import { createProviderAuthAdapter } from "./_shared.mjs";

export const CLAUDE_SUBSCRIPTION_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "claude-subscription-shim",
  label: "Claude Subscription",
  settings: {
    enabled: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED",
    authMode: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE",
    defaultModel: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODEL",
    workspace: "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default CLAUDE_SUBSCRIPTION_AUTH_ADAPTER;
