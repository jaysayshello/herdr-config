// A probe copy of t3-prs for `herdr-app check`, which loads a mod in Herdr's own QuickJS and renders
// it once, without a window. The copy's init() runs the mod's real poll handling (load()) and its
// render() runs the mod's real render() on fixtures, timed in QuickJS; then it throws
// "BENCH {json}", because check prints a render error but not console.log.
// check runs no promise jobs after init (only a cx.spawn task up to its first await), so the copy
// has `async`/`await` taken out of main.js, owners.js and comments.js and its exec answers at once:
// load() and its checks run start to end inside init. Its exec answers gh from the fixtures in
// memory and never starts a process, so it can never reach the real gh, whatever PATH Herdr gives
// exec. check also stops a mod that works too long ("interrupted"; in tests, beyond 150-400 ms of
// work in all), so the probe loops only while time is
// left (BENCH.budget) and one check measures one list size. The repo's mod is not changed; the
// copy goes into the sandbox.
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "./proc.ts";
import type { Sandbox } from "./sandbox.ts";

export interface ProbeInput {
	// Answers by kind of gh call: poll, comments, owners, team.
	answers: Record<string, string>;
	// At most this many polls and renders, and only within budget ms from init's start.
	polls: number;
	renders: number;
	budget: number;
	// A part of render() to switch off in every other render: comment bubbles, approval marks,
	// or the Merged group (folded).
	variant?: "talk" | "approval" | "merged";
}

export interface ProbeResult {
	clock: string;
	// Median ms of one poll's load() (parse, compare, save, then the comment and code owner checks)
	// with empty caches (the first poll after start), with a changed list and warm caches, and with
	// nothing changed; and of one render(). polls and renders: how many fit in the budget.
	first: number;
	poll: number;
	quiet: number;
	render: number;
	polls: number;
	renders: number;
	// The median render with the variant's part switched off (null without a variant).
	variantRender: number | null;
	total: number;
	prs: number;
	comments: number;
	approvals: number;
	error: string | null;
}

const PROBE = `
// --- bench probe (added in the sandbox copy only) ---
const BENCH_NOW = globalThis.performance && performance.now ? () => performance.now() : () => Date.now();
const BENCH_CLOCK = globalThis.performance && performance.now ? "performance.now" : "Date.now";
const benchMedian = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function benchKind(args) {
  if (args[0] !== "api") return args[0] + " " + args[1];
  const q = args[3] || "";
  if (q.includes("reviewThreads")) return "comments";
  if (q.includes("object(expression")) return "owners";
  if (q.includes("organization(login")) return "team";
  return "poll";
}
export default class Probe extends PullRequests {
  init(_props, cx) {
    this.t0 = BENCH_NOW();
    // The fields PullRequests.init sets, without its poll loop and command loop.
    Object.assign(this, { prs: null, merged: null, error: null, loading: false, manual: false, folded: {},
      approvals: new Map(), methods: new Map(), comments: new Map(), seen: {}, cursor: null, back: null });
    this.handle = cx.focus_handle();
    try {
      this.polls();
    } catch (e) {
      this.failed = e;
    }
  }
  // check stops a mod that works too long ("interrupted"): loop only while time is left.
  left(share) {
    return BENCH_NOW() - this.t0 < BENCH.budget * share;
  }
  // Polls with empty caches (the first poll after start), with a changed list and warm caches,
  // and with nothing changed. The state after them stays for render().
  polls() {
    const quietCx = { notify() {}, spawn() {}, focus_handle: () => this.handle };
    globalThis.__benchExec = (_cmd, args) => {
      const out = BENCH.answers[benchKind(args)];
      return out ? { code: 0, stdout: out, stderr: "" } : { code: 1, stdout: "", stderr: "no answer" };
    };
    const first = [], poll = [], quiet = [];
    do {
      this.prs = null; this.merged = null; this.comments = new Map(); this.approvals = new Map();
      let t = BENCH_NOW();
      this.load(quietCx);
      first.push(BENCH_NOW() - t);
      this.prs = null; this.merged = null;
      t = BENCH_NOW();
      this.load(quietCx);
      poll.push(BENCH_NOW() - t);
      t = BENCH_NOW();
      this.load(quietCx);
      quiet.push(BENCH_NOW() - t);
    } while (first.length < BENCH.polls && this.left(0.5));
    this.result = { first: benchMedian(first), poll: benchMedian(poll), quiet: benchMedian(quiet), polls: first.length,
      prs: this.prs.length, comments: this.comments.size, approvals: this.approvals.size, error: this.error };
  }
  // check's one render: time the mod's own render() inside it (Herdr takes click handlers only
  // while a render runs), then report everything as this render's error. With BENCH.variant, the
  // renders alternate: as is, then with one part switched off, for a paired comparison.
  render(cx) {
    let out;
    try {
      if (this.failed) throw this.failed;
      const off = {
        talk: () => { this.talk = () => null; },
        approval: () => { this.approval = () => null; },
        merged: () => { this.folded = { merged: true }; },
      }[BENCH.variant];
      const times = [], variant = [];
      do {
        let t = BENCH_NOW();
        super.render(cx);
        times.push(BENCH_NOW() - t);
        if (!off) continue;
        off();
        t = BENCH_NOW();
        super.render(cx);
        variant.push(BENCH_NOW() - t);
        delete this.talk; delete this.approval; this.folded = {};
      } while (times.length < BENCH.renders && this.left(1));
      out = "BENCH " + JSON.stringify({ clock: BENCH_CLOCK, ...this.result, render: benchMedian(times), renders: times.length,
        variantRender: off ? benchMedian(variant) : null, total: BENCH_NOW() - this.t0 });
    } catch (e) {
      out = "BENCH-ERROR " + String((e && e.stack) || e).split("\\n").join(" | ");
    }
    throw new Error(out);
  }
}
`;

// The probe's copy of a file: no async/await, so every call returns at once.
const syncCopy = (src: string) => src.replace(/\basync\s+/g, "").replace(/\bawait\s+/g, "");

// Writes the probe copy into <dir>/t3-prs and returns that folder.
export function writeProbe(modDir: string, dir: string, input: ProbeInput): string {
	const to = path.join(dir, "t3-prs");
	fs.rmSync(to, { recursive: true, force: true });
	fs.cpSync(modDir, to, { recursive: true });
	fs.rmSync(path.join(to, "check-prs.cjs"), { force: true });
	for (const f of ["owners.js", "comments.js"]) fs.writeFileSync(path.join(to, f), syncCopy(fs.readFileSync(path.join(modDir, f), "utf8")));
	let src = syncCopy(fs.readFileSync(path.join(modDir, "main.js"), "utf8"));
	const herdrImport = src.match(/import \{([^}]*)\} from "herdr";/);
	if (!herdrImport || !/\bexec\b/.test(herdrImport[1])) throw new Error("t3-prs main.js no longer imports exec from herdr");
	// exec goes through the probe's answers once it set them.
	src = src.replace(
		herdrImport[0],
		`import {${herdrImport[1].replace(/\bexec\b/, "exec as hostExec")}} from "herdr";\nconst exec = (c, a, o) => (globalThis.__benchExec ?? hostExec)(c, a, o);`,
	);
	if (!src.includes("export default class PullRequests")) throw new Error("t3-prs main.js no longer exports class PullRequests");
	src = src.replace("export default class PullRequests", "class PullRequests");
	fs.writeFileSync(path.join(to, "main.js"), `${src}\nconst BENCH = ${JSON.stringify(input)};\n${PROBE}`);
	return to;
}

// The BENCH line of `herdr-app check` output, or an error with what it printed instead.
export function readProbe(output: string): ProbeResult {
	const err = output.match(/BENCH-ERROR (.*)/);
	if (err) throw new Error(`probe failed in QuickJS: ${err[1].slice(0, 400)}`);
	const line = output.match(/BENCH (\{.*\})/);
	if (!line) throw new Error(`herdr-app check printed no BENCH line: ${output.slice(0, 300)}`);
	return JSON.parse(line[1]);
}

// Writes the probe, runs `herdr-app check` on it (in the test app home: run.sh set HERDR_APP_HOME)
// and reads its result. When check stopped it for time ("interrupted"), tries again with less budget.
export async function runProbe(sb: Sandbox, modDir: string, dir: string, input: ProbeInput): Promise<ProbeResult> {
	for (let budget = input.budget; ; budget /= 2) {
		const r = await run(sb.herdrApp, ["check", writeProbe(modDir, dir, { ...input, budget })], { timeoutMs: 60_000 });
		const text = r.stdout + r.stderr;
		if (!/^interrupted/m.test(text) || budget < input.budget / 2) return readProbe(text);
	}
}
