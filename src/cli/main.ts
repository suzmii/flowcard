/**
 * flowcard CLI：agent 的唯一写入口。
 * 契约：stdout 永远是一行 JSON；退出码 0 成功 / 2 用法 / 3 状态不允许 / 4 缺必要条件 / 5 服务不可达。
 */
import { parseArgs } from "node:util";
import { CONFIRM_ACTIONS, type Actor, type Command, type ConfirmAction } from "../shared/types.ts";

const DEFAULT_URL = process.env.FLOWCARD_URL ?? `http://127.0.0.1:${process.env.FLOWCARD_PORT ?? "47825"}`;

type Options = Record<string, string | boolean | string[] | undefined>;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" },
    body: { type: "string" },
    issue: { type: "string" },
    url: { type: "string" },
    repo: { type: "string" },
    "repo-path": { type: "string" },
    state: { type: "string" },
    ci: { type: "string" },
    number: { type: "string" },
    gate: { type: "string" },
    approve: { type: "boolean" },
    reject: { type: "boolean" },
    request: { type: "boolean" },
    consume: { type: "boolean" },
    list: { type: "boolean" },
    "for": { type: "string" },
    detail: { type: "string" },
    id: { type: "string" },
    reason: { type: "string" },
    path: { type: "string" },
    branch: { type: "string" },
    source: { type: "string" },
    harness: { type: "string" },
    session: { type: "string" },
    cwd: { type: "string" },
    file: { type: "string" },
    resume: { type: "string" },
    sha: { type: "string" },
    summary: { type: "string" },
    item: { type: "string", multiple: true },
    as: { type: "string" },
    "session-id": { type: "string" },
    url_base: { type: "string" },
  },
});

function die(code: number, message: string): never {
  process.stdout.write(`${JSON.stringify({ ok: false, rejection: { code: "USAGE_ERROR", message } })}\n`);
  process.exit(code);
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const opt = (name: string): string | undefined => str((values as Options)[name]);

function actor(): Actor {
  const harness = opt("harness");
  const sessionId = opt("session-id") ?? opt("session");
  if (harness) {
    return { kind: "agent", harness, ...(sessionId ? { sessionId } : {}) };
  }
  return { kind: "human", name: opt("as") ?? process.env.USER ?? "human" };
}

function requireCard(): string {
  const card = positionals[1];
  if (!card) die(2, `缺少卡片 id：flowcard ${positionals[0] ?? "<命令>"} <card> …`);
  return card;
}

/** 解析 `--issue repo#123`。 */
function parseIssueSpec(spec: string, url: string | undefined): { repo: string; number: number; url: string } {
  const [repo, numRaw] = spec.split("#");
  const number = Number(numRaw);
  if (!repo || !Number.isInteger(number) || number <= 0) {
    die(2, `--issue 需要形如 <repo>#<数字>，收到 "${spec}"`);
  }
  return { repo, number, url: url ?? `issue://${repo}#${number}` };
}

function build(): Command {
  const name = positionals[0];
  switch (name) {
    case "open":
      return {
        cmd: "open",
        actor: actor(),
        title: opt("title") ?? die(2, "open 需要 --title"),
        body: opt("body") ?? "",
        ...(opt("repo-path") ? { repoPath: opt("repo-path")! } : {}),
        ...(opt("issue") ? { issue: { ...parseIssueSpec(opt("issue")!, opt("url")), state: "open" as const } } : {}),
        ...(opt("part-of") ? { partOf: opt("part-of")! } : {}),
      };
    case "issue": {
      const card = requireCard();
      const spec = opt("issue") ?? die(2, "issue 需要 --issue <repo>#<n>");
      return {
        cmd: "bindIssue",
        actor: actor(),
        card,
        issue: { ...parseIssueSpec(spec, opt("url")), state: "open" },
      };
    }
    case "plan":
      return {
        cmd: "plan",
        actor: actor(),
        card: requireCard(),
        body: opt("body") ?? die(2, "plan 需要 --body"),
      };
    case "gate": {
      const card = requireCard();
      const gate = opt("gate") ?? die(2, "gate 需要 --gate <id>");
      const approved = values.approve === true;
      const rejected = values.reject === true;
      if (approved === rejected) die(2, "gate 需要 --approve 或 --reject 之一");
      return {
        cmd: "decideGate",
        actor: actor(),
        card,
        gate,
        decision: approved ? "approved" : "rejected",
        ...(opt("reason") ? { reason: opt("reason")! } : {}),
      };
    }
    case "worktree":
      return {
        cmd: "worktree",
        actor: actor(),
        card: requireCard(),
        worktree: {
          path: opt("path") ?? die(2, "worktree 需要 --path"),
          branch: opt("branch") ?? die(2, "worktree 需要 --branch"),
          source: (opt("source") as "harness" | "flowcard" | undefined) ?? "harness",
        },
      };
    case "claim":
      return {
        cmd: "claim",
        actor: actor(),
        card: requireCard(),
        session: {
          harness: opt("harness") ?? die(2, "claim 需要 --harness"),
          id: opt("session") ?? die(2, "claim 需要 --session <id>"),
          cwd: opt("cwd") ?? die(2, "claim 需要 --cwd（会话的工作目录，用来校验是否在 worktree 里）"),
          agentKind: (opt("kind") as "main" | "sub" | undefined) ?? "main",
          ...(opt("file") ? { file: opt("file")! } : {}),
          ...(opt("resume") ? { resumeHint: opt("resume")! } : {}),
        },
      };
    case "beat":
      return {
        cmd: "beat",
        actor: actor(),
        card: requireCard(),
        session: {
          harness: opt("harness") ?? "omp",
          id: opt("session") ?? die(2, "beat 需要 --session <id>"),
          cwd: opt("cwd") ?? process.cwd(),
          agentKind: (opt("kind") as "main" | "sub" | undefined) ?? "main",
        },
      };
    case "pr":
      return {
        cmd: "bindPr",
        actor: actor(),
        card: requireCard(),
        pr: {
          repo: opt("repo") ?? "repo",
          number: Number(opt("number") ?? die(2, "pr 需要 --number")),
          url: opt("url") ?? die(2, "pr 需要 --url"),
          branch: opt("branch") ?? die(2, "pr 需要 --branch"),
          state: (opt("state") as "draft" | "open" | "merged" | "closed" | undefined) ?? "open",
          ...(opt("ci") ? { ci: opt("ci") as "pending" | "pass" | "fail" } : {}),
        },
      };
    case "push":
      return { cmd: "push", actor: actor(), card: requireCard(), sha: opt("sha") ?? die(2, "push 需要 --sha") };
    /**
     * G2 远程写确认。一次授权只覆盖一次动作：
     *   申请 → 批准 → 执行 → consume；下一次写要重新申请。
     * 确认 id 可以写成位置参数（--approve cf1）或用 --id cf1。
     */
    case "confirm": {
      const card = requireCard();
      const request = values.request === true;
      const consume = values.consume === true;
      const approved = values.approve === true;
      const rejected = values.reject === true;
      const picked = [request, consume, approved, rejected].filter(Boolean).length;
      if (picked === 0) {
        die(2, "confirm 需要动作标志：--request / --approve <id> / --reject <id> / --consume <id>");
      }
      if (picked > 1) die(2, "confirm 一次只做一件事：--request / --approve / --reject / --consume 选一个");

      if (request) {
        const action = opt("for") ?? die(2, "confirm --request 需要 --for <push|openPr|commentRemote|merge|other>");
        if (!(CONFIRM_ACTIONS as readonly string[]).includes(action)) {
          die(2, `--for 只能是 ${CONFIRM_ACTIONS.join(" / ")}，收到 "${action}"`);
        }
        return {
          cmd: "requestConfirm",
          actor: actor(),
          card,
          action: action as ConfirmAction,
          detail:
            opt("detail") ?? die(2, 'confirm --request 需要 --detail "<将执行的确切命令或 URL>"'),
        };
      }

      const id = opt("id") ?? positionals[2];
      if (!id) die(2, `confirm ${approved ? "--approve" : rejected ? "--reject" : "--consume"} 需要确认 id（形如 cf1）`);
      if (approved || rejected) {
        return {
          cmd: "decideConfirm",
          actor: actor(),
          card,
          id,
          decision: approved ? "approved" : "rejected",
          ...(opt("reason") ? { reason: opt("reason")! } : {}),
        };
      }
      return { cmd: "consumeConfirm", actor: actor(), card, id };
    }
    case "end":
      return {
        cmd: "end",
        actor: actor(),
        card: requireCard(),
        ...(opt("session") ? { sessionId: opt("session")! } : {}),
        ...(opt("summary") ? { summary: opt("summary")! } : {}),
      };
    case "accept":
      return {
        cmd: "accept",
        actor: actor(),
        card: requireCard(),
        ...(opt("reason") ? { reason: opt("reason")! } : {}),
      };
    case "block":
      return {
        cmd: "block",
        actor: actor(),
        card: requireCard(),
        reason: opt("reason") ?? die(2, "block 需要 --reason"),
      };
    case "unblock":
      return { cmd: "unblock", actor: actor(), card: requireCard() };
    case "probe":
      return {
        cmd: "probePr",
        actor: { kind: "system" },
        card: requireCard(),
        pr: {
          repo: opt("repo") ?? "repo",
          number: Number(opt("number") ?? die(2, "probe 需要 --number")),
          url: opt("url") ?? die(2, "probe 需要 --url"),
          branch: opt("branch") ?? "unknown",
          state: (opt("state") as "draft" | "open" | "merged" | "closed" | undefined) ?? "open",
        },
      };
    case "cleanup": {
      const card = requireCard();
      const raw = Array.isArray(values.item) ? values.item : [];
      const items = raw.filter((x): x is string => typeof x === "string");
      if (items.length > 0) {
        return { cmd: "proposeCleanup", actor: actor(), card, items };
      }
      return { cmd: "cleanup", actor: actor(), card };
    }
    case "comment":
      return {
        cmd: "comment",
        actor: actor(),
        card: requireCard(),
        body: opt("body") ?? die(2, "comment 需要 --body"),
      };
    case "spawn":
      return {
        cmd: "spawn",
        actor: actor(),
        card: requireCard(),
        title: opt("title") ?? die(2, "spawn 需要 --title"),
        body: opt("body") ?? "",
      };
    default:
      return die(2, `未知命令 "${name ?? ""}"。可用：open issue plan gate confirm worktree claim beat pr push end accept block unblock probe cleanup comment spawn up down detect list show`);
  }
}

async function main(): Promise<void> {
  const name = positionals[0];

  if (!name || name === "help" || name === "--help") {
    process.stdout.write(`${JSON.stringify({ usage: "flowcard <命令> <card> [选项…]；命令：open issue plan gate confirm worktree claim beat pr push end accept block unblock probe cleanup comment spawn up down detect list show" })}\n`);
    process.exit(0);
  }

  if (name === "detect") {
    // 探测是只读 + 回写，与"用户命令"性质不同，实现在 detect.ts，这里只做转发。
    const { runDetect } = await import("./detect.ts");
    await runDetect(process.argv.slice(3));
  }

  if (name === "list") {
    const res = await fetch(`${DEFAULT_URL}/api/cards`);
    const data = (await res.json()) as unknown;
    process.stdout.write(`${JSON.stringify(data)}\n`);
    process.exit(0);
  }
  if (name === "show") {
    const res = await fetch(`${DEFAULT_URL}/api/cards/${requireCard()}`);
    process.stdout.write(`${JSON.stringify(await res.json())}\n`);
    process.exit(res.ok ? 0 : 3);
  }

  // 「列确认」是读（不改状态）：没给动作标志（或显式 --list）就列出这张卡的所有确认。
  if (name === "confirm") {
    const acting =
      values.request === true ||
      values.consume === true ||
      values.approve === true ||
      values.reject === true;
    if (acting && values.list === true) {
      die(2, "confirm 的 --list 不能和 --request / --approve / --reject / --consume 一起用");
    }
    if (!acting) {
      const card = requireCard();
      const res = await fetch(`${DEFAULT_URL}/api/cards/${encodeURIComponent(card)}`);
      const data = (await res.json().catch(() => null)) as { card?: { confirmations?: unknown } } | null;
      if (!res.ok || !data?.card) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, rejection: { code: "NOT_FOUND", message: `卡片 ${card} 不存在` } })}\n`,
        );
        process.exit(3);
      }
      process.stdout.write(
        `${JSON.stringify({ ok: true, card, confirmations: data.card.confirmations ?? [] })}\n`,
      );
      process.exit(0);
    }
  }

  // 启动/停止卡片运行时：不是命令（引擎不碰进程），直接打运行时端点。
  if (name === "up" || name === "down") {
    const card = requireCard();
    const url = `${DEFAULT_URL}/api/cards/${encodeURIComponent(card)}/runtime`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: name }),
      });
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, rejection: { code: "UNREACHABLE", message: `连不上 ${DEFAULT_URL}：${String(error)}` } })}\n`,
      );
      process.exit(5);
    }
    const payload = (await res.json()) as { ok?: boolean; error?: { code?: string } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (!res.ok || payload.ok === false) {
      process.exit(payload.error?.code === "USAGE_ERROR" ? 2 : 3);
    }
    process.exit(0);
  }

  const command = build();
  let res: Response;
  try {
    res = await fetch(`${DEFAULT_URL}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, rejection: { code: "UNREACHABLE", message: `连不上 ${DEFAULT_URL}：${String(error)}` } })}\n`,
    );
    process.exit(5);
  }

  const payload = (await res.json()) as {
    ok: boolean;
    rejection?: { code: string };
    blocked?: { missing: string[] };
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!payload.ok) process.exit(payload.rejection?.code === "USAGE_ERROR" ? 2 : 3);
  if (payload.blocked && payload.blocked.missing.length > 0) process.exit(4);
  process.exit(0);
}

await main();
