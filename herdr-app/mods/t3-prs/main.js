// Your open pull requests on GitHub (through `gh`), in Ready and Draft groups, each with its
// CI state. A click opens the pull request in the browser. Refreshes every 5 seconds.
// Keys (tmux-keys sends them while the sidebar lists show): `t3-prs.down` past the last space
// takes the keyboard into this list, `t3-prs.up` from its first row gives it back to the pane.
// In the list: Enter opens, Esc leaves. Right-click a row: copy it for Slack (the `slackpr` zsh
// function), or close it (asks first; the confirm dialog sends `t3-prs.close`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, spaces, focused, nextCommand, notify, openOverlay, closeOverlay } from "herdr";

const EVERY = 5000;
const QUERY = `{ viewer { pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title isDraft url repository { name }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

// statusCheckRollup.state: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, or none (no checks).
const CI = { SUCCESS: "passed", FAILURE: "failed", ERROR: "failed", PENDING: "running", EXPECTED: "running" };

export default class PullRequests extends View {
  init(_props, cx) {
    // The right-click menu is this mod as a popup: it only draws.
    if (props()?.menu) return;
    this.prs = JSON.parse(localStorage.getItem("prs") ?? "null");
    this.error = null;
    this.loading = false;
    this.manual = false;
    this.folded = JSON.parse(localStorage.getItem("folded") ?? "{}");
    // The keyboard row: a pull request's url, while this list holds the keyboard; `back` is the
    // pane that had it before.
    this.handle = cx.focus_handle();
    this.cursor = null;
    this.back = null;
    cx.spawn(async (cx) => {
      for (;;) {
        await this.load(cx);
        await cx.sleep(EVERY);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "down") this.down();
        else if (c === "up") this.up();
        else if (c.startsWith("close:")) await this.close(c.slice(6), cx);
        cx.notify();
      }
    });
  }

  // The pull requests in the order they show (folded groups skipped).
  visible() {
    const prs = this.prs ?? [];
    return [...prs.filter((p) => !p.draft && !this.folded.ready), ...prs.filter((p) => p.draft && !this.folded.draft)];
  }

  active() {
    return this.cursor != null && this.handle.is_focused();
  }

  down() {
    const list = this.visible();
    if (this.active()) {
      const i = list.findIndex((p) => p.url === this.cursor);
      this.cursor = (list[i + 1] ?? list[i] ?? list[0])?.url ?? null;
      return;
    }
    this.cursor = null;
    const sp = spaces();
    if (list.length && sp.findIndex((s) => s.active) === sp.length - 1) {
      this.back = focused()?.pane ?? null;
      this.cursor = list[0].url;
      this.handle.focus();
    } else {
      run("space.next");
    }
  }

  up() {
    if (!this.active()) {
      this.cursor = null;
      return run("space.prev");
    }
    const list = this.visible();
    const i = list.findIndex((p) => p.url === this.cursor);
    if (i <= 0) this.leave();
    else this.cursor = list[i - 1].url;
  }

  leave() {
    this.cursor = null;
    if (this.back) run("pane.focus", { pane: this.back });
    this.back = null;
  }

  async close(url, cx) {
    const r = await exec("gh", ["pr", "close", url]);
    if (r.code === 0) notify({ title: "Pull request closed", body: url, level: "success" });
    else notify({ title: "Could not close the pull request", body: (r.stderr || r.stdout).trim(), level: "error" });
    await this.load(cx, true);
  }

  // A poll redraws only when something changed, so the CI spinners keep turning undisturbed.
  // Only a click on refresh turns the refresh icon.
  async load(cx, manual = false) {
    if (manual) {
      this.manual = true;
      cx.notify();
    }
    if (this.loading) return;
    this.loading = true;
    const before = JSON.stringify([this.prs, this.error]);
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
      this.prs = JSON.parse(r.stdout).data.viewer.pullRequests.nodes.map((p) => ({
        number: p.number,
        title: p.title,
        draft: p.isDraft,
        url: p.url,
        repo: p.repository.name,
        ci: CI[p.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? null,
      }));
      this.error = null;
    } catch (e) {
      this.error = String(e.message ?? e);
    }
    this.loading = false;
    const changed = JSON.stringify([this.prs, this.error]) !== before;
    if (changed && !this.error) localStorage.setItem("prs", JSON.stringify(this.prs));
    if (changed || this.manual) {
      this.manual = false;
      cx.notify();
    }
  }

  mark(t, ci) {
    const box = h_flex().size(18).flex_none().items_center().justify_center();
    if (ci === "running") return box.accessibility_label("Checks running")
      .child(svg("mods/t3-prs/spinner.svg").size(12).text_color(t.ansi3).spin(1800));
    if (ci === "passed") return box.accessibility_label("Checks passed")
      .child(svg("mods/workspace-chrome/check.svg").size(14).text_color(t.ansi2));
    if (ci === "failed") return box.accessibility_label("Checks failed")
      .child(svg("mods/workspace-chrome/x.svg").size(14).text_color(t.ansi1));
    return box.accessibility_label("No checks").child(div().size(7).rounded_full().border(1.5).border_color(t.dim));
  }

  row(t, p) {
    const on = this.active() && this.cursor === p.url;
    return h_flex()
      .id(`pr-${p.repo}-${p.number}`)
      .w_full().min_w(0)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .role("button").accessibility_label(`${p.repo} #${p.number} ${p.title}`)
      .tooltip(`${p.repo} #${p.number}: ${p.title}`)
      .when(on, (el) => el.bg(t.selected).border(1).border_color(t.accent))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => exec("open", [p.url]).catch(() => null))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "t3-prs", kind: "popup", width: 220, height: 90, props: { menu: p } });
      })
      .child(this.mark(t, p.ci))
      .child(div().flex_none().text_color(t.dim).child(`#${p.number}`))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(p.title))
      .child(div().flex_1().flex_shrink(1000).min_w(0).truncate().text_size(12).text_color(t.dim).child(p.repo));
  }

  header(t, id, label, count, first, cx) {
    const open = !this.folded[id];
    return h_flex()
      .id(id)
      .px(8)
      .when(!first, (el) => el.pt(8))
      .h(first ? 22 : 30)
      .flex_none()
      .gap(4)
      .items_center()
      .text_size(11)
      .font_medium()
      .on_click(() => {
        this.folded[id] = open;
        localStorage.setItem("folded", JSON.stringify(this.folded));
        cx.notify();
      })
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none().text_color(t.dim)));
  }

  // The right-click menu of one pull request (props().menu).
  menu(t, p) {
    const item = (id, icon, label, color, action) => h_flex()
      .id(id).h(30).px(8).gap(8).rounded(8).items_center()
      .text_color(color).hover((s) => s.bg(t.hover))
      .on_click(() => { closeOverlay(props().overlay); action(); })
      .child(svg(`mods/t3-prs/${icon}.svg`).size(14).flex_none())
      .child(div().flex_1().child(label));
    return v_flex().w_full().p(4).bg(t.popover).text_size(13)
      .child(item("copy", "copy", "Copy for Slack", t.foreground, async () => {
        // -i: slackpr is a function in ~/.zshrc; it copies "[`repo`] title: url" itself.
        const r = await exec("zsh", ["-ic", 'slackpr "$1"', "zsh", p.url]);
        const text = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.includes(p.url));
        if (r.code === 0 && text) notify({ title: "Copied for Slack", body: text, level: "success" });
        else notify({ title: "slackpr failed", body: (r.stderr || r.stdout).trim(), level: "error" });
      }))
      .child(item("close", "pr-closed", "Close pull request…", t.ansi1, () => openOverlay({
        mod: "confirm", kind: "dialog", width: 420, height: 170,
        props: { title: "Close pull request?", detail: `${p.repo} #${p.number}: ${p.title}`, command: { name: `t3-prs.close:${p.url}` } },
      })));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menu(t, props().menu);
    const prs = this.prs ?? [];
    const groups = [
      { id: "ready", label: "Ready", members: prs.filter((p) => !p.draft) },
      { id: "draft", label: "Draft", members: prs.filter((p) => p.draft) },
    ].filter((g) => g.members.length);
    const rows = groups.flatMap((g, i) => [
      this.header(t, g.id, g.label, g.members.length, i === 0, cx),
      ...(this.folded[g.id] ? [] : g.members.map((p) => this.row(t, p))),
    ]);
    const note = this.error ? `Could not load pull requests: ${this.error}`
      : this.prs == null ? "Loading pull requests…"
      : prs.length === 0 ? "No open pull requests." : null;

    return v_flex()
      .id("t3-prs-root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (!this.active()) return;
        if (e.key === "enter") exec("open", [this.cursor]).catch(() => null);
        else if (e.key === "escape") this.leave();
        else if (e.key === "down") this.down();
        else if (e.key === "up") this.up();
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .child(h_flex()
        .id("prs-heading")
        .pl(16).pr(10)
        .h(31)
        .flex_none()
        .items_center()
        .justify_between()
        .child(div().text_size(12).font_medium().text_color(t.muted).child("Pull requests"))
        .child(div()
          .id("prs-refresh")
          .size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .role("button").accessibility_label("Refresh pull requests")
          .text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.load(cx, true); })
          .child(svg("mods/t3-prs/refresh.svg").size(13).when(this.manual, (el) => el.spin(900)))))
      .when(Boolean(note), (el) => el.child(div().px(16).pb(4).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(note)))
      .child(v_flex().id("prs-list").flex_1().min_h(0).px(8).overflow_y_scroll().children(rows));
  }
}
