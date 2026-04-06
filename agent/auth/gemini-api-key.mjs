import { createProviderAuthAdapter } from "./_shared.mjs";

export const GEMINI_API_KEY_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "gemini-generate-content",
  label: "Gemini API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_GEMINI_ENABLED",
    defaultModel: "BOSUN_PROVIDER_GEMINI_MODEL",
    baseUrl: "BOSUN_PROVIDER_GEMINI_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default GEMINI_API_KEY_AUTH_ADAPTER;
