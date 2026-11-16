// Helpers for the omp-start case: watch one test terminal closely, start omp in the test core,
// and end what was started. Everything here talks to the test core (HC_SESSION=herdrbench).
import * as fs from "node:fs";
import * as path from "node:path";
import type { Sandbox } from "./sandbox.ts";
import { now, run, sleep } from "./proc.ts";

// One change seen on the terminal. `at` is when the hc get that saw it started (our clock);
// statusMs is hc's own time of the last status change (exact, from the core).
export interface Seen {
	at: number;
	state?: string; // the program's status word: idle, working, done, ...
	app?: string;
	statusMs?: number;
	turn: number;
	fg?: string; // the foreground process name: sh, omp, ...
	pid?: number; // the foreground process id
	live?: string; // "live" or "finished"
}

export interface Trace {
	seen: Seen[];
	// Wall ms of each hc get call, to know what one poll costs.
	pollMs: number[];
	stop(): Promise<Seen[]>;
}

// Polls `hc get <terminal>` about every `everyMs` and keeps each change.
export function traceTerminal(sb: Sandbox, terminal: string, everyMs = 50): Trace {
	const seen: Seen[] = [];
	const pollMs: number[] = [];
	let stopped = false;
	const key = (s: Seen) => `${s.state}|${s.app}|${s.statusMs}|${s.turn}|${s.fg}|${s.live}`;
	const loop = (async () => {
		while (!stopped) {
			const at = now();
			const r = await run(sb.hc, ["get", terminal, "--json"], { timeoutMs: 10_000 });
			pollMs.push(r.ms);
			if (r.code === 0) {
				try {
					const t = JSON.parse(r.stdout);
					const s: Seen = {
						at,
						state: t.status?.state,
						app: t.status?.app,
						statusMs: t.status_ms ?? undefined,
						turn: t.turn ?? 0,
						fg: t.foreground?.name,
						pid: t.foreground?.pid,
						live: t.state,
					};
					if (!seen.length || key(seen[seen.length - 1]) !== key(s)) seen.push(s);
				} catch {}
			}
			const rest = everyMs - (now() - at);
			if (rest > 0) await sleep(rest);
		}
	})();
	return {
		seen,
		pollMs,
		async stop() {
			stopped = true;
			await loop;
			return seen;
		},
	};
}

// Short text of a trace for the log: "+120 fg=sh | +900 fg=omp | +4100 omp idle ...".
export function describe(seen: Seen[], t0: number): string {
	return seen
		.map(s => {
			const status = s.state ? ` ${s.app ?? "-"}:${s.state}@+${Math.round((s.statusMs ?? s.at) - t0)}` : "";
			return `+${Math.round(s.at - t0)} fg=${s.fg ?? "-"}${status} turn=${s.turn}${s.live === "finished" ? " finished" : ""}`;
		})
		.join(" | ");
}

// The address of a terminal hc run --bg started (hc prints the terminal record).
export function addressOf(out: string): string {
	const r = JSON.parse(out);
	const a = r.address ?? r.terminal?.address ?? r.terminal ?? r.id;
	if (typeof a !== "string") throw new Error(`no terminal address in hc run output: ${out.slice(0, 200)}`);
	return a;
}

// Starts argv in a new test terminal, in the background, with no parent.
export async function hcRunBg(sb: Sandbox, cwd: string, argv: string[]): Promise<{ terminal: string; t0: number }> {
	const t0 = now();
	const r = await run(sb.hc, ["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", cwd, "--", ...argv], { timeoutMs: 30_000 });
	if (r.code !== 0) throw new Error(`hc run: ${r.stderr || r.stdout}`);
	return { terminal: addressOf(r.stdout), t0 };
}

// Ends a test terminal and removes it; errors are ignored (it may be gone already).
export async function endTerminal(sb: Sandbox, terminal: string) {
	await run(sb.hc, ["kill", terminal, "--json"], { timeoutMs: 10_000 }).catch(() => {});
	await run(sb.hc, ["rm", terminal, "--json"], { timeoutMs: 10_000 }).catch(() => {});
}

// A second omp home inside the sandbox: the same links as the sandbox home (~/.claude, ~/.agents,
// ...) and its ~/.omp/agent, minus the entries named in `drop` (in either place). omp reads
// ~/.omp/agent from HOME, so `env HOME=<this> omp` starts with that part switched off. The real
// home is never changed: only links are made here.
export function altHome(sb: Sandbox, name: string, drop: string[]): string {
	const home = path.join(sb.root, `alt-${name}`);
	const agent = path.join(home, ".omp/agent");
	fs.rmSync(home, { recursive: true, force: true });
	fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
	const from = path.join(sb.home, ".omp/agent");
	for (const f of fs.readdirSync(from)) {
		const p = path.join(from, f);
		// Only the shared links: files a test omp wrote itself (history, logs) stay behind.
		if (drop.includes(f) || !fs.lstatSync(p).isSymbolicLink()) continue;
		fs.symlinkSync(fs.readlinkSync(p), path.join(agent, f));
	}
	for (const f of fs.readdirSync(sb.home)) {
		const p = path.join(sb.home, f);
		if (f !== ".omp" && !drop.includes(f) && fs.lstatSync(p).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(p), path.join(home, f));
	}
	return home;
}

// A test omp started with HOME=<alt home> runs hc there, and hc starts a second test core for
// that home (same session name, state under the alt home). This stops it, if one runs.
export async function stopCoreAt(sb: Sandbox, home: string) {
	await run(sb.hc, ["server", "stop", "--json"], { env: { HOME: home }, timeoutMs: 15_000 }).catch(() => {});
}

// A local server that takes connections and never answers: an MCP server that hangs (a slow
// network, a VPN half up, a stuck server). omp waits for it as it would for a real one.
export function hangingServer() {
	const open: { end(): void }[] = [];
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(s) {
				open.push(s);
			},
			data() {},
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/mcp`,
		connections: () => open.length,
		stop() {
			for (const s of open) s.end();
			server.stop(true);
		},
	};
}

// Where the main thread spent a macOS `sample` report: its leaf frames (the innermost call of
// each stack) added up by name, the largest first, as a share of all its samples. omp is a
// stripped binary, so its own frames show as "???"; system calls (close, read, ...) keep names.
export function mainThread(report: string, top = 8): string {
	const lines = report.split("\n");
	const start = lines.findIndex(l => /^\s+\d+ Thread_.*main-thread/.test(l));
	if (start < 0) return "(no main thread in the report)";
	const total = Number(lines[start].trim().split(" ")[0]);
	// Each frame line: tree marks, its sample count, then its name. Its depth is where the count starts.
	const frames: { depth: number; count: number; name: string }[] = [];
	for (const l of lines.slice(start + 1)) {
		const m = l.match(/^([\s+!:|]*?)(\d+) (.*)$/);
		if (!m || /^\s+\d+ Thread_/.test(l)) break;
		frames.push({ depth: m[1].length, count: Number(m[2]), name: m[3].replace(/\s*\[0x[0-9a-f,]+\]/g, "").replace(/\s+\+ \d+\s*$/, "").replace(/load address .*/, "").trim() });
	}
	const leaves = new Map<string, number>();
	frames.forEach((f, i) => {
		if ((frames[i + 1]?.depth ?? -1) > f.depth) return;
		leaves.set(f.name, (leaves.get(f.name) ?? 0) + f.count);
	});
	const rows = [...leaves].sort((a, b) => b[1] - a[1]).slice(0, top);
	return [`${total} samples`, ...rows.map(([name, count]) => `${Math.round((100 * count) / total)} %  ${name}`)].join("\n");
}

// How long omp `pid` reported its main thread blocked (sum of "ui.loop-blocked" blockedMs in its
// log under `home`); 0 when it reported none.
export function loopBlocked(home: string, pid: number | undefined): number {
	const dir = path.join(home, ".omp/logs");
	if (!pid || !fs.existsSync(dir)) return 0;
	const file = fs.readdirSync(dir).find(f => f.endsWith(`.${pid}.log`));
	if (!file) return 0;
	let ms = 0;
	for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
		if (!line.includes("ui.loop-blocked")) continue;
		try {
			ms += JSON.parse(line).blockedMs ?? 0;
		} catch {}
	}
	return ms;
}
