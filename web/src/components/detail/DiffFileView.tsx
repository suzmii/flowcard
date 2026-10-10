/**
 * 单个文件的 diff：hunk 展开 + 行号双列 + 行级评论（点行/行号打开小输入框）。
 *
 * 只读：这里不写任何文件、不动 worktree；行级评论只走 `reviewComment` 命令记进事件流。
 * 大文件靠"文件折叠（默认收起）+ 横向滚动"控制渲染量，不做虚拟列表（几百行足够）。
 */
import { Fragment, useState } from "react";
import { ChevronRight, MessageSquarePlus, TriangleAlert } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_LABELS, STATUS_TONE, anchorKey, lineAnchor, type DiffFile } from "@/lib/diff";
import type { ReviewComment } from "@/lib/contract";
import { shortSha } from "@/lib/graph";
import { type ReviewOutcome } from "@/lib/review";
import { cn, timeAgo } from "@/lib/utils";

const LINE_TONE: Record<"context" | "add" | "del", string> = {
  add: "bg-emerald-50 text-emerald-900",
  del: "bg-red-50 text-red-900",
  context: "text-foreground",
};

const LINE_MARKER: Record<"context" | "add" | "del", string> = {
  add: "+",
  del: "-",
  context: " ",
};

/** 一位评审评论：outdated 的默认折叠，但仍标出它基于哪个提交。 */
export function CommentCard({ comment }: { comment: ReviewComment }) {
  const [open, setOpen] = useState(!comment.outdated);
  const outdated = comment.outdated;

  return (
    <div
      className={cn(
        "rounded-md border p-1.5",
        outdated ? "border-amber-500/50 bg-amber-50/60" : "bg-muted/40",
      )}
      data-testid="review-comment"
      data-outdated={outdated ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquarePlus className="size-3 shrink-0" />
        <Badge variant="muted">{comment.actor.kind}</Badge>
        <span className="font-mono">{comment.actor.name ?? comment.actor.harness ?? "?"}</span>
        <span className="font-mono" title={comment.sha}>
          {shortSha(comment.sha)}
        </span>
        <span>
          {comment.path}:{comment.line}（{comment.side === "old" ? "旧" : "新"}行）
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {outdated ? (
            <button
              type="button"
              data-testid="review-comment-outdated-toggle"
              className="rounded border border-amber-600/40 px-1 py-0.5 hover:bg-amber-100"
              onClick={() => setOpen((prev) => !prev)}
            >
              已过期（基于 {shortSha(comment.sha)}）{open ? "· 收起" : "· 展开"}
            </button>
          ) : null}
          <span>{timeAgo(comment.at)}</span>
        </span>
      </div>
      {open ? <Markdown text={comment.body} /> : null}
    </div>
  );
}

/** 行级评论输入框：提交失败时把服务端 rejection 原文照抄出来。 */
function Composer({
  path,
  line,
  side,
  onSubmit,
  onCancel,
}: {
  path: string;
  line: number;
  side: "new" | "old";
  onSubmit: (body: string) => Promise<ReviewOutcome>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<ReviewOutcome & { ok: false } | null>(null);

  const submit = async () => {
    if (body.trim() === "") {
      setError({
        ok: false,
        code: "EMPTY",
        message: "评论不能为空",
        details: [],
      });
      return;
    }
    setSending(true);
    setError(null);
    const outcome = await onSubmit(body.trim());
    setSending(false);
    if (outcome.ok) {
      setBody("");
      onCancel();
      return;
    }
    setError(outcome);
  };

  return (
    <div className="my-1 ml-1 space-y-1.5 rounded-md border-2 border-sky-600/40 bg-sky-50/60 p-2" data-testid="review-composer">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono">评论 {path}</span>
        <Badge variant="info">
          {side === "old" ? "旧行" : "新行"} {line}
        </Badge>
        <span>markdown · 只记意见，不改代码、不改卡片状态</span>
      </div>
      <Textarea
        autoFocus
        value={body}
        placeholder="这条改动的问题 / 建议（markdown 文本，可空行分点）"
        data-testid="review-composer-input"
        onChange={(event) => setBody(event.target.value)}
      />
      {error ? (
        <div className="rounded border border-red-600/30 bg-red-50 p-1.5 text-[11px] text-red-800" data-testid="review-composer-error">
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
      <div className="flex items-center gap-1.5">
        <Button size="xs" disabled={sending} onClick={() => void submit()} data-testid="review-composer-submit">
          {sending ? "提交中…" : "提交评论"}
        </Button>
        <Button size="xs" variant="ghost" disabled={sending} onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

export function DiffFileView({
  file,
  index,
  comments,
  headSha,
  onSubmitComment,
  defaultOpen = false,
}: {
  file: DiffFile;
  /** 文件在响应里的序号：文件路径可能为空（服务端异常），testid 用它才唯一 */
  index: number;
  /** 落在这个文件上的评论（由容器按 path 过滤好） */
  comments: ReviewComment[];
  headSha: string;
  onSubmitComment: (input: { path: string; line: number; side: "new" | "old"; body: string }) => Promise<ReviewOutcome>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [anchor, setAnchor] = useState<{ side: "new" | "old"; line: number } | null>(null);

  const inline = new Map<string, ReviewComment[]>();
  const orphans: ReviewComment[] = [];
  const liveKeys = new Set<string>();
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      const spot = lineAnchor(line);
      if (spot) liveKeys.add(anchorKey(spot.side, spot.line));
    }
  }
  for (const comment of comments) {
    const key = anchorKey(comment.side, comment.line);
    if (!liveKeys.has(key)) {
      orphans.push(comment);
      continue;
    }
    const bucket = inline.get(key);
    if (bucket) bucket.push(comment);
    else inline.set(key, [comment]);
  }
  for (const bucket of inline.values()) bucket.sort((a, b) => a.at.localeCompare(b.at));
  orphans.sort((a, b) => b.at.localeCompare(a.at));

  const binary = file.status === "binary";
  const label =
    file.path === ""
      ? "(服务端没给 path)"
      : file.oldPath && file.oldPath !== file.path
        ? `${file.oldPath} → ${file.path}`
        : file.path;

  return (
    <div className="rounded-lg border bg-background" data-testid="diff-file" data-file-path={file.path}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        data-testid={`diff-file-toggle-${index}`}
        className="flex w-full flex-wrap items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/40"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <Badge variant={STATUS_TONE[file.status]}>{STATUS_LABELS[file.status]}</Badge>
        <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{label}</span>
        {typeof file.additions === "number" ? (
          <span className="font-mono text-[11px] text-emerald-700">+{file.additions}</span>
        ) : null}
        {typeof file.deletions === "number" ? (
          <span className="font-mono text-[11px] text-red-700">-{file.deletions}</span>
        ) : null}
        {comments.length > 0 ? (
          <Badge variant="info" title="这个文件上的评审评论">
            {comments.length} 条评论
          </Badge>
        ) : null}
        {binary ? <Badge variant="muted">不渲染内容</Badge> : null}
      </button>

      {open ? (
        <div className="space-y-2 border-t px-2 py-2">
          {binary ? (
            <p className="rounded border border-dashed p-2 text-[11px] text-muted-foreground" data-testid="diff-binary">
              二进制文件（status=binary）：只显示标记与增删统计，不渲染内容。
            </p>
          ) : file.hunks.length === 0 ? (
            <p className="rounded border border-dashed p-2 text-[11px] text-muted-foreground" data-testid="diff-no-hunks">
              服务端没有给 hunk（可能只回文件列表，或该文件的改动全在二进制/权限位）。
            </p>
          ) : (
            <div>
              {file.hunks.map((hunk, hunkIndex) => (
                <div key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
                  <div className="flex gap-2 bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    <span className="w-10 shrink-0 text-right">{hunk.oldStart},{hunk.oldLines}</span>
                    <span className="w-10 shrink-0 text-right">{hunk.newStart},{hunk.newLines}</span>
                    <span className="min-w-0 break-all whitespace-pre">
                      {hunk.header ?? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
                    </span>
                  </div>
                  {hunk.lines.map((line, lineIndex) => {
                    const spot = lineAnchor(line);
                    const key = spot ? anchorKey(spot.side, spot.line) : null;
                    const bucket = key ? (inline.get(key) ?? []) : [];
                    const composing = spot !== null && anchor !== null && anchor.side === spot.side && anchor.line === spot.line;
                    return (
                      <Fragment key={`${key ?? "x"}-${lineIndex}`}>
                        <div className="overflow-x-auto hover:bg-sky-50/70">
                          <button
                            type="button"
                            disabled={spot === null}
                            data-testid="diff-line"
                            data-path={file.path}
                            data-line={spot?.line ?? ""}
                            data-side={spot?.side ?? ""}
                            onClick={() => spot && setAnchor(spot)}
                            title={spot ? `点这行写下评论（${spot.side === "old" ? "旧" : "新"}行 ${spot.line}）` : "这一行没有可评论的行号"}
                            className={cn(
                              "flex w-full min-w-max items-stretch text-left font-mono text-[11px] leading-5",
                              LINE_TONE[line.kind],
                            )}
                          >
                            <span className="w-10 shrink-0 select-none border-r px-1 text-right text-muted-foreground">
                              {line.oldLine ?? ""}
                            </span>
                            <span className="w-10 shrink-0 select-none border-r px-1 text-right text-muted-foreground">
                              {line.newLine ?? ""}
                            </span>
                            <span className="w-4 shrink-0 select-none text-center">{LINE_MARKER[line.kind]}</span>
                            <span className="whitespace-pre pr-2">{line.text === "" ? " " : line.text}</span>
                          </button>
                        </div>
                        {bucket.map((comment) => (
                          <div key={comment.id} className="py-0.5 pl-4">
                            <CommentCard comment={comment} />
                          </div>
                        ))}
                        {composing && spot ? (
                          <div className="pl-4">
                            <Composer
                              path={file.path}
                              line={spot.line}
                              side={spot.side}
                              onCancel={() => setAnchor(null)}
                              onSubmit={(body) =>
                                onSubmitComment({ path: file.path, line: spot.line, side: spot.side, body })
                              }
                            />
                          </div>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {orphans.length > 0 ? (
            <div className="space-y-1 rounded border border-amber-500/40 bg-amber-50/50 p-2" data-testid="diff-orphan-comments">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-900">
                <TriangleAlert className="size-3.5" />
                {orphans.length} 条评论所在的行不在当前 diff 里（基于旧提交或该 hunk 已变）
              </div>
              {orphans.map((comment) => (
                <CommentCard key={comment.id} comment={comment} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}


