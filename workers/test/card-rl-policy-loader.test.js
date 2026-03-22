import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeCardRlPolicy, resetRuntimeCardRlPolicyCache } from "../src/card-rl-policy-loader.js";

test("card policy loader falls back cleanly when binding is missing", async () => {
  resetRuntimeCardRlPolicyCache();
  const policy = await getRuntimeCardRlPolicy({});
  assert.equal(policy.metadata.loadedFrom, "heuristic");
  assert.equal(policy.model, null);
});

test("card policy loader reads metadata and model from kv", async () => {
  resetRuntimeCardRlPolicyCache();
  const env = {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { version: "test-v1", compatibilityVersion: 1 };
        }
        if (key === "card-policy:model") {
          return { quoteTemplates: [], quoteHead: { weights: [], bias: [] }, takeHead: {}, revealHead: {} };
        }
        return null;
      },
    },
  };

  const policy = await getRuntimeCardRlPolicy(env);
  assert.equal(policy.metadata.version, "test-v1");
  assert.deepEqual(policy.model.quoteTemplates, []);
});
