// Your open pull requests on GitHub (through `gh`), in Ready and Draft groups, each with its
// CI state. A click opens the pull request in the browser. Refreshes every 5 seconds.
// Keys (tmux-keys sends them while the sidebar lists show): `t3-prs.down` past the last space
// takes the keyboard into this list, `t3-prs.up` from its first row gives it back to the pane.
// In the list: Enter opens, Esc leaves. Right-click a row: copy it for Slack (the `slackpr` zsh
// function), move it to Ready or to Draft (`gh pr ready`, `--undo`: only the draft state
// changes), merge it when it is ready (asks first), or close it (asks first; the confirm dialog
// sends `t3-prs.close`).
// Merge shows only on the conditions of the orchestrator's PR-ready notice: not a draft, approved,
// mergeable, and mergeStateStatus CLEAN or HAS_HOOKS. It uses the first method the repo permits
// (squash, merge commit, rebase), with --match-head-commit, so a push after the poll stops it.
// Approval: a green check after the number when the code owners of every changed file approved
// (owners.js, against the base branch's CODEOWNERS and team members) and GitHub's review decision
// agrees; amber when someone approved but that isn't enough yet. The tooltip says who or what.
// Ready to merge (not a draft, approved, checks passed or none): the row has a steady green frame.
// It does not pulse, so it does not look like a space with a finished agent.
// Comments: a speech bubble with the count of comments people (not bots) left (comments.js).
// Blue when some came after your last comment and after you last opened the PR from this list;
// dim when you saw them all. Opening the PR (click or Enter) marks them seen.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, props, run, spaces, focused, nextCommand, notify, openOverlay, closeOverlay } from "herdr";
import { checkCodeOwners } from "./owners.js";
import { fetchComments, summarize } from "./comments.js";

const EVERY = 5000;

// Windows: gh runs in WSL (machine "wsl"), where it is signed in to GitHub.
const GH_ON = "wsl";
// `account`: null for gh's active account, else another account gh is signed in to. Its token
// goes from `gh auth token` straight into that one gh process in WSL; the mod never sees it.
const gh = (args, account = null) => account
  ? exec("sh", ["-c", 't="$(gh auth token --user "$1")" || exit 1; export GH_TOKEN="$t"; shift; exec gh "$@"', "sh", account, ...args], { on: GH_ON })
  : exec("gh", args, { on: GH_ON });

// A PowerShell script as -EncodedCommand wants it: base64 of its UTF-16LE bytes.
function encodePs(script) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = [];
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i);
    bytes.push(c & 0xff, c >> 8);
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
    out += i + 1 < bytes.length ? A[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? A[n & 63] : "=";
  }
  return out;
}
// Your open pull requests from every account gh is signed in to. The active account: only repos
// it owns (`user:<you>`; an organization's IP allow list can refuse this machine). Each other
// account (a work account, say): its pull requests in any repo it can see, organizations too.
// The accounts come from `gh auth status`, so no account names live in this public repo.
const QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) {
  nodes { ... on PullRequest { number title isDraft url headRefOid baseRefName reviewDecision mergeable mergeStateStatus updatedAt author { login } repository { name nameWithOwner }
    latestReviews(first: 20) { nodes { state author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
let LOGIN = null;
async function accounts() {
  LOGIN ??= (await gql("{ viewer { login } }")).viewer.login;
  const r = await gh(["auth", "status", "--hostname", "github.com"]);
  const others = [...`${r.stdout}\n${r.stderr}`.matchAll(/account ([A-Za-z0-9-]+)/g)].map((m) => m[1]).filter((a) => a !== LOGIN);
  return [
    { account: null, q: `is:pr is:open archived:false author:${LOGIN} user:${LOGIN} sort:updated-desc` },
    ...[...new Set(others)].map((a) => ({ account: a, q: `is:pr is:open archived:false author:${a} sort:updated-desc` })),
  ];
}

// GitHub GraphQL through gh (as `account`, see gh): `data`, or an error with gh's message.
async function gql(query, vars = {}, account = null) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const r = await gh(args, account);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
  return JSON.parse(r.stdout).data;
}

// statusCheckRollup.state: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED, or none (no checks).
const CI = { SUCCESS: "passed", FAILURE: "failed", ERROR: "failed", PENDING: "running", EXPECTED: "running" };
// The frame of a pull request that is ready to merge.
const READY = "#4ade80";

// The orchestrator's PR-ready conditions (herdr-pr-ready.ts): required checks passed, no conflicts.
const MERGE_STATES = { CLEAN: true, HAS_HOOKS: true };
const mergeReady = (p) => !p.draft && p.decision === "APPROVED" && p.mergeable === "MERGEABLE" && MERGE_STATES[p.mergeState] === true;
// Merge methods in the order to use them, as `gh repo view --json` names them and `gh pr merge` takes them.
const METHODS = [["squashMergeAllowed", "squash", "Squash merge"], ["mergeCommitAllowed", "merge", "Merge commit"], ["rebaseMergeAllowed", "rebase", "Rebase merge"]];

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
    // repo -> { flag, label } of its merge method (see mergeMethod), for as long as this copy runs.
    this.methods = new Map();
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
        else if (c.startsWith("ask-merge:")) await this.askMerge(c.slice(10));
        else if (c.startsWith("merge:")) {
          const [head, ...url] = c.slice(6).split(":");
          await this.merge(head, url.join(":"), cx);
        }
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
    const account = (this.prs ?? []).find((q) => q.url === url)?.account ?? null;
    const r = await gh(["pr", "close", url], account);
    if (r.code === 0) notify({ title: "Pull request closed", body: url, level: "success" });
    else notify({ title: "Could not close the pull request", body: (r.stderr || r.stdout).trim(), level: "error" });
    await this.load(cx, true);
  }

  // A click, not part of the poll: one `gh pr ready` call, then a poll at once moves the row.
  async setDraft(url, draft, cx) {
    const p = (this.prs ?? []).find((q) => q.url === url);
    const what = draft ? "Move to Draft" : "Move to Ready";
    if (!p) return notify({ title: `${what} failed`, body: `Not in the list any more: ${url}`, level: "error" });
    const r = await gh(["pr", "ready", String(p.number), "-R", p.fullRepo, ...(draft ? ["--undo"] : [])], p.account);
    if (r.code === 0) notify({ title: draft ? "Moved to Draft" : "Moved to Ready", body: `${p.repo} #${p.number}`, level: "success" });
    else notify({ title: `${what} failed`, body: (r.stderr || r.stdout).trim() || `gh exited with ${r.code}`, level: "error" });
    await this.load(cx, true);
  }

  // The first merge method the repo permits, read once per repo.
  async mergeMethod(repo, account = null) {
    if (!this.methods.has(repo)) {
      const r = await gh(["repo", "view", repo, "--json", METHODS.map((m) => m[0]).join(",")], account);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `gh exited with ${r.code}`);
      const allowed = JSON.parse(r.stdout);
      const m = METHODS.find(([key]) => allowed[key]);
      if (!m) throw new Error(`${repo} permits no merge method`);
      this.methods.set(repo, { flag: m[1], label: m[2] });
    }
    return this.methods.get(repo);
  }

  // Merge is a click on a ready row; the dialog names the method and the head commit it merges.
  async askMerge(url) {
    const p = (this.prs ?? []).find((q) => q.url === url);
    if (!p || !mergeReady(p)) return notify({ title: "Merge stopped", body: `Not ready to merge any more: ${url}`, level: "error" });
    let method;
    try {
      method = await this.mergeMethod(p.fullRepo, p.account);
    } catch (e) {
      return notify({ title: "Merge failed", body: String(e.message ?? e), level: "error" });
    }
    openOverlay({
      mod: "confirm", kind: "dialog", width: 460, height: 190,
      props: {
        title: `Merge ${p.fullRepo}#${p.number}: ${p.title}?`,
        detail: `${method.label} into ${p.base}, at commit ${p.head.slice(0, 7)}. A push after this stops the merge.`,
        command: { name: `t3-prs.merge:${p.head}:${p.url}` },
      },
    });
  }

  // The confirmed merge. `head` is the commit the dialog named: gh refuses when the branch moved.
  async merge(head, url, cx) {
    const p = (this.prs ?? []).find((q) => q.url === url);
    const name = p ? `${p.fullRepo}#${p.number}` : url;
    let body = null;
    if (!p || !mergeReady(p)) body = `Not ready to merge any more: ${name}`;
    else if (p.head !== head) body = `New commits on ${name} since the confirmation; open the menu again`;
    if (body) return notify({ title: "Merge stopped", body, level: "error" });
    try {
      const method = await this.mergeMethod(p.fullRepo, p.account);
      const r = await gh(["pr", "merge", String(p.number), "-R", p.fullRepo, `--${method.flag}`, "--match-head-commit", head], p.account);
      if (r.code === 0) notify({ title: "Merged", body: name, level: "success" });
      else notify({ title: "Merge failed", body: (r.stderr || r.stdout).trim() || `gh exited with ${r.code}`, level: "error" });
    } catch (e) {
      notify({ title: "Merge failed", body: String(e.message ?? e), level: "error" });
    }
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
      const found = new Map();
      const failed = [];
      for (const { account, q } of await accounts()) {
        try {
          const data = await gql(QUERY, { q }, account);
          for (const p of data.search.nodes.filter((p) => p?.url)) found.set(p.url, { ...p, account });
        } catch (e) {
          failed.push(`${account ?? LOGIN}: ${String(e.message ?? e)}`);
        }
      }
      // One list across the accounts, most recently updated first, as each search sorts.
      this.prs = [...found.values()].sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)).map((p) => ({
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
        account: p.account,
        decision: p.reviewDecision,
        mergeable: p.mergeable,
        mergeState: p.mergeStateStatus,
        reviews: p.latestReviews.nodes.filter((v) => v.author).map((v) => ({ login: v.author.login, state: v.state })),
        ci: CI[p.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? null,
      }));
      // An account that failed says so; the others' pull requests still show.
      this.error = failed.length ? failed.join("; ") : null;
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
    if (this.prs) await this.checkApprovals(cx);
    if (this.prs) await this.checkComments(cx);
  }

  // Reads a pull request's comments again only when GitHub's updatedAt for it changed.
  async checkComments(cx) {
    let changed = false;
    for (const p of this.prs ?? []) {
      if (this.comments.get(p.url)?.key === p.updated) continue;
      try {
        this.comments.set(p.url, { key: p.updated, list: await fetchComments((q, v) => gql(q, v, p.account), p.fullRepo, p.number, p.author) });
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
    // Windows: the default browser (macOS used `open`).
    exec("rundll32", ["url.dll,FileProtocolHandler", url]).catch(() => null);
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
        result = await checkCodeOwners((q, v) => gql(q, v, p.account), { repo: p.fullRepo, number: p.number, base: p.base, author: p.author, reviews: p.reviews });
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
        openOverlay({ mod: "t3-prs", kind: "popup", width: 220, height: mergeReady(p) ? 150 : 120, props: { menu: p } });
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
        // Windows: what ~/.zshrc's slackpr copies on macOS, "[`repo`] title: url", put on the
        // clipboard by PowerShell. -EncodedCommand keeps quotes in titles out of argument quoting.
        const text = `[\`${p.repo}\`] ${p.title}: ${p.url}`;
        const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
          encodePs(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`)]);
        if (r.code === 0) notify({ title: "Copied for Slack", body: text, level: "success" });
        else notify({ title: "Copy for Slack failed", body: (r.stderr || r.stdout).trim(), level: "error" });
      }))
      // Only the move that applies; the main copy runs it, so its list polls again.
      .child(p.draft
        ? item("ready", "pr-ready", "Move to Ready", t.foreground, () => run(`t3-prs.ready:${p.url}`))
        : item("draft", "pr-draft", "Move to Draft", t.foreground, () => run(`t3-prs.draft:${p.url}`)))
      // The main copy reads the merge method and asks to confirm.
      .when(mergeReady(p), (el) => el.child(item("merge", "pr-merged", "Merge…", t.foreground, () => run(`t3-prs.ask-merge:${p.url}`))))
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
      this.header(t, g.id, g.label, g.members.length, i === 0),
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
