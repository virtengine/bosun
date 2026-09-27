/*
 * Session insights — main-thread facade.
 *
 * - `buildSessionInsights(session)` is the synchronous core (re-exported).
 * - `computeSessionInsights(session, opts?)` runs the same computation off the
 *   main thread when possible:
 *     1. Web Worker (preferred) — singleton, lazily created.
 *     2. requestIdleCallback fallback (or microtask) when Worker unavailable
 *        or fails. This still keeps the work out of the synchronous keystroke
 *        path, so chat input stays responsive even on huge sessions.
 *
 * The wrapper deliberately swallows worker errors and degrades to the
 * synchronous path so a worker failure can never blank the inspector rail.
 */

import { buildSessionInsights, formatCompactCount } from "../../../lib/session-insights.mjs";

export { buildSessionInsights, formatCompactCount };

const WORKER_URL = new URL("./session-insights-worker.js", import.meta.url);

let _worker = null;
let _workerDisabled = false;
let _nextRequestId = 1;
const _pending = new Map(); // id → { resolve, reject, signal, onAbort }

function _scheduleIdle(fn) {
  const ric = (typeof globalThis !== "undefined" && globalThis.requestIdleCallback) || null;
  if (ric) {
    const handle = ric(() => fn(), { timeout: 80 });
    return () => {
      const cic = globalThis.cancelIdleCallback;
      if (cic) cic(handle);
    };
  }
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
}

function _disposeWorker() {
  if (_worker) {
    try { _worker.terminate(); } catch { /* noop */ }
    _worker = null;
  }
  for (const [, entry] of _pending) {
    try { entry.reject(new Error("session-insights-worker-disposed")); } catch { /* noop */ }
  }
  _pending.clear();
}

function _ensureWorker() {
  if (_workerDisabled) return null;
  if (_worker) return _worker;
  if (typeof Worker === "undefined") {
    _workerDisabled = true;
    return null;
  }
  try {
    _worker = new Worker(WORKER_URL, { type: "module" });
  } catch {
    _workerDisabled = true;
    _worker = null;
    return null;
  }
  _worker.onmessage = (event) => {
    const data = event?.data || {};
    const { id } = data;
    if (typeof id !== "number") return;
    const entry = _pending.get(id);
    if (!entry) return;
    _pending.delete(id);
    if (entry.signal && entry.onAbort) {
      try { entry.signal.removeEventListener("abort", entry.onAbort); } catch { /* noop */ }
    }
    if (data.ok) entry.resolve(data.insights || null);
    else entry.reject(new Error(data.error || "session-insights-worker-error"));
  };
  _worker.onerror = () => {
    _disposeWorker();
    _workerDisabled = true;
  };
  return _worker;
}

function _runInWorker(session, signal) {
  const worker = _ensureWorker();
  if (!worker) return null;
  return new Promise((resolve, reject) => {
    const id = _nextRequestId++;
    const entry = { resolve, reject, signal: null, onAbort: null };
    if (signal) {
      if (signal.aborted) {
        reject(signal.reason || new DOMException("aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(signal.reason || new DOMException("aborted", "AbortError"));
        }
      };
      entry.signal = signal;
      entry.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    _pending.set(id, entry);
    try {
      worker.postMessage({ id, session });
    } catch (err) {
      _pending.delete(id);
      _disposeWorker();
      _workerDisabled = true;
      reject(err);
    }
  });
}

function _runIdle(session, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new DOMException("aborted", "AbortError"));
      return;
    }
    let cancelled = false;
    let cancelIdle = null;
    const onAbort = () => {
      cancelled = true;
      try { signal.removeEventListener("abort", onAbort); } catch { /* noop */ }
      cancelIdle?.();
      reject(signal.reason || new DOMException("aborted", "AbortError"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    cancelIdle = _scheduleIdle(() => {
      if (cancelled) return;
      try {
        const insights = buildSessionInsights(session || null);
        resolve(insights);
      } catch (err) {
        reject(err);
      } finally {
        if (signal) {
          try { signal.removeEventListener("abort", onAbort); } catch { /* noop */ }
        }
      }
    });
  });
}

/**
 * Compute session insights without blocking the main thread.
 * @param {object|null} session
 * @param {{ signal?: AbortSignal, forceFallback?: boolean }} [opts]
 * @returns {Promise<object|null>}
 */
export async function computeSessionInsights(session, opts = {}) {
  const signal = opts?.signal || null;
  if (!opts?.forceFallback) {
    try {
      const workerPromise = _runInWorker(session, signal);
      if (workerPromise) return await workerPromise;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // fall through to idle fallback
    }
  }
  return _runIdle(session, signal);
}

/** For tests: drop the singleton worker so a fresh one is created next time. */
export function _resetSessionInsightsWorker() {
  _disposeWorker();
  _workerDisabled = false;
}
