// The shapes every case and the result file share.
import type { Sandbox } from "./sandbox.ts";

// local: work on this computer (the part we can make faster). network: time spent waiting on
// GitHub (we can only send less or ask less often). total: both together, as the user feels it.
export type Kind = "local" | "network" | "total";
export type Unit = "ms" | "%" | "MB" | "points" | "points/h" | "calls/h" | "count";

export interface Measure {
	// Stable id, used to match the same measure across two result files: "<case>.<name>".
	id: string;
	label: string;
	unit: Unit;
	kind: Kind;
	// Most measures are better when lower; set "none" for facts that are context only.
	better?: "lower" | "higher" | "none";
	samples: number[];
	note?: string;
}

export interface Summary extends Measure {
	n: number;
	median: number;
	p95: number;
	min: number;
	max: number;
	// Median absolute deviation: the noise of this measure in this run.
	mad: number;
}

export interface Ctx {
	sandbox: Sandbox;
	// How many times to repeat each measure (cases may use fewer for slow ones, and say so in a note).
	runs: number;
	// The repo checkout under test (mods and orchestrator files are read from here, not the live copies).
	repo: string;
	log(msg: string): void;
	// Record GitHub GraphQL points the suite itself spent (lib/github.ts calls this).
	spend(points: number): void;
}

export interface Case {
	id: string;
	title: string;
	run(ctx: Ctx): Promise<Measure[]>;
}

export interface ResultFile {
	version: 1;
	label: string;
	started: string;
	finished: string;
	git: { sha: string; branch: string; dirty: boolean };
	host: { os: string; cpus: number; bun: string; load: number[] };
	runs: number;
	github: { pointsSpent: number };
	measures: Summary[];
	skipped: { id: string; reason: string }[];
}
