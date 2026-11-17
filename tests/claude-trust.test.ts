// Unit tests of orchestrator/.omp/lib/claude-trust.ts, on a Claude config folder in a temporary folder.
// Run: tests/run.sh tests/claude-trust.test.ts
import { assertNotReal } from "../bench/lib/guard.ts";
import { afterAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeConfigFile, trustFolder } from "../orchestrator/.omp/lib/claude-trust.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-trust-")));
const dir = path.join(root, "config");
const real = path.join(root, "real.json");
const backup = path.join(root, "state/claude.json.backup");
const folder = path.join(root, "project");
fs.mkdirSync(folder);
const saved = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = dir;
assertNotReal(claudeConfigFile());

beforeEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(real, { force: true });
	fs.rmSync(backup, { force: true });
	fs.mkdirSync(dir);
});
afterAll(() => {
	process.env.CLAUDE_CONFIG_DIR = saved;
	fs.rmSync(root, { recursive: true, force: true });
});

test("it waits for the lock that a running Claude holds, then writes", async () => {
	fs.writeFileSync(claudeConfigFile(), "{}");
	fs.mkdirSync(`${claudeConfigFile()}.lock`);
	setTimeout(() => fs.rmdirSync(`${claudeConfigFile()}.lock`), 300);
	const t0 = Date.now();
	expect(await trustFolder(folder, backup)).toBe("trusted");
	expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
	expect(JSON.parse(fs.readFileSync(claudeConfigFile(), "utf8")).projects[folder]).toEqual({ hasTrustDialogAccepted: true });
	expect(fs.existsSync(`${claudeConfigFile()}.lock`)).toBe(false);
});

test("a stale lock does not block it", async () => {
	fs.writeFileSync(claudeConfigFile(), "{}");
	const lock = `${claudeConfigFile()}.lock`;
	fs.mkdirSync(lock);
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lock, old, old);
	expect(await trustFolder(folder, backup)).toBe("trusted");
	expect(fs.existsSync(lock)).toBe(false);
});

test("a linked config stays a link, and a second call changes nothing", async () => {
	fs.writeFileSync(real, '{"theme":"dark"}');
	fs.symlinkSync(real, claudeConfigFile());
	expect(await trustFolder(folder, backup)).toBe("trusted");
	expect(fs.lstatSync(claudeConfigFile()).isSymbolicLink()).toBe(true);
	expect(JSON.parse(fs.readFileSync(real, "utf8"))).toEqual({ theme: "dark", projects: { [folder]: { hasTrustDialogAccepted: true } } });
	expect(fs.readFileSync(backup, "utf8")).toBe('{"theme":"dark"}');
	const mtime = fs.statSync(real).mtimeMs;
	expect(await trustFolder(folder, backup)).toBe("already trusted");
	expect(fs.statSync(real).mtimeMs).toBe(mtime);
});
