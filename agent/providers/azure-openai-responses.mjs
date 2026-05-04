import { createProviderDriver } from "./_shared.mjs";

export const AZURE_OPENAI_RESPONSES_PROVIDER = createProviderDriver({
  id: "azure-openai-responses",
  aliases: ["azure-openai", "azure-responses", "azure-openai-api"],
  label: "Azure OpenAI Responses",
  description: "Azure-hosted OpenAI Responses driver with deployment, endpoint, and API-version awareness.",
  vendor: "microsoft",
  family: "openai",
  docsSlug: "azure-openai-responses",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "codex-sdk",
    executor: "AZURE_OPENAI",
    shell: "codex-shell",
    providerFamily: "openai",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: true,
    auth: true,
    apiKey: true,
    oauth: true,
  },
  auth: {
    preferredMode: "apiKey",
    supportedModes: ["apiKey", "oauth"],
    env: {
      apiKey: ["AZURE_OPENAI_API_KEY"],
      oauth: ["AZURE_OPENAI_AD_TOKEN", "AZURE_OPENAI_ACCESS_TOKEN"],
      endpoint: ["AZURE_OPENAI_ENDPOINT"],
      deployment: ["AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_DEPLOYMENT_NAME"],
      apiVersion: ["AZURE_OPENAI_API_VERSION"],
    },
    settings: [
      "providers.azureOpenai.enabled",
      "providers.azureOpenai.endpoint",
      "providers.azureOpenai.deployment",
      "providers.azureOpenai.apiVersion",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "responses",
    messageShape: "openai-responses",
    toolCallShape: "responses-tool",
    reasoningParameter: "reasoning",
    streamEventShape: "response-event",
  },
  models: {
    defaultModel: "gpt-5.4",
    catalogSource: "deployment",
    supportsCustomModel: true,
    known: [
      { id: "gpt-5.4", default: true, aliases: ["azure-gpt-5.4"] },
      { id: "gpt-5.4-mini", aliases: ["azure-gpt-5.4-mini"] },
      { id: "o4-mini", aliases: ["azure-o4-mini"] },
    ],
  },
});

export default AZURE_OPENAI_RESPONSES_PROVIDER;
