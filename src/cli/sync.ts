/**
 * flowcard sync：触发一轮**只读**同步（issue/PR 状态 + 新评论），stdout 一行 JSON。
 * 退出码沿用约定：0 成功 / 2 用法错 / 3 项目或卡片不存在 / 4 无凭据 / 5 服务不可达。
 *
 * 两处入口共用同一实现：
 *   flowcard sync <项目 id 或路径 | 卡片 id> [--since ISO] [--list] [--dry-run] [--port 47825]
 *   node src/cli/sync.ts <…> […]
 *
 * 默认只读「卡片已绑定的编号」（精确读 + 每仓库一次评论增量）；`--list` 走全量列表（手动排查用），
 * `--dry-run` 只打印将产生的事实、不落库。
 */
import { parseArgs } from "node:util";
import { resolveUserPath } from "../shared/paths.ts";

const OPTIONS = {
  port: { type: "string" },
  url: { type: "string" },
  since: { type: "string" },
  list: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

type ProjectRef = { id: string } | { error: { code: string; message: string; hint?: string } };

export async function runSync(argv: string[]): Promise<never> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS });

  const baseUrl =
    str(values.url) ?? process.env.FLOWCARD_URL ?? `http://127.0.0.1:${str(values.port) ?? process.env.FLOWCARD_PORT ?? "47825"}`;

  const say = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  function die(code: number, message: string, extra: Record<string, unknown> = {}): never {
    say({ ok: false, rejection: { code: "USAGE_ERROR", message }, ...extra });
    process.exit(code);
  }

  if (values.help === true || positionals.length === 0) {
    say({
      usage: "flowcard sync <项目 id 或路径 | 卡片 id> [--since ISO] [--list] [--dry-run] [--port 47825]",
      note:
        "一轮 = 已绑编号精确读（GET issues/{n}、pulls/{n}）+ 每仓库一次评论增量（GET issues/comments?since=…）；全程只读。",
      flags: {
        "--list": "走全量列表（没有 since，用于手动排查/发现新编号）",
        "--dry-run": "只打印将产生的事实，不落库、不推进游标",
        "--since": "显式窗口起点（默认 = 上次同步时刻 - 60 s）",
      },
    });
    process.exit(values.help === true ? 0 : 2);
  }

  /** 位置参数可能是项目 id、仓库路径、或卡片 id（卡片的 projectId 就是它所属项目）。 */
  const resolveProject = async (ref: string): Promise<ProjectRef> => {
    const looksLikePath = ref.includes("/") || ref === "." || ref === ".." || ref.startsWith("~");
    if (looksLikePath) {
      const path = resolveUserPath(ref);
      const res = await fetch(`${baseUrl}/api/project/current?path=${encodeURIComponent(path)}`);
      const data = (await res.json().catch(() => null)) as { project?: { id?: string } } | null;
      if (!res.ok || !data?.project?.id) {
        return {
          error: {
            code: "NOT_FOUND",
            message: `${path} 不在任何已登记的项目里`,
            hint: "先登记：flowcard project add <仓库路径>",
          },
        };
      }
      return { id: data.project.id };
    }

    const projectsRes = await fetch(`${baseUrl}/api/projects`);
    const projectsData = (await projectsRes.json().catch(() => null)) as
      | { projects?: { id?: string }[] }
      | null;
    if (projectsData?.projects?.some((project) => project.id === ref)) return { id: ref };

    const cardRes = await fetch(`${baseUrl}/api/cards/${encodeURIComponent(ref)}`);
    const cardData = (await cardRes.json().catch(() => null)) as { card?: { projectId?: string } } | null;
    if (cardRes.ok && cardData?.card?.projectId) return { id: cardData.card.projectId };

    return {
      error: {
        code: "NOT_FOUND",
        message: `${ref} 既不是项目 id、也不是仓库路径、更不是卡片 id`,
        hint: "flowcard project list 看项目；flowcard list 看卡片",
      },
    };
  };

  let project: ProjectRef;
  try {
    project = await resolveProject(positionals[0]!);
  } catch (error) {
    say({ ok: false, rejection: { code: "UNREACHABLE", message: `连不上 ${baseUrl}：${String(error)}` } });
    process.exit(5);
  }
  if ("error" in project) {
    say({ ok: false, rejection: project.error });
    process.exit(3);
  }

  const body: Record<string, unknown> = {};
  const since = str(values.since);
  if (since) {
    if (!Number.isFinite(Date.parse(since))) die(2, `--since 要是能解析的时间（ISO 8601），收到：${since}`);
    body["since"] = since;
  }
  if (values.list === true) body["list"] = true;
  if (values["dry-run"] === true) body["dryRun"] = true;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(project.id)}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    say({ ok: false, rejection: { code: "UNREACHABLE", message: `连不上 ${baseUrl}：${String(error)}` } });
    process.exit(5);
  }

  const payload = (await res.json().catch(() => null)) as
    | {
        ok?: boolean;
        reason?: string | null;
        error?: { code?: string; message?: string; hint?: string };
        notes?: string[];
      }
    | null;

  if (!res.ok) {
    say(payload ?? { ok: false });
    process.exit(payload?.error?.code === "NOT_FOUND" ? 3 : 2);
  }

  say(payload ?? { ok: false });
  const reason = payload?.reason ?? null;
  if (reason === "no-credentials" || reason === "no-transport") {
    process.exit(4);
  }
  if (reason !== null) {
    // no-remote：remote 认不出目标仓库（不是凭据问题，也不是「同步成功」）。
    process.exit(3);
  }
  process.exit(0);
}

// 直接执行（`node src/cli/sync.ts …`）时才跑；被 main.ts import 时由那边调 runSync。
if (process.argv[1]?.endsWith("sync.ts") === true) {
  await runSync(process.argv.slice(2));
}
