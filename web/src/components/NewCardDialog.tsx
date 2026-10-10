import { useCallback, useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { BodyComposer } from "@/components/BodyComposer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { postCommand } from "@/lib/api";
import { LOCAL_PROJECT_ID } from "@/lib/projects";
import { cn } from "@/lib/utils";

type Draft = { title: string; body: string };

const EMPTY_DRAFT: Draft = { title: "", body: "" };

/** 服务端回的开卡结果（只取要展示的两项）。 */
type Created = { id: string; title: string | null };

/**
 * 人在看板上自己开卡：正文必填（主输入，支持粘贴/拖放图片），标题可选。
 * 标题留空**不编造** —— 命令里连字段都不带，由服务端从正文派生，回填的最终标题在成功提示里展示。
 * 卡片归属当前项目（`projectId`）；没选项目时由服务端兜到 `local`。
 */
export function NewCardDialog({
  open,
  onClose,
  onCreated,
  projectId,
  projectName,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  projectId: string | null;
  projectName: string | null;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const close = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setError(null);
    setCreated(null);
    onClose();
  }, [onClose]);

  const submit = useCallback(async () => {
    setError(null);
    if (draft.body.trim() === "") {
      setError("正文必填：写清要干什么（背景 / 验收标准 / 约束）。");
      return;
    }

    const command: Record<string, unknown> = {
      cmd: "open",
      actor: { kind: "human", name: "me" },
      body: draft.body,
    };
    // 标题留空就不带这个字段：派生是服务端的事，前端不猜。
    if (draft.title.trim() !== "") command.title = draft.title.trim();
    if (projectId) command.projectId = projectId;

    setBusy(true);
    const result = await postCommand(command);
    setBusy(false);

    if (!result.ok) {
      // 服务端的 zod 原文原样展示，别吞掉。
      const rejection = result.rejection;
      setError(rejection ? `${rejection.code}：${rejection.message}` : "开卡失败：服务端没有给出原因。");
      return;
    }
    setCreated({ id: result.card?.id ?? "（服务端未回 id）", title: result.card?.title ?? null });
    setDraft(EMPTY_DRAFT);
    await onCreated();
  }, [draft, onCreated, projectId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30"
        role="presentation"
        onClick={close}
        data-testid="new-card-backdrop"
      />
      <div
        className="relative flex max-h-full w-full max-w-[34rem] flex-col rounded-xl border bg-background shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="新建卡片"
        data-testid="new-card-dialog"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <Plus className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">新建卡片</h2>
          <span className="text-[11px] text-muted-foreground">开出来的卡会落在「收件箱」</span>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={close} aria-label="关闭">
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div
            className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 text-[11px]"
            data-testid="new-card-project"
          >
            <span className="text-muted-foreground">归属项目</span>
            <span className="font-medium" data-project-id={projectId ?? LOCAL_PROJECT_ID}>
              {projectName ?? "未选项目（落到 local，未归属）"}
            </span>
          </div>

          {created ? (
            <div
              className="space-y-1 rounded-lg border border-emerald-600/30 bg-emerald-50 p-2.5 text-xs text-emerald-900"
              data-testid="new-card-created"
            >
              <div className="font-medium">已开卡 · 服务端给的标题：</div>
              <div className="break-words text-sm" data-testid="new-card-created-title">
                {created.title ?? "（服务端没有回标题，以看板上的卡为准）"}
              </div>
              <div className="font-mono text-[11px] text-emerald-800/80">{created.id}</div>
            </div>
          ) : null}

          <label className="block space-y-1">
            <span className="flex items-baseline gap-2">
              <span className="text-xs font-medium">正文</span>
              <span className="text-[11px] text-muted-foreground">必填 · 主输入</span>
            </span>
            <BodyComposer
              testId="new-card-body"
              autoFocus
              value={draft.body}
              placeholder="背景、验收标准、约束…（图片可直接粘贴 / 拖放，会插入到光标处）"
              onChange={(next) => setDraft((prev) => ({ ...prev, body: next }))}
            />
          </label>

          <label className="block space-y-1">
            <span className="flex items-baseline gap-2">
              <span className="text-xs font-medium">标题</span>
              <span className="text-[11px] text-muted-foreground">可选 · 留空由服务端从正文派生</span>
            </span>
            <Input
              data-testid="new-card-title"
              value={draft.title}
              placeholder="不填也行"
              onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
            />
          </label>

          {error ? (
            <div
              data-testid="new-card-error"
              role="alert"
              className={cn(
                "rounded-lg border border-red-600/30 bg-red-50 p-2.5 text-xs text-red-800",
                "whitespace-pre-wrap break-words font-mono",
              )}
            >
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t px-4 py-3">
          {created ? (
            <>
              <Button variant="ghost" size="sm" data-testid="new-card-again" onClick={() => setCreated(null)}>
                再开一张
              </Button>
              <Button size="sm" data-testid="new-card-done" onClick={close}>
                完成
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={close}>
                取消
              </Button>
              <Button
                size="sm"
                data-testid="new-card-submit"
                disabled={busy}
                onClick={() => void submit()}
              >
                {busy ? "提交中…" : "开卡"}
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
