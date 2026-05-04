import { createProviderDriver } from "./_shared.mjs";

export const XAI_PROVIDER = createProviderDriver({
  id: "xai",
  aliases: ["x-ai", "grok", "grok-api"],
  label: "xAI",
  description: "Direct xAI chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "xai",
  family: "openai-compatible",
  docsSlug: "xai",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "XAI",
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
      apiKey: ["XAI_API_KEY"],
      baseUrl: ["XAI_BASE_URL"],
      endpoint: ["XAI_BASE_URL"],
    },
    settings: [
      "providers.xai.enabled",
      "providers.xai.defaultModel",
      "providers.xai.baseUrl",
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
      { id: "grok-3" },
      { id: "grok-3-fast" },
      { id: "grok-3-mini" },
    ],
  },
});

export default XAI_PROVIDER;
