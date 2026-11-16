// rex_watch: watches one worker terminal without an LLM and pushes its result into this session,
// as herdr_watch does for Herdr. It reports about 1 s after the worker stops.
//
// After a report it keeps watching: a blocked worker until it stops again, a done worker for
// FOLLOW_MS, so a worker that wakes later for its own background job still reports. A new
// rex_watch on the same terminal replaces the old watch.
import * as fs from "node:fs";
import { theme, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { focusLink, rexClient, type Term } from "../tools/rex.ts";

const START_MS = 60_000;
const SETTLE_MS = 1_000;
const POLL_MS = 1_000;
const FOLLOW_MS = 10 * 60_000;
const MAX_MS = 4 * 3_600_000;
const ANSWER_MAX = 6_000;
const WIDGET = "rex-watch";
// rex-pr-autofix.ts sends this ({ block }) just before it closes a fix agent's window, so that
// the watch of that terminal ends without a report.
export const FORGET_EVENT = "rex-watch:forget";

type Phase = "starting" | "working" | "blocked" | "following";

interface Watch {
	term: Term;
	afterTurn: number;
	prompt: string;
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
const label = (w: Watch) => `${w.term.short} in ${w.term.sessionName.replace(/-\d{4}-\d{2}-\d{2}$/, "")}: ${w.prompt}`;

function links(text: string): string[] {
	const found = text.match(/https?:\/\/[^\s<>()`"'|\]]+/g) ?? [];
	return [...new Set(found.map(l => l.replace(/[.,;:]+$/, "")))].slice(0, 5);
}

interface Message {
	type?: string;
	message?: { role?: string; content?: unknown };
}

// The last assistant text after the newest user prompt, from the worker's session file.
function finalAnswer(file: string | undefined): string | undefined {
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

export default function rexWatch(pi: ExtensionAPI) {
	const rex = rexClient(pi.exec);
	const watches = new Map<string, Watch>();
	let ui: ExtensionContext["ui"] | undefined;
	const stateOf = (t: Term) => t.state ?? "unknown";

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
			`space: ${w.term.sessionName}`,
			`space_id: ${w.term.session}`,
			`terminal: ${w.term.short}`,
			`link: ${focusLink(w.term)}`,
			`state: ${state}`,
			...lines,
		].join("\n");
		pi.sendMessage(
			{
				customType: "rex-report",
				content: `<rex-report terminal="${w.term.short}">\n${body}\n</rex-report>`,
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "aside", triggerTurn: true },
		);
	}

	async function report(w: Watch, t: Term, note: string | undefined, signal: AbortSignal) {
		const state = stateOf(t);
		let answer = state === "done" || state === "idle" ? finalAnswer(await rex.sessionFile(t)) : undefined;
		let source = "session";
		if (!answer) {
			// A dialog or an error shows only on the screen. The dialog and the last reply sit at the
			// bottom of the screen.
			const screen = await rex.read(t, 60, signal);
			answer = screen.split("\n").filter(l => l.trim()).slice(-40).join("\n");
			source = "screen, last 40 lines";
		}
		const cut = answer.length > ANSWER_MAX;
		send(w, state, [
			...(note ? [`note: ${note}`] : []),
			// omp tells Rex the text of an open ask dialog.
			...(state === "blocked" && t.msg ? [`question: ${t.msg.replace(/\s+/g, " ")}`] : []),
			`links: ${links(answer).join(", ") || "none"}`,
			`answer (${source}${cut ? `, first ${ANSWER_MAX} characters` : ""}):`,
			cut ? answer.slice(0, ANSWER_MAX) : answer,
		]);
	}

	// Waits until the terminal stops working, then once more for SETTLE_MS.
	async function untilStopped(t: Term, deadline: number, signal: AbortSignal): Promise<Term> {
		for (;;) {
			while (stateOf(t) === "working" && Date.now() < deadline) {
				await sleep(POLL_MS, signal);
				t = await rex.get(t, signal);
			}
			if (stateOf(t) === "working") return t;
			await sleep(SETTLE_MS, signal);
			t = await rex.get(t, signal);
			if (stateOf(t) !== "working") return t;
		}
	}

	async function run(w: Watch) {
		const signal = w.stop.signal;
		const deadline = Date.now() + MAX_MS;
		let t = await rex.get(w.term, signal);
		const began = async (x: Term) => stateOf(x) === "working" || (await rex.turn(x)) > w.afterTurn;

		// A fresh omp reports idle at its start before it takes the task.
		const startBy = Date.now() + START_MS;
		while (!(await began(t)) && Date.now() < startBy) {
			await sleep(500, signal);
			t = await rex.get(t, signal);
		}
		if (!(await began(t))) {
			await report(w, t, "the prompt did not start within 60 s", signal);
			return;
		}

		let note: string | undefined;
		for (;;) {
			setPhase(w, "working");
			t = await untilStopped(t, deadline, signal);
			if (stateOf(t) === "working") {
				await report(w, t, "still working after 4 hours; this watch stopped", signal);
				return;
			}
			await report(w, t, note, signal);
			const blocked = stateOf(t) === "blocked";
			setPhase(w, blocked ? "blocked" : "following");
			const turn = await rex.turn(t);
			const followBy = blocked ? deadline : Math.min(deadline, Date.now() + FOLLOW_MS);
			while ((await rex.turn(t)) === turn && stateOf(t) !== "working" && Date.now() < followBy) {
				await sleep(POLL_MS, signal);
				t = await rex.get(t, signal);
				if (stateOf(t) === "blocked" && !blocked) break;
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
	pi.events.on(FORGET_EVENT, data => {
		const block = data && typeof data === "object" && "block" in data ? data.block : undefined;
		const w = typeof block === "string" ? watches.get(block) : undefined;
		if (!w) return;
		w.stop.abort();
		watches.delete(block as string);
		draw();
	});

	pi.registerTool({
		name: "rex_watch",
		label: "Rex Watch",
		description:
			"Watch one omp worker terminal after rex_send, rex_new_agent, or rex_new_space, without a subagent. Returns at once. When the worker stops (done, idle, blocked on a question, or error), a <rex-report> message with its final answer arrives in this session and starts a turn. It keeps watching: a blocked worker until it stops again, a done worker for 10 minutes in case it wakes for its own background job; each later stop sends another report marked update. A new rex_watch on the same terminal replaces the old watch. after_turn is the turn from rex_send, or 0 for a new terminal. prompt is a summary of the request in about 10 words; the Workers panel shows '<terminal> in <space>: <prompt>'. Returns the space_id and the link for the More row.",
		loadMode: "essential",
		parameters: pi.zod.object({
			terminal: pi.zod.string(),
			after_turn: pi.zod.number(),
			prompt: pi.zod.string(),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.agent.kind === "main" && ctx.hasUI) ui = ctx.ui;
			const term = await rex.resolve(params.terminal, signal);
			if (term.app !== "omp") throw new Error(`Terminal ${term.short} runs ${term.fgName ?? "no agent"}, not omp`);
			watches.get(term.block)?.stop.abort();
			const w: Watch = {
				term,
				afterTurn: params.after_turn,
				prompt: params.prompt.replace(/\s+/g, " ").trim(),
				phase: "starting",
				stop: new AbortController(),
			};
			watches.set(term.block, w);
			draw();
			run(w)
				.catch(err => {
					if (!w.stop.signal.aborted)
						send(w, "error", [`note: the watch failed: ${err instanceof Error ? err.message : String(err)}`]);
				})
				.finally(() => {
					if (watches.get(term.block) === w) {
						watches.delete(term.block);
						draw();
					}
				});
			const details = {
				terminal: term.short,
				space: term.sessionName,
				space_id: term.session,
				link: focusLink(term),
				label: label(w),
				watching: true,
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
		},
	});
}
