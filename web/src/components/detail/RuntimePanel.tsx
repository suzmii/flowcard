import { useState } from "react";
import { Play, ScrollText, Square, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { postRuntime } from "@/lib/api";
import { RUNTIME_LABELS, RUNTIME_TONE, type RuntimeAction } from "@/lib/contract";
import type { CardView } from "@/lib/schema";
import { timeAgo } from "@/lib/utils";

/**
 * 运行时开关。`card.runtime` 与 `POST /api/cards/:id/runtime` 是另一条线正在落地的契约，
 * 因此这里一律按可选处理：字段缺失时降级显示，接口 404 时给出明确提示。
 */
export function RuntimePanel({
  card,
  cards,
  onRefresh,
}: {
  card: CardView;
  cards: CardView[];
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [killed, setKilled] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const runtime = card.runtime;

  const act = async (action: RuntimeAction) => {
    setBusy(action);
    setNotice(null);
    setKilled([]);
    setWarnings([]);
    const outcome = await postRuntime(card.id, action);
    if (outcome.ok) {
      setNotice({
        tone: "ok",
        text: action === "up" ? "已请求启动运行时" : "已请求停止运行时",
      });
      setKilled(outcome.killed);
      setWarnings(outcome.warnings);
      await onRefresh();
    } else {
      setNotice({ tone: "error", text: outcome.error ?? "运行时操作失败" });
    }
    setBusy(null);
  };

  const titleOf = (id: string) => cards.find((item) => item.id === id)?.title ?? "（不在当前列表）";

  return (
    <div className="space-y-2 rounded-lg border bg-background p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Terminal className="size-3.5 text-muted-foreground" />
        {runtime ? (
          <>
            <Badge
              variant={runtime.status === "running" ? "success" : runtime.status === "failed" ? "danger" : "muted"}
            >
              <span className={`size-1.5 rounded-full ${RUNTIME_TONE[runtime.status]}`} />
              {RUNTIME_LABELS[runtime.status]}
            </Badge>
            {runtime.pid ? <Badge variant="outline">pid {runtime.pid}</Badge> : null}
            {runtime.ports?.map((port) => (
              <Badge key={port} variant="outline" className="font-mono">
                :{port}
              </Badge>
            ))}
            {runtime.startedAt ? (
              <span className="text-xs text-muted-foreground">起于 {timeAgo(runtime.startedAt)}</span>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">未托管（card.runtime 为空）</span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => void act("up")}
            data-testid="runtime-up"
          >
            <Play />
            {busy === "up" ? "启动中…" : "启动"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void act("down")}
            data-testid="runtime-down"
          >
            <Square />
            {busy === "down" ? "停止中…" : "停止"}
          </Button>
        </div>
      </div>

      {runtime?.logPath ? (
        <div className="flex items-center gap-2 rounded border bg-muted/40 p-2">
          <ScrollText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{runtime.logPath}</span>
          <CopyButton value={runtime.logPath} label="复制日志路径" />
        </div>
      ) : null}

      {notice ? (
        <p
          className={
            notice.tone === "ok"
              ? "rounded border border-emerald-600/30 bg-emerald-50 p-2 text-xs text-emerald-800"
              : "rounded border border-red-600/30 bg-red-50 p-2 text-xs text-red-800"
          }
        >
          {notice.text}
        </p>
      ) : null}

      {killed.length > 0 ? (
        <div className="rounded border border-amber-500/50 bg-amber-50 p-2 text-xs text-amber-900">
          <div className="font-medium">本次操作停掉了 {killed.length} 个其他卡片运行时：</div>
          <ul className="mt-1 space-y-0.5">
            {killed.map((id) => (
              <li key={id} className="flex gap-1.5">
                <span className="font-mono">{id}</span>
                <span className="truncate">{titleOf(id)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <ul className="space-y-0.5 rounded border border-amber-500/50 bg-amber-50 p-2 text-xs text-amber-900">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        POST /api/cards/{card.id}/runtime · action=up|down（本机进程，属于本地动作）
      </p>
    </div>
  );
}
