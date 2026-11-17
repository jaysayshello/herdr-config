// When one of your pull requests moves from draft to ready, this starts an omp agent in its own
// pane of the Herdr space SPACE, to fix its Compass and Semgrep findings until none are left. The
// agents sit side by side in the one tab of SPACE (TAB), with equal widths, so 4 moves in one poll
// give 4 agents that run at once and all show, and the space you work in keeps its layout. It reads
// the polls of herdr-pr-ready.ts from the event bus, so it makes no GitHub query of its own. A move
// on GitHub and the Move to Ready menu of the Pull requests panel both show in the next poll.
// Guards: one agent per pull request and head commit (STATE), and none while the pull request's
// pane is still open, so a push by the agent never starts a second one; a session's first poll
// only records the drafts, unless DRAFTS has those of a poll in the last DRAFTS_MS, so a move to
// ready during a /reload still starts an agent; only pull requests whose author is the gh user.
// Each agent works in its own clone in CLONES, so two agents (or an agent and you) never share a
// working tree. It starts in the folder of an omp or Claude terminal that has the pull request's
// link in a tracking file (TRACKING; terminals in SPACE and in the orchestrator's folder do not
// count), else in its clone. The orchestrator gets a <herdr-pr-autofix> message with the folder.
// A pane closes, with a <herdr-pr-autofix-closed> message, and its clone is deleted, when its
// agent is done (done or idle at two polls in a row, at the same turn) or when the pull request
// is merged or closed, even if the agent still runs. A blocked agent or one with an error keeps
// its pane and clone. STATE keeps each pane, so a restart of the orchestrator can still close it;
// a pane that is gone is dropped without a word.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { agentTool, herdrClient } from "../tools/herdr.ts";
import { type OpenPr, POLL_EVENT, type Poll } from "./herdr-pr-ready.ts";
import { FORGET_EVENT } from "./herdr-watch.ts";

// The switch: false starts and closes no agents.
const ENABLED = true;
// No tmp- prefix, so that the orchestrator does not close it as a temporary space.
const SPACE = "reviewers";
const TAB = "fix agents";
const STATE = path.join(os.homedir(), ".local/state/herdr-pr-autofix/agents.json");
// The drafts at the last poll of any session. Older than DRAFTS_MS, they no longer count: a move
// to ready while the orchestrator was off for long is old news, and gets no agent.
const DRAFTS = path.join(os.homedir(), ".local/state/herdr-pr-autofix/drafts.json");
const DRAFTS_MS = 10 * 60_000;
// Each project folder logs its pull requests in these files.
const TRACKING = ["MERGED-PRS.md", "TODO.md", "README.md"];
// One folder per agent, for its clone (`repo`) and its scratch files. Tests set the env var.
export const CLONES = process.env.HERDR_PR_AUTOFIX_CLONES ?? "/tmp/herdr-pr-autofix";
const CLONE_MS = 10 * 60_000;
// The safety stop of an agent: at most MAX_ROUNDS pushes of fixes, and a stop when one finding
// comes back after MAX_REPEATS fixes, because the fixes then chase each other.
const MAX_ROUNDS = 10;
const MAX_REPEATS = 2;

interface Outcome {
	result: "started" | "error";
	spaceId?: string;
	pane?: string;
	terminal?: string;
	folder?: string;
	note?: string;
}
// One record per pull request and head commit an agent started at. spaceId and terminal are set
// while its pane is open (a herdr-app ls id and an hc address); dir is its own folder in CLONES,
// until the pane closes.
interface Agent {
	url: string;
	repo: string;
	number: number;
	title: string;
	head: string;
	spaceId?: string;
	terminal?: string;
	dir?: string;
}
// The name of an agent's pane in messages: `demo#42`.
const paneName = (repo: string, number: number) => `${repo.split("/")[1]}#${number}`;
type Reason = "done" | "merged" | "closed";
// The folder an agent starts in, how it was found, its own folder in CLONES and its clone there.
interface Where {
	folder: string;
	how: string;
	dir: string;
	clone: string;
}

function task(p: OpenPr, w: Where): string {
	const repo = p.repository.nameWithOwner;
	return [
		`Fix the Compass and Semgrep findings on ${p.url} (${repo}#${p.number}, branch ${p.headRefName}). It just moved from draft to ready at head commit ${p.headRefOid.slice(0, 7)}. Keep going until Compass and Semgrep have no findings on the head commit.`,
		"",
		"1. Read skill://fix and follow it, with the changes below. Where they differ, these steps win. The only pull request comments you post are the two in steps 3 and 7.",
		`2. Work only in your own clone of ${repo} at ${w.clone}, on branch ${p.headRefName}. No other agent and no person uses it. Do not change any other clone of the repo. Keep your other files (scripts, notes, diffs) in ${w.dir}, outside the clone. That folder is deleted when your pane closes.`,
		"3. Compass: its review is the check whose name starts with `Compass Code Review` and the `ws-compass[bot]` review on the head commit. The jobs of the `Compass` workflow (`Run / Compass`, `Run / Apply Changes`, and the others) are its chat mode: ignore them, also when they are skipped. Never write `@ws-compass` in a comment, because that starts the chat mode, which can push commits. If the head commit has no `Compass Code Review` check and no Compass review 5 minutes after it was pushed (or now, if it is older), post one general pull request comment whose whole body is `/compass-review`. Post it at most once per head commit. If no Compass review of the head commit comes 30 minutes after that comment, stop and say so.",
		"4. Semgrep: the `semgrep-cloud-platform/scan` check and the Semgrep review comments on the head commit. Fix them with the same rules as Compass: real fixes only, a guard test for each fix, the ledger, no replies to bot comments, `git push --force-with-lease`, and resolve each fixed thread.",
		"5. The loop: after each push, wait for the Compass review and the Semgrep result of the new head commit, then fix what they find. Stop when both have no findings on the head commit, or when only findings you cannot fix are left. Wait inside your turn, with a bash loop (a background job is fine), and do not end your turn while you wait: this pane closes about 2 minutes after you stop.",
		`6. Safety stop: stop after ${MAX_ROUNDS} rounds (one round is one push of fixes), even if findings are left. Also stop when a finding comes back after you fixed it ${MAX_REPEATS} times.`,
		"7. A finding you cannot fix (it is wrong, out of scope, or needs the user), and every finding left at a safety stop: do not ask the user, and do not reply in its thread. When you stop, post one general pull request comment: the first line `🤖 Not fixed:`, then one line for each such finding, `- <file>:<line> <the finding in a few words>: <why, in 15 words or fewer>`. After a safety stop, add the line `- Stopped: <the reason>`. Post no such comment when you fixed every finding.",
		"8. Do not merge or approve the pull request, and do not move it back to draft.",
		"9. Your final reply: the rounds, the findings you fixed, the findings left, and the comments you posted.",
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

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export default function herdrPrAutofix(pi: ExtensionAPI) {
	if (!ENABLED) return;
	const herdr = herdrClient(pi.exec);
	// The urls of the drafts at the last poll of this session.
	let drafts: Set<string> | undefined;
	// terminal -> the turn at which the last poll saw it done.
	const doneAt = new Map<string, number>();
	let queue = Promise.resolve();

	// The pull request's link in a tracking file of folder cwd.
	function logs(cwd: string, p: OpenPr): boolean {
		const escaped = p.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const link = new RegExp(`${escaped}(?![0-9])`);
		for (const f of TRACKING) {
			try {
				if (link.test(fs.readFileSync(path.join(cwd, f), "utf8"))) return true;
			} catch {}
		}
		return false;
	}

	// The omp and Claude terminals outside SPACE and the orchestrator's folder, and the terminals
	// in SPACE. The fix agents themselves start as omp (newPane) whatever the mode is.
	async function scan() {
		const { spaces, hcId } = await herdr.view();
		// An agent in the orchestrator's folder would load the orchestrator's own rules.
		const own = process.cwd();
		const workers: { space: string; cwd: string }[] = [];
		await Promise.all(
			spaces
				.filter(space => space.name !== SPACE)
				.flatMap(space =>
					space.tabs.flatMap(tab =>
						tab.terminals.map(async term => {
							const info = await herdr.get(hcId(term.terminal)).catch(() => undefined);
							const cwd = info?.foreground?.cwd ?? info?.cwd;
							if (agentTool(info?.status?.app) && cwd && cwd !== own) workers.push({ space: space.name, cwd });
						}),
					),
				),
		);
		const open = new Set(
			spaces.filter(s => s.name === SPACE).flatMap(s => s.tabs.flatMap(t => t.terminals.map(term => hcId(term.terminal)))),
		);
		return { workers, open };
	}

	// Makes the agent's own clone of the pull request's branch, and finds the folder it starts in.
	// The folder is per pull request and head commit, so a later agent on the same pull request
	// never gets the clone of an earlier one.
	async function locate(p: OpenPr, workers: { space: string; cwd: string }[]): Promise<Where> {
		const repo = p.repository.nameWithOwner;
		const [owner, name] = repo.split("/");
		const dir = path.join(CLONES, `${owner}-${name}-${p.number}-${p.headRefOid.slice(0, 7)}`);
		const clone = path.join(dir, "repo");
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		// Blobless, so that a big repo clones fast; git gets the file contents it needs later.
		const args = ["repo", "clone", repo, clone, "--", "--filter=blob:none", "--branch", p.headRefName];
		const r = await pi.exec("gh", args, { signal: AbortSignal.timeout(CLONE_MS) });
		if (r.killed || r.code !== 0) {
			fs.rmSync(dir, { recursive: true, force: true });
			throw new Error(`gh repo clone ${repo} failed: ${(r.stderr || r.stdout).trim() || `code ${r.code}`}`);
		}
		const hits = workers.filter(t => logs(t.cwd, p)).sort((a, b) => a.space.localeCompare(b.space));
		if (hits.length === 0) return { folder: clone, dir, clone, how: `its own clone in ${CLONES}` };
		const spaces = [...new Set(hits.map(h => h.space))];
		const of = spaces.length > 1 ? `, one of spaces ${spaces.join(", ")}` : "";
		return { folder: hits[0].cwd, dir, clone, how: `project space ${hits[0].space}${of}` };
	}

	// Starts one agent per pull request and records it in agents. The clones and the waits for omp
	// run at once; the panes open one at a time, because the first one makes SPACE and each one
	// puts back the view that was shown.
	async function startAll(prs: OpenPr[], agents: Agent[]) {
		const runs: { p: OpenPr; o: Outcome; dir?: string }[] = [];
		try {
			const { workers, open } = await scan();
			// A push by the agent, then a move to draft and back, must not start a second agent.
			const todo = prs.filter(p => !agents.some(a => a.url === p.url && a.terminal && open.has(a.terminal)));
			const placed = await Promise.all(
				todo.map(p => locate(p, workers).then(w => ({ p, w }), (err: unknown) => ({ p, err }))),
			);
			for (const x of placed) {
				if (!("w" in x)) {
					runs.push({ p: x.p, o: { result: "error", note: message(x.err) } });
					continue;
				}
				const { p, w } = x;
				const pane = paneName(p.repository.nameWithOwner, p.number);
				try {
					const t = await herdr.newPane(SPACE, TAB, w.folder, task(p, w));
					runs.push({ p, dir: w.dir, o: { result: "started", spaceId: t.space, pane, terminal: t.terminal, folder: w.folder, note: w.how } });
				} catch (err) {
					fs.rmSync(w.dir, { recursive: true, force: true });
					runs.push({ p, o: { result: "error", folder: w.folder, note: message(err) } });
				}
			}
		} catch (err) {
			for (const p of prs) runs.push({ p, o: { result: "error", note: message(err) } });
		}
		await Promise.all(
			runs.map(async r => {
				if (!r.o.terminal) return;
				try {
					await herdr.waitStarted(r.o.terminal);
				} catch (err) {
					r.o = { ...r.o, result: "error", note: message(err) };
				}
			}),
		);
		for (const { p, o, dir } of runs) {
			const { spaceId, terminal } = o;
			agents.push({ url: p.url, repo: p.repository.nameWithOwner, number: p.number, title: p.title, head: p.headRefOid, spaceId, terminal, dir });
			tell(p, o);
		}
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
			...(o.terminal ? [`space: ${SPACE}`, `space_id: ${o.spaceId}`, `pane: ${o.pane}`, `terminal: ${o.terminal}`] : []),
			...(o.folder ? [`folder: ${o.folder}`] : []),
			...(o.note ? [`note: ${o.note}`] : []),
		]);
	}

	// Closes the agent's pane, deletes its folder in CLONES, and returns the record without them.
	// A pane that is gone sends nothing.
	async function close(a: Agent, reason: Reason): Promise<Agent> {
		const { spaceId, terminal, dir, ...rest } = a;
		if (spaceId && terminal) {
			pi.events.emit(FORGET_EVENT, { terminal });
			doneAt.delete(terminal);
			if (await herdr.closePane(spaceId, terminal))
				send("herdr-pr-autofix-closed", [
					`reason: ${reason}`,
					`repo: ${a.repo}`,
					`number: ${a.number}`,
					`title: ${a.title}`,
					`url: ${a.url}`,
					`space: ${SPACE}`,
					`space_id: ${spaceId}`,
					`pane: ${paneName(a.repo, a.number)}`,
					`terminal: ${terminal}`,
				]);
		}
		if (dir?.startsWith(`${CLONES}/`)) fs.rmSync(dir, { recursive: true, force: true });
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

	// Each record: close its pane and delete its clone if its pull request left the open list
	// (merged, or closed; a pull request past the newest 100 open would count as closed too), or if
	// its agent is done. Records of pull requests that are no longer open drop out.
	async function sweep(poll: Poll, agents: Agent[]): Promise<Agent[]> {
		const open = new Set(poll.open.map(p => p.url));
		const merged = new Set(poll.merged.map(p => p.url));
		const next: Agent[] = [];
		for (const a of agents) {
			try {
				if (!open.has(a.url)) {
					await close(a, merged.has(a.url) ? "merged" : "closed");
					continue;
				}
				next.push(a.terminal && (await done(a)) ? await close(a, "done") : a);
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
		const fresh = moved.filter(p => !agents.some(a => a.url === p.url && a.head === p.headRefOid));
		if (fresh.length > 0) await startAll(fresh, agents);
		if (JSON.stringify(agents) !== JSON.stringify(saved)) write(STATE, agents);
		// Last, so that a restart during a start finds the move again.
		write(DRAFTS, { at: Date.now(), urls: [...now] });
	}

	// Polls arrive each minute; a start (the clones, then up to 45 s for omp) can take longer, so
	// they run one at a time.
	pi.events.on(POLL_EVENT, data => {
		queue = queue.then(() => onPoll(data as Poll)).catch(() => {});
	});
}
