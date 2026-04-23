import { normalizeExecutorKey } from "../task/task-complexity.mjs";
import { createProviderAuthManager } from "./provider-auth-manager.mjs";
import { getProviderCapabilities, normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getProviderModelCatalog } from "./provider-model-catalog.mjs";
import {
  buildProviderRegistryContract,
  normalizeProviderInventoryEntry,
  normalizeProviderSelection,
} from "./providers/provider-contract.mjs";
import {
  getBuiltInProviderDriver,
  getBuiltinProviderDefinition,
  listBuiltinProviderDefinitions,
  normalizeProviderDefinitionId,
  resolveProviderAdapterId,
} from "./providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function lookupEnvValue(envInput = {}, key = "") {
  const normalizedKey = toTrimmedString(key);
  if (!normalizedKey) return "";
  const env = envInput && typeof envInput === "object" ? envInput : process.env;
  const directValue = toTrimmedString(env?.[normalizedKey]);
  if (directValue) return directValue;
  const lowerKey = normalizedKey.toLowerCase();
  for (const [candidateKey, candidateValue] of Object.entries(env || {})) {
    if (String(candidateKey || "").trim().toLowerCase() !== lowerKey) continue;
    const resolvedValue = toTrimmedString(candidateValue);
    if (resolvedValue) return resolvedValue;
  }
  return "";
}

function looksLikeCanonicalEnvBinding(value = "") {
  return /^[A-Z_][A-Z0-9_]*$/.test(toTrimmedString(value));
}

function resolveBoundCredentialValue(envInput = {}, bindingRef = "") {
  const normalizedBindingRef = toTrimmedString(bindingRef);
  if (!normalizedBindingRef) return "";
  const envValue = lookupEnvValue(envInput, normalizedBindingRef);
  if (envValue) return envValue;
  if (!looksLikeCanonicalEnvBinding(normalizedBindingRef)) {
    return normalizedBindingRef;
  }
  return "";
}

function envFlagEnabled(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

const NATIVE_PROVIDER_ADAPTERS = new Map([
  ["openai-responses", "openai-native"],
  ["azure-openai-responses", "openai-native"],
  ["openai-compatible", "openai-native"],
  ["ollama", "openai-native"],
  ["anthropic-messages", "anthropic-native"],
  ["gemini-generate-content", "gemini-native"],
  ["openrouter", "openai-native"],
  ["perplexity", "openai-native"],
  ["deepinfra", "openai-native"],
  ["groq", "openai-native"],
  ["together", "openai-native"],
  ["xai", "openai-native"],
  ["fireworks", "openai-native"],
  ["cerebras", "openai-native"],
  ["sambanova", "openai-native"],
  ["nebius", "openai-native"],
]);

export function normalizeProviderAdapterName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if ([
    "anthropic-native",
    "gemini-native",
    "openai-native",
    "codex-sdk",
    "copilot-sdk",
    "claude-sdk",
    "gemini-sdk",
    "opencode-sdk",
  ].includes(normalized)) {
    return normalized;
  }
  const adapterId = resolveProviderAdapterId(value);
  if (adapterId) return adapterId;
  if (normalized === "anthropic-native") return "anthropic-native";
  if (normalized === "gemini-native") return "gemini-native";
  if (normalized === "openai-native") return "openai-native";
  if (normalized === "github-copilot") return "copilot-sdk";
  if (normalized === "claude_code" || normalized === "claude-code") return "claude-sdk";
  if (normalized === "google-gemini" || normalized === "gemini" || normalized === "gemini-sdk") return "gemini-sdk";
  if (["openrouter", "perplexity", "deepinfra", "groq", "together", "xai", "fireworks", "cerebras", "sambanova", "nebius"].includes(normalized)) return "openai-native";
  if (normalized === "open-code" || normalized === "opencode" || normalized === "opencode-sdk") return "opencode-sdk";
  if (normalized === "copilot" || normalized === "copilot-sdk") return "copilot-sdk";
  if (normalized === "claude" || normalized === "claude-sdk" || normalized === "anthropic") return "claude-sdk";
  if (normalized === "ollama") return "opencode-sdk";
  return "codex-sdk";
}

export function executorToAdapterName(executor) {
  const key = normalizeExecutorKey(executor);
  if (key === "codex" || key === "openai") return "codex-sdk";
  if (key === "copilot") return "copilot-sdk";
  if (key === "claude" || key === "anthropic") return "claude-sdk";
  if (key === "gemini") return "gemini-sdk";
  if (key === "opencode" || key === "ollama" || key === "openai-compatible") return "opencode-sdk";
  const definition = getBuiltinProviderDefinition(key);
  if (definition?.adapterId) return definition.adapterId;
  return "codex-sdk";
}

function resolveDisabled(definition, env = process.env) {
  const providerKey = String(definition?.id || "").replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  const adapterKey = String(definition?.adapterId || "").replace(/[^a-z0-9]+/gi, "_").toUpperCase();
  const providerDisabled = providerKey ? envFlagEnabled(env?.[`${providerKey}_DISABLED`]) : false;
  const adapterDisabled = adapterKey ? envFlagEnabled(env?.[`${adapterKey}_DISABLED`]) : false;
  return providerDisabled || adapterDisabled;
}

function buildCapabilities(adapter, providerId, getAdapterCapabilities) {
  const providerCapabilities = getProviderCapabilities(providerId);
  const adapterCapabilities =
    typeof getAdapterCapabilities === "function"
      ? getAdapterCapabilities(adapter, providerId)
      : {};
  return {
    ...providerCapabilities,
    ...adapterCapabilities,
  };
}

function resolveRuntimeAdapterId(providerId, definition, options = {}, entry = null) {
  const explicitAdapterId = toTrimmedString(entry?.adapterId || "");
  if (explicitAdapterId) {
    return normalizeProviderAdapterName(explicitAdapterId);
  }
  if (
    options.preferNativeAdapters !== true
    && entry
    && !toTrimmedString(entry?.providerId)
    && !toTrimmedString(entry?.adapterId)
    && toTrimmedString(entry?.executor)
  ) {
    const legacyAdapterId = executorToAdapterName(entry.executor);
    if (legacyAdapterId) {
      return legacyAdapterId;
    }
  }
  const normalizedProviderId = normalizeProviderDefinitionId(providerId, "") || providerId;
  const preferredNativeAdapterId = NATIVE_PROVIDER_ADAPTERS.get(normalizedProviderId);
  if (
    options.preferNativeAdapters === true
    && preferredNativeAdapterId
    && options.adapters?.[preferredNativeAdapterId]
  ) {
    return preferredNativeAdapterId;
  }
  return definition?.adapterId || normalizeProviderAdapterName(normalizedProviderId);
}

function normalizeAuthBindings(bindings = {}) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return {};
  return Object.fromEntries(
    Object.entries({
      apiKeyEnv: bindings.apiKeyEnv,
      oauthTokenEnv: bindings.oauthTokenEnv,
      subscriptionEnv: bindings.subscriptionEnv,
    }).map(([key, value]) => [key, toTrimmedString(value)]).filter(([, value]) => value),
  );
}

function applyBoundCredentialEnv(providerId, envInput = {}, bindings = {}) {
  const driver = getBuiltInProviderDriver(providerId);
  const env = envInput && typeof envInput === "object" ? envInput : process.env;
  const normalizedBindings = normalizeAuthBindings(bindings);
  if (!driver || Object.keys(normalizedBindings).length === 0) return env;
  const nextEnv = { ...env };
  const authHints = driver.auth?.env && typeof driver.auth.env === "object" ? driver.auth.env : {};
  const bindingMap = [
    ["apiKeyEnv", Array.isArray(authHints.apiKey) ? authHints.apiKey : []],
    ["oauthTokenEnv", Array.isArray(authHints.oauth) ? authHints.oauth : []],
    ["subscriptionEnv", Array.isArray(authHints.subscription) ? authHints.subscription : []],
  ];
  for (const [bindingKey, hintKeys] of bindingMap) {
    const sourceEnvKey = normalizedBindings[bindingKey];
    if (!sourceEnvKey) continue;
    const resolvedValue = resolveBoundCredentialValue(env, sourceEnvKey);
    if (!resolvedValue) continue;
    for (const hintKey of hintKeys) {
      const normalizedHintKey = toTrimmedString(hintKey);
      if (!normalizedHintKey) continue;
      nextEnv[normalizedHintKey] = resolvedValue;
    }
  }
  return nextEnv;
}

function resolveProviderAuth(providerId, fields, options) {
  const resolvedEnv = applyBoundCredentialEnv(
    providerId,
    options.env || process.env,
    fields?.authBindings,
  );
  const authManager = createProviderAuthManager({ env: resolvedEnv });
  const readAuthState = typeof options.readAuthState === "function"
    ? options.readAuthState
    : () => ({});
  const resolved = authManager.resolve(providerId, readAuthState(providerId, fields) || {}, {
    capabilities: buildCapabilities({}, providerId, null),
    enabled: fields.enabled,
    settings: options.settings || options.env || process.env,
    env: resolvedEnv,
  });
  const settings = {
    ...(resolved?.settings && typeof resolved.settings === "object" ? resolved.settings : {}),
  };
  const overrideFields = [
    "authMode",
    "defaultModel",
    "endpoint",
    "baseUrl",
    "deployment",
    "apiVersion",
    "workspace",
    "organization",
    "project",
  ];
  for (const field of overrideFields) {
    const value = toTrimmedString(fields?.[field]);
    if (!value) continue;
    settings[field] = value;
    settings[`${field}Source`] = "executor";
  }
  if (fields?.transportConfig && typeof fields.transportConfig === "object") {
    settings.transport = JSON.parse(JSON.stringify(fields.transportConfig));
  }
  return {
    ...resolved,
    preferredMode: toTrimmedString(fields?.authMode) || resolved?.preferredMode || null,
    authBindings: normalizeAuthBindings(fields?.authBindings),
    settings,
  };
}

function resolveProviderEnabled(providerId, explicitEnabled, options = {}) {
  if (explicitEnabled !== undefined) {
    return explicitEnabled === true;
  }
  const authManager = createProviderAuthManager({ env: options.env || process.env });
  const resolved = authManager.resolve(providerId, {}, {
    settings: options.settings || options.env || process.env,
    env: options.env || process.env,
  });
  return resolved?.enabled !== false;
}

function buildProviderEntry(providerId, definition, adapter, fields, options) {
  const configuredModels = Array.isArray(fields.models)
    ? fields.models.filter(Boolean)
    : [];
  const configuredModelIds = configuredModels
    .map((entry) => String(entry?.id || entry?.model || entry?.name || entry || "").trim())
    .filter(Boolean);
  const modelCatalog = getProviderModelCatalog(providerId, {
    adapter,
    executor: fields.executor,
    configuredModels,
    defaultModel: fields.defaultModel || definition?.defaultModel,
    local: getProviderCapabilities(providerId).local === true,
    settings: options.settings || options.env || process.env,
    env: options.env || process.env,
  });
  const capabilities = buildCapabilities(adapter, providerId, options.getAdapterCapabilities);
  return normalizeProviderInventoryEntry({
    id: fields.id,
    name: fields.name,
    providerId,
    provider: fields.provider,
    executor: fields.executor,
    variant: fields.variant,
    adapterId: fields.adapterId || definition?.adapterId || normalizeProviderAdapterName(providerId),
    transport: definition?.transport || null,
    transportConfig: fields.transportConfig || null,
    apiStyle: fields.apiStyle || definition?.transport?.apiStyle || null,
    available: fields.available,
    enabled: fields.enabled !== false,
    busy: fields.busy,
    source: fields.source || null,
    weight: fields.weight || 0,
    models: configuredModelIds.length > 0
      ? configuredModelIds
      : modelCatalog.models.map((entry) => entry.id),
    defaultModel: fields.defaultModel || modelCatalog.defaultModel,
    endpoint: fields.endpoint || null,
    baseUrl: fields.baseUrl || null,
    deployment: fields.deployment || null,
    apiVersion: fields.apiVersion || null,
    authBindings: normalizeAuthBindings(fields.authBindings),
    modelCatalog,
    auth: resolveProviderAuth(providerId, fields, options),
    capabilities,
    definition: definition ? { ...definition } : null,
  });
}

function resolveDefinitionFromEntry(entry = {}) {
  const direct = entry.providerId || entry.id || entry.adapterId || entry.executor || entry.provider;
  const normalizedProviderId = normalizeProviderDefinitionId(direct, "");
  const definition = getBuiltinProviderDefinition(normalizedProviderId || entry.adapterId || entry.executor);
  return {
    providerId: definition?.id || normalizeProviderCapabilityId(direct),
    definition,
  };
}

function buildConfiguredProviders(options = {}) {
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const env = options.env || process.env;
  const readBusy = typeof options.readBusy === "function"
    ? options.readBusy
    : () => false;
  const executors = Array.isArray(options.configExecutors)
    ? options.configExecutors
    : [];
  return executors.map((entry, index) => {
    const { providerId, definition } = resolveDefinitionFromEntry(entry);
    const adapterId = resolveRuntimeAdapterId(providerId, definition, options, entry);
    const adapter = adapters[adapterId] || adapters[definition?.adapterId] || adapters["codex-sdk"] || {};
    const enabled = resolveProviderEnabled(providerId, entry?.enabled !== false, options);
    const available = enabled && !resolveDisabled(definition || { id: providerId, adapterId }, env);
    const configuredModels = Array.isArray(entry?.models)
      ? entry.models.filter(Boolean)
      : [];
    const name = String(entry?.name || "").trim()
      || definition?.name
      || adapter.displayName
      || adapter.name
      || providerId;
    const selectionId = String(entry?.id || entry?.name || "").trim() || `${providerId}-${index + 1}`;
    return buildProviderEntry(
      providerId,
      definition,
      adapter,
      {
        id: selectionId,
        name,
        provider: definition?.provider || adapter.provider || String(entry?.executor || "").toUpperCase() || providerId,
        executor: definition?.executor || String(entry?.executor || "").toUpperCase() || adapter.provider || providerId,
        variant: String(entry?.variant || definition?.variant || "DEFAULT"),
        adapterId,
        available,
        enabled,
        busy: available ? readBusy(adapter) : false,
        models: configuredModels,
        defaultModel: entry?.defaultModel || definition?.defaultModel || null,
        authMode: entry?.authMode || null,
        endpoint: entry?.endpoint || null,
        baseUrl: entry?.baseUrl || null,
        deployment: entry?.deployment || null,
        apiVersion: entry?.apiVersion || null,
        workspace: entry?.workspace || null,
        organization: entry?.organization || null,
        project: entry?.project || null,
        authBindings: entry?.authBindings || null,
        source: entry?.source || "configured",
        weight: entry?.weight || 0,
        apiStyle: entry?.apiStyle || null,
        transportConfig: entry?.transport || entry?.transportConfig || null,
      },
      options,
    );
  });
}

function buildBuiltinProviders(options = {}) {
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const env = options.env || process.env;
  const readBusy = typeof options.readBusy === "function"
    ? options.readBusy
    : () => false;
  return listBuiltinProviderDefinitions().map((definition) => {
    const adapterId = resolveRuntimeAdapterId(definition.id, definition, options);
    const adapter = adapters[adapterId] || adapters[definition.adapterId] || adapters["codex-sdk"] || {};
    const enabled = resolveProviderEnabled(definition.id, undefined, options);
    const available = enabled && !resolveDisabled(definition, env);
    return buildProviderEntry(
      definition.id,
      definition,
      adapter,
      {
        id: definition.id,
        name: definition.name,
        provider: definition.provider,
        executor: definition.executor,
        variant: definition.variant || "DEFAULT",
        adapterId,
        available,
        enabled,
        busy: available ? readBusy(adapter) : false,
        models: [],
        defaultModel: definition.defaultModel || null,
      },
      options,
    );
  });
}

export function listRegisteredProviders(options = {}) {
  const configuredProviders = buildConfiguredProviders(options);
  if (configuredProviders.length === 0) return buildBuiltinProviders(options);
  if (options.includeBuiltins !== true) return configuredProviders;
  const builtins = buildBuiltinProviders(options);
  const seenProviderIds = new Set(configuredProviders.map((entry) => entry.providerId));
  return configuredProviders.concat(
    builtins.filter((entry) => !seenProviderIds.has(entry.providerId)),
  );
}

function resolveRequestedDefaultProviderId(options = {}) {
  const configuredDefault =
    options.defaultProviderId
    || options.settings?.BOSUN_PROVIDER_DEFAULT
    || options.env?.BOSUN_PROVIDER_DEFAULT
    || process.env.BOSUN_PROVIDER_DEFAULT
    || "";
  return normalizeProviderDefinitionId(configuredDefault, "");
}

export function resolveProviderSelection(name, options = {}) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const providers = Array.isArray(options.availableProviders)
    ? options.availableProviders
    : listRegisteredProviders(options);
  const exactIdMatch = providers.find((entry) => entry.id === raw);
  if (exactIdMatch) {
    return normalizeProviderSelection({
      providerId: exactIdMatch.providerId || normalizeProviderCapabilityId(exactIdMatch.id),
      adapterName: normalizeProviderAdapterName(
        exactIdMatch.adapterId || exactIdMatch.providerId || exactIdMatch.executor || exactIdMatch.provider,
      ),
      selectionId: exactIdMatch.id,
      model: exactIdMatch.defaultModel,
    });
  }
  const directProviderId = normalizeProviderDefinitionId(raw, "");
  if (directProviderId) {
    const providerMatch = providers.find((entry) => entry.providerId === directProviderId);
    if (providerMatch) {
      return normalizeProviderSelection({
        providerId: providerMatch.providerId,
        adapterName: normalizeProviderAdapterName(providerMatch.adapterId || providerMatch.providerId),
        selectionId: providerMatch.providerId,
        model: providerMatch.defaultModel,
      });
    }
  }
  const match = providers.find((entry) =>
    entry.adapterId === normalizeProviderAdapterName(raw));
  if (!match) return null;
  return normalizeProviderSelection({
    providerId: match.providerId || normalizeProviderCapabilityId(match.id),
    adapterName: normalizeProviderAdapterName(match.adapterId || match.providerId || match.executor || match.provider),
    selectionId: match.id,
    model: match.defaultModel,
  });
}

function getProviderList(options = {}) {
  return listRegisteredProviders(options).map((entry) => normalizeProviderInventoryEntry(entry));
}

function getEnabledProviders(options = {}) {
  return getProviderList(options).filter((entry) => entry.enabled !== false && entry.available !== false);
}

function resolveDefaultProvider(providers = [], options = {}) {
  const requestedDefaultProviderId = resolveRequestedDefaultProviderId(options);
  const enabledProviders = providers.filter((entry) => entry.enabled !== false && entry.available !== false);
  return enabledProviders.find((entry) => entry.providerId === requestedDefaultProviderId)
    || providers.find((entry) => entry.providerId === requestedDefaultProviderId && entry.enabled !== false)
    || enabledProviders[0]
    || providers.find((entry) => entry.enabled !== false)
    || providers[0]
    || null;
}

async function discoverRegistryRuntimeCatalog(providerId, options = {}) {
  const { discoverProviders } = await import("./provider-runtime-discovery.mjs");
  const snapshot = await discoverProviders(options);
  const normalizedProviderId = normalizeProviderDefinitionId(providerId, "");
  if (!normalizedProviderId) return snapshot;
  const matchedProviders = Array.isArray(snapshot?.providers)
    ? snapshot.providers.filter((entry) => entry.id === normalizedProviderId)
    : [];
  const matchedModels = Array.isArray(snapshot?.allModels)
    ? snapshot.allModels.filter((entry) => entry.providerID === normalizedProviderId)
    : [];
  return {
    ...snapshot,
    providers: matchedProviders,
    connected: matchedProviders.filter((entry) => entry.connected),
    connectedIds: matchedProviders.filter((entry) => entry.connected).map((entry) => entry.id),
    allModels: matchedModels,
  };
}

export function createProviderRegistry(options = {}) {
  const registry = {
    listProviders() {
      return getProviderList(options);
    },
    listEnabledProviders() {
      return getEnabledProviders(options);
    },
    getInventory() {
      const providers = getProviderList(options);
      return {
        providers,
        enabledProviders: providers.filter((entry) => entry.enabled !== false),
        availableProviders: providers.filter((entry) => entry.available !== false),
        defaultProvider: resolveDefaultProvider(providers, options),
      };
    },
    resolveSelection(name) {
      return resolveProviderSelection(name, options);
    },
    getProvider(providerId) {
      const normalized = normalizeProviderCapabilityId(providerId);
      const providers = getProviderList(options);
      return providers.find((entry) => entry.providerId === normalized || entry.id === providerId) || null;
    },
    getCapabilities(providerId) {
      return getProviderCapabilities(providerId);
    },
    getDefinition(providerId) {
      return getBuiltinProviderDefinition(providerId);
    },
    getModelCatalog(providerId) {
      const provider = this.getProvider(providerId);
      return provider?.modelCatalog || getProviderModelCatalog(providerId, {
        settings: options.settings || options.env || process.env,
        env: options.env || process.env,
      });
    },
    getAuthHealth(providerId, authState = {}) {
      return this.getAuthState(providerId, authState);
    },
    getAuthState(providerId, authState = {}) {
      const provider = this.getProvider(providerId);
      return provider?.auth || resolveProviderAuth(providerId, authState, options);
    },
    buildSessionConfig(providerId, overrides = {}) {
      const provider = this.getProvider(providerId) || this.getDefaultProvider();
      if (!provider?.providerId) return null;
      const driver = getBuiltInProviderDriver(provider.providerId);
      if (!driver) return null;
      const settings = provider.auth?.settings && typeof provider.auth.settings === "object"
        ? provider.auth.settings
        : {};
      const modelCatalog = this.getModelCatalog(provider.providerId);
      const resolvedEnv = applyBoundCredentialEnv(
        provider.providerId,
        options.env || process.env,
        provider.authBindings,
      );
      const sessionConfig = driver.createSessionConfig({
        env: resolvedEnv,
        settings,
        model:
          overrides.model
          || settings.defaultModel
          || modelCatalog?.defaultModel
          || provider.defaultModel
          || null,
        authMode: overrides.authMode || settings.authMode || provider.auth?.preferredMode || null,
        endpoint: overrides.endpoint || settings.endpoint || null,
        baseUrl: overrides.baseUrl || settings.baseUrl || null,
        deployment: overrides.deployment || settings.deployment || null,
        apiVersion: overrides.apiVersion || settings.apiVersion || null,
        workspace: overrides.workspace || settings.workspace || null,
        organization: overrides.organization || settings.organization || null,
        project: overrides.project || settings.project || null,
      });
      return sessionConfig
        ? {
            ...sessionConfig,
            provider: provider.providerId,
            selectionId: provider.id,
          }
        : null;
    },
    async discoverRuntimeCatalog(providerId, discoveryOptions = {}) {
      return await discoverRegistryRuntimeCatalog(providerId, discoveryOptions);
    },
    resolveProviderRuntime(name) {
      const selection = this.resolveSelection(name);
      const provider = this.getProvider(selection?.selectionId || selection?.providerId || name) || this.getDefaultProvider();
      return {
        selection,
        provider,
        capabilities: provider ? this.getCapabilities(provider.providerId) : getProviderCapabilities(name),
        auth: provider ? this.getAuthState(provider.providerId) : null,
        modelCatalog: provider ? this.getModelCatalog(provider.providerId) : null,
      };
    },
    getDefaultProvider() {
      return resolveDefaultProvider(getProviderList(options), options);
    },
    getRegistrySnapshot() {
      const inventory = this.getInventory();
      return {
        contractVersion: "bosun.provider-registry.v1",
        defaultProviderId: inventory.defaultProvider?.providerId || null,
        providers: inventory.providers,
        authHealth: Object.fromEntries(
          inventory.providers.map((entry) => [entry.providerId, this.getAuthHealth(entry.providerId)]),
        ),
        modelCatalogs: Object.fromEntries(
          inventory.providers.map((entry) => [entry.providerId, this.getModelCatalog(entry.providerId)]),
        ),
        capabilities: Object.fromEntries(
          inventory.providers.map((entry) => [entry.providerId, this.getCapabilities(entry.providerId)]),
        ),
        timestamp: Date.now(),
      };
    },
  };
  registry.contract = buildProviderRegistryContract(registry);
  return registry;
}

export default createProviderRegistry;
