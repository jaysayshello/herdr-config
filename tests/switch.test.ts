// Integration test of /claude and /omp (orchestrator/.omp/extensions/herdr-switch.ts) on a TEST Herdr
// only: its own window and core (bench/lib/instance.ts), with HOME in a sandbox (tests/run.sh, as
// bench/run.sh does). The extension runs outside omp with the fake `pi` of bench/lib/orch.ts. omp and
// claude are one compiled fake (tests/fakes/fake-agent.ts), so no model runs. Run: tests/run.sh
import { assertNotReal, BENCH_ROOT } from "../bench/lib/guard.ts";
import { fakePi, orchFile, type FakePi } from "../bench/lib/orch.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hc, Instance, startCore, stopAll } from "../bench/lib/instance.ts";
import { run, waitFor } from "../bench/lib/proc.ts";
import { prepareSandbox, type Sandbox } from "../bench/lib/sandbox.ts";

const repo = path.resolve(import.meta.dir, "..");
// The only programs the extension may start here.
const ALLOWED: Record<string, true> = { hc: true, "herdr-app": true, ps: true, pgrep: true, lsof: true, env: true, dscl: true, getent: true };
const LONG = 240_000;

interface HcGet {
	argv?: string[];
	pid?: number;
	created_ms?: number;
	cwd?: string;
	title?: string;
	foreground?: { pid?: number; cwd?: string } | null;
	status?: { app?: string; state?: string } | null;
	labels?: Record<string, string>;
}
interface Launch {
	name: "omp" | "claude";
	terminal: string;
	pid: number;
	cwd: string;
	argv: string[];
	session: string;
}
interface Command {
	handler(args: string, ctx: unknown): Promise<void>;
}

let sb: Sandbox;
let instance: Instance;
let pi: FakePi;
let folder: string;
let claudeDir: string;
let state: string;
const spaceIds: string[] = [];
const notes: { m: string; kind: string }[] = [];
const forgot: string[] = [];
const ctx = { ui: { notify: (m: string, kind: string) => notes.push({ m, kind }), setWidget() {}, setStatus() {} }, hasUI: true };
// The terminals: a: `zsh -l` with omp typed at its prompt; b: the `"$@"; exec "$0" -li` wrapper of
// space.new; c: an `exec omp` pane (the split path); busy: a working omp; orch: the stand-in for this
// orchestrator; sibling: an idle omp in the orchestrator's own space.
const T: Record<"a" | "b" | "c" | "busy" | "orch" | "sibling", string> = { a: "", b: "", c: "", busy: "", orch: "", sibling: "" };
let c2 = "";
let mod: { CLAUDE_CRUMBS: string; SWITCH_DIR: string; TRUST_BACKUP: string; default(p: FakePi): void };
let claudeJson: string;
// The Claude config before the first switch: other keys and another folder, which must not change.
const ELSEWHERE = "/elsewhere/not-this-folder";
const firstConfig = JSON.stringify({ numStartups: 7, projects: { [ELSEWHERE]: { allowedTools: ["Bash"], hasTrustDialogAccepted: false } } }, null, 2);
const config = () => JSON.parse(fs.readFileSync(claudeJson, "utf8"));
let reload: {
	toolPid(exec: unknown, fg: number, name: string, root?: number): Promise<number | undefined>;
	shellStays(argv: string[]): boolean;
	OMP_CRUMBS: string;
};
const firstOmp: Record<string, Launch> = {};
const firstClaude: Record<string, Launch> = {};

const get = (t: string) => hc<HcGet>(sb, ["get", t]);
const exec = (cmd: string, args: string[]) => pi.exec(cmd, args);
const launches = (): Launch[] =>
	fs
		.readFileSync(path.join(sb.home, "fake-agent.log"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l));
const last = (name: string, terminal: string) => launches().findLast(l => l.name === name && l.terminal === terminal);
const report = () => pi.sent.findLast(s => s.message.customType === "herdr-switch")?.message.content ?? "";
const crumbLines = (dir: string, t: string) => fs.readFileSync(path.join(dir, t), "utf8").split("\n");

function writeSettings(withHook: boolean) {
	const hook = { matcher: "", hooks: [{ type: "command", command: "sh ~/.claude/hooks/herdr-claude.sh", timeout: 5 }] };
	const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "StopFailure", "SessionEnd"];
	const hooks = withHook ? Object.fromEntries(events.map(e => [e, [hook]])) : { Stop: [{ matcher: "", hooks: [{ type: "command", command: "true" }] }] };
	fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks }, null, 2));
}

// Only a symlink is removed, never what it points at (the sandbox links the real ~/.claude and omp).
function unlinkIfLink(p: string) {
	try {
		if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
	} catch {}
	if (fs.existsSync(p) && !fs.realpathSync(p).startsWith(fs.realpathSync(BENCH_ROOT))) throw new Error(`${p} is not a sandbox file`);
}

async function until(t: string, ok: (i: HcGet) => boolean, what: string, ms = 30_000): Promise<HcGet> {
	return waitFor(async () => {
		const i = await get(t).catch(() => undefined);
		return i && ok(i) ? i : undefined;
	}, `${t}: ${what}`, ms, 100);
}
const isApp = (app: string, s?: string) => (i: HcGet) => i.status?.app === app && (!s || i.status.state === s);

async function newSpace(name: string, argv?: string[]) {
	const c = await instance.app<{ space: string; terminal: string }>([
		"do", "space.new", "--name", name, "--folder", folder, "--tab", "main", ...(argv ? ["--argv", JSON.stringify(argv)] : []), "--focus", "false",
	]);
	spaceIds.push(c.space);
	return c;
}
async function paneOf(terminal: string): Promise<string> {
	const ls = await instance.app<{ spaces: { tabs: { terminals: { terminal: string; pane?: string }[] }[] }[] }>(["ls"]);
	for (const s of ls.spaces) for (const tab of s.tabs) for (const t of tab.terminals) if (t.terminal === terminal && t.pane) return t.pane;
	throw new Error(`no pane for ${terminal}`);
}

beforeAll(async () => {
	sb = prepareSandbox(repo);
	state = path.join(sb.home, ".local/state");
	assertNotReal(state);
	folder = fs.realpathSync(sb.work("switch"));

	// A private Claude config folder (not the real ~/.claude link) with the hook, as the README installs it.
	claudeDir = path.join(sb.home, ".claude");
	unlinkIfLink(claudeDir);
	fs.mkdirSync(path.join(claudeDir, "hooks"), { recursive: true });
	fs.copyFileSync(path.join(repo, "claude/hooks/herdr-claude.sh"), path.join(claudeDir, "hooks/herdr-claude.sh"));
	writeSettings(true);
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	// The Claude global config, where Claude keeps folder trust. No folder of the test is trusted yet.
	claudeJson = path.join(claudeDir, ".claude.json");
	fs.writeFileSync(claudeJson, firstConfig, { mode: 0o600 });

	// The fakes, in place of the real omp link.
	const built = path.join(sb.root, "fake-agent");
	const b = await run(process.execPath, ["build", "--compile", path.join(repo, "tests/fakes/fake-agent.ts"), "--outfile", built]);
	if (b.code !== 0) throw new Error(`bun build: ${b.stderr || b.stdout}`);
	for (const name of ["omp", "claude"]) {
		const to = path.join(sb.bin, name);
		unlinkIfLink(to);
		fs.copyFileSync(built, to);
		fs.chmodSync(to, 0o755);
	}
	// A login shell runs path_helper, which puts the system folders first: put the sandbox bin back in
	// front, so `omp` and `command claude` find the fakes. Any rc file also keeps zsh's first-run menu away.
	const front = `export PATH="${sb.bin}:$PATH"\n`;
	for (const rc of [".zprofile", ".zshrc", ".profile"]) fs.writeFileSync(path.join(sb.home, rc), front);

	await startCore(sb);
	instance = (await Instance.start(sb)).instance;

	const orch = await newSpace("tmp-switch-orch", ["/bin/sh", "-c", "exec cat >/dev/null"]);
	T.orch = orch.terminal;
	T.sibling = (
		await instance.app<{ terminal: string }>(["do", "tab.new", "--space", orch.space, "--name", "second", "--folder", folder, "--argv", JSON.stringify([path.join(sb.bin, "omp")]), "--focus", "false"])
	).terminal;
	T.a = (await newSpace("tmp-switch-a")).terminal;
	T.b = (await newSpace("tmp-switch-b", ["omp"])).terminal;
	T.busy = (await newSpace("tmp-switch-busy", ["/usr/bin/env", "FAKE_AGENT_STATE=working", path.join(sb.bin, "omp")])).terminal;
	await until(T.b, isApp("omp", "idle"), "fake omp idle");
	// pane.split runs its argv as is: omp is the terminal's program, with no shell after it.
	const split = await instance.app<{ terminal: string }>([
		"do", "pane.split", "--direction", "right", "--pane", await paneOf(T.b), "--argv", JSON.stringify(["/bin/sh", "-c", `exec '${path.join(sb.bin, "omp")}'`]),
	]);
	T.c = split.terminal;
	// omp typed at the prompt of a plain shell.
	await until(T.a, i => !!i.foreground?.pid, "shell up");
	await run("env", ["-u", "HC_TERMINAL_ID", "hc", "send", T.a, "omp"], { timeoutMs: 10_000 });
	for (const t of [T.a, T.c, T.sibling]) await until(t, isApp("omp", "idle"), "fake omp idle");
	await until(T.busy, isApp("omp", "working"), "fake omp working");

	// The extension runs as the orchestrator: its own terminal is the stand-in.
	process.env.HC_TERMINAL_ID = T.orch;
	pi = fakePi({
		exec: async (cmd, args) => {
			if (!ALLOWED[cmd]) throw new Error(`switch test: refused to run ${cmd}`);
			if (process.env.HC_SESSION !== "herdrtest" || !process.env.HERDR_APP_HOME?.startsWith(BENCH_ROOT))
				throw new Error("switch test: hc or herdr-app would reach the real core or window");
			const r = await run(cmd, args);
			pi.execs.push({ at: 0, ms: r.ms, cmd, args });
			return r;
		},
	});
	// Dynamic imports: herdr-reload.ts and herdr-switch.ts read HC_TERMINAL_ID once at import, so they
	// must load after it is set above (and after orch.ts registered the omp stub module).
	mod = await import(`${orchFile(repo, "extensions/herdr-switch.ts")}?switch-test`);
	reload = await import(orchFile(repo, "extensions/herdr-reload.ts"));
	const watch = await import(orchFile(repo, "extensions/herdr-watch.ts"));
	pi.events.on(watch.FORGET_EVENT, d => {
		if (d && typeof d === "object" && "terminal" in d && typeof d.terminal === "string") forgot.push(d.terminal);
	});
	mod.default(pi);
	const trust = await import(orchFile(repo, "lib/claude-trust.ts"));
	expect(trust.claudeConfigFile()).toBe(claudeJson);
	for (const p of [mod.CLAUDE_CRUMBS, mod.SWITCH_DIR, mod.TRUST_BACKUP, reload.OMP_CRUMBS, trust.claudeConfigFile()]) assertNotReal(p);
}, LONG);

afterAll(async () => {
	for (const id of spaceIds) await instance?.app(["do", "space.close", "--id", id, "--confirmed", "true"]).catch(() => {});
	if (sb) await stopAll(sb);
});

const cmd = (name: string) => pi.commands.get(name) as Command;

test("the test sees the fakes as the extension does", async () => {
	for (const t of [T.a, T.b, T.c, T.busy, T.sibling]) {
		const info = await get(t);
		const pid = await reload.toolPid(exec, info.foreground!.pid!, "omp");
		expect(pid).toBeNumber();
		expect(last("omp", t)?.pid).toBe(pid!);
		firstOmp[t] = last("omp", t)!;
		expect(fs.realpathSync(firstOmp[t].session).startsWith(fs.realpathSync(BENCH_ROOT))).toBe(true);
	}
	expect(reload.shellStays((await get(T.a)).argv ?? [])).toBe(true);
	expect(reload.shellStays((await get(T.b)).argv ?? [])).toBe(true);
	expect(reload.shellStays((await get(T.c)).argv ?? [])).toBe(false);
});

test("/claude and /omp refuse to run without the Claude hook", async () => {
	writeSettings(false);
	const n = notes.length;
	const sends = pi.execs.filter(e => e.args.includes("send")).length;
	for (const name of ["claude", "omp"]) await cmd(name).handler("", ctx);
	writeSettings(true);
	const said = notes.slice(n);
	expect(said).toHaveLength(2);
	for (const s of said) {
		expect(s.kind).toBe("warning");
		expect(s.m).toContain("hook is not installed");
	}
	expect(pi.sent).toHaveLength(0);
	expect(pi.execs.filter(e => e.args.includes("send")).length).toBe(sends);
	expect(fs.existsSync(path.join(mod.SWITCH_DIR, "mode"))).toBe(false);
});

test(
	"/claude switches the idle omp terminals in place and skips the rest",
	async () => {
		const before = Object.fromEntries(await Promise.all(Object.entries(T).map(async ([k, t]) => [k, await get(t)] as const)));
		await cmd("claude").handler("", ctx);
		const text = report();
		expect(text).toStartWith("/claude: 3 switched, 2 skipped or failed.");
		expect(text).toContain(`${T.busy} (tmp-switch-busy): skipped: working`);
		expect(text).toContain(`${T.sibling} (tmp-switch-orch): skipped: the orchestrator's own space`);
		expect(fs.readFileSync(path.join(mod.SWITCH_DIR, "mode"), "utf8")).toBe("claude\n");
		expect(forgot.sort()).toEqual([T.a, T.b, T.c].sort());

		// The split terminal: a new id in the same tab, and its record and omp breadcrumb went with it.
		const moved = text.match(new RegExp(`- ${T.c} -> (\\S+) `));
		expect(moved).not.toBeNull();
		c2 = moved![1];
		const c2info = await get(c2);
		expect(c2info.labels?.["herdr.tab"]).toBe(before.c.labels?.["herdr.tab"]);
		expect(c2info.labels?.["herdr.space"]).toBe(before.c.labels?.["herdr.space"]);
		const record = JSON.parse(fs.readFileSync(path.join(mod.SWITCH_DIR, `${c2}.json`), "utf8"));
		expect(record.created_ms).toBe(c2info.created_ms);
		expect(record.omp.session_id).toBeString();
		expect(fs.existsSync(path.join(mod.SWITCH_DIR, `${T.c}.json`))).toBe(false);
		expect(crumbLines(reload.OMP_CRUMBS, c2).slice(0, 3)).toEqual([String(c2info.created_ms), firstOmp[T.c].session, "quit"]);

		for (const [key, t] of [["a", T.a], ["b", T.b], ["c", c2]] as const) {
			const info = await get(t);
			expect(info.status?.app).toBe("claude");
			if (key !== "c") {
				// Same terminal: same id, space, tab and cwd.
				expect(info.created_ms).toBe(before[key].created_ms);
				expect(info.labels).toEqual(before[key].labels);
				expect(crumbLines(reload.OMP_CRUMBS, t)[2]).toBe("quit");
			}
			const l = last("claude", t)!;
			expect(l).toBeDefined();
			firstClaude[key] = l;
			expect(l.cwd).toBe(folder);
			expect(await reload.toolPid(exec, info.foreground!.pid!, "claude")).toBe(l.pid);
			// No --add-dir: Claude would ask the person to trust that folder first.
			expect(l.argv).not.toContain("--add-dir");
			expect(l.argv).not.toContain("--resume");
			expect(l.argv.at(-2)).toBe("--");
			// The shell read the handoff file into the prompt: the instruction, then the handoff.
			const p = l.argv.at(-1)!;
			expect(p).toStartWith("switch test task: This terminal moved from omp to Claude Code. The handoff below");
			expect(p).toContain("\n# Handoff from omp to Claude Code\n");
			const handoffs = path.join(state, "herdr-switch/handoffs");
			// $(cat) drops the trailing newlines of the file.
			const file = fs.readdirSync(handoffs).map(f => path.join(handoffs, f)).find(f => fs.readFileSync(f, "utf8").replace(/\n+$/, "") === p);
			expect(file).toBeDefined();
			expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
			// The title keeps its text; omp's icon becomes Claude's.
			expect(l.argv).toContain("-n");
			expect(l.argv[l.argv.indexOf("-n") + 1]).toBe("switch test task");
			expect(crumbLines(mod.CLAUDE_CRUMBS, t)[1]).toBe(l.session);
		}
		expect((await get(T.a)).title).toStartWith("✳");

		// Claude asked no trust question: the switch marked the cwd, and only the cwd, as trusted. The rest
		// of the config did not change, and the backup holds the config from before.
		expect(text).not.toMatch(/trust/i);
		const after = config();
		expect(Object.keys(after.projects).sort()).toEqual([ELSEWHERE, folder].sort());
		expect(after.projects[folder]).toEqual({ hasTrustDialogAccepted: true });
		expect(after.projects[ELSEWHERE]).toEqual(JSON.parse(firstConfig).projects[ELSEWHERE]);
		expect(after.numStartups).toBe(7);
		expect(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
		expect(fs.readFileSync(mod.TRUST_BACKUP, "utf8")).toBe(firstConfig);
		expect(fs.statSync(mod.TRUST_BACKUP).mode & 0o777).toBe(0o600);
		expect(fs.readdirSync(claudeDir).filter(f => f.startsWith(".claude.json."))).toEqual([]);

		// Working and orchestrator-space terminals did not change.
		for (const key of ["busy", "sibling", "orch"] as const) {
			const info = await get(T[key]);
			expect(info.foreground?.pid).toBe(before[key].foreground?.pid);
			expect(info.status).toEqual(before[key].status);
		}
	},
	LONG,
);

test(
	"/omp resumes each terminal's old omp session",
	async () => {
		await cmd("omp").handler("", ctx);
		const text = report();
		expect(text).toStartWith("/omp: 3 switched, 0 skipped or failed.");
		expect(fs.readFileSync(path.join(mod.SWITCH_DIR, "mode"), "utf8")).toBe("omp\n");
		for (const [t, old] of [[T.a, T.a], [T.b, T.b], [c2, T.c]]) {
			const info = await until(t, isApp("omp"), "omp back");
			const l = last("omp", t)!;
			expect(l.argv.slice(0, 2)).toEqual(["--resume", firstOmp[old].session]);
			expect(l.argv[2]).toContain("This terminal moved from Claude Code to omp. The handoff below");
			expect(await reload.toolPid(exec, info.foreground!.pid!, "omp")).toBe(l.pid);
			expect(text).toContain(`${t} (`);
			expect(crumbLines(mod.CLAUDE_CRUMBS, t)[2]).toBe("quit");
		}
		// The split terminal keeps a shell now, so it kept its id this time.
		expect(text).not.toContain("->");
		expect(text).toContain("resumed its old session");
	},
	LONG,
);

test(
	"/claude again resumes Claude with only the new part, and forks a Claude session that moved on",
	async () => {
		// b's Claude session went on after the switch (as if it was continued in another terminal).
		const moved = { type: "user", uuid: crypto.randomUUID(), parentUuid: null, isSidechain: false, sessionId: path.basename(firstClaude.b.session, ".jsonl"), cwd: folder, message: { role: "user", content: "later" } };
		fs.appendFileSync(firstClaude.b.session, `${JSON.stringify(moved)}\n`);
		await cmd("claude").handler("", ctx);
		const text = report();
		expect(text).toStartWith("/claude: 3 switched, 2 skipped or failed.");

		const a = last("claude", T.a)!;
		expect(a.pid).not.toBe(firstClaude.a.pid);
		expect(a.argv.slice(a.argv.indexOf("--resume"), a.argv.indexOf("--resume") + 2)).toEqual(["--resume", path.basename(firstClaude.a.session, ".jsonl")]);
		expect(a.argv).not.toContain("--fork-session");
		expect(a.argv).not.toContain("-n");
		expect(text).toMatch(new RegExp(`${T.a} \\(tmp-switch-a\\): switched to Claude \\(resumed its old session, handoff since the last switch\\)`));

		const b = last("claude", T.b)!;
		expect(b.argv).toContain("--fork-session");
		expect(b.argv[b.argv.indexOf("--resume") + 1]).toBe(path.basename(firstClaude.b.session, ".jsonl"));
		expect(text).toContain(`${T.b} (tmp-switch-b): switched to Claude (forked its old session, which moved on, handoff since the last switch)`);
	},
	LONG,
);

// A space in a folder that Claude never saw, with omp typed at its shell prompt. folder is given as
// is: the sandbox is under /tmp, which Claude keys by its real path, /private/tmp.
async function ompSpace(name: string, dir: string) {
	const c = await instance.app<{ space: string; terminal: string }>([
		"do", "space.new", "--name", name, "--folder", dir, "--tab", "main", "--focus", "false",
	]);
	spaceIds.push(c.space);
	await until(c.terminal, i => !!i.foreground?.pid, "shell up");
	await run("env", ["-u", "HC_TERMINAL_ID", "hc", "send", c.terminal, "omp"], { timeoutMs: 10_000 });
	await until(c.terminal, isApp("omp", "idle"), "fake omp idle");
	return c.terminal;
}

test(
	"/claude in a folder that Claude never saw starts Claude with no trust question",
	async () => {
		const dir = sb.work("switch-new");
		const real = fs.realpathSync(dir);
		expect(real).not.toBe(dir);
		const t = await ompSpace("tmp-switch-new", dir);
		expect(config().projects[real]).toBeUndefined();

		await cmd("claude").handler("tmp-switch-new", ctx);
		const text = report();
		expect(text).toBe(`/claude: 1 switched, 0 skipped or failed.\nSwitched:\n- ${t} (tmp-switch-new): switched to Claude (new session, full handoff)`);
		await until(t, isApp("claude", "idle"), "fake claude idle");
		expect(last("claude", t)?.cwd).toBe(real);
		expect(config().projects[real]).toEqual({ hasTrustDialogAccepted: true });
		expect(config().projects[dir]).toBeUndefined();
		expect(config().projects[path.dirname(real)]).toBeUndefined();
		// The backup is made once, before the first change only.
		expect(fs.readFileSync(mod.TRUST_BACKUP, "utf8")).toBe(firstConfig);
	},
	LONG,
);

test(
	"/claude skips a terminal when the Claude config does not parse, and leaves omp and the file as they were",
	async () => {
		const t = await ompSpace("tmp-switch-broken", sb.work("switch-broken"));
		const pid = last("omp", t)!.pid;
		const good = fs.readFileSync(claudeJson, "utf8");
		fs.writeFileSync(claudeJson, "{ not json");
		try {
			await cmd("claude").handler("tmp-switch-broken", ctx);
			expect(report()).toStartWith(`/claude: 0 switched, 1 skipped or failed.`);
			expect(report()).toContain(`${t} (tmp-switch-broken): skipped: could not mark the folder as trusted for Claude`);
			expect(fs.readFileSync(claudeJson, "utf8")).toBe("{ not json");
			const info = await get(t);
			expect(info.status?.app).toBe("omp");
			// The same omp still runs (the raw foreground pid can be a short child of the shell or omp).
			expect(await reload.toolPid(exec, info.foreground!.pid!, "omp", info.pid)).toBe(pid);
		} finally {
			fs.writeFileSync(claudeJson, good);
		}
	},
	LONG,
);

test(
	"/omp switches a Claude terminal that reports claude-code, as Claude Code itself does",
	async () => {
		// The wrapper of space.new: the shell stays after Claude. The folder is trusted since the first /claude.
		const t = (await newSpace("tmp-switch-code", ["/usr/bin/env", "FAKE_AGENT_APP=claude-code", path.join(sb.bin, "claude")])).terminal;
		await until(t, isApp("claude-code", "idle"), "fake claude idle as claude-code");

		await cmd("omp").handler("tmp-switch-code", ctx);
		const text = report();
		expect(text).toBe(`/omp: 1 switched, 0 skipped or failed.\nSwitched:\n- ${t} (tmp-switch-code): switched to omp (new session, full handoff)`);
		const info = await until(t, isApp("omp", "idle"), "fake omp idle");
		const l = last("omp", t)!;
		expect(l.argv[0]).toContain("This terminal moved from Claude Code to omp. The handoff below");
		expect(await reload.toolPid(exec, info.foreground!.pid!, "omp")).toBe(l.pid);
		expect(crumbLines(mod.CLAUDE_CRUMBS, t)[2]).toBe("quit");
	},
	LONG,
);

test(
	"/claude and /omp list a terminal whose omp was killed, and leave its shell alone",
	async () => {
		const t = await ompSpace("tmp-switch-killed", sb.work("switch-killed"));
		const omp = last("omp", t)!;
		// SIGKILL: omp writes no quit mark, and the shell it ran in stays.
		process.kill(omp.pid, "SIGKILL");
		const shell = (await until(t, i => !!i.foreground?.pid && i.foreground.pid !== omp.pid, "shell back")).foreground!.pid!;
		expect(await reload.toolPid(exec, shell, "omp")).toBeUndefined();
		expect(crumbLines(reload.OMP_CRUMBS, t)[2]).not.toBe("quit");

		const note = `- ${t} (tmp-switch-killed): skipped: no agent runs; its omp session stopped (type omp or claude there to resume it)`;
		for (const name of ["claude", "omp"]) {
			await cmd(name).handler("tmp-switch-killed", ctx);
			expect(report()).toBe(`/${name}: 0 switched, 1 skipped or failed.\nSkipped or failed (type /${name} again later, or switch these by hand):\n${note}`);
		}
		const info = await get(t);
		expect(info.foreground?.pid).toBe(shell);
		expect(last("omp", t)?.pid).toBe(omp.pid);
		expect(last("claude", t)).toBeUndefined();
		expect(crumbLines(reload.OMP_CRUMBS, t)[2]).not.toBe("quit");
	},
	LONG,
);
