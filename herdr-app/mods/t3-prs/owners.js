// Code owner approval for one pull request: every changed file that CODEOWNERS gives an owner
// needs an approval from one of that file's owners (a user, or a member of an owning team).
// No Herdr imports: `gql(query, variables)` runs GitHub GraphQL and returns `data`, so the same
// code runs in the mod (gh through exec) and in a plain script.

const ORG_TEAM = /^@([^/\s]+)\/(\S+)$/;
const USER = /^@([^/\s]+)$/;

// One CODEOWNERS pattern as a regex, with GitHub's gitignore rules: a slash at the start or in
// the middle anchors it to the repo root; a trailing slash or a plain name also owns everything
// under it; "dir/*" owns only the files directly in dir.
export function patternRegex(pattern) {
  let p = pattern.replace(/\\#/g, "#");
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\//, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const last = p.split("/").pop();
  const under = dir || !/[*?]/.test(last) ? "(?:/.*)?" : "";
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${re}${under}$`);
}

export function parseCodeowners(text) {
  return (text ?? "").split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trim()).filter(Boolean).map((l) => {
    const [pattern, ...owners] = l.split(/\s+/);
    return { pattern, re: patternRegex(pattern), owners };
  });
}

// The owners of a path: the last matching rule wins; a rule with no owners means none.
export function ownersFor(rules, path) {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].re.test(path)) return rules[i].owners;
  return [];
}

// The distinct owner sets the changed files need, each with the files that need it.
export function requiredSets(rules, paths) {
  const sets = new Map();
  for (const path of paths) {
    const owners = ownersFor(rules, path);
    if (!owners.length) continue;
    const key = [...owners].sort().join(" ");
    if (!sets.has(key)) sets.set(key, { owners, files: [] });
    sets.get(key).files.push(path);
  }
  return [...sets.values()];
}

// The three CODEOWNERS places GitHub reads, first found wins. object(expression:) is null for a
// missing path, where Commit.file() makes the whole query fail.
const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String, $a: String!, $b: String!, $c: String!) {
  repository(owner: $owner, name: $name) {
    a: object(expression: $a) { ... on Blob { text } }
    b: object(expression: $b) { ... on Blob { text } }
    c: object(expression: $c) { ... on Blob { text } }
    pullRequest(number: $number) { files(first: 100, after: $after) { nodes { path } pageInfo { hasNextPage endCursor } } } } }`;

const TEAM_QUERY = `query($org: String!, $slug: String!, $after: String) {
  organization(login: $org) { team(slug: $slug) {
    members(first: 100, after: $after, membership: ALL) { nodes { login } pageInfo { hasNextPage endCursor } } } } }`;

// Team members change rarely: keep them for 30 minutes.
const teams = new Map();
async function teamMembers(gql, org, slug) {
  const key = `${org}/${slug}`.toLowerCase();
  const hit = teams.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.logins;
  const logins = new Set();
  for (let after = null; ;) {
    const m = (await gql(TEAM_QUERY, { org, slug, after })).organization?.team?.members;
    if (!m) throw new Error(`can't read team ${key}`);
    for (const n of m.nodes) logins.add(n.login.toLowerCase());
    if (!m.pageInfo.hasNextPage) break;
    after = m.pageInfo.endCursor;
  }
  teams.set(key, { at: Date.now(), logins });
  return logins;
}

async function ownerApproved(gql, owner, approvers) {
  const t = owner.match(ORG_TEAM);
  if (t) {
    const members = await teamMembers(gql, t[1], t[2]);
    return approvers.some((a) => members.has(a));
  }
  const u = owner.match(USER);
  return Boolean(u) && approvers.includes(u[1].toLowerCase());
}

// pr: { repo: "owner/name", number, base (branch), author, reviews: [{ login, state }] (latest
// per reviewer) }. Returns { ok, approvers, missing: [{ owners, files }], codeowners: boolean }.
export async function checkCodeOwners(gql, pr) {
  const [owner, name] = pr.repo.split("/");
  const approvers = pr.reviews.filter((r) => r.state === "APPROVED" && r.login.toLowerCase() !== pr.author?.toLowerCase())
    .map((r) => r.login.toLowerCase());
  const at = (path) => `${pr.base}:${path}`;
  const paths = [];
  let text = null;
  for (let after = null; ;) {
    const r = (await gql(PR_QUERY, { owner, name, number: pr.number, after,
      a: at(".github/CODEOWNERS"), b: at("CODEOWNERS"), c: at("docs/CODEOWNERS") })).repository;
    text ??= r.a?.text ?? r.b?.text ?? r.c?.text ?? "";
    for (const f of r.pullRequest.files.nodes) paths.push(f.path);
    if (!r.pullRequest.files.pageInfo.hasNextPage) break;
    after = r.pullRequest.files.pageInfo.endCursor;
  }
  const missing = [];
  for (const set of requiredSets(parseCodeowners(text), paths)) {
    let ok = false;
    for (const o of set.owners) if (await ownerApproved(gql, o, approvers)) { ok = true; break; }
    if (!ok) missing.push(set);
  }
  return { ok: approvers.length > 0 && missing.length === 0, approvers, missing, codeowners: Boolean(text) };
}
