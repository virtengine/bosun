import { createProviderDriver } from "./_shared.mjs";

export const ANTHROPIC_MESSAGES_PROVIDER = createProviderDriver({
  id: "anthropic-messages",
  aliases: ["anthropic", "claude-api", "anthropic-api"],
  label: "Anthropic Messages API",
  description: "Direct Anthropic Messages API driver for Claude models with streaming, tool use, and reasoning support.",
  vendor: "anthropic",
  family: "anthropic",
  docsSlug: "anthropic-messages",
  visibility: {
    advanced: false,
    defaultEnabled: true,
    explicitEnablementRequired: false,
  },
  adapterHints: {
    adapterId: "claude-sdk",
    executor: "ANTHROPIC",
    shell: "claude-shell",
    providerFamily: "anthropic",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: true,
    auth: true,
    apiKey: true,
  },
  auth: {
    preferredMode: "apiKey",
    supportedModes: ["apiKey"],
    env: {
      apiKey: ["ANTHROPIC_API_KEY"],
    },
    settings: [
      "providers.anthropic.enabled",
      "providers.anthropic.defaultModel",
      "providers.anthropic.apiKey",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "messages",
    messageShape: "anthropic-messages",
    toolCallShape: "anthropic-tool",
    reasoningParameter: "thinking",
    streamEventShape: "content-block-delta",
  },
  models: {
    defaultModel: "claude-opus-4.1",
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "claude-opus-4.1", default: true, aliases: ["claude-opus"], contextWindow: 200000, maxOutputTokens: 32000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
      { id: "claude-sonnet-4", aliases: ["claude-sonnet"], contextWindow: 200000, maxOutputTokens: 64000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
      { id: "claude-haiku-4", aliases: ["claude-haiku"], contextWindow: 200000, maxOutputTokens: 32000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
    ],
  },
});

export default ANTHROPIC_MESSAGES_PROVIDER;

