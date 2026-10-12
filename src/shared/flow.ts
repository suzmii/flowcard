/**
 * 流程 = 有类型的代码：状态、门禁、硬前置（requires）、自动动作。
 * 引擎只认这里的声明，一切"缺项拦截"都由 requires 表达。
 */
import type { Card, CardState, EventType, Gate } from "./types.ts";
import { isInside } from "./paths.ts";
// 只取列集合（运行时单向：stage.ts 对 flow.ts 只有 type-only 引用，不会成环）
import { STAGES } from "./stage.ts";
import type { Stage } from "./stage.ts";

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
export type FlowActor = "human" | "llm" | "command";

/**
 * 合法的 actor 取值（校验与测试都读这一份，别另写字面量）。
 *
 * | 取值 | 谁 | 判据 |
 * |---|---|---|
 * | `human` | 人 | 这一步必须人**拍板 / 动手**才往下走（验收 G3、清理确认 G4、远程写授权与 consume、等人看/合 PR、解除阻塞） |
 * | `llm` | agent | 由 agent **做判断并干活**推进（建 worktree、按 brief 实施、跑验证、开 PR、交回、拆片） |
 * | `command` | 机械动作 | **只是把已经定好的事落到系统里**：没有人的判断、也没有模型的判断（`flowcard worktree use`、`flowcard push --sha`、`flowcard confirm --consume`、`flowcard cleanup`）。边界拿不准就问「**这一步有没有判断**」 |
 *
 * 边界例子：`flowcard accept` 虽然是 CLI 敲的，但**判断是人做的** → `human`；
 * `flowcard confirm --approve` 同理是 `human`；而 `flowcard confirm --consume` 只是核销一张已经批过的凭据 → `command`。
 *
 * 用处：**只有动作节点（`actions`）会用 `command`** —— 状态机那一层（`stateActors` / `transitionActors` /
 * `gates` / `automations`）说的都是「谁在拍板」，只可能是 `human` / `llm`（`defineFlow` 会校验）。
 */
export const FLOW_ACTORS = ["human", "llm", "command"] as const;

/** 拍板用的两个取值（状态机那一层只认这两个）。 */
export const DECISION_ACTORS = ["human", "llm"] as const satisfies readonly FlowActor[];

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

// ---------------------------------------------------------------- 动作节点（细粒度）

/**
 * 一个动作节点**靠什么判定它真的发生了**（事件 / 卡片字段 / 门禁）。
 * 只认这三种：别的都是猜。
 */
export type Evidence =
  | { kind: "event"; name: EventType }
  | { kind: "field"; path: string }
  | { kind: "gate"; id: string };

/**
 * **动作节点**：把「状态 → 状态」再细一层到「具体动作 → 具体动作」。
 *
 * 这是**视图用的声明**，不动状态机语义：`Card.state` 还是只认 `states` 那七个值，
 * 细分只体现在这些节点上（`toState` 非空 = 这一步会推状态；`toStage` = 这一步之后卡片落在看板哪一列）。
 */
export type ActionSpec = {
  id: string;
  /** 中文名（人话，直接显示在流程图上）。 */
  title: string;
  actor: FlowActor;
  /** **为什么是这个人**（拍板 or 只是落库的机械动作）—— 边界处必须写清楚，别让读的人猜。 */
  actorWhy: string;
  /** 前置动作：这些节点要先完成（空数组 = 没有动作前置）。 */
  needsActions: readonly string[];
  /** 前置状态：卡片要先处于这些状态之一（空数组 = 不看状态）。 */
  needsStates: readonly CardState[];
  /** 产出：这一步之后系统里多了什么（交付物 / 事实）。 */
  output: string;
  /** 证据来源：靠哪个事件 / 字段 / 门禁判定它真的发生了。 */
  evidence: readonly Evidence[];
  /** 这一步把卡片推到哪个状态（`null` = 不推状态）。 */
  toState: CardState | null;
  /** 这一步之后卡片落进看板哪一列（`null` = 不改列）。 */
  toStage: Stage | null;
  /**
   * 这一步在 CLI 里敲什么（`flowcard <name> [sub] [--flag]`）。
   * **`command` 节点必须有**，且必须是 `src/cli/commands.ts` 里真实存在的命令；
   * 其余节点没有对应命令就写 `null`（人/模型做的判断未必有命令）。
   */
  command: string | null;
};

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
  /** 动作节点（细粒度层）：**按执行顺序**写在数组里，`needsActions` 只能指向前面的节点。 */
  actions: readonly ActionSpec[];
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

  // 动作节点：id 唯一、actor 合法、前置存在、"command 节点必须有真命令 / 别的节点别乱写命令"、
  // 证据来源与推进目标合法。
  const decisionOk = (a: unknown): a is FlowActor => (DECISION_ACTORS as readonly unknown[]).includes(a);
  const actionIds = flow.actions.map((action) => action.id);
  if (new Set(actionIds).size !== actionIds.length) problems.push("actions 里有重复 id");
  for (const action of flow.actions) {
    if (!actorOk(action.actor)) {
      problems.push(`动作节点 ${action.id} 的 actor "${String(action.actor)}" 不是 human / llm / command`);
    }
    if (action.command !== null && !action.command.startsWith("flowcard ")) {
      problems.push(`动作节点 ${action.id} 的 command "${action.command}" 必须以 "flowcard " 开头`);
    }
    if (action.actor === "command") {
      if (action.command === null) problems.push(`动作节点 ${action.id} 是 command，但没写 command 字段`);
    }
    if (action.actorWhy.trim() === "") problems.push(`动作节点 ${action.id} 没写 actorWhy（为什么是这个人）`);
    if (action.output.trim() === "") problems.push(`动作节点 ${action.id} 没写 output（产出）`);
    if (action.evidence.length === 0) problems.push(`动作节点 ${action.id} 没写 evidence（靠什么判定）`);
    for (const evidence of action.evidence) {
      if (evidence.kind === "gate" && !gateIds.includes(evidence.id)) {
        problems.push(`动作节点 ${action.id} 的证据指向未定义门禁 "${evidence.id}"`);
      }
      if (evidence.kind === "field" && evidence.path.trim() === "") {
        problems.push(`动作节点 ${action.id} 有一条空字段证据`);
      }
    }
    for (const need of action.needsActions) {
      if (!actionIds.includes(need)) problems.push(`动作节点 ${action.id} 的前置 "${need}" 不是动作节点`);
    }
    for (const state of action.needsStates) {
      if (!states.includes(state)) problems.push(`动作节点 ${action.id} 的前置状态 "${state}" 未定义`);
    }
    if (action.toState !== null && !states.includes(action.toState)) {
      problems.push(`动作节点 ${action.id} 推进到未定义状态 "${action.toState}"`);
    }
    if (action.toStage !== null && !(STAGES as readonly string[]).includes(action.toStage)) {
      problems.push(`动作节点 ${action.id} 推进到未定义列 "${action.toStage}"`);
    }
    // 前置只能指向**写在前面**的节点：数组顺序 = 执行顺序，别让读的人自己去拓扑排序
    const index = actionIds.indexOf(action.id);
    for (const need of action.needsActions) {
      if (actionIds.indexOf(need) >= index) {
        problems.push(`动作节点 ${action.id} 的前置 "${need}" 写在它后面（数组顺序必须是执行顺序）`);
      }
    }
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
