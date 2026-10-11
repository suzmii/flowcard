/**
 * 「发消息进去时对话记录会乱」的**服务端侧**回归：假 omp 端到端（真 store / 真 `createApp` / 真 SSE 帧）。
 *
 * 钉住前端归并依赖的那条契约：
 *   1. 快照里的转录顺序 == 流上各行**首次出现**的顺序；
 *   2. 每一行的「行身份」在流上与快照里是**同一个**（工具行按 `tool.callId` 对齐，其余按 `id`）——
 *      两侧对不上时，前端每次 `reload()` 合并都会把本地那份再挂一份到末尾（用户报的「会乱」）；
 *   3. 发完一条消息，快照末尾就是这条新消息（合并时不会被旧行的副本挤到中间）。
 *
 * 前端归并函数那一半的钉桩在 `web/src/lib/session.test.ts`
 * （根 tsconfig 只收 `src/**`+`test/**`，编译不了 `web/src` 里那套 DOM/`@/` 代码，所以不在这儿 import 它）。
 *
 * 不用任何定时器：假 omp 靠 `FAKE_OMP_HOLD_AFTER` 决定"从第几轮起不再回话"，
 * 用例等的是真事件（SSE 上的帧、GET 快照），不猜时长。
 *
 * 不联网、不调模型。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createHostedSessions, type HostedSessions } from "../src/server/hosted-session.ts";
import { defaultSpawn, startRpcSession, type OmpRpcSession, type StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore, type Store } from "../src/server/store.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

/**
 * 假 omp（照 `docs/omp-rpc.md` 的帧形状，只留这几条用例要的帧）：
 * 每轮「正文 → text_end → 工具 start/update/end → message_end → 下一条消息 → 收尾」；
 * `FAKE_OMP_THINKING=1` 时正文前先来一段思考块。
 * `FAKE_OMP_HOLD_AFTER=<n>`：第 n 轮之后只回显用户消息、不再吐助手那一轮
 * （用例要在"人刚发出去、助手还没答"这个窗口里观察转录顺序，又不想靠 sleep 卡时间）。
 * 真 omp 的 `messageId` / `toolCallId` 在整个会话里递增 —— 照抄，两轮才分得清哪轮发的。
 */
const FAKE_OMP_SOURCE = String.raw`
const NL = "\n";
const out = (obj, done) => { process.stdout.write(JSON.stringify(obj) + NL, done); };
const SESSION_FILE = process.env.FAKE_OMP_SESSION_FILE || "/tmp/fake-omp/session.jsonl";
const THINKING = process.env.FAKE_OMP_THINKING === "1";
const HOLD_AFTER = Number(process.env.FAKE_OMP_HOLD_AFTER || 0);
const sessionId = "fake-session-1";
let pending = null;
let buf = "";
let turn = 0;

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i = buf.indexOf(NL);
  while (i >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line.trim() !== "") handleLine(line);
    i = buf.indexOf(NL);
  }
});
process.stdin.on("end", () => process.exit(0));

function handleLine(line) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, sessionFile: SESSION_FILE, tokens: { total: 15 }, cost: 0.5 } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "abort":
      out({ id: cmd.id, type: "response", command: "abort", success: true });
      if (pending !== null) {
        out({ type: "message_end", messageId: pending.msgId, message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted" } });
        out({ type: "prompt_result", id: pending.promptId, agentInvoked: true, status: "aborted", sessionSettled: true });
        out({ type: "session_settled" });
        pending = null;
      }
      return;
    case "prompt": {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      turn += 1;
      const user = "msg-" + (turn * 3 - 2);
      const asked = "msg-" + (turn * 3 - 1);
      const final = "msg-" + (turn * 3);
      const callId = "t" + turn;
      const first = "先跑一下" + turn;
      const last = "ok" + turn;
      // 用户消息的 echo 立刻给（服务端自己也 echo 一条，omp 这条 role=user 的会被丢掉）
      out({ type: "message_start", messageId: user, message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_end", messageId: user, message: { role: "user", content: [{ type: "text", text: cmd.message }], stopReason: "stop" } });
      // 第 HOLD_AFTER 轮之后就不回话了：留着 busy，用例在"助手还没答"这个窗口里看转录
      if (HOLD_AFTER > 0 && turn > HOLD_AFTER) {
        pending = { promptId: cmd.id, msgId: asked };
        return;
      }
      pending = { promptId: cmd.id, msgId: asked };
      out({ type: "agent_start" });
      out({ type: "message_start", messageId: asked, message: { role: "assistant", content: [] } });
      if (THINKING) {
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "先想一" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "下再说" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "先想一下再说" } });
      }
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先跑一下" } });
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: String(turn) } });
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: first } });
      out({ type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: { command: "ls -la" } });
      out({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", partialResult: { content: [{ type: "text", text: "total 0\n" }] } });
      out({ type: "tool_execution_end", toolCallId: callId, toolName: "bash", result: { content: [{ type: "text", text: "total 0\ndrwxr-xr-x 2 u u 4096 ." }] }, isError: false });
      out({ type: "message_end", messageId: asked, message: { role: "assistant", content: [{ type: "text", text: first }, { type: "toolCall", id: callId, name: "bash" }], stopReason: "toolUse" } });
      out({ type: "message_start", messageId: final, message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: final, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: last } });
      out({ type: "message_update", messageId: final, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: last } });
      out({ type: "message_end", messageId: final, message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: "stop" } });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      out({ type: "session_settled" });
      pending = null;
      return;
    }
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown command: " + cmd.type, code: "unsupported" });
  }
}
`;

// ---------------------------------------------------------------- 脚手架

const tempDirs: string[] = [];
const live: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of live) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

type FakeOmpOptions = { thinking?: boolean; holdAfter?: number };

function spawnFake(options: FakeOmpOptions = {}) {
  return (opts: StartRpcOptions): OmpRpcSession => {
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      argv: ["-e", FAKE_OMP_SOURCE, "--", ...(opts.args ?? [])],
      env: {
        ...opts.env,
        FAKE_OMP_SESSION_FILE: join(tmpdir(), "fc-chatorder-session.jsonl"),
        ...(options.thinking ? { FAKE_OMP_THINKING: "1" } : {}),
        ...(options.holdAfter === undefined ? {} : { FAKE_OMP_HOLD_AFTER: String(options.holdAfter) }),
      },
      spawn: defaultSpawn,
    });
    live.push(session);
    return session;
  };
}

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-chatorder-"));
  tempDirs.push(dir);
  return { store: createStore({ dataDir: join(dir, "data"), flow: personalFlow }), dir };
}

/** 开一张卡并绑一个真存在的 worktree（会话 cwd = 它）。 */
function openCard(store: Store, worktreePath: string): string {
  const opened = store.execute({ cmd: "open", actor: HUMAN, title: "对话顺序", body: "正文" });
  const id = opened.card?.id ?? "";
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card: id,
    worktree: { path: worktreePath, branch: "feat/x", source: "flowcard" },
  });
  return id;
}

function makeSessions(store: Store, options: FakeOmpOptions = {}): HostedSessions {
  return createHostedSessions({
    store,
    startSession: (opts) => spawnFake(options)(opts),
    resolveOmpPath: async () => undefined,
  });
}

// ---------------------------------------------------------------- 契约口径（与前端同一套）

/** SSE 帧的载荷（我们只读用得到的字段；线上就是 `JSON.stringify(event)` 去掉 type）。 */
const frameSchema = z.looseObject({
  id: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  callId: z.string().optional(),
});

/** 快照里的一行（`GET .../session` 的 messages）。 */
const snapshotSchema = z.looseObject({
  messages: z.array(
    z.looseObject({
      id: z.string(),
      role: z.string(),
      text: z.string().optional(),
      tool: z.looseObject({ callId: z.string() }).optional(),
    }),
  ),
});

type Frame = z.infer<typeof frameSchema>;
type SnapshotMessage = z.infer<typeof snapshotSchema>["messages"][number];

/**
 * 一行的「行身份」——**与前端 `web/src/lib/session.ts` 的 `messageKey` 同一套口径**：
 * 工具行按 `tool.callId`，其余按转录行 id。两侧对不上时前端合并就会多挂一份。
 */
function rowKey(message: SnapshotMessage): string {
  return message.role === "tool" && message.tool !== undefined && message.tool.callId !== ""
    ? message.tool.callId
    : message.id;
}

/** 流上某一帧代表的「行身份」：`event: tool` 给的是裸 `callId`，其余帧给的是转录行 id。 */
function frameKey(name: string, frame: Frame): string {
  if (name === "tool" && frame.callId !== undefined) return frame.callId;
  return frame.id ?? "";
}

// ---------------------------------------------------------------- 真 SSE 客户端

/** 真 SSE：读到某段标记为止；顺手记下每一行**首次出现**的顺序（行身份）。 */
class SseClient {
  #text = "";
  #buffer = "";
  #keys: string[] = [];
  constructor(
    private readonly decoder: TextDecoder,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async until(marker: string, timeoutMs = 8_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#text.includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error(`SSE 里等不到 ${marker}；已有：${this.#text.slice(-400)}`);
      }
      const chunk = await this.reader.read();
      if (chunk.done === true) throw new Error(`SSE 提前结束；已有：${this.#text.slice(-400)}`);
      const text = this.decoder.decode(chunk.value);
      this.#text += text;
      this.#ingest(text);
    }
  }

  /** 流上各行首次出现的「行身份」顺序。 */
  keys(): string[] {
    return [...this.#keys];
  }

  #ingest(chunk: string): void {
    this.#buffer += chunk;
    const blocks = this.#buffer.split("\n\n");
    this.#buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      let name = "";
      let payload = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7).trim();
        else if (line.startsWith("data: ")) payload = line.slice(6);
      }
      // 会"建行"的帧：`message`（流式增量的第一帧就把这一行摆上）、`message_end`（权威文本）、
      // `tool`（start/update/end 是同一行）。前端那边的行序就是这些帧**首次出现**的顺序。
      if ((name !== "message" && name !== "message_end" && name !== "tool") || payload === "") continue;
      const parsed = frameSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) continue;
      const key = frameKey(name, parsed.data);
      if (key !== "" && !this.#keys.includes(key)) this.#keys.push(key);
    }
  }
}

/** 一张卡 + 一条真 SSE（每次用例都从零起）。 */
async function setup(options: FakeOmpOptions = {}) {
  const { store, dir } = makeStore();
  const worktree = join(dir, "wt");
  mkdirSync(worktree, { recursive: true });
  const id = openCard(store, worktree);
  const app = createApp(store, { sessions: makeSessions(store, options) });
  const json = { "content-type": "application/json" };
  const url = (suffix: string): string => `/api/cards/${id}/session${suffix}`;

  const stream = await app.request(url("/stream"));
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("没有可读的 SSE body");
  const sse = new SseClient(new TextDecoder(), reader);

  const post = async (suffix: string, body: unknown): Promise<void> => {
    const response = await app.request(url(suffix), { method: "POST", headers: json, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
  };

  /** 真 `GET .../session`，按契约解析（不猜形状）。 */
  const snapshot = async (): Promise<SnapshotMessage[]> => {
    const raw: unknown = await (await app.request(url(""))).json();
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`会话快照不符合契约：${JSON.stringify(parsed.error.issues)}`);
    return parsed.data.messages;
  };

  await post("/start", { cwd: worktree });
  await sse.until('"ompSessionId":"fake-session-1"');

  return { post, sse, snapshot, stop: () => reader.cancel() };
}

// ---------------------------------------------------------------- 用例

describe("发消息时的转录顺序（假 omp 端到端）", () => {
  it("快照顺序 == 流上各行首次出现的顺序；工具行的行身份两侧一致（前端按 tool.callId 对齐）", async () => {
    // 第 1 轮正常跑完，第 2 轮只回显用户消息（不回话）—— 正好是"人刚发出去"那一刻
    const t = await setup({ holdAfter: 1 });

    await t.post("/prompt", { text: "第一句" });
    await t.sse.until('"text":"ok1"');

    const messages = await t.snapshot();
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages.map((message) => rowKey(message))).toEqual([
      expect.stringMatching(/:p1$/),
      expect.stringMatching(/:msg-2$/),
      "t1",
      expect.stringMatching(/:msg-3$/),
    ]);
    // 前端拿到的每一行身份，在快照里都能找到同一条（工具行：流上 `callId` == 快照的 `tool.callId`）
    expect(messages.map(rowKey)).toEqual(t.sse.keys());
    // 没有两行共用同一个身份（前端合并时那就会出现"一份快照、一份本地流"）
    const keys = messages.map(rowKey);
    expect(new Set(keys).size).toBe(keys.length);

    // 再发一条：这条用户的帧一到，快照末尾就该是它
    await t.post("/prompt", { text: "第二句" });
    await t.sse.until('"text":"第二句"');
    const after = await t.snapshot();
    expect(after.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(after.at(-1)?.text).toBe("第二句");
    expect(after.map(rowKey)).toEqual(t.sse.keys());

    await t.post("/stop", {});
    await t.stop();
  });

  it("思考行的行身份两侧也一致（不是裸 msgId）：流上 `<tag>:msg-2:thinking` == 快照里的那一行", async () => {
    const t = await setup({ thinking: true, holdAfter: 1 });

    await t.post("/prompt", { text: "第一句" });
    await t.sse.until('"text":"ok1"');

    const messages = await t.snapshot();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages.map((message) => rowKey(message))).toEqual([
      expect.stringMatching(/:p1$/),
      expect.stringMatching(/:msg-2:thinking$/),
      expect.stringMatching(/:msg-2$/),
      "t1",
      expect.stringMatching(/:msg-3$/),
    ]);
    expect(messages.map(rowKey)).toEqual(t.sse.keys());

    await t.post("/stop", {});
    await t.stop();
  });
});
