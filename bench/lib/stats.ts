import type { Measure, Summary } from "./types.ts";

export function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return Number.NaN;
	// Nearest rank: p95 of 5 samples is the largest one, so a single slow run shows.
	const rank = Math.ceil(q * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function median(values: number[]): number {
	const s = [...values].sort((a, b) => a - b);
	if (s.length === 0) return Number.NaN;
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);

export function summarize(m: Measure): Summary {
	const s = m.samples.filter(Number.isFinite).sort((a, b) => a - b);
	const med = median(s);
	return {
		...m,
		samples: m.samples.map(round),
		n: s.length,
		median: round(med),
		p95: round(quantile(s, 0.95)),
		min: round(s[0] ?? Number.NaN),
		max: round(s[s.length - 1] ?? Number.NaN),
		mad: round(median(s.map(x => Math.abs(x - med)))),
	};
}

// Better or worse by more than the noise: the gap between the medians must be larger than twice
// the bigger MAD of the two runs, and larger than 5 % of the old median (so a tiny, steady
// measure does not flip on a 0.1 ms change).
export function verdict(a: Summary, b: Summary): "better" | "worse" | "same" {
	if (a.better === "none" || !Number.isFinite(a.median) || !Number.isFinite(b.median)) return "same";
	const noise = Math.max(2 * Math.max(a.mad, b.mad), 0.05 * Math.abs(a.median));
	const gain = a.better === "higher" ? b.median - a.median : a.median - b.median;
	if (gain > noise) return "better";
	if (-gain > noise) return "worse";
	return "same";
}
