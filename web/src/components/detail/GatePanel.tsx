import { useState } from "react";
import { CheckSquare, Lock, ShieldCheck, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GATE_STATUS_LABELS, type Gate } from "@/lib/contract";
import type { CardView } from "@/lib/schema";
import { timeAgo } from "@/lib/utils";

export type CommandRunner = (label: string, command: Record<string, unknown>) => Promise<void>;

const GATE_KIND_LABEL: Record<Gate["kind"], string> = {
  approve: "批准类",
  confirm: "确认类",
  review: "验收类",
  cleanup: "清理类",
};

/** 门禁 payload 里的清理清单（G4 proposeCleanup 的 items）。 */
function payloadItems(gate: Gate): string[] {
  const items = gate.payload?.["items"];
  return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
}

function OpenGate({
  card,
  gate,
  busy,
  onRun,
}: {
  card: CardView;
  gate: Gate;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const [reason, setReason] = useState("");
  const items = payloadItems(gate);

  const decide = (decision: "approved" | "rejected") =>
    void onRun(decision === "approved" ? `批准 ${gate.id}` : `驳回 ${gate.id}`, {
      cmd: "decideGate",
      actor: { kind: "human", name: "me" },
      card: card.id,
      gate: gate.id,
      decision,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });

  return (
    <div className="space-y-2 rounded-lg border-2 border-amber-500/60 bg-amber-50/60 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Lock className="size-3.5 text-amber-700" />
        <span className="font-mono text-xs font-semibold">{gate.id}</span>
        <span className="text-sm font-medium">{gate.title}</span>
        <Badge variant="warning">{GATE_KIND_LABEL[gate.kind]}</Badge>
        <span className="ml-auto text-xs text-muted-foreground">{timeAgo(gate.requestedAt)}</span>
      </div>

      {items.length > 0 ? (
        <div className="rounded border bg-background p-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">清理清单（payload.items）</div>
          <ul className="space-y-0.5">
            {items.map((item) => (
              <li key={item} className="flex items-center gap-1.5 text-xs">
                <CheckSquare className="size-3.5 text-muted-foreground" />
                <span className="font-mono">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Input
          value={reason}
          placeholder="理由（可空）"
          onChange={(event) => setReason(event.target.value)}
          className="flex-1"
        />
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => decide("approved")}
          data-testid={`gate-approve-${gate.id}`}
        >
          <ShieldCheck />
          批准
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => decide("rejected")}
          data-testid={`gate-reject-${gate.id}`}
        >
          <XCircle />
          驳回
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        POST /api/commands · decideGate（本地记录，不碰远程）
      </p>
    </div>
  );
}

export function GatePanel({
  card,
  busy,
  onRun,
}: {
  card: CardView;
  busy: string | null;
  onRun: CommandRunner;
}) {
  const gates = Object.values(card.gates);
  const open = gates.filter((gate) => gate.status === "open");
  const decided = gates.filter((gate) => gate.status !== "open");

  return (
    <div className="space-y-2">
      {open.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/40 p-2.5 text-xs text-muted-foreground">
          空 · 当前没有未决门禁
        </p>
      ) : (
        open.map((gate) => (
          <OpenGate key={gate.id} card={card} gate={gate} busy={busy} onRun={onRun} />
        ))
      )}

      {decided.length > 0 ? (
        <div className="space-y-1 rounded-lg border bg-background p-2.5">
          <div className="text-xs font-medium text-muted-foreground">已决门禁</div>
          {decided.map((gate) => (
            <div key={gate.id} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-mono">{gate.id}</span>
              <span>{gate.title}</span>
              <Badge variant={gate.status === "approved" ? "success" : "danger"}>
                {GATE_STATUS_LABELS[gate.status] ?? gate.status}
              </Badge>
              <span className="text-muted-foreground">
                {gate.decidedBy ?? "?"} · {timeAgo(gate.decidedAt)}
                {gate.reason ? ` · ${gate.reason}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
