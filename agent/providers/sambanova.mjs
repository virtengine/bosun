import { createProviderDriver } from "./_shared.mjs";

export const SAMBANOVA_PROVIDER = createProviderDriver({
  id: "sambanova",
  aliases: ["samba-nova", "sambanova-ai", "samba"],
  label: "SambaNova",
  description: "Direct SambaNova chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "sambanova",
  family: "openai-compatible",
  docsSlug: "sambanova",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "SAMBANOVA",
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
      apiKey: ["SAMBANOVA_API_KEY"],
      baseUrl: ["SAMBANOVA_BASE_URL"],
      endpoint: ["SAMBANOVA_BASE_URL"],
    },
    settings: [
      "providers.sambanova.enabled",
      "providers.sambanova.defaultModel",
      "providers.sambanova.baseUrl",
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
      { id: "Meta-Llama-3.3-70B-Instruct" },
      { id: "DeepSeek-R1" },
      { id: "Qwen2.5-Coder-32B-Instruct" },
    ],
  },
});

export default SAMBANOVA_PROVIDER;
