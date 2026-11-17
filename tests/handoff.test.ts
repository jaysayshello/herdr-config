// Unit tests for orchestrator/.omp/lib/handoff.ts. Run: bun test tests/handoff.test.ts
// Every session file here is fake and made in a temp dir. HOME points at a temp dir, so nothing touches real state.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lib from "../orchestrator/.omp/lib/handoff.ts";

let tmp: string;
let realHome: string | undefined;

// Fake secrets, made at run time so this file has no token-shaped text.
const GH = `ghp_${"a1B2".repeat(9)}`;
const AWS = `AKIA${"EXAMPLEFAKEKEY16"}`;
const ANT = `sk-ant-${"fakefake".repeat(4)}`;

beforeAll(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-test-"));
	realHome = process.env.HOME;
	// writeHandoff reads HOME at call time.
	process.env.HOME = path.join(tmp, "home");
	fs.mkdirSync(process.env.HOME, { recursive: true });
});

afterAll(() => {
	process.env.HOME = realHome;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(name: string, lines: (object | string)[]): string {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, `${lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
	return file;
}

function plainDir(): string {
	return fs.mkdtempSync(path.join(tmp, "cwd-"));
}

// ---------- omp ----------

const OMP_ID = "01900000-0000-7000-8000-000000000001";
let ts = 0;
function omp(id: string, parentId: string | null, rest: object): object {
	return { id, parentId, timestamp: new Date(1_800_000_000_000 + ts++ * 1000).toISOString(), ...rest };
}
function ompMsg(id: string, parentId: string | null, role: string, content: unknown): object {
	return omp(id, parentId, { type: "message", message: { role, content } });
}

function ompFixture(): string {
	return writeJsonl("omp.jsonl", [
		{ type: "title", title: "fake title" },
		{ type: "session", version: 3, id: OMP_ID, cwd: "/tmp/fake", timestamp: "2026-01-01T00:00:00.000Z" },
		ompMsg("e0000001", null, "user", "OLD-PROMPT-BEFORE-KEPT"),
		ompMsg("e0000002", "e0000001", "assistant", [{ type: "text", text: "OLD-ANSWER-BEFORE-KEPT" }]),
		ompMsg("e0000003", "e0000002", "user", [{ type: "text", text: "KEPT-PROMPT-ONE" }]),
		ompMsg("e0000004", "e0000003", "assistant", [
			{ type: "text", text: "Planning the work." },
			{
				type: "toolCall",
				id: "call1",
				name: "todo",
				arguments: { op: "init", list: [{ phase: "Build", items: ["Write the parser", "Write the tests"] }] },
			},
		]),
		ompMsg("e0000005", "e0000004", "toolResult", [{ type: "text", text: `TOOL-OUTPUT-TEXT ${GH}` }]),
		omp("e0000006", "e0000005", { type: "compaction", summary: "COMPACTION-SUMMARY-TEXT", firstKeptEntryId: "e0000003" }),
		// An abandoned side branch.
		ompMsg("e0000007", "e0000006", "user", "ABANDONED-TEXT"),
		omp("e0000008", "e0000006", { type: "branch_summary", summary: "BRANCH-SUMMARY-TEXT", fromId: "e0000007" }),
		ompMsg("e0000009", "e0000008", "user", "KEPT-PROMPT-TWO, see local://plan.md"),
		ompMsg("e0000010", "e0000009", "assistant", [
			{ type: "thinking", thinking: "THINKING-TEXT", thinkingSignature: "sig" },
			{ type: "text", text: `ANSWER-TWO with ${AWS}` },
		]),
		"{not json",
		ompMsg("e0000011", "e0000010", "assistant", [
			{ type: "toolCall", id: "call2", name: "todo", arguments: { op: "done", task: "Write the parser" } },
		]),
		ompMsg("e0000012", "e0000011", "developer", "DEVELOPER-TEXT"),
		omp("e0000013", "e0000012", { type: "custom", customType: "x", data: { note: "CUSTOM-TEXT" } }),
		ompMsg("e0000014", "e0000013", "user", "NEW-PROMPT-AFTER-SWITCH"),
	]);
}

describe("omp handoff", () => {
	test("sessionPoint gives the header id and the last entry", () => {
		const file = ompFixture();
		expect(lib.sessionPoint("omp", file)).toEqual({ sessionId: OMP_ID, leaf: "e0000014" });
	});

	test("sessionPoint and the handoff point skip the entries omp adds when it ends", async () => {
		const file = ompFixture();
		fs.appendFileSync(file, `${JSON.stringify(omp("e0000090", "e0000014", { type: "credential_pin", provider: "x" }))}\n`);
		fs.appendFileSync(file, `${JSON.stringify(omp("e0000091", "e0000090", { type: "custom", customType: "session_exit", data: { reason: "sigterm" } }))}\n`);
		fs.appendFileSync(file, `${JSON.stringify(omp("e0000092", "e0000014", { type: "model_usage", purpose: "title" }))}\n`);
		expect(lib.sessionPoint("omp", file).leaf).toBe("e0000014");
		expect((await lib.buildHandoff({ from: "omp", to: "claude", file, cwd: plainDir() })).point.leaf).toBe("e0000014");
	});

	test("full handoff keeps the active branch after the compaction point only", async () => {
		const file = ompFixture();
		const cwd = plainDir();
		const h = await lib.buildHandoff({ from: "omp", to: "claude", file, cwd });
		const md = h.markdown;
		expect(h.partial).toBe(false);
		expect(h.point).toEqual({ sessionId: OMP_ID, leaf: "e0000014" });
		expect(md).toContain("# Handoff from omp to Claude Code");
		expect(md).toContain("COMPACTION-SUMMARY-TEXT");
		expect(md).toContain("BRANCH-SUMMARY-TEXT");
		expect(md).toContain("KEPT-PROMPT-ONE");
		expect(md).toContain("KEPT-PROMPT-TWO");
		expect(md).toContain("NEW-PROMPT-AFTER-SWITCH");
		expect(md).toContain("ANSWER-TWO");
		expect(md).toContain("[x] Write the parser");
		expect(md).toContain("[ ] Write the tests");
		expect(md).toContain("plan.md (an omp-only file, not readable here)");
		expect(md).toContain(cwd);
		expect(md).toContain("Not a git repo");
		for (const gone of [
			"OLD-PROMPT-BEFORE-KEPT",
			"OLD-ANSWER-BEFORE-KEPT",
			"ABANDONED-TEXT",
			"TOOL-OUTPUT-TEXT",
			"THINKING-TEXT",
			"DEVELOPER-TEXT",
			"CUSTOM-TEXT",
			"local://",
			"ghp_",
			"AKIA",
			file,
		])
			expect(md).not.toContain(gone);
		expect(md).toContain("[redacted]");
	});

	test("sinceLeaf on the branch gives only the later part", async () => {
		const file = ompFixture();
		const h = await lib.buildHandoff({ from: "omp", to: "claude", file, cwd: plainDir(), sinceLeaf: "e0000010" });
		expect(h.partial).toBe(true);
		expect(h.markdown).toContain("NEW-PROMPT-AFTER-SWITCH");
		for (const gone of ["KEPT-PROMPT-ONE", "KEPT-PROMPT-TWO", "ANSWER-TWO", "COMPACTION-SUMMARY-TEXT", "BRANCH-SUMMARY-TEXT"])
			expect(h.markdown).not.toContain(gone);
	});

	test("sinceLeaf off the branch gives a full handoff", async () => {
		const file = ompFixture();
		for (const since of ["e0000007", "ffffffff"]) {
			const h = await lib.buildHandoff({ from: "omp", to: "claude", file, cwd: plainDir(), sinceLeaf: since });
			expect(h.partial).toBe(false);
			expect(h.markdown).toContain("KEPT-PROMPT-ONE");
			expect(h.markdown).toContain("COMPACTION-SUMMARY-TEXT");
		}
	});
});

// ---------- Claude ----------

const CLAUDE_ID = "11111111-2222-4333-8444-555555555555";
function cl(uuid: string, parentUuid: string | null, rest: object): object {
	return { uuid, parentUuid, isSidechain: false, sessionId: CLAUDE_ID, cwd: "/tmp/fake", ...rest };
}
function clUser(uuid: string, parentUuid: string | null, content: unknown, extra: object = {}): object {
	return cl(uuid, parentUuid, { type: "user", message: { role: "user", content }, ...extra });
}
function clAsst(uuid: string, parentUuid: string | null, msgId: string, block: object): object {
	return cl(uuid, parentUuid, { type: "assistant", message: { id: msgId, role: "assistant", content: [block] } });
}

function claudeFixture(): string {
	return writeJsonl(`${CLAUDE_ID}.jsonl`, [
		{ type: "queue-operation", operation: "enqueue" },
		clUser("c01", null, "OLD-CLAUDE-PROMPT"),
		clAsst("c02", "c01", "m0", { type: "text", text: "OLD-CLAUDE-ANSWER" }),
		clAsst("c03", "c02", "m0", { type: "tool_use", id: "t0", name: "TaskCreate", input: { subject: "Write docs" } }),
		cl("c04", null, { type: "system", subtype: "compact_boundary", logicalParentUuid: "c03" }),
		clUser("c05", "c04", "CLAUDE-COMPACT-SUMMARY", { isCompactSummary: true }),
		clUser("c06", "c05", "META-TEXT", { isMeta: true }),
		clUser("c07", "c06", "CLAUDE-PROMPT-ONE"),
		clAsst("c08", "c07", "m1", { type: "thinking", thinking: "THINKING-TEXT", signature: "sig" }),
		clAsst("c09", "c08", "m1", { type: "text", text: "FIRST-PART of the answer" }),
		clAsst("c10", "c09", "m1", {
			type: "tool_use",
			id: "t1",
			name: "TodoWrite",
			input: {
				todos: [
					{ content: "Fix the hook", status: "in_progress", activeForm: "Fixing the hook" },
					{ content: "Ship it", status: "pending", activeForm: "Shipping it" },
				],
			},
		}),
		clUser("c11", "c10", [{ type: "tool_result", tool_use_id: "t1", content: `TOOL-OUTPUT-TEXT ${GH}` }]),
		{ ...clUser("s01", "c11", "SIDECHAIN-TEXT"), isSidechain: true },
		clAsst("c12", "c11", "m2", { type: "tool_use", id: "t2", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }),
		clAsst("c13", "c12", "m2", { type: "tool_use", id: "t3", name: "TaskCreate", input: { subject: "Review the PR" } }),
		clAsst("c14", "c13", "m3", { type: "text", text: `ANSWER-THREE with ${AWS} and ${ANT}` }),
		"garbage line",
		clUser("c15", "c14", [{ type: "text", text: "CLAUDE-PROMPT-TWO" }]),
		{ type: "last-prompt", lastPrompt: "CLAUDE-PROMPT-TWO", leafUuid: "c15" },
		{ ...clAsst("s02", "s01", "m9", { type: "text", text: "SIDECHAIN-TEXT answer" }), isSidechain: true },
	]);
}

describe("Claude handoff", () => {
	test("sessionPoint gives the file name and the last main-chain entry", () => {
		const file = claudeFixture();
		expect(lib.sessionPoint("claude", file)).toEqual({ sessionId: CLAUDE_ID, leaf: "c15" });
	});

	test("sessionPoint skips the system entries Claude adds after a turn", async () => {
		const file = claudeFixture();
		fs.appendFileSync(file, `${JSON.stringify(cl("c90", "c15", { type: "system", subtype: "stop_hook_summary" }))}\n`);
		expect(lib.sessionPoint("claude", file).leaf).toBe("c15");
		expect((await lib.buildHandoff({ from: "claude", to: "omp", file, cwd: plainDir() })).point.leaf).toBe("c15");
	});

	test("full handoff keeps the main chain after the compact summary", async () => {
		const file = claudeFixture();
		const h = await lib.buildHandoff({ from: "claude", to: "omp", file, cwd: plainDir() });
		const md = h.markdown;
		expect(h.partial).toBe(false);
		expect(h.point).toEqual({ sessionId: CLAUDE_ID, leaf: "c15" });
		expect(md).toContain("# Handoff from Claude Code to omp");
		expect(md).toContain("CLAUDE-COMPACT-SUMMARY");
		expect(md).toContain("CLAUDE-PROMPT-ONE");
		expect(md).toContain("CLAUDE-PROMPT-TWO");
		expect(md).toContain("FIRST-PART of the answer");
		expect(md).toContain("ANSWER-THREE");
		expect(md).toContain("[>] Fix the hook");
		expect(md).toContain("[ ] Ship it");
		expect(md).toContain("[x] Write docs");
		expect(md).toContain("[ ] Review the PR");
		for (const gone of [
			"OLD-CLAUDE-PROMPT",
			"OLD-CLAUDE-ANSWER",
			"META-TEXT",
			"SIDECHAIN-TEXT",
			"THINKING-TEXT",
			"TOOL-OUTPUT-TEXT",
			"ghp_",
			"AKIA",
			"sk-ant-",
			file,
		])
			expect(md).not.toContain(gone);
	});

	test("sinceLeaf on the branch gives only the later part", async () => {
		const file = claudeFixture();
		const h = await lib.buildHandoff({ from: "claude", to: "omp", file, cwd: plainDir(), sinceLeaf: "c12" });
		expect(h.partial).toBe(true);
		expect(h.markdown).toContain("CLAUDE-PROMPT-TWO");
		expect(h.markdown).toContain("ANSWER-THREE");
		for (const gone of ["CLAUDE-PROMPT-ONE", "FIRST-PART", "CLAUDE-COMPACT-SUMMARY"]) expect(h.markdown).not.toContain(gone);
	});

	test("unknown sinceLeaf gives a full handoff", async () => {
		const file = claudeFixture();
		const h = await lib.buildHandoff({ from: "claude", to: "omp", file, cwd: plainDir(), sinceLeaf: "s01" });
		expect(h.partial).toBe(false);
		expect(h.markdown).toContain("CLAUDE-PROMPT-ONE");
	});
});

// ---------- the rest ----------

describe("project state", () => {
	test("a git repo shows the branch, changed files, commits and tracking files", async () => {
		const cwd = plainDir();
		const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
		const git = (...args: string[]) => {
			const r = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, env });
			if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
		};
		git("init", "-q", "-b", "fake-branch");
		fs.writeFileSync(path.join(cwd, "README.md"), "x\n");
		git("add", "README.md");
		git("commit", "-q", "-m", "feat: first fake commit");
		fs.writeFileSync(path.join(cwd, "changed-file.txt"), "y\n");
		const h = await lib.buildHandoff({ from: "omp", to: "claude", file: ompFixture(), cwd });
		expect(h.markdown).toContain("Branch: fake-branch");
		expect(h.markdown).toContain("changed-file.txt");
		expect(h.markdown).toContain("feat: first fake commit");
		expect(h.markdown).toContain("Tracking files here: README.md");
		expect(h.markdown).not.toContain("Not a git repo");
	});
});

describe("size cap", () => {
	test("200 long prompts stay under about 20 KB and keep the newest", async () => {
		const lines: object[] = [{ type: "session", version: 3, id: OMP_ID, cwd: "/tmp/fake" }];
		let parent: string | null = null;
		for (let i = 0; i < 200; i++) {
			const u = `a${String(i).padStart(7, "0")}`;
			const a = `b${String(i).padStart(7, "0")}`;
			lines.push(ompMsg(u, parent, "user", `PROMPT-${i}-END ${"x".repeat(3000)}`));
			lines.push(ompMsg(a, u, "assistant", [{ type: "text", text: `ANSWER-${i} ${"y".repeat(6000)}` }]));
			parent = a;
		}
		const file = writeJsonl("big.jsonl", lines);
		const h = await lib.buildHandoff({ from: "omp", to: "claude", file, cwd: plainDir() });
		expect(Buffer.byteLength(h.markdown)).toBeLessThanOrEqual(20_500);
		expect(h.markdown).toContain("PROMPT-199-END");
		expect(h.markdown).toContain("ANSWER-199");
		expect(h.markdown).not.toContain("PROMPT-150-END");
		expect(h.markdown).toContain("## Project state");
	});
});

describe("redact", () => {
	test("removes common secret forms", () => {
		const jwt = `eyJ${"hdr"}.eyJ${"body"}.${"sigsig"}`;
		const key = ["-----BEGIN RSA PRIVATE KEY-----", "fakebody", "-----END RSA PRIVATE KEY-----"].join("\n");
		const secrets = [
			GH,
			`gho_${"x".repeat(36)}`,
			`ghs_${"x".repeat(36)}`,
			`ghu_${"x".repeat(36)}`,
			`github_pat_${"x".repeat(40)}`,
			AWS,
			`ASIA${"FAKEFAKEFAKEFAKE"}`,
			`xoxb-${"1234567890-abcdef"}`,
			`sk-${"z".repeat(32)}`,
			ANT,
			jwt,
		];
		for (const s of secrets) expect(lib.redact(`before ${s} after`)).toBe("before [redacted] after");
		expect(lib.redact(`a\n${key}\nb`)).toBe("a\n[redacted]\nb");
		const kv = lib.redact("password=hunter2 TOKEN='abc def' client_secret=\"q r\" ok=1");
		expect(kv).toBe("password=[redacted] TOKEN=[redacted] client_secret=[redacted] ok=1");
		expect(lib.redact('{"api_key": "fake-value"}')).toBe('{"api_key": "[redacted]"}');
		expect(lib.redact("plain text stays")).toBe("plain text stays");
	});
});

describe("writeHandoff", () => {
	test("writes mode 600 in a 700 dir and deletes files older than 24 h", () => {
		const dir = path.join(process.env.HOME as string, ".local/state/herdr-switch/handoffs");
		fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
		fs.chmodSync(dir, 0o755);
		const old = path.join(dir, "t9-1.md");
		const fresh = path.join(dir, "t8-2.md");
		const other = path.join(dir, "keep.txt");
		for (const f of [old, fresh, other]) fs.writeFileSync(f, "x");
		const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(old, dayAgo, dayAgo);
		fs.utimesSync(other, dayAgo, dayAgo);

		const file = lib.writeHandoff("t1", "# fake handoff\n");
		expect(path.dirname(file)).toBe(dir);
		expect(path.basename(file)).toMatch(/^t1-\d+\.md$/);
		expect(fs.readFileSync(file, "utf8")).toBe("# fake handoff\n");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(other)).toBe(true);
	});
});

describe("firstPrompt", () => {
	test("names both tools, with the title first and the handoff after the instruction", () => {
		const p = lib.firstPrompt("omp", "claude", "# Handoff\n\nbody", "SEC: fix the hook");
		expect(p).toBe(
			"SEC: fix the hook: This terminal moved from omp to Claude Code. The handoff below has the conversation, the open task, and the project state. Read it, then tell me in 3 lines where the work is, and wait for my next message.\n\n# Handoff\n\nbody",
		);
		const q = lib.firstPrompt("claude", "omp", "# Handoff");
		expect(q.startsWith("This terminal moved from Claude Code to omp. The handoff below")).toBe(true);
		expect(q.endsWith("\n\n# Handoff")).toBe(true);
	});
});
