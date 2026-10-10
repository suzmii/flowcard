/**
 * **阶段（看板的列）**：从事实**派生**出来的视图 —— 不是新状态机。
 *
 * 这里只有两样东西：
 *   1. `STAGE_RULES`：一张**有顺序**的判据表（第一条命中即定列），
 *   2. `deriveStage(card, git)`：按这张表判一次的纯函数（无 IO、无时间、无随机）。
 *
 * 关键约定（改判据时必读）：
 * - **卡片状态（`Card.state`，见 `types.ts`）仍然是唯一的流程状态**；阶段只是它的一个投影。
 *   `dropped/done/blocked/merged/review` 这些列的名字恰好与状态同名，是因为状态本身就是事实；
 *   其余列（PR 待审 / 待开 PR / 实施中 / 待立项）由**引用与 git 实况**推出，卡片状态一点没变。
 * - 所以：**不要**为了多分列去加状态、加事件、加命令。分列变多只该改这张表。
 * - **判据表的顺序 = 匹配优先级**（第一条命中即定列，异常/终态必须排在前面，否则会被
 *   后面的宽判据吃掉）；**与列的显示顺序无关**。显示顺序见 `STAGES`。
 *
 * git 事实（`CardGitFacts`）是**可选**输入：
 * - 给不了（没 worktree / 刚起服务还没采集 / 探测失败）→ 传 `null`，对应判据**不成立**（不猜）；
 *   只剩「卡片上写得明明白白的事实」能定列（状态、会话、PR、验收时间）。
 * - 给了但**某一项是 `null`** → 只有那一项未知，其它项照常用。
 */
import type { Card } from "./types.ts";

// ---------------------------------------------------------------- git 事实

/**
 * 一张卡的 git 实况（**只读探测**的结果，采集与缓存见 `server/card-git.ts`）。
 * 每项都可能为 `null`：`null` = **未知**（不是 0）。
 */
export type CardGitFacts = {
  /** `git status --porcelain` 的改动文件数（含未跟踪）。 */
  dirtyFiles: number | null;
  /** `git rev-list --count <base>..HEAD`：相对基线的提交数。 */
  commitsSinceBase: number | null;
  /** 实际用的基线 ref（upstream 或 origin/HEAD）。 */
  baseBranch: string | null;
};

// ---------------------------------------------------------------- 列（阶段）

/**
 * 列的集合与**显示顺序** —— 看板从左到右就是这个顺序：**按活儿往前推进的方向排**
 * （待立项 → … → 完成），异常态（阻塞 / 放弃）排在最后。
 *
 * ⚠️ 这**不是**判据的匹配优先级（那个见 `STAGE_RULES`，异常/终态必须排在前面才不会被
 * 宽判据吃掉）。两处顺序互相独立：改显示顺序只动这里，改匹配优先级只动那张表。
 *
 * 注意：这九个 id 是**派生用的键**，不是 `Card.state` 的取值（虽然有些名字重合）。
 */
export const STAGES = [
  "backlog",
  "working",
  "prTodo",
  "prReview",
  "review",
  "merged",
  "done",
  "blocked",
  "dropped",
] as const;

export type Stage = (typeof STAGES)[number];

/** 列头中文名（`Record<Stage, …>` 保证每列都有；顺序由 `test/stage.test.ts` 钉住）。 */
export const STAGE_LABELS: Record<Stage, string> = {
  dropped: "放弃",
  done: "完成",
  blocked: "阻塞",
  merged: "已合并待清理",
  review: "待你验收",
  prReview: "PR 待审 / 等 CI",
  prTodo: "待开 PR",
  working: "实施中",
  backlog: "待立项",
};

/** 空列文案（每列一句，免得九个列头都写「暂无卡片」）。 */
export const STAGE_EMPTY_HINTS: Record<Stage, string> = {
  dropped: "没有放弃的卡",
  done: "还没有完成的卡",
  blocked: "没有阻塞的卡",
  merged: "没有待清理的卡",
  review: "没有等待验收的卡",
  prReview: "没有待审的 PR",
  prTodo: "没有待开 PR 的卡",
  working: "没有实施中的卡",
  backlog: "没有待立项的卡",
};

/** 判不出任何一条判据时的落点（= 判据表最后一条的 stage；**与显示顺序无关**）。 */
export const STAGE_FALLBACK: Stage = "backlog";

// ---------------------------------------------------------------- 判据

/**
 * 判据能看到的**外部事实**（卡片自身事实之外的东西）。目前只有 git。
 *
 * 以后要加第三种事实来源（例如 AI 步骤回执 / P2 步骤协议）时：**在这里加一个字段**，
 * 判据本身与所有调用方（server / CLI / web）的签名都不用动。
 */
export type StageFacts = {
  /** 这张卡对应 worktree 的 git 实况；没采集到 / 没 worktree = `null`。 */
  git: CardGitFacts | null;
};

/** 一条判据：`match` 为真 → 这张卡进 `stage` 这一列。 */
export type StageRule = {
  stage: Stage;
  /** 人话判据（文档/调试用；真实判定只认 `match`）。 */
  when: string;
  match: (card: Card, facts: StageFacts | null) => boolean;
};

/**
 * 判据表：**按顺序取第一条命中**（顺序 = 匹配优先级，异常/终态在前）。
 * 改分列/改判据只改这张表；**显示顺序**在 `STAGES`，两者互不影响。
 * 每条的 `when` 是给人和文档看的一句话；判定逻辑只认 `match`。
 */
export const STAGE_RULES: readonly StageRule[] = [
  {
    stage: "dropped",
    when: "卡片状态是 dropped（放弃）",
    match: (card) => card.state === "dropped",
  },
  {
    stage: "done",
    when: "卡片状态是 done（现场已清理）",
    match: (card) => card.state === "done",
  },
  {
    stage: "blocked",
    when: "卡片状态是 blocked（徽标显示 blockedReason）",
    match: (card) => card.state === "blocked",
  },
  {
    stage: "merged",
    when: "状态 merged，或 PR 已 merged 且已验收（acceptedAt）",
    match: (card) => card.state === "merged" || (card.pr?.state === "merged" && card.acceptedAt !== undefined),
  },
  {
    stage: "review",
    when: "状态 review；或会话已 ended/lost 而还没验收（acceptedAt 空）",
    match: (card) => {
      // 会话「交回来了」= ended 或 lost（卡片事实，不依赖 git）。
      const handedBack = card.session?.state === "ended" || card.session?.state === "lost";
      return card.state === "review" || (handedBack && card.acceptedAt === undefined);
    },
  },
  {
    stage: "prReview",
    when: "有 PR 且还没 merged（CI 状态来自同步，作徽标）",
    match: (card) => card.pr !== null && card.pr.state !== "merged",
  },
  {
    stage: "prTodo",
    when: "还没有 PR，但已经有提交（commitsSinceBase > 0）",
    // 提交数必须**确实读到**：未知（null）不算有 —— 不猜。
    match: (card, facts) => card.pr === null && (facts?.git?.commitsSinceBase ?? 0) > 0,
  },
  {
    stage: "working",
    when: "有会话（含失联），且不能证明它什么都没干（脏文件或提交）",
    match: (card, facts) => {
      const git = facts?.git ?? null;
      // 只有「读到了脏文件 0 且提交数 0」才算证明什么都没干；任何一项未知（含整块 git 事实缺失）都不算。
      const nothingDone = git !== null && git.dirtyFiles === 0 && git.commitsSinceBase === 0;
      return card.session !== null && !nothingDone;
    },
  },
  {
    stage: STAGE_FALLBACK,
    when: "其余：没有会话、没有改动、没有 PR",
    match: () => true,
  },
];

/**
 * 派生阶段：按 `STAGE_RULES` 取第一条命中的列。
 * `facts` 缺省/为 `null` = 没有任何外部事实 → 判据退化成只看卡片事实（不猜）。
 */
export function deriveStage(card: Card, facts: StageFacts | null = null): Stage {
  for (const rule of STAGE_RULES) {
    if (rule.match(card, facts)) return rule.stage;
  }
  return STAGE_FALLBACK;
}

// ---------------------------------------------------------------- 出口投影

/**
 * 接口出口的卡片：原卡片 + 派生阶段 +（若有）git 事实。
 * `stage` 与 `git` 都是**加出来的只读投影**，不改 `Card` 本身（老客户端解析不受影响）。
 */
export type StagedCard = Card & { stage: Stage; git?: CardGitFacts };

/** 组装出口投影：`git` 为 `null` 时**不带**这个字段（「若有」，不写假值）。 */
export function withStage(card: Card, git: CardGitFacts | null): StagedCard {
  const stage = deriveStage(card, git ? { git } : null);
  return git ? { ...card, stage, git } : { ...card, stage };
}
