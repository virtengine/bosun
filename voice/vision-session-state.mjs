/**
 * vision-session-state.mjs — Shared in-memory state for live vision frames.
 *
 * Keeps the latest frame per session so voice tools can query the current
 * visual context without relying on chat-posted summaries.
 */

const _visionSessionState = new Map();

const MAX_TRACE_TURNS = 12;
const MAX_TURN_EVENTS = 40;
const MAX_TURN_FINGERPRINTS = 32;
const MAX_MULTIMODAL_FALLBACK_HISTORY = 8;
const SECRET_KEY_PATTERN = /(token|key|secret|password|authorization|credential|cookie|client_secret|access_token)/i;

function getSessionKey(sessionId) {
  return String(sessionId || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  )];
}

function buildProfileSlug(value, fallback = "session") {
  const src = String(value || "").trim().toLowerCase();
  let result = "";
  for (const ch of src) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "." || ch === "_") {
      result += ch;
    } else if (result.length > 0 && result[result.length - 1] !== "-") {
      result += "-";
    }
  }
  while (result.endsWith("-")) result = result.slice(0, -1);
  while (result.startsWith("-")) result = result.slice(1);
  return result || fallback;
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function redactSecretLikeText(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  if (/^bearer\s+/i.test(raw)) return "Bearer [redacted]";
  if (/^sk-[a-z0-9_-]+/i.test(raw)) return "[redacted]";
  if (/api[_-]?key/i.test(raw) || /access[_-]?token/i.test(raw) || /client[_-]?secret/i.test(raw)) {
    return "[redacted]";
  }
  return raw;
}

function sanitizeTraceValue(value, key = "", seen = new WeakSet()) {
  if (value == null) return value;

  if (typeof value === "string") {
    return SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redactSecretLikeText(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValue(item, key, seen));
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (typeof childValue === "function") continue;
    output[childKey] = sanitizeTraceValue(childValue, childKey, seen);
  }
  return output;
}

function ensureTraceState(state) {
  if (!state.voiceTurnTrace || typeof state.voiceTurnTrace !== "object") {
    state.voiceTurnTrace = {
      activeTurnId: null,
      updatedAt: 0,
      turns: [],
    };
  }
  return state.voiceTurnTrace;
}

function ensureTurn(trace, turnId, metadata = {}) {
  const resolvedTurnId = String(turnId || trace.activeTurnId || `voice-turn-${Date.now()}`).trim();
  let turn = trace.turns.find((entry) => entry.turnId === resolvedTurnId);
  if (!turn) {
    turn = {
      turnId: resolvedTurnId,
      status: "active",
      startedAt: nowIso(),
      endedAt: null,
      metadata: sanitizeTraceValue(metadata),
      events: [],
      dispatchFingerprints: [],
    };
    trace.turns.push(turn);
    if (trace.turns.length > MAX_TRACE_TURNS) {
      trace.turns.splice(0, trace.turns.length - MAX_TRACE_TURNS);
    }
  } else if (metadata && Object.keys(metadata).length > 0) {
    turn.metadata = {
      ...(turn.metadata || {}),
      ...sanitizeTraceValue(metadata),
    };
  }
  trace.activeTurnId = resolvedTurnId;
  trace.updatedAt = Date.now();
  return turn;
}

function annotateTurnFromEvent(turn, event) {
  if (event.reason && !turn.reason) {
    turn.reason = event.reason;
  }
  if (event.category) {
    turn.category = event.category;
  }
  if (event.expected || event.actual) {
    turn.mismatch = {
      ...(turn.mismatch || {}),
      ...(event.expected ? { expected: event.expected } : {}),
      ...(event.actual ? { actual: event.actual } : {}),
    };
  }
  if (event.type === "turn.abort") {
    turn.status = "aborted";
    turn.endedAt = turn.endedAt || event.at;
  }
  if (event.type === "turn.end") {
    if (turn.status !== "aborted") {
      turn.status = event.status || event.outcome || "completed";
    }
    turn.endedAt = turn.endedAt || event.at;
  }
}

function normalizeBrowserWorkerIsolation(input = {}, fallback = {}) {
  const source = {
    ...(fallback && typeof fallback === "object" ? fallback : {}),
    ...(input && typeof input === "object" ? input : {}),
  };
  const sessionId = getSessionKey(source.sessionId || source.ownerSessionId || fallback?.sessionId);
  const parentSessionId = getSessionKey(source.parentSessionId || fallback?.parentSessionId) || null;
  const rootSessionId = getSessionKey(source.rootSessionId || fallback?.rootSessionId) || parentSessionId || sessionId || null;
  const profileScope = normalizeText(source.profileScope || fallback?.profileScope || "isolated-subagent") || "isolated-subagent";
  const profileId = normalizeText(
    source.profileId
    || fallback?.profileId
    || `${buildProfileSlug(rootSessionId || "root", "root")}--${buildProfileSlug(sessionId || "session")}`,
  ) || `${buildProfileSlug(rootSessionId || "root", "root")}--${buildProfileSlug(sessionId || "session")}`;
  const multimodalFallback = normalizeMultimodalFallback(source.multimodalFallback, fallback?.multimodalFallback);
  return {
    workerId: normalizeText(source.workerId || fallback?.workerId || `browser-worker:${profileId}`) || `browser-worker:${profileId}`,
    sessionId: sessionId || null,
    ownerSessionId: sessionId || null,
    parentSessionId,
    rootSessionId,
    profileId,
    profileDir: normalizeText(source.profileDir || fallback?.profileDir || `.bosun/.cache/browser-workers/${profileId}`) || `.bosun/.cache/browser-workers/${profileId}`,
    profileScope,
    status: normalizeText(source.status || fallback?.status || "attached") || "attached",
    requestedCapabilities: uniqueStrings(source.requestedCapabilities || fallback?.requestedCapabilities),
    toolHints: uniqueStrings(source.toolHints || fallback?.toolHints),
    multimodalFallback,
    metadata: sanitizeTraceValue(source.metadata || fallback?.metadata || {}),
    assignedAt: normalizeText(source.assignedAt || fallback?.assignedAt || "") || nowIso(),
    updatedAt: nowIso(),
    releasedAt: normalizeText(source.releasedAt || fallback?.releasedAt || "") || null,
  };
}

function normalizeMultimodalFallback(input = {}, fallback = {}) {
  const source = {
    ...(fallback && typeof fallback === "object" ? fallback : {}),
    ...(input && typeof input === "object" ? input : {}),
  };
  const history = Array.isArray(source.history)
    ? source.history
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          at: normalizeText(entry.at || entry.timestamp || "") || nowIso(),
          reason: normalizeText(entry.reason || "") || null,
          summary: normalizeText(entry.summary || entry.description || "") || null,
          source: normalizeText(entry.source || "") || null,
        }))
        .slice(-MAX_MULTIMODAL_FALLBACK_HISTORY)
    : [];
  return {
    enabled: normalizeBoolean(source.enabled, true),
    mode: normalizeText(source.mode || "vision_summary_to_text") || "vision_summary_to_text",
    available: normalizeBoolean(source.available, history.length > 0 || Boolean(normalizeText(source.summary || source.description || source.lastDescription))),
    reason: normalizeText(source.reason || "") || null,
    summary: normalizeText(source.summary || source.description || source.lastDescription || "") || null,
    source: normalizeText(source.source || "") || null,
    frameHash: normalizeText(source.frameHash || "") || null,
    width: Number.isFinite(Number(source.width)) ? Number(source.width) : null,
    height: Number.isFinite(Number(source.height)) ? Number(source.height) : null,
    updatedAt: normalizeText(source.updatedAt || source.lastUpdatedAt || "") || null,
    history,
  };
}

function buildMultimodalFallbackDescription(state, fallback = {}) {
  const summary = normalizeText(fallback.summary || state?.lastSummary || "");
  const source = normalizeText(fallback.source || state?.lastFrameSource || "") || "screen";
  const width = Number.isFinite(Number(fallback.width)) ? Number(fallback.width) : state?.lastFrameWidth;
  const height = Number.isFinite(Number(fallback.height)) ? Number(fallback.height) : state?.lastFrameHeight;
  const dimension = width && height ? ` (${width}x${height})` : "";
  if (summary) {
    return `[${source}${dimension}] ${summary}`;
  }
  if (state?.lastFrameHash) {
    return `Visual context from ${source}${dimension} is available for text fallback.`;
  }
  return "";
}

export function getVisionSessionState(sessionId) {
  const key = getSessionKey(sessionId);
  if (!key) return null;
  if (!_visionSessionState.has(key)) {
    _visionSessionState.set(key, {
      lastFrameHash: null,
      lastReceiptAt: 0,
      lastAnalyzedHash: null,
      lastAnalyzedAt: 0,
      lastSummary: "",
      inFlight: null,
      lastFrameDataUrl: "",
      lastFrameSource: "screen",
      lastFrameWidth: null,
      lastFrameHeight: null,
      browserWorker: null,
      multimodalFallback: {
        enabled: true,
        mode: "vision_summary_to_text",
        available: false,
        reason: null,
        summary: null,
        source: null,
        frameHash: null,
        width: null,
        height: null,
        updatedAt: null,
        history: [],
      },
      voiceTurnTrace: null,
    });
  }
  return _visionSessionState.get(key);
}

export function clearVisionSessionState(sessionId) {
  const key = getSessionKey(sessionId);
  if (!key) return false;
  return _visionSessionState.delete(key);
}

export function ensureBrowserWorkerIsolation(sessionId, options = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  state.browserWorker = normalizeBrowserWorkerIsolation({
    sessionId,
    ...options,
  }, state.browserWorker || {});
  if (!state.multimodalFallback || typeof state.multimodalFallback !== "object") {
    state.multimodalFallback = normalizeMultimodalFallback();
  }
  if (options.multimodalFallback || state.browserWorker?.multimodalFallback) {
    state.multimodalFallback = normalizeMultimodalFallback(
      state.browserWorker?.multimodalFallback || options.multimodalFallback,
      state.multimodalFallback,
    );
  }
  return cloneValue(state.browserWorker);
}

export function getBrowserWorkerIsolation(sessionId) {
  const state = getVisionSessionState(sessionId);
  if (!state?.browserWorker) return null;
  return cloneValue(state.browserWorker);
}

export function listBrowserWorkerIsolations(options = {}) {
  const rootSessionId = getSessionKey(options.rootSessionId);
  const parentSessionId = getSessionKey(options.parentSessionId);
  return [..._visionSessionState.values()]
    .map((state) => state?.browserWorker || null)
    .filter(Boolean)
    .filter((worker) => {
      if (rootSessionId && getSessionKey(worker.rootSessionId) !== rootSessionId) return false;
      if (parentSessionId && getSessionKey(worker.parentSessionId) !== parentSessionId) return false;
      return true;
    })
    .map((worker) => cloneValue(worker));
}

export function releaseBrowserWorkerIsolation(sessionId, reason = "released") {
  const state = getVisionSessionState(sessionId);
  if (!state?.browserWorker) return null;
  const released = normalizeBrowserWorkerIsolation({
    ...state.browserWorker,
    status: "released",
    releasedAt: nowIso(),
    metadata: {
      ...(state.browserWorker.metadata && typeof state.browserWorker.metadata === "object" ? state.browserWorker.metadata : {}),
      releaseReason: normalizeText(reason) || "released",
    },
  }, state.browserWorker);
  state.browserWorker = null;
  return cloneValue(released);
}

export function recordMultimodalFallback(sessionId, input = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const description = buildMultimodalFallbackDescription(state, input);
  const nextHistoryEntry = {
    at: nowIso(),
    reason: normalizeText(input.reason || "") || null,
    summary: normalizeText(input.summary || input.description || description) || null,
    source: normalizeText(input.source || state.lastFrameSource || "") || null,
  };
  const fallback = normalizeMultimodalFallback({
    ...state.multimodalFallback,
    ...input,
    available: Boolean(description),
    summary: description || normalizeText(input.summary || input.description || ""),
    source: normalizeText(input.source || state.lastFrameSource || ""),
    frameHash: normalizeText(input.frameHash || state.lastFrameHash || ""),
    width: Number.isFinite(Number(input.width)) ? Number(input.width) : state.lastFrameWidth,
    height: Number.isFinite(Number(input.height)) ? Number(input.height) : state.lastFrameHeight,
    updatedAt: nowIso(),
    history: [
      ...(Array.isArray(state.multimodalFallback?.history) ? state.multimodalFallback.history : []),
      nextHistoryEntry,
    ].slice(-MAX_MULTIMODAL_FALLBACK_HISTORY),
  }, state.multimodalFallback);
  state.multimodalFallback = fallback;
  if (state.browserWorker) {
    state.browserWorker = normalizeBrowserWorkerIsolation({
      ...state.browserWorker,
      multimodalFallback: fallback,
    }, state.browserWorker);
  }
  return cloneValue(fallback);
}

export function describeMultimodalFallback(sessionId, options = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) {
    return {
      sessionId: getSessionKey(sessionId),
      available: false,
      description: "",
      browserWorker: null,
    };
  }
  const fallback = normalizeMultimodalFallback(options, state.multimodalFallback);
  const description = normalizeText(
    options.description
    || options.summary
    || fallback.summary
    || buildMultimodalFallbackDescription(state, fallback),
  );
  return {
    sessionId: getSessionKey(sessionId),
    available: Boolean(description),
    description,
    browserWorker: cloneValue(state.browserWorker),
    fallback: cloneValue({
      ...fallback,
      summary: description || fallback.summary,
      available: Boolean(description),
    }),
  };
}

export function beginVoiceTurnTrace(sessionId, metadata = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, metadata?.turnId, metadata);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.start",
    ...sanitizeTraceValue(metadata),
  });
  return { turnId: turn.turnId, status: turn.status };
}

export function appendVoiceTurnTraceEvent(sessionId, event = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, event?.turnId, event?.metadata || {});
  const sanitized = sanitizeTraceValue(event);
  const traceEvent = {
    at: nowIso(),
    type: String(sanitized?.type || "trace.event").trim() || "trace.event",
    ...sanitized,
  };
  delete traceEvent.metadata;
  delete traceEvent.turnId;

  turn.events.push(traceEvent);
  if (turn.events.length > MAX_TURN_EVENTS) {
    turn.events.splice(0, turn.events.length - MAX_TURN_EVENTS);
  }
  annotateTurnFromEvent(turn, traceEvent);
  trace.updatedAt = Date.now();
  return traceEvent;
}

export function completeVoiceTurnTrace(sessionId, details = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, details?.turnId, details);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.end",
    status: details?.status,
    outcome: details?.outcome,
  });
  if (trace.activeTurnId === turn.turnId) {
    trace.activeTurnId = null;
  }
  return { turnId: turn.turnId, status: turn.status };
}

export function abortVoiceTurnTrace(sessionId, reason = "aborted", details = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state) return null;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, details?.turnId, details);
  appendVoiceTurnTraceEvent(sessionId, {
    turnId: turn.turnId,
    type: "turn.abort",
    reason: String(reason || "aborted"),
    ...sanitizeTraceValue(details),
  });
  return { turnId: turn.turnId, status: turn.status, reason: turn.reason };
}

export function hasVoiceTurnTraceFingerprint(sessionId, turnId, fingerprint) {
  const trace = getVoiceTurnTrace(sessionId);
  const resolvedTurnId = String(turnId || trace?.activeTurnId || "").trim();
  if (!trace || !resolvedTurnId || !fingerprint) return false;
  const turn = trace.turns.find((entry) => entry.turnId === resolvedTurnId);
  if (!turn) return false;
  return Array.isArray(turn.dispatchFingerprints) && turn.dispatchFingerprints.includes(fingerprint);
}

export function rememberVoiceTurnTraceFingerprint(sessionId, turnId, fingerprint) {
  const state = getVisionSessionState(sessionId);
  if (!state) return false;
  const trace = ensureTraceState(state);
  const turn = ensureTurn(trace, turnId);
  if (!fingerprint || turn.dispatchFingerprints.includes(fingerprint)) {
    return false;
  }
  turn.dispatchFingerprints.push(String(fingerprint));
  if (turn.dispatchFingerprints.length > MAX_TURN_FINGERPRINTS) {
    turn.dispatchFingerprints.splice(0, turn.dispatchFingerprints.length - MAX_TURN_FINGERPRINTS);
  }
  trace.updatedAt = Date.now();
  return true;
}

export function getVoiceTurnTrace(sessionId, options = {}) {
  const state = getVisionSessionState(sessionId);
  if (!state?.voiceTurnTrace) {
    return {
      sessionId: getSessionKey(sessionId),
      activeTurnId: null,
      updatedAt: 0,
      turns: [],
    };
  }

  const trace = state.voiceTurnTrace;
  const limit = Math.max(1, Number(options?.limit) || trace.turns.length || 1);
  const requestedTurnId = String(options?.turnId || "").trim();
  const selectedTurns = requestedTurnId
    ? trace.turns.filter((turn) => turn.turnId === requestedTurnId)
    : trace.turns.slice(-limit);
  const turns = selectedTurns.map((turn) => ({
    ...sanitizeTraceValue(turn),
    events: Array.isArray(turn.events) ? turn.events.map((event) => sanitizeTraceValue(event)) : [],
  }));

  return {
    sessionId: getSessionKey(sessionId),
    activeTurnId: trace.activeTurnId,
    updatedAt: trace.updatedAt,
    turns,
  };
}

function describeTurnCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "transport") return "transport issue";
  if (normalized === "dispatch-mismatch") return "dispatch mismatch";
  return normalized;
}

function inferTurnCategory(turn = {}) {
  if (turn.category) {
    return turn.category;
  }

  const reason = String(turn.reason || "").trim().toLowerCase();
  if (reason.startsWith("transport") || reason.includes("socket") || reason.includes("connection")) {
    return "transport";
  }
  if (reason === "unknown_action" || reason === "missing_action" || reason.includes("mismatch") || reason.includes("duplicate_dispatch")) {
    return "dispatch-mismatch";
  }

  const events = Array.isArray(turn.events) ? turn.events : [];
  if (events.some((event) => String(event?.type || "").trim().toLowerCase() === "action.mismatch")) {
    return "dispatch-mismatch";
  }
  if (events.some((event) => String(event?.type || "").trim().toLowerCase() === "turn.abort")) {
    return "transport";
  }

  return "";
}

export function formatVoiceTurnTrace(sessionId, options = {}) {
  const trace = getVoiceTurnTrace(sessionId, options);
  if (!trace.turns.length) {
    return `No voice turn trace recorded for ${trace.sessionId || "(unknown session)"}.`;
  }

  const lines = [`Voice turn trace for ${trace.sessionId}`];
  for (const turn of trace.turns) {
    const categoryText = describeTurnCategory(inferTurnCategory(turn));
    const transport = turn.metadata?.transport ? ` transport=${turn.metadata.transport}` : "";
    lines.push(`Turn ${turn.turnId} [${turn.status}]${transport}`);
    if (turn.reason) {
      lines.push(`  reason=${turn.reason}${categoryText ? ` (${categoryText})` : ""}`);
    } else if (categoryText) {
      lines.push(`  category=${categoryText}`);
    }
    if (turn.mismatch?.expected || turn.mismatch?.actual) {
      lines.push(`  mismatch expected=${turn.mismatch?.expected || "(none)"} actual=${turn.mismatch?.actual || "(none)"}`);
    }
    for (const event of turn.events.slice(-12)) {
      const parts = [`  - ${event.type}`];
      if (event.action) parts.push(`action=${event.action}`);
      if (event.toolName) parts.push(`tool=${event.toolName}`);
      if (event.reason) parts.push(`reason=${event.reason}`);
      if (event.expected) parts.push(`expected=${event.expected}`);
      if (event.actual) parts.push(`actual=${event.actual}`);
      lines.push(parts.join(" "));
    }
  }
  return lines.join("\n");
}





export function renderVoiceTurnTrace(sessionId, options = {}) {
  return formatVoiceTurnTrace(sessionId, options);
}
