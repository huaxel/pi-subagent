import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

interface Pane {
	pane_id: string;
	agent?: string;
	agent_status?: string;
	agent_session?: { value?: string };
}

interface HerdrResult {
	pane?: Pane;
	layout?: { panes: Array<{ pane_id: string; rect: { width: number; height: number } }> };
	process_info?: { foreground_processes: Array<{ pid: number }> };
}

function decode(stdout: string, stderr = "", failed = false): HerdrResult {
	let response: { result?: HerdrResult; error?: { code?: string; message?: string } };
	try { response = JSON.parse(stdout || stderr); }
	catch { throw new Error(stderr.trim() || "Invalid Herdr response"); }
	if (failed || response.error || !response.result) {
		const error = new Error(response.error?.message || stderr.trim() || "Herdr command failed");
		Object.assign(error, { code: response.error?.code });
		throw error;
	}
	return response.result;
}

function requireHerdr(): void {
	if (process.env.HERDR_ENV !== "1") throw new Error("Subagents require a Herdr-managed pane (HERDR_ENV=1)");
}

export function herdr(args: string[]): HerdrResult {
	requireHerdr();
	const timeout = args[0] === "agent" && args[1] === "start" ? 45000 : 5000;
	const result = spawnSync("herdr", args, { encoding: "utf8", timeout });
	if (result.error) throw result.error;
	return decode(result.stdout, result.stderr, result.status !== 0);
}

async function herdrAsync(args: string[]): Promise<HerdrResult> {
	requireHerdr();
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 5000 }));
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string };
		if (failure.stdout) return decode(failure.stdout, failure.stderr, true);
		throw error;
	}
	return decode(stdout);
}

export function getPane(paneId?: string): Pane | undefined {
	if (!paneId) return undefined;
	try { return herdr(["pane", "get", paneId]).pane; }
	catch (error) {
		if ((error as { code?: string }).code === "pane_not_found") return undefined;
		throw error;
	}
}

export async function getPaneAsync(paneId?: string): Promise<Pane | undefined> {
	if (!paneId) return undefined;
	try { return (await herdrAsync(["pane", "get", paneId])).pane; }
	catch (error) {
		if ((error as { code?: string }).code === "pane_not_found") return undefined;
		throw error;
	}
}

export function processStartTime(pid: number): string | undefined {
	// Linux start ticks distinguish PID reuse. Other platforms require Herdr's
	// session reference instead of falling back to a PID alone.
	if (process.platform !== "linux") return undefined;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	} catch { return undefined; }
}

export function ownsPane(pane: Pane, sessionFile: string, childPid?: number, childStartTime?: string): boolean {
	if (pane.agent_session) return pane.agent_session.value === sessionFile;
	// --no-extensions can disable Herdr's session reporting. The always-loaded
	// child bridge records its own PID; verify it against the pane's real PTY.
	if (!childPid || !childStartTime || processStartTime(childPid) !== childStartTime || pane.agent !== "pi") return false;
	return herdr(["pane", "process-info", "--pane", pane.pane_id]).process_info?.foreground_processes
		.some((process) => process.pid === childPid) ?? false;
}

export async function isLiveAsync(paneId: string | undefined, sessionFile: string, childPid?: number, childStartTime?: string): Promise<boolean> {
	const pane = await getPaneAsync(paneId);
	if (!pane) return false;
	if (pane.agent_session) return pane.agent_session.value === sessionFile;
	if (!childPid || !childStartTime || processStartTime(childPid) !== childStartTime || pane.agent !== "pi") return false;
	return (await herdrAsync(["pane", "process-info", "--pane", pane.pane_id])).process_info?.foreground_processes
		.some((process) => process.pid === childPid) ?? false;
}

export function closeOwnedPane(paneId: string | undefined, sessionFile: string, childPid?: number, childStartTime?: string): void {
	const pane = getPane(paneId);
	if (!pane) return;
	if (!ownsPane(pane, sessionFile, childPid, childStartTime)) {
		throw new Error(`Refusing to close ${paneId}: its agent session no longer belongs to this subagent`);
	}
	herdr(["pane", "close", pane.pane_id]);
}
