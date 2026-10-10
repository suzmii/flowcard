/**
 * 「当前在干啥」：把卡片上那一堆事实（会话/运行时/待批/交付要件/远端动态）压成
 * **几条能一眼看懂的信号** + 一行「下一步」。
 *
 * 纯函数、不碰 React，便于单测；磁贴只展示前两条（省地方），详情页头部展示完整短句。
 * 顺序即优先级：**需要你动手的排最前**，其次是"正在动"，最后才是"还没开始"。
 */
import type { CardView } from "@/lib/schema";

export type ActivityTone = "muted" | "info" | "success" | "warning" | "danger";

export type ActivitySignal = {
  key: string;
  /** 徽标上的短词。 */
  label: string;
  tone: ActivityTone;
  /** 鼠标悬停时的补充说明。 */
  detail?: string;
};

/** 会话失联多久算失联：与设计里 90s TTL 对齐（心跳按 30s 分桶，丢两次就算失联）。 */
const LOST_AFTER_MS = 90_000;

function minutesSince(iso: string, now: number): number {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.round((now - at) / 60_000));
}

export function cardActivity(card: CardView, now = Date.now()): ActivitySignal[] {
  const out: ActivitySignal[] = [];
  const session = card.session;
  const runtime = card.runtime;

  // —— 终态与异常：先说话
  if (card.state === "dropped") {
    out.push({ key: "dropped", label: "已放弃", tone: "muted" });
    return out;
  }
  if (card.state === "done") {
    out.push({
      key: "done",
      label: "已完成",
      tone: "success",
      ...(card.cleanedAt ? { detail: `现场清理于 ${card.cleanedAt}` } : {}),
    });
    return out;
  }
  if (card.state === "blocked") {
    out.push({ key: "blocked", label: "阻塞", tone: "danger", ...(card.blockedReason ? { detail: card.blockedReason } : {}) });
  }

  // —— 需要你动手：排最前
  const openGates = Object.values(card.gates).filter((gate) => gate.status === "open");
  if (openGates.length > 0) {
    out.push({
      key: "gates",
      label: `等你拍板 ${openGates.map((g) => g.id).join("+")}`,
      tone: "warning",
      detail: openGates.map((g) => g.title).join(" / "),
    });
  }
  const pendingConfirms = card.confirmations.filter((c) => c.status === "pending");
  const unusedConfirms = card.confirmations.filter((c) => c.status === "approved" && !c.consumedAt);
  if (pendingConfirms.length > 0) {
    out.push({ key: "confirm-pending", label: `${pendingConfirms.length} 条远程写待批`, tone: "warning" });
  } else if (unusedConfirms.length > 0) {
    out.push({
      key: "confirm-unused",
      label: `${unusedConfirms.length} 条授权可用`,
      tone: "info",
      detail: unusedConfirms.map((c) => c.detail).join(" / "),
    });
  }

  // —— 远端动态
  const unread = card.remoteComments.filter((c) => !c.read).length;
  if (unread > 0) {
    out.push({ key: "remote", label: `${unread} 条新评论`, tone: "info", detail: "同步自远端，打开详情即标已读" });
  }
  const outdated = card.review.comments.filter((c) => c.outdated).length;
  if (outdated > 0) {
    out.push({ key: "review-outdated", label: `${outdated} 条评审已过期`, tone: "muted" });
  }
  if (card.review.verdict?.decision === "request_changes") {
    out.push({ key: "review-rc", label: "评审要求改", tone: "warning" });
  }

  // —— 谁在动
  if (session) {
    if (session.state === "running" || session.state === "idle") {
      const inside = card.worktree ? session.cwd.startsWith(card.worktree.path) : false;
      out.push({ key: "session", label: "会话在干活", tone: "success", detail: `${session.harness} · ${session.cwd}` });
      out.push(
        inside
          ? { key: "session-cwd", label: "在 worktree 内", tone: "success" }
          : { key: "session-cwd", label: "不在 worktree 内", tone: "danger", detail: `cwd=${session.cwd}，应在 worktree 里干活` },
      );
    } else if (session.state === "lost") {
      out.push({
        key: "session-lost",
        label: `会话失联 ${minutesSince(session.lastSeenAt, now)} 分钟`,
        tone: "danger",
        detail: "心跳超过 90s 没来；可能是终端关了或进程没了",
      });
    } else if (session.state === "ended" && card.state === "review") {
      out.push({ key: "session-ended", label: "会话已结束，等你验收", tone: "warning" });
    }
  } else if (card.state === "working" || card.state === "ready") {
    out.push({ key: "no-session", label: "还没在干活", tone: "muted" });
  }

  if (runtime?.status === "running") {
    out.push({
      key: "runtime",
      label: `项目在跑${runtime.ports?.length ? `（${runtime.ports.join("/")}）` : ""}`,
      tone: "success",
    });
  } else if (runtime?.status === "failed") {
    out.push({ key: "runtime-failed", label: "运行时失败", tone: "danger" });
  }

  // —— 交付侧
  if (card.state === "review" && card.pr?.state === "merged") {
    out.push({ key: "wait-cleanup", label: "已合并，等清理确认", tone: "warning" });
  }
  if (card.state === "merged") {
    out.push({ key: "cleanup", label: "等清理确认（G4）", tone: "warning" });
  }

  return out;
}

/** 一行「下一步」：缺什么说什么；都不缺就说等谁。 */
export function cardNextStep(card: CardView): string {
  if (card.state === "dropped") return "已放弃";
  if (card.state === "done") return "完成";
  if (card.state === "blocked") return `等前置：${card.blockedReason ?? "未写明"}`;

  const openGate = Object.values(card.gates).find((gate) => gate.status === "open");
  if (openGate) return `等你${openGate.title}（${openGate.id}）`;
  if (card.confirmations.some((c) => c.status === "pending")) return "等你批远程写";
  if (card.state === "review") {
    if (card.pr?.state === "merged") return "等你确认清理（G4）";
    return card.acceptedAt ? "等合并 PR" : "等你验收";
  }
  if (card.state === "merged") return "等你确认清理（G4）";

  if (!card.worktree) return "建 worktree（会话自己起名，建完用 flowcard worktree 登记）";
  if (!card.issue) return "绑 Issue（只填编号）";
  if (!card.pr) return "开 WIP PR（先申请远程写确认）";
  if (card.pushes.length === 0) return "推一次并记录（flowcard push）";
  const session = card.session;
  if (!session || session.state === "ended" || session.state === "lost") return "起会话（在 worktree 里）";
  if (card.worktree && !session.cwd.startsWith(card.worktree.path)) return "把会话切进 worktree（/wt 或 /move）";
  return "干活，做完 flowcard end 交回";
}
