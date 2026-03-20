import { RL_POLICY_KV_BINDING, RL_POLICY_KV_KEYS } from "./rl-policy-kv.js";

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
    maker: {},
    takerModes: {},
    taker: {},
  };
}

async function loadPolicyFromKv(namespace) {
  const [metadata, maker, takerModes, taker] = await Promise.all([
    namespace.get(RL_POLICY_KV_KEYS.metadata, "json"),
    namespace.get(RL_POLICY_KV_KEYS.maker, "json"),
    namespace.get(RL_POLICY_KV_KEYS.takerModes, "json"),
    namespace.get(RL_POLICY_KV_KEYS.taker, "json"),
  ]);

  if (!maker || !takerModes || !taker) {
    return emptyPolicy("kv_incomplete");
  }

  return {
    metadata: {
      ...(metadata || {}),
      loadedFrom: "kv",
      binding: RL_POLICY_KV_BINDING,
    },
    maker,
    takerModes,
    taker,
  };
}

export async function getRuntimeRlPolicy(env) {
  if (cachedPolicy) {
    return cachedPolicy;
  }

  const namespace = env?.[RL_POLICY_KV_BINDING];
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

export function resetRuntimeRlPolicyCache() {
  cachedPolicy = null;
  loadPromise = null;
  lastFailureAt = 0;
}
