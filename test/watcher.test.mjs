import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rewardUsd, parseUsd, rewardFromComments, fromSearchItem, filterBounties,
  seenIdsFrom, competition, verdict, issueTitle, issueBody,
} from "../src/core.mjs";
import { run, fetchBounties, config } from "../src/run.mjs";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const bounty = (id, over = {}) => ({
  id, status: "active", reward_type: "cash", reward_formatted: "$250",
  created_at: "2026-10-13T20:00:00Z", tech: ["typescript"],
  task: { repo_owner: "acme", repo_name: "app", number: Number(String(id).replace(/\D/g, "")) || 1, title: `Fix ${id}`, url: `https://github.com/acme/app/issues/${id}` },
  ...over,
});
// A GitHub search result, as the API returns it.
const searchItem = (n, over = {}) => ({
  id: 9000 + n, number: n, title: `Issue ${n}`, created_at: "2026-10-13T20:00:00Z",
  html_url: `https://github.com/acme/app/issues/${n}`,
  repository_url: "https://api.github.com/repos/acme/app",
  labels: [{ name: "💎 Bounty" }], ...over,
});

test("reward parsing", () => {
  assert.equal(rewardUsd({ reward: { amount: 25000 } }), 250);
  assert.equal(rewardUsd({ reward_formatted: "$1,500" }), 1500);
  assert.equal(rewardUsd({}), null);
  assert.equal(parseUsd("💎 $2,000 bounty • acme"), 2000);
  assert.equal(parseUsd("no money here"), null);
});

test("reward is trusted only from the Algora bot", () => {
  const comments = [
    { user: { login: "someone" }, body: "💎 I'd do it for $20" },
    { user: { login: "algora-pbc[bot]", type: "Bot" }, body: "## 💎 $500 bounty • Acme\n### Steps to solve:" },
  ];
  assert.equal(rewardFromComments(comments), 500);
  assert.equal(rewardFromComments([{ user: { login: "x" }, body: "/bounty $900 💎" }]), null);
  assert.equal(rewardFromComments([{ user: { login: "other-bot[bot]" }, body: "$900" }]), null);
});

test("the bot's own /attempt instructions don't count as competition", () => {
  const c = competition([
    { user: { login: "algora-pbc[bot]", type: "Bot" }, body: "Comment `/attempt #3` to start. Submit with `/claim #3`." },
    { user: { login: "dev1" }, body: "/attempt #3" },
  ]);
  assert.deepEqual(c, { attempts: 1, claims: 0, total: 1 });
});

test("search items map to bounties, with a reward from labels or title when present", () => {
  const b = fromSearchItem(searchItem(7, { labels: [{ name: "💎 Bounty" }, { name: "$300" }] }), "typescript");
  assert.equal(b.id, "gh-9007");
  assert.deepEqual(b.task, { repo_owner: "acme", repo_name: "app", number: 7, title: "Issue 7", url: "https://github.com/acme/app/issues/7" });
  assert.equal(rewardUsd(b), 300);
  assert.equal(rewardUsd(fromSearchItem(searchItem(8, { title: "[$150] Add export" }), "typescript")), 150);
  assert.equal(rewardUsd(fromSearchItem(searchItem(9), "typescript")), null);
});

test("filter drops known-small, wrong-tech and old bounties; keeps unknown rewards", () => {
  const items = [
    bounty("keep"),
    bounty("unknown", { reward_formatted: null }),
    bounty("small", { reward_formatted: "$20" }),
    bounty("rust", { tech: ["rust"] }),
    bounty("old", { created_at: "2026-01-01T00:00:00Z" }),
  ];
  const kept = filterBounties(items, { tech: ["typescript"], minUsd: 50, maxAgeDays: 30, now: NOW }).map((b) => b.id);
  assert.deepEqual(kept, ["keep", "unknown"]);
});

test("seen ids come from hidden markers, including digests", () => {
  const seen = seenIdsFrom([{ body: "x <!-- algora:gh-1 -->" }, { body: "<!-- algora:gh-2 -->\n<!-- algora:gh-3 -->" }, { body: null }]);
  assert.deepEqual([...seen].sort(), ["gh-1", "gh-2", "gh-3"]);
});

test("competition and verdict", () => {
  const c = competition([{ body: "/attempt #12" }, { body: "nice" }, { body: "I will /attempt this" }, { body: "/claim #12" }]);
  assert.deepEqual(c, { attempts: 2, claims: 1, total: 4 });
  assert.equal(verdict({ attempts: 0, claims: 0 }).light, "🟢");
  assert.equal(verdict({ attempts: 2, claims: 0 }).light, "🟡");
  assert.equal(verdict({ attempts: 3, claims: 0 }).light, "🔴");
  assert.equal(verdict({ attempts: 0, claims: 1 }).light, "🔴");
  assert.equal(verdict({ attempts: 0, claims: 0 }, { assigned: true }).light, "🔴");
  assert.equal(verdict({ attempts: 0, claims: 0 }, { closed: true }).light, "⚫");
});

test("issue text carries the marker, the link and an unknown-safe reward", () => {
  const v = verdict({ attempts: 0, claims: 0 });
  assert.match(issueTitle(bounty("x9"), v), /^🟢 \$250 · acme\/app · Fix x9$/);
  assert.match(issueTitle(bounty("x8", { reward_formatted: null }), v), /^🟢 \$\? · /);
  const body = issueBody(bounty("x9"), v, { attempts: 0, claims: 0, total: 0 }, { mention: "habibdxb01" });
  assert.match(body, /<!-- algora:x9 -->/);
  assert.match(body, /https:\/\/github\.com\/acme\/app\/issues\/x9/);
  assert.match(body, /cc @habibdxb01/);
});

// Fake GitHub that records what would be posted.
function fakeGh({ ours = [], search = { typescript: [], javascript: [] }, targets = {} } = {}) {
  const created = [];
  return {
    created,
    searchBounties: async (lang) => search[lang] ?? [],
    ourIssues: async () => [...ours, ...created],
    ensureLabel: async () => {},
    targetIssue: async (o, n, num) => targets[num]?.issue ?? { state: "open", assignees: [] },
    targetComments: async (o, n, num) => targets[num]?.comments ?? [{ user: { login: "algora-pbc[bot]", type: "Bot" }, body: "💎 $200 bounty" }],
    createIssue: async (repo, title, body) => { created.push({ title, body }); return {}; },
  };
}
const cfg = config({ GITHUB_REPOSITORY: "habibdxb01/bounty-watcher", GITHUB_TOKEN: "t" });

test("search results across languages are de-duplicated", async () => {
  const gh = fakeGh({ search: { typescript: [searchItem(1), searchItem(2)], javascript: [searchItem(2), searchItem(3)] } });
  const out = await fetchBounties(gh, ["typescript", "javascript"]);
  assert.deepEqual(out.map((b) => b.id), ["gh-9001", "gh-9002", "gh-9003"]);
});

test("a failed search fails the run instead of reporting zero", async () => {
  const gh = fakeGh();
  gh.searchBounties = async () => { throw new Error("GitHub GET /search/issues → 403"); };
  await assert.rejects(run({ cfg, gh, log: () => {} }), /403/);
});

test("first run posts one digest, later runs post only new bounties", async () => {
  const gh = fakeGh({ search: { typescript: [searchItem(1), searchItem(2)] } });
  assert.equal((await run({ cfg, gh, log: () => {} })).created, 1);
  assert.match(gh.created[0].title, /2 open bounties/);
  assert.match(gh.created[0].body, /\$200/);

  assert.equal((await run({ cfg, gh, log: () => {} })).created, 0);

  const gh2 = fakeGh({
    ours: gh.created,
    search: { typescript: [searchItem(1), searchItem(2), searchItem(3)] },
    targets: { 3: { comments: [{ user: { login: "algora-pbc[bot]" }, body: "💎 $400 bounty" }, { body: "/attempt #3" }] } },
  });
  assert.equal((await run({ cfg, gh: gh2, log: () => {} })).created, 1);
  assert.match(gh2.created[0].title, /^🟡 \$400 · acme\/app · Issue 3$/);
});

test("closed and too-small bounties are not announced; unreadable ones are, for a manual check", async () => {
  const gh = fakeGh({
    ours: [{ body: "<!-- algora:seed -->" }],
    search: { typescript: [searchItem(5), searchItem(6), searchItem(7)] },
    targets: {
      5: { issue: { state: "closed", assignees: [] } },
      6: { comments: [{ user: { login: "algora-pbc[bot]" }, body: "💎 $25 bounty" }] },
    },
  });
  const realComments = gh.targetComments;
  gh.targetComments = async (o, n, num) => { if (num === 7) throw new Error("rate limited"); return realComments(o, n, num); };
  const r = await run({ cfg, gh, log: () => {} });
  assert.equal(r.created, 1);
  assert.match(gh.created[0].title, /^⚪ \$\? · /);
});

test("self-declared bounties without Algora funding are never announced, but are recorded", async () => {
  const gh = fakeGh({
    search: { typescript: [searchItem(10, { title: "[$900] Fix bridge" }), searchItem(11)] },
    targets: { 10: { comments: [{ user: { login: "owner" }, body: "/bounty $900" }] } },
  });
  assert.equal((await run({ cfg, gh, log: () => {} })).created, 1);
  assert.match(gh.created[0].title, /1 open bounties/);
  assert.match(gh.created[0].body, /algora:gh-9010/); // recorded so it isn't re-checked
  assert.doesNotMatch(gh.created[0].body, /Fix bridge/);
});

test("a digest is posted whenever nothing has been recorded yet, even if other issues exist", async () => {
  const gh = fakeGh({ ours: [{ body: "old digest, markers removed" }], search: { typescript: [searchItem(12)] } });
  await run({ cfg, gh, log: () => {} });
  assert.match(gh.created[0].title, /open bounties right now/);
});

test("dry run posts nothing", async () => {
  const gh = fakeGh({ ours: [{ body: "<!-- algora:seed -->" }], search: { typescript: [searchItem(8)] } });
  const r = await run({ cfg: { ...cfg, dryRun: true }, gh, log: () => {} });
  assert.equal(gh.created.length, 0);
  assert.equal(r.wouldCreate, 1);
});
