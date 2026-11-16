// prs-panel: the Pull requests view (herdr-app/mods/t3-prs: main.js, owners.js, comments.js).
// It polls GitHub every 5 seconds through `gh api graphql`, then fetches comments (comments.js)
// for each pull request whose updatedAt changed, and checks code owners (owners.js) for each
// approved one whose head, base or reviews changed. Measured here:
//   - real GitHub: one poll with the mod's own query through curl (network only) and through gh
//     (as the mod runs it), gh's start alone, and one real comments call (3 points per suite run,
//     whatever --runs). BENCH_PRS_OWNERS=1 adds one owners.js call (+1 point); BENCH_PRS_PROFILE=1
//     times the poll with one group of fields left out at a time (+9 points, logged only);
//   - in this process (lib/modvm.ts runs main.js with stub Herdr modules): parse + state update +
//     render after a poll, render alone with 20/50/100 open pull requests, the work of a poll that
//     changed nothing, and how many gh calls a poll makes;
//   - Move to Ready from the right-click menu through the fake gh (real process starts), until the
//     follow-up poll redrew;
//   - the same poll and render in Herdr's own QuickJS, through `herdr-app check` on a probe copy of
//     the mod in the sandbox (lib/prs-panel-probe.ts). Bun's JIT runs the same render about 30
//     times faster, so the in-process numbers rank changes; the QuickJS ones are Herdr's cost
//     (JavaScript only: check does no layout or paint).
import * as fs from "node:fs";
import * as path from "node:path";
import { commentsFixture, installFakeGh, ownersFixture, prFixture, QUERY_WORD, teamFixture } from "../lib/fakegh.ts";
import { ghStartMs, graphql, viaGh } from "../lib/github.ts";
import { find, host, loadMod, ModVm, nextIdle, resetHost, type ExecResult } from "../lib/modvm.ts";
import { now, run } from "../lib/proc.ts";
import { median } from "../lib/stats.ts";
import { type ProbeInput, type ProbeResult, runProbe } from "../lib/prs-panel-probe.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

const ID = "prs-panel";
// Renders per draw sample: one sample is the median of these.
const RENDERS = 50;
// Polls per poll-to-draw sample: one sample is the median of these.
const POLLS = 20;
// ms of QuickJS work per herdr-app check probe: check stops a mod that works much longer
// ("interrupted"; with this probe, already at 200 ms).
const PROBE_BUDGET = 80;

// The text of `const NAME = \`…\`;` in a mod file: a query exactly as the mod sends it.
function constText(file: string, name: string): string {
	const m = fs.readFileSync(file, "utf8").match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
	if (!m) throw new Error(`no ${name} in ${file}`);
	return m[1];
}

// Which call a gh command line is: the poll, one of the extra queries, or a pr/repo command.
function kindOf(args: string[]): string {
	if (args[0] !== "api") return `${args[0]} ${args[1]}`;
	const query = args[3] ?? "";
	for (const [kind, word] of Object.entries(QUERY_WORD)) if (query.includes(word)) return kind;
	return "poll";
}

function countKinds(calls: { args: string[] }[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const c of calls) out[kindOf(c.args)] = (out[kindOf(c.args)] ?? 0) + 1;
	return out;
}

// An exec that answers gh at once from strings in memory (no process), by kind of call.
function instant(answers: Record<string, string>) {
	return async (cmd: string, args: string[]): Promise<ExecResult> => {
		const stdout = cmd === "gh" ? answers[kindOf(args)] : undefined;
		return stdout ? { code: 0, stdout, stderr: "" } : { code: 1, stdout: "", stderr: `bench: no answer for ${cmd} ${args[0]} ${args[1]}` };
	};
}

// An exec that runs the fake gh script (by its full path, so never the real gh); nothing else runs.
function viaFakeGh(gh: string) {
	return async (cmd: string, args: string[]): Promise<ExecResult> => {
		if (cmd !== "gh") return { code: 1, stdout: "", stderr: `bench: only gh runs here, not ${cmd}` };
		return run(gh, args);
	};
}

const extras = () => ({
	comments: JSON.stringify(commentsFixture()),
	owners: JSON.stringify(ownersFixture()),
	team: JSON.stringify(teamFixture()),
});

// The poll's query with one group of fields left out at a time (for BENCH_PRS_PROFILE=1). A
// variant whose text no longer matches the mod's query is left out.
function queryVariants(query: string): [string, string][] {
	const cut = (from: string, to = from, put = "") => {
		const a = query.indexOf(from);
		const b = a < 0 ? -1 : query.indexOf(to, a);
		return b < 0 ? null : query.slice(0, a) + put + query.slice(b + to.length);
	};
	const checks = "commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
	const noMergeable = cut(" mergeable mergeStateStatus");
	const variants: [string, string | null][] = [
		["full", query],
		["without mergeable mergeStateStatus", noMergeable],
		["without reviewDecision", cut(" reviewDecision")],
		["without statusCheckRollup", cut(checks)],
		["without mergeable and statusCheckRollup", noMergeable && noMergeable.replace(checks, "")],
		["without latestReviews", cut("latestReviews(first: 20) { nodes { state author { login } } }")],
		["without merged", cut("merged: pullRequests(", "repository { name } } }")],
		["open: only number title url", cut("nodes { number title isDraft", checks, "nodes { number title url")],
		["full again", query],
	];
	return variants.filter((v): v is [string, string] => v[1] !== null);
}

const measure = (name: string, label: string, kind: Measure["kind"], samples: number[], note?: string, unit: Measure["unit"] = "ms", better: Measure["better"] = "lower"): Measure => ({
	id: `${ID}.${name}`,
	label,
	unit,
	kind,
	better,
	samples,
	note,
});

export default {
	id: ID,
	title: "Pull requests view: poll, draw and a menu action",
	async run(ctx: Ctx): Promise<Measure[]> {
		const modDir = path.join(ctx.repo, "herdr-app/mods/t3-prs");
		const out: Measure[] = [];
		const facts: string[] = [];
		resetHost("t3-prs");
		const Mod = await loadMod(modDir);

		// --- 1. Poll to draw, and a poll that changed nothing (in memory, no process) ---------------
		const answers = { poll: JSON.stringify(prFixture(20, 20)), ...extras() };
		{
			const total: number[] = [];
			const parse: number[] = [];
			const draw: number[] = [];
			const idle: number[] = [];
			let got = 0;
			const answer = instant(answers);
			host.exec = async (cmd, args) => {
				const r = await answer(cmd, args);
				if (kindOf(args) === "poll") got = now();
				return r;
			};
			const vm = new ModVm(Mod).init();
			for (let s = 0; s < ctx.runs; s++) {
				const t: number[] = [];
				const p: number[] = [];
				const d: number[] = [];
				const z: number[] = [];
				// The first rounds of the first sample warm the JIT and fill the comment and owner caches.
				for (let i = s === 0 ? -10 : 0; i < POLLS; i++) {
					// A poll that changed the list: the mod parses, compares, saves and asks for a redraw.
					vm.mod.prs = null;
					vm.mod.merged = null;
					vm.draws.length = 0;
					await vm.mod.load(vm.cx());
					const first = vm.draws[0];
					const answered = got;
					// The same poll again: nothing changed, so no redraw; this is most polls.
					await vm.mod.load(vm.cx());
					const quiet = now() - got;
					if (i < 0 || !first) continue;
					t.push(first.at - answered);
					d.push(first.ms);
					p.push(first.at - first.ms - answered);
					z.push(quiet);
				}
				total.push(median(t));
				parse.push(median(p));
				draw.push(median(d));
				idle.push(median(z));
			}
			out.push(
				measure("poll-to-draw", "Poll answer in hand to new tree drawn (20 open, 20 merged)", "local", total, `median of ${POLLS} polls per sample; Bun JIT, not QuickJS`),
				measure("poll-parse", "Poll answer to redraw asked: JSON.parse, map, compare, save", "local", parse, "part of poll-to-draw before render()"),
				measure("poll-idle", "A poll that changed nothing: parse, compare and cache checks, no redraw", "local", idle, "the JS work behind most 5 s polls"),
			);
			facts.push(`poll-to-draw: parse+state ${median(parse).toFixed(3)} ms, render ${median(draw).toFixed(3)} ms; answer ${(answers.poll.length / 1024).toFixed(0)} KB`);
		}

		// --- 2. render() alone with 20, 50 and 100 open pull requests ------------------------------
		for (const n of [20, 50, 100]) {
			host.exec = instant({ poll: JSON.stringify(prFixture(n, 20)), ...extras() });
			const vm = new ModVm(Mod).init();
			vm.drawOnNotify = false;
			// One poll fills the list, the comment counts and the code owner results, as in use.
			await vm.mod.load(vm.cx());
			for (let i = 0; i < 30; i++) vm.draw();
			const samples: number[] = [];
			for (let s = 0; s < ctx.runs; s++) {
				vm.draws.length = 0;
				for (let i = 0; i < RENDERS; i++) vm.draw();
				samples.push(median(vm.draws.map(d => d.ms)));
			}
			const last = vm.draws.at(-1)!;
			out.push(
				measure(
					`draw-${n}`,
					`render() with ${n} open and 20 merged pull requests`,
					"local",
					samples,
					`median of ${RENDERS} renders per sample; ${last.elements} elements, ${last.calls} builder calls per render${n > 50 ? "; the query asks first: 50, so 100 is a what-if" : ""}`,
				),
			);
			facts.push(`draw-${n}: ${last.elements} elements, ${last.calls} builder calls, ${median(samples).toFixed(3)} ms`);
		}

		// --- 3. gh calls per poll, through the fake gh (real process starts) -----------------------
		const fake = installFakeGh(ctx.sandbox);
		const gh = path.join(ctx.sandbox.bin, "gh");
		const fixture = prFixture(20, 20);
		fake.setGraphql(fixture);
		fake.setQuery("comments", commentsFixture());
		fake.setQuery("owners", ownersFixture());
		fake.setQuery("team", teamFixture());
		host.exec = viaFakeGh(gh);
		{
			const startup: number[] = [];
			let counts: Record<string, number>[] = [];
			for (let s = 0; s < ctx.runs; s++) {
				// A fresh copy: empty comment and owner caches, as after Herdr starts.
				const vm = new ModVm(Mod).init();
				host.calls = [];
				const t0 = now();
				await vm.mod.load(vm.cx());
				startup.push(now() - t0);
				if (s > 0) continue;
				const first = countKinds(host.calls);
				host.calls = [];
				await vm.mod.load(vm.cx());
				const steady = countKinds(host.calls);
				// A push to one approved pull request: new head commit and updatedAt.
				const pushed = structuredClone(fixture);
				const node = pushed.data.viewer.pullRequests.nodes[0];
				node.headRefOid = "f".repeat(40);
				node.updatedAt = new Date().toISOString();
				fake.setGraphql(pushed);
				host.calls = [];
				await vm.mod.load(vm.cx());
				counts = [first, steady, countKinds(host.calls)];
				fake.setGraphql(fixture);
			}
			const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
			const show = (c: Record<string, number>) => Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ");
			const [first, steady, push] = counts;
			out.push(
				measure("calls-startup", "gh calls in the first poll (20 open, 7 approved)", "local", [sum(first)], show(first), "count"),
				measure("calls-steady", "gh calls in a poll where nothing changed", "local", [sum(steady)], show(steady), "count"),
				measure("calls-one-push", "gh calls in a poll after a push to one approved pull request", "local", [sum(push)], show(push), "count"),
				measure("startup-local", "First poll and all its extra calls through the fake gh (process starts only)", "local", startup, "no network; owners.js keeps team members 30 min, so only the first sample asks for the team"),
			);
			facts.push(`calls: startup {${show(first)}}, steady {${show(steady)}}, one push {${show(push)}}`);
		}

		// --- 4. Move to Ready / Move to Draft from the right-click menu ----------------------------
		{
			const ready = (draft: boolean) => {
				const f = structuredClone(fixture);
				const node = f.data.viewer.pullRequests.nodes[1];
				node.isDraft = draft;
				node.updatedAt = new Date().toISOString();
				return f;
			};
			const viaFake = viaFakeGh(gh);
			// GitHub changes the pull request after `gh pr ready`: the fake answers the next poll so.
			host.exec = async (cmd, args) => {
				const r = await viaFake(cmd, args);
				if (args[0] === "pr" && args[1] === "ready") fake.setGraphql(ready(args.includes("--undo")));
				return r;
			};
			const vm = new ModVm(Mod).init();
			await vm.mod.load(vm.cx());
			vm.start(1); // the command loop: run("t3-prs.ready:<url>") arrives through nextCommand()
			await Bun.sleep(10);
			const samples: number[] = [];
			const phases: Record<string, number[]> = { "click to gh pr ready": [], "gh pr ready": [], "fake gh script": [], "gap to poll": [], poll: [], "poll answer to drawn": [] };
			for (let s = 0; s < ctx.runs; s++) {
				const p = vm.mod.prs.find((q: { number: number }) => q.number === 1001);
				// The menu is a second copy of the mod, opened with props.menu, as Herdr opens the popup.
				host.props = { menu: p, overlay: "menu" };
				const menu = new ModVm(Mod).init(host.props);
				const item = find(menu.draw(), p.draft ? "ready" : "draft");
				if (!item) throw new Error("the menu has no Move to Ready/Draft item");
				vm.draws.length = 0;
				host.calls = [];
				fake.clear();
				const done = nextIdle();
				const t0 = now();
				item.handlers.on_click();
				host.props = {};
				await done;
				const pr = host.calls.find(c => c.args[1] === "ready");
				const poll = host.calls.find(c => kindOf(c.args) === "poll");
				const drawn = poll && vm.draws.find(d => d.at >= poll.end);
				if (!pr || !poll || !drawn) {
					ctx.log(`${ID}: action sample ${s} incomplete (gh pr ready ${Boolean(pr)}, poll ${Boolean(poll)}, draw ${Boolean(drawn)})`);
					continue;
				}
				const script = fake.calls().find(c => c.args.startsWith("pr ready"));
				samples.push(drawn.at - t0);
				phases["click to gh pr ready"].push(pr.start - t0);
				phases["gh pr ready"].push(pr.end - pr.start);
				if (script) phases["fake gh script"].push(script.end - script.start);
				phases["gap to poll"].push(poll.start - pr.end);
				phases.poll.push(poll.end - poll.start);
				phases["poll answer to drawn"].push(drawn.at - poll.end);
			}
			const split = Object.entries(phases).map(([k, v]) => `${k} ${median(v).toFixed(1)}`).join(", ");
			out.push(measure("action", "Move to Ready/Draft: menu click to the follow-up poll drawn (fake gh)", "local", samples, `two fake gh processes; real use adds gh's network for the mutation and the poll. ms: ${split}`));
			facts.push(`action phases (ms): ${split}`);
		}

		// --- 5. The same poll and render in Herdr's QuickJS (herdr-app check, no window) -----------
		try {
			const dir = ctx.sandbox.work(ID);
			const probe = (n: number, variant?: ProbeInput["variant"]) =>
				runProbe(ctx.sandbox, modDir, dir, { answers: { poll: JSON.stringify(prFixture(n, 20)), ...extras() }, polls: variant ? 1 : POLLS, renders: RENDERS, budget: PROBE_BUDGET, variant });
			const sizes = [20, 50, 100];
			const got = new Map<number, ProbeResult[]>(sizes.map(n => [n, []]));
			for (let s = 0; s < ctx.runs; s++) for (const n of sizes) got.get(n)!.push(await probe(n));
			const at = (n: number, f: (r: ProbeResult) => number) => got.get(n)!.map(f);
			const fit = (n: number) => `${Math.min(...at(n, r => r.renders))}-${Math.max(...at(n, r => r.renders))}`;
			for (const n of sizes)
				out.push(measure(`quickjs-draw-${n}`, `render() with ${n} open and 20 merged, in Herdr's QuickJS`, "local", at(n, r => r.render), `one herdr-app check per sample, median of the ${fit(n)} renders that fit in its ~0.5 s limit`));
			out.push(
				measure("quickjs-poll", "A poll that changed the list: load() in QuickJS (20 open, caches warm)", "local", at(20, r => r.poll), "parse, compare, save and the cache checks, no render"),
				measure("quickjs-poll-idle", "A poll that changed nothing: load() in QuickJS (20 open)", "local", at(20, r => r.quiet), "the JS work behind most 5 s polls"),
				measure("quickjs-first-poll", "The first poll after start: load() in QuickJS with 20 comment and 7 owner answers", "local", at(20, r => r.first), "JS work only: answers come from memory"),
			);
			for (const n of sizes) facts.push(`quickjs n=${n}: first ${median(at(n, r => r.first)).toFixed(1)}, poll ${median(at(n, r => r.poll)).toFixed(1)}, quiet ${median(at(n, r => r.quiet)).toFixed(1)}, render ${median(at(n, r => r.render)).toFixed(1)} ms`);
			// Where render's time goes: each part switched off in every other render (20 open).
			for (const v of ["talk", "approval", "merged"] as const) {
				const r = await probe(20, v);
				facts.push(`quickjs render without ${v}: ${r.render.toFixed(2)} -> ${r.variantRender?.toFixed(2)} ms (${r.renders} pairs)`);
			}
		} catch (err) {
			ctx.log(`${ID}: QuickJS probe left out: ${err}`);
		}

		// --- 5. Real GitHub: one call of each kind per suite run (3 points) ------------------------
		{
			const starts: number[] = [];
			for (let s = 0; s < ctx.runs; s++) starts.push(await ghStartMs(ctx));
			out.push(measure("gh-start", "gh --version: gh's own start, no network", "local", starts, "the floor of every gh call the mod makes"));
			facts.push(`gh start ${median(starts).toFixed(1)} ms`);
		}
		const query = constText(path.join(modDir, "main.js"), "QUERY");
		let viewer: any = null;
		try {
			const g = await graphql(ctx, query);
			viewer = g.data.viewer;
			const text = JSON.stringify({ data: g.data });
			const t0 = now();
			for (let i = 0; i < 20; i++) JSON.parse(text);
			const parseMs = (now() - t0) / 20;
			out.push(
				measure("poll-network", "One real poll (the mod's query), curl total", "network", [g.totalMs], `1 sample per suite run, ${g.cost} point; dns ${g.dnsMs.toFixed(0)}, connect ${g.connectMs.toFixed(0)}, tls ${g.tlsMs.toFixed(0)} ms`),
				measure("poll-first-byte", "The same poll: time to GitHub's first byte", "network", [g.firstByteMs], "context: server time plus connection setup", "ms", "none"),
			);
			facts.push(
				`real poll: ${viewer.pullRequests.nodes.length} open, ${viewer.merged.nodes.length} merged, ${(text.length / 1024).toFixed(0)} KB, JSON.parse ${parseMs.toFixed(3)} ms (Bun); curl ${g.totalMs.toFixed(0)} ms (first byte ${g.firstByteMs.toFixed(0)}, tls done ${g.tlsMs.toFixed(0)})`,
			);
		} catch (err) {
			ctx.log(`${ID}: real poll through curl failed, poll-network left out: ${err}`);
		}
		try {
			const v = await viaGh(ctx, query);
			out.push(measure("poll-gh", "One real poll through gh, as the mod runs it", "total", [v.ms], `1 sample per suite run, ${v.cost} point; gh start + its own connection + GitHub`));
			// The mod waits EVERY ms after each poll ends, so one poll starts every EVERY + poll time.
			const every = Number(fs.readFileSync(path.join(modDir, "main.js"), "utf8").match(/const EVERY = (\d+);/)?.[1] ?? 5000);
			out.push(measure("poll-points", "GitHub points the mod's own poll spends per hour (one copy open)", "network", [Math.round((3600_000 / (every + v.ms)) * v.cost)], `3600 s / (${every / 1000} s wait + one poll) x ${v.cost} point; comment and owner calls come on top`, "points/h"));
			facts.push(`real poll through gh ${v.ms.toFixed(0)} ms`);
		} catch (err) {
			ctx.log(`${ID}: real poll through gh failed, poll-gh left out: ${err}`);
		}
		// Only with BENCH_PRS_PROFILE=1 (1 point per variant, 9 in all): the poll's GitHub time with one
		// group of fields left out at a time, to see which field makes GitHub slow. Logged, not measured.
		if (process.env.BENCH_PRS_PROFILE === "1") {
			for (const [name, q] of queryVariants(query)) {
				try {
					const g = await graphql(ctx, q);
					ctx.log(`${ID}: profile ${name}: first byte ${g.firstByteMs.toFixed(0)} ms, total ${g.totalMs.toFixed(0)} ms, cost ${g.cost}`);
				} catch (err) {
					ctx.log(`${ID}: profile ${name} failed: ${err}`);
				}
			}
		}
		// One comments call on one of the person's own pull requests (open first, else merged).
		const open = viewer?.pullRequests.nodes[0];
		const target = open
			? { repo: open.repository.nameWithOwner, number: open.number, base: open.baseRefName }
			: viewer?.merged.nodes[0] && { repo: new URL(viewer.merged.nodes[0].url).pathname.split("/").slice(1, 3).join("/"), number: viewer.merged.nodes[0].number, base: "main" };
		if (target) {
			const [owner, name] = target.repo.split("/");
			try {
				const c = await graphql(ctx, constText(path.join(modDir, "comments.js"), "QUERY"), { owner, name, number: target.number });
				out.push(measure("comments-network", "One real comments.js call, curl total", "network", [c.totalMs], `1 sample per suite run, ${c.cost} point; the mod makes one per pull request whose updatedAt changed`));
				facts.push(`real comments call ${c.totalMs.toFixed(0)} ms (first byte ${c.firstByteMs.toFixed(0)})`);
			} catch (err) {
				ctx.log(`${ID}: real comments call failed, comments-network left out: ${err}`);
			}
			// owners.js's query costs one more point: only when asked for.
			if (process.env.BENCH_PRS_OWNERS === "1" && open) {
				try {
					const at = (f: string) => `${target.base}:${f}`;
					const o = await graphql(ctx, constText(path.join(modDir, "owners.js"), "PR_QUERY"), { owner, name, number: target.number, a: at(".github/CODEOWNERS"), b: at("CODEOWNERS"), c: at("docs/CODEOWNERS") });
					out.push(measure("owners-network", "One real owners.js files + CODEOWNERS call, curl total", "network", [o.totalMs], `only with BENCH_PRS_OWNERS=1; ${o.cost} point`));
				} catch (err) {
					ctx.log(`${ID}: real owners call failed: ${err}`);
				}
			}
		} else ctx.log(`${ID}: no pull request to read comments of; comments-network left out`);

		for (const f of facts) ctx.log(`${ID}: ${f}`);
		return out;
	},
} satisfies Case;
