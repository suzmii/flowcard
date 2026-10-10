/**
 * 存储：事件是真相，cards 表是可重建的投影。
 * 每次写入后按"该卡片的事件全量重放"重建投影，保证投影 == 事件流的折叠结果。
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Flow } from "../shared/flow.ts";
import type { Actor, Card, Command, Event } from "../shared/types.ts";
import { runCommand, type CommandOutcome } from "./engine.ts";
import { applyEvent, emptyCard, type NewEvent } from "./project.ts";

export type ExecuteResult = {
  outcome: CommandOutcome;
  inserted: Event[];
  duplicates: number;
  card: Card | undefined;
};

export type Store = {
  /** 执行一条命令；被拒时什么也不写。 */
  execute(cmd: Command, now?: string): ExecuteResult;
  getCard(id: string): Card | undefined;
  listCards(): Card[];
  listEvents(limit?: number): Event[];
  /** 从零重放全部事件重建投影，返回卡片数。 */
  rebuild(): number;
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

  const execute = (cmd: Command, now = new Date().toISOString()): ExecuteResult => {
    const outcome = runCommand({
      flow: opts.flow,
      getCard,
      cmd,
      now,
      newCardId: nextCardId,
    });
    if (outcome.rejection) {
      return { outcome, inserted: [], duplicates: 0, card: undefined };
    }

    db.exec("BEGIN");
    let written: { inserted: Event[]; duplicates: number };
    try {
      written = insertEvents(outcome.events);
      const touched = new Set(outcome.events.map((e) => e.cardId));
      for (const cardId of touched) putCard(project(cardId));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      outcome,
      inserted: written.inserted,
      duplicates: written.duplicates,
      card: getCard(outcome.primaryCardId),
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
    close() {
      db.close();
    },
  };
}
