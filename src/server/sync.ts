/**
 * 同步（M4）：轮询 forge 的 issue / PR / 评论，产出「要落库的事实」（纯数据 + 幂等键）。
 *
 * 分层跟 `probe.ts` 完全一致：
 *   1. **纯函数**：tea 配置解析与目标解析、URL 拼装、响应解析、`merged` 判定、`toFacts` 差异与幂等键 —— 全部可单测；
 *   2. **薄 IO**：`pollRemote({ remote, http?, run? })` 只负责发请求 / 跑 `tea` CLI，把结果拼成快照；
 *      `http` 与 `run` 都可注入 —— 测试里塞假响应，不联网、不依赖真的工具。
 *
 * **只读**：全部是 GET（`issues` / `pulls` / `issues/comments`），没有任何远程写；
 * 拿不到凭据 / 401 / 403 / 404 / 超时 / 网络错误一律**降级成带原因的结果**，绝不抛、绝不让调用方炸。
 *
 * 传输选择：**优先直打 Gitea/GitHub REST API**（能带 `since` 增量、能拿到 `merged`、评论有 id 与正文），
 * `tea` CLI 只在**没有任何可用 token** 时兜底（见 `docs/sync.md` §1、§5）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultRun, parseJson, parseRemoteUrl, type Run } from "./probe.ts";

/** 单次 HTTP 超时。同步是后台轮询，宁可降级也不要挂住。 */
export const HTTP_TIMEOUT_MS = 10_000;
/** 每页条数（Gitea 的 `limit` / GitHub 的 `per_page`）。 */
export const PAGE_LIMIT = 50;
/** 单次同步最多翻几页 —— 上限 250 条，防止一次请求把内存/时间打爆。 */
export const MAX_PAGES = 5;

// ---------------------------------------------------------------- tea 配置（纯）

export type TeaLogin = { name: string; url: string; token: string };

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

const YAML_KV = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/**
 * 解析 `~/.config/tea/config.yml` 里的 `logins:` 列表。
 * 只认 tea 自己写出来的那几种键（`name` / `url` / `token`），不引 YAML 依赖：
 * tea 的配置是固定形态（`logins:` 下一串 `- name:` 块），手写扫描足够且不会说谎。
 * 缺 `url` 或 `token` 的块直接丢掉（不可用）。
 */
export function parseTeaConfig(text: string): TeaLogin[] {
  const logins: TeaLogin[] = [];
  let cur: { name: string; url: string; token: string } | null = null;
  const flush = (): void => {
    if (cur && cur.url !== "" && cur.token !== "") logins.push(cur);
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const item = /^-\s*(.*)$/.exec(line);
    if (item) {
      const kv = YAML_KV.exec(item[1] ?? "");
      if (!kv || kv[1] !== "name") {
        // 不是 login 条目（tea 配置里其它列表项）：上一块到此为止
        flush();
        continue;
      }
      flush();
      cur = { name: unquote(kv[2] ?? ""), url: "", token: "" };
      continue;
    }
    const kv = YAML_KV.exec(line);
    if (!kv || !cur) continue; // 顶层键（`logins:` / `preferences:`）与块外键都忽略
    const key = kv[1]!;
    const value = unquote(kv[2] ?? "");
    if (key === "url") cur.url = value.replace(/\/+$/, "");
    else if (key === "token") cur.token = value;
  }
  flush();
  return logins;
}

/** `~/.config/tea/config.yml`（可用 `FLOWCARD_TEA_CONFIG` 覆盖，测试/多机用）。 */
export function teaConfigPath(env: Record<string, string | undefined> = process.env): string {
  const override = env["FLOWCARD_TEA_CONFIG"];
  if (override && override.trim() !== "") return override;
  return join(homedir(), ".config", "tea", "config.yml");
}

/** 读 tea 配置；读不到（没装 / 没登录过）返回 null，不抛。 */
export function readTeaConfig(path: string = teaConfigPath()): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 远程 → 目标（纯）

export type SyncForge = "gitea" | "github";

/** 目标来源：tea 登录项 / 环境变量的 Gitea 凭据 / 环境变量的 GitHub token。 */
export type SyncSource = "tea" | "env-gitea" | "env-github";

export type SyncAuth = {
  ok: true;
  forge: SyncForge;
  /** 形如 `https://gitea.example.com/git/api/v1`（**已含 Gitea 的根路径前缀**）。 */
  apiBase: string;
  owner: string;
  repo: string;
  token: string;
  source: SyncSource;
};

export type SyncDenial = { ok: false; reason: "no-remote" | "no-credentials" };

export type SyncTarget = SyncAuth | SyncDenial;

/**
 * 把 remote 规范化成可比对的形式：去掉 `user@`、去掉结尾 `/` 与 `.git`。
 * `git@host:owner/repo` 这种 scp 形态统一成 `https://host/owner/repo`（**整段 path 保留**，
 * 所以 Gitea 的 `/git/owner/repo` 前缀不会被丢掉 —— 前缀匹配靠的就是它）。
 */
export function canonicalRemote(remote: string): string | null {
  const raw = remote.trim();
  if (raw === "") return null;
  let host: string;
  let path: string;
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(raw);
  if (url) {
    host = url[1] ?? "";
    path = url[2] ?? "";
  } else if (raw.includes("://")) {
    // 有 scheme 但没有路径（`https://github.com`）：不是可切分的形态，别拿去当 scp 解析
    return null;
  } else {
    const scp = /^(?:[^@/]*@)?([^:/]+):(.+)$/.exec(raw);
    if (!scp) return null;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  }
  const clean = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (host === "" || clean === "") return null;
  return `https://${host}/${clean}`;
}

/** 用 login 的 url 前缀切出 `{owner, repo}`；不匹配（或切不出两段）返回 null。 */
export function matchTeaLogin(
  logins: TeaLogin[],
  remote: string,
): { login: TeaLogin; owner: string; repo: string } | null {
  const canon = canonicalRemote(remote);
  if (!canon) return null;
  // 多条登录项都能前缀匹配时，**最长前缀胜出**（最具体的那个才是对的）
  let best: { login: TeaLogin; rest: string } | null = null;
  for (const login of logins) {
    const prefix = canonicalRemote(login.url) ?? login.url.replace(/\/+$/, "");
    if (prefix === "" || !canon.startsWith(`${prefix}/`)) continue;
    const rest = canon.slice(prefix.length + 1);
    if (best === null || prefix.length > (canonicalRemote(best.login.url) ?? best.login.url).length) {
      best = { login, rest };
    }
  }
  if (!best) return null;
  const segments = best.rest.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return { login: best.login, owner: segments[segments.length - 2]!, repo: segments[segments.length - 1]! };
}

/** remote 的主机名（小写）；认不出返回 null。 */
export function remoteHost(remote: string): string | null {
  const canon = canonicalRemote(remote);
  if (!canon) return null;
  const m = /^https:\/\/([^/]+)\//.exec(canon);
  return m ? (m[1] ?? "").toLowerCase() : null;
}

/**
 * 任意 URL（含**只到站点根**的形式，如 `https://gitea.com`）的主机名（小写，不含端口）；
 * 解析不出来返回 null。用来和 `remoteHost()` 比"是不是同一台主机"。
 */
function urlHost(value: string): string | null {
  const raw = value.trim();
  if (raw === "") return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function forgeOfHost(host: string): SyncForge {
  return host === "github.com" || host.endsWith(".github.com") ? "github" : "gitea";
}

/** GitHub 的 REST 基址（企业版走 `/api/v3`）。 */
function githubApiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/**
 * remote + tea 配置 + 环境变量 → 同步目标（纯函数，不碰磁盘/网络）。优先级：
 *
 *   1. **tea 配置里 `url` 是 remote 前缀的登录项**（最长前缀胜出）→ `{login.url}/api/v1`；
 *   2. `FLOWCARD_GITEA_ROOT` + `FLOWCARD_GITEA_TOKEN` → `{root}/api/v1`；
 *   3. `FLOWCARD_GITHUB_TOKEN`（仅 github.com 主机）→ `https://api.github.com`；
 *   4. 都没有 → `{ok:false, reason:"no-credentials"}`（**不抛**，由调用方决定降级或改用 tea CLI）。
 *
 * 第 2 条要求 `FLOWCARD_GITEA_ROOT` 的主机与 remote 一致 —— 否则等于把 token 发给别的主机。
 */
export function resolveSyncTarget(input: {
  remote: string;
  teaConfig?: string | null;
  env?: Record<string, string | undefined>;
}): SyncTarget {
  const env = input.env ?? process.env;
  const host = remoteHost(input.remote);
  if (host === null) return { ok: false, reason: "no-remote" };
  const forge = forgeOfHost(host);

  const matched = matchTeaLogin(parseTeaConfig(input.teaConfig ?? ""), input.remote);
  if (matched) {
    const base = matched.login.url.replace(/\/+$/, "");
    return {
      ok: true,
      forge: forgeOfHost(remoteHost(matched.login.url) ?? host),
      apiBase: forgeOfHost(host) === "github" ? githubApiBase(host) : `${base}/api/v1`,
      owner: matched.owner,
      repo: matched.repo,
      token: matched.login.token,
      source: "tea",
    };
  }

  const root = (env["FLOWCARD_GITEA_ROOT"] ?? "").trim().replace(/\/+$/, "");
  const giteaToken = env["FLOWCARD_GITEA_TOKEN"] ?? "";
  // 主机比较用**只到站点根的 URL** 也认：`FLOWCARD_GITEA_ROOT=https://gitea.com` 是合法写法，
  // 而 `remoteHost()` 走 canonicalRemote（要求 host 后至少有一段路径），对站点根恒返回 null
  // → 以前这种写法永远匹配不上，直接掉进 no-credentials。owner/repo 仍从 remote 自己切，与 root 的路径无关。
  if (root !== "" && giteaToken !== "" && urlHost(root) === host) {
    const parsed = parseRemoteUrl(input.remote);
    if (!parsed) return { ok: false, reason: "no-remote" };
    return {
      ok: true,
      forge: "gitea",
      apiBase: `${root}/api/v1`,
      owner: parsed.owner,
      repo: parsed.repo,
      token: giteaToken,
      source: "env-gitea",
    };
  }

  const ghToken = env["FLOWCARD_GITHUB_TOKEN"] ?? "";
  if (ghToken !== "" && forge === "github") {
    const parsed = parseRemoteUrl(input.remote);
    if (!parsed) return { ok: false, reason: "no-remote" };
    return {
      ok: true,
      forge: "github",
      apiBase: githubApiBase(host),
      owner: parsed.owner,
      repo: parsed.repo,
      token: ghToken,
      source: "env-github",
    };
  }

  return { ok: false, reason: "no-credentials" };
}

// ---------------------------------------------------------------- HTTP（薄 IO，可注入）

export type HttpFailureReason = "network" | "timeout" | "unauthorized" | "forbidden" | "not-found" | "http-error";

export type HttpOutcome =
  | { ok: true; status: number; text: string }
  | { ok: false; reason: HttpFailureReason; status: number | null; detail: string };

/** 注入点：`(url, headers) => outcome`。测试里塞一个按 URL 查表的假实现即可。 */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpOutcome>;

/** 把 HTTP 状态折成「降级原因」。**这是唯一的判定处**，别在上层重复判断状态码。 */
export function classifyStatus(status: number): HttpFailureReason | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  return "http-error";
}

/** 认证头：Gitea 用 `token`，GitHub 用 `Bearer`（GitHub 不认 `token` 前缀的写法）。 */
export function authHeaders(auth: SyncAuth): Record<string, string> {
  if (auth.forge === "github") {
    return {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "flowcard-sync",
    };
  }
  return {
    Authorization: `token ${auth.token}`,
    Accept: "application/json",
    "User-Agent": "flowcard-sync",
  };
}

/**
 * 默认 HTTP 实现：`fetch` + `AbortSignal.timeout`。
 * **整段（含读 body）都在 try 里** —— 超时可能在 body 流式读取途中触发（实测大页 PR 列表会撞上），
 * 那一支的拒绝必须同样折成 `{ok:false, reason:"timeout"}`，不能漏成异常抛给调用方。
 */
export async function defaultHttpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<HttpOutcome> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const bad = classifyStatus(res.status);
    if (bad === null) return { ok: true, status: res.status, text };
    return { ok: false, reason: bad, status: res.status, detail: `${res.status} ${res.statusText}`.trim() };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    const timeout = e.name === "TimeoutError" || e.name === "AbortError";
    return { ok: false, reason: timeout ? "timeout" : "network", status: null, detail: e.message ?? String(err) };
  }
}

// ---------------------------------------------------------------- URL 拼装（纯）

export type SyncEndpoint = "issues" | "pulls" | "comments";

/**
 * 端点 URL。三个端点在两种 forge 上路径相同，差异只在细节：
 *
 * - **每页条数**：Gitea `limit` / GitHub `per_page`；
 * - **`/issues` 会把 PR 混进来**：Gitea 加 `type=issues` 排掉；GitHub 靠响应里的 `pull_request` 字段过滤；
 * - **`since` 只给 issues 与 comments**（两家都只在这两个端点上支持增量）；
 *   `/pulls` 两家都**没有** `since`（Gitea 实测直接忽略：带 `since` 仍返回全量），
 *   所以 PR 列表只能按「最近更新在前」取前 `MAX_PAGES × PAGE_LIMIT` 条（Gitea 加 `sort=recentupdate` 把这个顺序钉死，
 *   不依赖服务端默认值）；绑定到卡片的老 PR 用 `fetchPull` 单条精确读。
 */
export function endpointUrl(
  auth: SyncAuth,
  endpoint: SyncEndpoint,
  opts: { since?: string | null; page?: number } = {},
): string {
  const page = opts.page ?? 1;
  const base = `${auth.apiBase}/repos/${auth.owner}/${auth.repo}`;
  const perPage = auth.forge === "github" ? "per_page" : "limit";
  const query: string[] = [`page=${page}`, `${perPage}=${PAGE_LIMIT}`];
  // Gitea 的 `/issues` 默认把 PR 混进来：加 `type=issues` 排掉（GitHub 靠响应里的 `pull_request` 字段过滤）
  if (endpoint === "issues" && auth.forge === "gitea") query.push("type=issues");
  if (opts.since && endpoint !== "pulls") query.push(`since=${encodeURIComponent(opts.since)}`);
  if (endpoint === "comments") return `${base}/issues/comments?${query.join("&")}`;
  if (endpoint === "pulls") {
    if (auth.forge === "gitea") query.push("sort=recentupdate");
    return `${base}/pulls?${query.concat("state=all").join("&")}`;
  }
  return `${base}/issues?${query.concat("state=all").join("&")}`;
}

/** 单个 issue / PR 的 URL（`since` 无关：按号精确读）。 */
export function singleUrl(auth: SyncAuth, kind: "issues" | "pulls", number: number): string {
  return `${auth.apiBase}/repos/${auth.owner}/${auth.repo}/${kind}/${number}`;
}

// ---------------------------------------------------------------- 响应解析（纯）

export type RawIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  /** 归一化成 UTC ISO（Gitea 给的是 `+08:00` 偏移形态，直接进幂等键不稳定）。 */
  updatedAt: string;
  /** 评论**条数**（不是正文）。 */
  comments: number;
};

export type RawPull = {
  number: number;
  state: "open" | "closed" | "merged";
  /** API 直接给；`tea` CLI 的字段里没有 → null（**不猜**）。 */
  merged: boolean | null;
  /** 源分支（Gitea 的 `label` 是分支名，`ref` 是 `refs/pull/N/head` —— 优先 label）。 */
  head: string;
  base: string;
  updatedAt: string;
  url: string;
};

export type RawComment = {
  id: number;
  /** 评论挂在哪个 issue/PR 上（从 `issue_url` / `pull_request_url` / `html_url` 抠出来）。 */
  issueNumber: number;
  author: string;
  body: string;
  at: string;
  url: string;
};

export type SyncSnapshotData = { issues: RawIssue[]; pulls: RawPull[]; comments: RawComment[] };

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

/** 时间统一成 UTC ISO；解析不出来返回 null（不伪造时间）。 */
export function toIso(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `state` + `merged` → 统一状态。`merged:true` 优先（Gitea 合并后 `state` 仍是 closed）。 */
export function pullState(state: unknown, merged: unknown): RawPull["state"] {
  if (merged === true) return "merged";
  const s = typeof state === "string" ? state.toLowerCase() : "";
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  return "open";
}

/**
 * Gitea 的 `head`/`base` 是 `{label, ref, sha}`：**`label` 才是分支名**（同仓 PR 时 `ref` 可能是
 * `refs/pull/N/head`）；跨仓时 `label` 是 `owner:branch`，原样保留（不猜要不要剥前缀）。
 */
export function branchFromRef(v: unknown): string {
  const o = asRecord(v);
  if (o) {
    const label = asString(o["label"]) ?? asString(o["name"]);
    if (label !== null) return label;
    return asString(o["ref"]) ?? "";
  }
  return asString(v) ?? "";
}

/** 从评论的各个 url 字段抠出 issue/PR 编号。Gitea 这里 `issue_url` 常常是空串。 */
export function issueNumberFromUrls(v: Record<string, unknown>): number | null {
  for (const key of ["issue_url", "pull_request_url", "html_url", "url"]) {
    const url = asString(v[key]);
    if (url === null) continue;
    const m = /\/(?:issues|pulls)\/(\d+)(?:$|[/?#])/.exec(url);
    if (m) return Number(m[1]!);
  }
  return null;
}

export function parseIssue(raw: unknown): RawIssue | null {
  const o = asRecord(raw);
  if (!o) return null;
  // `/issues` 在两边都会混进 PR：Gitea 给 `pull_request: {...}`，GitHub 同理。有它就跳过。
  if (o["pull_request"] !== null && o["pull_request"] !== undefined) return null;
  const number = asNumber(o["number"]);
  const updatedAt = toIso(o["updated_at"]) ?? toIso(o["created_at"]);
  if (number === null || updatedAt === null) return null;
  const state = o["state"] === "closed" ? "closed" : o["state"] === "open" ? "open" : null;
  if (state === null) return null;
  return {
    number,
    title: asString(o["title"]) ?? "",
    state,
    updatedAt,
    comments: asNumber(o["comments"]) ?? 0,
  };
}

export function parseIssueList(raw: unknown): RawIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: RawIssue[] = [];
  for (const item of raw) {
    const issue = parseIssue(item);
    if (issue) out.push(issue);
  }
  return out;
}

export function parsePull(raw: unknown): RawPull | null {
  const o = asRecord(raw);
  if (!o) return null;
  const number = asNumber(o["number"]);
  const updatedAt = toIso(o["updated_at"]) ?? toIso(o["created_at"]);
  if (number === null || updatedAt === null) return null;
  const mergedRaw = o["merged"];
  return {
    number,
    state: pullState(o["state"], mergedRaw),
    merged: typeof mergedRaw === "boolean" ? mergedRaw : null,
    head: branchFromRef(o["head"]),
    base: branchFromRef(o["base"]),
    updatedAt,
    url: asString(o["html_url"]) ?? asString(o["url"]) ?? "",
  };
}

export function parsePullList(raw: unknown): RawPull[] {
  if (!Array.isArray(raw)) return [];
  const out: RawPull[] = [];
  for (const item of raw) {
    const pull = parsePull(item);
    if (pull) out.push(pull);
  }
  return out;
}

export function parseComment(raw: unknown): RawComment | null {
  const o = asRecord(raw);
  if (!o) return null;
  const id = asNumber(o["id"]);
  const at = toIso(o["created_at"]) ?? toIso(o["updated_at"]);
  const issueNumber = issueNumberFromUrls(o);
  // 拿不到编号的评论无法路由到任何卡片：丢弃而不是塞一条没用的记录
  if (id === null || at === null || issueNumber === null) return null;
  const user = asRecord(o["user"]);
  const body = typeof o["body"] === "string" ? o["body"] : "";
  return {
    id,
    issueNumber,
    author: user ? (asString(user["login"]) ?? "") : "",
    body,
    at,
    url: asString(o["html_url"]) ?? asString(o["issue_url"]) ?? asString(o["pull_request_url"]) ?? "",
  };
}

export function parseCommentList(raw: unknown): RawComment[] {
  if (!Array.isArray(raw)) return [];
  const out: RawComment[] = [];
  for (const item of raw) {
    const comment = parseComment(item);
    if (comment) out.push(comment);
  }
  return out;
}

// ---------------------------------------------------------------- tea CLI 兜底（薄 IO）

/** `tea issues ls` / `tea pulls ls` 的参数（`-R origin` 要在仓库目录里跑）。 */
export function teaListArgv(kind: "issues" | "pulls", limit: number = PAGE_LIMIT): string[] {
  const fields =
    kind === "issues"
      ? "index,title,state,updated,comments,url,author"
      : "index,state,author,url,title,base,head,updated";
  return [kind, "ls", "-R", "origin", "--output", "json", "--state", "all", "--limit", String(limit), "--fields", fields];
}

/**
 * tea CLI 的 JSON → `RawIssue[]`。字段都是**字符串**（`index: "749"`）；
 * CLI **没有 since 增量**（`issues ls` 的 `--from` 是活动时间，`pulls ls` 干脆没有），所以只能全量拉。
 */
export function parseTeaCliIssues(raw: unknown): RawIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: RawIssue[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) continue;
    const number = asNumber(o["index"]);
    const updatedAt = toIso(o["updated"]);
    if (number === null || updatedAt === null) continue;
    out.push({
      number,
      title: asString(o["title"]) ?? "",
      state: o["state"] === "closed" ? "closed" : "open",
      updatedAt,
      comments: asNumber(o["comments"]) ?? 0,
    });
  }
  return out;
}

/** tea CLI 的 PR 字段里**没有 `merged`**（`tea pulls ls --fields merged` 直接报 invalid field）→ `merged: null`。 */
export function parseTeaCliPulls(raw: unknown): RawPull[] {
  if (!Array.isArray(raw)) return [];
  const out: RawPull[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) continue;
    const number = asNumber(o["index"]);
    const updatedAt = toIso(o["updated"]);
    if (number === null || updatedAt === null) continue;
    out.push({
      number,
      state: pullState(o["state"], null),
      merged: null,
      head: asString(o["head"]) ?? "",
      base: asString(o["base"]) ?? "",
      updatedAt,
      url: asString(o["url"]) ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------- 轮询（薄 IO）

export type DegradeReason = HttpFailureReason | "parse-error" | "unavailable";

/** 一个端点没拿到数据的原因（**有降级 ≠ 失败**：其余端点照常返回）。 */
export type Degradation = {
  endpoint: SyncEndpoint;
  reason: DegradeReason;
  status: number | null;
  detail: string;
};

export type SyncSnapshot = {
  ok: true;
  source: "api" | "tea-cli";
  forge: SyncForge;
  owner: string;
  repo: string;
  fetchedAt: string;
  /** 本次增量窗口起点（没传 = 全量）。 */
  since: string | null;
  issues: RawIssue[];
  pulls: RawPull[];
  comments: RawComment[];
  /** 拿不到的端点 / 截断说明；空数组 = 三个端点都完整。 */
  degraded: Degradation[];
  notes: string[];
};

export type SyncPollResult = SyncSnapshot | { ok: false; reason: "no-remote" | "no-credentials" | "no-transport"; notes: string[] };

export type SyncPollOptions = {
  remote: string;
  /** tea CLI 兜底需要在仓库里跑（`-R origin`）；不传就没法兜底。 */
  repoPath?: string;
  /** 增量起点（ISO）。评论端点用它过滤；issues/pulls 也带上（Gitea/GitHub 都支持 `since`）。 */
  since?: string;
  /** `undefined` = 读 `~/.config/tea/config.yml`；`null`/文本 = 直接用（测试用）。 */
  teaConfig?: string | null;
  env?: Record<string, string | undefined>;
  http?: HttpGet;
  run?: Run;
  now?: () => string;
};

type EndpointFetch<T> = { items: T[]; degraded: Degradation | null; notes: string[] };

async function fetchEndpoint<T>(input: {
  http: HttpGet;
  url: (page: number) => string;
  headers: Record<string, string>;
  parse: (raw: unknown) => T[];
  endpoint: SyncEndpoint;
}): Promise<EndpointFetch<T>> {
  const items: T[] = [];
  const notes: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const outcome = await input.http(input.url(page), input.headers);
    if (!outcome.ok) {
      if (page === 1) {
        return { items, degraded: { endpoint: input.endpoint, reason: outcome.reason, status: outcome.status, detail: outcome.detail }, notes };
      }
      notes.push(`${input.endpoint} 第 ${page} 页失败（${outcome.reason}）：已收 ${items.length} 条`);
      break;
    }
    const raw = parseJson(outcome.text);
    // 2xx 但响应不是 JSON 数组（反向代理的 HTML 错误页等）：当成这一页拿不到，别静默算「空列表」。
    if (!Array.isArray(raw)) {
      const detail = `响应不是 JSON 数组（HTTP ${outcome.status}）`;
      if (page === 1) return { items, degraded: { endpoint: input.endpoint, reason: "parse-error", status: outcome.status, detail }, notes };
      notes.push(`${input.endpoint} 第 ${page} 页解析失败：已收 ${items.length} 条`);
      break;
    }
    const parsed = input.parse(raw);
    items.push(...parsed);
    if (parsed.length < PAGE_LIMIT) break; // 不满一页 = 最后一页
    if (page === MAX_PAGES) {
      notes.push(`${input.endpoint} 命中 ${MAX_PAGES} 页上限（${items.length} 条），本轮不再翻页`);
    }
  }
  return { items, degraded: null, notes };
}

async function pollViaApi(auth: SyncAuth, input: SyncPollOptions, http: HttpGet, fetchedAt: string): Promise<SyncSnapshot> {
  const headers = authHeaders(auth);
  const since = input.since ?? null;
  const notes: string[] = [];
  const degraded: Degradation[] = [];

  const [issues, pulls, comments] = await Promise.all([
    fetchEndpoint({ http, url: (page) => endpointUrl(auth, "issues", { since, page }), headers, parse: parseIssueList, endpoint: "issues" }),
    fetchEndpoint({ http, url: (page) => endpointUrl(auth, "pulls", { since, page }), headers, parse: parsePullList, endpoint: "pulls" }),
    fetchEndpoint({ http, url: (page) => endpointUrl(auth, "comments", { since, page }), headers, parse: parseCommentList, endpoint: "comments" }),
  ]);
  for (const part of [issues, pulls, comments]) {
    if (part.degraded) {
      degraded.push(part.degraded);
      notes.push(`${part.degraded.endpoint} 降级：${part.degraded.reason} —— ${part.degraded.detail}`);
    }
    notes.push(...part.notes);
  }

  return {
    ok: true,
    source: "api",
    forge: auth.forge,
    owner: auth.owner,
    repo: auth.repo,
    fetchedAt,
    since,
    issues: issues.items,
    pulls: pulls.items,
    comments: comments.items,
    degraded,
    notes,
  };
}

async function pollViaTeaCli(input: SyncPollOptions, run: Run, fetchedAt: string): Promise<SyncPollResult> {
  const cwd = input.repoPath;
  if (!cwd) {
    return { ok: false, reason: "no-transport", notes: ["没有可用 token，且不知道仓库目录：无法用 tea CLI 兜底"] };
  }
  const notes: string[] = [];
  const [issuesOut, pullsOut] = await Promise.all([
    run("tea", teaListArgv("issues"), { cwd, timeoutMs: HTTP_TIMEOUT_MS }),
    run("tea", teaListArgv("pulls"), { cwd, timeoutMs: HTTP_TIMEOUT_MS }),
  ]);
  const collect = <T>(out: { stdout: string; stderr: string; code: number; missing: boolean }, parse: (raw: unknown) => T[], label: string): T[] => {
    if (out.missing) {
      notes.push(`tea 未安装：${label} 拿不到`);
      return [];
    }
    if (out.code !== 0) {
      notes.push(`tea ${label} 失败（exit ${out.code}）：${out.stderr.split("\n")[0] ?? ""}`);
      return [];
    }
    const raw = parseJson(out.stdout);
    if (raw === null) {
      notes.push(`tea ${label} 的输出不是 JSON`);
      return [];
    }
    const parsed = parse(raw);
    if (parsed.length === 0) notes.push(`tea ${label} 返回空列表`);
    return parsed;
  };
  const issues = collect(issuesOut, parseTeaCliIssues, "issues ls");
  const pulls = collect(pullsOut, parseTeaCliPulls, "pulls ls");
  const degraded: Degradation[] = [
    { endpoint: "comments", reason: "unavailable", status: null, detail: "tea CLI 没有评论增量接口：评论只能靠 API 拿" },
  ];
  if (pulls.length > 0) {
    degraded.push({ endpoint: "pulls", reason: "unavailable", status: null, detail: "tea CLI 的 PR 字段没有 merged：已合并的 PR 只能看 state=closed" });
  }
  if (issues.length === 0 && pulls.length === 0) {
    return { ok: false, reason: "no-transport", notes: [...notes, "tea CLI 兜底也没拿到数据"] };
  }
  const parsed = parseRemoteUrl(input.remote);
  return {
    ok: true,
    source: "tea-cli",
    forge: "gitea",
    owner: parsed?.owner ?? "",
    repo: parsed?.repo ?? "",
    fetchedAt,
    since: null, // CLI 没有 since 增量
    issues,
    pulls,
    comments: [],
    degraded,
    notes,
  };
}

/**
 * 拉一次快照（**只读 GET**）。凭据解析走 `resolveSyncTarget`；没有任何 token 时退到 `tea` CLI。
 * 永远不抛：没凭据 → `{ok:false, reason:"no-credentials"}`；某端点失败 → 该端点空数组 + `degraded[]`。
 */
export async function pollRemote(input: SyncPollOptions): Promise<SyncPollResult> {
  const env = input.env ?? process.env;
  const fetchedAt = (input.now ?? (() => new Date().toISOString()))();
  const teaConfig = input.teaConfig !== undefined ? input.teaConfig : readTeaConfig(teaConfigPath(env));
  const target = resolveSyncTarget({ remote: input.remote, teaConfig, env });

  if (target.ok) {
    return pollViaApi(target, input, input.http ?? defaultHttpGet, fetchedAt);
  }
  if (target.reason === "no-remote") return { ok: false, reason: "no-remote", notes: ["remote 认不出（拿不到 host/owner/repo）：不同步"] };

  const fallback = await pollViaTeaCli(input, input.run ?? defaultRun, fetchedAt);
  if (fallback.ok) return fallback;
  return {
    ok: false,
    reason: "no-credentials",
    notes: ["没有可用的 Gitea/GitHub 凭据（tea 配置 / FLOWCARD_GITEA_TOKEN / FLOWCARD_GITHUB_TOKEN 都没有）", ...fallback.notes],
  };
}

/**
 * 单个 issue / PR 的精确读（只读 GET）。给「卡片已绑定的编号」用：
 * 比全量列表便宜得多（一个 PR ≈ 17 KB vs 一页列表 ≈ 0.5 MB），也不会被列表分页上限漏掉。
 * 拿不到就降级成 `{ok:false, reason, ...}`，不抛。
 */
export type FetchOne<T> = { ok: true; item: T } | { ok: false; reason: DegradeReason; status: number | null; detail: string };

async function fetchOne<T>(
  auth: SyncAuth,
  kind: "issues" | "pulls",
  number: number,
  parse: (raw: unknown) => T | null,
  http: HttpGet,
): Promise<FetchOne<T>> {
  const outcome = await http(singleUrl(auth, kind, number), authHeaders(auth));
  if (!outcome.ok) return { ok: false, reason: outcome.reason, status: outcome.status, detail: outcome.detail };
  const item = parse(parseJson(outcome.text));
  if (!item) return { ok: false, reason: "parse-error", status: outcome.status, detail: `响应不是 ${kind} 对象` };
  return { ok: true, item };
}

export function fetchIssue(
  auth: SyncAuth,
  number: number,
  http: HttpGet = defaultHttpGet,
): Promise<FetchOne<RawIssue>> {
  return fetchOne(auth, "issues", number, parseIssue, http);
}

export function fetchPull(auth: SyncAuth, number: number, http: HttpGet = defaultHttpGet): Promise<FetchOne<RawPull>> {
  return fetchOne(auth, "pulls", number, parsePull, http);
}

// ---------------------------------------------------------------- 差异 → 事实（纯）

export type SyncFact =
  | { kind: "issue.state"; number: number; state: "open" | "closed"; title: string; updatedAt: string }
  | {
      kind: "pr.state";
      number: number;
      state: "open" | "closed" | "merged";
      merged: boolean | null;
      head: string;
      base: string;
      url: string;
      updatedAt: string;
    }
  | { kind: "remote.comment"; id: number; issueNumber: number; author: string; body: string; at: string; url: string };

export type SyncPrev = {
  issues?: { number: number; state: string; updatedAt?: string }[];
  pulls?: { number: number; state: string; merged?: boolean | null; updatedAt?: string }[];
  /** 已落库的评论幂等键（`sync:comment:{id}`）；不给就靠事件库的 dedupeKey 去重。 */
  commentKeys?: string[];
};

/** 幂等键（事件库的 `dedupeKey`）。同一事实重复同步 → 同一 key → 只落一次。 */
export function factKey(fact: SyncFact): string {
  switch (fact.kind) {
    case "remote.comment":
      return `sync:comment:${fact.id}`;
    case "issue.state":
      return `sync:issue:${fact.number}:${fact.updatedAt}`;
    case "pr.state":
      return `sync:pr:${fact.number}:${fact.state}:${fact.updatedAt}`;
  }
}

/**
 * 快照差异 → 要落库的事实。**只算差异**：状态/更新时间和上轮一样的不发，评论按 id 去重。
 *
 * `prev` 是上一轮快照（首次同步传 null）；`opts.numbers` 给了就**只出这些编号的 issue/PR 事实**
 * （= 看板上真有卡片的编号；事件必须挂 cardId，不给这个过滤会为仓库里每个条目都发一条）。
 * 缩窗口靠 `since`，不靠这里。
 */
export function toFacts(
  prev: SyncPrev | null,
  next: SyncSnapshotData,
  opts: { numbers?: readonly number[] } = {},
): SyncFact[] {
  const facts: SyncFact[] = [];
  const only = opts.numbers ? new Set(opts.numbers) : null;

  const prevIssues = new Map((prev?.issues ?? []).map((i) => [i.number, i]));
  for (const issue of next.issues) {
    if (only && !only.has(issue.number)) continue;
    const before = prevIssues.get(issue.number);
    if (before && before.state === issue.state && (before.updatedAt ?? null) === issue.updatedAt) continue;
    facts.push({ kind: "issue.state", number: issue.number, state: issue.state, title: issue.title, updatedAt: issue.updatedAt });
  }

  const prevPulls = new Map((prev?.pulls ?? []).map((p) => [p.number, p]));
  for (const pull of next.pulls) {
    if (only && !only.has(pull.number)) continue;
    const before = prevPulls.get(pull.number);
    const sameMerged = (before?.merged ?? null) === pull.merged;
    if (before && before.state === pull.state && sameMerged && (before.updatedAt ?? null) === pull.updatedAt) continue;
    facts.push({
      kind: "pr.state",
      number: pull.number,
      state: pull.state,
      merged: pull.merged,
      head: pull.head,
      base: pull.base,
      url: pull.url,
      updatedAt: pull.updatedAt,
    });
  }

  const seen = new Set(prev?.commentKeys ?? []);
  for (const comment of next.comments) {
    if (only && !only.has(comment.issueNumber)) continue;
    const key = `sync:comment:${comment.id}`;
    if (seen.has(key)) continue;
    seen.add(key); // 同轮重复（翻页边界）也只发一条
    facts.push({
      kind: "remote.comment",
      id: comment.id,
      issueNumber: comment.issueNumber,
      author: comment.author,
      body: comment.body,
      at: comment.at,
      url: comment.url,
    });
  }

  return facts;
}
