// Handoff builder for /claude and /omp. It reads an omp or Claude Code session file and writes a short
// markdown file for the other tool: the summary, the user prompts, the last answers, the open task and the
// project state. No tool calls, tool output or thinking go across. It makes no Herdr calls, so tests can call it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

export type Tool = "omp" | "claude";
export interface SessionPoint {
	sessionId: string;
	leaf: string | undefined;
}
export interface HandoffInput {
	from: Tool;
	to: Tool;
	file: string;
	cwd: string;
	sinceLeaf?: string;
}
export interface Handoff {
	markdown: string;
	point: SessionPoint;
	partial: boolean;
}

const PROMPTS = 20;
const PROMPT_BYTES = 2_048;
const ANSWERS = 3;
const ANSWER_BYTES = 4_096;
const SUMMARY_BYTES = 8_192;
const TOTAL_BYTES = 20_000;
const FILES = 30;
const COMMITS = 3;
const TRACKING = ["README.md", "TODO.md", "MERGED-PRS.md"];
const DAY_MS = 24 * 60 * 60 * 1000;

// Computed at call time: Bun's os.homedir() ignores a HOME change at run time, and tests point HOME at a sandbox.
function handoffDir(): string {
	return path.join(process.env.HOME || os.homedir(), ".local/state/herdr-switch/handoffs");
}

const NAMES: Record<Tool, string> = { omp: "omp", claude: "Claude Code" };

// ---------- secrets ----------

const SECRETS: [RegExp, string][] = [
	[/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, "[redacted]"],
	[/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, "[redacted]"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
	[/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
	[/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"],
	[/("\w*(?:password|passwd|secret|token|api[_-]?key)\w*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
	[/\b(\w*(?:password|passwd|secret|token|api[_-]?key)\w*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s&;,]+)/gi, "$1=[redacted]"],
];

export function redact(text: string): string {
	let out = text;
	for (const [re, to] of SECRETS) out = out.replace(re, to);
	return out;
}

// Claude cannot read omp's local:// files, and their real folder is not known here.
function localPaths(text: string): string {
	return text.replace(/local:\/\/([^\s)`'"\]>]+)/g, "$1 (an omp-only file, not readable here)");
}

function clean(text: string, max: number): string {
	return cut(localPaths(redact(text)).trim(), max);
}

function cut(text: string, max: number): string {
	if (Buffer.byteLength(text) <= max) return text;
	let s = Buffer.from(text).subarray(0, max).toString();
	if (s.endsWith("\uFFFD")) s = s.slice(0, -1);
	return `${s}\n[cut]`;
}

// ---------- parsing ----------

type Kind = "prompt" | "answer" | "summary" | "compaction" | "boundary" | "todo" | "task" | "other";
type Obj = Record<string, unknown>;
interface Call {
	name: string;
	input: Obj;
}
interface Node {
	id: string;
	parent: string | undefined;
	kind: Kind;
	text?: string;
	// omp compaction: where the kept messages start.
	firstKept?: string;
	// Claude: entries of one assistant message share a message id.
	group?: string;
	calls?: Call[];
}
// The few fields read from a session line. Both formats are internal, so every field is checked where it is used.
interface Entry {
	type?: unknown;
	subtype?: unknown;
	id?: unknown;
	parentId?: unknown;
	summary?: unknown;
	firstKeptEntryId?: unknown;
	uuid?: unknown;
	parentUuid?: unknown;
	logicalParentUuid?: unknown;
	isSidechain?: unknown;
	isMeta?: unknown;
	isCompactSummary?: unknown;
	message?: { role?: unknown; content?: unknown; id?: unknown };
}

interface Parsed {
	nodes: Map<string, Node>;
	sessionId: string;
	leaf: string | undefined;
	// The session point (see turnId).
	turn: string | undefined;
}

function str(x: unknown): string | undefined {
	return typeof x === "string" ? x : undefined;
}

function objects(x: unknown): Obj[] {
	return Array.isArray(x) ? x.filter((b): b is Obj => !!b && typeof b === "object") : [];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const b of objects(content)) if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
	return parts.join("\n");
}

function ompNode(e: Entry, id: string): Node {
	const n: Node = { id, parent: str(e.parentId), kind: "other" };
	const m = e.message;
	if (e.type === "compaction") {
		n.kind = "compaction";
		n.text = str(e.summary) ?? "";
		n.firstKept = str(e.firstKeptEntryId);
	} else if (e.type === "branch_summary") {
		n.kind = "summary";
		n.text = str(e.summary) ?? "";
	} else if (e.type === "message" && m) {
		const t = textOf(m.content);
		if (m.role === "user" && t.trim()) {
			n.kind = "prompt";
			n.text = cut(t, PROMPT_BYTES * 2);
		} else if (m.role === "assistant") {
			const calls = objects(m.content)
				.filter(b => b.type === "toolCall" && b.name === "todo")
				.map(b => ({ name: "todo", input: objects([b.arguments])[0] ?? {} }));
			if (calls.length) {
				n.kind = "todo";
				n.calls = calls;
			} else if (t.trim()) n.kind = "answer";
			if (t.trim()) n.text = cut(t, ANSWER_BYTES * 2);
		}
	}
	return n;
}

const CLAUDE_TASK_TOOLS = ["TodoWrite", "TaskCreate", "TaskUpdate"];

function claudeNode(e: Entry, id: string): Node {
	// A compact boundary has no parentUuid; logicalParentUuid keeps the older part reachable for the task list.
	const n: Node = { id, parent: str(e.parentUuid) ?? str(e.logicalParentUuid), kind: "other" };
	const m = e.message;
	if (e.type === "system" && e.subtype === "compact_boundary") n.kind = "boundary";
	else if (e.type === "user" && m) {
		const t = textOf(m.content);
		if (e.isCompactSummary === true) {
			n.kind = "compaction";
			n.text = t;
		} else if (e.isMeta !== true && t.trim() && !t.startsWith("<local-command-")) {
			n.kind = "prompt";
			n.text = cut(t, PROMPT_BYTES * 2);
		}
	} else if (e.type === "assistant" && m) {
		const calls = objects(m.content)
			.filter(b => b.type === "tool_use" && CLAUDE_TASK_TOOLS.includes(String(b.name)))
			.map(b => ({ name: String(b.name), input: objects([b.input])[0] ?? {} }));
		const t = textOf(m.content);
		if (calls.length) {
			n.kind = "task";
			n.calls = calls;
		} else if (t.trim()) n.kind = "answer";
		if (t.trim()) n.text = cut(t, ANSWER_BYTES * 2);
		n.group = str(m.id);
	}
	return n;
}

function ompSessionId(header: Entry | undefined, file: string): string {
	const id = str(header?.id);
	if (id) return id;
	const base = path.basename(file, ".jsonl");
	return base.slice(base.lastIndexOf("_") + 1);
}

// The entry id that counts for the active branch, so sessionPoint and buildHandoff agree on the leaf.
function entryId(tool: Tool, e: Entry): string | undefined {
	if (tool === "claude") return e.isSidechain === true ? undefined : str(e.uuid);
	return e.type === "session" || e.type === "title" ? undefined : str(e.id);
}

// The session point is the last entry of the conversation itself. omp adds entries when it ends
// (session_exit, model_usage, credential_pin) and Claude after a turn (system hook summaries), and
// these must not count as a session that moved on.
function turnId(tool: Tool, e: Entry): string | undefined {
	const turn = tool === "claude" ? e.type === "user" || e.type === "assistant" : e.type === "message" || e.type === "compaction" || e.type === "branch_summary";
	return turn ? entryId(tool, e) : undefined;
}

function parseLine(line: string): Entry | undefined {
	if (!line.trim()) return undefined;
	try {
		const e: unknown = JSON.parse(line);
		return e && typeof e === "object" && !Array.isArray(e) ? (e as Entry) : undefined;
	} catch {
		return undefined;
	}
}

// Reads a file line by line without a whole-file load (session files can be 50 MB).
function* syncLines(file: string): Generator<string> {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(1 << 20);
		let rest = "";
		for (;;) {
			const n = fs.readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			const parts = (rest + buf.subarray(0, n).toString()).split("\n");
			rest = parts.pop() ?? "";
			yield* parts;
		}
		if (rest) yield rest;
	} finally {
		fs.closeSync(fd);
	}
}

export function sessionPoint(tool: Tool, file: string): SessionPoint {
	let header: Entry | undefined;
	let leaf: string | undefined;
	for (const line of syncLines(file)) {
		const e = parseLine(line);
		if (!e) continue;
		if (tool === "omp" && e.type === "session") header ??= e;
		leaf = turnId(tool, e) ?? leaf;
	}
	const sessionId = tool === "omp" ? ompSessionId(header, file) : path.basename(file, ".jsonl");
	return { sessionId, leaf };
}

async function parse(tool: Tool, file: string): Promise<Parsed> {
	const nodes = new Map<string, Node>();
	let header: Entry | undefined;
	let leaf: string | undefined;
	let turn: string | undefined;
	const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
	for await (const line of rl) {
		const e = parseLine(line);
		if (!e) continue;
		if (tool === "omp" && e.type === "session") header ??= e;
		const id = entryId(tool, e);
		if (!id) continue;
		leaf = id;
		turn = turnId(tool, e) ?? turn;
		nodes.set(id, tool === "omp" ? ompNode(e, id) : claudeNode(e, id));
	}
	const sessionId = tool === "omp" ? ompSessionId(header, file) : path.basename(file, ".jsonl");
	return { nodes, sessionId, leaf, turn };
}

// The active branch, oldest first.
function activePath(nodes: Map<string, Node>, leaf: string | undefined): Node[] {
	const out: Node[] = [];
	const seen = new Set<string>();
	let id = leaf;
	while (id && !seen.has(id)) {
		seen.add(id);
		const n = nodes.get(id);
		if (!n) break;
		out.push(n);
		id = n.parent;
	}
	return out.reverse();
}

// ---------- task lists ----------

interface TodoItem {
	text: string;
	status: string;
}
interface TodoPhase {
	name: string;
	items: TodoItem[];
}

function items(list: unknown): TodoItem[] {
	const out: TodoItem[] = [];
	for (const x of Array.isArray(list) ? list : []) {
		if (typeof x === "string") out.push({ text: x, status: "pending" });
		else if (x && typeof x === "object") {
			const o = x as Obj;
			const text = str(o.content) ?? str(o.text) ?? str(o.task) ?? str(o.title);
			if (text) out.push({ text, status: str(o.status) ?? "pending" });
		}
	}
	return out;
}

const TODO_STATUS: Record<string, string> = { done: "completed", drop: "dropped", block: "blocked", start: "in_progress" };

// Replays the omp todo operations to get the newest list.
function ompTodos(nodes: Node[]): TodoPhase[] | undefined {
	let phases: TodoPhase[] | undefined;
	for (const n of nodes) {
		if (n.kind !== "todo") continue;
		for (const { input: a } of n.calls ?? []) {
			const op = str(a.op) ?? "";
			if (op === "init" && Array.isArray(a.list)) {
				phases = objects(a.list).map(p => ({ name: str(p.phase) ?? "", items: items(p.items) }));
			} else if (op === "append") {
				phases ??= [];
				const name = str(a.phase) ?? "";
				let p = phases.find(x => x.name === name);
				if (!p) {
					p = { name, items: [] };
					phases.push(p);
				}
				p.items.push(...items(a.items));
			} else if (TODO_STATUS[op]) {
				for (const p of phases ?? []) {
					if (a.phase && p.name !== a.phase) continue;
					for (const it of p.items) if (!a.task || it.text === a.task) it.status = TODO_STATUS[op];
				}
			} else if (op === "rm" && phases) {
				if (a.task) for (const p of phases) p.items = p.items.filter(it => it.text !== a.task);
				else if (a.phase) phases = phases.filter(p => p.name !== a.phase);
				else for (const p of phases) p.items = p.items.filter(it => it.status !== "completed" && it.status !== "dropped");
			}
		}
	}
	return phases;
}

interface ClaudeTasks {
	todos?: TodoItem[];
	tasks?: Map<string, TodoItem>;
}

function claudeTasks(nodes: Node[]): ClaudeTasks {
	const out: ClaudeTasks = {};
	let next = 1;
	for (const n of nodes) {
		if (n.kind !== "task") continue;
		for (const { name, input } of n.calls ?? []) {
			if (name === "TodoWrite" && Array.isArray(input.todos)) out.todos = items(input.todos);
			else if (name === "TaskCreate") {
				out.tasks ??= new Map();
				// Claude numbers tasks 1, 2, 3 in the order they are made.
				const text = [str(input.subject), str(input.description)].filter(Boolean).join(": ");
				out.tasks.set(String(next++), { text: text || "(no subject)", status: "pending" });
			} else if (name === "TaskUpdate" && input.taskId !== undefined) {
				out.tasks ??= new Map();
				const id = String(input.taskId);
				const t = out.tasks.get(id) ?? { text: `task ${id}`, status: "pending" };
				t.text = str(input.subject) ?? t.text;
				t.status = str(input.status) ?? t.status;
				if (t.status === "deleted") out.tasks.delete(id);
				else out.tasks.set(id, t);
			}
		}
	}
	return out;
}

const BOXES: Record<string, string> = { completed: "[x]", in_progress: "[>]", blocked: "[!]", dropped: "[-]" };
function itemLine(it: TodoItem): string {
	return `- ${BOXES[it.status] ?? "[ ]"} ${clean(it.text, 500)}`;
}

// ---------- project state ----------

async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const p = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		});
		const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
		return code === 0 ? out : undefined;
	} catch {
		return undefined;
	}
}

async function projectState(cwd: string): Promise<string> {
	const lines: string[] = [];
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside?.trim() !== "true") lines.push("- Not a git repo.");
	else {
		const [branch, status, log] = await Promise.all([
			git(cwd, ["branch", "--show-current"]),
			git(cwd, ["-c", "core.quotepath=off", "status", "--porcelain"]),
			git(cwd, ["log", `-${COMMITS}`, "--format=%h %s"]),
		]);
		lines.push(`- Branch: ${branch?.trim() || "(detached)"}`);
		const files = (status ?? "").split("\n").filter(Boolean).map(l => l.slice(3));
		if (!files.length) lines.push("- Changed files: none");
		else {
			lines.push("- Changed files:");
			for (const f of files.slice(0, FILES)) lines.push(`  - ${f}`);
			if (files.length > FILES) lines.push(`  - and ${files.length - FILES} more`);
		}
		const commits = (log ?? "").split("\n").filter(Boolean);
		if (commits.length) {
			lines.push("- Last commits:");
			for (const c of commits) lines.push(`  - ${c}`);
		}
	}
	const tracked = TRACKING.filter(f => fs.existsSync(path.join(cwd, f)));
	lines.push(`- Tracking files here: ${tracked.length ? tracked.join(", ") : "none"}`);
	return redact(lines.join("\n"));
}

// ---------- the handoff ----------

export async function buildHandoff(input: HandoffInput): Promise<Handoff> {
	const { from, to, file, cwd, sinceLeaf } = input;
	const parsed = await parse(from, file);
	const point: SessionPoint = { sessionId: parsed.sessionId, leaf: parsed.turn };
	const branch = activePath(parsed.nodes, parsed.leaf);

	const since = sinceLeaf ? branch.findIndex(n => n.id === sinceLeaf) : -1;
	const partial = since >= 0;
	// The newest compaction point: the tool keeps only its summary and the messages after it.
	let start = since + 1;
	let summary: string | undefined;
	for (let i = branch.length - 1; i >= start; i--) {
		const n = branch[i];
		if (n.kind === "compaction") {
			summary = n.text;
			let kept = i + 1;
			if (n.firstKept) {
				const k = branch.findIndex(x => x.id === n.firstKept);
				if (k >= 0 && k < i) kept = k;
			}
			start = Math.max(start, kept);
			break;
		}
		if (n.kind === "boundary") {
			start = Math.max(start, i + 1);
			break;
		}
	}
	const window = branch.slice(start);

	const summaries: string[] = [];
	if (summary?.trim()) summaries.push(clean(summary, SUMMARY_BYTES));
	for (const n of window) if (n.kind === "summary" && n.text?.trim()) summaries.push(clean(n.text, SUMMARY_BYTES / 2));

	const prompts = window.filter(n => n.kind === "prompt").map(n => clean(n.text ?? "", PROMPT_BYTES));
	const answers: string[] = [];
	{
		// Claude writes each block of one answer as its own entry; join them.
		const groups: { group?: string; text: string }[] = [];
		for (const n of window) {
			if (!n.text || (n.kind !== "answer" && n.kind !== "todo" && n.kind !== "task")) continue;
			const last = groups[groups.length - 1];
			if (last && n.group && last.group === n.group) last.text += `\n${n.text}`;
			else groups.push({ group: n.group, text: n.text });
		}
		for (const g of groups.slice(-ANSWERS)) answers.push(clean(g.text, ANSWER_BYTES));
	}

	const task: string[] = [];
	if (from === "omp") {
		const phases = ompTodos(branch);
		if (phases?.some(p => p.items.length)) {
			task.push("Todo list:");
			for (const p of phases) {
				if (!p.items.length) continue;
				if (p.name) task.push(`- ${clean(p.name, 200)}`);
				for (const it of p.items) task.push(`  ${itemLine(it)}`);
			}
		}
	} else {
		const t = claudeTasks(branch);
		if (t.todos?.length) {
			task.push("Todo list:");
			for (const it of t.todos) task.push(itemLine(it));
		}
		if (t.tasks?.size) {
			task.push("Tasks:");
			for (const [id, it] of t.tasks) task.push(`${itemLine(it)} (#${id})`);
		}
	}
	const lastPrompt = [...branch].reverse().find(n => n.kind === "prompt");
	if (lastPrompt?.text) task.push("", "Last user prompt:", "", quote(clean(lastPrompt.text, PROMPT_BYTES)));
	if (!task.length) task.push("No task list and no user prompt.");

	const state = await projectState(cwd);

	const head = [
		`# Handoff from ${NAMES[from]} to ${NAMES[to]}`,
		"",
		"## Source",
		"",
		`- Tool: ${NAMES[from]} (session ${parsed.sessionId})`,
		`- Cwd: ${redact(cwd)}`,
		`- Time: ${new Date().toISOString()}`,
		partial
			? `- This has only the part after the last switch away from ${NAMES[to]}; the earlier part is already in your own session.`
			: "- Tool calls, tool output and thinking are not included.",
		"",
		"## Summary",
		"",
		summaries.length ? summaries.join("\n\n---\n\n") : "No summary.",
		"",
	].join("\n");
	const tail = [
		"### Last answers",
		"",
		answers.length ? answers.map(quote).join("\n\n") : "No answers.",
		"",
		"## Open task",
		"",
		task.join("\n"),
		"",
		"## Project state",
		"",
		state,
		"",
	].join("\n");

	// Keep the last 20 prompts, then drop the oldest ones until the file fits.
	let kept = prompts.slice(-PROMPTS);
	const render = () =>
		[
			head,
			"## Conversation",
			"",
			`### User prompts (${kept.length} of ${prompts.length}, oldest first)`,
			"",
			kept.length ? kept.map(quote).join("\n\n") : "No prompts.",
			"",
			tail,
		].join("\n");
	let markdown = render();
	while (kept.length > 1 && Buffer.byteLength(markdown) > TOTAL_BYTES) {
		kept = kept.slice(1);
		markdown = render();
	}
	markdown = cut(redact(markdown), TOTAL_BYTES);
	return { markdown, point, partial };
}

function quote(text: string): string {
	return text
		.split("\n")
		.map(l => (l ? `> ${l}` : ">"))
		.join("\n");
}

// ---------- files and the first prompt ----------

export function writeHandoff(terminal: string, markdown: string): string {
	const dir = handoffDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const now = Date.now();
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".md")) continue;
		const p = path.join(dir, name);
		try {
			if (now - fs.statSync(p).mtimeMs > DAY_MS) fs.rmSync(p, { force: true });
		} catch {}
	}
	const file = path.join(dir, `${terminal}-${now}.md`);
	fs.writeFileSync(file, markdown, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return file;
}

// The whole first prompt: the instruction, then the handoff. The handoff goes in the prompt itself, not
// as a file to read: Claude asks the person to trust each folder outside its cwd, and a prompt stays in
// the session, so a later resume still has it. taskTitle goes first, so a new omp names itself from it.
export function firstPrompt(from: Tool, to: Tool, markdown: string, taskTitle?: string): string {
	const title = taskTitle?.trim();
	return `${title ? `${title}: ` : ""}This terminal moved from ${NAMES[from]} to ${NAMES[to]}. The handoff below has the conversation, the open task, and the project state. Read it, then tell me in 3 lines where the work is, and wait for my next message.\n\n${markdown}`;
}
