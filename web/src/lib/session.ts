/**
 * 卡片托管会话（`GET/POST /api/cards/:id/session*`）：在网页里直接跟这张卡的 agent 会话对话，
 * 工具调用与终端输出也在这里看（不再另开终端窗口）。本模块只做三件事：zod 容错、fetch、SSE 归并。
 *
 * 归一化规则（后端已按这套发帧，前端只负责按 id 合并与容错）：
 * - 转录按 `id` 归并：`message` 追加 `textDelta`，`message_end` 用 `text` **覆盖**（权威），不跨 id 合并；
 * - 工具块按 `callId` 归并：`tool{phase:"start"}` 建块，`update`/`end` 追加或替换输出（见 `mergeToolOutput`）；
 * - 刷新/重连时用 GET 的快照与本地流合并（`mergeSessionSnapshot`）：同 id 取更长的那份文本，
 *   免得「流到一半」的助手文本被落后一步的快照打回去。
 */
import { z } from "zod";
import { apiUrl, readErrorBody, unreachableMessage } from "@/lib/api";
import { describeIssues } from "@/lib/schema";

export const HOSTED_SESSION_STATUSES = ["stopped", "starting", "running", "ended", "failed"] as const;

export type HostedSessionStatus = (typeof HOSTED_SESSION_STATUSES)[number];

export const SESSION_STATUS_LABELS: Record<HostedSessionStatus, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  ended: "已结束",
  failed: "启动失败",
};

export const SESSION_STATUS_TONE: Record<
  HostedSessionStatus,
  "success" | "warning" | "danger" | "muted"
> = {
  stopped: "muted",
  starting: "warning",
  running: "success",
  ended: "muted",
  failed: "danger",
};

export const TOOL_STATUS_LABELS: Record<"start" | "update" | "end", string> = {
  start: "开始",
  update: "输出",
  end: "完成",
};

/**
 * 工具输出/参数可能是字符串，也可能是结构化对象；解析时就统一成可读文本（空串 = 没有），
 * 渲染层就不用再判类型。
 */
function toolText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// ------------------------------------------------------------------ schema
/** 单个字段坏了不能带塌整块响应：能兜底的一律 `.catch` 兜底。 */
const statusSchema = z.enum(HOSTED_SESSION_STATUSES).catch("stopped");
const roleSchema = z.enum(["user", "assistant", "tool"]).catch("assistant");
const toolPhaseSchema = z.enum(["start", "update", "end"]).catch("update");
const optNumber = z.number().optional().catch(undefined);
const optString = z.string().optional().catch(undefined);
const optBool = z.boolean().optional().catch(undefined);

const costSchema = z.looseObject({
  total: optNumber,
  cost: optNumber,
});

/** 工具调用块（`callId` 归并的键）；`args`/`output` 一律渲染成字符串。 */
const toolSchema = z.looseObject({
  callId: z.string(),
  name: z.string(),
  status: toolPhaseSchema,
  args: z.unknown().optional().transform((value) => toolText(value)),
  output: z.unknown().optional().transform((value) => toolText(value)),
  isError: optBool,
});

const messageSchema = z.looseObject({
  id: z.string(),
  role: roleSchema,
  at: z.string().catch(""),
  text: optString,
  tool: toolSchema.optional().catch(undefined),
});

export const hostedSessionSchema = z.looseObject({
  status: statusSchema,
  ompSessionId: optString,
  cwd: z.string().catch(""),
  startedAt: optString,
  lastActivityAt: optString,
  busy: z.boolean().catch(false),
  cost: costSchema.optional().catch(undefined),
  messages: z.array(messageSchema).catch([]),
});

export type SessionCost = z.infer<typeof costSchema>;
export type SessionTool = z.infer<typeof toolSchema>;
export type SessionMessage = z.infer<typeof messageSchema>;
export type SessionRole = SessionMessage["role"];
export type SessionState = z.infer<typeof hostedSessionSchema>;

// ------------------------------------------------------------------ 会话列表（左栏）
/**
 * 列表那一行状态点的口径：**卡片上的会话事实打底，托管会话快照盖在上面**。
 * 事实（`card.session.state`）只认 idle/running/ended/lost，`failed`/`starting` 只有快照知道，所以两者都看。
 */
export const SESSION_ROW_STATUSES = ["running", "idle", "lost", "ended", "failed"] as const;
export type SessionRowStatus = (typeof SESSION_ROW_STATUSES)[number];

export const SESSION_ROW_LABELS: Record<SessionRowStatus, string> = {
  running: "运行中",
  idle: "空闲",
  lost: "失联",
  ended: "已结束",
  failed: "启动失败",
};

export const SESSION_ROW_TONE: Record<SessionRowStatus, "success" | "info" | "warning" | "danger" | "muted"> = {
  running: "success",
  idle: "info",
  lost: "danger",
  ended: "muted",
  failed: "danger",
};

/** 状态点的底色（与 `CardTile` 的会话点同一套颜色）。 */
export const SESSION_ROW_DOT: Record<SessionRowStatus, string> = {
  running: "bg-emerald-600",
  idle: "bg-neutral-400",
  lost: "bg-red-600",
  ended: "bg-slate-400",
  failed: "bg-red-600",
};

/** 画一行需要的会话事实（`card.session` 的子集）。 */
export type SessionRowFact = { state: "idle" | "running" | "ended" | "lost"; lastSeenAt: string };

export type SessionRowSignals = { status: SessionRowStatus; busy: boolean; at: string };

/**
 * 一行会话的信号：事实与快照都没有（卡片还没绑会话）→ null，这种卡不进列表。
 * 快照是 `stopped` 时不算数（那是「托管进程没起」，卡片事实更权威）。
 */
export function sessionRowSignals(
  fact: SessionRowFact | null,
  live?: SessionState | null,
): SessionRowSignals | null {
  if (!fact && !live) return null;
  const fromLive = live && live.status !== "stopped" ? live.status : null;
  const status: SessionRowStatus =
    fromLive === "failed"
      ? "failed"
      : fromLive === "starting" || fromLive === "running"
        ? "running"
        : fromLive === "ended"
          ? "ended"
          : (fact?.state ?? "ended");
  return {
    status,
    busy: live ? live.status === "starting" || live.busy : false,
    at: live?.lastActivityAt ?? fact?.lastSeenAt ?? "",
  };
}

// ------------------------------------------------------------------ 网络
export type SessionFailure = { ok: false; code: string; message: string; missing: boolean };
export type SessionResult = { ok: true; data: SessionState } | SessionFailure;

export type SessionImage = { name: string; dataBase64: string };

export type SessionActionOutcome =
  | { ok: true; status?: HostedSessionStatus; ompSessionId?: string; messageId?: string }
  | SessionFailure;

function sessionPath(cardId: string, suffix = ""): string {
  return `/api/cards/${encodeURIComponent(cardId)}/session${suffix}`;
}

export function sessionStreamUrl(cardId: string): string {
  return apiUrl(sessionPath(cardId, "/stream"));
}

/** 回包里可选带的失败详情（`{ error: { code, message, hint } }`）。 */
const errorBodySchema = z.looseObject({
  ok: z.boolean().optional(),
  error: z.looseObject({ code: z.string(), message: z.string(), hint: z.string().optional() }).optional(),
});

export async function fetchSession(cardId: string, signal?: AbortSignal): Promise<SessionResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl(sessionPath(cardId)), { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, code: "UNREACHABLE", message: unreachableMessage(error), missing: false };
  }

  const clone = res.clone();
  const raw: unknown = await res.json().catch(() => null);
  const parsed = hostedSessionSchema.safeParse(raw);
  const envelope = errorBodySchema.safeParse(raw);
  const failure = envelope.success ? envelope.data.error : undefined;
  // 只认「像一份会话」的响应体：`{}` 或别的 JSON 不能被 schema 的默认值糊成一份空会话。
  const shaped =
    raw !== null &&
    typeof raw === "object" &&
    ["status", "cwd", "messages", "busy"].some((key) => key in raw);

  // 路由没挂：404 且响应里没有服务端自己的 error（那样才是「卡片不存在」之类的业务 404）。
  if (res.status === 404 && !failure) {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "服务端还没有 GET /api/cards/:id/session（托管会话接口未实现）",
      missing: true,
    };
  }
  if (failure) {
    return {
      ok: false,
      code: failure.code,
      message: failure.hint ? `${failure.message}（${failure.hint}）` : failure.message,
      missing: false,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: `HTTP_${res.status}`,
      message: `读取会话失败（HTTP ${res.status}）：${await readErrorBody(clone)}`,
      missing: false,
    };
  }
  if (!shaped || !parsed.success) {
    const reason = parsed.success ? "缺少 status / cwd / messages / busy 字段" : describeIssues(parsed.error);
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: `会话响应不符合契约（HTTP ${res.status}）：${reason}`,
      missing: false,
    };
  }
  return { ok: true, data: parsed.data };
}

/** 四个写操作共用的 POST：404 / 服务端拒绝 / 契约不符都收敛成一句可读文案。 */
async function postSession(
  cardId: string,
  suffix: string,
  body: Record<string, unknown>,
  label: string,
): Promise<{ ok: true; raw: Record<string, unknown> } | SessionFailure> {
  let res: Response;
  try {
    res = await fetch(apiUrl(sessionPath(cardId, suffix)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, code: "UNREACHABLE", message: unreachableMessage(error), missing: false };
  }

  const clone = res.clone();
  const raw: unknown = await res.json().catch(() => null);
  const envelope = errorBodySchema.safeParse(raw);
  const failure = envelope.success ? envelope.data.error : undefined;

  if (res.status === 404 && !failure) {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: `服务端还没有 POST /api/cards/:id/session${suffix}（托管会话接口未实现）`,
      missing: true,
    };
  }
  if (failure) {
    return {
      ok: false,
      code: failure.code,
      message: failure.hint ? `${failure.message}（${failure.hint}）` : failure.message,
      missing: false,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: `HTTP_${res.status}`,
      message: `${label}失败（HTTP ${res.status}）：${await readErrorBody(clone)}`,
      missing: false,
    };
  }
  if (!envelope.success) {
    return { ok: false, code: "BAD_RESPONSE", message: `${label}响应不符合契约（HTTP ${res.status}）`, missing: false };
  }
  if (envelope.data.ok === false) {
    return { ok: false, code: `HTTP_${res.status}`, message: `${label}被服务端拒绝（HTTP ${res.status}）`, missing: false };
  }
  return { ok: true, raw: (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown> };
}

const startResponseSchema = z.looseObject({
  status: statusSchema.optional().catch(undefined),
  ompSessionId: optString,
  messageId: optString,
});

/** 启动托管会话（cwd 不传时由服务端挑：卡片 worktree 优先）。 */
export async function startSession(cardId: string, opts: { cwd?: string } = {}): Promise<SessionActionOutcome> {
  const outcome = await postSession(cardId, "/start", opts.cwd ? { cwd: opts.cwd } : {}, "启动会话");
  if (!outcome.ok) return outcome;
  const extra = startResponseSchema.safeParse(outcome.raw);
  if (!extra.success) return { ok: true };
  return {
    ok: true,
    ...(extra.data.status === undefined ? {} : { status: extra.data.status }),
    ...(extra.data.ompSessionId === undefined ? {} : { ompSessionId: extra.data.ompSessionId }),
    ...(extra.data.messageId === undefined ? {} : { messageId: extra.data.messageId }),
  };
}

/** 发一句话（图片按契约内联 base64）。 */
export async function promptSession(
  cardId: string,
  prompt: { text: string; images?: SessionImage[] },
): Promise<SessionActionOutcome> {
  const body: Record<string, unknown> = { text: prompt.text };
  if (prompt.images && prompt.images.length > 0) body.images = prompt.images;
  const outcome = await postSession(cardId, "/prompt", body, "发送消息");
  if (!outcome.ok) return outcome;
  const extra = startResponseSchema.safeParse(outcome.raw);
  return extra.success && extra.data.messageId !== undefined
    ? { ok: true, messageId: extra.data.messageId }
    : { ok: true };
}

/** 中断当前这一轮（会话还活着）。 */
export async function abortSession(cardId: string): Promise<SessionActionOutcome> {
  const outcome = await postSession(cardId, "/abort", {}, "中断");
  return outcome.ok ? { ok: true } : outcome;
}

/** 停掉托管会话进程。 */
export async function stopSession(cardId: string): Promise<SessionActionOutcome> {
  const outcome = await postSession(cardId, "/stop", {}, "停止会话");
  return outcome.ok ? { ok: true } : outcome;
}

// ------------------------------------------------------------------ 事件与归并
export type SessionNoticeLevel = "info" | "warn" | "error";
export type SessionNotice = { at: string; level: SessionNoticeLevel; message: string };

export type SessionEvent =
  | { type: "ready"; ompSessionId: string; cwd: string }
  | { type: "message"; id: string; role: SessionRole; textDelta: string }
  | { type: "message_end"; id: string; role: SessionRole; text: string; at: string }
  | {
      type: "tool";
      callId: string;
      name: string;
      phase: "start" | "update" | "end";
      args: string;
      output: string;
      isError?: boolean;
    }
  | { type: "state"; busy: boolean; status?: HostedSessionStatus; cost?: SessionCost }
  | { type: "notice"; level: SessionNoticeLevel; message: string }
  | { type: "error"; message: string };

/** SSE 名字取自契约：ready / message / message_end / tool / state / notice / error。 */
export const SESSION_EVENT_NAMES = ["ready", "message", "message_end", "tool", "state", "notice", "error"] as const;
export type SessionEventName = (typeof SESSION_EVENT_NAMES)[number];

const eventSchema = z.looseObject({
  id: optString,
  role: roleSchema.optional().catch(undefined),
  textDelta: optString,
  contentIndex: optNumber,
  text: optString,
  at: optString,
  callId: optString,
  name: optString,
  phase: z.enum(["start", "update", "end"]).optional().catch(undefined),
  args: z.unknown().optional().transform((value) => toolText(value)),
  output: z.unknown().optional().transform((value) => toolText(value)),
  isError: optBool,
  busy: optBool,
  status: statusSchema.optional().catch(undefined),
  cost: costSchema.optional().catch(undefined),
  message: optString,
  level: z.enum(["info", "warn", "warning", "error"]).optional().catch(undefined),
  ompSessionId: optString,
  cwd: optString,
});

/** 一帧 SSE → 事件；认不出来（坏 JSON / 缺关键字段）返回 null，由调用方忽略。 */
export function parseSessionEvent(name: string, data: string): SessionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const frame = parsed.data;

  switch (name as SessionEventName) {
    case "ready":
      return { type: "ready", ompSessionId: frame.ompSessionId ?? "", cwd: frame.cwd ?? "" };
    case "message":
      if (!frame.id) return null;
      return { type: "message", id: frame.id, role: frame.role ?? "assistant", textDelta: frame.textDelta ?? "" };
    case "message_end":
      if (!frame.id) return null;
      return {
        type: "message_end",
        id: frame.id,
        role: frame.role ?? "assistant",
        text: frame.text ?? "",
        at: frame.at ?? "",
      };
    case "tool":
      if (!frame.callId || !frame.name || !frame.phase) return null;
      return {
        type: "tool",
        callId: frame.callId,
        name: frame.name,
        phase: frame.phase,
        args: frame.args,
        output: frame.output,
        ...(frame.isError === undefined ? {} : { isError: frame.isError }),
      };
    case "state":
      return {
        type: "state",
        busy: frame.busy ?? false,
        ...(frame.status === undefined ? {} : { status: frame.status }),
        ...(frame.cost === undefined ? {} : { cost: frame.cost }),
      };
    case "notice":
      return {
        type: "notice",
        level: frame.level === "warning" ? "warn" : (frame.level ?? "info"),
        message: frame.message ?? "",
      };
    case "error":
      return { type: "error", message: frame.message ?? "" };
    default:
      return null;
  }
}

export type SessionView = { session: SessionState; notices: SessionNotice[] };

export const MAX_NOTICES = 24;

export function initialSessionView(): SessionView {
  return { session: { status: "stopped", cwd: "", busy: false, messages: [] }, notices: [] };
}

function replaceMessage(
  messages: SessionMessage[],
  id: string,
  next: (previous: SessionMessage | undefined) => SessionMessage,
): SessionMessage[] {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) return [...messages, next(undefined)];
  const copy = messages.slice();
  copy[index] = next(messages[index]);
  return copy;
}

/**
 * 工具输出的合并：后端可能发「全量快照」也可能发「增量片段」，这里两种都接住 ——
 * 新串以旧串开头 = 累计快照，直接替换；旧串已经包含新串 = 重复，忽略；其余按增量追加。
 */
export function mergeToolOutput(previous: string, next: string): string {
  if (next === "") return previous;
  if (previous === "" || next === previous) return next;
  if (next.startsWith(previous)) return next;
  if (previous.endsWith(next)) return previous;
  return previous + next;
}

function upsertTool(messages: SessionMessage[], event: Extract<SessionEvent, { type: "tool" }>): SessionMessage[] {
  const existing = messages.find((message) => message.id === event.callId);
  const previous = existing?.tool;
  const started = event.phase === "start";
  const tool: SessionTool = {
    callId: event.callId,
    name: event.name === "" ? (previous?.name ?? "") : event.name,
    status: event.phase,
    args: started || previous?.args === undefined || previous.args === "" ? event.args : previous.args,
    output: started ? event.output : mergeToolOutput(previous?.output ?? "", event.output),
  };
  if (event.isError !== undefined) tool.isError = event.isError;
  else if (previous?.isError !== undefined) tool.isError = previous.isError;

  const message: SessionMessage = {
    id: event.callId,
    role: "tool",
    at: existing?.at ?? "",
    text: existing?.text,
    tool,
  };
  return replaceMessage(messages, event.callId, () => message);
}

/** 一帧事件 → 新视图（纯函数；`now` 由调用方给，便于测试与稳定输出）。 */
export function applySessionEvent(view: SessionView, event: SessionEvent, now = ""): SessionView {
  const session = view.session;

  switch (event.type) {
    case "ready":
      return {
        ...view,
        session: {
          ...session,
          cwd: event.cwd === "" ? session.cwd : event.cwd,
          ...(event.ompSessionId === "" ? {} : { ompSessionId: event.ompSessionId }),
        },
      };
    case "message":
      return {
        ...view,
        session: {
          ...session,
          messages: replaceMessage(session.messages, event.id, (previous) => ({
            id: event.id,
            role: event.role,
            at: previous?.at ?? "",
            text: (previous?.text ?? "") + event.textDelta,
            ...(previous?.tool ? { tool: previous.tool } : {}),
          })),
        },
      };
    case "message_end":
      return {
        ...view,
        session: {
          ...session,
          messages: replaceMessage(session.messages, event.id, (previous) => ({
            id: event.id,
            role: event.role,
            at: event.at === "" ? (previous?.at ?? "") : event.at,
            // message_end 是权威文本：整条覆盖，不做增量
            text: event.text,
            ...(previous?.tool ? { tool: previous.tool } : {}),
          })),
        },
      };
    case "tool":
      return { ...view, session: { ...session, messages: upsertTool(session.messages, event) } };
    case "state":
      return {
        ...view,
        session: {
          ...session,
          busy: event.busy,
          ...(event.status === undefined ? {} : { status: event.status }),
          ...(event.cost === undefined ? {} : { cost: event.cost }),
        },
      };
    case "notice":
      return { ...view, notices: pushNotice(view.notices, event.level, event.message, now) };
    case "error":
      return { ...view, notices: pushNotice(view.notices, "error", event.message, now) };
  }
}

function pushNotice(
  notices: SessionNotice[],
  level: SessionNoticeLevel,
  message: string,
  at: string,
): SessionNotice[] {
  if (message === "") return notices;
  return [...notices, { at, level, message }].slice(-MAX_NOTICES);
}

/**
 * GET 快照 vs 本地流：同 id 时取信息更全的那份（文本更长者胜、工具输出更长者胜），
 * 本地独有的消息挂在尾部（正在流、快照还没落盘的那条）。状态/成本以快照为准。
 */
export function mergeSessionSnapshot(current: SessionState, snapshot: SessionState): SessionState {
  const local = new Map(current.messages.map((message) => [message.id, message]));

  const merged = snapshot.messages.map((message) => {
    const mine = local.get(message.id);
    if (!mine) return message;
    const keepText = (mine.text?.length ?? 0) > (message.text?.length ?? 0);
    const tool = pickTool(mine.tool, message.tool);
    const at = message.at === "" && mine.at !== "" ? mine.at : message.at;
    return {
      ...message,
      at,
      ...(keepText ? { text: mine.text } : {}),
      ...(tool ? { tool } : {}),
    };
  });

  const known = new Set(snapshot.messages.map((message) => message.id));
  for (const message of current.messages) if (!known.has(message.id)) merged.push(message);

  return { ...snapshot, messages: merged };
}

function pickTool(mine: SessionTool | undefined, theirs: SessionTool | undefined): SessionTool | undefined {
  if (!mine) return theirs;
  if (!theirs) return mine;
  if (mine.output.length > theirs.output.length) return { ...theirs, output: mine.output, status: mine.status };
  return theirs.status === "start" && mine.status !== "start" ? { ...theirs, status: mine.status } : theirs;
}

// ------------------------------------------------------------------ SSE
export type SessionStreamHandlers = {
  onEvent: (event: SessionEvent) => void;
  /** 连上了（EventSource open，或服务端 `ready` 帧）：调用方可借此补一次快照。 */
  onLive: () => void;
  /** 断了（EventSource 自己会重连，这里只把状态亮出来）。 */
  onDisconnect: () => void;
};

/** 订阅一张卡的会话流，返回退订函数。 */
export function subscribeSession(cardId: string, handlers: SessionStreamHandlers): () => void {
  const url = sessionStreamUrl(cardId);
  let source: EventSource | null = null;
  let timer: number | undefined;
  let attempt = 0;
  let closed = false;

  /**
   * 不信 EventSource 的自动重连：SSE 规范里「响应不是 200 / 不是 text/event-stream」属于
   * 「fail the connection」——浏览器会**永久放弃**（readyState=CLOSED 且不再重试），
   * 而服务重启、反代 502 期间正好会撞上这条。所以一旦发现 CLOSED 就自己带退避重建。
   */
  const reopenLater = () => {
    if (closed || timer !== undefined) return;
    attempt += 1;
    timer = window.setTimeout(
      () => {
        timer = undefined;
        connect();
      },
      Math.min(1000 * 2 ** (attempt - 1), 10_000),
    );
  };

  const connect = () => {
    if (closed) return;
    source?.close();
    const next = new EventSource(url);
    source = next;

    next.onopen = () => {
      attempt = 0;
      handlers.onLive();
    };

    for (const name of SESSION_EVENT_NAMES) {
      // "error" 单独处理（见下）：它在 EventSource 里是保留事件，连接失败也会触发同名事件
      if (name === "error") continue;
      next.addEventListener(name, (event) => {
        const data = (event as MessageEvent<string>).data;
        if (typeof data !== "string") return;
        const parsed = parseSessionEvent(name, data);
        if (parsed) handlers.onEvent(parsed);
      });
    }

    // "error" 是 EventSource 的保留事件：连接失败给的是裸 Event（没有 data），服务端的 error 帧才带 data。
    next.addEventListener("error", (event) => {
      const data = (event as MessageEvent<string>).data;
      if (typeof data === "string" && data !== "") {
        const parsed = parseSessionEvent("error", data);
        if (parsed) handlers.onEvent(parsed);
        return;
      }
      handlers.onDisconnect();
      if (next.readyState === EventSource.CLOSED) reopenLater();
    });
  };

  connect();
  return () => {
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    source?.close();
  };
}
