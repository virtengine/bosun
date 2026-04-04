/**
 * provider-model-pricing.mjs
 *
 * Per-model USD pricing table for cost-tracking.
 *
 * Prices are in USD per 1,000,000 tokens (input / output / cache-read).
 * Sources: OpenAI pricing (openai.com/api/pricing), Azure OpenAI pricing,
 *          OpenRouter model pages — verified April 2026.
 *
 * Usage:
 *   import { estimateCost, getModelPricing } from './provider-model-pricing.mjs';
 *   const cost = estimateCost('gpt-4o', 1500, 300); // → 0.00675
 */

// ── Pricing Table ─────────────────────────────────────────────────────────────
//
// Each entry:
//   input        : USD / 1M input tokens
//   output       : USD / 1M output tokens
//   cacheRead    : USD / 1M cached-input tokens (OpenAI prompt-cache / Anthropic cache-read)
//   cacheWrite   : USD / 1M cache-write tokens  (Anthropic only — 1.25× input)
//
// Keys use the canonical model-ID string as returned by the API.  Aliases are
// handled via resolveModelKey().

/** @type {Record<string, { input: number, output: number, cacheRead?: number, cacheWrite?: number }>} */
export const MODEL_PRICING = {
  // ── GPT-5.4 series — OpenAI API direct (Apr 2026) ─────────────────────────
  "gpt-5.4":              { input: 2.50,  output: 15.00, cacheRead: 0.25   },
  "gpt-5.4-mini":         { input: 0.75,  output: 4.50,  cacheRead: 0.075  },
  "gpt-5.4-nano":         { input: 0.20,  output: 1.25,  cacheRead: 0.02   },
  "gpt-5.4-pro":          { input: 10.00, output: 40.00, cacheRead: 2.50   },

  // ── GPT-5.3 series — Azure / OpenRouter (2026) ────────────────────────────
  // gpt-5.3 = gpt-5.3-codex architecture; chat variant available via OpenRouter
  "gpt-5.3-codex":        { input: 1.75,  output: 14.00, cacheRead: 0.175  },
  "gpt-5.3-chat":         { input: 1.75,  output: 14.00, cacheRead: 0.175  },

  // ── GPT-5.2 series — Azure (Apr 2026) ─────────────────────────────────────
  "gpt-5.2":              { input: 1.75,  output: 14.00, cacheRead: 0.18   },
  "gpt-5.2-codex":        { input: 1.75,  output: 14.00, cacheRead: 0.18   },
  "gpt-5.2-chat":         { input: 1.75,  output: 14.00, cacheRead: 0.18   },
  "gpt-5.2-pro":          { input: 15.00, output: 120.00 },

  // ── GPT-5.1 series — Azure (2026) ─────────────────────────────────────────
  "gpt-5.1":              { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5.1-codex":        { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5.1-codex-max":    { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5.1-codex-mini":   { input: 0.25,  output: 2.00,  cacheRead: 0.03   },
  "gpt-5.1-chat":         { input: 1.25,  output: 10.00, cacheRead: 0.13   },

  // ── GPT-5 series — Azure / OpenAI (2025-26) ───────────────────────────────
  "gpt-5":                { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5-2025-08-07":     { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5-mini":           { input: 0.25,  output: 2.00,  cacheRead: 0.03   },
  "gpt-5-nano":           { input: 0.05,  output: 0.40,  cacheRead: 0.01   },
  "gpt-5-pro":            { input: 15.00, output: 120.00 },
  "gpt-5-codex":          { input: 1.25,  output: 10.00, cacheRead: 0.13   },
  "gpt-5-chat":           { input: 1.25,  output: 10.00, cacheRead: 0.13   },

  // ── OpenAI o-series — current prices (Azure + OpenRouter, Apr 2026) ───────
  // Note: o3 received a major price cut — now $2/$8, down from original $10/$40.
  "o4-mini":              { input: 1.10,  output: 4.40,  cacheRead: 0.275  },
  "o4-mini-2025-04-16":   { input: 1.10,  output: 4.40,  cacheRead: 0.275  },
  "o3":                   { input: 2.00,  output: 8.00,  cacheRead: 0.50   },
  "o3-2025-04-16":        { input: 2.00,  output: 8.00,  cacheRead: 0.50   },
  "o3-mini":              { input: 1.10,  output: 4.40,  cacheRead: 0.55   },
  "o3-mini-2025-01-31":   { input: 1.10,  output: 4.40,  cacheRead: 0.55   },
  "o1":                   { input: 15.00, output: 60.00, cacheRead: 7.50   },
  "o1-2024-12-17":        { input: 15.00, output: 60.00, cacheRead: 7.50   },
  "o1-mini":              { input: 3.00,  output: 12.00, cacheRead: 1.50   },
  "o1-mini-2024-09-12":   { input: 3.00,  output: 12.00, cacheRead: 1.50   },
  "o1-preview":           { input: 15.00, output: 60.00 },
  "o1-preview-2024-09-12":{ input: 15.00, output: 60.00 },

  // ── GPT-4.1 series ────────────────────────────────────────────────────────
  "gpt-4.1":              { input: 2.00,  output: 8.00,  cacheRead: 0.50   },
  "gpt-4.1-2025-04-14":   { input: 2.00,  output: 8.00,  cacheRead: 0.50   },
  "gpt-4.1-mini":         { input: 0.40,  output: 1.60,  cacheRead: 0.10   },
  "gpt-4.1-mini-2025-04-14": { input: 0.40, output: 1.60, cacheRead: 0.10 },
  "gpt-4.1-nano":         { input: 0.10,  output: 0.40,  cacheRead: 0.025  },
  "gpt-4.1-nano-2025-04-14": { input: 0.10, output: 0.40, cacheRead: 0.025 },

  // ── GPT-4o series ─────────────────────────────────────────────────────────
  "gpt-4o":               { input: 2.50,  output: 10.00, cacheRead: 1.25   },
  "gpt-4o-2024-11-20":    { input: 2.50,  output: 10.00, cacheRead: 1.25   },
  "gpt-4o-2024-08-06":    { input: 2.50,  output: 10.00, cacheRead: 1.25   },
  "gpt-4o-2024-05-13":    { input: 5.00,  output: 15.00 },
  "gpt-4o-mini":          { input: 0.15,  output: 0.60,  cacheRead: 0.075  },
  "gpt-4o-mini-2024-07-18":{ input: 0.15, output: 0.60,  cacheRead: 0.075  },
  "chatgpt-4o-latest":    { input: 5.00,  output: 15.00 },

  // ── GPT-4 series (legacy) ─────────────────────────────────────────────────
  "gpt-4-turbo":          { input: 10.00, output: 30.00 },
  "gpt-4-turbo-2024-04-09":{ input: 10.00, output: 30.00 },
  "gpt-4":                { input: 30.00, output: 60.00 },
  "gpt-4-0613":           { input: 30.00, output: 60.00 },
  "gpt-4-32k":            { input: 60.00, output: 120.00 },

  // ── GPT-3.5 series (legacy) ───────────────────────────────────────────────
  "gpt-3.5-turbo":        { input: 0.50,  output: 1.50 },
  "gpt-3.5-turbo-0125":   { input: 0.50,  output: 1.50 },

  // ── OpenAI open-weight OSS ────────────────────────────────────────────────
  "gpt-oss-120b":         { input: 0.15,  output: 0.60 },
  "gpt-oss-20b":          { input: 0.07,  output: 0.30 },

  // ── Anthropic Claude series ───────────────────────────────────────────────
  "claude-opus-4-5":           { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "claude-opus-4":             { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "claude-sonnet-4-5":         { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-sonnet-4":           { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-7-sonnet-20250219":{ input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-7-sonnet-latest":  { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-5-sonnet-20241022":{ input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-5-sonnet-20240620":{ input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-5-haiku-20241022": { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  "claude-3-5-haiku-latest":   { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  "claude-3-opus-20240229":    { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  "claude-3-sonnet-20240229":  { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  "claude-3-haiku-20240307":   { input: 0.25,  output: 1.25,  cacheRead: 0.03,  cacheWrite: 0.30  },

  // ── xAI Grok series — via OpenRouter (Apr 2026) ───────────────────────────
  "grok-4.20":            { input: 2.00,  output: 6.00 },
  "grok-4.20-multi-agent":{ input: 2.00,  output: 6.00 },
  "grok-4.1-fast":        { input: 3.00,  output: 15.00, cacheRead: 0.75  },
  "grok-4-fast":          { input: 3.00,  output: 15.00, cacheRead: 0.75  },
  "grok-3":               { input: 3.00,  output: 15.00, cacheRead: 0.75  },
  "grok-3-beta":          { input: 3.00,  output: 15.00, cacheRead: 0.75  },

  // ── Google Gemini series (approximate, 2025) ───────────────────────────────
  "gemini-2.5-pro":       { input: 1.25,  output: 10.00 },
  "gemini-2.5-flash":     { input: 0.075, output: 0.30  },
  "gemini-2.0-flash":     { input: 0.10,  output: 0.40  },
  "gemini-1.5-pro":       { input: 1.25,  output: 5.00  },
  "gemini-1.5-flash":     { input: 0.075, output: 0.30  },
};

// ── Alias Map ─────────────────────────────────────────────────────────────────
// Model IDs that are commonly used as aliases / aliases returned by some APIs

const MODEL_ALIASES = {
  "gpt-5-latest":             "gpt-5",
  "gpt-5.4-latest":           "gpt-5.4",
  "gpt-5.3-codex-latest":     "gpt-5.3-codex",
  "gpt-5.2-latest":           "gpt-5.2",
  "gpt-5.1-latest":           "gpt-5.1",
  "gpt-4o-latest":            "gpt-4o",
  "gpt4o":                    "gpt-4o",
  "gpt-4-turbo-preview":      "gpt-4-turbo",
  "gpt4":                     "gpt-4",
  "claude-sonnet-latest":     "claude-3-7-sonnet-latest",
  "claude-opus-latest":       "claude-opus-4",
  "claude-haiku-latest":      "claude-3-5-haiku-latest",
  "o4-mini-high":             "o4-mini",
  "o3-mini-high":             "o3-mini",
  "grok-3-fast":              "grok-3",
  "grok-4.20-beta":           "grok-4.20",
  "grok-4.20-multi-agent-beta": "grok-4.20-multi-agent",
};

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied model string to the canonical pricing key.
 *
 * Strategy:
 *   1. Exact match in MODEL_PRICING
 *   2. Alias lookup
 *   3. Longest-prefix match (handles dated snapshot variants)
 *   4. Family fallback  (e.g. "gpt-4o-xxxxx" → "gpt-4o")
 *
 * @param {string} model
 * @returns {string|null}  canonical key, or null if unknown
 */
export function resolveModelKey(model) {
  if (!model || typeof model !== "string") return null;
  const m = model.trim().toLowerCase();

  if (MODEL_PRICING[m]) return m;
  if (MODEL_ALIASES[m]) return MODEL_ALIASES[m];

  // Longest prefix match (descending key length)
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (m.startsWith(key)) return key;
    if (key.startsWith(m)) return key;
  }

  return null;
}

/**
 * Get the pricing entry for a model.
 *
 * @param {string} model
 * @returns {{ input: number, output: number, cacheRead?: number, cacheWrite?: number }|null}
 */
export function getModelPricing(model) {
  const key = resolveModelKey(model);
  return key ? MODEL_PRICING[key] : null;
}

/**
 * Estimate the USD cost of a model call.
 *
 * @param {string} model           Model ID
 * @param {number} inputTokens     Billed input tokens (non-cached)
 * @param {number} outputTokens    Output / completion tokens
 * @param {number} [cacheReadTokens=0]   Prompt-cached tokens (cheaper)
 * @param {number} [cacheWriteTokens=0]  Cache-write tokens (Anthropic only)
 * @returns {number}  Estimated cost in USD (0 if model is unknown)
 */
export function estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  const perM = 1_000_000;
  const inputCost      = (Number(inputTokens)      || 0) * pricing.input        / perM;
  const outputCost     = (Number(outputTokens)     || 0) * pricing.output       / perM;
  const cacheReadCost  = (Number(cacheReadTokens)  || 0) * (pricing.cacheRead  ?? pricing.input * 0.5) / perM;
  const cacheWriteCost = (Number(cacheWriteTokens) || 0) * (pricing.cacheWrite ?? pricing.input * 1.25) / perM;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Compute cost from a normalised usage object (as returned by
 * normalizeProviderUsageMetadata).
 *
 * @param {string} model
 * @param {{ inputTokens, outputTokens, cacheInputTokens?, cacheWriteTokens? }} usage
 * @returns {number} USD
 */
export function estimateCostFromUsage(model, usage) {
  if (!usage || typeof usage !== "object") return 0;
  return estimateCost(
    model,
    Number(usage.inputTokens)      || 0,
    Number(usage.outputTokens)     || 0,
    Number(usage.cacheInputTokens) || 0,
    Number(usage.cacheWriteTokens) || 0,
  );
}

export default { MODEL_PRICING, MODEL_ALIASES, resolveModelKey, getModelPricing, estimateCost, estimateCostFromUsage };
