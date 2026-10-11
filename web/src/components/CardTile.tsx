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

/** 磁贴最多直接画几条活动徽标；多出来的合并成 `+N`（tooltip 里列全）。 */
const ACTIVITY_SHOWN = 2;

/**
 * worktree 路径短形：只留最后两段（`.worktrees/<名字>`）。
 * 全路径永远在 tooltip 里 —— 磁贴列宽只有约 280px，塞不下绝对路径。
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
  /** 点「对话」：直接进**会话视图**（不给就退回 onSelect）。 */
  onSelectSession?: (id: string) => void;
}) {
  const activity = badgeSignals(card);
  const light = sessionLight(card);
  const openGates = Object.values(card.gates).filter((gate) => gate.status === "open");
  const runtime = card.runtime ?? null;
  const unreadComments = card.remoteComments.filter((comment) => !comment.read).length;
  const worktree = card.worktree;
  const shownActivity = activity.slice(0, ACTIVITY_SHOWN);
  const mergedActivity = activity.slice(ACTIVITY_SHOWN);
  const openSession = onSelectSession ?? onSelect;

  return (
    /* 整张磁贴都是「打开详情」的命中区，但**不能**再是一个包住所有内容的大 <button>：
       里面的「对话」是真 button，而 button 不能嵌套 button。
       所以主命中区 = 铺满磁贴的透明 button（Tab 第一站、读屏能念），
       内容层 pointer-events-none 让点击穿透到它；需要 tooltip / 自己点的元素再 pointer-events-auto。
       整块 onClick 保底：点徽标、点空白都走同一件事（打开详情）—— 与改动前一致。 */
    <article
      className={cn(
        "relative w-full shrink-0 cursor-pointer rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
        selected && "border-foreground/60 ring-2 ring-ring/40",
      )}
      data-testid="tile"
      data-card-id={card.id}
      onClick={() => onSelect(card.id)}
    >
      <button
        type="button"
        data-testid="tile-open"
        aria-label={`打开卡片详情：${card.title}`}
        className="absolute inset-0 z-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />

      <div className="pointer-events-none relative z-10">
        <div className="flex items-start gap-2">
          <span
            className="mt-0.5 grid size-5 shrink-0 place-items-center rounded border border-dashed text-[10px] text-muted-foreground"
            title="优先级（暂未定）"
          >
            —
          </span>
          <span className="line-clamp-2 text-sm font-medium leading-snug">{card.title}</span>
          {/* 常驻聊天入口：任何卡都有（没会话的卡进去后能看到「启动会话」）。
              它才是"每张卡都能进对话"的那条路，所以做成真 button：可 Tab、有 aria-label、命中区 24px。 */}
          <span className="pointer-events-auto ml-auto flex shrink-0 items-center gap-1.5">
            {/* 会话灯只当**状态指示**：不可点、不进 Tab 序（进对话走右边这个 button）。 */}
            {light ? (
              <span
                className={cn("size-2.5 shrink-0 rounded-full", LIGHT_TONE[light.tone])}
                data-testid="tile-session-light"
                data-light-tone={light.tone}
                title={light.label}
                aria-hidden="true"
              />
            ) : null}
            <button
              type="button"
              className="inline-flex min-h-6 min-w-6 items-center justify-center rounded border border-border px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground hover:border-foreground/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              data-testid="tile-chat"
              title="打开会话视图"
              aria-label={`打开会话视图：${card.title}`}
              onClick={(event) => {
                event.stopPropagation();
                openSession(card.id);
              }}
            >
              对话
            </button>
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1">
          {/* 会话徽标 = 状态（harness + 状态点），不再兼入口：会话入口只有上面那个「对话」按钮。 */}
          {card.session ? (
            <Badge
              variant="outline"
              className="pointer-events-auto"
              data-testid="tile-session-badge"
              title={`会话 ${card.session.id}（${card.session.cwd}）· ${
                SESSION_STATE_LABELS[card.session.state] ?? card.session.state
              }`}
            >
              <span className={`size-1.5 rounded-full ${SESSION_TONE[card.session.state] ?? "bg-neutral-400"}`} />
              {card.session.harness}
            </Badge>
          ) : null}

          {/* 只画**有值**的徽标：没有 Issue / PR / worktree 就什么都不画（空徽标是噪音，标题里也没有信息）。 */}
          {card.issue ? (
            <Badge variant="info" className="pointer-events-auto" title={card.issue.title ?? card.issue.url}>
              <CircleDot />
              {card.issue.number}
            </Badge>
          ) : null}

          {card.pr ? (
            <Badge
              variant="info"
              className="pointer-events-auto"
              title={`${card.pr.branch} · CI ${card.pr.ci ?? "未知"}`}
            >
              <GitPullRequest />
              {card.pr.number}
            </Badge>
          ) : null}

          {worktree ? (
            <Badge
              variant="info"
              className="pointer-events-auto max-w-full min-w-0"
              data-testid="tile-worktree"
              data-worktree={worktree.branch}
              data-worktree-source={worktree.source}
              title={`worktree ${worktree.path}\n分支 ${worktree.branch} · 来源 ${worktree.source}（harness / flowcard）`}
            >
              <GitBranch className="shrink-0" />
              {/* 分支名/路径都可能很长：截断显示，全名与全路径都在 tooltip 里 */}
              <span className="max-w-[7rem] truncate">{worktree.branch}</span>
              <span
                className="max-w-[4.5rem] truncate font-mono text-[10px] font-normal opacity-70"
                title={worktree.path}
              >
                …/{shortWorktreePath(worktree.path)}
              </span>
            </Badge>
          ) : null}

          {shownActivity.length > 0 ? (
            <span className="pointer-events-auto flex flex-wrap items-center gap-1" data-testid="tile-activity">
              {shownActivity.map((signal) => (
                <Badge
                  key={signal.key}
                  variant={signal.tone}
                  title={signal.detail ?? signal.label}
                  data-testid={`tile-activity-${signal.key}`}
                >
                  {signal.label}
                </Badge>
              ))}
              {/* 活动多了就合并：前两条直画，其余进 `+N`（tooltip 列全），别把磁贴堆成十行。 */}
              {mergedActivity.length > 0 ? (
                <Badge
                  variant="muted"
                  data-testid="tile-activity-more"
                  title={mergedActivity
                    .map((signal) => `${signal.label}${signal.detail ? `（${signal.detail}）` : ""}`)
                    .join("\n")}
                >
                  {`+${mergedActivity.length}`}
                </Badge>
              ) : null}
            </span>
          ) : null}

          {openGates.length > 0 ? (
            <Badge
              variant="warning"
              className="pointer-events-auto"
              title={openGates.map((gate) => `${gate.id} ${gate.title}`).join(" / ")}
            >
              <Lock />
              门禁 {openGates.map((g) => g.id).join("+")}
            </Badge>
          ) : null}

          {unreadComments > 0 ? (
            <Badge
              variant="info"
              className="pointer-events-auto"
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
              className="pointer-events-auto"
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
      </div>
    </article>
  );
}
