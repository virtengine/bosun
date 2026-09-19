import {
  listBuiltInProviderDrivers,
  normalizeProviderDefinitionId,
} from "../providers/index.mjs";
import { ANTHROPIC_API_KEY_AUTH_ADAPTER } from "./anthropic-api-key.mjs";
import { AZURE_OPENAI_AUTH_ADAPTER } from "./azure-openai.mjs";
import { CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER } from "./chatgpt-codex-subscription.mjs";
import { CLAUDE_SUBSCRIPTION_AUTH_ADAPTER } from "./claude-subscription.mjs";
import { COPILOT_OAUTH_AUTH_ADAPTER } from "./copilot-oauth.mjs";
import { CEREBRAS_AUTH_ADAPTER } from "./cerebras.mjs";
import { DEEPINFRA_AUTH_ADAPTER } from "./deepinfra.mjs";
import { FIREWORKS_AUTH_ADAPTER } from "./fireworks.mjs";
import { GEMINI_API_KEY_AUTH_ADAPTER } from "./gemini-api-key.mjs";
import { GROQ_AUTH_ADAPTER } from "./groq.mjs";
import { NEBIUS_AUTH_ADAPTER } from "./nebius.mjs";
import { OLLAMA_AUTH_ADAPTER } from "./ollama.mjs";
import { OPENAI_API_KEY_AUTH_ADAPTER } from "./openai-api-key.mjs";
import { OPENAI_COMPATIBLE_AUTH_ADAPTER } from "./openai-compatible.mjs";
import { OPENROUTER_AUTH_ADAPTER } from "./openrouter.mjs";
import { REQUESTY_AUTH_ADAPTER } from "./requesty.mjs";
import { PERPLEXITY_AUTH_ADAPTER } from "./perplexity.mjs";
import { SAMBANOVA_AUTH_ADAPTER } from "./sambanova.mjs";
import { TOGETHER_AUTH_ADAPTER } from "./together.mjs";
import { XAI_AUTH_ADAPTER } from "./xai.mjs";

export {
  ANTHROPIC_API_KEY_AUTH_ADAPTER,
  AZURE_OPENAI_AUTH_ADAPTER,
  CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER,
  CLAUDE_SUBSCRIPTION_AUTH_ADAPTER,
  COPILOT_OAUTH_AUTH_ADAPTER,
  CEREBRAS_AUTH_ADAPTER,
  DEEPINFRA_AUTH_ADAPTER,
  FIREWORKS_AUTH_ADAPTER,
  GEMINI_API_KEY_AUTH_ADAPTER,
  GROQ_AUTH_ADAPTER,
  NEBIUS_AUTH_ADAPTER,
  OLLAMA_AUTH_ADAPTER,
  OPENAI_API_KEY_AUTH_ADAPTER,
  OPENAI_COMPATIBLE_AUTH_ADAPTER,
  OPENROUTER_AUTH_ADAPTER,
  REQUESTY_AUTH_ADAPTER,
  PERPLEXITY_AUTH_ADAPTER,
  SAMBANOVA_AUTH_ADAPTER,
  TOGETHER_AUTH_ADAPTER,
  XAI_AUTH_ADAPTER,
};

const AUTH_ADAPTER_BY_PROVIDER_ID = Object.freeze({
  "openai-responses": OPENAI_API_KEY_AUTH_ADAPTER,
  "openai-codex-subscription": CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER,
  "azure-openai-responses": AZURE_OPENAI_AUTH_ADAPTER,
  "anthropic-messages": ANTHROPIC_API_KEY_AUTH_ADAPTER,
  "claude-subscription-shim": CLAUDE_SUBSCRIPTION_AUTH_ADAPTER,
  "openai-compatible": OPENAI_COMPATIBLE_AUTH_ADAPTER,
  ollama: OLLAMA_AUTH_ADAPTER,
  "copilot-oauth": COPILOT_OAUTH_AUTH_ADAPTER,
  "gemini-generate-content": GEMINI_API_KEY_AUTH_ADAPTER,
  openrouter: OPENROUTER_AUTH_ADAPTER,
  requesty: REQUESTY_AUTH_ADAPTER,
  perplexity: PERPLEXITY_AUTH_ADAPTER,
  deepinfra: DEEPINFRA_AUTH_ADAPTER,
  groq: GROQ_AUTH_ADAPTER,
  together: TOGETHER_AUTH_ADAPTER,
  xai: XAI_AUTH_ADAPTER,
  fireworks: FIREWORKS_AUTH_ADAPTER,
  cerebras: CEREBRAS_AUTH_ADAPTER,
  sambanova: SAMBANOVA_AUTH_ADAPTER,
  nebius: NEBIUS_AUTH_ADAPTER,
});

const BUILTIN_PROVIDER_AUTH_ADAPTERS = Object.freeze(
  listBuiltInProviderDrivers()
    .map((entry) => AUTH_ADAPTER_BY_PROVIDER_ID[entry.id] || null)
    .filter(Boolean),
);

export function listProviderAuthAdapters() {
  return BUILTIN_PROVIDER_AUTH_ADAPTERS.slice();
}

export function getProviderAuthAdapter(providerId) {
  const normalized = normalizeProviderDefinitionId(providerId, "");
  if (!normalized) return null;
  return BUILTIN_PROVIDER_AUTH_ADAPTERS.find((entry) => entry.providerId === normalized) || null;
}

export default BUILTIN_PROVIDER_AUTH_ADAPTERS;
