import { createProviderAuthAdapter } from "./_shared.mjs";

export const CHEAPERINFERENCE_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "cheaperinference",
  label: "Cheaper Inference API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_CHEAPERINFERENCE_ENABLED",
    defaultModel: "BOSUN_PROVIDER_CHEAPERINFERENCE_MODEL",
    baseUrl: "BOSUN_PROVIDER_CHEAPERINFERENCE_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default CHEAPERINFERENCE_AUTH_ADAPTER;
