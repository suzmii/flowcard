/**
 * 通知 hook（`src/server/notify-hooks.ts` + 同步侧的候选）：审批之外的**两个新来源** ——
 * 「CI 结束」与「远端新评论」。三层都测：
 *
 *   1. **纯函数**：CI 解析（combined status / check-runs 两种形状）与文案（`ciNotice` /
 *      `commentNotice` / `summarize` / `candidateSpec`），含"自己发的不投"与截断；
 *   2. **一轮同步**：注入假 http（假 Gitea），覆盖"状态变化才投"（pending → pass/fail）、
 *      换了 commit 不跟上一轮比、重复轮询不重投、CI 读不到（404 / 字段缺失）就不投；
 *   3. **投递编排**：真 store + 假投递，覆盖在线直投、幂等、离线降级（评论 + pending）与补投、开关。
 *
 * 全程离线：远程一律是注入的假 `http`，会话是假投递，不联网、不调模型。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import type { AppOptions } from "../src/server/app.ts";
import { createApp } from "../src/server/app.ts";
import {
  candidateSpec,
  ciNotice,
  commentNotice,
  createNotifyHooks,
  notifyHooksEnabled,
  summarize,
  type NotifyCandidate,
  type NotifyHooks,
} from "../src/server/notify-hooks.ts";
import type { HostedSessions } from "../src/server/hosted-session.ts";
import { createStore, type Store } from "../src/server/store.ts";
import { runSyncRound } from "../src/server/syncer.ts";
import { jobConclusion, parseCheckRuns, parseCombinedStatus, type HttpGet } from "../src/server/sync.ts";
import type { Project } from "../src/shared/types.ts";
import { issueRef, prRef } from "./harness.ts";

const HUMAN = { kind: "human" as const, name: "you" };

const REMOTE = "https://forge.example.com/git/Team/Repo";
const API = "https://forge.example.com/git/api/v1/repos/Team/Repo";
const TEA_CONFIG = ["logins:", "  - name: forge", "    url: https://forge.example.com/git", "    token: t0ken"].join(
  "\n",
);

const PROJECT: Project = {
  id: "proj-notify",
  name: "Repo",
  path: "/tmp/fc-notify-repo",
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
  updated_at: "2026-10-09T09:21:33Z",
  comments: 0,
});
const PULL_JSON = JSON.stringify({
  number: prRef.number,
  state: "open",
  merged: false,
  head: { label: prRef.branch, ref: "refs/pull/77/head" },
  base: { label: "master" },
  updated_at: "2026-10-10T04:42:54Z",
  html_url: prRef.url,
});

/** 一条远端评论（`issue_url` 决定它挂在哪个编号上）。 */
function remoteComment(over: { id: number; author: string; body: string; url?: string }): unknown {
  return {
    id: over.id,
    issue_url: `${REMOTE}/issues/${issueRef.number}`,
    user: { login: over.author },
    body: over.body,
    created_at: "2026-10-10T05:00:00Z",
    html_url: over.url ?? `${REMOTE}/issues/${issueRef.number}#issuecomment-${over.id}`,
  };
}

/** 假远端：按 URL 给响应；CI 那一档可以随时换（详见下面的 `setCi`）。 */
type Remote = {
  http: HttpGet;
  urls: string[];
  setComments: (comments: unknown[]) => void;
  /** 换 CI 响应：`null` = 端点不存在（404）；字符串 = 200 + 那个 body。 */
  setCi: (body: string | null) => void;
};

function fakeRemote(comments: unknown[] = []): Remote {
  const urls: string[] = [];
  let current = comments;
  let ci: string | null = null;
  const http: HttpGet = async (url) => {
    urls.push(url);
    if (url.startsWith(`${API}/issues/comments`)) return { ok: true, status: 200, text: JSON.stringify(current) };
    if (url === `${API}/issues/${issueRef.number}`) return { ok: true, status: 200, text: ISSUE_JSON };
    if (url === `${API}/pulls/${prRef.number}`) return { ok: true, status: 200, text: PULL_JSON };
    if (url.startsWith(`${API}/commits/`)) {
      if (ci === null) return { ok: false, reason: "not-found", status: 404, detail: "404 Not Found" };
      return { ok: true, status: 200, text: ci };
    }
    return { ok: false, reason: "not-found", status: 404, detail: `没打过的端点：${url}` };
  };
  return {
    http,
    urls,
    setComments: (next) => {
      current = next;
    },
    setCi: (body) => {
      ci = body;
    },
  };
}

/** Gitea 的 combined status（`/commits/{ref}/status`）。 */
function combinedStatus(input: {
  sha: string;
  state?: string;
  statuses?: { context: string; status: string; target_url?: string }[];
}): string {
  return JSON.stringify({
    sha: input.sha,
    state: input.state ?? "pending",
    total_count: input.statuses?.length ?? 0,
    statuses: input.statuses ?? [],
  });
}

const tempDirs: string[] = [];
const stores: Store[] = [];

let cardSeq = 0;

/** 建一张卡：项目 + issue #42 + PR #77（`withSession` 时再挂上会话，测"跳过自己"要用）。 */
function makeCard(opts: { withSession?: boolean; project?: Project } = {}): {
  store: Store;
  cardId: string;
  projectId: string;
} {
  const project = opts.project ?? PROJECT;
  const dir = mkdtempSync(join(tmpdir(), "fc-notify-"));
  tempDirs.push(dir);
  const store = createStore({ dataDir: join(dir, "data"), flow: personalFlow });
  stores.push(store);
  store.upsertProject(project);
  const opened = store.execute({
    cmd: "open",
    actor: HUMAN,
    title: `通知 hook ${++cardSeq}`,
    body: "",
    projectId: project.id,
    issue: issueRef,
  });
  const cardId = opened.outcome.primaryCardId;
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card: cardId,
    worktree: { path: dir, branch: prRef.branch, source: "flowcard" },
  });
  if (opts.withSession === true) {
    store.execute({
      cmd: "claim",
      actor: HUMAN,
      card: cardId,
      session: { harness: "omp", id: "s1", cwd: dir, agentKind: "main" },
    });
  }
  store.execute({ cmd: "bindPr", actor: HUMAN, card: cardId, pr: prRef });
  return { store, cardId, projectId: project.id };
}

/** 跑一轮同步，并把候选递给 hook（和 `app.ts` 里的接线一样）。 */
async function syncRound(input: {
  store: Store;
  projectId?: string;
  remote: Remote;
  hooks: NotifyHooks;
  now: string;
  candidates: NotifyCandidate[];
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await runSyncRound({
    store: input.store,
    projectId: input.projectId ?? PROJECT.id,
    http: input.remote.http,
    teaConfig: TEA_CONFIG,
    env: input.env ?? {},
    now: () => input.now,
    notify: (list) => {
      input.candidates.push(...list);
      input.hooks.onSync(list);
    },
  });
  await input.hooks.settle();
}

type Sink = {
  store: Store;
  cardId: string;
  projectId: string;
  prompts: { cardId: string; text: string }[];
  comments: string[];
  live: Set<string>;
  hooks: NotifyHooks;
  /** 上一轮同步算出来的候选（每轮清空）。 */
  candidates: NotifyCandidate[];
  /** 跑一轮同步（候选 → hook）。 */
  round: (remote: Remote, now: string) => Promise<void>;
};

function makeSink(
  opts: { enabled?: boolean; selfAuthors?: string[]; withSession?: boolean; project?: Project; env?: Record<string, string | undefined> } = {},
): Sink {
  const { store, cardId, projectId } = makeCard({
    withSession: opts.withSession ?? false,
    ...(opts.project ? { project: opts.project } : {}),
  });
  const sink: Sink = {
    store,
    cardId,
    projectId,
    prompts: [],
    comments: [],
    live: new Set<string>(),
    hooks: undefined as unknown as NotifyHooks,
    candidates: [],
    round: async (remote, now) => {
      sink.candidates = [];
      await syncRound({
        store,
        projectId,
        remote,
        hooks: sink.hooks,
        now,
        candidates: sink.candidates,
        ...(opts.env ? { env: opts.env } : {}),
      });
    },
  };
  sink.hooks = createNotifyHooks({
    enabled: opts.enabled ?? true,
    getCard: (id) => store.getCard(id),
    isLive: (id) => sink.live.has(id),
    prompt: async (id, text) => {
      sink.prompts.push({ cardId: id, text });
      return { ok: true };
    },
    comment: (id, body) => {
      sink.comments.push(body);
      store.execute({ cmd: "comment", actor: { kind: "system", name: "notify-hook" }, card: id, body });
    },
    ledger: {
      get: (id) => store.getApprovalLedger(id),
      set: (id, ledger) => store.setApprovalLedger(id, ledger),
    },
    ...(opts.selfAuthors ? { selfAuthors: opts.selfAuthors } : {}),
    // 失败只留痕：测试里出警告就是失败
    warn: (message) => {
      throw new Error(`不该出现警告：${message}`);
    },
  });
  return sink;
}

afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 纯函数：CI 解析

describe("CI 解析（纯函数）", () => {
  it("job 状态归一化：认识两家那套取值，认不出来就是不投（null）", () => {
    expect(jobConclusion("success", null)).toBe("pass");
    expect(jobConclusion(null, "SKIPPED")).toBe("pass");
    expect(jobConclusion("failure", null)).toBe("fail");
    expect(jobConclusion("completed", "timed_out")).toBe("fail");
    expect(jobConclusion("CANCELLED", null)).toBe("fail");
    expect(jobConclusion("pending", null)).toBe("pending");
    expect(jobConclusion("in_progress", "")).toBe("pending");
    expect(jobConclusion("queued", "")).toBe("pending");
    // `completed` 只说"跑到哪一步"，不是结论 → 拿不到结论就是不投
    expect(jobConclusion("completed", null)).toBeNull();
    expect(jobConclusion("", "")).toBeNull();
  });

  it("combined status（Gitea）：结论取 sha 与每个 job；没有 sha 就没法判定，返回 null", () => {
    const reading = parseCombinedStatus(
      JSON.parse(
        combinedStatus({
          sha: "aaa111",
          state: "failure",
          statuses: [
            { context: "build", status: "failure", target_url: "http://ci/build/1" },
            { context: "test", status: "success" },
          ],
        }),
      ),
    );
    expect(reading?.sha).toBe("aaa111");
    expect(reading?.conclusion).toBe("fail");
    expect(reading?.jobs).toEqual([
      { name: "build", conclusion: "fail", url: "http://ci/build/1" },
      { name: "test", conclusion: "pass", url: "" },
    ]);
    // 一个 job 都没有、顶层 state 也拿不到 → pending（"还没报结论"不等于"没有 CI"）
    expect(parseCombinedStatus({ sha: "aaa111", statuses: [] })?.conclusion).toBe("pending");
    // 没有 sha：这份结论属于哪个 commit 都不知道 → 不投
    expect(parseCombinedStatus({ state: "success", statuses: [] })).toBeNull();
  });

  it("check-runs（GitHub）：跑到一半是 pending，失败的按名字/链接列出来；空列表返回 null", () => {
    const reading = parseCheckRuns({
      total_count: 3,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success", html_url: "http://ci/build", head_sha: "bbb222" },
        { name: "test", status: "in_progress", conclusion: null, details_url: "http://ci/test", head_sha: "bbb222" },
        { name: "lint", status: "completed", conclusion: "cancelled", head_sha: "bbb222" },
      ],
    });
    expect(reading?.sha).toBe("bbb222");
    expect(reading?.conclusion).toBe("fail");
    expect(reading?.jobs.map((job: { name: string; conclusion: string }) => [job.name, job.conclusion])).toEqual([
      ["build", "pass"],
      ["test", "pending"],
      ["lint", "fail"],
    ]);
    expect(reading?.jobs[1]?.url).toBe("http://ci/test");
    // 没有 check run 的仓库：让调用方退回 legacy /status
    expect(parseCheckRuns({ total_count: 0, check_runs: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------- 纯函数：文案与跳过自己

describe("通知文案（纯函数）", () => {
  it("CI 通过：说清结论与下一步，不列 job；失败：带失败 job 的名字与链接", () => {
    const passed = ciNotice({
      cardId: "c1",
      pr: { number: 77, sha: "aaa1112223334445", conclusion: "pass", url: prRef.url },
      jobs: [{ name: "build", conclusion: "pass", url: "http://ci/build" }],
    });
    expect(passed).toContain("CI 结束了");
    expect(passed).toContain("PR #77");
    expect(passed).toContain("通过");
    expect(passed).toContain("commit aaa111222333");
    expect(passed).toContain(`flowcard accept c1`);
    expect(passed).not.toContain("失败 job");

    const failed = ciNotice({
      cardId: "c1",
      pr: { number: 77, sha: "aaa1112223334445", conclusion: "fail", url: prRef.url },
      jobs: [
        { name: "build", conclusion: "fail", url: "http://ci/build/1" },
        { name: "lint", conclusion: "fail", url: "" },
      ],
    });
    expect(failed).toContain("失败");
    expect(failed).toContain("失败 job：build（http://ci/build/1）、lint");
    expect(failed).toContain(`链接：${prRef.url}`);
  });

  it("评论通知：作者 / 链接 / 正文摘要（截断），空正文与缺链接都能兜住", () => {
    const long = `第一行\n\n第二行 ${"啊".repeat(400)}`;
    const text = commentNotice({
      cardId: "c1",
      kind: "pr",
      comment: { number: 77, author: "lhk229", body: long, at: "2026-10-10T05:00:00Z", url: "http://p/77#c1" },
    });
    expect(text).toContain("lhk229 在PR #77上留言了");
    expect(text).toContain("链接：http://p/77#c1");
    expect(text).toContain("（截断）");
    // 折了换行：通知里一行读完
    expect(text).not.toContain("第一行\n\n第二行");
    expect(text).toContain("第一行 第二行");

    expect(summarize("  短  ")).toBe("短");
    expect(summarize("")).toBe("（空）");

    const bare = commentNotice({
      cardId: "c1",
      kind: "issue",
      comment: { number: 42, author: "", body: "在", at: "x", url: "" },
    });
    expect(bare).toContain("有人 在Issue #42上留言了");
    expect(bare).not.toContain("链接：");
  });

  it("候选 → 规格：幂等键按来源定；自己发的评论不投", () => {
    const { store, cardId } = makeCard({ withSession: true });
    const card = store.getCard(cardId)!;

    const ci = candidateSpec(
      {
        kind: "ci",
        cardId,
        pr: { number: 77, sha: "aaa111", conclusion: "fail", url: prRef.url },
        jobs: [],
      },
      card,
    );
    expect(ci?.key).toBe("ci:77:aaa111:fail");
    expect(ci?.pendingPrefix).toBe("【通知·待转达】");

    const comment = (author: string): NotifyCandidate => ({
      kind: "comment",
      cardId,
      comment: { id: 7471, number: issueRef.number, author, body: "看过了", at: "x", url: "u" },
    });
    expect(candidateSpec(comment("lhk229"), card)?.key).toBe("comment:issue:7471");
    // 评论挂在 PR 的编号上 → 键里是 pr
    const onPull: NotifyCandidate = {
      kind: "comment",
      cardId,
      comment: { id: 1, number: prRef.number, author: "lhk229", body: "", at: "", url: "" },
    };
    expect(candidateSpec(onPull, card)?.key).toBe("comment:pr:1");
    // 自己发的：作者 == 卡片会话的 harness（"omp"）→ 不投
    expect(candidateSpec(comment("omp"), card)).toBeNull();
    expect(candidateSpec(comment("@OMP "), card)).toBeNull();
    // 额外名单（`FLOWCARD_NOTIFY_SELF_AUTHORS`）：agent 用的是这个账号时也当自己
    expect(candidateSpec(comment("lhk229"), card, ["lhk229"])).toBeNull();
    // 人（我）的评论照投
    expect(candidateSpec(comment("lhk229"), card)?.text).toContain("lhk229");
  });
});

// ---------------------------------------------------------------- 一轮同步 → 候选

describe("一轮同步算出来的候选", () => {
  it("CI：pending → pass 投一次；重复轮询 / 已结束都不重投；换了 commit 不拿它跟上一轮比", async () => {
    const sink = makeSink({ withSession: true });
    sink.live.add(sink.cardId);
    const remote = fakeRemote();
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));

    // 第一轮只是把"上一轮记录"立起来（第一次看到就是 pending 不是"结束"）
    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(sink.candidates).toEqual([]);
    expect(sink.store.getSyncState(PROJECT.id)?.prev?.pulls?.[0]?.ci).toBe("pending");
    expect(sink.store.getSyncState(PROJECT.id)?.prev?.pulls?.[0]?.sha).toBe("aaa111");

    // pending → pass：投一次
    remote.setCi(combinedStatus({ sha: "aaa111", state: "success", statuses: [{ context: "build", status: "success" }] }));
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    const candidate = sink.candidates[0]!;
    expect(candidate.kind).toBe("ci");
    expect(sink.prompts).toHaveLength(1);
    expect(sink.prompts[0]?.text).toContain("PR #77");
    expect(sink.prompts[0]?.text).toContain("通过");

    // 再轮询到同一个 pass：状态没变化 → 不投（也不重复打扰）
    await sink.round(remote, "2026-10-10T12:10:00.000Z");
    expect(sink.candidates).toEqual([]);
    // 就算同一条候选被重复递进来（重放），幂等键也挡住
    sink.hooks.onSync([candidate]);
    await sink.hooks.settle();
    expect(sink.prompts).toHaveLength(1);

    // 推了新 commit（sha 变了）：不拿它跟上一轮的 aaa111 比 —— 它自己的 pending → 结束才算结束
    remote.setCi(combinedStatus({ sha: "bbb222", state: "success", statuses: [{ context: "build", status: "success" }] }));
    await sink.round(remote, "2026-10-10T12:15:00.000Z");
    expect(sink.candidates).toEqual([]);
    remote.setCi(combinedStatus({ sha: "bbb222", statuses: [{ context: "build", status: "pending" }] }));
    await sink.round(remote, "2026-10-10T12:20:00.000Z");
    expect(sink.candidates).toEqual([]);
    remote.setCi(combinedStatus({ sha: "bbb222", state: "failure", statuses: [{ context: "build", status: "failure" }] }));
    await sink.round(remote, "2026-10-10T12:25:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.prompts).toHaveLength(2);
    expect(sink.prompts[1]?.text).toContain("失败");
  });

  it("CI 失败：只带失败的 job（名字 + 链接），通过的 job 不进通知", async () => {
    const sink = makeSink();
    sink.live.add(sink.cardId);
    const remote = fakeRemote();
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));
    await sink.round(remote, "2026-10-10T12:00:00.000Z");

    remote.setCi(
      combinedStatus({
        sha: "aaa111",
        state: "failure",
        statuses: [
          { context: "build", status: "failure", target_url: "http://ci/build/1" },
          { context: "test", status: "success", target_url: "http://ci/test/1" },
        ],
      }),
    );
    await sink.round(remote, "2026-10-10T12:05:00.000Z");

    expect(sink.prompts).toHaveLength(1);
    const text = sink.prompts[0]!.text;
    expect(text).toContain("失败 job：build（http://ci/build/1）");
    expect(text).not.toContain("http://ci/test/1");
    // 幂等键 = PR + commit + 结论
    expect(sink.store.getApprovalLedger(sink.cardId).delivered).toEqual(["ci:77:aaa111:fail"]);
  });

  it("CI 读不到（端点 404 / 字段缺失 / 没绑 PR 之外的情况）就不投，也不动上一轮的记录", async () => {
    const sink = makeSink();
    sink.live.add(sink.cardId);
    const remote = fakeRemote();

    // 端点不存在（老版本 / 没权限）：不投，只留一句 notes，也不改上一轮记录
    remote.setCi(null);
    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(sink.candidates).toEqual([]);
    expect(sink.store.getSyncState(PROJECT.id)?.notes.join()).toContain("CI 没读到");
    // 请求面仍然只有只读 GET
    expect(remote.urls.every((url) => url.startsWith(API))).toBe(true);

    // 先立一个 pending，再让 CI 端点坏掉 → 记录**原样带过**（不抹成未知，否则"结束"永远看不见）
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    remote.setCi(null);
    await sink.round(remote, "2026-10-10T12:10:00.000Z");
    expect(sink.store.getSyncState(PROJECT.id)?.prev?.pulls?.[0]?.ci).toBe("pending");
    expect(sink.candidates).toEqual([]);

    // 字段缺失（没有 sha）同样不投
    remote.setCi(JSON.stringify({ state: "success", statuses: [{ context: "build", status: "success" }] }));
    await sink.round(remote, "2026-10-10T12:15:00.000Z");
    expect(sink.candidates).toEqual([]);

    // 恢复之后：pending → pass 仍然算"结束"（前面那几轮没把状态搞丢）
    remote.setCi(combinedStatus({ sha: "aaa111", state: "success", statuses: [{ context: "build", status: "success" }] }));
    await sink.round(remote, "2026-10-10T12:20:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.prompts).toHaveLength(1);
  });

  it("新评论：投一次（作者 / 链接 / 摘要），重复轮询不重投；评论端点失败就不投", async () => {
    const sink = makeSink({ withSession: true });
    sink.live.add(sink.cardId);
    const remote = fakeRemote([
      remoteComment({ id: 7471, author: "lhk229", body: "两条审查问题都修了" }),
      // 没绑编号的评论：路由不到卡片，不该有候选
      { id: 9001, issue_url: `${REMOTE}/issues/999`, user: { login: "someone" }, body: "别的 issue", created_at: "2026-10-10T05:10:00Z" },
    ]);

    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.candidates[0]?.kind).toBe("comment");
    expect(sink.prompts).toHaveLength(1);
    expect(sink.prompts[0]?.text).toContain("lhk229 在Issue #42上留言了");
    expect(sink.prompts[0]?.text).toContain("两条审查问题都修了");
    expect(sink.prompts[0]?.text).toContain(`${REMOTE}/issues/42#issuecomment-7471`);

    // 同一批评论再轮询一次：事实没落库 → 没有候选
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    expect(sink.candidates).toEqual([]);
    expect(sink.prompts).toHaveLength(1);

    // 评论端点整个失败（断网）：不投
    remote.setComments([]);
    const broken: HttpGet = async (url, headers) =>
      url.includes("/issues/comments") ? { ok: false, reason: "network", status: null, detail: "断网" } : remote.http(url, headers);
    const candidates: NotifyCandidate[] = [];
    await syncRound({ store: sink.store, remote: { ...remote, http: broken }, hooks: sink.hooks, now: "2026-10-10T12:10:00.000Z", candidates });
    expect(candidates).toEqual([]);
  });

  it("GitHub：先读 check-runs（Actions 的结论只在那儿），没有 check run 时退回 legacy /status", async () => {
    const GH_PROJECT: Project = { ...PROJECT, id: "proj-gh", remote: "https://github.com/Team/Repo" };
    const GH_API = "https://api.github.com/repos/Team/Repo";
    const sink = makeSink({ withSession: true, project: GH_PROJECT, env: { FLOWCARD_GITHUB_TOKEN: "gh-token" } });
    sink.live.add(sink.cardId);

    const urls: string[] = [];
    let checkRuns: unknown = { total_count: 0, check_runs: [] };
    let status = combinedStatus({ sha: "aaa111", statuses: [{ context: "ci", status: "pending" }] });
    const http: HttpGet = async (url) => {
      urls.push(url);
      if (url.startsWith(`${GH_API}/issues/comments`)) return { ok: true, status: 200, text: "[]" };
      if (url === `${GH_API}/issues/${issueRef.number}`) return { ok: true, status: 200, text: ISSUE_JSON };
      if (url === `${GH_API}/pulls/${prRef.number}`) return { ok: true, status: 200, text: PULL_JSON };
      if (url.endsWith("/check-runs")) return { ok: true, status: 200, text: JSON.stringify(checkRuns) };
      if (url.endsWith("/status")) return { ok: true, status: 200, text: status };
      return { ok: false, reason: "not-found", status: 404, detail: `没打过的端点：${url}` };
    };
    const remote: Remote = {
      http,
      urls,
      setComments: () => undefined,
      setCi: () => undefined,
    };

    // 没有 check run（仓库用 status API 报 CI）→ 退回 legacy /status
    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(urls.some((url) => url.endsWith("/check-runs"))).toBe(true);
    expect(urls.some((url) => url.endsWith("/status"))).toBe(true);
    status = combinedStatus({ sha: "aaa111", state: "success", statuses: [{ context: "ci", status: "success" }] });
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.prompts[0]?.text).toContain("通过");

    // 有 check run → 只用 check-runs 的结论（跑到一半是 pending，失败带 job 名与链接）
    checkRuns = {
      total_count: 1,
      check_runs: [
        { name: "lint", status: "in_progress", conclusion: null, html_url: "http://gh/lint", head_sha: "ccc333" },
      ],
    };
    await sink.round(remote, "2026-10-10T12:10:00.000Z");
    expect(sink.candidates).toEqual([]);
    checkRuns = {
      total_count: 1,
      check_runs: [
        { name: "lint", status: "completed", conclusion: "failure", html_url: "http://gh/lint", head_sha: "ccc333" },
      ],
    };
    await sink.round(remote, "2026-10-10T12:15:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.prompts).toHaveLength(2);
    expect(sink.prompts[1]?.text).toContain("失败 job：lint（http://gh/lint）");
  });

  it("把 hook 递进同步的开关：不接 sink 就一条候选都不算（连 CI 都不读）", async () => {
    const { store, cardId } = makeCard();
    const remote = fakeRemote();
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [] }));
    const result = await runSyncRound({
      store,
      projectId: PROJECT.id,
      http: remote.http,
      teaConfig: TEA_CONFIG,
      env: {},
      now: () => "2026-10-10T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    expect(remote.urls.some((url) => url.includes("/commits/"))).toBe(false);
    expect(store.getSyncState(PROJECT.id)?.prev?.pulls?.[0]?.ci).toBeUndefined();
    expect(store.getApprovalLedger(cardId)).toEqual({ delivered: [], pending: [] });
  });
});

// ---------------------------------------------------------------- 投递编排（真 store + 假投递）

describe("投递编排", () => {
  it("会话在线：直投一条；离线：卡片评论 + pending，`flush` 补投一次之后不重复", async () => {
    const sink = makeSink({ withSession: true });
    const remote = fakeRemote([remoteComment({ id: 7471, author: "lhk229", body: "接口改一下" })]);

    // 会话不在线：降级成「评论 + 待补投」
    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(sink.prompts).toEqual([]);
    expect(sink.store.getApprovalLedger(sink.cardId).pending.map((p) => p.key)).toEqual(["comment:issue:7471"]);
    expect(sink.comments).toHaveLength(1);
    expect(sink.comments[0]?.startsWith("【通知·待转达】")).toBe(true);
    const card = sink.store.getCard(sink.cardId)!;
    expect(card.comments.some((c) => c.body.startsWith("【通知·待转达】"))).toBe(true);
    expect(card.comments.every((c) => c.actor.kind === "system")).toBe(true);

    // 会话起来 → 补投一次（`flush` 不看 isLive，能 `-r` 续接就续）
    expect(await sink.hooks.flush(sink.cardId)).toBe(1);
    expect(sink.prompts).toHaveLength(1);
    expect(sink.prompts[0]?.text).toContain("接口改一下");
    expect(sink.store.getApprovalLedger(sink.cardId).pending).toEqual([]);
    expect(sink.store.getApprovalLedger(sink.cardId).delivered).toEqual(["comment:issue:7471"]);
    // 再 flush 没事发生（幂等）
    expect(await sink.hooks.flush(sink.cardId)).toBe(0);
    expect(sink.prompts).toHaveLength(1);
    // 降级那条评论也只留一条（重复轮询不会刷屏）
    expect(sink.store.getCard(sink.cardId)!.comments.filter((c) => c.body.startsWith("【通知·待转达】"))).toHaveLength(1);
  });

  it("自己发的评论不投（连评论留痕与 pending 都不该有）", async () => {
    const sink = makeSink({ withSession: true });
    const remote = fakeRemote([
      remoteComment({ id: 7471, author: "omp", body: "我自己回的" }),
      remoteComment({ id: 7472, author: "lhk229", body: "人回的这条要投" }),
    ]);
    await sink.round(remote, "2026-10-10T12:00:00.000Z");

    // 候选是"同步看到的新评论"（两条都在）；**跳过自己**是 hook 那层的判断 —— 自己那条不进台账。
    expect(sink.candidates).toHaveLength(2);
    expect(sink.store.getApprovalLedger(sink.cardId).pending.map((p) => p.key)).toEqual(["comment:issue:7472"]);
    expect(sink.comments).toHaveLength(1);
    expect(sink.comments[0]).toContain("人回的这条要投");
    expect(sink.comments[0]).not.toContain("我自己回的");
  });

  it("会话在线：CI 结束直接投；投递失败算不在线，降级留痕等下次", async () => {
    const sink = makeSink();
    sink.live.add(sink.cardId);
    const remote = fakeRemote();
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));
    await sink.round(remote, "2026-10-10T12:00:00.000Z");

    remote.setCi(combinedStatus({ sha: "aaa111", state: "success", statuses: [{ context: "build", status: "success" }] }));
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    expect(sink.prompts).toHaveLength(1);
    expect(sink.comments).toEqual([]);
    expect(sink.store.getApprovalLedger(sink.cardId).delivered).toEqual(["ci:77:aaa111:pass"]);

    // 投递失败（会话"活着"但续接不上）→ 降级留痕，不静默丢
    const warnings: string[] = [];
    const failing = createNotifyHooks({
      enabled: true,
      getCard: (id) => sink.store.getCard(id),
      isLive: () => true,
      prompt: async () => ({ ok: false, error: { code: "NO_SESSION", message: "续不起来" } }),
      comment: (id, body) => sink.store.execute({ cmd: "comment", actor: { kind: "system" }, card: id, body }),
      ledger: {
        get: (id) => sink.store.getApprovalLedger(id),
        set: (id, ledger) => sink.store.setApprovalLedger(id, ledger),
      },
      warn: (message) => warnings.push(message),
    });
    failing.onSync([
      { kind: "ci", cardId: sink.cardId, pr: { number: 77, sha: "ccc333", conclusion: "fail", url: prRef.url }, jobs: [] },
    ]);
    await failing.settle();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(sink.cardId);
    expect(warnings[0]).toContain("续不起来");
    expect(sink.store.getApprovalLedger(sink.cardId).pending.map((p) => p.key)).toEqual(["ci:77:ccc333:fail"]);
  });

  it("开关：`FLOWCARD_NOTIFY_HOOKS=0` / 旧的 `FLOWCARD_APPROVAL_HOOKS=0` 都关；关掉时什么都不做", async () => {
    expect(notifyHooksEnabled({})).toBe(true);
    expect(notifyHooksEnabled({ FLOWCARD_NOTIFY_HOOKS: "1" })).toBe(true);
    expect(notifyHooksEnabled({ FLOWCARD_NOTIFY_HOOKS: "0" })).toBe(false);
    // 兼容：审批那个开关当年只管审批，现在等于同一个总开关
    expect(notifyHooksEnabled({ FLOWCARD_APPROVAL_HOOKS: "0" })).toBe(false);

    const sink = makeSink({ enabled: false, withSession: false });
    const remote = fakeRemote([remoteComment({ id: 7471, author: "lhk229", body: "关掉开关就安静" })]);
    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));
    await sink.round(remote, "2026-10-10T12:00:00.000Z");
    expect(sink.candidates).toHaveLength(1); // 同步照常算事实（候选只是数据）
    remote.setCi(combinedStatus({ sha: "aaa111", state: "failure", statuses: [{ context: "build", status: "failure" }] }));
    await sink.round(remote, "2026-10-10T12:05:00.000Z");
    expect(sink.candidates).toHaveLength(1);
    expect(sink.prompts).toEqual([]);
    expect(sink.comments).toEqual([]);
    expect(sink.store.getApprovalLedger(sink.cardId)).toEqual({ delivered: [], pending: [] });
    expect(await sink.hooks.flush(sink.cardId)).toBe(0);
  });
});

// ---------------------------------------------------------------- HTTP：同步路由把候选接到 hook

describe("HTTP /api/projects/:id/sync 的通知接线", () => {
  it("POST 跑一轮之后，CI 结束的通知真的投给了会话", async () => {
    const { store, cardId } = makeCard({ withSession: true });
    const remote = fakeRemote();
    const prompts: string[] = [];
    // 只要 isLive / prompt / onCard 的最小假会话（route 上就用到这三个）
    const sessions = {
      isLive: () => true,
      prompt: async (_cardId: string, text: string) => {
        prompts.push(text);
        return { ok: true };
      },
      onCard: () => () => undefined,
    } as unknown as HostedSessions;

    const opts: AppOptions = {
      sessions,
      sync: { intervalMs: 0, http: remote.http, teaConfig: TEA_CONFIG, env: {} },
      notifyHooks: { enabled: true },
    };
    const app = createApp(store, opts);

    remote.setCi(combinedStatus({ sha: "aaa111", statuses: [{ context: "build", status: "pending" }] }));
    expect((await app.request(`/api/projects/${PROJECT.id}/sync`, { method: "POST" })).status).toBe(200);
    remote.setCi(combinedStatus({ sha: "aaa111", state: "failure", statuses: [{ context: "build", status: "failure" }] }));
    expect((await app.request(`/api/projects/${PROJECT.id}/sync`, { method: "POST" })).status).toBe(200);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("PR #77");
    expect(prompts[0]).toContain("失败 job：build");
    expect(store.getApprovalLedger(cardId).delivered).toEqual(["ci:77:aaa111:fail"]);
  });

  it("开关关掉的 app：同步照跑，但一条通知都不投", async () => {
    const { store, cardId } = makeCard({ withSession: true });
    const remote = fakeRemote([remoteComment({ id: 7471, author: "lhk229", body: "关掉了" })]);
    const prompts: string[] = [];
    const sessions = {
      isLive: () => true,
      prompt: async (_cardId: string, text: string) => {
        prompts.push(text);
        return { ok: true };
      },
      onCard: () => () => undefined,
    } as unknown as HostedSessions;

    const app = createApp(store, {
      sessions,
      sync: { intervalMs: 0, http: remote.http, teaConfig: TEA_CONFIG, env: {} },
      notifyHooks: { enabled: false },
    });
    const res = await app.request(`/api/projects/${PROJECT.id}/sync`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(store.getCard(cardId)!.remoteComments.map((c) => c.id)).toEqual([7471]);
    expect(prompts).toEqual([]);
    expect(store.getApprovalLedger(cardId)).toEqual({ delivered: [], pending: [] });
  });
});
