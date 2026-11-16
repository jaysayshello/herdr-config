// Read-only process sampling for the resources case. Everything here reads /bin/ps output: no
// signal, debugger or sampler ever touches a real process.
//
// CPU % comes from the cumulative CPU time ps reports (TIME, in hundredths of a second): the
// difference between two samples divided by the wall time between them. ps's own %cpu column is a
// decaying average, so it hides short bursts such as a poll.
import { now, run, sleep } from "./proc.ts";

export interface Proc {
	pid: number;
	ppid: number;
	// Cumulative CPU time (user + system) in seconds.
	cpu: number;
	// Resident memory in KB.
	rss: number;
	// Executable path (or bare name) as ps shows it.
	comm: string;
}

export interface Snap {
	// Wall time of the sample in ms (the middle of the ps call).
	t: number;
	procs: Map<number, Proc>;
}

// "19:45.43", "1:02:03.45" or "1-02:03:04" into seconds.
export function parseCpuTime(s: string): number {
	let days = 0;
	if (s.includes("-")) {
		const [d, rest] = s.split("-");
		days = Number(d);
		s = rest;
	}
	let secs = 0;
	for (const part of s.split(":")) secs = secs * 60 + Number(part);
	return days * 86400 + secs;
}

export const base = (comm: string) => comm.slice(comm.lastIndexOf("/") + 1);

// One snapshot of every process. /bin/ps by full path: the system ps gives TIME with hundredths.
export async function snapshot(): Promise<Snap> {
	const t0 = now();
	const r = await run("/bin/ps", ["-axww", "-o", "pid=,ppid=,time=,rss=,comm="], { timeoutMs: 5000 });
	const t = (t0 + now()) / 2;
	const procs = new Map<number, Proc>();
	for (const line of r.stdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		const pid = Number(m[1]);
		procs.set(pid, { pid, ppid: Number(m[2]), cpu: parseCpuTime(m[3]), rss: Number(m[4]), comm: m[5].trim() });
	}
	return { t, procs };
}

// Takes a snapshot every `everyMs` for `durationMs`.
export async function sampleFor(durationMs: number, everyMs = 250): Promise<Snap[]> {
	const snaps: Snap[] = [];
	const end = now() + durationMs;
	while (now() < end) {
		const next = now() + everyMs;
		snaps.push(await snapshot());
		const wait = next - now();
		if (wait > 0) await sleep(wait);
	}
	return snaps;
}

// The command line and environment of some processes (ps -E shows the environment of the user's
// own processes after the arguments). Used once, to tell real processes from sandboxed ones.
export async function commandsWithEnv(pids: number[]): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	if (pids.length === 0) return out;
	const r = await run("/bin/ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")], { timeoutMs: 5000 });
	for (const line of r.stdout.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(.*)$/);
		if (m) out.set(Number(m[1]), m[2]);
	}
	return out;
}

// The value of one environment variable in a ps -E line ("" when missing).
export function envVar(cmd: string, name: string): string {
	const m = cmd.match(new RegExp(`(?:^|\\s)${name}=(\\S*)`));
	return m ? m[1] : "";
}

// Every descendant pid of `root` in a snapshot.
export function descendants(snap: Snap, root: number): number[] {
	const kids = new Map<number, number[]>();
	for (const p of snap.procs.values()) {
		const list = kids.get(p.ppid) ?? [];
		list.push(p.pid);
		kids.set(p.ppid, list);
	}
	const out: number[] = [];
	const stack = [...(kids.get(root) ?? [])];
	while (stack.length) {
		const pid = stack.pop()!;
		out.push(pid);
		stack.push(...(kids.get(pid) ?? []));
	}
	return out;
}

// True when `root` has a `gh` process below it in this snapshot.
export const hasGh = (snap: Snap, root: number) => descendants(snap, root).some(pid => base(snap.procs.get(pid)!.comm) === "gh");

// The pids above `pid` (parent, grandparent, ...), from the snapshot.
export function ancestors(snap: Snap, pid: number): number[] {
	const out: number[] = [];
	let p = snap.procs.get(pid);
	while (p && p.ppid > 1 && !out.includes(p.ppid)) {
		out.push(p.ppid);
		p = snap.procs.get(p.ppid);
	}
	return out;
}

export interface Window {
	start: number;
	end: number;
	// The two snapshots that bound the window.
	a: Snap;
	b: Snap;
}

// Cuts the samples into back-to-back windows of about `ms` each.
export function windows(snaps: Snap[], ms = 1000): Window[] {
	const out: Window[] = [];
	let i = 0;
	while (i < snaps.length - 1) {
		let j = i + 1;
		while (j < snaps.length - 1 && snaps[j].t - snaps[i].t < ms) j++;
		if (snaps[j].t - snaps[i].t >= ms * 0.75) out.push({ start: snaps[i].t, end: snaps[j].t, a: snaps[i], b: snaps[j] });
		i = j;
	}
	return out;
}

// CPU % of some processes over one window (100 = one full core). A process that started or ended
// inside the window counts only for the part both snapshots see.
export function cpuPct(w: Window, pids: number[]): number {
	let secs = 0;
	for (const pid of pids) {
		const a = w.a.procs.get(pid);
		const b = w.b.procs.get(pid);
		if (a && b) secs += Math.max(0, b.cpu - a.cpu);
	}
	return (secs / ((w.end - w.start) / 1000)) * 100;
}

// Resident memory in MB of some processes at the end of a window.
export function rssMb(w: Window, pids: number[]): number {
	let kb = 0;
	for (const pid of pids) kb += w.b.procs.get(pid)?.rss ?? 0;
	return kb / 1024;
}

// Marks each window as poll or rest. `polled(w)` says a poll process (gh) ran during window w. A
// window is a poll window when a poll ran in it or in the window just before it (the app reads
// and draws the answer right after gh ends).
export function classify(ws: Window[], polled: (w: Window) => boolean): boolean[] {
	const seen = ws.map(polled);
	return seen.map((v, i) => v || (i > 0 && seen[i - 1]));
}

// The snapshots inside one window (both ends included).
export const snapsIn = (snaps: Snap[], w: Window) => snaps.filter(s => s.t >= w.start && s.t <= w.end);
export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
