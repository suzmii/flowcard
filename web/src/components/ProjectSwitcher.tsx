/**
 * 顶部项目选择器（看板 Metadata）：显示当前项目名 + 从 git 自动读出来的元数据
 * （remote 短形、当前分支、最后提交、脏文件数），并支持现场添加项目（输入仓库绝对路径）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  FolderGit2,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchCandidates,
  pickProject,
  shortRemote,
  type CandidateView,
  type ProjectView,
} from "@/lib/projects";
import { timeAgo } from "@/lib/utils";

/** 项目元数据一行：remote / 分支 / 最后提交 / 脏文件数。 */
function ProjectMeta({ project }: { project: ProjectView }) {
  const remote = shortRemote(project.remote);

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="project-meta">
      {remote ? (
        <Badge variant="outline" className="font-mono" title={project.remote}>
          {remote}
        </Badge>
      ) : (
        <Badge variant="muted">无 remote</Badge>
      )}
      {project.headBranch ? (
        <Badge variant="info" title="当前分支">
          <GitBranch />
          {project.headBranch}
        </Badge>
      ) : null}
      {project.lastCommit ? (
        <Badge
          variant="outline"
          className="max-w-[26rem]"
          title={`${project.lastCommit.sha}\n${project.lastCommit.subject}\n${project.lastCommit.at}`}
        >
          <GitCommitHorizontal />
          <span className="font-mono">{project.lastCommit.sha.slice(0, 7)}</span>
          <span className="truncate">{project.lastCommit.subject}</span>
          <span className="text-muted-foreground">{timeAgo(project.lastCommit.at)}</span>
        </Badge>
      ) : null}
      {typeof project.dirtyFiles === "number" ? (
        <Badge variant={project.dirtyFiles > 0 ? "warning" : "success"}>
          {project.dirtyFiles > 0 ? `${project.dirtyFiles} 个未提交文件` : "工作区干净"}
        </Badge>
      ) : null}
      {project.virtual ? <Badge variant="muted">合成项目（未归属的卡）</Badge> : null}
    </div>
  );
}

export function ProjectSwitcher({
  projects,
  selected,
  loading,
  error,
  unavailable,
  onSelect,
  onAdd,
}: {
  projects: ProjectView[];
  selected: ProjectView | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  onSelect: (id: string) => void;
  onAdd: (path: string) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
}) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  // 展开"添加项目"时才去扫候选仓库（省得每次打开看板都扫盘）
  useEffect(() => {
    if (!adding || candidates !== null) return;
    let alive = true;
    void fetchCandidates().then((result) => {
      if (!alive) return;
      if (result.ok) {
        setCandidates(result.candidates.filter((c) => !projects.some((p) => p.path === c.path)));
        setCandidatesError(null);
      } else {
        setCandidates([]);
        setCandidatesError(result.message);
      }
    });
    return () => {
      alive = false;
    };
  }, [adding, candidates, projects]);

  /** 唤起服务端桌面上的原生目录选择器（浏览器拿不到绝对路径）。 */
  const browse = useCallback(async () => {
    setPicking(true);
    setNotice(null);
    const result = await pickProject();
    setPicking(false);
    if (!result.ok) {
      // 取消/超时不是错误，给灰字提示就够
      if (result.cancelled) setNotice({ tone: "ok", text: result.message });
      else setNotice({ tone: "error", text: `选择失败：${result.message}` });
      return;
    }
    // 选择器已在服务端把它注册好了；再走一次 onAdd（幂等）以刷新列表并选中
    const added = await onAdd(result.project.path);
    if (added.ok) {
      setNotice({ tone: "ok", text: `已添加项目「${added.project.name}」（来自目录选择器）` });
      setAdding(false);
      setCandidates(null);
    } else {
      setNotice({ tone: "error", text: `添加项目失败：${added.message}` });
    }
  }, [onAdd]);

  const addCandidate = async (candidate: CandidateView) => {
    setBusy(true);
    setNotice(null);
    const result = await onAdd(candidate.path);
    setBusy(false);
    if (result.ok) {
      setNotice({ tone: "ok", text: `已添加项目「${result.project.name}」` });
      setAdding(false);
      setCandidates(null);
    } else {
      setNotice({ tone: "error", text: `添加项目失败：${result.message}` });
    }
  };

  const submit = async () => {
    const trimmed = path.trim();
    if (trimmed === "") {
      setNotice({ tone: "error", text: "请填仓库的绝对路径（例如 /home/me/workspace/proj）。" });
      return;
    }
    setBusy(true);
    const result = await onAdd(trimmed);
    setBusy(false);
    if (result.ok) {
      setNotice({ tone: "ok", text: `已添加项目「${result.project.name}」` });
      setPath("");
      setAdding(false);
    } else {
      setNotice({ tone: "error", text: `添加项目失败：${result.message}` });
    }
  };

  return (
    <div className="space-y-1.5" data-testid="project-switcher">
      <div className="flex flex-wrap items-center gap-2">
        <FolderGit2 className="size-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">项目</span>
        <select
          data-testid="project-select"
          aria-label="当前项目"
          className="h-8 max-w-[22rem] min-w-0 rounded-md border bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          value={selected?.id ?? ""}
          disabled={loading || projects.length === 0}
          onChange={(event) => onSelect(event.target.value)}
        >
          {projects.length === 0 ? (
            <option value="">{loading ? "读取项目…" : "没有可选项目"}</option>
          ) : (
            projects.map((project) => (
              <option key={project.id} value={project.id} title={project.path}>
                {project.name} · {project.path}
              </option>
            ))
          )}
        </select>
        <Button
          size="xs"
          variant="outline"
          data-testid="project-add-toggle"
          onClick={() => {
            setAdding((prev) => !prev);
            setNotice(null);
          }}
        >
          <Plus />
          添加项目
        </Button>
        {selected ? <ProjectMeta project={selected} /> : null}
      </div>

      {adding ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-2.5" data-testid="project-add-panel">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              data-testid="project-browse"
              disabled={picking}
              onClick={() => void browse()}
            >
              {picking ? <Loader2 className="animate-spin" /> : <FolderSearch />}
              {picking ? "等待你在桌面上选择…" : "浏览…（打开文件管理器）"}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              对话框会弹在你桌面上（服务端在同一台机器上唤起）
            </span>
          </div>

          {candidates === null ? (
            <div className="text-[11px] text-muted-foreground" data-testid="project-candidates-loading">
              正在扫描常见工作目录…
            </div>
          ) : candidates.length > 0 ? (
            <div className="space-y-1" data-testid="project-candidates">
              <div className="text-[11px] text-muted-foreground">扫描到的仓库（点一下即添加）：</div>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.path}
                    type="button"
                    data-testid={`project-candidate-${candidate.name}`}
                    title={candidate.path}
                    disabled={busy}
                    onClick={() => void addCandidate(candidate)}
                    className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50"
                  >
                    <FolderGit2 className="size-3 text-muted-foreground" />
                    <span className="font-medium">{candidate.name}</span>
                    {candidate.remote ? (
                      <span className="text-muted-foreground">{shortRemote(candidate.remote)}</span>
                    ) : null}
                    {candidate.headBranch ? <span className="text-muted-foreground">{candidate.headBranch}</span> : null}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground" data-testid="project-candidates-empty">
              常见工作目录里没有未添加的 git 仓库{candidatesError ? `（${candidatesError}）` : ""}
            </div>
          )}

          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">或手动输入仓库绝对路径</summary>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Input
                data-testid="project-path-input"
                className="max-w-[28rem]"
                placeholder="/home/me/workspace/proj（仓库绝对路径）"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
              />
              <Button size="xs" data-testid="project-add-submit" disabled={busy} onClick={() => void submit()}>
                {busy ? <Loader2 className="animate-spin" /> : null}
                {busy ? "读取 git 元数据…" : "添加"}
              </Button>
            </div>
          </details>
        </div>
      ) : null}

      {notice ? (
        <div
          data-testid="project-notice"
          className={
            notice.tone === "ok"
              ? "flex items-center gap-1.5 text-[11px] text-emerald-700"
              : "flex items-center gap-1.5 text-[11px] text-red-700"
          }
        >
          {notice.tone === "ok" ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
          <span className="break-all">{notice.text}</span>
        </div>
      ) : null}

      {error ? (
        <div data-testid="project-error" className="text-[11px] text-amber-700">
          {unavailable ? "项目接口不可用（降级显示全部卡片）：" : "读项目失败："}
          {error}
        </div>
      ) : null}
    </div>
  );
}
