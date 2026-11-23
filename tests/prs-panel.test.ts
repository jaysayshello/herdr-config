// The Pull requests view (herdr-app/mods/t3-prs/main.js) keeps its list current: in lib/modvm.ts,
// with gh answered from memory. A cx works as Herdr's does: a click's cx is dead once the click
// returns, and the poll loop's cx lasts.
import { beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { prFixture } from "../bench/lib/fakegh.ts";
import { type Cx, find, host, loadMod, ModVm, resetHost } from "../bench/lib/modvm.ts";

const modDir = path.join(import.meta.dir, "../herdr-app/mods/t3-prs");
const Mod = await loadMod(modDir);

// The open pull requests that the next poll returns. Follow-up reads (comments, code owners) fail,
// which the view takes in its stride.
let open = prFixture(2, 0);
let polls = 0;

beforeEach(() => {
	resetHost("t3-prs");
	open = prFixture(2, 0);
	polls = 0;
	host.exec = async (cmd, args) => {
		if (cmd === "gh" && args[0] === "api" && (args[3] ?? "").includes("pullRequests(states: OPEN")) {
			polls++;
			return { code: 0, stdout: JSON.stringify(open), stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "not in this test" };
	};
});

// Lets the mod's promises run, until ok() or 2000 turns.
async function until(ok: () => boolean) {
	for (let i = 0; i < 2000 && !ok(); i++) await new Promise(r => setImmediate(r));
	return ok();
}
const shows = (vm: ModVm, id: string) => vm.draws.some(d => find(d.tree, id));

test("a refresh click draws the new list after the click has returned", async () => {
	const vm = new ModVm(Mod).init();
	const spawned = vm.tasks.length;
	const cx = vm.cx();
	find(vm.draw(), "prs-refresh")!.handlers.on_click({}, cx);
	cx.live = false;
	for (let i = spawned; i < vm.tasks.length; i++) vm.start(i);
	expect(await until(() => shows(vm, "pr-repo-0-1000"))).toBe(true);
	expect(polls).toBe(1);
});

test("the poll loop keeps polling after a poll throws", async () => {
	const vm = new ModVm(Mod).init();
	// The poll loop is the first task; its cx waits for a tick of this test, not 5 s.
	let tick: (() => void) | undefined;
	const cx: Cx = { ...vm.cx(), sleep: () => new Promise<void>(r => (tick = r)) };
	const set = globalThis.localStorage.setItem;
	let fail = true;
	globalThis.localStorage.setItem = (k: string, v: string) => {
		if (fail) {
			fail = false;
			throw new Error("store write failed");
		}
		set(k, v);
	};
	try {
		vm.tasks[0](cx).catch(() => {});
		// The first poll threw; the loop waits for its next turn.
		expect(await until(() => polls === 1 && tick !== undefined)).toBe(true);
		open = prFixture(3, 0);
		tick!();
		expect(await until(() => polls === 2 && shows(vm, "pr-repo-2-1002"))).toBe(true);
	} finally {
		globalThis.localStorage.setItem = set;
	}
});
