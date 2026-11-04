// How notifications look: outside the app. Each notify() goes to scripts/herdr-alert.sh, which has
// peon-ping draw it with the Herdr overlay above the Herdr window, and this in-app toast closes.
// A click on the alert brings Herdr forward and runs the toast's action (e.g. go to the agent).
// If the alert can't be sent, the toast shows in the app as Herdr's own does.
// Installed over the shipped mods/toast/main.js by mods/tmux-keys (Herdr restores shipped mods at
// each start); the source of truth is scripts/toast-external.js.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, exec, appHome, agents, shared } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

// The wizard of the space the toast's agent is in, as t3-spaces draws it.
function wizardFor(p) {
  const terminal = p.action?.args?.terminal;
  const space = terminal && agents().find((a) => a.address === terminal)?.space;
  const n = space != null ? (shared("space.wizards") ?? {})[space] : null;
  return n != null ? `${appHome()}/mods/t3-spaces/wizards/${String(n).padStart(3, "0")}.png` : "";
}

export default class Toast extends View {
  init(_props, cx) {
    this.inApp = false;
    const p = props() ?? {};
    const t = theme();
    const colors = { background: t.chrome, foreground: t.foreground, muted: t.muted, dim: t.dim,
      border: t.border, accent: t.accent, done: t.ansi2, blocked: t.blocked, error: t.ansi1 };
    cx.spawn(async (cx) => {
      try {
        const r = await exec(`${appHome()}/scripts/herdr-alert.sh`, [p.title ?? "", p.body ?? "",
          p.level ?? "info", wizardFor(p), p.action?.name ? JSON.stringify(p.action) : "", JSON.stringify(colors)]);
        if (r.code === 0) return closeOverlay(p.overlay);
      } catch (e) {
        // Fall through to the in-app toast.
      }
      this.inApp = true;
      cx.notify();
    });
  }

  render(cx) {
    if (!this.inApp) return div().size_full();
    const t = theme();
    const p = props() ?? {};
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? ""))),
      );
  }
}
