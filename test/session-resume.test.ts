/**
 * A 的回归：**会话要能一直对话**（多轮），进程没了也别让会话永久作废。
 *
 * 真机事实（见 docs/omp-rpc.md §8 与本次取证）：omp 的 rpc 模式**不会**在一轮结束
 * （`prompt_result{sessionSettled:true}` + `session_settled`）之后自己退出，它只认 stdin EOF；
 * 反过来说，子进程一旦没了（崩溃、或服务重启时 `stopAll()` 关掉 stdin），会话就再也接不上了 ——
 * 本文件盯的就是这件事：
 *   1. 一轮结束后子进程还在，下一条 prompt 进**同一个**会话（不重启、不换 sessionId）；
 *   2. 子进程没了（崩溃/服务重启）→ 下一条 prompt 自动 `-r <会话文件>` 续接**同一条**会话；
 *   3. 用户点过「停止」→ 不再续接（那才是人的明确意图）；
 *   4. 没有会话文件 → 不偷偷换一条新会话，直接把原因说出来；
 *   5. `session_settled` 的语义是「这一程静下来了」，**不是「会话结束了」**：
 *      `prompt_result{sessionSettled:false}` 时 busy 得挂着，等 `session_settled` 才落。
 *
 * 用假 omp（`node -e` 脚本，帧形状照 omp 18.8.7）跑真管道：不联网、不调模型。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createHostedSessions, type HostedSessions, type SessionEvent } from "../src/server/hosted-session.ts";
import { defaultSpawn, startRpcSession, type OmpRpcSession, type StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore, type Store } from "../src/server/store.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const SESSION_ID = "resume-session-1";

/**
 * 假 omp。`FAKE_MODE`：
 *   normal          —— 一轮一轮答下去，进程不走
 *   die-after-turn  —— 答完**第一轮**就自己退，且**只死一次**（marker 文件记着）：续接起来的那条要活下来
 *                      （模拟崩溃/服务重启；`stopAll()` 在客户端看来一样）
 *   not-settled     —— 第一轮的 `prompt_result.sessionSettled:false`，过 400ms 才补 `session_settled`
 * `FAKE_RESUME_FILE` 空 = 这条会话不留会话文件（测"续接不了"那一路）。
 */
const FAKE_OMP_SOURCE = String.raw`
const fs = require("node:fs");
const NL = "\n";
const MODE = process.env.FAKE_MODE || "normal";
const MARKER = process.env.FAKE_DIE_MARKER || "";
const SID = process.env.FAKE_SESSION_ID || "resume-session-1";
const FILE = process.env.FAKE_RESUME_FILE || "";
const out = (o, cb) => { process.stdout.write(JSON.stringify(o) + NL, cb); };

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
process.stdout.write("这不是 JSON" + NL);   // 乱码行不该影响会话

let rounds = 0;
let seq = 0;
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
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: SID, isStreaming: false, isSettled: true } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: {
        sessionId: SID, ...(FILE === "" ? {} : { sessionFile: FILE }), tokens: { total: 11 }, cost: 0,
      } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "prompt":
      answer(cmd.id, cmd.message);
      return;
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown command: " + cmd.type, code: "unsupported" });
  }
}

function answer(id, message) {
  rounds += 1;
  const notSettled = MODE === "not-settled" && rounds === 1;
  out({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
  const mid = "msg-" + (++seq);
  const text = "答：" + message;
  out({ type: "message_start", messageId: mid, message: { role: "assistant", content: [] } });
  out({ type: "message_update", messageId: mid, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  out({ type: "message_update", messageId: mid, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text } });
  out({ type: "message_end", messageId: mid, message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
  out({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: !notSettled });
  if (notSettled) {
    // 后台还有活：过一会儿才静下来（这期间 busy 得挂着）。
    // 真实计时器是故意的：这是**另一个进程**里的假 omp，测试侧的假时钟驱动不了它。
    setTimeout(() => out({ type: "session_settled" }), 400);
    return;
  }
  out({ type: "session_settled" }, () => {
    // 只死一次：续接起来的那个进程要活下来（真机上 omp 就是这样）
    if (MODE === "die-after-turn" && rounds === 1 && MARKER !== "" && !fs.existsSync(MARKER)) {
      fs.writeFileSync(MARKER, "died");
      process.exit(0);
    }
  });
}
`;

// ---------------------------------------------------------------- 脚手架

const tempDirs: string[] = [];
const live: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of live) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

type SpawnRecord = { cwd: string; args: string[] };

/**
 * 真进程 + 真管道（`node -e <假 omp>`），并把每次 spawn 的 cwd/args 记下来 ——
 * 「续接是不是真的重启了进程、是不是带了 `-r <会话文件>`」就靠它断言。
 */
function spawnFake(
  mode: string,
  resumeFile: string,
  spawns: SpawnRecord[],
  dieMarker = "",
): (opts: StartRpcOptions) => OmpRpcSession {
  return (opts: StartRpcOptions): OmpRpcSession => {
    spawns.push({ cwd: opts.cwd, args: [...(opts.args ?? [])] });
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      argv: ["-e", FAKE_OMP_SOURCE],
      env: {
        ...opts.env,
        FAKE_MODE: mode,
        FAKE_SESSION_ID: SESSION_ID,
        FAKE_RESUME_FILE: resumeFile,
        FAKE_DIE_MARKER: dieMarker,
      },
      spawn: defaultSpawn,
    });
    live.push(session);
    return session;
  };
}

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-resume-"));
  tempDirs.push(dir);
  return { store: createStore({ dataDir: join(dir, "data"), flow: personalFlow }), dir };
}

function openCard(store: Store, worktreePath: string): string {
  const opened = store.execute({ cmd: "open", actor: HUMAN, title: "多轮会话", body: "正文" });
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
  resumeFile: string,
  spawns: SpawnRecord[],
  dieMarker = "",
): HostedSessions {
  return createHostedSessions({
    store,
    startSession: spawnFake(mode, resumeFile, spawns, dieMarker),
    resolveOmpPath: async () => undefined, // 别真去 `sh -c command -v omp`
  });
}

/** 事件日志：`mark()` 之后只认新事件（订阅会先推一条现况 `state`，别把它当"这一轮结束了"）。 */
class EventLog {
  readonly events: SessionEvent[] = [];
  #waiters: Array<{ since: number; match: (event: SessionEvent) => boolean; resolve: (event: SessionEvent) => void }> =
    [];

  push = (event: SessionEvent): void => {
    this.events.push(event);
    const index = this.#waiters.findIndex((w) => this.events.length > w.since && w.match(event));
    const waiter = index < 0 ? undefined : this.#waiters.splice(index, 1)[0];
    waiter?.resolve(event);
  };

  mark(): number {
    return this.events.length;
  }

  waitFor(match: (event: SessionEvent) => boolean, since = 0, timeoutMs = 8_000): Promise<SessionEvent> {
    const found = this.events.slice(since).find(match);
    if (found !== undefined) return Promise.resolve(found);
    // tsconfig 的 lib 是 ES2023，没有 `Promise.withResolvers`（同 `test/hosted-session.test.ts` 的写法）。
    return new Promise<SessionEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `等不到匹配的事件（${timeoutMs}ms）；已有：${this.events
              .slice(since)
              .map((e) => e.type)
              .join(",")}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.push({
        since,
        match,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
      });
    });
  }
}

/** 等"这一轮答完了"：助手消息的 `message_end`（`text` 是权威文本）。 */
function waitAnswer(log: EventLog, since: number, text: string): Promise<SessionEvent> {
  return log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === text, since);
}

/** 用户消息 id 形如 `<tag>:p<n>`；返回 `p<n>` 那一截。 */
function promptSeqOf(id: string): string {
  return id.split(":")[1] ?? "";
}

function userRows(store: Store, cardId: string): { id: string; text?: string }[] {
  return store
    .listSessionMessages(cardId)
    .filter((row) => row.role === "user")
    .map((row) => ({ id: row.messageId, ...(row.text === undefined ? {} : { text: row.text }) }));
}

// ---------------------------------------------------------------- 测试

describe("会话多轮：一轮结束不等于会话结束", () => {
  it("一轮结束后子进程还在，下一句进的是同一个会话（不重启、不换 sessionId）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const spawns: SpawnRecord[] = [];
    const sessions = makeSessions(store, "normal", "/tmp/fake-omp/session.jsonl", spawns);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    const started = await sessions.start(id, { kickoff: "第一句" });
    expect(started.ok).toBe(true);
    await waitAnswer(log, 0, "答：第一句");
    expect(sessions.snapshot(id).status).toBe("running");
    expect(spawns).toHaveLength(1);

    // ---- 第二轮：同一个子进程、同一个会话
    const since = log.mark();
    const second = await sessions.prompt(id, "第二句");
    expect(second.ok).toBe(true);
    await waitAnswer(log, since, "答：第二句");

    expect(spawns).toHaveLength(1); // 没有重启
    const snap = sessions.snapshot(id);
    expect(snap.status).toBe("running"); // 待命时不是 ended
    expect(snap.busy).toBe(false);
    expect(snap.ompSessionId).toBe(SESSION_ID);
    expect(store.getCard(id)?.session?.id).toBe(SESSION_ID);

    const rows = userRows(store, id);
    expect(rows.map((row) => row.text)).toEqual(["第一句", "第二句"]);
    // 同一个会话的转录：两条 prompt 的 id 用同一个 tag（子进程重启才会换 tag）
    expect(promptSeqOf(rows[0]?.id ?? "")).toBe("p1");
    expect(promptSeqOf(rows[1]?.id ?? "")).toBe("p2");
    expect((rows[0]?.id ?? "").split(":")[0]).toBe((rows[1]?.id ?? "").split(":")[0]);
    expect(store.listSessionMessages(id).filter((row) => row.role === "assistant")).toHaveLength(2);
  });

  it("子进程没了（崩溃 / 服务重启）→ 下一句自动 `-r` 续接同一条会话", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const file = "/tmp/fake-omp/session.jsonl";
    const spawns: SpawnRecord[] = [];
    const sessions = makeSessions(store, "die-after-turn", file, spawns, join(dir, "died.marker"));
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "第一句" });
    await waitAnswer(log, 0, "答：第一句");
    // 子进程自己退了（`stopAll()` 关 stdin 的效果一样）：状态收尾成 ended，转录留着
    await log.waitFor((e) => e.type === "notice" && e.level === "warning", 0);
    expect(sessions.snapshot(id).status).toBe("ended");
    expect(sessions.isLive(id)).toBe(false);
    expect(spawns).toHaveLength(1);

    // ---- 下一句：自动续接（不是新会话）
    const since = log.mark();
    const next = await sessions.prompt(id, "第三句");
    expect(next.ok).toBe(true);
    await waitAnswer(log, since, "答：第三句");
    // 续接起来后 bringUp 会重新 claim 并推一条 ready（那时状态才是 running）
    await log.waitFor((e) => e.type === "ready" && e.ompSessionId === SESSION_ID, since);

    expect(spawns).toHaveLength(2); // 真的重启了子进程
    expect(spawns[1]?.args).toContain("-r");
    expect(spawns[1]?.args).toContain(file); // 续接的是**原会话文件**
    expect(spawns[1]?.cwd).toBe(dir); // `-r` 时 omp 认文件头里的 cwd，客户端这边 cwd 不变

    const snap = sessions.snapshot(id);
    expect(snap.status).toBe("running");
    expect(snap.busy).toBe(false);
    expect(snap.ompSessionId).toBe(SESSION_ID);
    // 卡片事实还是同一条会话（同一个 sessionId），而且从 ended 刷回 running
    const card = store.getCard(id);
    expect(card?.session?.id).toBe(SESSION_ID);
    expect(card?.session?.state).toBe("running");
    expect(card?.session?.cwd).toBe(dir);

    // 转录连续：三轮用户消息都在，第三轮换了新 tag（omp 的 msg-N 计数是从 1 重来的）
    const rows = userRows(store, id);
    expect(rows.map((row) => row.text)).toEqual(["第一句", "第三句"]);
    expect(promptSeqOf(rows[1]?.id ?? "")).toBe("p1"); // 续接后的子进程重新从 p1 数
    expect((rows[1]?.id ?? "").split(":")[0]).not.toBe((rows[0]?.id ?? "").split(":")[0]); // tag 换过，id 不撞
  });

  it("用户点过「停止」→ 不再自动续接（要接着聊得重新起会话）", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const spawns: SpawnRecord[] = [];
    const sessions = makeSessions(store, "normal", "/tmp/fake-omp/session.jsonl", spawns);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "第一句" });
    await waitAnswer(log, 0, "答：第一句");

    const since = log.mark();
    await sessions.stop(id);
    await log.waitFor((e) => e.type === "notice" && e.message === "会话已停止", since);
    expect(sessions.snapshot(id).status).toBe("ended");

    const refused = await sessions.prompt(id, "还想聊");
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("STOPPED");
    expect(spawns).toHaveLength(1); // 一次都没重启
  });

  it("没留下会话文件 → 不偷偷换一条新会话，直接说清楚", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const spawns: SpawnRecord[] = [];
    const sessions = makeSessions(store, "die-after-turn", "", spawns, join(dir, "died.marker")); // 不给会话文件
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    await sessions.start(id, { kickoff: "第一句" });
    await waitAnswer(log, 0, "答：第一句");
    await log.waitFor((e) => e.type === "notice" && e.message.includes("续接不了"), 0);

    const refused = await sessions.prompt(id, "还想聊");
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("NO_SESSION");
    expect(refused.error?.message).toContain("没留下会话文件");
    expect(spawns).toHaveLength(1); // 没有静默起新会话
  });

  it("`session_settled` = 静下来了，不是会话结束：sessionSettled:false 时 busy 挂到 settled 才落", async () => {
    const { store, dir } = makeStore();
    const id = openCard(store, dir);
    const spawns: SpawnRecord[] = [];
    const sessions = makeSessions(store, "not-settled", "/tmp/fake-omp/session.jsonl", spawns);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    const since = log.mark();
    await sessions.start(id, { kickoff: "第一句" });
    await waitAnswer(log, since, "答：第一句");
    // 交卷了但没静默（后台还有活）：busy 得挂着
    expect(sessions.snapshot(id).busy).toBe(true);

    // `session_settled` 到了（假 omp 里是 400ms 后）→ busy 落回 false，会话照样活着
    const afterTurn = log.mark();
    await log.waitFor((e) => e.type === "state" && e.busy === false, afterTurn);
    const snap = sessions.snapshot(id);
    expect(snap.busy).toBe(false);
    expect(snap.status).toBe("running");
    expect(sessions.isLive(id)).toBe(true);

    // 静下来之后照样能接着聊（settled 不是"会话结束了"）
    const after = log.mark();
    const again = await sessions.prompt(id, "第二句");
    expect(again.ok).toBe(true);
    await waitAnswer(log, after, "答：第二句");
    expect(spawns).toHaveLength(1);
    expect(sessions.snapshot(id).status).toBe("running");
  });
});
