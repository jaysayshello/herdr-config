// Compares two result files of bench/run.sh, measure by measure.
//   bun bench/compare.ts before.json after.json [--only <id prefix>]
// A change counts only when the gap between the medians is larger than the noise (lib/stats.ts).
import * as fs from "node:fs";
import { verdict } from "./lib/stats.ts";
import type { ResultFile } from "./lib/types.ts";

const [aFile, bFile] = process.argv.slice(2);
if (!aFile || !bFile) {
	console.error("usage: bun bench/compare.ts before.json after.json [--only <id prefix>]");
	process.exit(1);
}
const i = process.argv.indexOf("--only");
const prefix = i > 0 ? process.argv[i + 1] : "";
const load = (f: string) => JSON.parse(fs.readFileSync(f, "utf8")) as ResultFile;
const a = load(aFile);
const b = load(bFile);
const after = new Map(b.measures.map(m => [m.id, m]));

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
console.log(`before: ${a.label} ${a.git.sha}${a.git.dirty ? "+" : ""} (${a.started})\nafter:  ${b.label} ${b.git.sha}${b.git.dirty ? "+" : ""} (${b.started})\n`);
console.log("| measure | unit | before median (p95) | after median (p95) | change | verdict |");
console.log("|---|---|---|---|---|---|");
let worse = 0;
let better = 0;
for (const m of a.measures) {
	if (!m.id.startsWith(prefix)) continue;
	const n = after.get(m.id);
	if (!n) {
		console.log(`| ${m.id} | ${m.unit} | ${fmt(m.median)} (${fmt(m.p95)}) | missing | | |`);
		continue;
	}
	const v = verdict(m, n);
	if (v === "worse") worse++;
	if (v === "better") better++;
	const pct = m.median ? ((n.median - m.median) / Math.abs(m.median)) * 100 : 0;
	console.log(`| ${m.id} | ${m.unit} | ${fmt(m.median)} (${fmt(m.p95)}) | ${fmt(n.median)} (${fmt(n.p95)}) | ${pct >= 0 ? "+" : ""}${pct.toFixed(0)} % | ${v} |`);
}
for (const m of b.measures) if (m.id.startsWith(prefix) && !a.measures.some(x => x.id === m.id)) console.log(`| ${m.id} | ${m.unit} | missing | ${fmt(m.median)} (${fmt(m.p95)}) | | |`);
console.log(`\n${better} better, ${worse} worse, GitHub points: ${a.github.pointsSpent} -> ${b.github.pointsSpent}`);
