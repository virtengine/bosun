import { createProviderDriver } from "./_shared.mjs";

export const TOGETHER_PROVIDER = createProviderDriver({
  id: "together",
  aliases: ["together-ai", "together-api", "together-chat"],
  label: "Together",
  description: "Direct Together chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "together",
  family: "openai-compatible",
  docsSlug: "together",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "TOGETHER",
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
      apiKey: ["TOGETHER_API_KEY"],
      baseUrl: ["TOGETHER_BASE_URL"],
      endpoint: ["TOGETHER_BASE_URL"],
    },
    settings: [
      "providers.together.enabled",
      "providers.together.defaultModel",
      "providers.together.baseUrl",
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
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo" },
      { id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
      { id: "deepseek-ai/DeepSeek-V3" },
    ],
  },
});

export default TOGETHER_PROVIDER;
