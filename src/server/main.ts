/** 入口：起服务（默认只监听回环）。 */
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import { personalFlow } from "../flow/personal.ts";
import { createApp } from "./app.ts";
import { notifyHooksEnabled } from "./notify-hooks.ts";
import { createHostedSessions } from "./hosted-session.ts";
import { defaultAdapterPath } from "./launch.ts";
import { validatePrompts } from "./prompts.ts";
import { createRuntimeSupervisor } from "./runtime.ts";
import { createStore } from "./store.ts";
import { DEFAULT_SYNC_INTERVAL_MS } from "./syncer.ts";

const dataDir =
  process.env.FLOWCARD_DATA_DIR ?? `${homedir()}/.local/share/flowcard`;
const host = process.env.FLOWCARD_HOST ?? "127.0.0.1";
// 服务没有鉴权，但能起进程/起终端/读 Gitea 凭据 —— 只允许绑回环。
// 真要暴露到局域网，必须显式承认风险（FLOWCARD_ALLOW_REMOTE=1）并自行加反代鉴权。
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK.has(host) && process.env.FLOWCARD_ALLOW_REMOTE !== "1") {
  console.error(
    `拒绝绑定 ${host}：本服务无鉴权且能起进程/读凭据，只允许回环。` +
      `确实要暴露请设 FLOWCARD_ALLOW_REMOTE=1（并自行在反代上加鉴权）。`,
  );
  process.exit(2);
}
const port = Number(process.env.FLOWCARD_PORT ?? "47825");

// 提示词模板（`prompts/*.md`）启动即校验：语法坏 / 缺占位符 / 缺必模板当场拒绝启动 ——
// 别等到第一次起会话才发现提示发不出去（渲染器每次读文件，改完即生效，不用重启）。
try {
  validatePrompts();
} catch (err) {
  console.error(`拒绝启动：${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
}

const store = createStore({ dataDir, flow: personalFlow });
const runtime = createRuntimeSupervisor({ store, dataDir });

// 托管会话：每卡一个 `omp --mode rpc --no-ui` 子进程（网页上直接对话，不弹终端）。
// 上报扩展照旧挂上（心跳/结束上报的兜底），日志按卡片分文件写在数据目录里。
const sessions = createHostedSessions({
  store,
  adapterPath: defaultAdapterPath(),
  logDir: join(dataDir, "logs"),
  // 开工提示（`<dataDir>/briefs/<card>.md`）：搬进 worktree 之后用它刷新那份提示。
  briefDir: join(dataDir, "briefs"),
});

/**
 * 通知 hook：审批（人批了 / 驳了）、CI 结束、远端新评论 → 自动给这张卡的托管会话发一条人话通知。
 * 默认开，`FLOWCARD_NOTIFY_HOOKS=0` 关（关掉后流程照常，只是不通知 agent）；旧的
 * `FLOWCARD_APPROVAL_HOOKS=0` 仍然有效（它当年只管审批，现在等于同一个开关）。
 */
const notifyHooksOn = notifyHooksEnabled(process.env);

/** 后台同步节奏：默认 5 分钟一轮（`FLOWCARD_SYNC_INTERVAL_MS=0` 关掉）。 */
const syncRaw = Number(process.env.FLOWCARD_SYNC_INTERVAL_MS ?? "");
const syncIntervalMs = Number.isFinite(syncRaw) && syncRaw >= 0 ? syncRaw : DEFAULT_SYNC_INTERVAL_MS;
const app = createApp(store, {
  runtime,
  sync: { intervalMs: syncIntervalMs },
  sessions,
  notifyHooks: { enabled: notifyHooksOn },
  // 卡片 git 事实（看板阶段派生用）：只对有 worktree 的卡跑只读 git，结果缓存 30s。
  gitFacts: {},
  autostart: {
    // 默认开；`FLOWCARD_AUTOSTART=0` 关掉（只开卡、不起会话）
    enabled: process.env.FLOWCARD_AUTOSTART !== "0",
    dataDir,
    cli: "flowcard",
  },
});

// 上一次跑挂/被 SIGKILL 时留下的运行时进程组，这里收尾（只收自己起的那些）。
const reaped = await runtime.reapStale();

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  const cards = store.listCards().length;
  const tail = reaped.length > 0 ? `；清理残留运行时 ${reaped.join(", ")}` : "";
  const sync = syncIntervalMs > 0 ? `每 ${Math.round(syncIntervalMs / 1000)}s` : "已关闭";
  const hooks = notifyHooksOn
    ? "开（审批 / CI 结束 / 新评论都会通知托管会话）"
    : "关（FLOWCARD_NOTIFY_HOOKS=0）";
  console.log(
    `flowcard 已启动 http://${host}:${info.port}  （数据 ${dataDir}，卡片 ${cards} 张，同步 ${sync}，通知 hook ${hooks}${tail}）`,
  );
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  // 先收会话：关 stdin → omp 走 EOF 收尾自己退（退之前各自上报 end）。
  await sessions.stopAll();
  const stopped = await runtime.shutdown();
  if (stopped.length > 0) console.log(`已停掉运行时：${stopped.join(", ")}`);
  store.close();
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown();
  });
}

// 异常退出路径的兜底：同步 SIGKILL 自己起过的进程组（走不到就靠下次启动的 reapStale）。
// 托管会话不用兜底：它们的 stdin 是我们持有的管道，我们一死就 EOF，omp 自己收尾退出。
process.on("exit", () => {
  runtime.shutdownSync();
});
