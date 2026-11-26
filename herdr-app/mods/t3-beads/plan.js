// What the panel shows, from bd's lists: the beads in progress, the next one, the epic they belong
// to with its tasks in order, and the rest. No UI here, so tests can check it on its own.

const isEpic = (b) => b.issue_type === "epic";

// "citadel-zvm.10" after "citadel-zvm.2": ids compared part by part, numbers as numbers.
function byId(a, b) {
  const x = a.id.split("."), y = b.id.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const n = Number(x[i]) - Number(y[i]);
    if (!Number.isNaN(n) && n) return n;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}
const byPriority = (a, b) => (a.priority ?? 2) - (b.priority ?? 2) || byId(a, b);

// all: `bd list --all --brief`; open: the open beads with their text; ready: `bd ready` (bd's order);
// blocked: `bd blocked` ({id, blocked_by}).
export function plan(all, open, ready, blocked) {
  const beads = new Map();
  for (const b of all) beads.set(b.id, b);
  for (const b of open) beads.set(b.id, { ...beads.get(b.id), ...b });
  const waits = new Map(blocked.map((b) => [b.id, b.blocked_by ?? []]));
  const state = (b) => b.status === "closed" ? "done" : b.status === "in_progress" ? "working"
    : waits.has(b.id) || b.status === "blocked" ? "blocked" : b.status === "deferred" ? "later" : "ready";
  const epicOf = (b) => {
    for (let p = beads.get(b?.parent), hops = 0; p && hops < 20; p = beads.get(p.parent), hops++) if (isEpic(p)) return p;
    return null;
  };
  const tasks = [...beads.values()].filter((b) => !isEpic(b));
  const now = tasks.filter((b) => state(b) === "working").sort(byPriority);
  const queue = ready.map((r) => beads.get(r.id) ?? r).filter((b) => !isEpic(b) && state(b) === "ready");
  const epics = [...beads.values()].filter((b) => isEpic(b) && b.status !== "closed").sort(byPriority);
  // The epic we're on: the one of the bead in progress, else of the next ready bead, else the first open.
  const epic = epicOf(now[0]) ?? epicOf(queue[0]) ?? epics[0] ?? null;
  const inEpic = (b) => Boolean(epic) && epicOf(b)?.id === epic.id;
  const next = queue.find(inEpic) ?? queue[0] ?? null;
  const list = epic ? tasks.filter((b) => b.parent === epic.id).sort(byId) : [];
  const others = tasks.filter((b) => !inEpic(b) && b.status !== "closed").sort(byPriority);
  return {
    beads, state, waits, now, next, epic, list, others,
    otherEpics: epics.filter((e) => e.id !== epic?.id).length,
    done: list.filter((b) => b.status === "closed").length,
    counts: { working: now.length, ready: queue.length, blocked: tasks.filter((b) => state(b) === "blocked").length },
  };
}

const PRIORITY = ["Urgent", "High priority", "Normal priority", "Low priority", "Low priority"];

// The first sentence of a description, in plain words: no links (nor a "Notion:" label before one)
// and no markdown, at most about two lines.
export function gist(text, max = 110) {
  const clean = String(text ?? "").replace(/([\w-]+:\s+)?https?:\/\/\S+/g, "").replace(/`|\*\*|^#+\s*/gm, "")
    .replace(/\s+/g, " ").replace(/^[\s.,;:]+/, "").trim();
  const first = clean.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? clean;
  return first.length > max ? `${first.slice(0, max).replace(/\s+\S*$/, "")}…` : first;
}

function ago(iso, now) {
  const min = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min)) return null;
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

// The hover card's two lines: what the bead is, and where it stands.
export function about(b, p, now = Date.now()) {
  const what = gist(b.description) || "No description yet.";
  const s = p.state(b);
  let where;
  if (s === "working") {
    const since = b.started_at && ago(b.started_at, now);
    where = `Being worked on now${b.assignee ? ` by ${b.assignee}` : ""}${since ? `, started ${since}` : ""}.`;
  } else if (s === "blocked") {
    const names = (p.waits.get(b.id) ?? []).map((id) => gist(p.beads.get(id)?.title ?? id, 60).replace(/\.$/, ""));
    where = names.length === 0 ? "Waiting on another bead."
      : names.length === 1 ? `Waiting on: ${names[0]}`
      : `Waiting on ${names.length} beads, first: ${names[0]}`;
  } else if (s === "done") where = "Done.";
  else if (s === "later") where = "Put off for later.";
  else where = `Ready to start. ${PRIORITY[b.priority ?? 2] ?? "Normal priority"}.`;
  return [what, where];
}
