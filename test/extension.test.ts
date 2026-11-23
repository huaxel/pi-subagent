import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { enqueueTask, readMetadata, writeMetadata } from "../shared.ts";
import type { RunMetadata } from "../shared.ts";

async function harness(child: boolean) {
	const root = mkdtempSync(join(tmpdir(), "subagent-extension-"));
	for (const file of ["index.ts", "shared.ts", "herdr.ts"]) copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	for (const [name, exports] of [["pi-coding-agent", "export class DynamicBorder {}\nexport function keyHint() {}"], ["pi-tui", "export class Container {}\nexport class SelectList {}\nexport class Text {}"]]) {
		const directory = join(root, "node_modules", "@earendil-works", name); mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "package.json"), '{"type":"module","exports":"./index.js"}'); writeFileSync(join(directory, "index.js"), exports);
	}
	const runDir = join(root, "subagents-herdr", "abc123"); mkdirSync(runDir, { recursive: true });
	const record: RunMetadata = { version: 1, handle: "abc123", parentSessionId: "parent-session", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: root,
		provider: "test", model: "test", thinking: "low", state: child ? "idle" : "exited", hasStarted: true, launchId: "generation", createdAt: "now", updatedAt: "now" };
	writeMetadata(record); writeFileSync(record.sessionFile, "");
	const before = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_SUBAGENT_RUN_DIR: process.env.PI_SUBAGENT_RUN_DIR, PI_SUBAGENT_LAUNCH_ID: process.env.PI_SUBAGENT_LAUNCH_ID };
	process.env.PI_CODING_AGENT_DIR = root;
	if (child) { process.env.PI_SUBAGENT_RUN_DIR = runDir; process.env.PI_SUBAGENT_LAUNCH_ID = "generation"; } else delete process.env.PI_SUBAGENT_RUN_DIR;
	const handlers = new Map<string, Function[]>(); const notices: { message: any; options: any }[] = []; const inputs: string[] = [];
	const api = { registerCommand() {}, on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		sendMessage(message: any, options: any) { notices.push({ message, options }); }, sendUserMessage(message: string) { inputs.push(message); }, setSessionName() {} };
	const context = { mode: "rpc", hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => child ? "child-session" : "parent-session", getSessionFile: () => record.sessionFile },
		ui: { setWidget() { throw new Error("Non-TUI widget invoked"); }, setStatus() { throw new Error("Non-TUI status invoked"); } } };
	const module = await import(pathToFileURL(join(root, "index.ts")).href); module.default(api);
	const emit = async (name: string, event = {}) => { for (const handler of handlers.get(name) ?? []) await handler(event, context); };
	return { record, runDir, notices, inputs, emit, context, cleanup: async () => {
		await emit("session_shutdown", { reason: "reload" });
		for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	} };
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(predicate());
}

test("RPC parents receive pushed completion once without rendering a widget", async () => {
	const h = await harness(false);
	try {
		const record = { ...h.record, tasks: [{ id: "finished-task", message: "task", delivery: "auto" as const, status: "completed" as const, createdAt: "now", result: "result" }] };
		writeMetadata(record);
		await h.emit("session_start"); await until(() => h.notices.length === 1);
		assert.equal(h.notices[0].options.triggerTurn, true); assert.equal(h.notices[0].options.deliverAs, "followUp");
		assert.match(h.notices[0].message.content, /finished-task/); assert.ok(readMetadata(h.runDir)!.tasks![0].notified);
	} finally { await h.cleanup(); }
});

test("child bridge delivers a durable tagged assignment and records only its later result", async () => {
	const h = await harness(true);
	try {
		const task = enqueueTask(h.runDir, "investigate");
		await h.emit("session_start"); await until(() => h.inputs.length === 1);
		assert.match(h.inputs[0], new RegExp(task.id)); assert.equal(readMetadata(h.runDir)!.tasks![0].status, "submitted");
		await h.emit("agent_settled"); assert.equal(readMetadata(h.runDir)!.tasks![0].status, "submitted");
		writeFileSync(h.record.sessionFile, [
			{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: h.inputs[0] }] } },
			{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "fresh result" }], stopReason: "stop" } },
		].map((entry) => JSON.stringify(entry)).join("\n"));
		await h.emit("agent_settled"); assert.equal(readMetadata(h.runDir)!.tasks![0].result, "fresh result");
	} finally { await h.cleanup(); }
});


test("replacing a child conversation retains the original transcript reference and holds work", async () => {
	const h = await harness(true);
	try {
		enqueueTask(h.runDir, "task");
		h.context.sessionManager.getSessionFile = () => join(h.record.cwd, "unrelated-session.jsonl");
		await h.emit("session_start");
		const record = readMetadata(h.runDir)!;
		assert.equal(record.sessionFile, h.record.sessionFile); assert.equal(record.sessionReplaced, true);
		assert.equal(record.tasks![0].status, "held"); assert.equal(h.inputs.length, 0);
	} finally { await h.cleanup(); }
});

test("parent loss holds pending work without replaying or closing the human conversation", async () => {
	const h = await harness(true);
	try {
		writeMetadata({ ...h.record, parentPid: 999999999, parentStartTime: "dead-parent" });
		enqueueTask(h.runDir, "pending work");
		await h.emit("session_start");
		const record = readMetadata(h.runDir)!;
		assert.equal(record.tasks![0].status, "held"); assert.equal(h.inputs.length, 0); assert.match(record.error!, /Parent exited/);
	} finally { await h.cleanup(); }
});
