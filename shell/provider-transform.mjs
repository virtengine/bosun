/**
 * shell/provider-transform.mjs — Provider-Specific Message Normalization
 *
 * Normalizes messages before they are sent to the LLM API, applying
 * provider-specific fixes learned from OpenCode's provider/transform.ts:
 *
 *   1. Filter empty content for Anthropic / Bedrock
 *   2. Sanitize toolCallId for Claude (replace invalid chars)
 *   3. Sanitize toolCallId for Mistral (alphanumeric only, 9 chars)
 *   4. Fix message sequences (tool messages cannot be followed by user messages)
 *   5. Remove unsupported file/image parts and replace with error text
 *   6. Apply provider-specific cache control placement
 *   7. Inject reasoning content remapping for providers that need it
 *
 * Public API:
 *   normalizeMessages(messages, providerConfig) → messages[]
 *   sanitizeToolCallId(id, provider) → string
 *   fixMessageSequence(messages) → messages[]
 */

function toStr(v) {
  return String(v ?? "").trim();
}

function isAzureProvider(pc) {
  const provider = toStr(pc?.provider || pc?.providerId).toLowerCase();
  const endpoint = toStr(pc?.endpoint || pc?.baseUrl);
  return provider.includes("azure")
    || endpoint.includes(".azure.com")
    || endpoint.includes(".cognitiveservices.azure.com");
}

function isAnthropicProvider(pc) {
  const provider = toStr(pc?.provider || pc?.providerId).toLowerCase();
  const model = toStr(pc?.model).toLowerCase();
  return provider.includes("anthropic")
    || provider.includes("claude")
    || provider.includes("bedrock")
    || model.startsWith("claude-")
    || model.includes("/claude-");
}

function isMistralProvider(pc) {
  const provider = toStr(pc?.provider || pc?.providerId).toLowerCase();
  const model = toStr(pc?.model).toLowerCase();
  return provider.includes("mistral")
    || provider.includes("devstral")
    || model.includes("mistral")
    || model.includes("devstral");
}

function isGeminiProvider(pc) {
  const provider = toStr(pc?.provider || pc?.providerId).toLowerCase();
  const model = toStr(pc?.model).toLowerCase();
  return provider.includes("gemini")
    || provider.includes("google")
    || provider.includes("vertex")
    || model.startsWith("gemini-");
}

function isOpenRouterProvider(pc) {
  const provider = toStr(pc?.provider || pc?.providerId).toLowerCase();
  const endpoint = toStr(pc?.endpoint || pc?.baseUrl);
  return provider.includes("openrouter")
    || endpoint.includes("openrouter.ai");
}

// ── Tool Call ID Sanitization ────────────────────────────────────────────────

/**
 * Claude requires toolCallId to contain only [a-zA-Z0-9_-]
 */
function scrubClaudeToolCallId(id) {
  return toStr(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Mistral requires toolCallId to be alphanumeric, max 9 chars, padded with zeros.
 */
function scrubMistralToolCallId(id) {
  const alphanumeric = toStr(id).replace(/[^a-zA-Z0-9]/g, "").substring(0, 9);
  return alphanumeric.padEnd(9, "0");
}

export function sanitizeToolCallId(id, providerConfig = {}) {
  if (isMistralProvider(providerConfig)) {
    return scrubMistralToolCallId(id);
  }
  if (isAnthropicProvider(providerConfig)) {
    return scrubClaudeToolCallId(id);
  }
  return toStr(id);
}

// ── Empty Content Filtering ──────────────────────────────────────────────────

/**
 * Anthropic and Bedrock reject messages with empty content.
 * Filter out empty string messages and empty text/reasoning parts.
 */
function filterEmptyContent(messages, providerConfig) {
  if (!isAnthropicProvider(providerConfig)) return messages;

  return messages
    .map((msg) => {
      if (!msg) return null;
      if (typeof msg.content === "string") {
        if (msg.content === "") return null;
        return msg;
      }
      if (!Array.isArray(msg.content)) return msg;
      const filtered = msg.content.filter((part) => {
        if (!part) return false;
        if (part.type === "text" || part.type === "reasoning") {
          return toStr(part.text) !== "";
        }
        return true;
      });
      if (filtered.length === 0) return null;
      return { ...msg, content: filtered };
    })
    .filter(Boolean);
}

// ── Tool Call ID Sanitization in Messages ────────────────────────────────────

function sanitizeToolCallIdsInMessages(messages, providerConfig) {
  const isAnthropic = isAnthropicProvider(providerConfig);
  const isMistral = isMistralProvider(providerConfig);
  if (!isAnthropic && !isMistral) return messages;

  const scrubber = isMistral ? scrubMistralToolCallId : scrubClaudeToolCallId;

  return messages.map((msg) => {
    if (!msg) return msg;
    if (msg.role !== "assistant" && msg.role !== "tool") return msg;

    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((part) => {
          if (!part) return part;
          if (part.type === "tool-call" || part.type === "tool_call" || part.type === "tool-result" || part.type === "tool_result") {
            if (part.toolCallId != null) {
              return { ...part, toolCallId: scrubber(part.toolCallId) };
            }
            if (part.tool_call_id != null) {
              return { ...part, tool_call_id: scrubber(part.tool_call_id) };
            }
          }
          return part;
        }),
      };
    }

    // Also check top-level toolCalls / tool_calls
    if (Array.isArray(msg.toolCalls)) {
      return {
        ...msg,
        toolCalls: msg.toolCalls.map((tc) =>
          tc?.callId != null ? { ...tc, callId: scrubber(tc.callId) } : tc,
        ),
      };
    }
    if (Array.isArray(msg.tool_calls)) {
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) =>
          tc?.id != null ? { ...tc, id: scrubber(tc.id) } : tc,
        ),
      };
    }

    return msg;
  });
}

// ── Message Sequence Fix ─────────────────────────────────────────────────────

/**
 * Some providers (Mistral, and Anthropic in strict mode) require that
 * tool messages are not directly followed by user messages. Insert a
 * minimal assistant message "Done." between them.
 */
function fixMessageSequence(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    result.push(msg);

    if (msg?.role === "tool" && next?.role === "user") {
      result.push({
        role: "assistant",
        content: "Done.",
      });
    }
  }
  return result;
}

// ── Unsupported Part Filter ──────────────────────────────────────────────────

/**
 * Remove unsupported image/file parts and replace with error text.
 * This is a lightweight version — full modality checking would need
 * a model capability registry.
 */
function filterUnsupportedParts(messages, providerConfig) {
  // For now, keep all parts. In the future, check model capabilities.
  // Anthropic and Gemini support images; OpenAI supports images.
  // Most others don't support PDF/video/audio yet.
  // We can add per-provider filters here as needed.
  return messages;
}

// ── Cache Control Injection ──────────────────────────────────────────────────

/**
 * Apply provider-specific cache control hints.
 * Mirrors OpenCode's applyCaching strategy:
 *   - System messages and final messages get cache hints
 *   - Different providers use different option keys
 */
function applyCacheControl(messages, providerConfig) {
  const isAnthropic = isAnthropicProvider(providerConfig);
  const isOpenRouter = isOpenRouterProvider(providerConfig);
  if (!isAnthropic && !isOpenRouter) return messages;

  const systemMessages = messages.filter((msg) => msg?.role === "system").slice(0, 2);
  const finalMessages = messages.filter((msg) => msg?.role !== "system").slice(-2);
  const targetSet = new Set([...systemMessages, ...finalMessages]);

  return messages.map((msg) => {
    if (!targetSet.has(msg)) return msg;

    const providerOptions = msg.providerOptions || {};

    if (isAnthropic) {
      return {
        ...msg,
        providerOptions: {
          ...providerOptions,
          anthropic: {
            ...providerOptions.anthropic,
            cacheControl: { type: "ephemeral" },
          },
        },
      };
    }

    if (isOpenRouter) {
      return {
        ...msg,
        providerOptions: {
          ...providerOptions,
          openrouter: {
            ...providerOptions.openrouter,
            cacheControl: { type: "ephemeral" },
          },
        },
      };
    }

    return msg;
  });
}

// ── Reasoning Content Remap ──────────────────────────────────────────────────

/**
 * Some providers require reasoning content to be placed in a specific
 * field rather than as interleaved content parts.
 */
function remapReasoningContent(messages, providerConfig) {
  // Check if provider needs reasoning remapped to a message field
  // (e.g., some OpenAI-compatible proxies use `reasoning_content`)
  // For now, Bosun's native adapters handle reasoning inline.
  return messages;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalize messages for a specific provider.
 * @param {Array} messages  Internal message array
 * @param {object} providerConfig  providerConfig from execOptions
 * @returns {Array} Normalized messages
 */
export function normalizeMessages(messages, providerConfig = {}) {
  if (!Array.isArray(messages)) return messages;

  let result = [...messages];
  result = filterEmptyContent(result, providerConfig);
  result = sanitizeToolCallIdsInMessages(result, providerConfig);
  result = fixMessageSequence(result);
  result = filterUnsupportedParts(result, providerConfig);
  result = applyCacheControl(result, providerConfig);
  result = remapReasoningContent(result, providerConfig);

  return result;
}

/**
 * Get provider-specific default temperature.
 * Returns undefined when the provider/model doesn't need a default override.
 */
export function getDefaultTemperature(providerConfig = {}) {
  const model = toStr(providerConfig?.model).toLowerCase();
  if (model.includes("qwen")) return 0.55;
  if (model.includes("claude")) return undefined;
  if (model.includes("gemini")) return 1.0;
  return undefined;
}

/**
 * Get provider-specific default topP.
 */
export function getDefaultTopP(providerConfig = {}) {
  const model = toStr(providerConfig?.model).toLowerCase();
  if (model.includes("qwen")) return 1;
  if (model.includes("gemini")) return 0.95;
  return undefined;
}

/**
 * Get provider-specific reasoning variant map.
 *
 * Returns a map like:
 *   {
 *     low: { reasoningEffort: "low" },
 *     high: { thinking: { type: "enabled", budgetTokens: 16000 } },
 *   }
 */
export function getReasoningVariants(providerConfig = {}) {
  const model = toStr(providerConfig?.model).toLowerCase();
  const provider = toStr(providerConfig?.provider || providerConfig?.providerId).toLowerCase();

  if (!providerConfig?.reasoningEffort && !model.includes("claude") && !model.includes("o1") && !model.includes("o3") && !model.includes("gemini")) {
    return {};
  }

  // Anthropic / Claude
  if (model.includes("claude") || provider.includes("anthropic") || provider.includes("claude")) {
    return {
      low: { thinking: { type: "enabled", budgetTokens: 4000 } },
      medium: { thinking: { type: "enabled", budgetTokens: 16000 } },
      high: { thinking: { type: "enabled", budgetTokens: 16000 } },
      max: { thinking: { type: "enabled", budgetTokens: 31999 } },
    };
  }

  // Gemini
  if (model.includes("gemini")) {
    if (model.includes("2.5")) {
      return {
        low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
        high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
      };
    }
    return {
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } },
    };
  }

  // OpenAI / Azure / OpenRouter (OpenAI-compatible)
  const efforts = ["low", "medium", "high"];
  if (model.includes("gpt-5") || model.includes("codex")) {
    efforts.unshift("minimal");
  }
  return Object.fromEntries(
    efforts.map((effort) => [effort, { reasoningEffort: effort }]),
  );
}

export default {
  normalizeMessages,
  sanitizeToolCallId,
  getDefaultTemperature,
  getDefaultTopP,
  getReasoningVariants,
};
