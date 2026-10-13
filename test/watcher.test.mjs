import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rewardUsd, filterBounties, seenIdsFrom, competition, verdict, issueTitle, issueBody,
} from "../src/core.mjs";
import { run, fetchBounties, config } from "../src/run.mjs";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const bounty = (id, over = {}) => ({
  id, status: "active", reward_type: "cash",
  reward: { amount: 25000, currency: "USD" }, reward_formatted: "$250",
  created_at: new Date("2026-10-13T20:00:00Z"),
  org: { handle: "acme", tech: ["TypeScript"] },
  task: { repo_owner: "acme", repo_name: "app", number: Number(id.replace(/\D/g, "")) || 1, title: `Fix ${id}`, url: `https://github.com/acme/app/issues/${id}` },
  ...over,
});

test("reward converts cents and falls back to the formatted string", () => {
  assert.equal(rewardUsd(bounty("a")), 250);
  assert.equal(rewardUsd({ reward: null, reward_formatted: "$1,500" }), 1500);
  assert.equal(rewardUsd({}), 0);
});

test("filter keeps matching cash bounties and drops the rest", () => {
  const items = [
    bounty("keep"),
    bounty("rust", { org: { tech: ["Rust"] } }),
    bounty("small", { reward: { amount: 2000 } }),
    bounty("points", { reward_type: "point" }),
    bounty("inactive", { status: "inactive" }),
    bounty("untagged", { org: { tech: [] } }),
    bounty("old", { created_at: new Date("2026-01-01") }),
  ];
  const kept = filterBounties(items, { tech: ["typescript"], minUsd: 50, maxAgeDays: 30, now: NOW }).map((b) => b.id);
  assert.deepEqual(kept, ["keep", "untagged"]);
});

test("seen ids come from hidden markers, including digests", () => {
  const seen = seenIdsFrom([{ body: "x <!-- algora:a1 -->" }, { body: "<!-- algora:b2 -->\n<!-- algora:c3 -->" }, { body: null }]);
  assert.deepEqual([...seen].sort(), ["a1", "b2", "c3"]);
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

test("issue text carries the marker and the link", () => {
  const b = bounty("x9");
  const v = verdict({ attempts: 0, claims: 0 });
  assert.match(issueTitle(b, v), /^🟢 \$250 · acme\/app · Fix x9$/);
  const body = issueBody(b, v, { attempts: 0, claims: 0, total: 0 }, { mention: "habibdxb01" });
  assert.match(body, /<!-- algora:x9 -->/);
  assert.match(body, /https:\/\/github\.com\/acme\/app\/issues\/x9/);
  assert.match(body, /cc @habibdxb01/);
});

test("pagination follows next_cursor and stops", async () => {
  const calls = [];
  const list = async (p) => { calls.push(p.cursor ?? null); return p.cursor ? { items: [bounty("b")] } : { items: [bounty("a")], next_cursor: "c1" }; };
  const out = await fetchBounties(list, [], () => {});
  assert.deepEqual(out.map((b) => b.id), ["a", "b"]);
  assert.deepEqual(calls, [null, "c1"]);
});

test("an empty global list falls back to orgs", async () => {
  const list = async (p) => ({ items: p.org ? [bounty(p.org + "1")] : [] });
  const out = await fetchBounties(list, ["acme"], () => {});
  assert.deepEqual(out.map((b) => b.id), ["acme1"]);
});

test("fails loudly when Algora is unreachable", async () => {
  const list = async () => { throw new Error("fetch failed"); };
  await assert.rejects(fetchBounties(list, ["a", "b"], () => {}), /unreachable/);
});

test("falls back to per-org listing when the global list fails", async () => {
  const list = async (p) => { if (!p.org) throw new Error("org required"); if (p.org === "bad") throw new Error("nope"); return { items: [bounty(p.org + "1")] }; };
  const out = await fetchBounties(list, ["acme", "bad", "beta"], () => {});
  assert.deepEqual(out.map((b) => b.id), ["acme1", "beta1"]);
});

// Fake GitHub that records what would be posted.
function fakeGh({ ours = [], targets = {} } = {}) {
  const created = [];
  return {
    created,
    ourIssues: async () => [...ours, ...created],
    ensureLabel: async () => {},
    targetIssue: async (o, n, num) => targets[num]?.issue ?? { state: "open", assignees: [] },
    targetComments: async (o, n, num) => targets[num]?.comments ?? [],
    createIssue: async (repo, title, body) => { created.push({ title, body }); return {}; },
  };
}
const cfg = config({ GITHUB_REPOSITORY: "habibdxb01/bounty-watcher", GITHUB_TOKEN: "t" });

test("first run posts one digest, second run posts only new bounties", async () => {
  const gh = fakeGh();
  let items = [bounty("1"), bounty("2")];
  const list = async () => ({ items });
  const first = await run({ cfg, list, gh, log: () => {} });
  assert.equal(first.created, 1);
  assert.match(gh.created[0].title, /2 open bounties/);

  // Nothing new → nothing posted.
  assert.equal((await run({ cfg, list, gh, log: () => {} })).created, 0);

  // One new bounty, with competition.
  items = [...items, bounty("3")];
  gh.created.length; // keep digest in "ours"
  const targets = { 3: { comments: [{ body: "/attempt #3" }] } };
  const gh2 = fakeGh({ ours: gh.created, targets });
  const third = await run({ cfg, list, gh: gh2, log: () => {} });
  assert.equal(third.created, 1);
  assert.match(gh2.created[0].title, /^🟡 \$250 · acme\/app · Fix 3$/);
});

test("closed issues are never announced; read errors still announce for a manual check", async () => {
  const ours = [{ body: "<!-- algora:0 -->" }];
  const targets = { 5: { issue: { state: "closed", assignees: [] } } };
  const gh = fakeGh({ ours, targets });
  gh.targetComments = async (o, n, num) => { if (num === 6) throw new Error("rate limited"); return []; };
  const list = async () => ({ items: [bounty("5"), bounty("6")] });
  const r = await run({ cfg, list, gh, log: () => {} });
  assert.equal(r.created, 1);
  assert.match(gh.created[0].title, /^⚪ /);
});

test("dry run posts nothing", async () => {
  const gh = fakeGh({ ours: [{ body: "<!-- algora:0 -->" }] });
  const r = await run({ cfg: { ...cfg, dryRun: true }, list: async () => ({ items: [bounty("7")] }), gh, log: () => {} });
  assert.equal(gh.created.length, 0);
  assert.equal(r.wouldCreate, 1);
});
