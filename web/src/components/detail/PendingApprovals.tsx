/**
 * 待处理的审批 / 门禁，**就地**给出批准与驳回 —— 对话界面里不必退出去看板点。
 *
 * 数据来自卡片投影已有的两个字段（见 `lib/approvals.ts`）：`card.confirmations` 里 `pending` 的
 * G2 远程写申请、`card.gates` 里 `open` 的门禁（G3 验收 / G4 清理…）。决定发给的也是看板那两颗
 * 按钮同一条命令（`POST /api/commands` 的 `decideConfirm` / `decideGate`），没有新端点。
 *
 * 没有待办时 **什么都不渲染**（对话里不摆空壳）。
 */
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  approvalDetails,
  approvalSummary,
  pendingApprovals,
  submitApproval,
  type ApprovalDecision,
  type ApprovalRun,
  type PendingApproval,
} from "@/lib/approvals";
import type { CardView } from "@/lib/schema";
import { cn, timeAgo } from "@/lib/utils";
import { Lock, ShieldCheck, XCircle } from "lucide-react";

const KIND_LABELS: Record<PendingApproval["kind"], string> = { confirm: "远程写确认", gate: "门禁" };

function ApprovalRow({
  item,
  busy,
  onDecide,
}: {
  item: PendingApproval;
  /** 这张卡上正在处理的那条（按钮一起禁用，避免连点两条） */
  busy: boolean;
  onDecide: (item: PendingApproval, decision: ApprovalDecision, reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const summary = approvalSummary(item);
  const details = approvalDetails(item);
  const command = item.kind === "confirm" ? "decideConfirm" : "decideGate";

  return (
    <div
      className="space-y-2 rounded-lg border-2 border-amber-500/60 bg-amber-50/60 p-2.5 dark:bg-amber-950/20"
      data-testid={`pending-item-${item.id}`}
      data-kind={item.kind}
      data-command={command}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Lock className="size-3.5 text-amber-700" />
        <span className="font-mono text-xs font-semibold">{item.id}</span>
        <Badge variant="warning">{KIND_LABELS[item.kind]}</Badge>
        <span className="text-sm font-medium">{summary.title}</span>
        {summary.requester ? (
          <span className="text-xs text-muted-foreground">{summary.requester}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(item.requestedAt)}</span>
      </div>

      {item.kind === "confirm" ? (
        <pre
          className="whitespace-pre-wrap break-all rounded border bg-background p-2 font-mono text-xs"
          data-testid={`pending-detail-${item.id}`}
        >
          {summary.hint}
        </pre>
      ) : (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{summary.hint}</div>
          {details.length > 0 ? (
            <ul className="rounded border bg-background p-2">
              {details.map((detail) => (
                <li key={detail} className="font-mono text-xs">
                  {detail}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={reason}
          placeholder="理由（可空；驳回时建议写清为什么）"
          onChange={(event) => setReason(event.target.value)}
          className="flex-1"
          data-testid={`pending-reason-${item.id}`}
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onDecide(item, "approved", reason)}
          data-testid={`pending-approve-${item.id}`}
        >
          <ShieldCheck />
          批准
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide(item, "rejected", reason)}
          data-testid={`pending-reject-${item.id}`}
        >
          <XCircle />
          驳回
        </Button>
      </div>
    </div>
  );
}

export function PendingApprovals({
  card,
  run,
  onRefresh,
  className,
}: {
  card: CardView;
  /**
   * 看板那边的 `CommandRunner`（`CardDetail` 的 `run`）：给了就走它 —— 忙状态、失败提示、
   * 命令之后的刷新都归它。**不给**（对话界面里就是这种）就自己 `POST /api/commands`。
   */
  run?: ApprovalRun;
  /** 自己 POST 成功之后叫父层重拉卡片；投影回来这条待办就消失了 */
  onRefresh?: () => Promise<void> | void;
  className?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  /** 服务端已确认落地的决定：即使卡片投影还没刷新，也不留在待办里（换卡时清空） */
  const [settled, setSettled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettled([]);
    setError(null);
  }, [card.id]);

  const decide = useCallback(
    async (item: PendingApproval, decision: ApprovalDecision, reason: string) => {
      setBusy(item.id);
      setError(null);
      const outcome = await submitApproval({
        cardId: card.id,
        item,
        decision,
        reason,
        ...(run ? { run } : {}),
      });
      if (outcome.settled) {
        setSettled((prev) => [...prev, item.id]);
        await onRefresh?.();
      } else if (outcome.error) {
        setError(outcome.error);
      }
      setBusy(null);
    },
    [card.id, run, onRefresh],
  );

  const items = pendingApprovals(card).filter((item) => !settled.includes(item.id));
  if (items.length === 0) return null;

  return (
    <div
      className={cn("space-y-2 rounded-lg border border-amber-500/50 bg-amber-100/40 p-2", className)}
      data-testid="pending-approvals"
      data-count={items.length}
    >
      <div className="flex items-center gap-2">
        <Lock className="size-3.5 text-amber-700" />
        <span className="text-xs font-semibold">待你审批</span>
        <Badge variant="warning">{items.length}</Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          决定发 POST /api/commands（与看板同一个命令）
        </span>
      </div>

      {items.map((item) => (
        <ApprovalRow
          key={`${item.kind}-${item.id}`}
          item={item}
          busy={busy !== null}
          onDecide={(target, decision, reason) => void decide(target, decision, reason)}
        />
      ))}

      {error ? (
        <p className="text-xs text-red-600" data-testid="pending-approvals-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
