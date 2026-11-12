// Tells the orchestrator when one of your open pull requests becomes ready to merge: not a draft,
// approved, no conflicts, and required checks passed (mergeStateStatus CLEAN or HAS_HOOKS). It sends
// a <herdr-pr-ready> message, as herdr-watch.ts sends <herdr-report>, and the orchestrator writes a
// report box. One GraphQL query through gh each minute (EVERY_MS); it only reads.
// Once per pull request and head commit: a push after the notice can notify again. The first poll
// on a machine only records what is already ready, so it does not post a box for each of them.
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
const QUERY = `{ viewer { pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url isDraft headRefOid reviewDecision mergeable mergeStateStatus repository { nameWithOwner } } } } }`;
const CLEAN: Record<string, true> = { CLEAN: true, HAS_HOOKS: true };
// The sound of a ready notice. Herdr plays its own built-in "An agent finished" sound when a worker
// ends a turn; this one must sound different. It obeys Herdr's sound switch (settings.json sounds.enabled).
const SOUND = "/System/Library/Sounds/Glass.aiff";
const HERDR_SETTINGS = path.join(process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config/herdr-app"), "settings.json");

interface Pr {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	headRefOid: string;
	reviewDecision: string | null;
	mergeable: string;
	mergeStateStatus: string;
	repository: { nameWithOwner: string };
}

export default function herdrPrReady(pi: ExtensionAPI) {
	let timer: Timer | undefined;
	let stop: AbortController | undefined;

	async function poll(signal: AbortSignal) {
		const r = await pi.exec("gh", ["api", "graphql", "-f", `query=${QUERY}`], { signal: AbortSignal.any([signal, AbortSignal.timeout(GH_MS)]) });
		if (r.code !== 0 || signal.aborted) return;
		const open = (JSON.parse(r.stdout).data.viewer.pullRequests.nodes as Pr[]).filter(Boolean);
		const ready = open.filter(
			p => !p.isDraft && p.reviewDecision === "APPROVED" && p.mergeable === "MERGEABLE" && CLEAN[p.mergeStateStatus],
		);
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
		if (first || fresh.length === 0) return;
		const body = fresh
			.map(p => [`repo: ${p.repository.nameWithOwner}`, `number: ${p.number}`, `title: ${p.title}`, `url: ${p.url}`].join("\n"))
			.join("\n\n");
		pi.sendMessage(
			{
				customType: "herdr-pr-ready",
				content: `<herdr-pr-ready>\n${body}\n</herdr-pr-ready>`,
				display: false,
				attribution: "agent",
			},
			{ deliverAs: "aside", triggerTurn: true },
		);
		let soundsOn = true;
		try {
			soundsOn = JSON.parse(fs.readFileSync(HERDR_SETTINGS, "utf8")).sounds?.enabled !== false;
		} catch {}
		if (soundsOn && process.platform === "darwin" && fs.existsSync(SOUND)) void pi.exec("afplay", [SOUND]);
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
