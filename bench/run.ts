// The Herdr performance suite. Start it with bench/run.sh (it sets up the sandbox env first).
//   bench/run.sh [--runs 5] [--only a,b] [--skip a,b] [--label name] [--out file.json] [--keep]
//                [--repo <checkout>]   measure another checkout's code (default: this one)
// Each case in bench/cases/ runs in turn; the result file has every sample, the median and the
// 95th percentile of each measure, the GitHub points the suite spent, and the cases it skipped.
import { assertSandboxed } from "./lib/guard.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stopAll } from "./lib/instance.ts";
import { run } from "./lib/proc.ts";
import { prepareSandbox } from "./lib/sandbox.ts";
import { summarize } from "./lib/stats.ts";
import type { Case, Ctx, ResultFile, Summary } from "./lib/types.ts";

assertSandboxed();

const argv = process.argv.slice(2);
const opt = (name: string) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const list = (name: string) => opt(name)?.split(",").filter(Boolean);
// The code under test: this checkout, or another one (a clone on a branch to try), so the suite
// itself need not be on that branch.
const repo = path.resolve(opt("repo") ?? path.resolve(import.meta.dir, ".."));
if (!fs.existsSync(path.join(repo, "herdr-app")) || !fs.existsSync(path.join(repo, "orchestrator"))) {
	console.error(`bench: ${repo} is not a herdr-config checkout; pass --repo <checkout>`);
	process.exit(1);
}
const runs = Number(opt("runs") ?? 5);
const only = list("only");
const skip = list("skip") ?? [];
const label = opt("label") ?? "run";
const started = new Date();
const stamp = started.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.resolve(opt("out") ?? path.join(import.meta.dir, "results", `${label}-${stamp}.json`));

const log = (msg: string) => console.error(`[${new Date().toLocaleTimeString("en-CA", { hour12: false })}] ${msg}`);
const sandbox = prepareSandbox(repo);
let pointsSpent = 0;
const ctx: Ctx = { sandbox, runs, repo, log, spend: p => (pointsSpent += p) };

const caseDir = path.join(import.meta.dir, "cases");
const files = fs.readdirSync(caseDir).filter(f => f.endsWith(".ts")).sort();
const measures: Summary[] = [];
const skipped: ResultFile["skipped"] = [];

const git = async (...a: string[]) => (await run("git", ["-C", repo, ...a])).stdout.trim();
const gitInfo = { sha: await git("rev-parse", "--short", "HEAD"), branch: await git("branch", "--show-current"), dirty: (await git("status", "--porcelain")) !== "" };

function save() {
	const result: ResultFile = {
		version: 1,
		label,
		started: started.toISOString(),
		finished: new Date().toISOString(),
		git: gitInfo,
		host: { os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, bun: Bun.version, load: os.loadavg() },
		runs,
		github: { pointsSpent },
		measures,
		skipped,
	};
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

try {
	for (const file of files) {
		// The file name is the case id, so a filtered run loads only the cases it runs (a broken
		// case file then cannot stop the others). Case files are found at run time, hence import().
		const id = path.basename(file, ".ts");
		if ((only && !only.includes(id)) || skip.includes(id)) continue;
		const c = (await import(path.join(caseDir, file))).default as Case;
		log(`${c.id}: ${c.title}`);
		const t0 = performance.now();
		try {
			for (const m of await c.run(ctx)) measures.push(summarize(m));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			log(`${c.id}: skipped: ${reason}`);
			skipped.push({ id: c.id, reason });
		} finally {
			// A case that failed half way must not leave a window or core behind for the next one.
			await stopAll(sandbox);
		}
		log(`${c.id}: done in ${Math.round((performance.now() - t0) / 1000)} s`);
		save();
	}
} finally {
	await stopAll(sandbox);
	save();
	if (!argv.includes("--keep")) fs.rmSync(sandbox.root, { recursive: true, force: true });
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`\n${pad("measure", 48)} ${pad("unit", 6)} ${pad("median", 10)} ${pad("p95", 10)} n`);
for (const m of measures) console.log(`${pad(m.id, 48)} ${pad(m.unit, 6)} ${pad(String(m.median), 10)} ${pad(String(m.p95), 10)} ${m.n}`);
for (const s of skipped) console.log(`skipped ${s.id}: ${s.reason}`);
console.log(`\nGitHub points spent by the suite: ${pointsSpent}\nResults: ${out}`);
