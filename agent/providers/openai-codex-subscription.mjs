import { createProviderDriver } from "./_shared.mjs";

export const OPENAI_CODEX_SUBSCRIPTION_PROVIDER = createProviderDriver({
  id: "openai-codex-subscription",
  aliases: [
    "codex-subscription",
    "chatgpt-subscription",
    "chatgpt-codex",
    "openai-codex",
  ],
  label: "ChatGPT Codex Subscription",
  description: "Subscription-backed OpenAI Codex flow that hides ChatGPT session and subscription quirks behind a stable driver contract.",
  vendor: "openai",
  family: "openai",
  docsSlug: "openai-codex-subscription",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "codex-sdk",
    executor: "CODEX",
    shell: "codex-shell",
    providerFamily: "openai",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: false,
    auth: true,
    apiKey: true,
    oauth: true,
    subscription: true,
    sessions: true,
    steering: true,
  },
  auth: {
    preferredMode: "subscription",
    supportedModes: ["subscription", "oauth", "apiKey"],
    env: {
      apiKey: ["OPENAI_API_KEY"],
      oauth: ["OPENAI_ACCESS_TOKEN", "OPENAI_OAUTH_TOKEN"],
      subscription: ["OPENAI_SESSION_TOKEN", "OPENAI_SUBSCRIPTION_ACTIVE"],
      workspace: ["OPENAI_ACCOUNT_ID"],
    },
    settings: [
      "providers.chatgptCodex.enabled",
      "providers.chatgptCodex.mode",
      "providers.chatgptCodex.defaultModel",
    ],
  },
  transport: {
    protocol: "subscription",
    apiStyle: "responses",
    messageShape: "openai-responses",
    toolCallShape: "responses-tool",
    reasoningParameter: "reasoning",
    streamEventShape: "response-event",
  },
  models: {
    defaultModel: "gpt-5.4",
    catalogSource: "runtime",
    supportsCustomModel: true,
    known: [
      { id: "gpt-5.4", default: true, aliases: ["codex", "chatgpt-codex-default"] },
      { id: "gpt-5.4-mini", aliases: ["codex-mini"] },
      { id: "o4-mini", aliases: ["reasoning-mini"] },
    ],
  },
});

export default OPENAI_CODEX_SUBSCRIPTION_PROVIDER;
