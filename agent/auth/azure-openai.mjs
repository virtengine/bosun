import { createProviderAuthAdapter } from "./_shared.mjs";

export const AZURE_OPENAI_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "azure-openai-responses",
  label: "Azure OpenAI",
  settings: {
    enabled: "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED",
    authMode: "BOSUN_PROVIDER_AZURE_OPENAI_MODE",
    defaultModel: "BOSUN_PROVIDER_AZURE_OPENAI_MODEL",
    endpoint: "BOSUN_PROVIDER_AZURE_OPENAI_ENDPOINT",
    deployment: "BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT",
    apiVersion: "BOSUN_PROVIDER_AZURE_OPENAI_API_VERSION",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default AZURE_OPENAI_AUTH_ADAPTER;
