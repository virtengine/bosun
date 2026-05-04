import { createProviderDriver } from "./_shared.mjs";

export const OLLAMA_PROVIDER = createProviderDriver({
  id: "ollama",
  aliases: ["ollama-local", "ollama-openai", "local-ollama"],
  label: "Ollama",
  description: "Local Ollama driver for high-performance on-box models with OpenAI-compatible chat semantics and no remote credential requirement.",
  vendor: "ollama",
  family: "local",
  docsSlug: "ollama",
  visibility: {
    advanced: true,
    defaultEnabled: false,
    explicitEnablementRequired: true,
  },
  adapterHints: {
    adapterId: "opencode-sdk",
    executor: "OLLAMA",
    shell: "opencode-shell",
    providerFamily: "local",
  },
  capabilities: {
    streaming: true,
    tools: true,
    reasoning: true,
    usage: true,
    cost: false,
    auth: false,
    local: true,
    openaiCompatible: true,
  },
  auth: {
    required: false,
    preferredMode: "local",
    supportedModes: ["local"],
    env: {
      baseUrl: ["OLLAMA_HOST", "OLLAMA_BASE_URL"],
    },
    settings: [
      "providers.ollama.enabled",
      "providers.ollama.baseUrl",
      "providers.ollama.defaultModel",
    ],
  },
  transport: {
    protocol: "http",
    apiStyle: "ollama-openai-compatible",
    messageShape: "openai-chat",
    toolCallShape: "function-call",
    reasoningParameter: "reasoning",
    streamEventShape: "chat-completion-chunk",
  },
  models: {
    defaultModel: "qwen2.5-coder:latest",
    catalogSource: "runtime",
    supportsCustomModel: true,
    known: [
      { id: "qwen2.5-coder:latest", default: true, local: true, aliases: ["qwen-coder"] },
      { id: "llama3.3", local: true, aliases: ["llama"] },
      { id: "mistral-small3.1", local: true, aliases: ["mistral"] },
    ],
  },
});

export default OLLAMA_PROVIDER;

