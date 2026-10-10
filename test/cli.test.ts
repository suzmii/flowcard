/**
 * CLI 的出口契约（spawn 真进程，走真管道）。
 *
 * 两条要守住的硬约束：
 *   1. **stdout 是一整行 JSON，且经管道不截断** —— 裸 `process.exit()` 会在管道缓冲（Linux 64 KiB）
 *      没排空时掐掉输出，`list`/`show`/写命令的响应体一旦过 64 KiB 就拿到半截（还会断在半个字符处）。
 *      这里用"暂停读端"把管道灌满，稳定复现：修前 `| cat` 只有 65536 字节。
 *   2. **退出码契约**：0 成功 / 2 用法或服务端错误 / 3 状态不允许 / 4 缺必要条件 / 5 服务不可达。
 *      服务不可达时**必须**是 exit 5 + 一行 JSON（不是 exit 1 + 栈追踪、也不是假成功）。
 *
 * 全程离线：远程一律是本地假 HTTP，端口用完即关，不碰真服务。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "src", "cli", "main.ts");

// ---------------------------------------------------------------- 假服务

type Fake = { url: string; port: number; close: () => Promise<void>; requests: string[] };

const servers: Server[] = [];

afterAll(async () => {
  for (const server of servers) server.close();
});

/** 起一个本地假 HTTP：`route(req)` 返回 `{status, body, type}`，没匹配上就是 404 JSON。 */
async function fakeServer(
  route: (req: { method: string; url: string; body: string }) => { status: number; body: string; type?: string } | null,
): Promise<Fake> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(`${req.method ?? "GET"} ${url}`);
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const hit = route({ method: req.method ?? "GET", url, body: Buffer.concat(chunks).toString("utf8") });
      if (hit === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "没有这个端点" } }));
        return;
      }
      res.writeHead(hit.status, { "content-type": hit.type ?? "application/json" });
      res.end(hit.body);
    });
  });
  servers.push(server);
  // `Promise.withResolvers()` 是 ES2024，本仓 tsconfig 的 lib 停在 ES2023：这里用 executor 形态。
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 一个确定没人监听的端口（先占再放）。 */
async function deadPort(): Promise<number> {
  const fake = await fakeServer(() => null);
  await fake.close();
  return fake.port;
}

/** 一行 JSON → 普通对象（形状不对就当场炸：CLI 的 stdout 契约就是"一行 JSON 对象"）。 */
function jsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`stdout 不是 JSON 对象：${text.slice(0, 80)}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * 跑一次 CLI，返回退出码 + stdout/stderr。
 * **必须异步**：假 HTTP 服务跑在本进程（vitest worker）里，`spawnSync` 会把 worker 的事件循环堵死，
 * 请求永远等不到应答 —— 那就变成测自己的死锁，不是测 CLI。
 */
async function runCli(
  args: string[],
  baseUrl: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, FLOWCARD_URL: baseUrl, FLOWCARD_PORT: "" },
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const guard = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(guard);
  return { status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/**
 * 跑一次 CLI，**先按住读端**再收：管道缓冲（Linux 64 KiB）会被灌满。
 * 修前的实现"写完就 `process.exit()`"会在这个窗口里**提前退出**（输出被截断）；
 * 修后的实现会一直等写回调，所以要先把读端放开、它才能写完收尾。
 *
 * 这里必须用真时间：真实子进程 + OS 侧管道缓冲，fake timer 推不动内核的读端。
 * 等待是"有界地看它会不会自己先退"，不是靠睡够时长来断言。
 */
async function runCliThroughCloggedPipe(args: string[], baseUrl: string): Promise<{ status: number | null; stdout: string }> {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, FLOWCARD_URL: baseUrl, FLOWCARD_PORT: "" },
  });
  const chunks: Buffer[] = [];
  child.stderr.resume();
  child.stdout.pause(); // 不让 Node 从管道读 → 子进程那边的缓冲会满

  const waited = new Promise<void>((resolve) => setTimeout(resolve, 300));
  await waited;

  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdout.resume();
  // 兜底：读端放开后还收不了尾（实现有问题时会出现），3 秒后杀掉，让断言去报"字节不够"，
  // 而不是让整个用例撞 vitest 的超时（那条信息什么都说明不了）。
  const guard = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const status = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  clearTimeout(guard);
  return { status, stdout: Buffer.concat(chunks).toString("utf8") };
}

/** 大响应：40 张卡 × 12 KB 正文 ≈ 480 KB（远超管道缓冲）。 */
const BIG_BODY = "x".repeat(12_000);
const BIG_CARDS = JSON.stringify({
  cards: Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, title: `卡 ${i + 1}`, body: BIG_BODY })),
});

describe("CLI 出口：大输出经管道不截断", () => {
  it("list 的 480 KB 响应经管道仍然完整、仍是可 JSON.parse 的一行", async () => {
    const fake = await fakeServer((req) =>
      req.url === "/api/cards" ? { status: 200, body: BIG_CARDS } : null,
    );
    const { status, stdout } = await runCliThroughCloggedPipe(["list"], fake.url);

    expect(status).toBe(0);
    // 修前：管道里只有 65536 字节（JSON 断在半个 UTF-8 字符处，parse 直接报错）
    expect(Buffer.byteLength(stdout, "utf8"), "输出被管道截断了（修前的 bug）").toBeGreaterThan(400_000);
    expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(jsonObject(stdout)["cards"]).toHaveLength(40);
    await fake.close();
  });

  it("show 的 400 KB 输出经管道完整（修前只有 65536）", async () => {
    // 正文要够大：子进程 stdio 是 socketpair，发送缓冲有几百 KB —— 输出小于它就"写得下"，
    // 不按住读端也踩不到截断（卡片正文上限由 HTTP 体限 1 MiB 兜着，400 KB 是合法尺寸）。
    const body = "y".repeat(400_000);
    const card = JSON.stringify({ card: { id: "c1", title: "卡", body } });
    const fake = await fakeServer((req) =>
      req.url === "/api/cards/c1" ? { status: 200, body: card } : null,
    );
    const { status, stdout } = await runCliThroughCloggedPipe(["show", "c1"], fake.url);

    expect(status).toBe(0);
    // 修前：这里只剩 65536 字节（卡片正文在后半截），JSON 直接 parse 不了
    expect(Buffer.byteLength(stdout, "utf8"), "输出被管道截断了（修前的 bug）").toBeGreaterThan(300_000);
    const shown = jsonObject(stdout)["card"];
    expect(shown).toMatchObject({ id: "c1" });
    if (shown === null || typeof shown !== "object" || !("body" in shown)) throw new Error("show 没给出 card.body");
    expect(shown.body).toHaveLength(400_000);
    await fake.close();
  });
});

describe("CLI 退出码契约", () => {
  it("list / show 服务不可达 → exit 5 + 一行 JSON（不是 exit 1 + 栈追踪）", async () => {
    const port = await deadPort();
    const url = `http://127.0.0.1:${port}`;

    for (const args of [["list"], ["show", "c1"], ["sync", "proj"], ["delete", "c1"], ["restore", "c1"]]) {
      const { status, stdout, stderr } = await runCli(args, url);
      expect({ args, status }).toEqual({ args, status: 5 });
      expect(stderr).toBe("");
      expect(stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(jsonObject(stdout)).toMatchObject({ ok: false, rejection: { code: "UNREACHABLE" } });
    }
  });

  it("delete / restore 的退出码不回归：成功 0、被拒 3", async () => {
    const ok = await fakeServer(() => ({ status: 200, body: JSON.stringify({ ok: true, inserted: 1, duplicates: 0 }) }));
    expect((await runCli(["delete", "c1", "--reason", "不需要了"], ok.url)).status).toBe(0);
    expect((await runCli(["restore", "c1"], ok.url)).status).toBe(0);
    await ok.close();

    const rejected = await fakeServer(() => ({
      status: 200,
      body: JSON.stringify({ ok: false, rejection: { code: "NOT_FOUND", message: "卡片不存在" } }),
    }));
    expect((await runCli(["delete", "c1"], rejected.url)).status).toBe(3);
    expect((await runCli(["restore", "c1"], rejected.url)).status).toBe(3);
    await rejected.close();
  });

  it("sync 的退出码不回归：no-credentials / no-transport → 4、no-remote → 3、成功 → 0", async () => {
    for (const [reason, code] of [
      ["no-credentials", 4],
      ["no-transport", 4],
      ["no-remote", 3],
      [null, 0],
    ] as const) {
      // sync 先解析"项目 id 或路径"（这里给的是项目 id，走 /api/projects 列表），再 POST .../sync
      const fake = await fakeServer((req) => {
        if (req.url === "/api/projects") return { status: 200, body: JSON.stringify({ projects: [{ id: "p1" }] }) };
        if (req.url?.startsWith("/api/projects/") === true) {
          return { status: 200, body: JSON.stringify({ ok: reason === null, reason }) };
        }
        return null;
      });
      const { status, stdout } = await runCli(["sync", "p1"], fake.url);
      expect({ reason, status }).toEqual({ reason, status: code });
      expect(jsonObject(stdout)).toMatchObject({ reason });
      await fake.close();
    }
  });

  it("服务端回非 JSON 的 500：写命令 exit 5 + 一行 JSON（不是 exit 1 + 栈追踪）", async () => {
    const fake = await fakeServer(() => ({
      status: 500,
      body: "Internal Server Error\n",
      type: "text/plain",
    }));
    const comment = await runCli(["comment", "c1", "--body", "hi"], fake.url);
    expect(comment.status).toBe(5);
    expect(comment.stderr).toBe("");
    expect(jsonObject(comment.stdout)).toMatchObject({ ok: false, rejection: { code: "SERVER_ERROR" } });

    // 读命令也一样：不装成功，但拿到的是解析后的 JSON 行
    const listed = await runCli(["list"], fake.url);
    expect(listed.status).toBe(2);
    expect(listed.stderr).toBe("");
    expect(jsonObject(listed.stdout)).toMatchObject({ ok: false, error: { code: "BAD_RESPONSE" } });
    await fake.close();
  });
});

/**
 * `worktree use` 是**多步**命令（绑 worktree → 换 cwd → 等卡片进实施中），
 * 这里用假服务端把三步的请求体都看住：顺序、路径、以及最终那行 JSON。
 */
describe("CLI：worktree use（绑 worktree + 把会话搬进去）", () => {
  it("先绑 worktree 再打 session/cwd，等到 working 才回 ok（退出码 0）", async () => {
    const bodies: { url: string; body: string }[] = [];
    let moved = false;
    const fake = await fakeServer((req) => {
      if (req.url === "/api/cards/c1") {
        return {
          status: 200,
          body: JSON.stringify({
            card: { id: "c1", state: moved ? "working" : "ready", projectId: "p", repoPath: "/repo", worktree: null, session: null },
          }),
        };
      }
      if (req.url === "/api/commands") {
        bodies.push({ url: req.url, body: req.body });
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            card: {
              id: "c1",
              state: "ready",
              worktree: { path: "/repo/.worktrees/x", branch: "feat/x", source: "flowcard" },
            },
          }),
        };
      }
      if (req.url === "/api/cards/c1/session/cwd") {
        bodies.push({ url: req.url, body: req.body });
        moved = true;
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            status: "starting",
            cwd: "/repo/.worktrees/x",
            previousCwd: "/repo",
            resumed: true,
            sessionFile: "/repo/.omp/session.jsonl",
          }),
        };
      }
      return null;
    });

    const { status, stdout, stderr } = await runCli(
      ["worktree", "use", "c1", "--path", "/repo/.worktrees/x", "--branch", "feat/x"],
      fake.url,
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(jsonObject(stdout)).toMatchObject({
      ok: true,
      worktree: { path: "/repo/.worktrees/x", branch: "feat/x" },
      session: { ok: true, resumed: true, cwd: "/repo/.worktrees/x", previousCwd: "/repo" },
      state: "working",
      advanced: true,
    });

    // 顺序与请求体：① 绑 worktree 走既有命令（相对路径交给服务端按项目根解析）② 换 cwd 用**服务端解析后的绝对路径**
    expect(bodies.map((b) => b.url)).toEqual(["/api/commands", "/api/cards/c1/session/cwd"]);
    expect(jsonObject(bodies[0]?.body ?? "{}")).toMatchObject({
      cmd: "worktree",
      card: "c1",
      worktree: { path: "/repo/.worktrees/x", branch: "feat/x" },
    });
    expect(jsonObject(bodies[1]?.body ?? "{}")).toEqual({ path: "/repo/.worktrees/x" });
    await fake.close();
  });

  it("不给 --branch 时按目录里的 git 分支推；推不出来就用法错退出（不瞎绑）", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fc-wtu-cli-"));
    execFileSync("git", ["init", "-q", "-b", "feat/from-git", repo]);
    const bodies: string[] = [];
    const fake = await fakeServer((req) => {
      if (req.url === "/api/cards/c1") {
        return { status: 200, body: JSON.stringify({ card: { id: "c1", state: "working", repoPath: repo, worktree: null } }) };
      }
      if (req.url === "/api/commands") {
        bodies.push(req.body);
        return { status: 200, body: JSON.stringify({ ok: true, card: { id: "c1", worktree: { path: repo, branch: "feat/from-git" } } }) };
      }
      if (req.url === "/api/cards/c1/session/cwd") {
        return { status: 200, body: JSON.stringify({ ok: true, status: "starting", cwd: repo, resumed: true }) };
      }
      return null;
    });

    const derived = await runCli(["worktree", "use", "c1", "--path", repo], fake.url);
    expect(derived.status).toBe(0);
    expect(jsonObject(bodies[0] ?? "{}")).toMatchObject({ worktree: { branch: "feat/from-git" } });

    // 不是 git 工作树 + 没给 --branch → 退出码 2（用法错），一个命令都不发
    const bare = mkdtempSync(join(tmpdir(), "fc-wtu-bare-"));
    const noBranch = await runCli(["worktree", "use", "c1", "--path", bare], fake.url);
    expect(noBranch.status).toBe(2);
    expect(jsonObject(noBranch.stdout)).toMatchObject({ ok: false, rejection: { code: "USAGE_ERROR" } });
    expect(bodies).toHaveLength(1);
    await fake.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  });
});
