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
const LOG_PATH = process.env.FLOWCARD_OMP_LOG ?? "/tmp/omp-adapter.log";
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
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志失败必须静默 */
  }
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
};

export default function flowcardOmpAdapter(pi: OmpExtensionApi): void {
  let handle: unknown;
  let current: { id: string; cwd: string; kind: string; file?: string } | undefined;
  /** 卡片 id：FLOWCARD_CARD 显式给的，或 claim 时服务端按 cwd 解析出来的 */
  let bound = CARD;
  /** 「解析失败」只记一次日志：心跳会重试，不能每 15s 刷屏 */
  let resolveFailedLogged = false;

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
    const me = current;

    const session = {
      harness: "omp",
      id: me.id,
      agentKind: "main",
      cwd: me.cwd,
      ...(me.file ? { file: me.file } : {}),
      resumeHint: `omp -r ${me.file ?? me.id}`,
    };

    // 不给 card 时服务端按 cwd 反查；解析失败/端点不可达都只记日志，绝不抛（会话照常）。
    const claim = async (): Promise<void> => {
      const res = (await post(
        {
          cmd: "claim",
          actor: { kind: "agent", harness: "omp", sessionId: me.id },
          ...(bound ? { card: bound } : {}),
          session,
        },
        "claim",
        // 显式给了 card 就是普通上报（照旧记一行 HTTP 日志）；按 cwd 解析的日志下面自己记
        !CARD,
      )) as ClaimResponse | undefined;
      if (bound) return;
      const resolved = res?.card?.id;
      if (res?.ok && resolved) {
        bound = resolved;
        resolveFailedLogged = false;
        log(`claim: 按 cwd 解析到卡片 ${resolved}（cwd ${me.cwd}）`);
        return;
      }
      if (!resolveFailedLogged) {
        resolveFailedLogged = true;
        log(
          `claim: 没绑上卡片（cwd ${me.cwd}）：${res?.rejection?.code ?? "UNREACHABLE"} ` +
            `${res?.rejection?.message ?? "服务无响应"}` +
            `${res?.rejection?.hint ? ` — ${res.rejection.hint}` : ""}；心跳时重试，不影响会话`,
        );
      }
    };

    handle = ctx.setInterval?.(() => {
      if (!bound) {
        // 还没绑上（当时解析失败，或卡片还没建）：静默重试
        void claim();
        return;
      }
      void post(
        {
          cmd: "beat",
          actor: { kind: "agent", harness: "omp", sessionId: me.id },
          card: bound,
          session: { harness: "omp", id: me.id, cwd: me.cwd, agentKind: "main" },
        },
        "beat",
      );
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
