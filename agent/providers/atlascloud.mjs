import { createProviderDriver } from "./_shared.mjs";

export const ATLASCLOUD_PROVIDER = createProviderDriver({
  id: "atlascloud",
  aliases: ["atlas-cloud", "atlascloud-api"],
  label: "Atlas Cloud",
  description: "Direct Atlas Cloud chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "atlascloud",
  family: "openai-compatible",
  docsSlug: "atlascloud",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "ATLASCLOUD",
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
      apiKey: ["ATLASCLOUD_API_KEY"],
      baseUrl: ["ATLASCLOUD_BASE_URL"],
      endpoint: ["ATLASCLOUD_BASE_URL"],
    },
    settings: [
      "providers.atlascloud.enabled",
      "providers.atlascloud.defaultModel",
      "providers.atlascloud.baseUrl",
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
      { id: "deepseek-ai/deepseek-v4-flash" },
      { id: "moonshotai/kimi-k3" },
      { id: "zai-org/glm-5.2" },
    ],
  },
});

export default ATLASCLOUD_PROVIDER;
