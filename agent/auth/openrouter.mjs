import { createProviderAuthAdapter } from "./_shared.mjs";

export const OPENROUTER_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "openrouter",
  label: "OpenRouter API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_OPENROUTER_ENABLED",
    defaultModel: "BOSUN_PROVIDER_OPENROUTER_MODEL",
    baseUrl: "BOSUN_PROVIDER_OPENROUTER_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default OPENROUTER_AUTH_ADAPTER;
