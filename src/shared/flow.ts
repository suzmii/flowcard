/**
 * 流程 = 有类型的代码：状态、门禁、硬前置（requires）、自动动作。
 * 引擎只认这里的声明，一切"缺项拦截"都由 requires 表达。
 */
import type { Card, CardState, EventType, Gate } from "./types.ts";
import { isInside } from "./paths.ts";

// ---------------------------------------------------------------- 谁动手（human / llm）

/**
 * 流程里每一步**归谁**：`human` = 要人拍板/动手，`llm` = 要 agent 干活。
 *
 * **只有这两个取值**（别加第三种：机器事实、系统、轮询都不算第三方 —— 见下面的口径）。
 *
 * ## 判定口径（读标注前先读这段，别猜）
 *
 * 1. **看这一步最终由谁拍板，而不是看事实是谁送来的。**
 *    机器事实（CI 结果、`git status` 脏文件数、PR 状态轮询、文件监听）**不单独成一类**：
 *    它只提供条件，归到「该步最终拍板的那一方」。
 *    - 例子：`prReview`（PR 待审）的 CI 已经绿了，但还是要**人等审/等合** → 这一列标 `human`，
 *      CI 只是条件，不是「谁在等」。
 * 2. `human` = 必须由人做决定或动手才能往下走：
 *    验收（G3）、清理确认（G4）、远程写授权（G2 的 approve / consume）、
 *    「PR 待审 / 等 CI」那一列（等人看、等人合）、「待你验收」那一列、解除阻塞（显式 `unblock`）。
 * 3. `llm` = 由 agent 干活推进，人不需要在场：
 *    建 worktree / 把会话搬进去（`flowcard worktree use`）、实施、开 PR、推送、
 *    写转录、按会话心跳/结束这类回执推进状态。
 * 4. **终态（`done` / `dropped`）也必须有标注**：按「谁拍板把它定在这里」算 ——
 *    两者都是人（验收+清理确认 / 决定放弃），所以是 `human`。
 * 5. 标在**三个地方**（同一套词，谁都别自造）：
 *    `stateActors`（停在这个状态时在等谁动手）、`transitionActors`（这一步谁推的）、
 *    `gates[].actor` / `automations[].actor`（这个节点谁动手）。
 *    看板每列的 `actor` 在 `shared/stage.ts` 的 `STAGE_RULES` 上（这一列**在等谁动手**）。
 */
export type FlowActor = "human" | "llm";

/** 合法的 actor 取值（校验与测试都读这一份，别另写字面量）。 */
export const FLOW_ACTORS = ["human", "llm"] as const;

export type Requirement = {
  id: string;
  /** 给人和 agent 看的说明，缺项时直接回给调用方。 */
  describe: string;
  check: (card: Card) => boolean;
};

export type GateSpec = {
  id: string;
  /** [from, to]：这个门禁把关的转换。 */
  on: [CardState, CardState];
  kind: Gate["kind"];
  title: string;
  /** 谁动手过这道门禁（`human` = 人批的；全流程目前都是人）。 */
  actor: FlowActor;
  /** 生成门禁时需要一并展示的报告项（如清理清单）。 */
  report?: string[];
};

export type Action = { setState: CardState } | { openGate: string } | { comment: string };

export type AutomationSpec = {
  name: string;
  on: EventType;
  when?: (card: Card, payload: Record<string, unknown>) => boolean;
  do: Action[];
  /** 这条自动节点的推进动作归谁动手（口径见 `FlowActor`）。 */
  actor: FlowActor;
};

export type Transition = `${CardState} -> ${CardState}`;

export type Flow = {
  name: string;
  states: readonly CardState[];
  /** 每个状态**停在那里时在等谁动手**（`Record` 语义：`defineFlow` 校验每个状态都有）。 */
  stateActors: Partial<Record<CardState, FlowActor>>;
  requirements: Requirement[];
  gates: GateSpec[];
  requires: Partial<Record<Transition, string[]>>;
  /** 每一条带硬前置的转换**归谁推**（`defineFlow` 校验与 `requires` 的键一一对应）。 */
  transitionActors: Partial<Record<Transition, FlowActor>>;
  automations: AutomationSpec[];
};

/**
 * 定义流程并**当场校验**：状态名、必要条件 id、门禁 id 写错就在启动/测试时炸，
 * 而不是等到某次转换时才莫名其妙地拦住。
 */
export function defineFlow(flow: Flow): Flow {
  const problems: string[] = [];
  const states = flow.states;
  const reqIds = flow.requirements.map((r) => r.id);
  const gateIds = flow.gates.map((g) => g.id);

  if (new Set(reqIds).size !== reqIds.length) problems.push("requirements 里有重复 id");
  if (new Set(gateIds).size !== gateIds.length) problems.push("gates 里有重复 id");

  for (const [key, ids] of Object.entries(flow.requires)) {
    const [from, to] = key.split(" -> ");
    if (!from || !to || !states.includes(from as CardState) || !states.includes(to as CardState)) {
      problems.push(`requires 的键 "${key}" 不是合法的 "状态 -> 状态"`);
    }
    for (const id of ids ?? []) {
      if (!reqIds.includes(id)) problems.push(`requires["${key}"] 引用了未定义的必要条件 "${id}"`);
    }
  }

  for (const gate of flow.gates) {
    const [from, to] = gate.on;
    if (!states.includes(from) || !states.includes(to)) {
      problems.push(`门禁 ${gate.id} 的转换 ${from} -> ${to} 含未定义状态`);
    }
  }

  // 谁动手（human / llm）：**每个状态、每条转换、每个门禁与自动节点都必须有**、且只能是这两个词。
  const actorOk = (a: unknown): a is FlowActor => (FLOW_ACTORS as readonly unknown[]).includes(a);
  for (const state of states) {
    const actor = flow.stateActors[state];
    if (actor === undefined) problems.push(`状态 ${state} 没有 stateActors 标注（必须标 human 或 llm）`);
    else if (!actorOk(actor)) problems.push(`状态 ${state} 的 actor "${String(actor)}" 不是 human / llm`);
  }
  for (const key of Object.keys(flow.stateActors)) {
    if (!states.includes(key as CardState)) problems.push(`stateActors 里有未定义状态 "${key}"`);
  }
  for (const key of Object.keys(flow.requires)) {
    const actor = flow.transitionActors[key as Transition];
    if (actor === undefined) problems.push(`转换 ${key} 没有 transitionActors 标注（必须标 human 或 llm）`);
    else if (!actorOk(actor)) problems.push(`转换 ${key} 的 actor "${String(actor)}" 不是 human / llm`);
  }
  for (const key of Object.keys(flow.transitionActors)) {
    if (!(key in flow.requires)) problems.push(`transitionActors 里的 "${key}" 不是一条 requires 转换`);
  }
  for (const gate of flow.gates) {
    if (!actorOk(gate.actor)) problems.push(`门禁 ${gate.id} 的 actor "${String(gate.actor)}" 不是 human / llm`);
  }

  for (const auto of flow.automations) {
    if (!actorOk(auto.actor)) {
      problems.push(`自动节点 ${auto.name} 的 actor "${String(auto.actor)}" 不是 human / llm`);
    }
    for (const action of auto.do) {
      if ("setState" in action && !states.includes(action.setState)) {
        problems.push(`自动动作 ${auto.name} 设置了未定义状态 "${action.setState}"`);
      }
      if ("openGate" in action && !gateIds.includes(action.openGate)) {
        problems.push(`自动动作 ${auto.name} 打开了未定义门禁 "${action.openGate}"`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`流程定义有问题（${flow.name}）：\n- ${problems.join("\n- ")}`);
  }
  return flow;
}

/** 返回缺失的必要条件 id（空数组 = 允许转换）。 */
export function missingRequirements(
  flow: Flow,
  from: CardState,
  to: CardState,
  card: Card,
): string[] {
  const ids = flow.requires[`${from} -> ${to}` as Transition];
  if (!ids || ids.length === 0) return [];
  return ids.filter((id) => {
    const req = flow.requirements.find((r) => r.id === id);
    if (!req) return true; // 流程写错就当缺项，宁可拦住
    return !req.check(card);
  });
}

/** 描述缺失项，直接用作出错信息（agent 拿到就能自己修）。 */
export function describeMissing(flow: Flow, ids: string[]): string[] {
  return ids.map((id) => {
    const req = flow.requirements.find((r) => r.id === id);
    return req ? `${id}: ${req.describe}` : `${id}: 未定义的必要条件`;
  });
}

/**
 * 会话是否**真的**在这个 worktree 里干活（1:1 模型下的硬校验）。
 *
 * 「还在干活」包含会话本身还活着：`ended` / `lost` 的会话不算 —— 否则一张卡上留下的历史 cwd
 * 会让 `blocked -> working`（以及任何依赖本项的转换）在会话早就不在的时候照样放行。
 */
export function sessionInsideWorktree(card: Card): boolean {
  if (!card.worktree || !card.session) return false;
  if (card.session.agentKind !== "main") return false;
  if (card.session.state !== "running" && card.session.state !== "idle") return false;
  return isInside(card.session.cwd, card.worktree.path);
}
