/**
 * 项目（看板 Metadata）：`GET /api/projects` / `POST /api/projects`。
 * 项目是服务端从 git 仓库自动读出来的，前端只做选择与展示；`local` 是合成项目（未归属的卡）。
 * 服务端接口可能还没挂上（404/网络失败），这里一律降级成可读文案 + `unavailable`，UI 不因此崩。
 */
import { z } from "zod";
import type * as shared from "../../../src/shared/types.ts";
import { apiUrl, readErrorBody, unreachableMessage } from "@/lib/api";
import { describeIssues } from "@/lib/schema";

/**
 * 合成项目 id：不属于任何仓库的卡都落在这里。
 * 与 `src/shared/types.ts` 的 `LOCAL_PROJECT_ID` 用编译期断言锁住（那边是 value，`import type` 才不会把 zod 拖进 bundle）。
 */
export const LOCAL_PROJECT_ID = "local";

type Assert<T extends true> = T;
type _LocalProjectIdMatchesShared = Assert<
  (typeof LOCAL_PROJECT_ID) extends (typeof shared.LOCAL_PROJECT_ID) ? true : false
>;

const lastCommitSchema = z.looseObject({
  sha: z.string(),
  subject: z.string(),
  at: z.string(),
});

export const projectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  remote: z.string().optional(),
  headBranch: z.string().optional(),
  defaultBranch: z.string().optional(),
  lastCommit: lastCommitSchema.optional(),
  dirtyFiles: z.number().optional(),
  virtual: z.boolean().optional(),
  addedAt: z.string(),
  lastSeenAt: z.string(),
});

export type ProjectView = z.infer<typeof projectSchema>;

const projectsResponseSchema = z.looseObject({ projects: z.array(projectSchema) });
const projectResponseSchema = z.looseObject({
  project: projectSchema,
  created: z.boolean().optional(),
});

export type ProjectsResult =
  | { ok: true; projects: ProjectView[] }
  | { ok: false; message: string; unavailable: boolean };

export type AddProjectResult =
  | { ok: true; project: ProjectView; created: boolean }
  | { ok: false; message: string; unavailable: boolean };

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectsResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/projects"), { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error), unavailable: true };
  }
  if (res.status === 404) {
    return { ok: false, message: "服务端还没有 /api/projects（项目接口未实现）", unavailable: true };
  }
  const parsed = projectsResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      message: `项目列表不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`,
      unavailable: true,
    };
  }
  return { ok: true, projects: parsed.data.projects };
}

/** 添加项目：输入仓库绝对路径，服务端自己读 git 元数据。 */
export async function addProject(path: string, signal?: AbortSignal): Promise<AddProjectResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/projects"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error), unavailable: true };
  }
  if (res.status === 404) {
    return { ok: false, message: "服务端还没有 POST /api/projects（项目接口未实现）", unavailable: true };
  }
  if (!res.ok) {
    return { ok: false, message: await readErrorBody(res), unavailable: false };
  }
  const parsed = projectResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return {
      ok: false,
      message: `添加项目返回不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}`,
      unavailable: false,
    };
  }
  return { ok: true, project: parsed.data.project, created: parsed.data.created ?? true };
}

/** remote 短形：`git@github.com:owner/repo.git` / `https://host/owner/repo.git` → `owner/repo`。 */
export function shortRemote(remote: string | undefined): string | null {
  if (!remote) return null;
  const trimmed = remote.trim().replace(/\.git$/, "");
  if (trimmed === "") return null;
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(trimmed);
  if (scp?.[1]) return scp[1];
  try {
    const url = new URL(trimmed);
    return url.pathname.replace(/^\//, "") || trimmed;
  } catch {
    return trimmed;
  }
}

/** 项目的元数据摘要（remote / 分支 / 最后提交 / 脏文件），给顶部与选择器用。 */
export function projectSummary(project: ProjectView): string[] {
  const parts: string[] = [];
  const remote = shortRemote(project.remote);
  if (remote) parts.push(remote);
  if (project.headBranch) parts.push(`分支 ${project.headBranch}`);
  if (project.lastCommit) {
    parts.push(`${project.lastCommit.sha.slice(0, 7)} ${project.lastCommit.subject}`);
  }
  if (typeof project.dirtyFiles === "number") {
    parts.push(project.dirtyFiles > 0 ? `${project.dirtyFiles} 个未提交文件` : "工作区干净");
  }
  if (project.virtual) parts.push("合成项目（未归属的卡）");
  return parts;
}
