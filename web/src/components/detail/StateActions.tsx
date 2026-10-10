/**
 * 卡片上的"人工推进"动作：**只剩「放弃这条」**（drop，必须写理由，理由进评论留痕）。
 * 其余推进都由事实自动完成（绑 worktree / 起会话自动开工、推送、PR 合并、验收、清理）。
 */
import { useState } from "react";
import { CircleSlash } from "lucide-react";
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
  const [reason, setReason] = useState("");
  const [confirmDrop, setConfirmDrop] = useState(false);

  const finished = card.state === "done" || card.state === "dropped";
  if (finished) return null;

  const human = { kind: "human", name: "me" } as const;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="state-actions">
      {confirmDrop ? (
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
    </div>
  );
}
