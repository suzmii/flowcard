/** 原生选择器与候选仓库扫描：命令可注入，所以不依赖真的弹窗。 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickDirectory, resolvePickerCmd, sessionGraphicalEnv } from "../src/server/picker.ts";
import { projectRootsFromEnv, scanGitRepos } from "../src/server/projects.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("原生目录选择器", () => {
  it("选中路径：取 stdout 最后一行", async () => {
    const result = await pickDirectory({
      startDir: "/tmp",
      commandOverride: { cmd: "sh", args: ["-c", "echo 一些噪声; echo /tmp/some/repo"] },
    });
    expect(result).toEqual({ status: "picked", path: "/tmp/some/repo" });
  });

  it("空输出 = 用户取消", async () => {
    const result = await pickDirectory({
      startDir: "/tmp",
      commandOverride: { cmd: "sh", args: ["-c", "exit 0"] },
    });
    expect(result).toEqual({ status: "cancelled", reason: "user" });
  });

  it("退出码 1 且无 stderr = 用户点了取消", async () => {
    const result = await pickDirectory({
      startDir: "/tmp",
      commandOverride: { cmd: "sh", args: ["-c", "exit 1"] },
    });
    expect(result).toEqual({ status: "cancelled", reason: "user" });
  });

  it("超时 = 当用户取消，并且把进程杀掉", async () => {
    const result = await pickDirectory({
      startDir: "/tmp",
      timeoutMs: 300,
      commandOverride: { cmd: "sh", args: ["-c", "sleep 10"] },
    });
    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" && result.reason).toBe("timeout");
  });

  it("选择器崩了要带回原因，而不是假装取消", async () => {
    const result = await pickDirectory({
      startDir: "/tmp",
      commandOverride: { cmd: "sh", args: ["-c", "echo 'no display' >&2; exit 3"] },
    });
    expect(result.status).toBe("cancelled");
    expect(result.status === "cancelled" && result.reason).toBe("failed");
    expect(result.status === "cancelled" && result.message).toContain("no display");
  });

  it("FLOWCARD_PICKER_CMD 可以覆盖选择器命令", async () => {
    const before = process.env.FLOWCARD_PICKER_CMD;
    process.env.FLOWCARD_PICKER_CMD = "/bin/echo";
    try {
      expect(await resolvePickerCmd()).toBe("/bin/echo");
    } finally {
      if (before === undefined) delete process.env.FLOWCARD_PICKER_CMD;
      else process.env.FLOWCARD_PICKER_CMD = before;
    }
  });

  it("拿不到图形环境也不能抛（返回对象即可）", async () => {
    await expect(sessionGraphicalEnv()).resolves.toBeTypeOf("object");
  });
});

describe("候选仓库扫描", () => {
  it("找出根目录与一层子目录里的 git 仓库，跳过非仓库", async () => {
    const root = tmp("flowcard-scan-");
    const a = join(root, "repo-a");
    const b = join(root, "group", "repo-b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(join(root, "not-repo"), { recursive: true });
    execFileSync("git", ["init", "-q", a]);
    execFileSync("git", ["init", "-q", b]);

    const found = await scanGitRepos([root]);
    expect(found.map((r) => r.name).sort()).toEqual(["repo-a", "repo-b"]);
    expect(found.every((r) => r.path.startsWith(root))).toBe(true);
  });

  it("不往仓库内部继续扫（嵌套仓库不算候选）", async () => {
    const root = tmp("flowcard-scan-nested-");
    const outer = join(root, "outer");
    const inner = join(outer, "packages", "inner");
    mkdirSync(inner, { recursive: true });
    execFileSync("git", ["init", "-q", outer]);
    execFileSync("git", ["init", "-q", inner]);

    const found = await scanGitRepos([root], { depth: 3 });
    expect(found.map((r) => r.name)).toEqual(["outer"]);
  });

  it("depth 限制生效，且不存在的根目录不抛", async () => {
    const root = tmp("flowcard-scan-depth-");
    const deep = join(root, "l1", "l2", "l3", "repo");
    mkdirSync(deep, { recursive: true });
    execFileSync("git", ["init", "-q", deep]);
    writeFileSync(join(root, "note.txt"), "x");

    expect(await scanGitRepos([root], { depth: 1 })).toEqual([]);
    expect((await scanGitRepos([root], { depth: 4 })).map((r) => r.name)).toEqual(["repo"]);
    expect(await scanGitRepos([join(root, "nope")])).toEqual([]);
  });

  it("候选根目录来自 FLOWCARD_PROJECT_ROOTS（冒号分隔），默认 ~/workspace", () => {
    expect(projectRootsFromEnv({ FLOWCARD_PROJECT_ROOTS: "/a:/b/", HOME: "/home/x" })).toEqual(["/a", "/b"]);
    expect(projectRootsFromEnv({ HOME: "/home/x" })).toEqual(["/home/x/workspace"]);
  });
});
