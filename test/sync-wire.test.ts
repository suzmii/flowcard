/**
 * 同步接线：两个新事件的投影（含 rebuild 一致）、`markRemoteCommentsRead` 幂等、
 * PR 状态推进（draft 不被 open 覆盖）、store 的 `lastSyncAt` / since 游标、
 * 两个 HTTP 端点（无凭据降级 + token 不泄漏）、调度器一轮的调用面（注入假 http）。
 *
 * 全程离线：远程一律是注入的假 `http` / 假 `run`，没有真网络。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import type { Hono } from "hono";
import { createApp, type AppOptions } from "../src/server/app.ts";
import { nextPrState } from "../src/server/engine.ts";
import { createStore, type Store } from "../src/server/store.ts";
import { runSyncRound, sinceFrom, startSyncScheduler, trackedNumbers } from "../src/server/syncer.ts";
import type { HttpGet, SyncFact } from "../src/server/sync.ts";
import type { Run } from "../src/server/probe.ts";
import { commandSchema, type Command, type Project } from "../src/shared/types.ts";
import { createHarness, issueRef, prRef, worktreeRef, type Harness } from "./harness.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const SYSTEM = { kind: "system" as const };
/** 只在假茶配置里出现；任何响应体/日志里再出现它就是泄漏。 */
const SECRET = "s3cr3t-token-value";

const issueFact = (
  over: Partial<Extract<SyncFact, { kind: "issue.state" }>> = {},
): Extract<SyncFact, { kind: "issue.state" }> => ({
  kind: "issue.state",
  number: issueRef.number,
  state: "closed",
  title: "改过的标题",
  updatedAt: "2026-10-10T01:00:00.000Z",
  ...over,
});

const prFact = (
  over: Partial<Extract<SyncFact, { kind: "pr.state" }>> = {},
): Extract<SyncFact, { kind: "pr.state" }> => ({
  kind: "pr.state",
  number: prRef.number,
  state: "open",
  merged: false,
  head: prRef.branch,
  base: "master",
  url: prRef.url,
  updatedAt: "2026-10-10T02:00:00.000Z",
  ...over,
});

const commentFact = (
  over: Partial<Extract<SyncFact, { kind: "remote.comment" }>> = {},
): Extract<SyncFact, { kind: "remote.comment" }> => ({
  kind: "remote.comment",
  id: 7471,
  issueNumber: issueRef.number,
  author: "lhk229",
  body: "两条审查问题都修了",
  at: "2026-10-09T07:22:19.000Z",
  url: "https://git.example.com/git/Team/Repo/issues/42#issuecomment-7471",
  ...over,
});

function freshStore(): Store {
  return createStore({ dataDir: mkdtempSync(join(tmpdir(), "flowcard-wire-")), flow: personalFlow });
}

// ---------------------------------------------------------------- 投影

describe("同步事件的投影", () => {
  it("issue.state.changed 更新 state/title，closed 不动 repo/url；rebuild 与投影一致", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "同步", body: "", issue: issueRef }).primaryCardId;

    const out = h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [issueFact()] });

    expect(out.events.map((e) => e.type)).toEqual(["issue.state.changed"]);
    expect(out.events[0]!.dedupeKey).toBe(`sync:issue:${issueRef.number}:2026-10-10T01:00:00.000Z`);
    const card = h.card(id);
    expect(card.issue).toEqual({ ...issueRef, state: "closed", title: "改过的标题" });
    // 其余字段（repo/url）原样保留：闭掉不等于清空
    expect(card.issue?.repo).toBe(issueRef.repo);
    expect(card.issue?.url).toBe(issueRef.url);
    expect(h.rebuild(id)).toEqual(card);
  });

  it("remote.comment.added 落成未读一条，重复 id 只投影一次；rebuild 与投影一致", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "评论", body: "", issue: issueRef }).primaryCardId;

    h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [commentFact(), commentFact({ id: 7472, body: "第二条" })] });
    expect(h.card(id).remoteComments.map((c) => c.id)).toEqual([7471, 7472]);
    expect(h.card(id).remoteComments.every((c) => !c.read)).toBe(true);
    expect(h.card(id).remoteComments[0]!.issueNumber).toBe(issueRef.number);
    expect(h.rebuild(id)).toEqual(h.card(id));

    // 同一个 fact 再来一次：幂等键挡住（不是"再落一条"）
    const again = h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [commentFact()] });
    expect(again.events[0]!.dedupeKey).toBe("sync:comment:7471");
    expect(h.card(id).remoteComments).toHaveLength(2);
  });

  it("编号与卡片对不上就不落（事实按编号路由，投影层只兜底）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "别的卡", body: "", issue: issueRef }).primaryCardId;
    const out = h.run({
      cmd: "applySync",
      actor: SYSTEM,
      card: id,
      facts: [issueFact({ number: 9999 }), prFact({ number: 9999 })],
    });
    expect(out.events).toHaveLength(0);
  });

  it("markRemoteCommentsRead 幂等：标一次就够，第二次没有未读 → 不发事件", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "已读", body: "", issue: issueRef }).primaryCardId;
    h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [commentFact(), commentFact({ id: 7472 })] });

    const first = h.run({ cmd: "markRemoteCommentsRead", actor: HUMAN, card: id });
    expect(first.events.map((e) => e.type)).toEqual(["remote.comments.read"]);
    expect(first.events[0]!.payload["ids"]).toEqual([7471, 7472]);
    expect(h.card(id).remoteComments.every((c) => c.read)).toBe(true);
    expect(h.rebuild(id)).toEqual(h.card(id));

    const second = h.run({ cmd: "markRemoteCommentsRead", actor: HUMAN, card: id });
    expect(second.events).toHaveLength(0);
    expect(second.notes).toContain("没有未读的远端评论，跳过");

    // 只标指定的那几条（ids 给了就只动这些）
    h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [commentFact({ id: 7473 })] });
    h.run({ cmd: "markRemoteCommentsRead", actor: HUMAN, card: id, ids: [7473] });
    expect(h.card(id).remoteComments.filter((c) => c.read).map((c) => c.id)).toEqual([7471, 7472, 7473]);
    expect(h.rebuild(id)).toEqual(h.card(id));
  });
});

// ---------------------------------------------------------------- PR 状态推进

/** 把一张卡推到 `review` 并且已验收（G3 过了），PR 还开着。 */
function reviewedCard(h: Harness): string {
  const id = h.run({ cmd: "open", actor: h.human, title: "PR 合并", body: "" }).primaryCardId;
  h.run({ cmd: "worktree", actor: h.agent, card: id, worktree: worktreeRef });
  h.run({
    cmd: "claim",
    actor: h.agent,
    card: id,
    session: { harness: "omp", id: "sess-1", agentKind: "main", cwd: `${worktreeRef.path}/src` },
  });
  h.run({ cmd: "bindPr", actor: h.human, card: id, pr: { ...prRef, state: "open" } });
  h.run({ cmd: "push", actor: h.agent, card: id, sha: "a".repeat(40) });
  h.run({ cmd: "end", actor: h.agent, card: id });
  h.run({ cmd: "accept", actor: h.human, card: id });
  return id;
}

describe("同步事实推进 PR 状态", () => {
  it("pr.merged 能把 review → merged 推下去（前提：已验收），并开 G4", () => {
    const h = createHarness();
    const id = reviewedCard(h);
    // 只验收、PR 还没合并：进不了 merged（但验收那一步已经把 G4 开出来了）
    expect(h.card(id).state).toBe("review");
    expect(h.card(id).gates["G4"]?.status).toBe("open");

    const out = h.run({
      cmd: "applySync",
      actor: SYSTEM,
      card: id,
      facts: [prFact({ state: "merged", merged: true })],
    });

    expect(out.events.map((e) => e.type)).toEqual(["pr.merged", "card.state.changed"]);
    expect(h.card(id).pr?.state).toBe("merged");
    expect(h.card(id).state).toBe("merged");
    expect(h.card(id).gates["G4"]?.status).toBe("open");
    expect(h.rebuild(id)).toEqual(h.card(id));
  });

  it("draft 不被 open 覆盖，也不会被当成合并", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "草稿 PR", body: "" }).primaryCardId;
    h.run({ cmd: "bindPr", actor: h.human, card: id, pr: { ...prRef, state: "draft" } });

    const out = h.run({ cmd: "applySync", actor: SYSTEM, card: id, facts: [prFact({ state: "open" })] });

    expect(out.events.map((e) => e.type)).toEqual(["pr.updated"]);
    expect(h.card(id).pr?.state).toBe("draft");
    expect(h.card(id).state).not.toBe("merged");
    expect(h.rebuild(id)).toEqual(h.card(id));
  });

  it("nextPrState：不拿更弱的信息覆盖更强的已知事实", () => {
    const base = prFact();
    expect(nextPrState({ ...prRef, state: "draft" }, base)).toBe("draft");
    expect(nextPrState({ ...prRef, state: "draft" }, { ...base, state: "merged", merged: true })).toBe("merged");
    // tea CLI 兜底：merged 位拿不到（null），已合并的 PR 只报 closed —— 不许把它降回 closed
    expect(nextPrState({ ...prRef, state: "merged" }, { ...base, state: "closed", merged: null })).toBe("merged");
    expect(nextPrState({ ...prRef, state: "open" }, { ...base, state: "closed", merged: null })).toBe("closed");
  });
});

// ---------------------------------------------------------------- store 游标

describe("同步状态的持久化", () => {
  it("lastSyncAt 按项目记住，rebuild 不动它；since 游标 = lastSyncAt - 60s", () => {
    const store = freshStore();
    const id = store.execute({ cmd: "open", actor: HUMAN, title: "游标", body: "" }, "2026-10-10T00:00:00.000Z")
      .outcome.primaryCardId;

    expect(store.getSyncState("p1")).toBeUndefined();
    store.setSyncState("p1", {
      at: "2026-10-10T10:00:00.000Z",
      degraded: [],
      notes: ["一轮"],
      counts: { issues: 1, pulls: 1, comments: 2 },
      prev: { commentKeys: ["sync:comment:7471"] },
    });

    expect(store.getSyncState("p1")?.at).toBe("2026-10-10T10:00:00.000Z");
    expect(sinceFrom(store.getSyncState("p1")!.at)).toBe("2026-10-10T09:59:00.000Z");
    expect(sinceFrom(undefined)).toBeNull();
    // 另一个项目不受影响（按项目分开）
    expect(store.getSyncState("p2")).toBeUndefined();

    store.rebuild();
    expect(store.getSyncState("p1")?.prev?.commentKeys).toEqual(["sync:comment:7471"]);
    expect(store.getCard(id)).toBeDefined();
    store.close();
  });

  it("meta 里的值被写坏时当「没同步过」，不让同步整个停掉", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowcard-wire-"));
    const store = createStore({ dataDir: dir, flow: personalFlow });
    store.close();

    const db = new DatabaseSync(join(dir, "flowcard.sqlite"));
    db.prepare("INSERT INTO meta (key, value) VALUES ('sync:p1', ?)").run("{ 不是 JSON");
    db.close();

    const reopened = createStore({ dataDir: dir, flow: personalFlow });
    expect(reopened.getSyncState("p1")).toBeUndefined();
    reopened.close();
  });

  it("trackedNumbers 只收卡片上真绑了的编号（issue ∪ pr，去重排序）", () => {
    const h = createHarness();
    const id = h.run({ cmd: "open", actor: h.human, title: "绑了两样", body: "", issue: issueRef }).primaryCardId;
    h.run({ cmd: "bindPr", actor: h.human, card: id, pr: prRef });
    const cards = [h.card(id)];
    expect(trackedNumbers(cards)).toEqual({ issues: [issueRef.number], pulls: [prRef.number] });
  });
});

// ---------------------------------------------------------------- 同步一轮（注入假 http）

const REMOTE = "https://forge.example.com/git/Team/Repo";
const API = "https://forge.example.com/git/api/v1/repos/Team/Repo";

const TEA_CONFIG = [
  "logins:",
  "  - name: forge",
  "    url: https://forge.example.com/git",
  `    token: ${SECRET}`,
].join("\n");

const PROJECT: Project = {
  id: "proj-team",
  name: "Repo",
  path: "/tmp/fc-wire-repo",
  remote: REMOTE,
  issueRepo: "Team/Repo",
  issueUrlTemplate: `${REMOTE}/issues/{number}`,
  addedAt: "2026-10-10T00:00:00.000Z",
  lastSeenAt: "2026-10-10T00:00:00.000Z",
};

const ISSUE_JSON = JSON.stringify({
  number: issueRef.number,
  title: "游玩页启动超时",
  state: "open",
  updated_at: "2026-10-09T09:21:33+08:00",
  comments: 0,
});
const PULL_JSON = JSON.stringify({
  number: prRef.number,
  state: "open",
  merged: false,
  head: { label: prRef.branch, ref: "refs/pull/77/head" },
  base: { label: "master" },
  updated_at: "2026-10-10T04:42:54Z",
  html_url: `${REMOTE}/pulls/77`,
});
const COMMENTS_JSON = JSON.stringify([
  {
    id: 7471,
    issue_url: `${REMOTE}/issues/42`,
    user: { login: "lhk229" },
    body: "两条审查问题都修了",
    created_at: "2026-10-09T07:22:19Z",
    html_url: `${REMOTE}/issues/42#issuecomment-7471`,
  },
  // 没绑编号的评论：不该产生事实
  {
    id: 7472,
    issue_url: `${REMOTE}/issues/999`,
    user: { login: "someone" },
    body: "这条是别的 issue 的",
    created_at: "2026-10-09T07:30:00Z",
  },
]);

/** 记录每个请求的假 http：按 URL 子串选响应，断言「打了哪些端点」用。 */
function fakeHttp(): { http: HttpGet; urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const http: HttpGet = async (url, sent) => {
    urls.push(url);
    headers.push(sent);
    if (url.startsWith(`${API}/issues/comments`)) return { ok: true, status: 200, text: COMMENTS_JSON };
    if (url === `${API}/issues/${issueRef.number}`) return { ok: true, status: 200, text: ISSUE_JSON };
    if (url === `${API}/pulls/${prRef.number}`) return { ok: true, status: 200, text: PULL_JSON };
    return { ok: false, reason: "not-found", status: 404, detail: `没打过的端点：${url}` };
  };
  return { http, urls, headers };
}

const MISSING_TEA: Run = async () => ({ code: 127, stdout: "", stderr: "command not found", missing: true });

function projectStore(): { store: Store; cardId: string } {
  const store = freshStore();
  store.upsertProject(PROJECT);
  const opened = store.execute(
    { cmd: "open", actor: HUMAN, title: "同步这张卡", body: "", projectId: PROJECT.id, issue: issueRef },
    "2026-10-10T00:00:00.000Z",
  );
  const cardId = opened.outcome.primaryCardId;
  store.execute(
    { cmd: "bindPr", actor: HUMAN, card: cardId, pr: prRef },
    "2026-10-10T00:00:01.000Z",
  );
  return { store, cardId };
}

describe("一轮同步的调用面", () => {
  it("只按已绑编号精确读 + 每仓库一次评论增量；再跑一次零差异", async () => {
    const { store, cardId } = projectStore();
    const { http, urls, headers } = fakeHttp();

    const first = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:00:00.000Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const report = first.report;

    // 面：两个精确读 + 一次评论增量；**没有**列表请求
    expect(urls.filter((u) => u === `${API}/issues/${issueRef.number}`)).toHaveLength(1);
    expect(urls.filter((u) => u === `${API}/pulls/${prRef.number}`)).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(`${API}/issues/comments`))).toHaveLength(1);
    expect(urls.filter((u) => /\/(issues|pulls)\?/.test(u))).toHaveLength(0);
    // 凭据在请求头里，不在 URL 里
    expect(urls.every((u) => !u.includes(SECRET))).toBe(true);
    expect(headers[0]!["Authorization"]).toBe(`token ${SECRET}`);

    expect(report.counts).toEqual({ issues: 1, pulls: 1, comments: 1 });
    expect(report.facts).toBe(3); // issue.state + pr.state + 一条评论（999 的那条被滤掉）
    expect(report.applied).toBe(3);
    expect(report.ok).toBe(true);
    expect(report.degraded).toEqual([]);

    const card = store.getCard(cardId)!;
    expect(card.issue?.state).toBe("open");
    expect(card.remoteComments.map((c) => c.id)).toEqual([7471]);
    // 幂等键就是 factKey
    expect(store.listEvents().map((e) => e.dedupeKey)).toContain("sync:comment:7471");

    // 游标落库
    expect(store.getSyncState(PROJECT.id)?.at).toBe("2026-10-10T12:00:00.000Z");

    // 第二轮：同一份数据 → 零差异（prev 生效）
    const second = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:05:00.000Z",
    });
    expect(second.ok && second.report.facts).toBe(0);
    expect(second.ok && second.report.applied).toBe(0);
    expect(store.listEvents().filter((e) => e.dedupeKey.startsWith("sync:"))).toHaveLength(3);
    store.close();
  });

  it("游标 = lastSyncAt - 60s，进了评论请求的 since", async () => {
    const { store } = projectStore();
    const { http, urls } = fakeHttp();
    await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:00:00.000Z",
    });
    urls.length = 0;
    await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:05:00.000Z",
    });
    const commentUrl = urls.find((u) => u.includes("/issues/comments"))!;
    expect(decodeURIComponent(commentUrl)).toContain("since=2026-10-10T11:59:00.000Z");
    store.close();
  });

  it("--dry-run 只算事实不落库、不推进游标", async () => {
    const { store, cardId } = projectStore();
    const { http } = fakeHttp();
    const result = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      dryRun: true,
      now: () => "2026-10-10T12:00:00.000Z",
    });
    expect(result.ok && result.report.facts).toBe(3);
    expect(result.ok && result.report.applied).toBe(0);
    expect(result.ok && result.report.factList?.map((f) => f.kind)).toEqual([
      "issue.state",
      "pr.state",
      "remote.comment",
    ]);
    expect(store.listEvents().filter((e) => e.dedupeKey.startsWith("sync:"))).toHaveLength(0);
    expect(store.getSyncState(PROJECT.id)).toBeUndefined();
    expect(store.getCard(cardId)!.remoteComments).toHaveLength(0);
    store.close();
  });

  it("一张卡都没绑编号就一个请求都不发", async () => {
    const store = freshStore();
    store.upsertProject(PROJECT);
    const { http, urls } = fakeHttp();
    const result = await runSyncRound({ store, projectId: PROJECT.id, http, teaConfig: TEA_CONFIG, env: {} });
    expect(urls).toEqual([]);
    expect(result.ok && result.report.notes.join()).toContain("还没有卡片绑定");
    store.close();
  });

  it("没有游标时如实提醒「评论只能拿到最早的一页」；给了 since 就不提", async () => {
    const { store } = projectStore();
    const { http } = fakeHttp();
    const noCursor = await runSyncRound({ store, projectId: PROJECT.id, http, teaConfig: TEA_CONFIG, env: {} });
    expect(noCursor.ok && noCursor.report.since).toBeNull();
    expect(noCursor.ok && noCursor.report.notes.join()).toContain("还没有同步游标");

    const withCursor = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      since: "2026-10-06T00:00:00.000Z",
    });
    expect(withCursor.ok && withCursor.report.notes.join()).not.toContain("还没有同步游标");
    store.close();
  });

  it("没凭据时降级但不写状态（游标不动）", async () => {
    const { store } = projectStore();
    const { http } = fakeHttp();
    const result = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: null,
      env: {},
      run: MISSING_TEA,
    });
    expect(result.ok && result.report.ok).toBe(false);
    expect(result.ok && result.report.reason).toBe("no-credentials");
    expect(store.getSyncState(PROJECT.id)).toBeUndefined();
    store.close();
  });

  it("评论端点降级时 since 游标不前进（下轮重读同一窗口）", async () => {
    const { store } = projectStore();
    const { http, urls } = fakeHttp();
    await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:00:00.000Z",
    });
    const failing: HttpGet = async (url, headers) =>
      url.includes("/issues/comments")
        ? { ok: false, reason: "network", status: null, detail: "断网" }
        : http(url, headers);
    const result = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http: failing,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:05:00.000Z",
    });
    expect(result.ok && result.report.degraded.map((d) => d.endpoint)).toContain("comments");
    expect(store.getSyncState(PROJECT.id)?.at).toBe("2026-10-10T12:00:00.000Z");
    urls.length = 0;
    await runSyncRound({
      store,
      projectId: PROJECT.id,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:10:00.000Z",
    });
    expect(decodeURIComponent(urls.find((u) => u.includes("/issues/comments"))!)).toContain(
      "since=2026-10-10T11:59:00.000Z",
    );
    store.close();
  });

  it("调度器只跑「有卡片绑了编号」的项目，一轮 = 一轮的调用面；0 表示关掉", async () => {
    const { store } = projectStore();
    // 第二个项目：登记了但一张卡都没绑编号 → 不该发请求
    store.upsertProject({
      ...PROJECT,
      id: "proj-empty",
      name: "Empty",
      path: "/tmp/fc-wire-empty",
      remote: "https://forge.example.com/git/Team/Empty",
    });
    const { http, urls } = fakeHttp();

    const scheduler = startSyncScheduler({
      store,
      intervalMs: 600_000,
      http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:00:00.000Z",
    });
    expect(scheduler).not.toBeNull();
    const reports = await scheduler!.runOnce();
    scheduler!.stop();

    expect(reports).toHaveLength(1);
    expect(reports[0]!.projectId).toBe(PROJECT.id);
    expect(urls.some((u) => u.includes("Empty"))).toBe(false);
    expect(urls.filter((u) => /\/(issues|pulls)\?/.test(u))).toHaveLength(0);
    expect(startSyncScheduler({ store, intervalMs: 0 })).toBeNull();
    store.close();
  });
});

// ---------------------------------------------------------------- HTTP 端点

function appHarness(opts: AppOptions): { app: Hono; store: Store } {
  const { store } = projectStore();
  return { app: createApp(store, opts), store };
}

describe("HTTP /api/projects/:id/sync", () => {
  it("POST 跑一轮并回 counts/degraded/notes；token 不出现在响应里", async () => {
    const { app, store } = appHarness({
      sync: { intervalMs: 0, http: fakeHttp().http, teaConfig: TEA_CONFIG, env: {} },
    });

    const res = await app.request(`/api/projects/${PROJECT.id}/sync`, { method: "POST" });
    const text = await res.text();
    expect(res.status).toBe(200);
    // 凭据只在请求头里：响应体、卡片的 payload、事件流里都不许出现它的值
    expect(text.includes(SECRET)).toBe(false);
    expect(text.includes("Authorization")).toBe(false);
    expect(JSON.stringify(store.listEvents())).not.toContain(SECRET);
    expect(JSON.stringify(store.listCards())).not.toContain(SECRET);

    const body = JSON.parse(text) as { ok: boolean; counts: Record<string, number>; applied: number; degraded: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.counts).toEqual({ issues: 1, pulls: 1, comments: 1 });
    expect(body.applied).toBe(3);
    expect(body.degraded).toEqual([]);

    // GET 只读状态：lastSyncAt / 已绑编号数
    const status = await app.request(`/api/projects/${PROJECT.id}/sync`);
    const statusText = await status.text();
    expect(statusText.includes(SECRET)).toBe(false);
    const statusBody = JSON.parse(statusText) as {
      lastSyncAt: string | null;
      tracked: { issues: number; pulls: number };
      degraded: unknown[];
    };
    expect(statusBody.lastSyncAt).not.toBeNull();
    expect(statusBody.tracked).toEqual({ issues: 1, pulls: 1 });
    expect(statusBody.degraded).toEqual([]);
    store.close();
  });

  it("没有凭据时降级（200 + reason），不写状态", async () => {
    const { app, store } = appHarness({
      sync: { intervalMs: 0, teaConfig: null, env: {}, run: MISSING_TEA },
    });

    const res = await app.request(`/api/projects/${PROJECT.id}/sync`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; reason: string | null; degraded: unknown[]; notes: string[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("no-credentials");
    expect(body.notes.join()).toContain("凭据");

    const status = (await (await app.request(`/api/projects/${PROJECT.id}/sync`)).json()) as {
      lastSyncAt: string | null;
    };
    expect(status.lastSyncAt).toBeNull();
    store.close();
  });

  it("项目不存在 → 404；body 不合法 → 400", async () => {
    const { app, store } = appHarness({ sync: { intervalMs: 0, http: fakeHttp().http, teaConfig: null, env: {} } });
    expect((await app.request("/api/projects/nope/sync", { method: "POST" })).status).toBe(404);
    expect((await app.request("/api/projects/nope/sync")).status).toBe(404);

    const bad = await app.request(`/api/projects/${PROJECT.id}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ since: "不是时间" }),
    });
    expect(bad.status).toBe(400);
    store.close();
  });
});

// ---------------------------------------------------------------- 命令契约

describe("命令校验", () => {
  it("applySync / markRemoteCommentsRead 进 zod 契约，坏形状被拒", async () => {
    const applySync: Command = {
      cmd: "applySync",
      actor: SYSTEM,
      card: "c1",
      facts: [issueFact()],
    };
    expect(commandSchema.safeParse(applySync).success).toBe(true);
    expect(
      commandSchema.safeParse({ ...applySync, facts: [{ kind: "issue.state", number: 42 }] }).success,
    ).toBe(false);
    expect(commandSchema.safeParse({ cmd: "applySync", actor: SYSTEM, card: "c1", facts: [] }).success).toBe(false);
    expect(
      commandSchema.safeParse({ cmd: "markRemoteCommentsRead", actor: HUMAN, card: "c1", ids: [7471] }).success,
    ).toBe(true);
  });

  it("HTTP 走命令端点也能跑 applySync（同步器不是唯一入口，但形状一致）", async () => {
    const store = freshStore();
    const cardId = store.execute({ cmd: "open", actor: HUMAN, title: "命令入口", body: "", issue: issueRef })
      .outcome.primaryCardId;
    const app = createApp(store);
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "applySync", actor: SYSTEM, card: cardId, facts: [issueFact(), commentFact()] }),
    });
    const body = (await res.json()) as { ok: boolean; inserted: number };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.inserted).toBe(2);
    expect(store.getCard(cardId)!.issue?.state).toBe("closed");
    expect(store.getCard(cardId)!.remoteComments).toHaveLength(1);
    store.close();
  });
});
