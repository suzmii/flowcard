/**
 * 项目层（看板 Metadata）：
 *   - `readProject` 读真实临时 git 仓库（只读子命令，remote 用本地配置造）；
 *   - 登记幂等 / 路径解析（含嵌套仓库取最具体）；
 *   - 卡片归属（open 带不带 projectId、老卡片投影成 local、spawn 继承）；
 *   - 自动标题规则；
 *   - 投影版本 +1 触发 rebuild。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { DERIVED_TITLE_MAX, UNTITLED, deriveTitle } from "../src/server/engine.ts";
import { deriveIssueBase, projectIdFor, readProject } from "../src/server/projects.ts";
import { createApp } from "../src/server/app.ts";
import { createStore, type Store } from "../src/server/store.ts";
import { resolveUserPath } from "../src/shared/paths.ts";
import { LOCAL_PROJECT_ID, type Command } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

/**
 * 临时 git 仓库。remote 只用 `remote add` 写本地配置 + 手工造 `refs/remotes/origin/*`，
 * **不联网、不 fetch、不 push** —— 元数据本来就是从本地 ref 读出来的。
 */
function makeRepo(
  name: string,
  opts: { remote?: string; branch?: string; originHead?: boolean; dirty?: boolean } = {},
): { root: string; sha: string } {
  const root = join(mkdtempSync(join(tmpdir(), "flowcard-repo-")), name);
  mkdirSync(join(root, "sub"), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

  git("init", "-q", "-b", opts.branch ?? "main");
  git("config", "user.email", "tester@example.com");
  git("config", "user.name", "tester");
  writeFileSync(join(root, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-q", "-m", "初提交：README");
  if (opts.remote) git("remote", "add", "origin", opts.remote);
  if (opts.originHead) {
    const sha = git("rev-parse", "HEAD").trim();
    git("update-ref", `refs/remotes/origin/${opts.branch ?? "main"}`, sha);
    git("symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${opts.branch ?? "main"}`);
  }
  if (opts.dirty) writeFileSync(join(root, "dirty.txt"), "x\n");
  return { root, sha: git("rev-parse", "HEAD").trim() };
}

function freshStore(dataDir = mkdtempSync(join(tmpdir(), "flowcard-proj-"))) {
  return { store: createStore({ dataDir, flow: personalFlow }), dataDir };
}

async function addProject(store: Store, path: string) {
  const read = await readProject(path);
  if (!read.ok) throw new Error(`临时仓库没读出来：${read.error.message}`);
  return store.upsertProject(read.project);
}

const at = (n: number): string => new Date(Date.parse("2026-10-10T00:00:00.000Z") + n * 1000).toISOString();

describe("readProject 读 git 元数据", () => {
  it("读出根路径 / remote / 分支 / 默认分支 / 最近提交 / 脏文件数", async () => {
    const repo = makeRepo("alpha", {
      remote: "https://git.example.com/x/alpha.git",
      originHead: true,
      dirty: true,
    });
    const read = await readProject(repo.root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const project = read.project;
    expect(project.path).toBe(repo.root);
    expect(project.name).toBe("alpha");
    expect(project.remote).toBe("https://git.example.com/x/alpha.git");
    expect(project.headBranch).toBe("main");
    expect(project.defaultBranch).toBe("main");
    expect(project.lastCommit?.sha).toBe(repo.sha);
    expect(project.lastCommit?.subject).toBe("初提交：README");
    expect(Number.isFinite(Date.parse(project.lastCommit?.at ?? ""))).toBe(true);
    // README.md 已提交，只有 dirty.txt 没提交 → 1 行
    expect(project.dirtyFiles).toBe(1);
    expect(project.virtual).toBeUndefined();
    expect(project.addedAt).toBe(project.lastSeenAt);
  });

  it("干净仓库 dirtyFiles = 0；给子目录也解析到同一个仓库根", async () => {
    const repo = makeRepo("beta");
    const fromSub = await readProject(join(repo.root, "sub"));
    expect(fromSub.ok).toBe(true);
    if (!fromSub.ok) return;
    expect(fromSub.project.path).toBe(repo.root);
    expect(fromSub.project.dirtyFiles).toBe(0);
    // 没有 remote：拿不到 origin/HEAD，就回退到存在的 main
    expect(fromSub.project.remote).toBeUndefined();
    expect(fromSub.project.defaultBranch).toBe("main");
    expect(projectIdFor(repo.root)).toBe(fromSub.project.id);
  });

  it("detached HEAD 不写成分支；没有 main/master 时不给默认分支", async () => {
    const repo = makeRepo("gamma", { branch: "trunk" });
    execFileSync("git", ["-C", repo.root, "checkout", "-q", "--detach", repo.sha], { encoding: "utf8" });
    const read = await readProject(repo.root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.project.headBranch).toBeUndefined();
    expect(read.project.defaultBranch).toBeUndefined();
  });

  it("不是 git 仓库 → ok:false 且给出人话提示", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowcard-norepo-"));
    const read = await readProject(dir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("NOT_A_REPO");
    expect(read.error.message).toContain(dir);
    expect(read.error.hint).toContain("git");
  });
});

describe("projectIdFor 由仓库根路径派生", () => {
  it("同路径稳定、同名不同路径不同、带上目录名", () => {
    const a = projectIdFor("/home/u/work/flowcard");
    expect(a).toBe(projectIdFor("/home/u/work/flowcard"));
    expect(a).toBe(projectIdFor("/home/u/work/flowcard/"));
    expect(a.startsWith("flowcard-")).toBe(true);
    expect(a).not.toBe(projectIdFor("/home/u/other/flowcard"));
    expect(a).not.toBe(projectIdFor("/home/u/work/flowcard-lite"));
  });

  it("resolveUserPath：~ 展开、相对路径按调用方 cwd 解析、折叠斜杠", () => {
    expect(resolveUserPath("~/repo", "/base")).toBe(`${homedir()}/repo`);
    expect(resolveUserPath("~", "/base")).toBe(homedir());
    expect(resolveUserPath("repo/sub/", "/base")).toBe("/base/repo/sub");
    expect(resolveUserPath("/abs//repo/", "/base")).toBe("/abs/repo");
  });
});

describe("项目登记与路径解析", () => {
  it("同一 path 两次 add 幂等：第二次 created:false 且保留 addedAt、刷新 lastSeenAt", async () => {
    const { store } = freshStore();
    const repo = makeRepo("idem");

    const first = await addProject(store, repo.root);
    expect(first.created).toBe(true);
    const again = await addProject(store, repo.root);
    expect(again.created).toBe(false);
    expect(again.project.id).toBe(first.project.id);
    expect(again.project.addedAt).toBe(first.project.addedAt);
    expect(Date.parse(again.project.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(first.project.addedAt));

    // 只有 1 个真实项目 + 合成项目 local
    expect(store.listProjects()).toHaveLength(2);
    expect(store.listProjects().filter((p) => !p.virtual).map((p) => p.id)).toEqual([first.project.id]);
    store.close();
  });

  it("listProjects 恒含合成项目 local（virtual、名字「未归属」）", () => {
    const { store } = freshStore();
    const local = store.getProject(LOCAL_PROJECT_ID);
    expect(local?.virtual).toBe(true);
    expect(local?.name).toBe("未归属");
    expect(local?.path).toBe("");
    expect(store.listProjects().at(-1)?.id).toBe(LOCAL_PROJECT_ID);
    store.close();
  });

  it("projectForPath：子目录命中、嵌套仓库取最具体的、外面一律不命中（local 不参与）", async () => {
    const { store } = freshStore();
    const outer = makeRepo("outer");
    const nested = makeRepo("outer-nested");
    const outerProject = (await addProject(store, outer.root)).project;

    const nestedRoot = join(outer.root, "sub", "nested");
    mkdirSync(nestedRoot, { recursive: true });
    execFileSync("git", ["-C", nestedRoot, "init", "-q", "-b", "main"], { encoding: "utf8" });
    const nestedProject = (await addProject(store, nestedRoot)).project;

    expect(store.projectForPath(outer.root)?.id).toBe(outerProject.id);
    expect(store.projectForPath(join(outer.root, "sub"))?.id).toBe(outerProject.id);
    expect(store.projectForPath(nestedRoot)?.id).toBe(nestedProject.id);
    expect(store.projectForPath(join(nestedRoot, "x"))?.id).toBe(nestedProject.id);
    expect(store.projectForPath("/tmp")).toBeUndefined();
    // 前缀相同但不同目录：/a/b 不匹配 /a/bc
    expect(store.projectForPath(`${outer.root}c`)).toBeUndefined();
    store.close();
  });
});

describe("卡片归属项目", () => {
  it("open 带 projectId：卡片记 projectId，并且 repoPath 由项目解析出来", async () => {
    const { store } = freshStore();
    const repo = makeRepo("cardproj");
    const project = (await addProject(store, repo.root)).project;

    const result = store.execute(
      { cmd: "open", actor: HUMAN, title: "带项目开卡", body: "", projectId: project.id },
      at(0),
    );
    const card = result.card!;
    expect(card.projectId).toBe(project.id);
    expect(card.repoPath).toBe(repo.root);
    // 派生结果写进事件 → 历史稳定
    const opened = store.listEvents().find((e) => e.type === "card.opened");
    expect(opened?.payload.projectId).toBe(project.id);
    store.close();
  });

  it("open 不带 projectId 落 local（且没有 repoPath）", () => {
    const { store } = freshStore();
    const card = store.execute({ cmd: "open", actor: HUMAN, body: "随便写点" }, at(0)).card!;
    expect(card.projectId).toBe(LOCAL_PROJECT_ID);
    expect(card.repoPath).toBeUndefined();
    store.close();
  });

  it("open 给了不存在的 projectId → NOT_FOUND，什么都不写", () => {
    const { store } = freshStore();
    const result = store.execute(
      { cmd: "open", actor: HUMAN, body: "x", projectId: "nope-1234" },
      at(0),
    );
    expect(result.outcome.rejection?.code).toBe("NOT_FOUND");
    expect(result.inserted).toHaveLength(0);
    expect(store.listCards()).toHaveLength(0);
    store.close();
  });

  it("spawn 的子卡继承父卡的项目", async () => {
    const { store } = freshStore();
    const repo = makeRepo("spawnproj");
    const project = (await addProject(store, repo.root)).project;
    const parent = store.execute(
      { cmd: "open", actor: HUMAN, title: "父卡", body: "", projectId: project.id },
      at(0),
    ).card!;

    const child = store.execute(
      { cmd: "spawn", actor: HUMAN, card: parent.id, title: "子卡", body: "" },
      at(1),
    ).card!;
    expect(child.projectId).toBe(project.id);
    expect(child.repoPath).toBe(repo.root);
    store.close();
  });

  it("老卡片（事件里没有 projectId）投影成 local，投影版本 +1 时自动 rebuild", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "flowcard-oldcard-"));
    const first = freshStore(dataDir).store;
    const id = first.execute({ cmd: "open", actor: HUMAN, title: "老卡", body: "" }, at(0)).card!.id;
    first.close();

    // 造出"升级前"的样子：投影里没有 projectId，且投影版本号还是上一版
    const db = new DatabaseSync(join(dataDir, "flowcard.sqlite"));
    const before =
      (db.prepare("SELECT card FROM cards WHERE id = ?").get(id) as { card: string } | undefined)?.card ?? "";
    expect(before).toContain('"projectId":"local"');
    db.exec(`UPDATE cards SET card = REPLACE(card, '"projectId":"local",', '')`);
    db.exec("UPDATE meta SET value = '2' WHERE key = 'projection_version'");
    db.close();

    // 启动时版本不一致 → 从事件重放（自愈），老卡片落到合成项目 local
    const second = createStore({ dataDir, flow: personalFlow });
    const card = second.getCard(id);
    expect(card?.projectId).toBe(LOCAL_PROJECT_ID);
    expect(card?.title).toBe("老卡");
    second.close();
  });

  it("open 的 title 缺省时把派生结果写进事件（不是每次读卡都重算）", () => {
    const { store } = freshStore();
    const cmd: Command = { cmd: "open", actor: HUMAN, body: "## 先做登录\n\n细节不重要" };
    const card = store.execute(cmd, at(0)).card!;
    expect(card.title).toBe("先做登录");
    const opened = store.listEvents().find((e) => e.type === "card.opened");
    expect(opened?.payload.title).toBe("先做登录");

    // 同一条命令重发：幂等（指纹按派生后的标题算），不会开出第二张卡，而且要指回原来那张
    const again = store.execute(cmd, at(1));
    expect(again.inserted).toHaveLength(0);
    expect(again.card?.id).toBe(card.id);
    expect(store.listCards()).toHaveLength(1);
    store.close();
  });
});

describe("自动标题（服务端派生）", () => {
  it("取第一个有文本的段落，并去掉 markdown 语法", () => {
    expect(deriveTitle("")).toBe(UNTITLED);
    expect(deriveTitle("   \n\n  ")).toBe(UNTITLED);
    expect(deriveTitle("## 修好登录\n\n后面还有一段")).toBe("修好登录");
    expect(deriveTitle("> 引用里的话")).toBe("引用里的话");
    expect(deriveTitle("- 列表项一\n- 列表项二")).toBe("列表项一 列表项二");
    expect(deriveTitle("**粗体** 与 `代码`")).toBe("粗体 与 代码");
    expect(deriveTitle("[标题](https://x/y) 后面")).toBe("标题 后面");
    expect(deriveTitle("多   个    空白")).toBe("多 个 空白");
    // `#42` 不是标题标记（# 后没有空格）→ issue 号留着
    expect(deriveTitle("#42 修登录")).toBe("#42 修登录");
  });

  it("纯图正文 → 跳过没文字的段落；整段都是图 → 未命名卡片", () => {
    expect(deriveTitle("![截图](/api/attachments/abc123)")).toBe(UNTITLED);
    expect(deriveTitle("![a](/x.png)\n\n真正的正文在第一段之后")).toBe("真正的正文在第一段之后");
  });

  it("超长按 40 个字符截断并加省略号（中文按 1 计、emoji 不切半个）", () => {
    const long = "汉".repeat(50);
    expect(deriveTitle(long)).toBe(`${"汉".repeat(DERIVED_TITLE_MAX)}…`);

    const exact = "汉".repeat(DERIVED_TITLE_MAX);
    expect(deriveTitle(exact)).toBe(exact);

    const emoji = `${"🙂".repeat(DERIVED_TITLE_MAX)}🙂`;
    expect(deriveTitle(emoji)).toBe(`${"🙂".repeat(DERIVED_TITLE_MAX)}…`);
  });
});

describe("deriveIssueBase 从 remote 派生 Issue 基址", () => {
  it("scp 形态（git@host:path）→ scheme 取 https，.git 去掉、多段 path 保留", () => {
    expect(deriveIssueBase("git@gitea.example.com:git/owner/repo.git")).toEqual({
      issueRepo: "git/owner/repo",
      issueUrlTemplate: "https://gitea.example.com/git/owner/repo/issues/{number}",
    });
    expect(deriveIssueBase("git@github.com:owner/repo")).toEqual({
      issueRepo: "owner/repo",
      issueUrlTemplate: "https://github.com/owner/repo/issues/{number}",
    });
  });

  it("ssh:// 形态：scheme 原样，端口带上", () => {
    expect(deriveIssueBase("ssh://git@example.com/owner/repo.git")).toEqual({
      issueRepo: "owner/repo",
      issueUrlTemplate: "ssh://example.com/owner/repo/issues/{number}",
    });
    expect(deriveIssueBase("ssh://git@example.com:2222/o/r.git")).toEqual({
      issueRepo: "o/r",
      issueUrlTemplate: "ssh://example.com:2222/o/r/issues/{number}",
    });
  });

  it("http(s):// 形态：scheme 原样（http 保持 http）、结尾斜杠去掉、Gitea 多段路径整段保留", () => {
    expect(deriveIssueBase("https://gitea.example.com/git/owner/repo")).toEqual({
      issueRepo: "git/owner/repo",
      issueUrlTemplate: "https://gitea.example.com/git/owner/repo/issues/{number}",
    });
    expect(deriveIssueBase("http://localhost:3000/o/r.git/")).toEqual({
      issueRepo: "o/r",
      issueUrlTemplate: "http://localhost:3000/o/r/issues/{number}",
    });
  });

  it("认不出就两条都空（不瞎猜）", () => {
    expect(deriveIssueBase(undefined)).toEqual({});
    expect(deriveIssueBase("")).toEqual({});
    expect(deriveIssueBase("   ")).toEqual({});
    expect(deriveIssueBase("/home/u/repo.git")).toEqual({});
    expect(deriveIssueBase("file:///srv/git/r.git")).toEqual({});
    expect(deriveIssueBase("git://host/o/r.git")).toEqual({});
    expect(deriveIssueBase("git@host:repo.git")).toEqual({}); // 只有一段 path
    expect(deriveIssueBase("C:\\work\\repo.git")).toEqual({}); // Windows 盘符不是主机
  });
});

describe("项目带 Issue 基址", () => {
  it("readProject 按 remote 派生；没有 remote 就不给（不瞎猜）", async () => {
    const withRemote = await readProject(
      makeRepo("issuebase", { remote: "git@git.example.com:team/issuebase.git" }).root,
    );
    expect(withRemote.ok).toBe(true);
    if (!withRemote.ok) return;
    expect(withRemote.project.issueRepo).toBe("team/issuebase");
    expect(withRemote.project.issueUrlTemplate).toBe(
      "https://git.example.com/team/issuebase/issues/{number}",
    );

    const without = await readProject(makeRepo("issuebase-none").root);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.project.issueRepo).toBeUndefined();
    expect(without.project.issueUrlTemplate).toBeUndefined();
  });

  it("登记时落库（JSON 里带字段）；POST /api/projects 不传按 remote 派生、传了就覆盖", async () => {
    const { store } = freshStore();
    const repo = makeRepo("override", { remote: "https://git.example.com/team/override.git" });
    const app = createApp(store);
    const postProject = async (body: unknown): Promise<{ issueRepo?: string; issueUrlTemplate?: string }> => {
      const res = await app.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { project: { issueRepo?: string; issueUrlTemplate?: string } };
      return data.project;
    };

    const derived = await postProject({ path: repo.root });
    expect(derived.issueRepo).toBe("team/override");
    expect(derived.issueUrlTemplate).toBe("https://git.example.com/team/override/issues/{number}");
    expect(store.projectForPath(repo.root)?.issueRepo).toBe("team/override");

    const overridden = await postProject({
      path: repo.root,
      issueRepo: "me/mine",
      issueUrlTemplate: "https://my.host/me/mine/issues/{number}",
    });
    expect(overridden.issueRepo).toBe("me/mine");
    expect(overridden.issueUrlTemplate).toBe("https://my.host/me/mine/issues/{number}");
    // 覆盖不产生第二个项目
    expect(store.listProjects().filter((p) => !p.virtual)).toHaveLength(1);
    store.close();
  });
});
