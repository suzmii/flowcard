/**
 * omp RPC 薄客户端的单测。
 *
 * 分两层：
 *   1. **纯函数**：`parseFrame` / `FrameNormalizer` / `textFromMessage` —— 直接喂帧字符串，不碰进程；
 *   2. **端到端**：一个**假的 omp**（`node -e` 脚本，按 omp 18.8.7 的真实帧形状吐 JSONL，
 *      源码见 `docs/omp-rpc.md`）跑在真管道上，覆盖正常一轮、乱码行、子进程早退、
 *      `abort` 收尾、`prompt_result` 归类、命令错误回执。
 *
 * 不联网、不调模型、不碰用户的 omp 配置。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FrameNormalizer,
  MAX_LINE_BYTES,
  classifyFrame,
  defaultSpawn,
  parseFrame,
  parseJsonLine,
  rpcArgv,
  startRpcSession,
  textFromMessage,
  type OmpEvent,
  type OmpRpcSession,
} from "../src/server/omp-rpc.ts";

// ---------------------------------------------------------------- 假 omp（node -e 脚本）

/**
 * 假 omp：只实现本测试用到的命令与帧，形状照抄 omp 18.8.7 的 `src/modes/rpc/`。
 * 用 `String.raw` 包住，好让脚本里的 `\n` 原样留在源码里（模板字面量不会先吃掉一层转义）。
 * `FAKE_OMP_MODE` 选分支：normal | die-before-ready | exit-after-ready | error-result。
 */
const FAKE_OMP_SOURCE = String.raw`
const NL = "\n";
const MODE = process.env.FAKE_OMP_MODE || "normal";
const out = (obj) => { process.stdout.write(JSON.stringify(obj) + NL); };

if (MODE !== "die-before-ready") {
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
if (MODE === "die-before-ready") { process.exit(3); }
if (MODE === "exit-after-ready") { process.exit(0); }

// 乱码：非 JSON + 合法 JSON 但不是对象。两者都必须被丢掉且不影响后续帧。
process.stdout.write("this is not json at all" + NL);
process.stdout.write("12345" + NL);

let sessionId = "fake-1";
let pendingPromptId = null;
let steerQueue = [];
let buf = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i = buf.indexOf(NL);
  while (i >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line.trim() !== "") { handleLine(line); }
    i = buf.indexOf(NL);
  }
});
process.stdin.on("end", () => { process.exit(0); });

function handleLine(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (e) {
    out({ type: "response", command: "parse", success: false, error: "bad json" });
    return;
  }
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: sessionId, isStreaming: false, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId: sessionId, toolCalls: 0, tokens: { input: 12, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.0001 } });
      return;
    case "new_session":
      sessionId = sessionId === "fake-1" ? "fake-2" : "fake-1";
      out({ id: cmd.id, type: "response", command: "new_session", success: true, data: { cancelled: false } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "steer":
      // 真 omp：入 steering 队列 + 回执 + queue_update（steering / liveSteered）。
      steerQueue.push(cmd.message);
      out({ id: cmd.id, type: "response", command: "steer", success: true });
      out({ type: "queue_update", steering: steerQueue.slice(), followUp: [], liveSteered: 1 });
      return;
    case "abort":
      out({ id: cmd.id, type: "response", command: "abort", success: true });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "只回答" } });
      out({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "只回答" }], stopReason: "aborted" } });
      out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
      out({ type: "agent_end", messages: [] });
      out({ type: "prompt_result", id: pendingPromptId, agentInvoked: true, status: "aborted", sessionSettled: true });
      out({ type: "session_settled" });
      return;
    case "prompt":
      pendingPromptId = cmd.id;
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      out({ type: "message_start", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_end", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "agent_start" });
      out({ type: "turn_start" });
      out({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "o" } });
      if (MODE === "dangling") { return; }
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "k" } });
      process.stdout.write("garbage mid-stream" + NL);
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" } });
      out({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
      out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
      out({ type: "agent_end", messages: [] });
      if (MODE === "error-result") {
        out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "error", error: { message: "provider exploded", provider: "example", model: "gen/m", httpStatus: 500, retryable: true }, sessionSettled: true });
      } else {
        out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      }
      out({ type: "session_settled" });
      return;
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown command: " + cmd.type, code: "unsupported" });
  }
}
`;

const tempDirs: string[] = [];
const live: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of live) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 起一个假 omp 会话：真 `spawn` + 真管道，argv 换成 `node -e <假脚本>`。 */
function startFake(mode: string): { session: OmpRpcSession; log: EventLog; cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "fc-rpc-test-"));
  tempDirs.push(cwd);
  const session = startRpcSession({
    cwd,
    ompPath: process.execPath,
    argv: ["-e", FAKE_OMP_SOURCE],
    env: { ...process.env, FAKE_OMP_MODE: mode },
    spawn: defaultSpawn,
    readyTimeoutMs: 10_000,
  });
  live.push(session);
  return { session, log: new EventLog(session), cwd };
}

/** 事件日志 + 按条件等待（订阅驱动，不轮询）。 */
class EventLog {
  readonly events: OmpEvent[] = [];
  #waiters: Array<{ match: (event: OmpEvent) => boolean; resolve: (event: OmpEvent) => void }> = [];

  constructor(session: OmpRpcSession) {
    session.on((event) => this.push(event));
  }

  push(event: OmpEvent): void {
    this.events.push(event);
    const index = this.#waiters.findIndex((waiter) => waiter.match(event));
    const waiter = index < 0 ? undefined : this.#waiters.splice(index, 1)[0];
    waiter?.resolve(event);
  }

  waitFor(match: (event: OmpEvent) => boolean, timeoutMs = 5_000): Promise<OmpEvent> {
    const existing = this.events.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    const gate = promiseLib.withResolvers<OmpEvent>();
    const timer = setTimeout(
      () => gate.reject(new Error(`no matching event in ${timeoutMs}ms; got: ${this.kinds().join(",")}`)),
      timeoutMs,
    );
    this.#waiters.push({
      match,
      resolve: (event) => {
        clearTimeout(timer);
        gate.resolve(event);
      },
    });
    return gate.promise;
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }

  indexOf(match: (event: OmpEvent) => boolean): number {
    return this.events.findIndex(match);
  }
}

const isResult = (event: OmpEvent): boolean => event.kind === "result";

/** 同 `omp-rpc.ts`：lib 是 ES2023，`Promise.withResolvers`（ES2024）只能用类型收窄拿到。 */
const promiseLib = Promise as unknown as {
  withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
};

// ---------------------------------------------------------------- 纯解析

describe("parseFrame：一行 stdout → 类型化帧", () => {
  it("ready：抄 omp 的真实字段（protocolVersion 1 + supportedProtocolVersions）", () => {
    const frame = parseFrame(
      '{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}',
    );
    expect(frame).toEqual({
      kind: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1048576,
      maxReassembledFrameBytes: 67108864,
    });
  });

  it("response：成功带 data，失败走 response_error（带 id/command/code）", () => {
    expect(parseFrame('{"id":"c1","type":"response","command":"get_state","success":true,"data":{"sessionId":"s"}}')).toEqual({
      kind: "response",
      id: "c1",
      command: "get_state",
      data: { sessionId: "s" },
    });
    expect(
      parseFrame('{"id":"c2","type":"response","command":"prompt","success":false,"error":"boom","code":"session_busy"}'),
    ).toEqual({ kind: "response_error", id: "c2", command: "prompt", error: "boom", code: "session_busy" });
  });

  it("prompt_result：status 只有 completed/aborted/error，其余归 completed", () => {
    expect(
      parseFrame('{"id":"p1","type":"prompt_result","agentInvoked":true,"status":"aborted","sessionSettled":true}'),
    ).toMatchObject({ kind: "prompt_result", id: "p1", agentInvoked: true, status: "aborted", sessionSettled: true });
    expect(parseFrame('{"type":"prompt_result","agentInvoked":true,"status":"weird","sessionSettled":false}')).toMatchObject({
      status: "completed",
    });
    expect(
      parseFrame(
        '{"type":"prompt_result","agentInvoked":true,"status":"error","error":{"message":"m","provider":"gen","model":"gen/m","httpStatus":429,"retryable":true},"sessionSettled":false}',
      ),
    ).toMatchObject({
      status: "error",
      sessionSettled: false,
      error: { message: "m", provider: "gen", model: "gen/m", httpStatus: 429, retryable: true },
    });
    // 本地命令（比如斜杠命令）没调 agent
    expect(parseFrame('{"type":"prompt_result","agentInvoked":false,"status":"completed","sessionSettled":true}')).toMatchObject({
      agentInvoked: false,
    });
  });

  it("session_settled / command_output / extension_ui_request 各归各的帧", () => {
    expect(parseFrame('{"type":"session_settled"}')).toEqual({ kind: "session_settled" });
    expect(parseFrame('{"type":"command_output","text":"usage: /help"}')).toEqual({ kind: "command_output", text: "usage: /help" });
    expect(parseFrame('{"type":"extension_ui_request","id":"u1","method":"confirm","title":"t","message":"m"}')).toMatchObject({
      kind: "ui_request",
      id: "u1",
      method: "confirm",
    });
  });

  it("会话事件按类型分流（含 message_update / tool_execution_* / notice）", () => {
    const frame = parseFrame(
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}',
    );
    expect(frame?.kind).toBe("session_event");
    expect(parseFrame('{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"}}')?.kind).toBe(
      "session_event",
    );
    expect(parseFrame('{"type":"notice","level":"warning","message":"n"}')?.kind).toBe("session_event");
  });

  it("乱码 / 空行 / 非对象 JSON → null；不认识的类型 → unknown（可安全忽略）", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame("   ")).toBeNull();
    expect(parseFrame("12345")).toBeNull();
    expect(parseFrame('["a","b"]')).toBeNull();
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseFrame('{"type":"brand_new_omp_frame","x":1}')).toEqual({
      kind: "unknown",
      type: "brand_new_omp_frame",
      raw: { type: "brand_new_omp_frame", x: 1 },
    });
    expect(parseFrame('{"noType":true}')).toEqual({ kind: "unknown", type: null, raw: { noType: true } });
    // 协议 v2 的分块帧：本客户端不 negotiate v2，所以只会安全忽略。
    expect(parseFrame('{"type":"rpc_chunk","chunkId":"rpc-1","index":0,"count":2,"byteLength":1,"data":"e30="}')?.kind).toBe(
      "unknown",
    );
  });

  it("classifyFrame 与 parseFrame 同源（已解析对象直接定帧）", () => {
    expect(classifyFrame({ type: "session_settled" })).toEqual({ kind: "session_settled" });
  });

  it("真机上真出现过的其余协议帧：available_commands_update / rpc_frame_error / extension_error", () => {
    // 启动与 new_session 之后各来一条，~50 KB，flowcard 不用 → 显式认得、归一化时丢弃并计数。
    expect(parseFrame('{"type":"available_commands_update","commands":[{"name":"security"}]}')).toEqual({
      kind: "commands_update",
      commands: [{ name: "security" }],
    });
    expect(parseFrame('{"type":"rpc_frame_error","originalType":"message_update","error":"RPC frame exceeded the transport limit"}')).toEqual({
      kind: "frame_error",
      error: "RPC frame exceeded the transport limit",
      originalType: "message_update",
    });
    expect(parseFrame('{"type":"extension_error","extensionPath":"/x/e.ts","event":"tool_call","error":"boom"}')).toEqual({
      kind: "extension_error",
      extensionPath: "/x/e.ts",
      event: "tool_call",
      error: "boom",
    });
  });

  it("rpcArgv 默认带上 mode/no-ui/cwd，并保留调用方参数顺序", () => {
    expect(rpcArgv({ cwd: "/tmp/fc-rpc" })).toEqual(["--mode", "rpc", "--no-ui", "--cwd", "/tmp/fc-rpc"]);
    expect(rpcArgv({ cwd: "/w", args: ["--no-title", "--model", "x"] })).toEqual([
      "--mode",
      "rpc",
      "--no-ui",
      "--cwd",
      "/w",
      "--no-title",
      "--model",
      "x",
    ]);
  });

  it("MAX_LINE_BYTES 比协议帧上限（1 MiB）留了余量", () => {
    expect(MAX_LINE_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

// ---------------------------------------------------------------- 归一化（纯）

describe("FrameNormalizer：帧 → 简化事件 + 拼纯文本", () => {
  const feed = (normalizer: FrameNormalizer, ...lines: string[]): OmpEvent[] =>
    lines.flatMap((line) => {
      const frame = parseFrame(line);
      return frame === null ? [] : normalizer.push(frame);
    });

  it("text_delta 按 messageId + contentIndex 累计；text_end 覆盖；message_end 再覆盖", () => {
    const n = new FrameNormalizer();
    const events = feed(
      n,
      '{"type":"message_start","messageId":"msg-2","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}',
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"o"}}',
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"k"}}',
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"ok!"}}',
      '{"type":"message_end","messageId":"msg-2","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stopReason":"stop"}}',
    );
    expect(events.filter((event) => event.kind === "text")).toHaveLength(2);
    expect(n.textFor("msg-2")).toBe("ok");
    const end = events.find((event) => event.kind === "message" && event.phase === "end");
    expect(end).toMatchObject({ phase: "end", messageId: "msg-2", role: "assistant", text: "ok", stopReason: "stop" });
  });

  it("不同 messageId 绝不合并（用户消息的文本不混进助手回答）", () => {
    const n = new FrameNormalizer();
    feed(
      n,
      '{"type":"message_start","messageId":"msg-1","message":{"role":"user","content":[{"type":"text","text":"只回答：ok"}]}}',
      '{"type":"message_end","messageId":"msg-1","message":{"role":"user","content":[{"type":"text","text":"只回答：ok"}]}}',
      '{"type":"message_update","messageId":"msg-2","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ok"}}',
    );
    expect(n.textFor("msg-1")).toBe("只回答：ok");
    expect(n.textFor("msg-2")).toBe("ok");
    expect(n.messageIds()).toEqual(["msg-1", "msg-2"]);
    expect(n.textFor("msg-9")).toBeNull();
  });

  it("多个 contentIndex 的文本块按序号拼接", () => {
    const n = new FrameNormalizer();
    feed(
      n,
      '{"type":"message_update","messageId":"msg-3","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"B"}}',
      '{"type":"message_update","messageId":"msg-3","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"A"}}',
    );
    expect(n.textFor("msg-3")).toBe("AB");
  });

  it("thinking / toolcall / tool / turn / agent / notice / queue 各自映射", () => {
    const n = new FrameNormalizer();
    const events = feed(
      n,
      '{"type":"message_update","messageId":"m","message":{"role":"assistant"},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"嗯"}}',
      '{"type":"message_update","messageId":"m","message":{"role":"assistant"},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"id":"t1","name":"bash","arguments":{}}}}',
      '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"ls"},"intent":"列目录"}',
      '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"stdout":"a"},"isError":false}',
      '{"type":"turn_start"}',
      '{"type":"turn_end","message":{"role":"assistant"},"toolResults":[{"toolCallId":"t1"}]}',
      '{"type":"agent_start"}',
      '{"type":"agent_end","messages":[]}',
      '{"type":"notice","level":"warning","message":"小心","source":"cfg"}',
      '{"type":"queue_update","steering":["s"],"followUp":[],"liveSteered":1}',
    );
    expect(events.map((event) => event.kind)).toEqual([
      "thinking",
      "toolcall",
      "tool",
      "tool",
      "turn",
      "turn",
      "agent",
      "agent",
      "notice",
      "queue",
    ]);
    expect(events[1]).toMatchObject({ kind: "toolcall", phase: "end", contentIndex: 1, toolName: "bash", toolCallId: "t1" });
    expect(events[2]).toMatchObject({ kind: "tool", phase: "start", toolName: "bash", intent: "列目录", args: { command: "ls" } });
    expect(events[3]).toMatchObject({ kind: "tool", phase: "end", isError: false, result: { stdout: "a" } });
    expect(events[8]).toMatchObject({ kind: "notice", level: "warning", message: "小心", source: "cfg" });
    // queue_update：steering/followUp 的排队快照 + 队头里已活投进流式响应的条数
    expect(events[9]).toEqual({ kind: "queue", steering: ["s"], followUp: [], liveSteered: 1 });
  });

  it("没见过的会话事件 → other（不丢信息），未知协议帧 → 丢弃并计数", () => {
    const n = new FrameNormalizer();
    const events = feed(n, '{"type":"todo_auto_clear"}', '{"type":"rpc_chunk","chunkId":"x","index":0,"count":1,"data":""}');
    expect(events).toEqual([{ kind: "other", type: "todo_auto_clear", raw: { type: "todo_auto_clear" } }]);
    expect(n.dropped).toBe(1);
  });

  it("commands_update 丢弃并计数；frame_error → protocol 错误；extension_error → error 级 notice", () => {
    const n = new FrameNormalizer();
    const events = feed(
      n,
      '{"type":"available_commands_update","commands":[{"name":"help"}]}',
      '{"type":"rpc_frame_error","originalType":"message_update","error":"too big"}',
      '{"type":"extension_error","extensionPath":"/x/e.ts","event":"session_start","error":"boom"}',
    );
    expect(events).toEqual([
      { kind: "error", scope: "protocol", message: "too big", code: "message_update", id: null, command: null },
      { kind: "notice", level: "error", message: "/x/e.ts session_start: boom", source: "extension" },
    ]);
    expect(n.dropped).toBe(1);
  });

  it("prompt_result / prompt 回执 / settled 的简化形状", () => {
    const n = new FrameNormalizer();
    const events = feed(
      n,
      '{"id":"p1","type":"response","command":"prompt","success":true,"data":{"agentInvoked":true}}',
      '{"id":"p1","type":"prompt_result","agentInvoked":true,"status":"error","error":{"message":"m","retryable":true},"sessionSettled":false}',
      '{"type":"session_settled"}',
    );
    expect(events[0]).toEqual({ kind: "response", command: "prompt", id: "p1", data: { agentInvoked: true } });
    expect(events[1]).toEqual({
      kind: "result",
      id: "p1",
      agentInvoked: true,
      status: "error",
      error: "m",
      retryable: true,
      sessionSettled: false,
    });
    expect(events[2]).toEqual({ kind: "settled" });
  });

  it("命令失败回执 → error{scope:command}，带 id/command 供关联", () => {
    const n = new FrameNormalizer();
    const events = feed(n, '{"id":"c9","type":"response","command":"new_session","success":false,"error":"busy","code":"session_busy"}');
    expect(events).toEqual([
      { kind: "error", scope: "command", message: "new_session: busy", code: "session_busy", id: "c9", command: "new_session" },
    ]);
  });

  it("reset() 之后拼好的文本清零（new_session 用）", () => {
    const n = new FrameNormalizer();
    feed(n, '{"type":"message_update","messageId":"msg-1","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"a"}}');
    expect(n.textFor("msg-1")).toBe("a");
    n.reset();
    expect(n.textFor("msg-1")).toBeNull();
  });

  it("textFromMessage 只取 text 块（thinking/toolCall 不算回答）", () => {
    expect(textFromMessage({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t" }] })).toBe("a");
    expect(textFromMessage({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] })).toBeNull();
    expect(textFromMessage(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- 端到端（真管道 + 假 omp）

describe("startRpcSession（假 omp 跑真管道）", () => {
  it("正常一轮：ready → prompt → 事件流 → prompt_result → session_settled", async () => {
    const { session, log } = startFake("normal");
    const ready = await session.ready;
    expect(ready).toMatchObject({ ok: true, protocolVersion: 1, supportedProtocolVersions: [1, 2] });
    expect(session.pid).toBeGreaterThan(0);

    expect(session.setEventFilter(null, "delta")).toBe(true);
    const promptId = session.prompt("只回答：ok");
    const result = await log.waitFor(isResult);
    expect(result).toMatchObject({ kind: "result", id: promptId, agentInvoked: true, status: "completed", sessionSettled: true });
    await log.waitFor((event) => event.kind === "settled");

    // 顺序：turn_start 在助手 message_start 前；prompt_result 在 agent_end 之后、settled 之前。
    const turnStart = log.indexOf((event) => event.kind === "turn" && event.phase === "start");
    const assistantStart = log.indexOf((event) => event.kind === "message" && event.messageId === "msg-2");
    const agentEnd = log.indexOf((event) => event.kind === "agent" && event.phase === "end");
    const resultIndex = log.indexOf(isResult);
    const settledIndex = log.indexOf((event) => event.kind === "settled");
    expect(turnStart).toBeGreaterThan(-1);
    expect(turnStart).toBeLessThan(assistantStart);
    expect(agentEnd).toBeLessThan(resultIndex);
    expect(resultIndex).toBeLessThan(settledIndex);

    // 文本拼装：两个增量 + text_end + message_end
    const deltas = log.events.filter((event) => event.kind === "text").map((event) => (event.kind === "text" ? event.delta : ""));
    expect(deltas).toEqual(["o", "k"]);
    expect(session.textFor("msg-2")).toBe("ok");
    expect(log.events.find((event) => event.kind === "text_end")).toMatchObject({ kind: "text_end", text: "ok" });

    // 乱码行（3 行）被忽略，且没有变成错误事件。
    expect(session.stats().badLines).toBe(3);
    expect(log.events.filter((event) => event.kind === "error")).toEqual([]);
    expect(await session.stop({ graceMs: 1_000, killGraceMs: 500 })).toMatchObject({ code: 0, signal: null, forced: false });
  });

  it("request()：按 id 关联响应；new_session 之后 sessionId 会变（M0 的坑）", async () => {
    const { session } = startFake("normal");
    expect((await session.ready).ok).toBe(true);

    const state1 = await session.request<{ sessionId: string }>({ type: "get_state" });
    expect(state1).toEqual({ ok: true, data: { sessionId: "fake-1", isStreaming: false, messageCount: 0 } });

    const switched = await session.request({ type: "new_session" });
    expect(switched).toEqual({ ok: true, data: { cancelled: false } });

    const state2 = await session.request<{ sessionId: string }>({ type: "get_state" });
    expect(state2.ok && state2.data.sessionId).toBe("fake-2");

    // 未知命令 → 命令错误（不是超时）
    const bogus = await session.request({ type: "bogus_command" }, { timeoutMs: 2_000 });
    expect(bogus).toEqual({ ok: false, reason: "error", message: "bogus_command: unknown command: bogus_command", code: "unsupported" });

    const stats = await session.request<{ tokens: { total: number } }>({ type: "get_session_stats" });
    expect(stats.ok && stats.data.tokens.total).toBe(15);
    await session.stop({ graceMs: 1_000, killGraceMs: 500 });
  });

  it("子进程在 ready 之前就退：ready 报 exit，不抛；stop() 拿到退出码", async () => {
    const { session, log } = startFake("die-before-ready");
    const ready = await session.ready;
    expect(ready).toMatchObject({ ok: false, reason: "exit" });
    if (!ready.ok) expect(ready.message).toContain("code=3");
    await session.stop();
    await log.waitFor((event) => event.kind === "exit");
    expect(log.events.find((event) => event.kind === "exit")).toEqual({ kind: "exit", code: 3, signal: null });
    expect(session.stats().receivedFrames).toBe(0);
  });

  it("ready 之后立刻退：拿到 exit 事件；退出后 send() 变 false + io 错误，且不再有事件", async () => {
    const { session, log } = startFake("exit-after-ready");
    expect((await session.ready).ok).toBe(true);
    const exitEvent = await log.waitFor((event) => event.kind === "exit");
    expect(exitEvent).toEqual({ kind: "exit", code: 0, signal: null });

    const countAtExit = log.events.length;
    expect(session.send({ type: "abort" })).toBe(false);
    const errorEvent = await log.waitFor((event) => event.kind === "error");
    expect(errorEvent).toMatchObject({ kind: "error", scope: "io", id: null, command: null });
    // 退出之后只有那一条 io 错误，没有别的（没有迟到的协议帧被当成事件）。
    expect(log.events.slice(countAtExit - 1).map((event) => event.kind)).toEqual(["exit", "error"]);
    await session.stop();
    expect(await session.request({ type: "get_state" })).toMatchObject({ ok: false, reason: "exited" });
  });

  it("abort：发长任务后立刻 abort，事件收尾为 result{status:\"aborted\"}，之后不再有事件", async () => {
    const { session, log } = startFake("dangling");
    expect((await session.ready).ok).toBe(true);
    const promptId = session.prompt("长任务");
    await log.waitFor((event) => event.kind === "text");
    expect(session.abort()).toBe(true);
    await log.waitFor((event) => event.kind === "response" && event.command === "abort");

    const result = await log.waitFor(isResult);
    expect(result).toMatchObject({ id: promptId, status: "aborted", agentInvoked: true, sessionSettled: true });
    await log.waitFor((event) => event.kind === "settled");
    // text_end 覆盖了之前拼的部分文本
    expect(session.textFor("msg-2")).toBe("只回答");

    // 「abort 之后不再有事件」：settled 之后再用一次 get_state 做**确定性屏障**
    // （子进程按序写同一个管道，等它回 get_state 就说明 settled 之后没有别的帧了），
    // 看到的事件必须恰好只有这一条回执。
    const countAfterSettled = log.events.length;
    const state = await session.request<{ sessionId: string }>({ type: "get_state" });
    expect(state.ok).toBe(true);
    expect(log.events.length).toBe(countAfterSettled + 1);
    expect(log.events.at(-1)).toMatchObject({ kind: "response", command: "get_state" });
    expect(log.indexOf(isResult)).toBeLessThan(log.indexOf((event) => event.kind === "settled"));
    await session.stop({ graceMs: 1_000, killGraceMs: 500 });
  });

  it("prompt_result 的 error 归类：status/error/retryable 一路透传成 result", async () => {
    const { session, log } = startFake("error-result");
    expect((await session.ready).ok).toBe(true);
    const promptId = session.prompt("会炸的一轮");
    const result = await log.waitFor(isResult);
    expect(result).toEqual({
      kind: "result",
      id: promptId,
      agentInvoked: true,
      status: "error",
      error: "provider exploded",
      retryable: true,
      sessionSettled: true,
    });
    await session.stop({ graceMs: 1_000, killGraceMs: 500 });
  });

  it("steer()：中途引导发的是 `type:\"steer\"`（不是 prompt），omp 的 queue_update 带 liveSteered", async () => {
    const { session, log } = startFake("normal");
    expect((await session.ready).ok).toBe(true);

    // 自己生成的 id（跟 prompt 一样带序号），命令类型是 steer
    const steerId = session.steer("打断一下：改用 pnpm");
    expect(steerId).toMatch(/^steer-\d+$/);
    await log.waitFor((event) => event.kind === "queue");
    expect(log.events.find((event) => event.kind === "queue")).toMatchObject({
      kind: "queue",
      steering: ["打断一下：改用 pnpm"],
      followUp: [],
      liveSteered: 1,
    });

    // 回执按 id 关联得上（`request` 是确认「omp 收下了」的逃生口）
    const ack = await session.request({ type: "steer", message: "再来一句" });
    expect(ack).toMatchObject({ ok: true });
    await log.waitFor((event) => event.kind === "queue" && event.steering.length === 2);
    await session.stop({ graceMs: 1_000, killGraceMs: 500 });
  });

  it("stop() 幂等：二次调用直接返回同一结论；取消订阅后不再收到事件", async () => {
    const { session } = startFake("normal");
    expect((await session.ready).ok).toBe(true);
    const unsubscribe = session.on(() => {
      throw new Error("订阅者自己抛错不能拖垮会话");
    });
    // 订阅者抛错被吞掉，命令照发。
    expect(session.send({ type: "get_state" })).toBe(true);
    unsubscribe();
    const first = await session.stop();
    expect(first.code).toBe(0);
    expect(await session.stop()).toEqual(first);
  });
});
