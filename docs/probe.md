# 探测（M3）：worktree / 分支 / PR / CI / 进度

> 代码：`src/server/probe.ts`（纯函数 + 薄 IO，执行器可注入）、`src/cli/detect.ts`（独立入口）。
> 测试：`test/probe.test.ts`（真实临时 git 仓库 + 注入的假 gh/tea）。
> 全程**只读**：只跑 `git rev-parse/status/log/rev-list/remote`、`gh pr view`、`tea pulls list`；
> 没有 `fetch`/`push`/`pull`，不改用户仓库状态，不装工具，不改用户配置。

## 1. 分层

| 层 | 内容 | 为什么 |
|---|---|---|
| 纯函数 | argv 拼装（`gitArgv`/`ghArgv`/`teaArgv`）、输出解析（`parseRemoteUrl`、`classifyWorktree`、`ciFromGhRollup`、`ghPrToRef`、`teaPullToRef`…）、回写计划（`probeCommands`） | 可单测，不碰进程/网络 |
| 薄 IO | `probeGit(cwd, run)` / `probePr(ctx, run)` / `probe(cwd, {run})` | `run` 可注入；测试里塞假的 gh/tea 输出 |

`defaultRun` 用 `execFile`（**不经过 shell**），带超时（git 5 s，gh/tea 10 s）与 8 MiB 输出上限；
只往环境里加 `GH_PROMPT_DISABLED=1`（防 gh 交互）+ `NO_COLOR=1`，其余环境原样。

## 2. 探测了哪些信号

| 信号 | 命令 | 解析/用途 |
|---|---|---|
| worktree 根 | `git -C <cwd> rev-parse --show-toplevel` | 会话实际工作目录的根 |
| 分支名 | `git -C <cwd> rev-parse --abbrev-ref HEAD` | `HEAD` = detached → 记为 `null`，跳过 PR 探测 |
| git-dir / common-dir | `rev-parse --path-format=absolute --git-dir --git-common-dir` | **判定主仓库 vs worktree**（见 §3） |
| HEAD sha | `git -C <cwd> rev-parse HEAD` | 展示用 |
| 改动文件数 | `git -C <cwd> status --porcelain` | 非空行数（含未跟踪） |
| upstream | `git rev-parse --abbrev-ref --symbolic-full-name @{u}` | 无 upstream → 见 §5 降级 |
| 未推送提交数 | `git -C <cwd> log --oneline @{u}..HEAD` | 行数；无 upstream → `null`（未知） |
| 相对基线提交数 | `git -C <cwd> rev-list --count <base>..HEAD` | base = upstream，退到 `origin/HEAD`（都是本地 remote-tracking ref，**不联网**） |
| 远程 / forge | `git -C <cwd> remote get-url origin` | `parseRemoteUrl` → `{host,owner,repo,slug,forge}`；`github.com`→github，其余→gitea |
| PR 状态 / CI | `gh pr view <branch> --json number,url,state,isDraft,headRefName,statusCheckRollup` 或 `tea pulls list --state all --output json --limit 50 --fields index,state,url,title,head,base,ci` | 见 §4 |

`origin/HEAD` 基线用 `git rev-parse --verify --quiet origin/HEAD` 校验存在性，仍**不联网**（只读本地 remote-tracking ref）。

## 3. 从 cwd 反查 worktree（判定主仓库 vs worktree）

判据（任一成立即为 linked worktree）：

1. `--show-toplevel` ≠ 主仓库根；
2. `--git-dir` ≠ `--git-common-dir`（worktree 的 git-dir 是 `<主仓库>/.git/worktrees/<名字>`）。

**主仓库根** = `--git-common-dir` 的父目录（主仓库里它就是 `<根>/.git`）。所以：

- 会话在主仓库 → `isWorktree=false`，**worktree 槽位留空**并提示「请 `/wt <branch>` 或 `/move <worktree 路径>`」，绝不把主仓库当成 worktree 绑上去；
- 会话在 `<主仓库>/.worktrees/<名字>`（设计 §3.1 方式 B 的约定）→ 绑为 `{path, branch, source:"flowcard"}`；
- 会话在别处的 linked worktree → 仍接受，`source` 推断为 `"harness"`（见 §9 限制）；
- **detached HEAD**（`--abbrev-ref HEAD` 返回空或字面量 `HEAD`）→ `branch=null`、`detached=true`、`bindable=null`，
  **一律不回写 worktree**（首次绑定也不回写，见 §7）。理由：`branch` 是绑卡后开 PR / 清理要用的字段，
  探测是自动跑的，**自动写绝不能让卡片信息变差**——用 `detached` 覆盖掉原本正确的 `feat/x` 是净损失。
  此时只给 note/hint：`要绑卡请先在里面 \`git switch -c feat/<名字>\``。

## 4. PR / CI 探测（可降级）

按 forge 决定顺序，**第一个给出确定答案的工具说了算**：

| forge | 顺序 |
|---|---|
| `github.com` | `gh` → `tea` |
| 其他主机（Gitea 等） | `tea` → `gh` |
| 无远程 / 认不出 | `tea` → `gh` |

- **gh**：`gh pr view <branch> --json …`。状态映射 `MERGED`→merged、`CLOSED`→closed、`OPEN`+`isDraft`→draft、否则 open。
- **tea**（Gitea，v0.16）：`tea pulls list --state all --output json --fields …,head,ci`，按 `head == 分支名` 挑。
  注意 Gitea 列表**没有 draft 位**（draft 会显示成 open）。
- **CI 结论**：统一成 `pending | pass | fail`。
  - gh：`statusCheckRollup` 里 CheckRun 的 `status/conclusion` 与 StatusContext 的 `state`。任一 `FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE` → `fail`（fail 优先）；否则任一未完成（非 `COMPLETED` 或 `PENDING/QUEUED/IN_PROGRESS/WAITING/REQUESTED/EXPECTED`）→ `pending`；空数组 → 无 CI（`ci` 字段不写）。
  - tea：`ci` 字段 `success/skipped`→`pass`、`failure/error`→`fail`、`pending/running/queued/warning`→`pending`、空→无。

## 5. 降级行为（拿不到就跳过，绝不报错/装工具/改配置）

| 情况 | 表现 |
|---|---|
| `gh` / `tea` 未安装（ENOENT） | 记 note「xx 未安装：跳过」，试下一个工具 |
| 工具在但未登录 / 远程不匹配 / 私有仓库无权限 | 该工具 exit≠0 → 记 note（带 stderr 首行）→ 试下一个 |
| 两个工具都不可用 | `prProbed=false`、`pr=null`，note + hint 明确写「**未探测**」；**不算失败**，退出码仍 0 |
| 工具成功但该分支没有 PR | 这是**确定没有**：`prProbed=true`、`pr=null`，提示「先开 WIP PR」 |
| 无 `origin` 远程 / URL 认不出 | 记 note；PR 探测降级；`repo` 归属缺失（解析不出就不猜） |
| 分支无 upstream | `unpushedCommits=null`（**不 fetch**，只读本地 ref）；退到 `origin/HEAD` 算 `commitsSinceBase` |
| `cwd` 不在 git 仓库里 | `probe.ok=false` + note；若卡片有 `repoPath` 则退回它探测 |
| git 输出里没有 worktree（主仓库） | worktree 槽位不回写，给提示 |
| worktree 处于 **detached HEAD** | worktree 槽位**不回写**（首次绑定也不写），note/hint「先 `git switch -c feat/<名字>`」 |
| 单个工具命令超时（10 s） | kill 后按失败处理并降级 |

## 6. 本机 gh / tea 实测状态（2026-10-10）

**一句话：本机 `gh` 未安装；`tea` 0.16.0 已安装且已登录 `gitea.example.com`（用户名 `suzmii`，非 DEFAULT 登录）。**

- `command -v gh` → 未安装（`gh: command not found`）。
- `tea --version` → `Version: 0.16.0 golang: 1.27.1`；`tea login list` 显示一条登录：`gitea.example.com / https://gitea.example.com/git / suzmii / DEFAULT=false`。
- **实测成功**（只读 GET）：在 `~/workspace/repo`（远程 `https://gitea.example.com/git/owner/repo`）跑
  `tea pulls list --state all --output json --fields index,state,url,title,head,base,ci` 返回真实 PR 列表；
  经 `probePr` 解析：分支 `codex/trim-native-shell-tests` → `{number:745, state:"merged", ci:"pass"}`；不存在的分支 → `probed=true, pr=null`。
- **实测降级**：在一个远程是 `github.com` 的仓库里（`gh` 未装、tea 无 github.com 登录），
  `node src/cli/detect.ts` 输出 `prProbed=false` 并附 note：
  「gh 未安装：跳过 GitHub PR 探测」+「tea 探测失败（exit 1）：NOTE: no login matched this repository…」+「PR 未探测…」，退出码 0。

因为 `gh` 未安装，**gh 解析路径本机无法端到端实测**，只由单测里的假 JSON 覆盖。

## 7. 回写规则（幂等，只回写拿到的部分）

`probeCommands(卡片现状, 探测结果)`：

- worktree：探测到**可绑卡的** linked worktree（`bindable != null`，即非主仓库且非 detached HEAD）且与卡片现状（path 或 branch）不同 → 发 `worktree`；
  主仓库、detached HEAD、以及「与现状一致」都不发 —— **自动回写只会补充或纠正，不会把已有的有效分支写坏**；
- PR：卡片没 PR 或 PR 号不同 → `bindPr`；同一 PR 但 `state`/`ci` 变了 → `probePr`（merged 会被引擎升级成 `pr.merged`）；
- 完全一致 → **不发**（再跑一次是空操作）。

拿不到就不发（例如没有 worktree / detached HEAD 就不发 `worktree`）；单个命令失败不影响其他命令与卡片完整性。

## 8. 用法

```bash
# 探测某张卡并回写（独立入口，不改 src/cli/main.ts）
node src/cli/detect.ts <card> [--port 47825] [--url http://127.0.0.1:47825] [--cwd <路径>]

# 退出码：0 成功 / 2 用法错 / 3 卡片不存在或服务端拒绝 / 4 缺必要条件（无会话 cwd、cwd 不在仓库）/ 5 服务不可达
```

stdout 一行 JSON，字段：`ok / card / cwd / worktree / isWorktree / detached / mainRoot / pr / prSource / prProbed / signals / applied / notes / hints`。
「没有 worktree 或没会话 cwd」时会给出人话 `hint`，例如：

```
会话 cwd 是主仓库 /path/to/repo，不是 worktree：请 /wt <branch> 或 /move <worktree 路径>
会话所在的 worktree /path/to/repo/.worktrees/demo 处于 detached HEAD：未回写 worktree（不覆盖卡片上已有的分支）；请先在里面 git switch -c feat/<名字> 再绑卡
```

## 9. 已知限制

- **`source` 是启发式**：`git` 不知道 worktree 是谁建的。落在 `<主仓库>/.worktrees/` 记为 `flowcard`，否则记为 `harness`——omp 的 `/wt` 若也用 `.worktrees/`，会被误记成 `flowcard`。
- **无 upstream / 从未 fetch** 时，「未推送提交数」只能给 `null`（我们刻意不 fetch，避免任何网络写/副作用）；`commitsSinceBase` 的基线可能滞后于远端真实状态。
- **私有仓库 / 无权限**：`gh`/`tea` 会失败 → 一律降级为「未探测」，不区分「没权限」与「没登录」。
- **Gitea 的 draft 状态**（`tea pulls list` 无该字段）无法识别，draft PR 会显示成 `open`。
- **fork 工作流**：`tea`/`gh` 按当前仓库上下文解析；远程指向 fork 而非上游时可能找不到 PR。
- 自建 Gitea 的 PR URL 可能是 `http://`（本机实测就是），我们是原样记录 URL，不做规范化。
- `git < 2.31` 不支持 `--path-format=absolute`，已带相对路径兜底，但未在本机（git 2.56）实测。
- **detached HEAD 的 worktree 不会绑到卡片上**：卡片上的 `worktree.branch` 必须是真分支名（要用来开 PR / 清理）。
  会话停在 detached HEAD 时只提示、不写卡；想绑就先 `git switch -c feat/<名字>`。
- 探测只读、不修改卡片：拿不到的信号不会伪造，也不会把卡片搞坏。

## 10. 复现

```bash
npx tsc --noEmit                 # 我的文件不报错
npx vitest run test/probe.test.ts # 30 个用例：真实临时仓库（含 detached worktree）+ 假 gh/tea

# 端到端（临时实例 + 临时仓库）
FLOWCARD_DATA_DIR=/tmp/fc-probe FLOWCARD_PORT=47833 npm start
# 在 /tmp 自建 git 仓库 + `git worktree add .worktrees/<名字> <branch>`
# 造卡 → 跑检测：
node src/cli/detect.ts <card> --port 47833
```
