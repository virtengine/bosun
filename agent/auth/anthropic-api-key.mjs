import { createProviderAuthAdapter } from "./_shared.mjs";

export const ANTHROPIC_API_KEY_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "anthropic-messages",
  label: "Anthropic API Key",
  settings: {
    enabled: "BOSUN_PROVIDER_ANTHROPIC_ENABLED",
    defaultModel: "BOSUN_PROVIDER_ANTHROPIC_MODEL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default ANTHROPIC_API_KEY_AUTH_ADAPTER;
