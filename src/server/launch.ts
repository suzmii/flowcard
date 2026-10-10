/**
 * 「开工」这一步的两个真动作：**建 worktree** + **在桌面上把会话跑起来**。
 *
 * 为什么在服务端做：看板在浏览器里，浏览器既不能建 git worktree，也不能开终端
 * （跟"选目录要弹原生对话框"同一个道理）。所以由后台服务执行，并把图形环境从
 * 用户级 systemd 里借过来（`systemctl --user show-environment`，与 picker.ts 同一招）。
 *
 * 分层跟 probe.ts / picker.ts 一致：**纯函数拼 argv / 解析输出，薄 IO 可注入**，测试不依赖真终端。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { sessionGraphicalEnv } from "./picker.ts";

const run = promisify(execFile);

export type RunResult = { code: number; stdout: string; stderr: string; missing: boolean };
export type RunFn = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

const GIT_TIMEOUT_MS = 30_000;

const defaultRun: RunFn = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await run(file, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 4 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    const missing = e.code === "ENOENT";
    return {
      code: typeof e.code === "number" ? e.code : missing ? 127 : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (missing ? `${file}: 未安装` : String(error)),
      missing,
    };
  }
};

/** 一行诊断信息：git 的中文/英文报错都取第一行非空。 */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

export type WorktreePlan = { repoPath: string; path: string; branch: string; base?: string };

/** `git worktree add <path> -b <branch> [<base>]`（新分支）；分支已存在时退化成绑现有分支。 */
export function worktreeArgv(plan: WorktreePlan, opts: { useExistingBranch: boolean }): string[] {
  const argv = ["-C", plan.repoPath, "worktree", "add", plan.path];
  if (!opts.useExistingBranch) argv.push("-b", plan.branch);
  else argv.push(plan.branch);
  if (plan.base) argv.push(plan.base);
  return argv;
}

/** 分支已存在是**可恢复**的：换成"直接绑这个分支"，而不是失败。 */
export function looksLikeBranchExists(stderr: string): boolean {
  return /already exists|已经存在/i.test(stderr);
}

export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string; reusedBranch: boolean }
  | { ok: false; reason: "not-a-repo" | "path-exists" | "git-failed" | "git-missing"; message: string };

export async function createWorktree(
  plan: WorktreePlan,
  opts: { run?: RunFn } = {},
): Promise<CreateWorktreeResult> {
  const runner = opts.run ?? defaultRun;

  if (existsSync(plan.path)) {
    return { ok: false, reason: "path-exists", message: `${plan.path} 已经存在，先处理掉它或换个名字` };
  }
  // 仓库根要存在且是 git 仓库；父目录 git 会自己建，但 .worktrees 这种中间层先兜一下
  const repoCheck = await runner("git", ["-C", plan.repoPath, "rev-parse", "--git-dir"], { timeoutMs: 5000 });
  if (repoCheck.missing) {
    return { ok: false, reason: "git-missing", message: "找不到 git" };
  }
  if (repoCheck.code !== 0) {
    return {
      ok: false,
      reason: "not-a-repo",
      message: `${plan.repoPath} 不是 git 仓库：${firstLine(repoCheck.stderr)}`,
    };
  }
  await mkdir(dirname(plan.path), { recursive: true });

  for (const useExistingBranch of [false, true]) {
    const result = await runner("git", worktreeArgv(plan, { useExistingBranch }));
    if (result.code === 0) {
      return { ok: true, path: plan.path, branch: plan.branch, reusedBranch: useExistingBranch };
    }
    const canRetryWithExisting = !useExistingBranch && looksLikeBranchExists(result.stderr);
    if (!canRetryWithExisting) {
      return { ok: false, reason: "git-failed", message: firstLine(result.stderr) || `git 退出码 ${result.code}` };
    }
  }
  return { ok: false, reason: "git-failed", message: "git worktree add 失败（分支可能已被别的 worktree 占用）" };
}

// ------------------------------------------------------------------ 起会话

export type TerminalSpec = { binary: string; argv: (opts: { cwd: string; command: string }) => string[] };

/**
 * 支持的终端（本机只有 konsole，其余留作可移植性）。`-e` 后面的参数是**独立 argv**，
 * 不经过 shell，所以内层命令原样交给 `bash -lc` 就行，不用自己拼引号。
 */
export const TERMINALS: TerminalSpec[] = [
  { binary: "konsole", argv: ({ cwd, command }) => ["--workdir", cwd, "-e", "bash", "-lc", command] },
  { binary: "ptyxis", argv: ({ cwd, command }) => ["--new-window", "--working-directory", cwd, "--", "bash", "-lc", command] },
  { binary: "kgx", argv: ({ cwd, command }) => ["--working-directory", cwd, "--", "bash", "-lc", command] },
  { binary: "gnome-terminal", argv: ({ cwd, command }) => [`--working-directory=${cwd}`, "--", "bash", "-lc", command] },
  { binary: "kitty", argv: ({ cwd, command }) => ["--directory", cwd, "bash", "-lc", command] },
  { binary: "alacritty", argv: ({ cwd, command }) => ["--working-directory", cwd, "-e", "bash", "-lc", command] },
  { binary: "wezterm", argv: ({ cwd, command }) => ["start", "--cwd", cwd, "--", "bash", "-lc", command] },
  { binary: "xterm", argv: ({ cwd, command }) => ["-e", "bash", "-lc", `cd ${cwd} && ${command}`] },
];

export async function resolveTerminal(opts: { run?: RunFn } = {}): Promise<TerminalSpec | undefined> {
  const override = process.env.FLOWCARD_TERMINAL;
  if (override) {
    const found = TERMINALS.find((t) => t.binary === override);
    return found ?? { binary: override, argv: TERMINALS[0]!.argv };
  }
  const runner = opts.run ?? defaultRun;
  for (const candidate of TERMINALS) {
    const probe = await runner("sh", ["-c", `command -v ${candidate.binary}`], { timeoutMs: 2000 });
    if (probe.code === 0 && !probe.missing) return candidate;
  }
  return undefined;
}

/** POSIX 单引号转义：内层命令是整串交给 `bash -lc` 的，路径必须自己护住。 */
export function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * 会话启动命令：优先绝对路径的 omp（不依赖新终端里的 PATH），显式带上上报扩展，
 * 并把**开工提示**（当前卡片状态 + 要做的事）通过 `--append-system-prompt` 注入
 * （用 `$(cat <file>)` 传文本，绕开引号问题）。
 * omp 退出后把 tab 留在一个 shell 里：省得用户什么都没看清窗口就关了。
 */
export function sessionCommand(opts: {
  harness?: string;
  ompPath?: string;
  adapterPath?: string;
  briefPath?: string;
  kickoff?: string;
}): string {
  const binary = opts.ompPath ?? opts.harness ?? "omp";
  const parts = [shq(binary)];
  if (opts.adapterPath) parts.push("-e", shq(opts.adapterPath));
  if (opts.briefPath) parts.push("--append-system-prompt", `"$(cat ${shq(opts.briefPath)})"`);
  parts.push(
    shq(
      opts.kickoff ??
        '开工：先读系统提示里「接下来你要做的」，按顺序执行；每完成一步用 flowcard comment 留痕。',
    ),
  );
  return `${parts.join(" ")}; echo "[flowcard] 会话已退出（这个终端留着给你看现场）"; exec bash -i`;
}

export type LaunchSessionResult =
  | { ok: true; terminal: string; command: string }
  | { ok: false; reason: "no-terminal" | "spawn-failed"; message: string };

/** 在用户桌面上开一个终端，在 worktree 里跑会话（detached，不阻塞服务）。 */
export async function launchSession(opts: {
  worktreePath: string;
  harness?: string;
  ompPath?: string;
  adapterPath?: string;
  briefPath?: string;
  kickoff?: string;
  run?: RunFn;
  spawnFn?: typeof spawn;
  env?: Record<string, string>;
}): Promise<LaunchSessionResult> {
  const terminal = await resolveTerminal({ ...(opts.run ? { run: opts.run } : {}) });
  if (!terminal) {
    return {
      ok: false,
      reason: "no-terminal",
      message: "没找到可用的终端（装 konsole，或用 FLOWCARD_TERMINAL 指定）",
    };
  }
  if (!existsSync(opts.worktreePath)) {
    return { ok: false, reason: "spawn-failed", message: `worktree 不存在：${opts.worktreePath}` };
  }

  const command = sessionCommand({
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.ompPath ? { ompPath: opts.ompPath } : {}),
    ...(opts.adapterPath ? { adapterPath: opts.adapterPath } : {}),
    ...(opts.briefPath ? { briefPath: opts.briefPath } : {}),
    ...(opts.kickoff ? { kickoff: opts.kickoff } : {}),
  });
  const argv = terminal.argv({ cwd: opts.worktreePath, command });
  const env = { ...process.env, ...(opts.env ?? (await sessionGraphicalEnv())) };
  const spawnFn = opts.spawnFn ?? spawn;

  try {
    const child = spawnFn(terminal.binary, argv, { detached: true, stdio: "ignore", env });
    child.unref?.();
    return { ok: true, terminal: terminal.binary, command };
  } catch (error) {
    return { ok: false, reason: "spawn-failed", message: `起终端失败：${String(error)}` };
  }
}

/** 上报扩展的绝对路径：服务端自己知道装在哪（本仓 `src/adapters/omp/`）。 */
export function defaultAdapterPath(): string {
  return fileURLToPath(new URL("../adapters/omp/flowcard-omp-adapter.ts", import.meta.url));
}

/** 从 PATH 或常见位置找 omp 的绝对路径（找不到就返回 undefined，交给 shell 的 PATH）。 */
export async function resolveOmpPath(opts: { run?: RunFn } = {}): Promise<string | undefined> {
  const runner = opts.run ?? defaultRun;
  const probe = await runner("sh", ["-c", "command -v omp"], { timeoutMs: 2000 });
  const found = probe.code === 0 ? firstLine(probe.stdout) : "";
  if (found !== "") return found;
  const fallback = `${process.env.HOME ?? ""}/.bun/bin/omp`;
  return existsSync(fallback) ? fallback : undefined;
}
