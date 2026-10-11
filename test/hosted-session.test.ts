/**
 * 托管会话的单测 + 端到端。
 *
 * 端到端用**假 omp**（`node -e` 脚本，照 omp 18.8.7 的帧形状吐 JSONL，见 `docs/omp-rpc.md`）
 * 跑真管道：起会话 → claim → prompt → 文本/工具事件 → prompt_result → 转录落库 → 停；
 * 还覆盖 abort、子进程早退、重启后转录仍在、以及 app 上那 5 个端点 + 每卡 SSE。
 *
 * 不联网、不调模型、不碰用户的 omp 配置。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { normalizePath } from "../src/shared/paths.ts";
import type { Card } from "../src/shared/types.ts";
import { createApp } from "../src/server/app.ts";
import { briefKickoff, cardBrief } from "../src/server/brief.ts";
import {
  createHostedSessions,
  imageMimeType,
  toolOutputText,
  type HostedSessions,
  type SessionEvent,
} from "../src/server/hosted-session.ts";
import { defaultSpawn, startRpcSession, type OmpRpcSession, type StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore, type Store } from "../src/server/store.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

// ---------------------------------------------------------------- 假 omp（node -e 脚本）

/**
 * 假 omp。`FAKE_OMP_MODE` 选分支：
 *   normal            —— 一轮完整交互：助手文本 → 工具调用（bash）→ 最终回答 → result
 *   hang              —— 收到 prompt 只吐一半就挂着，等 abort 才收尾（测中断）
 *   exit-after-turn   —— 一轮跑完就自己退（测"子进程早退"）
 *   die-before-ready  —— 连 ready 都不吐就退（测起不来）
 *   thinking          —— 一轮只有思考块 + 一句正文（测思考流式/落库，不跑工具）
 */
const FAKE_OMP_SOURCE = String.raw`
const NL = "\n";
const MODE = process.env.FAKE_OMP_MODE || "normal";
// 真 omp：-r <file> 续接时 get_session_stats 报的是**被续接的那个文件**（cwd 也取自它）。
// 假 omp 照抄这一点，好在测试里验证 argv 真的透传到了子进程。
const resumeIdx = process.argv.indexOf("-r");
const SESSION_FILE = (resumeIdx >= 0 ? process.argv[resumeIdx + 1] : null) || process.env.FAKE_OMP_SESSION_FILE || "/tmp/fake-omp/session.jsonl";
const out = (obj, done) => { process.stdout.write(JSON.stringify(obj) + NL, done); };

if (MODE !== "die-before-ready") {
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
if (MODE === "die-before-ready") { process.exit(3); }

// 乱码行不能影响会话（协议解析失败必须被丢掉）
process.stdout.write("这不是 JSON" + NL);

// 真 omp 起一段**新**对话时 sessionId 是新生成的（-r 续接才沿用文件里的那个）。
// FAKE_OMP_FRESH_ID=1 时照抄这一点：每次新进程给一个不同的 id（删会话后"再 start 是全新对话"
// 要用它 —— id 相同的话 claim 的幂等键会跟删除前那次撞上，被去重静默吞掉）。
const sessionId =
  process.env.FAKE_OMP_FRESH_ID && resumeIdx < 0
    ? "fresh-" + process.pid + "-" + Math.random().toString(36).slice(2, 6)
    : "fake-session-1";
// 挂着的那一轮：{ promptId, msgId }（abort 时照着它收尾）。
let pending = null;
// 已引导但还没被读到的消息（真 omp 的 steering 队列；abort 后**保留**并起新的一轮，见 docs/omp-rpc.md §3.2）。
let steerQueue = [];
let buf = "";
// 收到的每条命令落一份日志（测试断言 stdin 里到底是 steer 还是 prompt）——只读不改协议。
const CMD_LOG = process.env.FAKE_OMP_LOG || null;
function logCmd(cmd) {
  if (CMD_LOG === null) return;
  try { require("node:fs").appendFileSync(CMD_LOG, JSON.stringify({ type: cmd.type, id: cmd.id, message: cmd.message, streamingBehavior: cmd.streamingBehavior }) + NL); } catch {}
}
// 真 omp 的 messageId / toolCallId 在**整个会话里递增**（不是每轮从 msg-1 重来）——
// 假 omp 照抄这一点，两轮的帧/转录才分得清是哪一轮发的。
let turn = 0;

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

/**
 * 引导驱动起的一轮（abort 之后把排队里的引导跑成新的一轮）：真 omp 的引导**没有 prompt ticket**，
 * 所以不会出现 prompt_result —— 只有事件流 + 收尾的 session_settled。
 */
function runSteeredTurn(text) {
  turn += 1;
  const u = "msg-" + (turn * 3 - 2);
  const a = "msg-" + (turn * 3);
  out({ type: "agent_start" });
  out({ type: "message_start", messageId: u, message: { role: "user", content: [{ type: "text", text }] } });
  out({ type: "message_end", messageId: u, message: { role: "user", content: [{ type: "text", text }], stopReason: "stop" } });
  out({ type: "message_start", messageId: a, message: { role: "assistant", content: [] } });
  out({ type: "message_update", messageId: a, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "引导收到" } });
  out({ type: "message_update", messageId: a, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "引导收到" } });
  out({ type: "message_end", messageId: a, message: { role: "assistant", content: [{ type: "text", text: "引导收到" }], stopReason: "stop" } });
  out({ type: "agent_end", messages: [] });
}

function handleLine(line) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { out({ type: "response", command: "parse", success: false, error: "bad json" }); return; }
  logCmd(cmd);
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, sessionFile: SESSION_FILE, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.5 } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "abort": {
      out({ id: cmd.id, type: "response", command: "abort", success: true });
      if (pending === null) return; // 空闲时 abort 是空操作：只回回执，不报错、不起轮次
      // abort 之后在途帧还会有几条（真机就这样），然后以 aborted 收尾。
      out({ type: "message_update", messageId: pending.msgId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "2" } });
      out({ type: "message_update", messageId: pending.msgId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "12" } });
      out({ type: "message_end", messageId: pending.msgId, message: { role: "assistant", content: [{ type: "text", text: "12" }], stopReason: "aborted" } });
      // 真 omp：abort **不清空** steering 队列（agent.abort() 只 abort controller），收尾时
      // #drainStrandedQueuedMessages 把排队里的引导直接跑成新的一轮（源码 agent-session.ts:9781-9784）。
      const queued = steerQueue.shift();
      out({ type: "prompt_result", id: pending.promptId, agentInvoked: true, status: "aborted", sessionSettled: queued === undefined });
      pending = null;
      if (queued === undefined) { out({ type: "session_settled" }); return; }
      out({ type: "queue_update", steering: steerQueue.slice(), followUp: [] });
      runSteeredTurn(queued);
      out({ type: "session_settled" });
      return;
    }
    case "steer": {
      // 引导：只入队（真 omp 的语义，docs/omp-rpc.md §3.2）——忙时也不报 busy 错、不另起一轮。
      steerQueue.push(cmd.message);
      out({ id: cmd.id, type: "response", command: "steer", success: true });
      out({ type: "queue_update", steering: steerQueue.slice(), followUp: [] });
      return;
    }
    case "prompt": {
      if (pending !== null) {
        // 真 omp：忙时**不带** streamingBehavior 的 prompt 抛 AgentBusyError（rpc-mode 先吐一条失败回执，
        // 再把 ticket 记成 error 的 prompt_result）——这正是「默认引导」要绕开的那条路。
        out({ id: cmd.id, type: "response", command: "prompt", success: false, error: "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion." });
        out({ type: "prompt_result", id: cmd.id, agentInvoked: false, status: "error", error: { message: "Agent is already processing.", retryable: false }, sessionSettled: false });
        return;
      }
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      turn += 1;
      const user = "msg-" + (turn * 3 - 2);
      const asked = "msg-" + (turn * 3 - 1);
      const final = "msg-" + (turn * 3);
      const callId = "t" + turn;
      pending = { promptId: cmd.id, msgId: asked };
      out({ type: "message_start", messageId: user, message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_end", messageId: user, message: { role: "user", content: [{ type: "text", text: cmd.message }], stopReason: "stop" } });
      out({ type: "agent_start" });
      out({ type: "turn_start" });
      out({ type: "message_start", messageId: asked, message: { role: "assistant", content: [] } });
      if (MODE === "thinking") {
        // 思考块：两个 delta 累加 + thinking_end 权威覆盖；随后才是正文（同一条 messageId）。
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "先想一" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "下再说" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "先想一下再说" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好" } });
        out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "好" } });
        out({ type: "message_end", messageId: asked, message: { role: "assistant", content: [{ type: "text", text: "好" }], stopReason: "stop" } });
        out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
        out({ type: "session_settled" });
        pending = null;
        return;
      }
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先" } });
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "跑一下" } });
      if (MODE === "hang") return;
      out({ type: "message_update", messageId: asked, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "先跑一下" } });
      out({ type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: { command: "ls -la" } });
      out({ type: "tool_execution_update", toolCallId: callId, toolName: "bash", partialResult: { content: [{ type: "text", text: "total 0\n" }] } });
      out({ type: "tool_execution_end", toolCallId: callId, toolName: "bash", result: { content: [{ type: "text", text: "total 0\ndrwxr-xr-x 2 u u 4096 ." }] }, isError: false });
      out({ type: "message_end", messageId: asked, message: { role: "assistant", content: [{ type: "text", text: "先跑一下" }, { type: "toolCall", id: callId, name: "bash" }], stopReason: "toolUse" } });
      out({ type: "message_start", messageId: final, message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: final, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
      process.stdout.write("流中间的乱码" + NL);
      out({ type: "message_update", messageId: final, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" } });
      out({ type: "message_end", messageId: final, message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
      out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
      out({ type: "agent_end", messages: [] });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      // 最后一帧写进管道之后再退（退出回调里 process.exit 不会截断前面已 flush 的写）
      out({ type: "session_settled" }, () => {
        if (MODE === "exit-after-turn") process.exit(0);
      });
      pending = null;
      return;
    }
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown command: " + cmd.type, code: "unsupported" });
  }
}
`;

// ---------------------------------------------------------------- 测试脚手架

const tempDirs: string[] = [];
const live: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of live) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 真进程 + 真管道，argv 换成 `node -e <假 omp> <omp 的真实参数…>`；registry 的其余依赖照生产走。 */
function spawnFake(mode: string, sessionFile?: string, extraEnv?: NodeJS.ProcessEnv) {
  return (opts: StartRpcOptions): OmpRpcSession => {
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      // omp 的真实参数（`-r`/`-e`…）跟着脚本一起透传，假 omp 才看得见它们。
      // `--` 不能省：不然 node 会把 `--no-title` 之类当自己的选项，直接报错退出（起不来）。
      argv: ["-e", FAKE_OMP_SOURCE, "--", ...(opts.args ?? [])],
      env: {
        ...opts.env,
        FAKE_OMP_MODE: mode,
        ...(sessionFile === undefined ? {} : { FAKE_OMP_SESSION_FILE: sessionFile }),
        ...(extraEnv ?? {}),
      },
      spawn: defaultSpawn,
    });
    live.push(session);
    return session;
  };
}

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-hosted-"));
  tempDirs.push(dir);
  return { store: createStore({ dataDir: join(dir, "data"), flow: personalFlow }), dir };
}

/** 开一张卡并绑一个真存在的 worktree（会话 cwd = 它）。 */
function openCard(store: Store, worktreePath: string): string {
  const opened = store.execute({ cmd: "open", actor: HUMAN, title: "托管会话", body: "正文" });
  const id = opened.card?.id ?? "";
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card: id,
    worktree: { path: worktreePath, branch: "feat/x", source: "flowcard" },
  });
  return id;
}

function makeSessions(
  store: Store,
  mode: string,
  calls: StartRpcOptions[] = [],
  sessionFile?: string,
  extraEnv?: NodeJS.ProcessEnv,
): HostedSessions {
  return createHostedSessions({
    store,
    startSession: (opts) => {
      calls.push(opts);
      return spawnFake(mode, sessionFile, extraEnv)(opts);
    },
    resolveOmpPath: async () => undefined, // 别真去 `sh -c command -v omp`
  });
}

/**
 * 配了 `briefDir` 的注册表 —— 生产里 `main.ts` 就是这么装的（`<dataDir>/briefs`）。
 * 手动起会话（`POST .../session/start`）走的就是这条路：先落开工提示文件，新会话再投 kickoff。
 */
function makeSessionsWithBriefDir(
  store: Store,
  mode: string,
  briefDir: string,
  calls: StartRpcOptions[] = [],
  sessionFile?: string,
): HostedSessions {
  return createHostedSessions({
    store,
    briefDir,
    startSession: (opts) => {
      calls.push(opts);
      return spawnFake(mode, sessionFile)(opts);
    },
    resolveOmpPath: async () => undefined,
  });
}

/** 事件日志 + 按条件等待（订阅驱动，不轮询）。 */
class EventLog {
  readonly events: SessionEvent[] = [];
  #waiters: Array<{
    match: (event: SessionEvent) => boolean;
    remaining: number;
    resolve: (event: SessionEvent) => void;
  }> = [];

  push = (event: SessionEvent): void => {
    this.events.push(event);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.match(event)) continue;
      waiter.remaining -= 1;
      if (waiter.remaining > 0) continue;
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  };

  waitFor(match: (event: SessionEvent) => boolean, timeoutMs = 4_000): Promise<SessionEvent> {
    const existing = this.events.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return this.#next(match, 1, timeoutMs);
  }

  byType(type: SessionEvent["type"]): SessionEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  /**
   * 等**第 `nth` 次**匹配的事件（`waitFor` 只认第一次）—— 多轮对话要靠这个数着等：
   * 每轮结束都会推一条 `state{busy:false}`，只按形状等就分不清是哪一轮。
   *
   * **不能**在"还没够数"时退回 `waitFor`：它会立刻拿一个**已经存在的**匹配事件结账（等于没等），
   * 数轮次时就会把启动期那条当成"这一轮跑完了"。所以这里只等**调用之后新到的**事件。
   */
  waitForNth(match: (event: SessionEvent) => boolean, nth: number, timeoutMs = 4_000): Promise<SessionEvent> {
    const seen = this.events.filter(match);
    if (seen.length >= nth) return Promise.resolve(seen[nth - 1] as SessionEvent);
    return this.#next(match, nth - seen.length, timeoutMs);
  }

  /** 等接下来 `count` 个匹配的事件（只算调用之后新到的）。 */
  #next(
    match: (event: SessionEvent) => boolean,
    count: number,
    timeoutMs: number,
  ): Promise<SessionEvent> {
    return new Promise<SessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等不到匹配的事件（${timeoutMs}ms）；已有：${this.events.map((e) => e.type).join(",")}`));
      }, timeoutMs);
      this.#waiters.push({
        match,
        remaining: count,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }
}

// ---------------------------------------------------------------- 纯函数

describe("工具输出与图片（纯函数）", () => {
  it("工具输出优先说人话：content 文本块 / output / 字符串 / 兜底 JSON", () => {
    expect(toolOutputText({ content: [{ type: "text", text: "hello" }, { type: "text", text: " world" }] })).toBe(
      "hello world",
    );
    expect(toolOutputText({ output: "1 passed" })).toBe("1 passed");
    expect(toolOutputText("raw")).toBe("raw");
    expect(toolOutputText({ weird: 1 })).toBe('{"weird":1}');
    expect(toolOutputText(undefined)).toBeUndefined();
    expect(toolOutputText(null)).toBeUndefined();
    // 超长截断（网页要能看，但别把响应撑爆）
    const long = "x".repeat(9_000);
    expect(toolOutputText(long)?.endsWith("（已截断）")).toBe(true);
  });

  it("图片 mime 按扩展名猜，认不出当 png", () => {
    expect(imageMimeType("a.JPG")).toBe("image/jpeg");
    expect(imageMimeType("shot.webp")).toBe("image/webp");
    expect(imageMimeType("noext")).toBe("image/png");
  });
});

// ---------------------------------------------------------------- 端到端（假 omp）

describe("托管会话（假 omp 真管道）", () => {
  it("起会话 → claim → prompt → 文本/工具/输出 → 转录落库 → 停；重启后转录仍在", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "normal");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    const started = await sessions.start(id, { kickoff: "只回答：ok" });
    expect(started).toEqual({ ok: true, status: "starting", cwd: dir });
    expect(store.getCard(id)?.state).toBe("ready"); // 还没起来，卡片不动

    // ready 事件在这之前已经发出去 ⇒ claim 一定落库了（先 claim 再推 ready）
    const ready = await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    expect(ready.type === "ready" ? ready.cwd : null).toBe(dir);
    expect(ready.type === "ready" ? ready.ompSessionId : null).toBe("fake-session-1");
    expect(sessions.snapshot(id).status).toBe("running");
    const card = store.getCard(id);
    expect(card?.session?.id).toBe("fake-session-1");
    expect(card?.session?.cwd).toBe(dir);
    expect(card?.session?.resumeHint).toBe("omp -r /tmp/fake-omp/session.jsonl");
    expect(card?.state).toBe("working"); // claim → 开工

    // 用户消息由 flowcard 自己 echo（id 也是我们自己发的那个 prompt id）
    const user = await log.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(user.type === "message_end" ? user.text : "").toBe("只回答：ok");

    // 助手两条消息的最终文本（text_end / message_end 两次都权威）
    const finals = await log.waitFor(
      (e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok",
    );
    expect(finals.type === "message_end" ? finals.role : null).toBe("assistant");
    const deltas = log
      .byType("message")
      .map((e) => (e.type === "message" ? e.textDelta : undefined))
      .join("");
    expect(deltas).toContain("先跑一下");
    expect(deltas).toContain("ok");

    // 工具调用与它的输出（"直接看到终端"）
    const toolEnd = await log.waitFor((e) => e.type === "tool" && e.phase === "end");
    expect(toolEnd.type === "tool" ? toolEnd.name : "").toBe("bash");
    expect(toolEnd.type === "tool" ? toolEnd.output : "").toContain("drwxr-xr-x");
    expect(log.byType("tool").map((e) => (e.type === "tool" ? e.phase : "")).slice(0, 3)).toEqual([
      "start",
      "update",
      "end",
    ]);

    // 一轮结束：busy 归零 + 花费带上来
    const settledState = await log.waitFor(
      (e) => e.type === "state" && e.busy === false && e.cost?.total === 15,
    );
    expect(settledState.type === "state" ? settledState.cost : null).toEqual({ total: 15, cost: 0.5 });

    const snapshot = sessions.snapshot(id);
    expect(snapshot.status).toBe("running");
    expect(snapshot.ompSessionId).toBe("fake-session-1");
    expect(snapshot.busy).toBe(false);
    expect(snapshot.cost).toEqual({ total: 15, cost: 0.5 });
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(snapshot.messages[0]?.text).toBe("只回答：ok");
    expect(snapshot.messages[1]?.text).toBe("先跑一下");
    expect(snapshot.messages[2]?.tool?.callId).toBe("t1");
    expect(snapshot.messages[2]?.tool?.status).toBe("end");
    expect(snapshot.messages[2]?.tool?.output).toContain("total 0");
    expect(snapshot.messages[3]?.text).toBe("ok");

    // 停：子进程退出 → 上报 end → 卡片会话结束
    expect(await sessions.stop(id)).toEqual({ ok: true });
    expect(sessions.snapshot(id).status).toBe("ended");
    expect(store.getCard(id)?.session?.state).toBe("ended");
    expect(sessions.isLive(id)).toBe(false);
    expect(sessions.liveCardIds()).toEqual([]);

    // 重启服务：新注册表（没有 live 记录）照样给得出历史
    const restarted = createHostedSessions({ store, resolveOmpPath: async () => undefined });
    expect(restarted.snapshot(id).status).toBe("ended");
    expect(restarted.snapshot(id).cwd).toBe(dir);
    expect(restarted.snapshot(id).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("起会话不往 argv 塞 --append-system-prompt：kickoff 就是第一条 prompt，里面带 brief 的绝对路径", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const calls: StartRpcOptions[] = [];
    const sessions = makeSessions(store, "normal", calls);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    // autostart 实际用的那个路径（`<dataDir>/briefs/<card>.md`）
    const briefPath = join(dir, "data", "briefs", `${id}.md`);
    const kickoff = `开工：第一步先 read \`${briefPath}\`，按里面「☑︎ 接下来你要做的」逐步执行。`;
    await sessions.start(id, { kickoff });

    // argv 里既没有注入用的 flag，也没有提示正文（提示只在文件里）
    const args = calls[0]?.args ?? [];
    expect(args).not.toContain("--append-system-prompt");
    expect(args.some((arg) => arg.includes("接下来你要做的") || arg.includes("# 卡片"))).toBe(false);

    // 第一条 prompt 原样发出去 = 「去 read 那个绝对路径」，效果等同注入一次 tool use
    const user = await log.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(user.type === "message_end" ? user.text : null).toBe(kickoff);
    expect(kickoff).toContain(briefPath);
    expect(sessions.snapshot(id).messages[0]?.text).toBe(kickoff);
    await sessions.stop(id);
  });

  it("abort：中断当前一轮，transcript 留下被中断的那一段", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "hang");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    const sent = await sessions.prompt(id, "请从 1 数到 500");
    expect(sent.ok).toBe(true);
    expect(sent.messageId).toBeDefined();
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");
    expect(sessions.snapshot(id).busy).toBe(true);

    const settledBefore = log.byType("state").filter((e) => e.type === "state" && e.busy === false).length;
    expect(await sessions.abort(id)).toEqual({ ok: true });
    const aborted = await log.waitFor(
      (e) => e.type === "message_end" && e.role === "assistant" && e.text === "12",
    );
    expect(aborted.type === "message_end" ? aborted.text : "").toBe("12");
    // 等**中断之后**第一次 busy 归零（启动期也有同形状的态，按形状等会立刻拿旧的结账）
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 1);
    expect(sessions.snapshot(id).busy).toBe(false);
    // abort 不是结束：会话还活着，等真正的 stop
    expect(sessions.snapshot(id).status).toBe("running");
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual(["请从 1 数到 500", "12"]);
    await sessions.stop(id);
    expect(sessions.snapshot(id).status).toBe("ended");
  });

  it("思考块：SSE 流式出现、按 messageId/contentIndex 归并、落库后 GET 读回 role=thinking", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "thinking");
    const log = new EventLog();
    sessions.subscribe(id, log.push);
    const app = createApp(store, { sessions });

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    expect((await sessions.prompt(id, "想想再答")).ok).toBe(true);

    // SSE：思考增量流式出现（累加），thinking_end 落一条 message_end 权威覆盖
    await log.waitFor((e) => e.type === "message" && e.role === "thinking" && e.textDelta === "先想一");
    const end = await log.waitFor((e) => e.type === "message_end" && e.role === "thinking");
    expect(end.type === "message_end" ? end.text : "").toBe("先想一下再说");
    const deltas = log
      .byType("message")
      .map((e) => (e.type === "message" && e.role === "thinking" ? e.textDelta : ""))
      .join("");
    expect(deltas).toBe("先想一下再说");
    // 思考块独占一行，不盖掉同一条 messageId 的助手回答
    const assistant = await log.waitFor((e) => e.type === "message_end" && e.role === "assistant");
    expect(assistant.type === "message_end" ? assistant.text : "").toBe("好");

    const snapshot = sessions.snapshot(id);
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    const thinking = snapshot.messages.find((m) => m.role === "thinking");
    expect(thinking?.text).toBe("先想一下再说");
    expect(thinking?.id).toContain(":thinking");

    // 亲口从 HTTP GET 读回：role=thinking（不是被兜底成 assistant）
    const got = (await (await app.request(`/api/cards/${id}/session`)).json()) as {
      messages: { role: string; text?: string }[];
    };
    expect(got.messages.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(got.messages.find((m) => m.role === "thinking")?.text).toBe("先想一下再说");

    await sessions.stop(id);
    // 重启（新注册表）后转录仍在：思考块照样读得回
    const restarted = createHostedSessions({ store, resolveOmpPath: async () => undefined });
    expect(restarted.snapshot(id).messages.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
  });

  it("子进程早退：状态收尾 + 代表会话上报 end（卡片会话变 ended）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "exit-after-turn");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "只回答：ok" });
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    // 进程没了就说清楚「还能接着聊」：有会话文件 → 下一条消息会自动 `-r` 续接（见 session-resume.test.ts）
    await log.waitFor((e) => e.type === "notice" && e.message.includes("下一条消息会自动用"));
    expect(sessions.snapshot(id).status).toBe("ended");
    expect(store.getCard(id)?.session?.state).toBe("ended");
    expect(sessions.isLive(id)).toBe(false);
    // 转录还在（进程没了不等于聊天记录没了）
    expect(sessions.snapshot(id).messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("连 ready 都没吐就退：状态 failed，卡片不 claim（不打扰投影）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "die-before-ready");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    const started = await sessions.start(id);
    expect(started.status).toBe("starting");
    const failure = await log.waitFor((e) => e.type === "error");
    expect(failure.type === "error" ? failure.message : "").toContain("omp 没起来");
    expect(sessions.snapshot(id).status).toBe("failed");
    expect(store.getCard(id)?.session).toBeNull();
    expect(store.getCard(id)?.state).toBe("ready");
    expect(sessions.snapshot(id).messages).toEqual([]);
  });

  it("没有会话时 prompt/abort 明确报错；没有 worktree 也不属于项目时起不来", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "normal");
    const prompted = await sessions.prompt(id, "在吗");
    expect(prompted).toEqual({
      ok: false,
      error: { code: "NO_SESSION", message: `卡片 ${id} 没有会话（也没有可续接的会话文件）` },
    });
    expect((await sessions.abort(id)).ok).toBe(false);

    // 卡不在任何项目里（未归属）、也没绑 worktree → 没有工作目录
    const orphan = store.execute({ cmd: "open", actor: HUMAN, title: "未归属", body: "" }).card?.id ?? "";
    const lonely = await sessions.start(orphan);
    expect(lonely.ok).toBe(false);
    expect(lonely.status).toBe("failed");
    expect(lonely.error?.code).toBe("NO_CWD");

    const missing = await sessions.start("c404");
    expect(missing.error?.code).toBe("NOT_FOUND");

    // 起的会话还在时重复 start：不重复起，返回现况
    await sessions.start(id);
    const again = await sessions.start(id);
    expect(again.ok).toBe(true);
    expect(again.status).toBe("starting");
    await sessions.stop(id);
  });
});

// ---------------------------------------------------------------- 换工作目录（changeCwd）

/** omp 形状的会话文件（头里带 cwd），按 omp 的目录布局放：`<sessions>/<cwd 里 / 换成 ->/<id>.jsonl`。 */
function writeSessionFixture(root: string, cwd: string, id = "fake-session-1"): string {
  const file = join(root, normalizePath(cwd).replace(/\//g, "-"), `${id}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "title", v: 1, title: "" }),
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-10T00:00:00.000Z", cwd }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: "上一轮的结论" }] } }),
    ].join("\n") + "\n",
  );
  return file;
}

describe("换工作目录（changeCwd：绑 worktree 后的「把会话搬进去」）", () => {
  it("停旧进程 → 用改过 cwd 头的会话文件 -r 续接 → 重新 claim：卡片进实施中、转录不断", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "x");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = openCard(store, proj);
    const calls: StartRpcOptions[] = [];
    const sessions = makeSessions(store, "normal", calls, fixture);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "开工" });
    const first = await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    expect(first.type === "ready" ? first.cwd : null).toBe(proj);
    expect(store.getCard(id)?.state).toBe("working");
    const before = sessions.snapshot(id).messages.length;
    expect(before).toBeGreaterThan(0);

    const moved = await sessions.changeCwd(id, { cwd: wt });
    expect(moved.ok).toBe(true);
    expect(moved.resumed).toBe(true);
    expect(moved.previousCwd).toBe(proj);
    expect(moved.cwd).toBe(wt);
    expect(moved.status).toBe("starting");

    // 续接文件是**新目录对应的会话目录**里的副本，头里的 cwd 已改成新目录；原文件没动
    const handoff = join(dir, "omp-sessions", normalizePath(wt).replace(/\//g, "-"), "fake-session-1.jsonl");
    expect(moved.sessionFile).toBe(handoff);
    const headerLine = readFileSync(handoff, "utf8").split("\n").find((l) => l.includes('"type":"session"'));
    const header: unknown = JSON.parse(headerLine ?? "{}");
    expect(typeof header === "object" && header !== null && "cwd" in header ? header.cwd : undefined).toBe(wt);
    expect(readFileSync(fixture, "utf8")).toContain(`"cwd":"${proj}"`);

    // 第二次起会话：cwd 是新目录，argv 里带 `-r <副本>`（假 omp 从 argv 里认出它并当自己的 sessionFile）
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cwd).toBe(wt);
    const args = calls[1]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe(handoff);

    // 新会话起来 → 自己 claim（cwd 在新目录）→ 卡片还是「实施中」，会话 cwd 是新目录
    const second = await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined && e.cwd === wt);
    expect(second.type === "ready" ? second.ompSessionId : null).toBe("fake-session-1");
    expect(store.getCard(id)?.session?.cwd).toBe(wt);
    expect(store.getCard(id)?.state).toBe("working");
    expect(sessions.snapshot(id).cwd).toBe(wt);

    // 转录连续：老消息还在，续接后接着往同一张卡的转录里追加
    await sessions.prompt(id, "接着干");
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    const messages = sessions.snapshot(id).messages;
    expect(messages.length).toBeGreaterThan(before);
    expect(messages.some((m) => m.text === "上一轮的结论" || m.text === "开工")).toBe(true);
  });

  it("会话文件读不动 / 压根没有 → 退化成新会话，并在 note 里说清（不静默）", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "y");
    mkdirSync(wt, { recursive: true });
    const id = openCard(store, proj);
    const calls: StartRpcOptions[] = [];
    // 假 omp 报一个**不存在**的会话文件：读不动 → 只能新起一条
    const sessions = makeSessions(store, "normal", calls, join(dir, "gone.jsonl"));
    const log = new EventLog();
    sessions.subscribe(id, log.push);
    await sessions.start(id, { kickoff: "开工" });
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);

    const moved = await sessions.changeCwd(id, { cwd: wt });
    expect(moved.ok).toBe(true);
    expect(moved.resumed).toBe(false);
    expect(moved.sessionFile).toBeUndefined();
    expect(moved.note).toContain("续接没成");
    expect(calls[1]?.args ?? []).not.toContain("-r");
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined && e.cwd === wt);
    expect(store.getCard(id)?.session?.cwd).toBe(wt);
    expect(store.getCard(id)?.state).toBe("working");

    // 目录不存在：明确报错，不动会话
    const bad = await sessions.changeCwd(id, { cwd: join(dir, "没有这个目录") });
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("NO_CWD");
    expect(bad.resumed).toBe(false);
    expect((await sessions.changeCwd("c404", { cwd: wt })).error?.code).toBe("NOT_FOUND");
  });

  it("服务重启后（注册表里没有 live 记录）也能按卡片上留的会话文件续接", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "z");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = openCard(store, proj);

    // 第一个实例：起会话（claim 把 session.file 落进卡片投影）→ 停掉
    const first = makeSessions(store, "normal", [], fixture);
    const firstLog = new EventLog();
    first.subscribe(id, firstLog.push);
    await first.start(id, { kickoff: "开工" });
    await firstLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await first.stop(id);
    expect(store.getCard(id)?.session?.file).toBe(fixture);

    // 第二个实例（相当于重启）：注册表是空的，只能靠卡片上的 file
    const calls: StartRpcOptions[] = [];
    const second = makeSessions(store, "normal", calls, fixture);
    const log = new EventLog();
    second.subscribe(id, log.push);
    const moved = await second.changeCwd(id, { cwd: wt });
    expect(moved.resumed).toBe(true);
    expect(moved.previousCwd).toBe(proj);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined && e.cwd === wt);
    expect(store.getCard(id)?.session?.cwd).toBe(wt);
    expect(store.getCard(id)?.state).toBe("working");
  });
});

// ---------------------------------------------------------------- 多轮对话（答完一轮 ≠ 会话结束）

describe("多轮对话（同一个子进程接着聊）", () => {
  it("连着两轮都有回答，会话还在 running：答完一轮不该把会话结束掉", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const calls: StartRpcOptions[] = [];
    const sessions = makeSessions(store, "normal", calls);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);

    // 第一轮
    const settledBefore = log.byType("state").filter((e) => e.type === "state" && e.busy === false).length;
    const first = await sessions.prompt(id, "第一轮：只回答 ok");
    expect(first.ok).toBe(true);
    expect(first.messageId).toContain(":p1");
    await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-3"));
    // 每轮跑完的标志：这一轮置忙之后**第一次** busy 归零（别去数启动期的那些态 —— 数量随加载而变）
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 1);
    expect(sessions.snapshot(id).busy).toBe(false);

    // 第二轮：**同一个子进程**（tag 一样）接着发
    const second = await sessions.prompt(id, "第二轮：还是回答 ok");
    expect(second.ok).toBe(true);
    expect(second.messageId).toContain(":p2");
    expect(second.messageId?.split(":")[0]).toBe(first.messageId?.split(":")[0]);
    // 第二轮的收尾帧（msg-6 是第二轮的最终回答，第一轮是 msg-3）—— 两轮的帧分得开
    const answered = await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-6"));
    expect(answered.type === "message_end" ? answered.text : "").toBe("ok");
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 2); // 第二轮跑完

    const snapshot = sessions.snapshot(id);
    expect(snapshot.status).toBe("running"); // 两轮之间会话没被结束
    expect(snapshot.busy).toBe(false);
    expect(snapshot.ompSessionId).toBe("fake-session-1");
    expect(snapshot.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(snapshot.messages[0]?.text).toBe("第一轮：只回答 ok");
    expect(snapshot.messages[4]?.text).toBe("第二轮：还是回答 ok");
    expect(calls).toHaveLength(1); // 只起过一个子进程：不是"一轮一个进程"
    expect(sessions.isLive(id)).toBe(true);
    expect(log.byType("error")).toEqual([]);
    expect(log.events.some((e) => e.type === "notice" && e.message === "omp 会话已退出")).toBe(false);

    await sessions.stop(id);
    expect(sessions.snapshot(id).status).toBe("ended");
  });

  it("服务重启后再「启动会话」：默认拿卡片上留的会话文件 -r 续接（同一段对话、同一会话身份）", async () => {
    const { store, dir } = makeStore();
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), dir);
    const id = openCard(store, dir);

    // 重启前：起会话 → 停（stopAll 也是这条路径：关 stdin → omp 自己退）
    const before = makeSessions(store, "normal", [], fixture);
    const beforeLog = new EventLog();
    before.subscribe(id, beforeLog.push);
    await before.start(id);
    await beforeLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await before.stop(id);
    expect(store.getCard(id)?.session?.state).toBe("ended");
    expect(store.getCard(id)?.session?.file).toBe(fixture);

    // 重启后（注册表是空的）：没被显式要求续接，也该接着原会话 —— 而不是从零开始
    const calls: StartRpcOptions[] = [];
    const after = makeSessions(store, "normal", calls, fixture);
    const log = new EventLog();
    after.subscribe(id, log.push);
    await after.start(id);
    const ready = await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe(fixture);
    expect(ready.type === "ready" ? ready.ompSessionId : null).toBe("fake-session-1");
    expect(after.snapshot(id).status).toBe("running");
    // 同 sessionId 重新 claim：卡片绑的还是同一个会话，cwd 也没变
    expect(store.getCard(id)?.session?.id).toBe("fake-session-1");
    expect(store.getCard(id)?.session?.cwd).toBe(dir);
    expect(store.getCard(id)?.state).toBe("working");
    expect(log.byType("notice")).toEqual([]); // 顺顺当当续上，没有降级要解释
    await after.stop(id);
  });

  it("`fresh: true` 起新对话；会话文件不在了就说一句再起新的（不静默降级）", async () => {
    // A) 显式 fresh：卡片上有会话文件也不续
    {
      const { store, dir } = makeStore();
      const fixture = writeSessionFixture(join(dir, "omp-sessions"), dir);
      const id = openCard(store, dir);
      const first = makeSessions(store, "normal", [], fixture);
      const firstLog = new EventLog();
      first.subscribe(id, firstLog.push);
      await first.start(id);
      await firstLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
      await first.stop(id);

      const calls: StartRpcOptions[] = [];
      const second = makeSessions(store, "normal", calls, fixture);
      const log = new EventLog();
      second.subscribe(id, log.push);
      await second.start(id, { fresh: true });
      await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
      expect(calls[0]?.args ?? []).not.toContain("-r");
      expect(log.byType("notice")).toEqual([]); // 是你自己要新的，不用解释
      await second.stop(id);
    }

    // B) 会话文件已经不在了：退化成新会话，但要把原因说出来
    {
      const { store, dir } = makeStore();
      const gone = join(dir, "gone.jsonl");
      const id = openCard(store, dir);
      const first = makeSessions(store, "normal", [], gone);
      const firstLog = new EventLog();
      first.subscribe(id, firstLog.push);
      await first.start(id);
      await firstLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
      await first.stop(id);
      expect(store.getCard(id)?.session?.file).toBe(gone);

      const calls: StartRpcOptions[] = [];
      const second = makeSessions(store, "normal", calls, gone);
      const log = new EventLog();
      second.subscribe(id, log.push);
      await second.start(id);
      await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
      expect(calls[0]?.args ?? []).not.toContain("-r");
      const notice = log.byType("notice")[0];
      expect(notice?.type === "notice" ? notice.message : "").toContain("会话文件不在了");
      await second.stop(id);
    }
  });

  it("会话文件头里的 cwd 跟这次要跑的目录对不上：不硬续（否则会在别的目录里跑）并说清", async () => {
    const { store, dir } = makeStore();
    const other = join(dir, "别处");
    mkdirSync(other, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), dir);
    const id = openCard(store, dir);
    const first = makeSessions(store, "normal", [], fixture);
    const firstLog = new EventLog();
    first.subscribe(id, firstLog.push);
    await first.start(id);
    await firstLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await first.stop(id);

    // 会话文件还在、id 也对，但头里的 cwd 已经不是这次要跑的目录（比如卡片换了 worktree）。
    // 头是 writeSessionFixture 用 JSON.stringify 写的，cwd 是最后一个键 —— 直接替换这一段。
    writeFileSync(fixture, readFileSync(fixture, "utf8").replace(`"cwd":"${dir}"`, `"cwd":"${other}"`));

    const calls: StartRpcOptions[] = [];
    const second = makeSessions(store, "normal", calls, fixture);
    const log = new EventLog();
    second.subscribe(id, log.push);
    await second.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    expect(calls[0]?.args ?? []).not.toContain("-r");
    const notice = log.byType("notice")[0];
    expect(notice?.type === "notice" ? notice.message : "").toContain(other);
    expect(second.snapshot(id).cwd).toBe(dir);
    await second.stop(id);
  });
});

// ---------------------------------------------------------------- 手动起会话：brief 文件 + kickoff

describe("手动起会话（session/start）：brief 总是写、kickoff 只在新会话投", () => {
  /** 卡片当下的开工提示全文（手动起会话写的必须就是这一份 —— 与自动开工同一个 `cardBrief`）。 */
  const briefOf = (store: Store, id: string): string => {
    const card = store.getCard(id) as Card;
    return cardBrief({ card, project: store.getProject(card.projectId) });
  };
  /** 「当前状态」一行会随会话 claim / 结束变（不是这几条测试要验的）：比内容时先摘掉它。 */
  const withoutState = (text: string): string => text.replace(/^\*\*当前状态\*\*：.*$/m, "");

  it("新会话：先落 brief 文件，第一条 prompt 就是 kickoff（与自动开工同一句）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const briefDir = join(dir, "data", "briefs");
    const briefPath = join(briefDir, `${id}.md`);
    const calls: StartRpcOptions[] = [];
    const sessions = makeSessionsWithBriefDir(store, "normal", briefDir, calls);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    // 手动起会话（端点只给 cwd，没人给 kickoff）；起会话**之前**的卡片快照 = 提示里该有的现状
    const before = store.getCard(id) as Card;
    const expected = cardBrief({ card: before, project: store.getProject(before.projectId) });
    expect(await sessions.start(id)).toEqual({ ok: true, status: "starting", cwd: dir });

    // ① 提示文件已经落在那儿，内容与 `cardBrief` 一字不差（claim 要等子进程 ready，此刻还没动过状态）
    const brief = readFileSync(briefPath, "utf8");
    expect(brief).toBe(expected);
    expect(brief).toContain("☑︎ 接下来你要做的");

    // ② 第一条 prompt 就是那句 kickoff（文案与自动开工完全一致，见 `briefKickoff`）
    const kickoff = briefKickoff(briefPath);
    expect(kickoff).toBe(
      `开工：第一步先 read \`${briefPath}\`，按里面「☑︎ 接下来你要做的」逐步执行，每步用 \`flowcard comment\` 留痕。`,
    );
    const echoed = await log.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(echoed.type === "message_end" ? echoed.text : null).toBe(kickoff);
    expect(calls[0]?.args ?? []).not.toContain("-r"); // 新会话：argv 里没有 `-r`
    expect(sessions.snapshot(id).messages[0]?.text).toBe(kickoff);
    await sessions.stop(id);
  });

  it("续接（-r）：不投 kickoff，但 brief 被刷新成当下的现状", async () => {
    const { store, dir } = makeStore();
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), dir);
    const id = openCard(store, dir);
    const briefDir = join(dir, "data", "briefs");
    const briefPath = join(briefDir, `${id}.md`);

    // 先手动起一次（新会话）：kickoff 进转录、提示落盘
    const first = makeSessionsWithBriefDir(store, "normal", briefDir, [], fixture);
    const firstLog = new EventLog();
    first.subscribe(id, firstLog.push);
    await first.start(id);
    await firstLog.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    const kickoff = briefKickoff(briefPath);
    const echoed = await firstLog.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(echoed.type === "message_end" ? echoed.text : null).toBe(kickoff);
    await first.stop(id);

    // 卡片现状变了（多一条推送记录）：提示写的是"当下的现状"，不该是历史
    const before = readFileSync(briefPath, "utf8");
    expect(before).not.toContain("已有 1 条推送记录");
    store.execute({ cmd: "push", actor: HUMAN, card: id, sha: "abc1234" });

    // 再手动起一次：默认 `-r` 续接同一条会话
    const calls: StartRpcOptions[] = [];
    const second = makeSessionsWithBriefDir(store, "normal", briefDir, calls, fixture);
    const log = new EventLog();
    second.subscribe(id, log.push);
    await second.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe(fixture); // 真续接了：这次不是新会话

    // 续接**不投** kickoff（上下文里已经躺着它）：显式发一句并等它跑完，转录里 user 就该只有这两条
    const sent = await second.prompt(id, "接着干");
    expect(sent.ok).toBe(true);
    await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-3"));
    expect(second.snapshot(id).messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual([
      kickoff,
      "接着干",
    ]);
    expect(log.byType("error")).toEqual([]);

    // 但提示**被刷新**了：按当下的卡片现状重写（内容 = `cardBrief`，状态那行除外）
    const refreshed = readFileSync(briefPath, "utf8");
    expect(refreshed).not.toBe(before);
    expect(refreshed).toContain("已有 1 条推送记录（最新 abc1234）");
    expect(withoutState(refreshed)).toBe(withoutState(briefOf(store, id)));
    await second.stop(id);
  });

  it("HTTP 端点：`POST .../session/start`（端上只给 cwd）就走这条规则", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const briefDir = join(dir, "data", "briefs");
    const briefPath = join(briefDir, `${id}.md`);
    const sessions = makeSessionsWithBriefDir(store, "normal", briefDir);
    const log = new EventLog();
    sessions.subscribe(id, log.push);
    const app = createApp(store, { sessions });

    const res = await app.request(`/api/cards/${id}/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true, status: "starting", cwd: dir });

    // 提示文件已落盘、第一条 prompt 就是 kickoff —— 端上没传任何 brief/kickoff 参数
    expect(readFileSync(briefPath, "utf8")).toContain("## ☑︎ 接下来你要做的");
    const echoed = await log.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(echoed.type === "message_end" ? echoed.text : null).toBe(briefKickoff(briefPath));
    await sessions.stop(id);
  });

  it("autostart 那条路不变：显式 kickoff 照原样投，配了 briefDir 也不会多投一句", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessionsWithBriefDir(store, "normal", join(dir, "data", "briefs"));
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    // autostart 的形状：自己写好提示文件 + 自带 kickoff 文案；start 照原样投它
    const mine = "开工：第一步先 read `/data/briefs/x.md`，按里面的待办走。";
    await sessions.start(id, { kickoff: mine });
    const echoed = await log.waitFor((e) => e.type === "message_end" && e.role === "user");
    expect(echoed.type === "message_end" ? echoed.text : null).toBe(mine);
    await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-3")); // 这一轮跑完

    const users = sessions.snapshot(id).messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toEqual([mine]); // 只有这一句：没被再补一句自动生成的
    // 提示文件也照旧由 flowcard 管着（这次是 start 自己写的）
    expect(readFileSync(join(dir, "data", "briefs", `${id}.md`), "utf8")).toContain("☑︎ 接下来你要做的");
    await sessions.stop(id);
  });
});

// ---------------------------------------------------------------- HTTP 端点 + 每卡 SSE

describe("HTTP：会话端点与每卡 SSE", () => {
  it("start / prompt / abort / stop / GET 现况 + SSE 推事件", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "normal");
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const url = (suffix: string): string => `/api/cards/${id}/session${suffix}`;

    // 卡片不存在：404（不是 5xx）
    expect((await app.request("/api/cards/c404/session")).status).toBe(404);
    expect((await app.request("/api/cards/c404/session/stream")).status).toBe(404);
    // 还没起会话：现况是 stopped，转录为空
    const before = await (await app.request(url(""))).json();
    expect(before).toEqual({ status: "stopped", cwd: dir, busy: false, messages: [] });

    // 先在 SSE 上等着，再起会话 —— 前几帧就该是 ready + state
    const stream = await app.request(url("/stream"));
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("没有可读的 SSE body");
    const decoder = new TextDecoder();
    const seen = new SseReader(decoder, reader);
    const primed = await seen.until("event: state");
    expect(primed).toContain("event: ready");
    expect(primed).toContain('"status":"stopped"');

    const started = await app.request(url("/start"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ cwd: dir }),
    });
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ ok: true, status: "starting", cwd: dir });

    const readyFrames = await seen.until('"ompSessionId":"fake-session-1"');
    expect(readyFrames).toContain("event: ready");

    // 发一轮：SSE 上能看到用户 echo、助手增量、工具输出
    const prompted = await app.request(url("/prompt"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "只回答：ok" }),
    });
    expect(prompted.status).toBe(200);
    const promptBody = (await prompted.json()) as { ok: boolean; messageId?: string };
    expect(promptBody.ok).toBe(true);
    expect(promptBody.messageId).toContain(":p1");
    const frames = await seen.until("event: tool");
    expect(frames).toContain("event: message");
    expect(frames).toContain('"textDelta":"先"');
    expect(frames).toContain('"name":"bash"');
    const endFrames = await seen.until('"text":"ok"');
    expect(endFrames).toContain("event: message_end");

    // 现况：转录与卡片身份都对得上
    const snapshot = (await (await app.request(url(""))).json()) as {
      status: string;
      ompSessionId?: string;
      messages: { role: string; text?: string }[];
    };
    expect(snapshot.status).toBe("running");
    expect(snapshot.ompSessionId).toBe("fake-session-1");
    expect(snapshot.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    // 空消息 400、坏 body 400
    expect(
      (
        await app.request(url("/prompt"), {
          method: "POST",
          headers: json,
          body: JSON.stringify({ text: "  " }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(url("/start"), {
          method: "POST",
          headers: json,
          body: JSON.stringify({ cwd: "" }),
        })
      ).status,
    ).toBe(400);

    expect((await app.request(url("/abort"), { method: "POST" })).status).toBe(200);
    const stopped = await app.request(url("/stop"), { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ ok: true });
    const after = (await (await app.request(url(""))).json()) as { status: string };
    expect(after.status).toBe("ended");
    await reader.cancel();
  });

  it("POST .../session/cwd：把会话搬进 new worktree（续接 + 重新 claim），坏入参/坏卡片都不 5xx", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "x");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = openCard(store, proj);
    const sessions = makeSessions(store, "normal", [], fixture);
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const cwdUrl = `/api/cards/${id}/session/cwd`;

    expect((await app.request("/api/cards/c404/session/cwd", { method: "POST", headers: json, body: JSON.stringify({ path: wt }) })).status).toBe(404);
    expect((await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({ path: "" }) })).status).toBe(400);
    expect((await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({}) })).status).toBe(400);

    // 没起过会话也能直接搬（会在新目录起一条新会话，resumed:false）
    const fresh = await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({ path: wt }) });
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as { ok?: boolean; cwd?: string; resumed?: boolean };
    expect(freshBody.ok).toBe(true);
    expect(freshBody.cwd).toBe(wt);
    expect(freshBody.resumed).toBe(false);

    // 目录不存在 → 409 + NO_CWD（不是 5xx）
    const missing = await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({ path: join(dir, "没有这个目录") }) });
    expect(missing.status).toBe(409);
    const missingBody = (await missing.json()) as { ok?: boolean; error?: { code?: string } };
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error?.code).toBe("NO_CWD");
  });
});

/** 读 SSE：累积解码文本，直到出现某个标记（或超时）。 */
class SseReader {
  #text = "";
  constructor(
    private readonly decoder: TextDecoder,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async until(marker: string, timeoutMs = 4_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#text.includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error(`SSE 里等不到 ${marker}；已有：${this.#text.slice(-400)}`);
      }
      const chunk = await this.reader.read();
      if (chunk.done === true) throw new Error(`SSE 提前结束；已有：${this.#text.slice(-400)}`);
      this.#text += this.decoder.decode(chunk.value);
    }
    return this.#text;
  }
}

describe("删会话：停进程 + 清转录 + 清卡片会话事实（omp 的会话文件保留）", () => {
  it("删掉后转录空、status=stopped、卡片 session=null；再 start 是全新对话（无 -r）；重复删幂等", async () => {
    const { store, dir } = makeStore();
    // 卡片上留一份**对得上**的会话文件：没有删除的话，第二次 start 会用它 `-r` 续接。
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), dir);
    const id = openCard(store, dir);
    const calls: StartRpcOptions[] = [];
    // `FAKE_OMP_FRESH_ID=1`：假 omp 起新对话时给一个新 sessionId（真 omp 就是这样）——
    // 否则删除前后两次 claim 的身份完全一样，claim 的幂等键会撞上、被去重静默吞掉。
    const sessions = makeSessions(store, "normal", calls, fixture, { FAKE_OMP_FRESH_ID: "1" });
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const url = (suffix: string): string => `/api/cards/${id}/session${suffix}`;

    const log = new EventLog();
    sessions.subscribe(id, log.push);
    const started = await sessions.start(id, { kickoff: "第一句" });
    expect(started.ok).toBe(true);
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    // 前置：会话起来了、卡片绑上了（含会话文件）、转录有内容
    expect(sessions.isLive(id)).toBe(true);
    const firstId = store.getCard(id)?.session?.id ?? "";
    expect(firstId).toMatch(/^fresh-/);
    expect(store.listSessionMessages(id).length).toBeGreaterThan(0);
    expect(store.getCard(id)?.session?.file).toBe(fixture);
    // 攒着等这个会话的审批通知：删会话时该清掉（`delivered` 留着，别在新会话里重复打扰）。
    store.setApprovalLedger(id, {
      delivered: ["gate:G1"],
      pending: [{ key: "gate:G2", text: "通知", at: "2026-10-10T00:00:00.000Z" }],
    });

    // 删会话（无 body）：200 + { ok: true }
    const deleted = await app.request(url("/delete"), { method: "POST", headers: json, body: "{}" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });

    // ① GET .../session：转录为空、status=stopped（进程也停了）
    const after = (await (await app.request(url(""))).json()) as { status: string; messages: unknown[] };
    expect(after.status).toBe("stopped");
    expect(after.messages).toEqual([]);
    expect(store.listSessionMessages(id)).toEqual([]);
    expect(sessions.isLive(id)).toBe(false);

    // ② 卡片上的会话事实清掉（`session = null`），一条 `session.deleted` 事件
    expect(store.getCard(id)?.session).toBe(null);
    expect(store.listEventsOfCard(id, "session.deleted").map((e) => e.type)).toEqual(["session.deleted"]);
    // pending 清掉、delivered 留着
    expect(store.getApprovalLedger(id)).toEqual({ delivered: ["gate:G1"], pending: [] });

    // ③ 幂等：没会话可删时重复删不报错，也不会再写第二条 `session.deleted`
    const again = await app.request(url("/delete"), { method: "POST", headers: json, body: "{}" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(store.listEventsOfCard(id, "session.deleted")).toHaveLength(1);
    expect(store.getCard(id)?.session).toBe(null);

    // ④ 再 start：卡片不再记会话文件 → argv 里没有 `-r`，是一段全新的对话（新的 omp sessionId）
    const readyBefore = log.byType("ready").length;
    const restarted = await sessions.start(id, {});
    expect(restarted.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args ?? []).not.toContain("-r");
    expect(calls[1]?.args ?? []).not.toContain("-r");
    await log.waitForNth((e) => e.type === "ready", readyBefore + 1);
    const secondId = store.getCard(id)?.session?.id ?? "";
    expect(secondId).toMatch(/^fresh-/);
    expect(secondId).not.toBe(firstId); // 全新的一段对话（不是续接回来的同一条）

    // 卡片不存在：404（不是 5xx）
    expect((await app.request("/api/cards/c404/session/delete", { method: "POST", headers: json, body: "{}" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------- 忙时引导（steer）/ 中断（abort）

/**
 * 用户要的：**会话正忙时说话 = 中途引导 AI**（omp 的 `steer`），不是干等它忙完。
 * 协议语义见 `docs/omp-rpc.md` §3.2；这里用假 omp 真管道断言 stdin 里到底是 `steer` 还是 `prompt`。
 */
describe("忙时引导（steer）与中断（abort）", () => {
  /** 假 omp 收到的命令日志（每行一条 JSON：`{type,id,message,streamingBehavior}`）。 */
  function readCommands(file: string): Array<{ type: string; id?: string; message?: string; streamingBehavior?: string }> {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; message?: string });
  }

  it("忙时说话默认就是引导：stdin 收到的是 steer（不是 prompt），不被 busy 拦掉，会话保持忙", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const cmdLog = join(dir, "cmds.jsonl");
    const sessions = makeSessions(store, "hang", [], undefined, { FAKE_OMP_LOG: cmdLog });
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const url = (suffix: string): string => `/api/cards/${id}/session${suffix}`;
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    // 第一句把会话弄忙（hang 模式：吐半截就挂着）
    expect((await sessions.prompt(id, "请从 1 数到 500")).delivery).toBe("prompt");
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");
    expect(sessions.snapshot(id).busy).toBe(true);

    // 忙时说话：不带 steer 字段 = 默认引导（HTTP 层默认 steer:true）
    const steered = await app.request(url("/prompt"), {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "别数了，只回答 ok" }),
    });
    expect(steered.status).toBe(200); // 不是 409：忙不拦
    const steeredBody = (await steered.json()) as { ok: boolean; messageId: string; delivery: string };
    expect(steeredBody).toEqual({
      ok: true,
      messageId: expect.stringContaining(":p2"),
      delivery: "steer",
    });

    // ② omp 的排队快照（queue_update）也推给了网页：已引导、还没被读到
    //    （**先等这条**再读命令日志：日志是假 omp 子进程写的，早读会读不到那一行）
    const queue = await log.waitFor((e) => e.type === "queue");
    expect(queue.type === "queue" ? queue.steering : []).toEqual(["别数了，只回答 ok"]);

    // ① stdin 里那句是 `steer`，且**没有**第二句 `prompt`
    const commands = readCommands(cmdLog);
    const steering = commands.filter((cmd) => cmd.message === "别数了，只回答 ok");
    expect(steering.map((cmd) => cmd.type)).toEqual(["steer"]);
    expect(steering[0]?.id).toBe(steeredBody.messageId); // 我们自己的 prompt id 原样带上（转录/回显对齐用）
    expect(commands.filter((cmd) => cmd.type === "prompt")).toHaveLength(1); // 只有第一句

    // ③ 用户那句话照旧进转录 + SSE 回显；会话还是忙的（引导没结束这一轮）
    expect((await log.waitFor((e) => e.type === "message_end" && e.role === "user" && e.text === "别数了，只回答 ok"))).toBeTruthy();
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual(["请从 1 数到 500", "别数了，只回答 ok"]);
    expect(sessions.snapshot(id).busy).toBe(true);
    expect(sessions.snapshot(id).status).toBe("running");

    // ④ 忙时引导**不会**报错（对比：steer:false 那条老路会被 omp 回 busy 错，见下一个用例）
    expect(log.byType("error")).toEqual([]);

    await sessions.abort(id);
    await sessions.stop(id);
  });
});

describe("引导（steer）的连发、空闲路径与对比项", () => {
  function readCommands(file: string): Array<{ type: string; id?: string; message?: string; streamingBehavior?: string }> {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { type: string; message?: string });
  }

  it("忙时连发多条引导：一条一条进 steering 队列（FIFO、不合并、不被拒）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const cmdLog = join(dir, "cmds.jsonl");
    const sessions = makeSessions(store, "hang", [], undefined, { FAKE_OMP_LOG: cmdLog });
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await sessions.prompt(id, "请从 1 数到 500");
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");

    const sent = [
      await sessions.prompt(id, "改一", [], { steer: true }),
      await sessions.prompt(id, "改二", [], { steer: true }),
      await sessions.prompt(id, "改三", [], { steer: true }),
    ];
    expect(sent.map((r) => r.delivery)).toEqual(["steer", "steer", "steer"]);
    expect(sent.map((r) => r.messageId)).toEqual([
      expect.stringContaining(":p2"),
      expect.stringContaining(":p3"),
      expect.stringContaining(":p4"),
    ]);

    // omp 的排队快照逐条长大（1 → 2 → 3）：这是「都在队列里、没被吞掉」的证据
    //（**先等它**再读命令日志：日志是子进程写的，早读会读不到那几行）
    await log.waitFor((e) => e.type === "queue" && e.steering.length === 3);
    expect(
      log
        .byType("queue")
        .map((e) => (e.type === "queue" ? e.steering.length : 0)),
    ).toEqual([1, 2, 3]);

    // 三条各成一帧、顺序不变、没有被合并成一条，也没有被拒绝
    const steers = readCommands(cmdLog).filter((cmd) => cmd.type === "steer");
    expect(steers.map((cmd) => cmd.message)).toEqual(["改一", "改二", "改三"]);

    expect(log.byType("error")).toEqual([]);
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual([
      "请从 1 数到 500",
      "改一",
      "改二",
      "改三",
    ]);
    expect(sessions.snapshot(id).busy).toBe(true);

    await sessions.abort(id);
    await sessions.stop(id);
  });

  it("空闲时说一句：走 prompt（带 streamingBehavior:'steer' 兜底），delivery=prompt，正常跑完一轮", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const cmdLog = join(dir, "cmds.jsonl");
    const sessions = makeSessions(store, "normal", [], undefined, { FAKE_OMP_LOG: cmdLog });
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id); // 不投 kickoff：起来就是空闲
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);

    const idle = await sessions.prompt(id, "空闲时说一句", [], { steer: true });
    expect(idle.delivery).toBe("prompt");
    // 先等这一轮真的跑完（"ok" 是假 omp 处理完 prompt 之后发的），再去读命令日志
    // —— 日志是子进程写的，早读会读不到那一行。
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    const cmd = readCommands(cmdLog).filter((c) => c.message === "空闲时说一句");
    expect(cmd.map((c) => c.type)).toEqual(["prompt"]);
    // 兜底：空闲那条也带 streamingBehavior:"steer" —— 万一这一瞬间判错，omp 会排进 steering 队列而不是回 busy 错
    expect(cmd[0]?.streamingBehavior).toBe("steer");

    expect(sessions.snapshot(id).busy).toBe(false);
    expect(
      sessions
        .snapshot(id)
        .messages.filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => m.text),
    ).toEqual(["空闲时说一句", "先跑一下", "ok"]);
    await sessions.stop(id);
  });

  it("steer:false 忙时仍是老路：omp 回 busy 错，SSE 上看到 error（默认引导要绕开的正是这条）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const cmdLog = join(dir, "cmds.jsonl");
    const sessions = makeSessions(store, "hang", [], undefined, { FAKE_OMP_LOG: cmdLog });
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await sessions.prompt(id, "请从 1 数到 500");
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");

    const refused = await sessions.prompt(id, "排队等吧", [], { steer: false });
    expect(refused.ok).toBe(true); // 命令照旧只是写进 stdin（乐观）；omp 的拒绝走 SSE
    expect(refused.delivery).toBe("prompt");
    // 先等 omp 的拒绝（证明那句 prompt 真被子进程处理了），再去读命令日志
    const failure = await log.waitFor((e) => e.type === "error");
    expect(failure.type === "error" ? failure.message : "").toContain("already processing");
    expect(readCommands(cmdLog).filter((c) => c.message === "排队等吧").map((c) => c.type)).toEqual(["prompt"]);

    await sessions.abort(id);
    await sessions.stop(id);
  });
});

describe("中断（abort）的语义与竞态", () => {
  it("忙时中断：本轮以 aborted 收尾（转录留半截）、会话不退出；空闲时是空操作；连点两次都 ok", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "hang");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await sessions.prompt(id, "请从 1 数到 500");
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");
    expect(sessions.snapshot(id).busy).toBe(true);

    const settledBefore = log.byType("state").filter((e) => e.type === "state" && e.busy === false).length;
    expect(await sessions.abort(id)).toEqual({ ok: true });
    // 中断那一轮照旧落库（半截的 "12"），并以 aborted 收尾
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "12");
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 1);
    expect(sessions.snapshot(id).busy).toBe(false);
    expect(sessions.snapshot(id).status).toBe("running"); // 会话本身没退出
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual(["请从 1 数到 500", "12"]);

    // 空闲时 abort：omp 只回回执（空操作），不报错；连点两次也一样
    expect(await sessions.abort(id)).toEqual({ ok: true });
    expect(await sessions.abort(id)).toEqual({ ok: true });
    expect(log.byType("error")).toEqual([]);

    // 中断之后照旧能说话（同一段会话接着跑）
    const again = await sessions.prompt(id, "中断后继续");
    expect(again.delivery).toBe("prompt");
    await log.waitForNth((e) => e.type === "message" && e.textDelta === "跑一下", 2);
    expect(sessions.snapshot(id).busy).toBe(true);
    await sessions.abort(id);
    await sessions.stop(id);
  });

  it("中断与 pending 引导：steering 队列不清空 —— 排队的引导保留，并在收尾时起新的一轮", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "hang");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);
    await sessions.prompt(id, "请从 1 数到 500");
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");

    // 先引导一句（还没被模型读到就按了中断）
    expect((await sessions.prompt(id, "别数了，回答 ok", [], { steer: true })).delivery).toBe("steer");
    await log.waitFor((e) => e.type === "queue" && e.steering.length === 1);

    const settledBefore = log.byType("state").filter((e) => e.type === "state" && e.busy === false).length;
    expect(await sessions.abort(id)).toEqual({ ok: true });
    // 被中断的一轮留下半截
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "12");
    // 排队的引导没被丢掉：omp 把它跑成了新的一轮
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "引导收到");
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 1);
    expect(sessions.snapshot(id).busy).toBe(false);
    expect(sessions.snapshot(id).status).toBe("running");
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual([
      "请从 1 数到 500",
      "别数了，回答 ok",
      "12",
      "引导收到",
    ]);
    await sessions.stop(id);
  });

  it("HTTP 契约：POST /abort → 200 {ok:true}（会话不退出），中断后 POST /prompt 照旧 200", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "hang");
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const url = (suffix: string): string => `/api/cards/${id}/session${suffix}`;
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    const started = await app.request(url("/start"), { method: "POST", headers: json, body: JSON.stringify({}) });
    expect(started.status).toBe(200);
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId !== undefined);

    const first = await app.request(url("/prompt"), { method: "POST", headers: json, body: JSON.stringify({ text: "请从 1 数到 500" }) });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { delivery?: string }).delivery).toBe("prompt"); // 空闲：新起一轮
    await log.waitFor((e) => e.type === "message" && e.textDelta === "跑一下");

    const settledBefore = log.byType("state").filter((e) => e.type === "state" && e.busy === false).length;
    const aborted = await app.request(url("/abort"), { method: "POST" });
    expect(aborted.status).toBe(200);
    expect(await aborted.json()).toEqual({ ok: true });
    await log.waitForNth((e) => e.type === "state" && e.busy === false, settledBefore + 1);
    expect(((await (await app.request(url(""))).json()) as { status: string; busy: boolean }).status).toBe("running");

    // 中断后继续说话：照旧 200（会话没退出）
    const after = await app.request(url("/prompt"), { method: "POST", headers: json, body: JSON.stringify({ text: "中断后继续" }) });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { delivery?: string }).delivery).toBe("prompt");
    expect(await (await app.request(url("/stop"), { method: "POST" })).json()).toEqual({ ok: true });
  });
});
