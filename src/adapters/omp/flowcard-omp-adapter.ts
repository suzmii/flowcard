/**
 * flowcard ⇄ omp 适配器：把会话生命周期上报给 flowcard。
 *
 * 加载（不需要 manifest、不需要 omp install）：
 *   omp -e /path/to/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
 *
 * 环境变量：
 *   FLOWCARD_URL          默认 http://127.0.0.1:47825
 *   FLOWCARD_CARD         卡片 id（**在卡片的 worktree 里启动 omp 时给上**，否则只记日志不上报）
 *   FLOWCARD_HEARTBEAT_MS 心跳间隔，默认 15000
 *   FLOWCARD_OMP_LOG      日志文件，默认 /tmp/omp-adapter.log
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

async function post(command: Record<string, unknown>, label: string): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    const text = await res.text();
    log(`${label} -> ${res.status} ${text.slice(0, 400)}`);
  } catch (error) {
    // 服务没起、超时、网络断：只记录，绝不抛
    log(`${label} !! ${String(error)}`);
  }
}

export default function flowcardOmpAdapter(pi: OmpExtensionApi): void {
  let handle: unknown;
  let current: { id: string; cwd: string; kind: string; file?: string } | undefined;

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
    if (!CARD) {
      log(`session_start: ${current.id} 未设置 FLOWCARD_CARD，无法上报（在 worktree 里用 FLOWCARD_CARD=cN omp 启动）`);
      return;
    }
    void post(
      {
        cmd: "claim",
        actor: { kind: "agent", harness: "omp", sessionId: current.id },
        card: CARD,
        session: {
          harness: "omp",
          id: current.id,
          agentKind: "main",
          cwd: current.cwd,
          ...(current.file ? { file: current.file } : {}),
          resumeHint: `omp -r ${current.file ?? current.id}`,
        },
      },
      "claim",
    );

    handle = ctx.setInterval?.(() => {
      if (!current) return;
      void post(
        {
          cmd: "beat",
          actor: { kind: "agent", harness: "omp", sessionId: current.id },
          card: CARD,
          session: { harness: "omp", id: current.id, cwd: current.cwd, agentKind: "main" },
        },
        "beat",
      );
    }, HEARTBEAT_MS);
  });

  pi.on("session_shutdown", (_payload, ctx) => {
    if (handle && ctx.clearInterval) ctx.clearInterval(handle);
    if (!CARD || !current || current.kind !== "main") return;
    void post(
      {
        cmd: "end",
        actor: { kind: "agent", harness: "omp", sessionId: current.id },
        card: CARD,
        sessionId: current.id,
      },
      "end",
    );
  });
}
