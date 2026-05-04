import { createProviderDriver } from "./_shared.mjs";

export const OPENAI_RESPONSES_PROVIDER = createProviderDriver({
  id: "openai-responses",
  aliases: ["openai", "openai-api", "responses", "openai-response-api"],
  label: "OpenAI Responses API",
  description: "Direct OpenAI Responses API driver for high-quality reasoning, streaming, tool calling, and usage accounting.",
  vendor: "openai",
  family: "openai",
  docsSlug: "openai-responses",
  visibility: {
    advanced: false,
    defaultEnabled: true,
    explicitEnablementRequired: false,
  },
  adapterHints: {
    adapterId: "codex-sdk",
    executor: "OPENAI",
    shell: "codex-shell",
    providerFamily: "openai",
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
      apiKey: ["OPENAI_API_KEY"],
      organization: ["OPENAI_ORG_ID"],
      project: ["OPENAI_PROJECT_ID"],
    },
    settings: [
      "providers.openai.enabled",
      "providers.openai.defaultModel",
      "providers.openai.apiKey",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "responses",
    messageShape: "openai-responses",
    toolCallShape: "responses-tool",
    reasoningParameter: "reasoning",
    streamEventShape: "response-event",
  },
  models: {
    defaultModel: "gpt-5.4",
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "gpt-5.4", default: true, aliases: ["gpt5.4", "gpt-5"], apiStyle: "responses", contextWindow: 400000, maxOutputTokens: 128000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
      { id: "gpt-5.4-mini", aliases: ["gpt5.4-mini", "gpt-5-mini"], apiStyle: "responses", contextWindow: 400000, maxOutputTokens: 128000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
      { id: "o4-mini", aliases: ["o4", "omni-4-mini"], apiStyle: "responses", contextWindow: 200000, maxOutputTokens: 100000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
      { id: "o3", aliases: ["o3-reasoning"], apiStyle: "responses", contextWindow: 200000, maxOutputTokens: 100000, toolCalling: true, vision: true, supportsAttachments: true, reasoning: true, streaming: true },
    ],
  },
});

export default OPENAI_RESPONSES_PROVIDER;

