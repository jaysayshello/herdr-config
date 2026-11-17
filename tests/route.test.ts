// The orchestrator routes work to omp and Claude Code workers: herdr_send, herdr_new_agent,
// herdr_new_space, herdr_spaces and herdr_watch's final answer. The tools and the watch extension
// load outside omp with a fake `pi` (as bench/lib/orch.ts does), and fake `hc` and `herdr-app`
// programs come first on PATH, so the real Herdr is never reached.
// Bun reads HOME once at start, so this file runs itself again with HOME (and TMPDIR) in a temp
// folder: run it with `~/.bun/bin/bun test tests/route.test.ts`.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { plugin } from "bun";

const ROOT = path.join(import.meta.dir, "..");
const inner = process.env.ROUTE_TEST_HOME;

if (!inner) {
	test("route tests in a temp HOME", () => {
		const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "route-test-")));
		try {
			fs.mkdirSync(path.join(home, "tmp"));
			const r = Bun.spawnSync([process.execPath, "test", "./tests/route.test.ts"], {
				cwd: ROOT,
				env: {
					...process.env,
					HOME: home,
					TMPDIR: path.join(home, "tmp"),
					ROUTE_TEST_HOME: home,
					// The orchestrator's own terminal in the fake data.
					HC_TERMINAL_ID: "t0",
					// In case anything still finds the real programs, they reach no real core or window.
					HC_SESSION: "route-test",
					HERDR_APP_HOME: path.join(home, "herdr-app"),
				},
				stdout: "inherit",
				stderr: "inherit",
			});
			expect(r.exitCode).toBe(0);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	}, 120_000);
} else {
	if (os.homedir() !== inner || process.env.HC_TERMINAL_ID !== "t0") throw new Error("route tests must run in their temp HOME");
	const home = inner;
	const bin = path.join(home, "bin");
	const fake = path.join(home, "fake");
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ROUTE_FAKE: fake };
	const modeFile = path.join(home, ".local/state/herdr-switch/mode");
	const work = path.join(home, "work");

	// The fakes answer from fake/terminals/<t>.json and fake/ls.json, and log each call.
	const head = `#!${process.execPath}
const fs = require("fs"), path = require("path");
const dir = process.env.ROUTE_FAKE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "log.jsonl"), JSON.stringify({ cmd: path.basename(process.argv[1]), args }) + "\\n");
const file = t => path.join(dir, "terminals", t + ".json");
const put = (t, info) => fs.writeFileSync(file(t), JSON.stringify(info));
`;
	const hc = `${head}
if (args[0] === "get") {
	if (!fs.existsSync(file(args[1]))) { console.error("no terminal " + args[1]); process.exit(1); }
	process.stdout.write(fs.readFileSync(file(args[1]), "utf8"));
} else if (args[0] === "send") {
	const t = args[2];
	const info = JSON.parse(fs.readFileSync(file(t), "utf8"));
	const turn = info.turn ?? 0;
	put(t, { ...info, turn: turn + 1, status: { ...info.status, state: "working" } });
	console.log(JSON.stringify({ started: true, status: "idle", turn }));
} else if (args[0] === "read") {
	console.log(fs.existsSync(path.join(dir, "untrusted")) ? "Quick safety check: Is this a project you trust?\\n Yes, I trust this folder" : "screen text");
} else console.log("{}");
`;
	// A new terminal runs the app its argv starts, and has taken its first prompt.
	const app = `${head}
const argv = args.includes("--argv") ? JSON.parse(args[args.indexOf("--argv") + 1]) : [];
// A Claude in a folder it does not trust yet shows a question and reports no state.
const started = a => put("t9", fs.existsSync(path.join(dir, "untrusted")) ? { created_ms: 999, turn: 0, status: null, labels: { "herdr.space": "s9" } } : { created_ms: 999, turn: 1, status: { app: a, state: "working" }, labels: { "herdr.space": "s9" } });
if (args[0] === "ls") process.stdout.write(fs.readFileSync(path.join(dir, "ls.json"), "utf8"));
else if (args[0] === "do" && args[1] === "pane.split") {
	started(/exec claude "\\$t"$/.test(argv[2]) ? "claude" : /exec omp "\\$t"$/.test(argv[2]) ? "omp" : "sh");
	console.log(JSON.stringify({ pane: "p9", terminal: "t9" }));
} else if (args[0] === "do" && (args[1] === "space.new" || args[1] === "tab.new")) {
	started(argv[0]);
	console.log(JSON.stringify({ space: "s9", tab: "s9:1", terminal: "t9" }));
} else console.log("{}");
`;
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "hc"), hc, { mode: 0o755 });
	fs.writeFileSync(path.join(bin, "herdr-app"), app, { mode: 0o755 });

	const id = (s: string) => s;
	plugin({
		name: "omp-stub",
		setup(build) {
			build.module("@oh-my-pi/pi-coding-agent", () => ({
				loader: "object",
				exports: { theme: { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: id, italic: id, dim: id } },
			}));
		},
	});
	// Dynamic, because the stub module above must be in place before these files load.
	const herdr = await import("../orchestrator/.omp/tools/herdr.ts");
	const watch = await import("../orchestrator/.omp/extensions/herdr-watch.ts");

	interface Tool {
		name: string;
		execute(...args: unknown[]): Promise<{ details: Record<string, unknown> }>;
	}
	interface Sent {
		customType?: string;
		content?: string;
	}
	// Any zod call chain (pi.zod.object({...}).optional()) returns the same callable stub.
	const zod: object = new Proxy(function () {}, { get: () => zod, apply: () => zod });
	// exec runs only the fakes: a command that resolves anywhere else fails the test.
	async function exec(cmd: string, args: string[], o: { signal?: AbortSignal } = {}) {
		const found = Bun.which(cmd, { PATH: env.PATH });
		if (!found || path.dirname(found) !== bin) throw new Error(`the test would run the real ${cmd}`);
		const p = Bun.spawn([found, ...args], { env, stdout: "pipe", stderr: "pipe", signal: o.signal });
		const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { code, stdout, stderr, killed: p.signalCode != null };
	}
	function fakePi() {
		const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
		const report = Promise.withResolvers<string>();
		const pi = {
			zod,
			exec,
			tools: new Map<string, Tool>(),
			// The content of the first <herdr-report>.
			report: report.promise,
			on(event: string, fn: (...a: unknown[]) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), fn]);
			},
			async fire(event: string, ...args: unknown[]) {
				for (const fn of handlers.get(event) ?? []) await fn(...args);
			},
			events: { on() {}, emit() {} },
			registerTool(tool: Tool) {
				pi.tools.set(tool.name, tool);
			},
			sendMessage(message: Sent) {
				if (message.customType === "herdr-report") report.resolve(message.content ?? "");
			},
		};
		return pi;
	}
	// The pi types live in omp, which this test does not load; the fake has the parts the files use.
	type Pi = Parameters<typeof herdr.default>[0] & Parameters<typeof watch.default>[0];
	const asPi = (pi: ReturnType<typeof fakePi>) => pi as unknown as Pi;

	const tools = new Map((herdr.default(asPi(fakePi())) as unknown as Tool[]).map(t => [t.name, t]));
	const call = (name: string, params: object) => tools.get(name)!.execute("id", params, undefined, undefined, undefined);

	const terminal = (t: string, info: object) => fs.writeFileSync(path.join(fake, "terminals", `${t}.json`), JSON.stringify(info));
	const calls = (): { cmd: string; args: string[] }[] => {
		const log = path.join(fake, "log.jsonl");
		return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
	};
	const doCall = (verb: string) => calls().find(c => c.cmd === "herdr-app" && c.args[0] === "do" && c.args[1] === verb);
	const sends = () => calls().filter(c => c.cmd === "hc" && c.args[0] === "send").map(c => c.args);
	const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
	const setMode = (word: string) => {
		fs.mkdirSync(path.dirname(modeFile), { recursive: true });
		fs.writeFileSync(modeFile, word);
	};

	beforeEach(() => {
		fs.rmSync(fake, { recursive: true, force: true });
		fs.rmSync(modeFile, { force: true });
		fs.mkdirSync(path.join(fake, "terminals"), { recursive: true });
		fs.mkdirSync(work, { recursive: true });
		const tab = (id: string, terms: string[]) => ({ id, name: "1", terminals: terms.map(t => ({ terminal: t, pane: `p${t.slice(1)}` })) });
		fs.writeFileSync(
			path.join(fake, "ls.json"),
			JSON.stringify({
				spaces: [
					{ id: "s0", name: "orchestrator", tabs: [tab("s0:1", ["t0"])] },
					{ id: "s1", name: "demo", tabs: [tab("s1:1", ["t1", "t2", "t3"])] },
				],
			}),
		);
		const labels = { "herdr.space": "s1", where: "demo / 1" };
		terminal("t0", { created_ms: 100, turn: 5, status: { app: "omp", state: "working" }, labels: { "herdr.space": "s0" } });
		terminal("t1", { created_ms: 111, turn: 0, status: { app: "claude", state: "idle" }, labels, title: "✳ > DEMO: Fix the build", cwd: work });
		terminal("t2", { created_ms: 122, turn: 0, status: null, foreground: { name: "zsh", cwd: work }, labels, cwd: work });
		terminal("t3", { created_ms: 133, turn: 2, status: { app: "omp", state: "idle" }, labels, title: "π > DEMO: Docs", cwd: work });
	});

	test("readMode is omp without a mode file, and for an unknown word", () => {
		expect(herdr.readMode()).toBe("omp");
		setMode("garbage\n");
		expect(herdr.readMode()).toBe("omp");
		setMode("claude\n");
		expect(herdr.readMode()).toBe("claude");
		setMode("omp\n");
		expect(herdr.readMode()).toBe("omp");
	});

	describe("herdr_send", () => {
		test("sends to an idle claude terminal", async () => {
			const out = await call("herdr_send", { terminal: "t1", text: "Fix the build" });
			expect(out.details).toMatchObject({ terminal: "t1", turn: 0, interrupted: false });
			expect(sends()).toEqual([["send", "--json", "t1", "Fix the build"]]);
		});

		test("refuses a plain zsh terminal", async () => {
			await expect(call("herdr_send", { terminal: "t2", text: "Fix the build" })).rejects.toThrow("runs no agent, not omp or claude");
			expect(sends()).toEqual([]);
		});

		test("refuses the orchestrator's own terminal", async () => {
			await expect(call("herdr_send", { terminal: "t0", text: "x" })).rejects.toThrow("orchestrator's own terminal");
		});
	});

	describe("new workers start in the current mode", () => {
		// The task file is the script's $1; the fake does not run the script, so the test removes it.
		function splitArgv(): string[] {
			const c = doCall("pane.split");
			expect(c).toBeDefined();
			const argv = JSON.parse(flag(c!.args, "--argv")) as string[];
			expect(fs.readFileSync(argv[4], "utf8")).toBe("Write the docs");
			fs.rmSync(argv[4]);
			return argv;
		}

		test("herdr_new_agent in claude mode runs claude", async () => {
			setMode("claude\n");
			const out = await call("herdr_new_agent", { beside: "t1", task: "Write the docs" });
			expect(out.details).toMatchObject({ space: "s1", pane: "p9", terminal: "t9", turn: 0 });
			const argv = splitArgv();
			expect(argv.slice(0, 2)).toEqual(["sh", "-lc"]);
			expect(argv[2]).toEndWith('exec claude "$t"');
			expect(flag(doCall("pane.split")!.args, "--pane")).toBe("p1");
		});

		test("herdr_new_agent in omp mode runs omp", async () => {
			const out = await call("herdr_new_agent", { beside: "t3", task: "Write the docs" });
			expect(out.details).toMatchObject({ terminal: "t9" });
			expect(splitArgv()[2]).toEndWith('exec omp "$t"');
		});

		test("herdr_new_space in claude mode starts claude", async () => {
			setMode("claude\n");
			const out = await call("herdr_new_space", { name: "docs", folder: path.join(home, "space"), task: "Write the docs" });
			expect(out.details).toMatchObject({ space: "s9", terminal: "t9" });
			const args = doCall("space.new")!.args;
			expect(flag(args, "--argv")).toBe('["claude"]');
			expect(flag(args, "--name")).toBe("tmp-docs");
		});

		test("herdr_new_agent in claude mode says when Claude asks to trust the folder", async () => {
			setMode("claude\n");
			fs.writeFileSync(path.join(fake, "untrusted"), "");
			try {
				const t0 = Date.now();
				await expect(call("herdr_new_agent", { beside: "t1", task: "Write the docs" })).rejects.toThrow(/asks if it can trust this folder/);
				// It says so at once, not after the 45 s start wait.
				expect(Date.now() - t0).toBeLessThan(10_000);
			} finally {
				fs.rmSync(path.join(fake, "untrusted"));
			}
		});
	});

	test("herdr_spaces lists claude terminals with their app and state", async () => {
		interface Listed {
			spaces: { tabs: { terminals: { terminal: string }[] }[] }[];
		}
		const out = (await call("herdr_spaces", {})).details as unknown as Listed;
		const terms = out.spaces.flatMap(s => s.tabs.flatMap(t => t.terminals));
		expect(terms.find(t => t.terminal === "t1")).toMatchObject({ app: "claude", state: "idle", cwd: work });
		expect(terms.find(t => t.terminal === "t2")).toMatchObject({ app: null, state: null });
	});

	describe("Claude final answer", () => {
		const crumbs = path.join(home, ".local/state/claude-herdr-resume");
		const transcript = path.join(home, ".claude/projects/-work/0b6c1b9e-1111-4222-8333-444455556666.jsonl");
		const user = (content: unknown, more: object = {}) =>
			JSON.stringify({ type: "user", uuid: crypto.randomUUID(), isSidechain: false, message: { role: "user", content }, ...more });
		// Claude Code writes each block of a reply as its own entry, with the message id of the reply.
		const reply = (msg: string, block: object, more: object = {}) =>
			JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), isSidechain: false, message: { id: msg, role: "assistant", content: [block] }, ...more });
		const text = (t: string) => ({ type: "text", text: t });
		function writeTranscript(extra: string[] = []) {
			fs.mkdirSync(path.dirname(transcript), { recursive: true });
			const lines = [
				JSON.stringify({ type: "queue-operation" }),
				user("first task"),
				reply("m0", text("old answer")),
				user("do the second task"),
				reply("m1", { type: "thinking", thinking: "plan", signature: "sig" }),
				reply("m1", text("Checking.")),
				reply("m1", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }),
				user([{ type: "tool_result", tool_use_id: "toolu_1", content: "file" }]),
				reply("m8", text("sidechain text"), { isSidechain: true }),
				user([text("<system-reminder>meta</system-reminder>")], { isMeta: true }),
				reply("m2", text("Done: fixed the build.")),
				reply("m2", text("PR: https://github.com/owner/demo/pull/7")),
				JSON.stringify({ type: "last-prompt", leafUuid: "x" }),
				...extra,
			];
			fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
		}
		function crumb(created: number) {
			fs.mkdirSync(crumbs, { recursive: true });
			fs.writeFileSync(path.join(crumbs, "t1"), `${created}\n${transcript}\n`);
		}
		const answer = "Done: fixed the build.\nPR: https://github.com/owner/demo/pull/7";

		test("finalAnswer reads the last reply after the newest real prompt", () => {
			writeTranscript();
			crumb(111);
			expect(watch.finalAnswer("t1", 111, "claude")).toBe(answer);
			// The omp breadcrumb folder has no entry for t1.
			expect(watch.finalAnswer("t1", 111, "omp")).toBeUndefined();
		});

		test("finalAnswer ignores a breadcrumb of an older terminal at the same address", () => {
			writeTranscript();
			crumb(42);
			expect(watch.finalAnswer("t1", 111, "claude")).toBeUndefined();
		});

		test("finalAnswer gives nothing when the newest prompt has no reply yet", () => {
			writeTranscript([user("a third task")]);
			crumb(111);
			expect(watch.finalAnswer("t1", 111, "claude")).toBeUndefined();
		});

		describe("herdr_watch", () => {
			const pi = fakePi();
			watch.default(asPi(pi));
			const ctx = { agent: { kind: "main" }, hasUI: false };
			const watchTool = (params: object) => pi.tools.get("herdr_watch")!.execute("id", params, undefined, undefined, ctx);
			afterAll(() => pi.fire("session_shutdown"));

			test("watches a claude terminal and reports its answer from the transcript", async () => {
				writeTranscript();
				crumb(111);
				const t1 = JSON.parse(fs.readFileSync(path.join(fake, "terminals/t1.json"), "utf8"));
				terminal("t1", { ...t1, turn: 1, status: { app: "claude", state: "working" } });
				const out = await watchTool({ terminal: "t1", after_turn: 0, prompt: "Fix the build" });
				expect(out.details).toMatchObject({ terminal: "t1", space_id: "s1", watching: true });
				terminal("t1", { ...t1, turn: 1, status: { app: "claude", state: "done" } });
				const report = await pi.report;
				expect(report).toContain("state: done");
				expect(report).toContain(`answer (session):\n${answer}`);
				expect(report).toContain("links: https://github.com/owner/demo/pull/7");
			});

			test("refuses a plain zsh terminal", async () => {
				await expect(watchTool({ terminal: "t2", after_turn: 0, prompt: "x" })).rejects.toThrow("not omp or claude");
			});
		});
	});
}
