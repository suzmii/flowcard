import { Inbox } from "lucide-react";
import { CardTile } from "@/components/CardTile";
import { Skeleton } from "@/components/ui/skeleton";
import { CARD_STATES, STATE_LABELS, STATE_TONE, type CardState } from "@/lib/contract";
import type { CardView } from "@/lib/schema";

/** 每列空态文案，避免七列都写「暂无卡片」。 */
const EMPTY_HINTS: Record<CardState, string> = {
  ready: "还没有卡",
  working: "没有实施中的卡",
  review: "没有等待验收的卡",
  merged: "没有待清理的卡",
  done: "还没有完成的卡",
  blocked: "没有阻塞的卡",
  dropped: "没有放弃的卡",
};

export function Board({
  cards,
  loading,
  selectedId,
  onSelect,
  onSelectSession,
}: {
  cards: CardView[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 点磁贴的会话灯/会话徽标：打开详情并直接落在对话区。 */
  onSelectSession?: (id: string) => void;
}) {
  return (
    <div className="board-scroll flex h-full min-h-0 gap-3 overflow-x-auto p-3">
      {CARD_STATES.map((state) => {
        const columnCards = cards.filter((card) => card.state === state);
        return (
          <section
            key={state}
            className="flex h-full w-[17.5rem] shrink-0 flex-col rounded-xl border bg-background/70"
            aria-label={`${STATE_LABELS[state]}列`}
          >
            <header className="flex items-center gap-2 border-b px-3 py-2">
              <span className={`size-2 rounded-full ${STATE_TONE[state]}`} />
              <h2 className="text-xs font-semibold">{STATE_LABELS[state]}</h2>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {state}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {columnCards.length}
              </span>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {loading ? (
                <>
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </>
              ) : columnCards.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                  <Inbox className="size-4" />
                  {EMPTY_HINTS[state]}
                </div>
              ) : (
                columnCards.map((card) => (
                  <CardTile
                    key={card.id}
                    card={card}
                    selected={card.id === selectedId}
                    onSelect={onSelect}
                    {...(onSelectSession ? { onSelectSession } : {})}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
