/** 开工这条链路的单测：提示词内容、argv 拼装与引号、编排的降级路径。全部不碰真终端/git。 */
import { describe, expect, it } from "vitest";
import { cardBrief, writeBriefFile } from "../src/server/brief.ts";
import { autostartCard, hasLiveSession, worktreePlanFor } from "../src/server/autostart.ts";
import { defaultAdapterPath, sessionCommand, shq, worktreeArgv } from "../src/server/launch.ts";
import { emptyCard } from "../src/server/project.ts";
import type { Card, Project } from "../src/shared/types.ts";

const project: Project = {
  id: "proj-1",
  name: "demo",
  path: "/repo",
  remote: "https://git.example.com/git/Team/Repo.git",
  defaultBranch: "master",
  addedAt: "2026-10-10T00:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
};

function card(overrides: Partial<Card> = {}): Card {
  return {
    ...emptyCard("c7", "2026-10-10T00:00:00.000Z"),
    title: "修一个 bug",
    body: "现象：点开会卡住",
    ...overrides,
  };
}

describe("开工提示（brief）", () => {
  it("把现状与待办都写进去：没 worktree / 没 Issue / 没 PR / 没推送时都是待办", () => {
    const text = cardBrief({ card: card(), project });
    expect(text).toContain("卡片 c7");
    expect(text).toContain("待开工");
    expect(text).toContain("现象：点开会卡住");
    expect(text).toContain("先建 worktree");
    expect(text).toContain("绑上对应的 Issue");
    expect(text).toContain("开 WIP PR");
    expect(text).toContain("flowcard push c7 --sha");
    // 铁律必须在
    expect(text).toContain("远程写要人批");
    expect(text).toContain("会话必须待在 worktree 里");
    expect(text).toContain("验收、清理只能人点");
  });

  it("已完成的步骤标 ✅，未完成的标 ⬜", () => {
    const text = cardBrief({
      card: card({
        issue: { repo: "Team/Repo", number: 742, url: "https://x/742", state: "open" },
        worktree: { path: "/repo/.worktrees/c7", branch: "feat/c7", source: "flowcard" },
        pushes: [{ sha: "abc12345def", at: "2026-10-10T01:00:00.000Z", actor: { kind: "agent" } }],
      }),
      project,
    });
    expect(text).toMatch(/✅ worktree 已就绪/);
    expect(text).toMatch(/✅ Issue 已绑：#742/);
    expect(text).toMatch(/⬜ 开 WIP PR/);
    expect(text).toMatch(/✅ 已有 1 条推送记录/);
  });

  it("正文为空也不崩", () => {
    expect(cardBrief({ card: card({ body: "" }), project })).toContain("（空）");
  });

  it("提示文件内容没变就不重写", async () => {
    const files = new Map<string, string>();
    const io = {
      readFile: async (p: string) => {
        const found = files.get(p);
        if (found === undefined) throw new Error("ENOENT");
        return found;
      },
      writeFile: async (p: string, t: string) => void files.set(p, t),
    };
    expect((await writeBriefFile("/b/c7.md", "hi", io)).written).toBe(true);
    expect((await writeBriefFile("/b/c7.md", "hi", io)).written).toBe(false);
    expect((await writeBriefFile("/b/c7.md", "hi2", io)).written).toBe(true);
  });
});

describe("启动命令拼装", () => {
  it("POSIX 单引号转义挡得住引号与空格", () => {
    expect(shq("/a b/c")).toBe("'/a b/c'");
    expect(shq("it's")).toBe("'it'\\''s'");
  });

  it("worktree 参数：新分支带 -b，已存在时退化成绑现有分支", () => {
    const plan = { repoPath: "/repo", path: "/repo/.worktrees/c7", branch: "feat/c7", base: "master" };
    expect(worktreeArgv(plan, { useExistingBranch: false })).toEqual([
      "-C", "/repo", "worktree", "add", "/repo/.worktrees/c7", "-b", "feat/c7", "master",
    ]);
    expect(worktreeArgv(plan, { useExistingBranch: true })).toContain("feat/c7");
    expect(worktreeArgv(plan, { useExistingBranch: true })).not.toContain("-b");
  });

  it("会话命令：带扩展与提示文件，且提示用 $(cat) 传，退出后留住终端", () => {
    const cmd = sessionCommand({
      ompPath: "/home/u/.bun/bin/omp",
      adapterPath: "/repo/src/adapters/omp/adapter.ts",
      briefPath: "/data/briefs/c7.md",
    });
    expect(cmd).toContain("'/home/u/.bun/bin/omp'");
    expect(cmd).toContain("-e '/repo/src/adapters/omp/adapter.ts'");
    expect(cmd).toContain('--append-system-prompt "$(cat \'/data/briefs/c7.md\')"');
    expect(cmd).toContain("exec bash -i");
  });
});

describe("自动开工编排", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const cards = new Map<string, Card>([["c7", card()]]);
    const base = {
      getCard: (id: string) => cards.get(id),
      getProject: () => project,
      bindWorktree: async (id: string, ref: { path: string; branch: string }) => {
        calls.push(`bind:${id}:${ref.path}`);
        cards.set(id, { ...cards.get(id)!, worktree: { ...ref, source: "flowcard" } });
      },
      comment: async (id: string, body: string) => void calls.push(`comment:${id}:${body}`),
      dataDir: "/data",
      adapterPath: "/repo/src/adapters/omp/adapter.ts",
      io: {
        createWorktree: async () => ({ ok: true, path: "/repo/.worktrees/c7", branch: "feat/c7", reusedBranch: false }),
        launchSession: async () => ({ ok: true, terminal: "konsole", command: "omp …" }),
        resolveOmpPath: async () => "/home/u/.bun/bin/omp",
        writeBrief: async () => ({ written: true }),
      },
      calls,
      ...over,
    };
    return base;
  };

  it("正常路径：建 worktree → 绑定 → 写提示 → 起会话，并把结论写进评论", async () => {
    const d = deps();
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("started");
    expect(outcome.worktree?.path).toBe("/repo/.worktrees/c7");
    expect(outcome.terminal).toEqual({ ok: true, terminal: "konsole", command: "omp …" });
    expect(d.calls.some((c) => c.startsWith("bind:c7:"))).toBe(true);
    expect(d.calls.some((c) => c.startsWith("comment:c7:已在桌面上启动会话"))).toBe(true);
  });

  it("已有会话在跑 → 跳过，不重复开终端", async () => {
    const running = card({ session: { harness: "omp", id: "s1", agentKind: "main", cwd: "/repo/.worktrees/c7", state: "running", startedAt: "x", lastSeenAt: "x" } });
    expect(hasLiveSession(running)).toBe(true);
    const outcome = await autostartCard("c7", deps({ getCard: () => running }) as never);
    expect(outcome.status).toBe("skipped");
  });

  it("建 worktree 失败 → 不静默：写清失败原因与手动命令，不起会话", async () => {
    const d = deps({
      io: {
        createWorktree: async () => ({ ok: false, reason: "not-a-repo", message: "/repo 不是 git 仓库" }),
        launchSession: async () => {
          throw new Error("不该走到起会话这一步");
        },
        resolveOmpPath: async () => undefined,
        writeBrief: async () => ({ written: true }),
      },
    });
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("failed");
    expect(d.calls.some((c) => c.includes("自动开工失败"))).toBe(true);
    expect(d.calls.some((c) => c.includes("worktree add"))).toBe(true);
  });

  it("没终端 → worktree 照样建好绑定，评论里给手动启动命令", async () => {
    const d = deps({
      io: {
        createWorktree: async () => ({ ok: true, path: "/repo/.worktrees/c7", branch: "feat/c7", reusedBranch: false }),
        launchSession: async () => ({ ok: false, reason: "no-terminal", message: "没找到可用的终端" }),
        resolveOmpPath: async () => undefined,
        writeBrief: async () => ({ written: true }),
      },
    });
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("failed");
    expect(outcome.worktree?.branch).toBe("feat/c7");
    expect(d.calls.some((c) => c.includes("没起来会话"))).toBe(true);
  });

  it("未归属项目的卡不自动开工", async () => {
    const outcome = await autostartCard("c7", deps({ getProject: () => undefined }) as never);
    expect(outcome.status).toBe("skipped");
    expect(outcome.summary).toContain("未归属");
  });

  it("扩展路径由服务端自己算出来（不靠环境变量）", () => {
    const path = defaultAdapterPath();
    expect(path.endsWith("src/adapters/omp/flowcard-omp-adapter.ts")).toBe(true);
  });

  it("worktree 计划：路径落在项目下的 .worktrees/<卡片 id>，分支 feat/<卡片 id>", () => {
    const plan = worktreePlanFor(card(), project);
    expect(plan).toMatchObject({ repoPath: "/repo", path: "/repo/.worktrees/c7", branch: "feat/c7", base: "master" });
  });
});
