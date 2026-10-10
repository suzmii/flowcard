/**
 * 运行时监督器：卡片「启动按钮」的适配层（也是唯一碰进程的地方）。
 *
 * 职责边界：
 *   - 引擎（engine.ts）是纯函数：`runtime` 命令只把状态写成事件（runtime.starting/started/failed/stopped）；
 *   - spawn / kill / 日志重定向只在这里；
 *   - 状态一律经 store.execute 落事件 → `cards` 是投影 → rebuild 之后按钮状态不会漂。
 *
 * 安全边界（硬要求，别越线）：
 *   - 只对自己启动的进程组下手。spawn 时 `detached: true` 自建进程组（pgid == 子进程 pid），
 *     停止只发 `process.kill(-pgid, SIGTERM)`，宽限期后 `SIGKILL`。
 *   - **绝不**用 pkill / pgrep / 模式匹配去杀进程；不是自己启动的东西一律不碰。
 *   - 重启/退出时清理自己留下的残留进程：pid/pgid/启动时刻从事件流重建，且要先核对
 *     `/proc/<pgid>` 的启动时刻（或 session 归属）确认「这确实是我们起的那一组」才动手。
 *   - 恢复不了/对不上的组只「收尸」（把卡片状态标成 stopped），不杀。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
  findRepoConfig,
  resolveRuntimeConfig,
  RuntimeConfigError,
  type ReadySpec,
  type RuntimeConfig,
} from "../shared/runtime-config.ts";
import type {
  Actor,
  Command,
  EventType,
  Runtime,
  RuntimeAction,
  RuntimeStatus,
} from "../shared/types.ts";
import type { Store } from "./store.ts";

export type RuntimeErrorCode =
  | "NOT_FOUND"
  | "NO_PROJECT"
  | "NO_CONFIG"
  | "BAD_CONFIG"
  | "SPAWN_FAILED"
  | "READY_TIMEOUT"
  | "EXITED";

export type RuntimeFailure = { code: RuntimeErrorCode; message: string; hint?: string };

export type RuntimeActionResult = {
  ok: boolean;
  action: RuntimeAction;
  cardId: string;
  runtime: Runtime | null;
  /** 这次启动顺手停掉的其他卡片 id（单例不变式） */
  killed: string[];
  warnings: string[];
  error?: RuntimeFailure;
  /** 停止时实际用到的信号，排障/测试用 */
  signal?: "SIGTERM" | "SIGKILL";
};

export type RuntimeChange = { cardId: string; status: RuntimeStatus; types: EventType[] };

export type RuntimeSupervisor = {
  up(cardId: string): Promise<RuntimeActionResult>;
  down(cardId: string, reason?: string): Promise<RuntimeActionResult>;
  /** 服务退出：停掉所有在跑的（自己起的）运行时，返回被停的卡片 id */
  shutdown(): Promise<string[]>;
  /** 退出钩子里的同步兜底：直接 SIGKILL 自己的进程组 */
  shutdownSync(): void;
  /** 启动时清理上一轮残留（从事件流重建 pid/pgid），返回被清理的卡片 id */
  reapStale(): Promise<string[]>;
  /** 观察状态变化（SSE 广播用），返回退订函数 */
  subscribe(listener: (change: RuntimeChange) => void): () => void;
  /** 当前自己管着的进程组（排障/测试用） */
  active(): { cardId: string; pid: number; pgid: number; cmd: string }[];
  /** 等所有进行中的启停收尾（测试用） */
  settle(): Promise<void>;
};

export type RuntimeSupervisorOptions = {
  store: Store;
  dataDir: string;
  configDir?: string;
  /** SIGTERM → SIGKILL 的宽限期，默认 5000ms */
  graceMs?: number;
  /** 就绪轮询间隔，默认 100ms */
  pollMs?: number;
  /** 没配 ready 时：spawn 后多久没退出就算 running，默认 500ms */
  settleMs?: number;
};

const SYSTEM: Actor = { kind: "system" };
const SIGKILL_WAIT_MS = 2000;

const STATUS_BY_TO: Record<"starting" | "running" | "failed" | "stopped", RuntimeStatus> = {
  starting: "starting",
  running: "running",
  failed: "failed",
  stopped: "stopped",
};

// tsconfig 的 lib 是 ES2023（Promise.withResolvers 要 ES2024），这里只能用 executor 形式。
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type ProcInfo = { pid: number; pgrp: number; sid: number; start: string };

/** /proc/<pid>/stat：state/ppid/pgrp/session… 的字段位置固定，starttime 是第 22 个。 */
function readProc(pid: number): ProcInfo | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const f = stat.slice(close + 2).trim().split(/\s+/);
  return { pid, pgrp: Number(f[2]), sid: Number(f[3]), start: f[19] ?? "" };
}

function readGroup(pgid: number): ProcInfo[] {
  const out: ProcInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const info = readProc(Number(entry));
    if (info && info.pgrp === pgid) out.push(info);
  }
  return out;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function logMatches(logPath: string, pattern: string, from: number): boolean {
  try {
    // 只看这次启动之后写的字节：否则重启时会被上一轮的 "ready" 行直接骗过去。
    const text = readFileSync(logPath).subarray(from).toString("utf8");
    return new RegExp(pattern, "m").test(text);
  } catch {
    return false;
  }
}

/** 事件重建出来的目标（重启后残留进程只留下这些）。 */
type StopTarget = {
  pid: number;
  pgid: number;
  startedAt: string;
  procStart?: string;
  logPath?: string;
  ports?: number[];
};

type Active = StopTarget & {
  cardId: string;
  child: ChildProcess;
  cmd: string;
  /** 这次启动的日志起点（字节），ready.log 只匹配这之后的输出 */
  logStart: number;
  stoppedByUs: boolean;
  /** 已经 emitted started；在此之前退出算「启动失败」，由 up 自己处理 */
  ready: boolean;
  /** 已经写过终态事件（failed/stopped），防止 exit 监听重复写 */
  reported: boolean;
  exit: { code: number | null; signal: string | null } | null;
};

export function createRuntimeSupervisor(opts: RuntimeSupervisorOptions): RuntimeSupervisor {
  const graceMs = opts.graceMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const settleMs = opts.settleMs ?? 500;
  const logDir = join(opts.dataDir, "logs");
  mkdirSync(logDir, { recursive: true });

  const active = new Map<string, Active>();
  const listeners = new Set<(change: RuntimeChange) => void>();

  // 所有启停都串行：单例不变式（先停别人再起自己）不允许两条 up 交叉。
  let queue: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const notify = (cardId: string, status: RuntimeStatus, types: EventType[]): void => {
    for (const listener of listeners) listener({ cardId, status, types });
  };

  /** 状态变化只走这一条路：写成 runtime.* 事件，投影交给 project.ts。 */
  const emit = (
    cardId: string,
    input: {
      to: "starting" | "running" | "failed" | "stopped";
      pid?: number | undefined;
      pgid?: number | undefined;
      exitCode?: number | undefined;
      signal?: string | undefined;
      reason?: string | undefined;
      error?: string | undefined;
      startedAt?: string | undefined;
      ports?: number[] | undefined;
      logPath?: string | undefined;
      procStart?: string | undefined;
    },
  ): void => {
    const cmd: Command = {
      cmd: "runtime",
      actor: SYSTEM,
      card: cardId,
      to: input.to,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.pgid !== undefined ? { pgid: input.pgid } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.ports !== undefined ? { ports: input.ports } : {}),
      ...(input.logPath !== undefined ? { logPath: input.logPath } : {}),
      ...(input.procStart !== undefined ? { procStart: input.procStart } : {}),
    };
    const result = opts.store.execute(cmd);
    if (result.inserted.length > 0) {
      notify(cardId, STATUS_BY_TO[input.to], result.inserted.map((e) => e.type));
    }
  };

  const cardRuntime = (cardId: string): Runtime | null =>
    opts.store.getCard(cardId)?.runtime ?? null;

  const failure = (
    action: RuntimeAction,
    cardId: string,
    code: RuntimeErrorCode,
    message: string,
    extra?: { hint?: string | undefined; killed?: string[]; warnings?: string[] },
  ): RuntimeActionResult => ({
    ok: false,
    action,
    cardId,
    runtime: cardRuntime(cardId),
    killed: extra?.killed ?? [],
    warnings: extra?.warnings ?? [],
    error: { code, message, ...(extra?.hint ? { hint: extra.hint } : {}) },
  });

  const waitGroupGone = async (pgid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    if (!groupAlive(pgid)) return true;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (!groupAlive(pgid)) return true;
    }
    return !groupAlive(pgid);
  };

  /**
   * 只对我们记下的 pgid 下手。返回实际用到的信号（或 null = 没杀，只是收尸）。
   */
  const killGroup = async (
    target: StopTarget,
    verify: boolean,
  ): Promise<{ signal: "SIGTERM" | "SIGKILL" | null; note?: string }> => {
    if (verify) {
      const members = readGroup(target.pgid);
      if (members.length === 0) return { signal: null, note: "进程组已不存在" };
      const leader = members.find((m) => m.pid === target.pgid);
      if (leader) {
        if (target.procStart && leader.start !== target.procStart) {
          return { signal: null, note: "pid 已被复用（启动时刻对不上），不杀" };
        }
        if (leader.sid !== target.pgid) {
          return { signal: null, note: "进程组归属对不上（session 不是这个组），不杀" };
        }
      } else if (!members.some((m) => m.sid === target.pgid)) {
        return { signal: null, note: "只剩来路不明的进程，不杀" };
      }
    }

    try {
      process.kill(-target.pgid, "SIGTERM");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { signal: null, note: "进程组已不存在" };
      return { signal: null, note: `SIGTERM 失败：${String(error)}` };
    }
    if (await waitGroupGone(target.pgid, graceMs)) return { signal: "SIGTERM" };

    try {
      process.kill(-target.pgid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return { signal: "SIGKILL" };
      return { signal: "SIGTERM", note: `SIGKILL 失败：${String(error)}` };
    }
    if (!(await waitGroupGone(target.pgid, SIGKILL_WAIT_MS))) {
      return { signal: "SIGKILL", note: "SIGKILL 后进程组还在（可能在 D 状态）" };
    }
    return { signal: "SIGKILL" };
  };

  /** 从事件流重建某个卡片最后一次运行的进程身份（重启后的唯一线索）。 */
  const targetFromEvents = (cardId: string): StopTarget | null => {
    const events = opts.store
      .listEvents(1000)
      .filter((e) => e.cardId === cardId && e.type.startsWith("runtime."));
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "runtime.stopped") return null;
      if (ev.type === "runtime.started" || ev.type === "runtime.starting") {
        const p = ev.payload;
        const pgid = typeof p.pgid === "number" ? p.pgid : typeof p.pid === "number" ? p.pid : null;
        if (pgid === null) return null;
        return {
          pid: typeof p.pid === "number" ? p.pid : pgid,
          pgid,
          startedAt: typeof p.startedAt === "string" ? p.startedAt : ev.at,
          ...(typeof p.procStart === "string" ? { procStart: p.procStart } : {}),
          ...(typeof p.logPath === "string" ? { logPath: p.logPath } : {}),
          ...(Array.isArray(p.ports) ? { ports: p.ports as number[] } : {}),
        };
      }
    }
    return null;
  };

  /** 停掉一张卡的运行时。进程不在了也把状态收成 stopped（只收尸，不碰别的进程）。 */
  const stopRun = async (
    cardId: string,
    reason: string,
  ): Promise<{ stopped: boolean; signal: "SIGTERM" | "SIGKILL" | null; note?: string }> => {
    const run = active.get(cardId);
    const target: StopTarget | null = run ?? targetFromEvents(cardId);
    if (!target) return { stopped: false, signal: null };

    if (run) run.stoppedByUs = true;
    const outcome = await killGroup(target, !run);
    active.delete(cardId);

    const exit = run?.exit ?? null;
    emit(cardId, {
      to: "stopped",
      pid: target.pid,
      pgid: target.pgid,
      startedAt: target.startedAt,
      reason,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      ...(exit?.code !== null && exit?.code !== undefined ? { exitCode: exit.code } : {}),
      ...(target.logPath !== undefined ? { logPath: target.logPath } : {}),
      ...(target.ports !== undefined ? { ports: target.ports } : {}),
    });
    if (run) run.reported = true;
    return { stopped: true, signal: outcome.signal, ...(outcome.note ? { note: outcome.note } : {}) };
  };

  /** 就绪判定：端口探活 / 日志正则 / 进程存活；以及「启动即退出」的失败路径。 */
  const waitReady = async (
    run: Active,
    ready: ReadySpec,
    targets: number[],
  ): Promise<{ ok: true } | { ok: false; error: RuntimeFailure }> => {
    const deadline = Date.now() + ready.timeoutMs;
    const aliveUntil = Date.now() + settleMs;
    for (;;) {
      if (run.exit) {
        const detail =
          run.exit.code !== null ? `退出码 ${run.exit.code}` : `被信号 ${run.exit.signal} 终止`;
        return {
          ok: false,
          error: {
            code: "EXITED",
            message: `启动失败：进程起了但立刻退出（${detail}）`,
            hint: `看日志：${run.logPath ?? logDir}`,
          },
        };
      }
      if (ready.kind === "port") {
        if (await portInUse(ready.port)) return { ok: true };
      } else if (ready.kind === "log") {
        if (run.logPath && logMatches(run.logPath, ready.pattern, run.logStart)) return { ok: true };
      } else if (Date.now() >= aliveUntil || ready.skipSettle) {
        return { ok: true };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          error: {
            code: "READY_TIMEOUT",
            message:
              ready.kind === "port"
                ? `启动超时：${ready.timeoutMs}ms 内端口 ${ready.port} 一直没通`
                : ready.kind === "log"
                  ? `启动超时：${ready.timeoutMs}ms 内日志里没等到 /${ready.pattern}/`
                  : `启动超时：${ready.timeoutMs}ms 内没就绪`,
            hint: `看日志：${run.logPath ?? logDir}${targets.length > 0 ? `；端口：${targets.join(", ")}` : ""}`,
          },
        };
      }
      await sleep(pollMs);
    }
  };

  const doUp = async (cardId: string): Promise<RuntimeActionResult> => {
    const card = opts.store.getCard(cardId);
    if (!card) {
      return failure("up", cardId, "NOT_FOUND", `卡片 ${cardId} 不存在`);
    }

    const running = active.get(cardId);
    if (running && !running.exit) {
      return {
        ok: true,
        action: "up",
        cardId,
        runtime: cardRuntime(cardId),
        killed: [],
        warnings: [`卡片 ${cardId} 的运行时已经在跑（pid ${running.pid}）`],
      };
    }

    const warnings: string[] = [];
    const root = card.worktree?.path ?? card.repoPath;
    if (!root) {
      return failure(
        "up",
        cardId,
        "NO_PROJECT",
        `卡片 ${cardId} 还没绑定 worktree，不知道要启动哪个项目`,
        { hint: `先绑定：flowcard worktree ${cardId} --path <worktree> --branch <branch>` },
      );
    }

    let config: RuntimeConfig;
    try {
      config = resolveRuntimeConfig({
        root,
        ...(opts.configDir ? { configDir: opts.configDir } : {}),
      });
    } catch (error) {
      const known = error instanceof RuntimeConfigError ? error : null;
      emit(cardId, { to: "failed", error: String(error instanceof Error ? error.message : error) });
      const searched = known?.searched ?? [];
      const parts = [known?.hint, searched.length > 0 ? `找过：${searched.join("、")}` : undefined];
      const hint = parts.filter((p): p is string => p !== undefined).join("；");
      return failure("up", cardId, known?.code ?? "BAD_CONFIG", known?.message ?? String(error), {
        ...(hint ? { hint } : {}),
        warnings,
      });
    }

    if (card.runtime?.status === "running" || card.runtime?.status === "starting") {
      warnings.push(`卡片状态显示 ${card.runtime.status}，但进程已不在；重新启动`);
    }

    // 单例不变式：先把别的卡片正在跑的运行时停掉。
    const killed: string[] = [];
    if (config.singleton !== false) {
      const others = opts.store
        .listCards()
        .filter(
          (c) =>
            c.id !== cardId &&
            (c.runtime?.status === "running" || c.runtime?.status === "starting"),
        );
      for (const other of others) {
        if (config.singleton === "project") {
          const otherRoot = other.worktree?.path ?? other.repoPath;
          if (!otherRoot) continue;
          let same = false;
          try {
            same = findRepoConfig(otherRoot).projectRoot === config.projectRoot;
          } catch {
            same = false;
          }
          if (!same) continue;
        }
        const stopped = await stopRun(other.id, `singleton:${cardId}`);
        if (stopped.stopped) {
          killed.push(other.id);
          if (stopped.note) warnings.push(`停 ${other.id}：${stopped.note}`);
        }
      }
    }

    for (const port of config.ports) {
      if (await portInUse(port)) {
        warnings.push(`端口 ${port} 已被占用（可能是别的进程，不是 flowcard 起的，不会去杀它）`);
      }
    }

    const logPath = join(logDir, `${cardId}.log`);
    const startedAt = new Date().toISOString();
    const cwd = config.cwd ?? config.root;
    let fd: number;
    let logStart: number;
    try {
      fd = openSync(logPath, "a");
      logStart = fstatSync(fd).size;
      writeSync(fd, `\n[flowcard] runtime start ${startedAt} cmd=${config.cmd}\n`);
    } catch (error) {
      emit(cardId, { to: "failed", error: `打不开日志文件 ${logPath}：${String(error)}`, startedAt });
      return failure("up", cardId, "SPAWN_FAILED", `打不开日志文件 ${logPath}：${String(error)}`);
    }

    let child: ChildProcess;
    try {
      child = spawn("/bin/sh", ["-c", config.cmd], {
        cwd,
        env: { ...process.env, ...config.env },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } catch (error) {
      closeSync(fd);
      emit(cardId, {
        to: "failed",
        error: `spawn 失败：${String(error)}`,
        startedAt,
        logPath,
        ports: config.ports,
      });
      return failure("up", cardId, "SPAWN_FAILED", `spawn 失败：${String(error)}`, {
        hint: `检查 [runtime] cmd 与 cwd（${cwd}）`,
        killed,
        warnings,
      });
    }

    const spawned = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
      child.once("spawn", () => resolve({ ok: true }));
      child.once("error", (error) => resolve({ ok: false, message: String(error) }));
    });
    closeSync(fd);

    if (!spawned.ok) {
      emit(cardId, {
        to: "failed",
        error: `spawn 失败：${spawned.message}`,
        startedAt,
        logPath,
        ports: config.ports,
      });
      return failure("up", cardId, "SPAWN_FAILED", `spawn 失败：${spawned.message}`, {
        hint: `检查 [runtime] cmd 与 cwd（${cwd}）`,
        killed,
        warnings,
      });
    }

    const pid = child.pid!;
    const pgid = pid; // detached: true → 子进程自成 session/进程组，pgid == pid
    const procStart = readProc(pid)?.start;
    const run: Active = {
      cardId,
      pid,
      pgid,
      startedAt,
      logPath,
      ports: config.ports,
      ...(procStart ? { procStart } : {}),
      child,
      cmd: config.cmd,
      logStart,
      stoppedByUs: false,
      ready: false,
      reported: false,
      exit: null,
    };
    active.set(cardId, run);

    emit(cardId, {
      to: "starting",
      pid,
      pgid,
      startedAt,
      ports: config.ports,
      logPath,
      ...(procStart ? { procStart } : {}),
    });

    child.on("exit", (code, signal) => {
      run.exit = { code, signal };
      if (run.stoppedByUs || run.reported || !run.ready) return;
      run.reported = true;
      if (active.get(cardId) === run) active.delete(cardId);
      void withLock(async () => {
        emit(cardId, {
          to: "failed",
          pid: run.pid,
          pgid: run.pgid,
          startedAt: run.startedAt,
          logPath: run.logPath,
          ports: run.ports,
          error: `进程自己退出了（code=${code}, signal=${signal}）`,
          ...(code !== null ? { exitCode: code } : {}),
          ...(signal !== null ? { signal } : {}),
        });
      });
    });

    const outcome = await waitReady(run, config.ready, config.ports);
    if (!outcome.ok) {
      const killedGroup = await killGroup(run, false);
      run.stoppedByUs = true;
      run.reported = true;
      active.delete(cardId);
      emit(cardId, {
        to: "failed",
        pid,
        pgid,
        startedAt,
        logPath,
        ports: config.ports,
        error: outcome.error.message,
        ...(run.exit?.code !== null && run.exit?.code !== undefined ? { exitCode: run.exit.code } : {}),
        ...(run.exit?.signal ? { signal: run.exit.signal } : {}),
      });
      if (killedGroup.note) warnings.push(killedGroup.note);
      return failure("up", cardId, outcome.error.code, outcome.error.message, {
        ...(outcome.error.hint ? { hint: outcome.error.hint } : {}),
        killed,
        warnings,
      });
    }

    run.ready = true;
    emit(cardId, {
      to: "running",
      pid,
      pgid,
      startedAt,
      ports: config.ports,
      logPath,
      ...(procStart ? { procStart } : {}),
    });

    return {
      ok: true,
      action: "up",
      cardId,
      runtime: cardRuntime(cardId),
      killed,
      warnings,
    };
  };

  const doDown = async (cardId: string, reason = "down"): Promise<RuntimeActionResult> => {
    const card = opts.store.getCard(cardId);
    if (!card) return failure("down", cardId, "NOT_FOUND", `卡片 ${cardId} 不存在`);

    const stopped = await stopRun(cardId, reason);
    if (!stopped.stopped) {
      return {
        ok: true,
        action: "down",
        cardId,
        runtime: cardRuntime(cardId),
        killed: [],
        warnings: [`卡片 ${cardId} 的运行时没有在跑，什么也没做`],
      };
    }
    return {
      ok: true,
      action: "down",
      cardId,
      runtime: cardRuntime(cardId),
      killed: [],
      warnings: stopped.note ? [stopped.note] : [],
      ...(stopped.signal ? { signal: stopped.signal } : {}),
    };
  };

  return {
    up: (cardId) => withLock(() => doUp(cardId)),
    down: (cardId, reason) => withLock(() => doDown(cardId, reason)),

    shutdown() {
      return withLock(async () => {
        const ids = new Set<string>();
        for (const cardId of active.keys()) ids.add(cardId);
        for (const card of opts.store.listCards()) {
          if (card.runtime?.status === "running" || card.runtime?.status === "starting") {
            ids.add(card.id);
          }
        }
        const stopped: string[] = [];
        for (const cardId of ids) {
          const outcome = await stopRun(cardId, "shutdown");
          if (outcome.stopped) stopped.push(cardId);
        }
        return stopped;
      });
    },

    shutdownSync() {
      for (const [, run] of active) {
        try {
          process.kill(-run.pgid, "SIGKILL");
        } catch {
          // 已经死了就算了
        }
      }
    },

    reapStale() {
      return withLock(async () => {
        const reaped: string[] = [];
        for (const card of opts.store.listCards()) {
          const status = card.runtime?.status;
          if (status !== "running" && status !== "starting") continue;
          const outcome = await stopRun(card.id, "reap:stale");
          if (outcome.stopped) reaped.push(card.id);
        }
        return reaped;
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    active: () =>
      [...active.values()].map((run) => ({
        cardId: run.cardId,
        pid: run.pid,
        pgid: run.pgid,
        cmd: run.cmd,
      })),

    settle: () => withLock(async () => undefined),
  };
}
