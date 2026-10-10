/**
 * 项目（看板的 Metadata）：把一个 git 仓库读成 `Project`。
 *
 * 分层与 `probe.ts` 一致：**只读 git 子命令**（`rev-parse` / `remote get-url` / `log` / `status`），
 * 绝不 fetch/push/pull，也不联网；执行器可注入，所以测试既能用真实临时仓库、也能造降级场景。
 *
 * id 由仓库根路径派生（目录名 + 短哈希）：同一路径永远同一个 id（幂等），人也能看懂是哪个仓库。
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { shortHash } from "../shared/hash.ts";
import { normalizePath } from "../shared/paths.ts";
import {
  LOCAL_PROJECT_ID,
  LOCAL_PROJECT_NAME,
  type Project,
} from "../shared/types.ts";
import { defaultRun, firstLine, GIT_TIMEOUT_MS, type Run } from "./probe.ts";

/** id 里哈希后缀的位数：4 位够把「同名目录」区分开，也还短得能读。 */
export const PROJECT_HASH_LEN = 4;

/** 目录名太长时截断，避免 id 变成一长串。 */
const MAX_NAME_LEN = 32;

/**
 * 仓库根路径 → 项目 id：目录名（非法字符换成 `-`）+ 路径哈希前 4 位。
 * 纯函数、不碰 fs：路径稳定 → id 稳定，重复 add 才算得出同一个 id。
 */
export function projectIdFor(rootPath: string, hashLen: number = PROJECT_HASH_LEN): string {
  const normalized = normalizePath(rootPath);
  const raw = basename(normalized) || "repo";
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LEN);
  const name = safe === "" ? "repo" : safe;
  return `${name}-${shortHash(normalized).slice(0, hashLen)}`;
}

/** 目录名（原样，只做去空/截断）：`Project.name` 的默认值。 */
function projectNameFor(rootPath: string): string {
  const raw = basename(normalizePath(rootPath));
  return raw === "" ? "repo" : raw.slice(0, MAX_NAME_LEN);
}

/** 合成项目「未归属」：所有没归属的卡片都落在这里，看板上也要能看到它。 */
export function localProject(addedAt: string): Project {
  return {
    id: LOCAL_PROJECT_ID,
    name: LOCAL_PROJECT_NAME,
    path: "",
    virtual: true,
    addedAt,
    lastSeenAt: addedAt,
  };
}

export type ProjectReadError = {
  code: "NOT_A_REPO";
  message: string;
  hint: string;
};

export type ProjectReadResult = { ok: true; project: Project } | { ok: false; error: ProjectReadError };

/**
 * 读一个仓库的元数据。`path` 指向仓库内任意目录都行（`git -C` 自己找到根）。
 * 不是 git 仓库 / git 不可用 → `ok:false`（不抛），由调用方决定回什么状态码。
 */
export async function readProject(
  path: string,
  opts: { run?: Run; now?: string } = {},
): Promise<ProjectReadResult> {
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? new Date().toISOString();
  const target = normalizePath(path);
  const git = (args: string[], timeoutMs = GIT_TIMEOUT_MS) => run("git", args, { cwd: target, timeoutMs });

  const top = await git(["-C", target, "rev-parse", "--show-toplevel"]);
  const root = normalizePath(firstLine(top.stdout));
  if (top.code !== 0 || root === "") {
    return {
      ok: false,
      error: {
        code: "NOT_A_REPO",
        message: `${path} 不是一个 git 仓库${top.missing ? "（git 不可用）" : ""}`,
        hint: "只接受 git 仓库：先 git init / clone，或用仓库内的子目录也行（会自己找到根）",
      },
    };
  }

  const [branchR, remoteR, originHeadR, logR, statusR] = await Promise.all([
    git(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]),
    git(["-C", root, "remote", "get-url", "origin"]),
    git(["-C", root, "rev-parse", "--abbrev-ref", "origin/HEAD"]),
    git(["-C", root, "log", "-1", "--format=%H%x1f%s%x1f%cI"]),
    git(["-C", root, "status", "--porcelain"]),
  ]);

  // detached HEAD 会回 "HEAD"：那不是分支，宁可缺省也不写错。
  const headBranch = branchR.code === 0 ? firstLine(branchR.stdout) : "";
  const remote = remoteR.code === 0 ? firstLine(remoteR.stdout) : "";

  // origin/HEAD 是本地 remote-tracking ref，不联网；拿不到就回退到本地存在的 main / master。
  let defaultBranch = firstLine(originHeadR.stdout).replace(/^origin\//, "");
  if (defaultBranch === "" || defaultBranch === "HEAD") {
    for (const candidate of ["main", "master"]) {
      const exists = await git(["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]);
      if (exists.code === 0) {
        defaultBranch = candidate;
        break;
      }
    }
  }

  const lastCommit = lastCommitOf(logR.stdout);

  const project: Project = {
    id: projectIdFor(root),
    name: projectNameFor(root),
    path: root,
    ...(remote !== "" ? { remote } : {}),
    ...(headBranch !== "" && headBranch !== "HEAD" ? { headBranch } : {}),
    ...(defaultBranch !== "" && defaultBranch !== "HEAD" ? { defaultBranch } : {}),
    ...(lastCommit ? { lastCommit } : {}),
    // 脏文件数 = git status --porcelain 的行数；干净时输出为空串（不是一行空行），所以单独判。
    ...(statusR.code === 0
      ? { dirtyFiles: statusR.stdout === "" ? 0 : statusR.stdout.replace(/\n+$/, "").split("\n").length }
      : {}),
    addedAt: now,
    lastSeenAt: now,
  };
  return { ok: true, project };
}

/** `git log -1 --format=%H%x1f%s%x1f%cI` → 提交摘要（字段不齐就返回 null）。 */
/** 候选项目根目录：`FLOWCARD_PROJECT_ROOTS` 冒号分隔，默认 `~/workspace`。 */
export function projectRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.FLOWCARD_PROJECT_ROOTS;
  const roots = raw
    ? raw.split(":").map((p) => p.trim()).filter(Boolean)
    : [`${env.HOME ?? homedir()}/workspace`];
  return roots.map((p) => normalizePath(p));
}

/** 扫描常见工作目录，找出可直接添加的 git 仓库（给"选择项目"提供候选，省得翻对话框）。 */
const SCAN_SKIP = new Set(["node_modules", "dist", "target", "build", "vendor", ".git", ".worktrees"]);

export type RepoCandidate = {
  path: string;
  name: string;
  remote?: string;
  headBranch?: string;
};

export async function scanGitRepos(
  roots: string[],
  opts: { depth?: number; run?: Run } = {},
): Promise<RepoCandidate[]> {
  const depth = opts.depth ?? 2;
  const run = opts.run ?? defaultRun;
  const found: RepoCandidate[] = [];

  const visit = async (dir: string, level: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 不存在/没权限：跳过，不抛
    }
    if (entries.some((e) => e.name === ".git")) {
      const result = await readProject(dir, { run });
      if (result.ok) {
        found.push({
          path: result.project.path,
          name: result.project.name,
          ...(result.project.remote ? { remote: result.project.remote } : {}),
          ...(result.project.headBranch ? { headBranch: result.project.headBranch } : {}),
        });
      }
      return; // 仓库内部不再往下找（嵌套仓库另算）
    }
    if (level >= depth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SCAN_SKIP.has(entry.name)) continue;
      await visit(join(dir, entry.name), level + 1);
    }
  };

  for (const root of roots) await visit(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

function lastCommitOf(stdout: string): Project["lastCommit"] | null {
  const [sha, subject, at] = firstLine(stdout).split("\x1f");
  if (!sha || !at) return null;
  return { sha, subject: subject ?? "", at };
}
