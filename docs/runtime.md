# 卡片运行时（M3）

每张卡片有一个「启动按钮」，启动的是**这张卡片 worktree 里的项目**（dev server / 预览栈之类）。
会话是 agent 在干活，运行时是项目在跑——两者都由卡片持有，互不影响。

## 1. 配置：每个项目怎么启动

### 1.1 仓库内 `.flowcard.toml`（主来源，跟代码走）

放在**项目仓库根**（跟 `.git` 同级），随代码提交、可 review、可回滚：

```toml
[runtime]
cmd = "npm run dev"          # 必填：交给 /bin/sh -c 执行
cwd = "."                    # 可选：相对卡片 worktree 根（默认就是 worktree 根；绝对路径也行）
ports = [5173]               # 可选：探活 + 端口冲突提示用
singleton = true             # 可选：true（默认）/ "project" / false

[runtime.env]                # 可选：追加/覆盖进程环境变量
NODE_ENV = "development"

[runtime.ready]              # 可选：怎么算「起来了」，见 §1.3
port = 5173
timeout = 30                 # 秒，默认 30
```

worktree 在仓库内的 `.worktrees/<名字>` 下，往上找就能找到仓库根的 `.flowcard.toml`，
所以同一份配置对「主干」和「所有 worktree」都生效。

**项目根判定**：只看「`.git` 是目录」的那个目录。linked worktree（`git worktree add`）里 `.git`
是个**文件**（内容 `gitdir: <主仓库>/.git/worktrees/<名字>`），不算项目根，会继续往上找主仓库——
所以同一仓库的所有 worktree 都归同一个项目（`singleton = "project"` 的「同一项目」也是按这个算）。
worktree 里如果自己再放一份 `.flowcard.toml`，**就近的那份赢**（整字段覆盖主仓库那份）。

### 1.2 全局 `~/.config/flowcard/projects.toml`（兜底/补字段）

仓库里不方便提交配置时（比如不想把启动方式写进别人的 repo），用这份按项目绝对路径兜底：

```toml
["/home/u/workspace/proj"]   # 键就是项目根（含 .git 的那个目录）的绝对路径
cmd = "pnpm dev"
singleton = false

["/home/u/workspace/proj".env]
DATABASE_URL = "postgres://localhost/dev"
```

（也允许再套一层 `runtime`：`["/path".runtime] cmd = "…"`。目录用 `FLOWCARD_CONFIG_DIR` 可覆盖。）

**优先级（字段级合并，仓库内优先）**：

| 字段 | 来源 |
|---|---|
| 仓库内 `.flowcard.toml` 写了的字段 | 用它（最高优先） |
| 仓库内没写的字段 | 全局 `projects.toml` 兜底 |
| 两边都没写 | 用默认值（`cwd` = worktree 根、`singleton` = true、`ready` = §1.3 的默认） |

全局那份按路径匹配：项目根**精确等于**键，或是键的**子孙目录**；键是祖先时更具体的键赢
（`/home/u` 与 `/home/u/proj` 都在时，`/home/u/proj` 覆盖 `/home/u`）。

`env` 是两边合并（全局的键被仓库同名键覆盖），其余字段是整字段覆盖。

### 1.3 就绪判定（`ready`）

| 写法 | 含义 |
|---|---|
| `[runtime.ready] port = 5173` | 127.0.0.1:5173 能连上才算 running |
| `[runtime.ready] log = "listening on"` | 日志里出现这个正则才算 running（日志里适配层写的行以 `[flowcard]` 开头，正则别撞上它） |
| `[runtime.ready] exit = true` | 进程 0.5s 内没退出就算 running（**默认**） |
| `[runtime.ready] exit = false` | spawn 成功立刻算 running（不查「起完就死」；它随后真退出了，后台监听会把它标成 `failed`） |
| 不写 `ready` | 有 `ports` 就按第一个端口探活；否则等价于 `exit = true` |

`timeout` 是秒（默认 30）。就绪超时 → 卡片状态 `failed`，并把超时原因写进事件。

### 1.4 配置缺失/非法时

- 找不到配置 → 状态 `failed`，接口回 `{"ok":false,"error":{code:"NO_CONFIG", message:"项目 … 还没有启动配置，不知道该跑什么", hint:"在 …/.flowcard.toml 写 [runtime] cmd = "…"；…；找过：…"}}`。
- TOML 写错 / 字段不认识 / 类型不对 → `BAD_CONFIG`，错误信息带 `文件:行号`（例如 `/tmp/p/.flowcard.toml:3: 不认识的值：maybe`）。
- 这两种情况都**不会崩**：状态标成 `failed`，人话错误原样回给启动按钮。

## 2. 启动 / 停止流程

`up`（`POST /api/cards/:id/runtime {action:"up"}` / `flowcard up <card>`）：

1. 卡片不存在 → `NOT_FOUND`；原来那次运行的进程还活着 → 幂等返回（不重复起）。
2. 定位工作目录：`card.worktree.path`（没有就退回 `card.repoPath`；都没有 → `NO_PROJECT`）。
3. 解析配置（§1）。
4. **单例不变式**：按 `singleton` 停掉其他卡片正在跑的运行时，被停的卡片 id 放进响应 `killed`。
5. 端口占用检查：配置里的 `ports` 若被别的进程占着，只在 `warnings` 里提示——**不会去杀那个进程**。
6. 写事件 `runtime.starting`（含 pid/pgid/日志路径/端口）。
7. `spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: true, stdio: [ignore, logFd, logFd] })`。
8. 等 `ready`（§1.3）：超时或进程立刻退出 → 杀掉自己这个进程组 + 写 `runtime.failed`（带退出码/信号）。
9. 就绪 → 写 `runtime.started` → 状态 `running`。

`down`（`{action:"down"}` / `flowcard down <card>`）：

1. 取这次运行记下的 pgid（内存记录，或从事件流重建）。
2. 进程组已不在 → 只收尸：写 `runtime.stopped`。
3. 在 → `process.kill(-pgid, "SIGTERM")`，宽限期 **5s** 内还没走干净 → `process.kill(-pgid, "SIGKILL")`。
4. 写 `runtime.stopped`（带 `signal`、`reason`：`down` / `singleton:<card>` / `shutdown` / `reap:stale`）。
5. 状态 `stopped`。重复 `down` 什么也不做（同一把 `dedupeKey`，不会写出第二条事件）。

另外两种自动收尾：

- **服务退出**：`SIGINT`/`SIGTERM` → 停掉自己起过的全部运行时（`reason: "shutdown"`）；`process "exit"` 钩子再同步
  `SIGKILL` 兜底一次。
- **服务重启**：启动时扫一遍卡片投影，凡是还写着 `running`/`starting` 的，按事件流里的 pid/pgid 收尸
  （`reason: "reap:stale"`），启动日志会打印 `清理残留运行时 c1, c2`。

## 3. 单例不变式

| `singleton` | 行为 |
|---|---|
| `true`（默认） | 启一张卡 → 先停掉**其他所有卡片**在跑的运行时（端口/GPU/显存这类资源同时只能给一套栈） |
| `"project"` | 只在**同一个项目**（同一个主仓库、即 `.git` 是目录的那个根，含其所有 worktree）内互斥 |
| `false` | 完全不互斥，各起各的 |

被这次启动顺手停掉的卡片 id 一律回在 `killed` 里（UI 要显示出来）。

**和「多开 subagent」不冲突**：单例只约束项目进程；agent 会话（含 harness 自己开的 subagent）
想开几个开几个，卡片绑定会话仍然只认 `agentKind === "main"`。

## 4. kill 语义与安全边界

一句话：**只对 flowcard 自己 spawn 出来的那个进程组（`detached: true` 自建，pgid == 子进程 pid）发
`SIGTERM`，宽限期后 `SIGKILL`；不是自己起的进程，一个也不碰。**

| 允许 | 禁止 |
|---|---|
| `process.kill(-pgid, "SIGTERM" / "SIGKILL")`，pgid 是自己 spawn 时记下的 | `pkill` / `pgrep` / `pkill -f <模式>` / 按命令行匹配杀进程 |
| 杀自己那组的**全部成员**（父 + 它拉起的子进程都在同一组） | 杀别的 card、别的项目、系统里任何来路不明的进程 |
| 重启后清理自己留下的残留进程 | 拿 `pid` 直接 `kill`（pid 会被复用） |

安全细节：

- 停止走 `process.kill(-pgid, …)`，**整个进程组**一起收（组里 `sleep` / 子 server 都跟着走）。
- 从事件流重建的残留目标，动手前先核对 `/proc/<pgid>`：**启动时刻**（事件里的 `procStart`）必须一致、
  且 session 必须就是这个组（说明是当初 `detached` 建的那一组）。对不上就只收尸（状态标 `stopped`）、
  **不杀**，并在响应 `warnings` 里说明。
- 端口被占用只提示、不处理：占端口的可能是你自己开的别的东西，flowcard 不越权。

## 5. 日志

`<FLOWCARD_DATA_DIR>/logs/<cardId>.log`（默认 `~/.local/share/flowcard/logs/c1.log`），
子进程的 stdout/stderr 都追加到这里，多次启动追加到同一文件；适配层每次启动先写一行
`[flowcard] runtime start <时间> cmd=<命令>` 头。卡片投影里的 `runtime.logPath` 就是它。
`ready.log` 只匹配**这次启动之后**写入的字节（不会拿上一轮的 `READY` 冒充），所以别把正则写得太泛。

## 6. 事件与投影

状态变化**全部**是 append-only 事件，`cards` 是投影，所以 `rebuild` 之后按钮状态不会漂：

| 事件 | payload 关键字段 |
|---|---|
| `runtime.starting` | `pid`, `pgid`, `startedAt`, `ports`, `logPath`, `procStart` |
| `runtime.started` | 同上 |
| `runtime.failed` | `pid`, `pgid`, `startedAt`, `exitCode`, `signal`, `error`, `logPath` |
| `runtime.stopped` | `pid`, `pgid`, `startedAt`, `signal`, `reason`, `exitCode` |

投影结果（对外契约，冻结）：

```ts
Card.runtime: { status: "stopped"|"starting"|"running"|"failed";
                pid?: number; startedAt?: string; ports?: number[]; logPath?: string } | null
```

`pgid` / `procStart` / `exitCode` / `error` / `reason` 只在事件里（`GET /api/events` 可见），不进卡片投影。

引擎侧：新命令 `{cmd:"runtime", card, to, pid?, pgid?, …}`（`src/shared/types.ts` 的 `commandSchema`），
`runCommand` 里只做「校验卡片存在 + 落事件」，**不碰进程**；spawn/kill 全在 `src/server/runtime.ts`。

## 7. 接口与 CLI

```
POST /api/cards/:id/runtime   body {"action":"up"|"down"}
  → 200 {"ok":true, "runtime":{…}, "killed":["c1"], "warnings":[]}
  → 409 {"ok":false, "error":{"code":"NO_CONFIG","message":"…","hint":"…"}, "killed":[], "runtime":{…}}
     （404 = 卡片不存在，400 = body 非法）
SSE: event "runtime"  data {"cardId":"c1","status":"running"}   # 另有 "changed" 触发看板重取

flowcard up   <card>   # JSON 输出；0 成功 / 3 状态或配置不允许 / 5 服务不可达 / 2 用法错
flowcard down <card>
```

## 8. 已知限制

- **只保证收自己那组**：flowcard 重启后若某个运行时的组 leader 已死、只剩来路不明的孤儿，会只收尸不杀（安全优先）。
- **就绪判定是轮询**：端口 100ms 探一次、日志按整文件正则匹配（不 tail 增量，大日志会有点浪费）。
- **没有守护/自愈**：进程自己退出只记 `failed`，不会自动重启。
- **单例是全局的**：`singleton = true` 时跨项目也会互斥（想按项目隔离用 `"project"`）。
- **Linux 专属细节**：残留进程核对读 `/proc`；非 Linux 上会退化成「只收尸不杀残留」。
- 配置里 `env` 会**整体继承服务进程的环境变量**（`process.env` 打底），不提供白名单。
