/**
 * flowcard ⇄ omp 适配器：把会话生命周期上报给 flowcard。
 *
 * 加载（不需要 manifest、不需要 omp install）：
 *   omp -e /path/to/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
 *
 * 环境变量：
 *   FLOWCARD_URL          默认 http://127.0.0.1:47825
 *   FLOWCARD_CARD         卡片 id，**可选**：不给就由服务端按会话 cwd 反查是哪张卡片的 worktree
 *   FLOWCARD_HEARTBEAT_MS 心跳间隔，默认 15000
 *   FLOWCARD_OMP_LOG      日志文件，默认 /tmp/omp-adapter.log
 *
 * M6 起绑定是自动的：只要会话的工作目录落在某张卡片的 worktree 里，claim 不带 card 也能绑上
 * （服务端在全部卡片里按路径段比较找，最具体的 worktree 赢）。FLOWCARD_CARD 只作显式覆盖。
 *
 * M0 实测出来的坑（改动前先看 README）：
 *   - 事件体是空的，身份只能从 handler 第二参数 ctx 取；
 *   - 定时器必须用 ctx.setInterval：裸 setInterval 抛错会变成 uncaughtException 拆掉会话；
 *   - session_shutdown 只有 2s 预算 → fetch 超时压到 1.5s；
 *   - 端点不可达只写日志，绝不能影响会话。
 */
import { appendFileSync } from "node:fs";

const BASE = (process.env.FLOWCARD_URL ?? "http://127.0.0.1:47825").replace(/\/+$/, "");
const CARD = process.env.FLOWCARD_CARD ?? "";
const HEARTBEAT_MS = Number(process.env.FLOWCARD_OMP_HEARTBEAT_MS ?? 15_000);
const LOG_PATH =
  process.env.FLOWCARD_OMP_LOG ??
  `${process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? "/tmp"}/.local/state`}/flowcard/omp-adapter.log`;
const POST_TIMEOUT_MS = 1_500;

interface OmpSessionManager {
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
  getCwd?: () => string | undefined;
}

interface OmpAgentIdentity {
  kind?: string;
  id?: string;
  name?: string;
}

interface OmpContext {
  cwd?: string;
  agent?: OmpAgentIdentity;
  sessionManager?: OmpSessionManager;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface OmpExtensionApi {
  on: (event: string, handler: (payload: unknown, ctx: OmpContext) => void) => void;
}

function log(line: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    /* 日志失败必须静默 */
  }
}

/** 每次调用都拿到**当下**的 cwd（`/move`、`/wt` 之后会变）。 */
function readCwd(ctx: OmpContext): string {
  return ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd();
}

function identity(ctx: OmpContext): { id: string; cwd: string; kind: string; file?: string } | undefined {
  const id = ctx.sessionManager?.getSessionId?.();
  if (!id) return undefined;
  const file = ctx.sessionManager?.getSessionFile?.();
  return {
    id,
    cwd: ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? process.cwd(),
    kind: ctx.agent?.kind ?? "main",
    ...(file ? { file } : {}),
  };
}

/**
 * POST 一条命令。返回解析后的响应体（拿不到就是 undefined）。
 * `quiet` 用于"失败会重试"的调用（如按 cwd 解析 claim）：重试不打日志，只有第一次结果由调用方自己记，
 * 否则每 15s 心跳刷一行日志。
 */
async function post(
  command: Record<string, unknown>,
  label: string,
  quiet = false,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${BASE}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!quiet) log(`${label} -> ${res.status} ${text.slice(0, 400)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } catch (error) {
    // 服务没起、超时、网络断：只记录，绝不抛
    if (!quiet) log(`${label} !! ${String(error)}`);
    return undefined;
  }
}

type ClaimResponse = {
  ok?: boolean;
  card?: { id?: string };
  rejection?: { code?: string; message?: string; hint?: string };
  /** 命令结果里的事件计数：心跳"没被记下"（未知会话 / 卡片还没有会话）时都是 0。 */
  inserted?: number;
  duplicates?: number;
  notes?: unknown;
};

/**
 * 心跳真的被服务端记下了吗？
 * 卡片还没有会话 → `NOT_FOUND`；卡片绑的是别的会话 → `ok:true` 但**什么都没记**（inserted/duplicates 都是 0，
 * 只在 notes 里写一句"忽略未知会话"）。两种都算"这次心跳没生效"，调用方要退回 claim 重试。
 */
function beatApplied(res: ClaimResponse | undefined): boolean {
  if (res?.ok !== true) return false;
  const known = typeof res.inserted === "number" || typeof res.duplicates === "number";
  // 服务端没给计数（别的版本）时不臆断失败，免得每 15s 白重试一次。
  if (!known) return true;
  return (res.inserted ?? 0) + (res.duplicates ?? 0) > 0;
}

export default function flowcardOmpAdapter(pi: OmpExtensionApi): void {
  let handle: unknown;
  let current: { id: string; cwd: string; kind: string; file?: string } | undefined;
  /** 卡片 id：FLOWCARD_CARD 显式给的，或 claim 时服务端按 cwd 解析出来的 */
  let bound = CARD;
  /**
   * **claim 成功了没有**——这是独立标志，不能复用 `bound`：开工链路**总是**带 `FLOWCARD_CARD`，
   * `bound` 一上来就是真值；用它当"已绑"会让首个 claim 失败后再也不重试（服务重启 / 超时 /
   * SESSION_CONFLICT：上一个会话的 `end` 没送达），卡片永远停在「实施中」，心跳要么 NOT_FOUND、
   * 要么被服务端静默忽略。没 claim 上就下一拍继续 claim，直到服务端认下这次会话。
   */
  let claimed = false;
  /** 「解析失败」只记一次日志：心跳会重试，不能每 15s 刷屏 */
  let resolveFailedLogged = false;
  /** 「claim 没成功」同理只记一次 */
  let claimFailedLogged = false;

  pi.on("session_start", (_payload, ctx) => {
    current = identity(ctx);
    if (!current) {
      log("session_start: 拿不到会话身份，跳过");
      return;
    }
    if (current.kind !== "main") {
      log(`session_start: ${current.kind} 会话（subagent）不绑卡片，跳过 ${current.id}`);
      return;
    }
    // 本次会话的身份快照：心跳/结束都只认它（RPC 里 new_session 之后 ctx 会换人，卡片不该跟着漂）
    let me = current;

    // 每次上报都现算：cwd 会随 /move、/wt 变，不能缓存启动时的值
    const sessionBody = () => ({
      harness: "omp",
      id: me.id,
      agentKind: "main",
      cwd: me.cwd,
      ...(me.file ? { file: me.file } : {}),
      resumeHint: `omp -r ${me.file ?? me.id}`,
    });

    // 不给 card 时服务端按 cwd 反查；解析失败/端点不可达都只记日志，绝不抛（会话照常）。
    const claim = async (): Promise<void> => {
      const res = (await post(
        {
          cmd: "claim",
          actor: { kind: "agent", harness: "omp", sessionId: me.id },
          ...(bound ? { card: bound } : {}),
          session: sessionBody(),
        },
        "claim",
        // 显式给了 card 就是普通上报（照旧记一行 HTTP 日志）；按 cwd 解析的日志下面自己记
        !CARD,
      )) as ClaimResponse | undefined;

      if (res?.ok !== true) {
        // 服务重启 / 超时 / 卡片绑着旧会话（SESSION_CONFLICT）：**不算 claim 上**，下一拍接着试。
        if (!claimFailedLogged) {
          claimFailedLogged = true;
          log(
            `claim: 没 claim 上（${bound ? `卡片 ${bound}` : `cwd ${me.cwd}`}）：` +
              `${res?.rejection?.code ?? "UNREACHABLE"} ${res?.rejection?.message ?? "服务无响应"}` +
              `${res?.rejection?.hint ? ` — ${res.rejection.hint}` : ""}；下一拍继续 claim，不影响会话`,
          );
        }
        return;
      }

      const resolved = res.card?.id;
      if (!bound && resolved === undefined) {
        // 服务端说 ok 却没给卡片（不该发生）：当没绑上，下一拍再试。
        if (!resolveFailedLogged) {
          resolveFailedLogged = true;
          log(`claim: 服务端没给卡片 id（cwd ${me.cwd}）；下一拍继续 claim，不影响会话`);
        }
        return;
      }

      claimed = true;
      claimFailedLogged = false;
      if (!bound) {
        bound = resolved!;
        resolveFailedLogged = false;
        log(`claim: 按 cwd 解析到卡片 ${bound}（cwd ${me.cwd}）`);
      }
    };

    const beat = async (cwd: string): Promise<void> => {
      const res = (await post(
        {
          cmd: "beat",
          actor: { kind: "agent", harness: "omp", sessionId: me.id },
          card: bound,
          session: { harness: "omp", id: me.id, cwd, agentKind: "main" },
        },
        "beat",
      )) as ClaimResponse | undefined;
      if (beatApplied(res)) return;
      // 心跳没人接（卡片还没有会话 / 卡片绑的是旧会话）：退回 claim，别让卡片永远停在「实施中」，
      // 也别让下一个会话一直撞 SESSION_CONFLICT。claim 失败会自己记日志，这里不重复记。
      claimed = false;
      await claim();
    };

    handle = ctx.setInterval?.(() => {
      if (!claimed) {
        // 还没 claim 上（服务重启、上一个会话的 end 没送达、当时解析失败，或**卡片还没建**）：静默重试。
        // 显式 `FLOWCARD_CARD` 也走这一支 —— 那正是开工链路的主路径。
        void claim();
        return;
      }
      // **cwd 每次都要重新读**：omp 的 /move、/wt 会把会话挪到别的目录（比如挪进 worktree），
      // 缓存住启动时的 cwd 会让服务端永远不知道会话已经进去了。
      const here = readCwd(ctx);
      if (here !== me.cwd) {
        me = { ...me, cwd: here };
        log(`cwd 变了：${current?.cwd ?? "?"} → ${here}，重新 claim 让卡片跟上`);
        // 挪了目录就重新 claim：claim 会把会话记录刷新，并触发"进实施中"的前进。
        // 顺手把 claimed 摆回 false：claim 没成功就下一拍继续 claim，而不是拿着旧绑定继续心跳。
        claimed = false;
        void claim();
        return;
      }
      void beat(here);
    }, HEARTBEAT_MS);

    void claim();
  });

  pi.on("session_shutdown", (_payload, ctx) => {
    if (handle && ctx.clearInterval) ctx.clearInterval(handle);
    if (!bound || !current || current.kind !== "main") return;
    void post(
      {
        cmd: "end",
        actor: { kind: "agent", harness: "omp", sessionId: current.id },
        card: bound,
        sessionId: current.id,
      },
      "end",
    );
  });
}
