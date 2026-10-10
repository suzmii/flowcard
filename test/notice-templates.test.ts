/**
 * 通知文案模板（`prompts/notices/*.md`）：与 kickoff/brief **同一套**渲染与校验规则，只是文案在
 * 文件里。这里守住三件事：
 *
 *   1. **改文件即生效**：改 `prompts/notices/*.md` 之后，下一次通知就用新文案（不重启服务）；
 *   2. **坏模板不静默**：模板坏 / 缺文件 → 那条通知**不投**，但会 `warn` 一句 + 在卡片上留一条评论；
 *   3. **抬头可配置**：降级评论的 `【通知·待转达】` 在 `prompts/notices/prefixes.json` 里（坏了好用默认）。
 *
 * 全程离线：假投递 / 假台账，不联网、不起会话。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_PENDING_PREFIX,
  approvalNotice,
  createNotifyHooks,
  type ApprovalSpec,
  type NotifyCandidate,
  type NotifyHooks,
} from "../src/server/notify-hooks.ts";
import { emptyCard, type NewEvent } from "../src/server/project.ts";
import { DEFAULT_NOTICE_PREFIXES, promptsDir } from "../src/server/prompts.ts";
import type { ApprovalLedger } from "../src/server/store.ts";
import type { Card, Command, Gate, PrRef } from "../src/shared/types.ts";

const AT = "2026-10-10T00:00:00.000Z";
const HUMAN = { kind: "human" as const, name: "you" };

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fc-notices-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

/** 仓库自带的 `prompts/notices/` 逐字抄一份（含 README.md 与 prefixes.json）。 */
function repoNotices(): Record<string, string> {
  const dir = join(promptsDir(), "notices");
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) out[`notices/${name}`] = readFileSync(join(dir, name), "utf8");
  return out;
}

const gate = (id: string, kind: Gate["kind"], title: string): Record<string, Gate> => ({
  [id]: { id, kind, title, status: "open", requestedAt: AT },
});

const cardWith = (over: Partial<Card> = {}): Card => ({ ...emptyCard("c7", AT), ...over });

const pr: PrRef = { repo: "Team/Repo", number: 77, url: "https://forge.example.com/pull/77", branch: "feat/x", state: "open" };

const comment = (id: number): NotifyCandidate => ({
  kind: "comment",
  cardId: "c7",
  comment: { id, number: 42, author: "lhk229", body: "接口改一下", at: AT, url: "https://forge.example.com/issues/42#issuecomment-1" },
});

const ciFail: NotifyCandidate = {
  kind: "ci",
  cardId: "c7",
  pr: { number: 77, sha: "aaa111222333", conclusion: "fail", url: "https://forge.example.com/pull/77" },
  jobs: [{ name: "build", conclusion: "fail", url: "http://ci/build/1" }],
};

const ciPass: NotifyCandidate = {
  kind: "ci",
  cardId: "c7",
  pr: { number: 77, sha: "aaa111222333", conclusion: "pass", url: "https://forge.example.com/pull/77" },
  jobs: [],
};

/** 假投递 + 假台账 + 真模板：够跑 hook 的三条路（审批 / CI / 评论）。 */
type Harness = {
  hooks: NotifyHooks;
  ledger: ApprovalLedger;
  prompts: string[];
  comments: string[];
  warnings: string[];
};

function makeHooks(dir: string, opts: { live?: boolean; card?: Card } = {}): Harness {
  const h: Harness = { ledger: { delivered: [], pending: [] }, prompts: [], comments: [], warnings: [], hooks: undefined! };
  h.hooks = createNotifyHooks({
    enabled: true,
    getCard: () => opts.card ?? cardWith(),
    isLive: () => opts.live ?? false,
    prompt: async (_cardId, text) => {
      h.prompts.push(text);
      return { ok: true };
    },
    comment: (_cardId, body) => {
      h.comments.push(body);
    },
    ledger: { get: () => h.ledger, set: (_cardId, next) => { h.ledger = next; } },
    warn: (message) => {
      h.warnings.push(message);
    },
    promptsDir: dir,
  });
  return h;
}

/** 人的一次 `accept`（含真落库的那条事件）—— 审批通知的最短输入。 */
function acceptInput(card: Card): { cmd: Command; card: Card; events: NewEvent[] } {
  const cmd: Command = { cmd: "accept", actor: HUMAN, card: card.id };
  const events: NewEvent[] = [
    { at: AT, actor: HUMAN, cardId: card.id, type: "card.accepted", payload: {}, dedupeKey: "k1" },
  ];
  return { cmd, card, events };
}

describe("改文件即生效（文案在 prompts/notices/ 里）", () => {
  it("改 comment.md → 同一条 hook 的下一条通知就用新文案（不重启服务）", async () => {
    const dir = tempDir(repoNotices());
    const h = makeHooks(dir, { live: true });

    h.hooks.onSync([comment(1)]);
    await h.hooks.settle();
    expect(h.prompts[0]).toContain("lhk229 在Issue #42上留言了");
    expect(h.prompts[0]).toContain("接口改一下");

    // 只改文件（服务"没重启"：还是同一个 hook 实例），下一条通知立刻换文案
    writeFileSync(join(dir, "notices/comment.md"), "【flowcard 通知】{{who}} 在 {{where}} 说了话：{{summary}}\n");
    h.hooks.onSync([comment(2)]);
    await h.hooks.settle();
    expect(h.prompts[1]).toBe("【flowcard 通知】lhk229 在 Issue #42 说了话：接口改一下");
  });

  it("纯函数也现读文件：`FLOWCARD_PROMPTS_DIR` 指到改过的 notices，approvalNotice 立刻用新文案", () => {
    const dir = tempDir(repoNotices());
    vi.stubEnv("FLOWCARD_PROMPTS_DIR", dir);
    const card = cardWith({ gates: gate("G3", "review", "验收") });
    const spec: ApprovalSpec = {
      key: "k",
      cardId: "c7",
      decision: "approved",
      pendingPrefix: APPROVAL_PENDING_PREFIX,
      gate: { id: "G3" },
    };

    expect(approvalNotice(spec, card)).toBe(
      "【flowcard 审批通知】人已验收（G3 验收 通过）。\n下一步：卡片现在是「待开工」，按它继续往前推。",
    );
    writeFileSync(join(dir, "notices/accept.md"), "验收过了（{{gateName}}）。\n{{next}}\n");
    expect(approvalNotice(spec, card)).toBe("验收过了（G3 验收）。\n下一步：卡片现在是「待开工」，按它继续往前推。");
  });
});

describe("渲染失败不静默：warn + 卡片评论留痕", () => {
  it("模板里写了 {{nope}} → 那条通知不投，但 warn 点名文件与占位符，并在卡上留一条评论", async () => {
    const dir = tempDir({ ...repoNotices(), "notices/ci-fail.md": "失败：{{nope}}\n" });
    const h = makeHooks(dir, { live: true });

    h.hooks.onSync([ciFail]);
    await h.hooks.settle();

    expect(h.prompts).toEqual([]);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("notices/ci-fail.md");
    expect(h.warnings[0]).toContain("{{nope}}");
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.startsWith(DEFAULT_NOTICE_PREFIXES.renderFailed)).toBe(true);
    expect(h.comments[0]).toContain("{{nope}}");
    // 渲染失败的通知不进台账（不拿半截文案去补投）
    expect(h.ledger).toEqual({ delivered: [], pending: [] });
  });

  it("模板文件被删（读不到）→ 同样 warn + 留痕，不静默丢", async () => {
    const files = repoNotices();
    delete files["notices/ci-pass.md"];
    const h = makeHooks(tempDir(files), { live: true });

    h.hooks.onSync([ciPass]);
    await h.hooks.settle();

    expect(h.prompts).toEqual([]);
    expect(h.warnings[0]).toContain("notices/ci-pass.md");
    expect(h.warnings[0]).toContain("读不到");
    expect(h.comments[0]?.startsWith(DEFAULT_NOTICE_PREFIXES.renderFailed)).toBe(true);
  });

  it("审批通知走同一条路：模板坏了也 warn + 留痕（决定本身照常落库，只是没通知出去）", async () => {
    const dir = tempDir({ ...repoNotices(), "notices/accept-reject.md": "驳回验收 {{nope}}\n" });
    const card = cardWith({ gates: gate("G3", "review", "验收") });
    const h = makeHooks(dir, { live: true, card });
    const events: NewEvent[] = [
      {
        at: AT,
        actor: HUMAN,
        cardId: card.id,
        type: "gate.decided",
        payload: { gate: "G3", decision: "rejected" },
        dedupeKey: "k1",
      },
    ];

    h.hooks.onCommand({
      cmd: { cmd: "decideGate", actor: HUMAN, card: card.id, gate: "G3", decision: "rejected" },
      card,
      events,
    });
    await h.hooks.settle();

    expect(h.prompts).toEqual([]);
    expect(h.warnings[0]).toContain("notices/accept-reject.md");
    expect(h.warnings[0]).toContain("审批通知");
    expect(h.comments[0]?.startsWith(DEFAULT_NOTICE_PREFIXES.renderFailed)).toBe(true);
  });
});

describe("抬头可配置（notices/prefixes.json）", () => {
  it("降级评论的抬头按配置来：待转达一类与审批一类各用各的", async () => {
    const dir = tempDir({
      ...repoNotices(),
      "notices/prefixes.json": JSON.stringify({ pending: "【未转达】", approvalPending: "【审批未转达】" }),
    });
    const h = makeHooks(dir, { live: false });

    h.hooks.onSync([comment(1)]);
    await h.hooks.settle();
    expect(h.comments[0]?.startsWith("【未转达】")).toBe(true);

    h.hooks.onCommand(acceptInput(cardWith()));
    await h.hooks.settle();
    expect(h.comments[1]?.startsWith("【审批未转达】")).toBe(true);
    // 内置默认常量没被改（还是那个字符串）
    expect(APPROVAL_PENDING_PREFIX).toBe("【审批通知·待转达】");
  });

  it("抬头配置坏 → 只 warn + 用内置默认，通知照发（不因为一个装饰性文件全卡住）", async () => {
    const dir = tempDir({ ...repoNotices(), "notices/prefixes.json": "{ 这不是 JSON" });
    const h = makeHooks(dir, { live: false });

    h.hooks.onSync([comment(1)]);
    await h.hooks.settle();

    expect(h.comments[0]?.startsWith(DEFAULT_NOTICE_PREFIXES.pending)).toBe(true);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain("prefixes.json");
  });
});

describe("仓库自带模板：渲染出的文案（回归网）", () => {
  it("评论通知逐字：谁 / 在哪 / 链接 / 摘要 / 下一步", async () => {
    const h = makeHooks(tempDir(repoNotices()), { live: true });
    h.hooks.onSync([comment(1)]);
    await h.hooks.settle();
    expect(h.prompts[0]).toBe(
      [
        "【flowcard 通知】lhk229 在Issue #42上留言了。",
        "链接：https://forge.example.com/issues/42#issuecomment-1",
        "正文（摘要）：接口改一下",
        '下一步：读一遍再决定要不要回 —— 要回就在远端评论（或 `flowcard comment c7 --body "…"` 记一句本地说明）。',
      ].join("\n"),
    );
  });

  it("CI 失败逐字：结论 / 失败 job（名字 + 链接）/ 下一步 / 链接", async () => {
    const h = makeHooks(tempDir(repoNotices()), { live: true });
    h.hooks.onSync([ciFail]);
    await h.hooks.settle();
    expect(h.prompts[0]).toBe(
      [
        "【flowcard 通知】CI 结束了：PR #77 的 CI **失败**（fail）（commit aaa111222333）。",
        "失败 job：build（http://ci/build/1）",
        "下一步：看一眼失败日志；改完推上去 CI 会重跑。",
        "链接：https://forge.example.com/pull/77",
      ].join("\n"),
    );
  });

  it("验收通过逐字：决定 / 下一步（按卡片状态给，PR 已合并 → 去提清理清单）", async () => {
    const h = makeHooks(tempDir(repoNotices()), { live: true });
    h.hooks.onCommand(acceptInput(cardWith({ state: "merged", acceptedAt: AT, pr })));
    await h.hooks.settle();
    expect(h.prompts[0]).toBe(
      [
        "【flowcard 审批通知】人已验收（G3 验收 通过）。",
        "下一步：先提清理清单 —— `flowcard cleanup c7 --item \"要删的东西\"`，等人批准 G4 后执行 `flowcard cleanup c7`。",
      ].join("\n"),
    );
  });
});
