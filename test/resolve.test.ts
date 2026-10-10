/**
 * M6：claim 不带 card 时按会话 cwd 反查卡片。
 *
 * 选这个新文件而不是塞进 engine.test.ts：解析规则本身（路径段比较 / 最长路径 / 零命中的参照物文案）
 * 是 store 里的纯函数，和引擎的"命令 → 事件"用例是两件事，分开放读起来更清楚；
 * 引擎侧只留"显式 card 不走解析"与"subagent 不解析"这两条接线用例。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { emptyCard } from "../src/server/project.ts";
import { createStore, resolveClaimCardByCwd } from "../src/server/store.ts";
import type { Card } from "../src/shared/types.ts";
import { createHarness } from "./harness.ts";

const AT = "2026-10-10T00:00:00.000Z";

/** 造一张只关心 worktree 槽位的卡片。 */
function cardWithWorktree(id: string, path: string | null): Card {
  const base = emptyCard(id, AT);
  return { ...base, worktree: path === null ? null : { path, branch: `feat/${id}`, source: "flowcard" } };
}

describe("按 cwd 解析 claim 的卡片（纯函数）", () => {
  it("唯一命中：cwd 落在 worktree 之内（含 worktree 自己）", () => {
    const cards = [cardWithWorktree("c1", "/repo/.worktrees/x")];
    expect(resolveClaimCardByCwd("/repo/.worktrees/x", cards)).toEqual({ cardId: "c1" });
    expect(resolveClaimCardByCwd("/repo/.worktrees/x/src/deep", cards)).toEqual({ cardId: "c1" });
  });

  it("多命中取路径最长的那个（最具体的 worktree 赢）", () => {
    const cards = [cardWithWorktree("c1", "/repo"), cardWithWorktree("c2", "/repo/.worktrees/x")];
    expect(resolveClaimCardByCwd("/repo/.worktrees/x/src", cards)).toEqual({ cardId: "c2" });
    expect(resolveClaimCardByCwd("/repo/other", cards)).toEqual({ cardId: "c1" });
  });

  it("路径段比较：/a/b 不误配 /a/bc", () => {
    const cards = [cardWithWorktree("c1", "/a/b")];
    expect(resolveClaimCardByCwd("/a/bc", cards)).toMatchObject({ error: expect.anything() });
    expect(resolveClaimCardByCwd("/a/b/c", cards)).toEqual({ cardId: "c1" });
  });

  it("零命中 → 错误信息里带参照物（可用卡片），且不超过 200 字", () => {
    const cards = [
      cardWithWorktree("c1", "/repo/.worktrees/x"),
      cardWithWorktree("c2", "/repo/.worktrees/y"),
      cardWithWorktree("c3", null),
    ];
    const out = resolveClaimCardByCwd("/elsewhere", cards);
    expect(out).toMatchObject({ error: { message: expect.any(String), hint: expect.any(String) } });
    if (!("error" in out)) throw new Error("应该是解析失败");
    expect(out.error.message).toContain("没有对应任何卡片的 worktree");
    expect(out.error.hint).toContain("可用卡片：");
    expect(out.error.hint).toContain("c1(/repo/.worktrees/x)");
    expect(out.error.hint).toContain("c2(/repo/.worktrees/y)");
    expect(out.error.hint).not.toContain("c3"); // 没有 worktree 的卡片不是参照物
    expect(out.error.message.length + out.error.hint.length).toBeLessThanOrEqual(200);
  });

  it("并列最长（同一条 worktree 绑了两张卡）→ 拿不到唯一解，报歧义", () => {
    const cards = [cardWithWorktree("c1", "/repo/.worktrees/x"), cardWithWorktree("c2", "/repo/.worktrees/x")];
    const out = resolveClaimCardByCwd("/repo/.worktrees/x", cards);
    expect(out).toMatchObject({ error: { message: expect.any(String) } });
    if (!("error" in out)) throw new Error("应该是解析失败");
    expect(out.error.message).toContain("c1");
    expect(out.error.message).toContain("c2");
    expect(out.error.hint).toContain("FLOWCARD_CARD");
  });

  it("一张带 worktree 的卡都没有时，提示先建卡", () => {
    const out = resolveClaimCardByCwd("/repo", [cardWithWorktree("c1", null)]);
    expect(out).toMatchObject({ error: { hint: expect.stringContaining("还没有带 worktree 的卡片") } });
  });
});

describe("store：claim 不带 card 走真实解析", () => {
  it("从 cwd 认领卡片，并把 cwd 记进会话", () => {
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-resolve-")),
      flow: personalFlow,
    });
    const HUMAN = { kind: "human" as const, name: "tester" };
    const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "sess-1" };
    const worktreePath = "/repo/.worktrees/x";

    const id = store.execute(
      {
        cmd: "open",
        actor: HUMAN,
        title: "自动绑卡",
        body: "",
        issue: { repo: "r", number: 1, url: "http://i/1", state: "open" },
      },
      AT,
    ).outcome.primaryCardId;
    store.execute({ cmd: "plan", actor: AGENT, card: id, body: "方案" }, AT);
    store.execute({ cmd: "decideGate", actor: HUMAN, card: id, gate: "G1", decision: "approved" }, AT);
    store.execute(
      { cmd: "worktree", actor: AGENT, card: id, worktree: { path: worktreePath, branch: "feat/x", source: "flowcard" } },
      AT,
    );
    store.execute(
      {
        cmd: "bindPr",
        actor: AGENT,
        card: id,
        pr: { repo: "r", number: 2, url: "http://p/2", branch: "feat/x", state: "open" },
      },
      AT,
    );

    const claimed = store.execute(
      {
        cmd: "claim",
        actor: AGENT,
        session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: `${worktreePath}/src` },
      },
      AT,
    );

    expect(claimed.outcome.rejection).toBeUndefined();
    expect(claimed.outcome.primaryCardId).toBe(id);
    expect(claimed.card?.id).toBe(id);
    expect(claimed.card?.state).toBe("working");
    expect(claimed.card?.session?.cwd).toBe(`${worktreePath}/src`);
    expect(claimed.card?.session?.id).toBe("sess-1");
    store.close();
  });

  it("cwd 不在任何 worktree 里 → NOT_FOUND，且不写事件", () => {
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-resolve-")),
      flow: personalFlow,
    });
    const id = store.execute({ cmd: "open", actor: { kind: "human", name: "t" }, title: "x", body: "" }, AT)
      .outcome.primaryCardId;

    const out = store.execute(
      {
        cmd: "claim",
        actor: { kind: "agent", harness: "omp", sessionId: "sess-1" },
        session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/nowhere" },
      },
      AT,
    );

    expect(out.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(out.outcome.rejection?.hint).toContain("还没有带 worktree 的卡片");
    expect(out.inserted).toHaveLength(0);
    expect(store.getCard(id)?.session).toBeNull();
    store.close();
  });
});

describe("engine：解析只在没给 card 时发生", () => {
  it("显式给 card 时不调用解析回调（解析坏了也不影响）", () => {
    let calls = 0;
    const h = createHarness({
      resolveCardByCwd: () => {
        calls++;
        return { error: { message: "不该被调用", hint: "不该被调用" } };
      },
    });
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "显式绑卡",
      body: "",
      issue: { repo: "r", number: 1, url: "http://i/1", state: "open" },
    }).primaryCardId;
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
    h.run({
      cmd: "worktree",
      actor: h.agent,
      card: id,
      worktree: { path: "/repo/.worktrees/x", branch: "feat/x", source: "flowcard" },
    });
    h.run({
      cmd: "bindPr",
      actor: h.agent,
      card: id,
      pr: { repo: "r", number: 2, url: "http://p/2", branch: "feat/x", state: "open" },
    });

    const out = h.run({
      cmd: "claim",
      actor: h.agent,
      card: id,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/repo/.worktrees/x" },
    });

    expect(out.rejection).toBeUndefined();
    expect(calls).toBe(0);
    expect(h.card(id).state).toBe("working");
  });

  it("claim 不带 card 且注入了解析：走解析绑卡", () => {
    const h = createHarness({
      resolveCardByCwd: (cwd) => resolveClaimCardByCwd(cwd, [...h.cards.values()]),
    });
    const id = h.run({
      cmd: "open",
      actor: h.human,
      title: "自动绑卡",
      body: "",
      issue: { repo: "r", number: 1, url: "http://i/1", state: "open" },
    }).primaryCardId;
    h.run({ cmd: "plan", actor: h.agent, card: id, body: "方案" });
    h.run({ cmd: "decideGate", actor: h.human, card: id, gate: "G1", decision: "approved" });
    h.run({
      cmd: "worktree",
      actor: h.agent,
      card: id,
      worktree: { path: "/repo/.worktrees/x", branch: "feat/x", source: "flowcard" },
    });
    h.run({
      cmd: "bindPr",
      actor: h.agent,
      card: id,
      pr: { repo: "r", number: 2, url: "http://p/2", branch: "feat/x", state: "open" },
    });

    const out = h.run({
      cmd: "claim",
      actor: h.agent,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/repo/.worktrees/x/src" },
    });

    expect(out.rejection).toBeUndefined();
    expect(out.primaryCardId).toBe(id);
    expect(h.card(id).session?.id).toBe("sess-1");
    expect(h.card(id).session?.cwd).toBe("/repo/.worktrees/x/src");
  });

  it("claim 不带 card 也没注入解析回调 → NOT_FOUND（引擎不碰 IO）", () => {
    const h = createHarness();
    const out = h.run({
      cmd: "claim",
      actor: h.agent,
      session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/repo" },
    });
    expect(out.rejection?.code).toBe("NOT_FOUND");
  });

  it("subagent 会话不解析（直接 USAGE_ERROR，不浪费一次反查）", () => {
    let calls = 0;
    const h = createHarness({
      resolveCardByCwd: () => {
        calls++;
        return { error: { message: "x", hint: "y" } };
      },
    });
    const out = h.run({
      cmd: "claim",
      actor: h.agent,
      session: { harness: "omp", id: "sub-1", agentKind: "sub", cwd: "/repo" },
    });
    expect(out.rejection?.code).toBe("USAGE_ERROR");
    expect(calls).toBe(0);
  });
});

describe("store：解析回调读的是最新投影", () => {
  it("后建的卡片也参与解析（不是启动时的快照）", () => {
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-resolve-")),
      flow: personalFlow,
    });
    const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "sess-1" };
    const first = store.execute({ cmd: "open", actor: { kind: "human", name: "t" }, title: "a", body: "" }, AT)
      .outcome.primaryCardId;
    // 先 claim 一张没有 worktree 的卡：解析必然失败，且不写事件
    const miss = store.execute(
      {
        cmd: "claim",
        actor: AGENT,
        session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/repo/.worktrees/x" },
      },
      AT,
    );
    expect(miss.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(miss.inserted).toHaveLength(0);

    store.execute(
      {
        cmd: "worktree",
        actor: AGENT,
        card: first,
        worktree: { path: "/repo/.worktrees/x", branch: "feat/x", source: "flowcard" },
      },
      AT,
    );
    const hit = store.execute(
      {
        cmd: "claim",
        actor: AGENT,
        session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: "/repo/.worktrees/x" },
      },
      AT,
    );
    expect(hit.outcome.rejection).toBeUndefined();
    expect(hit.card?.id).toBe(first);
    expect(hit.card?.session?.id).toBe("sess-1");
    store.close();
  });
});
