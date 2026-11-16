// orchestrator: how fast the orchestrator's Herdr tools and extensions answer. It loads the real
// files from orchestrator/.omp in this checkout (tools/herdr.ts, extensions/herdr-watch.ts,
// extensions/herdr-reload.ts) outside omp, with lib/orch.ts's fake `pi`, and points them at the test
// window and test core, where 10 spaces hold 18 fake omp workers (lib/orchestrator-world.ts).
//   spaces  herdr_spaces: herdr-app ls, then one hc get per terminal
//   send    herdr_send to an idle worker, until the prompt starts
//   watch   herdr_watch's return (the watch itself goes on in the background)
//   report  the worker stops -> the <herdr-report> message arrives (SETTLE_MS 1000 is by design)
//   reload  /reload tmp-bench-reload: a real omp in a test space stops and resumes its session
import { assertNotReal, BENCH_ROOT } from "../lib/guard.ts";
import { hc, Instance, startCore } from "../lib/instance.ts";
import { fakeCtx, fakePi, orchFile, type FakePi } from "../lib/orch.ts";
import { buildWorld, closeWorld, crumbDir, removeCrumb, stateAt, untilFree, WORK_MS, writeCrumb, type World } from "../lib/orchestrator-world.ts";
import { now, run, sleep, waitFor } from "../lib/proc.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Case, Ctx, Measure } from "../lib/types.ts";

// The only programs the orchestrator files may start here.
const ALLOWED: Record<string, true> = { hc: true, "herdr-app": true, ps: true, pgrep: true, lsof: true, env: true, dscl: true };
const RELOAD_SPACE = "tmp-bench-reload";

type Exec = FakePi["execs"][number];
// The tools return { content, details }; this case reads only details.
interface Tool {
	name: string;
	execute(...args: unknown[]): Promise<{ details: unknown }>;
}
interface SpacesDetails {
	self: { space: string | null };
	spaces: { tabs: { terminals: unknown[] }[] }[];
}
interface HcGet {
	created_ms?: number;
	turn?: number;
	cwd?: string;
	foreground?: { pid?: number; cwd?: string } | null;
	status?: { app?: string; state?: string } | null;
}

// What each hc send printed (its JSON says whether the prompt started), for the log.
const sendOut = new Map<Exec, string>();

// A fake pi whose exec refuses anything but the programs above, re-checks that hc and herdr-app
// point at the test core and window, and records every call with its start time and duration.
function makePi(): FakePi {
	const pi: FakePi = fakePi({
		exec: async (cmd, args, o = {}) => {
			if (!ALLOWED[cmd]) throw new Error(`orchestrator case: refused to run ${cmd}`);
			if (process.env.HC_SESSION !== "herdrbench" || !process.env.HERDR_APP_HOME?.startsWith(BENCH_ROOT))
				throw new Error("orchestrator case: hc or herdr-app would reach the real core or window");
			const r = await run(cmd, args, { signal: o.signal, cwd: o.cwd, timeoutMs: o.timeout });
			const entry = { at: now() - r.ms, ms: r.ms, cmd, args };
			pi.execs.push(entry);
			if (args.includes("send")) sendOut.set(entry, r.stdout.trim());
			return r;
		},
	});
	return pi;
}

// A fresh copy of an orchestrator file: each module reads HC_TERMINAL_ID once at import, and
// another case may have imported the same file before with another value.
const load = (ctx: Ctx, rel: string) => import(`${orchFile(ctx.repo, rel)}?orchestrator-case`);

const end = (e: Exec) => e.at + e.ms;
const round = (x: number) => Math.round(x);

function measure(id: string, label: string, samples: number[], note?: string, extra: Partial<Measure> = {}): Measure {
	return { id: `orchestrator.${id}`, label, unit: "ms", kind: "local", better: "lower", samples, note, ...extra };
}

async function spacesCase(ctx: Ctx, pi: FakePi, tool: Tool, out: Measure[]) {
	const total: number[] = [];
	const execCount: number[] = [];
	const lsMs: number[] = [];
	const getMs: number[] = [];
	const getPhase: number[] = [];
	for (let r = 0; r < ctx.runs; r++) {
		const mark = pi.execs.length;
		const t0 = now();
		const res = await tool.execute("bench", {}, undefined, fakeCtx(), undefined);
		total.push(now() - t0);
		const execs = pi.execs.slice(mark);
		execCount.push(execs.length);
		const ls = execs.find(e => e.cmd === "herdr-app" && e.args[0] === "ls");
		const gets = execs.filter(e => e.cmd === "hc" && e.args[0] === "get");
		if (ls) lsMs.push(ls.ms);
		getMs.push(...gets.map(e => e.ms));
		// The per-terminal gets run together once ls (and the orchestrator's own get) are back.
		const late = gets.filter(e => ls && e.at >= end(ls) - 1);
		if (late.length) getPhase.push(Math.max(...late.map(end)) - Math.min(...late.map(e => e.at)));
		if (r === 0) {
			const d = res.details as SpacesDetails;
			const terms = d.spaces.reduce((n, s) => n + s.tabs.reduce((m, t) => m + t.terminals.length, 0), 0);
			ctx.log(`orchestrator: herdr_spaces saw ${d.spaces.length} spaces, ${terms} terminals (own space ${d.self.space} left out); ${execs.length} processes`);
		}
	}
	out.push(
		measure("spaces", "herdr_spaces call (11 spaces, 19 terminals)", total),
		measure("spaces_procs", "processes herdr_spaces starts per call", execCount, "herdr-app ls + 1 hc get for itself + 1 hc get per terminal", { unit: "count" }),
		measure("spaces_ls", "herdr-app ls inside herdr_spaces", lsMs, undefined, { better: "none" }),
		measure("spaces_get", "one hc get inside herdr_spaces (all of them run at once)", getMs, undefined, { better: "none" }),
		measure("spaces_get_phase", "first to last per-terminal hc get in one herdr_spaces call", getPhase, undefined, { better: "none" }),
	);

	// For comparison: one `hc ls` that lists every terminal, and one lone hc get.
	const hcLs: number[] = [];
	const oneGet: number[] = [];
	const someone = pi.execs.findLast(e => e.args[0] === "get")?.args[1] ?? "t1";
	for (let r = 0; r < ctx.runs; r++) {
		const a = await run("hc", ["ls", "--json"]);
		if (a.code === 0) hcLs.push(a.ms);
		const b = await run("hc", ["get", someone, "--json"]);
		if (b.code === 0) oneGet.push(b.ms);
		if (r === 0) {
			// hc ls --json: { terminals: [{ address, agent, status, turn, cwd, where, … }] }.
			const listed: { terminals: { address: string }[] } = JSON.parse(a.stdout);
			const entry = listed.terminals.find(t => t.address === someone);
			ctx.log(`orchestrator: hc ls entry of ${someone}: ${JSON.stringify(entry)}`);
			ctx.log(`orchestrator: hc get ${someone}: ${b.stdout.replace(/\s+/g, " ").slice(0, 600)}`);
		}
	}
	out.push(
		measure("hc_ls", "one hc ls --json (all terminals), for comparison", hcLs, undefined, { better: "none" }),
		measure("hc_get", "one hc get on its own, for comparison", oneGet, undefined, { better: "none" }),
	);
}

// send, watch and report in one go per run, as the orchestrator does them: herdr_send, then
// herdr_watch with the turn it returned, then the report when the worker stops. The first half of
// the runs gives the worker a breadcrumb and a session file (the normal path: the answer comes from
// the session); the second half has none, so the watch reads the screen (hc read).
async function workCase(ctx: Ctx, world: World, pi: FakePi, send: Tool, watch: Tool, forgetEvent: string, out: Measure[]) {
	const sendMs: number[] = [];
	const sendSendMs: number[] = [];
	const sendTyped: number[] = [];
	const watchMs: number[] = [];
	const reportSession: number[] = [];
	const reportScreen: number[] = [];
	const waitLag: number[] = [];
	const afterWait: number[] = [];
	const tail: number[] = [];
	const readMs: number[] = [];
	const answerMs: number[] = [];
	const sctx = fakeCtx();
	let k = 0;
	for (const withCrumb of [true, false]) {
		for (let r = 0; r < ctx.runs; r++, k++) {
			const w = world.workers[k % world.workers.length];
			await untilFree(ctx.sandbox, w.terminal);
			if (withCrumb) await writeCrumb(ctx.sandbox, w.terminal);
			else removeCrumb(w.terminal);

			const mark = pi.execs.length;
			const t0 = now();
			const sent = await send.execute("send", { terminal: w.terminal, text: `bench task ${k}` }, undefined, sctx, undefined);
			const t1 = now();
			sendMs.push(t1 - t0);
			const hcSend = pi.execs.slice(mark).find(e => e.args[0] === "send");
			if (hcSend) sendSendMs.push(hcSend.ms);
			// When the worker got the line: its `working` log line, from the start of hc send.
			const working = stateAt(world, w.terminal, "working", t0);
			if (hcSend && working) sendTyped.push(working - hcSend.at);

			// herdr_watch has the extension tool order: (id, params, signal, onUpdate, ctx).
			const details = sent.details;
			const turn = details && typeof details === "object" && "turn" in details && typeof details.turn === "number" ? details.turn : 0;
			await watch.execute("watch", { terminal: w.terminal, after_turn: turn, prompt: "bench task" }, undefined, undefined, sctx);
			const t2 = now();
			watchMs.push(t2 - t1);

			const report = await waitFor(
				() => pi.sent.find(s => s.at > t2 && s.message.customType === "herdr-report" && s.message.content?.includes(`terminal="${w.terminal}"`)),
				`the herdr-report of ${w.terminal}`,
				WORK_MS + 20_000,
				5,
			);
			// Stop the follow-up watch (it keeps polling for 10 minutes otherwise).
			pi.events.emit(forgetEvent, { terminal: w.terminal });
			const done = stateAt(world, w.terminal, "done", t0);
			if (!done) {
				ctx.log(`orchestrator: no done line for ${w.terminal} in the fake worker log`);
				continue;
			}
			if (!report.message.content?.includes(withCrumb ? "answer (session" : "answer (screen")) ctx.log(`orchestrator: ${w.terminal} report read the wrong source`);
			(withCrumb ? reportSession : reportScreen).push(report.at - done);

			// Where the report time goes, from the processes the watch started for this terminal.
			const mine = pi.execs.slice(mark).filter(e => e.args.includes(w.terminal));
			const wait = mine.find(e => e.args[0] === "wait" && end(e) >= done);
			const gets = mine.filter(e => e.args[0] === "get" && e.at < report.at && wait && e.at >= end(wait) - 1);
			const read = mine.find(e => e.args[0] === "read" && e.at < report.at);
			if (wait) waitLag.push(end(wait) - done);
			if (wait && gets[0]) afterWait.push(end(gets[0]) - end(wait));
			const last = gets.at(-1);
			if (last) tail.push(report.at - last.at);
			if (last && read) readMs.push(read.ms);
			if (last && !read) answerMs.push(report.at - end(last));
			if (r === 0)
				ctx.log(
					`orchestrator: report ${withCrumb ? "session" : "screen"} ${w.terminal}, ms after the stop: hc wait back +${wait ? round(end(wait) - done) : "?"}, ` +
						gets.map(g => `hc get ${round(g.at - done)}..${round(end(g) - done)}`).join(", ") +
						(read ? `, hc read ${round(read.at - done)}..${round(end(read) - done)}` : "") +
						`, report sent +${round(report.at - done)}`,
				);
		}
	}
	for (const w of world.workers) removeCrumb(w.terminal);
	const n = ctx.runs;
	out.push(
		measure("send", "herdr_send to an idle worker, until its prompt starts", sendMs, `${2 * n} runs; hc get, hc send, then hc get every 500 ms until the prompt starts`),
		measure("send_hc_send", "the hc send inside herdr_send", sendSendMs, undefined, { better: "none" }),
		measure("send_typed", "hc send starts -> the worker reads the line (reports working)", sendTyped, undefined, { better: "none" }),
		measure("watch", "herdr_watch call until it returns", watchMs, `${2 * n} runs; one hc get, the watch goes on in the background`),
		measure("report", "worker stops -> <herdr-report> sent (answer from its session file)", reportSession, "includes SETTLE_MS 1000 by design"),
		measure("report_screen", "worker stops -> <herdr-report> sent (no breadcrumb: answer from hc read)", reportScreen, "includes SETTLE_MS 1000 by design"),
		measure("report_wait_lag", "worker stops -> its hc wait returns", waitLag, undefined, { better: "none" }),
		measure("report_first_get", "hc wait returned -> the hc get after it is back", afterWait, undefined, { better: "none" }),
		measure("report_tail", "settle over (last hc get starts) -> report sent", tail, "last hc get + session read or hc read + sendMessage", { better: "none" }),
		measure("report_read", "hc read of the screen (no breadcrumb)", readMs, undefined, { better: "none" }),
		measure("report_session_read", "last hc get back -> report sent, answer from the session file", answerMs, undefined, { better: "none" }),
	);
}

// The omp process of a terminal, found as herdr-reload.ts finds it: the foreground itself, or
// its omp child under `zsh -lc`.
async function ompPid(fg: number | undefined): Promise<number | undefined> {
	if (!fg) return undefined;
	const comm = (await run("ps", ["-o", "comm=", "-p", String(fg)])).stdout.trim();
	if (path.basename(comm) === "omp") return fg;
	const child = (await run("pgrep", ["-P", String(fg), "-x", "omp"])).stdout.trim().split("\n")[0];
	return child ? Number(child) : undefined;
}

interface ReloadCommand {
	handler(args: string, ctx: unknown): Promise<void>;
}

interface ReloadTimes {
	total: number[];
	find: number[];
	stop: number[];
	gap: number[];
	typing: number[];
	boot: number[];
	noticed: number[];
}

// A session file with only its header, as omp writes it at start, so the test omp can start with
// --resume and /reload has a session to resume without any model call. omp pads the title line to
// 255 characters so it can rewrite the title in place.
function emptySession(sb: Ctx["sandbox"], folder: string): string {
	const real = fs.realpathSync(folder);
	const dir = path.join(sb.home, ".omp/agent/sessions", `-${real.replaceAll("/", "-")}--`);
	assertNotReal(dir);
	fs.mkdirSync(dir, { recursive: true });
	const id = crypto.randomUUID();
	const at = new Date().toISOString();
	const file = path.join(dir, `${at.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const bare = JSON.stringify({ type: "title", v: 1, title: "", updatedAt: at, pad: "" });
	const title = JSON.stringify({ type: "title", v: 1, title: "", updatedAt: at, pad: " ".repeat(Math.max(0, 255 - bare.length)) });
	const session = JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: folder });
	fs.writeFileSync(file, `${title}\n${session}\n`);
	return file;
}

// /reload of one test space with a real omp in it. The omp runs with HOME in the sandbox, so its
// session file and breadcrumb are sandbox files.
async function reloadCase(ctx: Ctx, instance: Instance, world: World, out: Measure[]) {
	const sb = ctx.sandbox;
	const folder = sb.work("reload");
	// Starts omp in the test space and waits until hc reports it idle; closes the space if it never is.
	const open = async (argv: string[], waitMs: number) => {
		const c = await instance.app<{ space: string; terminal: string }>(["do", "space.new", "--name", RELOAD_SPACE, "--folder", folder, "--tab", "main", "--argv", JSON.stringify(argv), "--focus", "false"]);
		world.spaceIds.push(c.space);
		const t0 = now();
		const ready = await waitFor(async () => {
			const i = await hc<HcGet>(sb, ["get", c.terminal]).catch(() => undefined);
			return i?.status?.app === "omp" && i.status.state === "idle" ? i : undefined;
		}, `omp in ${RELOAD_SPACE} to report idle`, waitMs, 100).catch(() => undefined);
		if (ready) ctx.log(`orchestrator: real omp (${argv.join(" ").replace(BENCH_ROOT, "<sandbox>")}) idle in ${round(now() - t0)} ms on ${c.terminal}`);
		else {
			const screen = (await run("hc", ["read", c.terminal, "--lines", "0"])).stdout.split("\n").filter(l => l.trim()).slice(-8).join(" | ");
			ctx.log(`orchestrator: reload: ${c.terminal} screen: ${screen.replaceAll(BENCH_ROOT, "<sandbox>").slice(0, 600)}`);
			await instance.app(["do", "space.close", "--id", c.space, "--confirmed", "true"]).catch(() => {});
		}
		return ready ? { t: c.terminal, info: ready } : undefined;
	};
	const resumed = await open(["omp", "--resume", emptySession(sb, folder)], 20_000);
	if (!resumed) ctx.log("orchestrator: reload: omp --resume of a header-only session did not come up; starting a plain omp");
	const opened = resumed ?? (await open(["omp"], 60_000));
	if (!opened) throw new Error("omp did not report idle in 60 s");
	const t = opened.t;
	let info = opened.info;
	const getT = () => hc<HcGet>(sb, ["get", t]).catch(() => undefined);
	const idle = async () => {
		const i = await getT();
		return i?.status?.app === "omp" && (i.status.state === "idle" || i.status.state === "done") ? i : undefined;
	};

	// Safety: this omp must be the sandbox one: its folder is in the sandbox, and so is its breadcrumb.
	const cwd = fs.realpathSync(info.foreground?.cwd ?? info.cwd ?? "/");
	if (!cwd.startsWith(fs.realpathSync(BENCH_ROOT))) throw new Error(`the omp on ${t} runs in ${cwd}, not in the sandbox`);
	const crumb = path.join(crumbDir(), t);
	assertNotReal(crumb);

	// /reload needs the breadcrumb's session file on disk. With the header-only session above it is
	// there at once; if omp did not take it, one tiny prompt makes omp write its own.
	const sessionOf = () => {
		try {
			const [created, file] = fs.readFileSync(crumb, "utf8").split("\n");
			return created === String(info.created_ms) && file && fs.existsSync(file) ? file : undefined;
		} catch {
			return undefined;
		}
	};
	let modelCalls = 0;
	const early = await waitFor(async () => sessionOf(), "the breadcrumb", 5000, 50).catch(() => undefined);
	if (!early) {
		ctx.log("orchestrator: reload: no breadcrumb with a session file after 5 s, sending one tiny prompt");
		const turn = info.turn ?? 0;
		await run("env", ["-u", "HC_TERMINAL_ID", "hc", "send", t, "Reply with the single word: ok"]);
		modelCalls = 1;
		info = await waitFor(
			async () => {
				const i = await idle();
				return i && (i.turn ?? 0) > turn ? i : undefined;
			},
			"the tiny prompt to finish",
			90_000,
			200,
		);
		await waitFor(async () => sessionOf(), "the session file", 10_000, 100);
	}
	const session = sessionOf()!;
	assertNotReal(session);
	if (!fs.realpathSync(session).startsWith(fs.realpathSync(BENCH_ROOT))) throw new Error(`session file ${session} is not in the sandbox`);

	// The real file, then an experiment: a sandbox copy of it that types `omp --resume` with hc send
	// but does not wait for hc send to return.
	const realPi = makePi();
	(await load(ctx, "extensions/herdr-reload.ts")).default(realPi);
	const times = await timeReloads(ctx, realPi, realPi.commands.get("reload") as ReloadCommand, t, crumb, idle, getT, true);

	const src = fs.readFileSync(orchFile(ctx.repo, "extensions/herdr-reload.ts"), "utf8");
	const awaited = 'await run("env", ["-u", "HC_TERMINAL_ID", "hc", "send", t.terminal, command]);';
	let nowait: number[] = [];
	if (src.includes(awaited)) {
		const copy = path.join(sb.work("orchestrator-experiment"), "herdr-reload-nowait.ts");
		assertNotReal(copy);
		fs.writeFileSync(copy, src.replace(awaited, awaited.replace("await run(", "void run(").replace(");", ").catch(() => {});")));
		const expPi = makePi();
		// A runtime path (the sandbox copy), so a static import cannot work.
		(await import(copy)).default(expPi);
		nowait = (await timeReloads(ctx, expPi, expPi.commands.get("reload") as ReloadCommand, t, crumb, idle, getT, false)).total;
	} else ctx.log("orchestrator: reload experiment skipped: the hc send line of herdr-reload.ts changed");

	const note = `${ctx.runs} runs; ${modelCalls} model calls`;
	out.push(
		measure("reload", "/reload of one idle omp until it is idle again", times.total, note),
		measure("reload_find", "/reload: find the session (herdr-app ls, hc get, ps, pgrep) until SIGTERM", times.find, undefined, { better: "none" }),
		measure("reload_stop", "/reload: SIGTERM until the old omp has ended", times.stop, undefined, { better: "none" }),
		measure("reload_gap", "/reload: old omp ended until omp --resume is typed (200 ms poll + 500 ms sleep)", times.gap, undefined, { better: "none" }),
		measure("reload_hc_send", "/reload: the hc send that types omp --resume, until it returns", times.typing, undefined, { better: "none" }),
		measure("reload_boot", "/reload: omp --resume typed until the new omp's session start (breadcrumb written)", times.boot, undefined, { better: "none" }),
		measure("reload_noticed", "/reload: new session start until the command returns", times.noticed, undefined, { better: "none" }),
		measure("reload_nowait", "experiment: /reload with a sandbox copy that does not wait for that hc send", nowait, `${ctx.runs} runs; not the repo code`, { better: "none" }),
	);
}

// Runs /reload tmp-bench-reload ctx.runs times and splits each run into its phases.
async function timeReloads(
	ctx: Ctx,
	pi: FakePi,
	cmd: ReloadCommand,
	t: string,
	crumb: string,
	idle: () => Promise<HcGet | undefined>,
	getT: () => Promise<HcGet | undefined>,
	detail: boolean,
): Promise<ReloadTimes> {
	const times: ReloadTimes = { total: [], find: [], stop: [], gap: [], typing: [], boot: [], noticed: [] };
	const notes: string[] = [];
	const rctx = {
		ui: { notify: (m: string) => notes.push(m), setWidget() {}, setStatus() {} },
		hasUI: true,
		shutdown() {
			throw new Error("reload tried to stop this process");
		},
	};
	for (let r = 0; r < ctx.runs; r++) {
		const before = await waitFor(idle, "omp idle before reload", 60_000, 100);
		const oldPid = await ompPid(before.foreground?.pid);
		if (!oldPid) throw new Error(`no omp process on ${t}`);
		const crumbBefore = fs.statSync(crumb).mtimeMs;
		// Beside the command: watch the old omp end (every 10 ms), what hc reports (every 100 ms),
		// and the breadcrumb: the new omp rewrites it at its session start.
		let deadAt = 0;
		let crumbAt = 0;
		const states: string[] = [];
		let polling = true;
		const pollDead = (async () => {
			while (polling && !deadAt) {
				try {
					process.kill(oldPid, 0);
				} catch {
					deadAt = now();
				}
				await sleep(10);
			}
		})();
		const pollTerm = (async () => {
			while (polling) {
				const s = `${(await getT())?.status?.state ?? "none"}`;
				if (states.at(-1)?.split("@")[0] !== s) states.push(`${s}@${now()}`);
				try {
					const m = fs.statSync(crumb).mtimeMs;
					if (!crumbAt && m !== crumbBefore && fs.readFileSync(crumb, "utf8").split("\n")[2] !== "quit") crumbAt = m;
				} catch {}
				await sleep(100);
			}
		})();
		const mark = pi.execs.length;
		const n0 = notes.length;
		const sendsBefore = pi.execs.filter(e => e.cmd === "env").length;
		const s0 = now();
		await cmd.handler(RELOAD_SPACE, rctx);
		const s1 = now();
		polling = false;
		await Promise.all([pollDead, pollTerm]);
		// The experiment leaves its hc send running: let it end before the next run.
		await waitFor(() => pi.execs.filter(e => e.cmd === "env").length > sendsBefore, "the hc send of /reload", 20_000, 50).catch(() => {});
		const report = pi.sent.at(-1)?.message.content ?? "";
		if (!/^\/reload: 1 restarted/.test(report)) {
			ctx.log(`orchestrator: reload run ${r} did not restart: ${report || notes.slice(n0).join(" | ")}`);
			continue;
		}
		times.total.push(s1 - s0);
		if (!detail) continue;
		const execs = pi.execs.slice(mark);
		const typed = execs.find(e => e.cmd === "env");
		// The last process before the SIGTERM: the omp look-up in restart().
		const prep = execs.filter(e => deadAt && end(e) <= deadAt);
		const killAt = prep.length ? end(prep.at(-1)!) : s0;
		if (deadAt && typed) {
			times.find.push(killAt - s0);
			times.stop.push(deadAt - killAt);
			times.gap.push(typed.at - deadAt);
			times.typing.push(typed.ms);
			if (crumbAt) times.boot.push(crumbAt - typed.at);
			if (crumbAt) times.noticed.push(s1 - crumbAt);
		}
		if (r === 0) {
			const rel = (x: number) => (x ? `+${round(x - s0)}` : "?");
			ctx.log(
				`orchestrator: reload, ms after start: SIGTERM ${rel(killAt)} (${prep.length} processes before), old omp ended ${rel(deadAt)}, ` +
					`hc send of omp --resume ${typed ? `${rel(typed.at)}..${rel(end(typed))} said ${sendOut.get(typed)}` : "?"}, new breadcrumb ${rel(crumbAt)}, ` +
					`command back ${rel(s1)}; hc states ${states.map(s => s.replace(/@([\d.]+)/, (_m, at) => `@${rel(Number(at))}`)).join(" ")}`,
			);
		}
	}
	return times;
}

export default {
	id: "orchestrator",
	title: "Orchestrator tools and extensions: spaces, send, watch, report, reload",
	async run(ctx) {
		const sb = ctx.sandbox;
		const out: Measure[] = [];
		await startCore(sb);
		const { instance } = await Instance.start(sb);
		const realSelf = process.env.HC_TERMINAL_ID;
		let world: World | undefined;
		try {
			world = await buildWorld(sb, instance, ctx.log);
			// The tools run as the orchestrator: its own terminal is the test orchestrator terminal.
			process.env.HC_TERMINAL_ID = world.orchTerminal;
			const pi = makePi();
			const tools = (await load(ctx, "tools/herdr.ts")).default(pi) as Tool[];
			const watchMod = await load(ctx, "extensions/herdr-watch.ts");
			watchMod.default(pi);
			await pi.fire("session_start", {}, fakeCtx());

			await spacesCase(ctx, pi, tools.find(x => x.name === "herdr_spaces")!, out);
			await workCase(ctx, world, pi, tools.find(x => x.name === "herdr_send")!, pi.tools.get("herdr_watch"), watchMod.FORGET_EVENT, out);
			await pi.fire("session_shutdown", {}, fakeCtx());
			try {
				await reloadCase(ctx, instance, world, out);
			} catch (err) {
				ctx.log(`orchestrator: reload not measured: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			if (realSelf === undefined) delete process.env.HC_TERMINAL_ID;
			else process.env.HC_TERMINAL_ID = realSelf;
			if (world) await closeWorld(sb, instance, world.spaceIds, ctx.log);
		}
		return out.filter(m => m.samples.length > 0);
	},
} satisfies Case;
