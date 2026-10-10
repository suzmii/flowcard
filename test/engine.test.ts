import { describe, expect, it } from "vitest";
import { createHarness, issueRef, prRef, worktreeRef, type Harness } from "./harness.ts";
import type { Project } from "../src/shared/types.ts";

const INSIDE = `${worktreeRef.path}/packages/app`;
const OUTSIDE = "/home/u/workspace/proj";

/** 带 Issue 基址的项目（模拟 `project add` 按 remote 派生后的结果）。 */
const PROJECT: Project = {
  id: "proj-0001",
  name: "proj",
  path: "/tmp/fc-issue-proj",
  issueRepo: "git/owner/repo",
  issueUrlTemplate: "https://gitea.example.com/git/owner/repo/issues/{number}",
  addedAt: "2026-10-10T00:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
};

describe("流程硬门禁", () => {
  it("open 直接落 ready：带不带 Issue 都能马上开工（没有 G1 方案批准这道门）", () => {
    const h = createHarness();
    // 不带 Issue 开卡 → 直接 ready（老流程里会停在 inbox，要穿过 triage / 立 Issue / G1 三层）
    const plain = h.run({ cmd: "open", actor: h.human, title: "做点事", body: "" });
    expect(plain.rejection).toBeUndefined();
    expect(h.card(plain.primaryCardId).state).toBe("ready");
    expect(h.card(plain.primaryCardId).issue).toBeNull();

    // 带 Issue 开卡也直接 ready（Issue 只是必要项目，不是开工前置）
    const withIssue = h.run({
      cmd: "open",
      actor: h.human,
      title: "带 Issue 的卡",
      body: "",
      issue: issueRef,
    });
    expect(h.card(withIssue.primaryCardId).state).toBe("ready");

    // 开完卡直接建 worktree + 会话进去 → 自动开工，全程不需要任何人工批准
    const id = plain.primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    expect(h.card(id).state).toBe("working");
  });

  it("会话没进 worktree 就不算开工（ready 卡住并回报缺项）", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "带 Issue 的卡",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });

    const claimed = h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: OUTSIDE },
    });

    expect(h.card(id).state).toBe("ready");
    expect(claimed.blocked?.missing).toEqual(["sessionInWorktree"]);
    expect(claimed.notes.join(" ")).toContain("sessionInWorktree");
    // 事实照样落库：会话记录不能因为状态没前进就丢
    expect(h.card(id).session?.id).toBe("sess-1");
  });

  it("会话在 worktree 里才放行到 working", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "带 Issue 的卡",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });

    expect(h.card(id).state).toBe("working");
  });
});

describe("一条卡片的完整生命周期", () => {
  it("open（ready）→ worktree → claim → PR → push → end → merged → 验收 → 清理 → done", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "端到端",
      body: "需求",
      issue: issueRef,
    }).primaryCardId;
    // 建卡即 ready：不再经 inbox / triage / 立 Issue / G1
    expect(h.card(id).state).toBe("ready");
    expect(Object.keys(h.card(id).gates)).toHaveLength(0);

    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    expect(h.card(id).state).toBe("working");

    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({ cmd: "push", actor: h.agent, card: id, sha: "abc123" });
    h.run({ cmd: "end", actor: h.agent, card: id, sessionId: "sess-1", summary: "做完了" });
    expect(h.card(id).state).toBe("review");
    expect(h.card(id).session?.state).toBe("ended");

    // 会话结束但没人验收：即使 PR 已合并也不许前进
    h.run({
      cmd: "probePr",
      actor: { kind: "system" },
      card: id,
      pr: { ...prRef, state: "merged" },
    });
    expect(h.card(id).state).toBe("review");
    expect(h.card(id).pr?.state).toBe("merged");

    h.run({ cmd: "accept", actor: h.human, card: id });
    expect(h.card(id).state).toBe("merged");
    expect(h.card(id).gates.G4?.status).toBe("open");

    h.run({
      cmd: "proposeCleanup",
      actor: h.agent,
      card: id,
      items: ["删 .worktrees/card-1", "删本地分支 feat/card-1"],
    });
    expect(h.card(id).gates.G4?.payload?.items).toEqual([
      "删 .worktrees/card-1",
      "删本地分支 feat/card-1",
    ]);

    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G4", decision: "approved" });
    h.run({ cmd: "cleanup", actor: h.agent, card: id });

    expect(h.card(id).state).toBe("done");
    expect(h.card(id).cleanedAt).toBeDefined();
  });

  it("PR 未合并时不许提清理（不许提前拆现场）", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });

    const out = h.run({
      cmd: "proposeCleanup",
      actor: h.agent,
      card: id,
      items: ["删 worktree"],
    });
    expect(out.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(out.rejection?.message).toContain("合并");
  });

  it("没有 G4 批准就不许执行清理", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    h.run({ cmd: "push", actor: h.agent, card: id, sha: "a" });
    h.run({ cmd: "end", actor: h.agent, card: id, sessionId: "sess-1" });
    h.run({
      cmd: "probePr",
      actor: { kind: "system" },
      card: id,
      pr: { ...prRef, state: "merged" },
    });
    h.run({ cmd: "accept", actor: h.human, card: id });

    const out = h.run({ cmd: "cleanup", actor: h.agent, card: id });
    expect(out.rejection?.code).toBe("GATE_PENDING");
    expect(h.card(id).state).toBe("merged");
  });
});

describe("声明式 setter 的幂等语义", () => {
  it("同值重复绑定是 no-op，不写第二条事件", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "同值", body: "" }).primaryCardId;

    const first = h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    const again = h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });

    expect(first.events.length).toBeGreaterThan(0);
    expect(again.events).toHaveLength(0);
    expect(again.notes.join(" ")).toContain("已经是该值");
    expect(h.card(id).worktree?.branch).toBe("feat/card-1");
  });

  it("A → B → A 能改回去（历史幂等键不许吞掉恢复写入）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "改回去", body: "" }).primaryCardId;

    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({
      cmd: "worktree",
      actor: h.agent,
      card: id,
      worktree: { ...worktreeRef, branch: "detached" },
    });
    expect(h.card(id).worktree?.branch).toBe("detached");

    // 探测把被写坏的值改回来：必须真的写进去
    const restored = h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    expect(restored.events.map((e) => e.type)).toContain("worktree.bound");
    expect(h.card(id).worktree?.branch).toBe("feat/card-1");
    expect(h.rebuild(id)).toEqual(h.card(id));
  });

  it("PR 状态变化也按前值区分（重复探测不刷事件）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "PR", body: "" }).primaryCardId;

    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    const dup = h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    expect(dup.events).toHaveLength(0);

    const changed = h.run({
      cmd: "probePr",
      actor: { kind: "system" },
      card: id,
      pr: { ...prRef, state: "merged" },
    });
    expect(changed.events.map((e) => e.type)).toContain("pr.merged");
    expect(h.card(id).pr?.state).toBe("merged");
  });
});

describe("会话挪进 worktree 后由心跳推进", () => {
  it("beat 带上的 cwd 落在 worktree 内 → ready 进 working", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "心跳推进", body: "", issue: issueRef }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    // 会话先起在主仓库（cwd 不在 worktree 内）→ 只能绑上会话，状态不动
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "s1", agentKind: "main", cwd: OUTSIDE },
    });
    expect(h.card(id).state).not.toBe("working");

    // omp 里 /move 进 worktree → 下一次心跳带上新 cwd → 自动进实施中
    const beat = h.run({
      cmd: "beat",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "s1", cwd: INSIDE, agentKind: "main" },
    });
    expect(beat.events.map((e) => e.type)).toContain("card.state.changed");
    expect(h.card(id).state).toBe("working");
    expect(h.card(id).session?.cwd).toBe(INSIDE);
  });
});

describe("会话规则", () => {
  it("一个卡片同时只能有一个活跃会话", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });

    const second = h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-2", agentKind: "main", cwd: INSIDE },
    });
    expect(second.rejection?.code).toBe("SESSION_CONFLICT");
  });

  it("subagent 会话不绑卡片", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "x", body: "" }).primaryCardId;
    const out = h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sub-1", agentKind: "sub", cwd: INSIDE },
    });
    expect(out.rejection?.code).toBe("USAGE_ERROR");
  });

  it("未知 sessionId 的心跳不认（new_session 换 id 的坑）", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });

    const beat = h.run({
      cmd: "beat",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-9", cwd: "/tmp", agentKind: "main" },
    });
    expect(beat.events).toHaveLength(0);
    expect(beat.notes.join(" ")).toContain("忽略未知会话");
    expect(h.card(id).session?.id).toBe("sess-1");
  });

  it("cwd 漂出 worktree 会记 mismatch，但不改状态", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });

    const beat = h.run({
      cmd: "beat",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", cwd: OUTSIDE, agentKind: "main" },
    });
    expect(beat.events.map((e) => e.type)).toContain("session.cwd.mismatch");
    expect(h.card(id).state).toBe("working");
  });
});

describe("建卡即开工 / 放弃（没有中转层）", () => {
  it("建卡直接 ready；绑 Issue 只是填槽位，不改状态", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "从看板记的需求", body: "" }).primaryCardId;
    expect(h.card(id).state).toBe("ready");

    h.run({
      cmd: "bindIssue",
      actor: h.human,
      card: id,
      number: issueRef.number,
      repo: issueRef.repo,
      url: issueRef.url,
    });
    expect(h.card(id).issue?.number).toBe(issueRef.number);
    expect(h.card(id).state).toBe("ready");
  });

  it("建卡后不需要任何人工确认就能开工（worktree + 会话 → working）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "马上开工", body: "" }).primaryCardId;

    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    expect(h.card(id).state).toBe("working");
    expect(h.rebuild(id)).toEqual(h.card(id));
  });

  it("drop：放弃要留理由；重复放弃是 no-op；已完成的不许放弃", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "不做了", body: "" }).primaryCardId;

    h.run({ cmd: "drop", actor: h.human, card: id, reason: "需求黄了" });
    expect(h.card(id).state).toBe("dropped");
    expect(h.card(id).comments.map((c) => c.body)).toContain("放弃：需求黄了");

    const again = h.run({ cmd: "drop", actor: h.human, card: id, reason: "再放弃一次" });
    expect(again.events).toHaveLength(0);
    expect(again.notes.join(" ")).toContain("已经是放弃状态");
  });

  it("丢弃状态也能从任意未完成状态进（含 blocked）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "阻塞后放弃", body: "" }).primaryCardId;
    h.run({ cmd: "block", actor: h.agent, card: id, reason: "缺东西" });
    expect(h.card(id).state).toBe("blocked");

    h.run({ cmd: "drop", actor: h.human, card: id, reason: "不做了" });
    expect(h.card(id).state).toBe("dropped");
    expect(h.rebuild(id)).toEqual(h.card(id));
  });
});

describe("大需求拆多片", () => {
  it("spawn 继承同一个 Issue，父卡记下子卡", () => {
    const h = createHarness();
    const parent = h.run({
      cmd: "open",
      actor: h.human,
      title: "大需求第一片",
      body: "",
      issue: issueRef,
    }).primaryCardId;

    const out = h.run({
      cmd: "spawn",
      actor: h.agent,
      card: parent,
      title: "大需求第二片",
      body: "",
    });

    const child = out.primaryCardId;
    expect(child).not.toBe(parent);
    expect(h.card(child).issue?.number).toBe(42);
    expect(h.card(child).partOf).toBe(parent);
    // 子卡也是建卡即 ready（不再落到「立 Issue」那一层）
    expect(h.card(child).state).toBe("ready");
    expect(h.card(parent).spawned).toEqual([child]);
  });
});

describe("阻塞与投影一致性", () => {
  it("blocked 之后前置补齐才能回到 working", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });

    h.run({ cmd: "block", actor: h.agent, card: id, reason: "缺 OAuth 凭据" });
    expect(h.card(id).state).toBe("blocked");
    expect(h.card(id).blockedReason).toBe("缺 OAuth 凭据");

    const out = h.run({ cmd: "unblock", actor: h.human, card: id });
    expect(out.blocked).toBeUndefined();
    expect(h.card(id).state).toBe("working");
  });

  it("从零重放事件得到的卡片与增量投影一致", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "重放",
      body: "body",
      issue: issueRef,
    }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    h.run({ cmd: "push", actor: h.agent, card: id, sha: "deadbeef" });
    h.run({ cmd: "comment", actor: h.agent, card: id, body: "一条评论" });

    expect(h.rebuild(id)).toEqual(h.card(id));
  });
});

describe("Issue 基址：绑 Issue 只填编号", () => {
  it("bindIssue 只给 number：按项目基址补 repo/url，rebuild 一致，重发幂等", () => {
    const h = createHarness({ projects: [PROJECT] });
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "卡片",
      body: "",
      projectId: PROJECT.id,
    }).primaryCardId;

    const out = h.run({ cmd: "bindIssue", actor: h.human, card: id, number: 742 });
    expect(out.rejection).toBeUndefined();
    expect(h.card(id).issue).toEqual({
      repo: "git/owner/repo",
      number: 742,
      url: "https://gitea.example.com/git/owner/repo/issues/742",
      state: "open",
    });
    // 绑 Issue 只填槽位，不推进状态（卡一直是 ready）
    expect(h.card(id).state).toBe("ready");
    // 事件里存的是补齐后的完整 IssueRef → 从零重放得到同一张卡
    expect(h.rebuild(id).issue).toEqual(h.card(id).issue);
    expect(h.rebuild(id).state).toBe("ready");

    const again = h.run({ cmd: "bindIssue", actor: h.human, card: id, number: 742 });
    expect(again.events).toHaveLength(0);
    expect(again.notes.join(" ")).toContain("跳过");
  });

  it("项目没有基址、也没给 url → USAGE_ERROR，hint 说清两条出路，且什么都不写", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "卡片", body: "" }).primaryCardId;

    const out = h.run({ cmd: "bindIssue", actor: h.human, card: id, number: 742 });
    expect(out.rejection?.code).toBe("USAGE_ERROR");
    expect(out.rejection?.message).toContain("742");
    expect(out.rejection?.hint).toContain("issue-base");
    expect(out.rejection?.hint).toContain("--url");
    expect(out.events).toHaveLength(0);
    expect(h.card(id).issue).toBeNull();
  });

  it("显式 repo / url 优先于项目基址（各覆盖各的）", () => {
    const h = createHarness({ projects: [PROJECT] });
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "卡片",
      body: "",
      projectId: PROJECT.id,
    }).primaryCardId;

    // 只覆盖 url：repo 仍从项目补
    h.run({ cmd: "bindIssue", actor: h.human, card: id, number: 7, url: "https://elsewhere/issues/7" });
    expect(h.card(id).issue).toEqual({
      repo: "git/owner/repo",
      number: 7,
      url: "https://elsewhere/issues/7",
      state: "open",
    });

    // 两个都覆盖
    h.run({ cmd: "bindIssue", actor: h.human, card: id, number: 8, repo: "me/mine", url: "https://x/8" });
    expect(h.card(id).issue).toEqual({ repo: "me/mine", number: 8, url: "https://x/8", state: "open" });
  });

  it("open --issue 742 走同一套补齐规则（只给编号也行）", () => {
    const h = createHarness({ projects: [PROJECT] });
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "带 issue 开卡",
      body: "",
      projectId: PROJECT.id,
      issue: { number: 742, state: "open" },
    }).primaryCardId;
    expect(h.card(id).issue?.url).toBe(
      "https://gitea.example.com/git/owner/repo/issues/742",
    );
    expect(h.card(id).state).toBe("ready");
    expect(h.rebuild(id).issue).toEqual(h.card(id).issue);

    // 开卡时显式 url 覆盖模板
    const other = h.run({
      cmd: "open",
      actor: h.human,
      title: "显式 url",
      body: "",
      projectId: PROJECT.id,
      issue: { number: 9, url: "https://x/9", state: "open" },
    }).primaryCardId;
    expect(h.card(other).issue).toEqual({
      repo: "git/owner/repo",
      number: 9,
      url: "https://x/9",
      state: "open",
    });
  });

  it("open 只给编号但项目没基址 → USAGE_ERROR（卡都不开）", () => {
    const h = createHarness();
    const out = h.run({
      cmd: "open",
      actor: h.human,
      title: "x",
      body: "",
      issue: { number: 1, state: "open" },
    });
    expect(out.rejection?.code).toBe("USAGE_ERROR");
    expect(out.events).toHaveLength(0);
    expect(h.cards.size).toBe(0);
  });

  it("显式给全三样时照旧（不查项目也能绑）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "卡片", body: "" }).primaryCardId;
    const out = h.run({
      cmd: "bindIssue",
      actor: h.human,
      card: id,
      number: issueRef.number,
      repo: issueRef.repo,
      url: issueRef.url,
    });
    expect(out.rejection).toBeUndefined();
    expect(h.card(id).issue?.url).toBe(issueRef.url);
  });
});

describe("交付要件（防回归）", () => {
  /** 建卡 → worktree → 会话进 worktree，一路推到 working。 */
  const driveToWorking = (h: Harness, title: string): string => {
    const id = h.run({ cmd: "open", actor: h.human, title, body: "" }).primaryCardId;
    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    expect(h.card(id).state).toBe("working");
    return id;
  };

  it("working -> review 仍要求 PR + 至少一次推送：没补齐就停在 working", () => {
    const h = createHarness();

    // ① PR、推送都没有
    const bare = driveToWorking(h, "没交付要件");
    const endedBare = h.run({ cmd: "end", actor: h.agent, card: bare, sessionId: "sess-1" });
    expect(h.card(bare).state).toBe("working");
    expect(endedBare.blocked?.transition).toBe("working -> review");
    expect(endedBare.blocked?.missing).toEqual(["pr", "pushedAtLeastOnce"]);
    // 事实照样落库：会话结束不能因为状态没前进就丢
    expect(h.card(bare).session?.state).toBe("ended");

    // ② 有 PR 但一次都没推
    const prOnly = driveToWorking(h, "只开了 PR");
    h.run({ cmd: "bindPr", actor: h.agent, card: prOnly, pr: prRef });
    const endedPrOnly = h.run({ cmd: "end", actor: h.agent, card: prOnly, sessionId: "sess-1" });
    expect(endedPrOnly.blocked?.missing).toEqual(["pushedAtLeastOnce"]);
    expect(h.card(prOnly).state).toBe("working");
  });

  it("验收语义不变：accept 不改 state；review -> merged 需要 accepted + prMerged", () => {
    const h = createHarness();
    /** 推到 review：PR + 一次推送 + 交回。 */
    const driveToReview = (title: string): string => {
      const id = driveToWorking(h, title);
      h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
      h.run({ cmd: "push", actor: h.agent, card: id, sha: "a1" });
      h.run({ cmd: "end", actor: h.agent, card: id, sessionId: "sess-1" });
      expect(h.card(id).state).toBe("review");
      return id;
    };

    // 人验收了但 PR 还没合并 → 状态不动，只记下验收事实
    const accepted = driveToReview("先验收");
    h.run({ cmd: "accept", actor: h.human, card: accepted });
    expect(h.card(accepted).acceptedAt).toBeDefined();
    expect(h.card(accepted).gates.G3?.status).toBe("approved");
    expect(h.card(accepted).state).toBe("review");

    // PR 合并后才前进（accepted + prMerged 齐了）
    h.run({
      cmd: "probePr",
      actor: { kind: "system" },
      card: accepted,
      pr: { ...prRef, state: "merged" },
    });
    expect(h.card(accepted).state).toBe("merged");
    expect(h.card(accepted).gates.G4?.status).toBe("open");

    // 反向：PR 合并了但没人验收 → 不许进 merged
    const unaccepted = driveToReview("没人验收");
    h.run({
      cmd: "probePr",
      actor: { kind: "system" },
      card: unaccepted,
      pr: { ...prRef, state: "merged" },
    });
    expect(h.card(unaccepted).state).toBe("review");
    expect(h.card(unaccepted).acceptedAt).toBeUndefined();
  });
});
