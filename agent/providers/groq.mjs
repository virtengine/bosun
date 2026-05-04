import { createProviderDriver } from "./_shared.mjs";

export const GROQ_PROVIDER = createProviderDriver({
  id: "groq",
  aliases: ["groq-api", "groq-chat"],
  label: "Groq",
  description: "Direct Groq chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "groq",
  family: "openai-compatible",
  docsSlug: "groq",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "GROQ",
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
      apiKey: ["GROQ_API_KEY"],
      baseUrl: ["GROQ_BASE_URL"],
      endpoint: ["GROQ_BASE_URL"],
    },
    settings: [
      "providers.groq.enabled",
      "providers.groq.defaultModel",
      "providers.groq.baseUrl",
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
      { id: "llama-3.3-70b-versatile" },
      { id: "qwen/qwen3-32b" },
      { id: "moonshotai/kimi-k2-instruct-0905" },
    ],
  },
});

export default GROQ_PROVIDER;
