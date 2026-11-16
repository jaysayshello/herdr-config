// The test world of the orchestrator-e2e case, shaped like the person's: 10 tmp-bench-* spaces, each
// with its terminals in a folder named like a real project (<words>-2026-01-NN), 1 or 2 tabs, some
// plain shell panes beside the agents, one agent that stays working and one blocked on a question.
// The agents are fake omp workers (lib/instance.ts writeFakeOmp) with a terminal title; the target
// of every request is the one in tmp-bench-payments. Plus a sandbox copy of the orchestrator
// project (its .omp from the checkout under test) for the real test orchestrator omp to run in.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertNotReal, BENCH_ROOT } from "./guard.ts";
import { type Instance, hc, writeFakeOmp } from "./instance.ts";
import { now, run, sleep, waitFor } from "./proc.ts";
import type { Sandbox } from "./sandbox.ts";

// The target worker "works" this long on each prompt.
export const TARGET_WORK_MS = 3000;
export const TARGET_SPACE = "tmp-bench-payments";
// The orchestrator's space. Not "orchestrator": herdr-pr-ready.ts polls GitHub only in a space
// of that name, and herdr-pr-autofix.ts acts only on those polls, so here both stay quiet.
export const ORCH_SPACE = "tmp-orch-bench";

interface SpacePlan {
	name: string;
	folder: string;
	// One entry per tab; each tab is a list of panes: an agent kind, or "shell".
	tabs: ("target" | "idle" | "working" | "blocked" | "shell")[][];
}

const PLAN: SpacePlan[] = [
	{ name: TARGET_SPACE, folder: "billing-payments-2026-01-01", tabs: [["target", "shell"]] },
	{ name: "tmp-bench-docs", folder: "team-docs-2026-01-02", tabs: [["idle"], ["idle"]] },
	{ name: "tmp-bench-infra", folder: "infra-terraform-2026-01-03", tabs: [["working", "shell"]] },
	{ name: "tmp-bench-herdr", folder: "ricing-herdr-2026-01-04", tabs: [["idle", "shell"], ["idle"]] },
	{ name: "tmp-bench-api", folder: "public-api-2026-01-05", tabs: [["blocked"]] },
	{ name: "tmp-bench-web", folder: "web-dashboard-2026-01-06", tabs: [["idle"], ["idle", "idle"]] },
	{ name: "tmp-bench-mobile", folder: "mobile-app-2026-01-07", tabs: [["idle"]] },
	{ name: "tmp-bench-data", folder: "data-pipeline-2026-01-08", tabs: [["idle", "shell"]] },
	{ name: "tmp-bench-search", folder: "search-index-2026-01-09", tabs: [["idle"], ["idle"]] },
	{ name: "tmp-bench-notes", folder: "meeting-notes-2026-01-10", tabs: [["idle"]] },
];

export interface World {
	target: string;
	targetSpace: string;
	spaceIds: string[];
	agents: number;
	shells: number;
	fakeLog: string;
}

interface Created {
	space: string;
	tab: string;
	terminal: string;
}
interface Ls {
	spaces: { id: string; name: string; tabs: { id: string; terminals: { terminal: string; pane?: string }[] }[] }[];
}

// Small helper scripts: one sets the terminal title and starts the rest of its arguments; one
// reports a fixed omp state (working or blocked) and then only reads its input.
function writeHelpers(sb: Sandbox) {
	const titled = path.join(sb.root, "e2e-titled.sh");
	fs.writeFileSync(titled, `#!/bin/sh\nprintf '\\033]0;%s\\007' "$1"\nshift\nexec "$@"\n`, { mode: 0o755 });
	const fixed = path.join(sb.root, "e2e-fixed-state.sh");
	fs.writeFileSync(
		fixed,
		`#!/bin/sh\nprintf '\\033]7501;state=%s:app=omp\\007' "$1"\necho "fake omp, $1"\nexec cat >/dev/null\n`,
		{ mode: 0o755 },
	);
	return { titled, fixed };
}

export async function buildWorld(sb: Sandbox, instance: Instance, log: (m: string) => void): Promise<World> {
	const fake = writeFakeOmp(sb);
	const { titled, fixed } = writeHelpers(sb);
	const projects = sb.work("projects");
	const spaceIds: string[] = [];
	let target = "";
	let targetSpace = "";
	let agents = 0;
	let shells = 0;
	const t0 = now();
	for (const s of PLAN) {
		const folder = path.join(projects, s.folder);
		fs.mkdirSync(folder, { recursive: true });
		const words = s.folder.replace(/-\d{4}-\d{2}-\d{2}$/, "");
		const argvOf = (kind: string, n: number) => {
			const title = `omp · ${words}${n ? ` ${n + 1}` : ""}`;
			if (kind === "target") return ["/usr/bin/env", `BENCH_WORK_MS=${TARGET_WORK_MS}`, titled, title, fake];
			if (kind === "working" || kind === "blocked") return [titled, title, fixed, kind];
			return [titled, title, fake];
		};
		let spaceId = "";
		for (const [ti, panes] of s.tabs.entries()) {
			const first = argvOf(panes[0], ti);
			const c =
				ti === 0
					? await instance.app<Created>(["do", "space.new", "--name", s.name, "--folder", folder, "--tab", "main", "--argv", JSON.stringify(first), "--focus", "false"])
					: await instance.app<Created>(["do", "tab.new", "--space", spaceId, "--name", `tab ${ti + 1}`, "--folder", folder, "--argv", JSON.stringify(first), "--focus", "false"]);
			if (ti === 0) {
				spaceId = c.space;
				spaceIds.push(c.space);
			}
			if (panes[0] === "target") {
				target = c.terminal;
				targetSpace = c.space;
			}
			agents++;
			// More panes in this tab: split the first one to the right.
			for (const [pi, kind] of panes.slice(1).entries()) {
				const { spaces } = await instance.app<Ls>(["ls"]);
				const pane = spaces.find(x => x.id === c.space)?.tabs.find(t => t.id === c.tab)?.terminals.find(t => t.terminal === c.terminal)?.pane;
				if (!pane) throw new Error(`no pane for ${c.terminal} in herdr-app ls`);
				const args = ["do", "pane.split", "--direction", "right", "--pane", pane];
				if (kind !== "shell") args.push("--argv", JSON.stringify(argvOf(kind, ti * 10 + pi + 1)));
				await instance.app(args);
				if (kind === "shell") shells++;
				else agents++;
			}
		}
	}
	if (!target) throw new Error("the plan has no target worker");
	// Every fake agent must report itself as omp before a test uses it.
	await waitFor(
		async () => {
			const { spaces } = await instance.app<Ls>(["ls"]);
			const ours = spaces.filter(s => spaceIds.includes(s.id)).flatMap(s => s.tabs.flatMap(t => t.terminals.map(x => x.terminal)));
			const infos = await Promise.all(ours.map(t => hc(sb, ["get", t]).catch(() => undefined)));
			return infos.filter(i => i?.status?.app === "omp").length >= agents;
		},
		"every fake agent to report as omp",
		30_000,
		200,
	);
	await writeAnswer(sb, target);
	log(`orchestrator-e2e: ${spaceIds.length} spaces, ${agents} fake agents, ${shells} shell panes ready in ${Math.round(now() - t0)} ms; target ${target}`);
	return { target, targetSpace, spaceIds, agents, shells, fakeLog: path.join(sb.root, "fake-omp.log") };
}

// The herdr-resume breadcrumb folder (os.homedir() is the sandbox home).
export function crumbDir(): string {
	const dir = path.join(os.homedir(), ".local/state/omp-herdr-resume");
	assertNotReal(dir);
	if (!dir.startsWith(BENCH_ROOT)) throw new Error(`breadcrumb folder ${dir} is not in the sandbox`);
	return dir;
}

// Gives the target a breadcrumb and a session file whose last answer is "pong", as a real worker
// has, so the watch takes the answer from the session (the normal path), not the screen.
async function writeAnswer(sb: Sandbox, terminal: string) {
	const info = await hc(sb, ["get", terminal]);
	const session = path.join(sb.work("e2e-sessions"), `${terminal}.jsonl`);
	assertNotReal(session);
	const entry = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
	fs.writeFileSync(session, `${entry("user", "reply with pong")}\n${entry("assistant", "pong")}\n`);
	fs.mkdirSync(crumbDir(), { recursive: true });
	fs.writeFileSync(path.join(crumbDir(), terminal), `${info.created_ms}\n${session}\n`);
}

// The sandbox copy of the orchestrator project: a folder named like the real one, with the
// checkout's orchestrator/.omp in it. omp loads .omp from its cwd, so the test orchestrator runs
// the code under test.
export function orchestratorCopy(sb: Sandbox, repo: string): string {
	const dir = path.join(sb.work("orchestrator-project"), "herdr-orchestrator-2026-01-01");
	assertNotReal(dir);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	fs.cpSync(path.join(repo, "orchestrator/.omp"), path.join(dir, ".omp"), { recursive: true });
	return dir;
}

// The time the fake worker logged `state` first after `after` (ms), or undefined.
export function stateAt(world: World, terminal: string, state: string, after: number): number | undefined {
	let text = "";
	try {
		text = fs.readFileSync(world.fakeLog, "utf8");
	} catch {
		return undefined;
	}
	for (const line of text.split("\n")) {
		const [ms, t, s] = line.split(" ");
		if (t === terminal && s === state && Number(ms) > after) return Number(ms);
	}
	return undefined;
}

// The environment of a process, from `ps eww` (only used on processes of the test core).
export async function envOf(pid: number): Promise<string> {
	return (await run("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)])).stdout;
}

// Closes every space this case made and waits until herdr-app ls has none of them.
export async function closeAll(instance: Instance, ids: string[], log: (m: string) => void) {
	for (const id of ids) await instance.app(["do", "space.close", "--id", id, "--confirmed", "true"]).catch(err => log(`orchestrator-e2e: close ${id}: ${err}`));
	const left = async () => (await instance.app<Ls>(["ls"])).spaces.filter(s => ids.includes(s.id));
	for (let i = 0; i < 50 && (await left()).length > 0; i++) await sleep(100);
	const still = await left();
	if (still.length) log(`orchestrator-e2e: spaces still open after close: ${still.map(s => s.name).join(", ")}`);
}
