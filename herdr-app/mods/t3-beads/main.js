// Beads (bd, github.com/gastownhall/beads) progress of the shown space: a done bar, the counts, the
// open epics and the in progress, ready and blocked beads. The space's folder is where its first
// terminal is now, as Herdr's own mods take a space's repo; bd finds .beads in it or above it.
// Layout node "beads", hidden by default: cmd-alt-b or the sidebar footer row shows it.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, exec, readTextFile, watchFolder, theme, layout, run, openOverlay, notify, nextCommand, checking } from "herdr";

const NODE = "beads";
// Only for what no folder watch sees: another machine, or a folder with no beads yet.
const EVERY = 30000;
const ROWS = 8;

// null: no node `id` under node. Else whether it is off screen: it or a node above it hidden, or a
// stack above it showing another child (the sidebar's Inbox).
function offscreen(node, id) {
  if (node?.id === id) return Boolean(node.hidden);
  const children = node?.children ?? [];
  for (const child of children) {
    const below = offscreen(child, id);
    if (below === null) continue;
    return Boolean(node.hidden) || (node.type === "stack" && (node.active ?? children[0]?.id) !== child.id) || below;
  }
  return null;
}
const hidden = () => offscreen(layout(), NODE) !== false;

function location() {
  const space = spaces().find((s) => s.active);
  if (!space) return null;
  const tabs = new Set(space.tabs.map((t) => t.id));
  const first = panes().find((p) => tabs.has(p.tab) && p.terminal && p.cwd);
  const folder = first?.cwd || space.folder;
  return folder ? { folder, on: space.machine ?? null } : null;
}
const key = () => JSON.stringify(location());

// --readonly: the panel never changes beads. Reads still touch Dolt's files (see watch()).
async function bd(args, { folder, on }) {
  // exec rejects when bd can't start: not installed, no such folder, machine unreachable.
  const r = await exec("bd", ["--readonly", ...args], { cwd: folder, on, timeout: 20000 })
    .catch((e) => { throw new Error(`bd could not start (${reason(e)})`); });
  if (r.code !== 0) {
    // With --json, bd reports some errors as JSON on stdout: {error, message}.
    let json = null;
    try { json = JSON.parse(r.stdout); } catch {}
    throw Object.assign(new Error(json?.message || errorLine(r) || `bd ${args[0]} failed`), { kind: json?.error, output: r.stderr + r.stdout });
  }
  return JSON.parse(r.stdout || "null");
}

// First line of an error, without bd's "Error: " prefix.
const reason = (e) => String(e?.message ?? e).replace(/^Error:\s*/, "");
// bd prints warnings first (beads.role, git exclude): the line that says what went wrong.
function errorLine(r) {
  const lines = (r.stderr || r.stdout).trim().split("\n");
  return lines.find((l) => /^Error:/.test(l)) ?? lines.find((l) => l && !/^\s*(warning|fix|or):/i.test(l)) ?? lines[0];
}

export default class Beads extends View {
  init(_props, cx) {
    this.context = null;
    this.data = null;
    this.folded = JSON.parse(localStorage.getItem("folded") ?? "{}");
    // manifest path -> its text: a Dolt write changes it, a read only rewrites it as it was.
    this.manifests = new Map();
    if (checking()) return;
    cx.timer.every(EVERY, (cx) => { if (!this.watching) this.refresh(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx, true);
        else if (c.startsWith("setup:")) await this.setup(JSON.parse(c.slice(6)), cx);
        cx.notify();
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  // A trigger while hidden or mid-load is kept as `stale` and runs once it can.
  refresh(cx, manual = false) {
    const loc = location(), next = key();
    if (next !== this.context?.key) {
      this.context = { key: next };
      this.data = null; this.error = null; this.none = false; this.loading = false;
      this.watched?.cancel(); this.watched = null; this.watching = null;
      this.manifests = new Map();
    }
    if (!loc) return;
    if (hidden() || this.loading) { this.stale = true; return; }
    this.stale = false;
    this.loading = true;
    this.manual = manual;
    const context = this.context;
    if (manual) cx.notify();
    cx.spawn(async (cx) => {
      try {
        let where;
        try { where = await bd(["where", "--json"], loc); }
        catch (e) {
          if (!this.current(context)) return;
          if (e.kind === "no_beads_directory" || /no beads database/i.test(e.output ?? "")) { this.none = true; this.data = null; this.error = null; }
          else throw e;
          return;
        }
        if (!this.current(context)) return;
        this.none = false;
        // Seed the manifest before reading, so a write during the reads still counts as a change.
        // Only an embedded database lives under .beads: a Dolt server's writes may change no file
        // there, so other modes keep the 30 s timer.
        let embedded = false;
        if (!loc.on) {
          const meta = JSON.parse(await readTextFile(`${where.path}/metadata.json`).catch(() => null) ?? "{}");
          embedded = meta.dolt_mode === "embedded" && Boolean(meta.dolt_database);
          if (embedded) {
            const manifest = `${where.database_path}/${meta.dolt_database}/.dolt/noms/manifest`;
            this.manifests.set(manifest, await readTextFile(manifest).catch(() => null));
          }
        }
        const [status, active, ready, blocked, epics] = await Promise.all([
          bd(["status", "--json"], loc),
          bd(["list", "--json", "--brief", "--status", "in_progress", "-n", "0"], loc),
          bd(["ready", "--json", "--brief", "--exclude-type", "epic", "-n", "0"], loc),
          bd(["blocked", "--json"], loc),
          bd(["epic", "status", "--json"], loc),
        ]);
        if (!this.current(context)) return;
        this.data = { where, summary: status?.summary ?? {}, active: active ?? [], ready: ready ?? [], blocked: blocked ?? [], epics: epics ?? [] };
        this.error = null;
        if (embedded) this.watch(where.path, context, cx);
      } catch (e) {
        if (this.current(context)) this.error = reason(e);
      } finally {
        if (this.context === context) { this.loading = false; this.manual = false; }
        cx.notify();
        if (this.stale && this.current(context)) this.refresh(cx);
      }
    });
  }

  // Every bd read rewrites Dolt's manifest and journal under .dolt/, so those events alone are no
  // change: only a manifest whose text changed is. Anything else under .beads (config) is one.
  watch(path, context, cx) {
    if (this.watching === path) return;
    this.watching = path;
    cx.spawn(async (cx) => {
      try {
        while (this.watching === path && this.context === context) {
          this.watched = watchFolder(path);
          const batch = await this.watched;
          if (this.watching !== path || this.context !== context) return;
          // [] or the root itself: the watch was released or overflowed, so read everything.
          let changed = batch.length === 0 || batch.includes(path);
          for (const p of batch) {
            if (changed) break;
            if (p.endsWith("/.dolt/noms/manifest")) {
              const text = await readTextFile(p).catch(() => null);
              if (text !== this.manifests.get(p)) { this.manifests.set(p, text); changed = true; }
            } else if (!p.includes("/.dolt/")) changed = true;
          }
          if (changed) this.refresh(cx);
        }
      } catch { if (this.watching === path) this.watching = null; }
    });
  }

  ask(loc) {
    openOverlay({
      mod: "confirm", kind: "dialog", width: 440, height: 190,
      props: {
        title: "Set up beads here?",
        detail: `bd init --stealth in ${loc.folder} (its git repo root, if any). Beads stays out of commits (.git/info/exclude), no AGENTS.md, hooks or git init.`,
        command: { name: `t3-beads.setup:${JSON.stringify(loc)}` },
      },
    });
  }

  async setup({ folder, on }, cx) {
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on }).catch(() => null);
    const root = top?.code === 0 ? top.stdout.trim() : folder;
    // BEADS_DIR: in a folder that is not a git repo, plain bd init would run git init there.
    const r = await exec("env", [`BEADS_DIR=${root}/.beads`, "bd", "init", "--quiet", "--stealth", "--skip-agents", "--skip-hooks", "--non-interactive"],
      { cwd: root, on, timeout: 60000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    if (r.code === 0) notify({ title: "Beads set up", body: root, level: "success" });
    else notify({ title: "bd init failed", body: errorLine(r), level: "error" });
    this.refresh(cx);
  }

  fold(id) {
    this.folded[id] = !this.folded[id];
    localStorage.setItem("folded", JSON.stringify(this.folded));
  }

  // parts fill the bar left to right; what is left of total stays the track color.
  bar(t, id, parts, total) {
    const rest = total - parts.reduce((n, p) => n + p.n, 0);
    return h_flex().id(id).w_full().h(6).flex_none().overflow_hidden().rounded_full().bg(t.border)
      .children(parts.filter((p) => p.n > 0).map((p) => div().h_full().flex_grow(p.n).bg(p.color)))
      .when(rest > 0, (el) => el.child(div().h_full().flex_grow(rest)));
  }

  header(t, id, label, count) {
    const open = !this.folded[id];
    return h_flex().id(`beads-${id}`).px(8).pt(8).h(30).flex_none().gap(4).items_center().text_size(11).font_medium()
      .on_click((_e, cx) => { this.fold(id); cx.notify(); })
      .child(div().text_color(t.dim).child(label))
      .child(div().text_color(t.dim).child(String(count)))
      .child(div().flex_1())
      .when(!open, (el) => el.child(svg("mods/workspace-chrome/chevron-right.svg").size(12).flex_none().text_color(t.dim)));
  }

  row(t, group, b, extra) {
    const p = b.priority ?? 2;
    const tip = [`${b.id}: ${b.title}`, `${b.issue_type ?? "task"} · P${p} · ${b.status}`, extra?.tip].filter(Boolean).join("\n");
    return h_flex().id(`bead-${group}-${b.id}`).w_full().min_w(0).px(8).h(26).flex_none().rounded(8).items_center().gap(8)
      .tooltip(tip).hover((s) => s.bg(t.foreground + "26"))
      .child(div().w(20).flex_none().text_size(11).font_medium().text_color(p === 0 ? t.ansi1 : p === 1 ? t.ansi3 : t.dim).child(`P${p}`))
      .child(div().min_w(0).truncate().text_color(t.foreground).child(b.title))
      .child(div().flex_1().flex_shrink(1000).min_w(0).truncate().text_size(12).text_color(t.dim).child(extra?.note ?? b.id));
  }

  group(t, id, label, list, extra) {
    if (!list.length) return [];
    const rows = this.folded[id] ? [] : list.slice(0, ROWS).map((b) => this.row(t, id, b, extra?.(b)));
    if (!this.folded[id] && list.length > ROWS) rows.push(div().id(`beads-${id}-more`).px(8).h(22).flex_none().text_size(11).text_color(t.dim).child(`and ${list.length - ROWS} more`));
    return [this.header(t, id, label, list.length), ...rows];
  }

  epic(t, e) {
    const done = e.closed_children ?? 0, total = e.total_children ?? 0;
    return v_flex().id(`epic-${e.epic.id}`).px(8).py(4).gap(4).flex_none().tooltip(`${e.epic.id}: ${e.epic.title}`)
      .child(h_flex().min_w(0).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(e.epic.title))
        .child(div().flex_none().text_size(11).text_color(e.eligible_for_close ? t.done : t.dim).child(`${done}/${total}`)))
      .child(this.bar(t, `epic-bar-${e.epic.id}`, [{ n: done, color: t.done }], Math.max(total, 1)));
  }

  body(t) {
    const d = this.data, s = d.summary;
    const total = s.total_issues ?? 0, closed = s.closed_issues ?? 0, active = s.in_progress_issues ?? 0, blocked = s.blocked_issues ?? 0;
    const pct = total ? Math.round((closed / total) * 100) : 0;
    // The lists, not the summary: bd's ready count includes epics, which the Ready list leaves out.
    const counts = [`${d.active.length} in progress`, `${d.ready.length} ready`, `${d.blocked.length} blocked`].join(" · ");
    const epics = d.epics.filter((e) => e.epic?.status !== "closed");
    return [
      v_flex().id("beads-summary").px(8).pt(2).pb(6).gap(5).flex_none()
        .child(h_flex().items_center().text_size(13)
          .child(div().font_medium().text_color(t.foreground).child(total ? `${closed} of ${total} done` : "No beads yet"))
          .child(div().flex_1())
          .when(total > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(`${pct}%`))))
        .when(total > 0, (el) => el.child(this.bar(t, "beads-bar", [
          { n: closed, color: t.done }, { n: active, color: t.working }, { n: blocked, color: t.blocked },
        ], total)))
        .when(total > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(counts))),
      ...(epics.length ? [this.header(t, "epics", "Epics", epics.length), ...(this.folded.epics ? [] : epics.map((e) => this.epic(t, e)))] : []),
      ...this.group(t, "active", "In progress", d.active, (b) => b.assignee ? { note: b.assignee } : null),
      ...this.group(t, "ready", "Ready", d.ready),
      ...this.group(t, "blocked", "Blocked", d.blocked, (b) => b.blocked_by?.length ? { note: `by ${b.blocked_by.join(", ")}`, tip: `Blocked by ${b.blocked_by.join(", ")}` } : null),
    ];
  }

  render(cx) {
    if (key() !== this.context?.key || (this.stale && !hidden())) this.refresh(cx);
    const t = theme(), loc = location();
    const name = this.data?.where?.prefix;
    const note = !loc ? "No space shown."
      : this.error ? `Could not read beads: ${this.error}`
      : this.none ? null
      : !this.data ? "Loading beads…" : null;
    const icon = (id, src, label, action, spin) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .role("button").accessibility_label(label).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(svg(src).size(13).when(Boolean(spin), (el) => el.spin(900)));
    return v_flex().id("t3-beads-root").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().id("beads-heading").pl(16).pr(10).h(31).flex_none().items_center().gap(6)
        .child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child("Beads"))
        .when(Boolean(name), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(name)))
        .child(div().flex_1())
        // A click's cx lasts only for the click: the refresh runs through the command loop's.
        .child(icon("beads-refresh", "mods/t3-prs/refresh.svg", "Refresh beads", () => run("t3-beads.refresh"), this.manual))
        .child(icon("beads-hide", "mods/workspace-chrome/x.svg", "Hide beads", () => run("layout.hide", { id: NODE }))))
      .when(Boolean(note), (el) => el.child(div().px(16).pb(4).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(note)))
      .when(this.none && Boolean(loc), (el) => el.child(v_flex().px(16).pb(8).gap(8)
        .child(div().text_size(12).text_color(t.dim).child(`No beads in ${loc.folder.split("/").pop() || loc.folder}.`))
        .child(h_flex().id("beads-setup").h(30).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.border)
          .role("button").accessibility_label("Set up beads here").tooltip(loc.folder)
          .text_color(t.foreground).hover((s) => s.bg(t.hover))
          .on_click(() => this.ask(loc))
          .child(svg("mods/t3-chrome/beads.svg").size(14).flex_none())
          .child(div().child("Set up beads here")))))
      .when(Boolean(this.data), (el) => el.child(v_flex().id("beads-list").flex_1().min_h(0).px(8).pb(6).overflow_y_scroll().children(this.body(t))));
  }
}
