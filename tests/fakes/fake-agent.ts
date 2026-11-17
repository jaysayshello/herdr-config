// A stand-in for omp and Claude Code in tests/switch.test.ts and tests/autofix.test.ts, so no model runs.
// One program, compiled twice (`bun build --compile`) to binaries named omp and claude: `ps -o comm=`
// then reads omp or claude, where a shell script reads as bash. Its name picks the part it plays:
//   - writes its argv to $FAKE_AGENT_LOG (default ~/fake-agent.log, one JSON line),
//   - keeps a small valid session file (omp: ~/.omp/agent/sessions/...; claude:
//     $CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl), with --resume (and --fork-session) as the
//     real tool reads them, and adds the first prompt to it,
//   - writes its breadcrumb (claude: through the hook in the Claude config folder,
//     hooks/herdr-claude.sh, with a SessionStart input; directly when the hook wrote none),
//   - reports `state=$FAKE_AGENT_STATE` (default idle) with OSC 7501, and ends on SIGTERM; claude
//     reports `app=claude`, or `app=claude-code` (as Claude Code itself) when FAKE_AGENT_APP=claude-code;
//     with FAKE_AGENT_STATE_DIR set, it then reports working and each state written to <dir>/<terminal>,
//   - claude only: in a folder that the Claude config does not trust, shows the trust question instead.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const name = path.basename(process.execPath) === "claude" ? "claude" : "omp";
const terminal = process.env.HC_TERMINAL_ID ?? "";
const cwd = process.cwd();
const at = () => new Date().toISOString();

const opts: Record<string, string | true> = {};
const words: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === "--") {
		words.push(...argv.slice(i + 1));
		break;
	}
	if (a === "--fork-session") opts[a] = true;
	else if (a.startsWith("-")) opts[a] = argv[++i] ?? "";
	else words.push(a);
}
const prompt = words.join(" ");
const resume = typeof opts["--resume"] === "string" ? opts["--resume"] : undefined;

function createdMs(): string {
	const r = spawnSync("hc", ["get", terminal, "--json"], { encoding: "utf8" });
	return String(JSON.parse(r.stdout || "{}").created_ms ?? "");
}

function writeCrumb(dir: string, file: string) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, terminal), `${createdMs()}\n${file}\n`);
}

function ompSession(): string {
	let file = resume;
	const lines: string[] = [];
	let parent: string | null = null;
	if (file) {
		for (const l of fs.readFileSync(file, "utf8").split("\n")) {
			const id = l.trim() ? JSON.parse(l).id : undefined;
			if (id && !/^[0-9a-f-]{36}$/.test(id)) parent = id;
		}
	} else {
		const id = crypto.randomUUID();
		const dir = path.join(os.homedir(), ".omp/agent/sessions", `-${fs.realpathSync(cwd).slice(1).replaceAll("/", "-")}--`);
		fs.mkdirSync(dir, { recursive: true });
		file = path.join(dir, `${at().replace(/[:.]/g, "-")}_${id}.jsonl`);
		lines.push(JSON.stringify({ type: "title", v: 1, title: "", updatedAt: at() }), JSON.stringify({ type: "session", version: 3, id, timestamp: at(), cwd }));
	}
	const add = (role: string, text: string) => {
		const id = crypto.randomBytes(4).toString("hex");
		lines.push(JSON.stringify({ type: "message", id, parentId: parent, timestamp: at(), message: { role, content: [{ type: "text", text }] } }));
		parent = id;
	};
	add("user", prompt || `fake omp task in ${terminal}`);
	add("assistant", `fake omp answer in ${terminal}`);
	fs.appendFileSync(file, `${lines.join("\n")}\n`);
	writeCrumb(path.join(os.homedir(), ".local/state/omp-herdr-resume"), file);
	return file;
}

function claudeSession(): string {
	const config = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
	const projects = path.join(config, "projects");
	let id: string = crypto.randomUUID();
	let file = path.join(projects, fs.realpathSync(cwd).replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
	let parent: string | null = null;
	if (resume) {
		const old = fs.readdirSync(projects).map(d => path.join(projects, d, `${resume}.jsonl`)).find(f => fs.existsSync(f));
		if (!old) throw new Error(`fake claude: no session ${resume}`);
		const text = fs.readFileSync(old, "utf8");
		for (const l of text.split("\n")) if (l.trim()) parent = JSON.parse(l).uuid ?? parent;
		if (opts["--fork-session"]) {
			file = path.join(path.dirname(old), `${id}.jsonl`);
			fs.writeFileSync(file, text);
		} else {
			id = resume;
			file = old;
		}
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const add = (type: string, content: unknown) => {
		const uuid = crypto.randomUUID();
		const e = { type, uuid, parentUuid: parent, isSidechain: false, sessionId: id, cwd, timestamp: at(), message: { role: type, content } };
		fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
		parent = uuid;
	};
	add("user", prompt || `fake claude task in ${terminal}`);
	add("assistant", [{ type: "text", text: `fake claude answer in ${terminal}` }]);

	const dir = path.join(os.homedir(), ".local/state/claude-herdr-resume");
	const hook = path.join(config, "hooks/herdr-claude.sh");
	if (fs.existsSync(hook)) {
		const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: id, transcript_path: file, cwd, source: resume ? "resume" : "startup" });
		spawnSync("sh", [hook], { input, stdio: ["pipe", "ignore", "ignore"] });
	}
	let line2 = "";
	try {
		line2 = fs.readFileSync(path.join(dir, terminal), "utf8").split("\n")[1];
	} catch {}
	if (line2 !== file) writeCrumb(dir, file);
	return file;
}

// As the real Claude: a folder is trusted when it, or a folder above it, has
// projects["<real path>"].hasTrustDialogAccepted in the global config ($CLAUDE_CONFIG_DIR/.claude.json).
function trusted(): boolean {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	let projects: Record<string, { hasTrustDialogAccepted?: boolean }> = {};
	try {
		projects = JSON.parse(fs.readFileSync(dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json"), "utf8")).projects ?? {};
	} catch {}
	for (let d = fs.realpathSync(cwd); ; d = path.dirname(d)) {
		if (projects[d]?.hasTrustDialogAccepted === true) return true;
		if (d === path.dirname(d)) return false;
	}
}

// The real Claude asks once per folder if it can trust it, and runs no hook until the answer.
if (name === "claude" && !trusted()) {
	process.stdout.write("Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n");
	for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => process.exit(0));
	setInterval(() => {}, 1 << 30);
} else {
	const session = name === "omp" ? ompSession() : claudeSession();
	fs.appendFileSync(process.env.FAKE_AGENT_LOG ?? path.join(os.homedir(), "fake-agent.log"), `${JSON.stringify({ name, terminal, pid: process.pid, cwd, argv, session })}\n`);
	if (name === "omp") process.stdout.write(`\x1b]2;${process.env.FAKE_AGENT_TITLE ?? "π > FAKE: switch test task"}\x07`);
	const app = name === "claude" && process.env.FAKE_AGENT_APP === "claude-code" ? "claude-code" : name;
	process.stdout.write(`\x1b]7501;state=${process.env.FAKE_AGENT_STATE ?? "idle"}:app=${app}\x07fake ${name} ready\n`);
	// tests/autofix.test.ts: from working on, the state written to $FAKE_AGENT_STATE_DIR/<terminal>.
	const stateDir = process.env.FAKE_AGENT_STATE_DIR;
	if (stateDir) {
		const file = path.join(stateDir, terminal);
		fs.mkdirSync(stateDir, { recursive: true });
		fs.writeFileSync(file, "working");
		let last = "";
		setInterval(() => {
			const s = fs.readFileSync(file, "utf8").trim();
			if (s !== last) process.stdout.write(`\x1b]7501;state=${s}:app=${app}\x07`);
			last = s;
		}, 100);
	}
	for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
		process.on(sig, () => {
			// The real omp adds an entry when it ends; a switch back must still see the session where it left it.
			if (name === "omp") {
				const lastId = fs.readFileSync(session, "utf8").trim().split("\n").map(l => JSON.parse(l).id).filter(Boolean).at(-1);
				const exit = { type: "custom", customType: "session_exit", id: crypto.randomBytes(4).toString("hex"), parentId: lastId ?? null, timestamp: at(), data: { reason: sig.toLowerCase(), kind: "signal" } };
				fs.appendFileSync(session, `${JSON.stringify(exit)}\n`);
			}
			process.exit(0);
		});
	setInterval(() => {}, 1 << 30);
}
