import { View, div } from "gpui-kit";
import { appHome, exec, focused, hc, home, layout, nextCommand, notify, run, terminals } from "herdr";

// The keys from ~/.config/herdr/config.toml that need more than one command (keys.json,
// section layout:herdr-t3). Nothing to see: the layout keeps a 0px copy alive for the keys.
//   swap-left|down|up|right  Ctrl+h/j/k/l: (n)vim gets the key (tmux's is_vim), else swap the pane
//   balance                  Ctrl+r: every pane in the tab gets an equal share
//   new-space                Ctrl+n: a new space in ~/Projects (keys.json can't pass `folder`)
//   nav-up|nav-down          Ctrl+w/s: the previous/next space; past the last space, down into the
//                            Pull requests list (t3-prs), but only while that list shows

const VIM = /^g?(view|n?vim?x?)(diff)?$/i;
const KEY = { left: "ctrl+h", down: "ctrl+j", up: "ctrl+k", right: "ctrl+l" };

const fail = (title, r) => notify({ title, body: (r.stderr || r.stdout).trim(), level: "error" });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
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

export default class TmuxKeys extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (c === "balance") await balance();
          else if (c.startsWith("swap-")) await swapOrVim(c.slice(5));
          else if (c === "new-space") run("space.new", { folder: `${home()}/Projects` });
          else if (c === "nav-down") run(prsShown() ? "t3-prs.down" : "space.next");
          else if (c === "nav-up") run(prsShown() ? "t3-prs.up" : "space.prev");
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
