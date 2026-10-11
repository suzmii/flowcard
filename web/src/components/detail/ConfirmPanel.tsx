import { useState } from "react";
import { CheckSquare, Lock, ShieldCheck, XCircle } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import type { CommandRunner } from "@/components/detail/GatePanel";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmDecisionCommand } from "@/lib/approvals";
import { CONFIRM_ACTION_LABELS, type Confirmation } from "@/lib/contract";
import type { CardView } from "@/lib/schema";
import { timeAgo } from "@/lib/utils";

function PendingConfirm({
  card,
  confirmation,
  busy,
  onRun,
}: {
  card: CardView;
  confirmation: Confirmation;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const [reason, setReason] = useState("");
  const requester = confirmation.requestedBy;

  const decide = (decision: "approved" | "rejected") => {
    const { label, command } = confirmDecisionCommand(card.id, confirmation, decision, reason);
    return void onRun(label, command);
  };

  return (
    <div className="space-y-2 rounded-lg border-2 border-amber-500/60 bg-amber-50/60 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Lock className="size-3.5 text-amber-700" />
        <span className="font-mono text-xs font-semibold">{confirmation.id}</span>
        <Badge variant="warning">{CONFIRM_ACTION_LABELS[confirmation.action]}</Badge>
        <span className="text-xs text-muted-foreground">
          {requester.name ?? requester.harness ?? requester.kind} 申请
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {timeAgo(confirmation.requestedAt)}
        </span>
      </div>

      <div className="rounded border bg-background p-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            将执行的确切命令 / URL
          </span>
          <CopyButton
            value={confirmation.detail}
            label="复制"
            size="xs"
            variant="ghost"
            className="ml-auto"
          />
        </div>
        <pre
          className="whitespace-pre-wrap break-all font-mono text-xs"
          data-testid={`confirm-detail-${confirmation.id}`}
        >
          {confirmation.detail}
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={reason}
          placeholder="理由（驳回必填）"
          onChange={(event) => setReason(event.target.value)}
          className="flex-1"
          data-testid={`confirm-reason-${confirmation.id}`}
        />
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => decide("approved")}
          data-testid={`confirm-approve-${confirmation.id}`}
        >
          <ShieldCheck />
          批准
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => decide("rejected")}
          data-testid={`confirm-reject-${confirmation.id}`}
        >
          <XCircle />
          驳回
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        一次授权只覆盖一次动作：agent 执行完会回报 consume，之后这条授权作废 · 看板不执行远程写
      </p>
    </div>
  );
}

function DecidedConfirm({
  card,
  confirmation,
  busy,
  onRun,
}: {
  card: CardView;
  confirmation: Confirmation;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const usable = confirmation.status === "approved" && !confirmation.consumedAt;
  // 已决状态：**已批准没 consume**（凭据还在）与「已经用掉」必须一眼分得开。
  const status: { label: string; variant: BadgeProps["variant"] } =
    confirmation.status === "rejected"
      ? { label: "已驳回", variant: "danger" }
      : confirmation.consumedAt
        ? { label: "已用完", variant: "muted" }
        : { label: "已批准 · 未使用", variant: "info" };

  return (
    <div className="space-y-1 border-t pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-mono">{confirmation.id}</span>
        <span>{CONFIRM_ACTION_LABELS[confirmation.action]}</span>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="text-muted-foreground">
          {confirmation.decidedBy ?? "?"} · {timeAgo(confirmation.decidedAt)}
          {confirmation.reason ? ` · ${confirmation.reason}` : ""}
        </span>
        {usable ? (
          <>
            <span className="ml-auto text-[11px] text-sky-700">
              consume 之前还能执行一次
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void onRun(`标记已用 ${confirmation.id}`, {
                  cmd: "consumeConfirm",
                  actor: { kind: "human", name: "me" },
                  card: card.id,
                  id: confirmation.id,
                })
              }
              data-testid={`confirm-consume-${confirmation.id}`}
            >
              <CheckSquare />
              标记已用
            </Button>
          </>
        ) : null}
        {confirmation.consumedAt ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            已用 · {timeAgo(confirmation.consumedAt)}
          </span>
        ) : null}
      </div>
      <pre className="whitespace-pre-wrap break-all pl-1 font-mono text-[11px] text-muted-foreground">
        {confirmation.detail}
      </pre>
    </div>
  );
}

/** G2：卡片上的「远程写确认」——人照 detail 做判断，批准/驳回，历史只增不删。 */
export function ConfirmPanel({
  card,
  busy,
  onRun,
}: {
  card: CardView;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const pending = card.confirmations.filter((confirmation) => confirmation.status === "pending");
  const decided = card.confirmations.filter((confirmation) => confirmation.status !== "pending");

  return (
    <div className="space-y-2">
      {pending.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs text-muted-foreground">
          空 · 没有待批的远程写申请
        </p>
      ) : (
        pending.map((confirmation) => (
          <PendingConfirm
            key={confirmation.id}
            card={card}
            confirmation={confirmation}
            busy={busy}
            onRun={onRun}
          />
        ))
      )}

      {decided.length > 0 ? (
        <div className="space-y-1.5 rounded-lg border bg-background p-2.5">
          <div className="text-xs font-medium text-muted-foreground">
            历史（{decided.length}）· 已批准未使用的还是一次凭据，已用完/已驳回的不能再执行
          </div>
          {decided.map((confirmation) => (
            <DecidedConfirm
              key={confirmation.id}
              card={card}
              confirmation={confirmation}
              busy={busy}
              onRun={onRun}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
