import { createProviderAuthAdapter } from "./_shared.mjs";

export const OPENAI_COMPATIBLE_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "openai-compatible",
  label: "OpenAI-Compatible Endpoint",
  settings: {
    enabled: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED",
    authMode: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE",
    defaultModel: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL",
    baseUrl: "BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default OPENAI_COMPATIBLE_AUTH_ADAPTER;
