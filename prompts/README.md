# 提示词模板（改文案改这里）

这些 `.md` 是 flowcard 发给 AI 的提示词的**唯一真相**：代码只负责填值，读不到就报错
（绝不静默回退到内置文案 —— 两份真相必然分叉）。

- 位置：仓库根 `prompts/`，与 `skills/` 并列；`FLOWCARD_PROMPTS_DIR` 可指到别处（测试/试验用）。
- 渲染器：`src/server/prompts.ts` —— 语法只有一条 `{{名字}}`，无第三方库、无条件/循环。
- **每次渲染都重新读文件** → 改完保存**即生效，不用重启服务**（下一句 kickoff、下一份 brief 立刻用新文案）。
- 服务启动时会用样本值把所有模板渲一遍（`validatePrompts()`），坏的当场**拒启**（退出码 3），
  不等到第一次起会话才发现。
- 只认 `.md`；`README.md`（本文件）不是模板，不参与渲染与校验。

## 两份模板

| 文件 | 用途 | 渲染入口 | 占位符 |
|---|---|---|---|
| `kickoff.md` | 起会话的第一条 prompt（只说一句「去 read 那份提示」） | `briefKickoff()`（`src/server/brief.ts`） | `{{briefPath}}`、`{{cli}}` |
| `brief.md` | 开工提示全文（写到 `<dataDir>/briefs/<card>.md`，agent 自己 `read`） | `cardBrief()`（`src/server/brief.ts`） | 见下 8 个 |

## 占位符清单

`{{briefPath}}`（只在 kickoff.md）

| 占位符 | 含义 | 由谁提供 |
|---|---|---|
| `{{briefPath}}` | 开工提示文件的**绝对路径** | `briefKickoff(file, cli)` 的 `file`；自动开工在 `autostart.ts` 算（`<dataDir>/briefs/<card>.md`），手动起会话在 `hosted-session.ts` 算 |
| `{{cli}}` | flowcard CLI 的调用前缀，默认 `flowcard` | `briefKickoff` / `cardBrief` 的 `cli` 参数（`main.ts`、`autostart` 都传 `flowcard`） |

`brief.md`（全部由 `cardBrief(input)` 提供）

| 占位符 | 含义 | 值从哪来 |
|---|---|---|
| `{{cardId}}` | 卡号，如 `c7` | `card.id` |
| `{{title}}` | 卡片标题 | `card.title` |
| `{{state}}` | 当前状态的中文名（如「实施中」） | `STATE_LABELS[card.state]`，认不出的状态退回原始值 |
| `{{body}}` | 正文（需求原文，已 trim；空正文写「（空）」） | `card.body` |
| `{{paths}}` | 「关键路径」那几行（项目根 / worktree / 远端），多行用换行分隔 | `cardBrief` 内部拼（吃 `project` 与 `worktree`；没有的项不出行） |
| `{{checklist}}` | 六项交付要件的表格：表头 + 分隔行 + 一行现状 | `checklist(card).join("\n")`（同文件里那个函数） |
| `{{todos}}` | 「☑︎ 接下来你要做的」清单行（`- [x]` / `- [ ]`） | `todos(card, cli, worktree).join("\n")` |
| `{{cli}}` | 同 kickoff 的 `{{cli}}` | 参数 |

> 清单行是**代码拼的**（要按卡片现状判断缺哪件），模板只决定它摆在哪儿、配什么标题。

## 严格规则

1. 模板里出现**没给值的占位符 → 抛错**，错误信息带文件、占位符名、可用清单：

   ```
   prompts/brief.md：模板里的占位符 {{nope}} 没有对应的值（可用：body、cardId、checklist、cli、paths、state、title、todos）
   ```

2. 给了值但模板里**没用到 → 不报错**（模板可以改短）。
3. 模板文件**缺失/读不到 → 抛错**：`prompts/kickoff.md：提示词模板读不到（ENOENT…）—— prompts/ 是提示词的唯一真相，缺失不静默回退到内置文案`。
4. 写法不对也报错：`{{ }}` 里不是字母数字下划线、或者多了半个括号（`{{name` / `}}`）。
5. **逐字渲染**，文件末尾的换行也算内容：`kickoff.md` 故意**不带**末尾换行（多一个会让第一条 prompt 变样），
   `brief.md` 末尾带一个换行（与模板化之前的文案逐字一致）。

## 改坏会怎样

| 你做了什么 | 结果 |
|---|---|
| 改文案（不动占位符） | 下一次起会话/写 brief 立刻用新的，**不用重启** |
| 占位符名字打错（`{{titel}}`） | 渲染抛错；服务启动时就会拒启（退出码 3） |
| 删掉 `{{todos}}` 那段 | 不报错 —— 但 agent 就看不到待办了（清单行是代码拼的，模板决定它露不露面） |
| 删掉 `kickoff.md` / `brief.md` | 启动拒启（缺必模板；见 `prompts.ts` 的 `REQUIRED_TEMPLATES`） |
| 加了代码不认识的占位符 | 渲染抛错；要加值得改代码（见下） |

## 加一份新模板

1. 新建 `prompts/<名字>.md`，占位符**只用 `src/server/prompts.ts` 里 `SAMPLE_VARS` 已有的名字**
   （新名字要同时加进 `SAMPLE_VARS` 与调用处的 `renderPrompt("<名字>.md", { … })`）；
2. 调用处 `renderPrompt("<名字>.md", { … })`；
3. 启动校验会自动把它带上（`prompts/` 下所有 `.md` 都渲一遍），不用登记。

改完记得跑 `npx vitest run` —— 文案断言就是回归网（改坏哪句会被用例点名）。
