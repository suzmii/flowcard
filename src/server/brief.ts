/**
 * 开工提示（brief）：把"这张卡的现状 + 接下来该做什么"写成一段 markdown，
 * 由启动会话时通过 `--append-system-prompt` 注入，让 AI 一睁眼就知道自己是谁、要干什么。
 *
 * 纯函数：只吃 card/project/worktree，输出文本；便于单测与复用（CLI/UI 也能拿它做预览）。
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Card, CardState, Project } from "../shared/types.ts";
import { STATE_LABELS } from "../shared/types.ts";

export type BriefInput = {
  card: Card;
  project?: Project | undefined;
  /** 卡片已被自动建好的 worktree（由 autostart 传进来，比 card.worktree 更"当下"）。 */
  worktree?: { path: string; branch: string } | undefined;
  /** flowcard CLI 的调用前缀（默认 `flowcard`）。 */
  cli?: string | undefined;
};

function line(ok: boolean, text: string): string {
  return `- ${ok ? "✅" : "⬜"} ${text}`;
}

/** 按卡片现状生成"接下来要做的步骤"。已完成的步骤也要列出（用 ✅ 标出）。 */
function steps(card: Card, cli: string, worktree: { path: string; branch: string } | undefined): string[] {
  const out: string[] = [];
  const wt = worktree ?? card.worktree ?? undefined;

  out.push(
    wt
      ? line(true, `worktree 已就绪：\`${wt.path}\`（分支 \`${wt.branch}\`）——**你就在里面干活，别切到主仓库**`)
      : line(
          false,
          [
            "**先建 worktree，名字由你起**：目录名与分支名都按这次要干的事取（分支前缀看改动性质——feat / fix / chore / docs / refactor…，跟本仓库惯例走）：",
            "  ```bash",
            "  git worktree add .worktrees/<你起的名字> -b <前缀>/<你起的名字>",
            `  ${cli} worktree ${card.id} --path .worktrees/<你起的名字> --branch <前缀>/<你起的名字>   # 登记到卡片（不登记我认不出这张卡）`,
            "  ```",
            "  然后**把当前会话移进去**（omp：`/wt <分支>` 或 `/move <路径>`），再开始改文件——",
            "  **在主仓库里改文件不算开工**（卡片进不了「实施中」）；建完登记后心跳会自动把会话认到这张卡上。",
          ].join("\n"),
        ),
  );

  out.push(
    card.issue
      ? line(
          true,
          `Issue 已绑：#${card.issue.number} ${card.issue.url}（干活前先读它，别自己另开一个）`,
        )
      : line(
          false,
          `绑上对应的 Issue（**只填编号**）：\`${cli} issue ${card.id} --number <编号>\`；确实没有就跳过，并在评论里写清为什么没有`,
        ),
  );

  out.push(
    card.pr
      ? line(true, `WIP PR 已绑：#${card.pr.number} ${card.pr.url}（状态 ${card.pr.state}）`)
      : line(
          false,
          `开 WIP PR（**任务一开始就开**）：推分支后 \`${cli} pr ${card.id} --number <编号> --url <链接> --branch <分支>\``,
        ),
  );

  out.push(
    card.pushes.length > 0
      ? line(true, `已有 ${card.pushes.length} 条推送记录（最新 ${card.pushes.at(-1)?.sha.slice(0, 8) ?? ""}）`)
      : line(
          false,
          `推进度要留痕：推送后 \`${cli} push ${card.id} --sha <sha>\`（以后每次 push 都记一条）`,
        ),
  );

  out.push(line(Boolean(card.acceptedAt), "验收与清理由人来做——你只负责把交付要件备齐，然后交回"));

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

  const where = [
    project ? `项目：\`${project.name}\`（${project.path}${project.defaultBranch ? `，默认分支 ${project.defaultBranch}` : ""}）` : null,
    worktree ? `worktree：\`${worktree.path}\`（分支 \`${worktree.branch}\`）` : null,
  ]
    .filter((x): x is string => x !== null)
    .join("\n");

  const remote = project?.remote ? `\n远端：${project.remote}` : "";

  return `# 你是 flowcard 卡片 ${card.id} 的会话

${where}${remote}

**卡片标题**：${card.title}
**当前状态**：${STATE_LABELS[card.state as CardState] ?? card.state}
**正文（你的需求原文）**：

${card.body.trim() === "" ? "（空）" : card.body.trim()}

## 六项交付要件

${checklist(card).join("\n")}

## 接下来你要做的

${steps(card, cli, worktree).join("\n")}

## 铁律（违反会被拦或回滚）

1. **远程写要人批，一事一议**：push / 开 PR / 合并 / 远程评论之前先
   \`${cli} confirm ${card.id} --request --for push --detail "git push -u origin <分支>"\`，
   人批了再执行，执行完 \`${cli} confirm ${card.id} --consume <id>\`；被驳回就停下问人，别换个说法再申请。
2. **会话必须待在 worktree 里**（cwd 不在 worktree 内就不算开工）；omp 用 \`/wt\` 或 \`/move\` 切，别在主仓库改文件。
3. **验收、清理只能人点**：\`flowcard accept\` / 清理门禁 G4 不是你能代做的；PR 合并前不要拆任何复现环境。
4. 缺东西时命令会回**退出码 4**，那不是报错：照 JSON 里 \`blocked.missing\` 补齐再重试；同一缺项连拦两次就停下来问人。

## 常用命令

\`\`\`bash
${cli} show ${card.id}                          # 看当前状态（缺什么它会说）
${cli} comment ${card.id} --body "进展/结论"     # 留痕
${cli} diff ${card.id}                          # 看自己的改动
${cli} end ${card.id} --summary "做完什么"        # 交回（自动进待验收）
${cli} block ${card.id} --reason "缺什么"         # 卡住了就明说
\`\`\`
`;
}

/** 内容不变就不重写（避免每次都改 mtime）。 */
export async function writeBriefFile(
  filePath: string,
  text: string,
  io: { readFile?: (p: string) => Promise<string>; writeFile?: (p: string, t: string) => Promise<void> } = {},
): Promise<{ written: boolean }> {
  const read = io.readFile ?? ((p: string) => readFile(p, "utf8"));
  const write = io.writeFile ?? ((p: string, t: string) => writeFile(p, t, "utf8"));
  const existing = await read(filePath).catch(() => null);
  if (existing === text) return { written: false };
  await write(filePath, text);
  return { written: true };
}
