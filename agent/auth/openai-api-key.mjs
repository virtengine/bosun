import { createProviderAuthAdapter } from "./_shared.mjs";

export const OPENAI_API_KEY_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "openai-responses",
  label: "OpenAI API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED",
    defaultModel: "BOSUN_PROVIDER_OPENAI_RESPONSES_MODEL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default OPENAI_API_KEY_AUTH_ADAPTER;
