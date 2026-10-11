/**
 * 唯一一处跨边界引用：类型从 `src/shared/types.ts` 走 `import type`（编译期擦除，不进 bundle）；
 * 两个字面量表在前端本地镜像，并用类型断言锁死与共享契约的一致性（见文件末尾的编译期检查）。
 */
import type { CardState, ConfirmAction, ConfirmStatus, RuntimeStatus } from "../../../src/shared/types.ts";
import type { Stage } from "../../../src/shared/stage.ts";
import type { FlowActor } from "../../../src/shared/flow.ts";

export type {
  Card,
  CardState,
  ConfirmAction,
  ConfirmStatus,
  Confirmation,
  Gate,
  RemoteComment,
  Review,
  ReviewComment,
  ReviewSide,
  ReviewVerdict,
  ReviewVerdictKind,
  Runtime,
  RuntimeAction,
  RuntimeStatus,
  Session,
} from "../../../src/shared/types.ts";

/**
 * 托管会话（`/api/cards/:id/session*`，见 `lib/session.ts`）的对外类型：
 * 组件一律从 `@/lib/contract` 取类型，真实实现留在 session.ts。
 */
export type {
  HostedSessionStatus,
  SessionEvent,
  SessionMessage,
  SessionNotice,
  SessionRole,
  SessionState,
  SessionTool,
  SessionView,
} from "@/lib/session";

/**
 * 看板列的**派生阶段**（`src/shared/stage.ts` 是唯一来源：列集合、判据、纯函数都在那里）。
 * 前端只读不改 —— 要让列变多/变少、改判据，改共享层那一处即可，这里自动跟上。
 */
import { STAGE_RULES } from "../../../src/shared/stage.ts";

export {
  deriveStage,
  STAGE_EMPTY_HINTS,
  STAGE_FACT_LABELS,
  STAGE_FALLBACK,
  STAGE_LABELS,
  STAGE_RULES,
  STAGES,
  withStage,
} from "../../../src/shared/stage.ts";
export type {
  CardGitFacts,
  Stage,
  StageFactSource,
  StageFacts,
  StageRule,
  StagedCard,
} from "../../../src/shared/stage.ts";

/**
 * 谁动手（`human` = 人拍板/动手，`llm` = agent 干活）—— 类型只有这两个取值，
 * 判定口径写在 `src/shared/flow.ts` 的 `FlowActor`（机器事实不算第三方）。
 * 类型走 `import type`：`flow.ts` 会拖进 node 侧模块，**值**一律不许从那里进 bundle。
 */
export type { FlowActor } from "../../../src/shared/flow.ts";

/** actor 的显示文字：用户要求「直接用 human 和 llm 标注」，**文字就是这两个词本身**，别换词。 */
export const ACTOR_TEXT: Record<FlowActor, string> = {
  human: "human",
  llm: "llm",
};

/** actor 的悬停解释（只在 title / 图例里出现，标签文字仍然是上面那两个词）。 */
export const ACTOR_HINT: Record<FlowActor, string> = {
  human: "human：要人拍板或动手（验收 G3、清理 G4、远程写授权、等人看/合 PR、解除阻塞）",
  llm: "llm：agent 干活推进（建 worktree、实施、开 PR、推送、写转录、按会话回执前进）",
};

/** actor 的样式（Tailwind 类名必须留在 web 里，构建时才扫得到）。 */
export const ACTOR_TONE: Record<FlowActor, string> = {
  human: "border-rose-200 bg-rose-50 text-rose-700",
  llm: "border-sky-200 bg-sky-50 text-sky-700",
};

/**
 * 每列**在等谁动手**与它的**人话判据** —— 直接从 `STAGE_RULES` 生成（别在组件里手写第二份）。
 * 看板列头与 Workflow 视图都读这两份，改判据只改 `src/shared/stage.ts`。
 */
export const STAGE_ACTOR: Record<Stage, FlowActor> = Object.fromEntries(
  STAGE_RULES.map((rule) => [rule.stage, rule.actor]),
) as Record<Stage, FlowActor>;

export const STAGE_WHEN: Record<Stage, string> = Object.fromEntries(
  STAGE_RULES.map((rule) => [rule.stage, rule.when]),
) as Record<Stage, string>;

/**
 * 「看板列头 → Workflow 里这一列」的锚点（单向的 hash 深链，App 监听 hashchange 切视图）。
 * Workflow 视图里对应的节点 id 是 `wf-stage-<stage>`。
 */
export function stageTraceHash(stage: Stage): string {
  return `#workflow/stage/${stage}`;
}

/** 各列的进度点颜色（Tailwind 类名必须留在 web 里，构建时才扫得到）。 */
export const STAGE_TONE: Record<Stage, string> = {
  dropped: "bg-neutral-400",
  done: "bg-emerald-600",
  blocked: "bg-red-600",
  merged: "bg-teal-600",
  review: "bg-violet-500",
  prReview: "bg-sky-500",
  prTodo: "bg-amber-500",
  working: "bg-blue-600",
  backlog: "bg-neutral-300",
};

/** 与 CARD_STATES 同序，看板列顺序即此顺序。 */
export const CARD_STATES = [
  "ready",
  "working",
  "review",
  "merged",
  "done",
  "blocked",
  "dropped",
] as const satisfies readonly CardState[];

export const STATE_LABELS: Record<CardState, string> = {
  ready: "待开工",
  working: "实施中",
  review: "待验收",
  merged: "已合并待清理",
  done: "完成",
  blocked: "阻塞",
  dropped: "放弃",
};

/** 运行时的进度点颜色对应的中文名。 */
export const STATE_TONE: Record<CardState, string> = {
  ready: "bg-amber-500",
  working: "bg-blue-600",
  review: "bg-violet-500",
  merged: "bg-teal-600",
  done: "bg-emerald-600",
  blocked: "bg-red-600",
  dropped: "bg-neutral-400",
};

/** 运行时会话态 → 中文。 */
export const SESSION_STATE_LABELS: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  ended: "已结束",
  lost: "失联",
};

export const GATE_STATUS_LABELS: Record<string, string> = {
  open: "待决",
  approved: "已批准",
  rejected: "已驳回",
};

/** G2 远程写确认（`card.confirmations`）：一次授权只覆盖一次动作。 */
export const CONFIRM_ACTION_LABELS: Record<ConfirmAction, string> = {
  push: "推送 push",
  openPr: "开/改 PR",
  commentRemote: "远程评论",
  merge: "合并 merge",
  other: "其他远程写",
};

export const CONFIRM_STATUS_LABELS: Record<ConfirmStatus, string> = {
  pending: "待批",
  approved: "已批准",
  rejected: "已驳回",
};

/**
 * 运行时（`card.runtime`）：契约在 `src/shared/types.ts` 的 `Runtime`。
 * 后端可能还没把 `POST /api/cards/:id/runtime` 挂上，所以 UI 侧对 null 与 404 都要能降级。
 */
export const RUNTIME_LABELS: Record<RuntimeStatus, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  failed: "启动失败",
};

export const RUNTIME_TONE: Record<RuntimeStatus, string> = {
  stopped: "bg-neutral-400",
  starting: "bg-amber-500",
  running: "bg-emerald-600",
  failed: "bg-red-600",
};

// ------------------------------------------------------------------ 契约锁
// 若 src/shared/types.ts 增删状态，下面的断言会让 web 的类型检查直接失败。
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type _ActorTextIsExhaustive = Assert<Equal<keyof typeof ACTOR_TEXT, FlowActor>>;
type _ActorToneIsExhaustive = Assert<Equal<keyof typeof ACTOR_TONE, FlowActor>>;
type _StatesExactlyMatch =
  Assert<Equal<(typeof CARD_STATES)[number], CardState>>;
type _LabelsAreExhaustive = Assert<Equal<keyof typeof STATE_LABELS, CardState>>;
type _RuntimeLabelsAreExhaustive = Assert<Equal<keyof typeof RUNTIME_LABELS, RuntimeStatus>>;
type _ConfirmActionLabelsAreExhaustive = Assert<Equal<keyof typeof CONFIRM_ACTION_LABELS, ConfirmAction>>;
type _ConfirmStatusLabelsAreExhaustive = Assert<Equal<keyof typeof CONFIRM_STATUS_LABELS, ConfirmStatus>>;
