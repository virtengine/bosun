import { createProviderDriver } from "./_shared.mjs";

export const NEBIUS_PROVIDER = createProviderDriver({
  id: "nebius",
  aliases: ["nebius-ai", "nebius-api"],
  label: "Nebius",
  description: "Direct Nebius chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "nebius",
  family: "openai-compatible",
  docsSlug: "nebius",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "NEBIUS",
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
      apiKey: ["NEBIUS_API_KEY"],
      baseUrl: ["NEBIUS_BASE_URL"],
      endpoint: ["NEBIUS_BASE_URL"],
    },
    settings: [
      "providers.nebius.enabled",
      "providers.nebius.defaultModel",
      "providers.nebius.baseUrl",
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
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct" },
      { id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
      { id: "deepseek-ai/DeepSeek-R1" },
    ],
  },
});

export default NEBIUS_PROVIDER;
