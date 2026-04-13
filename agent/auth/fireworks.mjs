import { createProviderAuthAdapter } from "./_shared.mjs";

export const FIREWORKS_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "fireworks",
  label: "Fireworks API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_FIREWORKS_ENABLED",
    defaultModel: "BOSUN_PROVIDER_FIREWORKS_MODEL",
    baseUrl: "BOSUN_PROVIDER_FIREWORKS_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default FIREWORKS_AUTH_ADAPTER;
