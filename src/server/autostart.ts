/**
 * 「开工」编排：写开工提示到文件 → 起一个**托管会话**（`omp --mode rpc --no-ui` 子进程）→ 第一条 prompt
 * 让会话自己去 `read` 那份提示。
 *
 * 两件事的分工（用户定的，2026-10 起）：
 *   · worktree 由 **AI 自己建**（名字得它按任务起）——写进开工提示的第一步，做没做在清单里看得见；
 *   · 会话**进** worktree 由 **flowcard 自己做**：`flowcard worktree use <card> --path <worktree>` 会
 *     登记 worktree、停掉当前会话、用新 cwd `-r` 续接（斜杠命令 `/wt`、`/move` 模型调不了，这条死路已废）。
 * flowcard 负责的是把会话起起来、把「现状 + 待办」喂给它、并在失败时**不静默**地留痕。
 *
 * 提示的注入方式（用户定的，2026-10）：开工提示**不占 argv**（`--append-system-prompt` 每轮请求都要
 * 重发一遍全文，3KB 白白烧着）—— 提示写到 `<dataDir>/briefs/<card>.md`，第一条 prompt 只说一句
 * 「先 read 这个文件（绝对路径），按里面的待办执行」，效果等同"注入一次 tool use"。都不需要终端窗口。
 *
 * 依赖全部注入，便于单测（不碰真 omp）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Card, Project } from "../shared/types.ts";
import { briefKickoff, writeCardBrief, type BriefWriteIo } from "./brief.ts";
import type { HostedSessionStatus, HostedSessions } from "./hosted-session.ts";

export type AutostartDeps = {
  getCard: (id: string) => Card | undefined;
  getProject: (id: string) => Project | undefined;
  /** 往卡片写一条评论（留痕失败原因）。 */
  comment: (cardId: string, body: string) => Promise<void>;
  dataDir: string;
  /** 托管会话注册表：开工 = 起一个托管 omp RPC 会话（**不再弹终端**）。 */
  sessions: HostedSessions;
  cli?: string | undefined;
  io?: {
    writeBrief?: BriefWriteIo["writeBrief"];
  };
};

export type AutostartOutcome = {
  status: "started" | "skipped" | "failed";
  /** 会话起在哪儿（没 worktree 时就是项目根，AI 之后自己切进 worktree）。 */
  cwd?: string;
  /** 托管会话的起步状态：`starting` 之后由 `GET .../session` 与 SSE 接着报。 */
  session?: { ok: boolean; status: HostedSessionStatus; ompSessionId?: string };
  briefPath?: string;
  /** 给 UI/调用方看的简短结论。 */
  summary: string;
};

/** 卡片是否已经有会话在跑（有就别再起一个）。 */
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
  if (hasLiveSession(card) || deps.sessions.isLive(cardId)) {
    return { status: "skipped", summary: "卡片已有会话在跑，不再重复启动" };
  }

  // worktree 还没绑（或目录已经没了）时，会话先起在项目根：AI 读完提示会自己建 worktree 并切进去
  const bound = card.worktree;
  const cwd = bound && existsSync(bound.path) ? bound.path : project.path;
  if (bound && cwd !== bound.path) {
    await deps.comment(
      cardId,
      `卡片绑着 worktree \`${bound.path}\`，但那个目录不存在了：会话这次起在项目根，请先重建 worktree 再切进去。`,
    );
  }

  // ---- 1) 开工提示：把"当前状态 + 还缺什么"写进文件（**不进 argv**，kickoff 只说去 read 它）
  const fresh = deps.getCard(cardId) ?? card;
  const cli = deps.cli ?? "flowcard";
  const briefPath = await writeCardBrief({
    briefDir: join(deps.dataDir, "briefs"),
    card: fresh,
    project,
    cli,
    ...(deps.io?.writeBrief === undefined ? {} : { io: { writeBrief: deps.io.writeBrief } }),
  });

  // ---- 2) 起托管会话（cwd 在 worktree 里，或先落在项目根）
  const started = await deps.sessions.start(cardId, { cwd, kickoff: briefKickoff(briefPath, cli) });

  if (!started.ok) {
    const reason = started.error?.message ?? "未知原因";
    await deps.comment(
      cardId,
      `自动开工：**没起来会话**（${started.error?.code ?? "UNKNOWN"}）——${reason}\n\n` +
        `再试一次：看板上这张卡的「起会话」；或自己在 \`${cwd}\` 里起 omp，再 ` +
        `\`flowcard claim ${cardId} --harness omp --session <id> --cwd ${cwd}\`。`,
    );
    return {
      status: "failed",
      cwd,
      briefPath,
      session: { ok: false, status: started.status },
      summary: `会话没起来：${reason}`,
    };
  }

  await deps.comment(
    cardId,
    `已托管会话（工作目录 \`${cwd}\`，提示词见 \`${briefPath}\`）：worktree 由会话自己按提示创建并登记。`,
  );
  return {
    status: "started",
    cwd,
    briefPath,
    session: {
      ok: true,
      status: started.status,
      ...(started.ompSessionId === undefined ? {} : { ompSessionId: started.ompSessionId }),
    },
    summary: `已托管会话（${started.status}），worktree 交给会话自己建`,
  };
}
