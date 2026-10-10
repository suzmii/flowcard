/**
 * 「开工」编排：写开工提示 → 在桌面上把会话跑起来。
 *
 * 两件事**不由 flowcard 做**（用户定的）：
 *   · worktree 由 **AI 自己建**（名字得它按任务起）——写进开工提示的第一步，做没做在清单里看得见；
 *   · 会话进 worktree 也由 AI 自己切（omp 的 `/wt` / `/move`）。
 * flowcard 负责的是把会话起起来、把「现状 + 待办」喂给它、并在失败时**不静默**地留痕。
 *
 * 依赖全部注入，便于单测（不碰真终端）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Card, Project } from "../shared/types.ts";
import { cardBrief, writeBriefFile } from "./brief.ts";
import { launchSession, resolveOmpPath, type LaunchSessionResult } from "./launch.ts";

export type AutostartDeps = {
  getCard: (id: string) => Card | undefined;
  getProject: (id: string) => Project | undefined;
  /** 往卡片写一条评论（留痕失败原因）。 */
  comment: (cardId: string, body: string) => Promise<void>;
  dataDir: string;
  /** omp 上报扩展的绝对路径；给了就显式 `-e` 它。 */
  adapterPath?: string | undefined;
  cli?: string | undefined;
  io?: {
    launchSession?: typeof launchSession;
    resolveOmpPath?: typeof resolveOmpPath;
    writeBrief?: typeof writeBriefFile;
  };
};

export type AutostartOutcome = {
  status: "started" | "skipped" | "failed";
  /** 会话起在哪儿（没 worktree 时就是项目根，AI 之后自己切进 worktree）。 */
  cwd?: string;
  terminal?: { ok: boolean; terminal?: string; command?: string };
  briefPath?: string;
  /** 给 UI/调用方看的简短结论。 */
  summary: string;
};

/** 卡片是否已经有会话在跑（有就别再起一个终端）。 */
export function hasLiveSession(card: Card): boolean {
  return card.session !== null && (card.session.state === "running" || card.session.state === "idle");
}

export async function autostartCard(cardId: string, deps: AutostartDeps): Promise<AutostartOutcome> {
  try {
    return await autostartInner(cardId, deps);
  } catch (error) {
    // 开卡是主流程，自动开工是"顺手做的事"：这里绝不能让请求 500
    const detail = error instanceof Error ? error.message : String(error);
    await deps
      .comment(cardId, `自动开工时出了意外（已忽略，不影响卡片）：${detail}`)
      .catch(() => undefined);
    return { status: "failed", summary: `自动开工异常：${detail}` };
  }
}

async function autostartInner(cardId: string, deps: AutostartDeps): Promise<AutostartOutcome> {
  const card = deps.getCard(cardId);
  if (!card) return { status: "skipped", summary: `卡片 ${cardId} 不存在` };

  const project = deps.getProject(card.projectId);
  if (!project || project.virtual === true || project.path === "") {
    return { status: "skipped", summary: "卡片不属于任何 git 项目（未归属），没有 worktree 可建" };
  }
  if (hasLiveSession(card)) {
    return { status: "skipped", summary: "卡片已有会话在跑，不再重复启动" };
  }

  const doLaunch = deps.io?.launchSession ?? launchSession;
  const doResolveOmp = deps.io?.resolveOmpPath ?? resolveOmpPath;
  const doWriteBrief = deps.io?.writeBrief ?? writeBriefFile;

  // worktree 还没绑时，会话先起在项目根：AI 读完提示会自己建 worktree 并切进去
  const bound = card.worktree;
  const cwd = bound?.path ?? project.path;
  if (bound && !existsSync(bound.path)) {
    await deps.comment(
      cardId,
      `卡片绑着 worktree \`${bound.path}\`，但那个目录不存在了：会话这次起在项目根，请先重建 worktree 再切进去。`,
    );
  }

  // ---- 2) 开工提示：把"当前状态 + 要做的事"写进文件，启动时注入系统提示
  const fresh = deps.getCard(cardId) ?? card;
  const brief = cardBrief({
    card: fresh,
    project,
    ...(bound ? { worktree: { path: bound.path, branch: bound.branch } } : {}),
    ...(deps.cli ? { cli: deps.cli } : {}),
  });
  const briefPath = join(deps.dataDir, "briefs", `${cardId}.md`);
  await doWriteBrief(briefPath, brief);

  // ---- 3) 起会话（在 worktree 里，桌面上开终端）
  const ompPath = await doResolveOmp();
  const launched: LaunchSessionResult = await doLaunch({
    worktreePath: cwd,
    cardId,
    harness: "omp",
    ...(ompPath ? { ompPath } : {}),
    ...(deps.adapterPath ? { adapterPath: deps.adapterPath } : {}),
    briefPath,
    kickoff: `开工：你是卡片 ${cardId} 的会话，先按系统提示里「接下来你要做的」逐步执行，每步用 flowcard comment 留痕。`,
  });

  if (!launched.ok) {
    await deps.comment(
      cardId,
      `自动开工：**没起来会话**（${launched.reason}）——${launched.message}\n\n手动起：\n\`\`\`bash\ncd ${cwd} && omp -e ${deps.adapterPath ?? "<adapter>"}\n\`\`\``,
    );
    return { status: "failed", cwd, briefPath, summary: `会话没起来：${launched.message}` };
  }

  await deps.comment(
    cardId,
    `已在桌面上启动会话（工作目录 \`${cwd}\`，提示词见 \`${briefPath}\`）：worktree 由会话自己按提示创建并登记。`,
  );
  return {
    status: "started",
    cwd,
    briefPath,
    terminal: { ok: true, ...(launched.terminal ? { terminal: launched.terminal } : {}), ...(launched.command ? { command: launched.command } : {}) },
    summary: `已在桌面启动会话（${launched.terminal}），worktree 交给会话自己建`,
  };
}
