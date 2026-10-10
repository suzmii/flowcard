import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCheck, CircleSlash, ExternalLink, X } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { Markdown } from "@/components/Markdown";
import { StateActions } from "@/components/detail/StateActions";
import { CodeChanges } from "@/components/detail/CodeChanges";
import { ConfirmPanel } from "@/components/detail/ConfirmPanel";
import { GatePanel, type CommandRunner } from "@/components/detail/GatePanel";
import { RuntimePanel } from "@/components/detail/RuntimePanel";
import { SessionPanel } from "@/components/detail/SessionPanel";
import { SessionChat } from "@/components/detail/SessionChat";
import { SlotGrid } from "@/components/detail/SlotGrid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { postCommand } from "@/lib/api";
import { STATE_LABELS, STATE_TONE } from "@/lib/contract";
import type { IssueBase } from "@/lib/projects";
import { cardActivity, cardNextStep } from "@/lib/activity";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";

type Notice = { tone: "ok" | "error"; text: string; details: string[] } | null;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** 卡片详情侧栏：六个必要项目格 + 会话 + 门禁 + 运行时 + 正文/评论（markdown）。 */
export function CardDetail({
  card,
  cards,
  issueBase,
  onClose,
  onRefresh,
}: {
  card: CardView;
  cards: CardView[];
  /** 当前项目的 Issue 基址（repo 短形 + URL 模板）：Issue 绑定入口只填数字就靠它 */
  issueBase?: IssueBase;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  /**
   * 远端评论**不自动标已读**：打开详情就清零的话，未读高亮（磁贴上的「N 条新评论」）永远看不到。
   * 标已读是人的动作 —— 这里发一枪 `markRemoteCommentsRead`，卡片上的未读随之清零。
   */
  const unreadIds = card.remoteComments.filter((comment) => !comment.read).map((comment) => comment.id);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run: CommandRunner = useCallback(
    async (label, command) => {
      setBusy(label);
      setNotice(null);
      const result = await postCommand(command);
      const rejection = result.rejection;
      if (result.ok) {
        setNotice({ tone: "ok", text: `${label}成功`, details: result.notes ?? [] });
      } else {
        setNotice({
          tone: "error",
          text: `${label}失败（${rejection?.code ?? "未知"}）：${rejection?.message ?? "未知错误"}`,
          details: [...(rejection?.missing ?? []), ...(rejection?.hint ? [rejection.hint] : [])],
        });
      }
      setBusy(null);
      await onRefresh();
    },
    [onRefresh],
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="flex-1 bg-black/30"
        role="presentation"
        onClick={onClose}
        data-testid="detail-backdrop"
      />
      <aside
        className="flex h-full w-full max-w-[46rem] flex-col border-l bg-background shadow-xl"
        role="dialog"
        aria-label={`卡片详情 ${card.title}`}
        data-testid="card-detail"
      >
        <header className="flex items-start gap-2 border-b bg-background px-4 py-3">
          <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${STATE_TONE[card.state]}`} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug">{card.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{STATE_LABELS[card.state]}</Badge>
              <span className="flex flex-wrap items-center gap-1" data-testid="detail-activity">
                {cardActivity(card).map((signal) => (
                  <Badge key={signal.key} variant={signal.tone} title={signal.detail ?? signal.label}>
                    {signal.label}
                  </Badge>
                ))}
              </span>
              <span className="text-xs text-muted-foreground" data-testid="detail-next-step">
                下一步：{cardNextStep(card)}
              </span>
              <Badge variant="muted" className="font-mono">
                {card.id}
              </Badge>
              <CopyButton value={card.id} label="复制 id" size="xs" variant="ghost" />
              <span className="text-xs text-muted-foreground">
                更新于 {timeAgo(card.updatedAt)}（{card.updatedAt}）
              </span>
            </div>
            {card.repoPath ? (
              <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                repoPath={card.repoPath}
              </div>
            ) : null}
            {card.partOf ? (
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                partOf={card.partOf} · spawned={card.spawned.length}
              </div>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {notice ? (
            <div
              className={
                notice.tone === "ok"
                  ? "rounded-lg border border-emerald-600/30 bg-emerald-50 p-2.5 text-xs text-emerald-800"
                  : "rounded-lg border border-red-600/30 bg-red-50 p-2.5 text-xs text-red-800"
              }
            >
              <div className="font-medium">{notice.text}</div>
              {notice.details.length > 0 ? (
                <ul className="mt-1 space-y-0.5">
                  {notice.details.map((detail) => (
                    <li key={detail} className="font-mono">
                      {detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {card.blockedReason ? (
            <div className="flex gap-2 rounded-lg border border-red-600/30 bg-red-50 p-2.5 text-xs text-red-800">
              <CircleSlash className="mt-0.5 size-3.5 shrink-0" />
              <span>阻塞原因：{card.blockedReason}</span>
            </div>
          ) : null}

          <Section title="状态动作" hint="人工的只有「验收（G3）」与「放弃这条」；其余推进都由事实自动完成">
            <StateActions card={card} busy={busy} onRun={run} />
          </Section>

          <Section title="必要项目" hint="空槽位也保留；每个槽位标注动作落在本地还是远程">
            <SlotGrid
              card={card}
              issueBase={issueBase}
              busy={busy}
              onRun={run}
            />
          </Section>

          <Section title="会话" hint="cwd 必须落在 worktree 内">
            <SessionPanel card={card} />
          </Section>

          <Section title="对话" hint="托管会话：在网页里直接跟这张卡说话，工具/终端输出同页可见">
            <SessionChat card={card} />
          </Section>

          <CodeChanges card={card} onRefresh={onRefresh} />

          <Section title="门禁" hint="未决门禁可在这里批准/驳回">
            <GatePanel card={card} busy={busy} onRun={run} />
          </Section>

          <Section title="远程写确认（G2）" hint="一事一议：一次批准只覆盖一次动作">
            <ConfirmPanel card={card} busy={busy} onRun={run} />
          </Section>

          <Section title="运行时" hint="/api/cards/:id/runtime">
            <RuntimePanel card={card} cards={cards} onRefresh={onRefresh} />
          </Section>

          {card.body ? (
            <Section title="正文" hint="markdown（不解析原始 HTML）">
              <div
                className="rounded-lg border bg-background p-2.5"
                data-testid="card-body-markdown"
              >
                <Markdown text={card.body} />
              </div>
            </Section>
          ) : null}

          {card.comments.length > 0 ? (
            <Section title="评论" hint={`${card.comments.length} 条 · markdown`}>
              <ul className="space-y-2" data-testid="card-comments">
                {card.comments.map((comment) => (
                  <li key={comment.id} className="rounded-lg border bg-background p-2.5">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="muted">{comment.actor.kind}</Badge>
                      <span className="font-mono">{comment.actor.name ?? comment.actor.harness ?? "—"}</span>
                      <span className="ml-auto">{timeAgo(comment.at)}</span>
                    </div>
                    <Markdown text={comment.body} />
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {card.remoteComments.length > 0 ? (
            <Section
              title="远端动态"
              hint={`${card.remoteComments.length} 条远端评论 · 只读（同步进来的，点标题回远端看）`}
            >
              {unreadIds.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-600/40 bg-sky-50/60 p-2 text-[11px] text-sky-900">
                  <span>未读的会一直高亮（这里不自动标已读：看过再动手，磁贴上的未读数才有意义）。</span>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="remote-mark-read"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("标记远端评论已读", {
                        cmd: "markRemoteCommentsRead",
                        actor: { kind: "human", name: "看板" },
                        card: card.id,
                        ids: unreadIds,
                      })
                    }
                  >
                    <CheckCheck />
                    标为已读（{unreadIds.length} 条）
                  </Button>
                </div>
              ) : null}
              <ul className="space-y-2" data-testid="card-remote-comments">
                {card.remoteComments.map((comment) => (
                  <li
                    key={comment.id}
                    data-testid={`remote-comment-${comment.id}`}
                    className={cn(
                      "rounded-lg border bg-background p-2.5",
                      !comment.read && "border-sky-600/40 bg-sky-50/40",
                    )}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="info">#{comment.issueNumber}</Badge>
                      <span className="font-mono">{comment.author || "—"}</span>
                      {comment.read ? <Badge variant="muted">已读</Badge> : <Badge variant="warning">未读</Badge>}
                      <span className="ml-auto">{timeAgo(comment.at)}</span>
                    </div>
                    {/* 远端是别人写的 markdown：外链图片不自动加载（隐私），只给可点的链接 */}
                    <Markdown text={comment.body} blockRemoteImages />
                    {comment.url ? (
                      <a
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-700 underline"
                        href={comment.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid={`remote-comment-link-${comment.id}`}
                      >
                        <ExternalLink className="size-3" />
                        在远端打开
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
