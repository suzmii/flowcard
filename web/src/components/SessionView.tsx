/**
 * 「会话」视图：左栏是会话列表（`GET /api/cards` 里 `session != null` 的卡），
 * 右栏是选中那个会话的完整对话（全高：状态栏固定 / 转录自己滚 / 输入框贴底）。
 *
 * 状态两条来源，各管一段：
 * - 卡片的会话事实（`card.session`，随看板的 SSE + 30s 兜底节拍刷新）→ 每行的底；
 * - `GET /api/cards/:id/session` 快照 → `busy` 与 `failed` 这类只有会话接口才知道的事；
 *   选中那行还会被对话面板的 SSE（`state` 帧）实时回报（见 `SessionChat.onSnapshot`）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, MessagesSquare } from "lucide-react";
import { SessionChat } from "@/components/detail/SessionChat";
import { Badge } from "@/components/ui/badge";
import {
  SESSION_ROW_DOT,
  SESSION_ROW_LABELS,
  SESSION_ROW_TONE,
  fetchSession,
  sessionRowSignals,
  type SessionRowSignals,
  type SessionState,
} from "@/lib/session";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";

/** 背景快照的最低刷新间隔：左栏所有行靠它；选中那行另有 SSE 实时回报，所以不用更勤。 */
const SNAPSHOT_REFRESH_MS = 10_000;

function SessionRow({
  card,
  projectName,
  signals,
  selected,
  onSelect,
}: {
  card: CardView;
  projectName: string;
  signals: SessionRowSignals;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const unread = card.remoteComments.filter((comment) => !comment.read).length;
  const cwd = card.session?.cwd ?? "";

  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      title={cwd === "" ? card.title : `${card.title}\ncwd=${cwd}`}
      data-testid={`session-row-${card.id}`}
      data-status={signals.status}
      data-busy={signals.busy ? "1" : "0"}
      className={cn(
        "w-full rounded-lg border bg-card p-2 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40",
        selected && "border-foreground/60 ring-2 ring-ring/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn("mt-1 size-2.5 shrink-0 rounded-full", SESSION_ROW_DOT[signals.status])}
          title={SESSION_ROW_LABELS[signals.status]}
        />
        <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium leading-snug">{card.title}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant={SESSION_ROW_TONE[signals.status]} data-testid={`session-row-status-${card.id}`}>
          {SESSION_ROW_LABELS[signals.status]}
        </Badge>
        {signals.busy ? (
          <span className="flex items-center gap-1" data-testid={`session-row-busy-${card.id}`}>
            <Loader2 className="size-3 animate-spin" />
            忙
          </span>
        ) : null}
        <Badge variant="outline" data-testid={`session-row-project-${card.id}`}>
          {projectName}
        </Badge>
        {unread > 0 ? (
          <Badge
            variant="info"
            title={`${unread} 条未读远端评论（在卡片详情里点「标为已读」才清）`}
            data-testid={`session-row-unread-${card.id}`}
          >
            <MessageSquare />
            {unread}
          </Badge>
        ) : null}
        <span className="ml-auto" data-testid={`session-row-at-${card.id}`}>
          {timeAgo(signals.at)}
        </span>
      </div>
    </button>
  );
}

export function SessionView({
  cards,
  projectNames,
  selectedId,
  onSelect,
}: {
  /** 会话卡（`session != null`），顺序即列表顺序（调用方已按最近心跳排好）。 */
  cards: CardView[];
  /** `projectId → 项目名`，用来给每行标项目。 */
  projectNames: Record<string, string>;
  /** 记忆里的选中卡（可能已失效）；失效时退回列表第一项。 */
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [snapshots, setSnapshots] = useState<Record<string, SessionState>>({});

  /** 对话面板回报的快照：字段没变就不换引用，免得把它自己重新渲一遍。 */
  const reportSnapshot = useCallback((cardId: string, session: SessionState) => {
    setSnapshots((prev) => {
      const before = prev[cardId];
      if (
        before &&
        before.status === session.status &&
        before.busy === session.busy &&
        before.ompSessionId === session.ompSessionId &&
        before.lastActivityAt === session.lastActivityAt &&
        before.messages.length === session.messages.length
      ) {
        return prev;
      }
      return { ...prev, [cardId]: session };
    });
  }, []);

  // 背景拉一遍每张卡的会话快照（卡片的会话事实画不出 busy/failed）；同一批人 10s 内不重复拉。
  const fetchedIds = useRef("");
  const fetchedAt = useRef(0);
  useEffect(() => {
    const ids = cards.map((card) => card.id);
    if (ids.length === 0) return;
    const signature = ids.join(",");
    if (signature === fetchedIds.current && Date.now() - fetchedAt.current < SNAPSHOT_REFRESH_MS) return;
    fetchedIds.current = signature;
    fetchedAt.current = Date.now();

    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => {
        const result = await fetchSession(id);
        if (!cancelled && result.ok) reportSnapshot(id, result.data);
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [cards, reportSnapshot]);

  // 选中项：记忆优先，失效/为空就退回列表第一项。
  const current = cards.find((card) => card.id === selectedId) ?? cards[0] ?? null;

  return (
    <div className="flex h-full min-h-0" data-testid="session-view">
      <aside className="flex h-full w-[19rem] shrink-0 flex-col border-r bg-background/70" aria-label="会话列表">
        <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <MessagesSquare className="size-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold">会话</h2>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="session-count">
            {cards.length}
          </span>
          <span className="ml-auto text-[11px] text-muted-foreground">按最近心跳排</span>
        </header>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2" data-testid="session-list">
          {cards.length === 0 ? (
            <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="session-list-empty">
              这里按「卡片的会话」列；还没有一张卡绑过会话。
            </div>
          ) : (
            cards.map((card) => {
              const signals = sessionRowSignals(card.session, snapshots[card.id] ?? null);
              if (!signals) return null;
              return (
                <SessionRow
                  key={card.id}
                  card={card}
                  projectName={projectNames[card.projectId] ?? card.projectId}
                  signals={signals}
                  selected={card.id === current?.id}
                  onSelect={onSelect}
                />
              );
            })
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col p-3">
        {current ? (
          // 一张卡一个实例：换会话就换一份状态（转录、输入框、滚动位置都不串台）
          <SessionChat key={current.id} card={current} onSnapshot={reportSnapshot} />
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background/70 p-6 text-center text-xs text-muted-foreground"
            data-testid="session-view-empty"
          >
            <MessagesSquare className="size-5" />
            <p className="text-sm font-medium text-foreground">还没有托管会话</p>
            <p className="max-w-md">
              去「看板」开一张卡（「新建卡片」），让它开工（<code className="font-mono">flowcard claim …</code>
              ）—— 会话立起来之后就会出现在左边，这里能直接读转录、发消息。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
