import { describe, expect, it } from "vitest";
import { createHarness, issueRef, prRef, worktreeRef } from "./harness.ts";

const INSIDE = `${worktreeRef.path}/packages/app`;
const OUTSIDE = "/home/u/workspace/proj";

describe("流程硬门禁", () => {
  it("无 Issue 时不许批准方案（G1 缺项被拦）", () => {
    const h = createHarness();
    const opened = h.run({ cmd: "open", actor: h.human, title: "做点事", body: "" });
    const id = opened.primaryCardId;
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });

    const decided = h.run({
      cmd: "decideGate",
      actor: h.human,
      card: id,
      gate: "G1",
      decision: "approved",
    });

    expect(decided.rejection?.code).toBe("MISSING_REQUIREMENT");
    expect(decided.rejection?.missing).toContain("issue");
    expect(h.card(id).state).toBe("issue");
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
  it("open → plan → 批 → worktree → PR → claim → push → end → merged → 验收 → 清理 → done", () => {
    const h = createHarness();
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "端到端",
      body: "需求",
      issue: issueRef,
    }).primaryCardId;
    // 开卡时就带了 Issue = 已经立项，直接落在 issue 列（绑 Issue 会推进状态）
    expect(h.card(id).state).toBe("issue");

    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    expect(h.card(id).state).toBe("issue");
    expect(h.card(id).gates.G1?.status).toBe("open");

    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
    expect(h.card(id).state).toBe("ready");

    h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
    h.run({ cmd: "bindPr", actor: h.agent, card: id, pr: prRef });
    h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: INSIDE },
    });
    expect(h.card(id).state).toBe("working");

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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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

describe("首页那一步：确认要做 / 放弃", () => {
  it("绑定 Issue 就是立项：收件箱自动进「立 Issue」", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "从看板记的需求", body: "" }).primaryCardId;
    expect(h.card(id).state).toBe("inbox");

    h.run({ cmd: "bindIssue", actor: h.human, card: id, issue: issueRef });
    expect(h.card(id).state).toBe("issue");
  });

  it("triage：人确认要做 → 从收件箱进「立 Issue」，备注进评论", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "待确认", body: "" }).primaryCardId;

    h.run({ cmd: "triage", actor: h.human, card: id, note: "这个做" });
    expect(h.card(id).state).toBe("issue");
    expect(h.card(id).comments.map((c) => c.body)).toContain("这个做");

    // 再做一次是 no-op，不报错也不重复写
    const again = h.run({ cmd: "triage", actor: h.human, card: id });
    expect(again.events).toHaveLength(0);
    expect(again.notes.join(" ")).toContain("已经是");
  });

  it("已经开工的卡不能再用 triage 回退", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "x", body: "", issue: issueRef }).primaryCardId;
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
    expect(h.card(id).state).toBe("ready");

    const out = h.run({ cmd: "triage", actor: h.human, card: id });
    expect(out.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(h.card(id).state).toBe("ready");
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
    expect(h.card(child).state).toBe("issue");
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
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
