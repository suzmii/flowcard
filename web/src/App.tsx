import { useCallback, useState } from "react";
import { AlertTriangle, LayoutGrid, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { Board } from "@/components/Board";
import { CardDetail } from "@/components/CardDetail";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBoard, type Connection } from "@/lib/useBoard";
import { clockTime } from "@/lib/utils";

const CONNECTION_TEXT: Record<Connection, string> = {
  connecting: "连接中…",
  live: "已连接",
  reconnecting: "重连中…",
};

const CONNECTION_TONE: Record<Connection, string> = {
  connecting: "bg-amber-500",
  live: "bg-emerald-600",
  reconnecting: "bg-red-600",
};

export function App() {
  const board = useBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const cards = board.cards ?? [];
  const selected = cards.find((card) => card.id === selectedId) ?? null;

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await board.refresh();
    setRefreshing(false);
  }, [board]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <header className="flex flex-wrap items-center gap-3 border-b bg-background px-4 py-2.5">
        <div className="flex items-center gap-2">
          <LayoutGrid className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">flowcard 看板</h1>
          <Badge variant="muted">{cards.length} 张卡</Badge>
          {board.lastChanged ? (
            <Badge variant="outline" title={board.lastChanged.types.join(", ")}>
              最近变更 {board.lastChanged.cardIds.length} 张 ·{" "}
              {clockTime(board.lastChangedAt)}
            </Badge>
          ) : null}
          {board.runtimeEvents > 0 ? (
            <Badge variant="outline" title="SSE 收到的 runtime 事件数">
              运行时事件 {board.runtimeEvents}
            </Badge>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            title="GET /api/stream（SSE）"
          >
            <span className={`size-2 rounded-full ${CONNECTION_TONE[board.connection]}`} />
            {board.connection === "live" ? (
              <Wifi className="size-3.5" />
            ) : (
              <WifiOff className="size-3.5" />
            )}
            {CONNECTION_TEXT[board.connection]}
          </span>
          <Button variant="outline" size="sm" onClick={() => void manualRefresh()}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            刷新
          </Button>
        </div>
      </header>

      {board.error ? (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <div className="font-medium">读不到卡片数据：{board.error}</div>
            <div className="text-red-700/80">
              服务没起来时先跑：
              <code className="mx-1 rounded bg-red-100 px-1 py-0.5 font-mono">
                FLOWCARD_DATA_DIR=/tmp/fc-web npm start
              </code>
              （默认监听 127.0.0.1:47825，FLOWCARD_PORT 可改）；前端 dev 由 vite proxy 转发 /api，不需要开 CORS。
            </div>
          </div>
        </div>
      ) : null}

      <main className="min-h-0 flex-1">
        <Board cards={cards} loading={board.loading} selectedId={selectedId} onSelect={setSelectedId} />
      </main>

      {selected ? (
        <CardDetail
          card={selected}
          cards={cards}
          onClose={() => setSelectedId(null)}
          onRefresh={board.refresh}
        />
      ) : null}
    </div>
  );
}
