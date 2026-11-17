// Runs claude/hooks/herdr-claude.sh with fake hook input. HOME is a temp dir,
// `hc` is a fake, and HERDR_CLAUDE_HOOK_TTY points the OSC report at a file.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "../claude/hooks/herdr-claude.sh");
const TRANSCRIPT = "/tmp/fake-claude-project/0d9a1c2e-1111-4222-8333-444455556666.jsonl";

let root: string;
let home: string;
let bin: string;
let tty: string;
let crumb: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "herdr-claude-hook-"));
	home = join(root, "home");
	bin = join(root, "bin");
	tty = join(root, "tty");
	crumb = join(home, ".local/state/claude-herdr-resume/tTEST");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "hc"), '#!/bin/sh\necho \'{"created_ms":123}\'\n');
	chmodSync(join(bin, "hc"), 0o755);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function run(input: object, opts: { terminal?: string; tty?: boolean; argv?: string[] } = {}) {
	const env: Record<string, string> = {
		HOME: home,
		PATH: `${bin}:${process.env.PATH}`,
		HC_TERMINAL_ID: opts.terminal ?? "tTEST",
	};
	if (opts.tty !== false) env.HERDR_CLAUDE_HOOK_TTY = tty;
	const proc = Bun.spawn(opts.argv ?? ["sh", SCRIPT], {
		env,
		stdin: new Blob([JSON.stringify(input)]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(stdout).toBe("");
	expect(code).toBe(0);
}

const osc = (state: string) => `\x1b]7501;state=${state}:app=claude\x07`;
const ttyText = () => (existsSync(tty) ? readFileSync(tty, "utf8") : "");
const base = { session_id: "0d9a1c2e-1111-4222-8333-444455556666", transcript_path: TRANSCRIPT, cwd: "/tmp" };

for (const [event, state] of [
	["SessionStart", "idle"],
	["UserPromptSubmit", "working"],
	["PreToolUse", "working"],
	["PostToolUse", "working"],
	["PermissionRequest", "blocked"],
	["Stop", "done"],
	["StopFailure", "error"],
] as const) {
	test(`${event} reports ${state}`, async () => {
		await run({ ...base, hook_event_name: event });
		expect(ttyText()).toBe(osc(state));
	});
}

test("Notification idle_prompt writes nothing", async () => {
	await run({ ...base, hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
	expect(ttyText()).toBe("");
	expect(existsSync(crumb)).toBe(false);
});

test("SessionStart writes the breadcrumb", async () => {
	await run({ ...base, hook_event_name: "SessionStart", source: "startup" });
	expect(readFileSync(crumb, "utf8")).toBe(`123\n${TRANSCRIPT}\n`);
});

test("SessionStart after a compaction writes the breadcrumb and no state", async () => {
	await run({ ...base, hook_event_name: "SessionStart", source: "compact" });
	expect(readFileSync(crumb, "utf8")).toBe(`123\n${TRANSCRIPT}\n`);
	expect(ttyText()).toBe("");
});

test("PreCompact reports working", async () => {
	await run({ ...base, hook_event_name: "PreCompact", trigger: "auto" });
	expect(ttyText()).toBe(osc("working"));
});

test("SessionEnd prompt_input_exit appends quit", async () => {
	await run({ ...base, hook_event_name: "SessionStart" });
	await run({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
	expect(readFileSync(crumb, "utf8")).toBe(`123\n${TRANSCRIPT}\nquit\n`);
	expect(ttyText()).toBe(osc("idle"));
});

test("SessionEnd by a signal writes no quit", async () => {
	await run({ ...base, hook_event_name: "SessionStart" });
	await run({ ...base, hook_event_name: "SessionEnd", reason: "other" });
	expect(readFileSync(crumb, "utf8")).toBe(`123\n${TRANSCRIPT}\n`);
});

test("SessionEnd of another session leaves the breadcrumb alone", async () => {
	await run({ ...base, hook_event_name: "SessionStart" });
	await run({ ...base, transcript_path: "/tmp/fake-claude-project/other.jsonl", hook_event_name: "SessionEnd", reason: "logout" });
	expect(readFileSync(crumb, "utf8")).toBe(`123\n${TRANSCRIPT}\n`);
});

test("no HC_TERMINAL_ID writes nothing", async () => {
	await run({ ...base, hook_event_name: "SessionStart" }, { terminal: "" });
	expect(ttyText()).toBe("");
	expect(existsSync(join(home, ".local"))).toBe(false);
});

test("parent that is not claude writes nothing", async () => {
	// Seven sh layers keep the 6-level walk from reaching a real claude above the test runner.
	const wrap = join(root, "wrap.sh");
	writeFileSync(wrap, '#!/bin/sh\n"$@"\nexit $?\n');
	chmodSync(wrap, 0o755);
	const argv = [...Array(7).fill(wrap), "sh", SCRIPT];
	await run({ ...base, hook_event_name: "SessionStart" }, { tty: false, argv });
	expect(ttyText()).toBe("");
	expect(existsSync(join(home, ".local"))).toBe(false);
});
