import { Inbox } from "lucide-react";
import { CardTile } from "@/components/CardTile";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ACTOR_HINT,
  ACTOR_TEXT,
  ACTOR_TONE,
  deriveStage,
  STAGE_ACTOR,
  STAGE_EMPTY_HINTS,
  STAGE_LABELS,
  STAGE_TONE,
  STAGE_WHEN,
  STAGES,
  stageTraceHash,
  type Stage,
} from "@/lib/contract";
import type { CardView } from "@/lib/schema";
import { cn } from "@/lib/utils";

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
    /* 看板 = 自适应网格，不是一条横向长条：
       - `auto-fill` + 15rem 下限：1512px 视口下每行 5 列 → 9 个阶段铺成 2 行，**终态列不用横向滚动**就能看到；
         窗口更窄时自动降到 4 列/行（3 行），宽屏时更宽 —— 列宽永远是等分的 1fr。
       - 15rem 下限是按磁贴内容预算定的：列宽 281px − 列内边距 16 − 卡片内边距 20 ≈ 245px 可用，
         足够放下最宽的 worktree 徽标（分支 + 短路径）。
       - `auto-rows: minmax(12rem, 1fr)`：行高只分现有高度；行数多了每行变矮，列内列表自己滚（min-h-0）。*/
    <div
      className="board-scroll grid h-full min-h-0 auto-rows-[minmax(12rem,1fr)] grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3 overflow-y-auto p-3"
      data-testid="board-grid"
    >
      {STAGES.map((stage) => {
        // 列按**派生阶段**分：以服务端给的 `stage` 为准；老服务端没给就地按同一套判据派生。
        const columnCards = cards.filter(
          (card) => (card.stage ?? deriveStage(card, card.git ? { git: card.git } : null)) === stage,
        );
        const notes = stageNotes(stage, columnCards);
        const empty = !loading && columnCards.length === 0;
        return (
          <section
            key={stage}
            id={`board-column-${stage}`}
            className={cn(
              "flex min-h-0 flex-col rounded-xl border bg-background/70",
              empty && "bg-muted/20",
            )}
            aria-label={`${STAGE_LABELS[stage]}列`}
            data-stage={stage}
            data-empty={empty ? "true" : "false"}
          >
            <header className="border-b px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`size-2 shrink-0 rounded-full ${STAGE_TONE[stage]}`} />
                {/* 列名 = 深链入口：点它去流程图里看这一列的判据与来源（App 监听 hashchange）。
                    外层仍是 h2（列的标题就是它），链接嵌在标题里。 */}
                <h2 className="text-xs font-semibold leading-tight">
                  <a
                    data-testid={`stage-trace-${stage}`}
                    href={stageTraceHash(stage)}
                    title="在流程图里看这一列的判据与来源"
                    className="hover:underline"
                  >
                    {STAGE_LABELS[stage]}
                  </a>
                </h2>
                {/* 等谁动手（human / llm）+ 悬停给判据由来 */}
                <span
                  data-testid={`stage-actor-${stage}`}
                  data-actor={STAGE_ACTOR[stage]}
                  title={`${STAGE_WHEN[stage]}｜等谁动手：${ACTOR_HINT[STAGE_ACTOR[stage]]}`}
                  className={`inline-flex items-center rounded border px-1 text-[10px] font-mono ${ACTOR_TONE[STAGE_ACTOR[stage]]}`}
                >
                  {ACTOR_TEXT[STAGE_ACTOR[stage]]}
                </span>
                {/* 空列只留列名 + 计数：连 stage 代码都不挤进去。 */}
                {empty ? null : (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{stage}</span>
                )}
                <span
                  className={cn(
                    "rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
                    empty && "ml-auto",
                  )}
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

            {/* 列内也自适应：列够宽就并排两张卡，不够就单列堆叠（网格 + auto-fill 自动决定）。 */}
            {empty ? (
              <div
                className="m-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-2 text-center text-[11px] text-muted-foreground"
                data-testid={`stage-empty-${stage}`}
                title={STAGE_EMPTY_HINTS[stage]}
              >
                <Inbox className="size-4 shrink-0" />
                <span className="leading-tight">{STAGE_EMPTY_HINTS[stage]}</span>
              </div>
            ) : (
              <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] content-start gap-2 overflow-y-auto p-2">
                {loading ? (
                  <>
                    <Skeleton className="h-24 w-full" />
                    <Skeleton className="h-24 w-full" />
                  </>
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
            )}
          </section>
        );
      })}
    </div>
  );
}
