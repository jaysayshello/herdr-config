// How long omp takes to start in a new Herdr pane, and where that time goes.
//
// Part 1, as the orchestrator feels it: herdr_new_agent (herdrClient.newAgent from the repo's
// orchestrator/.omp/tools/herdr.ts) splits a pane in the test window and starts a real omp there
// with a tiny first prompt, then waits until omp takes it. A second loop polls `hc get` every
// 50 ms meanwhile, to time each phase: herdr-app ls, the split, the pane's start until omp runs,
// omp's own boot until it reports the prompt taken, and the extra wait of newAgent's 500 ms poll.
// Then the same with the test window minimized. As soon as newAgent returns, the turn is stopped
// (hc interrupt) and the terminal and pane end, so each run costs at most one small model call.
//
// Part 2, omp alone: `hc run --bg omp` with no task in the test core, until omp reports idle; then
// the same with one part switched off (MCP wait, MCP servers, a hanging MCP server, memory,
// extensions, skills, ~/.claude, all of them) and four at once. The switched-off parts are sandbox
// homes made of links, or flags; the real ~/.omp is never changed.
//
// Profile: omp's own startup timer (PI_TIMING=x prints a tree and exits before the prompt), the
// main-thread blocks omp logs (ui.loop-blocked in the sandbox ~/.omp/logs), and macOS `sample`
// of one test omp's boot. They go to the log; the raw files stay in the sandbox with --keep.
// orch.ts first: it registers the stub module herdr.ts imports.
import { orchFile } from "../lib/orch.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Instance, startCore } from "../lib/instance.ts";
import { altHome, describe, endTerminal, hangingServer, hcRunBg, loopBlocked, mainThread, stopCoreAt, traceTerminal, type Seen, type Trace } from "../lib/omp-start-trace.ts";
import { now, run, sleep, waitFor } from "../lib/proc.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

const TASK = "Reply with only the word ok.";
// newAgent gives up after 45 s; a boot alone gets more, to see how long it really takes.
const BOOT_TIMEOUT_MS = 120_000;

// The rule of herdrClient.waitStarted: omp took the prompt.
const isTaken = (s: Seen) => s.app === "omp" && (s.turn > 0 || (!!s.state && s.state !== "idle" && s.state !== "done"));

// System load right now: how many omp processes run on this Mac (read only, one ps call) and the
// one-minute load average.
async function load() {
	const r = await run("/bin/ps", ["-A", "-o", "%cpu=,comm="]);
	let count = 0;
	let cpu = 0;
	for (const line of r.stdout.split("\n")) {
		const m = line.trim().match(/^([\d.]+)\s+(.*)$/);
		if (m && path.basename(m[2]) === "omp") {
			count++;
			cpu += Number(m[1]);
		}
	}
	return { count, cpu, load1: os.loadavg()[0] };
}

export default {
	id: "omp-start",
	title: "omp start in a new pane (herdr_new_agent) and omp's own boot",
	async run(ctx: Ctx): Promise<Measure[]> {
		const sb = ctx.sandbox;
		const n = Math.min(ctx.runs, 3);
		const nVariant = Math.min(ctx.runs, 2);
		const cwd = sb.work("omp-start");
		const out: Measure[] = [];
		const m = (name: string, label: string, kind: Measure["kind"], samples: number[], note?: string) => {
			if (samples.length) out.push({ id: `omp-start.${name}`, label, unit: "ms", kind, samples, note });
			else ctx.log(`omp-start: no samples for ${name}`);
		};

		const before = await load();
		ctx.log(`omp-start: ${before.count} omp processes running (${Math.round(before.cpu)} % CPU together), load ${before.load1.toFixed(1)} on ${os.cpus().length} cores`);

		// omp --version: the binary's start alone (no config, no extensions). And the shell
		// newAgent puts before omp: `sh -lc` (a login shell: /etc/profile, path_helper) against a
		// plain `sh -c`, both with the sandbox HOME (the person's ~/.profile is not read).
		const version: number[] = [];
		const login: number[] = [];
		const plain: number[] = [];
		for (let i = 0; i < n; i++) {
			const r = await run(sb.omp, ["--version"], { cwd });
			if (r.code === 0) version.push(r.ms);
			login.push((await run("/bin/sh", ["-lc", "true"], { cwd })).ms);
			plain.push((await run("/bin/sh", ["-c", "true"], { cwd })).ms);
		}
		m("shell.login", "sh -lc true (the login shell newAgent starts omp from)", "local", login);
		m("shell.plain", "sh -c true (the same without login)", "local", plain);

		await startCore(sb);
		const { instance } = await Instance.start(sb);

		// ---- Part 1: herdr_new_agent in the test window ----
		// The space to split beside runs a plain sleep, so nothing else starts in it.
		const space = await instance.app<{ space: string; terminal: string }>([
			"do", "space.new", "--name", "tmp-bench-omp", "--folder", cwd, "--argv", '["/bin/sleep","3600"]', "--focus", "false",
		]);
		const beside = space.terminal;
		// A runtime path (the repo under test), loaded after orch.ts registered its stub.
		const { herdrClient } = await import(orchFile(ctx.repo, "tools/herdr.ts"));

		// Runs newAgent `count` times and times its phases.
		const agentRuns = async (count: number, what: string) => {
			const total: number[] = [];
			const phases: Record<string, number[]> = { view: [], split: [], shell: [], boot: [], lag: [], ready: [] };
			const pollMs: number[] = [];
			for (let i = 0; i < count; i++) {
				// Every herdr-app and hc call newAgent makes, with its start and end time.
				const calls: { cmd: string; args: string[]; start: number; end: number }[] = [];
				let trace: Trace | undefined;
				let split: { pane: string; terminal: string } | undefined;
				const exec = async (cmd: string, args: string[], o: { signal?: AbortSignal } = {}) => {
					const start = now();
					const r = await run(cmd, args, { signal: o.signal });
					calls.push({ cmd, args, start, end: now() });
					// Start our own fast poll the moment the split gives the new terminal.
					if (args[0] === "do" && args[1] === "pane.split" && r.code === 0) {
						split = JSON.parse(r.stdout);
						trace = traceTerminal(sb, split!.terminal, 50);
					}
					return r;
				};
				const client = herdrClient(exec);
				const t0 = now();
				let ok = false;
				try {
					await client.newAgent(beside, TASK);
					ok = true;
				} catch (err) {
					ctx.log(`omp-start: newAgent (${what}) run ${i + 1} failed: ${err instanceof Error ? err.message : err}`);
				}
				const tEnd = now();
				// One more poll after the return, then stop the turn and end the pane.
				await sleep(60);
				const seen = (await trace?.stop()) ?? [];
				if (split) {
					await run(sb.hc, ["interrupt", split.terminal, "--json"], { timeoutMs: 15_000 }).catch(() => {});
					await endTerminal(sb, split.terminal);
					await instance.app(["do", "pane.close", "--pane", split.pane]).catch(() => {});
				}
				ctx.log(`omp-start: newAgent (${what}) run ${i + 1}: ${describe(seen, t0)}; returned at +${Math.round(tEnd - t0)}`);
				if (!ok || !split) continue;
				pollMs.push(...(trace?.pollMs ?? []));
				const ls = calls.find(c => c.args[0] === "ls");
				const sp = calls.find(c => c.args[1] === "pane.split")!;
				const fg = seen.find(s => s.fg === "omp");
				// omp's first report already counts as "taken": with a first prompt, omp reports
				// working from the moment its screen starts (before it sends the prompt to the model).
				const taken = seen.find(isTaken);
				total.push(tEnd - t0);
				if (ls) phases.view.push(ls.end - t0);
				phases.split.push(sp.end - sp.start);
				if (fg) phases.shell.push(fg.at - sp.end);
				if (fg && taken?.statusMs) phases.boot.push(taken.statusMs - fg.at);
				if (taken?.statusMs) {
					phases.ready.push(taken.statusMs - t0);
					phases.lag.push(tEnd - taken.statusMs);
				}
			}
			return { total, phases, pollMs };
		};

		const shown = await agentRuns(n, "window shown");
		// The same with the test window minimized, as when the person works in another app
		// (Herdr draws only a visible window).
		await instance.app(["do", "window.minimize"]).catch(err => ctx.log(`omp-start: window.minimize: ${err}`));
		const hidden = await agentRuns(nVariant, "window minimized");
		await instance.app(["do", "space.close", "--id", space.space, "--confirmed", "true"]).catch(() => {});

		const runsNote = `${n} runs (min of --runs and 3: each starts a real omp and one tiny model call, stopped at once)`;
		m("new-agent", "herdr_new_agent: split, omp start, prompt taken (as the orchestrator waits)", "total", shown.total, runsNote);
		m("new-agent.minimized", "the same with the test window minimized", "total", hidden.total, `${nVariant} runs`);
		m("phase.view", "herdr-app ls before the split (from the call)", "local", shown.phases.view);
		m("phase.split", "herdr-app do pane.split call", "local", shown.phases.split);
		m("phase.shell", "split returned until omp is the pane's foreground process (the core starts the pane, sh -lc, exec omp; ±50 ms)", "local", shown.phases.shell);
		m("phase.boot", "omp process until it reports the prompt taken to hc (app=omp working)", "local", shown.phases.boot);
		m("phase.ready", "newAgent call until omp reports the prompt taken (hc's own time)", "local", shown.phases.ready);
		m("phase.poll-lag", "prompt taken until newAgent returns (waitStarted polls every 500 ms)", "local", shown.phases.lag);
		m("hc-get", "one hc get call (the poll waitStarted repeats)", "local", shown.pollMs, `all polls of ${n} runs`);

		// ---- Part 2: omp alone in the test core ----
		// Boots argv in a new test terminal until omp reports idle. Returns ms from hc run, and how
		// long omp's main thread was blocked meanwhile, from omp's own log in `home`
		// (~/.omp/logs/omp.<date>.<pid>.log, "ui.loop-blocked" lines).
		const boot = async (argv: string[], home = sb.home) => {
			const { terminal, t0 } = await hcRunBg(sb, cwd, argv);
			const trace = traceTerminal(sb, terminal, 50);
			let screen = "";
			try {
				await waitFor(() => trace.seen.some(s => (s.app === "omp" && s.state === "idle") || s.live === "finished"), "omp idle", BOOT_TIMEOUT_MS, 50);
			} finally {
				await trace.stop();
				screen = (await run(sb.hc, ["read", terminal, "--lines", "15"], { timeoutMs: 10_000 })).stdout;
				await endTerminal(sb, terminal);
			}
			const idle = trace.seen.find(s => s.app === "omp" && s.state === "idle");
			const blockedMs = loopBlocked(home, trace.seen.find(s => s.fg === "omp")?.pid);
			ctx.log(`omp-start: boot ${argv.join(" ")}: ${describe(trace.seen, t0)}; main thread blocked ${blockedMs} ms`);
			// No idle: show what the terminal printed.
			if (!idle?.statusMs) ctx.log(`omp-start: its screen:\n${screen.replace(/\n{2,}/g, "\n").slice(-1500)}`);
			if (!idle?.statusMs) throw new Error("omp ended before it reported idle");
			return { ms: idle.statusMs - t0, blockedMs };
		};
		const noMcp = altHome(sb, "no-mcp", ["mcp.json"]);
		const noClaude = altHome(sb, "no-claude", [".claude"]);
		// An MCP server that never answers, in place of the person's servers.
		const hang = hangingServer();
		const mcpHang = altHome(sb, "mcp-hang", ["mcp.json"]);
		fs.writeFileSync(path.join(mcpHang, ".omp/agent/mcp.json"), JSON.stringify({ mcpServers: { hang: { type: "http", url: hang.url } } }));
		const overlay = path.join(sb.root, "omp-memory-off.yml");
		fs.writeFileSync(overlay, "memory:\n  backend: off\n");
		const wait250 = "OMP_MCP_STARTUP_TIMEOUT_MS=250";
		const variants: { name: string; label: string; home?: string; env?: string[]; flags?: string[]; runs: number }[] = [
			{ name: "boot", label: "omp alone (hc run --bg omp, no task) until it reports idle", runs: n },
			{ name: "boot.mcp-wait-250", label: "same, MCP start wait 250 ms (omp's default) instead of the config's 0 (wait for every server)", env: [wait250], runs: nVariant },
			{ name: "boot.no-mcp", label: "same, without mcp.json (no MCP servers)", home: noMcp, runs: nVariant },
			{ name: "boot.no-memory", label: "same, memory backend off", flags: ["--config", overlay], runs: nVariant },
			{ name: "boot.no-extensions", label: "same, --no-extensions", flags: ["--no-extensions"], runs: nVariant },
			{ name: "boot.no-skills", label: "same, --no-skills --no-rules", flags: ["--no-skills", "--no-rules"], runs: nVariant },
			{ name: "boot.no-claude-home", label: "same, without ~/.claude (Claude plugins, skills, settings)", home: noClaude, runs: nVariant },
			{
				name: "boot.bare",
				label: "same, all of them off (no MCP, memory, extensions, skills, rules, LSP, context files)",
				home: noMcp,
				flags: ["--config", overlay, "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-context-files"],
				runs: nVariant,
			},
			// A hanging MCP server, with the config's wait (0: until every server settles) and with
			// omp's default 250 ms window.
			{ name: "boot.mcp-hang", label: "same, one MCP server that never answers, config's wait 0", home: mcpHang, runs: nVariant },
			{ name: "boot.mcp-hang-wait-250", label: "same, one MCP server that never answers, wait 250 ms", home: mcpHang, env: [wait250], runs: nVariant },
		];
		// The first omp in a new home is slower (omp builds its caches there); each other home
		// gets one unmeasured boot first, so the variants compare warm starts, as in daily use.
		const cold: number[] = [];
		const warmed = new Set<string>();
		const blocked: Record<string, number[]> = {};
		try {
			for (const v of variants) {
				const argv = [...(v.home || v.env ? ["env", ...(v.home ? [`HOME=${v.home}`] : []), ...(v.env ?? [])] : []), "omp", ...(v.flags ?? [])];
				if (v.home && !warmed.has(v.home)) {
					warmed.add(v.home);
					cold.push(await boot(argv, v.home).then(r => r.ms, () => Number.NaN));
				}
				const samples: number[] = [];
				blocked[v.name] = [];
				for (let i = 0; i < v.runs; i++) {
					try {
						const r = await boot(argv, v.home);
						samples.push(r.ms);
						blocked[v.name].push(r.blockedMs);
					} catch (err) {
						ctx.log(`omp-start: ${v.name} failed: ${err instanceof Error ? err.message : err}`);
					}
				}
				m(v.name, v.label, "local", samples, v.runs < ctx.runs ? `${v.runs} run${v.runs > 1 ? "s" : ""}` : undefined);
			}
			ctx.log(`omp-start: the hanging MCP server got ${hang.connections()} connections`);
		} finally {
			hang.stop();
			for (const h of [noMcp, noClaude, mcpHang]) await stopCoreAt(sb, h);
		}
		m("boot.cold-home", "omp alone, first start in a new home (caches empty)", "local", cold.filter(Number.isFinite), "one per extra sandbox home");
		m("boot.main-thread-blocked", "omp alone: time its main thread was blocked during the boot (omp's own ui.loop-blocked log)", "local", blocked.boot ?? []);
		m("boot.no-memory.main-thread-blocked", "same, memory backend off", "local", blocked["boot.no-memory"] ?? []);

		// Four omp at once, as when the orchestrator starts several agents together on a busy Mac.
		// An omp that starts while another omp runs in the same folder can attach to it (see
		// ~/.omp/run/daemons) and report idle in about 0.2 s; the others boot in full.
		const parallel = await Promise.allSettled([0, 1, 2, 3].map(() => boot(["omp"])));
		m("boot.parallel-4", "omp alone, four started at the same time (each one's time)", "local", parallel.flatMap(p => (p.status === "fulfilled" ? [p.value.ms] : [])), "one round of 4; some can attach to another one and start in about 0.2 s");

		// omp's own startup timings: PI_TIMING=x prints them to stderr and exits before the prompt.
		// Once as configured and once with memory off. The whole trees stay in
		// <sandbox>/omp-timing-*.txt (with --keep); the log gets the steps of 100 ms or more.
		const timing = async (name: string, args: string[]) => {
			const file = path.join(sb.root, `omp-timing-${name}.txt`);
			const timed = await hcRunBg(sb, cwd, ["sh", "-c", 'PI_TIMING=x exec omp "$@" 2>"$0"', file, ...args]);
			try {
				await waitFor(async () => (await run(sb.hc, ["get", timed.terminal, "--json"])).stdout.includes('"state":"finished"'), "PI_TIMING run", BOOT_TIMEOUT_MS, 100);
			} catch (err) {
				ctx.log(`omp-start: PI_TIMING run: ${err instanceof Error ? err.message : err}`);
			}
			await endTerminal(sb, timed.terminal);
			const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
			const slow = text.split("\n").filter(l => Number(l.match(/: ([\d.]+)ms/)?.[1] ?? 0) >= 100);
			ctx.log(`omp-start: PI_TIMING (${name}) steps of 100 ms or more:\n${slow.join("\n")}`);
			return Number(text.match(/Total: ([\d.]+)ms/)?.[1]);
		};
		const internal = await timing("as-configured", []);
		const internalNoMemory = await timing("no-memory", ["--config", overlay]);
		if (Number.isFinite(internal)) m("boot.internal", "omp's own startup timer (PI_TIMING total, until just before its prompt screen)", "local", [internal], "one run");
		if (Number.isFinite(internalNoMemory)) m("boot.internal.no-memory", "same, memory backend off", "local", [internalNoMemory], "one run");

		// Where omp's main thread waits while it boots: macOS `sample` on a TEST omp (sandbox
		// HOME, in the test core) for 2 s from its start. The whole report stays in
		// <sandbox>/omp-sample.txt (with --keep); the log gets the main thread's heaviest frames.
		const sampled = await hcRunBg(sb, cwd, ["omp"]);
		try {
			const pid = await waitFor(async () => {
				const t = JSON.parse((await run(sb.hc, ["get", sampled.terminal, "--json"])).stdout);
				return t.foreground?.name === "omp" ? (t.foreground.pid as number) : 0;
			}, "omp pid", 10_000, 10);
			const file = path.join(sb.root, "omp-sample.txt");
			await run("/usr/bin/sample", [String(pid), "2", "1", "-mayDie", "-file", file], { timeoutMs: 30_000 });
			if (fs.existsSync(file)) ctx.log(`omp-start: sample of omp's boot, main thread:\n${mainThread(fs.readFileSync(file, "utf8"))}`);
		} catch (err) {
			ctx.log(`omp-start: sample: ${err instanceof Error ? err.message : err}`);
		} finally {
			await endTerminal(sb, sampled.terminal);
		}

		m("version", "omp --version (the binary's start alone)", "local", version);
		const after = await load();
		out.push(
			{ id: "omp-start.omp-processes", label: "omp processes running on this Mac (context)", unit: "count", kind: "local", better: "none", samples: [before.count, after.count], note: "before and after the case" },
			{ id: "omp-start.load1", label: "one-minute load average (context)", unit: "count", kind: "local", better: "none", samples: [before.load1, after.load1], note: `before and after the case, ${os.cpus().length} cores` },
		);
		return out;
	},
} satisfies Case;
