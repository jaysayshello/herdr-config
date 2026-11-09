import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, updates, layout, nextCommand, window } from "herdr";
import { trafficLights } from "./lights.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar shows either Lists (Spaces and Agents) or the Inbox (t3-inbox): a stack in the layout.
const inboxShown = () => find(layout(), "sidebar-lists")?.active === "inbox";
const switchSidebar = () => run("layout.select", { stack: "sidebar-lists", child: inboxShown() ? "lists" : "inbox" });

// The tab bar (layout node "tabs") and the pane headers (the "main" block's pane.header) hide and
// show together. Layout nodes have no native transition, so the toggle shrinks (or grows) both
// over STEPS frames with layout.set, then hides the tab bar. The header has no hidden flag, so
// hidden, it is off the layout and kept here (localStorage of this mod) to put back.
const HEADER = { content: { mod: "t3-pane" }, reveal: "always", height: 28, position: "top" };
const STEPS = 12, FRAME = 16;
const ease = (x) => 1 - (1 - x) ** 3;
const barsShown = () => !find(layout(), "tabs")?.hidden;
let moving = false;
async function toggleBars(cx) {
  if (moving) return;
  const root = JSON.parse(JSON.stringify(layout()));
  const tabs = find(root, "tabs"), pane = find(root, "main")?.content?.pane;
  if (!tabs || !pane) return;
  moving = true;
  const hide = !tabs.hidden;
  if (hide && pane.header) localStorage.setItem("header", JSON.stringify(pane.header));
  const header = pane.header ?? JSON.parse(localStorage.getItem("header") ?? "null") ?? HEADER;
  const barPx = tabs.size?.px ?? 40, headPx = header.height ?? 28;
  // k: how much of both bars shows, 1 to 0 when hiding, 0 to 1 when showing.
  const frame = (k) => {
    tabs.hidden = false;
    tabs.size = { px: Math.round(barPx * k) };
    pane.header = { ...header, height: Math.max(1, Math.round(headPx * k)) };
    run("layout.set", { layout: root });
  };
  try {
    for (let i = 1; i <= STEPS; i++) {
      const k = ease(i / STEPS);
      frame(hide ? 1 - k : k);
      await cx.sleep(FRAME);
    }
  } finally {
    tabs.size = { px: barPx };
    tabs.hidden = hide;
    if (hide) delete pane.header;
    else pane.header = header;
    run("layout.set", { layout: root });
    moving = false;
  }
}

export default class WorkspaceChrome extends View {
  init(_props, cx) {
    // Only the brand bar's copy takes `t3-chrome.sidebar` and `t3-chrome.bars`; the footer's only draws.
    if (props()?.footer) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "sidebar") switchSidebar();
        else if (c === "bars") await toggleBars(cx);
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    if (props()?.footer) {
      const row = (id, icon, label, action) => h_flex().id(id).relative().h(30).px(8).gap(8).items_center().rounded(8)
        .role("button").accessibility_label(label)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(action).child(h_flex().size(18).flex_none().items_center().justify_center()
          .child(svg(`mods/t3-chrome/${icon}.svg`).size(16)))
        .child(div().flex_1().min_w(0).truncate().child(label));
      const shown = barsShown();
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).pt(4).pb(6).text_size(13)
        .child(row("bars", shown ? "bars-hide" : "bars-show", shown ? "Hide tab bar" : "Show tab bar", () => run("t3-chrome.bars")))
        .child(row("settings", "settings", "Settings", () => run("app.settings"))
          .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent))));
    }
    // The window buttons at the left (macOS draws its own traffic lights there, the layout's
    // traffic_lights; elsewhere lights.js draws the same), a place to drag the window, and the
    // sidebar toggle at its right edge; while the sidebar is hidden, t3-tabs shows both.
    const inbox = inboxShown(), w = window();
    return h_flex().id("brand").size_full().bg(t.chrome).pl(16).pr(10).gap(2).items_center()
      .when(Boolean(w?.buttons), el => el.child(trafficLights(this, w)))
      .child(div().flex_1())
      .child(div().id("sidebar-mode").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(inbox ? "Show lists" : "Show inbox")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(switchSidebar)
        .child(svg(`mods/workspace-chrome/${inbox ? "layers" : "circle-check"}.svg`).size(14)))
      .child(div().id("sidebar-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label("Hide sidebar")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.toggle", { id: "sidebar" }))
        .child(svg("mods/workspace-chrome/sidebar.svg").size(14)));
  }
}
