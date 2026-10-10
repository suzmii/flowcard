import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * 前端构建配置。
 * 关键点：dev server 必须把 /api 代理到后端，否则浏览器会被 CORS 挡掉。
 * 默认 127.0.0.1:47825（flowcard 服务默认端口），可用 FLOWCARD_PORT / FLOWCARD_API_TARGET 覆盖。
 */
const apiTarget =
  process.env.FLOWCARD_API_TARGET ??
  `http://127.0.0.1:${process.env.FLOWCARD_PORT ?? "47825"}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: Number(process.env.FLOWCARD_WEB_PORT ?? "5273"),
    strictPort: false,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // SSE 必须禁用缓冲/保持长连接
        ws: false,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
