/**
 * 提示词模板的渲染器（`prompts/*.md` + `prompts/notices/*.md`）。
 *
 * 背景（用户定的，2026-10）：提示词要能"直接改文件"，不要每次改文案都动代码。所以 kickoff 与
 * brief 的文案从 `brief.ts` 的模板字符串里搬进 `prompts/`，通知文案从 `notify-hooks.ts` 的
 * 模板字符串里搬进 `prompts/notices/`（`prefixes.json` 放降级评论的抬头），代码只负责**填值**。
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
  // —— 通知模板（`prompts/notices/*.md`）的占位符：每一类都要有样本值，否则启动校验会把它当"没给值"。
  what: "cf1（将执行：git push origin feat/x）",
  confirmId: "cf1",
  action: "push",
  gateName: "G4 清理确认",
  next: "下一步：示例下一步",
  reason: "理由：示例理由",
  prNumber: "77",
  sha: "（commit aaa111222333）",
  jobs: "失败 job：build（http://ci/build/1）",
  link: "链接：https://forge.example.com/pull/77",
  who: "lhk229",
  where: "Issue #42",
  summary: "示例评论摘要",
};

/** 起会话一定要用到的模板：少一个，第一次开工就炸 —— 启动时就得拦住。 */
export const REQUIRED_TEMPLATES = ["kickoff.md", "brief.md"] as const;

/** 通知模板的子目录（`prompts/notices/`）—— 与 kickoff/brief 走**同一套**渲染与校验规则。 */
export const NOTICES_SUBDIR = "notices";

/** README 是给人的说明，不是模板（不参与渲染与校验）。 */
const NOT_A_TEMPLATE = "readme.md";

/** `prompts/` **顶层**的模板文件名，已排序（子目录见 `listNoticeTemplates`）。 */
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

/** `prompts/notices/` 下的通知模板，名字相对 `prompts/`（如 `notices/ci-pass.md`），已排序。 */
export function listNoticeTemplates(dir: string = promptsDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, NOTICES_SUBDIR));
  } catch {
    // 没有 `notices/` 目录 = 没有通知模板（不是错；通知那几条会在运行时按"渲染失败"留痕）。
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== NOT_A_TEMPLATE)
    .map((name) => `${NOTICES_SUBDIR}/${name}`)
    .sort();
}

/** 通知抬头（`prompts/notices/prefixes.json`）：降级评论与"渲染失败"评论的第一句前缀。 */
export type NoticePrefixes = { pending: string; approvalPending: string; renderFailed: string };

/** 抬头文件缺失/读不到时用的内置默认（与 `notify-hooks.ts` 导出的常量同值）。 */
export const DEFAULT_NOTICE_PREFIXES: NoticePrefixes = {
  pending: "【通知·待转达】",
  approvalPending: "【审批通知·待转达】",
  renderFailed: "【通知·渲染失败】",
};

const PREFIXES_FILE = `${NOTICES_SUBDIR}/prefixes.json`;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 读通知抬头的配置。三种情形分开处理：
 *   · 文件**不在**（ENOENT）→ 用内置默认：抬头只是"给人看的装饰"，不为它把整类通知弄坏；
 *   · 文件**在**但坏（JSON 解析不了 / 缺键 / 值是空串）→ **抛错**（启动校验据此拒启，改坏当场发现）；
 *   · 其它读文件错误（权限等）→ 抛错（不是"用户改文案"，别静默）。
 */
export function readNoticePrefixes(dir: string = promptsDir()): NoticePrefixes {
  const file = join(dir, PREFIXES_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return DEFAULT_NOTICE_PREFIXES;
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}：通知抬头配置读不到（${why}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}：通知抬头配置不是合法 JSON（${why}）`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file}：通知抬头配置应该是一个对象，形如 ${JSON.stringify(DEFAULT_NOTICE_PREFIXES)}`);
  }
  const record = parsed as Record<string, unknown>;
  const out = { ...DEFAULT_NOTICE_PREFIXES };
  for (const key of Object.keys(out) as (keyof NoticePrefixes)[]) {
    const value = record[key];
    if (value === undefined) continue; // 少写一个键 → 那个抬头用默认（不因为少写一行把通知弄坏）
    if (!nonEmptyString(value)) {
      throw new Error(`${file}：${key} 必须是非空字符串（可用键：${Object.keys(out).join("、")}）`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * 启动校验：用样本值把 `prompts/` 下每个模板（**含 `notices/` 子目录**）都渲一遍，
 * 坏模板/缺占位符/缺必模板/坏抬头配置**当场抛错**。`main.ts` 据此拒绝启动（错误信息直接打给人看）；
 * 返回校验通过的模板名（相对 `prompts/`，如 `notices/ci-pass.md`）。
 *
 * 通知模板（`notices/*.md`）**不硬性要求存在** —— 少一个，那一类通知会在运行时渲染失败并按
 * "warn + 卡片评论留痕"处理（不静默）；但只要它在，写错占位符就跟 kickoff/brief 一样拒启。
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
  const notices = listNoticeTemplates(dir);
  for (const name of [...templates, ...notices]) {
    const file = join(dir, name);
    fill(readTemplate(file), SAMPLE_VARS, file);
  }
  readNoticePrefixes(dir);
  return [...templates, ...notices];
}
