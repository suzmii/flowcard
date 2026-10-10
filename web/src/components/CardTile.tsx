import { CircleDot, GitPullRequest, Lock, MessageSquare, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RUNTIME_TONE, SESSION_STATE_LABELS } from "@/lib/contract";
import { cardActivity } from "@/lib/activity";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";

const SESSION_TONE: Record<string, string> = {
  idle: "bg-neutral-400",
  running: "bg-emerald-600",
  ended: "bg-slate-400",
  lost: "bg-red-600",
};

export function CardTile({
  card,
  selected,
  onSelect,
}: {
  card: CardView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const activity = cardActivity(card);
  const openGates = Object.values(card.gates).filter((gate) => gate.status === "open");
  const runtime = card.runtime ?? null;
  const unreadComments = card.remoteComments.filter((comment) => !comment.read).length;

  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      className={cn(
        "w-full shrink-0 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
        selected && "border-foreground/60 ring-2 ring-ring/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-dashed text-[10px] text-muted-foreground"
          title="优先级（暂未定）"
        >
          —
        </span>
        <span className="line-clamp-2 text-sm font-medium leading-snug">{card.title}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {card.session ? (
          <Badge variant="outline" title={`会话 ${card.session.id}（${card.session.cwd}）`}>
            <span className={`size-1.5 rounded-full ${SESSION_TONE[card.session.state] ?? "bg-neutral-400"}`} />
            {card.session.harness}
            <span className="text-muted-foreground">
              {SESSION_STATE_LABELS[card.session.state] ?? card.session.state}
            </span>
          </Badge>
        ) : (
          <Badge variant="muted">无会话</Badge>
        )}

        {card.issue ? (
          <Badge variant="info" title={card.issue.title ?? card.issue.url}>
            <CircleDot />
            {card.issue.number}
          </Badge>
        ) : (
          <Badge variant="muted" title="没有绑定 Issue">
            <CircleDot className="opacity-40" />无 Issue
          </Badge>
        )}

        {card.pr ? (
          <Badge variant="info" title={`${card.pr.branch} · CI ${card.pr.ci ?? "未知"}`}>
            <GitPullRequest />
            {card.pr.number}
          </Badge>
        ) : (
          <Badge variant="muted" title="没有 WIP PR">
            <GitPullRequest className="opacity-40" />无 PR
          </Badge>
        )}

        {activity.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1" data-testid="tile-activity">
            {activity.slice(0, 2).map((signal) => (
              <Badge key={signal.key} variant={signal.tone} title={signal.detail ?? signal.label} data-testid={`tile-activity-${signal.key}`}>
                {signal.label}
              </Badge>
            ))}
          </span>
        ) : null}

        {openGates.length > 0 ? (
          <Badge variant="warning" title={openGates.map((gate) => `${gate.id} ${gate.title}`).join(" / ")}>
            <Lock />
            门禁 {openGates.map((g) => g.id).join("+")}
          </Badge>
        ) : null}

        {unreadComments > 0 ? (
          <Badge
            variant="info"
            data-testid="tile-remote-unread"
            title={`${unreadComments} 条未读远端评论（打开卡片就标已读）`}
          >
            <MessageSquare />
            {unreadComments} 条新评论
          </Badge>
        ) : null}

        {runtime ? (
          <Badge
            variant={runtime.status === "running" ? "success" : runtime.status === "failed" ? "danger" : "muted"}
            title={`运行时 ${runtime.status}${runtime.pid ? ` pid ${runtime.pid}` : ""}`}
          >
            <span className={`size-1.5 rounded-full ${RUNTIME_TONE[runtime.status]}`} />
            <Play className="size-3" />
            {runtime.status}
          </Badge>
        ) : null}
      </div>

      {card.blockedReason ? (
        <p className="mt-2 line-clamp-2 rounded bg-red-50 px-1.5 py-1 text-xs text-red-700">
          阻塞：{card.blockedReason}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{card.id}</span>
        <span className="ml-auto">{timeAgo(card.updatedAt)}</span>
      </div>
    </button>
  );
}
