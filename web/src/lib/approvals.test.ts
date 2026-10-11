/**
 * 待处理审批 / 门禁的取数与命令构造：纯逻辑，不需要浏览器。
 *
 * 这里盯三件事：
 *   1. 待办**只**来自卡片投影已有的 `confirmations`(pending) 与 `gates`(open)；
 *   2. 点批准/驳回要发的命令与看板那两颗按钮逐字一致（同一份构造 → 没有第二套端点）；
 *   3. 只有服务端确认落地（`settled`）才算处理掉，失败必须带出原因。
 */
import { describe, expect, it } from "vitest";
import { cardViewSchema } from "./schema.ts";
import {
  approvalDecision,
  approvalDetails,
  approvalSummary,
  gatePayloadItems,
  pendingApprovals,
  submitApproval,
} from "./approvals.ts";

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

function confirmation(over: Record<string, unknown> = {}) {
  return {
    id: "cf1",
    action: "push",
    detail: "git push origin fix/c7",
    status: "pending",
    requestedAt: "2026-10-10T10:00:00.000Z",
    requestedBy: { kind: "agent", name: "omp" },
    ...over,
  };
}

function gate(over: Record<string, unknown> = {}) {
  return {
    id: "G4",
    kind: "cleanup",
    title: "清理确认",
    status: "open",
    requestedAt: "2026-10-10T11:00:00.000Z",
    payload: { items: ["删 worktree .worktrees/c7", "删分支 fix/c7"] },
    ...over,
  };
}

describe("pendingApprovals：待办从哪来", () => {
  it("pending 的确认 + open 的门禁，合并成一条待办（按申请时间从早到晚）", () => {
    const view = card({
      confirmations: [confirmation()],
      gates: { G4: gate(), G3: gate({ id: "G3", kind: "review", title: "验收", status: "approved" }) },
    });
    const items = pendingApprovals(view);
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(["confirm:cf1", "gate:G4"]);
    expect(items.every((item) => typeof item.requestedAt === "string")).toBe(true);
  });

  it("已经处理过的不进待办（approved/rejected/consume 过的确认、已决门禁）", () => {
    const view = card({
      confirmations: [
        confirmation({ id: "cf1", status: "approved" }),
        confirmation({ id: "cf2", status: "rejected" }),
        confirmation({ id: "cf3", status: "approved", consumedAt: "2026-10-10T10:30:00.000Z" }),
      ],
      gates: { G3: gate({ id: "G3", kind: "review", title: "验收", status: "approved" }) },
    });
    expect(pendingApprovals(view)).toEqual([]);
  });

  it("没有这两类字段内容时是空待办（不会因为老投影缺字段而炸）", () => {
    expect(pendingApprovals(card())).toEqual([]);
  });

  it("门禁 payload.items → 清理清单；别的门禁是空数组", () => {
    expect(gatePayloadItems(gate() as never)).toEqual(["删 worktree .worktrees/c7", "删分支 fix/c7"]);
    expect(gatePayloadItems(gate({ payload: {} }) as never)).toEqual([]);
    expect(gatePayloadItems(gate({ payload: undefined }) as never)).toEqual([]);
  });

  it("一行文案：确认给动作名 + detail，门禁给标题 + 类别", () => {
    const [confirmItem, gateItem] = pendingApprovals(
      card({ confirmations: [confirmation()], gates: { G4: gate() } }),
    );
    expect(approvalSummary(confirmItem!).title).toBe("推送 push");
    expect(approvalSummary(confirmItem!).hint).toBe("git push origin fix/c7");
    expect(approvalSummary(confirmItem!).requester).toBe("omp 申请");
    expect(approvalSummary(gateItem!)).toEqual({ title: "清理确认", hint: "清理类", requester: "" });
    expect(approvalDetails(confirmItem!)).toEqual(["git push origin fix/c7"]);
    expect(approvalDetails(gateItem!)).toEqual(["删 worktree .worktrees/c7", "删分支 fix/c7"]);
  });
});

describe("approvalDecision：命令与看板那两颗按钮同源", () => {
  it("确认 → decideConfirm（card + id + decision，理由非空才带）", () => {
    const view = card({ confirmations: [confirmation()] });
    const [item] = pendingApprovals(view);
    expect(approvalDecision("c7", item!, "approved")).toEqual({
      label: "批准确认 cf1",
      command: {
        cmd: "decideConfirm",
        actor: { kind: "human", name: "me" },
        card: "c7",
        id: "cf1",
        decision: "approved",
      },
    });
    expect(approvalDecision("c7", item!, "rejected", "  没写清要推哪个分支  ").command).toEqual({
      cmd: "decideConfirm",
      actor: { kind: "human", name: "me" },
      card: "c7",
      id: "cf1",
      decision: "rejected",
      reason: "没写清要推哪个分支",
    });
  });

  it("门禁 → decideGate（键是 gate，不是 id）", () => {
    const view = card({ gates: { G4: gate() } });
    const [item] = pendingApprovals(view);
    expect(approvalDecision("c7", item!, "rejected", "现场还有用")).toEqual({
      label: "驳回 G4",
      command: {
        cmd: "decideGate",
        actor: { kind: "human", name: "me" },
        card: "c7",
        gate: "G4",
        decision: "rejected",
        reason: "现场还有用",
      },
    });
    expect(approvalDecision("c7", item!, "approved").label).toBe("批准 G4");
  });
});

describe("submitApproval：怎么发、怎么判成败", () => {
  it("没有外层 runner 时自己 POST /api/commands，服务端 ok 才算落地", async () => {
    const seen: Record<string, unknown>[] = [];
    const view = card({ confirmations: [confirmation()] });
    const [item] = pendingApprovals(view);
    const outcome = await submitApproval({
      cardId: "c7",
      item: item!,
      decision: "approved",
      post: async (command) => {
        seen.push(command);
        return { ok: true };
      },
    });
    expect(seen).toEqual([
      {
        cmd: "decideConfirm",
        actor: { kind: "human", name: "me" },
        card: "c7",
        id: "cf1",
        decision: "approved",
      },
    ]);
    expect(outcome).toMatchObject({ settled: true, label: "批准确认 cf1" });
  });

  it("服务端拒绝 → 不落地，带出 code 与 message", async () => {
    const view = card({ gates: { G4: gate() } });
    const [item] = pendingApprovals(view);
    const outcome = await submitApproval({
      cardId: "c7",
      item: item!,
      decision: "approved",
      post: async () => ({ ok: false, rejection: { code: "GATE_NOT_OPEN", message: "门禁已经决过了" } }),
    });
    expect(outcome.settled).toBe(false);
    expect(outcome.error).toBe("批准 G4失败（GATE_NOT_OPEN）：门禁已经决过了");
  });

  it("网络炸了也不静默：settled=false 且带原因", async () => {
    const view = card({ confirmations: [confirmation()] });
    const [item] = pendingApprovals(view);
    const outcome = await submitApproval({
      cardId: "c7",
      item: item!,
      decision: "approved",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(outcome.settled).toBe(false);
    expect(outcome.error).toContain("连不上 flowcard 服务");
  });

  it("有外层 runner（看板 CardDetail 的 run）就走它：命令同一条，成败由它自己的提示管", async () => {
    const view = card({ confirmations: [confirmation()] });
    const [item] = pendingApprovals(view);
    const calls: { label: string; command: Record<string, unknown> }[] = [];
    const viaRunner = await submitApproval({
      cardId: "c7",
      item: item!,
      decision: "rejected",
      reason: "理由",
      run: async (label, command) => {
        calls.push({ label, command });
      },
    });
    expect(calls).toEqual([
      {
        label: "驳回确认 cf1",
        command: {
          cmd: "decideConfirm",
          actor: { kind: "human", name: "me" },
          card: "c7",
          id: "cf1",
          decision: "rejected",
          reason: "理由",
        },
      },
    ]);
    // runner 不回 ok 时不猜成败：不乐观地从待办里拿掉，等卡片投影刷新
    expect(viaRunner.settled).toBe(false);
    expect(viaRunner.error).toBeUndefined();

    const reported = await submitApproval({
      cardId: "c7",
      item: item!,
      decision: "approved",
      run: async () => ({ ok: false, error: "服务端拒绝" }),
    });
    expect(reported).toMatchObject({ settled: false, error: "服务端拒绝" });
  });
});
