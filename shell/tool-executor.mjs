/**
 * tool-executor.mjs
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║           B O S U N   T O O L   E X E C U T O R                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Parallel + serial tool execution with per-tool timeouts, approval gating,
 * and type-safe result collection.
 *
 * ─── CONCURRENCY MODEL ──────────────────────────────────────────────────────
 *
 *  Inspired by Vercel AI SDK's TransformStream-based tool execution and
 *  Rust tokio's structured concurrency:
 *
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │  toolCalls = [A, B, C, D, E]                                         │
 *  │                                                                      │
 *  │  classify(tool)                                                       │
 *  │    → parallel:   A, C, D   (read-only / idempotent)                  │
 *  │    → serial:     B, E      (write / stateful)                        │
 *  │                                                                      │
 *  │  Phase 1: Promise.all([A, C, D])   ← tokio-style concurrent launch   │
 *  │  Phase 2: SerialQueue.run(B)       ← SerialJobExecutor pattern       │
 *  │           SerialQueue.run(E)                                          │
 *  │                                                                      │
 *  │  Results reunited in original call order for history consistency.     │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 *  Each tool call runs inside a per-tool AbortSignal that: 
 *    - inherits the session-level signal (user cancel propagates)
 *    - adds a per-tool timeout via AbortSignal.timeout(ms) if configured
 *    - never blocks other tools when one times out
 *
 * ─── APPROVAL GATING ────────────────────────────────────────────────────────
 *
 *  Each tool can have a `needsApproval` property:
 *    - boolean true → always gate
 *    - boolean false / absent → never gate
 *    - async function (args, ctx) → boolean  → dynamic decision per-call
 *
 *  When approval is needed and `execOptions.onApprovalRequest` is absent,
 *  the tool is allowed by default (non-interactive mode).
 *  When `onApprovalRequest` is provided, the executor suspends the tool call
 *  and waits for `{ approved: boolean, reason?: string }`.
 *
 * ─── DOOM-LOOP DETECTION ────────────────────────────────────────────────────
 *
 *  Inspired by OpenCode's doom-loop guard.
 *  Tracks (toolName + argsSignature) per session across rounds.
 *  If the same call appears MAX_IDENTICAL_CALLS consecutive times,
 *  the tool returns a synthetic error and the round is flagged.
 *
 * ─── PUBLIC API ─────────────────────────────────────────────────────────────
 *
 *  createToolExecutor(opts?)   → ToolExecutor instance
 *
 *  ToolExecutor:
 *    execute(toolCalls, execOptions)  → Promise<ToolExecutionBatch>
 *    classifyTool(toolDef)            → "parallel" | "serial"
 *    resetDoomLoopState(sessionId)    → void
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Default per-tool timeout when no timeout is configured (5 minutes). */
const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How many consecutive identical (name + args) calls before doom-loop fires.
 * Identical = same tool name AND same JSON-serialized arguments.
 */
const MAX_IDENTICAL_CALLS = 4;

// ── Utilities ────────────────────────────────────────────────────────────────

function toStr(v) {
  return String(v ?? "").trim();
}

/**
 * Compute a stable fingerprint for a tool call.
 * Used for doom-loop detection. We don't need crypto — just a compact key.
 */
function toolCallFingerprint(name, args) {
  let argsKey;
  try {
    // Sort keys for determinism regardless of arg ordering
    argsKey = JSON.stringify(args, Object.keys(args ?? {}).sort());
  } catch {
    argsKey = String(args ?? "");
  }
  return `${name}::${argsKey}`;
}

/**
 * Evaluate a `needsApproval` property.
 * Supports: boolean | async (args, ctx) => boolean
 */
async function evaluateApproval(needsApproval, args, ctx) {
  if (needsApproval == null || needsApproval === false) return false;
  if (needsApproval === true) return true;
  if (typeof needsApproval === "function") {
    try {
      return Boolean(await needsApproval(args, ctx));
    } catch {
      return false;
    }
  }
  return false;
}

// ── Serial Job Executor ──────────────────────────────────────────────────────

/**
 * Runs async jobs one at a time, in the order they were enqueued.
 * Direct port of Vercel AI SDK's SerialJobExecutor.
 */
class SerialJobExecutor {
  #queue = [];
  #busy = false;

  async #drain() {
    if (this.#busy) return;
    this.#busy = true;
    while (this.#queue.length > 0) {
      const job = this.#queue[0];
      try { await job.run(); } catch (err) { job.reject(err); }
      this.#queue.shift();
    }
    this.#busy = false;
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.#queue.push({
        run: async () => { resolve(await fn()); },
        reject,
      });
      void this.#drain();
    });
  }
}

// ── Core Tool Dispatcher ──────────────────────────────────────────────────────

/**
 * Dispatch a single tool call, respecting:
 *   - approval gating
 *   - per-tool timeout
 *   - session-level abort signal
 *   - doom-loop detection (caller-managed fingerprint map)
 *
 * Returns { callId, name, output, error?, timedOut?, denied? }
 */
async function dispatchSingleTool({
  tc,
  execOptions,
  toolDef,
  fingerprintMap,
  sessionId,
}) {
  const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
  const toolName = toStr(tc.name);
  const callId   = toStr(tc.callId || tc.id || "");

  // ── Parse arguments ───────────────────────────────────────────────────────
  let args = {};
  if (typeof tc.arguments === "object" && tc.arguments !== null) {
    args = tc.arguments;
  } else if (typeof tc.argumentsRaw === "string") {
    try { args = JSON.parse(tc.argumentsRaw); } catch { args = {}; }
  }

  // ── Doom-loop detection ───────────────────────────────────────────────────
  if (fingerprintMap) {
    const fp    = toolCallFingerprint(toolName, args);
    const count = (fingerprintMap.get(fp) ?? 0) + 1;
    fingerprintMap.set(fp, count);
    if (count > MAX_IDENTICAL_CALLS) {
      const errMsg = `Doom-loop detected: "${toolName}" called with identical arguments ${count} consecutive times. Aborting.`;
      onEvent?.({ type: "session.tool.doomloop", sessionId, toolName, callId, count });
      return { callId, name: toolName, output: JSON.stringify({ error: errMsg }), doomLoop: true };
    }
  }

  // ── Approval gating ───────────────────────────────────────────────────────
  const needsApproval = toolDef?.needsApproval ?? toolDef?.requiresApproval ?? false;
  const approvalCtx = {
    toolCallId: callId,
    sessionId,
    messages: execOptions?.messages ?? [],
    context: execOptions?.context,
  };
  const shouldGate = await evaluateApproval(needsApproval, args, approvalCtx);

  if (shouldGate && typeof execOptions?.onApprovalRequest === "function") {
    onEvent?.({ type: "session.tool.approval_request", sessionId, toolName, callId, args });
    let approved = false;
    let denialReason = "";
    try {
      const decision = await execOptions.onApprovalRequest({ toolName, callId, args, sessionId });
      approved = Boolean(decision?.approved ?? decision);
      denialReason = toStr(decision?.reason || "");
    } catch {
      approved = false;
    }
    if (!approved) {
      const msg = denialReason
        ? `Tool call denied: ${denialReason}`
        : `Tool call "${toolName}" was not approved.`;
      onEvent?.({ type: "session.tool.denied", sessionId, toolName, callId });
      return { callId, name: toolName, output: JSON.stringify({ error: msg }), denied: true };
    }
  }

  // ── Build abort signal (session + per-tool timeout) ───────────────────────
  const sessionSignal = execOptions?.abortController?.signal ?? null;
  const timeoutMs = Number(
    toolDef?.timeoutMs ??
    execOptions?.toolTimeouts?.[toolName] ??
    execOptions?.toolTimeoutMs ??
    DEFAULT_TOOL_TIMEOUT_MS,
  );
  const toolSignal = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? (sessionSignal
        ? AbortSignal.any([sessionSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs))
    : sessionSignal;

  // ── Execute ───────────────────────────────────────────────────────────────
  onEvent?.({ type: "session.tool.start", sessionId, toolName, callId, args });

  let output;
  let timedOut = false;

  try {
    const toolOrchestrator = execOptions?.toolOrchestrator;
    const toolRunner       = execOptions?.toolRunner;

    if (toolOrchestrator && typeof toolOrchestrator.executeTool === "function") {
      output = await toolOrchestrator.executeTool(toolName, args, {
        onEvent,
        sessionId,
        toolCallId: callId,
        abortSignal: toolSignal,
        context: execOptions?.context,
      });
    } else if (toolRunner && typeof toolRunner.runTool === "function") {
      output = await toolRunner.runTool(toolName, args, {
        onEvent,
        sessionId,
        abortSignal: toolSignal,
      });
    } else if (toolDef && typeof toolDef.execute === "function") {
      output = await toolDef.execute(args, {
        toolCallId: callId,
        sessionId,
        abortSignal: toolSignal,
        messages: execOptions?.messages ?? [],
        context: execOptions?.context,
      });
    } else {
      output = { error: `No executor configured for tool "${toolName}".` };
    }
  } catch (err) {
    timedOut = err?.name === "TimeoutError" ||
               String(err?.message ?? "").toLowerCase().includes("timeout");

    const msg = timedOut
      ? `Tool "${toolName}" timed out after ${timeoutMs}ms.`
      : String(err?.message || err);
    output = { error: msg };
  }

  const outputText = typeof output === "string"
    ? output
    : JSON.stringify(output ?? null);

  onEvent?.({ type: "session.tool.complete", sessionId, toolName, callId, output: outputText, timedOut });

  return { callId, name: toolName, output: outputText, timedOut };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createToolExecutor(factoryOpts = {}) {
  // Per-session doom-loop state: sessionId → Map<fingerprint, consecutiveCount>
  const _doomLoopState = new Map();

  /**
   * Classify a tool as "parallel" (safe to run concurrently) or "serial"
   * (must run in order after parallel batch completes).
   *
   * Heuristic:
   *   - explicit `parallel: false` → serial
   *   - explicit `parallel: true`  → parallel
   *   - tool names matching write-like patterns → serial
   *   - everything else → parallel
   *
   * @param {Object|null} toolDef  Tool definition from execOptions.toolDefinitions
   * @param {string}      name     Tool name (used for heuristic classification)
   * @returns {"parallel" | "serial"}
   */
  function classifyTool(toolDef, name = "") {
    // Explicit override on the tool definition
    if (toolDef?.parallel === false) return "serial";
    if (toolDef?.parallel === true)  return "parallel";

    // Heuristic: write-like name patterns → serial
    const lower = toStr(name).toLowerCase();
    const writePatterns = [
      "write", "create", "delete", "remove", "update", "patch", "put",
      "insert", "append", "rename", "move", "copy", "exec", "run",
      "apply", "commit", "push", "deploy", "reset", "clear", "kill",
      "terminate", "send", "post", "submit", "save",
    ];
    if (writePatterns.some((p) => lower.includes(p))) return "serial";

    return "parallel";
  }

  /**
   * Execute a full batch of tool calls from one assistant turn.
   *
   * Algorithm:
   *   1. Classify each call as parallel or serial.
   *   2. Run all parallel calls concurrently via Promise.all.
   *   3. Run all serial calls sequentially via SerialJobExecutor.
   *   4. Reunite results in original call order.
   *
   * @param {Array}  toolCalls    Array of tool call objects from the stream
   * @param {Object} execOptions  Standard exec options
   * @returns {Promise<ToolExecutionBatch>}
   */
  async function execute(toolCalls, execOptions = {}) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return { results: [], doomLoopDetected: false, anyTimedOut: false };
    }

    const sessionId    = toStr(execOptions?.sessionId || "ephemeral");
    const toolDefs     = execOptions?.toolDefinitions ?? {};

    // Ensure doom-loop fingerprint map for this session
    if (!_doomLoopState.has(sessionId)) {
      _doomLoopState.set(sessionId, new Map());
    }
    const fingerprintMap = _doomLoopState.get(sessionId);

    // ── Classify ──────────────────────────────────────────────────────────
    const parallelCalls = [];  // { index, tc, toolDef }
    const serialCalls   = [];  // { index, tc, toolDef }

    for (let i = 0; i < toolCalls.length; i++) {
      const tc      = toolCalls[i];
      const name    = toStr(tc.name || "");
      const toolDef = toolDefs[name] ?? null;
      const kind    = classifyTool(toolDef, name);
      if (kind === "parallel") {
        parallelCalls.push({ index: i, tc, toolDef });
      } else {
        serialCalls.push({ index: i, tc, toolDef });
      }
    }

    // Results array in original index order
    const results = new Array(toolCalls.length);
    const dispatchArgs = { execOptions, fingerprintMap, sessionId };

    // ── Phase 1: Parallel ─────────────────────────────────────────────────
    if (parallelCalls.length > 0) {
      const parallelResults = await Promise.allSettled(
        parallelCalls.map(({ tc, toolDef }) =>
          dispatchSingleTool({ tc, toolDef, ...dispatchArgs }),
        ),
      );
      for (let i = 0; i < parallelCalls.length; i++) {
        const { index, tc } = parallelCalls[i];
        const settled       = parallelResults[i];
        results[index] = settled.status === "fulfilled"
          ? settled.value
          : {
              callId: toStr(tc.callId || tc.id || ""),
              name:   toStr(tc.name || ""),
              output: JSON.stringify({ error: String(settled.reason?.message ?? settled.reason) }),
            };
      }
    }

    // ── Phase 2: Serial ───────────────────────────────────────────────────
    if (serialCalls.length > 0) {
      const serialExecutor = new SerialJobExecutor();
      await Promise.allSettled(
        serialCalls.map(({ index, tc, toolDef }) =>
          serialExecutor.run(async () => {
            const result = await dispatchSingleTool({ tc, toolDef, ...dispatchArgs });
            results[index] = result;
          }),
        ),
      );
    }

    // ── Fill any remaining slots (should not happen, defensive) ───────────
    for (let i = 0; i < results.length; i++) {
      if (results[i] == null) {
        const tc = toolCalls[i];
        results[i] = {
          callId: toStr(tc?.callId || tc?.id || ""),
          name:   toStr(tc?.name || ""),
          output: JSON.stringify({ error: "Tool dispatch result missing." }),
        };
      }
    }

    const doomLoopDetected = results.some((r) => r.doomLoop === true);
    const anyTimedOut      = results.some((r) => r.timedOut === true);

    return { results, doomLoopDetected, anyTimedOut };
  }

  /**
   * Resets doom-loop state for a session (e.g. when the user starts a new turn
   * intentionally, so the counter resets to zero).
   *
   * @param {string} sessionId
   */
  function resetDoomLoopState(sessionId) {
    if (sessionId) {
      _doomLoopState.delete(toStr(sessionId));
    }
  }

  /**
   * Returns current doom-loop state for debugging.
   */
  function getDoomLoopStats(sessionId) {
    const sid   = toStr(sessionId || "");
    const state = sid ? _doomLoopState.get(sid) : null;
    if (!state) return { sessionId: sid, fingerprints: [] };
    return {
      sessionId: sid,
      fingerprints: [...state.entries()].map(([fp, count]) => ({ fp, count })),
    };
  }

  return { execute, classifyTool, resetDoomLoopState, getDoomLoopStats };
}

export const defaultToolExecutor = createToolExecutor();
export default defaultToolExecutor;
