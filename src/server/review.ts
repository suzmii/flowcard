/**
 * 代码评审的**纯规则**：排序、outdated 判定、锚点/编号推导。
 *
 * 评审是本地事实（走事件流），所以这里不碰 IO、不碰 git：
 *   投影（project.ts）拿这些函数算 `card.review`，引擎/CLI/看板都读同一份规则。
 *
 * **head 的事实来源**：一张卡最近一次 `push.recorded` 的 sha。
 * 推送就是「HEAD 往前走了」这件事的唯一记录（`flowcard push <card> --sha <sha>`），
 * 所以不需要额外的 head 事件；一次都没推送时 head 未知，`outdated` 一律 false。
 */
import type { Card, ReviewComment, ReviewSide } from "../shared/types.ts";

/**
 * 当前 head sha：**最后一次推送的 sha**；没有任何推送记录 → undefined（未知）。
 * 这是 frozen 约定（不是"随便取一个 sha"），所以单独给个名字，免得三处各写各的。
 */
export function headShaOf(card: Card): string | undefined {
  return card.pushes.length > 0 ? card.pushes[card.pushes.length - 1]!.sha : undefined;
}

/**
 * 一条注释是否已经过期：只认「有 head 且 sha 不一致」。
 * head 未知时返回 false —— 报"过期"是给人看的判断，宁可不说也不冤枉。
 */
export function isOutdated(sha: string, headSha: string | undefined): boolean {
  return headSha !== undefined && sha !== headSha;
}

/** 按当前 head 重算一组注释的 `outdated`（head 变化时投影重跑一次）。纯函数，不改原数组。 */
export function markOutdated(comments: ReviewComment[], headSha: string | undefined): ReviewComment[] {
  return comments.map((comment) => {
    const outdated = isOutdated(comment.sha, headSha);
    return comment.outdated === outdated ? comment : { ...comment, outdated };
  });
}

/**
 * 注释排序键：**锚点在前、时间在后** —— 同一 `(sha, path, line, side)` 的多条必然按时间先后排。
 * 跨文件按路径排，看板/CLI 读出来就是"按文件分组"的样子；`id` 兜底保证全序稳定。
 */
export function compareReviewComments(a: ReviewComment, b: ReviewComment): number {
  return (
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.side.localeCompare(b.side) ||
    a.at.localeCompare(b.at) ||
    a.id.localeCompare(b.id)
  );
}

/** 卡片内注释 id 自增（"rc1"…）：按已有注释的最大编号推导，不额外维护计数器。 */
export function nextReviewCommentId(comments: ReviewComment[]): string {
  let max = 0;
  for (const comment of comments) {
    const matched = /^rc(\d+)$/.exec(comment.id);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `rc${max + 1}`;
}

/** 注释锚点的人话形式（命令回执里提示"评的是哪一行"）。 */
export function reviewAnchor(input: {
  sha: string;
  path: string;
  line: number;
  side: ReviewSide;
}): string {
  const short = input.sha.length > 10 ? input.sha.slice(0, 10) : input.sha;
  return `${input.path}:${input.line}@${input.side}(${short})`;
}
