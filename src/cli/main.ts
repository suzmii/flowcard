/**
 * flowcard CLI：agent 的唯一写入口。
 * 契约：stdout 永远是一行 JSON；退出码 0 成功 / 2 用法 / 3 状态不允许 / 4 缺必要条件 / 5 服务不可达。
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";
import { MAX_ATTACHMENT_BYTES, MIME_BY_EXT } from "../server/attachments.ts";
import { resolveUserPath } from "../shared/paths.ts";
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
    project: { type: "string" },
    name: { type: "string" },
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

/** 读接口的统一收尾：非 2xx 时把服务端的 error 原样当 rejection 打出来，按 404/其它分退出码。 */
async function report(res: Response): Promise<never> {
  const payload = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; hint?: string };
  } | null;
  process.stdout.write(`${JSON.stringify(payload ?? { ok: false })}\n`);
  if (res.ok) process.exit(0);
  process.exit(res.status === 404 ? 3 : 2);
}

/** 服务不可达（连不上就是连不上，别装成别的错）。 */
function unreachable(error: unknown): never {
  process.stdout.write(
    `${JSON.stringify({ ok: false, rejection: { code: "UNREACHABLE", message: `连不上 ${DEFAULT_URL}：${String(error)}` } })}\n`,
  );
  process.exit(5);
}

/**
 * `flowcard project add <路径> | list | current [--path <路径>]`
 * 项目 = 看板的 Metadata：登记一次，之后开卡只给 `--project <id>`（不给就按 cwd 解析）。
 */
async function runProject(args: string[]): Promise<never> {
  const sub = args[0] ?? "list";
  // 人手输的路径（可能带 ~ 或相对路径）在 CLI 侧先定成绝对路径：服务端 cwd 与调用方不一定一致。
  const target = resolveUserPath(args[1] ?? opt("path") ?? process.cwd());

  try {
    if (sub === "list") return await report(await fetch(`${DEFAULT_URL}/api/projects`));
    if (sub === "current") {
      return await report(
        await fetch(`${DEFAULT_URL}/api/project/current?path=${encodeURIComponent(target)}`),
      );
    }
    if (sub === "add") {
      return await report(
        await fetch(`${DEFAULT_URL}/api/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: target }),
        }),
      );
    }
  } catch (error) {
    unreachable(error);
  }
  die(2, `未知的 project 子命令 "${sub}"：可用 add <路径> / list / current [--path <路径>]`);
}

/** `flowcard attach <图片>`：上传后打印 markdown，直接贴进正文或评论。 */
async function runAttach(file: string | undefined): Promise<never> {
  if (!file) die(2, "attach 需要 <图片文件路径>（png/jpg/jpeg/gif/webp）");
  const mime = MIME_BY_EXT[extname(file).slice(1).toLowerCase()];
  if (!mime) die(2, `只支持 png/jpg/jpeg/gif/webp，收到 "${file}"`);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    die(2, `读不到文件 ${file}：${String(error)}`);
  }
  // 本地先量一次：明知超限就别把 10MB 推上去再等 413。
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    die(2, `${file} 有 ${bytes.byteLength} 字节，超过上限 ${MAX_ATTACHMENT_BYTES} 字节（10 MB）`);
  }

  const name = opt("name") ?? basename(file);
  try {
    return await report(
      await fetch(`${DEFAULT_URL}/api/attachments?name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": mime },
        body: bytes,
      }),
    );
  } catch (error) {
    unreachable(error);
  }
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

/**
 * 当前目录落在哪个项目里（服务端按 `shared/paths.ts` 的路径段规则解析，CLI 不自己比路径）。
 * 没登记过 / 服务不可达 → undefined，调用方退回合成项目 local。
 */
async function currentProjectId(cwd: string): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${DEFAULT_URL}/api/project/current?path=${encodeURIComponent(resolveUserPath(cwd))}`,
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { project?: { id?: string } };
    return data.project?.id;
  } catch {
    return undefined;
  }
}

async function build(): Promise<Command> {
  const name = positionals[0];
  switch (name) {
    case "open": {
      // 标题可选：不给（或给空白）由服务端从正文派生。项目不给就按 cwd 解析，解析不到用 local。
      const title = opt("title");
      const projectId = opt("project") ?? (await currentProjectId(process.cwd()));
      return {
        cmd: "open",
        actor: actor(),
        ...(title !== undefined && title.trim() !== "" ? { title } : {}),
        body: opt("body") ?? "",
        ...(projectId ? { projectId } : {}),
        ...(opt("issue") ? { issue: { ...parseIssueSpec(opt("issue")!, opt("url")), state: "open" as const } } : {}),
        ...(opt("part-of") ? { partOf: opt("part-of")! } : {}),
      };
    }
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
    case "claim": {
      // card 可以不写：服务端按 --cwd 反查是哪张卡片的 worktree（写了 card 就照旧显式绑）。
      const card = positionals[1];
      const cwd = opt("cwd");
      if (!card && !cwd) {
        die(2, "claim 要么给 <card>，要么给 --cwd 让服务端按会话工作目录反查卡片");
      }
      return {
        cmd: "claim",
        actor: actor(),
        ...(card ? { card } : {}),
        session: {
          harness: opt("harness") ?? die(2, "claim 需要 --harness"),
          id: opt("session") ?? die(2, "claim 需要 --session <id>"),
          cwd: cwd ?? die(2, "claim 需要 --cwd（会话的工作目录，用来校验是否在 worktree 里）"),
          agentKind: (opt("kind") as "main" | "sub" | undefined) ?? "main",
          ...(opt("file") ? { file: opt("file")! } : {}),
          ...(opt("resume") ? { resumeHint: opt("resume")! } : {}),
        },
      };
    }
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
      return die(2, `未知命令 "${name ?? ""}"。可用：project attach open issue plan gate confirm worktree claim beat pr push end accept block unblock probe cleanup comment spawn up down detect list show`);
  }
}

async function main(): Promise<void> {
  const name = positionals[0];

  if (!name || name === "help" || name === "--help") {
    process.stdout.write(`${JSON.stringify({ usage: "flowcard <命令> <card> [选项…]；命令：project attach open issue plan gate confirm worktree claim beat pr push end accept block unblock probe cleanup comment spawn up down detect list show" })}\n`);
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

  // 项目（看板 Metadata）与附件不是命令：直接打各自的端点。
  if (name === "project") await runProject(positionals.slice(1));
  if (name === "attach") await runAttach(positionals[1]);

  const command = await build();
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
