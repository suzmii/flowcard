# flowcard 发给 AI 的全部提示词（逐字，供人工优化）

> 生成方式：从源码**逐字提取**当前生效的文案（改文案请直接改源码里对应的那段）。
> 触发时机写在每节开头；改完跑 `npx vitest run`，有文案断言会用例告诉我哪里破了。

共 6 类：

| # | 提示词 | 位置 | 触发时机 | 体积 |
|---|---|---|---|---|
| 1 | **kickoff**（起会话第一条 prompt） | `src/server/brief.ts` `briefKickoff()` | 起会话（自动开工 / 手动 start 的**新会话**） | 一句话 |
| 2 | **brief 全文**（写成文件让 agent `read`） | `src/server/brief.ts` `cardBrief()` | 每次起会话/切 worktree 时刷新文件 | ~1.9KB |
| 3 | **skill**（模型指令文件，omp 自动加载） | `skills/flowcard/SKILL.md` | 每个会话常驻（软链 `~/.agents/skills/flowcard`） | ~7KB |
| 4 | **审批通知**（人批准/驳回后投给会话） | `src/server/notify-hooks.ts` `approvalNotice()` | 人在看板上做决定之后（异步、幂等、离线降级） | 每条约 100–300 字 |
| 5 | **自动开工写回卡片的评论** | `src/server/autostart.ts` | 自动开工时（成功/失败/异常） | 数行 |
| 6 | **CI 结束 / 新评论通知** | `src/server/notify-hooks.ts` `ciNotice()` / `commentNotice()` | 同步轮询发现状态变化时 | 每条约 150–300 字 |

---

## 1. kickoff（起会话第一条 prompt）

`src/server/brief.ts` `briefKickoff(file, cli="flowcard")`：

```ts
 * 起会话时投的第一句 prompt（kickoff）：只说一句「先 `read` 那份提示，按待办走」——
 * 提示全文**不进 argv/系统提示**（见本文件头注释）。自动开工与手动起会话（新会话）用**同一句**。
 */
export function briefKickoff(file: string, cli = "flowcard"): string {
  return `开工：第一步先 read \`${file}\`，按里面「☑︎ 接下来你要做的」逐步执行，每步用 \`${cli} comment\` 留痕。`;
}

```

**为什么这么短**：用户要求"提示词直接接一个 tool use，read brief 行不行，其他说明都省了" —— 全文进
`--append-system-prompt` 会**每轮请求重发 ~3KB**，所以改成一句话 + 让 agent 自己 `read`。

---

## 2. brief 全文（`<dataDir>/briefs/<card>.md`）

`src/server/brief.ts` `cardBrief()`：

```ts
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

  return `# 卡片 ${card.id}：${card.title}

**当前状态**：${STATE_LABELS[card.state as CardState] ?? card.state}

**正文（需求原文）**：

${card.body.trim() === "" ? "（空）" : card.body.trim()}

## 关键路径

${paths}

## 六项交付要件

${checklist(card).join("\n")}

## ☑︎ 接下来你要做的

${todos(card, cli, worktree).join("\n")}

**位置**：会话没进 worktree 就不算开工（在主仓库里改文件不算开工）—— 搬进去用
\`${cli} worktree use ${card.id} --path <worktree 路径>\`（停当前会话、用新目录续接同一条会话）。
`;
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

```

**只写卡片特有事实**；铁律/命令清单已删（`skill` 里都有，omp 自动加载）。

**生成清单行的两个函数**（brief 里那两节就是它们拼出来的，改文案也改这里）：

```ts
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
```

---

## 3. skill（模型指令文件）

`skills/flowcard/SKILL.md`（全文，逐字）：

```markdown
---
name: flowcard
description: 用 flowcard 工作台干活（一张卡 = 一次会话）。当你要开卡、绑 Issue/PR/worktree、启动/接续会话、推进卡片状态、做代码评审（diff/行级评论/判定）时用。CLI 是模型唯一的写入口。
---

# flowcard 是什么

个人工作台：**一张卡片 = 一次 agent 会话**。卡片上固定挂着六个"必要项目"——Issue、worktree、WIP PR、推送记录、验收、清理；**列只表示状态，不表示流程阶段**，状态由事实自动推进。

**人只做三件事**：远程写授权、验收、清理确认。其余全部由事实推进——你干活，状态自己走。

- 服务：`http://127.0.0.1:47825`（`FLOWCARD_URL` / `FLOWCARD_PORT` 可覆盖）
- CLI：`flowcard <命令> <card> [选项…]`，stdout 恒为一行 JSON
- 细节：`~/workspace/flowcard/docs/design.md`

# 干活的主线（就这四步）

```bash
flowcard open --body "需求正文（标题可省，服务端派生）"     # ① 开卡：直接落「待开工」
flowcard worktree <card> --path .worktrees/x --branch <前缀>/x   # ② 绑 worktree（前缀看改动性质）
cd .worktrees/x && omp -e ~/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
                                                          # ③ 在 worktree 里启动会话：
                                                          #    按 cwd 自动认卡 → 自动进「实施中」
flowcard issue <card> --number 742    # Issue 只填数字，repo/url 由项目基址拼出来
flowcard pr <card> --number 7 --url <链接> --branch <前缀>/x     # WIP PR（交付要件）
flowcard push <card> --sha <sha>      # 推送记录（进度要看得见）
flowcard end <card> --summary "做完什么"                       # ④ 交回 → 自动进「待验收」
```

- **不要**自己编造状态，也别把"卡片状态"当成需要你去推进的流程——你只负责产生事实（worktree/PR/推送/会话）。
- 会话必须是**在卡片的 worktree 里**跑的那个（`cwd` 不在 worktree 内会被拦）。
  **斜杠命令（`/wt`、`/move`）你执行不了**——要用 `flowcard worktree use <card> --path <worktree>`：
  它会绑 worktree 并把**当前这段会话**用新 cwd 续接（转录连续、卡片自动进「实施中」）。
- subagent 会话**不绑卡片**（一张卡只有一个主会话）；它们归 harness 自己管。

# 状态与门禁（只有这四条会拦你）

```
待开工 ──会话在 worktree 里起来──▶ 实施中 ──会话结束──▶ 待验收
待验收 ──人验收 + PR merged──▶ 已合并待清理 ──G4 人批清理──▶ 完成
任意未完成 ──drop──▶ 已放弃            缺前置 ──block──▶ 阻塞 ──unblock──▶ 实施中
```

| 转换 | 缺什么会被拦（退出码 4） |
|---|---|
| `待开工 → 实施中` | 卡片的 worktree、**会话 cwd 在 worktree 内** |
| `实施中 → 待验收` | 有 PR、至少一条推送记录 |
| `待验收 → 已合并` | 人已验收、PR 已 merged |
| `已合并 → 完成` | 清理已（经人批准 G4 后）执行 |

**退出码 4 不是报错**：事实已经落库，只是状态没前进；照着 JSON 的 `blocked.missing` 补齐再重试（同一缺项连拦两次就停下来问人，别硬试）。

# 远程写（一事一议）

```bash
flowcard confirm <card> --request --for push --detail "git push -u origin <分支>"
flowcard confirm <card> --list      # 只有 approved 且没用过的授权才能执行
flowcard confirm <card> --consume cf1   # 执行完回报：作废
```

一次批准**只覆盖那一条确切命令**；换命令（哪怕改一个字、换分支）都要重新申请；被驳回就停下问人。

# 代码评审（本地记录，不发远程）

```bash
flowcard diff <card> [--patch]
flowcard review <card> --comment --path a.ts --line 12 --side new --body "…"
flowcard review <card> --approve | --request-changes [--body "…"]
flowcard review <card> --list
```

`approve` 只是记录意见，**不改卡片状态**——验收仍然只能人点。

# 探测

```bash
flowcard detect <card>     # 从 cwd 反查 worktree/分支，只读读 PR 与 CI，把能拿到的回写卡片
flowcard probe <card> --number 7 --state merged …   # 汇报 PR 状态（merged 会推动状态）
```

# 什么时候必须停下来问人

- 需要**远程写授权**、**验收**（G3）、**清理批准**（G4）
- 同一缺项**连续两次**被拦（前提不成立，重试无用）
- 要动别人的分支/PR/Issue、要清理现场、要删数据
- **PR 合并前想拆复现环境**：一律先报告再等人点头

```

---

## 4. 审批通知（`approvalNotice()`）

`src/server/notify-hooks.ts`：

```ts
  }
}

/**
 * 一次审批决定 → 给 agent 的人话通知（纯函数）。
 *
 * 三件事必须都在：**决定**（通过还是驳回）、**理由**（有就带）、**下一步该做什么**。
 */
export function approvalNotice(spec: ApprovalSpec, card: Card): string {
  const reason = reasonLine(spec.reason);
  const approved = spec.decision === "approved";

  // —— G2 远程写确认：一次授权只覆盖一次动作，批的/驳的都是"这一件事"。
  if (spec.confirm) {
    const id = spec.confirm.id;
    const confirmation = card.confirmations.find((c) => c.id === id);
    const detail = confirmation?.detail.trim() ?? "";
    const action = confirmation?.action ?? "other";
    const what = detail === "" ? `${id}（${action}）` : `${id}（将执行：${detail}）`;
    const open = `【flowcard 审批通知】人${approved ? "批准" : "驳回"}了远程写授权 ${what}。`;
    if (approved) {
      return [
        open,
        reason,
        `下一步：现在可以执行它；执行完请 \`flowcard confirm ${card.id} --consume ${id}\` 作废这次授权（一次批准只覆盖一次动作，再写一次要重新申请）。`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    return [
      open,
      reason,
      `下一步：**不要执行**这次远程写。如果你仍然认为有必要，改 detail（写清将要执行的确切命令或 URL）后重新申请一次：\`flowcard confirm ${card.id} --request --for ${action} --detail "…"\`。`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 清理门禁（G4）：批的就是"可以拆现场了"。
  if (spec.gate && gateKind(spec, card) === "cleanup") {
    const name = gateName(spec, card);
    if (approved) {
      return [
        `【flowcard 审批通知】人已批准清理（${name}）。`,
        reason,
        card.cleanedAt
          ? "下一步：清理已经完成（卡片已「完成」）。"
          : `下一步：现在可以执行清理：\`flowcard cleanup ${card.id}\` 记账，然后把现场清掉（worktree / 分支 / 临时文件）—— 完成后卡片自动进「完成」。`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    return [
      `【flowcard 审批通知】人已驳回清理（${name}）。`,
      reason,
      `下一步：**不要拆现场**（worktree / 分支都留着）。如果你仍然认为有必要清理，把理由说清楚后重新提一次清单：\`flowcard cleanup ${card.id} --item "要删的东西"\`，等人再批一次。`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 不认识的流程门禁：说清决定与状态，不硬套"验收/清理"的说法。
  if (spec.gate && gateKind(spec, card) !== "review") {
    const name = gateName(spec, card);
    const open = `【flowcard 审批通知】人已${approved ? "批准" : "驳回"}门禁 ${name}。`;
    const next = approved
      ? afterAcceptance(card)
      : `下一步：**不要**按"已经通过"往下走。如果你仍然认为有必要，把理由说清楚后重新申请一次。`;
    return [open, reason, next]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 验收门禁（G3）/ `accept`：批的是"这活我认了"。
  const name = spec.gate ? gateName(spec, card) : "G3 验收";
  if (approved) {
    return [`【flowcard 审批通知】人已验收（${name} 通过）。`, reason, afterAcceptance(card)]
      .filter((line) => line !== "")
      .join("\n");
  }
  return [
    `【flowcard 审批通知】人已驳回验收（${name}）。`,
    reason,
    `下一步：**不要**按「已经验收」往下走（别合并、别拆现场）。如果你仍然认为有必要，把下面说的东西补上 / 改掉之后，再请人验收一次（看板上点「验收」，或 \`flowcard accept ${card.id}\`）。`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------- 投递（带 IO）

```

---

## 5. 自动开工写回卡片的评论

`src/server/autostart.ts`：

```ts
    const detail = error instanceof Error ? error.message : String(error);
    await deps
      .comment(cardId, `自动开工时出了意外（已忽略，不影响卡片）：${detail}`)
      .catch(() => undefined);
    await deps.comment(
      cardId,
      `卡片绑着 worktree \`${bound.path}\`，但那个目录不存在了：会话这次起在项目根，请先重建 worktree 再切进去。`,
    );
    await deps.comment(
      cardId,
      `自动开工：**没起来会话**（${started.error?.code ?? "UNKNOWN"}）——${reason}\n\n` +
        `再试一次：看板上这张卡的「起会话」；或自己在 \`${cwd}\` 里起 omp，再 ` +

  await deps.comment(
    cardId,
    `已托管会话（工作目录 \`${cwd}\`，提示词见 \`${briefPath}\`）：worktree 由会话自己按提示创建并登记。`,
```

---

## 6. CI 结束 / 新评论通知

这两个源已经落在 `src/server/notify-hooks.ts`：`ciNotice()` / `commentNotice()`（复用同一条通道 / 台账 / 降级）。
本节还没有逐字抄文案 —— 抄的时候从这两个函数里取。
