// Runs a mod's main.js outside Herdr, in this Bun process, so a case can time its own JavaScript:
// a poll's parse and state update, and render(). It is the general form of
// herdr-app/mods/t3-prs/check-prs.cjs: "herdr", "gpui-kit" and "gpui-base" are stub modules.
//   - Every "herdr" call goes to `host`: exec (set host.exec per test; each call is recorded with
//     its start and end), props, run, nextCommand, notify, openOverlay, closeOverlay, …
//   - div(), h_flex(), svg(…) build plain nodes: { type, key, items, handlers }, so a test can find
//     a row by its id and call its click handler. Style callbacks (`.hover((s) => …)`) run, as in
//     gpui, so their cost counts.
//   - `localStorage` is a Map in host.storage.
// Caveat: Herdr runs mods in QuickJS (an interpreter); Bun runs them with a JIT. The same render is
// many times faster here, so these numbers rank changes but are not the time Herdr spends.
import "./guard.ts";
import * as path from "node:path";
import { plugin } from "bun";
import { now } from "./proc.ts";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecCall {
	cmd: string;
	args: string[];
	start: number;
	end: number;
	code: number;
}

// What a mod asks of Herdr. Tests set exec, props, spaces and read the rest.
export const host = {
	// The mod's name: run("<mod>.<command>") goes to its nextCommand(), as Herdr does it.
	mod: "",
	props: {} as Record<string, unknown>,
	exec: async (_cmd: string, _args: string[]): Promise<ExecResult> => ({ code: 1, stdout: "", stderr: "modvm: no exec set" }),
	calls: [] as ExecCall[],
	runs: [] as { name: string; args?: unknown }[],
	toasts: [] as any[],
	overlays: [] as any[],
	closed: [] as unknown[],
	storage: new Map<string, string>(),
	spaces: [] as any[],
	panes: [] as any[],
	focused: null as unknown,
	layout: null as unknown,
	// Commands waiting for the mod's nextCommand(), and the mod's waiting nextCommand() calls.
	commands: [] as string[],
	waiters: [] as ((c: string) => void)[],
	// Called each time the mod waits for a command again (its command loop is idle).
	idle: [] as (() => void)[],
};

export function resetHost(mod = "") {
	Object.assign(host, { mod, props: {}, calls: [], runs: [], toasts: [], overlays: [], closed: [], commands: [], waiters: [], idle: [], spaces: [], panes: [], focused: null, layout: null });
	host.storage = new Map();
	host.exec = async () => ({ code: 1, stdout: "", stderr: "modvm: no exec set" });
}

// Sends a key command to the mod (what `run("<mod>.<command>")` does in Herdr).
export function command(c: string) {
	const w = host.waiters.shift();
	if (w) w(c);
	else host.commands.push(c);
}

// Resolves the next time the mod's command loop waits again, i.e. it finished the last command.
export const nextIdle = () => new Promise<void>(r => host.idle.push(r));

// --- Elements ---------------------------------------------------------------------------------

export interface Node {
	type: string;
	key?: string;
	src?: string;
	tooltip?: string;
	items: unknown[];
	handlers: Record<string, (...a: any[]) => any>;
}

const NODE = Symbol("node");
// Builder calls (`.px(8)`, `.child(…)`, …) since the last reset: a rough count of the work a
// render hands to Herdr's native side.
export const counters = { elements: 0, calls: 0 };

const methods = new Map<string, (...a: any[]) => any>();
function method(key: string) {
	let fn = methods.get(key);
	if (fn) return fn;
	fn = function (this: any, ...args: any[]) {
		const node: Node = this[NODE];
		counters.calls++;
		if (key === "when") {
			if (args[0]) args[1](this);
		} else if (key === "child") node.items.push(args[0]);
		// A slot (a HoverCard's trigger and card) is drawn by its component: kept as a child, so find() reaches it.
		else if (key === "trigger" || key === "content") node.items.push(args[0]);
		else if (key === "children") node.items.push(...args[0]);
		else if (key === "id") node.key = args[0];
		else if (key === "tooltip") node.tooltip = args[0];
		else if (key.startsWith("on_")) {
			// on_click(fn) -> handlers.on_click; on_mouse_down("right", fn) -> handlers["on_mouse_down:right"].
			const name = typeof args[0] === "string" ? `${key}:${args[0]}` : key;
			node.handlers[name] = args[args.length - 1];
		} else if (typeof args[0] === "function") args[0](element("style"));
		return this;
	};
	methods.set(key, fn);
	return fn;
}

const handler: ProxyHandler<Node> = {
	get(target, key) {
		if (key === NODE) return target;
		// Not a thenable, not a primitive: an element must never look like a Promise.
		if (typeof key !== "string" || key === "then") return undefined;
		return method(key);
	},
};

export function element(type: string, src?: string): any {
	counters.elements++;
	return new Proxy<Node>({ type, src, items: [], handlers: {} }, handler);
}

export const nodeOf = (el: any): Node | undefined => (el && typeof el === "object" ? el[NODE] : undefined);

// The first node with this id (`.id(…)`), depth first.
export function find(el: any, id: string): Node | null {
	const node = nodeOf(el);
	if (!node) return null;
	if (node.key === id) return node;
	for (const c of node.items) {
		const hit = find(c, id);
		if (hit) return hit;
	}
	return null;
}

// --- Contexts ---------------------------------------------------------------------------------

export interface Cx {
	live: boolean;
	notified: number;
	notify(): void;
	spawn(fn: (cx: Cx) => Promise<void>): void;
	sleep(ms: number): Promise<void>;
	stop_propagation(): void;
	focus_handle(): { is_focused(): boolean; focus(): void };
	timer: { every(): void; after(): void };
}

// One mod copy: init, its spawned tasks, and render() on every cx.notify() (Herdr draws the next
// frame after a notify; here the draw runs at once, so its time is easy to read).
export class ModVm {
	mod: any;
	tasks: ((cx: Cx) => Promise<void>)[] = [];
	// One entry per render(): when it returned, how long it took, and its builder calls.
	draws: { at: number; ms: number; calls: number; elements: number; tree: any }[] = [];
	drawOnNotify = true;

	constructor(readonly Mod: new () => any) {}

	cx(): Cx {
		const cx: Cx = {
			live: true,
			notified: 0,
			notify: () => {
				if (!cx.live) throw new Error("cx is no longer valid");
				cx.notified++;
				if (this.drawOnNotify) this.draw();
			},
			spawn: fn => {
				this.tasks.push(fn);
			},
			// The poll loop's wait: real time, so a started poll loop keeps Herdr's pace.
			sleep: ms => Bun.sleep(ms),
			stop_propagation() {},
			focus_handle: () => ({ is_focused: () => false, focus() {} }),
			timer: { every() {}, after() {} },
		};
		return cx;
	}

	init(props: Record<string, unknown> = {}) {
		host.props = props;
		this.mod = new this.Mod();
		const cx = this.cx();
		this.mod.init(props, cx);
		cx.live = false;
		return this;
	}

	// Starts the i-th task init spawned (it runs on its own, like Herdr's cx.spawn).
	start(i: number) {
		const task = this.tasks[i];
		if (!task) throw new Error(`modvm: the mod spawned no task ${i}`);
		task(this.cx()).catch(err => console.error(`modvm task ${i}:`, err));
	}

	draw() {
		const cx = this.cx();
		const calls = counters.calls;
		const elements = counters.elements;
		const t0 = now();
		const tree = this.mod.render(cx);
		const t1 = now();
		cx.live = false;
		this.draws.push({ at: t1, ms: t1 - t0, calls: counters.calls - calls, elements: counters.elements - elements, tree });
		if (this.draws.length > 1000) this.draws.splice(0, 500);
		return tree;
	}
}

// --- Stub modules -----------------------------------------------------------------------------

const theme = new Proxy({}, { get: (_t, k) => (typeof k === "string" ? "#000000" : undefined) });
// The "herdr" module. Its functions read `host` at call time; a mod that needs one of the empty
// ones below can have it replaced here before loadMod().
export const herdr: Record<string, unknown> = {
	exec: async (cmd: string, args: string[] = []) => {
		const start = now();
		try {
			const r = await host.exec(cmd, args);
			host.calls.push({ cmd, args, start, end: now(), code: r.code });
			return r;
		} catch (err) {
			host.calls.push({ cmd, args, start, end: now(), code: -1 });
			throw err;
		}
	},
	theme: () => theme,
	props: () => host.props,
	run: (name: string, args?: unknown) => {
		host.runs.push({ name, args });
		if (host.mod && name.startsWith(`${host.mod}.`)) command(name.slice(host.mod.length + 1));
	},
	nextCommand: () => {
		for (const r of host.idle.splice(0)) r();
		const c = host.commands.shift();
		return c !== undefined ? Promise.resolve(c) : new Promise<string>(r => host.waiters.push(r));
	},
	notify: (n: unknown) => host.toasts.push(n),
	openOverlay: (o: unknown) => host.overlays.push(o),
	closeOverlay: (id: unknown) => host.closed.push(id),
	spaces: () => host.spaces,
	panes: () => host.panes,
	focused: () => host.focused,
	layout: () => host.layout,
	// As in Herdr, both return promises: no file is there, and no folder event ever comes.
	readTextFile: async () => null,
	watchFolder: () => Object.assign(new Promise<string[]>(() => {}), { cancel() {} }),
	home: () => process.env.HOME,
	appHome: () => process.env.HERDR_APP_HOME,
	checking: () => false,
	shared: () => null,
};
for (const name of "hc writeTextFile knownAgents pickFolder playSound machines agents setAgentOrder terminals layouts commands window setWindowTitle setBadge placement themes fonts updates presentUpdateNotes telemetry settings keys setShared".split(" "))
	herdr[name] ??= (..._a: unknown[]) => undefined;

class View {}
const factory = (type: string) =>
	function (src?: string) {
		return element(type, src);
	};

plugin({
	name: "mod-stubs",
	setup(build) {
		build.module("herdr", () => ({ loader: "object", exports: herdr }));
		build.module("gpui-kit", () => ({ loader: "object", exports: { View, div: factory("div"), svg: factory("svg"), image: factory("image"), list: factory("list"), uniform_list: factory("list") } }));
		build.module("gpui-base", () => ({
			loader: "object",
			exports: {
				h_flex: factory("h_flex"), v_flex: factory("v_flex"), Popover: factory("popover"), Input: factory("input"), InputState: factory("input-state"),
				HoverCard: { new: (id: string) => element("hovercard").id(id) },
			},
		}));
	},
});

(globalThis as any).localStorage = {
	getItem: (k: string) => host.storage.get(k) ?? null,
	setItem: (k: string, v: unknown) => void host.storage.set(k, String(v)),
	removeItem: (k: string) => void host.storage.delete(k),
	clear: () => host.storage.clear(),
};

// The default export (the View class) of <modDir>/main.js. Its own imports (./owners.js, …) load
// as usual. Bun keeps a module once loaded, so module-level state (caches) lasts for the process.
export async function loadMod(modDir: string): Promise<new () => any> {
	return (await import(path.join(modDir, "main.js"))).default;
}
