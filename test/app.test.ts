/** HTTP 层：契约、状态码、校验与 SSE —— 另外两个 agent 都依赖这层，先钉住。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createStore } from "../src/server/store.ts";
import type { Command } from "../src/shared/types.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

/** 响应契约：边界数据一律先解析再读，别用断言把未知结构当成已知。 */
const commandResponse = z.object({
  ok: z.boolean(),
  card: z.object({ id: z.string(), state: z.string() }).optional(),
  inserted: z.number(),
  duplicates: z.number(),
  notes: z.array(z.string()),
  rejection: z.object({ code: z.string(), message: z.string() }).optional(),
  blocked: z
    .object({ transition: z.string(), missing: z.array(z.string()), describe: z.array(z.string()) })
    .optional(),
});

function harness() {
  const store = createStore({
    dataDir: mkdtempSync(join(tmpdir(), "flowcard-app-")),
    flow: personalFlow,
  });
  return { app: createApp(store), store };
}

async function post(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: commandResponse.parse(await res.json()) };
}

describe("HTTP 接口", () => {
  it("走完一条完整链路（含状态码与幂等计数）", async () => {
    const { app } = harness();
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "接口链路", body: "" });
    expect(opened.status).toBe(200);
    const id = opened.data.card?.id ?? "";
    expect(id).not.toBe("");

    const planned = await post(app, { cmd: "plan", actor: HUMAN, card: id, body: "方案" });
    expect(planned.status).toBe(200);
    expect(planned.data.card?.state).toBe("issue");

    // 没绑 Issue → 门禁拒绝，且什么都没写
    const rejected = await post(app, {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G1",
      decision: "approved",
    });
    expect(rejected.status).toBe(409);
    expect(rejected.data.rejection?.code).toBe("MISSING_REQUIREMENT");
    expect(rejected.data.inserted).toBe(0);

    const bound = await post(app, {
      cmd: "bindIssue",
      actor: HUMAN,
      card: id,
      issue: { repo: "r", number: 1, url: "http://i/1", state: "open" },
    });
    expect(bound.status).toBe(200);

    const approved = await post(app, {
      cmd: "decideGate",
      actor: HUMAN,
      card: id,
      gate: "G1",
      decision: "approved",
    });
    expect(approved.status).toBe(200);
    expect(approved.data.card?.state).toBe("ready");
  });

  it("非法 body 回 400 且给出人话原因", async () => {
    const { app } = harness();
    const bad = await post(app, { cmd: "open", actor: HUMAN });
    expect(bad.status).toBe(400);
    expect(bad.data.rejection?.code).toBe("USAGE_ERROR");
    expect(bad.data.rejection?.message).toContain("title");
  });

  it("未知卡片回 404", async () => {
    const { app } = harness();
    const res = await app.request("/api/cards/nope");
    expect(res.status).toBe(404);
  });

  it("缺必要条件时 200 + blocked（事实照样落库）", async () => {
    const { app, store } = harness();
    const opened = await post(app, {
      cmd: "open",
      actor: HUMAN,
      title: "缺项",
      body: "",
      issue: { repo: "r", number: 1, url: "http://i/1", state: "open" },
    });
    const id = opened.data.card?.id ?? "";

    // 先走到 ready（Issue + 方案批准 + worktree + PR），这样 claim 才可能触发转换
    await post(app, { cmd: "plan", actor: HUMAN, card: id, body: "方案" });
    await post(app, { cmd: "decideGate", actor: HUMAN, card: id, gate: "G1", decision: "approved" });
    await post(app, {
      cmd: "worktree",
      actor: HUMAN,
      card: id,
      worktree: { path: "/w/card", branch: "feat/x", source: "flowcard" },
    });
    await post(app, {
      cmd: "bindPr",
      actor: HUMAN,
      card: id,
      pr: { repo: "r", number: 2, url: "http://p/2", branch: "feat/x", state: "open" },
    });

    const res = await post(app, {
      cmd: "claim",
      actor: HUMAN,
      card: id,
      session: { harness: "omp", id: "s1", cwd: "/tmp", agentKind: "main" },
    });
    expect(res.status).toBe(200);
    expect(res.data.blocked?.missing).toContain("sessionInWorktree");
    expect(store.getCard(id)?.session?.id).toBe("s1");
  });

  it("重复的同一条命令只写一次（幂等计数可见）", async () => {
    const { app } = harness();
    const cmd: Command = { cmd: "open", actor: HUMAN, title: "重复", body: "" };
    const first = await post(app, cmd);
    const second = await post(app, cmd);
    expect(first.data.inserted).toBeGreaterThan(0);
    expect(second.data.inserted).toBe(0);
    expect(second.data.duplicates).toBeGreaterThan(0);
  });

  it("SSE 会推送 changed 事件", async () => {
    const { app } = harness();
    const res = await app.request("/api/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("没有可读的 SSE body");
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("hello");

    await post(app, { cmd: "open", actor: HUMAN, title: "推给我", body: "" });
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain("changed");
    expect(second).toContain("card.opened");
    await reader.cancel();
  });

  it("rebuild 不改投影（HTTP 也能触发）", async () => {
    const { app, store } = harness();
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "重放", body: "" });
    const id = opened.data.card?.id ?? "";
    const before = store.getCard(id);
    const res = await app.request("/api/rebuild", { method: "POST" });
    expect(res.status).toBe(200);
    expect(store.getCard(id)).toEqual(before);
  });
});
