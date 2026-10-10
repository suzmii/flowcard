/**
 * 卡片上的"人工推进"动作：**验收**（accept，人拍板 G3）、**放弃**（drop，理由进评论）与
 * **删除**（软删除：从看板消失、可恢复）。
 * 其余推进都由事实自动完成（绑 worktree / 起会话自动开工、推送、PR 合并、清理）。
 */
import { useState } from "react";
import { CircleSlash, ShieldCheck, Trash2, Undo2 } from "lucide-react";
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");

  const human = { kind: "human", name: "me" } as const;

  // 已删除：只给"恢复"（软删除，事件与六项要件都还在）
  if (card.deletedAt) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="state-actions">
        <span className="text-xs text-amber-700">
          已删除{card.deletedReason ? `（${card.deletedReason}）` : ""} · {card.deletedAt.slice(0, 16).replace("T", " ")}
        </span>
        <Button
          size="xs"
          variant="outline"
          data-testid="state-restore"
          disabled={busy !== null}
          onClick={() => void onRun("恢复卡片", { cmd: "restore", actor: human, card: card.id })}
        >
          <Undo2 />
          恢复这张卡
        </Button>
      </div>
    );
  }

  const finished = card.state === "done" || card.state === "dropped";
  if (finished) return null;

  /**
   * 验收（G3）：**只有人能拍板**，而且服务端只有 `accept` 会一次性合成 G3 的 requested + decided
   * （投影里不存在「未决的 G3」），所以入口必须放在这里，门禁区里等不到它。
   * 验收满足 `review → merged` 的 accepted 要件；PR 已合并时这一步就把卡片推进「已合并待清理」。
   */
  const canAccept = card.state === "review" && !card.acceptedAt;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="state-actions">
      {canAccept ? (
        <Button
          size="xs"
          data-testid="state-accept"
          disabled={busy !== null}
          title="人工验收（G3）：记录 G3 通过；PR 已合并时卡片随之进入「已合并待清理」"
          onClick={() => void onRun("验收（G3）", { cmd: "accept", actor: human, card: card.id })}
        >
          <ShieldCheck />
          验收（G3）
        </Button>
      ) : null}

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

      {confirmDelete ? (
        <span className="flex flex-wrap items-center gap-2" data-testid="state-delete-form">
          <Input
            data-testid="state-delete-reason"
            autoFocus
            className="h-7 max-w-[20rem] text-xs"
            placeholder="为什么删（可选，记进事件）"
            value={deleteReason}
            onChange={(event) => setDeleteReason(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            data-testid="state-delete-submit"
            disabled={busy !== null}
            onClick={() =>
              void onRun("删除卡片", {
                cmd: "delete",
                actor: human,
                card: card.id,
                ...(deleteReason.trim() ? { reason: deleteReason.trim() } : {}),
              })
            }
          >
            <Trash2 />
            确认删除
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
            取消
          </Button>
        </span>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          data-testid="state-delete"
          disabled={busy !== null}
          title="软删除：从看板消失，事件与六项要件都留着，可恢复"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 />
          删除卡片
        </Button>
      )}
    </div>
  );
}
