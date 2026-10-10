import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { postCommand } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Issue 三件套：要么都填，要么都不填（客户端先挡一层，服务端还会再校验一次）。 */
const ISSUE_FIELDS = ["repo", "number", "url"] as const;

type Draft = {
  title: string;
  body: string;
  issueRepo: string;
  issueNumber: string;
  issueUrl: string;
  repoPath: string;
};

const EMPTY_DRAFT: Draft = {
  title: "",
  body: "",
  issueRepo: "",
  issueNumber: "",
  issueUrl: "",
  repoPath: "",
};

/** 校验草稿；返回第一条可读错误（客户端拦不住的交由服务端，原文照样展示）。 */
function validate(draft: Draft): string | null {
  if (draft.title.trim() === "") return "标题必填：至少写一句这条需求要干什么。";

  const filled = {
    repo: draft.issueRepo.trim() !== "",
    number: draft.issueNumber.trim() !== "",
    url: draft.issueUrl.trim() !== "",
  };
  const filledCount = ISSUE_FIELDS.filter((field) => filled[field]).length;
  if (filledCount === 0) return null;

  if (filledCount < ISSUE_FIELDS.length) {
    const missing = ISSUE_FIELDS.filter((field) => !filled[field]);
    return `Issue 三件套必须成套填写：repo / number / url 要么都填、要么都不填（当前缺 ${missing.join("、")}）。`;
  }

  const number = Number(draft.issueNumber.trim());
  if (!Number.isInteger(number) || number <= 0) {
    return `Issue number 必须是正整数（当前是「${draft.issueNumber.trim()}」）。`;
  }
  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

/**
 * 人在看板上自己开卡：填标题（必填）、正文、可选 Issue 三件套、可选 repoPath。
 * 提交走和 CLI 同一条通道（`POST /api/commands` 的 `open`），成功后由 SSE/刷新把新卡带进收件箱。
 */
export function NewCardDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = useCallback(
    <K extends keyof Draft>(key: K, value: Draft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const submit = useCallback(async () => {
    setError(null);
    const invalid = validate(draft);
    if (invalid) {
      setError(invalid);
      return;
    }

    const command: Record<string, unknown> = {
      cmd: "open",
      actor: { kind: "human", name: "me" },
      title: draft.title.trim(),
      body: draft.body,
    };
    if (draft.issueRepo.trim() !== "") {
      command.issue = {
        repo: draft.issueRepo.trim(),
        number: Number(draft.issueNumber.trim()),
        url: draft.issueUrl.trim(),
      };
    }
    if (draft.repoPath.trim() !== "") command.repoPath = draft.repoPath.trim();

    setBusy(true);
    const result = await postCommand(command);
    setBusy(false);

    if (!result.ok) {
      // 服务端的 zod 原文原样展示，别吞掉。
      const rejection = result.rejection;
      setError(rejection ? `${rejection.code}：${rejection.message}` : "开卡失败：服务端没有给出原因。");
      return;
    }
    setDraft(EMPTY_DRAFT);
    await onCreated();
    onClose();
  }, [draft, onClose, onCreated]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30"
        role="presentation"
        onClick={onClose}
        data-testid="new-card-backdrop"
      />
      <div
        className="relative flex max-h-full w-full max-w-[32rem] flex-col rounded-xl border bg-background shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="新建卡片"
        data-testid="new-card-dialog"
      >
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <Plus className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">新建卡片</h2>
          <span className="text-[11px] text-muted-foreground">开出来的卡会落在「收件箱」</span>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={onClose} aria-label="关闭">
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <Field label="标题" hint="必填">
            <Input
              data-testid="new-card-title"
              value={draft.title}
              autoFocus
              placeholder="想干什么？一句话"
              onChange={(event) => set("title", event.target.value)}
            />
          </Field>

          <Field label="正文" hint="可选">
            <Textarea
              data-testid="new-card-body"
              value={draft.body}
              placeholder="背景、验收标准、约束…"
              onChange={(event) => set("body", event.target.value)}
            />
          </Field>

          <fieldset className="space-y-2 rounded-lg border p-2.5">
            <legend className="px-1 text-[11px] text-muted-foreground">
              Issue（可选，三件套要么都填要么都不填）
            </legend>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Field label="repo">
                <Input
                  data-testid="new-card-issue-repo"
                  value={draft.issueRepo}
                  placeholder="owner/name"
                  onChange={(event) => set("issueRepo", event.target.value)}
                />
              </Field>
              <Field label="number">
                <Input
                  data-testid="new-card-issue-number"
                  value={draft.issueNumber}
                  inputMode="numeric"
                  placeholder="123"
                  className="w-24"
                  onChange={(event) => set("issueNumber", event.target.value)}
                />
              </Field>
            </div>
            <Field label="url">
              <Input
                data-testid="new-card-issue-url"
                value={draft.issueUrl}
                placeholder="https://…/issues/123"
                onChange={(event) => set("issueUrl", event.target.value)}
              />
            </Field>
          </fieldset>

          <Field label="项目仓库路径" hint="可选">
            <Input
              data-testid="new-card-repo-path"
              value={draft.repoPath}
              placeholder="/home/me/workspace/proj"
              onChange={(event) => set("repoPath", event.target.value)}
            />
          </Field>

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
          <Button variant="ghost" size="sm" onClick={onClose}>
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
        </footer>
      </div>
    </div>
  );
}
