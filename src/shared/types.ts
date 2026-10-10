/**
 * 共享类型与校验：server / cli / 前端共用同一份契约。
 * 约定：所有外部输入（HTTP body、CLI 参数）都用这里的 zod schema 校验后再进引擎。
 */
import { z } from "zod";

export const CARD_STATES = [
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

/**
 * 项目 = 整块看板的 **Metadata**：一个 git 仓库。进入 flowcard 先选项目，之后建卡只填正文，
 * 归属由 `Card.projectId` 记，repo 路径/分支/远程都从这里解析（不再手填）。
 *
 * 存在性：**每个实例一定有 `local` 这个合成项目**（`virtual: true`，不在磁盘上），
 * 所有没归属的卡片（含升级前的老卡片）都落在这里。
 */
export type Project = {
  /** 由仓库根路径派生（目录名 + 哈希后缀）：短、稳定、可读 */
  id: string;
  /** 默认取仓库目录名 */
  name: string;
  /** 仓库根绝对路径（`git rev-parse --show-toplevel`；合成项目为 ""） */
  path: string;
  /** `git remote get-url origin` */
  remote?: string;
  /** `git rev-parse --abbrev-ref HEAD`；detached HEAD 时缺省 */
  headBranch?: string;
  /** `origin/HEAD` 指向的分支；拿不到就回退到存在的 main / master */
  defaultBranch?: string;
  lastCommit?: { sha: string; subject: string; at: string };
  /** `git status --porcelain` 行数（脏文件数） */
  dirtyFiles?: number;
  /**
   * Issue 基址：绑 Issue 时只给编号，`repo`/`url` 从这里补齐（省得每张卡手填三样）。
   * 添加项目时按 `remote` 派生（`server/projects.ts` 的 `deriveIssueBase`），也允许显式覆盖；
   * 认不出 remote 就缺省（此时绑 Issue 必须显式给 `--url`，或先 `flowcard project issue-base`）。
   */
  issueRepo?: string;
  /** 形如 `https://host/owner/repo/issues/{number}`；`{number}` 换成 Issue 编号 */
  issueUrlTemplate?: string;
  /** 仅本地存在的合成项目（只有 `local`） */
  virtual?: boolean;
  addedAt: string;
  lastSeenAt: string;
};

/** 从 remote 派生的 Issue 基址；两条都不给 = 认不出 remote（不瞎猜）。 */
export type IssueBase = { issueRepo?: string; issueUrlTemplate?: string };

/** 合成项目 id：没归属的卡片都落在这里。 */
export const LOCAL_PROJECT_ID = "local";
export const LOCAL_PROJECT_NAME = "未归属";

/** 图片附件的 MIME 白名单。**不含 svg**：svg 是可执行脚本，等于把 XSS 面挂到看板上。 */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/**
 * 附件元数据。`id` 是内容 sha256 前 16 位 —— 内容寻址，同一张图重复上传天然去重、天然幂等。
 * 字节落在 `<dataDir>/attachments/<id>.<ext>`（路径由 id + 扩展名推出，不用存）。
 */
export type Attachment = {
  id: string;
  mime: ImageMime;
  ext: string;
  /** 原始文件名（只作记录，不参与落盘路径） */
  name: string;
  bytes: number;
  at: string;
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

/**
 * 从 forge 同步回来的评论（issue / PR 上的）：**只读投影**，不代表本地评论。
 * 与 `Comment` 分开存（`Card.remoteComments`），免得远端评论混进本地评论的时间线；
 * `read` 由人打开详情时调的 `markRemoteCommentsRead` 置位，卡片磁贴上的「N 条新评论」数它。
 */
export type RemoteComment = {
  /** forge 上的评论 id（幂等键 `sync:comment:{id}` 用的就是它）。 */
  id: number;
  /** 评论挂在哪个编号上：issue 或 PR 的编号（两者共用一个号池）。 */
  issueNumber: number;
  author: string;
  body: string;
  /** 发表时间（UTC ISO，由同步层归一化）。 */
  at: string;
  /** 远端链接；抠不出时为 `""`（不伪造）。 */
  url: string;
  read: boolean;
};

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

// ---------------------------------------------------------------- 代码评审（本地事实）

export const REVIEW_SIDES = ["new", "old"] as const;
export type ReviewSide = (typeof REVIEW_SIDES)[number];

/**
 * 行级评审注释。锚点是 `(sha, path, line, side)`，同一个位置可以有多条（按时间排序）。
 *
 * `outdated` **不是事件里的字段**，而是投影时当场算出来的：`注释的 sha ≠ 当前 head sha` 就算过期。
 * 当前 head = 这张卡**最近一次 push 记录的 sha**（push 是 HEAD 往前走的唯一事实来源）；
 * 一次 push 都没有时 head 未知，一律 `outdated: false`（宁可不说，也不冤枉一条评论）。
 */
export type ReviewComment = {
  /** 卡片内自增，形如 "rc1"（按已有注释推导，不额外维护计数器） */
  id: string;
  sha: string;
  path: string;
  line: number;
  side: ReviewSide;
  body: string;
  at: string;
  actor: Actor;
  outdated: boolean;
};

export const REVIEW_VERDICTS = ["approve", "request_changes", "comment"] as const;
export type ReviewVerdictKind = (typeof REVIEW_VERDICTS)[number];

/** 评审判定：**只记录**。不改流程状态 —— G3 验收仍由人在看板上点。 */
export type ReviewVerdict = { decision: ReviewVerdictKind; at: string; by: string; body?: string };

/** 卡片上的评审槽位（恒存在）：注释按 `(path, line, side, at, id)` 排序，判定只留最后一次。 */
export type Review = { comments: ReviewComment[]; verdict?: ReviewVerdict };

/** 卡片投影：issue / pr / worktree 三个槽位永远存在（可为 null），空也要能渲染。 */
export type Card = {
  id: string;
  title: string;
  body: string;
  state: CardState;
  /**
   * 归属项目（`Project.id`）。必填：老卡片的事件里没有这个字段，投影成 `"local"`（合成项目）。
   * `repoPath` 由它解析，客户端不再自己填。
   */
  projectId: string;
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
  /** 远端评论（同步进来的，只读）；恒存在，空数组也要能渲染。 */
  remoteComments: RemoteComment[];
  /** 代码评审（本地事实：行级注释 + 判定）。恒存在，空也要能渲染。 */
  review: Review;
  partOf?: string;
  spawned: string[];
  acceptedAt?: string;
  cleanedAt?: string;
  blockedReason?: string;
  /** 软删除：删除时间与原因。看板默认不显示已删除的卡（`?includeDeleted=1` 可见并可恢复）。 */
  deletedAt?: string;
  deletedReason?: string;
  createdAt: string;
  /**
   * 这张卡片**已经应用过的事件条数**（每折一条事件 +1，`emptyCard` 从 0 起）。
   *
   * 单调递增，所以它就是「卡片版本」：意图类命令的幂等键拿它当后缀
   * （规则见 `server/engine.ts` 头部），于是
   * - 同一次请求重试（版本没变）→ 键相同 → 被存储层去重；
   * - 版本变了之后的**同内容**操作（第二次 unblock、删除→恢复→再删除…）→ 新键 → 不会被吞。
   * 重复语义仍由引擎自己的状态守卫负责（setter「值没变就跳过」、unblock 查 state…）。
   *
   * 它由事件重放推出来，所以 `rebuild` 之后的值必然与增量投影一致。
   */
  eventCount: number;
  updatedAt: string;
};

export type EventType =
  | "card.opened"
  | "card.state.changed"
  | "card.comment.added"
  | "review.comment.added"
  | "review.verdict.recorded"
  | "card.spawned"
  | "card.accepted"
  | "card.blocked"
  | "card.deleted"
  | "card.restored"
  | "issue.bound"
  | "issue.state.changed"
  | "remote.comment.added"
  | "remote.comments.read"
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
  | "session.deleted"
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

/**
 * 托管会话的 HTTP 入参（`server/hosted-session.ts` 实现）：
 * `start` 可显式给 cwd（不给就取卡片 worktree，再退项目根）；
 * `prompt` 至少要有 text 或 images 之一（空消息没意义，服务端会拒）。
 */
export const sessionStartSchema = z.object({
  cwd: z.string().min(1).optional(),
});

/**
 * `POST /api/cards/:id/session/cwd`：把这张卡的托管会话搬到新的工作目录
 * （停掉当前进程 → 用 `-r` 续接同一条 omp 会话 → 重新 claim）。见 `server/hosted-session.ts` 的 `changeCwd`。
 */
export const sessionCwdSchema = z.object({
  path: z.string().min(1),
});

export const sessionPromptSchema = z.object({
  text: z.string(),
  images: z
    .array(z.object({ name: z.string().min(1), dataBase64: z.string().min(1) }))
    .optional(),
});

/**
 * Issue 输入：**编号是唯一必填的**，`repo`/`url` 缺省时由卡片所属项目的 Issue 基址补齐
 * （见 `server/engine.ts` 的 `resolveIssueRef`）。HTTP 客户端仍可像以前那样三样都给。
 */
export const issueInSchema = z.object({
  number: z.number().int().positive(),
  repo: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
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

/**
 * 同步事实的结构（`server/sync.ts` 的 `SyncFact` 的镜像）：只描述形状，不含任何凭据/传输细节。
 * 放在共享层是因为它是**跨边界契约**（HTTP body → 引擎），`server/syncer.ts` 用编译期断言锁住两边一致。
 */
export const syncFactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue.state"),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed"]),
    title: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    kind: z.literal("pr.state"),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed", "merged"]),
    /** `null` = 传输拿不到 merged 位（tea CLI 兜底），不瞎填。 */
    merged: z.boolean().nullable(),
    head: z.string(),
    base: z.string(),
    url: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    kind: z.literal("remote.comment"),
    id: z.number().int().positive(),
    issueNumber: z.number().int().positive(),
    author: z.string(),
    body: z.string(),
    at: z.string(),
    url: z.string(),
  }),
]);

export type SyncFactIn = z.infer<typeof syncFactSchema>;

/** CLI / HTTP 的命令体：一条命令 = 一次写入意图。 */
export const commandSchema = z.discriminatedUnion("cmd", [
  z.object({
    cmd: z.literal("open"),
    actor: actorSchema,
    /**
     * 标题**可选**：给空串或干脆不给，由服务端从正文派生（见 `server/engine.ts` 的 `deriveTitle`）。
     * 派生结果写进事件，所以标题历史稳定，不随规则重算而变。
     */
    title: z.string().optional(),
    body: z.string().default(""),
    /** 归属项目；缺省 `local`。`repoPath` 不再由客户端填 —— 由项目解析出来落进卡片。 */
    projectId: z.string().min(1).optional(),
    issue: issueInSchema.optional(),
    partOf: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("bindIssue"),
    actor: actorSchema,
    card: z.string().min(1),
    /** 只给编号就行：`repo`/`url` 缺省时用卡片所属项目的 Issue 基址补齐。 */
    number: z.number().int().positive(),
    repo: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    title: z.string().optional(),
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
    /**
     * 删掉这张卡的会话事实（**不动** omp 磁盘上的会话文件）：`session` 投影成 `null`，
     * 下次「启动会话」不再 `-r` 续接，是一段全新的对话。转录由服务端另外清（不进事件流）。
     * 服务端内部命令（`POST /api/cards/:id/session/delete`），见 `server/hosted-session.ts`。
     */
    cmd: z.literal("deleteSession"),
    actor: actorSchema,
    card: z.string().min(1),
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
    cmd: z.literal("delete"),
    actor: actorSchema,
    card: z.string().min(1),
    reason: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("restore"),
    actor: actorSchema,
    card: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("drop"),
    actor: actorSchema,
    card: z.string().min(1),
    reason: z.string().min(1),
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
  /**
   * 代码评审：**本地事实，不是远程写**。评论只落进事件流（不回写 Gitea），
   * 所以不走 G2 确认；判定同理，不改流程状态（G3 验收仍由人点 `accept`）。
   *
   * `sha` 是评论的锚点（写评论时的 head）—— CLI 不给 `--sha` 时按卡片 worktree 的 HEAD 解析。
   */
  z.object({
    cmd: z.literal("reviewComment"),
    actor: actorSchema,
    card: z.string().min(1),
    sha: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive(),
    side: z.enum(REVIEW_SIDES).default("new"),
    body: z.string().min(1),
    dedupeKey: z.string().optional(),
  }),
  z.object({
    cmd: z.literal("reviewVerdict"),
    actor: actorSchema,
    card: z.string().min(1),
    verdict: z.enum(REVIEW_VERDICTS),
    body: z.string().optional(),
    dedupeKey: z.string().optional(),
  }),
  /**
   * 同步事实：**服务端同步器唯一的写入口**（引擎把它翻成事件，幂等键就是 `factKey(fact)`）。
   * 形状与 `server/sync.ts` 的 `SyncFact` 一致（那里有编译期断言锁住）；`card` 由同步器按编号解析好。
   */
  z.object({
    cmd: z.literal("applySync"),
    actor: actorSchema,
    card: z.string().min(1),
    facts: z.array(syncFactSchema).min(1),
  }),
  /**
   * 远端评论标记已读：人打开卡片详情时前端调它。`ids` 不给 = 当前所有未读。
   * 已经全读过时**不产生事件**（幂等：连着调两次只有第一次有效）。
   */
  z.object({
    cmd: z.literal("markRemoteCommentsRead"),
    actor: actorSchema,
    card: z.string().min(1),
    ids: z.array(z.number().int().positive()).optional(),
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

/**
 * POST /api/projects 的 body：登记一个仓库当项目。
 * 路径可以是仓库内的任意子目录 —— `git rev-parse --show-toplevel` 自己找到根。
 * `issueRepo` / `issueUrlTemplate` **不传就按 remote 派生**（`deriveIssueBase`），传了就覆盖。
 */
export const projectInSchema = z.object({
  path: z.string().trim().min(1, "path 不能为空"),
  issueRepo: z.string().trim().min(1).optional(),
  issueUrlTemplate: z.string().trim().min(1).optional(),
});

/**
 * POST /api/projects/:id/issue-base 的 body：改一个项目的 Issue 基址。
 * `clear: true` 清掉两条（此时忽略给出的值）；不然只更新传了的那些，没传的保持不动。
 */
export const issueBaseInSchema = z.object({
  issueRepo: z.string().trim().min(1).optional(),
  issueUrlTemplate: z.string().trim().min(1).optional(),
  clear: z.boolean().optional(),
});

/**
 * POST /api/projects/:id/sync 的 body：三个都可选，全不给 = 一轮常规同步
 * （精确读已绑编号 + 每仓库一次评论增量）。`since` 必须是能解析的时间。
 */
export const syncRequestSchema = z.object({
  since: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Number.isFinite(Date.parse(value)), "since 要是能解析的时间（ISO 8601）")
    .optional(),
  /** `true` = 手动全量列表模式（`sync.ts` 的 `pollRemote`）。 */
  list: z.boolean().optional(),
  /** `true` = 只算事实不落库。 */
  dryRun: z.boolean().optional(),
});

// ---------------------------------------------------------------- 只读视图：提交图 / diff

/** 统一的读接口错误体（`ok: false` 那一支）。 */
export type ApiError = { code: string; message: string; hint?: string };

/** 提交图里的一条提交。`refs` 由 decorate 解析出来（`HEAD -> main` 只留 `main`）。 */
export type GraphCommit = {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  at: string;
  subject: string;
  refs: string[];
};

export type GraphBranch = { name: string; head: string; upstream?: string };

/** `git worktree list --porcelain` 的一条；卡片映射按 worktree.path 优先、分支名兜底。 */
export type GraphWorktree = {
  path: string;
  /** detached HEAD → null（没有分支可清理） */
  branch: string | null;
  head: string;
  detached: boolean;
  cardId?: string;
  cardTitle?: string;
  cardState?: string;
};

/** 「有 worktree 的卡片」的反查表：给看板把卡片叠到提交图/泳道上。 */
export type GraphCardRef = {
  id: string;
  title: string;
  state: string;
  branch: string;
  worktreePath: string;
};

/**
 * `GET /api/projects/:id/graph` 的成功体。`graphText` 是
 * `git log --graph --oneline --decorate --all -n <limit>` 的**原样输出**（只去掉结尾换行）：
 * 泳道交给 git 自己画，我们不重画。
 */
export type ProjectGraph = {
  ok: true;
  repoPath: string;
  limit: number;
  graphText: string;
  commits: GraphCommit[];
  branches: GraphBranch[];
  worktrees: GraphWorktree[];
  cards: GraphCardRef[];
};

export type ProjectGraphResult = ProjectGraph | { ok: false; error: ApiError };

export const DIFF_STATUSES = ["added", "modified", "deleted", "renamed", "binary"] as const;
export type DiffStatus = (typeof DIFF_STATUSES)[number];

export type DiffLine = {
  kind: "context" | "add" | "del";
  /** 旧文件里的行号（`add` 没有） */
  oldLine?: number;
  /** 新文件里的行号（`del` 没有） */
  newLine?: number;
  text: string;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
};

export type DiffFile = {
  path: string;
  /** 只在 renamed/copy 时有值 */
  oldPath?: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

/**
 * 卡片 diff（只读）：`git diff <baseSha>...<headSha>`（三点 = merge-base 语义），
 * 在仓库根跑。base = 项目 defaultBranch（拿不到退 main/master），head = 卡片 worktree 的 HEAD。
 */
export type CardDiff = {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  /** 超过阈值（默认 1 MiB）被截断：只保留完整的文件，其余丢掉 */
  truncated?: boolean;
  truncatedReason?: string;
  /** 只有 `?patch=1` 时才有：git 的原始 unified diff（同样受截断阈值约束） */
  patch?: string;
};

export type CardDiffResult = (CardDiff & { ok: true }) | { ok: false; error: ApiError };

/** `flowcard diff` 默认打的摘要：文件级 + hunk 头，**不含行体**。 */
export type DiffHunkSummary = Omit<DiffHunk, "lines">;
/** 摘要里的文件项：**只有文件级信息**（不带 hunks——只有行数的空壳没有用）。 */
export type DiffFileSummary = Omit<DiffFile, "hunks">;
export type DiffSummary = {
  ok: true;
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  files: DiffFileSummary[];
  truncated?: boolean;
  truncatedReason?: string;
};
