/**
 * 流程 = 有类型的代码：状态、门禁、硬前置（requires）、自动动作。
 * 引擎只认这里的声明，一切"缺项拦截"都由 requires 表达。
 */
import type { Card, CardState, EventType, Gate } from "./types.ts";
import { isInside } from "./paths.ts";

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
  /** 生成门禁时需要一并展示的报告项（如清理清单）。 */
  report?: string[];
};

export type Action = { setState: CardState } | { openGate: string } | { comment: string };

export type AutomationSpec = {
  name: string;
  on: EventType;
  when?: (card: Card, payload: Record<string, unknown>) => boolean;
  do: Action[];
};

export type Transition = `${CardState} -> ${CardState}`;

export type Flow = {
  name: string;
  states: readonly CardState[];
  requirements: Requirement[];
  gates: GateSpec[];
  requires: Partial<Record<Transition, string[]>>;
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

  for (const auto of flow.automations) {
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
