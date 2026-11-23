import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assignmentPrompt, completeTasks, launchRun, enqueueTask, holdPending, mutateMetadata, recoverMissingRun, readMetadata, writeMetadata } from "../shared.ts";
import type { RunMetadata } from "../shared.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-coordination-"));
	const directory = join(root, "subagents-herdr", "abc123"); mkdirSync(directory, { recursive: true });
	const record: RunMetadata = { version: 1, handle: "abc123", runDir: directory, sessionFile: join(directory, "session.jsonl"), cwd: root,
		provider: "test", model: "test", thinking: "low", state: "idle", hasStarted: true, launchId: "generation", createdAt: "now", updatedAt: "now" };
	writeMetadata(record); writeFileSync(record.sessionFile, "");
	return { root, directory, record, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function message(id: string, parentId: string | null, role: string, text: string, stopReason = "stop") {
	return { type: "message", id, parentId, message: { role, content: [{ type: "text", text }], stopReason } };
}

test("settlement requires the assignment input and a later final answer on the active branch", () => {
	const f = fixture();
	try {
		const task = enqueueTask(f.directory, "new investigation");
		mutateMetadata(f.directory, (m) => { m.tasks![0].status = "submitted"; });
		const old = message("old", null, "assistant", "stale answer");
		writeFileSync(f.record.sessionFile, JSON.stringify(old) + "\n");
		completeTasks(f.directory, "generation"); assert.equal(readMetadata(f.directory)!.tasks![0].status, "submitted");
		const input = message("input", "old", "user", assignmentPrompt(task));
		const answer = message("answer", "input", "assistant", "fresh answer");
		writeFileSync(f.record.sessionFile, [old, input, answer].map(JSON.stringify).join("\n") + "\n");
		completeTasks(f.directory, "wrong-generation"); assert.equal(readMetadata(f.directory)!.tasks![0].status, "submitted");
		completeTasks(f.directory, "generation");
		const saved = readMetadata(f.directory)!.tasks![0];
		assert.equal(saved.status, "completed"); assert.equal(saved.inputEntryId, "input"); assert.equal(saved.responseEntryId, "answer"); assert.equal(saved.result, "fresh answer");
	} finally { f.cleanup(); }
});

test("abandoned branches and tool-use messages cannot masquerade as completed assignments", () => {
	const f = fixture();
	try {
		const task = enqueueTask(f.directory, "task"); mutateMetadata(f.directory, (m) => { m.tasks![0].status = "submitted"; });
		const old = message("old", null, "assistant", "old"); const input = message("input", "old", "user", assignmentPrompt(task));
		const abandoned = message("abandoned", "input", "assistant", "abandoned answer"); const active = message("active", "old", "assistant", "unrelated answer");
		writeFileSync(f.record.sessionFile, [old, input, abandoned, active].map(JSON.stringify).join("\n"));
		completeTasks(f.directory, "generation"); assert.equal(readMetadata(f.directory)!.tasks![0].status, "submitted");
		writeFileSync(f.record.sessionFile, [old, input, message("tool", "input", "assistant", "running tool", "toolUse")].map(JSON.stringify).join("\n"));
		completeTasks(f.directory, "generation"); assert.equal(readMetadata(f.directory)!.tasks![0].status, "submitted");
	} finally { f.cleanup(); }
});

test("holding pending messages preserves their content and clears current wait without replay", () => {
	const f = fixture();
	try {
		enqueueTask(f.directory, "queued message"); enqueueTask(f.directory, "followup message", "followUp");
		mutateMetadata(f.directory, (m) => { m.tasks![1].status = "submitted"; holdPending(m); });
		const m = readMetadata(f.directory)!;
		assert.equal(m.waitTaskId, undefined); assert.deepEqual(m.tasks!.map((t) => t.status), ["held", "held"]);
		assert.deepEqual(m.tasks!.map((t) => t.message), ["queued message", "followup message"]);
	} finally { f.cleanup(); }
});

test("real interprocess locking prevents lost updates and releases on writer death", async () => {
	const f = fixture();
	try {
		const module = new URL("../shared.ts", import.meta.url).href;
		await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", `import {enqueueTask} from ${JSON.stringify(module)}; enqueueTask(${JSON.stringify(f.directory)}, 'message-${i}');`], { stdio: "pipe" });
			let error = ""; child.stderr.on("data", (chunk) => error += chunk); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(error)));
		})));
		assert.equal(readMetadata(f.directory)!.tasks!.length, 12);
		const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `import {mutateMetadata} from ${JSON.stringify(module)}; mutateMetadata(${JSON.stringify(f.directory)}, () => process.kill(process.pid, 'SIGKILL'));`]);
		assert.equal(crash.signal, "SIGKILL");
		enqueueTask(f.directory, "after crash"); assert.equal(readMetadata(f.directory)!.tasks!.length, 13);
		assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.directory, "metadata.json"), "utf8")));
	} finally { f.cleanup(); }
});

test("two completed follow-up turns retain their own answers", () => {
	const f = fixture();
	try {
		const a = enqueueTask(f.directory, "A"); const b = enqueueTask(f.directory, "B", "followUp");
		mutateMetadata(f.directory, (m) => { for (const t of m.tasks!) t.status = "submitted"; });
		const entries = [message("a", null, "user", assignmentPrompt(a)), message("ar", "a", "assistant", "answer A"), message("b", "ar", "user", assignmentPrompt(b)), message("br", "b", "assistant", "answer B")];
		writeFileSync(f.record.sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
		completeTasks(f.directory, "generation");
		assert.deepEqual(readMetadata(f.directory)!.tasks!.map((t) => t.result), ["answer A", "answer B"]);
	} finally { f.cleanup(); }
});


test("a stale missing-pane result cannot hold newly registered work", () => {
	const f = fixture();
	try {
		const snapshot = readMetadata(f.directory)!;
		mutateMetadata(f.directory, (m) => { m.launchReadyAt = new Date().toISOString(); });
		const task = enqueueTask(f.directory, "new healthy assignment");
		recoverMissingRun(snapshot);
		const m = readMetadata(f.directory)!;
		assert.equal(m.tasks!.find((t) => t.id === task.id)!.status, "queued"); assert.equal(m.state, "idle");
	} finally { f.cleanup(); }
});


test("a stale resume snapshot never launches after its locked metadata disappears", () => {
	const f = fixture();
	try {
		unlinkSync(join(f.directory, "metadata.json"));
		assert.throws(() => launchRun(f.record), /refusing stale resume/);
		// No Herdr transport is configured in this fixture: reaching launch would fail differently.
	} finally { f.cleanup(); }
});
