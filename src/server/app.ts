/** HTTP 接口 + SSE：写入只走 /api/commands（命令），读取走投影。 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { commandSchema, runtimeActionSchema } from "../shared/types.ts";
import type { RuntimeSupervisor } from "./runtime.ts";
import type { Store } from "./store.ts";

export type AppOptions = { runtime?: RuntimeSupervisor };

export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();
  const subscribers = new Set<(event: string, data: unknown) => void>();

  const broadcast = (event: string, data: unknown): void => {
    for (const send of subscribers) send(event, data);
  };

  // 运行时状态变化也是事件（runtime.*）→ 看板既收到细粒度的 "runtime"，也收到 "changed" 触发重取。
  opts.runtime?.subscribe((change) => {
    broadcast("runtime", { cardId: change.cardId, status: change.status });
    broadcast("changed", { cardIds: [change.cardId], types: change.types });
  });

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
        {
          ok: false,
          inserted: 0,
          duplicates: 0,
          rejection: { code: "USAGE_ERROR", message },
          notes: [],
        },
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

  /**
   * 启动按钮：up = 启动这张卡片 worktree 里的项目（会先停掉别的卡片在跑的运行时）；
   * down = 停掉它。进程由适配层管，状态照旧走事件流。
   */
  app.post("/api/cards/:id/runtime", async (c) => {
    const runtime = opts.runtime;
    if (!runtime) {
      return c.json(
        { ok: false, error: { code: "RUNTIME_DISABLED", message: "这个实例没有启用运行时监督器" } },
        503,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeActionSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ ok: false, rejection: { code: "USAGE_ERROR", message } }, 400);
    }

    const cardId = c.req.param("id");
    const result =
      parsed.data.action === "up" ? await runtime.up(cardId) : await runtime.down(cardId);
    return c.json(result, result.ok ? 200 : result.error?.code === "NOT_FOUND" ? 404 : 409);
  });

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
