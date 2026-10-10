/**
 * 阶段派生（看板分列）的单测。
 *
 * 分两层：
 * 1. **逐条钉死**：每条判据（含优先级顺序）一条用例，断言「某事实组合 → 落到哪一列」。
 *    这一层是回归网：之后加列/改列/把顺序写反，这里必须红。
 * 2. **结构性自洽**：列集合 = `STAGES`、判据表顺序 = 列序、兜底完备、缺外部事实时退化。
 */
import { describe, expect, it } from "vitest";
import { emptyCard } from "../src/server/project.ts";
import type { Card, PrRef, Session } from "../src/shared/types.ts";
import {
  deriveStage,
  STAGE_FALLBACK,
  STAGE_LABELS,
  STAGE_RULES,
  STAGES,
  withStage,
  type CardGitFacts,
} from "../src/shared/stage.ts";

const AT = "2026-10-10T00:00:00.000Z";
/** 有改动：脏文件 2 + 提交 3。 */
const GIT: CardGitFacts = { dirtyFiles: 2, commitsSinceBase: 3, baseBranch: "origin/main" };
/** 什么都没干（确实读到 0/0）。 */
const IDLE_GIT: CardGitFacts = { dirtyFiles: 0, commitsSinceBase: 0, baseBranch: "origin/main" };
/** 只改了没提交（实施中的典型现场）。 */
const DIRTY_ONLY_GIT: CardGitFacts = { dirtyFiles: 2, commitsSinceBase: 0, baseBranch: "origin/main" };
/** 只提交了（待开 PR 的典型现场）。 */
const COMMITS_ONLY_GIT: CardGitFacts = { dirtyFiles: 0, commitsSinceBase: 1, baseBranch: "origin/main" };
const PR_OPEN: PrRef = {
  repo: "acme/demo",
  number: 7,
  url: "https://example.com/acme/demo/pulls/7",
  branch: "feat/card",
  state: "open",
  ci: "pending",
};
const SESSION: Session = {
  harness: "omp",
  id: "sess-1",
  agentKind: "main",
  cwd: "/w/proj/.worktrees/card",
  state: "idle",
  startedAt: AT,
  lastSeenAt: AT,
};

const card = (over: Partial<Card> = {}): Card => ({ ...emptyCard("c1", AT), ...over });
/** 判据只认「外部事实」这一层；测试里把 git 包进去（`null` = 完全没采集到）。 */
const stageWith = (c: Card, git: CardGitFacts | null = null) => deriveStage(c, git ? { git } : null);

/** 形态各异的卡：每种卡片事实都出现一次（状态 × 会话 × PR × 验收）。 */
const CASES: { name: string; card: Card; git: CardGitFacts | null }[] = [
  { name: "空卡", card: card(), git: null },
  { name: "空卡 + git", card: card(), git: GIT },
  { name: "有会话", card: card({ session: SESSION }), git: null },
  { name: "有会话 + 脏文件", card: card({ session: SESSION }), git: GIT },
  { name: "有会话 + 干净且零提交", card: card({ session: SESSION }), git: IDLE_GIT },
  { name: "失联会话", card: card({ session: { ...SESSION, state: "lost" } }), git: null },
  { name: "结束会话（未验收）", card: card({ session: { ...SESSION, state: "ended" } }), git: GIT },
  {
    name: "结束会话（已验收）",
    card: card({ session: { ...SESSION, state: "ended" }, acceptedAt: AT }),
    git: null,
  },
  { name: "有 PR", card: card({ pr: PR_OPEN }), git: GIT },
  { name: "PR 已合并 + 已验收", card: card({ pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT }), git: GIT },
  {
    name: "PR 已合并（未验收）+ 会话结束",
    card: card({ pr: { ...PR_OPEN, state: "merged" }, session: { ...SESSION, state: "ended" } }),
    git: GIT,
  },
  { name: "只看有提交（无 PR、无会话）", card: card(), git: COMMITS_ONLY_GIT },
  { name: "只看有脏文件（无 PR、无会话）", card: card(), git: DIRTY_ONLY_GIT },
  { name: "review 状态", card: card({ state: "review" }), git: null },
  { name: "merged 状态", card: card({ state: "merged" }), git: null },
  { name: "done 状态", card: card({ state: "done" }), git: GIT },
  { name: "blocked 状态", card: card({ state: "blocked", blockedReason: "缺 design review" }), git: GIT },
  { name: "dropped 状态", card: card({ state: "dropped" }), git: null },
];

// ---------------------------------------------------------------- 逐条钉死

describe("逐条判据：事实组合 → 列", () => {
  it("1 放弃：state=dropped（哪怕还有别的现场事实）→ dropped", () => {
    expect(stageWith(card({ state: "dropped" }))).toBe("dropped");
    expect(
      stageWith(card({ state: "dropped", pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT, session: SESSION }), GIT),
    ).toBe("dropped");
  });

  it("2 完成：state=done → done", () => {
    expect(stageWith(card({ state: "done" }), GIT)).toBe("done");
    expect(stageWith(card({ state: "done", cleanedAt: AT }))).toBe("done");
  });

  it("3 阻塞：state=blocked（blockedReason 只作徽标，不改判据）→ blocked", () => {
    expect(stageWith(card({ state: "blocked", blockedReason: "缺 design review" }))).toBe("blocked");
    expect(stageWith(card({ state: "blocked", session: SESSION }), GIT)).toBe("blocked");
  });

  it("4 已合并待清理：state=merged → merged", () => {
    expect(stageWith(card({ state: "merged" }))).toBe("merged");
    expect(stageWith(card({ state: "merged" }), GIT)).toBe("merged");
  });

  it("4 已合并待清理：PR 已 merged 且已验收（acceptedAt）→ merged", () => {
    expect(stageWith(card({ pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT }))).toBe("merged");
    // 只 merged 还没验收 → 不算这一列（看下一条）
    expect(stageWith(card({ pr: { ...PR_OPEN, state: "merged" } }))).not.toBe("merged");
  });

  it("5 待你验收：state=review → review（不看会话/PR/CI）", () => {
    expect(stageWith(card({ state: "review" }))).toBe("review");
    expect(stageWith(card({ state: "review" }), IDLE_GIT)).toBe("review");
  });

  it("5 待你验收：会话 ended 且未验收 → review；lost 同样", () => {
    expect(stageWith(card({ session: { ...SESSION, state: "ended" } }))).toBe("review");
    expect(stageWith(card({ session: { ...SESSION, state: "lost" } }))).toBe("review");
  });

  it("5 待你验收：会话 ended 但已验收 → 不再是 review", () => {
    expect(stageWith(card({ session: { ...SESSION, state: "ended" }, acceptedAt: AT }))).not.toBe("review");
  });

  it("6 PR 待审 / 等 CI：有 PR 且未 merged → prReview（CI 只作徽标）", () => {
    expect(stageWith(card({ pr: PR_OPEN }))).toBe("prReview");
    for (const ci of ["pending", "pass", "fail"] as const) {
      expect(stageWith(card({ pr: { ...PR_OPEN, ci } }))).toBe("prReview");
    }
    expect(stageWith(card({ pr: { ...PR_OPEN, state: "draft" } }))).toBe("prReview");
    expect(stageWith(card({ pr: { ...PR_OPEN, state: "closed" } }))).toBe("prReview");
  });

  it("7 待开 PR：没有 PR 但确实读到提交 → prTodo", () => {
    expect(stageWith(card(), COMMITS_ONLY_GIT)).toBe("prTodo");
    expect(stageWith(card({ session: SESSION }), COMMITS_ONLY_GIT)).toBe("prTodo");
  });

  it("7 待开 PR：没有 PR 也没提交（或提交数未知）→ 不是 prTodo", () => {
    expect(stageWith(card(), IDLE_GIT)).not.toBe("prTodo");
    expect(stageWith(card(), { ...IDLE_GIT, commitsSinceBase: null })).not.toBe("prTodo");
    expect(stageWith(card(), null)).not.toBe("prTodo");
  });

  it("8 实施中：有会话 + 只有未提交改动（没提交、没 PR）→ working", () => {
    expect(stageWith(card({ session: SESSION }), DIRTY_ONLY_GIT)).toBe("working");
    expect(stageWith(card({ session: { ...SESSION, state: "running" } }), DIRTY_ONLY_GIT)).toBe("working");
  });

  it("8 实施中：有会话但已证明什么都没干（脏文件 0 + 提交 0）→ 不是 working", () => {
    expect(stageWith(card({ session: SESSION }), IDLE_GIT)).toBe(STAGE_FALLBACK);
  });

  it("9 待立项：没有会话、没有改动、没有 PR → backlog", () => {
    expect(stageWith(card())).toBe("backlog");
    expect(stageWith(card(), IDLE_GIT)).toBe("backlog");
  });

  it("9 待立项：有 worktree 但没会话没改动 → 仍是 backlog（worktree 本身不是进度）", () => {
    const withWorktree = card({ worktree: { path: "/w/proj/.worktrees/card", branch: "feat/card", source: "flowcard" } });
    expect(stageWith(withWorktree, IDLE_GIT)).toBe("backlog");
  });
});

describe("逐条优先级：更靠前的判据赢", () => {
  it("dropped 压过一切（merg/done 之外的状态就是 dropped）", () => {
    expect(stageWith(card({ state: "dropped", pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT }))).toBe("dropped");
  });

  it("P1 merged 压过 prReview / review：PR 已 merged + 已验收 + state=review → merged", () => {
    expect(stageWith(card({ state: "review", pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT }))).toBe("merged");
  });

  it("P2 review 压过 prReview：state=review + PR 还开着 → review", () => {
    expect(stageWith(card({ state: "review", pr: PR_OPEN }), GIT)).toBe("review");
  });

  it("P3 prReview 压过 prTodo 与 working：有 PR + 有提交 + 会话还在 → prReview", () => {
    expect(stageWith(card({ session: SESSION, pr: PR_OPEN }), COMMITS_ONLY_GIT)).toBe("prReview");
  });

  it("P4 prTodo 压过 working：没 PR + 有提交 + 会话还在（且没有脏文件）→ prTodo", () => {
    expect(stageWith(card({ session: SESSION }), COMMITS_ONLY_GIT)).toBe("prTodo");
  });

  it("P5 working 压过 backlog：有会话 + 有脏文件 → working", () => {
    expect(stageWith(card({ session: SESSION }), DIRTY_ONLY_GIT)).toBe("working");
  });

  it("P6 blocked 压过 merged：state=blocked + PR 已 merged + 已验收 → blocked", () => {
    expect(stageWith(card({ state: "blocked", pr: { ...PR_OPEN, state: "merged" }, acceptedAt: AT }))).toBe("blocked");
  });
});

// ---------------------------------------------------------------- 缺外部事实就退化

describe("缺外部事实（git）时退化：只看卡片事实，不猜", () => {
  it("有会话但拿不到 git 事实 → 仍算实施中（会话本身就是事实），不当成 0 改动", () => {
    expect(stageWith(card({ session: SESSION }), null)).toBe("working");
  });

  it("确实读到「脏文件 0 + 提交 0」才往下挪列（null 与 0 不是一回事）", () => {
    expect(stageWith(card({ session: SESSION }), IDLE_GIT)).toBe("backlog");
    expect(stageWith(card({ session: SESSION }), null)).toBe("working");
  });

  it("「有提交」只认确实读到的数：commitsSinceBase=null 与 0 同效，读到 >0 才换列", () => {
    expect(stageWith(card(), { ...IDLE_GIT, commitsSinceBase: null })).toBe("backlog");
    expect(stageWith(card(), { ...IDLE_GIT, commitsSinceBase: 2 })).toBe("prTodo");
  });

  it("不用 git 的判据（PR / 状态 / 会话）缺 git 事实照样成立", () => {
    expect(stageWith(card({ pr: PR_OPEN }), null)).toBe("prReview");
    expect(stageWith(card({ state: "review" }), null)).toBe("review");
  });
});

// ---------------------------------------------------------------- 结构性自洽

describe("列的定义与判据表（加列只该改 STAGES + STAGE_RULES）", () => {
  it("列（id + 中文标签 + 顺序）就是定稿的九个", () => {
    expect([...STAGES]).toEqual([
      "dropped",
      "done",
      "blocked",
      "merged",
      "review",
      "prReview",
      "prTodo",
      "working",
      "backlog",
    ]);
    expect(STAGE_LABELS).toEqual({
      dropped: "放弃",
      done: "完成",
      blocked: "阻塞",
      merged: "已合并待清理",
      review: "待你验收",
      prReview: "PR 待审 / 等 CI",
      prTodo: "待开 PR",
      working: "实施中",
      backlog: "待立项",
    });
  });

  it("判据表与列同序同集（列序 = 优先级），兜底列在最后且对任何卡片都成立", () => {
    expect(STAGE_RULES.map((rule) => rule.stage)).toEqual([...STAGES]);
    expect(new Set(STAGES).size).toBe(STAGES.length);
    expect(STAGE_RULES.at(-1)!.stage).toBe(STAGE_FALLBACK);
    for (const { name, card: c, git } of CASES) {
      expect(STAGE_RULES.at(-1)!.match(c, git ? { git } : null), name).toBe(true);
    }
  });

  it("每张卡都至少命中一条判据，且 deriveStage = 第一条命中的那列", () => {
    for (const { name, card: c, git } of CASES) {
      const hits = STAGE_RULES.filter((rule) => rule.match(c, git ? { git } : null));
      expect(hits.length, name).toBeGreaterThan(0);
      expect(deriveStage(c, git ? { git } : null), name).toBe(hits[0]!.stage);
    }
  });
});

describe("出口投影", () => {
  it("withStage 带上 stage；有 git 事实才带 git 字段（没有就不写假值）", () => {
    const c = card({ session: SESSION });
    const withGit = withStage(c, DIRTY_ONLY_GIT);
    expect(withGit.stage).toBe("working");
    expect(withGit.git).toEqual(DIRTY_ONLY_GIT);
    expect(withGit.state).toBe(c.state); // 派生阶段不改状态
    const withoutGit = withStage(c, null);
    expect(withoutGit.stage).toBe("working");
    expect("git" in withoutGit).toBe(false);
  });
});
