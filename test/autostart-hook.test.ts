/** 开卡即开工：`POST /api/commands {cmd:"open"}` 之后应当自动起会话（这里用注入的假实现验）。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { createStore } from "../src/server/store.ts";
import { personalFlow } from "../src/flow/personal.ts";

const HUMAN = { kind: "human" as const, name: "tester" };

function harness(opts: { enabled: boolean; launchOk?: boolean; projectPath?: string | null }) {
  const dataDir = mkdtempSync(join(tmpdir(), "flowcard-autostart-"));
  const store = createStore({ dataDir, flow: personalFlow });
  const launched: string[] = [];
  const projectPath = opts.projectPath === undefined ? "/tmp/proj" : opts.projectPath;

  if (projectPath !== null) {
    store.upsertProject({
      id: "proj-1",
      name: "proj",
      path: projectPath,
      defaultBranch: "master",
      addedAt: "2026-10-10T00:00:00.000Z",
      lastSeenAt: "2026-10-10T00:00:00.000Z",
    });
  }

  const app = createApp(store, {
    autostart: {
      enabled: opts.enabled,
      dataDir,
      adapterPath: "/repo/src/adapters/omp/flowcard-omp-adapter.ts",
      cli: "flowcard",
      launch: async ({ worktreePath }) => {
        launched.push(worktreePath);
        return opts.launchOk === false
          ? { ok: false, reason: "no-terminal", message: "没找到可用的终端" }
          : { ok: true, terminal: "konsole", command: "omp …" };
      },
      resolveOmpPath: async () => "/home/u/.bun/bin/omp",
      writeBrief: async () => ({ written: true }),
    },
  });

  return { app, store, launched, dataDir };
}

async function openCard(app: ReturnType<typeof createApp>, projectId: string) {
  const res = await app.request("/api/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "open", actor: HUMAN, title: "开一张卡", body: "正文", projectId }),
  });
  return (await res.json()) as {
    card?: { id: string; state: string };
    autostart?: { status: string; cwd?: string; summary: string };
  };
}

describe("开卡即开工", () => {
  it("open 成功后自动起会话，并把结果放进响应", async () => {
    const { app, launched } = harness({ enabled: true });
    const body = await openCard(app, "proj-1");
    expect(body.card?.id).toBe("c1");
    expect(body.autostart?.status).toBe("started");
    expect(body.autostart?.cwd).toBe("/tmp/proj");
    expect(launched).toEqual(["/tmp/proj"]);
  });

  it("起会话失败也不静默：响应里带 summary，卡片上留一条评论", async () => {
    const { app, store } = harness({ enabled: true, launchOk: false });
    const body = await openCard(app, "proj-1");
    expect(body.autostart?.status).toBe("failed");
    expect(body.autostart?.summary).toContain("会话没起来");
    const comments = store.getCard("c1")?.comments.map((c) => c.body).join("\n") ?? "";
    expect(comments).toContain("没起来会话");
    expect(comments).toContain("omp");
  });

  it("`enabled: false` 时只开卡，不起会话", async () => {
    const { app, launched } = harness({ enabled: false });
    const body = await openCard(app, "proj-1");
    expect(body.card?.id).toBe("c1");
    expect(body.autostart).toBeUndefined();
    expect(launched).toEqual([]);
  });

  it("未归属（无项目）的卡：跳过并说明，不算失败", async () => {
    const { app, launched } = harness({ enabled: true, projectPath: null });
    const body = await openCard(app, "local");
    expect(body.autostart?.status).toBe("skipped");
    expect(body.autostart?.summary).toContain("未归属");
    expect(launched).toEqual([]);
  });

  it("被拒的命令不会触发起会话", async () => {
    const { app, launched } = harness({ enabled: true });
    const res = await app.request("/api/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // actor.kind 不在枚举里 → zod 拦下（400），且 open 没成功就不该起会话
      body: JSON.stringify({ cmd: "open", actor: { kind: "bogus" }, title: "会被拒" }),
    });
    expect(res.status).toBe(400);
    expect(launched).toEqual([]);
  });
});
