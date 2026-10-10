/**
 * 提示词模板的渲染器（`prompts/*.md`）。
 *
 * 背景（用户定的，2026-10）：提示词要能"直接改文件"，不要每次改文案都动代码。所以 kickoff 与
 * brief 的文案从 `brief.ts` 的模板字符串里搬进 `prompts/`，代码只负责**填值**。
 *
 * 三条设计约束：
 *   · **每次渲染都读文件**（几 KB，只在起会话/写 brief/发通知时发生）—— 改完文件即生效，不用重启服务；
 *   · **占位符严格**：模板里出现没给值的占位符就抛错（写错名字绝不静默变空串）；
 *   · **模板读不到就抛错**：不回退到内置文案 —— 两份真相必然分叉。启动时 `validatePrompts()`
 *     会先用样本值把所有模板渲一遍，坏模板当场拒启（见 `main.ts`），不等起会话才炸。
 *
 * 给了值但模板里没用上**不算错**：用户有权把模板改短。
 * 语法只有一条：`{{名字}}`（名字限字母/数字/下划线），没有第三方模板库、没有条件/循环 ——
 * 需要"选文案"的逻辑留在代码里（如 `checklist()`/`todos()` 拼好清单行再当值传进来）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 占位符里的名字：只认 `{{cardId}}` 这种，出现别的写法一律报错。 */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const VALID_NAME = /^[A-Za-z0-9_]+$/;

export type PromptVars = Record<string, string>;

/** 模板目录：默认仓库根的 `prompts/`（与 `skills/` 并列），`FLOWCARD_PROMPTS_DIR` 可覆盖。 */
export function promptsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOWCARD_PROMPTS_DIR;
  if (override !== undefined && override !== "") return override;
  return fileURLToPath(new URL("../../prompts", import.meta.url));
}

/** 读一份模板；读不到**不吞**（缺文件 = 提示词没来源，继续跑只会静默发出半截提示）。 */
function readTemplate(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${file}：提示词模板读不到（${why}）—— prompts/ 是提示词的唯一真相，缺失不静默回退到内置文案`,
    );
  }
}

/** `{{名字}}` → 值。没给值的占位符抛错，错误信息带文件名、占位符名与可用清单。 */
function fill(text: string, vars: PromptVars, file: string): string {
  const available = Object.keys(vars).sort().join("、") || "（无）";
  const out = text.replace(PLACEHOLDER, (whole: string, rawName: string): string => {
    const name = rawName.trim();
    if (!VALID_NAME.test(name)) {
      throw new Error(`${file}：占位符 ${whole} 写法不对（应为 {{字母数字下划线}}）`);
    }
    if (!Object.hasOwn(vars, name)) {
      throw new Error(`${file}：模板里的占位符 {{${name}}} 没有对应的值（可用：${available}）`);
    }
    return vars[name] ?? "";
  });
  // 没配成对的 `{{` / `}}` 也拦下来：手滑多打一个括号，留在提示里更难查。
  const stray = out.match(/\{\{|\}\}/);
  if (stray) {
    throw new Error(`${file}：有没配成对的 ${stray[0]}（占位符要写成 {{名字}}，可用：${available}）`);
  }
  return out;
}

/** 渲染模板 `dir/name`（默认 `prompts/`）。**每次都重新读文件** → 改完即生效。 */
export function renderPrompt(name: string, vars: PromptVars, dir: string = promptsDir()): string {
  const file = join(dir, name);
  return fill(readTemplate(file), vars, file);
}

/**
 * 校验用的样本值：**所有**已知占位符都给一份（模板没用到的允许）。
 * 启动时用它把所有模板渲一遍 —— 于是"模板里写了代码不认识的占位符"当场暴露。
 */
export const SAMPLE_VARS: PromptVars = {
  briefPath: "/data/briefs/sample.md",
  cardId: "c1",
  title: "示例标题",
  state: "待开工",
  body: "示例正文",
  paths: "- 项目根：`/repo`（demo，默认分支 main）",
  checklist: "| Issue | worktree | WIP PR | 推送 | 验收 | 清理 |\n|---|---|---|---|---|---|\n| 未绑 | 未绑 | 未绑 | 0 条 | 未验收 | 未清理 |",
  todos: "- [ ] 示例待办",
  cli: "flowcard",
};

/** 起会话一定要用到的模板：少一个，第一次开工就炸 —— 启动时就得拦住。 */
export const REQUIRED_TEMPLATES = ["kickoff.md", "brief.md"] as const;

/** README 是给人的说明，不是模板（不参与渲染与校验）。 */
const NOT_A_TEMPLATE = "readme.md";

/** `prompts/` 下所有模板文件名（`README.md` 除外），已排序。 */
export function listTemplates(dir: string = promptsDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${dir}：提示词模板目录读不到（${why}）`);
  }
  return names.filter((n) => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== NOT_A_TEMPLATE).sort();
}

/**
 * 启动校验：用样本值把 `prompts/` 下每个模板都渲一遍，坏模板/缺占位符/缺必模板**当场抛错**。
 * `main.ts` 据此拒绝启动（错误信息直接打给人看）；返回校验通过的模板名。
 */
export function validatePrompts(dir: string = promptsDir()): string[] {
  const templates = listTemplates(dir);
  for (const required of REQUIRED_TEMPLATES) {
    if (!templates.includes(required)) {
      throw new Error(
        `${join(dir, required)}：这个模板必须存在（${templates.join("、") || "目录里没有任何模板"}）—— 少了它起会话必炸`,
      );
    }
  }
  for (const name of templates) {
    const file = join(dir, name);
    fill(readTemplate(file), SAMPLE_VARS, file);
  }
  return templates;
}
