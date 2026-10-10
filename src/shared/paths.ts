/** 路径工具：纯字符串运算，不碰 fs（引擎是纯函数，测试要能离线跑）。 */

/** 折叠重复斜杠、去掉末尾斜杠（根路径除外）。不做 resolve，调用方负责传绝对路径。 */
export function normalizePath(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

/** child 是否在 parent 之内（严格：/a/bc 不算在 /a/b 内）。 */
export function isInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  return c.startsWith(p === "/" ? "/" : `${p}/`);
}
