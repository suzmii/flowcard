/** HTTP 层：契约、状态码、校验与 SSE —— 另外两个 agent 都依赖这层，先钉住。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Hono } from "hono";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createStore, type Store } from "../src/server/store.ts";
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
  it("走完一条完整链路（含状态码、非法命令与幂等计数）", async () => {
    const { app } = harness();
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "接口链路", body: "" });
    expect(opened.status).toBe(200);
    const id = opened.data.card?.id ?? "";
    expect(id).not.toBe("");
    // 建卡即 ready：没有额外的中转层
    expect(opened.data.card?.state).toBe("ready");

    const bound = await post(app, {
      cmd: "bindIssue",
      actor: HUMAN,
      card: id,
      number: 1,
      repo: "r",
      url: "http://i/1",
    });
    expect(bound.status).toBe(200);
    expect(bound.data.card?.state).toBe("ready");

    // 已删掉的命令（plan / triage）现在只是非法输入
    for (const cmd of ["plan", "triage"]) {
      const gone = await post(app, { cmd, actor: HUMAN, card: id, body: "x" });
      expect(gone.status).toBe(400);
      expect(gone.data.rejection?.code).toBe("USAGE_ERROR");
      expect(gone.data.inserted).toBe(0);
    }

    const worktree = {
      path: "/w/card",
      branch: "feat/x",
      source: "flowcard" as const,
    };
    const wt = await post(app, { cmd: "worktree", actor: HUMAN, card: id, worktree });
    expect(wt.status).toBe(200);
    // 同一条事实命令重发不写第二条事件（幂等靠 dedupeKey）
    const first = await post(app, { cmd: "comment", actor: HUMAN, card: id, body: "同一条评论" });
    const again = await post(app, { cmd: "comment", actor: HUMAN, card: id, body: "同一条评论" });
    expect(first.data.inserted).toBe(1);
    expect(again.data.inserted).toBe(0);
    expect(again.data.duplicates).toBeGreaterThan(0);

    // 会话进入 worktree → 自动 working（不需要任何人工批准）
    const claimed = await post(app, {
      cmd: "claim",
      actor: HUMAN,
      card: id,
      session: { harness: "omp", id: "s1", cwd: "/w/card/x", agentKind: "main" },
    });
    expect(claimed.status).toBe(200);
    expect(claimed.data.card?.state).toBe("working");
  });

  it("非法 body 回 400 且给出人话原因", async () => {
    const { app } = harness();
    // 标题从 M7 起是可选的（不给就按正文派生），所以拿类型不对的 title 当非法输入。
    const bad = await post(app, { cmd: "open", actor: HUMAN, title: 42 });
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

    // 建卡即 ready（Issue 只是槽位）：建好 worktree 后，会话没进去就不算开工
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

  it("软删除的卡默认不进列表，?includeDeleted=1 能看到（并可恢复）", async () => {
    const { app } = harness();
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "删我", body: "" });
    const id = opened.data.card?.id ?? "";
    await post(app, { cmd: "delete", actor: HUMAN, card: id, reason: "建错了" });

    const hidden = (await (await app.request("/api/cards")).json()) as { cards: { id: string }[] };
    expect(hidden.cards.map((c) => c.id)).not.toContain(id);

    const shown = (await (await app.request("/api/cards?includeDeleted=1")).json()) as {
      cards: { id: string; deletedAt?: string }[];
    };
    expect(shown.cards.find((c) => c.id === id)?.deletedAt).toBeDefined();

    await post(app, { cmd: "restore", actor: HUMAN, card: id });
    const back = (await (await app.request("/api/cards")).json()) as { cards: { id: string }[] };
    expect(back.cards.map((c) => c.id)).toContain(id);
  });

  it("跨站请求一律拒（回环 ≠ 可信）：Sec-Fetch-Site / Origin 两道闸", async () => {
    const { app } = harness();
    const body = JSON.stringify({ cmd: "open", actor: HUMAN, title: "跨站", body: "x" });

    const crossSite = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body,
    });
    expect(crossSite.status).toBe(403);

    const foreignOrigin = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body,
    });
    expect(foreignOrigin.status).toBe(403);

    // 本页（同源，无 Sec-Fetch、Origin 是回环）照常放行
    const ok = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:47825", "sec-fetch-site": "same-origin" },
      body,
    });
    expect(ok.status).toBe(200);
  });

  it("写接口只收 application/json（挡跨站简单请求）", async () => {
    const { app } = harness();
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ cmd: "open", actor: HUMAN, title: "text/plain", body: "x" }),
    });
    expect(res.status).toBe(415);
  });

  it("events 的 limit 收敛：负数不会把整部历史倒出来", async () => {
    const { app } = harness();
    for (let i = 0; i < 5; i++) {
      await post(app, { cmd: "open", actor: HUMAN, title: `卡 ${i}`, body: "" });
    }
    const all = (await (await app.request("/api/events?limit=1000")).json()) as { events: { type: string }[] };
    expect(all.events.length).toBe(5);

    // 负 LIMIT 在 SQLite 里是"无上限"：不能原样透传（否则一次性倒出整部历史）
    const negative = (await (await app.request("/api/events?limit=-1")).json()) as { events: unknown[] };
    expect(negative.events.length).toBe(5);

    const small = (await (await app.request("/api/events?limit=2")).json()) as { events: unknown[] };
    expect(small.events.length).toBe(2);
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

/** POST /api/projects/:id/issue-base 的响应体（只取要断言的字段）。 */
const issueBaseResponse = z.object({
  project: z.object({
    id: z.string(),
    issueRepo: z.string().optional(),
    issueUrlTemplate: z.string().optional(),
  }),
});

describe("Issue 基址（项目层）", () => {
  /** 造一个项目（不碰 git：这里只关心基址字段的读写）。 */
  function seedProject(store: Store, path: string) {
    return store.upsertProject({
      id: "repo-0001",
      name: "repo",
      path,
      addedAt: "2026-10-10T00:00:00.000Z",
      lastSeenAt: "2026-10-10T00:00:00.000Z",
    }).project;
  }

  async function postIssueBase(app: Hono, id: string, body: unknown) {
    const res = await app.request(`/api/projects/${id}/issue-base`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  it("设置 / 只更新给的那条 / clear 清空", async () => {
    const { app, store } = harness();
    const project = seedProject(store, "/tmp/fc-issue-base-a");

    const set = await postIssueBase(app, project.id, {
      issueRepo: "o/r",
      issueUrlTemplate: "https://h/o/r/issues/{number}",
    });
    expect(set.status).toBe(200);
    const setData = issueBaseResponse.parse(await set.json());
    expect(setData.project.issueRepo).toBe("o/r");
    expect(setData.project.issueUrlTemplate).toBe("https://h/o/r/issues/{number}");
    expect(store.getProject(project.id)?.issueUrlTemplate).toBe("https://h/o/r/issues/{number}");

    // 只给 issueRepo：模板保持不动
    const patch = await postIssueBase(app, project.id, { issueRepo: "x/y" });
    expect(patch.status).toBe(200);
    const patched = issueBaseResponse.parse(await patch.json());
    expect(patched.project.issueRepo).toBe("x/y");
    expect(patched.project.issueUrlTemplate).toBe("https://h/o/r/issues/{number}");

    const cleared = await postIssueBase(app, project.id, { clear: true });
    expect(cleared.status).toBe(200);
    const clearedData = issueBaseResponse.parse(await cleared.json());
    expect(clearedData.project.issueRepo).toBeUndefined();
    expect(clearedData.project.issueUrlTemplate).toBeUndefined();
    expect(store.getProject(project.id)?.issueRepo).toBeUndefined();
  });

  it("项目不存在 → 404；body 非法 → 400", async () => {
    const { app, store } = harness();
    const missing = await postIssueBase(app, "nope-0000", { issueRepo: "o/r" });
    expect(missing.status).toBe(404);

    const project = seedProject(store, "/tmp/fc-issue-base-b");
    const bad = await postIssueBase(app, project.id, { issueRepo: 42 });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("USAGE_ERROR");
    expect(body.error.message).toContain("issueRepo");
    expect(store.getProject(project.id)?.issueRepo).toBeUndefined();
  });

  it("配好基址后，bindIssue 只给 number 就补齐（HTTP 端到端）", async () => {
    const { app, store } = harness();
    const project = seedProject(store, "/tmp/fc-issue-base-c");
    await postIssueBase(app, project.id, {
      issueRepo: "git/owner/repo",
      issueUrlTemplate: "https://gitea.example.com/git/owner/repo/issues/{number}",
    });

    const opened = await post(app, {
      cmd: "open",
      actor: HUMAN,
      title: "带项目开卡",
      body: "",
      projectId: project.id,
    });
    const id = opened.data.card?.id ?? "";

    const bound = await post(app, { cmd: "bindIssue", actor: HUMAN, card: id, number: 742 });
    expect(bound.status).toBe(200);
    expect(store.getCard(id)?.issue).toEqual({
      repo: "git/owner/repo",
      number: 742,
      url: "https://gitea.example.com/git/owner/repo/issues/742",
      state: "open",
    });

    // 没有基址的项目（合成项目 local）：只给编号 → 400 + USAGE_ERROR
    const localCard = await post(app, { cmd: "open", actor: HUMAN, title: "没归属", body: "" });
    const localId = localCard.data.card?.id ?? "";
    const rejected = await post(app, { cmd: "bindIssue", actor: HUMAN, card: localId, number: 1 });
    expect(rejected.status).toBe(400);
    expect(rejected.data.rejection?.code).toBe("USAGE_ERROR");
    expect(store.getCard(localId)?.issue).toBeNull();
  });
});

/**
 * 验收（G3）：`accept` 是**唯一**能让人推进 `review → merged` 的动作。
 * 投影里不存在「未决的 G3」——accept 一次合成 requested + decided，所以看板必须给它一个按钮
 * （而不是在门禁区等一个永远不会出现的未决门禁）。
 */
describe("验收（accept）", () => {
  const cardState = z.looseObject({
    card: z.looseObject({
      state: z.string(),
      acceptedAt: z.string().optional(),
      gates: z.record(z.string(), z.looseObject({ id: z.string(), status: z.string() })),
    }),
  });

  /** 走到「待验收」：worktree → 会话进 worktree → WIP PR → 推送 → 结束会话。 */
  async function toReview(app: Hono, prState: "open" | "merged") {
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "待验收", body: "" });
    const id = opened.data.card?.id ?? "";
    await post(app, {
      cmd: "worktree",
      actor: HUMAN,
      card: id,
      worktree: { path: "/w/card", branch: "feat/x", source: "flowcard" },
    });
    await post(app, {
      cmd: "claim",
      actor: HUMAN,
      card: id,
      session: { harness: "omp", id: "s1", cwd: "/w/card/x", agentKind: "main" },
    });
    await post(app, {
      cmd: "bindPr",
      actor: HUMAN,
      card: id,
      pr: { repo: "r", number: 7, url: "http://p/7", branch: "feat/x", state: prState },
    });
    await post(app, { cmd: "push", actor: HUMAN, card: id, sha: "abc123" });
    const ended = await post(app, { cmd: "end", actor: HUMAN, card: id, sessionId: "s1" });
    expect(ended.data.card?.state).toBe("review");
    return id;
  }

  async function readCard(app: Hono, id: string) {
    const res = await app.request(`/api/cards/${id}`);
    expect(res.status).toBe(200);
    return cardState.parse(await res.json()).card;
  }

  it("PR 已合并时：accept 直接把卡片推到 merged，并打开 G4", async () => {
    const { app } = harness();
    const id = await toReview(app, "merged");

    const accepted = await post(app, { cmd: "accept", actor: HUMAN, card: id });
    expect(accepted.status).toBe(200);
    expect(accepted.data.card?.state).toBe("merged");

    const card = await readCard(app, id);
    expect(card.acceptedAt).toBeTruthy();
    expect(card.gates["G3"]?.status).toBe("approved");
    expect(card.gates["G4"]?.status).toBe("open");
  });

  it("PR 还没合并时：accept 记下验收，但状态仍停在 review（缺 prMerged）", async () => {
    const { app } = harness();
    const id = await toReview(app, "open");

    const accepted = await post(app, { cmd: "accept", actor: HUMAN, card: id });
    expect(accepted.status).toBe(200);
    // 事实照样落库：验收已记，卡不前进只是因为 review -> merged 还缺 prMerged
    expect(accepted.data.card?.state).toBe("review");
    expect(accepted.data.notes.join(" ")).toContain("prMerged");

    const card = await readCard(app, id);
    expect(card.acceptedAt).toBeTruthy();
    expect(card.gates["G3"]?.status).toBe("approved");
    // 既有行为（本次不动）：automation 的 do 是逐条跑的 —— setState 被 requires 拦下后，
    // 后面的 openGate G4 照样执行了，所以卡片停在 review 但 G4 已经开着。清理确认提前可见无害。
    expect(card.gates["G4"]?.status).toBe("open");
  });
});

/** 会话失联：投影只写 running/ended，读接口按 `lastSeenAt` 与读取时刻推导 `lost`。 */
describe("会话失联（读接口推导）", () => {
  const cardsResponse = z.looseObject({
    cards: z.array(
      z.looseObject({
        id: z.string(),
        session: z.looseObject({ state: z.string(), lastSeenAt: z.string() }).nullable(),
      }),
    ),
  });

  it("心跳过期（>90s）→ 卡片接口把会话改判成 lost；没过期仍是 running", async () => {
    const { app } = harness();
    const opened = await post(app, { cmd: "open", actor: HUMAN, title: "心跳", body: "" });
    const id = opened.data.card?.id ?? "";
    await post(app, {
      cmd: "claim",
      actor: HUMAN,
      card: id,
      session: { harness: "omp", id: "s1", cwd: "/w/c", agentKind: "main" },
    });

    const fresh = await app.request("/api/cards");
    const freshCard = cardsResponse.parse(await fresh.json()).cards.find((c) => c.id === id);
    expect(freshCard?.session?.state).toBe("running");

    // 不真等 90s：把「读取时刻」往后拨，正是推导所依赖的唯一输入
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91_000);
    try {
      const stale = await app.request("/api/cards");
      const staleCard = cardsResponse.parse(await stale.json()).cards.find((c) => c.id === id);
      expect(staleCard?.session?.state).toBe("lost");
      expect(staleCard?.session?.lastSeenAt).toBe(freshCard?.session?.lastSeenAt);

      const one = await app.request(`/api/cards/${id}`);
      const oneCard = z
        .looseObject({ card: z.looseObject({ session: z.looseObject({ state: z.string() }).nullable() }) })
        .parse(await one.json()).card;
      expect(oneCard.session?.state).toBe("lost");
    } finally {
      spy.mockRestore();
    }
  });
});
