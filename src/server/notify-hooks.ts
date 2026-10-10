/**
 * 通知 hook：把人那边 / 远端发生的事，**投成一条人话消息给这张卡的托管会话**。三个来源共用一套通道：
 *
 *   1. **审批**：人在看板上批准 / 驳回（`decideGate` / `decideConfirm` / `accept`，`actor.kind === "human"`）；
 *   2. **CI 结束**：绑定的 PR 的 CI 从 `pending` 变成 `pass` / `fail`（失败要带失败的 job 名与链接）；
 *   3. **远端新评论**：绑定的 issue / PR 上出现新评论（带作者、链接、正文摘要）。
 *
 * 三条纪律（用户定的，三类通知都一样）：
 *   1. **不阻塞、不抛错、失败只留痕**：hook 在命令 / 同步**成功之后**异步跑，绝不让调用方等它；
 *      内部出错只走 `warn`（默认 `console.error`），不改变命令与同步本身的成败。
 *   2. **只投一次**：幂等键按来源定（审批 = 那次决定；CI = `ci:<pr>:<sha>:<结论>`；
 *      评论 = `comment:<issue|pr>:<远端评论 id>`），已投递的键与待补投的通知都记在卡片的
 *      **投递台账**里（`store` 的 meta 表，key `approval:<card>`，不进事件流）。重复轮询到同一状态不重投。
 *   3. **会话不在线不静默丢**：写一条卡片评论说明它，并把通知记成 pending，
 *      等这张卡下次 `session.start` / 下一次 `prompt` 时自动补投一次。
 *
 * 判定与文案都是**纯函数**（`approvalSpec` / `approvalNotice` / `ciNotice` / `commentNotice` /
 * `candidateSpec`），IO 只在 `createNotifyHooks` 那个壳里 —— 所以能单独测（`test/notify-hooks.test.ts`）。
 *
 * 开关：`FLOWCARD_NOTIFY_HOOKS=0` 关掉（默认开）；旧的 `FLOWCARD_APPROVAL_HOOKS=0` **仍然有效**
 * （兼容 —— 它当年只管审批，现在等于总开关），见 `notifyHooksEnabled`。
 */
import { STATE_LABELS, type Card, type Command } from "../shared/types.ts";
import type { NewEvent } from "./project.ts";
import type { ApprovalLedger, ApprovalNotice } from "./store.ts";
import type { CiJob } from "./sync.ts";

// ---------------------------------------------------------------- 通用：一条待投的通知

/** 投递台账里攒下来的通知抬头（分不出它原来是谁的，只说明"还没转达出去"）。 */
export const NOTIFY_PENDING_PREFIX = "【通知·待转达】";
/** 审批通知沿用最早那个抬头（只针对审批那一类）。 */
export const APPROVAL_PENDING_PREFIX = "【审批通知·待转达】";

/** 一条要投给会话的通知（`key` = 幂等键，全局唯一）。 */
export type NoticeSpec = {
  key: string;
  cardId: string;
  text: string;
  /** 会话不在线时写那条卡片评论的抬头（默认 `NOTIFY_PENDING_PREFIX`）。 */
  pendingPrefix?: string;
};

// ---------------------------------------------------------------- 审批：判定（纯）

/** 一次「人的审批决定」：投给 agent 的那条通知 + 它的幂等键。 */
export type ApprovalSpec = {
  /** 幂等键（含卡片 id，全局唯一）：同一个决定只打扰 agent 一次。 */
  key: string;
  cardId: string;
  decision: "approved" | "rejected";
  /** 人给的理由（驳回必须有；批准可选）。 */
  reason?: string;
  /** 流程门禁（G3 验收 / G4 清理）：`id` 是门禁名，`kind`（验收/清理）从卡片投影上读。 */
  gate?: { id: string };
  /** G2 远程写确认（`id` 形如 `cf1`）：起因、将执行什么，都从卡片上的确认里读。 */
  confirm?: { id: string };
  pendingPrefix: string;
};

/**
 * 这条命令是不是「人刚做的一次审批决定」，是的话给出幂等键。
 *
 * 取的是**真的落库了的**事件（`store.execute` 的 `inserted`），不是命令本身：
 * 门禁已经决策过、卡片已经验收过时引擎会直接跳过（一条事件都不写），那种重发不算新决定。
 */
export function approvalSpec(cmd: Command, events: readonly NewEvent[]): ApprovalSpec | null {
  // 人点的才算：agent / 系统自己调这三条是在跑流程，不是在审批。
  if (cmd.actor.kind !== "human") return null;

  if (cmd.cmd === "accept") {
    if (!events.some((e) => e.type === "card.accepted")) return null;
    return {
      key: `approval:${cmd.card}:accept`,
      cardId: cmd.card,
      decision: "approved",
      pendingPrefix: APPROVAL_PENDING_PREFIX,
      ...(cmd.reason ? { reason: cmd.reason } : {}),
    };
  }

  if (cmd.cmd === "decideGate") {
    const decided = events.find((e) => e.type === "gate.decided");
    if (!decided) return null;
    const gate = typeof decided.payload.gate === "string" ? decided.payload.gate : null;
    const decision = decided.payload.decision;
    if (gate === null || (decision !== "approved" && decision !== "rejected")) return null;
    const reason = typeof decided.payload.reason === "string" ? decided.payload.reason : undefined;
    return {
      key: `approval:${cmd.card}:gate:${gate}:${decision}`,
      cardId: cmd.card,
      decision,
      pendingPrefix: APPROVAL_PENDING_PREFIX,
      ...(reason ? { reason } : {}),
      gate: { id: gate },
    };
  }

  if (cmd.cmd === "decideConfirm") {
    const decided = events.find((e) => e.type === "confirm.decided");
    if (!decided) return null;
    const id = typeof decided.payload.id === "string" ? decided.payload.id : null;
    const decision = decided.payload.decision;
    if (id === null || (decision !== "approved" && decision !== "rejected")) return null;
    const reason = typeof decided.payload.reason === "string" ? decided.payload.reason : undefined;
    return {
      key: `approval:${cmd.card}:confirm:${id}:${decision}`,
      cardId: cmd.card,
      decision,
      pendingPrefix: APPROVAL_PENDING_PREFIX,
      ...(reason ? { reason } : {}),
      confirm: { id },
    };
  }

  return null;
}

// ---------------------------------------------------------------- 审批：文案（纯）

/** 理由那一句（没有就不写 —— 别留一个"理由："的空壳让人猜）。 */
function reasonLine(reason: string | undefined): string {
  return reason && reason.trim() !== "" ? `理由：${reason.trim()}` : "";
}

/** 门禁的名字：优先流程里的标题（"验收" / "清理确认"），退到 id。 */
function gateName(spec: ApprovalSpec, card: Card): string {
  const id = spec.gate?.id ?? "";
  const title = id === "" ? undefined : card.gates[id]?.title;
  return title ? `${id} ${title}` : id;
}

/** 门禁是干什么的（`review` 验收 / `cleanup` 清理）：只有门禁决策事件，所以从卡片投影上读。 */
function gateKind(spec: ApprovalSpec, card: Card): string {
  const id = spec.gate?.id;
  return id === undefined ? "" : (card.gates[id]?.kind ?? "");
}

/** 验收通过之后的"下一步"：**按卡片当前状态给**，不硬写死。 */
function afterAcceptance(card: Card): string {
  switch (card.state) {
    case "merged":
      return `下一步：先提清理清单 —— \`flowcard cleanup ${card.id} --item "要删的东西"\`，等人批准 G4 后执行 \`flowcard cleanup ${card.id}\`。`;
    case "done":
      return "下一步：现场已经清理完、卡片已完成，不用再动手。";
    case "review":
      return "下一步：等 PR 合并 —— 合并后卡片自动进「已合并待清理」并打开 G4，那时再提清理清单。";
    default:
      return `下一步：卡片现在是「${STATE_LABELS[card.state]}」，按它继续往前推。`;
  }
}

/**
 * 一次审批决定 → 给 agent 的人话通知（纯函数）。
 *
 * 三件事必须都在：**决定**（通过还是驳回）、**理由**（有就带）、**下一步该做什么**。
 */
export function approvalNotice(spec: ApprovalSpec, card: Card): string {
  const reason = reasonLine(spec.reason);
  const approved = spec.decision === "approved";

  // —— G2 远程写确认：一次授权只覆盖一次动作，批的/驳的都是"这一件事"。
  if (spec.confirm) {
    const id = spec.confirm.id;
    const confirmation = card.confirmations.find((c) => c.id === id);
    const detail = confirmation?.detail.trim() ?? "";
    const action = confirmation?.action ?? "other";
    const what = detail === "" ? `${id}（${action}）` : `${id}（将执行：${detail}）`;
    const open = `【flowcard 审批通知】人${approved ? "批准" : "驳回"}了远程写授权 ${what}。`;
    if (approved) {
      return [
        open,
        reason,
        `下一步：现在可以执行它；执行完请 \`flowcard confirm ${card.id} --consume ${id}\` 作废这次授权（一次批准只覆盖一次动作，再写一次要重新申请）。`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    return [
      open,
      reason,
      `下一步：**不要执行**这次远程写。如果你仍然认为有必要，改 detail（写清将要执行的确切命令或 URL）后重新申请一次：\`flowcard confirm ${card.id} --request --for ${action} --detail "…"\`。`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 清理门禁（G4）：批的就是"可以拆现场了"。
  if (spec.gate && gateKind(spec, card) === "cleanup") {
    const name = gateName(spec, card);
    if (approved) {
      return [
        `【flowcard 审批通知】人已批准清理（${name}）。`,
        reason,
        card.cleanedAt
          ? "下一步：清理已经完成（卡片已「完成」）。"
          : `下一步：现在可以执行清理：\`flowcard cleanup ${card.id}\` 记账，然后把现场清掉（worktree / 分支 / 临时文件）—— 完成后卡片自动进「完成」。`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    }
    return [
      `【flowcard 审批通知】人已驳回清理（${name}）。`,
      reason,
      `下一步：**不要拆现场**（worktree / 分支都留着）。如果你仍然认为有必要清理，把理由说清楚后重新提一次清单：\`flowcard cleanup ${card.id} --item "要删的东西"\`，等人再批一次。`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 不认识的流程门禁：说清决定与状态，不硬套"验收/清理"的说法。
  if (spec.gate && gateKind(spec, card) !== "review") {
    const name = gateName(spec, card);
    const open = `【flowcard 审批通知】人已${approved ? "批准" : "驳回"}门禁 ${name}。`;
    const next = approved
      ? afterAcceptance(card)
      : `下一步：**不要**按"已经通过"往下走。如果你仍然认为有必要，把理由说清楚后重新申请一次。`;
    return [open, reason, next]
      .filter((line) => line !== "")
      .join("\n");
  }

  // —— 验收门禁（G3）/ `accept`：批的是"这活我认了"。
  const name = spec.gate ? gateName(spec, card) : "G3 验收";
  if (approved) {
    return [`【flowcard 审批通知】人已验收（${name} 通过）。`, reason, afterAcceptance(card)]
      .filter((line) => line !== "")
      .join("\n");
  }
  return [
    `【flowcard 审批通知】人已驳回验收（${name}）。`,
    reason,
    `下一步：**不要**按「已经验收」往下走（别合并、别拆现场）。如果你仍然认为有必要，把下面说的东西补上 / 改掉之后，再请人验收一次（看板上点「验收」，或 \`flowcard accept ${card.id}\`）。`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------- 同步侧：候选（纯数据）

/**
 * 同步轮询算出来的「值得打扰 agent 的事」。**只带事实**：远端没给（网络失败 / 字段缺失）
 * 就不进这个列表 —— 宁可不说，不要猜。
 */
export type NotifyCandidate =
  | {
      kind: "ci";
      cardId: string;
      /** 结论属于哪个 PR / 哪个 commit（幂等键 = `ci:<pr>:<sha>:<结论>`）。 */
      pr: { number: number; sha: string; conclusion: "pass" | "fail"; url: string };
      /** 只带**失败**的 job（名字 + 链接）；空的 = 远端没给 job 明细。 */
      jobs: readonly CiJob[];
    }
  | {
      kind: "comment";
      cardId: string;
      /** `number` = 评论挂在哪个编号上（issue / PR 共用一个号池，按卡片的槽位判它是哪个）。 */
      comment: { id: number; number: number; author: string; body: string; at: string; url: string };
    };

// ---------------------------------------------------------------- CI：文案（纯）

/** 失败 job 最多列几个（多了只会计数，别把通知刷成一片 URL）。 */
export const MAX_LISTED_JOBS = 5;

/** CI 结束 → 给 agent 的人话通知（纯函数）：结论、失败的 job（名字 + 链接）、下一步。 */
export function ciNotice(input: {
  cardId: string;
  pr: { number: number; sha: string; conclusion: "pass" | "fail"; url: string };
  jobs: readonly CiJob[];
}): string {
  const { pr, jobs, cardId } = input;
  const passed = pr.conclusion === "pass";
  const sha = pr.sha === "" ? "" : `（commit ${pr.sha.slice(0, 12)}）`;
  const lines = [
    `【flowcard 通知】CI 结束了：PR #${pr.number} 的 CI ${passed ? "**通过**（pass）" : "**失败**（fail）"}${sha}。`,
  ];
  if (!passed) {
    const failed = jobs.filter((job) => job.conclusion === "fail");
    if (failed.length === 0) {
      lines.push("失败的 job 名远端没给（自己去 PR 页面看详情）。");
    } else {
      const listed = failed
        .slice(0, MAX_LISTED_JOBS)
        .map((job) => (job.url === "" ? job.name : `${job.name}（${job.url}）`));
      const rest = failed.length - listed.length;
      lines.push(`失败 job：${listed.join("、")}${rest > 0 ? `；还有 ${rest} 个没列` : ""}`);
    }
  }
  lines.push(
    passed
      ? `下一步：看一下还有没有 review 意见；都处理完就请人验收（看板点「验收」，或 \`flowcard accept ${cardId}\`）。`
      : "下一步：看一眼失败日志；改完推上去 CI 会重跑。",
  );
  if (pr.url !== "") lines.push(`链接：${pr.url}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- 评论：文案 + 跳过自己（纯）

/** 评论摘要上限（超了截断 —— 通知不该变成一份转录）。 */
export const COMMENT_SUMMARY_MAX = 240;

/** 正文摘要：折掉换行/连续空白（消息里一行读完），超长截断。 */
export function summarize(text: string, max = COMMENT_SUMMARY_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return "（空）";
  return clean.length <= max ? clean : `${clean.slice(0, max)}…（截断）`;
}

/** 作者名的比对形态：去 `@`、去空白、小写。 */
function normAuthor(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

/**
 * 这张卡上「自己」的身份集合：会话的 harness / agentKind / id，加上这张卡上 agent 留过的
 * 名字（harness / sessionId / name）。**人（我）的评论不在里面** —— 人的评论要投。
 *
 * `extra` 是额外补充（例如 agent 用的是某个固定的 forge 账号，见 `FLOWCARD_NOTIFY_SELF_AUTHORS`）。
 */
export function selfAuthors(card: Card, extra: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  const add = (value: string | undefined): void => {
    if (value === undefined) return;
    const name = normAuthor(value);
    if (name !== "") out.add(name);
  };
  add(card.session?.harness);
  add(card.session?.agentKind);
  add(card.session?.id);
  for (const comment of card.comments) {
    if (comment.actor.kind !== "agent") continue;
    add(comment.actor.name);
    add(comment.actor.harness);
    add(comment.actor.sessionId);
  }
  for (const value of extra) add(value);
  return out;
}

/** 这条远端评论是不是"自己发的"（自己回的评论不该把自己吵醒）。作者名空 = 认不出，不当自己。 */
export function isSelfComment(card: Card, author: string, extra: readonly string[] = []): boolean {
  const name = normAuthor(author);
  return name !== "" && selfAuthors(card, extra).has(name);
}

/** 新评论 → 给 agent 的人话通知（纯函数）：谁、在哪、链接、正文摘要。 */
export function commentNotice(input: {
  cardId: string;
  kind: "issue" | "pr";
  comment: { number: number; author: string; body: string; at: string; url: string };
}): string {
  const { comment, kind, cardId } = input;
  const who = comment.author === "" ? "有人" : comment.author;
  const where = kind === "pr" ? `PR #${comment.number}` : `Issue #${comment.number}`;
  const lines = [`【flowcard 通知】${who} 在${where}上留言了。`];
  if (comment.url !== "") lines.push(`链接：${comment.url}`);
  lines.push(`正文（摘要）：${summarize(comment.body)}`);
  lines.push(
    `下一步：读一遍再决定要不要回 —— 要回就在远端评论（或 \`flowcard comment ${cardId} --body "…"\` 记一句本地说明）。`,
  );
  return lines.join("\n");
}

/**
 * 一个同步候选 → 一条待投的通知；**不该投的返回 null**：
 *   · 评论是自己发的（作者 == 这张卡的 agent 身份）→ 不投；
 *   · 卡片不在 / 编号对不上槽位 → 调用方先过滤，这里只在评论路由上兜底。
 */
export function candidateSpec(
  candidate: NotifyCandidate,
  card: Card,
  extraSelf: readonly string[] = [],
): NoticeSpec | null {
  if (candidate.kind === "ci") {
    const { pr, jobs } = candidate;
    return {
      key: `ci:${pr.number}:${pr.sha}:${pr.conclusion}`,
      cardId: candidate.cardId,
      text: ciNotice({ cardId: candidate.cardId, pr, jobs }),
      pendingPrefix: NOTIFY_PENDING_PREFIX,
    };
  }
  const { comment } = candidate;
  if (isSelfComment(card, comment.author, extraSelf)) return null;
  const kind: "issue" | "pr" = card.pr?.number === comment.number ? "pr" : "issue";
  return {
    key: `comment:${kind}:${comment.id}`,
    cardId: candidate.cardId,
    text: commentNotice({ cardId: candidate.cardId, kind, comment }),
    pendingPrefix: NOTIFY_PENDING_PREFIX,
  };
}

// ---------------------------------------------------------------- 投递（带 IO）

/** 会话投递的最小依赖（`HostedSessions.prompt` 的形状）。 */
export type NoticeDelivery = { ok: boolean; error?: { code?: string; message?: string } };

export type NotifyHookDeps = {
  /** 开关：`FLOWCARD_NOTIFY_HOOKS=0` 关（默认开）。关掉时所有方法都是空操作。 */
  enabled: boolean;
  getCard: (id: string) => Card | undefined;
  /** 这张卡的托管会话现在活着吗（活着就直接投，省一次评论）。 */
  isLive: (cardId: string) => boolean;
  /** 往托管会话投一条消息（会按需 `-r` 续接；失败返回 `ok:false`，不抛）。 */
  prompt: (cardId: string, text: string) => Promise<NoticeDelivery>;
  /** 写一条卡片评论（降级留痕）：走 `/api/commands` 的 comment 那条路。 */
  comment: (cardId: string, body: string) => void;
  /** 投递台账（store 的 meta 表）：已投递的幂等键 + 待补投的通知。 */
  ledger: {
    get: (cardId: string) => ApprovalLedger;
    set: (cardId: string, ledger: ApprovalLedger) => void;
  };
  /** 落了评论之后通知看板重拉（可选）。 */
  notify?: (cardId: string, types: string[]) => void;
  /** 失败只留痕（默认 `console.error`）。 */
  warn?: (message: string) => void;
  now?: () => string;
  /** 每张卡最多记多少个已投递的幂等键（超出丢最老的）。 */
  maxDelivered?: number;
  /** 额外算作「自己」的远端作者名（`FLOWCARD_NOTIFY_SELF_AUTHORS`，逗号分隔）。 */
  selfAuthors?: readonly string[];
};

export type NotifyHooks = {
  /**
   * 命令成功后调它：**不 await**（内部自己排队投递），失败只留痕。
   * `events` 传真的落库了的那些（`store.execute` 的 `inserted`）。
   */
  onCommand: (input: { cmd: Command; card: Card | undefined; events: readonly NewEvent[] }) => void;
  /** 同步一轮算出来的候选（CI 结束 / 新评论）：**不 await**，同一张卡串行。 */
  onSync: (candidates: readonly NotifyCandidate[]) => void;
  /** 会话起来 / 要发言之前补投 pending（返回这次补投了几条）。同一张卡的投递串行。 */
  flush: (cardId: string) => Promise<number>;
  /** 测试用：等所有在飞的投递结束。 */
  settle: () => Promise<void>;
  enabled: boolean;
};

/** `FLOWCARD_APPROVAL_HOOKS=0` 关掉（默认开）—— 与 `FLOWCARD_AUTOSTART` 一个写法。 */
function approvalHooksEnabled(env: Record<string, string | undefined>): boolean {
  return (env.FLOWCARD_APPROVAL_HOOKS ?? "").trim() !== "0";
}

/**
 * 通知 hook 的总开关：`FLOWCARD_NOTIFY_HOOKS=0` 关（默认开）。
 * 旧的 `FLOWCARD_APPROVAL_HOOKS=0` 仍然有效 —— 它当年只管审批，现在等于同一件事（兼容保留）。
 */
export function notifyHooksEnabled(env: Record<string, string | undefined>): boolean {
  return approvalHooksEnabled(env) && (env.FLOWCARD_NOTIFY_HOOKS ?? "").trim() !== "0";
}

/** `FLOWCARD_NOTIFY_SELF_AUTHORS=a,b`：额外算「自己」的远端作者名（可选）。 */
export function notifySelfAuthors(env: Record<string, string | undefined>): string[] {
  return (env.FLOWCARD_NOTIFY_SELF_AUTHORS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

const DEFAULT_MAX_DELIVERED = 500;
const MAX_PENDING = 50;

export function createNotifyHooks(deps: NotifyHookDeps): NotifyHooks {
  const warn = deps.warn ?? ((message: string) => console.error(`[notify-hook] ${message}`));
  const now = deps.now ?? (() => new Date().toISOString());
  const maxDelivered = deps.maxDelivered ?? DEFAULT_MAX_DELIVERED;
  const extraSelf = deps.selfAuthors ?? [];

  const inflight = new Set<Promise<unknown>>();
  /** 每张卡一条串行链：`flush` 与投递都在改同一份台账，别让它们互相覆盖。 */
  const chains = new Map<string, Promise<unknown>>();

  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise);
    void promise.finally(() => inflight.delete(promise)).catch(() => undefined);
    return promise;
  };

  /** 同一张卡上的操作排队跑（前一个失败不挡后一个）；链跑完就把表项清掉，别让表随卡片数无限长。 */
  const serialize = <T>(cardId: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.get(cardId) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    chains.set(cardId, tail);
    void tail.finally(() => {
      if (chains.get(cardId) === tail) chains.delete(cardId);
    });
    return next;
  };

  const deliver = async (cardId: string, text: string): Promise<boolean> => {
    try {
      const result = await deps.prompt(cardId, text);
      if (result.ok) return true;
      warn(`投递失败（卡片 ${cardId}）：${result.error?.message ?? "未知原因"}`);
      return false;
    } catch (error) {
      warn(`投递抛错（卡片 ${cardId}）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const markDelivered = (cardId: string, key: string): void => {
    const ledger = deps.ledger.get(cardId);
    const delivered = [...ledger.delivered.filter((k) => k !== key), key].slice(-maxDelivered);
    deps.ledger.set(cardId, { ...ledger, delivered });
  };

  /** 降级：记 pending + 写一条评论（会话不在线时，评论就是这条通知唯一的可见痕迹）。 */
  const degrade = (spec: NoticeSpec): void => {
    const ledger = deps.ledger.get(spec.cardId);
    if (!ledger.pending.some((p) => p.key === spec.key)) {
      const notice: ApprovalNotice = { key: spec.key, text: spec.text, at: now() };
      deps.ledger.set(spec.cardId, {
        ...ledger,
        pending: [...ledger.pending, notice].slice(-MAX_PENDING),
      });
    }
    try {
      const prefix = spec.pendingPrefix ?? NOTIFY_PENDING_PREFIX;
      deps.comment(spec.cardId, `${prefix}${spec.text}`);
      deps.notify?.(spec.cardId, ["card.comment.added"]);
    } catch (error) {
      warn(`写卡片评论失败（卡片 ${spec.cardId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** 投一条（或降级留痕）。同一张卡串行，幂等键查一遍台账。 */
  const enqueue = async (spec: NoticeSpec): Promise<void> => {
    await serialize(spec.cardId, async () => {
      const ledger = deps.ledger.get(spec.cardId);
      // 幂等：同一条通知（已投出去、或还在队列里等补投）只打扰 agent 一次。
      if (ledger.delivered.includes(spec.key) || ledger.pending.some((p) => p.key === spec.key)) return;
      if (deps.isLive(spec.cardId) && (await deliver(spec.cardId, spec.text))) {
        markDelivered(spec.cardId, spec.key);
        return;
      }
      degrade(spec);
    });
  };

  const flush = async (cardId: string): Promise<number> => {
    if (!deps.enabled) return 0;
    return serialize(cardId, async () => {
      const ledger = deps.ledger.get(cardId);
      if (ledger.pending.length === 0) return 0;
      // 这里**不看 `isLive`**：进程没了但会话文件还在的（崩溃 / 服务重启）也能 `-r` 续接，
      // 投递本身会把它拉起来；真续不起来 `prompt` 会返回 `ok:false`，那就原样留着等下次。
      const left: ApprovalNotice[] = [];
      let sent = 0;
      for (const notice of ledger.pending) {
        // 前一条没投出去就都留着（顺序即决定顺序），等下一次机会。
        if (left.length > 0) {
          left.push(notice);
          continue;
        }
        if (ledger.delivered.includes(notice.key)) continue;
        if (await deliver(cardId, notice.text)) {
          sent++;
          markDelivered(cardId, notice.key);
        } else {
          left.push(notice);
        }
      }
      const after = deps.ledger.get(cardId);
      deps.ledger.set(cardId, { ...after, pending: left });
      return sent;
    });
  };

  return {
    enabled: deps.enabled,
    onCommand: (input) => {
      if (!deps.enabled) return;
      track(
        (async () => {
          const spec = approvalSpec(input.cmd, input.events);
          if (!spec) return;
          const card = input.card ?? deps.getCard(spec.cardId);
          if (!card) {
            warn(`卡片 ${spec.cardId} 不在，跳过审批通知`);
            return;
          }
          await enqueue({ ...spec, text: approvalNotice(spec, card) });
        })(),
      );
    },
    onSync: (candidates) => {
      if (!deps.enabled) return;
      track(
        (async () => {
          for (const candidate of candidates) {
            const card = deps.getCard(candidate.cardId);
            if (!card) {
              warn(`卡片 ${candidate.cardId} 不在，跳过 ${candidate.kind} 通知`);
              continue;
            }
            const spec = candidateSpec(candidate, card, extraSelf);
            if (!spec) continue; // 自己发的评论：不投
            await enqueue(spec);
          }
        })(),
      );
    },
    flush: (cardId) => track(flush(cardId)),
    settle: async () => {
      for (let round = 0; round < 50 && inflight.size > 0; round++) {
        await Promise.all([...inflight]);
      }
    },
  };
}
