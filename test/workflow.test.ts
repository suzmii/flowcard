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
 *    （渲染出的标签条数 = 常量条数，一条都不许漏标）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { createApp } from "../src/server/app.ts";
import { createStore } from "../src/server/store.ts";
import { FLOW_ACTORS, type FlowActor } from "../src/shared/flow.ts";
import { STAGE_FACT_LABELS, STAGE_RULES, STAGES, type StageFactSource } from "../src/shared/stage.ts";
import type { Transition } from "../src/shared/flow.ts";
import { CARD_STATES, STATE_LABELS } from "../src/shared/types.ts";
import { buildWorkflow, workflowActorSlots } from "../src/shared/workflow.ts";

const ACTORS: readonly FlowActor[] = FLOW_ACTORS;
const FACT_SOURCES = Object.keys(STAGE_FACT_LABELS) as StageFactSource[];

const payload = buildWorkflow();

describe("流程图：状态", () => {
  it("CARD_STATES 每个状态都在图上（一个不漏），且集合相等（不多）", () => {
    const ids = payload.flow.states.map((state) => state.id);
    expect(new Set(ids)).toEqual(new Set(CARD_STATES));
    expect(ids.length).toBe(CARD_STATES.length);
  });

  it("每个状态都有中文名、actor，以及进/出边（进边为空要能报出来）", () => {
    for (const state of payload.flow.states) {
      expect(state.label, state.id).toBe(STATE_LABELS[state.id]);
      expect(ACTORS, state.id).toContain(state.actor);
      for (const key of [...state.incoming, ...state.outgoing]) expect(key).toContain(" -> ");
    }
    // 入度为 0 的状态（建卡即 ready、blocked / dropped 靠命令直达）必须是常量 + 边推出来的，不是写死的
    expect(payload.flow.entranceFreeStates).toEqual(
      payload.flow.states.filter((state) => state.incoming.length === 0).map((state) => state.id),
    );
  });
});

describe("流程图：转换 / 门禁 / 自动节点", () => {
  it("每条 requires 转换都在图上，且 1:1 带 actor 与硬前置说明", () => {
    const keys = Object.keys(personalFlow.requires) as Transition[];
    expect(payload.flow.transitions.map((t) => t.id)).toEqual(keys);
    for (const t of payload.flow.transitions) {
      expect(ACTORS, t.id).toContain(t.actor);
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
      expect(ACTORS).toContain(gate.actor);
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
      expect(ACTORS).toContain(auto.actor);
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
      expect(ACTORS, stage.id).toContain(stage.actor);
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

describe("谁动手：human / llm 标签", () => {
  it("每条状态 / 转换 / 自动节点 / 门禁 / 判据都有 actor，且取值只有 human / llm", () => {
    expect(ACTORS).toEqual(["human", "llm"]);
    const slots = workflowActorSlots(payload);
    expect(slots.length).toBe(
      CARD_STATES.length +
        Object.keys(personalFlow.requires).length +
        personalFlow.automations.length +
        personalFlow.gates.length +
        STAGE_RULES.length,
    );
    for (const slot of slots) expect(ACTORS, `${slot.kind}:${slot.id}`).toContain(slot.actor);
    // 每个状态机节点都必须自己有标注（常量里写全，别靠视图兜底）
    for (const id of CARD_STATES) expect(ACTORS, id).toContain(personalFlow.stateActors[id]);
    for (const key of Object.keys(personalFlow.requires) as Transition[]) {
      expect(ACTORS, key).toContain(personalFlow.transitionActors[key]);
    }
  });

  it("两类都真的有：人拍板的（验收/清理/解除阻塞）与 agent 干的（实施/开 PR）", () => {
    const humans = workflowActorSlots(payload).filter((slot) => slot.actor === "human");
    const llms = workflowActorSlots(payload).filter((slot) => slot.actor === "llm");
    expect(humans.length).toBeGreaterThan(0);
    expect(llms.length).toBeGreaterThan(0);
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
