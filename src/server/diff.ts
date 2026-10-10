/**
 * 卡片 diff（只读）：`git diff <baseSha>...<headSha>`（三点 = merge-base 语义），在仓库根跑。
 *
 *   1. **纯函数**：unified diff 的解析（文件/状态/hunk/行号）与摘要 —— 可单测；
 *   2. **薄 IO**：`readCardDiff` 只跑 `rev-parse` / `diff`，`run` 可注入（真实临时仓库即可）。
 *
 * 只读、且**不写文件**：没有 fetch/push/checkout，diff 只在内存里过。
 * base = 项目 defaultBranch（拿不到退 main/master），head = 卡片 worktree 的 HEAD（detached 用 sha）。
 *
 * 大 diff 不硬塞进响应：超过 `DIFF_MAX_BYTES`（1 MiB）就只保留**完整的**文件，并置 `truncated`。
 */
import { normalizePath } from "../shared/paths.ts";
import type {
  CardDiff,
  CardDiffResult,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffStatus,
  DiffSummary,
} from "../shared/types.ts";
import { defaultRun, firstLine, GIT_TIMEOUT_MS, type Run, type RunOutcome } from "./probe.ts";

/** 响应里 diff 的字节上限（超过就丢文件并置 truncated）。 */
export const DIFF_MAX_BYTES = 1_000_000;
/** hunk 上下文行数：够看就行，不给 git 默认值留伏笔。 */
export const DIFF_CONTEXT = 3;
/** base 分支的候选顺序：项目 defaultBranch → main → master（设计里就是这么退化的）。 */
export const BASE_BRANCH_FALLBACKS = ["main", "master"] as const;

export const diffArgv = {
  head: () => ["rev-parse", "HEAD"],
  /** `--abbrev-ref HEAD` 在 detached 时回 "HEAD"（那不是分支名，宁可不用）。 */
  headName: () => ["rev-parse", "--abbrev-ref", "HEAD"],
  /** `--verify --quiet`：ref 不存在时静默失败，正好用来逐个试候选。 */
  verify: (ref: string) => ["rev-parse", "--verify", "--quiet", ref],
  patch: (baseSha: string, headSha: string) => [
    "diff",
    "--patch",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    `--unified=${DIFF_CONTEXT}`,
    `${baseSha}...${headSha}`,
  ],
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * `diff --git a/x b/y` → 两侧路径。**二进制文件没有 `---`/`+++` 行**，路径只能从这里取；
 * 路径含空格/特殊字符时 git 会加引号（`"a/my file.txt" "b/my file.txt"`），所以两段要按引号切。
 */
function diffGitPaths(line: string): { oldPath: string | null; newPath: string | null } {
  const rest = line.slice("diff --git ".length);
  const quoted = /^"(.+)" "(.+)"$/.exec(rest);
  if (quoted) return { oldPath: diffPath(quoted[1]!), newPath: diffPath(quoted[2]!) };
  const parts = rest.split(" ");
  if (parts.length < 2) return { oldPath: null, newPath: null };
  return { oldPath: diffPath(parts[0]!), newPath: diffPath(parts[1]!) };
}

/**
 * `--- a/x` / `+++ b/y` 的字段 → 仓库内路径；`/dev/null` → null（新增/删除）。
 * 路径带空格时 git 会加引号：这里只去引号，不做完整反转义（够看板显示，不猜怪字符）。
 */
function diffPath(field: string): string | null {
  let path = field.trim();
  if (path === "" || path === "/dev/null") return null;
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  return path.replace(/^[ab]\//, "");
}

type FileFlags = {
  oldSide: string | null;
  newSide: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  binary: boolean;
  added: boolean;
  deleted: boolean;
};

const blankFlags = (): FileFlags => ({
  oldSide: null,
  newSide: null,
  renameFrom: null,
  renameTo: null,
  binary: false,
  added: false,
  deleted: false,
});

/**
 * 解析 unified diff。行体**按 hunk 头声明的两侧行数**吃到底
 * （context 同时算旧/新各一行，所以行体条数 = oldLines + newLines − context 条数，
 * 不能简单相加）—— 这样 `\ No newline at end of file`、空行、夹在中间的任何东西都不会把行号算歪。
 *
 * 状态判定优先级：**binary > renamed > added > deleted > modified**（binary 一个文件只有一格）。
 * 返回的 `sizes[i]` 是第 i 个文件在原始文本里占的字节数（截断时按它挑完整的文件）。
 * `complete` = 所有 hunk 的两侧行数都吃满了（否则说明输出被 maxBuffer 截断，最后一个文件不可信）。
 */
export function parseUnifiedDiff(text: string): {
  files: DiffFile[];
  sizes: number[];
  complete: boolean;
} {
  const files: DiffFile[] = [];
  const sizes: number[] = [];
  let current: DiffFile | null = null;
  let flags = blankFlags();
  let size = 0;
  let hunk: DiffHunk | null = null;
  /** 当前 hunk 还没吃到的旧/新侧行数，两侧都归零才算这个 hunk 吃完。 */
  let oldLeft = 0;
  let newLeft = 0;
  let oldLine = 0;
  let newLine = 0;
  let incomplete = false;

  const flush = (): void => {
    if (!current) return;
    const renamed = flags.renameFrom !== null || flags.renameTo !== null;
    const path = flags.renameTo ?? flags.newSide ?? flags.renameFrom ?? flags.oldSide ?? "";
    const status: DiffStatus = flags.binary
      ? "binary"
      : renamed
        ? "renamed"
        : flags.added
          ? "added"
          : flags.deleted
            ? "deleted"
            : "modified";
    const oldPath = renamed ? (flags.renameFrom ?? path) : null;
    current.path = path;
    current.status = status;
    if (oldPath !== null && oldPath !== path) current.oldPath = oldPath;
    files.push(current);
    sizes.push(size);
    current = null;
  };

  for (const raw of text.split("\n")) {
    size += Buffer.byteLength(raw, "utf8") + 1;

    if (raw.startsWith("diff --git ")) {
      // 上一个文件还有没吃完的 hunk → 输出被截断了，别装作完整。
      if (oldLeft > 0 || newLeft > 0) incomplete = true;
      flush();
      current = { path: "", status: "modified", additions: 0, deletions: 0, hunks: [] };
      flags = blankFlags();
      // 头部先给一对路径兜底：二进制文件没有 ---/+++ 行，只有这里有路径。
      const paths = diffGitPaths(raw);
      flags.oldSide = paths.oldPath;
      flags.newSide = paths.newPath;
      size = Buffer.byteLength(raw, "utf8") + 1;
      hunk = null;
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (!current) continue;

    if (hunk !== null && (oldLeft > 0 || newLeft > 0)) {
      // `\ No newline at end of file` 是标记不是行：不占行数、也不算进增删。
      if (raw.startsWith("\\")) continue;
      const marker = raw.slice(0, 1);
      const kind: DiffLine["kind"] = marker === "+" ? "add" : marker === "-" ? "del" : "context";
      const body = raw.slice(1);
      let line: DiffLine;
      if (kind === "add") {
        current.additions += 1;
        newLeft -= 1;
        line = { kind, newLine: newLine++, text: body };
      } else if (kind === "del") {
        current.deletions += 1;
        oldLeft -= 1;
        line = { kind, oldLine: oldLine++, text: body };
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        line = { kind, oldLine: oldLine++, newLine: newLine++, text: body };
      }
      hunk.lines.push(line);
      if (oldLeft <= 0 && newLeft <= 0) hunk = null;
      continue;
    }

    const headerMatch = HUNK_HEADER.exec(raw);
    if (headerMatch) {
      const oldLines = headerMatch[2] === undefined ? 1 : Number(headerMatch[2]);
      const newLines = headerMatch[4] === undefined ? 1 : Number(headerMatch[4]);
      oldLine = Number(headerMatch[1]);
      newLine = Number(headerMatch[3]);
      hunk = {
        oldStart: oldLine,
        oldLines,
        newStart: newLine,
        newLines,
        header: (headerMatch[5] ?? "").trim(),
        lines: [],
      };
      current.hunks.push(hunk);
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }

    if (raw.startsWith("new file mode")) flags.added = true;
    else if (raw.startsWith("deleted file mode")) flags.deleted = true;
    else if (raw.startsWith("rename from ")) flags.renameFrom = diffPath(raw.slice("rename from ".length));
    else if (raw.startsWith("rename to ")) flags.renameTo = diffPath(raw.slice("rename to ".length));
    else if (raw.startsWith("copy from ")) flags.renameFrom = diffPath(raw.slice("copy from ".length));
    else if (raw.startsWith("copy to ")) flags.renameTo = diffPath(raw.slice("copy to ".length));
    else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) flags.binary = true;
    else if (raw.startsWith("--- ")) {
      const path = diffPath(raw.slice(4));
      if (path === null) flags.added = true;
      else flags.oldSide = path;
    } else if (raw.startsWith("+++ ")) {
      const path = diffPath(raw.slice(4));
      if (path === null) flags.deleted = true;
      else flags.newSide = path;
    }
  }

  if (oldLeft > 0 || newLeft > 0) incomplete = true;
  flush();
  return { files, sizes, complete: !incomplete };
}

/** 默认打的摘要：文件级 + hunk 头，**不含行体**（行体是看板的事，CLI 不用喷一屏）。 */
export function summarizeDiff(diff: CardDiff): DiffSummary {
  return {
    ok: true,
    base: diff.base,
    head: diff.head,
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    // 摘要是文件级的：不带 hunks（只有行数的壳子没有用，要看内容用 --patch 或完整响应）
    files: diff.files.map(({ hunks: _hunks, ...file }) => file),
    ...(diff.truncated ? { truncated: true } : {}),
    ...(diff.truncatedReason ? { truncatedReason: diff.truncatedReason } : {}),
  };
}

const fail = (code: string, message: string, hint?: string): { ok: false; error: { code: string; message: string; hint?: string } } => ({
  ok: false,
  error: { code, message, ...(hint ? { hint } : {}) },
});

/**
 * 读一张卡片的 diff。
 *
 * `repoPath` = 仓库根（跑 diff 的地方）；`headDir` = 卡片 worktree（取 HEAD/分支名的地方）。
 * 卡片**没有 worktree** 的判定在 HTTP 层（它才知道卡片），这里只管 git 侧的结果：
 * `NO_BASE`（找不到基准分支）/ `GIT_FAILED`。
 */
export async function readCardDiff(input: {
  repoPath: string;
  headDir: string;
  defaultBranch?: string;
  run?: Run;
  /** 覆盖字节阈值（测试用小值造 truncated） */
  maxBytes?: number;
  /** `?patch=1`：把 git 的原始 unified diff 也带上（同样受阈值约束） */
  includePatch?: boolean;
}): Promise<CardDiffResult> {
  const run = input.run ?? defaultRun;
  const root = normalizePath(input.repoPath);
  const headDir = normalizePath(input.headDir);
  const maxBytes = input.maxBytes ?? DIFF_MAX_BYTES;
  const gitIn = (dir: string) => (args: string[]): Promise<RunOutcome> =>
    run("git", ["-C", dir, ...args], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });

  const headOut = await gitIn(headDir)(diffArgv.head());
  const headSha = headOut.code === 0 ? firstLine(headOut.stdout) : "";
  if (headOut.missing || headSha === "") {
    return fail(
      "GIT_FAILED",
      `${headDir} 读不出 HEAD：${firstLine(headOut.stderr) || `退出码 ${headOut.code}`}`,
      "卡片的 worktree 还在吗？（`git worktree list` 看一眼）",
    );
  }
  const nameOut = await gitIn(headDir)(diffArgv.headName());
  const rawName = nameOut.code === 0 ? firstLine(nameOut.stdout) : "";
  // detached HEAD 回 "HEAD" —— 那不是分支名，直接用 sha 标 head。
  const head = rawName === "" || rawName === "HEAD" ? headSha : rawName;

  // base：项目 defaultBranch 优先，拿不到退 main/master；本地分支优先，其次 origin 的远程跟踪分支。
  const candidates = [...new Set([input.defaultBranch ?? "", ...BASE_BRANCH_FALLBACKS])].filter(
    (name) => name !== "",
  );
  let base = "";
  let baseSha = "";
  for (const candidate of candidates) {
    for (const ref of [`refs/heads/${candidate}`, `refs/remotes/origin/${candidate}`, candidate]) {
      const out = await gitIn(root)(diffArgv.verify(ref));
      const sha = out.code === 0 ? firstLine(out.stdout) : "";
      if (sha !== "") {
        base = candidate;
        baseSha = sha;
        break;
      }
    }
    if (baseSha !== "") break;
  }
  if (baseSha === "") {
    return fail(
      "NO_BASE",
      `${root} 里找不到基准分支（试过 ${candidates.join(" / ")}）`,
      "给项目一个 defaultBranch（origin/HEAD 或本地 main/master）就能算出 base",
    );
  }

  const patchOut = await gitIn(root)(diffArgv.patch(baseSha, headSha));
  if (patchOut.missing || patchOut.code !== 0) {
    return fail(
      "GIT_FAILED",
      `git diff ${baseSha.slice(0, 10)}...${headSha.slice(0, 10)} 失败：${firstLine(patchOut.stderr) || `退出码 ${patchOut.code}`}`,
    );
  }

  const parsed = parseUnifiedDiff(patchOut.stdout);
  let files = parsed.files;
  let sizes = parsed.sizes;
  let truncated = false;
  let truncatedReason = "";

  // 输出本身就被 maxBuffer 截了（或最后一个 hunk 没吃满）→ 最后一个文件不可信，丢掉。
  const bufferCut = /maxbuffer/i.test(patchOut.stderr);
  if (bufferCut || !parsed.complete) {
    truncated = true;
    if (files.length > 1) {
      files = files.slice(0, -1);
      sizes = sizes.slice(0, -1);
      truncatedReason = "git 输出被截断：最后一个文件不完整，已丢掉";
    } else {
      // 只有一个文件也不完整：留着（有总比没有强），但要说明计数可能偏小。
      truncatedReason = "git 输出被截断：文件不完整，增删计数可能偏小";
    }
  }

  const totalBytes = sizes.reduce((sum, n) => sum + n, 0);
  if (totalBytes > maxBytes) {
    let kept = 0;
    let acc = 0;
    for (const n of sizes) {
      if (acc + n > maxBytes) break;
      acc += n;
      kept += 1;
    }
    const dropped = files.length - kept;
    files = files.slice(0, kept);
    truncated = true;
    truncatedReason = `${truncatedReason === "" ? "" : `${truncatedReason}；`}diff ${totalBytes} 字节超过阈值 ${maxBytes}：只保留前 ${kept} 个文件，丢掉 ${dropped} 个`;
  }

  const diff: CardDiff = {
    base,
    head,
    baseSha,
    headSha,
    files,
    ...(truncated ? { truncated: true } : {}),
    ...(truncatedReason !== "" ? { truncatedReason } : {}),
  };

  if (input.includePatch) {
    // 原始 patch 同样受阈值约束：宁可截成半截，也不把几十 MB 塞进响应。
    const raw = patchOut.stdout;
    const cut = Buffer.byteLength(raw, "utf8") > maxBytes;
    diff.patch = cut ? raw.slice(0, maxBytes) : raw;
    if (cut) {
      diff.truncated = true;
      diff.truncatedReason = `${diff.truncatedReason ?? ""}${diff.truncatedReason ? "；" : ""}patch 文本按 ${maxBytes} 字节截断`;
    }
  }

  return { ok: true, ...diff };
}
