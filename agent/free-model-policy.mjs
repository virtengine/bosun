/**
 * free-model-policy.mjs
 *
 * Central policy for free-tier / slow-model failure modes observed on
 * OpenRouter free routes (e.g. nvidia/nemotron-3.5-lightning:free returning
 * finish_reason "length" with the whole budget consumed by reasoning, and
 * Zen free models with 16s cold starts / 55s tool turns).
 *
 * Covers the task acceptance criteria:
 *  - classify reasoning-only / length-truncated turns explicitly
 *  - slow-model-aware timeouts instead of fixed timeouts
 *  - per-model capability metadata for routing
 *  - per-turn observability (model, latency, finish reason, tokens)
 */

const FREE_TIER_MARKERS = [":free", "openrouter/free", "/free"];

// Observed free-tier latencies (task description): 16s cold start, 55s tool
// turns. Budgets below leave headroom above those observations.
export const FREE_TIER_FIRST_TURN_TIMEOUT_MS = 120_000;
export const FREE_TIER_TOOL_TURN_TIMEOUT_MS = 180_000;
export const FREE_TIER_MAX_RETRIES = 2;
export const STANDARD_TURN_TIMEOUT_MS = 60_000;

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toLowerId(value) {
  return toTrimmedString(value).toLowerCase();
}

/** True when the model id / route looks like a free-tier route. */
export function isFreeTierModel(modelId) {
  const normalized = toLowerId(modelId);
  if (!normalized) return false;
  return FREE_TIER_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Per-model capability metadata for free-tier routing. `toolCalling`
 * reliability and `reasoningStyle` let routers prefer models that actually
 * complete tasks instead of burning budget on reasoning-only turns.
 */
const FREE_MODEL_CAPABILITIES = Object.freeze({
  // Observed: returns finish_reason=length with response consumed by reasoning.
  "nvidia/nemotron-3.5-lightning:free": Object.freeze({
    modelId: "nvidia/nemotron-3.5-lightning:free",
    family: "nemotron",
    freeTier: true,
    toolCalling: "unreliable",
    reasoningStyle: "reasoning-heavy",
    truncatesToReasoning: true,
    prefersLowerReasoningBudget: true,
    recommendedReasoningEffort: "low",
    slowStart: false,
    notes: "Observed to return finish_reason=length with empty visible content.",
  }),
});

const GENERIC_FREE_CAPABILITY = Object.freeze({
  modelId: null,
  family: "free-tier",
  freeTier: true,
  toolCalling: "degraded",
  reasoningStyle: "reasoning-heavy-possible",
  truncatesToReasoning: false,
  prefersLowerReasoningBudget: true,
  recommendedReasoningEffort: "low",
  slowStart: true,
  notes: "Generic free-tier defaults: slow cold starts, prefer low reasoning budget.",
});

export function getModelCapabilities(modelId) {
  const id = toTrimmedString(modelId);
  const lower = toLowerId(id);
  for (const [key, caps] of Object.entries(FREE_MODEL_CAPABILITIES)) {
    if (lower === key.toLowerCase() || (lower && key.toLowerCase().includes(lower)) || (lower && lower.includes(key.toLowerCase()))) {
      return { ...caps, modelId: id || caps.modelId };
    }
  }
  if (isFreeTierModel(id)) {
    return { ...GENERIC_FREE_CAPABILITY, modelId: id };
  }
  return null;
}

/** Rank free-tier models for routing: reliable tool calling first. */
export function rankFreeModelsForRouting(modelIds = []) {
  const score = (caps) => {
    if (!caps) return 0;
    let s = 0;
    if (caps.toolCalling === "reliable") s += 3;
    else if (caps.toolCalling === "degraded") s += 1;
    if (caps.truncatesToReasoning) s -= 2;
    if (caps.slowStart) s -= 1;
    return s;
  };
  return [...modelIds].sort((a, b) => score(getModelCapabilities(b)) - score(getModelCapabilities(a)));
}

/**
 * Resolve a slow-model-aware per-turn timeout. Free-tier routes get the
 * elevated budgets; explicit caller timeouts still win when provided.
 */
export function resolveFreeTierTimeoutMs({ model, timeoutMs, isFirstTurn = false } = {}) {
  const explicit = Number(timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return Math.trunc(explicit);
  const envOverride = Number(process.env.BOSUN_FREE_MODEL_TIMEOUT_MS);
  if (Number.isFinite(envOverride) && envOverride > 0) return Math.trunc(envOverride);
  if (isFreeTierModel(model)) {
    return isFirstTurn ? FREE_TIER_FIRST_TURN_TIMEOUT_MS : FREE_TIER_TOOL_TURN_TIMEOUT_MS;
  }
  return STANDARD_TURN_TIMEOUT_MS;
}

export function resolveFreeTierRetries({ model, maxRetries } = {}) {
  const explicit = Number(maxRetries);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.trunc(explicit);
  if (isFreeTierModel(model)) return FREE_TIER_MAX_RETRIES;
  return 0;
}

function countTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 };
  }
  const inputTokens = Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens) || 0;
  const reasoningTokens = Number(
    usage.reasoningTokens
      ?? usage.reasoning_tokens
      ?? usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.raw?.completion_tokens_details?.reasoning_tokens
      ?? 0,
  ) || 0;
  return { inputTokens, outputTokens, totalTokens, reasoningTokens };
}

/**
 * Classify a completed turn for the free-model failure modes.
 *
 * Never returns a silent empty success: a response that is entirely
 * reasoning with empty visible content, or finish_reason=length with no
 * content/tools, is flagged as retryable with the reasoning-vs-content
 * split surfaced.
 */
export function classifyTruncatedTurn({
  text,
  reasoningText,
  toolCalls = [],
  finishReason,
  usage,
} = {}) {
  const visible = toTrimmedString(text);
  const reasoning = toTrimmedString(reasoningText);
  const normalizedFinish = toLowerId(finishReason);
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
  const { inputTokens, outputTokens, totalTokens, reasoningTokens } = countTokens(usage);
  const reasoningChars = reasoning.length;
  const contentChars = visible.length;
  const reasoningDominant = reasoningChars > 0 && (contentChars === 0 || reasoningChars > contentChars * 4);

  const isLength = normalizedFinish === "length" || normalizedFinish === "max_tokens";
  const emptyVisible = contentChars === 0 && !hasToolCalls;

  if (emptyVisible && reasoningChars > 0) {
    return {
      kind: isLength ? "truncated_length_reasoning_only" : "reasoning_only",
      retryable: true,
      fallbackAvailable: true,
      finishReason: normalizedFinish || null,
      contentChars,
      reasoningChars,
      reasoningDominant,
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      detail: isLength
        ? `finish_reason=length with empty visible content; ${reasoningChars} reasoning chars captured`
        : `empty visible content with ${reasoningChars} reasoning chars captured`,
    };
  }
  if (isLength && emptyVisible) {
    return {
      kind: "truncated_length_empty",
      retryable: true,
      fallbackAvailable: false,
      finishReason: normalizedFinish || null,
      contentChars,
      reasoningChars,
      reasoningDominant,
      inputTokens,
      outputTokens,
      totalTokens,
      reasoningTokens,
      detail: "finish_reason=length with empty visible content and no reasoning captured",
    };
  }
  return {
    kind: "ok",
    retryable: false,
    fallbackAvailable: false,
    finishReason: normalizedFinish || null,
    contentChars,
    reasoningChars,
    reasoningDominant,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    detail: "",
  };
}

/** Lower a reasoning budget one step for retries (high->medium->low->minimal). */
export function lowerReasoningBudget(current) {
  const normalized = toLowerId(current);
  if (normalized === "high" || normalized === "xhigh") return "medium";
  if (normalized === "medium") return "low";
  if (normalized === "low") return "minimal";
  if (!normalized) return "low";
  return normalized;
}

/** Build a single-line per-turn diagnostics record for logs. */
export function formatTurnDiagnostics({ model, latencyMs, finishReason, usage, classification } = {}) {
  const tokens = countTokens(usage);
  return {
    model: toTrimmedString(model) || "unknown",
    latencyMs: Number.isFinite(Number(latencyMs)) ? Math.trunc(Number(latencyMs)) : null,
    finishReason: toLowerId(finishReason) || "unknown",
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    reasoningTokens: tokens.reasoningTokens,
    contentChars: Number(classification?.contentChars) || 0,
    reasoningChars: Number(classification?.reasoningChars) || 0,
    classification: classification?.kind || "ok",
  };
}

/** Emit per-turn observability (model, latency, finish reason, tokens). */
export function logProviderTurn(record = {}, logger = console) {
  const entry = formatTurnDiagnostics(record);
  const line = `[free-model-policy] model=${entry.model} latencyMs=${entry.latencyMs ?? "?"} `
    + `finishReason=${entry.finishReason} tokens=${entry.inputTokens}/${entry.outputTokens}/${entry.totalTokens} `
    + `reasoningTokens=${entry.reasoningTokens} contentChars=${entry.contentChars} `
    + `reasoningChars=${entry.reasoningChars} classification=${entry.classification}`;
  try {
    if (typeof logger?.info === "function") logger.info(line);
    else if (typeof logger?.log === "function") logger.log(line);
  } catch {
    // Logging must never break execution.
  }
  return entry;
}

export default {
  isFreeTierModel,
  getModelCapabilities,
  rankFreeModelsForRouting,
  resolveFreeTierTimeoutMs,
  resolveFreeTierRetries,
  classifyTruncatedTurn,
  lowerReasoningBudget,
  formatTurnDiagnostics,
  logProviderTurn,
};
