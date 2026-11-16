// /reload: restarts every idle or done omp session in the Rex sessions, so that each one loads changed
// config, extensions, skills, AGENTS.md and the omp binary. Each session resumes its own session file in
// the same terminal. A working or blocked session is skipped. This session restarts last.
// `/reload <space name>` restarts only the omp sessions of the Rex session with that name.
// The same job as herdr-reload.ts, on Rex.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { crumbFile, REX, rexClient, SELF, type Term, uuid } from "../tools/rex.ts";

// rex-resume.ts writes this breadcrumb in each terminal: the session file, then `quit` after a quit.
const CRUMBS = path.join(os.homedir(), ".local/state/omp-rex-resume");
const STOP_MS = 15_000;
const BACK_MS = 60_000;
// How long a worker block's own shell gets to resume omp by itself before the command is typed.
const WRAPPED_MS = 10_000;
const PARALLEL = 4;
const SHELLS: Record<string, true> = { zsh: true, bash: true, sh: true, fish: true };

// A process as the terminal block's `process` method reports it.
interface Proc {
	pid: number;
	name?: string;
	cwd?: string;
}
interface BlockProcess {
	foreground?: Proc | null;
	ancestors?: Proc[];
}
// How this session's own omp must end for its restart.
type StopHow = "signal" | "quit";
export interface Outcome {
	target: Term;
	ok: boolean;
	note: string;
}

const isUp = (t: Term) => t.state === "idle" || t.state === "done";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// The terminal keeps a shell after omp ends only when omp runs under an interactive shell: a login
// shell (`-zsh`) or `zsh -li` with omp typed at its prompt, or the `"$@"; exec "$0" -li` wrapper of
// the split below. When omp is the block's program (`rex split -- omp`, `zsh -lc omp`), the block
// ends with it and Rex closes it.
function shellStays(args: string): boolean {
	const argv = args.trim().split(/\s+/);
	if (!SHELLS[path.basename(argv[0] ?? "").replace(/^-/, "")]) return false;
	if (/exec "?\$0"? -li/.test(args)) return true;
	return argv.slice(1).every(a => a.startsWith("-") && !a.includes("c"));
}

// The restart logic, apart from the command, so that a script can run it on a test terminal.
export function rexReloader(exec: ExtensionAPI["exec"]) {
	const rex = rexClient(exec);

	// The omp process: the foreground itself, or its omp child under `zsh -lc`.
	async function ompPid(t: Term): Promise<number | undefined> {
		if (!t.fgPid) return undefined;
		if (t.fgName === "omp") return t.fgPid;
		const child = (await exec("pgrep", ["-P", String(t.fgPid), "-x", "omp"])).stdout.trim().split("\n")[0];
		return child ? Number(child) : undefined;
	}

	// Rex terminals can run without SHELL, so read the account's login shell.
	async function loginShell(): Promise<string> {
		if (process.env.SHELL) return process.env.SHELL;
		const user = os.userInfo().username;
		const shell =
			process.platform === "darwin"
				? (await exec("dscl", [".", "-read", `/Users/${user}`, "UserShell"])).stdout.split(":")[1]
				: (await exec("getent", ["passwd", user])).stdout.trim().split(":")[6];
		return shell?.trim() || "/bin/sh";
	}

	// Every omp terminal, or those of the session named `only`. Rex keeps the last omp status after
	// omp ends, so a plain shell can still read as omp: an omp process must run there too.
	async function targets(only: string | undefined): Promise<Term[]> {
		const spaces = await rex.snapshot();
		const found: Term[] = [];
		for (const t of rex.terms(spaces.filter(s => !only || s.name === only)))
			if (t.app === "omp" && (await ompPid(t))) found.push(t);
		return found;
	}

	// Stops omp and starts `omp --resume <file>` in its place. For this session, `stop` ends omp
	// and a detached helper or the shell does the start, because nothing here runs after omp ends.
	// stop("signal") must end omp with SIGTERM, so that rex-resume.ts adds no quit mark; stop("quit")
	// is a normal quit.
	async function restart(target: Term, isSelf: boolean, stop: (how: StopHow) => void): Promise<Outcome> {
		const t = await rex.get(target);
		if (!isUp(t)) return { target, ok: false, note: `skipped: ${t.state ?? "unknown"}` };
		const pid = await ompPid(t);
		if (!pid) return { target, ok: false, note: "skipped: no omp process found" };
		// sessionFile reads the breadcrumb, else the files the omp process holds open; an omp that
		// resumed a file and has not written yet holds none open, but names it in its arguments.
		const resumed = (await exec("ps", ["-o", "args=", "-p", String(pid)])).stdout.match(/--resume\s+(\S+\.jsonl)/)?.[1];
		const file = (await rex.sessionFile({ ...t, fgName: "omp", fgPid: pid })) ?? (resumed && fs.existsSync(resumed) ? resumed : undefined);
		if (!file) return { target, ok: false, note: "skipped: no session file found" };
		const cwd = t.cwd ?? os.homedir();
		const where = ["-s", t.session, "-b", t.block];
		const proc = JSON.parse(await rex.run(["block", "call", ...where, "process"])) as BlockProcess;
		// The foreground is omp, under its ancestors; or omp's parent, when omp is its child.
		const parent = proc.foreground?.pid === pid ? proc.ancestors?.[0] : proc.foreground;
		const parentArgs = parent ? (await exec("ps", ["-o", "args=", "-p", String(parent.pid)])).stdout : "";

		// A restored shell reopens the breadcrumb at its first prompt; the quit mark stops that, so
		// only the typed command starts omp. The resumed omp writes the breadcrumb again.
		const markQuit = () => {
			if (!crumbFile(t.block)) return;
			const crumb = path.join(CRUMBS, uuid(t.block));
			if (fs.readFileSync(crumb, "utf8").split("\n")[1] !== "quit") fs.appendFileSync(crumb, "quit\n");
		};
		// Plain typed text, not a bracketed paste, because the shell's prompt takes it.
		const command = `omp --resume '${file.replaceAll("'", "'\\''")}'`;
		const typeCommand = async () => {
			await rex.run(["send", ...where, command]);
			await Bun.sleep(200);
			await rex.run(["send-key", ...where, "enter"]);
		};
		const stopOmp = async () => {
			process.kill(pid, "SIGTERM");
			const stopBy = Date.now() + STOP_MS;
			while (alive(pid) && Date.now() < stopBy) await Bun.sleep(200);
			return !alive(pid);
		};

		// A worker block of rex.ts: `$SHELL -lic '<wrapper>' rex-omp <task file>` runs omp, then
		// execs an interactive login shell, whose first prompt resumes the breadcrumb by itself
		// unless it says quit. So a SIGTERM (which adds no quit mark) is the whole restart, and
		// nothing is typed while omp may come back: the text would land in its editor. If no omp is
		// back after WRAPPED_MS and the foreground is a shell (no zsh hook), the command is typed.
		// Without a breadcrumb, the shell resumes nothing, so the shell path below types at once.
		const wrapped = /\brex-omp\b/.test(parentArgs) && !!crumbFile(t.block);
		if (wrapped) {
			if (isSelf) {
				const crumb = path.join(CRUMBS, uuid(t.block));
				const script = [
					'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; sleep "$7"',
					'"$2" block call -s "$3" -b "$4" process | grep -q \'"foreground":{[^}]*"name":"omp"\' && exit 0',
					'[ "$(sed -n 2p "$6")" = quit ] || echo quit >> "$6"',
					'"$2" send -s "$3" -b "$4" "$5" && sleep 0.2 && exec "$2" send-key -s "$3" -b "$4" enter',
				].join("\n");
				const args = [String(pid), REX, t.session, t.block, command, crumb, String(WRAPPED_MS / 1000)];
				spawn("sh", ["-c", script, "sh", ...args], { detached: true, stdio: "ignore" }).unref();
				stop("signal");
				return { target, ok: true, note: "restarts now" };
			}
			if (!(await stopOmp())) return { target, ok: false, note: "failed: omp did not stop in 15 s" };
			const by = Date.now() + WRAPPED_MS;
			let now: Term | undefined;
			let back: number | undefined;
			do {
				await Bun.sleep(500);
				now = await rex.get(t).catch(() => undefined);
				const found = now ? await ompPid(now) : undefined;
				back = found !== pid ? found : undefined;
			} while (!back && Date.now() < by);
			if (!back && now && SHELLS[path.basename(now.fgName ?? "").replace(/^-/, "")]) {
				markQuit();
				await typeCommand();
			}
			return backIn(target, t.block, pid);
		}
		if (/\brex-omp\b/.test(parentArgs) || shellStays(parentArgs)) {
			markQuit();
			if (isSelf) {
				const script =
					'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; sleep 0.5; "$2" send -s "$3" -b "$4" "$5" && sleep 0.2 && exec "$2" send-key -s "$3" -b "$4" enter';
				spawn("sh", ["-c", script, "sh", String(pid), REX, t.session, t.block, command], { detached: true, stdio: "ignore" }).unref();
				stop("quit");
				return { target, ok: true, note: "restarts now" };
			}
			if (!(await stopOmp())) return { target, ok: false, note: "failed: omp did not stop in 15 s" };
			await Bun.sleep(500);
			await typeCommand();
			return backIn(target, t.block, pid);
		}

		// The block ends with omp, and Rex closes it. A block split from it waits for the old omp to
		// end, then resumes the session; it takes the old block's place when that block closes. Its
		// shell stays after omp, so the next /reload uses the path above.
		const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; cd "$2" && omp --resume "$3"; exec "$0" -li';
		const shell = await loginShell();
		const out = await rex.run([
			"split", ...where, "--split", "right", "--focus=false", "-c", cwd, "--shell", "none", "--json",
			"--", shell, "-lic", script, shell, String(pid), cwd, file,
		]);
		const made = JSON.parse(out) as { block_id?: string; block_ids?: string[] };
		const block = made.block_id ?? made.block_ids?.[0];
		if (!block) return { target, ok: false, note: `failed: rex split gave no block: ${out.trim()}` };
		const short = block.replace(/^block:/, "").slice(-6);
		if (isSelf) {
			stop("quit");
			return { target, ok: true, note: `restarts now as ${short}` };
		}
		process.kill(pid, "SIGTERM");
		return backIn(target, block, pid, ` as ${short}`);
	}

	async function backIn(target: Term, block: string, oldPid: number, suffix = ""): Promise<Outcome> {
		const by = Date.now() + BACK_MS;
		while (Date.now() < by) {
			const t = await rex.get({ session: target.session, block }).catch(() => undefined);
			const pid = t ? await ompPid(t) : undefined;
			if (t && pid && pid !== oldPid && t.app === "omp" && isUp(t)) return { target, ok: true, note: `restarted${suffix}` };
			await Bun.sleep(500);
		}
		return { target, ok: false, note: `failed: omp did not come back in 60 s${suffix}, look at ${block.replace(/^block:/, "").slice(-6)}` };
	}

	return { targets, restart };
}

export default function rexReload(pi: ExtensionAPI) {
	const { targets, restart } = rexReloader(pi.exec);

	pi.registerCommand("reload", {
		description: "Restart every idle or done omp session in the Rex sessions (or in one session), this session last",
		handler: async (args, ctx) => {
			const only = args.trim() || undefined;
			const all = await targets(only);
			if (all.length === 0) {
				ctx.ui.notify(only ? `/reload: no omp session in a space named ${only}` : "/reload: no omp sessions found", "warning");
				return;
			}
			ctx.ui.notify(`/reload: restarting ${all.length} omp sessions, this one last`, "info");
			const others = all.filter(t => t.block !== SELF);
			const me = all.find(t => t.block === SELF);

			const outcomes: Outcome[] = [];
			const queue = [...others];
			await Promise.all(
				Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
					for (let t = queue.shift(); t; t = queue.shift())
						outcomes.push(await restart(t, false, () => {}).catch(err => ({ target: t!, ok: false, note: `failed: ${String(err)}` })));
				}),
			);

			const report = () => {
				const line = (o: Outcome) => `- ${o.target.short} (${o.target.sessionName.replace(/-\d{4}-\d{2}-\d{2}$/, "")}): ${o.note}`;
				const done = outcomes.filter(o => o.ok);
				const skipped = outcomes.filter(o => !o.ok);
				return [
					`/reload: ${done.length} restarted, ${skipped.length} skipped or failed.`,
					...(done.length ? ["Restarted:", ...done.map(line)] : []),
					...(skipped.length ? ["Skipped or failed (restart these by hand later):", ...skipped.map(line)] : []),
				].join("\n");
			};

			let stopping: StopHow | undefined;
			if (me) {
				const o = await restart(me, true, how => {
					stopping = how;
				}).catch(err => ({ target: me, ok: false, note: `failed: ${String(err)}` }));
				outcomes.push(o);
			}
			// Saved in this session, so the result shows here again after the resume.
			pi.sendMessage({ customType: "rex-reload", content: report(), display: true }, { triggerTurn: false });
			if (stopping) {
				await Bun.sleep(300);
				// omp's SIGTERM handler shuts down as a quit does, but rex-resume.ts adds no quit mark.
				if (stopping === "signal") process.kill(process.pid, "SIGTERM");
				else ctx.shutdown();
			} else ctx.ui.notify(report(), outcomes.every(o => o.ok) ? "info" : "warning");
		},
	});
}
