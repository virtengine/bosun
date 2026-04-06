import { getBuiltInProviderDriver, listBuiltInProviderDrivers, normalizeProviderDefinitionId } from "./providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function sanitizeId(value, fallback = "harness-executor") {
  const normalized = toTrimmedString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .flatMap((entry) => {
        if (Array.isArray(entry)) return entry;
        if (typeof entry === "string") return entry.split(/[,\n|]/);
        return [entry];
      })
      .map((entry) => toTrimmedString(entry))
      .filter(Boolean),
  )];
}

function normalizeModelEntryId(value, fallback = "model") {
  return toTrimmedString(value) || fallback;
}

function normalizeBindingReference(value) {
  return toTrimmedString(value);
}

function parseBooleanLike(value, fallback = true) {
  if (typeof value === "boolean") return value;
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeApiStyle(value, fallback = "provider-default") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (["responses", "chat-completions", "provider-default"].includes(normalized)) {
    return normalized;
  }
  if (normalized === "chat" || normalized === "chat-completion" || normalized === "chatcompletions") {
    return "chat-completions";
  }
  return fallback;
}

function normalizeRoutingMode(value, fallback = "default-only") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (["default-only", "fallback", "spread"].includes(normalized)) return normalized;
  return fallback;
}

function resolveProviderId(rawProviderId = "") {
  return normalizeProviderDefinitionId(rawProviderId, "") || "";
}

function defaultApiStyleForProvider(providerId = "") {
  const driver = getBuiltInProviderDriver(providerId);
  if (!driver?.transport?.apiStyle) return "provider-default";
  const style = toTrimmedString(driver.transport.apiStyle).toLowerCase();
  if (style === "responses") return "responses";
  if (style === "chat-completions" || style === "openai-compatible") return "chat-completions";
  return "provider-default";
}

function normalizeHarnessModelEntry(rawEntry = {}, index = 0, options = {}) {
  const fallbackApiStyle = normalizeApiStyle(
    options.apiStyle || options.fallbackApiStyle || "provider-default",
    "provider-default",
  );
  const value = rawEntry && typeof rawEntry === "object"
    ? rawEntry
    : { id: rawEntry };
  const id = normalizeModelEntryId(
    value.id || value.model || value.name,
    `model-${index + 1}`,
  );
  const label = toTrimmedString(value.label || value.name || value.title || id) || id;
  const apiStyle = normalizeApiStyle(
    value.apiStyle || value.transport?.apiStyle || fallbackApiStyle,
    fallbackApiStyle,
  );
  const reasoningEffort = toTrimmedString(
    value.reasoningEffort || value.reasoning || value.effort || "",
  ) || null;
  const contextWindow = Number.isFinite(Number(value.contextWindow))
    ? Number(value.contextWindow)
    : null;
  return {
    id,
    label,
    enabled: parseBooleanLike(value.enabled, true),
    apiStyle,
    apiVersion: toTrimmedString(value.apiVersion || "") || null,
    reasoningEffort,
    contextWindow,
  };
}

function normalizeHarnessModelEntries(rawModels = [], options = {}) {
  const fallbackApiStyle = defaultApiStyleForProvider(options.providerId || "");
  const input = Array.isArray(rawModels) ? rawModels : uniqueStrings(rawModels);
  const deduped = [];
  const seen = new Set();
  for (const [index, rawEntry] of input.entries()) {
    const normalized = normalizeHarnessModelEntry(rawEntry, index, {
      fallbackApiStyle,
      apiStyle: options.apiStyle,
    });
    if (!normalized?.id || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    deduped.push(normalized);
  }
  return deduped;
}

function normalizeExecutorTransport(executor = {}) {
  const apiStyle = normalizeApiStyle(
    executor.apiStyle
      || executor.transport?.apiStyle
      || executor.transport?.style
      || executor.transportStyle,
    defaultApiStyleForProvider(executor.providerId),
  );
  if (apiStyle === "provider-default") return null;
  return {
    apiStyle,
  };
}

function buildExecutorOverrideSettings(executor = {}) {
  const settings = {};
  const map = {
    authMode: executor.authMode,
    defaultModel: executor.defaultModel,
    endpoint: executor.endpoint,
    baseUrl: executor.baseUrl,
    deployment: executor.deployment,
    apiVersion: executor.apiVersion,
    workspace: executor.workspace,
    organization: executor.organization,
    project: executor.project,
  };
  for (const [key, rawValue] of Object.entries(map)) {
    const value = toTrimmedString(rawValue);
    if (value) settings[key] = value;
  }
  const transport = normalizeExecutorTransport(executor);
  if (transport) settings.transport = transport;
  return settings;
}

function normalizeExecutorAuthBindings(rawExecutor = {}) {
  const input =
    rawExecutor.authBindings && typeof rawExecutor.authBindings === "object"
      ? rawExecutor.authBindings
      : rawExecutor.auth && typeof rawExecutor.auth === "object"
        ? rawExecutor.auth
        : {};
  const bindings = {
    apiKeyEnv: normalizeBindingReference(
      input.apiKeyEnv || input.apiKey || rawExecutor.apiKeyEnv || rawExecutor.apiKeyRef || "",
    ),
    oauthTokenEnv: normalizeBindingReference(
      input.oauthTokenEnv || input.oauthEnv || input.oauthToken || rawExecutor.oauthTokenEnv || rawExecutor.oauthTokenRef || "",
    ),
    subscriptionEnv: normalizeBindingReference(
      input.subscriptionEnv || input.subscriptionTokenEnv || input.subscription || rawExecutor.subscriptionEnv || rawExecutor.subscriptionRef || "",
    ),
  };
  return Object.fromEntries(
    Object.entries(bindings).filter(([, value]) => value),
  );
}

export function normalizeHarnessExecutor(rawExecutor = {}, index = 0) {
  const providerId = resolveProviderId(
    rawExecutor.providerId
      || rawExecutor.provider
      || rawExecutor.driver
      || rawExecutor.type,
  );
  const driver = providerId ? getBuiltInProviderDriver(providerId) : null;
  const fallbackName = driver?.name || providerId || `Harness Executor ${index + 1}`;
  const name = toTrimmedString(rawExecutor.name || rawExecutor.label || rawExecutor.title) || fallbackName;
  const id = sanitizeId(rawExecutor.id || rawExecutor.slug || name || providerId || `executor-${index + 1}`);
  const modelEntries = normalizeHarnessModelEntries(
    rawExecutor.models || rawExecutor.modelCatalog?.models || [],
    {
      providerId,
      apiStyle: rawExecutor.apiStyle || rawExecutor.transport?.apiStyle || rawExecutor.transportStyle,
    },
  );
  const models = modelEntries.map((entry) => entry.id);
  const defaultModel = toTrimmedString(
    rawExecutor.defaultModel
    || rawExecutor.model
    || modelEntries.find((entry) => entry.enabled !== false)?.id
    || driver?.defaultModel
    || "",
  );
  const enabled = parseBooleanLike(rawExecutor.enabled, true);
  const weight = Math.max(0, Number.parseInt(toTrimmedString(rawExecutor.weight), 10) || 0);
  const authMode = toTrimmedString(rawExecutor.authMode || rawExecutor.mode || rawExecutor.auth?.mode || "");
  const authBindings = normalizeExecutorAuthBindings(rawExecutor);
  const apiStyle = normalizeApiStyle(
    rawExecutor.apiStyle || rawExecutor.transport?.apiStyle || rawExecutor.transportStyle,
    defaultApiStyleForProvider(providerId),
  );
  return {
    id,
    name,
    providerId,
    enabled,
    available: rawExecutor.available !== false,
    source: toTrimmedString(rawExecutor.source || (rawExecutor.derived ? "derived" : "configured")) || "configured",
    description: toTrimmedString(rawExecutor.description || driver?.description || ""),
    defaultModel: defaultModel || null,
    models,
    modelEntries,
    authMode: authMode || null,
    endpoint: toTrimmedString(rawExecutor.endpoint || rawExecutor.url || "") || null,
    baseUrl: toTrimmedString(rawExecutor.baseUrl || rawExecutor.baseURL || "") || null,
    deployment: toTrimmedString(rawExecutor.deployment || "") || null,
    apiVersion: toTrimmedString(rawExecutor.apiVersion || "") || null,
    workspace: toTrimmedString(rawExecutor.workspace || "") || null,
    organization: toTrimmedString(rawExecutor.organization || "") || null,
    project: toTrimmedString(rawExecutor.project || "") || null,
    apiStyle,
    authBindings,
    weight,
    transport: normalizeExecutorTransport({ ...rawExecutor, providerId }),
    settingsOverrides: buildExecutorOverrideSettings({
      ...rawExecutor,
      providerId,
      defaultModel,
      authMode,
      apiStyle,
    }),
  };
}

export function buildDerivedHarnessExecutors(providerInventory = null) {
  const items = Array.isArray(providerInventory?.items) ? providerInventory.items : [];
  return items
    .filter((item) => item?.enabled !== false)
    .map((item, index) => normalizeHarnessExecutor({
      id: item?.providerId || `provider-${index + 1}`,
      name: item?.label || item?.name || item?.providerId || `Provider ${index + 1}`,
      providerId: item?.providerId,
      enabled: item?.enabled !== false,
      available: item?.auth?.canRun === true || item?.available !== false,
      source: "derived",
      derived: true,
      defaultModel:
        item?.defaultModel
        || item?.modelCatalog?.defaultModel
        || item?.auth?.settings?.defaultModel
        || null,
      models:
        Array.isArray(item?.modelCatalog?.models)
          ? item.modelCatalog.models
          : Array.isArray(item?.models)
            ? item.models
            : [],
      authMode: item?.auth?.preferredMode || null,
      endpoint: item?.auth?.settings?.endpoint || null,
      baseUrl: item?.auth?.settings?.baseUrl || null,
      deployment: item?.auth?.settings?.deployment || null,
      apiVersion: item?.auth?.settings?.apiVersion || null,
      workspace: item?.auth?.settings?.workspace || null,
      organization: item?.auth?.settings?.organization || null,
      project: item?.auth?.settings?.project || null,
      authBindings: item?.authBindings || null,
      transport: item?.transport || null,
      apiStyle: item?.transport?.apiStyle || null,
      description: item?.description || "",
    }, index));
}

export function readHarnessExecutorFabric(configData = {}, options = {}) {
  const harness = configData?.harness && typeof configData.harness === "object"
    ? configData.harness
    : {};
  const explicitExecutors = Array.isArray(harness.executors)
    ? harness.executors
        .map((entry, index) => normalizeHarnessExecutor(entry, index))
        .filter((entry) => entry.providerId)
    : [];
  const providerInventory = options.providerInventory || null;
  const effectiveExecutors = explicitExecutors.length > 0
    ? explicitExecutors
    : buildDerivedHarnessExecutors(providerInventory);
  const preferredPrimaryId = toTrimmedString(
    harness.primaryExecutor
      || options.primaryExecutor
      || "",
  );
  const primaryExecutorId =
    effectiveExecutors.find((entry) => entry.id === preferredPrimaryId)?.id
    || effectiveExecutors.find((entry) => entry.providerId === preferredPrimaryId)?.id
    || effectiveExecutors.find((entry) => entry.enabled !== false)?.id
    || effectiveExecutors[0]?.id
    || null;
  return {
    explicitExecutors,
    executors: effectiveExecutors,
    hasExplicitExecutors: explicitExecutors.length > 0,
    primaryExecutorId,
    routingMode: normalizeRoutingMode(
      harness.routingMode || options.routingMode || options.providerRoutingMode || "default-only",
      "default-only",
    ),
  };
}

export function listHarnessExecutorProviderOptions() {
  return listBuiltInProviderDrivers().map((driver) => ({
    id: driver.id,
    label: driver.name,
    description: driver.description || "",
    adapterId: driver.adapterId || null,
    apiStyle: defaultApiStyleForProvider(driver.id),
    transport: driver.transport ? { ...driver.transport } : null,
    capabilities: driver.capabilities ? { ...driver.capabilities } : {},
    defaultModel: driver.defaultModel || null,
  }));
}

export default {
  buildDerivedHarnessExecutors,
  listHarnessExecutorProviderOptions,
  normalizeHarnessExecutor,
  readHarnessExecutorFabric,
};
