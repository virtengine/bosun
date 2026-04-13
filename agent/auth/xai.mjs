import { createProviderAuthAdapter } from "./_shared.mjs";

export const XAI_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "xai",
  label: "xAI API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_XAI_ENABLED",
    defaultModel: "BOSUN_PROVIDER_XAI_MODEL",
    baseUrl: "BOSUN_PROVIDER_XAI_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default XAI_AUTH_ADAPTER;
