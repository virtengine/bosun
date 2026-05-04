import { createProviderAuthAdapter } from "./_shared.mjs";

export const CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER = createProviderAuthAdapter({
  providerId: "openai-codex-subscription",
  label: "ChatGPT Codex Subscription",
  settings: {
    enabled: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED",
    authMode: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE",
    defaultModel: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODEL",
    workspace: "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE",
    globalDefaultModel: "BOSUN_PROVIDER_DEFAULT_MODEL",
  },
});

export default CHATGPT_CODEX_SUBSCRIPTION_AUTH_ADAPTER;
