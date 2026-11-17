// Integration test of the PR fix agents (orchestrator/.omp/extensions/herdr-pr-autofix.ts) on a TEST
// Herdr only: its own window and core (bench/lib/instance.ts), with HOME in a sandbox (tests/run.sh).
// The extension runs outside omp with the fake `pi` of bench/lib/orch.ts; its polls come straight
// on the event bus, so no GitHub query runs. omp is the compiled fake of tests/fakes/fake-agent.ts,
// which reports the state written to $FAKE_AGENT_STATE_DIR/<terminal>. gh is answered in process:
// `gh repo clone` makes a local git repo, so no clone reaches GitHub and no agent starts on a real
// pull request. Run: tests/run.sh
import { assertNotReal, BENCH_ROOT } from "../bench/lib/guard.ts";
import { fakePi, orchFile, type FakePi } from "../bench/lib/orch.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hc, Instance, startCore, stopAll } from "../bench/lib/instance.ts";
import { run, waitFor } from "../bench/lib/proc.ts";
import { prepareSandbox, type Sandbox } from "../bench/lib/sandbox.ts";
import type { MergedPr, OpenPr, Poll } from "../orchestrator/.omp/extensions/herdr-pr-ready.ts";

const repo = path.resolve(import.meta.dir, "..");
const LONG = 240_000;
const ME = "me";

interface HcGet {
	turn?: number;
	cwd?: string;
	foreground?: { cwd?: string } | null;
	status?: { app?: string; state?: string } | null;
}
interface LsSpace {
	id: string;
	name: string;
	tabs: { id: string; terminals: { terminal: string; pane?: string }[] }[];
}
interface Record {
	url: string;
	head: string;
	terminal?: string;
	dir?: string;
}

let sb: Sandbox;
let instance: Instance;
let pi: FakePi;
let clones: string;
let state: string;
let pollEvent: string;
const clonedTo: string[] = [];

const pr = (name: string, number: number, draft: boolean, head = "a".repeat(40)): OpenPr => ({
	id: `id-${name}-${number}`,
	number,
	title: `PR ${number}`,
	url: `https://github.com/example/${name}/pull/${number}`,
	isDraft: draft,
	headRefName: `branch-${number}`,
	headRefOid: head,
	author: { login: ME },
	reviewDecision: null,
	mergeable: "MERGEABLE",
	repository: { nameWithOwner: `example/${name}` },
});
const merged = (name: string, number: number) => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/example/${name}/pull/${number}`,
	repository: { nameWithOwner: `example/${name}` },
	mergedAt: new Date().toISOString(),
});

const records = (): Record[] => JSON.parse(fs.readFileSync(path.join(state, "herdr-pr-autofix/agents.json"), "utf8"));
const recordOf = (number: number) => records().find(r => r.url.endsWith(`/pull/${number}`));
const sent = (type: string) => pi.sent.filter(s => s.message.customType === type).map(s => s.message.content ?? "");
const reviewers = async () => (await instance.app<{ spaces: LsSpace[] }>(["ls"])).spaces.filter(s => s.name === "reviewers");
// The terminals of the reviewers space, once they are `want` (herdr-app ls can lag a new or closed
// pane by a moment); one space with one tab, or none.
async function paneTerminals(want: number): Promise<string[]> {
	const list = async () => {
		const spaces = await reviewers();
		if (spaces.length === 0) return [];
		expect(spaces).toHaveLength(1);
		expect(spaces[0].tabs).toHaveLength(1);
		return spaces[0].tabs[0].terminals.map(t => t.terminal);
	};
	await waitFor(async () => (await list()).length === want, `${want} terminals in reviewers`, 5000, 100).catch(() => {});
	return list();
}
const setState = (terminal: string, s: string) => fs.writeFileSync(path.join(sb.home, "agent-state", terminal), s);
// The task an agent got: the fake omp logs its argv (the task is its one word).
const taskOf = (terminal: string) =>
	fs.readFileSync(path.join(sb.home, "fake-agent.log"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as { terminal: string; argv: string[] }).findLast(l => l.terminal === terminal)?.argv.join(" ") ?? "";
const get = (t: string) => hc<HcGet>(sb, ["get", t]);

// Sends one poll and waits until the extension handled it: the drafts file is written last.
async function poll(open: OpenPr[], done: MergedPr[] = []) {
	const drafts = path.join(state, "herdr-pr-autofix/drafts.json");
	const before = fs.existsSync(drafts) ? fs.readFileSync(drafts, "utf8") : "";
	pi.events.emit(pollEvent, { login: ME, open, merged: done } satisfies Poll);
	await waitFor(() => fs.existsSync(drafts) && fs.readFileSync(drafts, "utf8") !== before, "poll handled", 120_000, 50);
}

beforeAll(async () => {
	sb = prepareSandbox(repo);
	state = path.join(sb.home, ".local/state");
	assertNotReal(state);

	// The fake omp, in place of the real omp link: a binary, because a Mac security rule can kill a
	// shell script that gets a long argument (the task).
	const omp = path.join(sb.bin, "omp");
	if (fs.lstatSync(omp).isSymbolicLink()) fs.unlinkSync(omp);
	const b = await run(process.execPath, ["build", "--compile", path.join(repo, "tests/fakes/fake-agent.ts"), "--outfile", omp]);
	if (b.code !== 0) throw new Error(`bun build: ${b.stderr || b.stdout}`);
	// The core passes its env to the terminals it starts.
	process.env.FAKE_AGENT_STATE_DIR = path.join(sb.home, "agent-state");
	// A login shell runs path_helper, which puts the system folders first: put the sandbox bin back in front.
	for (const rc of [".zprofile", ".zshrc", ".profile"]) fs.writeFileSync(path.join(sb.home, rc), `export PATH="${sb.bin}:$PATH"\n`);
	fs.copyFileSync(path.join(repo, "herdr-app/scripts/balance-panes.sh"), path.join(sb.appHome, "scripts/balance-panes.sh"));
	fs.chmodSync(path.join(sb.appHome, "scripts/balance-panes.sh"), 0o755);

	// A local clone of example/demo, as ~/Github/<owner>/<repo> would be: no agent may work in it.
	const local = path.join(sb.home, "Github/example/demo");
	fs.mkdirSync(local, { recursive: true });
	for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://github.com/example/demo.git"]]) await run("git", ["-C", local, ...args]);

	clones = fs.realpathSync(sb.work("clones"));
	process.env.HERDR_PR_AUTOFIX_CLONES = clones;
	await startCore(sb);
	instance = (await Instance.start(sb)).instance;

	const balance = path.join(sb.appHome, "scripts/balance-panes.sh");
	pi = fakePi({
		exec: async (cmd, args, o) => {
			if (process.env.HC_SESSION !== "herdrtest" || !process.env.HERDR_APP_HOME?.startsWith(BENCH_ROOT))
				throw new Error("autofix test: hc or herdr-app would reach the real core or window");
			// gh repo clone <repo> <dir> -- --filter=blob:none --branch <branch>: a local repo on that branch.
			if (cmd === "gh" && args[0] === "repo" && args[1] === "clone") {
				const [, , name, dir] = args;
				if (!dir.startsWith(`${clones}/`)) throw new Error(`autofix test: a clone outside the test folder: ${dir}`);
				clonedTo.push(dir);
				const branch = args[args.indexOf("--branch") + 1];
				await run("git", ["init", "-q", "-b", branch, dir]);
				return run("git", ["-C", dir, "remote", "add", "origin", `https://github.com/${name}.git`]);
			}
			if (cmd !== "hc" && cmd !== "herdr-app" && cmd !== "git" && cmd !== balance) throw new Error(`autofix test: refused to run ${cmd}`);
			const r = await run(cmd, args, { signal: o?.signal });
			pi.execs.push({ at: 0, ms: r.ms, cmd, args });
			return r;
		},
	});
	// Dynamic imports, after HERDR_PR_AUTOFIX_CLONES is set (the module reads it once at import).
	const mod = await import(`${orchFile(repo, "extensions/herdr-pr-autofix.ts")}?autofix-test`);
	expect(mod.CLONES).toBe(clones);
	pollEvent = (await import(orchFile(repo, "extensions/herdr-pr-ready.ts"))).POLL_EVENT;
	mod.default(pi);
}, LONG);

afterAll(async () => {
	for (const s of (await reviewers().catch(() => [])) ?? []) await instance?.app(["do", "space.close", "--id", s.id, "--confirmed", "true"]).catch(() => {});
	if (sb) await stopAll(sb);
});

const drafts = [pr("demo", 1, true), pr("demo", 2, true), pr("other", 3, true)];
const ready = [pr("demo", 1, false), pr("demo", 2, false), pr("other", 3, false)];

test(
	"3 pull requests that move to ready in one poll get 3 agents side by side, each in its own clone",
	async () => {
		await poll(drafts);
		expect(sent("herdr-pr-autofix")).toHaveLength(0);
		await poll(ready);
		const msgs = sent("herdr-pr-autofix");
		expect(msgs).toHaveLength(3);
		for (const m of msgs) expect(m).toContain("result: started");

		// One reviewers space with one tab, and the 3 agents as panes of it.
		const terminals = await paneTerminals(3);
		expect(terminals).toHaveLength(3);

		// 3 different clones, also for the 2 pull requests of example/demo, and never the local clone.
		const recs = [1, 2, 3].map(n => recordOf(n)!);
		const dirs = recs.map(r => r.dir!);
		expect(new Set(dirs).size).toBe(3);
		expect(clonedTo.sort()).toEqual(dirs.map(d => path.join(d, "repo")).sort());
		for (const r of recs) {
			expect(terminals).toContain(r.terminal!);
			const clone = path.join(r.dir!, "repo");
			const branch = await run("git", ["-C", clone, "branch", "--show-current"]);
			expect(branch.stdout.trim()).toBe(`branch-${r.url.split("/").at(-1)}`);
			// It starts in its clone and its task names that clone.
			const info = await get(r.terminal!);
			expect(fs.realpathSync(info.foreground?.cwd ?? info.cwd ?? "")).toBe(clone);
			expect(taskOf(r.terminal!)).toContain(`Work only in your own clone of ${r.url.split("/").slice(3, 5).join("/")} at ${clone}`);
		}
	},
	LONG,
);

test(
	"no second agent for a pull request whose pane is open, or for the same head commit",
	async () => {
		const n = sent("herdr-pr-autofix").length;
		// Same heads again: nothing new.
		await poll(ready);
		// A push by the agent, then a move to draft and back, while its pane is open.
		const pushed = pr("demo", 2, false, "b".repeat(40));
		await poll([ready[0], { ...pushed, isDraft: true }, ready[2]]);
		await poll([ready[0], pushed, ready[2]]);
		expect(sent("herdr-pr-autofix")).toHaveLength(n);
		expect(await paneTerminals(3)).toHaveLength(3);
	},
	LONG,
);

test(
	"a done agent's pane closes and its clone is deleted; a blocked agent keeps both",
	async () => {
		const one = recordOf(1)!;
		const two = recordOf(2)!;
		setState(one.terminal!, "done");
		setState(two.terminal!, "blocked");
		await waitFor(async () => ((await get(one.terminal!)).turn ?? 0) > 0, "demo#1 turn ended", 10_000, 100);
		await waitFor(async () => (await get(two.terminal!)).status?.state === "blocked", "demo#2 blocked", 10_000, 100);
		const open = [ready[0], pr("demo", 2, false, "b".repeat(40)), ready[2]];
		// Done at two polls in a row, at the same turn.
		await poll(open);
		expect(sent("herdr-pr-autofix-closed")).toHaveLength(0);
		await poll(open);
		const closed = sent("herdr-pr-autofix-closed");
		expect(closed).toHaveLength(1);
		expect(closed[0]).toContain("reason: done");
		expect(closed[0]).toContain("pane: demo#1");
		expect(fs.existsSync(one.dir!)).toBe(false);
		expect(recordOf(1)?.terminal).toBeUndefined();
		expect((await paneTerminals(2)).sort()).toEqual([two.terminal!, recordOf(3)!.terminal!].sort());
		expect(fs.existsSync(two.dir!)).toBe(true);
	},
	LONG,
);

test(
	"a merged pull request closes its pane and deletes its clone while the agent still works",
	async () => {
		const three = recordOf(3)!;
		expect((await get(three.terminal!)).status?.state).toBe("working");
		await poll([ready[0], pr("demo", 2, false, "b".repeat(40))], [merged("other", 3)]);
		const closed = sent("herdr-pr-autofix-closed");
		expect(closed).toHaveLength(2);
		expect(closed[1]).toContain("reason: merged");
		expect(fs.existsSync(three.dir!)).toBe(false);
		expect(recordOf(3)).toBeUndefined();
		expect(await paneTerminals(1)).toEqual([recordOf(2)!.terminal!]);
	},
	LONG,
);

test(
	"the last pane closes with its space, and the blocked agent's clone goes when its pull request closes",
	async () => {
		const two = recordOf(2)!;
		await poll([ready[0]]);
		const closed = sent("herdr-pr-autofix-closed");
		expect(closed).toHaveLength(3);
		expect(closed[2]).toContain("reason: closed");
		expect(fs.existsSync(two.dir!)).toBe(false);
		expect(await paneTerminals(0)).toEqual([]);
		expect(await reviewers()).toHaveLength(0);
		// Only the record of demo#1 is left, with no pane and no clone, and the clones folder is empty.
		expect(records().map(r => [r.url.split("/").at(-1), r.terminal, r.dir])).toEqual([["1", undefined, undefined]]);
		expect(fs.readdirSync(clones)).toEqual([]);
	},
	LONG,
);
