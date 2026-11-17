// Folder trust for /claude. Claude Code asks "Is this a project you trust?" once per folder, and runs
// no hook before the answer. It keeps the answer in its global config as
// projects["<real path>"].hasTrustDialogAccepted, and a folder below a trusted one counts as trusted.
// trustFolder sets only that key, for only the one folder. It makes no Herdr calls, so tests can call it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Claude reads $CLAUDE_CONFIG_DIR/.claude.json when the variable is set, else ~/.claude.json.
export function claudeConfigFile(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

// Claude writes the config under a proper-lockfile lock: a folder named <file>.lock, stale after 10 s.
// Taking the same lock keeps a running Claude from writing an older copy over this change.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

async function withLock<T>(file: string, fn: () => T): Promise<T> {
	const lock = `${file}.lock`;
	const by = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.mkdirSync(lock);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		let age = 0;
		try {
			age = Date.now() - fs.statSync(lock).mtimeMs;
		} catch {
			continue;
		}
		if (age > LOCK_STALE_MS) {
			try {
				fs.rmdirSync(lock);
			} catch {}
			continue;
		}
		if (Date.now() >= by) throw new Error(`${lock} stayed locked for ${LOCK_WAIT_MS / 1000} s`);
		await Bun.sleep(50);
	}
	try {
		return fn();
	} finally {
		fs.rmdirSync(lock);
	}
}

// Marks folder (by its real path: Claude resolves /tmp to /private/tmp) as trusted. It reads the newest
// config under the lock, changes that one key, and writes a temporary file that replaces the config.
// Before the first change it copies the config to backup, once. A config that does not parse is not
// changed: the call throws.
export async function trustFolder(folder: string, backup: string): Promise<"trusted" | "already trusted"> {
	const key = fs.realpathSync(folder);
	let file = claudeConfigFile();
	// A linked config stays a link: the change goes to the file it points at.
	try {
		file = fs.realpathSync(file);
	} catch {}
	return withLock(file, () => {
		let text: string | undefined;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const config = text === undefined ? {} : JSON.parse(text);
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${file} is not a JSON object`);
		const projects = config.projects && typeof config.projects === "object" ? config.projects : {};
		if (projects[key]?.hasTrustDialogAccepted === true) return "already trusted";
		if (text !== undefined && !fs.existsSync(backup)) {
			fs.mkdirSync(path.dirname(backup), { recursive: true });
			fs.writeFileSync(backup, text, { mode: 0o600 });
		}
		config.projects = { ...projects, [key]: { ...projects[key], hasTrustDialogAccepted: true } };
		const mode = text === undefined ? 0o600 : fs.statSync(file).mode & 0o777;
		const tmp = `${file}.herdr-switch-${process.pid}-${Date.now()}.tmp`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
			fs.chmodSync(tmp, mode);
			fs.renameSync(tmp, file);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		}
		return "trusted";
	});
}
