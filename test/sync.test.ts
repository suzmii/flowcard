/**
 * 同步的单测：**不联网、不跑真 tea/fetch**。
 *
 * fixtures 来自 2026-10-10 对 `gitea.example.com`（Gitea）与 GitHub 形态的真实响应样本，
 * 但已**裁剪 + 脱敏**：去掉 `email` / `avatar_url` / `login_name` / `token`、正文截断到几十字、
 * 删掉与解析无关的大对象（`repository`、`permissions`、`labels`…）。**token 在任何 fixture 里都不存在**。
 *
 * 覆盖：tea 配置解析（前缀匹配 / 多登录 / GitHub 形态 / 无凭据）、issue/PR/评论解析、`since` 过滤、
 * 分页上限、401/404/网络降级、`toFacts` 只出差异、幂等键稳定、`merged` 判定、tea CLI 兜底。
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { RunOutcome } from "../src/server/probe.ts";
import {
  MAX_PAGES,
  PAGE_LIMIT,
  authHeaders,
  canonicalRemote,
  defaultHttpGet,
  endpointUrl,
  factKey,
  fetchIssue,
  fetchPull,
  issueNumberFromUrls,
  matchTeaLogin,
  parseComment,
  parseCommentList,
  parseIssue,
  parseIssueList,
  parsePull,
  parsePullList,
  parseTeaCliIssues,
  parseTeaCliPulls,
  parseTeaConfig,
  pollRemote,
  pullState,
  resolveSyncTarget,
  singleUrl,
  teaListArgv,
  toFacts,
  toIso,
  type HttpGet,
  type HttpOutcome,
  type SyncAuth,
  type SyncSnapshotData,
} from "../src/server/sync.ts";

// ---------------------------------------------------------------- fixtures（脱敏的真实样本）

/** tea 的 `~/.config/tea/config.yml`：两条登录（长前缀 / 短前缀），token 是假值。 */
const TEA_CONFIG = `logins:
    - name: gitea.example.com
      url: https://gitea.example.com/git
      token: t0ken-fake-gitea
      default: false
      ssh_host: gitea.example.com
      user: suzmii
    - name: gitea.example.com-root
      url: "https://gitea.example.com"
      token: "t0ken-fake-root"
      default: true
    - name: github.com
      url: https://github.com
      token: t0ken-fake-github
      default: false
    - name: broken
      url: https://broken.example
preferences:
    editor: false
    flag_defaults:
        remote: ""
`;

const REMOTE = "https://gitea.example.com/git/owner/repo";

/** `GET /repos/owner/repo/issues/742`（真实样本，裁剪）。 */
const ISSUE_742 = {
  number: 742,
  title: "游玩页大体积单文件作品启动超时：包体启动耗时与超时窗口贴边（重试可进）",
  state: "open",
  updated_at: "2026-10-09T17:21:33+08:00",
  created_at: "2026-10-09T17:21:33+08:00",
  comments: 0,
  html_url: "http://gitea.example.com/git/owner/repo/issues/742",
  pull_request: null,
};

/** `GET /repos/.../pulls/745`（真实样本，裁剪）：closed + merged=true → **merged**。 */
const PULL_745 = {
  number: 745,
  state: "closed",
  merged: true,
  merged_at: "2026-10-10T01:06:49+08:00",
  updated_at: "2026-10-10T12:42:54+08:00",
  html_url: "http://gitea.example.com/git/owner/repo/pulls/745",
  head: { label: "codex/trim-native-shell-tests", ref: "refs/pull/745/head", sha: "d1f3747" },
  base: { label: "master", ref: "master", sha: "8baff15" },
};

/** 列表里混进来的 PR（Gitea 的 `/issues` 会给 `pull_request` 对象）——必须被过滤掉。 */
const ISSUE_LIST_ENTRY_PR = { number: 750, title: "WIP: 陶泥儿发布面板", state: "open", updated_at: "2026-10-10T13:52:02+08:00", comments: 2, pull_request: { merged: false, html_url: "…" } };

/** `GET /repos/.../issues/comments?since=…`（真实样本，正文截断、去掉 user.email/avatar_url）。 */
const COMMENT_7438 = {
  id: 7438,
  html_url: "http://gitea.example.com/git/owner/repo/pulls/735#issuecomment-7438",
  pull_request_url: "http://gitea.example.com/git/owner/repo/pulls/735",
  issue_url: "",
  user: { id: 19, login: "suzmii", full_name: "（脱敏）" },
  body: "#735 已把 merged-usr 预检修好（证据：报错文案从预检失败变成握手失败）…",
  created_at: "2026-10-09T13:56:21+08:00",
  updated_at: "2026-10-09T13:56:32+08:00",
};
const COMMENT_7633 = {
  id: 7633,
  html_url: "http://gitea.example.com/git/owner/repo/issues/564#issuecomment-7633",
  pull_request_url: "",
  issue_url: "http://gitea.example.com/git/owner/repo/issues/564",
  user: { id: 8, login: "lhk229" },
  body: "这条我来看，今晚给结论。",
  created_at: "2026-10-10T11:27:43+08:00",
  updated_at: "2026-10-10T11:27:43+08:00",
};
/** 两个 url 都缺、只能从 html_url 抠编号的形态。 */
const COMMENT_7679 = { id: 7679, html_url: "http://gitea.example.com/git/owner/repo/pulls/720#issuecomment-7679", user: { login: "suzmii" }, body: "12 楼的对齐问题我来跟。", created_at: "2026-10-10T13:38:26+08:00" };

/** GitHub 形态：`per_page` + PR 对象自带 `pull_request` 字段。 */
const GH_ISSUE = { number: 12, title: "crash on empty diff", state: "open", updated_at: "2026-10-01T02:03:04Z", comments: 3, pull_request: null };
const GH_PULL = { number: 13, state: "closed", merged: false, updated_at: "2026-10-02T02:03:04Z", html_url: "https://github.com/acme/demo/pull/13", head: { ref: "fix/x" }, base: { ref: "main" } };
const GH_COMMENT = {
  id: 9001,
  issue_url: "https://api.github.com/repos/acme/demo/issues/12",
  html_url: "https://github.com/acme/demo/issues/12#issuecomment-9001",
  user: { login: "octocat" },
  body: ":+1:",
  created_at: "2026-10-03T02:03:04Z",
};

/** tea CLI 的真实输出（字段全是字符串）。 */
const TEA_CLI_ISSUES = [
  { index: "749", title: "AGC 陶泥儿发布面板默认允许全开放共创", state: "open", updated: "2026-10-10T04:58:46Z", comments: "0", url: "http://…/issues/749", author: "董羽秦" },
];
const TEA_CLI_PULLS = [
  { index: "750", state: "open", author: "董羽秦", url: "http://…/pulls/750", title: "WIP: 陶泥儿发布面板", base: "master", head: "feat/agc-fork-default-full", updated: "2026-10-10T05:52:02Z" },
  { index: "745", state: "closed", author: "lhk229", url: "http://…/pulls/745", title: "trim native shell tests", base: "master", head: "codex/trim-native-shell-tests", updated: "2026-10-10T04:42:54Z" },
];

function giteaAuth(overrides: Partial<SyncAuth> = {}): SyncAuth {
  return {
    ok: true,
    forge: "gitea",
    apiBase: "https://gitea.example.com/git/api/v1",
    owner: "owner",
    repo: "repo",
    token: "t0ken-fake-gitea",
    source: "tea",
    ...overrides,
  };
}

/** 假 HTTP：按 URL 查表；没配的 URL 直接断言失败（避免静默走偏）。 */
function fakeHttp(routes: Record<string, HttpOutcome>, onCall?: (url: string) => void): HttpGet {
  return async (url) => {
    onCall?.(url);
    const hit = routes[url];
    if (!hit) throw new Error(`测试没配这个 URL：${url}`);
    return hit;
  };
}

function jsonOk(body: unknown, status = 200): HttpOutcome {
  return { ok: true, status, text: JSON.stringify(body) };
}

function fakeRun(outcomes: Record<string, RunOutcome>): (file: string, args: string[]) => Promise<RunOutcome> {
  return async (_file, args) => {
    const key = args[0] ?? "";
    const hit = outcomes[key];
    if (!hit) throw new Error(`测试没配这个 tea 子命令：${args.join(" ")}`);
    return hit;
  };
}

const ok = (stdout: string): RunOutcome => ({ code: 0, stdout, stderr: "", missing: false });

// ---------------------------------------------------------------- tea 配置解析

describe("tea 配置解析（纯）", () => {
  it("解析出多条登录，丢掉缺 url/token 的块，去掉引号", () => {
    const logins = parseTeaConfig(TEA_CONFIG);
    expect(logins).toEqual([
      { name: "gitea.example.com", url: "https://gitea.example.com/git", token: "t0ken-fake-gitea" },
      { name: "gitea.example.com-root", url: "https://gitea.example.com", token: "t0ken-fake-root" },
      { name: "github.com", url: "https://github.com", token: "t0ken-fake-github" },
    ]);
    expect(parseTeaConfig("")).toEqual([]);
    expect(parseTeaConfig("preferences:\n    editor: false\n")).toEqual([]);
  });

  it("前缀匹配：最长前缀胜出（同主机两条登录）", () => {
    const logins = parseTeaConfig(TEA_CONFIG);
    const m = matchTeaLogin(logins, REMOTE);
    expect(m).toMatchObject({ owner: "owner", repo: "repo" });
    expect(m?.login.name).toBe("gitea.example.com");
    // scp 形态也认（规范化时把 `/git` 前缀完整保留）
    expect(matchTeaLogin(logins, "git@gitea.example.com:git/owner/repo.git")?.login.name).toBe(
      "gitea.example.com",
    );
    // 同主机但不在 `/git` 下的仓库 → 由主机级登录项（短前缀）接管
    expect(matchTeaLogin(logins, "https://gitea.example.com/other/repo")?.login.name).toBe("gitea.example.com-root");
    expect(matchTeaLogin(logins, "https://unknown.example/a/b")).toBeNull();
  });

  it("canonicalRemote 统一 scp / https / .git / 尾斜杠", () => {
    expect(canonicalRemote("git@github.com:acme/demo.git")).toBe("https://github.com/acme/demo");
    expect(canonicalRemote("https://gitea.example.com/git/A/B/")).toBe("https://gitea.example.com/git/A/B");
    // 只有主机没有路径（tea 的 GitHub 登录项就长这样）：切不出 owner/repo，返回 null（上层按前缀兜底）
    expect(canonicalRemote("https://github.com")).toBeNull();
    expect(canonicalRemote("")).toBeNull();
  });
});

describe("同步目标解析（纯）", () => {
  it("tea 配置命中 → apiBase 带 Gitea 根路径前缀", () => {
    const t = resolveSyncTarget({ remote: REMOTE, teaConfig: TEA_CONFIG, env: {} });
    expect(t).toMatchObject({
      ok: true,
      forge: "gitea",
      apiBase: "https://gitea.example.com/git/api/v1",
      owner: "owner",
      repo: "repo",
      source: "tea",
    });
  });

  it("GitHub 形态：forge=github，apiBase 走 api.github.com（不带 /api/v1）", () => {
    const t = resolveSyncTarget({ remote: "https://github.com/acme/demo.git", teaConfig: TEA_CONFIG, env: {} });
    expect(t).toMatchObject({ ok: true, forge: "github", apiBase: "https://api.github.com", owner: "acme", repo: "demo" });
  });

  it("没有 token 的 tea 配置 → 环境变量兜底（Gitea root 主机必须一致）", () => {
    const env = { FLOWCARD_GITEA_ROOT: "https://gitea.example.com/git", FLOWCARD_GITEA_TOKEN: "env-t0ken" };
    expect(resolveSyncTarget({ remote: REMOTE, teaConfig: "", env })).toMatchObject({
      ok: true,
      source: "env-gitea",
      apiBase: "https://gitea.example.com/git/api/v1",
      owner: "owner",
    });
    // 主机不一致 = 会把 token 发给别的主机：宁可不用
    expect(
      resolveSyncTarget({ remote: REMOTE, teaConfig: "", env: { ...env, FLOWCARD_GITEA_ROOT: "https://evil.example" } }),
    ).toEqual({ ok: false, reason: "no-credentials" });
  });

  it("GitHub token 只对 github.com 生效；都没有 → no-credentials（不抛）", () => {
    expect(
      resolveSyncTarget({ remote: "https://github.com/acme/demo", teaConfig: "", env: { FLOWCARD_GITHUB_TOKEN: "gh-t0ken" } }),
    ).toMatchObject({ ok: true, source: "env-github", apiBase: "https://api.github.com" });
    expect(
      resolveSyncTarget({ remote: REMOTE, teaConfig: "", env: { FLOWCARD_GITHUB_TOKEN: "gh-t0ken" } }),
    ).toEqual({ ok: false, reason: "no-credentials" });
    expect(resolveSyncTarget({ remote: "not a url", teaConfig: TEA_CONFIG, env: {} })).toEqual({
      ok: false,
      reason: "no-remote",
    });
  });
});

// ---------------------------------------------------------------- URL / 认证头

describe("端点 URL 与认证头（纯）", () => {
  it("Gitea：limit + type=issues + since；评论端点不带 type；pulls 不带 since（服务端会忽略）", () => {
    const auth = giteaAuth();
    expect(endpointUrl(auth, "issues", { since: "2026-10-09T05:55:43Z", page: 2 })).toBe(
      "https://gitea.example.com/git/api/v1/repos/owner/repo/issues?page=2&limit=50&type=issues&since=2026-10-09T05%3A55%3A43Z&state=all",
    );
    expect(endpointUrl(auth, "comments", { since: "2026-10-09T05:55:43Z" })).toBe(
      "https://gitea.example.com/git/api/v1/repos/owner/repo/issues/comments?page=1&limit=50&since=2026-10-09T05%3A55%3A43Z",
    );
    const pullsUrl = endpointUrl(auth, "pulls", { since: "2026-10-09T05:55:43Z" });
    expect(pullsUrl).toBe(
      "https://gitea.example.com/git/api/v1/repos/owner/repo/pulls?page=1&limit=50&sort=recentupdate&state=all",
    );
    expect(pullsUrl).not.toContain("since=");
    expect(singleUrl(auth, "pulls", 745)).toBe("https://gitea.example.com/git/api/v1/repos/owner/repo/pulls/745");
  });

  it("GitHub：per_page，且没有 Gitea 的 type 参数；认证头是 Bearer", () => {
    const auth = giteaAuth({ forge: "github", apiBase: "https://api.github.com", source: "env-github" });
    const url = endpointUrl(auth, "issues", { page: 3 });
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues?page=3&per_page=50&state=all");
    expect(url).not.toContain("type=");
    expect(authHeaders(auth)["Authorization"]).toBe("Bearer t0ken-fake-gitea");
    expect(authHeaders(giteaAuth())["Authorization"]).toBe("token t0ken-fake-gitea");
  });
});

// ---------------------------------------------------------------- 响应解析

describe("issue / PR / 评论解析（纯）", () => {
  it("issue：updated_at 归一化成 UTC ISO（Gitea 给的是 +08:00）", () => {
    expect(parseIssue(ISSUE_742)).toEqual({
      number: 742,
      title: ISSUE_742.title,
      state: "open",
      updatedAt: "2026-10-09T09:21:33.000Z",
      comments: 0,
    });
    expect(toIso("2026-10-10T04:58:46Z")).toBe("2026-10-10T04:58:46.000Z");
    expect(toIso("不是时间")).toBeNull();
  });

  it("issue 列表：混进来的 PR 被过滤，坏条目被丢掉而不是编造", () => {
    const list = parseIssueList([
      ISSUE_742,
      ISSUE_LIST_ENTRY_PR,
      { number: 1, title: "缺 state", updated_at: "2026-10-09T00:00:00Z" },
      "垃圾",
      null,
    ]);
    expect(list.map((i) => i.number)).toEqual([742]);
    expect(parseIssueList("不是数组")).toEqual([]);
  });

  it("PR：closed + merged=true → merged；closed 但未 merged → closed", () => {
    expect(parsePull(PULL_745)).toEqual({
      number: 745,
      state: "merged",
      merged: true,
      head: "codex/trim-native-shell-tests",
      base: "master",
      updatedAt: "2026-10-10T04:42:54.000Z",
      url: "http://gitea.example.com/git/owner/repo/pulls/745",
    });
    expect(pullState("closed", false)).toBe("closed");
    expect(pullState("closed", null)).toBe("closed");
    expect(pullState("open", false)).toBe("open");
    expect(pullState("merged", null)).toBe("merged");
    const noMergedFlag = parsePull({ ...PULL_745, merged: undefined });
    expect(noMergedFlag).toMatchObject({ state: "closed", merged: null });
    expect(parsePullList([PULL_745, GH_PULL]).map((p) => p.state)).toEqual(["merged", "closed"]);
  });

  it("评论：issue_url 空串时从 pull_request_url / html_url 抠编号", () => {
    expect(parseComment(COMMENT_7438)).toEqual({
      id: 7438,
      issueNumber: 735,
      author: "suzmii",
      body: COMMENT_7438.body,
      at: "2026-10-09T05:56:21.000Z",
      url: COMMENT_7438.html_url,
    });
    expect(parseComment(COMMENT_7633)?.issueNumber).toBe(564);
    expect(parseComment(COMMENT_7679)?.issueNumber).toBe(720);
    expect(parseComment(GH_COMMENT)).toMatchObject({ id: 9001, issueNumber: 12, author: "octocat" });
    expect(issueNumberFromUrls({ issue_url: "…/issues/12#issuecomment-1" })).toBe(12);
    // 抠不出编号的评论直接丢（没法路由到卡片）
    expect(parseComment({ id: 1, created_at: "2026-10-10T00:00:00Z", body: "x" })).toBeNull();
    expect(parseCommentList([COMMENT_7438, null, 42])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 轮询：分页 / 降级

describe("轮询（纯 IO 注入，不联网）", () => {
  const auth = giteaAuth();
  const base = `${auth.apiBase}/repos/owner/repo`;

  function pollWith(routes: Record<string, HttpOutcome>, since?: string, onCall?: (url: string) => void) {
    return pollRemote({
      remote: REMOTE,
      teaConfig: TEA_CONFIG,
      env: {},
      ...(since === undefined ? {} : { since }),
      http: fakeHttp(routes, onCall),
      now: () => "2026-10-10T06:00:00.000Z",
    });
  }

  it("三个端点都通：解析 + since 透传 + 空 degraded", async () => {
    const snapped = await pollWith(
      {
        [`${base}/issues?page=1&limit=50&type=issues&since=2026-10-09T05%3A55%3A43Z&state=all`]: jsonOk([ISSUE_742, ISSUE_LIST_ENTRY_PR]),
        [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: jsonOk([PULL_745]),
        [`${base}/issues/comments?page=1&limit=50&since=2026-10-09T05%3A55%3A43Z`]: jsonOk([COMMENT_7438, COMMENT_7633]),
      },
      "2026-10-09T05:55:43Z",
    );
    expect(snapped).toMatchObject({ ok: true, source: "api", owner: "owner", since: "2026-10-09T05:55:43Z" });
    if (!snapped.ok) throw new Error("should be ok");
    expect(snapped.issues.map((i) => i.number)).toEqual([742]);
    expect(snapped.pulls[0]).toMatchObject({ number: 745, state: "merged" });
    expect(snapped.comments.map((c) => c.issueNumber)).toEqual([735, 564]);
    expect(snapped.degraded).toEqual([]);
  });

  it("分页：第一页满 50 → 翻第二页；不满就停", async () => {
    const full = Array.from({ length: PAGE_LIMIT }, (_, n) => ({ ...ISSUE_742, number: 100 + n }));
    const calls: string[] = [];
    const snapped = await pollWith(
      {
        [`${base}/issues?page=1&limit=50&type=issues&state=all`]: jsonOk(full),
        [`${base}/issues?page=2&limit=50&type=issues&state=all`]: jsonOk([{ ...ISSUE_742, number: 900 }]),
        [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: jsonOk([]),
        [`${base}/issues/comments?page=1&limit=50`]: jsonOk([]),
      },
      undefined,
      (url) => calls.push(url),
    );
    if (!snapped.ok) throw new Error("should be ok");
    expect(snapped.issues).toHaveLength(PAGE_LIMIT + 1);
    expect(calls.filter((u) => u.includes("/issues?"))).toHaveLength(2);
  });

  it("分页上限：永远满页也只翻 MAX_PAGES 页，并记一条 note", async () => {
    const full = Array.from({ length: PAGE_LIMIT }, (_, n) => ({ ...ISSUE_742, number: 100 + n }));
    let issueCalls = 0;
    const routes: Record<string, HttpOutcome> = {
      [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: jsonOk([]),
      [`${base}/issues/comments?page=1&limit=50`]: jsonOk([]),
    };
    for (let page = 1; page <= MAX_PAGES + 2; page++) {
      routes[`${base}/issues?page=${page}&limit=50&type=issues&state=all`] = jsonOk(full);
    }
    const snapped = await pollWith(routes, undefined, (url) => {
      if (url.includes("/issues?")) issueCalls++;
    });
    if (!snapped.ok) throw new Error("should be ok");
    expect(issueCalls).toBe(MAX_PAGES);
    expect(snapped.issues).toHaveLength(PAGE_LIMIT * MAX_PAGES);
    expect(snapped.notes.join("\n")).toContain(`${MAX_PAGES} 页上限`);
  });

  it("降级：401 / 404 / 网络错误各成一个 degraded，其余端点照常", async () => {
    const unauth = await pollWith({
      [`${base}/issues?page=1&limit=50&type=issues&state=all`]: { ok: false, reason: "unauthorized", status: 401, detail: "401 Unauthorized" },
      [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: { ok: false, reason: "not-found", status: 404, detail: "404 Not Found" },
      [`${base}/issues/comments?page=1&limit=50`]: { ok: false, reason: "network", status: null, detail: "fetch failed" },
    });
    if (!unauth.ok) throw new Error("降级不是失败");
    expect(unauth.degraded).toEqual([
      { endpoint: "issues", reason: "unauthorized", status: 401, detail: "401 Unauthorized" },
      { endpoint: "pulls", reason: "not-found", status: 404, detail: "404 Not Found" },
      { endpoint: "comments", reason: "network", status: null, detail: "fetch failed" },
    ]);
    expect([unauth.issues, unauth.pulls, unauth.comments]).toEqual([[], [], []]);
  });

  it("第二页失败：保留第一页，记 note，不整体降级", async () => {
    const full = Array.from({ length: PAGE_LIMIT }, (_, n) => ({ ...ISSUE_742, number: 100 + n }));
    const snapped = await pollWith({
      [`${base}/issues?page=1&limit=50&type=issues&state=all`]: jsonOk(full),
      [`${base}/issues?page=2&limit=50&type=issues&state=all`]: { ok: false, reason: "timeout", status: null, detail: "aborted" },
      [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: jsonOk([]),
      [`${base}/issues/comments?page=1&limit=50`]: jsonOk([]),
    });
    if (!snapped.ok) throw new Error("should be ok");
    expect(snapped.issues).toHaveLength(PAGE_LIMIT);
    expect(snapped.degraded).toEqual([]);
    expect(snapped.notes.join("\n")).toContain("第 2 页失败（timeout）");
  });

  it("响应不是 JSON / 不是数组 → parse-error 降级，不抛", async () => {
    const snapped = await pollWith({
      [`${base}/issues?page=1&limit=50&type=issues&state=all`]: { ok: true, status: 200, text: "<html>500</html>" },
      [`${base}/pulls?page=1&limit=50&sort=recentupdate&state=all`]: jsonOk([]),
      [`${base}/issues/comments?page=1&limit=50`]: jsonOk({ message: "不是数组" }),
    });
    if (!snapped.ok) throw new Error("should be ok");
    expect(snapped.degraded.map((d) => d.reason)).toEqual(["parse-error", "parse-error"]);
    expect(snapped.issues).toEqual([]);
  });

  it("没有凭据且没有仓库目录 → ok:false / no-credentials（不抛）", async () => {
    const out = await pollRemote({ remote: REMOTE, teaConfig: "", env: {}, http: fakeHttp({}) });
    expect(out).toEqual({
      ok: false,
      reason: "no-credentials",
      notes: [
        "没有可用的 Gitea/GitHub 凭据（tea 配置 / FLOWCARD_GITEA_TOKEN / FLOWCARD_GITHUB_TOKEN 都没有）",
        "没有可用 token，且不知道仓库目录：无法用 tea CLI 兜底",
      ],
    });
  });

  it("无凭据但有仓库 → tea CLI 兜底：merged 标 null、评论 unavailable", async () => {
    const out = await pollRemote({
      remote: REMOTE,
      repoPath: "/tmp/fc-sync/repo",
      teaConfig: TEA_CONFIG.replace(/token: "?t0ken-fake-[a-z]+"?/g, 'token: ""'),
      env: {},
      run: fakeRun({ issues: ok(JSON.stringify(TEA_CLI_ISSUES)), pulls: ok(JSON.stringify(TEA_CLI_PULLS)) }),
      now: () => "2026-10-10T06:00:00.000Z",
    });
    if (!out.ok) throw new Error("应走 CLI 兜底");
    expect(out.source).toBe("tea-cli");
    expect(out.issues.map((i) => i.number)).toEqual([749]);
    expect(out.pulls[1]).toMatchObject({ number: 745, state: "closed", merged: null, head: "codex/trim-native-shell-tests" });
    expect(out.comments).toEqual([]);
    expect(out.degraded.map((d) => d.endpoint)).toEqual(["comments", "pulls"]);
  });

  it("tea CLI：未安装 / 命令失败 → ok:false，且原因写在 notes 里", async () => {
    const missing: RunOutcome = { code: 127, stdout: "", stderr: "tea: 未安装", missing: true };
    const out = await pollRemote({
      remote: REMOTE,
      repoPath: "/tmp/fc-sync/repo",
      teaConfig: "",
      env: {},
      run: fakeRun({ issues: missing, pulls: missing }),
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("不该成功");
    expect(out.notes.join("\n")).toContain("tea 未安装");
  });

  it("tea CLI 参数：-R origin + JSON + 全量 state", () => {
    expect(teaListArgv("issues", 50)).toEqual([
      "issues", "ls", "-R", "origin", "--output", "json", "--state", "all", "--limit", "50", "--fields",
      "index,title,state,updated,comments,url,author",
    ]);
    expect(teaListArgv("pulls").join(" ")).toContain("--fields index,state,author,url,title,base,head,updated");
    expect(parseTeaCliIssues(TEA_CLI_ISSUES)[0]).toEqual({
      number: 749,
      title: "AGC 陶泥儿发布面板默认允许全开放共创",
      state: "open",
      updatedAt: "2026-10-10T04:58:46.000Z",
      comments: 0,
    });
    expect(parseTeaCliPulls(TEA_CLI_PULLS).map((p) => [p.number, p.state, p.merged])).toEqual([
      [750, "open", null],
      [745, "closed", null],
    ]);
    expect(parseTeaCliIssues("垃圾")).toEqual([]);
  });
});

// ---------------------------------------------------------------- 按号精确读

describe("fetchIssue / fetchPull（只读单条）", () => {
  const auth = giteaAuth();
  const base = `${auth.apiBase}/repos/owner/repo`;

  it("拿到就解析成同一种纯数据", async () => {
    const http = fakeHttp({ [`${base}/pulls/745`]: jsonOk(PULL_745), [`${base}/issues/742`]: jsonOk(ISSUE_742) });
    await expect(fetchPull(auth, 745, http)).resolves.toEqual({
      ok: true,
      item: {
        number: 745,
        state: "merged",
        merged: true,
        head: "codex/trim-native-shell-tests",
        base: "master",
        updatedAt: "2026-10-10T04:42:54.000Z",
        url: "http://gitea.example.com/git/owner/repo/pulls/745",
      },
    });
    const issue = await fetchIssue(auth, 742, http);
    expect(issue).toMatchObject({ ok: true, item: { number: 742, state: "open", comments: 0 } });
  });

  it("404 / 401 / 网络错误都降级成带原因的结果，不抛", async () => {
    const http = fakeHttp({
      [`${base}/pulls/745`]: { ok: false, reason: "not-found", status: 404, detail: "404 Not Found" },
      [`${base}/issues/742`]: { ok: false, reason: "unauthorized", status: 401, detail: "401 Unauthorized" },
    });
    await expect(fetchPull(auth, 745, http)).resolves.toEqual({ ok: false, reason: "not-found", status: 404, detail: "404 Not Found" });
    await expect(fetchIssue(auth, 742, http)).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
      status: 401,
      detail: "401 Unauthorized",
    });
    const broken = fakeHttp({ [`${base}/pulls/999`]: { ok: true, status: 200, text: "<html>" } });
    await expect(fetchPull(auth, 999, broken)).resolves.toEqual({
      ok: false,
      reason: "parse-error",
      status: 200,
      detail: "响应不是 pulls 对象",
    });
  });
});

// ---------------------------------------------------------------- 默认 HTTP 实现

describe("defaultHttpGet（本地假服务，无外网）", () => {
  it("status 分类正确；超时（哪怕发生在读 body 途中）折成 timeout 而不是抛异常", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/partial") {
        // 头先回来、body 永远写不完 → 超时发生在 `res.text()` 里（实测大页 PR 列表会撞上这一支）
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"a":');
        return;
      }
      if (req.url === "/404") {
        res.writeHead(404).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end('[{"number":1}]');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    try {
      await expect(defaultHttpGet(`${base}/partial`, {}, 150)).resolves.toMatchObject({ ok: false, reason: "timeout", status: null });
      await expect(defaultHttpGet(`${base}/404`, {})).resolves.toMatchObject({ ok: false, reason: "not-found", status: 404 });
      await expect(defaultHttpGet(`${base}/ok`, {})).resolves.toEqual({ ok: true, status: 200, text: '[{"number":1}]' });
      await expect(defaultHttpGet("http://127.0.0.1:1/nope", {})).resolves.toMatchObject({ ok: false, reason: "network", status: null });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------- 差异 → 事实

describe("toFacts：只出差异 + 幂等键", () => {
  const snapshot: SyncSnapshotData = {
    issues: [
      { number: 742, title: "超时", state: "open", updatedAt: "2026-10-09T09:21:33.000Z", comments: 0 },
      { number: 743, title: "缓存", state: "closed", updatedAt: "2026-10-10T04:00:00.000Z", comments: 2 },
    ],
    pulls: [{ number: 745, state: "merged", merged: true, head: "codex/x", base: "master", updatedAt: "2026-10-10T04:42:54.000Z", url: "u" }],
    comments: [
      { id: 7438, issueNumber: 735, author: "suzmii", body: "b1", at: "2026-10-09T05:56:21.000Z", url: "u1" },
      { id: 7633, issueNumber: 564, author: "lhk229", body: "b2", at: "2026-10-10T03:27:43.000Z", url: "u2" },
    ],
  };

  it("首轮（prev=null）：全部条目各出一条", () => {
    const facts = toFacts(null, snapshot);
    expect(facts.map(factKey)).toEqual([
      "sync:issue:742:2026-10-09T09:21:33.000Z",
      "sync:issue:743:2026-10-10T04:00:00.000Z",
      "sync:pr:745:merged:2026-10-10T04:42:54.000Z",
      "sync:comment:7438",
      "sync:comment:7633",
    ]);
  });

  it("再同步一次（状态/更新时间没变）→ 空数组", () => {
    const prev = {
      issues: snapshot.issues,
      pulls: snapshot.pulls,
      commentKeys: snapshot.comments.map((c) => `sync:comment:${c.id}`),
    };
    expect(toFacts(prev, snapshot)).toEqual([]);
  });

  it("只有变化的才发：issue 关掉、PR 合并、新评论", () => {
    const prev = {
      issues: [snapshot.issues[0]!, { ...snapshot.issues[1]!, state: "open" }],
      pulls: [{ number: 745, state: "open", merged: false, updatedAt: "2026-10-10T04:00:00.000Z" }],
      commentKeys: ["sync:comment:7438"],
    };
    const next: SyncSnapshotData = {
      ...snapshot,
      issues: [snapshot.issues[0]!, snapshot.issues[1]!],
      comments: [snapshot.comments[0]!, snapshot.comments[1]!, { ...snapshot.comments[1]!, id: 7633 }],
    };
    const facts = toFacts(prev, next);
    expect(facts).toEqual([
      { kind: "issue.state", number: 743, state: "closed", title: "缓存", updatedAt: "2026-10-10T04:00:00.000Z" },
      {
        kind: "pr.state",
        number: 745,
        state: "merged",
        merged: true,
        head: "codex/x",
        base: "master",
        url: "u",
        updatedAt: "2026-10-10T04:42:54.000Z",
      },
      { kind: "remote.comment", id: 7633, issueNumber: 564, author: "lhk229", body: "b2", at: "2026-10-10T03:27:43.000Z", url: "u2" },
    ]);
    expect(facts.map(factKey)).toEqual([
      "sync:issue:743:2026-10-10T04:00:00.000Z",
      "sync:pr:745:merged:2026-10-10T04:42:54.000Z",
      "sync:comment:7633",
    ]);
  });

  it("numbers 过滤：只出看板上真有卡片的编号（事件必须挂 cardId）", () => {
    // 过滤键是 issue/PR **编号**（评论按它挂着的那张卡过滤，不是评论 id）
    const facts = toFacts(null, snapshot, { numbers: [743, 564] });
    expect(facts.map(factKey)).toEqual(["sync:issue:743:2026-10-10T04:00:00.000Z", "sync:comment:7633"]);
    expect(toFacts(null, snapshot, { numbers: [] })).toEqual([]);
    expect(toFacts(null, snapshot, { numbers: [735] }).map(factKey)).toEqual(["sync:comment:7438"]);
  });

  it("幂等键稳定：同一事实两次 → 同一 key；同一 PR 换状态 → 换 key", () => {
    const a = factKey({ kind: "pr.state", number: 745, state: "merged", merged: true, head: "h", base: "b", url: "u", updatedAt: "t" });
    const b = factKey({ kind: "pr.state", number: 745, state: "merged", merged: true, head: "h2", base: "b2", url: "u2", updatedAt: "t" });
    const c = factKey({ kind: "pr.state", number: 745, state: "open", merged: false, head: "h", base: "b", url: "u", updatedAt: "t2" });
    expect(a).toBe("sync:pr:745:merged:t");
    expect(a).toBe(b);
    expect(c).toBe("sync:pr:745:open:t2");
    expect(factKey({ kind: "issue.state", number: 742, state: "open", title: "t", updatedAt: "u" })).toBe("sync:issue:742:u");
    expect(factKey({ kind: "remote.comment", id: 7, issueNumber: 1, author: "a", body: "b", at: "c", url: "d" })).toBe("sync:comment:7");
  });
});
