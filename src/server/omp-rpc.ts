/**
 * omp RPC 会话：flowcard 自己托管 `omp --mode rpc --no-ui` 子进程，
 * 让网页直接看对话与终端输出，而不是弹一个 konsole。
 *
 * 分层（跟 `src/server/probe.ts` 同一范式）：
 *   1. **纯函数**：`parseFrame(line)` 一行 stdout → 类型化帧；`classifyFrame` 定帧类；
 *      `FrameNormalizer` 把帧折成 flowcard 侧的简化事件（`OmpEvent`）并拼纯文本；
 *      `rpcArgv` 拼 omp 的 argv。全部可单测，不碰进程。
 *   2. **薄 IO**：`startRpcSession({cwd, ompPath, env, args})` 只负责 spawn、按行切 stdout、
 *      把帧喂给 `FrameNormalizer`、把事件分发给订阅者。`spawn` 可注入（测试里塞假 omp）。
 *
 * 契约（全部抄自 omp 18.8.7 源码，见 `docs/omp-rpc.md`）：
 *   - 命令是 stdin 上的 JSONL；响应与事件是 stdout 上的 JSONL（**stderr 不是协议通道**）。
 *   - 启动后第一帧永远是 `{type:"ready"}`；不 negotiate 就是 protocol v1（不会有 `rpc_chunk`）。
 *   - `prompt` 的 `response` 只是「收下了」，真正的终局是 `prompt_result`（**必须用同一个 `id` 关联**）。
 *   - stdin 关闭（EOF）→ omp 优雅收尾并退出，所以 `stop()` 先关 stdin 再谈信号。
 *
 * 不抛：omp 崩了 / 输出乱码 / 管道断了，一律变成事件（`error` / `exit`），
 * `startRpcSession` 同步返回句柄，失败通过 `handle.ready` 与事件流表达。
 */
import { spawn } from "node:child_process";

/** 单行 stdout 的上限（协议帧上限 1 MiB；留足余量，超了当作协议损坏）。 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Node ≥22 有 `Promise.withResolvers`（ES2024），但本仓 tsconfig 的 `lib` 是 ES2023
 * ——补个类型收窄（与 `probe.ts` 同一写法）。
 */
const promiseLib = Promise as unknown as {
  withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
};

/** 等 `ready` 帧的默认上限。 */
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** `stop()` 关 stdin 之后等进程自己退的默认宽限。 */
export const DEFAULT_STOP_GRACE_MS = 2_000;
/** 发 SIGTERM 之后等进程退的默认宽限，再超就 SIGKILL。 */
export const DEFAULT_KILL_GRACE_MS = 2_000;

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

function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

// ---------------------------------------------------------------- argv（纯）

/**
 * omp 的 RPC argv。`--cwd` 是 omp 自己的旗标（覆盖「启动目录」），必须显式给：
 * flowcard 的 cwd 是卡片的 worktree，不能赌子进程继承的 cwd。
 */
export function rpcArgv(opts: { cwd: string; args?: readonly string[] }): string[] {
  return ["--mode", "rpc", "--no-ui", "--cwd", opts.cwd, ...(opts.args ?? [])];
}

// ---------------------------------------------------------------- 帧（纯）

/**
 * 会在 stdout 上出现的会话事件类型（`AgentEvent` ∪ `AgentSessionEvent`，
 * 抄自 pi-agent-core `types.ts` / pi-coding-agent `session/agent-session-events.ts`）。
 * 不认识的类型归 `unknown`，归一化时**静默丢弃并计数**，绝不抛。
 * 协议帧（`ready`/`response`/`prompt_result`/`rpc_chunk`/`host_*`…）**不在**这张表里，
 * 由 `classifyFrame` 的 switch 单独处理。
 */
export const SESSION_EVENT_TYPES: Readonly<Record<string, true>> = {
  // AgentEvent
  agent_start: true,
  agent_end: true,
  turn_start: true,
  turn_end: true,
  message_start: true,
  message_update: true,
  message_end: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_stream_update: true,
  tool_execution_end: true,
  // AgentSessionEvent 追加
  auto_compaction_start: true,
  auto_compaction_end: true,
  auto_retry_start: true,
  auto_retry_end: true,
  cache_warming_start: true,
  cache_warming_end: true,
  retry_fallback_applied: true,
  retry_fallback_succeeded: true,
  model_changed: true,
  config_warnings_changed: true,
  advisor_cost_changed: true,
  advisor_yielded: true,
  ttsr_triggered: true,
  todo_reminder: true,
  todo_auto_clear: true,
  irc_message: true,
  notice: true,
  thinking_level_changed: true,
  goal_updated: true,
  queue_update: true,
};

/** `prompt_result.status`；omp 侧的 `RpcPromptStatus`。 */
export type PromptStatus = "completed" | "aborted" | "error";

export type FrameOf<Kind extends string, Extra extends object = object> = { kind: Kind } & Extra;

export type OmpFrame =
  | FrameOf<
      "ready",
      {
        protocolVersion: number | null;
        supportedProtocolVersions: number[];
        maxFrameBytes: number | null;
        maxReassembledFrameBytes: number | null;
      }
    >
  | FrameOf<"response", { id: string | null; command: string; data: unknown }>
  | FrameOf<"response_error", { id: string | null; command: string; error: string; code: string | null }>
  | FrameOf<"session_event", { type: string; raw: Record<string, unknown> }>
  | FrameOf<
      "prompt_result",
      {
        id: string | null;
        agentInvoked: boolean;
        status: PromptStatus;
        error: { message: string; provider: string | null; model: string | null; httpStatus: number | null; retryable: boolean } | null;
        sessionSettled: boolean;
      }
    >
  | FrameOf<"session_settled", object>
  | FrameOf<"command_output", { text: string }>
  | FrameOf<"commands_update", { commands: unknown }>
  | FrameOf<"frame_error", { error: string; originalType: string | null }>
  | FrameOf<"extension_error", { extensionPath: string | null; event: string | null; error: string }>
  | FrameOf<"ui_request", { id: string; method: string; raw: Record<string, unknown> }>
  | FrameOf<"unknown", { type: string | null; raw: Record<string, unknown> }>;

/** 把一行 stdout 解析成 JSON 对象；空行/乱码/非对象 → null。 */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const text = line.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return asRecord(parsed);
}

/**
 * 一行 stdout → 类型化帧。**乱码与空行返回 null**（调用方丢弃），
 * 认不出的 JSON 对象返回 `{kind:"unknown"}`（同样可安全忽略）。
 */
export function parseFrame(line: string): OmpFrame | null {
  const frame = parseJsonLine(line);
  return frame === null ? null : classifyFrame(frame);
}

/** 已解析的 JSON 对象 → 类型化帧。纯函数，不抛。 */
export function classifyFrame(frame: Record<string, unknown>): OmpFrame {
  const type = asString(frame["type"]) ?? "";
  switch (type) {
    case "ready": {
      const supported = frame["supportedProtocolVersions"];
      return {
        kind: "ready",
        protocolVersion: asNumber(frame["protocolVersion"]),
        supportedProtocolVersions:
          Array.isArray(supported) && supported.every((v) => typeof v === "number") ? (supported as number[]) : [],
        maxFrameBytes: asNumber(frame["maxFrameBytes"]),
        maxReassembledFrameBytes: asNumber(frame["maxReassembledFrameBytes"]),
      };
    }
    case "response": {
      const id = asString(frame["id"]);
      const command = asString(frame["command"]) ?? "unknown";
      if (frame["success"] === false) {
        return {
          kind: "response_error",
          id,
          command,
          error: asString(frame["error"]) ?? "unknown error",
          code: asString(frame["code"]),
        };
      }
      return { kind: "response", id, command, data: frame["data"] };
    }
    case "prompt_result": {
      const raw = asRecord(frame["error"]);
      const status = frame["status"];
      const err =
        raw === null
          ? null
          : {
              message: asString(raw["message"]) ?? "unknown error",
              provider: asString(raw["provider"]),
              model: asString(raw["model"]),
              httpStatus: asNumber(raw["httpStatus"]),
              retryable: raw["retryable"] === true,
            };
      return {
        kind: "prompt_result",
        id: asString(frame["id"]),
        agentInvoked: frame["agentInvoked"] === true,
        status: status === "aborted" || status === "error" ? status : "completed",
        error: err,
        sessionSettled: frame["sessionSettled"] === true,
      };
    }
    case "session_settled":
      return { kind: "session_settled" };
    case "command_output":
      return { kind: "command_output", text: asString(frame["text"]) ?? "" };
    case "available_commands_update":
      return { kind: "commands_update", commands: frame["commands"] };
    case "rpc_frame_error":
      return {
        kind: "frame_error",
        error: asString(frame["error"]) ?? "RPC frame error",
        originalType: asString(frame["originalType"]),
      };
    case "extension_error":
      return {
        kind: "extension_error",
        extensionPath: asString(frame["extensionPath"]),
        event: asString(frame["event"]),
        error: asString(frame["error"]) ?? "extension error",
      };
    case "extension_ui_request":
      return {
        kind: "ui_request",
        id: asString(frame["id"]) ?? "",
        method: asString(frame["method"]) ?? "unknown",
        raw: frame,
      };
    default:
      break;
  }
  if (SESSION_EVENT_TYPES[type] === true) return { kind: "session_event", type, raw: frame };
  return { kind: "unknown", type: type === "" ? null : type, raw: frame };
}

// ---------------------------------------------------------------- 简化事件（flowcard 侧）

/**
 * flowcard 侧的简化事件。`kind` 的划分与映射见 `docs/omp-rpc.md` §4。
 * 只有 `text` / `thinking` / `tool` / `turn` / `result` / `settled` / `error` 是核心，
 * 其余（`ready` / `response` / `message*` / `agent` / `notice` / `queue` / `command_output` /
 * `ui` / `other` / `exit`）都是为了让调用方**不丢信息**而保留的。
 */
export type OmpEvent =
  | { kind: "ready"; protocolVersion: number | null; supportedProtocolVersions: number[]; maxFrameBytes: number | null }
  | { kind: "response"; command: string; id: string | null; data: unknown }
  | { kind: "text"; messageId: string; contentIndex: number | null; delta: string }
  | { kind: "text_end"; messageId: string; contentIndex: number | null; text: string }
  | { kind: "thinking"; messageId: string; contentIndex: number | null; delta: string }
  | { kind: "thinking_end"; messageId: string; contentIndex: number | null; text: string }
  | { kind: "toolcall"; phase: "start" | "delta" | "end"; messageId: string; contentIndex: number | null; toolName: string | null; toolCallId: string | null }
  | { kind: "message"; phase: "start" | "end"; messageId: string; role: string; text: string | null; stopReason: string | null }
  | {
      kind: "tool";
      phase: "start" | "update" | "end";
      toolCallId: string;
      toolName: string;
      args: unknown;
      intent: string | null;
      result: unknown;
      isError: boolean | null;
    }
  | { kind: "turn"; phase: "start" | "end"; toolResults: unknown }
  | { kind: "agent"; phase: "start" | "end" }
  | { kind: "notice"; level: string; message: string; source: string | null }
  | { kind: "queue"; steering: string[]; followUp: string[] }
  | { kind: "command_output"; text: string }
  | { kind: "ui"; id: string; method: string; request: Record<string, unknown> }
  | { kind: "other"; type: string; raw: Record<string, unknown> }
  | {
      kind: "result";
      id: string | null;
      agentInvoked: boolean;
      status: PromptStatus;
      error: string | null;
      retryable: boolean;
      sessionSettled: boolean;
    }
  | { kind: "settled" }
  | {
      kind: "error";
      scope: "command" | "prompt" | "spawn" | "io" | "protocol";
      message: string;
      code: string | null;
      /** 命令出错时的关联字段（`response{success:false}` 带回的 `id`/`command`）。 */
      id: string | null;
      command: string | null;
    }
  | { kind: "exit"; code: number | null; signal: string | null };

/**
 * 帧 → 简化事件，并负责**拼纯文本**。
 *
 * 拼法（见 docs §5）：以 `message_update.messageId` 为键，按 `contentIndex` 分块累计
 * `text_delta`；`text_end.content` 到了就用它**覆盖**该块（权威值）；`message_end.message`
 * 里的 text 块同样覆盖。`messageId` 由 omp 盖（`msg-1`、`msg-2`…），**跨 messageId 绝不合并**。
 *
 * `set_event_filter({messageUpdates:"delta"})` 之后 `message_update.message` 只剩 `{role}`，
 * 本类只读 `assistantMessageEvent`，两种投影都吃。
 */
export class FrameNormalizer {
  #blocks = new Map<string, Map<number, string>>();
  #dropped = 0;

  /** 被静默丢弃的帧数（未知类型 / 只带 `{role}` 的空快照）。观测用，不是错误。 */
  get dropped(): number {
    return this.#dropped;
  }

  /** 清掉累计文本（`new_session` / `switch_session` 之后必须调）。 */
  reset(): void {
    this.#blocks.clear();
  }

  /** 某个 messageId 已拼好的纯文本；该消息还没吐过文本 → null。 */
  textFor(messageId: string): string | null {
    const blocks = this.#blocks.get(messageId);
    if (blocks === undefined || blocks.size === 0) return null;
    return [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join("");
  }

  /** 所有已见过文本的 messageId（按首次出现顺序）。 */
  messageIds(): string[] {
    return [...this.#blocks.keys()];
  }

  push(frame: OmpFrame): OmpEvent[] {
    switch (frame.kind) {
      case "session_event":
        return this.#sessionEvent(frame.type, frame.raw);
      case "ready":
        return [
          {
            kind: "ready",
            protocolVersion: frame.protocolVersion,
            supportedProtocolVersions: frame.supportedProtocolVersions,
            maxFrameBytes: frame.maxFrameBytes,
          },
        ];
      case "response":
        return [{ kind: "response", command: frame.command, id: frame.id, data: frame.data }];
      case "response_error":
        return [
          {
            kind: "error",
            scope: "command",
            message: `${frame.command}: ${frame.error}`,
            code: frame.code,
            id: frame.id,
            command: frame.command,
          },
        ];
      case "prompt_result":
        return [
          {
            kind: "result",
            id: frame.id,
            agentInvoked: frame.agentInvoked,
            status: frame.status,
            error: frame.error?.message ?? null,
            retryable: frame.error?.retryable ?? false,
            sessionSettled: frame.sessionSettled,
          },
        ];
      case "session_settled":
        return [{ kind: "settled" }];
      case "command_output":
        return [{ kind: "command_output", text: frame.text }];
      case "frame_error":
        return [
          {
            kind: "error",
            scope: "protocol",
            message: frame.error,
            code: frame.originalType,
            id: null,
            command: null,
          },
        ];
      case "extension_error":
        return [
          {
            kind: "notice",
            level: "error",
            message: `${frame.extensionPath ?? "extension"} ${frame.event ?? ""}: ${frame.error}`.trim(),
            source: "extension",
          },
        ];
      case "ui_request":
        return [{ kind: "ui", id: frame.id, method: frame.method, request: frame.raw }];
      default:
        // commands_update（斜杠命令全表，flowcard 不用）/ rpc_chunk（v2 才可能，我们不 negotiate）/
        // host_*（我们从不 set_host_tools）/ 未知类型 —— 安全忽略并计数。
        this.#dropped += 1;
        return [];
    }
  }

  #sessionEvent(type: string, raw: Record<string, unknown>): OmpEvent[] {
    switch (type) {
      case "message_update":
        return this.#messageUpdate(raw);
      case "message_start": {
        const messageId = asString(raw["messageId"]) ?? "msg-?";
        const message = asRecord(raw["message"]);
        return [
          {
            kind: "message",
            phase: "start",
            messageId,
            role: asString(message?.["role"]) ?? "unknown",
            text: null,
            stopReason: null,
          },
        ];
      }
      case "message_end": {
        const messageId = asString(raw["messageId"]) ?? "msg-?";
        const message = asRecord(raw["message"]);
        const text = textFromMessage(message);
        if (text !== null) this.#setBlock(messageId, 0, text);
        return [
          {
            kind: "message",
            phase: "end",
            messageId,
            role: asString(message?.["role"]) ?? "unknown",
            text: text ?? this.textFor(messageId),
            stopReason: asString(message?.["stopReason"]),
          },
        ];
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const phase = type === "tool_execution_start" ? "start" : type === "tool_execution_update" ? "update" : "end";
        return [
          {
            kind: "tool",
            phase,
            toolCallId: asString(raw["toolCallId"]) ?? "",
            toolName: asString(raw["toolName"]) ?? "unknown",
            args: raw["args"],
            intent: asString(raw["intent"]),
            result: raw["result"] ?? raw["partialResult"],
            isError: asBool(raw["isError"]),
          },
        ];
      }
      case "turn_start":
        return [{ kind: "turn", phase: "start", toolResults: undefined }];
      case "turn_end":
        return [{ kind: "turn", phase: "end", toolResults: raw["toolResults"] }];
      case "agent_start":
        return [{ kind: "agent", phase: "start" }];
      case "agent_end":
        return [{ kind: "agent", phase: "end" }];
      case "notice":
        return [
          {
            kind: "notice",
            level: asString(raw["level"]) ?? "info",
            message: asString(raw["message"]) ?? "",
            source: asString(raw["source"]),
          },
        ];
      case "queue_update":
        return [
          {
            kind: "queue",
            steering: asStringArray(raw["steering"]) ?? [],
            followUp: asStringArray(raw["followUp"]) ?? [],
          },
        ];
      default:
        return [{ kind: "other", type, raw }];
    }
  }

  #messageUpdate(raw: Record<string, unknown>): OmpEvent[] {
    const messageId = asString(raw["messageId"]) ?? "msg-?";
    const ev = asRecord(raw["assistantMessageEvent"]);
    if (ev === null) {
      // 投影成 delta 时 message 只剩 {role}；没有 assistantMessageEvent 的更新帧没内容可拼。
      this.#dropped += 1;
      return [];
    }
    const type = asString(ev["type"]) ?? "";
    const contentIndex = asNumber(ev["contentIndex"]);
    switch (type) {
      case "text_delta": {
        const delta = asString(ev["delta"]) ?? "";
        this.#append(messageId, contentIndex ?? 0, delta);
        return [{ kind: "text", messageId, contentIndex, delta }];
      }
      case "text_end": {
        const text = asString(ev["content"]) ?? this.#block(messageId, contentIndex ?? 0);
        this.#setBlock(messageId, contentIndex ?? 0, text);
        return [{ kind: "text_end", messageId, contentIndex, text }];
      }
      case "thinking_delta": {
        const delta = asString(ev["delta"]) ?? "";
        return [{ kind: "thinking", messageId, contentIndex, delta }];
      }
      case "thinking_end":
        return [{ kind: "thinking_end", messageId, contentIndex, text: asString(ev["content"]) ?? "" }];
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end": {
        const phase = type === "toolcall_start" ? "start" : type === "toolcall_delta" ? "delta" : "end";
        const call = asRecord(ev["toolCall"]);
        return [
          {
            kind: "toolcall",
            phase,
            messageId,
            contentIndex,
            toolName: asString(call?.["name"]),
            toolCallId: asString(call?.["id"]),
          },
        ];
      }
      case "done":
      case "error":
      case "start":
      case "text_start":
      case "thinking_start":
      case "image_end":
        return [{ kind: "other", type: `message_update.${type}`, raw: ev }];
      default:
        return [{ kind: "other", type: `message_update.${type || "?"}`, raw: ev }];
    }
  }

  #block(messageId: string, contentIndex: number): string {
    return this.#blocks.get(messageId)?.get(contentIndex) ?? "";
  }

  #append(messageId: string, contentIndex: number, delta: string): void {
    this.#setBlock(messageId, contentIndex, this.#block(messageId, contentIndex) + delta);
  }

  #setBlock(messageId: string, contentIndex: number, text: string): void {
    let blocks = this.#blocks.get(messageId);
    if (blocks === undefined) {
      blocks = new Map<number, string>();
      this.#blocks.set(messageId, blocks);
    }
    blocks.set(contentIndex, text);
  }
}

/** 从完整 `AgentMessage` 里取 assistant 的纯文本（text 块按顺序拼接）；取不到 → null。 */
export function textFromMessage(message: Record<string, unknown> | null): string | null {
  if (message === null) return null;
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const rec = asRecord(block);
    if (rec === null) continue;
    if (rec["type"] === "text") {
      const text = asString(rec["text"]);
      if (text !== null) parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

// ---------------------------------------------------------------- 子进程 IO（可注入）

export type SpawnOptions = {
  cwd?: string;
  env: NodeJS.ProcessEnv;
};

/**
 * `startRpcSession` 需要的子进程能力（结构类型，`ChildProcess` 天然满足）。
 * 测试可以塞任何符合这个形状的对象。
 */
export type SpawnedProcess = {
  readonly pid?: number;
  stdout: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stdin: {
    write(data: string): unknown;
    end(): unknown;
    /** 管道断了（子进程没了 / EPIPE）是**异步** `error` 事件：不挂监听器会变成未捕获异常。 */
    on?(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
};

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => SpawnedProcess;

/** 默认执行器：`spawn`（不经过 shell），三条管道，只关掉交互式提示与颜色。 */
export function defaultSpawn(file: string, args: string[], options: SpawnOptions): SpawnedProcess {
  const child = spawn(file, args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options.env, NO_COLOR: "1", PI_NOTIFICATIONS: "off" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child as unknown as SpawnedProcess;
}

// ---------------------------------------------------------------- 会话

/** 发出去的 omp 命令（stdin JSONL）。字段以 omp 的 `RpcCommand` 为准。 */
export type RpcCommandInput = { type: string } & Record<string, unknown>;

export type ReadyOutcome =
  | {
      ok: true;
      protocolVersion: number | null;
      supportedProtocolVersions: number[];
      maxFrameBytes: number | null;
      /** 等 `ready` 花了多久（真机诊断用）。 */
      ms: number;
    }
  | { ok: false; reason: "exit" | "error" | "timeout"; message: string; stderr: string };

export type StopOutcome = { code: number | null; signal: string | null; forced: boolean };

export type RequestOutcome<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; reason: "error" | "timeout" | "exited"; message: string; code?: string };

export type OmpRpcSession = {
  readonly pid: number | null;
  /** 等到 `ready` 帧（或早退/超时）；**永不 reject**。 */
  readonly ready: Promise<ReadyOutcome>;
  /** 订阅简化事件；返回退订函数。 */
  on(listener: (event: OmpEvent) => void): () => void;
  /** 发一条命令；已退出/写失败 → false（并补一个 `error` 事件）。 */
  send(command: RpcCommandInput): boolean;
  /** 发 prompt，返回自己生成的 `id`（用来跟 `result` 对齐）。 */
  prompt(message: string, opts?: { images?: readonly unknown[]; id?: string; streamingBehavior?: "steer" | "followUp" }): string;
  /** 中断当前 run；omp 仍会吐完事件并以 `result{status:"aborted"}` 收尾。 */
  abort(): boolean;
  /** 开新会话（浅层 `/clear`）；之后必须重新 `get_state` 拿新的 sessionId。 */
  newSession(): boolean;
  getState(): boolean;
  getSessionStats(): boolean;
  /** 请求一次快照（`get_state` / `get_session_stats` …），按 `id` 关联响应；**永不 reject**。 */
  request<T = unknown>(command: RpcCommandInput, opts?: { timeoutMs?: number; id?: string }): Promise<RequestOutcome<T>>;
  /** 推荐的第一次调用：`set_event_filter({events:null, messageUpdates:"delta"})` 压小 message_update 帧。 */
  setEventFilter(events: readonly string[] | null, messageUpdates?: "full" | "delta"): boolean;
  /** stderr 尾巴（最多 `stderrTailBytes`），诊断用；stderr 不是协议通道。 */
  stderrTail(): string;
  /** 某个 messageId 已拼好的纯文本；还没见过 → null。 */
  textFor(messageId: string): string | null;
  stats(): { droppedFrames: number; receivedFrames: number; badLines: number };
  /** 优雅停：关 stdin（→ omp 自己收尾退出）→ 宽限 → SIGTERM → 宽限 → SIGKILL。幂等，不抛。 */
  stop(opts?: { graceMs?: number; killGraceMs?: number }): Promise<StopOutcome>;
};

export type StartRpcOptions = {
  /** 会话工作目录 = 卡片的 worktree。必填（`--cwd` 也用它）。 */
  cwd: string;
  /** omp 可执行文件；默认 `"omp"`（交给 PATH，调用方可用 `resolveOmpPath()` 传绝对路径）。 */
  ompPath?: string;
  /** 追加到默认 argv 之后的参数（如 `--no-title`、`--model`）。 */
  args?: readonly string[];
  /**
   * **整串 argv 覆盖**默认的 `rpcArgv()`。给测试与自定义启动器用（比如换成
   * `node -e <假 omp 脚本>`）；生产接线不该用它。
   */
  argv?: readonly string[];
  /** 子进程环境；默认继承 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
  readyTimeoutMs?: number;
  /** 保留多少字节的 stderr 尾巴。 */
  stderrTailBytes?: number;
};

/**
 * 起一个托管会话。**同步返回句柄**（不 await）：`ready` 是 promise，
 * spawn 失败（如 omp 未安装）会变成 `ready:{ok:false}` + `error`/`exit` 事件。
 */
export function startRpcSession(opts: StartRpcOptions): OmpRpcSession {
  const doSpawn = opts.spawn ?? defaultSpawn;
  const argv: string[] =
    opts.argv === undefined
      ? rpcArgv({ cwd: opts.cwd, ...(opts.args === undefined ? {} : { args: opts.args }) })
      : [...opts.argv];
  const env = opts.env ?? process.env;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const stderrCap = opts.stderrTailBytes ?? 4 * 1024;

  const normalizer = new FrameNormalizer();
  const listeners = new Set<(event: OmpEvent) => void>();
  let stderr = "";
  let receivedFrames = 0;
  let badLines = 0;
  let exited = false;
  let stopping = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let forceKilled = false;
  let seq = 0;
  let stdoutBuf = "";
  const pending = new Map<string, (outcome: RequestOutcome) => void>();

  const exitGate = promiseLib.withResolvers<StopOutcome>();
  const exitPromise = exitGate.promise;
  const readyGate = promiseLib.withResolvers<ReadyOutcome>();
  const readyPromise = readyGate.promise;
  let readyTimer: NodeJS.Timeout | undefined;
  let readySettled = false;
  const startedAt = Date.now();

  const emit = (event: OmpEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者自己抛错不能拖垮会话；这条消息只服务协议，不影响子进程。
      }
    }
  };

  let child: SpawnedProcess | null = null;
  let spawnFailure: string | null = null;
  try {
    child = doSpawn(opts.ompPath ?? "omp", argv, { cwd: opts.cwd, env });
  } catch (error) {
    // spawn 同步抛（理论上很少见）→ 也变成事件。
    spawnFailure = error instanceof Error ? error.message : String(error);
  }

  const pid = child?.pid ?? null;

  const settleReady = (outcome: ReadyOutcome): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    readyGate.resolve(outcome);
  };

  readyTimer = setTimeout(() => {
    settleReady({ ok: false, reason: "timeout", message: `no ready frame in ${readyTimeoutMs}ms`, stderr });
  }, readyTimeoutMs);
  readyTimer.unref?.();

  const finish = (): void => {
    if (exited) return;
    exited = true;
    clearTimeout(readyTimer);
    clearTimeout(closeTimer);
    settleReady({ ok: false, reason: "exit", message: `omp exited before ready (code=${exitCode})`, stderr });
    for (const resolve of pending.values()) {
      resolve({ ok: false, reason: "exited", message: `omp exited (code=${exitCode})` });
    }
    pending.clear();
    emit({ kind: "exit", code: exitCode, signal: exitSignal });
    exitGate.resolve({ code: exitCode, signal: exitSignal, forced: forceKilled });
  };

  let closeTimer: NodeJS.Timeout | undefined;

  const pushLine = (line: string): void => {
    if (exited) return;
    if (line.trim() === "") return;
    const frame = parseFrame(line);
    if (frame === null) {
      badLines += 1;
      return;
    }
    receivedFrames += 1;
    if (frame.kind === "ready") {
      settleReady({
        ok: true,
        protocolVersion: frame.protocolVersion,
        supportedProtocolVersions: frame.supportedProtocolVersions,
        maxFrameBytes: frame.maxFrameBytes,
        ms: Date.now() - startedAt,
      });
    }
    const events = normalizer.push(frame);
    for (const event of events) {
      if (event.kind === "response" || event.kind === "error") {
        const id = event.id;
        const resolve = id === null ? undefined : pending.get(id);
        if (id !== null && resolve !== undefined) {
          pending.delete(id);
          resolve(
            event.kind === "response"
              ? { ok: true, data: event.data }
              : { ok: false, reason: "error", message: event.message, ...(event.code === null ? {} : { code: event.code }) },
          );
        }
      }
      emit(event);
    }
  };

  const onStdoutData = (chunk: unknown): void => {
    if (exited) return;
    stdoutBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    if (Buffer.byteLength(stdoutBuf, "utf8") > MAX_LINE_BYTES && !stdoutBuf.includes("\n")) {
      // 单行超限：协议坏了，丢掉这半行并报一次（不清空整个流）。
      stdoutBuf = "";
      badLines += 1;
      emit({ kind: "error", scope: "protocol", message: `stdout line exceeded ${MAX_LINE_BYTES} bytes`, code: null, id: null, command: null });
      return;
    }
    let index = stdoutBuf.indexOf("\n");
    while (index >= 0) {
      const line = stdoutBuf.slice(0, index);
      stdoutBuf = stdoutBuf.slice(index + 1);
      pushLine(line);
      index = stdoutBuf.indexOf("\n");
    }
  };

  child?.stdout?.on("data", onStdoutData);
  child?.stderr?.on("data", (chunk: unknown) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array);
    stderr = (stderr + text).slice(-stderrCap);
  });
  // 子进程没了之后往它的 stdin 写会拿到 **异步** 的 EPIPE：`write()` 里的 try/catch 抓不到
  // （它只会变成 stream 的 `error` 事件，没人听就是未捕获异常，能把整个进程带走）。
  // 这里按模块契约把它降级成 `error{scope:"io"}` 事件 —— 写失败本身由 `write()` 返回 false 表达。
  child?.stdin?.on?.("error", (error: Error) => {
    emit({ kind: "error", scope: "io", message: error.message, code: null, id: null, command: null });
  });
  child?.on("error", (error: Error) => {
    spawnFailure = error.message;
    emit({ kind: "error", scope: "spawn", message: error.message, code: null, id: null, command: null });
    exitCode = null;
    exitSignal = null;
    finish();
  });
  child?.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code;
    exitSignal = signal;
    // `close` 才是 stdio 真的排干的时刻；它不来也不能卡住（stdout 被孙进程继承之类）。
    if (closeTimer === undefined) {
      closeTimer = setTimeout(finish, 500);
      closeTimer.unref?.();
    }
  });
  child?.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    exitCode = code ?? exitCode;
    exitSignal = signal ?? exitSignal;
    finish();
  });
  if (child === null) {
    emit({ kind: "error", scope: "spawn", message: "spawn threw before a process existed", code: null, id: null, command: null });
    finish();
  }

  const write = (command: RpcCommandInput): boolean => {
    if (exited || stopping) {
      emit({ kind: "error", scope: "io", message: `session is not accepting commands (${exited ? "exited" : "stopping"})`, code: null, id: null, command: null });
      return false;
    }
    if (child === null || child.stdin === null) {
      emit({ kind: "error", scope: "io", message: "no stdin pipe", code: null, id: null, command: null });
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch (error) {
      emit({ kind: "error", scope: "io", message: error instanceof Error ? error.message : String(error), code: null, id: null, command: null });
      return false;
    }
  };

  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  return {
    pid,
    ready: readyPromise,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: write,
    prompt(message, promptOpts = {}) {
      const id = promptOpts.id ?? nextId("prompt");
      write({
        id,
        type: "prompt",
        message,
        ...(promptOpts.images === undefined ? {} : { images: promptOpts.images }),
        ...(promptOpts.streamingBehavior === undefined ? {} : { streamingBehavior: promptOpts.streamingBehavior }),
      });
      return id;
    },
    abort() {
      return write({ type: "abort" });
    },
    newSession() {
      normalizer.reset();
      return write({ type: "new_session" });
    },
    getState() {
      return write({ id: nextId("state"), type: "get_state" });
    },
    getSessionStats() {
      return write({ id: nextId("stats"), type: "get_session_stats" });
    },
    setEventFilter(events, messageUpdates = "delta") {
      return write({ type: "set_event_filter", events, messageUpdates });
    },
    request<T = unknown>(command: RpcCommandInput, requestOpts: { timeoutMs?: number; id?: string } = {}) {
      const id = requestOpts.id ?? nextId(command.type);
      if (exited || stopping) {
        return Promise.resolve<RequestOutcome<T>>({ ok: false, reason: "exited", message: "session already exited" });
      }
      const gate = promiseLib.withResolvers<RequestOutcome<T>>();
      const timer = setTimeout(() => {
        pending.delete(id);
        gate.resolve({
          ok: false,
          reason: "timeout",
          message: `${command.type}: no response in ${requestOpts.timeoutMs ?? 10_000}ms`,
        });
      }, requestOpts.timeoutMs ?? 10_000);
      timer.unref?.();
      pending.set(id, (outcome) => {
        clearTimeout(timer);
        gate.resolve(outcome as RequestOutcome<T>);
      });
      if (!write({ ...command, id })) {
        pending.delete(id);
        clearTimeout(timer);
        gate.resolve({ ok: false, reason: "exited", message: `${command.type}: could not send` });
      }
      return gate.promise;
    },
    stderrTail() {
      return stderr;
    },
    textFor(messageId) {
      return normalizer.textFor(messageId);
    },
    stats() {
      return { droppedFrames: normalizer.dropped, receivedFrames, badLines };
    },
    async stop(stopOpts = {}) {
      if (exited) return { code: exitCode, signal: exitSignal, forced: forceKilled };
      stopping = true;
      const graceMs = stopOpts.graceMs ?? DEFAULT_STOP_GRACE_MS;
      const killGraceMs = stopOpts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      try {
        child?.stdin?.end();
      } catch {
        // 已经断了就算了。
      }
      // stdin EOF 是 omp 的正规退出路径；等不到才升级信号。
      const term = setTimeout(() => {
        forceKilled = true;
        try {
          child?.kill("SIGTERM");
        } catch {
          // 进程可能已经不在了。
        }
      }, graceMs);
      term.unref?.();
      const kill = setTimeout(() => {
        forceKilled = true;
        try {
          child?.kill("SIGKILL");
        } catch {
          // 同上。
        }
      }, graceMs + killGraceMs);
      kill.unref?.();
      const outcome = await exitPromise;
      clearTimeout(term);
      clearTimeout(kill);
      if (spawnFailure !== null && outcome.code === null && !forceKilled) {
        return { ...outcome, forced: false };
      }
      return outcome;
    },
  };
}
