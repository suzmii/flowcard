/**
 * 开工提示（brief）：把"这张卡的现状 + 还缺什么"写成一段 markdown，落在
 * `<dataDir>/briefs/<card>.md`；起会话时只发**一句话**让 agent 自己 `read` 它
 * （不走 `--append-system-prompt`，不必每轮请求重发全文）。
 *
 * 只写**卡片特有的事实**：卡号/标题、当前状态、六项交付要件现状、☑︎ 待办清单、
 * 关键绝对路径（项目根 / worktree）、以及"会话没进 worktree 不算开工"这类**位置**约束。
 * 通用规矩（远程写要人批、退出码 4、验收/清理只能人点、常用命令清单…）由 skill
 * `~/.agents/skills/flowcard` 覆盖，这里**不重复**。
 *
 * 纯函数：只吃 card/project/worktree，输出文本；便于单测与复用（CLI/UI 也能拿它做预览）。
 *
 * **文案在哪**：本文件只负责"填值"，正文一字不落地躺在 `prompts/brief.md`（kickoff 在
 * `prompts/kickoff.md`）—— 改文案改那个文件即可，不用动代码、不用重启（见 `prompts/README.md`）。
 * 占位符清单在 `prompts/README.md`，渲染器是 `./prompts.ts`。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Card, CardState, Project } from "../shared/types.ts";
import { STATE_LABELS } from "../shared/types.ts";
import { renderPrompt } from "./prompts.ts";

export type BriefInput = {
  card: Card;
  project?: Project | undefined;
  /** 卡片已被自动建好的 worktree（由 autostart 传进来，比 card.worktree 更"当下"）。 */
  worktree?: { path: string; branch: string } | undefined;
  /** flowcard CLI 的调用前缀（默认 `flowcard`）。 */
  cli?: string | undefined;
};

function todo(ok: boolean, text: string): string {
  return `- ${ok ? "[x]" : "[ ]"} ${text}`;
}

/** 按"还缺哪个要件"生成待办：已完成的也列出来（`[x]`），一眼能看出还剩几件。 */
function todos(card: Card, cli: string, worktree: { path: string; branch: string } | undefined): string[] {
  const out: string[] = [];
  const wt = worktree ?? card.worktree ?? undefined;

  out.push(
    wt
      ? todo(true, `会话就待在 worktree 里干活：\`${wt.path}\`（分支 \`${wt.branch}\`）`)
      : todo(
          false,
          [
            "**先建 worktree，名字由你起**：目录名与分支名都按这次要干的事取（分支前缀看改动性质——feat / fix / chore / docs / refactor…，跟本仓库惯例走）：",
            "  ```bash",
            "  git worktree add .worktrees/<你起的名字> -b <前缀>/<你起的名字>",
            `  ${cli} worktree use ${card.id} --path .worktrees/<你起的名字>   # 登记 + 把会话搬进去（一步到位）`,
            "  ```",
            "  **斜杠命令你执行不了，别尝试 `/move`、`/wt`**：`worktree use` 会替你做——登记 worktree、停掉当前会话、",
            "  用新目录续接（还是同一条会话，历史都在），新会话起来后自己 claim，卡片随即进「实施中」。",
          ].join("\n"),
        ),
  );

  out.push(
    card.issue
      ? todo(true, `Issue 已绑：#${card.issue.number} ${card.issue.url}（干活前先读它，别自己另开一个）`)
      : todo(
          false,
          `绑上对应的 Issue（**只填编号**）：\`${cli} issue ${card.id} --number <编号>\`；确实没有就在评论里写清为什么没有`,
        ),
  );

  out.push(
    card.pr
      ? todo(true, `WIP PR 已绑：#${card.pr.number} ${card.pr.url}（状态 ${card.pr.state}）`)
      : todo(false, `开 WIP PR（**任务一开始就开**）：推分支后 \`${cli} pr ${card.id} --number <编号> --url <链接> --branch <分支>\``),
  );

  out.push(
    card.pushes.length > 0
      ? todo(true, `已有 ${card.pushes.length} 条推送记录（最新 ${card.pushes.at(-1)?.sha.slice(0, 8) ?? ""}）`)
      : todo(false, `推进度要留痕：推送后 \`${cli} push ${card.id} --sha <sha>\`（以后每次 push 都记一条）`),
  );

  out.push(
    todo(
      Boolean(card.acceptedAt),
      `要件备齐就交回：\`${cli} end ${card.id} --summary "做完什么"\` —— 剩下的验收与清理由人来做`,
    ),
  );

  return out;
}

/** 六项交付要件的当前值，一眼能看出缺什么。 */
function checklist(card: Card): string[] {
  const issue = card.issue ? `${card.issue.repo}#${card.issue.number}` : "未绑";
  const pr = card.pr ? `#${card.pr.number}（${card.pr.state}）` : "未绑";
  const wt = card.worktree ? `${card.worktree.path}（${card.worktree.branch}）` : "未绑";
  return [
    `| Issue | worktree | WIP PR | 推送 | 验收 | 清理 |`,
    `|---|---|---|---|---|---|`,
    `| ${issue} | ${wt} | ${pr} | ${card.pushes.length} 条 | ${
      card.acceptedAt ? "已验收" : "未验收"
    } | ${card.cleanedAt ? "已清理" : "未清理"} |`,
  ];
}

export function cardBrief(input: BriefInput): string {
  const { card } = input;
  const cli = input.cli ?? "flowcard";
  const project = input.project;
  const worktree = input.worktree ?? card.worktree ?? undefined;

  const paths = [
    project
      ? `- 项目根：\`${project.path}\`（${project.name}${project.defaultBranch ? `，默认分支 ${project.defaultBranch}` : ""}）`
      : null,
    worktree
      ? `- worktree：\`${worktree.path}\`（分支 \`${worktree.branch}\`）`
      : `- worktree：未绑（下面第一条待办就是建它）`,
    project?.remote ? `- 远端：${project.remote}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");

  return renderPrompt("brief.md", {
    cardId: card.id,
    title: card.title,
    state: STATE_LABELS[card.state as CardState] ?? card.state,
    body: card.body.trim() === "" ? "（空）" : card.body.trim(),
    paths,
    checklist: checklist(card).join("\n"),
    todos: todos(card, cli, worktree).join("\n"),
    cli,
  });
}

/** 内容不变就不重写（避免每次都改 mtime）。 */
export async function writeBriefFile(
  filePath: string,
  text: string,
  io: {
    readFile?: (p: string) => Promise<string>;
    writeFile?: (p: string, t: string) => Promise<void>;
    mkdir?: (p: string) => Promise<void>;
  } = {},
): Promise<{ written: boolean }> {
  const read = io.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write = io.writeFile ?? ((p: string, t: string) => writeFile(p, t, "utf8"));
  const existing = await read(filePath).catch(() => null);
  if (existing === text) return { written: false };
  // 目录可能还不存在（第一次写），自己建——不该让"开卡"因为一个 mkdir 失败而 500
  await (io.mkdir ?? ((p: string) => mkdir(p, { recursive: true })))(dirname(filePath));
  await write(filePath, text);
  return { written: true };
}

/** 写开工提示的可注入 IO（测试用）：只换"怎么落盘"，内容与路径的规则不变。 */
export type BriefWriteIo = { writeBrief?: typeof writeBriefFile };

/** 开工提示文件的落点：`<briefDir>/<cardId>.md`（`briefDir` 就是 `<dataDir>/briefs`）。 */
export function cardBriefPath(briefDir: string, cardId: string): string {
  return join(briefDir, `${cardId}.md`);
}

/**
 * 起会话时投的第一句 prompt（kickoff）：只说一句「先 `read` 那份提示，按待办走」——
 * 提示全文**不进 argv/系统提示**（见本文件头注释）。自动开工与手动起会话（新会话）用**同一句**。
 * 文案本体在 `prompts/kickoff.md`（`{{briefPath}}` / `{{cli}}`）。
 */
export function briefKickoff(file: string, cli = "flowcard"): string {
  return renderPrompt("kickoff.md", { briefPath: file, cli });
}

/**
 * 写开工提示（`cardBrief` 的全文 → `<briefDir>/<cardId>.md`），返回文件路径。
 *
 * 两个调用方，保证内容完全一致：自动开工（`autostart`，自己写）、`hosted-session` 的 `refreshBrief`
 * （手动起会话与搬 worktree 都经由它）。写不出去**不吞**——由调用方决定是报错还是静默。
 */
export async function writeCardBrief(input: {
  briefDir: string;
  card: Card;
  project?: Project | undefined;
  cli?: string | undefined;
  io?: BriefWriteIo | undefined;
}): Promise<string> {
  const { card } = input;
  const worktree = card.worktree;
  const text = cardBrief({
    card,
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(worktree === null ? {} : { worktree: { path: worktree.path, branch: worktree.branch } }),
    ...(input.cli === undefined ? {} : { cli: input.cli }),
  });
  const file = cardBriefPath(input.briefDir, card.id);
  await (input.io?.writeBrief ?? writeBriefFile)(file, text);
  return file;
}
