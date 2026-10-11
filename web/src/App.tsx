import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  GitFork,
  LayoutGrid,
  ListTree,
  MessagesSquare,
  Plus,
  RefreshCw,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Board } from "@/components/Board";
import { CardDetail } from "@/components/CardDetail";
import { GraphView } from "@/components/GraphView";
import { NewCardDialog } from "@/components/NewCardDialog";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { SessionView } from "@/components/SessionView";
import { WorkflowView, type WorkflowFocus } from "@/components/WorkflowView";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBoard, type Connection } from "@/lib/useBoard";
import { useProjects } from "@/lib/useProjects";
import { useWorkflow } from "@/lib/workflow";
import { projectIssueBase } from "@/lib/projects";
import { clockTime } from "@/lib/utils";
import type { CardView } from "@/lib/schema";

/** 主视图：看板 / 会话 / 提交图 / 流程（都只切主区，不重排看板数据）。 */
type View = "board" | "sessions" | "graph" | "workflow";

const VIEW_KEY = "flowcard.view";
/** 会话视图选中的卡（换视图/刷新都记得）。 */
const SESSION_CARD_KEY = "flowcard.sessionCardId";

function readView(): View {
  // hash 深链优先（例如从别处直接打开 `#workflow/stage/prTodo`）
  if (readWorkflowFocus()) return "workflow";
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    return saved === "graph" || saved === "sessions" || saved === "workflow" ? saved : "board";
  } catch {
    // 隐私模式等拿不到 localStorage：只是不持久化
    return "board";
  }
}

/**
 * `#workflow/stage/<列>` / `#workflow/state/<状态>` → 流程视图里选中的节点。
 * 看板的列头就是靠这个 hash 一键跳进来的（普通 `<a href>`，不需要 props 传递）。
 */
function readWorkflowFocus(): WorkflowFocus | null {
  const [view, kind, ...rest] = window.location.hash.replace(/^#/, "").split("/");
  const id = rest.join("/");
  if (view !== "workflow" || id === "") return null;
  if (kind === "stage" || kind === "state") return { kind, id };
  return null;
}

/** 给流程节点生成深链（同一份格式，读与写都在这里）。 */
function workflowHash(focus: WorkflowFocus): string {
  return `workflow/${focus.kind}/${focus.id}`;
}

/** 离开流程视图时把深链抹掉（否则刷新又跳回流程页）。 */
function clearWorkflowHash() {
  if (window.location.hash === "") return;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function readSessionCardId(): string | null {
  try {
    return window.localStorage.getItem(SESSION_CARD_KEY);
  } catch {
    return null;
  }
}

function writeSessionCardId(id: string | null) {
  try {
    if (id === null) window.localStorage.removeItem(SESSION_CARD_KEY);
    else window.localStorage.setItem(SESSION_CARD_KEY, id);
  } catch {
    /* 同上 */
  }
}

/** 会话列表顺序：最近心跳在前（同刻按卡的活跃时间兜底）。 */
function byRecentSession(a: CardView, b: CardView): number {
  const left = a.session?.lastSeenAt ?? "";
  const right = b.session?.lastSeenAt ?? "";
  return right.localeCompare(left) || b.updatedAt.localeCompare(a.updatedAt);
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
  /** 详情是否要直接对着对话区（从磁贴的会话灯/会话徽标进来时为真）。 */
  const [focusSession, setFocusSession] = useState(false);
  const [view, setView] = useState<View>(() => readView());
  /** 流程视图里被选中 / 要高亮的节点（看板列头跳进来时带上）。 */
  const [workflowFocus, setWorkflowFocus] = useState<WorkflowFocus | null>(() => readWorkflowFocus());
  // 流程视图的数据：进视图才拉（常量不会变，刷新按钮可手动重拉）
  const workflow = useWorkflow(view === "workflow");
  const [sessionCardId, setSessionCardId] = useState<string | null>(() => readSessionCardId());
  const [refreshing, setRefreshing] = useState(false);
  const [newCardOpen, setNewCardOpen] = useState(false);

  const switchView = useCallback((next: View) => {
    setView(next);
    writeView(next);
    // 离开流程视图就把 `#workflow/...` 去掉：深链只服务于「跳进流程」，别赖着不走
    if (next !== "workflow") clearWorkflowHash();
    else setWorkflowFocus(null);
  }, []);

  /** 看板列头 / 图内互跳：切到流程视图并选中那个节点，同时把深链写进 hash。 */
  const traceWorkflow = useCallback((focus: WorkflowFocus) => {
    setView("workflow");
    writeView("workflow");
    setWorkflowFocus(focus);
    window.location.hash = workflowHash(focus);
  }, []);

  /** 浏览器前进/后退、以及页面里普通 `<a href="#workflow/...">` 都走这里。 */
  useEffect(() => {
    const sync = () => {
      const focus = readWorkflowFocus();
      if (!focus) return;
      setView("workflow");
      writeView("workflow");
      setWorkflowFocus(focus);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  /** 磁贴主点击：打开卡片详情（顶部开始）。 */
  const openCard = useCallback((id: string) => {
    setSelectedId(id);
    setFocusSession(false);
  }, []);

  const closeCard = useCallback(() => {
    setSelectedId(null);
    setFocusSession(false);
  }, []);

  /** 会话视图的选中：写进 localStorage，切视图/刷新都还在。 */
  const pickSessionCard = useCallback((id: string | null) => {
    setSessionCardId(id);
    writeSessionCardId(id);
  }, []);

  /** 详情里那行入口：关掉详情、切到会话视图、并把这张卡选中。 */
  const openSessionView = useCallback(
    (id: string) => {
      pickSessionCard(id);
      switchView("sessions");
      setSelectedId(null);
      setFocusSession(false);
    },
    [pickSessionCard, switchView],
  );

  const cards = board.cards ?? [];
  // 看板按当前项目过滤（服务端把没归属的卡投影成 projectId="local"）；没有可选项目时不过滤。
  const currentProject = projects.selected;
  const visibleCards = currentProject
    ? cards.filter((card) => card.projectId === currentProject.id)
    : cards;
  const selected = cards.find((card) => card.id === selectedId) ?? null;

  /** 会话视图的列表：所有绑过会话的卡（不分项目，行上标项目），最近心跳在前。 */
  const sessionCards = useMemo(
    () => cards.filter((card) => card.session !== null).sort(byRecentSession),
    [cards],
  );
  const projectNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const project of projects.projects) names[project.id] = project.name;
    return names;
  }, [projects.projects]);

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
              variant={view === "sessions" ? "secondary" : "ghost"}
              data-testid="view-sessions"
              role="tab"
              aria-selected={view === "sessions"}
              onClick={() => switchView("sessions")}
            >
              <MessagesSquare />
              会话
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
            <Button
              size="xs"
              variant={view === "workflow" ? "secondary" : "ghost"}
              data-testid="view-workflow"
              role="tab"
              aria-selected={view === "workflow"}
              onClick={() => switchView("workflow")}
            >
              <ListTree />
              流程
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
        {view === "sessions" ? (
          <SessionView
            cards={sessionCards}
            projectNames={projectNames}
            selectedId={sessionCardId}
            onSelect={pickSessionCard}
          />
        ) : view === "workflow" ? (
          <WorkflowView
            workflow={workflow.workflow}
            error={workflow.error}
            loading={workflow.loading}
            cards={cards}
            focus={workflowFocus}
            onFocus={traceWorkflow}
            onOpenBoard={() => switchView("board")}
            onRefresh={workflow.refresh}
          />
        ) : view === "graph" ? (
          <GraphView
            project={currentProject}
            version={board.lastChangedAt ?? ""}
            onOpenCard={openCard}
          />
        ) : (
          <Board
            cards={visibleCards}
            loading={board.loading}
            selectedId={selectedId}
            onSelect={openCard}
            onSelectSession={openSessionView}
          />
        )}
      </main>

      {selected ? (
        <CardDetail
          card={selected}
          cards={cards}
          issueBase={projectIssueBase(currentProject)}
          focusSession={focusSession}
          onClose={closeCard}
          onOpenSession={() => openSessionView(selected.id)}
          onRefresh={board.refresh}
        />
      ) : null}

      <NewCardDialog
        open={newCardOpen}
        onClose={() => setNewCardOpen(false)}
        onCreated={board.refresh}
        projectId={currentProject?.id ?? null}
        projectName={currentProject?.name ?? null}
        projectsUnavailable={projects.unavailable}
        projectsError={projects.error}
      />
    </div>
  );
}
