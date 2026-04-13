import { createProviderAuthAdapter } from "./_shared.mjs";

export const GROQ_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "groq",
  label: "Groq API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_GROQ_ENABLED",
    defaultModel: "BOSUN_PROVIDER_GROQ_MODEL",
    baseUrl: "BOSUN_PROVIDER_GROQ_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default GROQ_AUTH_ADAPTER;
