// Real GitHub reads, timed, with their GraphQL cost. Every query gets `rateLimit { cost remaining }`
// added at its top level, so each call reports its own cost, and the suite adds it to its spend.
// Network time comes from curl's own timers (DNS, connect, TLS, first byte); gh's local start-up
// is measured apart. The token comes from the real gh login once and stays in this process.
import type { Ctx } from "./types.ts";
import { REAL_HOME } from "./guard.ts";
import { now, run } from "./proc.ts";

let token: string | undefined;
async function ghToken(ctx: Ctx): Promise<string> {
	if (token) return token;
	const r = await run(ctx.sandbox.realGh, ["auth", "token"], { env: { HOME: REAL_HOME } });
	if (r.code !== 0 || !r.stdout.trim()) throw new Error("gh auth token failed: is gh logged in?");
	token = r.stdout.trim();
	return token;
}

// `{ viewer { … } }` or `query($q: String!) { … }` -> the same with rateLimit beside the top fields.
export function withRateLimit(query: string): string {
	const end = query.lastIndexOf("}");
	return `${query.slice(0, end)} rateLimit { cost remaining } }`;
}

export interface Timed {
	totalMs: number;
	// curl timers, in ms from the start: DNS done, TCP connected, TLS done, first byte, last byte.
	dnsMs: number;
	connectMs: number;
	tlsMs: number;
	firstByteMs: number;
	cost: number;
	remaining: number;
	data: any;
}

// One GraphQL POST with curl. The spend is recorded at once, so it counts even when a case fails later.
export async function graphql(ctx: Ctx, query: string, variables: Record<string, unknown> = {}): Promise<Timed> {
	const body = JSON.stringify({ query: withRateLimit(query), variables });
	const fmt = "\n%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}";
	const r = await run("/usr/bin/curl", ["-sS", "-X", "POST", "https://api.github.com/graphql", "-H", `Authorization: bearer ${await ghToken(ctx)}`, "-H", "Content-Type: application/json", "--data-binary", "@-", "-w", fmt], { input: body });
	if (r.code !== 0) throw new Error(`curl: ${r.stderr}`);
	const cut = r.stdout.lastIndexOf("\n");
	const [dns, connect, tls, first, total] = r.stdout.slice(cut + 1).trim().split(" ").map(s => Number(s) * 1000);
	const parsed = JSON.parse(r.stdout.slice(0, cut));
	if (parsed.errors) throw new Error(`GraphQL: ${JSON.stringify(parsed.errors).slice(0, 300)}`);
	const cost = parsed.data.rateLimit.cost;
	ctx.spend(cost);
	return { totalMs: total, dnsMs: dns, connectMs: connect, tlsMs: tls, firstByteMs: first, cost, remaining: parsed.data.rateLimit.remaining, data: parsed.data };
}

// The same query the way the mods and extensions send it: through the real gh. Wall time includes
// gh's own start, its config read and its HTTP client.
export async function viaGh(ctx: Ctx, query: string): Promise<{ ms: number; cost: number; data: any }> {
	const t0 = now();
	const r = await run(ctx.sandbox.realGh, ["api", "graphql", "-f", `query=${withRateLimit(query)}`], { env: { GH_TOKEN: await ghToken(ctx) } });
	const ms = now() - t0;
	if (r.code !== 0) throw new Error(`gh api graphql: ${r.stderr}`);
	const data = JSON.parse(r.stdout).data;
	ctx.spend(data.rateLimit.cost);
	return { ms, cost: data.rateLimit.cost, data };
}

// gh's local start-up: `gh --version` does no network.
export async function ghStartMs(ctx: Ctx): Promise<number> {
	return (await run(ctx.sandbox.realGh, ["--version"])).ms;
}
