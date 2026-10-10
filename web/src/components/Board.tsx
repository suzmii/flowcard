import { Inbox } from "lucide-react";
import { CardTile } from "@/components/CardTile";
import { Skeleton } from "@/components/ui/skeleton";
import { deriveStage, STAGE_EMPTY_HINTS, STAGE_LABELS, STAGE_TONE, STAGES, type Stage } from "@/lib/contract";
import type { CardView } from "@/lib/schema";

/** PR 列列 CI 分布时用的中文名。 */
const CI_LABELS: Record<"pending" | "pass" | "fail" | "none", string> = {
  pending: "待跑",
  pass: "通过",
  fail: "失败",
  none: "没有 CI",
};

/**
 * 列头上的补充事实（磁贴/详情不动，这里只补「这一列为什么长这样」的概览）：
 * - 阻塞列：列出 `blockedReason`（重复的合并成 `×N`）。
 * - PR 列：列出 CI 分布（状态来自同步，`pr.ci`）。
 * 返回空数组 = 这一列不需要补。
 */
function stageNotes(stage: Stage, columnCards: CardView[]): string[] {
  if (stage === "blocked") {
    const reasons = new Map<string, number>();
    for (const card of columnCards) {
      const reason = card.blockedReason?.trim();
      if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    return [...reasons].map(([reason, count]) => (count > 1 ? `${reason} ×${count}` : reason));
  }
  if (stage === "prReview") {
    const buckets: Record<"pending" | "pass" | "fail" | "none", number> = { pending: 0, pass: 0, fail: 0, none: 0 };
    for (const card of columnCards) buckets[card.pr?.ci ?? "none"] += 1;
    return (Object.keys(buckets) as (keyof typeof buckets)[])
      .filter((key) => buckets[key] > 0)
      .map((key) => `CI ${CI_LABELS[key]} ${buckets[key]}`);
  }
  return [];
}

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
      {STAGES.map((stage) => {
        // 列按**派生阶段**分：以服务端给的 `stage` 为准；老服务端没给就地按同一套判据派生。
        const columnCards = cards.filter(
          (card) => (card.stage ?? deriveStage(card, card.git ? { git: card.git } : null)) === stage,
        );
        const notes = stageNotes(stage, columnCards);
        return (
          <section
            key={stage}
            className="flex h-full w-[17.5rem] shrink-0 flex-col rounded-xl border bg-background/70"
            aria-label={`${STAGE_LABELS[stage]}列`}
          >
            <header className="border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full ${STAGE_TONE[stage]}`} />
                <h2 className="text-xs font-semibold">{STAGE_LABELS[stage]}</h2>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{stage}</span>
                <span
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  data-stage-count={stage}
                >
                  {columnCards.length}
                </span>
              </div>
              {notes.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                  {notes.map((note) => (
                    <li key={note} className="truncate" title={note}>
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
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
                  {STAGE_EMPTY_HINTS[stage]}
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
