/**
 * **Workflow 视图**：把「任务流程」和「看板的 9 列」放在一张图里讲清楚，并让两边**互相能跳**。
 *
 * 内容**一个字都不在这里手写**：
 * - 流程主体（状态 / 转换 / 硬前置 / 门禁 / 自动节点）来自 `src/flow/personal.ts`；
 * - 9 列（列名 / 判据人话 / 等谁动手 / 看哪几类事实）来自 `src/shared/stage.ts`；
 * - 两者都由 `src/shared/workflow.ts` 编译成 `GET /api/workflow` 的响应，这里只渲染。
 *
 * 溯源约定（改这个文件时别破坏）：
 * - **每个常量条目恰好一个 `data-actor`**（状态节点、转换边、自动节点、门禁、列各一次），
 *   内部的 `human` / `llm` 徽标不再重复打 —— 这样 `data-actor` 的条数可以拿来当「标签没漏标」的证据。
 * - 列节点有稳定的 `id="wf-stage-<stage>"`，状态节点 `id="wf-state-<state>"`，
 *   看板列头就是靠 `#workflow/stage/<stage>` 这种 hash 一键跳过来的。
 */
import { useEffect, useMemo } from "react";
import { ExternalLink, ListTree, RefreshCw } from "lucide-react";
import {
  ACTOR_HINT,
  ACTOR_TEXT,
  ACTOR_TONE,
  STAGE_FACT_LABELS,
  STAGE_TONE,
  type FlowActor,
  type Stage,
} from "@/lib/contract";
import {
  countByStage,
  type Workflow,
  type WorkflowActionNode,
  type WorkflowEvidence,
  type WorkflowStateNode,
} from "@/lib/workflow";
import type { CardView } from "@/lib/schema";

/** 图上被选中的节点（看板列头 / 图内互跳都走这里）。 */
export type WorkflowFocus = { kind: "stage" | "state"; id: string };

/** SVG 布局常量：不引图表库，位置按「转换的层数」算出来。 */
const NODE_W = 168;
const NODE_H = 46;
const LANE_GAP = 64;
const ROW_GAP = 26;

const ACTOR_COLOR: Record<FlowActor, string> = { human: "#e11d48", llm: "#0284c7", command: "#475569" };

/** 证据来源怎么显示（事件 / 卡片字段 / 门禁 —— 只认这三种）。 */
const EVIDENCE_KIND_LABEL: Record<WorkflowEvidence["kind"], string> = {
  event: "事件",
  field: "字段",
  gate: "门禁",
};

function evidenceRef(evidence: WorkflowEvidence): string {
  if (evidence.kind === "event") return evidence.name;
  if (evidence.kind === "field") return evidence.path;
  return evidence.id;
}

/** 停在这个状态时在等谁动手 —— 徽标文字就是那一列 / 那一站等的人。 */
function ActorBadge({ actor, size = "sm" }: { actor: FlowActor; size?: "sm" | "xs" }) {
  return (
    <span
      className={`inline-flex items-center rounded border font-mono ${size === "xs" ? "px-1 text-[10px]" : "px-1.5 text-[11px]"} ${ACTOR_TONE[actor]}`}
      title={ACTOR_HINT[actor]}
    >
      {ACTOR_TEXT[actor]}
    </span>
  );
}

/**
 * 状态节点在图上放哪：**层 = 转了几跳**（沿声明式转换走最长路径，遇到回边/自环就停下）。
 * 位置是算出来的，不写死 —— 流程加了状态或转换，图自己会长出来。
 */
function layoutStates(states: WorkflowStateNode[], edges: { from: string; to: string }[]) {
  const depthOf = (id: string, seen: readonly string[]): number => {
    if (seen.includes(id)) return 0;
    const incoming = edges.filter((edge) => edge.to === id && edge.from !== id);
    if (incoming.length === 0) return 0;
    return 1 + Math.max(...incoming.map((edge) => depthOf(edge.from, [...seen, id])));
  };
  const lanes = new Map<number, WorkflowStateNode[]>();
  for (const state of states) {
    const depth = depthOf(state.id, []);
    lanes.set(depth, [...(lanes.get(depth) ?? []), state]);
  }
  const nodes = states.map((state) => {
    const depth = depthOf(state.id, []);
    const row = lanes.get(depth)?.findIndex((candidate) => candidate.id === state.id) ?? 0;
    return {
      state,
      x: depth * (NODE_W + LANE_GAP) + 8,
      y: row * (NODE_H + ROW_GAP) + 8,
    };
  });
  const height = Math.max(...[...lanes.values()].map((lane) => lane.length)) * (NODE_H + ROW_GAP) + 16;
  const width = Math.max(...[...lanes.keys()]) * (NODE_W + LANE_GAP) + NODE_W + 16;
  return { nodes, width, height, lanes };
}

function WorkflowDiagram({
  workflow,
  focus,
  onFocus,
}: {
  workflow: Workflow;
  focus: WorkflowFocus | null;
  onFocus: (focus: WorkflowFocus) => void;
}) {
  const { nodes, width, height } = useMemo(
    () => layoutStates(workflow.flow.states, workflow.flow.transitions),
    [workflow.flow.states, workflow.flow.transitions],
  );
  const at = (id: string) => nodes.find((node) => node.state.id === id);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full min-w-[52rem]"
      style={{ height }}
      data-testid="wf-graph"
      role="img"
      aria-label="流程状态与转换"
    >
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
        </marker>
      </defs>

      {workflow.flow.transitions.map((transition) => {
        const from = at(transition.from);
        const to = at(transition.to);
        if (!from || !to) return null;
        const sx = from.x + NODE_W;
        const sy = from.y + NODE_H / 2;
        const tx = to.x;
        const ty = to.y + NODE_H / 2;
        const mx = (sx + tx) / 2;
        const label = `${transition.actor}`;
        return (
          <g key={transition.id} data-actor={transition.actor} data-testid={`wf-edge-${transition.from}-${transition.to}`}>
            <path
              d={`M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`}
              fill="none"
              stroke={ACTOR_COLOR[transition.actor]}
              strokeWidth="1.6"
              markerEnd="url(#wf-arrow)"
            />
            <rect
              x={mx - label.length * 3.6 - 5}
              y={(sy + ty) / 2 - 9}
              width={label.length * 7.2 + 10}
              height={18}
              rx={9}
              fill="#ffffff"
              stroke={ACTOR_COLOR[transition.actor]}
            />
            <text
              x={mx}
              y={(sy + ty) / 2 + 4}
              textAnchor="middle"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fill={ACTOR_COLOR[transition.actor]}
            >
              {label}
            </text>
          </g>
        );
      })}

      {nodes.map(({ state, x, y }) => {
        const active = focus?.kind === "state" && focus.id === state.id;
        return (
          <g
            key={state.id}
            id={`wf-state-${state.id}`}
            data-actor={state.actor}
            data-testid={`wf-state-${state.id}`}
            onClick={() => onFocus({ kind: "state", id: state.id })}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={x}
              y={y}
              width={NODE_W}
              height={NODE_H}
              rx={10}
              fill={active ? "#f1f5f9" : "#ffffff"}
              stroke={active ? "#0f172a" : "#cbd5e1"}
              strokeWidth={active ? 2.5 : 1}
            />
            <text x={x + 12} y={y + 20} fontSize="12.5" fill="#0f172a">
              {state.label}
            </text>
            <text x={x + 12} y={y + 36} fontSize="10" fontFamily="ui-monospace, monospace" fill="#64748b">
              {state.id}
            </text>
            <text
              x={x + NODE_W - 10}
              y={y + 29}
              textAnchor="end"
              fontSize="11"
              fontFamily="ui-monospace, monospace"
              fill={ACTOR_COLOR[state.actor]}
            >
              {ACTOR_TEXT[state.actor]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 一个动作节点（细粒度层）：序号 = 执行顺序（常量数组里的顺序，前置永远在它前面）。
 * 命令文字放 `<details>` 里（折起来默认不占地方），但 `data-command` 一直在 —— 验收/DOM 断言直接读它。
 */
function ActionRow({
  action,
  focus,
  onFocus,
}: {
  action: WorkflowActionNode;
  focus: WorkflowFocus | null;
  onFocus: (focus: WorkflowFocus) => void;
}) {
  const active = focus?.kind === "state" && action.toState !== null && focus.id === action.toState;
  return (
    <li
      data-testid={`wf-action-${action.id}`}
      data-action={action.id}
      data-actor={action.actor}
      data-command={action.command ?? ""}
      data-order={action.order}
      className={`rounded-lg border bg-background p-2 text-[11px] ${active ? "ring-2 ring-slate-900" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          #{action.order}
        </span>
        <span className="font-semibold">{action.title}</span>
        <ActorBadge actor={action.actor} size="xs" />
        <span className="font-mono text-[10px] text-muted-foreground">{action.id}</span>
        {action.command === null ? null : (
          <details className="ml-auto">
            <summary className="cursor-pointer select-none text-[10px] text-muted-foreground">命令</summary>
            <code className="mt-0.5 block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{action.command}</code>
          </details>
        )}
      </div>
      <dl className="mt-1 space-y-0.5 text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1">
          <dt>前置</dt>
          {action.needs.length === 0 ? (
            <dd className="rounded bg-muted px-1.5 py-0.5">无（流程入口）</dd>
          ) : (
            action.needs.map((need) => (
              <dd key={need.id} className="rounded border px-1.5 py-0.5">
                #{need.order} {need.title}
              </dd>
            ))
          )}
          {action.needsStates.length > 0 ? (
            <dd className="flex flex-wrap items-center gap-1">
              {action.needsStates.map((state) => (
                <span key={state} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {state}
                </span>
              ))}
            </dd>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <dt>产出</dt>
          <dd>{action.output}</dd>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <dt>证据</dt>
          {action.evidence.map((evidence) => (
            <dd key={`${evidence.kind}-${evidenceRef(evidence)}`} className="rounded border px-1.5 py-0.5 font-mono">
              {EVIDENCE_KIND_LABEL[evidence.kind]}·{evidenceRef(evidence)}
            </dd>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <dt>推进到</dt>
          <dd>
            {action.toState === null ? (
              <span className="rounded bg-muted px-1.5 py-0.5">不推状态</span>
            ) : (
              <button
                type="button"
                className="rounded border px-1.5 py-0.5 font-mono hover:bg-muted"
                onClick={() => onFocus({ kind: "state", id: action.toState ?? "" })}
                title="跳到流程图上这个状态"
              >
                {action.toState}
              </button>
            )}
          </dd>
          <dd>
            {action.toStage === null ? (
              <span className="rounded bg-muted px-1.5 py-0.5">不改列</span>
            ) : (
              <button
                type="button"
                className="rounded border px-1.5 py-0.5 font-mono hover:bg-muted"
                onClick={() => onFocus({ kind: "stage", id: action.toStage ?? "" })}
                title="跳到下面这一列的溯源卡片"
              >
                列 {action.toStage}
              </button>
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-1 text-[10px] text-muted-foreground">{action.actorWhy}</p>
    </li>
  );
}

function StageNode({
  stage,
  count,
  focus,
  onFocus,
  onOpenBoard,
}: {
  stage: Workflow["stages"][number];
  count: number;
  focus: WorkflowFocus | null;
  onFocus: (focus: WorkflowFocus) => void;
  onOpenBoard: (stage: Stage) => void;
}) {
  const active = focus?.kind === "stage" && focus.id === stage.id;
  return (
    <article
      id={`wf-stage-${stage.id}`}
      data-testid={`wf-stage-${stage.id}`}
      data-actor={stage.actor}
      className={`rounded-xl border bg-background p-3 ${active ? "ring-2 ring-slate-900" : ""}`}
    >
      <header className="flex items-center gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          判据 #{stage.priority}
        </span>
        <span className={`size-2 rounded-full ${STAGE_TONE[stage.id]}`} />
        <h3 className="text-xs font-semibold">{stage.label}</h3>
        <span className="font-mono text-[11px] text-muted-foreground">{stage.id}</span>
        <ActorBadge actor={stage.actor} />
        <button
          type="button"
          onClick={() => onOpenBoard(stage.id)}
          className="ml-auto rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
          title={`回看板看这一列（${count} 张卡）`}
        >
          {count} 张卡
        </button>
      </header>
      <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/80">{stage.when}</p>
      <dl className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
        <div className="flex flex-wrap items-center gap-1">
          <dt>事实来源</dt>
          {stage.facts.map((fact) => (
            <dd key={fact} className="rounded bg-muted px-1.5 py-0.5">
              {STAGE_FACT_LABELS[fact]}
            </dd>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <dt>落进这一列的动作</dt>
          <dd className="flex flex-wrap items-center gap-1">
            {stage.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => document.getElementById(`wf-action-${action.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
                className="rounded border px-1.5 py-0.5 hover:bg-muted"
                title="跳到动作节点那一行"
              >
                #{action.order} {action.title} · {action.actor}
              </button>
            ))}
          </dd>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <dt>读到的状态</dt>
          {stage.states.length === 0 ? (
            <dd className="rounded bg-muted px-1.5 py-0.5">不看状态（纯靠引用 / 实况推出）</dd>
          ) : (
            stage.states.map((state) => (
              <dd key={state}>
                <button
                  type="button"
                  onClick={() => onFocus({ kind: "state", id: state })}
                  className="rounded border px-1.5 py-0.5 font-mono hover:bg-muted"
                  title="跳到流程图上这个状态"
                >
                  {state}
                </button>
              </dd>
            ))
          )}
        </div>
      </dl>
    </article>
  );
}

export function WorkflowView({
  workflow,
  error,
  loading,
  cards,
  focus,
  onFocus,
  onOpenBoard,
  onRefresh,
}: {
  workflow: Workflow | null;
  error: string | null;
  loading: boolean;
  cards: CardView[];
  focus: WorkflowFocus | null;
  onFocus: (focus: WorkflowFocus) => void;
  onOpenBoard: (stage: Stage | null) => void;
  onRefresh: () => Promise<void>;
}) {
  useEffect(() => {
    if (!focus || !workflow) return;
    document.getElementById(`wf-${focus.kind}-${focus.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, workflow]);

  const counts = useMemo(() => countByStage(cards), [cards]);

  if (loading && !workflow) {
    return (
      <div className="p-6 text-xs text-muted-foreground" data-testid="workflow-view">
        正在读 GET /api/workflow …
      </div>
    );
  }
  if (!workflow) {
    return (
      <div className="p-6 text-xs text-red-700" data-testid="workflow-view">
        读不到流程数据：{error ?? "未知错误"}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4" data-testid="workflow-view">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <ListTree className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">流程（{workflow.flow.name}）</h2>
          </div>
          <p className="text-[11px] text-muted-foreground">
            本页内容由 <code className="font-mono">src/flow/personal.ts</code>（状态机：转换 / 硬前置 / 门禁 /
            自动节点 / <strong>动作节点</strong>）与 <code className="font-mono">src/shared/stage.ts</code>
            （看板 9 列的判据）<strong>编译而成</strong>，前端不手写流程。
          </p>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <ActorBadge actor="human" size="xs" />
            {ACTOR_HINT.human}
          </span>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <ActorBadge actor="llm" size="xs" />
            {ACTOR_HINT.llm}
          </span>
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <ActorBadge actor="command" size="xs" />
            {ACTOR_HINT.command}
          </span>
          <button
            type="button"
            className="ml-auto flex items-center gap-1 rounded border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
            onClick={() => void onRefresh()}
            data-testid="wf-refresh"
          >
            <RefreshCw className="size-3" />
            刷新
          </button>
        </header>

        <section data-testid="wf-flow" className="space-y-3 rounded-xl border bg-background p-3">
          <h3 className="text-xs font-semibold">一、流程主体：状态与转换</h3>
          <div className="overflow-x-auto">
            <WorkflowDiagram workflow={workflow} focus={focus} onFocus={onFocus} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            图上只画<strong>声明式</strong>转换（<code className="font-mono">requires</code> 的键）。没有进入边的状态：
            {workflow.flow.entranceFreeStates.map((state) => (
              <code key={state} className="mx-1 font-mono">
                {state}
              </code>
            ))}
            —— 建卡即 <code className="font-mono">ready</code>，
            <code className="font-mono">blocked</code> / <code className="font-mono">dropped</code>{" "}
            由命令直达（本表不声明）。
          </p>
          <ol className="space-y-2" data-testid="wf-transitions">
            {workflow.flow.transitions.map((transition) => (
              <li key={transition.id} className="rounded-lg border p-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="font-mono font-semibold hover:underline"
                    onClick={() => onFocus({ kind: "state", id: transition.to })}
                    title="跳到目标状态"
                  >
                    {transition.id}
                  </button>
                  <ActorBadge actor={transition.actor} size="xs" />
                  {transition.gates.map((gate) => (
                    <span key={gate.id} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                      门禁 {gate.id} {gate.title} · {gate.actor}
                    </span>
                  ))}
                  {transition.automations.map((auto) => (
                    <span key={auto.name} className="rounded border px-1.5 py-0.5 text-muted-foreground">
                      自动：{auto.name}（{auto.on}）· {auto.actor}
                    </span>
                  ))}
                </div>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {transition.requires.map((req) => (
                    <li key={req.id}>
                      <span className="font-mono">{req.id}</span>：{req.describe}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <div className="grid gap-3 md:grid-cols-2">
            <div data-testid="wf-automations">
              <h4 className="text-[11px] font-semibold">自动节点（事实驱动，缺前置只记 note）</h4>
              <ul className="mt-1 space-y-1 text-[11px]">
                {workflow.flow.automations.map((auto) => (
                  <li key={auto.name} className="flex flex-wrap items-center gap-1.5" data-actor={auto.actor}>
                    <code className="font-mono">{auto.name}</code>
                    <span className="text-muted-foreground">on {auto.on}</span>
                    <ActorBadge actor={auto.actor} size="xs" />
                    <span className="text-muted-foreground">
                      → {auto.setsState.length > 0 ? auto.setsState.join(" / ") : "只记 note"}
                      {auto.opensGates.length > 0 ? `，开门禁 ${auto.opensGates.join(" / ")}` : ""}
                      {`（触发状态：${auto.whenStates.join(" / ")}）`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div data-testid="wf-gates">
              <h4 className="text-[11px] font-semibold">门禁（人工节点）</h4>
              <ul className="mt-1 space-y-1 text-[11px]">
                {workflow.flow.gates.map((gate) => (
                  <li key={gate.id} className="flex flex-wrap items-center gap-1.5" data-actor={gate.actor}>
                    <code className="font-mono">
                      {gate.id} {gate.on}
                    </code>
                    <span>{gate.title}</span>
                    <ActorBadge actor={gate.actor} size="xs" />
                    {gate.report.length > 0 ? (
                      <span className="text-muted-foreground">报告项：{gate.report.join(" / ")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section data-testid="wf-actions" className="space-y-2 rounded-xl border bg-background p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold">二、动作节点（细粒度层，按执行顺序）</h3>
            <span className="text-[11px] text-muted-foreground">
              共 {workflow.flow.actions.length} 个节点（
              {(["human", "llm", "command"] as const)
                .map((actor) => `${actor} ${workflow.flow.actions.filter((a) => a.actor === actor).length}`)
                .join(" / ")}
              ）：把上面那七步状态机细到「具体动作 → 具体动作」。
              序号 = 执行顺序（常量数组顺序，前置永远在它前面）；命令折在「命令」里，点开就是 CLI 原文。
            </span>
          </div>
          <ol className="space-y-1.5" data-testid="wf-action-list">
            {workflow.flow.actions.map((action) => (
              <ActionRow key={action.id} action={action} focus={focus} onFocus={onFocus} />
            ))}
          </ol>
        </section>

        <section data-testid="wf-stages" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold">三、看板的 9 列：每列的溯源</h3>
            <span className="text-[11px] text-muted-foreground">
              顺序 = 判据匹配优先级（第一条命中即定列）；看板从左到右是显示顺序，两者不同。
            </span>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
              onClick={() => onOpenBoard(null)}
              data-testid="wf-open-board"
            >
              <ExternalLink className="size-3" />
              回看板
            </button>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            {workflow.stages.map((stage) => (
              <StageNode
                key={stage.id}
                stage={stage}
                count={counts[stage.id]}
                focus={focus}
                onFocus={onFocus}
                onOpenBoard={(id) => onOpenBoard(id)}
              />
            ))}
          </div>
        </section>
      </div>
      {error ? <p className="mt-3 text-[11px] text-red-700">{error}</p> : null}
    </div>
  );
}
