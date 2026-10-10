/**
 * 一个托管会话的完整对话面板（「会话」视图右栏的唯一渲染体）：顶部状态栏固定、
 * 中间转录自己滚、输入框钉在底部。
 *
 * 数据来源：`GET /api/cards/:id/session`（快照）+ `GET /api/cards/:id/session/stream`（每卡一条 SSE）。
 * 断线时 EventSource 自己重连，这里只把「重连中」亮出来，并在恢复后补一次快照。
 *
 * 滚动：**默认贴底**。进视图/换会话/首次拉到历史后立刻滚到底，内容（markdown、图片）晚一步撑高
 * 也再跟一次；只有用户自己往上翻（离底 > `AT_BOTTOM_PX`）才不抢，并亮出「跳到最新」。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  Hand,
  ImagePlus,
  Loader2,
  Play,
  SendHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_ATTACHMENT_BYTES, validateImage } from "@/lib/uploads";
import { cn, timeAgo } from "@/lib/utils";
import {
  TOOL_STATUS_LABELS,
  SESSION_STATUS_LABELS,
  SESSION_STATUS_TONE,
  DELETE_SESSION_CONFIRM,
  abortSession,
  applySessionEvent,
  deleteSession,
  fetchSession,
  initialSessionView,
  mergeSessionSnapshot,
  promptSession,
  startSession,
  stopSession,
  subscribeSession,
  thinkingSummary,
  toolSummary,
  type SessionImage,
  type SessionMessage,
  type SessionState,
  type SessionTool,
} from "@/lib/session";
import type { CardView } from "@/lib/schema";

const ROLE_LABELS: Record<SessionMessage["role"], string> = {
  user: "我",
  assistant: "助手",
  tool: "工具",
  thinking: "思考",
};

/** 工具输出超过这个长度就先折一半（**只影响首屏**，点「展开全部」看全量，绝不截断丢弃）。 */
const TOOL_PREVIEW_CHARS = 4000;

/** 离底多少像素内算「还贴着底」：超过就当用户自己往上翻了，新内容不抢滚动。 */
const AT_BOTTOM_PX = 40;

/** 待发图片：校验复用 `lib/uploads.ts` 的口径，字节按契约内联成 base64。 */
type PendingImage = { key: string; name: string; bytes: number; dataBase64: string };

type ImageError = { key: string; name: string; message: string };

/**
 * 存活探针间隔：契约里没有 ping 帧，EventSource 也察觉不到「假活」连接
 * （开发期的 vite 代理会把上游断开吞掉），所以定期用一次便宜的 GET 兜底：
 * 拉不到 → 亮「重连中」并**重建** EventSource；拉到了 → 顺带把漏掉的帧补上。
 */
const LIVENESS_PROBE_MS = 20_000;

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`;
}

/** data URL → 纯 base64（契约里 `images[].dataBase64` 不带前缀）。 */
async function readBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** 工具调用块：命令名 + 参数摘要 + 输出（等宽、可折叠、可滚动，出错变红）。 */
function ToolBlock({ tool }: { tool: SessionTool }) {
  // 默认折叠：标题行已经带「工具名 · 命令摘要」，要完整输出才展开（用户要求）。
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const summary = toolSummary(tool);
  const long = tool.output.length > TOOL_PREVIEW_CHARS;
  const shown = long && !full ? tool.output.slice(0, TOOL_PREVIEW_CHARS) : tool.output;

  return (
    <div
      className={cn("rounded-md border bg-muted/30", tool.isError && "border-red-600/50 bg-red-50")}
      data-testid="session-tool"
      data-tool-name={tool.name}
      data-tool-status={tool.status}
      data-tool-error={tool.isError === true ? "1" : "0"}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="session-tool-toggle"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <SquareTerminal className={cn("size-3.5 shrink-0", tool.isError ? "text-red-700" : "text-muted-foreground")} />
        <span className="shrink-0 font-mono text-[11px] font-medium">
          {tool.name === "" ? "工具调用" : tool.name}
        </span>
        {summary !== "" ? (
          <>
            <span className="shrink-0 text-[11px] text-muted-foreground">·</span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
              data-testid="session-tool-summary"
            >
              {summary}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {tool.output !== "" ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{tool.output.length} 字符</span>
        ) : null}
        <Badge variant={tool.isError ? "danger" : tool.status === "end" ? "muted" : "info"}>
          {TOOL_STATUS_LABELS[tool.status]}
        </Badge>
      </button>

      {open ? (
        <div className="space-y-1 border-t px-2 py-1.5">
          {tool.args !== "" ? (
            <pre
              data-testid="session-tool-args"
              className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-background/80 p-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
            >
              {tool.args}
            </pre>
          ) : null}
          {tool.output !== "" ? (
            <pre
              data-testid="session-tool-output"
              className={cn(
                "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background/80 p-1.5 font-mono text-[11px] leading-relaxed",
                tool.isError && "bg-red-100/70 text-red-800",
              )}
            >
              {shown}
            </pre>
          ) : tool.status === "end" ? (
            <p className="text-[11px] text-muted-foreground">（没有输出）</p>
          ) : (
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              运行中…
            </p>
          )}
          {long && !full ? (
            <Button size="xs" variant="outline" data-testid="session-tool-expand" onClick={() => setFull(true)}>
              展开全部（共 {tool.output.length} 字符）
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 思考块：默认折叠，标题行显示「思考 · 首行摘要」，展开看完整思考（与工具块同一套折叠交互）。 */
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const summary = thinkingSummary(text);
  return (
    <div className="rounded-md border bg-muted/20" data-testid="session-thinking">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        data-testid="session-thinking-toggle"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Brain className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-[11px] font-medium">思考</span>
        {summary !== "" ? (
          <>
            <span className="shrink-0 text-[11px] text-muted-foreground">·</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" data-testid="session-thinking-summary">
              {summary}
            </span>
          </>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {text !== "" ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">{text.length} 字符</span>
        ) : null}
      </button>

      {open ? (
        <pre
          data-testid="session-thinking-text"
          className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >
          {text === "" ? "…" : text}
        </pre>
      ) : null}
    </div>
  );
}

function MessageRow({ message }: { message: SessionMessage }) {
  if (message.role === "tool" && message.tool) return <ToolBlock tool={message.tool} />;
  if (message.role === "thinking") return <ThinkingBlock text={message.text ?? ""} />;
  const mine = message.role === "user";
  return (
    <div
      className={cn("rounded-lg border p-2", mine ? "bg-sky-50/60" : "bg-background")}
      data-testid={`session-message-${message.role}`}
      data-message-id={message.id}
    >
      <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant={mine ? "info" : "muted"}>{ROLE_LABELS[message.role]}</Badge>
        {message.at !== "" ? <span className="ml-auto">{timeAgo(message.at)}</span> : null}
      </div>
      {message.text !== undefined && message.text !== "" ? (
        <Markdown text={message.text} />
      ) : (
        <p className="text-xs text-muted-foreground">…</p>
      )}
    </div>
  );
}

export function SessionChat({
  card,
  onSnapshot,
}: {
  card: CardView;
  /** 每次会话状态变化回报一次（左栏列表要画选中项的实时点/busy）；纯通知，不参与渲染。 */
  onSnapshot?: (cardId: string, session: SessionState) => void;
}) {
  const [view, setView] = useState(initialSessionView);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string; missing: boolean } | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [streamFailures, setStreamFailures] = useState(0);
  /** 换个 key 就丢掉当前 EventSource 重建一条（假活连接只能靠重建救）。 */
  const [streamKey, setStreamKey] = useState(0);
  const [action, setAction] = useState<null | "start" | "abort" | "stop" | "prompt" | "delete">(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [imageErrors, setImageErrors] = useState<ImageError[]>([]);
  const [stick, setStick] = useState(true);

  const listRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const stickRef = useRef(true);
  const aliveRef = useRef(true);
  const probeFailedRef = useRef(false);

  const session = view.session;
  const messages = session.messages;
  const status = session.status;
  const ompSessionId = session.ompSessionId ?? "";
  const shortId = ompSessionId.length > 12 ? `${ompSessionId.slice(0, 8)}…${ompSessionId.slice(-4)}` : ompSessionId;
  const costValue = session.cost?.total ?? session.cost?.cost;
  const modelText = session.model ?? "";
  const costText =
    typeof costValue === "number" && Number.isFinite(costValue) ? `$${costValue.toFixed(4)}` : "";

  // 重连后（或每次连上）补一次快照：断线期间的帧不保证补发。
  const reload = useCallback(async () => {
    const result = await fetchSession(card.id);
    if (result.ok) {
      setView((prev) => ({ ...prev, session: mergeSessionSnapshot(prev.session, result.data) }));
      setLoadError(null);
    } else {
      setLoadError({ message: result.message, missing: result.missing });
    }
  }, [card.id]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // 进详情（或换卡）先拉一次转录：刷新页面后历史也在。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const result = await fetchSession(card.id, controller.signal);
        if (result.ok) {
          setView((prev) => ({ ...prev, session: mergeSessionSnapshot(prev.session, result.data) }));
          setLoadError(null);
        } else {
          setLoadError({ message: result.message, missing: result.missing });
        }
      } catch {
        // 换卡/关闭面板导致的中断：丢掉即可
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [card.id]);

  // 每卡一条 SSE；EventSource 自带重连，这里只记录状态并标记需要补快照。
  useEffect(() => {
    let welcomed = false;
    let failures = 0;
    setConnection("connecting");
    setStreamFailures(0);

    const close = subscribeSession(card.id, {
      onEvent: (event) =>
        setView((prev) => applySessionEvent(prev, event, new Date().toISOString())),
      onLive: () => {
        setConnection("live");
        failures = 0;
        setStreamFailures(0);
        if (welcomed) return;
        welcomed = true;
        void reloadRef.current().catch(() => undefined);
      },
      onDisconnect: () => {
        setConnection("reconnecting");
        failures += 1;
        setStreamFailures(failures);
      },
    });
    return close;
  }, [card.id, streamKey]);

  // 存活探针：见 LIVENESS_PROBE_MS 的说明（假活连接要主动重建，漏掉的帧顺手补齐）。
  useEffect(() => {
    const probe = async () => {
      const result = await fetchSession(card.id).catch(() => null);
      if (!aliveRef.current) return;
      if (!result || !result.ok) {
        probeFailedRef.current = true;
        setConnection("reconnecting");
        setStreamFailures((count) => count + 1);
        setStreamKey((key) => key + 1);
        return;
      }
      setView((prev) => ({ ...prev, session: mergeSessionSnapshot(prev.session, result.data) }));
      setLoadError(null);
      if (probeFailedRef.current) {
        // 服务回来了：直接换一条新连接，别等旧连接的重试（它可能已经假活或放弃了）
        probeFailedRef.current = false;
        setStreamKey((key) => key + 1);
      }
    };
    const timer = window.setInterval(() => void probe(), LIVENESS_PROBE_MS);
    return () => window.clearInterval(timer);
  }, [card.id]);

  /**
   * 贴底：在**布局阶段**（浏览器已经算完高度、还没画）就把转录滚到底，避开「先渲染再撑高」的闪烁。
   * 依赖整个 view：流式文本、工具输出、提示流都会换掉它的引用，只盯「最后一条消息」会漏。
   */
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [view]);

  /**
   * 内容**晚一步**撑高（markdown 渲染完、图片加载完、工具块展开）时再跟一次底：直接改 scrollTop，
   * 不进 state（每次增量都 setState 会把对话多渲一遍）。用户往上翻时不打扰。
   */
  useEffect(() => {
    const content = contentRef.current;
    const list = listRef.current;
    if (!content || !list) return;
    const observer = new ResizeObserver(() => {
      if (!stickRef.current) return;
      list.scrollTop = list.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /** 换会话：重新贴底（新转录还没来，先把位置摆正；历史到了上面的 effect 会再跟一次）。 */
  useLayoutEffect(() => {
    stickRef.current = true;
    setStick(true);
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [card.id]);

  // 左栏列表要画选中项的实时状态/busy：会话状态变了就报一次。
  useEffect(() => {
    onSnapshot?.(card.id, view.session);
  }, [card.id, view.session, onSnapshot]);

  const onScroll = () => {
    const element = listRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
    stickRef.current = atBottom;
    setStick(atBottom);
  };

  const ingest = useCallback(async (files: File[]) => {
    const accepted: PendingImage[] = [];
    const errors: ImageError[] = [];
    for (const file of files) {
      const key = fileKey(file);
      const invalid = validateImage(file);
      if (invalid) {
        errors.push({ key, name: file.name, message: invalid });
        continue;
      }
      try {
        accepted.push({ key, name: file.name, bytes: file.size, dataBase64: await readBase64(file) });
      } catch (error) {
        errors.push({ key, name: file.name, message: `读取图片失败：${String(error)}` });
      }
    }
    if (!aliveRef.current) return;
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
    setImageErrors(errors);
  }, []);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void ingest(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void ingest(files);
  };

  const act = async (kind: "start" | "abort" | "stop" | "prompt" | "delete") => {
    if (action !== null) return;
    // 删会话是不可逆的（转录清了、卡片不再记这个会话）→ 二次确认，写清删什么、不删什么。
    if (kind === "delete" && !window.confirm(DELETE_SESSION_CONFIRM)) return;
    setAction(kind);
    setNotice(null);

    if (kind === "prompt") {
      const text = draft.trim();
      const images: SessionImage[] = pending.map(({ name, dataBase64 }) => ({ name, dataBase64 }));
      const result = await promptSession(card.id, { text, ...(images.length > 0 ? { images } : {}) });
      if (result.ok) {
        setDraft("");
        setPending([]);
        setImageErrors([]);
        stickRef.current = true;
        setStick(true);
        await reload();
      } else {
        setNotice({ tone: "error", text: `${result.code}：${result.message}` });
      }
      setAction(null);
      return;
    }

    const worktreePath = card.worktree?.path;
    const result =
      kind === "start"
        ? await startSession(card.id, worktreePath ? { cwd: worktreePath } : {})
        : kind === "abort"
          ? await abortSession(card.id)
          : kind === "delete"
            ? await deleteSession(card.id)
            : await stopSession(card.id);

    if (result.ok) {
      setNotice({
        tone: "ok",
        text:
          kind === "start"
            ? result.ompSessionId
              ? `会话已启动（${result.ompSessionId}）`
              : "已请求启动会话，稍候…"
            : kind === "abort"
              ? "已请求中断当前这一轮"
              : kind === "delete"
                ? "会话已删除：转录已清空，下次「启动会话」是全新的对话（omp 的会话文件仍保留）"
                : "已请求停止会话",
      });
    } else {
      setNotice({ tone: "error", text: `${result.code}：${result.message}` });
    }
    // 失败也要回读一次：服务端可能已经把状态落成 failed，徽标要跟着变
    await reload();
    setAction(null);
  };

  const streaming = status === "running";
  const canSend = streaming && !session.busy && action === null && (draft.trim() !== "" || pending.length > 0);
  const sendHint =
    action === "prompt"
      ? "发送中…"
      : status !== "running"
        ? "会话没在跑：先点「启动会话」"
        : session.busy
          ? "会话忙：等它说完再发下一条"
          : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 rounded-lg border bg-background p-2.5">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Badge variant={SESSION_STATUS_TONE[status]} data-testid="session-status" data-status={status}>
          {SESSION_STATUS_LABELS[status]}
        </Badge>
        {modelText !== "" ? (
          <span className="text-[11px] text-muted-foreground" data-testid="session-model" title="本次会话正在用的模型">
            模型：{modelText}
          </span>
        ) : null}
        {session.busy ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="session-busy">
            <Loader2 className="size-3 animate-spin" />
            忙
          </span>
        ) : null}
        {connection === "live" ? null : (
          <Badge variant="warning" data-testid="session-connection" data-connection={connection}>
            {connection === "connecting" ? "连接会话流…" : "重连中…"}
          </Badge>
        )}
        {ompSessionId !== "" ? (
          <Badge variant="outline" className="font-mono" title={ompSessionId} data-testid="session-id">
            {shortId}
          </Badge>
        ) : null}
        {session.cwd !== "" ? (
          <span
            className="min-w-0 max-w-[16rem] truncate font-mono text-[11px] text-muted-foreground"
            title={session.cwd}
            data-testid="session-cwd"
          >
            cwd {session.cwd}
          </span>
        ) : null}
        {costText !== "" ? (
          <Badge variant="muted" data-testid="session-cost">
            成本 {costText}
          </Badge>
        ) : null}
        {session.lastActivityAt ? (
          <span className="text-[11px] text-muted-foreground">最近活动 {timeAgo(session.lastActivityAt)}</span>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {status === "running" || status === "starting" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={action !== null}
              data-testid="session-stop"
              onClick={() => void act("stop")}
            >
              <Square />
              {action === "stop" ? "停止中…" : "停止"}
            </Button>
          ) : (
            <Button size="xs" disabled={action !== null} data-testid="session-start" onClick={() => void act("start")}>
              <Play />
              {action === "start" ? "启动中…" : status === "ended" ? "重新启动会话" : "启动会话"}
            </Button>
          )}
          {session.busy ? (
            <Button
              size="xs"
              variant="destructive"
              disabled={action !== null}
              data-testid="session-abort"
              onClick={() => void act("abort")}
            >
              <Hand />
              {action === "abort" ? "中断中…" : "中断"}
            </Button>
          ) : null}
          {/* 没会话事实也没转录的卡（会话视图里不会有，卡片详情里有）不显示删除：没东西可删。 */}
          {status !== "stopped" || messages.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={action !== null}
              data-testid="session-delete"
              title="停进程、清转录；下次启动是全新对话（omp 的会话文件保留）"
              onClick={() => void act("delete")}
            >
              <Trash2 />
              {action === "delete" ? "删除中…" : "删除会话"}
            </Button>
          ) : null}
        </div>
      </div>

      {loadError ? (
        <div
          className={cn(
            "shrink-0 rounded border p-2 text-xs",
            loadError.missing
              ? "border-amber-500/50 bg-amber-50 text-amber-900"
              : "border-red-600/30 bg-red-50 text-red-800",
          )}
          data-testid="session-load-error"
        >
          {loadError.message}
        </div>
      ) : null}

      {connection !== "live" && streamFailures >= 3 ? (
        <p className="shrink-0 rounded border border-amber-500/50 bg-amber-50 p-2 text-xs text-amber-900">
          对话流连不上：服务端可能还没实现 <code className="font-mono">GET /api/cards/:id/session/stream</code>。
          转录仍可读，接口上线后会自动恢复。
        </p>
      ) : null}

      {notice ? (
        <p
          className={
            notice.tone === "ok"
              ? "shrink-0 rounded border border-emerald-600/30 bg-emerald-50 p-2 text-xs text-emerald-800"
              : "shrink-0 rounded border border-red-600/30 bg-red-50 p-2 text-xs text-red-800"
          }
          data-testid="session-action-notice"
        >
          {notice.text}
        </p>
      ) : null}

      {messages.length === 0 && !loading && status !== "running" ? (
        <p className="shrink-0 rounded border border-dashed bg-muted/40 p-2 text-xs text-muted-foreground">
          这张卡的托管会话
          {status === "ended" ? "已经结束了" : status === "failed" ? "启动失败" : "还没启动"}
          ：点「启动会话」就能在这里直接对话 —— 会话在卡片自己的 worktree 里跑，助手的回复、
          工具调用与终端输出都会显示在下面（不用另开终端窗口）。
          {card.worktree ? "" : "这张卡还没绑 worktree，cwd 由服务端决定。"}
        </p>
      ) : null}

      {/* 转录：**自己滚**（外层给高度，内层 absolute 铺满），别指望整页滚 */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={onScroll}
          className="absolute inset-0 overflow-y-auto rounded-md border bg-muted/20 p-2"
          data-testid="session-transcript"
        >
          {/* 内容用一层包起来：ResizeObserver 才量得到「撑高」这件事 */}
          <div ref={contentRef} className="space-y-2">
            {loading && messages.length === 0 ? (
              <p className="text-xs text-muted-foreground">读取会话转录…</p>
            ) : null}
            {messages
              // 修复前落库的空助手行（omp 那种"只有思考/工具调用、没有正文"的消息）不渲染
              .filter((message) => !(message.role === "assistant" && (message.text ?? "").trim() === ""))
              .map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
            {view.notices.length > 0 ? (
              <ul className="space-y-0.5" data-testid="session-notices">
                {view.notices.map((item, index) => (
                  <li
                    key={`${item.at}-${index}`}
                    className={cn(
                      "rounded border px-1.5 py-1 text-[11px]",
                      item.level === "error"
                        ? "border-red-600/30 bg-red-50 text-red-800"
                        : item.level === "warn"
                          ? "border-amber-500/40 bg-amber-50 text-amber-900"
                          : "border-border bg-muted/40 text-muted-foreground",
                    )}
                  >
                    {item.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {stick ? null : (
          <Button
            size="xs"
            variant="outline"
            className="absolute bottom-2 right-2 bg-background shadow-md"
            data-testid="session-jump-latest"
            onClick={() => {
              stickRef.current = true;
              setStick(true);
              const element = listRef.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
          >
            <ChevronDown />
            跳到最新
          </Button>
        )}
      </div>

      <div
        className="shrink-0 space-y-1.5"
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
        }}
        onDrop={onDrop}
      >
        <Textarea
          data-testid="session-input"
          value={draft}
          rows={2}
          placeholder={
            streaming ? "跟这张卡说点什么…（Enter 发送 / Shift+Enter 换行；图片可粘贴或拖放）" : "先启动会话再发消息"
          }
          disabled={!streaming}
          onChange={(event) => setDraft(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) void act("prompt");
          }}
          className="min-h-[3.5rem]"
        />

        {pending.length > 0 ? (
          <ul className="flex flex-wrap gap-1" data-testid="session-images">
            {pending.map((image) => (
              <li
                key={image.key}
                className="flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px]"
              >
                <ImagePlus className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-[12rem] truncate font-mono">{image.name}</span>
                <span className="text-muted-foreground">
                  {image.bytes < 1024 ? `${image.bytes} B` : `${Math.round(image.bytes / 1024)} KB`}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${image.name}`}
                  onClick={() => setPending((prev) => prev.filter((item) => item.key !== image.key))}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {imageErrors.length > 0 ? (
          <ul className="space-y-0.5 rounded border border-red-600/30 bg-red-50 p-1.5 text-[11px] text-red-800">
            {imageErrors.map((item) => (
              <li key={item.key} className="flex gap-1.5">
                <span className="max-w-[10rem] truncate font-mono">{item.name}</span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            data-testid="session-input-file"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length > 0) void ingest(files);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={!streaming}
            onClick={() => fileRef.current?.click()}
            data-testid="session-pick-image"
          >
            <ImagePlus />
            图片
          </Button>
          <Button
            size="xs"
            disabled={!canSend}
            data-testid="session-send"
            onClick={() => void act("prompt")}
          >
            <SendHorizontal />
            {action === "prompt" ? "发送中…" : "发送"}
          </Button>
          <span className="text-[11px] text-muted-foreground" data-testid="session-send-hint">
            {sendHint ?? `单张图片 ≤ ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB · png/jpeg/gif/webp`}
          </span>
        </div>
      </div>
    </div>
  );
}
