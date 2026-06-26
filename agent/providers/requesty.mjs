import { createProviderDriver } from "./_shared.mjs";

export const REQUESTY_PROVIDER = createProviderDriver({
  id: "requesty",
  aliases: ["requesty-api", "requesty-chat"],
  label: "Requesty",
  description: "Direct Requesty chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "requesty",
  family: "openai-compatible",
  docsSlug: "requesty",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "REQUESTY",
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
      apiKey: ["REQUESTY_API_KEY"],
      baseUrl: ["REQUESTY_BASE_URL"],
      endpoint: ["REQUESTY_BASE_URL"],
    },
    settings: [
      "providers.requesty.enabled",
      "providers.requesty.defaultModel",
      "providers.requesty.baseUrl",
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
      { id: "openai/gpt-4o-mini" },
      { id: "anthropic/claude-sonnet-4-5" },
      { id: "google/gemini-2.5-flash" },
    ],
  },
});

export default REQUESTY_PROVIDER;
