// Tells the orchestrator when one of your open pull requests becomes ready to merge: not a draft,
// approved, no conflicts, and required checks passed (mergeStateStatus CLEAN or HAS_HOOKS). It sends
// a <herdr-pr-ready> message, as herdr-watch.ts sends <herdr-report>, and the orchestrator writes a
// report box. When one of your pull requests is merged, it sends <herdr-pr-merged>. One GraphQL
// query through gh each minute (EVERY_MS) gets both; it only reads.
// Ready: once per pull request and head commit, so a push after the notice can notify again. The
// first poll on a machine only records what is already ready, so it does not post a box for each.
// Merged: once per pull request, and only for merges after the first poll of this session.
// Each poll also goes out on the event bus as POLL_EVENT, for herdr-pr-autofix.ts.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// The query costs 1 point of GitHub's 5,000 an hour, so a poll each minute uses about 60. The next
// poll starts EVERY_MS after the last one ends, so two polls never overlap; GH_MS ends a hung gh.
const EVERY_MS = 60_000;
const FIRST_MS = 10_000;
const GH_MS = 30_000;
// Only the session in this space polls, so that other sessions started in this folder stay quiet.
const SPACE = "orchestrator";
const STATE = path.join(os.homedir(), ".local/state/herdr-pr-ready/notified.json");
export const POLL_EVENT = "herdr-pr-ready:poll";
// MERGED lists merged pull requests only, so one closed without a merge never shows. A merge bumps
// updatedAt, so a new merge is at the top of the 20.
const QUERY = `{ viewer { login pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url isDraft headRefName headRefOid author { login } reviewDecision mergeable mergeStateStatus repository { nameWithOwner } } }
  merged: pullRequests(states: MERGED, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url mergedAt repository { nameWithOwner } } } } }`;
const CLEAN: Record<string, true> = { CLEAN: true, HAS_HOOKS: true };
// The sounds of the notices. Herdr plays its own built-in "An agent finished" sound when a worker
// ends a turn; these must sound different from it and from each other. They obey Herdr's sound
// switch (settings.json sounds.enabled).
const SOUND = "/System/Library/Sounds/Glass.aiff";
const MERGED_SOUND = "/System/Library/Sounds/Hero.aiff";
const HERDR_HOME = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app");
const HERDR_SETTINGS = path.join(HERDR_HOME, "settings.json");
// The banner of a worker-done notice: Herdr's toast mod sends each notify() to this script, which
// draws it above the Herdr window. A click brings Herdr forward, where the box has the PR link.
const HERDR_ALERT = path.join(HERDR_HOME, "scripts/herdr-alert.sh");

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
}
interface MergedPr extends Pr {
	mergedAt: string;
}

export default function herdrPrReady(pi: ExtensionAPI) {
	let timer: Timer | undefined;
	let stop: AbortController | undefined;
	// Merges at or before this time (the start of the first poll) do not notify.
	let since: number | undefined;
	const merged = new Set<string>();

	async function notice(type: "herdr-pr-ready" | "herdr-pr-merged", prs: Pr[], sound: string) {
		const title = type === "herdr-pr-ready" ? "Pull request ready to merge" : "Pull request merged";
		const body = prs
			.map(p => [`repo: ${p.repository.nameWithOwner}`, `number: ${p.number}`, `title: ${p.title}`, `url: ${p.url}`].join("\n"))
			.join("\n\n");
		pi.sendMessage(
			{ customType: type, content: `<${type}>\n${body}\n</${type}>`, display: false, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
		if (fs.existsSync(HERDR_ALERT))
			for (const p of prs)
				await pi.exec(HERDR_ALERT, [title, `${p.repository.nameWithOwner}#${p.number}: ${p.title}`, "success", "", "", ""]);
		let soundsOn = true;
		try {
			soundsOn = JSON.parse(fs.readFileSync(HERDR_SETTINGS, "utf8")).sounds?.enabled !== false;
		} catch {}
		if (soundsOn && process.platform === "darwin" && fs.existsSync(sound)) await pi.exec("afplay", [sound]);
	}

	async function poll(signal: AbortSignal) {
		const started = Date.now();
		const r = await pi.exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { signal: AbortSignal.any([signal, AbortSignal.timeout(GH_MS)]) });
		if (r.code !== 0 || signal.aborted) return;
		const viewer = JSON.parse(r.stdout).data.viewer;
		const open = (viewer.pullRequests.nodes as OpenPr[]).filter(Boolean);
		pi.events.emit(POLL_EVENT, { login: viewer.login, open } satisfies Poll);
		const ready = open.filter(
			p => !p.isDraft && p.reviewDecision === "APPROVED" && p.mergeable === "MERGEABLE" && CLEAN[p.mergeStateStatus],
		);
		const after = (since ??= started);
		const newMerges = (viewer.merged.nodes as MergedPr[])
			.filter(Boolean)
			.filter(p => Date.parse(p.mergedAt) > after && !merged.has(p.url));
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
		if (!first && fresh.length > 0) await notice("herdr-pr-ready", fresh, SOUND);
		if (newMerges.length > 0) await notice("herdr-pr-merged", newMerges, MERGED_SOUND);
	}

	function schedule(ms: number, signal: AbortSignal) {
		timer = setTimeout(async () => {
			await poll(signal).catch(() => {});
			if (!signal.aborted) schedule(EVERY_MS, signal);
		}, ms);
	}

	pi.on("session_start", async (_event, ctx) => {
		const self = process.env.HC_TERMINAL_ID;
		if (stop || !self || ctx.agent.kind !== "main" || !ctx.hasUI) return;
		const ctl = (stop = new AbortController());
		const r = await pi.exec("hc", ["get", self, "--json"]);
		const where: string | undefined = r.code === 0 ? JSON.parse(r.stdout).labels?.where : undefined;
		if (where?.split(" / ")[0] === SPACE && !ctl.signal.aborted) schedule(FIRST_MS, ctl.signal);
	});
	pi.on("session_shutdown", () => {
		stop?.abort();
		stop = undefined;
		clearTimeout(timer);
		timer = undefined;
	});
}
