import { createProviderRegistry } from "./provider-registry.mjs";

let providerCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 30_000;

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function buildRegistry(options = {}) {
  return createProviderRegistry({
    env: options.env || process.env,
    settings: options.settings || options.env || process.env,
    configExecutors: Array.isArray(options.configExecutors) ? options.configExecutors : [],
    adapters: options.adapters || {},
    includeBuiltins: true,
  });
}

function normalizeDiscoveredModel(providerId, entry = {}) {
  return {
    id: entry.id,
    name: entry.label || entry.name || entry.id,
    providerID: providerId,
    fullId: `${providerId}/${entry.id}`,
    status: "active",
    reasoning: entry.reasoningEffort != null,
    toolcall: true,
    limit: {
      context: Number.isFinite(Number(entry.contextWindow)) ? Number(entry.contextWindow) : 0,
      output: 0,
    },
    cost: { input: 0, output: 0 },
  };
}

function normalizeDiscoveredProvider(entry = {}, authHealth = null, modelCatalog = null) {
  const models = Array.isArray(modelCatalog?.models)
    ? modelCatalog.models.map((model) => normalizeDiscoveredModel(entry.providerId, model))
    : [];
  const envKeys = [
    ...(Array.isArray(authHealth?.env?.apiKey?.keys) ? authHealth.env.apiKey.keys : []),
    ...(Array.isArray(authHealth?.env?.oauth?.keys) ? authHealth.env.oauth.keys : []),
    ...(Array.isArray(authHealth?.env?.subscription?.keys) ? authHealth.env.subscription.keys : []),
  ];
  return {
    id: entry.providerId,
    name: entry.name || entry.providerId,
    source: "registry",
    env: envKeys.filter(Boolean),
    connected: authHealth?.canRun === true || authHealth?.authenticated === true,
    models,
    authMethods: Array.isArray(authHealth?.methods)
      ? authHealth.methods.map((method) => ({
          type: method.type,
          label: method.type,
        }))
      : [],
  };
}

function buildSnapshot(registry) {
  const registrySnapshot = registry.getRegistrySnapshot();
  const providers = registrySnapshot.providers.map((entry) => normalizeDiscoveredProvider(
    entry,
    registrySnapshot.authHealth?.[entry.providerId] || null,
    registrySnapshot.modelCatalogs?.[entry.providerId] || null,
  ));
  const connected = providers.filter((entry) => entry.connected);
  return {
    providers,
    connected,
    connectedIds: connected.map((entry) => entry.id),
    defaults: Object.fromEntries(
      providers.map((entry) => [
        entry.id,
        registrySnapshot.modelCatalogs?.[entry.id]?.defaultModel || null,
      ]),
    ),
    allModels: providers.flatMap((entry) => entry.models),
    timestamp: registrySnapshot.timestamp || Date.now(),
  };
}

export async function discoverProviders(opts = {}) {
  if (!opts.force && providerCache.data && Date.now() - providerCache.ts < CACHE_TTL_MS) {
    return providerCache.data;
  }
  const snapshot = buildSnapshot(buildRegistry(opts));
  providerCache = { data: snapshot, ts: Date.now() };
  return snapshot;
}

export async function getConnectedProviders(opts = {}) {
  const snapshot = await discoverProviders(opts);
  return snapshot.connected;
}

export async function getProviderModels(providerID, opts = {}) {
  const snapshot = await discoverProviders(opts);
  return snapshot.allModels.filter((entry) => entry.providerID === toTrimmedString(providerID));
}

export async function isProviderConnected(providerID, opts = {}) {
  const snapshot = await discoverProviders(opts);
  return snapshot.connectedIds.includes(toTrimmedString(providerID));
}

export function formatProvidersForMenu(providers, opts = {}) {
  const { showModelCount = true, showConnected = true } = opts;
  return providers.map((provider) => {
    const parts = [provider.name || provider.id];
    if (showConnected) parts.push(provider.connected ? " ✓" : " ○");
    if (showModelCount && provider.models?.length) parts.push(` (${provider.models.length} models)`);
    return parts.join("");
  });
}

export function formatModelsForMenu(models) {
  return models.map((model) => {
    const parts = [model.fullId];
    if (model.reasoning) parts.push(" 🧠");
    if (model.toolcall) parts.push(" 🔧");
    if (model.limit?.context) parts.push(` (${Math.round(model.limit.context / 1000)}k ctx)`);
    return parts.join("");
  });
}

export function buildExecutorEntry(providerID, modelFullId, overrides = {}) {
  return {
    name: `opencode-${providerID}`,
    executor: "OPENCODE",
    weight: overrides.weight ?? 100,
    provider: providerID,
    providerConfig: {
      model: modelFullId,
      ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
      ...(overrides.port ? { port: overrides.port } : {}),
      ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    },
  };
}

export function invalidateCache() {
  providerCache = { data: null, ts: 0 };
}
