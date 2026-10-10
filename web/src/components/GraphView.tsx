/**
 * 提交图视图（第一期：文本图 + worktree/分支/卡片叠加）。
 *
 * 刻意**不做**图形化泳道排线：服务端给的就是 `git log --graph --oneline --decorate --all` 的原样字符画，
 * 等宽字体渲染在可滚动的 `<pre>` 里就够了（真实仓库上百条提交也只多几行 DOM）。
 * 每个 worktree 若绑了卡片（服务端按 `worktree.path` 反查）就显示卡片徽标，点一下打开那张卡的详情。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { STATE_LABELS, STATE_TONE, type CardState } from "@/lib/contract";
import {
  GRAPH_LIMIT_DEFAULT,
  GRAPH_LIMITS,
  fetchGraph,
  shortSha,
  type GraphResult,
} from "@/lib/graph";
import { shortRemote, type ProjectView } from "@/lib/projects";
import { timeAgo } from "@/lib/utils";

/** 卡片状态来自服务端的字符串（契约里是 `cardState?: string`），不认识就原样显示。 */
function stateLabel(state: string | undefined): string {
  if (!state) return "未知状态";
  return state in STATE_LABELS ? STATE_LABELS[state as CardState] : state;
}

function stateTone(state: string | undefined): string {
  return state && state in STATE_TONE ? STATE_TONE[state as CardState] : "bg-neutral-400";
}

function Panel({
  title,
  icon,
  count,
  hint,
  children,
  testId,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  hint?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="shrink-0 rounded-xl border bg-background" data-testid={testId}>
      <header className="flex items-center gap-1.5 border-b px-3 py-2">
        {icon}
        <h2 className="text-xs font-semibold">{title}</h2>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {count}
        </span>
        {hint ? <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span> : null}
      </header>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto p-2">{children}</div>
    </section>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed p-2 text-[11px] text-muted-foreground">{text}</p>
  );
}

export function GraphView({
  project,
  version,
  onOpenCard,
}: {
  project: ProjectView | null;
  /** 外部数据版本（看板 SSE 的 lastChangedAt）：变了就重拉，保证 worktree/卡片叠加不漂 */
  version: string;
  onOpenCard: (cardId: string) => void;
}) {
  const [limit, setLimit] = useState<number>(GRAPH_LIMIT_DEFAULT);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GraphResult | null>(null);

  const projectId = project?.id ?? null;
  const projectPath = project?.path ?? "";

  useEffect(() => {
    // `local` 是合成项目（path 为空）：没有仓库可读，直接把空态交给渲染层。
    if (!projectId || projectPath === "") {
      setResult(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void fetchGraph(projectId, limit, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setResult(next);
      })
      .catch(() => {
        /* abort：让下一次请求说了算 */
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, projectPath, limit, nonce, version]);

  if (!project) {
    return (
      <div className="p-4" data-testid="graph-view">
        <EmptyLine text="先在上方「项目」里选一个仓库：提交图是按项目仓库算的（git log / git worktree）。" />
      </div>
    );
  }

  if (projectPath === "") {
    return (
      <div className="p-4" data-testid="graph-view">
        <EmptyLine text="「local」是合成项目（未归属的卡），没有对应仓库，看不了提交图；请切换到具体项目。" />
      </div>
    );
  }

  const data = result?.ok ? result.data : null;
  const remote = shortRemote(project.remote);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3" data-testid="graph-view">
      <header
        className="flex flex-wrap items-center gap-2 rounded-xl border bg-background px-3 py-2"
        data-testid="graph-project"
      >
        <FolderGit2 className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{project.name}</span>
        <span className="break-all font-mono text-[11px] text-muted-foreground">
          {data?.repoPath || project.path}
        </span>
        {remote ? (
          <Badge variant="outline" className="font-mono" title={project.remote}>
            {remote}
          </Badge>
        ) : null}
        {project.headBranch ? (
          <Badge variant="info">
            <GitBranch />
            {project.headBranch}
          </Badge>
        ) : null}
        {typeof project.dirtyFiles === "number" ? (
          <Badge variant={project.dirtyFiles > 0 ? "warning" : "success"}>
            {project.dirtyFiles > 0 ? `${project.dirtyFiles} 个未提交文件` : "工作区干净"}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            limit
            <select
              data-testid="graph-limit"
              aria-label="提交条数上限"
              className="h-7 rounded-md border bg-background px-1.5 font-mono text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {GRAPH_LIMITS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <Button size="xs" variant="outline" data-testid="graph-refresh" onClick={() => setNonce((n) => n + 1)}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </header>

      {result && !result.ok ? (
        <div
          className="flex items-start gap-2 rounded-xl border border-red-600/30 bg-red-50 p-3 text-xs text-red-800"
          data-testid="graph-error"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">
              读不到提交图（{result.code}）：{result.message}
            </div>
            {result.hint ? <div className="text-red-700/80">{result.hint}</div> : null}
            {result.missing ? (
              <div className="text-red-700/80">
                服务端路由还没挂上时，看板其它部分照常用；这条接口由服务端工作流负责。
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!result && loading ? (
        <div className="space-y-2" data-testid="graph-loading">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : null}

      {data ? (
        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="flex min-h-0 flex-col gap-3">
            <section className="flex min-h-[16rem] flex-1 flex-col rounded-xl border bg-background">
              <header className="flex flex-wrap items-center gap-1.5 border-b px-3 py-2">
                <GitFork className="size-3.5 text-muted-foreground" />
                <h2 className="text-xs font-semibold">提交图</h2>
                <span className="font-mono text-[11px] text-muted-foreground">
                  git log --graph --oneline --decorate --all
                </span>
                <span className="ml-auto text-[11px] text-muted-foreground" data-testid="graph-counts">
                  {data.commits.length} 条提交 · {data.branches.length} 个分支 · {data.worktrees.length} 个
                  worktree · limit {data.limit ?? limit}
                </span>
              </header>
              <p className="border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
                只显示最近 {data.limit ?? limit} 条（接口 limit 参数）；大仓库调小 limit 或按分支范围看。
                字符画原样输出，颜色无关。
              </p>
              <pre
                data-testid="graph-text"
                className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-[1.5] whitespace-pre"
              >
                {data.graphText === "" ? "（git log 没有输出：仓库里还没有提交）" : data.graphText}
              </pre>
            </section>

            <Panel
              title="最近提交"
              icon={<GitCommitHorizontal className="size-3.5 text-muted-foreground" />}
              count={data.commits.length}
              hint="sha · 作者 · 主题 · refs"
              testId="graph-commits"
            >
              {data.commits.length === 0 ? (
                <EmptyLine text="没有提交（或服务端没回 commits 数组）。" />
              ) : (
                data.commits.map((commit) => (
                  <div
                    key={commit.sha}
                    className="flex flex-wrap items-baseline gap-1.5 rounded-lg border bg-background px-2 py-1"
                    data-testid="graph-commit"
                  >
                    <span className="font-mono text-[11px]">{commit.short ?? shortSha(commit.sha)}</span>
                    <span className="min-w-0 flex-1 truncate text-xs">{commit.subject ?? "(无主题)"}</span>
                    {commit.refs?.map((ref) => (
                      <Badge key={ref} variant="outline" className="font-mono text-[10px]">
                        {ref}
                      </Badge>
                    ))}
                    <span className="text-[11px] text-muted-foreground">
                      {commit.author ?? "?"}
                      {commit.at ? ` · ${timeAgo(commit.at)}` : ""}
                    </span>
                  </div>
                ))
              )}
            </Panel>
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <Panel
              title="worktrees"
              icon={<FolderGit2 className="size-3.5 text-muted-foreground" />}
              count={data.worktrees.length}
              hint="绑了卡片的可以点开"
              testId="graph-worktrees"
            >
              {data.worktrees.length === 0 ? (
                <EmptyLine text="没有 worktree（服务端没回 worktrees，或仓库只有主工作区）。" />
              ) : (
                data.worktrees.map((worktree) => (
                  <div
                    key={worktree.path}
                    className="space-y-1 rounded-lg border bg-background p-2"
                    data-testid="graph-worktree"
                  >
                    <div className="flex items-center gap-1.5">
                      <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{worktree.path}</span>
                      {worktree.detached ? <Badge variant="warning">detached</Badge> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {worktree.branch ? (
                        <Badge variant="info">
                          <GitBranch />
                          {worktree.branch}
                        </Badge>
                      ) : (
                        <Badge variant="muted">无分支</Badge>
                      )}
                      <Badge variant="outline" className="font-mono" title={worktree.head}>
                        HEAD {shortSha(worktree.head)}
                      </Badge>
                    </div>
                    {worktree.cardId ? (
                      <button
                        type="button"
                        data-testid={`graph-worktree-card-${worktree.cardId}`}
                        onClick={() => onOpenCard(worktree.cardId as string)}
                        className="flex w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-left text-[11px] hover:bg-accent"
                        title={`打开卡片 ${worktree.cardId}`}
                      >
                        <span className={`size-1.5 shrink-0 rounded-full ${stateTone(worktree.cardState)}`} />
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {worktree.cardTitle ?? worktree.cardId}
                        </span>
                        <span className="shrink-0 text-muted-foreground">{stateLabel(worktree.cardState)}</span>
                      </button>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">没有卡片绑在这个 worktree 上</p>
                    )}
                  </div>
                ))
              )}
            </Panel>

            <Panel
              title="分支"
              icon={<GitBranch className="size-3.5 text-muted-foreground" />}
              count={data.branches.length}
              testId="graph-branches"
            >
              {data.branches.length === 0 ? (
                <EmptyLine text="没有分支信息（或服务端没回 branches 数组）。" />
              ) : (
                data.branches.map((branch) => (
                  <div
                    key={branch.name}
                    className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1"
                    data-testid="graph-branch"
                  >
                    <GitBranch className="size-3 text-muted-foreground" />
                    <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{branch.name}</span>
                    <Badge variant="outline" className="font-mono" title={branch.head}>
                      {shortSha(branch.head)}
                    </Badge>
                    {branch.upstream ? (
                      <Badge variant="muted" className="font-mono" title={`upstream ${branch.upstream}`}>
                        ↑{branch.upstream}
                      </Badge>
                    ) : (
                      <Badge variant="muted">无 upstream</Badge>
                    )}
                  </div>
                ))
              )}
            </Panel>

            <Panel
              title="卡片 ↔ worktree"
              icon={<GitFork className="size-3.5 text-muted-foreground" />}
              count={data.cards.length}
              hint="只列绑了 worktree 的卡"
              testId="graph-cards"
            >
              {data.cards.length === 0 ? (
                <EmptyLine text="这个仓库里还没有卡片绑 worktree（没绑的卡不会出现在这里）。" />
              ) : (
                data.cards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    data-testid={`graph-card-${card.id}`}
                    onClick={() => onOpenCard(card.id)}
                    className="flex w-full flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1 text-left hover:bg-accent"
                    title={`打开卡片 ${card.id}`}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${stateTone(card.state)}`} />
                    <span className="min-w-0 flex-1 truncate text-xs">{card.title ?? card.id}</span>
                    {card.branch ? (
                      <Badge variant="info" className="font-mono text-[10px]">
                        {card.branch}
                      </Badge>
                    ) : null}
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {card.id}
                    </Badge>
                  </button>
                ))
              )}
            </Panel>
          </div>
        </div>
      ) : null}

      {!data && !loading && !result ? (
        <div className="p-1" data-testid="graph-empty">
          <EmptyLine text="没有可显示的数据。" />
        </div>
      ) : null}
    </div>
  );
}
