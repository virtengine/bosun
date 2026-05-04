import { createProviderAuthAdapter } from "./_shared.mjs";

export const OLLAMA_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "ollama",
  label: "Ollama",
  settings: {
    enabled: "BOSUN_PROVIDER_OLLAMA_ENABLED",
    defaultModel: "BOSUN_PROVIDER_OLLAMA_MODEL",
    baseUrl: "BOSUN_PROVIDER_OLLAMA_BASE_URL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default OLLAMA_AUTH_ADAPTER;
