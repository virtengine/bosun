import { normalizeProviderDriverId } from "./_shared.mjs";
import ANTHROPIC_MESSAGES_PROVIDER from "./anthropic-messages.mjs";
import AZURE_OPENAI_RESPONSES_PROVIDER from "./azure-openai-responses.mjs";
import CLAUDE_SUBSCRIPTION_SHIM_PROVIDER from "./claude-subscription-shim.mjs";
import COPILOT_OAUTH_PROVIDER from "./copilot-oauth.mjs";
import CEREBRAS_PROVIDER from "./cerebras.mjs";
import DEEPINFRA_PROVIDER from "./deepinfra.mjs";
import FIREWORKS_PROVIDER from "./fireworks.mjs";
import GEMINI_GENERATE_CONTENT_PROVIDER from "./gemini-generate-content.mjs";
import GROQ_PROVIDER from "./groq.mjs";
import NEBIUS_PROVIDER from "./nebius.mjs";
import OLLAMA_PROVIDER from "./ollama.mjs";
import OPENAI_CODEX_SUBSCRIPTION_PROVIDER from "./openai-codex-subscription.mjs";
import OPENAI_COMPATIBLE_PROVIDER from "./openai-compatible.mjs";
import OPENAI_RESPONSES_PROVIDER from "./openai-responses.mjs";
import OPENROUTER_PROVIDER from "./openrouter.mjs";
import REQUESTY_PROVIDER from "./requesty.mjs";
import PERPLEXITY_PROVIDER from "./perplexity.mjs";
import SAMBANOVA_PROVIDER from "./sambanova.mjs";
import TOGETHER_PROVIDER from "./together.mjs";
import XAI_PROVIDER from "./xai.mjs";

export {
  createProviderDriver,
  normalizeProviderDriverId,
  normalizeUsageSnapshot,
  resolveEnvConfig,
} from "./_shared.mjs";
export {
  buildProviderRegistryContract,
  normalizeProviderInventoryEntry,
  normalizeProviderSelection,
  normalizeProviderSessionInput,
  normalizeProviderSessionState,
  normalizeProviderToolCallEnvelope,
} from "./provider-contract.mjs";
export {
  ProviderConfigurationError,
  ProviderExecutionError,
  ProviderKernelError,
  normalizeProviderErrorDetails,
} from "./provider-errors.mjs";
export {
  normalizeProviderUsageMetadata,
} from "./provider-usage-normalizer.mjs";
export {
  normalizeProviderStreamEnvelope,
} from "./provider-stream-normalizer.mjs";

export {
  ANTHROPIC_MESSAGES_PROVIDER,
  AZURE_OPENAI_RESPONSES_PROVIDER,
  CLAUDE_SUBSCRIPTION_SHIM_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
  CEREBRAS_PROVIDER,
  DEEPINFRA_PROVIDER,
  FIREWORKS_PROVIDER,
  GEMINI_GENERATE_CONTENT_PROVIDER,
  GROQ_PROVIDER,
  NEBIUS_PROVIDER,
  OLLAMA_PROVIDER,
  OPENAI_CODEX_SUBSCRIPTION_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  OPENAI_RESPONSES_PROVIDER,
  OPENROUTER_PROVIDER,
  REQUESTY_PROVIDER,
  PERPLEXITY_PROVIDER,
  SAMBANOVA_PROVIDER,
  TOGETHER_PROVIDER,
  XAI_PROVIDER,
};

export const BUILTIN_PROVIDER_DRIVERS = Object.freeze([
  OPENAI_RESPONSES_PROVIDER,
  OPENAI_CODEX_SUBSCRIPTION_PROVIDER,
  AZURE_OPENAI_RESPONSES_PROVIDER,
  ANTHROPIC_MESSAGES_PROVIDER,
  CLAUDE_SUBSCRIPTION_SHIM_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  OLLAMA_PROVIDER,
  COPILOT_OAUTH_PROVIDER,
  GEMINI_GENERATE_CONTENT_PROVIDER,
  OPENROUTER_PROVIDER,
  REQUESTY_PROVIDER,
  PERPLEXITY_PROVIDER,
  DEEPINFRA_PROVIDER,
  GROQ_PROVIDER,
  TOGETHER_PROVIDER,
  XAI_PROVIDER,
  FIREWORKS_PROVIDER,
  CEREBRAS_PROVIDER,
  SAMBANOVA_PROVIDER,
  NEBIUS_PROVIDER,
]);

export const BUILTIN_PROVIDER_DEFINITIONS = BUILTIN_PROVIDER_DRIVERS;

const LEGACY_PROVIDER_ALIASES = Object.freeze({
  codex: "openai-codex-subscription",
  "codex-sdk": "openai-codex-subscription",
  openai: "openai-responses",
  responses: "openai-responses",
  claude: "claude-subscription-shim",
  "claude-sdk": "claude-subscription-shim",
  anthropic: "anthropic-messages",
  copilot: "copilot-oauth",
  "copilot-sdk": "copilot-oauth",
  "github-copilot": "copilot-oauth",
  gemini: "gemini-generate-content",
  "gemini-sdk": "gemini-generate-content",
  "google-gemini": "gemini-generate-content",
  openrouter: "openrouter",
  "openrouter-api": "openrouter",
  requesty: "requesty",
  "requesty-api": "requesty",
  perplexity: "perplexity",
  pplx: "perplexity",
  deepinfra: "deepinfra",
  "deep-infra": "deepinfra",
  groq: "groq",
  "groq-api": "groq",
  together: "together",
  "together-ai": "together",
  xai: "xai",
  "x-ai": "xai",
  grok: "xai",
  fireworks: "fireworks",
  "fireworks-ai": "fireworks",
  cerebras: "cerebras",
  "cerebras-ai": "cerebras",
  sambanova: "sambanova",
  "samba-nova": "sambanova",
  samba: "sambanova",
  nebius: "nebius",
  "nebius-ai": "nebius",
  opencode: "openai-compatible",
  "opencode-sdk": "openai-compatible",
  "open-code": "openai-compatible",
  "openai-compatible-local": "openai-compatible",
  ollama: "ollama",
  azure: "azure-openai-responses",
  "azure-openai": "azure-openai-responses",
  "azure-responses": "azure-openai-responses",
});

function toCompatibilityDefinition(driver) {
  if (!driver) return null;
  return {
    id: driver.id,
    name: driver.metadata?.label || driver.id,
    provider: String(driver.metadata?.family || driver.metadata?.vendor || driver.id).toUpperCase(),
    executor: driver.adapterHints?.executor || String(driver.metadata?.family || driver.id).toUpperCase(),
    variant: driver.transport?.apiStyle ? String(driver.transport.apiStyle).toUpperCase() : "DEFAULT",
    adapterId: driver.adapterHints?.adapterId || null,
    transport: driver.transport?.apiStyle || null,
    aliases: [...(driver.aliases || [])],
    capabilities: { ...(driver.capabilities || {}) },
    envHints: {
      apiKey: [...(driver.auth?.env?.apiKey || [])],
      oauth: [...(driver.auth?.env?.oauth || [])],
      subscription: [...(driver.auth?.env?.subscription || [])],
    },
    defaultModel: driver.models?.defaultModel || null,
    models: Array.isArray(driver.models?.known) ? driver.models.known.map((entry) => ({ ...entry })) : [],
  };
}

export function listBuiltInProviderDrivers() {
  return BUILTIN_PROVIDER_DRIVERS.slice();
}

export function listBuiltInProviderIds() {
  return BUILTIN_PROVIDER_DRIVERS.map((entry) => entry.id);
}

export function getBuiltInProviderDriver(value) {
  const normalized = normalizeProviderDriverId(value);
  if (!normalized) return null;
  const aliased = LEGACY_PROVIDER_ALIASES[normalized] || normalized;
  return BUILTIN_PROVIDER_DRIVERS.find((entry) => entry.matches(aliased)) || null;
}

export function hasBuiltInProviderDriver(value) {
  return Boolean(getBuiltInProviderDriver(value));
}

export function listBuiltinProviderDefinitions() {
  return listBuiltInProviderDrivers().map((entry) => toCompatibilityDefinition(entry)).filter(Boolean);
}

export function getBuiltinProviderDefinition(value) {
  return toCompatibilityDefinition(getBuiltInProviderDriver(value));
}

export function normalizeProviderDefinitionId(value, fallback = null) {
  const normalized = normalizeProviderDriverId(value);
  if (!normalized) return fallback;
  return getBuiltInProviderDriver(normalized)?.id || LEGACY_PROVIDER_ALIASES[normalized] || fallback;
}

export function resolveProviderAdapterId(value) {
  return getBuiltInProviderDriver(value)?.adapterHints?.adapterId || null;
}

export function getBuiltinProviderEnvHints(value) {
  return getBuiltinProviderDefinition(value)?.envHints || {
    apiKey: [],
    oauth: [],
    subscription: [],
  };
}

export default BUILTIN_PROVIDER_DRIVERS;
