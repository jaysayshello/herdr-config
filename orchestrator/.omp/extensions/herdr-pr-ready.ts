// Tells the orchestrator when one of your open pull requests becomes ready to merge: not a draft,
// approved, no conflicts, and required checks passed (mergeStateStatus CLEAN or HAS_HOOKS). It sends
// a <herdr-pr-ready> message, as herdr-watch.ts sends <herdr-report>, and the orchestrator writes a
// report box. One GraphQL query through gh every 3 minutes; it only reads.
// Once per pull request and head commit: a push after the notice can notify again. The first poll
// on a machine only records what is already ready, so it does not post a box for each of them.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const EVERY_MS = 3 * 60_000;
const FIRST_MS = 10_000;
// Only the session in this space polls, so that other sessions started in this folder stay quiet.
const SPACE = "orchestrator";
const STATE = path.join(os.homedir(), ".local/state/herdr-pr-ready/notified.json");
const QUERY = `{ viewer { pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title url isDraft headRefOid reviewDecision mergeable mergeStateStatus repository { nameWithOwner } } } } }`;
const CLEAN: Record<string, true> = { CLEAN: true, HAS_HOOKS: true };

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

	async function poll() {
		const r = await pi.exec("gh", ["api", "graphql", "-f", `query=${QUERY}`]);
		if (r.code !== 0) return;
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
	}

	function schedule(ms: number) {
		timer = setTimeout(async () => {
			await poll().catch(() => {});
			schedule(EVERY_MS);
		}, ms);
	}

	pi.on("session_start", async (_event, ctx) => {
		const self = process.env.HC_TERMINAL_ID;
		if (timer || !self || ctx.agent.kind !== "main" || !ctx.hasUI) return;
		const r = await pi.exec("hc", ["get", self, "--json"]);
		const where: string | undefined = r.code === 0 ? JSON.parse(r.stdout).labels?.where : undefined;
		if (where?.split(" / ")[0] === SPACE) schedule(FIRST_MS);
	});
	pi.on("session_shutdown", () => {
		clearTimeout(timer);
		timer = undefined;
	});
}
