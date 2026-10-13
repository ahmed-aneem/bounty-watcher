// Pure logic: no network, no I/O. Everything here is unit-tested.

export const MARKER_RE = /<!--\s*algora:([A-Za-z0-9_-]+)\s*-->/g;

/** Reward in whole US dollars (Algora stores cents). */
export function rewardUsd(b) {
  if (b?.reward?.amount != null) return Math.round(b.reward.amount / 100);
  const m = /\$?\s*([\d,]+)/.exec(b?.reward_formatted ?? "");
  return m ? Number(m[1].replace(/,/g, "")) : 0;
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
    if (rewardUsd(b) < minUsd) return false;
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

/** IDs already announced, read from hidden markers in issue bodies. */
export function seenIdsFrom(issues) {
  const seen = new Set();
  for (const i of issues) for (const m of (i.body ?? "").matchAll(MARKER_RE)) seen.add(m[1]);
  return seen;
}

/** Count competition from the bounty issue's comments. */
export function competition(comments) {
  const attempts = comments.filter((c) => /(^|\s)\/attempt\b/i.test(c.body ?? "")).length;
  const claims = comments.filter((c) => /(^|\s)\/claim\b/i.test(c.body ?? "")).length;
  return { attempts, claims, total: comments.length };
}

/**
 * Traffic-light verdict. Being early matters most, so attempts and claims weigh heaviest.
 * Returns { light, label, reason }.
 */
export function verdict({ attempts, claims }, { closed = false, assigned = false } = {}) {
  if (closed) return { light: "⚫", label: "skip", reason: "the issue is already closed" };
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
  return `${v.light} $${rewardUsd(b)} · ${repo} · ${title}`;
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
    `| Reward | **$${rewardUsd(b)}** |`,
    `| Issue | ${url} |`,
    `| Tech | ${tags} |`,
    `| Posted | ${posted} |`,
    `| Comments | ${comp.total} (${comp.attempts} /attempt, ${comp.claims} /claim) |`,
    "",
    "**Next step:** paste the issue link to Claude and ask it to assess the fix. If it looks doable, comment `/attempt` on the issue first, then build.",
    "",
    mention ? `cc @${mention}` : "",
    `<!-- algora:${b.id} -->`,
  ].join("\n");
}

/** One issue listing everything already open, so the first run doesn't flood the inbox. */
export function digestBody(rows, { mention }) {
  const lines = rows
    .sort((a, b) => rewardUsd(b.b) - rewardUsd(a.b))
    .map(({ b, v }) => `- ${v.light} **$${rewardUsd(b)}** · [${(b.task?.title ?? "Untitled").slice(0, 80)}](${issueUrl(b)})`);
  return [
    "Bounties that were already open when the watcher started. From now on, each new one gets its own issue.",
    "",
    ...lines,
    "",
    mention ? `cc @${mention}` : "",
    ...rows.map(({ b }) => `<!-- algora:${b.id} -->`),
  ].join("\n");
}
