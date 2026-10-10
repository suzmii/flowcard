/** 入口：起服务（默认只监听回环）。 */
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { personalFlow } from "../flow/personal.ts";
import { createApp } from "./app.ts";
import { createRuntimeSupervisor } from "./runtime.ts";
import { createStore } from "./store.ts";
import { defaultAdapterPath } from "./launch.ts";
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

const store = createStore({ dataDir, flow: personalFlow });
const runtime = createRuntimeSupervisor({ store, dataDir });

/** 后台同步节奏：默认 5 分钟一轮（`FLOWCARD_SYNC_INTERVAL_MS=0` 关掉）。 */
const syncRaw = Number(process.env.FLOWCARD_SYNC_INTERVAL_MS ?? "");
const syncIntervalMs = Number.isFinite(syncRaw) && syncRaw >= 0 ? syncRaw : DEFAULT_SYNC_INTERVAL_MS;
const app = createApp(store, {
  runtime,
  sync: { intervalMs: syncIntervalMs },
  autostart: {
    // 默认开；`FLOWCARD_AUTOSTART=0` 关掉（只开卡、不起会话）
    enabled: process.env.FLOWCARD_AUTOSTART !== "0",
    dataDir,
    adapterPath: defaultAdapterPath(),
    cli: "flowcard",
  },
});

// 上一次跑挂/被 SIGKILL 时留下的运行时进程组，这里收尾（只收自己起的那些）。
const reaped = await runtime.reapStale();

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  const cards = store.listCards().length;
  const tail = reaped.length > 0 ? `；清理残留运行时 ${reaped.join(", ")}` : "";
  const sync = syncIntervalMs > 0 ? `每 ${Math.round(syncIntervalMs / 1000)}s` : "已关闭";
  console.log(
    `flowcard 已启动 http://${host}:${info.port}  （数据 ${dataDir}，卡片 ${cards} 张，同步 ${sync}${tail}）`,
  );
});

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
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
process.on("exit", () => {
  runtime.shutdownSync();
});
