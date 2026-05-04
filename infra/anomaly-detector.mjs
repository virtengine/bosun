/**
 * anomaly-detector.mjs — Plaintext real-time anomaly detection for agent sessions.
 * Works with internal SDK/CLI event streams.
 *
 * Detects death loops, stalls, token overflows, rebase spirals, and other
 * wasteful agent behaviors by pattern-matching raw log lines. No AI inference —
 * purely regex/string-based detection for low latency.
 *
 * Integration:
 *   Wired into log stream callbacks in monitor.mjs.
 *   Each log line is fed to processLine(line, meta) which maintains per-process
 *   state and emits anomaly events via the onAnomaly callback.
 *
 * Architecture:
 *   - Per-process tracking via ProcessState objects
 *   - Sliding window counters for rate-based detection
 *   - Fingerprinted dedup to avoid alert spam
 *   - Severity levels: CRITICAL (kill), HIGH (kill at threshold/warn), MEDIUM (warn), LOW (info)
 *   - KILL action triggers at kill thresholds for all anomaly types (not just TOKEN_OVERFLOW)
 *   - Active process monitoring only (completed processes archived for analysis)
 *
 * Pattern catalog: See FAILURE_PATTERN_CATALOG.md
 */

import { normalizeDedupKey, stripAnsi, escapeHtml } from "../utils.mjs";

// ── Severity levels ─────────────────────────────────────────────────────────
export const Severity = /** @type {const} */ ({
  CRITICAL: "CRITICAL", // Reserved for TOKEN_OVERFLOW (unrecoverable)
  HIGH: "HIGH", // Serious issues requiring attention (but don't kill)
  MEDIUM: "MEDIUM", // Should warn, may need intervention
  LOW: "LOW", // Informational
});

// ── Anomaly types ───────────────────────────────────────────────────────────
export const AnomalyType = /** @type {const} */ ({
  TOKEN_OVERFLOW: "TOKEN_OVERFLOW",
  MODEL_NOT_SUPPORTED: "MODEL_NOT_SUPPORTED",
  STREAM_DEATH: "STREAM_DEATH",
  TOOL_CALL_LOOP: "TOOL_CALL_LOOP",
  REBASE_SPIRAL: "REBASE_SPIRAL",
  GIT_PUSH_LOOP: "GIT_PUSH_LOOP",
  SUBAGENT_WASTE: "SUBAGENT_WASTE",
  COMMAND_FAILURE_RATE: "COMMAND_FAILURE_RATE",
  TOOL_FAILURE_CASCADE: "TOOL_FAILURE_CASCADE",
  THOUGHT_SPINNING: "THOUGHT_SPINNING",
  SELF_DEBUG_LOOP: "SELF_DEBUG_LOOP",
  REPEATED_ERROR: "REPEATED_ERROR",
  IDLE_STALL: "IDLE_STALL",
});

// ── Default thresholds (configurable) ───────────────────────────────────────
const DEFAULT_THRESHOLDS = {
  // Tool call loop: N consecutive identical tool titles
  toolCallLoopWarn: 6,
  toolCallLoopKill: 12,

  // Rebase spiral: N rebase --continue commands
  rebaseWarn: 10,
  rebaseKill: 25,

  // Git push attempts in a session
  gitPushWarn: 4,
  gitPushKill: 8,

  // Subagent spawns per session
  subagentWarn: 10,
  subagentKill: 20,

  // Tool failures per session before alert
  toolFailureWarn: 10,
  toolFailureKill: 30,

  // Command failure rate (%) over sliding window
  commandFailureRateWarn: 25,

  // Thought repetition (same text N+ times)
  thoughtSpinWarn: 25,
  thoughtSpinKill: 50,

  // Model-not-supported failures before kill (high threshold — external issue)
  modelFailureKill: 5,

  // Repeated error fingerprint threshold
  repeatedErrorWarn: 5,
  repeatedErrorKill: 10,

  // Idle stall: seconds with no line activity
  idleStallWarnSec: 300, // 5 minutes
  idleStallKillSec: 600, // 10 minutes

  // Dedup window: don't re-alert same anomaly within this many ms
  alertDedupWindowMs: 5 * 60 * 1000,

  // Process state cleanup: remove tracking after this many ms of inactivity
  processCleanupMs: 30 * 60 * 1000,
};

// Thought patterns that are legitimate during long-running operations.
// Agents running test suites, builds, or installations will naturally repeat
// these status thoughts many times — they're progress indicators, not loops.
const THOUGHT_SPINNING_EXCLUSIONS = [
  /^running\s+\w*\s*tests?$/i,           // "Running integration tests", "Running portal tests", "Running unit tests"
  /^running\s+\w+$/i,                     // "Running prettier", "Running eslint"
  /^waiting\s+for\s+/i,                   // "Waiting for tests to complete"
  /^installing\s+/i,                      // "Installing dependencies"
  /^building\s+/i,                        // "Building the project"
  /^compiling\s+/i,                       // "Compiling TypeScript"
  /^testing\s+/i,                         // "Testing the implementation"
  /^executing\s+/i,                       // "Executing the command"
  /^checking\s+/i,                        // "Checking test results"
  /^analyzing\s+/i,                       // "Analyzing test output"
];

/**
 * Check if a thought is a legitimate operational status message
 * that should not count toward thought spinning detection.
 * @param {string} normalized - Lowercase, trimmed thought text
 * @returns {boolean}
 */
function isOperationalThought(normalized) {
  return THOUGHT_SPINNING_EXCLUSIONS.some((re) => re.test(normalized));
}

// ── Per-process state ───────────────────────────────────────────────────────

/**
 * @typedef {Object} ProcessState
 * @property {string} processId
 * @property {string} shortId
 * @property {number} lineCount
 * @property {number} firstLineAt
 * @property {number} lastLineAt
 * @property {string|null} lastToolTitle - Last ToolCall title seen
 * @property {number} lastToolCallFingerprint - DJB2 hash of last tool call (minus toolCallId)
 * @property {number} lastToolApproxFingerprint - DJB2 hash of normalized tool call content
 * @property {number} consecutiveSameToolCount - How many times in a row
 * @property {string|null} lastReasoningNormalized - Last exact normalized thought/reasoning text
 * @property {string|null} lastReasoningSkeleton - Last normalized thought/reasoning skeleton
 * @property {number} consecutiveNearReasoningCount - Consecutive near-identical reasoning streak
 * @property {number} rebaseCount - git rebase --continue count
 * @property {number} rebaseAbortCount
 * @property {number} gitPushCount
 * @property {number} subagentCount
 * @property {number} toolFailureCount
 * @property {number} commandCount - Total command executions
 * @property {number} commandFailureCount - Failed command executions
 * @property {Map<string, number>} thoughtCounts - Normalized thought text → count
 * @property {Map<string, number>} errorFingerprints - Error fingerprint → count
 * @property {number} modelFailureCount
 * @property {boolean} isDead - Process known to be dead/finished
 * @property {string|null} taskTitle
 * @property {string|null} branch
 * @property {Set<string>} alertsSent - Dedup keys for alerts already sent
 * @property {Map<string, number>} alertTimestamps - Dedup key → last alert time
 * @property {Map<string, number>} alertEmitCounts - type → total emit count (for escalation)
 */

/**
 * Create a fresh process state
 * @param {string} processId
 * @returns {ProcessState}
 */
function createProcessState(processId) {
  const now = Date.now();
  return {
    processId,
    shortId: processId.slice(0, 8),
    lineCount: 0,
    firstLineAt: now,
    lastLineAt: now,
    lastToolTitle: null,
    lastToolCallFingerprint: 0,
    lastToolApproxFingerprint: 0,
    consecutiveSameToolCount: 0,
    lastReasoningNormalized: null,
    lastReasoningSkeleton: null,
    consecutiveNearReasoningCount: 0,
    rebaseCount: 0,
    rebaseAbortCount: 0,
    gitPushCount: 0,
    subagentCount: 0,
    toolFailureCount: 0,
    commandCount: 0,
    commandFailureCount: 0,
    thoughtCounts: new Map(),
    errorFingerprints: new Map(),
    modelFailureCount: 0,
    isDead: false,
    taskTitle: null,
    branch: null,
    alertsSent: new Set(),
    alertTimestamps: new Map(),
    alertEmitCounts: new Map(),
  };
}

// ── Compiled patterns (computed once) ───────────────────────────────────────

// P0: Token overflow
const RE_TOKEN_OVERFLOW =
  /CAPIError: 400 prompt token count of (\d+) exceeds the limit of (\d+)/;

// P0: Model not supported
const STR_MODEL_NOT_SUPPORTED =
  "CAPIError: 400 The requested model is not supported";

// P0: JSON body parse failure — oversized payload or control-char corruption
// Example: "Failed to parse request body as json with error: ... BytePositionInLine: 81998"
const RE_INVALID_REQUEST_JSON =
  /Failed to parse request body as json|BytePositionInLine:\s*\d{4,}/;

// P1: Stream death
const STR_STREAM_DEATH = "Stream completed without a response.completed event";

// P1: Rebase spiral
const RE_REBASE_CONTINUE = /git rebase --continue/;
const RE_REBASE_ABORT = /git rebase --abort/;

// P2: Tool call (Copilot format) — extract title
const RE_TOOL_CALL_TITLE = /"ToolCall"\s*:\s*\{[^}]*"title"\s*:\s*"([^"]+)"/;

// P2: Strip toolCallId from tool call lines for content fingerprinting
// toolCallId changes every call, so we strip it to compare actual content
const RE_TOOL_CALL_ID = /"toolCallId"\s*:\s*"[^"]*"\s*,?\s*/g;

// Tools that are inherently iterative — agents legitimately call these many
// times on the same file during normal development (edit→test→edit cycles).
// These get multiplied thresholds to avoid false-positive kill signals.
const ITERATIVE_TOOL_PREFIXES = [
  "Editing ",       // replace_string_in_file, multi_replace_string_in_file
  "Reading ",       // read_file
  "Searching ",     // grep_search, file_search, semantic_search
  "Listing ",       // list_dir, list_code_usages
];

/**
 * Simple DJB2 string hash for fingerprinting tool call lines.
 * Not cryptographic — just fast dedup.
 * @param {string} str
 * @returns {number}
 */
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Check if a tool title represents an inherently iterative operation.
 * @param {string} title
 * @returns {boolean}
 */
function isIterativeTool(title) {
  return ITERATIVE_TOOL_PREFIXES.some((p) => title.startsWith(p));
}

/**
 * Normalize volatile values out of a tool call or response so we can detect
 * "same call, tiny arg drift" loops without requiring byte-for-byte identity.
 * We keep enough literal structure to avoid collapsing truly different edits.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeLoopSkeleton(text) {
  return String(text || "")
    .replace(RE_TOOL_CALL_ID, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b(?:0x)?[0-9a-f]{10,}\b/gi, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi, "<ts>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract assistant reasoning text from either Copilot thought lines or Codex
 * reasoning summaries.
 *
 * @param {string} line
 * @returns {string|null}
 */
function extractReasoningText(line) {
  const thoughtMatch = RE_THOUGHT_TEXT.exec(line);
  if (thoughtMatch?.[1]) return thoughtMatch[1];
  const summaryMatch = RE_REASONING_SUMMARY.exec(line);
  if (summaryMatch?.[1]) return summaryMatch[1];
  return null;
}

// P2: Tool failure (Copilot format)
const STR_TOOL_FAILED = '"status":"failed"';
const RE_TOOL_UPDATE_FAILED =
  /"ToolUpdate"\s*:\s*\{[^}]*"status"\s*:\s*"failed"/;

// P2: Git push
const RE_GIT_PUSH = /git push(?:\s|$)/;

// P2: Subagent spawn (Copilot format — ToolCall with "prompt" in rawInput)
const RE_SUBAGENT_SPAWN =
  /"ToolCall"\s*:\s*\{[^}]*"rawInput"\s*:\s*\{[^}]*"prompt"\s*:/;

// P3: Command failure (Codex format)
const RE_CMD_FAILED_CODEX =
  /"type"\s*:\s*"commandExecution"[^}]*"status"\s*:\s*"failed"/;
const RE_CMD_COMPLETED_CODEX =
  /"type"\s*:\s*"commandExecution"[^}]*"status"\s*:\s*"completed"/;

// P3: Thought tokens (Copilot format)
const RE_THOUGHT_TEXT =
  /"Thought"\s*:\s*\{\s*"type"\s*:\s*"text"\s*,\s*"text"\s*:\s*"([^"]+)"/;

// P3: Reasoning summary (Codex format)
const RE_REASONING_SUMMARY =
  /"type"\s*:\s*"reasoning"[^}]*"summary"\s*:\s*\["([^"]+)"/;

// Self-debugging keywords in reasoning
const SELF_DEBUG_KEYWORDS = [
  "troubleshooting",
  "debugging",
  "analyzing grep",
  "figuring out",
  "retrying",
  "diagnosing",
];

// Error line patterns
const RE_ERROR_PATTERNS = [
  /\bError:\s/i,
  /\bFailed\b.*\b(?:to|with)\b/i,
  /\bfatal\b/i,
  /\bpanic\b/i,
  /\bCAPIError\b/,
];

// Noise exclusions (don't count these as errors)
const RE_ERROR_NOISE = [
  /error=0/i,
  /errors: 0/i,
  /no errors/i,
  /\berror handling\b/i,
  /error_count.*:\s*0/i,
  /"status":"completed"/,
  /PASSED/,
];

// Session completion indicators
const RE_SESSION_DONE = /"Done"\s*:\s*"/;
const STR_TASK_COMPLETE = "task_complete";
const INTERNAL_SESSION_COMPLETION_MARKERS = [
  "EVT[turn.completed]",
  "EVT[session.completed]",
  "EVT[response.completed]",
  "EVT[thread.completed]",
];

// ── Main Detector Class ─────────────────────────────────────────────────────

export class AnomalyDetector {
  /** @type {Map<string, ProcessState>} Per-process state (active only) */
  #processes = new Map();

  /** @type {Map<string, ProcessState>} Completed processes (archived for analysis) */
  #completedProcesses = new Map();

  /** @type {(anomaly: Anomaly) => void} */
  #onAnomaly;

  /** @type {(text: string, options?: object) => void} */
  #notify;

  /** @type {typeof DEFAULT_THRESHOLDS} */
  #thresholds;

  /** @type {NodeJS.Timeout|null} */
  #cleanupInterval = null;

  /** @type {NodeJS.Timeout|null} */
  #stallCheckInterval = null;

  /** @type {Map<string, number>} Global anomaly counters by type */
  #globalCounts = new Map();

  /** @type {number} Total lines processed */
  #totalLines = 0;

  /** @type {number} Detector start time */
  #startedAt = Date.now();

  /**
   * @param {object} options
   * @param {(anomaly: Anomaly) => void} options.onAnomaly - Called when anomaly detected
   * @param {(text: string, options?: object) => void} [options.notify] - Notification function (Telegram)
   * @param {Partial<typeof DEFAULT_THRESHOLDS>} [options.thresholds] - Override defaults
   */
  constructor(options) {
    this.#onAnomaly = options.onAnomaly || (() => {});
    this.#notify = options.notify || (() => {});
    this.#thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }

  /**
   * Start background timers (stall detection, cleanup).
   * Call once after construction.
   */
  start() {
    // Check for idle stalls every 30 seconds
    this.#stallCheckInterval = setInterval(() => {
      this.#checkStalls();
    }, 30_000);
    this.#stallCheckInterval.unref?.();

    // Clean up old process state every 10 minutes
    this.#cleanupInterval = setInterval(() => {
      this.#cleanupOldProcesses();
    }, 10 * 60_000);
    this.#cleanupInterval.unref?.();
  }

  /**
   * Stop background timers.
   */
  stop() {
    if (this.#stallCheckInterval) {
      clearInterval(this.#stallCheckInterval);
      this.#stallCheckInterval = null;
    }
    if (this.#cleanupInterval) {
      clearInterval(this.#cleanupInterval);
      this.#cleanupInterval = null;
    }
  }

  /**
   * Process a single log line from the event stream.
   * This is the main entry point — called from the onLine callback.
   *
   * @param {string} rawLine - Raw log line
   * @param {object} meta - Metadata from the log stream
   * @param {string} meta.processId - Execution process ID
   * @param {string} meta.stream - "stdout" or "stderr"
   * @param {string} [meta.taskTitle] - Task title if known
   * @param {string} [meta.branch] - Git branch if known
   * @param {string} [meta.sessionId] - Session ID
   * @param {string} [meta.attemptId] - Attempt ID
   */
  processLine(rawLine, meta) {
    if (!rawLine || !meta?.processId) return;

    const line = stripAnsi(rawLine).trim();
    if (!line) return;
    if (line.length > 20000) return;

    this.#totalLines++;

    // Get or create per-process state
    const pid = meta.processId;
    if (this.#completedProcesses.has(pid)) {
      return;
    }
    let state = this.#processes.get(pid);
    if (!state) {
      state = createProcessState(pid);
      this.#processes.set(pid, state);
    }

    state.lineCount++;
    state.lastLineAt = Date.now();
    if (meta.taskTitle && !state.taskTitle) state.taskTitle = meta.taskTitle;
    if (meta.branch && !state.branch) state.branch = meta.branch;

    // Skip further analysis on dead/completed processes
    if (state.isDead) {
      // Archive completed process on first detection
      if (this.#processes.has(pid)) {
        this.#completedProcesses.set(pid, state);
        this.#processes.delete(pid);
      }
      return;
    }

    // ── Run all detectors (cheap string gates before regex) ──────────
    if (line.includes("CAPIError")) {
      this.#detectTokenOverflow(line, state);
      this.#detectModelNotSupported(line, state);
    }
    if (RE_INVALID_REQUEST_JSON.test(line)) {
      this.#detectInvalidRequestJson(line, state);
    }
    if (line.includes("Stream completed")) {
      this.#detectStreamDeath(line, state);
    }
    if (line.includes("ToolCall")) {
      this.#detectToolCallLoop(line, state);
      this.#detectSubagentWaste(line, state);
    }
    if (line.includes("ToolUpdate")) {
      this.#detectToolFailures(line, state);
    }
    if (line.includes("git ")) {
      this.#detectRebaseSpiral(line, state);
      this.#detectGitPushLoop(line, state);
    }
    if (line.includes("commandExecution")) {
      this.#detectCommandFailures(line, state);
    }
    if (line.includes("\"Thought\"") || line.includes("\"reasoning\"")) {
      this.#detectThoughtSpinning(line, state);
      this.#detectSelfDebugLoop(line, state);
    }
    if (line.includes("error") || line.includes("Error") || line.includes("ERROR")) {
      this.#detectRepeatedErrors(line, state);
    }
    this.#detectSessionCompletion(line, state);

    // Move completed processes out of the active map immediately so stats reflect completion.
    if (state.isDead && this.#processes.has(pid)) {
      this.#completedProcesses.set(pid, state);
      this.#processes.delete(pid);
    }
  }

  /**
   * Get anomaly statistics across all tracked processes.
   * @returns {object}
   */
  getStats() {
    const stats = {
      uptimeMs: Date.now() - this.#startedAt,
      totalLinesProcessed: this.#totalLines,
      activeProcesses: this.#processes.size,
      completedProcesses: this.#completedProcesses.size,
      deadProcesses: this.#completedProcesses.size,
      anomalyCounts: Object.fromEntries(this.#globalCounts),
      processes: /** @type {object[]} */ ([]),
    };

    for (const [pid, state] of this.#processes) {
      stats.processes.push({
        shortId: state.shortId,
        taskTitle: state.taskTitle || "(unknown)",
        lineCount: state.lineCount,
        isDead: state.isDead,
        toolFailures: state.toolFailureCount,
        rebaseCount: state.rebaseCount,
        gitPushCount: state.gitPushCount,
        subagentCount: state.subagentCount,
        modelFailures: state.modelFailureCount,
        consecutiveSameToolCount: state.consecutiveSameToolCount,
        lastToolTitle: state.lastToolTitle,
        idleSec: Math.round((Date.now() - state.lastLineAt) / 1000),
        alertEmitCounts: Object.fromEntries(state.alertEmitCounts),
        runtimeMin: Math.round((Date.now() - state.firstLineAt) / 60_000),
      });
    }

    return stats;
  }

  /**
   * Get a formatted status string suitable for Telegram /status command.
   * @returns {string}
   */
  getStatusReport() {
    const s = this.getStats();
    const uptimeMin = Math.round(s.uptimeMs / 60_000);
    const lines = [
      `<b>:search: Anomaly Detector Status</b>`,
      `Uptime: ${uptimeMin}m | Lines: ${s.totalLinesProcessed.toLocaleString()}`,
      `Active: ${s.activeProcesses} | Completed: ${s.completedProcesses}`,
    ];

    const counts = Object.entries(s.anomalyCounts);
    if (counts.length > 0) {
      lines.push(
        `\n<b>Anomalies detected:</b>`,
        ...counts.map(([type, count]) => `  ${type}: ${count}`),
      );
    } else {
      lines.push(`\nNo anomalies detected.`);
    }

    // Show any active concerns
    for (const proc of s.processes) {
      if (proc.isDead) continue;
      const concerns = [];
      if (proc.consecutiveSameToolCount >= this.#thresholds.toolCallLoopWarn) {
        concerns.push(
          `tool loop (${proc.consecutiveSameToolCount}x ${proc.lastToolTitle})`,
        );
      }
      if (proc.rebaseCount >= this.#thresholds.rebaseWarn) {
        concerns.push(`rebase spiral (${proc.rebaseCount})`);
      }
      if (proc.gitPushCount >= this.#thresholds.gitPushWarn) {
        concerns.push(`push loop (${proc.gitPushCount})`);
      }
      if (proc.idleSec >= this.#thresholds.idleStallWarnSec) {
        concerns.push(`idle ${proc.idleSec}s`);
      }
      // Show circuit-breaker escalation status
      const escalated = Object.entries(proc.alertEmitCounts || {}).filter(
        ([, c]) => c >= 3,
      );
      if (escalated.length > 0) {
        concerns.push(
          `escalated: ${escalated.map(([t, c]) => `${t}(${c}x)`).join(", ")}`,
        );
      }
      if (proc.runtimeMin >= 60) {
        concerns.push(`runtime ${proc.runtimeMin}min`);
      }
      if (concerns.length > 0) {
        lines.push(
          `\n:alert: <b>${escapeHtml(proc.shortId)}</b> (${escapeHtml(proc.taskTitle || "?")}):`,
          `  ${concerns.join(", ")}`,
        );
      }
    }

    return lines.join("\n");
  }

  /**
   * Reset a specific process's state (e.g., after restart).
   * @param {string} processId
   */
  resetProcess(processId) {
    this.#processes.delete(processId);
  }

  // ── Detector methods ──────────────────────────────────────────────────────

  /**
   * P0: Token count exceeds model limit — instant death.
   */
  #detectTokenOverflow(line, state) {
    const match = RE_TOKEN_OVERFLOW.exec(line);
    if (!match) return;

    const tokenCount = parseInt(match[1], 10);
    const limit = parseInt(match[2], 10);
    state.isDead = true;

    this.#emit({
      type: AnomalyType.TOKEN_OVERFLOW,
      severity: Severity.CRITICAL,
      processId: state.processId,
      shortId: state.shortId,
      taskTitle: state.taskTitle,
      message: `Token overflow: ${tokenCount.toLocaleString()} tokens vs ${limit.toLocaleString()} limit (+${(tokenCount - limit).toLocaleString()} over)`,
      data: { tokenCount, limit, overflow: tokenCount - limit },
      action: "kill",
    });
  }

  /**
   * P0: Codex API rejected request body as malformed JSON.
   * Two variants:
   *   1. Oversized payload (~1.5 MB) — body truncated mid-stream → "Expected end of string"
   *   2. Unescaped control chars (~82 KB) — '}' invalid in property position
   * Both mean the current thread/session state must be reset.
   * codex-shell.mjs sanitizeAndTruncatePrompt() prevents recurrence on next attempt.
   */
  #detectInvalidRequestJson(line, state) {
    if (!RE_INVALID_REQUEST_JSON.test(line)) return;

    // Extract byte position if present for richer diagnostics
    const byteMatch = /BytePositionInLine:\s*(\d+)/i.exec(line);
    const bytePos = byteMatch ? parseInt(byteMatch[1], 10) : null;
    const sizeHint = bytePos ? ` (payload byte pos ${bytePos.toLocaleString()})` : "";

    this.#emit({
      type: AnomalyType.REPEATED_ERROR,  // closest existing type; conveys "bad payload"
      severity: Severity.HIGH,
      processId: state.processId,
      shortId: state.shortId,
      taskTitle: state.taskTitle,
      message: `Codex API invalid_request_error: malformed JSON body${sizeHint} — prompt too large or contains unescaped control chars. Thread will be reset on next attempt.`,
      data: { bytePos, line: line.slice(0, 200) },
      action: "warn",
    });
  }

  /**
   * P0: Model not supported — subagent dies, parent wastes ~90s retrying.
   * While this is an external issue (Azure/model config), after enough failures
   * the agent is wasting compute spinning in retry loops. Kill it so the slot
   * is freed for a fresh attempt that might succeed after config fixes.
   */
  #detectModelNotSupported(line, state) {
    if (!line.includes(STR_MODEL_NOT_SUPPORTED)) return;

    state.modelFailureCount++;

    if (state.modelFailureCount >= this.#thresholds.modelFailureKill) {
      this.#emit({
        type: AnomalyType.MODEL_NOT_SUPPORTED,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Model not supported — ${state.modelFailureCount} failures, each wasting ~90s in retries`,
        data: { failureCount: state.modelFailureCount },
        action: "kill",
      });
    } else {
      this.#emit({
        type: AnomalyType.MODEL_NOT_SUPPORTED,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Model not supported failure #${state.modelFailureCount} (~90s wasted per retry)`,
        data: { failureCount: state.modelFailureCount },
        action: "warn",
      });
    }
  }

  /**
   * P1: Stream completed without response — session is dead.
   */
  #detectStreamDeath(line, state) {
    if (!line.includes(STR_STREAM_DEATH)) return;

    state.isDead = true;

    this.#emit({
      type: AnomalyType.STREAM_DEATH,
      severity: Severity.HIGH,
      processId: state.processId,
      shortId: state.shortId,
      taskTitle: state.taskTitle,
      message: "Stream completed without response — session dead",
      data: {},
      action: "restart",
    });
  }

  /**
   * P2: Consecutive identical tool calls — agent stuck in a loop.
   *
   * KEY: We fingerprint the ENTIRE tool call content (minus the ever-changing
   * toolCallId) so that different edits to the same file are NOT counted as
   * a loop. Only truly identical calls (same title, same arguments, same
   * content) increment the counter.
   *
   * Additionally, known-iterative tools (Editing, Reading, Searching) get
   * multiplied thresholds since agents legitimately call them many times
   * during normal edit→test→edit development cycles.
   */
  #detectToolCallLoop(line, state) {
    const match = RE_TOOL_CALL_TITLE.exec(line);
    if (!match) {
      // Non-tool-call lines don't reset the counter (reasoning/thought between calls is normal)
      return;
    }

    const title = match[1];
    const iterative = isIterativeTool(title);

    // Fingerprint the full tool call content, stripping the toolCallId which
    // changes every invocation. Two calls are "identical" only when both the
    // tool name AND the arguments/content are the same.
    const stripped = line.replace(RE_TOOL_CALL_ID, "");
    const fingerprint = djb2Hash(stripped);
    const approxNormalized = normalizeLoopSkeleton(stripped);
    const approxFingerprint = djb2Hash(approxNormalized);
    const sameExact =
      fingerprint === state.lastToolCallFingerprint && title === state.lastToolTitle;
    const sameNear =
      !sameExact &&
      !iterative &&
      approxNormalized.length >= 24 &&
      approxFingerprint === state.lastToolApproxFingerprint &&
      title === state.lastToolTitle;

    // Tool activity is real progress, so any reasoning/output streak should reset.
    state.lastReasoningNormalized = null;
    state.lastReasoningSkeleton = null;
    state.consecutiveNearReasoningCount = 0;

    if (sameExact || sameNear) {
      state.consecutiveSameToolCount++;
    } else {
      state.lastToolTitle = title;
      state.lastToolCallFingerprint = fingerprint;
      state.lastToolApproxFingerprint = approxFingerprint;
      state.consecutiveSameToolCount = 1;
    }

    state.lastToolTitle = title;
    state.lastToolCallFingerprint = fingerprint;
    state.lastToolApproxFingerprint = approxFingerprint;

    const count = state.consecutiveSameToolCount;
    const loopKind = sameNear ? "near_identical" : "identical";

    // Use elevated thresholds for inherently iterative tools (editing, reading)
    const warnThreshold = iterative
      ? this.#thresholds.toolCallLoopWarn * 3
      : this.#thresholds.toolCallLoopWarn;
    const killThreshold = iterative
      ? this.#thresholds.toolCallLoopKill * 3
      : this.#thresholds.toolCallLoopKill;

    if (count >= killThreshold) {
      this.#emit({
        type: AnomalyType.TOOL_CALL_LOOP,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Tool call death loop: "${title}" called ${count}x consecutively (${sameNear ? "near-identical" : "identical"} content)`,
        data: { tool: title, count, iterative, loopKind },
        action: "kill",
      });
    } else if (count >= warnThreshold) {
      this.#emit({
        type: AnomalyType.TOOL_CALL_LOOP,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Tool call loop: "${title}" called ${count}x consecutively (${sameNear ? "near-identical" : "identical"} content)`,
        data: { tool: title, count, iterative, loopKind },
        action: "warn",
      });
    }
  }

  /**
   * P2: Tool failures accumulating.
   */
  #detectToolFailures(line, state) {
    if (!RE_TOOL_UPDATE_FAILED.test(line)) return;

    state.toolFailureCount++;

    if (state.toolFailureCount >= this.#thresholds.toolFailureKill) {
      this.#emit({
        type: AnomalyType.TOOL_FAILURE_CASCADE,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Tool failure cascade: ${state.toolFailureCount} failures in session`,
        data: { count: state.toolFailureCount },
        action: "kill",
      });
    } else if (state.toolFailureCount >= this.#thresholds.toolFailureWarn) {
      this.#emit({
        type: AnomalyType.TOOL_FAILURE_CASCADE,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `High tool failure rate: ${state.toolFailureCount} failures in session`,
        data: { count: state.toolFailureCount },
        action: "warn",
      });
    }
  }

  /**
   * P1: Rebase --continue death spiral.
   */
  #detectRebaseSpiral(line, state) {
    if (RE_REBASE_CONTINUE.test(line)) {
      state.rebaseCount++;
    } else if (RE_REBASE_ABORT.test(line)) {
      state.rebaseAbortCount++;
      return; // abort is recovery, don't alert
    } else {
      return;
    }

    if (state.rebaseCount >= this.#thresholds.rebaseKill) {
      this.#emit({
        type: AnomalyType.REBASE_SPIRAL,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Rebase spiral detected: ${state.rebaseCount} rebase --continue attempts`,
        data: {
          rebaseCount: state.rebaseCount,
          abortCount: state.rebaseAbortCount,
        },
        action: "kill",
      });
    } else if (state.rebaseCount >= this.#thresholds.rebaseWarn) {
      this.#emit({
        type: AnomalyType.REBASE_SPIRAL,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Rebase spiral: ${state.rebaseCount} rebase --continue attempts`,
        data: {
          rebaseCount: state.rebaseCount,
          abortCount: state.rebaseAbortCount,
        },
        action: "warn",
      });
    }
  }

  /**
   * P2: Git push retry loop.
   */
  #detectGitPushLoop(line, state) {
    if (!RE_GIT_PUSH.test(line)) return;

    state.gitPushCount++;

    if (state.gitPushCount >= this.#thresholds.gitPushKill) {
      this.#emit({
        type: AnomalyType.GIT_PUSH_LOOP,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Git push loop detected: ${state.gitPushCount} push attempts`,
        data: { count: state.gitPushCount },
        action: "kill",
      });
    } else if (state.gitPushCount >= this.#thresholds.gitPushWarn) {
      this.#emit({
        type: AnomalyType.GIT_PUSH_LOOP,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Git push loop: ${state.gitPushCount} push attempts in session`,
        data: { count: state.gitPushCount },
        action: "warn",
      });
    }
  }

  /**
   * P2: Subagent over-spawning.
   */
  #detectSubagentWaste(line, state) {
    if (!RE_SUBAGENT_SPAWN.test(line)) return;

    state.subagentCount++;

    if (state.subagentCount >= this.#thresholds.subagentKill) {
      this.#emit({
        type: AnomalyType.SUBAGENT_WASTE,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Excessive subagent spawning: ${state.subagentCount} subagents`,
        data: { count: state.subagentCount },
        action: "kill",
      });
    } else if (state.subagentCount >= this.#thresholds.subagentWarn) {
      this.#emit({
        type: AnomalyType.SUBAGENT_WASTE,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `High subagent count: ${state.subagentCount} subagents spawned`,
        data: { count: state.subagentCount },
        action: "warn",
      });
    }
  }

  /**
   * P3: Command failure rate tracking (Codex format).
   */
  #detectCommandFailures(line, state) {
    if (RE_CMD_FAILED_CODEX.test(line)) {
      state.commandCount++;
      state.commandFailureCount++;
    } else if (RE_CMD_COMPLETED_CODEX.test(line)) {
      state.commandCount++;
    } else {
      return;
    }

    // Check failure rate after enough samples
    if (state.commandCount >= 10) {
      const rate = (state.commandFailureCount / state.commandCount) * 100;
      if (rate >= this.#thresholds.commandFailureRateWarn) {
        this.#emit({
          type: AnomalyType.COMMAND_FAILURE_RATE,
          severity: Severity.MEDIUM,
          processId: state.processId,
          shortId: state.shortId,
          taskTitle: state.taskTitle,
          message: `High command failure rate: ${rate.toFixed(0)}% (${state.commandFailureCount}/${state.commandCount})`,
          data: {
            rate,
            failed: state.commandFailureCount,
            total: state.commandCount,
          },
          action: "warn",
        });
      }
    }
  }

  /**
   * P3: Thought repetition (model spinning/looping).
   */
  #detectThoughtSpinning(line, state) {
    const thoughtText = extractReasoningText(line);
    if (!thoughtText) return;

    // Normalize: lowercase, trim, collapse whitespace
    const normalized = thoughtText.toLowerCase().trim().replace(/\s+/g, " ");
    // Skip short fragments — streaming often emits single tokens ("portal",
    // " trust", "the") that accumulate massive counts but aren't real repeated
    // thoughts. Require at least 12 chars (~2-3 words) to count as a trackable
    // thought pattern.
    if (normalized.length < 12) return;

    // Skip operational status messages — agents running tests, builds, or
    // installations legitimately repeat status thoughts like "Running integration
    // tests" many times. These are progress indicators, not loops.
    if (isOperationalThought(normalized)) return;

    const skeleton = normalizeLoopSkeleton(normalized);
    const sameNear =
      skeleton.length >= 18 &&
      state.lastReasoningSkeleton === skeleton;
    if (sameNear) {
      state.consecutiveNearReasoningCount++;
    } else {
      state.lastReasoningSkeleton = skeleton;
      state.consecutiveNearReasoningCount = 1;
    }
    state.lastReasoningNormalized = normalized;

    const count = (state.thoughtCounts.get(normalized) || 0) + 1;
    state.thoughtCounts.set(normalized, count);
    const nearCount = state.consecutiveNearReasoningCount;

    if (count >= this.#thresholds.thoughtSpinKill) {
      this.#emit({
        type: AnomalyType.THOUGHT_SPINNING,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Thought spinning: "${thoughtText}" repeated ${count}x — model may be looping`,
        data: { thought: thoughtText, count },
        action: "kill",
      });
    } else if (nearCount >= this.#thresholds.thoughtSpinKill) {
      this.#emit({
        type: AnomalyType.THOUGHT_SPINNING,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Near-identical reasoning loop: "${thoughtText}" repeated ${nearCount}x with only minor variation`,
        data: {
          thought: thoughtText,
          count: nearCount,
          loopKind: "near_identical_reasoning",
        },
        action: "kill",
      });
    } else if (count >= this.#thresholds.thoughtSpinWarn) {
      this.#emit({
        type: AnomalyType.THOUGHT_SPINNING,
        severity: Severity.LOW,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Thought repetition: "${thoughtText}" repeated ${count}x`,
        data: { thought: thoughtText, count },
        action: "info",
      });
    } else if (nearCount >= this.#thresholds.thoughtSpinWarn) {
      this.#emit({
        type: AnomalyType.THOUGHT_SPINNING,
        severity: Severity.LOW,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Near-identical reasoning streak: "${thoughtText}" repeated ${nearCount}x with only minor variation`,
        data: {
          thought: thoughtText,
          count: nearCount,
          loopKind: "near_identical_reasoning",
        },
        action: "info",
      });
    }
  }

  /**
   * P3: Self-debugging reasoning loops (Codex format).
   */
  #detectSelfDebugLoop(line, state) {
    const match = RE_REASONING_SUMMARY.exec(line);
    if (!match) return;

    const summary = match[1].toLowerCase();
    const isDebug = SELF_DEBUG_KEYWORDS.some((kw) => summary.includes(kw));
    if (!isDebug) return;

    this.#emit({
      type: AnomalyType.SELF_DEBUG_LOOP,
      severity: Severity.LOW,
      processId: state.processId,
      shortId: state.shortId,
      taskTitle: state.taskTitle,
      message: `Agent self-debugging: "${match[1]}"`,
      data: { summary: match[1] },
      action: "info",
    });
  }

  /**
   * P3: Repeated error fingerprints.
   */
  #detectRepeatedErrors(line, state) {
    // Only check lines that look like errors
    if (RE_ERROR_NOISE.some((re) => re.test(line))) return;
    if (!RE_ERROR_PATTERNS.some((re) => re.test(line))) return;

    const fingerprint = normalizeDedupKey(line).slice(0, 120);
    const count = (state.errorFingerprints.get(fingerprint) || 0) + 1;
    state.errorFingerprints.set(fingerprint, count);

    if (count >= this.#thresholds.repeatedErrorKill) {
      this.#emit({
        type: AnomalyType.REPEATED_ERROR,
        severity: Severity.HIGH,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Repeated error (${count}x): ${line.slice(0, 150)}`,
        data: { fingerprint, count },
        action: "kill",
      });
    } else if (count >= this.#thresholds.repeatedErrorWarn) {
      this.#emit({
        type: AnomalyType.REPEATED_ERROR,
        severity: Severity.MEDIUM,
        processId: state.processId,
        shortId: state.shortId,
        taskTitle: state.taskTitle,
        message: `Repeated error (${count}x): ${line.slice(0, 150)}`,
        data: { fingerprint, count },
        action: "warn",
      });
    }
  }

  /**
   * Detect session completion (mark as dead to stop analysis).
   */
  #detectSessionCompletion(line, state) {
    if (
      RE_SESSION_DONE.test(line) ||
      line.includes(STR_TASK_COMPLETE) ||
      INTERNAL_SESSION_COMPLETION_MARKERS.some((marker) =>
        line.includes(marker),
      )
    ) {
      state.isDead = true;
    }
  }

  // ── Stall detection (timer-based) ─────────────────────────────────────────

  /**
   * Check all active processes for idle stalls.
   * Called on a 30-second interval.
   */
  #checkStalls() {
    const now = Date.now();
    for (const [, state] of this.#processes) {
      if (state.isDead) continue;
      if (state.lineCount < 5) continue; // Don't alert on brand-new processes

      const idleMs = now - state.lastLineAt;

      if (idleMs >= this.#thresholds.idleStallKillSec * 1000) {
        this.#emit({
          type: AnomalyType.IDLE_STALL,
          severity: Severity.HIGH,
          processId: state.processId,
          shortId: state.shortId,
          taskTitle: state.taskTitle,
          message: `Agent may be stalled: no output for ${Math.round(idleMs / 1000)}s`,
          data: { idleSec: Math.round(idleMs / 1000) },
          action: "kill",
        });
      } else if (idleMs >= this.#thresholds.idleStallWarnSec * 1000) {
        this.#emit({
          type: AnomalyType.IDLE_STALL,
          severity: Severity.MEDIUM,
          processId: state.processId,
          shortId: state.shortId,
          taskTitle: state.taskTitle,
          message: `Agent may be stalled: no output for ${Math.round(idleMs / 1000)}s`,
          data: { idleSec: Math.round(idleMs / 1000) },
          action: "warn",
        });
      }
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Remove process state for processes inactive beyond cleanup threshold.
   * Cleans both active and completed process archives.
   */
  #cleanupOldProcesses() {
    const now = Date.now();
    // Clean active processes
    for (const [pid, state] of this.#processes) {
      if (now - state.lastLineAt > this.#thresholds.processCleanupMs) {
        this.#processes.delete(pid);
      }
    }
    // Clean completed process archives
    for (const [pid, state] of this.#completedProcesses) {
      if (now - state.lastLineAt > this.#thresholds.processCleanupMs) {
        this.#completedProcesses.delete(pid);
      }
    }
  }

  // ── Emission ──────────────────────────────────────────────────────────────

  /**
   * Emit an anomaly event with dedup protection and auto-escalation.
   *
   * Circuit breaker: When a warn-level anomaly fires 3+ times for the same
   * process (each separated by the dedup window), auto-escalate to
   * action="kill". This prevents agents from wasting hours in loops that
   * individually don't cross kill thresholds but collectively indicate a
   * stuck process.
   *
   * @param {Anomaly} anomaly
   */
  #emit(anomaly) {
    // Build dedup key: type + processId + severity (so escalations still fire)
    const dedupKey = `${anomaly.type}:${anomaly.shortId}:${anomaly.severity}`;
    const state = this.#processes.get(anomaly.processId);

    if (state) {
      const now = Date.now();
      const lastAlert = state.alertTimestamps.get(dedupKey) || 0;
      if (now - lastAlert < this.#thresholds.alertDedupWindowMs) {
        return; // Already alerted recently
      }
      state.alertTimestamps.set(dedupKey, now);

      // ── Circuit breaker escalation ─────────────────────────────────
      // Track how many times this anomaly type has been emitted for this
      // process. If a warn/info action fires 3+ times, auto-escalate
      // to kill — the process is stuck and won't recover on its own.
      const emitKey = anomaly.type;
      const emitCount = (state.alertEmitCounts.get(emitKey) || 0) + 1;
      state.alertEmitCounts.set(emitKey, emitCount);

      if (anomaly.action === "warn" || anomaly.action === "info") {
        if (emitCount >= 3) {
          console.warn(
            `[anomaly-detector] circuit breaker: ${anomaly.type} fired ${emitCount}x for ${anomaly.shortId} — escalating to KILL`,
          );
          anomaly.action = "kill";
          anomaly.severity = Severity.HIGH;
          anomaly.message = `[ESCALATED] ${anomaly.message} (${emitCount} alerts over ${Math.round((now - state.firstLineAt) / 60_000)}min)`;
        }
      }
    }

    // Increment global counter
    const prev = this.#globalCounts.get(anomaly.type) || 0;
    this.#globalCounts.set(anomaly.type, prev + 1);

    // Invoke callback
    try {
      this.#onAnomaly(anomaly);
    } catch {
      /* callback error — ignore */
    }

    // Send notification for HIGH+ severity
    if (
      anomaly.severity === Severity.CRITICAL ||
      anomaly.severity === Severity.HIGH
    ) {
      const icon = anomaly.severity === Severity.CRITICAL ? ":dot:" : ":u1f7e0:";
      const actionLabel =
        anomaly.action === "kill"
          ? ":ban: KILL"
          : anomaly.action === "restart"
            ? ":refresh: RESTART"
            : ":alert: ALERT";

      const msg = [
        `${icon} <b>Anomaly: ${escapeHtml(anomaly.type)}</b>`,
        `Process: <code>${escapeHtml(anomaly.shortId)}</code>`,
        anomaly.taskTitle ? `Task: ${escapeHtml(anomaly.taskTitle)}` : null,
        `${escapeHtml(anomaly.message)}`,
        `Action: ${actionLabel}`,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        this.#notify(msg, { parseMode: "HTML", skipDedup: false });
      } catch {
        /* notification error — ignore */
      }
    }
  }
}

// ── Factory function ────────────────────────────────────────────────────────

/**
 * Create and start an anomaly detector instance.
 *
 * @param {object} options
 * @param {(anomaly: Anomaly) => void} [options.onAnomaly] - Custom anomaly handler
 * @param {(text: string, options?: object) => void} [options.notify] - Telegram notification fn
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [options.thresholds] - Threshold overrides
 * @returns {AnomalyDetector}
 */
export function createAnomalyDetector(options = {}) {
  const detector = new AnomalyDetector(options);
  detector.start();
  return detector;
}

/**
 * @typedef {Object} Anomaly
 * @property {string} type - AnomalyType value
 * @property {string} severity - Severity value
 * @property {string} processId - Full process ID
 * @property {string} shortId - 8-char short process ID
 * @property {string|null} taskTitle - Task title if known
 * @property {string} message - Human-readable description
 * @property {object} data - Structured data for the anomaly
 * @property {string} action - Recommended action: "kill" | "restart" | "warn" | "info"
 */

export default AnomalyDetector;

// ── Workflow Engine Integration ─────────────────────────────────────────────

/**
 * Registered workflow engine reference for anomaly → workflow triggers.
 * @type {import("../workflow/workflow-engine.mjs").WorkflowEngine | null}
 */
let _workflowEngine = null;

/**
 * Register a workflow engine to receive anomaly trigger events.
 * When set, every anomaly emitted will also call engine.evaluateTriggers("anomaly", anomalyData).
 *
 * @param {import("../workflow/workflow-engine.mjs").WorkflowEngine} engine
 */
export function setWorkflowEngine(engine) {
  _workflowEngine = engine;
}

/** Get the currently registered workflow engine (or null) */
export function getWorkflowEngine() {
  return _workflowEngine;
}

/**
 * Create an onAnomaly callback that also fires workflow triggers.
 * Wraps the user's original callback and additionally invokes
 * evaluateTriggers on the registered workflow engine.
 *
 * @param {(anomaly: Anomaly) => void} [originalCallback]
 * @returns {(anomaly: Anomaly) => void}
 */
export function wrapAnomalyCallback(originalCallback) {
  return (anomaly) => {
    // Always call the original callback
    if (originalCallback) originalCallback(anomaly);

    // Fire workflow triggers if engine is registered
    if (_workflowEngine?.evaluateTriggers) {
      try {
        _workflowEngine.evaluateTriggers("anomaly", {
          anomalyType: anomaly.type,
          severity: anomaly.severity,
          agentId: anomaly.processId || anomaly.shortId,
          message: anomaly.message,
          action: anomaly.action,
          taskTitle: anomaly.taskTitle,
          data: anomaly.data,
          timestamp: Date.now(),
        });
      } catch { /* workflow trigger errors should not break anomaly detection */ }
    }
  };
}
