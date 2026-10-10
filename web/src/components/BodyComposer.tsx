/**
 * 正文输入器：多行文本 + 图片输入（粘贴 / 拖放 / 选择文件）。
 * 图片先传 `POST /api/attachments`，成功后把服务端给的 `markdown` 插到光标处（多张按顺序）；
 * 被拦的文件（非图片类型、超 10 MB）只在状态条里给理由 —— **正文一个字都不动**。
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ClipboardEvent } from "react";
import { AlertTriangle, CheckCircle2, ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_ATTACHMENT_BYTES, uploadImage, validateImage } from "@/lib/uploads";
import { cn } from "@/lib/utils";

type Upload = {
  key: string;
  name: string;
  status: "uploading" | "done" | "error";
  message?: string;
};

const STATUS_TEXT: Record<Upload["status"], string> = {
  uploading: "上传中…",
  done: "已插入正文",
  error: "被拦下",
};

export function BodyComposer({
  value,
  onChange,
  placeholder,
  testId,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  testId: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  // 连续的异步上传之间，props 里的 value 还是旧的；用 ref 保证每次插入都基于最新正文。
  const latest = useRef(value);
  latest.current = value;
  const pendingCursor = useRef<number | null>(null);
  const alive = useRef(true);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 插入后把光标挪到插入内容之后（值已经由父组件回填到 DOM）。
  useEffect(() => {
    const at = pendingCursor.current;
    if (at === null) return;
    pendingCursor.current = null;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  });

  const insertMarkdown = useCallback(
    (markdown: string) => {
      const el = ref.current;
      const text = latest.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const before = text.slice(0, start);
      const after = text.slice(end);
      const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
      const tail = after !== "" && !after.startsWith("\n") ? "\n" : "";
      const inserted = `${lead}${markdown}${tail}`;
      const next = `${before}${inserted}${after}`;
      latest.current = next;
      pendingCursor.current = before.length + inserted.length;
      onChange(next);
    },
    [onChange],
  );

  /** 一份输入里的文件按顺序传：成功的插 markdown，失败的留理由（正文不动）。 */
  const ingest = useCallback(
    async (files: File[]) => {
      setQueueing(true);
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`;
        const invalid = validateImage(file);
        if (invalid) {
          if (alive.current) setUploads((prev) => [...prev, { key, name: file.name, status: "error", message: invalid }]);
          continue;
        }
        if (alive.current) setUploads((prev) => [...prev, { key, name: file.name, status: "uploading" }]);
        const result = await uploadImage(file);
        if (!alive.current) return;
        if (result.ok) {
          setUploads((prev) => prev.map((item) => (item.key === key ? { ...item, status: "done" } : item)));
          insertMarkdown(result.markdown);
        } else {
          setUploads((prev) =>
            prev.map((item) => (item.key === key ? { ...item, status: "error", message: result.message } : item)),
          );
        }
      }
      if (alive.current) setQueueing(false);
    },
    [insertMarkdown],
  );

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = Array.from(clipboard.files);
    // 纯文本粘贴不动（走浏览器默认）；夹带文件的一律自己处理：
    // 图片去上传，非图片只报理由，都不让浏览器把文件名当文本塞进正文。
    if (files.length === 0) return;
    event.preventDefault();
    void ingest(files);
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void ingest(files);
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length > 0) void ingest(files);
  };

  return (
    <div className="space-y-1.5">
      <div
        className={cn("relative rounded-md", dragging && "ring-2 ring-ring/60")}
        data-testid={`${testId}-dropzone`}
        data-dragging={dragging}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
      >
        <Textarea
          ref={ref}
          data-testid={testId}
          value={value}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onPaste={onPaste}
          onDrop={onDrop}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-[7.5rem]"
        />
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-md bg-background/80 text-xs font-medium">
            松手即上传图片
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          className="hidden"
          data-testid={`${testId}-file`}
          onChange={onPick}
        />
        <Button size="xs" variant="outline" disabled={queueing} onClick={() => fileInput.current?.click()}>
          <ImagePlus />
          选择文件
        </Button>
        <span className="text-[11px] text-muted-foreground">
          可直接粘贴（Ctrl/Cmd+V）或拖放图片 · 单张 ≤ {MAX_ATTACHMENT_BYTES / 1024 / 1024} MB · png/jpeg/gif/webp
        </span>
      </div>

      {uploads.length > 0 ? (
        <ul className="space-y-1 rounded-md border bg-muted/40 p-1.5" data-testid={`${testId}-uploads`}>
          {uploads.map((item) => (
            <li
              key={item.key}
              data-upload-status={item.status}
              className="flex items-start gap-1.5 text-[11px] leading-relaxed"
            >
              {item.status === "uploading" ? (
                <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" />
              ) : item.status === "done" ? (
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" />
              ) : (
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-red-600" />
              )}
              <span className="min-w-0 flex-1 break-all">
                <span className="font-mono">{item.name}</span> · {STATUS_TEXT[item.status]}
                {item.message ? <span className="text-red-700">：{item.message}</span> : null}
              </span>
            </li>
          ))}
          <li className="flex justify-end">
            <Button size="xs" variant="ghost" onClick={() => setUploads([])}>
              <X />
              清空状态
            </Button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
