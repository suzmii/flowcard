/**
 * **CLI 顶层命令表** —— 单一真相：`flowcard help` 的命令清单从这里生成，
 * Workflow 视图里 `command` 动作节点写的命令也拿这张表核对（`test/workflow.test.ts`：
 * 子命令名必须命中，**不许编造命令**）。
 *
 * 加命令只改这里 + `main.ts` 的 dispatch；别在别处再抄一份清单。
 */

export type CliCommandSpec = {
  name: string;
  /** 一句话：这个命令干什么（人话）。 */
  describe: string;
  /** 位置子命令（`flowcard <name> <sub>`）；空数组 = 没有子命令。 */
  subs: readonly string[];
};

export const CLI_COMMANDS: readonly CliCommandSpec[] = [
  { name: "open", describe: "建卡（立项，正文 + 归属项目）", subs: [] },
  { name: "issue", describe: "给卡片绑 Issue", subs: [] },
  { name: "gate", describe: "决定门禁（G3 验收 / G4 清理，--approve / --reject）", subs: [] },
  { name: "confirm", describe: "远程写授权：--request / --approve / --reject / --consume", subs: [] },
  { name: "worktree", describe: "worktree 操作（绑路径与分支）", subs: ["use"] },
  { name: "session", describe: "托管会话操作", subs: ["delete"] },
  { name: "claim", describe: "认领卡片（起会话）", subs: [] },
  { name: "beat", describe: "会话心跳（harness 上报）", subs: [] },
  { name: "pr", describe: "绑 / 改 PR 引用", subs: [] },
  { name: "push", describe: "登记一次推送（--sha）", subs: [] },
  { name: "end", describe: "结束会话并交回（要求 PR + 一次推送）", subs: [] },
  { name: "accept", describe: "人验收（G3）", subs: [] },
  { name: "delete", describe: "软删除卡片", subs: [] },
  { name: "restore", describe: "恢复软删除的卡片", subs: [] },
  { name: "drop", describe: "放弃卡片（--reason）", subs: [] },
  { name: "block", describe: "标记阻塞（--reason 写明缺什么）", subs: [] },
  { name: "unblock", describe: "解除阻塞", subs: [] },
  { name: "probe", describe: "只读探测 PR 状态（手工补一次同步）", subs: [] },
  { name: "cleanup", describe: "清理：--item 列清单 = 申请；不带 = 执行", subs: [] },
  { name: "comment", describe: "在卡片上留言（--body）", subs: [] },
  { name: "spawn", describe: "在大需求边界内拆子卡", subs: [] },
  { name: "up", describe: "启动卡片自己的运行时", subs: [] },
  { name: "down", describe: "停止卡片运行时", subs: [] },
  { name: "diff", describe: "读卡片当前 diff（只读）", subs: [] },
  { name: "review", describe: "提交代码评审（评论 / 结论）", subs: [] },
  { name: "detect", describe: "探测本机 harness（只读）", subs: [] },
  { name: "sync", describe: "跑一轮远端同步（Issue / PR / 评论，只读）", subs: [] },
  { name: "list", describe: "列卡片（带 stage）", subs: [] },
  { name: "show", describe: "看一张卡的完整投影", subs: [] },
  { name: "project", describe: "项目管理（看板 Metadata）", subs: ["list", "current", "add", "issue-base"] },
  { name: "attach", describe: "上传附件图片", subs: [] },
];

/**
 * `flowcard <name> [sub]` 是否命中命令表。
 * 返回值就是命中的那条（拿得到 subs 等元信息），没命中返回 `null`。
 */
export function lookupCliCommand(name: string, sub: string | null): CliCommandSpec | null {
  const found = CLI_COMMANDS.find((command) => command.name === name);
  if (!found) return null;
  if (sub === null) return found;
  return found.subs.includes(sub) ? found : null;
}
