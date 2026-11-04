// Your open pull requests on GitHub (through `gh`), in Ready and Draft groups, each with its
// CI state. A click opens the pull request in the browser. Refreshes every 5 seconds.
// Keys (tmux-keys sends them while the sidebar lists show): `t3-prs.down` past the last space
// takes the keyboard into this list, `t3-prs.up` from its first row gives it back to the pane.
// In the list: Enter opens, Esc leaves. Right-click a row: copy it for Slack (the `slackpr` zsh
// function), or close it (asks first; the confirm dialog sends `t3-prs.close`).
// Approval: a green check after the number when the code owners of every changed file approved
// (owners.js, against the base branch's CODEOWNERS and team members) and GitHub's review decision
// agrees; amber when someone approved but that isn't enough yet. The tooltip says who or what.
// Comments: a speech bubble with the count of comments people (not bots) left (comments.js).
// Blue when some came after your last comment and after you last opened the PR from this list;
// dim when you saw them all. Opening the PR (click or Enter) marks them seen.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, spaces, focused, nextCommand, notify, openOverlay, closeOverlay } from "herdr";
import { checkCodeOwners } from "./owners.js";
import { fetchComments, summarize } from "./comments.js";

const EVERY = 5000;
const QUERY = `{ viewer { pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title isDraft url headRefOid baseRefName reviewDecision updatedAt author { login } repository { name nameWithOwner }
    latestReviews(first: 20) { nodes { state author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;

// GitHub GraphQL through gh: `data`, or an error with gh's message.
async function gql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
  return JSON.parse(r.stdout).data;
}

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
    // url -> { key, result } of the last code owner check (see checkApprovals).
    this.approvals = new Map();
    // url -> { key, list } of people's comments (see checkComments); url -> ISO time of the last open.
    this.comments = new Map();
    this.seen = JSON.parse(localStorage.getItem("seen") ?? "{}");
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
        fullRepo: p.repository.nameWithOwner,
        base: p.baseRefName,
        head: p.headRefOid,
        updated: p.updatedAt,
        author: p.author?.login ?? "",
        decision: p.reviewDecision,
        reviews: p.latestReviews.nodes.filter((v) => v.author).map((v) => ({ login: v.author.login, state: v.state })),
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
    if (!this.error) await this.checkApprovals(cx);
    if (!this.error) await this.checkComments(cx);
  }

  // Reads a pull request's comments again only when GitHub's updatedAt for it changed.
  async checkComments(cx) {
    let changed = false;
    for (const p of this.prs ?? []) {
      if (this.comments.get(p.url)?.key === p.updated) continue;
      try {
        this.comments.set(p.url, { key: p.updated, list: await fetchComments(gql, p.fullRepo, p.number, p.author) });
        changed = true;
      } catch (e) {
        // Keep the last list; the next change of updatedAt tries again.
      }
    }
    if (changed) cx.notify();
  }

  // Opening a pull request from this list marks its comments seen.
  open(url) {
    this.seen[url] = new Date().toISOString();
    localStorage.setItem("seen", JSON.stringify(this.seen));
    exec("open", [url]).catch(() => null);
  }

  // { count, fresh, text } of people's comments, or null when there are none.
  talk(p) {
    const list = this.comments.get(p.url)?.list;
    if (!list) return null;
    const s = summarize(list, this.seen[p.url]);
    if (!s.count) return null;
    const who = s.by.map(([login, n]) => `${login} (${n})`).join(", ");
    return { ...s, text: `Comments: ${who}${s.fresh ? `; ${s.fresh} new` : ""}` };
  }

  // Runs the code owner check for each pull request with an approval, again only when its head
  // commit, base, reviews or review decision changed (owners.js keeps team members 30 minutes).
  async checkApprovals(cx) {
    let changed = false;
    for (const p of this.prs ?? []) {
      const approvers = (p.reviews ?? []).filter((v) => v.state === "APPROVED" && v.login !== p.author);
      if (!approvers.length) continue;
      const key = JSON.stringify([p.head, p.base, p.decision, p.reviews]);
      if (this.approvals.get(p.url)?.key === key) continue;
      let result;
      try {
        result = await checkCodeOwners(gql, { repo: p.fullRepo, number: p.number, base: p.base, author: p.author, reviews: p.reviews });
      } catch (e) {
        result = { error: String(e.message ?? e) };
      }
      this.approvals.set(p.url, { key, result });
      changed = true;
    }
    if (changed) cx.notify();
  }

  // "approved", "partial" or null, with the words for the tooltip.
  approval(p) {
    const approvers = (p.reviews ?? []).filter((v) => v.state === "APPROVED" && v.login !== p.author).map((v) => v.login);
    if (!approvers.length) return null;
    const blockers = (p.reviews ?? []).filter((v) => v.state === "CHANGES_REQUESTED").map((v) => v.login);
    if (blockers.length) return { state: "partial", text: `Changes requested by ${blockers.join(", ")}` };
    const r = this.approvals.get(p.url)?.result;
    if (!r) return null;
    if (r.error) return { state: "partial", text: `Approved by ${approvers.join(", ")}; can't check code owners: ${r.error}` };
    if (!r.ok) {
      const wait = r.missing.map((s) => s.owners.join(" or ")).join("; ");
      return { state: "partial", text: `Approved by ${approvers.join(", ")}; waiting for ${wait}` };
    }
    if (p.decision === "REVIEW_REQUIRED" || p.decision === "CHANGES_REQUESTED")
      return { state: "partial", text: `Code owners approved (${approvers.join(", ")}); GitHub still needs more reviews` };
    return { state: "approved", text: `Approved by code owners: ${approvers.join(", ")}` };
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
    const review = this.approval(p);
    const talk = this.talk(p);
    const tip = [`${p.repo} #${p.number}: ${p.title}`, review?.text, talk?.text].filter(Boolean).join("\n");
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
      .tooltip(tip)
      .when(on, (el) => el.bg(t.selected).border(1).border_color(t.accent))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.open(p.url); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "t3-prs", kind: "popup", width: 220, height: 90, props: { menu: p } });
      })
      .child(this.mark(t, p.ci))
      .child(div().flex_none().text_color(t.dim).child(`#${p.number}`))
      // Shape tells them apart: the theme's green and yellow are close. Approved: a green check;
      // not yet: a yellow clock.
      .when(Boolean(review), (el) => el.child(svg(`mods/workspace-chrome/${review.state === "approved" ? "circle-check" : "clock"}.svg`)
        .size(13).flex_none().text_color(review.state === "approved" ? t.ansi2 : t.ansi3).accessibility_label(review.text)))
      .when(Boolean(talk), (el) => el.child(h_flex().flex_none().gap(2).items_center()
        .text_size(11).text_color(talk.fresh ? t.accent : t.dim).accessibility_label(talk.text)
        .child(svg("mods/t3-prs/message.svg").size(12).flex_none())
        .child(div().child(String(talk.fresh || talk.count)))))
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
        if (e.key === "enter") this.open(this.cursor);
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
