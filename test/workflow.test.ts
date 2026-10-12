/**
 * 流程视图（Workflow tab）的不变量。
 *
 * 视图内容**全部来自常量**（`src/flow/personal.ts` + `src/shared/stage.ts`），所以这里钉的是
 * 「常量与视图不许对不上」：
 *
 * 1. `CARD_STATES` **每个状态**都出现在流程图里（没有状态被藏起来）；
 * 2. `STAGES` **每一列**都有节点、且能溯源到**恰好一条**判据（`when` 文案 + 名次都来自 `STAGE_RULES`）；
 * 3. 视图里的状态集合 = `CARD_STATES`、列集合 = `STAGES`（**集合相等：没漏没多**）；
 * 4. 每条状态 / 转换 / 自动节点 / 门禁 / 判据都有 `actor`，取值只能是 `human` / `llm`
 *    （渲染出的标签条数 = 常量条数，一条都不许漏标）；
 * 5. **动作节点层**：每个节点都有 `actor` ∈ {human, llm, command} + 前置 / 产出 / 证据来源 /
 *    推进目标，数组顺序 = 执行顺序（前置永远在前面）；
 * 6. **`command` 节点写的命令必须真实存在**：名字与子命令核对 `src/cli/commands.ts` 的命令表，
 *    用到的 `--flag` 核对 `src/cli/main.ts` 里真实的 `parseArgs` 选项（**不许编造命令**）。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_COMMANDS, lookupCliCommand } from "../src/cli/commands.ts";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createStore } from "../src/server/store.ts";
import { DECISION_ACTORS, FLOW_ACTORS, type FlowActor, type Transition } from "../src/shared/flow.ts";
import { STAGE_FACT_LABELS, STAGE_RULES, STAGES, type StageFactSource } from "../src/shared/stage.ts";
import { CARD_STATES, STATE_LABELS } from "../src/shared/types.ts";
import { buildWorkflow, workflowActorSlots } from "../src/shared/workflow.ts";

const ACTORS: readonly FlowActor[] = FLOW_ACTORS;
const DECISIONS: readonly FlowActor[] = DECISION_ACTORS;
const FACT_SOURCES = Object.keys(STAGE_FACT_LABELS) as StageFactSource[];

const payload = buildWorkflow();

// ---------------------------------------------------------------- CLI 真相（读源码，不抄第二份）
const cliSource = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../src/shared/types.ts", import.meta.url), "utf8");

/** `src/cli/main.ts` 里 `parseArgs` 真实声明的 flag。 */
const CLI_FLAGS: readonly string[] = (() => {
  const start = cliSource.indexOf("const { values, positionals } = parseArgs({");
  const block = cliSource.slice(start, cliSource.indexOf("});", start));
  return [...block.matchAll(/^\s+"?([\w-]+)"?:\s*\{\s*type:/gm)].map((match) => match[1] ?? "");
})();

/** `src/shared/types.ts` 的 `EventType` 联合里真实存在的事件名。 */
const EVENT_TYPES: readonly string[] = (() => {
  const start = typesSource.indexOf("export type EventType =");
  const block = typesSource.slice(start, typesSource.indexOf(";", start));
  return [...block.matchAll(/\|\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
})();

/** `flowcard <name> [sub] [--flag…]` → 拆成可核对的三段。 */
function parseCommand(command: string) {
  const tokens = command.split(/\s+/);
  const [bin, name, ...rest] = tokens;
  const sub = rest[0] !== undefined && !rest[0].startsWith("--") ? rest[0] : null;
  const flags = rest.filter((token) => token.startsWith("--")).map((token) => (token.split("=")[0] ?? "").replace(/^--/, ""));
  return { bin, name: name ?? "", sub, flags };
}

// ---------------------------------------------------------------- 流程图：状态

describe("流程图：状态", () => {
  it("CARD_STATES 每个状态都在图上（一个不漏），且集合相等（不多）", () => {
    const ids = payload.flow.states.map((state) => state.id);
    expect(new Set(ids)).toEqual(new Set(CARD_STATES));
    expect(ids.length).toBe(CARD_STATES.length);
  });

  it("每个状态都有中文名、actor，以及进/出边（进边为空要能报出来）", () => {
    for (const state of payload.flow.states) {
      expect(state.label, state.id).toBe(STATE_LABELS[state.id]);
      expect(DECISIONS, state.id).toContain(state.actor);
      for (const key of [...state.incoming, ...state.outgoing]) expect(key).toContain(" -> ");
    }
    // 入度为 0 的状态（建卡即 ready、blocked / dropped 靠命令直达）必须是常量 + 边推出来的，不是写死的
    expect(payload.flow.entranceFreeStates).toEqual(
      payload.flow.states.filter((state) => state.incoming.length === 0).map((state) => state.id),
    );
  });
});

// ---------------------------------------------------------------- 流程图：转换 / 门禁 / 自动节点

describe("流程图：转换 / 门禁 / 自动节点", () => {
  it("每条 requires 转换都在图上，且 1:1 带 actor 与硬前置说明", () => {
    const keys = Object.keys(personalFlow.requires) as Transition[];
    expect(payload.flow.transitions.map((t) => t.id)).toEqual(keys);
    for (const t of payload.flow.transitions) {
      expect(DECISIONS, t.id).toContain(t.actor);
      expect(personalFlow.transitionActors[t.id as Transition], t.id).toBe(t.actor);
      // 边界必须与常量同名，且是合法状态
      expect(t.id).toBe(`${t.from} -> ${t.to}`);
      expect(CARD_STATES).toContain(t.from);
      expect(CARD_STATES).toContain(t.to);
      // 每条前置都能溯源到 requirements 的人话说明
      expect(t.requires.length).toBe(personalFlow.requires[t.id as Transition]?.length);
      for (const req of t.requires) {
        expect(personalFlow.requirements.some((r) => r.id === req.id), req.id).toBe(true);
        expect(req.describe.trim().length, req.id).toBeGreaterThan(0);
      }
    }
  });

  it("门禁 1:1 展开，actor 只能是 human / llm，且指向一条真实转换", () => {
    expect(payload.flow.gates.map((g) => g.id)).toEqual(personalFlow.gates.map((g) => g.id));
    for (const gate of payload.flow.gates) {
      const spec = personalFlow.gates.find((g) => g.id === gate.id);
      expect(spec, gate.id).toBeDefined();
      expect(gate.actor).toBe(spec?.actor);
      expect(DECISIONS).toContain(gate.actor);
      expect(gate.on).toBe(`${spec?.on[0]} -> ${spec?.on[1]}`);
      expect(gate.report).toEqual(spec?.report ?? []);
    }
  });

  it("自动节点 1:1 展开，带 actor、事件、动作与探测出的触发状态", () => {
    expect(payload.flow.automations.map((a) => a.name)).toEqual(personalFlow.automations.map((a) => a.name));
    for (const auto of payload.flow.automations) {
      const spec = personalFlow.automations.find((a) => a.name === auto.name);
      expect(spec, auto.name).toBeDefined();
      expect(auto.actor).toBe(spec?.actor);
      expect(DECISIONS).toContain(auto.actor);
      expect(auto.on).toBe(spec?.on);
      expect(auto.setsState.length + auto.opensGates.length).toBeGreaterThan(0);
      expect(auto.whenStates.length).toBeGreaterThan(0);
      for (const state of auto.whenStates) expect(CARD_STATES).toContain(state);
    }
    // `when: (c) => c.state === "ready"` 这类条件要能被探测出来（ready 的三条自动节点）
    const beat = payload.flow.automations.find((a) => a.name === "beat-advances-to-working");
    expect(beat?.whenStates).toEqual(["ready"]);
  });
});

// ---------------------------------------------------------------- 动作节点层

describe("动作节点层（细粒度）", () => {
  it("节点够细：20+ 个，且覆盖了流程里的关键动作", () => {
    expect(payload.flow.actions.length).toBeGreaterThanOrEqual(20);
    expect(payload.flow.actions.map((a) => a.id)).toEqual(personalFlow.actions.map((a) => a.id));
    const required = [
      "open-card",
      "bind-issue",
      "create-worktree",
      "start-session",
      "implement-brief",
      "run-verification",
      "open-wip-pr",
      "push-record",
      "hand-back",
      "ask-review",
      "accept-review",
      "merge-pr",
      "propose-cleanup",
      "approve-cleanup",
      "cleanup-execute",
      "remote-write-request",
      "remote-write-approve",
      "remote-write-consume",
    ];
    const ids = payload.flow.actions.map((a) => a.id);
    for (const id of required) expect(ids, `缺动作节点 ${id}`).toContain(id);
  });

  it("每个节点都有 actor（∈ human/llm/command）/ actorWhy / 产出 / 证据 / 前置与推进目标", () => {
    for (const action of payload.flow.actions) {
      expect(ACTORS, action.id).toContain(action.actor);
      expect(action.actorWhy.trim().length, action.id).toBeGreaterThan(0);
      expect(action.output.trim().length, action.id).toBeGreaterThan(0);
      expect(action.evidence.length, action.id).toBeGreaterThan(0);
      expect(action.order).toBeGreaterThan(0);
      for (const state of action.needsStates) expect(CARD_STATES, action.id).toContain(state);
      if (action.toState !== null) expect(CARD_STATES, action.id).toContain(action.toState);
      if (action.toStage !== null) expect(STAGES, action.id).toContain(action.toStage);
    }
    // 三种 actor 都真的用上了（人拍的板 / agent 干的活 / 机械落库）
    for (const actor of ACTORS) {
      expect(
        payload.flow.actions.filter((action) => action.actor === actor).length,
        `没有节点的 actor 是 ${actor}`,
      ).toBeGreaterThan(0);
    }
  });

  it("数组顺序 = 执行顺序：每个节点的前置都排在它前面（拓扑序），序号连续", () => {
    for (const [index, action] of payload.flow.actions.entries()) {
      expect(action.order).toBe(index + 1);
      for (const need of action.needs) {
        expect(need.order, `${action.id} 的前置 ${need.id}`).toBeLessThan(action.order);
        expect(payload.flow.actions[need.order - 1]?.id, need.id).toBe(need.id);
        // 中文名也要能从常量里查到（前端不用自己查表）
        expect(need.title).toBe(personalFlow.actions[need.order - 1]?.title);
      }
    }
  });

  it("证据来源合法：事件名在 EventType 里、门禁在 flow.gates 里、字段路径非空", () => {
    for (const action of payload.flow.actions) {
      for (const evidence of action.evidence) {
        if (evidence.kind === "event") expect(EVENT_TYPES, `${action.id} 的证据事件`).toContain(evidence.name);
        if (evidence.kind === "field") expect(evidence.path.trim().length, action.id).toBeGreaterThan(0);
        if (evidence.kind === "gate") expect(personalFlow.gates.map((g) => g.id), action.id).toContain(evidence.id);
      }
    }
  });

  it("`command` 节点的命令必须真实存在（核对 CLI 命令表，不许编造）", () => {
    const commandNodes = payload.flow.actions.filter((action) => action.actor === "command");
    expect(commandNodes.length).toBeGreaterThan(0);
    for (const action of commandNodes) {
      expect(action.command, `${action.id} 是 command 节点却没有命令`).not.toBeNull();
    }
    for (const action of payload.flow.actions) {
      if (action.command === null) continue;
      const { bin, name, sub, flags } = parseCommand(action.command);
      expect(bin, `${action.id}: ${action.command}`).toBe("flowcard");
      expect(lookupCliCommand(name, sub), `${action.id} 的命令不存在：${action.command}`).not.toBeNull();
      for (const flag of flags) expect(CLI_FLAGS, `${action.id} 用了不存在的 flag --${flag}`).toContain(flag);
    }
    // 命令表本身是给 help 用的那一份：没被清空、名字唯一
    expect(CLI_COMMANDS.length).toBeGreaterThan(10);
    expect(new Set(CLI_COMMANDS.map((c) => c.name)).size).toBe(CLI_COMMANDS.length);
    // 反例：编造的命令必须被这套核对挡住
    expect(lookupCliCommand("push", null)).not.toBeNull();
    expect(CLI_FLAGS).not.toContain("record");
    expect(lookupCliCommand("not-a-command", null)).toBeNull();
  });

  it("9 列每列至少有一个可达的动作节点（列不是空的）", () => {
    for (const stage of payload.stages) {
      expect(stage.actions.length, `列 ${stage.id} 没有动作节点`).toBeGreaterThan(0);
      for (const action of stage.actions) {
        const node = payload.flow.actions.find((candidate) => candidate.id === action.id);
        expect(node?.toStage, action.id).toBe(stage.id);
        expect(node?.actor).toBe(action.actor);
      }
    }
  });
});

// ---------------------------------------------------------------- 看板的 9 列

describe("看板的 9 列：每列都能溯源到一条判据", () => {
  it("列集合与 STAGES 相等（没漏没多），顺序 = 判据优先级", () => {
    const ids = payload.stages.map((stage) => stage.id);
    expect(new Set(ids)).toEqual(new Set(STAGES));
    expect(ids.length).toBe(STAGES.length);
    // 图上列节点的顺序 = 判据表顺序（= 匹配优先级，与看板显示顺序 STAGES 相反）
    expect(ids).toEqual(STAGE_RULES.map((rule) => rule.stage));
    expect(payload.stages.map((stage) => stage.priority)).toEqual(STAGE_RULES.map((_, index) => index + 1));
  });

  it("每列都有节点、有判据人话、有事实来源、有 actor", () => {
    expect(payload.stages.length).toBe(STAGE_RULES.length);
    for (const [index, stage] of payload.stages.entries()) {
      const rule = STAGE_RULES[index];
      expect(rule, stage.id).toBeDefined();
      expect(stage.id).toBe(rule?.stage);
      // 判据文案、actor、事实来源、读到的状态全部来自常量，前端一个字没改
      expect(stage.when).toBe(rule?.when);
      expect(stage.when.trim().length).toBeGreaterThan(0);
      expect(stage.actor).toBe(rule?.actor);
      expect(DECISIONS, stage.id).toContain(stage.actor);
      expect(stage.facts).toEqual([...(rule?.facts ?? [])]);
      expect(stage.states).toEqual([...(rule?.states ?? [])]);
      expect(stage.facts.length, stage.id).toBeGreaterThan(0);
      for (const fact of stage.facts) expect(FACT_SOURCES, `${stage.id}/${fact}`).toContain(fact);
      for (const state of stage.states) expect(CARD_STATES, `${stage.id}/${state}`).toContain(state);
    }
  });

  it("判据文案里提到的事实必须在 facts 里标出来（标注与判据不许对不上）", () => {
    const FACT_KEYWORDS: Record<string, StageFactSource> = {
      PR: "pr",
      会话: "session",
      提交: "git",
      脏文件: "git",
      改动: "git",
    };
    for (const stage of payload.stages) {
      for (const [word, source] of Object.entries(FACT_KEYWORDS)) {
        if (stage.when.includes(word)) expect(stage.facts, `${stage.id} 提到「${word}」`).toContain(source);
      }
    }
  });

  it("与状态同名的列，等的人和状态机说的是同一件事", () => {
    for (const stage of payload.stages) {
      const state = CARD_STATES.find((id) => id === stage.id);
      if (state) expect(personalFlow.stateActors[state], state).toBe(stage.actor);
    }
  });
});

// ---------------------------------------------------------------- 谁动手

describe("谁动手：human / llm / command 标签", () => {
  it("每条状态 / 转换 / 自动节点 / 门禁 / 判据 / 动作节点都有 actor，取值只有那三个", () => {
    expect(ACTORS).toEqual(["human", "llm", "command"]);
    const slots = workflowActorSlots(payload);
    expect(slots.length).toBe(
      CARD_STATES.length +
        Object.keys(personalFlow.requires).length +
        personalFlow.automations.length +
        personalFlow.gates.length +
        personalFlow.actions.length +
        STAGE_RULES.length,
    );
    for (const slot of slots) expect(ACTORS, `${slot.kind}:${slot.id}`).toContain(slot.actor);
    // 状态机那一层只谈「谁拍板」：不可能是 command
    for (const slot of slots.filter((slot) => slot.kind !== "action")) {
      expect(DECISIONS, `${slot.kind}:${slot.id}`).toContain(slot.actor);
    }
    // 每个状态机节点都必须自己有标注（常量里写全，别靠视图兜底）
    for (const id of CARD_STATES) expect(DECISIONS, id).toContain(personalFlow.stateActors[id]);
    for (const key of Object.keys(personalFlow.requires) as Transition[]) {
      expect(DECISIONS, key).toContain(personalFlow.transitionActors[key]);
    }
  });

  it("标注条数与节点数一致（每个动作节点恰好一条 actor 标签，没漏标）", () => {
    const slotCounts = workflowActorSlots(payload).reduce<Record<string, number>>((acc, slot) => {
      acc[slot.kind] = (acc[slot.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(slotCounts["action"]).toBe(personalFlow.actions.length);
    expect(payload.flow.actions.length).toBe(personalFlow.actions.length);
  });

  it("三类都真的有：人拍板的、agent 干的、机械落库的", () => {
    const counts = payload.flow.actions.reduce<Record<string, number>>((acc, action) => {
      acc[action.actor] = (acc[action.actor] ?? 0) + 1;
      return acc;
    }, {});
    const slots = workflowActorSlots(payload);
    expect(slots.some((slot) => slot.actor === "human")).toBe(true);
    expect(slots.filter((slot) => slot.actor === "command").map((slot) => slot.id)).toEqual(
      payload.flow.actions.filter((action) => action.actor === "command").map((action) => action.id),
    );
    // 人拍板的典型：验收 / 清理确认 / 远程写授权；机械的典型：建 worktree / 推送登记 / 核销授权
    for (const id of ["accept-review", "approve-cleanup", "remote-write-approve"]) {
      expect(counts["human"], id).toBeGreaterThan(0);
      expect(payload.flow.actions.find((action) => action.id === id)?.actor, id).toBe("human");
    }
    for (const id of ["create-worktree", "push-record", "remote-write-consume", "cleanup-execute"]) {
      expect(payload.flow.actions.find((action) => action.id === id)?.actor, id).toBe("command");
    }
    // 边界例子：`flowcard accept` 是 CLI 敲的，但判断是人做的 → human（不是 command）
    const accept = payload.flow.actions.find((action) => action.id === "accept-review");
    expect(accept?.actor).toBe("human");
    expect(accept?.command).toBe("flowcard accept");
    // 两道门禁都归人
    for (const gate of payload.flow.gates) expect(gate.actor, gate.id).toBe("human");
    // 等人拍板的列：待你验收 / 已合并待清理 / PR 待审
    const stageActor = (id: string) => payload.stages.find((stage) => stage.id === id)?.actor;
    expect(stageActor("review")).toBe("human");
    expect(stageActor("merged")).toBe("human");
    expect(stageActor("prReview")).toBe("human");
    // agent 自己推的：实施中 / 待开 PR / 待立项
    expect(stageActor("working")).toBe("llm");
    expect(stageActor("prTodo")).toBe("llm");
    expect(stageActor("backlog")).toBe("llm");
  });
});

describe("GET /api/workflow", () => {
  it("返回的就是常量编译出来的那份数据（服务端不另写一遍）", async () => {
    const store = createStore({ dataDir: mkdtempSync(join(tmpdir(), "flowcard-workflow-")), flow: personalFlow });
    const res = await createApp(store).request("/api/workflow");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(payload)));
  });
});
