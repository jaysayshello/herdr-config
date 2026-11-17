// /claude and /omp: switch every idle or done omp terminal in the Herdr spaces to Claude Code, or every
// Claude Code terminal back to omp, in the same pane and cwd. The new tool starts with a handoff file
// (lib/handoff.ts) as its first prompt. A switch back resumes the tool's own old session when it did not
// move on since the last switch away, and then the handoff has only the part after that switch.
// `/claude <space name>` and `/omp <space name>` switch only that space. This orchestrator, its space,
// the reviewers space, busy terminals and Claude with a background job are skipped.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { trustFolder } from "../lib/claude-trust.ts";
import { buildHandoff, firstPrompt, sessionPoint, type Tool, writeHandoff } from "../lib/handoff.ts";
import { agentTool } from "../tools/herdr.ts";
import {
	backIn,
	crumbFile,
	type Exec,
	hcGet,
	OMP_CRUMBS,
	type Outcome,
	ompSessionFile,
	PARALLEL,
	quote,
	shellStays,
	splitPane,
	stateOf,
	stopThenType,
	type Target,
	targets,
	toolPid,
} from "./herdr-reload.ts";
import { FORGET_EVENT } from "./herdr-watch.ts";

const self = process.env.HC_TERMINAL_ID;
const STATE = path.join(os.homedir(), ".local/state");
// The Claude hook (claude/hooks/herdr-claude.sh) writes this breadcrumb, in the shape of the omp one.
export const CLAUDE_CRUMBS = path.join(STATE, "claude-herdr-resume");
export const SWITCH_DIR = path.join(STATE, "herdr-switch");
// A copy of the Claude config from before the first trust change of a switch.
export const TRUST_BACKUP = path.join(SWITCH_DIR, "claude.json.backup");
const CRUMBS: Record<Tool, string> = { omp: OMP_CRUMBS, claude: CLAUDE_CRUMBS };
const NAMES: Record<Tool, string> = { omp: "omp", claude: "Claude" };
const SHELL_CHILD = "(sh|bash|zsh|fish)";
const HOOK = "herdr-claude.sh";

// Per terminal: the session and leaf of each tool at the last switch away from it.
interface SwitchRecord {
	created_ms: number;
	omp?: { session_id: string; leaf: string };
	claude?: { session_id: string; leaf: string };
}

// Herdr gets Claude's state only from the hook, and hc keeps the last omp state after omp ends, so
// without the hook a switched terminal still reads as an idle omp.
export function hookInstalled(): boolean {
	const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
	let settings: unknown;
	try {
		settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
	} catch {
		return false;
	}
	const named = (v: unknown): boolean => {
		if (Array.isArray(v)) return v.some(named);
		if (!v || typeof v !== "object") return false;
		return Object.entries(v).some(([k, x]) => (k === "command" && typeof x === "string" ? x.includes(HOOK) : named(x)));
	};
	return !!settings && typeof settings === "object" && "hooks" in settings && named(settings.hooks);
}

// "π > MISP: Fix misp-modules image build" -> "Fix misp-modules image build", as herdr-watch.ts reads a
// title, but whole. A title with no omp tag (a shell path) gives nothing.
export function taskTitle(title: string | undefined): string | undefined {
	const m = title?.match(/\b[A-Z0-9]{2,}:\s*(.+)$/);
	return m ? m[1].trim() : undefined;
}

// The omp icon at the start of the title becomes Claude's, so the tab shows which tool runs.
export function claudeTitle(title: string): string {
	return title.replace(/^([^\p{L}\p{N}]*)π/u, "$1✳");
}

// One line for the shell. The title comes first, with OSC 2, and Claude must not change it.
// `command` skips a `claude` alias; `--` keeps a prompt that starts with `-` a prompt. The prompt is the
// handoff file, read by the shell, so the typed line stays short.
export function claudeCommand(o: { title?: string; name?: string; resume?: string; fork?: boolean; promptFile: string }): string {
	const words = ["CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1", "command", "claude"];
	if (o.name) words.push("-n", quote(o.name));
	if (o.resume) words.push("--resume", quote(o.resume), ...(o.fork ? ["--fork-session"] : []));
	words.push("--", fromFile(o.promptFile));
	const title = o.title ? `printf '\\033]2;%s\\007' ${quote(o.title)}; ` : "";
	return title + words.join(" ");
}

export function ompCommand(o: { resume?: string; promptFile: string }): string {
	return ["omp", ...(o.resume ? ["--resume", quote(o.resume)] : []), fromFile(o.promptFile)].join(" ");
}

// The shell does not expand the text that a command substitution gives inside double quotes.
const fromFile = (file: string) => `"$(cat ${quote(file)})"`;

function readRecord(terminal: string, createdMs: number): SwitchRecord {
	try {
		const r = JSON.parse(fs.readFileSync(path.join(SWITCH_DIR, `${terminal}.json`), "utf8")) as SwitchRecord;
		if (r.created_ms === createdMs) return r;
	} catch {}
	return { created_ms: createdMs };
}

function writeRecord(terminal: string, record: SwitchRecord) {
	fs.mkdirSync(SWITCH_DIR, { recursive: true });
	fs.writeFileSync(path.join(SWITCH_DIR, `${terminal}.json`), `${JSON.stringify(record)}\n`);
}

// A pane split gives the terminal a new id: the record and the old tool's breadcrumb go with it, so a
// switch back still finds the old session. The new tool writes its own breadcrumb.
function moveTo(from: Tool, oldId: string, newId: string, createdMs: number, record: SwitchRecord) {
	writeRecord(newId, { ...record, created_ms: createdMs });
	fs.rmSync(path.join(SWITCH_DIR, `${oldId}.json`), { force: true });
	const oldCrumb = path.join(CRUMBS[from], oldId);
	try {
		const lines = fs.readFileSync(oldCrumb, "utf8").split("\n");
		lines[0] = String(createdMs);
		fs.writeFileSync(path.join(CRUMBS[from], newId), lines.join("\n"));
		fs.rmSync(oldCrumb, { force: true });
	} catch {}
}

// The tool whose session a terminal last held, from a breadcrumb with no quit mark: the tool ended
// without a switch or a quit (killed, crashed), and only a shell runs there now.
function stoppedTool(terminal: string, createdMs: number | undefined): Tool | undefined {
	for (const tool of ["omp", "claude"] as const)
		if (crumbFile(CRUMBS[tool], terminal, createdMs) && fs.readFileSync(path.join(CRUMBS[tool], terminal), "utf8").split("\n")[2] !== "quit")
			return tool;
	return undefined;
}

export default function herdrSwitch(pi: ExtensionAPI) {
	const exec: Exec = (cmd, args) => pi.exec(cmd, args);

	async function sessionFile(from: Tool, t: Target, pid: number): Promise<string | undefined> {
		if (from === "omp") return ompSessionFile(exec, t, pid);
		return crumbFile(CLAUDE_CRUMBS, t.terminal, t.info.created_ms);
	}

	async function switchOne(t: Target, from: Tool, to: Tool): Promise<Outcome & { now?: string }> {
		const skip = (why: string) => ({ target: t, ok: false, note: `skipped: ${why}` });
		if (t.terminal === self) return skip("this orchestrator");
		if (t.own) return skip("the orchestrator's own space");
		if (t.space === "reviewers") return skip("the reviewers space (PR fix agents)");
		const info = await hcGet(exec, t.terminal);
		t.info = info;
		// A Claude that started before the hook was installed never reports a state.
		if (agentTool(info.status?.app) !== from) return skip("no state");
		const state = stateOf(info);
		if (state !== "idle" && state !== "done") return skip(state === "unknown" ? "no state" : state);
		const fg = info.foreground?.pid ?? info.pid;
		const pid = fg ? await toolPid(exec, fg, from, info.pid) : undefined;
		if (!pid) return skip(`no ${from} process found`);
		// SIGTERM would end a background job too. omp has no background job while idle or done (since
		// omp 18.18.9 it reports working until its jobs end); Claude's run as a shell under it.
		if (from === "claude" && (await exec("pgrep", ["-P", String(pid), "-x", SHELL_CHILD])).stdout.trim())
			return skip("a background job runs");
		const file = await sessionFile(from, t, pid);
		if (!file) return skip("no session found");
		const stays = shellStays(info.argv ?? []);
		if (!stays && !t.pane) return skip("no pane in herdr-app ls");
		const createdMs = info.created_ms ?? 0;
		const cwd = info.foreground?.cwd ?? info.cwd ?? os.homedir();

		// The new tool resumes its own old session only when that session is where the last switch left
		// it. A Claude session that moved on is forked; an omp session that moved on is not resumed.
		const record = readRecord(t.terminal, createdMs);
		const back = record[to];
		const backFile = back ? crumbFile(CRUMBS[to], t.terminal, createdMs) : undefined;
		const backPoint = backFile ? sessionPoint(to, backFile) : undefined;
		const same = back && backPoint?.sessionId === back.session_id;
		const resume = same && backPoint?.leaf === back.leaf ? "resume" : same && to === "claude" ? "fork" : "new";
		// The new tool gets only the part after the last switch away from the old one when it already
		// has what came before.
		const left = record[from];
		const sinceLeaf = resume !== "new" && left && left.session_id === sessionPoint(from, file).sessionId ? left.leaf : undefined;
		const handoff = await buildHandoff({ from, to, file, cwd, sinceLeaf });
		record[from] = { session_id: handoff.point.sessionId, leaf: handoff.point.leaf ?? "" };
		const task = taskTitle(info.title);
		const handoffPath = writeHandoff(t.terminal, firstPrompt(from, to, handoff.markdown, task));
		const command =
			to === "claude"
				? claudeCommand({
						title: info.title ? claudeTitle(info.title) : undefined,
						name: resume === "new" ? task : undefined,
						resume: resume === "new" ? undefined : backPoint!.sessionId,
						fork: resume === "fork",
						promptFile: handoffPath,
					})
				: ompCommand({ resume: resume === "resume" ? backFile : undefined, promptFile: handoffPath });
		const how = [
			resume === "resume" ? "resumed its old session" : resume === "fork" ? "forked its old session, which moved on" : "new session",
			handoff.partial ? "handoff since the last switch" : "full handoff",
		].join(", ");
		const want = {
			app: to,
			name: to,
			states: ["idle", "working", "done"],
			ok: `switched to ${NAMES[to]} (${how})`,
			late: `${NAMES[to]} did not start`,
		};

		// The terminal can turn busy while the handoff is built; the stop below would end its work.
		const now = await hcGet(exec, t.terminal).catch(() => undefined);
		const nowState = now ? stateOf(now) : "unknown";
		const nowFg = now?.foreground?.pid ?? now?.pid;
		const nowPid = nowFg ? await toolPid(exec, nowFg, from, now?.pid) : undefined;
		if (agentTool(now?.status?.app) !== from || (nowState !== "idle" && nowState !== "done") || nowPid !== pid) {
			fs.rmSync(handoffPath, { force: true });
			return skip(nowPid === pid ? `became ${nowState}` : "the process changed");
		}
		// Claude asks once per folder if it can trust it, and runs no hook before the answer: mark this
		// cwd (only this one) as trusted first. On a failure the old tool still runs.
		if (to === "claude") {
			try {
				await trustFolder(cwd, TRUST_BACKUP);
			} catch (err) {
				fs.rmSync(handoffPath, { force: true });
				return skip(`could not mark the folder as trusted for Claude: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		writeRecord(t.terminal, record);
		// A watch keeps a done worker for 10 minutes; the stop below must not reach it as a report.
		pi.events.emit(FORGET_EVENT, { terminal: t.terminal });
		// The quit mark stops a fresh shell (and a bare `omp`) from reopening the old tool's session.
		if (crumbFile(CRUMBS[from], t.terminal, createdMs)) fs.appendFileSync(path.join(CRUMBS[from], t.terminal), "quit\n");

		if (stays) {
			const { failed, sent } = await stopThenType(exec, t.terminal, pid, command, from);
			if (failed) return { target: t, ok: false, note: failed };
			return backIn(exec, t, t.terminal, pid, want, "", sent);
		}
		// The terminal ends with the old tool. The split pane waits for it to end, then starts the new
		// tool in the old cwd, and keeps a shell after it, so the next switch types its command.
		const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; cd "$2" && eval "$3"; exec "$0" -li';
		const terminal = await splitPane(exec, t.pane!, script, [String(pid), cwd, command]);
		process.kill(pid, "SIGTERM");
		const fresh = await hcGet(exec, terminal).catch(() => undefined);
		if (fresh?.created_ms) moveTo(from, t.terminal, terminal, fresh.created_ms, record);
		return { ...(await backIn(exec, t, terminal, pid, want)), now: terminal };
	}

	async function run(from: Tool, to: Tool, args: string, ctx: { ui: { notify(m: string, kind: "info" | "warning" | "error"): void } }) {
		const name = `/${to}`;
		if (!hookInstalled()) {
			ctx.ui.notify(
				`${name}: the Claude hook is not installed. Add ${HOOK} to the hooks in the Claude settings.json (see the herdr-config README), then try again.`,
				"warning",
			);
			return;
		}
		// New workers start in this mode (herdr_new_agent, herdr_new_space).
		fs.mkdirSync(SWITCH_DIR, { recursive: true });
		fs.writeFileSync(path.join(SWITCH_DIR, "mode"), `${to}\n`);

		const only = args.trim() || undefined;
		// For omp, the omp state and an omp process (hc keeps the last omp state after omp ends). For
		// Claude, any claude process: one with no state shows in the report as skipped. A terminal with
		// no omp or claude process but the breadcrumb of a session that did not quit goes in the report
		// too, so a killed tool does not go out of sight.
		const stopped = new Map<string, Tool>();
		const found = await targets(exec, only, async (info, terminal) => {
			const fg = info.foreground?.pid ?? info.pid;
			const pid = fg ? await toolPid(exec, fg, from, info.pid) : undefined;
			if (pid) return from === "claude" || agentTool(info.status?.app) === "omp";
			if (fg && (await toolPid(exec, fg, from === "omp" ? "claude" : "omp", info.pid))) return false;
			const tool = stoppedTool(terminal, info.created_ms);
			if (tool) stopped.set(terminal, tool);
			return !!tool;
		});
		const all = found.filter(t => !stopped.has(t.terminal));
		const dead = found.filter(t => stopped.has(t.terminal) && t.terminal !== self && !t.own && t.space !== "reviewers");
		if (all.length === 0 && dead.length === 0) {
			ctx.ui.notify(only ? `${name}: no ${from} terminal in a space named ${only}` : `${name}: no ${from} terminals found`, "warning");
			return;
		}
		if (all.length) ctx.ui.notify(`${name}: switching ${all.length} ${from} terminals to ${NAMES[to]}`, "info");

		const outcomes: (Outcome & { now?: string })[] = [];
		const queue = [...all];
		await Promise.all(
			Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
				for (let t = queue.shift(); t; t = queue.shift())
					outcomes.push(await switchOne(t, from, to).catch(err => ({ target: t!, ok: false, note: `failed: ${String(err)}` })));
			}),
		);
		for (const t of dead)
			outcomes.push({ target: t, ok: false, note: `skipped: no agent runs; its ${NAMES[stopped.get(t.terminal)!]} session stopped (type omp or claude there to resume it)` });

		const line = (o: Outcome & { now?: string }) =>
			`- ${o.target.terminal}${o.now ? ` -> ${o.now}` : ""} (${o.target.space.replace(/-\d{4}-\d{2}-\d{2}$/, "")}): ${o.note}`;
		const done = outcomes.filter(o => o.ok);
		const skipped = outcomes.filter(o => !o.ok);
		const report = [
			`${name}: ${done.length} switched, ${skipped.length} skipped or failed.`,
			...(done.length ? ["Switched:", ...done.map(line)] : []),
			...(skipped.length ? [`Skipped or failed (type ${name} again later, or switch these by hand):`, ...skipped.map(line)] : []),
		].join("\n");
		pi.sendMessage({ customType: "herdr-switch", content: report, display: true }, { triggerTurn: false });
		ctx.ui.notify(report, skipped.length ? "warning" : "info");
	}

	pi.registerCommand("claude", {
		description: "Switch every idle or done omp terminal in the Herdr spaces (or in one space) to Claude Code, with its context",
		handler: (args, ctx) => run("omp", "claude", args, ctx),
	});
	pi.registerCommand("omp", {
		description: "Switch every idle or done Claude Code terminal in the Herdr spaces (or in one space) back to omp, with its context",
		handler: (args, ctx) => run("claude", "omp", args, ctx),
	});
}
