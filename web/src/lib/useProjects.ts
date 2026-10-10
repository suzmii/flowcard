/**
 * 项目选择状态：`GET /api/projects` 拉列表，选中的 id 存 localStorage（刷新后保持）。
 * 服务端的项目列表一定含 `local`（未归属的卡），所以选不上已存 id 时兜回 `local`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LOCAL_PROJECT_ID, addProject, fetchProjects, type ProjectView } from "@/lib/projects";

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
  add: (path: string) => Promise<{ ok: true; project: ProjectView } | { ok: false; message: string }>;
  refresh: () => Promise<void>;
};

export function useProjects(): ProjectsData {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => readStoredId());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetchProjects();
      if (result.ok) {
        setProjects(result.projects);
        setUnavailable(false);
        setError(result.projects.length === 0 ? "服务端没有返回任何项目（连 local 都没有）" : null);
      } else {
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

  // 选中的 id 必须落在列表里；不在（首次、项目被删、id 变了）就兜回 local，没有 local 再退到第一个。
  // 注意：列表还没回来时（loading）**不能**拿空列表去清选择，否则 localStorage 里存的会被冲掉。
  useEffect(() => {
    if (loading) return;
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
  }, [loading, projects, selectedId]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    writeStoredId(id);
  }, []);

  const add = useCallback<ProjectsData["add"]>(
    async (path) => {
      const result = await addProject(path);
      if (!result.ok) return { ok: false, message: result.message };
      await refresh();
      select(result.project.id);
      return { ok: true, project: result.project };
    },
    [refresh, select],
  );

  const selected = projects.find((project) => project.id === selectedId) ?? null;

  return { projects, selected, loading, error, unavailable, select, add, refresh };
}
