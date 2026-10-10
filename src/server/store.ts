/**
 * 存储：事件是真相，cards 表是可重建的投影。
 * 每次写入后按"该卡片的事件全量重放"重建投影，保证投影 == 事件流的折叠结果。
 */
import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Flow } from "../shared/flow.ts";
import { isInside, normalizePath } from "../shared/paths.ts";
import {
  LOCAL_PROJECT_ID,
  type Actor,
  type Attachment,
  type Card,
  type Command,
  type CwdClaimResolution,
  type Event,
  type Project,
} from "../shared/types.ts";
import {
  attachmentsDir,
  readAttachmentBytes,
  saveAttachment,
  type AttachmentRejection,
} from "./attachments.ts";
import { runCommand, type CommandOutcome } from "./engine.ts";
import { applyEvent, emptyCard, type NewEvent } from "./project.ts";
import { localProject, projectIdFor } from "./projects.ts";
import type { Degradation, SyncPrev } from "./sync.ts";

export type ExecuteResult = {
  outcome: CommandOutcome;
  inserted: Event[];
  duplicates: number;
  card: Card | undefined;
};

/** 登记项目的结果：同 path 重复登记不算新建（`created:false`），且保留最初的 addedAt。 */
export type UpsertProjectResult = { project: Project; created: boolean };

/** 存附件的结果：校验失败给 `error`（HTTP 层照着回 415/413），成功时 `created` 说明是不是新内容。 */
export type AppendAttachmentResult =
  | { ok: true; attachment: Attachment; created: boolean }
  | { ok: false; error: AttachmentRejection };

/** 解析失败时给出的 message / hint 各自的上限（要能一眼读完，又要带参照物）。 */
const CLAIM_HINT_BUDGET = 200;

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * `claim` 没给 card 时的回退解析：会话 cwd 落在哪张卡片的 worktree 里。
 *
 * - 命中多张 → 取 `worktree.path` 最长的（最具体的 worktree 赢）；
 * - 零命中，或并列最长（拿不到唯一解）→ 返回 `error`，message/hint 里带上现有卡片当参照物。
 *
 * 纯函数（只读传进来的卡片数组），所以引擎注入它就行，不用碰 IO。
 */
export function resolveClaimCardByCwd(cwd: string, cards: Card[]): CwdClaimResolution {
  const cands = cards.flatMap((c) =>
    // 软删除的卡片不再是认领目标：删掉的老卡（worktree 还在历史里）不该抢走新卡片的位置，
    // 否则「建错了 → 删除 → 重建同 worktree」之后按 cwd 认领会撞上并列而永远解不出唯一解。
    c.worktree && !c.deletedAt
      ? [{ id: c.id, raw: c.worktree.path, path: normalizePath(c.worktree.path) }]
      : [],
  );
  // 参照物里的路径太长就只留尾巴：hint 是给人定位用的，不是让人读全路径。
  const listed = cands
    .map((c) => `${c.id}(${c.raw.length <= 40 ? c.raw : `…${c.raw.slice(-36)}`})`)
    .join("、");
  const hits = cands.filter((c) => isInside(cwd, c.path));

  if (hits.length === 0) {
    return {
      error: {
        message: clip(`cwd ${cwd} 没有对应任何卡片的 worktree`, CLAIM_HINT_BUDGET),
        hint: clip(
          cands.length === 0
            ? "这个实例还没有带 worktree 的卡片：先 flowcard open 建卡并绑 worktree，再在 worktree 里启动会话"
            : `可用卡片：${listed}。在对应 worktree 里启动会话才会自动绑卡；也可用 FLOWCARD_CARD=cN 显式指定`,
          CLAIM_HINT_BUDGET,
        ),
      },
    };
  }

  hits.sort((a, b) => b.path.length - a.path.length);
  const most = hits.filter((h) => h.path === hits[0]!.path);
  if (most.length > 1) {
    return {
      error: {
        message: clip(
          `cwd ${cwd} 同时落在 ${most.length} 张卡片的同一个 worktree 里：${most.map((h) => h.id).join("、")}`,
          CLAIM_HINT_BUDGET,
        ),
        hint: "这些卡片的 worktree.path 完全相同，无法自动选；用 FLOWCARD_CARD=cN 显式指定",
      },
    };
  }

  return { cardId: hits[0]!.id };
}

/**
 * 投影格式版本：**改动 `Card` 的形态（增删槽位）时把它 +1**。
 * 启动时版本不一致就自动 rebuild 一次——投影本来就能从事件重放，这样老库不用手工救，
 * 也不会让"投影比代码旧"悄悄毁掉前端解析。
 *
 * v3：卡片新增 `projectId`（老事件没有 → 投影成 `local`），所以必须重放一遍。
 * v4：卡片新增 `review` 槽位（行级评审注释 + 判定），老投影里没有 → 重放补上。
 * v5：状态从 9 个缩到 7 个（删 `inbox` / `issue` 两层中转）→ 老事件里的这两个状态投影成 `ready`，
 *     建卡直接落 `ready`，所以形态变了、必须重放。
 * v6：卡片新增 `remoteComments`（同步进来的远端评论），老投影里没有 → 重放补上空数组。
 * v8：卡片新增 `eventCount`（已应用的事件条数）——意图类命令的幂等键用它当卡片版本，
 *     老投影里没有这个字段 → 必须重放一遍才能继续拿它当幂等键。
 */
export const PROJECTION_VERSION = "8";

/**
 * 一个项目上一轮同步的结果（按项目存在 `meta` 表里，**不进事件流**）：
 * 它是「我们什么时候看过远程」的记录，不是业务事实，重建投影不需要它。
 * `prev` 只用来省掉无谓的引擎调用；丢了也能跑（`dedupeKey` 兜底幂等）。
 */
export type ProjectSyncState = {
  /** 上一次同步完成时刻（UTC ISO）；`since` 游标 = 它 - 60 s。 */
  at: string;
  /** 上一轮的端点降级（空 = 三个端点都完整）。 */
  degraded: Degradation[];
  notes: string[];
  counts: { issues: number; pulls: number; comments: number };
  prev?: SyncPrev;
  /** 上一轮整体没跑成的原因（没凭据等）；成功一轮后清掉。 */
  lastError?: string;
};

/**
 * 托管会话里的一次工具调用（转录里 `role: "tool"` 的那一行）。
 * `status` 跟着 omp 的 `tool_execution_start/update/end` 走；`output` 是从结果里抠出来的可读文本。
 */
export type SessionToolEvent = {
  callId: string;
  name: string;
  status: "start" | "update" | "end";
  args?: unknown;
  output?: string;
  isError?: boolean;
};

export type SessionMessageInput = {
  cardId: string;
  messageId: string;
  /** `thinking` = 模型的思考块（一条消息一个，见 `hosted-session.ts` 的归并规则）。 */
  role: "user" | "assistant" | "tool" | "thinking";
  at: string;
  text?: string;
  tool?: SessionToolEvent;
};

/** 落库的转录行（`seq` 是卡片内自增序号，用来定顺序）。 */
export type SessionMessageRow = SessionMessageInput & { seq: number };

export type Store = {
  /** 执行一条命令；被拒时什么也不写。 */
  execute(cmd: Command, now?: string): ExecuteResult;
  getCard(id: string): Card | undefined;
  listCards(): Card[];
  listEvents(limit?: number): Event[];
  /**
   * 某张卡片最近的 N 条某前缀事件（按 seq 升序返回）。
   * `runtime.*` 用它：**全局滑窗会随心跳滑走**（最新 1000 条只覆盖约 8 小时），
   * 一旦卡片的 runtime 事件滑出去，停止按钮就找不到进程身份了。
   */
  listEventsOfCard(cardId: string, typePrefix: string, limit?: number): Event[];
  /** 从零重放全部事件重建投影，返回卡片数。 */
  rebuild(): number;
  /** 全部项目（含合成项目 local，恒在；真实项目按登记时间排）。 */
  listProjects(): Project[];
  getProject(id: string): Project | undefined;
  /** 登记 / 刷新一个项目（按 path 幂等，保留最初的 addedAt）。 */
  upsertProject(project: Project, now?: string): UpsertProjectResult;
  /** 按绝对路径解析所属项目（最具体命中）；不在任何项目内（或只有合成项目）返回 undefined。 */
  projectForPath(path: string): Project | undefined;
  /** 上一轮同步的结果（没同步过返回 undefined）。 */
  getSyncState(projectId: string): ProjectSyncState | undefined;
  /** 记住这一轮同步（`lastSyncAt` / 上轮摘要 / 降级）。 */
  setSyncState(projectId: string, state: ProjectSyncState): void;
  /** 存一张图片附件（内容寻址，幂等）；校验不过返回 error。 */
  appendAttachment(input: { name: string; mime: string | undefined; bytes: Uint8Array }, now?: string): AppendAttachmentResult;
  getAttachment(id: string): { attachment: Attachment; bytes: Uint8Array } | undefined;
  /**
   * 追加/更新一条托管会话的转录行：同 `messageId` 复写（工具调用会随 start/update/end 刷三遍），
   * 新行按卡片内 `seq` 递增。返回这一行的 `seq`。
   *
   * **不进事件流**（取舍见 `docs/design.md` §14）：转录是"会话说了什么"，不是流程事实；
   * 每个文本增量都写事件会把事件日志淹掉，而重放投影并不需要它。
   */
  appendSessionMessage(input: SessionMessageInput): { seq: number };
  /** 某张卡片的转录（按 `seq` 升序；默认最近 500 条，上限 2000）。 */
  listSessionMessages(cardId: string, limit?: number): SessionMessageRow[];
  close(): void;
};

type EventRow = {
  seq: number;
  id: string;
  at: string;
  actor: string;
  card_id: string;
  type: string;
  payload: string;
  dedupe_key: string;
};

type AttachmentRow = {
  id: string;
  mime: string;
  ext: string;
  name: string;
  bytes: number;
  at: string;
};

const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  mime: row.mime as Attachment["mime"],
  ext: row.ext,
  name: row.name,
  bytes: row.bytes,
  at: row.at,
});

type SessionMessageDbRow = {
  card_id: string;
  seq: number;
  message_id: string;
  role: string;
  at: string;
  text: string | null;
  tool_json: string | null;
};

/** 每张卡片最多留这么多条转录（工具输出很占地方）；再老的真删掉，别让它无限长。 */
export const SESSION_TRANSCRIPT_MAX = 2_000;

const toSessionMessage = (row: SessionMessageDbRow): SessionMessageRow => {
  let tool: SessionToolEvent | undefined;
  if (row.tool_json !== null) {
    try {
      tool = JSON.parse(row.tool_json) as SessionToolEvent;
    } catch {
      tool = undefined; // 写坏的 JSON 不该让整段转录读不出来
    }
  }
  return {
    cardId: row.card_id,
    seq: row.seq,
    messageId: row.message_id,
    role: row.role === "user" || row.role === "tool" || row.role === "thinking" ? row.role : "assistant",
    at: row.at,
    ...(row.text === null ? {} : { text: row.text }),
    ...(tool === undefined ? {} : { tool }),
  };
};

export function createStore(opts: { dataDir: string; flow: Flow }): Store {
  // 数据目录里有卡片正文、远端评论正文、附件：只给自己读写（不依赖 umask）
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const dbPath = `${opts.dataDir}/flowcard.sqlite`;
  const db = new DatabaseSync(dbPath);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // -wal/-shm 可能还没建：下一轮再说，不该因此起不来
    }
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      id         TEXT NOT NULL UNIQUE,
      at         TEXT NOT NULL,
      actor      TEXT NOT NULL,
      card_id    TEXT NOT NULL,
      type       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS events_card ON events(card_id, seq);
    CREATE TABLE IF NOT EXISTS cards (
      id         TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      card       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- 项目是**环境元数据**（仓库路径/分支/远程），不是业务流程，所以单独一张表、不进事件流：
    -- 建卡时刷一次 git 元数据代表"现在长这样"，没有谁在什么时候做了什么要重放。
    -- 卡片归属（Card.projectId）仍然走事件，因为那是业务事实。
    CREATE TABLE IF NOT EXISTS projects (
      id      TEXT PRIMARY KEY,
      path    TEXT NOT NULL,
      project TEXT NOT NULL,
      at      TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS projects_path ON projects(path);
    -- 附件元数据：字节在 <dataDir>/attachments/<id>.<ext>，路径由 id+ext 推出，所以这里不存路径。
    CREATE TABLE IF NOT EXISTS attachments (
      id    TEXT PRIMARY KEY,
      mime  TEXT NOT NULL,
      ext   TEXT NOT NULL,
      name  TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      at    TEXT NOT NULL
    );
    -- 托管会话的转录（每卡一条 omp RPC 会话的对话与工具输出）。
    -- **不进事件流**：转录是「会话说了什么」，不是流程事实（流程只认 claim/beat/end）；
    -- 每个文本增量都写事件会把事件日志淹掉，而重放投影并不需要它。取舍见 docs/design.md §14。
    -- 主键是 (card_id, message_id)：工具调用会随 start/update/end 复写同一行。
    CREATE TABLE IF NOT EXISTS session_messages (
      card_id    TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      at         TEXT NOT NULL,
      text       TEXT,
      tool_json  TEXT,
      PRIMARY KEY (card_id, message_id)
    );
  `);

  const toEvent = (row: EventRow): Event => ({
    id: row.id,
    seq: row.seq,
    at: row.at,
    actor: JSON.parse(row.actor) as Actor,
    cardId: row.card_id,
    type: row.type as Event["type"],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    dedupeKey: row.dedupe_key,
  });

  const cardEvents = (cardId: string): Event[] =>
    (db.prepare("SELECT * FROM events WHERE card_id = ? ORDER BY seq").all(cardId) as EventRow[]).map(
      toEvent,
    );

  const project = (cardId: string): Card => {
    const events = cardEvents(cardId);
    const seedAt = events[0]?.at ?? new Date().toISOString();
    return events.reduce<Card>((acc, ev) => applyEvent(acc, ev), emptyCard(cardId, seedAt));
  };

  const putCard = (card: Card): void => {
    db.prepare(
      "INSERT INTO cards (id, state, card, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET state = excluded.state, card = excluded.card, updated_at = excluded.updated_at",
    ).run(card.id, card.state, JSON.stringify(card), card.updatedAt);
  };

  const insertEvents = (events: NewEvent[]): { inserted: Event[]; duplicates: number } => {
    const stmt = db.prepare(
      "INSERT INTO events (id, at, actor, card_id, type, payload, dedupe_key) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING",
    );
    const inserted: Event[] = [];
    let duplicates = 0;
    for (const ev of events) {
      const id = randomUUID();
      const res = stmt.run(
        id,
        ev.at,
        JSON.stringify(ev.actor),
        ev.cardId,
        ev.type,
        JSON.stringify(ev.payload),
        ev.dedupeKey,
      );
      if (res.changes === 0) {
        duplicates++;
        continue;
      }
      inserted.push({ ...ev, id, seq: Number(res.lastInsertRowid) });
    }
    return { inserted, duplicates };
  };

  const metaGet = (key: string): string | undefined => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const metaSet = (key: string, value: string): void => {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  };

  const getCard = (id: string): Card | undefined => {
    const row = db.prepare("SELECT card FROM cards WHERE id = ?").get(id) as
      | { card: string }
      | undefined;
    return row ? (JSON.parse(row.card) as Card) : undefined;
  };

  const listCards = (): Card[] => {
    const rows = db
      .prepare("SELECT card FROM cards ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)")
      .all() as { card: string }[];
    return rows.map((r) => JSON.parse(r.card) as Card);
  };

  // ---------------------------------------------------------------- 项目（环境元数据）

  const getProject = (id: string): Project | undefined => {
    const row = db.prepare("SELECT project FROM projects WHERE id = ?").get(id) as
      | { project: string }
      | undefined;
    return row ? (JSON.parse(row.project) as Project) : undefined;
  };

  /** 真实项目在前（按登记时间），合成项目 local 放最后——它是"桶"，不是仓库。 */
  const listProjects = (): Project[] => {
    const all = (db.prepare("SELECT project FROM projects").all() as { project: string }[]).map(
      (r) => JSON.parse(r.project) as Project,
    );
    const rank = (p: Project): number => (p.virtual === true ? 1 : 0);
    return all.sort(
      (a, b) => rank(a) - rank(b) || a.addedAt.localeCompare(b.addedAt) || a.id.localeCompare(b.id),
    );
  };

  /**
   * id 由路径派生，理论上同 basename 的两个仓库会撞（4 位哈希）。撞了就退到 8 位，再撞加序号：
   * **id 一旦分配就不再变**（卡片归属靠它），所以宁可长一点也不换。
   */
  const allocateProjectId = (want: string, path: string): string => {
    const owner = (id: string): string | undefined =>
      (db.prepare("SELECT path FROM projects WHERE id = ?").get(id) as { path: string } | undefined)
        ?.path;
    if (owner(want) === undefined) return want;
    const wide = projectIdFor(path, 8);
    if (owner(wide) === undefined) return wide;
    for (let n = 2; n <= 50; n++) {
      const candidate = `${wide}-${n}`;
      if (owner(candidate) === undefined) return candidate;
    }
    throw new Error(`项目 id 分配失败（同名同哈希太多）：${path}`);
  };

  const upsertProject = (incoming: Project, now = new Date().toISOString()): UpsertProjectResult => {
    const existing = db.prepare("SELECT project FROM projects WHERE path = ?").get(incoming.path) as
      | { project: string }
      | undefined;
    if (existing) {
      // 同 path 幂等：元数据刷新（分支/远程/脏文件随时会变），但 id 与加入时间不动。
      const prev = JSON.parse(existing.project) as Project;
      const merged: Project = { ...incoming, id: prev.id, addedAt: prev.addedAt, lastSeenAt: now };
      db.prepare("UPDATE projects SET project = ?, at = ? WHERE path = ?").run(
        JSON.stringify(merged),
        merged.lastSeenAt,
        incoming.path,
      );
      return { project: merged, created: false };
    }
    const project: Project = { ...incoming, id: allocateProjectId(incoming.id, incoming.path) };
    db.prepare("INSERT INTO projects (id, path, project, at) VALUES (?, ?, ?, ?)").run(
      project.id,
      project.path,
      JSON.stringify(project),
      project.lastSeenAt,
    );
    return { project, created: true };
  };

  /**
   * 路径 → 项目：命中的里面取路径最长的（嵌套仓库时最具体的赢），与 `claim` 按 cwd 认卡同规则。
   * 合成项目（path 为空）不参与。
   */
  const projectForPath = (path: string): Project | undefined => {
    const normalized = normalizePath(path);
    const hits = listProjects().filter((p) => !p.virtual && p.path !== "" && isInside(normalized, p.path));
    hits.sort((a, b) => b.path.length - a.path.length);
    return hits[0];
  };

  // ---------------------------------------------------------------- 同步状态（按项目，不进事件流）

  const getSyncState = (projectId: string): ProjectSyncState | undefined => {
    const raw = metaGet(`sync:${projectId}`);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as ProjectSyncState;
      // 手工改坏/旧版本写坏的值不该把同步整个搞停：形状不对就当没同步过。
      return typeof parsed?.at === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const setSyncState = (projectId: string, state: ProjectSyncState): void => {
    metaSet(`sync:${projectId}`, JSON.stringify(state));
  };

  // ---------------------------------------------------------------- 附件（图片）

  const attachmentsRoot = attachmentsDir(opts.dataDir);

  const appendAttachment = (
    input: { name: string; mime: string | undefined; bytes: Uint8Array },
    now = new Date().toISOString(),
  ): AppendAttachmentResult => {
    const saved = saveAttachment(attachmentsRoot, input, now);
    if (!saved.ok) return saved;
    const existing = db.prepare("SELECT * FROM attachments WHERE id = ?").get(saved.attachment.id) as
      | AttachmentRow
      | undefined;
    // 内容一样就是同一张图：元数据保留第一次的记录（id 内容寻址，天然幂等）。
    if (existing) return { ok: true, attachment: toAttachment(existing), created: false };
    db.prepare("INSERT INTO attachments (id, mime, ext, name, bytes, at) VALUES (?, ?, ?, ?, ?, ?)").run(
      saved.attachment.id,
      saved.attachment.mime,
      saved.attachment.ext,
      saved.attachment.name,
      saved.attachment.bytes,
      saved.attachment.at,
    );
    return { ok: true, attachment: saved.attachment, created: true };
  };

  const getAttachment = (id: string): { attachment: Attachment; bytes: Uint8Array } | undefined => {
    const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
      | AttachmentRow
      | undefined;
    if (!row) return undefined;
    const attachment = toAttachment(row);
    const bytes = readAttachmentBytes(attachmentsRoot, attachment);
    return bytes ? { attachment, bytes } : undefined;
  };

  // ---------------------------------------------------------------- 托管会话的转录（不进事件流）

  const appendSessionMessage = (input: SessionMessageInput): { seq: number } => {
    const toolJson = input.tool === undefined ? null : JSON.stringify(input.tool);
    const existing = db
      .prepare("SELECT seq FROM session_messages WHERE card_id = ? AND message_id = ?")
      .get(input.cardId, input.messageId) as { seq: number } | undefined;
    if (existing) {
      // 同一条消息的后续刷新（工具调用 start→update→end、助手文本 text_end→message_end）就地改。
      db.prepare(
        "UPDATE session_messages SET role = ?, at = ?, text = ?, tool_json = ? WHERE card_id = ? AND message_id = ?",
      ).run(input.role, input.at, input.text ?? null, toolJson, input.cardId, input.messageId);
      return { seq: existing.seq };
    }
    const head = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM session_messages WHERE card_id = ?")
      .get(input.cardId) as { m: number };
    const seq = head.m + 1;
    db.prepare(
      "INSERT INTO session_messages (card_id, seq, message_id, role, at, text, tool_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(input.cardId, seq, input.messageId, input.role, input.at, input.text ?? null, toolJson);
    db.prepare("DELETE FROM session_messages WHERE card_id = ? AND seq <= ?").run(
      input.cardId,
      seq - SESSION_TRANSCRIPT_MAX,
    );
    return { seq };
  };

  const listSessionMessages = (cardId: string, limit = 500): SessionMessageRow[] => {
    const cap = Math.min(Math.max(Math.floor(limit), 1), SESSION_TRANSCRIPT_MAX);
    const rows = db
      .prepare("SELECT * FROM session_messages WHERE card_id = ? ORDER BY seq DESC LIMIT ?")
      .all(cardId, cap) as SessionMessageDbRow[];
    return rows.map(toSessionMessage).reverse();
  };

  const execute = (cmd: Command, now = new Date().toISOString()): ExecuteResult => {
    /**
     * 卡号只在**这一轮 execute 里**预付（`peeked`），真正落库推迟到事务内。
     * 被拒的命令（项目不存在 / Issue 补不齐）与全被幂等吞掉的重复 open 都不会烧号，
     * 所以卡号不会出现 c1、c3 这样的空洞；崩溃/回滚时预付也跟着作废（同一个闭包变量）。
     */
    let peeked = 0;
    const outcome = runCommand({
      flow: opts.flow,
      getCard,
      getProject,
      cmd,
      now,
      newCardId: () => {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'next_card'").get() as
          | { value: string }
          | undefined;
        peeked = (peeked > 0 ? peeked : row ? Number(row.value) : 0) + 1;
        return `c${peeked}`;
      },
      resolveCardByCwd: (cwd) => resolveClaimCardByCwd(cwd, listCards()),
    });
    if (outcome.rejection) {
      return { outcome, inserted: [], duplicates: 0, card: undefined };
    }

    db.exec("BEGIN");
    let written: { inserted: Event[]; duplicates: number };
    try {
      written = insertEvents(outcome.events);
      // 只重投影**真的写进去了**的卡片：命令被幂等键吞掉时事件一条没写，
      // 若照样重投影就会给"新分配但没事件"的 id 落一张空壳卡（重复 open 会凭空多一张空卡）。
      const touched = new Set(written.inserted.map((e) => e.cardId));
      for (const cardId of touched) putCard(project(cardId));
      // 有事件落库才推进卡号计数器（分配过才动；重复 open 一条没写就原样留着这个号）。
      if (peeked > 0 && written.inserted.length > 0) {
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('next_card', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(String(peeked));
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    /**
     * 主卡：正常就是 `primaryCardId` 的投影。事件全被幂等吞掉时必须按第一条事件的 dedupeKey
     * 找回第一次写进去的那张卡 —— `open` 每次都先分配新 id，光看 `primaryCardId` 是找不到原卡的，
     * 而"重发同一条 open 要指向同一张卡"正是幂等该给人的东西。
     */
    const primaryCard = (): Card | undefined => {
      const direct = getCard(outcome.primaryCardId);
      if (direct) return direct;
      const key = outcome.events[0]?.dedupeKey;
      if (!key) return undefined;
      const row = db.prepare("SELECT card_id FROM events WHERE dedupe_key = ?").get(key) as
        | { card_id: string }
        | undefined;
      return row ? getCard(row.card_id) : undefined;
    };

    return {
      outcome,
      inserted: written.inserted,
      duplicates: written.duplicates,
      card: primaryCard(),
    };
  };

  const rebuild = (): number => {
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM cards");
      const ids = db.prepare("SELECT DISTINCT card_id FROM events").all() as { card_id: string }[];
      for (const { card_id } of ids) putCard(project(card_id));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return listCards().length;
  };

  // 合成项目「未归属」恒存在（首次启动落一行，之后复用）。它拥有所有非项目卡，看板里也要能看到。
  if (!getProject(LOCAL_PROJECT_ID)) {
    const at = new Date().toISOString();
    const local = localProject(at);
    db.prepare("INSERT INTO projects (id, path, project, at) VALUES (?, ?, ?, ?)").run(
      local.id,
      local.path,
      JSON.stringify(local),
      at,
    );
  }

  // 投影版本不一致 → 从事件重放一次（自愈，不需要人手工 rebuild）
  if (metaGet("projection_version") !== PROJECTION_VERSION) {
    rebuild();
    metaSet("projection_version", PROJECTION_VERSION);
  }

  return {
    execute,
    getCard,
    listCards,
    listEventsOfCard(cardId: string, typePrefix: string, limit = 50) {
      const rows = db
        .prepare("SELECT * FROM events WHERE card_id = ? AND type LIKE ? ORDER BY seq DESC LIMIT ?")
        .all(cardId, `${typePrefix}%`, Math.min(Math.max(limit, 1), 500)) as EventRow[];
      return rows.map(toEvent).reverse();
    },

    listEvents(limit = 200) {
      const rows = db
        .prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?")
        .all(limit) as EventRow[];
      return rows.map(toEvent).reverse();
    },
    rebuild,
    listProjects,
    getProject,
    upsertProject,
    projectForPath,
    getSyncState,
    setSyncState,
    appendAttachment,
    getAttachment,
    appendSessionMessage,
    listSessionMessages,
    close() {
      db.close();
    },
  };
}
