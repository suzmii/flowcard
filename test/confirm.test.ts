/**
 * G2 远程写确认：一次性凭据、一事一议、幂等与投影一致性。
 * 引擎层用 harness（不起服务），幂等要靠 store（dedupeKey 是存储层的唯一索引）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createStore } from "../src/server/store.ts";
import { commandSchema, type Command } from "../src/shared/types.ts";
import { createHarness } from "./harness.ts";

const DETAIL = "git push -u origin feat/card-1";
const HUMAN = { kind: "human" as const, name: "tester" };

function freshStore() {
  return createStore({
    dataDir: mkdtempSync(join(tmpdir(), "flowcard-confirm-")),
    flow: personalFlow,
  });
}

describe("远程写确认（G2）", () => {
  it("申请 → 批准 → consume 是唯一放行路径；未批准不能 consume", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "远程写", body: "" }).primaryCardId;

    const requested = h.run({
      cmd: "requestConfirm",
      actor: h.agent,
      card: id,
      action: "push",
      detail: DETAIL,
    });
    expect(requested.rejection).toBeUndefined();
    expect(h.card(id).confirmations).toHaveLength(1);
    expect(h.card(id).confirmations[0]).toMatchObject({
      id: "cf1",
      action: "push",
      detail: DETAIL,
      status: "pending",
    });
    expect(h.card(id).confirmations[0]?.requestedBy).toEqual(h.agent);
    expect(h.card(id).confirmations[0]?.consumedAt).toBeUndefined();

    const early = h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });
    expect(early.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(early.rejection?.message).toContain("还没被批准");
    expect(early.events).toHaveLength(0);
    expect(h.card(id).confirmations[0]?.consumedAt).toBeUndefined();

    h.run({ cmd: "decideConfirm", actor: h.human, card: id, id: "cf1", decision: "approved" });
    expect(h.card(id).confirmations[0]).toMatchObject({ status: "approved", decidedBy: "you" });
    expect(h.card(id).confirmations[0]?.consumedAt).toBeUndefined();

    const consumed = h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });
    expect(consumed.rejection).toBeUndefined();
    expect(h.card(id).confirmations[0]?.consumedAt).toBeDefined();
    expect(h.card(id).confirmations[0]?.status).toBe("approved");
  });

  it("一次批准只覆盖一次动作：二次 consume 被拒，第二次写必须重新申请", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "远程写", body: "" }).primaryCardId;
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "push", detail: DETAIL });
    h.run({ cmd: "decideConfirm", actor: h.human, card: id, id: "cf1", decision: "approved" });
    h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });

    const reused = h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });
    expect(reused.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(reused.rejection?.message).toContain("一次授权只覆盖一次动作");
    expect(reused.events).toHaveLength(0);

    // 同样的一条命令再来一次：是**新的一条申请**，不是复用旧的那张凭据。
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "push", detail: DETAIL });
    expect(h.card(id).confirmations).toHaveLength(2);
    expect(h.card(id).confirmations[1]).toMatchObject({ id: "cf2", status: "pending" });

    // 老的批准不能覆盖新申请。
    const tooEarly = h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf2" });
    expect(tooEarly.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(tooEarly.rejection?.message).toContain("还没被批准");
  });

  it("驳回必须带理由，被驳回的申请不能再 consume", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "远程写", body: "" }).primaryCardId;
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "merge", detail: "tea pr merge 77" });

    const noReason = h.run({
      cmd: "decideConfirm",
      actor: h.human,
      card: id,
      id: "cf1",
      decision: "rejected",
    });
    expect(noReason.rejection?.code).toBe("USAGE_ERROR");
    expect(h.card(id).confirmations[0]?.status).toBe("pending");

    h.run({
      cmd: "decideConfirm",
      actor: h.human,
      card: id,
      id: "cf1",
      decision: "rejected",
      reason: "CI 还红着，不许合",
    });
    expect(h.card(id).confirmations[0]).toMatchObject({
      status: "rejected",
      reason: "CI 还红着，不许合",
      decidedBy: "you",
    });

    const consumed = h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });
    expect(consumed.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(consumed.rejection?.message).toContain("已被驳回");
    expect(consumed.rejection?.message).toContain("CI 还红着，不许合");
    expect(consumed.events).toHaveLength(0);

    // 同一件事可以重新申请（被拒之后），拿到的是新的一条。
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "merge", detail: "tea pr merge 77" });
    expect(h.card(id).confirmations.map((c) => c.id)).toEqual(["cf1", "cf2"]);
  });

  it("重复决策与不存在的 id 都回清楚", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "远程写", body: "" }).primaryCardId;
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "other", detail: "curl -X POST …/comment" });
    h.run({ cmd: "decideConfirm", actor: h.human, card: id, id: "cf1", decision: "approved" });

    const twice = h.run({
      cmd: "decideConfirm",
      actor: h.human,
      card: id,
      id: "cf1",
      decision: "approved",
    });
    expect(twice.rejection?.code).toBe("STATE_NOT_ALLOWED");
    expect(twice.rejection?.message).toContain("不能重复决策");

    for (const cmd of [
      { cmd: "decideConfirm", actor: h.human, card: id, id: "cf9", decision: "approved" as const },
      { cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf9" },
    ] as const) {
      const missing = h.run(cmd);
      expect(missing.rejection?.code).toBe("NOT_FOUND");
      expect(missing.rejection?.message).toContain("cf9");
      expect(missing.events).toHaveLength(0);
    }

    const ghost = h.run({ cmd: "requestConfirm", actor: h.agent, card: "c99", action: "push", detail: DETAIL });
    expect(ghost.rejection?.code).toBe("NOT_FOUND");
  });

  it("投影 == 从零重放（rebuild 不漂），空卡片从空的确认列表开始", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "远程写", body: "" }).primaryCardId;
    expect(h.card(id).confirmations).toEqual([]);

    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "openPr", detail: "tea pr create --title x" });
    h.run({ cmd: "requestConfirm", actor: h.agent, card: id, action: "push", detail: DETAIL });
    h.run({ cmd: "decideConfirm", actor: h.human, card: id, id: "cf1", decision: "approved" });
    h.run({ cmd: "consumeConfirm", actor: h.agent, card: id, id: "cf1" });
    h.run({
      cmd: "decideConfirm",
      actor: h.human,
      card: id,
      id: "cf2",
      decision: "rejected",
      reason: "先等 CI",
    });

    expect(h.card(id).confirmations.map((c) => [c.id, c.status, Boolean(c.consumedAt)])).toEqual([
      ["cf1", "approved", true],
      ["cf2", "rejected", false],
    ]);
    expect(h.rebuild(id)).toEqual(h.card(id));
  });

  it("detail 的校验：空/太短/太长都拒，合法的会 trim", () => {
    const base = { cmd: "requestConfirm", actor: HUMAN, card: "c1", action: "push" } as const;
    expect(commandSchema.safeParse({ ...base, detail: "" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...base, detail: "   \n  " }).success).toBe(false);
    expect(commandSchema.safeParse({ ...base, detail: "git push" }).success).toBe(false);
    expect(commandSchema.safeParse({ ...base, detail: "x".repeat(2001) }).success).toBe(false);
    expect(commandSchema.safeParse({ ...base, detail: DETAIL, action: "发布" }).success).toBe(false);

    const trimmed = commandSchema.safeParse({ ...base, detail: `  ${DETAIL}\n` });
    if (!trimmed.success || trimmed.data.cmd !== "requestConfirm") {
      throw new Error(`requestConfirm 应该解析成功，却拿到：${JSON.stringify(trimmed)}`);
    }
    expect(trimmed.data.detail).toBe(DETAIL);
  });
});

describe("远程写确认的幂等与落盘", () => {
  it("同一条申请重复发送不产生第二条；settle 之后同样的申请是新的一条", () => {
    const store = freshStore();
    const at = (n: number) => `2026-10-10T00:00:0${n}.000Z`;
    const id = store.execute({ cmd: "open", actor: HUMAN, title: "幂等", body: "" }, at(0))
      .outcome.primaryCardId;
    const request: Command = {
      cmd: "requestConfirm",
      actor: HUMAN,
      card: id,
      action: "push",
      detail: DETAIL,
    };

    const first = store.execute(request, at(1));
    expect(first.inserted).toHaveLength(1);
    const retry = store.execute(request, at(2));
    expect(retry.inserted).toHaveLength(0);
    expect(retry.duplicates).toBe(1);
    expect(store.getCard(id)?.confirmations).toHaveLength(1);

    store.execute({ cmd: "decideConfirm", actor: HUMAN, card: id, id: "cf1", decision: "approved" }, at(3));
    const approveRetry = store.execute(
      { cmd: "decideConfirm", actor: HUMAN, card: id, id: "cf1", decision: "approved" },
      at(4),
    );
    expect(approveRetry.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");

    store.execute({ cmd: "consumeConfirm", actor: HUMAN, card: id, id: "cf1" }, at(5));
    const consumeRetry = store.execute({ cmd: "consumeConfirm", actor: HUMAN, card: id, id: "cf1" }, at(6));
    expect(consumeRetry.outcome.rejection?.code).toBe("STATE_NOT_ALLOWED");

    const again = store.execute(request, at(7));
    expect(again.inserted).toHaveLength(1);
    expect(store.getCard(id)?.confirmations.map((c) => c.id)).toEqual(["cf1", "cf2"]);

    const before = store.getCard(id);
    expect(store.rebuild()).toBe(1);
    expect(store.getCard(id)).toEqual(before);
    store.close();
  });
});
