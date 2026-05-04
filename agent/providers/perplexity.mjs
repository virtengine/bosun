import { createProviderDriver } from "./_shared.mjs";

export const PERPLEXITY_PROVIDER = createProviderDriver({
  id: "perplexity",
  aliases: ["perplexity-api", "perplexity-chat", "pplx"],
  label: "Perplexity",
  description: "Direct Perplexity chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "perplexity",
  family: "openai-compatible",
  docsSlug: "perplexity",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "PERPLEXITY",
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
      apiKey: ["PERPLEXITY_API_KEY"],
      baseUrl: ["PERPLEXITY_BASE_URL"],
      endpoint: ["PERPLEXITY_BASE_URL"],
    },
    settings: [
      "providers.perplexity.enabled",
      "providers.perplexity.defaultModel",
      "providers.perplexity.baseUrl",
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
    defaultModel: "sonar-pro",
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "sonar-pro", default: true },
      { id: "sonar" },
      { id: "sonar-reasoning" },
    ],
  },
});

export default PERPLEXITY_PROVIDER;
