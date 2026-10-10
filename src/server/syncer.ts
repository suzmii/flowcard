/**
 * 同步接线：把 `sync.ts` 的「只读快照 + 差异」接到引擎与 store 上。
 *
 * **一轮同步的调用面是定死的**（省的是带宽与时间，见 `docs/sync.md` §7 的实测）：
 *   1. 卡片已绑定的编号 → 精确读 `GET /issues/{n}`、`GET /pulls/{n}`（各 ~6–17 KB）；
 *   2. 评论增量 → **每仓库一次** `GET /issues/comments?since=…`，回来按已绑编号过滤。
 * **不翻 `/pulls` 列表**（两家都没有 `since`，5 页 ≈2.6 MB / 9–32 s）；列表路径只在手动 `--list` 时走。
 *
 * 事实落库只有一条路：`applySync` 命令（引擎翻成事件 + 跑自动节点），幂等键 = `factKey(fact)`。
 * 同步是**只读**的：整个过程只有 GET，没有远程写，也没有 token 出现在返回值/日志里。
 */
import type { Card, SyncFactIn } from "../shared/types.ts";
import { parseJson, type Run } from "./probe.ts";
import type { ProjectSyncState, Store } from "./store.ts";
import {
  authHeaders,
  defaultHttpGet,
  endpointUrl,
  fetchIssue,
  fetchPull,
  MAX_PAGES,
  PAGE_LIMIT,
  parseCommentList,
  pollRemote,
  readTeaConfig,
  resolveSyncTarget,
  toFacts,
  type Degradation,
  type HttpGet,
  type RawComment,
  type RawIssue,
  type RawPull,
  type SyncAuth,
  type SyncFact,
  type SyncPrev,
  type SyncSnapshotData,
} from "./sync.ts";

/** `since` 游标往回让 1 分钟：重叠窗口吃掉时钟漂移/跨事务漏事件，重复由幂等键吸收。 */
export const SINCE_OVERLAP_MS = 60_000;
/** 后台轮询间隔（`FLOWCARD_SYNC_INTERVAL_MS`，`0` = 关）。看板场景人的反应时间远大于 5 分钟。 */
export const DEFAULT_SYNC_INTERVAL_MS = 300_000;

// 两边形状必须一致：`sync.ts` 的事实类型与共享契约的 zod schema（改了哪边这里先报错）。
type Assert<T extends true> = T;
type _FactsCoverSchema = Assert<SyncFact extends SyncFactIn ? true : false>;
type _SchemaCoversFacts = Assert<SyncFactIn extends SyncFact ? true : false>;

export type SyncRoundCounts = { issues: number; pulls: number; comments: number };

export type SyncRoundReport = {
  /** false = 本轮整体没跑成（`reason` 说明原因）；端点级问题看 `degraded`（那不是失败）。 */
  ok: boolean;
  projectId: string;
  fetchedAt: string;
  since: string | null;
  reason: "no-remote" | "no-credentials" | "no-transport" | null;
  source: "api" | "tea-cli" | null;
  counts: SyncRoundCounts;
  /** 本轮算出的事实条数（`applied` = 真的写进事件库的，`duplicates` = 被幂等键挡住的）。 */
  facts: number;
  applied: number;
  duplicates: number;
  degraded: Degradation[];
  notes: string[];
  /** 卡片已绑定的编号个数（本轮读了什么）。 */
  numbers: { issues: number; pulls: number };
  dryRun: boolean;
  /** 本轮动过的卡片（app 拿去广播 SSE）。 */
  cardIds: string[];
  types: string[];
  /** 只有 `dryRun` 带：将要产生的事实（不落库、不推进游标）。 */
  factList?: SyncFact[];
};

export type SyncRoundResult =
  | { ok: true; report: SyncRoundReport }
  | { ok: false; error: { code: "NOT_FOUND" | "USAGE_ERROR"; message: string; hint?: string } };

/**
 * `since` 游标 = 上次同步时刻 - 60 s。从没同步过 → `null`（全量，只对评论端点有意义）。
 */
export function sinceFrom(lastSyncAt: string | undefined): string | null {
  if (!lastSyncAt) return null;
  const at = Date.parse(lastSyncAt);
  return Number.isFinite(at) ? new Date(at - SINCE_OVERLAP_MS).toISOString() : null;
}

/** 卡片上已绑定的编号（issue / PR）：**只有这些编号值得发事实**（事件必须挂 cardId）。 */
export function trackedNumbers(cards: readonly Card[]): { issues: number[]; pulls: number[] } {
  const issues = new Set<number>();
  const pulls = new Set<number>();
  for (const card of cards) {
    if (card.issue) issues.add(card.issue.number);
    if (card.pr) pulls.add(card.pr.number);
  }
  const asc = (a: number, b: number): number => a - b;
  return { issues: [...issues].sort(asc), pulls: [...pulls].sort(asc) };
}

/**
 * 编号 → 卡片 id。issue 与 PR **共用一个号池**（PR 上的评论只带 PR 编号），所以放同一张表里；
 * 同一个号挂在多张卡上时取 id 最小的那张（事件幂等键全局唯一，事实只能落给一张卡）。
 */
function cardsByNumber(cards: readonly Card[]): Map<number, string> {
  const map = new Map<number, string>();
  const ordered = [...cards].sort((a, b) => a.id.localeCompare(b.id));
  for (const card of ordered) {
    if (card.issue && !map.has(card.issue.number)) map.set(card.issue.number, card.id);
    if (card.pr && !map.has(card.pr.number)) map.set(card.pr.number, card.id);
  }
  return map;
}

/** 快照 → 下一轮的 `prev`（喂 `toFacts` 省掉无谓的引擎调用；丢了也能靠幂等键跑）。 */
function prevFrom(snapshot: SyncSnapshotData): SyncPrev {
  return {
    issues: snapshot.issues.map((i) => ({ number: i.number, state: i.state, updatedAt: i.updatedAt })),
    pulls: snapshot.pulls.map((p) => ({
      number: p.number,
      state: p.state,
      merged: p.merged,
      updatedAt: p.updatedAt,
    })),
    commentKeys: snapshot.comments.map((c) => `sync:comment:${c.id}`),
  };
}

/** 按已绑编号精确读 issue/PR（每个编号一次请求，并发跑）。拿不到的单个编号降级，不影响别的。 */
async function readTracked(
  auth: SyncAuth,
  tracked: { issues: number[]; pulls: number[] },
  http: HttpGet,
): Promise<{ issues: RawIssue[]; pulls: RawPull[]; degraded: Degradation[]; notes: string[] }> {
  const degraded: Degradation[] = [];
  const notes: string[] = [];

  const [issueOutcomes, pullOutcomes] = await Promise.all([
    Promise.all(tracked.issues.map((number) => fetchIssue(auth, number, http))),
    Promise.all(tracked.pulls.map((number) => fetchPull(auth, number, http))),
  ]);

  const issues: RawIssue[] = [];
  for (const [index, outcome] of issueOutcomes.entries()) {
    const number = tracked.issues[index]!;
    if (outcome.ok) {
      issues.push(outcome.item);
      continue;
    }
    degraded.push({
      endpoint: "issues",
      reason: outcome.reason,
      status: outcome.status,
      detail: `#${number} 精确读失败：${outcome.detail}`,
    });
  }

  const pulls: RawPull[] = [];
  for (const [index, outcome] of pullOutcomes.entries()) {
    const number = tracked.pulls[index]!;
    if (outcome.ok) {
      pulls.push(outcome.item);
      continue;
    }
    degraded.push({
      endpoint: "pulls",
      reason: outcome.reason,
      status: outcome.status,
      detail: `#${number} 精确读失败：${outcome.detail}`,
    });
  }

  if (degraded.length > 0) {
    notes.push(
      `${degraded.length} 个已绑编号没读到（${degraded.map((d) => d.detail).join("；")}）—— 其余的照常`,
    );
  }
  return { issues, pulls, degraded, notes };
}

/**
 * 每仓库一次的评论增量：`since` 窗口 + 按已绑编号过滤（没绑编号的评论无法路由到卡片）。
 *
 * **窗口内要翻页读完**：Gitea 的评论端点按时间**升序**返回，`limit=50` 拿到的是窗口里**最早**的
 * 50 条 —— 只读一页就把游标推到 now，等于把第 51 条之后（更新的）评论永久丢掉。
 * 所以满页继续翻（上限复用 `MAX_PAGES`）：读完了才算 `complete`；没读完时调用方把游标停在
 * `latestAt`（本批最新一条的时间），下一轮从那里接着读。
 */
async function readComments(
  auth: SyncAuth,
  since: string | null,
  bound: ReadonlySet<number>,
  http: HttpGet,
): Promise<{
  comments: RawComment[];
  degraded: Degradation[];
  notes: string[];
  /** true = 窗口里的评论都读到了（游标可以推到 fetchedAt）。 */
  complete: boolean;
  /** 本批评论里**最新**一条的时间（不依赖服务端排序方向，取 max）；一条都没有 = null。 */
  latestAt: string | null;
}> {
  const headers = authHeaders(auth);
  const all: RawComment[] = [];
  let latestAt: string | null = null;
  const keep = (): RawComment[] => all.filter((comment) => bound.has(comment.issueNumber));

  for (let page = 1; page <= MAX_PAGES; page++) {
    const outcome = await http(endpointUrl(auth, "comments", { since, page }), headers);
    if (!outcome.ok) {
      if (page === 1) {
        return {
          comments: [],
          degraded: [
            { endpoint: "comments", reason: outcome.reason, status: outcome.status, detail: outcome.detail },
          ],
          notes: [],
          complete: false,
          latestAt: null,
        };
      }
      // 第 2 页起失败：已拿到的是窗口里**最早**的一批，更新的还在后面 → 不算读完。
      return {
        comments: keep(),
        degraded: [],
        notes: [`评论第 ${page} 页没拿到（${outcome.reason}）：已收 ${all.length} 条，下一轮接着读`],
        complete: false,
        latestAt,
      };
    }
    const raw = parseJson(outcome.text);
    if (!Array.isArray(raw)) {
      const detail = `响应不是 JSON 数组（HTTP ${outcome.status}）`;
      if (page === 1) {
        return {
          comments: [],
          degraded: [{ endpoint: "comments", reason: "parse-error", status: outcome.status, detail }],
          notes: [],
          complete: false,
          latestAt: null,
        };
      }
      return {
        comments: keep(),
        degraded: [],
        notes: [`评论第 ${page} 页解析失败（${detail}）：已收 ${all.length} 条，下一轮接着读`],
        complete: false,
        latestAt,
      };
    }
    const parsed = parseCommentList(raw);
    all.push(...parsed);
    for (const comment of parsed) if (latestAt === null || comment.at > latestAt) latestAt = comment.at;
    // 不满一页 = 窗口读到尾了（判满页按**原始条数**，不是过滤后的：没绑编号的评论也占一页的名额）
    if (raw.length < PAGE_LIMIT) {
      return { comments: keep(), degraded: [], notes: [], complete: true, latestAt };
    }
    if (page === MAX_PAGES) {
      return {
        comments: keep(),
        degraded: [],
        notes: [
          `评论读满 ${MAX_PAGES} 页（${all.length} 条）还没到窗口末尾：更新的评论这轮没读到，` +
            `游标停在本批最后一条，下一轮继续`,
        ],
        complete: false,
        latestAt,
      };
    }
  }
  return { comments: keep(), degraded: [], notes: [], complete: false, latestAt };
}

/**
 * 跑一轮同步（只读远程）。`list=true` 走 `pollRemote` 的全量列表（手动 `--list` 才用）；
 * 默认只做「已绑编号精确读 + 每仓库一次评论增量」。
 *
 * 落库：事实 → `applySync` 命令（每张卡一条）。`dryRun` 只算不写，也不推进游标。
 */
export async function runSyncRound(opts: {
  store: Store;
  projectId: string;
  /** 显式窗口起点（CLI `--since`）；不给就用 `lastSyncAt - 60 s`。 */
  since?: string;
  list?: boolean;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  http?: HttpGet;
  run?: Run;
  teaConfig?: string | null;
  now?: () => string;
}): Promise<SyncRoundResult> {
  const { store, projectId } = opts;
  const project = store.getProject(projectId);
  if (!project) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `项目 ${projectId} 不存在`,
        hint: "flowcard project list 看现有项目；也可以直接给仓库路径",
      },
    };
  }

  // 软删除的卡不参与同步：事实只能落给活卡（同号重开的新卡才是现在这张），也别为它轮询远程。
  const cards = store.listCards().filter((card) => card.projectId === project.id && card.deletedAt === undefined);
  const tracked = trackedNumbers(cards);
  const numbers = [...tracked.issues, ...tracked.pulls];
  const previous = store.getSyncState(project.id);
  const fetchedAt = (opts.now ?? (() => new Date().toISOString()))();
  const since = opts.since ?? sinceFrom(previous?.at);
  const remote = project.remote ?? "";
  const teaConfig = opts.teaConfig !== undefined ? opts.teaConfig : readTeaConfig();
  const http = opts.http ?? defaultHttpGet;

  const degraded: Degradation[] = [];
  const notes: string[] = [];
  /**
   * 没有游标 = 这个项目从没同步过：评论端点这时只会给**仓库最早**的一页（不是最新的，Gitea 按时间升序），
   * 所以要如实提醒一句 —— 否则人会以为"同步完了却一条新评论都没有"。
   */
  if (since === null && opts.list !== true) {
    notes.push(
      "这个项目还没有同步游标：评论只能拿到仓库最早的一页（不是最新的）——给 --since <ISO> 指定窗口，或先跑一次 --list",
    );
  }
  let reason: SyncRoundReport["reason"] = null;
  let source: SyncRoundReport["source"] = null;
  let snapshot: SyncSnapshotData = { issues: [], pulls: [], comments: [] };
  /** 评论增量读完了没有：没读完（满页/中途失败）游标就不能推到 now —— 更新的评论会永久丢。 */
  let commentsComplete = true;
  let commentsLatestAt: string | null = null;

  const target = resolveSyncTarget({
    remote,
    teaConfig,
    ...(opts.env ? { env: opts.env } : {}),
  });

  if (target.ok && opts.list !== true && numbers.length > 0) {
    source = "api";
    const pulled = await readTracked(target, tracked, http);
    const comments = await readComments(target, since, new Set(numbers), http);
    snapshot = { issues: pulled.issues, pulls: pulled.pulls, comments: comments.comments };
    degraded.push(...pulled.degraded, ...comments.degraded);
    notes.push(...pulled.notes, ...comments.notes);
    commentsComplete = comments.complete;
    commentsLatestAt = comments.latestAt;
  } else if (numbers.length === 0 && opts.list !== true) {
    // 一张卡都没绑编号：不值得为一个仓库拉全量（事件也无处可挂）。
    notes.push("这个项目还没有卡片绑定 issue/PR 编号：本轮不读远程（先绑编号再来同步）");
  } else {
    // 手动列表模式，或没有凭据 → 交给 `pollRemote`（它自己决定走 API 还是退到 tea CLI）
    const polled = await pollRemote({
      remote,
      ...(project.path !== "" ? { repoPath: project.path } : {}),
      ...(since !== null ? { since } : {}),
      teaConfig,
      ...(opts.env ? { env: opts.env } : {}),
      http,
      ...(opts.run ? { run: opts.run } : {}),
      now: () => fetchedAt,
    });
    if (!polled.ok) {
      reason = polled.reason;
      notes.push(...polled.notes);
    } else {
      source = polled.source;
      snapshot = { issues: polled.issues, pulls: polled.pulls, comments: polled.comments };
      degraded.push(...polled.degraded);
      notes.push(...polled.notes);
    }
  }

  const facts = toFacts(previous?.prev ?? null, snapshot, { numbers });

  // 事实 → 每张卡一条 `applySync` 命令（编号对不上卡的丢掉：理论上不会，因为已经按 numbers 过滤）
  const byNumber = cardsByNumber(cards);
  const byCard = new Map<string, SyncFact[]>();
  for (const fact of facts) {
    const cardId = byNumber.get(fact.kind === "remote.comment" ? fact.issueNumber : fact.number);
    if (cardId === undefined) continue;
    const bucket = byCard.get(cardId);
    if (bucket) bucket.push(fact);
    else byCard.set(cardId, [fact]);
  }

  let applied = 0;
  let duplicates = 0;
  const cardIds: string[] = [];
  const types: string[] = [];
  for (const [cardId, cardFacts] of byCard) {
    if (opts.dryRun === true) continue;
    const outcome = store.execute({ cmd: "applySync", actor: { kind: "system" }, card: cardId, facts: cardFacts }, fetchedAt);
    applied += outcome.inserted.length;
    duplicates += outcome.duplicates;
    for (const event of outcome.inserted) types.push(event.type);
    if (outcome.inserted.length > 0) cardIds.push(cardId);
  }

  /**
   * 游标 = "已经读到哪儿了"。**只有窗口真正读完才推到 fetchedAt**：
   *   · 评论端点降级（整页没拿到）：停在能表达的最早起点（上轮游标，或显式 `--since`），下轮重读同一窗口；
   *   · 读满页数上限 / 半路失败：窗口里**更新**的那批还没读到 —— 推进到 now 就等于把它们永久丢掉，
   *     所以停在 `commentsLatestAt`（本批最新一条），下一轮从那儿接着读。
   * （issues/pulls 每轮都按号精确重读，没有窗口问题，不用管。）
   */
  const commentsDegraded = degraded.some((item) => item.endpoint === "comments");
  let cursorAt = fetchedAt;
  if (commentsDegraded) {
    cursorAt = previous?.at ?? since ?? fetchedAt;
    notes.push(`评论端点降级：since 游标停在 ${cursorAt}（下轮重读同一窗口）`);
  } else if (!commentsComplete) {
    cursorAt = commentsLatestAt ?? previous?.at ?? since ?? fetchedAt;
    notes.push(`评论还没读完：since 游标推进到 ${cursorAt}（本批最新一条），下一轮从那里接着读`);
  }

  if (opts.dryRun !== true) {
    if (reason === null) {
      const state: ProjectSyncState = {
        at: cursorAt,
        degraded,
        notes,
        counts: {
          issues: snapshot.issues.length,
          pulls: snapshot.pulls.length,
          comments: snapshot.comments.length,
        },
        prev: prevFrom(snapshot),
      };
      store.setSyncState(project.id, state);
    } else if (previous) {
      // 整体没跑成（没凭据等）：游标不能动，只记下这次为什么没跑成。
      store.setSyncState(project.id, { ...previous, lastError: reason });
    } else {
      // 从来没成功过：也得落一条可见状态，否则面板一直显示「还没同步过」，
      // 后台每 5 分钟失败一次谁都看不见。`at: ""` = 没有游标（`sinceFrom` 解析不出时间就当没有，
      // 与完全没有这条记录等价），所以失败不会被误当成"同步过"。
      store.setSyncState(project.id, {
        at: "",
        degraded,
        notes,
        counts: { issues: 0, pulls: 0, comments: 0 },
        lastError: reason,
      });
    }
  }

  return {
    ok: true,
    report: {
      ok: reason === null,
      projectId: project.id,
      fetchedAt,
      since,
      reason,
      source,
      counts: {
        issues: snapshot.issues.length,
        pulls: snapshot.pulls.length,
        comments: snapshot.comments.length,
      },
      facts: facts.length,
      applied,
      duplicates,
      degraded,
      notes,
      numbers: { issues: tracked.issues.length, pulls: tracked.pulls.length },
      dryRun: opts.dryRun === true,
      cardIds,
      types,
      ...(opts.dryRun === true ? { factList: facts } : {}),
    },
  };
}

export type SyncScheduler = {
  intervalMs: number;
  /** 把所有「有卡片绑了编号」的项目各跑一轮；返回本轮的报告。 */
  runOnce: () => Promise<SyncRoundReport[]>;
  stop: () => void;
};

/**
 * 内置轮询：每 `intervalMs` 毫秒对所有「有卡片绑了编号」的项目跑一轮（只读）。
 * `0`（或负数）= 不同步，返回 `null`，一个定时器都不建。
 * 上一轮没跑完就跳过这一拍 —— 远程慢的时候宁可少跑，也不要排一队请求。
 */
export function startSyncScheduler(opts: {
  store: Store;
  intervalMs: number;
  env?: Record<string, string | undefined>;
  http?: HttpGet;
  run?: Run;
  teaConfig?: string | null;
  now?: () => string;
  onReport?: (report: SyncRoundReport) => void;
  onError?: (error: unknown) => void;
}): SyncScheduler | null {
  if (!(opts.intervalMs > 0)) return null;
  let running = false;

  const runOnce = async (): Promise<SyncRoundReport[]> => {
    if (running) return [];
    running = true;
    const reports: SyncRoundReport[] = [];
    try {
      for (const project of opts.store.listProjects()) {
        if (project.virtual === true || project.path === "" || (project.remote ?? "") === "") continue;
        const cards = opts.store
          .listCards()
          .filter((card) => card.projectId === project.id && card.deletedAt === undefined);
        const tracked = trackedNumbers(cards);
        if (tracked.issues.length + tracked.pulls.length === 0) continue;
        const result = await runSyncRound({
          store: opts.store,
          projectId: project.id,
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.http ? { http: opts.http } : {}),
          ...(opts.run ? { run: opts.run } : {}),
          ...(opts.teaConfig !== undefined ? { teaConfig: opts.teaConfig } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        });
        if (result.ok) {
          reports.push(result.report);
          opts.onReport?.(result.report);
        } else {
          opts.onError?.(new Error(result.error.message));
        }
      }
    } finally {
      running = false;
    }
    return reports;
  };

  const timer = setInterval(() => {
    void runOnce().catch((error: unknown) => opts.onError?.(error));
  }, opts.intervalMs);
  // 不因为这个定时器拖住进程退出（服务本身由 HTTP server 撑着）。
  timer.unref();

  return {
    intervalMs: opts.intervalMs,
    runOnce,
    stop: () => clearInterval(timer),
  };
}
