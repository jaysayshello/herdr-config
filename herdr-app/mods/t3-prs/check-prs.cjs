// node mods/t3-prs/check-prs.cjs
// 1. A click on a group header (Ready, Draft, Merged) folds it and asks for a redraw. Herdr's cx is
// valid only during the call it is passed to: a cx kept from render() throws "cx is no longer
// valid" when a click uses it later, so the fold showed only at the next unrelated redraw.
// 2. Merge: the menu item shows only for a ready PR, the dialog comes first, the method follows
// the repo, the head commit is pinned, and gh's error text reaches the toast.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function element() {
  const node = { items: [], handlers: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child") node.items.push(args[0]);
      else if (key === "children") node.items.push(...args[0]);
      else if (key === "on_click") node.handlers.click = args[0];
      else if (key === "on_mouse_down") node.handlers[args[0]] = args[1];
      else if (key === "id") node.key = args[0];
      return proxy;
    };
  } });
  return proxy;
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.key === id) return node;
  for (const child of node.items) { const found = find(child, id); if (found) return found; }
  return null;
}

// A cx as Herdr gives it: usable until the call that received it returns.
function scopedCx() {
  const cx = { live: true, notified: 0, stop_propagation() {},
    notify() { if (!cx.live) throw new Error("cx is no longer valid"); cx.notified += 1; },
    spawn(fn) { spawned.push(fn); }, sleep: () => new Promise(() => {}), focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  return cx;
}

const store = new Map();
const spawned = [];
// What the mod asks of Herdr; each test sets the answers and reads the calls.
const host = { props: {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }), calls: [], toasts: [], overlays: [], runs: [], closed: [] };
const env = {
  View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
  theme: () => new Proxy({}, { get: () => "#000000" }), props: () => host.props,
  exec: (cmd, args) => { host.calls.push([cmd, ...args]); return host.exec(cmd, args); },
  run: (name) => host.runs.push(name), spaces: () => [], focused: () => null,
  nextCommand: () => host.commands?.length ? Promise.resolve(host.commands.shift()) : new Promise(() => {}),
  notify: (n) => host.toasts.push(n), openOverlay: (o) => host.overlays.push(o), closeOverlay: (id) => host.closed.push(id),
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  // owners.js and comments.js run only after a fetch; this check draws and clicks.
  checkCodeOwners: async () => ({ ok: true }), fetchComments: async () => [], summarize: () => ({ count: 0, fresh: 0, by: [] }),
};
const file = path.join(__dirname, "main.js");
const src = fs.readFileSync(file, "utf8")
  .replace(/^import [\s\S]*?;\r?\n/gm, "").replace("export default class", "globalThis.Mod = class");
const context = vm.createContext({ ...env, JSON, Date, Map, Promise, String, Number, Object, Array, Error });
vm.runInContext(src, context, { filename: file });

const mod = new context.Mod();
mod.init({}, scopedCx());
const pr = (number, draft) => ({ number, title: `PR ${number}`, draft, url: `https://example.com/pull/${number}`, repo: "demo",
  fullRepo: "example/demo", reviews: [], ci: null });
mod.prs = [pr(1, false), pr(2, true)];
mod.merged = [{ number: 3, title: "Merged", url: "https://example.com/pull/3", repo: "demo", mergedAt: "2026-11-13T14:00:00Z" }];

function draw() {
  const cx = scopedCx();
  const tree = mod.render(cx);
  cx.live = false;
  return tree;
}

for (const id of ["ready", "draft", "merged"]) {
  for (const want of [true, false]) {
    const header = find(draw(), id);
    assert.ok(header?.handlers.click, `${id} header has a click handler`);
    const click = scopedCx();
    assert.doesNotThrow(() => header.handlers.click({}, click), `${id} header click must not use a cx kept from render()`);
    click.live = false;
    assert.equal(Boolean(mod.folded[id]), want, `${id} folded is ${want} after the click`);
    assert.equal(JSON.parse(store.get("folded"))[id], want, `${id} fold saved`);
    assert.equal(click.notified, 1, `${id} click asks for a redraw with its own cx`);
    assert.equal(Boolean(find(draw(), id) && mod.visible().some((p) => p.number === { ready: 1, draft: 2, merged: 3 }[id])), !want,
      `${id} rows ${want ? "hidden" : "shown"} on the next draw`);
  }
}
console.log("check-prs: header folds pass");

// --- Merge ---
const HEAD = "a".repeat(40);
const ready = (over = {}) => ({ ...pr(7, false), url: "https://example.com/pull/7", head: HEAD, base: "main",
  decision: "APPROVED", mergeable: "MERGEABLE", mergeState: "CLEAN", ...over });
const menuIds = (p) => {
  host.props = { menu: p, overlay: "o1" };
  const tree = draw();
  host.props = {};
  return ["copy", "ready", "draft", "merge", "close"].filter((id) => find(tree, id));
};
const cases = [
  ["ready, checks passed", ready(), true],
  ["ready, with hooks", ready({ mergeState: "HAS_HOOKS" }), true],
  ["a required check failed", ready({ mergeState: "BLOCKED" }), false],
  ["a check failed", ready({ mergeState: "UNSTABLE" }), false],
  ["no approval", ready({ decision: "REVIEW_REQUIRED" }), false],
  ["changes requested", ready({ decision: "CHANGES_REQUESTED" }), false],
  ["conflicts", ready({ mergeable: "CONFLICTING", mergeState: "DIRTY" }), false],
  ["mergeability not known yet", ready({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" }), false],
  ["draft", ready({ draft: true, mergeState: "DRAFT" }), false],
];
for (const [what, p, shows] of cases) {
  const ids = menuIds(p);
  assert.equal(ids.includes("merge"), shows, `Merge ${shows ? "shows" : "is hidden"}: ${what}`);
  assert.ok(ids.includes("copy") && ids.includes("close") && ids.includes(p.draft ? "ready" : "draft"), `other items stay: ${what}`);
}

const reset = () => { for (const k of ["calls", "toasts", "overlays", "runs", "closed"]) host[k] = []; };
const ghCalls = (sub) => host.calls.filter((c) => c[0] === "gh" && c[1] === sub[0] && c[2] === sub[1]);
const repoAllows = (allowed) => async (_cmd, args) => args[0] === "repo"
  ? { code: 0, stdout: JSON.stringify({ squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false, ...allowed }), stderr: "" }
  : { code: 1, stdout: "", stderr: "" };

(async () => {
  // The menu item only asks the main copy; the dialog comes before any merge.
  reset();
  host.props = { menu: ready(), overlay: "o1" };
  find(draw(), "merge").handlers.click();
  host.props = {};
  assert.deepEqual(host.runs, ["t3-prs.ask-merge:https://example.com/pull/7"], "the item sends ask-merge");
  assert.deepEqual(host.closed, ["o1"], "the item closes the menu");

  // Method order, read once per repo.
  for (const [allowed, flag] of [[{ squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true }, "squash"],
    [{ mergeCommitAllowed: true, rebaseMergeAllowed: true }, "merge"], [{ rebaseMergeAllowed: true }, "rebase"]]) {
    reset();
    mod.methods = new Map();
    mod.prs = [ready()];
    host.exec = repoAllows(allowed);
    await mod.askMerge("https://example.com/pull/7");
    await mod.askMerge("https://example.com/pull/7");
    assert.equal(ghCalls(["repo", "view"]).length, 1, `repo methods read once (${flag})`);
    assert.equal(host.overlays.length, 2, "a confirm dialog each time");
    const dialog = host.overlays[0];
    assert.equal(dialog.mod, "confirm");
    assert.equal(dialog.props.title, "Merge example/demo#7: PR 7?");
    assert.equal(dialog.props.command.name, `t3-prs.merge:${HEAD}:https://example.com/pull/7`, "the dialog pins the head commit");
    assert.equal(mod.methods.get("example/demo").flag, flag, `first permitted method: ${flag}`);
    assert.equal(ghCalls(["pr", "merge"]).length, 0, "asking never merges (a cancelled dialog runs nothing)");
  }
  reset();
  mod.methods = new Map();
  host.exec = repoAllows({});
  await mod.askMerge("https://example.com/pull/7");
  assert.equal(host.overlays.length, 0, "no dialog when the repo permits no method");
  assert.equal(host.toasts.at(-1).level, "error");

  // The confirmed command, through the real command loop: the url keeps its colon.
  reset();
  mod.methods = new Map([["example/demo", { flag: "squash", label: "Squash merge" }]]);
  mod.prs = [ready()];
  host.exec = async () => ({ code: 0, stdout: "", stderr: "" });
  host.commands = [`merge:${HEAD}:https://example.com/pull/7`];
  spawned[1](scopedCx());
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ghCalls(["pr", "merge"]), [["gh", "pr", "merge", "7", "-R", "example/demo", "--squash", "--match-head-commit", HEAD]],
    "gh pr merge with the method and the pinned head, no --admin, no --delete-branch");
  assert.deepEqual(host.toasts.map((t) => [t.title, t.level]), [["Merged", "success"]]);
  const merge = host.calls.findIndex((c) => c[2] === "merge");
  assert.ok(host.calls.slice(merge + 1).some((c) => c[1] === "api" && String(c[4]).includes("mergeStateStatus")), "a poll right after the merge");

  // gh's own error text goes to the toast, unchanged.
  reset();
  const err = "GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)";
  host.exec = async (_cmd, args) => args[1] === "merge" ? { code: 1, stdout: "", stderr: `${err}\n` } : { code: 1, stdout: "", stderr: "" };
  mod.prs = [ready()];
  await mod.merge(HEAD, "https://example.com/pull/7", scopedCx());
  assert.deepEqual([host.toasts[0].title, host.toasts[0].body, host.toasts[0].level], ["Merge failed", err, "error"]);

  // A push the poll already saw, or a PR no longer ready: no gh pr merge at all.
  for (const [what, now] of [["new head", ready({ head: "b".repeat(40) })], ["changes requested", ready({ decision: "CHANGES_REQUESTED" })],
    ["gone", null]]) {
    reset();
    mod.prs = now ? [now] : [];
    await mod.merge(HEAD, "https://example.com/pull/7", scopedCx());
    assert.equal(ghCalls(["pr", "merge"]).length, 0, `no merge: ${what}`);
    assert.equal(host.toasts[0].title, "Merge stopped", `toast: ${what}`);
  }

  // The poll fills the fields Merge needs.
  reset();
  const node = { number: 7, title: "PR 7", isDraft: false, url: "https://example.com/pull/7", headRefOid: HEAD, baseRefName: "main",
    reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", updatedAt: "2026-11-15T00:00:00Z", author: { login: "me" },
    repository: { name: "demo", nameWithOwner: "example/demo" }, latestReviews: { nodes: [] }, commits: { nodes: [] } };
  host.exec = async (_cmd, args) => args[0] === "api"
    ? { code: 0, stdout: JSON.stringify({ data: { viewer: { pullRequests: { nodes: [node] }, merged: { nodes: [] } } } }), stderr: "" }
    : { code: 1, stdout: "", stderr: "" };
  mod.loading = false;
  await mod.load(scopedCx(), true);
  assert.equal(ghCalls(["api", "graphql"]).length, 1, "still one GraphQL call per poll");
  assert.deepEqual([mod.prs[0].mergeable, mod.prs[0].mergeState, mod.prs[0].decision, mod.prs[0].head], ["MERGEABLE", "CLEAN", "APPROVED", HEAD]);
  console.log(`check-prs: merge passes (${cases.length} menu states)`);
})().catch((e) => { console.error(e); process.exit(1); });
