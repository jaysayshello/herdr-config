// A fake gh for the test window and for action tests: it never reaches GitHub, so no real pull
// request can change. It answers `api graphql` with a fixture, `pr ready|merge|close` with success,
// and `repo view --json` with the merge methods, after BENCH_GH_DELAY_MS (default 0). Each call is
// logged as "<start ms> <end ms> <args…>" to <root>/fake-gh/gh.log.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Sandbox } from "./sandbox.ts";

const STATES = ["SUCCESS", "FAILURE", "PENDING", null] as const;

// n open pull requests (some drafts, some ready to merge) and `merged` merged ones, with every
// field that t3-prs and herdr-pr-ready ask for.
export function prFixture(n: number, merged = 20, login = "bench-user") {
	const open = Array.from({ length: n }, (_, i) => {
		const ready = i % 3 === 0;
		return {
			id: `PR_${1000 + i}`,
			number: 1000 + i,
			title: `Bench pull request ${i} with a title of a usual length`,
			isDraft: i % 4 === 1,
			url: `https://github.com/${login}/repo-${i % 5}/pull/${1000 + i}`,
			headRefName: `feat/bench-${i}`,
			headRefOid: `${(i * 2654435761).toString(16).padStart(8, "0")}${"0".repeat(32)}`,
			baseRefName: "main",
			reviewDecision: ready ? "APPROVED" : i % 3 === 1 ? "REVIEW_REQUIRED" : null,
			mergeable: "MERGEABLE",
			mergeStateStatus: ready ? "CLEAN" : "BLOCKED",
			updatedAt: new Date(Date.UTC(2026, 10, 15, 12, 0, 0) - i * 60_000).toISOString(),
			author: { login },
			repository: { name: `repo-${i % 5}`, nameWithOwner: `${login}/repo-${i % 5}` },
			latestReviews: { nodes: ready ? [{ state: "APPROVED", author: { login: "reviewer" } }] : [] },
			commits: { nodes: [{ commit: { statusCheckRollup: STATES[i % 4] ? { state: STATES[i % 4] } : null } }] },
		};
	});
	const done = Array.from({ length: merged }, (_, i) => ({
		number: 900 + i,
		title: `Merged bench pull request ${i}`,
		url: `https://github.com/${login}/repo-${i % 5}/pull/${900 + i}`,
		mergedAt: new Date(Date.UTC(2026, 10, 15, 11, 0, 0) - i * 3_600_000).toISOString(),
		repository: { name: `repo-${i % 5}`, nameWithOwner: `${login}/repo-${i % 5}` },
	}));
	return { data: { viewer: { login, pullRequests: { nodes: open }, merged: { nodes: done } } } };
}

// The extra GraphQL calls t3-prs makes after a poll, by the word in their query that tells them
// apart: comments.js (one call per pull request whose updatedAt changed), owners.js (files and
// CODEOWNERS of an approved pull request, then the members of each owning team), and a follow-up
// `nodes(ids: …)` query a poll may make for some fields of some pull requests (merge state).
export type QueryKind = "comments" | "owners" | "team" | "merge";
export const QUERY_WORD: Record<QueryKind, string> = { comments: "reviewThreads", owners: "object(expression", team: "organization(login", merge: "nodes(ids:" };

// The answer to a `nodes(ids: …)` follow-up for prFixture's open pull requests (the first n):
// each by its id, with the merge state prFixture gives it.
export function mergeFixture(n = 100) {
	const nodes = prFixture(n, 0).data.viewer.pullRequests.nodes.map(p => ({ id: p.id, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus }));
	return { data: { nodes } };
}

// The answer to comments.js's query: people's comments, review texts and inline threads, and a bot.
export function commentsFixture(people = 6, threads = 5) {
	const at = (i: number) => new Date(Date.UTC(2026, 10, 14, 9, 0, 0) + i * 600_000).toISOString();
	const who = (i: number) => ({ __typename: "User", login: i % 3 === 0 ? "bench-user" : `reviewer-${i % 4}` });
	return {
		data: {
			repository: {
				pullRequest: {
					comments: { nodes: [...Array.from({ length: people }, (_, i) => ({ author: who(i), createdAt: at(i) })), { author: { __typename: "Bot", login: "ci" }, createdAt: at(99) }] },
					reviews: { nodes: Array.from({ length: 3 }, (_, i) => ({ author: who(i + 1), submittedAt: at(20 + i), bodyText: i === 1 ? "" : "Looks good overall." })) },
					reviewThreads: { nodes: Array.from({ length: threads }, (_, t) => ({ comments: { nodes: Array.from({ length: 3 }, (_, i) => ({ author: who(t + i), createdAt: at(40 + t * 3 + i) })) } })) },
				},
			},
		},
	};
}

// The answer to owners.js's pull request query: a CODEOWNERS file in .github/ that gives every
// file to a team and docs/ to one person, and `files` changed files (one page).
export function ownersFixture(files = 30, org = "bench-org") {
	const text = `# Bench CODEOWNERS\n* @${org}/platform\n/docs/ @reviewer\n*.md @${org}/writers\n`;
	const paths = Array.from({ length: files }, (_, i) => (i % 5 === 0 ? `docs/page-${i}.md` : `src/module-${i % 7}/file-${i}.ts`));
	return {
		data: {
			repository: {
				a: { text },
				b: null,
				c: null,
				pullRequest: { files: { nodes: paths.map(p => ({ path: p })), pageInfo: { hasNextPage: false, endCursor: null } } },
			},
		},
	};
}

// The answer to owners.js's team query: the members of the owning team (it includes "reviewer",
// the approver in prFixture).
export function teamFixture(members = 12) {
	const nodes = [{ login: "reviewer" }, ...Array.from({ length: members - 1 }, (_, i) => ({ login: `member-${i}` }))];
	return { data: { organization: { team: { members: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } };
}

export interface FakeGh {
	dir: string;
	log: string;
	// Replaces the answer to `gh api graphql` (every GraphQL query without its own answer).
	setGraphql(fixture: unknown): void;
	// Gives one kind of query its own answer (until then it gets the setGraphql answer).
	setQuery(kind: QueryKind, fixture: unknown): void;
	calls(): { start: number; end: number; args: string }[];
	clear(): void;
}

// Writes the fake as <sandbox bin>/gh, first on the PATH of the test window and of every child.
export function installFakeGh(sb: Sandbox): FakeGh {
	const dir = path.join(sb.root, "fake-gh");
	fs.mkdirSync(dir, { recursive: true });
	const log = path.join(dir, "gh.log");
	const graphql = path.join(dir, "graphql.json");
	fs.writeFileSync(graphql, JSON.stringify(prFixture(10)));
	fs.writeFileSync(
		path.join(sb.bin, "gh"),
		`#!/bin/sh
ms() { /usr/bin/perl -MTime::HiRes=time -e 'printf "%.1f", time*1000'; }
T0=$(ms)
D=\${BENCH_GH_DELAY_MS:-0}
[ "$D" -gt 0 ] && /usr/bin/perl -e "select(undef,undef,undef,$D/1000)"
case "$1 $2" in
  "api graphql")
    F="${graphql}"
    case "$*" in
      *"${QUERY_WORD.comments}"*) [ -f "${dir}/comments.json" ] && F="${dir}/comments.json" ;;
      *"${QUERY_WORD.owners}"*) [ -f "${dir}/owners.json" ] && F="${dir}/owners.json" ;;
      *"${QUERY_WORD.team}"*) [ -f "${dir}/team.json" ] && F="${dir}/team.json" ;;
      *"${QUERY_WORD.merge}"*) [ -f "${dir}/merge.json" ] && F="${dir}/merge.json" ;;
    esac
    cat "$F" ;;
  "repo view") echo '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}' ;;
  "pr ready"|"pr merge"|"pr close") echo "ok" ;;
  "auth token") echo "fake-token" ;;
  *) echo "fake gh: no answer for: $*" >&2; echo "$T0 $(ms) $*" >> "${log}"; exit 1 ;;
esac
echo "$T0 $(ms) $*" | tr '\\n' ' ' >> "${log}"; echo >> "${log}"
`,
		{ mode: 0o755 },
	);
	return {
		dir,
		log,
		setGraphql: f => fs.writeFileSync(graphql, JSON.stringify(f)),
		setQuery: (kind, f) => fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(f)),
		calls() {
			if (!fs.existsSync(log)) return [];
			return fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(l => {
					const [start, end, ...rest] = l.split(" ");
					return { start: Number(start), end: Number(end), args: rest.join(" ").trim() };
				});
		},
		clear: () => fs.rmSync(log, { force: true }),
	};
}
