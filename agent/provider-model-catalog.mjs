import { getProviderAuthAdapter } from "./auth/index.mjs";
import { normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getBuiltinProviderDefinition } from "./providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeModelFamily(modelId = "", providerDefinition = null) {
  const normalized = toTrimmedString(modelId).toLowerCase();
  if (!normalized) return "unknown";
  if (providerDefinition?.provider === "ANTHROPIC" || normalized.includes("claude")) return "anthropic";
  if (providerDefinition?.provider?.includes("OPENAI") || normalized.startsWith("gpt-")) return "openai";
  if (normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) return "openai";
  if (providerDefinition?.provider === "GEMINI" || normalized.includes("gemini")) return "google";
  if (providerDefinition?.provider === "OLLAMA") return "ollama";
  if (providerDefinition?.capabilities?.local || normalized.includes("llama") || normalized.includes("mistral") || normalized.includes("qwen")) return "local";
  return "general";
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function optionalBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    const normalized = toTrimmedString(value).toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function resolveModelCapability(value, providerDefinition = null, capabilityKey = "") {
  const capabilities = providerDefinition?.capabilities && typeof providerDefinition.capabilities === "object"
    ? providerDefinition.capabilities
    : {};
  const modelCapabilities = value?.capabilities && typeof value.capabilities === "object"
    ? value.capabilities
    : {};
  const metadata = value?.metadata && typeof value.metadata === "object" ? value.metadata : {};
  const direct = optionalBoolean(value?.[capabilityKey], modelCapabilities[capabilityKey], metadata[capabilityKey]);
  if (direct !== null) return direct;
  if (capabilityKey === "toolCalling") return capabilities.tools === true;
  if (capabilityKey === "vision" || capabilityKey === "supportsAttachments") {
    return capabilities.vision === true || capabilities.multimodal === true;
  }
  if (capabilityKey === "reasoning") return capabilities.reasoning === true;
  if (capabilityKey === "streaming") return capabilities.streaming !== false;
  return null;
}

function cloneObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

export function normalizeModelEntry(model, options = {}) {
  const value = model && typeof model === "object" ? model : { id: model };
  const providerId = normalizeProviderCapabilityId(value.providerId || options.providerId);
  const providerDefinition = options.providerDefinition || getBuiltinProviderDefinition(providerId);
  const id = toTrimmedString(value.id || value.name || value.model);
  if (!id) return null;
  return {
    id,
    label: toTrimmedString(value.label || value.name || id) || id,
    providerId,
    family: normalizeModelFamily(id, providerDefinition),
    apiModel: toTrimmedString(value.apiModel || value.api_model || value.model || id) || id,
    apiStyle: toTrimmedString(value.apiStyle || value.transport?.apiStyle || "") || null,
    apiVersion: toTrimmedString(value.apiVersion || "") || null,
    reasoningEffort: toTrimmedString(value.reasoningEffort || value.reasoning || value.effort) || null,
    contextWindow: firstFiniteNumber(value.contextWindow, value.contextLength, value.context_window, value.maxContextTokens),
    contextLength: firstFiniteNumber(value.contextLength, value.contextWindow, value.context_window, value.maxContextTokens),
    maxInputTokens: firstFiniteNumber(value.maxInputTokens, value.inputTokens, value.input_token_limit, value.contextWindow, value.contextLength),
    maxOutputTokens: firstFiniteNumber(value.maxOutputTokens, value.outputTokens, value.defaultMaxTokens, value.default_max_tokens),
    toolCalling: resolveModelCapability(value, providerDefinition, "toolCalling"),
    vision: resolveModelCapability(value, providerDefinition, "vision"),
    supportsAttachments: resolveModelCapability(value, providerDefinition, "supportsAttachments"),
    reasoning: resolveModelCapability(value, providerDefinition, "reasoning"),
    streaming: resolveModelCapability(value, providerDefinition, "streaming"),
    default: value.default === true || id === toTrimmedString(options.defaultModel),
    local: value.local === true || options.local === true || providerDefinition?.capabilities?.local === true,
    custom: value.custom === true || options.custom === true,
    catalogSource: toTrimmedString(value.catalogSource || options.catalogSource || providerDefinition?.models?.catalogSource || "static") || "static",
    overrides: cloneObject(value.overrides),
  };
}

function uniqueEntries(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = typeof value === "string"
      ? toTrimmedString(value)
      : toTrimmedString(value?.id || value?.name || value?.model);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function listProviderModels(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const providerDefinition = options.providerDefinition || getBuiltinProviderDefinition(normalizedProviderId);
  const authAdapter = getProviderAuthAdapter(normalizedProviderId);
  const settingsState = authAdapter?.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  }) || {};
  const configured = Array.isArray(options.configuredModels) ? options.configuredModels : [];
  const adapterModels = Array.isArray(options.adapterModels)
    ? options.adapterModels
    : Array.isArray(options.adapter?.models)
      ? options.adapter.models
      : [];
  const definitionModels = Array.isArray(providerDefinition?.models) ? providerDefinition.models : [];
  const selectedSource = configured.length > 0
    ? configured
    : (adapterModels.length > 0
      ? adapterModels
      : definitionModels);
  return uniqueEntries(selectedSource)
    .map((entry) => normalizeModelEntry(entry, {
      providerId: normalizedProviderId,
      providerDefinition,
      defaultModel: options.defaultModel || settingsState.defaultModel || providerDefinition?.defaultModel,
      local: options.local === true || providerDefinition?.capabilities?.local === true,
      catalogSource: configured.length > 0 ? "configured" : providerDefinition?.models?.catalogSource,
    }))
    .filter(Boolean);
}

export function getProviderModelCatalog(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const providerDefinition = options.providerDefinition || getBuiltinProviderDefinition(normalizedProviderId);
  const authAdapter = getProviderAuthAdapter(normalizedProviderId);
  const settingsState = authAdapter?.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  }) || {};
  const models = listProviderModels(normalizedProviderId, options);
  const defaultModel = models.find((entry) => entry.id === settingsState.defaultModel)
    || models.find((entry) => entry.default)
    || models.find((entry) => entry.id === providerDefinition?.defaultModel)
    || models[0]
    || null;
  return {
    providerId: normalizedProviderId,
    enabled: settingsState.enabled !== false,
    catalogSource: providerDefinition?.models?.catalogSource || "static",
    defaultModel: defaultModel?.id || settingsState.defaultModel || providerDefinition?.defaultModel || null,
    supportsCustomModel: providerDefinition?.models?.supportsCustomModel !== false,
    models,
  };
}

export default getProviderModelCatalog;
