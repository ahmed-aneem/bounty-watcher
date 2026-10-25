import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsd } from "../src/core.mjs";

test("enhanced reward parsing: USD suffix and trailing dollar", () => {
  // Original formats (already supported)
  assert.equal(parseUsd("💎 $2,000 bounty • acme"), 2000);
  assert.equal(parseUsd("$100"), 100);

  // New formats (fixes bug where 100 USD or 250$ returned null)
  assert.equal(parseUsd("Reward: 100 USD"), 100, "100 USD should be parsed as 100");
  assert.equal(parseUsd("Bounty: 250$"), 250, "250$ should be parsed as 250");
  assert.equal(parseUsd("Fixed reward of 1,500 USDC on merge"), 1500, "1,500 USDC should be parsed as 1500");
});
