/**
 * 共享类型与校验：server / cli / 前端共用同一份契约。
 * 约定：所有外部输入（HTTP body、CLI 参数）都用这里的 zod schema 校验后再进引擎。
 */
import { z } from "zod";

export const CARD_STATES = [
  "inbox",
  "issue",
  "ready",
  "working",
  "review",
  "merged",
  "done",
  "blocked",
  "dropped",
] as const;
export type CardState = (typeof CARD_STATES)[number];

export const STATE_LABELS: Record<CardState, string> = {
  inbox: "收件箱",
  issue: "立 Issue",
  ready: "待开工",
  working: "实施中",
  review: "待验收",
  merged: "已合并待清理",
  done: "完成",
  blocked: "阻塞",
  dropped: "放弃",
};

export type ActorKind = "human" | "agent" | "system";
export type Actor = {
  kind: ActorKind;
  name?: string | undefined;
  harness?: string | undefined;
  sessionId?: string | undefined;
};

export type IssueRef = {
  repo: string;
  number: number;
  url: string;
  title?: string;
  state: "open" | "closed";
};

export type PrRef = {
  repo: string;
  number: number;
  url: string;
  branch: string;
  state: "draft" | "open" | "merged" | "closed";
  ci?: "pending" | "pass" | "fail";
};

export type WorktreeRef = {
  path: string;
  branch: string;
  source: "harness" | "flowcard";
};

export type SessionState = "idle" | "running" | "ended" | "lost";

export type Session = {
  harness: string;
  id: string;
  file?: string;
  agentKind: "main" | "sub";
  cwd: string;
  state: SessionState;
  startedAt: string;
  lastSeenAt: string;
  resumeHint?: string;
};

export type GateStatus = "open" | "approved" | "rejected";

export type Gate = {
  id: string;
  kind: "approve" | "confirm" | "review" | "cleanup";
  title: string;
  status: GateStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  payload?: Record<string, unknown>;
};

export const CONFIRM_ACTIONS = ["push", "openPr", "commentRemote", "merge", "other"] as const;
export type ConfirmAction = (typeof CONFIRM_ACTIONS)[number];

export type ConfirmStatus = "pending" | "approved" | "rejected";

/**
 * G2 远程写确认：**一次授权只覆盖一次动作**（凭据，不是流程节点）。
 *
 * 与 `card.gates`（流程节点，一张卡同时最多一个未决）的区别：确认可以有多条、有历史，
 * 所以单独占一个槽位；pending 的确认不挡别的动作，但 **consumeConfirm 成功即作废**。
 */
export type Confirmation = {
  /** 卡片内自增，形如 "cf1"；由投影按已有确认推导（不额外维护计数器） */
  id: string;
  action: ConfirmAction;
  /** 将执行的确切命令或 URL（10..2000 字）——人就是照这个做判断的 */
  detail: string;
  status: ConfirmStatus;
  requestedAt: string;
  requestedBy: Actor;
  decidedAt?: string;
  decidedBy?: string;
  /** 驳回时必须写：下一次申请才知道该怎么改 */
  reason?: string;
  /** agent 回报「这次授权已经用掉了」的时间 */
  consumedAt?: string;
};

export type PushRecord = { sha: string; at: string; actor: Actor };

export type Comment = { id: string; at: string; actor: Actor; body: string };

/** 卡片自己的项目运行时（启动按钮管的就是它）。进程的 spawn/kill 在适配层，这里只是事件投影。 */
export type RuntimeStatus = "stopped" | "starting" | "running" | "failed";

export type Runtime = {
  status: RuntimeStatus;
  /** 只记 flowcard 自己启动的那个进程组 leader 的 pid */
  pid?: number;
  startedAt?: string;
  ports?: number[];
  logPath?: string;
};

/** 卡片投影：issue / pr / worktree 三个槽位永远存在（可为 null），空也要能渲染。 */
export type Card = {
  id: string;
  title: string;
  body: string;
  state: CardState;
  repoPath?: string;
  issue: IssueRef | null;
  pr: PrRef | null;
  worktree: WorktreeRef | null;
  session: Session | null;
  runtime: Runtime | null;
  gates: Record<string, Gate>;
  /** G2 远程写确认：按申请顺序追加，历史不删 */
  confirmations: Confirmation[];
  pushes: PushRecord[];
  comments: Comment[];
  partOf?: string;
  spawned: string[];
  acceptedAt?: string;
  cleanedAt?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type EventType =
  | "card.opened"
  | "card.state.changed"
  | "card.comment.added"
  | "card.spawned"
  | "card.accepted"
  | "card.blocked"
  | "issue.bound"
  | "worktree.bound"
  | "worktree.removed"
  | "pr.bound"
  | "pr.updated"
  | "pr.merged"
  | "push.recorded"
  | "gate.requested"
  | "gate.decided"
  | "confirm.requested"
  | "confirm.decided"
  | "confirm.consumed"
  | "cleanup.proposed"
  | "cleanup.completed"
  | "session.started"
  | "session.heartbeat"
  | "session.ended"
  | "session.cwd.mismatch"
  | "runtime.starting"
  | "runtime.started"
  | "runtime.failed"
  | "runtime.stopped"
  | "git.probed";

export type Event = {
  id: string;
  seq: number;
  at: string;
  actor: Actor;
  cardId: string;
  type: EventType;
  payload: Record<string, unknown>;
  dedupeKey: string;
};

/** 引擎拒绝：缺哪一项必要条件，或状态/门禁不允许。 */
export type Rejection = {
  code:
    | "USAGE_ERROR"
    | "NOT_FOUND"
    | "STATE_NOT_ALLOWED"
    | "MISSING_REQUIREMENT"
    | "GATE_PENDING"
    | "SESSION_CONFLICT"
    | "WORKTREE_MISMATCH";
  message: string;
  missing?: string[];
  hint?: string;
};

// ---------------------------------------------------------------- zod 输入

const actorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  name: z.string().min(1).optional(),
  harness: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});

export const sessionInSchema = z.object({
  harness: z.string().min(1),
  id: z.string().min(1),
  file: z.string().min(1).optional(),
  agentKind: z.enum(["main", "sub"]).default("main"),
  cwd: z.string().min(1),
  resumeHint: z.string().min(1).optional(),
});

export const issueInSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  title: z.string().optional(),
  state: z.enum(["open", "closed"]).default("open"),
});

export const worktreeInSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  source: z.enum(["harness", "flowcard"]).default("flowcard"),
});

export const prInSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().min(1),
  branch: z.string().min(1),
  state: z.enum(["draft", "open", "merged", "closed"]).default("open"),
  ci: z.enum(["pending", "pass", "fail"]).optional(),
});

/** CLI / HTTP 的命令体：一条命令 = 一次写入意图。 */
export const commandSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("open"),
    actor: actorSchema,
    title: z.string().min(1),
    body: z.string().default(""),
    repoPath: z.string().optional(),
    issue: issueInSchema.optional(),
    partOf: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("bindIssue"),
    actor: actorSchema,
    card: z.string().min(1),
    issue: issueInSchema,
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("plan"),
    actor: actorSchema,
    card: z.string().min(1),
    body: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("decideGate"),
    actor: actorSchema,
    card: z.string().min(1),
    gate: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("worktree"),
    actor: actorSchema,
    card: z.string().min(1),
    worktree: worktreeInSchema,
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("claim"),
    actor: actorSchema,
    /**
     * 卡片 id **可选**：不写时由服务端按 `session.cwd` 落在哪张卡片的 worktree 里解析
     * （`FLOWCARD_CARD` 是显式覆盖）。解析要读全部卡片，所以引擎只收 store 注入的回调。
     */
    card: z.string().min(1).optional(),
    session: sessionInSchema,
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("beat"),
    actor: actorSchema,
    card: z.string().min(1),
    session: z.object({
      harness: z.string().min(1),
      id: z.string().min(1),
      cwd: z.string().min(1),
      agentKind: z.enum(["main", "sub"]).default("main"),
    }),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("bindPr"),
    actor: actorSchema,
    card: z.string().min(1),
    pr: prInSchema,
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("push"),
    actor: actorSchema,
    card: z.string().min(1),
    sha: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("end"),
    actor: actorSchema,
    card: z.string().min(1),
    sessionId: z.string().optional(),
    summary: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("accept"),
    actor: actorSchema,
    card: z.string().min(1),
    reason: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("block"),
    actor: actorSchema,
    card: z.string().min(1),
    reason: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("unblock"),
    actor: actorSchema,
    card: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("probePr"),
    actor: actorSchema,
    card: z.string().min(1),
    pr: prInSchema,
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("proposeCleanup"),
    actor: actorSchema,
    card: z.string().min(1),
    items: z.array(z.string().min(1)).min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("cleanup"),
    actor: actorSchema,
    card: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("comment"),
    actor: actorSchema,
    card: z.string().min(1),
    body: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("spawn"),
    actor: actorSchema,
    card: z.string().min(1),
    title: z.string().min(1),
    body: z.string().default(""),
    dedupeKey: z.string().optional(),
  }),
  /**
   * 运行时状态事件：进程本身由适配层（src/server/runtime.ts）管，引擎只把状态写进事件流。
   * 启动按钮的 POST /api/cards/:id/runtime 最终就是落成这条命令。
   */
  z.object({
    cmd: z.literal("runtime"),
    actor: actorSchema,
    card: z.string().min(1),
    to: z.enum(["starting", "running", "failed", "stopped"]),
    pid: z.number().int().positive().optional(),
    pgid: z.number().int().positive().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
    startedAt: z.string().min(1).optional(),
    ports: z.array(z.number().int().positive()).optional(),
    logPath: z.string().min(1).optional(),
    /** 进程启动时刻（/proc/<pid>/stat 第 22 字段），重启后用它判断 pid 是否被复用 */
    procStart: z.string().min(1).optional(),
    dedupeKey: z.string().optional(),
  }),
  /**
   * G2 远程写确认：申请 / 决策 / 用掉。看板不执行远程写，这三条命令只动凭据。
   * detail 用 trim 后判长度：空白串不算「说清了要执行什么」。
   */
  z.object({
    cmd: z.literal("requestConfirm"),
    actor: actorSchema,
    card: z.string().min(1),
    action: z.enum(CONFIRM_ACTIONS),
    detail: z
      .string()
      .trim()
      .min(10, "太短了：要写清将要执行的确切命令或 URL（至少 10 个字符）")
      .max(2000, "太长了：detail 最多 2000 字，贴真正要执行的那一条"),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("decideConfirm"),
    actor: actorSchema,
    card: z.string().min(1),
    id: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("consumeConfirm"),
    actor: actorSchema,
    card: z.string().min(1),
    id: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
]);

export type Command = z.infer<typeof commandSchema>;

/**
 * `claim` 不带 `card` 时的解析结果。
 *
 * 解析规则（实现在 `server/store.ts`）：cwd 落在某张卡片 `worktree.path` 之内（路径段比较，
 * `/a/b` 不匹配 `/a/bc`）就算命中；多张命中取路径最长的那个；零命中或有并列最长（拿不到唯一解）
 * 就返回 `error`。message/hint 由 store 拼好（它才知道有哪些卡片），引擎只原样转述。
 */
export type CwdClaimResolution = { cardId: string } | { error: { message: string; hint: string } };

/** POST /api/cards/:id/runtime 的 body。 */
export const runtimeActionSchema = z.object({ action: z.enum(["up", "down"]) });

export type RuntimeAction = z.infer<typeof runtimeActionSchema>["action"];
