/**
 * 投影：把 append-only 的事件流折成卡片现状。纯函数、不碰 IO。
 * rebuild 就是「从零 reduce 一遍全部事件」，所以投影必须与事件语义严格一致。
 */
import {
  LOCAL_PROJECT_ID,
  type Actor,
  type Card,
  type CardState,
  type Comment,
  type ConfirmAction,
  type ConfirmStatus,
  type Confirmation,
  type Event,
  type IssueRef,
  type PrRef,
  type ReviewComment,
  type ReviewSide,
  type ReviewVerdictKind,
  type Runtime,
  type Session,
  type WorktreeRef,
} from "../shared/types.ts";
import { compareReviewComments, headShaOf, isOutdated, markOutdated, nextReviewCommentId } from "./review.ts";

/** 引擎产生的新事件（缺 seq/id，由存储层补）。 */
export type NewEvent = {
  at: string;
  actor: Actor;
  cardId: string;
  type: Event["type"];
  payload: Record<string, unknown>;
  dedupeKey: string;
};

/** 只按 id 建空壳；真正的字段都由 card.opened 事件填。 */
export function emptyCard(id: string, at: string): Card {
  return {
    id,
    title: "",
    body: "",
    state: "inbox",
    projectId: LOCAL_PROJECT_ID,
    issue: null,
    pr: null,
    worktree: null,
    session: null,
    runtime: null,
    gates: {},
    confirmations: [],
    pushes: [],
    comments: [],
    review: { comments: [] },
    spawned: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** 卡片内确认 id 自增（"cf1"…）：按已有确认的最大编号推导，不额外维护计数器表。 */
export function nextConfirmationId(confirmations: Confirmation[]): string {
  let max = 0;
  for (const confirmation of confirmations) {
    const matched = /^cf(\d+)$/.exec(confirmation.id);
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `cf${max + 1}`;
}

export function applyEvent(card: Card, event: NewEvent | Event): Card {
  const at = event.at;
  const next: Card = { ...card, updatedAt: at };
  const p = event.payload;

  switch (event.type) {
    case "card.opened":
      next.title = String(p.title ?? "");
      next.body = String(p.body ?? "");
      next.state = "inbox";
      // 老事件的 payload 里没有 projectId（升级前开的卡）→ 一律落到合成项目「未归属」。
      next.projectId = typeof p.projectId === "string" && p.projectId !== "" ? p.projectId : LOCAL_PROJECT_ID;
      if (typeof p.repoPath === "string") next.repoPath = p.repoPath;
      if (typeof p.partOf === "string") next.partOf = p.partOf;
      if (p.issue) next.issue = p.issue as IssueRef;
      break;

    case "card.state.changed":
      next.state = p.to as CardState;
      if (next.state !== "blocked") delete next.blockedReason;
      break;

    case "card.blocked":
      next.state = "blocked";
      next.blockedReason = String(p.reason ?? "");
      break;

    case "card.accepted":
      next.acceptedAt = at;
      break;

    case "card.comment.added": {
      const comment: Comment = {
        id: String(p.commentId ?? `${event.cardId}-${card.comments.length + 1}`),
        at,
        actor: event.actor,
        body: String(p.body ?? ""),
      };
      next.comments = [...card.comments, comment];
      break;
    }

    /**
     * 行级评审注释：**outdated 是投影时算的**，不是事件里的字段 ——
     * 所以 `push.recorded` 时要把已有注释整体重算一遍（见下面 pushes 的分支）。
     */
    case "review.comment.added": {
      const comment: ReviewComment = {
        id: nextReviewCommentId(card.review.comments),
        sha: String(p.sha ?? ""),
        path: String(p.path ?? ""),
        line: Number(p.line ?? 0),
        side: (p.side === "old" ? "old" : "new") as ReviewSide,
        body: String(p.body ?? ""),
        at,
        actor: event.actor,
        outdated: false,
      };
      next.review = {
        ...card.review,
        comments: [...card.review.comments, comment]
          .map((c) => ({ ...c, outdated: isOutdated(c.sha, headShaOf(card)) }))
          .sort(compareReviewComments),
      };
      break;
    }

    case "review.verdict.recorded": {
      next.review = {
        ...card.review,
        verdict: {
          decision: p.verdict as ReviewVerdictKind,
          at,
          by: event.actor.name ?? event.actor.harness ?? event.actor.kind,
          ...(p.body ? { body: String(p.body) } : {}),
        },
      };
      break;
    }

    case "card.spawned": {
      const childId = String(p.childId ?? "");
      if (childId) next.spawned = [...card.spawned, childId];
      break;
    }

    case "issue.bound":
      next.issue = p.issue as IssueRef;
      break;

    case "worktree.bound":
      next.worktree = p.worktree as WorktreeRef;
      break;

    case "pr.bound":
    case "pr.updated":
    case "pr.merged":
      next.pr = p.pr as PrRef;
      break;

    case "push.recorded": {
      next.pushes = [...card.pushes, { sha: String(p.sha ?? ""), at, actor: event.actor }];
      // 推送 = HEAD 往前走了 → 所有锚在旧 head 上的评审注释变成"已过期"。
      if (next.review.comments.length > 0) {
        next.review = { ...next.review, comments: markOutdated(next.review.comments, headShaOf(next)) };
      }
      break;
    }

    case "gate.requested":
      next.gates = {
        ...card.gates,
        [String(p.gate)]: {
          id: String(p.gate),
          kind: p.kind as "approve" | "confirm" | "review" | "cleanup",
          title: String(p.title ?? ""),
          status: "open",
          requestedAt: at,
          ...(p.payload ? { payload: p.payload as Record<string, unknown> } : {}),
        },
      };
      break;

    case "gate.decided": {
      const id = String(p.gate);
      const existing = card.gates[id];
      if (!existing) break;
      next.gates = {
        ...card.gates,
        [id]: {
          ...existing,
          status: p.decision as "approved" | "rejected",
          decidedAt: at,
          decidedBy: event.actor.name ?? event.actor.kind,
          ...(p.reason ? { reason: String(p.reason) } : {}),
        },
      };
      break;
    }

    case "confirm.requested": {
      const confirmation: Confirmation = {
        id: nextConfirmationId(card.confirmations),
        action: p.action as ConfirmAction,
        detail: String(p.detail ?? ""),
        status: "pending",
        requestedAt: at,
        requestedBy: event.actor,
      };
      next.confirmations = [...card.confirmations, confirmation];
      break;
    }

    case "confirm.decided": {
      const id = String(p.id);
      if (!card.confirmations.some((c) => c.id === id)) break;
      next.confirmations = card.confirmations.map((c) =>
        c.id === id
          ? {
              ...c,
              status: p.decision as ConfirmStatus,
              decidedAt: at,
              decidedBy: event.actor.name ?? event.actor.kind,
              ...(p.reason ? { reason: String(p.reason) } : {}),
            }
          : c,
      );
      break;
    }

    case "confirm.consumed": {
      const id = String(p.id);
      if (!card.confirmations.some((c) => c.id === id)) break;
      next.confirmations = card.confirmations.map((c) =>
        c.id === id ? { ...c, consumedAt: at } : c,
      );
      break;
    }

    case "cleanup.proposed":
      next.gates = {
        ...card.gates,
        G4: {
          id: "G4",
          kind: "cleanup",
          title: "清理确认",
          status: "open",
          requestedAt: at,
          payload: { items: p.items ?? [] },
        },
      };
      break;

    case "cleanup.completed":
      next.cleanedAt = at;
      break;

    case "session.started":
      next.session = {
        harness: String((p.session as Session)?.harness ?? ""),
        id: String((p.session as Session)?.id ?? ""),
        agentKind: ((p.session as Session)?.agentKind ?? "main") as "main" | "sub",
        cwd: String((p.session as Session)?.cwd ?? ""),
        state: "running",
        startedAt: at,
        lastSeenAt: at,
        ...((p.session as Session)?.file ? { file: (p.session as Session).file } : {}),
        ...((p.session as Session)?.resumeHint ? { resumeHint: (p.session as Session).resumeHint } : {}),
      };
      break;

    case "session.heartbeat": {
      if (!card.session) break;
      next.session = {
        ...card.session,
        state: card.session.state === "ended" ? "ended" : "running",
        lastSeenAt: at,
        ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
      };
      break;
    }

    case "session.ended":
      if (card.session) next.session = { ...card.session, state: "ended", lastSeenAt: at };
      break;

    case "session.cwd.mismatch":
    case "git.probed":
      break;

    case "runtime.starting": {
      const runtime: Runtime = { status: "starting", startedAt: at };
      if (typeof p.pid === "number") runtime.pid = p.pid;
      if (Array.isArray(p.ports)) runtime.ports = p.ports as number[];
      if (typeof p.logPath === "string") runtime.logPath = p.logPath;
      next.runtime = runtime;
      break;
    }

    case "runtime.started": {
      const runtime: Runtime = {
        status: "running",
        startedAt: typeof p.startedAt === "string" ? p.startedAt : at,
      };
      if (typeof p.pid === "number") runtime.pid = p.pid;
      if (Array.isArray(p.ports)) runtime.ports = p.ports as number[];
      if (typeof p.logPath === "string") runtime.logPath = p.logPath;
      next.runtime = runtime;
      break;
    }

    case "runtime.failed": {
      const runtime: Runtime = {
        status: "failed",
        startedAt: typeof p.startedAt === "string" ? p.startedAt : at,
      };
      if (typeof p.pid === "number") runtime.pid = p.pid;
      if (Array.isArray(p.ports)) runtime.ports = p.ports as number[];
      if (typeof p.logPath === "string") runtime.logPath = p.logPath;
      next.runtime = runtime;
      break;
    }

    case "runtime.stopped": {
      const runtime: Runtime = {
        status: "stopped",
        startedAt: typeof p.startedAt === "string" ? p.startedAt : at,
      };
      if (Array.isArray(p.ports)) runtime.ports = p.ports as number[];
      if (typeof p.logPath === "string") runtime.logPath = p.logPath;
      next.runtime = runtime;
      break;
    }
  }

  return next;
}
