/**
 * 投影：把 append-only 的事件流折成卡片现状。纯函数、不碰 IO。
 * rebuild 就是「从零 reduce 一遍全部事件」，所以投影必须与事件语义严格一致。
 */
import type {
  Actor,
  Card,
  CardState,
  Comment,
  Event,
  IssueRef,
  PrRef,
  Session,
  WorktreeRef,
} from "../shared/types.ts";

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
    issue: null,
    pr: null,
    worktree: null,
    session: null,
    gates: {},
    pushes: [],
    comments: [],
    spawned: [],
    createdAt: at,
    updatedAt: at,
  };
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

    case "push.recorded":
      next.pushes = [...card.pushes, { sha: String(p.sha ?? ""), at, actor: event.actor }];
      break;

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
  }

  return next;
}
