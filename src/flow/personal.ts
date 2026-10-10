/**
 * 个人流程：就是 skill 里那套规矩的可执行版本。
 * 每个 requires 都是一条"缺了就拦住"的硬门禁；每个 autoTransitions 都靠 requires 决定放不放行。
 */
import { defineFlow, sessionInsideWorktree } from "../shared/flow.ts";
import { CARD_STATES } from "../shared/types.ts";

export const personalFlow = defineFlow({
  name: "personal",

  states: CARD_STATES,

  requirements: [
    { id: "issue", describe: "卡片必须绑定 Issue（建或查已有）", check: (c) => c.issue !== null },
    {
      id: "planApproved",
      describe: "方案必须经人批准（门禁 G1）",
      check: (c) => c.gates.G1?.status === "approved",
    },
    {
      id: "worktree",
      describe: "必须建好 worktree 与分支（.worktrees/<名字>，feat/* 或 fix/*）",
      check: (c) => c.worktree !== null,
    },
    { id: "pr", describe: "必须开 WIP PR（任务一开始就建）", check: (c) => c.pr !== null },
    {
      id: "sessionInWorktree",
      describe: "会话必须已经进入 worktree 里工作（omp 用 /wt <branch> 或 /move <path>）",
      check: sessionInsideWorktree,
    },
    {
      id: "pushedAtLeastOnce",
      describe: "至少要有一次推送记录（进度要能每天看到）",
      check: (c) => c.pushes.length > 0,
    },
    {
      id: "accepted",
      describe: "必须由人明确验收（门禁 G3）",
      check: (c) => c.acceptedAt !== undefined,
    },
    {
      id: "prMerged",
      describe: "PR 必须已合并（PR 合并前不许进入下一步）",
      check: (c) => c.pr?.state === "merged",
    },
    {
      id: "cleanupCompleted",
      describe: "合并后的现场清理必须已完成（门禁 G4）",
      check: (c) => c.cleanedAt !== undefined,
    },
  ],

  gates: [
    { id: "G1", on: ["issue", "ready"], kind: "approve", title: "批准方案" },
    { id: "G3", on: ["review", "merged"], kind: "review", title: "验收" },
    {
      id: "G4",
      on: ["merged", "done"],
      kind: "cleanup",
      title: "清理确认",
      report: ["worktree.path", "worktree.branch", "PR 状态"],
    },
  ],

  requires: {
    "issue -> ready": ["issue", "planApproved"],
    "ready -> working": ["worktree", "pr", "sessionInWorktree"],
    "working -> review": ["pr", "pushedAtLeastOnce"],
    "review -> merged": ["accepted", "prMerged"],
    "merged -> done": ["cleanupCompleted"],
    "blocked -> working": ["worktree", "pr", "sessionInWorktree"],
  },

  /**
   * 自动节点：每个"可能让状态前进"的事实事件都挂一条，谁最后到谁触发前进；
   * 能不能前进由 requires 决定，缺项就只是记一笔 note，不报错。
   */
  automations: [
    {
      name: "issued-plan-advances-to-ready",
      on: "gate.decided",
      when: (c) => c.state === "issue",
      do: [{ setState: "ready" }],
    },
    {
      name: "pr-bound-advances-to-working",
      on: "pr.bound",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
    },
    {
      name: "worktree-bound-advances-to-working",
      on: "worktree.bound",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
    },
    {
      name: "claim-advances-to-working",
      on: "session.started",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
    },
    {
      name: "end-advances-to-review",
      on: "session.ended",
      when: (c) => c.state === "working",
      do: [{ setState: "review" }],
    },
    {
      name: "merged-opens-cleanup",
      on: "pr.merged",
      when: (c) => c.state === "review",
      do: [{ setState: "merged" }, { openGate: "G4" }],
    },
    {
      name: "accepted-merges",
      on: "card.accepted",
      when: (c) => c.state === "review",
      do: [{ setState: "merged" }, { openGate: "G4" }],
    },
  ],
});

export type PersonalFlow = typeof personalFlow;
