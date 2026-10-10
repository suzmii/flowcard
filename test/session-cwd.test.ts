/**
 * 「把会话搬进 worktree」这条链路的测试：`changeCwd`（停旧进程 → 用改过 cwd 头的会话文件 `-r` 续接 →
 * 重新 claim → 卡片进「实施中」）+ `POST /api/cards/:id/session/cwd`。
 *
 * 为什么单独一个文件：`test/hosted-session.test.ts` 里的假 omp 是那份大端到端测试的私有脚手架，
 * 这里用最小的一份（只吐本功能要用到的帧），两边的会话编排都能各自演进、互不覆盖。
 * 真机上的关键结论（也写在 `writeHandoff` 的注释里，omp 18.8.7 实测）：
 *   `omp -r <file>` 拿**会话文件头里的 `cwd`** 当工作目录，`--cwd` 在续接时被忽略 ——
 *   所以换目录必须给一份改过头的会话文件，光传 `--cwd` 是白搭。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { normalizePath } from "../src/shared/paths.ts";
import { createApp } from "../src/server/app.ts";
import { createHostedSessions, type HostedSessions, type SessionEvent } from "../src/server/hosted-session.ts";
import { defaultSpawn, startRpcSession, type OmpRpcSession, type StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore, type Store } from "../src/server/store.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
/** 仓库根：`test/` 的上一层（CLI 端到端要跑真 CLI 文件）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 最小假 omp：ready → get_state/get_session_stats（报 `-r` 给的文件，照真 omp 的行为）
 * → prompt 一轮（用户消息 + 助手 "ok"）→ stdin EOF 退出。
 */
const FAKE_OMP_SOURCE = String.raw`
const NL = "\n";
const out = (obj) => { process.stdout.write(JSON.stringify(obj) + NL); };
// 真 omp 续接时 get_session_stats 报的是**被续接的那个文件**：argv 里的 -r 优先，其次 env。
const i = process.argv.indexOf("-r");
const FILE = (i >= 0 ? process.argv[i + 1] : null) || process.env.FAKE_OMP_SESSION_FILE || "/tmp/fake-omp/session.jsonl";
const SESSION_ID = process.env.FAKE_OMP_SESSION_ID || "fake-session-1";

out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let j = buf.indexOf(NL);
  while (j >= 0) {
    const line = buf.slice(0, j).replace(/\r$/, "");
    buf = buf.slice(j + 1);
    if (line.trim() !== "") handle(line);
    j = buf.indexOf(NL);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(line) {
  const cmd = JSON.parse(line);
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: SESSION_ID, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId: SESSION_ID, sessionFile: FILE, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.5 } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: "delta" } });
      return;
    case "prompt": {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      out({ type: "message_start", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }] } });
      out({ type: "message_end", messageId: "msg-1", message: { role: "user", content: [{ type: "text", text: cmd.message }], stopReason: "stop" } });
      out({ type: "agent_start" });
      out({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" } });
      out({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "ok" } });
      out({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" } });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      out({ type: "session_settled" });
      return;
    }
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: "unknown command: " + cmd.type, code: "unsupported" });
  }
}
`;

const tempDirs: string[] = [];
const liveSessions: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of liveSessions) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 真进程 + 真管道：`node -e <假 omp> <omp 的真实参数…>`（argv 透传，假 omp 才看得见 `-r`）。 */
function spawnFake(sessionFile?: string) {
  return (opts: StartRpcOptions): OmpRpcSession => {
    const session = startRpcSession({
      ...opts,
      ompPath: process.execPath,
      // `node -e <src> -- <omp 的真实参数…>`：`--` 之后 node 不再自己解析，
      // 假 omp 才能在 argv 里看见 `-r`/`--no-title` 这些旗标（少了 `--`，node 会拿它们当自己的选项报错）。
      argv: ["-e", FAKE_OMP_SOURCE, "--", ...(opts.args ?? [])],
      env: { ...opts.env, ...(sessionFile === undefined ? {} : { FAKE_OMP_SESSION_FILE: sessionFile }) },
      spawn: defaultSpawn,
    });
    liveSessions.push(session);
    return session;
  };
}

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-session-cwd-"));
  tempDirs.push(dir);
  return { store: createStore({ dataDir: join(dir, "data"), flow: personalFlow }), dir };
}

/** 开一张卡并绑一个真存在的 worktree（会话 cwd = 它）。 */
function openCard(store: Store, worktreePath: string): string {
  const id = store.execute({ cmd: "open", actor: HUMAN, title: "搬会话", body: "正文" }).card?.id ?? "";
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card: id,
    worktree: { path: worktreePath, branch: "feat/x", source: "flowcard" },
  });
  return id;
}

/** 会话注册表：`calls` 记下每次 start 拿到了什么（argv 断言用），`sessionFile` 是假 omp 报的会话文件。 */
function makeSessions(store: Store, calls: StartRpcOptions[] = [], sessionFile?: string): HostedSessions {
  return createHostedSessions({
    store,
    startSession: (opts) => {
      calls.push(opts);
      return spawnFake(sessionFile)(opts);
    },
    resolveOmpPath: async () => undefined, // 别真去 `sh -c command -v omp`
  });
}

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

  waitFor(match: (event: SessionEvent) => boolean, timeoutMs = 5_000): Promise<SessionEvent> {
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
}

/** 会话真起来（`ready` 事件带 ompSessionId）才算 claim 落库。 */
const sessionReady = (cwd: string) => (event: SessionEvent): boolean =>
  event.type === "ready" && event.ompSessionId !== undefined && event.cwd === cwd;

describe("changeCwd：把会话搬进 worktree", () => {
  it("停旧进程 → 用改过 cwd 头的会话文件 -r 续接 → 重新 claim：卡片进实施中、转录不断", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "x");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = openCard(store, proj);
    const calls: StartRpcOptions[] = [];
    const sessions = makeSessions(store, calls, fixture);
    const log = new EventLog();
    sessions.subscribe(id, log.push);

    // 起点：会话在项目根（还没进 worktree）→ 卡片进不了「实施中」
    store.execute({ cmd: "unblock", actor: HUMAN, card: id });
    await sessions.start(id, { kickoff: "开工" });
    await log.waitFor(sessionReady(proj));
    const before = sessions.snapshot(id).messages.length;
    expect(before).toBeGreaterThan(0);

    const moved = await sessions.changeCwd(id, { cwd: wt });
    expect(moved.ok).toBe(true);
    expect(moved.resumed).toBe(true);
    expect(moved.previousCwd).toBe(proj);
    expect(moved.cwd).toBe(wt);
    expect(moved.status).toBe("starting");

    // 续接文件 = 新目录对应会话目录里的副本，头里的 cwd 已改；原文件没被动过
    const handoff = join(dir, "omp-sessions", normalizePath(wt).replace(/\//g, "-"), "fake-session-1.jsonl");
    expect(moved.sessionFile).toBe(handoff);
    const headerLine = readFileSync(handoff, "utf8").split("\n").find((line) => line.includes('"type":"session"'));
    const header: unknown = JSON.parse(headerLine ?? "{}");
    expect(typeof header === "object" && header !== null && "cwd" in header ? header.cwd : undefined).toBe(wt);
    expect(readFileSync(fixture, "utf8")).toContain(`"cwd":"${proj}"`);

    // 第二次 start：cwd 是新目录，argv 带 `-r <副本>`
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cwd).toBe(wt);
    const args = calls[1]?.args ?? [];
    expect(args[args.indexOf("-r") + 1]).toBe(handoff);

    // 新会话起来 → 自己 claim（cwd 在新目录）→ 卡片进「实施中」
    await log.waitFor(sessionReady(wt));
    expect(store.getCard(id)?.session?.cwd).toBe(wt);
    expect(store.getCard(id)?.state).toBe("working");
    expect(sessions.snapshot(id).cwd).toBe(wt);

    // 转录连续：老消息还在，续接后接着往同一张卡的转录里追加
    await sessions.prompt(id, "接着干");
    await log.waitFor((e) => e.type === "message_end" && e.role === "assistant" && e.text === "ok");
    const messages = sessions.snapshot(id).messages;
    expect(messages.length).toBeGreaterThan(before);
    expect(messages.some((m) => m.text === "开工")).toBe(true);
  });

  it("会话文件读不动 → 退化成新会话，并在 note 里说清（不静默）；目录不存在/卡片不存在都明确报错", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "y");
    mkdirSync(wt, { recursive: true });
    const id = openCard(store, proj);
    const calls: StartRpcOptions[] = [];
    // 假 omp 报一个**不存在**的会话文件：读不动 → 只能新起一条
    const sessions = makeSessions(store, calls, join(dir, "gone.jsonl"));
    const log = new EventLog();
    sessions.subscribe(id, log.push);
    await sessions.start(id, { kickoff: "开工" });
    await log.waitFor(sessionReady(proj));

    const moved = await sessions.changeCwd(id, { cwd: wt });
    expect(moved.ok).toBe(true);
    expect(moved.resumed).toBe(false);
    expect(moved.sessionFile).toBeUndefined();
    expect(moved.note).toContain("续接没成");
    expect(calls[1]?.args ?? []).not.toContain("-r");
    await log.waitFor(sessionReady(wt));
    expect(store.getCard(id)?.session?.cwd).toBe(wt);

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

    // 第一个实例：起会话（claim 会把 session.file 落进卡片投影）→ 停掉
    const first = makeSessions(store, [], fixture);
    const firstLog = new EventLog();
    first.subscribe(id, firstLog.push);
    await first.start(id, { kickoff: "开工" });
    await firstLog.waitFor(sessionReady(proj));
    await first.stop(id);
    expect(store.getCard(id)?.session?.file).toBe(fixture);

    // 第二个实例（相当于重启）：注册表是空的，只能靠卡片上的 file
    const second = makeSessions(store, [], fixture);
    const log = new EventLog();
    second.subscribe(id, log.push);
    const moved = await second.changeCwd(id, { cwd: wt });
    expect(moved.resumed).toBe(true);
    expect(moved.previousCwd).toBe(proj);
    await log.waitFor(sessionReady(wt));
    expect(store.getCard(id)?.session?.cwd).toBe(wt);
    expect(store.getCard(id)?.state).toBe("working");
  });
});

describe("端到端：`flowcard worktree use` → 真服务 → 假 omp", () => {
  it("一条命令：绑 worktree、停旧会话、用新 cwd 续接、卡片进实施中（退出码 0）", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "x");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = store.execute({ cmd: "open", actor: HUMAN, title: "e2e", body: "" }).card?.id ?? "";

    const calls: StartRpcOptions[] = [];
    const sessions = makeSessions(store, calls, fixture);
    const app = createApp(store, { sessions });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("没拿到端口");
    const url = `http://127.0.0.1:${address.port}`;

    try {
      // 先在项目根起会话（还没进 worktree → 卡片进不了实施中）
      const log = new EventLog();
      sessions.subscribe(id, log.push);
      await sessions.start(id, { cwd: proj, kickoff: "开工" });
      await log.waitFor(sessionReady(proj));
      expect(store.getCard(id)?.state).not.toBe("working");

      // 真 CLI → 真 HTTP → 真编排（只有 omp 是假的）
      const cli = join(REPO_ROOT, "src", "cli", "main.ts");
      const child = spawn(process.execPath, [cli, "worktree", "use", id, "--path", wt, "--branch", "feat/x"], {
        env: { ...process.env, FLOWCARD_URL: url, FLOWCARD_PORT: "" },
      });
      const stdout: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      const out = JSON.parse(Buffer.concat(stdout).toString("utf8") || "{}") as {
        ok?: boolean;
        advanced?: boolean;
        session?: { resumed?: boolean; previousCwd?: string; cwd?: string };
      };

      expect(status).toBe(0);
      expect(out).toMatchObject({
        ok: true,
        advanced: true,
        session: { resumed: true, previousCwd: proj, cwd: wt },
      });
      // 卡片进「实施中」、会话 cwd 在新目录；续接用的是改过头的副本
      expect(store.getCard(id)?.state).toBe("working");
      expect(store.getCard(id)?.session?.cwd).toBe(wt);
      expect(store.getCard(id)?.worktree?.path).toBe(wt);
      await log.waitFor(sessionReady(wt));
      expect(calls.map((call) => call.cwd)).toEqual([proj, wt]);
      expect((calls[1]?.args ?? []).includes("-r")).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("HTTP：POST /api/cards/:id/session/cwd", () => {
  it("搬进新 worktree（认入参、认错误码，坏卡片/坏 body 都不 5xx）", async () => {
    const { store, dir } = makeStore();
    const proj = join(dir, "proj");
    const wt = join(proj, ".worktrees", "x");
    mkdirSync(wt, { recursive: true });
    const fixture = writeSessionFixture(join(dir, "omp-sessions"), proj);
    const id = openCard(store, proj);
    const sessions = makeSessions(store, [], fixture);
    const app = createApp(store, { sessions });
    const json = { "content-type": "application/json" };
    const cwdUrl = `/api/cards/${id}/session/cwd`;

    expect(
      (await app.request("/api/cards/c404/session/cwd", { method: "POST", headers: json, body: JSON.stringify({ path: wt }) })).status,
    ).toBe(404);
    expect((await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({ path: "" }) })).status).toBe(400);
    expect((await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({}) })).status).toBe(400);

    // 没起过会话也能直接搬（原会话没留下会话文件 → 在新目录起一条新会话）
    const fresh = await app.request(cwdUrl, { method: "POST", headers: json, body: JSON.stringify({ path: wt }) });
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as { ok?: boolean; cwd?: string; resumed?: boolean };
    expect(freshBody.ok).toBe(true);
    expect(freshBody.cwd).toBe(wt);
    expect(freshBody.resumed).toBe(false);

    // 目录不存在 → 409 + NO_CWD（不是 5xx）
    const missing = await app.request(cwdUrl, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ path: join(dir, "没有这个目录") }),
    });
    expect(missing.status).toBe(409);
    const missingBody = (await missing.json()) as { ok?: boolean; error?: { code?: string } };
    expect(missingBody.ok).toBe(false);
    expect(missingBody.error?.code).toBe("NO_CWD");
  });
});
