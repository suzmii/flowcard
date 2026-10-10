/**
 * 「开工」编排：建 worktree → 绑到卡片 → 写开工提示 → 在桌面上把会话跑起来。
 *
 * 用户要的是「创建卡片 = 创建会话」，所以这套东西由**服务端在开卡后自动执行**，
 * 不是让人再点一个按钮。任何一步失败都**不静默**：往卡片上写一条评论说明失败原因与
 * 可手动执行的命令，卡片状态不动（还是「待开工」，看得见）。
 *
 * 依赖全部注入，便于单测（不碰真 git / 真终端）。
 */
import { join } from "node:path";
import type { Card, Project, WorktreeRef } from "../shared/types.ts";
import { cardBrief, writeBriefFile } from "./brief.ts";
import {
  createWorktree,
  launchSession,
  resolveOmpPath,
  type CreateWorktreeResult,
  type LaunchSessionResult,
  type WorktreePlan,
} from "./launch.ts";

export type AutostartDeps = {
  getCard: (id: string) => Card | undefined;
  getProject: (id: string) => Project | undefined;
  /** 绑 worktree（走 store.execute({cmd:"worktree"})）。 */
  bindWorktree: (cardId: string, ref: WorktreeRef) => Promise<void>;
  /** 往卡片写一条评论（留痕失败原因）。 */
  comment: (cardId: string, body: string) => Promise<void>;
  dataDir: string;
  /** omp 上报扩展的绝对路径；给了就显式 `-e` 它。 */
  adapterPath?: string | undefined;
  cli?: string | undefined;
  io?: {
    createWorktree?: typeof createWorktree;
    launchSession?: typeof launchSession;
    resolveOmpPath?: typeof resolveOmpPath;
    writeBrief?: typeof writeBriefFile;
  };
};

export type AutostartOutcome = {
  status: "started" | "skipped" | "failed";
  worktree?: { path: string; branch: string; created: boolean };
  terminal?: { ok: boolean; terminal?: string; command?: string };
  briefPath?: string;
  /** 给 UI/调用方看的简短结论。 */
  summary: string;
};

/** worktree 目录名与分支名：都用卡片 id，稳定且好认（`.worktrees/c7`、`feat/c7`）。 */
export function worktreePlanFor(card: Card, project: Project): WorktreePlan {
  return {
    repoPath: project.path,
    path: join(project.path, ".worktrees", card.id),
    branch: `feat/${card.id}`,
    ...(project.defaultBranch ? { base: project.defaultBranch } : {}),
  };
}

/** 卡片是否已经有会话在跑（有就别再起一个终端）。 */
export function hasLiveSession(card: Card): boolean {
  return card.session !== null && (card.session.state === "running" || card.session.state === "idle");
}

export async function autostartCard(cardId: string, deps: AutostartDeps): Promise<AutostartOutcome> {
  const card = deps.getCard(cardId);
  if (!card) return { status: "skipped", summary: `卡片 ${cardId} 不存在` };

  const project = deps.getProject(card.projectId);
  if (!project || project.virtual === true || project.path === "") {
    return { status: "skipped", summary: "卡片不属于任何 git 项目（未归属），没有 worktree 可建" };
  }
  if (hasLiveSession(card)) {
    return { status: "skipped", summary: "卡片已有会话在跑，不再重复启动" };
  }

  const plan = worktreePlanFor(card, project);
  const doCreate = deps.io?.createWorktree ?? createWorktree;
  const doLaunch = deps.io?.launchSession ?? launchSession;
  const doResolveOmp = deps.io?.resolveOmpPath ?? resolveOmpPath;
  const doWriteBrief = deps.io?.writeBrief ?? writeBriefFile;

  // ---- 1) worktree：已绑且目录还在 → 直接用；否则建
  let worktree: { path: string; branch: string; created: boolean } | undefined;
  const bound = card.worktree;
  if (bound && bound.path === plan.path) {
    worktree = { path: bound.path, branch: bound.branch, created: false };
  } else {
    const created: CreateWorktreeResult = await doCreate(plan);
    if (!created.ok) {
      await deps.comment(
        cardId,
        `自动开工失败：建 worktree 没成（${created.reason}）——${created.message}\n\n手动补：\n\`\`\`bash\ngit -C ${project.path} worktree add ${plan.path} -b ${plan.branch}${plan.base ? ` ${plan.base}` : ""}\n\`\`\``,
      );
      return { status: "failed", summary: `建 worktree 失败：${created.message}` };
    }
    worktree = { path: created.path, branch: created.branch, created: true };
    const ref: WorktreeRef = { path: created.path, branch: created.branch, source: "flowcard" };
    await deps.bindWorktree(cardId, ref);
  }

  // ---- 2) 开工提示：把"当前状态 + 要做的事"写进文件，启动时注入系统提示
  const fresh = deps.getCard(cardId) ?? card;
  const brief = cardBrief({
    card: fresh,
    project,
    worktree,
    ...(deps.cli ? { cli: deps.cli } : {}),
  });
  const briefPath = join(deps.dataDir, "briefs", `${cardId}.md`);
  await doWriteBrief(briefPath, brief);

  // ---- 3) 起会话（在 worktree 里，桌面上开终端）
  const ompPath = await doResolveOmp();
  const launched: LaunchSessionResult = await doLaunch({
    worktreePath: worktree.path,
    harness: "omp",
    ...(ompPath ? { ompPath } : {}),
    ...(deps.adapterPath ? { adapterPath: deps.adapterPath } : {}),
    briefPath,
    kickoff: `开工：你是卡片 ${cardId} 的会话，先按系统提示里「接下来你要做的」逐步执行，每步用 flowcard comment 留痕。`,
  });

  if (!launched.ok) {
    await deps.comment(
      cardId,
      `自动开工：worktree 好了（\`${worktree.path}\`），但**没起来会话**（${launched.reason}）——${launched.message}\n\n手动起：\n\`\`\`bash\ncd ${worktree.path} && omp -e ${deps.adapterPath ?? "<adapter>"}\n\`\`\``,
    );
    return {
      status: "failed",
      worktree,
      briefPath,
      summary: `worktree 已就绪，但会话没起来：${launched.message}`,
    };
  }

  await deps.comment(
    cardId,
    `已在桌面上启动会话：\`${worktree.branch}\` @ \`${worktree.path}\`（提示词见 \`${briefPath}\`）`,
  );
  return {
    status: "started",
    worktree,
    briefPath,
    terminal: { ok: true, ...(launched.terminal ? { terminal: launched.terminal } : {}), ...(launched.command ? { command: launched.command } : {}) },
    summary: `已建 worktree 并启动会话（${launched.terminal}）`,
  };
}
