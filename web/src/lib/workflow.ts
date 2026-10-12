/**
 * Workflow 视图的数据接入：`GET /api/workflow` → zod 校验 → 组件。
 *
 * 这份数据**完全由服务端的常量编译出来**（`src/flow/personal.ts` + `src/shared/stage.ts`），
 * 前端不写任何流程内容；这里只做两件事：
 *   1. 把响应解析成有类型的结构（外部数据一律先校验）；
 *   2. 算「每列现在有几张卡」（反向溯源：图上每列节点要标数字）。
 */
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { apiUrl, unreachableMessage } from "@/lib/api";
import { CARD_STATES, deriveStage, STAGE_FACT_LABELS, STAGES, type CardGitFacts, type Stage } from "@/lib/contract";
import type { FlowActor } from "@/lib/contract";
import type { CardView } from "@/lib/schema";

const actorSchema = z.enum(["human", "llm", "command"] satisfies [FlowActor, ...FlowActor[]]);
const cardStateSchema = z.enum(CARD_STATES);
const stageSchema = z.enum(STAGES);
const factSourceSchema = z.enum(
  Object.keys(STAGE_FACT_LABELS) as [keyof typeof STAGE_FACT_LABELS, ...(keyof typeof STAGE_FACT_LABELS)[]],
);

const stateNodeSchema = z.looseObject({
  id: cardStateSchema,
  label: z.string(),
  actor: actorSchema,
  incoming: z.array(z.string()),
  outgoing: z.array(z.string()),
});

const transitionSchema = z.looseObject({
  id: z.string(),
  from: cardStateSchema,
  to: cardStateSchema,
  actor: actorSchema,
  requires: z.array(z.looseObject({ id: z.string(), describe: z.string() })),
  gates: z.array(z.looseObject({ id: z.string(), title: z.string(), kind: z.string(), actor: actorSchema })),
  automations: z.array(z.looseObject({ name: z.string(), on: z.string(), actor: actorSchema })),
});

const automationSchema = z.looseObject({
  name: z.string(),
  on: z.string(),
  actor: actorSchema,
  setsState: z.array(cardStateSchema),
  opensGates: z.array(z.string()),
  whenStates: z.array(cardStateSchema),
});

const evidenceSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("event"), name: z.string() }),
  z.looseObject({ kind: z.literal("field"), path: z.string() }),
  z.looseObject({ kind: z.literal("gate"), id: z.string() }),
]);

const actionSchema = z.looseObject({
  order: z.number(),
  id: z.string(),
  title: z.string(),
  actor: actorSchema,
  actorWhy: z.string(),
  needs: z.array(z.looseObject({ id: z.string(), title: z.string(), order: z.number() })),
  needsStates: z.array(cardStateSchema),
  output: z.string(),
  evidence: z.array(evidenceSchema),
  toState: cardStateSchema.nullable(),
  toStage: stageSchema.nullable(),
  command: z.string().nullable(),
});

const gateSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  actor: actorSchema,
  on: z.string(),
  from: cardStateSchema,
  to: cardStateSchema,
  report: z.array(z.string()),
});

/** 看板一列的节点（溯源用：判据 / 等谁动手 / 哪几类事实 / 读到哪些状态）。 */
export const stageNodeSchema = z.looseObject({
  id: stageSchema,
  label: z.string(),
  emptyHint: z.string(),
  when: z.string(),
  actor: actorSchema,
  facts: z.array(factSourceSchema),
  states: z.array(cardStateSchema),
  priority: z.number(),
  actions: z.array(z.looseObject({ id: z.string(), title: z.string(), actor: actorSchema, order: z.number() })),
});

export const workflowSchema = z.looseObject({
  flow: z.looseObject({
    name: z.string(),
    states: z.array(stateNodeSchema),
    transitions: z.array(transitionSchema),
    automations: z.array(automationSchema),
    gates: z.array(gateSchema),
    entranceFreeStates: z.array(cardStateSchema),
    actions: z.array(actionSchema),
  }),
  stages: z.array(stageNodeSchema),
});

export type WorkflowStateNode = z.infer<typeof stateNodeSchema>;
export type WorkflowTransition = z.infer<typeof transitionSchema>;
export type WorkflowAutomation = z.infer<typeof automationSchema>;
export type WorkflowGate = z.infer<typeof gateSchema>;
export type WorkflowEvidence = z.infer<typeof evidenceSchema>;
export type WorkflowActionNode = z.infer<typeof actionSchema>;
export type WorkflowStageNode = z.infer<typeof stageNodeSchema>;
export type Workflow = z.infer<typeof workflowSchema>;

export type WorkflowResult = { ok: true; data: Workflow } | { ok: false; message: string };

async function requestWorkflow(signal?: AbortSignal): Promise<WorkflowResult> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/api/workflow"), { signal, headers: { accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, message: unreachableMessage(error) };
  }
  const raw: unknown = await res.json().catch(() => null);
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: res.ok
        ? `GET /api/workflow 的响应不符合契约：${parsed.error.issues[0]?.message ?? "解析失败"}`
        : `GET /api/workflow 失败（HTTP ${res.status}）`,
    };
  }
  return { ok: true, data: parsed.data };
}

export type WorkflowData = {
  workflow: Workflow | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
};

/** 流程视图的数据源：进视图拉一次（常量不变，没必要跟 SSE 一起重拉；刷新按钮可手动重拉）。 */
export function useWorkflow(enabled: boolean): WorkflowData {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await requestWorkflow();
    if (result.ok) {
      setWorkflow(result.data);
      setError(null);
    } else {
      setError(result.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled || workflow !== null) return;
    void refresh();
  }, [enabled, workflow, refresh]);

  return { workflow, error, loading, refresh };
}

/**
 * 每列现在有几张卡（反向溯源：图上每个列节点要能报数，点一下就回看板那一列）。
 * 分列口径与看板 `Board.tsx` 一致：以服务端给的 `stage` 为准，老服务端没给就地按同一套判据派生。
 */
export function countByStage(cards: CardView[]): Record<Stage, number> {
  const counts = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<Stage, number>;
  for (const card of cards) {
    const git: CardGitFacts | undefined = card.git;
    const stage = card.stage ?? deriveStage(card, git ? { git } : null);
    counts[stage] += 1;
  }
  return counts;
}
