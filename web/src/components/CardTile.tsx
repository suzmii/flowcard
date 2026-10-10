import { CircleDot, GitBranch, GitPullRequest, Lock, MessageSquare, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RUNTIME_TONE, SESSION_STATE_LABELS } from "@/lib/contract";
import { badgeSignals, sessionLight } from "@/lib/activity";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";

const SESSION_TONE: Record<string, string> = {
  idle: "bg-neutral-400",
  running: "bg-emerald-600",
  ended: "bg-slate-400",
  lost: "bg-red-600",
};

const LIGHT_TONE: Record<string, string> = {
  running: "bg-emerald-500 animate-pulse",
  idle: "bg-sky-500",
  lost: "bg-red-500",
  ended: "bg-neutral-400",
  failed: "bg-red-600",
};

/**
 * worktree 路径短形：只留最后两段（`.worktrees/<名字>`）。
 * 全路径永远在 tooltip 里 —— 磁贴只有 17.5rem 宽，塞不下绝对路径。
 */
function shortWorktreePath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts.slice(-2).join("/");
}

export function CardTile({
  card,
  selected,
  onSelect,
  onSelectSession,
}: {
  card: CardView;
  selected: boolean;
  /** 打开卡片详情。 */
  onSelect: (id: string) => void;
  /** 点会话灯/会话徽标：同样打开详情，但直接落在对话区（不给就退回 onSelect）。 */
  onSelectSession?: (id: string) => void;
}) {
  const activity = badgeSignals(card);
  const light = sessionLight(card);
  const openGates = Object.values(card.gates).filter((gate) => gate.status === "open");
  const runtime = card.runtime ?? null;
  const unreadComments = card.remoteComments.filter((comment) => !comment.read).length;
  const worktree = card.worktree;
  // 磁贴主点击（打开详情）不变；会话相关的入口直接进**会话视图**（不进详情）。
  const openSession = onSelectSession ?? onSelect;

  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      className={cn(
        "relative w-full shrink-0 rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
        selected && "border-foreground/60 ring-2 ring-ring/40",
      )}
    >
      {light ? (
        // 会话灯 = 会话入口：点一下直接进这张卡的**会话视图**。
        // 用 after 撑大命中区（灯本身只有 10px），不改磁贴的主点击。
        <span
          className={cn(
            "absolute right-2 top-2 size-2.5 cursor-pointer rounded-full ring-2 ring-card after:absolute after:-inset-2 after:content-['']",
            LIGHT_TONE[light.tone],
          )}
          data-testid="tile-session-light"
          data-light-tone={light.tone}
          title={`${light.label} · 打开会话视图`}
          aria-label={`${light.label}（打开对话）`}
          onClick={(event) => {
            event.stopPropagation();
            openSession(card.id);
          }}
        />
      ) : null}

      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-dashed text-[10px] text-muted-foreground"
          title="优先级（暂未定）"
        >
          —
        </span>
        <span className="line-clamp-2 text-sm font-medium leading-snug">{card.title}</span>
        {/* 常驻聊天入口：任何卡都有（没会话的卡进去后能看到「启动会话」）。
            灯只对有会话的卡点，所以这个按钮才是"每张卡都能进对话"的那条路。 */}
        <span
          className="ml-auto shrink-0 cursor-pointer rounded border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          data-testid="tile-chat"
          title="打开会话视图"
          aria-label="打开会话视图"
          onClick={(event) => {
            event.stopPropagation();
            openSession(card.id);
          }}
        >
          对话
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {card.session ? (
          <Badge
            variant="outline"
            className="cursor-pointer"
            data-testid="tile-session-badge"
            title={`会话 ${card.session.id}（${card.session.cwd}）· 打开会话视图`}
            onClick={(event) => {
              event.stopPropagation();
              openSession(card.id);
            }}
          >
            <span className={`size-1.5 rounded-full ${SESSION_TONE[card.session.state] ?? "bg-neutral-400"}`} />
            {card.session.harness}
          </Badge>
        ) : null}

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

        {/* worktree 与 Issue / PR 一样是常驻槽位：有没有都画出来。 */}
        {worktree ? (
          <Badge
            variant="info"
            className="max-w-full min-w-0"
            data-testid="tile-worktree"
            data-worktree={worktree.branch}
            data-worktree-source={worktree.source}
            title={`worktree ${worktree.path}\n分支 ${worktree.branch} · 来源 ${worktree.source}（harness / flowcard）`}
          >
            <GitBranch className="shrink-0" />
            {/* 分支名可能很长：截断显示，全名与全路径都在 tooltip 里 */}
            <span className="max-w-[9rem] truncate">{worktree.branch}</span>
            <span
              className="max-w-[6rem] truncate font-mono text-[10px] font-normal opacity-70"
              title={worktree.path}
            >
              …/{shortWorktreePath(worktree.path)}
            </span>
          </Badge>
        ) : (
          <Badge variant="muted" data-testid="tile-worktree" data-worktree="none" title="没有绑定 worktree">
            <GitBranch className="opacity-40" />无 worktree
          </Badge>
        )}

        {activity.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1" data-testid="tile-activity">
            {activity.slice(0, 6).map((signal) => (
              <Badge
                key={signal.key}
                variant={signal.tone}
                title={signal.detail ?? signal.label}
                data-testid={`tile-activity-${signal.key}`}
              >
                {signal.label}
              </Badge>
            ))}
            {activity.length > 6 ? <Badge variant="muted">{`+${activity.length - 6}`}</Badge> : null}
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
