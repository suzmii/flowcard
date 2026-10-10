/**
 * 托管会话的单测 + 端到端。
 *
 * 端到端用**假 omp**（`node -e` 脚本，照 omp 18.8.7 的帧形状吐 JSONL，见 `docs/omp-rpc.md`）
 * 跑真管道：起会话 → claim → prompt → 文本/工具事件 → prompt_result → 转录落库 → 停；
 * 还覆盖 abort、子进程早退、重启后转录仍在、以及 app 上那 5 个端点 + 每卡 SSE。
 *
 * 不联网、不调模型、不碰用户的 omp 配置。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
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
 */
const FAKE_OMP_SOURCE = String.raw`
const NL = "\n";
const MODE = process.env.FAKE_OMP_MODE || "normal";
const out = (obj, done) => { process.stdout.write(JSON.stringify(obj) + NL, done); };

if (MODE !== "die-before-ready") {
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
if (MODE === "die-before-ready") { process.exit(3); }

// 乱码行不能影响会话（协议解析失败必须被丢掉）
process.stdout.write("这不是 JSON" + NL);

const sessionId = "fake-session-1";
let pending = null;
let buf = "";

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
  try { cmd = JSON.parse(line); } catch { out({ type: "response", command: "parse", success: false, error: "bad json" }); return; }
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, sessionFile: "/tmp/fake-omp/session.jsonl", tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.5 } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "abort": {
      out({ id: cmd.id, type: "response", command: "abort", success: true });
      if (pending === null) return;
      // abort 之后在途帧还会有几条（真机就这样），然后以 aborted 收尾。
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "2" } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "12" } });
      out({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "12" }], stopReason: "aborted" } });
      out({ type: "prompt_result", id: pending, agentInvoked: true, status: "aborted", sessionSettled: true });
      out({ type: "session_settled" });
      pending = null;
      return;
    }
    case "prompt": {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      pending = cmd.id;
      out({ type: "message_start", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_end", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }], stopReason: "stop" } });
      out({ type: "agent_start" });
      out({ type: "turn_start" });
      out({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先" } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "跑一下" } });
      if (MODE === "hang") return;
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "先跑一下" } });
      out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la" } });
      out({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "total 0\n" }] } });
      out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "total 0\ndrwxr-xr-x 2 u u 4096 ." }] }, isError: false });
      out({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "先跑一下" }, { type: "toolCall", id: "t1", name: "bash" }], stopReason: "toolUse" } });
      out({ type: "message_start", messageId: "msg-3", message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: "msg-3", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
      process.stdout.write("流中间的乱码" + NL);
      out({ type: "message_update", messageId: "msg-3", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" } });
      out({ type: "message_end", messageId: "msg-3", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
      out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
      out({ type: "agent_end", messages: [] });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      // 最后一帧写进管道之后再退（退出回调里 process.exit 不会截断前面已 flush 的写）
      out({ type: "session_settled" }, () => {
        if (MODE === "exit-after-turn") process.exit(0);
      });
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

/** 真进程 + 真管道，argv 换成 `node -e <假 omp>`；registry 的其余依赖照生产走。 */
function spawnFake(mode: string) {
  return (opts: StartRpcOptions): OmpRpcSession => {
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      argv: ["-e", FAKE_OMP_SOURCE],
      env: { ...opts.env, FAKE_OMP_MODE: mode },
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

function makeSessions(store: Store, mode: string): HostedSessions {
  return createHostedSessions({
    store,
    startSession: spawnFake(mode),
    resolveOmpPath: async () => undefined, // 别真去 `sh -c command -v omp`
  });
}

/** 事件日志 + 按条件等待（订阅驱动，不轮询）。 */
class EventLog {
  readonly events: SessionEvent[] = [];
  #waiters: Array<{ match: (event: SessionEvent) => boolean; resolve: (event: SessionEvent) => void }> = [];

  push = (event: SessionEvent): void => {
    this.events.push(event);
    const index = this.#waiters.findIndex((waiter) => waiter.match(event));
    const waiter = index < 0 ? undefined : this.#waiters.splice(index, 1)[0];
    waiter?.resolve(event);
  };

  waitFor(match: (event: SessionEvent) => boolean, timeoutMs = 4_000): Promise<SessionEvent> {
    const existing = this.events.find(match);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<SessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`等不到匹配的事件（${timeoutMs}ms）；已有：${this.events.map((e) => e.type).join(",")}`));
      }, timeoutMs);
      this.#waiters.push({
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }

  byType(type: SessionEvent["type"]): SessionEvent[] {
    return this.events.filter((event) => event.type === type);
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

    expect(await sessions.abort(id)).toEqual({ ok: true });
    const aborted = await log.waitFor(
      (e) => e.type === "message_end" && e.role === "assistant" && e.text === "12",
    );
    expect(aborted.type === "message_end" ? aborted.text : "").toBe("12");
    await log.waitFor((e) => e.type === "state" && e.busy === false);
    expect(sessions.snapshot(id).busy).toBe(false);
    // abort 不是结束：会话还活着，等真正的 stop
    expect(sessions.snapshot(id).status).toBe("running");
    expect(sessions.snapshot(id).messages.map((m) => m.text)).toEqual(["请从 1 数到 500", "12"]);
    await sessions.stop(id);
    expect(sessions.snapshot(id).status).toBe("ended");
  });

  it("子进程早退：状态收尾 + 代表会话上报 end（卡片会话变 ended）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const sessions = makeSessions(store, "exit-after-turn");
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "只回答：ok" });
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    await log.waitFor((e) => e.type === "notice" && e.message === "omp 会话已退出");
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
      error: { code: "NO_SESSION", message: `卡片 ${id} 没有在跑的会话` },
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
