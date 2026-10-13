// Finds new Algora bounties through GitHub search (Algora labels every bounty issue "💎 Bounty")
// and opens one issue per new bounty in this repo. GitHub then notifies you by email and the mobile app.
import {
  dropFarms, filterBounties, seenIdsFrom, competition, verdict, rewardUsd,
  rewardFromComments, fromSearchItem, issueTitle, issueBody, digestBody,
} from "./core.mjs";

const LABEL = "bounty";
const BOUNTY_LABEL = "💎 Bounty";

export function config(env = process.env) {
  const repo = env.GITHUB_REPOSITORY ?? "";
  return {
    repo,
    token: env.GITHUB_TOKEN ?? "",
    tech: (env.TECH || "typescript,javascript").split(",").map((s) => s.trim()).filter(Boolean),
    minUsd: Number(env.MIN_USD || 50),
    maxPerRepo: Number(env.MAX_PER_REPO || 15),
    blockRepos: (env.BLOCK_REPOS || "UnsafeLabs/Bounty-Hunters,SecureBananaLabs/bug-bounty").split(",").map((s) => s.trim()).filter(Boolean),
    maxAgeDays: Number(env.MAX_AGE_DAYS || 0),
    mention: env.MENTION || repo.split("/")[0] || "",
    dryRun: env.DRY_RUN === "1",
  };
}

export function githubClient(token, fetchImpl = fetch) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bounty-watcher",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    async searchBounties(lang) {
      const q = `label:"${BOUNTY_LABEL}" is:open is:issue language:${lang}`;
      const params = new URLSearchParams({ q, sort: "created", order: "desc", per_page: "100" });
      const r = await call("GET", `/search/issues?${params}`);
      return r?.items ?? [];
    },
    async ourIssues(repo) {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const batch = await call("GET", `/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`);
        if (!batch?.length) break;
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
    async ensureLabel(repo) {
      const exists = await call("GET", `/repos/${repo}/labels/${LABEL}`);
      if (!exists) await call("POST", `/repos/${repo}/labels`, { name: LABEL, color: "1f883d" });
    },
    async targetIssue(owner, name, number) {
      return call("GET", `/repos/${owner}/${name}/issues/${number}`);
    },
    async targetComments(owner, name, number) {
      return (await call("GET", `/repos/${owner}/${name}/issues/${number}/comments?per_page=100`)) ?? [];
    },
    async createIssue(repo, title, body) {
      return call("POST", `/repos/${repo}/issues`, { title, body, labels: [LABEL] });
    },
  };
}

/** Open bounty issues for each language, de-duplicated. A search failure fails the run. */
export async function fetchBounties(gh, tech) {
  const byId = new Map();
  for (const lang of tech) {
    for (const item of await gh.searchBounties(lang)) {
      if (!byId.has(item.id)) byId.set(item.id, fromSearchItem(item, lang));
    }
  }
  return [...byId.values()];
}

/** Read the bounty's issue: competition, state, and the reward the Algora bot posted. Never fails the run. */
async function assess(gh, b) {
  const t = b.task ?? {};
  try {
    const [issue, comments] = await Promise.all([
      gh.targetIssue(t.repo_owner, t.repo_name, t.number),
      gh.targetComments(t.repo_owner, t.repo_name, t.number),
    ]);
    // Only the Algora bot's amount is trusted; it replaces anything read from the title or labels.
    const usd = rewardFromComments(comments);
    if (usd != null) b.reward_formatted = `$${usd}`;
    const comp = competition(comments);
    const v = verdict(comp, {
      closed: issue?.state === "closed",
      assigned: (issue?.assignees ?? []).length > 0,
      funded: usd != null,
    });
    return { b, comp, v };
  } catch {
    const comp = { attempts: 0, claims: 0, total: 0 };
    return { b, comp, v: { light: "⚪", label: "check", reason: "couldn't read the issue; check it by hand" } };
  }
}

export async function run({ cfg, gh, log = console.log }) {
  if (!cfg.repo || !cfg.token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set.");

  const all = await fetchBounties(gh, cfg.tech);
  const { kept, farms } = dropFarms(all, cfg);
  if (farms.length) log(`Skipped bounty farms: ${farms.join(", ")}.`);
  const wanted = filterBounties(kept, cfg);
  log(`Search: ${all.length} open bounty issues, ${wanted.length} pass the filters.`);

  const existing = await gh.ourIssues(cfg.repo);
  const seen = seenIdsFrom(existing);
  const fresh = wanted.filter((b) => !seen.has(String(b.id)));
  log(`Already announced: ${seen.size}. New: ${fresh.length}.`);
  if (!fresh.length) return { created: 0 };

  const assessed = [];
  for (const b of fresh) assessed.push(await assess(gh, b));
  // The reward is now known for most; drop the ones under the minimum.
  const priced = assessed.filter((r) => { const usd = rewardUsd(r.b); return usd == null || usd >= cfg.minUsd; });
  const live = priced.filter((r) => r.v.light !== "⚫");
  const tally = {};
  for (const r of assessed) tally[r.v.reason.replace(/\d+/g, "N")] = (tally[r.v.reason.replace(/\d+/g, "N")] ?? 0) + 1;
  log(`After reading the issues: ${live.length} worth announcing. Verdicts: ${Object.entries(tally).map(([k, n]) => `${n}× ${k}`).join("; ")}.`);

  if (cfg.dryRun) {
    for (const r of live) log(`DRY ${issueTitle(r.b, r.v)}`);
    return { created: 0, wouldCreate: seen.size ? live.length : 1 };
  }
  // On the first run, post the digest even when empty so everything checked is recorded.
  if (!live.length && seen.size) return { created: 0 };

  await gh.ensureLabel(cfg.repo);

  if (!seen.size) {
    // First run: one digest instead of dozens of issues. Skipped ones are recorded too, so they aren't re-checked.
    await gh.createIssue(cfg.repo, `📋 ${live.length} open bounties right now`, digestBody(live, cfg, assessed));
    log("First run: posted a digest.");
    return { created: 1 };
  }

  let created = 0;
  for (const r of live) {
    await gh.createIssue(cfg.repo, issueTitle(r.b, r.v), issueBody(r.b, r.v, r.comp, cfg));
    created++;
  }
  log(`Opened ${created} issue(s).`);
  return { created };
}

// Entry point when run directly (GitHub Actions).
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  // "::notice::" lines become annotations on the run page, readable without opening logs.
  const log = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
  run({ cfg, gh: githubClient(cfg.token), log })
    .catch((e) => { console.log(`::error::${e.message}`); process.exit(1); });
}
