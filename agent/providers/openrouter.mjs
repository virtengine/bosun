import { createProviderDriver } from "./_shared.mjs";

export const OPENROUTER_PROVIDER = createProviderDriver({
  id: "openrouter",
  aliases: ["openrouter-api", "openrouter-chat"],
  label: "OpenRouter",
  description: "Direct OpenRouter chat-completions driver on the Bosun-native OpenAI-compatible transport.",
  vendor: "openrouter",
  family: "openai-compatible",
  docsSlug: "openrouter",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "openai-native",
    executor: "OPENROUTER",
    shell: "openai-native-adapter",
    providerFamily: "openai-compatible",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: true,
    auth: true,
    apiKey: true,
    openaiCompatible: true,
  },
  auth: {
    preferredMode: "apiKey",
    supportedModes: ["apiKey"],
    env: {
      apiKey: ["OPENROUTER_API_KEY"],
      baseUrl: ["OPENROUTER_BASE_URL"],
      endpoint: ["OPENROUTER_BASE_URL"],
    },
    settings: [
      "providers.openrouter.enabled",
      "providers.openrouter.defaultModel",
      "providers.openrouter.baseUrl",
    ],
  },
  transport: {
    protocol: "https",
    apiStyle: "chat-completions",
    messageShape: "openai-chat",
    toolCallShape: "function-call",
    reasoningParameter: "reasoning",
    streamEventShape: "chat-completion-chunk",
  },
  models: {
    defaultModel: null,
    catalogSource: "static+runtime",
    supportsCustomModel: true,
    known: [
      { id: "openai/gpt-5" },
      { id: "anthropic/claude-sonnet-4" },
      { id: "moonshotai/kimi-k2" },
      // Free-tier routes with per-model capability metadata so routing can
      // prefer models that actually complete tasks. Reliability reflects
      // observed behavior: nemotron free truncates to reasoning-only output;
      // Zen free models are compliant but slow (16s cold start, 55s turns).
      {
        id: "nvidia/nemotron-3.5-lightning:free",
        family: "nemotron",
        toolCalling: false,
        reasoning: true,
        streaming: true,
        metadata: {
          freeTier: true,
          toolCallingReliability: "unreliable",
          reasoningStyle: "reasoning-heavy",
          truncatesToReasoning: true,
          recommendedReasoningEffort: "low",
        },
      },
      {
        id: "openrouter/free",
        family: "free-tier",
        toolCalling: false,
        reasoning: true,
        streaming: true,
        metadata: {
          freeTier: true,
          toolCallingReliability: "degraded",
          reasoningStyle: "reasoning-heavy-possible",
          slowStart: true,
          firstTurnTimeoutMs: 120000,
          toolTurnTimeoutMs: 180000,
        },
      },
    ],
  },
});

export default OPENROUTER_PROVIDER;
