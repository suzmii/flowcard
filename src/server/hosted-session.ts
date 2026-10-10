/**
 * 托管会话：每张卡片一个 `omp --mode rpc --no-ui` 子进程（stdio 管道），网页通过 HTTP/SSE
 * 跟它对话并看到工具输出 —— **不弹任何窗口，也不引 node-pty**。
 *
 * 分层（与 `omp-rpc.ts`/`probe.ts` 同一范式）：
 *   1. `omp-rpc.ts` 管协议与子进程（帧解析、纯文本归并、优雅停）；
 *   2. 本模块管**编排与投影**：每卡一条 live 记录、`OmpEvent` → SSE 事件 + 转录落库、
 *      会话身份（`claim`）/退出（`end`）上报成流程事实。`startSession` 可注入（测试塞假 omp）。
 *
 * 两条不变量：
 *   · **会话身份由 flowcard 代表会话上报**（`claim`/`end`），卡片投影与三张表一个都不用改；
 *   · **任何异常都不许抛**：帧坏了、子进程没了、落库失败，一律变成 SSE 事件或状态 `failed`，
 *     绝不会把 HTTP 打成 5xx。
 *
 * 转录落 `session_messages`（**不进事件流**，取舍见 `docs/design.md` §14）：
 * 重启服务后 `snapshot()` 照样给得出历史。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { normalizePath } from "../shared/paths.ts";
import { shortHash } from "../shared/hash.ts";
import type { Card } from "../shared/types.ts";
import { cardBrief } from "./brief.ts";
import { resolveOmpPath } from "./launch.ts";
import { startRpcSession, type OmpEvent, type OmpRpcSession, type StartRpcOptions } from "./omp-rpc.ts";
import type { SessionToolEvent, Store } from "./store.ts";

// ---------------------------------------------------------------- 类型（HTTP 契约）

/** 会话状态：没起过 `stopped`；起着 `starting`→`running`；子进程没了 `ended`（起的失败 `failed`）。 */
export type HostedSessionStatus = "stopped" | "starting" | "running" | "ended" | "failed";

export type SessionCost = { total?: number; cost?: number };

/** 转录里的一条消息（`tool` 行的 `tool` 槽位带工具名/参数/输出）。 */
export type SessionMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  at: string;
  text?: string;
  tool?: SessionToolEvent;
};

export type SessionSnapshot = {
  status: HostedSessionStatus;
  ompSessionId?: string;
  cwd: string;
  startedAt?: string;
  lastActivityAt?: string;
  busy: boolean;
  cost?: SessionCost;
  messages: SessionMessage[];
};

/** 每卡 SSE 推的事件（`type` 就是 SSE 的 `event:` 名，见 `GET /api/cards/:id/session/stream`）。 */
export type SessionEvent =
  | { type: "ready"; ompSessionId?: string; cwd: string }
  | { type: "message"; id: string; role: "user" | "assistant"; textDelta?: string; contentIndex?: number }
  | { type: "message_end"; id: string; role: "user" | "assistant"; text: string; at: string }
  | {
      type: "tool";
      callId: string;
      name: string;
      phase: "start" | "update" | "end";
      args?: unknown;
      output?: string;
      isError?: boolean;
    }
  | { type: "state"; busy: boolean; status: HostedSessionStatus; cost?: SessionCost }
  | { type: "notice"; level: string; message: string }
  | { type: "error"; message: string };

export type SessionError = { code: string; message: string };

export type StartSessionResult = {
  ok: boolean;
  status: HostedSessionStatus;
  ompSessionId?: string;
  cwd?: string;
  error?: SessionError;
};

export type PromptResult = { ok: boolean; messageId?: string; error?: SessionError };
export type SimpleResult = { ok: boolean; error?: SessionError };

/** 上传图片：前端给 `{name, dataBase64}`，这里补 omp 要的 `ImageContent`（mimeType 从扩展名猜）。 */
export type SessionImage = { name: string; dataBase64: string };

export type StartSessionOptions = {
  /** 工作目录；不给就取卡片已绑 worktree，再退项目根。 */
  cwd?: string;
  /** 开工提示（卡片现状 + 待办）：作为 `--append-system-prompt` 注入。 */
  brief?: string;
  /** 起好后立刻发出去的第一条 prompt（"开工"）。 */
  kickoff?: string;
  /** 追加到 argv 之后的参数（如 `--model`）。 */
  args?: readonly string[];
  /**
   * 用 `-r` 续接一条已有的 omp 会话（`changeCwd` 用）。
   * **注意**：omp 的 `-r` 认会话文件头里的 `cwd`，`--cwd` 在续接时会被忽略 ——
   * 要换目录必须传一份改过 `cwd` 的会话文件（见 `writeHandoff`）。
   *
   * 给了它就**只**用它（不再自动续接卡片自己的会话文件，见 `fresh`）。
   */
  resume?: { file?: string | undefined } | undefined;
  /**
   * `true` = 不续接卡片已有的 omp 会话，起一段**新的**对话。
   *
   * 默认（`false`）在卡片已经有会话文件、且文件头跟这张卡/这个 cwd 对得上时自动 `-r` 续接：
   * 一张卡始终是同一段对话 —— 服务重启（托管子进程跟着走）之后再点「启动会话」，
   * 接着聊的是原来的上下文，而不是从零开始。对不上（文件没了/头里的 sessionId 或 cwd 不符）
   * 就退化成新会话，并推一条 `notice` 说明原因。
   */
  fresh?: boolean;
};

/** `changeCwd` 的结果：新 cwd、旧 cwd、以及**是不是真的续接了原会话**。 */
export type ChangeCwdResult = {
  ok: boolean;
  status: HostedSessionStatus;
  /** 新工作目录。 */
  cwd?: string;
  /** 搬之前的工作目录。 */
  previousCwd?: string;
  ompSessionId?: string;
  /** true = 用 `-r` 续接了原会话（同 sessionId、历史都在）；false = 新起了一条会话。 */
  resumed: boolean;
  /** 续接用的会话文件（改过 `cwd` 的 handoff 副本）。 */
  sessionFile?: string;
  /** `ok:false` 或退化成新会话时，说明为什么。 */
  note?: string;
  error?: SessionError;
};

/**
 * `--append-system-prompt` 的值上限：Linux 单个 argv 元素上限 `MAX_ARG_STRLEN` = 128 KiB，
 * 超了 omp 根本起不来（E2BIG），而 flowcard 还会报"已启动会话"。留出余量给别的参数与环境。
 */
export const MAX_INLINE_BRIEF_BYTES = 96 * 1024;

/** 按 UTF-8 边界截到至多 `limit` 字节（不把多字节字符切成两半）。 */
function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let end = limit;
  // 截断点落在续字节上 = 这个字符跨了边界：往回退到字符边界
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * `--append-system-prompt` 该传什么：
 *   · 小 brief（默认路径）→ 直接传正文（**顺手补个换行**，见下）；
 *   · 超过 argv 上限 → 写成文件，传**文件路径**（omp 的 `resolvePromptInput` 判定规则是
 *     "含不含 `\n`"：含换行当正文，否则先试 `Bun.file(值).text()` —— 所以传路径它自己会读进来；
 *     既不撞 E2BIG，也没有 `$(cat …)` 那套）；
 *   · 连文件都写不出去 → 截断 + 注明全文在哪，**绝不让会话因为提示太长而起不来**。
 *
 * 补换行是为了钉死"这是正文不是路径"：不带换行的短字符串会被 omp 当路径去试读。
 */
export function briefPromptArg(
  brief: string,
  cardId: string,
  dir: string = join(tmpdir(), "flowcard-briefs"),
): string {
  if (Buffer.byteLength(brief, "utf8") <= MAX_INLINE_BRIEF_BYTES) {
    return brief.includes("\n") ? brief : `${brief}\n`;
  }
  const file = join(dir, `${cardId}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, brief, { mode: 0o600 });
    return file;
  } catch {
    const note = `\n\n…（提示超过 ${MAX_INLINE_BRIEF_BYTES} 字节，已截断：全文看 \`flowcard show ${cardId}\`）`;
    return `${truncateUtf8(brief, MAX_INLINE_BRIEF_BYTES - Buffer.byteLength(note, "utf8"))}${note}`;
  }
}

export type CardChange = { cardId: string; types: string[] };
export type HostedSessions = {
  start(cardId: string, opts?: StartSessionOptions): Promise<StartSessionResult>;
  prompt(cardId: string, text: string, images?: readonly SessionImage[]): Promise<PromptResult>;
  abort(cardId: string): Promise<SimpleResult>;
  stop(cardId: string): Promise<SimpleResult>;
  /**
   * 把会话搬到新的工作目录（卡片进 worktree 的正规路径）：
   * 停掉当前进程 → 原会话（`-r`，cwd 头改到新目录）续接 → 起来后自己重新 claim（卡片进「实施中」）。
   */
  changeCwd(cardId: string, opts: { cwd: string; brief?: string }): Promise<ChangeCwdResult>;
  /** 服务退出时用：逐个优雅停（关 stdin → omp 自己收尾），并行等。 */
  stopAll(): Promise<void>;
  snapshot(cardId: string): SessionSnapshot;
  /** 订阅这张卡的事件（连上就先给一条 `ready` + `state` 的现况）；返回退订函数。 */
  subscribe(cardId: string, listener: (event: SessionEvent) => void): () => void;
  /** 流程事实（claim/end）落库后回调，看板据此广播 `changed`；返回退订函数。 */
  onCard(listener: (change: CardChange) => void): () => void;
  isLive(cardId: string): boolean;
  liveCardIds(): string[];
  /** 会话（或默认）的工作目录：卡片 worktree 优先，其次项目根。 */
  resolveCwd(cardId: string): string | undefined;
};

export type HostedSessionDeps = {
  store: Pick<Store, "getCard" | "getProject" | "execute" | "appendSessionMessage" | "listSessionMessages">;
  /** 起会话的实现；默认 `startRpcSession`。测试注入假 omp（换 argv/env）。 */
  startSession?: (opts: StartRpcOptions) => OmpRpcSession;
  /** omp 可执行文件的绝对路径；不给就找一次（`resolveOmpPath`），找不到交给 PATH 的 `omp`。 */
  ompPath?: string;
  resolveOmpPath?: (opts?: { run?: never }) => Promise<string | undefined>;
  /** 追加到 omp argv 之后的参数（默认 `--no-title`：省一次标题模型调用）。 */
  args?: readonly string[];
  /** omp 上报扩展的绝对路径（`defaultAdapterPath()`）：给了就显式 `-e` 它 —— 心跳/结束仍由适配器兜底。 */
  adapterPath?: string;
  /** 适配器日志目录（按卡片分文件，不再互相覆盖）。 */
  logDir?: string;
  /** flowcard 自己的基址（适配器要回调 `/api/commands`）。 */
  baseUrl?: string;
  /** 子进程环境追加项（测试用）。 */
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  readyTimeoutMs?: number;
};

// ---------------------------------------------------------------- 取值小工具（纯）

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 前端只给文件名 + base64：mime 按扩展名猜（认不出就当 png，omp 侧也只是给模型看）。 */
export function imageMimeType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "image/png";
}

/** `{name, dataBase64}` → omp 的 `ImageContent`（`pi-ai` 的 `ImageContent`：type/data/mimeType）。 */
export function ompImage(image: SessionImage): Record<string, unknown> {
  return { type: "image", data: image.dataBase64, mimeType: imageMimeType(image.name) };
}

/** 单个工具输出的展示上限：再长就截断（网页要能看，但别把响应撑爆）。 */
export const MAX_TOOL_OUTPUT_CHARS = 8_000;

/**
 * 工具结果 → 给人看的文本（纯函数）：
 *   1. 先说人话：`content` 数组里的 text 块 / `output` / `text` / `stdout` / `error` / `message`；
 *   2. 都没有就 JSON 化（截断）—— 未知形状也比"什么都没有"强，这正是"看到工具输出"要的。
 */
export function toolOutputText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return clip(result);
  const rec = asRecord(result);
  if (rec === null) return clip(JSON.stringify(result));

  const content = rec["content"];
  if (typeof content === "string") return clip(content);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
        continue;
      }
      const b = asRecord(block);
      const text = b === null ? null : asString(b["text"]);
      if (text !== null) parts.push(text);
    }
    if (parts.length > 0) return clip(parts.join(""));
  }
  for (const key of ["output", "text", "stdout", "stderr", "error", "message"]) {
    const value = asString(rec[key]);
    if (value !== null) return clip(value);
  }
  try {
    return clip(JSON.stringify(result));
  } catch {
    return undefined;
  }
}

function clip(text: string): string {
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…（已截断）`;
}

// ---------------------------------------------------------------- 编排

/**
 * 换工作目录时给 omp 的续接文件：把会话文件头里的 `cwd` 改成新目录，拷一份 handoff 副本。
 *
 * 为什么必须拷 + 改头：`omp -r <file>` 拿**文件头里的 `cwd`** 当工作目录，`--cwd` 会被忽略
 * （omp 18.8.7 真机验过）—— 直接 `-r` 原文件的话，会话还在旧目录里跑，卡片永远进不了「实施中」。
 * 副本放进新目录对应的会话目录（omp 把 cwd 里的 `/` 换成 `-` 当目录名），
 * 这样在新目录里用 `omp -r` 的 picker 也能捡到它。认不出会话头时原样返回（不比原来更糟）。
 */
async function writeHandoff(sourceFile: string, oldCwd: string, newCwd: string): Promise<string> {
  const lines = (await readFile(sourceFile, "utf8")).split("\n");
  let patched = false;
  const out = lines.map((line) => {
    if (patched || !line.includes('"type":"session"')) return line;
    let head: unknown;
    try {
      head = JSON.parse(line);
    } catch {
      return line;
    }
    const rec = asRecord(head);
    if (rec?.["type"] !== "session") return line;
    patched = true;
    return JSON.stringify({ ...rec, cwd: newCwd });
  });
  if (!patched) return sourceFile;
  const dir = dirname(sourceFile);
  // omp 的会话目录名 = cwd 里的 `/` 换成 `-`（真机上 `-tmp-fc-wtu-proj` 就是这个形状）。
  const newDirName = normalizePath(newCwd).replace(/\//g, "-");
  const oldDirName = oldCwd === "" ? "" : normalizePath(oldCwd).replace(/\//g, "-");
  const target =
    oldDirName !== "" && basename(dir) === oldDirName
      ? join(dirname(dir), newDirName, basename(sourceFile))
      : join(dir, `handoff-${shortHash(newCwd)}-${basename(sourceFile)}`);
  if (target === sourceFile) return sourceFile;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  return target;
}

/** 会话文件头里我们认的两个字段（`-r` 续接前必须核对，见 `resolveResumeFile`）。 */
type SessionHead = { sessionId: string; cwd: string };

/** 会话文件头（`{"type":"session",...}`）在文件最前面，读前 8 KiB 就够 —— 别为了一行头把整个转录读进内存。 */
const SESSION_HEAD_BYTES = 8 * 1024;

/**
 * 读 omp 会话文件头里的 `{id, cwd}`；读不到（文件没了/头不完整/不是 omp 会话文件）返回 `null`。
 *
 * 为什么续接前非读不可：`omp -r <file>` 拿**文件头里的 cwd** 当工作目录（`--cwd` 被忽略），
 * 头里的 id 又是会话身份 —— 头跟「这张卡 + 这次要跑的 cwd」对不上就不能续：
 * 那会让会话在别的目录里跑，还会把卡片绑到另一段会话上。
 */
async function readSessionHead(file: string): Promise<SessionHead | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(SESSION_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.includes('"type":"session"')) continue;
      let head: unknown;
      try {
        head = JSON.parse(line);
      } catch {
        return null; // 头行本身就是坏的（被截断/不是 JSON）：当作读不出来
      }
      const rec = asRecord(head);
      if (rec?.["type"] !== "session") continue;
      const sessionId = asString(rec["id"]);
      const cwd = asString(rec["cwd"]);
      if (sessionId === null || cwd === null) return null;
      return { sessionId, cwd };
    }
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * `start()` 到底要不要 `-r`、以及为什么（`note` 是给用户看的一句话，不静默降级）。
 *
 * 优先级：
 *   1. 显式 `opts.resume.file`（`changeCwd` 的 handoff 副本）→ 照用；
 *   2. `opts.fresh` 或带 `kickoff`（「开工」= 故意开一段新的）→ 不续接；
 *   3. 卡片上次的会话文件还在、且**头里的 sessionId 就是卡片绑定的会话、cwd 就是这次要跑的 cwd** → 续接；
 *   4. 其它 → 新会话（把原因写进 `note`；卡片压根没有会话时不说多余的话）。
 *
 * 这张卡还没有会话、或本来就要开新的，都算正常路径，不报 `note`。
 */
async function resolveResumeFile(
  card: Card,
  cwd: string,
  opts: StartSessionOptions,
): Promise<{ file: string | null; note?: string }> {
  const explicit = opts.resume?.file;
  if (explicit !== undefined && explicit !== "") return { file: explicit };
  if (opts.fresh === true || opts.kickoff !== undefined) return { file: null };

  const bound = card.session;
  const file = bound?.file ?? "";
  const sessionId = bound?.id ?? "";
  if (bound === null || file === "" || sessionId === "") return { file: null };
  if (!existsSync(file)) {
    return { file: null, note: `上次的会话文件不在了（${file}）：这次从新的一段对话开始` };
  }
  const head = await readSessionHead(file);
  if (head === null) {
    return { file: null, note: `读不出会话文件头（${file}）：这次从新的一段对话开始` };
  }
  if (head.sessionId !== sessionId) {
    return {
      file: null,
      note: `会话文件里的 id（${head.sessionId}）和卡片绑的会话（${sessionId}）对不上：这次从新的一段对话开始`,
    };
  }
  if (normalizePath(head.cwd) !== normalizePath(cwd)) {
    return {
      file: null,
      note: `上次的会话在 ${head.cwd} 里跑，这次要在 ${cwd}：这次从新的一段对话开始（要带着历史换目录用 \`flowcard worktree use\`）`,
    };
  }
  return { file };
}

/** omp 的会话状态快照（只取我们用的字段）。 */
type OmpState = { sessionId?: unknown; sessionFile?: unknown };

type Live = {
  cardId: string;
  cwd: string;
  /** 外部消息 id 的前缀：omp 的 `msg-1` 在 `new_session`/重启后会重复，转录里必须能区分。 */
  tag: string;
  session: OmpRpcSession;
  startedAt: string;
  lastActivityAt: string;
  status: HostedSessionStatus;
  ompSessionId: string | null;
  /** omp 落盘的会话文件（`get_session_stats.sessionFile`）；`changeCwd` 用它做 `-r` 续接。 */
  sessionFile: string | null;
  cost: SessionCost | null;
  busy: boolean;
  claimed: boolean;
  exited: boolean;
  /**
   * 用户点过「停止」（`stop()`）：进程没了之后**不要再自动续接**——那是人的明确意图。
   * 崩溃 / 服务重启（`stopAll()`）不置这一位：那种情况要能自动续接，不然会话就永久作废了。
   */
  stoppedByUser: boolean;
  /**
   * omp 说过"还没静默"（`prompt_result.sessionSettled:false`）：还有排队/后台的活在跑，
   * 得等 `session_settled` 才算这一程结束（**`session_settled` 是"静下来了"，不是"会话结束了"**）。
   */
  awaitingSettle: boolean;
  /** 是否真的见过 `ready` 帧（决定退出时怎么报：起来了才说"会话已退出"）。 */
  readyOk: boolean;
  promptSeq: number;
  /** 每条 omp messageId 第一次出现的时间（写转录用，别让 delta 每次刷新时间）。 */
  seenAt: Map<string, string>;
  off: () => void;
};

export function createHostedSessions(deps: HostedSessionDeps): HostedSessions {
  const store = deps.store;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const startSession = deps.startSession ?? startRpcSession;
  const findOmpPath = deps.resolveOmpPath ?? resolveOmpPath;

  const records = new Map<string, Live>();
  const listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  const cardListeners = new Set<(change: CardChange) => void>();
  let ompPathCache: string | null | undefined;

  const deliver = (listener: (event: SessionEvent) => void, event: SessionEvent): void => {
    try {
      listener(event);
    } catch {
      // 订阅者自己抛错不能拆掉会话（SSE 客户端可能已经断了）。
    }
  };

  const emit = (live: Live, event: SessionEvent): void => {
    for (const listener of [...(listeners.get(live.cardId) ?? [])]) deliver(listener, event);
  };

  const emitState = (live: Live): void => {
    emit(live, {
      type: "state",
      busy: live.busy,
      status: live.status,
      ...(live.cost === null ? {} : { cost: live.cost }),
    });
  };

  const notifyCard = (cardId: string, types: string[]): void => {
    for (const listener of [...cardListeners]) {
      try {
        listener({ cardId, types });
      } catch {
        // 同 deliver()：回调不该影响流程。
      }
    }
  };

  const defaultCwd = (cardId: string): string | undefined => {
    const card = store.getCard(cardId);
    if (!card) return undefined;
    if (card.worktree && card.worktree.path !== "") return card.worktree.path;
    const project = store.getProject(card.projectId);
    if (project && project.virtual !== true && project.path !== "") return project.path;
    return undefined;
  };

  /**
   * 续接这个会话该用哪个会话文件：进程内记住的那份（`get_session_stats.sessionFile`）优先，
   * 退到卡片事实里的 `session.file`（服务重启后进程内那份就没了）。都没有 → null（续接不了）。
   */
  const resumableFile = (live: Live): string | null => {
    const file = live.sessionFile ?? store.getCard(live.cardId)?.session?.file ?? null;
    return file === null || file === "" ? null : file;
  };

  /** 转录落库（失败只报一条 notice：事件已经推出去了，不该因此拆掉会话）。 */
  const persist = (live: Live, message: SessionMessage): void => {
    try {
      store.appendSessionMessage({
        cardId: live.cardId,
        messageId: message.id,
        role: message.role,
        at: message.at,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.tool === undefined ? {} : { tool: message.tool }),
      });
    } catch (error) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `转录没落库（不影响会话）：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const externalId = (live: Live, ompMessageId: string): string => `${live.tag}:${ompMessageId}`;

  const seenAt = (live: Live, ompMessageId: string): string => {
    const found = live.seenAt.get(ompMessageId);
    if (found !== undefined) return found;
    const at = now();
    live.seenAt.set(ompMessageId, at);
    return at;
  };

  /** 从 `get_session_stats` 的 data 里取 tokens/cost（顺手也拿 sessionFile）。 */
  const applyStats = (live: Live, data: unknown): void => {
    const rec = asRecord(data);
    if (rec === null) return;
    const tokens = asRecord(rec["tokens"]);
    const total = tokens === null ? null : asNumber(tokens["total"]);
    const cost = asNumber(rec["cost"]);
    if (total === null && cost === null) return;
    live.cost = {
      ...(live.cost ?? {}),
      ...(total === null ? {} : { total }),
      ...(cost === null ? {} : { cost }),
    };
  };

  const refreshStats = async (live: Live): Promise<void> => {
    // 进程没了就别再问它了（写死管道只会白报一条 io 错）。
    if (live.exited) return;
    const out = await live.session.request<Record<string, unknown>>(
      { type: "get_session_stats" },
      { timeoutMs: 10_000 },
    );
    if (records.get(live.cardId) !== live || live.exited || !out.ok) return;
    const before = JSON.stringify(live.cost);
    applyStats(live, out.data);
    if (JSON.stringify(live.cost) !== before) emitState(live);
  };

  /** 拿会话身份 → 代表会话发 `claim`（卡片投影与三张表都不用改）。 */
  const identify = async (live: Live): Promise<void> => {
    const state = await live.session.request<OmpState>({ type: "get_state" }, { timeoutMs: 10_000 });
    if (records.get(live.cardId) !== live || live.exited) return;
    const stats = await live.session.request<Record<string, unknown>>(
      { type: "get_session_stats" },
      { timeoutMs: 10_000 },
    );
    if (records.get(live.cardId) !== live || live.exited) return;
    if (stats.ok) applyStats(live, stats.data);

    const sid = state.ok ? asString(state.data?.sessionId) : null;
    if (sid === null) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `拿不到 omp 会话身份（get_state ${state.ok ? "没有 sessionId" : `失败：${state.message}`}）：这张卡不会被 claim`,
      });
      return;
    }
    live.ompSessionId = sid;
    const file = stats.ok ? asString(stats.data?.["sessionFile"]) : null;
    live.sessionFile = file;
    const result = store.execute({
      cmd: "claim",
      actor: { kind: "agent", harness: "omp", sessionId: sid },
      card: live.cardId,
      session: {
        harness: "omp",
        id: sid,
        cwd: live.cwd,
        agentKind: "main",
        ...(file === null ? {} : { file }),
        resumeHint: `omp -r ${file ?? sid}`,
      },
    });
    const rejection = result.outcome.rejection;
    if (rejection) {
      emit(live, {
        type: "notice",
        level: "warning",
        message: `claim 被拒（${rejection.code}）：${rejection.message}`,
      });
      return;
    }
    live.claimed = true;
    notifyCard(
      live.cardId,
      result.outcome.events.map((event) => event.type),
    );
  };

  /** 子进程没了：状态收尾 + 代表会话发 `end`（幂等，适配器也可能发过同一条）。 */
  const handleExit = (live: Live): void => {
    if (live.exited) return;
    live.exited = true;
    // 还没起来就退 = 起的失败；起来过再退 = 结束。
    live.status = live.status === "starting" ? "failed" : "ended";
    live.busy = false;
    live.awaitingSettle = false;
    live.off();
    if (live.claimed) {
      const sessions = live.ompSessionId === null ? {} : { sessionId: live.ompSessionId };
      const result = store.execute({
        cmd: "end",
        actor: { kind: "agent", harness: "omp", ...sessions },
        card: live.cardId,
        ...sessions,
      });
      if (!result.outcome.rejection) {
        notifyCard(
          live.cardId,
          result.outcome.events.map((event) => event.type),
        );
      }
    }
    // 没起来就退的细节（退出码/stderr）由 bringUp 报，别在这里报一句"没什么信息"的话。
    if (live.readyOk) {
      emit(live, {
        type: "notice",
        level: live.stoppedByUser ? "info" : "warning",
        message: live.stoppedByUser
          ? "会话已停止"
          : resumableFile(live) === null
            ? "omp 会话进程没了（没留下会话文件，续接不了）"
            : "omp 会话进程没了：下一条消息会自动用 `-r` 续接同一条会话（历史与卡片绑定都不变）",
      });
    }
    emitState(live);
  };

  const handle = (live: Live, event: OmpEvent): void => {
    if (records.get(live.cardId) !== live) return;
    live.lastActivityAt = now();
    switch (event.kind) {
      case "text": {
        emit(live, {
          type: "message",
          id: externalId(live, event.messageId),
          role: "assistant",
          textDelta: event.delta,
          ...(event.contentIndex === null ? {} : { contentIndex: event.contentIndex }),
        });
        break;
      }
      case "text_end": {
        // 权威块文本到了：先落一次（这样 message_end 丢了也还有）。
        const id = externalId(live, event.messageId);
        persist(live, {
          id,
          role: "assistant",
          at: seenAt(live, event.messageId),
          text: live.session.textFor(event.messageId) ?? event.text,
        });
        break;
      }
      case "message": {
        // 用户消息由 flowcard 自己 echo（prompt 时就写好了）；工具结果走 tool_execution_*。
        if (event.role !== "assistant") break;
        const id = externalId(live, event.messageId);
        if (event.phase === "start") {
          seenAt(live, event.messageId);
          break;
        }
        const text = event.text ?? live.session.textFor(event.messageId) ?? "";
        const at = seenAt(live, event.messageId);
        persist(live, { id, role: "assistant", at, text });
        emit(live, { type: "message_end", id, role: "assistant", text, at });
        break;
      }
      case "tool": {
        const output = toolOutputText(event.result);
        const tool: SessionToolEvent = {
          callId: event.toolCallId,
          name: event.toolName,
          status: event.phase,
          ...(event.args === undefined ? {} : { args: event.args }),
          ...(output === undefined ? {} : { output }),
          ...(event.isError === null ? {} : { isError: event.isError }),
        };
        persist(live, { id: `${live.tag}:${event.toolCallId}`, role: "tool", at: now(), tool });
        emit(live, {
          type: "tool",
          callId: event.toolCallId,
          name: event.toolName,
          phase: event.phase,
          ...(event.args === undefined ? {} : { args: event.args }),
          ...(output === undefined ? {} : { output }),
          ...(event.isError === null ? {} : { isError: event.isError }),
        });
        break;
      }
      case "notice":
        emit(live, { type: "notice", level: event.level, message: event.message });
        break;
      case "error":
        // 自己发的命令失败（get_state/stats 之类）不是会话级故障：降级成 notice，别的照旧是 error。
        if (event.scope === "command" && event.command !== "prompt") {
          emit(live, { type: "notice", level: "warning", message: event.message });
        } else {
          emit(live, { type: "error", message: event.message });
        }
        break;
      case "result":
        // `sessionSettled:false` = 这一轮虽然交了卷，但 omp 那边还有排队/后台的活在跑：
        // 先别把 busy 放下（放置 `awaitingSettle`，等 `session_settled` 收尾）。
        live.awaitingSettle = !event.sessionSettled;
        live.busy = !event.sessionSettled;
        if (event.status === "error" && event.error !== null) {
          emit(live, { type: "error", message: `这一轮出错了：${event.error}` });
        }
        emitState(live);
        void refreshStats(live);
        break;
      case "settled":
        // `session_settled` 的语义是**「这一程静下来了」**（没有在跑的 run、没有排队、没有后台活），
        // **不是「会话结束了」**——会话照常活着，下一条 prompt 照收。
        // 只有确实在等它（`awaitingSettle`）时才把 busy 放下：免得把新一轮刚置上的 busy 抹掉。
        live.awaitingSettle = false;
        if (live.busy) {
          live.busy = false;
          emitState(live);
        }
        break;
      case "ui":
        // `--no-ui` 下扩展是 headless，正常不会来；真来了也没人能答 —— 一律取消，别让会话挂住。
        live.session.send({ type: "extension_ui_response", id: event.id, cancelled: true });
        emit(live, {
          type: "notice",
          level: "warning",
          message: `收到 UI 请求 ${event.method}，headless 下无人应答，已自动取消`,
        });
        break;
      case "exit":
        handleExit(live);
        break;
      default:
        // ready/response/thinking/turn/agent/queue/command_output/other：不进网页也不落库。
        break;
    }
  };

  const sessionEnv = (cardId: string): NodeJS.ProcessEnv => {
    const base = deps.baseUrl ?? `http://${process.env.FLOWCARD_HOST ?? "127.0.0.1"}:${process.env.FLOWCARD_PORT ?? "47825"}`;
    const env: NodeJS.ProcessEnv = { ...process.env, FLOWCARD_CARD: cardId, FLOWCARD_URL: base };
    if (deps.logDir !== undefined) env["FLOWCARD_OMP_LOG"] = `${deps.logDir}/omp-${cardId}.log`;
    return { ...env, ...(deps.env ?? {}) };
  };

  /** 起好后：等 ready → 拿身份 → claim → 发 `ready` → 发开工提示。全程不抛。 */
  const bringUp = async (live: Live, opts: StartSessionOptions): Promise<void> => {
    const ready = await live.session.ready;
    if (records.get(live.cardId) !== live) return;
    if (!ready.ok) {
      // 起不来（早退/超时/spawn 失败）：状态落 `failed`，把原因说清楚，并把这个没用的子进程收掉。
      live.status = "failed";
      const tail = ready.stderr.trim();
      emit(live, {
        type: "error",
        message: `omp 没起来（${ready.reason}）：${ready.message}${tail === "" ? "" : `｜stderr: ${tail.split("\n")[0] ?? ""}`}`,
      });
      emitState(live);
      if (!live.exited) void live.session.stop().catch(() => undefined);
      return;
    }
    if (live.exited) return;
    live.readyOk = true;
    live.session.setEventFilter(null, "delta");
    await identify(live);
    if (records.get(live.cardId) !== live || live.exited) return;
    live.status = "running";
    live.lastActivityAt = now();
    emit(live, {
      type: "ready",
      ...(live.ompSessionId === null ? {} : { ompSessionId: live.ompSessionId }),
      cwd: live.cwd,
    });
    emitState(live);
    if (opts.kickoff !== undefined && opts.kickoff !== "") {
      const sent = await prompt(live.cardId, opts.kickoff);
      if (!sent.ok && records.get(live.cardId) === live && !live.exited) {
        emit(live, { type: "error", message: `开工提示没发出去：${sent.error?.message ?? "未知原因"}` });
      }
    }
  };

  const resolveOmpPathOnce = async (): Promise<string | undefined> => {
    if (deps.ompPath !== undefined) return deps.ompPath;
    if (ompPathCache === undefined) {
      ompPathCache = (await findOmpPath().catch(() => undefined)) ?? null;
    }
    return ompPathCache ?? undefined;
  };

  const start = async (cardId: string, opts: StartSessionOptions = {}): Promise<StartSessionResult> => {
    const card = store.getCard(cardId);
    if (!card) {
      return { ok: false, status: "stopped", error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } };
    }
    const existing = records.get(cardId);
    if (existing && (existing.status === "starting" || existing.status === "running")) {
      return {
        ok: true,
        status: existing.status,
        ...(existing.ompSessionId === null ? {} : { ompSessionId: existing.ompSessionId }),
        cwd: existing.cwd,
      };
    }
    if (existing) existing.off(); // 旧记录只留状态与转录

    const cwd = opts.cwd ?? defaultCwd(cardId);
    if (cwd === undefined || cwd === "") {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "NO_CWD",
          message: `卡片 ${cardId} 既没绑 worktree，也不属于任何真实项目：没有会话的工作目录`,
        },
      };
    }
    if (!existsSync(cwd)) {
      return {
        ok: false,
        status: "failed",
        error: { code: "NO_CWD", message: `会话的工作目录不存在：${cwd}` },
      };
    }

    const ompPath = await resolveOmpPathOnce();
    /**
     * 续接：`-r <会话文件>`。
     * 真机验过（omp 18.8.7）：**`-r` 时 omp 拿会话文件头里的 `cwd` 当工作目录，`--cwd` 被忽略** ——
     * 换目录必须给一份改过头的会话文件（`writeHandoff`），只传 `--cwd` 是白搭。
     *
     * 没显式指定就去认卡片自己的会话文件（见 `resolveResumeFile`）：一张卡始终是同一段对话，
     * 服务重启把托管子进程带走之后，再点「启动会话」接着的是原来的上下文。
     */
    const { file: resumeFile, note: resumeNote } = await resolveResumeFile(card, cwd, opts);
    const args = [
      ...(deps.args ?? ["--no-title"]),
      ...(deps.adapterPath === undefined ? [] : ["-e", deps.adapterPath]),
      // brief 可能是正文，也可能是落盘后的路径（超大提示走路径，见 briefPromptArg）
      ...(opts.brief === undefined ? [] : ["--append-system-prompt", briefPromptArg(opts.brief, cardId)]),
      ...(resumeFile === null ? [] : ["-r", resumeFile]),
      ...(opts.args ?? []),
    ];
    const session = startSession({
      cwd,
      ...(ompPath === undefined ? {} : { ompPath }),
      args,
      env: sessionEnv(cardId),
      ...(deps.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: deps.readyTimeoutMs }),
    });

    const live: Live = {
      cardId,
      cwd,
      tag: randomUUID().slice(0, 8),
      session,
      startedAt: now(),
      lastActivityAt: now(),
      status: "starting",
      ompSessionId: null,
      sessionFile: null,
      cost: null,
      busy: false,
      claimed: false,
      exited: false,
      stoppedByUser: false,
      awaitingSettle: false,
      readyOk: false,
      promptSeq: 0,
      seenAt: new Map(),
      off: () => undefined,
    };
    records.set(cardId, live);
    live.off = session.on((event) => handle(live, event));
    emitState(live);
    // 降级成新会话的原因（文件没了/头对不上）—— 说清一句，别让"上下文丢了"变成看不见的事
    if (resumeNote !== undefined) emit(live, { type: "notice", level: "warning", message: resumeNote });
    void bringUp(live, opts);

    return { ok: true, status: "starting", cwd };
  };

  /** `revive()` 的结果：判别式联合，`ok:false` 一定带得出原因（HTTP 层直接透给用户看）。 */
  type ReviveOutcome = { ok: true } | { ok: false; error: SessionError };

  /**
   * 会话进程没了之后把**同一条**会话续起来（`-r <会话文件>`）——「会话要能一直对话」的兜底：
   *   · 用户点过「停止」→ 不续（那是人的明确意图，要接着聊就重新起会话）；
   *   · 有会话文件 → `start({cwd, resume:{file}})`：同 sessionId、同转录、卡片绑定不变；
   *   · 没有会话文件 → 说清楚为什么，**绝不悄悄起一条新会话**（那会把"接着聊"偷换成"换了会话"）。
   * `cwd` 只能取会话文件头里的那个（`-r` 时 omp 忽略 `--cwd`，真机验过，见 docs/omp-rpc.md）。
   */
  const revive = async (cardId: string, live: Live | undefined): Promise<ReviveOutcome> => {
    if (live?.stoppedByUser) {
      return {
        ok: false,
        error: { code: "STOPPED", message: `卡片 ${cardId} 的会话已被停止：要接着聊请重新起会话` },
      };
    }
    const card = store.getCard(cardId);
    if (!card) return { ok: false, error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } };
    const file = live === undefined ? (card.session?.file ?? null) : resumableFile(live);
    const cwd = live?.cwd ?? card.session?.cwd ?? defaultCwd(cardId);
    if (file === null || cwd === undefined || cwd === "") {
      return {
        ok: false,
        error: {
          code: "NO_SESSION",
          message:
            live === undefined
              ? `卡片 ${cardId} 没有会话（也没有可续接的会话文件）`
              : `卡片 ${cardId} 的会话进程已退出，而且没留下会话文件：续接不了，请重新起会话`,
        },
      };
    }
    const started = await start(cardId, { cwd, resume: { file } });
    if (!started.ok) {
      return { ok: false, error: started.error ?? { code: "NO_SESSION", message: `卡片 ${cardId} 的会话续不起来` } };
    }
    const next = records.get(cardId);
    if (next) {
      emit(next, {
        type: "notice",
        level: "info",
        message: `会话进程不在了：已用 \`-r\` 续接同一条 omp 会话（${file}）`,
      });
    }
    return { ok: true };
  };

  const prompt = async (
    cardId: string,
    text: string,
    images: readonly SessionImage[] = [],
  ): Promise<PromptResult> => {
    let live = records.get(cardId);
    // 进程没了（崩溃 / 服务重启时被 stopAll 收掉）不代表会话作废：先把它续起来再说话。
    if (live === undefined || live.exited) {
      const revived = await revive(cardId, live);
      if (!revived.ok) return { ok: false, error: revived.error };
      live = records.get(cardId);
      if (live === undefined) {
        return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 的会话没起来` } };
      }
    }
    // 起会话的流程还在跑就先等它：命令早于 ready 会被 omp 丢掉（ready 永不 reject）。
    if (live.status === "starting") {
      const outcome = await live.session.ready;
      if (!outcome.ok) {
        return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 的会话没起来` } };
      }
    }
    if (records.get(cardId) !== live || live.exited || live.status === "failed") {
      return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 的会话没起来` } };
    }
    const id = `${live.tag}:p${++live.promptSeq}`;
    const sent = live.session.send({
      id,
      type: "prompt",
      message: text,
      ...(images.length === 0 ? {} : { images: images.map(ompImage) }),
    });
    if (!sent) {
      return { ok: false, error: { code: "SEND_FAILED", message: "命令没写进 omp 的 stdin" } };
    }
    const at = now();
    persist(live, { id, role: "user", at, text });
    live.busy = true;
    live.lastActivityAt = at;
    emit(live, { type: "message_end", id, role: "user", text, at });
    emitState(live);
    return { ok: true, messageId: id };
  };

  const abort = async (cardId: string): Promise<SimpleResult> => {
    const live = records.get(cardId);
    if (!live || live.exited) {
      return { ok: false, error: { code: "NO_SESSION", message: `卡片 ${cardId} 没有在跑的会话` } };
    }
    if (!live.session.abort()) {
      return { ok: false, error: { code: "SEND_FAILED", message: "中断命令没写进 omp 的 stdin" } };
    }
    return { ok: true };
  };

  const stop = async (cardId: string): Promise<SimpleResult> => {
    const live = records.get(cardId);
    if (!live) return { ok: true };
    // 关 stdin → omp 自己收尾退出 → exit 事件里发 `end`；幂等（已经退了就直接返回）。
    // 这一位只在**人**点停止时置上：之后进程没了也不再自动续接（崩溃/服务重启不置，那种要能续）。
    live.stoppedByUser = true;
    await live.session.stop();
    return { ok: true };
  };

  /**
   * 把会话搬到新 cwd —— 卡片进 worktree 的正规路径（`flowcard worktree use` 的第二步）：
   * 停掉旧进程 → 用改过 `cwd` 头的会话文件 `-r` 续接（同 sessionId、历史不断）→ 起来后 bringUp
   * 自己重新 claim（cwd 已在新目录）→ 卡片自动进「实施中」。
   *
   * 原会话没留下会话文件（或文件没了/读不动）就退化成新起一条会话：卡片照样能进「实施中」，
   * 但 omp 侧的历史断了——这种情况在 `note` 里明说，不静默。
   */
  const changeCwd = async (cardId: string, opts: { cwd: string; brief?: string }): Promise<ChangeCwdResult> => {
    const card = store.getCard(cardId);
    if (!card) {
      return { ok: false, status: "stopped", resumed: false, error: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` } };
    }
    if (!existsSync(opts.cwd)) {
      return {
        ok: false,
        status: "failed",
        resumed: false,
        error: { code: "NO_CWD", message: `会话的新工作目录不存在：${opts.cwd}` },
      };
    }
    const live = records.get(cardId);
    const previousCwd = live?.cwd ?? card.session?.cwd ?? defaultCwd(cardId);
    const source = live?.sessionFile ?? card.session?.file ?? null;

    // 1) 先停：会话文件正被 omp 写着，不停就拷到半截（stop() 会等进程真的退）。
    if (live && !live.exited) await live.session.stop();

    // 2) 续接来源：改过 `cwd` 头的 handoff 副本（`-r` 时 omp 忽略 `--cwd`，见 writeHandoff）。
    let resume: { file: string } | null = null;
    let note: string | undefined;
    if (source === null) {
      note =
        live === undefined && card.session === null
          ? "这张卡还没有会话：已在新目录起一条会话"
          : "原会话没留下会话文件：已在新目录起一条会话（omp 侧历史断了）";
    } else {
      const handoff = await writeHandoff(source, previousCwd ?? "", opts.cwd).catch((error: unknown) => {
        note = `续接没成（${error instanceof Error ? error.message : String(error)}）：已在新目录起一条会话`;
        return null;
      });
      if (handoff !== null) resume = { file: handoff };
    }

    // 3) 起会话：brief 按绑定后的新 worktree 重新生成（调用方没给才自己算）。
    const project = store.getProject(card.projectId);
    const fresh = store.getCard(cardId) ?? card;
    const brief =
      opts.brief ??
      cardBrief({
        card: fresh,
        ...(project === undefined ? {} : { project }),
        ...(fresh.worktree === null ? {} : { worktree: { path: fresh.worktree.path, branch: fresh.worktree.branch } }),
      });
    const started = await start(cardId, { cwd: opts.cwd, brief, ...(resume === null ? {} : { resume }) });
    return {
      ...started,
      ...(previousCwd === undefined ? {} : { previousCwd }),
      resumed: resume !== null,
      ...(resume === null ? {} : { sessionFile: resume.file }),
      ...(note === undefined ? {} : { note }),
    };
  };

  const snapshot = (cardId: string): SessionSnapshot => {
    const messages: SessionMessage[] = store.listSessionMessages(cardId).map((row) => ({
      id: row.messageId,
      role: row.role,
      at: row.at,
      ...(row.text === undefined ? {} : { text: row.text }),
      ...(row.tool === undefined ? {} : { tool: row.tool }),
    }));
    const live = records.get(cardId);
    if (!live) {
      // 本进程没起过（比如重启过）：有转录就是「已结束」，没有就是「没起过」。
      return {
        status: messages.length === 0 ? "stopped" : "ended",
        cwd: defaultCwd(cardId) ?? "",
        busy: false,
        messages,
      };
    }
    return {
      status: live.status,
      ...(live.ompSessionId === null ? {} : { ompSessionId: live.ompSessionId }),
      cwd: live.cwd,
      startedAt: live.startedAt,
      lastActivityAt: live.lastActivityAt,
      busy: live.busy,
      ...(live.cost === null ? {} : { cost: live.cost }),
      messages,
    };
  };

  const subscribe = (cardId: string, listener: (event: SessionEvent) => void): (() => void) => {
    let set = listeners.get(cardId);
    if (set === undefined) {
      set = new Set();
      listeners.set(cardId, set);
    }
    set.add(listener);
    // 连上就先给现况（历史走 `GET .../session`），前端一幅画面都不用等。
    const current = snapshot(cardId);
    deliver(listener, {
      type: "ready",
      ...(current.ompSessionId === undefined ? {} : { ompSessionId: current.ompSessionId }),
      cwd: current.cwd,
    });
    deliver(listener, {
      type: "state",
      busy: current.busy,
      status: current.status,
      ...(current.cost === undefined ? {} : { cost: current.cost }),
    });
    return () => {
      set.delete(listener);
    };
  };

  const isLive = (cardId: string): boolean => {
    const live = records.get(cardId);
    return live !== undefined && !live.exited && (live.status === "starting" || live.status === "running");
  };

  return {
    start,
    prompt,
    abort,
    stop,
    changeCwd,
    async stopAll() {
      await Promise.all([...records.values()].map((live) => live.session.stop().catch(() => undefined)));
    },
    snapshot,
    subscribe,
    onCard(listener) {
      cardListeners.add(listener);
      return () => {
        cardListeners.delete(listener);
      };
    },
    isLive,
    liveCardIds: () => [...records.values()].filter((live) => !live.exited).map((live) => live.cardId),
    resolveCwd: (cardId) => records.get(cardId)?.cwd ?? defaultCwd(cardId),
  };
}
