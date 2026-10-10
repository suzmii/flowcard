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
  /** Issue 基址：repo 短形（`owner/name`），没设就按 remote 派生；绑定 Issue 时不用再手填 */
  issueRepo: z.string().optional(),
  /** Issue URL 模板，`{number}` 是占位符；绑 Issue 时只填数字，链接由它拼出来 */
  issueUrlTemplate: z.string().optional(),
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

/**
 * Issue 基址：把「绑 Issue 要填的三件套」压成项目级的一次性配置。
 * - `repo`：短形（`owner/name`）；缺省时服务端按 remote 派生
 * - `urlTemplate`：`{number}` 占位，绑 Issue 只填数字就能拼出链接
 */
export type IssueBase = { repo?: string; urlTemplate?: string };

/** 空值一律当「没设」，避免把 `""` 传给服务端把基址抹掉（那是 `clear` 的事）。 */
function addIssueBaseFields(body: Record<string, unknown>, issueBase: IssueBase | undefined) {
  if (!issueBase) return;
  const repo = issueBase.repo?.trim();
  const template = issueBase.urlTemplate?.trim();
  if (repo) body["issueRepo"] = repo;
  if (template) body["issueUrlTemplate"] = template;
}

/** 取项目的 Issue 基址：模板用项目的；repo 没设时回退到 remote 短形。 */
export function projectIssueBase(project: ProjectView | null | undefined): IssueBase {
  if (!project) return {};
  const repo = shortRemote(project.issueRepo ?? project.remote) ?? undefined;
  const urlTemplate = project.issueUrlTemplate?.trim() || undefined;
  return { ...(repo ? { repo } : {}), ...(urlTemplate ? { urlTemplate } : {}) };
}

/** 模板里必须有 `{number}` 占位，否则拼出来的链接永远是同一条。 */
export function templateHasNumber(template: string): boolean {
  return template.includes("{number}");
}

/** 用模板把 Issue 编号拼成 URL；模板缺占位或编号不是正整数 → null（由调用方决定怎么提示）。 */
export function issueUrlFromTemplate(
  template: string | undefined,
  number: string | number,
): string | null {
  const raw = typeof number === "number" ? String(number) : number.trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  if (!template || !templateHasNumber(template)) return null;
  return template.replaceAll("{number}", raw);
}

export type SetIssueBaseResult = { ok: true; project: ProjectView } | { ok: false; message: string };

/**
 * 改项目的 Issue 基址：`POST /api/projects/:id/issue-base`。
 * `clear: true` 清空（回到「按 remote 派生」），否则只覆盖传进来的字段。
 */
export async function setProjectIssueBase(
  id: string,
  input: { repo?: string; urlTemplate?: string; clear?: boolean },
  signal?: AbortSignal,
): Promise<SetIssueBaseResult> {
  let res: Response;
  const body: Record<string, unknown> = {};
  if (input.clear) {
    body["clear"] = true;
  } else {
    // 服务端的字段是 `min(1)`：空串会被拒；留空 = 保持不动，清空走 `clear: true`
    const repo = input.repo?.trim();
    const template = input.urlTemplate?.trim();
    if (repo) body["issueRepo"] = repo;
    if (template) body["issueUrlTemplate"] = template;
  }
  try {
    res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(id)}/issue-base`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error) };
  }
  if (res.status === 404) {
    return { ok: false, message: "服务端还没有 POST /api/projects/:id/issue-base（Issue 基址接口未实现）" };
  }
  if (!res.ok) return { ok: false, message: await readErrorBody(res) };
  const parsed = projectResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    return { ok: false, message: `Issue 基址返回不符合契约（HTTP ${res.status}）：${describeIssues(parsed.error)}` };
  }
  return { ok: true, project: parsed.data.project };
}

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

/** 添加项目：输入仓库绝对路径，服务端自己读 git 元数据；Issue 基址可选（不传按 remote 派生）。 */
export async function addProject(
  path: string,
  issueBase?: IssueBase,
  signal?: AbortSignal,
): Promise<AddProjectResult> {
  let res: Response;
  const body: Record<string, unknown> = { path };
  addIssueBaseFields(body, issueBase);
  try {
    res = await fetch(apiUrl("/api/projects"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

/** 候选仓库（扫常见工作目录得来）：点一下就能加，省得翻对话框。 */
const candidateSchema = z.looseObject({
  path: z.string(),
  name: z.string(),
  remote: z.string().optional(),
  headBranch: z.string().optional(),
});
export type CandidateView = z.infer<typeof candidateSchema>;

const candidatesResponseSchema = z.looseObject({
  roots: z.array(z.string()),
  candidates: z.array(candidateSchema),
});

export type CandidatesResult =
  | { ok: true; roots: string[]; candidates: CandidateView[] }
  | { ok: false; message: string };

export async function fetchCandidates(signal?: AbortSignal): Promise<CandidatesResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/projects/candidates"), { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error) };
  }
  if (!res.ok) return { ok: false, message: `候选仓库接口返回 ${res.status}` };
  const parsed = candidatesResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return { ok: false, message: `候选仓库不符合契约：${describeIssues(parsed.error)}` };
  return { ok: true, roots: parsed.data.roots, candidates: parsed.data.candidates };
}

export type PickProjectResult =
  | { ok: true; project: ProjectView; created: boolean }
  | { ok: false; cancelled: boolean; message: string };

/**
 * 唤起服务端所在桌面的**原生目录选择器**（浏览器拿不到绝对路径，只能这样）。
 * 用户取消 / 超时都算正常结果（cancelled: true），不要当错误弹红。
 */
export async function pickProject(start?: string, signal?: AbortSignal): Promise<PickProjectResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/projects/pick"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(start ? { start } : {}),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, cancelled: false, message: unreachableMessage(error) };
  }
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; status?: string; reason?: string; message?: string | null; project?: unknown; created?: boolean }
    | null;
  if (body?.ok === true) {
    const parsed = projectResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, cancelled: false, message: `选择项目返回不符合契约：${describeIssues(parsed.error)}` };
    }
    return { ok: true, project: parsed.data.project, created: parsed.data.created ?? true };
  }
  const reason = body?.reason ?? "failed";
  if (reason === "user") return { ok: false, cancelled: true, message: "已取消选择" };
  if (reason === "timeout") return { ok: false, cancelled: true, message: "对话框超时未操作，已取消" };
  return { ok: false, cancelled: false, message: body?.message ?? `选择项目失败（${reason}）` };
}
