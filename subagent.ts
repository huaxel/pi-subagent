#!/usr/bin/env node

import type { RunMetadata } from "./shared.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	detachRun,
	parentIdentity,
	lifecycleAttention,
	enqueueTask,
	effectiveRunState,
	getRunsDir,
	inboxDir,
	launchRun,
	listRuns,
	readMetadata,
	purgeRun,
	runDisplayName,
	isValidRunName,
	runIsLive,
	releaseRun,
	updateMetadata,
	writeMetadata,
} from "./shared.ts";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] [--no-extensions] [--no-skills]
    [--no-prompt-templates] [--no-context-files] (--prompt <text> | --file <path>)...
  subagent detach <handle>
  subagent pending <handle>
  subagent status <handle>
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--task <id>] [--timeout <seconds>]
  subagent stop <handle>
  subagent resume <handle>
  subagent purge <handle> --confirm
  subagent list`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

function runDirForHandle(handle: string): string {
	if (!/^[a-z0-9]+$/.test(handle)) fail(`Invalid subagent handle: ${handle}`);
	return join(getRunsDir(), handle);
}

function getRun(handle: string): RunMetadata {
	const metadata = readMetadata(runDirForHandle(handle));
	if (!metadata) fail(`Unknown subagent: ${handle}`);
	if (!process.env.PI_SESSION_ID) fail("PI_SESSION_ID is required; run this command through the owning Pi session");
	if (metadata.parentSessionId !== process.env.PI_SESSION_ID)
		fail(`Subagent ${handle} belongs to another parent session`);
	return metadata;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function spawnSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	if (!process.env.PI_SESSION_ID) fail("PI_SESSION_ID is required; spawn through a Pi session");
	if (process.env.HERDR_ENV !== "1") fail("Subagents require a Herdr-managed pane (HERDR_ENV=1)");
	let name: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	let cwd = process.cwd();
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and PI_PROVIDER is not set");
	if (!model) fail("No model specified and PI_MODEL is not set");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((name) => name.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) launchArgs.push("--no-extensions");
	launchArgs.push("--extension", extensionPath);
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const parent = parentIdentity(process.env.PI_SESSION_ID);
	const now = new Date().toISOString();
	const metadata: RunMetadata = {
		version: 1,
		handle,
		name,
		parentSessionId: process.env.PI_SESSION_ID || undefined,
		parentPid: parent.pid,
		parentStartTime: parent.startTime,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
		runDir,
		sessionFile,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		state: "starting",
		hasStarted: false,
		createdAt: now,
		updatedAt: now,
	};
	writeMetadata(metadata);

	const initialArgs = files.map((file) => `File: ${file}\n${readFileSync(file, "utf8")}`);
	if (prompts.length > 0) initialArgs.push(`Task:\n${prompts.join("\n\n")}`);
	try {
		launchRun(metadata, initialArgs);
	} catch (error) {
		updateMetadata(runDir, { state: "error", error: error instanceof Error ? error.message : String(error) });
		throw error;
	}

	process.stdout.write(`Spawned ${runDisplayName(metadata)}\nTask: ${readMetadata(runDir)?.waitTaskId}\nState: busy\nPane: ${readMetadata(runDir)?.paneId ?? "unavailable"}\n`);
}

function statusSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	process.stdout.write(
		`${runDisplayName(metadata)}: ${effectiveRunState(metadata)} (${metadata.provider}/${metadata.model}, ${metadata.thinking})\nPane: ${metadata.paneId ?? "released"}\nTranscript: ${metadata.sessionFile}\nTask: ${metadata.waitTaskId ?? "none (idle resume)"}\nAttention: ${lifecycleAttention(metadata) ?? "none"}\n`,
	);
}

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const metadata = getRun(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateMetadata(metadata.runDir, { name });
	if (!updated) fail(`Could not rename subagent: ${metadata.handle}`);
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const metadata = getRun(handle);
	if (!runIsLive(metadata)) fail(`${handle} is not running`);

	const task = enqueueTask(metadata.runDir, message, followUp ? "followUp" : "auto");

	const state = effectiveRunState(metadata);
	const verb = followUp && state === "busy" ? "Queued follow-up for" : state === "idle" ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(metadata)}\nTask: ${task.id}\n`);
}

function parseTimeout(args: string[]): number {
	if (args.length === 0) return 1800;
	if (args.length !== 2 || args[0] !== "--timeout") usage();
	const timeout = Number(args[1]);
	if (!Number.isInteger(timeout) || timeout <= 0) fail("--timeout must be a positive integer");
	return timeout;
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	let taskId: string | undefined;
	const taskFlag = args.indexOf("--task");
	if (taskFlag >= 0) { taskId = valueAfter(args, taskFlag, "--task"); args.splice(taskFlag, 2); }
	const timeoutSeconds = parseTimeout(args);
	taskId ??= getRun(handle).waitTaskId;
	if (!taskId) fail("No current assignment; resume is idle. Send a task or use --task <id> for an earlier result");
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		const metadata = getRun(handle);
		const task = metadata.tasks?.find((entry) => entry.id === taskId);
		if (!task) fail(`Unknown assignment: ${taskId}`);
		if (task.status === "completed") {
			process.stdout.write(`${handle} task ${task.id} finished\n\n${task.result}\n`);
			if (task.failed) process.exitCode = 1;
			return;
		}
		if (task.status === "held") fail(`Assignment ${task.id} is held after stop/resume; inspect with pending and explicitly resend`);
		const state = effectiveRunState(metadata);
		if (state === "error" || state === "exited") fail(metadata.error || `${handle} is not running; assignment retained`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	releaseRun(metadata);
	process.stdout.write(`Stopped ${runDisplayName(metadata)}; transcript retained: ${metadata.sessionFile}\n`);
}

function resumeSubagent(args: string[]): void {
	if (process.env.PI_SUBAGENT_RUN_DIR) fail("Nested subagents are disabled");
	if (args.length !== 1) usage();
	const metadata = getRun(args[0]);
	if (runIsLive(metadata)) fail(`${metadata.handle} is already running`);
	if (!existsSync(metadata.sessionFile)) fail("Retained transcript is missing");
	launchRun(metadata);
	process.stdout.write(`Resumed ${runDisplayName(metadata)}\n`);
}

function purgeSubagent(args: string[]): void {
	if (args.length !== 2 || args[1] !== "--confirm") fail("purge requires <handle> --confirm; this permanently deletes the transcript");
	const metadata = getRun(args[0]);
	if (runIsLive(metadata)) fail("Stop the subagent before purging");
	purgeRun(metadata);
	process.stdout.write(`Purged ${runDisplayName(metadata)}\n`);
}

function listSubagents(args: string[]): void {
	if (args.length !== 0) usage();
	const runs = listRuns(process.env.PI_SESSION_ID || undefined);
	if (runs.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const metadata of runs) {
		process.stdout.write(
			`${runDisplayName(metadata)}  ${effectiveRunState(metadata).padEnd(8)}  ${metadata.provider}/${metadata.model}  ${metadata.thinking}${lifecycleAttention(metadata) ? `  ATTENTION: ${lifecycleAttention(metadata)}` : ""}\n`,
		);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "detach":
			if (args.length !== 1) usage();
			detachRun(getRun(args[0]));
			process.stdout.write("Detached retained run bookkeeping; no pane closed\n");
			break;
		case "pending": {
			if (args.length !== 1) usage();
			const run = getRun(args[0]);
			for (const task of run.tasks ?? []) if (task.status !== "completed") process.stdout.write(`${task.id} ${task.status}\n${task.message}\n\n`);
			break;
		}
		case "status":
			statusSubagent(args);
			break;
		case "rename":
			renameSubagent(args);
			break;
		case "send":
			sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "resume":
			resumeSubagent(args);
			break;
		case "purge":
			purgeSubagent(args);
			break;
		case "list":
			listSubagents(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
