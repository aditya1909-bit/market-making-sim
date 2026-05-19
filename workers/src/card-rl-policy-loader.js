import { CARD_RL_POLICY_COMPAT_VERSION } from "./card-rl-policy-config.js";
import { CARD_RL_POLICY_KV_BINDING, CARD_RL_POLICY_KV_KEYS } from "./card-rl-policy-kv.js";

const LOAD_FAILURE_RETRY_MS = 30_000;

let cachedRegistry = null;
let loadPromise = null;
let lastFailureAt = 0;

function emptyRegistry(reason, error = null) {
  return {
    metadata: {
      source: "runtime-fallback",
      loadedFrom: "heuristic",
      compatibilityVersion: CARD_RL_POLICY_COMPAT_VERSION,
      reason,
      error,
      defaultPolicyIds: {},
    },
    policies: {},
  };
}

function normalizePolicyEntry(entry, fallbackId = "heuristic") {
  if (!entry?.model) {
    return null;
  }
  const policyId = String(entry.id || entry.version || fallbackId);
  return {
    id: policyId,
    family: String(entry.family || entry.model?.modelType || "linear").startsWith("neural") ? "neural" : String(entry.family || "linear"),
    version: String(entry.version || policyId),
    compatibilityVersion: Number(entry.compatibilityVersion || entry.model?.compatibilityVersion || 0),
    source: entry.source || "kv",
    evaluation: entry.evaluation || {},
    model: entry.model,
  };
}

function normalizeLegacyPolicy(metadata, model) {
  if (!model) {
    return emptyRegistry("kv_incomplete");
  }
  const policyId = String(metadata?.version || "linear-v1");
  return {
    metadata: {
      ...(metadata || {}),
      loadedFrom: "kv",
      binding: CARD_RL_POLICY_KV_BINDING,
      compatibilityVersion: Number(metadata?.compatibilityVersion || model?.compatibilityVersion || 1),
      defaultPolicyIds: { linear: policyId },
    },
    policies: {
      [policyId]: {
        id: policyId,
        family: "linear",
        version: policyId,
        compatibilityVersion: Number(metadata?.compatibilityVersion || model?.compatibilityVersion || 1),
        source: metadata?.source || "kv:legacy",
        evaluation: {},
        model,
      },
    },
  };
}

function normalizeRegistry(metadata, payload) {
  const policyEntries = {};
  Object.entries(payload?.policies || {}).forEach(([policyId, entry]) => {
    const normalized = normalizePolicyEntry(entry, policyId);
    if (normalized) {
      policyEntries[normalized.id] = normalized;
    }
  });
  return {
    metadata: {
      ...(metadata || {}),
      ...(payload?.metadata || {}),
      loadedFrom: "kv",
      binding: CARD_RL_POLICY_KV_BINDING,
      compatibilityVersion: Number(payload?.metadata?.compatibilityVersion || metadata?.compatibilityVersion || 0),
      defaultPolicyIds: payload?.metadata?.defaultPolicyIds || metadata?.defaultPolicyIds || {},
    },
    policies: policyEntries,
  };
}

async function loadRegistryFromKv(namespace) {
  const [metadata, registry, model] = await Promise.all([
    namespace.get(CARD_RL_POLICY_KV_KEYS.metadata, "json"),
    namespace.get(CARD_RL_POLICY_KV_KEYS.registry, "json"),
    namespace.get(CARD_RL_POLICY_KV_KEYS.model, "json"),
  ]);
  if (registry?.policies) {
    return normalizeRegistry(metadata, registry);
  }
  return normalizeLegacyPolicy(metadata, model);
}

export async function getRuntimeCardRlPolicyRegistry(env) {
  if (cachedRegistry) {
    return cachedRegistry;
  }

  const namespace = env?.[CARD_RL_POLICY_KV_BINDING];
  if (!namespace) {
    cachedRegistry = emptyRegistry("kv_unbound");
    return cachedRegistry;
  }

  const now = Date.now();
  if (!loadPromise && lastFailureAt && now - lastFailureAt < LOAD_FAILURE_RETRY_MS) {
    return emptyRegistry("kv_retry_backoff");
  }

  if (!loadPromise) {
    loadPromise = loadRegistryFromKv(namespace)
      .then((registry) => {
        cachedRegistry = registry;
        return registry;
      })
      .catch((error) => {
        lastFailureAt = Date.now();
        return emptyRegistry("kv_load_failed", error?.message || String(error));
      })
      .finally(() => {
        loadPromise = null;
      });
  }

  return loadPromise;
}

export async function getRuntimeCardRlPolicy(env, policyId = null) {
  const registry = await getRuntimeCardRlPolicyRegistry(env);
  if (policyId && registry.policies?.[policyId]) {
    return registry.policies[policyId];
  }
  const defaultId = registry.metadata?.defaultPolicyIds?.linear || Object.keys(registry.policies || {})[0] || null;
  return defaultId ? registry.policies[defaultId] : { metadata: registry.metadata, model: null };
}

export function registryPolicyIdsByFamily(registry, family) {
  return Object.values(registry?.policies || {})
    .filter((entry) => entry?.family === family && Number(entry.compatibilityVersion || 0) === CARD_RL_POLICY_COMPAT_VERSION)
    .map((entry) => entry.id);
}

export function resetRuntimeCardRlPolicyCache() {
  cachedRegistry = null;
  loadPromise = null;
  lastFailureAt = 0;
}
