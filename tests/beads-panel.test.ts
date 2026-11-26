// The Beads panel (herdr-app/mods/t3-beads/main.js) in lib/modvm.ts, against the real bd on a beads
// workspace in a temporary folder: it reads the shown space's progress, and sets beads up in a folder
// that has none without running git init there.
import { afterAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { command, find, host, loadMod, ModVm, resetHost } from "../bench/lib/modvm.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "beads-panel-"));
// The sandbox HOME has no bd settings: keep bd's usage metrics off for every bd this test runs.
process.env.DO_NOT_TRACK = "1";
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

let folder = "";
const Mod = await loadMod(path.join(import.meta.dir, "../herdr-app/mods/t3-beads"));

const sh = (cmd: string, args: string[], cwd: string) => {
	const r = Bun.spawnSync([cmd, ...args], { cwd, env: process.env });
	return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const bd = (dir: string, ...args: string[]) => {
	const r = sh("bd", [...args, "--json"], dir);
	if (r.code !== 0) throw new Error(`bd ${args.join(" ")}: ${r.stderr}`);
	return JSON.parse(r.stdout);
};

beforeEach(() => {
	resetHost("t3-beads");
	host.exec = async (cmd, args) => sh(cmd, args, folder);
});

// The shown space: one tab whose first terminal is in dir; the Beads block is in the layout, shown.
function show(dir: string) {
	folder = dir;
	host.spaces = [{ id: "sp1", active: true, tabs: [{ id: "tb1" }], folder: dir, machine: null }];
	host.panes = [{ pane: "p1", terminal: "t1", tab: "tb1", cwd: dir }];
	host.layout = { id: "root", children: [{ id: "beads", type: "block" }] };
}

// Starts every task the mod spawned (init's and each render's) once, until ok() or about 20 s.
const started = new WeakMap<ModVm, number>();
async function until(vm: ModVm, ok: () => boolean) {
	for (let i = 0; i < 4000 && !ok(); i++) {
		for (let n = started.get(vm) ?? 0; n < vm.tasks.length; n++, started.set(vm, n)) vm.start(n);
		await Bun.sleep(5);
	}
	return ok();
}
const last = (vm: ModVm) => vm.draws.at(-1)?.tree;

test("shows the done bar, epics, and the in progress, ready and blocked beads", async () => {
	const dir = path.join(tmp, "project");
	fs.mkdirSync(dir);
	expect(sh("env", [`BEADS_DIR=${dir}/.beads`, "bd", "init", "--quiet", "--stealth", "--skip-agents", "--skip-hooks", "--non-interactive", "-p", "pj"], dir).code).toBe(0);
	const epic = bd(dir, "create", "Ship it", "-t", "epic", "-p", "1").id;
	const doing = bd(dir, "create", "Write it", "-p", "1", "--parent", epic).id;
	const done = bd(dir, "create", "Plan it", "-p", "2", "--parent", epic).id;
	const docs = bd(dir, "create", "Docs", "-p", "3").id;
	sh("bd", ["dep", "add", docs, doing], dir);
	sh("bd", ["update", doing, "--claim"], dir);
	sh("bd", ["close", done], dir);
	show(dir);

	const vm = new ModVm(Mod).init();
	vm.draw();
	expect(await until(vm, () => Boolean(find(last(vm), "beads-bar")))).toBe(true);
	const tree = last(vm);
	expect(find(tree, `epic-${epic}`)).not.toBeNull();
	expect(find(tree, `bead-active-${doing}`)).not.toBeNull();
	expect(find(tree, `bead-blocked-${docs}`)).not.toBeNull();
	// The epic is ready to bd, but the Ready list holds work only.
	expect(find(tree, `bead-ready-${epic}`)).toBeNull();
	expect(find(tree, "beads-setup")).toBeNull();
	// Reads only: nothing claimed or closed by the panel.
	expect(bd(dir, "show", doing)[0].status).toBe("in_progress");
}, 60_000);

test("a folder without beads offers setup, which makes .beads and no git repo", async () => {
	const dir = path.join(tmp, "plain");
	fs.mkdirSync(dir);
	show(dir);
	const vm = new ModVm(Mod).init();
	vm.draw();
	expect(await until(vm, () => Boolean(find(last(vm), "beads-setup")))).toBe(true);

	find(last(vm), "beads-setup")!.handlers.on_click({}, vm.cx());
	const ask = host.overlays.at(-1) as any;
	expect(ask.mod).toBe("confirm");
	// What the confirm dialog runs on Enter.
	command(ask.props.command.name.slice("t3-beads.".length));
	expect(await until(vm, () => Boolean(find(last(vm), "beads-summary")))).toBe(true);
	expect(fs.existsSync(path.join(dir, ".beads"))).toBe(true);
	expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
	expect(host.toasts.at(-1)).toMatchObject({ title: "Beads set up", level: "success" });
}, 60_000);

test("runs no bd while the sidebar shows the Inbox, and reads once the lists show again", async () => {
	show(path.join(tmp, "plain"));
	const lists = { id: "lists", type: "column", children: [{ id: "beads", type: "block" }] };
	const stack = { id: "sidebar-lists", type: "stack", active: "inbox", children: [lists, { id: "inbox", type: "block" }] };
	host.layout = { id: "root", children: [stack] };
	const vm = new ModVm(Mod).init();
	vm.draw();
	let turns = 0;
	await until(vm, () => ++turns > 40);
	expect(host.calls.length).toBe(0);
	stack.active = "lists";
	vm.draw();
	expect(await until(vm, () => host.calls.some(c => c.cmd === "bd"))).toBe(true);
}, 60_000);
