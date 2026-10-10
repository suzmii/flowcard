/** HTTP 接口 + SSE：写入只走 /api/commands（命令），读取走投影。 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { commandSchema } from "../shared/types.ts";
import type { Store } from "./store.ts";

export function createApp(store: Store) {
  const app = new Hono();
  const subscribers = new Set<(event: string, data: unknown) => void>();

  const broadcast = (event: string, data: unknown): void => {
    for (const send of subscribers) send(event, data);
  };

  app.get("/api/health", (c) =>
    c.json({ ok: true, cards: store.listCards().length, events: store.listEvents(1).length }),
  );

  app.get("/api/cards", (c) => c.json({ cards: store.listCards() }));

  app.get("/api/cards/:id", (c) => {
    const card = store.getCard(c.req.param("id"));
    if (!card) return c.json({ error: { code: "NOT_FOUND", message: "卡片不存在" } }, 404);
    return c.json({ card });
  });

  app.get("/api/events", (c) => {
    const limit = Number(c.req.query("limit") ?? "200");
    return c.json({ events: store.listEvents(Number.isFinite(limit) ? limit : 200) });
  });

  app.post("/api/commands", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json(
        { ok: false, rejection: { code: "USAGE_ERROR", message }, notes: [] },
        400,
      );
    }

    const result = store.execute(parsed.data);
    broadcast("changed", {
      cardIds: [...new Set(result.outcome.events.map((e) => e.cardId))],
      types: result.outcome.events.map((e) => e.type),
    });

    const rejection = result.outcome.rejection;
    const status = rejection
      ? rejection.code === "NOT_FOUND"
        ? 404
        : rejection.code === "USAGE_ERROR"
          ? 400
          : 409
      : 200;

    return c.json(
      {
        ok: !rejection,
        card: result.card,
        inserted: result.inserted.length,
        duplicates: result.duplicates,
        notes: result.outcome.notes,
        ...(rejection ? { rejection } : {}),
        ...(result.outcome.blocked ? { blocked: result.outcome.blocked } : {}),
      },
      status,
    );
  });

  app.post("/api/rebuild", (c) => c.json({ ok: true, cards: store.rebuild() }));

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown): void => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(send);
      stream.onAbort(() => {
        subscribers.delete(send);
      });
      send("hello", { ok: true });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        send("ping", { at: new Date().toISOString() });
      }
    }),
  );

  return app;
}
