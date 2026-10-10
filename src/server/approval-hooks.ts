/**
 * 审批 hook：人在看板上做完决定（批准 / 驳回）之后，**自动把一条人话通知投给这张卡的托管会话** ——
 * 让在另一端干活的 agent 知道"人已经批了 / 人已经驳回了"，不用人再跑去终端里喊一遍。
 *
 * 三条纪律（用户定的）：
 *   1. **不阻塞、不抛错、失败只留痕**：hook 在 `/api/commands` 成功之后异步跑，绝不让审批请求等它；
 *      内部出错只走 `warn`（默认 `console.error`），不改变审批本身的成败。
 *   2. **只投一次**：幂等键 = 那次决定本身（门禁 id + 决定 / 确认 id + 决定 / accept）；
 *      已投递的键与待补投的通知都记在卡片的**投递台账**里（`store` 的 meta 表，不进事件流）。
 *   3. **会话不在线不静默丢**：写一条卡片评论说明这个决定，并把通知记成 pending，
 *      等这张卡下次 `session.start` / 下一次 `prompt` 时自动补投一次。
 *
 * 谁能触发：`decideGate` / `decideConfirm` / `accept` 三条命令，且 `actor.kind === "human"`。
 * agent 自己在看板外调这三条（比如自动化脚本）不算"人的审批"，不通知自己。
 *
 * 文案是**纯函数**（`approvalNotice`），"下一步该做什么"按卡片当前状态给，所以能单独测
 * （见 `test/approval-hooks.test.ts`）。
 */
import { STATE_LABELS, type Card, type Command } from "../shared/types.ts";
import type { NewEvent } from "./project.ts";
import type { ApprovalLedger, ApprovalNotice } from "./store.ts";

// ---------------------------------------------------------------- 判定（纯）

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
      ...(reason ? { reason } : {}),
      confirm: { id },
    };
  }

  return null;
}

// ---------------------------------------------------------------- 文案（纯）

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

// ---------------------------------------------------------------- 投递（带 IO）

/** 会话投递的最小依赖（`HostedSessions.prompt` 的形状）。 */
export type NoticeDelivery = { ok: boolean; error?: { code?: string; message?: string } };

export type ApprovalHookDeps = {
  /** 开关：`FLOWCARD_APPROVAL_HOOKS=0` 关（默认开）。关掉时所有方法都是空操作。 */
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
};

export type ApprovalHooks = {
  /**
   * 命令成功后调它：**不 await**（内部自己排队投递），失败只留痕。
   * `events` 传真的落库了的那些（`store.execute` 的 `inserted`）。
   */
  onCommand: (input: { cmd: Command; card: Card | undefined; events: readonly NewEvent[] }) => void;
  /** 会话起来 / 要发言之前补投 pending（返回这次补投了几条）。同一张卡的投递串行。 */
  flush: (cardId: string) => Promise<number>;
  /** 测试用：等所有在飞的投递结束。 */
  settle: () => Promise<void>;
  enabled: boolean;
};

/** `FLOWCARD_APPROVAL_HOOKS=0` 关掉（默认开）—— 与 `FLOWCARD_AUTOSTART` 一个写法。 */
export function approvalHooksEnabled(env: Record<string, string | undefined>): boolean {
  return (env.FLOWCARD_APPROVAL_HOOKS ?? "").trim() !== "0";
}

const DEFAULT_MAX_DELIVERED = 500;
const MAX_PENDING = 50;

export function createApprovalHooks(deps: ApprovalHookDeps): ApprovalHooks {
  const warn = deps.warn ?? ((message: string) => console.error(`[approval-hook] ${message}`));
  const now = deps.now ?? (() => new Date().toISOString());
  const maxDelivered = deps.maxDelivered ?? DEFAULT_MAX_DELIVERED;

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

  /** 降级：记 pending + 写一条评论（会话不在线时，评论就是这个决定唯一的可见痕迹）。 */
  const degrade = (spec: ApprovalSpec, text: string): void => {
    const ledger = deps.ledger.get(spec.cardId);
    if (!ledger.pending.some((p) => p.key === spec.key)) {
      const notice: ApprovalNotice = { key: spec.key, text, at: now() };
      deps.ledger.set(spec.cardId, {
        ...ledger,
        pending: [...ledger.pending, notice].slice(-MAX_PENDING),
      });
    }
    try {
      deps.comment(spec.cardId, `【审批通知·待转达】${text}`);
      deps.notify?.(spec.cardId, ["card.comment.added"]);
    } catch (error) {
      warn(`写卡片评论失败（卡片 ${spec.cardId}）：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const run = async (input: {
    cmd: Command;
    card: Card | undefined;
    events: readonly NewEvent[];
  }): Promise<void> => {
    if (!deps.enabled) return;
    const spec = approvalSpec(input.cmd, input.events);
    if (!spec) return;
    const card = input.card ?? deps.getCard(spec.cardId);
    if (!card) {
      warn(`卡片 ${spec.cardId} 不在，跳过审批通知`);
      return;
    }
    await serialize(spec.cardId, async () => {
      const ledger = deps.ledger.get(spec.cardId);
      // 幂等：同一个决定（已投出去、或还在队列里等补投）只打扰 agent 一次。
      if (ledger.delivered.includes(spec.key) || ledger.pending.some((p) => p.key === spec.key)) return;
      const text = approvalNotice(spec, card);
      if (deps.isLive(spec.cardId) && (await deliver(spec.cardId, text))) {
        markDelivered(spec.cardId, spec.key);
        return;
      }
      degrade(spec, text);
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
      track(run(input));
    },
    flush: (cardId) => track(flush(cardId)),
    settle: async () => {
      for (let round = 0; round < 50 && inflight.size > 0; round++) {
        await Promise.all([...inflight]);
      }
    },
  };
}
