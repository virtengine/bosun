/*
 * Session API path helpers.
 * Keeps workspace scoping explicit for /api/sessions/:id routes.
 */

export const SESSION_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1500,
  maxDelayMs: 20000,
  backoffMultiplier: 2,
});

export const SESSION_RUNTIME_RECENT_WINDOW_MS = 90 * 1000;
export const SESSION_RUNTIME_STALE_WINDOW_MS = 10 * 60 * 1000;

function normalizeRetryNumber(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeIsoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return null;
  return date.toISOString();
}

function defaultFormatDate(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function defaultFormatRelative(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = Date.now() - timestamp;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeStaleReason(reason) {
  if (reason && typeof reason === "object") {
    const code = String(reason.code || reason.type || "").trim() || null;
    const message = String(
      reason.message || reason.detail || reason.reason || reason.error || "",
    ).trim() || null;
    return { code, message };
  }
  const message = String(reason || "").trim() || null;
  return { code: null, message };
}

function titleCaseWords(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildStaleReasonLabel(code, message) {
  const normalizedCode = String(code || "").trim().toLowerCase();
  if (normalizedCode === "offline") return "Browser offline";
  if (normalizedCode === "request_failed") return "Refresh request failed";
  if (normalizedCode === "timeout") return "Refresh timed out";
  if (normalizedCode === "server_error") return "Server error";
  if (normalizedCode) return titleCaseWords(normalizedCode.replace(/[-_]+/g, " "));
  if (message) return "Refresh request failed";
  return "Unknown refresh issue";
}

function normalizeStaleReasonMeta(reason, overrides = {}) {
  const normalized = normalizeStaleReason(reason);
  const code = normalized.code || null;
  const message = normalized.message || null;
  const overrideLabel = String(overrides?.label || "").trim() || null;
  if (!code && !message && !overrideLabel) return null;
  const label = overrideLabel || buildStaleReasonLabel(code, message);
  return { code, message, label };
}

function resolveRetryConfig(meta = {}) {
  const maxAttempts = normalizeRetryNumber(
    meta.maxAttempts,
    SESSION_RETRY_DEFAULTS.maxAttempts,
    1,
  );
  const baseDelayMs = normalizeRetryNumber(
    meta.baseDelayMs,
    SESSION_RETRY_DEFAULTS.baseDelayMs,
    1,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    normalizeRetryNumber(meta.maxDelayMs, SESSION_RETRY_DEFAULTS.maxDelayMs, 1),
  );
  const backoffMultiplier = Math.max(
    1,
    Number(meta.backoffMultiplier || SESSION_RETRY_DEFAULTS.backoffMultiplier),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs, backoffMultiplier };
}

export function createSessionLoadMeta(overrides = {}) {
  const config = resolveRetryConfig(overrides);
  const staleReasonMeta = normalizeStaleReasonMeta(
    overrides?.staleReasonMeta && typeof overrides.staleReasonMeta === "object"
      ? overrides.staleReasonMeta
      : overrides?.staleReason && typeof overrides.staleReason === "object"
        ? overrides.staleReason
        : {
            code: overrides?.staleReasonCode,
            message: overrides?.staleReason,
            label: overrides?.staleReasonLabel,
          },
  );
  const staleReason = normalizeStaleReason(
    overrides?.staleReason && typeof overrides.staleReason === "object"
      ? overrides.staleReason
      : {
          code: overrides?.staleReasonCode,
          message: overrides?.staleReason,
        },
  );
  return {
    ...config,
    stale: Boolean(overrides?.stale),
    lastSuccessAt: normalizeIsoTimestamp(overrides?.lastSuccessAt),
    lastFailureAt: normalizeIsoTimestamp(overrides?.lastFailureAt),
    staleReason: staleReasonMeta?.message || staleReason.message,
    staleReasonCode: staleReasonMeta?.code || staleReason.code,
    staleReasonLabel: staleReasonMeta?.label || null,
    staleReasonMeta,
    retryAttempt: normalizeRetryNumber(overrides?.retryAttempt, 0, 0),
    retryDelayMs: normalizeRetryNumber(overrides?.retryDelayMs, 0, 0),
    nextRetryAt: normalizeIsoTimestamp(overrides?.nextRetryAt),
    retriesExhausted: Boolean(overrides?.retriesExhausted),
  };
}

export function getSessionRetryDelayMs(attemptNumber, meta = {}) {
  const { baseDelayMs, maxDelayMs, backoffMultiplier } = resolveRetryConfig(meta);
  const attempt = Math.max(1, normalizeRetryNumber(attemptNumber, 1, 1));
  const delay = Math.round(baseDelayMs * Math.pow(backoffMultiplier, attempt - 1));
  return Math.min(maxDelayMs, Math.max(baseDelayMs, delay));
}

export function formatSessionFreshnessTimestamp(lastSuccessAt, formatters = {}) {
  if (!lastSuccessAt) return "unknown";
  const formatRelative =
    typeof formatters?.formatRelative === "function"
      ? formatters.formatRelative
      : defaultFormatRelative;
  const formatDate =
    typeof formatters?.formatDate === "function"
      ? formatters.formatDate
      : defaultFormatDate;
  const relative = String(formatRelative(lastSuccessAt) || "").trim();
  const absolute = String(formatDate(lastSuccessAt) || "").trim();
  if (relative && absolute && relative !== absolute) {
    return `${relative} (${absolute})`;
  }
  return relative || absolute || "unknown";
}

export function deriveSessionStaleReason(error) {
  if (typeof navigator !== "undefined" && navigator?.onLine === false) {
    return {
      code: "offline",
      message: "Browser appears to be offline.",
    };
  }
  const raw = String(error?.message || error || "").trim();
  if (!raw) {
    return {
      code: "request_failed",
      message: "Last refresh failed before new session data could be loaded.",
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const message = String(parsed?.error || parsed?.message || "").trim();
    if (message) {
      return {
        code: String(parsed?.code || "request_failed").trim() || "request_failed",
        message,
      };
    }
  } catch {
    // Raw string error; preserve it as operator-facing context.
  }
  return {
    code: "request_failed",
    message: raw,
  };
}
export function classifySessionRequestError(error) {
  const raw = String(error?.message || error || "").trim();
  const lower = raw.toLowerCase();
  const code = String(error?.code || "").trim().toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (!raw && !code && !status) {
    return {
      raw,
      isNotFound: false,
      isTransient: false,
      key: null,
    };
  }
  const isNotFound =
    status === 404
    || code === "not_found"
    || lower.includes("not_found")
    || lower.includes("session not found")
    || lower.includes("request failed (404)")
    || lower.includes("not found");
  const isTransient =
    !isNotFound && (
      code === "request_failed"
      || code === "timeout"
      || code === "offline"
      || status === 408
      || status === 429
      || status >= 500
      || lower.includes("timeout")
      || lower.includes("timed out")
      || lower.includes("network")
      || lower.includes("offline")
      || lower.includes("request failed")
      || lower.includes("gateway")
      || lower.includes("unavailable")
    );
  return {
    raw,
    isNotFound,
    isTransient,
    key: isNotFound ? "not_found" : isTransient ? "unavailable" : "fatal",
  };
}

export function isScopedSessionNotFound(error) {
  return classifySessionRequestError(error).isNotFound;
}

export function shouldFallbackToAllSessions(error, primaryPath, fallbackPath) {
  if (!fallbackPath || fallbackPath === primaryPath) return false;
  return isScopedSessionNotFound(error);
}

export function getSessionManualRetryState(meta, options = {}) {
  const now = Number(options?.now || Date.now()) || Date.now();
  if (options?.isLoading) {
    return {
      disabled: true,
      label: "Refreshing…",
      reason: "Refresh already in progress.",
      retrySeconds: 0,
      backoffActive: false,
    };
  }
  const loadMeta = createSessionLoadMeta(meta || {});
  const nextRetryAt = Date.parse(String(loadMeta.nextRetryAt || ""));
  const backoffActive =
    !loadMeta.retriesExhausted && Number.isFinite(nextRetryAt) && nextRetryAt > now;
  if (backoffActive) {
    const retrySeconds = Math.max(0, Math.ceil((nextRetryAt - now) / 1000));
    return {
      disabled: true,
      label: retrySeconds > 0 ? `Retry in ${retrySeconds}s` : "Retry locked",
      reason: "Manual retry is disabled while automatic backoff is active.",
      retrySeconds,
      backoffActive: true,
    };
  }
  return {
    disabled: false,
    label: "Retry now",
    reason: "",
    retrySeconds: 0,
    backoffActive: false,
  };
}

export function markSessionLoadSuccess(previousMeta, now = Date.now()) {
  const meta = createSessionLoadMeta(previousMeta || {});
  return {
    ...meta,
    stale: false,
    lastSuccessAt: normalizeIsoTimestamp(now) || new Date().toISOString(),
    retryAttempt: 0,
    retryDelayMs: 0,
    nextRetryAt: null,
    retriesExhausted: false,
    staleReason: null,
    staleReasonCode: null,
    staleReasonLabel: null,
    staleReasonMeta: null,
  };
}

export function markSessionLoadFailure(previousMeta, now = Date.now(), options = {}) {
  const meta = createSessionLoadMeta(previousMeta || {});
  const retryAttempt = normalizeRetryNumber(meta.retryAttempt, 0, 0) + 1;
  const retriesExhausted = retryAttempt > meta.maxAttempts;
  const retryDelayMs = retriesExhausted
    ? 0
    : getSessionRetryDelayMs(retryAttempt, meta);
  const staleReasonMeta = normalizeStaleReasonMeta(
    options?.staleReason ?? options?.reason ?? {
      code: options?.staleReasonCode,
      message: options?.message,
    },
  );
  return {
    ...meta,
    stale: true,
    lastFailureAt: meta.lastFailureAt || normalizeIsoTimestamp(now) || new Date().toISOString(),
    staleReason: staleReasonMeta?.message || meta.staleReason || null,
    staleReasonCode: staleReasonMeta?.code || meta.staleReasonCode || null,
    staleReasonLabel: staleReasonMeta?.label || meta.staleReasonLabel || null,
    staleReasonMeta: staleReasonMeta || meta.staleReasonMeta || null,
    retryAttempt,
    retryDelayMs,
    nextRetryAt: retriesExhausted ? null : new Date(new Date(now).getTime() + retryDelayMs).toISOString(),
    retriesExhausted,
  };
}

export function resetSessionRetryMeta(previousMeta) {
  const meta = createSessionLoadMeta(previousMeta || {});
  return {
    ...meta,
    retryAttempt: 0,
    retryDelayMs: 0,
    nextRetryAt: null,
    retriesExhausted: false,
  };
}

export function getSessionListState(input = {}) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions.filter(Boolean) : [];
  const loadMeta = createSessionLoadMeta(input?.loadMeta || {});
  const hasSessions = sessions.length > 0;
  const isStale = Boolean(loadMeta.stale && (loadMeta.lastSuccessAt || hasSessions));
  const errorState = input?.error && typeof input.error === "object"
    ? input.error
    : classifySessionRequestError(input?.error);
  const errorKey = String(errorState?.key || "").trim().toLowerCase() || null;

  if (isStale) {
    return {
      key: "stale",
      isError: false,
      canRetry: true,
      hasSessions,
      message: "Session list is showing stale data.",
    };
  }
  if (errorKey === "not_found") {
    return {
      key: "not_found",
      isError: true,
      canRetry: true,
      hasSessions: false,
      message: "Sessions not found",
    };
  }
  if (errorKey) {
    return {
      key: errorKey,
      isError: true,
      canRetry: true,
      hasSessions,
      message: errorKey === "fatal" ? "Sessions failed to load" : "Sessions not available",
    };
  }
  return {
    key: "ready",
    isError: false,
    canRetry: false,
    hasSessions,
    message: "",
  };
}

function normalizeWorkspaceHint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "all" || lower === "*") return "all";
  if (lower === "active") return "active";
  return raw;
}

function normalizeSessionLifecycleKey(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) return "idle";
  if (lower === "running") return "active";
  if (lower === "done") return "completed";
  return lower;
}

function normalizeSessionRuntimeKey(value) {
  const lower = String(value || "").trim().toLowerCase();
  if (!lower) return "";
  if (
    lower === "active"
    || lower === "running"
    || lower === "busy"
    || lower === "inprogress"
  ) {
    return "running";
  }
  if (lower === "pending") return "queued";
  if (lower === "ended" || lower === "completed" || lower === "done") return "stopped";
  if (lower === "archived") return "stopped";
  if (lower === "failed" || lower === "error") return "stopped";
  return lower;
}

export function getSessionRecencyTimestamp(session) {
  return normalizeIsoTimestamp(
    session?.lastActiveAt
      || session?.runtimeUpdatedAt
      || session?.updatedAt
      || session?.createdAt,
  );
}

export function getSessionLifecycleState(session) {
  const key = normalizeSessionLifecycleKey(
    session?.lifecycleStatus
      || session?.lifecycle?.status
      || session?.status,
  );
  const meta = {
    active: { label: "Active", tone: "success", isActive: true },
    completed: { label: "Completed", tone: "default", isActive: false },
    archived: { label: "Archived", tone: "default", isActive: false },
    failed: { label: "Failed", tone: "error", isActive: false },
    error: { label: "Error", tone: "error", isActive: false },
    idle: { label: "Idle", tone: "warning", isActive: false },
    paused: { label: "Paused", tone: "warning", isActive: false },
  }[key] || {
    label: titleCaseWords(key.replace(/[-_]+/g, " ")),
    tone: "default",
    isActive: false,
  };
  return { key, ...meta };
}

function buildRuntimeState(key, overrides = {}) {
  const base = {
    running: { label: "Running", tone: "success", isLive: true, isStale: false },
    idle: { label: "Idle", tone: "warning", isLive: true, isStale: false },
    stalled: { label: "Stalled", tone: "error", isLive: false, isStale: true },
    queued: { label: "Queued", tone: "info", isLive: false, isStale: false },
    paused: { label: "Paused", tone: "warning", isLive: false, isStale: false },
    recent: { label: "Recent", tone: "info", isLive: false, isStale: false },
    stale: { label: "Stale", tone: "error", isLive: false, isStale: true },
    stopped: { label: "Not live", tone: "default", isLive: false, isStale: false },
  }[key] || {
    label: titleCaseWords(String(key || "unknown").replace(/[-_]+/g, " ")),
    tone: "default",
    isLive: false,
    isStale: false,
  };
  return {
    key,
    source: overrides.source || "runtime",
    ageMs: Number.isFinite(overrides.ageMs) ? overrides.ageMs : null,
    ...base,
    ...overrides,
  };
}

function resolveSessionRuntimeLiveFlag(session) {
  if (!session || typeof session !== "object") return null;
  if (typeof session.runtimeIsLive === "boolean") return session.runtimeIsLive;
  if (typeof session.runtime?.isLive === "boolean") return session.runtime.isLive;
  if (typeof session.runtimeSnapshot?.isLive === "boolean") return session.runtimeSnapshot.isLive;
  return null;
}

function resolveSessionRuntimeAgeMs(session, now = Date.now()) {
  const recencyAt = getSessionRecencyTimestamp(session);
  const recencyMs = Date.parse(String(recencyAt || ""));
  if (!Number.isFinite(recencyMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - recencyMs);
}

function buildSessionRecencyRuntimeState(session, lifecycle, options = {}, source = "recency") {
  if (!lifecycle.isActive) {
    return buildRuntimeState("stopped", { source: "lifecycle" });
  }
  const now = Number(options?.now || Date.now()) || Date.now();
  const ageMs = resolveSessionRuntimeAgeMs(session, now);
  if (ageMs <= SESSION_RUNTIME_RECENT_WINDOW_MS) {
    return buildRuntimeState("recent", { source, ageMs });
  }
  if (ageMs >= SESSION_RUNTIME_STALE_WINDOW_MS || !Number.isFinite(ageMs)) {
    return buildRuntimeState("stale", { source, ageMs });
  }
  return buildRuntimeState("idle", { source, ageMs, isLive: false });
}

export function getSessionRuntimeState(session, options = {}) {
  const lifecycle = getSessionLifecycleState(session);
  if (!lifecycle.isActive) {
    return buildRuntimeState("stopped", { source: "lifecycle" });
  }
  const runtimeKey = normalizeSessionRuntimeKey(
    session?.runtimeState
      || session?.runtimeStatus
      || session?.runtime?.state
      || session?.runtimeSnapshot?.state
      || (session?.lifecycleStatus ? "" : session?.status),
  );
  const runtimeIsLive = resolveSessionRuntimeLiveFlag(session);
  if (runtimeKey) {
    if (runtimeKey === "running" && runtimeIsLive === false) {
      return buildSessionRecencyRuntimeState(session, lifecycle, options, "runtime");
    }
    const now = Number(options?.now || Date.now()) || Date.now();
    const ageMs = resolveSessionRuntimeAgeMs(session, now);
    return buildRuntimeState(runtimeKey, {
      source: "runtime",
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      isLive:
        runtimeKey === "running"
          ? (runtimeIsLive === false ? false : true)
          : (runtimeIsLive === true ? true : false),
    });
  }
  return buildSessionRecencyRuntimeState(session, lifecycle, options, "recency");
}

export function getSessionHistoryState(session, options = {}) {
  const lifecycle = getSessionLifecycleState(session);
  const runtime = getSessionRuntimeState(session, options);
  const inProgress =
    lifecycle.isActive
    && (runtime.isLive || runtime.key === "running" || runtime.key === "queued");
  const isArchived = lifecycle.key === "archived";
  const isHistoric = !inProgress;
  const folderPath = String(
    session?.surface?.repository?.selected?.path
    || session?.workspaceDir
    || session?.workspacePath
    || session?.metadata?.selectedRepoPath
    || session?.metadata?.workspaceDir
    || session?.metadata?.workspacePath
    || "",
  ).trim() || null;

  let label = "Live session";
  let tone = "default";
  if (isArchived) {
    label = "Archived history";
    tone = "default";
  } else if (isHistoric) {
    label = "Cold reopen ready";
    tone = runtime.isStale ? "warning" : "info";
  } else if (runtime.key === "running" || runtime.key === "queued") {
    label = "Live session";
    tone = "success";
  }

  return {
    key: isArchived ? "archived" : (isHistoric ? "historic" : "live"),
    label,
    tone,
    isHistoric,
    isArchived,
    isLive: inProgress,
    canReopenTranscript: Boolean(session && (session.id || session.taskId)),
    canResumeWork: isArchived || lifecycle.key === "paused",
    canDeleteHistory: isHistoric,
    canRevealFolder: Boolean(folderPath),
    folderPath,
    reopenLabel: isHistoric ? "Reopen transcript" : "Open session",
    resumeLabel: isArchived || lifecycle.key === "paused" ? "Resume work" : "",
    deleteLabel: isHistoric ? "Delete history" : "Delete session",
  };
}

export function resolveSessionWorkspaceHint(session, fallback = "active") {
  const direct = String(session?.workspaceId || session?.workspace || "").trim();
  if (direct) return normalizeWorkspaceHint(direct);
  const metadata =
    session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
  const fromMetadata = String(metadata?.workspaceId || "").trim();
  if (fromMetadata) return normalizeWorkspaceHint(fromMetadata);
  return normalizeWorkspaceHint(fallback);
}

export function buildSessionApiPath(sessionId, action = "", opts = {}) {
  const safeId = encodeURIComponent(String(sessionId || "").trim());
  if (!safeId) return "";
  const suffix = action ? `/${String(action || "").trim()}` : "";
  const path = `/api/sessions/${safeId}${suffix}`;
  const params = new URLSearchParams();

  const workspace = normalizeWorkspaceHint(opts?.workspace);
  if (workspace) params.set("workspace", workspace);

  if (opts?.query && typeof opts.query === "object") {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value == null) continue;
      const stringValue = String(value).trim();
      if (!stringValue) continue;
      params.set(key, stringValue);
    }
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}





