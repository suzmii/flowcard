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

const sessionId = "fake-session-1";
// 挂着的那一轮：{ promptId, msgId }（abort 时照着它收尾）。
let pending = null;
let buf = "";
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

function handleLine(line) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { out({ type: "response", command: "parse", success: false, error: "bad json" }); return; }
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
      if (pending === null) return;
      // abort 之后在途帧还会有几条（真机就这样），然后以 aborted 收尾。
      out({ type: "message_update", messageId: pending.msgId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "2" } });
      out({ type: "message_update", messageId: pending.msgId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "12" } });
      out({ type: "message_end", messageId: pending.msgId, message: { role: "assistant", content: [{ type: "text", text: "12" }], stopReason: "aborted" } });
      out({ type: "prompt_result", id: pending.promptId, agentInvoked: true, status: "aborted", sessionSettled: true });
      out({ type: "session_settled" });
      pending = null;
      return;
    }
    case "prompt": {
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
function spawnFake(mode: string, sessionFile?: string) {
  return (opts: StartRpcOptions): OmpRpcSession => {
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      // omp 的真实参数（`-r`/`--append-system-prompt`…）跟着脚本一起透传，假 omp 才看得见它们。
      // `--` 不能省：不然 node 会把 `--no-title` 之类当自己的选项，直接报错退出（起不来）。
      argv: ["-e", FAKE_OMP_SOURCE, "--", ...(opts.args ?? [])],
      env: {
        ...opts.env,
        FAKE_OMP_MODE: mode,
        ...(sessionFile === undefined ? {} : { FAKE_OMP_SESSION_FILE: sessionFile }),
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

function makeSessions(store: Store, mode: string, calls: StartRpcOptions[] = [], sessionFile?: string): HostedSessions {
  return createHostedSessions({
    store,
    startSession: (opts) => {
      calls.push(opts);
      return spawnFake(mode, sessionFile)(opts);
    },
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

  /**
   * 等**第 `nth` 次**匹配的事件（`waitFor` 只认第一次）—— 多轮对话要靠这个数着等：
   * 每轮结束都会推一条 `state{busy:false}`，只按形状等就分不清是哪一轮。
   */
  waitForNth(match: (event: SessionEvent) => boolean, nth: number, timeoutMs = 4_000): Promise<SessionEvent> {
    const seen = this.events.filter(match);
    if (seen.length >= nth) return Promise.resolve(seen[nth - 1] as SessionEvent);
    let remaining = nth - seen.length;
    return this.waitFor((event) => {
      if (!match(event)) return false;
      remaining -= 1;
      return remaining <= 0;
    }, timeoutMs);
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
    const first = await sessions.prompt(id, "第一轮：只回答 ok");
    expect(first.ok).toBe(true);
    expect(first.messageId).toContain(":p1");
    await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-3"));
    // 每轮跑完的标志：busy 归零（第 1 次是 ready 之后那拍，第 2 次才是第一轮跑完）
    await log.waitForNth((e) => e.type === "state" && e.busy === false, 2);
    expect(sessions.snapshot(id).busy).toBe(false);

    // 第二轮：**同一个子进程**（tag 一样）接着发
    const second = await sessions.prompt(id, "第二轮：还是回答 ok");
    expect(second.ok).toBe(true);
    expect(second.messageId).toContain(":p2");
    expect(second.messageId?.split(":")[0]).toBe(first.messageId?.split(":")[0]);
    // 第二轮的收尾帧（msg-6 是第二轮的最终回答，第一轮是 msg-3）—— 两轮的帧分得开
    const answered = await log.waitFor((e) => e.type === "message_end" && e.id.endsWith(":msg-6"));
    expect(answered.type === "message_end" ? answered.text : "").toBe("ok");
    await log.waitForNth((e) => e.type === "state" && e.busy === false, 3); // 第 3 次 = 第二轮跑完

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
