/**
 * 网络边界校验：后端返回的都是外部数据，进 UI 之前先用 zod 解析一次。
 * 这些 schema 与 `src/shared/types.ts` 的投影类型用文件末尾的编译期断言锁在一起，
 * 后端加字段/改字段时，web 的 `npm run web:typecheck` 会先报错。
 */
import { z } from "zod";
import { CARD_STATES, type Card, type Runtime } from "@/lib/contract";

const actorSchema = z.looseObject({
  kind: z.enum(["human", "agent", "system"]),
  name: z.string().optional(),
  harness: z.string().optional(),
  sessionId: z.string().optional(),
});

const issueSchema = z.looseObject({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string().optional(),
  state: z.enum(["open", "closed"]),
});

const prSchema = z.looseObject({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  branch: z.string(),
  state: z.enum(["draft", "open", "merged", "closed"]),
  ci: z.enum(["pending", "pass", "fail"]).optional(),
});

const worktreeSchema = z.looseObject({
  path: z.string(),
  branch: z.string(),
  source: z.enum(["harness", "flowcard"]),
});

const sessionSchema = z.looseObject({
  harness: z.string(),
  id: z.string(),
  file: z.string().optional(),
  agentKind: z.enum(["main", "sub"]),
  cwd: z.string(),
  state: z.enum(["idle", "running", "ended", "lost"]),
  startedAt: z.string(),
  lastSeenAt: z.string(),
  resumeHint: z.string().optional(),
});

const gateSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(["approve", "confirm", "review", "cleanup"]),
  title: z.string(),
  status: z.enum(["open", "approved", "rejected"]),
  requestedAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  reason: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const pushSchema = z.looseObject({
  sha: z.string(),
  at: z.string(),
  actor: actorSchema,
});

/** G2 远程写确认（`Card.confirmations`）。 */
const confirmationSchema = z.looseObject({
  id: z.string(),
  action: z.enum(["push", "openPr", "commentRemote", "merge", "other"]),
  detail: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  requestedAt: z.string(),
  requestedBy: actorSchema,
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  reason: z.string().optional(),
  consumedAt: z.string().optional(),
});

const commentSchema = z.looseObject({
  id: z.string(),
  at: z.string(),
  actor: actorSchema,
  body: z.string(),
});

/** 远端评论（`Card.remoteComments`，同步进来的只读投影）；老投影缺这个字段时按空数组处理。 */
const remoteCommentSchema = z.looseObject({
  id: z.number(),
  issueNumber: z.number(),
  author: z.string(),
  body: z.string(),
  at: z.string(),
  url: z.string(),
  read: z.boolean().default(false),
});

/**
 * 代码评审（`Card.review`，恒存在）：行级注释 + 最后一次判定。
 * 与共享契约 `src/shared/types.ts` 的 `Review` 用文件末尾的编译期断言锁在一起。
 */
const reviewCommentSchema = z.looseObject({
  id: z.string(),
  sha: z.string(),
  path: z.string(),
  line: z.number(),
  side: z.enum(["new", "old"]).catch("new"),
  body: z.string(),
  at: z.string(),
  actor: actorSchema,
  /** true = 这条评论基于的提交已不是当前 head（行可能已漂） */
  outdated: z.boolean().default(false),
});

const reviewVerdictSchema = z.looseObject({
  decision: z.enum(["approve", "request_changes", "comment"]).catch("comment"),
  at: z.string(),
  by: z.string(),
  body: z.string().optional(),
});

const reviewSchema = z.looseObject({
  comments: z.array(reviewCommentSchema).default([]),
  verdict: reviewVerdictSchema.optional(),
});

/** 运行时字段（`Card.runtime: Runtime | null`）。 */
const runtimeSchema = z.looseObject({
  status: z.enum(["stopped", "starting", "running", "failed"]),
  pid: z.number().optional(),
  startedAt: z.string().optional(),
  ports: z.array(z.number()).optional(),
  logPath: z.string().optional(),
});

export const cardViewSchema = z.looseObject({
  deletedAt: z.string().optional(),
  deletedReason: z.string().optional(),
  id: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.enum(CARD_STATES),
  /** 归属项目（`Project.id`）；服务端把没归属的老卡投影成 `local` */
  projectId: z.string(),
  repoPath: z.string().optional(),
  issue: issueSchema.nullable(),
  pr: prSchema.nullable(),
  worktree: worktreeSchema.nullable(),
  session: sessionSchema.nullable(),
  runtime: runtimeSchema.nullable(),
  gates: z.record(z.string(), gateSchema),
  confirmations: z.array(confirmationSchema),
  pushes: z.array(pushSchema),
  comments: z.array(commentSchema),
  /** 同步进来的远端评论（只读）；老投影缺这个字段时按空数组处理 */
  remoteComments: z.array(remoteCommentSchema).default([]),
  /** 代码评审（本地事实）；老投影缺这个字段时按"空评审"处理，别让整个看板解析失败 */
  review: reviewSchema.default(() => ({ comments: [] })),
  partOf: z.string().optional(),
  spawned: z.array(z.string()),
  acceptedAt: z.string().optional(),
  cleanedAt: z.string().optional(),
  blockedReason: z.string().optional(),
  createdAt: z.string(),
  /** 卡片版本（每折一条事件 +1）；意图类命令的幂等键用它（见 `src/server/engine.ts`）。 */
  eventCount: z.number(),
  updatedAt: z.string(),
});

const cardsResponseSchema = z.looseObject({ cards: z.array(cardViewSchema) });
const cardResponseSchema = z.looseObject({ card: cardViewSchema });

const rejectionSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  missing: z.array(z.string()).optional(),
  hint: z.string().optional(),
});

export const commandsResponseSchema = z.looseObject({
  ok: z.boolean(),
  card: cardViewSchema.optional(),
  inserted: z.number().optional(),
  duplicates: z.number().optional(),
  notes: z.array(z.string()).optional(),
  rejection: rejectionSchema.optional(),
  blocked: z.looseObject({ missing: z.array(z.string()) }).optional(),
  /** 开卡即开工的结果（只有 `open` 会带；服务端 `FLOWCARD_AUTOSTART=0` 时没有）。 */
  autostart: z
    .looseObject({
      status: z.string(),
      cwd: z.string().optional(),
      summary: z.string(),
    })
    .optional(),
});

/**
 * `POST /api/cards/:id/runtime` 的返回：对齐 `src/server/runtime.ts` 的 RuntimeActionResult，
 * 但只强制 ok，其余字段宽松处理（服务端路由可能还在落地）。
 */
export const runtimeResponseSchema = z.looseObject({
  ok: z.boolean(),
  action: z.enum(["up", "down"]).optional(),
  cardId: z.string().optional(),
  runtime: runtimeSchema.nullable().optional(),
  killed: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  error: z
    .looseObject({ code: z.string(), message: z.string(), hint: z.string().optional() })
    .nullable()
    .optional(),
});

export const changedPayloadSchema = z.looseObject({
  cardIds: z.array(z.string()),
  types: z.array(z.string()),
});

export type CardView = z.infer<typeof cardViewSchema>;
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;
export type ChangedPayload = z.infer<typeof changedPayloadSchema>;

export const cardsResponse = {
  parse: (raw: unknown) => cardsResponseSchema.safeParse(raw),
  select: (parsed: z.infer<typeof cardsResponseSchema>) => parsed.cards,
} as const;

export const cardResponse = {
  parse: (raw: unknown) => cardResponseSchema.safeParse(raw),
  select: (parsed: z.infer<typeof cardResponseSchema>) => parsed.card,
} as const;

/** 把 zod 的 issue 列表压成一行中文提示，方便直接扔进 UI 的错误条。 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

// ------------------------------------------------------------------ 契约锁
type Assert<T extends true> = T;
type Assignable<From, To> = From extends To ? true : false;

type _SchemaCoversProjection = Assert<Assignable<CardView, Card>>;
type _ProjectionCoversSchema = Assert<Assignable<Card, CardView>>;
