/**
 * 提交图（只读）：在**真实临时仓库**（多分支 + merge + 两个 worktree）上验证
 * 解析、卡片映射、limit 收敛，以及 HTTP 端点的形状与状态码。
 *
 * 只读：`git init/commit/branch/merge/worktree add` 只写这个临时仓库自己的东西，
 * 不联网、不 fetch/push；`readGraph` 只跑 log/for-each-ref/worktree list。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import {
  clampGraphLimit,
  decorateToRefs,
  mapCardsToWorktrees,
  parseBranches,
  parseCommits,
  parseWorktreeList,
  readGraph,
} from "../src/server/graph.ts";
import { emptyCard } from "../src/server/project.ts";
import { readProject } from "../src/server/projects.ts";
import type { Run } from "../src/server/probe.ts";
import { createStore } from "../src/server/store.ts";
import type { Card } from "../src/shared/types.ts";

const AT = "2026-10-10T00:00:00.000Z";

type Fixture = {
  root: string;
  wtOne: string;
  wtTwo: string;
  mainSha: string;
  featureSha: string;
  mergeSha: string;
};

/** 一个真有形状的仓库：main + feature 分支 + 一次 --no-ff 合并 + 两个 worktree（一个 detached）。 */
function makeGraphRepo(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "flowcard-graph-"));
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

  git("init", "-q", "-b", "main");
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "tester");
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "初提交");
  const mainSha = git("rev-parse", "HEAD");

  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(root, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feature 提交");
  const featureSha = git("rev-parse", "HEAD");

  git("checkout", "-q", "main");
  writeFileSync(join(root, "c.txt"), "c\n");
  git("add", "-A");
  git("commit", "-q", "-m", "主干提交");
  git("merge", "-q", "--no-ff", "-m", "合并 feature", "feature");
  const mergeSha = git("rev-parse", "HEAD");

  const wtOne = join(base, "wt-one");
  const wtTwo = join(base, "wt-two");
  git("worktree", "add", "-q", "-b", "feat/one", wtOne);
  git("worktree", "add", "-q", "--detach", wtTwo);

  return { root, wtOne, wtTwo, mainSha, featureSha, mergeSha };
}

describe("提交图：纯解析", () => {
  it("decorate 解析：`HEAD -> x` 只留分支名，其余原样", () => {
    expect(decorateToRefs("")).toEqual([]);
    expect(decorateToRefs("HEAD -> main, origin/main, tag: v1")).toEqual([
      "main",
      "origin/main",
      "tag: v1",
    ]);
  });

  it("limit 收敛：默认 200、下限 1、上限 1000，认不出的值退回默认", () => {
    expect(clampGraphLimit(undefined)).toBe(200);
    expect(clampGraphLimit("abc")).toBe(200);
    expect(clampGraphLimit("7")).toBe(7);
    expect(clampGraphLimit("0")).toBe(1);
    expect(clampGraphLimit("99999")).toBe(1000);
  });

  it("解析 worktree list / branches / commits 的原始输出", () => {
    const worktrees = parseWorktreeList(
      [
        "worktree /repo",
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /repo/.worktrees/one",
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/feat/one",
        "",
        "worktree /tmp/detached",
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
      ].join("\n"),
    );
    expect(worktrees).toHaveLength(3);
    expect(worktrees[0]).toEqual({
      path: "/repo",
      branch: "main",
      head: "1111111111111111111111111111111111111111",
      detached: false,
    });
    expect(worktrees[1]?.branch).toBe("feat/one");
    expect(worktrees[2]).toMatchObject({ path: "/tmp/detached", branch: null, detached: true });

    const branches = parseBranches(
      ["main\x1f1111111111111111111111111111111111111111\x1f", "feat/x\x1f2222\x1forigin/feat/x"].join("\n"),
    );
    expect(branches).toEqual([
      { name: "main", head: "1111111111111111111111111111111111111111" },
      { name: "feat/x", head: "2222", upstream: "origin/feat/x" },
    ]);

    const commits = parseCommits(
      "aaaa\x1faaaaaaa\x1fbbbb cccc\x1f张三\x1f2026-10-10T00:00:00+08:00\x1f合并 feature\x1fHEAD -> main, tag: v1",
    );
    expect(commits).toEqual([
      {
        sha: "aaaa",
        short: "aaaaaaa",
        parents: ["bbbb", "cccc"],
        author: "张三",
        at: "2026-10-10T00:00:00+08:00",
        subject: "合并 feature",
        refs: ["main", "tag: v1"],
      },
    ]);
  });
});

describe("提交图：真实仓库", () => {
  const repo = makeGraphRepo();

  it("commits / branches / worktrees / graphText 都是真事实", async () => {
    const graph = await readGraph(repo.root, { limit: 50 });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    expect(graph.repoPath).toBe(repo.root);
    expect(graph.limit).toBe(50);
    // graphText 是 git 的原样输出（泳道不自己画），至少有内容且有节点标记。
    expect(graph.graphText).not.toBe("");
    expect(graph.graphText).toContain("*");

    const merge = graph.commits.find((c) => c.sha === repo.mergeSha);
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.subject).toBe("合并 feature");
    expect(merge?.refs).toContain("main");
    expect(graph.commits.some((c) => c.sha === repo.featureSha)).toBe(true);
    expect(graph.commits.some((c) => c.parents.length === 0)).toBe(true); // 初提交没有父

    const names = graph.branches.map((b) => b.name);
    expect(names).toContain("main");
    expect(names).toContain("feature");
    expect(names).toContain("feat/one");
    expect(graph.branches.find((b) => b.name === "main")?.head).toBe(repo.mergeSha);

    const byPath = new Map(graph.worktrees.map((w) => [w.path, w]));
    expect(graph.worktrees).toHaveLength(3);
    expect(byPath.get(repo.root)).toMatchObject({ branch: "main", detached: false, head: repo.mergeSha });
    expect(byPath.get(repo.wtOne)).toMatchObject({
      branch: "feat/one",
      detached: false,
      head: repo.mergeSha,
    });
    expect(byPath.get(repo.wtTwo)).toMatchObject({ branch: null, detached: true });
  });

  it("limit 真的把提交数压住（commits 与 graphText 同源）", async () => {
    const graph = await readGraph(repo.root, { limit: 2 });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.limit).toBe(2);
    expect(graph.commits).toHaveLength(2);
    // graphText 与 commits 同源：节点行数一致（合并还会多出 `|\` 这类连接线，所以按含 `*` 的行数）。
    expect(graph.graphText.split("\n").filter((l) => l.includes("*"))).toHaveLength(2);
    // 分支与 worktree 不受 limit 影响：它们是实况，不是历史。
    expect(graph.worktrees).toHaveLength(3);
    expect(graph.branches.length).toBeGreaterThanOrEqual(3);
  });

  it("卡片↔worktree 映射：先按路径，再按分支名兜底；没 worktree 的卡片不参与", async () => {
    const graph = await readGraph(repo.root, { limit: 5 });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;

    const byPath: Card = {
      ...emptyCard("c1", AT),
      title: "卡片一",
      state: "working",
      worktree: { path: repo.wtOne, branch: "feat/one", source: "flowcard" },
    };
    // 路径故意写错（比如卡片记的是老路径），靠分支名兜底也应当命中。
    const byBranch: Card = {
      ...emptyCard("c2", AT),
      title: "卡片二",
      state: "review",
      worktree: { path: "/gone/away", branch: "main", source: "harness" },
    };
    const noWorktree: Card = { ...emptyCard("c3", AT), title: "没 worktree" };

    const mapped = mapCardsToWorktrees(graph.worktrees, [byPath, byBranch, noWorktree]);
    expect(mapped.cards.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(mapped.cards[0]).toMatchObject({ branch: "feat/one", worktreePath: repo.wtOne });
    expect(mapped.worktrees.find((w) => w.path === repo.wtOne)).toMatchObject({
      cardId: "c1",
      cardTitle: "卡片一",
      cardState: "working",
    });
    expect(mapped.worktrees.find((w) => w.path === repo.root)).toMatchObject({
      cardId: "c2",
      cardState: "review",
    });
    // detached 的 worktree（没有分支名）谁也匹配不上，就当它没卡片。
    expect(mapped.worktrees.find((w) => w.path === repo.wtTwo)?.cardId).toBeUndefined();
  });

  it("readGraph 直接把卡片叠上去（端点就是这么用的）", async () => {
    const card: Card = {
      ...emptyCard("c1", AT),
      title: "卡片一",
      state: "working",
      worktree: { path: repo.wtOne, branch: "feat/one", source: "flowcard" },
    };
    const graph = await readGraph(repo.root, { limit: 3, cards: [card] });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.cards).toHaveLength(1);
    expect(graph.worktrees.find((w) => w.path === repo.wtOne)?.cardId).toBe("c1");
  });
});

describe("提交图：错误路径", () => {
  it("不是仓库 / git 不在：GIT_FAILED 带原因，不抛异常", async () => {
    const notRepo = mkdtempSync(join(tmpdir(), "flowcard-graph-bad-"));
    const broken = await readGraph(notRepo);
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.error.code).toBe("GIT_FAILED");
      // 报错要说清是哪个目录读不出来。
      expect(broken.error.message).toContain(notRepo);
    }

    const noGit: Run = async () => ({ code: 127, stdout: "", stderr: "git: 未安装", missing: true });
    const missing = await readGraph(notRepo, { run: noGit });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("GIT_FAILED");
      expect(missing.error.message).toContain("跑不动 git");
      // 原因要说清是"命令不在"还是"目录没了"，否则会让人去装 git
      expect(missing.error.message).toMatch(/未安装|目录不存在/);
    }
  });

  it("空仓库（还没有提交）不算错：graphText/commits 为空，worktree 照常回", async () => {
    const empty = mkdtempSync(join(tmpdir(), "flowcard-graph-empty-"));
    execFileSync("git", ["-C", empty, "init", "-q", "-b", "main"], { encoding: "utf8" });
    const graph = await readGraph(empty, { limit: 5 });
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.commits).toEqual([]);
    expect(graph.branches).toEqual([]);
    expect(graph.graphText).toBe("");
    expect(graph.worktrees).toHaveLength(1);
    expect(graph.worktrees[0]?.branch).toBe("main");
  });
});

describe("提交图：HTTP 端点", () => {
  const repo = makeGraphRepo();

  async function harness() {
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-graph-api-")),
      flow: personalFlow,
    });
    const read = await readProject(repo.root);
    if (!read.ok) throw new Error(`临时仓库没读出来：${read.error.message}`);
    const { project } = store.upsertProject(read.project);
    return { app: createApp(store), store, project };
  }

  it("GET /api/projects/:id/graph 回 ok:true + 实况；?limit 生效", async () => {
    const { app, project } = await harness();
    const res = await app.request(`/api/projects/${project.id}/graph?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      limit?: number;
      graphText?: string;
      commits?: unknown[];
      worktrees?: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.limit).toBe(2);
    expect(body.commits).toHaveLength(2);
    expect(body.graphText).toContain("*");
    expect(body.worktrees).toHaveLength(3);
  });

  it("仓库被删（登记之后没了的路径）→ 500 GIT_FAILED，不抛", async () => {
    const gone = mkdtempSync(join(tmpdir(), "flowcard-graph-gone-"));
    execFileSync("git", ["-C", gone, "init", "-q", "-b", "main"], { encoding: "utf8" });
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-graph-gone-data-")),
      flow: personalFlow,
    });
    const read = await readProject(gone);
    if (!read.ok) throw new Error(read.error.message);
    const { project } = store.upsertProject(read.project);
    rmSync(gone, { recursive: true, force: true });

    const res = await createApp(store).request(`/api/projects/${project.id}/graph`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok?: boolean; error?: { code?: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("GIT_FAILED");
  });

  it("项目不存在 / 合成项目 local → 404 且带人话错误", async () => {
    const { app } = await harness();
    for (const id of ["nope", "local"]) {
      const res = await app.request(`/api/projects/${id}/graph`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok?: boolean; error?: { code?: string; message?: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("NOT_FOUND");
      expect(body.error?.message).toContain(id);
    }
  });
});
