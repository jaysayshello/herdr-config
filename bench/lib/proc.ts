// Small process and timing helpers. Every child gets the sandbox env that bench/run.sh set up
// (HOME, HC_SESSION, HERDR_APP_HOME), so hc and herdr-app only ever reach the test core and window.

// Wall clock in milliseconds, with sub-millisecond precision, comparable across processes.
export const now = () => performance.timeOrigin + performance.now();

export const sleep = Bun.sleep;

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
	killed: boolean;
}

export async function run(
	cmd: string,
	args: string[] = [],
	opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; input?: string; signal?: AbortSignal } = {},
): Promise<RunResult> {
	const t0 = now();
	const p = Bun.spawn([cmd, ...args], {
		env: { ...process.env, ...opts.env },
		cwd: opts.cwd,
		stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
		stdout: "pipe",
		stderr: "pipe",
		timeout: opts.timeoutMs ?? 120_000,
		signal: opts.signal,
	});
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout, stderr, ms: now() - t0, killed: p.signalCode != null };
}

// Runs and parses JSON stdout; throws with stderr when the command fails.
export async function json<T = any>(cmd: string, args: string[], opts?: Parameters<typeof run>[2]): Promise<T> {
	const r = await run(cmd, args, opts);
	if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr || r.stdout}`);
	return JSON.parse(r.stdout) as T;
}

// Polls fn every `every` ms until it returns a truthy value; returns it, or throws after timeoutMs.
export async function waitFor<T>(fn: () => Promise<T> | T, what: string, timeoutMs = 30_000, every = 50): Promise<T> {
	const deadline = now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await sleep(every);
	}
}

// The shell-free millisecond clock for scripts the suite writes (fake gh, fake omp): perl is on
// every Mac and starts in a few ms.
export const SH_NOW_MS = `/usr/bin/perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'`;
