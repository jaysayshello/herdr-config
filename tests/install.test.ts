// Runs install.sh --files-only with HOME in a temp dir. --files-only skips launchctl, the Focus
// app builds, the reloads and herdr-app, so nothing here reaches the real Mac or Herdr window.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "install.sh");
const HOOK = "sh ~/.claude/hooks/herdr-claude.sh";
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "StopFailure", "PreCompact", "SessionEnd"];

// A first install copies about 200 files, a few seconds of cp and mv.
setDefaultTimeout(60_000);
let root: string;
let home: string;
let bin: string;
let app: string;
let orch: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "herdr-install-"));
	home = join(root, "home");
	bin = join(root, "bin");
	app = join(home, ".config/herdr-app");
	orch = join(home, "Projects/herdr-orchestrator-2026-11-08/.omp");
	mkdirSync(home, { recursive: true });
	mkdirSync(bin, { recursive: true });
	// install.sh only looks for rex on PATH; --files-only never runs it.
	writeFileSync(join(bin, "rex"), "#!/bin/sh\nexit 1\n");
	chmodSync(join(bin, "rex"), 0o755);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function put(file: string, text: string) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

async function install() {
	const proc = Bun.spawn(["sh", SCRIPT, "--files-only"], {
		env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:${dirname(Bun.which("jq") ?? "/usr/bin/jq")}` },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	expect(err).toBe("");
	expect(code).toBe(0);
	return out;
}

const read = (file: string) => readFileSync(file, "utf8");
const claudeSettings = () => JSON.parse(read(join(home, ".claude/settings.json")));
const herdrHooks = (settings: any, event: string) =>
	(settings.hooks?.[event] ?? []).flatMap((m: any) => m.hooks).filter((h: any) => h.command.includes("herdr-claude.sh"));

test("a new home gets every file in its live place and the Claude hook on each event", async () => {
	await install();
	for (const [repo, live] of [
		["herdr/config.toml", ".config/herdr/config.toml"],
		["herdr-app/keys.json", ".config/herdr-app/keys.json"],
		["herdr-app/layouts/herdr-t3.json", ".config/herdr-app/layouts/herdr-t3.json"],
		["herdr-app/themes/ghostty.json", ".config/herdr-app/themes/ghostty.json"],
		["herdr-app/mods/t3-prs/main.js", ".config/herdr-app/mods/t3-prs/main.js"],
		["omp/launchagents/com.jay.omp-update.plist", "Library/LaunchAgents/com.jay.omp-update.plist"],
		["omp/extensions/herdr-resume.ts", ".omp/agent/extensions/herdr-resume.ts"],
		["orchestrator/.omp/tools/herdr.ts", "Projects/herdr-orchestrator-2026-11-08/.omp/tools/herdr.ts"],
		["claude/hooks/herdr-claude.sh", ".claude/hooks/herdr-claude.sh"],
		["rex/config/init.lua", ".config/rex/init.lua"],
		["rex/orchestrator/.omp/tools/rex.ts", "Projects/rex-orchestrator-2026-11-15/.omp/tools/rex.ts"],
	])
		expect(read(join(home, live))).toBe(read(join(REPO, repo)));
	for (const mod of readdirSync(join(REPO, "herdr-app/mods"))) expect(existsSync(join(app, "mods", mod, "main.js"))).toBe(true);
	// Scripts keep their execute bit, and a repo symlink stays a symlink.
	expect(Bun.spawnSync(["test", "-x", join(app, "scripts/herdr-focus.sh")]).exitCode).toBe(0);
	const glass = "peon/scripts/mac-overlay-glass.js";
	expect(readlinkSync(join(app, glass))).toBe(readlinkSync(join(REPO, "herdr-app", glass)));
	expect(read(join(app, glass))).toBe(read(join(REPO, "herdr-app/scripts/mac-overlay-herdr.js")));
	const settings = claudeSettings();
	for (const e of EVENTS) expect(herdrHooks(settings, e)).toEqual([{ type: "command", command: HOOK, timeout: 5 }]);
});

test("a second run keeps live-only files, backs up what it replaces and adds no hook twice", async () => {
	// Live files the repo does not have: an extension only on this machine, Herdr's generated types.
	put(join(orch, "extensions/ste100.ts"), "// mine\n");
	put(join(app, "mods/t3-prs/gpui-kit.d.ts"), "// generated\n");
	put(join(app, "keys.json"), '{"global":{}}\n');
	// settings.json kept in another repo, linked into ~/.claude.
	const peon = { matcher: "", hooks: [{ type: "command", command: "peon.sh", timeout: 10 }] };
	const dotfile = join(home, "dotfiles/claude-settings.json");
	put(dotfile, JSON.stringify({ model: "opus", hooks: { Stop: [peon] } }));
	chmodSync(dotfile, 0o600);
	mkdirSync(join(home, ".claude"), { recursive: true });
	symlinkSync(dotfile, join(home, ".claude/settings.json"));

	const first = await install();
	expect(first).toContain("updated ~/.config/herdr-app/keys.json");
	expect(read(join(orch, "extensions/ste100.ts"))).toBe("// mine\n");
	expect(read(join(app, "mods/t3-prs/gpui-kit.d.ts"))).toBe("// generated\n");
	expect(read(join(app, "keys.json"))).toBe(read(join(REPO, "herdr-app/keys.json")));
	const backups = join(home, ".local/state/herdr-config");
	const [backup] = readdirSync(backups);
	expect(read(join(backups, backup, app, "keys.json"))).toBe('{"global":{}}\n');
	expect(lstatSync(join(home, ".claude/settings.json")).isSymbolicLink()).toBe(true);
	const settings = claudeSettings();
	expect(settings.model).toBe("opus");
	expect(settings.hooks.Stop[0]).toEqual(peon);
	expect(herdrHooks(settings, "Stop")).toHaveLength(1);
	expect(lstatSync(dotfile).mode & 0o777).toBe(0o600);

	expect(await install()).toBe("All files were already up to date.\n");
	for (const e of EVENTS) expect(herdrHooks(claudeSettings(), e)).toHaveLength(1);
});
