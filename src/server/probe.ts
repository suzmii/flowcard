/**
 * 探测（M3）：从会话 cwd 反查 worktree/分支，探测 PR 状态与 CI，并读本地进度信号。
 *
 * 分层（跟设计 §3.1 第 4 条与 §7 的「纯函数 / 薄适配层」一致）：
 *   1. **纯函数**：git/gh/tea 的 argv 拼装、命令输出解析、状态判定 —— 全部可单测；
 *   2. **薄 IO**：`probe(cwd, { run })` 只负责跑命令、把结果拼成 `ProbeResult`；
 *      `run` 可注入 —— 测试里用假的 gh/tea 输出，不依赖真的工具与网络。
 *
 * 只读：这里只跑 `git rev-parse/status/log/rev-list/remote`、`gh pr view`、`tea pulls list`。
 * 没有任何 fetch/push/pull 或远程写；工具缺失 / 未登录 / 无远程一律**降级并说明**，不报错。
 */
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { PrRef, WorktreeRef } from "../shared/types.ts";

export const GIT_TIMEOUT_MS = 5_000;
export const TOOL_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- 执行层（可注入）

export type RunOpts = { cwd?: string; timeoutMs?: number };

export type RunOutcome = {
  code: number;
  stdout: string;
  stderr: string;
  /** true = 命令本身不存在（ENOENT）——用来区分「没装」与「跑了但失败」。 */
  missing: boolean;
};

export type Run = (file: string, args: string[], opts?: RunOpts) => Promise<RunOutcome>;

/**
 * Node ≥22 有 `Promise.withResolvers`（ES2024），但本仓 tsconfig 的 `lib` 是 ES2023 —— 补个类型收窄。
 */
const promiseLib = Promise as unknown as {
  withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T) => void };
};

/** 默认执行器：`execFile`（不经过 shell），带超时与输出上限；环境不变，只关掉交互提示。 */
export function defaultRun(file: string, args: string[], opts: RunOpts = {}): Promise<RunOutcome> {
  const { promise, resolve: settle } = promiseLib.withResolvers<RunOutcome>();
  execFile(
    file,
    args,
    {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    },
    (error, stdout, stderr) => {
      const out = typeof stdout === "string" ? stdout : "";
      const err = typeof stderr === "string" ? stderr : "";
      if (!error) {
        settle({ code: 0, stdout: out, stderr: err, missing: false });
        return;
      }
      const e = error as NodeJS.ErrnoException & { code?: number | string };
      const missing = e.code === "ENOENT";
      const code = typeof e.code === "number" ? e.code : missing ? 127 : 1;
      settle({ code, stdout: out, stderr: err || (missing ? `${file}: 未安装` : e.message), missing });
    },
  );
  return promise;
}

// ---------------------------------------------------------------- argv 拼装（纯）

export type GitArgv = {
  toplevel: string[];
  branch: string[];
  gitDir: string[];
  commonDir: string[];
  head: string[];
  status: string[];
  remote: string[];
  upstream: string[];
  /** `git log --oneline @{u}..HEAD` —— 本地未推送提交。 */
  unpushed: string[];
  verify: (ref: string) => string[];
  count: (range: string) => string[];
};

/** 所有 git 探测命令都用 `-C <cwd>`，不依赖进程 cwd。 */
export function gitArgv(cwd: string): GitArgv {
  const base = ["-C", cwd];
  return {
    toplevel: [...base, "rev-parse", "--show-toplevel"],
    branch: [...base, "rev-parse", "--abbrev-ref", "HEAD"],
    gitDir: [...base, "rev-parse", "--path-format=absolute", "--git-dir"],
    commonDir: [...base, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    head: [...base, "rev-parse", "HEAD"],
    status: [...base, "status", "--porcelain"],
    remote: [...base, "remote", "get-url", "origin"],
    upstream: [...base, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    unpushed: [...base, "log", "--oneline", "@{u}..HEAD"],
    verify: (ref: string) => [...base, "rev-parse", "--verify", "--quiet", ref],
    count: (range: string) => [...base, "rev-list", "--count", range],
  };
}

/** GitHub：按分支名取 PR + CI 汇总（`statusCheckRollup` 含 CheckRun / StatusContext）。 */
export function ghArgv(branch: string): string[] {
  return [
    "pr",
    "view",
    branch,
    "--json",
    "number,url,state,isDraft,headRefName,statusCheckRollup",
  ];
}

/** Gitea（tea 0.16）：列出全部 PR 并带 head/ci 字段，再按分支名挑。 */
export function teaArgv(): string[] {
  return [
    "pulls",
    "list",
    "--state",
    "all",
    "--output",
    "json",
    "--limit",
    "50",
    "--fields",
    "index,state,url,title,head,base,ci",
  ];
}

// ---------------------------------------------------------------- 通用解析（纯）

export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export function countLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (line.trim()) n += 1;
  return n;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 远程 / forge（纯）

export type Forge = "github" | "gitea" | "unknown";

export type Remote = {
  /// 原始 URL（去掉尾部 .git 之前的形式不保留，这里就是原样 trim）。
  raw: string;
  host: string;
  owner: string;
  repo: string;
  /// `<owner>/<repo>`，直接喂给 PrRef.repo。
  slug: string;
  forge: Forge;
};

/**
 * 解析 `git remote get-url origin` 的几种常见形态：
 *   https://host/owner/repo(.git)   |   ssh://git@host[:port]/owner/repo(.git)   |   git@host:owner/repo(.git)
 * 自建 Gitea 常见带根路径前缀（`https://gitea.example.com/git/owner/repo`）→ 取最后两段。
 */
export function parseRemoteUrl(raw: string): Remote | null {
  const text = raw.trim();
  if (!text) return null;

  let host = "";
  let path = "";
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text); // git@host:owner/repo
  if (/^ssh:\/\//i.test(text)) {
    const m = /^ssh:\/\/(?:[^@/]*@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (!m) return null;
    host = m[1] ?? "";
    path = m[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/]+)(?::\d+)?\/(.+)$/i.exec(text);
    if (!m) return null;
    host = m[1] ?? "";
    path = m[2] ?? "";
  } else if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    return null;
  }

  const segments = path.replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const repo = segments[segments.length - 1]!;
  const owner = segments[segments.length - 2]!;
  const lowerHost = host.toLowerCase();
  const forge: Forge = lowerHost === "github.com" || lowerHost.endsWith(".github.com") ? "github" : "gitea";
  return { raw: text, host, owner, repo, slug: `${owner}/${repo}`, forge };
}

/** 从 PR 网页 URL 兜底取 `<owner>/<repo>`（远程缺失时用）。 */
export function slugFromPrUrl(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+?)\/(?:pulls|pull)\/\d+/i.exec(url);
  if (!m) return null;
  const segments = (m[1] ?? "").split("/").filter(Boolean);
  if (segments.length < 2) return null;
  return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

/** 按 forge 决定先试谁（另一个作为兜底）。 */
export function probeOrder(forge: Forge): ["gh" | "tea", "gh" | "tea"] {
  return forge === "github" ? ["gh", "tea"] : ["tea", "gh"];
}

// ---------------------------------------------------------------- worktree 判定（纯）

export type WorktreeVerdict = {
  /** worktree 根（`--show-toplevel` 的绝对路径）。 */
  path: string;
  /** 分支名；**detached HEAD → null**（没有分支，不能拿来开 PR / 清理）。 */
  branch: string | null;
  /** 谁建的（启发式，见 docs/probe.md §9）。 */
  source: "harness" | "flowcard";
  /** true = linked worktree；false = 主仓库工作区。 */
  isWorktree: boolean;
  /** true = 处于 detached HEAD。 */
  detached: boolean;
  /** 主仓库根（= git-common-dir 的父目录）。 */
  mainRoot: string;
  gitDir: string;
  commonDir: string;
  /** 是否落在约定的 `<主仓库>/.worktrees/` 下。 */
  underWorktreesDir: boolean;
  /**
   * 可绑卡的值：**只有 linked worktree 且不在 detached HEAD 时非 null**。
   * detached worktree 的路径虽然有用，但绑上去分支只会是空的 —— 探测是自动跑的，
   * 自动写绝不能让卡片信息变差，所以这里直接给 null（不回写）。
   */
  bindable: WorktreeRef | null;
};

/** 路径段比较复用共享实现（单一来源）；probe 内部拿到的路径都是绝对路径。 */
export { isInside } from "../shared/paths.ts";

/**
 * 判定 cwd 是主仓库还是 linked worktree。
 * 判据（两条任一成立即为 worktree）：
 *   1. `--show-toplevel` ≠ 主仓库根；
 *   2. `--git-dir` ≠ `--git-common-dir`（worktree 的 git-dir 是 `<主仓库>/.git/worktrees/<名字>`）。
 * 主仓库根由 `--git-common-dir`（`<主仓库>/.git`）取父目录得到 —— **主仓库不会被当成 worktree**。
 */
export function classifyWorktree(input: {
  toplevel: string;
  gitDir: string;
  commonDir: string;
  branch: string;
}): WorktreeVerdict | null {
  const toplevel = input.toplevel.trim();
  if (!toplevel) return null;
  const path = resolve(toplevel);
  const gitDir = input.gitDir.trim();
  const commonDir = resolve(input.commonDir.trim() || gitDir || path);
  const mainRoot = dirname(commonDir);
  const isWorktree = path !== mainRoot || (gitDir !== "" && resolve(gitDir) !== commonDir);
  // `--abbrev-ref HEAD` 在 detached HEAD 时返回字面量 "HEAD"；空输出同样按 detached 处理。
  const rawBranch = input.branch.trim();
  const detached = rawBranch === "" || rawBranch === "HEAD";
  const branch = detached ? null : rawBranch;
  const worktreesDir = `${mainRoot}/.worktrees/`;
  const underWorktreesDir = path.startsWith(worktreesDir);
  // 谁建的无法真正知道；按 `.worktrees/<名字>` 约定推断（设计 §3.1 方式 B 用这个路径）。
  const source: WorktreeRef["source"] = underWorktreesDir ? "flowcard" : "harness";
  return {
    path,
    branch,
    source,
    isWorktree,
    detached,
    mainRoot,
    gitDir,
    commonDir,
    underWorktreesDir,
    bindable: isWorktree && branch !== null ? { path, branch, source } : null,
  };
}

// ---------------------------------------------------------------- PR / CI 解析（纯）

export type Ci = "pending" | "pass" | "fail";

export type ProbeOrdered = { pr: PrRef | null; source: "gh" | "tea" | null; probed: boolean; notes: string[] };

const GH_FAIL: Record<string, true> = {
  FAILURE: true,
  ERROR: true,
  CANCELLED: true,
  TIMED_OUT: true,
  ACTION_REQUIRED: true,
  STARTUP_FAILURE: true,
};
const GH_PENDING: Record<string, true> = {
  PENDING: true,
  QUEUED: true,
  IN_PROGRESS: true,
  WAITING: true,
  REQUESTED: true,
  EXPECTED: true,
};

/**
 * `gh pr view --json statusCheckRollup` → CI 结论。
 * rollup 项要么是 CheckRun（status/conclusion），要么是 StatusContext（state）。
 * 任一失败 → fail；否则任一未完成 → pending；否则 pass；空数组 → undefined（没有 CI）。
 */
export function ciFromGhRollup(rollup: unknown): Ci | undefined {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  let pending = false;
  for (const raw of rollup) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const status = String(item.status ?? "").toUpperCase();
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    const state = String(item.state ?? "").toUpperCase();
    if (GH_FAIL[conclusion] === true || GH_FAIL[state] === true) return "fail";
    if ((status !== "" && status !== "COMPLETED") || GH_PENDING[status] === true || GH_PENDING[state] === true) {
      pending = true;
    }
  }
  return pending ? "pending" : "pass";
}

/** Gitea 组合状态（tea 的 `ci` 字段）→ CI 结论。 */
export function ciFromTeaStatus(ci: unknown): Ci | undefined {
  const value = String(ci ?? "").trim().toLowerCase();
  if (!value) return undefined;
  if (value === "success" || value === "skipped") return "pass";
  if (value === "failure" || value === "error") return "fail";
  if (value === "pending" || value === "running" || value === "queued" || value === "warning") return "pending";
  return undefined;
}

/** gh 的 PR JSON → PrRef。取不到 number/url 就返回 null（不猜）。 */
export function ghPrToRef(gh: unknown, remote: Remote | null, fallbackBranch: string): PrRef | null {
  if (!gh || typeof gh !== "object") return null;
  const o = gh as Record<string, unknown>;
  const number = typeof o.number === "number" ? o.number : Number(o.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const url = typeof o.url === "string" ? o.url : "";
  if (!url) return null;
  const repo = remote?.slug ?? slugFromPrUrl(url);
  if (!repo) return null;
  const head = typeof o.headRefName === "string" && o.headRefName ? o.headRefName : fallbackBranch;
  const stateRaw = String(o.state ?? "").toUpperCase();
  const state: PrRef["state"] =
    stateRaw === "MERGED" ? "merged" : stateRaw === "CLOSED" ? "closed" : o.isDraft === true ? "draft" : "open";
  const ci = ciFromGhRollup(o.statusCheckRollup);
  return { repo, number, url, branch: head, state, ...(ci ? { ci } : {}) };
}

/** tea `pulls list --output json` → 按 head 分支挑出目标 PR。列表通常是「最近更新在前」。 */
export function pickTeaPull(pulls: unknown, branch: string): Record<string, unknown> | null {
  if (!Array.isArray(pulls)) return null;
  for (const raw of pulls) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const head = String(item.head ?? "").replace(/^refs\/heads\//, "");
    if (head === branch) return item;
  }
  return null;
}

/** tea 的 PR 条目 → PrRef（Gitea 列表里没有 draft 位，draft 会显示成 open）。 */
export function teaPullToRef(
  pull: unknown,
  remote: Remote | null,
  fallbackBranch: string,
): PrRef | null {
  if (!pull || typeof pull !== "object") return null;
  const o = pull as Record<string, unknown>;
  const number = Number.parseInt(String(o.index ?? ""), 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  const url = typeof o.url === "string" ? o.url : "";
  if (!url) return null;
  const repo = remote?.slug ?? slugFromPrUrl(url);
  if (!repo) return null;
  const headRaw = String(o.head ?? "").replace(/^refs\/heads\//, "");
  const branch = headRaw || fallbackBranch;
  const stateRaw = String(o.state ?? "").toLowerCase();
  const state: PrRef["state"] =
    stateRaw === "merged" ? "merged" : stateRaw === "closed" ? "closed" : stateRaw === "draft" ? "draft" : "open";
  const ci = ciFromTeaStatus(o.ci);
  return { repo, number, url, branch, state, ...(ci ? { ci } : {}) };
}

// ---------------------------------------------------------------- git 探测（薄 IO）

export type GitSignals = {
  /** 分支名（detached 时为 null）。 */
  branch: string | null;
  headSha: string | null;
  /** `git status --porcelain` 的**改动文件数**（含未跟踪）。 */
  changedFiles: number | null;
  /** `git log --oneline @{u}..HEAD` 的条数：本地未推送提交；无 upstream → null（未知）。 */
  unpushedCommits: number | null;
  /** `git rev-list --count <base>..HEAD`：相对基线（upstream 或 origin/HEAD）的本地提交数。 */
  commitsSinceBase: number | null;
  /** 上一步实际用的基线 ref。 */
  base: string | null;
  /** upstream ref（`origin/feat/x` 形式）；没有 → null。 */
  upstream: string | null;
  remoteUrl: string | null;
  remote: Remote | null;
  forge: Forge;
};

export type GitProbe = {
  ok: boolean;
  cwd: string;
  verdict: WorktreeVerdict | null;
  signals: GitSignals;
  notes: string[];
};

export function emptySignals(): GitSignals {
  return {
    branch: null,
    headSha: null,
    changedFiles: null,
    unpushedCommits: null,
    commitsSinceBase: null,
    base: null,
    upstream: null,
    remoteUrl: null,
    remote: null,
    forge: "unknown",
  };
}

/** 读 git 实况：worktree 判定 + 进度信号。cwd 不在仓库里 → `ok:false`（不抛）。 */
export async function probeGit(cwd: string, run: Run = defaultRun): Promise<GitProbe> {
  const argv = gitArgv(cwd);
  const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS) => run("git", args, { cwd, timeoutMs });

  const toplevel = await git(argv.toplevel);
  if (toplevel.code !== 0 || !toplevel.stdout.trim()) {
    return {
      ok: false,
      cwd,
      verdict: null,
      signals: emptySignals(),
      notes: [`cwd ${cwd} 不在 git 仓库内（git rev-parse 失败）：跳过探测`],
    };
  }

  const [branchR, gitDirR, commonDirR, headR, statusR, remoteR, upstreamR] = await Promise.all([
    git(argv.branch),
    git(argv.gitDir),
    git(argv.commonDir),
    git(argv.head),
    git(argv.status),
    git(argv.remote),
    git(argv.upstream),
  ]);

  // 老 git 不认 --path-format：退回到相对路径并以 toplevel 为基准解析。
  const commonDirRaw =
    commonDirR.code === 0 && commonDirR.stdout.trim()
      ? commonDirR.stdout.trim()
      : await fallbackPath(git, argv.commonDir.filter((a) => a !== "--path-format=absolute"), toplevel.stdout.trim());

  const verdict = classifyWorktree({
    toplevel: toplevel.stdout,
    gitDir: gitDirR.stdout,
    commonDir: commonDirRaw ?? "",
    branch: branchR.stdout,
  });

  const upstream = upstreamR.code === 0 ? firstLine(upstreamR.stdout) : null;
  const notes: string[] = [];

  // 基线：优先 upstream，退到 origin/HEAD（都是本地 remote-tracking ref，不联网）。
  let base = upstream;
  if (!base) {
    const originHead = await git(argv.verify("origin/HEAD"));
    if (originHead.code === 0 && originHead.stdout.trim()) base = firstLine(originHead.stdout);
  }

  const [unpushedR, countR] = await Promise.all([
    upstream ? git(argv.unpushed) : Promise.resolve<RunOutcome>({ code: 1, stdout: "", stderr: "", missing: false }),
    base ? git(argv.count(`${base}..HEAD`)) : Promise.resolve<RunOutcome>({ code: 1, stdout: "", stderr: "", missing: false }),
  ]);
  if (upstream && unpushedR.code !== 0) notes.push("读未推送提交失败（git log @{u}..HEAD）");
  if (!upstream) notes.push("分支没有 upstream：未推送提交数未知（只读探测，不 fetch）");

  const remoteUrl = remoteR.code === 0 ? firstLine(remoteR.stdout) : null;
  const remote = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  if (!remote) notes.push("拿不到 origin 远程（或不是常见 URL 形态）：PR 探测与 repo 归属会缺失");

  const branchRaw = firstLine(branchR.stdout);
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
  const commitsSinceBase = base && countR.code === 0 ? Number.parseInt(firstLine(countR.stdout), 10) : Number.NaN;

  return {
    ok: true,
    cwd,
    verdict,
    signals: {
      branch,
      headSha: headR.code === 0 ? firstLine(headR.stdout) || null : null,
      changedFiles: statusR.code === 0 ? countLines(statusR.stdout) : null,
      unpushedCommits: upstream && unpushedR.code === 0 ? countLines(unpushedR.stdout) : null,
      commitsSinceBase: Number.isFinite(commitsSinceBase) ? commitsSinceBase : null,
      base,
      upstream,
      remoteUrl,
      remote,
      forge: remote?.forge ?? "unknown",
    },
    notes,
  };
}

async function fallbackPath(git: (args: string[]) => Promise<RunOutcome>, args: string[], base: string): Promise<string | null> {
  const r = await git(args);
  const value = r.code === 0 ? firstLine(r.stdout) : "";
  if (!value) return null;
  return value.startsWith("/") ? value : resolve(base, value);
}

// ---------------------------------------------------------------- PR 探测（薄 IO）

export type PrProbe = ProbeOrdered;

/**
 * 按 forge 顺序试 gh / tea；**第一个给出确定答案的工具说了算**。
 * 工具缺失 / 未登录 / 网络失败 → 记 note 继续；都没有 → `probed:false`（明确报告「未探测」）。
 */
export async function probePr(
  ctx: { cwd: string; branch: string; remote: Remote | null },
  run: Run = defaultRun,
): Promise<PrProbe> {
  const notes: string[] = [];
  for (const tool of probeOrder(ctx.remote?.forge ?? "unknown")) {
    if (tool === "gh") {
      const r = await run("gh", ghArgv(ctx.branch), { cwd: ctx.cwd, timeoutMs: TOOL_TIMEOUT_MS });
      if (r.missing) {
        notes.push("gh 未安装：跳过 GitHub PR 探测");
        continue;
      }
      if (r.code !== 0) {
        notes.push(`gh 探测失败（exit ${r.code}）：${firstLine(r.stderr) || "无输出"}`);
        continue;
      }
      const parsed = parseJson(r.stdout);
      const pr = ghPrToRef(parsed, ctx.remote, ctx.branch);
      if (!pr) {
        notes.push("gh 成功但返回了无法解析/不完整的 JSON：跳过");
        continue;
      }
      return { pr, source: "gh", probed: true, notes };
    }

    const r = await run("tea", teaArgv(), { cwd: ctx.cwd, timeoutMs: TOOL_TIMEOUT_MS });
    if (r.missing) {
      notes.push("tea 未安装：跳过 Gitea PR 探测");
      continue;
    }
    if (r.code !== 0) {
      notes.push(`tea 探测失败（exit ${r.code}）：${firstLine(r.stderr) || "无输出"}`);
      continue;
    }
    const parsed = parseJson(r.stdout);
    if (!Array.isArray(parsed)) {
      notes.push("tea 成功但返回的不是 JSON 数组：跳过");
      continue;
    }
    const pr = teaPullToRef(pickTeaPull(parsed, ctx.branch), ctx.remote, ctx.branch);
    if (!pr) {
      // tea 正常回答但这条分支没有 PR —— 这是「确定没有」，不是「未探测」。
      notes.push(`tea：分支 ${ctx.branch} 没有对应的 PR（已探测，共 ${parsed.length} 条）`);
      return { pr: null, source: "tea", probed: true, notes };
    }
    return { pr, source: "tea", probed: true, notes };
  }

  notes.push("PR 未探测：没有可用的 gh/tea（未安装、未登录或远程不匹配）");
  return { pr: null, source: null, probed: false, notes };
}

// ---------------------------------------------------------------- 顶层组合

export type ProbeOptions = { run?: Run; repoPath?: string | null };

export type ProbeResult = {
  cwd: string;
  /** cwd 是否在 git 仓库里（否则其余字段全为空值）。 */
  ok: boolean;
  /** 只在 cwd 确实是 linked worktree 时非 null —— 主仓库不产出（设计 §3.1）。 */
  worktree: WorktreeRef | null;
  /** 判定细节：主仓库根、是否 worktree，用来给人话提示。 */
  verdict: WorktreeVerdict | null;
  signals: GitSignals;
  pr: PrRef | null;
  prSource: "gh" | "tea" | null;
  /** true = PR 探测有确定答案（含「确实没有 PR」）；false = 未探测（降级）。 */
  prProbed: boolean;
  notes: string[];
};

export async function probe(cwd: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const run = opts.run ?? defaultRun;
  let git = await probeGit(cwd, run);
  const notes: string[] = [];

  // 会话 cwd 不在仓库里时，退回卡片的 repoPath 兜底（探测分支/远程信号，但不把 repoPath 当 worktree）。
  if (!git.ok && opts.repoPath) {
    const viaRepo = await probeGit(opts.repoPath, run);
    if (viaRepo.ok) {
      notes.push(`cwd ${cwd} 不在 git 仓库内，改用卡片 repoPath ${opts.repoPath} 探测`);
      git = viaRepo;
    }
  }
  if (!git.ok) {
    return {
      cwd,
      ok: false,
      worktree: null,
      verdict: null,
      signals: git.signals,
      pr: null,
      prSource: null,
      prProbed: false,
      notes: [...notes, ...git.notes],
    };
  }

  notes.push(...git.notes);
  const verdict = git.verdict;
  const worktree = verdict?.bindable ?? null;
  if (verdict && !verdict.isWorktree) {
    notes.push(`cwd 是主仓库工作区 ${verdict.mainRoot}，不是 worktree：不绑定 worktree（请在 worktree 里工作）`);
  } else if (verdict?.detached) {
    notes.push(
      `worktree ${verdict.path} 处于 detached HEAD（没有分支）：**不回写 worktree**（避免把卡片上已有的分支覆盖成无效值）；` +
        `要绑卡请先在里面 \`git switch -c feat/<名字>\``,
    );
  } else if (verdict && !verdict.underWorktreesDir) {
    notes.push("worktree 不在 .worktrees/ 约定目录下：仍接受（推断 source=harness）");
  }

  const branch = git.signals.branch;
  let pr: PrRef | null = null;
  let prSource: "gh" | "tea" | null = null;
  let prProbed = false;
  if (branch) {
    const out = await probePr({ cwd: git.cwd, branch, remote: git.signals.remote }, run);
    pr = out.pr;
    prSource = out.source;
    prProbed = out.probed;
    notes.push(...out.notes);
  } else {
    notes.push("拿不到分支名（detached HEAD？）：跳过 PR 探测");
  }

  return {
    cwd,
    ok: true,
    worktree,
    verdict,
    signals: git.signals,
    pr,
    prSource,
    prProbed,
    notes,
  };
}

// ---------------------------------------------------------------- 回写计划（纯）

export type ProbeCommand =
  | { cmd: "worktree"; worktree: WorktreeRef }
  | { cmd: "bindPr"; pr: PrRef }
  | { cmd: "probePr"; pr: PrRef };

/** 卡片已有槽位：ProbeResult → 该发哪些写命令（幂等：与现状一致就不发）。 */
export function probeCommands(
  existing: { worktree: WorktreeRef | null; pr: PrRef | null },
  result: ProbeResult,
): ProbeCommand[] {
  const out: ProbeCommand[] = [];

  const w = result.worktree;
  if (w && (!existing.worktree || existing.worktree.path !== w.path || existing.worktree.branch !== w.branch)) {
    out.push({ cmd: "worktree", worktree: w });
  }

  const pr = result.pr;
  if (pr) {
    if (!existing.pr || existing.pr.number !== pr.number) {
      out.push({ cmd: "bindPr", pr });
    } else if (existing.pr.state !== pr.state || (existing.pr.ci ?? null) !== (pr.ci ?? null)) {
      // 已有同一 PR，只是状态/CI 变了：走 probePr（merged 会被引擎升级成 pr.merged）。
      out.push({ cmd: "probePr", pr });
    }
  }

  return out;
}
