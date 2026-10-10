# ADR 0001：技术选型

状态：已接受（2026-10-10）

## 决策

| 项 | 选择 | 理由 | 何时重估 |
|---|---|---|---|
| 语言/运行时 | TypeScript on **Node 22** | 成本在反复打磨流程语义，不在性能；agent 侧的 CLI/skill/HTTP 与前端同栈；本机已有 v22.22.2 | 若要单文件分发，考虑 Bun `--compile` 或 Rust 重写核心 |
| 跑 TS 的方式 | **Node 原生 type stripping**（`node src/server/main.ts`） | 无构建步骤、无 tsx/ts-node 依赖；`--noEmit` 只做类型检查。已验证 v22.22.2 直接可跑 | Node 类型剥离能力不足或需要装饰器等特性时改用 tsx/esbuild |
| 存储 | **SQLite（WAL）**，`node:sqlite` | 单进程单写者最简单；事件表是自动节点的地基。已验证 v22.22.2 可用（experimental 警告） | 撞到 API 缺口换 `better-sqlite3`（接口相近） |
| 服务端 | **Hono + zod** | 路由/校验不手写；zod schema 在 server/CLI/前端共享，契约单一来源；将来可搬 Workers | 若要零依赖，退回 `node:http` |
| 实时 | **SSE** | 只需"状态广播"，EventSource 自带重连 | 需要实时双向（终端输出）时加 WS |
| CLI | TS 单文件 CLI，`--json` + `schemaVersion` + 语义化退出码 | agent 的唯一写入口，契约必须稳定 | — |
| 流程定义 | **TS 代码 DSL**（`defineFlow`） | 用户明确选择：流程要能写条件、要类型安全，不迁就配置格式 | — |
| 引擎 | 自研：`decide(card, event, flow) -> Action[]` 纯函数 | 这是本项目的差异化；纯函数才能把语义钉进单测 | — |
| 测试 | **vitest** | 与现有两个仓库（repo / 前端约定）一致；后续 React 组件测试同一跑子 | 内核若想零依赖可换 `node:test` |
| 前端 | React 19 + Vite + TS + Tailwind/shadcn（沿用现有约定） | 复用组件库与肌肉记忆；拖拽用 dnd-kit，数据用 TanStack Query + SSE | — |
| 数据目录 | `~/.local/share/flowcard/`（XDG，可 `FLOWCARD_DATA_DIR` 覆盖） | dashi 把 DB 塞在安装目录，升级/清理都别扭 | — |
| 运行 | `systemd --user` 常驻，仅回环 | 已有验证过的 unit 形状 | 要局域网/多机时再定 |

## 明确否决

- **agent 框架**（LangChain / LlamaIndex / AI SDK 编排层等）：本系统不调用模型，自动节点是确定性的；agent 执行归 harness。引入只会增加抽象与依赖。
- **自建 `exec` 编排器**（自己 spawn/supervise agent 会话）：第一版不做；subagent 归 harness。
- **抄 dashi 的能力面**：Jira 同步、云同步、桌面壳、Codex CDP 注入、附件/富文本/甘特/i18n 一律不做。
- **抄 dashi 的 `--if-version` 往返**：那边的写是整记录覆盖，需要版本号；这边命令是意图，靠状态校验 + 可选 `--if-state`。

## 后果

- 优点：零构建、依赖极少（hono+zod）、契约可共享、流程语义可单测、单文件数据库便于备份。
- 代价：`node:sqlite` 标注实验性（升级 Node 需回归）；原生 type stripping 不用枚举/装饰器等特性；只有回环监听，无鉴权（单机前提）。
