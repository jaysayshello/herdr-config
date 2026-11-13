// node mods/t3-prs/check-prs.cjs: a click on a group header (Ready, Draft, Merged) folds it and
// asks for a redraw. Herdr's cx is valid only during the call it is passed to: a cx kept from
// render() throws "cx is no longer valid" when a click uses it later, so the fold showed only
// at the next unrelated redraw (a poll with new data, an agent's state change) or not at all.
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
    spawn() {}, focus_handle: () => ({ is_focused: () => false, focus() {} }) };
  return cx;
}

const store = new Map();
const env = {
  View: class {}, div: element, svg: element, h_flex: element, v_flex: element,
  theme: () => new Proxy({}, { get: () => "#000000" }), props: () => ({}),
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), run() {}, spaces: () => [], focused: () => null,
  nextCommand: () => new Promise(() => {}), notify() {}, openOverlay() {}, closeOverlay() {},
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
