import assert from "node:assert/strict";
import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { processStartTime } from "../herdr.ts";

const cli = resolve(import.meta.dirname, "../subagent.ts");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.MOCK_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { calls: [], panes: {}, n: 0 };
state.calls.push(args);
let result = {};
let error;
if (args[0] === 'pane' && args[1] === 'layout') result = { layout: { panes: [{ pane_id: 'parent-pane', rect: { width: 160, height: 40 } }] } };
else if (args[0] === 'pane' && args[1] === 'split') {
  const id = 'opaque-' + (++state.n);
  const env = args.filter((v, i) => args[i - 1] === '--env');
  state.panes[id] = { pane_id: id, env };
  result = { pane: state.panes[id] };
} else if (args[0] === 'agent' && args[1] === 'start') {
  const pane = state.panes[args[args.indexOf('--pane') + 1]];
  const sessionFile = args[args.indexOf('--session') + 1];
  pane.agent = 'pi'; pane.agent_session = { value: sessionFile };
  const runDir = path.dirname(sessionFile);
  const metaFile = path.join(runDir, 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaFile));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, childPid: 1, state: 'idle' }));
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  const pane = state.panes[args[2]];
  const metaFile = path.join(path.dirname(pane.agent_session.value), 'metadata.json');
  const meta = JSON.parse(fs.readFileSync(metaFile));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, hasStarted: true, state: 'idle' }));
  fs.writeFileSync(pane.agent_session.value, JSON.stringify({ type: 'message', id: 'm1', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: 'durable result' }], stopReason: 'stop' } }) + '\\n');
} else if (args[0] === 'pane' && args[1] === 'get') {
  if (!state.panes[args[2]]) error = { code: 'pane_not_found', message: 'missing pane' };
  else result = { pane: state.panes[args[2]] };
} else if (args[0] === 'pane' && args[1] === 'process-info') {
  const pane = state.panes[args[args.indexOf('--pane') + 1]];
  result = { process_info: { foreground_processes: [{ pid: pane.pid }] } };
} else if (args[0] === 'pane' && args[1] === 'close') delete state.panes[args[2]];
fs.writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify(error ? { error } : { result }));
process.exitCode = error ? 1 : 0;
`;
	writeFileSync(join(bin, "herdr"), mock, { mode: 0o755 });
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_STATE: join(root, "state.json"),
		PI_CODING_AGENT_DIR: root, HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", PI_SESSION_ID: "parent-session",
		PI_PROVIDER: "test-provider", PI_MODEL: "test-model", PI_REASONING_LEVEL: "low" };
	delete env.PI_SUBAGENT_RUN_DIR;
	mkdirSync(join(root, "subagent-parents"));
	writeFileSync(join(root, "subagent-parents", "parent-session.json"), JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }));
	const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	const runAsync = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawnProcess(process.execPath, [cli, ...args], { env, stdio: "pipe" }); let stdout = "", stderr = "";
		child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", reject); child.on("exit", (status) => resolve({ status, stdout, stderr }));
	});
	const spawn = () => {
		const result = run(["spawn", "--name", "review", "--prompt", "Review this"]);
		assert.equal(result.status, 0, result.stderr);
		const handle = result.stdout.match(/\(([a-z0-9]+)\)/)![1];
		const path = join(root, "subagents-herdr", handle, "metadata.json");
		const metadata = JSON.parse(readFileSync(path, "utf8"));
		metadata.tasks[0].status = "completed"; metadata.tasks[0].result = "durable result";
		writeFileSync(path, JSON.stringify(metadata));
		writeFileSync(metadata.sessionFile, "retained conversation\n");
		return handle;
	};
	const metaPath = (handle: string) => join(root, "subagents-herdr", handle, "metadata.json");
	const meta = (handle: string) => JSON.parse(readFileSync(metaPath(handle), "utf8"));
	return { root, env, run, runAsync, spawn, meta, metaPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("inherits model, uses returned sibling pane ID, preserves focus and reads durable result", () => {
	const f = fixture();
	try {
		const h = f.spawn();
		const m = f.meta(h);
		assert.equal(m.provider, "test-provider"); assert.equal(m.model, "test-model"); assert.equal(m.thinking, "low");
		assert.equal(m.paneId, "opaque-1");
		const calls = JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8")).calls;
		const split = calls.find((c: string[]) => c[1] === "split");
		assert.ok(split.includes("--current")); assert.ok(split.includes("--no-focus")); assert.ok(split.includes("right"));
		assert.ok(calls.find((c: string[]) => c[1] === "start").includes("--extension"));
		assert.match(f.run(["wait", h, "--timeout", "1"]).stdout, /durable result/);
	} finally { f.cleanup(); }
});

test("stop preserves transcript, is idempotent, resume reuses history, purge requires confirmation", () => {
	const f = fixture();
	try {
		const h = f.spawn(); const file = f.meta(h).sessionFile; const history = readFileSync(file, "utf8");
		assert.equal(f.run(["stop", h]).status, 0);
		assert.equal(readFileSync(file, "utf8"), history); assert.equal(f.meta(h).state, "exited");
		assert.equal(f.meta(h).suspended, false);
		assert.equal(f.run(["stop", h]).status, 0);
		assert.match(f.run(["list"]).stdout, new RegExp(h));
		assert.equal(f.run(["resume", h]).status, 0);
		assert.notEqual(f.run(["wait", h, "--timeout", "1"]).status, 0);
		assert.equal(f.meta(h).paneId, "opaque-2"); assert.equal(readFileSync(file, "utf8"), history);
		assert.notEqual(f.run(["purge", h, "--confirm"]).status, 0);
		assert.equal(f.run(["stop", h]).status, 0);
		assert.notEqual(f.run(["purge", h]).status, 0); assert.ok(existsSync(file));
		assert.equal(f.run(["purge", h, "--confirm"]).status, 0); assert.ok(!existsSync(file));
	} finally { f.cleanup(); }
});

test("rejects nested spawning, foreign parent access, and closing repurposed panes", () => {
	const f = fixture();
	try {
		assert.notEqual(f.run(["spawn", "--prompt", "task"], { PI_SUBAGENT_RUN_DIR: "/child" }).status, 0);
		assert.notEqual(f.run(["spawn", "--prompt", "task"], { HERDR_ENV: "0" }).status, 0);
		const h = f.spawn();
		assert.notEqual(f.run(["stop", h], { PI_SESSION_ID: "other-parent" }).status, 0);
		const state = JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8"));
		state.panes[f.meta(h).paneId].agent_session.value = "/somebody-elses-session";
		writeFileSync(f.env.MOCK_STATE, JSON.stringify(state));
		const result = f.run(["stop", h]);
		assert.notEqual(result.status, 0); assert.match(result.stderr, /Refusing to close/);
		assert.ok(existsSync(f.metaPath(h)));
	} finally { f.cleanup(); }
});

test("per-spawn model and tools overrides remain available", () => {
	const f = fixture();
	try {
		const result = f.run(["spawn", "--prompt", "task", "--provider", "other", "--model", "fast", "--thinking", "high", "--tools", "read,grep,find,ls", "--no-extensions"]);
		assert.equal(result.status, 0, result.stderr);
		const h = result.stdout.match(/\(([a-z0-9]+)\)/);
		// Unnamed runs print the bare handle.
		const m = f.meta(h ? h[1] : result.stdout.split("\n")[0].split(" ")[1]);
		assert.equal(m.provider, "other"); assert.equal(m.model, "fast"); assert.equal(m.thinking, "high");
		assert.ok(m.launchArgs.includes("read,grep,find,ls")); assert.ok(m.launchArgs.includes("--no-extensions"));
	} finally { f.cleanup(); }
});

test("missing parent identity and corrupted deletion paths fail closed", () => {
	const f = fixture();
	try {
		const h = f.spawn();
		assert.notEqual(f.run(["stop", h], { PI_SESSION_ID: "" }).status, 0);
		assert.notEqual(f.run(["spawn", "--prompt", "task"], { PI_SESSION_ID: "" }).status, 0);
		assert.equal(f.run(["stop", h]).status, 0);
		const victim = join(f.root, "keep-me"); mkdirSync(victim); writeFileSync(join(victim, "important"), "safe");
		writeFileSync(f.metaPath(h), JSON.stringify({ ...f.meta(h), runDir: victim }));
		assert.notEqual(f.run(["purge", h, "--confirm"]).status, 0);
		assert.ok(existsSync(join(victim, "important")));
	} finally { f.cleanup(); }
});


test("isolated children use bridge PID ownership, never mismatching session or PID", () => {
	const f = fixture();
	try {
		const h = f.spawn(); const m = f.meta(h);
		writeFileSync(f.metaPath(h), JSON.stringify({ ...m, childPid: process.pid, childStartTime: processStartTime(process.pid) }));
		const state = JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8"));
		delete state.panes[m.paneId].agent_session;
		state.panes[m.paneId].pid = 54321;
		writeFileSync(f.env.MOCK_STATE, JSON.stringify(state));
		assert.notEqual(f.run(["stop", h]).status, 0);
		state.panes[m.paneId].pid = process.pid;
		writeFileSync(f.env.MOCK_STATE, JSON.stringify(state));
		assert.match(f.run(["status", h]).stdout, /idle/);
		writeFileSync(f.metaPath(h), JSON.stringify({ ...f.meta(h), childStartTime: "stale-start-ticks" }));
		assert.notEqual(f.run(["stop", h]).status, 0);
		writeFileSync(f.metaPath(h), JSON.stringify({ ...f.meta(h), childStartTime: processStartTime(process.pid) }));
		assert.equal(f.run(["stop", h]).status, 0);
		assert.ok(existsSync(m.sessionFile));
	} finally { f.cleanup(); }
});


test("concurrent resumes cannot create duplicate workers", async () => {
	const f = fixture();
	try {
		const h = f.spawn(); assert.equal(f.run(["stop", h]).status, 0);
		const results = await Promise.all([f.runAsync(["resume", h]), f.runAsync(["resume", h])]);
		assert.equal(results.filter((r) => r.status === 0).length, 1);
		const state = JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8")); assert.equal(Object.keys(state.panes).length, 1);
		assert.ok(state.panes[f.meta(h).paneId]);
	} finally { f.cleanup(); }
});

test("overlapping purge and resume cannot delete a live worker transcript", async () => {
	const f = fixture();
	try {
		const h = f.spawn(); assert.equal(f.run(["stop", h]).status, 0);
		const [purge, resume] = await Promise.all([f.runAsync(["purge", h, "--confirm"]), f.runAsync(["resume", h])]);
		assert.ok(purge.status !== 0 || resume.status !== 0);
		if (resume.status === 0) assert.ok(existsSync(f.meta(h).sessionFile));
		if (purge.status === 0) assert.equal(Object.keys(JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8")).panes).length, 0);
	} finally { f.cleanup(); }
});

test("failed stop unfreezes bookkeeping and foreign-pane detach never closes it", () => {
	const f = fixture();
	try {
		const h = f.spawn(); const m = f.meta(h);
		const state = JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8")); state.panes[m.paneId].agent_session.value = "/foreign-session";
		writeFileSync(f.env.MOCK_STATE, JSON.stringify(state));
		assert.notEqual(f.run(["stop", h]).status, 0); assert.equal(f.meta(h).closing, false); assert.match(f.meta(h).error, /Refusing/);
		assert.equal(f.run(["detach", h]).status, 0); assert.equal(f.meta(h).paneId, undefined);
		assert.ok(JSON.parse(readFileSync(f.env.MOCK_STATE, "utf8")).panes[m.paneId]); assert.ok(existsSync(m.sessionFile));
	} finally { f.cleanup(); }
});
