/**
 * 引擎：`命令 -> 事件[]`。纯函数，不碰 IO、不碰时钟（时间由调用方传入）。
 *
 * 三段式：
 *   A 命令事实（claim/bind/push/comment…）→ 事件
 *   B 显式转换请求（如 unblock/cleanup）→ 过 requires 才放行
 *   C 自动节点：对每个事实事件跑 flow.automations，动作同样过 requires
 * requires 不满足时**不是报错**，而是把缺项回报给调用方（写事件已经落库，状态不动）。
 *
 * ## 幂等键的分层规则（`dedupeKey` 是存储层的全局唯一索引，重复写入会**静默**丢掉）
 *
 * 用「命令内容」当键会让**同内容的第二次合法操作**被当成重复请求吞掉（第二次 unblock、
 * 同理由的第二次 block、G4 被驳回后重新提清单、删除→恢复→再删除、A→B→A→B 改回旧值…
 * 症状全是「命令返回 ok，但状态没动」）。所以按下面两类分开：
 *
 * 1. **带外部身份的事实** → 保持「内容/身份寻址」的键，重复就是同一件事，天生重试安全：
 *    - `push:{card}:{sha}`、`sync:*`（`factKey`：issue/PR 的编号 + 远端 updatedAt、评论 id）、
 *      `open:{title/body/projectId 的指纹}`（同内容 = 同一张卡）、`spawn` / `comment` 的内容键。
 *    - 会话身份：`claim:{card}:{sessionId}:{hash(cwd)}:{这一轮的起点}` / `end:{card}:{sessionId}:{起点}`
 *      —— 起点是当前会话的 `startedAt`，所以「会话结束后用同一个 id 在同一目录恢复（omp -r）」
 *      是新的一轮、能刷新；同一轮的重复上报仍然是同一个键。
 * 2. **意图类命令**（block / unblock / delete / restore / drop / accept / worktree / bindIssue /
 *    bindPr / decideGate / proposeCleanup / cleanup / probePr / reviewVerdict）→ 键是
 *    **`{cmd}:{card}:{card.eventCount}`**（见 `intentKey`）：`eventCount` 是卡片版本，
 *    版本没变的重试会被去重，版本变了之后的同内容操作是新键。
 *    **重复语义由引擎自己的状态守卫保证**（setter「值没变就跳过」、unblock 查 state、
 *    delete 查 deletedAt、proposeCleanup 查 G4 是否未决…），所以重试不会写出第二条事实。
 *    （`probePr` 也是这一类：观察到的值没变就跳过。放在这里是因为 PR 会 open→closed→open，
 *    内容寻址的键会把"重新打开"和第一次的 open 撞成同一条。）
 * 3. **心跳**：30s 分桶 + `shortHash(cwd)`。同一桶里 cwd 从主仓库变到 worktree 是两件不同的事，
 *    不带 cwd 的话第二拍会被去重吞掉，而引擎的本地投影已经应用过它 → 落库的投影与事件对不上。
 *
 * 调用方显式给了 `--dedupe-key`（`cmd.dedupeKey`）时以上键都只是后缀：前缀仍然由它说了算。
 */
import { describeMissing, missingRequirements, type Flow } from "../shared/flow.ts";
import { isAbsolute, join } from "node:path";
import { normalizePath } from "../shared/paths.ts";
import { shortHash } from "../shared/hash.ts";
import { LOCAL_PROJECT_ID, type Card, type Command, type CwdClaimResolution, type EventType, type IssueRef, type PrRef, type Project, type Rejection, type SyncFactIn } from "../shared/types.ts";
import { applyEvent, emptyCard, type NewEvent } from "./project.ts";
import { reviewAnchor } from "./review.ts";
import { factKey } from "./sync.ts";

export type CommandOutcome = {
  events: NewEvent[];
  /** 主卡片？spawn 会同时动父卡与新卡，所以给整张表。 */
  cards: Record<string, Card>;
  primaryCardId: string;
  rejection?: Rejection;
  blocked?: { transition: string; missing: string[]; describe: string[] };
  notes: string[];
};

const MAX_DERIVED_EVENTS = 50;

/** 自动标题的长度上限（中文按 1 个字符计）。 */
export const DERIVED_TITLE_MAX = 40;

/** 空正文（或整段正文只有图片/markdown 符号）时的兜底标题。 */
export const UNTITLED = "未命名卡片";

/**
 * 正文 → 标题：取**第一个有文本的段落** → 去掉 markdown 语法 → 折叠空白 → 截断 40 字符。
 *
 * 细节都按"要能当标题读"来定：
 * - 图片 `![]()` 整段丢掉（alt 通常是文件名，当标题只会误导）；链接 `[](url)` **保留链接文字**（那是人写的字）；
 * - 代码/强调标记只去标记，不去内容；`#`/`>`/列表符只去**行首的标记**，所以 `#42 修登录` 里的 issue 号留着；
 * - 按**码点**截断（emoji 不会被切成半个字符）。
 */
export function deriveTitle(body: string): string {
  for (const paragraph of body.split(/\n\s*\n/)) {
    const text = paragraph
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`+/g, "")
      .replace(/\*/g, "")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text === "") continue;
    const chars = [...text];
    return chars.length > DERIVED_TITLE_MAX
      ? `${chars.slice(0, DERIVED_TITLE_MAX).join("")}…`
      : text;
  }
  return UNTITLED;
}

/** 带 card 的命令的卡片 id；claim 允许不写（由 cwd 解析），所以是 string | undefined。 */
const cardIdOf = (cmd: Command): string | undefined => ("card" in cmd ? cmd.card : undefined);

/**
 * 意图类命令的幂等键：`{cmd}:{card}:{card.eventCount}`。
 *
 * `eventCount` 是**命令开始前**的卡片版本（每折一条事件 +1），所以：
 * - 同一次请求重试（什么都没写成，版本没变）→ 同一个键 → 被存储层去重；
 * - 上一次已经写成了（版本变了）→ 新键 → 同内容的第二次合法操作不会被历史键吞掉。
 *
 * 注意 `card` 必须是命令开始时读到的投影（不能用 `applyPending` 之后的），
 * 否则一条命令里多次取键会各拿一个版本，重试时对不上。
 */
const intentKey = (name: string, card: Card): string => `${name}:${card.id}:${card.eventCount}`;

/**
 * 绑 Issue 的补齐：**编号是命令给的，`repo`/`url` 缺省时用卡片所属项目的 Issue 基址补**。
 *
 * 纯函数（项目由调用方传进来，引擎不碰 IO）。项目没基址、调用方也没给 → `USAGE_ERROR`，
 * 并把两条出路写进 hint：给项目配基址（`flowcard project issue-base`），或这次显式给 `--url`。
 */
export function resolveIssueRef(
  input: {
    number: number;
    repo?: string | undefined;
    url?: string | undefined;
    title?: string | undefined;
    state: "open" | "closed";
  },
  project: Project | undefined,
): { ok: true; issue: IssueRef } | { ok: false; rejection: Rejection } {
  const repo = input.repo ?? project?.issueRepo;
  const url =
    input.url ??
    (project?.issueUrlTemplate
      ? project.issueUrlTemplate.replaceAll("{number}", String(input.number))
      : undefined);

  if (repo && url) {
    return {
      ok: true,
      issue: {
        repo,
        number: input.number,
        url,
        ...(input.title ? { title: input.title } : {}),
        state: input.state,
      },
    };
  }

  const missing = [...(repo ? [] : ["repo"]), ...(url ? [] : ["url"])];
  const projectId = project?.id ?? LOCAL_PROJECT_ID;
  return {
    ok: false,
    rejection: {
      code: "USAGE_ERROR",
      message: `Issue 只给了编号 ${input.number}，却补不出 ${missing.join(" 与 ")}（项目 ${projectId} 没有 Issue 基址）`,
      hint:
        `给 flowcard project issue-base ${projectId} --repo <owner/repo> --template "https://<host>/<owner/repo>/issues/{number}"，` +
        `或这次显式 --repo <owner/repo> --url <链接>`,
    },
  };
}

/**
 * 同步事实 → 卡片上的 PR 状态。三条规矩（都是为了「不拿更弱的信息覆盖更强的已知事实」）：
 *
 * 1. 事实确认合并（`merged:true` 或 `state:"merged"`）→ `merged`；
 * 2. 事实说 `open` 而卡片已经是 `draft` → **保留 `draft`**（draft 比 open 精确，不能降级）；
 * 3. 事实是 `closed` 但 `merged` 未知（tea CLI 兜底拿不到这个位）而卡片已知 `merged` → 保留 `merged`。
 */
export function nextPrState(pr: PrRef, fact: Extract<SyncFactIn, { kind: "pr.state" }>): PrRef["state"] {
  if (fact.merged === true || fact.state === "merged") return "merged";
  if (fact.state === "open") return pr.state === "draft" ? "draft" : "open";
  if (fact.merged === null && pr.state === "merged") return "merged";
  return "closed";
}

export function runCommand(input: {
  flow: Flow;
  getCard: (id: string) => Card | undefined;
  cmd: Command;
  now: string;
  newCardId: () => string;
  /**
   * `claim` 没给 card 时用它按 cwd 找卡片。解析要读全部卡片（IO），所以由 server/store 注入，
   * 引擎自己保持纯函数；没注入（如测试 harness 不关心）时 claim 不给 card 会直接 NOT_FOUND。
   */
  resolveCardByCwd?: (cwd: string) => CwdClaimResolution;
  /**
   * `open` 按 `projectId` 解析项目（要 `path` 才算得出卡片上的 repoPath）。与 `getCard` 一样由
   * store 注入：引擎保持纯函数。没注入时（如测试 harness）只认不写 `projectId` 的 open ——
   * 显式给 `projectId` 却查不到项目会直接拒绝，免得卡片的归属和实际仓库对不上。
   */
  getProject?: (id: string) => Project | undefined;
}): CommandOutcome {
  const { flow, cmd, now } = input;
  const local = new Map<string, Card>();
  const events: NewEvent[] = [];
  const notes: string[] = [];
  let applied = 0;
  let blocked: CommandOutcome["blocked"];
  /** `cleanup` 的两条事件（completed + done 转换）共用同一版本次，见 B' 段。 */
  let cleanupKey: string | undefined;

  const get = (id: string): Card | undefined => local.get(id) ?? input.getCard(id);

  const applyPending = (): void => {
    for (; applied < events.length; applied++) {
      const ev = events[applied]!;
      const base = get(ev.cardId) ?? emptyCard(ev.cardId, now);
      local.set(ev.cardId, applyEvent(base, ev));
    }
  };

  const emit = (cardId: string, type: EventType, payload: Record<string, unknown>, key: string): void => {
    // `applySync` 的事实自带幂等键（`factKey`），没有命令级的 `dedupeKey` 可拼。
    const prefix = "dedupeKey" in cmd ? cmd.dedupeKey : undefined;
    events.push({
      at: now,
      actor: cmd.actor,
      cardId,
      type,
      payload,
      dedupeKey: prefix ? `${prefix}#${key}` : key,
    });
  };

  const gateOpen = (card: Card, exceptId?: string): string | undefined =>
    Object.values(card.gates).find((g) => g.status === "open" && g.id !== exceptId)?.id;

  const fail = (r: Rejection): CommandOutcome => ({
    events: [],
    cards: {},
    primaryCardId: cardIdOf(cmd) ?? "",
    rejection: r,
    notes,
  });

  /** B 段：显式转换请求。 */
  const requestTransition = (cardId: string, to: Card["state"], key: string): void => {
    const card = get(cardId);
    if (!card || card.state === to) return;
    const from = card.state;
    const missing = missingRequirements(flow, from, to, card);
    if (missing.length > 0) {
      blocked = {
        transition: `${from} -> ${to}`,
        missing,
        describe: describeMissing(flow, missing),
      };
      notes.push(`状态未前进：${from} -> ${to} 缺 ${missing.join(", ")}`);
      return;
    }
    emit(cardId, "card.state.changed", { from, to }, `${key}#state`);
    applyPending();
  };

  // ------------------------------------------------------------ A 段：命令事实

  let primaryCardId = cardIdOf(cmd) ?? "";

  switch (cmd.cmd) {
    case "open": {
      const id = input.newCardId();
      primaryCardId = id;
      // 归属项目：显式给了就必须存在（不能悄悄落到 local 让别人以为卡在项目里）；
      // 没给就是合成项目 local（没归属的卡，含所有老卡片）。
      const projectId = cmd.projectId ?? LOCAL_PROJECT_ID;
      const project = input.getProject?.(projectId);
      if (cmd.projectId && !project) {
        return fail({
          code: "NOT_FOUND",
          message: `项目 ${cmd.projectId} 不存在`,
          hint: `先登记仓库：flowcard project add <仓库路径>（flowcard project list 看现有项目）`,
        });
      }
      // 标题缺省时从正文派生（标题可选），派生结果落进事件 → 历史稳定、不随规则重算而变。
      const givenTitle = cmd.title?.trim() ?? "";
      const title = givenTitle === "" ? deriveTitle(cmd.body) : givenTitle;
      const repoPath = project && !project.virtual ? project.path : undefined;
      // 开卡就带 Issue：同样只要求编号，repo/url 由项目的基址补齐。
      const issue = cmd.issue ? resolveIssueRef(cmd.issue, project) : undefined;
      if (issue && !issue.ok) return fail(issue.rejection);
      const resolved = issue?.ok ? issue.issue : undefined;
      // 幂等键不掺 id（id 每次分配都会变），否则重试会写出一张重复卡片。
      // 但**只把"同一分钟内的同样内容"当重试**：否则想再开一张内容相同的卡就永远建不出来
      // （用户实际撞过：正文写 "Issue 742"，第一次建出来了，之后每次都被当重复吞掉，看着像"创建不了"）。
      const minuteBucket = Math.floor(Date.parse(now) / 60_000);
      const fingerprint = shortHash(`${title}\n${cmd.body}\n${projectId}\n${minuteBucket}`);
      emit(
        id,
        "card.opened",
        {
          title,
          body: cmd.body,
          projectId,
          ...(repoPath ? { repoPath } : {}),
          ...(cmd.partOf ? { partOf: cmd.partOf } : {}),
          ...(resolved ? { issue: resolved } : {}),
        },
        `open:${fingerprint}`,
      );
      if (resolved) {
        emit(
          id,
          "issue.bound",
          { issue: resolved },
          `issue:${resolved.repo}#${resolved.number}:${fingerprint}`,
        );
      }
      break;
    }

    case "bindIssue": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const built = resolveIssueRef(
        { number: cmd.number, repo: cmd.repo, url: cmd.url, title: cmd.title, state: "open" },
        input.getProject?.(card.projectId),
      );
      if (!built.ok) return fail(built.rejection);
      const issue = built.issue;
      const sameIssue = card.issue?.repo === issue.repo && card.issue?.number === issue.number;
      if (sameIssue) {
        notes.push("Issue 已经是该值，跳过");
        break;
      }
      emit(cmd.card, "issue.bound", { issue }, intentKey("issue", card));
      break;
    }

    case "decideGate": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const gate = card.gates[cmd.gate];
      if (!gate) return fail({ code: "NOT_FOUND", message: `门禁 ${cmd.gate} 不存在` });
      if (gate.status !== "open") {
        return fail({ code: "STATE_NOT_ALLOWED", message: `门禁 ${cmd.gate} 已经是 ${gate.status}` });
      }
      emit(
        cmd.card,
        "gate.decided",
        { gate: cmd.gate, decision: cmd.decision, ...(cmd.reason ? { reason: cmd.reason } : {}) },
        intentKey("gate-decision", card),
      );
      break;
    }

    /**
     * G2：申请一次远程写确认。detail 就是「将执行的确切命令 / URL」，人照它做判断。
     *
     * 幂等键带上「同样内容的确认里已经结算（被驳回或已 consume）的条数」：
     * - 重复发送同一条申请 → 键相同 → 不产生第二条（幂等）；
     * - 用掉/被拒之后再申请同样的一件事 → 结算数变了 → 是新的一次申请。
     *   （否则「第二次写必须重新申请」会被自己的幂等键吞掉，agent 永远申请不出来。）
     */
    case "requestConfirm": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const settled = card.confirmations.filter(
        (c) =>
          c.action === cmd.action &&
          c.detail === cmd.detail &&
          (c.status === "rejected" || c.consumedAt !== undefined),
      ).length;
      emit(
        cmd.card,
        "confirm.requested",
        { action: cmd.action, detail: cmd.detail },
        `confirm:${cmd.card}:${cmd.action}:${shortHash(cmd.detail)}:${settled}`,
      );
      break;
    }

    /** G2 决策：批准 / 驳回（驳回必须给理由——下一次申请才知道该怎么改）。 */
    case "decideConfirm": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const target = card.confirmations.find((c) => c.id === cmd.id);
      if (!target) {
        return fail({
          code: "NOT_FOUND",
          message: `确认 ${cmd.id} 不存在`,
          hint: `flowcard confirm ${cmd.card} --list 看这张卡现有的确认`,
        });
      }
      if (target.status !== "pending") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `确认 ${cmd.id} 已经是 ${target.status === "approved" ? "已批准" : "已驳回"}，不能重复决策`,
        });
      }
      if (cmd.decision === "rejected" && !cmd.reason?.trim()) {
        return fail({
          code: "USAGE_ERROR",
          message: `驳回确认 ${cmd.id} 必须给理由`,
          hint: "写清为什么不许：agent 要靠它改 detail 再申请一次",
        });
      }
      emit(
        cmd.card,
        "confirm.decided",
        { id: cmd.id, decision: cmd.decision, ...(cmd.reason ? { reason: cmd.reason } : {}) },
        `confirm:${cmd.card}:${cmd.id}:${cmd.decision}`,
      );
      break;
    }

    /**
     * G2：agent 回报「这次授权已经用掉了」。**一次批准只覆盖一次动作**，
     * 所以只有 approved 且没 consumedAt 才能成功；失败情形要分得开。
     */
    case "consumeConfirm": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const target = card.confirmations.find((c) => c.id === cmd.id);
      if (!target) {
        return fail({
          code: "NOT_FOUND",
          message: `确认 ${cmd.id} 不存在`,
          hint: `flowcard confirm ${cmd.card} --list 看这张卡现有的确认`,
        });
      }
      if (target.status === "pending") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `确认 ${cmd.id} 还没被批准，不能使用`,
          hint: `先批准：flowcard confirm ${cmd.card} --approve ${cmd.id}（或看板上批准）`,
        });
      }
      if (target.status === "rejected") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `确认 ${cmd.id} 已被驳回${target.reason ? `（${target.reason}）` : ""}，不能使用`,
          hint: "被驳回的申请永久失效；真要执行就重新申请一次",
        });
      }
      if (target.consumedAt) {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `确认 ${cmd.id} 已经在 ${target.consumedAt} 被用掉了，一次授权只覆盖一次动作`,
          hint: `再执行一次远程写就重新申请：flowcard confirm ${cmd.card} --request --for ${target.action} --detail "…"`,
        });
      }
      emit(cmd.card, "confirm.consumed", { id: cmd.id }, `confirm:${cmd.card}:${cmd.id}:consumed`);
      break;
    }

    case "worktree": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      // 统一成绝对路径：会话 cwd 一定是绝对的，相对路径比前缀会永远不相等（卡片就永远进不了实施中）
      const projectPath = input.getProject?.(card.projectId)?.path;
      const rawPath = cmd.worktree.path;
      if (!isAbsolute(rawPath) && !projectPath) {
        return fail({
          code: "USAGE_ERROR",
          message: `worktree 路径 "${rawPath}" 是相对路径，而这张卡没有归属项目可作基准`,
          hint: "给绝对路径，或先把卡片归属到一个项目（flowcard project add …）",
        });
      }
      const worktree = isAbsolute(rawPath)
        ? { ...cmd.worktree, path: normalizePath(rawPath) }
        : { ...cmd.worktree, path: normalizePath(join(projectPath!, rawPath)) };
      const same = card.worktree?.path === worktree.path && card.worktree?.branch === worktree.branch;
      if (same) {
        // 声明式 setter：值没变就是 no-op（重试天然幂等）
        notes.push("worktree 已经是该值，跳过");
        break;
      }
      // 声明式 setter：值没变就是 no-op（重试天然幂等）。
      // 键用卡片版本（不带前值）：A→B→A→B 每一次都是新版本，
      // 改回旧值、或同分支换路径（正是重登记 worktree 的场景）都不会被历史键吞掉。
      emit(cmd.card, "worktree.bound", { worktree }, intentKey("worktree", card));
      break;
    }

    case "claim": {
      if (cmd.session.agentKind !== "main") {
        return fail({
          code: "USAGE_ERROR",
          message: "只有 main 会话能绑定卡片（subagent 归 harness 自己管）",
        });
      }
      let cardId = cmd.card;
      if (!cardId) {
        // 没给 card：按会话 cwd 在全部卡片里找 worktree。解析失败要能直接告诉人「在哪个目录里跑才有卡」。
        const resolved = input.resolveCardByCwd?.(cmd.session.cwd);
        if (!resolved || "error" in resolved) {
          return fail({
            code: "NOT_FOUND",
            message:
              resolved?.error.message ??
              `cwd ${cmd.session.cwd} 解析不到卡片（这个实例没装 cwd 解析）`,
            hint:
              resolved?.error.hint ??
              "在卡片的 worktree 目录里启动会话，或显式指定 FLOWCARD_CARD=<card>",
          });
        }
        cardId = resolved.cardId;
        primaryCardId = cardId;
      }
      const card = get(cardId);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cardId} 不存在` });
      const current = card.session;
      if (current && current.state === "running" && current.id !== cmd.session.id) {
        return fail({
          code: "SESSION_CONFLICT",
          message: `卡片已绑定活跃会话 ${current.harness}:${current.id}`,
          hint: "一张卡片同一时刻只能有一个活跃会话；先结束它，或改绑同一会话",
        });
      }
      // 同 id 同 cwd 且还在跑 = 同一次 claim 的重发：直接跳过（不依赖幂等键也不写事件）。
      if (current && current.id === cmd.session.id && current.cwd === cmd.session.cwd && current.state === "running") {
        notes.push("会话已经绑在这张卡上（同 id 同 cwd），跳过");
        break;
      }
      /**
       * 幂等键 = 身份（卡片 + 会话 id + cwd）+ **这一轮的起点**（当前会话的 `startedAt`）。
       * 于是「会话结束后用同一个 id 在**同一目录**恢复（适配器的 resumeHint）再 claim」是新的一轮
       * → 新键 → 能把投影从 ended 刷回 running；而同一轮里的重复上报仍然是同一个键。
       * （键里带 cwd：omp 的 `/wt`、`/move` 之后从新目录 claim 必须能刷新记录。）
       */
      const runMarker = current && current.id === cmd.session.id ? current.startedAt : "-";
      emit(
        cardId,
        "session.started",
        { session: cmd.session },
        `claim:${cardId}:${cmd.session.id}:${shortHash(cmd.session.cwd)}:${runMarker}`,
      );
      break;
    }

    case "beat": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (!card.session) {
        return fail({
          code: "NOT_FOUND",
          message: `卡片 ${cmd.card} 还没有会话`,
          hint: "先在 worktree 里开会话并 claim",
        });
      }
      if (card.session.id !== cmd.session.id) {
        // 未知 sessionId 的心跳一律不认（new_session 换 id 的坑），只记一笔。
        notes.push(`忽略未知会话 ${cmd.session.id} 的心跳（卡片绑定的是 ${card.session.id}）`);
        break;
      }
      // 心跳按 30s 分桶去重：分桶粒度就是 lastSeenAt 的分辨率，
      // 所以存活判定的 TTL 必须 ≥ 3 个桶（设计里取 90s）。
      // 键里还要带 cwd：同一个桶里 cwd 从主仓库变到 worktree 是**两件不同的事**，
      // 只按分桶去重会把第二拍吞掉，而引擎的本地投影已经应用过它 → 落库的投影与事件对不上。
      const bucket = Math.floor(Date.parse(now) / 30_000);
      const cwdTag = shortHash(cmd.session.cwd);
      emit(
        cmd.card,
        "session.heartbeat",
        { cwd: cmd.session.cwd },
        `beat:${cmd.card}:${cmd.session.id}:${bucket}:${cwdTag}`,
      );
      applyPending();
      const after = get(cmd.card)!;
      if (after.worktree && after.state === "working") {
        const inside = cmd.session.cwd.startsWith(after.worktree.path);
        if (!inside) {
          emit(
            cmd.card,
            "session.cwd.mismatch",
            { cwd: cmd.session.cwd, worktree: after.worktree.path },
            `mismatch:${cmd.card}:${cmd.session.id}:${bucket}:${cwdTag}`,
          );
        }
      }
      break;
    }

    case "bindPr": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const samePr =
        card.pr?.number === cmd.pr.number &&
        card.pr?.state === cmd.pr.state &&
        card.pr?.url === cmd.pr.url;
      if (samePr) {
        notes.push("PR 已经是该值，跳过");
        break;
      }
      emit(cmd.card, "pr.bound", { pr: cmd.pr }, intentKey("pr", card));
      break;
    }

    case "push": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      emit(cmd.card, "push.recorded", { sha: cmd.sha }, `push:${cmd.card}:${cmd.sha}`);
      break;
    }

    case "end": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.session && cmd.sessionId && card.session.id !== cmd.sessionId) {
        return fail({ code: "SESSION_CONFLICT", message: `会话 ${cmd.sessionId} 不是卡片当前会话` });
      }
      // 键 = 身份（卡片 + 会话 id）+ 这一轮的起点（`startedAt`）：同一次 end 重发被去重，
      // 而「会话结束后用同一 id 恢复、跑完再 end」是新的一轮 → 新键 → 不会被第一次的键吞掉。
      emit(
        cmd.card,
        "session.ended",
        { ...(cmd.summary ? { summary: cmd.summary } : {}) },
        `end:${cmd.card}:${card.session?.id ?? "-"}:${card.session?.startedAt ?? "-"}`,
      );
      break;
    }

    case "accept": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      // 验收是一次性的事实（`acceptedAt` 永不重置）：重发同一条不写第二条、也不重置 G3。
      if (card.acceptedAt) {
        notes.push("卡片已经验收过，跳过");
        break;
      }
      const key = intentKey("accept", card);
      emit(cmd.card, "gate.requested", { gate: "G3", kind: "review", title: "验收" }, `${key}:gate`);
      emit(
        cmd.card,
        "gate.decided",
        { gate: "G3", decision: "approved", ...(cmd.reason ? { reason: cmd.reason } : {}) },
        `${key}:gate:approved`,
      );
      emit(cmd.card, "card.accepted", {}, key);
      break;
    }

    case "drop": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.state === "dropped") {
        notes.push("卡片已经是放弃状态，跳过");
        break;
      }
      if (card.state === "done") {
        return fail({ code: "STATE_NOT_ALLOWED", message: "已完成的卡片不能放弃" });
      }
      // 放弃是决定，得留痕：理由进评论，状态另记。两条事件共用同一版本次（都是命令卡片的版本）。
      const key = intentKey("drop", card);
      emit(cmd.card, "card.comment.added", { body: `放弃：${cmd.reason}` }, `${key}:reason`);
      applyPending();
      const now2 = get(cmd.card)!;
      emit(
        cmd.card,
        "card.state.changed",
        { from: now2.state, to: "dropped" },
        `${key}:state`,
      );
      break;
    }

    case "delete": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.deletedAt) {
        notes.push("卡片已经是删除状态，跳过");
        break;
      }
      // 键用卡片版本（不是理由的指纹）：删除→恢复→再删除（同理由或都不填理由）必须还能删掉。
      emit(
        cmd.card,
        "card.deleted",
        { ...(cmd.reason ? { reason: cmd.reason } : {}) },
        intentKey("delete", card),
      );
      break;
    }

    case "restore": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (!card.deletedAt) {
        notes.push("卡片本来就没被删除，跳过");
        break;
      }
      emit(cmd.card, "card.restored", {}, intentKey("restore", card));
      break;
    }

    case "block": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      /**
       * 阻塞是「停下来补前置」，只能落在还能干的卡上：
       * `card.blocked` 是无条件置 blocked 的投影事件，放行 done/dropped/merged（或已删除）的卡
       * 等于把它们拉回实施中（done 卡再 unblock 就进 working，merged 卡还能绕过 G4）。
       */
      if (card.deletedAt) {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: "卡片已删除，不能标记阻塞",
          hint: `先恢复：flowcard restore ${cmd.card}`,
        });
      }
      if (card.state === "done" || card.state === "dropped" || card.state === "merged") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `卡片当前是 ${card.state}，不能再标记阻塞`,
          hint:
            card.state === "merged"
              ? "已合并的卡片只在清理阶段（G4）：要拦清理就在评审里说清楚，而不是阻塞这张卡"
              : "阻塞只用于实施中的卡；这张卡已经结束了（要重开就另开一张卡）",
        });
      }
      // 同一条阻塞理由重发是重试：不写第二条（换了理由则要更新，所以按 reason 比）。
      if (card.state === "blocked" && card.blockedReason === cmd.reason) {
        notes.push("卡片已经是这个阻塞原因，跳过");
        break;
      }
      emit(cmd.card, "card.blocked", { reason: cmd.reason }, intentKey("block", card));
      break;
    }

    case "unblock": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.state !== "blocked") {
        return fail({ code: "STATE_NOT_ALLOWED", message: `卡片当前是 ${card.state}，不是 blocked` });
      }
      requestTransition(cmd.card, "working", intentKey("unblock", card));
      break;
    }

    case "probePr": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      /**
       * 观察到的值没变 = 同一次上报的重发 → no-op（重复语义由守卫保证，不靠键）。
       *
       * 键用卡片版本而不是「编号 + 状态」：PR 会 open→closed→**open**，内容寻址的键会把
       * 重新打开的那次和第一次的 `open` 撞成同一条（静默吞掉）；而带 `from:前值` 也只能防住
       * 一次往返（open→closed→open→closed 的第 4 次又撞第 2 次）。版本键 + 值没变守卫两头都保。
       */
      // 与 `probeCommands` 的"该不该发"用同一套比较（含 CI：只 CI 变了的探测也要落库）。
      const same =
        card.pr?.number === cmd.pr.number &&
        card.pr?.state === cmd.pr.state &&
        card.pr?.url === cmd.pr.url &&
        card.pr?.branch === cmd.pr.branch &&
        (card.pr?.ci ?? null) === (cmd.pr.ci ?? null);
      if (same) {
        notes.push("PR 状态没有变化，跳过");
        break;
      }
      const merged = cmd.pr.state === "merged";
      const type: EventType = merged && card.pr?.state !== "merged" ? "pr.merged" : "pr.updated";
      emit(cmd.card, type, { pr: cmd.pr }, intentKey("probe", card));
      break;
    }

    case "proposeCleanup": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.pr?.state !== "merged") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: "PR 还没合并，不许拆验证现场",
          hint: "PR 合并后（probePr 汇报 merged）才能提清理",
        });
      }
      const open = gateOpen(card, "G4");
      if (open) return fail({ code: "GATE_PENDING", message: `门禁 ${open} 还没决策` });
      /**
       * **G4 被驳回之后**重新提清单必须能提上去（旧键恒定，第二次提会被自己的幂等键吞掉，
       * 卡就永久停在 merged：decideGate 报 STATE_NOT_ALLOWED、cleanup 报 GATE_PENDING，无路可走）。
       * 但「清单已提交、还在等决策」与「G4 已批准」时重发是同一次请求的重试 → 跳过，
       * 免得把 `requestedAt` 与已有决策抹掉。（G4 刚由自动化打开、还没提清单时不算重发：payload 里没 items。）
       */
      const g4 = card.gates.G4;
      const alreadyProposed = Array.isArray(g4?.payload?.items) && g4.payload.items.length > 0;
      if (g4 && (g4.status === "approved" || (g4.status === "open" && alreadyProposed))) {
        notes.push(
          g4.status === "approved"
            ? "G4 已经批准：清单不用再提，直接 cleanup"
            : "清理清单已经提交，等 G4 决策，跳过",
        );
        break;
      }
      emit(cmd.card, "cleanup.proposed", { items: cmd.items }, intentKey("cleanup-plan", card));
      break;
    }

    case "cleanup": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.gates.G4?.status !== "approved") {
        return fail({
          code: "GATE_PENDING",
          message: "清理必须先经 G4 批准",
          hint: `flowcard cleanup ${cmd.card} --propose-item … → flowcard gate ${cmd.card} --gate G4 --approve`,
        });
      }
      // 清理是一次性事实（`cleanedAt` 不复位）：重发不写第二条、也不再跑一次 done 转换。
      if (card.cleanedAt) {
        notes.push("清理已经完成，跳过");
        break;
      }
      cleanupKey = intentKey("cleanup", card);
      emit(cmd.card, "cleanup.completed", {}, cleanupKey);
      break;
    }

    case "comment": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      emit(
        cmd.card,
        "card.comment.added",
        { body: cmd.body },
        `comment:${cmd.card}:${shortHash(cmd.body)}`,
      );
      break;
    }

    /**
     * 代码评审：**本地事实，不是远程写**。评论只落进事件流（不回写 Gitea），
     * 所以这里不走 G2、不发任何网络请求；判定同理，**不改流程状态**（G3 验收仍由人 `accept`）。
     */
    case "reviewComment": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      // 幂等键 = 锚点 + 正文指纹：同一条评论重发不产生第二条；同位置另写一条（内容不同）算新评论。
      emit(
        cmd.card,
        "review.comment.added",
        { sha: cmd.sha, path: cmd.path, line: cmd.line, side: cmd.side, body: cmd.body },
        `review-comment:${cmd.card}:${cmd.sha}:${cmd.path}:${cmd.line}:${cmd.side}:${shortHash(cmd.body)}`,
      );
      notes.push(`评审注释已记录：${reviewAnchor(cmd)}`);
      break;
    }

    case "reviewVerdict": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      /**
       * 幂等键用卡片版本：A→B→A→B 每次都记得上（旧键带"前值"只能防住 A→B→A）。
       * 同一条判定（同 verdict + 同正文）重发则由下面的守卫拦成 no-op —— 重复语义不靠键。
       */
      const previous = card.review.verdict;
      if (previous && previous.decision === cmd.verdict && (previous.body ?? "") === (cmd.body ?? "")) {
        notes.push(`判定没有变化（${cmd.verdict}），跳过`);
        break;
      }
      emit(
        cmd.card,
        "review.verdict.recorded",
        { verdict: cmd.verdict, ...(cmd.body ? { body: cmd.body } : {}) },
        intentKey("review-verdict", card),
      );
      notes.push(`评审判定已记录：${cmd.verdict}（不改流程状态：验收仍由人在看板上点 G3）`);
      break;
    }

    /**
     * 同步事实 → 事件。**每张卡一条命令**（同步器按编号解析好 card），事实只有一条路进来：
     * 幂等键一律 `factKey(fact)`，所以同一事实重复同步只会落一次。
     * 编号与卡片对不上就跳过（同步器已经按已绑编号过滤过，这里是兜底）。
     */
    case "applySync": {
      if (!get(cmd.card)) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      for (const fact of cmd.facts) {
        const card = get(cmd.card)!;
        if (fact.kind === "issue.state") {
          if (card.issue?.number !== fact.number) continue;
          emit(
            cmd.card,
            "issue.state.changed",
            { number: fact.number, state: fact.state, title: fact.title, updatedAt: fact.updatedAt },
            factKey(fact),
          );
        } else if (fact.kind === "pr.state") {
          if (card.pr?.number !== fact.number) continue;
          const state = nextPrState(card.pr, fact);
          const merged = state === "merged";
          emit(
            cmd.card,
            merged ? "pr.merged" : "pr.updated",
            { pr: { ...card.pr, state, branch: fact.head !== "" ? fact.head : card.pr.branch } },
            factKey(fact),
          );
        } else {
          emit(
            cmd.card,
            "remote.comment.added",
            {
              id: fact.id,
              issueNumber: fact.issueNumber,
              author: fact.author,
              body: fact.body,
              at: fact.at,
              url: fact.url,
            },
            factKey(fact),
          );
        }
        applyPending();
      }
      break;
    }

    /**
     * 远端评论标记已读（人打开详情时前端调）。`ids` 不给 = 当前全部未读；
     * 一条未读都没有就**不发事件** —— 所以连着调两次的第二次是空操作（幂等）。
     */
    case "markRemoteCommentsRead": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const wanted = cmd.ids ? new Set(cmd.ids) : null;
      const ids = card.remoteComments
        .filter((comment) => !comment.read && (wanted === null || wanted.has(comment.id)))
        .map((comment) => comment.id);
      if (ids.length === 0) {
        notes.push("没有未读的远端评论，跳过");
        break;
      }
      emit(
        cmd.card,
        "remote.comments.read",
        { ids },
        `remote-read:${cmd.card}:${shortHash(ids.join(","))}`,
      );
      break;
    }

    case "spawn": {
      const parent = get(cmd.card);
      if (!parent) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const id = input.newCardId();
      primaryCardId = id;
      emit(
        id,
        "card.opened",
        {
          title: cmd.title,
          body: cmd.body,
          partOf: cmd.card,
          projectId: parent.projectId,
          ...(parent.issue ? { issue: parent.issue } : {}),
          ...(parent.repoPath ? { repoPath: parent.repoPath } : {}),
        },
        `spawn:${cmd.card}:${shortHash(cmd.title)}`,
      );
      emit(
        cmd.card,
        "card.spawned",
        { childId: id, title: cmd.title },
        `spawn-parent:${cmd.card}:${shortHash(cmd.title)}`,
      );
      break;
    }

    /**
     * 运行时状态事件。引擎不管进程（spawn/kill 在适配层）：这里只校验卡片存在、
     * 把「状态 + 进程身份」原样落成事件，投影后就是卡片上的启动按钮状态。
     */
    case "runtime": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (cmd.to === "running" && cmd.pid === undefined) {
        return fail({ code: "USAGE_ERROR", message: "runtime running 事件必须带 pid" });
      }
      const type: EventType =
        cmd.to === "starting"
          ? "runtime.starting"
          : cmd.to === "running"
            ? "runtime.started"
            : cmd.to === "failed"
              ? "runtime.failed"
              : "runtime.stopped";
      emit(
        cmd.card,
        type,
        {
          ...(cmd.pid !== undefined ? { pid: cmd.pid } : {}),
          ...(cmd.pgid !== undefined ? { pgid: cmd.pgid } : {}),
          ...(cmd.exitCode !== undefined ? { exitCode: cmd.exitCode } : {}),
          ...(cmd.signal !== undefined ? { signal: cmd.signal } : {}),
          ...(cmd.reason !== undefined ? { reason: cmd.reason } : {}),
          ...(cmd.error !== undefined ? { error: cmd.error } : {}),
          ...(cmd.startedAt !== undefined ? { startedAt: cmd.startedAt } : {}),
          ...(cmd.ports !== undefined ? { ports: cmd.ports } : {}),
          ...(cmd.logPath !== undefined ? { logPath: cmd.logPath } : {}),
          ...(cmd.procStart !== undefined ? { procStart: cmd.procStart } : {}),
        },
        // 同一「次运行」的状态变化用同一把键：重复 down 不会写出第二条 stopped；
        // 新的 up 带新的 startedAt，键自然不同（不会因为幂等把新事件吃掉）。
        `runtime:${cmd.card}:${cmd.to}:${cmd.startedAt ?? "-"}:${cmd.pid ?? "-"}`,
      );
      break;
    }
  }

  applyPending();

  // ------------------------------------------------------------ B' 段：命令自带的转换意图

  if (cmd.cmd === "cleanup" && cleanupKey) requestTransition(cmd.card, "done", cleanupKey);

  // ------------------------------------------------------------ C 段：自动节点

  for (let i = 0; i < events.length && i < MAX_DERIVED_EVENTS; i++) {
    const ev = events[i]!;
    const card = get(ev.cardId);
    if (!card) continue;
    for (const auto of flow.automations) {
      if (auto.on !== ev.type) continue;
      if (auto.when && !auto.when(card, ev.payload)) continue;
      for (const [index, action] of auto.do.entries()) {
        const current = get(ev.cardId);
        if (!current) break;
        const key = `${ev.dedupeKey}#a${index}`;
        if ("setState" in action) {
          if (current.state === action.setState) continue;
          const missing = missingRequirements(flow, current.state, action.setState, current);
          if (missing.length > 0) {
            const transition = `${current.state} -> ${action.setState}`;
            if (!blocked) {
              blocked = { transition, missing, describe: describeMissing(flow, missing) };
            }
            notes.push(
              `自动动作 ${auto.name} 未生效：${transition} 缺 ${missing.join(", ")}`,
            );
            continue;
          }
          emit(
            ev.cardId,
            "card.state.changed",
            { from: current.state, to: action.setState },
            `${key}:state`,
          );
          applyPending();
        } else if ("openGate" in action) {
          if (current.gates[action.openGate]) continue;
          const open = gateOpen(current, action.openGate);
          if (open) {
            notes.push(`自动动作 ${auto.name} 未生效：门禁 ${open} 还开着`);
            continue;
          }
          const spec = flow.gates.find((g) => g.id === action.openGate);
          emit(
            ev.cardId,
            "gate.requested",
            {
              gate: action.openGate,
              kind: spec?.kind ?? "confirm",
              title: spec?.title ?? action.openGate,
            },
            `${key}:gate`,
          );
          applyPending();
        } else {
          emit(ev.cardId, "card.comment.added", { body: action.comment }, `${key}:comment`);
          applyPending();
        }
      }
    }
  }

  const cards: Record<string, Card> = {};
  for (const [id, card] of local) cards[id] = card;

  return { events, cards, primaryCardId, ...(blocked ? { blocked } : {}), notes };
}
