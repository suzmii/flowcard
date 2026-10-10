/**
 * 根测试配置：跑 `src/**`、`test/**` 以及 **web 里的纯逻辑模块**（`web/src/lib/*`，不含 React 组件）。
 * web 的源码用 `@/` 指代 `web/src`（vite.config.ts 里也这么配），所以这里补同一个别名，
 * 免得 web 的 lib 模块在根测试里加载不了。
 */
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./web/src", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "web/src/**/*.test.ts"],
  },
});
