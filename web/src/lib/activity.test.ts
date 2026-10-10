/** 「当前在干啥」的推导：优先级、失联判定、下一步文案。纯函数，不需要浏览器。 */
import { describe, expect, it } from "vitest";
import { cardActivity, cardNextStep } from "./activity.ts";
import { cardViewSchema } from "./schema.ts";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

function card(overrides: Record<string, unknown> = {}) {
  return cardViewSchema.parse({
    id: "c7",
    title: "修一个 bug",
    body: "",
    state: "working",
    projectId: "proj-1",
    issue: null,
    pr: null,
    worktree: null,
    session: null,
    runtime: null,
    gates: {},
    confirmations: [],
    pushes: [],
    comments: [],
    remoteComments: [],
    review: { comments: [] },
    spawned: [],
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  });
}

const session = (over: Record<string, unknown> = {}) => ({
  harness: "omp",
  id: "s1",
  agentKind: "main",
  cwd: "/repo/.worktrees/c7",
  state: "running",
  startedAt: "2026-10-10T11:00:00.000Z",
  lastSeenAt: "2026-10-10T11:59:30.000Z",
  ...over,
});

const worktree = { path: "/repo/.worktrees/c7", branch: "fix/c7", source: "harness" };

describe("当前在干啥", () => {
  it("会话在 worktree 里干活 → 两条绿色信号", () => {
    const signals = cardActivity(card({ session: session(), worktree }), NOW);
    expect(signals.map((s) => s.key)).toEqual(["session", "session-cwd"]);
    expect(signals.every((s) => s.tone === "success")).toBe(true);
  });

  it("会话不在 worktree 里 → 红字告警（不是静默）", () => {
    const signals = cardActivity(card({ session: session({ cwd: "/repo" }), worktree }), NOW);
    const cwd = signals.find((s) => s.key === "session-cwd");
    expect(cwd?.tone).toBe("danger");
    expect(cwd?.label).toContain("不在 worktree");
  });

  it("心跳超 90s → 会话失联，并说清多久", () => {
    const signals = cardActivity(
      card({ session: session({ state: "lost", lastSeenAt: "2026-10-10T11:45:00.000Z" }), worktree }),
      NOW,
    );
    expect(signals.find((s) => s.key === "session-lost")?.label).toBe("会话失联 15 分钟");
  });

  it("需要人动手的排在正在动的前面", () => {
    const signals = cardActivity(
      card({
        session: session(),
        worktree,
        gates: { G4: { id: "G4", kind: "cleanup", title: "清理确认", status: "open", requestedAt: "2026-10-10T11:00:00.000Z" } },
        remoteComments: [{ id: 1, issueNumber: 5, author: "u", body: "hi", at: "2026-10-10T11:30:00.000Z", url: "https://x/1", read: false }],
      }),
      NOW,
    );
    expect(signals[0]?.key).toBe("gates");
    expect(signals[1]?.key).toBe("remote");
    expect(signals.map((s) => s.key)).toContain("session");
  });

  it("终态直接收尾：放弃/完成只看一条", () => {
    expect(cardActivity(card({ state: "dropped" })).map((s) => s.key)).toEqual(["dropped"]);
    expect(cardActivity(card({ state: "done", cleanedAt: "2026-10-10T11:00:00.000Z" })).map((s) => s.key)).toEqual(["done"]);
  });

  it("已批但没用掉的授权要提示（一次批准只覆盖一次动作）", () => {
    const signals = cardActivity(
      card({
        confirmations: [{ id: "cf1", action: "push", detail: "git push -u origin fix/c7", status: "approved", requestedAt: "2026-10-10T11:00:00.000Z", requestedBy: { kind: "agent" } }],
      }),
    );
    expect(signals.find((s) => s.key === "confirm-unused")?.tone).toBe("info");
  });

  it("没会话、也没 worktree → 还没在干活 + 下一步先建 worktree", () => {
    const signals = cardActivity(card(), NOW);
    expect(signals.map((s) => s.key)).toEqual(["no-session"]);
    expect(cardNextStep(card())).toContain("建 worktree");
  });

  it("下一步按缺失要件逐条给：Issue → PR → 推送 → 起会话 → 切进 worktree", () => {
    const base = { worktree, session: session() };
    expect(cardNextStep(card({ worktree, session: session() }))).toContain("绑 Issue");
    expect(cardNextStep(card({ ...base, issue: { repo: "r", number: 1, url: "https://x/1", state: "open" } }))).toContain("开 WIP PR");
    expect(
      cardNextStep(
        card({ ...base, issue: { repo: "r", number: 1, url: "https://x/1", state: "open" }, pr: { repo: "r", number: 2, url: "https://x/2", branch: "fix/c7", state: "open" } }),
      ),
    ).toContain("推一次");
    expect(
      cardNextStep(
        card({
          worktree,
          issue: { repo: "r", number: 1, url: "https://x/1", state: "open" },
          pr: { repo: "r", number: 2, url: "https://x/2", branch: "fix/c7", state: "open" },
          pushes: [{ sha: "a", at: "2026-10-10T11:00:00.000Z", actor: { kind: "agent" } }],
        }),
      ),
    ).toContain("起会话");
    expect(
      cardNextStep(
        card({
          worktree,
          session: session({ cwd: "/repo" }),
          issue: { repo: "r", number: 1, url: "https://x/1", state: "open" },
          pr: { repo: "r", number: 2, url: "https://x/2", branch: "fix/c7", state: "open" },
          pushes: [{ sha: "a", at: "2026-10-10T11:00:00.000Z", actor: { kind: "agent" } }],
        }),
      ),
    ).toContain("切进 worktree");
  });

  it("待验收/待清理各自的「下一步」不一样", () => {
    expect(cardNextStep(card({ state: "review", session: session({ state: "ended" }) }))).toContain("等你验收");
    expect(
      cardNextStep(card({ state: "review", acceptedAt: "2026-10-10T11:00:00.000Z", pr: { repo: "r", number: 2, url: "https://x/2", branch: "fix/c7", state: "open" } })),
    ).toContain("等合并");
    expect(cardNextStep(card({ state: "merged" }))).toContain("清理");
  });
});
