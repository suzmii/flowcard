/**
 * 开工提示（brief）怎么传给 omp。
 *
 * `--append-system-prompt` 的值有两条硬约束：
 *   · omp 的 `resolvePromptInput` 按"含不含 `\n`"判定：含换行当**正文**，否则先按**文件路径**读。
 *     所以正文必须带换行，否则一句短提示会被当成路径去读。
 *   · Linux 单个 argv 元素上限 `MAX_ARG_STRLEN` = 128 KiB。卡片正文只受 HTTP 体限（1 MiB）约束，
 *     超长 brief 直接塞 argv 会让 omp **起不来**（E2BIG），而 flowcard 还报"已启动会话"。
 *     修法：超限就落盘、传路径。
 *
 * 假的 `startSession` 只记 argv，不真起 omp；临时目录用完即弃。
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { personalFlow } from "../src/flow/personal.ts";
import { MAX_INLINE_BRIEF_BYTES, briefPromptArg, createHostedSessions } from "../src/server/hosted-session.ts";
import type { OmpRpcSession, ReadyOutcome, StartRpcOptions } from "../src/server/omp-rpc.ts";
import { createStore } from "../src/server/store.ts";

const HUMAN = { kind: "human" as const, name: "tester" };
/** Linux 单个 argv 元素的上限。 */
const ARG_STRLEN_LIMIT = 128 * 1024;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  // 临时目录交给系统清理（/tmp 不删共享内容），这里只保证不往用户的 state 目录写东西
});

/** 假的 omp 会话句柄：只需让 `bringUp` 走"没起来"那一支（不真起子进程）。 */
function stubSession(): OmpRpcSession {
  return {
    pid: null,
    ready: Promise.resolve({
      ok: false,
      reason: "exit",
      message: "stub：测试不真起 omp",
      stderr: "",
    } satisfies Extract<ReadyOutcome, { ok: false }>),
    on: () => () => undefined,
    send: () => false,
    prompt: () => "msg-0",
    abort: () => false,
    newSession: () => false,
    getState: () => false,
    getSessionStats: () => false,
    request: async () => ({ ok: false, reason: "exited", message: "stub" }),
    setEventFilter: () => false,
    stderrTail: () => "",
    textFor: () => null,
    stats: () => ({ droppedFrames: 0, receivedFrames: 0, badLines: 0 }),
    stop: async () => ({ code: null, signal: null, forced: false }),
  };
}

/** 拿住 `--append-system-prompt` 的值（argv 里紧跟在它后面的那个）。 */
function promptArg(argv: readonly string[]): string {
  const index = argv.indexOf("--append-system-prompt");
  if (index < 0) throw new Error("argv 里没有 --append-system-prompt");
  return argv[index + 1] ?? "";
}

describe("brief 的传参方式（纯）", () => {
  it("小 brief 传正文，并补一个换行钉死「这是正文不是路径」", () => {
    expect(briefPromptArg("# 开工\n干活", "c1")).toBe("# 开工\n干活");
    // 不含换行的短串会被 omp 当路径去试读：补一个换行
    expect(briefPromptArg("很短", "c1")).toBe("很短\n");
  });

  it("超过阈值的 brief 落盘传路径：omp 自己读，且远小于 argv 上限", () => {
    const brief = `# 大卡片\n${"正".repeat(60_000)}`; // ≈ 180 KB
    const arg = briefPromptArg(brief, "c-big", tempDir("fc-brief-"));

    expect(arg.includes("\n")).toBe(false); // 路径不能含换行（含了就被当正文）
    expect(Buffer.byteLength(arg, "utf8")).toBeLessThan(ARG_STRLEN_LIMIT);
    expect(existsSync(arg)).toBe(true);
    expect(readFileSync(arg, "utf8")).toBe(brief);
  });

  it("连文件都写不出去：截断 + 注明全文在哪，仍然不超上限", () => {
    const brief = `# 大卡片\n${"正".repeat(60_000)}`;
    const arg = briefPromptArg(brief, "c-big", "/dev/null/写不进去");

    expect(arg.includes("\n")).toBe(true); // 还是正文（omp 不会去当路径读）
    expect(Buffer.byteLength(arg, "utf8")).toBeLessThanOrEqual(MAX_INLINE_BRIEF_BYTES);
    expect(arg).toContain("已截断");
    expect(arg).toContain("flowcard show c-big");
  });
});

describe("起会话时 brief 不会把 omp 顶出 argv 上限", () => {
  it("超长 brief：argv 里给的是落盘的路径，而不是 400 KB 的正文", async () => {
    const dataDir = tempDir("fc-brief-store-");
    const worktreePath = tempDir("fc-brief-wt-");
    const store = createStore({ dataDir, flow: personalFlow });
    const opened = store.execute({ cmd: "open", actor: HUMAN, title: "大卡片", body: "" });
    const cardId = opened.card?.id ?? "";

    const captured: StartRpcOptions[] = [];
    const sessions = createHostedSessions({
      store,
      resolveOmpPath: async () => undefined,
      startSession: (options) => {
        captured.push(options);
        return stubSession();
      },
    });

    // 卡片正文上限由 HTTP 体限（1 MiB）兜着：400 KB 是合法尺寸，但早就超过单个 argv 元素的上限
    const brief = `# 你是 flowcard 卡片 ${cardId} 的会话\n${"正".repeat(400_000)}`;
    const started = await sessions.start(cardId, { cwd: worktreePath, brief });

    expect(started.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const argv = captured[0]?.args ?? [];
    const arg = promptArg(argv);

    // 修前：正文原样进 argv（>128 KiB）→ omp 起不来（E2BIG），这里却报 started
    expect(Buffer.byteLength(argv.join("\0"), "utf8")).toBeLessThan(ARG_STRLEN_LIMIT);
    expect(arg.includes("\n")).toBe(false);
    expect(readFileSync(arg, "utf8")).toBe(brief);
    store.close();
  });

  it("普通 brief：正文原样传给 omp（不额外落盘）", async () => {
    const dataDir = tempDir("fc-brief-store-");
    const worktreePath = tempDir("fc-brief-wt-");
    const store = createStore({ dataDir, flow: personalFlow });
    const cardId = store.execute({ cmd: "open", actor: HUMAN, title: "普通卡", body: "" }).card?.id ?? "";

    const captured: StartRpcOptions[] = [];
    const sessions = createHostedSessions({
      store,
      resolveOmpPath: async () => undefined,
      startSession: (options) => {
        captured.push(options);
        return stubSession();
      },
    });

    const brief = `# 你是 flowcard 卡片 ${cardId} 的会话\n按提示干活`;
    await sessions.start(cardId, { cwd: worktreePath, brief });

    expect(promptArg(captured[0]?.args ?? [])).toBe(brief);
    store.close();
  });
});
