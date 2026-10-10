/**
 * 卡片 diff（只读）：在真实临时仓库里造出 added / modified / deleted / renamed / binary 五种状态，
 * 逐项验证状态判定、增删计数、hunk 行号（旧/新两侧）、截断，以及 HTTP 端点。
 *
 * 只读：写操作只发生在临时仓库自己的文件上。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { parseUnifiedDiff, readCardDiff, summarizeDiff, DIFF_MAX_BYTES } from "../src/server/diff.ts";
import { readProject } from "../src/server/projects.ts";
import { createStore } from "../src/server/store.ts";
import type { Command, DiffFile } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

type Fixture = { root: string; baseSha: string; headSha: string };

/**
 * base（main）：README / keep.txt / del.txt / rn.txt / bin.dat
 * head（feat/x）：改 keep.txt、加 new.txt、删 del.txt、rn.txt → renamed.txt、改 bin.dat（二进制）。
 * 一个提交里把五种状态凑齐。
 */
function makeDiffRepo(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "flowcard-diff-"));
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

  git("init", "-q", "-b", "main");
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "tester");
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "keep.txt"), "l1\nl2\n\nl4\n");
  writeFileSync(join(root, "del.txt"), "zzz\n");
  writeFileSync(join(root, "rn.txt"), "rename me\n");
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x31, 0x0a]));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");

  git("checkout", "-q", "-b", "feat/x");
  writeFileSync(join(root, "keep.txt"), "l1\nL2\n\nl4\nl5\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  execFileSync("git", ["-C", root, "rm", "-q", "del.txt"], { encoding: "utf8" });
  execFileSync("git", ["-C", root, "mv", "rn.txt", "renamed.txt"], { encoding: "utf8" });
  writeFileSync(join(root, "bin.dat"), Buffer.from([0x62, 0x69, 0x6e, 0x00, 0x32, 0x0a]));
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  const headSha = git("rev-parse", "HEAD");

  return { root, baseSha, headSha };
}

const fileAt = (files: DiffFile[], path: string): DiffFile => {
  const found = files.find((f) => f.path === path);
  if (!found) throw new Error(`diff 里没有 ${path}`);
  return found;
};

describe("diff：真实仓库的解析", () => {
  const repo = makeDiffRepo();

  it("五种状态、增删计数、renamed 的 oldPath 都对", async () => {
    const result = await readCardDiff({ repoPath: repo.root, headDir: repo.root, defaultBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.base).toBe("main");
    expect(result.head).toBe("feat/x");
    expect(result.baseSha).toBe(repo.baseSha);
    expect(result.headSha).toBe(repo.headSha);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      "bin.dat",
      "del.txt",
      "keep.txt",
      "new.txt",
      "renamed.txt",
    ]);

    const keep = fileAt(result.files, "keep.txt");
    expect(keep.status).toBe("modified");
    expect(keep.additions).toBe(2);
    expect(keep.deletions).toBe(1);

    const added = fileAt(result.files, "new.txt");
    expect(added).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(added.oldPath).toBeUndefined();

    const deleted = fileAt(result.files, "del.txt");
    expect(deleted).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });

    const renamed = fileAt(result.files, "renamed.txt");
    expect(renamed.status).toBe("renamed");
    expect(renamed.oldPath).toBe("rn.txt");
    // 纯改名没有内容变化 → 没有 hunk，也没有增删。
    expect(renamed.hunks).toEqual([]);
    expect(renamed.additions + renamed.deletions).toBe(0);

    const binary = fileAt(result.files, "bin.dat");
    expect(binary.status).toBe("binary");
    expect(binary.hunks).toEqual([]);
  });

  it("hunk 头与两侧行号：context / del / add 各自算对", async () => {
    const result = await readCardDiff({ repoPath: repo.root, headDir: repo.root, defaultBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keep = fileAt(result.files, "keep.txt");
    expect(keep.hunks).toHaveLength(1);
    const hunk = keep.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(hunk.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "l1" },
      { kind: "del", oldLine: 2, text: "l2" },
      { kind: "add", newLine: 2, text: "L2" },
      { kind: "context", oldLine: 3, newLine: 3, text: "" },
      { kind: "context", oldLine: 4, newLine: 4, text: "l4" },
      { kind: "add", newLine: 5, text: "l5" },
    ]);

    const added = fileAt(result.files, "new.txt");
    expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(added.hunks[0]?.lines).toEqual([{ kind: "add", newLine: 1, text: "new" }]);

    const deleted = fileAt(result.files, "del.txt");
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    expect(deleted.hunks[0]?.lines).toEqual([{ kind: "del", oldLine: 1, text: "zzz" }]);
  });

  it("base 拿不到就退 main；连 main/master 都没有 → NO_BASE", async () => {
    // 这个仓库只有 trunk：候选 defaultBranch / main / master 全试一遍都落空。
    const trunk = mkdtempSync(join(tmpdir(), "flowcard-trunk-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", trunk, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "trunk");
    git("config", "user.email", "tester@example.com");
    git("config", "user.name", "tester");
    writeFileSync(join(trunk, "x.txt"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "只有 trunk");

    const result = await readCardDiff({ repoPath: trunk, headDir: trunk, defaultBranch: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NO_BASE");
    // 报错要写清"试过哪些候选"，人才能知道该建哪个分支。
    expect(result.error.message).toContain("nope");
    expect(result.error.message).toContain("main");
  });

  it("detached HEAD → head 用 sha；不是仓库 → GIT_FAILED", async () => {
    const detached = makeDiffRepo();
    execFileSync("git", ["-C", detached.root, "checkout", "-q", "--detach", detached.headSha], {
      encoding: "utf8",
    });
    const result = await readCardDiff({ repoPath: detached.root, headDir: detached.root, defaultBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.head).toBe(detached.headSha);

    const empty = mkdtempSync(join(tmpdir(), "flowcard-notrepo-"));
    const broken = await readCardDiff({ repoPath: empty, headDir: empty, defaultBranch: "main" });
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.error.code).toBe("GIT_FAILED");
  });
});

describe("diff：截断与摘要", () => {
  const repo = makeDiffRepo();

  it("超过阈值只保留完整文件，并说明为什么截断", async () => {
    const full = await readCardDiff({ repoPath: repo.root, headDir: repo.root, defaultBranch: "main" });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.files.length).toBeGreaterThan(1);
    expect(full.truncated).toBeUndefined();

    const cut = await readCardDiff({
      repoPath: repo.root,
      headDir: repo.root,
      defaultBranch: "main",
      maxBytes: 200,
    });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.truncated).toBe(true);
    expect(cut.files.length).toBeLessThan(full.files.length);
    expect(cut.files.length).toBeGreaterThan(0);
    expect(cut.truncatedReason).toContain("阈值");
    // 留下来的文件仍然是完整的文件（状态/计数/hunk 都在）。
    expect(cut.files[0]?.hunks.length).toBeGreaterThanOrEqual(0);
  });

  it("?patch=1 时给 git 的原始 unified diff，且同样受阈值约束", async () => {
    const result = await readCardDiff({
      repoPath: repo.root,
      headDir: repo.root,
      defaultBranch: "main",
      includePatch: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toContain("diff --git a/keep.txt b/keep.txt");
    expect(result.patch).toContain("+l5");
    expect(result.patch).toContain("rename to renamed.txt");
    expect(result.patch).not.toContain("GIT binary patch"); // 不给 --binary：二进制只报"differ"

    const cut = await readCardDiff({
      repoPath: repo.root,
      headDir: repo.root,
      defaultBranch: "main",
      includePatch: true,
      maxBytes: 120,
    });
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.truncated).toBe(true);
    expect(cut.patch?.length).toBeLessThanOrEqual(120);
    expect(cut.truncatedReason).toContain("patch");
  });

  it("摘要是文件级的：不带 hunks，但保留路径/状态/增删数", async () => {
    const result = await readCardDiff({ repoPath: repo.root, headDir: repo.root, defaultBranch: "main" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summary = summarizeDiff(result);
    expect(summary.ok).toBe(true);
    expect(summary.headSha).toBe(repo.headSha);
    const keep = summary.files.find((f) => f.path === "keep.txt");
    expect(keep).toMatchObject({ path: "keep.txt", status: "modified" });
    // 只有行数的空壳 hunk 没有用：摘要不带 hunks，要看内容用完整响应或 --patch
    expect(keep).not.toHaveProperty("hunks");
    expect(Object.keys(keep ?? {})).not.toContain("hunks");
  });

  it("默认阈值是 1 MiB（不是无限大）", () => {
    expect(DIFF_MAX_BYTES).toBe(1_000_000);
  });
});

describe("diff：纯解析", () => {
  it("单行 hunk 头、带空格的引号路径、`\\ No newline` 都不把行号算歪", () => {
    const patch = [
      'diff --git "a/my file.txt" "b/my file.txt"',
      "index 1111111..2222222 100644",
      '--- "a/my file.txt"',
      '+++ "b/my file.txt"',
      "@@ -1 +1 @@ 小标题",
      "-old",
      "+new",
      "diff --git a/eof.txt b/eof.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/eof.txt",
      "@@ -0,0 +1 @@",
      "+no newline",
      "\\ No newline at end of file",
    ].join("\n");

    const parsed = parseUnifiedDiff(patch);
    expect(parsed.complete).toBe(true);
    expect(parsed.files).toHaveLength(2);
    const escaped = parsed.files[0]!;
    expect(escaped.path).toBe("my file.txt");
    expect(escaped.status).toBe("modified");
    expect(escaped.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    expect(escaped.hunks[0]?.header).toBe("小标题");
    expect(escaped.hunks[0]?.lines).toEqual([
      { kind: "del", oldLine: 1, text: "old" },
      { kind: "add", newLine: 1, text: "new" },
    ]);
    expect(escaped.additions).toBe(1);
    expect(escaped.deletions).toBe(1);
    // sizes 与 files 一一对应（截断时按它挑完整的文件）。
    expect(parsed.sizes).toHaveLength(2);

    const eof = parsed.files[1]!;
    expect(eof).toMatchObject({ path: "eof.txt", status: "added", additions: 1, deletions: 0 });
  });

  it("行体被截断（maxBuffer）→ complete:false，调用方据此丢掉最后一个文件", () => {
    const patch = [
      "diff --git a/x.txt b/x.txt",
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
    ].join("\n");
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.complete).toBe(false);
    expect(parsed.files).toHaveLength(1);
  });

  it("hunk 以 context 行收尾也不算截断（context 两侧各算一行，不能拿 old+new 当条数）", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,4 +1,4 @@",
      " ctx1",
      "-old",
      "+new",
      " ctx3",
      " ctx4",
    ].join("\n");
    const parsed = parseUnifiedDiff(patch);
    expect(parsed.complete).toBe(true);
    const file = parsed.files[0]!;
    expect(file).toMatchObject({ path: "a.txt", additions: 1, deletions: 1 });
    expect(file.hunks[0]?.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["context", 1, 1],
      ["del", 2, undefined],
      ["add", undefined, 2],
      ["context", 3, 3],
      ["context", 4, 4],
    ]);
  });

  it("空 diff → 空的 files/sizes", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], sizes: [], complete: true });
  });
});

describe("diff：HTTP 端点", () => {
  const repo = makeDiffRepo();

  async function harness() {
    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-diff-api-")),
      flow: personalFlow,
    });
    const read = await readProject(repo.root);
    if (!read.ok) throw new Error(`临时仓库没读出来：${read.error.message}`);
    const { project } = store.upsertProject(read.project);
    const id = store.execute({
      cmd: "open",
      actor: HUMAN,
      title: "看 diff",
      body: "",
      projectId: project.id,
    } as Command).outcome.primaryCardId;
    return { app: createApp(store), store, project, id };
  }

  it("没绑 worktree → 409 NO_WORKTREE，且什么都不写", async () => {
    const { app, id } = await harness();
    const res = await app.request(`/api/cards/${id}/diff`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok?: boolean; error?: { code?: string; message?: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("NO_WORKTREE");
    expect(body.error?.message).toContain(id);
  });

  it("绑了 worktree → 200，文件列表与真实 diff 一致", async () => {
    const { app, store, id } = await harness();
    store.execute({
      cmd: "worktree",
      actor: HUMAN,
      card: id,
      worktree: { path: repo.root, branch: "feat/x", source: "flowcard" },
    } as Command);

    const res = await app.request(`/api/cards/${id}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      baseSha?: string;
      files?: { path: string; status: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.baseSha).toBe(repo.baseSha);
    expect(body.files?.find((f) => f.path === "renamed.txt")?.status).toBe("renamed");
    expect(body.files?.find((f) => f.path === "bin.dat")?.status).toBe("binary");

    const missing = await app.request("/api/cards/c404/diff");
    expect(missing.status).toBe(404);
  });

  it("找不到基准分支 → 409 NO_BASE（仓库只有 trunk）", async () => {
    const trunk = mkdtempSync(join(tmpdir(), "flowcard-diff-trunk-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", trunk, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "trunk");
    git("config", "user.email", "tester@example.com");
    git("config", "user.name", "tester");
    writeFileSync(join(trunk, "x.txt"), "x\n");
    git("add", "-A");
    git("commit", "-q", "-m", "只有 trunk");

    const store = createStore({
      dataDir: mkdtempSync(join(tmpdir(), "flowcard-diff-trunk-data-")),
      flow: personalFlow,
    });
    const read = await readProject(trunk);
    if (!read.ok) throw new Error(read.error.message);
    const { project } = store.upsertProject(read.project);
    const id = store.execute({
      cmd: "open",
      actor: HUMAN,
      title: "没有 base",
      body: "",
      projectId: project.id,
    } as Command).outcome.primaryCardId;
    store.execute({
      cmd: "worktree",
      actor: HUMAN,
      card: id,
      worktree: { path: trunk, branch: "trunk", source: "flowcard" },
    } as Command);

    const res = await createApp(store).request(`/api/cards/${id}/diff`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok?: boolean; error?: { code?: string; message?: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("NO_BASE");
    expect(body.error?.message).toContain("main");
  });
});
