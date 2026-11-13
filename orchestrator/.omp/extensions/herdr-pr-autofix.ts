// When one of your pull requests moves from draft to ready, this starts an omp agent beside a
// session in that pull request's Herdr space, to fix its Compass and Semgrep findings. It reads the
// polls of herdr-pr-ready.ts from the event bus, so it makes no GitHub query of its own. A move on
// GitHub and the Move to Ready menu of the Pull requests panel both show in the next poll.
// Guards: one agent per pull request and head commit (STATE); the first poll of a session only
// records the drafts; only pull requests whose author is the gh user.
// The space is the one with an omp terminal whose folder has the pull request's link in a tracking
// file (TRACKING), or is a clone of its repo on its branch. With no such space or several, nothing
// starts. Either way the orchestrator gets a <herdr-pr-autofix> message.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { herdrClient, type LsSpace } from "../tools/herdr.ts";
import { type OpenPr, POLL_EVENT, type Poll } from "./herdr-pr-ready.ts";

// The switch: false starts no agents.
const ENABLED = true;
const STATE = path.join(os.homedir(), ".local/state/herdr-pr-autofix/started.json");
// Each project folder logs its pull requests in these files.
const TRACKING = ["MERGED-PRS.md", "TODO.md", "README.md"];
const self = process.env.HC_TERMINAL_ID;

interface Outcome {
	result: "started" | "no space" | "several spaces" | "no omp terminal" | "error";
	space?: string;
	spaceId?: string;
	terminal?: string;
	note?: string;
}
// A folder of the pull request; clone is set when the folder is a clone on its branch.
interface Match {
	clone?: string;
}

function task(p: OpenPr, clone: string | undefined): string {
	const repo = p.repository.nameWithOwner;
	return [
		`Fix the Compass and Semgrep findings on ${p.url} (${repo}#${p.number}, branch ${p.headRefName}). It just moved from draft to ready at head commit ${p.headRefOid.slice(0, 7)}.`,
		"",
		"1. Read skill://fix and follow it.",
		`2. Work in a local clone of ${repo} on branch ${p.headRefName}${clone ? ` (this space has one at ${clone})` : ""}. If that clone has uncommitted changes or another branch checked out, do not change it: clone the repo again into a temporary folder and work there.`,
		"3. Wait for the Compass check to start and finish on the head commit, as the fix skill's Phase 4b loop does. Then fix every Compass finding with the fix skill.",
		"4. Also fix the Semgrep findings: the failures of the `semgrep-cloud-platform/scan` check and the Semgrep review comments. Use the same rules as for Compass: real fixes only, a guard test for each fix, the ledger, no replies to bot comments, `git push --force-with-lease`, and resolve each fixed thread.",
		"5. Stop after 3 rounds, even if findings are left, and say what is left.",
		"6. Do not merge or approve the pull request, and do not move it back to draft.",
	].join("\n");
}

export default function herdrPrAutofix(pi: ExtensionAPI) {
	if (!ENABLED) return;
	const herdr = herdrClient(pi.exec);
	// url -> isDraft at the last poll of this session.
	let drafts: Map<string, boolean> | undefined;
	let queue = Promise.resolve();

	// The pull request's link in a tracking file, or a clone of its repo on its branch (returned).
	async function belongs(cwd: string, p: OpenPr): Promise<Match | undefined> {
		const escaped = p.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const link = new RegExp(`${escaped}(?![0-9])`);
		for (const f of TRACKING) {
			try {
				if (link.test(fs.readFileSync(path.join(cwd, f), "utf8"))) return {};
			} catch {}
		}
		const remotes = await pi.exec("git", ["-C", cwd, "remote", "-v"]);
		if (remotes.code !== 0) return undefined;
		const repo = p.repository.nameWithOwner.toLowerCase();
		const ofRepo = remotes.stdout
			.split("\n")
			.some(l => l.toLowerCase().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s/)?.[1] === repo);
		if (!ofRepo) return undefined;
		const branch = await pi.exec("git", ["-C", cwd, "branch", "--show-current"]);
		return branch.code === 0 && branch.stdout.trim() === p.headRefName ? { clone: cwd } : undefined;
	}

	async function start(p: OpenPr): Promise<Outcome> {
		const { spaces, hcId } = await herdr.view();
		const omp: { space: LsSpace; terminal: string; cwd?: string }[] = [];
		await Promise.all(
			spaces.flatMap(space =>
				space.tabs.flatMap(tab =>
					tab.terminals.map(async term => {
						const terminal = hcId(term.terminal);
						const info = await herdr.get(terminal).catch(() => undefined);
						if (info?.status?.app === "omp") omp.push({ space, terminal, cwd: info.foreground?.cwd ?? info.cwd });
					}),
				),
			),
		);
		const checks = new Map<string, Promise<Match | undefined>>();
		const hits: { space: LsSpace; terminal: string; clone?: string }[] = [];
		for (const t of omp) {
			if (!t.cwd) continue;
			if (!checks.has(t.cwd)) checks.set(t.cwd, belongs(t.cwd, p));
			const hit = await checks.get(t.cwd);
			if (hit) hits.push({ ...t, ...hit });
		}
		const matched = [...new Set(hits.map(h => h.space))];
		if (matched.length === 0)
			return { result: "no space", note: "no omp session sits in a folder that logs this pull request or in a clone on its branch" };
		if (matched.length > 1) return { result: "several spaces", note: `spaces ${matched.map(s => s.name).join(", ")}` };
		const space = matched[0];
		const at = { space: space.name, spaceId: hcId(space.id) };
		const beside =
			hits.find(h => h.terminal !== self)?.terminal ?? omp.find(t => t.space === space && t.terminal !== self)?.terminal;
		if (!beside) return { result: "no omp terminal", ...at, note: "only the orchestrator runs omp in that space" };
		const clone = hits.find(h => h.clone)?.clone;
		const agent = await herdr.newAgent(beside, task(p, clone));
		return { result: "started", ...at, terminal: agent.terminal, note: `split beside ${beside}` };
	}

	function tell(p: OpenPr, o: Outcome) {
		const body = [
			`result: ${o.result}`,
			`repo: ${p.repository.nameWithOwner}`,
			`number: ${p.number}`,
			`title: ${p.title}`,
			`url: ${p.url}`,
			...(o.space ? [`space: ${o.space}`, `space_id: ${o.spaceId}`] : []),
			...(o.terminal ? [`terminal: ${o.terminal}`] : []),
			...(o.note ? [`note: ${o.note}`] : []),
		].join("\n");
		pi.sendMessage(
			{ customType: "herdr-pr-autofix", content: `<herdr-pr-autofix>\n${body}\n</herdr-pr-autofix>`, display: false, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
	}

	async function onPoll(poll: Poll) {
		const before = drafts;
		drafts = new Map(poll.open.map(p => [p.url, p.isDraft]));
		if (!before) return;
		const moved = poll.open.filter(p => before.get(p.url) === true && !p.isDraft && p.author?.login === poll.login);
		if (moved.length === 0) return;
		let started: Record<string, string> = {};
		try {
			started = JSON.parse(fs.readFileSync(STATE, "utf8"));
		} catch {}
		const fresh = moved.filter(p => started[p.url] !== p.headRefOid);
		if (fresh.length === 0) return;
		// url -> the head commit an agent started at. Closed pull requests drop out. A pull request
		// with no space is not recorded, so a move back to draft and to ready again tries again.
		const next: Record<string, string> = {};
		for (const p of poll.open) if (started[p.url]) next[p.url] = started[p.url];
		for (const p of fresh) {
			const o = await start(p).catch(err => ({ result: "error" as const, note: err instanceof Error ? err.message : String(err) }));
			if (o.result === "started" || o.result === "error") next[p.url] = p.headRefOid;
			tell(p, o);
		}
		fs.mkdirSync(path.dirname(STATE), { recursive: true });
		fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(next));
		fs.renameSync(`${STATE}.tmp`, STATE);
	}

	// Polls arrive each minute; a start can take 45 s, so they run one at a time.
	pi.events.on(POLL_EVENT, data => {
		queue = queue.then(() => onPoll(data as Poll)).catch(() => {});
	});
}
