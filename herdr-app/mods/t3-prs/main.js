// Your open pull requests on GitHub (through `gh`), in Ready and Draft groups, each with its
// CI state. A click opens the pull request in the browser. Refreshes every 5 seconds.
// Keys (tmux-keys sends them while the sidebar lists show): `t3-prs.down` past the last space
// takes the keyboard into this list, `t3-prs.up` from its first row gives it back to the pane.
// In the list: Enter opens, Esc leaves. Right-click an open row: copy it for Slack (the `slackpr`
// zsh function), move it to Ready or to Draft (`gh pr ready`, `--undo`: only the draft state
// changes), or close it (asks first; the confirm dialog sends `t3-prs.close`).
// Approval: a green check after the number when the code owners of every changed file approved
// (owners.js, against the base branch's CODEOWNERS and team members) and GitHub's review decision
// agrees; amber when someone approved but that isn't enough yet. The tooltip says who or what.
// Ready to merge (not a draft, approved, checks passed or none): the row has a steady green frame.
// It does not pulse, so it does not look like a space with a finished agent.
// Comments: a speech bubble with the count of comments people (not bots) left (comments.js).
// Blue when some came after your last comment and after you last opened the PR from this list;
// dim when you saw them all. Opening the PR (click or Enter) marks them seen.
// Merged: your last 20 merged pull requests (not closed ones), newest merge first, with the merge
// time in Eastern time. The same query fetches them, so a poll stays one call (cost 1 point).
// Headers fold their group on a click or `t3-prs.fold:<ready|draft|merged>`; folds are kept.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, spaces, focused, nextCommand, notify, openOverlay, closeOverlay } from "herdr";
import { checkCodeOwners } from "./owners.js";
import { fetchComments, summarize } from "./comments.js";

const EVERY = 5000;
const QUERY = `{ viewer { pullRequests(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
  nodes { number title isDraft url headRefOid baseRefName reviewDecision updatedAt author { login } repository { name nameWithOwner }
    latestReviews(first: 20) { nodes { state author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
  merged: pullRequests(states: MERGED, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url mergedAt repository { name } } } } }`;

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
// The frame of a pull request that is ready to merge.
const READY = "#4ade80";

// Mods have no Intl, and Date only knows the computer's own zone: work out US Eastern by hand.
// Daylight time runs from the second Sunday of March, 2 AM (07:00 UTC), to the first Sunday of
// November, 2 AM (06:00 UTC). Returns a Date whose UTC fields read as Eastern wall time.
function eastern(ms) {
  const y = new Date(ms).getUTCFullYear();
  const sunday = (month, n) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + 7 * (n - 1);
  const daylight = ms >= Date.UTC(y, 2, sunday(2, 2), 7) && ms < Date.UTC(y, 10, sunday(10, 1), 6);
  return new Date(ms - (daylight ? 4 : 5) * 3600_000);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2:18 PM" for a merge today (Eastern), else "Nov 10, 2:18 PM".
function mergedAt(iso, now = Date.now()) {
  const d = eastern(Date.parse(iso));
  const today = eastern(now);
  const h = d.getUTCHours();
  const time = `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const same = d.getUTCFullYear() === today.getUTCFullYear() && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate();
  return same ? time : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`;
}

export default class PullRequests extends View {
  init(_props, cx) {
    // The right-click menu is this mod as a popup: it only draws.
    if (props()?.menu) return;
    this.prs = JSON.parse(localStorage.getItem("prs") ?? "null");
    this.merged = JSON.parse(localStorage.getItem("merged") ?? "null");
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
        else if (c.startsWith("ready:")) await this.setDraft(c.slice(6), false, cx);
        else if (c.startsWith("draft:")) await this.setDraft(c.slice(6), true, cx);
        else if (c.startsWith("fold:")) this.fold(c.slice(5));
        cx.notify();
      }
    });
  }

  // The pull requests in the order they show (folded groups skipped).
  visible() {
    const prs = this.prs ?? [];
    return [
      ...prs.filter((p) => !p.draft && !this.folded.ready),
      ...prs.filter((p) => p.draft && !this.folded.draft),
      ...(this.folded.merged ? [] : this.merged ?? []),
    ];
  }

  fold(id) {
    this.folded[id] = !this.folded[id];
    localStorage.setItem("folded", JSON.stringify(this.folded));
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

  // A click, not part of the poll: one `gh pr ready` call, then a poll at once moves the row.
  async setDraft(url, draft, cx) {
    const p = (this.prs ?? []).find((q) => q.url === url);
    const what = draft ? "Move to Draft" : "Move to Ready";
    if (!p) return notify({ title: `${what} failed`, body: `Not in the list any more: ${url}`, level: "error" });
    const r = await exec("gh", ["pr", "ready", String(p.number), "-R", p.fullRepo, ...(draft ? ["--undo"] : [])]);
    if (r.code === 0) notify({ title: draft ? "Moved to Draft" : "Moved to Ready", body: `${p.repo} #${p.number}`, level: "success" });
    else notify({ title: `${what} failed`, body: (r.stderr || r.stdout).trim() || `gh exited with ${r.code}`, level: "error" });
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
    const before = JSON.stringify([this.prs, this.merged, this.error]);
    try {
      const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`]);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
      const viewer = JSON.parse(r.stdout).data.viewer;
      this.merged = viewer.merged.nodes
        .map((p) => ({ number: p.number, title: p.title, url: p.url, repo: p.repository.name, mergedAt: p.mergedAt }))
        .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
      this.prs = viewer.pullRequests.nodes.map((p) => ({
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
    const changed = JSON.stringify([this.prs, this.merged, this.error]) !== before;
    if (changed && !this.error) {
      localStorage.setItem("prs", JSON.stringify(this.prs));
      localStorage.setItem("merged", JSON.stringify(this.merged));
    }
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

  // Opening an open pull request from this list marks its comments seen.
  open(url) {
    if ((this.prs ?? []).some((p) => p.url === url)) {
      this.seen[url] = new Date().toISOString();
      localStorage.setItem("seen", JSON.stringify(this.seen));
    }
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
    const ready = !p.draft && review?.state === "approved" && (p.ci === "passed" || p.ci == null);
    const talk = this.talk(p);
    const tip = [`${p.repo} #${p.number}: ${p.title}`, ready ? "Ready to merge" : null, review?.text, talk?.text].filter(Boolean).join("\n");
    return h_flex()
      .relative()
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
      // Selected (the keyboard row) and hover: as the Spaces rows (t3-spaces).
      .border(1).border_color("#00000000")
      // Bright green, with a soft ring outside the edge for the glow. Not the theme's ansi2: it is a
      // dull yellow-green. The keyboard row keeps its accent.
      .when(ready && !on, (el) => el.my(4).bg(READY + "33").border_color(READY)
        .child(div().absolute().inset(-3).rounded(11).border(2).border_color(READY + "59")))
      .when(on, (el) => el.bg(t.accent + "8c").border_color(t.accent))
      .when(!on && !ready, (el) => el.hover((s) => s.bg(t.foreground + "40").border_color(t.foreground + "59")))
      .when(!on && ready, (el) => el.hover((s) => s.bg(READY + "4d")))
      .on_click((_e, cx) => { this.open(p.url); cx.notify(); })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "t3-prs", kind: "popup", width: 220, height: 120, props: { menu: p } });
      })
      .child(this.mark(t, p.ci))
      .child(div().flex_none().text_color(on ? t.muted : t.dim).child(`#${p.number}`))
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

  // A merged pull request: read only, so no right-click menu.
  mergedRow(t, p) {
    const on = this.active() && this.cursor === p.url;
    const when = mergedAt(p.mergedAt);
    return h_flex()
      .id(`merged-${p.repo}-${p.number}`)
      .w_full().min_w(0)
      .px(8)
      .h(30)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(8)
      .role("button").accessibility_label(`${p.repo} #${p.number} ${p.title}, merged ${when}`)
      .tooltip(`${p.repo} #${p.number}: ${p.title}\nMerged ${when} ET`)
      .border(1).border_color("#00000000")
      .when(on, (el) => el.bg(t.accent + "8c").border_color(t.accent))
      .when(!on, (el) => el.hover((s) => s.bg(t.foreground + "40").border_color(t.foreground + "59")))
      .on_click((_e, cx) => { this.open(p.url); cx.notify(); })
      .child(h_flex().size(18).flex_none().items_center().justify_center().accessibility_label("Merged")
        .child(svg("mods/t3-prs/pr-merged.svg").size(13).text_color(t.ansi5)))
      .child(div().flex_none().text_color(on ? t.muted : t.dim).child(`#${p.number}`))
      .child(div().min_w(0).truncate().text_color(t.muted).child(p.title))
      .child(div().flex_1().flex_shrink(1000).min_w(0).truncate().text_size(12).text_color(t.dim).child(p.repo))
      .child(div().flex_none().text_size(12).text_color(t.dim).child(when));
  }

  header(t, id, label, count, first) {
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
      // The cx from the click's own arguments: render()'s cx is no longer valid by the time
      // anyone clicks, and using it throws before the redraw is asked for.
      .on_click((_e, cx) => {
        this.fold(id);
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
      // Only the move that applies; the main copy runs it, so its list polls again.
      .child(p.draft
        ? item("ready", "pr-ready", "Move to Ready", t.foreground, () => run(`t3-prs.ready:${p.url}`))
        : item("draft", "pr-draft", "Move to Draft", t.foreground, () => run(`t3-prs.draft:${p.url}`)))
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
      { id: "ready", label: "Ready", members: prs.filter((p) => !p.draft), row: (p) => this.row(t, p) },
      { id: "draft", label: "Draft", members: prs.filter((p) => p.draft), row: (p) => this.row(t, p) },
      { id: "merged", label: "Merged", members: this.merged ?? [], row: (p) => this.mergedRow(t, p) },
    ].filter((g) => g.members.length);
    const rows = groups.flatMap((g, i) => [
      this.header(t, g.id, g.label, g.members.length, i === 0),
      ...(this.folded[g.id] ? [] : g.members.map(g.row)),
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
