/**
 * 卡片 git 事实的采集与缓存 + 它怎么进 `/api/cards`。
 *
 * git 全部注入假的执行器（不跑真 git、不碰网络）：断言的是**调用次数**（缓存语义）
 * 与**字段映射**（probe 的输出 → `CardGitFacts`），以及出口投影的形状。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createCardGitFactsCache, GIT_FACTS_TTL_MS } from "../src/server/card-git.ts";
import { emptyCard } from "../src/server/project.ts";
import type { Run, RunOutcome } from "../src/server/probe.ts";
import { createStore } from "../src/server/store.ts";
import { deriveStage, STAGES, type CardGitFacts } from "../src/shared/stage.ts";
import type { Card } from "../src/shared/types.ts";

const AT = "2026-10-10T00:00:00.000Z";
const MAIN = "/w/proj";
const WT = `${MAIN}/.worktrees/card-1`;
const HUMAN = { kind: "human" as const, name: "tester" };
const AGENT = { kind: "agent" as const, harness: "omp", sessionId: "sess-1" };

const card = (id: string, worktreePath: string | null): Card => ({
  ...emptyCard(id, AT),
  ...(worktreePath ? { worktree: { path: worktreePath, branch: "feat/card-1", source: "flowcard" as const } } : {}),
});

/**
 * 假 git：只回答探针真正会打的那几条命令；其余一律报错（漏了哪条立刻看得见）。
 * `toplevelCalls` 用来验缓存 —— 一次探测 = 一次 `rev-parse --show-toplevel`。
 */
function fakeGit(facts: { dirtyFiles: number; commitsSinceBase: number } = { dirtyFiles: 2, commitsSinceBase: 3 }) {
  const calls: string[][] = [];
  const run: Run = async (_file, args) => {
    calls.push(args);
    const line = args.join(" ");
    const ok = (stdout: string): RunOutcome => ({ code: 0, stdout, stderr: "", missing: false });
    if (line.includes("--show-toplevel")) return ok(`${WT}\n`);
    if (line.includes("--symbolic-full-name")) return ok("origin/main\n");
    if (line.includes("--abbrev-ref")) return ok("feat/card-1\n");
    if (line.includes("--git-common-dir")) return ok(`${MAIN}/.git\n`);
    if (line.includes("--git-dir")) return ok(`${MAIN}/.git/worktrees/card-1\n`);
    if (line.includes("rev-parse HEAD")) return ok("abc123\n");
    if (line.includes("status --porcelain")) {
      const lines = Array.from({ length: facts.dirtyFiles }, (_, i) => ` M f${i}.ts`);
      return ok(lines.length > 0 ? `${lines.join("\n")}\n` : "");
    }
    if (line.includes("remote get-url origin")) return ok("git@github.com:acme/demo.git\n");
    if (line.includes("rev-list --count")) return ok(`${facts.commitsSinceBase}\n`);
    if (line.includes("log --oneline")) return ok("");
    return { code: 1, stdout: "", stderr: `未预期的 git 调用：${line}`, missing: false };
  };
  return { run, calls, toplevelCalls: () => calls.filter((args) => args.join(" ").includes("--show-toplevel")).length };
}

describe("卡片 git 事实：采集面与缓存", () => {
  it("只对有 worktree 的卡探测；同一 worktree 上的多张卡只跑一次", async () => {
    const { run, toplevelCalls } = fakeGit();
    const cache = createCardGitFactsCache({ run });
    const facts = await cache.collect([card("c1", WT), card("c2", WT), card("c3", null)]);

    expect([...facts.keys()]).toEqual([WT]);
    expect(facts.get(WT)).toEqual({ dirtyFiles: 2, commitsSinceBase: 3, baseBranch: "origin/main" });
    expect(toplevelCalls()).toBe(1);
    expect(cache.size()).toBe(1);
  });

  it("TTL 内复用缓存（SSE 刷新不会每次跑 git）；过期后才重跑", async () => {
    let clock = 1_000;
    const { run, toplevelCalls } = fakeGit();
    const cache = createCardGitFactsCache({ run, now: () => clock });
    const cards = [card("c1", WT)];

    await cache.collect(cards);
    await cache.collect(cards);
    expect(toplevelCalls()).toBe(1);

    clock += GIT_FACTS_TTL_MS - 1;
    await cache.collect(cards);
    expect(toplevelCalls()).toBe(1); // 还在寿命内：复用缓存

    clock += 2;
    await cache.collect(cards);
    expect(toplevelCalls()).toBe(2); // 越过寿命：重跑一次
  });

  it("并发请求同一个 worktree 只探测一次（不重复打 git）", async () => {
    const { run, toplevelCalls } = fakeGit();
    const cache = createCardGitFactsCache({ run });
    const [a, b] = await Promise.all([cache.collect([card("c1", WT)]), cache.collect([card("c2", WT)])]);

    expect(toplevelCalls()).toBe(1);
    expect(a.get(WT)).toEqual(b.get(WT));
  });

  it("路径不在仓库里 / git 不可用 → 没有 git 事实（不抛，也不当成 0）", async () => {
    const run: Run = async () => ({ code: 128, stdout: "", stderr: "not a git repository", missing: false });
    const cache = createCardGitFactsCache({ run });
    await expect(cache.collect([card("c1", WT)])).resolves.toEqual(new Map());
  });

  it("探测抛异常也不带崩接口（当作没有 git 事实）", async () => {
    const run: Run = async () => {
      throw new Error("boom");
    };
    const cache = createCardGitFactsCache({ run });
    await expect(cache.collect([card("c1", WT)])).resolves.toEqual(new Map());
  });
});

describe("GET /api/cards：带上 stage 与（有 worktree 时的）git", () => {
  const harness = () => {
    const store = createStore({ dataDir: mkdtempSync(join(tmpdir(), "flowcard-stage-")), flow: personalFlow });
    const open = (title: string) =>
      store.execute({ cmd: "open", actor: HUMAN, title, body: "" }, AT).outcome.primaryCardId;
    const withWorktree = open("有 worktree 的卡");
    const plain = open("还没动的卡");
    store.execute(
      { cmd: "worktree", actor: AGENT, card: withWorktree, worktree: { path: WT, branch: "feat/card-1", source: "flowcard" } },
      AT,
    );
    return { store, withWorktree, plain };
  };

  it("每张卡都有派生 stage；git 只挂在有 worktree 的卡上；v 再取一次不重跑 git", async () => {
    const { store, withWorktree, plain } = harness();
    const { run, toplevelCalls } = fakeGit();
    const app = createApp(store, { gitFacts: { run } });

    const first = (await (await app.request("/api/cards")).json()) as {
      cards: ({ id: string; stage: string; git?: CardGitFacts } & Card)[];
    };
    try {
      expect(first.cards).toHaveLength(2);
      for (const c of first.cards) expect(STAGES).toContain(c.stage);

      const busy = first.cards.find((c) => c.id === withWorktree)!;
      expect(busy.git).toEqual({ dirtyFiles: 2, commitsSinceBase: 3, baseBranch: "origin/main" });
      // 出口的 stage 就是共享层对「卡片 + 这批 git 事实」的派生结果（同一套判据，不是另一份）
      expect(busy.stage).toBe(deriveStage(busy, busy.git ? { git: busy.git } : null));
      expect(busy.state).toBe("ready"); // 派生阶段不改状态

      const untouched = first.cards.find((c) => c.id === plain)!;
      expect("git" in untouched).toBe(false);
      expect(untouched.stage).toBe(deriveStage(untouched));

      expect(toplevelCalls()).toBe(1);
      const second = (await (await app.request("/api/cards")).json()) as { cards: { id: string; stage: string }[] };
      expect(second.cards.map((c) => c.stage)).toEqual(first.cards.map((c) => c.stage));
      expect(toplevelCalls()).toBe(1); // 30s 缓存：第二次请求不再跑 git
    } finally {
      store.close();
    }
  });

  it("GET /api/cards/:id 同样带 stage（`flowcard show` 用的就是它）", async () => {
    const { store, plain } = harness();
    const app = createApp(store, { gitFacts: { run: fakeGit().run } });
    try {
      const res = await app.request(`/api/cards/${plain}`);
      const body = (await res.json()) as { card: { stage: string } };
      expect(res.status).toBe(200);
      expect(STAGES).toContain(body.card.stage);
    } finally {
      store.close();
    }
  });

  it("不传 gitFacts → 不跑任何 git，stage 仍然有（退化成只看卡片事实）", async () => {
    const { store, withWorktree } = harness();
    const app = createApp(store);
    try {
      const body = (await (await app.request("/api/cards")).json()) as { cards: { id: string; stage: string }[] };
      const target = body.cards.find((c) => c.id === withWorktree)!;
      expect(STAGES).toContain(target.stage);
      expect(deriveStage(card(withWorktree, WT))).toBe(target.stage);
    } finally {
      store.close();
    }
  });
});
