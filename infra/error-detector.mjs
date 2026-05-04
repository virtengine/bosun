/**
 * error-detector.mjs — Detects common agent failure patterns and provides recovery actions.
 *
 * Classifies errors into: plan_stuck, rate_limit, token_overflow, api_error,
 * session_expired, build_failure, git_conflict, unknown.
 * Returns recommended recovery actions so the orchestrator can respond automatically.
 */

import { readdirSync, readFileSync } from "node:fs";

const TAG = "[error-detector]";

// ── Detection patterns ──────────────────────────────────────────────────────

export const PLAN_STUCK_PATTERNS = [
  /ready to (start|begin|implement)/i,
  /would you like me to (proceed|start|implement|continue)/i,
  /shall i (start|begin|implement|proceed)/i,
  /here'?s the plan/i,
  /created plan at/i,
  /plan\.md$/m,
  /I'?ve (?:created|outlined|prepared) a plan/i,
  /Let me know (?:if|when|how) you'?d like/i,
  /awaiting (?:your|further) (?:input|instructions|confirmation)/i,
];

export const RATE_LIMIT_PATTERNS = [
  /429|rate.?limit|too many requests/i,
  /quota exceeded|billing.*limit/i,
  /tokens per minute|TPM.*limit/i,
  /resource exhausted|capacity/i,
  /please try again later/i,
  /Request too large|max.*tokens/i,
];

export const TOKEN_OVERFLOW_PATTERNS = [
  /context.*(too long|exceeded|overflow|maximum)/i,
  /max.*(context|token|length).*exceeded/i,
  /conversation.*too.*long/i,
  /input.*too.*large/i,
  /reduce.*(context|input|message)/i,
  /maximum.*context.*length/i,
  /413 Payload Too Large/i,                        // HTTP 413 = too much data
  /context_length_exceeded/i,                      // OpenAI error code
  /prompt.*(too long|too large)/i,                 // Anthropic / generic
  /prompt_too_long/i,                              // Anthropic error code
  /This model's maximum context length/i,          // OpenAI human-readable
  /token_budget.*exceeded|token.*budget/i,         // Codex CLI
  /turn_limit_reached|turn.*limit/i,               // Copilot / thread exhaustion
  /string_above_max_length/i,                      // OpenAI field-level
  /maximum.*number.*tokens/i,                      // Generic
];

const API_ERROR_PATTERNS = [
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /500 Internal Server Error/i,
  /502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout/i,
  /408 Request Timeout/i,
  /network.*(error|failure|unreachable)/i,
  /fetch failed|request failed/i,
  /overloaded_error|server_error|engine_overloaded/i,  // Anthropic/OpenAI overloaded
];

// ── Client request errors (NOT blindly retryable — bad payload/params) ──
export const REQUEST_ERROR_PATTERNS = [
  /400 Bad Request/i,
  /invalid_request_error/i,
  /malformed.*request|malformed.*json|invalid.*json/i,
  /422 Unprocessable Entity/i,
  /validation.*failed|invalid.*parameter|missing.*parameter/i,
  /request.*too.*large|payload.*too.*large/i,     // 413 without token context
  /404 Not Found/i,                                // wrong endpoint URL
  /invalid.*endpoint|endpoint.*not.*found/i,
  // Codex API: JSON body parse failures — oversized or control-char-corrupted payload
  /Failed to parse request body as json/i,
  /BytePositionInLine/i,
  /Expected end of string.*end of data/i,
  /is invalid after a property name.*Expected a ':'/i,
];

const SESSION_EXPIRED_PATTERNS = [
  /session.*expired|invalid.*session/i,
  /thread.*not.*found|conversation.*not.*found/i,
  /token.*expired|invalid.*token/i,
];

// ── Auth errors (NOT transient — should NOT be retried) ──
export const AUTH_ERROR_PATTERNS = [
  /invalid.?api.?key|incorrect.?api.?key/i,
  /authentication_error|permission_error/i,
  /authentication.*failed|unauthenticated/i,
  /401 Unauthorized|403 Forbidden/i,
  /invalid.*credentials|bad.*credentials/i,
  /billing_hard_limit_reached|insufficient_quota/i,
  /access.?denied|not.?authorized/i,
  /OPENAI_API_KEY.*invalid|ANTHROPIC_API_KEY.*invalid/i,
];

// ── Model-specific errors ──
export const MODEL_ERROR_PATTERNS = [
  /model.*not.*found|model.*not.*supported/i,
  /invalid.*model|model.*does.*not.*exist/i,
  /not_found_error.*model/i,
  /model.*deprecated|model.*unavailable/i,
  /engine.*not.*found|deployment.*not.*found/i,  // Azure OpenAI
];

// ── Content policy violations (NOT retryable) ──
export const CONTENT_POLICY_PATTERNS = [
  /content_policy_violation|content.?filter/i,
  /safety_system|safety.*filter/i,
  /flagged.*content|unsafe.*content/i,
  /output.*blocked|response.*blocked/i,
  /responsible.?ai|content.?management/i,
];

// ── Codex sandbox / CLI errors ──
export const CODEX_SANDBOX_PATTERNS = [
  /sandbox.*fail|sandbox.*error/i,
  /bubblewrap.*error|bwrap.*error|bwrap.*fail/i,
  /EPERM.*operation.*not.*permitted/i,
  /writable_roots/i,
  /codex.*segfault|codex.*killed|codex.*crash/i,
  /namespace.*error|unshare.*fail/i,
];

const BUILD_FAILURE_PATTERNS = [
  /go build.*failed|compilation error/i,
  /FAIL\s+\S+/m,
  /golangci-lint.*error/i,
  /pre-push hook.*failed/i,
  /npm ERR|pnpm.*error/i,
];

const GIT_CONFLICT_PATTERNS = [
  /merge conflict|CONFLICT.*Merge/i,
  /rebase.*conflict/i,
  /cannot.*merge|unable to merge/i,
  /both modified/i,
  /cannot rebase|rebase failed/i,
];

export const PUSH_FAILURE_PATTERNS = [
  /git push.*fail|rejected.*push|push.*rejected/i,
  /pre-push hook.*fail/i,
  /remote.*rejected|remote:.*error/i,
  /failed to push|push.*error/i,
  /non-fast-forward|fetch first|stale info/i,
];

export const PERMISSION_WAIT_PATTERNS = [
  /waiting for.*input|waiting for.*response/i,
  /please provide|please specify|please confirm/i,
  /do you want me to|should I/i,
  /what would you prefer/i,
  /which option|which approach/i,
  /I need your.*input|I need.*confirmation/i,
];

export const EMPTY_RESPONSE_PATTERNS = [
  /^[\s]*$/,
  /no output|empty response|blank response/i,
  /agent produced no output/i,
];

export const TEST_FAILURE_PATTERNS = [
  /FAIL\s+\S+/m,
  /test.*fail|tests? failed/i,
  /--- FAIL:/,
  /✗|✘|FAILED/,
  /AssertionError|assertion failed/i,
  /Expected.*but got|expected.*received/i,
];

export const LINT_FAILURE_PATTERNS = [
  /golangci-lint.*error/i,
  /eslint.*error|prettier.*error/i,
  /lint.*failed|linting.*error/i,
  /gofmt.*differ|goimports.*differ/i,
];

// ── OOM / SIGKILL patterns ──────────────────────────────────────────────────────

export const OOM_KILL_PATTERNS = [
  /SIGKILL/,
  /killed.*out.?of.?memory|oom.?kill/i,
  /out of memory: kill process/i,
];

export const OOM_PATTERNS = [
  /heap out of memory|javascript heap/i,
  /fatal error.*allocation failed|allocation failure/i,
  /process out of memory/i,
];

/**
 * Ordered list of pattern groups to check. Earlier entries win on ties.
 * Each entry: [patternName, regexArray, baseConfidence]
 */
const PATTERN_GROUPS = [
  ["auth_error", AUTH_ERROR_PATTERNS, 0.97],      // Auth first — never retryable
  ["content_policy", CONTENT_POLICY_PATTERNS, 0.96], // Content policy — never retryable
  ["plan_stuck", PLAN_STUCK_PATTERNS, 0.85],
  ["rate_limit", RATE_LIMIT_PATTERNS, 0.95],
  ["token_overflow", TOKEN_OVERFLOW_PATTERNS, 0.9],
  ["model_error", MODEL_ERROR_PATTERNS, 0.92],    // Model errors — not retryable
  ["request_error", REQUEST_ERROR_PATTERNS, 0.91], // Client errors (400/404/422) — needs prompt fix
  ["api_error", API_ERROR_PATTERNS, 0.9],
  ["session_expired", SESSION_EXPIRED_PATTERNS, 0.9],
  ["oom_kill", OOM_KILL_PATTERNS, 0.97],           // SIGKILL / OS-level OOM kill — critical
  ["oom", OOM_PATTERNS, 0.95],                     // JavaScript heap OOM — critical
  ["codex_sandbox", CODEX_SANDBOX_PATTERNS, 0.88], // Codex sandbox failures
  ["push_failure", PUSH_FAILURE_PATTERNS, 0.85],
  ["test_failure", TEST_FAILURE_PATTERNS, 0.83],
  ["lint_failure", LINT_FAILURE_PATTERNS, 0.82],
  ["build_failure", BUILD_FAILURE_PATTERNS, 0.8],
  ["git_conflict", GIT_CONFLICT_PATTERNS, 0.85],
];

/**
 * Severity level for each error pattern type.
 * 'low' | 'medium' | 'high' | 'critical'
 * @type {Record<string, 'low'|'medium'|'high'|'critical'>}
 */
export const PATTERN_SEVERITY = {
  auth_error: "high",
  content_policy: "high",
  plan_stuck: "low",
  rate_limit: "medium",
  token_overflow: "medium",
  model_error: "high",
  request_error: "medium",
  api_error: "medium",
  session_expired: "medium",
  oom_kill: "critical",
  oom: "critical",
  codex_sandbox: "high",
  push_failure: "medium",
  test_failure: "medium",
  lint_failure: "low",
  build_failure: "medium",
  git_conflict: "medium",
  permission_wait: "low",
  empty_response: "low",
  unknown: "low",
};

// ── Remediation hints ──────────────────────────────────────────────────────

/**
 * Human-readable remediation hints for each error type.
 * Surfaced in UI and Telegram notifications to guide users.
 */
const REMEDIATION_HINTS = {
  rate_limit: "Wait a few minutes before retrying. Consider reducing MAX_PARALLEL.",
  oom: "Reduce MAX_PARALLEL or increase available memory. Use --max-old-space-size.",
  oom_kill: "Process was killed by the OS. Reduce memory usage or increase system RAM.",
  git_conflict: "Manual conflict resolution required. Run: git mergetool",
  push_failure: "Rebase failed or push rejected. Run: git rebase --abort then try again.",
  auth_error: "Authentication failed. Check your API tokens and credentials.",
  api_error: "Network connectivity issue. Check your internet connection.",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Safely truncate a string for logging / details. */
function truncate(str, max = 200) {
  if (!str) return "";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Return the first regex match from `patterns` against `text`, or null. */
function firstMatch(text, patterns) {
  if (!text) return null;
  for (const rx of patterns) {
    const m = rx.exec(text);
    if (m) return m;
  }
  return null;
}

/** Description strings for each pattern type. */
const PATTERN_DESCRIPTIONS = {
  plan_stuck: "Agent created a plan but did not implement it",
  rate_limit: "API rate limit or quota exceeded",
  token_overflow: "Context or token limit exceeded",
  api_error: "API connection or server error",
  session_expired: "Agent session or thread expired",
  build_failure: "Build, test, or lint failure",
  test_failure: "Unit or integration test failure",
  lint_failure: "Lint or code formatting failure",
  push_failure: "Git push or pre-push hook failure",
  git_conflict: "Git merge or rebase conflict detected",
  auth_error: "API key invalid, expired, or missing — NOT retryable",
  model_error: "Model not found, deprecated, or unavailable",
  request_error: "Bad request (400/404/422) — invalid payload or endpoint",
  content_policy: "Content policy / safety filter violation — NOT retryable",
  codex_sandbox: "Codex CLI sandbox or permission error",
  oom_kill: "Process killed by OS due to out-of-memory (SIGKILL)",
  oom: "JavaScript heap out-of-memory error",
  permission_wait: "Agent waiting for human input/permission",
  empty_response: "Agent produced no meaningful output",
  unknown: "Unclassified error",
};

// ── ErrorDetector ───────────────────────────────────────────────────────────

export class ErrorDetector {
  /**
   * @param {object} [options]
   * @param {number} [options.maxConsecutiveErrors=5]
   * @param {number} [options.cooldownMs=300000]          5 min default
   * @param {number} [options.rateLimitCooldownMs=60000]  1 min default
   * @param {Function} [options.onErrorDetected]
   * @param {Function} [options.sendTelegram]
   */
  constructor(options = {}) {
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 5;
    this.cooldownMs = options.cooldownMs ?? 5 * 60 * 1000;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60 * 1000;
    this.onErrorDetected = options.onErrorDetected ?? null;
    this.sendTelegram = options.sendTelegram ?? null;

    /** @type {Map<string, { errors: Array<{pattern:string, timestamp:number, details:string}>, consecutiveErrors: number, lastErrorAt: number }>} */
    this._tasks = new Map();

    /** Global stats */
    this._global = {
      rateLimitHits: [], // timestamps
      totalErrors: 0,
      totalRecoveries: 0,
    };
  }

  // ── classify ────────────────────────────────────────────────────────────

  /**
   * Analyse agent output (and optional stderr) to classify the failure.
   *
   * @param {string} output  Agent stdout / response text
   * @param {string} [error] Agent stderr or error message
   * @returns {{ pattern: string, confidence: number, details: string, rawMatch: string|null, severity: 'low'|'medium'|'high'|'critical' }}
   */
  classify(output, error) {
    const combined = [output, error].filter(Boolean).join("\n");
    if (!combined) {
      return {
        pattern: "unknown",
        confidence: 0,
        details: "No output to analyse",
        rawMatch: null,
        severity: PATTERN_SEVERITY.unknown ?? "low",
      };
    }

    let best = null;

    for (const [pattern, regexes, baseConfidence] of PATTERN_GROUPS) {
      const m = firstMatch(combined, regexes);
      if (m) {
        // Boost confidence when multiple patterns in the same group match.
        let hits = 0;
        for (const rx of regexes) {
          if (rx.test(combined)) hits++;
        }
        const confidence = Math.min(1, baseConfidence + (hits - 1) * 0.05);

        if (!best || confidence > best.confidence) {
          best = {
            pattern,
            confidence,
            details: PATTERN_DESCRIPTIONS[pattern],
            rawMatch: truncate(m[0]),
          };
        }
      }
    }

    const result = best || {
      pattern: "unknown",
      confidence: 0.3,
      details: PATTERN_DESCRIPTIONS.unknown,
      rawMatch: null,
    };
    return {
      ...result,
      severity: PATTERN_SEVERITY[result.pattern] ?? "low",
      remediation: REMEDIATION_HINTS[result.pattern] || null,
    };
  }

  // ── recordError ─────────────────────────────────────────────────────────

  /**
   * Record an error for a task and return the recommended recovery action.
   *
   * @param {string} taskId
   * @param {{ pattern: string, confidence: number, details: string, rawMatch: string|null }} classification
   * @returns {{ action: string, prompt?: string, cooldownMs?: number, reason: string, errorCount: number }}
   */
  recordError(taskId, classification) {
    if (!taskId || !classification) {
      return {
        action: "manual",
        reason: "Missing taskId or classification",
        errorCount: 0,
      };
    }

    // Ensure task record exists.
    if (!this._tasks.has(taskId)) {
      this._tasks.set(taskId, {
        errors: [],
        consecutiveErrors: 0,
        lastErrorAt: 0,
      });
    }
    const rec = this._tasks.get(taskId);
    const now = Date.now();

    rec.errors.push({
      pattern: classification.pattern,
      timestamp: now,
      details: classification.details,
    });
    rec.consecutiveErrors += 1;
    rec.lastErrorAt = now;
    this._global.totalErrors += 1;

    // Track global rate-limit hits.
    if (classification.pattern === "rate_limit") {
      this._global.rateLimitHits.push(now);
      // Prune old entries (> 5 minutes).
      const cutoff = now - this.cooldownMs;
      this._global.rateLimitHits = this._global.rateLimitHits.filter(
        (t) => t > cutoff,
      );
    }

    // Fire callback.
    if (typeof this.onErrorDetected === "function") {
      try {
        this.onErrorDetected({
          taskId,
          classification,
          errorCount: rec.consecutiveErrors,
        });
      } catch {
        /* swallow */
      }
    }

    // Determine recovery action.
    const errorCount = rec.consecutiveErrors;

    // Block after too many consecutive errors.
    if (errorCount >= this.maxConsecutiveErrors) {
      const reason = `Task has ${errorCount} consecutive errors (max ${this.maxConsecutiveErrors}) — blocking`;
      this._notifyTelegram(`:close: Task ${taskId} blocked: ${reason}`);
      return { action: "block", reason, errorCount };
    }

    switch (classification.pattern) {
      case "plan_stuck":
        return {
          action: "retry_with_prompt",
          prompt: this.getPlanStuckRecoveryPrompt("(unknown)", ""),
          reason:
            "Agent stuck in planning mode — sending implementation prompt",
          errorCount,
        };

      case "rate_limit":
        if (this.shouldPauseExecutor()) {
          return {
            action: "pause_executor",
            cooldownMs: this.cooldownMs,
            reason: `>${this._rateLimitThreshold()} rate limits in 5 min window — pausing executor`,
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: "Rate limited — cooling down before retry",
          errorCount,
        };

      case "token_overflow":
        return {
          action: "new_session",
          prompt: this.getTokenOverflowRecoveryPrompt("(unknown)"),
          reason:
            "Token/context overflow — starting fresh session on same worktree",
          errorCount,
        };

      case "api_error":
        if (errorCount >= 3) {
          return {
            action: "block",
            reason: "API errors persist after 3 retries — blocking",
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: `API error (attempt ${errorCount}/3) — retry after cooldown`,
          errorCount,
        };

      case "session_expired":
        return {
          action: "new_session",
          reason: "Session/thread expired — creating new session",
          errorCount,
        };

      case "build_failure":
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason:
              "Build failures persist after 3 retries — needs manual review",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "The previous build/test/lint step failed. Carefully read the error output, fix the root cause, and try again. Do NOT skip tests.",
          reason: `Build failure (attempt ${errorCount}/3) — retry with fix prompt`,
          errorCount,
        };

      case "git_conflict":
        if (errorCount >= 2) {
          return {
            action: "manual",
            reason:
              "Git conflicts persist after 2 retries — needs manual resolution",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "There are git merge conflicts. Run `git status` to find conflicting files, resolve each conflict by choosing the correct code, then `git add` and `git commit`. Do NOT leave conflict markers in the code.",
          reason: "Git conflict detected — retry with resolution prompt",
          errorCount,
        };

      case "push_failure":
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason:
              "Push failures persist after 3 retries — needs manual review",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "git push failed. Check the error output:\n" +
            "1. If pre-push hooks failed → fix lint/test/build errors, then push again\n" +
            "2. If remote rejected → git pull --no-rebase origin main && resolve conflicts && push\n" +
            "Do NOT use --no-verify.",
          reason: `Push failure (attempt ${errorCount}/3) — retry with fix prompt`,
          errorCount,
        };

      case "test_failure":
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason:
              "Test failures persist after 3 retries — needs manual review",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "Tests are failing. Read the EXACT failure output. " +
            "Fix the IMPLEMENTATION, not the tests (unless tests have an obvious bug). " +
            "Run the specific failing test to verify your fix before pushing.",
          reason: `Test failure (attempt ${errorCount}/3) — retry with fix prompt`,
          errorCount,
        };

      case "lint_failure":
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason:
              "Lint failures persist after 3 retries — needs manual review",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "Linting/formatting failed. Fix the specific lint errors reported. " +
            "Common issues: unused variables, unchecked error returns, formatting. " +
            "Apply minimal targeted fixes, then re-run the linter to verify.",
          reason: `Lint failure (attempt ${errorCount}/3) — retry with fix prompt`,
          errorCount,
        };

      case "auth_error":
        // Auth errors are NEVER retryable — block immediately
        return {
          action: "block",
          reason:
            "API authentication failed (invalid/expired/missing key). " +
            "Fix the API key configuration before retrying.",
          errorCount,
        };

      case "model_error":
        // Model errors are NEVER retryable — wrong model name or deprecated
        return {
          action: "block",
          reason:
            "Model not found or unavailable. Check the model name in your " +
            "configuration (COPILOT_MODEL, CLAUDE_MODEL, OPENAI_MODEL).",
          errorCount,
        };

      case "content_policy":
        // Content policy violations are NEVER retryable
        return {
          action: "block",
          reason:
            "Content policy or safety filter violation. The request " +
            "was rejected and will not succeed on retry.",
          errorCount,
        };

      case "request_error":
        // Client errors (400/404/422) — retry with guidance but block after 2
        if (errorCount >= 2) {
          return {
            action: "block",
            reason:
              "Client request errors persist (400/404/422) — the request payload " +
              "or endpoint is invalid and needs manual investigation.",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "The API returned a client error (400 Bad Request, 404, or 422). " +
            "This means the request itself is malformed — NOT a server issue. " +
            "Check: 1) API endpoint URL is correct, 2) request body is valid JSON, " +
            "3) all required parameters are present, 4) parameter values are valid. " +
            "Do NOT simply retry — fix the request first.",
          reason: `Client request error (attempt ${errorCount}/2) — fix request payload`,
          errorCount,
        };

      case "codex_sandbox":
        if (errorCount >= 2) {
          return {
            action: "block",
            reason:
              "Codex sandbox/permission errors persist — check sandbox config in ~/.codex/config.toml",
            errorCount,
          };
        }
        return {
          action: "retry_with_prompt",
          prompt:
            "Codex sandbox error detected. Check:\n" +
            "1. writable_roots includes your workspace in ~/.codex/config.toml\n" +
            "2. Bubblewrap (bwrap) is installed if use_linux_sandbox_bwrap=true\n" +
            "3. File permissions allow the operation\n" +
            "If using Docker, ensure the container has the right mounts.",
          reason: `Codex sandbox failure (attempt ${errorCount}/2) — check config`,
          errorCount,
        };

      default:
        if (errorCount >= 3) {
          return {
            action: "manual",
            reason: `Unknown error repeated ${errorCount} times — needs manual review`,
            errorCount,
          };
        }
        return {
          action: "cooldown",
          cooldownMs: this.rateLimitCooldownMs,
          reason: "Unknown error — retry after cooldown",
          errorCount,
        };
    }
  }

  // ── Recovery prompts ────────────────────────────────────────────────────

  /**
   * Get recovery prompt for plan-stuck errors.
   *
   * @param {string} taskTitle
   * @param {string} lastOutput
   * @returns {string}
   */
  getPlanStuckRecoveryPrompt(taskTitle, lastOutput) {
    const outputSummary = (lastOutput || "").slice(-1500);
    return `You previously created a plan for task "${taskTitle}" but did not implement it.

CRITICAL: Do NOT create another plan. Do NOT ask for permission. Implement the changes NOW.

Your previous output ended with planning but no code changes were made. This is an autonomous task — you must implement, test, commit, and push without any human interaction.

Previous output summary:
${outputSummary}

IMPLEMENT NOW. Start by making the actual code changes, then test, commit, and push.`;
  }

  /**
   * Get recovery prompt for token overflow.
   *
   * @param {string} taskTitle
   * @returns {string}
   */
  getTokenOverflowRecoveryPrompt(taskTitle) {
    return `Continue working on task "${taskTitle}". Your previous session exceeded context limits.

This is a fresh session on the same worktree. Check what was already done:
1. Run \`git log --oneline -10\` to see recent commits
2. Run \`git diff --stat\` to see uncommitted changes
3. Review the task requirements and continue from where the previous session left off

Do NOT restart from scratch — build on existing progress.`;
  }

  // ── Executor kill-switch ────────────────────────────────────────────────

  /**
   * Returns true if the executor should pause due to excessive rate limiting.
   * Triggers when >3 rate-limit errors hit within the cooldown window (5 min).
   *
   * @returns {boolean}
   */
  shouldPauseExecutor() {
    const now = Date.now();
    const cutoff = now - this.cooldownMs;
    this._global.rateLimitHits = this._global.rateLimitHits.filter(
      (t) => t > cutoff,
    );
    return this._global.rateLimitHits.length > this._rateLimitThreshold();
  }

  /** @private */
  _rateLimitThreshold() {
    return 3;
  }

  // ── Task lifecycle ──────────────────────────────────────────────────────

  /**
   * Reset error tracking for a task (call on success).
   *
   * @param {string} taskId
   */
  resetTask(taskId) {
    if (this._tasks.has(taskId)) {
      this._global.totalRecoveries += this._tasks.get(taskId).consecutiveErrors;
      this._tasks.delete(taskId);
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  /**
   * Get error statistics.
   *
   * @returns {{ totalErrors: number, totalRecoveries: number, activeTaskErrors: number, rateLimitHitsLast5m: number, taskBreakdown: Record<string, number> }}
   */
  getStats() {
    const now = Date.now();
    const cutoff = now - this.cooldownMs;
    const rateLimitHitsLast5m = this._global.rateLimitHits.filter(
      (t) => t > cutoff,
    ).length;

    const taskBreakdown = {};
    for (const [taskId, rec] of this._tasks) {
      taskBreakdown[taskId] = rec.consecutiveErrors;
    }

    return {
      totalErrors: this._global.totalErrors,
      totalRecoveries: this._global.totalRecoveries,
      activeTaskErrors: this._tasks.size,
      rateLimitHitsLast5m,
      taskBreakdown,
    };
  }

  // ── Session-Aware Analysis ────────────────────────────────────────────────

  /**
   * Analyze a sequence of session messages (from SessionTracker) to detect
   * behavioral patterns that single-event classification would miss.
   *
   * Detects:
   * - tool_loop:           Same tools repeated 5+ times without progress
   * - analysis_paralysis:  Only reading files, never editing (after 10+ tool calls)
   * - plan_stuck:          Agent wrote a plan but stopped (plan keywords + no edits)
   * - needs_clarification: Agent explicitly says it needs input/clarification
   * - false_completion:    Agent claims done but there are no commits
   * - rate_limited:        Multiple rate limit errors in sequence
   *
   * @param {Array<{type: string, content: string, meta?: {toolName?: string}}>} messages
   * @returns {{ patterns: string[], primary: string|null, details: Record<string, string> }}
   */
  analyzeMessageSequence(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { patterns: [], primary: null, details: {} };
    }

    const patterns = [];
    const details = {};
    const normalizeBehaviorText = (text, { loose = false } = {}) => {
      let normalized = String(text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
      if (loose) {
        normalized = normalized
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>")
          .replace(/\b(?:0x)?[0-9a-f]{10,}\b/gi, "<hex>")
          .replace(/\b\d{2,}\b/g, "<n>");
      }
      return normalized;
    };
    const isReadTool = (message) => {
      const name = (message?.meta?.toolName || message?.content || "").toLowerCase();
      return (
        name.includes("read") ||
        name.includes("search") ||
        name.includes("grep") ||
        name.includes("list") ||
        name.includes("find") ||
        name.includes("cat")
      );
    };
    const isEditTool = (message) => {
      const name = (message?.meta?.toolName || message?.content || "").toLowerCase();
      return (
        name.includes("write") ||
        name.includes("edit") ||
        name.includes("create") ||
        name.includes("replace") ||
        name.includes("patch") ||
        name.includes("append")
      );
    };
    const buildToolFingerprint = (message, { loose = false } = {}) => {
      const toolName = normalizeBehaviorText(message?.meta?.toolName || "unknown");
      const content = normalizeBehaviorText(message?.content || "", { loose });
      return `${toolName}::${content}`;
    };

    // ── Tool loop detection ──
    const toolCalls = messages.filter((m) => m.type === "tool_call");
    if (toolCalls.length >= 5) {
      const toolNames = toolCalls.map((m) => m.meta?.toolName || "unknown");
      const lastFive = toolNames.slice(-5);
      const uniqueInLastFive = new Set(lastFive).size;
      const lastFiveCalls = toolCalls.slice(-5);
      const exactFingerprints = lastFiveCalls.map((m) => buildToolFingerprint(m));
      const looseFingerprints = lastFiveCalls.map((m) => buildToolFingerprint(m, { loose: true }));
      const dominantLooseFingerprint = looseFingerprints
        .map((fingerprint) => ({
          fingerprint,
          count: looseFingerprints.filter((entry) => entry === fingerprint).length,
        }))
        .sort((a, b) => b.count - a.count)[0];
      if (uniqueInLastFive <= 2 || dominantLooseFingerprint?.count >= 4) {
        patterns.push("tool_loop");
        const loopMode = dominantLooseFingerprint?.count >= 4 &&
            new Set(exactFingerprints).size > 1
          ? "near-identical"
          : "repeated";
        details.tool_loop = loopMode === "near-identical"
          ? `Near-identical tool retries: ${[...new Set(lastFive)].join(", ")} (${dominantLooseFingerprint.count}x in last 5)`
          : `Repeated tools: ${[...new Set(lastFive)].join(", ")} (${lastFive.length}x in last 5)`;
      }
    }

    // ── Analysis paralysis ──
    if (toolCalls.length >= 10) {
      const readTools = toolCalls.filter((m) => isReadTool(m));
      const editTools = toolCalls.filter((m) => isEditTool(m));

      if (readTools.length >= 8 && editTools.length === 0) {
        patterns.push("analysis_paralysis");
        details.analysis_paralysis = `${readTools.length} read ops, 0 write ops in ${toolCalls.length} tool calls`;
      }
    }

    // ── Plan stuck ──
    const agentMessages = messages.filter((m) => m.type === "agent_message");
    const lastAgentMessages = agentMessages.slice(-3);
    const allAgentText = agentMessages
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();
    const planPhrases = [
      "here's the plan",
      "here is my plan",
      "i'll create a plan",
      "plan.md",
      "ready to start implementing",
      "ready to begin",
      "would you like me to proceed",
      "shall i start",
      "would you like me to implement",
    ];
    const hasPlanPhrase = planPhrases.some((p) => allAgentText.includes(p));
    const editToolCalls = toolCalls.filter((m) => isEditTool(m));
    if (hasPlanPhrase && editToolCalls.length <= 1) {
      patterns.push("plan_stuck");
      details.plan_stuck = "Agent created a plan but did not implement it";
    }

    // ── Doom loop: repeated near-identical assistant outputs with no concrete progress ──
    if (lastAgentMessages.length >= 3) {
      const exactOutputs = lastAgentMessages.map((m) => normalizeBehaviorText(m.content));
      const looseOutputs = lastAgentMessages.map((m) =>
        normalizeBehaviorText(m.content, { loose: true }));
      const sameLooseResponse = looseOutputs.every((text) => text && text === looseOutputs[0]);
      const sameExactResponse = exactOutputs.every((text) => text && text === exactOutputs[0]);
      const recentEditCalls = toolCalls
        .filter((m) => messages.slice(-8).includes(m))
        .filter((m) => isEditTool(m));
      if ((sameLooseResponse || sameExactResponse) && recentEditCalls.length === 0) {
        patterns.push("doom_loop");
        details.doom_loop = `Near-identical assistant outputs repeated ${lastAgentMessages.length}x without edits`;
      }
    }

    // ── Needs clarification ──
    const clarificationPhrases = [
      "need clarification",
      "need more information",
      "could you clarify",
      "unclear",
      "ambiguous",
      "which approach",
      "please specify",
      "i need to know",
      "can you provide",
      "what should i",
    ];
    if (clarificationPhrases.some((p) => allAgentText.includes(p))) {
      patterns.push("needs_clarification");
      details.needs_clarification =
        "Agent expressed uncertainty or asked for input";
    }

    // ── False completion ──
    const completionPhrases = [
      "task complete",
      "task is complete",
      "i've completed",
      "all done",
      "successfully completed",
      "changes have been committed",
      "pushed to",
      "pr created",
      "pull request created",
    ];
    const claimsDone = completionPhrases.some((p) => allAgentText.includes(p));
    const hasGitCommit = toolCalls.some((m) => {
      const content = (m.content || "").toLowerCase();
      return content.includes("git commit") || content.includes("git push");
    });
    if (claimsDone && !hasGitCommit) {
      patterns.push("false_completion");
      details.false_completion =
        "Agent claims completion but no git commit/push detected in tool calls";
    }

    // ── Rate limited ──
    const errors = messages.filter((m) => m.type === "error");
    const rateLimitErrors = errors.filter((m) =>
      /rate.?limit|429|too many requests|quota/i.test(m.content || ""),
    );
    if (rateLimitErrors.length >= 2) {
      patterns.push("rate_limited");
      details.rate_limited = `${rateLimitErrors.length} rate limit errors detected`;
    }

    // ── Commits without push ──
    const hasGitCommitCall = toolCalls.some((m) => {
      const content = (m.content || "").toLowerCase();
      return content.includes("git commit");
    });
    const hasGitPushCall = toolCalls.some((m) => {
      const content = (m.content || "").toLowerCase();
      return content.includes("git push");
    });
    if (hasGitCommitCall && !hasGitPushCall && claimsDone) {
      patterns.push("commits_no_push");
      details.commits_no_push =
        "Agent committed changes but never pushed them";
    }

    // ── Permission waiting ──
    const permissionPhrases = [
      "do you want me to",
      "should i proceed",
      "should i continue",
      "waiting for your",
      "let me know if",
      "please confirm",
      "would you like",
      "whenever you're ready",
    ];
    const lastAgentMsg = agentMessages.length > 0
      ? (agentMessages[agentMessages.length - 1].content || "").toLowerCase()
      : "";
    if (permissionPhrases.some((p) => lastAgentMsg.includes(p))) {
      patterns.push("permission_wait");
      details.permission_wait =
        "Agent's last message asks for permission/input — will never receive a response";
    }

    // ── Empty/no-progress ──
    if (
      messages.length >= 5 &&
      toolCalls.length === 0 &&
      agentMessages.length <= 1
    ) {
      patterns.push("no_progress");
      details.no_progress =
        `${messages.length} messages but no tool calls and ≤1 agent message — agent may be stuck`;
    } else if (
      messages.length >= 6 &&
      toolCalls.slice(-6).length <= 1 &&
      lastAgentMessages.length >= 2
    ) {
      const looseOutputs = lastAgentMessages.map((m) =>
        normalizeBehaviorText(m.content, { loose: true }));
      if (looseOutputs.every((text) => text && text === looseOutputs[0])) {
        patterns.push("no_progress");
        details.no_progress =
          `Recent session activity is stalled: ${lastAgentMessages.length} near-identical assistant messages with no meaningful tool progress`;
      }
    }

    // ── Error loop (same error repeating) ──
    if (errors.length >= 3) {
      const lastThree = errors.slice(-3).map((m) => (m.content || "").slice(0, 100));
      if (lastThree.every((e) => e === lastThree[0])) {
        patterns.push("error_loop");
        details.error_loop =
          `Same error repeated ${errors.length}x: "${lastThree[0].slice(0, 80)}"`;
      }
    }

    // Determine primary pattern (most actionable)
    const priority = [
      "rate_limited",
      "doom_loop",
      "plan_stuck",
      "false_completion",
      "commits_no_push",
      "permission_wait",
      "error_loop",
      "needs_clarification",
      "tool_loop",
      "analysis_paralysis",
      "no_progress",
    ];
    const primary = priority.find((p) => patterns.includes(p)) || null;

    return { patterns, primary, details };
  }

  /**
   * Analyze agent log files for historical error patterns.
   * Reads log files from the agent logs directory and returns frequency data.
   *
   * @param {string} logsDir - Path to the agent logs directory
   * @returns {{ patterns: Record<string, number>, recommendations: string[] }}
   */
  analyzeHistoricalErrors(logsDir) {
    const patterns = {};
    const recommendations = [];

    try {
      const files = readdirSync(logsDir).filter((f) => f.endsWith(".log"));

      for (const file of files.slice(-20)) {
        // Only last 20 logs
        try {
          const content = readFileSync(`${logsDir}/${file}`, "utf8");
          const classification = this.classify(content);
          const pattern = classification.pattern;
          patterns[pattern] = (patterns[pattern] || 0) + 1;
        } catch {
          /* skip unreadable files */
        }
      }

      // Generate recommendations
      if ((patterns.rate_limit || 0) > 3) {
        recommendations.push(
          "Frequent rate limiting — consider reducing parallelism or adding delays",
        );
      }
      if ((patterns.plan_stuck || 0) > 3) {
        recommendations.push(
          "Agents frequently get stuck in planning mode — ensure instructions explicitly say 'implement immediately'",
        );
      }
      if ((patterns.token_overflow || 0) > 2) {
        recommendations.push(
          "Token overflow occurring — consider splitting large tasks or using summarization",
        );
      }
    } catch {
      /* logsDir might not exist */
    }

    return { patterns, recommendations };
  }

  /**
   * Generate a recovery prompt based on session analysis results.
   * Used by task-executor when a behavioral pattern is detected mid-session.
   *
   * @param {string} taskTitle
   * @param {{ primary: string|null, details: Record<string, string> }} analysis
   * @param {string} [lastOutput] - Last agent output for additional context
   * @returns {string}
   */
  getRecoveryPromptForAnalysis(taskTitle, analysis, lastOutput = "") {
    if (!analysis?.primary) {
      return `Continue working on task "${taskTitle}". Focus on implementation.`;
    }

    switch (analysis.primary) {
      case "plan_stuck":
        return [
          `# CONTINUE IMPLEMENTATION — Do Not Plan`,
          ``,
          `You wrote a plan for "${taskTitle}" but stopped before implementing it.`,
          ``,
          `DO NOT create another plan. DO NOT ask for permission.`,
          `Implement the changes NOW:`,
          `1. Edit the necessary files`,
          `2. Run tests to verify`,
          `3. Commit with conventional commit message`,
          `4. Push to the branch`,
          ``,
          `This is autonomous execution — implement immediately.`,
        ].join("\n");

      case "doom_loop":
        return [
          `# BREAK THE DOOM LOOP — Change State, Then Act`,
          ``,
          `You're replaying near-identical responses on "${taskTitle}" without moving the work forward.`,
          analysis.details?.doom_loop
            ? `Detail: ${analysis.details.doom_loop}`
            : "",
          ``,
          `Break the cycle immediately:`,
          `1. Stop restating the same status`,
          `2. Pick one concrete file or command that changes state`,
          `3. Execute it now`,
          `4. Verify whether the state actually changed before continuing`,
        ]
          .filter(Boolean)
          .join("\n");

      case "tool_loop":
        return [
          `# BREAK THE LOOP — Change Approach`,
          ``,
          `You've been repeating the same tools without making progress on "${taskTitle}".`,
          analysis.details?.tool_loop
            ? `Detail: ${analysis.details.tool_loop}`
            : "",
          ``,
          `STOP and take a different approach:`,
          `1. Summarize what you've learned so far`,
          `2. Identify what's blocking you`,
          `3. Try a completely different strategy`,
          `4. Make incremental progress — edit files, commit, push`,
        ]
          .filter(Boolean)
          .join("\n");

      case "analysis_paralysis":
        return [
          `# START EDITING — Stop Just Reading`,
          ``,
          `You've been reading files but not making any changes for "${taskTitle}".`,
          analysis.details?.analysis_paralysis
            ? `Detail: ${analysis.details.analysis_paralysis}`
            : "",
          ``,
          `You have enough context. Start implementing:`,
          `1. Create or edit the files needed`,
          `2. Don't try to understand everything first — work incrementally`,
          `3. Commit and push after each meaningful change`,
        ]
          .filter(Boolean)
          .join("\n");

      case "needs_clarification":
        return [
          `# MAKE A DECISION — Do Not Wait for Input`,
          ``,
          `You expressed uncertainty about "${taskTitle}" but this is autonomous execution.`,
          `No one will respond to your questions.`,
          ``,
          `Choose the most reasonable approach and proceed:`,
          `1. Pick the simplest correct implementation`,
          `2. Document any assumptions in code comments`,
          `3. Implement, test, commit, and push`,
        ].join("\n");

      case "false_completion":
        return [
          `# ACTUALLY COMPLETE THE TASK`,
          ``,
          `You claimed "${taskTitle}" was complete, but no git commit or push was detected.`,
          ``,
          `The task is NOT complete until changes are committed and pushed:`,
          `1. Stage your changes: git add -A`,
          `2. Commit: git commit -m "feat(scope): description"`,
          `3. Push: git push origin <branch>`,
          `4. Verify the push succeeded`,
        ].join("\n");

      case "rate_limited":
        return [
          `# RATE LIMITED — Wait and Retry`,
          ``,
          `You hit rate limits while working on "${taskTitle}".`,
          `Wait 30 seconds, then continue with smaller, focused operations.`,
          `Avoid large file reads or many parallel tool calls.`,
        ].join("\n");

      case "commits_no_push":
        return [
          `# PUSH YOUR COMMITS`,
          ``,
          `You committed changes for "${taskTitle}" but never pushed them.`,
          ``,
          `Run now:`,
          `  git push --set-upstream origin $(git branch --show-current)`,
          ``,
          `If the push fails due to pre-push hooks, fix the reported issues and push again.`,
          `Do NOT use --no-verify.`,
        ].join("\n");

      case "permission_wait":
        return [
          `# DO NOT WAIT FOR INPUT`,
          ``,
          `You appear to be waiting for human input on "${taskTitle}".`,
          `This is FULLY AUTONOMOUS execution — no human will respond.`,
          ``,
          `Make the best engineering decision and continue:`,
          `1. Choose the simplest correct approach`,
          `2. Implement it now`,
          `3. Test, commit, and push`,
        ].join("\n");

      case "error_loop":
        return [
          `# BREAK THE ERROR LOOP`,
          ``,
          `You've hit the same error multiple times on "${taskTitle}".`,
          analysis.details?.error_loop
            ? `Detail: ${analysis.details.error_loop}`
            : "",
          ``,
          `The current approach is NOT working. Try something different:`,
          `1. Read the error message carefully — what is the ROOT CAUSE?`,
          `2. Fix the underlying issue, not just the symptom`,
          `3. If a tool keeps failing, use a different tool or approach`,
          `4. Make a small change, verify it works, commit it`,
        ]
          .filter(Boolean)
          .join("\n");

      case "no_progress":
        return [
          `# START WORKING`,
          ``,
          `No meaningful progress detected on "${taskTitle}".`,
          `You have sent messages but made no tool calls and no code changes.`,
          ``,
          `Start now:`,
          `1. Identify the first file to modify`,
          `2. Edit it`,
          `3. Test the change`,
          `4. Commit and push`,
        ].join("\n");

      default:
        return `Continue working on task "${taskTitle}". Focus on making concrete progress.`;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** @private */
  _notifyTelegram(message) {
    if (typeof this.sendTelegram === "function") {
      try {
        this.sendTelegram(message);
      } catch {
        /* swallow */
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Convenience factory for creating an ErrorDetector.
 *
 * @param {object} [options] Same options as ErrorDetector constructor.
 * @returns {ErrorDetector}
 */
export function createErrorDetector(options) {
  return new ErrorDetector(options);
}
