// The test home. bench/run.sh points HOME, HC_SESSION and HERDR_APP_HOME here before Bun starts;
// this file fills it:
//   $HOME/.config/herdr-app   the Herdr config from the repo checkout under test (not the live copy)
//   $HOME/.local/bin          herdr-app, hc, herdr-core and omp (the real binaries) and a fake gh
//   $HOME/.omp/agent          the real omp config, linked (auth, models, extensions, skills), with
//                             empty sessions, so a test omp starts as the person's omp does but
//                             writes its sessions and resume breadcrumbs here
// Nothing here writes in the real home.
import * as fs from "node:fs";
import * as path from "node:path";
import { BENCH_ROOT, REAL_HOME } from "./guard.ts";

export interface Sandbox {
	root: string;
	home: string;
	appHome: string;
	bin: string;
	// Real binaries by absolute path (the PATH starts with the sandbox bin, where gh is fake).
	realGh: string;
	hc: string;
	herdrApp: string;
	omp: string;
	// Scratch folder for a case: <root>/work/<name>, made on first use.
	work(name: string): string;
}

// The mods the person made (sync.sh's list); Herdr installs its shipped mods by itself.
export const MODS = ["t3-agents", "t3-beads", "t3-chrome", "t3-inbox", "t3-menu", "t3-new-menu", "t3-pane", "t3-prs", "t3-spaces", "t3-tabs", "tmux-keys"];
// omp's own files that a test omp may share: config and caches. Sessions, history and memory
// outboxes stay separate so the person's session list and prompt history stay clean.
// agent.db (the login) stays linked: a test omp that refreshes a token must refresh the person's
// own copy, or the real login could end up with a used token. Caches are copied, so a test omp
// starts warm (a cold cache adds about 0.8 s) without writing to the real ones.
const OMP_SHARED = ["AGENTS.md", "agent.db", "config.yml", "mcp.json", "extensions", "skills", "themes", "skill-descriptions.db"];
const OMP_COPIED = ["models.db", "cache"];
// Home files that change what omp loads at start (skills, rules, git identity).
const HOME_SHARED = [".claude", ".agents", "AGENTS.md", ".gitconfig"];

function link(from: string, to: string) {
	if (!fs.existsSync(from)) return;
	fs.mkdirSync(path.dirname(to), { recursive: true });
	fs.rmSync(to, { force: true, recursive: true });
	fs.symlinkSync(from, to);
}

function which(name: string): string {
	const dirs = (process.env.BENCH_REAL_PATH ?? process.env.PATH ?? "").split(":");
	for (const d of dirs) {
		const p = path.join(d, name);
		if (!d.startsWith(BENCH_ROOT) && fs.existsSync(p)) return fs.realpathSync(p);
	}
	throw new Error(`${name} not found on PATH`);
}

// Copies the repo's Herdr config into appHome: keys, settings, the herdr-t3 layout, the theme and
// the mods, and selects herdr-t3. scripts/herdr-alert.sh is a stub, so a test toast never draws
// a banner over the person's screen.
export function writeAppHome(repo: string, appHome: string) {
	const src = path.join(repo, "herdr-app");
	fs.rmSync(appHome, { recursive: true, force: true });
	fs.mkdirSync(path.join(appHome, "scripts"), { recursive: true });
	for (const f of ["keys.json", "settings.json", "layouts/herdr-t3.json", "layouts/herdr-t3.svg", "themes/ghostty.json"]) {
		fs.mkdirSync(path.dirname(path.join(appHome, f)), { recursive: true });
		fs.copyFileSync(path.join(src, f), path.join(appHome, f));
	}
	for (const m of MODS) fs.cpSync(path.join(src, "mods", m), path.join(appHome, "mods", m), { recursive: true });
	fs.copyFileSync(path.join(src, "scripts/toast-external.js"), path.join(appHome, "scripts/toast-external.js"));
	fs.writeFileSync(path.join(appHome, "scripts/herdr-alert.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(path.join(appHome, "shared.json"), JSON.stringify({ layout: "herdr-t3", "frame.welcomed": "finished" }));
	// The "Updated to …" toast shows once per version; the live copy already saw it.
	const notes = path.join(REAL_HOME, ".config/herdr-app/update-notes.json");
	if (fs.existsSync(notes)) fs.copyFileSync(notes, path.join(appHome, "update-notes.json"));
}

export function prepareSandbox(repo: string): Sandbox {
	const root = BENCH_ROOT;
	const home = process.env.HOME!;
	const appHome = process.env.HERDR_APP_HOME!;
	const bin = path.join(home, ".local/bin");
	fs.mkdirSync(bin, { recursive: true });
	const sb: Sandbox = {
		root,
		home,
		appHome,
		bin,
		realGh: which("gh"),
		hc: which("hc"),
		herdrApp: which("herdr-app"),
		omp: which("omp"),
		work(name) {
			const dir = path.join(root, "work", name);
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		},
	};
	for (const [name, target] of [["hc", sb.hc], ["herdr-core", sb.hc], ["herdr-app", sb.herdrApp], ["omp", sb.omp]]) link(target, path.join(bin, name));
	const bun = process.execPath;
	link(bun, path.join(bin, "bun"));

	writeAppHome(repo, appHome);

	const agent = path.join(home, ".omp/agent");
	fs.mkdirSync(path.join(agent, "sessions"), { recursive: true });
	for (const f of OMP_SHARED) link(path.join(REAL_HOME, ".omp/agent", f), path.join(agent, f));
	for (const f of OMP_COPIED) {
		const from = path.join(REAL_HOME, ".omp/agent", f);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(agent, f), { recursive: true });
	}
	for (const f of HOME_SHARED) link(path.join(REAL_HOME, f), path.join(home, f));
	const coreConfig = path.join(REAL_HOME, ".config/herdr-core/config.toml");
	if (fs.existsSync(coreConfig)) {
		fs.mkdirSync(path.join(home, ".config/herdr-core"), { recursive: true });
		fs.copyFileSync(coreConfig, path.join(home, ".config/herdr-core/config.toml"));
	}
	return sb;
}
