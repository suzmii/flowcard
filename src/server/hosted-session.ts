/**
 * 托管会话：每张卡片一个 `omp --mode rpc --no-ui` 子进程（stdio 管道），网页通过 HTTP/SSE
 * 跟它对话并看到工具输出 —— **不弹任何窗口，也不引 node-pty**。
 *
 * 分层（与 `omp-rpc.ts`/`probe.ts` 同一范式）：
 *   1. `omp-rpc.ts` 管协议与子进程（帧解析、纯文本归并、优雅停）；
 *   2. 本模块管**编排与投影**：每卡一条 live 记录、`OmpEvent` → SSE 事件 + 转录落库、
 *      会话身份（`claim`）/退出（`end`）上报成流程事实。`startSession` 可注入（测试塞假 omp）。
 *
 * 两条不变量：
 *   · **会话身份由 flowcard 代表会话上报**（`claim`/`end`），卡片投影与三张表一个都不用改；
 *   · **任何异常都不许抛**：帧坏了、子进程没了、落库失败，一律变成 SSE 事件或状态 `failed`，
 *     绝不会把 HTTP 打成 5xx。
 *
 * 转录落 `session_messages`（**不进事件流**，取舍见 `docs/design.md` §14）：
 * 重启服务后 `snapshot()` 照样给得出历史。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOmpPath } from "./launch.ts";
import { startRpcSession, type OmpEvent, type OmpRpcSession, type StartRpcOptions } from "./omp-rpc.ts";
import type { SessionToolEvent, Store } from "./store.ts";

// ---------------------------------------------------------------- 类型（HTTP 契约）

/** 会话状态：没起过 `stopped`；起着 `starting`→`running`；子进程没了 `ended`（起的失败 `failed`）。 */
export type HostedSessionStatus = "stopped" | "starting" | "running" | "ended" | "failed";

export type SessionCost = { total?: number; cost?: number };

/** 转录里的一条消息（`tool` 行的 `tool` 槽位带工具名/参数/输出）。 */
export type SessionMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  at: string;
  text?: string;
  tool?: SessionToolEvent;
};

export type SessionSnapshot = {
  status: HostedSessionStatus;
  ompSessionId?: string;
  cwd: string;
  startedAt?: string;
  lastActivityAt?: string;
  busy: boolean;
  cost?: SessionCost;
  messages: SessionMessage[];
};

/** 每卡 SSE 推的事件（`type` 就是 SSE 的 `event:` 名，见 `GET /api/cards/:id/session/stream`）。 */
export type SessionEvent =
  | { type: "ready"; ompSessionId?: string; cwd: string }
  | { type: "message"; id: string; role: "user" | "assistant"; textDelta?: string; contentIndex?: number }
  | { type: "message_end"; id: string; role: "user" | "assistant"; text: string; at: string }
  | {
      type: "tool";
      callId: string;
      name: string;
      phase: "start" | "update" | "end";
      args?: unknown;
      output?: string;
      isError?: boolean;
    }
  | { type: "state"; busy: boolean; status: HostedSessionStatus; cost?: SessionCost }
  | { type: "notice"; level: string; message: string }
  | { type: "error"; message: string };

export type SessionError = { code: string; message: string };

export type StartSessionResult = {
  ok: boolean;
  status: HostedSessionStatus;
  ompSessionId?: string;
  cwd?: string;
  error?: SessionError;
};

export type PromptResult = { ok: boolean; messageId?: string; error?: SessionError };
export type SimpleResult = { ok: boolean; error?: SessionError };

/** 上传图片：前端给 `{name, dataBase64}`，这里补 omp 要的 `ImageContent`（mimeType 从扩展名猜）。 */
export type SessionImage = { name: string; dataBase64: string };

export type StartSessionOptions = {
  /** 工作目录；不给就取卡片已绑 worktree，再退项目根。 */
  cwd?: string;
  /** 开工提示（卡片现状 + 待办）：作为 `--append-system-prompt` 注入。 */
  brief?: string;
  /** 起好后立刻发出去的第一条 prompt（"开工"）。 */
  kickoff?: string;
  /** 追加到 argv 之后的参数（如 `--model`）。 */
  args?: readonly string[];
};

/**
 * `--append-system-prompt` 的值上限：Linux 单个 argv 元素上限 `MAX_ARG_STRLEN` = 128 KiB，
 * 超了 omp 根本起不来（E2BIG），而 flowcard 还会报"已启动会话"。留出余量给别的参数与环境。
 */
export const MAX_INLINE_BRIEF_BYTES = 96 * 1024;

/** 按 UTF-8 边界截到至多 `limit` 字节（不把多字节字符切成两半）。 */
function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // 截断点落在续字节上 = 这个字符跨了边界：往回退到字符边界
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * `--append-system-prompt` 该传什么：
 *   · 小 brief（默认路径）→ 直接传正文（**顺手补个换行**，见下）；
 *   · 超过 argv 上限 → 写成文件，传**文件路径**（omp 的 `resolvePromptInput` 判定规则是
 *     "含不含 `\n`"：含换行当正文，否则先试 `Bun.file(值).text()` —— 所以传路径它自己会读进来；
 *     既不撞 E2BIG，也没有 `$(cat …)` 那套）；
 *   · 连文件都写不出去 → 截断 + 注明全文在哪，**绝不让会话因为提示太长而起不来**。
 *
 * 补换行是为了钉死"这是正文不是路径"：不带换行的短字符串会被 omp 当路径去试读。
 */
export function briefPromptArg(
  brief: string,
  cardId: string,
  dir: string = join(tmpdir(), "flowcard-briefs"),
): string {
  if (Buffer.byteLength(brief, "utf8") <= MAX_INLINE_BRIEF_BYTES) {
    return brief.includes("\n") ? brief : `${brief}\n`;
  }
  const file = join(dir, `${cardId}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, brief, { mode: 0o600 });
    return file;
  } catch {
    const note = `\n\n…（提示超过 ${MAX_INLINE_BRIEF_BYTES} 字节，已截断：全文看 \`flowcard show ${cardId}\`）`;
    return `${truncateUtf8(brief, MAX_INLINE_BRIEF_BYTES - Buffer.byteLength(note, "utf8"))}${note}`;
  }
}

export type CardChange = { cardId: string; types: string[] };

export type HostedSessions = {
  start(cardId: string, opts?: StartSessionOptions): Promise<StartSessionResult>;
  prompt(cardId: string, text: string, images?: readonly SessionImage[]): Promise<PromptResult>;
  abort(cardId: string): Promise<SimpleResult>;
  stop(cardId: string): Promise<SimpleResult>;
  /** 服务退出时用：逐个优雅停（关 stdin → omp 自己收尾），并行等。 */
  stopAll(): Promise<void>;
  snapshot(cardId: string): SessionSnapshot;
  /** 订阅这张卡的事件（连上就先给一条 `ready` + `state` 的现况）；返回退订函数。 */
  subscribe(cardId: string, listener: (event: SessionEvent) => void): () => void;
  /** 流程事实（claim/end）落库后回调，看板据此广播 `changed`；返回退订函数。 */
  onCard(listener: (change: CardChange) => void): () => void;
  isLive(cardId: string): boolean;
  liveCardIds(): string[];
  /** 会话（或默认）的工作目录：卡片 worktree 优先，其次项目根。 */
  resolveCwd(cardId: string): string | undefined;
};

export type HostedSessionDeps = {
  store: Pick<Store, "getCard" | "getProject" | "execute" | "appendSessionMessage" | "listSessionMessages">;
  /** 起会话的实现；默认 `startRpcSession`。测试注入假 omp（换 argv/env）。 */
  startSession?: (opts: StartRpcOptions) => OmpRpcSession;
  /** omp 可执行文件的绝对路径；不给就找一次（`resolveOmpPath`），找不到交给 PATH 的 `omp`。 */
  ompPath?: string;
  resolveOmpPath?: (opts?: { run?: never }) => Promise<string | undefined>;
  /** 追加到 omp argv 之后的参数（默认 `--no-title`：省一次标题模型调用）。 */
  args?: readonly string[];
  /** omp 上报扩展的绝对路径（`defaultAdapterPath()`）：给了就显式 `-e` 它 —— 心跳/结束仍由适配器兜底。 */
  adapterPath?: string;
  /** 适配器日志目录（按卡片分文件，不再互相覆盖）。 */
  logDir?: string;
  /** flowcard 自己的基址（适配器要回调 `/api/commands`）。 */
  baseUrl?: string;
  /** 子进程环境追加项（测试用）。 */
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  readyTimeoutMs?: number;
};

// ---------------------------------------------------------------- 取值小工具（纯）

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 前端只给文件名 + base64：mime 按扩展名猜（认不出就当 png，omp 侧也只是给模型看）。 */
export function imageMimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "image/png";
}

/** `{name, dataBase64}` → omp 的 `ImageContent`（`pi-ai` 的 `ImageContent`：type/data/mimeType）。 */
export function ompImage(image: SessionImage): Record<string, unknown> {
  return { type: "image", data: image.dataBase64, mimeType: imageMimeType(image.name) };
}

/** 单个工具输出的展示上限：再长就截断（网页要能看，但别把响应撑爆）。 */
export const MAX_TOOL_OUTPUT_CHARS = 8_000;

/**
 * 工具结果 → 给人看的文本（纯函数）：
 *   1. 先说人话：`content` 数组里的 text 块 / `output` / `text` / `stdout` / `error` / `message`；
 *   2. 都没有就 JSON 化（截断）—— 未知形状也比"什么都没有"强，这正是"看到工具输出"要的。
 */
export function toolOutputText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return clip(result);
  const rec = asRecord(result);
  if (rec === null) return clip(JSON.stringify(result));

  const content = rec["content"];
  if (typeof content === "string") return clip(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      const b = asRecord(block);
      const text = b === null ? null : asString(b["text"]);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return clip(parts.join(""));
  }
  for (const key of ["output", "text", "stdout", "stderr", "error", "message"]) {
    const value = asString(rec[key]);
    if (value !== null) return clip(value);
  }
  try {
    return clip(JSON.stringify(result));
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…（已截断）`;
}

// ---------------------------------------------------------------- 编排

/** omp 的会话状态快照（只取我们用的字段）。 */
type OmpState = { sessionId?: unknown; sessionFile?: unknown };

type Live = {
  cardId: string;
  cwd: string;
  /** 外部消息 id 的前缀：omp 的 `msg-1` 在 `new_session`/重启后会重复，转录里必须能区分。 */
  tag: string;
  session: OmpRpcSession;
  startedAt: string;
  lastActivityAt: string;
  status: HostedSessionStatus;
  ompSessionId: string | null;
  cost: SessionCost | null;
  busy: boolean;
  claimed: boolean;
  exited: boolean;
  /** 是否真的见过 `ready` 帧（决定退出时怎么报：起来了才说"会话已退出"）。 */
  readyOk: boolean;
  promptSeq: number;
  /** 每条 omp messageId 第一次出现的时间（写转录用，别让 delta 每次刷新时间）。 */
  seenAt: Map<string, string>;
  off: () => void;
};

export function createHostedSessions(deps: HostedSessionDeps): HostedSessions {
  const store = deps.store;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const startSession = deps.startSession ?? startRpcSession;
  const findOmpPath = deps.resolveOmpPath ?? resolveOmpPath;

  const records = new Map<string, Live>();
  const listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  const cardListeners = new Set<(change: CardChange) => void>();
  let ompPathCache: string | null | undefined;

  const deliver = (listener: (event: SessionEvent) => void, event: SessionEvent): void => {
    try {
      listener(event);
    } catch {
      // 订阅者自己抛错不能拆掉会话（SSE 客户端可能已经断了）。
    }
  };

  const emit = (live: Live, event: SessionEvent): void => {
    for (const listener of [...(listeners.get(live.cardId) ?? [])]) deliver(listener, event);
  };

  const emitState = (live: Live): void => {
    emit(live, {
      type: "state",
      busy: live.busy,
      status: live.status,
      ...(live.cost === null ? {} : { cost: live.cost }),
    });
  };

  const notifyCard = (cardId: string, types: string[]): void => {
    for (const listener of [...cardListeners]) {
      try {
        listener({ cardId, types });
      } catch {
        // 同 deliver()：回调不该影响流程。
      }
    }
  };

  const defaultCwd = (cardId: string): string | undefined => {
    const card = store.getCard(cardId);
    if (!card) return undefined;
    if (card.worktree && card.worktree.path !== "") return card.worktree.path;
    const project = store.getProject(card.projectId);
    if (project && project.virtual !== true && project.path !== "") return project.path;
    return undefined;
  };

  /** 转录落库（失败只报一条 notice：事件已经推出去了，不该因此拆掉会话）。 */
  const persist = (live: Live, message: SessionMessage): void => {
    try {
      store.appendSessionMessage({
        cardId: live.cardId,
        messageId: message.id,
        role: message.role,
        at: message.at,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.tool === undefined ? {} : { tool: message.tool }),
      });
    } catch (error) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `转录没落库（不影响会话）：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const externalId = (live: Live, ompMessageId: string): string => `${live.tag}:${ompMessageId}`;

  const seenAt = (live: Live, ompMessageId: string): string => {
    const found = live.seenAt.get(ompMessageId);
    if (found !== undefined) return found;
    const at = now();
    live.seenAt.set(ompMessageId, at);
    return at;
  };

  /** 从 `get_session_stats` 的 data 里取 tokens/cost（顺手也拿 sessionFile）。 */
  const applyStats = (live: Live, data: unknown): void => {
    const rec = asRecord(data);
    if (rec === null) return;
    const tokens = asRecord(rec["tokens"]);
    const total = tokens === null ? null : asNumber(tokens["total"]);
    const cost = asNumber(rec["cost"]);
    if (total === null && cost === null) return;
    live.cost = {
      ...(live.cost ?? {}),
      ...(total === null ? {} : { total }),
      ...(cost === null ? {} : { cost }),
    };
  };

  const refreshStats = async (live: Live): Promise<void> => {
    const out = await live.session.request<Record<string, unknown>>(
      { type: "get_session_stats" },
      { timeoutMs: 10_000 },
    );
    if (records.get(live.cardId) !== live || live.exited || !out.ok) return;
    const before = JSON.stringify(live.cost);
    applyStats(live, out.data);
    if (JSON.stringify(live.cost) !== before) emitState(live);
  };

  /** 拿会话身份 → 代表会话发 `claim`（卡片投影与三张表都不用改）。 */
  const identify = async (live: Live): Promise<void> => {
    const state = await live.session.request<OmpState>({ type: "get_state" }, { timeoutMs: 10_000 });
    if (records.get(live.cardId) !== live || live.exited) return;
    const stats = await live.session.request<Record<string, unknown>>(
      { type: "get_session_stats" },
      { timeoutMs: 10_000 },
    );
    if (records.get(live.cardId) !== live || live.exited) return;
    if (stats.ok) applyStats(live, stats.data);

    const sid = state.ok ? asString(state.data?.sessionId) : null;
    if (sid === null) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `拿不到 omp 会话身份（get_state ${state.ok ? "没有 sessionId" : `失败：${state.message}`}）：这张卡不会被 claim`,
      });
      return;
    }
    live.ompSessionId = sid;
    const file = stats.ok ? asString(stats.data?.["sessionFile"]) : null;
    const result = store.execute({
      cmd: "claim",
      actor: { kind: "agent", harness: "omp", sessionId: sid },
      card: live.cardId,
      session: {
        harness: "omp",
        id: sid,
        cwd: live.cwd,
        agentKind: "main",
        ...(file === null ? {} : { file }),
        resumeHint: `omp -r ${file ?? sid}`,
      },
    });
    const rejection = result.outcome.rejection;
    if (rejection) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `claim 被拒（${rejection.code}）：${rejection.message}`,
      });
      return;
    }
    live.claimed = true;
    notifyCard(
      live.cardId,
      result.outcome.events.map((event) => event.type),
    );
  };

  /** 子进程没了：状态收尾 + 代表会话发 `end`（幂等，适配器也可能发过同一条）。 */
  const handleExit = (live: Live): void => {
    if (live.exited) return;
    live.exited = true;
    // 还没起来就退 = 起的失败；起来过再退 = 结束。
    live.status = live.status === "starting" ? "failed" : "ended";
    live.busy = false;
    live.off();
    if (live.claimed) {
      const sessions = live.ompSessionId === null ? {} : { sessionId: live.ompSessionId };
      const result = store.execute({
        cmd: "end",
        actor: { kind: "agent", harness: "omp", ...sessions },
        card: live.cardId,
        ...sessions,
      });
      if (!result.outcome.rejection) {
        notifyCard(
          live.cardId,
          result.outcome.events.map((event) => event.type),
        );
      }
    }
    // 没起来就退的细节（退出码/stderr）由 bringUp 报，别在这里报一句"没什么信息"的话。
    if (live.readyOk) {
      emit(live, { type: "notice", level: "info", message: "omp 会话已退出" });
    }
    emitState(live);
  };

  const handle = (live: Live, event: OmpEvent): void => {
    if (records.get(live.cardId) !== live) return;
    live.lastActivityAt = now();
    switch (event.kind) {
      case "text": {
        emit(live, {
          type: "message",
          id: externalId(live, event.messageId),
          role: "assistant",
          textDelta: event.delta,
          ...(event.contentIndex === null ? {} : { contentIndex: event.contentIndex }),
        });
        break;
      }
      case "text_end": {
        // 权威块文本到了：先落一次（这样 message_end 丢了也还有）。
        const id = externalId(live, event.messageId);
        persist(live, {
          id,
          role: "assistant",
          at: seenAt(live, event.messageId),
          text: live.session.textFor(event.messageId) ?? event.text,
        });
        break;
      }
      case "message": {
        // 用户消息由 flowcard 自己 echo（prompt 时就写好了）；工具结果走 tool_execution_*。
        if (event.role !== "assistant") break;
        const id = externalId(live, event.messageId);
        if (event.phase === "start") {
          seenAt(live, event.messageId);
          break;
        }
        const text = event.text ?? live.session.textFor(event.messageId) ?? "";
        const at = seenAt(live, event.messageId);
        persist(live, { id, role: "assistant", at, text });
        emit(live, { type: "message_end", id, role: "assistant", text, at });
        break;
      }
      case "tool": {
        const output = toolOutputText(event.result);
        const tool: SessionToolEvent = {
          callId: event.toolCallId,
          name: event.toolName,
          status: event.phase,
          ...(event.args === undefined ? {} : { args: event.args }),
          ...(output === undefined ? {} : { output }),
          ...(event.isError === null ? {} : { isError: event.isError }),
        };
        persist(live, { id: `${live.tag}:${event.toolCallId}`, role: "tool", at: now(), tool });
        emit(live, {
          type: "tool",
          callId: event.toolCallId,
          name: event.toolName,
          phase: event.phase,
          ...(event.args === undefined ? {} : { args: event.args }),
          ...(output === undefined ? {} : { output }),
          ...(event.isError === null ? {} : { isError: event.isError }),
        });
        break;
      }
      case "notice":
        emit(live, { type: "notice", level: event.level, message: event.message });
        break;
      case "error":
        // 自己发的命令失败（get_state/stats 之类）不是会话级故障：降级成 notice，别的照旧是 error。
        if (event.scope === "command" && event.command !== "prompt") {
          emit(live, { type: "notice", level: "warning", message: event.message });
        } else {
          emit(live, { type: "error", message: event.message });
        }
        break;
      case "result":
        live.busy = false;
        if (event.status === "error" && event.error !== null) {
          emit(live, { type: "error", message: `这一轮出错了：${event.error}` });
        }
        emitState(live);
        void refreshStats(live);
        break;
      case "ui":
        // `--no-ui` 下扩展是 headless，正常不会来；真来了也没人能答 —— 一律取消，别让会话挂住。
        live.session.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        emit(live, {
          type: "notice",
          level: "warning",
          message: `收到 UI 请求 ${event.method}，headless 下无人应答，已自动取消`,
        });
        break;
      case "exit":
        handleExit(live);
        break;
      default:
        // ready/response/thinking/turn/agent/queue/command_output/other/settled：不进网页也不落库。
        break;
    }
  };

  const sessionEnv = (cardId: string): NodeJS.ProcessEnv => {
    const base = deps.baseUrl ?? `http://${process.env.FLOWCARD_HOST ?? "127.0.0.1"}:${process.env.FLOWCARD_PORT ?? "47825"}`;
    const env: NodeJS.ProcessEnv = { ...process.env, FLOWCARD_CARD: cardId, FLOWCARD_URL: base };
    if (deps.logDir !== undefined) env["FLOWCARD_OMP_LOG"] = `${deps.logDir}/omp-${cardId}.log`;
    return { ...env, ...(deps.env ?? {}) };
  };

  /** 起好后：等 ready → 拿身份 → claim → 发 `ready` → 发开工提示。全程不抛。 */
  const bringUp = async (live: Live, opts: StartSessionOptions): Promise<void> => {
    const ready = await live.session.ready;
    if (records.get(live.cardId) !== live) return;
    if (!ready.ok) {
      // 起不来（早退/超时/spawn 失败）：状态落 `failed`，把原因说清楚，并把这个没用的子进程收掉。
      live.status = "failed";
      const tail = ready.stderr.trim();
      emit(live, {
        type: "error",
        message: `omp 没起来（${ready.reason}）：${ready.message}${tail === "" ? "" : `｜stderr: ${tail.split("\n")[0] ?? ""}`}`,
      });
      emitState(live);
      if (!live.exited) void live.session.stop().catch(() => undefined);
      return;
    }
    if (live.exited) return;
    live.readyOk = true;
    live.session.setEventFilter(null, "delta");
    await identify(live);
    if (records.get(live.cardId) !== live || live.exited) return;
    live.status = "running";
    live.lastActivityAt = now();
    emit(live, {
      type: "ready",
      ...(live.ompSessionId === null ? {} : { ompSessionId: live.ompSessionId }),
      cwd: live.cwd,
    });
    emitState(live);
    if (opts.kickoff !== undefined && opts.kickoff !== "") {
      const sent = await prompt(live.cardId, opts.kickoff);
      if (!sent.ok && records.get(live.cardId) === live && !live.exited) {
        emit(live, { type: "error", message: `开工提示没发出去：${sent.error?.message ?? "未知原因"}` });
      }
    }
  };

  const resolveOmpPathOnce = async (): Promise<string | undefined> => {
    if (deps.ompPath !== undefined) return deps.ompPath;
    if (ompPathCache === undefined) {
      ompPathCache = (await findOmpPath().catch(() => undefined)) ?? null;
    }
    return ompPathCache ?? undefined;
  };

  const start = async (cardId: string, opts: StartSessionOptions = {}): Promise<StartSessionResult> => {
    const card = store.getCard(cardId);
    if (!card) {
      return { ok: false, status: "stopped", error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } };
    }
    const existing = records.get(cardId);
    if (existing && (existing.status === "starting" || existing.status === "running")) {
      return {
        ok: true,
        status: existing.status,
        ...(existing.ompSessionId === null ? {} : { ompSessionId: existing.ompSessionId }),
        cwd: existing.cwd,
      };
    }
    if (existing) existing.off(); // 旧记录只留状态与转录

    const cwd = opts.cwd ?? defaultCwd(cardId);
    if (cwd === undefined || cwd === "") {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "NO_CWD",
          message: `卡片 ${cardId} 既没绑 worktree，也不属于任何真实项目：没有会话的工作目录`,
        },
      };
    }
    if (!existsSync(cwd)) {
      return {
        ok: false,
        status: "failed",
        error: { code: "NO_CWD", message: `会话的工作目录不存在：${cwd}` },
      };
    }

    const ompPath = await resolveOmpPathOnce();
    const args = [
      ...(deps.args ?? ["--no-title"]),
      ...(deps.adapterPath === undefined ? [] : ["-e", deps.adapterPath]),
      // brief 可能是正文，也可能是落盘后的路径（超大提示走路径，见 briefPromptArg）
      ...(opts.brief === undefined ? [] : ["--append-system-prompt", briefPromptArg(opts.brief, cardId)]),
      ...(opts.args ?? []),
    ];
    const session = startSession({
      cwd,
      ...(ompPath === undefined ? {} : { ompPath }),
      args,
      env: sessionEnv(cardId),
      ...(deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs }),
    });

    const live: Live = {
      cardId,
      cwd,
      tag: randomUUID().slice(0, 8),
      session,
      startedAt: now(),
      lastActivityAt: now(),
      status: "starting",
      ompSessionId: null,
      cost: null,
      busy: false,
      claimed: false,
      exited: false,
      readyOk: false,
      promptSeq: 0,
      seenAt: new Map(),
      off: () => undefined,
    };
    records.set(cardId, live);
    live.off = session.on((event) => handle(live, event));
    emitState(live);
    void bringUp(live, opts);

    return { ok: true, status: "starting", cwd };
  };

  const prompt = async (
    cardId: string,
    text: string,
    images: readonly SessionImage[] = [],
  ): Promise<PromptResult> => {
    const live = records.get(cardId);
    if (!live || live.exited) {
      return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 没有在跑的会话` } };
    }
    // 起会话的流程还在跑就先等它：命令早于 ready 会被 omp 丢掉（ready 永不 reject）。
    if (live.status === "starting") {
      const outcome = await live.session.ready;
      if (!outcome.ok) {
        return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 的会话没起来` } };
      }
    }
    if (records.get(cardId) !== live || live.exited || live.status === "failed") {
      return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 的会话没起来` } };
    }
    const id = `${live.tag}:p${++live.promptSeq}`;
    const sent = live.session.send({
      id,
      type: "prompt",
      message: text,
      ...(images.length === 0 ? {} : { images: images.map(ompImage) }),
    });
    if (!sent) {
      return { ok: false, error: { code: "SEND_FAILED", message: "命令没写进 omp 的 stdin" } };
    }
    const at = now();
    persist(live, { id, role: "user", at, text });
    live.busy = true;
    live.lastActivityAt = at;
    emit(live, { type: "message_end", id, role: "user", text, at });
    emitState(live);
    return { ok: true, messageId: id };
  };

  const abort = async (cardId: string): Promise<SimpleResult> => {
    const live = records.get(cardId);
    if (!live || live.exited) {
      return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 没有在跑的会话` } };
    }
    if (!live.session.abort()) {
      return { ok: false, error: { code: "SEND_FAILED", message: "中断命令没写进 omp 的 stdin" } };
    }
    return { ok: true };
  };

  const stop = async (cardId: string): Promise<SimpleResult> => {
    const live = records.get(cardId);
    if (!live) return { ok: true };
    // 关 stdin → omp 自己收尾退出 → exit 事件里发 `end`；幂等（已经退了就直接返回）。
    await live.session.stop();
    return { ok: true };
  };

  const snapshot = (cardId: string): SessionSnapshot => {
    const messages: SessionMessage[] = store.listSessionMessages(cardId).map((row) => ({
      id: row.messageId,
      role: row.role,
      at: row.at,
      ...(row.text === undefined ? {} : { text: row.text }),
      ...(row.tool === undefined ? {} : { tool: row.tool }),
    }));
    const live = records.get(cardId);
    if (!live) {
      // 本进程没起过（比如重启过）：有转录就是「已结束」，没有就是「没起过」。
      return {
        status: messages.length === 0 ? "stopped" : "ended",
        cwd: defaultCwd(cardId) ?? "",
        busy: false,
        messages,
      };
    }
    return {
      status: live.status,
      ...(live.ompSessionId === null ? {} : { ompSessionId: live.ompSessionId }),
      cwd: live.cwd,
      startedAt: live.startedAt,
      lastActivityAt: live.lastActivityAt,
      busy: live.busy,
      ...(live.cost === null ? {} : { cost: live.cost }),
      messages,
    };
  };

  const subscribe = (cardId: string, listener: (event: SessionEvent) => void): (() => void) => {
    let set = listeners.get(cardId);
    if (set === undefined) {
      set = new Set();
      listeners.set(cardId, set);
    }
    set.add(listener);
    // 连上就先给现况（历史走 `GET .../session`），前端一幅画面都不用等。
    const current = snapshot(cardId);
    deliver(listener, {
      type: "ready",
      ...(current.ompSessionId === undefined ? {} : { ompSessionId: current.ompSessionId }),
      cwd: current.cwd,
    });
    deliver(listener, {
      type: "state",
      busy: current.busy,
      status: current.status,
      ...(current.cost === undefined ? {} : { cost: current.cost }),
    });
    return () => {
      set.delete(listener);
    };
  };

  const isLive = (cardId: string): boolean => {
    const live = records.get(cardId);
    return live !== undefined && !live.exited && (live.status === "starting" || live.status === "running");
  };

  return {
    start,
    prompt,
    abort,
    stop,
    async stopAll() {
      await Promise.all([...records.values()].map((live) => live.session.stop().catch(() => undefined)));
    },
    snapshot,
    subscribe,
    onCard(listener) {
      cardListeners.add(listener);
      return () => {
        cardListeners.delete(listener);
      };
    },
    isLive,
    liveCardIds: () => [...records.values()].filter((live) => !live.exited).map((live) => live.cardId),
    resolveCwd: (cardId) => records.get(cardId)?.cwd ?? defaultCwd(cardId),
  };
}
