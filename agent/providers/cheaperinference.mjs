import { createProviderDriver } from "./_shared.mjs";

export const CHEAPERINFERENCE_PROVIDER = createProviderDriver({
  id: "cheaperinference",
  aliases: ["cheaperinference-api", "cheaperinference-chat"],
  label: "Cheaper Inference",
  description: "Direct Cheaper Inference chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "cheaperinference",
  family: "openai-compatible",
  docsSlug: "cheaperinference",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "CHEAPERINFERENCE",
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
      apiKey: ["CHEAPER_INFERENCE_API_KEY"],
      baseUrl: ["CHEAPER_INFERENCE_BASE_URL"],
      endpoint: ["CHEAPER_INFERENCE_BASE_URL"],
    },
    settings: [
      "providers.cheaperinference.enabled",
      "providers.cheaperinference.defaultModel",
      "providers.cheaperinference.baseUrl",
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
      { id: "gpt-5.4-mini" },
      { id: "claude-sonnet-5" },
      { id: "deepseek-v4-flash" },
    ],
  },
});

export default CHEAPERINFERENCE_PROVIDER;
