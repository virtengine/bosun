/**
 * message-pruner.mjs
 *
 * Surgical message-history pruning inspired by Vercel AI SDK `prune-messages.ts`.
 *
 * Goals:
 *   1. Remove `reasoning` / `thinking` tokens from non-tail assistant messages
 *      (they are debug-only and cost a lot; only the last turn needs them in context)
 *   2. Truncate oversized tool-output bodies in older turns to save tokens
 *   3. Remove whole message blocks (keeping tool-call/result pairs intact)
 *   4. Re-estimate token counts throughout so callers can budget accurately
 *
 * The pruner is deliberately non-destructive: it returns NEW arrays / objects
 * and never mutates the originals.
 *
 * Exports:
 *   pruneMessages(messages, opts) → messages[]
 *   createMessagePruner(opts)     → { prune(messages) }
 *   stripReasoningFromOldTurns(messages) → messages[]
 *   truncateToolOutputs(messages, maxChars) → messages[]
 *   pruneTailMessages(messages, keepCount) → messages[]
 */

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000;
const DEFAULT_KEEP_LAST_TURNS = 10;  // keep last 10 user-assistant pairs intact

// ── Utilities ─────────────────────────────────────────────────────────────────

function cloneEntry(entry) {
  return Object.assign({}, entry);
}

function isUserMessage(e)      { return e?.type === "user_message"; }
function isAssistantMessage(e) { return e?.type === "assistant_message"; }
function isFunctionCall(e)     { return e?.type === "function_call"; }
function isFunctionResult(e)   { return e?.type === "function_call_output"; }
function isCheckpoint(e)       { return e?.type === "compaction_checkpoint"; }

/**
 * Find the index of the Nth-from-the-end user message (1-based).
 * Returns -1 if there aren't that many user messages.
 */
function findNthLastUserMessageIndex(messages, n) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserMessage(messages[i])) {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

// ── Strategy 1: Strip reasoning from non-tail turns ──────────────────────────

/**
 * OpenAI reasoning models (o1, o3, o4-mini) and Anthropic Claude 3.7+ include
 * a `reasoning` / `thinking` field in assistant messages.  We only need these
 * in the most-recent assistant turn; older turns can be stripped to save tokens.
 *
 * Strips `reasoning`, `thinking`, `thoughts`, and `reasoningContent` from
 * all assistant messages except the last one.
 *
 * @param {object[]} messages  History entries
 * @returns {object[]}         New array with reasoning stripped from old turns
 */
export function stripReasoningFromOldTurns(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // Find index of last assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistantMessage(messages[i])) { lastAssistantIdx = i; break; }
  }

  return messages.map((entry, idx) => {
    if (!isAssistantMessage(entry)) return entry;
    if (idx === lastAssistantIdx) return entry;  // keep tail
    // Strip reasoning fields
    if (!entry.reasoning && !entry.thinking && !entry.thoughts && !entry.reasoningContent) {
      return entry;  // nothing to strip — return same reference
    }
    const stripped = cloneEntry(entry);
    delete stripped.reasoning;
    delete stripped.thinking;
    delete stripped.thoughts;
    delete stripped.reasoningContent;
    return stripped;
  });
}

// ── Strategy 2: Truncate oversized tool outputs ───────────────────────────────

/**
 * Large tool outputs (file reads, grep results, web pages) are expensive to
 * keep in full for old turns.  Truncate them to `maxChars` beyond a configurable
 * tail cut-off index.
 *
 * The last `keepLastTurns` user-assistant pairs are left untouched.
 *
 * @param {object[]} messages
 * @param {number}   maxChars       Max chars per tool output in old turns  (default 8000)
 * @param {number}   [keepLastTurns=10]  Number of recent turns to leave untouched
 * @returns {object[]}
 */
export function truncateToolOutputs(messages, maxChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS, keepLastTurns = DEFAULT_KEEP_LAST_TURNS) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const cutIdx = findNthLastUserMessageIndex(messages, keepLastTurns);

  return messages.map((entry, idx) => {
    if (!isFunctionResult(entry)) return entry;
    if (cutIdx !== -1 && idx >= cutIdx) return entry;  // in protected tail

    const output = typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output ?? "");
    if (output.length <= maxChars) return entry;

    const truncated = cloneEntry(entry);
    const half = Math.floor(maxChars / 2);
    truncated.output = output.slice(0, half) + `\n…[truncated ${output.length - maxChars} chars]…\n` + output.slice(-half);
    truncated._truncated = true;
    return truncated;
  });
}

// ── Strategy 3: Drop whole turn groups (pair-safe) ───────────────────────────

/**
 * Remove message groups (user turns + following assistant/tool pairs) beyond
 * `keepCount` user messages from the end.
 *
 * PAIR SAFETY: When a function_call is in the kept window but its matching
 * function_call_output is not (or vice versa), the pair is always kept together
 * or dropped together to avoid orphan entries that confuse the API.
 *
 * Checkpoints (compaction_checkpoint) are always kept.
 *
 * @param {object[]} messages
 * @param {number}   keepCount   Number of recent user turns to keep (default 10)
 * @returns {object[]}
 */
export function pruneTailMessages(messages, keepCount = DEFAULT_KEEP_LAST_TURNS) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const cutIdx = findNthLastUserMessageIndex(messages, keepCount);
  if (cutIdx <= 0) return messages;  // not enough history to prune

  // Collect call IDs referenced in the KEPT tail (cutIdx … end)
  const keptCallIds = new Set();
  for (let i = cutIdx; i < messages.length; i++) {
    const e = messages[i];
    if (isFunctionCall(e) && e.callId) keptCallIds.add(e.callId);
    if (isFunctionResult(e) && e.callId) keptCallIds.add(e.callId);
  }

  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const e = messages[i];

    // Always keep checkpoints
    if (isCheckpoint(e)) { result.push(e); continue; }

    // Keep everything from cut index onwards
    if (i >= cutIdx) { result.push(e); continue; }

    // Before the cut: only keep function_call / function_call_output whose
    // call_id is also referenced in the kept tail (orphan pair guard)
    if (isFunctionCall(e) || isFunctionResult(e)) {
      if (keptCallIds.has(e.callId)) { result.push(e); continue; }
      // Drop orphaned pair member — but we should never have cross-boundary pairs
      continue;
    }

    // Everything else before cutIdx is dropped
    // (user_message, assistant_message that aren't checkpoints)
  }
  return result;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Apply a configurable set of pruning strategies in order.
 *
 * Order (each strategy operates on the output of the previous):
 *   1. `stripReasoning`    — remove reasoning tokens from old assistant turns
 *   2. `truncateOutputs`   — shorten oversized tool outputs in old turns
 *   3. `keepLastTurns`     — drop old user-assistant groups entirely
 *
 * Options:
 * @param {object[]} messages   History entries
 * @param {object}   [opts]
 * @param {boolean}  [opts.stripReasoning=true]
 * @param {boolean}  [opts.truncateOutputs=true]
 * @param {number}   [opts.maxToolOutputChars=8000]
 * @param {number|false} [opts.keepLastTurns=false]  Set a number to enable group pruning
 * @returns {object[]}
 */
export function pruneMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const {
    stripReasoning   = true,
    truncateOutputs  = true,
    maxToolOutputChars = DEFAULT_MAX_TOOL_OUTPUT_CHARS,
    keepLastTurns    = false,  // off by default — caller must opt-in
  } = opts;

  let result = messages;

  if (stripReasoning) {
    result = stripReasoningFromOldTurns(result);
  }

  if (truncateOutputs) {
    result = truncateToolOutputs(result, maxToolOutputChars, typeof keepLastTurns === "number" ? keepLastTurns : DEFAULT_KEEP_LAST_TURNS);
  }

  if (typeof keepLastTurns === "number" && keepLastTurns > 0) {
    result = pruneTailMessages(result, keepLastTurns);
  }

  return result;
}

/**
 * Create a reusable pruner with fixed defaults.
 *
 * @param {object} [defaultOpts]   Same opts as pruneMessages
 * @returns {{ prune(messages: object[], overrideOpts?: object): object[] }}
 */
export function createMessagePruner(defaultOpts = {}) {
  return {
    prune(messages, overrideOpts = {}) {
      return pruneMessages(messages, { ...defaultOpts, ...overrideOpts });
    },
  };
}

export default {
  pruneMessages,
  createMessagePruner,
  stripReasoningFromOldTurns,
  truncateToolOutputs,
  pruneTailMessages,
};
