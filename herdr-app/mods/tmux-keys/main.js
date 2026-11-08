import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { appHome, exec, focused, hc, home, layout, nextCommand, notify, run, setShared, shared, spaces, terminals } from "herdr";

// The keys from ~/.config/herdr/config.toml that need more than one command (keys.json,
// section layout:herdr-t3). Nothing to see: the layout keeps a 0px copy alive for the keys.
//   swap-left|down|up|right  Ctrl+h/j/k/l: (n)vim gets the key (tmux's is_vim), else swap the pane
//   balance                  Ctrl+r: every pane in the tab gets an equal share
//   new-space                Ctrl+n: a new space in ~/Projects (keys.json can't pass `folder`)
//   nav-up|nav-down          Ctrl+w/s: the previous/next space; past the last space, down into the
//                            Pull requests list (t3-prs), but only while that list shows
//   orchestrator             Ctrl+f: the space named "orchestrator" (by name: ids change after a restart)
//   pin[:<space>]            Ctrl+space p: pin / unpin the space (the active one without a name)
//   section:<S>[:<space>]    Ctrl+space o (S = Operational): move the space into sidebar section S, or out
// Pins and sections go by space name into spaces.json ({ pinned, sections }), shared with the
// sidebar and the space menu as "space.sidebar". Edits to the file by hand apply at the next start.
// It also puts scripts/toast-external.js over the shipped toast mod at each start, so
// notifications show outside the app (Herdr restores shipped mods at start and keeps the edit
// as mods/toast-edited*, which this removes).

const VIM = /^g?(view|n?vim?x?)(diff)?$/i;
const ORCHESTRATOR = "orchestrator";
const KEY = { left: "ctrl+h", down: "ctrl+j", up: "ctrl+k", right: "ctrl+l" };
const SIDEBAR = () => `${appHome()}/spaces.json`;

const fail = (title, r) => notify({ title, body: (r.stderr || r.stdout).trim(), level: "error" });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Adds `name` to `list`, or takes it out. Returns the new list.
const toggle = (list = [], name) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
const activeName = () => spaces().find((s) => s.active)?.name;

async function loadSidebar() {
  const text = await fs.readFile(SIDEBAR(), "utf8").catch(() => "{}");
  const { pinned = [], sections = {} } = JSON.parse(text);
  setShared("space.sidebar", { pinned, sections });
}

async function saveSidebar(change) {
  const { pinned = [], sections = {} } = shared("space.sidebar") ?? {};
  const next = change({ pinned, sections: { ...sections } });
  setShared("space.sidebar", next);
  await fs.writeFile(SIDEBAR(), JSON.stringify(next, null, 2) + "\n");
}

const pin = (name) => saveSidebar((s) => ({ ...s, pinned: toggle(s.pinned, name) }));

// A space is in one section at most: moving it in takes it out of the others.
const section = (target, name) => saveSidebar((s) => {
  const inside = (s.sections[target] ?? []).includes(name);
  for (const k of Object.keys(s.sections)) s.sections[k] = s.sections[k].filter((n) => n !== name);
  if (!inside) s.sections[target] = [...(s.sections[target] ?? []), name];
  return s;
});
// `<mod>.<command>` reaches shown copies only: with the sidebar or its lists hidden, t3-prs hears nothing.
const prsShown = () => {
  const root = layout();
  return Boolean(find(root, "prs")) && !find(root, "sidebar")?.hidden && find(root, "sidebar-lists")?.active !== "inbox";
};

async function swapOrVim(direction) {
  const t = focused()?.terminal;
  const term = t && terminals().find((x) => x.address === t);
  const names = [term?.program?.key, ...(term?.argv?.slice(0, 1) ?? [])].map((n) => String(n ?? "").split("/").pop());
  if (names.some((n) => VIM.test(n))) {
    const r = await hc(["keys", t, KEY[direction]]);
    if (r.code !== 0) fail(`Could not send ${KEY[direction]} to vim`, r);
  } else {
    run("pane.swap", { direction });
  }
}

async function balance() {
  const tab = focused()?.tab;
  if (!tab) return;
  const slash = tab.lastIndexOf("/");
  const args = slash < 0 ? [tab] : [tab.slice(slash + 1), tab.slice(0, slash)];
  const r = await exec(`${appHome()}/scripts/balance-panes.sh`, args);
  if (r.code !== 0) fail("Could not balance panes", r);
}

function orchestrator() {
  const space = spaces().find((s) => s.name === ORCHESTRATOR);
  if (space) run("space.select", { id: space.id });
  else notify({ title: "No orchestrator space", body: `Name a space "${ORCHESTRATOR}" (shift-f2).`, level: "error" });
}

export default class TmuxKeys extends View {
  init(_props, cx) {
    exec("/bin/sh", ["-c", 'cd "$1" && { cmp -s scripts/toast-external.js mods/toast/main.js || cp scripts/toast-external.js mods/toast/main.js; } && rm -rf mods/toast-edited*', "sh", appHome()])
      .catch((e) => notify({ title: "Could not install the external toast", body: String(e), level: "error" }));
    loadSidebar().catch((e) => notify({ title: "Could not read spaces.json", body: String(e), level: "error" }));
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (c === "balance") await balance();
          else if (c.startsWith("swap-")) await swapOrVim(c.slice(5));
          else if (c === "new-space") run("space.new", { folder: `${home()}/Projects` });
          else if (c === "nav-down") run(prsShown() ? "t3-prs.down" : "space.next");
          else if (c === "nav-up") run(prsShown() ? "t3-prs.up" : "space.prev");
          else if (c === "orchestrator") orchestrator();
          else if (c === "pin" || c.startsWith("pin:")) {
            const name = c.slice(4) || activeName();
            if (name) await pin(name);
          } else if (c.startsWith("section:")) {
            const [target, ...rest] = c.slice(8).split(":");
            const name = rest.join(":") || activeName();
            if (target && name) await section(target, name);
          }
        } catch (e) {
          notify({ title: `tmux-keys: ${c}`, body: String(e), level: "error" });
        }
      }
    });
  }

  render() {
    return div().size_full();
  }
}
