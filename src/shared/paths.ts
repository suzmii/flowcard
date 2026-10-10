/** 路径工具：纯字符串运算 + 只读环境（home/cwd），不碰 fs（引擎是纯函数，测试要能离线跑）。 */
import { homedir } from "node:os";
import { resolve } from "node:path";

/** 折叠重复斜杠、去掉末尾斜杠（根路径除外）。不做 resolve，调用方负责传绝对路径。 */
export function normalizePath(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

/**
 * 人手输的路径 → 绝对路径：开头的 `~` 展开成 home、相对路径按 `base` 解析、再折叠斜杠。
 * 项目登记/解析都从人给的字符串出发（CLI 的 `--path`、看板输入框），所以这一步是必须的：
 * `~` 与相对路径直接丢给 git 会变成"看起来不在仓库里"的怪错误。
 */
export function resolveUserPath(input: string, base: string = process.cwd()): string {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? `${homedir()}/${input.slice(2)}` : input;
  return normalizePath(resolve(base, expanded));
}

/** child 是否在 parent 之内（严格：/a/bc 不算在 /a/b 内）。 */
export function isInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  return c.startsWith(p === "/" ? "/" : `${p}/`);
}
