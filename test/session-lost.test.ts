/**
 * 会话失联推导（纯函数）：投影里只有 running/ended，「失联」是**读取时刻**的判断。
 * 阈值 90s = 心跳 30s 分桶丢两拍；边界、终态、坏时间戳都要说清。
 */
import { describe, expect, it } from "vitest";
import { applyEvent, deriveSessionState, emptyCard, SESSION_LOST_AFTER_MS } from "../src/server/project.ts";
import type { Card, Session } from "../src/shared/types.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const HUMAN = { kind: "human" as const, name: "tester" };

const session = (over: Partial<Session> = {}): Session => ({
  harness: "omp",
  id: "s1",
  agentKind: "main",
  cwd: "/repo/.worktrees/c7",
  state: "running",
  startedAt: "2026-10-10T11:00:00.000Z",
  lastSeenAt: "2026-10-10T11:59:30.000Z",
  ...over,
});

/** 卡片只差一个会话：直接走投影（`session.started` 之后就是 running）。 */
function cardWithSession(over: Partial<Session> = {}): Card {
  const card = applyEvent(emptyCard("c7", "2026-10-10T11:00:00.000Z"), {
    at: "2026-10-10T11:00:00.000Z",
    actor: HUMAN,
    cardId: "c7",
    type: "session.started",
    payload: { session: session(over) },
    dedupeKey: "k",
  });
  return { ...card, session: { ...card.session!, ...over } };
}

describe("会话失联推导", () => {
  it("心跳还在阈值内 → running 原样返回（同一个对象，不白拷贝）", () => {
    const card = cardWithSession({ lastSeenAt: "2026-10-10T11:59:30.000Z" });
    expect(deriveSessionState(card, NOW)).toBe(card);
  });

  it("刚好 90s → 还不算失联；91s → 失联（阈值是「大于」）", () => {
    const boundary = cardWithSession({ lastSeenAt: new Date(NOW - SESSION_LOST_AFTER_MS).toISOString() });
    expect(deriveSessionState(boundary, NOW).session?.state).toBe("running");

    const late = cardWithSession({ lastSeenAt: new Date(NOW - SESSION_LOST_AFTER_MS - 1000).toISOString() });
    expect(deriveSessionState(late, NOW).session?.state).toBe("lost");
    // 只改推导出来的 state：lastSeenAt 是事实，一个字都不动
    expect(deriveSessionState(late, NOW).session?.lastSeenAt).toBe(late.session?.lastSeenAt);
  });

  it("idle 也会失联（空闲会话同样要报心跳）", () => {
    const idle = cardWithSession({ state: "idle", lastSeenAt: "2026-10-10T11:00:00.000Z" });
    expect(deriveSessionState(idle, NOW).session?.state).toBe("lost");
  });

  it("ended 是事实，永不被改判；没有会话、时间戳坏掉也原样返回", () => {
    const ended = cardWithSession({ state: "ended", lastSeenAt: "2026-10-10T09:00:00.000Z" });
    expect(deriveSessionState(ended, NOW).session?.state).toBe("ended");

    const none = emptyCard("c8", "2026-10-10T11:00:00.000Z");
    expect(deriveSessionState(none, NOW)).toBe(none);

    const broken = cardWithSession({ lastSeenAt: "不是时间" });
    expect(deriveSessionState(broken, NOW)).toBe(broken);
  });
});
