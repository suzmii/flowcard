/**
 * 审批 hook：人批了 / 驳了 → 自动给这张卡的托管会话投一条人话通知。
 *
 * 三层都测：
 *   1. **纯函数**：`approvalSpec`（谁触发 + 幂等键）与 `approvalNotice`（决定 + 理由 + 下一步）；
 *   2. **编排**：真 store + 假投递，覆盖幂等（同一决定只投一次）、actor 过滤、会话不在线的降级与补投、开关；
 *   3. **端到端**：假 omp（照 `hosted-session.test.ts` 的写法）起真会话，从 HTTP 上批 / 驳，
 *      断言会话侧真的收到了那两条消息，且重复决策不再打扰。
 *
 * 全程不联网、不调模型。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { approvalNotice, approvalSpec, createApprovalHooks, type ApprovalHooks } from "../src/server/approval-hooks.ts";
import { createHostedSessions, type HostedSessions, type SessionEvent } from "../src/server/hosted-session.ts";
import { defaultSpawn, startRpcSession, type OmpRpcSession, type StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore, type Store } from "../src/server/store.ts";
import type { Command, PrRef } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "s1" };
const SYSTEM = { kind: "system" as const };
/** 通知的统一抬头：端到端断言靠它把审批通知从别的 user 消息里挑出来。 */
const NOTICE_PREFIX = "【flowcard 审批通知】";

/**
 * `Promise.withResolvers` 是 ES2024，本仓 tsconfig 的 `lib` 停在 ES2023 —— 补个类型收窄
 * （与 `server/omp-rpc.ts` / `server/probe.ts` 同一写法）。
 */
const promiseLib = Promise as unknown as {
  withResolvers: <T>() => { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
};

const pr = (state: PrRef["state"]): PrRef => ({
  repo: "r",
  number: 7,
  url: "http://p/7",
  branch: "feat/x",
  state,
});

const tempDirs: string[] = [];
const live: OmpRpcSession[] = [];

afterAll(async () => {
  for (const session of live) await session.stop({ graceMs: 500, killGraceMs: 500 });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-approval-"));
  tempDirs.push(dir);
  return { store: createStore({ dataDir: join(dir, "data"), flow: personalFlow }), dir };
}

/** 每张卡的标题要不一样：`open` 的幂等键按内容指纹算，同内容的第二次 open 会被吞掉。 */
let cardSeq = 0;

/** 走到「待验收」（review）：worktree → 会话进 worktree → WIP PR → 推送 → 结束会话。 */
function toReview(store: Store, workdir: string, prState: PrRef["state"]): string {
  const opened = store.execute({
    cmd: "open",
    actor: HUMAN,
    title: `审批 hook ${++cardSeq}`,
    body: "正文",
  });
  const id = opened.card?.id ?? "";
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card: id,
    worktree: { path: workdir, branch: "feat/x", source: "flowcard" },
  });
  store.execute({
    cmd: "claim",
    actor: HUMAN,
    card: id,
    session: { harness: "omp", id: "s1", cwd: join(workdir, "x"), agentKind: "main" },
  });
  store.execute({ cmd: "bindPr", actor: HUMAN, card: id, pr: pr("open") });
  store.execute({ cmd: "push", actor: HUMAN, card: id, sha: "abc123" });
  store.execute({ cmd: "end", actor: HUMAN, card: id, sessionId: "s1" });
  store.execute({ cmd: "probePr", actor: SYSTEM, card: id, pr: pr(prState) });
  return id;
}

// ---------------------------------------------------------------- 纯函数

describe("审批通知（纯函数）", () => {
  it("通过 G4：说清决定、理由与下一步（执行 cleanup + 清现场）", () => {
    const { store, dir } = makeStore();
    const id = toReview(store, dir, "merged");

    const acceptCmd: Command = { cmd: "accept", actor: HUMAN, card: id, reason: "看过了" };
    const accept = store.execute(acceptCmd);
    const acceptSpec = approvalSpec(acceptCmd, accept.inserted);
    expect(acceptSpec?.key).toBe(`approval:${id}:accept`);
    expect(approvalNotice(acceptSpec!, accept.card!)).toContain(`${NOTICE_PREFIX}人已验收`);

    const gateCmd: Command = {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G4",
      decision: "approved",
      reason: "现场没用了",
    };
    const decided = store.execute(gateCmd);
    const gateSpec = approvalSpec(gateCmd, decided.inserted);
    expect(gateSpec?.key).toBe(`approval:${id}:gate:G4:approved`);
    const text = approvalNotice(gateSpec!, decided.card!);
    expect(text).toContain(`${NOTICE_PREFIX}人已批准清理（G4 清理确认）。`);
    expect(text).toContain("理由：现场没用了");
    expect(text).toContain(`flowcard cleanup ${id}`);
    expect(text).toContain("把现场清掉");
  });

  it("验收通过：下一步按卡片当前状态给（已合并→提清理清单；还没合并→等合并）", () => {
    const { store, dir } = makeStore();
    const mergedId = toReview(store, dir, "merged");
    const merged = store.execute({ cmd: "accept", actor: HUMAN, card: mergedId, reason: "验收通过" });
    const spec = approvalSpec(
      { cmd: "accept", actor: HUMAN, card: mergedId, reason: "验收通过" },
      merged.inserted,
    );
    expect(merged.card?.state).toBe("merged");
    const text = approvalNotice(spec!, merged.card!);
    expect(text).toContain(`${NOTICE_PREFIX}人已验收（G3 验收 通过）。`);
    expect(text).toContain("理由：验收通过");
    expect(text).toContain(`flowcard cleanup ${mergedId} --item`);

    // PR 还没合并：验收记下了，但卡片停在 review —— 下一步就该是"等合并"，不是"去清理"。
    const reviewId = toReview(store, dir, "open");
    const pending = store.execute({ cmd: "accept", actor: HUMAN, card: reviewId });
    const pendingSpec = approvalSpec({ cmd: "accept", actor: HUMAN, card: reviewId }, pending.inserted);
    expect(pending.card?.state).toBe("review");
    const pendingText = approvalNotice(pendingSpec!, pending.card!);
    expect(pendingText).toContain("等 PR 合并");
    expect(pendingText).not.toContain("--item");
  });

  it("驳回：说清「不要做什么」+ 理由 + 认为有必要就重新申请", () => {
    const { store, dir } = makeStore();
    const id = toReview(store, dir, "merged");
    store.execute({ cmd: "accept", actor: HUMAN, card: id });
    const cmd: Command = {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G4",
      decision: "rejected",
      reason: "worktree 里还有没提交的东西",
    };
    const rejected = store.execute(cmd);
    const spec = approvalSpec(cmd, rejected.inserted);
    expect(spec?.key).toBe(`approval:${id}:gate:G4:rejected`);
    const text = approvalNotice(spec!, rejected.card!);
    expect(text).toContain(`${NOTICE_PREFIX}人已驳回清理（G4 清理确认）。`);
    expect(text).toContain("理由：worktree 里还有没提交的东西");
    expect(text).toContain("不要拆现场");
    expect(text).toContain("重新提一次清单");
  });

  it("G2 远程写确认：批准说要 consume，驳回说不要执行 + 怎么重新申请", () => {
    const { store, dir } = makeStore();
    const id = toReview(store, dir, "open");
    const request = store.execute({
      cmd: "requestConfirm",
      actor: AGENT,
      card: id,
      action: "push",
      detail: "git push origin feat/x",
    });
    const cf = request.card?.confirmations[0]?.id ?? "";
    expect(cf).toBe("cf1");

    const approved = store.execute({
      cmd: "decideConfirm",
      actor: HUMAN,
      card: id,
      id: cf,
      decision: "approved",
    });
    const approveSpec = approvalSpec(
      { cmd: "decideConfirm", actor: HUMAN, card: id, id: cf, decision: "approved" },
      approved.inserted,
    );
    expect(approveSpec?.key).toBe(`approval:${id}:confirm:${cf}:approved`);
    const approveText = approvalNotice(approveSpec!, approved.card!);
    expect(approveText).toContain(`${NOTICE_PREFIX}人批准了远程写授权 ${cf}（将执行：git push origin feat/x）。`);
    expect(approveText).toContain(`flowcard confirm ${id} --consume ${cf}`);

    store.execute({ cmd: "requestConfirm", actor: AGENT, card: id, action: "merge", detail: "tea pr merge 7" });
    const rejected = store.execute({
      cmd: "decideConfirm",
      actor: HUMAN,
      card: id,
      id: "cf2",
      decision: "rejected",
      reason: "CI 还没绿",
    });
    const rejectSpec = approvalSpec(
      { cmd: "decideConfirm", actor: HUMAN, card: id, id: "cf2", decision: "rejected", reason: "CI 还没绿" },
      rejected.inserted,
    );
    const rejectText = approvalNotice(rejectSpec!, rejected.card!);
    expect(rejectText).toContain(`${NOTICE_PREFIX}人驳回了远程写授权 cf2（将执行：tea pr merge 7）。`);
    expect(rejectText).toContain("理由：CI 还没绿");
    expect(rejectText).toContain("**不要执行**");
    expect(rejectText).toContain(`flowcard confirm ${id} --request --for merge`);
  });

  it("只有人的决定才算审批；「决定没落库」的重发不算", () => {
    const { store, dir } = makeStore();
    const id = toReview(store, dir, "merged");
    store.execute({ cmd: "accept", actor: HUMAN, card: id });

    // agent 自己调 decideGate（自动化跑流程）→ 不是人的审批
    const byAgent = store.execute({
      cmd: "decideGate",
      actor: AGENT,
      card: id,
      gate: "G4",
      decision: "approved",
    });
    expect(
      approvalSpec(
        { cmd: "decideGate", actor: AGENT, card: id, gate: "G4", decision: "approved" },
        byAgent.inserted,
      ),
    ).toBeNull();

    // 重发同一条 accept：引擎跳过、一条事件都不写 → 没有新的决定
    const again = store.execute({ cmd: "accept", actor: HUMAN, card: id });
    expect(again.inserted).toHaveLength(0);
    expect(approvalSpec({ cmd: "accept", actor: HUMAN, card: id }, again.inserted)).toBeNull();

    // 别的命令（comment）不触发
    const comment = store.execute({ cmd: "comment", actor: HUMAN, card: id, body: "随便说一句" });
    expect(approvalSpec({ cmd: "comment", actor: HUMAN, card: id, body: "随便说一句" }, comment.inserted)).toBeNull();
  });
});

// ---------------------------------------------------------------- 编排（真 store + 假投递）

type Fake = {
  store: Store;
  dir: string;
  prompts: { cardId: string; text: string }[];
  comments: string[];
  live: Set<string>;
  hooks: ApprovalHooks;
};

function makeFake(opts: { enabled?: boolean } = {}): Fake {
  const { store, dir } = makeStore();
  const fake: Fake = {
    store,
    dir,
    prompts: [],
    comments: [],
    live: new Set<string>(),
    hooks: undefined as unknown as ApprovalHooks,
  };
  fake.hooks = createApprovalHooks({
    enabled: opts.enabled ?? true,
    getCard: (id) => store.getCard(id),
    isLive: (id) => fake.live.has(id),
    prompt: async (cardId, text) => {
      fake.prompts.push({ cardId, text });
      return { ok: true };
    },
    comment: (cardId, body) => {
      fake.comments.push(body);
      store.execute({ cmd: "comment", actor: SYSTEM, card: cardId, body });
    },
    ledger: {
      get: (cardId) => store.getApprovalLedger(cardId),
      set: (cardId, ledger) => store.setApprovalLedger(cardId, ledger),
    },
    // 失败只留痕：测试里不该有噪音就失败
    warn: (message) => {
      throw new Error(`不该出现警告：${message}`);
    },
  });
  return fake;
}

/** 走一遍「人在看板上做了决定」：执行命令 + 把结果交给 hook（和 `/api/commands` 里一样）。 */
async function decide(fake: Fake, cmd: Command) {
  const result = fake.store.execute(cmd);
  fake.hooks.onCommand({ cmd, card: result.card, events: result.inserted });
  await fake.hooks.settle();
  return result;
}

describe("投递编排", () => {
  it("会话在线：投一条；同一个决定再点一次不重复打扰", async () => {
    const fake = makeFake();
    const id = toReview(fake.store, fake.dir, "merged");
    fake.live.add(id);

    await decide(fake, { cmd: "accept", actor: HUMAN, card: id });
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]?.text.startsWith(NOTICE_PREFIX)).toBe(true);
    expect(fake.comments).toHaveLength(0);

    const gate: Command = { cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" };
    const first = await decide(fake, gate);
    expect(fake.prompts).toHaveLength(2);

    // 重复决策：引擎拒掉（门禁已经不是 open）→ 没有新事件 → 不再投
    const again = await decide(fake, gate);
    expect(again.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(fake.prompts).toHaveLength(2);

    // 同一次决定的事件被重放（幂等键没变）也不会再投一次
    fake.hooks.onCommand({ cmd: gate, card: first.card, events: first.inserted });
    await fake.hooks.settle();
    expect(fake.prompts).toHaveLength(2);
  });

  it("agent / 系统 actor 不触发", async () => {
    const fake = makeFake();
    const id = toReview(fake.store, fake.dir, "merged");
    fake.live.add(id);
    fake.store.execute({ cmd: "requestConfirm", actor: AGENT, card: id, action: "push", detail: "git push origin feat/x" });

    await decide(fake, { cmd: "decideConfirm", actor: AGENT, card: id, id: "cf1", decision: "approved" });
    expect(fake.prompts).toHaveLength(0);
    expect(fake.comments).toHaveLength(0);
    expect(fake.store.getApprovalLedger(id).delivered).toHaveLength(0);
  });

  it("会话不在线：写卡片评论 + 记 pending；下次会话起来补投一次，之后不重复", async () => {
    const fake = makeFake();
    const id = toReview(fake.store, fake.dir, "merged");
    fake.live.add(id);
    await decide(fake, { cmd: "accept", actor: HUMAN, card: id });

    // PR 合并之后人批了 G4 —— 会话这时候已经没了（宕机 / 被停掉）
    fake.live.delete(id);
    await decide(fake, { cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved", reason: "没用了" });

    const ledger = fake.store.getApprovalLedger(id);
    expect(ledger.pending.map((p) => p.key)).toEqual([`approval:${id}:gate:G4:approved`]);
    expect(ledger.delivered).toEqual([`approval:${id}:accept`]);
    // 评论留痕：会话不在线时，这个决定唯一的可见痕迹
    const comments = fake.store.getCard(id)?.comments ?? [];
    const notice = comments.find((c) => c.body.startsWith("【审批通知·待转达】"));
    expect(notice?.body).toContain("人已批准清理");
    expect(notice?.actor.kind).toBe("system");
    expect(fake.prompts).toHaveLength(1); // 只有在线时那条

    // 会话起来 → 补投一次
    fake.live.add(id);
    expect(await fake.hooks.flush(id)).toBe(1);
    expect(fake.prompts).toHaveLength(2);
    expect(fake.prompts[1]?.text).toContain("人已批准清理");
    expect(fake.store.getApprovalLedger(id).pending).toEqual([]);
    // 再 flush 没事发生（幂等）
    expect(await fake.hooks.flush(id)).toBe(0);
    expect(fake.prompts).toHaveLength(2);
    // 同一条评论也只留一条
    const notices = (fake.store.getCard(id)?.comments ?? []).filter((c) => c.body.startsWith("【审批通知·待转达】"));
    expect(notices).toHaveLength(1);
  });

  it("投递失败也算不在线：降级留痕，等下次再投", async () => {
    const fake = makeFake();
    const id = toReview(fake.store, fake.dir, "merged");
    fake.live.add(id);
    // 会话"活着"但投不进去（续接失败之类）
    const warnings: string[] = [];
    const failing = createApprovalHooks({
      enabled: true,
      getCard: (cid) => fake.store.getCard(cid),
      isLive: () => true,
      prompt: async () => ({ ok: false, error: { code: "NO_SESSION", message: "续不起来" } }),
      comment: (_cid, body) => fake.comments.push(body),
      ledger: {
        get: (cid) => fake.store.getApprovalLedger(cid),
        set: (cid, ledger) => fake.store.setApprovalLedger(cid, ledger),
      },
      // 失败只留痕：留痕内容要能定位到是哪张卡、为什么
      warn: (message) => warnings.push(message),
    });
    const cmd: Command = { cmd: "accept", actor: HUMAN, card: id };
    const result = fake.store.execute(cmd);
    failing.onCommand({ cmd, card: result.card, events: result.inserted });
    await failing.settle();
    expect(fake.comments).toHaveLength(1);
    expect(fake.store.getApprovalLedger(id).pending.map((p) => p.key)).toEqual([`approval:${id}:accept`]);
    expect(fake.store.getApprovalLedger(id).delivered).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(id);
    expect(warnings[0]).toContain("续不起来");
  });

  it("FLOWCARD_APPROVAL_HOOKS=0：什么都不做", async () => {
    const fake = makeFake({ enabled: false });
    const id = toReview(fake.store, fake.dir, "merged");
    await decide(fake, { cmd: "accept", actor: HUMAN, card: id });
    await decide(fake, { cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" });
    expect(fake.prompts).toHaveLength(0);
    expect(fake.comments).toHaveLength(0);
    expect(fake.store.getApprovalLedger(id)).toEqual({ delivered: [], pending: [] });
  });
});

// ---------------------------------------------------------------- 端到端（假 omp + HTTP）

/**
 * 假 omp：ready + 最小的 responses + 每收到一句 prompt 吐一条助手文本。
 * 真协议形状抄 `test/hosted-session.test.ts`（同一个 omp 18.8.7 的 JSONL 约定）。
 */
const FAKE_OMP_SOURCE = String.raw`
const fs = require("node:fs");
const NL = "\n";
// 有这条标记时：第 N 轮答完就自己退**一次**（模拟崩溃 / 服务重启），续接起来的那个进程要活下来。
const DIE_MARKER = process.env.FAKE_OMP_DIE_MARKER || "";
const DIE_AFTER_TURN = Number(process.env.FAKE_OMP_DIE_AFTER_TURN || "0");
const out = (obj) => { process.stdout.write(JSON.stringify(obj) + NL); };
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
const sessionId = "fake-approval-1";
let buf = "";
let turn = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i = buf.indexOf(NL);
  while (i >= 0) {
    const line = buf.slice(0, i).replace(/\r$/, "");
    buf = buf.slice(i + 1);
    if (line.trim() !== "") handle(line);
    i = buf.indexOf(NL);
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(line) {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  switch (cmd.type) {
    case "get_state":
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId, isStreaming: false, isSettled: true, messageCount: 0 } });
      return;
    case "get_session_stats":
      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionId, sessionFile: "/tmp/fake-approval/session.jsonl", tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } });
      return;
    case "set_event_filter":
      out({ id: cmd.id, type: "response", command: "set_event_filter", success: true, data: { events: null, messageUpdates: cmd.messageUpdates || "full" } });
      return;
    case "prompt": {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      turn += 1;
      const msgId = "msg-" + turn;
      out({ type: "message_start", messageId: msgId, message: { role: "assistant", content: [] } });
      out({ type: "message_update", messageId: msgId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "收到" } });
      out({ type: "message_end", messageId: msgId, message: { role: "assistant", content: [{ type: "text", text: "收到" }], stopReason: "stop" } });
      out({ type: "prompt_result", id: cmd.id, agentInvoked: true, status: "completed", sessionSettled: true });
      out({ type: "session_settled" });
      if (DIE_AFTER_TURN > 0 && turn >= DIE_AFTER_TURN && DIE_MARKER !== "" && !fs.existsSync(DIE_MARKER)) {
        fs.writeFileSync(DIE_MARKER, "died");
        process.exit(0);
      }
      return;
    }
    default:
      out({ id: cmd.id, type: "response", command: cmd.type, success: true });
  }
}
`;

function makeSessions(store: Store, opts: { die?: { marker: string; afterTurn: number } } = {}): HostedSessions {
  return createHostedSessions({
    store,
    startSession: (opts2: StartRpcOptions) => {
      const session = startRpcSession({
        ...opts2,
        ompPath: process.execPath,
        argv: ["-e", FAKE_OMP_SOURCE, "--", ...(opts2.args ?? [])],
        env: {
          ...opts2.env,
          ...(opts.die === undefined
            ? {}
            : {
                FAKE_OMP_DIE_MARKER: opts.die.marker,
                FAKE_OMP_DIE_AFTER_TURN: String(opts.die.afterTurn),
              }),
        },
        spawn: defaultSpawn,
      });
      live.push(session);
      return session;
    },
    resolveOmpPath: async () => undefined, // 别真去 `sh -c command -v omp`
  });
}

/** 订阅驱动地等一个会话事件（**不轮询**；超时只是失败兜底）。 */
function waitEvent(
  sessions: HostedSessions,
  cardId: string,
  match: (event: SessionEvent) => boolean,
  timeoutMs = 6_000,
): Promise<void> {
  const { promise, resolve, reject } = promiseLib.withResolvers<void>();
  // 先备好退订句柄与计时器：`subscribe` 会**同步**补一条现况，那时 `off` 还没赋值。
  let off: () => void = () => undefined;
  const timer = setTimeout(() => {
    off();
    reject(new Error(`等不到匹配的会话事件（${timeoutMs}ms）`));
  }, timeoutMs);
  off = sessions.subscribe(cardId, (event) => {
    if (!match(event)) return;
    clearTimeout(timer);
    off();
    resolve();
  });
  return promise;
}

/** 订阅里的审批通知（订阅驱动地等，不轮询）。 */
class NoticeLog {
  readonly sent: string[] = [];
  #waiters: { count: number; resolve: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(sessions: HostedSessions, cardId: string) {
    sessions.subscribe(cardId, (event: SessionEvent) => {
      if (event.type !== "message_end" || event.role !== "user") return;
      if (!event.text.startsWith(NOTICE_PREFIX)) return;
      this.sent.push(event.text);
      for (const waiter of [...this.#waiters]) {
        if (this.sent.length < waiter.count) continue;
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    });
  }

  wait(count: number, timeoutMs = 6_000): Promise<void> {
    if (this.sent.length >= count) return Promise.resolve();
    const { promise, resolve, reject } = promiseLib.withResolvers<void>();
    const timer = setTimeout(
      () => reject(new Error(`等不到第 ${count} 条审批通知；已有 ${this.sent.length} 条`)),
      timeoutMs,
    );
    this.#waiters.push({ count, resolve, timer });
    return promise;
  }
}

describe("端到端：假 omp 会话 + HTTP 上审批", () => {
  async function post(app: ReturnType<typeof createApp>, path: string, body: unknown = {}) {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  it("批准与驳回都会投到会话里；同一决定再点不重复", async () => {
    const { store, dir } = makeStore();
    const sessions = makeSessions(store);
    const app = createApp(store, { sessions, approvalHooks: { enabled: true } });

    const id = toReview(store, dir, "merged");
    // 会话真的起来（假 omp 真管道）：cwd 用临时目录，保证存在
    const started = await post(app, `/api/cards/${id}/session/start`);
    expect(started.data.ok).toBe(true);
    expect(sessions.isLive(id)).toBe(true);
    const log = new NoticeLog(sessions, id);

    // 1) 人在看板上点「验收」→ 会话收到 G3 通过
    const accepted = await post(app, "/api/commands", { cmd: "accept", actor: HUMAN, card: id, reason: "看过了" });
    expect(accepted.status).toBe(200);
    await log.wait(1);
    expect(log.sent[0]).toContain("人已验收");
    expect(log.sent[0]).toContain("理由：看过了");

    // 重复点「验收」：引擎跳过（已经验收过），不再打扰
    expect((await post(app, "/api/commands", { cmd: "accept", actor: HUMAN, card: id })).status).toBe(200);

    // 2) 点「批准清理（G4）」
    const approved = await post(app, "/api/commands", {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G4",
      decision: "approved",
      reason: "没用了",
    });
    expect(approved.status).toBe(200);
    await log.wait(2);
    expect(log.sent[1]).toContain("人已批准清理（G4 清理确认）");
    expect(log.sent[1]).toContain(`flowcard cleanup ${id}`);

    // 同一个 G4 再点一次批准：门禁已经不是 open → 409，且没有新通知
    expect(
      (await post(app, "/api/commands", { cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" }))
        .status,
    ).toBe(409);

    // 3) 驳回一条远程写申请
    await post(app, "/api/commands", {
      cmd: "requestConfirm",
      actor: AGENT,
      card: id,
      action: "push",
      detail: "git push origin feat/x",
    });
    const rejected = await post(app, "/api/commands", {
      cmd: "decideConfirm",
      actor: HUMAN,
      card: id,
      id: "cf1",
      decision: "rejected",
      reason: "CI 还没绿",
    });
    expect(rejected.status).toBe(200);
    await log.wait(3);
    expect(log.sent[2]).toContain("人驳回了远程写授权 cf1");
    expect(log.sent[2]).toContain("理由：CI 还没绿");
    expect(log.sent[2]).toContain("不要执行");

    // 重复驳回：确认已经结算 → 409，且没有新通知
    expect(
      (
        await post(app, "/api/commands", {
          cmd: "decideConfirm",
          actor: HUMAN,
          card: id,
          id: "cf1",
          decision: "rejected",
          reason: "CI 还没绿",
        })
      ).status,
    ).toBe(409);

    // 4) 再来一条真正新的决定（第二条远程写被批准）——用它把上面那些"没重复"坐实：
    //    如果重复决策真的又投了一次，这里收到的就是第 5 条而不是第 4 条。
    await post(app, "/api/commands", {
      cmd: "requestConfirm",
      actor: AGENT,
      card: id,
      action: "merge",
      detail: "tea pr merge 7",
    });
    await post(app, "/api/commands", {
      cmd: "decideConfirm",
      actor: HUMAN,
      card: id,
      id: "cf2",
      decision: "approved",
    });
    await log.wait(4);
    expect(log.sent).toHaveLength(4);
    expect(log.sent[3]).toContain("人批准了远程写授权 cf2（将执行：tea pr merge 7）。");

    // agent 自己调审批（看板外）不打扰：直接调 /api/commands 也一样
    await post(app, "/api/commands", {
      cmd: "requestConfirm",
      actor: AGENT,
      card: id,
      action: "other",
      detail: "rm -rf something",
    });
    await post(app, "/api/commands", {
      cmd: "decideConfirm",
      actor: AGENT,
      card: id,
      id: "cf3",
      decision: "approved",
    });

    // 转录（GET /api/cards/:id/session）里就该只有那 4 条通知，且都记在投递台账里
    const snapshot = (await (await app.request(`/api/cards/${id}/session`)).json()) as {
      messages: { role: string; text?: string }[];
    };
    const notices = snapshot.messages.filter((m) => m.role === "user" && m.text?.startsWith(NOTICE_PREFIX));
    expect(notices).toHaveLength(4);
    expect(store.getApprovalLedger(id).delivered).toEqual([
      `approval:${id}:accept`,
      `approval:${id}:gate:G4:approved`,
      `approval:${id}:confirm:cf1:rejected`,
      `approval:${id}:confirm:cf2:approved`,
    ]);
    expect(store.getApprovalLedger(id).pending).toEqual([]);

    await sessions.stop(id);
  });

  it("会话不在线：先落评论 + pending；`session.start` 与「下一次发言」都会补投，且不重复", async () => {
    const { store, dir } = makeStore();
    // 假 omp 答完**第 2 轮**（补投通知算第 1 轮）就自己退一次：模拟崩溃 / 服务重启 —— 那种"进程没了"能 `-r` 续接。
    const sessions = makeSessions(store, { die: { marker: join(dir, "died.marker"), afterTurn: 2 } });
    const app = createApp(store, { sessions, approvalHooks: { enabled: true } });

    const id = toReview(store, dir, "merged");
    // 人批 G4 时会话还没起来 → 降级：卡片评论 + 待补投
    await post(app, "/api/commands", {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G4",
      decision: "approved",
      reason: "没用了",
    });
    const card = (await (await app.request(`/api/cards/${id}`)).json()) as {
      card: { comments: { body: string; actor: { kind: string } }[] };
    };
    const comment = card.card.comments.find((c) => c.body.startsWith("【审批通知·待转达】"));
    expect(comment?.body).toContain("人已批准清理");
    expect(comment?.actor.kind).toBe("system");
    expect(store.getApprovalLedger(id).pending.map((p) => p.key)).toEqual([
      `approval:${id}:gate:G4:approved`,
    ]);

    // 1) 会话起来：`session/start` 里直接补投
    const log = new NoticeLog(sessions, id);
    expect((await post(app, `/api/cards/${id}/session/start`)).data.ok).toBe(true);
    // 等会话真的 `running`（identify/claim 完成）再往下走：否则人的下一句话会和"起会话"抢同一个进程。
    await waitEvent(sessions, id, (e) => e.type === "state" && e.status === "running");
    await log.wait(1);
    expect(log.sent[0]).toContain("人已批准清理");
    expect(store.getApprovalLedger(id).pending).toEqual([]);

    // 人自己说一句：不再重复补投；这一轮跑完假 omp 自己退了（会话 ended）
    expect((await post(app, `/api/cards/${id}/session/prompt`, { text: "清理完了吗" })).data.ok).toBe(true);
    await waitEvent(sessions, id, (e) => e.type === "state" && e.status === "ended");
    expect(sessions.isLive(id)).toBe(false);
    // 2) 会话没了之后又有一次驳回 → 照样降级（评论 + pending）
    await post(app, "/api/commands", {
      cmd: "requestConfirm",
      actor: AGENT,
      card: id,
      action: "push",
      detail: "git push origin feat/x",
    });
    await post(app, "/api/commands", {
      cmd: "decideConfirm",
      actor: HUMAN,
      card: id,
      id: "cf1",
      decision: "rejected",
      reason: "CI 还没绿",
    });
    expect(store.getApprovalLedger(id).pending.map((p) => p.key)).toEqual([
      `approval:${id}:confirm:cf1:rejected`,
    ]);

    // 3) 人在网页上发言：先把通知补投进去（用 `-r` 续接同一条会话），再发人这句话
    const prompted = await post(app, `/api/cards/${id}/session/prompt`, { text: "那我先不动了" });
    expect(prompted.data.ok).toBe(true);
    await log.wait(2);
    expect(log.sent[1]).toContain("人驳回了远程写授权 cf1");
    expect(log.sent[1]).toContain("不要执行");
    expect(store.getApprovalLedger(id).pending).toEqual([]);

    const snapshot = (await (await app.request(`/api/cards/${id}/session`)).json()) as {
      messages: { role: string; text?: string }[];
    };
    const userTexts = snapshot.messages.filter((m) => m.role === "user").map((m) => m.text ?? "");
    expect(userTexts.filter((t) => t.startsWith(NOTICE_PREFIX))).toHaveLength(2);
    // 顺序：补投的通知在人的那句话**之前**
    expect(userTexts.slice(-2)[0]?.startsWith(NOTICE_PREFIX)).toBe(true);
    expect(userTexts.at(-1)).toBe("那我先不动了");

    // 再说一句：不会重复补投
    await post(app, `/api/cards/${id}/session/prompt`, { text: "好" });
    const after = (await (await app.request(`/api/cards/${id}/session`)).json()) as {
      messages: { role: string; text?: string }[];
    };
    expect(after.messages.filter((m) => m.role === "user" && m.text?.startsWith(NOTICE_PREFIX))).toHaveLength(2);

    await sessions.stop(id);
  }, 20_000);
});
