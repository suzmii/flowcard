/**
 * 引擎：`命令 -> 事件[]`。纯函数，不碰 IO、不碰时钟（时间由调用方传入）。
 *
 * 三段式：
 *   A 命令事实（claim/bind/push/comment…）→ 事件
 *   B 显式转换请求（如 unblock/cleanup）→ 过 requires 才放行
 *   C 自动节点：对每个事实事件跑 flow.automations，动作同样过 requires
 * requires 不满足时**不是报错**，而是把缺项回报给调用方（写事件已经落库，状态不动）。
 */
import { describeMissing, missingRequirements, type Flow } from "../shared/flow.ts";
import { shortHash } from "../shared/hash.ts";
import { LOCAL_PROJECT_ID, type Card, type Command, type CwdClaimResolution, type EventType, type Project, type Rejection } from "../shared/types.ts";
import { applyEvent, emptyCard, type NewEvent } from "./project.ts";
import { reviewAnchor } from "./review.ts";

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

  const get = (id: string): Card | undefined => local.get(id) ?? input.getCard(id);

  const applyPending = (): void => {
    for (; applied < events.length; applied++) {
      const ev = events[applied]!;
      const base = get(ev.cardId) ?? emptyCard(ev.cardId, now);
      local.set(ev.cardId, applyEvent(base, ev));
    }
  };

  const emit = (cardId: string, type: EventType, payload: Record<string, unknown>, key: string): void => {
    events.push({
      at: now,
      actor: cmd.actor,
      cardId,
      type,
      payload,
      dedupeKey: cmd.dedupeKey ? `${cmd.dedupeKey}#${key}` : key,
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
      // 幂等键不掺 id（id 每次分配都会变），否则重试会写出一张重复卡片；
      // 内容相同的 open 视为同一次请求，要开两张一样的卡请显式给 --dedupe-key。
      const fingerprint = shortHash(`${title}\n${cmd.body}\n${projectId}`);
      emit(
        id,
        "card.opened",
        {
          title,
          body: cmd.body,
          projectId,
          ...(repoPath ? { repoPath } : {}),
          ...(cmd.partOf ? { partOf: cmd.partOf } : {}),
          ...(cmd.issue ? { issue: cmd.issue } : {}),
        },
        `open:${fingerprint}`,
      );
      if (cmd.issue) {
        emit(
          id,
          "issue.bound",
          { issue: cmd.issue },
          `issue:${cmd.issue.repo}#${cmd.issue.number}:${fingerprint}`,
        );
      }
      break;
    }

    case "bindIssue": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const sameIssue =
        card.issue?.repo === cmd.issue.repo && card.issue?.number === cmd.issue.number;
      if (sameIssue) {
        notes.push("Issue 已经是该值，跳过");
        break;
      }
      emit(
        cmd.card,
        "issue.bound",
        { issue: cmd.issue },
        `issue:${cmd.card}:${cmd.issue.repo}#${cmd.issue.number}:from:${card.issue ? `${card.issue.repo}#${card.issue.number}` : "-"}`,
      );
      break;
    }

    case "plan": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.state === "inbox") {
        emit(cmd.card, "card.state.changed", { from: "inbox", to: "issue" }, `plan:${cmd.card}#state`);
        applyPending();
      }
      const after = get(cmd.card)!;
      const open = gateOpen(after, "G1");
      if (open) {
        return fail({
          code: "GATE_PENDING",
          message: `门禁 ${open} 还没决策，不能重复申请 G1`,
          hint: `先 flowcard gate ${cmd.card} --gate ${open} --approve|--reject`,
        });
      }
      emit(
        cmd.card,
        "card.comment.added",
        { body: cmd.body, commentId: `plan-${cmd.card}` },
        `plan-comment:${cmd.card}`,
      );
      emit(cmd.card, "gate.requested", { gate: "G1", kind: "approve", title: "批准方案" }, `gate:${cmd.card}:G1`);
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
      const spec = flow.gates.find((g) => g.id === cmd.gate);
      if (gate.kind === "approve" && cmd.decision === "approved" && spec) {
        // 按"这一票已投"的口径校验：否则 planApproved 自身永远算缺项，永远批不了。
        const projected = applyEvent(card, {
          at: now,
          actor: cmd.actor,
          cardId: cmd.card,
          type: "gate.decided",
          payload: { gate: cmd.gate, decision: "approved" },
          dedupeKey: "guard",
        });
        const missing = missingRequirements(flow, spec.on[0], spec.on[1], projected);
        if (missing.length > 0) {
          return fail({
            code: "MISSING_REQUIREMENT",
            message: `还缺必要条件，不能批准（${spec.on[0]} -> ${spec.on[1]}）`,
            missing,
            hint: describeMissing(flow, missing).join("；"),
          });
        }
      }
      emit(
        cmd.card,
        "gate.decided",
        { gate: cmd.gate, decision: cmd.decision, ...(cmd.reason ? { reason: cmd.reason } : {}) },
        `gate:${cmd.card}:${cmd.gate}:${cmd.decision}`,
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
      const same =
        card.worktree?.path === cmd.worktree.path && card.worktree?.branch === cmd.worktree.branch;
      if (same) {
        // 声明式 setter：值没变就是 no-op（重试天然幂等）
        notes.push("worktree 已经是该值，跳过");
        break;
      }
      // 幂等键带上"前值"：否则把 A→B 之后再改回 A 时，会被历史上那条 A 的键吞掉
      emit(
        cmd.card,
        "worktree.bound",
        { worktree: cmd.worktree },
        `worktree:${cmd.card}:${shortHash(cmd.worktree.path)}:${cmd.worktree.branch}:from:${card.worktree?.branch ?? "-"}`,
      );
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
      // 幂等键带上 cwd：同一会话从新目录再 claim（omp 的 /wt、/move 之后）要能刷新记录
      emit(
        cardId,
        "session.started",
        { session: cmd.session },
        `claim:${cardId}:${cmd.session.id}:${shortHash(cmd.session.cwd)}`,
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
      const bucket = Math.floor(Date.parse(now) / 30_000);
      emit(
        cmd.card,
        "session.heartbeat",
        { cwd: cmd.session.cwd },
        `beat:${cmd.card}:${cmd.session.id}:${bucket}`,
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
            `mismatch:${cmd.card}:${cmd.session.id}:${bucket}`,
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
      emit(
        cmd.card,
        "pr.bound",
        { pr: cmd.pr },
        `pr:${cmd.card}:${cmd.pr.number}:${cmd.pr.state}:from:${card.pr ? `${card.pr.number}:${card.pr.state}` : "-"}`,
      );
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
      emit(
        cmd.card,
        "session.ended",
        { ...(cmd.summary ? { summary: cmd.summary } : {}) },
        `end:${cmd.card}:${card.session?.id ?? "-"}`,
      );
      break;
    }

    case "accept": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      emit(cmd.card, "gate.requested", { gate: "G3", kind: "review", title: "验收" }, `gate:${cmd.card}:G3`);
      emit(
        cmd.card,
        "gate.decided",
        { gate: "G3", decision: "approved", ...(cmd.reason ? { reason: cmd.reason } : {}) },
        `gate:${cmd.card}:G3:approved`,
      );
      emit(cmd.card, "card.accepted", {}, `accept:${cmd.card}`);
      break;
    }

    case "triage": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.state === "issue") {
        notes.push("卡片已经是「立 Issue」状态，跳过");
        break;
      }
      if (card.state !== "inbox") {
        return fail({
          code: "STATE_NOT_ALLOWED",
          message: `卡片当前是 ${card.state}，只有收件箱里的卡需要"确认要做"`,
          hint: "已经开工的卡请用门禁/会话推进；要放弃用 flowcard drop",
        });
      }
      if (cmd.note) {
        emit(
          cmd.card,
          "card.comment.added",
          { body: cmd.note },
          `triage:${cmd.card}:${shortHash(cmd.note)}`,
        );
        applyPending();
      }
      requestTransition(cmd.card, "issue", `triage:${cmd.card}`);
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
      // 放弃是决定，得留痕：理由进评论，状态另记
      emit(cmd.card, "card.comment.added", { body: `放弃：${cmd.reason}` }, `drop:${cmd.card}:${shortHash(cmd.reason)}`);
      applyPending();
      const now2 = get(cmd.card)!;
      emit(
        cmd.card,
        "card.state.changed",
        { from: now2.state, to: "dropped" },
        `drop:${cmd.card}:${now2.state}:state`,
      );
      break;
    }

    case "block": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      emit(cmd.card, "card.blocked", { reason: cmd.reason }, `block:${cmd.card}:${shortHash(cmd.reason)}`);
      break;
    }

    case "unblock": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      if (card.state !== "blocked") {
        return fail({ code: "STATE_NOT_ALLOWED", message: `卡片当前是 ${card.state}，不是 blocked` });
      }
      requestTransition(cmd.card, "working", `unblock:${cmd.card}`);
      break;
    }

    case "probePr": {
      const card = get(cmd.card);
      if (!card) return fail({ code: "NOT_FOUND", message: `卡片 ${cmd.card} 不存在` });
      const merged = cmd.pr.state === "merged";
      const type: EventType = merged && card.pr?.state !== "merged" ? "pr.merged" : "pr.updated";
      emit(cmd.card, type, { pr: cmd.pr }, `probe:${cmd.card}:${cmd.pr.number}:${cmd.pr.state}`);
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
      emit(cmd.card, "cleanup.proposed", { items: cmd.items }, `cleanup-plan:${cmd.card}`);
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
      emit(cmd.card, "cleanup.completed", {}, `cleanup:${cmd.card}`);
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
       * 幂等键：同一条判定（同 verdict + 同正文）重发不产生第二条；
       * 但**改主意再改回来要能记上** —— 所以键里只在"前一次判定与这次不同"时带上前值。
       */
      const previous = card.review.verdict?.decision;
      const from = previous === undefined || previous === cmd.verdict ? "-" : previous;
      emit(
        cmd.card,
        "review.verdict.recorded",
        { verdict: cmd.verdict, ...(cmd.body ? { body: cmd.body } : {}) },
        `review-verdict:${cmd.card}:${cmd.verdict}:${shortHash(cmd.body ?? "")}:from:${from}`,
      );
      notes.push(`评审判定已记录：${cmd.verdict}（不改流程状态：验收仍由人在看板上点 G3）`);
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
      if (parent.issue) {
        emit(
          id,
          "issue.bound",
          { issue: parent.issue },
          `spawn-issue:${cmd.card}:${shortHash(cmd.title)}`,
        );
        emit(
          id,
          "card.state.changed",
          { from: "inbox", to: "issue" },
          `spawn-state:${cmd.card}:${shortHash(cmd.title)}`,
        );
      }
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

  if (cmd.cmd === "cleanup") requestTransition(cmd.card, "done", `cleanup:${cmd.card}`);

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
