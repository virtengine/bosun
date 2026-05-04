import { createProviderDriver } from "./_shared.mjs";

export const OPENAI_COMPATIBLE_PROVIDER = createProviderDriver({
  id: "openai-compatible",
  aliases: ["compatible", "custom-openai", "openai-proxy"],
  label: "OpenAI-Compatible Endpoint",
  description: "Generic OpenAI-compatible driver for self-hosted or proxied endpoints that mimic OpenAI request and response shapes.",
  vendor: "custom",
  family: "openai-compatible",
  docsSlug: "openai-compatible",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "opencode-sdk",
    executor: "OPENAI_COMPATIBLE",
    shell: "opencode-shell",
    providerFamily: "openai-compatible",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: false,
    auth: true,
    apiKey: true,
    local: true,
    openaiCompatible: true,
  },
  auth: {
    preferredMode: "apiKey",
    supportedModes: ["apiKey", "local"],
    env: {
      apiKey: ["OPENAI_COMPATIBLE_API_KEY"],
      baseUrl: ["OPENAI_COMPATIBLE_BASE_URL", "OPENAI_BASE_URL"],
    },
    settings: [
      "providers.openaiCompatible.enabled",
      "providers.openaiCompatible.baseUrl",
      "providers.openaiCompatible.defaultModel",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "openai-compatible",
    messageShape: "openai-chat",
    toolCallShape: "function-call",
    reasoningParameter: "reasoning",
    streamEventShape: "chat-completion-chunk",
  },
  models: {
    defaultModel: null,
    catalogSource: "runtime",
    supportsCustomModel: true,
    known: [
      { id: "gpt-4o-compatible", aliases: ["compatible-default"], apiStyle: "chat-completions", contextWindow: 128000, maxOutputTokens: 16384, toolCalling: true, vision: true, supportsAttachments: true, streaming: true },
      { id: "qwen2.5-coder:latest", local: true, apiStyle: "chat-completions", contextWindow: 32768, maxOutputTokens: 8192, toolCalling: true, vision: false, streaming: true },
    ],
  },
});

export default OPENAI_COMPATIBLE_PROVIDER;
