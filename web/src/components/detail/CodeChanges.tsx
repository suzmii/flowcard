/**
 * 卡片详情里的「代码变更」块（可折叠，默认收起，不挤占六格必要项目）。
 *
 * 组成：只读 diff（文件列表 → hunk）+ 行级评论 + 评审判定（approve / request-changes / comment）。
 * 数据来源：diff 走 `GET /api/cards/:id/diff`（只读）；评审（`card.review`）随卡片一起来，
 * 写入只走 `POST /api/commands`（reviewComment / reviewVerdict）——都不碰远程、不动 worktree。
 * 写入成功后重拉卡片（onRefresh），所以评论/判定立刻出现，不依赖 SSE 是否推了事件。
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, FileCode2, GitCompare, RefreshCw } from "lucide-react";
import { CommentCard, DiffFileView } from "@/components/detail/DiffFileView";
import { ReviewPanel } from "@/components/detail/ReviewPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReviewVerdictKind } from "@/lib/contract";
import { fetchDiff, type DiffResult } from "@/lib/diff";
import { shortSha } from "@/lib/graph";
import {
  VERDICT_LABELS,
  reviewCommentCommand,
  reviewVerdictCommand,
  sendReview,
  type ReviewOutcome,
} from "@/lib/review";
import type { CardView } from "@/lib/schema";
import { cn } from "@/lib/utils";

export function CodeChanges({ card, onRefresh }: { card: CardView; onRefresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDiff = useCallback(async () => {
    setLoading(true);
    const result = await fetchDiff(card.id);
    setDiff(result);
    setLoading(false);
  }, [card.id]);

  // 展开时才拉（默认收起：卡片详情打开时不多打一次请求）；每次展开都重读，拿最新的 head。
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    void loadDiff();
  }, [open, loadDiff]);

  const review = card.review;
  const headSha = diff?.ok ? diff.data.headSha || diff.data.head : "";

  const submitComment = useCallback<
    (input: { path: string; line: number; side: "new" | "old"; body: string }) => Promise<ReviewOutcome>
  >(
    async (input) => {
      setBusy(true);
      const outcome = await sendReview(
        reviewCommentCommand({
          cardId: card.id,
          sha: headSha,
          path: input.path,
          line: input.line,
          side: input.side,
          body: input.body,
        }),
      );
      setBusy(false);
      if (outcome.ok) {
        setNotice(`已记录评论：${input.path}:${input.line}（${input.side === "old" ? "旧" : "新"}行）`);
        await onRefresh();
      }
      return outcome;
    },
    [card.id, headSha, onRefresh],
  );

  const submitVerdict = useCallback<(verdict: ReviewVerdictKind, body: string) => Promise<ReviewOutcome>>(
    async (verdict, body) => {
      setBusy(true);
      const outcome = await sendReview(reviewVerdictCommand({ cardId: card.id, verdict, body }));
      setBusy(false);
      if (outcome.ok) {
        setNotice(`已记录判定：${VERDICT_LABELS[verdict]}（卡片状态不变，验收仍在门禁区）`);
        await onRefresh();
      }
      return outcome;
    },
    [card.id, onRefresh],
  );

  const data = diff?.ok ? diff.data : null;
  const summary = data
    ? `${data.files.length} 个文件 +${data.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)} -${data.files.reduce(
        (sum, file) => sum + (file.deletions ?? 0),
        0,
      )}`
    : null;
  const filePaths = new Set((data?.files ?? []).map((file) => file.path));
  const commentsOutside = review.comments.filter((comment) => !filePaths.has(comment.path));

  return (
    <section className="space-y-2" data-testid="code-changes">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        data-testid="code-changes-toggle"
        className="flex w-full flex-wrap items-center gap-2 text-left"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <h3 className="text-sm font-semibold">代码变更</h3>
        <span className="text-[11px] text-muted-foreground">
          只读 diff · 行级评论 · 判定（只记意见，不动卡片状态）
        </span>
        {data ? (
          <>
            <Badge variant="outline" data-testid="code-changes-summary">
              {summary}
            </Badge>
            <Badge variant="muted" className="font-mono" title={`${data.baseSha} → ${data.headSha}`}>
              {shortSha(data.baseSha)} → {shortSha(data.headSha)}
            </Badge>
          </>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "收起" : "展开"}</span>
      </button>

      {!open ? (
        <p className="rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs text-muted-foreground">
          收起中 · 展开后读 GET /api/cards/{card.id}/diff（只读：不在 worktree 里写任何东西）。
        </p>
      ) : (
        <div className="space-y-2">
          {notice ? (
            <p
              className="rounded-lg border border-emerald-600/30 bg-emerald-50 p-2 text-xs text-emerald-800"
              data-testid="code-changes-notice"
            >
              {notice}
            </p>
          ) : null}

          <div className="rounded-lg border bg-background p-2.5" data-testid="diff-block">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <GitCompare className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">代码变更（只读）</span>
              {data ? (
                <>
                  <Badge variant="outline" className="font-mono">
                    {data.base || "base"} → {data.head || "head"}
                  </Badge>
                  <Badge variant="outline" className="font-mono" title={`${data.baseSha} → ${data.headSha}`}>
                    {shortSha(data.baseSha)} → {shortSha(data.headSha)}
                  </Badge>
                </>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                className="ml-auto"
                disabled={loading}
                data-testid="diff-refresh"
                onClick={() => void loadDiff()}
              >
                <RefreshCw className={loading ? "animate-spin" : undefined} />
                重读
              </Button>
            </div>

            {loading && !diff ? (
              <div className="space-y-1.5" data-testid="diff-loading">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : null}

            {diff && !diff.ok ? (
              <div
                className="flex items-start gap-2 rounded-lg border border-red-600/30 bg-red-50 p-2.5 text-xs text-red-800"
                data-testid="diff-error"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-1">
                  <div className="font-medium" data-testid="diff-error-message">
                    拿不到代码变更（{diff.code}）：{diff.message}
                  </div>
                  {diff.hint ? <div className="text-red-700/80">下一步：{diff.hint}</div> : null}
                  <div className="text-red-700/80">
                    {card.worktree ? (
                      <>
                        卡片已绑 worktree <code className="font-mono">{card.worktree.path}</code>
                        （分支 {card.worktree.branch}）：确认分支上有相对基线的新提交。
                      </>
                    ) : (
                      <>
                        这张卡还没有 worktree：先在「必要项目 → worktree + 分支」里绑定
                        （会话里 <code className="font-mono">/wt feat/xxx</code>，或让 CLI 建），再回来看。
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {data ? (
              <>
                {data.truncated ? (
                  <p
                    className="mb-2 rounded border border-amber-500/50 bg-amber-50 p-2 text-[11px] text-amber-900"
                    data-testid="diff-truncated"
                  >
                    diff 被截断（truncated: true）：只列出了部分文件，重活请直接在 worktree 里看
                    <code className="mx-1 font-mono">git diff</code>
                    {data.truncatedReason ? <span className="block">服务端原因：{data.truncatedReason}</span> : null}
                  </p>
                ) : null}

                {data.files.length === 0 ? (
                  <p
                    className="rounded border border-dashed p-2 text-[11px] text-muted-foreground"
                    data-testid="diff-empty"
                  >
                    {data.base} → {data.head} 之间没有文件改动（工作区干净 / 分支与基线一致）。
                  </p>
                ) : (
                  <div className="space-y-1.5" data-testid="diff-files">
                    {data.files.map((file, index) => (
                      <DiffFileView
                        key={`${index}-${file.path}`}
                        index={index}
                        file={file}
                        comments={review.comments.filter((comment) => comment.path === file.path)}
                        headSha={data.headSha}
                        defaultOpen={data.files.length <= 3 && index === 0}
                        onSubmitComment={submitComment}
                      />
                    ))}
                  </div>
                )}

                {commentsOutside.length > 0 ? (
                  <div
                    className="mt-2 space-y-1 rounded border border-amber-500/50 bg-amber-50/50 p-2"
                    data-testid="diff-comments-outside"
                  >
                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-900">
                      <FileCode2 className="size-3.5 shrink-0" />
                      {commentsOutside.length} 条评论落在本次 diff 之外（文件已不在 diff 里）：按行内联不了，这里照样能看到。
                    </p>
                    {commentsOutside.map((comment) => (
                      <CommentCard key={comment.id} comment={comment} />
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          <ReviewPanel review={review} onSubmit={submitVerdict} />

          {busy ? <p className="text-[11px] text-muted-foreground">正在提交评审写入…</p> : null}
          <p className="text-[11px] text-muted-foreground">
            GET /api/cards/{card.id}/diff（只读） · POST /api/commands reviewComment / reviewVerdict（本地记录）
          </p>
        </div>
      )}
    </section>
  );
}
