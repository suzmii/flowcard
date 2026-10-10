/**
 * 看板数据源：一次全量拉取 + SSE 增量信号（收到任何 changed/runtime 就重拉一次，
 * 简单且不会和投影漂移）。断线自动重连，并有 ping 看门狗兜住「连接假活」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCards, parseChanged, streamUrl } from "@/lib/api";
import type { CardView, ChangedPayload } from "@/lib/schema";

export type Connection = "connecting" | "live" | "reconnecting";

export type BoardData = {
  cards: CardView[] | null;
  loading: boolean;
  error: string | null;
  connection: Connection;
  lastChanged: ChangedPayload | null;
  lastChangedAt: string | null;
  refresh: () => Promise<void>;
  runtimeEvents: number;
};

const PING_TIMEOUT_MS = 30_000;

export function useBoard(opts: { includeDeleted?: boolean } = {}): BoardData {
  const [cards, setCards] = useState<CardView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastChanged, setLastChanged] = useState<ChangedPayload | null>(null);
  const [lastChangedAt, setLastChangedAt] = useState<string | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetchCards(undefined, { includeDeleted: opts.includeDeleted === true });
      setCards(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // 拉不到就说明当前不是「已连接」，别让角标骗人；SSE 事件或下一次成功刷新会改回来。
      setConnection((prev) => (prev === "live" ? "reconnecting" : prev));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [opts.includeDeleted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let lastSeenAt = Date.now();
    let clearTimer: number | undefined;

    const markAlive = () => {
      lastSeenAt = Date.now();
      setConnection("live");
    };

    const connect = () => {
      if (closed) return;
      source?.close();
      const next = new EventSource(streamUrl());
      source = next;
      // 重连成功（hello）时补一次全量：断线期间的变化不能指望补发。
      next.addEventListener("hello", () => {
        markAlive();
        void refresh();
      });
      next.addEventListener("ping", markAlive);
      next.addEventListener("changed", (event) => {
        markAlive();
        const payload = parseChanged((event as MessageEvent<string>).data);
        if (payload) {
          setLastChanged(payload);
          setLastChangedAt(new Date().toISOString());
        }
        void refresh();
      });
      next.addEventListener("runtime", () => {
        markAlive();
        setRuntimeEvents((count) => count + 1);
        void refresh();
      });
      next.addEventListener("error", () => {
        // EventSource 自己会重连，这里只把状态亮出来；真断了由看门狗兜底。
        if (!closed) setConnection("reconnecting");
      });
    };

    connect();
    const watchdog = window.setInterval(() => {
      if (closed) return;
      if (Date.now() - lastSeenAt > PING_TIMEOUT_MS) {
        setConnection("reconnecting");
        clearTimer = window.setTimeout(connect, 500);
      }
    }, 10_000);

    return () => {
      closed = true;
      source?.close();
      window.clearInterval(watchdog);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [refresh]);

  return {
    cards,
    loading,
    error,
    connection,
    lastChanged,
    lastChangedAt,
    refresh,
    runtimeEvents,
  };
}
