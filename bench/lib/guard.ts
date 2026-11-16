// Stops the suite before it can touch the person's real state. Import this first, in every process
// that loads orchestrator or mod code. Bun reads HOME once at start, so the HOME check must pass
// before any extension module computes its state path (herdr-pr-ready.ts, herdr-pr-autofix.ts and
// herdr-resume.ts all join os.homedir() at import time).
import * as os from "node:os";
import * as path from "node:path";

// Bun's os.userInfo().homedir follows HOME, so the real home comes from run.sh, which saves HOME
// before it points HOME at the sandbox.
export const REAL_HOME = process.env.BENCH_REAL_HOME ?? "";
export const BENCH_ROOT = process.env.BENCH_ROOT ?? "";

const REAL_STATE = ["herdr-pr-ready", "herdr-pr-autofix", "omp-herdr-resume"].map(d => path.join(REAL_HOME, ".local/state", d));

function stop(why: string): never {
	console.error(`bench: stopped before any test ran: ${why}`);
	process.exit(2);
}

export function assertSandboxed() {
	const home = os.homedir();
	if (!/^(\/private)?\/tmp\/hb-\d+$/.test(BENCH_ROOT)) stop("BENCH_ROOT is not /tmp/hb-<pid> (run bench/run.sh, not bun directly)");
	if (!REAL_HOME || REAL_HOME.startsWith("/tmp/") || REAL_HOME.startsWith("/private/tmp/"))
		stop(`BENCH_REAL_HOME is ${REAL_HOME || "unset"}: start the suite from a normal shell`);
	if (home === REAL_HOME || !home.startsWith(BENCH_ROOT)) stop(`HOME is ${home}, not a folder under ${BENCH_ROOT}`);
	for (const dir of REAL_STATE) {
		const mine = path.join(home, ".local/state", path.basename(dir));
		if (mine === dir || mine.startsWith(`${REAL_HOME}/.local/state/`)) stop(`the state folder ${mine} is the real one`);
	}
	if (process.env.HC_SESSION !== "herdrbench") stop("HC_SESSION is not herdrbench, so hc would drive the real core");
	const app = process.env.HERDR_APP_HOME ?? "";
	if (!app.startsWith(BENCH_ROOT)) stop(`HERDR_APP_HOME is ${app || "unset"}, so herdr-app would drive the real window`);
}

// A state path a module under test computed: refuse it when it is in the real home.
export function assertNotReal(file: string) {
	if (file.startsWith(`${REAL_HOME}/`)) stop(`a module under test uses the real path ${file}`);
}

assertSandboxed();
