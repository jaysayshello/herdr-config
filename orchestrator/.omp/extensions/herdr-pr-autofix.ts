// When one of your pull requests moves from draft to ready, this starts an omp agent in its own tab
// of the Herdr space SPACE, to fix its Compass and Semgrep findings. The tab is named for the pull
// request (`demo#42`), and omp runs in the folder of the pull request's project, so the space you
// work in keeps its layout. It reads the polls of herdr-pr-ready.ts from the event bus, so it makes
// no GitHub query of its own. A move on GitHub and the Move to Ready menu of the Pull requests
// panel both show in the next poll.
// Guards: one agent per pull request and head commit (STATE); a session's first poll only records
// the drafts, unless DRAFTS has those of a poll in the last DRAFTS_MS, so a move to ready during a
// /reload still starts an agent; only pull requests whose author is the gh user.
// The folder is that of an omp terminal whose folder has the pull request's link in a tracking file
// (TRACKING), or is a clone of its repo on its branch. Terminals in SPACE and in the orchestrator's
// folder do not count. With no such space or several, nothing starts. Either way the orchestrator
// gets a <herdr-pr-autofix> message.
// A tab closes, with a <herdr-pr-autofix-closed> message, when its agent is done (done or idle at
// two polls in a row, at the same turn) or when the pull request is merged or closed, even if the
// agent still runs. A blocked agent or one with an error keeps its tab. STATE keeps each tab, so
// a restart of the orchestrator can still close it; a tab that is gone is dropped without a word.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { herdrClient } from "../tools/herdr.ts";
import { type OpenPr, POLL_EVENT, type Poll } from "./herdr-pr-ready.ts";
import { FORGET_EVENT } from "./herdr-watch.ts";

// The switch: false starts and closes no agents.
const ENABLED = true;
// No tmp- prefix, so that the orchestrator does not close it as a temporary space.
const SPACE = "reviewers";
const STATE = path.join(os.homedir(), ".local/state/herdr-pr-autofix/agents.json");
// The drafts at the last poll of any session. Older than DRAFTS_MS, they no longer count: a move
// to ready while the orchestrator was off for long is old news, and gets no agent.
const DRAFTS = path.join(os.homedir(), ".local/state/herdr-pr-autofix/drafts.json");
const DRAFTS_MS = 10 * 60_000;
// Each project folder logs its pull requests in these files.
const TRACKING = ["MERGED-PRS.md", "TODO.md", "README.md"];

interface Outcome {
	result: "started" | "no space" | "several spaces" | "error";
	spaceId?: string;
	tab?: string;
	tabId?: string;
	terminal?: string;
	note?: string;
}
// One record per pull request and head commit an agent started at. tabId and terminal are set
// while its tab is open; spaceId and tabId are herdr-app ls ids, terminal is an hc address.
interface Agent {
	url: string;
	repo: string;
	number: number;
	title: string;
	head: string;
	spaceId?: string;
	tab?: string;
	tabId?: string;
	terminal?: string;
}
type Reason = "done" | "merged" | "closed";
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
		`2. Work in a local clone of ${repo} on branch ${p.headRefName}${clone ? ` (there is one at ${clone})` : ""}. If that clone has uncommitted changes or another branch checked out, do not change it: clone the repo again into a temporary folder and work there.`,
		"3. Wait for the Compass check to start and finish on the head commit, as the fix skill's Phase 4b loop does. Then fix every Compass finding with the fix skill.",
		"4. If the Compass job is skipped on the head commit, this repo starts Compass only after a pull request comment that asks for it. Then stop at once and reply with the one line `Compass needs a comment`. Do not post that comment.",
		"5. Also fix the Semgrep findings: the failures of the `semgrep-cloud-platform/scan` check and the Semgrep review comments. Use the same rules as for Compass: real fixes only, a guard test for each fix, the ledger, no replies to bot comments, `git push --force-with-lease`, and resolve each fixed thread.",
		"6. Stop after 3 rounds, even if findings are left, and say what is left.",
		"7. Do not merge or approve the pull request, and do not move it back to draft.",
		"8. This tab closes about 2 minutes after you stop. If you need an answer from the user, ask with the ask tool, so that the tab stays open until the user answers.",
	].join("\n");
}

function load(): Agent[] {
	try {
		return JSON.parse(fs.readFileSync(STATE, "utf8"));
	} catch {
		return [];
	}
}

function loadDrafts(): Set<string> | undefined {
	try {
		const { at, urls } = JSON.parse(fs.readFileSync(DRAFTS, "utf8"));
		return Date.now() - at <= DRAFTS_MS ? new Set(urls) : undefined;
	} catch {
		return undefined;
	}
}

function write(file: string, data: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
	fs.renameSync(`${file}.tmp`, file);
}

export default function herdrPrAutofix(pi: ExtensionAPI) {
	if (!ENABLED) return;
	const herdr = herdrClient(pi.exec);
	// The urls of the drafts at the last poll of this session.
	let drafts: Set<string> | undefined;
	// terminal -> the turn at which the last poll saw it done.
	const doneAt = new Map<string, number>();
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
		// An agent in the orchestrator's folder would load the orchestrator's own rules.
		const own = process.cwd();
		const omp: { space: string; cwd: string }[] = [];
		await Promise.all(
			spaces
				.filter(space => space.name !== SPACE)
				.flatMap(space =>
					space.tabs.flatMap(tab =>
						tab.terminals.map(async term => {
							const info = await herdr.get(hcId(term.terminal)).catch(() => undefined);
							const cwd = info?.foreground?.cwd ?? info?.cwd;
							if (info?.status?.app === "omp" && cwd && cwd !== own) omp.push({ space: space.name, cwd });
						}),
					),
				),
		);
		const checks = new Map<string, Promise<Match | undefined>>();
		const hits: { space: string; cwd: string; clone?: string }[] = [];
		for (const t of omp) {
			if (!checks.has(t.cwd)) checks.set(t.cwd, belongs(t.cwd, p));
			const hit = await checks.get(t.cwd);
			if (hit) hits.push({ ...t, ...hit });
		}
		const matched = [...new Set(hits.map(h => h.space))];
		if (matched.length === 0)
			return { result: "no space", note: "no omp session sits in a folder that logs this pull request or in a clone on its branch" };
		if (matched.length > 1) return { result: "several spaces", note: `spaces ${matched.join(", ")}` };
		// The project folder, where the tracking files are, before a clone.
		const folder = (hits.find(h => !h.clone) ?? hits[0]).cwd;
		const clone = hits.find(h => h.clone)?.clone;
		const tab = `${p.repository.nameWithOwner.split("/")[1]}#${p.number}`;
		const t = await herdr.newTab(SPACE, tab, folder, task(p, clone));
		const at = { spaceId: t.space, tab, tabId: t.tab, terminal: t.terminal };
		try {
			await herdr.waitStarted(t.terminal);
		} catch (err) {
			return { result: "error", ...at, note: err instanceof Error ? err.message : String(err) };
		}
		return { result: "started", ...at, note: `project space ${matched[0]}, folder ${folder}` };
	}

	function send(type: string, lines: string[]) {
		pi.sendMessage(
			{ customType: type, content: `<${type}>\n${lines.join("\n")}\n</${type}>`, display: false, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
	}

	function tell(p: OpenPr, o: Outcome) {
		send("herdr-pr-autofix", [
			`result: ${o.result}`,
			`repo: ${p.repository.nameWithOwner}`,
			`number: ${p.number}`,
			`title: ${p.title}`,
			`url: ${p.url}`,
			...(o.tabId ? [`space: ${SPACE}`, `space_id: ${o.spaceId}`, `tab: ${o.tab}`, `terminal: ${o.terminal}`] : []),
			...(o.note ? [`note: ${o.note}`] : []),
		]);
	}

	// Closes the agent's tab and returns the record without it. A tab that is gone sends nothing.
	async function close(a: Agent, reason: Reason): Promise<Agent> {
		const { spaceId, tab, tabId, terminal, ...rest } = a;
		if (!spaceId || !tabId || !terminal) return rest;
		pi.events.emit(FORGET_EVENT, { terminal });
		doneAt.delete(terminal);
		if (await herdr.closeTab(spaceId, tabId, terminal))
			send("herdr-pr-autofix-closed", [
				`reason: ${reason}`,
				`repo: ${a.repo}`,
				`number: ${a.number}`,
				`title: ${a.title}`,
				`url: ${a.url}`,
				`space: ${SPACE}`,
				`space_id: ${spaceId}`,
				`tab: ${tab}`,
				`terminal: ${terminal}`,
			]);
		return rest;
	}

	// Done or idle after its first turn, at the same turn as at the last poll.
	async function done(a: Agent): Promise<boolean> {
		if (!a.terminal) return false;
		const info = await herdr.get(a.terminal).catch(() => undefined);
		const state = info?.status?.state;
		const turn = info?.turn ?? 0;
		if (info?.status?.app !== "omp" || (state !== "done" && state !== "idle") || turn === 0) {
			doneAt.delete(a.terminal);
			return false;
		}
		if (doneAt.get(a.terminal) === turn) return true;
		doneAt.set(a.terminal, turn);
		return false;
	}

	// Each record with an open tab: close it if its pull request left the open list (merged, or
	// closed; a pull request past the newest 100 open would count as closed too) or if its
	// agent is done. Records of pull requests that are no longer open drop out.
	async function sweep(poll: Poll, agents: Agent[]): Promise<Agent[]> {
		const open = new Set(poll.open.map(p => p.url));
		const merged = new Set(poll.merged.map(p => p.url));
		const next: Agent[] = [];
		for (const a of agents) {
			try {
				if (!open.has(a.url)) {
					if (a.tabId) await close(a, merged.has(a.url) ? "merged" : "closed");
					continue;
				}
				next.push(a.tabId && (await done(a)) ? await close(a, "done") : a);
			} catch {
				// Herdr did not answer: keep the record and try again at the next poll.
				next.push(a);
			}
		}
		return next;
	}

	async function onPoll(poll: Poll) {
		const before = drafts ?? loadDrafts();
		const now = new Set(poll.open.filter(p => p.isDraft).map(p => p.url));
		drafts = now;
		const saved = load();
		const agents = await sweep(poll, saved);
		const moved = before
			? poll.open.filter(p => before.has(p.url) && !p.isDraft && p.author?.login === poll.login)
			: [];
		for (const p of moved) {
			if (agents.some(a => a.url === p.url && a.head === p.headRefOid)) continue;
			const o = await start(p).catch((err): Outcome => ({ result: "error", note: err instanceof Error ? err.message : String(err) }));
			// A pull request with no space is not recorded, so a move back to draft and to ready
			// again tries again.
			if (o.result === "started" || o.result === "error") {
				const { spaceId, tab, tabId, terminal } = o;
				agents.push({ url: p.url, repo: p.repository.nameWithOwner, number: p.number, title: p.title, head: p.headRefOid, spaceId, tab, tabId, terminal });
			}
			tell(p, o);
		}
		if (JSON.stringify(agents) !== JSON.stringify(saved)) write(STATE, agents);
		// Last, so that a restart during a start finds the move again.
		write(DRAFTS, { at: Date.now(), urls: [...now] });
	}

	// Polls arrive each minute; a start can take 45 s, so they run one at a time.
	pi.events.on(POLL_EVENT, data => {
		queue = queue.then(() => onPoll(data as Poll)).catch(() => {});
	});
}
