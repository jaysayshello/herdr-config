import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

interface LsTerminal {
	terminal: string;
	pane?: string;
	status?: string;
	app?: string;
}
interface LsTab {
	id: string;
	name: string;
	terminals: LsTerminal[];
}
export interface LsSpace {
	id: string;
	name: string;
	folder?: string;
	machine?: string | null;
	active?: boolean;
	tabs: LsTab[];
}
export interface HcGet {
	address?: string;
	title?: string;
	turn?: number;
	status?: { app?: string; state?: string } | null;
	foreground?: { cwd?: string; name?: string } | null;
	cwd?: string;
	state?: string;
	labels?: Record<string, string>;
}
interface HcSend {
	started?: boolean;
	status?: string;
	turn?: number;
}
interface Created {
	space: string;
	tab: string;
	terminal: string;
}
// What the window shows (herdr-app status).
interface Shown {
	space?: string;
	tab?: string;
	focused_pane?: string;
}

const self = process.env.HC_TERMINAL_ID;
// Goes before the text of an interrupting send: the stop can leave a repo half way through a step.
const STOPPED_NOTE =
	"Your last turn was stopped on purpose, so that you get the context below. Before you continue, examine the state that the stop left: a git stash that was not popped, a half-done commit, merge or rebase, a branch switch, a command or background job that still runs, or a half-written file. Put the repo back in a clean state first. Then continue the task with this context:";

function result<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

// The programs a worker terminal can run. /claude and /omp (extensions/herdr-switch.ts) write the
// mode file, and new workers start in that mode. The PR fix agents of herdr-pr-autofix.ts stay omp.
export const AGENT_APPS = ["omp", "claude"] as const;
export type AgentApp = (typeof AGENT_APPS)[number];
export const isAgentApp = (app: string | undefined): app is AgentApp => AGENT_APPS.includes(app as AgentApp);

// A missing or unknown mode file means omp.
export function readMode(): AgentApp {
	try {
		const word = fs.readFileSync(path.join(os.homedir(), ".local/state/herdr-switch/mode"), "utf8").trim();
		return word === "claude" ? "claude" : "omp";
	} catch {
		return "omp";
	}
}

// How a worker of app starts with its first prompt: argv for space.new and tab.new (they pass the
// task themselves), script for the sh -lc of pane.split (the task file is $1). Claude starts as the
// program itself (`command claude`), not as a shell alias of it.
export function workerArgv(app: AgentApp) {
	return { argv: [app], script: `t=$(cat "$1") && rm -f "$1" && exec ${app} "$t"` };
}

// herdr_send, herdr_new_agent and herdr_new_space take `watch` (the ~10-word summary) and start
// the watch of extensions/herdr-watch.ts at once, which saves the model a herdr_watch call.
// Custom tools get no pi.events, and omp loads each extension as a new module copy, so the
// extension of the main session puts its starter on globalThis (shareWatch) for these tools.
export type StartWatch = (terminal: string, afterTurn: number, prompt: string, signal?: AbortSignal) => Promise<object>;
const WATCH_KEY = Symbol.for("herdr-watch:start");
const watchHost = globalThis as unknown as Record<symbol, StartWatch | undefined>;

// Returns the call that takes the starter away again (only if it is still this one).
export function shareWatch(start: StartWatch): () => void {
	watchHost[WATCH_KEY] = start;
	return () => {
		if (watchHost[WATCH_KEY] === start) delete watchHost[WATCH_KEY];
	};
}

// The `watch` part of a send result: what herdr_watch returns, or why no watch started. A failed
// watch must not fail a send that worked.
async function startWatch(prompt: string | undefined, terminal: string, afterTurn: number, signal?: AbortSignal) {
	if (!prompt?.trim()) return {};
	const start = watchHost[WATCH_KEY];
	const none = (why: string) => ({
		watch: { watching: false, note: `No watch started: ${why}. Use the herdr-watcher fallback with after_turn ${afterTurn}.` },
	});
	if (!start) return none("the herdr-watch extension is not loaded");
	try {
		return { watch: await start(terminal, afterTurn, prompt, signal) };
	} catch (err) {
		return none(err instanceof Error ? err.message : String(err));
	}
}

const WATCH_DOC =
	"With watch (a summary of the request in about 10 words) it also starts herdr_watch on this terminal (after_turn: the turn of this send, or 0 for a new terminal), so do not call herdr_watch after it. The result then has watch: what herdr_watch returns (space_id for the More link), or watching false and a note when no watch started.";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal?.aborted) {
		reject(new Error("Cancelled"));
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(new Error("Cancelled"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

// The Herdr calls the tools below make. extensions/herdr-pr-autofix.ts uses them too, to start its
// fix agents in tabs (newTab, waitStarted) and to close those tabs (closeTab), and
// extensions/herdr-spaces.ts puts the herdr_spaces list (spaces) before each user request.
export function herdrClient(exec: CustomToolAPI["exec"]) {
	async function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
		const r = await exec(cmd, args, { signal });
		if (r.killed) throw new Error(`${cmd} was cancelled`);
		if (r.code !== 0) throw new Error(r.stderr || r.stdout || `${cmd} exited with code ${r.code}`);
		return r.stdout;
	}

	async function runJson<T>(cmd: string, args: string[], signal?: AbortSignal): Promise<T> {
		return JSON.parse(await run(cmd, args, signal)) as T;
	}

	const ls = (signal?: AbortSignal) => runJson<{ spaces: LsSpace[] }>("herdr-app", ["ls"], signal);
	const get = (terminal: string, signal?: AbortSignal) => runJson<HcGet>("hc", ["get", terminal, "--json"], signal);

	// herdr-app ls names a remote machine's ids `<machine>/<id>` (the Windows app with omp in WSL:
	// `wsl/t8`), but hc talks only to the core it runs on, which knows them as `t8`. Find the
	// orchestrator's own space by the space label hc sets (terminal ids repeat across machines),
	// keep that machine's spaces, and give everything to the model in hc's addresses.
	async function view(signal?: AbortSignal) {
		const [{ spaces }, me] = await Promise.all([ls(signal), self ? get(self, signal).catch(() => undefined) : undefined]);
		const prefix = (s: LsSpace) => (s.machine ? `${s.machine}/` : "");
		const sid = me?.labels?.["herdr.space"];
		const selfSpace = spaces.find(s =>
			sid ? s.id === prefix(s) + sid : s.tabs.some(t => t.terminals.some(term => term.terminal === prefix(s) + self)),
		);
		const machine = selfSpace?.machine ?? null;
		const local = spaces.filter(s => (s.machine ?? null) === machine);
		const hcId = (id: string) => (machine && id.startsWith(`${machine}/`) ? id.slice(machine.length + 1) : id);
		return { spaces: local, selfSpace, machine, hcId };
	}

	// What herdr_spaces returns: every space but the orchestrator's own, with each terminal's state.
	async function spaces(signal?: AbortSignal) {
		const { spaces, selfSpace, hcId } = await view(signal);
		const out = await Promise.all(
			spaces
				.filter(s => s !== selfSpace)
				.map(async s => ({
					id: s.id,
					name: s.name,
					tabs: await Promise.all(
						s.tabs.map(async t => ({
							id: t.id,
							name: t.name,
							terminals: await Promise.all(
								t.terminals.map(async ({ terminal: id, app }) => {
									const terminal = hcId(id);
									// One dead terminal must not hide every other space.
									const info = await get(terminal, signal).catch(() => undefined);
									return {
										terminal,
										app: info?.status?.app ?? app ?? null,
										state: info?.status?.state ?? null,
										turn: info?.turn ?? null,
										title: info?.title ?? null,
										cwd: info?.foreground?.cwd ?? info?.cwd ?? null,
									};
								}),
							),
						})),
					),
				})),
		);
		return { self: { terminal: self ?? null, space: selfSpace?.id ?? null }, spaces: out };
	}

	// Waits up to 45 s for the agent (app) on a new terminal to take its first prompt. It checks every
	// 100 ms: one check (hc get) takes about 15 ms, and a 500 ms step added about 0.35 s to each start.
	async function waitStarted(terminal: string, signal?: AbortSignal, app: AgentApp = "omp") {
		const deadline = Date.now() + 45_000;
		let screenAt = 0;
		for (;;) {
			const info = await get(terminal, signal).catch(() => ({}) as HcGet);
			const state = info.status?.state;
			if (info.status?.app === app && ((info.turn ?? 0) > 0 || (state && state !== "idle" && state !== "done"))) return;
			// Claude asks once per folder if it can trust it, and reports no state before the answer.
			if (app === "claude" && info.status?.app !== "claude" && Date.now() - screenAt >= 1000) {
				screenAt = Date.now();
				const screen = await run("hc", ["read", terminal, "--lines", "40"], signal).catch(() => "");
				if (/trust this folder/i.test(screen))
					throw new Error(`Claude on ${terminal} asks if it can trust this folder. Tell the user to answer it in that terminal; the task starts after the answer. Do not start it again.`);
			}
			if (Date.now() >= deadline)
				throw new Error(`${app} on ${terminal} did not start the task in 45 s (last state ${state ?? "unknown"}, turn ${info.turn ?? 0}). Do not start it again; read the terminal with herdr_read.`);
			await sleep(100, signal);
		}
	}

	// Splits the pane of terminal `beside` to the right and starts the agent of the current mode
	// there with task as its first prompt, then waits for it to take it.
	async function newAgent(beside: string, task: string, signal?: AbortSignal) {
		if (beside === self) throw new Error("Refusing to split the orchestrator's own pane");
		const { spaces, hcId } = await view(signal);
		let pane: string | undefined;
		let space: string | undefined;
		for (const s of spaces)
			for (const t of s.tabs)
				for (const term of t.terminals)
					if (hcId(term.terminal) === beside) {
						pane = term.pane;
						space = s.id;
					}
		if (!pane) throw new Error(`Terminal ${beside} has no pane in herdr-app ls`);
		// space.new starts its argv in a login shell, but pane.split runs it as is, with the PATH
		// herdr-core started with, which lacks ~/.local/bin (where omp and claude are) on a remote
		// machine.
		// The task goes through a file: a Mac security rule can kill `sh -lc` at once when a long
		// argument follows it, and Herdr's core then puts a plain login shell in the new pane.
		const file = path.join(os.tmpdir(), `herdr-task-${crypto.randomUUID()}`);
		fs.writeFileSync(file, task, { mode: 0o600 });
		const app = readMode();
		const argv = ["sh", "-lc", workerArgv(app).script, "sh", file];
		let split: { pane: string; terminal: string };
		try {
			split = await runJson(
				"herdr-app",
				["do", "pane.split", "--direction", "right", "--pane", pane, "--argv", JSON.stringify(argv)],
				signal,
			);
		} catch (err) {
			fs.rmSync(file, { force: true });
			throw err;
		}
		const terminal = hcId(split.terminal);
		await waitStarted(terminal, signal, app);
		return { space, pane: split.pane, terminal, turn: 0 };
	}

	// Starts omp in folder with task as its first prompt, in a new tab named tabName of the space
	// named spaceName, which it makes if it is missing. Herdr shows a new space or tab at once, so
	// this shows again the space, tab and pane that were shown before. It does not wait for omp.
	async function newTab(spaceName: string, tabName: string, folder: string, task: string, signal?: AbortSignal) {
		const [{ spaces, machine, hcId }, shown] = await Promise.all([view(signal), runJson<Shown>("herdr-app", ["status"], signal)]);
		const space = spaces.find(s => s.name === spaceName);
		const agent = ["--folder", folder, "--argv", '["omp"]', "--task", task];
		const created = await runJson<Created>(
			"herdr-app",
			space
				? ["do", "tab.new", "--space", space.id, "--name", tabName, ...agent]
				: ["do", "space.new", "--name", spaceName, "--tab", tabName, ...agent, ...(machine ? ["--machine", machine] : [])],
			signal,
		);
		// A failed step back (the user closed that space meanwhile) must not fail the start.
		if (shown.space) await run("herdr-app", ["do", "space.select", "--id", shown.space], signal).catch(() => {});
		if (shown.tab) await run("herdr-app", ["do", "tab.select", "--id", shown.tab], signal).catch(() => {});
		if (shown.focused_pane) await run("herdr-app", ["do", "pane.focus", "--pane", shown.focused_pane], signal).catch(() => {});
		return { space: created.space, tab: created.tab, terminal: hcId(created.terminal) };
	}

	// Closes tab `tab` of space `space` (herdr-app ls ids) and ends its terminals, but only if it
	// still holds terminal `terminal`. Returns false if that tab is gone.
	async function closeTab(space: string, tab: string, terminal: string, signal?: AbortSignal) {
		const { spaces, hcId } = await view(signal);
		const found = spaces
			.find(s => s.id === space)
			?.tabs.find(t => t.id === tab && t.terminals.some(term => hcId(term.terminal) === terminal));
		if (!found) return false;
		await run("herdr-app", ["do", "tab.close", "--id", tab, "--confirmed", "true"], signal);
		return true;
	}

	return { run, runJson, ls, get, view, spaces, waitStarted, newAgent, newTab, closeTab };
}

const factory: CustomToolFactory = (pi: CustomToolAPI) => {
	const { run, runJson, ls, get, view, spaces, newAgent } = herdrClient(pi.exec);

	// hc interrupt presses the stop key (Esc in omp). omp reports working until the abort is done,
	// and a dialog that appears instead must not get the text, so wait for idle or done.
	async function stop(terminal: string, signal?: AbortSignal): Promise<HcGet> {
		await run("hc", ["interrupt", "--json", terminal], signal);
		const deadline = Date.now() + 30_000;
		for (;;) {
			const info = await get(terminal, signal);
			const state = info.status?.state;
			if (state === "idle" || state === "done") return info;
			if (state === "blocked")
				throw new Error(`Terminal ${terminal} shows a dialog after the interrupt; nothing was sent. Tell the user to look at it.`);
			if (Date.now() >= deadline)
				throw new Error(`Terminal ${terminal} is still ${state ?? "unknown"} 30 s after the interrupt; nothing was sent. Read it with herdr_read.`);
			await sleep(500, signal);
		}
	}

	// hc send reports started:true with status idle even when omp has not taken the prompt yet,
	// so only a state change or a new turn proves delivery.
	async function deliver(terminal: string, text: string, before: HcGet, signal?: AbortSignal) {
		const turn = before.turn ?? 0;
		const out = (await run("hc", ["send", "--json", terminal, text], signal)).trim();
		const sent = JSON.parse(out) as HcSend;
		let last = before;
		const deadline = Date.now() + 15_000;
		while (sent.started !== false) {
			last = await get(terminal, signal);
			const now = last.status?.state;
			if ((last.turn ?? 0) > turn || (now && now !== "idle" && now !== "done")) return turn;
			if (Date.now() >= deadline) break;
			await sleep(500, signal);
		}
		throw new Error(
			`Prompt did not start on ${terminal}: hc send returned ${out}; last state ${last.status?.state ?? "unknown"}, turn ${last.turn ?? 0} (before ${turn}). Do not send again, because the text can still arrive and run twice. Start the task with herdr_new_agent beside ${terminal}.`,
		);
	}

	return [
		{
			name: "herdr_spaces",
			label: "Herdr Spaces",
			description:
				"List open Herdr spaces (except the orchestrator's own), their tabs, and each terminal's app, state (idle|working|done|blocked|error, null for plain shells), turn, title, and cwd. Each user request already comes with this list in a <herdr-spaces> message; call this only when that message is missing or you need a fresh view. Match on space name and terminal cwd, not on folder.",
			loadMode: "essential",
			parameters: pi.zod.object({}),
			async execute(_id, _params, _onUpdate, _ctx, signal) {
				return result(await spaces(signal));
			},
		},
		{
			name: "herdr_send",
			label: "Herdr Send",
			description:
				`Send a task as a prompt to an agent session (omp or Claude Code) in another Herdr terminal. Use this when herdr_spaces shows a matching space with an omp or claude terminal in state idle or done. Refuses other apps, busy terminals, and the orchestrator's own terminal. With interrupt: true it also takes a working terminal: only for a clear correction of the task that terminal runs now (new or related work goes to herdr_new_agent), it stops the turn (hc interrupt, as Esc does), waits until the terminal is idle or done, and sends the text after a note that tells the worker its turn was stopped and to clean up first. It never sends to a blocked terminal, with or without interrupt: a key press can answer its dialog. Waits up to 15 s for the prompt to start and throws a 'Prompt did not start' error if it does not; then use herdr_new_agent beside that terminal and do not send again. Returns the turn before the send (pass it to herdr_wait as after_turn) and interrupted: whether a turn was stopped. ${WATCH_DOC}`,
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				text: pi.zod.string(),
				interrupt: pi.zod.boolean().optional(),
				watch: pi.zod.string().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				if (params.terminal === self) throw new Error("Refusing to send to the orchestrator's own terminal");
				let info = await get(params.terminal, signal);
				const app = info.status?.app;
				const state = info.status?.state;
				if (!isAgentApp(app)) throw new Error(`Terminal ${params.terminal} runs ${app ?? "no agent"}, not omp or claude`);
				if (state === "blocked") {
					throw new Error(`Terminal ${params.terminal} is blocked on a dialog; never send or interrupt there, tell the user to look at it`);
				}
				const interrupted = params.interrupt === true && state === "working";
				if (interrupted) info = await stop(params.terminal, signal);
				else if (state !== "idle" && state !== "done") {
					throw new Error(`Terminal ${params.terminal} is ${state ?? "unknown"}; send only when idle or done, pass interrupt: true only to correct its current task, or use herdr_new_agent`);
				}
				const text = interrupted ? `${STOPPED_NOTE}\n\n${params.text}` : params.text;
				const turn = await deliver(params.terminal, text, info, signal);
				return result({ terminal: params.terminal, turn, interrupted, ...(await startWatch(params.watch, params.terminal, turn, signal)) });
			},
		},
		{
			name: "herdr_new_agent",
			label: "Herdr New Agent",
			description:
				`Start another agent session (omp or Claude Code: the current mode, which /claude and /omp set) beside an existing one, in the same Herdr space and the same tab, as Ctrl+E does (pane.split right). The pane of terminal \`beside\` splits, and the agent starts there in the same folder with task as its first prompt (a real user prompt, so the \`orchestrate\` keyword works). The existing session keeps running and stays visible. Use this for every new session in an open space: another agent, a busy space, or a failed send. Waits up to 45 s for the first turn to start. Returns the new terminal and turn 0 for herdr_wait. ${WATCH_DOC}`,
			loadMode: "essential",
			parameters: pi.zod.object({
				beside: pi.zod.string(),
				task: pi.zod.string(),
				watch: pi.zod.string().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				const started = await newAgent(params.beside, params.task, signal);
				return result({ ...started, ...(await startWatch(params.watch, started.terminal, 0, signal)) });
			},
		},
		{
			name: "herdr_new_space",
			label: "Herdr New Space",
			description:
				`Create a temporary Herdr space and start an agent session there (omp or Claude Code: the current mode) with task as its first prompt. Use this only when no open space matches the request. name must match ^[a-z0-9-]+$; the tool adds the prefix tmp-. folder defaults to /tmp/herdr-orchestrator/<name> and is created if missing. ${WATCH_DOC}`,
			loadMode: "essential",
			parameters: pi.zod.object({
				name: pi.zod.string(),
				folder: pi.zod.string().optional(),
				task: pi.zod.string(),
				watch: pi.zod.string().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				if (!/^[a-z0-9-]+$/.test(params.name)) throw new Error(`Space name must match ^[a-z0-9-]+$: ${params.name}`);
				const name = params.name.startsWith("tmp-") ? params.name : `tmp-${params.name}`;
				const folder = params.folder ?? `/tmp/herdr-orchestrator/${name}`;
				fs.mkdirSync(folder, { recursive: true });
				// The space goes on the orchestrator's machine, where the agent and this folder are.
				const { machine, hcId } = await view(signal);
				const argv = JSON.stringify(workerArgv(readMode()).argv);
				const created = await runJson<Created>(
					"herdr-app",
					["do", "space.new", "--name", name, "--folder", folder, "--argv", argv, "--task", params.task, ...(machine ? ["--machine", machine] : [])],
					signal,
				);
				const terminal = hcId(created.terminal);
				// The agent has not started yet; the watch waits up to 60 s for its first turn.
				return result({ space: created.space, tab: created.tab, terminal, ...(await startWatch(params.watch, terminal, 0, signal)) });
			},
		},
		{
			name: "herdr_wait",
			label: "Herdr Wait",
			description:
				"Block until the agent session (omp or Claude Code) in a terminal starts a turn after after_turn and then stops working, or until timeout_s (default 600) passes. Use this after herdr_send, herdr_new_agent, or herdr_new_space (after_turn 0 for new terminals). started false means no turn began within 60 s, so the prompt did not start. timed_out true means it is still working. Also returns the terminal's space name and space_id.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				after_turn: pi.zod.number(),
				timeout_s: pi.zod.number().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				const deadline = Date.now() + (params.timeout_s ?? 600) * 1000;
				const startDeadline = Math.min(deadline, Date.now() + 60_000);
				let info = await get(params.terminal, signal);
				const state = () => info.status?.state ?? null;
				const turn = () => info.turn ?? 0;

				// A fresh omp reports idle at its start turn before it takes the task.
				while (turn() <= params.after_turn && state() !== "working" && Date.now() < startDeadline) {
					await sleep(1000, signal);
					info = await get(params.terminal, signal);
				}

				let didBegin = turn() > params.after_turn || state() === "working";
				for (;;) {
					while (state() === "working" && Date.now() < deadline) {
						const started = Date.now();
						const remaining = Math.max(1, Math.ceil((deadline - started) / 1000));
						const r = await pi.exec("hc", ["wait", params.terminal, "--timeout", String(remaining), "--json"], { signal });
						if (r.killed || signal?.aborted) throw new Error("Cancelled");
						info = await get(params.terminal, signal);
						if (state() === "working" && Date.now() - started < 1000) await sleep(1000, signal);
					}
					if (state() === "working" || Date.now() >= deadline) break;
					// omp reports done for a moment between a turn end and a background-job wake.
					await sleep(5000, signal);
					info = await get(params.terminal, signal);
					if (state() !== "working") break;
					didBegin = true;
				}
				didBegin ||= turn() > params.after_turn;

				return result({
					terminal: params.terminal,
					space: info.labels?.where?.split(" / ")[0] ?? null,
					space_id: info.labels?.["herdr.space"] ?? null,
					state: state(),
					turn: turn(),
					started: didBegin,
					timed_out: state() === "working",
				});
			},
		},
		{
			name: "herdr_read",
			label: "Herdr Read",
			description:
				"Read the current screen of a Herdr terminal plus lines (default 80) of history. Use this to check what a worker did, or why it is blocked or in error.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				lines: pi.zod.number().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				const text = await run("hc", ["read", params.terminal, "--lines", String(params.lines ?? 80)], signal);
				return { content: [{ type: "text" as const, text }], details: { terminal: params.terminal } };
			},
		},
		{
			name: "herdr_close_space",
			label: "Herdr Close Space",
			description:
				"Close a temporary Herdr space by id when its work is finished. Refuses any space whose name does not start with tmp-.",
			loadMode: "essential",
			parameters: pi.zod.object({
				space: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				const { spaces } = await ls(signal);
				const space = spaces.find(s => s.id === params.space);
				if (!space) throw new Error(`No space with id ${params.space}`);
				if (!space.name.startsWith("tmp-")) throw new Error(`Refusing to close ${space.name}: only tmp- spaces can be closed`);
				await run("herdr-app", ["do", "space.close", "--id", params.space, "--confirmed", "true"], signal);
				return result({ space: params.space, name: space.name, closed: true });
			},
		},
	];
};

export default factory;
