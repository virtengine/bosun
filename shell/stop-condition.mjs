/**
 * stop-condition.mjs
 *
 * Flexible loop-termination conditions for the tool-call loop, inspired by
 * Vercel AI SDK `stop-condition.ts` and `prepare-step.ts`.
 *
 * A StopCondition is any value that can be converted to a predicate:
 *   (stepState) → boolean
 *
 * stepState shape:
 *   {
 *     stepNumber: number,          // 1-based (starts at 1 after first LLM turn)
 *     roundCount: number,          // alias for stepNumber (legacy)
 *     toolCalls: object[],         // tool calls requested this turn
 *     toolResults: object[],       // results from this turn's tools
 *     stopReason: string,          // 'stop' | 'tool_calls' | 'max_tokens' | etc.
 *     text: string,                // assistant's text output this turn
 *     sessionId: string,
 *   }
 *
 * PrepareStep shape (return value from a prepareStep function):
 *   {
 *     model?: string,              // override model for this step
 *     tools?: object[],            // override tool set for this step
 *     maxTokens?: number,          // override max_tokens for this step
 *     systemPrompt?: string,       // override system prompt for this step
 *   }
 *
 * Exports:
 *   isStepCount(n)            → StopCondition  (stop after n steps)
 *   hasToolCall(names?)       → StopCondition  (stop when specific tool was called)
 *   isLoopFinished()          → StopCondition  (stop when no tool calls)
 *   never()                   → StopCondition  (never stop — run to MAX_TOOL_ROUNDS)
 *   always()                  → StopCondition  (always stop after first step)
 *   all(...conditions)        → StopCondition  (all must be true — AND)
 *   any(...conditions)        → StopCondition  (any must be true — OR)
 *   not(condition)            → StopCondition  (negate)
 *   isStopConditionMet(cond, stepState) → Promise<boolean>
 *   resolvePrepareStep(fn, stepState, currentOpts) → Promise<object>
 */

// ── Condition primitives ──────────────────────────────────────────────────────

/**
 * Stop after `n` tool/LLM steps.
 *
 * @param {number} n  Maximum number of steps (1 = stop after first LLM round)
 * @returns {(state: object) => boolean}
 */
export function isStepCount(n) {
  const max = Math.max(1, Math.floor(Number(n) || 1));
  return function stepCountCondition(state) {
    return (state?.stepNumber ?? state?.roundCount ?? 0) >= max;
  };
}

/**
 * Stop when the LLM calls (or requested) any of the specified tool names.
 * If no names are given, stops whenever ANY tool was called.
 *
 * @param {string|string[]} [names]  Tool name(s) to match, or omit for "any tool"
 * @returns {(state: object) => boolean}
 */
export function hasToolCall(names) {
  const nameSet = names
    ? new Set(Array.isArray(names) ? names.map(String) : [String(names)])
    : null;
  return function hasToolCallCondition(state) {
    const calls = Array.isArray(state?.toolCalls) ? state.toolCalls : [];
    if (calls.length === 0) return false;
    if (!nameSet) return true;  // any tool call satisfies
    return calls.some((tc) => nameSet.has(String(tc?.name || "")));
  };
}

/**
 * Stop when the LLM produces no tool calls (i.e., the loop is finished naturally).
 * Equivalent to "stop when stopReason is 'stop' or 'end_turn'".
 *
 * This is the natural turn-is-done condition.  Most loop implementations already
 * break on this; wiring it as a stop condition makes it composable.
 *
 * @returns {(state: object) => boolean}
 */
export function isLoopFinished() {
  return function loopFinishedCondition(state) {
    const tools = Array.isArray(state?.toolCalls) ? state.toolCalls : [];
    if (tools.length === 0) return true;
    const reason = String(state?.stopReason || "").toLowerCase();
    return reason === "stop" || reason === "end_turn";
  };
}

/**
 * Never stop (run to MAX_TOOL_ROUNDS).
 * @returns {() => false}
 */
export function never() {
  return () => false;
}

/**
 * Always stop after the first step.
 * @returns {() => true}
 */
export function always() {
  return () => true;
}

// ── Combinators ───────────────────────────────────────────────────────────────

/**
 * All conditions must be true (AND).
 * @param {...Function} conditions
 * @returns {(state: object) => Promise<boolean>}
 */
export function all(...conditions) {
  return async function allCondition(state) {
    for (const cond of conditions) {
      // eslint-disable-next-line no-await-in-loop
      const result = await isStopConditionMet(cond, state);
      if (!result) return false;
    }
    return true;
  };
}

/**
 * Any condition must be true (OR).
 * @param {...Function} conditions
 * @returns {(state: object) => Promise<boolean>}
 */
export function any(...conditions) {
  return async function anyCondition(state) {
    for (const cond of conditions) {
      // eslint-disable-next-line no-await-in-loop
      const result = await isStopConditionMet(cond, state);
      if (result) return true;
    }
    return false;
  };
}

/**
 * Negate a condition.
 * @param {Function} condition
 * @returns {(state: object) => Promise<boolean>}
 */
export function not(condition) {
  return async function notCondition(state) {
    return !(await isStopConditionMet(condition, state));
  };
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Evaluate a stop condition against the current step state.
 *
 * Accepts any of:
 *   - a plain function: (state) => boolean | Promise<boolean>
 *   - a number: treated as isStepCount(n)
 *   - null / undefined / false: never stops
 *   - true: always stops
 *
 * @param {*}      condition   The stop condition to evaluate
 * @param {object} stepState   Current step context
 * @returns {Promise<boolean>}
 */
export async function isStopConditionMet(condition, stepState) {
  if (condition == null || condition === false) return false;
  if (condition === true) return true;
  if (typeof condition === "number") return isStepCount(condition)(stepState);
  if (typeof condition === "function") {
    const result = condition(stepState);
    if (result && typeof result.then === "function") return Boolean(await result);
    return Boolean(result);
  }
  return false;
}

// ── prepareStep ───────────────────────────────────────────────────────────────

/**
 * Apply a `prepareStep` function (AI SDK pattern) to potentially override
 * model, tools, temperature, or maxTokens for the upcoming step.
 *
 * The `prepareStep` function may return:
 *   - an object with override fields
 *   - null/undefined to use defaults
 *   - a Promise of either
 *
 * Merges the returned overrides into `currentOpts` (shallow merge) and
 * returns the merged result, or `currentOpts` if `prepareStep` is not set.
 *
 * @param {Function|null}  prepareStep    User-supplied prepare function
 * @param {object}         stepState      Current step context
 * @param {object}         currentOpts    Current exec options (NOT mutated)
 * @returns {Promise<object>}
 */
export async function resolvePrepareStep(prepareStep, stepState, currentOpts = {}) {
  if (typeof prepareStep !== "function") return currentOpts;
  try {
    let overrides = prepareStep(stepState, currentOpts);
    if (overrides && typeof overrides.then === "function") overrides = await overrides;
    if (!overrides || typeof overrides !== "object") return currentOpts;

    const merged = { ...currentOpts };

    // Apply recognized override fields
    if (overrides.model != null)        merged.model = overrides.model;
    if (overrides.tools != null)        merged.tools = overrides.tools;
    if (overrides.maxTokens != null)    merged.maxTokens = overrides.maxTokens;
    if (overrides.systemPrompt != null) merged.systemPrompt = overrides.systemPrompt;
    if (overrides.temperature != null)  merged.temperature = overrides.temperature;
    if (overrides.providerConfig != null) {
      merged.providerConfig = { ...(currentOpts.providerConfig || {}), ...overrides.providerConfig };
    }

    return merged;
  } catch {
    // prepareStep errors are non-fatal — continue with current opts
    return currentOpts;
  }
}

export default {
  isStepCount,
  hasToolCall,
  isLoopFinished,
  never,
  always,
  all,
  any,
  not,
  isStopConditionMet,
  resolvePrepareStep,
};
