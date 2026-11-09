// Comments that people (not bots) left on one pull request: conversation comments, inline review
// comments, and review summaries with text. No Herdr imports: `gql(query, variables)` runs GitHub
// GraphQL and returns `data`, so the same code runs in the mod and in a plain script.

// GitHub Apps are "Bot". Machine users are "User" accounts, so they go by name: a login that ends
// in "bot" (deploy-bot, policybot, renovate[bot]).
export const isBot = (a) => !a || a.__typename === "Bot" || /(bot|\[bot\])$/i.test(a.login);

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    comments(last: 100) { nodes { author { __typename login } createdAt } }
    reviews(last: 100) { nodes { author { __typename login } submittedAt bodyText } }
    reviewThreads(last: 50) { nodes { comments(last: 20) { nodes { author { __typename login } createdAt } } } } } } }`;

// Every comment as { login, at, mine }, oldest first; bots left out.
export function collect(pr, me) {
  const out = [];
  const add = (author, at) => {
    if (isBot(author) || !at) return;
    out.push({ login: author.login, at, mine: author.login.toLowerCase() === me.toLowerCase() });
  };
  for (const c of pr.comments.nodes) add(c.author, c.createdAt);
  // A review's own text counts; an empty one only holds inline comments (counted below) or a bare approval.
  for (const r of pr.reviews.nodes) if (r.bodyText?.trim()) add(r.author, r.submittedAt);
  for (const t of pr.reviewThreads.nodes) for (const c of t.comments.nodes) add(c.author, c.createdAt);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// Others' comments, and how many came after `since` (ISO time) and after my last comment.
export function summarize(list, since = "") {
  const mine = list.filter((c) => c.mine).map((c) => c.at);
  const after = [since, ...mine].sort().pop() ?? "";
  const others = list.filter((c) => !c.mine);
  const by = new Map();
  for (const c of others) by.set(c.login, (by.get(c.login) ?? 0) + 1);
  return { count: others.length, fresh: others.filter((c) => c.at > after).length, by: [...by] };
}

export async function fetchComments(gql, repo, number, me) {
  const [owner, name] = repo.split("/");
  return collect((await gql(QUERY, { owner, name, number })).repository.pullRequest, me);
}
