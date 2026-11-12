// /reload: restarts every idle or done omp session in the Herdr spaces, so that each one loads changed
// config, extensions, skills, AGENTS.md and the omp binary. Each session resumes its own session file in
// the same place. A working or blocked session is skipped. This session restarts last.
// `/reload <space name>` restarts only the sessions of that space.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const self = process.env.HC_TERMINAL_ID;
// herdr-resume.ts writes this breadcrumb in each session: created_ms, then the session file.
const CRUMBS = path.join(os.homedir(), ".local/state/omp-herdr-resume");
const STOP_MS = 15_000;
const BACK_MS = 60_000;
const PARALLEL = 4;
const SHELLS: Record<string, true> = { zsh: true, bash: true, sh: true, fish: true };

interface HcGet {
	argv?: string[];
	created_ms?: number;
	cwd?: string;
	foreground?: { pid?: number; cwd?: string } | null;
	status?: { app?: string; state?: string } | null;
	labels?: Record<string, string>;
}
interface LsSpace {
	id: string;
	name: string;
	machine?: string | null;
	tabs: { terminals: { terminal: string; pane?: string }[] }[];
}
interface Target {
	terminal: string;
	pane?: string;
	space: string;
	info: HcGet;
}
interface Outcome {
	target: Target;
	ok: boolean;
	note: string;
}

const stateOf = (info: HcGet) => info.status?.state ?? "unknown";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// The terminal keeps a shell after omp ends only when omp runs under an interactive shell:
// `zsh -l` with omp typed at its prompt, or the `"$@"; exec "$0" -li` wrapper of space.new.
// When omp is the terminal's program (pane.split, `zsh -lc omp`), the terminal ends with it
// and Herdr closes its pane.
function shellStays(argv: string[]): boolean {
	if (!SHELLS[path.basename(argv[0] ?? "")]) return false;
	if (/exec "\$0" -li/.test(argv.join(" "))) return true;
	return argv.slice(1).every(a => a.startsWith("-") && !a.includes("c"));
}

// A bare `omp` resumes this breadcrumb, and a fresh shell reopens it unless line 3 is `quit`.
function crumbFile(terminal: string, createdMs: number | undefined): string | undefined {
	try {
		const [created, file] = fs.readFileSync(path.join(CRUMBS, terminal), "utf8").split("\n");
		if (created === String(createdMs) && file && fs.existsSync(file)) return file;
	} catch {}
	return undefined;
}

export default function herdrReload(pi: ExtensionAPI) {
	async function run(cmd: string, args: string[]): Promise<string> {
		const r = await pi.exec(cmd, args);
		if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${cmd} exited with code ${r.code}`).trim());
		return r.stdout;
	}
	const get = async (t: string) => JSON.parse(await run("hc", ["get", t, "--json"])) as HcGet;

	// The omp process: the foreground itself, or its omp child under `zsh -lc`.
	async function ompPid(fg: number): Promise<number | undefined> {
		const comm = (await pi.exec("ps", ["-o", "comm=", "-p", String(fg)])).stdout.trim();
		if (path.basename(comm) === "omp") return fg;
		const child = (await pi.exec("pgrep", ["-P", String(fg), "-x", "omp"])).stdout.trim().split("\n")[0];
		return child ? Number(child) : undefined;
	}

	// Herdr terminals often run without SHELL, so read the account's login shell.
	async function loginShell(): Promise<string> {
		if (process.env.SHELL) return process.env.SHELL;
		const user = os.userInfo().username;
		const shell =
			process.platform === "darwin"
				? (await pi.exec("dscl", [".", "-read", `/Users/${user}`, "UserShell"])).stdout.split(":")[1]
				: (await pi.exec("getent", ["passwd", user])).stdout.trim().split(":")[6];
		return shell?.trim() || "/bin/sh";
	}

	// The breadcrumb first; else the main session file omp holds open (subagent files sit one folder deeper).
	async function sessionFile(t: Target, pid: number): Promise<string | undefined> {
		const crumb = crumbFile(t.terminal, t.info.created_ms);
		if (crumb) return crumb;
		const out = (await pi.exec("lsof", ["-p", String(pid), "-Fn"])).stdout;
		return out
			.split("\n")
			.filter(l => l.startsWith("n") && l.endsWith(".jsonl"))
			.map(l => l.slice(1))
			.find(f => path.basename(path.dirname(f)).startsWith("-"));
	}

	async function targets(only: string | undefined): Promise<Target[]> {
		const [{ spaces }, me] = await Promise.all([
			run("herdr-app", ["ls"]).then(out => JSON.parse(out) as { spaces: LsSpace[] }),
			self ? get(self).catch(() => undefined) : undefined,
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
					const info = await get(terminal).catch(() => undefined);
					// hc keeps the last omp status after omp ends, so a plain shell can still read as omp.
					const fg = info?.foreground?.pid;
					if (info?.status?.app === "omp" && fg && (await ompPid(fg)))
						found.push({ terminal, pane: term.pane, space: s.name, info });
				}
		}
		return found;
	}

	// Stops omp and starts `omp --resume <file>` in its place. For this session, `stop` ends omp
	// and a detached helper does the start, because nothing here runs after omp ends.
	async function restart(t: Target, isSelf: boolean, stop: () => void): Promise<Outcome> {
		const info = await get(t.terminal);
		const state = stateOf(info);
		if (state !== "idle" && state !== "done") return { target: t, ok: false, note: `skipped: ${state}` };
		const fg = info.foreground?.pid;
		const pid = fg ? await ompPid(fg) : undefined;
		if (!pid) return { target: t, ok: false, note: "skipped: no omp process found" };
		const file = await sessionFile(t, pid);
		if (!file) return { target: t, ok: false, note: "skipped: no session file found" };
		const cwd = info.foreground?.cwd ?? info.cwd ?? os.homedir();

		if (shellStays(info.argv ?? [])) {
			// A fresh shell reopens the breadcrumb at its first prompt; the quit mark stops that, so
			// only the command below starts omp. The resumed omp writes the breadcrumb again.
			const crumb = path.join(CRUMBS, t.terminal);
			if (crumbFile(t.terminal, info.created_ms)) fs.appendFileSync(crumb, "quit\n");
			const command = `omp --resume '${file.replaceAll("'", "'\\''")}'`;
			// hc send from a terminal wraps the text in <hc from="..."> tags; without HC_TERMINAL_ID it
			// types the text as is.
			if (isSelf) {
				const env = { ...process.env };
				delete env.HC_TERMINAL_ID;
				const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; sleep 0.5; exec hc send "$2" "$3"';
				spawn("sh", ["-c", script, "sh", String(pid), t.terminal, command], { detached: true, stdio: "ignore", env }).unref();
				stop();
				return { target: t, ok: true, note: "restarts now" };
			}
			process.kill(pid, "SIGTERM");
			const stopBy = Date.now() + STOP_MS;
			while (alive(pid) && Date.now() < stopBy) await Bun.sleep(200);
			if (alive(pid)) return { target: t, ok: false, note: "failed: omp did not stop in 15 s" };
			await Bun.sleep(500);
			await run("env", ["-u", "HC_TERMINAL_ID", "hc", "send", t.terminal, command]);
			return backIn(t, t.terminal, pid);
		}

		// The terminal ends with omp, and Herdr closes its pane. A pane split from it waits for the old
		// omp to end, then resumes the session; it takes the old pane's place when that pane closes.
		// Its shell stays after omp, so the next /reload uses the path above.
		if (!t.pane) return { target: t, ok: false, note: "skipped: no pane in herdr-app ls" };
		const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; cd "$2" && omp --resume "$3"; exec "$0" -li';
		const shell = await loginShell();
		const argv = [shell, "-lic", script, shell, String(pid), cwd, file];
		const split = JSON.parse(
			await run("herdr-app", ["do", "pane.split", "--direction", "right", "--pane", t.pane, "--argv", JSON.stringify(argv)]),
		) as { terminal: string };
		if (isSelf) {
			stop();
			return { target: t, ok: true, note: `restarts now as ${split.terminal}` };
		}
		process.kill(pid, "SIGTERM");
		return backIn(t, split.terminal, pid, ` as ${split.terminal}`);
	}

	async function backIn(t: Target, terminal: string, oldPid: number, suffix = ""): Promise<Outcome> {
		const by = Date.now() + BACK_MS;
		while (Date.now() < by) {
			const info = await get(terminal).catch(() => undefined);
			const state = info ? stateOf(info) : "unknown";
			const fg = info?.foreground?.pid;
			const pid = fg ? await ompPid(fg) : undefined;
			if (pid && pid !== oldPid && info?.status?.app === "omp" && (state === "idle" || state === "done"))
				return { target: t, ok: true, note: `restarted${suffix}` };
			await Bun.sleep(500);
		}
		return { target: t, ok: false, note: `failed: omp did not come back in 60 s${suffix}, look at ${terminal}` };
	}

	pi.registerCommand("reload", {
		description: "Restart every idle or done omp session in the Herdr spaces (or in one space), this session last",
		handler: async (args, ctx) => {
			const only = args.trim() || undefined;
			const all = await targets(only);
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
