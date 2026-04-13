import { createProviderAuthAdapter } from "./_shared.mjs";

export const NEBIUS_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "nebius",
  label: "Nebius API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_NEBIUS_ENABLED",
    defaultModel: "BOSUN_PROVIDER_NEBIUS_MODEL",
    baseUrl: "BOSUN_PROVIDER_NEBIUS_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default NEBIUS_AUTH_ADAPTER;
