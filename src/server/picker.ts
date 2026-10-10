/**
 * 原生目录选择器：让后台服务把"选文件夹"的对话框弹到用户的桌面上。
 *
 * 为什么不是浏览器 API：浏览器**拿不到绝对路径**（`webkitRelativePath` 是相对路径，
 * 这是安全边界），所以"选项目" 这件事只能在服务端唤起桌面对话框。
 *
 * 服务是 systemd --user 起的，进程环境里没有图形变量；而桌面会话通常已经把自己的环境
 * 导入到用户级 systemd（`systemctl --user show-environment` 能看到 DISPLAY/WAYLAND_DISPLAY/
 * XAUTHORITY/DBUS_SESSION_BUS_ADDRESS）。所以唤起前先把这些变量读出来合并给子进程。
 *
 * 选择器命令可用 `FLOWCARD_PICKER_CMD` 覆盖（测试注入桩程序用；也方便你换 kdialog/portal）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ENV_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
] as const;

export type PickResult =
  | { status: "picked"; path: string }
  | { status: "cancelled"; reason: "user" | "timeout" | "no-picker" | "failed"; message?: string };

/** 桌面会话的图形变量（拿不到就返回空对象，不抛）。 */
export async function sessionGraphicalEnv(): Promise<Record<string, string>> {
  try {
    const { stdout } = await run("systemctl", ["--user", "show-environment"], {
      timeout: 3000,
      maxBuffer: 1 << 20,
    });
    const env: Record<string, string> = {};
    for (const line of stdout.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      if ((ENV_KEYS as readonly string[]).includes(key)) env[key] = line.slice(eq + 1);
    }
    return env;
  } catch {
    return {};
  }
}

/** 当前可用的选择器命令（`{cmd, args}`），没有就返回 undefined。 */
export async function resolvePickerCmd(): Promise<string | undefined> {
  const override = process.env.FLOWCARD_PICKER_CMD;
  if (override) return override;
  for (const candidate of ["zenity", "kdialog"]) {
    try {
      await run("sh", ["-c", `command -v ${candidate}`], { timeout: 2000 });
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

function pickerArgs(cmd: string, title: string, startDir: string): string[] {
  // 两种程序的目录选择参数不同：zenity 用 --file-selection --directory，kdialog 用 --getexistingdirectory
  const z = cmd.endsWith("zenity");
  return z
    ? ["--file-selection", "--directory", "--title", title, `--filename=${startDir.replace(/\/?$/, "/")}`]
    : ["--getexistingdirectory", startDir, "--title", title];
}

/**
 * 唤起对话框等用户选目录。`timeoutMs` 到了就当"用户取消"（对话框进程会被杀掉，
 * 只杀我们自己起的这个进程）。
 */
export async function pickDirectory(opts: {
  startDir: string;
  title?: string;
  timeoutMs?: number;
  /** 测试/脚本注入：覆盖选择器命令与参数 */
  commandOverride?: { cmd: string; args: string[] };
}): Promise<PickResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const title = opts.title ?? "选择项目仓库（flowcard）";
  const env = { ...process.env, ...(await sessionGraphicalEnv()) };

  let cmd: string;
  let args: string[];
  if (opts.commandOverride) {
    cmd = opts.commandOverride.cmd;
    args = opts.commandOverride.args;
  } else {
    const resolved = await resolvePickerCmd();
    if (!resolved) {
      return {
        status: "cancelled",
        reason: "no-picker",
        message: "没找到可用的目录选择器：装 zenity 或 kdialog，或用 FLOWCARD_PICKER_CMD 指定",
      };
    }
    cmd = resolved;
    args = pickerArgs(resolved, title, opts.startDir);
  }

  try {
    const { stdout } = await run(cmd, args, { timeout: timeoutMs, env, maxBuffer: 1 << 20 });
    const path = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!path) return { status: "cancelled", reason: "user" };
    return { status: "picked", path };
  } catch (error) {
    const err = error as { killed?: boolean; signal?: string; code?: number | string; stderr?: string };
    if (err.killed || err.signal === "SIGTERM") return { status: "cancelled", reason: "timeout" };
    // zenity/kdialog 用户点取消：退出码 1，stderr 通常为空
    if (err.code === 1 && !err.stderr?.trim()) return { status: "cancelled", reason: "user" };
    return {
      status: "cancelled",
      reason: "failed",
      message: `${cmd} 失败（exit=${String(err.code)}${
        err.stderr?.trim() ? `：${err.stderr.trim().slice(0, 200)}` : ""
      }）`,
    };
  }
}
