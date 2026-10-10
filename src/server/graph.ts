/**
 * 提交图（只读）：`git log --graph` 的原始输出 + 提交/分支/worktree 的结构化事实 + 卡片↔分支映射。
 *
 * 分层与 `probe.ts` 一致：
 *   1. **纯函数**：argv 拼装、输出解析、卡片映射 —— 全部可单测；
 *   2. **薄 IO**：`readGraph` 只跑命令、拼结果，`run` 可注入（测试用真实临时仓库即可）。
 *
 * 只读：只跑 `log` / `for-each-ref` / `worktree list`；**不 fetch/push/checkout**，不写任何文件。
 * 泳道图**不自己画**：`graphText` 就是 git 的原样输出，前端直接等宽渲染。
 */
import { normalizePath } from "../shared/paths.ts";
import type {
  Card,
  GraphBranch,
  GraphCardRef,
  GraphCommit,
  GraphWorktree,
  ProjectGraphResult,
} from "../shared/types.ts";
import { defaultRun, firstLine, GIT_TIMEOUT_MS, type Run, type RunOutcome } from "./probe.ts";

export const GRAPH_LIMIT_DEFAULT = 200;
export const GRAPH_LIMIT_MAX = 1000;

/** `limit` 收敛到 [1, 1000]：没给/给了不认识的数就退回默认 200（图与响应都要有上限）。 */
export function clampGraphLimit(raw: string | number | undefined): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === undefined || !Number.isFinite(n)) return GRAPH_LIMIT_DEFAULT;
  return Math.min(GRAPH_LIMIT_MAX, Math.max(1, Math.floor(n)));
}

/** 字段分隔符（`%x1f`，US 控制字符）：提交主题里不会出现，比 `|` 安全。 */
const FIELD = "\x1f";

export const graphArgv = {
  /** 视觉用：原样输出，别自己画泳道。 */
  log: (limit: number) => ["log", "--graph", "--oneline", "--decorate", "--all", "-n", String(limit)],
  commits: (limit: number) => [
    "log",
    "--all",
    "-n",
    String(limit),
    `--format=%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%cI${FIELD}%s${FIELD}%D`,
  ],
  branches: () => [
    "for-each-ref",
    "refs/heads",
    `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(upstream:short)`,
  ],
  worktrees: () => ["worktree", "list", "--porcelain"],
};

/** `--decorate` 的 `%D` → refs：`HEAD -> main` 只留 `main`，其余（分支/远程/tag）原样。 */
export function decorateToRefs(decorate: string): string[] {
  return decorate
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => (part.startsWith("HEAD -> ") ? part.slice("HEAD -> ".length) : part));
}

export function parseCommits(stdout: string): GraphCommit[] {
  const out: GraphCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, short, parents, author, at, subject, refs] = line.split(FIELD);
    if (!sha || !at) continue;
    out.push({
      sha,
      short: short ?? "",
      parents: (parents ?? "").split(" ").filter((p) => p !== ""),
      author: author ?? "",
      at,
      subject: subject ?? "",
      refs: decorateToRefs(refs ?? ""),
    });
  }
  return out;
}

export function parseBranches(stdout: string): GraphBranch[] {
  const out: GraphBranch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name, head, upstream] = line.split(FIELD);
    if (!name || !head) continue;
    out.push({ name, head, ...(upstream ? { upstream } : {}) });
  }
  return out;
}

/**
 * `git worktree list --porcelain` 的块解析（只读实况）。
 * 每块形如：`worktree <path>` / `HEAD <sha>` / `branch refs/heads/x` **或** `detached`（后跟空行）。
 */
export function parseWorktreeList(stdout: string): GraphWorktree[] {
  const out: GraphWorktree[] = [];
  for (const block of stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const pathLine = lines.find((l) => l.startsWith("worktree "));
    const headLine = lines.find((l) => l.startsWith("HEAD "));
    if (!pathLine || !headLine) continue;
    const branchLine = lines.find((l) => l.startsWith("branch "));
    const branch = branchLine ? branchLine.slice("branch ".length).replace(/^refs\/heads\//, "") : null;
    out.push({
      path: normalizePath(pathLine.slice("worktree ".length).trim()),
      branch,
      head: headLine.slice("HEAD ".length).trim(),
      detached: branch === null,
    });
  }
  return out;
}

/**
 * 卡片↔worktree 映射：**先按路径（规范化后相等），再按分支名兜底**。
 * 只有「带 worktree 的卡片」参与；分支名重复时取第一张（路径精确匹配永远优先，不受此影响）。
 */
export function mapCardsToWorktrees(
  worktrees: GraphWorktree[],
  cards: readonly Card[],
): { worktrees: GraphWorktree[]; cards: GraphCardRef[] } {
  const withWorktree: GraphCardRef[] = cards.flatMap((card) =>
    card.worktree
      ? [
          {
            id: card.id,
            title: card.title,
            state: card.state,
            branch: card.worktree.branch,
            worktreePath: normalizePath(card.worktree.path),
          },
        ]
      : [],
  );

  const merged = worktrees.map((wt) => {
    const matched =
      withWorktree.find((c) => c.worktreePath === normalizePath(wt.path)) ??
      (wt.branch ? withWorktree.find((c) => c.branch === wt.branch) : undefined);
    if (!matched) return wt;
    return {
      ...wt,
      cardId: matched.id,
      cardTitle: matched.title,
      cardState: matched.state,
    };
  });

  return { worktrees: merged, cards: withWorktree };
}

/**
 * 读一个仓库的提交图。`repoPath` 是仓库根（项目登记的 `path`）。
 *
 * 空仓库（还没有任何提交）不算错：`graphText` 为空、commit/branch 为空，worktree 照常回。
 * 只有 **git 不可用**、或连 `worktree list` 都跑不动时才回 `GIT_FAILED`。
 */
export async function readGraph(
  repoPath: string,
  opts: { limit?: number; cards?: readonly Card[]; run?: Run } = {},
): Promise<ProjectGraphResult> {
  const run = opts.run ?? defaultRun;
  const root = normalizePath(repoPath);
  const limit = clampGraphLimit(opts.limit);
  const git = (args: string[]): Promise<RunOutcome> =>
    run("git", ["-C", root, ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });

  const [logOut, commitOut, branchOut, worktreeOut] = await Promise.all([
    git(graphArgv.log(limit)),
    git(graphArgv.commits(limit)),
    git(graphArgv.branches()),
    git(graphArgv.worktrees()),
  ]);

  if (logOut.missing) {
    return {
      ok: false,
      error: {
        code: "GIT_FAILED",
        message: `跑不动 git（${root}）：${firstLine(logOut.stderr)}`,
        hint: "仓库目录是否还在？git 是否装了？改好后刷新，或重新选项目",
      },
    };
  }
  // 是不是仓库，以 worktree list 为准：空仓库的 log 会失败，但这里照样能列。
  if (worktreeOut.missing || worktreeOut.code !== 0) {
    return {
      ok: false,
      error: {
        code: "GIT_FAILED",
        message: `${root} 读不出 worktree 实况：${firstLine(worktreeOut.stderr) || `退出码 ${worktreeOut.code}`}`,
        hint: "仓库被删/无权限？重新 flowcard project add <仓库路径>",
      },
    };
  }

  const mapped = mapCardsToWorktrees(parseWorktreeList(worktreeOut.stdout), opts.cards ?? []);
  return {
    ok: true,
    repoPath: root,
    limit,
    // 原样输出，只去掉结尾换行（前端直接等宽渲染）。
    graphText: logOut.stdout.replace(/\n+$/, ""),
    commits: commitOut.code === 0 ? parseCommits(commitOut.stdout) : [],
    branches: branchOut.code === 0 ? parseBranches(branchOut.stdout) : [],
    worktrees: mapped.worktrees,
    cards: mapped.cards,
  };
}
