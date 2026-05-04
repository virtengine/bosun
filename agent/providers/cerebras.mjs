import { createProviderDriver } from "./_shared.mjs";

export const CEREBRAS_PROVIDER = createProviderDriver({
  id: "cerebras",
  aliases: ["cerebras-ai", "cerebras-api"],
  label: "Cerebras",
  description: "Direct Cerebras chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "cerebras",
  family: "openai-compatible",
  docsSlug: "cerebras",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "CEREBRAS",
    shell: "openai-native-adapter",
    providerFamily: "openai-compatible",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: true,
    auth: true,
    apiKey: true,
    openaiCompatible: true,
  },
  auth: {
    preferredMode: "apiKey",
    supportedModes: ["apiKey"],
    env: {
      apiKey: ["CEREBRAS_API_KEY"],
      baseUrl: ["CEREBRAS_BASE_URL"],
      endpoint: ["CEREBRAS_BASE_URL"],
    },
    settings: [
      "providers.cerebras.enabled",
      "providers.cerebras.defaultModel",
      "providers.cerebras.baseUrl",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "chat-completions",
    messageShape: "openai-chat",
    toolCallShape: "function-call",
    reasoningParameter: "reasoning",
    streamEventShape: "chat-completion-chunk",
  },
  models: {
    defaultModel: null,
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "llama-4-scout-17b-16e-instruct" },
      { id: "qwen-3-32b" },
      { id: "llama3.1-8b" },
    ],
  },
});

export default CEREBRAS_PROVIDER;
