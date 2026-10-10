/**
 * 「起会话」这一步的动作层：在用户桌面上开一个终端，在指定目录里把 agent 会话跑起来，
 * 并把**开工提示**（当前卡片状态 + 要做的事）注入系统提示。
 *
 * 为什么在服务端做：浏览器既不能开终端，也拿不到桌面环境；服务是 systemd --user 起的，
 * 图形变量要从用户级 systemd 借过来（`systemctl --user show-environment`，与 picker.ts 同一招）。
 *
 * **worktree 不由这里建**（用户定的：名字得 AI 按任务自己起）——建 worktree 是开工提示里的第一步。
 *
 * 分层与 probe.ts/picker.ts 一致：纯函数拼 argv，薄 IO 可注入，测试不依赖真终端。
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sessionGraphicalEnv } from "./picker.ts";

const run = promisify(execFile);

export type RunResult = { code: number; stdout: string; stderr: string; missing: boolean };
export type RunFn = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

/** 只用来探"哪个终端在"、"omp 在哪"这类一次性问题。 */
const defaultRun: RunFn = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await run(file, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 5000,
      maxBuffer: 1 << 20,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    const missing = e.code === "ENOENT";
    return {
      code: typeof e.code === "number" ? e.code : missing ? 127 : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (missing ? `${file}: 未安装` : String(error)),
      missing,
    };
  }
};

/** 取第一行非空文本（诊断信息只留一行）。 */
export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

export type TerminalSpec = { binary: string; argv: (opts: { cwd: string; command: string }) => string[] };

/**
 * 支持的终端（本机是 konsole，其余留作可移植性）。`-e` 后面的参数是**独立 argv**、
 * 不经过 shell，所以内层命令原样交给 `bash -lc` 就行。
 */
export const TERMINALS: TerminalSpec[] = [
  { binary: "konsole", argv: ({ cwd, command }) => ["--workdir", cwd, "-e", "bash", "-lc", command] },
  { binary: "ptyxis", argv: ({ cwd, command }) => ["--new-window", "--working-directory", cwd, "--", "bash", "-lc", command] },
  { binary: "kgx", argv: ({ cwd, command }) => ["--working-directory", cwd, "--", "bash", "-lc", command] },
  { binary: "gnome-terminal", argv: ({ cwd, command }) => [`--working-directory=${cwd}`, "--", "bash", "-lc", command] },
  { binary: "kitty", argv: ({ cwd, command }) => ["--directory", cwd, "bash", "-lc", command] },
  { binary: "alacritty", argv: ({ cwd, command }) => ["--working-directory", cwd, "-e", "bash", "-lc", command] },
  { binary: "wezterm", argv: ({ cwd, command }) => ["start", "--cwd", cwd, "--", "bash", "-lc", command] },
  { binary: "xterm", argv: ({ cwd, command }) => ["-e", "bash", "-lc", `cd ${shq(cwd)} && ${command}`] },
];

export async function resolveTerminal(opts: { run?: RunFn } = {}): Promise<TerminalSpec | undefined> {
  const override = process.env.FLOWCARD_TERMINAL;
  if (override) return TERMINALS.find((t) => t.binary === override) ?? {
    binary: override,
    argv: ({ cwd, command }) => ["--workdir", cwd, "-e", "bash", "-lc", command],
  };
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
 * 会话启动命令：绝对路径的 omp（不赌新终端的 PATH）+ 显式 `-e <上报扩展>` +
 * `--append-system-prompt "$(cat <brief 文件>)"`（用 shell 读文件传文本，绕开引号问题）。
 * omp 退出后 `exec bash -i` 把 tab 留在一个 shell 里，省得用户什么都没看清窗口就关了。
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
        "开工：先读系统提示里「接下来你要做的」，按顺序执行；每完成一步用 flowcard comment 留痕。",
    ),
  );
  return `${parts.join(" ")}; echo "[flowcard] 会话已退出（这个终端留着给你看现场）"; exec bash -i`;
}

/** 上报扩展的绝对路径：服务端自己知道装在哪（本仓 `src/adapters/omp/`）。 */
export function defaultAdapterPath(): string {
  return fileURLToPath(new URL("../adapters/omp/flowcard-omp-adapter.ts", import.meta.url));
}

/** 从 PATH 或常见位置找 omp 的绝对路径（找不到就交给新终端的 PATH）。 */
export async function resolveOmpPath(opts: { run?: RunFn } = {}): Promise<string | undefined> {
  const runner = opts.run ?? defaultRun;
  const probe = await runner("sh", ["-c", "command -v omp"], { timeoutMs: 2000 });
  const found = probe.code === 0 ? firstLine(probe.stdout) : "";
  if (found !== "") return found;
  const fallback = `${process.env.HOME ?? ""}/.bun/bin/omp`;
  return existsSync(fallback) ? fallback : undefined;
}

export type LaunchSessionResult =
  | { ok: true; terminal: string; command: string }
  | { ok: false; reason: "no-terminal" | "no-cwd" | "spawn-failed"; message: string };

/** 在用户桌面上开一个终端跑会话（detached，不阻塞服务）。 */
export async function launchSession(opts: {
  worktreePath: string;
  /** 适配器日志目录（给了就按卡片分文件写在那里，不再落到 /tmp） */
  logDir?: string;
  /** 卡片 id：塞进环境变量，适配器第一秒就能绑上卡片（不必等 worktree 建好、cwd 能对上） */
  cardId?: string;
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
    return { ok: false, reason: "no-cwd", message: `工作目录不存在：${opts.worktreePath}` };
  }

  const command = sessionCommand({
    ...(opts.harness ? { harness: opts.harness } : {}),
    ...(opts.ompPath ? { ompPath: opts.ompPath } : {}),
    ...(opts.adapterPath ? { adapterPath: opts.adapterPath } : {}),
    ...(opts.briefPath ? { briefPath: opts.briefPath } : {}),
    ...(opts.kickoff ? { kickoff: opts.kickoff } : {}),
  });
  const argv = terminal.argv({ cwd: opts.worktreePath, command });
  const flowcardEnv: Record<string, string> = opts.cardId
    ? {
        FLOWCARD_CARD: opts.cardId,
        FLOWCARD_URL: `http://${process.env.FLOWCARD_HOST ?? "127.0.0.1"}:${process.env.FLOWCARD_PORT ?? "47825"}`,
      }
    : {};
  // 适配器日志别都往 /tmp/omp-adapter.log 写（多卡互相覆盖，且 /tmp 是公开可读的）
  const logDir = opts.logDir;
  if (logDir && opts.cardId) flowcardEnv.FLOWCARD_OMP_LOG = `${logDir}/omp-${opts.cardId}.log`;
  const env = { ...process.env, ...flowcardEnv, ...(opts.env ?? (await sessionGraphicalEnv())) };
  const spawnFn = opts.spawnFn ?? spawn;

  try {
    const child = spawnFn(terminal.binary, argv, { detached: true, stdio: "ignore", env });
    child.unref?.();
    return { ok: true, terminal: terminal.binary, command };
  } catch (error) {
    return { ok: false, reason: "spawn-failed", message: `起终端失败：${String(error)}` };
  }
}
