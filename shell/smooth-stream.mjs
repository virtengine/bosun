/**
 * smooth-stream.mjs
 *
 * Configurable token/word/line-chunked stream smoother inspired by
 * Vercel AI SDK `smooth-stream.ts`.
 *
 * The native adapter emits `session.stream.delta` events for each SSE chunk
 * it receives — these arrive in variable-size bursts that produce a jarring
 * "pause-then-flood" effect in any UI consuming the event stream.
 *
 * This module:
 *   1. Buffers incoming deltas in a per-session queue
 *   2. Chunks by word, line, or a custom RegExp / Intl.Segmenter strategy
 *   3. Re-emits `onChunk` callbacks at a configurable rate so the UI sees
 *      smooth, evenly-paced output
 *   4. Flushes any remaining buffer when the turn ends
 *
 * Usage:
 *   const smoother = createStreamSmoother({ chunking: 'word', delayMs: 10 });
 *   // During SSE delta events:
 *   smoother.feed(delta, (chunk) => onEvent({ type:'session.stream.delta', delta: chunk }));
 *   // After turn completes:
 *   await smoother.flush((chunk) => onEvent({ type:'session.stream.delta', delta: chunk }));
 *
 * For per-session isolation, use createStreamSmootherFactory() which returns
 * a map of independent smoothers keyed by session ID.
 */

// ── Chunking strategies ───────────────────────────────────────────────────────

/**
 * A "detect-chunk" function takes a buffer string and returns the next
 * chunk to emit (or null if there is not yet enough content to emit).
 *
 * @callback DetectChunkFn
 * @param {string} buffer
 * @returns {{ chunk: string, remainder: string }|null}
 */

/** Split at the next whitespace boundary (word-boundary chunking). */
function detectWordChunk(buffer) {
  const match = buffer.match(/^(.*?\S)\s/s);
  if (!match) return null;
  const chunk = match[1];  // everything up to (not including) the last space
  const remainder = buffer.slice(chunk.length);
  return { chunk, remainder };
}

/** Split at the next newline boundary (line chunking). */
function detectLineChunk(buffer) {
  const nl = buffer.indexOf("\n");
  if (nl === -1) return null;
  return { chunk: buffer.slice(0, nl + 1), remainder: buffer.slice(nl + 1) };
}

/** Split using a custom RegExp whose first capture group is the chunk. */
function makeRegexDetect(pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, "s");
  return (buffer) => {
    const match = buffer.match(re);
    if (!match) return null;
    const chunk = match[1] ?? match[0];
    const remainder = buffer.slice(match.index + match[0].length);
    return { chunk, remainder };
  };
}

/** Passthrough: emit each delta as-is without buffering. */
function detectPassthrough(buffer) {
  if (!buffer) return null;
  return { chunk: buffer, remainder: "" };
}

/**
 * Resolve a chunking descriptor to a DetectChunkFn.
 *
 * @param {string|RegExp|DetectChunkFn} chunking
 * @returns {DetectChunkFn}
 */
function resolveChunkDetector(chunking) {
  if (typeof chunking === "function") return chunking;
  if (chunking instanceof RegExp) return makeRegexDetect(chunking);
  switch (String(chunking || "word").toLowerCase()) {
    case "word":
    case "words":      return detectWordChunk;
    case "line":
    case "lines":      return detectLineChunk;
    case "none":
    case "passthrough":
    case "raw":        return detectPassthrough;
    default:
      if (typeof chunking === "string") {
        // treat as regex pattern string
        try { return makeRegexDetect(new RegExp(chunking, "s")); } catch { /* fall through */ }
      }
      return detectWordChunk;
  }
}

// ── Async delay ───────────────────────────────────────────────────────────────

function delay(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── StreamSmoother ────────────────────────────────────────────────────────────

/**
 * A single-session stream smoother.
 *
 * @typedef {{ chunk: string, done: boolean }} SmootherChunk
 */

export class StreamSmoother {
  #buffer = "";
  #detect;
  #delayMs;

  /**
   * @param {object} [opts]
   * @param {string|RegExp|DetectChunkFn} [opts.chunking='word']
   * @param {number} [opts.delayMs=12]      Milliseconds to wait between emitted chunks
   */
  constructor(opts = {}) {
    this.#detect  = resolveChunkDetector(opts.chunking ?? "word");
    this.#delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 12;
  }

  /**
   * Feed a new delta string into the buffer and immediately emit any
   * complete chunks to `onChunk`.  Can be called synchronously — emitting
   * is sync when delayMs === 0.
   *
   * If delayMs > 0 the returned Promise should be awaited to preserve ordering,
   * but callers that prefer fire-and-forget can ignore it.
   *
   * @param {string}              delta
   * @param {(chunk: string) => void} onChunk
   * @returns {Promise<void>}
   */
  async feed(delta, onChunk) {
    this.#buffer += delta;
    await this.#drain(onChunk, false);
  }

  /**
   * Flush remaining buffer content (once the turn is complete).
   *
   * @param {(chunk: string) => void} onChunk
   * @returns {Promise<void>}
   */
  async flush(onChunk) {
    await this.#drain(onChunk, true);
  }

  /** Reset internal buffer (e.g. between turns). */
  reset() {
    this.#buffer = "";
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  async #drain(onChunk, flushAll) {
    const emit = typeof onChunk === "function" ? onChunk : () => {};

    // Drain all complete chunks
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = this.#detect(this.#buffer);
      if (!result) break;
      this.#buffer = result.remainder;
      emit(result.chunk);
      if (this.#delayMs > 0) await delay(this.#delayMs);
    }

    // On flush: emit whatever remains
    if (flushAll && this.#buffer) {
      emit(this.#buffer);
      if (this.#delayMs > 0) await delay(this.#delayMs);
      this.#buffer = "";
    }
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────

/**
 * Create a single StreamSmoother instance with the given options.
 *
 * @param {object} [opts]
 * @param {string|RegExp} [opts.chunking='word']
 * @param {number}        [opts.delayMs=12]
 * @returns {StreamSmoother}
 */
export function createStreamSmoother(opts = {}) {
  return new StreamSmoother(opts);
}

/**
 * Create a factory that returns a per-session StreamSmoother, creating a new
 * one on first access and reusing it thereafter.
 *
 * @param {object} [defaultOpts]  Options forwarded to StreamSmoother constructor
 * @returns {{ get(sessionId: string): StreamSmoother, reset(sessionId: string): void, resetAll(): void }}
 */
export function createStreamSmootherFactory(defaultOpts = {}) {
  const _map = new Map();

  function get(sessionId) {
    const key = String(sessionId || "_default");
    if (!_map.has(key)) _map.set(key, new StreamSmoother(defaultOpts));
    return _map.get(key);
  }

  function reset(sessionId) {
    const key = String(sessionId || "_default");
    const s = _map.get(key);
    if (s) s.reset();
  }

  function resetAll() {
    _map.forEach((s) => s.reset());
  }

  function remove(sessionId) {
    _map.delete(String(sessionId || "_default"));
  }

  return { get, reset, resetAll, remove };
}

export default { StreamSmoother, createStreamSmoother, createStreamSmootherFactory };
