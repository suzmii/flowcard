/** 入口：起服务（默认只监听回环）。 */
import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { personalFlow } from "../flow/personal.ts";
import { createApp } from "./app.ts";
import { createStore } from "./store.ts";

const dataDir =
  process.env.FLOWCARD_DATA_DIR ?? `${homedir()}/.local/share/flowcard`;
const host = process.env.FLOWCARD_HOST ?? "127.0.0.1";
const port = Number(process.env.FLOWCARD_PORT ?? "47825");

const store = createStore({ dataDir, flow: personalFlow });
const app = createApp(store);
const cards = store.listCards().length;

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`flowcard 已启动 http://${host}:${info.port}  （数据 ${dataDir}，卡片 ${cards} 张）`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    store.close();
    process.exit(0);
  });
}
