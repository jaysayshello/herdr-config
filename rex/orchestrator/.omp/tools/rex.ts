// The Rex orchestrator's tools: the same jobs as the Herdr orchestrator's herdr_* tools, on Rex.
// A Herdr space is a Rex session, a tab is a window, and a terminal is a terminal block. The model
// sees each terminal as the last 6 characters of its block id (`d17538`); the tools take that or
// the full id. omp reports its state to Rex itself (program status, OSC 7501). Rex has no turn
// counter, so a terminal's `turn` is the time (ms) of the newest prompt in its omp session file,
// which rex-resume.ts names in a breadcrumb. All Rex calls go through the `rex` CLI; one Lua
// script (`rex do -e`) reads every session in about 50 ms.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CustomToolAPI, CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

export const REX = process.env.REX_BIN_DIR ? path.join(process.env.REX_BIN_DIR, "rex") : "rex";
export const SELF = process.env.REX_BLOCK;
const CRUMBS = path.join(os.homedir(), ".local/state/omp-rex-resume");
const SHELL = "com.superlogical.terminal.shell";
// The script of a worker block: start omp with the task file once, then stay as a login shell.
export const WRAPPER = '[ -f "$1" ] && { t=$(cat "$1"); rm -f "$1"; omp "$t"; }; exec "${SHELL:-/bin/zsh}" -li';
// Goes before the text of an interrupting send: the stop can leave a repo half way through a step.
const STOPPED_NOTE =
	"Your last turn was stopped on purpose, so that you get the context below. Before you continue, examine the state that the stop left: a git stash that was not popped, a half-done commit, merge or rebase, a branch switch, a command or background job that still runs, or a half-written file. Put the repo back in a clean state first. Then continue the task with this context:";

// Reads every session, window and terminal block, with each terminal's root program status,
// foreground process and title. A script must attach to a session before it can call its blocks.
const SNAPSHOT_LUA = `
local T = "com.superlogical.terminal"
local list, err = rex.call("session.list", {})
if not list then error(err, 0) end
local only = rex.args.session
local out = {}
for _, s in ipairs(list.sessions or {}) do
  if only == nil or only == s.session_id then
    rex.session.attach{ session_id = s.session_id }
    local view = rex.session.view{ session_id = s.session_id } or {}
    local sess = { id = s.session_id, name = s.label, windows = {} }
    for _, w in ipairs(view.windows or {}) do
      local win = { id = w.window_id, name = w.label, terminals = {} }
      for _, layer in ipairs(w.layers or {}) do
        for _, b in ipairs(layer.blocks or {}) do
          if b.creator_name == T and (rex.args.block == nil or rex.args.block == b.block_id) then
            local a = { session_id = s.session_id, block_id = b.block_id }
            local st = rex.block.call(T, "program_status", a) or {}
            local pr = rex.block.call(T, "process", a) or {}
            local ti = rex.block.call(T, "title", a) or {}
            local root
            for _, r in ipairs(st.records or {}) do if r.id == nil then root = r break end end
            if root == nil and st.records then root = st.records[1] end
            table.insert(win.terminals, { id = b.block_id, label = b.label, status = root, fg = pr.foreground, title = ti.title })
          end
        end
      end
      table.insert(sess.windows, win)
    end
    table.insert(out, sess)
  end
end
return { sessions = out }
`;

// Creates a terminal block that runs `command`, as a new session, a new window of a session, or a
// split to the right of a block.
const CREATE_LUA = `
local a = rex.args
local block = { block = { flavor = "${SHELL}", options = { cwd = a.cwd, command = a.command, shell = "none" } } }
if a.kind == "session" then
  local r, err = rex.call("session.create", { label = a.name, initial_windows = { { window_label = a.window, layout = block } } })
  if not r then error(err, 0) end
  local w = r.initial_windows[1]
  return { session = r.session_id, window = w.window_id, block = w.block_ids[1] }
end
rex.session.attach{ session_id = a.session }
if a.kind == "window" then
  local r, err = rex.session.new_window{ session_id = a.session, window_label = a.window, layout = block, focus = false }
  if not r then error(err, 0) end
  return { session = a.session, window = r.window_id, block = r.block_ids[1] }
end
local r, err = rex.session.new_split{ session_id = a.session, anchor_id = a.anchor, direction = "horizontal", side = "after", focus = false, layout = block }
if not r then error(err, 0) end
return { session = a.session, block = r.block_ids[1] }
`;

interface RawTerm {
	id: string;
	label?: string;
	status?: { state?: string; app?: string; effective_app?: string; kind?: string; msg?: string } | null;
	fg?: { name?: string; pid?: number; cwd?: string } | null;
	title?: string;
}
interface RawSession {
	id: string;
	name: string;
	windows?: { id: string; name: string; terminals?: RawTerm[] }[];
}

// One terminal block, with where it sits.
export interface Term {
	block: string;
	short: string;
	session: string;
	sessionName: string;
	window: string;
	windowName: string;
	app: string | null;
	state: string | null;
	kind: string | null;
	msg: string | null;
	title: string;
	cwd: string | null;
	fgName: string | null;
	fgPid: number | null;
}
export interface Space {
	id: string;
	name: string;
	windows: { id: string; name: string; terminals: Term[] }[];
}

// Lua turns an empty list into {}, so a list can come back as an object.
const list = <T>(x: T[] | Record<string, never> | undefined | null): T[] => (Array.isArray(x) ? x : []);
export const shortId = (block: string) => block.replace(/^block:/, "").slice(-6);
export const uuid = (id: string) => id.replace(/^(block|session|window):/, "");
// Opens the terminal in the Rex app; rex-focus.sh handles the scheme.
export const focusLink = (t: Pick<Term, "session" | "block">) => `rex-focus://${uuid(t.session)}/${uuid(t.block)}`;

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

// The session file of an omp terminal: the breadcrumb of rex-resume.ts.
export function crumbFile(block: string): string | undefined {
	try {
		const file = fs.readFileSync(path.join(CRUMBS, uuid(block)), "utf8").split("\n")[0];
		if (file && fs.existsSync(file)) return file;
	} catch {}
	return undefined;
}

// The time (ms) of the newest user prompt in an omp session file, read backwards in parts; 0 if
// it has none. A session file can be large, so it reads at most 16 MiB from the end.
export function lastPromptMs(file: string | undefined): number {
	if (!file) return 0;
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return 0;
	}
	try {
		const size = fs.fstatSync(fd).size;
		const CHUNK = 512 * 1024;
		let end = size;
		let carry = "";
		while (end > 0 && size - end < 16 * 1024 * 1024) {
			const start = Math.max(0, end - CHUNK);
			const buf = Buffer.alloc(end - start);
			fs.readSync(fd, buf, 0, buf.length, start);
			const text = buf.toString("utf8") + carry;
			const lines = text.split("\n");
			// The first line can start mid-entry; it joins the part read next.
			carry = start > 0 ? (lines.shift() ?? "") : "";
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i];
				if (!line.includes('"role":"user"')) continue;
				try {
					const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: { role?: string } };
					if (entry.type === "message" && entry.message?.role === "user" && entry.timestamp) return Date.parse(entry.timestamp);
				} catch {}
			}
			end = start;
		}
		return 0;
	} finally {
		fs.closeSync(fd);
	}
}

// The Rex calls the tools below make. rex-watch.ts, rex-pr-autofix.ts and rex-reload.ts use
// them too.
export function rexClient(exec: CustomToolAPI["exec"]) {
	async function run(args: string[], signal?: AbortSignal): Promise<string> {
		const r = await exec(REX, args, { signal });
		if (r.killed) throw new Error("rex was cancelled");
		if (r.code !== 0) throw new Error((r.stderr || r.stdout || `rex ${args[0]} exited with code ${r.code}`).trim());
		return r.stdout;
	}
	async function lua<T>(code: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		return JSON.parse(await run(["do", "-e", code, "--json", "--args", JSON.stringify(args)], signal)) as T;
	}

	function toSpaces(raw: RawSession[]): Space[] {
		return raw.map(s => ({
			id: s.id,
			name: s.name,
			windows: list(s.windows).map(w => ({
				id: w.id,
				name: w.name,
				terminals: list(w.terminals).map(t => ({
					block: t.id,
					short: shortId(t.id),
					session: s.id,
					sessionName: s.name,
					window: w.id,
					windowName: w.name,
					app: t.status?.effective_app ?? t.status?.app ?? null,
					state: t.status?.state ?? null,
					kind: t.status?.kind ?? null,
					msg: t.status?.msg ?? null,
					title: t.title ?? "",
					cwd: t.fg?.cwd ?? null,
					fgName: t.fg?.name ?? null,
					fgPid: t.fg?.pid ?? null,
				})),
			})),
		}));
	}

	// Every session; or one session, or one block in it.
	async function snapshot(scope: { session?: string; block?: string } = {}, signal?: AbortSignal): Promise<Space[]> {
		const out = await lua<{ sessions?: RawSession[] }>(SNAPSHOT_LUA, scope, signal);
		return toSpaces(list(out.sessions));
	}
	const terms = (spaces: Space[]) => spaces.flatMap(s => s.windows.flatMap(w => w.terminals));

	// The orchestrator's own session is left out of the list the model sees.
	async function view(signal?: AbortSignal) {
		const spaces = await snapshot({}, signal);
		const selfSpace = SELF ? spaces.find(s => terms([s]).some(t => t.block === SELF)) : undefined;
		return { spaces, selfSpace };
	}

	// A terminal by full block id or by its last characters.
	function find(spaces: Space[], terminal: string): Term {
		const id = terminal.trim();
		const all = terms(spaces);
		const exact = all.find(t => t.block === id || uuid(t.block) === id);
		if (exact) return exact;
		const hits = all.filter(t => id.length >= 4 && uuid(t.block).endsWith(id));
		if (hits.length === 1) return hits[0];
		if (hits.length > 1) throw new Error(`Terminal ${id} matches ${hits.length} terminals; use the full block id`);
		throw new Error(`No Rex terminal ${id}`);
	}
	const resolve = async (terminal: string, signal?: AbortSignal) => find(await snapshot({}, signal), terminal);
	// The same terminal again, fresh; it throws once the block is gone.
	async function get(t: Pick<Term, "session" | "block">, signal?: AbortSignal): Promise<Term> {
		const [found] = terms(await snapshot({ session: t.session, block: t.block }, signal));
		if (!found) throw new Error(`Rex terminal ${shortId(t.block)} is gone`);
		return found;
	}

	// The omp session file of a terminal: the breadcrumb, else the main session file omp holds
	// open (subagent files sit one folder deeper). In a worker block the foreground is the
	// rex-omp sh, with omp as its child.
	async function sessionFile(t: Term): Promise<string | undefined> {
		const crumb = crumbFile(t.block);
		if (crumb) return crumb;
		if (!t.fgPid) return undefined;
		const pid = t.fgName === "omp" ? String(t.fgPid) : (await exec("pgrep", ["-P", String(t.fgPid), "-x", "omp"])).stdout.trim().split("\n")[0];
		if (!pid) return undefined;
		const out = (await exec("lsof", ["-p", pid, "-Fn"])).stdout;
		return out
			.split("\n")
			.filter(l => l.startsWith("n") && l.endsWith(".jsonl"))
			.map(l => l.slice(1))
			.find(f => path.basename(path.dirname(f)).startsWith("-"));
	}
	const turn = async (t: Term) => lastPromptMs(await sessionFile(t));

	// Waits up to 45 s for omp on a new terminal to take its first prompt.
	async function waitStarted(t: Pick<Term, "session" | "block">, signal?: AbortSignal) {
		const deadline = Date.now() + 45_000;
		for (;;) {
			const info = await get(t, signal).catch(() => undefined);
			const state = info?.state;
			if (info?.app === "omp" && (state === "working" || (await turn(info)) > 0)) return;
			if (Date.now() >= deadline)
				throw new Error(
					`omp on ${shortId(t.block)} did not start the task in 45 s (last state ${state ?? "unknown"}). Do not start it again; read the terminal with rex_read.`,
				);
			await sleep(500, signal);
		}
	}

	// The command of a new worker block. The task goes through a file, so no quoting can break it.
	// The script runs in an interactive login shell, so omp gets the PATH and the rest of the
	// environment a terminal has (~/.zshrc puts omp on the PATH). When omp ends, the block keeps
	// a login shell. When Rex restores the session, it keeps the block id but starts a plain
	// shell without this command, and that shell's first prompt resumes omp from the
	// rex-resume.ts breadcrumb (the zsh hook), unless omp was quit. rex-reload.ts knows the block
	// by the `rex-omp` name ($0) of the script.
	function startCommand(task: string): string[] {
		const file = path.join(os.tmpdir(), `rex-task-${crypto.randomUUID()}`);
		fs.writeFileSync(file, task, { mode: 0o600 });
		return [process.env.SHELL || "/bin/zsh", "-lic", WRAPPER, "rex-omp", file];
	}

	async function create(args: Record<string, unknown>, signal?: AbortSignal) {
		return lua<{ session: string; window?: string; block: string }>(CREATE_LUA, args, signal);
	}

	// Splits the pane of terminal `beside` to the right and starts omp there, in the same folder,
	// with task as its first prompt, then waits for omp to take it.
	async function newAgent(beside: string, task: string, signal?: AbortSignal) {
		const { spaces } = await view(signal);
		const t = find(spaces, beside);
		if (t.block === SELF) throw new Error("Refusing to split the orchestrator's own pane");
		const made = await create({ kind: "split", session: t.session, anchor: t.block, cwd: t.cwd ?? os.homedir(), command: startCommand(task) }, signal);
		const created = { session: t.session, block: made.block };
		await waitStarted(created, signal);
		return { space: t.sessionName, space_id: t.session, terminal: shortId(made.block), turn: 0, link: focusLink(created) };
	}

	// A new session named name, with one window, that starts omp in folder with task, then waits
	// for omp to take it.
	async function newSpace(name: string, folder: string, task: string, signal?: AbortSignal) {
		const made = await create({ kind: "session", name, window: "main", cwd: folder, command: startCommand(task) }, signal);
		await waitStarted(made, signal);
		return { space: name, space_id: made.session, terminal: shortId(made.block), turn: 0, link: focusLink(made) };
	}

	// Starts omp in folder with task as its first prompt, in a new window named tabName of the
	// session named spaceName, which it makes if it is missing. Rex does not show it, so the view
	// the user has stays as it is. It does not wait for omp.
	async function newTab(spaceName: string, tabName: string, folder: string, task: string, signal?: AbortSignal) {
		const { spaces } = await view(signal);
		const space = spaces.find(s => s.name === spaceName);
		const command = startCommand(task);
		const made = space
			? await create({ kind: "window", session: space.id, window: tabName, cwd: folder, command }, signal)
			: await create({ kind: "session", name: spaceName, window: tabName, cwd: folder, command }, signal);
		return { space: made.session, tab: made.window!, block: made.block, terminal: shortId(made.block) };
	}

	// Closes window `tab` of session `space` and ends its terminals, but only if it still holds
	// block `block`. Returns false if that window is gone.
	async function closeTab(space: string, tab: string, block: string, signal?: AbortSignal) {
		const spaces = await snapshot({ session: space }, signal).catch(() => [] as Space[]);
		const found = spaces[0]?.windows.find(w => w.id === tab && w.terminals.some(t => t.block === block));
		if (!found) return false;
		await run(["window", "close", "-s", space, tab], signal);
		return true;
	}

	// Types text into omp as one bracketed paste, then presses Enter, as a paste and Enter by hand.
	async function type(t: Term, text: string, signal?: AbortSignal) {
		const clean = text.replaceAll("\u001b[201~", "");
		await run(["send", "-s", t.session, "-b", t.block, `\u001b[200~${clean}\u001b[201~`], signal);
		await sleep(200, signal);
		await run(["send-key", "-s", t.session, "-b", t.block, "enter"], signal);
	}
	const key = (t: Term, k: string, signal?: AbortSignal) => run(["send-key", "-s", t.session, "-b", t.block, k], signal);

	// The screen and scrollback, the last `lines` lines.
	async function read(t: Term, lines: number, signal?: AbortSignal) {
		const text = await run(["capture", "-s", t.session, "-b", t.block, "--trim", "--unwrap"], signal);
		return text.split("\n").slice(-Math.max(1, lines)).join("\n");
	}

	return { run, lua, snapshot, view, find, resolve, get, terms, sessionFile, turn, waitStarted, newAgent, newSpace, newTab, closeTab, type, key, read };
}

function result<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

const factory: CustomToolFactory = (pi: CustomToolAPI) => {
	const rex = rexClient(pi.exec);

	function notInRex() {
		if (!SELF) throw new Error("This omp does not run in a Rex terminal (REX_BLOCK is not set)");
	}

	// Esc stops an omp turn. omp reports working until the abort is done, and a dialog that
	// appears instead must not get the text, so wait for idle or done.
	async function stop(t: Term, signal?: AbortSignal): Promise<Term> {
		await rex.key(t, "escape", signal);
		const deadline = Date.now() + 30_000;
		for (;;) {
			const info = await rex.get(t, signal);
			if (info.state === "idle" || info.state === "done") return info;
			if (info.state === "blocked")
				throw new Error(`Terminal ${t.short} shows a dialog after the interrupt; nothing was sent. Tell the user to look at it.`);
			if (Date.now() >= deadline)
				throw new Error(`Terminal ${t.short} is still ${info.state ?? "unknown"} 30 s after the interrupt; nothing was sent. Read it with rex_read.`);
			await sleep(500, signal);
		}
	}

	// Only a new prompt in the session file or a change to working proves delivery. Returns the
	// turn before the send: rex_watch waits for a turn after it, and a fast worker can be done
	// again before the watch looks.
	async function deliver(t: Term, text: string, signal?: AbortSignal): Promise<number> {
		const before = await rex.turn(t);
		await rex.type(t, text, signal);
		let last = t;
		const deadline = Date.now() + 15_000;
		for (;;) {
			await sleep(500, signal);
			last = await rex.get(t, signal);
			if (last.state === "working" || (await rex.turn(last)) > before) return before;
			if (Date.now() >= deadline) break;
		}
		throw new Error(
			`Prompt did not start on ${t.short}: last state ${last.state ?? "unknown"}. Do not send again, because the text can still arrive and run twice. Start the task with rex_new_agent beside ${t.short}.`,
		);
	}

	return [
		{
			name: "rex_spaces",
			label: "Rex Spaces",
			description:
				"List the open Rex sessions (spaces) except the orchestrator's own, their windows (tabs), and each terminal's app, state (idle|working|done|blocked|error, null for plain shells), turn, title, and cwd. Call this first to find the space that matches the user's request; match on space name and terminal cwd.",
			loadMode: "essential",
			parameters: pi.zod.object({}),
			async execute(_id, _params, _onUpdate, _ctx, signal) {
				notInRex();
				const { spaces, selfSpace } = await rex.view(signal);
				const out = await Promise.all(
					spaces
						.filter(s => s !== selfSpace)
						.map(async s => ({
							id: s.id,
							name: s.name,
							tabs: await Promise.all(
								s.windows.map(async w => ({
									id: w.id,
									name: w.name,
									terminals: await Promise.all(
										w.terminals.map(async t => ({
											terminal: t.short,
											app: t.app,
											state: t.state,
											turn: t.app === "omp" ? await rex.turn(t) : null,
											title: t.title || null,
											cwd: t.cwd,
										})),
									),
								})),
							),
						})),
				);
				const me = SELF ? shortId(SELF) : null;
				return result({ self: { terminal: me, space: selfSpace?.id ?? null }, spaces: out });
			},
		},
		{
			name: "rex_send",
			label: "Rex Send",
			description:
				"Send a task as a prompt to an omp session in another Rex terminal. Use this when rex_spaces shows a matching space with an omp terminal in state idle or done. Refuses other apps, busy terminals, and the orchestrator's own terminal. With interrupt: true it also takes a working terminal: only for a clear correction of the task that terminal runs now (new or related work goes to rex_new_agent), it stops the turn (Esc), waits until the terminal is idle or done, and sends the text after a note that tells the worker its turn was stopped and to clean up first. It never sends to a blocked terminal, with or without interrupt: a key press can answer its dialog. Waits up to 15 s for the prompt to start and throws a 'Prompt did not start' error if it does not. Returns the terminal and its turn for rex_watch.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				text: pi.zod.string(),
				interrupt: pi.zod.boolean().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				let t = await rex.resolve(params.terminal, signal);
				if (t.block === SELF) throw new Error("Refusing to send to the orchestrator's own terminal");
				if (t.app !== "omp") throw new Error(`Terminal ${t.short} runs ${t.fgName ?? "no agent"}, not omp`);
				if (t.state === "blocked")
					throw new Error(`Terminal ${t.short} is blocked on a dialog; never send or interrupt there, tell the user to look at it`);
				const interrupted = params.interrupt === true && t.state === "working";
				if (interrupted) t = await stop(t, signal);
				else if (t.state !== "idle" && t.state !== "done")
					throw new Error(
						`Terminal ${t.short} is ${t.state ?? "unknown"}; send only when idle or done, pass interrupt: true only to correct its current task, or use rex_new_agent`,
					);
				const text = interrupted ? `${STOPPED_NOTE}\n\n${params.text}` : params.text;
				return result({ terminal: t.short, turn: await deliver(t, text, signal), interrupted });
			},
		},
		{
			name: "rex_new_agent",
			label: "Rex New Agent",
			description:
				"Start another omp session beside an existing one, in the same Rex session and window, as Ctrl+E does (split right). The pane of terminal `beside` splits, and omp starts there in the same folder with task as its first prompt (a real user prompt, so the `orchestrate` keyword works). The existing session keeps running and stays visible. Use this for every new session in an open space: another agent, a busy space, or a failed send. Waits up to 45 s for the first turn to start. Returns the new terminal, its space_id and link, and turn 0 for rex_watch.",
			loadMode: "essential",
			parameters: pi.zod.object({
				beside: pi.zod.string(),
				task: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				return result(await rex.newAgent(params.beside, params.task, signal));
			},
		},
		{
			name: "rex_new_space",
			label: "Rex New Space",
			description:
				"Create a temporary Rex session and start omp there with task as its first prompt. Use this only when no open space matches the request. name must match ^[a-z0-9-]+$; the tool adds the prefix tmp-. folder defaults to /tmp/rex-orchestrator/<name> and is created if missing. Waits up to 45 s for the first turn to start. Returns the new terminal, its space_id and link, and turn 0 for rex_watch.",
			loadMode: "essential",
			parameters: pi.zod.object({
				name: pi.zod.string(),
				folder: pi.zod.string().optional(),
				task: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				if (!/^[a-z0-9-]+$/.test(params.name)) throw new Error(`Space name must match ^[a-z0-9-]+$: ${params.name}`);
				const name = params.name.startsWith("tmp-") ? params.name : `tmp-${params.name}`;
				const folder = params.folder ?? `/tmp/rex-orchestrator/${name}`;
				fs.mkdirSync(folder, { recursive: true });
				return result(await rex.newSpace(name, folder, params.task, signal));
			},
		},
		{
			name: "rex_wait",
			label: "Rex Wait",
			description:
				"Block until the omp session in a terminal starts a turn after after_turn and then stops working, or until timeout_s (default 600) passes. Only the rex-watcher fallback uses this; the orchestrator uses rex_watch. started false means no turn began within 60 s, so the prompt did not start. timed_out true means it is still working. Also returns the terminal's space name, space_id and link.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				after_turn: pi.zod.number(),
				timeout_s: pi.zod.number().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				const deadline = Date.now() + (params.timeout_s ?? 600) * 1000;
				const startDeadline = Math.min(deadline, Date.now() + 60_000);
				let t = await rex.resolve(params.terminal, signal);
				const began = async () => t.state === "working" || (await rex.turn(t)) > params.after_turn;

				// A fresh omp reports idle at its start before it takes the task.
				while (!(await began()) && Date.now() < startDeadline) {
					await sleep(1000, signal);
					t = await rex.get(t, signal);
				}
				let didBegin = await began();
				for (;;) {
					while (t.state === "working" && Date.now() < deadline) {
						await sleep(1000, signal);
						t = await rex.get(t, signal);
					}
					if (t.state === "working" || Date.now() >= deadline) break;
					// A short stop between a turn end and a background-job wake.
					await sleep(5000, signal);
					t = await rex.get(t, signal);
					if (t.state !== "working") break;
					didBegin = true;
				}
				didBegin ||= await began();
				return result({
					terminal: t.short,
					space: t.sessionName,
					space_id: t.session,
					link: focusLink(t),
					state: t.state,
					turn: await rex.turn(t),
					started: didBegin,
					timed_out: t.state === "working",
				});
			},
		},
		{
			name: "rex_read",
			label: "Rex Read",
			description:
				"Read the last lines (default 80) of a Rex terminal's screen and scrollback. Use this to check what a worker did, or why it is blocked or in error.",
			loadMode: "essential",
			parameters: pi.zod.object({
				terminal: pi.zod.string(),
				lines: pi.zod.number().optional(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				const t = await rex.resolve(params.terminal, signal);
				const text = await rex.read(t, params.lines ?? 80, signal);
				return { content: [{ type: "text" as const, text }], details: { terminal: t.short } };
			},
		},
		{
			name: "rex_close_space",
			label: "Rex Close Space",
			description:
				"Close a temporary Rex session by id when its work is finished. Refuses any session whose name does not start with tmp-.",
			loadMode: "essential",
			parameters: pi.zod.object({
				space: pi.zod.string(),
			}),
			async execute(_id, params, _onUpdate, _ctx, signal) {
				notInRex();
				const id = params.space.startsWith("session:") ? params.space : `session:${params.space}`;
				const space = (await rex.snapshot({}, signal)).find(s => s.id === id);
				if (!space) throw new Error(`No Rex session with id ${params.space}`);
				if (!space.name.startsWith("tmp-")) throw new Error(`Refusing to close ${space.name}: only tmp- sessions can be closed`);
				await rex.run(["kill", id], signal);
				return result({ space: id, name: space.name, closed: true });
			},
		},
	];
};

export default factory;
