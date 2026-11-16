// The test world of the orchestrator case: one "orchestrator" space (a plain program that only
// reads its input, standing in for the orchestrator's own terminal) and 10 worker spaces with
// 1 or 2 tabs each, every tab a fake omp worker (lib/instance.ts writeFakeOmp). That is about the
// number of spaces and agents the person keeps open. All spaces are named tmp-bench-*.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertNotReal, BENCH_ROOT } from "./guard.ts";
import { type Instance, hc } from "./instance.ts";
import { now, sleep, waitFor } from "./proc.ts";
import type { Sandbox } from "./sandbox.ts";

export const WORKER_SPACES = 10;
// Spaces 0..7 get a second tab: 18 workers in all.
export const TWO_TAB_SPACES = 8;
// How long a fake worker "works" on each prompt.
export const WORK_MS = 2000;

export interface Worker {
	terminal: string;
	space: string;
	spaceName: string;
}

export interface World {
	orchTerminal: string;
	orchSpace: string;
	workers: Worker[];
	// Every space this case made, so cleanup can close them all.
	spaceIds: string[];
	fakeLog: string;
}

interface Created {
	space: string;
	tab: string;
	terminal: string;
}

// The fake omp of lib/instance.ts, with one change: it reads the clock BEFORE it prints the state
// change. instance.ts's version prints first and then starts perl for the time, so its log line
// is about 20 ms after the real stop (perl's start), which hid the hc wait lag this case measures.
function writeFakeOmp(sb: Sandbox): string {
	const file = path.join(sb.root, "orchestrator-fake-omp.sh");
	const log = path.join(sb.root, "fake-omp.log");
	fs.writeFileSync(
		file,
		`#!/bin/sh
LOG=\${BENCH_OMP_LOG:-${log}}
WORK=\${BENCH_WORK_MS:-1000}
state() { t=$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'); printf '\\033]7501;state=%s:app=omp\\007' "$1"; echo "$t $HC_TERMINAL_ID $1" >> "$LOG"; }
state idle
echo "fake omp ready"
while IFS= read -r line; do
  state working
  echo "task: $line"
  /usr/bin/perl -e "select(undef,undef,undef,$WORK/1000)"
  echo "fake answer for: $line"
  state done
done
`,
		{ mode: 0o755 },
	);
	return file;
}

// The herdr-resume breadcrumb folder the watch and /reload read (os.homedir() is the sandbox home).
export function crumbDir(): string {
	const dir = path.join(os.homedir(), ".local/state/omp-herdr-resume");
	assertNotReal(dir);
	if (!dir.startsWith(BENCH_ROOT)) throw new Error(`breadcrumb folder ${dir} is not in the sandbox`);
	return dir;
}

export async function buildWorld(sb: Sandbox, instance: Instance, log: (m: string) => void): Promise<World> {
	const fake = writeFakeOmp(sb);
	const fakeLog = path.join(sb.root, "fake-omp.log");
	const folder = sb.work("orchestrator");
	const spaceIds: string[] = [];
	const newSpace = async (name: string, argv: string[]) => {
		const c = await instance.app<Created>(["do", "space.new", "--name", name, "--folder", folder, "--tab", "main", "--argv", JSON.stringify(argv), "--focus", "false"]);
		spaceIds.push(c.space);
		return c;
	};
	// The worker program: the fake omp, with a fixed work time per prompt.
	const workerArgv = ["/usr/bin/env", `BENCH_WORK_MS=${WORK_MS}`, fake];

	const t0 = now();
	const orch = await newSpace("tmp-bench-orchestrator", ["/bin/sh", "-c", "exec cat >/dev/null"]);
	const workers: Worker[] = [];
	for (let i = 0; i < WORKER_SPACES; i++) {
		const name = `tmp-bench-s${i}`;
		const c = await newSpace(name, workerArgv);
		workers.push({ terminal: c.terminal, space: c.space, spaceName: name });
		if (i < TWO_TAB_SPACES) {
			const t = await instance.app<Created>(["do", "tab.new", "--space", c.space, "--name", "second", "--folder", folder, "--argv", JSON.stringify(workerArgv), "--focus", "false"]);
			workers.push({ terminal: t.terminal, space: c.space, spaceName: name });
		}
	}
	// Every worker must report itself as omp (idle) before a test uses it.
	await waitFor(
		async () => {
			const infos = await Promise.all(workers.map(w => hc(sb, ["get", w.terminal]).catch(() => undefined)));
			return infos.every(i => i?.status?.app === "omp" && i.status.state === "idle");
		},
		"every fake worker to report idle",
		30_000,
		200,
	);
	log(`orchestrator: ${spaceIds.length} spaces, ${workers.length} fake workers ready in ${Math.round(now() - t0)} ms`);
	return { orchTerminal: orch.terminal, orchSpace: orch.space, workers, spaceIds, fakeLog };
}

// Waits until a worker is idle or done again (it may still be busy from an earlier run).
export async function untilFree(sb: Sandbox, terminal: string) {
	await waitFor(
		async () => {
			const s = (await hc(sb, ["get", terminal]).catch(() => undefined))?.status?.state;
			return s === "idle" || s === "done";
		},
		`${terminal} to stop working`,
		WORK_MS + 15_000,
		100,
	);
}

// The time the fake worker logged `state` (working or done) first after `after` (ms), or undefined.
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

// Gives a worker a breadcrumb and a session file with one finished answer, as herdr-resume and
// omp would for a real worker, so the watch reads the answer from the session (the normal path).
export async function writeCrumb(sb: Sandbox, terminal: string) {
	const info = await hc(sb, ["get", terminal]);
	const dir = crumbDir();
	fs.mkdirSync(dir, { recursive: true });
	const session = path.join(sb.work("orchestrator-sessions"), `${terminal}.jsonl`);
	assertNotReal(session);
	const entry = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
	fs.writeFileSync(session, `${entry("user", "bench task")}\n${entry("assistant", "Done. See https://example.com/bench/1 for the result.")}\n`);
	fs.writeFileSync(path.join(dir, terminal), `${info.created_ms}\n${session}\n`);
}

export function removeCrumb(terminal: string) {
	fs.rmSync(path.join(crumbDir(), terminal), { force: true });
}

// Closes every space this case made and waits until the test core has none of their terminals.
export async function closeWorld(sb: Sandbox, instance: Instance, ids: string[], log: (m: string) => void) {
	for (const id of ids) await instance.app(["do", "space.close", "--id", id, "--confirmed", "true"]).catch(err => log(`orchestrator: close ${id}: ${err}`));
	const left = async () => {
		const { spaces } = await instance.app<{ spaces: { id: string; name: string }[] }>(["ls"]);
		return spaces.filter(s => s.name.startsWith("tmp-bench-"));
	};
	for (let i = 0; i < 50 && (await left()).length > 0; i++) await sleep(100);
	const still = await left();
	if (still.length) log(`orchestrator: spaces still open after close: ${still.map(s => s.name).join(", ")}`);
}
