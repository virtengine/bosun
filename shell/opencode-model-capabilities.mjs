/**
 * opencode-model-capabilities.mjs — Tool-use capability registry for OpenCode models.
 *
 * "Free" and "agent-capable" are separate properties. A model can be routable
 * (it answers plain chat prompts, including through the raw SDK) yet unable to
 * drive the agent path, which always issues tool calls. Such a model fails
 * every agent turn with:
 *
 *   `APIError: No endpoints found that support tool use`
 *
 * Verified live on 2026-09-27 through the real agent path
 * (`execOpencodePrompt(userMessage, options)` with the model from
 * `options.providerConfig` + `options.provider`):
 *
 * Tool-use UNSUPPORTED (fail on the agent path — do NOT configure these):
 *
 * | Model ID                                    | Notes                              |
 * |---------------------------------------------|------------------------------------|
 * | `opencode/space-bunny-free`                 | No tool-use endpoint               |
 * | `opencode/longcat-2.5-preview-free`         | No tool-use endpoint               |
 * | `opencode/mimo-v2.6-flash-free`             | No tool-use endpoint               |
 * | `opencode/muse-spark-1.3-contributor-free`  | No tool-use endpoint               |
 *
 * Tool-use SUPPORTED (succeed on the agent path — safe to configure):
 *
 * | Model ID                                   |
 * |--------------------------------------------|
 * | `opencode/nemotron-3-ultra-free`           |
 * | `opencode/ling-3.0-flash-fin-free`         |
 * | `opencode/nemotron-3.5-lightning-free`     |
 *
 * The same IDs may additionally be routable via the `opencode-go/` provider
 * prefix in some configurations; the prefix does not change capability, so it
 * is stripped before lookup.
 *
 * Consumers:
 *   - `shell/opencode-shell.mjs` runs `assertToolUseCapableModel()` before the
 *     first turn (preflight), so a misconfigured model is refused at config
 *     time instead of failing after a wasted turn.
 *   - `config/config-doctor.mjs` reports `OPENCODE_MODEL_TOOL_USE_UNSUPPORTED`
 *     for configured models on the unsupported list.
 */

export const OPENCODE_TOOL_USE_UNSUPPORTED_MODELS = Object.freeze([
  "space-bunny-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.3-contributor-free",
]);

export const OPENCODE_AGENT_CAPABLE_FREE_MODELS = Object.freeze([
  "nemotron-3-ultra-free",
  "ling-3.0-flash-fin-free",
  "nemotron-3.5-lightning-free",
]);

const TOOL_USE_UNSUPPORTED_RE = /no endpoints found that support tool use/i;

/**
 * Strip a provider prefix (`opencode/`, `opencode-go/`, …) and lowercase the
 * bare model id for capability lookup. Returns "" for empty input.
 */
export function normalizeOpencodeModelId(model) {
  const raw = String(model || "").trim();
  if (!raw) return "";
  const slashIdx = raw.indexOf("/");
  const bare = slashIdx >= 0 ? raw.slice(slashIdx + 1) : raw;
  return bare.trim().toLowerCase();
}

/** True when the model is on the known tool-use-unsupported list. */
export function isKnownToolUseUnsupportedModel(model) {
  const normalized = normalizeOpencodeModelId(model);
  if (!normalized) return false;
  return OPENCODE_TOOL_USE_UNSUPPORTED_MODELS.includes(normalized);
}

/** True when the model is on the known agent-capable free list. */
export function isKnownAgentCapableModel(model) {
  const normalized = normalizeOpencodeModelId(model);
  if (!normalized) return false;
  return OPENCODE_AGENT_CAPABLE_FREE_MODELS.includes(normalized);
}

/**
 * Describe what is known about a model's agent (tool-use) capability.
 * Returns `{ capable: true | false | null }` — null means unknown (not on
 * either list), in which case the model is allowed through: the lists only
 * encode verified 2026-09-27 observations, and an unknown model must not be
 * blocked on stale data.
 */
export function describeOpencodeModelCapability(model) {
  const normalized = normalizeOpencodeModelId(model);
  if (!normalized) return { capable: null, model: "", reason: "no model configured" };
  if (isKnownToolUseUnsupportedModel(normalized)) {
    return {
      capable: false,
      model: normalized,
      reason:
        `model "${normalized}" has no tool-use endpoint and fails every agent turn ` +
        `with "No endpoints found that support tool use".`,
      alternatives: [...OPENCODE_AGENT_CAPABLE_FREE_MODELS],
    };
  }
  if (isKnownAgentCapableModel(normalized)) {
    return {
      capable: true,
      model: normalized,
      reason: `model "${normalized}" is verified to support tool use on the agent path.`,
    };
  }
  return { capable: null, model: normalized, reason: "capability unknown — not on a verified list" };
}

/**
 * Preflight gate: returns an error string when the model is known to lack
 * tool use, or null when the turn may proceed (capable or unknown).
 */
export function getToolUsePreflightError(model) {
  const described = describeOpencodeModelCapability(model);
  if (described.capable !== false) return null;
  const alternatives = (described.alternatives || [])
    .map((id) => `opencode/${id}`)
    .join(", ");
  return (
    `:close: OpenCode model "${String(model || "").trim()}" does not support tool use ` +
    `(no endpoint for this model accepts tool calls), so it cannot run the agent path. ` +
    `Pick an agent-capable model instead${alternatives ? `: ${alternatives}` : ""}.`
  );
}

/**
 * True when an error/result message is the tool-use endpoint rejection, i.e.
 * the turn failed because the model cannot do tool use (as opposed to any
 * other provider failure).
 */
export function isToolUseUnsupportedError(value) {
  if (!value) return false;
  if (typeof value === "string") return TOOL_USE_UNSUPPORTED_RE.test(value);
  if (value instanceof Error) {
    return (
      TOOL_USE_UNSUPPORTED_RE.test(value.message || "") ||
      TOOL_USE_UNSUPPORTED_RE.test(JSON.stringify(value.data || "")) ||
      TOOL_USE_UNSUPPORTED_RE.test(JSON.stringify(value.error || ""))
    );
  }
  if (typeof value === "object") {
    const candidates = [
      value.message,
      value.data?.message,
      value.error?.message,
      value.error?.data?.message,
      value.info?.error?.message,
      value.info?.error?.data?.message,
      value.data?.info?.error?.message,
      value.data?.info?.error?.data?.message,
    ];
    if (candidates.some((entry) => typeof entry === "string" && TOOL_USE_UNSUPPORTED_RE.test(entry))) {
      return true;
    }
    try {
      return TOOL_USE_UNSUPPORTED_RE.test(JSON.stringify(value).slice(0, 4000));
    } catch {
      return false;
    }
  }
  return false;
}
