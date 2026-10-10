/**
 * 代码评审（本地记录）：行级评论与判定都挂在 `card.review`（由 `schema.ts` 校验，类型来自共享契约）。
 *
 * 两个语义要点（UI 文案里也要写清）：
 * - 评审**只记录意见**：approve 不会自动改卡片状态，验收仍由人在「门禁」里点 G3。
 * - 写入只走 `POST /api/commands`（`reviewComment` / `reviewVerdict`），不碰远程、不动 worktree。
 */
import { postCommand } from "@/lib/api";
import type { ReviewVerdictKind } from "@/lib/contract";

export const REVIEW_VERDICT_KINDS = ["approve", "request_changes", "comment"] as const;

export const VERDICT_LABELS: Record<ReviewVerdictKind, string> = {
  approve: "同意（approve）",
  request_changes: "要求修改（request-changes）",
  comment: "仅评论（comment）",
};

export const VERDICT_TONE: Record<ReviewVerdictKind, "success" | "danger" | "muted"> = {
  approve: "success",
  request_changes: "danger",
  comment: "muted",
};

/** 一条评审写入的结果：失败时把服务端 rejection 原文一起带回来（UI 直接展示）。 */
export type ReviewOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string; details: string[] };

const HUMAN_ACTOR = { kind: "human", name: "me" } as const;

export function reviewCommentCommand(input: {
  cardId: string;
  sha: string;
  path: string;
  line: number;
  side: "new" | "old";
  body: string;
}): Record<string, unknown> {
  return {
    cmd: "reviewComment",
    actor: HUMAN_ACTOR,
    card: input.cardId,
    sha: input.sha,
    path: input.path,
    line: input.line,
    side: input.side,
    body: input.body,
  };
}

export function reviewVerdictCommand(input: {
  cardId: string;
  verdict: ReviewVerdictKind;
  body?: string;
}): Record<string, unknown> {
  return {
    cmd: "reviewVerdict",
    actor: HUMAN_ACTOR,
    card: input.cardId,
    verdict: input.verdict,
    ...(input.body && input.body.trim() ? { body: input.body.trim() } : {}),
  };
}

/** 统一的写入 + 错误翻译：网络失败、契约不符、服务端拒绝都收敛成一段可读文案。 */
export async function sendReview(command: Record<string, unknown>): Promise<ReviewOutcome> {
  const result = await postCommand(command);
  if (result.ok) return { ok: true };
  const rejection = result.rejection;
  return {
    ok: false,
    code: rejection?.code ?? "UNKNOWN",
    message: rejection?.message ?? "未知错误（响应里没有 rejection）",
    details: [...(rejection?.missing ?? []), ...(rejection?.hint ? [rejection.hint] : [])],
  };
}

// ------------------------------------------------------------------ 契约锁
// 若 `src/shared/types.ts` 增删判定动作，下面的断言会让 web 的类型检查直接失败。
type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type _VerdictKindsExactlyMatch =
  Assert<Equal<(typeof REVIEW_VERDICT_KINDS)[number], ReviewVerdictKind>>;
type _VerdictLabelsAreExhaustive = Assert<Equal<keyof typeof VERDICT_LABELS, ReviewVerdictKind>>;
