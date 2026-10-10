/** 提示词模板（`prompts/*.md`）：占位符严格、每次读文件、启动校验。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { briefKickoff, cardBrief } from "../src/server/brief.ts";
import { emptyCard } from "../src/server/project.ts";
import {
  DEFAULT_NOTICE_PREFIXES,
  listNoticeTemplates,
  listTemplates,
  promptsDir,
  readNoticePrefixes,
  renderPrompt,
  validatePrompts,
} from "../src/server/prompts.ts";

const dirs: string[] = [];

/** 新建一个临时模板目录并写入给定文件（`notices/x.md` 这种带子目录的名字也支持；测完自动删）。 */
function tmpPrompts(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-prompts-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** 仓库自带的 `prompts/` 逐字抄一份（含 README.md）。 */
function repoPrompts(): Record<string, string> {
  const dir = promptsDir();
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".md")) out[name] = readFileSync(join(dir, name), "utf8");
  }
  return out;
}

/** 跑一段本该抛错的代码，返回错误信息（没抛就是用例失败）。 */
function message(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("本该抛错，却跑通了");
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("提示词渲染器（renderPrompt）", () => {
  it("`{{名字}}` 换成值；多给的值没被模板用到也不算错", () => {
    const dir = tmpPrompts({ "x.md": "你好 {{name}}！\n" });
    expect(renderPrompt("x.md", { name: "世界", unused: "随便" }, dir)).toBe("你好 世界！\n");
  });

  it("模板里写了没给值的占位符 → 抛错，信息带文件名、占位符名与可用清单", () => {
    const dir = tmpPrompts({ "x.md": "要点：{{nope}}\n" });
    const msg = message(() => renderPrompt("x.md", { name: "世界", cli: "flowcard" }, dir));
    expect(msg).toContain("x.md");
    expect(msg).toContain("{{nope}}");
    expect(msg).toContain("cli");
    expect(msg).toContain("name");
  });

  it("模板读不到 → 抛错（不静默回退到内置文案）", () => {
    const dir = tmpPrompts({ "x.md": "hi\n" });
    const msg = message(() => renderPrompt("missing.md", {}, dir));
    expect(msg).toContain("missing.md");
    expect(msg).toContain("读不到");
  });

  it("括号没配成对也拦下来（别让半截占位符混进提示里）", () => {
    const dir = tmpPrompts({ "x.md": "名字：{{name\n" });
    expect(message(() => renderPrompt("x.md", { name: "a" }, dir))).toContain("{{");
  });

  it("每次渲染都重读文件：改完立刻生效（不重启、不缓存）", () => {
    const dir = tmpPrompts({ "x.md": "旧文案 {{name}}\n" });
    expect(renderPrompt("x.md", { name: "a" }, dir)).toBe("旧文案 a\n");
    writeFileSync(join(dir, "x.md"), "新文案 {{name}}！\n");
    expect(renderPrompt("x.md", { name: "a" }, dir)).toBe("新文案 a！\n");
  });
});

describe("启动校验（validatePrompts）", () => {
  it("仓库自带的 prompts/ 通过校验：两份会话模板 + notices/ 下的通知模板都在，默认目录就是仓库根的 prompts/", () => {
    expect(promptsDir().endsWith("/prompts")).toBe(true);
    expect(validatePrompts()).toEqual(["brief.md", "kickoff.md", ...listNoticeTemplates()]);
    // 通知模板确实被算进来了（`notices/*.md`，不含 README.md 与 prefixes.json）
    expect(listNoticeTemplates().length).toBeGreaterThanOrEqual(11);
    expect(listNoticeTemplates()).toContain("notices/ci-fail.md");
  });

  it("notices/ 里的坏模板同样当场抛错：点名文件与占位符（坏模板拒启也管通知）", () => {
    const dir = tmpPrompts({ ...repoPrompts(), "notices/ci-fail.md": "失败：{{nope}}\n" });
    const msg = message(() => validatePrompts(dir));
    expect(msg).toContain("notices/ci-fail.md");
    expect(msg).toContain("{{nope}}");
    expect(msg).toContain("cardId"); // 错误信息里带可用清单
  });

  it("notices/ 里只认 .md 模板：README.md 不是模板，prefixes.json 也不参与渲染", () => {
    const dir = tmpPrompts({
      ...repoPrompts(),
      "notices/README.md": "# 说明 {{随便写}}\n",
      "notices/prefixes.json": JSON.stringify(DEFAULT_NOTICE_PREFIXES),
      "notices/ci-pass.md": "PR #{{prNumber}} 绿了\n",
    });
    expect(listNoticeTemplates(dir)).toEqual(["notices/ci-pass.md"]);
    expect(validatePrompts(dir)).toEqual(["brief.md", "kickoff.md", "notices/ci-pass.md"]);
  });

  it("通知抬头配置（notices/prefixes.json）：缺文件用内置默认，文件在就按文件来", () => {
    const bare = tmpPrompts(repoPrompts());
    expect(readNoticePrefixes(bare)).toEqual(DEFAULT_NOTICE_PREFIXES);

    const dir = tmpPrompts({
      ...repoPrompts(),
      "notices/prefixes.json": JSON.stringify({ pending: "【未转达】", approvalPending: "【审批未转达】" }),
    });
    expect(readNoticePrefixes(dir)).toEqual({
      pending: "【未转达】",
      approvalPending: "【审批未转达】",
      renderFailed: DEFAULT_NOTICE_PREFIXES.renderFailed,
    });
  });

  it("抬头配置坏（不是合法 JSON / 值是空串）→ 启动校验抛错点名那个文件与键", () => {
    const bad = tmpPrompts({ ...repoPrompts(), "notices/prefixes.json": "{ 这不是 JSON" });
    expect(message(() => validatePrompts(bad))).toContain("prefixes.json");
    const empty = tmpPrompts({ ...repoPrompts(), "notices/prefixes.json": JSON.stringify({ pending: "" }) });
    const msg = message(() => validatePrompts(empty));
    expect(msg).toContain("prefixes.json");
    expect(msg).toContain("pending");
  });

  it("坏模板（多了个没给值的 {{nope}}）→ 当场抛错（服务据此拒启）", () => {
    const good = repoPrompts();
    const dir = tmpPrompts({ ...good, "brief.md": `${good["brief.md"] ?? ""}\n{{nope}}\n` });
    const msg = message(() => validatePrompts(dir));
    expect(msg).toContain("brief.md");
    expect(msg).toContain("{{nope}}");
  });

  it("缺必模板（这里删掉 brief.md）→ 抛错点名缺哪个", () => {
    const good = repoPrompts();
    const dir = tmpPrompts({ "kickoff.md": good["kickoff.md"] ?? "" });
    const msg = message(() => validatePrompts(dir));
    expect(msg).toContain("brief.md");
    expect(msg).toContain("必须存在");
  });

  it("README.md 不是模板（不参与渲染与校验）", () => {
    const dir = tmpPrompts({ ...repoPrompts(), "README.md": "# 说明 {{随便写}}\n" });
    expect(listTemplates(dir)).toEqual(["brief.md", "kickoff.md"]);
    expect(validatePrompts(dir)).toEqual(["brief.md", "kickoff.md"]);
  });

  it("模板目录都不在 → 报错说清是哪个目录读不到", () => {
    const gone = join(tmpdir(), "fc-prompts-not-here");
    expect(message(() => validatePrompts(gone))).toContain(gone);
  });
});

describe("改文件即生效（brief.ts 走模板）", () => {
  it("`FLOWCARD_PROMPTS_DIR` 指到改过的模板：briefKickoff / cardBrief 立刻用新文案", () => {
    const dir = tmpPrompts(repoPrompts());
    vi.stubEnv("FLOWCARD_PROMPTS_DIR", dir);
    const card = { ...emptyCard("c7", "2026-10-10T00:00:00.000Z"), title: "修一个 bug", body: "现象：点开会卡住" };

    // 起手就是仓库里那份（逐字；这条也是「默认目录能读到真模板」的回归网）
    expect(briefKickoff("/data/briefs/c7.md")).toBe(
      "开工：第一步先 read `/data/briefs/c7.md`，按里面「☑︎ 接下来你要做的」逐步执行，每步用 `flowcard comment` 留痕。",
    );
    expect(cardBrief({ card })).toContain("## 六项交付要件");

    // 改 kickoff.md 的文案：下一句 kickoff 立刻变（现读现渲染）
    writeFileSync(join(dir, "kickoff.md"), "先 read `{{briefPath}}` 再动手（{{cli}} 留痕）。");
    expect(briefKickoff("/data/briefs/c7.md")).toBe("先 read `/data/briefs/c7.md` 再动手（flowcard 留痕）。");

    // 换掉 brief.md 的骨架：cardBrief 跟着变，而清单行仍由代码拼好塞进 {{todos}}
    writeFileSync(join(dir, "brief.md"), "卡 {{cardId}}｜{{title}}｜{{state}}\n\n{{todos}}\n");
    const text = cardBrief({ card });
    expect(text).toContain("卡 c7｜修一个 bug｜待开工");
    expect(text).toContain("- [ ] 绑上对应的 Issue");
  });
});
