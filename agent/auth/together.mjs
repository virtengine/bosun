import { createProviderAuthAdapter } from "./_shared.mjs";

export const TOGETHER_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "together",
  label: "Together API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_TOGETHER_ENABLED",
    defaultModel: "BOSUN_PROVIDER_TOGETHER_MODEL",
    baseUrl: "BOSUN_PROVIDER_TOGETHER_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default TOGETHER_AUTH_ADAPTER;
