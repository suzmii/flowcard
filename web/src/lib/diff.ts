/**
 * 卡片代码变更（`GET /api/cards/:id/diff`，**只读**）：服务端在卡片 worktree 里跑
 * `git diff <base>...<head>` 并把结构化 hunk 给前端渲染。这里只做校验与错误降级，不碰 git。
 *
 * 拿不到 diff 的原因是可枚举的（NO_WORKTREE / NO_BASE / GIT_FAILED），每种都给一句可执行的下一步。
 */
import { z } from "zod";
import { apiUrl, unreachableMessage } from "@/lib/api";
import { describeIssues } from "@/lib/schema";

const diffLineSchema = z.looseObject({
  kind: z.enum(["context", "add", "del"]).catch("context"),
  oldLine: z.number().optional(),
  newLine: z.number().optional(),
  text: z.string(),
});

const hunkSchema = z.looseObject({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  header: z.string().optional(),
  lines: z.array(diffLineSchema).default([]),
});

export const DIFF_STATUSES = ["added", "modified", "deleted", "renamed", "binary"] as const;

const fileSchema = z.looseObject({
  path: z.string(),
  oldPath: z.string().optional(),
  // 服务端将来加状态时不要让整块 diff 解析失败：不认识就按 modified 显示
  status: z.enum(DIFF_STATUSES).catch("modified"),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  hunks: z.array(hunkSchema).default([]),
});

const diffErrorSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

const diffResponseSchema = z.looseObject({
  ok: z.boolean().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  baseSha: z.string().optional(),
  headSha: z.string().optional(),
  files: z.array(fileSchema).optional(),
  truncated: z.boolean().optional(),
  /** 为什么被截断（服务端给的原文：字节阈值 / maxBuffer / 丢了多少文件） */
  truncatedReason: z.string().optional(),
  error: diffErrorSchema.optional(),
});

export type DiffLine = z.infer<typeof diffLineSchema>;
export type DiffHunk = z.infer<typeof hunkSchema>;
export type DiffFile = z.infer<typeof fileSchema>;
export type DiffStatus = DiffFile["status"];

export type DiffData = {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  files: DiffFile[];
  truncated: boolean;
  truncatedReason: string;
};

export type DiffResult =
  | { ok: true; data: DiffData }
  | { ok: false; code: string; message: string; hint?: string; missing: boolean };

/** 服务端没给 hint 时的兜底建议（按错误码给可执行的下一步）。 */
const ERROR_HINTS: Record<string, string> = {
  NO_WORKTREE:
    "这张卡还没绑 worktree：先在「必要项目」里绑 worktree（会话里 /wt <branch>，或让 CLI 建），再回来看代码变更。",
  NO_BASE: "没有可对比的基线：给卡片绑 WIP PR，或让分支相对默认分支先有一次提交。",
  GIT_FAILED: "服务端执行 git 失败：看服务端日志里的命令与 stderr，确认仓库/分支还在。",
};

export const STATUS_LABELS: Record<DiffStatus, string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  binary: "二进制",
};

export const STATUS_TONE: Record<DiffStatus, "success" | "warning" | "danger" | "info" | "muted"> = {
  added: "success",
  modified: "info",
  deleted: "danger",
  renamed: "warning",
  binary: "muted",
};

export async function fetchDiff(cardId: string, signal?: AbortSignal): Promise<DiffResult> {
  const url = apiUrl(`/api/cards/${encodeURIComponent(cardId)}/diff`);
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, code: "UNREACHABLE", message: unreachableMessage(error), missing: false };
  }

  const raw: unknown = await res.json().catch(() => null);
  const parsed = diffResponseSchema.safeParse(raw);
  const failure = parsed.success ? parsed.data.error : undefined;

  // 404 只有"响应里没带 error"时才算"路由没挂"；服务端自己的 404（卡片不存在）走下面的原文。
  if (res.status === 404 && !failure) {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      message: "服务端还没有 GET /api/cards/:id/diff（代码变更接口未实现）",
      missing: true,
    };
  }
  if (!parsed.success) {
    return {
      ok: false,
      code: "BAD_RESPONSE",
      message: `代码变更响应不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`,
      missing: false,
    };
  }

  const body = parsed.data;
  if (!res.ok || body.ok === false) {
    const code = failure?.code ?? `HTTP_${res.status}`;
    return {
      ok: false,
      code,
      message: failure?.message ?? `读取代码变更失败（HTTP ${res.status}）`,
      ...(failure?.hint ?? ERROR_HINTS[code] ? { hint: failure?.hint ?? ERROR_HINTS[code] } : {}),
      missing: false,
    };
  }

  return {
    ok: true,
    data: {
      base: body.base ?? "",
      head: body.head ?? "",
      baseSha: body.baseSha ?? "",
      headSha: body.headSha ?? "",
      files: body.files ?? [],
      truncated: body.truncated ?? false,
      truncatedReason: body.truncatedReason ?? "",
    },
  };
}

/** 行的评论锚点：删除行只有旧行号（side=old），其余行挂在新行号上（side=new）。 */
export function lineAnchor(line: DiffLine): { side: "new" | "old"; line: number } | null {
  if (line.kind === "del") {
    return typeof line.oldLine === "number" ? { side: "old", line: line.oldLine } : null;
  }
  return typeof line.newLine === "number" ? { side: "new", line: line.newLine } : null;
}

/** 一个文件里所有「可评论的行」锚点键（用于判断评论是否过期/落在当前 diff 里）。 */
export function anchorKeys(file: DiffFile): Set<string> {
  const keys = new Set<string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const anchor = lineAnchor(line);
      if (anchor) keys.add(`${anchor.side}:${anchor.line}`);
    }
  }
  return keys;
}

export function anchorKey(side: string, line: number): string {
  return `${side === "old" ? "old" : "new"}:${line}`;
}
