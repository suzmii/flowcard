import { useCallback, useState } from "react";
import { AlertTriangle, GitFork, LayoutGrid, Plus, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Board } from "@/components/Board";
import { CardDetail } from "@/components/CardDetail";
import { GraphView } from "@/components/GraphView";
import { NewCardDialog } from "@/components/NewCardDialog";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBoard, type Connection } from "@/lib/useBoard";
import { useProjects } from "@/lib/useProjects";
import { projectIssueBase } from "@/lib/projects";
import { clockTime } from "@/lib/utils";

/** 主视图：看板 / 提交图（提交图不重排看板，只切换主区）。 */
type View = "board" | "graph";

const VIEW_KEY = "flowcard.view";

function readView(): View {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "board";
  } catch {
    // 隐私模式等拿不到 localStorage：只是不持久化
    return "board";
  }
}

function writeView(view: View) {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* 同上 */
  }
}

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: "连接中…",
  live: "已连接",
  reconnecting: "重连中…",
};

const CONNECTION_TONE: Record<Connection, string> = {
  connecting: "bg-amber-500",
  live: "bg-emerald-600",
  reconnecting: "bg-red-600",
};

export function App() {
  const [showDeleted, setShowDeleted] = useState(false);
  const board = useBoard({ includeDeleted: showDeleted });
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => readView());
  const [refreshing, setRefreshing] = useState(false);
  const [newCardOpen, setNewCardOpen] = useState(false);

  const switchView = useCallback((next: View) => {
    setView(next);
    writeView(next);
  }, []);

  const cards = board.cards ?? [];
  // 看板按当前项目过滤（服务端把没归属的卡投影成 projectId="local"）；没有可选项目时不过滤。
  const currentProject = projects.selected;
  const visibleCards = currentProject
    ? cards.filter((card) => card.projectId === currentProject.id)
    : cards;
  const selected = cards.find((card) => card.id === selectedId) ?? null;

  /** 「刷新」= 卡片 + 项目元数据一起重拉（别处的 CLI 加了项目，这里不刷新就看不到）。 */
  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([board.refresh(), projects.refresh()]);
    setRefreshing(false);
  }, [board, projects]);

  /** 「立即同步」= 服务端跑一轮只读同步，然后重拉卡片（新徽标立刻可见）。 */
  const syncNow = useCallback(async () => {
    const result = await projects.syncNow();
    await board.refresh();
    return result;
  }, [projects, board]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <header className="space-y-2 border-b bg-background px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <LayoutGrid className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">flowcard 看板</h1>
            <Badge variant="muted" data-testid="card-count">
              {visibleCards.length} 张卡
              {currentProject ? `（全部 ${cards.length}）` : ""}
            </Badge>
            {board.lastChanged ? (
              <Badge variant="outline" title={board.lastChanged.types.join(", ")}>
                最近变更 {board.lastChanged.cardIds.length} 张 ·{" "}
                {clockTime(board.lastChangedAt)}
              </Badge>
            ) : null}
            {board.runtimeEvents > 0 ? (
              <Badge variant="outline" title="SSE 收到的 runtime 事件数">
                运行时事件 {board.runtimeEvents}
              </Badge>
            ) : null}
          </div>

          <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="tablist" aria-label="主视图">
            <Button
              size="xs"
              variant={view === "board" ? "secondary" : "ghost"}
              data-testid="view-board"
              role="tab"
              aria-selected={view === "board"}
              onClick={() => switchView("board")}
            >
              <LayoutGrid />
              看板
            </Button>
            <Button
              size="xs"
              variant={view === "graph" ? "secondary" : "ghost"}
              data-testid="view-graph"
              role="tab"
              aria-selected={view === "graph"}
              onClick={() => switchView("graph")}
            >
              <GitFork />
              提交图
            </Button>
          </div>

          <div className="ml-auto flex items-center gap-2">
                        <label
              className="flex items-center gap-1 text-xs text-muted-foreground"
              data-testid="show-deleted"
              title="软删除的卡默认不显示；勾上可以看到并恢复"
            >
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(event) => setShowDeleted(event.target.checked)}
              />
              显示已删除
            </label>
<Button
              size="sm"
              data-testid="new-card-open"
              onClick={() => setNewCardOpen(true)}
            >
              <Plus />
              新建卡片
            </Button>
            <span
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="GET /api/stream（SSE）"
            >
              <span className={`size-2 rounded-full ${CONNECTION_TONE[board.connection]}`} />
              {board.connection === "live" ? (
                <Wifi className="size-3.5" />
              ) : (
                <WifiOff className="size-3.5" />
              )}
              {CONNECTION_TEXT[board.connection]}
            </span>
            <Button variant="outline" size="sm" onClick={() => void manualRefresh()}>
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
              刷新
            </Button>
          </div>
        </div>

        <ProjectSwitcher
          projects={projects.projects}
          selected={projects.selected}
          loading={projects.loading}
          error={projects.error}
          unavailable={projects.unavailable}
          syncStatus={projects.syncStatus}
          syncing={projects.syncing}
          onSelect={projects.select}
          onAdd={projects.add}
          onSetIssueBase={projects.setIssueBase}
          onSync={syncNow}
        />
      </header>

      {board.error ? (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">读不到卡片数据：{board.error}</div>
            <div className="text-red-700/80">
              服务没起来时先跑：
              <code className="mx-1 rounded bg-red-100 px-1 py-0.5 font-mono">
                FLOWCARD_DATA_DIR=/tmp/fc-web npm start
              </code>
              （默认监听 127.0.0.1:47825，FLOWCARD_PORT 可改）；前端 dev 由 vite proxy 转发 /api，不需要开 CORS。
            </div>
          </div>
        </div>
      ) : null}

      <main className="min-h-0 flex-1">
        {view === "graph" ? (
          <GraphView
            project={currentProject}
            version={board.lastChangedAt ?? ""}
            onOpenCard={setSelectedId}
          />
        ) : (
          <Board
            cards={visibleCards}
            loading={board.loading}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </main>

      {selected ? (
        <CardDetail
          card={selected}
          cards={cards}
          issueBase={projectIssueBase(currentProject)}
          onClose={() => setSelectedId(null)}
          onRefresh={board.refresh}
        />
      ) : null}

      <NewCardDialog
        open={newCardOpen}
        onClose={() => setNewCardOpen(false)}
        onCreated={board.refresh}
        projectId={currentProject?.id ?? null}
        projectName={currentProject?.name ?? null}
      />
    </div>
  );
}
