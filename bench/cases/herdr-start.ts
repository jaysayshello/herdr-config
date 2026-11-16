// How long Herdr takes to start: from the spawn of the app process until the window answers,
// draws its first frame, and the person's mods (the spaces sidebar, the Pull requests panel, …)
// have drawn. The test core starts once and stays up, as the person's core outlives the app.
// "Drawn" comes from a probe added only to the sandbox copies of the mods (lib/herdr-start-probe.ts):
// each mod copy notes when its first render() ran, t3-spaces when it first listed every space and
// when it first showed their git, and t3-prs when it first rendered pull request rows.
import * as fs from "node:fs";
import * as path from "node:path";
import { installFakeGh } from "../lib/fakegh.ts";
import { clearMarks, injectProbe, layoutMods, type ProbeMark, readMarks, removeProbe } from "../lib/herdr-start-probe.ts";
import { Instance, startCore, writeFakeOmp } from "../lib/instance.ts";
import { run, waitFor } from "../lib/proc.ts";
import { MODS } from "../lib/sandbox.ts";
import type { Case, Ctx, Measure } from "../lib/types.ts";

const ID = "herdr-start";
// How many spaces the sidebar shows (each a git folder with a fake omp worker).
const SPACES = 6;
// Probe events past the first render: a JS condition on the mod instance, checked after each
// render. t3-spaces: `known` the window has the core's spaces, `one`/`rows` it lists one / all of
// them (a space is listed once it is in `this.shown`), `git` every space has its git answer.
const EVENTS: Record<string, Record<string, string>> = {
	"t3-prs": { rows: "(this.prs?.length ?? 0) > 0" },
	"t3-spaces": {
		known: `spaces().length >= ${SPACES}`,
		one: "spaces().some((s) => this.shown?.has(s.id))",
		rows: `spaces().filter((s) => this.shown?.has(s.id)).length >= ${SPACES}`,
		git: `!this.refreshing && Object.values(this.git ?? {}).filter(Boolean).length >= ${SPACES}`,
	},
};
// The events every measured start waits for, besides each shown mod copy's first render.
const NEEDED = Object.entries(EVENTS).flatMap(([mod, events]) => Object.keys(events).map(event => ({ mod, event })));

// One start of the window, with every time in ms from the spawn of the app process.
interface Start {
	status: number;
	frame?: number;
	marks: ProbeMark[];
	// The first `gh api graphql` the Pull requests panel ran: when it started and ended.
	gh?: { start: number; end: number };
	// How long one `herdr-app status` takes once the window is up (the cost of each poll).
	cli?: number;
}

export default {
	id: ID,
	title: "Herdr start: window, first frame, sidebar, mods and pull request rows",
	async run(ctx: Ctx): Promise<Measure[]> {
		const sb = ctx.sandbox;
		const gh = installFakeGh(sb); // about 10 open pull requests, answered at once
		await startCore(sb);

		// The mods the herdr-t3 layout shows at start (hidden blocks and inactive stack pages wait).
		const { shown, offscreen } = layoutMods(path.join(sb.appHome, "layouts/herdr-t3.json"));
		const mine = [...shown.keys()].filter(m => MODS.includes(m));
		ctx.log(`${ID}: on screen: ${[...shown].map(([m, n]) => `${m}×${n}`).join(", ")}; not drawn at start: ${offscreen.join(", ") || "none"}`);
		if (!mine.includes("t3-spaces") || !mine.includes("t3-prs")) throw new Error("herdr-t3 layout has no t3-spaces or t3-prs block");
		// Every mod gets the probe (it is cheap), so the log also shows if an off-screen one renders.
		const probeAll = () => {
			for (const m of MODS) injectProbe(sb.appHome, m, { when: EVENTS[m] });
		};
		probeAll();

		// Spaces like the person's: a few git folders, each with an omp-like worker (the fake omp),
		// so the sidebar has rows, agents and git status to read at start. They live in the core,
		// which outlives each window; stopAll ends the core (and with it these terminals) afterwards.
		const fake = writeFakeOmp(sb);
		const { instance: setup } = await Instance.start(sb);
		try {
			for (let i = 0; i < SPACES; i++) {
				const dir = sb.work(`${ID}/space-${i}`);
				await run("git", ["init", "-q", dir]);
				await setup.app(["do", "space.new", "--name", `tmp-bench-start-${i}`, "--folder", dir, "--argv", JSON.stringify([fake]), "--focus", "false"]);
			}
		} finally {
			await setup.stop();
		}

		// One start: spawn, wait for status and the first frame, then (with `probe`) for every shown
		// mod copy's first render, the NEEDED events and the panel's first `gh api graphql` (one
		// started after the panel's init, so a call left over from the last window does not count).
		const startOnce = async (probe: boolean): Promise<Start> => {
			clearMarks(sb.appHome);
			gh.clear();
			const { instance, statusMs, frameMs } = await Instance.start(sb, { waitFrame: true });
			try {
				if (!probe) return { status: statusMs, frame: frameMs, marks: [] };
				let call: { start: number; end: number } | undefined;
				const marks = await waitFor(
					() => {
						const all = readMarks(sb.appHome);
						const drawn = mine.every(m => all.filter(k => k.mod === m && k.event === "first").length >= shown.get(m)!);
						const events = NEEDED.every(n => all.some(k => k.mod === n.mod && k.event === n.event));
						const prsInit = all.find(k => k.mod === "t3-prs" && k.event === "first")?.init0 ?? Infinity;
						call = gh.calls().find(c => c.args.startsWith("api graphql") && c.start >= prsInit);
						return drawn && events && call ? all : null;
					},
					"every shown mod, the sidebar's spaces and git, the pull request rows and the first gh call",
					30_000,
					20,
				);
				const cli = (await run(sb.herdrApp, ["status"], { timeoutMs: 5000 })).ms;
				const rel = (n: number) => n - instance.t0;
				const times = ["t0", "loaded", "init0", "init1", "render0", "render1"] as const;
				return {
					status: statusMs,
					frame: frameMs,
					marks: marks.map(k => ({ ...k, ...Object.fromEntries(times.filter(f => k[f]).map(f => [f, rel(k[f]!)])) })),
					gh: call ? { start: rel(call.start), end: rel(call.end) } : undefined,
					cli,
				};
			} finally {
				await instance.stop();
			}
		};

		const samples: Record<string, number[]> = {};
		const add = (name: string, v: number | undefined) => {
			if (v === undefined || !Number.isFinite(v)) return;
			(samples[name] ??= []).push(Math.round(v * 10) / 10);
		};
		const firsts = (s: Start, mod: string) => s.marks.filter(k => k.mod === mod && k.event === "first").map(k => k.render1);
		const event = (s: Start, mod: string, name: string) => s.marks.find(k => k.mod === mod && k.event === name)?.render1;

		// A start that is not counted: it warms the disk cache for the app binary and fills
		// t3-prs's saved list (its localStorage), as the person's own Herdr always has one.
		await startOnce(true);

		for (let i = 0; i < ctx.runs; i++) {
			const s = await startOnce(true);
			add("status", s.status);
			// Before the first mod file loads, the time is Herdr's own (process, window, core, layout).
			add("boot", Math.min(...s.marks.filter(k => k.event === "first").map(k => k.t0!)));
			add("frame", s.frame);
			add("sidebar", event(s, "t3-spaces", "rows"));
			add("mods", Math.max(...mine.flatMap(m => firsts(s, m))));
			add("prs", event(s, "t3-prs", "rows"));
			for (const m of mine) add(`mod.${m}`, Math.min(...firsts(s, m)));
			add("git", event(s, "t3-spaces", "git"));
			add("gh", s.gh?.end);
			add("cli", s.cli);
			ctx.log(`${ID}: run ${i + 1}: ${timeline(s)}`);
			const extra = [...new Set(s.marks.filter(k => !mine.includes(k.mod)).map(k => k.mod))];
			if (extra.length) ctx.log(`${ID}: also rendered at start: ${extra.join(", ")}`);
		}

		// Profile: t3-prs with no saved list (a first start, or after its data was cleared): the rows
		// wait for gh. The fake gh answers at once, so this is the local part of that wait.
		const store = path.join(sb.appHome, "data/t3-prs/store.json");
		for (let i = 0; i < ctx.runs; i++) {
			fs.rmSync(store, { force: true });
			const s = await startOnce(true);
			add("prs-cold", event(s, "t3-prs", "rows"));
			ctx.log(`${ID}: no saved list ${i + 1}: ${timeline(s)}`);
		}

		// Profile: the same start with the untouched mods, to show the probe costs nothing visible.
		for (const m of MODS) removeProbe(sb.appHome, m);
		for (let i = 0; i < ctx.runs; i++) add("noprobe.frame", (await startOnce(false)).frame);

		// Profile: Herdr's shipped "main" layout (none of the person's mods on screen), to see what
		// the mods add to the first frame. shared.json picks the layout at start.
		const shared = path.join(sb.appHome, "shared.json");
		const saved = fs.readFileSync(shared, "utf8");
		fs.writeFileSync(shared, JSON.stringify({ ...JSON.parse(saved), layout: "main" }));
		try {
			for (let i = 0; i < ctx.runs; i++) {
				const s = await startOnce(false);
				add("shipped.status", s.status);
				add("shipped.frame", s.frame);
			}
		} finally {
			fs.writeFileSync(shared, saved);
			probeAll();
		}

		const m = (name: string, label: string, better: Measure["better"] = "lower", note?: string): Measure | null =>
			samples[name]?.length ? { id: `${ID}.${name}`, label, unit: "ms", kind: "local", better, samples: samples[name], note } : null;
		const poll = "Polled every 20 ms with the herdr-app CLI, so it includes one CLI call (see herdr-start.cli).";
		const warm = "After one start that is not counted, so t3-prs shows its saved list, as the person's Herdr does.";
		return [
			m("status", "Start: the window answers `herdr-app status`", "lower", poll),
			m("boot", "Start: the first mod file starts to load (Herdr's own start before the mods)", "lower", "Not in this repo's code: the app binary, window, core link and layout."),
			m("frame", "Start: the first frame is drawn (`herdr-app shot` gives a picture)", "lower", poll),
			m("sidebar", `Start: the spaces sidebar (t3-spaces) listed all ${SPACES} spaces`),
			m("mods", "Start: every t3 mod on screen rendered once", "lower", `Mods on screen: ${mine.join(", ")}.`),
			m("prs", "Start: the Pull requests panel rendered its rows", "lower", warm),
			...mine.map(x => m(`mod.${x}`, `Start: ${x} first render`, "none")),
			m("git", `Start: the sidebar shows git for all ${SPACES} spaces`, "lower", "t3-spaces runs 3 git commands per space, one after another."),
			m("gh", "Start: the panel's first `gh api graphql` answered", "none", "Fake gh with no delay: app and gh process start only, no GitHub wait."),
			m("cli", "One `herdr-app status` call once the window is up", "none"),
			m("prs-cold", "Start with no saved pull request list: the panel rendered its rows", "lower", "Fake gh with no delay; with real GitHub add its wait (about 1 s)."),
			m("noprobe.frame", "Start without the probe: first frame", "none", "Same start with the untouched mods; compare with herdr-start.frame."),
			m("shipped.status", "Start with the shipped main layout: window answers", "none", "No personal mods on screen; compare with herdr-start.status."),
			m("shipped.frame", "Start with the shipped main layout: first frame", "none", "No personal mods on screen; compare with herdr-start.frame."),
		].filter((x): x is Measure => x !== null);
	},
} satisfies Case;

// One line per start for the log, in the order things happened, for example
// "status 380 frame 420 | t3-spaces.0 load 291 init 291-291 render 301-301 · … | t3-spaces.rows 301 · …".
function timeline(s: Start) {
	const r = Math.round;
	const firsts = s.marks.filter(k => k.event === "first").sort((a, b) => a.render1 - b.render1);
	const mods = firsts.map(k => `${k.mod}.${k.copy} load ${r(k.t0!)}-${r(k.loaded!)} init ${r(k.init0!)}-${r(k.init1!)} render ${r(k.render0)}-${r(k.render1)}`);
	const events = s.marks.filter(k => k.event !== "first").sort((a, b) => a.render1 - b.render1).map(k => `${k.mod}.${k.event} ${r(k.render1)}`);
	const gh = s.gh ? `gh ${r(s.gh.start)}-${r(s.gh.end)}` : "gh none";
	return `status ${r(s.status)} frame ${r(s.frame ?? 0)} | ${mods.join(" · ")} | ${events.join(" · ")} | ${gh}`;
}
