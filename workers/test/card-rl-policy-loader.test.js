import test from "node:test";
import assert from "node:assert/strict";

import { getRuntimeCardRlPolicy, getRuntimeCardRlPolicyRegistry, resetRuntimeCardRlPolicyCache } from "../src/card-rl-policy-loader.js";

test("card policy loader falls back cleanly when binding is missing", async () => {
  resetRuntimeCardRlPolicyCache();
  const registry = await getRuntimeCardRlPolicyRegistry({});
  assert.equal(registry.metadata.loadedFrom, "heuristic");
  assert.deepEqual(registry.policies, {});
});

test("card policy loader reads registry payloads from kv", async () => {
  resetRuntimeCardRlPolicyCache();
  const env = {
    CARD_RL_POLICY_KV: {
      async get(key) {
        if (key === "card-policy:metadata") {
          return { defaultPolicyIds: { linear: "linear-v2", neural: "neural-v1" }, compatibilityVersion: 2 };
        }
        if (key === "card-policy:registry") {
          return {
            metadata: { compatibilityVersion: 2, defaultPolicyIds: { linear: "linear-v2", neural: "neural-v1" } },
            policies: {
              "linear-v2": {
                id: "linear-v2",
                family: "linear",
                version: "linear-v2",
                compatibilityVersion: 2,
                model: { modelType: "linear", quoteTemplates: [], intentHead: { weights: [], bias: [] }, quoteHead: { weights: [], bias: [] }, takeHead: {}, revealHead: {} },
              },
              "neural-v1": {
                id: "neural-v1",
                family: "neural",
                version: "neural-v1",
                compatibilityVersion: 2,
                model: { modelType: "neural_mlp", hiddenSize: 4, trunk: { weights: [], bias: [] }, intentHead: { weights: [], bias: [] }, quoteHead: { stateWeights: [], templateWeights: [], bias: [] }, takeHead: {}, revealHead: {} },
              },
            },
          };
        }
        return null;
      },
    },
  };

  const registry = await getRuntimeCardRlPolicyRegistry(env);
  assert.equal(registry.metadata.defaultPolicyIds.linear, "linear-v2");
  assert.equal(registry.policies["neural-v1"].family, "neural");

  const defaultPolicy = await getRuntimeCardRlPolicy(env);
  assert.equal(defaultPolicy.id, "linear-v2");
});
