// A test Herdr: its own window (HERDR_APP_HOME in the sandbox) on its own core (HC_SESSION
// herdrbench, state under the sandbox HOME). The person's window and core never see it. The
// window shows on screen while it runs; Herdr draws only a visible window, so it must.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Sandbox } from "./sandbox.ts";
import { json, now, run, sleep, waitFor } from "./proc.ts";

const live = new Set<Instance>();

export const hc = <T = any>(sb: Sandbox, args: string[]) => json<T>(sb.hc, [...args, "--json"]);
export const app = <T = any>(sb: Sandbox, args: string[]) => json<T>(sb.herdrApp, args);

export async function startCore(sb: Sandbox) {
	const r = await run(sb.hc, ["server", "start", "--json"]);
	if (r.code !== 0) throw new Error(`hc server start: ${r.stderr || r.stdout}`);
}

export async function stopCore(sb: Sandbox) {
	await run(sb.hc, ["server", "stop", "--json"]);
}

export interface Started {
	instance: Instance;
	// Milliseconds from the spawn of the app process.
	statusMs: number; // `herdr-app status` answers (the window's socket is up)
	frameMs?: number; // `herdr-app shot` returns a PNG (the first frame is drawn)
}

export class Instance {
	readonly proc: Bun.Subprocess;
	readonly t0: number;

	private constructor(
		readonly sb: Sandbox,
		extraEnv: Record<string, string>,
	) {
		fs.rmSync(path.join(sb.appHome, "herdr-app.sock"), { force: true });
		this.t0 = now();
		this.proc = Bun.spawn([sb.herdrApp], {
			env: { ...process.env, ...extraEnv },
			stdout: "ignore",
			stderr: Bun.file(path.join(sb.root, "herdr-app.err")),
			cwd: sb.root,
		});
		live.add(this);
	}

	// Starts the window and waits until it answers; with waitFrame, also until it drew a frame.
	static async start(sb: Sandbox, opts: { waitFrame?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Started> {
		const instance = new Instance(sb, opts.env ?? {});
		const timeout = opts.timeoutMs ?? 30_000;
		await waitFor(async () => (await run(sb.herdrApp, ["status"], { timeoutMs: 5000 })).code === 0, "herdr-app status", timeout, 20);
		const statusMs = now() - instance.t0;
		let frameMs: number | undefined;
		if (opts.waitFrame) {
			const png = path.join(sb.root, "frame.png");
			await waitFor(async () => (await run(sb.herdrApp, ["shot", png], { timeoutMs: 5000 })).code === 0, "first frame", timeout, 20);
			frameMs = now() - instance.t0;
		}
		return { instance, statusMs, frameMs };
	}

	app<T = any>(args: string[]) {
		return app<T>(this.sb, args);
	}

	async shot(file: string) {
		const r = await run(this.sb.herdrApp, ["shot", file]);
		if (r.code !== 0) throw new Error(`herdr-app shot: ${r.stderr || r.stdout}`);
		return file;
	}

	// Quits through the app's own command; kills only this process if it does not end.
	async stop() {
		live.delete(this);
		if (this.proc.exitCode !== null) return;
		await run(this.sb.herdrApp, ["do", "app.quit"], { timeoutMs: 5000 }).catch(() => {});
		const end = now() + 5000;
		while (this.proc.exitCode === null && now() < end) await sleep(50);
		if (this.proc.exitCode === null) this.proc.kill();
		await this.proc.exited;
	}
}

// Ends every test window and the test core (run.ts calls this at the end, also after an error).
export async function stopAll(sb: Sandbox) {
	for (const i of [...live]) await i.stop();
	await stopCore(sb);
}

// A program that reports itself to hc as omp (OSC 7501), so herdr_spaces, herdr_send and
// herdr_watch treat it as an omp worker without starting a model. It reports idle, and for each
// line it reads: working, then done after BENCH_WORK_MS (default 1000). Each change is logged
// with a millisecond time to $BENCH_OMP_LOG (default <root>/fake-omp.log) as "<ms> <terminal> <state>".
export function writeFakeOmp(sb: Sandbox): string {
	const file = path.join(sb.root, "fake-omp.sh");
	const log = path.join(sb.root, "fake-omp.log");
	fs.writeFileSync(
		file,
		`#!/bin/sh
LOG=\${BENCH_OMP_LOG:-${log}}
WORK=\${BENCH_WORK_MS:-1000}
ms() { /usr/bin/perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'; }
# The clock is read first: perl takes about 20 ms to start, and the time must be the change's own.
state() { t=$(ms); printf '\\033]7501;state=%s:app=omp\\007' "$1"; echo "$t $HC_TERMINAL_ID $1" >> "$LOG"; }
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
