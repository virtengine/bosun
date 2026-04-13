import { createProviderAuthAdapter } from "./_shared.mjs";

export const CEREBRAS_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "cerebras",
  label: "Cerebras API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_CEREBRAS_ENABLED",
    defaultModel: "BOSUN_PROVIDER_CEREBRAS_MODEL",
    baseUrl: "BOSUN_PROVIDER_CEREBRAS_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default CEREBRAS_AUTH_ADAPTER;
