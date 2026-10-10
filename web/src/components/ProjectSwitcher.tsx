/**
 * 顶部项目选择器（看板 Metadata）：显示当前项目名 + 从 git 自动读出来的元数据
 * （remote 短形、当前分支、最后提交、脏文件数），并支持现场添加项目（输入仓库绝对路径）。
 */
import { useState } from "react";
import { AlertTriangle, Check, FolderGit2, GitBranch, GitCommitHorizontal, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shortRemote, type ProjectView } from "@/lib/projects";
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
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-testid="project-path-input"
            autoFocus
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
          <span className="text-[11px] text-muted-foreground">
            服务端会读 remote / 分支 / 最后提交 / 脏文件数
          </span>
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
