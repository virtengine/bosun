import { createProviderAuthAdapter } from "./_shared.mjs";

export const SAMBANOVA_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "sambanova",
  label: "SambaNova API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_SAMBANOVA_ENABLED",
    defaultModel: "BOSUN_PROVIDER_SAMBANOVA_MODEL",
    baseUrl: "BOSUN_PROVIDER_SAMBANOVA_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default SAMBANOVA_AUTH_ADAPTER;
