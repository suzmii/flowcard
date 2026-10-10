/** HTTP 接口 + SSE：写入只走 /api/commands（命令），读取走投影；同时把构建好的看板当静态资源发出去。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import {
  commandSchema,
  issueBaseInSchema,
  projectInSchema,
  runtimeActionSchema,
  sessionPromptSchema,
  sessionStartSchema,
  syncRequestSchema,
} from "../shared/types.ts";
import type { Project } from "../shared/types.ts";
import { resolveUserPath } from "../shared/paths.ts";
import { attachmentRef, MAX_ATTACHMENT_BYTES } from "./attachments.ts";
import { runSyncRound, startSyncScheduler, trackedNumbers } from "./syncer.ts";
import type { HttpGet } from "./sync.ts";
import type { Run } from "./probe.ts";
import { readProject } from "./projects.ts";
import { deriveSessionState } from "./project.ts";
import { autostartCard } from "./autostart.ts";
import { writeBriefFile } from "./brief.ts";
import { defaultAdapterPath } from "./launch.ts";
import { createHostedSessions, type HostedSessions } from "./hosted-session.ts";
import { clampGraphLimit, readGraph } from "./graph.ts";
import { readCardDiff } from "./diff.ts";
import type { RuntimeSupervisor } from "./runtime.ts";
import type { Store } from "./store.ts";
import { pickDirectory } from "./picker.ts";
import { projectRootsFromEnv } from "./projects.ts";
import { scanGitRepos } from "./projects.ts";

/** 看板构建产物目录（`npm run web:build` 的 outDir）。 */
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export type AppOptions = {
  runtime?: RuntimeSupervisor;
  /**
   * 同步（只读轮询）：`intervalMs <= 0` = 关（默认：测试与 CLI 起 app 时都不带，所以不建定时器）。
   * 每轮只对「有卡片绑了编号」的项目跑，且只按编号精确读 + 每仓库一次评论增量。
   */
  sync?: {
    intervalMs: number;
    env?: Record<string, string | undefined>;
    http?: HttpGet;
    run?: Run;
    teaConfig?: string | null;
  };
  /**
   * 开卡即开工：`open` 成功后自动**托管一次 omp RPC 会话**并把开工提示注入进去
   * （worktree 由会话自己按提示创建、自己登记）。`enabled: false` 或未传则只开卡不起会话。
   */
  autostart?: {
    enabled: boolean;
    dataDir: string;
    cli?: string;
    /** 测试注入：替换写开工提示的实现。 */
    writeBrief?: typeof writeBriefFile;
  };
  /**
   * 托管会话（每卡一条 `omp --mode rpc --no-ui` 子进程）。不传就自己建一个（端点照样可用）；
   * `main.ts` 自己建是为了进程退出时能 `stopAll()`，测试自己建是为了塞假 omp。
   */
  sessions?: HostedSessions;
};

export function createApp(store: Store, opts: AppOptions = {}) {
  const app = new Hono();
  const subscribers = new Set<(event: string, data: unknown) => void>();

  // 托管会话：每卡一个 omp RPC 子进程；上报扩展默认就挂（心跳/结束上报的兜底）。
  const sessions = opts.sessions ?? createHostedSessions({ store, adapterPath: defaultAdapterPath() });

  /**
   * 调用方鉴别：**只监听回环不等于可信**——任意网页都能从浏览器打 127.0.0.1，
   * 而本服务能起进程/起终端/读 Gitea 凭据，所以必须挡住"不是本页发来的"请求。
   * 三条独立规则，任一命中即拒：
   *   1. 带 `Sec-Fetch-Site` 且不是 same-origin/same-site/none（现代浏览器都会带）
   *   2. 带 `Origin`/`Referer` 且主机不在白名单（本机回环）
   *   3. 写接口（/api/commands 等）必须是 `Content-Type: application/json`——
   *      这是 CORS 的"非安全列表类型"，跨站发它必须先过预检，而本服务不返回 CORS 头 ⇒ 跨站发不出来
   */
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  const hostOf = (value: string): string | null => {
    try {
      return new URL(value).hostname;
    } catch {
      return null;
    }
  };
  app.use("/api/*", async (c, next) => {
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      return c.json({ ok: false, rejection: { code: "FORBIDDEN", message: "拒绝跨站请求" } }, 403);
    }
    for (const header of ["origin", "referer"] as const) {
      const value = c.req.header(header);
      if (!value) continue;
      const host = hostOf(value);
      if (host !== null && !LOOPBACK_HOSTS.has(host)) {
        return c.json({ ok: false, rejection: { code: "FORBIDDEN", message: `拒绝来自 ${host} 的请求` } }, 403);
      }
    }
    return next();
  });

  // 写接口只收 JSON：既挡跨站简单请求，也顺手把"任何 Content-Type 都能写"堵上
  app.use("/api/commands", async (c, next) => {
    if (c.req.method === "POST") {
      const type = c.req.header("content-type") ?? "";
      if (!type.includes("application/json")) {
        return c.json(
          { ok: false, rejection: { code: "UNSUPPORTED_MEDIA", message: "只接受 application/json" } },
          415,
        );
      }
    }
    return next();
  });

  // 请求体上限：JSON 走 1 MiB（正文/评论足够），附件单独给 12 MiB（比自己 10 MiB 的校验松一点，
  // 真正的大小判定仍在 attachments.checkAttachment 里）
  const jsonLimit = bodyLimit({ maxSize: 1 << 20, onError: (c) => c.json({ ok: false, rejection: { code: "PAYLOAD_TOO_LARGE", message: "请求体超过 1 MiB" } }, 413) });

  const broadcast = (event: string, data: unknown): void => {
    for (const send of subscribers) send(event, data);
  };

  // 托管会话里的 claim/end 也是卡片事实（走的就是引擎那条命令通道）→ 和命令一样广播 "changed"。
  sessions.onCard((change) => {
    if (change.types.length === 0) return;
    broadcast("changed", { cardIds: [change.cardId], types: change.types });
  });

  // 后台同步也是卡片事实的来源 → 和命令一样广播 "changed"，看板据此重拉。
  if (opts.sync) {
    startSyncScheduler({
      store,
      intervalMs: opts.sync.intervalMs,
      ...(opts.sync.env ? { env: opts.sync.env } : {}),
      ...(opts.sync.http ? { http: opts.sync.http } : {}),
      ...(opts.sync.run ? { run: opts.sync.run } : {}),
      ...(opts.sync.teaConfig !== undefined ? { teaConfig: opts.sync.teaConfig } : {}),
      onReport: (report) => {
        if (report.cardIds.length > 0) {
          broadcast("changed", { cardIds: report.cardIds, types: report.types });
        }
      },
      onError: (error) => {
        console.error(`[sync] 一轮同步失败：${String(error)}`);
      },
    });
  }

  // 运行时状态变化也是事件（runtime.*）→ 看板既收到细粒度的 "runtime"，也收到 "changed" 触发重取。
  opts.runtime?.subscribe((change) => {
    broadcast("runtime", { cardId: change.cardId, status: change.status });
    broadcast("changed", { cardIds: [change.cardId], types: change.types });
  });

  app.get("/api/health", (c) =>
    c.json({ ok: true, cards: store.listCards().length, events: store.listEvents(1).length }),
  );

  app.get("/api/cards", (c) => {
    // 软删除的卡默认不进看板；`?includeDeleted=1` 才带出来（配合 CLI 的 restore 用）
    const includeDeleted = c.req.query("includeDeleted") === "1";
    const now = Date.now();
    const cards = store
      .listCards()
      .filter((card) => includeDeleted || !card.deletedAt)
      // 会话失联是「读取时刻」的判断：库里的投影只有 running/ended，出口统一改判，CLI 与看板一致
      .map((card) => deriveSessionState(card, now));
    return c.json({ cards });
  });

  app.get("/api/cards/:id", (c) => {
    const card = store.getCard(c.req.param("id"));
    if (!card) return c.json({ error: { code: "NOT_FOUND", message: "卡片不存在" } }, 404);
    return c.json({ card: deriveSessionState(card) });
  });

  app.get("/api/events", (c) => {
    // SQLite 里负 LIMIT = 无上限，必须收敛（-1 会把整部历史一次性倒出来）
    const raw = Number(c.req.query("limit") ?? "200");
    // 负数/NaN 一律退回默认值（SQLite 里负 LIMIT = 无上限，绝不能透传）
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 1000) : 200;
    return c.json({ events: store.listEvents(limit) });
  });

  app.post("/api/commands", jsonLimit, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = commandSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json(
        {
          ok: false,
          inserted: 0,
          duplicates: 0,
          rejection: { code: "USAGE_ERROR", message },
          notes: [],
        },
        400,
      );
    }

    const result = store.execute(parsed.data);
    broadcast("changed", {
      cardIds: [...new Set(result.outcome.events.map((e) => e.cardId))],
      types: result.outcome.events.map((e) => e.type),
    });

    // 开卡即开工：卡片建好就在桌面上把会话立起来（带开工提示）；失败会自己写到卡片评论上
    let autostart: Awaited<ReturnType<typeof autostartCard>> | undefined;
    if (
      !result.outcome.rejection &&
      parsed.data.cmd === "open" &&
      opts.autostart?.enabled === true &&
      result.card
    ) {
      autostart = await autostartCard(result.card.id, {
        getCard: (id) => store.getCard(id),
        getProject: (id) => store.getProject(id),
        comment: async (cardId, body) => {
          store.execute({
            cmd: "comment",
            actor: { kind: "system" },
            card: cardId,
            body,
            dedupeKey: `autostart:${cardId}:${body.length}`,
          });
        },
        dataDir: opts.autostart.dataDir,
        sessions,
        ...(opts.autostart.cli ? { cli: opts.autostart.cli } : {}),
        io: {
          ...(opts.autostart.writeBrief ? { writeBrief: opts.autostart.writeBrief } : {}),
        },
      });
    }

    const rejection = result.outcome.rejection;
    const status = rejection
      ? rejection.code === "NOT_FOUND"
        ? 404
        : rejection.code === "USAGE_ERROR"
          ? 400
          : 409
      : 200;

    return c.json(
      {
        ok: !rejection,
        card: result.card,
        inserted: result.inserted.length,
        duplicates: result.duplicates,
        notes: result.outcome.notes,
        ...(autostart ? { autostart } : {}),
        ...(rejection ? { rejection } : {}),
        ...(result.outcome.blocked ? { blocked: result.outcome.blocked } : {}),
      },
      status,
    );
  });

  app.get("/api/projects", (c) => c.json({ projects: store.listProjects() }));

  /**
   * `/api/projects/:id/sync` 的 body：`since` 显式给窗口起点，`list` 走全量列表（手动排查用），
   * `dryRun` 只算事实不落库。三个都不给 = 一轮常规同步（精确读已绑编号 + 每仓库一次评论增量）。
   */
  app.post("/api/projects/:id/sync", async (c) => {
    const id = c.req.param("id");
    if (!store.getProject(id)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `项目 ${id} 不存在`,
            hint: "flowcard project list 看现有项目",
          },
        },
        404,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = syncRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: {
            code: "USAGE_ERROR",
            message: parsed.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
            hint: 'body 形如 {"since":"2026-10-09T00:00:00.000Z","list":false,"dryRun":false}',
          },
        },
        400,
      );
    }

    const result = await runSyncRound({
      store,
      projectId: id,
      // 传输依赖与后台调度共用一套（测试/替换用），默认全是生产实现。
      ...(opts.sync?.env ? { env: opts.sync.env } : {}),
      ...(opts.sync?.http ? { http: opts.sync.http } : {}),
      ...(opts.sync?.run ? { run: opts.sync.run } : {}),
      ...(opts.sync?.teaConfig !== undefined ? { teaConfig: opts.sync.teaConfig } : {}),
      ...(parsed.data.since ? { since: parsed.data.since } : {}),
      ...(parsed.data.list !== undefined ? { list: parsed.data.list } : {}),
      ...(parsed.data.dryRun !== undefined ? { dryRun: parsed.data.dryRun } : {}),
    });
    if (!result.ok) return c.json({ ok: false, error: result.error }, 404);
    // 报告里没有凭据字段（`SyncAuth.token` 从不进返回值）。
    if (result.report.cardIds.length > 0) {
      broadcast("changed", { cardIds: result.report.cardIds, types: result.report.types });
    }
    return c.json(result.report);
  });

  /** 同步状态（纯读，不触发网络）：上次同步时刻 / 降级 / 已绑编号数。 */
  app.get("/api/projects/:id/sync", (c) => {
    const id = c.req.param("id");
    const project = store.getProject(id);
    if (!project) {
      return c.json(
        {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `项目 ${id} 不存在`,
            hint: "flowcard project list 看现有项目",
          },
        },
        404,
      );
    }
    const state = store.getSyncState(id);
    const tracked = trackedNumbers(store.listCards().filter((card) => card.projectId === id));
    return c.json({
      projectId: id,
      lastSyncAt: state?.at ?? null,
      degraded: state?.degraded ?? [],
      notes: state?.notes ?? [],
      counts: state?.counts ?? null,
      lastError: state?.lastError ?? null,
      tracked: { issues: tracked.issues.length, pulls: tracked.pulls.length },
    });
  });

  /**
   * 提交图（只读）：`git log --graph` 的原始输出 + 提交/分支/worktree 实况 + 卡片↔分支映射。
   * 只跑只读 git 子命令；`limit` 默认 200、上限 1000（图与响应都要有上限）。
   */
  app.get("/api/projects/:id/graph", async (c) => {
    const id = c.req.param("id");
    const project = store.getProject(id);
    if (!project || project.virtual === true || project.path === "") {
      return c.json(
        {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `项目 ${id} 不存在（或不是真实仓库）`,
            hint: "flowcard project list 看现有项目；合成项目「未归属」没有仓库可画",
          },
        },
        404,
      );
    }
    const result = await readGraph(project.path, {
      limit: clampGraphLimit(c.req.query("limit")),
      cards: store.listCards(),
    });
    return c.json(result, result.ok ? 200 : 500);
  });

  /**
   * 卡片 diff（只读）：base = 项目 defaultBranch（拿不到退 main/master），
   * head = 卡片 worktree 的 HEAD；`git diff <baseSha>...<headSha>`（三点 = merge-base）。
   * `?patch=1` 额外带上 git 的原始 unified diff 文本。
   */
  app.get("/api/cards/:id/diff", async (c) => {
    const card = store.getCard(c.req.param("id"));
    if (!card) {
      return c.json({ ok: false, error: { code: "NOT_FOUND", message: "卡片不存在" } }, 404);
    }
    if (!card.worktree) {
      return c.json(
        {
          ok: false,
          error: {
            code: "NO_WORKTREE",
            message: `卡片 ${card.id} 还没绑 worktree，没有可比的 head`,
            hint: `先建并绑 worktree：flowcard worktree ${card.id} --path .worktrees/x --branch <前缀>/x`,
          },
        },
        409,
      );
    }
    const project = store.getProject(card.projectId);
    const repoPath = project && project.virtual !== true ? project.path : card.repoPath;
    if (repoPath === undefined || repoPath === "") {
      return c.json(
        {
          ok: false,
          error: {
            code: "NO_BASE",
            message: `卡片 ${card.id} 归属的项目没有仓库路径，算不出 base`,
            hint: "先登记项目：flowcard project add <仓库路径>",
          },
        },
        409,
      );
    }
    const result = await readCardDiff({
      repoPath,
      headDir: card.worktree.path,
      ...(project?.defaultBranch ? { defaultBranch: project.defaultBranch } : {}),
      includePatch: c.req.query("patch") === "1",
    });
    return c.json(result, result.ok ? 200 : result.error.code === "GIT_FAILED" ? 500 : 409);
  });

  /**
   * 登记项目（看板的 Metadata）：读一次 git 元数据存起来。同 path 幂等（`created:false` 并刷新元数据），
   * 因为"这个仓库现在长这样"是会变的，而重复登记不该产生第二个项目。
   */
  app.post("/api/projects", jsonLimit, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = projectInSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "USAGE_ERROR",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
            hint: "flowcard project add <仓库路径>",
          },
        },
        400,
      );
    }
    const read = await readProject(resolveUserPath(parsed.data.path));
    if (!read.ok) return c.json({ error: read.error }, 400);
    // 基址默认按 remote 派生；body 里给了就用给的（显式覆盖）。
    const { project, created } = store.upsertProject({
      ...read.project,
      ...(parsed.data.issueRepo ? { issueRepo: parsed.data.issueRepo } : {}),
      ...(parsed.data.issueUrlTemplate ? { issueUrlTemplate: parsed.data.issueUrlTemplate } : {}),
    });
    broadcast("projects", { project, created });
    return c.json({ project, created });
  });

  /**
   * 改一个项目的 Issue 基址（绑 Issue 时只填编号，`repo`/`url` 从这里补）。
   * 不传的字段保持不动；`clear:true` 把两条都清掉。
   */
  app.post("/api/projects/:id/issue-base", async (c) => {
    const id = c.req.param("id");
    const project = store.getProject(id);
    if (!project) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `项目 ${id} 不存在`,
            hint: "flowcard project list 看现有项目；也可以直接给路径：flowcard project issue-base <路径>",
          },
        },
        404,
      );
    }

    const body = await c.req.json().catch(() => null);
    const parsed = issueBaseInSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "USAGE_ERROR",
            message: parsed.error.issues
              .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
              .join("; "),
            hint: 'flowcard project issue-base <项目> --repo <owner/repo> --template "…{number}"（或 --clear）',
          },
        },
        400,
      );
    }

    const next: Project = { ...project };
    if (parsed.data.clear === true) {
      delete next.issueRepo;
      delete next.issueUrlTemplate;
    } else {
      if (parsed.data.issueRepo !== undefined) next.issueRepo = parsed.data.issueRepo;
      if (parsed.data.issueUrlTemplate !== undefined) {
        next.issueUrlTemplate = parsed.data.issueUrlTemplate;
      }
    }
    const saved = store.upsertProject(next).project;
    broadcast("projects", { project: saved, created: false });
    return c.json({ project: saved });
  });

  /** 按路径解析当前项目（CLI / 看板进来时用）：路径可以是仓库内任意目录；不在任何项目里则 404。 */
  app.get("/api/project/current", (c) => {
    const raw = c.req.query("path");
    if (!raw) {
      return c.json(
        {
          error: {
            code: "USAGE_ERROR",
            message: "缺少 path 查询参数",
            hint: "GET /api/project/current?path=<绝对路径>",
          },
        },
        400,
      );
    }
    const resolved = resolveUserPath(raw);
    const project = store.projectForPath(resolved);
    if (!project) {
      return c.json(
        {
          error: {
            code: "NOT_FOUND",
            message: `${resolved} 不在任何已登记的项目里`,
            hint: "先登记：flowcard project add <仓库路径>",
          },
        },
        404,
      );
    }
    return c.json({ project });
  });

  /**
   * 传附件（图片）。**必须读原始字节**（不是 JSON）：body 就是要存的图。
   * 只收 png/jpeg/gif/webp 且按文件头嗅探，≤10MB，id = 内容 sha256 前 16 位（内容寻址 → 幂等去重）。
   */
  app.post("/api/attachments", async (c) => {
    // 先看 Content-Length：明知超限就别把 10MB 全读进内存。
    const declaredLength = Number(c.req.header("content-length") ?? Number.NaN);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
      return c.json(
        {
          error: {
            code: "TOO_LARGE",
            message: `附件 ${declaredLength} 字节，超过上限 ${MAX_ATTACHMENT_BYTES} 字节（10 MB）`,
            hint: "先压缩或裁剪再传",
          },
        },
        413,
      );
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = store.appendAttachment({
      name: c.req.query("name") ?? "",
      mime: c.req.header("content-type"),
      bytes,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.error.code === "TOO_LARGE" ? 413 : 415);
    }
    const { attachment, created } = result;
    return c.json({
      ...attachmentRef(attachment.id),
      id: attachment.id,
      bytes: attachment.bytes,
      mime: attachment.mime,
      name: attachment.name,
      at: attachment.at,
      created,
    });
  });

  // 内容寻址 → 同一个 id 的内容永不改变，可以放心长缓存。
  app.get("/api/attachments/:id", (c) => {
    const found = store.getAttachment(c.req.param("id"));
    if (!found) {
      return c.json({ error: { code: "NOT_FOUND", message: "附件不存在" } }, 404);
    }
    return new Response(found.bytes, {
      status: 200,
      headers: {
        "content-type": found.attachment.mime,
        "content-length": String(found.bytes.byteLength),
        "cache-control": "public, max-age=31536000, immutable",
        // 上传内容一律不许浏览器猜类型，免得被当成 HTML/脚本执行。
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/api/rebuild", (c) => c.json({ ok: true, cards: store.rebuild() }));

  /**
   * 启动按钮：up = 启动这张卡片 worktree 里的项目（会先停掉别的卡片在跑的运行时）；
   * down = 停掉它。进程由适配层管，状态照旧走事件流。
   */
  app.post("/api/cards/:id/runtime", async (c) => {
    const runtime = opts.runtime;
    if (!runtime) {
      return c.json(
        { ok: false, error: { code: "RUNTIME_DISABLED", message: "这个实例没有启用运行时监督器" } },
        503,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = runtimeActionSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ ok: false, rejection: { code: "USAGE_ERROR", message } }, 400);
    }

    const cardId = c.req.param("id");
    const result =
      parsed.data.action === "up" ? await runtime.up(cardId) : await runtime.down(cardId);
    return c.json(result, result.ok ? 200 : result.error?.code === "NOT_FOUND" ? 404 : 409);
  });

  /**
   * 托管会话（每卡一个 `omp --mode rpc --no-ui` 子进程）—— 网页上直接对话、直接看工具输出。
   *
   * | 方法 | 路径 | 说明 |
   * |---|---|---|
   * | GET  | `/api/cards/:id/session` | 现况（status/busy/cost）+ 转录（落库的，重启后仍在） |
   * | POST | `/api/cards/:id/session/start` | `{cwd?}` → `{ok,status,ompSessionId?}`；**立刻回 `starting`** |
   * | POST | `/api/cards/:id/session/prompt` | `{text,images?}` → `{ok,messageId?}` |
   * | POST | `/api/cards/:id/session/abort` | 中断当前一轮 |
   * | POST | `/api/cards/:id/session/stop` | 收尾（关 stdin → omp 自己退 → 上报 `end`） |
   * | GET  | `/api/cards/:id/session/stream` | 这张卡一条 SSE：ready/message/message_end/tool/state/notice/error |
   */
  app.get("/api/cards/:id/session", (c) => {
    const cardId = c.req.param("id");
    if (!store.getCard(cardId)) {
      return c.json({ error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } }, 404);
    }
    return c.json(sessions.snapshot(cardId));
  });

  app.post("/api/cards/:id/session/start", async (c) => {
    const cardId = c.req.param("id");
    const body = await c.req.json().catch(() => null);
    const parsed = sessionStartSchema.safeParse(body ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ ok: false, status: "stopped", error: { code: "USAGE_ERROR", message } }, 400);
    }
    const result = await sessions.start(cardId, {
      ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
    });
    // 起不来也不是 5xx：状态就是 `failed`，原因在 `error` 里（前端照着显示）。
    return c.json(result, result.error?.code === "NOT_FOUND" ? 404 : 200);
  });

  app.post("/api/cards/:id/session/prompt", async (c) => {
    const cardId = c.req.param("id");
    if (!store.getCard(cardId)) {
      return c.json({ error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = sessionPromptSchema.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; ");
      return c.json({ ok: false, error: { code: "USAGE_ERROR", message } }, 400);
    }
    const images = parsed.data.images ?? [];
    if (parsed.data.text.trim() === "" && images.length === 0) {
      return c.json({ ok: false, error: { code: "USAGE_ERROR", message: "text 与 images 不能都空" } }, 400);
    }
    const result = await sessions.prompt(cardId, parsed.data.text, images);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/api/cards/:id/session/abort", async (c) => {
    const cardId = c.req.param("id");
    if (!store.getCard(cardId)) {
      return c.json({ error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } }, 404);
    }
    const result = await sessions.abort(cardId);
    return c.json(result, result.ok ? 200 : 409);
  });

  app.post("/api/cards/:id/session/stop", async (c) => {
    const cardId = c.req.param("id");
    if (!store.getCard(cardId)) {
      return c.json({ error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } }, 404);
    }
    const result = await sessions.stop(cardId);
    return c.json(result, result.ok ? 200 : 409);
  });

  // 每卡一条 SSE（**不把增量灌进全局 `/api/stream`**）：连上先收到 `ready` + `state` 的现况，
  // 历史转录走 `GET .../session`。
  app.get("/api/cards/:id/session/stream", (c) => {
    const cardId = c.req.param("id");
    if (!store.getCard(cardId)) {
      return c.json({ error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } }, 404);
    }
    return streamSSE(c, async (stream) => {
      const off = sessions.subscribe(cardId, (event) => {
        const { type, ...body } = event;
        // 客户端断了就别让这条事件把服务搞出未处理的 rejection（`onAbort` 随后会退订）。
        stream.writeSSE({ event: type, data: JSON.stringify(body) }).catch(() => undefined);
      });
      stream.onAbort(off);
      while (!stream.aborted) {
        await stream.sleep(15_000);
        stream.writeSSE({ event: "ping", data: JSON.stringify({ at: new Date().toISOString() }) }).catch(() => undefined);
      }
    });
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown): void => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      subscribers.add(send);
      stream.onAbort(() => {
        subscribers.delete(send);
      });
      send("hello", { ok: true });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        send("ping", { at: new Date().toISOString() });
      }
    }),
  );

  // 选择项目：候选列表（扫常见工作目录）+ 原生目录选择器（弹到用户桌面）
  app.get("/api/projects/candidates", async (c) => {
    const roots = projectRootsFromEnv();
    const candidates = await scanGitRepos(roots);
    return c.json({ roots, candidates });
  });

  app.post("/api/projects/pick", jsonLimit, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { start?: string; timeoutMs?: number };
    const roots = projectRootsFromEnv();
    const start = body.start ?? roots[0] ?? process.env.HOME ?? "/";
    const picked = await pickDirectory({
      startDir: start,
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
    });
    if (picked.status !== "picked") {
      return c.json({ ok: false, status: picked.status, reason: picked.reason, message: picked.message ?? null }, 200);
    }
    const read = await readProject(picked.path);
    if (!read.ok) {
      return c.json(
        { ok: false, status: "failed", reason: "not-a-repo", message: read.error.message, path: picked.path },
        200,
      );
    }
    const { project, created } = store.upsertProject(read.project);
    broadcast("projects", { project, created });
    return c.json({ ok: true, status: "picked", path: picked.path, project, created });
  });

  // 看板静态资源：注册在 /api 路由之后，不会盖住接口。没构建过就给一条人话提示。
  if (existsSync(join(WEB_DIST, "index.html"))) {
    app.use("/*", serveStatic({ root: WEB_DIST }));
    app.get("*", serveStatic({ path: join(WEB_DIST, "index.html") }));
  } else {
    app.get("/", (c) =>
      c.html(
        "<!doctype html><meta charset='utf-8'><title>flowcard</title>" +
          "<body style='font:14px/1.6 system-ui;padding:2rem'>" +
          "<h1>flowcard</h1><p>看板还没构建。先跑：</p>" +
          "<pre>npm run web:install &amp;&amp; npm run web:build</pre>" +
          "<p>然后刷新本页（接口在 <code>/api</code> 下已可用）。</p></body>",
      ),
    );
  }

  return app;
}
