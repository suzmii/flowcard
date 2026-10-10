/**
 * 卡片运行时的启动配置：「每个项目怎么启动」是可配置的。
 *
 * 两个来源（字段级合并，**仓库内优先**）：
 *   1. 项目仓库内 `.flowcard.toml`（跟代码走、可 review、可回滚）—— 主来源
 *   2. `~/.config/flowcard/projects.toml`（`FLOWCARD_CONFIG_DIR` 可覆盖）—— 兜底/覆盖仓库没写的字段
 *
 * 这里自带一个 TOML 子集解析器（不引运行期依赖）：表头 `[a.b]`、点号键、基本/字面字符串、
 * 整数/浮点、布尔、数组、内联表。够描述 `[runtime]` 段，写错了会给出「文件:行号」的人话错误。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ------------------------------------------------------------------ TOML 子集

export type TomlTable = { [key: string]: TomlValue };
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

const table = (): TomlTable => Object.create(null) as TomlTable;
const isTable = (v: TomlValue | undefined): v is TomlTable =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function tomlFail(file: string, line: number, message: string): never {
  throw new Error(`${file}:${line}: ${message}`);
}

/** 去掉行内注释（引号里的 # 不算注释）。 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** 找顶层 `=`（引号内不算）。 */
function topLevelEq(line: string): number {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "=") return i;
  }
  return -1;
}

/** 按顶层分隔符切分（引号内不切）。 */
function splitTopLevel(input: string, sep: string): string[] | null {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) return null;
  out.push(input.slice(start));
  return out;
}

function unquote(raw: string, file: string, line: number): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
      switch (esc) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case '"':
          return '"';
        case "\\":
          return "\\";
        default:
          if (esc.startsWith("u")) return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
          tomlFail(file, line, `不支持的转义 \\${esc}`);
      }
    });
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/** 解析 `[a."b.c".d]` / `a.b = 1` 的键路径。 */
function parseKeyPath(raw: string, file: string, line: number): string[] {
  const parts = splitTopLevel(raw, ".");
  if (!parts) tomlFail(file, line, `键名不合法（引号或括号没闭合）：${raw}`);
  const keys = parts.map((p) => unquote(p, file, line).trim());
  if (keys.length === 0 || keys.some((k) => k === "")) {
    tomlFail(file, line, `键名不合法（有空段）：${raw}`);
  }
  return keys;
}

function parseValue(raw: string, file: string, line: number): TomlValue {
  const v = raw.trim();
  if (v === "") tomlFail(file, line, "缺少值");
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0]!;
    if (!v.endsWith(quote) || v.length < 2) tomlFail(file, line, `字符串没有闭合：${v}`);
    return unquote(v, file, line);
  }
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) tomlFail(file, line, `数组没有闭合：${v}`);
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    const parts = splitTopLevel(inner, ",");
    if (!parts) tomlFail(file, line, `数组不合法：${v}`);
    return parts
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map((p) => parseValue(p, file, line));
  }
  if (v.startsWith("{")) {
    if (!v.endsWith("}")) tomlFail(file, line, `内联表没有闭合：${v}`);
    const out = table();
    const inner = v.slice(1, -1).trim();
    if (inner === "") return out;
    for (const pair of splitTopLevel(inner, ",") ?? []) {
      if (pair.trim() === "") continue;
      const eq = topLevelEq(pair);
      if (eq < 0) tomlFail(file, line, `内联表项不是 key = value：${pair.trim()}`);
      const keys = parseKeyPath(pair.slice(0, eq), file, line);
      const target = keys.length > 1 ? ensureTable(out, keys.slice(0, -1), file, line) : out;
      target[keys[keys.length - 1]!] = parseValue(pair.slice(eq + 1), file, line);
    }
    return out;
  }
  if (v === "true") return true;
  if (v === "false") return false;
  const num = v.replace(/_/g, "");
  if (/^[+-]?\d+$/.test(num)) return Number.parseInt(num, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(num)) return Number.parseFloat(num);
  tomlFail(file, line, `不认识的值：${v}`);
}

function ensureTable(root: TomlTable, path: string[], file: string, line: number): TomlTable {
  let cur = root;
  for (const key of path) {
    const existing = Object.hasOwn(cur, key) ? cur[key] : undefined;
    if (existing === undefined) {
      const fresh = table();
      cur[key] = fresh;
      cur = fresh;
      continue;
    }
    if (!isTable(existing)) tomlFail(file, line, `键 ${key} 已经是值，不能当表用`);
    cur = existing;
  }
  return cur;
}

export function parseToml(text: string, file = "<toml>"): TomlTable {
  const root = table();
  let current = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]!).trim();
    if (line === "") continue;
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) tomlFail(file, lineNo, `表头没有闭合的 ]：${line}`);
      const inner = line.slice(1, -1).trim();
      if (inner.startsWith("[") || inner === "") tomlFail(file, lineNo, `不支持的数组表头：${line}`);
      current = ensureTable(root, parseKeyPath(inner, file, lineNo), file, lineNo);
      continue;
    }
    const eq = topLevelEq(line);
    if (eq < 0) tomlFail(file, lineNo, `不是合法的 key = value：${line}`);
    const keys = parseKeyPath(line.slice(0, eq), file, lineNo);
    const value = parseValue(line.slice(eq + 1), file, lineNo);
    const parent = keys.length > 1 ? ensureTable(current, keys.slice(0, -1), file, lineNo) : current;
    parent[keys[keys.length - 1]!] = value;
  }
  return root;
}

// ------------------------------------------------------------------ 配置类型

export type RuntimeConfigErrorCode = "NO_PROJECT" | "NO_CONFIG" | "BAD_CONFIG";

/** 配置问题一律是这个错误：调用方把它翻成人话给用户（启动按钮不该崩）。 */
export class RuntimeConfigError extends Error {
  readonly code: RuntimeConfigErrorCode;
  readonly searched: string[];
  readonly hint?: string;

  constructor(
    code: RuntimeConfigErrorCode,
    message: string,
    opts?: { hint?: string | undefined; searched?: string[] | undefined },
  ) {
    super(message);
    this.name = "RuntimeConfigError";
    this.code = code;
    this.searched = opts?.searched ?? [];
    if (opts?.hint) this.hint = opts.hint;
  }
}

/** 就绪判定：按端口探活、按日志正则、或「进程不退出就算就绪」。 */
export type ReadySpec =
  | { kind: "port"; port: number; timeoutMs: number }
  | { kind: "log"; pattern: string; timeoutMs: number }
  /** skipSettle = spawn 成功立刻算就绪（`ready.exit = false`），不查「起完就死」 */
  | { kind: "proc"; timeoutMs: number; skipSettle?: boolean };

/** true = 全局单例（启一张就停其他所有卡）；"project" = 只在同项目内互斥；false = 不互斥。 */
export type SingletonMode = boolean | "project";

export type RuntimeConfig = {
  /** shell 命令，交给 `/bin/sh -c` 执行 */
  cmd: string;
  /** 工作目录，相对卡片 worktree 根（默认就是 worktree 根） */
  cwd?: string;
  env: Record<string, string>;
  /** 探活与冲突提示用的端口 */
  ports: number[];
  ready: ReadySpec;
  singleton: SingletonMode;
  /** 卡片 worktree / 项目根 */
  root: string;
  projectRoot: string;
  /** 实际读到的配置文件（按优先级） */
  sources: string[];
};

const DEFAULT_TIMEOUT_MS = 30_000;

type PartialRuntime = {
  cmd?: string;
  cwd?: string;
  env?: Record<string, string>;
  ports?: number[];
  ready?: ReadySpec;
  singleton?: SingletonMode;
};

const RUNTIME_KEYS = new Set(["cmd", "cwd", "env", "ports", "ready", "singleton", "runtime"]);

function runtimeFail(file: string, message: string): never {
  throw new RuntimeConfigError("BAD_CONFIG", `${file}: ${message}`);
}

function readString(value: TomlValue | undefined, file: string, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") runtimeFail(file, `字段 ${key} 必须是非空字符串`);
  return value;
}

function readRuntimeTable(entry: TomlTable, file: string, where: string): PartialRuntime {
  const nested = Object.hasOwn(entry, "runtime") ? entry["runtime"] : undefined;
  if (nested !== undefined && !isTable(nested)) runtimeFail(file, `${where}.runtime 必须是表`);
  // 仓库内是 [runtime] 段；全局那份的键直接写在项目段里（也允许再套一层 runtime）。
  const flat: TomlTable = table();
  for (const [key, value] of Object.entries(entry)) {
    if (key !== "runtime") flat[key] = value;
  }
  const t: TomlTable = isTable(nested) ? { ...flat, ...nested } : flat;

  for (const key of Object.keys(t)) {
    if (key === "runtime") continue;
    if (!RUNTIME_KEYS.has(key)) {
      runtimeFail(
        file,
        `${where} 有不认识的字段 "${key}"（可用：cmd / cwd / env / ports / ready / singleton）`,
      );
    }
  }

  const out: PartialRuntime = {};
  const cmd = readString(t["cmd"], file, "cmd");
  if (cmd !== undefined) out.cmd = cmd;
  const cwd = readString(t["cwd"], file, "cwd");
  if (cwd !== undefined) out.cwd = cwd;

  const envRaw = t["env"];
  if (envRaw !== undefined) {
    if (!isTable(envRaw)) runtimeFail(file, `字段 env 必须是表（[runtime.env] K = "V"）`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRaw)) {
      if (typeof v !== "string") runtimeFail(file, `env.${k} 必须是字符串`);
      env[k] = v;
    }
    out.env = env;
  }

  const portsRaw = t["ports"];
  if (portsRaw !== undefined) {
    if (!Array.isArray(portsRaw)) runtimeFail(file, `字段 ports 必须是数组，如 [5173, 8080]`);
    out.ports = portsRaw.map((p) => {
      if (typeof p !== "number" || !Number.isInteger(p) || p <= 0 || p > 65_535) {
        runtimeFail(file, `ports 里的每一项都必须是 1-65535 的整数，收到 ${JSON.stringify(p)}`);
      }
      return p;
    });
  }

  const singletonRaw = t["singleton"];
  if (singletonRaw !== undefined) {
    if (typeof singletonRaw === "boolean") out.singleton = singletonRaw;
    else if (singletonRaw === "project") out.singleton = "project";
    else runtimeFail(file, `字段 singleton 必须是 true / false / "project"`);
  }

  const readyRaw = t["ready"];
  if (readyRaw !== undefined) {
    if (!isTable(readyRaw)) {
      runtimeFail(file, `字段 ready 必须是表（[runtime.ready] port = 5173 / log = "…" / exit = true）`);
    }
    for (const key of Object.keys(readyRaw)) {
      if (!["port", "log", "exit", "timeout"].includes(key)) {
        runtimeFail(file, `ready 有不认识的字段 "${key}"（可用：port / log / exit / timeout）`);
      }
    }
    const timeoutSec = readyRaw["timeout"];
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (timeoutSec !== undefined) {
      if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        runtimeFail(file, `ready.timeout 必须是正数（秒）`);
      }
      timeoutMs = Math.round(timeoutSec * 1000);
    }
    const port = readyRaw["port"];
    const log = readyRaw["log"];
    const exit = readyRaw["exit"];
    const picked = [port !== undefined, log !== undefined, exit !== undefined].filter(Boolean).length;
    if (picked > 1) runtimeFail(file, `ready 里 port / log / exit 只能写一个`);
    if (port !== undefined) {
      if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65_535) {
        runtimeFail(file, `ready.port 必须是 1-65535 的整数`);
      }
      out.ready = { kind: "port", port, timeoutMs };
    } else if (log !== undefined) {
      if (typeof log !== "string" || log === "") runtimeFail(file, `ready.log 必须是非空正则字符串`);
      try {
        new RegExp(log);
      } catch (error) {
        runtimeFail(file, `ready.log 不是合法正则：${String(error)}`);
      }
      out.ready = { kind: "log", pattern: log, timeoutMs };
    } else if (exit !== undefined) {
      if (typeof exit !== "boolean") runtimeFail(file, `ready.exit 必须是 true / false`);
      out.ready = exit ? { kind: "proc", timeoutMs } : { kind: "proc", timeoutMs, skipSettle: true };
    } else {
      out.ready = { kind: "proc", timeoutMs };
    }
  }

  return out;
}

export type RepoConfigLookup = { projectRoot: string; configPath?: string };

/**
 * 从某个目录往上找项目根与最近的 `.flowcard.toml`。
 *
 * 项目根判据是「`.git` 是**目录**」——linked worktree 里 `.git` 是个**文件**
 * （内容 `gitdir: <主仓库>/.git/worktrees/<名字>`），那种要**继续往上走**，
 * 否则每张卡的 worktree 都会被当成独立项目（配置找不到 + `singleton = "project"` 认不出同一项目）。
 */
export function findRepoConfig(startDir: string): RepoConfigLookup {
  let dir = resolve(startDir);
  let projectRoot = dir;
  let configPath: string | undefined;
  for (let depth = 0; depth < 64; depth++) {
    const candidate = join(dir, ".flowcard.toml");
    if (!configPath && existsSync(candidate)) configPath = candidate;
    let isRepoRoot = false;
    try {
      isRepoRoot = statSync(join(dir, ".git")).isDirectory();
    } catch {
      isRepoRoot = false;
    }
    if (isRepoRoot) {
      projectRoot = dir;
      break;
    }
    const parent = dirname(dir);
    projectRoot = dir;
    if (parent === dir) break;
    dir = parent;
  }
  if (!configPath && existsSync(join(projectRoot, ".flowcard.toml"))) {
    configPath = join(projectRoot, ".flowcard.toml");
  }
  return { projectRoot, ...(configPath ? { configPath } : {}) };
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env["FLOWCARD_CONFIG_DIR"]) return env["FLOWCARD_CONFIG_DIR"];
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "flowcard");
}

export type ResolveRuntimeConfigOptions = {
  /** 卡片 worktree 根（缺 worktree 时用 repoPath） */
  root: string;
  /** 全局兜底配置目录，默认 `~/.config/flowcard` */
  configDir?: string;
};

/**
 * 合并两个来源、校验、补默认值。取不到配置时抛 `RuntimeConfigError`（带人话 message + searched）。
 */
export function resolveRuntimeConfig(opts: ResolveRuntimeConfigOptions): RuntimeConfig {
  const root = resolve(opts.root);
  if (!existsSync(root)) {
    throw new RuntimeConfigError("NO_PROJECT", `卡片的工作目录不存在：${root}`, {
      hint: "先给卡片绑定 worktree（flowcard worktree <card> --path … --branch …）",
    });
  }

  const repo = findRepoConfig(root);
  const configDir = opts.configDir ?? defaultConfigDir();
  const globalFile = join(configDir, "projects.toml");
  const sources: string[] = [];
  const searched: string[] = [...(repo.configPath ? [repo.configPath] : []), globalFile];

  let repoPartial: PartialRuntime = {};
  if (repo.configPath) {
    sources.push(repo.configPath);
    repoPartial = readRuntimeTable(parseFile(repo.configPath), repo.configPath, "runtime");
  }

  let globalPartial: PartialRuntime = {};
  if (existsSync(globalFile)) {
    const globalRoot = parseFile(globalFile);
    const keyed = Object.keys(globalRoot).map((key) => ({
      key,
      path: (key.length > 1 ? key.replace(/\/+$/, "") : key) || "/",
      entry: globalRoot[key]!,
    }));
    // 祖先路径也可能配：从最泛到最具体依次覆盖，具体的那份赢。
    keyed.sort((a, b) => a.path.length - b.path.length);
    for (const { key, path, entry } of keyed) {
      if (!isTable(entry)) {
        throw new RuntimeConfigError(
          "BAD_CONFIG",
          `${globalFile}: "${key}" 必须是表（["<项目绝对路径>"]）`,
        );
      }
      const matched =
        repo.projectRoot === path || repo.projectRoot.startsWith(path === "/" ? "/" : `${path}/`);
      if (!matched) continue;
      const partial = readRuntimeTable(entry, globalFile, `"${key}"`);
      globalPartial = {
        ...globalPartial,
        ...partial,
        env: { ...globalPartial.env, ...partial.env },
      };
      if (Object.keys(partial).length > 0 && !sources.includes(globalFile)) sources.push(globalFile);
    }
  }

  const pick = <K extends keyof PartialRuntime>(key: K): PartialRuntime[K] =>
    repoPartial[key] ?? globalPartial[key];

  const cmd = pick("cmd");
  if (!cmd) {
    throw new RuntimeConfigError(
      "NO_CONFIG",
      `项目 ${repo.projectRoot} 还没有启动配置，不知道该跑什么`,
      {
        hint:
          `在 ${repo.projectRoot}/.flowcard.toml 写 [runtime] cmd = "…"；` +
          `或在 ${globalFile} 写 ["${repo.projectRoot}"] cmd = "…"`,
        searched,
      },
    );
  }

  const ports = pick("ports") ?? [];
  const ready =
    pick("ready") ??
    (ports.length > 0 && ports[0] !== undefined
      ? ({ kind: "port", port: ports[0], timeoutMs: DEFAULT_TIMEOUT_MS } as const)
      : ({ kind: "proc", timeoutMs: DEFAULT_TIMEOUT_MS } as const));

  const cwdRaw = pick("cwd");
  const cwd = cwdRaw === undefined ? undefined : isAbsolute(cwdRaw) ? cwdRaw : join(root, cwdRaw);

  const config: RuntimeConfig = {
    cmd,
    env: { ...globalPartial.env, ...repoPartial.env },
    ports,
    ready,
    singleton: pick("singleton") ?? true,
    root,
    projectRoot: repo.projectRoot,
    sources,
  };
  if (cwd !== undefined) config.cwd = cwd;
  return config;
}

function parseFile(file: string): TomlTable {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new RuntimeConfigError("BAD_CONFIG", `读不了配置文件 ${file}：${String(error)}`);
  }
  try {
    return parseToml(text, file);
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw error;
    throw new RuntimeConfigError("BAD_CONFIG", String(error instanceof Error ? error.message : error));
  }
}
