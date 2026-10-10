/** 存储层的行为：幂等、投影 == 重放、跨重启一致。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createStore } from "../src/server/store.ts";
import type { Command } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const issue = { repo: "r", number: 1, url: "http://i/1", state: "open" as const };
const worktree = {
  path: "/w/card",
  branch: "feat/card",
  source: "flowcard" as const,
};
const pr = {
  repo: "r",
  number: 2,
  url: "http://p/2",
  branch: "feat/card",
  state: "open" as const,
};

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "flowcard-test-"));
  return createStore({ dataDir: dir, flow: personalFlow });
}

describe("存储", () => {
  it("同一条命令重放不会写出第二条事件", () => {
    const store = freshStore();
    const open: Command = { cmd: "open", actor: HUMAN, title: "幂等", body: "" };
    const first = store.execute(open, "2026-10-10T00:00:00.000Z");
    const again = store.execute(open, "2026-10-10T00:00:05.000Z");

    expect(first.inserted.length).toBeGreaterThan(0);
    expect(again.inserted).toHaveLength(0);
    expect(again.duplicates).toBeGreaterThan(0);
    expect(store.listEvents()).toHaveLength(first.inserted.length);
    store.close();
  });

  it("投影等于从零重放，且 rebuild 不改结果", () => {
    const store = freshStore();
    const id = store.execute(
      { cmd: "open", actor: HUMAN, title: "重放", body: "", issue },
      "2026-10-10T00:00:00.000Z",
    ).outcome.primaryCardId;

    store.execute({ cmd: "plan", actor: HUMAN, card: id, body: "方案" }, "2026-10-10T00:00:01.000Z");
    store.execute(
      { cmd: "decideGate", actor: HUMAN, card: id, gate: "G1", decision: "approved" },
      "2026-10-10T00:00:02.000Z",
    );
    store.execute({ cmd: "worktree", actor: HUMAN, card: id, worktree }, "2026-10-10T00:00:03.000Z");
    store.execute({ cmd: "bindPr", actor: HUMAN, card: id, pr }, "2026-10-10T00:00:04.000Z");
    store.execute(
      {
        cmd: "claim",
        actor: HUMAN,
        card: id,
        session: {
          harness: "omp",
          id: "s1",
          cwd: `${worktree.path}/x`,
          agentKind: "main",
        },
      },
      "2026-10-10T00:00:05.000Z",
    );

    const before = store.getCard(id);
    expect(before?.state).toBe("working");

    expect(store.rebuild()).toBe(1);
    expect(store.getCard(id)).toEqual(before);
    store.close();
  });

  it("被拒的命令不写任何东西", () => {
    const store = freshStore();
    const id = store.execute(
      { cmd: "open", actor: HUMAN, title: "拒绝", body: "" },
      "2026-10-10T00:00:00.000Z",
    ).outcome.primaryCardId;

    const rejected = store.execute(
      { cmd: "cleanup", actor: HUMAN, card: id },
      "2026-10-10T00:00:01.000Z",
    );

    expect(rejected.outcome.rejection?.code).toBe("GATE_PENDING");
    expect(rejected.inserted).toHaveLength(0);
    expect(store.listEvents().filter((e) => e.cardId === id)).toHaveLength(1);
    store.close();
  });

  it("重启后卡片仍在（事件落盘）", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowcard-persist-"));
    const first = createStore({ dataDir: dir, flow: personalFlow });
    const id = first.execute(
      { cmd: "open", actor: HUMAN, title: "持久化", body: "" },
      "2026-10-10T00:00:00.000Z",
    ).outcome.primaryCardId;
    first.close();

    const second = createStore({ dataDir: dir, flow: personalFlow });
    expect(second.getCard(id)?.title).toBe("持久化");
    second.close();
  });
});
