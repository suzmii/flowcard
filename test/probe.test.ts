/**
 * 探测的单测：git 部分用**真实临时仓库**（git init + commit + worktree add + 建分支），
 * gh/tea 部分注入假的命令输出（不依赖真的 gh/tea，也不联网）。
 * 全程只读 git：`git config` 只写临时仓库自己的 config，不 fetch/push。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ciFromGhRollup,
  classifyWorktree,
  countLines,
  defaultRun,
  firstLine,
  ghArgv,
  ghPrToRef,
  gitArgv,
  isInside,
  parseRemoteUrl,
  pickTeaPull,
  probe,
  probeCommands,
  probeGit,
  probeOrder,
  probePr,
  slugFromPrUrl,
  teaArgv,
  teaPullToRef,
  type Remote,
  type Run,
  type RunOutcome,
} from "../src/server/probe.ts";

// ---------------------------------------------------------------- 纯解析

describe("远程 URL / 归属", () => {
  it("解析 https（含 Gitea 根路径前缀）与 .git 后缀", () => {
    const r = parseRemoteUrl("https://gitea.example.com/git/owner/repo.git");
    expect(r).toMatchObject({
      host: "gitea.example.com",
      owner: "owner",
      repo: "repo",
      slug: "owner/repo",
      forge: "gitea",
    });
  });

  it("解析 scp 形态与 ssh://（含端口），并认出 github.com", () => {
    expect(parseRemoteUrl("git@github.com:acme/demo.git")).toMatchObject({
      host: "github.com",
      slug: "acme/demo",
      forge: "github",
    });
    expect(parseRemoteUrl("ssh://git@git.example.com:2222/team/proj.git")).toMatchObject({
      host: "git.example.com",
      slug: "team/proj",
      forge: "gitea",
    });
  });

  it("拿不到归属就返回 null，不猜", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("https://github.com/onlyowner")).toBeNull();
    expect(slugFromPrUrl("https://github.com/acme/demo/pull/42")).toBe("acme/demo");
    expect(slugFromPrUrl("https://github.com/acme/demo")).toBeNull();
  });

  it("按 forge 决定探测顺序（另一个兜底）", () => {
    expect(probeOrder("github")).toEqual(["gh", "tea"]);
    expect(probeOrder("gitea")).toEqual(["tea", "gh"]);
    expect(probeOrder("unknown")).toEqual(["tea", "gh"]);
  });
});

describe("worktree 判定（纯）", () => {
  it("主仓库不是 worktree（toplevel == common-dir 的父目录）", () => {
    const v = classifyWorktree({
      toplevel: "/w/proj",
      gitDir: "/w/proj/.git",
      commonDir: "/w/proj/.git",
      branch: "main",
    });
    expect(v?.isWorktree).toBe(false);
    expect(v?.mainRoot).toBe("/w/proj");
    expect(v?.worktree).toMatchObject({ path: "/w/proj", branch: "main" });
  });

  it("linked worktree 认出来；.worktrees/ 下判为 flowcard 建的", () => {
    const v = classifyWorktree({
      toplevel: "/w/proj/.worktrees/card-1",
      gitDir: "/w/proj/.git/worktrees/card-1",
      commonDir: "/w/proj/.git",
      branch: "feat/card-1",
    });
    expect(v?.isWorktree).toBe(true);
    expect(v?.mainRoot).toBe("/w/proj");
    expect(v?.underWorktreesDir).toBe(true);
    expect(v?.worktree).toMatchObject({ path: "/w/proj/.worktrees/card-1", branch: "feat/card-1", source: "flowcard" });
  });

  it("约定目录之外的 worktree 仍接受（source 推断 harness）；分支 HEAD 显示 detached", () => {
    const v = classifyWorktree({
      toplevel: "/w/other/wt",
      gitDir: "/w/proj/.git/worktrees/wt",
      commonDir: "/w/proj/.git",
      branch: "HEAD",
    });
    expect(v?.isWorktree).toBe(true);
    expect(v?.underWorktreesDir).toBe(false);
    expect(v?.worktree).toMatchObject({ branch: "detached", source: "harness" });
  });

  it("路径前缀按段比较：/w/xy 不算在 /w/x 里", () => {
    expect(isInside("/w/x/sub", "/w/x")).toBe(true);
    expect(isInside("/w/x", "/w/x")).toBe(true);
    expect(isInside("/w/xy", "/w/x")).toBe(false);
  });
});

describe("PR / CI 解析（纯）", () => {
  const remote: Remote = {
    raw: "https://github.com/acme/demo.git",
    host: "github.com",
    owner: "acme",
    repo: "demo",
    slug: "acme/demo",
    forge: "github",
  };

  it("gh 的 statusCheckRollup → pass / pending / fail / 无 CI", () => {
    expect(ciFromGhRollup([])).toBeUndefined();
    expect(ciFromGhRollup(null)).toBeUndefined();
    expect(ciFromGhRollup([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pass");
    expect(ciFromGhRollup([{ __typename: "CheckRun", status: "IN_PROGRESS" }])).toBe("pending");
    expect(ciFromGhRollup([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");
    expect(ciFromGhRollup([{ __typename: "StatusContext", state: "ERROR" }])).toBe("fail");
    // 一失败 + 一未完成：fail 优先
    expect(
      ciFromGhRollup([
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "QUEUED" },
      ]),
    ).toBe("fail");
  });

  it("gh 的 PR JSON → PrRef（含 draft / merged / ci），缺字段返回 null", () => {
    const pr = ghPrToRef(
      {
        number: 42,
        url: "https://github.com/acme/demo/pull/42",
        state: "OPEN",
        isDraft: false,
        headRefName: "feat/card-1",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      },
      remote,
      "fallback",
    );
    expect(pr).toEqual({
      repo: "acme/demo",
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
      branch: "feat/card-1",
      state: "open",
      ci: "pass",
    });

    expect(
      ghPrToRef({ number: 7, url: "https://github.com/acme/demo/pull/7", state: "OPEN", isDraft: true }, remote, "b"),
    ).toMatchObject({ state: "draft", branch: "b" });
    expect(
      ghPrToRef({ number: 8, url: "https://github.com/acme/demo/pull/8", state: "MERGED" }, remote, "b"),
    ).toMatchObject({ state: "merged" });
    expect(ghPrToRef({ number: 9, state: "OPEN" }, remote, "b")).toBeNull();
    expect(ghPrToRef(null, remote, "b")).toBeNull();
  });

  it("tea 的列表 → 按 head 挑 PR，ci 字段映射；无匹配返回 null", () => {
    const pulls = [
      { index: "745", state: "merged", url: "https://g/pulls/745", head: "codex/a", base: "main", ci: "success" },
      { index: "746", state: "closed", url: "https://g/pulls/746", head: "codex/b", base: "main", ci: "failure" },
    ];
    const picked = pickTeaPull(pulls, "codex/b");
    expect(teaPullToRef(picked, remote, "codex/b")).toMatchObject({
      number: 746,
      state: "closed",
      branch: "codex/b",
      ci: "fail",
      repo: "acme/demo",
    });
    expect(pickTeaPull(pulls, "nope")).toBeNull();
    expect(teaPullToRef(pickTeaPull(pulls, "codex/a"), remote, "codex/a")).toMatchObject({
      number: 745,
      state: "merged",
      ci: "pass",
    });
  });

  it("回写计划：一致就不发；状态/CI 变了走 probePr", () => {
    const base = {
      cwd: "/w/proj/.worktrees/card-1",
      ok: true,
      verdict: null,
      signals: {
        branch: "feat/card-1",
        headSha: null,
        changedFiles: 1,
        unpushedCommits: 0,
        commitsSinceBase: 1,
        base: "main",
        upstream: "main",
        remoteUrl: null,
        remote: null,
        forge: "unknown" as const,
      },
      notes: [],
    };
    const worktree = { path: "/w/proj/.worktrees/card-1", branch: "feat/card-1", source: "flowcard" as const };
    const pr = {
      repo: "acme/demo",
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
      branch: "feat/card-1",
      state: "open" as const,
      ci: "pending" as const,
    };
    const result = { ...base, worktree, pr, prSource: "gh" as const, prProbed: true };

    expect(probeCommands({ worktree: null, pr: null }, result)).toEqual([
      { cmd: "worktree", worktree },
      { cmd: "bindPr", pr },
    ]);
    // 已经一致 → 不发
    expect(probeCommands({ worktree, pr }, result)).toEqual([]);
    // CI 变了 → probePr
    expect(probeCommands({ worktree, pr: { ...pr, ci: "pass" } }, result)).toEqual([{ cmd: "probePr", pr }]);
    // PR 号换了 → bindPr
    expect(probeCommands({ worktree, pr: { ...pr, number: 41 } }, result)).toEqual([{ cmd: "bindPr", pr }]);
    // 主仓库（无 worktree）→ 不绑 worktree
    expect(probeCommands({ worktree: null, pr: null }, { ...result, worktree: null })).toEqual([{ cmd: "bindPr", pr }]);
  });

  it("命令拼装：git / gh / tea 的 argv 形状", () => {
    const g = gitArgv("/w/proj");
    expect(g.toplevel).toEqual(["-C", "/w/proj", "rev-parse", "--show-toplevel"]);
    expect(g.branch).toEqual(["-C", "/w/proj", "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(g.commonDir).toEqual(["-C", "/w/proj", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    expect(g.unpushed).toEqual(["-C", "/w/proj", "log", "--oneline", "@{u}..HEAD"]);
    expect(g.count("main..HEAD")).toEqual(["-C", "/w/proj", "rev-list", "--count", "main..HEAD"]);
    expect(ghArgv("feat/x")).toEqual([
      "pr",
      "view",
      "feat/x",
      "--json",
      "number,url,state,isDraft,headRefName,statusCheckRollup",
    ]);
    expect(teaArgv()).toEqual([
      "pulls",
      "list",
      "--state",
      "all",
      "--output",
      "json",
      "--limit",
      "50",
      "--fields",
      "index,state,url,title,head,base,ci",
    ]);
  });

  it("文本小工具", () => {
    expect(firstLine("\n  a \n b\n")).toBe("a");
    expect(countLines("a\n\nb\n  \n")).toBe(2);
  });
});

// ---------------------------------------------------------------- 真实 git 仓库

let root = "";
let mainRepo = "";
let wtPath = "";
let mainBranch = "";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fc-probe-"));
  mainRepo = join(root, "main");
  mkdirSync(mainRepo);
  git(["init", "-q", "-b", "main", "."], mainRepo);
  git(["config", "user.email", "probe@test"], mainRepo);
  git(["config", "user.name", "probe"], mainRepo);
  writeFileSync(join(mainRepo, "a.txt"), "a\n");
  git(["add", "."], mainRepo);
  git(["commit", "-qm", "c1"], mainRepo);
  mainBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], mainRepo).trim();

  git(["branch", "feat/card-1"], mainRepo);
  mkdirSync(join(mainRepo, ".worktrees"));
  git(["worktree", "add", "-q", ".worktrees/card-1", "feat/card-1"], mainRepo);
  wtPath = join(mainRepo, ".worktrees", "card-1");

  // worktree 里两个提交 + 一个未提交改动
  writeFileSync(join(wtPath, "b.txt"), "b\n");
  git(["add", "."], wtPath);
  git(["commit", "-qm", "c2"], wtPath);
  appendFileSync(join(wtPath, "b.txt"), "c\n");
  git(["commit", "-qam", "c3"], wtPath);
  writeFileSync(join(wtPath, "dirty.txt"), "d\n");

  // 只写临时仓库自己的 config 造出 upstream（不 push、不 fetch）：@{u} = refs/heads/main
  git(["config", "branch.feat/card-1.remote", "."], wtPath);
  git(["config", "branch.feat/card-1.merge", "refs/heads/main"], wtPath);

  git(["remote", "add", "origin", "https://github.com/acme/demo.git"], mainRepo);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("真实 git 仓库：主仓库 vs worktree", () => {
  it("主仓库：ok 但 isWorktree=false，worktree 槽位为空", async () => {
    const g = await probeGit(mainRepo);
    expect(g.ok).toBe(true);
    expect(g.verdict?.isWorktree).toBe(false);
    expect(g.verdict?.mainRoot).toBe(mainRepo);
    expect(g.signals.branch).toBe(mainBranch);
    expect(g.signals.remote?.slug).toBe("acme/demo");
    expect(g.signals.forge).toBe("github");
  });

  it("linked worktree：path/分支/source 都对，且是 flowcard 约定的 .worktrees/", async () => {
    const g = await probeGit(wtPath);
    expect(g.ok).toBe(true);
    expect(g.verdict?.isWorktree).toBe(true);
    expect(g.verdict?.underWorktreesDir).toBe(true);
    expect(g.verdict?.worktree).toMatchObject({
      path: wtPath,
      branch: "feat/card-1",
      source: "flowcard",
    });
    expect(g.signals.branch).toBe("feat/card-1");
    expect(g.signals.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("cwd 在 worktree 子目录里也能反查到 worktree 根", async () => {
    const sub = join(wtPath, "sub");
    mkdirSync(sub, { recursive: true });
    const g = await probeGit(sub);
    expect(g.verdict?.isWorktree).toBe(true);
    expect(g.verdict?.worktree.path).toBe(wtPath);
  });

  it("改动文件数与未推送提交数", async () => {
    const g = await probeGit(wtPath);
    expect(g.signals.changedFiles).toBe(1); // dirty.txt
    expect(g.signals.upstream).toBe("main");
    expect(g.signals.unpushedCommits).toBe(2); // c2, c3
    expect(g.signals.commitsSinceBase).toBe(2);
    expect(g.signals.base).toBe("main");
  });

  it("不是 git 仓库 → ok=false + 人话 note，不抛", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const g = await probeGit(plain);
    expect(g.ok).toBe(false);
    expect(g.notes.join("\n")).toContain("不在 git 仓库内");
  });
});

describe("probe 组合（真实 git + 注入假 gh/tea）", () => {
  it("会话在主仓库：worktree 槽位留空并给出提示", async () => {
    const result = await probe(mainRepo, { run: silentTools });
    expect(result.ok).toBe(true);
    expect(result.worktree).toBeNull();
    expect(result.notes.join("\n")).toContain("不是 worktree");
  });

  it("worktree 里的会话：假 gh 输出被解析成 PR，并产出回写命令", async () => {
    const ghJson = JSON.stringify({
      number: 42,
      url: "https://github.com/acme/demo/pull/42",
      state: "OPEN",
      isDraft: false,
      headRefName: "feat/card-1",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const run: Run = (file, args, opts) =>
      file === "git"
        ? defaultRun(file, args, opts)
        : Promise.resolve(file === "gh" ? ok(ghJson) : missing("tea"));

    const result = await probe(wtPath, { run });
    expect(result.worktree).toMatchObject({ path: wtPath, branch: "feat/card-1" });
    expect(result.prSource).toBe("gh");
    expect(result.prProbed).toBe(true);
    expect(result.pr).toMatchObject({ number: 42, state: "open", ci: "pass", repo: "acme/demo" });

    const plan = probeCommands({ worktree: null, pr: null }, result);
    expect(plan.map((c) => c.cmd)).toEqual(["worktree", "bindPr"]);
  });

  it("gh/tea 都不可用 → 明确报告「未探测」，不报错、不回写 PR", async () => {
    const result = await probe(wtPath, { run: silentTools });
    expect(result.ok).toBe(true);
    expect(result.worktree).not.toBeNull();
    expect(result.pr).toBeNull();
    expect(result.prProbed).toBe(false);
    expect(result.notes.join("\n")).toContain("未探测");
    expect(probeCommands({ worktree: result.worktree, pr: null }, result)).toEqual([]);
  });
});

describe("probePr 的分支选择与降级", () => {
  const remote: Remote = {
    raw: "https://gitea.example.com/git/acme/demo",
    host: "gitea.example.com",
    owner: "acme",
    repo: "demo",
    slug: "acme/demo",
    forge: "gitea",
  };

  it("Gitea：先试 tea，成功即定论", async () => {
    const teaJson = JSON.stringify([
      { index: "745", state: "merged", url: "https://g/acme/demo/pulls/745", head: "feat/card-1", base: "main", ci: "success" },
    ]);
    const calls: string[] = [];
    const out = await probePr({ cwd: "/tmp", branch: "feat/card-1", remote }, async (file, args) => {
      calls.push(file);
      return file === "tea" ? ok(teaJson) : missing("gh");
    });
    expect(calls).toEqual(["tea"]);
    expect(out.probed).toBe(true);
    expect(out.source).toBe("tea");
    expect(out.pr).toMatchObject({ number: 745, state: "merged", ci: "pass" });
  });

  it("tea 正常但没这条分支的 PR → probed=true、pr=null（是「确定没有」）", async () => {
    const out = await probePr({ cwd: "/tmp", branch: "feat/none", remote }, async () => ok("[]"));
    expect(out.probed).toBe(true);
    expect(out.pr).toBeNull();
    expect(out.notes.join("\n")).toContain("没有对应的 PR");
  });

  it("工具缺失 → probed=false 并说明未探测", async () => {
    const out = await probePr(
      { cwd: "/tmp", branch: "feat/card-1", remote },
      async (file) => missing(file),
    );
    expect(out.probed).toBe(false);
    expect(out.pr).toBeNull();
    expect(out.source).toBeNull();
    expect(out.notes.join("\n")).toContain("未探测");
  });
});

// ---------------------------------------------------------------- 注入用的假执行器

function ok(stdout: string): RunOutcome {
  return { code: 0, stdout, stderr: "", missing: false };
}

function missing(file: string): RunOutcome {
  return { code: 127, stdout: "", stderr: `${file}: 未安装`, missing: true };
}

/** 假 gh/tea：都当作未安装（用来验证降级）。 */
const silentTools: Run = (file, args, opts) =>
  file === "git" ? defaultRun(file, args, opts) : Promise.resolve(missing(file));
