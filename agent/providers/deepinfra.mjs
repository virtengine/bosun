import { createProviderDriver } from "./_shared.mjs";

export const DEEPINFRA_PROVIDER = createProviderDriver({
  id: "deepinfra",
  aliases: ["deepinfra-api", "deepinfra-chat"],
  label: "DeepInfra",
  description: "Direct DeepInfra chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "deepinfra",
  family: "openai-compatible",
  docsSlug: "deepinfra",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "DEEPINFRA",
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
      apiKey: ["DEEPINFRA_API_KEY"],
      baseUrl: ["DEEPINFRA_BASE_URL"],
      endpoint: ["DEEPINFRA_BASE_URL"],
    },
    settings: [
      "providers.deepinfra.enabled",
      "providers.deepinfra.defaultModel",
      "providers.deepinfra.baseUrl",
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
      { id: "meta-llama/Llama-3.3-70B-Instruct" },
      { id: "Qwen/Qwen2.5-Coder-32B-Instruct" },
      { id: "mistralai/Mistral-Small-24B-Instruct-2501" },
    ],
  },
});

export default DEEPINFRA_PROVIDER;
