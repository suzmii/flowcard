# flowcard ⇄ omp adapter（M0 spike）

结论：**可行**。用 `-e/--hook` 直接指定仓库里的一个 `.ts` 文件，就能在 omp 进程内拿到会话生命周期，
并用 `fetch` POST 到本地 HTTP。已在真实 omp 进程（18.8.6，`--mode rpc --no-ui`）上端到端验证：

```
session.started → session.heartbeat ×N → session.ended     全部 HTTP 204
```

验证用的是 `--mode rpc --no-ui` 且**不发送任何 prompt**：没有推理请求、没有工具调用，只有会话启动/退出。

本目录内容：

| 文件 | 作用 |
| --- | --- |
| `flowcard-omp-adapter.ts` | 最小上报扩展（会话开始/心跳/结束 + 本地日志），由 **omp** 加载，不被 flowcard 引用 |
| `recv-server.mjs` | 一次性验证用接收端（`node` 起，落盘 `/tmp/omp-adapter-recv.log`） |

下面每条结论后跟证据。约定：**已验证**＝实际跑过并看到输出；**[INFERENCE]**＝只读代码/文档推出，未实跑。

---

## 0. 本机环境（证据）

```console
$ command -v omp && omp --version
/path/to/.bun/bin/omp
omp/18.8.6

$ ls -d ~/.bun/install/global/node_modules/@oh-my-pi/*
.../omp-stats  .../omptype  .../pi-agent-core  .../pi-ai  .../pi-catalog
.../pi-coding-agent  .../pi-mnemopi  .../pi-natives  .../pi-tui  .../pi-utils  .../pi-wire  .../snapcompact
```

安装目录（下文简写 `<omp-pkg>`）是 `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`，
**不是** ticket 里猜的 fnm 目录；该包内同时带 `src/`（TypeScript 源码）和 `dist/`，所以下面能直接引行号。

```console
$ omp plugin doctor --json
[{"name":"plugins_directory","status":"warning","message":"Not created yet"},
 {"name":"package_manifest","status":"warning","message":"Not created yet"},
 {"name":"node_modules","status":"warning","message":"Missing (run npm install in plugins dir)"}]
```

本机没装任何 plugin；M0 也不需要装（见 §5）。

---

## 1. 扩展是什么形式？

**单个 TS/JS 模块文件即可；npm 包形式是可选的。** 模块必须 default export 一个函数（工厂）。

证据：`omp://extension-loading.md`「Module import and factory contract」：

> factory is selected by `getExtensionFactory(module)`: the module itself if it is a function, otherwise `module.default`
> factory must be a function (`ExtensionFactory`) and may return `void` or a promise

证据：`omp://extensions.md`「What an extension is」：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
export default function myExtension(pi: ExtensionAPI) { ... }
```

包形式（可选，用于分发）：目录里有 `package.json` 的 `omp.extensions`（或旧的 `pi.extensions`）字段。
证据：`<omp-pkg>/examples/extensions/README.md` 的 `pi --extension examples/extensions/permission-gate.ts`
＋ `omp://skills/authoring-extensions.md`「package.json manifest」。

本仓库采用**单文件**形式：`flowcard-omp-adapter.ts`（仅 `import { appendFileSync } from "node:fs"`，
无第三方依赖、无 manifest、无权限声明）。

## 2. 有哪些生命周期事件/钩子？

事件是字符串名字 + `pi.on(name, handler)`。全量目录见 `omp://extensions.md`「Event surface」。
与 flowcard 相关的：

- 会话：`session_start`、`session_before_switch`/`session_switch`、`session_before_branch`/`session_branch`、
  `session_before_compact`/`session.compacting`/`session_compact`、`session_before_tree`/`session_tree`、
  `session_stop`、`session_shutdown`
- 轮次/消息：`input`、`before_agent_start`、`agent_start`/`agent_end`、`turn_start`/`turn_end`、
  `message_start`/`message_update`/`message_end`、`assistant_message`
- 工具：`tool_call`、`tool_result`、`tool_execution_start`/`_update`/`_end`、`tool_approval_requested`/`_resolved`
- 子代理：`before_subagent_spawn`
- 其他：`auto_compaction_*`、`auto_retry_*`、`ttsr_triggered`、`todo_reminder`、`goal_updated`、`mcp_notification`

证据（类型定义）：`<omp-pkg>/src/extensibility/extensions/types.ts:1382` 起是 `on(...)` 的重载表，
例如 `on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;`、
`on(event: "session_shutdown", ...)`。

**关键点：`session_start` / `session_shutdown` 事件体是空的**，所以一切上下文只能从 handler 的第二个参数 `ctx` 拿。

证据：`<omp-pkg>/src/extensibility/shared-events.ts:30-32`：

```ts
export interface SessionStartEvent { type: "session_start"; }
```
```ts
export interface SessionShutdownEvent { type: "session_shutdown"; }   // :105-107
```

"空闲"没有独立事件：handler 里用 `ctx.isIdle()` / `ctx.hasPendingMessages()` 查询（`types.ts:510-515`），
`turn_end` / `session_stop` 可作为轮次结束信号。

## 3. 扩展里怎么拿到会话标识？（1:1 映射的关键）

`ctx.sessionManager`（只读）提供 **`getSessionId()`（UUID）** 和 **`getSessionFile()`（.jsonl 绝对路径，
未落盘时可能 `undefined`）**。两个都实测可用。

证据（类型）：`<omp-pkg>/src/session/session-manager.ts:685-686`

```ts
export type ReadonlySessionManager = Pick<SessionManager,
  | "getCwd" | "getRecordedCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | ... >;
```

证据（实现）：同文件 `:3091` `getSessionId(): string { return this.#sessionId; }`，
`:3095` `getSessionFile(): string | undefined { return this.#sessionFile; }`；
`:3104` 的注释说明会话持久化是懒的，`getSessionFile()` 可能返回一个"还没写"的路径。

证据（实跑，`/tmp/omp-adapter-spike.log`）：

```json
{"type":"session.started","harness":"omp",
 "sessionId":"01a123bc-2451-7627-a5b6-d6fcc2a664c4",
 "cwd":"/tmp","at":"2026-10-10T02:54:55.173Z",
 "sessionFile":"/tmp/omp-adapter-sessions/2026-10-10T02-54-55-057Z_01a123bc-2451-7627-a5b6-d6fcc2a664c4.jsonl"}
```

`--no-session`（不落盘）时仍然有 `sessionId`，只是没有 `sessionFile`：

```console
$ { sleep 2; } | FLOWCARD_OMP_LOG=/tmp/omp-nosession.log omp --mode rpc --no-ui --no-extensions \
    --no-session -e .../flowcard-omp-adapter.ts --cwd /tmp
$ cat /tmp/omp-nosession.log
... POST session.started -> 204 {"type":"session.started",...,
 "sessionId":"01a123bc-831e-75e8-be0a-435dbcbc7868","cwd":"/tmp","at":"...","agentKind":"main","agentId":"Main"}
```

**建议**：flowcard 的卡片主键用 `sessionId`（始终存在、稳定），把 `sessionFile` 作为附加字段（可空）。
`sessionId` 恰好也是会话文件名里的那一段，与 `--resume <id>` 对得上。

## 4. 怎么加载？必须 `omp install` 吗？

**不需要。** `-e/--extension` 直接给文件路径即可（`--hook` 是等价别名，实测同样有效）。
`--no-extensions` 关闭环境发现时，显式 `-e/--hook` 仍然生效。

证据：`omp --help`

```
      --hook=<value>             Load a hook/extension file (can be used multiple times)
  -e, --extension=<value>        Load an extension file (can be used multiple times)
      --no-extensions            Disable extension discovery (explicit -e paths still work)
```

证据：`omp://extension-loading.md`「Explicitly configured paths」— 配置来源第 1 条就是
「CLI-provided paths (`--extension/-e`, and `--hook` is also treated as an extension path)」；
`omp://hooks.md`「Current status in runtime」—「`--hook` is treated as an alias for `--extension`」。

证据（实跑，`--hook` 别名，`/tmp/omp-hook-alias.log`）：

```console
$ { sleep 2; } | FLOWCARD_OMP_LOG=/tmp/omp-hook-alias.log omp --mode rpc --no-ui --no-extensions \
    --hook /path/to/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts --session-dir /tmp/omp-adapter-sessions --cwd /tmp
hook-alias exit=0
2026-10-10T02:55:19.595Z POST session.started -> 204 {...}
```

显式文件后缀支持 `.ts`/`.js`/`.mjs`/`.cjs`；环境自动发现只扫 `.ts`/`.js`。
证据：`omp://extension-loading.md`「If configured path is a file」/「Installed plugin extension entries」。

其他加载方式（本 spike 未用，也不建议 M0 用）：
- 丢到 `~/.omp/agent/extensions/` 自动发现（**会改用户环境**，本次刻意没做）；
- `omp install <path|npm-spec>` 装成 plugin —— `omp install --help` 输出确认它接受
  「Local path, npm spec, or marketplace ref」并有 `--dry-run`/`--scope`，但 M0 用 `-e` 就够了，**没装**。

## 5. 扩展能不能发 HTTP？

**能。** 扩展跑在 omp 自己的 Bun 进程里，`fetch` 是全局可用的，实测 POST 到 `127.0.0.1:47824` 成功（204）。

证据（实跑 `/tmp/omp-adapter-recv.log`，这是接收端收到的原始 body）：

```
2026-10-10T02:54:55.175Z POST /hook {"type":"session.started",...}
2026-10-10T02:54:56.317Z POST /hook {"type":"session.heartbeat",...}
2026-10-10T02:54:57.318Z POST /hook {"type":"session.heartbeat",...}
2026-10-10T02:54:58.318Z POST /hook {"type":"session.heartbeat",...}
2026-10-10T02:54:58.465Z POST /hook {"type":"session.ended",...}
```

证据（文档）：`omp://extensions.md` 的 `registerProvider` 例子就在扩展里直接 `await fetch(...)`；
该章还明确「this API adds no network dependency」（即网络由扩展自己负责，没有任何限制）。
心跳来自 `ctx.setInterval`（见下面 §7 注意事项）。

## 6. 扩展抛错会不会拖垮会话？

分情况，**用 `pi.on` 注册的 handler 抛错不会**；**裸 `setInterval`/`setTimeout`/游离 promise 抛错会**（进程级
`uncaughtException` → 整个会话被拆）。所以心跳必须用 `ctx.setInterval`。

证据（代码）：`<omp-pkg>/src/extensibility/extensions/runner.ts:1510-1560` —— handler 在 try/catch 内执行，
异常被记入 `handlerFailure` 并走 `emitError`（`runner.ts:1259 onError`），不会 rethrow；
只有 `tool_call` 是 fail-closed（文档：`omp://skills/authoring-extensions.md`「Important constraints」）。

证据（超时预算）：`runner.ts:130` `EXTENSION_HANDLER_TIMEOUT_MS = 30_000`，
`runner.ts:154` `SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS = 2_000`，且 `:163 handlerTimeoutForEvent()` 只对
`session_shutdown` 用 2s。**所以 `session.ended` 必须在 2 秒内发完** —— 扩展里把 fetch 超时设成 1.5s。
另外 `emitSessionShutdownEvent`（`runner.ts:439-451`）外层还有 try/catch
（`<omp-pkg>/src/session/agent-session.ts:5571-5577`），shutdown handler 整个挂掉也只记一条 warn。

证据（实跑，故意指向没人监听的 47825 端口，`/tmp/omp-adapter-spike-deadendpoint.log`，进程 `exit=0`）：

```
POST session.started FAILED (TypeError: Unable to connect. Is the computer able to access the url?) {...}
POST session.heartbeat FAILED (...)
POST session.heartbeat FAILED (...)
POST session.ended FAILED (...)
```

会话照常启动、照常退出（exit 0），没有任何崩溃 —— 说明 flowcard 服务没起来也不会影响用户在跑的 agent。

## 7. 能不能区分主会话与 subagent 会话？

**能。** `ctx.agent = { kind: "main" | "sub", id, name, depth, parentId? }`，判 `kind`（不要判 `depth`：
`/tan` clone 的 depth 是 0）。本扩展已经把 `agentKind`/`agentId` 一起上报。

证据（类型）：`<omp-pkg>/src/extensibility/extensions/types.ts:466-483`：

```ts
export interface ExtensionAgentIdentity {
  /** `"main"` for a top-level session, `"sub"` for any spawned session. ... */
  kind: "main" | "sub";
  id: string;            // 例如 "Main" / "0-Explore"
  name: string;          // 小写的 agent 定义名，如 "main"/"task"/"explore"
  depth: number;
  parentId?: string;
}
```

证据（构造点）：`<omp-pkg>/src/sdk.ts:3288-3296`：

```ts
Object.freeze({
  kind: isSubagentSession ? "sub" : "main",
  id: resolvedAgentId,
  name: resolvedAgentName,
  depth: taskDepth,
  ...(options.parentAgentId ? { parentId: options.parentAgentId } : {}),
})
```

证据（subagent 也会触发 `session_start`）：`<omp-pkg>/src/modes/runtime-init.ts:212`
`await runner.emit({ type: "session_start" });`，其调用方之一是
`<omp-pkg>/src/task/executor.ts:4544`（task 子会话初始化），另外还有 rpc / print / interactive
（`modes/rpc/rpc-mode.ts:1620`、`modes/print-mode.ts:161`、
`modes/controllers/extension-ui-controller.ts:327-330`）。文档同样确认
（`omp://extensions.md`「Handler context」：「Factories are rebound to every subagent session ... a handler
can check `ctx.agent.kind === "sub"`」）。

**[INFERENCE]** 当前 `flowcard-omp-adapter.ts` 对 main/sub **都上报**（不做过滤），因为过滤策略属于
flowcard 的数据模型决策；服务端可以按 `agentKind === "sub"` 忽略，避免给 subagent 建卡片。
subagent 场景**没有实跑验证**（要真跑一次 task 子代理＝一次真实模型调用，违反本次成本约束）。

## 8. M0 的坑：会话切换不会再有 `session_start`

**这是本次调查最重要的发现，直接影响数据模型。** 一个 omp 进程内 `/new`、`/resume`、`/branch`
等不会重发 `session_start`/`session_shutdown`，只会发 `session_switch` 之类事件；而 `ctx.sessionManager`
是**活的**，所以心跳会自动换到新会话，但卡片不会自动关闭/新建。

证据（实跑，RPC 发 `new_session` 后退出，`/tmp/omp-switch.log`）：

```
02:55:38.709 POST session.started -> 204 {... sessionId":"01a123bc-cd2d-707c-819e-f4096c870be8" ...}
02:55:39.709 POST session.heartbeat -> 204 {... "sessionId":"01a123bc-cede-7630-b37f-c2412c8f3bc7" ...}   ← 换人了，没有新的 started
02:55:40.698 POST session.ended    -> 204 {... "sessionId":"01a123bc-cede-7630-b37f-c2412c8f3bc7" ...}   ← ended 报的是新会话
```

同一进程内 `new_session` 返回 `{"command":"new_session","success":true,"data":{"cancelled":false}}`。
后果：老会话 `01a123bc-cd2d-...` 永远收不到 `session.ended`，新会话也没有 `session.started`。
**M1 必须**在适配器里补 `session_switch`（以及 `session_before_switch` 事件里的 `targetSessionFile`）
来关旧卡片、开新卡片；`session_shutdown` 只能当作"进程结束"清尾。
本 spike 按 ticket 要求只做三件事，**没有**实现这段（属于下一步）。

---

## 上报契约（当前实现）

POST `http://127.0.0.1:47824/hook`，`content-type: application/json`：

```json
{ "type": "session.started" | "session.heartbeat" | "session.ended",
  "harness": "omp",
  "sessionId": "01a123bc-...",
  "cwd": "/tmp",
  "at": "2026-10-10T02:54:55.173Z",
  "agentKind": "main",
  "agentId": "Main",
  "sessionFile": "/tmp/.../xxx.jsonl" }
```

前 6 个字段是占位契约里的原样字段；后 3 个是本 spike 追加的（理由：`agentKind` 用于过滤 subagent，
`sessionFile` 用于对齐 omp 的 `--resume`）；`sessionFile` 在 `--no-session` 下不出现。
另有本地日志每行一条：`POST <type> -> <status|FAILED> <payload>`，默认 `/tmp/omp-adapter-spike.log`。

环境变量（都有默认值，全部可选）：
`FLOWCARD_OMP_ENDPOINT`、`FLOWCARD_OMP_HEARTBEAT_MS`（默认 30000）、`FLOWCARD_OMP_LOG`。

## 加载命令

```bash
# 正常使用：对任意 omp 会话生效（建议默认关掉环境发现，只加载这一个）
omp -e ~/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts
```

## 复现验证（成本：无推理请求，每次 2–4 秒，其中大部分是 `sleep`）

```bash
# 1) 接收端（终端 A）
node ~/workspace/flowcard/src/adapters/omp/recv-server.mjs
#    -> listening on 127.0.0.1:47824 -> /tmp/omp-adapter-recv.log

# 2) headless 跑一次 omp（终端 B）：rpc 模式启动即 emit session_start，不需要任何 prompt
{ sleep 4; } | FLOWCARD_OMP_HEARTBEAT_MS=1000 omp --mode rpc --no-ui --no-extensions \
  -e ~/workspace/flowcard/src/adapters/omp/flowcard-omp-adapter.ts \
  --session-dir /tmp/omp-adapter-sessions --cwd /tmp
#    stdin EOF 后 omp 正常 dispose（exit 0）并 emit session_shutdown

# 3) 看结果
cat /tmp/omp-adapter-recv.log      # 接收端视角：5 个 body
cat /tmp/omp-adapter-spike.log     # 扩展视角：5 行 POST 日志
```

用 `--mode rpc --no-ui` 的理由：`omp://rpc.md`「Startup」说明该模式在启动时就完成扩展初始化并写 `ready`
帧、`--no-ui` 下 `ctx.hasUI === false` 且不弹任何对话框；stdin 关闭即正常退出。全程没有发送 prompt，
因此**没有发生任何推理（provider）请求**，成本只有几秒的进程启动。

## 未验证 / 未知（以及我试了什么）

- **TUI（交互）模式下的 `session_start` 时序**：只做了静态验证
  （`modes/controllers/extension-ui-controller.ts:327-330` 会 emit）。没实跑，因为需要 pty + 手工退出，
  风险高收益低。[INFERENCE：会正常触发]
- **subagent 会话实跑**：需要真实模型调用（`task`/eval agent），按成本约束放弃；结论基于 §7 的静态证据。
- **强杀（SIGKILL）时 `session.ended`**：没测。文档只覆盖"正常 dispose"路径；
  `process.exit`/`SIGKILL` 下 handler 不会跑。[INFERENCE：会丢失]
- **omp 18.8.6 之外的版本**：未测。事件名和 `ctx.agent` 是 18.x 的现状，
  `omp://extensions.md` 明确警告过 API 会变（如 18.3 移除过 `settings.get/set` 字符串路径 API）。
- **flowcard 侧 `npm run typecheck` / `npm test`**：本目录只加了 `.ts` 扩展文件（`recv-server.mjs` 不在
  tsconfig 的 `include` 里）。按分工没有在子任务里跑构建/测试；扩展文件刻意用本地结构化类型
  （`OmpExtensionApi`/`OmpContext`，见文件头注释）而不是 `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`，
  以免给 flowcard 的 `package.json` 加依赖、也避免 `tsc --noEmit` 找不到模块。
