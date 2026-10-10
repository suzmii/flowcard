/**
 * 看板数据源：一次全量拉取 + SSE 增量信号（收到任何 changed/runtime 就重拉一次，
 * 简单且不会和投影漂移）。断线自动重连，并有 ping 看门狗兜住「连接假活」。
 *
 * 两条不丢事实的规矩：
 * - 请求飞行中来的信号**不丢**，标记后等这次请求结束立刻补拉一次（多次信号合并成一次）；
 * - 没有事件时也有 30s 兜底节拍 —— 会话失联是服务端按读取时刻推导的，死掉的会话不会自己发事件。
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
/**
 * 兜底节拍：会话「失联」是**服务端按读取时刻推导**的，会话死掉后不会再有事件 ——
 * 只等 SSE 的话徽标会一直停在「在干活」。所以 30s 无条件重拉一次（顺带刷新相对时间）。
 */
const NOW_TICK_MS = 30_000;

export function useBoard(opts: { includeDeleted?: boolean } = {}): BoardData {
  const [cards, setCards] = useState<CardView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastChanged, setLastChanged] = useState<ChangedPayload | null>(null);
  const [lastChangedAt, setLastChangedAt] = useState<string | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState(0);
  const inFlight = useRef(false);
  /** 请求飞行中又来的刷新信号（SSE、兜底节拍）：别丢，标记一下等这次结束立刻补拉。 */
  const pendingRefresh = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      pendingRefresh.current = true;
      return;
    }
    inFlight.current = true;
    try {
      // 一次请求覆盖期间攒下的**全部**信号：连写两次（push + end）也不会被中间那次请求的顺序骗到。
      do {
        pendingRefresh.current = false;
        const next = await fetchCards(undefined, { includeDeleted: opts.includeDeleted === true });
        setCards(next);
        setError(null);
      } while (pendingRefresh.current);
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
    const timer = window.setInterval(() => {
      void refresh();
    }, NOW_TICK_MS);
    return () => window.clearInterval(timer);
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
