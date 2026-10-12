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

  /**
   * **动作节点层**：把上面那七步状态机细到「具体动作 → 具体动作」。
   *
   * 规矩（`defineFlow` 会校验）：
   * - **数组顺序 = 执行顺序**，`needsActions` 只能指向前面的节点；
   * - `actor` / `actorWhy` / `output` / `evidence` 每个节点都得写（口径见 `shared/flow.ts` 的 `FlowActor`）；
   * - `command` 字段写 CLI 命令，**必须真实存在**（`src/cli/commands.ts` 的命令表），
   *   `actor: "command"` 的节点必须有命令，人/模型做判断的节点没有命令就写 `null`；
   * - `toState` / `toStage` 说清这一步把卡片推到哪个状态、之后落在看板哪一列。
   *
   * 状态机那层（`stateActors` / `transitionActors` / `gates` / `automations`）不改：
   * 细分只体现在这里，`Card.state` 仍然只有那七个值。
   */
  actions: [
    {
      id: "open-card",
      title: "立项：建卡",
      actor: "human",
      actorWhy: "要不要做这件事、做到什么程度，是人的意图；agent 只能按给定的活往下做",
      needsActions: [],
      needsStates: [],
      output: "一张 ready 卡（正文 + 归属项目）",
      evidence: [{ kind: "event", name: "card.opened" }, { kind: "field", path: "card.title" }],
      toState: "ready",
      toStage: "backlog",
      command: "flowcard open",
    },
    {
      id: "bind-issue",
      title: "绑 Issue",
      actor: "llm",
      actorWhy: "把活儿对上 Issue 编号，agent 按上下文绑；这一步人不需要做判断",
      needsActions: ["open-card"],
      needsStates: ["ready"],
      output: "卡片带上 issue {repo, number, url}",
      evidence: [{ kind: "event", name: "issue.bound" }, { kind: "field", path: "card.issue" }],
      toState: null,
      toStage: "backlog",
      command: "flowcard issue",
    },
    {
      id: "spawn-part",
      title: "拆片：在边界内开子卡",
      actor: "llm",
      actorWhy: "大需求怎么拆成几片、每片一条 PR，是 agent 在自己那边的判断",
      needsActions: ["bind-issue"],
      needsStates: ["ready", "working"],
      output: "子卡（partOf 指向原卡，自己带一条 PR）",
      evidence: [{ kind: "event", name: "card.spawned" }, { kind: "field", path: "card.partOf" }],
      toState: "ready",
      toStage: "backlog",
      command: "flowcard spawn",
    },
    {
      id: "create-worktree",
      title: "建 worktree + 分支",
      actor: "command",
      actorWhy: "路径和分支名已经由 `worktree use` 的参数定好，这一步只是把它落到磁盘上；没有任何判断",
      needsActions: ["bind-issue"],
      needsStates: ["ready"],
      output: "`.worktrees/<名字>` + 一条分支（卡片记 worktree）",
      evidence: [{ kind: "event", name: "worktree.bound" }, { kind: "field", path: "card.worktree.path" }],
      toState: "working",
      toStage: "working",
      command: "flowcard worktree use",
    },
    {
      id: "start-session",
      title: "起会话（认领）",
      actor: "llm",
      actorWhy: "起会话、把开工提示与 brief 喂进去，都是 agent 干的；人不需要在场",
      needsActions: ["create-worktree"],
      needsStates: ["ready", "working"],
      output: "托管会话（cwd 落在 worktree 里）",
      evidence: [{ kind: "event", name: "session.started" }, { kind: "field", path: "card.session" }],
      toState: "working",
      toStage: "working",
      command: "flowcard claim",
    },
    {
      id: "read-board",
      title: "读投影（stage + git 实况）",
      actor: "command",
      actorWhy: "只读投影：服务端顺手采集 git 实况，没有任何判断；agent 靠它知道自己该干什么",
      needsActions: ["start-session"],
      needsStates: ["working"],
      output: "每张卡的 stage、dirtyFiles、commitsSinceBase",
      evidence: [{ kind: "event", name: "git.probed" }, { kind: "field", path: "card.git.dirtyFiles" }],
      toState: null,
      toStage: null,
      command: "flowcard list",
    },
    {
      id: "implement-brief",
      title: "按 brief 实施",
      actor: "llm",
      actorWhy: "写代码、改文件是 agent 的活；人只在验收那一站出现",
      needsActions: ["start-session"],
      needsStates: ["working"],
      output: "worktree 里的改动（脏文件 + 提交）",
      evidence: [
        { kind: "event", name: "session.heartbeat" },
        { kind: "field", path: "card.git.dirtyFiles" },
      ],
      toState: null,
      toStage: "working",
      command: null,
    },
    {
      id: "run-verification",
      title: "跑验证（typecheck / 测试 / 构建）",
      actor: "llm",
      actorWhy: "跑哪些验证、红了怎么改，是 agent 自己的判断",
      needsActions: ["implement-brief"],
      needsStates: ["working"],
      output: "验证结果（**目前只留在会话转录里，没有卡片事实**）",
      evidence: [
        { kind: "event", name: "session.heartbeat" },
        { kind: "field", path: "card.git.commitsSinceBase" },
      ],
      toState: null,
      toStage: null,
      command: null,
    },
    {
      id: "make-commit",
      title: "提交（本地提交，还没开 PR）",
      actor: "llm",
      actorWhy: "「这批改动该不该落成一个提交」是 agent 的判断；`flowcard` 不管 git 提交",
      needsActions: ["run-verification"],
      needsStates: ["working"],
      output: "相对基线的提交（commitsSinceBase > 0）",
      evidence: [{ kind: "field", path: "card.git.commitsSinceBase" }],
      toState: null,
      toStage: "prTodo",
      command: null,
    },
    {
      id: "remote-write-request",
      title: "远程写申请（G2）",
      actor: "llm",
      actorWhy: "agent 先说清楚要在远端做什么（推送 / 开 PR / 评论 / 合并），请求一次授权",
      needsActions: ["implement-brief"],
      needsStates: ["working"],
      output: "一条 pending 的授权（action + detail）",
      evidence: [
        { kind: "event", name: "confirm.requested" },
        { kind: "field", path: "card.confirmations" },
      ],
      toState: null,
      toStage: null,
      command: "flowcard confirm --request",
    },
    {
      id: "remote-write-approve",
      title: "人批远程写（G2）",
      actor: "human",
      actorWhy: "远程写是不可逆的外部动作，授权只有人能给；判断在人这里",
      needsActions: ["remote-write-request"],
      needsStates: ["working"],
      output: "一条 approved 的授权（**一次授权只覆盖一次动作**）",
      evidence: [
        { kind: "event", name: "confirm.decided" },
        { kind: "field", path: "card.confirmations" },
      ],
      toState: null,
      toStage: null,
      command: "flowcard confirm --approve",
    },
    {
      id: "remote-write-consume",
      title: "核销授权（consume）",
      actor: "command",
      actorWhy: "授权已经批过了，这一步只是把凭据核销掉、把动作放行；没有判断",
      needsActions: ["remote-write-approve"],
      needsStates: ["working"],
      output: "授权被 consume（consumedAt），下一次写要重新申请",
      evidence: [
        { kind: "event", name: "confirm.consumed" },
        { kind: "field", path: "card.confirmations" },
      ],
      toState: null,
      toStage: null,
      command: "flowcard confirm --consume",
    },
    {
      id: "push-record",
      title: "推送并登记",
      actor: "command",
      actorWhy: "推什么、推去哪都已经定好，登记也只是把 sha 落下来；「该不该推」的判断在 G2 那一站",
      needsActions: ["make-commit", "remote-write-consume"],
      needsStates: ["working"],
      output: "远端分支 + `pushes[]` 里一条记录",
      evidence: [{ kind: "event", name: "push.recorded" }, { kind: "field", path: "card.pushes[]" }],
      toState: null,
      toStage: "prReview",
      command: "flowcard push --sha",
    },
    {
      id: "open-wip-pr",
      title: "开 WIP PR",
      actor: "llm",
      actorWhy: "PR 的标题/正文/取哪条分支是 agent 写的；开的是草稿，不涉及别人的判断",
      needsActions: ["push-record"],
      needsStates: ["working"],
      output: "WIP（draft）PR，卡片记 pr 引用",
      evidence: [{ kind: "event", name: "pr.bound" }, { kind: "field", path: "card.pr" }],
      toState: null,
      toStage: "prReview",
      command: "flowcard pr --number",
    },
    {
      id: "ci-sync",
      title: "同步 CI / PR 状态",
      actor: "command",
      actorWhy: "只读同步：把远端的 pr.ci / pr.state 拉回来，纯机械动作，没有判断",
      needsActions: ["open-wip-pr"],
      needsStates: ["working"],
      output: "pr.ci = pending / pass / fail（只作徽标）",
      evidence: [{ kind: "event", name: "pr.updated" }, { kind: "field", path: "card.pr.ci" }],
      toState: null,
      toStage: "prReview",
      command: "flowcard sync",
    },
    {
      id: "probe-pr",
      title: "手工探测一次 PR",
      actor: "command",
      actorWhy: "同步之外的兜底探测（只读），把 PR 状态补准；没有判断",
      needsActions: ["open-wip-pr"],
      needsStates: ["working"],
      output: "补一次 pr 状态的探测结果",
      evidence: [{ kind: "event", name: "pr.updated" }, { kind: "field", path: "card.pr.state" }],
      toState: null,
      toStage: "prReview",
      command: "flowcard probe --number",
    },
    {
      id: "hand-back",
      title: "交回（结束会话、请人验收）",
      actor: "llm",
      actorWhy: "「活干完了没有、能不能交回」是 agent 的判断；交回后再往下只能等人",
      needsActions: ["open-wip-pr", "ci-sync"],
      needsStates: ["working"],
      output: "会话 ended、卡片进 review、G3 门禁自动打开",
      evidence: [
        { kind: "event", name: "session.ended" },
        { kind: "event", name: "gate.requested" },
        { kind: "field", path: "card.state" },
      ],
      toState: "review",
      toStage: "review",
      command: "flowcard end --summary",
    },
    {
      id: "ask-review",
      title: "请人验收（G3 已开，等人来批）",
      actor: "human",
      actorWhy: "这一站就是**在等人**：G3 开了之后只有人能批，agent 干等也没用",
      needsActions: ["hand-back"],
      needsStates: ["review"],
      output: "卡片停在「待你验收」列，等一个决定",
      evidence: [{ kind: "gate", id: "G3" }, { kind: "field", path: "card.gates.G3" }],
      toState: null,
      toStage: "review",
      command: null,
    },
    {
      id: "review-verdict",
      title: "提交代码评审结论",
      actor: "human",
      actorWhy: "评审结论（approve / request_changes）是人的判断，agent 不能给自己签合格证",
      needsActions: ["open-wip-pr"],
      needsStates: ["working", "review"],
      output: "评审记录（行级注释 + 结论）",
      evidence: [
        { kind: "event", name: "review.verdict.recorded" },
        { kind: "field", path: "card.review" },
      ],
      toState: null,
      toStage: "review",
      command: "flowcard review --verdict",
    },
    {
      id: "accept-review",
      title: "人验收（G3）",
      actor: "human",
      actorWhy: "验收是人的判断（门禁 G3）：`flowcard accept` 是人敲的，判断也在人这里",
      needsActions: ["ask-review"],
      needsStates: ["review"],
      output: "acceptedAt + 一条验收评论；卡片随 PR 合并进 merged",
      evidence: [{ kind: "event", name: "card.accepted" }, { kind: "field", path: "card.acceptedAt" }],
      toState: "merged",
      toStage: "merged",
      command: "flowcard accept",
    },
    {
      id: "merge-pr",
      title: "合并 PR",
      actor: "human",
      actorWhy: "合并是远程写，必须先有 G2 授权；合不合由人拍板（flowcard 里没有 merge 命令，人在 forge 上点）",
      needsActions: ["accept-review", "remote-write-consume"],
      needsStates: ["review", "merged"],
      output: "PR merged（同步探测回来）",
      evidence: [{ kind: "event", name: "pr.merged" }, { kind: "field", path: "card.pr.state" }],
      toState: "merged",
      toStage: "merged",
      command: null,
    },
    {
      id: "propose-cleanup",
      title: "清理申请（G4 清单）",
      actor: "llm",
      actorWhy: "按 G4 的报告项把要清的现场列出来（worktree / 分支 / 会话），是 agent 做的功课",
      needsActions: ["merge-pr"],
      needsStates: ["merged"],
      output: "G4 收到一份清理清单（worktree.path / branch / PR 状态）",
      evidence: [
        { kind: "event", name: "cleanup.proposed" },
        { kind: "gate", id: "G4" },
      ],
      toState: null,
      toStage: "merged",
      command: "flowcard cleanup --item",
    },
    {
      id: "approve-cleanup",
      title: "人批 G4（清理确认）",
      actor: "human",
      actorWhy: "清理现场不可逆（worktree 一删就没了验证现场），必须人确认",
      needsActions: ["propose-cleanup"],
      needsStates: ["merged"],
      output: "G4 approved",
      evidence: [{ kind: "event", name: "gate.decided" }, { kind: "field", path: "card.gates.G4" }],
      toState: null,
      toStage: "merged",
      command: "flowcard gate --gate G4 --approve",
    },
    {
      id: "cleanup-execute",
      title: "执行清理",
      actor: "command",
      actorWhy: "清单已经被 G4 批过，这一步只是照着清单把 worktree / 分支落到系统里；没有判断",
      needsActions: ["approve-cleanup"],
      needsStates: ["merged"],
      output: "现场清理完（cleanedAt），卡片 done",
      evidence: [
        { kind: "event", name: "cleanup.completed" },
        { kind: "field", path: "card.cleanedAt" },
      ],
      toState: "done",
      toStage: "done",
      command: "flowcard cleanup",
    },
    {
      id: "block-card",
      title: "阻塞（写明缺什么）",
      actor: "llm",
      actorWhy: "撞墙的是 agent：缺什么、缺到什么程度由它报，人只看结论",
      needsActions: ["start-session"],
      needsStates: ["ready", "working"],
      output: "blockedReason（**必须写明缺什么**）",
      evidence: [{ kind: "event", name: "card.blocked" }, { kind: "field", path: "card.blockedReason" }],
      toState: "blocked",
      toStage: "blocked",
      command: "flowcard block --reason",
    },
    {
      id: "unblock-card",
      title: "解除阻塞",
      actor: "human",
      actorWhy: "前置补没补齐是人说了算：只有显式 unblock 能回 working（心跳与绑 worktree 的自动化只认 ready）",
      needsActions: ["block-card"],
      needsStates: ["blocked"],
      output: "卡片回 working，接着干",
      evidence: [
        { kind: "event", name: "card.state.changed" },
        { kind: "field", path: "card.state" },
      ],
      toState: "working",
      toStage: "working",
      command: "flowcard unblock",
    },
    {
      id: "drop-card",
      title: "放弃卡片",
      actor: "human",
      actorWhy: "放弃是把活停掉的决定，只有人能做（要写原因）",
      needsActions: ["open-card"],
      needsStates: ["ready", "working", "blocked"],
      output: "卡片 dropped + 一条原因",
      evidence: [
        { kind: "event", name: "card.state.changed" },
        { kind: "field", path: "card.state" },
      ],
      toState: "dropped",
      toStage: "dropped",
      command: "flowcard drop --reason",
    },
    {
      id: "runtime-up",
      title: "拉起卡片自己的运行时（可选）",
      actor: "llm",
      actorWhy: "要不要在本卡上起一个常驻进程（预览 / 服务）由干活的一方判断",
      needsActions: ["start-session"],
      needsStates: ["working"],
      output: "runtime = running（卡片上多一个运行时徽标）",
      evidence: [
        { kind: "event", name: "runtime.started" },
        { kind: "field", path: "card.runtime" },
      ],
      toState: null,
      toStage: null,
      command: "flowcard up",
    },
    {
      id: "comment-card",
      title: "在看板上留言",
      actor: "llm",
      actorWhy: "进度和为什么这么改，agent 自己写；留言不推进流程",
      needsActions: ["open-card"],
      needsStates: ["ready", "working", "review", "merged", "blocked"],
      output: "一条本地评论（进时间线）",
      evidence: [
        { kind: "event", name: "card.comment.added" },
        { kind: "field", path: "card.comments" },
      ],
      toState: null,
      toStage: null,
      command: "flowcard comment --body",
    },
  ],
});

export type PersonalFlow = typeof personalFlow;
