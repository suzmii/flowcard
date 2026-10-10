/**
 * 测试用的小驱动：把一串命令按顺序喂给引擎，不需要数据库。
 * 每个用例只关心「事实落库后卡片长什么样」与「哪一步被拦住、缺什么」。
 */
import { personalFlow } from "../src/flow/personal.ts";
import { runCommand, type CommandOutcome } from "../src/server/engine.ts";
import { applyEvent, emptyCard, type NewEvent } from "../src/server/project.ts";
import type { Card, Command, CwdClaimResolution } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "you" };
const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "sess-1" };

export function createHarness(opts: { resolveCardByCwd?: (cwd: string) => CwdClaimResolution } = {}) {
  const cards = new Map<string, Card>();
  const allEvents: NewEvent[] = [];
  let counter = 0;
  let clock = Date.parse("2026-10-10T00:00:00.000Z");

  const run = (cmd: Command): CommandOutcome => {
    clock += 1000;
    const outcome = runCommand({
      flow: personalFlow,
      getCard: (id) => cards.get(id),
      cmd,
      now: new Date(clock).toISOString(),
      newCardId: () => `c${++counter}`,
      ...opts,
    });
    for (const [id, card] of Object.entries(outcome.cards)) cards.set(id, card);
    allEvents.push(...outcome.events);
    return outcome;
  };

  const card = (id: string): Card => {
    const found = cards.get(id);
    if (!found) throw new Error(`卡片 ${id} 不存在`);
    return found;
  };

  /** 从零重放全部事件，验证投影与事件流一致。 */
  const rebuild = (id: string): Card =>
    allEvents
      .filter((e) => e.cardId === id)
      .reduce<Card>((acc, e) => applyEvent(acc, e), emptyCard(id, allEvents[0]?.at ?? ""));

  return { run, card, cards, allEvents, rebuild, human: HUMAN, agent: AGENT };
}

export const issueRef = {
  repo: "example",
  number: 42,
  url: "https://gitea.example.com/x/y/issues/42",
  state: "open" as const,
};

export const worktreeRef = {
  path: "/home/u/workspace/proj/.worktrees/card-1",
  branch: "feat/card-1",
  source: "harness" as const,
};

export const prRef = {
  repo: "example",
  number: 77,
  url: "https://gitea.example.com/x/y/pulls/77",
  branch: "feat/card-1",
  state: "open" as const,
};
