/** 开工这条链路的单测：提示词内容、托管会话的编排与降级路径。全部不碰真 omp/git。 */
import { describe, expect, it } from "vitest";
import { cardBrief, writeBriefFile } from "../src/server/brief.ts";
import { autostartCard, hasLiveSession } from "../src/server/autostart.ts";
import type { HostedSessions, StartSessionOptions, StartSessionResult } from "../src/server/hosted-session.ts";
import { defaultAdapterPath } from "../src/server/launch.ts";
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

/** 假的托管会话注册表：只记下 start 拿到了什么。 */
function fakeSessions(outcome: Partial<StartSessionResult> = {}): {
  sessions: HostedSessions;
  started: StartSessionOptions[];
} {
  const started: StartSessionOptions[] = [];
  const sessions: HostedSessions = {
    async start(_cardId, opts = {}) {
      started.push(opts);
      return {
        ok: true,
        status: "starting",
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...outcome,
      };
    },
    async prompt() {
      return { ok: true, messageId: "u:1" };
    },
    async abort() {
      return { ok: true };
    },
    async stop() {
      return { ok: true };
    },
    async stopAll() {
      return undefined;
    },
    snapshot: () => ({ status: "stopped", cwd: "", busy: false, messages: [] }),
    subscribe: () => () => undefined,
    onCard: () => () => undefined,
    isLive: () => false,
    liveCardIds: () => [],
    resolveCwd: () => "/repo",
  };
  return { sessions, started };
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
      mkdir: async () => undefined,
    };
    expect((await writeBriefFile("/b/c7.md", "hi", io)).written).toBe(true);
    expect((await writeBriefFile("/b/c7.md", "hi", io)).written).toBe(false);
    expect((await writeBriefFile("/b/c7.md", "hi2", io)).written).toBe(true);
  });
});

describe("omp 辅助", () => {
  it("扩展路径由服务端自己算出来（不靠环境变量）", () => {
    expect(defaultAdapterPath().endsWith("src/adapters/omp/flowcard-omp-adapter.ts")).toBe(true);
  });
});

describe("自动开工编排", () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const cards = new Map<string, Card>([["c7", card()]]);
    const fake = fakeSessions();
    const base = {
      getCard: (id: string) => cards.get(id),
      getProject: () => project,
      comment: async (id: string, body: string) => void calls.push(`comment:${id}:${body}`),
      dataDir: "/data",
      sessions: fake.sessions,
      started: fake.started,
      io: { writeBrief: async () => ({ written: true }) },
      calls,
      ...over,
    };
    return base;
  };

  it("正常路径：写提示 → 起托管会话（brief 走系统提示、开工话走第一条 prompt），结论写进评论", async () => {
    const d = deps();
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("started");
    expect(outcome.cwd).toBe("/repo");
    expect(outcome.session).toEqual({ ok: true, status: "starting" });
    expect(d.started).toHaveLength(1);
    expect(d.started[0]?.cwd).toBe("/repo");
    expect(d.started[0]?.brief).toContain("你是 flowcard 卡片 c7 的会话");
    expect(d.started[0]?.kickoff).toContain("开工：你是卡片 c7 的会话");
    expect(d.calls.some((c) => c.startsWith("comment:c7:已托管会话"))).toBe(true);
  });

  it("绑的 worktree 目录没了 → 先起在项目根，并留一条评论说明", async () => {
    const gone = card({ worktree: { path: "/repo/.worktrees/gone", branch: "feat/x", source: "flowcard" } });
    const d = deps({ getCard: () => gone });
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("started");
    expect(outcome.cwd).toBe("/repo");
    expect(d.started[0]?.cwd).toBe("/repo");
    expect(d.calls.some((c) => c.includes("但那个目录不存在了"))).toBe(true);
  });

  it("已有会话在跑（卡片投影或注册表）→ 跳过，不重复起", async () => {
    const running = card({
      session: {
        harness: "omp",
        id: "s1",
        agentKind: "main",
        cwd: "/repo/.worktrees/c7",
        state: "running",
        startedAt: "x",
        lastSeenAt: "x",
      },
    });
    expect(hasLiveSession(running)).toBe(true);
    const skippedCard = await autostartCard("c7", deps({ getCard: () => running }) as never);
    expect(skippedCard.status).toBe("skipped");

    const fake = fakeSessions();
    const liveSessions: HostedSessions = { ...fake.sessions, isLive: () => true };
    const liveRegistry = await autostartCard("c7", deps({ sessions: liveSessions }) as never);
    expect(liveRegistry.status).toBe("skipped");
    expect(fake.started).toHaveLength(0);
  });

  it("提示里把「建 worktree」交回给会话：名字自定 + 要登记 + 要切进去", async () => {
    const d = deps();
    const outcome = await autostartCard("c7", d as never);
    const text = cardBrief({ card: card(), project });
    expect(outcome.status).toBe("started");
    expect(text).toMatch(/名字由你起/);
    expect(text).toMatch(/git worktree add \.worktrees\/<你起的名字>/);
    expect(text).toMatch(/flowcard worktree c7 --path/);
    expect(text).toMatch(/\/wt <分支>|\/move <路径>/);
    expect(text).toMatch(/在主仓库里改文件不算开工/);
  });

  it("会话没起来 → 评论里给重试/手动办法，卡片状态不动", async () => {
    const d = deps({
      sessions: fakeSessions({
        ok: false,
        status: "failed",
        error: { code: "NO_CWD", message: "工作目录不存在：/repo" },
      }).sessions,
    });
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("failed");
    expect(outcome.cwd).toBe("/repo");
    expect(outcome.session).toEqual({ ok: false, status: "failed" });
    expect(outcome.summary).toContain("工作目录不存在");
    expect(d.calls.some((c) => c.includes("没起来会话"))).toBe(true);
    expect(d.calls.some((c) => c.includes("flowcard claim c7"))).toBe(true);
  });

  it("未归属项目的卡不自动开工", async () => {
    const outcome = await autostartCard("c7", deps({ getProject: () => undefined }) as never);
    expect(outcome.status).toBe("skipped");
    expect(outcome.summary).toContain("未归属");
  });

  it("提示文件目录不存在时自己建（第一次开卡的老 bug：ENOENT 把请求打成 500）", async () => {
    const files = new Map<string, string>();
    const made: string[] = [];
    const io = {
      readFile: async (p: string) => {
        const found = files.get(p);
        if (found === undefined) throw new Error("ENOENT");
        return found;
      },
      writeFile: async (p: string, t: string) => void files.set(p, t),
      mkdir: async (p: string) => void made.push(p),
    };
    const result = await writeBriefFile("/data/briefs/c9.md", "hi", io);
    expect(result.written).toBe(true);
    expect(made).toEqual(["/data/briefs"]);
  });

  it("编排里任何意外都不抛：变成卡片评论 + failed（开卡不能因此 500）", async () => {
    const crashing = fakeSessions();
    const d = deps({
      sessions: {
        ...crashing.sessions,
        start: async () => {
          throw new Error("会话炸了");
        },
      },
    });
    const outcome = await autostartCard("c7", d as never);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("会话炸了");
    expect(d.calls.some((c) => c.includes("自动开工时出了意外"))).toBe(true);
  });
});
