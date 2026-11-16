// Loads the orchestrator's extensions and tools from the repo checkout, outside omp, with a fake
// `pi`: exec runs real commands (in the sandbox env), and messages, tools, commands and events are
// recorded with the time they happened. "@oh-my-pi/pi-coding-agent" is a stub module: the files
// use only its types and `theme`.
import "./guard.ts";
import * as path from "node:path";
import { plugin } from "bun";
import { now, run } from "./proc.ts";

const id = (s: string) => s;
plugin({
	name: "omp-stub",
	setup(build) {
		build.module("@oh-my-pi/pi-coding-agent", () => ({
			loader: "object",
			exports: { theme: { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: id, italic: id, dim: id } },
		}));
	},
});

export const orchFile = (repo: string, rel: string) => path.join(repo, "orchestrator/.omp", rel);

// Any zod call chain (pi.zod.object({...}).optional()) returns the same callable stub.
const zod: any = new Proxy(function () {}, { get: () => zod, apply: () => zod });

export interface Sent {
	at: number;
	message: { customType?: string; content?: string };
	options: unknown;
}

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
}

export function fakePi(opts: { exec?: (cmd: string, args: string[], o?: ExecOptions) => Promise<any> } = {}) {
	const handlers = new Map<string, ((...a: any[]) => any)[]>();
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		zod,
		tools: new Map<string, any>(),
		commands: new Map<string, any>(),
		sent: [] as Sent[],
		execs: [] as { at: number; ms: number; cmd: string; args: string[] }[],
		async exec(cmd: string, args: string[], o: ExecOptions = {}) {
			if (opts.exec) return opts.exec(cmd, args, o);
			const r = await run(cmd, args, { signal: o.signal, cwd: o.cwd, timeoutMs: o.timeout });
			pi.execs.push({ at: now() - r.ms, ms: r.ms, cmd, args });
			return r;
		},
		on(event: string, fn: (...a: any[]) => any) {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		async fire(event: string, ...args: any[]) {
			for (const fn of handlers.get(event) ?? []) await fn(...args);
		},
		events: {
			on(event: string, fn: (data: unknown) => void) {
				bus.set(event, [...(bus.get(event) ?? []), fn]);
			},
			emit(event: string, data: unknown) {
				for (const fn of bus.get(event) ?? []) fn(data);
			},
		},
		registerTool(tool: any) {
			pi.tools.set(tool.name, tool);
		},
		registerCommand(name: string, cmd: any) {
			pi.commands.set(name, cmd);
		},
		sendMessage(message: Sent["message"], options: unknown) {
			pi.sent.push({ at: now(), message, options });
		},
		sendUserMessage(text: string, options?: unknown) {
			pi.sent.push({ at: now(), message: { content: text }, options });
		},
	};
	return pi;
}

export type FakePi = ReturnType<typeof fakePi>;

// The ctx an extension's session_start and tools get: the main agent, with a UI that records widgets.
export function fakeCtx() {
	const widgets = new Map<string, unknown>();
	return {
		agent: { kind: "main" },
		hasUI: true,
		ui: { setWidget: (k: string, v: unknown) => widgets.set(k, v), notify() {}, setStatus() {} },
		widgets,
	};
}
