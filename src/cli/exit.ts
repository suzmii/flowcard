/**
 * CLI 的**唯一出口**（`main.ts` / `sync.ts` 共用）。
 *
 * 背景：`process.stdout.write(text); process.exit()` 在输出超过管道缓冲（Linux 64 KiB）时**静默截断**
 * —— `process.exit()` 不等异步写排空，读端（omp 的 bash 工具、`| cat`、`| python3 -m json.tool`）
 * 拿到半截 JSON（实测 `flowcard list` 的 157 KB 只剩 65536，还会断在半个 UTF-8 字符处）。
 * 所以所有出口都走这里：**先把整段写完（管道排空），再退**。
 *
 * 两个入口，按调用点能不能 await 分：
 *   · `finish(text, code)`：异步上下文用（`return finish(...)`），写完真的退出；
 *   · `abort(text, code)`：同步上下文用（`die` 这种要参与类型收窄、没法 await 的地方）——
 *     写完抛 `ExitSignal`，由最外层 `runCli` 统一收尾（flush 之后再 exit）。
 *     两者输出与退出码完全一致，只是"谁来收尾"不同。
 */

/** `abort` 抛出的退出哨兵：只是把退出码带出去，不是错误。 */
export class ExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

let stdoutGuarded = false;

/**
 * `| head -1` 之类读端提前关掉时，stdout 会 emit `error`（EPIPE）。
 * 没有监听者的话 Node 会把它变成"未处理的错误事件"（栈追踪 + 退出码 1），
 * 而这里本来就是"读完就退"的正常场景 —— 安静地按原退出码收场。
 */
function guardStdout(): void {
  if (stdoutGuarded) return;
  stdoutGuarded = true;
  process.stdout.on("error", () => process.exit(process.exitCode ?? 0));
}

/** 打完再退：大 JSON（list/show/写命令的响应体/sync 的事实清单）必须等管道排空。 */
export async function finish(text: string, code: number): Promise<never> {
  guardStdout();
  process.exitCode = code;
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
  process.exit(code);
}

/** 同步出口：写完挂上退出码再抛哨兵，由 `runCli` 收尾（`never` 让调用点的类型收窄照旧生效）。 */
export function abort(text: string, code: number): never {
  guardStdout();
  process.exitCode = code;
  process.stdout.write(text);
  throw new ExitSignal(code);
}

/**
 * CLI 的顶层包装：把 `abort` 的哨兵收成"flush 完再 exit"；别的异常原样抛（真 bug 要看得见栈）。
 */
export async function runCli(entry: () => Promise<void>): Promise<void> {
  try {
    await entry();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    // 栅栏：往 stdout 写一个空串，等它的回调（回调按写入顺序触发）→ 前面所有字节都排空了。
    await new Promise<void>((resolve) => {
      process.stdout.write("", () => resolve());
    });
    process.exit(error.code);
  }
}
