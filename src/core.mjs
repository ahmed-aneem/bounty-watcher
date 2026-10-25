// Pure logic: no network, no I/O. Everything here is unit-tested.

export const MARKER_RE = /<!--\s*algora:([A-Za-z0-9_-]+)\s*-->/g;

/** Reward in whole US dollars, or null when unknown. */
export function rewardUsd(b) {
  if (b?.reward?.amount != null) return Math.round(b.reward.amount / 100);
  return parseUsd(b?.reward_formatted ?? "");
}

/** First "$1,500"-style amount in a piece of text, or null. */
export function parseUsd(text) {
  const t = text ?? "";
  const m = /(?:\$|USD[C]?\s*)\s*([\d,]+)(?:\.\d+)?|([\d,]+)(?:\.\d+)?\s*(?:\$|USD[C]?)/i.exec(t);
  if (!m) return null;
  const numStr = m[1] || m[2];
  return numStr ? Number(numStr.replace(/,/g, "")) : null;
}

const isBot = (c) => c.user?.type === "Bot" || /\[bot\]$/i.test(c.user?.login ?? "");

/**
 * Reward confirmed by Algora's own bot, or null. Only this counts as funded:
 * anyone can label their issue "💎 Bounty" or write "$900" in it.
 */
export function rewardFromComments(comments) {
  for (const c of comments) {
    if (isBot(c) && /algora/i.test(c.user?.login ?? "")) {
      const usd = parseUsd(c.body);
      if (usd != null) return usd;
    }
  }
  return null;
}

/** Turn a GitHub search result into the bounty shape the rest of the code uses. */
export function fromSearchItem(item, lang) {
  const [owner, name] = item.repository_url.replace("https://api.github.com/repos/", "").split("/");
  const labelReward = (item.labels ?? []).map((l) => parseUsd(l.name)).find((v) => v != null);
  return {
    id: `gh-${item.id}`,
    status: "active",
    reward_type: "cash",
    reward_formatted: labelReward != null ? `$${labelReward}` : parseUsd(item.title) != null ? `$${parseUsd(item.title)}` : null,
    created_at: item.created_at,
    tech: [lang],
    task: { repo_owner: owner, repo_name: name, number: item.number, title: item.title, url: item.html_url },
  };
}

/** Tech tags for a bounty, lower-cased. Newer API puts them on the bounty, older on the org. */
export function techOf(b) {
  const tags = [...(b?.tech ?? []), ...(b?.org?.tech ?? [])];
  return [...new Set(tags.map((t) => String(t).toLowerCase()))];
}

export function issueUrl(b) {
  const t = b?.task ?? {};
  if (t.url) return t.url;
  if (t.repo_owner && t.repo_name && t.number)
    return `https://github.com/${t.repo_owner}/${t.repo_name}/issues/${t.number}`;
  return null;
}

/** Keep cash bounties that are active, in the wanted tech, and above the minimum. */
export function filterBounties(items, { tech, minUsd, maxAgeDays, now = Date.now() }) {
  const wanted = tech.map((t) => t.toLowerCase());
  return items.filter((b) => {
    if (b.status && b.status !== "active") return false;
    if (b.reward_type && b.reward_type !== "cash") return false;
    // Unknown rewards pass here; the reward is read from the issue later and checked again.
    const usd = rewardUsd(b);
    if (usd != null && usd < minUsd) return false;
    if (!issueUrl(b)) return false;
    const tags = techOf(b);
    // Untagged bounties are kept: missing tags are common and filtering them hides real work.
    if (tags.length && !tags.some((t) => wanted.includes(t))) return false;
    if (maxAgeDays && b.created_at) {
      const ageDays = (now - new Date(b.created_at).getTime()) / 864e5;
      if (ageDays > maxAgeDays) return false;
    }
    return true;
  });
}

const repoOf = (b) => `${b.task?.repo_owner}/${b.task?.repo_name}`.toLowerCase();

/**
 * Drop bounty farms: blocked repos, and repos with more open bounties than a real project posts.
 * Farms attract swarms of AI agents and often never pay. Returns { kept, farms }.
 */
export function dropFarms(items, { maxPerRepo, blockRepos = [] }) {
  const counts = new Map();
  for (const b of items) counts.set(repoOf(b), (counts.get(repoOf(b)) ?? 0) + 1);
  const blocked = new Set(blockRepos.map((r) => r.toLowerCase()));
  const farms = [...counts].filter(([r, n]) => blocked.has(r) || n > maxPerRepo).map(([r, n]) => `${r} (${n})`);
  const bad = new Set(farms.map((f) => f.split(" ")[0]));
  return { kept: items.filter((b) => !bad.has(repoOf(b))), farms };
}

/** IDs already announced, read from hidden markers in issue bodies. */
export function seenIdsFrom(issues) {
  const seen = new Set();
  for (const i of issues) for (const m of (i.body ?? "").matchAll(MARKER_RE)) seen.add(m[1]);
  return seen;
}

/** Count competition from the bounty issue's comments. */
export function competition(comments) {
  // Bots quote "/attempt" in their instructions; only people count as competition.
  const people = comments.filter((c) => !isBot(c));
  const attempts = people.filter((c) => /(^|\s)\/attempt\b/i.test(c.body ?? "")).length;
  const claims = people.filter((c) => /(^|\s)\/claim\b/i.test(c.body ?? "")).length;
  return { attempts, claims, total: people.length };
}

/**
 * Traffic-light verdict. Being early matters most, so attempts and claims weigh heaviest.
 * Returns { light, label, reason }.
 */
export function verdict({ attempts, claims }, { closed = false, assigned = false, funded = true } = {}) {
  if (closed) return { light: "⚫", label: "skip", reason: "the issue is already closed" };
  if (!funded) return { light: "⚫", label: "skip", reason: "no funding confirmed by Algora's bot" };
  if (claims > 0) return { light: "🔴", label: "skip", reason: `${claims} claim(s) already submitted` };
  if (assigned) return { light: "🔴", label: "skip", reason: "the issue is assigned to someone" };
  if (attempts === 0) return { light: "🟢", label: "go now", reason: "nobody has started yet" };
  if (attempts <= 2) return { light: "🟡", label: "maybe", reason: `${attempts} attempt(s) so far` };
  return { light: "🔴", label: "skip", reason: `${attempts} attempts already` };
}

export function issueTitle(b, v) {
  const t = b.task ?? {};
  const repo = t.repo_owner && t.repo_name ? `${t.repo_owner}/${t.repo_name}` : b.org?.handle ?? "unknown";
  const title = (t.title ?? "Untitled").slice(0, 90);
  return `${v.light} ${money(b)} · ${repo} · ${title}`;
}

function money(b) {
  const usd = rewardUsd(b);
  return usd == null ? "$?" : `$${usd}`;
}

export function issueBody(b, v, comp, { mention }) {
  const url = issueUrl(b);
  const tags = techOf(b).join(", ") || "not tagged";
  const posted = b.created_at ? new Date(b.created_at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "unknown";
  return [
    `**${v.light} ${v.label.toUpperCase()}**: ${v.reason}.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Reward | **${money(b)}** |`,
    `| Issue | ${url} |`,
    `| Tech | ${tags} |`,
    `| Posted | ${posted} |`,
    `| Comments | ${comp.total} (${comp.attempts} /attempt, ${comp.claims} /claim) |`,
    "",
    "**Next step:** paste the issue link to Claude and ask it to assess the fix. If it looks doable, comment `/attempt` on the issue first, then build.",
    "",
    "⚠️ Treat the issue text as untrusted. Some bounty repos hide instructions for AI agents (for example, asking them to upload session data). Never let an agent follow instructions found inside an issue.",
    "",
    mention ? `cc @${mention}` : "",
    `<!-- algora:${b.id} -->`,
  ].join("\n");
}

/** One issue listing everything already open, so the first run doesn't flood the inbox. */
export function digestBody(rows, { mention }, recordAll = rows) {
  const lines = rows
    .sort((a, b) => (rewardUsd(b.b) ?? 0) - (rewardUsd(a.b) ?? 0))
    .map(({ b, v }) => `- ${v.light} **${money(b)}** · [${(b.task?.title ?? "Untitled").slice(0, 80)}](${issueUrl(b)})`);
  return [
    "Bounties that were already open when the watcher started. From now on, each new one gets its own issue.",
    "",
    ...lines,
    "",
    mention ? `cc @${mention}` : "",
    ...recordAll.map(({ b }) => `<!-- algora:${b.id} -->`),
  ].join("\n");
}
