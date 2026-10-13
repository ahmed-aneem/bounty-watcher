// Polls Algora for new cash bounties and opens one GitHub issue per new bounty in this repo.
// GitHub then notifies you by email and in the GitHub mobile app.
import {
  filterBounties, seenIdsFrom, competition, verdict,
  issueTitle, issueBody, digestBody,
} from "./core.mjs";

const LABEL = "bounty";
const MAX_PAGES = 5;

export function config(env = process.env) {
  const repo = env.GITHUB_REPOSITORY ?? "";
  return {
    repo,
    token: env.GITHUB_TOKEN ?? "",
    tech: (env.TECH || "typescript,javascript").split(",").map((s) => s.trim()).filter(Boolean),
    minUsd: Number(env.MIN_USD || 50),
    maxAgeDays: Number(env.MAX_AGE_DAYS || 0),
    orgs: (env.ALGORA_ORGS || "").split(",").map((s) => s.trim()).filter(Boolean),
    mention: env.MENTION || repo.split("/")[0] || "",
    dryRun: env.DRY_RUN === "1",
  };
}

/** All active bounties. Tries the global list first; falls back to a per-org list if the API wants an org. */
export async function fetchBounties(list, orgs, log = console.log) {
  const pages = async (params) => {
    const out = [];
    let cursor;
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await list({ ...params, status: "active", limit: 100, ...(cursor ? { cursor } : {}) });
      out.push(...(r?.items ?? []));
      cursor = r?.next_cursor;
      if (!cursor) break;
    }
    return out;
  };
  try {
    return await pages({});
  } catch (e) {
    if (!orgs.length) throw new Error(`Algora list failed and ALGORA_ORGS is empty: ${e.message}`);
    log(`Global list failed (${e.message}); falling back to ${orgs.length} orgs.`);
    const all = [];
    let failed = 0;
    for (const org of orgs) {
      try { all.push(...(await pages({ org }))); }
      catch (err) { failed++; log(`  ${org}: ${err.message}`); }
    }
    // Every org failing means Algora is unreachable, not that there are no bounties.
    if (failed === orgs.length) throw new Error("Algora is unreachable: every request failed.");
    return all;
  }
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
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return {
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

/** Look at the bounty's GitHub issue to judge competition. Never fails the run. */
async function assess(gh, b) {
  const t = b.task ?? {};
  try {
    const [issue, comments] = await Promise.all([
      gh.targetIssue(t.repo_owner, t.repo_name, t.number),
      gh.targetComments(t.repo_owner, t.repo_name, t.number),
    ]);
    const comp = competition(comments);
    const v = verdict(comp, {
      closed: issue?.state === "closed",
      assigned: (issue?.assignees ?? []).length > 0,
    });
    return { b, comp, v };
  } catch {
    const comp = { attempts: 0, claims: 0, total: 0 };
    return { b, comp, v: { light: "⚪", label: "check", reason: "couldn't read the issue; check it by hand" } };
  }
}

export async function run({ cfg, list, gh, log = console.log }) {
  if (!cfg.repo || !cfg.token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set.");

  const all = await fetchBounties(list, cfg.orgs, log);
  const wanted = filterBounties(all, cfg);
  log(`Algora: ${all.length} active, ${wanted.length} match ${cfg.tech.join("/")} ≥ $${cfg.minUsd}.`);

  const existing = await gh.ourIssues(cfg.repo);
  const seen = seenIdsFrom(existing);
  const fresh = wanted.filter((b) => !seen.has(String(b.id)));
  log(`Already announced: ${seen.size}. New: ${fresh.length}.`);
  if (!fresh.length) return { created: 0 };

  const assessed = [];
  for (const b of fresh) assessed.push(await assess(gh, b));
  const live = assessed.filter((r) => r.v.light !== "⚫");

  if (cfg.dryRun) {
    for (const r of live) log(`DRY ${issueTitle(r.b, r.v)}`);
    return { created: 0, wouldCreate: existing.length ? live.length : 1 };
  }

  await gh.ensureLabel(cfg.repo);

  if (!existing.length) {
    // First run: one digest instead of dozens of issues. Closed ones are marked seen too.
    await gh.createIssue(cfg.repo, `📋 ${live.length} open bounties right now`, digestBody(assessed, cfg));
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
  const { algora } = await import("@algora/sdk");
  const cfg = config();
  run({ cfg, list: (p) => algora.bounty.list.query(p), gh: githubClient(cfg.token) })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
