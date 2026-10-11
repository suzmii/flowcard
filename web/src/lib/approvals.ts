/**
 * 待处理审批 / 门禁：**数据全部来自卡片投影里已有的字段，服务端不需要新字段**。
 *
 *   - G2 远程写确认 → `card.confirmations` 里 `status === "pending"` 的那几条（`Confirmation`）
 *   - 门禁（G3 验收 / G4 清理…）→ `card.gates` 里 `status === "open"` 的那几条（`Gate`，按 id 的 record）
 *
 * 这两个字段本来就在 `GET /api/cards` / `GET /api/cards/:id` 的响应里（看板的 `ConfirmPanel` /
 * `GatePanel` 就是读它们画的），所以「对话界面里能就地批准」只要复用同一份数据 + 同一条命令即可。
 *
 * 命令只有两条，都走 `POST /api/commands`（**不另造端点**）：
 *   - 确认 → `{ cmd: "decideConfirm", actor, card, id, decision, reason? }`
 *   - 门禁 → `{ cmd: "decideGate",    actor, card, gate, decision, reason? }`
 * 命令构造只在这一处写：看板的面板与 `PendingApprovals` 都从这里取，避免三份 payload 各自漂移。
 */
import { postCommand } from "@/lib/api";
import type { Confirmation, Gate } from "@/lib/contract";
import { CONFIRM_ACTION_LABELS } from "@/lib/contract";
import type { CardView } from "@/lib/schema";

export type ApprovalDecision = "approved" | "rejected";

/** 一条待办：远程写确认，或一道未决门禁。 */
export type PendingApproval =
  | { kind: "confirm"; id: string; requestedAt: string; confirmation: Confirmation }
  | { kind: "gate"; id: string; requestedAt: string; gate: Gate };

/** 门禁分四类（G3 验收 / G4 清理 / 批准类 / 确认类）。 */
export const GATE_KIND_LABELS: Record<Gate["kind"], string> = {
  approve: "批准类",
  confirm: "确认类",
  review: "验收类",
  cleanup: "清理类",
};

/**
 * 卡片上还没被处理的审批 / 门禁，按申请时间从早到晚（先来先处理）。
 * 已决的（确认 `approved|rejected`、门禁 `approved|rejected`）不进这个列表 —— 待办里不留旧账。
 */
export function pendingApprovals(card: CardView): PendingApproval[] {
  const confirmations: PendingApproval[] = card.confirmations
    .filter((confirmation) => confirmation.status === "pending")
    .map((confirmation) => ({
      kind: "confirm" as const,
      id: confirmation.id,
      requestedAt: confirmation.requestedAt,
      confirmation,
    }));

  const gates: PendingApproval[] = Object.values(card.gates)
    .filter((gate) => gate.status === "open")
    .map((gate) => ({ kind: "gate" as const, id: gate.id, requestedAt: gate.requestedAt, gate }));

  return [...confirmations, ...gates].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

/** 一条待办的一行文案（列表里显示什么）。 */
export function approvalSummary(item: PendingApproval): {
  /** 主标题：确认是动作名（推送 / 合并…），门禁是它的标题（验收 / 清理确认…） */
  title: string;
  /** 副标题：确认给 detail，门禁给 kind 中文名 */
  hint: string;
  /** 谁在等：`omp 申请` 这种；门禁没有申请人时是空串 */
  requester: string;
} {
  if (item.kind === "confirm") {
    const by = item.confirmation.requestedBy;
    return {
      title: CONFIRM_ACTION_LABELS[item.confirmation.action] ?? item.confirmation.action,
      hint: item.confirmation.detail,
      requester: `${by.name ?? by.harness ?? by.kind} 申请`,
    };
  }
  return {
    title: item.gate.title,
    hint: GATE_KIND_LABELS[item.gate.kind] ?? item.gate.kind,
    requester: "",
  };
}

/** G4 清理门禁 payload 里的清理清单（`proposeCleanup` 的 items）；别的门禁是空数组。 */
export function gatePayloadItems(gate: Gate): string[] {
  const items = gate.payload?.["items"];
  return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
}

/** 一条待办目前的明细行（确认给"将执行的确切命令/URL"，门禁给清理清单）。 */
export function approvalDetails(item: PendingApproval): string[] {
  return item.kind === "confirm" ? [item.confirmation.detail] : gatePayloadItems(item.gate);
}

export type ApprovalCommand = { label: string; command: Record<string, unknown> };

const humanActor = { kind: "human", name: "me" } as const;

/** G2 确认的决定命令（与看板 `ConfirmPanel` 逐字一致）。 */
export function confirmDecisionCommand(
  cardId: string,
  confirmation: Confirmation,
  decision: ApprovalDecision,
  reason = "",
): ApprovalCommand {
  return {
    label: decision === "approved" ? `批准确认 ${confirmation.id}` : `驳回确认 ${confirmation.id}`,
    command: {
      cmd: "decideConfirm",
      actor: humanActor,
      card: cardId,
      id: confirmation.id,
      decision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    },
  };
}

/** 门禁的决定命令（与看板 `GatePanel` 逐字一致；门禁的键是 `gate`，不是 `id`）。 */
export function gateDecisionCommand(
  cardId: string,
  gate: Gate,
  decision: ApprovalDecision,
  reason = "",
): ApprovalCommand {
  return {
    label: decision === "approved" ? `批准 ${gate.id}` : `驳回 ${gate.id}`,
    command: {
      cmd: "decideGate",
      actor: humanActor,
      card: cardId,
      gate: gate.id,
      decision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    },
  };
}

/** 一条待办 + 决定 → 要发的命令（`PendingApprovals` 的按钮点下去就是发这一条）。 */
export function approvalDecision(
  cardId: string,
  item: PendingApproval,
  decision: ApprovalDecision,
  reason = "",
): ApprovalCommand {
  return item.kind === "confirm"
    ? confirmDecisionCommand(cardId, item.confirmation, decision, reason)
    : gateDecisionCommand(cardId, item.gate, decision, reason);
}

/** 服务端 `POST /api/commands` 的响应里这一块就够 UI 判成败（`rejection` 的形状见 `lib/api.ts`）。 */
export type ApprovalPost = (
  command: Record<string, unknown>,
) => Promise<{ ok: boolean; rejection?: { code?: string; message?: string } }>;

/** 看板那个 `CommandRunner`（`CardDetail` 的 `run`）：外层的忙状态与提示由它自己管。 */
export type ApprovalRun = (
  label: string,
  command: Record<string, unknown>,
) => Promise<{ ok?: boolean; error?: string } | void>;

export type ApprovalOutcome = {
  label: string;
  command: Record<string, unknown>;
  /**
   * 这个决定**确实落到服务端了吗**。`true` 才允许乐观地把这条从待办里拿掉；
   * 外层 runner 不回 `ok` 时是 `false`（未知）—— 那就等卡片投影刷新来收走它。
   */
  settled: boolean;
  error?: string;
};

/**
 * 发一条决定。
 * - 给了 `run`（会话视图里没有，看板里有）就走外层 runner：忙状态 / 失败提示 / 刷新都归它，
 *   这里只负责命令构造与判成败；它不回 `ok` 时不猜成败（`settled: false`）。
 * - 没给 `run` 就直接 `post`（默认 `postCommand`，即 `POST /api/commands`）—— 对话界面里就是这条路径。
 */
export async function submitApproval(input: {
  cardId: string;
  item: PendingApproval;
  decision: ApprovalDecision;
  reason?: string;
  run?: ApprovalRun;
  post?: ApprovalPost;
}): Promise<ApprovalOutcome> {
  const { label, command } = approvalDecision(input.cardId, input.item, input.decision, input.reason);

  if (input.run) {
    try {
      const out = await input.run(label, command);
      if (out && out.ok === false) {
        return { label, command, settled: false, error: out.error ?? `${label}失败` };
      }
      return { label, command, settled: out?.ok === true };
    } catch (error) {
      return { label, command, settled: false, error: `${label}失败：${String(error)}` };
    }
  }

  let result: { ok: boolean; rejection?: { code?: string; message?: string } };
  try {
    result = await (input.post ?? postCommand)(command);
  } catch (error) {
    return { label, command, settled: false, error: `${label}失败：连不上 flowcard 服务（${String(error)}）` };
  }
  if (result.ok) return { label, command, settled: true };
  const rejection = result.rejection;
  return {
    label,
    command,
    settled: false,
    error: rejection
      ? `${label}失败（${rejection.code ?? "未知"}）：${rejection.message ?? "未知错误"}`
      : `${label}失败`,
  };
}
