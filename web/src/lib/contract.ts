/**
 * 唯一一处跨边界引用：类型从 `src/shared/types.ts` 走 `import type`（编译期擦除，不进 bundle）；
 * 两个字面量表在前端本地镜像，并用类型断言锁死与共享契约的一致性（见文件末尾的编译期检查）。
 */
import type { CardState, ConfirmAction, ConfirmStatus, RuntimeStatus } from "../../../src/shared/types.ts";

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

type _StatesExactlyMatch =
  Assert<Equal<(typeof CARD_STATES)[number], CardState>>;
type _LabelsAreExhaustive = Assert<Equal<keyof typeof STATE_LABELS, CardState>>;
type _RuntimeLabelsAreExhaustive = Assert<Equal<keyof typeof RUNTIME_LABELS, RuntimeStatus>>;
type _ConfirmActionLabelsAreExhaustive = Assert<Equal<keyof typeof CONFIRM_ACTION_LABELS, ConfirmAction>>;
type _ConfirmStatusLabelsAreExhaustive = Assert<Equal<keyof typeof CONFIRM_STATUS_LABELS, ConfirmStatus>>;
