/**
 * **流程视图（Workflow tab）的唯一数据源**：把两处常量编译成一份**纯数据**，给
 * `GET /api/workflow` 与前端 Workflow 视图渲染。
 *
 *   1. `src/flow/personal.ts` —— 流程主体：状态（`states`/`stateActors`）、
 *      转换（`requires` + `transitionActors`）、门禁（`gates`）、自动节点（`automations`）；
 *   2. `src/shared/stage.ts` —— 看板的 9 列：`STAGES` / `STAGE_LABELS` / `STAGE_EMPTY_HINTS`
 *      / `STAGE_RULES`（每条判据的人话 `when`、等谁动手 `actor`、看哪几类事实 `facts`）。
 *
 * 规矩：**前端一个字都不许手写**（判据、状态名、列名、actor 全从这里来）。
 * 改流程/改列只改上面那两处，这个文件与前端自动跟上；对不上的地方由 `test/workflow.test.ts` 钉住。
 */
import { personalFlow } from "../flow/personal.ts";
import type { Evidence, FlowActor, Transition } from "./flow.ts";
import {
  STAGE_EMPTY_HINTS,
  STAGE_FACT_LABELS,
  STAGE_LABELS,
  STAGE_RULES,
  type Stage,
  type StageFactSource,
} from "./stage.ts";
import { CARD_STATES, STATE_LABELS, type Card, type CardState, type EventType } from "./types.ts";

/** 事实来源的中文名（前端与文档共用同一份常量）。 */
export { STAGE_FACT_LABELS } from "./stage.ts";

/** 图上的一个状态节点。 */
export type WorkflowStateNode = {
  id: CardState;
  label: string;
  /** 停在这个状态时**在等谁动手**。 */
  actor: FlowActor;
  /** 声明式转换里指向它的边（= 转换 id）。 */
  incoming: string[];
  /** 声明式转换里从它出去的边（= 转换 id）。 */
  outgoing: string[];
};

/** 一条带硬前置的转换（`requires` 的键）。 */
export type WorkflowTransition = {
  /** `"ready -> working"`。 */
  id: string;
  from: CardState;
  to: CardState;
  /** 这一步归谁推（`transitionActors`）。 */
  actor: FlowActor;
  /** 硬前置（需求 id + 人话说明），缺一项就拦住。 */
  requires: { id: string; describe: string }[];
  /** 把关的门禁（`gate.on` 与这条转换同名）。 */
  gates: { id: string; title: string; kind: string; actor: FlowActor }[];
  /** 会把卡片推进到 `to` 的自动节点（事件驱动，缺前置只记一笔 note 不报错）。 */
  automations: { name: string; on: EventType; actor: FlowActor }[];
};

export type WorkflowAutomation = {
  name: string;
  on: EventType;
  actor: FlowActor;
  /** 它的动作：推进到哪些状态 / 打开哪些门禁（`do` 里的原样展开）。 */
  setsState: CardState[];
  opensGates: string[];
  /**
   * 探测出的触发状态：把 `when` 在 7 个状态上各试一次（`when` 是纯函数，只看状态这一层）。
   * `when` 缺省 = 无条件（任何状态都可能触发）。
   */
  whenStates: CardState[];
};

export type WorkflowGate = {
  id: string;
  title: string;
  kind: string;
  actor: FlowActor;
  /** 它把关的转换（`"review -> merged"`）。 */
  on: string;
  from: CardState;
  to: CardState;
  report: string[];
};

/**
 * **动作节点**（细粒度层）：`order` = 执行顺序（= 常量数组里的顺序，`defineFlow` 保证前置永远在它前面）。
 * 每个节点自带「前置 / 产出 / 证据来源 / 推进到哪个状态或列」，`command` 是它在 CLI 里敲的那条命令。
 */
export type WorkflowActionNode = {
  order: number;
  id: string;
  title: string;
  actor: FlowActor;
  /** 为什么是这个人（拍板 or 只是落库的机械动作）。 */
  actorWhy: string;
  /** 前置动作（带中文名与序号，前端不用自己查表）。 */
  needs: { id: string; title: string; order: number }[];
  needsStates: CardState[];
  output: string;
  /** 证据来源：事件 / 卡片字段 / 门禁。 */
  evidence: Evidence[];
  toState: CardState | null;
  toStage: Stage | null;
  /** 在 CLI 里敲什么（`command` 节点必有；没有对应命令的就是 `null`）。 */
  command: string | null;
};

/** 看板的一列 —— 每列的**溯源**：判据、等谁动手、看哪几类事实、直接读哪些卡片状态。 */
export type WorkflowStageNode = {
  id: Stage;
  label: string;
  emptyHint: string;
  /** 人话判据（`STAGE_RULES[].when`）。 */
  when: string;
  actor: FlowActor;
  /** 事实来源（卡片事实 / PR・CI / git 实况 / 会话）。 */
  facts: StageFactSource[];
  /** 判据里直接比对的卡片状态（空 = 不看状态，纯靠引用/实况推出）。 */
  states: CardState[];
  /** 在判据表里的名次（1 = 最优先命中）。 */
  priority: number;
  /** 这一步之后会落进这一列的动作节点（**每列至少一个**，由 `test/workflow.test.ts` 钉住）。 */
  actions: { id: string; title: string; actor: FlowActor; order: number }[];
};

export type WorkflowPayload = {
  flow: {
    name: string;
    states: WorkflowStateNode[];
    transitions: WorkflowTransition[];
    automations: WorkflowAutomation[];
    gates: WorkflowGate[];
    /** 声明式转换之外的入口也要能解释：哪些状态没有进入边。 */
    entranceFreeStates: CardState[];
    /** 动作节点（按执行顺序）。 */
    actions: WorkflowActionNode[];
  };
  stages: WorkflowStageNode[];
};

/** 视图里会打出的一个 actor 标签（`human` / `llm` 文字）。 */
export type WorkflowActorSlot = {
  kind: "state" | "transition" | "automation" | "gate" | "action" | "stage";
  id: string;
  actor: FlowActor;
};

const TRANSITION_SEP = " -> ";

/** `when` 是纯函数：拿一个只有 `state` 的假卡片探测它在哪些状态上成立（只用于展示）。 */
function probeWhenStates(when: ((card: Card, payload: Record<string, unknown>) => boolean) | undefined): CardState[] {
  if (!when) return [...CARD_STATES];
  return CARD_STATES.filter((state) => {
    try {
      return when({ state } as Card, {});
    } catch {
      return false;
    }
  });
}

/**
 * 从常量生成流程视图数据。**纯函数**：没有 IO、没有时间、没有随机；
 * 同一份常量永远得到同一份输出（测试可以直接断言集合相等）。
 */
export function buildWorkflow(): WorkflowPayload {
  const flow = personalFlow;

  const requiresEntries = Object.entries(flow.requires) as [Transition, string[]][];
  const transitionIds = requiresEntries.map(([key]) => key);

  const transitions: WorkflowTransition[] = requiresEntries.map(([key, reqIds]) => {
    const [from, to] = key.split(TRANSITION_SEP) as [CardState, CardState];
    return {
      id: key,
      from,
      to,
      actor: flow.transitionActors[key] ?? "llm",
      requires: reqIds.map((id) => ({
        id,
        describe: flow.requirements.find((req) => req.id === id)?.describe ?? `未定义的必要条件 ${id}`,
      })),
      gates: flow.gates
        .filter((gate) => gate.on[0] === from && gate.on[1] === to)
        .map((gate) => ({ id: gate.id, title: gate.title, kind: gate.kind, actor: gate.actor })),
      automations: flow.automations
        .filter((auto) => auto.do.some((action) => "setState" in action && action.setState === to))
        .map((auto) => ({ name: auto.name, on: auto.on, actor: auto.actor })),
    };
  });

  const states: WorkflowStateNode[] = flow.states.map((id) => ({
    id,
    label: STATE_LABELS[id],
    actor: flow.stateActors[id] ?? "llm",
    incoming: transitionIds.filter((key) => key.endsWith(`${TRANSITION_SEP}${id}`)),
    outgoing: transitionIds.filter((key) => key.startsWith(`${id}${TRANSITION_SEP}`)),
  }));

  const automations: WorkflowAutomation[] = flow.automations.map((auto) => ({
    name: auto.name,
    on: auto.on,
    actor: auto.actor,
    setsState: auto.do.flatMap((action) => ("setState" in action ? [action.setState] : [])),
    opensGates: auto.do.flatMap((action) => ("openGate" in action ? [action.openGate] : [])),
    whenStates: probeWhenStates(auto.when),
  }));

  const gates: WorkflowGate[] = flow.gates.map((gate) => ({
    id: gate.id,
    title: gate.title,
    kind: gate.kind,
    actor: gate.actor,
    on: `${gate.on[0]}${TRANSITION_SEP}${gate.on[1]}`,
    from: gate.on[0],
    to: gate.on[1],
    report: gate.report ?? [],
  }));

  const actions: WorkflowActionNode[] = flow.actions.map((action, index) => ({
    order: index + 1,
    id: action.id,
    title: action.title,
    actor: action.actor,
    actorWhy: action.actorWhy,
    // 前置只可能写在前面（defineFlow 已校验），所以顺序表里一定查得到
    needs: action.needsActions.map((id) => ({
      id,
      title: flow.actions.find((candidate) => candidate.id === id)?.title ?? id,
      order: flow.actions.findIndex((candidate) => candidate.id === id) + 1,
    })),
    needsStates: [...action.needsStates],
    output: action.output,
    evidence: [...action.evidence],
    toState: action.toState,
    toStage: action.toStage,
    command: action.command,
  }));

  const stages: WorkflowStageNode[] = STAGE_RULES.map((rule, index) => ({
    id: rule.stage,
    label: STAGE_LABELS[rule.stage],
    emptyHint: STAGE_EMPTY_HINTS[rule.stage],
    when: rule.when,
    actor: rule.actor,
    facts: [...rule.facts],
    states: [...rule.states],
    priority: index + 1,
    actions: actions
      .filter((action) => action.toStage === rule.stage)
      .map((action) => ({ id: action.id, title: action.title, actor: action.actor, order: action.order })),
  }));

  return {
    flow: {
      name: flow.name,
      states,
      transitions,
      automations,
      gates,
      entranceFreeStates: states.filter((state) => state.incoming.length === 0).map((state) => state.id),
      actions,
    },
    stages,
  };
}

/**
 * 视图里会出现的**全部** actor 标签（每个状态 / 转换 / 自动节点 / 门禁 / 列各一条）。
 * 组件按同样的集合渲染标签，`test/workflow.test.ts` 用它钉住「一个都没漏标」。
 */
export function workflowActorSlots(payload: WorkflowPayload): WorkflowActorSlot[] {
  return [
    ...payload.flow.states.map((s) => ({ kind: "state" as const, id: s.id, actor: s.actor })),
    ...payload.flow.transitions.map((t) => ({ kind: "transition" as const, id: t.id, actor: t.actor })),
    ...payload.flow.automations.map((a) => ({ kind: "automation" as const, id: a.name, actor: a.actor })),
    ...payload.flow.gates.map((g) => ({ kind: "gate" as const, id: g.id, actor: g.actor })),
    ...payload.flow.actions.map((a) => ({ kind: "action" as const, id: a.id, actor: a.actor })),
    ...payload.stages.map((s) => ({ kind: "stage" as const, id: s.id, actor: s.actor })),
  ];
}
