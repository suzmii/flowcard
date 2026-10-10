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
