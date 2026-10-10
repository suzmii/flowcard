/**
 * 存储：事件是真相，cards 表是可重建的投影。
 * 每次写入后按"该卡片的事件全量重放"重建投影，保证投影 == 事件流的折叠结果。
 */
import { mkdirSync } from "node:fs";
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
    c.worktree ? [{ id: c.id, raw: c.worktree.path, path: normalizePath(c.worktree.path) }] : [],
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
 */
export const PROJECTION_VERSION = "7";

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

export type Store = {
  /** 执行一条命令；被拒时什么也不写。 */
  execute(cmd: Command, now?: string): ExecuteResult;
  getCard(id: string): Card | undefined;
  listCards(): Card[];
  listEvents(limit?: number): Event[];
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

export function createStore(opts: { dataDir: string; flow: Flow }): Store {
  mkdirSync(opts.dataDir, { recursive: true });
  const db = new DatabaseSync(`${opts.dataDir}/flowcard.sqlite`);
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

  const nextCardId = (): string => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'next_card'").get() as
      | { value: string }
      | undefined;
    const next = row ? Number(row.value) + 1 : 1;
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('next_card', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(next));
    return `c${next}`;
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

  const execute = (cmd: Command, now = new Date().toISOString()): ExecuteResult => {
    const outcome = runCommand({
      flow: opts.flow,
      getCard,
      getProject,
      cmd,
      now,
      newCardId: nextCardId,
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
    close() {
      db.close();
    },
  };
}
