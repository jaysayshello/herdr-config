// pr-ready: the orchestrator's pull request poll (orchestrator/.omp/extensions/herdr-pr-ready.ts),
// the per-poll work of herdr-pr-autofix.ts that listens to it, and the GitHub points per hour that
// every poll on this Mac spends together (t3-prs in each Herdr window, its follow-up queries, and
// herdr-pr-ready).
// The GraphQL queries are read from the repo files at run time, so a change to a query shows here.
// Real GitHub reads: the poll query once per run through curl and once through gh, the
// extension's own poll (all its queries) a few times, plus one call for each other query shape
// per suite run. The local part loads both extensions with a fake `pi` whose exec answers gh and
// hc from memory, so no real gh, git, hc or herdr-app runs from them, and
// their state files land in the sandbox home.
import { assertNotReal, REAL_HOME } from "../lib/guard.ts";
import { type ExecOptions, fakeCtx, fakePi, orchFile } from "../lib/orch.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prFixture } from "../lib/fakegh.ts";
import { ghStartMs, graphql, viaGh } from "../lib/github.ts";
import { median } from "../lib/stats.ts";
import { now, run } from "../lib/proc.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

// The terminal id the fake session claims to be. Only the fake exec below ever sees it.
const FAKE_TERMINAL = "bench-fake-terminal-0";
// Polls before the measured ones: the first poll on a machine only records (no state file yet),
// and the first calls warm up Bun's JIT.
const WARMUP = 2;
// A cap on the real calls one code owner check may make here (file pages, team pages).
const OWNER_CALLS_MAX = 4;
// How many Herdr windows run t3-prs: one copy of the panel per window. The person runs one.
const WINDOWS = Number(process.env.BENCH_HERDR_WINDOWS ?? 1);
// Real polls of the extension itself: each costs a point or two, so a few at most.
const REAL_RUNS = 3;

// The fields of t3-prs's answer this case reads.
interface T3Pr {
	number: number;
	updatedAt: string;
	baseRefName: string;
	author: { login: string } | null;
	repository: { nameWithOwner: string };
	latestReviews: { nodes: { state: string; author: { login: string } | null }[] };
}
interface Viewer {
	login: string;
	pullRequests: { nodes: unknown[] };
	merged: { nodes: unknown[] };
}

// The text of `const NAME = ...;` in a source file: a template string or a number.
function constant(file: string, name: string): string {
	const src = fs.readFileSync(file, "utf8");
	const m = src.match(new RegExp(`const ${name} = (\`[\\s\\S]*?\`|[0-9_]+);`));
	if (!m) throw new Error(`no const ${name} in ${path.basename(file)}`);
	return m[1].startsWith("`") ? m[1].slice(1, -1) : m[1];
}
const num = (s: string) => Number(s.replace(/_/g, ""));
const round2 = (xs: number[]) => Math.round(median(xs) * 100) / 100;
const why = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A command result as pi.exec gives it.
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", killed: false });
const refused = { code: 1, stdout: "", stderr: "bench: the fake exec refuses this command", killed: false };

// Lets every queued promise job run. The autofix queue does no real I/O here (exec is answered
// from memory), so it ends within them.
function flush(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

// The profile: the same query without mergeStateStatus, which GitHub works out per pull request
// on each read. Asked on the first PROFILE_RUNS runs only, to keep the spend small.
const PROFILE_RUNS = 2;

async function network(ctx: Ctx, query: string) {
	const out = { curl: [] as number[], server: [] as number[], connect: [] as number[], gh: [] as number[], ghStart: [] as number[], noMergeState: [] as number[], cost: 0, viewer: undefined as Viewer | undefined };
	const lighter = query.replace(/\s*mergeStateStatus\b/, "");
	for (let i = 0; i < ctx.runs; i++) {
		try {
			const r = await graphql(ctx, query);
			out.curl.push(r.totalMs);
			// Request sent to first byte: GitHub working on the query, plus one round trip.
			out.server.push(r.firstByteMs - r.tlsMs);
			// DNS + TCP + TLS: curl opens a new connection each time, as each gh run does.
			out.connect.push(r.tlsMs);
			out.cost = r.cost;
			out.viewer ??= r.data.viewer;
		} catch (err) {
			ctx.log(`pr-ready: curl poll failed: ${why(err)}`);
		}
		try {
			out.gh.push((await viaGh(ctx, query)).ms);
		} catch (err) {
			ctx.log(`pr-ready: gh poll failed: ${why(err)}`);
		}
		out.ghStart.push(await ghStartMs(ctx));
		if (i >= PROFILE_RUNS || lighter === query) continue;
		try {
			const r = await graphql(ctx, lighter);
			out.noMergeState.push(r.firstByteMs - r.tlsMs);
		} catch (err) {
			ctx.log(`pr-ready: profile query failed: ${why(err)}`);
		}
	}
	return out;
}

// The real gh login's token, as lib/github.ts gets it (it does not export its copy).
async function realToken(ctx: Ctx): Promise<string> {
	const r = await run(ctx.sandbox.realGh, ["auth", "token"], { env: { HOME: REAL_HOME } });
	if (r.code !== 0 || !r.stdout.trim()) throw new Error("gh auth token failed: is gh logged in?");
	return r.stdout.trim();
}

// What the fake exec gives for `gh api graphql <args>`: from memory, or from the real gh.
type GraphqlAnswer = (args: string[], o?: ExecOptions) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

// Loads herdr-pr-ready.ts (and herdr-pr-autofix.ts when `autofix`) with a fake pi and starts a
// session in the space "orchestrator", catching the poll timer instead of waiting for it.
async function loadPoller(ctx: Ctx, answer: GraphqlAnswer, autofix: boolean) {
	const readyFile = orchFile(ctx.repo, "extensions/herdr-pr-ready.ts");
	const first = num(constant(readyFile, "FIRST_MS"));
	const every = num(constant(readyFile, "EVERY_MS"));
	const calls: { cmd: string; args: string[]; answered: boolean }[] = [];
	const pi = fakePi({
		async exec(cmd, args, o) {
			if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
				calls.push({ cmd, args, answered: true });
				return answer(args, o);
			}
			if (cmd === "hc" && args[0] === "get" && args[1] === FAKE_TERMINAL) {
				calls.push({ cmd, args, answered: true });
				return ok(JSON.stringify({ labels: { where: "orchestrator / 1" } }));
			}
			// git, other gh commands, herdr-app (new tabs), other hc calls, afplay, the alert script.
			calls.push({ cmd, args, answered: false });
			return refused;
		},
	});
	// Dynamic: orch.ts must register its stub module before these files load.
	(await import(readyFile)).default(pi);
	if (autofix) (await import(orchFile(ctx.repo, "extensions/herdr-pr-autofix.ts"))).default(pi);

	// The poll's timer: setTimeout(FIRST_MS) at session start, setTimeout(EVERY_MS) after each poll.
	// Those two are caught (the test runs them); every other timer runs as usual.
	let next: (() => Promise<void>) | undefined;
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => Promise<void>, ms?: number, ...rest: unknown[]) => {
		if (ms === first || ms === every) {
			next = fn;
			return undefined;
		}
		return realSetTimeout(fn, ms, ...rest);
	}) as typeof setTimeout;

	// HC_TERMINAL_ID only while session_start reads it, so no child process of a later step gets it.
	const saved = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_ID = FAKE_TERMINAL;
	try {
		await pi.fire("session_start", {}, fakeCtx());
	} finally {
		if (saved === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = saved;
	}
	const end = async () => {
		await pi.fire("session_shutdown");
		globalThis.setTimeout = realSetTimeout;
	};
	if (!next) {
		await end();
		throw new Error("herdr-pr-ready scheduled no poll at session start");
	}
	// One poll as the timer would run it; it schedules the next one (caught again).
	const poll = async () => {
		const fn = next;
		next = undefined;
		if (!fn) throw new Error("herdr-pr-ready scheduled no next poll");
		await fn();
	};
	return { pi, poll, end, calls };
}

// The local time of `n` polls, each the poll itself plus the autofix queue it starts.
async function timePolls(poll: () => Promise<void>, n: number): Promise<number[]> {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const t0 = now();
		await poll();
		await flush();
		out.push(now() - t0);
	}
	return out;
}

export default {
	id: "pr-ready",
	title: "Orchestrator PR poll: network, gh, local work, and GitHub points per hour",
	async run(ctx) {
		const measures: Measure[] = [];
		const readyFile = orchFile(ctx.repo, "extensions/herdr-pr-ready.ts");
		const QUERY = constant(readyFile, "QUERY");
		const EVERY_MS = num(constant(readyFile, "EVERY_MS"));

		// 1. Network: the poll query as GitHub sees it (curl) and as the extension sends it (gh).
		const net = await network(ctx, QUERY);
		if (net.curl.length)
			measures.push(
				{ id: "pr-ready.poll-network", label: "Poll query, GitHub round trip (curl)", unit: "ms", kind: "network", samples: net.curl, note: `${net.cost} point(s) per poll; a new connection each time, as each gh run opens one` },
				{ id: "pr-ready.poll-server", label: "Poll query, request sent to first byte", unit: "ms", kind: "network", samples: net.server },
				{ id: "pr-ready.poll-connect", label: "Poll query, DNS + TCP + TLS", unit: "ms", kind: "network", samples: net.connect },
			);
		if (net.gh.length) measures.push({ id: "pr-ready.poll-gh", label: "Poll query through gh, as the extension runs it", unit: "ms", kind: "total", samples: net.gh });
		measures.push({ id: "pr-ready.gh-start", label: "gh start without network (gh --version)", unit: "ms", kind: "local", samples: net.ghStart });
		if (net.noMergeState.length)
			measures.push({ id: "pr-ready.poll-server-no-merge-state", label: "Profile: poll query without mergeStateStatus, request sent to first byte", unit: "ms", kind: "network", better: "none", samples: net.noMergeState, note: `first ${PROFILE_RUNS} runs only; compare with poll-server` });

		// The state files the code under test computes from os.homedir(): they must be the sandbox ones.
		const stateDir = path.join(os.homedir(), ".local/state");
		const readyState = path.join(stateDir, "herdr-pr-ready/notified.json");
		const drafts = path.join(stateDir, "herdr-pr-autofix/drafts.json");
		assertNotReal(readyState);
		assertNotReal(drafts);
		if (!readyState.startsWith(`${ctx.sandbox.home}/`)) throw new Error(`state path ${readyState} is not in the sandbox`);

		// 2. The extension's own poll against real GitHub, end to end: every gh graphql call it makes
		// (the main query, and any follow-up such as a check query) through the real gh, until it
		// sends the poll event. The answers are kept for the local part below.
		const { POLL_EVENT } = await import(readyFile);
		const recorded = { main: undefined as string | undefined, check: undefined as string | undefined };
		const pollReal: number[] = [];
		const callsPerPoll: number[] = [];
		const token = await realToken(ctx);
		let firstCall: number | undefined;
		let emitted: number | undefined;
		let calls = 0;
		const realGh: GraphqlAnswer = async (args, o) => {
			firstCall ??= now();
			calls++;
			const r = await run(ctx.sandbox.realGh, args, { env: { GH_TOKEN: token }, signal: o?.signal, timeoutMs: o?.timeout });
			// The suite cannot add rateLimit to a query under test: 1 point per call is GitHub's
			// smallest cost, and what these queries cost when asked with rateLimit.
			ctx.spend(1);
			if (r.code === 0) {
				if (args.some(a => a.includes("nodes(ids:"))) recorded.check ??= r.stdout;
				else recorded.main ??= r.stdout;
			}
			return r;
		};
		const live = await loadPoller(ctx, realGh, false);
		live.pi.events.on(POLL_EVENT, () => (emitted = now()));
		try {
			for (let i = 0; i < Math.min(ctx.runs, REAL_RUNS); i++) {
				firstCall = emitted = undefined;
				calls = 0;
				await live.poll();
				if (firstCall === undefined || emitted === undefined) ctx.log("pr-ready: a real poll sent no poll event (gh failed?)");
				else {
					pollReal.push(emitted - firstCall);
					callsPerPoll.push(calls);
				}
			}
		} finally {
			await live.end();
		}
		const gqlPerPoll = callsPerPoll.length ? median(callsPerPoll) : 1;
		if (pollReal.length)
			measures.push({ id: "pr-ready.poll-real", label: "The extension's own poll on real GitHub, first gh call to poll event", unit: "ms", kind: "total", samples: pollReal, note: `${gqlPerPoll} gh graphql call(s) per poll, about 1 point each (estimated); ${Math.min(ctx.runs, REAL_RUNS)} polls at most` });

		// 3. Local: the extensions' own work per poll, with gh answered at once from memory: the
		// recorded real answers (the poll's own, else the suite's without its rateLimit), or 30 fixture PRs.
		const viewer: Viewer = recorded.main ? JSON.parse(recorded.main).data.viewer : (net.viewer ?? prFixture(30).data.viewer);
		if (!recorded.main && !net.viewer) ctx.log("pr-ready: no real poll answer; poll-local uses prFixture(30)");
		// A check query asks by node id: give fixture PRs one.
		for (const p of viewer.pullRequests.nodes as { id?: string; number: number }[]) p.id ??= `PR_bench_${p.number}`;
		const stdout = JSON.stringify({ data: { viewer } });
		const openCount = viewer.pullRequests.nodes.length;
		const byId = new Map<string, string>();
		for (const p of viewer.pullRequests.nodes as { id: string; mergeStateStatus?: string }[]) if (p.mergeStateStatus) byId.set(p.id, p.mergeStateStatus);
		for (const n of recorded.check ? (JSON.parse(recorded.check).data.nodes as ({ id: string; mergeStateStatus: string } | null)[]) : []) if (n) byId.set(n.id, n.mergeStateStatus);
		// `nodes(ids: [...]) { ... on PullRequest { id mergeStateStatus } }`: the recorded status of
		// each id (BLOCKED when none was recorded); any other query gets the main answer.
		const fromMemory: GraphqlAnswer = async args => {
			const ids = args.join(" ").match(/nodes\(ids: (\[[^\]]*\])/)?.[1];
			if (!ids) return ok(stdout);
			const nodes = (JSON.parse(ids) as string[]).map(id => ({ id, mergeStateStatus: byId.get(id) ?? "BLOCKED" }));
			return ok(JSON.stringify({ data: { nodes } }));
		};

		const both = await loadPoller(ctx, fromMemory, true);
		let pollLocal: number[] = [];
		const eventLocal: number[] = [];
		try {
			await timePolls(both.poll, WARMUP);
			// The polls wrote their files in the sandbox home, so the code used the sandbox paths.
			if (!fs.existsSync(readyState)) throw new Error("herdr-pr-ready wrote no state file in the sandbox home");
			if (!fs.existsSync(drafts)) throw new Error("herdr-pr-autofix wrote no drafts file in the sandbox home");
			pollLocal = await timePolls(both.poll, ctx.runs);
			// The autofix handler alone: the same poll data straight on the event bus.
			const data = { login: viewer.login, open: viewer.pullRequests.nodes, merged: viewer.merged.nodes };
			for (let i = 0; i < ctx.runs; i++) {
				// A mark in the drafts file that the handler's last step (its drafts write) replaces.
				fs.writeFileSync(drafts, "bench");
				const t0 = now();
				both.pi.events.emit(POLL_EVENT, data);
				await flush();
				eventLocal.push(now() - t0);
				if (fs.readFileSync(drafts, "utf8") === "bench") ctx.log("pr-ready: autofix did not finish within one flush, so poll-event-local reads too low");
			}
		} finally {
			await both.end();
		}
		const refusedCalls = both.calls.filter(c => !c.answered);
		if (refusedCalls.length) ctx.log(`pr-ready: the fake exec refused ${refusedCalls.length} call(s): ${[...new Set(refusedCalls.map(c => `${c.cmd} ${c.args[0] ?? ""}`))].join(", ")}`);
		measures.push(
			{ id: "pr-ready.poll-local", label: "One poll's local work, gh answered at once (pr-ready + autofix)", unit: "ms", kind: "local", samples: pollLocal, note: `${openCount} open PRs in the answer, ${Math.round(stdout.length / 1024)} KB; after ${WARMUP} warm-up polls; no agents in the autofix state` },
			{ id: "pr-ready.poll-event-local", label: "herdr-pr-autofix's handling of one poll event", unit: "ms", kind: "local", samples: eventLocal },
		);

		// Profile: the same poll without autofix, and the parts of the pr-ready poll on their own.
		const alone = await loadPoller(ctx, fromMemory, false);
		try {
			await timePolls(alone.poll, WARMUP);
			const solo = await timePolls(alone.poll, Math.max(ctx.runs, 5));
			const parse: number[] = [];
			const write: number[] = [];
			const copy = path.join(ctx.sandbox.work("pr-ready"), "notified.json");
			for (let i = 0; i < 5; i++) {
				let t0 = now();
				JSON.parse(stdout);
				parse.push(now() - t0);
				t0 = now();
				fs.writeFileSync(`${copy}.tmp`, fs.readFileSync(readyState, "utf8"));
				fs.renameSync(`${copy}.tmp`, copy);
				write.push(now() - t0);
			}
			ctx.log(`pr-ready: profile (median ms): poll with autofix ${round2(pollLocal)}, without ${round2(solo)}, autofix event alone ${round2(eventLocal)}, JSON.parse ${round2(parse)}, state read+write ${round2(write)}`);
		} finally {
			await alone.end();
		}

		// 3. GitHub points per hour of every poll on this Mac.
		const prsMain = path.join(ctx.repo, "herdr-app/mods/t3-prs/main.js");
		const T3_QUERY = constant(prsMain, "QUERY");
		const T3_EVERY = num(constant(prsMain, "EVERY"));
		const ghMs = net.gh.length ? median(net.gh) : median(net.ghStart) + (net.curl.length ? median(net.curl) : 0);
		const t3 = await graphql(ctx, T3_QUERY);
		// t3-prs's own query takes its own time; gh start comes on top, as the panel runs gh.
		const t3Ms = t3.totalMs + median(net.ghStart);
		// Each loop sleeps its interval after the poll ends, so a poll's own time adds to the period.
		// The extension's poll is all its queries: its own real time when measured.
		const readyPerHour = 3_600_000 / (EVERY_MS + (pollReal.length ? median(pollReal) : ghMs));
		// Main query plus any follow-up calls (1 point each), as the real polls made them just now.
		const readyPerPoll = net.cost + Math.max(0, gqlPerPoll - 1);
		const t3PerHour = (3_600_000 / (T3_EVERY + t3Ms)) * WINDOWS;
		const prs = (t3.data.viewer.pullRequests.nodes as (T3Pr | null)[]).filter((p): p is T3Pr => p !== null);
		// Follow-ups run only when a PR changed, in each copy of the panel: comments when updatedAt
		// moved, the code owner check when head, base, reviews or decision moved. The PRs updated in
		// the last hour are the estimate (each one changed at least once).
		const hourAgo = Date.now() - 3_600_000;
		const approved = (p: T3Pr) => p.latestReviews.nodes.some(v => v.author && v.state === "APPROVED" && v.author.login !== p.author?.login);
		const recent = prs.filter(p => Date.parse(p.updatedAt) > hourAgo);
		const recentApproved = recent.filter(approved);
		// The mods' gql(query, variables) over the suite's timed real GraphQL, counting calls and points.
		const counted = (counter: { calls: number; cost: number }) => async (q: string, v: Record<string, unknown> = {}) => {
			if (counter.calls >= OWNER_CALLS_MAX) throw new Error("bench: call cap reached");
			counter.calls++;
			const r = await graphql(ctx, q, v);
			counter.cost += r.cost;
			return r.data;
		};
		const comments = { calls: 0, cost: 0 };
		const owners = { calls: 0, cost: 0 };
		// Dynamic: the checkout under test (--repo) is chosen at run time.
		const { fetchComments } = await import(path.join(ctx.repo, "herdr-app/mods/t3-prs/comments.js"));
		const { checkCodeOwners } = await import(path.join(ctx.repo, "herdr-app/mods/t3-prs/owners.js"));
		if (prs[0])
			await fetchComments(counted(comments), prs[0].repository.nameWithOwner, prs[0].number, prs[0].author?.login ?? "").catch((err: unknown) =>
				ctx.log(`pr-ready: comments query failed: ${why(err)}`),
			);
		const sample = prs.find(approved);
		if (sample) {
			const reviews = sample.latestReviews.nodes.flatMap(v => (v.author ? [{ login: v.author.login, state: v.state }] : []));
			await checkCodeOwners(counted(owners), { repo: sample.repository.nameWithOwner, number: sample.number, base: sample.baseRefName, author: sample.author?.login, reviews }).catch(
				(err: unknown) => ctx.log(`pr-ready: code owner check stopped: ${why(err)}`),
			);
		}
		const commentCost = comments.calls ? comments.cost / comments.calls : 1;
		const ownerCost = owners.calls ? owners.cost : 1;
		const parts = {
			t3: t3PerHour * t3.cost,
			comments: recent.length * commentCost * WINDOWS,
			owners: recentApproved.length * ownerCost * WINDOWS,
			ready: readyPerHour * readyPerPoll,
		};
		const total = parts.t3 + parts.comments + parts.owners + parts.ready;
		const r = Math.round;
		measures.push({
			id: "pr-ready.graphql-points-per-hour",
			label: "GitHub GraphQL points per hour, every poll together",
			unit: "points/h",
			kind: "network",
			better: "lower",
			samples: [r(total)],
			note:
				`t3-prs poll ${r(parts.t3)} (${r(t3PerHour)} polls/h x ${t3.cost} pt, ${WINDOWS} window(s), every ${T3_EVERY / 1000} s + ${r(t3Ms)} ms query); ` +
				`herdr-pr-ready ${r(parts.ready)} (${r(readyPerHour)} polls/h x ${readyPerPoll} pt over ${gqlPerPoll} call(s) per poll now); ` +
				`t3-prs comments ${r(parts.comments)} (${recent.length} PRs updated in the last hour x ${commentCost} pt); ` +
				`t3-prs code owners ${r(parts.owners)} (${recentApproved.length} approved PRs updated in the last hour x ${ownerCost} pt over ${owners.calls} call(s)${sample ? "" : ", none approved, cost not read"}); ` +
				"herdr-pr-autofix 0 (it reads the poll event). " +
				`Each Herdr window start also reads comments for all ${prs.length} open PRs and owners for the ${prs.filter(approved).length} approved ones. Computed once per suite run.`,
		});
		measures.push({
			id: "pr-ready.rest-calls-per-hour",
			label: "GitHub REST calls per hour from polls",
			unit: "calls/h",
			kind: "network",
			better: "lower",
			samples: [0],
			note: "No poll uses REST. Only clicks do: t3-prs gh pr ready/merge/close and gh repo view (merge method, cached per panel copy); herdr-pr-autofix runs gh repo clone when a draft moves to ready and no clone exists.",
		});
		const spent = net.cost * (net.curl.length + net.gh.length + net.noMergeState.length) + callsPerPoll.reduce((a, b) => a + b, 0) + t3.cost + comments.cost + owners.cost;
		ctx.log(`pr-ready: real GitHub points this case spent: ${spent} (${comments.calls} comments call(s), ${owners.calls} code owner call(s))`);
		return measures;
	},
} satisfies Case;
