/**
 * flowcard ⇄ omp adapter (M0 spike).
 *
 * Loaded by omp itself as an *extension module* — it is not imported by the
 * flowcard server. See README.md for the exact load command and the evidence
 * behind every claim below.
 *
 * What it does, and nothing else:
 *   session_start    -> POST session.started  (once)
 *   every N ms       -> POST session.heartbeat
 *   session_shutdown -> POST session.ended    (once)
 *
 * Every attempt is also appended to a local log file, so the spike still shows
 * evidence when no receiver is listening.
 */

// node:fs is fine: omp runs extensions in its own Bun process, and `export
// default function` is the factory contract (`getExtensionFactory` in
// extension-loading.md).
import { appendFileSync } from "node:fs";

/** Endpoint + log file are env-overridable so the spike is repeatable. */
const ENDPOINT = process.env.FLOWCARD_OMP_ENDPOINT ?? "http://127.0.0.1:47824/hook";
const LOG_PATH = process.env.FLOWCARD_OMP_LOG ?? "/tmp/omp-adapter-spike.log";
const HEARTBEAT_MS = Number(process.env.FLOWCARD_OMP_HEARTBEAT_MS ?? 30_000);

/**
 * `session_shutdown` handlers are raced against a 2s budget
 * (`SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS` in extensibility/extensions/runner.ts),
 * so a hung POST must not hold the shutdown open.
 */
const POST_TIMEOUT_MS = 1_500;

type FlowcardEventType = "session.started" | "session.heartbeat" | "session.ended";

/**
 * Placeholder flowcard contract (see README "上报契约"). The first six fields
 * are the agreed shape; `agentKind` / `agentId` / `sessionFile` are extras this
 * spike adds so the server can tell main sessions from subagent sessions and
 * can see what omp reports as the session file.
 */
interface FlowcardEvent {
	type: FlowcardEventType;
	harness: "omp";
	sessionId: string;
	cwd: string;
	at: string;
	agentKind: "main" | "sub";
	agentId: string;
	sessionFile?: string;
}

/**
 * Minimal structural view of omp's `ExtensionContext` / `ExtensionAPI`
 * (`@oh-my-pi/pi-coding-agent`, `src/extensibility/extensions/types.ts`).
 *
 * Declared locally instead of `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`
 * so this file stays type-checkable by flowcard's `tsc --noEmit` without adding
 * an omp dependency to flowcard's package.json. Only the members used below are
 * listed; the runtime object omp passes has many more.
 */
interface OmpSessionManager {
	getSessionId(): string;
	getSessionFile(): string | undefined;
}
interface OmpAgentIdentity {
	kind: "main" | "sub";
	id: string;
}
interface OmpContext {
	cwd: string;
	sessionManager: OmpSessionManager;
	agent: OmpAgentIdentity;
	/** Managed timer: contained throws, unref'd, auto-cleared on session_shutdown. */
	setInterval(callback: () => void, ms: number): unknown;
	clearTimer(timer: unknown): void;
}
interface OmpExtensionApi {
	logger: { debug(message: string, meta?: Record<string, unknown>): void };
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: OmpContext) => unknown): void;
}

/** Best-effort file logging: a failure here must never disturb the session. */
function log(line: string): void {
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
	} catch {
		/* ignore */
	}
}

async function send(type: FlowcardEventType, ctx: OmpContext): Promise<void> {
	let payload: FlowcardEvent;
	try {
		const sessionFile = ctx.sessionManager.getSessionFile();
		payload = {
			type,
			harness: "omp",
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			at: new Date().toISOString(),
			agentKind: ctx.agent.kind,
			agentId: ctx.agent.id,
			...(sessionFile ? { sessionFile } : {}),
		};
	} catch (error) {
		log(`ERROR building ${type} payload: ${String(error)}`);
		return;
	}

	try {
		const response = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(POST_TIMEOUT_MS),
		});
		log(`POST ${type} -> ${response.status} ${JSON.stringify(payload)}`);
	} catch (error) {
		log(`POST ${type} FAILED (${String(error)}) ${JSON.stringify(payload)}`);
	}
}

/**
 * Factory signature required by omp: the default export must be a function
 * receiving the extension API (`getExtensionFactory` in extension-loading.md).
 * omp rebinds this factory to every session in the process, so the closure
 * below is per session.
 */
export default function flowcardOmpAdapter(pi: OmpExtensionApi): void {
	let heartbeat: unknown;

	pi.on("session_start", async (_event, ctx) => {
		await send("session.started", ctx);
		heartbeat = ctx.setInterval(() => {
			void send("session.heartbeat", ctx);
		}, HEARTBEAT_MS);
		pi.logger.debug("flowcard adapter: session started", {
			endpoint: ENDPOINT,
			heartbeatMs: HEARTBEAT_MS,
			agentKind: ctx.agent.kind,
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeat !== undefined) {
			ctx.clearTimer(heartbeat);
			heartbeat = undefined;
		}
		await send("session.ended", ctx);
	});
}
