// orchestrator-e2e: the two waits the person feels, with a REAL test orchestrator (omp and its model)
// running the checkout's orchestrator/.omp, in the test window and test core:
//   A  send-path   a prompt typed into the orchestrator -> the task reaches the right worker
//   B  reply-path  the worker stops -> the orchestrator has written its report box (turn done)
// The world is shaped like the person's (lib/orchestrator-e2e-world.ts): 10 spaces, fake omp
// workers in project-named folders, shell panes, one working and one blocked agent. The prompt
// always names the payments project, whose fake worker works 3 s and answers "pong".
// The orchestrator's session file (sandbox) splits each wait into model time and tool time.
// Also, tool-only: herdr_spaces on this world (time, bytes) and herdr_new_space until omp takes its
// prompt (a real omp, stopped at once).
// orch.ts first: it registers the stub module the orchestrator files import.
import { fakeCtx, fakePi, orchFile, type FakePi } from "../lib/orch.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertNotReal, BENCH_ROOT } from "../lib/guard.ts";
import { hc, Instance, startCore } from "../lib/instance.ts";
import { traceTerminal, type Seen } from "../lib/omp-start-trace.ts";
import { buildWorld, closeAll, crumbDir, envOf, ORCH_SPACE, orchestratorCopy, stateAt, TARGET_WORK_MS, type World } from "../lib/orchestrator-e2e-world.ts";
import { readSession, type Session, spacesFieldBytes } from "../lib/orchestrator-e2e-session.ts";
import { now, run, sleep, waitFor } from "../lib/proc.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

const PROMPTS = [
	"Ask the payments project to reply with the word pong.",
	"Please have the payments project answer with just the word pong.",
	"Tell the payments space to reply pong.",
];
const NEW_TASK = "Reply with only the word ok.";
const RUN_TIMEOUT_MS = 180_000;

interface Tool {
	name: string;
	execute(...args: unknown[]): Promise<{ content: { text: string }[]; details: unknown }>;
}
interface HcGet {
	created_ms?: number;
	turn?: number;
	foreground?: { pid?: number } | null;
	status?: { app?: string; state?: string } | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (x: number) => Math.round(x);
// When hc saw the status change (status_ms), else when the poll saw it.
const seenAt = (s: Seen) => s.statusMs ?? s.at;
const stopped = (s: Seen) => s.state === "done" || s.state === "idle";

function measure(id: string, label: string, samples: number[], kind: Measure["kind"], note?: string, extra: Partial<Measure> = {}): Measure {
	return { id: `orchestrator-e2e.${id}`, label, unit: "ms", kind, better: "lower", samples, note, ...extra };
}

// A fake pi for the tool-only measures: real commands (sandbox env), recorded.
function makePi(): FakePi {
	const pi: FakePi = fakePi({
		exec: async (cmd, args, o = {}) => {
			if (process.env.HC_SESSION !== "herdrbench" || !process.env.HERDR_APP_HOME?.startsWith(BENCH_ROOT))
				throw new Error("orchestrator-e2e: hc or herdr-app would reach the real core or window");
			const r = await run(cmd, args, { signal: o.signal, cwd: o.cwd, timeoutMs: o.timeout });
			pi.execs.push({ at: now() - r.ms, ms: r.ms, cmd, args });
			return r;
		},
	});
	return pi;
}

// The end of the first model call that started after `after` and wrote only text (no tool call):
// the report box. omp writes an assistant entry when the call is complete, and draws the box then.
function boxEnd(s: Session, after: number): number | undefined {
	return s.models.find(m => m.start >= after && m.tools.length === 0)?.end;
}

// The tool-only measures, run by this process with the same world and the same "self" as the
// test orchestrator, so herdr_spaces gives the same output.
async function toolOnly(ctx: Ctx, instance: Instance, world: World, orch: string, out: Measure[]) {
	const saved = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_ID = orch;
	try {
		const pi = makePi();
		// herdr.ts reads HC_TERMINAL_ID once at import: a fresh copy with this one.
		const mod = await import(`${orchFile(ctx.repo, "tools/herdr.ts")}?orchestrator-e2e`);
		const tools = mod.default(pi) as Tool[];
		const client = mod.herdrClient(pi.exec) as { waitStarted(t: string): Promise<void> };
		const spaces = tools.find(t => t.name === "herdr_spaces")!;
		const ms: number[] = [];
		const bytes: number[] = [];
		for (let r = 0; r < ctx.runs; r++) {
			const t0 = now();
			const res = await spaces.execute("bench", {}, undefined, fakeCtx(), undefined);
			ms.push(now() - t0);
			bytes.push(Buffer.byteLength(res.content[0].text));
		}
		out.push(
			measure("spaces-ms-tool", "herdr_spaces alone (this process, same world)", ms, "local"),
			measure("spaces-bytes-tool", "bytes of one herdr_spaces result (this process, same world)", bytes, "local", undefined, { unit: "count" }),
		);

		// herdr_new_space until omp takes its prompt; a real omp, stopped as soon as it took it.
		const newSpace = tools.find(t => t.name === "herdr_new_space")!;
		const call: number[] = [];
		const taken: number[] = [];
		const n = Math.min(ctx.runs, 2);
		for (let r = 0; r < n; r++) {
			const folder = ctx.sandbox.work(`e2e-new-space-${r}`);
			const t0 = now();
			const res = await newSpace.execute("bench", { name: `bench-new-${r}`, folder, task: NEW_TASK }, undefined, fakeCtx(), undefined);
			const t1 = now();
			const d = res.details as { space: string; terminal: string };
			world.spaceIds.push(d.space);
			try {
				await client.waitStarted(d.terminal);
				taken.push(now() - t0);
				call.push(t1 - t0);
			} catch (err) {
				ctx.log(`orchestrator-e2e: new space ${r}: ${err instanceof Error ? err.message : err}`);
			}
			await run("hc", ["interrupt", "--json", d.terminal]).catch(() => {});
			const closed = await instance.app(["do", "space.close", "--id", d.space, "--confirmed", "true"]).then(() => true, () => false);
			if (closed) world.spaceIds = world.spaceIds.filter(id => id !== d.space);
		}
		out.push(
			measure("new-space-call", "herdr_new_space until it returns", call, "local", `${n} runs`),
			measure("new-space", "herdr_new_space until the new omp takes its prompt", taken, "local", `${n} runs; a real omp with one tiny prompt, stopped at once`),
		);
	} finally {
		if (saved === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = saved;
	}
}

// Starts the test orchestrator: a real omp in the sandbox copy of the orchestrator project.
async function startOrchestrator(ctx: Ctx, instance: Instance, world: World) {
	const sb = ctx.sandbox;
	const folder = orchestratorCopy(sb, ctx.repo);
	// Memory off: the person's memory server must not get the test prompts.
	const overlay = path.join(sb.root, "e2e-memory-off.yml");
	fs.writeFileSync(overlay, "memory:\n  backend: off\n");
	const t0 = now();
	const c = await instance.app<{ space: string; terminal: string }>(["do", "space.new", "--name", ORCH_SPACE, "--folder", folder, "--tab", "main", "--argv", JSON.stringify(["omp", "--config", overlay]), "--focus", "false"]);
	world.spaceIds.push(c.space);
	const info = await waitFor(
		async () => {
			const i = await hc<HcGet>(sb, ["get", c.terminal]).catch(() => undefined);
			return i?.status?.app === "omp" && i.status.state === "idle" ? i : undefined;
		},
		"the test orchestrator to report idle",
		90_000,
		100,
	);
	ctx.log(`orchestrator-e2e: test orchestrator idle in ${round(now() - t0)} ms on ${c.terminal}`);
	// Safety: its tools must reach the test window and core, and write sandbox files.
	const env = await envOf(info.foreground?.pid ?? 0);
	if (!env.includes(`HERDR_APP_HOME=${sb.appHome}`) || !env.includes(`HOME=${sb.home}`))
		throw new Error("the test orchestrator does not run with the sandbox HERDR_APP_HOME and HOME");
	return { terminal: c.terminal, created: info.created_ms };
}

// The orchestrator's session file, from the breadcrumb herdr-resume writes in the sandbox.
async function sessionFile(terminal: string, created: number | undefined): Promise<string> {
	const crumb = path.join(crumbDir(), terminal);
	const file = await waitFor(
		async () => {
			try {
				const [c, f] = fs.readFileSync(crumb, "utf8").split("\n");
				return c === String(created) && f && fs.existsSync(f) ? f : undefined;
			} catch {
				return undefined;
			}
		},
		"the test orchestrator's session file",
		30_000,
		100,
	);
	assertNotReal(file);
	if (!fs.realpathSync(file).startsWith(fs.realpathSync(BENCH_ROOT))) throw new Error(`session file ${file} is not in the sandbox`);
	return file;
}

interface RunResult {
	t0: number;
	task: number;
	box1: number;
	wdone: number;
	report: number;
	box2: number;
	end: number;
	hcSendMs: number;
	// hc saw the orchestrator report working (its turn began).
	busy: number;
}

// One request: type the prompt, wait for the task at the worker, the worker's stop, the report and
// the orchestrator's turn after it, then until the orchestrator is quiet again.
async function oneRun(ctx: Ctx, world: World, orch: string, seen: Seen[], file: () => Promise<string>, prompt: string): Promise<RunResult> {
	const t0 = now();
	// HC_TERMINAL_ID is unset in the suite, so hc types the text as the person would.
	const sent = await run("hc", ["send", "--json", orch, prompt]);
	if (sent.code !== 0) throw new Error(`hc send to the orchestrator: ${sent.stderr || sent.stdout}`);
	const task = await waitFor(() => stateAt(world, world.target, "working", t0), "the task at the payments worker", RUN_TIMEOUT_MS, 20);
	const wdone = await waitFor(() => stateAt(world, world.target, "done", task), "the payments worker to stop", TARGET_WORK_MS + 30_000, 20);
	const f = await file();
	const report = await waitFor(() => readSession(f).reports.find(r => r.at > wdone)?.at, "the herdr-report in the orchestrator's session", 30_000, 50);
	const box1 = (await waitFor(() => boxEnd(readSession(f), t0), "the orchestrator's WORKING box", RUN_TIMEOUT_MS, 50)) ?? 0;
	// The report can arrive while the first turn still runs: its turn starts after that one.
	const box2 = (await waitFor(() => boxEnd(readSession(f), Math.max(report, box1)), "the orchestrator's report box", RUN_TIMEOUT_MS, 50)) ?? 0;
	// Quiet: idle or done for 3 s with no new turn (an hc note can start one more).
	let end = now();
	await waitFor(
		() => {
			const last = seen.at(-1);
			if (!last || !stopped(last)) return false;
			end = seenAt(last);
			return now() - end > 3000;
		},
		"the orchestrator to be quiet",
		RUN_TIMEOUT_MS,
		100,
	);
	const busy = seen.find(x => seenAt(x) >= t0 && x.state === "working");
	return { t0, task, box1, wdone, report, box2, end, hcSendMs: sent.ms, busy: busy ? seenAt(busy) : 0 };
}

export default {
	id: "orchestrator-e2e",
	title: "Orchestrator end to end: a real test orchestrator routes a prompt and reports back",
	async run(ctx) {
		const sb = ctx.sandbox;
		const out: Measure[] = [];
		await startCore(sb);
		const { instance } = await Instance.start(sb);
		let world: World | undefined;
		try {
			world = await buildWorld(sb, instance, ctx.log);
			const orch = await startOrchestrator(ctx, instance, world);
			await toolOnly(ctx, instance, world, orch.terminal, out);

			const n = Math.min(ctx.runs, 3);
			const seen = traceTerminal(sb, orch.terminal, 50);
			let file: string | undefined;
			const getFile = async () => (file ??= await sessionFile(orch.terminal, orch.created));
			const samples: Record<string, number[]> = {};
			const add = (k: string, v: number) => (samples[k] ??= []).push(v);
			const sequences: string[] = [];
			try {
				for (let r = 0; r < n; r++) {
					const w = world;
					await waitFor(async () => {
						const s = (await hc<HcGet>(sb, ["get", w.target]).catch(() => undefined))?.status?.state;
						return s === "idle" || s === "done";
					}, "the payments worker to be free", 30_000, 100);
					let res: RunResult;
					try {
						res = await oneRun(ctx, w, orch.terminal, seen.seen, getFile, PROMPTS[r % PROMPTS.length]);
					} catch (err) {
						ctx.log(`orchestrator-e2e: run ${r} failed: ${err instanceof Error ? err.message : err}`);
						continue;
					}
					const s: Session = readSession(await getFile());
					const inRun = (at: number) => at >= res.t0 && at <= res.end + 1;
					const user = s.users.find(u => inRun(u.at) && u.text.includes("pong"));
					// The first turn: from the prompt until the WORKING box; the report turn: after both
					// the report and that box, until the report box.
					const replyFrom = Math.max(res.report, res.box1);
					const sendModels = s.models.filter(m => inRun(m.start) && m.end <= res.box1);
					const replyModels = s.models.filter(m => m.start >= replyFrom && m.end <= res.box2);
					const sendTools = s.tools.filter(t => inRun(t.start) && t.end <= res.box1);
					const notes = s.users.filter(u => inRun(u.at) && u.at > res.wdone && u.text.includes("<hc"));
					const send = sendTools.find(t => t.name === "herdr_send");
					const spaces = sendTools.filter(t => t.name === "herdr_spaces");

					add("send-path", res.task - res.t0);
					add("hc-send-ms", res.hcSendMs);
					if (res.busy) add("omp-busy", res.busy - res.t0);
					if (r === 0) ctx.log(`orchestrator-e2e: model ${sendModels[0]?.model ?? "?"}`);
					add("reply-path", res.box2 - res.wdone);
					add("report-arrive", res.report - res.wdone);
					add("reply-model-ms", sum(replyModels.map(m => m.end - m.start)));
					add("model-calls-reply", replyModels.length);
					if (replyModels[0]) add("report-queued", replyModels[0].start - res.report);
					if (res.box1) add("box1", res.box1 - res.t0);
					add("tool-calls", sendTools.length);
					add("model-calls-send", sendModels.length);
					add("model-ms-send", sum(sendModels.map(m => m.end - m.start)));
					add("tool-ms-send", sum(sendTools.map(t => t.end - t.start)));
					if (user) add("typing", user.at - res.t0);
					if (user && res.box1) add("other-ms-send", res.box1 - user.at - sum(sendModels.map(m => m.end - m.start)) - sum(sendTools.map(t => t.end - t.start)));
					if (send) {
						add("model-ms-to-task", sum(sendModels.filter(m => m.end <= send.start).map(m => m.end - m.start)));
						add("tool-ms-to-task", sum(sendTools.filter(t => t.end <= send.start).map(t => t.end - t.start)));
						add("send-to-task", res.task - send.start);
						add("send-tool-ms", send.end - send.start);
					}
					for (const m of [...sendModels, ...replyModels]) add("ttft", m.ttft);
					for (const t of spaces) {
						add("spaces-ms", t.end - t.start);
						add("spaces-bytes", Buffer.byteLength(t.text));
					}
					const all = [...sendModels, ...replyModels];
					add("tokens-input", sum(all.map(m => m.input)));
					add("tokens-output", sum(all.map(m => m.output)));
					add("tokens-cache-read", sum(all.map(m => m.cacheRead)));
					add("tokens-cache-write", sum(all.map(m => m.cacheWrite)));
					add("hc-notes", notes.length);

					const rel = (x: number) => `+${round(x - res.t0)}`;
					sequences.push(sendTools.map(t => t.name).join(" > "));
					ctx.log(
						`orchestrator-e2e: run ${r}: typed ${user ? rel(user.at) : "?"}; ` +
							[...sendModels.map(m => ({ at: m.start, s: `model ${rel(m.start)}..${rel(m.end)} (ttft ${round(m.ttft)}, out ${m.output} tok) -> ${m.tools.join(",") || "text"}` })), ...sendTools.map(t => ({ at: t.start, s: `${t.name} ${rel(t.start)}..${rel(t.end)}` }))]
								.sort((a, b) => a.at - b.at)
								.map(x => x.s)
								.join("; ") +
							`; task at worker ${rel(res.task)}; box1 ${res.box1 ? rel(res.box1) : "?"}; worker done ${rel(res.wdone)}; report ${rel(res.report)}; ` +
							replyModels.map(m => `model ${rel(m.start)}..${rel(m.end)} (ttft ${round(m.ttft)}, out ${m.output} tok)`).join("; ") +
							`; box2 ${rel(res.box2)}; hc notes after the stop ${notes.length}`,
					);
					if (r === 0 && spaces[0]) {
						const fields = Object.entries(spacesFieldBytes(spaces[0].text)).sort((a, b) => b[1] - a[1]);
						ctx.log(`orchestrator-e2e: herdr_spaces result ${Buffer.byteLength(spaces[0].text)} bytes; by field: ${fields.map(([k, v]) => `${k} ${v}`).join(", ")}`);
					}
				}
			} finally {
				await seen.stop();
			}
			ctx.log(`orchestrator-e2e: tool calls per request: ${sequences.join(" | ")}`);

			const runs = `${n} runs (min of --runs and 3)`;
			const calls = samples["model-calls-send"]?.map((c, i) => c + (samples["model-calls-reply"]?.[i] ?? 0)) ?? [];
			const cost = `${runs}; about ${sum(calls)} model calls in all (${calls.join(", ")} per run)`;
			const s = (k: string) => samples[k] ?? [];
			out.push(
				measure("send-path", "A: prompt typed -> the task reaches the payments worker", s("send-path"), "total", cost),
				measure("reply-path", "B: worker stops -> the orchestrator's report turn is done (box shown)", s("reply-path"), "total", `${runs}; includes the watch's SETTLE_MS 1000`),
				measure("report-arrive", "worker stops -> <herdr-report> in the orchestrator's session", s("report-arrive"), "local"),
				measure("report-queued", "<herdr-report> arrived -> the report turn's model call starts (waits for a running turn)", s("report-queued"), "local"),
				measure("model-ms-reply", "model time of the report turn", s("reply-model-ms"), "network"),
				measure("model-calls-reply", "model calls in the report turn", s("model-calls-reply"), "network", undefined, { unit: "count" }),
				measure("box1", "prompt typed -> the orchestrator's first turn is done (WORKING box shown)", s("box1"), "total"),
				measure("typing", "prompt typed -> omp has the user message", s("typing"), "local"),
				measure("hc-send-ms", "the hc send that types the prompt, until it returns", s("hc-send-ms"), "local", undefined, { better: "none" }),
				measure("omp-busy", "prompt typed -> hc sees the orchestrator working", s("omp-busy"), "local", undefined, { better: "none" }),
				measure("tool-calls", "tool calls in the first turn", s("tool-calls"), "local", undefined, { unit: "count" }),
				measure("model-calls-send", "model calls in the first turn", s("model-calls-send"), "network", undefined, { unit: "count" }),
				measure("model-ms-send", "model time in the first turn", s("model-ms-send"), "network"),
				measure("tool-ms-send", "tool time in the first turn", s("tool-ms-send"), "local"),
				measure("other-ms-send", "rest of the first turn (omp between model and tools)", s("other-ms-send"), "local"),
				measure("model-ms-to-task", "model time before herdr_send starts", s("model-ms-to-task"), "network"),
				measure("tool-ms-to-task", "tool time before herdr_send starts", s("tool-ms-to-task"), "local"),
				measure("send-to-task", "herdr_send starts -> the worker has the task", s("send-to-task"), "local"),
				measure("send-tool-ms", "herdr_send tool call", s("send-tool-ms"), "local"),
				measure("ttft", "time to first token of each model call", s("ttft"), "network", undefined, { better: "none" }),
				measure("spaces-ms", "herdr_spaces call inside the test orchestrator", s("spaces-ms"), "local"),
				measure("spaces-bytes", "bytes of each herdr_spaces result the model read (about 4 bytes a token)", s("spaces-bytes"), "local", undefined, { unit: "count" }),
				measure("tokens-input", "uncached input tokens per request", s("tokens-input"), "network", undefined, { unit: "count" }),
				measure("tokens-output", "output tokens per request", s("tokens-output"), "network", undefined, { unit: "count" }),
				measure("tokens-cache-read", "cached input tokens read per request", s("tokens-cache-read"), "network", undefined, { unit: "count", better: "none" }),
				measure("tokens-cache-write", "input tokens written to the cache per request", s("tokens-cache-write"), "network", undefined, { unit: "count" }),
				measure("hc-notes", "hc notes typed into the orchestrator after the worker stopped", s("hc-notes"), "local", undefined, { unit: "count", better: "none" }),
			);
		} finally {
			if (world) await closeAll(instance, world.spaceIds, ctx.log);
		}
		return out.filter(m => m.samples.length > 0);
	},
} satisfies Case;
