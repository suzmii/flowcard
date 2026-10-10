/**
 * 顶部项目选择器（看板 Metadata）：显示当前项目名 + 从 git 自动读出来的元数据
 * （remote 短形、当前分支、最后提交、脏文件数），并支持现场添加项目（输入仓库绝对路径）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  FolderGit2,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchCandidates,
  pickProject,
  projectIssueBase,
  shortRemote,
  templateHasNumber,
  type CandidateView,
  type IssueBase,
  type ProjectView,
  type SyncReportView,
  type SyncStatusView,
} from "@/lib/projects";
import { timeAgo } from "@/lib/utils";

/** 模板输入的占位例子：说清 `{number}` 才是被替换的那一段。 */
const ISSUE_TEMPLATE_PLACEHOLDER = "https://git.example.com/git/Team/Repo/issues/{number}";

/** 项目元数据一行：remote / 分支 / 最后提交 / 脏文件数 / Issue 基址 / 同步状态。 */
function ProjectMeta({
  project,
  syncStatus,
  syncing,
  onEditIssueBase,
  onSync,
}: {
  project: ProjectView;
  /** 同步状态（`GET /api/projects/:id/sync`）；拿不到/接口没实现时为 null */
  syncStatus: SyncStatusView | null;
  syncing: boolean;
  onEditIssueBase?: () => void;
  onSync: () => void;
}) {
  const remote = shortRemote(project.remote);
  const base = projectIssueBase(project);
  // 显示去掉协议头，省地方；完整模板挂在 title 上
  const baseLabel = base.urlTemplate
    ? `Issue ${base.repo ? `${base.repo} · ` : ""}${base.urlTemplate.replace(/^https?:\/\//, "")}`
    : "Issue 基址未设置";
  const degraded = syncStatus?.degraded ?? [];
  const syncLabel =
    syncStatus?.lastError != null
      ? `同步失败：${syncStatus.lastError}`
      : syncStatus?.lastSyncAt
        ? `最后同步 ${timeAgo(syncStatus.lastSyncAt)}`
        : "还没同步过";

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
      <Badge
        variant={base.urlTemplate ? "outline" : "muted"}
        data-testid="project-issue-base"
        className="max-w-[26rem] font-mono"
        title={
          base.urlTemplate
            ? `Issue 基址：${base.repo ?? "（repo 未设，按 remote）"} → ${base.urlTemplate}`
            : "Issue 基址未设置：绑 Issue 时还得手填完整 url"
        }
      >
        <CircleDot />
        <span className="truncate">{baseLabel}</span>
      </Badge>
      {onEditIssueBase && !project.virtual ? (
        <Button
          size="xs"
          variant="ghost"
          data-testid="project-issue-base-edit-toggle"
          onClick={onEditIssueBase}
        >
          <Pencil />
          改 Issue 基址
        </Button>
      ) : null}
      {project.virtual ? (
        <Badge variant="muted">合成项目（未归属的卡）</Badge>
      ) : (
        <>
          <Badge
            variant={syncStatus?.lastError != null ? "danger" : degraded.length > 0 ? "warning" : "outline"}
            data-testid="project-sync-status"
            title={syncStatus?.lastSyncAt ? `上次同步：${syncStatus.lastSyncAt}` : "这个项目还没同步过"}
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} />
            {syncLabel}
          </Badge>
          {degraded.length > 0 ? (
            <Badge
              variant="warning"
              data-testid="project-sync-degraded"
              title={degraded
                .map((item) => `${item.endpoint}：${item.reason}${item.detail ? ` —— ${item.detail}` : ""}`)
                .join("\n")}
            >
              <AlertTriangle />
              本轮数据可能不全（{degraded.length}）
            </Badge>
          ) : null}
          {syncStatus ? (
            <Badge variant="muted" title="卡片已绑定的编号数（同步只精确读这些）">
              已绑 {syncStatus.tracked.issues} issue / {syncStatus.tracked.pulls} PR
            </Badge>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            data-testid="project-sync-now"
            disabled={syncing}
            onClick={onSync}
          >
            <RefreshCw className={syncing ? "animate-spin" : undefined} />
            {syncing ? "同步中…" : "立即同步"}
          </Button>
        </>
      )}
    </div>
  );
}

export function ProjectSwitcher({
  projects,
  selected,
  loading,
  error,
  unavailable,
  syncStatus,
  syncing,
  onSelect,
  onAdd,
  onSetIssueBase,
  onSync,
}: {
  projects: ProjectView[];
  selected: ProjectView | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  /** 当前项目的同步状态（`GET /api/projects/:id/sync`） */
  syncStatus: SyncStatusView | null;
  syncing: boolean;
  onSelect: (id: string) => void;
  onAdd: (
    path: string,
    issueBase?: IssueBase,
  ) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
  onSetIssueBase: (
    id: string,
    input: { repo?: string; urlTemplate?: string; clear?: boolean },
  ) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
  /** 「立即同步」：跑一轮只读同步；返回结果由这里出面提示 */
  onSync: () => Promise<{ ok: true; report: SyncReportView } | { ok: false; message: string }>;
}) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [issueRepo, setIssueRepo] = useState("");
  const [issueTemplate, setIssueTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [baseRepo, setBaseRepo] = useState("");
  const [baseTemplate, setBaseTemplate] = useState("");
  const [baseBusy, setBaseBusy] = useState(false);

  /** 读「Issue 基址」两个输入框；模板必须带 `{number}`，否则把理由交给调用方展示。 */
  const readIssueBaseInput = (
    repoValue: string,
    templateValue: string,
  ): { ok: true; base: IssueBase } | { ok: false; message: string } => {
    const template = templateValue.trim();
    if (template !== "" && !templateHasNumber(template)) {
      return { ok: false, message: `Issue 地址模板要含 {number} 占位（例：${ISSUE_TEMPLATE_PLACEHOLDER}）。` };
    }
    const repo = repoValue.trim();
    return {
      ok: true,
      base: { ...(repo ? { repo } : {}), ...(template ? { urlTemplate: template } : {}) },
    };
  };

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
    const read = readIssueBaseInput(issueRepo, issueTemplate);
    if (!read.ok) {
      setNotice({ tone: "error", text: read.message });
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await onAdd(candidate.path, read.base);
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
    const read = readIssueBaseInput(issueRepo, issueTemplate);
    if (!read.ok) {
      setNotice({ tone: "error", text: read.message });
      return;
    }
    setBusy(true);
    const result = await onAdd(trimmed, read.base);
    setBusy(false);
    if (result.ok) {
      setNotice({ tone: "ok", text: `已添加项目「${result.project.name}」` });
      setPath("");
      setAdding(false);
    } else {
      setNotice({ tone: "error", text: `添加项目失败：${result.message}` });
    }
  };

  /** 打开当前项目的 Issue 基址编辑器，并把现有值灌进输入框。 */
  const openBaseEditor = (project: ProjectView) => {
    setEditingBase(true);
    setBaseRepo(project.issueRepo?.trim() ?? "");
    setBaseTemplate(project.issueUrlTemplate?.trim() ?? "");
    setNotice(null);
  };

  /** 保存当前项目的 Issue 基址；两个框都清空（或点清空）就回到「按 remote 派生」。 */
  const saveBase = async (clear: boolean) => {
    if (!selected) return;
    const repo = baseRepo.trim();
    const template = baseTemplate.trim();
    if (!clear && template !== "" && !templateHasNumber(template)) {
      setNotice({ tone: "error", text: `Issue 地址模板要含 {number} 占位（例：${ISSUE_TEMPLATE_PLACEHOLDER}）。` });
      return;
    }
    // 留空的字段发给服务端会被拒（min(1)），所以只发填了的；两个都空 = 清空
    const wipe = clear || (repo === "" && template === "");
    const payload: { repo?: string; urlTemplate?: string; clear?: boolean } = wipe
      ? { clear: true }
      : { ...(repo ? { repo } : {}), ...(template ? { urlTemplate: template } : {}) };
    setBaseBusy(true);
    const result = await onSetIssueBase(selected.id, payload);
    setBaseBusy(false);
    if (result.ok) {
      setNotice({
        tone: "ok",
        text: wipe
          ? `已清空「${result.project.name}」的 Issue 基址（改回按 remote 派生）`
          : `已更新「${result.project.name}」的 Issue 基址`,
      });
      setEditingBase(false);
    } else {
      setNotice({ tone: "error", text: `改 Issue 基址失败：${result.message}` });
    }
  };

  /** 「立即同步」：结果在这里提示（成功把这一轮读了什么报出来，人知道游标的窗口有多宽）。 */
  const runSyncNow = async () => {
    setNotice(null);
    const result = await onSync();
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message });
      return;
    }
    const { counts, applied, duplicates, facts } = result.report;
    setNotice({
      tone: "ok",
      text:
        `同步完成：读到 issue ${counts.issues} / PR ${counts.pulls} / 评论 ${counts.comments}，` +
        `算出事实 ${facts} 条（落库 ${applied}，重复 ${duplicates}）`,
    });
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
        {selected ? (
          <ProjectMeta
            project={selected}
            syncStatus={syncStatus}
            syncing={syncing}
            onEditIssueBase={() => openBaseEditor(selected)}
            onSync={() => void runSyncNow()}
          />
        ) : null}
      </div>

      {editingBase && selected ? (
        <div
          className="space-y-2 rounded-lg border bg-muted/30 p-2.5"
          data-testid="project-issue-base-panel"
        >
          <div className="text-[11px] text-muted-foreground">
            改「{selected.name}」的 Issue 基址：绑 Issue 时只填数字，链接由模板拼出来。
            <span className="ml-1">留空的字段保持不动；两个都清空（或点「清空」）就回到按 remote 派生。</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Issue 地址模板（{`{number}`} 是占位）</span>
              <Input
                data-testid="project-issue-base-input"
                className="max-w-[34rem]"
                placeholder={ISSUE_TEMPLATE_PLACEHOLDER}
                value={baseTemplate}
                onChange={(event) => setBaseTemplate(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">repo（owner/name）</span>
              <Input
                data-testid="project-issue-base-edit-repo"
                className="max-w-[16rem]"
                placeholder="owner/name（留空按 remote）"
                value={baseRepo}
                onChange={(event) => setBaseRepo(event.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              data-testid="project-issue-base-save"
              disabled={baseBusy}
              onClick={() => void saveBase(false)}
            >
              {baseBusy ? <Loader2 className="animate-spin" /> : null}
              {baseBusy ? "保存中…" : "保存 Issue 基址"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              data-testid="project-issue-base-clear"
              disabled={baseBusy}
              onClick={() => void saveBase(true)}
            >
              清空（回到按 remote 派生）
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setEditingBase(false)}>
              取消
            </Button>
            <span className="text-[11px] text-muted-foreground">例：{ISSUE_TEMPLATE_PLACEHOLDER}</span>
          </div>
        </div>
      ) : null}

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

          <div className="flex flex-wrap items-center gap-2" data-testid="project-issue-base-field">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">
                Issue 地址模板（可选 · 只绑 Issue 用，{`{number}`} 会被数字替换）
              </span>
              <Input
                data-testid="project-issue-base-add-input"
                className="max-w-[34rem]"
                placeholder={ISSUE_TEMPLATE_PLACEHOLDER}
                value={issueTemplate}
                onChange={(event) => setIssueTemplate(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">repo（可选）</span>
              <Input
                data-testid="project-issue-repo-input"
                className="max-w-[16rem]"
                placeholder="owner/name（留空按 remote）"
                value={issueRepo}
                onChange={(event) => setIssueRepo(event.target.value)}
              />
            </label>
          </div>
          <div className="text-[11px] text-muted-foreground">
            例：<span className="font-mono">{ISSUE_TEMPLATE_PLACEHOLDER}</span> —— 填了它，之后绑 Issue
            只要填数字。
          </div>

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
