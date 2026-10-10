/**
 * omp 适配器的 claim/beat 状态机（假 fetch + 假 ctx，不联网、不碰真服务、不写用户的日志目录）。
 *
 * 要守住的两条（开工链路**总是**带 `FLOWCARD_CARD`，所以这就是主路径）：
 *   1. **首个 claim 没成功（服务重启 / 超时 / SESSION_CONFLICT）→ 下一拍继续 claim**，
 *      不能因为"卡片 id 是显式给的"就以为绑上了 —— 否则 `end` 没送达时卡片永远停在「实施中」，
 *      服务端还把旧会话当活跃，下一个会话一直撞 SESSION_CONFLICT。
 *   2. **心跳没人接（NOT_FOUND，或被服务端静默忽略）→ 退回 claim**，别拿着无效绑定继续心跳。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeCtx = {
  cwd: string;
  agent: { kind: string };
  sessionManager: { getSessionId: () => string; getCwd: () => string; getSessionFile: () => string };
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

const handlers = new Map<string, (payload: unknown, ctx: FakeCtx) => void>();
const ticks: Array<() => void> = [];
const sent: Array<Record<string, unknown>> = [];
const logDir = mkdtempSync(join(tmpdir(), "fc-adapter-"));

/** 适配器里 `void post(...)` 那串 promise 跑完（假 fetch 只走微任务 + 一个 check 阶段）。 */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function ctx(): FakeCtx {
  return {
    cwd: "/tmp/fc-clifix/wt",
    agent: { kind: "main" },
    sessionManager: {
      getSessionId: () => "s1",
      getCwd: () => "/tmp/fc-clifix/wt",
      getSessionFile: () => "/tmp/fc-clifix/s1.json",
    },
    setInterval: (fn: () => void) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => undefined,
  };
}

type Reply = Record<string, unknown>;

/** 假 `/api/commands`：把收到的命令记下来，回复由 `reply(cmd)` 决定。 */
function fakeFetch(reply: (cmd: string) => Reply | "network-down"): void {
  vi.stubGlobal("fetch", async (_url: string, init: { body?: string }) => {
    const command = JSON.parse(String(init.body ?? "{}")) as { cmd: string };
    sent.push(command);
    const body = reply(command.cmd);
    if (body === "network-down") throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

/** 动态 import：模块在**加载时**读 env（FLOWCARD_CARD / 日志路径），所以每个用例都要重新加载。 */
async function loadAdapter(): Promise<void> {
  vi.resetModules();
  const mod = (await import("../src/adapters/omp/flowcard-omp-adapter.ts")) as {
    default: (pi: { on: (event: string, handler: (payload: unknown, ctx: FakeCtx) => void) => void }) => void;
  };
  handlers.clear();
  ticks.length = 0;
  mod.default({ on: (event, handler) => handlers.set(event, handler) });
}

beforeEach(() => {
  sent.length = 0;
  process.env["FLOWCARD_URL"] = "http://127.0.0.1:47899";
  process.env["FLOWCARD_CARD"] = "c1";
  process.env["FLOWCARD_OMP_LOG"] = join(logDir, `adapter-${sent.length}.log`);
  process.env["FLOWCARD_OMP_HEARTBEAT_MS"] = "15000";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("适配器：显式 FLOWCARD_CARD 下的 claim 重试", () => {
  it("首个 claim 失败 → 下一拍继续 claim（不是发心跳）；claim 成功后才转心跳", async () => {
    let claimOk = false;
    fakeFetch((cmd) =>
      cmd === "claim"
        ? claimOk
          ? { ok: true, inserted: 1, duplicates: 0, card: { id: "c1" } }
          : { ok: false, rejection: { code: "SESSION_CONFLICT", message: "卡片已绑定活跃会话 omp:sA" } }
        : { ok: true, inserted: 1, duplicates: 0 },
    );
    await loadAdapter();
    handlers.get("session_start")?.({}, ctx());
    await settle();

    // 启动时的那一拍：claim 失败
    expect(sent.map((c) => c.cmd)).toEqual(["claim"]);
    expect(sent[0]?.["card"]).toBe("c1");

    // 修前：`bound` 恒真 → 这一拍直接发 beat，卡片永远绑不上
    ticks[0]?.();
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "claim"]);

    // 服务端恢复：这一拍 claim 成功，之后才走心跳
    claimOk = true;
    ticks[0]?.();
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "claim", "claim"]);
    ticks[0]?.();
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "claim", "claim", "beat"]);
  });

  it("心跳 NOT_FOUND（卡片还没有会话）→ 立刻退回 claim", async () => {
    fakeFetch((cmd) =>
      cmd === "claim"
        ? { ok: true, inserted: 1, duplicates: 0, card: { id: "c1" } }
        : { ok: false, rejection: { code: "NOT_FOUND", message: "卡片 c1 还没有会话" } },
    );
    await loadAdapter();
    handlers.get("session_start")?.({}, ctx());
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim"]);

    ticks[0]?.();
    await settle();
    // 心跳没人接 → 同一拍里就补一次 claim
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "beat", "claim"]);
  });

  it("心跳被静默忽略（ok:true 但什么都没记）→ 也退回 claim", async () => {
    fakeFetch((cmd) =>
      cmd === "claim"
        ? { ok: true, inserted: 1, duplicates: 0, card: { id: "c1" } }
        : {
            ok: true,
            inserted: 0,
            duplicates: 0,
            notes: ["忽略未知会话 s1 的心跳（卡片绑定的是 sA）"],
          },
    );
    await loadAdapter();
    handlers.get("session_start")?.({}, ctx());
    await settle();

    ticks[0]?.();
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "beat", "claim"]);
  });

  it("端点不可达也不抛：下一拍继续 claim（会话照常）", async () => {
    fakeFetch(() => "network-down");
    await loadAdapter();
    expect(() => handlers.get("session_start")?.({}, ctx())).not.toThrow();
    await settle();
    ticks[0]?.();
    await settle();
    expect(sent.map((c) => c.cmd)).toEqual(["claim", "claim"]);
  });

  it("subagent 会话不绑卡片：一个请求都不发", async () => {
    fakeFetch(() => ({ ok: true, inserted: 1, duplicates: 0 }));
    await loadAdapter();
    const sub = ctx();
    sub.agent = { kind: "sub" };
    handlers.get("session_start")?.({}, sub);
    await settle();
    ticks[0]?.();
    await settle();
    expect(sent).toEqual([]);
  });
});
