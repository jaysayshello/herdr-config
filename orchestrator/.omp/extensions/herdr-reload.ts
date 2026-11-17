// /reload: restarts every idle or done omp session in the Herdr spaces, so that each one loads changed
// config, extensions, skills, AGENTS.md and the omp binary. Each session resumes its own session file in
// the same place. A working or blocked session is skipped. This session restarts last.
// `/reload <space name>` restarts only the sessions of that space.
// The helpers below are shared with /claude and /omp (herdr-switch.ts); they take an `exec` instead of `pi`.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { agentTool } from "../tools/herdr.ts";

const self = process.env.HC_TERMINAL_ID;
// herdr-resume.ts writes this breadcrumb in each session: created_ms, then the session file.
export const OMP_CRUMBS = path.join(os.homedir(), ".local/state/omp-herdr-resume");
export const STOP_MS = 15_000;
const BACK_MS = 60_000;
export const PARALLEL = 4;
const SHELLS: Record<string, true> = { zsh: true, bash: true, sh: true, fish: true };

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface HcGet {
	argv?: string[];
	created_ms?: number;
	cwd?: string;
	title?: string;
	foreground?: { pid?: number; cwd?: string; name?: string } | null;
	status?: { app?: string; state?: string } | null;
	labels?: Record<string, string>;
}
interface LsSpace {
	id: string;
	name: string;
	machine?: string | null;
	tabs: { terminals: { terminal: string; pane?: string }[] }[];
}
export interface Target {
	terminal: string;
	pane?: string;
	space: string;
	// The terminal is in the same space as the terminal that runs the command.
	own: boolean;
	info: HcGet;
}
export interface Outcome {
	target: Target;
	ok: boolean;
	note: string;
}

export const stateOf = (info: HcGet) => info.status?.state ?? "unknown";

// One shell word: single quotes, with each ' written as '\''.
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Runs a command and returns its stdout; throws with its stderr when it fails.
export function runner(exec: Exec) {
	return async (cmd: string, args: string[]): Promise<string> => {
		const r = await exec(cmd, args);
		if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${cmd} exited with code ${r.code}`).trim());
		return r.stdout;
	};
}

export const hcGet = async (exec: Exec, t: string) => JSON.parse(await runner(exec)("hc", ["get", t, "--json"])) as HcGet;

// The process of a tool (omp, claude): the foreground itself, or its child under `zsh -lc`.
export async function toolPid(exec: Exec, fg: number, name: string): Promise<number | undefined> {
	const comm = (await exec("ps", ["-o", "comm=", "-p", String(fg)])).stdout.trim();
	if (path.basename(comm) === name) return fg;
	const child = (await exec("pgrep", ["-P", String(fg), "-x", name])).stdout.trim().split("\n")[0];
	return child ? Number(child) : undefined;
}

// The terminal keeps a shell after omp ends only when omp runs under an interactive shell:
// `zsh -l` with omp typed at its prompt, or the `"$@"; exec "$0" -li` wrapper of space.new.
// When omp is the terminal's program (pane.split, `zsh -lc omp`), the terminal ends with it
// and Herdr closes its pane.
export function shellStays(argv: string[]): boolean {
	if (!SHELLS[path.basename(argv[0] ?? "")]) return false;
	if (/exec "\$0" -li/.test(argv.join(" "))) return true;
	return argv.slice(1).every(a => a.startsWith("-") && !a.includes("c"));
}

// A breadcrumb (omp's or Claude's) counts only for the terminal that wrote it, while its session file exists.
// A bare `omp` resumes the omp one, and a fresh shell reopens it unless line 3 is `quit`.
export function crumbFile(dir: string, terminal: string, createdMs: number | undefined): string | undefined {
	try {
		const [created, file] = fs.readFileSync(path.join(dir, terminal), "utf8").split("\n");
		if (created === String(createdMs) && file && fs.existsSync(file)) return file;
	} catch {}
	return undefined;
}

// Herdr terminals often run without SHELL, so read the account's login shell.
export async function loginShell(exec: Exec): Promise<string> {
	if (process.env.SHELL) return process.env.SHELL;
	const user = os.userInfo().username;
	const shell =
		process.platform === "darwin"
			? (await exec("dscl", [".", "-read", `/Users/${user}`, "UserShell"])).stdout.split(":")[1]
			: (await exec("getent", ["passwd", user])).stdout.trim().split(":")[6];
	return shell?.trim() || "/bin/sh";
}

// The breadcrumb first; else the main session file omp holds open (subagent files sit one folder deeper).
export async function ompSessionFile(exec: Exec, t: Target, pid: number): Promise<string | undefined> {
	const crumb = crumbFile(OMP_CRUMBS, t.terminal, t.info.created_ms);
	if (crumb) return crumb;
	const out = (await exec("lsof", ["-p", String(pid), "-Fn"])).stdout;
	return out
		.split("\n")
		.filter(l => l.startsWith("n") && l.endsWith(".jsonl"))
		.map(l => l.slice(1))
		.find(f => path.basename(path.dirname(f)).startsWith("-"));
}

// Every terminal of the caller's machine (or of the space `only`) that `match` takes.
export async function targets(exec: Exec, only: string | undefined, match: (info: HcGet, terminal: string) => Promise<boolean>): Promise<Target[]> {
	const [{ spaces }, me] = await Promise.all([
		runner(exec)("herdr-app", ["ls"]).then(out => JSON.parse(out) as { spaces: LsSpace[] }),
		self ? hcGet(exec, self).catch(() => undefined) : undefined,
	]);
	// herdr-app ls names a remote machine's ids `<machine>/<id>`; hc knows them as `<id>`.
	const prefix = (s: LsSpace) => (s.machine ? `${s.machine}/` : "");
	const sid = me?.labels?.["herdr.space"];
	const mine = spaces.find(s => (sid ? s.id === prefix(s) + sid : false));
	const machine = mine?.machine ?? null;
	const found: Target[] = [];
	for (const s of spaces) {
		if ((s.machine ?? null) !== machine || (only && s.name !== only)) continue;
		for (const tab of s.tabs)
			for (const term of tab.terminals) {
				const terminal = machine && term.terminal.startsWith(`${machine}/`) ? term.terminal.slice(machine.length + 1) : term.terminal;
				const info = await hcGet(exec, terminal).catch(() => undefined);
				if (info && (await match(info, terminal))) found.push({ terminal, pane: term.pane, space: s.name, own: s === mine, info });
			}
	}
	return found;
}

// SIGTERM to the old tool, then types `command` in the shell that stays. Returns a failure note, or
// the hc send state for backIn (hc send runs on in the background).
export async function stopThenType(exec: Exec, terminal: string, pid: number, command: string, tool: string): Promise<{ failed?: string; sent?: { error?: string } }> {
	process.kill(pid, "SIGTERM");
	const stopBy = Date.now() + STOP_MS;
	// Check often (kill -0 costs nothing), so the new omp is typed soon after the old one ends.
	// The terminal keeps what is typed until the shell reads it, so a short pause is enough.
	while (alive(pid) && Date.now() < stopBy) await Bun.sleep(50);
	if (alive(pid)) return { failed: `failed: ${tool} did not stop in 15 s` };
	await Bun.sleep(150);
	// hc send types the text at once but then waits for a turn to start, which a shell never
	// reports, so it can hang for seconds. Watch for omp while it runs; stop early if it fails.
	// hc send from a terminal wraps the text in <hc from="..."> tags; without HC_TERMINAL_ID it
	// types the text as is.
	const sent: { error?: string } = {};
	runner(exec)("env", ["-u", "HC_TERMINAL_ID", "hc", "send", terminal, command]).catch(e => {
		sent.error = e instanceof Error ? e.message : String(e);
	});
	return { sent };
}

// The terminal ends with the old tool, and Herdr closes its pane. A pane split from it runs `script`
// (in a login shell, with $1 = the old pid and the rest of `args` after it); the new pane takes the
// old pane's place when that pane closes. Returns the new terminal id.
export async function splitPane(exec: Exec, pane: string, script: string, args: string[]): Promise<string> {
	const shell = await loginShell(exec);
	const argv = [shell, "-lic", script, shell, ...args];
	const split = JSON.parse(
		await runner(exec)("herdr-app", ["do", "pane.split", "--direction", "right", "--pane", pane, "--argv", JSON.stringify(argv)]),
	) as { terminal: string };
	return split.terminal;
}

export interface Expect {
	// The tool (agentTool of status.app: Claude reports `claude` or `claude-code`) and its process name.
	app: "omp" | "claude";
	name: string;
	states: string[];
	// Outcome words: "restarted", and "omp did not come back".
	ok: string;
	late: string;
}

// Passes when hc reports the expected tool in an expected state, with a new process of it in the foreground.
export async function backIn(
	exec: Exec,
	t: Target,
	terminal: string,
	oldPid: number,
	want: Expect,
	suffix = "",
	sent?: { error?: string },
): Promise<Outcome> {
	const by = Date.now() + BACK_MS;
	while (Date.now() < by) {
		if (sent?.error) return { target: t, ok: false, note: `failed: hc send did not work: ${sent.error}` };
		const info = await hcGet(exec, terminal).catch(() => undefined);
		const state = info ? stateOf(info) : "unknown";
		const fg = info?.foreground?.pid;
		const pid = fg ? await toolPid(exec, fg, want.name) : undefined;
		if (pid && pid !== oldPid && agentTool(info?.status?.app) === want.app && want.states.includes(state)) return { target: t, ok: true, note: `${want.ok}${suffix}` };
		await Bun.sleep(500);
	}
	return { target: t, ok: false, note: `failed: ${want.late} in 60 s${suffix}, look at ${terminal}` };
}

const OMP_BACK: Expect = { app: "omp", name: "omp", states: ["idle", "done"], ok: "restarted", late: "omp did not come back" };

export default function herdrReload(pi: ExtensionAPI) {
	const exec: Exec = (cmd, args) => pi.exec(cmd, args);

	// Stops omp and starts `omp --resume <file>` in its place. For this session, `stop` ends omp
	// and a detached helper does the start, because nothing here runs after omp ends.
	async function restart(t: Target, isSelf: boolean, stop: () => void): Promise<Outcome> {
		const info = await hcGet(exec, t.terminal);
		const state = stateOf(info);
		if (state !== "idle" && state !== "done") return { target: t, ok: false, note: `skipped: ${state}` };
		const fg = info.foreground?.pid;
		const pid = fg ? await toolPid(exec, fg, "omp") : undefined;
		if (!pid) return { target: t, ok: false, note: "skipped: no omp process found" };
		const file = await ompSessionFile(exec, t, pid);
		if (!file) return { target: t, ok: false, note: "skipped: no session file found" };
		const cwd = info.foreground?.cwd ?? info.cwd ?? os.homedir();

		if (shellStays(info.argv ?? [])) {
			// A fresh shell reopens the breadcrumb at its first prompt; the quit mark stops that, so
			// only the command below starts omp. The resumed omp writes the breadcrumb again.
			const crumb = path.join(OMP_CRUMBS, t.terminal);
			if (crumbFile(OMP_CRUMBS, t.terminal, info.created_ms)) fs.appendFileSync(crumb, "quit\n");
			const command = `omp --resume ${quote(file)}`;
			if (isSelf) {
				const env = { ...process.env };
				delete env.HC_TERMINAL_ID;
				const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; sleep 0.5; exec hc send "$2" "$3"';
				spawn("sh", ["-c", script, "sh", String(pid), t.terminal, command], { detached: true, stdio: "ignore", env }).unref();
				stop();
				return { target: t, ok: true, note: "restarts now" };
			}
			const { failed, sent } = await stopThenType(exec, t.terminal, pid, command, "omp");
			if (failed) return { target: t, ok: false, note: failed };
			return backIn(exec, t, t.terminal, pid, OMP_BACK, "", sent);
		}

		// The new pane resumes the session once the old omp ends. Its shell stays after omp, so the
		// next /reload uses the path above.
		if (!t.pane) return { target: t, ok: false, note: "skipped: no pane in herdr-app ls" };
		const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; cd "$2" && omp --resume "$3"; exec "$0" -li';
		const terminal = await splitPane(exec, t.pane, script, [String(pid), cwd, file]);
		if (isSelf) {
			stop();
			return { target: t, ok: true, note: `restarts now as ${terminal}` };
		}
		process.kill(pid, "SIGTERM");
		return backIn(exec, t, terminal, pid, OMP_BACK, ` as ${terminal}`);
	}

	pi.registerCommand("reload", {
		description: "Restart every idle or done omp session in the Herdr spaces (or in one space), this session last",
		handler: async (args, ctx) => {
			const only = args.trim() || undefined;
			// hc keeps the last omp status after omp ends, so a plain shell can still read as omp.
			const all = await targets(exec, only, async info => {
				const fg = info.foreground?.pid;
				return agentTool(info.status?.app) === "omp" && !!fg && !!(await toolPid(exec, fg, "omp"));
			});
			if (all.length === 0) {
				ctx.ui.notify(only ? `/reload: no omp session in a space named ${only}` : "/reload: no omp sessions found", "warning");
				return;
			}
			ctx.ui.notify(`/reload: restarting ${all.length} omp sessions, this one last`, "info");
			const others = all.filter(t => t.terminal !== self);
			const me = all.find(t => t.terminal === self);

			const outcomes: Outcome[] = [];
			const queue = [...others];
			await Promise.all(
				Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
					for (let t = queue.shift(); t; t = queue.shift())
						outcomes.push(await restart(t, false, () => {}).catch(err => ({ target: t!, ok: false, note: `failed: ${String(err)}` })));
				}),
			);

			const report = () => {
				const line = (o: Outcome) => `- ${o.target.terminal} (${o.target.space.replace(/-\d{4}-\d{2}-\d{2}$/, "")}): ${o.note}`;
				const done = outcomes.filter(o => o.ok);
				const skipped = outcomes.filter(o => !o.ok);
				return [
					`/reload: ${done.length} restarted, ${skipped.length} skipped or failed.`,
					...(done.length ? ["Restarted:", ...done.map(line)] : []),
					...(skipped.length ? ["Skipped or failed (restart these by hand later):", ...skipped.map(line)] : []),
				].join("\n");
			};

			let stopping = false;
			if (me) {
				const o = await restart(me, true, () => {
					stopping = true;
				}).catch(err => ({ target: me, ok: false, note: `failed: ${String(err)}` }));
				outcomes.push(o);
			}
			// Saved in this session, so the result shows here again after the resume.
			pi.sendMessage({ customType: "herdr-reload", content: report(), display: true }, { triggerTurn: false });
			if (stopping) {
				await Bun.sleep(300);
				ctx.shutdown();
			} else ctx.ui.notify(report(), outcomes.every(o => o.ok) ? "info" : "warning");
		},
	});
}
