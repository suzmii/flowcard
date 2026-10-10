/**
 * 评审面板：三个判定动作（approve / request-changes / comment）+ 当前判定 + 评审记录（历史）。
 *
 * **语义（文案必须说清）**：评审只是本地记录的意见 —— approve **不会**把卡片推到下一列，
 * 验收仍然由人在「状态动作」区点「验收（G3）」（accept，服务端一次合成 G3 的 requested+decided）。
 * 判定与评论都走 `POST /api/commands`，不碰远程、不动 worktree。
 * 契约只给最新一条 `card.review.verdict`，所以这里显示“当前判定” + 评论时间线当历史。
 */
import { useState, type ReactNode } from "react";
import { CheckCircle2, MessageSquare, MessageSquareWarning, ShieldCheck } from "lucide-react";
import { CommentCard } from "@/components/detail/DiffFileView";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { VERDICT_LABELS, VERDICT_TONE, type ReviewOutcome } from "@/lib/review";
import type { Review, ReviewVerdictKind } from "@/lib/contract";
import { timeAgo } from "@/lib/utils";

/** 三个动作的按钮外观：判定语义不只靠颜色，图标 + 文字都带。 */
const ACTIONS: { verdict: ReviewVerdictKind; label: string; icon: ReactNode; variant: "default" | "outline" | "destructive" }[] = [
  { verdict: "approve", label: "同意 approve", icon: <ShieldCheck />, variant: "default" },
  { verdict: "request_changes", label: "要求修改 request-changes", icon: <MessageSquareWarning />, variant: "destructive" },
  { verdict: "comment", label: "仅评论 comment", icon: <MessageSquare />, variant: "outline" },
];

export function ReviewPanel({
  review,
  onSubmit,
}: {
  review: Review;
  onSubmit: (verdict: ReviewVerdictKind, body: string) => Promise<ReviewOutcome>;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState<ReviewVerdictKind | null>(null);
  const [error, setError] = useState<(ReviewOutcome & { ok: false }) | null>(null);

  const act = async (verdict: ReviewVerdictKind) => {
    setSending(verdict);
    setError(null);
    const outcome = await onSubmit(verdict, body);
    setSending(null);
    if (outcome.ok) {
      setBody("");
      return;
    }
    setError(outcome);
  };

  const verdict = review.verdict ?? null;
  const comments = review.comments;

  return (
    <div className="space-y-2 rounded-lg border bg-background p-2.5" data-testid="review-panel">
      <div className="flex flex-wrap items-center gap-1.5">
        <CheckCircle2 className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">评审判定</span>
        {verdict ? (
          <Badge variant={VERDICT_TONE[verdict.decision]} data-testid="review-current-verdict">
            {VERDICT_LABELS[verdict.decision]}
          </Badge>
        ) : (
          <Badge variant="muted" data-testid="review-current-verdict">
            还没有判定
          </Badge>
        )}
        {verdict ? (
          <span className="text-[11px] text-muted-foreground">
            {verdict.by ?? "?"} · {timeAgo(verdict.at)}（{verdict.at}）
          </span>
        ) : null}
      </div>

      <p className="rounded border border-sky-600/30 bg-sky-50/60 p-1.5 text-[11px] text-sky-900" data-testid="review-semantics">
        这里<strong>只记录意见</strong>：approve 不会自动改卡片状态，也不会合并 PR。验收是人拍板的动作，在
        「状态动作」区点<strong>「验收（G3）」</strong>；合并由人自己做（本页不写远程）。
      </p>

      {verdict?.body ? (
        <div className="rounded border bg-muted/40 p-2">
          <div className="mb-0.5 text-[11px] text-muted-foreground">判定说明</div>
          <Markdown text={verdict.body} />
        </div>
      ) : null}

      <Textarea
        value={body}
        placeholder="判定说明（可空；写清理由更好审）"
        data-testid="review-verdict-body"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {ACTIONS.map((action) => (
          <Button
            key={action.verdict}
            size="xs"
            variant={action.variant}
            disabled={sending !== null}
            data-testid={`review-verdict-${action.verdict}`}
            onClick={() => void act(action.verdict)}
          >
            {action.icon}
            {sending === action.verdict ? "提交中…" : action.label}
          </Button>
        ))}
        <span className="text-[11px] text-muted-foreground">POST /api/commands · reviewVerdict</span>
      </div>

      {error ? (
        <div className="rounded border border-red-600/30 bg-red-50 p-2 text-xs text-red-800" data-testid="review-verdict-error">
          <div className="font-medium">
            服务端拒绝（{error.code}）：{error.message}
          </div>
          {error.details.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5">
              {error.details.map((detail) => (
                <li key={detail} className="font-mono">
                  {detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1" data-testid="review-history">
        <div className="text-[11px] font-medium text-muted-foreground">
          评审记录（历史 · {comments.length} 条评论）
        </div>
        {comments.length === 0 ? (
          <p className="rounded border border-dashed p-2 text-[11px] text-muted-foreground">
            还没有评论：在上面的 diff 里点某一行就能写。
          </p>
        ) : (
          <ul className="space-y-1">
            {[...comments]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((comment) => (
                <li key={comment.id} data-testid="review-history-item">
                  <CommentCard comment={comment} />
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
