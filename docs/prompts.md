# flowcard 发给 AI 的全部提示词（逐字，供人工优化）

> **改哪个文件就改哪个文件，保存即生效（不用重启服务）**——本文件只是"看全"用的提取视图。
> 渲染规则：`src/server/prompts.ts`（每次渲染现读文件；`{占位符}` 严格校验；模板坏 → 启动拒绝）。

| # | 提示词 | **可编辑的文件** | 触发时机 |
|---|---|---|---|
| 1 | kickoff（起会话第一条 prompt） | `prompts/kickoff.md` | 起会话（自动开工 / 手动 start 的新会话） |
| 2 | brief 全文 | `prompts/brief.md` | 起会话、切 worktree 时写成文件让 agent `read` |
| 3 | skill（模型指令） | `skills/flowcard/SKILL.md` | 每个会话常驻（omp 自动加载） |
| 4 | 通知文案（审批 / CI / 评论） | `prompts/notices/*.md` | 人做决定、CI 结束、远端新评论 |
| 5 | 降级评论抬头 | `prompts/notices/prefixes.json` | 会话不在线时写卡片评论的前缀 |
| 6 | 自动开工写回卡片的评论 | `src/server/autostart.ts`（源码内） | 自动开工成功/失败/异常 |

---

## 1. `prompts/kickoff.md`

```markdown
开工：第一步先 read `{{briefPath}}`，按里面「☑︎ 接下来你要做的」逐步执行，每步用 `{{cli}} comment` 留痕。
```

---

## 2. `prompts/brief.md`

```markdown
# 卡片 {{cardId}}：{{title}}

**当前状态**：{{state}}

**正文（需求原文）**：

{{body}}

## 关键路径

{{paths}}

## 六项交付要件

{{checklist}}

## ☑︎ 接下来你要做的

{{todos}}

**位置**：会话没进 worktree 就不算开工（在主仓库里改文件不算开工）—— 搬进去用
`{{cli}} worktree use {{cardId}} --path <worktree 路径>`（停当前会话、用新目录续接同一条会话）。

```

---

## 3. `skills/flowcard/SKILL.md`

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

## 4. 通知文案 `prompts/notices/*.md`（12 份，逐字）

### `prompts/notices/README.md`

```markdown
# 通知文案模板（改文案改这里）

`notify-hooks.ts` 发给 AI 的那些**通知**（人批准/驳回、CI 结束、远端新评论）的正文就躺在这个目录里：
代码只负责**选文件 + 填值**。渲染器与校验规则与 `prompts/kickoff.md` / `prompts/brief.md`
**完全同一套**（见 `src/server/prompts.ts`）：语法只有 `{{名字}}`，没有条件/循环。

- **每次渲染都重新读文件** → 改完保存**即生效，不用重启服务**（下一次通知立刻用新文案）。
- 服务启动时会把 `notices/*.md` 与顶层模板一起渲一遍（`validatePrompts()`）：**坏模板当场拒启**（退出码 3）。
- 只认 `.md`；`README.md`（本文件）不是模板，`prefixes.json` 也不是模板（它是抬头配置，见下）。
- 渲染完会**丢掉空行**（含文件末尾那个换行）—— 占位符没内容时（比如没写理由的 `{{reason}}`）不该在
  通知中间留一个空行。所以别指望用空行在这里排版，它会被吃掉。

## 一决定一文件

| 文件 | 触发时机 | 占位符 |
|---|---|---|
| `confirm-approve.md` | 人**批准**了 G2 远程写授权（`flowcard confirm … --request` 之后人在看板点批准） | `{{what}}` `{{reason}}` `{{cardId}}` `{{confirmId}}` |
| `confirm-reject.md` | 人**驳回**了远程写授权 | `{{what}}` `{{reason}}` `{{cardId}}` `{{action}}` |
| `cleanup-approve.md` | 人**批准**了 G4 清理门禁 | `{{gateName}}` `{{reason}}` `{{next}}` |
| `cleanup-reject.md` | 人**驳回**了 G4 清理门禁 | `{{gateName}}` `{{reason}}` `{{cardId}}` |
| `gate-approve.md` | 人**批准**了其它流程门禁（不是验收、也不是清理） | `{{gateName}}` `{{reason}}` `{{next}}` |
| `gate-reject.md` | 人**驳回**了其它流程门禁 | `{{gateName}}` `{{reason}}` |
| `accept.md` | 人**验收通过**（G3 门禁，或 `flowcard accept`） | `{{gateName}}` `{{reason}}` `{{next}}` |
| `accept-reject.md` | 人**驳回验收** | `{{gateName}}` `{{reason}}` `{{cardId}}` |
| `ci-pass.md` | 绑定的 PR 的 CI 从 `pending` 变成 `pass` | `{{prNumber}}` `{{sha}}` `{{cardId}}` `{{link}}` |
| `ci-fail.md` | 绑定的 PR 的 CI 从 `pending` 变成 `fail` | `{{prNumber}}` `{{sha}}` `{{jobs}}` `{{link}}` |
| `comment.md` | 绑定的 issue / PR 上出现了**别人**（不是这张卡的 agent）的新评论 | `{{who}}` `{{where}}` `{{link}}` `{{summary}}` `{{cardId}}` |

三类通知共用同一条通道：投给这张卡的托管会话；会话不在线时降级成「卡片评论 + 待补投」（抬头见下）。
幂等（同一条只打扰一次）与降级逻辑都在 `src/server/notify-hooks.ts`，改文案**不用**碰它。

## 占位符清单

| 占位符 | 含义 | 值长什么样 / 由谁算 |
|---|---|---|
| `{{what}}` | 是哪一件远程写授权 | `cf1（将执行：git push origin feat/x）`；申请时没写 detail 就是 `cf1（push）` |
| `{{confirmId}}` | 那条授权的编号 | `cf1` |
| `{{action}}` | 授权的动作类型 | `push` / `merge` / `openPr` / `commentRemote` / `other` |
| `{{gateName}}` | 门禁名 | `G4 清理确认`（流程里的标题；没标题就只给 id，如 `G9`）；验收没有门禁时是 `G3 验收` |
| `{{reason}}` | 「理由」那一行 | `理由：现场没用了`；人没写理由就是**空串**（那一行整个消失） |
| `{{next}}` | 「下一步」那一行 | `下一步：…` —— **按卡片当前状态**由代码选（`afterAcceptance()` 与清理分支）。模板没有条件语句，所以"选哪句"留在代码里 |
| `{{cardId}}` | 卡号 | `c7` |
| `{{prNumber}}` | PR 编号（只有数字） | `77` |
| `{{sha}}` | commit 那一小句 | `（commit aaa111222333）`；远端没给 sha 就是**空串** |
| `{{jobs}}` | 失败 job 那一行 | `失败 job：build（http://ci/build/1）、lint`（最多列 5 个，多的写「；还有 N 个没列」）；远端没给 job 明细时是「失败的 job 名远端没给（自己去 PR 页面看详情）。」 |
| `{{link}}` | 「链接」那一行 | `链接：https://…`；远端没给链接就是**空串** |
| `{{who}}` | 评论作者 | `lhk229`；作者名读不出来时是 `有人` |
| `{{where}}` | 评论挂在哪儿 | `Issue #42` / `PR #77` |
| `{{summary}}` | 评论正文摘要 | 折掉换行、超 240 字截断（`summarize()`），空正文是 `（空）` |

> `{{next}}` / `{{reason}}` / `{{jobs}}` / `{{link}}` 这几个是**整行**：要么是一句完整的话，要么是空串
> （空行会被丢掉）。因为模板里没有 `if`，"哪一句"由代码挑；改这些句子的**措辞**要改
> `src/server/notify-hooks.ts`（`afterAcceptance()` / 清理分支 / `ciNoticeIn()`）。

## 降级评论的抬头（`prefixes.json`）

| 键 | 默认值 | 用在哪 |
|---|---|---|
| `pending` | `【通知·待转达】` | 会话不在线时，CI / 评论通知降级写的卡片评论抬头 |
| `approvalPending` | `【审批通知·待转达】` | 同上，审批那一类（沿用最早那个抬头） |
| `renderFailed` | `【通知·渲染失败】` | 模板坏 / 读不到时，那条"没发出去"的留痕评论抬头 |

```json
{ "pending": "【通知·待转达】", "approvalPending": "【审批通知·待转达】", "renderFailed": "【通知·渲染失败】" }
```

- 文件**不在** → 用内置默认（抬头只是"给人看的装饰"，不为它把整类通知弄坏）。
- 文件**在但坏**（不是合法 JSON / 值是空串）→ 服务启动**拒启**（点名 `prefixes.json` 与哪个键）；
  运行中改坏 → 只 `warn` + 退回内置默认，通知照发。
- 少写某个键 → 那个抬头用默认（不因为少写一行把通知弄坏）。

## 改坏会怎样

| 你做了什么 | 结果 |
|---|---|
| 改文案（不动占位符） | 下一条通知立刻用新文案，**不用重启** |
| 占位符名字打错 / 写了代码不认识的 | 渲染抛错：那条通知**不投**，控制台 `warn` 一句 + 卡片上留一条 `【通知·渲染失败】…` 评论；服务**启动时就拒启**（退出码 3），报错点名文件 + 占位符 + 可用清单 |
| 删掉某个通知模板 | 那条通知渲染时读不到文件 → 同样「不投 + warn + 卡片评论留痕」（启动校验只拦"坏模板"，不拦"少文件"） |
| 删/改坏 `prefixes.json` | 启动拒启（JSON 坏 / 值是空串）；运行中改坏 → warn + 用内置默认抬头 |
| 加一个代码没给值的占位符 | 与"占位符打错"同一条路：拒启 / 渲染失败留痕。真要新占位符得改代码 |

模板坏掉时**绝不静默**：即使会话在线也只会 warn + 在卡片上留痕，不会发出半截通知。

## 加一类新通知

1. 新建 `notices/<名字>.md`，占位符只用 `src/server/prompts.ts` 的 `SAMPLE_VARS` 里已有的名字
   （新名字要同时加进 `SAMPLE_VARS` 与调用处的 `renderNotice(…)`）；
2. 在 `src/server/notify-hooks.ts` 顶部的 `NOTICE_TEMPLATES` 里加上这份文件，调用处 `renderNotice(名字, { … })`；
3. 启动校验会自动带上它（`notices/*.md` 全渲一遍），不用登记。

改完跑 `npx vitest run`：`test/notice-templates.test.ts` / `test/notify-hooks.test.ts` /
`test/approval-hooks.test.ts` 里的文案断言就是回归网（改坏哪句会被用例点名）。
```

### `prompts/notices/accept-reject.md`

```markdown
【flowcard 审批通知】人已驳回验收（{{gateName}}）。
{{reason}}
下一步：**不要**按「已经验收」往下走（别合并、别拆现场）。如果你仍然认为有必要，把下面说的东西补上 / 改掉之后，再请人验收一次（看板上点「验收」，或 `flowcard accept {{cardId}}`）。
```

### `prompts/notices/accept.md`

```markdown
【flowcard 审批通知】人已验收（{{gateName}} 通过）。
{{reason}}
{{next}}
```

### `prompts/notices/ci-fail.md`

```markdown
【flowcard 通知】CI 结束了：PR #{{prNumber}} 的 CI **失败**（fail）{{sha}}。
{{jobs}}
下一步：看一眼失败日志；改完推上去 CI 会重跑。
{{link}}
```

### `prompts/notices/ci-pass.md`

```markdown
【flowcard 通知】CI 结束了：PR #{{prNumber}} 的 CI **通过**（pass）{{sha}}。
下一步：看一下还有没有 review 意见；都处理完就请人验收（看板点「验收」，或 `flowcard accept {{cardId}}`）。
{{link}}
```

### `prompts/notices/cleanup-approve.md`

```markdown
【flowcard 审批通知】人已批准清理（{{gateName}}）。
{{reason}}
{{next}}
```

### `prompts/notices/cleanup-reject.md`

```markdown
【flowcard 审批通知】人已驳回清理（{{gateName}}）。
{{reason}}
下一步：**不要拆现场**（worktree / 分支都留着）。如果你仍然认为有必要清理，把理由说清楚后重新提一次清单：`flowcard cleanup {{cardId}} --item "要删的东西"`，等人再批一次。
```

### `prompts/notices/comment.md`

```markdown
【flowcard 通知】{{who}} 在{{where}}上留言了。
{{link}}
正文（摘要）：{{summary}}
下一步：读一遍再决定要不要回 —— 要回就在远端评论（或 `flowcard comment {{cardId}} --body "…"` 记一句本地说明）。
```

### `prompts/notices/confirm-approve.md`

```markdown
【flowcard 审批通知】人批准了远程写授权 {{what}}。
{{reason}}
下一步：现在可以执行它；执行完请 `flowcard confirm {{cardId}} --consume {{confirmId}}` 作废这次授权（一次批准只覆盖一次动作，再写一次要重新申请）。
```

### `prompts/notices/confirm-reject.md`

```markdown
【flowcard 审批通知】人驳回了远程写授权 {{what}}。
{{reason}}
下一步：**不要执行**这次远程写。如果你仍然认为有必要，改 detail（写清将要执行的确切命令或 URL）后重新申请一次：`flowcard confirm {{cardId}} --request --for {{action}} --detail "…"`。
```

### `prompts/notices/gate-approve.md`

```markdown
【flowcard 审批通知】人已批准门禁 {{gateName}}。
{{reason}}
{{next}}
```

### `prompts/notices/gate-reject.md`

```markdown
【flowcard 审批通知】人已驳回门禁 {{gateName}}。
{{reason}}
下一步：**不要**按"已经通过"往下走。如果你仍然认为有必要，把理由说清楚后重新申请一次。
```

---

## 5. 降级评论抬头 `prompts/notices/prefixes.json`

```json
{
  "pending": "【通知·待转达】",
  "approvalPending": "【审批通知·待转达】",
  "renderFailed": "【通知·渲染失败】"
}
```

---

## 6. 自动开工写回卡片的评论（源码内，暂无独立文件）

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
