/**
 * retry-fetch.mjs
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║        B O S U N   R E T R Y   F E T C H                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Exponential-backoff fetch wrapper that:
 *
 *   ① Respects Retry-After / Retry-After-Ms response headers
 *      (same as Vercel AI SDK's retryWithExponentialBackoffRespectingRetryHeaders)
 *   ② Never retries abort errors (user cancel propagates instantly)
 *   ③ Only retries transient HTTP errors: 429, 500, 502, 503, 504
 *   ④ Caps retry delay at 60 seconds to avoid excessive wait
 *   ⑤ Returns the final Response on success; throws RetryExhaustedError on failure
 *
 * ─── USAGE ──────────────────────────────────────────────────────────────────
 *
 *  import { retryFetch } from "./retry-fetch.mjs";
 *
 *  const response = await retryFetch(url, fetchInit, {
 *    maxRetries: 3,
 *    initialDelayMs: 1000,
 *    backoffFactor: 2,
 *    signal: abortController.signal,
 *  });
 *
 * ─── PUBLIC API ─────────────────────────────────────────────────────────────
 *
 *  retryFetch(url, init, opts?)                 → Promise<Response>
 *  isRetryableStatus(status)                    → boolean
 *  parseRetryAfterMs(headers, fallbackMs)       → number
 *  RetryExhaustedError                          class extends Error
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** HTTP status codes worth retrying. */
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Maximum delay we will respect from Retry-After headers (60s). */
const MAX_HEADER_DELAY_MS = 60_000;

// ── RetryExhaustedError ───────────────────────────────────────────────────────

/**
 * Thrown when all retry attempts are exhausted.
 * Carries the last response (if any) and the full attempt history for
 * structured logging.
 */
export class RetryExhaustedError extends Error {
  /**
   * @param {string}   message
   * @param {Object}   details
   * @param {Response|null} details.lastResponse   The final failing HTTP response
   * @param {number}   details.attempts            Total attempts made
   * @param {number[]} details.statuses            HTTP statuses from each attempt
   */
  constructor(message, { lastResponse = null, attempts = 0, statuses = [] } = {}) {
    super(message);
    this.name = "RetryExhaustedError";
    this.lastResponse = lastResponse;
    this.attempts = attempts;
    this.statuses = statuses;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the HTTP status should trigger a retry.
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Parse the delay in milliseconds from `Retry-After-Ms` or `Retry-After` headers.
 * Returns the header delay if it is in [0, MAX_HEADER_DELAY_MS] and less than
 * the computed exponential fallback — whichever is more generous to the client.
 *
 * @param {Headers|Record<string,string>} headers
 * @param {number} fallbackMs  Exponential backoff value to use if header is absent/invalid
 * @returns {number}
 */
export function parseRetryAfterMs(headers, fallbackMs) {
  const getHeader = (name) => {
    if (headers && typeof headers.get === "function") return headers.get(name);
    if (headers && typeof headers === "object") return headers[name] ?? null;
    return null;
  };

  // retry-after-ms (precise, used by OpenAI)
  const retryAfterMs = getHeader("retry-after-ms");
  if (retryAfterMs != null) {
    const parsed = parseFloat(retryAfterMs);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_HEADER_DELAY_MS) {
      return Math.min(parsed, MAX_HEADER_DELAY_MS);
    }
  }

  // retry-after (seconds or HTTP-date)
  const retryAfter = getHeader("retry-after");
  if (retryAfter != null) {
    const asSeconds = parseFloat(retryAfter);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      const ms = asSeconds * 1000;
      if (ms <= MAX_HEADER_DELAY_MS) return ms;
    } else {
      // Try HTTP-date
      const ts = Date.parse(retryAfter);
      if (!Number.isNaN(ts)) {
        const delta = ts - Date.now();
        if (delta >= 0 && delta <= MAX_HEADER_DELAY_MS) return delta;
      }
    }
  }

  return fallbackMs;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Fetch with exponential backoff retries, Retry-After header support,
 * and abort-signal forwarding.
 *
 * The function retries on network errors AND on retryable HTTP statuses.
 * For retryable HTTP responses the response body is consumed and discarded
 * before retrying (required to release the connection).
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]          Standard fetch options
 * @param {Object}      [opts]
 * @param {number}      [opts.maxRetries=3]      Max retry attempts (not counting first try)
 * @param {number}      [opts.initialDelayMs=1000] Initial backoff delay in ms
 * @param {number}      [opts.backoffFactor=2]    Multiplier per retry
 * @param {number}      [opts.jitterMs=200]       Max random jitter added to each delay
 * @param {AbortSignal} [opts.signal]             Additional abort signal to respect
 * @returns {Promise<Response>}
 */
export async function retryFetch(url, init = {}, opts = {}) {
  const {
    maxRetries     = 3,
    initialDelayMs = 1_000,
    backoffFactor  = 2,
    jitterMs       = 200,
    signal: extraSignal,
  } = opts;

  // Merge the caller's signal with any signal already in init
  const signals = [init?.signal, extraSignal].filter(Boolean);
  const mergedSignal =
    signals.length === 0 ? undefined :
    signals.length === 1 ? signals[0] :
    AbortSignal.any(signals);

  const fetchInit = {
    ...init,
    signal: mergedSignal,
  };

  const statuses = [];
  let lastResponse = null;
  let delayMs = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // If already aborted, propagate immediately
    if (mergedSignal?.aborted) {
      const err = new DOMException(
        mergedSignal.reason ?? "The operation was aborted.",
        "AbortError",
      );
      throw err;
    }

    let response = null;
    let networkError = null;

    try {
      response = await fetch(url, fetchInit);
    } catch (err) {
      // Abort errors must not be retried — propagate immediately.
      if (err?.name === "AbortError") throw err;
      networkError = err;
    }

    if (networkError == null && response != null) {
      statuses.push(response.status);
      lastResponse = response;

      // Success path
      if (!isRetryableStatus(response.status)) {
        return response;
      }

      // Retryable HTTP status
      if (attempt < maxRetries) {
        // Must drain the body to release the connection before retrying
        try { await response.text(); } catch { /* ignore */ }
      } else {
        // Final attempt — return the bad response so caller can read body
        return response;
      }

      delayMs = parseRetryAfterMs(response.headers, delayMs);
    } else if (networkError != null && attempt >= maxRetries) {
      throw networkError;
    }

    // Wait before next attempt
    if (attempt < maxRetries) {
      const jitter = Math.floor(Math.random() * jitterMs);
      await _sleep(delayMs + jitter, mergedSignal);
      delayMs = Math.min(delayMs * backoffFactor, MAX_HEADER_DELAY_MS);
    }
  }

  // Should not be reachable, but be safe
  throw new RetryExhaustedError(
    `All ${maxRetries + 1} attempts failed for ${url}`,
    { lastResponse, attempts: maxRetries + 1, statuses },
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Promise-based sleep that aborts early if the abort signal fires.
 */
function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException(signal.reason ?? "Aborted", "AbortError"));
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException(signal.reason ?? "Aborted", "AbortError"));
    }, { once: true });
  });
}
