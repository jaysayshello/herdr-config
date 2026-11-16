// Tells the Rex orchestrator when one of your open pull requests becomes ready to merge: not a
// draft, approved, no conflicts, and required checks passed (mergeStateStatus CLEAN or HAS_HOOKS).
// It sends a <rex-pr-ready> message, as rex-watch.ts sends <rex-report>, and the orchestrator
// writes a report box. When one of your pull requests is merged, it sends <rex-pr-merged>. One
// GraphQL query through gh each minute (EVERY_MS) gets both; it only reads. The same job as
// herdr-pr-ready.ts, with its own state file, so the two never share notices.
// Ready: once per pull request and head commit, so a push after the notice can notify again. The
// first poll on a machine only records what is already ready, so it does not post a box for each.
// Merged: once per pull request, and only for merges after the first poll of this session.
// Each poll also goes out on the event bus as POLL_EVENT, for rex-pr-autofix.ts.
// Only the omp in a Rex terminal of the session named SPACE polls.
// Overlap with Herdr: while the Herdr app runs (`pgrep -x Herdr` succeeds at poll time), Herdr's
// orchestrator posts these notices, so this one posts none: no message, banner or sound. It still
// emits POLL_EVENT and keeps STATE and the merged list current, so when Herdr quits, only changes
// after that point notify, and nothing floods.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { rexClient, SELF } from "../tools/rex.ts";

// The query costs 1 point of GitHub's 5,000 an hour, so a poll each minute uses about 60. The next
// poll starts EVERY_MS after the last one ends, so two polls never overlap; GH_MS ends a hung gh.
const EVERY_MS = 60_000;
const FIRST_MS = 10_000;
const GH_MS = 30_000;
// Only the session with this name polls, so that other omp sessions started in this folder stay quiet.
const SPACE = "orchestrator";
const STATE = path.join(os.homedir(), ".local/state/rex-pr-ready/notified.json");
export const POLL_EVENT = "rex-pr-ready:poll";
// MERGED lists merged pull requests only, so one closed without a merge never shows. A merge bumps
// updatedAt, so a new merge is at the top of the 20.
const QUERY = `{ viewer { login pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url isDraft headRefName headRefOid author { login } reviewDecision mergeable mergeStateStatus repository { nameWithOwner } } }
  merged: pullRequests(states: MERGED, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url mergedAt repository { nameWithOwner } } } } }`;
const CLEAN: Record<string, true> = { CLEAN: true, HAS_HOOKS: true };
// The sound switch: false plays no sound with the notices.
const SOUNDS = true;
// The sounds of the notices. They must sound different from each other and from the sound of a
// worker that ends a turn.
const SOUND = "/System/Library/Sounds/Glass.aiff";
const MERGED_SOUND = "/System/Library/Sounds/Hero.aiff";
// The banner: a macOS notification. The title and text go in as arguments, so no quoting can break it.
const BANNER = ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"];

interface Pr {
	number: number;
	title: string;
	url: string;
	repository: { nameWithOwner: string };
}
export interface OpenPr extends Pr {
	isDraft: boolean;
	headRefName: string;
	headRefOid: string;
	author: { login: string } | null;
	reviewDecision: string | null;
	mergeable: string;
	mergeStateStatus: string;
}
export interface Poll {
	login: string;
	open: OpenPr[];
	// The 20 merged pull requests updated last.
	merged: MergedPr[];
}
export interface MergedPr extends Pr {
	mergedAt: string;
}

export default function rexPrReady(pi: ExtensionAPI) {
	let timer: Timer | undefined;
	let stop: AbortController | undefined;
	// Merges at or before this time (the start of the first poll) do not notify.
	let since: number | undefined;
	const merged = new Set<string>();

	async function notice(type: "rex-pr-ready" | "rex-pr-merged", prs: Pr[], sound: string) {
		const title = type === "rex-pr-ready" ? "Pull request ready to merge" : "Pull request merged";
		const body = prs
			.map(p => [`repo: ${p.repository.nameWithOwner}`, `number: ${p.number}`, `title: ${p.title}`, `url: ${p.url}`].join("\n"))
			.join("\n\n");
		pi.sendMessage(
			{ customType: type, content: `<${type}>\n${body}\n</${type}>`, display: false, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
		if (process.platform !== "darwin") return;
		for (const p of prs) await pi.exec("osascript", [...BANNER, title, `${p.repository.nameWithOwner}#${p.number}: ${p.title}`]);
		if (SOUNDS && fs.existsSync(sound)) await pi.exec("afplay", [sound]);
	}

	async function poll(signal: AbortSignal) {
		const started = Date.now();
		const r = await pi.exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { signal: AbortSignal.any([signal, AbortSignal.timeout(GH_MS)]) });
		if (r.code !== 0 || signal.aborted) return;
		const viewer = JSON.parse(r.stdout).data.viewer;
		const open = (viewer.pullRequests.nodes as OpenPr[]).filter(Boolean);
		const lastMerged = (viewer.merged.nodes as MergedPr[]).filter(Boolean);
		pi.events.emit(POLL_EVENT, { login: viewer.login, open, merged: lastMerged } satisfies Poll);
		const ready = open.filter(
			p => !p.isDraft && p.reviewDecision === "APPROVED" && p.mergeable === "MERGEABLE" && CLEAN[p.mergeStateStatus],
		);
		const after = (since ??= started);
		const newMerges = lastMerged.filter(p => Date.parse(p.mergedAt) > after && !merged.has(p.url));
		for (const p of newMerges) merged.add(p.url);
		// url -> the head commit it was ready at. Closed pull requests drop out.
		const first = !fs.existsSync(STATE);
		const seen: Record<string, string> = first ? {} : JSON.parse(fs.readFileSync(STATE, "utf8"));
		const fresh = ready.filter(p => seen[p.url] !== p.headRefOid);
		const next: Record<string, string> = {};
		for (const p of open) if (seen[p.url]) next[p.url] = seen[p.url];
		for (const p of ready) next[p.url] = p.headRefOid;
		fs.mkdirSync(path.dirname(STATE), { recursive: true });
		fs.writeFileSync(`${STATE}.tmp`, JSON.stringify(next));
		fs.renameSync(`${STATE}.tmp`, STATE);
		// Herdr's orchestrator posts the notices while Herdr runs.
		if ((await pi.exec("pgrep", ["-x", "Herdr"])).code === 0) return;
		if (!first && fresh.length > 0) await notice("rex-pr-ready", fresh, SOUND);
		if (newMerges.length > 0) await notice("rex-pr-merged", newMerges, MERGED_SOUND);
	}

	function schedule(ms: number, signal: AbortSignal) {
		timer = setTimeout(async () => {
			await poll(signal).catch(() => {});
			if (!signal.aborted) schedule(EVERY_MS, signal);
		}, ms);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (stop || !SELF || ctx.agent.kind !== "main" || !ctx.hasUI) return;
		const ctl = (stop = new AbortController());
		const { selfSpace } = await rexClient(pi.exec)
			.view(ctl.signal)
			.catch(() => ({ selfSpace: undefined }));
		if (selfSpace?.name === SPACE && !ctl.signal.aborted) schedule(FIRST_MS, ctl.signal);
	});
	pi.on("session_shutdown", () => {
		stop?.abort();
		stop = undefined;
		clearTimeout(timer);
		timer = undefined;
	});
}
