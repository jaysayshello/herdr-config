// Gives each Herdr (herdr-core) terminal its own omp session. A bare `omp` in
// that terminal resumes it, and after a reboot or core crash (hc replaces a lost
// kept terminal with a fresh login shell at the same address) the shell reopens
// it by itself. Both live in ~/.zshrc: `omp` and `_herdr_omp_resume`.
//
// Breadcrumb: ~/.local/state/omp-herdr-resume/<HC_TERMINAL_ID>
//   line 1: the terminal's created_ms (a reused address must not resume)
//   line 2: the session file
//   line 3: `quit` after a normal quit, so a recovered shell does not start omp.
// A shutdown signal (SIGTERM/SIGHUP) adds no mark, since that is how a reboot
// ends omp.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const terminal = process.env.HC_TERMINAL_ID;
const dir = path.join(os.homedir(), ".local/state/omp-herdr-resume");
const crumb = terminal ? path.join(dir, terminal) : undefined;

let signaled = false;
if (crumb) {
	for (const sig of ["SIGTERM", "SIGHUP"] as const) {
		// With no handler of omp's own, the default action ends the process before
		// session_shutdown; adding one here would stop the signal from ending omp.
		if (process.listenerCount(sig) > 0) process.prependListener(sig, () => { signaled = true; });
	}
}

let createdMs: Promise<string | undefined> | undefined;
function terminalCreatedMs(): Promise<string | undefined> {
	if (createdMs) return createdMs;
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	createdMs = promise;
	execFile("hc", ["get", terminal!, "--json"], { timeout: 5000 }, (err, stdout) => {
		if (err) return resolve(undefined);
		try {
			const ms = JSON.parse(stdout).created_ms;
			resolve(typeof ms === "number" ? String(ms) : undefined);
		} catch {
			resolve(undefined);
		}
	});
	return promise;
}

async function record(ctx: ExtensionContext): Promise<void> {
	if (!crumb || !ctx.hasUI || ctx.mode !== "tui") return;
	const file = ctx.sessionManager.getSessionFile();
	const created = await terminalCreatedMs();
	if (!file || !created) return;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${crumb}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${created}\n${file}\n`);
		fs.renameSync(tmp, crumb);
	} catch {
		// Best effort: a missing breadcrumb only means no auto-resume.
	}
}

export default function herdrResume(pi: ExtensionAPI) {
	if (!crumb) return;
	pi.on("session_start", (_event, ctx) => record(ctx));
	pi.on("session_switch", (_event, ctx) => record(ctx));
	pi.on("session_branch", (_event, ctx) => record(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (signaled || !ctx.hasUI || ctx.mode !== "tui") return;
		if (fs.existsSync(crumb)) fs.appendFileSync(crumb, "quit\n");
	});
}
