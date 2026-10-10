/**
 * HTTP 客户端：读走投影，写只走 /api/commands（与后端契约一致）。
 * 默认走相对路径 `/api`（dev 由 vite proxy 转发，避免 CORS）。
 * 所有响应体都先过 `schema.ts` 的 zod schema 再交给 UI —— 这里不出现未校验的 `as`。
 */
import {
  cardResponse,
  cardsResponse,
  changedPayloadSchema,
  commandsResponseSchema,
  describeIssues,
  runtimeResponseSchema,
  type ChangedPayload,
  type CardView,
  type CommandsResponse,
} from "@/lib/schema";
import type { Runtime, RuntimeAction } from "@/lib/contract";

const BASE = (import.meta.env.VITE_FLOWCARD_API ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 拼 API 绝对/相对地址：dev 走 vite proxy（相对），生产同源（相对），VITE_FLOWCARD_API 可给绝对前缀。 */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

/** 网络失败（服务不可达）的统一文案；`projects.ts`/`uploads.ts` 也要给出同一句话。 */
export function unreachableMessage(error: unknown): string {
  return `连不上 flowcard 服务（${BASE || "同源"}/api）：${String(error)}`;
}

/** 网络/解析失败统一走这里：服务不可达（code=UNREACHABLE）要能和业务拒绝区分开。 */
function unreachable(error: unknown): ApiError {
  return new ApiError(0, "UNREACHABLE", unreachableMessage(error));
}

/**
 * 从失败响应里抠出可读文案：服务端会回 `{ error: { code, message, hint } }` 或 `{ rejection }`，
 * 拿不到就退回 HTTP 码。`projects.ts` / `uploads.ts` 都复用这一处，避免各写一份解析。
 */
export async function readErrorBody(res: Response): Promise<string> {
  const raw: unknown = await res.json().catch(() => null);
  if (raw && typeof raw === "object") {
    const body = raw as Record<string, unknown>;
    for (const key of ["error", "rejection"]) {
      const value = body[key];
      if (value && typeof value === "object") {
        const inner = value as Record<string, unknown>;
        const message = typeof inner["message"] === "string" ? inner["message"] : null;
        if (message) {
          const code = typeof inner["code"] === "string" ? inner["code"] : null;
          const hint = typeof inner["hint"] === "string" ? `（${inner["hint"]}）` : "";
          return `${code ? `${code}：` : ""}${message}${hint}`;
        }
      }
    }
    if (typeof body["message"] === "string") return body["message"];
  }
  return `HTTP ${res.status}`;
}

export async function fetchCards(signal?: AbortSignal): Promise<CardView[]> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/cards`, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw unreachable(error);
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, `读取卡片失败（HTTP ${res.status}）`);
  const parsed = cardsResponse.parse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(200, "BAD_RESPONSE", `卡片列表格式不符合契约：${describeIssues(parsed.error)}`);
  }
  return cardsResponse.select(parsed.data);
}

export async function fetchCard(id: string, signal?: AbortSignal): Promise<CardView> {
  const res = await fetch(`${BASE}/api/cards/${encodeURIComponent(id)}`, {
    signal,
    headers: { accept: "application/json" },
  });
  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, `HTTP_${res.status}`, `读取卡片失败（HTTP ${res.status}）`);
  const parsed = cardResponse.parse(raw);
  if (!parsed.success) {
    throw new ApiError(200, "BAD_RESPONSE", `卡片格式不符合契约：${describeIssues(parsed.error)}`);
  }
  return cardResponse.select(parsed.data);
}

/** 所有写操作都走这里；网络层失败也转成 rejection，调用方只需看 ok。 */
export async function postCommand(command: Record<string, unknown>): Promise<CommandsResponse> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  } catch (error) {
    return { ok: false, rejection: { code: "UNREACHABLE", message: unreachable(error).message } };
  }
  const parsed = commandsResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      rejection: {
        code: "BAD_RESPONSE",
        message: `命令响应不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`,
      },
    };
  }
  return parsed.data;
}

/** UI 层的运行时操作结果：把服务端 failure、网络错误、契约不符都收敛成一条可读文案。 */
export type RuntimeOutcome = {
  ok: boolean;
  runtime: Runtime | null;
  killed: string[];
  warnings: string[];
  error?: string;
};

/** 运行时开关：后端路由可能还没挂上（404），按可选处理。 */
export async function postRuntime(cardId: string, action: RuntimeAction): Promise<RuntimeOutcome> {
  const failed = (error: string): RuntimeOutcome => ({
    ok: false,
    runtime: null,
    killed: [],
    warnings: [],
    error,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/cards/${encodeURIComponent(cardId)}/runtime`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
  } catch (error) {
    return failed(unreachable(error).message);
  }
  if (res.status === 404) return failed("运行时接口尚未实现（HTTP 404）");

  const parsed = runtimeResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return failed(`运行时响应不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`);
  }

  const result = parsed.data;
  const failure = result.error;
  return {
    ok: result.ok,
    runtime: result.runtime ?? null,
    killed: result.killed ?? [],
    warnings: result.warnings ?? [],
    ...(result.ok
      ? {}
      : {
          error: failure
            ? `${failure.code}：${failure.message}${failure.hint ? `（${failure.hint}）` : ""}`
            : `运行时操作失败（HTTP ${res.status}）`,
        }),
  };
}

export function streamUrl(): string {
  return `${BASE}/api/stream`;
}

export function parseChanged(data: string): ChangedPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = changedPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 详情侧栏拿的是列表快照；这里只做查找，找不到时返回 null 由调用方降级。 */
export function findCard(cards: CardView[], id: string | null): CardView | null {
  if (!id) return null;
  return cards.find((card) => card.id === id) ?? null;
}
