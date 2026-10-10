/**
 * 代码评审（本地事实）：
 *   - 纯规则：head 来源、outdated 判定、锚点排序、注释 id；
 *   - 投影：评论落进 `card.review`、幂等、排序、push 之后自动变 outdated；
 *   - **判定不改流程状态**（G3 验收仍由人点）；
 *   - 投影 == 从零重放（rebuild 一致）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { applyEvent, emptyCard } from "../src/server/project.ts";
import {
  compareReviewComments,
  headShaOf,
  isOutdated,
  markOutdated,
  nextReviewCommentId,
} from "../src/server/review.ts";
import { createStore, type Store } from "../src/server/store.ts";
import type { Card, Command, ReviewComment } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "s1" };

const at = (n: number): string => new Date(Date.parse("2026-10-10T00:00:00.000Z") + n * 1000).toISOString();

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "flowcard-review-"));
  return { store: createStore({ dataDir: dir, flow: personalFlow }), dir };
}

const commentOf = (id: string, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  sha: "aaaa",
  path: "a.ts",
  line: 1,
  side: "new",
  body: id,
  at: "2026-10-10T00:00:00.000Z",
  actor: HUMAN,
  outdated: false,
  ...over,
});

/** 把一张卡推到 `review`（沿途的命令都是已有能力，这里只是走流程）。 */
function driveToReview(store: Store, pushShas: string[] = ["A"]): string {
  const run = (n: number, cmd: Command): void => {
    store.execute(cmd, at(n));
  };
  let step = 0;
  const id = store.execute({ cmd: "open", actor: HUMAN, title: "评审卡", body: "" }, at(step++)).outcome
    .primaryCardId;
  run(step++, {
    cmd: "bindIssue",
    actor: HUMAN,
    card: id,
    number: 1,
    repo: "r",
    url: "http://i/1",
  });
  run(step++, { cmd: "plan", actor: HUMAN, card: id, body: "方案" });
  run(step++, { cmd: "decideGate", actor: HUMAN, card: id, gate: "G1", decision: "approved" });
  run(step++, {
    cmd: "worktree",
    actor: HUMAN,
    card: id,
    worktree: { path: "/w/card", branch: "feat/card", source: "flowcard" },
  });
  run(step++, {
    cmd: "bindPr",
    actor: HUMAN,
    card: id,
    pr: { repo: "r", number: 2, url: "http://p/2", branch: "feat/card", state: "open" },
  });
  run(step++, {
    cmd: "claim",
    actor: AGENT,
    card: id,
    session: { harness: "omp", id: "s1", cwd: "/w/card/sub", agentKind: "main" },
  });
  for (const sha of pushShas) run(step++, { cmd: "push", actor: AGENT, card: id, sha });
  run(step++, { cmd: "end", actor: AGENT, card: id });
  return id;
}

describe("评审：纯规则", () => {
  it("head = 最近一次 push 的 sha；一次都没推 → 未知", () => {
    const card = emptyCard("c1", at(0));
    expect(headShaOf(card)).toBeUndefined();
    expect(headShaOf({ ...card, pushes: [{ sha: "A", at: at(1), actor: HUMAN }] })).toBe("A");
    expect(
      headShaOf({
        ...card,
        pushes: [
          { sha: "A", at: at(1), actor: HUMAN },
          { sha: "B", at: at(2), actor: HUMAN },
        ],
      }),
    ).toBe("B");
  });

  it("outdated：head 未知不说人过期；sha 不一致才算过期", () => {
    expect(isOutdated("a", undefined)).toBe(false);
    expect(isOutdated("a", "a")).toBe(false);
    expect(isOutdated("a", "b")).toBe(true);

    const comments = [commentOf("rc1", { sha: "a" }), commentOf("rc2", { sha: "b" })];
    expect(markOutdated(comments, "b").map((c) => c.outdated)).toEqual([true, false]);
    expect(markOutdated(comments, undefined).map((c) => c.outdated)).toEqual([false, false]);
    // 纯函数：不改原数组。
    expect(comments[0]?.outdated).toBe(false);
  });

  it("注释 id 自增；排序是「锚点在前、时间在后」", () => {
    expect(nextReviewCommentId([])).toBe("rc1");
    expect(nextReviewCommentId([commentOf("rc1"), commentOf("rc2")])).toBe("rc3");
    // 认不出的 id 不参与推导（不会因此跳号）。
    expect(nextReviewCommentId([commentOf("weird")])).toBe("rc1");

    const sorted = [
      commentOf("rc1", { path: "b.ts", line: 9, at: at(3) }),
      commentOf("rc2", { path: "a.ts", line: 2, at: at(1) }),
      commentOf("rc3", { path: "a.ts", line: 2, at: at(2) }),
    ].sort(compareReviewComments);
    expect(sorted.map((c) => c.id)).toEqual(["rc2", "rc3", "rc1"]);
    // 同一位置的两条按时间先后 —— 这正是锚点 (sha, path, line, side) 的语义。
    expect(sorted[0]!.at < sorted[1]!.at).toBe(true);
  });
});

describe("评审：投影", () => {
  it("评论落进 card.review，同一条重发幂等，同位置多条按时间排序", () => {
    const { store } = freshStore();
    const id = store.execute({ cmd: "open", actor: HUMAN, title: "评", body: "" }, at(0)).outcome
      .primaryCardId;

    const first: Command = {
      cmd: "reviewComment",
      actor: HUMAN,
      card: id,
      sha: "AAAA",
      path: "b.ts",
      line: 9,
      side: "new",
      body: "这里并发没处理",
    };
    expect(store.execute(first, at(1)).inserted).toHaveLength(1);
    const again = store.execute(first, at(2));
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toBeGreaterThan(0);

    store.execute(
      { cmd: "reviewComment", actor: HUMAN, card: id, sha: "AAAA", path: "a.ts", line: 2, side: "old", body: "先问清" },
      at(3),
    );
    store.execute(
      { cmd: "reviewComment", actor: HUMAN, card: id, sha: "AAAA", path: "a.ts", line: 2, side: "old", body: "再补一句" },
      at(4),
    );

    const card = store.getCard(id);
    expect(card?.review.comments).toHaveLength(3);
    expect(card?.review.comments.map((c) => c.id)).toEqual(["rc2", "rc3", "rc1"]);
    expect(card?.review.comments.map((c) => `${c.path}:${c.line}:${c.side}`)).toEqual([
      "a.ts:2:old",
      "a.ts:2:old",
      "b.ts:9:new",
    ]);
    expect(card?.review.comments.map((c) => c.at)).toEqual([at(3), at(4), at(1)]);
    expect(card?.review.comments.every((c) => c.actor.kind === "human")).toBe(true);
    expect(card?.review.verdict).toBeUndefined();
    store.close();
  });

  it("推送让老评论变 outdated；新 head 上的评论不过期", () => {
    const { store } = freshStore();
    const id = driveToReview(store, ["A"]);
    expect(store.getCard(id)?.state).toBe("review");

    store.execute(
      { cmd: "reviewComment", actor: HUMAN, card: id, sha: "A", path: "a.ts", line: 1, side: "new", body: "在 A 上提的" },
      at(50),
    );
    expect(store.getCard(id)?.review.comments[0]?.outdated).toBe(false);

    // head 往前走了：老评论过期。
    store.execute({ cmd: "push", actor: AGENT, card: id, sha: "B" }, at(51));
    expect(store.getCard(id)?.review.comments[0]?.outdated).toBe(true);

    store.execute(
      { cmd: "reviewComment", actor: HUMAN, card: id, sha: "B", path: "a.ts", line: 2, side: "new", body: "在 B 上提的" },
      at(52),
    );
    const comments = store.getCard(id)?.review.comments ?? [];
    expect(comments.map((c) => [c.sha, c.outdated])).toEqual([
      ["A", true],
      ["B", false],
    ]);
    store.close();
  });

  it("判定只记录、不改流程状态，也不占门禁", () => {
    const { store } = freshStore();
    const id = driveToReview(store);
    const before = store.getCard(id)!;
    expect(before.state).toBe("review");

    const approved = store.execute(
      { cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "approve", body: "看过了" },
      at(50),
    );
    expect(approved.outcome.rejection).toBeUndefined();
    expect(approved.outcome.events.map((e) => e.type)).toEqual(["review.verdict.recorded"]);

    const after = store.getCard(id)!;
    expect(after.state).toBe("review");
    expect(after.acceptedAt).toBeUndefined();
    expect(after.gates.G3).toBeUndefined();
    expect(after.review.verdict).toEqual({ decision: "approve", at: at(50), by: "tester", body: "看过了" });

    // 重复同一条判定幂等；改主意（request_changes）能覆盖；再改回来还能记上。
    const again = store.execute(
      { cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "approve", body: "看过了" },
      at(51),
    );
    expect(again.inserted).toHaveLength(0);
    expect(store.execute({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "request_changes" }, at(52)).inserted).toHaveLength(1);
    expect(store.getCard(id)?.review.verdict?.decision).toBe("request_changes");
    expect(store.execute({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "approve", body: "看过了" }, at(53)).inserted).toHaveLength(1);
    expect(store.getCard(id)?.review.verdict?.decision).toBe("approve");
    expect(store.getCard(id)?.state).toBe("review");
    store.close();
  });

  it("投影 == 从零重放，rebuild 之后一模一样", () => {
    const { store } = freshStore();
    const id = driveToReview(store, ["A", "B"]);
    store.execute(
      { cmd: "reviewComment", actor: AGENT, card: id, sha: "B", path: "src/x.ts", line: 12, side: "new", body: "边界没测" },
      at(50),
    );
    store.execute({ cmd: "reviewComment", actor: HUMAN, card: id, sha: "A", path: "src/x.ts", line: 7, side: "old", body: "老代码可以删" }, at(51));
    store.execute({ cmd: "reviewVerdict", actor: HUMAN, card: id, verdict: "request_changes", body: "改完再说" }, at(52));

    const before = store.getCard(id)!;
    expect(before.review.comments.map((c) => [c.path, c.line, c.outdated])).toEqual([
      ["src/x.ts", 7, true],
      ["src/x.ts", 12, false],
    ]);

    // 手工按事件流折叠一遍，必须等于当前投影。
    const folded = store
      .listEvents(1000)
      .filter((e) => e.cardId === id)
      .reduce<Card>((acc, e) => applyEvent(acc, e), emptyCard(id, at(0)));
    expect(folded).toEqual(before);

    expect(store.rebuild()).toBe(1);
    expect(store.getCard(id)).toEqual(before);
    store.close();
  });

  it("卡片不存在 → NOT_FOUND（评审命令也不例外）", () => {
    const { store } = freshStore();
    const missing = store.execute(
      { cmd: "reviewVerdict", actor: HUMAN, card: "c404", verdict: "approve" },
      at(0),
    );
    expect(missing.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(missing.inserted).toHaveLength(0);
    store.close();
  });
});
