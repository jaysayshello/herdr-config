// A tiny timing probe for the herdr-start case. It is added ONLY to the sandbox copies of the mods
// (in <appHome>/mods/<mod>/main.js, after writeAppHome copied them), never to the repo or the live
// config. The probe wraps the mod's exported View in a subclass that notes, with Date.now():
//   t0      the mod file's own code started to run (its imports are loaded by then)
//   loaded  the mod file's code finished (last line of main.js)
//   init0/init1      init() started / returned
//   render0/render1  the first render() started / returned
// and writes them once per mod copy, on the first render, as JSON to
// <appHome>/bench-probe/<mod>.<copy>.first. A `when` condition (for t3-prs: "it has pull request
// rows") writes one more file, <mod>.<copy>.<event>, on the first render where it is true.
// Cost: two Date.now() calls and the conditions per render, and a few small file writes per copy.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ProbeMark {
	mod: string;
	copy: number;
	event: string;
	t0?: number;
	loaded?: number;
	init0?: number;
	init1?: number;
	render0: number;
	render1: number;
}

export interface ProbeOptions {
	// Extra events: name -> a JS condition on `this` (the mod instance), checked after each render.
	when?: Record<string, string>;
}

export const probeDir = (appHome: string) => path.join(appHome, "bench-probe");

// Rewrites <appHome>/mods/<mod>/main.js with the probe. Call it on a fresh copy (writeAppHome)
// or again with other options: it starts from main.js.orig, the untouched copy, each time.
export function injectProbe(appHome: string, mod: string, opts: ProbeOptions = {}) {
	const file = path.join(appHome, "mods", mod, "main.js");
	const orig = `${file}.orig`;
	if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
	const src = fs.readFileSync(orig, "utf8");
	const m = src.match(/^export default class (\w+) extends View\b/m);
	if (!m) throw new Error(`${mod}/main.js: no "export default class X extends View" to wrap`);
	const inner = m[1];
	const dir = probeDir(appHome);
	fs.mkdirSync(dir, { recursive: true });
	const when = Object.entries(opts.when ?? {})
		.map(([event, cond]) => `    if (!this.__hb.done[${JSON.stringify(event)}] && (${cond})) { this.__hb.done[${JSON.stringify(event)}] = 1; __hbSave(this, ${JSON.stringify(event)}, a, b); }`)
		.join("\n");
	const probe = `
// --- bench probe (sandbox copy only) ---
import { writeTextFile as __hbWrite, appHome as __hbHome } from "herdr";
const __hbLoaded = Date.now();
let __hbCopies = 0;
function __hbSave(v, event, a, b) {
  const h = v.__hb;
  const mark = event === "first" ? { t0: __hbT0, loaded: __hbLoaded, init0: h.init0, init1: h.init1, render0: a, render1: b } : { render0: a, render1: b };
  __hbWrite(__hbHome() + "/bench-probe/${mod}." + h.copy + "." + event, JSON.stringify(mark), null).catch(() => {});
}
export default class __HbProbe extends ${inner} {
  init(props, cx) {
    this.__hb = { copy: __hbCopies++, init0: Date.now(), init1: 0, done: {} };
    const r = super.init?.(props, cx);
    this.__hb.init1 = Date.now();
    return r;
  }
  render(cx) {
    const a = Date.now();
    const el = super.render(cx);
    const b = Date.now();
    // A copy can render before init in theory; give it a record then too.
    this.__hb ??= { copy: __hbCopies++, init0: 0, init1: 0, done: {} };
    if (!this.__hb.done.first) { this.__hb.done.first = 1; __hbSave(this, "first", a, b); }
${when}
    return el;
  }
}
`;
	const body = src.replace(m[0], `class ${inner} extends View`);
	fs.writeFileSync(file, `const __hbT0 = Date.now();\n${body}\n${probe}`);
}

// Puts the untouched main.js back (for runs that compare "with probe" and "without").
export function removeProbe(appHome: string, mod: string) {
	const file = path.join(appHome, "mods", mod, "main.js");
	if (fs.existsSync(`${file}.orig`)) fs.copyFileSync(`${file}.orig`, file);
}

// Every probe record written so far.
export function readMarks(appHome: string): ProbeMark[] {
	const dir = probeDir(appHome);
	if (!fs.existsSync(dir)) return [];
	const out: ProbeMark[] = [];
	for (const f of fs.readdirSync(dir)) {
		const [mod, copy, event] = f.split(".");
		if (!event) continue;
		try {
			out.push({ mod, copy: Number(copy), event, ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
		} catch {
			// Half-written file: read it again on the next poll.
		}
	}
	return out;
}

export function clearMarks(appHome: string) {
	const dir = probeDir(appHome);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
}

// The parts of a layout file node this case reads.
interface LayoutNode {
	id?: string;
	type?: string;
	hidden?: boolean;
	active?: string;
	content?: { mod?: string };
	children?: LayoutNode[];
}

// The mod blocks the layout puts on screen, with how many copies of each: hidden blocks and the
// inactive children of a stack do not draw at start, so they are left out (as `offscreen`).
export function layoutMods(layoutFile: string): { shown: Map<string, number>; offscreen: string[] } {
	const shown = new Map<string, number>();
	const offscreen: string[] = [];
	const walk = (node: LayoutNode, visible: boolean) => {
		const vis = visible && !node.hidden;
		const mod = node.content?.mod;
		if (mod) {
			if (vis) shown.set(mod, (shown.get(mod) ?? 0) + 1);
			else offscreen.push(mod);
		}
		for (const child of node.children ?? []) walk(child, vis && (node.type !== "stack" || !node.active || child.id === node.active));
	};
	walk(JSON.parse(fs.readFileSync(layoutFile, "utf8")) as LayoutNode, true);
	return { shown, offscreen };
}
