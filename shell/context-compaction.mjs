/**
 * context-compaction.mjs
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║         B O S U N   C O N T E X T   C O M P A C T I O N               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Multi-strategy conversation history management engine that prevents
 * context-window overflow while preserving maximum conversational fidelity.
 *
 * ─── STRATEGY CASCADE ────────────────────────────────────────────────────────
 *
 *  ① proactive      Triggered at SOFT threshold (≥ 70% of context window).
 *                   Calls the model for a structured summary; inserts a
 *                   compaction_checkpoint; drops the summarised head.
 *                   Best quality — no information is permanently lost.
 *                   Inspired by: Claude Code (proactive compaction)
 *
 *  ② pre_tool       Same as proactive but fires right before a tool-call
 *                   round when at MID threshold (≥ 85%). Prevents tool
 *                   outputs from blowing the remaining budget mid-round.
 *                   Inspired by: Claude Code (pre-tool-limit compaction)
 *
 *  ③ rollback       Triggered when the API returns context_length_exceeded.
 *                   Drops the oldest complete turn-group(s) and retries
 *                   without any extra API call — fast, zero quality cost
 *                   for short conversations.
 *                   Inspired by: Codex CLI (ContextManager rollback trimming)
 *
 *  ④ head_truncate  Hard drop when rollback alone is not enough. Shaves
 *                   individual messages from the head while keeping
 *                   tool-call output pairs strictly intact.
 *                   Inspired by: Claude Code (head_truncation fallback)
 *
 *  ⑤ minimal        Absolute last resort. Preserves only the most recent
 *                   compaction checkpoint (if any) + the last user message.
 *                   Never fails regardless of history size.
 *                   Inspired by: Claude Code (minimal fallback)
 *
 * ─── CHECKPOINT MARKERS ──────────────────────────────────────────────────────
 *
 *  After a summarisation compaction, the condensed head is replaced by a
 *  single synthetic entry:
 *    { type: "compaction_checkpoint", text, strategy, originalCount, timestamp }
 *
 *  The model receives this as a rich prior-context narrative. Multiple
 *  checkpoints accumulate as the session grows — each records when and why
 *  it was created, forming a recoverable audit trail.
 *  Inspired by: OpenCode (summary messages in SQLite)
 *
 * ─── TOKEN BUDGET TRACKING ───────────────────────────────────────────────────
 *
 *  • Per-session rolling input-token accumulation from API usage objects.
 *  • Fast character-ratio estimation for pre-call checks (no tokeniser dep).
 *  • Context window lookup table for 25+ common models (prefix-matched).
 *  • Four urgency levels: none → medium → high → critical.
 *  • Exposes getTokenBudget() so callers can surface live stats to the UI.
 *
 * ─── PUBLIC API ─────────────────────────────────────────────────────────────
 *
 *  createContextCompactor(factoryOpts?)   → Compactor instance
 *  estimateTokenCount(entries)            → number  (fast char-based)
 *  isContextOverflowError(err)            → boolean
 *  CONTEXT_WINDOWS                        → Record<string, number>
 *
 *  Compactor instance:
 *    shouldCompact(session, opts?)        → CompactionDecision
 *    compact(session, opts?)              → Promise<CompactionResult>
 *    onContextOverflow(session, opts?)    → Promise<CompactionResult>
 *    recordUsage(sessionId, usage)        → void
 *    getTokenBudget(sessionId, cw?)       → TokenBudget
 *    getStats(sessionId?)                 → CompactionStats
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Average characters per token across English prose + code. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Compaction threshold ratios (fraction of total context window).
 * - SOFT:      Proactive summarisation kicks in.
 * - MID:       Pre-tool summarisation kicks in.
 * - HARD:      Rollback drop kicks in (no API call).
 * - CRITICAL:  Head truncation kicks in (emergency).
 */
const THRESHOLD_PROACTIVE   = 0.70;
const THRESHOLD_PRE_TOOL    = 0.85;
const THRESHOLD_ROLLBACK    = 0.90;
const THRESHOLD_CRITICAL    = 0.95;

/**
 * How many complete user-turn-groups to always preserve at the tail.
 * These N groups are never summarised or dropped.
 */
const KEEP_RECENT_TURNS = 3;

/**
 * Minimum number of turn groups that must exist before any compaction fires.
 * Prevents premature compaction on very short sessions.
 */
const MIN_COMPACTABLE_TURNS = KEEP_RECENT_TURNS + 1;

/**
 * Maximum turn groups to drop in a single rollback pass.
 * Capped at 3 to avoid losing too much context at once.
 */
const ROLLBACK_MAX_DROPS = 3;

// ── Context Window Table ─────────────────────────────────────────────────────

/**
 * Total context window sizes for common models (prompt + output).
 * Used by shouldCompact() when the caller does not provide an explicit limit.
 * Prefix-matched: "gpt-4o-mini" matches on "gpt-4o-mini" key.
 */
export const CONTEXT_WINDOWS = {
  // ── OpenAI GPT-5.x series (2025-26) ────────────────────────────────────────
  "gpt-5.4":            200_000,
  "gpt-5.3":            200_000,
  "gpt-5.2":            200_000,
  "gpt-5.1":            200_000,
  "gpt-5":              200_000,
  // ── OpenAI o-series reasoning models ───────────────────────────────────────
  "o4-mini":            200_000,
  "o3-mini":            200_000,
  "o3":                 200_000,
  "o1-mini":            128_000,
  "o1-preview":         128_000,
  "o1":                 200_000,
  // ── GPT-4.1 family (1M context) ─────────────────────────────────────────────
  "gpt-4.1-nano":     1_047_576,
  "gpt-4.1-mini":     1_047_576,
  "gpt-4.1":          1_047_576,
  // ── GPT-4o family ───────────────────────────────────────────────────────────
  "gpt-4o-mini":        128_000,
  "gpt-4o":             128_000,
  // ── GPT-4 family (legacy) ───────────────────────────────────────────────────
  "gpt-4-turbo":        128_000,
  "gpt-4-0125-preview": 128_000,
  "gpt-4-1106-preview": 128_000,
  "gpt-4-32k":           32_768,
  "gpt-4":                8_192,
  // ── GPT-3.5 ─────────────────────────────────────────────────────────────────
  "gpt-3.5-turbo":       16_385,
  // ── Claude (via compatible proxy or native Anthropic) ───────────────────────
  "claude-opus-4":      200_000,
  "claude-sonnet-4":    200_000,
  "claude-3-7-sonnet":  200_000,
  "claude-3-5-sonnet":  200_000,
  "claude-3-5-haiku":   200_000,
  "claude-3-opus":      200_000,
  "claude-3-sonnet":    200_000,
  "claude-3-haiku":     200_000,
  // ── xAI Grok series (via OpenRouter) ────────────────────────────────────────
  "grok-4":             256_000,
  "grok-4.20":          256_000,
  "grok-3":             131_072,
  "grok-3-mini":        131_072,
  // ── Gemini (via compatible proxy) ───────────────────────────────────────────
  "gemini-2.5-pro":   1_000_000,
  "gemini-2.5-flash":   1_000_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-1.5-pro":   1_000_000,
  "gemini-1.5-flash": 1_000_000,
  // ── Mistral / LLaMA ─────────────────────────────────────────────────────────
  "mixtral-8x7b":        32_768,
  "llama-3":            128_000,
  // ── Safe default for unknown models ─────────────────────────────────────────
  "default":             32_000,
};

/** Returns the context window size for a given model name (prefix search). */
function resolveContextWindow(modelName) {
  if (!modelName) return CONTEXT_WINDOWS.default;
  const lower = String(modelName).toLowerCase().trim();
  // Exact match
  if (CONTEXT_WINDOWS[lower]) return CONTEXT_WINDOWS[lower];
  // Longest-prefix match (ensures "gpt-4o-mini" is preferred over "gpt-4")
  let best = null;
  let bestLen = 0;
  for (const [key, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (key === "default") continue;
    if (lower.startsWith(key) && key.length > bestLen) {
      best = size;
      bestLen = key.length;
    }
  }
  return best ?? CONTEXT_WINDOWS.default;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Fast character-based token count estimate across history entries.
 * Accurate to ±20% on mixed English/code content — sufficient for
 * threshold checks without requiring a tokeniser dependency.
 *
 * @param {Array<Object>} entries  History entries (any subset of session.messages)
 * @returns {number}
 */
export function estimateTokenCount(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 0;
  let chars = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    // Text content
    if (entry.text) chars += String(entry.text).length;
    // Tool output
    if (entry.output) chars += String(entry.output).length;
    // Tool arguments
    if (entry.arguments != null) {
      chars += typeof entry.arguments === "string"
        ? entry.arguments.length
        : JSON.stringify(entry.arguments).length;
    }
    // Tool name overhead
    if (entry.name) chars += entry.name.length;
    // JSON structural overhead per entry (~20 chars for roles, types, keys)
    chars += 20;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ── Context Overflow Detection ───────────────────────────────────────────────

/**
 * Returns true if the error is an OpenAI / Azure context-length-exceeded
 * error. Checks both the error message and common HTTP 400 body signatures.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isContextOverflowError(err) {
  if (!err) return false;
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("context_length_exceeded") ||
    msg.includes("maximum context length") ||
    msg.includes("max_tokens_exceeded") ||
    msg.includes("string too long") ||
    msg.includes("input is too long") ||
    msg.includes("tokens exceed") ||
    msg.includes("this model's maximum context")
  );
}

// ── Turn Group Extraction ────────────────────────────────────────────────────

/**
 * A "turn group" is a user_message (or compaction_checkpoint acting as
 * a session anchor) plus all subsequent assistant_message / function_call /
 * function_call_output entries that belong to it, up to the next user message.
 *
 * Keeping tool-call pairs in the same group ensures we never produce an
 * orphaned function_call_output in the history after a rollback drop.
 *
 * @typedef {{ startIndex: number, endIndex: number, entries: Object[] }} TurnGroup
 * @param {Object[]} messages
 * @returns {TurnGroup[]}
 */
function extractTurnGroups(messages) {
  const groups = [];
  let current = null;

  for (let i = 0; i < messages.length; i++) {
    const e = messages[i];
    const isAnchor = e.type === "user_message" || e.type === "compaction_checkpoint";

    if (isAnchor) {
      if (current) {
        current.endIndex = i - 1;
        groups.push(current);
      }
      current = { startIndex: i, endIndex: i, entries: [e] };
    } else if (current) {
      current.entries.push(e);
      current.endIndex = i;
    }
    // entries before the first user_message are silently attached to the first group
    // that forms — this handles synthetic system preambles if they appear.
  }

  if (current) {
    current.endIndex = messages.length - 1;
    groups.push(current);
  }

  return groups;
}

/** Flatten an array of TurnGroups back into a flat messages array. */
function flattenGroups(groups) {
  return groups.flatMap((g) => g.entries);
}

// ── Summarisation Prompt ─────────────────────────────────────────────────────

/**
 * Converts a single history entry to a human-readable string for the
 * summarisation prompt. Tool outputs are truncated at 2000 chars to prevent
 * the summary call itself from exceeding its own budget.
 */
function entryToReadable(entry) {
  switch (entry?.type) {
    case "user_message":
      return `USER:\n${entry.text ?? ""}`;

    case "assistant_message":
      return `ASSISTANT:\n${entry.text || "(no text — tool calls only)"}`;

    case "function_call": {
      const args = typeof entry.arguments === "string"
        ? entry.arguments
        : JSON.stringify(entry.arguments ?? {}, null, 2);
      return `TOOL CALL [${entry.name}]:\n${args}`;
    }

    case "function_call_output":
      return `TOOL RESULT [${entry.name ?? "unknown"}]:\n${
        String(entry.output ?? "").slice(0, 2000)
      }`;

    case "compaction_checkpoint":
      return `[PRIOR CONVERSATION SUMMARY]\n${entry.text ?? ""}`;

    default:
      return "";
  }
}

/**
 * Builds the full summarisation prompt from a slice of history entries.
 * The prompt is designed to elicit a structured, technically-dense summary
 * that a future assistant can use as drop-in context.
 */
function buildSummarisationPrompt(entries) {
  const dialogue = entries
    .map(entryToReadable)
    .filter(Boolean)
    .join("\n\n---\n\n");

  return (
    `You are summarizing a technical AI coding-assistant session for context continuity.\n` +
    `Produce a structured summary the assistant can use verbatim as prior-context.\n` +
    `Preserve ALL technical details: file paths, function names, error messages, code.\n\n` +
    `CONVERSATION:\n\n${dialogue}\n\n` +
    `Write the summary now in the following format:\n\n` +
    `## Prior Conversation Summary\n\n` +
    `### Goal\n` +
    `*(The user's primary objective and any active sub-goals.)*\n\n` +
    `### Progress & Decisions\n` +
    `*(Bullet list: what was accomplished, what was decided, and why.)*\n\n` +
    `### Key Technical Details\n` +
    `*(File paths, function signatures, variable names, config values, error messages,` +
    ` and any code that was created or modified.)*\n\n` +
    `### Current State\n` +
    `*(What is fully done, what is in progress, what is blocked or deferred.)*\n\n` +
    `### Pending Actions\n` +
    `*(Specific next steps, open questions, and what the user is likely to ask next.)*`
  );
}

// ── Compaction Strategies ────────────────────────────────────────────────────

/**
 * Build a compaction_checkpoint entry from a generated summary text.
 */
function makeCheckpoint(text, strategy, originalCount) {
  return {
    type: "compaction_checkpoint",
    text: String(text || ""),
    strategy,
    originalCount,
    timestamp: new Date().toISOString(),
  };
}

/**
 * STRATEGY: summarisation (proactive | pre_tool | manual)
 * Calls the provided summarise() callback, then replaces the head with
 * a compaction_checkpoint.
 *
 * @param {Object}   session      Live session object (mutated in-place)
 * @param {string}   strategy     "proactive" | "pre_tool" | "manual"
 * @param {Function} summariseFn  async (entries) → { summary: string, usage? }
 * @returns {Promise<CompactionResult>}
 */
async function applySummarisation(session, strategy, summariseFn) {
  const messages = session.messages;
  const groups = extractTurnGroups(messages);

  if (groups.length <= MIN_COMPACTABLE_TURNS) {
    // Not enough groups to safely split — fall back to rollback
    return applyRollback(session, "rollback");
  }

  // Split: head (to summarise) + tail (to keep verbatim)
  const keepCount  = KEEP_RECENT_TURNS;
  const headGroups = groups.slice(0, groups.length - keepCount);
  const tailGroups = groups.slice(groups.length - keepCount);

  const headEntries    = flattenGroups(headGroups);
  const originalCount  = headEntries.length;

  // Call the model for a summary
  const { summary, usage } = await summariseFn(headEntries);

  // Build the new history: checkpoint + tail
  const checkpoint  = makeCheckpoint(summary, strategy, originalCount);
  const tailEntries = flattenGroups(tailGroups);

  session.messages = [checkpoint, ...tailEntries];
  session.compactionCount = (session.compactionCount ?? 0) + 1;
  session.lastCompactionStrategy = strategy;
  session.lastCompactionAt = Date.now();

  return {
    compacted: true,
    strategy,
    removedCount: originalCount,
    newMessageCount: session.messages.length,
    checkpointAdded: true,
    summaryText: summary,
    usageFromSummary: usage ?? null,
  };
}

/**
 * STRATEGY: rollback (Codex-inspired)
 * Drops the oldest 1–ROLLBACK_MAX_DROPS complete turn groups from the head.
 * No API call required — purely local history surgery.
 *
 * @param {Object} session   Live session object (mutated in-place)
 * @param {string} strategy  "rollback" | "head_truncate" (controls label only)
 * @param {number} [dropCount=1]  How many turn groups to drop
 * @returns {CompactionResult}
 */
function applyRollback(session, strategy = "rollback", dropCount = 1) {
  const messages = session.messages;
  const groups   = extractTurnGroups(messages);

  // Must always keep at least KEEP_RECENT_TURNS groups
  const maxDroppable = Math.max(0, groups.length - KEEP_RECENT_TURNS);
  const effectiveDrop = Math.min(
    Math.max(1, dropCount),
    maxDroppable,
    ROLLBACK_MAX_DROPS,
  );

  if (effectiveDrop === 0) {
    // Nothing can be dropped — escalate to minimal
    return applyMinimal(session);
  }

  const dropped      = groups.slice(0, effectiveDrop);
  const kept         = groups.slice(effectiveDrop);
  const removedCount = flattenGroups(dropped).length;

  session.messages = flattenGroups(kept);
  session.compactionCount         = (session.compactionCount ?? 0) + 1;
  session.lastCompactionStrategy  = strategy;
  session.lastCompactionAt        = Date.now();

  return {
    compacted: true,
    strategy,
    removedCount,
    newMessageCount: session.messages.length,
    checkpointAdded: false,
    summaryText: null,
    usageFromSummary: null,
  };
}

/**
 * STRATEGY: head_truncate
 * Drops individual messages from the head while preserving:
 *   - All compaction_checkpoint entries (they may only be dropped as a last resort)
 *   - Tool-call pairs: a function_call_output is never orphaned
 * Continues until the estimated token count drops below THRESHOLD_ROLLBACK.
 *
 * @param {Object} session          Live session object (mutated in-place)
 * @param {number} targetWindow     Context window limit to trim toward
 * @returns {CompactionResult}
 */
function applyHeadTruncate(session, targetWindow = 32_000) {
  const targetTokens  = Math.floor(targetWindow * THRESHOLD_ROLLBACK);
  let   removedCount  = 0;

  // Build a set of callIds that have an output so we know which function_calls
  // are "safe" to drop (i.e. their output has already been dropped or will be).
  while (session.messages.length > KEEP_RECENT_TURNS * 2) {
    const current = estimateTokenCount(session.messages);
    if (current <= targetTokens) break;

    // Find the first droppable entry from the head
    let dropIdx = -1;
    for (let i = 0; i < session.messages.length; i++) {
      const e = session.messages[i];
      // Never drop checkpoints in head_truncate — they are the memory
      if (e.type === "compaction_checkpoint") continue;
      // Don't drop a function_call if its output is still present (would orphan it)
      if (e.type === "function_call") {
        const callId = e.callId;
        const hasOutput = session.messages.some(
          (m, j) => j > i && m.type === "function_call_output" && m.callId === callId,
        );
        if (hasOutput) {
          // Drop the function_call AND its output together
          const outputIdx = session.messages.findIndex(
            (m, j) => j > i && m.type === "function_call_output" && m.callId === callId,
          );
          if (outputIdx !== -1) {
            session.messages.splice(outputIdx, 1);
            session.messages.splice(i, 1);
            removedCount += 2;
          } else {
            session.messages.splice(i, 1);
            removedCount++;
          }
          dropIdx = i;
          break;
        }
      }
      dropIdx = i;
      session.messages.splice(i, 1);
      removedCount++;
      break;
    }

    if (dropIdx === -1) break; // Nothing left to drop
  }

  session.compactionCount         = (session.compactionCount ?? 0) + 1;
  session.lastCompactionStrategy  = "head_truncate";
  session.lastCompactionAt        = Date.now();

  return {
    compacted: removedCount > 0,
    strategy: "head_truncate",
    removedCount,
    newMessageCount: session.messages.length,
    checkpointAdded: false,
    summaryText: null,
    usageFromSummary: null,
  };
}

/**
 * STRATEGY: minimal (absolute last resort)
 * Keeps only: the most recent compaction_checkpoint (if any) + the last
 * user_message. Everything else is dropped.
 * Cannot fail regardless of history state.
 *
 * @param {Object} session  Live session object (mutated in-place)
 * @returns {CompactionResult}
 */
function applyMinimal(session) {
  const messages      = session.messages ?? [];
  const originalCount = messages.length;
  const survivors     = [];

  // Keep the most recent checkpoint (first one found from tail)
  const checkpointIdx = messages.findLastIndex(
    (m) => m.type === "compaction_checkpoint",
  );
  if (checkpointIdx !== -1) survivors.push(messages[checkpointIdx]);

  // Keep the last user_message
  const lastUserIdx = messages.findLastIndex((m) => m.type === "user_message");
  if (lastUserIdx !== -1 && lastUserIdx !== checkpointIdx) {
    survivors.push(messages[lastUserIdx]);
  }

  session.messages = survivors;
  session.compactionCount         = (session.compactionCount ?? 0) + 1;
  session.lastCompactionStrategy  = "minimal";
  session.lastCompactionAt        = Date.now();

  return {
    compacted: true,
    strategy: "minimal",
    removedCount: originalCount - survivors.length,
    newMessageCount: survivors.length,
    checkpointAdded: false,
    summaryText: null,
    usageFromSummary: null,
  };
}

// ── Compactor Factory ────────────────────────────────────────────────────────

/**
 * Creates a context compactor instance.
 * One instance is typically shared across all sessions in a process.
 *
 * @param {Object} [factoryOpts]
 * @returns {Compactor}
 */
export function createContextCompactor(factoryOpts = {}) {
  // Per-session token budget state
  // sessionId → { trackedInputTokens, lastContextWindow, compactionCount }
  const _budgets = new Map();

  // ── Internal helpers ────────────────────────────────────────────────────

  function getBudgetState(sessionId) {
    if (!sessionId) return null;
    if (!_budgets.has(sessionId)) {
      _budgets.set(sessionId, {
        trackedInputTokens: 0,
        lastContextWindow: 0,
        compactionCount: 0,
      });
    }
    return _budgets.get(sessionId);
  }

  function getEffectiveContextWindow(session, explicitWindow) {
    return (
      explicitWindow ||
      session?.contextWindow ||
      resolveContextWindow(session?.model || "")
    );
  }

  // ── Public methods ───────────────────────────────────────────────────────

  /**
   * Inspect session history and return a compaction recommendation.
   *
   * @param {Object} session
   * @param {Object} [opts]
   * @param {string} [opts.model]           Override model name for window lookup
   * @param {number} [opts.contextWindow]   Explicit context window override
   * @param {boolean}[opts.beforeToolRound] True when called before tool execution
   * @returns {CompactionDecision}
   */
  function shouldCompact(session, opts = {}) {
    const { beforeToolRound = false } = opts;
    const messages        = session?.messages ?? [];
    const contextWindow   = getEffectiveContextWindow(session, opts.contextWindow);
    const groups          = extractTurnGroups(messages);

    if (groups.length < MIN_COMPACTABLE_TURNS) {
      return {
        shouldCompact: false,
        strategy: null,
        urgency: "none",
        estimatedTokens: estimateTokenCount(messages),
        remainingBudget: contextWindow,
        reason: "insufficient history for compaction",
      };
    }

    // Prefer accumulated API usage over char estimate (more accurate)
    const budgetState      = getBudgetState(session?.id ?? null);
    const tracked          = budgetState?.trackedInputTokens ?? 0;
    const estimated        = estimateTokenCount(messages);
    const effectiveTokens  = Math.max(tracked, estimated);
    const usageRatio       = effectiveTokens / contextWindow;
    const remainingBudget  = Math.max(0, contextWindow - effectiveTokens);

    // Critical — hard truncation needed
    if (usageRatio >= THRESHOLD_CRITICAL) {
      return {
        shouldCompact: true, strategy: "head_truncate", urgency: "critical",
        estimatedTokens: effectiveTokens, remainingBudget,
        reason: `${(usageRatio * 100).toFixed(1)}% used — critical threshold`,
      };
    }

    // Hard — rollback drop
    if (usageRatio >= THRESHOLD_ROLLBACK) {
      return {
        shouldCompact: true, strategy: "rollback", urgency: "high",
        estimatedTokens: effectiveTokens, remainingBudget,
        reason: `${(usageRatio * 100).toFixed(1)}% used — rollback threshold`,
      };
    }

    // Pre-tool — summarise before tool round bloat
    if (beforeToolRound && usageRatio >= THRESHOLD_PRE_TOOL) {
      return {
        shouldCompact: true, strategy: "pre_tool", urgency: "high",
        estimatedTokens: effectiveTokens, remainingBudget,
        reason: `${(usageRatio * 100).toFixed(1)}% used — pre-tool threshold`,
      };
    }

    // Soft — proactive summarisation
    if (usageRatio >= THRESHOLD_PROACTIVE) {
      return {
        shouldCompact: true, strategy: "proactive", urgency: "medium",
        estimatedTokens: effectiveTokens, remainingBudget,
        reason: `${(usageRatio * 100).toFixed(1)}% used — proactive threshold`,
      };
    }

    return {
      shouldCompact: false, strategy: null, urgency: "none",
      estimatedTokens: effectiveTokens, remainingBudget,
      reason: "within budget",
    };
  }

  /**
   * Execute the compaction strategy for a session.
   *
   * The `summarise` callback is invoked only for strategies that require
   * an LLM call (proactive, pre_tool, manual). It receives the history
   * slice to be condensed and must resolve to `{ summary: string, usage? }`.
   * If the callback is absent or throws, the system falls back to rollback.
   *
   * @param {Object}   session
   * @param {Object}   [opts]
   * @param {string}   [opts.strategy]    Override strategy
   * @param {Function} [opts.summarise]   async (entries) → { summary, usage? }
   * @param {number}   [opts.contextWindow]
   * @returns {Promise<CompactionResult>}
   */
  async function compact(session, opts = {}) {
    const { strategy, summarise } = opts;
    const messages = session?.messages;

    if (!Array.isArray(messages) || messages.length < 2) {
      return noopResult("insufficient_history");
    }

    const contextWindow = getEffectiveContextWindow(session, opts.contextWindow);

    switch (strategy) {
      case "minimal":
        return applyMinimal(session);

      case "head_truncate":
        return applyHeadTruncate(session, contextWindow);

      case "rollback":
        return applyRollback(session, "rollback");

      case "proactive":
      case "pre_tool":
      case "manual":
      default: {
        // Try summarisation; fall back to rollback on error
        if (typeof summarise === "function") {
          try {
            return await applySummarisation(session, strategy ?? "proactive", summarise);
          } catch {
            return applyRollback(session, "rollback");
          }
        }
        // No summarise fn — use rollback
        return applyRollback(session, "rollback");
      }
    }
  }

  /**
   * Reactive handler: called when the API returns a context-length-exceeded
   * error. The system first attempts rollback (zero API cost), and if the
   * session is still dangerously large, escalates to head_truncate.
   *
   * Pass `summarise` if you want a quality-preserving summary attempt on
   * sessions with many accumulated groups.
   *
   * @param {Object}   session
   * @param {Object}   [opts]
   * @param {Function} [opts.summarise]  async (entries) → { summary, usage? }
   * @param {number}   [opts.contextWindow]
   * @returns {Promise<CompactionResult>}
   */
  async function onContextOverflow(session, opts = {}) {
    const { summarise } = opts;
    const contextWindow = getEffectiveContextWindow(session, opts.contextWindow);
    const messages      = session?.messages ?? [];

    if (messages.length === 0) return noopResult("empty_history");

    const groups = extractTurnGroups(messages);

    // Enough groups to attempt a quality summarisation?
    if (typeof summarise === "function" && groups.length > KEEP_RECENT_TURNS + 2) {
      try {
        return await applySummarisation(session, "rollback", summarise);
      } catch {
        // Fall through to raw rollback
      }
    }

    // Drop one turn group and see if that's enough
    const result = applyRollback(session, "rollback", 1);

    // If we're still well over the limit after one drop, head-truncate
    const remaining = estimateTokenCount(session.messages);
    if (remaining / contextWindow >= THRESHOLD_ROLLBACK) {
      return applyHeadTruncate(session, contextWindow);
    }

    return result;
  }

  /**
   * Record actual API throughput for a session.
   * Accumulated input tokens are used by shouldCompact() in preference to
   * the character-based estimate, giving accurate proactive trigger timing.
   *
   * @param {string} sessionId
   * @param {Object} usage  Normalised usage object from provider-usage-normalizer
   */
  function recordUsage(sessionId, usage) {
    if (!sessionId || !usage) return;
    const state = getBudgetState(sessionId);
    if (!state) return;
    // input tokens grow monotonically across the session
    const incoming = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
    if (incoming > state.trackedInputTokens) {
      state.trackedInputTokens = incoming;
    }
  }

  /**
   * Returns a token budget snapshot for a session for UI display.
   *
   * @param {string|null} sessionId
   * @param {number}      [contextWindowOverride]
   * @returns {TokenBudget}
   */
  function getTokenBudget(sessionId, contextWindowOverride) {
    const state = sessionId ? getBudgetState(sessionId) : null;
    const window = contextWindowOverride ?? state?.lastContextWindow ?? CONTEXT_WINDOWS.default;
    const used   = state?.trackedInputTokens ?? 0;
    const ratio  = window > 0 ? used / window : 0;

    return {
      contextWindow: window,
      usedTokens:    used,
      remainingTokens: Math.max(0, window - used),
      usageRatio: ratio,
      urgency: (
        ratio >= THRESHOLD_CRITICAL  ? "critical" :
        ratio >= THRESHOLD_ROLLBACK  ? "high"     :
        ratio >= THRESHOLD_PRE_TOOL  ? "medium"   :
        ratio >= THRESHOLD_PROACTIVE ? "low"       :
        "none"
      ),
    };
  }

  /**
   * Returns compaction statistics for a session (or all sessions).
   *
   * @param {string|null} [sessionId]
   * @returns {CompactionStats}
   */
  function getStats(sessionId) {
    if (sessionId) {
      const state = _budgets.get(String(sessionId));
      if (!state) return { sessionId, compactionCount: 0, trackedInputTokens: 0 };
      return { sessionId, ...state };
    }
    return {
      totalSessions: _budgets.size,
      sessions: [..._budgets.entries()].map(([id, s]) => ({ sessionId: id, ...s })),
    };
  }

  return {
    shouldCompact,
    compact,
    onContextOverflow,
    recordUsage,
    getTokenBudget,
    getStats,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function noopResult(reason) {
  return {
    compacted: false,
    strategy: "none",
    removedCount: 0,
    newMessageCount: 0,
    checkpointAdded: false,
    summaryText: null,
    usageFromSummary: null,
    reason,
  };
}

// ── Default Singleton ────────────────────────────────────────────────────────

export const defaultCompactor = createContextCompactor();
export default defaultCompactor;
