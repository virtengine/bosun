import { createProviderDriver } from "./_shared.mjs";

export const GEMINI_GENERATE_CONTENT_PROVIDER = createProviderDriver({
  id: "gemini-generate-content",
  aliases: ["gemini", "google-gemini", "gemini-api"],
  label: "Google Gemini Generate Content",
  description: "Direct Gemini Generate Content API driver for Google-hosted Gemini models with tool use and usage accounting.",
  vendor: "google",
  family: "gemini",
  docsSlug: "gemini-generate-content",
  visibility: {
    advanced: false,
    defaultEnabled: true,
    explicitEnablementRequired: false,
  },
  adapterHints: {
    adapterId: "gemini-native",
    executor: "GEMINI",
    shell: "gemini-shell",
    providerFamily: "gemini",
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
      apiKey: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      baseUrl: ["GEMINI_BASE_URL"],
      endpoint: ["GEMINI_BASE_URL"],
    },
    settings: [
      "providers.gemini.enabled",
      "providers.gemini.defaultModel",
      "providers.gemini.baseUrl",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "generate-content",
    messageShape: "gemini-content",
    toolCallShape: "function-call",
    reasoningParameter: "thinking",
    streamEventShape: "generate-content-response",
  },
  models: {
    defaultModel: "gemini-2.5-pro",
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "gemini-2.5-pro", default: true, aliases: ["gemini-pro"] },
      { id: "gemini-2.5-flash", aliases: ["gemini-flash"] },
      { id: "gemini-3.0-flash" },
      { id: "gemini-3.1-pro" },
    ],
  },
});

export default GEMINI_GENERATE_CONTENT_PROVIDER;
