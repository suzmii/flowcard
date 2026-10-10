/**
 * 会话启动的**残留辅助**：找 omp 可执行文件、找 omp 上报扩展的路径。
 *
 * 起会话那一步已经不在这里了：flowcard 直接把 `omp --mode rpc --no-ui` 当**自己的子进程**起
 * （`src/server/hosted-session.ts`），网页通过 HTTP/SSE 跟它对话，**不再弹终端窗口**
 * （原来那套 konsole/gnome-terminal/… 的 argv 拼装与 `bash -lc` 引号转义连同它的测试一起删了）。
 *
 * 分层与 probe.ts/picker.ts 一致：纯函数拼 argv，薄 IO 可注入，测试不依赖真终端。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export type RunResult = { code: number; stdout: string; stderr: string; missing: boolean };
export type RunFn = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

/** 只用来探"omp 在哪"这类一次性问题。 */
const defaultRun: RunFn = async (file, args, opts) => {
  try {
    const { stdout, stderr } = await run(file, args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 5000,
      maxBuffer: 1 << 20,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { code: 0, stdout, stderr, missing: false };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    const missing = e.code === "ENOENT";
    return {
      code: typeof e.code === "number" ? e.code : missing ? 127 : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (missing ? `${file}: 未安装` : String(error)),
      missing,
    };
  }
};

/** 取第一行非空文本（诊断信息只留一行）。 */
export function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

/** 上报扩展的绝对路径：服务端自己知道装在哪（本仓 `src/adapters/omp/`）。 */
export function defaultAdapterPath(): string {
  return fileURLToPath(new URL("../adapters/omp/flowcard-omp-adapter.ts", import.meta.url));
}

/** 从 PATH 或常见位置找 omp 的绝对路径（找不到就交给子进程 PATH 里的 `omp`）。 */
export async function resolveOmpPath(opts: { run?: RunFn } = {}): Promise<string | undefined> {
  const runner = opts.run ?? defaultRun;
  const probe = await runner("sh", ["-c", "command -v omp"], { timeoutMs: 2000 });
  const found = probe.code === 0 ? firstLine(probe.stdout) : "";
  if (found !== "") return found;
  const fallback = `${process.env.HOME ?? ""}/.bun/bin/omp`;
  return existsSync(fallback) ? fallback : undefined;
}
