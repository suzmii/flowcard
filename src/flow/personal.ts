/**
 * 个人流程：就是 skill 里那套规矩的可执行版本。
 * 每个 requires 都是一条"缺了就拦住"的硬门禁；每个 autoTransitions 都靠 requires 决定放不放行。
 *
 * 人只做三件事：远程写授权（G2 confirmations）、验收（G3）、清理确认（G4）；
 * 其余状态由事实（绑 worktree、起会话、推送、PR 合并）自动推进 —— 建卡即 `ready`，没有中间层。
 */
import { defineFlow, sessionInsideWorktree } from "../shared/flow.ts";
import { CARD_STATES } from "../shared/types.ts";

export const personalFlow = defineFlow({
  name: "personal",

  states: CARD_STATES,

  /**
   * 停在这个状态时**在等谁动手**（口径见 `shared/flow.ts` 的 `FlowActor`）：
   * 人只做三件事（远程写授权 / 验收 / 清理确认），其余都是 agent 在推。
   * 终态也标：`done` 是人验收+清理确认的结果，`dropped` 是人决定放弃。
   */
  stateActors: {
    ready: "llm", // 等 agent 建 worktree、把会话搬进去（人已经开完卡）
    working: "llm", // agent 在实施
    review: "human", // 等 G3 验收
    merged: "human", // 等 G4 清理确认
    done: "human", // 人拍板定的终态（验收 + 清理）
    blocked: "human", // 等**人**补齐前置并显式 unblock（心跳不会把它拉回 working）
    dropped: "human", // 人决定放弃（终态）
  },

  requirements: [
    {
      id: "worktree",
      describe: "必须建好 worktree 与分支（目录 .worktrees/<名字>；分支名按改动性质起，前缀跟仓库惯例走）",
      check: (c) => c.worktree !== null,
    },
    {
      id: "sessionInWorktree",
      describe: "会话必须已经在 worktree 里工作（用 flowcard worktree use 把会话搬进去）",
      check: sessionInsideWorktree,
    },
    { id: "pr", describe: "必须开 WIP PR（交付要件，不挡开工）", check: (c) => c.pr !== null },
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
    // 全流程只剩两道门禁，都是人拍板：G3 验收、G4 清理确认（G2 是凭据不是流程节点）。
    { id: "G3", on: ["review", "merged"], kind: "review", title: "验收", actor: "human" },
    {
      id: "G4",
      on: ["merged", "done"],
      kind: "cleanup",
      title: "清理确认",
      actor: "human",
      report: ["worktree.path", "worktree.branch", "PR 状态"],
    },
  ],

  requires: {
    // 开工：只要 worktree 建好、会话真的在里面干活 —— PR 是交付要件，不挡开工
    "ready -> working": ["worktree", "sessionInWorktree"],
    "working -> review": ["pr", "pushedAtLeastOnce"],
    "review -> merged": ["accepted", "prMerged"],
    "merged -> done": ["cleanupCompleted"],
    "blocked -> working": ["worktree", "sessionInWorktree"],
  },

  /**
   * 每条转换**归谁推**（口径见 `shared/flow.ts` 的 `FlowActor`）：
   * 机器事实（推送、PR merged、CI）只当条件，拍板归谁就看谁在等 ——
   * `review -> merged` 虽然有 `prMerged` 这个机器事实，但同一道坎上 `accepted`（G3）是人，
   * 所以整步标 `human`。
   */
  transitionActors: {
    "ready -> working": "llm", // agent 建 worktree + 把会话搬进去，事实自己推
    "working -> review": "llm", // agent 交回（并开 PR + 推送）
    "review -> merged": "human", // G3 验收是人 + PR 合并（机器探测，但拍板在人）
    "merged -> done": "human", // G4 清理确认是人
    "blocked -> working": "human", // 必须人补齐前置后显式 unblock
  },

  /**
   * 自动节点：每个"可能让状态前进"的事实事件都挂一条，谁最后到谁触发前进；
   * 能不能前进由 requires 决定，缺项就只是记一笔 note，不报错。
   */
  automations: [
    {
      name: "worktree-bound-advances-to-working",
      on: "worktree.bound",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
      actor: "llm",
    },
    {
      name: "claim-advances-to-working",
      on: "session.started",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
      actor: "llm",
    },
    {
      /**
       * 心跳也参与前进：会话挪进 worktree 后（/move、/wt），下一次心跳就该让卡片进「实施中」。
       * **只认 `ready`**：`blocked` 的卡必须等人补齐前置后显式 `unblock` ——
       * 否则心跳（≤30s）会把 blocked 拉回 working，`blockedReason` 被投影抹掉，
       * 「必须写明缺什么」在一个还在 worktree 里跑的会话上等于无效。
       */
      name: "beat-advances-to-working",
      on: "session.heartbeat",
      when: (c) => c.state === "ready",
      do: [{ setState: "working" }],
      actor: "llm",
    },
    {
      name: "end-advances-to-review",
      on: "session.ended",
      when: (c) => c.state === "working",
      do: [{ setState: "review" }],
      actor: "llm",
    },
    {
      name: "merged-opens-cleanup",
      on: "pr.merged",
      when: (c) => c.state === "review",
      do: [{ setState: "merged" }, { openGate: "G4" }],
      actor: "human",
    },
    {
      name: "accepted-merges",
      on: "card.accepted",
      when: (c) => c.state === "review",
      do: [{ setState: "merged" }, { openGate: "G4" }],
      actor: "human",
    },
  ],
});

export type PersonalFlow = typeof personalFlow;
