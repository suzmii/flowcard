/**
 * 卡片上的"人工推进"动作：目前只有两步是纯人工决定的——
 *   · 收件箱里的卡：「确认要做」（triage）→ 进「立 Issue」列
 *   · 任意未完成的卡：「放弃」（drop，必须写理由，理由进评论留痕）
 * 其余推进都有各自的入口（绑 Issue 自动立项、门禁批准、会话 claim 自动开工、验收、清理）。
 */
import { useState } from "react";
import { CheckCircle2, CircleSlash, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CardView } from "@/lib/schema";

export type StateActionsRunner = (label: string, command: Record<string, unknown>) => Promise<void>;

export function StateActions({
  card,
  busy,
  onRun,
}: {
  card: CardView;
  busy: string | null;
  onRun: StateActionsRunner;
}) {
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const inInbox = card.state === "inbox";
  const finished = card.state === "done" || card.state === "dropped";
  if (!inInbox && finished) return null;

  const human = { kind: "human", name: "me" } as const;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="state-actions">
      {inInbox ? (
        <>
          <Button
            size="xs"
            data-testid="state-triage"
            disabled={busy !== null}
            onClick={() =>
              void onRun("确认要做", {
                cmd: "triage",
                actor: human,
                card: card.id,
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            <Inbox />
            确认要做（去立项）
          </Button>
          <Input
            data-testid="state-triage-note"
            className="h-7 max-w-[20rem] text-xs"
            placeholder="备注（可选，会记进评论）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </>
      ) : null}

      {finished ? null : confirmDrop ? (
        <span className="flex flex-wrap items-center gap-2" data-testid="state-drop-form">
          <Input
            data-testid="state-drop-reason"
            autoFocus
            className="h-7 max-w-[20rem] text-xs"
            placeholder="为什么放弃（必填，会记进评论）"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            data-testid="state-drop-submit"
            disabled={busy !== null || reason.trim() === ""}
            onClick={() =>
              void onRun("放弃", {
                cmd: "drop",
                actor: human,
                card: card.id,
                reason: reason.trim(),
              })
            }
          >
            <CircleSlash />
            确认放弃
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmDrop(false)}>
            取消
          </Button>
        </span>
      ) : (
        <Button
          size="xs"
          variant="outline"
          data-testid="state-drop"
          disabled={busy !== null}
          onClick={() => setConfirmDrop(true)}
        >
          <CircleSlash />
          放弃这条
        </Button>
      )}

      {inInbox ? (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <CheckCircle2 className="size-3" />
          也可以直接绑 Issue：绑上就自动进「立 Issue」列
        </span>
      ) : null}
    </div>
  );
}
