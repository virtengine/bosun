import { createProviderAuthAdapter } from "./_shared.mjs";

export const PERPLEXITY_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "perplexity",
  label: "Perplexity API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_PERPLEXITY_ENABLED",
    defaultModel: "BOSUN_PROVIDER_PERPLEXITY_MODEL",
    baseUrl: "BOSUN_PROVIDER_PERPLEXITY_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default PERPLEXITY_AUTH_ADAPTER;
