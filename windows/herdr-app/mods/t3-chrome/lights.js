import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run } from "herdr";

// macOS-style window buttons for Windows and Linux, where `"titlebar": "none"` leaves none
// (window().buttons). Red closes, yellow minimizes, green maximizes. As on a Mac, the glyphs show
// while the pointer is on the group, and the lights go gray while the window is in the background.
const LIGHTS = [
  ["close-window", "Close", "#ff5f57", "x", "window.close"],
  ["minimize", "Minimize", "#febc2e", "minus", "window.minimize"],
  ["maximize", "Maximize", "#28c840", "plus", "window.maximize"],
];

// The same file is in t3-chrome and t3-tabs: a mod can't import from another mod's folder.
// `view.lightsHot` holds the hover, so each view that draws them keeps its own.
export function trafficLights(view, w) {
  const hot = Boolean(view.lightsHot);
  return h_flex().id("traffic-lights").flex_none().gap(8).items_center()
    .on_hover((over, cx) => { view.lightsHot = over; cx.notify(); })
    .children(LIGHTS.map(([id, label, color, icon, command]) => div().id(id).size(12).flex_none().rounded_full()
      .flex().items_center().justify_center()
      .bg(w.active || hot ? color : "#5c5c5c")
      .role("button").accessibility_label(label)
      // A press on a light clicks it; it doesn't drag the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run(command))
      .when(hot, el => el.child(svg(`mods/workspace-chrome/${icon}.svg`).size(8).text_color("#000000a6")))));
}
