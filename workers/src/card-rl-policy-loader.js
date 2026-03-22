import { CARD_RL_POLICY_KV_BINDING, CARD_RL_POLICY_KV_KEYS } from "./card-rl-policy-kv.js";

const LOAD_FAILURE_RETRY_MS = 30_000;

let cachedPolicy = null;
let loadPromise = null;
let lastFailureAt = 0;

function emptyPolicy(reason, error = null) {
  return {
    metadata: {
      source: "runtime-fallback",
      loadedFrom: "heuristic",
      reason,
      error,
    },
    model: null,
  };
}

async function loadPolicyFromKv(namespace) {
  const [metadata, model] = await Promise.all([
    namespace.get(CARD_RL_POLICY_KV_KEYS.metadata, "json"),
    namespace.get(CARD_RL_POLICY_KV_KEYS.model, "json"),
  ]);

  if (!model) {
    return emptyPolicy("kv_incomplete");
  }

  return {
    metadata: {
      ...(metadata || {}),
      loadedFrom: "kv",
      binding: CARD_RL_POLICY_KV_BINDING,
    },
    model,
  };
}

export async function getRuntimeCardRlPolicy(env) {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  const namespace = env?.[CARD_RL_POLICY_KV_BINDING];
  if (!namespace) {
    cachedPolicy = emptyPolicy("kv_unbound");
    return cachedPolicy;
  }

  const now = Date.now();
  if (!loadPromise && lastFailureAt && now - lastFailureAt < LOAD_FAILURE_RETRY_MS) {
    return emptyPolicy("kv_retry_backoff");
  }

  if (!loadPromise) {
    loadPromise = loadPolicyFromKv(namespace)
      .then((policy) => {
        cachedPolicy = policy;
        return policy;
      })
      .catch((error) => {
        lastFailureAt = Date.now();
        return emptyPolicy("kv_load_failed", error?.message || String(error));
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}

export function resetRuntimeCardRlPolicyCache() {
  cachedPolicy = null;
  loadPromise = null;
  lastFailureAt = 0;
}
