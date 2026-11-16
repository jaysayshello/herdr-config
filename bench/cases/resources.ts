// CPU and memory of Herdr and of every omp, at rest and while a poll runs.
//
// Part 1, the real processes (read only: one /bin/ps call every 125 ms, no signal, no sampler):
// the person's Herdr app, its herdr-core processes and every omp. For about 70 s, so the
// orchestrator's one-minute poll shows up once. The Herdr app runs `gh` every 5 s (t3-prs); the
// orchestrator omp runs `gh` every 60 s. A `gh` process below a pid marks a poll.
// Part 2, a test window from this repo's code (the code the improvement loop changes): a fake gh
// with 50 open pull requests, sampled for 30 s; the fake gh log marks its polls. Then `sample`
// (the macOS stack sampler) on the TEST app only, to see where its CPU goes.
//
// CPU % is the change in each process's cumulative CPU time over 1 s windows (100 % = one core).
// A window is a poll window when gh ran in it or in the window before (the answer is read and drawn
// right after gh ends); every other window is a rest window. One sample per window, so --runs does
// not repeat this case.
import * as fs from "node:fs";
import * as path from "node:path";
import { installFakeGh, prFixture } from "../lib/fakegh.ts";
import { Instance, startCore } from "../lib/instance.ts";
import { now, run, sleep, waitFor } from "../lib/proc.ts";
import {
	ancestors,
	base,
	classify,
	commandsWithEnv,
	cpuPct,
	envVar,
	hasGh,
	round,
	rssMb,
	sampleFor,
	snapsIn,
	snapshot,
	windows,
	type Snap,
	type Window,
} from "../lib/resources-ps.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

const REAL_MS = Number(process.env.BENCH_RESOURCES_REAL_MS ?? 70_000);
const TEST_MS = Number(process.env.BENCH_RESOURCES_TEST_MS ?? 30_000);
// How the orchestrator omp is recognised: its start folder or arguments contain this text.
const ORCH_MATCH = process.env.BENCH_ORCH_MATCH ?? "herdr-orchestrator";

// The real processes this case watches, found once before sampling.
interface Real {
	herdr?: number;
	cores: number[];
	omps: number[];
	helpers: number[];
	orchCandidates: number[];
	skippedOwn: number[];
}

// A process is sandboxed when its HOME (or anything in its command line) points into /tmp/hb-*.
const sandboxed = (cmd: string) => /^(\/private)?\/tmp\/hb-/.test(envVar(cmd, "HOME")) || envVar(cmd, "HC_SESSION") === "herdrbench" || cmd.includes("/tmp/hb-");

async function findReal(): Promise<Real> {
	const snap = await snapshot();
	const isHerdr = (c: string) => c.endsWith("Herdr.app/Contents/MacOS/Herdr");
	const picks = [...snap.procs.values()].filter(p => isHerdr(p.comm) || ["herdr-core", "omp"].includes(base(p.comm)));
	const cmds = await commandsWithEnv(picks.map(p => p.pid));
	// The omp that started this suite (an agent running bench/run.sh) works for the suite: leave it out.
	const own = new Set(ancestors(snap, process.pid));
	const real: Real = { cores: [], omps: [], helpers: [], orchCandidates: [], skippedOwn: [] };
	const herdrs: number[] = [];
	for (const p of picks) {
		const cmd = cmds.get(p.pid);
		if (cmd === undefined || sandboxed(cmd)) continue;
		if (isHerdr(p.comm)) herdrs.push(p.pid);
		else if (base(p.comm) === "herdr-core") real.cores.push(p.pid);
		else if (cmd.includes("__omp_worker")) real.helpers.push(p.pid);
		else if (own.has(p.pid)) real.skippedOwn.push(p.pid);
		else {
			real.omps.push(p.pid);
			if (envVar(cmd, "PWD").includes(ORCH_MATCH) || cmd.split(/\s\w+=/)[0].includes(ORCH_MATCH)) real.orchCandidates.push(p.pid);
		}
	}
	// The app launchd started (parent 1) is the person's window; test windows have a parent.
	real.herdr = herdrs.find(pid => snap.procs.get(pid)?.ppid === 1) ?? herdrs[0];
	return real;
}

const pct = (label: string, id: string, samples: number[], note: string, kind: Measure["kind"] = "local"): Measure => ({
	id: `resources.${id}`,
	label,
	unit: "%",
	kind,
	better: "lower",
	samples: samples.map(v => round(v)),
	note,
});
const mb = (label: string, id: string, samples: number[], note: string): Measure => ({
	id: `resources.${id}`,
	label,
	unit: "MB",
	kind: "local",
	better: "lower",
	samples: samples.map(v => round(v)),
	note,
});

// Rest and poll CPU of some pids, split by `poll` flags (one per window).
function split(ws: Window[], poll: boolean[], pids: number[]) {
	const rest: number[] = [];
	const busy: number[] = [];
	ws.forEach((w, i) => (poll[i] ? busy : rest).push(cpuPct(w, pids)));
	return { rest, busy };
}

async function realPart(ctx: Ctx, out: Measure[]) {
	const real = await findReal();
	ctx.log(
		`resources: real Herdr ${real.herdr ?? "not found"}, ${real.cores.length} herdr-core, ${real.omps.length} omp, ${real.helpers.length} omp helpers` +
			(real.skippedOwn.length ? `, left out the omp running the suite (${real.skippedOwn.join(",")})` : ""),
	);
	ctx.log(`resources: sampling real processes for ${REAL_MS / 1000} s`);
	// 125 ms, not 250: a real gh often ends within 250 ms, and a missed poll would count as rest.
	const snaps = await sampleFor(REAL_MS, 125);
	const ws = windows(snaps);
	const seconds = Math.round((snaps.at(-1)!.t - snaps[0].t) / 1000);

	// Herdr app.
	if (real.herdr) {
		const h = real.herdr;
		const poll = classify(ws, w => snapsIn(snaps, w).some(s => hasGh(s, h)));
		const { rest, busy } = split(ws, poll, [h]);
		const polls = countRuns(snaps.map(s => hasGh(s, h)));
		const note = `Real Herdr app, ${seconds} s at 125 ms, ${polls} gh polls seen (t3-prs waits 5 s after each poll; a real gh takes seconds), ${busy.length} poll and ${rest.length} rest windows of 1 s.`;
		if (rest.length) out.push(pct("Herdr app CPU at rest", "herdr-cpu-rest", rest, note));
		if (busy.length) out.push(pct("Herdr app CPU during a t3-prs poll", "herdr-cpu-poll", busy, note));
		else ctx.log("resources: no gh child of the real Herdr app seen (is the PR panel on?)");
		out.push(mb("Herdr app memory (RSS)", "herdr-rss", ws.map(w => rssMb(w, [h])), note));
	} else ctx.log("resources: the real Herdr app is not running; its measures are left out");

	if (real.cores.length) {
		const note = `All ${real.cores.length} real herdr-core processes (core and terminal holders), every window.`;
		out.push(pct("herdr-core CPU (sum)", "core-cpu", ws.map(w => cpuPct(w, real.cores)), note));
		out.push(mb("herdr-core memory (sum of RSS)", "core-rss", ws.map(w => rssMb(w, real.cores)), note));
	}

	// Profile evidence for the real app (ps numbers only): its CPU over time next to the CPU of all
	// omp sessions, whose terminal output the app must draw. A strong match means drawing terminal
	// output, not the PR poll, drives the app's CPU.
	if (real.herdr && real.omps.length) {
		const h = ws.map(w => cpuPct(w, [real.herdr!]));
		const o = ws.map(w => cpuPct(w, real.omps));
		const fives: number[] = [];
		for (let i = 0; i < h.length; i += 5) {
			const part = h.slice(i, i + 5);
			fives.push(round(part.reduce((a, b) => a + b, 0) / part.length));
		}
		ctx.log(`resources: real Herdr CPU % per 5 s: ${fives.join(" ")}`);
		ctx.log(`resources: correlation of real Herdr CPU with all omp CPU per window: ${round(correlation(h, o), 2)}`);
	}

	// The orchestrator: of the omp processes started in its project, the one that ran gh.
	const ghCount = new Map(real.orchCandidates.map(pid => [pid, snaps.filter(s => hasGh(s, pid)).length]));
	const polling = real.orchCandidates.filter(pid => ghCount.get(pid)! > 0).sort((a, b) => ghCount.get(b)! - ghCount.get(a)!);
	const orch = polling[0] ?? (real.orchCandidates.length === 1 ? real.orchCandidates[0] : undefined);
	let orchPoll = ws.map(() => false);
	if (orch) {
		orchPoll = classify(ws, w => snapsIn(snaps, w).some(s => hasGh(s, orch)));
		const { rest, busy } = split(ws, orchPoll, [orch]);
		const note = `The omp started in the orchestrator project that ran gh (${real.orchCandidates.length} omp started there, ${polling.length} ran gh in ${seconds} s); ${busy.length} poll and ${rest.length} rest windows.`;
		if (rest.length) out.push(pct("Orchestrator omp CPU at rest", "orchestrator-cpu-rest", rest, note));
		if (busy.length) out.push(pct("Orchestrator omp CPU during its gh poll", "orchestrator-cpu-poll", busy, note));
		else ctx.log("resources: the orchestrator ran no gh during the sampling");
	} else ctx.log(`resources: orchestrator not identified (${real.orchCandidates.length} candidates, none ran gh)`);

	// All omp processes: rest windows are those outside the orchestrator's poll.
	if (real.omps.length) {
		const rest = ws.filter((_, i) => !orchPoll[i]);
		// The biggest omp processes by memory, with their CPU over the whole sampling.
		const first = snaps[0];
		const last = snaps.at(-1)!;
		const table = real.omps
			.map(pid => {
				const a = first.procs.get(pid);
				const b = last.procs.get(pid);
				const cpu = a && b ? ((b.cpu - a.cpu) / ((last.t - first.t) / 1000)) * 100 : 0;
				return { pid, rss: (b ?? a)?.rss ?? 0, cpu };
			})
			.sort((x, y) => y.rss - x.rss)
			.slice(0, 6)
			.map(r => `pid ${r.pid}${r.pid === orch ? " (orchestrator)" : ""} ${Math.round(r.rss / 1024)} MB ${round(r.cpu)} %`)
			.join("; ");
		const note = `Sum over ${real.omps.length} real omp sessions (omp helper processes and the omp running the suite left out). Biggest: ${table}.`;
		out.push(pct("All omp sessions CPU at rest (sum)", "omp-cpu-rest-total", rest.map(w => cpuPct(w, real.omps)), note));
		out.push(mb("All omp sessions memory (sum of RSS)", "omp-rss-total", ws.map(w => rssMb(w, real.omps)), note));
		out.push({
			id: "resources.omp-count",
			label: "omp sessions running",
			unit: "count",
			kind: "local",
			better: "none",
			samples: [real.omps.length],
			note: `Plus ${real.helpers.length} omp helper processes (__omp_worker…).`,
		});
	}
	if (real.helpers.length) {
		const note = `${real.helpers.length} omp helper processes (__omp_worker…: js eval, daemon brokers), every window.`;
		out.push(pct("omp helper processes CPU (sum)", "omp-helper-cpu-total", ws.map(w => cpuPct(w, real.helpers)), note));
		out.push(mb("omp helper processes memory (sum of RSS)", "omp-helper-rss-total", ws.map(w => rssMb(w, real.helpers)), note));
	}
}

// How many separate runs of `true` a list of flags has (a gh process seen in back-to-back
// snapshots is one poll).
function countRuns(flags: boolean[]) {
	return flags.filter((v, i) => v && !flags[i - 1]).length;
}

// Pearson correlation of two equal-length lists: 1 = they rise and fall together, 0 = unrelated.
function correlation(x: number[], y: number[]) {
	const mx = x.reduce((a, b) => a + b, 0) / x.length;
	const my = y.reduce((a, b) => a + b, 0) / y.length;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < x.length; i++) {
		sxy += (x[i] - mx) * (y[i] - my);
		sxx += (x[i] - mx) ** 2;
		syy += (y[i] - my) ** 2;
	}
	return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

async function testPart(ctx: Ctx, out: Measure[]) {
	const sb = ctx.sandbox;
	await startCore(sb);
	const gh = installFakeGh(sb);
	// The fake gh answers every query with one file, so the file holds both the pull request list
	// (viewer) and an empty answer for the per pull request queries (comments.js, owners.js). With
	// the list alone those queries fail, and t3-prs asks again on every poll (50 extra gh runs).
	const list = prFixture(50);
	const empty = { nodes: [] };
	const pullRequest = { files: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, comments: empty, reviews: empty, reviewThreads: empty };
	gh.setGraphql({ data: { ...list.data, repository: { a: null, b: null, c: null, pullRequest } } });
	const { instance } = await Instance.start(sb, { waitFrame: true });
	const pid = instance.proc.pid;
	// Wait for t3-prs's first poll and its first round of per pull request queries (comments for all
	// 50, code owners for the approved ones), then for one quiet poll: the steady state the user has.
	await waitFor(() => gh.calls().length >= 51, "the first t3-prs poll and its comment queries", 30_000, 100);
	await sleep(6000);
	ctx.log(`resources: sampling the test window (pid ${pid}) for ${TEST_MS / 1000} s`);
	const t0 = now();
	const snaps = await sampleFor(TEST_MS);
	const calls = gh.calls().filter(c => c.end >= t0);
	const ws = windows(snaps);
	const poll = classify(ws, w => calls.some(c => c.start <= w.end && c.end >= w.start));
	const { rest, busy } = split(ws, poll, [pid]);
	const note = `Test window from this repo, fake gh with 50 open pull requests, ${Math.round(TEST_MS / 1000)} s at 250 ms, ${calls.length} gh calls, ${busy.length} poll and ${rest.length} rest windows.`;
	if (rest.length) out.push(pct("Test Herdr CPU at rest", "test-herdr-cpu-rest", rest, note));
	if (busy.length) out.push(pct("Test Herdr CPU during a t3-prs poll", "test-herdr-cpu-poll", busy, note));
	out.push(mb("Test Herdr memory (RSS)", "test-herdr-rss", ws.map(w => rssMb(w, [pid])), note));

	// Profile: the macOS stack sampler on the test app only (3 s). The heaviest frames go to the log;
	// the whole report stays in the sandbox (bench/run.sh --keep keeps it).
	const report = path.join(sb.root, "test-herdr-sample.txt");
	const r = await run("/usr/bin/sample", [String(pid), "3", "1", "-mayDie", "-file", report], { timeoutMs: 20_000 });
	if (r.code === 0 && fs.existsSync(report)) {
		const text = fs.readFileSync(report, "utf8");
		// Threads waiting in the kernel are idle; the frames left are where the CPU went.
		const idle = /__workq_kernreturn|mach_msg2_trap|semaphore_(timed)?wait_trap|__psynch_cvwait|__accept|^read |__select|kevent|Binary Images|^0x/;
		const top = (text.split("Sort by top of stack")[1] ?? "").split("\n").slice(1, 40).map(l => l.trim()).filter(l => l && !idle.test(l));
		ctx.log(`resources: test app busy frames (sample, 3 s): ${top.slice(0, 10).join(" | ") || "none: every thread waited the whole time"}`);
	} else ctx.log(`resources: sample failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
	await instance.stop();
}

export default {
	id: "resources",
	title: "CPU and memory of Herdr and omp, at rest and during polls",
	async run(ctx) {
		const out: Measure[] = [];
		await realPart(ctx, out);
		try {
			await testPart(ctx, out);
		} catch (err) {
			ctx.log(`resources: test window part failed: ${err instanceof Error ? err.message : err}`);
		}
		if (!out.length) throw new Error("no Herdr or omp process to measure");
		return out;
	},
} satisfies Case;
