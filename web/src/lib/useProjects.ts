/**
 * 项目选择状态：`GET /api/projects` 拉列表，选中的 id 存 localStorage（刷新后保持）。
 * 服务端的项目列表一定含 `local`（未归属的卡），所以选不上已存 id 时兜回 `local`。
 *
 * 硬规矩：**拉取失败不动选择** —— 失败时列表是空的，拿空列表去"修正"选择会把 localStorage 里
 * 存的 id 一起冲掉，后端恢复后用户的选择也回不来。只有成功拿到列表且列表里确实没有该 id 才换。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { streamUrl } from "@/lib/api";
import {
  LOCAL_PROJECT_ID,
  addProject,
  fetchProjects,
  fetchSyncStatus,
  runProjectSync,
  setProjectIssueBase,
  type IssueBase,
  type ProjectView,
  type SyncReportView,
  type SyncStatusView,
} from "@/lib/projects";

const STORAGE_KEY = "flowcard.projectId";

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式等拿不到 localStorage：只是不持久化，不影响使用
    return null;
  }
}

function writeStoredId(id: string | null) {
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 同上 */
  }
}

export type ProjectsData = {
  projects: ProjectView[];
  /** 当前项目；null = 没有项目可选（接口没实现或列表为空，此时看板不过滤） */
  selected: ProjectView | null;
  loading: boolean;
  error: string | null;
  /** true = 服务端还没有项目接口（降级运行，看板显示全部卡片） */
  unavailable: boolean;
  select: (id: string) => void;
  /** 添加项目：成功返回新项目（并自动选中）；失败返回理由 */
  add: (
    path: string,
    issueBase?: IssueBase,
  ) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
  /** 改某个项目的 Issue 基址（`clear` 清空）：成功返回刷新后的项目 */
  setIssueBase: (
    id: string,
    input: { repo?: string; urlTemplate?: string; clear?: boolean },
  ) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
  /** 当前项目的同步状态（`GET /api/projects/:id/sync`；没同步过 / 接口没有时为 null） */
  syncStatus: SyncStatusView | null;
  /** true = 正在跑一轮同步（按钮转圈） */
  syncing: boolean;
  /** 「立即同步」：跑一轮并刷新卡片与状态（服务端要重启后才有这个接口时给可读文案） */
  syncNow: () => Promise<{ ok: true; report: SyncReportView } | { ok: false; message: string }>;
  refresh: () => Promise<void>;
};

export function useProjects(): ProjectsData {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => readStoredId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** true = 最近一次刷新**成功拿到列表**；失败时用它挡住"拿空列表去清选择"。 */
  const [listed, setListed] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetchProjects();
      if (result.ok) {
        setProjects(result.projects);
        setUnavailable(false);
        setListed(true);
        setError(result.projects.length === 0 ? "服务端没有返回任何项目（连 local 都没有）" : null);
      } else {
        // 失败**只**报错：列表与选择都保持原样（清掉就再也回不来，恢复后也认不出原来选的是谁）
        setUnavailable(result.unavailable);
        setError(result.message);
      }
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 项目列表也要跟着 SSE 走：`hello`（连上/重连成功）与 `projects`（别处加了项目 / 改了基址）都重拉一次。
   * 否则服务端重启后项目列表不会自己回来，选择也就一直是空的。
   */
  useEffect(() => {
    const source = new EventSource(streamUrl());
    const reload = () => void refresh();
    source.addEventListener("hello", reload);
    source.addEventListener("projects", reload);
    return () => source.close();
  }, [refresh]);

  // 选中的 id 必须落在列表里；不在才换（首次、项目被删、id 变了）→ 兜回 local，没有 local 再退到第一个。
  // 关键：**只有成功拿到列表且列表里确实没有该 id** 才动选择与 localStorage。
  // 拉取失败时列表是空的，那时候清选择 = 把用户存的选择永久冲掉（后端恢复也回不来）。
  useEffect(() => {
    if (!listed) return;
    if (projects.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
        writeStoredId(null);
      }
      return;
    }
    if (selectedId !== null && projects.some((project) => project.id === selectedId)) return;
    const fallback = projects.find((project) => project.id === LOCAL_PROJECT_ID) ?? projects[0];
    if (!fallback) return;
    setSelectedId(fallback.id);
    writeStoredId(fallback.id);
  }, [listed, projects, selectedId]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    writeStoredId(id);
  }, []);

  const add = useCallback<ProjectsData["add"]>(
    async (path, issueBase) => {
      const result = await addProject(path, issueBase);
      if (!result.ok) return { ok: false, message: result.message };
      await refresh();
      select(result.project.id);
      return { ok: true, project: result.project };
    },
    [refresh, select],
  );

  const setIssueBase = useCallback<ProjectsData["setIssueBase"]>(
    async (id, input) => {
      const result = await setProjectIssueBase(id, input);
      if (!result.ok) return { ok: false, message: result.message };
      await refresh();
      return { ok: true, project: result.project };
    },
    [refresh],
  );

  const selected = projects.find((project) => project.id === selectedId) ?? null;

  /**
   * 同步状态：跟着**选中的项目**走（每个项目各自记 `lastSyncAt`）。
   * 拿不到就保持 null（徽标区域只显示「还没同步」），不因为同步接口缺失把项目面板搞崩。
   */
  const [syncStatus, setSyncStatus] = useState<SyncStatusView | null>(null);
  const [syncing, setSyncing] = useState(false);

  const loadSyncStatus = useCallback(async (projectId: string) => {
    const result = await fetchSyncStatus(projectId);
    setSyncStatus(result.ok ? result.status : null);
  }, []);

  useEffect(() => {
    if (!selected) {
      setSyncStatus(null);
      return;
    }
    let alive = true;
    void fetchSyncStatus(selected.id).then((result) => {
      if (alive) setSyncStatus(result.ok ? result.status : null);
    });
    return () => {
      alive = false;
    };
  }, [selected?.id]);

  const syncNow = useCallback<ProjectsData["syncNow"]>(async () => {
    if (!selected) return { ok: false, message: "先选一个项目" };
    setSyncing(true);
    try {
      const result = await runProjectSync(selected.id);
      await loadSyncStatus(selected.id);
      if (!result.ok) return { ok: false, message: result.message };
      if (result.report.reason !== null && result.report.reason !== undefined) {
        const why: Record<string, string> = {
          "no-remote": "这个项目的 remote 认不出目标仓库",
          "no-credentials": "本机没有可用凭据（tea 登录 / FLOWCARD_GITEA_TOKEN / FLOWCARD_GITHUB_TOKEN 都没有）",
          "no-transport": "凭据与 tea CLI 都拿不到数据",
        };
        return { ok: false, message: `同步没跑成：${why[result.report.reason] ?? result.report.reason}` };
      }
      return { ok: true, report: result.report };
    } finally {
      setSyncing(false);
    }
  }, [selected, loadSyncStatus]);

  return {
    projects,
    selected,
    loading,
    error,
    unavailable,
    select,
    add,
    setIssueBase,
    syncStatus,
    syncing,
    syncNow,
    refresh,
  };
}
