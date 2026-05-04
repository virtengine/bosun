import { createProviderDriver } from "./_shared.mjs";

export const CLAUDE_SUBSCRIPTION_SHIM_PROVIDER = createProviderDriver({
  id: "claude-subscription-shim",
  aliases: ["claude-subscription", "claude-code-subscription", "claude-local-subscription"],
  label: "Claude Subscription Shim",
  description: "Subscription-backed Claude Code style driver that exposes Anthropic-hosted sessions through a normalized Bosun contract.",
  vendor: "anthropic",
  family: "anthropic",
  docsSlug: "claude-subscription-shim",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "claude-sdk",
    executor: "CLAUDE",
    shell: "claude-shell",
    providerFamily: "anthropic",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: false,
    auth: true,
    oauth: true,
    subscription: true,
    sessions: true,
    steering: true,
  },
  auth: {
    preferredMode: "subscription",
    supportedModes: ["subscription", "oauth"],
    env: {
      oauth: ["CLAUDE_ACCESS_TOKEN", "ANTHROPIC_ACCESS_TOKEN"],
      subscription: ["CLAUDE_SESSION_TOKEN", "CLAUDE_SUBSCRIPTION_ACTIVE"],
      workspace: ["CLAUDE_ACCOUNT_ID"],
    },
    settings: [
      "providers.claudeSubscription.enabled",
      "providers.claudeSubscription.mode",
      "providers.claudeSubscription.defaultModel",
    ],
  },
  transport: {
    protocol: "subscription",
    apiStyle: "messages",
    messageShape: "anthropic-messages",
    toolCallShape: "anthropic-tool",
    reasoningParameter: "thinking",
    streamEventShape: "content-block-delta",
  },
  models: {
    defaultModel: "claude-opus-4.1",
    catalogSource: "runtime",
    supportsCustomModel: true,
    known: [
      { id: "claude-opus-4.1", default: true, aliases: ["claude-code-default"] },
      { id: "claude-sonnet-4", aliases: ["claude-code-fast"] },
    ],
  },
});

export default CLAUDE_SUBSCRIPTION_SHIM_PROVIDER;

