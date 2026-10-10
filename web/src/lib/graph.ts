/**
 * 提交图（`GET /api/projects/:id/graph`）：服务端跑 `git log --graph --oneline --decorate --all`
 * 与 `git worktree list` 的原样输出，前端只负责渲染文本图 + 叠加 worktree/分支/卡片信息。
 *
 * 这个接口是另一条线在落地的契约，所以字段一律按可选处理：拿不到就降级成空列表 / 可读错误，
 * UI 不因此崩（和 `projects.ts` 对 `/api/projects` 的降级策略一致）。
 */
import { z } from "zod";
import { apiUrl, unreachableMessage } from "@/lib/api";
import { describeIssues } from "@/lib/schema";

const graphErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

const commitSchema = z.looseObject({
  sha: z.string(),
  short: z.string().optional(),
  parents: z.array(z.string()).optional(),
  author: z.string().optional(),
  at: z.string().optional(),
  subject: z.string().optional(),
  refs: z.array(z.string()).optional(),
});

const branchSchema = z.looseObject({
  name: z.string(),
  head: z.string().optional(),
  upstream: z.string().optional(),
});

const worktreeSchema = z.looseObject({
  path: z.string(),
  branch: z.string().nullable().optional(),
  head: z.string().optional(),
  detached: z.boolean().optional(),
  cardId: z.string().optional(),
  cardTitle: z.string().optional(),
  cardState: z.string().optional(),
});

const graphCardSchema = z.looseObject({
  id: z.string(),
  title: z.string().optional(),
  state: z.string().optional(),
  branch: z.string().nullable().optional(),
  worktreePath: z.string().optional(),
});

const graphResponseSchema = z.looseObject({
  ok: z.boolean().optional(),
  repoPath: z.string().optional(),
  limit: z.number().optional(),
  graphText: z.string().optional(),
  commits: z.array(commitSchema).optional(),
  branches: z.array(branchSchema).optional(),
  worktrees: z.array(worktreeSchema).optional(),
  cards: z.array(graphCardSchema).optional(),
  error: graphErrorSchema.optional(),
});

export type GraphCommit = z.infer<typeof commitSchema>;
export type GraphBranch = z.infer<typeof branchSchema>;
export type GraphWorktree = z.infer<typeof worktreeSchema>;
export type GraphCard = z.infer<typeof graphCardSchema>;

export type GraphData = {
  repoPath: string;
  /** 服务端实际生效的条数上限（拿不到就用请求值） */
  limit: number | null;
  graphText: string;
  commits: GraphCommit[];
  branches: GraphBranch[];
  worktrees: GraphWorktree[];
  cards: GraphCard[];
};

export type GraphResult =
  | { ok: true; data: GraphData }
  | { ok: false; code: string; message: string; hint?: string; /** true = 服务端还没挂这个路由（404） */ missing: boolean };

/** 默认拉多少条提交；大仓库调小能明显减轻服务端与渲染压力。 */
export const GRAPH_LIMIT_DEFAULT = 200;

export const GRAPH_LIMITS = [50, 200, 500] as const;

export async function fetchGraph(
  projectId: string,
  limit: number = GRAPH_LIMIT_DEFAULT,
  signal?: AbortSignal,
): Promise<GraphResult> {
  const url = apiUrl(`/api/projects/${encodeURIComponent(projectId)}/graph?limit=${limit}`);
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, code: "UNREACHABLE", message: unreachableMessage(error), missing: false };
  }

  // body 只能读一次：先读成 json，失败响应里的 { error } 也从这里抠。
  const raw: unknown = await res.json().catch(() => null);
  const parsed = graphResponseSchema.safeParse(raw);
  const failure = parsed.success ? parsed.data.error : undefined;

  // 404 只有"响应里没带 error"时才算"路由没挂"；服务端自己的 404（项目不存在）走下面的原文。
  if (res.status === 404 && !failure) {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "服务端还没有 GET /api/projects/:id/graph（提交图接口未实现）",
      missing: true,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: failure?.code ?? `HTTP_${res.status}`,
      message: failure?.message ?? `读取提交图失败（HTTP ${res.status}）`,
      ...(failure?.hint ? { hint: failure.hint } : {}),
      missing: false,
    };
  }
  if (!parsed.success) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: `提交图响应不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`,
      missing: false,
    };
  }

  const body = parsed.data;
  if (body.ok === false) {
    return {
      ok: false,
      code: failure?.code ?? "GIT_FAILED",
      message: failure?.message ?? "读取提交图失败",
      ...(failure?.hint ? { hint: failure.hint } : {}),
      missing: false,
    };
  }
  if (typeof body.graphText !== "string") {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: "提交图响应缺少 graphText（ok:true 时必须有）",
      missing: false,
    };
  }

  return {
    ok: true,
    data: {
      repoPath: body.repoPath ?? "",
      limit: body.limit ?? null,
      graphText: body.graphText,
      commits: body.commits ?? [],
      branches: body.branches ?? [],
      worktrees: body.worktrees ?? [],
      cards: body.cards ?? [],
    },
  };
}

/** 短 sha：`short` 字段优先，其次自己截前 7 位。 */
export function shortSha(sha: string | null | undefined, length = 7): string {
  if (!sha) return "—";
  return sha.length > length ? sha.slice(0, length) : sha;
}
