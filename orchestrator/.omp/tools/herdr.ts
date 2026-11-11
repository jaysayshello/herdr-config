import * as fs from "node:fs";
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
interface LsSpace {
	id: string;
	name: string;
	folder?: string;
	machine?: string | null;
	active?: boolean;
	tabs: LsTab[];
}
interface HcGet {
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

const self = process.env.HC_TERMINAL_ID;
// Goes before the text of an interrupting send: the stop can leave a repo half way through a step.
const STOPPED_NOTE =
	"Your last turn was stopped on purpose, so that you get the context below. Before you continue, examine the state that the stop left: a git stash that was not popped, a half-done commit, merge or rebase, a branch switch, a command or background job that still runs, or a half-written file. Put the repo back in a clean state first. Then continue the task with this context:";

function result<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

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

const factory: CustomToolFactory = (pi: CustomToolAPI) => {
	async function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
		const r = await pi.exec(cmd, args, { signal });
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
				"List open Herdr spaces (except the orchestrator's own), their tabs, and each terminal's app, state (idle|working|done|blocked|error, null for plain shells), turn, title, and cwd. Call this first to find the space that matches the user's request; match on space name and terminal cwd, not on folder.",
			loadMode: "essential",
			parameters: pi.zod.object({}),
			async execute(_id, _params, _onUpdate, _ctx, signal) {
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
				return result({ self: { terminal: self ?? null, space: selfSpace?.id ?? null }, spaces: out });
			},
		},
		{
			name: "herdr_send",
			label: "Herdr Send",
			description:
				"Send a task as a prompt to an omp session in another Herdr terminal. Use this when herdr_spaces shows a matching space with an omp terminal in state idle or done. Refuses other apps, busy terminals, and the orchestrator's own terminal. With interrupt: true it also takes a working terminal: for a correction or more context for the task that terminal runs now, it stops the turn (hc interrupt, as Esc does), waits until the terminal is idle or done, and sends the text after a note that tells the worker its turn was stopped and to clean up first. It never sends to a blocked terminal, with or without interrupt: a key press can answer its dialog. Waits up to 15 s for the prompt to start and throws a 'Prompt did not start' error if it does not; then use herdr_new_agent beside that terminal and do not send again. Returns the turn before the send (pass it to herdr_wait as after_turn) and interrupted: whether a turn was stopped.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				text: pi.zod.string(),
				interrupt: pi.zod.boolean().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				if (params.terminal === self) throw new Error("Refusing to send to the orchestrator's own terminal");
				let info = await get(params.terminal, signal);
				const app = info.status?.app;
				const state = info.status?.state;
				if (app !== "omp") throw new Error(`Terminal ${params.terminal} runs ${app ?? "no agent"}, not omp`);
				if (state === "blocked") {
					throw new Error(`Terminal ${params.terminal} is blocked on a dialog; never send or interrupt there, tell the user to look at it`);
				}
				const interrupted = params.interrupt === true && state === "working";
				if (interrupted) info = await stop(params.terminal, signal);
				else if (state !== "idle" && state !== "done") {
					throw new Error(`Terminal ${params.terminal} is ${state ?? "unknown"}; send only when idle or done, or pass interrupt: true for more context on its current task`);
				}
				const text = interrupted ? `${STOPPED_NOTE}\n\n${params.text}` : params.text;
				return result({ terminal: params.terminal, turn: await deliver(params.terminal, text, info, signal), interrupted });
			},
		},
		{
			name: "herdr_new_agent",
			label: "Herdr New Agent",
			description:
				"Start another omp session beside an existing one, in the same Herdr space and the same tab, as Ctrl+E does (pane.split right). The pane of terminal `beside` splits, and omp starts there in the same folder with task as its first prompt (a real user prompt, so the `orchestrate` keyword works). The existing session keeps running and stays visible. Use this for every new session in an open space: another agent, a busy space, or a failed send. Waits up to 45 s for the first turn to start. Returns the new terminal and turn 0 for herdr_wait.",
			loadMode: "essential",
			parameters: pi.zod.object({
				beside: pi.zod.string(),
				task: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				if (params.beside === self) throw new Error("Refusing to split the orchestrator's own pane");
				const { spaces, hcId } = await view(signal);
				let pane: string | undefined;
				let space: string | undefined;
				for (const s of spaces)
					for (const t of s.tabs)
						for (const term of t.terminals)
							if (hcId(term.terminal) === params.beside) {
								pane = term.pane;
								space = s.id;
							}
				if (!pane) throw new Error(`Terminal ${params.beside} has no pane in herdr-app ls`);
				// space.new starts its argv in a login shell, but pane.split runs it as is, with the PATH
				// herdr-core started with, which lacks ~/.local/bin (where omp is) on a remote machine.
				const argv = ["sh", "-lc", 'exec omp "$@"', "sh", params.task];
				const split = await runJson<{ pane: string; terminal: string }>(
					"herdr-app",
					["do", "pane.split", "--direction", "right", "--pane", pane, "--argv", JSON.stringify(argv)],
					signal,
				);
				const terminal = hcId(split.terminal);
				let info: HcGet = {};
				const deadline = Date.now() + 45_000;
				for (;;) {
					info = await get(terminal, signal).catch(() => ({}) as HcGet);
					const state = info.status?.state;
					if (info.status?.app === "omp" && ((info.turn ?? 0) > 0 || (state && state !== "idle" && state !== "done"))) break;
					if (Date.now() >= deadline)
						throw new Error(`omp on ${terminal} did not start the task in 45 s (last state ${state ?? "unknown"}, turn ${info.turn ?? 0}). Do not start it again; read the terminal with herdr_read.`);
					await sleep(500, signal);
				}
				return result({ space, pane: split.pane, terminal, turn: 0 });
			},
		},
		{
			name: "herdr_new_space",
			label: "Herdr New Space",
			description:
				"Create a temporary Herdr space and start omp there with task as its first prompt. Use this only when no open space matches the request. name must match ^[a-z0-9-]+$; the tool adds the prefix tmp-. folder defaults to /tmp/herdr-orchestrator/<name> and is created if missing.",
			loadMode: "essential",
			parameters: pi.zod.object({
				name: pi.zod.string(),
				folder: pi.zod.string().optional(),
				task: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				if (!/^[a-z0-9-]+$/.test(params.name)) throw new Error(`Space name must match ^[a-z0-9-]+$: ${params.name}`);
				const name = params.name.startsWith("tmp-") ? params.name : `tmp-${params.name}`;
				const folder = params.folder ?? `/tmp/herdr-orchestrator/${name}`;
				fs.mkdirSync(folder, { recursive: true });
				// The space goes on the orchestrator's machine, where omp and this folder are.
				const { machine, hcId } = await view(signal);
				const created = await runJson<Created>(
					"herdr-app",
					["do", "space.new", "--name", name, "--folder", folder, "--argv", '["omp"]', "--task", params.task, ...(machine ? ["--machine", machine] : [])],
					signal,
				);
				return result({ space: created.space, tab: created.tab, terminal: hcId(created.terminal) });
			},
		},
		{
			name: "herdr_wait",
			label: "Herdr Wait",
			description:
				"Block until the omp session in a terminal starts a turn after after_turn and then stops working, or until timeout_s (default 600) passes. Use this after herdr_send, herdr_new_agent, or herdr_new_space (after_turn 0 for new terminals). started false means no turn began within 60 s, so the prompt did not start. timed_out true means it is still working.",
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
