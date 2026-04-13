import { createProviderDriver } from "./_shared.mjs";

export const FIREWORKS_PROVIDER = createProviderDriver({
  id: "fireworks",
  aliases: ["fireworks-ai", "fireworks-api", "fw"],
  label: "Fireworks AI",
  description: "Direct Fireworks AI chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "fireworks",
  family: "openai-compatible",
  docsSlug: "fireworks",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "FIREWORKS",
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
      apiKey: ["FIREWORKS_API_KEY"],
      baseUrl: ["FIREWORKS_BASE_URL"],
      endpoint: ["FIREWORKS_BASE_URL"],
    },
    settings: [
      "providers.fireworks.enabled",
      "providers.fireworks.defaultModel",
      "providers.fireworks.baseUrl",
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
      { id: "llama-v3p3-70b-instruct" },
      { id: "qwen3-32b" },
      { id: "deepseek-v3" },
    ],
  },
});

export default FIREWORKS_PROVIDER;
