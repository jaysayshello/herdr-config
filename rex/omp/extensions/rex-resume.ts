// Gives each Rex terminal (block) its own omp session, as herdr-resume.ts does for Herdr. A bare
// `omp` in that terminal resumes it, and when the Rex server restores its sessions (after a
// reboot, an update or a server restart) the restored shell reopens it by itself. Both live in
// ~/.zshrc: `omp` and `_omp_resume`. The Rex orchestrator reads the same file to find a
// worker's session.
//
// Breadcrumb: ~/.local/state/omp-rex-resume/<block uuid>
//   line 1: the session file
//   line 2: `quit` after a normal quit, so a restored shell does not start omp.
// Rex block ids are never reused, so the breadcrumb needs no creation time.
// A shutdown signal (SIGTERM/SIGHUP) adds no mark, since that is how a reboot ends omp.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const block = process.env.REX_BLOCK?.replace(/^block:/, "");
const dir = path.join(os.homedir(), ".local/state/omp-rex-resume");
// A Herdr terminal keeps herdr-resume.ts in charge, even if it inherited REX_BLOCK.
const crumb = block && !process.env.HC_TERMINAL_ID ? path.join(dir, block) : undefined;

let signaled = false;
if (crumb) {
	for (const sig of ["SIGTERM", "SIGHUP"] as const) {
		// With no handler of omp's own, the default action ends the process before
		// session_shutdown; adding one here would stop the signal from ending omp.
		if (process.listenerCount(sig) > 0) process.prependListener(sig, () => { signaled = true; });
	}
}

function record(ctx: ExtensionContext): void {
	if (!crumb || !ctx.hasUI || ctx.mode !== "tui") return;
	const file = ctx.sessionManager.getSessionFile();
	if (!file) return;
	try {
		fs.mkdirSync(dir, { recursive: true });
		const tmp = `${crumb}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${file}\n`);
		fs.renameSync(tmp, crumb);
	} catch {
		// Best effort: a missing breadcrumb only means no auto-resume.
	}
}

export default function rexResume(pi: ExtensionAPI) {
	if (!crumb) return;
	pi.on("session_start", (_event, ctx) => record(ctx));
	pi.on("session_switch", (_event, ctx) => record(ctx));
	pi.on("session_branch", (_event, ctx) => record(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		if (signaled || !ctx.hasUI || ctx.mode !== "tui") return;
		if (fs.existsSync(crumb)) fs.appendFileSync(crumb, "quit\n");
	});
}
