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

export type PushRecord = { sha: string; at: string; actor: Actor };

export type Comment = { id: string; at: string; actor: Actor; body: string };

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
  gates: Record<string, Gate>;
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
  | "cleanup.proposed"
  | "cleanup.completed"
  | "session.started"
  | "session.heartbeat"
  | "session.ended"
  | "session.cwd.mismatch"
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
    card: z.string().min(1),
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
]);

export type Command = z.infer<typeof commandSchema>;
