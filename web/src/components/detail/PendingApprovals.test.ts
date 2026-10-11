/**
 * `PendingApprovals` 的渲染冒烟：仓库里没有 jsdom / testing-library（不加依赖），
 * 所以用 SSR 的静态标记验「有待办 → 渲染出批准/驳回按钮；没有 → 整个组件不渲染」。
 * 点下去要发的命令在 `lib/approvals.test.ts` 里逐字比对（按钮的 onClick 调的就是那一个函数）。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cardViewSchema, type CardView } from "@/lib/schema";
import { PendingApprovals } from "./PendingApprovals.tsx";

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
    eventCount: 0,
    ...overrides,
  });
}

function markup(view: CardView): string {
  return renderToStaticMarkup(createElement(PendingApprovals, { card: view }));
}

const pendingConfirm = {
  id: "cf1",
  action: "push",
  detail: "git push origin fix/c7",
  status: "pending",
  requestedAt: "2026-10-10T10:00:00.000Z",
  requestedBy: { kind: "agent", name: "omp" },
};

const openGate = {
  id: "G4",
  kind: "cleanup",
  title: "清理确认",
  status: "open",
  requestedAt: "2026-10-10T11:00:00.000Z",
  payload: { items: ["删 worktree .worktrees/c7"] },
};

describe("PendingApprovals 渲染", () => {
  it("有待批的确认 + 未决门禁 → 两条都渲染出批准/驳回按钮", () => {
    const html = markup(card({ confirmations: [pendingConfirm], gates: { G4: openGate } }));

    expect(html).toContain('data-testid="pending-approvals"');
    expect(html).toContain('data-count="2"');
    // 远程写确认（G2）：detail 要看得见，人才能判断批不批
    expect(html).toContain("git push origin fix/c7");
    expect(html).toContain('data-testid="pending-approve-cf1"');
    expect(html).toContain('data-testid="pending-reject-cf1"');
    expect(html).toContain('data-testid="pending-reason-cf1"');
    expect(html).toContain('data-command="decideConfirm"');
    // 门禁（G4 清理）：标题 + 清理清单 + 按钮
    expect(html).toContain("清理确认");
    expect(html).toContain("删 worktree .worktrees/c7");
    expect(html).toContain('data-testid="pending-approve-G4"');
    expect(html).toContain('data-testid="pending-reject-G4"');
    expect(html).toContain('data-command="decideGate"');
    expect(html).toContain("批准");
    expect(html).toContain("驳回");
  });

  it("没有待办 → 什么都不渲染（对话里不摆空壳）", () => {
    expect(markup(card())).toBe("");
  });

  it("只有已经处理过的（已批准确认 / 已决门禁）→ 同样不渲染", () => {
    const html = markup(
      card({
        confirmations: [
          { ...pendingConfirm, status: "approved", decidedAt: "2026-10-10T10:10:00.000Z", decidedBy: "me" },
        ],
        gates: { G3: { id: "G3", kind: "review", title: "验收", status: "approved", requestedAt: "2026-10-10T09:00:00.000Z" } },
      }),
    );
    expect(html).toBe("");
  });

  it("有理由输入框与命令出处提示（和看板同一条命令）", () => {
    const html = markup(card({ confirmations: [pendingConfirm] }));
    expect(html).toContain("理由（可空");
    expect(html).toContain("POST /api/commands");
  });
});
