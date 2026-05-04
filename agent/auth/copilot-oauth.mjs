import { createProviderAuthAdapter } from "./_shared.mjs";

export const COPILOT_OAUTH_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "copilot-oauth",
  label: "GitHub Copilot OAuth",
  settings: {
    enabled: "BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED",
    defaultModel: "BOSUN_PROVIDER_COPILOT_OAUTH_MODEL",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default COPILOT_OAUTH_AUTH_ADAPTER;
