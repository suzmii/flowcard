/**
 * flowcard detect：独立可执行探测入口（M3）。
 *
 *   node src/cli/detect.ts <card> [--port 47825] [--url http://127.0.0.1:47825] [--cwd <路径>]
 *
 * 做三件事：从 cwd 反查 worktree/分支 → 探测 PR/CI 与进度信号 → 把**能拿到的部分**通过
 * `POST /api/commands` 回写卡片（`worktree` / `bindPr` / `probePr`）。stdout 一行 JSON。
 * 退出码沿用约定：0 成功 / 2 用法错 / 3 状态不允许或服务端拒绝 / 4 缺必要条件 / 5 服务不可达。
 *
 * 不改 `src/cli/main.ts`（那条通道只做"用户命令"）；这里是只读探测 + 回写的独立入口。
 * 探测失败不会把卡片搞坏：拿不到就不回写，只回写拿得到的那部分。
 */
import { parseArgs } from "node:util";
import type { Card, Command } from "../shared/types.ts";
import { probe, probeCommands, type ProbeCommand } from "../server/probe.ts";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    port: { type: "string" },
    url: { type: "string" },
    cwd: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const baseUrl =
  str(values.url) ??
  process.env.FLOWCARD_URL ??
  `http://127.0.0.1:${str(values.port) ?? process.env.FLOWCARD_PORT ?? "47825"}`;

function say(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** stdout 一行 JSON + 退出码，与 main.ts 的错误形状保持一致（`ok:false` + `rejection.code`）。 */
function die(code: number, message: string, extra: Record<string, unknown> = {}): never {
  say({ ok: false, rejection: { code: "USAGE_ERROR", message }, ...extra });
  process.exit(code);
}

async function post(command: Command): Promise<{ ok: boolean; rejection?: { code: string; message: string }; blocked?: { missing: string[] } }> {
  const res = await fetch(`${baseUrl}/api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return (await res.json()) as { ok: boolean; rejection?: { code: string; message: string }; blocked?: { missing: string[] } };
}

/** 探测计划 → `Command`（actor 用 system：这是机器探测，不是人的命令）。 */
function toCommand(card: string, plan: ProbeCommand): Command {
  const actor = { kind: "system" as const };
  if (plan.cmd === "worktree") return { cmd: "worktree", actor, card, worktree: plan.worktree };
  if (plan.cmd === "bindPr") return { cmd: "bindPr", actor, card, pr: plan.pr };
  return { cmd: "probePr", actor, card, pr: plan.pr };
}

async function main(): Promise<void> {
  if (values.help === true || positionals.length === 0) {
    say({
      usage: "node src/cli/detect.ts <card> [--port 47825] [--url <base>] [--cwd <路径>]",
      note: "从会话 cwd 反查 worktree/分支并探测 PR/CI，回写卡片；拿不到的信号会明确报告「未探测」。",
    });
    process.exit(values.help === true ? 0 : 2);
  }

  const cardId = positionals[0]!;

  // 1) 读卡片
  let card: Card;
  try {
    const res = await fetch(`${baseUrl}/api/cards/${encodeURIComponent(cardId)}`);
    if (!res.ok) {
      say({
        ok: false,
        card: cardId,
        rejection: { code: "NOT_FOUND", message: `卡片 ${cardId} 不存在（${baseUrl}）` },
      });
      process.exit(3);
    }
    const data = (await res.json()) as { card: Card };
    card = data.card;
  } catch (error) {
    say({
      ok: false,
      card: cardId,
      rejection: { code: "UNREACHABLE", message: `连不上 ${baseUrl}：${String(error)}` },
    });
    process.exit(5);
  }

  // 2) 定 cwd：会话 cwd 优先，退到已绑的 worktree 路径
  const cwd = str(values.cwd) ?? card.session?.cwd ?? card.worktree?.path;
  if (!cwd) {
    die(
      4,
      "卡片既没有会话 cwd 也没有已绑 worktree：先在 worktree 里开会话并 claim，或绑一个 worktree",
      {
        card: cardId,
        blocked: { missing: ["session.cwd"] },
        hint: `在 worktree 里开会话后：flowcard claim ${cardId} --harness omp --session <id> --cwd <worktree 路径>；或 flowcard worktree ${cardId} --path <路径> --branch <分支>`,
      },
    );
  }

  // 3) 探测（只读；gh/tea 缺失一律降级）
  const result = await probe(cwd, { repoPath: card.repoPath ?? null });

  // 4) 回写拿得到的那部分
  const plan = probeCommands({ worktree: card.worktree ?? null, pr: card.pr ?? null }, result);
  const applied: Array<{ cmd: string; ok: boolean; rejection?: { code: string; message: string }; blocked?: { missing: string[] } }> = [];
  for (const item of plan) {
    applied.push({ cmd: item.cmd, ...(await post(toCommand(cardId, item))) });
  }

  // 5) 报告
  const hints: string[] = [];
  if (!result.ok) {
    hints.push(`cwd ${cwd} 不在 git 仓库内：请把会话移进项目仓库的 worktree`);
  } else if (!result.worktree) {
    hints.push(
      `会话 cwd 是主仓库 ${result.verdict?.mainRoot ?? "?"}，不是 worktree：请 /wt <branch> 或 /move <worktree 路径>`,
    );
  }
  if (result.ok && !result.prProbed) {
    hints.push("PR 未探测：本机没有可用的 gh/tea（未安装、未登录或远程不匹配）——不算失败，只是没有 PR 信号");
  }
  if (result.ok && result.prProbed && !result.pr) {
    hints.push(`分支 ${result.signals.branch ?? "?"} 没有对应的 PR：先开 WIP PR（flowcard pr …）`);
  }

  const appliedOk = applied.every((a) => a.ok);
  say({
    ok: result.ok && appliedOk,
    card: cardId,
    baseUrl,
    cwd,
    worktree: result.worktree,
    isWorktree: result.verdict?.isWorktree ?? false,
    mainRoot: result.verdict?.mainRoot ?? null,
    pr: result.pr,
    prSource: result.prSource,
    prProbed: result.prProbed,
    signals: result.signals,
    applied,
    notes: result.notes,
    hints,
  });

  const rejection = applied.find((a) => !a.ok)?.rejection;
  if (rejection) process.exit(rejection.code === "USAGE_ERROR" ? 2 : 3);
  if (applied.some((a) => a.blocked && a.blocked.missing.length > 0)) process.exit(4);
  if (!result.ok) process.exit(4);
  process.exit(0);
}

await main();
