import { getBuiltInProviderDriver, listBuiltInProviderDrivers, normalizeProviderDefinitionId } from "./providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function sanitizeId(value, fallback = "harness-executor") {
  const src = toTrimmedString(value).toLowerCase();
  let result = "";
  for (const ch of src) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      result += ch;
    } else if (result.length > 0 && result[result.length - 1] !== "-") {
      result += "-";
    }
  }
  while (result.endsWith("-")) result = result.slice(0, -1);
  return result || fallback;
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

function parseOptionalBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cloneObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
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
  const raw = toTrimmedString(rawProviderId);
  return normalizeProviderDefinitionId(raw, "") || sanitizeId(raw, "");
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
  const normalized = {
    id,
    label,
    enabled: parseBooleanLike(value.enabled, true),
    apiModel: toTrimmedString(value.apiModel || value.api_model || value.model || id) || id,
    apiStyle,
    apiVersion: toTrimmedString(value.apiVersion || "") || null,
    reasoningEffort,
    contextWindow: contextWindow || parsePositiveNumber(value.contextLength || value.context_window || value.maxContextTokens),
    contextLength: parsePositiveNumber(value.contextLength || value.contextWindow || value.context_window || value.maxContextTokens),
    maxInputTokens: parsePositiveNumber(value.maxInputTokens || value.inputTokens || value.input_token_limit),
    maxOutputTokens: parsePositiveNumber(value.maxOutputTokens || value.outputTokens || value.defaultMaxTokens || value.default_max_tokens),
    toolCalling: parseOptionalBoolean(value.toolCalling ?? value.capabilities?.toolCalling),
    vision: parseOptionalBoolean(value.vision ?? value.capabilities?.vision),
    supportsAttachments: parseOptionalBoolean(value.supportsAttachments ?? value.capabilities?.supportsAttachments),
    reasoning: parseOptionalBoolean(value.reasoning ?? value.capabilities?.reasoning),
    streaming: parseOptionalBoolean(value.streaming ?? value.capabilities?.streaming),
    catalogSource: toTrimmedString(value.catalogSource || "") || null,
    custom: value.custom === true,
    overrides: cloneObject(value.overrides),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, entryValue]) => entryValue !== null && entryValue !== undefined));
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
  const providerType = resolveProviderId(rawExecutor.providerType || rawExecutor.baseProvider || rawExecutor.adapterProvider || "");
  const driver = providerId ? getBuiltInProviderDriver(providerType || providerId) : null;
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
    providerType: providerType || null,
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
