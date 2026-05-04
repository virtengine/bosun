import { createProviderDriver } from "./_shared.mjs";

export const COPILOT_OAUTH_PROVIDER = createProviderDriver({
  id: "copilot-oauth",
  aliases: ["copilot", "github-copilot", "copilot-chat"],
  label: "GitHub Copilot OAuth",
  description: "OAuth-backed Copilot driver for hosted multi-model access through GitHub account authorization.",
  vendor: "github",
  family: "copilot",
  docsSlug: "copilot-oauth",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "copilot-sdk",
    executor: "COPILOT",
    shell: "copilot-shell",
    providerFamily: "copilot",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: false,
    auth: true,
    oauth: true,
    sessions: true,
    steering: true,
  },
  auth: {
    preferredMode: "oauth",
    supportedModes: ["oauth"],
    env: {
      oauth: ["GITHUB_TOKEN", "COPILOT_ACCESS_TOKEN"],
      workspace: ["GITHUB_USER", "GITHUB_LOGIN"],
    },
    settings: [
      "providers.copilot.enabled",
      "providers.copilot.defaultModel",
    ],
  },
  transport: {
    protocol: "oauth",
    apiStyle: "copilot-chat",
    messageShape: "copilot-chat",
    toolCallShape: "function-call",
    reasoningParameter: "reasoning",
    streamEventShape: "assistant-delta",
  },
  models: {
    defaultModel: "gpt-4o",
    catalogSource: "runtime",
    supportsCustomModel: true,
    known: [
      { id: "gpt-4o", default: true, aliases: ["copilot-default"] },
      { id: "o4-mini", aliases: ["copilot-reasoning"] },
      { id: "claude-sonnet-4", aliases: ["copilot-claude"] },
    ],
  },
});

export default COPILOT_OAUTH_PROVIDER;

