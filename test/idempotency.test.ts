/**
 * 幂等键的回归测试：**每条用例在修之前都会先红**。
 *
 * 根因：意图类命令用「命令内容」当 `dedupeKey`（`unblock:{card}#state`、`delete:{card}:{hash(reason)}`、
 * `cleanup-plan:{card}`…），于是"同内容的第二次合法操作"被当成重复请求静默吞掉 ——
 * 命令返回 ok，状态没动。修法（见 `src/server/engine.ts` 头部）：
 *   - 意图类命令 → `{cmd}:{card}:{card.eventCount}`（卡片版本变了就是新的一次）；
 *   - 带外部身份的事实（sha / 远端 id / 会话 id / PR 编号+状态）→ 保持身份寻址；
 *   - 心跳 → 30s 分桶 + `shortHash(cwd)`；
 *   - 重复语义由引擎自己的状态守卫负责（setter「值没变就跳过」、unblock 查 state…）。
 *
 * 每条都标了它覆盖的 findings-a 条目（A1–A10）。用真 store（`dedupeKey` 是存储层的唯一索引，
 * harness 里没有唯一索引，测不出"被吞"）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { sessionInsideWorktree } from "../src/shared/flow.ts";
import { createStore, type ExecuteResult, type Store } from "../src/server/store.ts";
import type { Command, PrRef } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "s1" };
const SYSTEM = { kind: "system" as const };
const AT = (n: number): string => new Date(Date.parse("2026-10-10T00:00:00.000Z") + n * 1000).toISOString();

const WT = { path: "/w/card", branch: "feat/card", source: "flowcard" as const };
const INSIDE = "/w/card/src";
const OUTSIDE = "/w";
const prRef: PrRef = {
  repo: "r",
  number: 77,
  url: "http://p/77",
  branch: "feat/card",
  state: "open",
};
const mergedPr: PrRef = { ...prRef, state: "merged" };

function freshStore(): Store {
  return createStore({ dataDir: mkdtempSync(join(tmpdir(), "flowcard-keyfix-")), flow: personalFlow });
}

/** 时钟自动往前走（每条命令 +1s），`plus` 用来越过/停在同一个心跳分桶里。 */
type Runner = { run: (c: Command) => ExecuteResult; plus: (ms: number) => void };

function runner(store: Store): Runner {
  let n = 0;
  return {
    run: (cmd) => store.execute(cmd, AT(n++)),
    plus: (ms) => {
      n += ms / 1000;
    },
  };
}

/** 建卡 → worktree → 会话进 worktree（working）。返回卡片 id。 */
function driveToWorking(r: Runner, title: string): string {
  const id = r.run({ cmd: "open", actor: HUMAN, title, body: "" }).outcome.primaryCardId;
  r.run({ cmd: "worktree", actor: AGENT, card: id, worktree: WT });
  r.run({ cmd: "claim", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
  return id;
}

/** 一路推到 merged + G4 开着。 */
function driveToMerged(r: Runner, title: string): string {
  const id = driveToWorking(r, title);
  r.run({ cmd: "bindPr", actor: AGENT, card: id, pr: prRef });
  r.run({ cmd: "push", actor: AGENT, card: id, sha: "a1" });
  r.run({ cmd: "end", actor: AGENT, card: id, sessionId: "s1" });
  r.run({ cmd: "probePr", actor: SYSTEM, card: id, pr: mergedPr });
  r.run({ cmd: "accept", actor: HUMAN, card: id });
  return id;
}

// ---------------------------------------------------------------- A1：G4 被驳回之后能重新提

describe("[A1] G4 被驳回之后重新提清单、再批准、cleanup 进 done", () => {
  it("驳回 → 再提清单 → 再批准 → cleanup 成功进 done（修前第二次提清单被幂等键吞掉，卡永久停在 merged）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToMerged(r, "清理重来");
    expect(store.getCard(id)?.state).toBe("merged");
    expect(store.getCard(id)?.gates.G4?.status).toBe("open");

    // 第一次提清单 → 被驳回
    const first = r.run({ cmd: "proposeCleanup", actor: AGENT, card: id, items: ["删 worktree"] });
    expect(first.inserted.map((e) => e.type)).toEqual(["cleanup.proposed"]);
    r.run({ cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "rejected", reason: "worktree 里有没提交的东西" });
    expect(store.getCard(id)?.gates.G4?.status).toBe("rejected");

    // 第二次提清单（改了内容）：修前 `cleanup-plan:{card}` 恒定 → 事件被吞，G4 一直停在 rejected
    const second = r.run({
      cmd: "proposeCleanup",
      actor: AGENT,
      card: id,
      items: ["先 stash 再删 worktree", "删本地分支"],
    });
    expect(second.inserted.map((e) => e.type)).toEqual(["cleanup.proposed"]);
    expect(store.getCard(id)?.gates.G4?.status).toBe("open");
    expect(store.getCard(id)?.gates.G4?.payload?.items).toEqual(["先 stash 再删 worktree", "删本地分支"]);

    // 再批准 → cleanup：一路进 done
    const approve = r.run({ cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" });
    expect(approve.inserted).toHaveLength(1);
    const cleaned = r.run({ cmd: "cleanup", actor: AGENT, card: id });
    expect(cleaned.outcome.rejection).toBeUndefined();
    expect(cleaned.inserted.map((e) => e.type)).toEqual(["cleanup.completed", "card.state.changed"]);
    expect(store.getCard(id)?.state).toBe("done");
    expect(store.getCard(id)?.cleanedAt).toBeDefined();

    // 投影 == 从零重放
    store.rebuild();
    expect(store.getCard(id)?.state).toBe("done");
    store.close();
  });

  it("清单已经提交（G4 还开着）时重发是 no-op：不重置 requestedAt / items", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToMerged(r, "重发清单");

    const first = r.run({ cmd: "proposeCleanup", actor: AGENT, card: id, items: ["删 worktree"] });
    const requestedAt = store.getCard(id)?.gates.G4?.requestedAt;
    const again = r.run({ cmd: "proposeCleanup", actor: AGENT, card: id, items: ["删 worktree", "删分支"] });

    expect(first.inserted).toHaveLength(1);
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toBe(0); // 不是"被键吞掉"，而是守卫显式跳过
    expect(again.outcome.notes.join(" ")).toContain("已经提交");
    expect(store.getCard(id)?.gates.G4?.requestedAt).toBe(requestedAt);
    expect(store.getCard(id)?.gates.G4?.payload?.items).toEqual(["删 worktree"]);
    store.close();
  });
});

// ---------------------------------------------------------------- A2：心跳不复活 blocked

describe("[A2] 心跳只推进 ready，不复活 blocked", () => {
  it("blocked 的卡收到心跳不会被拉回 working，blockedReason 还在（修前 beat 的 when 含 blocked，≤30s 就被抹掉）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "心跳别复活");
    expect(store.getCard(id)?.state).toBe("working");

    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺 OAuth 凭据" });
    expect(store.getCard(id)?.state).toBe("blocked");

    // 会话还活着、cwd 就在 worktree 里（最常见的情形）：心跳不能把它拉回实施中
    const beat = r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(beat.inserted.map((e) => e.type)).toEqual(["session.heartbeat"]);
    expect(store.getCard(id)?.state).toBe("blocked");
    expect(store.getCard(id)?.blockedReason).toBe("缺 OAuth 凭据");

    // 只有显式 unblock 才能回来
    r.run({ cmd: "unblock", actor: HUMAN, card: id });
    expect(store.getCard(id)?.state).toBe("working");
    store.close();
  });
});

// ---------------------------------------------------------------- A3：软删除的卡不再参与认领

describe("[A3] 软删除的卡不再被 cwd 认领", () => {
  it("删掉的卡不会被 cwd 认领；删旧卡后新建的同 worktree 卡能正常认领（修前并列两张卡直接 NOT_FOUND）", () => {
    const store = freshStore();
    const r = runner(store);

    const old = r.run({ cmd: "open", actor: HUMAN, title: "建错了", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "worktree", actor: AGENT, card: old, worktree: WT });
    r.run({ cmd: "delete", actor: HUMAN, card: old, reason: "建错了" });

    // 被删的卡不再是认领目标（修前它还在候选里 → cwd 认领会解到这张已删的卡）
    const claimed = r.run({ cmd: "claim", actor: AGENT, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(claimed.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(store.getCard(old)?.session).toBeNull();

    // 重建同一棵 worktree 的新卡：按 cwd 认领必须解到它（修前两张卡 path 并列 → 永远解不出唯一解）
    const fresh = r.run({ cmd: "open", actor: HUMAN, title: "重建", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "worktree", actor: AGENT, card: fresh, worktree: WT });
    const bound = r.run({ cmd: "claim", actor: AGENT, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(bound.outcome.primaryCardId).toBe(fresh);
    expect(store.getCard(fresh)?.session?.id).toBe("s1");
    expect(store.getCard(fresh)?.state).toBe("working");
    expect(store.getCard(old)?.session).toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------- A4：block 的状态守卫

describe("[A4] block 不许落在已经结束的卡上", () => {
  it("done / dropped 的卡拒绝阻塞（给人话原因）；修前能把 done 拉回 blocked 再 unblock 成 working", () => {
    const store = freshStore();
    const r = runner(store);

    const dropped = r.run({ cmd: "open", actor: HUMAN, title: "放弃的", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "drop", actor: HUMAN, card: dropped, reason: "不做了" });
    const blockedDropped = r.run({ cmd: "block", actor: AGENT, card: dropped, reason: "缺东西" });
    expect(blockedDropped.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(blockedDropped.outcome.rejection?.message).toContain("dropped");
    expect(store.getCard(dropped)?.state).toBe("dropped");

    // done：完整的清理流程走完
    const done = driveToMerged(r, "完成的");
    r.run({ cmd: "proposeCleanup", actor: AGENT, card: done, items: ["删 worktree"] });
    r.run({ cmd: "decideGate", actor: HUMAN, card: done, gate: "G4", decision: "approved" });
    r.run({ cmd: "cleanup", actor: AGENT, card: done });
    expect(store.getCard(done)?.state).toBe("done");

    const blockedDone = r.run({ cmd: "block", actor: AGENT, card: done, reason: "又想改了" });
    expect(blockedDone.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(blockedDone.outcome.rejection?.message).toContain("done");
    expect(blockedDone.outcome.rejection?.hint).toContain("另开一张卡");
    expect(store.getCard(done)?.state).toBe("done");
    store.close();
  });

  it("已删除的卡不许阻塞（要先 restore）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "删掉的", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "delete", actor: HUMAN, card: id });

    const out = r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺东西" });
    expect(out.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(out.outcome.rejection?.hint).toContain("restore");
    expect(store.getCard(id)?.state).toBe("ready");
    store.close();
  });
});

// ---------------------------------------------------------------- A5：会话死了就不算在 worktree 里干活

describe("[A5] sessionInsideWorktree 要看会话还活着", () => {
  it("会话 ended 之后 unblock 不成立：缺 sessionInWorktree（修前只看 cwd，凭历史 cwd 就放行）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "会话没了");
    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺凭据" });
    r.run({ cmd: "end", actor: AGENT, card: id, sessionId: "s1" });
    expect(store.getCard(id)?.session?.state).toBe("ended");
    expect(store.getCard(id)?.state).toBe("blocked");

    const out = r.run({ cmd: "unblock", actor: HUMAN, card: id });
    expect(out.outcome.blocked?.missing).toEqual(["sessionInWorktree"]);
    expect(store.getCard(id)?.state).toBe("blocked");
    expect(sessionInsideWorktree(store.getCard(id)!)).toBe(false);
    store.close();
  });

  it("会话还在跑时 unblock 照旧放行（不看别的）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "会话还在");
    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺凭据" });
    const out = r.run({ cmd: "unblock", actor: HUMAN, card: id });
    expect(out.outcome.blocked).toBeUndefined();
    expect(store.getCard(id)?.state).toBe("working");
    store.close();
  });
});

// ---------------------------------------------------------------- A6：end 之后同 id 复 claim

describe("[A6] 会话结束后用同一个 session id 重新 claim", () => {
  it("end → 同 id 同 cwd 再 claim → 会话回到 running；另一个 id 抢卡仍被 SESSION_CONFLICT 挡住", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "恢复会话");
    r.run({ cmd: "end", actor: AGENT, card: id, sessionId: "s1" });
    expect(store.getCard(id)?.session?.state).toBe("ended");

    // 恢复（适配器的 resumeHint：omp -r 沿用原 id）：修前 `claim:{card}:{sid}:{hash(cwd)}` 恒定 → 被吞，
    // 投影里 session.state 一直是 ended，后续 end / beat 也全被吞
    const resumed = r.run({ cmd: "claim", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(resumed.inserted.map((e) => e.type)).toEqual(["session.started"]);
    expect(store.getCard(id)?.session?.state).toBe("running");

    // 另一个 id 抢卡：守卫仍然在
    const other = r.run({ cmd: "claim", actor: AGENT, card: id, session: { harness: "omp", id: "s2", agentKind: "main", cwd: INSIDE } });
    expect(other.outcome.rejection?.code).toBe("SESSION_CONFLICT");
    expect(store.getCard(id)?.session?.id).toBe("s1");

    // 恢复的这一轮跑完再 end：新的一轮、新键，能写进去；同一次 end 的重发才是同一个键
    const endResumed = r.run({ cmd: "end", actor: AGENT, card: id, sessionId: "s1" });
    expect(endResumed.inserted.map((e) => e.type)).toEqual(["session.ended"]);
    expect(store.getCard(id)?.session?.state).toBe("ended");
    const endAgain = r.run({ cmd: "end", actor: AGENT, card: id, sessionId: "s1" });
    expect(endAgain.inserted).toHaveLength(0);
    expect(endAgain.duplicates).toBe(1);
    store.close();
  });

  it("同 id 同 cwd 且还在跑时重发 claim 是 no-op（重试幂等靠守卫，不靠键）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "重复认领");
    const again = r.run({ cmd: "claim", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(again.inserted).toHaveLength(0);
    expect(again.outcome.notes.join(" ")).toContain("已经绑在这张卡上");
    store.close();
  });
});

// ---------------------------------------------------------------- A7：卡号不再烧号

describe("[A7] nextCardId 只在事务里提交", () => {
  it("被拒的 open 与重复的 open 不留卡号空洞（卡号连着给）", () => {
    const store = freshStore();
    const r = runner(store);

    // 被拒的 open：项目不存在（引擎在检查前已经分配了 id）
    const rejected = r.run({ cmd: "open", actor: HUMAN, title: "没项目", body: "", projectId: "nope" });
    expect(rejected.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(rejected.inserted).toHaveLength(0);

    const first = r.run({ cmd: "open", actor: HUMAN, title: "第一张", body: "b" });
    const firstId = first.outcome.primaryCardId;
    // 重复 open（同内容）：一条事件都没写 → 不能再烧号
    const dup = r.run({ cmd: "open", actor: HUMAN, title: "第一张", body: "b" });
    expect(dup.inserted).toHaveLength(0);
    // 存储层按幂等键把"重发的 open"指回原来那张卡（这里分配的 c2 一个字节都没写）
    expect(dup.card?.id).toBe(firstId);

    const second = r.run({ cmd: "open", actor: HUMAN, title: "第二张", body: "b" });
    expect(second.outcome.primaryCardId).toBe("c2");

    // 修前：被拒的 open 烧掉 c1、重复的 open 烧掉 c3 → 第一张/第二张是 c2 / c4
    expect(firstId).toBe("c1");
    expect(store.listCards().map((c) => c.id)).toEqual(["c1", "c2"]);
    store.close();
  });
});

// ---------------------------------------------------------------- A8：心跳分桶要带 cwd

describe("[A8] 同一个心跳分桶里 cwd 变了是两件事", () => {
  it("cwd 从主仓库变到 worktree：两拍都落库，投影里的 cwd 与状态一致（修前第二拍被吞，落库 state=working 而 cwd 还在主干）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "换目录", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "worktree", actor: AGENT, card: id, worktree: WT });
    r.run({ cmd: "claim", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: OUTSIDE } });
    expect(store.getCard(id)?.state).toBe("ready");

    // 两拍落在同一个 30s 桶里（中间只隔 2s）
    r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: OUTSIDE } });
    r.plus(2000);
    const moved = r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });

    expect(moved.inserted.map((e) => e.type)).toContain("session.heartbeat");
    const card = store.getCard(id)!;
    expect(card.session?.cwd).toBe(INSIDE);
    expect(card.state).toBe("working");
    // 落库的投影必须自己满足 requires（修前 session.cwd 停在主干 → sessionInWorktree 为假却有 working 状态）
    expect(sessionInsideWorktree(card)).toBe(true);

    // 同一桶里**同一个 cwd** 再拍一次才是重复（键没变）
    r.plus(1000);
    const same = r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(same.inserted).toHaveLength(0);
    expect(same.duplicates).toBeGreaterThan(0);
    store.close();
  });
});

// ---------------------------------------------------------------- 意图命令：同内容第二次是新的一次

describe("同内容的第二次合法操作不会被吞", () => {
  it("[A5/A6] 第二次 unblock：block A → unblock → block B → unblock", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "两次阻塞");

    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺 A 凭据" });
    const first = r.run({ cmd: "unblock", actor: HUMAN, card: id });
    expect(first.inserted.map((e) => e.type)).toEqual(["card.state.changed"]);
    expect(store.getCard(id)?.state).toBe("working");

    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺 B 凭据" });
    expect(store.getCard(id)?.state).toBe("blocked");
    // 修前 `unblock:{card}#state` 恒定 → 第二次 unblock 被吞，卡永久停在 blocked
    const second = r.run({ cmd: "unblock", actor: HUMAN, card: id });
    expect(second.inserted.map((e) => e.type)).toEqual(["card.state.changed"]);
    expect(store.getCard(id)?.state).toBe("working");
    store.close();
  });

  it("[A5] 同理由二次 block（unblock 之后）要能真的阻塞；同理由重发才是 no-op", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "同理由再阻塞");

    r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺凭据" });
    r.run({ cmd: "unblock", actor: HUMAN, card: id });
    // 修前 `block:{card}:{hash(reason)}` 恒定 → 同理由第二次 block 被吞（命令回 ok、卡还在 working）
    const again = r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺凭据" });
    expect(again.inserted.map((e) => e.type)).toEqual(["card.blocked"]);
    expect(store.getCard(id)?.state).toBe("blocked");

    // 重发同一件事（已经在 blocked 且理由一样）→ 守卫跳过
    const retry = r.run({ cmd: "block", actor: AGENT, card: id, reason: "缺凭据" });
    expect(retry.inserted).toHaveLength(0);
    expect(retry.outcome.notes.join(" ")).toContain("已经是这个阻塞原因");
    store.close();
  });

  it("[A6] delete → restore → delete（同理由）要能删第二次", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "删两次", body: "" }).outcome.primaryCardId;

    r.run({ cmd: "delete", actor: HUMAN, card: id, reason: "建错了" });
    expect(store.getCard(id)?.deletedAt).toBeDefined();
    r.run({ cmd: "restore", actor: HUMAN, card: id });
    expect(store.getCard(id)?.deletedAt).toBeUndefined();

    // 修前 `delete:{card}:{hash(reason)}` 恒定 → 第二次删除被吞，卡还留在看板上
    const again = r.run({ cmd: "delete", actor: HUMAN, card: id, reason: "建错了" });
    expect(again.inserted.map((e) => e.type)).toEqual(["card.deleted"]);
    expect(store.getCard(id)?.deletedAt).toBeDefined();
    expect(store.getCard(id)?.deletedReason).toBe("建错了");
    store.close();
  });

  it("[A6] A→B→A→B 的 setter（worktree / bindIssue / bindPr）第 4 次也写得进去", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "来回改", body: "" }).outcome.primaryCardId;

    const A = { path: "/w/a", branch: "feat/a", source: "flowcard" as const };
    const B = { path: "/w/b", branch: "feat/b", source: "flowcard" as const };
    // 修前 worktree 的键带"前一个 branch":A→B→A 之后第 4 次（又到 B）与第 2 次同键 → 被吞
    const seq = [A, B, A, B];
    for (const wt of seq) {
      const out = r.run({ cmd: "worktree", actor: AGENT, card: id, worktree: wt });
      expect(out.inserted.map((e) => e.type)).toEqual(["worktree.bound"]);
    }
    expect(store.getCard(id)?.worktree?.path).toBe("/w/b");

    // bindIssue 1 → 2 → 1 → 2（修前键带 from，第 4 次与第 2 次同键）
    for (const n of [1, 2, 1, 2]) {
      const out = r.run({ cmd: "bindIssue", actor: HUMAN, card: id, number: n, repo: "r", url: `http://i/${n}` });
      expect(out.inserted.map((e) => e.type)).toEqual(["issue.bound"]);
    }
    expect(store.getCard(id)?.issue?.number).toBe(2);

    // bindPr：同编号同状态、只换 url（修前键不含 url → 被吞）
    for (const url of ["http://p/1", "http://p/2", "http://p/1", "http://p/2"]) {
      const out = r.run({ cmd: "bindPr", actor: AGENT, card: id, pr: { ...prRef, url } });
      expect(out.inserted.map((e) => e.type)).toEqual(["pr.bound"]);
    }
    expect(store.getCard(id)?.pr?.url).toBe("http://p/2");
    store.close();
  });

  it("[A6] probePr：open → closed → open → closed 每次都记上；同一个观察重发才是 no-op", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "重开 PR", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "bindPr", actor: AGENT, card: id, pr: prRef });

    // 修前 `probe:{card}:{n}:{state}` 恒定：重新打开（第 2 次 open）与第 1 次 open 同键 → 被吞
    const seq = [
      { ...prRef, state: "closed" as const },
      prRef,
      { ...prRef, state: "closed" as const },
      prRef,
    ];
    for (const pr of seq) {
      const out = r.run({ cmd: "probePr", actor: SYSTEM, card: id, pr });
      expect(out.inserted).toHaveLength(1);
    }
    expect(store.getCard(id)?.pr?.state).toBe("open");

    // 同一个观察重发：值没变 → 守卫跳过
    const dup = r.run({ cmd: "probePr", actor: SYSTEM, card: id, pr: prRef });
    expect(dup.inserted).toHaveLength(0);
    expect(dup.outcome.notes.join(" ")).toContain("没有变化");
    store.close();
  });

  it("[A6] probePr：合并是单向的事实，重复观察不刷事件", () => {
    const store = freshStore();
    const r = runner(store);
    const id = r.run({ cmd: "open", actor: HUMAN, title: "合并", body: "" }).outcome.primaryCardId;
    r.run({ cmd: "bindPr", actor: AGENT, card: id, pr: prRef });

    const merged = r.run({ cmd: "probePr", actor: SYSTEM, card: id, pr: mergedPr });
    expect(merged.inserted.map((e) => e.type)).toEqual(["pr.merged"]);
    expect(store.getCard(id)?.pr?.state).toBe("merged");
    const again = r.run({ cmd: "probePr", actor: SYSTEM, card: id, pr: mergedPr });
    expect(again.inserted).toHaveLength(0);
    store.close();
  });
});

// ---------------------------------------------------------------- 重试幂等：同一命令重发两次

describe("键规则变更后，同一次请求的重发仍然是幂等的", () => {
  it("内容键（comment）与分桶键（beat）由存储层去重", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "内容键");

    const first = r.run({ cmd: "comment", actor: AGENT, card: id, body: "同一条评论" });
    const again = r.run({ cmd: "comment", actor: AGENT, card: id, body: "同一条评论" });
    expect(first.inserted).toHaveLength(1);
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toBeGreaterThan(0);

    const b1 = r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    const b2 = r.run({ cmd: "beat", actor: AGENT, card: id, session: { harness: "omp", id: "s1", agentKind: "main", cwd: INSIDE } });
    expect(b1.inserted).toHaveLength(1);
    expect(b2.duplicates).toBeGreaterThan(0);
    expect(store.getCard(id)?.comments.filter((c) => c.body === "同一条评论")).toHaveLength(1);
    store.close();
  });

  it("意图类命令的重发由状态守卫挡成 no-op（版本变了也不会写出第二条事实）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToMerged(r, "重发守卫");

    // worktree 同值
    const wt = r.run({ cmd: "worktree", actor: AGENT, card: id, worktree: WT });
    expect(wt.inserted).toHaveLength(0);
    expect(wt.outcome.notes.join(" ")).toContain("已经是该值");

    // accept：acceptedAt 已经有了
    const accepted = r.run({ cmd: "accept", actor: HUMAN, card: id });
    expect(accepted.inserted).toHaveLength(0);
    expect(accepted.outcome.notes.join(" ")).toContain("已经验收过");
    const acceptedAt = store.getCard(id)?.acceptedAt;

    // 提清单 → 重发
    r.run({ cmd: "proposeCleanup", actor: AGENT, card: id, items: ["删 worktree"] });
    const proposedAt = store.getCard(id)?.gates.G4?.requestedAt;
    const again = r.run({ cmd: "proposeCleanup", actor: AGENT, card: id, items: ["删 worktree"] });
    expect(again.inserted).toHaveLength(0);
    expect(again.outcome.notes.join(" ")).toContain("已经提交");

    // decideGate 重发：门禁已经不是 open
    r.run({ cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" });
    const decided = r.run({ cmd: "decideGate", actor: HUMAN, card: id, gate: "G4", decision: "approved" });
    expect(decided.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(decided.inserted).toHaveLength(0);

    // cleanup 重发：cleanedAt 已经写了
    const cleaned = r.run({ cmd: "cleanup", actor: AGENT, card: id });
    expect(cleaned.outcome.rejection).toBeUndefined();
    expect(store.getCard(id)?.state).toBe("done");
    const reclean = r.run({ cmd: "cleanup", actor: AGENT, card: id });
    expect(reclean.inserted).toHaveLength(0);
    expect(reclean.outcome.notes.join(" ")).toContain("清理已经完成");

    // block 不许落在 done 上（守卫，不是键）
    const block = r.run({ cmd: "block", actor: AGENT, card: id, reason: "x" });
    expect(block.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");

    const del = r.run({ cmd: "delete", actor: HUMAN, card: id, reason: "清理错了" });
    expect(del.inserted).toHaveLength(1);
    const del2 = r.run({ cmd: "delete", actor: HUMAN, card: id, reason: "清理错了" });
    expect(del2.inserted).toHaveLength(0);
    expect(del2.outcome.notes.join(" ")).toContain("已经是删除状态");
    const restore = r.run({ cmd: "restore", actor: HUMAN, card: id });
    expect(restore.inserted).toHaveLength(1);
    const restore2 = r.run({ cmd: "restore", actor: HUMAN, card: id });
    expect(restore2.inserted).toHaveLength(0);

    // reviewVerdict 同一条判定重发：守卫跳过
    const v1 = r.run({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "approve", body: "看过了" });
    const v2 = r.run({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "approve", body: "看过了" });
    expect(v1.inserted).toHaveLength(1);
    expect(v2.inserted).toHaveLength(0);
    expect(v2.outcome.notes.join(" ")).toContain("没有变化");

    // 事件流没有被重发写花：每条事件一条
    const keys = store.listEvents(1000).filter((e) => e.cardId === id).map((e) => e.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(store.getCard(id)?.acceptedAt).toBe(acceptedAt);
    expect(store.getCard(id)?.gates.G4?.requestedAt).toBe(proposedAt);
    store.close();
  });

  it("reviewVerdict 改主意 A→B→A→B 每次都记上（版本键）", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToMerged(r, "判定来回");
    const seq: Array<"approve" | "request_changes"> = ["approve", "request_changes", "approve", "request_changes"];
    for (const verdict of seq) {
      const out = r.run({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict, body: `第 ${verdict} 次` });
      expect(out.inserted.map((e) => e.type)).toEqual(["review.verdict.recorded"]);
    }
    expect(store.getCard(id)?.review.verdict?.decision).toBe("request_changes");
    store.close();
  });
});

// ---------------------------------------------------------------- 投影：eventCount

describe("eventCount（卡片版本）", () => {
  it("每折一条事件 +1，且 rebuild 之后一模一样", () => {
    const store = freshStore();
    const r = runner(store);
    const id = driveToWorking(r, "版本号");
    const card = store.getCard(id)!;
    const events = store.listEvents(1000).filter((e) => e.cardId === id);
    expect(card.eventCount).toBe(events.length);

    store.rebuild();
    expect(store.getCard(id)?.eventCount).toBe(events.length);
    expect(store.getCard(id)).toEqual(card);
    store.close();
  });

  it("老投影（没有 eventCount）在版本号升级时被自动重建补上", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowcard-keyfix-ver-"));
    const first = createStore({ dataDir: dir, flow: personalFlow });
    const id = first.execute({ cmd: "open", actor: HUMAN, title: "老库", body: "" }, AT(0)).outcome.primaryCardId;
    first.close();

    const db = new DatabaseSync(join(dir, "flowcard.sqlite"));
    db.exec("UPDATE cards SET card = REPLACE(card, '\"eventCount\":', '\"eventCount_old\":')");
    db.exec("UPDATE meta SET value = '7' WHERE key = 'projection_version'");
    db.close();

    const second = createStore({ dataDir: dir, flow: personalFlow });
    expect(second.getCard(id)?.eventCount).toBe(1);
    second.close();
  });
});
