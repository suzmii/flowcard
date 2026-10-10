/** HTTP 层：契约、状态码、校验与 SSE —— 另外两个 agent 都依赖这层，先钉住。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
