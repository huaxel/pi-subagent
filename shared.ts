import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeOwnedPane, getPane, herdr, ownsPane, processStartTime } from "./herdr.ts";
import {
	existsSync,
	openSync,
	closeSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface Assignment {
	id: string;
	message: string;
	delivery: "auto" | "followUp";
	status: "queued" | "submitted" | "held" | "completed";
	createdAt: string;
	inputEntryId?: string;
	responseEntryId?: string;
	result?: string;
	failed?: boolean;
	notified?: boolean;
}

export interface RunMetadata {
	version: 1;
	revision?: number;
	launchId?: string;
	launchStartedAt?: string;
	launchReadyAt?: string;
	closing?: boolean;
	sessionReplaced?: boolean;
	tasks?: Assignment[];
	waitTaskId?: string;
	parentPid?: number;
	parentStartTime?: string;
	attentionNotified?: string;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	childPid?: number;
	childStartTime?: string;
	paneId?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function registerParent(sessionId: string): void {
	if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid parent session ID");
	const directory = join(getAgentDir(), "subagent-parents"); mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = join(directory, `${sessionId}.json`); const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }), { mode: 0o600 }); renameSync(temporary, file);
}

export function parentIdentity(sessionId: string): { pid: number; startTime: string } {
	if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid parent session ID");
	try {
		const saved = JSON.parse(readFileSync(join(getAgentDir(), "subagent-parents", `${sessionId}.json`), "utf8"));
		if (saved.startTime && processStartTime(saved.pid) === saved.startTime) return saved;
	} catch { /* Older parent extensions have no registration yet. */ }
	// Linux bootstrap for a still-running parent that has not reloaded yet:
	// find the actual enclosing Pi process, never use the transient CLI PID.
	let pid = process.ppid;
	if (process.platform === "linux") for (let depth = 0; depth < 20 && pid > 1; depth++) {
		try {
			const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			const startTime = processStartTime(pid);
			if (name === "pi" && startTime) return { pid, startTime };
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
		} catch { break; }
	}
	throw new Error("Owning Pi process is not registered; reload the parent before spawning");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents-herdr");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			(metadata.paneId !== undefined && typeof metadata.paneId !== "string") ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string" ||
			resolve(metadata.runDir) !== resolve(runDir) ||
			resolve(metadata.sessionFile) !== resolve(runDir, "session.jsonl")
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

/** flock locks the inherited open file description; the parent retains it
 * until closeSync. The kernel releases it even when the process dies. */
function withFileLock<T>(runDir: string, name: string, action: () => T): T {
	const fd = openSync(join(runDir, name), "a", 0o600);
	try {
		const lock = spawnSync("flock", ["--exclusive", "--timeout", "3", "3"], { stdio: ["ignore", "ignore", "pipe", fd] });
		if (lock.error || lock.status !== 0) throw new Error("Could not acquire metadata lock (flock required)");
		return action();
	} finally { closeSync(fd); }
}

export function mutateMetadata(runDir: string, mutate: (current: RunMetadata) => void): RunMetadata | undefined {
	return withFileLock(runDir, "metadata.lock", () => {
		const current = readMetadata(runDir);
		if (!current) return undefined;
		mutate(current);
		current.revision = (current.revision ?? 0) + 1;
		current.updatedAt = new Date().toISOString();
		writeMetadata(current);
		return current;
	});
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	return mutateMetadata(runDir, (current) => {
		const { handle, runDir: directory, version } = current;
		Object.assign(current, patch, { handle, runDir: directory, version });
	});
}

export function enqueueTask(runDir: string, message: string, delivery: "auto" | "followUp" = "auto"): Assignment {
	const task: Assignment = { id: randomBytes(8).toString("hex"), message, delivery, status: "queued", createdAt: new Date().toISOString() };
	const updated = mutateMetadata(runDir, (current) => {
		if (current.closing || current.state === "exited" || current.state === "error") throw new Error("Worker is not accepting assignments");
		(current.tasks ??= []).push(task);
		current.waitTaskId = task.id;
	});
	if (!updated) throw new Error("Worker metadata missing");
	return task;
}

export function holdPending(current: RunMetadata): void {
	// Upgrade old file inboxes non-destructively. They are retained as held
	// assignments, never replayed during a resume.
	if (existsSync(inboxDir(current.runDir))) for (const name of readdirSync(inboxDir(current.runDir)).filter((entry) => entry.endsWith(".json"))) {
		const id = `legacy-${name.slice(0, -5)}`;
		if (current.tasks?.some((task) => task.id === id)) continue;
		try {
			const value = JSON.parse(readFileSync(join(inboxDir(current.runDir), name), "utf8"));
			if (typeof value.message === "string") (current.tasks ??= []).push({ id, message: value.message, delivery: value.delivery === "followUp" ? "followUp" : "auto", status: "held", createdAt: current.updatedAt });
		} catch { current.error = "Malformed legacy inbox retained for inspection"; }
	}
	for (const task of current.tasks ?? []) if (task.status !== "completed") task.status = "held";
	current.waitTaskId = undefined;
}

export function assignmentPrompt(task: Assignment): string {
	return `[Subagent assignment ${task.id}]\n${task.message}`;
}

export function completeTasks(runDir: string, launchId: string): void {
	const metadata = readMetadata(runDir);
	if (!metadata) return;
	const branch = readSessionBranch(metadata.sessionFile);
	mutateMetadata(runDir, (current) => {
		if (current.launchId !== launchId || current.closing) return;
		for (const task of current.tasks ?? []) {
			if (task.status !== "submitted") continue;
			const inputIndex = branch.findIndex((entry) => {
				const message = entry.message as { role?: string; content?: unknown } | undefined;
				if (message?.role !== "user") return false;
				const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
				return content?.includes(`[Subagent assignment ${task.id}]`);
			});
			if (inputIndex < 0) continue;
			// A completed follow-up must not overwrite an earlier assignment's
			// answer. Inputs steered into one turn may share its first final reply.
			const response = branch.slice(inputIndex + 1).find((entry) => isAssistantEntry(entry) && entry.message.stopReason !== "toolUse");
			if (!response || !isAssistantEntry(response)) continue;
			task.inputEntryId = branch[inputIndex].id;
			task.responseEntryId = response.id;
			task.result = assistantText(response.message);
			task.failed = response.message.stopReason === "error" || response.message.stopReason === "aborted";
			task.status = "completed";
		}
	});
}

export function removeRunDir(runDir: string): void {
	if (dirname(resolve(runDir)) !== resolve(getRunsDir()) || !/^[a-z0-9]+$/.test(basename(runDir)))
		throw new Error("Refusing to delete a path outside the subagent runs directory");
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function detachRun(metadata: RunMetadata): void {
	withFileLock(metadata.runDir, "control.lock", () => {
		const current = readMetadata(metadata.runDir);
		if (!current) throw new Error("Run metadata missing");
		const pane = getPane(current.paneId);
		if (pane) {
			if (ownsPane(pane, current.sessionFile, current.childPid, current.childStartTime)) throw new Error("Worker still owns this pane; stop it instead");
			const foreignSession = current.sessionReplaced || pane.agent_session && pane.agent_session.value !== current.sessionFile;
			const oldProcessExited = current.childPid && current.childStartTime && processStartTime(current.childPid) !== current.childStartTime;
			if (!foreignSession && !oldProcessExited) throw new Error("Pane ownership is uncertain; refusing to detach until identity can be verified");
		}
		mutateMetadata(current.runDir, (saved) => { holdPending(saved); saved.paneId = undefined; saved.state = "exited"; saved.closing = false; saved.error = "Detached bookkeeping only; any foreign pane remains untouched"; });
	});
}

export function recoverMissingRun(snapshot: RunMetadata): RunMetadata | undefined {
	return mutateMetadata(snapshot.runDir, (current) => {
		if (current.launchId !== snapshot.launchId || current.paneId !== snapshot.paneId || current.revision !== snapshot.revision || current.closing) return;
		if (!current.launchReadyAt && Date.now() - Date.parse(current.launchStartedAt ?? current.createdAt) < 60000) return;
		holdPending(current); current.state = "error";
		current.error = "Worker disappeared or its pane was repurposed; assignments held and history retained. Inspect before resuming";
	});
}

export function purgeRun(metadata: RunMetadata): void {
	withFileLock(metadata.runDir, "control.lock", () => {
		const current = readMetadata(metadata.runDir);
		if (!current) throw new Error("Run metadata missing");
		if (getPane(current.paneId)) throw new Error("Recorded pane still exists; stop it before purging");
		removeRunDir(current.runDir);
	});
}

export function runIsLive(metadata: RunMetadata): boolean {
	if (metadata.sessionReplaced) return false;
	const pane = getPane(metadata.paneId);
	return !!pane && ownsPane(pane, metadata.sessionFile, metadata.childPid, metadata.childStartTime);
}

export function releaseRun(metadata: RunMetadata, suspended = false): void {
	withFileLock(metadata.runDir, "control.lock", () => {
		const current = readMetadata(metadata.runDir);
		if (!current) throw new Error("Run metadata disappeared; refusing stale stop");
		releaseRunUnlocked(current, suspended);
	});
}

function releaseRunUnlocked(metadata: RunMetadata, suspended: boolean): void {
	mutateMetadata(metadata.runDir, (current) => { current.closing = true; holdPending(current); });
	try {
		if (metadata.sessionReplaced) throw new Error("Worker conversation was replaced; detach retained bookkeeping without closing the human session");
		closeOwnedPane(metadata.paneId, metadata.sessionFile, metadata.childPid, metadata.childStartTime);
		updateMetadata(metadata.runDir, { paneId: undefined, state: "exited", suspended, closing: false });
	} catch (error) {
		mutateMetadata(metadata.runDir, (current) => {
			if (current.launchId !== metadata.launchId || current.paneId !== metadata.paneId) return;
			current.closing = false; current.error = error instanceof Error ? error.message : String(error);
		});
		throw error;
	}
}

/** Start a Pi TUI in a task-owned sibling pane without changing human focus. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	withFileLock(metadata.runDir, "control.lock", () => {
		const current = readMetadata(metadata.runDir);
		if (!current) throw new Error("Run metadata disappeared; refusing stale resume");
		if (getPane(current.paneId)) throw new Error("Recorded pane still exists; inspect and stop it before resuming");
		launchRunUnlocked(current, initialArgs);
	});
}

function launchRunUnlocked(metadata: RunMetadata, initialArgs: string[]): void {
	const layout = herdr(["pane", "layout", "--current"]).layout;
	if (!layout) throw new Error("Herdr did not return a pane layout");
	const rect = layout.panes.find((pane: { pane_id: string }) => pane.pane_id === process.env.HERDR_PANE_ID)?.rect;
	const direction = rect && rect.width > rect.height * 2 ? "right" : "down";
	const launchId = randomBytes(16).toString("hex");
	const args = ["pane", "split", "--current", "--direction", direction, "--no-focus", "--cwd", metadata.cwd,
		"--env", `PI_SUBAGENT_RUN_DIR=${metadata.runDir}`, "--env", `PI_SUBAGENT_LAUNCH_ID=${launchId}`];
	if (process.env.PI_CODING_AGENT_DIR) args.push("--env", `PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`);
	const paneId = herdr(args).pane?.pane_id;
	if (typeof paneId !== "string") throw new Error("Herdr did not return a pane ID");
	mutateMetadata(metadata.runDir, (current) => {
		holdPending(current);
		Object.assign(current, { paneId, launchId, childPid: undefined, childStartTime: undefined, state: "starting", launchStartedAt: new Date().toISOString(), launchReadyAt: undefined, suspended: undefined, closing: false, sessionReplaced: false });
	});
	try {
		herdr(["pane", "rename", paneId, metadata.name ?? `subagent-${metadata.handle}`]);
		herdr(["agent", "start", `subagent-${metadata.handle}`, "--kind", "pi", "--pane", paneId,
			"--", "--session", metadata.sessionFile, "--provider", metadata.provider, "--model", metadata.model,
			"--thinking", metadata.thinking, ...(metadata.launchArgs ?? [])]);
		const deadline = Date.now() + 5000;
		let registered = false;
		while (Date.now() < deadline) {
			const child = readMetadata(metadata.runDir);
			if (child?.childPid && runIsLive(child)) { registered = true; break; }
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
		}
		if (!registered) throw new Error("Child bridge did not register its ownership within 5 seconds");
		updateMetadata(metadata.runDir, { launchReadyAt: new Date().toISOString() });
		if (initialArgs.length) enqueueTask(metadata.runDir, initialArgs.join("\n\n"));
	} catch (error) {
		// This function just created the pane; only close if it is still empty or hosts our session.
		const pane = getPane(paneId);
		if (pane && ((!pane.agent && !pane.agent_session) || ownsPane(pane, metadata.sessionFile, readMetadata(metadata.runDir)?.childPid, readMetadata(metadata.runDir)?.childStartTime))) {
			herdr(["pane", "close", paneId]);
			updateMetadata(metadata.runDir, { paneId: undefined, state: "error" });
		}
		throw error;
	}
}

export function lifecycleAttention(metadata: RunMetadata): string | undefined {
	if (metadata.parentPid && processStartTime(metadata.parentPid) !== metadata.parentStartTime)
		return "Parent process exited; conversation may be orphaned. Inspect before further delegation";
	return metadata.error;
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!runIsLive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readSessionBranch(sessionFile: string): SessionEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries);
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	return readSessionBranch(sessionFile).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
