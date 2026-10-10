/**
 * M3 运行时监督：配置解析、单例 kill 语义、进程组杀干净、SIGKILL 兜底、日志、状态投影。
 * 这里真的 spawn 进程（用的都是 node / sh / python3 这种必然存在的短命令），所以每个用例都要收干净。
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { applyEvent, emptyCard } from "../src/server/project.ts";
import { createRuntimeSupervisor, type RuntimeSupervisor } from "../src/server/runtime.ts";
import { createStore, type Store } from "../src/server/store.ts";
import {
  findRepoConfig,
  resolveRuntimeConfig,
  RuntimeConfigError,
} from "../src/shared/runtime-config.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
const LONG_RUNNING = 'node -e "setInterval(()=>{},1000)"';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** 一个假项目：带 .git 的根 + .worktrees/card-1 工作树 + .flowcard.toml。 */
function makeProject(toml?: string): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "fc-proj-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  const worktree = join(root, ".worktrees", "card-1");
  mkdirSync(worktree, { recursive: true });
  if (toml !== undefined) writeFileSync(join(root, ".flowcard.toml"), toml);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, worktree };
}

/**
 * 真仓库 + 真 `git worktree add`：linked worktree 里的 `.git` 是个**文件**
 * （`gitdir: …/.git/worktrees/<名字>`），项目根判定必须能穿过它往上找。
 */
function makeGitProject(toml?: string): { root: string; worktree: string } {
  const root = mkdtempSync(join(tmpdir(), "fc-git-"));
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
      { encoding: "utf8" },
    );
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  if (toml !== undefined) writeFileSync(join(root, ".flowcard.toml"), toml);
  const worktree = join(root, ".worktrees", "demo");
  git("worktree", "add", "-q", worktree, "-b", "feat/demo");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, worktree };
}

/** 在同一个真仓库里再开一个 worktree（linked worktree）。 */
function addGitWorktree(root: string, name: string, branch: string): string {
  const path = join(root, ".worktrees", name);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", path, "-b", branch], { encoding: "utf8" });
  return path;
}

type Fixture = {
  store: Store;
  sup: RuntimeSupervisor;
  dataDir: string;
  configDir: string;
};

function makeRuntime(opts: { configDir?: string } = {}): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), "fc-rt-"));
  const configDir = opts.configDir ?? mkdtempSync(join(tmpdir(), "fc-cfg-"));
  const store = createStore({ dataDir, flow: personalFlow });
  const sup = createRuntimeSupervisor({
    store,
    dataDir,
    configDir,
    graceMs: 400,
    pollMs: 40,
    settleMs: 150,
  });
  cleanups.push(async () => {
    await sup.shutdown();
    sup.shutdownSync();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (opts.configDir === undefined) rmSync(configDir, { recursive: true, force: true });
  });
  return { store, sup, dataDir, configDir };
}

function openCard(store: Store, title: string, root?: string): string {
  return store.execute({
    cmd: "open",
    actor: HUMAN,
    title,
    body: "",
    ...(root ? { repoPath: root } : {}),
  }).outcome.primaryCardId;
}

function bindWorktree(store: Store, card: string, path: string): void {
  store.execute({
    cmd: "worktree",
    actor: HUMAN,
    card,
    worktree: { path, branch: `feat/${card}`, source: "flowcard" },
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runtimeEvents(store: Store, card: string): { type: string; payload: Record<string, unknown> }[] {
  return store
    .listEvents(1000)
    .filter((e) => e.cardId === card && e.type.startsWith("runtime."))
    .map((e) => ({ type: e.type, payload: e.payload }));
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** /proc/<pid>/stat 第 22 字段：判断 pid 有没有被复用时用得上。 */
function procStartOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] ?? "";
}

// ---------------------------------------------------------------- 配置解析

describe("启动配置", () => {
  it("仓库内 .flowcard.toml：cmd / cwd / env / ports / ready / singleton 都读得到", () => {
    const { root, worktree } = makeProject(
      [
        "[runtime]",
        'cmd = "npm run dev"',
        'cwd = "packages/app"',
        "ports = [5173, 5174]",
        "",
        "[runtime.env]",
        'NODE_ENV = "development"',
        "",
        "[runtime.ready]",
        "port = 5173",
        "timeout = 5",
        "",
      ].join("\n"),
    );
    const configDir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

    const config = resolveRuntimeConfig({ root: worktree, configDir });

    expect(config.cmd).toBe("npm run dev");
    expect(config.cwd).toBe(join(worktree, "packages/app"));
    expect(config.env).toEqual({ NODE_ENV: "development" });
    expect(config.ports).toEqual([5173, 5174]);
    expect(config.ready).toEqual({ kind: "port", port: 5173, timeoutMs: 5000 });
    expect(config.singleton).toBe(true); // 默认全局单例
    expect(config.projectRoot).toBe(root);
    expect(config.sources).toEqual([join(root, ".flowcard.toml")]);
  });

  it("没配 ready 但有 ports：默认按第一个端口探活；没配 ports：进程不退就算就绪", () => {
    const { worktree } = makeProject('[runtime]\ncmd = "x"\nports = [8080]\n');
    const bare = makeProject('[runtime]\ncmd = "x"\n');
    const configDir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

    expect(resolveRuntimeConfig({ root: worktree, configDir }).ready).toEqual({
      kind: "port",
      port: 8080,
      timeoutMs: 30_000,
    });
    expect(resolveRuntimeConfig({ root: bare.worktree, configDir }).ready.kind).toBe("proc");
  });

  it("配置缺失 / 非法：给人话错误，不崩", () => {
    const { worktree } = makeProject();
    const configDir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

    let missing: unknown;
    try {
      resolveRuntimeConfig({ root: worktree, configDir });
    } catch (error) {
      missing = error;
    }
    expect(missing).toBeInstanceOf(RuntimeConfigError);
    expect((missing as RuntimeConfigError).code).toBe("NO_CONFIG");
    expect((missing as RuntimeConfigError).message).toContain("启动配置");
    expect((missing as RuntimeConfigError).searched).toContain(join(configDir, "projects.toml"));

    const bad = makeProject('[runtime]\ncmd = "x"\nsiingleton = true\n');
    let invalid: unknown;
    try {
      resolveRuntimeConfig({ root: bad.worktree, configDir });
    } catch (error) {
      invalid = error;
    }
    expect((invalid as RuntimeConfigError).code).toBe("BAD_CONFIG");
    expect((invalid as RuntimeConfigError).message).toContain("siingleton");
    expect((invalid as RuntimeConfigError).message).toContain(".flowcard.toml");

    const clash = makeProject("[runtime]\ncmd = 1\n");
    let wrongType: unknown;
    try {
      resolveRuntimeConfig({ root: clash.worktree, configDir });
    } catch (error) {
      wrongType = error;
    }
    expect((wrongType as RuntimeConfigError).message).toContain("cmd 必须是非空字符串");
  });

  it("优先级：仓库内优先，全局只补仓库没写的字段（含 env 合并）", () => {
    const { root, worktree } = makeProject('[runtime]\ncmd = "repo-cmd"\nports = [1]\n');
    const configDir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
    writeFileSync(
      join(configDir, "projects.toml"),
      [
        `["${root}"]`,
        'cmd = "global-cmd"',
        "singleton = false",
        "",
        `["${root}".env]`,
        'FROM = "global"',
        'BOTH = "global"',
        "",
      ].join("\n"),
    );

    const config = resolveRuntimeConfig({ root: worktree, configDir });
    expect(config.cmd).toBe("repo-cmd"); // 仓库内赢
    expect(config.ports).toEqual([1]);
    expect(config.singleton).toBe(false); // 仓库没写 → 全局兜底
    expect(config.env).toEqual({ FROM: "global", BOTH: "global" });
    expect(config.sources).toEqual([join(root, ".flowcard.toml"), join(configDir, "projects.toml")]);
  });
});

// ---------------------------------------------------------------- 启停与 kill 语义

describe("运行时启停", () => {
  it("up 之后状态 running，down 之后 stopped，且进程真的没了", async () => {
    const { worktree } = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const card = openCard(store, "起服务", worktree);
    bindWorktree(store, card, worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    expect(up.runtime?.status).toBe("running");
    expect(up.runtime?.pid).toBeGreaterThan(0);
    const pid = up.runtime!.pid!;
    expect(alive(pid)).toBe(true);

    // 事件流里有 starting → running
    expect(runtimeEvents(store, card).map((e) => e.type)).toEqual([
      "runtime.starting",
      "runtime.started",
    ]);

    const down = await sup.down(card);
    expect(down.ok).toBe(true);
    expect(down.runtime?.status).toBe("stopped");
    expect(down.signal).toBe("SIGTERM");
    expect(alive(pid)).toBe(false);

    const again = await sup.down(card);
    expect(again.ok).toBe(true);
    expect(again.warnings.join()).toContain("没有在跑");
    // 重复 down 不会写出第二条 stopped（dedupeKey）
    expect(runtimeEvents(store, card).filter((e) => e.type === "runtime.stopped")).toHaveLength(1);
  });

  it("单例不变式：启 B 会把 A 停掉，并把 A 放进 killed", async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const a = openCard(store, "A", project.worktree);
    const b = openCard(store, "B", project.worktree);
    bindWorktree(store, a, project.worktree);
    bindWorktree(store, b, project.worktree);

    const upA = await sup.up(a);
    const pidA = upA.runtime!.pid!;
    expect(alive(pidA)).toBe(true);

    const upB = await sup.up(b);
    expect(upB.killed).toEqual([a]);
    expect(upB.runtime?.status).toBe("running");
    expect(alive(pidA)).toBe(false);
    expect(store.getCard(a)!.runtime?.status).toBe("stopped");
    expect(alive(upB.runtime!.pid!)).toBe(true);
  });

  it('singleton = false：各起各的，不互相杀', async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\nsingleton = false\n`);
    const { store, sup } = makeRuntime();
    const a = openCard(store, "A", project.worktree);
    const b = openCard(store, "B", project.worktree);
    bindWorktree(store, a, project.worktree);
    bindWorktree(store, b, project.worktree);

    const upA = await sup.up(a);
    const upB = await sup.up(b);
    expect(upB.killed).toEqual([]);
    expect(alive(upA.runtime!.pid!)).toBe(true);
    expect(alive(upB.runtime!.pid!)).toBe(true);
  });

  it('singleton = "project"：只停同一个项目里的卡', async () => {
    const one = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\nsingleton = "project"\n`);
    const two = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\nsingleton = "project"\n`);
    const { store, sup } = makeRuntime();
    const a = openCard(store, "A", one.worktree);
    const b = openCard(store, "B", two.worktree);
    const c = openCard(store, "C", one.worktree);
    bindWorktree(store, a, one.worktree);
    bindWorktree(store, b, two.worktree);
    bindWorktree(store, c, one.worktree);

    const upA = await sup.up(a);
    const upB = await sup.up(b); // 另一个项目：不动 A
    expect(upB.killed).toEqual([]);
    expect(alive(upA.runtime!.pid!)).toBe(true);

    const upC = await sup.up(c); // 同项目：停 A，不动 B
    expect(upC.killed).toEqual([a]);
    expect(alive(upA.runtime!.pid!)).toBe(false);
    expect(alive(upB.runtime!.pid!)).toBe(true);
  });

  it("进程组杀干净：同一个组里的子进程也一起死", async () => {
    const project = makeProject(`[runtime]\ncmd = 'sleep 300 & echo CHILD=$!; wait'\n`);
    const { store, sup, dataDir } = makeRuntime();
    const card = openCard(store, "带子进程", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    const pid = up.runtime!.pid!;

    const log = readFileSync(join(dataDir, "logs", `${card}.log`), "utf8");
    const childPid = Number(/CHILD=(\d+)/.exec(log)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);

    await sup.down(card);
    expect(alive(pid)).toBe(false);
    expect(alive(childPid)).toBe(false);
  });

  it("SIGKILL 兜底：赖着不走的进程组也会被收掉，且信号写进事件", async () => {
    const project = makeProject(`[runtime]\ncmd = 'trap "" TERM; while true; do sleep 1; done'\n`);
    const { store, sup } = makeRuntime();
    const card = openCard(store, "抗 TERM", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    const pid = up.runtime!.pid!;

    const down = await sup.down(card);
    expect(down.signal).toBe("SIGKILL");
    expect(alive(pid)).toBe(false);
    const stopped = runtimeEvents(store, card).filter((e) => e.type === "runtime.stopped");
    expect(stopped.at(-1)?.payload["signal"]).toBe("SIGKILL");
  });

  it("日志重定向到 <dataDir>/logs/<cardId>.log", async () => {
    const project = makeProject(`[runtime]\ncmd = 'echo hello-from-runtime; ${LONG_RUNNING}'\n`);
    const { store, sup, dataDir } = makeRuntime();
    const card = openCard(store, "看日志", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.runtime?.logPath).toBe(join(dataDir, "logs", `${card}.log`));
    const text = readFileSync(up.runtime!.logPath!, "utf8");
    expect(text).toContain("[flowcard] runtime start");
    expect(text).toContain("hello-from-runtime");
  });

  it("ready.log 只看这次启动之后的输出（重启不会被上一轮的 ready 行骗到）", async () => {
    const project = makeProject(
      [
        "[runtime]",
        "cmd = 'echo READY; sleep 300'",
        "",
        "[runtime.ready]",
        'log = "READY"',
        "timeout = 1",
        "",
      ].join("\n"),
    );
    const { store, sup } = makeRuntime();
    const card = openCard(store, "日志起点", project.worktree);
    bindWorktree(store, card, project.worktree);

    expect((await sup.up(card)).ok).toBe(true);
    await sup.down(card);

    // 换个不再打印 READY 的命令：如果匹配了整个日志文件，第二次会立刻「就绪」。
    writeFileSync(
      join(project.root, ".flowcard.toml"),
      ["[runtime]", "cmd = 'sleep 300'", "", "[runtime.ready]", 'log = "READY"', "timeout = 1", ""].join(
        "\n",
      ),
    );
    const again = await sup.up(card);
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("READY_TIMEOUT");
  });

  it("启动即退出 → failed，退出码进事件", async () => {
    const project = makeProject("[runtime]\ncmd = 'exit 3'\n");
    const { store, sup } = makeRuntime();
    const card = openCard(store, "起不来", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(false);
    expect(up.error?.code).toBe("EXITED");
    expect(up.runtime?.status).toBe("failed");
    const failed = runtimeEvents(store, card).filter((e) => e.type === "runtime.failed");
    expect(failed.at(-1)?.payload["exitCode"]).toBe(3);
  });

  it("没有配置 / 没有 worktree：up 给人话错误，不崩", async () => {
    const project = makeProject();
    const { store, sup } = makeRuntime();
    const noConfig = openCard(store, "没配置", project.worktree);
    bindWorktree(store, noConfig, project.worktree);
    const noWorktree = openCard(store, "没工作树");

    const a = await sup.up(noConfig);
    expect(a.ok).toBe(false);
    expect(a.error?.code).toBe("NO_CONFIG");
    expect(a.error?.message).toContain("启动配置");
    expect(store.getCard(noConfig)!.runtime?.status).toBe("failed");

    const b = await sup.up(noWorktree);
    expect(b.ok).toBe(false);
    expect(b.error?.code).toBe("NO_PROJECT");
    expect(b.error?.hint).toContain("worktree");

    const c = await sup.up("c999");
    expect(c.error?.code).toBe("NOT_FOUND");
  });

  it("ready 按端口判定：端口通了才算 running", async () => {
    const port = await freePort();
    const project = makeProject(
      [
        "[runtime]",
        `cmd = "python3 -m http.server ${port} --bind 127.0.0.1"`,
        `ports = [${port}]`,
        "",
        "[runtime.ready]",
        `port = ${port}`,
        "timeout = 10",
        "",
      ].join("\n"),
    );
    const { store, sup } = makeRuntime();
    const card = openCard(store, "端口就绪", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    expect(up.runtime?.status).toBe("running");
    expect(up.runtime?.ports).toEqual([port]);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    await sup.down(card);
    await vi.waitFor(
      async () => {
        expect(await portOpen(port)).toBe(false);
      },
      { timeout: 5000 },
    );
  });

  it("ready 按日志正则判定", async () => {
    const project = makeProject(
      [
        "[runtime]",
        "cmd = 'echo booting; sleep 0.2; echo SERVER READY; sleep 300'",
        "",
        "[runtime.ready]",
        'log = "SERVER READY"',
        "timeout = 5",
        "",
      ].join("\n"),
    );
    const { store, sup } = makeRuntime();
    const card = openCard(store, "日志就绪", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    expect(up.runtime?.status).toBe("running");
  });

  it("进程自己退出后，卡片状态跟着变成 failed", async () => {
    const project = makeProject("[runtime]\ncmd = 'sleep 0.4; exit 7'\n");
    const { store, sup } = makeRuntime();
    const card = openCard(store, "自己退", project.worktree);
    bindWorktree(store, card, project.worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    await vi.waitFor(
      () => {
        expect(store.getCard(card)!.runtime?.status).toBe("failed");
      },
      { timeout: 5000 },
    );

    const failed = runtimeEvents(store, card).filter((e) => e.type === "runtime.failed");
    expect(failed.at(-1)?.payload["exitCode"]).toBe(7);
    // exit 监听与 up 各写一次 failed 时，dedupeKey 相同 → 只有一条
    expect(failed.length).toBe(1);
  });

  it("投影 == 从零 rebuild（runtime 状态不会漂）", async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const a = openCard(store, "A", project.worktree);
    const b = openCard(store, "B", project.worktree);
    bindWorktree(store, a, project.worktree);
    bindWorktree(store, b, project.worktree);

    await sup.up(a);
    await sup.up(b); // 顺手停了 A
    await sup.down(b);

    for (const card of [a, b]) {
      const events = store.listEvents(1000).filter((e) => e.cardId === card);
      const rebuilt = events.reduce((acc, e) => applyEvent(acc, e), emptyCard(card, events[0]!.at));
      expect(rebuilt).toEqual(store.getCard(card));
      expect(rebuilt.runtime?.status).toBe("stopped");
    }

    const ids = store.listCards().map((c) => c.id);
    expect(store.rebuild()).toBe(ids.length); // rebuild 不改结果
    expect(store.getCard(a)).toEqual(store.listCards()[0]);
  });

  it("linked worktree：配置只写在主仓库，也能从 worktree 里读到（.git 是文件不是目录）", () => {
    const { root, worktree } = makeGitProject(`[runtime]\ncmd = '${LONG_RUNNING}'\nports = [8199]\n`);
    const configDir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
    cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

    // worktree 的 .git 是文件：gitdir 指向主仓库
    expect(readFileSync(join(worktree, ".git"), "utf8")).toContain("gitdir:");
    expect(findRepoConfig(worktree).projectRoot).toBe(root);
    expect(findRepoConfig(join(worktree, "src")).projectRoot).toBe(root);

    const config = resolveRuntimeConfig({ root: worktree, configDir });
    expect(config.cmd).toBe(LONG_RUNNING);
    expect(config.ports).toEqual([8199]);
    expect(config.projectRoot).toBe(root);
    expect(config.sources).toEqual([join(root, ".flowcard.toml")]);
  });

  it("singleton = \"project\"：同一仓库的两个 worktree 分属两张卡时要互斥", async () => {
    const { root, worktree } = makeGitProject(
      `[runtime]\ncmd = '${LONG_RUNNING}'\nsingleton = "project"\n`,
    );
    const other = addGitWorktree(root, "demo-2", "feat/demo-2");
    expect(findRepoConfig(other).projectRoot).toBe(root);

    const { store, sup } = makeRuntime();
    const a = openCard(store, "A", worktree);
    const b = openCard(store, "B", other);
    bindWorktree(store, a, worktree);
    bindWorktree(store, b, other);

    const upA = await sup.up(a);
    expect(upA.ok).toBe(true);
    const pidA = upA.runtime!.pid!;
    expect(alive(pidA)).toBe(true);

    const upB = await sup.up(b);
    expect(upB.ok).toBe(true);
    expect(upB.killed).toEqual([a]); // 主仓库同一个 → 该互斥
    expect(alive(pidA)).toBe(false);
    expect(alive(upB.runtime!.pid!)).toBe(true);
  });

  it("真 worktree 里能起服务：配置从主仓库读到、进程组收得干净", async () => {
    const { root, worktree } = makeGitProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup, dataDir } = makeRuntime();
    const card = openCard(store, "真 worktree", worktree);
    bindWorktree(store, card, worktree);

    const up = await sup.up(card);
    expect(up.ok).toBe(true);
    expect(up.runtime?.status).toBe("running");
    expect(up.runtime?.logPath).toBe(join(dataDir, "logs", `${card}.log`));
    expect(alive(up.runtime!.pid!)).toBe(true);

    const down = await sup.down(card);
    expect(down.ok).toBe(true);
    expect(down.signal).toBe("SIGTERM");
    expect(alive(up.runtime!.pid!)).toBe(false);
    expect(store.getCard(card)!.runtime?.status).toBe("stopped");
    expect(findRepoConfig(worktree).projectRoot).toBe(root);
  });

  it("配置缺失 / 就绪超时：up 失败也不留半死进程", async () => {
    const { worktree } = makeGitProject(); // 真 worktree，但没有 .flowcard.toml
    const { store, sup } = makeRuntime();
    const miss = openCard(store, "没配置", worktree);
    bindWorktree(store, miss, worktree);

    const failedUp = await sup.up(miss);
    expect(failedUp.ok).toBe(false);
    expect(failedUp.error?.code).toBe("NO_CONFIG");
    expect(sup.active()).toEqual([]); // 监督器手里一个进程都没有（配置阶段就失败了，没 spawn）
    expect(runtimeEvents(store, miss).every((e) => e.type !== "runtime.starting")).toBe(true);
    expect(store.getCard(miss)!.runtime?.status).toBe("failed");

    // 起了但没就绪：必须把自己那组收掉，pid 不能留在进程表里
    const port = await freePort();
    const stuck = makeProject(
      [
        "[runtime]",
        "cmd = 'sleep 300'",
        "",
        "[runtime.ready]",
        `port = ${port}`,
        "timeout = 1",
        "",
      ].join("\n"),
    );
    const hang = openCard(store, "起不来", stuck.worktree);
    bindWorktree(store, hang, stuck.worktree);

    const timedOut = await sup.up(hang);
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error?.code).toBe("READY_TIMEOUT");
    expect(sup.active()).toEqual([]);
    const pid = runtimeEvents(store, hang)
      .filter((e) => e.type === "runtime.failed")
      .at(-1)?.payload["pid"] as number;
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
    expect(store.getCard(hang)!.runtime?.status).toBe("failed");
  });

  it("subscribe 收到状态变化（SSE 用）", async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const card = openCard(store, "看事件", project.worktree);
    bindWorktree(store, card, project.worktree);

    const seen: string[] = [];
    const off = sup.subscribe((change) => seen.push(`${change.cardId}:${change.status}`));
    await sup.up(card);
    await sup.down(card);
    off();
    expect(seen).toContain(`${card}:starting`);
    expect(seen).toContain(`${card}:running`);
    expect(seen).toContain(`${card}:stopped`);
  });

  it("重启后清理自己留下的残留进程：只认 pid/pgid/启动时刻对得上的组", async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const card = openCard(store, "残留", project.worktree);

    // 造一个「上一轮服务留下的」进程：自建进程组，身份写进事件流（就像上次 up 干的那样）。
    const orphan = spawn("/bin/sh", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
    await once(orphan, "spawn");
    const pid = orphan.pid!;
    const startedAt = new Date().toISOString();
    const procStart = procStartOf(pid);
    for (const to of ["starting", "running"] as const) {
      store.execute({
        cmd: "runtime",
        actor: { kind: "system" },
        card,
        to,
        pid,
        pgid: pid,
        startedAt,
        procStart,
      });
    }
    expect(store.getCard(card)!.runtime?.status).toBe("running");
    expect(alive(pid)).toBe(true);

    const reaped = await sup.reapStale();
    expect(reaped).toEqual([card]);
    expect(alive(pid)).toBe(false);
    expect(store.getCard(card)!.runtime?.status).toBe("stopped");
    const stopped = runtimeEvents(store, card).filter((e) => e.type === "runtime.stopped");
    expect(stopped.at(-1)?.payload["reason"]).toBe("reap:stale");
  });

  it("启动时刻对不上（pid 可能被复用）时只收尸，不杀", async () => {
    const project = makeProject(`[runtime]\ncmd = '${LONG_RUNNING}'\n`);
    const { store, sup } = makeRuntime();
    const card = openCard(store, "复用", project.worktree);

    const other = spawn("/bin/sh", ["-c", "sleep 300"], { detached: true, stdio: "ignore" });
    await once(other, "spawn");
    const pid = other.pid!;
    store.execute({
      cmd: "runtime",
      actor: { kind: "system" },
      card,
      to: "running",
      pid,
      pgid: pid,
      startedAt: new Date().toISOString(),
      procStart: "999999999", // 跟真实启动时刻对不上 → 不许动手
    });

    const reaped = await sup.reapStale();
    expect(reaped).toEqual([card]);
    expect(alive(pid)).toBe(true); // 不是我们那一轮起的，不能杀
    expect(store.getCard(card)!.runtime?.status).toBe("stopped");
    const note = runtimeEvents(store, card).at(-1)?.payload["reason"];
    expect(note).toBe("reap:stale");
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // 收尾失败无所谓
    }
  });
});
