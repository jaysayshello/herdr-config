// herdr_watch: watches one worker terminal without an LLM and pushes its result into this session.
// The old path (a herdr-watcher subagent that calls herdr_wait, then herdr_read, then writes a summary)
// spent about 5 s on a settle sleep and 4 to 30 s on the subagent's own model calls before the
// orchestrator saw anything. This watch reports about 1 s after the worker stops.
//
// After a report it keeps watching: a blocked worker until it stops again, a done worker for
// FOLLOW_MS, so a worker that wakes later for its own background job still reports. A new
// herdr_watch on the same terminal replaces the old watch.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { theme, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const START_MS = 60_000;
// omp 18.18.9 stays working while a background job runs, but older builds reported done for a
// moment before the job woke them. Workers keep the omp build they started with.
const SETTLE_MS = 1_000;
const FOLLOW_MS = 10 * 60_000;
const MAX_MS = 4 * 3_600_000;
const ANSWER_MAX = 6_000;
const WIDGET = "herdr-watch";
// herdr-resume.ts writes this breadcrumb in each worker: created_ms, then the session file.
const CRUMBS = path.join(os.homedir(), ".local/state/omp-herdr-resume");

interface HcGet {
	turn?: number;
	created_ms?: number;
	status?: { app?: string; state?: string; kind?: string; msg?: string } | null;
	labels?: Record<string, string>;
}

type Phase = "starting" | "working" | "blocked" | "following";

interface Watch {
	terminal: string;
	afterTurn: number;
	prompt: string;
	space: string;
	spaceId: string | null;
	phase: Phase;
	stop: AbortController;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal.aborted) {
		reject(new Error("Cancelled"));
		return promise;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(new Error("Cancelled"));
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

// The panel line: "demo-service-2026-11-03" reads as "demo-service".
const label = (w: Pick<Watch, "terminal" | "space" | "prompt">) =>
	`${w.terminal} in ${w.space.replace(/-\d{4}-\d{2}-\d{2}$/, "")}: ${w.prompt}`;

function links(text: string): string[] {
	const found = text.match(/https?:\/\/[^\s<>()`"'|\]]+/g) ?? [];
	return [...new Set(found.map(l => l.replace(/[.,;:]+$/, "")))].slice(0, 5);
}

interface Message {
	type?: string;
	message?: { role?: string; content?: unknown };
}

// The last assistant text after the newest user prompt, from the worker's session file.
function finalAnswer(terminal: string, createdMs: number | undefined): string | undefined {
	let file: string | undefined;
	try {
		const [created, session] = fs.readFileSync(path.join(CRUMBS, terminal), "utf8").split("\n");
		// A reused terminal address must not read another terminal's session.
		if (created === String(createdMs)) file = session;
	} catch {
		return undefined;
	}
	if (!file) return undefined;
	let tail: string;
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const len = Math.min(size, 4 * 1024 * 1024);
			const buf = Buffer.alloc(len);
			fs.readSync(fd, buf, 0, len, size - len);
			tail = buf.toString("utf8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	const lines = tail.split("\n");
	for (let i = lines.length - 1; i > 0; i--) {
		let entry: Message;
		try {
			entry = JSON.parse(lines[i]) as Message;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user") return undefined;
		if (role !== "assistant" || !Array.isArray(entry.message?.content)) continue;
		const text = (entry.message.content as { type?: string; text?: string }[])
			.filter(c => c.type === "text" && c.text)
			.map(c => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return undefined;
}

export default function herdrWatch(pi: ExtensionAPI) {
	const watches = new Map<string, Watch>();
	let ui: ExtensionContext["ui"] | undefined;

	async function hc(args: string[], signal: AbortSignal): Promise<string> {
		const r = await pi.exec("hc", args, { signal });
		if (r.killed || signal.aborted) throw new Error("Cancelled");
		if (r.code !== 0) throw new Error(r.stderr || r.stdout || `hc ${args[0]} exited with code ${r.code}`);
		return r.stdout;
	}
	const get = async (t: string, signal: AbortSignal) => JSON.parse(await hc(["get", t, "--json"], signal)) as HcGet;
	const stateOf = (info: HcGet) => info.status?.state ?? "unknown";

	function draw() {
		if (!ui) return;
		if (watches.size === 0) {
			ui.setWidget(WIDGET, undefined);
			return;
		}
		const rows = [...watches.values()].map(w => {
			const mark =
				w.phase === "blocked"
					? theme.fg("warning", "◆")
					: w.phase === "following"
						? theme.fg("dim", "·")
						: theme.fg("accent", "◌");
			const note = { starting: "starting", working: "working", blocked: "waits for you", following: "reported" }[w.phase];
			return ` └ ${mark} ${theme.fg(w.phase === "following" ? "muted" : "accent", label(w))}${theme.fg("dim", ` · ${note}`)}`;
		});
		const reported = [...watches.values()].filter(w => w.phase === "following").length;
		const counts = `${watches.size - reported} running${reported ? `, ${reported} reported` : ""}`;
		ui.setWidget(WIDGET, [`${theme.bold(theme.fg("accent", "Workers"))}${theme.fg("dim", ` · ${counts}`)}`, ...rows], {
			placement: "aboveEditor",
		});
	}

	function setPhase(w: Watch, phase: Phase) {
		if (w.phase === phase) return;
		w.phase = phase;
		draw();
	}

	function send(w: Watch, state: string, lines: string[]) {
		const body = [
			`prompt: ${w.prompt}`,
			`space: ${w.space}`,
			`space_id: ${w.spaceId ?? "none"}`,
			`terminal: ${w.terminal}`,
			`state: ${state}`,
			...lines,
		].join("\n");
		pi.sendMessage(
			{
				customType: "herdr-report",
				content: `<herdr-report terminal="${w.terminal}">\n${body}\n</herdr-report>`,
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "aside", triggerTurn: true },
		);
	}

	async function report(w: Watch, info: HcGet, note: string | undefined, signal: AbortSignal) {
		const state = stateOf(info);
		let answer = state === "done" || state === "idle" ? finalAnswer(w.terminal, info.created_ms) : undefined;
		let source = "session";
		if (!answer) {
			// A dialog or an error shows only on the screen; so does the answer of a worker without a breadcrumb.
			// The dialog and the last reply sit at the bottom of the screen.
			const screen = await hc(["read", w.terminal, "--lines", state === "blocked" ? "0" : "60"], signal);
			answer = screen.split("\n").filter(l => l.trim()).slice(-40).join("\n");
			source = "screen, last 40 lines";
		}
		const cut = answer.length > ANSWER_MAX;
		send(w, state, [
			...(note ? [`note: ${note}`] : []),
			// omp tells hc the text of an open ask dialog.
			...(state === "blocked" && info.status?.msg ? [`question: ${info.status.msg.replace(/\s+/g, " ")}`] : []),
			`links: ${links(answer).join(", ") || "none"}`,
			`answer (${source}${cut ? `, first ${ANSWER_MAX} characters` : ""}):`,
			cut ? answer.slice(0, ANSWER_MAX) : answer,
		]);
	}

	// Waits until the terminal stops working. hc wait returns on a state change, a timeout, or a message.
	async function untilStopped(w: Watch, info: HcGet, deadline: number, signal: AbortSignal): Promise<HcGet> {
		for (;;) {
			while (stateOf(info) === "working" && Date.now() < deadline) {
				const started = Date.now();
				const left = Math.max(1, Math.min(180, Math.ceil((deadline - started) / 1000)));
				await pi.exec("hc", ["wait", w.terminal, "--timeout", String(left), "--json"], { signal });
				if (signal.aborted) throw new Error("Cancelled");
				info = await get(w.terminal, signal);
				if (stateOf(info) === "working" && Date.now() - started < 1000) await sleep(1000, signal);
			}
			if (stateOf(info) === "working") return info;
			await sleep(SETTLE_MS, signal);
			info = await get(w.terminal, signal);
			if (stateOf(info) !== "working") return info;
		}
	}

	async function run(w: Watch) {
		const signal = w.stop.signal;
		const deadline = Date.now() + MAX_MS;
		let info = await get(w.terminal, signal);

		// A fresh omp reports idle at its start turn before it takes the task.
		const startBy = Date.now() + START_MS;
		while ((info.turn ?? 0) <= w.afterTurn && stateOf(info) !== "working" && Date.now() < startBy) {
			await sleep(500, signal);
			info = await get(w.terminal, signal);
		}
		if ((info.turn ?? 0) <= w.afterTurn && stateOf(info) !== "working") {
			await report(w, info, "the prompt did not start within 60 s", signal);
			return;
		}

		let note: string | undefined;
		for (;;) {
			setPhase(w, "working");
			info = await untilStopped(w, info, deadline, signal);
			if (stateOf(info) === "working") {
				await report(w, info, "still working after 4 hours; this watch stopped", signal);
				return;
			}
			await report(w, info, note, signal);
			const blocked = stateOf(info) === "blocked";
			setPhase(w, blocked ? "blocked" : "following");
			const turn = info.turn ?? 0;
			const followBy = blocked ? deadline : Math.min(deadline, Date.now() + FOLLOW_MS);
			while ((info.turn ?? 0) === turn && stateOf(info) !== "working" && Date.now() < followBy) {
				await sleep(1000, signal);
				info = await get(w.terminal, signal);
				if (stateOf(info) === "blocked" && !blocked) break;
			}
			if (Date.now() >= followBy) return;
			note = blocked
				? "update: the worker went on after the question"
				: "update: the worker went on by itself after its last report";
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent.kind === "main" && ctx.hasUI) ui = ctx.ui;
	});
	pi.on("session_shutdown", () => {
		for (const w of watches.values()) w.stop.abort();
		watches.clear();
	});

	pi.registerTool({
		name: "herdr_watch",
		label: "Herdr Watch",
		description:
			"Watch one omp worker terminal after herdr_send, herdr_new_agent, or herdr_new_space, without a subagent. Returns at once. When the worker stops (done, idle, blocked on a question, or error), a <herdr-report> message with its final answer arrives in this session and starts a turn. It keeps watching: a blocked worker until it stops again, a done worker for 10 minutes in case it wakes for its own background job; each later stop sends another report marked update. A new herdr_watch on the same terminal replaces the old watch. after_turn is the turn from herdr_send, or 0 for a new terminal. prompt is a summary of the request in about 10 words; the Workers panel shows '<terminal> in <space>: <prompt>'.",
		loadMode: "essential",
		parameters: pi.zod.object({
			terminal: pi.zod.string(),
			after_turn: pi.zod.number(),
			prompt: pi.zod.string(),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.agent.kind === "main" && ctx.hasUI) ui = ctx.ui;
			const info = await get(params.terminal, signal ?? new AbortController().signal);
			if (info.status?.app !== "omp") throw new Error(`Terminal ${params.terminal} runs ${info.status?.app ?? "no agent"}, not omp`);
			watches.get(params.terminal)?.stop.abort();
			const w: Watch = {
				terminal: params.terminal,
				afterTurn: params.after_turn,
				prompt: params.prompt.replace(/\s+/g, " ").trim(),
				space: info.labels?.where?.split(" / ")[0] ?? "no space",
				spaceId: info.labels?.["herdr.space"] ?? null,
				phase: "starting",
				stop: new AbortController(),
			};
			watches.set(w.terminal, w);
			draw();
			run(w)
				.catch(err => {
					if (!w.stop.signal.aborted)
						send(w, "error", [`note: the watch failed: ${err instanceof Error ? err.message : String(err)}`]);
				})
				.finally(() => {
					if (watches.get(w.terminal) === w) {
						watches.delete(w.terminal);
						draw();
					}
				});
			const details = { terminal: w.terminal, space: w.space, space_id: w.spaceId, label: label(w), watching: true };
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}
