function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return cloneJson(value);
}

export function normalizeProviderSelection(selection = {}) {
  return {
    providerId: toTrimmedString(selection.providerId || selection.selectionId) || null,
    selectionId: toTrimmedString(selection.selectionId || selection.providerId) || null,
    adapterName: toTrimmedString(selection.adapterName || selection.adapterId) || null,
    model: toTrimmedString(selection.model) || null,
  };
}

export function normalizeProviderSessionInput(input = {}) {
  return {
    providerId: toTrimmedString(input.providerId || input.provider) || null,
    sessionId: toTrimmedString(input.sessionId) || null,
    threadId: toTrimmedString(input.threadId || input.sessionId) || null,
    model: toTrimmedString(input.model) || null,
    metadata: normalizeMetadata(input.metadata),
  };
}

export function normalizeProviderSessionState(input = {}) {
  const normalized = normalizeProviderSessionInput(input);
  return {
    provider: normalized.providerId,
    model: normalized.model,
    sessionId: normalized.sessionId,
    threadId: normalized.threadId,
    metadata: normalized.metadata,
  };
}

export function normalizeProviderToolCallEnvelope(toolCall = {}) {
  return {
    id: toTrimmedString(toolCall.id) || null,
    type: "tool_call",
    name: toTrimmedString(toolCall.name) || null,
    server: toTrimmedString(toolCall.server) || null,
    tool: toTrimmedString(toolCall.tool) || null,
    input:
      toolCall.input && typeof toolCall.input === "object"
        ? cloneJson(toolCall.input)
        : {},
    status: toTrimmedString(toolCall.status) || null,
    originalType: toTrimmedString(toolCall.originalType) || null,
  };
}

export function normalizeProviderInventoryEntry(entry = {}) {
  return {
    id: toTrimmedString(entry.id || entry.providerId) || null,
    name: toTrimmedString(entry.name || entry.providerId) || null,
    providerId: toTrimmedString(entry.providerId || entry.id) || null,
    provider: toTrimmedString(entry.provider) || null,
    executor: toTrimmedString(entry.executor) || null,
    variant: toTrimmedString(entry.variant) || null,
    adapterId: toTrimmedString(entry.adapterId) || null,
    transport: toTrimmedString(entry.transport) || null,
    transportConfig:
      entry.transportConfig && typeof entry.transportConfig === "object"
        ? cloneJson(entry.transportConfig)
        : null,
    apiStyle: toTrimmedString(entry.apiStyle) || null,
    available: entry.available !== false,
    enabled: entry.enabled !== false,
    busy: entry.busy === true,
    source: toTrimmedString(entry.source) || null,
    weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 0,
    models: Array.isArray(entry.models) ? [...entry.models] : [],
    defaultModel: toTrimmedString(entry.defaultModel) || null,
    endpoint: toTrimmedString(entry.endpoint) || null,
    baseUrl: toTrimmedString(entry.baseUrl) || null,
    deployment: toTrimmedString(entry.deployment) || null,
    apiVersion: toTrimmedString(entry.apiVersion) || null,
    authBindings:
      entry.authBindings && typeof entry.authBindings === "object"
        ? cloneJson(entry.authBindings)
        : null,
    modelCatalog:
      entry.modelCatalog && typeof entry.modelCatalog === "object"
        ? cloneJson(entry.modelCatalog)
        : null,
    auth:
      entry.auth && typeof entry.auth === "object"
        ? cloneJson(entry.auth)
        : null,
    capabilities:
      entry.capabilities && typeof entry.capabilities === "object"
        ? cloneJson(entry.capabilities)
        : {},
    definition:
      entry.definition && typeof entry.definition === "object"
        ? cloneJson(entry.definition)
        : null,
  };
}

export function buildProviderRegistryContract(registry) {
  if (!registry || typeof registry !== "object") return null;
  return Object.freeze({
    version: "bosun.provider-registry.v1",
    listProviders: typeof registry.listProviders === "function",
    listEnabledProviders: typeof registry.listEnabledProviders === "function",
    getInventory: typeof registry.getInventory === "function",
    resolveSelection: typeof registry.resolveSelection === "function",
    getProvider: typeof registry.getProvider === "function",
    getDefaultProvider: typeof registry.getDefaultProvider === "function",
    getModelCatalog: typeof registry.getModelCatalog === "function",
    getCapabilities: typeof registry.getCapabilities === "function",
    getAuthState: typeof registry.getAuthState === "function",
    getAuthHealth: typeof registry.getAuthHealth === "function",
    buildSessionConfig: typeof registry.buildSessionConfig === "function",
    getRegistrySnapshot: typeof registry.getRegistrySnapshot === "function",
    resolveProviderRuntime: typeof registry.resolveProviderRuntime === "function",
    discoverRuntimeCatalog: typeof registry.discoverRuntimeCatalog === "function",
  });
}

export default {
  buildProviderRegistryContract,
  normalizeProviderInventoryEntry,
  normalizeProviderSelection,
  normalizeProviderSessionInput,
  normalizeProviderSessionState,
  normalizeProviderToolCallEnvelope,
};
