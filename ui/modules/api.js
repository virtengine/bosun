/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – API Client & WebSocket
 *  Handles REST calls, WS connection, and command sending
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { getInitData } from "./telegram.js";

/** Map of in-flight GET request promises, keyed by path */
const _inflight = new Map();
const MAX_CONCURRENT_GET_REQUESTS = 6;
const _queuedGetRequests = [];
let _activeGetRequestCount = 0;

/** Reactive signal: whether the WebSocket is currently connected */
export const wsConnected = signal(false);
/** Reactive signal: high-level socket state for connection badges */
export const wsStatus = signal("offline");
/** Reactive signal: WebSocket round-trip latency in ms (null if unknown) */
export const wsLatency = signal(null);
/** Reactive signal: countdown seconds until next reconnect attempt (null when connected) */
export const wsReconnectIn = signal(null);
/** Reactive signal: number of reconnections since last user-initiated action */
export const wsReconnectCount = signal(0);
/** Reactive signal: timestamp of the most recent successful reconnect */
export const wsLastReconnectAt = signal(null);
/** Reactive signal: count of in-flight apiFetch calls (drives top loading bar) */
export const loadingCount = signal(0);
/** Reactive signal: whether the backend is currently reachable */
export const backendReachability = signal("online");

let _loadingSuppressionDepth = 0;
let _loadingForceDepth = 0;

async function withDepthCounter(kind, fn) {
  if (kind === "suppress") _loadingSuppressionDepth += 1;
  else _loadingForceDepth += 1;
  try {
    return await fn();
  } finally {
    if (kind === "suppress") {
      _loadingSuppressionDepth = Math.max(0, _loadingSuppressionDepth - 1);
    } else {
      _loadingForceDepth = Math.max(0, _loadingForceDepth - 1);
    }
  }
}

export function withLoadingSuppressed(fn) {
  return withDepthCounter("suppress", fn);
}

export function withLoadingTracked(fn) {
  return withDepthCounter("force", fn);
}

function createAbortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function drainGetRequestQueue() {
  while (
    _activeGetRequestCount < MAX_CONCURRENT_GET_REQUESTS
    && _queuedGetRequests.length > 0
  ) {
    const next = _queuedGetRequests.shift();
    next?.start?.();
  }
}

function scheduleGetRequest(task, signal) {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const entry = {
      started: false,
      abortListener: null,
      start: async () => {
        if (entry.started) return;
        entry.started = true;
        if (typeof signal?.removeEventListener === "function" && entry.abortListener) {
          signal.removeEventListener("abort", entry.abortListener);
          entry.abortListener = null;
        }
        if (signal?.aborted) {
          reject(createAbortError());
          drainGetRequestQueue();
          return;
        }

        _activeGetRequestCount += 1;
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          _activeGetRequestCount = Math.max(0, _activeGetRequestCount - 1);
          drainGetRequestQueue();
        }
      },
    };

    if (typeof signal?.addEventListener === "function") {
      entry.abortListener = () => {
        if (entry.started) return;
        const index = _queuedGetRequests.indexOf(entry);
        if (index >= 0) {
          _queuedGetRequests.splice(index, 1);
        }
        reject(createAbortError());
      };
      signal.addEventListener("abort", entry.abortListener, { once: true });
    }

    _queuedGetRequests.push(entry);
    drainGetRequestQueue();
  });
}

/* ─── REST API Client ─── */

/**
 * Fetch from the API (same-origin). Automatically injects the
 * X-Telegram-InitData header and handles JSON parsing / errors.
 *
 * @param {string} path  - API path, e.g. "/api/status"
 * @param {RequestInit & {_silent?: boolean}} options
 * @returns {Promise<any>} parsed JSON body
 */
const MAX_FETCH_RETRIES = 2;
const FETCH_RETRY_BASE_MS = 800;
const NETWORK_ERROR_COOLDOWN_MS = 4000;
const API_ERROR_DEDUPE_MS = 4000;
const DEFAULT_GET_TIMEOUT_MS = 12000;
const DEFAULT_MUTATION_TIMEOUT_MS = 25000;
let _sessionRecoveryPromise = null;
let _backendUnavailableUntil = 0;
let _lastApiErrorAt = 0;
let _lastApiErrorMessage = "";

function buildSessionRecoveryPath() {
  try {
    const current = new URL(globalThis.location?.href || "/", globalThis.location?.origin || "http://localhost");
    return `${current.pathname}${current.search}` || "/";
  } catch {
    return "/";
  }
}

async function readApiErrorBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return { text: "", payload: null };
  try {
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text, payload: null };
  }
}

function resolveApiErrorMessage(status, text, payload) {
  if (payload && typeof payload === "object") {
    const message = String(
      payload.message || payload.detail || payload.reason || payload.error || "",
    ).trim();
    if (message) return message;
  }
  const normalizedText = String(text || "").trim();
  if (normalizedText && !normalizedText.startsWith("{")) return normalizedText;
  if (status === 401) return "Unauthorized.";
  if (status === 403) return "Forbidden.";
  return normalizedText || `Request failed (${status})`;
}

function createApiError(status, body = {}) {
  const error = new Error(resolveApiErrorMessage(status, body.text, body.payload));
  error.status = status;
  error.payload = body.payload || null;
  error.responseText = body.text || "";
  error.isAuthError = status === 401 || status === 403;
  return error;
}

function isNetworkConnectivityError(error) {
  const message = String(error?.message || error || "");
  const name = String(error?.name || "");
  return (
    name === "TypeError"
    || /Failed to fetch/i.test(message)
    || /NetworkError/i.test(message)
    || /Load failed/i.test(message)
    || /ERR_CONNECTION_REFUSED/i.test(message)
    || /ERR_TIMED_OUT/i.test(message)
  );
}

function getBackendCooldownRemainingMs() {
  return Math.max(0, _backendUnavailableUntil - Date.now());
}

function markBackendUnavailable(cooldownMs = NETWORK_ERROR_COOLDOWN_MS) {
  const nextUntil = Date.now() + Math.max(500, Number(cooldownMs) || NETWORK_ERROR_COOLDOWN_MS);
  _backendUnavailableUntil = Math.max(_backendUnavailableUntil, nextUntil);
  backendReachability.value = "offline";
}

function clearBackendUnavailable() {
  _backendUnavailableUntil = 0;
  backendReachability.value = "online";
}

function createBackendUnavailableError(retryInMs = getBackendCooldownRemainingMs()) {
  const seconds = Math.max(1, Math.ceil(Math.max(0, retryInMs) / 1000));
  const error = new Error(`Bosun backend is unavailable. Retrying in about ${seconds}s.`);
  error.status = 0;
  error.isNetworkError = true;
  error.isBackendUnavailable = true;
  return error;
}

function createRequestTimeoutError(timeoutMs) {
  const seconds = Math.max(1, Math.ceil(Math.max(0, Number(timeoutMs) || 0) / 1000));
  const error = new Error(`Bosun backend timed out after about ${seconds}s.`);
  error.name = "AbortError";
  error.status = 0;
  error.isNetworkError = true;
  error.isTimeout = true;
  return error;
}

function shouldDispatchApiError(message) {
  const now = Date.now();
  if (
    message
    && message === _lastApiErrorMessage
    && (now - _lastApiErrorAt) < API_ERROR_DEDUPE_MS
  ) {
    return false;
  }
  _lastApiErrorMessage = message;
  _lastApiErrorAt = now;
  return true;
}

async function recoverUiSession() {
  if (_sessionRecoveryPromise) return _sessionRecoveryPromise;
  _sessionRecoveryPromise = (async () => {
    const headers = {};
    const initData = getInitData();
    if (initData) {
      headers["X-Telegram-InitData"] = initData;
    }
    const response = await fetch(buildSessionRecoveryPath(), {
      method: "GET",
      headers,
      redirect: "follow",
      cache: "no-store",
    });
    if (!response.ok) {
      throw createApiError(response.status, await readApiErrorBody(response));
    }
    return true;
  })().finally(() => {
    _sessionRecoveryPromise = null;
  });
  return _sessionRecoveryPromise;
}

export function apiFetch(path, options = {}) {
  const {
    _silent: silentOption = false,
    _trackLoading: trackLoadingOption,
    _sessionRecoveryAttempted: sessionRecoveryAttempted = false,
    _timeoutMs: timeoutOverrideMs,
    ...requestInit
  } = options || {};
  const headers = { ...requestInit.headers };
  const isFormData = typeof FormData !== "undefined" && requestInit.body instanceof FormData;
  if (!isFormData) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  const initData = getInitData();
  if (initData) {
    headers["X-Telegram-InitData"] = initData;
  }

  const silent = Boolean(silentOption);
  const method = String(requestInit.method || "GET").toUpperCase();
  const timeoutMs = Math.max(
    1000,
    Number(timeoutOverrideMs)
      || Number(requestInit.timeoutMs)
      || (method === "GET" ? DEFAULT_GET_TIMEOUT_MS : DEFAULT_MUTATION_TIMEOUT_MS),
  );

  const forceLoading = trackLoadingOption === true || _loadingForceDepth > 0;
  const suppressLoading = trackLoadingOption === false || _loadingSuppressionDepth > 0;
  const defaultTrackLoading = !silent && method !== "GET";
  const trackLoading =
    !suppressLoading &&
    (forceLoading || trackLoadingOption === true || defaultTrackLoading);

  const isGet = method === "GET";
  const requestOptions = { ...requestInit, method, headers };
  if (isGet && !requestOptions.body && !sessionRecoveryAttempted) {
    if (_inflight.has(path)) {
      return _inflight.get(path);
    }
  }

  const promise = (async () => {
    if (trackLoading) loadingCount.value += 1;
    try {
      const performRequest = async (allowSessionRecovery = true) => {
        const cooldownRemainingMs = getBackendCooldownRemainingMs();
        if (cooldownRemainingMs > 0 && isGet) {
          throw createBackendUnavailableError(cooldownRemainingMs);
        }
        let response;
        let fetchAttempt = 0;
        while (fetchAttempt <= MAX_FETCH_RETRIES) {
          const timeoutController = typeof AbortController !== "undefined"
            ? new AbortController()
            : null;
          const requestSignal = requestOptions.signal;
          const signal = timeoutController?.signal || requestSignal;
          let timeoutId = null;
          let cleanupTimeout = null;
          try {
            if (timeoutController && requestSignal) {
              const abortFromCaller = () => timeoutController.abort(requestSignal.reason);
              if (requestSignal.aborted) {
                abortFromCaller();
              } else {
                requestSignal.addEventListener("abort", abortFromCaller, { once: true });
                cleanupTimeout = () => requestSignal.removeEventListener("abort", abortFromCaller);
              }
            }
            if (timeoutController) {
              timeoutId = setTimeout(() => {
                timeoutController.abort(createRequestTimeoutError(timeoutMs));
              }, timeoutMs);
            }
            response = await fetch(path, { ...requestOptions, signal });
            clearBackendUnavailable();
            break;
          } catch (networkErr) {
            fetchAttempt += 1;
            const isTimeout = networkErr?.name === "AbortError"
              && timeoutController?.signal?.aborted === true;
            if (isTimeout || isNetworkConnectivityError(networkErr)) {
              markBackendUnavailable();
              if (isGet || fetchAttempt > MAX_FETCH_RETRIES || silent) {
                throw isTimeout
                  ? createRequestTimeoutError(timeoutMs)
                  : createBackendUnavailableError();
              }
            }
            if (fetchAttempt > MAX_FETCH_RETRIES || silent) throw networkErr;
            await new Promise((r) => setTimeout(r, FETCH_RETRY_BASE_MS * fetchAttempt));
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
            cleanupTimeout?.();
          }
        }
        if (!response.ok) {
          const body = await readApiErrorBody(response);
          if (allowSessionRecovery && (response.status === 401 || response.status === 403)) {
            await recoverUiSession();
            return performRequest(false);
          }
          throw createApiError(response.status, body);
        }
        return await response.json();
      };

      if (isGet && !requestOptions.body) {
        return await scheduleGetRequest(
          () => performRequest(!sessionRecoveryAttempted),
          requestOptions.signal,
        );
      }
      return await performRequest(!sessionRecoveryAttempted);
    } catch (err) {
      if (!silent) {
        try {
          const message = String(err?.message || "Request failed");
          if (shouldDispatchApiError(message)) {
            globalThis.dispatchEvent(
              new CustomEvent("ve:api-error", { detail: { message } }),
            );
          }
        } catch {
          /* noop */
        }
      }
      throw err;
    } finally {
      if (trackLoading) {
        loadingCount.value = Math.max(0, loadingCount.value - 1);
      }
      if (isGet && !requestOptions.body) _inflight.delete(path);
    }
  })();

  if (isGet && !requestOptions.body && !sessionRecoveryAttempted) _inflight.set(path, promise);
  return promise;
}

/* ─── Command Sending ─── */

/**
 * Send a slash-command to the backend via POST /api/command.
 * @param {string} cmd  - e.g. "/status" or "/starttask abc123"
 * @returns {Promise<any>}
 */
export async function sendCommandToChat(cmd) {
  return apiFetch("/api/command", {
    method: "POST",
    body: JSON.stringify({ command: cmd }),
  });
}

/* ─── WebSocket ─── */

/** @type {WebSocket|null} */
let ws = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let countdownTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pingTimer = null;
let retryMs = 1000;

/** Registered message handlers */
const wsHandlers = new Set();

/**
 * Register a handler for incoming WS messages.
 * Returns an unsubscribe function.
 * @param {(data: any) => void} handler
 * @returns {() => void}
 */
export function onWsMessage(handler) {
  wsHandlers.add(handler);
  return () => wsHandlers.delete(handler);
}

/** Clear the reconnect countdown timer and reset signal */
function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  wsReconnectIn.value = null;
}

/** Start a countdown timer that ticks wsReconnectIn every second */
function startCountdown(ms) {
  clearCountdown();
  let remaining = Math.ceil(ms / 1000);
  wsReconnectIn.value = remaining;
  countdownTimer = setInterval(() => {
    remaining -= 1;
    wsReconnectIn.value = Math.max(0, remaining);
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }, 1000);
}

function scheduleReconnect(ms) {
  const delayMs = Math.max(250, Math.ceil(Number(ms) || retryMs));
  if (reconnectTimer) clearTimeout(reconnectTimer);
  startCountdown(delayMs);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delayMs);
}

/** Start the client-side ping interval (every 30s) */
function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    wsSend({ type: "ping", ts: Date.now() });
  }, 30_000);
}

/** Stop the client-side ping interval */
function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/**
 * Open (or re-open) a WebSocket connection to /ws.
 * Automatically reconnects on close with exponential backoff.
 */
export function connectWebSocket() {
  // Prevent double connections
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const cooldownRemainingMs = getBackendCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    wsConnected.value = false;
    wsStatus.value = "reconnecting";
    scheduleReconnect(cooldownRemainingMs);
    return;
  }

  const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = new URL(`${proto}://${globalThis.location.host}/ws`);

  const initData = getInitData();
  if (initData) {
    wsUrl.searchParams.set("initData", initData);
  } else {
    // Pass session token from cookie for browser-based WS auth
    const m = (document.cookie || "").match(/(?:^|;\s*)ve_session=([^;]+)/);
    if (m) wsUrl.searchParams.set("token", m[1]);
  }

  const socket = new WebSocket(wsUrl.toString());
  ws = socket;
  if (wsReconnectCount.value > 0) {
    wsStatus.value = "reconnecting";
  }

  socket.addEventListener("open", () => {
    if (wsReconnectCount.value > 0) {
      wsLastReconnectAt.value = Date.now();
    }
    wsConnected.value = true;
    wsStatus.value = "connected";
    wsLatency.value = null;
    retryMs = 1000; // reset backoff on successful connect
    clearBackendUnavailable();
    clearCountdown();
    startPing();
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data || "{}");
    } catch {
      return;
    }

    // Handle pong → calculate RTT
    if (msg.type === "pong" && typeof msg.ts === "number") {
      wsLatency.value = Date.now() - msg.ts;
      return;
    }

    // Handle server-initiated ping → reply with pong
    if (msg.type === "ping" && typeof msg.ts === "number") {
      wsSend({ type: "pong", ts: msg.ts });
      return;
    }

    // Handle log-lines streaming
    if (msg.type === "log-lines" && Array.isArray(msg.lines)) {
      try {
        globalThis.dispatchEvent(
          new CustomEvent("ve:log-lines", { detail: { lines: msg.lines } }),
        );
      } catch {
        /* noop */
      }
      return;
    }

    // Dispatch to all registered handlers
    for (const handler of wsHandlers) {
      try {
        handler(msg);
      } catch {
        /* handler errors shouldn't crash the WS loop */
      }
    }
  });

  socket.addEventListener("close", () => {
    wsConnected.value = false;
    wsStatus.value = "reconnecting";
    wsLatency.value = null;
    ws = null;
    stopPing();
    wsReconnectCount.value += 1;
    const delayMs = Math.max(retryMs, getBackendCooldownRemainingMs());
    scheduleReconnect(delayMs);
    retryMs = Math.min(15000, retryMs * 2);
  });

  socket.addEventListener("error", () => {
    wsConnected.value = false;
    wsStatus.value = "reconnecting";
    markBackendUnavailable(retryMs);
  });
}

/**
 * Disconnect the WebSocket and cancel any pending reconnect.
 */
export function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  clearCountdown();
  stopPing();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* noop */
    }
    ws = null;
  }
  wsConnected.value = false;
  wsStatus.value = "offline";
  wsLatency.value = null;
}

/**
 * Send a raw JSON message over the open WebSocket.
 * @param {any} data
 */
export function wsSend(data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }
}

/* ─── Log Streaming ─── */

/**
 * Subscribe to real-time log streaming over the WebSocket.
 * @param {"system"|"agent"} logType
 * @param {string} [query] - optional filter query (e.g. agent name)
 */
export function subscribeToLogs(logType, query) {
  wsSend({ type: "subscribe-logs", logType, ...(query ? { query } : {}) });
}

/**
 * Unsubscribe from log streaming.
 */
export function unsubscribeFromLogs() {
  wsSend({ type: "unsubscribe-logs" });
}

/**
 * Reset the reconnect counter (call on user-initiated actions).
 */
export function resetReconnectCount() {
  wsReconnectCount.value = 0;
}
