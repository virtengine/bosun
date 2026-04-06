/* ─────────────────────────────────────────────────────────────
 *  Component: Session List — ChatGPT-style sidebar for agent sessions
 *  With swipe-to-action, archive, delete, and duplicate prevention.
 *  UI: MUI Material components (Preact + HTM, no build step)
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import { signal, computed, effect } from "@preact/signals";
import { apiFetch, onWsMessage } from "../modules/api.js";
import {
  buildSessionApiPath,
  classifySessionRequestError,
  createSessionLoadMeta,
  deriveSessionStaleReason,
  formatSessionFreshnessTimestamp,
  getSessionHistoryState,
  getSessionLifecycleState,
  getSessionManualRetryState,
  getSessionListState,
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  markSessionLoadFailure,
  markSessionLoadSuccess,
  resolveSessionWorkspaceHint,
  shouldFallbackToAllSessions,
} from "../modules/session-api.js";
import { formatDate, formatRelative, truncate } from "../modules/utils.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { showToast } from "../modules/state.js";
import {
  List, ListItem, ListItemButton, ListItemText, ListItemIcon,
  ListItemSecondaryAction, Typography, Box, Stack, IconButton,
  Chip, Divider, TextField, InputAdornment, CircularProgress,
  Tooltip, Menu, MenuItem, Paper, Skeleton, Button, Alert,
} from "@mui/material";

const html = htm.bind(h);
const SELECTED_SESSION_STORAGE_KEY = "ve-selected-session-id";

function readPersistedSelectedSessionId() {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = String(localStorage.getItem(SELECTED_SESSION_STORAGE_KEY) || "").trim();
    return value || null;
  } catch {
    return null;
  }
}

/* ─── Signals ─── */
export const sessionsData = signal([]);
export const selectedSessionId = signal(readPersistedSelectedSessionId());
export const sessionMessages = signal([]);
export const sessionMessagesSessionId = signal("");
export const sessionsError = signal(null);
export const sessionsLoading = signal(false);
export const sessionLoadMeta = signal(createSessionLoadMeta());
/** Pagination metadata from the last loadSessionMessages call */
export const sessionPagination = signal(null);

effect(() => {
  const sessionId = selectedSessionId.value ? String(selectedSessionId.value).trim() : "";
  if (typeof localStorage === "undefined") return;
  try {
    if (sessionId) {
      localStorage.setItem(SELECTED_SESSION_STORAGE_KEY, sessionId);
    } else {
      localStorage.removeItem(SELECTED_SESSION_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable in some embeds.
  }
});

const DEFAULT_SESSION_PAGE_SIZE = 50;
const MAX_SESSION_PAGE_SIZE = 200;

let _wsListenerReady = false;

/** Track the last filter used so createSession can reload with the same filter */
let _lastLoadFilter = {};
let _sessionRetryTimer = null;

function clearSessionRetryTimer() {
  if (_sessionRetryTimer) {
    clearTimeout(_sessionRetryTimer);
    _sessionRetryTimer = null;
  }
}

function scheduleSessionRetry(meta) {
  clearSessionRetryTimer();
  const nextRetryAt = Date.parse(String(meta?.nextRetryAt || ""));
  if (!Number.isFinite(nextRetryAt)) return;
  const delayMs = Math.max(0, nextRetryAt - Date.now());
  _sessionRetryTimer = setTimeout(() => {
    _sessionRetryTimer = null;
    loadSessions(_lastLoadFilter, { source: "retry" }).catch(() => {});
  }, delayMs);
}

function sessionPath(id, action = "") {
  const session = (sessionsData.peek() || []).find((entry) => entry?.id === id) || null;
  const workspace = resolveSessionWorkspaceHint(
    session,
    String(_lastLoadFilter?.workspace || "").trim() || "active",
  );
  return buildSessionApiPath(id, action, { workspace });
}

function clearUnavailableSelectedSession(targetSessionId) {
  const normalizedTargetSessionId = String(targetSessionId || "").trim();
  if (!normalizedTargetSessionId) return;
  if (String(selectedSessionId.peek() || "").trim() === normalizedTargetSessionId) {
    selectedSessionId.value = null;
  }
  if (String(sessionMessagesSessionId.peek() || "").trim() === normalizedTargetSessionId) {
    sessionMessagesSessionId.value = "";
    sessionMessages.value = [];
    sessionPagination.value = null;
  }
}

/* ─── Data loaders ─── */
export async function loadSessions(filter = {}, _opts = {}) {
  const normalizedFilter = {
    ...(filter && typeof filter === "object" ? filter : {}),
  };
  if (!Object.prototype.hasOwnProperty.call(normalizedFilter, "workspace")) {
    normalizedFilter.workspace = "active";
  }
  _lastLoadFilter = normalizedFilter;
  sessionsLoading.value = true;
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(normalizedFilter)) {
      if (value == null || value === "") continue;
      params.set(key, String(value));
    }
    const currentSelectedSessionId = String(selectedSessionId.value || "").trim();
    const previousSessionIds = new Set(
      (sessionsData.peek() || []).map((session) => String(session?.id || "")).filter(Boolean),
    );
    const res = await apiFetch(`/api/sessions?${params}`, { _silent: true });
    if (res?.sessions) {
      sessionsData.value = res.sessions;
      const sessionIds = new Set(
        res.sessions.map((session) => String(session?.id || "")).filter(Boolean),
      );
      const workspaceScope = String(normalizedFilter.workspace || "active").trim().toLowerCase();
      const shouldRetainScopedSelection =
        Boolean(currentSelectedSessionId) &&
        workspaceScope !== "all" &&
        previousSessionIds.has(currentSelectedSessionId) &&
        !sessionIds.has(currentSelectedSessionId);
      const selectedSessionStillExists =
        !currentSelectedSessionId ||
        sessionIds.has(currentSelectedSessionId) ||
        shouldRetainScopedSelection;
      selectedSessionId.value = selectedSessionStillExists ? currentSelectedSessionId : null;
    }
    clearSessionRetryTimer();
    const responseMeta = createSessionLoadMeta({
      ...sessionLoadMeta.peek(),
      ...(res?.loadMeta && typeof res.loadMeta === "object" ? res.loadMeta : {}),
    });
    sessionLoadMeta.value = markSessionLoadSuccess(
      responseMeta,
      responseMeta.lastSuccessAt || Date.now(),
    );
    sessionsError.value = null;
    return Array.isArray(res?.sessions) ? res.sessions : [];
  } catch (error) {
    const nextMeta = markSessionLoadFailure(sessionLoadMeta.peek(), Date.now(), {
      staleReason: deriveSessionStaleReason(error),
    });
    sessionLoadMeta.value = nextMeta;
    scheduleSessionRetry(nextMeta);
    const nextErrorState = classifySessionRequestError(error);
    const hasCachedData = Array.isArray(sessionsData.peek()) && sessionsData.peek().length > 0;
    sessionsError.value = hasCachedData ? null : nextErrorState;
    return null;
  } finally {
    sessionsLoading.value = false;
  }
}

function _bindSessionStore(targetId, messages, pagination) {
  if (String(selectedSessionId.value || "") !== String(targetId)) return;
  sessionMessagesSessionId.value = targetId;
  sessionMessages.value = messages;
  sessionPagination.value = pagination;
}

export async function loadSessionMessages(id, opts = {}) {
  const targetSessionId = String(id || "").trim();
  if (!targetSessionId) return { ok: false, error: "invalid" };

  const buildMessagesUrl = (path, limit, offset) => {
    try {
      const parsed = new URL(path, globalThis.location?.origin || "http://localhost");
      parsed.searchParams.set("limit", String(limit));
      if (offset != null) {
        parsed.searchParams.set("offset", String(offset));
      }
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      const join = path.includes("?") ? "&" : "?";
      const parts = [`limit=${encodeURIComponent(String(limit))}`];
      if (offset != null) {
        parts.push(`offset=${encodeURIComponent(String(offset))}`);
      }
      return `${path}${join}${parts.join("&")}`;
    }
  };
  const fetchSessionAtPath = async (path, limit, offset) => {
    const url = buildMessagesUrl(path, limit, offset);
    return apiFetch(url, { _silent: true });
  };
  try {
    const baseUrl = sessionPath(targetSessionId);
    if (!baseUrl) return { ok: false, error: "invalid" };
    const requestedLimit = opts.limit != null ? Number(opts.limit) : DEFAULT_SESSION_PAGE_SIZE;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), MAX_SESSION_PAGE_SIZE)
        : DEFAULT_SESSION_PAGE_SIZE;
    const fallbackUrl = buildSessionApiPath(id, "", { workspace: "all" });
    let res;
    try {
      res = await fetchSessionAtPath(baseUrl, limit, opts.offset);
    } catch (err) {
      const shouldRetryAll = shouldFallbackToAllSessions(err, baseUrl, fallbackUrl);
      if (!shouldRetryAll) throw err;
      res = await fetchSessionAtPath(fallbackUrl, limit, opts.offset);
    }
    if (res?.session) {
      const normalized = dedupeMessages(res.session.messages || []);
      const sameBoundSession =
        String(sessionMessagesSessionId.value || "") === targetSessionId;
      if (opts.prepend && sameBoundSession && sessionMessages.value?.length) {
        // Prepend older messages (loading history on scroll up)
        const merged = dedupeMessages([...normalized, ...sessionMessages.value]);
        _bindSessionStore(targetSessionId, merged, res.pagination || null);
      } else {
        _bindSessionStore(targetSessionId, normalized, res.pagination || null);
      }
      return { ok: true, messages: normalized, pagination: res.pagination || null };
    }
    if (!opts.prepend) {
      _bindSessionStore(targetSessionId, [], res?.pagination || null);
      sessionMessagesSessionId.value = targetSessionId;
    }
    return { ok: false, error: "empty" };
  } catch (error) {
    const errorState = classifySessionRequestError(error);
    if (errorState.isNotFound) {
      clearUnavailableSelectedSession(targetSessionId);
    }
    if (!opts.prepend) {
      _bindSessionStore(targetSessionId, [], null);
      sessionMessagesSessionId.value = targetSessionId;
    }
    return { ok: false, error: errorState.isNotFound ? "not_found" : "unavailable" };
  }
}

function normalizePreview(content) {
  if (content == null) return "";
  const text =
    typeof content === "string" ? content : JSON.stringify(content);
  return text.slice(0, 100);
}

function canonicalMessageKind(msg) {
  const role = String(msg?.role || "").trim().toLowerCase();
  const type = String(msg?.type || "").trim().toLowerCase();
  if (
    role === "assistant" ||
    type === "agent_message" ||
    type === "assistant" ||
    type === "assistant_message"
  ) {
    return "assistant";
  }
  if (role === "user" || type === "user") return "user";
  if (type === "tool_call") return "tool_call";
  if (type === "tool_result" || type === "tool_output") return "tool_result";
  if (type === "error" || type === "stream_error") return "error";
  if (role === "system" || type === "system") return "system";
  return `${role || "unknown"}:${type || "message"}`;
}

function messageBody(msg) {
  const value = msg?.content ?? msg?.text ?? "";
  return String(value || "").trim();
}

function isLifecycleSystemMessage(msg) {
  if (canonicalMessageKind(msg) !== "system") return false;
  const lifecycle = String(msg?.meta?.lifecycle || "").trim().toLowerCase();
  if (lifecycle) return true;
  const content = messageBody(msg).toLowerCase();
  if (!content) return true;
  return (
    content === "turn completed" ||
    content === "session completed" ||
    content === "agent is composing a response..." ||
    content === "agent is composing a response…" ||
    content.startsWith("message_stop") ||
    content.startsWith("message_delta")
  );
}

function reconnectFingerprint(content) {
  const text = String(content || "").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  if (!lower.includes("stream disconnected")) return "";
  return lower
    .replace(/reconnecting\.\.\.\s*\d+\s*\/\s*\d+/g, "reconnecting... n/n")
    .replace(/\s+/g, " ")
    .trim();
}

function isDecorativeLine(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact) return true;
  if (/^[\-=_*`~.·•]+$/.test(compact)) return true;
  if (/^[\u2500-\u257f]+$/u.test(compact)) return true;
  return false;
}

function dedupeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  const seenExact = new Set();
  const recentAssistantContentTs = new Map();
  const reconnectIndexByFingerprint = new Map();
  for (const msg of list) {
    if (!msg) continue;
    const kind = canonicalMessageKind(msg);
    const content = messageBody(msg);
    if (!content && kind !== "user") continue;
    if (isLifecycleSystemMessage(msg)) continue;
    if (kind === "system" && isDecorativeLine(content)) continue;
    if (
      kind === "assistant" &&
      content.length <= 2 &&
      !/[a-z0-9]/i.test(content)
    ) {
      continue;
    }
    const ts = Date.parse(msg.timestamp || 0) || 0;
    const exactKey = `${kind}|${content}|${ts}`;
    if (seenExact.has(exactKey)) continue;
    const reconnectKey = kind === "error" ? reconnectFingerprint(content) : "";
    const normalizedMsg =
      reconnectKey && !msg.id ? { ...msg, id: `reconnect:${reconnectKey}` } : msg;
    if (reconnectKey) {
      const existingIndex = reconnectIndexByFingerprint.get(reconnectKey);
      if (Number.isInteger(existingIndex) && existingIndex >= 0 && existingIndex < out.length) {
        const existing = out[existingIndex];
        out[existingIndex] = existing?.id
          ? { ...normalizedMsg, id: existing.id }
          : normalizedMsg;
        seenExact.add(exactKey);
        continue;
      }
    }
    if (kind === "assistant" && content) {
      while (out.length > 0 && isLifecycleSystemMessage(out[out.length - 1])) {
        out.pop();
      }
      const lastAssistant = out[out.length - 1];
      if (lastAssistant && canonicalMessageKind(lastAssistant) === "assistant") {
        const lastTs = Date.parse(lastAssistant.timestamp || 0) || 0;
        const withinStreamingWindow =
          ts > 0 && lastTs > 0 ? Math.abs(ts - lastTs) <= 120000 : true;
        if (withinStreamingWindow) {
          out[out.length - 1] = lastAssistant?.id
            ? { ...normalizedMsg, id: lastAssistant.id }
            : normalizedMsg;
          recentAssistantContentTs.set(content, ts);
          seenExact.add(exactKey);
          continue;
        }
      }
      const prevAssistantTs = recentAssistantContentTs.get(content);
      if (prevAssistantTs !== undefined) {
        const withinAssistantWindow =
          ts > 0 && prevAssistantTs > 0
            ? Math.abs(ts - prevAssistantTs) <= 5000
            : true;
        if (withinAssistantWindow) continue;
      }
    }
    const last = out[out.length - 1];
    if (last) {
      const lastKind = canonicalMessageKind(last);
      const lastContent = String(last.content || last.text || "").trim();
      const lastTs = Date.parse(last.timestamp || 0) || 0;
      const withinDuplicateWindow =
        ts > 0 && lastTs > 0 ? Math.abs(ts - lastTs) <= 5000 : true;
      if (
        content &&
        lastKind === kind &&
        lastContent === content &&
        withinDuplicateWindow
      ) {
        continue;
      }
    }
    seenExact.add(exactKey);
    out.push(normalizedMsg);
    if (reconnectKey) {
      reconnectIndexByFingerprint.set(reconnectKey, out.length - 1);
    }
    if (kind === "assistant" && content) {
      recentAssistantContentTs.set(content, ts);
    }
  }
  return out;
}

/**
 * Throttle sessionsData updates — the sidebar preview metadata
 * (lastActiveAt, preview) changes on every WS event, but the user
 * doesn't notice sub-second updates. Batch them to avoid triggering
 * cascading re-renders in the 5+ components that subscribe to
 * sessionsData. Messages (sessionMessages) are batched per-frame
 * so multiple WS events within a single animation frame cause only
 * one ChatView re-render.
 */
let _sessionUpdateTimer = null;
let _pendingSessionUpdates = new Map();

function _flushSessionUpdates() {
  _sessionUpdateTimer = null;
  if (_pendingSessionUpdates.size === 0) return;
  const sessions = sessionsData.value || [];
  const patches = _pendingSessionUpdates;
  _pendingSessionUpdates = new Map();
  const next = sessions.map((s) => {
    const patch = patches.get(s.id);
    return patch ? { ...s, ...patch } : s;
  });
  sessionsData.value = next;
}

/** Per-frame message batching for sessionMessages */
let _msgBatchBuffer = [];
let _msgBatchRaf = null;

function _flushMessageBatch() {
  _msgBatchRaf = null;
  if (_msgBatchBuffer.length === 0) return;
  const batch = _msgBatchBuffer;
  _msgBatchBuffer = [];
  const selectedId = String(selectedSessionId.value || "");
  if (!selectedId) return;
  const boundId = String(sessionMessagesSessionId.value || "");
  if (boundId && boundId !== selectedId) return;
  if (!boundId) sessionMessagesSessionId.value = selectedId;
  const current = Array.isArray(sessionMessages.value) ? sessionMessages.value : [];
  const merged = dedupeMessages([...current, ...batch]);
  if (merged.length !== current.length) {
    sessionMessages.value = merged;
  }
}

function appendSessionMessage(sessionId, message, sessionMeta) {
  if (!sessionId || !message) return;

  // ── Batch sessionsData sidebar updates (throttled to ~500ms) ──
  const sessions = sessionsData.value || [];
  const existing = sessions.find((s) => s.id === sessionId);
  if (existing) {
    const preview = normalizePreview(message.content || message.text || "");
    const lastActiveAt = message.timestamp || sessionMeta?.lastActiveAt || new Date().toISOString();
    const turnCount = Math.max(existing.turnCount || 0, sessionMeta?.turnCount || 0);
    // Only schedule an update if something actually changed
    if (existing.preview !== preview || existing.turnCount !== turnCount) {
      _pendingSessionUpdates.set(sessionId, { preview, lastMessage: preview, lastActiveAt, turnCount });
      if (!_sessionUpdateTimer) {
        _sessionUpdateTimer = setTimeout(_flushSessionUpdates, 500);
      }
    }
  }

  // ── Batch sessionMessages per animation frame ──
  if (selectedSessionId.value === sessionId) {
    _msgBatchBuffer.push(message);
    if (!_msgBatchRaf) {
      _msgBatchRaf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(_flushMessageBatch)
        : setTimeout(_flushMessageBatch, 16);
    }
  }
}

export function initSessionWsListener() {
  if (_wsListenerReady) return;
  _wsListenerReady = true;
  onWsMessage((msg) => {
    if (msg?.type === "session-message") {
      const payload = msg.payload || {};
      const sessionId = payload.sessionId || payload.taskId;
      if (!sessionId) return;
      appendSessionMessage(sessionId, payload.message, payload.session);
      return;
    }
    if (msg?.type === "invalidate") {
      const channels = Array.isArray(msg.channels) ? msg.channels : [];
      if (channels.includes("*") || channels.includes("sessions")) {
        loadSessions(_lastLoadFilter).catch(() => {});
      }
    }
  });
}

/**
 * Create a new session — but first check if there's already an empty/fresh
 * session of the same type. If so, just select it instead of creating a dupe.
 */
export async function createSession(options = {}) {
  const type = options?.type || "manual";
  const allowReuseFresh = options?.reuseFresh !== false;

  // Duplicate prevention: if a fresh empty session of same type exists, reuse it
  const existing = sessionsData.value || [];
  if (allowReuseFresh) {
    const fresh = existing.find(
      (s) =>
        s.type === type &&
        getSessionLifecycleState(s).isActive &&
        (s.turnCount || 0) === 0 &&
        (!s.preview || s.preview.trim() === ""),
    );
    if (fresh) {
      selectedSessionId.value = fresh.id;
      return { ok: true, session: fresh };
    }
  }

  try {
    const body = options && Object.keys(options).length > 0 ? options : null;
    const res = await apiFetch("/api/sessions/create", {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res?.session?.id) {
      // Reload with the SAME filter the parent component uses
      await loadSessions(_lastLoadFilter);
      selectedSessionId.value = res.session.id;
    }
    return res;
  } catch {
    return null;
  }
}

/* ─── Session actions ─── */
export async function archiveSession(id) {
  try {
    const url = sessionPath(id, "archive");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function deleteSession(id) {
  try {
    const url = sessionPath(id, "delete");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function deleteSessionHistory(id) {
  try {
    const historyUrl = sessionPath(id, "delete-history");
    const fallbackUrl = sessionPath(id, "delete");
    const url = historyUrl || fallbackUrl;
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    clearUnavailableSelectedSession(id);
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function resumeSession(id) {
  try {
    const url = sessionPath(id, "resume");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function revealSessionFolder(id) {
  try {
    const url = sessionPath(id, "reveal");
    if (!url) return null;
    const response = await apiFetch(url, { method: "POST" });
    return response?.path || null;
  } catch {
    return null;
  }
}

export async function reopenSessionHistory(id, opts = {}) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return false;
  selectedSessionId.value = normalizedId;
  const loadResult = await loadSessionMessages(normalizedId, {
    limit: Number.isFinite(Number(opts?.limit)) ? Number(opts.limit) : DEFAULT_SESSION_PAGE_SIZE,
  });
  return loadResult?.ok !== false;
}

/* ─── Helpers ─── */
const STATUS_TONE_COLOR_MAP = {
  success: "var(--color-done)",
  info: "var(--accent)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  default: "var(--text-hint)",
};

export const SESSION_VIEW_FILTER = Object.freeze({
  all: "all",
  active: "active",
  historic: "historic",
});

function normalizeSessionViewFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === SESSION_VIEW_FILTER.active) return SESSION_VIEW_FILTER.active;
  if (normalized === SESSION_VIEW_FILTER.historic) return SESSION_VIEW_FILTER.historic;
  return SESSION_VIEW_FILTER.all;
}

function getSessionStatusKey(session) {
  return getSessionLifecycleState(session).key;
}

function isInProgressSession(session) {
  const lifecycle = getSessionLifecycleState(session);
  if (!lifecycle.isActive) return false;
  const runtime = getSessionRuntimeState(session);
  return runtime.isLive || runtime.key === "running" || runtime.key === "queued";
}

function isHistoricSession(session) {
  return !isInProgressSession(session);
}

/* ─── Swipeable Session Item ─── */
function SwipeableSessionItem({
  session: s,
  isSelected,
  isRenaming,
  onSelect,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onArchive,
  onDelete,
  onResume,
  onContextMenu,
  showActions,
  onToggleActions,
}) {
  const dragRef = useRef(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const [offset, setOffset] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const title = s.title || s.taskId || "Untitled";
  const isArchived = s.status === "archived";

  const lifecycleState = getSessionLifecycleState(s);
  const runtimeState = getSessionRuntimeState(s);
  const historyState = getSessionHistoryState(s);
  const recencyAt = getSessionRecencyTimestamp(s);
  const typeLabel = String(s.type || "session").trim().replace(/[-_]+/g, " ");
  const typeSummary = typeLabel
    ? typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)
    : "Session";
  const workspaceLabel = String(
    s?.surface?.repository?.selected?.displayName
    || s?.surface?.repository?.selected?.name
    || s?.metadata?.selectedRepoName
    || s?.metadata?.workspaceDir
    || s?.workspaceDir
    || "",
  ).trim();
  const dotColor = STATUS_TONE_COLOR_MAP[runtimeState.tone] || STATUS_TONE_COLOR_MAP[lifecycleState.tone] || "var(--text-hint)";
  const preview = s.lastMessage && !isArchived ? truncate(s.lastMessage, 36) : "";
  const metaSummary = [
    `Type: ${typeSummary}`,
    `Lifecycle: ${lifecycleState.label}`,
    `Runtime: ${runtimeState.label}`,
    historyState.isHistoric ? `History: ${historyState.label}` : "",
    workspaceLabel ? `Folder: ${truncate(workspaceLabel, 28)}` : "",
    preview || "",
  ]
    .filter(Boolean)
    .join(" · ");
  const freshnessLabel = recencyAt ? formatRelative(recencyAt) : "unknown";

  /* ── Touch / pointer swipe handling ── */
  function onPointerDown(e) {
    // Don't capture on action buttons
    if (e.target.closest(".session-actions")) return;
    startX.current = e.clientX || e.touches?.[0]?.clientX || 0;
    currentX.current = startX.current;
    swiping.current = true;
  }

  function onPointerMove(e) {
    if (!swiping.current) return;
    const x = e.clientX || e.touches?.[0]?.clientX || 0;
    currentX.current = x;
    const dx = x - startX.current;
    // Only allow left swipe (negative), cap at -140
    if (dx < 0) {
      setOffset(Math.max(dx, -140));
    } else {
      setOffset(0);
    }
  }

  function onPointerUp() {
    swiping.current = false;
    if (offset < -50) {
      // Snap open to reveal actions
      setOffset(-140);
      if (onToggleActions) onToggleActions(s.id);
    } else {
      setOffset(0);
    }
  }

  // Close swipe if another item opened
  useEffect(() => {
    if (showActions !== s.id && offset !== 0) {
      setOffset(0);
    }
  }, [showActions]);

  // Close delete confirm when actions close
  useEffect(() => {
    if (showActions !== s.id) setConfirmDelete(false);
  }, [showActions]);

  function handleDelete(e) {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(s.id);
    setOffset(0);
  }

  function handleArchive(e) {
    e.stopPropagation();
    onArchive(s.id);
    setOffset(0);
  }

  function handleResume(e) {
    e.stopPropagation();
    onResume(s.id);
    setOffset(0);
  }

  function handleRename(e) {
    e.stopPropagation();
    if (onStartRename) onStartRename(s.id);
    setOffset(0);
  }

  return html`
    <${Box}
      key=${s.id}
      sx=${{ position: "relative", overflow: "hidden" }}
      class="session-item-wrapper ${showActions === s.id ? "actions-revealed" : ""}"
    >
      <!-- Swipe-reveal action buttons behind the item -->
      <${Stack}
        direction="row"
        spacing=${1}
        sx=${{
          position: "absolute", right: 0, top: 0, bottom: 0,
          display: "flex", alignItems: "center", px: 0.5, zIndex: 0,
        }}
      >
        ${isArchived
          ? html`
              <${Tooltip} title="Unarchive">
                <${IconButton}
                  size="small"
                  color="primary"
                  onClick=${handleResume}
                >
                  ${resolveIcon(":workflow:")}
                </${IconButton}>
              </${Tooltip}>
            `
          : html`
              <${Tooltip} title="Edit title">
                <${IconButton}
                  size="small"
                  color="default"
                  onClick=${handleRename}
                >
                  ${resolveIcon(":edit:")}
                </${IconButton}>
              </${Tooltip}>
              <${Tooltip} title="Archive session">
                <${IconButton}
                  size="small"
                  color="warning"
                  onClick=${handleArchive}
                >
                  ${resolveIcon(":box:")}
                </${IconButton}>
              </${Tooltip}>
            `}
        <${Tooltip} title=${confirmDelete ? "Confirm delete" : "Delete session"}>
          <${IconButton}
            size="small"
            color=${confirmDelete ? "error" : "default"}
            onClick=${handleDelete}
          >
            ${resolveIcon(confirmDelete ? ":alert:" : ":trash:")}
          </${IconButton}>
        </${Tooltip}>
      </${Stack}>

      <!-- The actual session item (slides left on swipe) -->
      <${Box}
        sx=${{
          position: "relative", zIndex: 1, bgcolor: "background.paper",
          transform: `translateX(${offset}px)`,
          transition: swiping.current ? "none" : "transform 0.2s ease",
        }}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${() => { swiping.current = false; setOffset(0); }}
        onDblClick=${(e) => {
          if (onStartRename) { e.stopPropagation(); onStartRename(s.id); }
        }}
      >
        <${ListItemButton}
          selected=${isSelected}
          onClick=${() => {
            if (Math.abs(offset) > 10) return;
            if (showActions === s.id) { onToggleActions(null); setOffset(0); return; }
            onSelect(s.id);
          }}
          onContextMenu=${(e) => {
            if (typeof onContextMenu === "function") {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(s.id, e);
            }
          }}
          sx=${{
            borderRadius: 1, opacity: isArchived ? 0.6 : 1,
            py: 0.75, px: 1.5,
          }}
        >
          <${ListItemIcon} sx=${{ minWidth: 24 }}>
            <${Box}
              sx=${{
                width: 8, height: 8, borderRadius: "50%",
                bgcolor: dotColor, flexShrink: 0,
              }}
            />
          </${ListItemIcon}>
          ${isRenaming && onSaveRename && onCancelRename
            ? html`
                <${TextField}
                  size="small"
                  variant="standard"
                  defaultValue=${title}
                  autoFocus
                  fullWidth
                  onClick=${(e) => e.stopPropagation()}
                  onKeyDown=${(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = e.target.value.trim();
                      if (v && v !== title) onSaveRename(s.id, v);
                      else onCancelRename();
                    }
                    if (e.key === "Escape") onCancelRename();
                  }}
                  onBlur=${(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== title) onSaveRename(s.id, v);
                    else onCancelRename();
                  }}
                  inputRef=${(el) => {
                    if (el) { el.focus(); el.select(); }
                  }}
                  sx=${{ mr: 1 }}
                />
              `
            : html`
                <${ListItemText}
                  primary=${truncate(title, 32)}
                  secondary=${metaSummary}
                  primaryTypographyProps=${{
                    variant: "body2",
                    fontWeight: isSelected ? 600 : 400,
                    noWrap: true,
                  }}
                  secondaryTypographyProps=${{
                    variant: "caption",
                    noWrap: true,
                  }}
                />
              `}
          <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ ml: "auto", flexShrink: 0, pl: 1 }}>
            <${Typography} variant="caption" color="text.secondary" noWrap>
              Freshness: ${freshnessLabel}
            </${Typography}>
            <${Tooltip} title="Actions">
              <${IconButton}
                size="small"
                onClick=${(e) => {
                  e.stopPropagation();
                  if (onToggleActions) { onToggleActions(s.id); setOffset(-140); }
                }}
                sx=${{ p: 0.25 }}
              >
                ${resolveIcon(":menu:")}
              </${IconButton}>
            </${Tooltip}>
          </${Stack}>
        </${ListItemButton}>
      </${Box}>
    </${Box}>
  `;
}

/* ─── SessionList component ─── */
export function SessionList({
  onSelect,
  showArchived = true,
  onToggleArchived,
  sessionView = SESSION_VIEW_FILTER.all,
  onSessionViewChange,
  defaultType = null,
  renamingSessionId = null,
  onStartRename,
  onSaveRename,
  onCancelRename,
}) {
  const [search, setSearch] = useState("");
  const [revealedActions, setRevealedActions] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [uncontrolledSessionView, setUncontrolledSessionView] = useState(
    normalizeSessionViewFilter(sessionView),
  );
  const allSessions = sessionsData.value || [];
  const loadMeta = sessionLoadMeta.value || createSessionLoadMeta();
  const isLoadingSessions = sessionsLoading.value === true;
  const error = sessionsError.value;
  const listState = getSessionListState({
    sessions: allSessions,
    error,
    loadMeta,
  });
  const showStaleBanner = listState.key === "stale";
  const [retryCountdownNow, setRetryCountdownNow] = useState(() => Date.now());
  const hasSearch = search.trim().length > 0;
  const resolvedSessionView =
    typeof onSessionViewChange === "function"
      ? normalizeSessionViewFilter(sessionView)
      : uncontrolledSessionView;

  useEffect(() => {
    if (typeof onSessionViewChange === "function") return;
    const normalized = normalizeSessionViewFilter(sessionView);
    if (normalized !== uncontrolledSessionView) {
      setUncontrolledSessionView(normalized);
    }
  }, [onSessionViewChange, sessionView, uncontrolledSessionView]);

  useEffect(() => {
    if (!showStaleBanner || !loadMeta.nextRetryAt || loadMeta.retriesExhausted) return undefined;
    const interval = setInterval(() => {
      setRetryCountdownNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [showStaleBanner, loadMeta.nextRetryAt, loadMeta.retriesExhausted]);

  const setSessionView = useCallback(
    (nextFilter) => {
      const normalized = normalizeSessionViewFilter(nextFilter);
      if (typeof onSessionViewChange === "function") {
        onSessionViewChange(normalized);
      } else {
        setUncontrolledSessionView(normalized);
      }
    },
    [onSessionViewChange],
  );

  // Filter by defaultType to exclude ghost sessions (e.g. task sessions in Chat tab)
  const typeFiltered = defaultType
    ? allSessions.filter((s) => {
        const t = (s.type || "").toLowerCase();
        if (defaultType === "primary") {
          // Show primary, manual, and untyped sessions — exclude task/review
          return t !== "task" && t !== "review";
        }
        if (defaultType === "task") {
          return t === "task";
        }
        return t === defaultType.toLowerCase();
      })
    : allSessions;

  const archivedFiltered = showArchived
    ? typeFiltered
    : typeFiltered.filter((s) => getSessionStatusKey(s) !== "archived");

  const viewFiltered = archivedFiltered.filter((s) => {
    if (resolvedSessionView === SESSION_VIEW_FILTER.active) {
      return isInProgressSession(s);
    }
    if (resolvedSessionView === SESSION_VIEW_FILTER.historic) {
      return isHistoricSession(s);
    }
    return true;
  });

  const filtered = search
    ? viewFiltered.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(search.toLowerCase()) ||
          (s.taskId || "").toLowerCase().includes(search.toLowerCase()),
      )
    : viewFiltered;

  const active = filtered.filter((s) => isInProgressSession(s));
  const archived = filtered.filter((s) => getSessionStatusKey(s) === "archived");
  const recent = filtered.filter(
    (s) =>
      !isInProgressSession(s) && getSessionStatusKey(s) !== "archived",
  );

  const archivedCount = typeFiltered.filter((s) => getSessionStatusKey(s) === "archived").length;
  const allCount = archivedFiltered.length;
  const activeCount = archivedFiltered.filter((s) => isInProgressSession(s)).length;
  const historicCount = archivedFiltered.filter((s) => isHistoricSession(s)).length;
  const reopenableHistoryCount = archivedFiltered.filter((s) => getSessionHistoryState(s).canReopenTranscript).length;
  const revealableHistoryCount = archivedFiltered.filter((s) => getSessionHistoryState(s).canRevealFolder).length;

  const handleSelect = useCallback(
    (id) => {
      selectedSessionId.value = id;
      setRevealedActions(null);
      setContextMenu(null);
      if (onSelect) onSelect(id);
    },
    [onSelect],
  );

  const handleRetry = useCallback(() => {
    const manualRetryState = getSessionManualRetryState(sessionLoadMeta.peek(), {
      now: Date.now(),
      isLoading: sessionsLoading.peek() === true,
    });
    if (manualRetryState.disabled) return;
    clearSessionRetryTimer();
    sessionsError.value = null;
    loadSessions(_lastLoadFilter, { source: "manual-retry" });
  }, []);

  const handleCreateSession = useCallback(() => {
    if (resolvedSessionView === SESSION_VIEW_FILTER.historic) {
      setSessionView(SESSION_VIEW_FILTER.all);
    }
    createSession(defaultType ? { type: defaultType } : {});
  }, [defaultType, resolvedSessionView, setSessionView]);

  const handleArchive = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    await archiveSession(id);
  }, []);

  const handleDelete = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    await deleteSession(id);
  }, []);

  const handleResume = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    await resumeSession(id);
  }, []);

  const handleReopenHistory = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    const reopened = await reopenSessionHistory(id);
    if (!reopened) {
      showToast("Could not reopen session history", "error");
      return;
    }
    if (onSelect) onSelect(id);
  }, [onSelect]);

  const handleRevealFolder = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    const revealedPath = await revealSessionFolder(id);
    if (!revealedPath) {
      showToast("Session folder is not available", "error");
      return;
    }
    showToast("Opened session folder", "success");
  }, []);

  const handleDeleteHistory = useCallback(async (id) => {
    setRevealedActions(null);
    setContextMenu(null);
    const deleted = await deleteSessionHistory(id);
    if (!deleted) {
      showToast("Could not delete session history", "error");
      return;
    }
    showToast("Session history deleted", "success");
  }, []);

  const handleContextMenu = useCallback((id, event) => {
    setRevealedActions(null);
    setContextMenu({
      id,
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleContextAction = useCallback(async (action) => {
    const targetId = contextMenu?.id;
    if (!targetId) {
      closeContextMenu();
      return;
    }
    const currentSession = (sessionsData.value || []).find((item) => item.id === targetId);
    const historyState = getSessionHistoryState(currentSession);
    if (action === "open") {
      handleSelect(targetId);
      closeContextMenu();
      return;
    }
    if (action === "reopen") {
      closeContextMenu();
      await handleReopenHistory(targetId);
      return;
    }
    if (action === "rename") {
      closeContextMenu();
      if (typeof onStartRename === "function") onStartRename(targetId);
      return;
    }
    if (action === "archive") {
      closeContextMenu();
      if (currentSession?.status === "archived") {
        await handleResume(targetId);
      } else {
        await handleArchive(targetId);
      }
      return;
    }
    if (action === "delete") {
      closeContextMenu();
      await handleDelete(targetId);
      return;
    }
    if (action === "reveal") {
      closeContextMenu();
      await handleRevealFolder(targetId);
      return;
    }
    if (action === "delete-history") {
      closeContextMenu();
      await handleDeleteHistory(targetId);
      return;
    }
    if (action === "copy-id") {
      closeContextMenu();
      try {
        await navigator.clipboard.writeText(String(targetId));
      } catch {
        /* ignore clipboard errors */
      }
      return;
    }
    closeContextMenu();
  }, [
    closeContextMenu,
    contextMenu?.id,
    handleArchive,
    handleDelete,
    handleDeleteHistory,
    handleRevealFolder,
    handleReopenHistory,
    handleResume,
    handleSelect,
    onStartRename,
  ]);

  // Close revealed actions when clicking the list background
  const handleListClick = useCallback((e) => {
    if (e.target.closest(".session-item-wrapper")) return;
    setRevealedActions(null);
    setContextMenu(null);
  }, []);

  const emptyTitle = hasSearch
    ? "No matching sessions"
    : resolvedSessionView === SESSION_VIEW_FILTER.active
      ? "No in-progress sessions"
      : resolvedSessionView === SESSION_VIEW_FILTER.historic
        ? "No historic sessions"
        : "No sessions yet";
  const emptyHint = hasSearch
    ? "Try a different keyword or clear the search."
    : resolvedSessionView === SESSION_VIEW_FILTER.active
      ? "Sessions with live work appear here."
      : resolvedSessionView === SESSION_VIEW_FILTER.historic
        ? "Historic sessions appear after they finish."
        : "Create a session to get started.";

  /* ── Render session items ── */
  function renderSessionItem(s) {
    return html`
      <${SwipeableSessionItem}
        key=${s.id}
        session=${s}
        isSelected=${selectedSessionId.value === s.id}
        isRenaming=${renamingSessionId === s.id}
        onSelect=${handleSelect}
        onStartRename=${onStartRename}
        onSaveRename=${onSaveRename}
        onCancelRename=${onCancelRename}
        onArchive=${handleArchive}
        onDelete=${handleDelete}
        onResume=${handleResume}
        onContextMenu=${handleContextMenu}
        showActions=${revealedActions}
        onToggleActions=${setRevealedActions}
      />
    `;
  }

  const nextRetryMs = Date.parse(String(loadMeta.nextRetryAt || ""));
  const retrySeconds =
    Number.isFinite(nextRetryMs) && !loadMeta.retriesExhausted
      ? Math.max(0, Math.ceil((nextRetryMs - retryCountdownNow) / 1000))
      : 0;
  const retryAttemptDisplay = Math.min(loadMeta.retryAttempt || 0, loadMeta.maxAttempts || 0);
  const manualRetryState = getSessionManualRetryState(loadMeta, {
    now: retryCountdownNow,
    isLoading: isLoadingSessions,
  });
  const lastSuccessLabel = formatSessionFreshnessTimestamp(loadMeta.lastSuccessAt, {
    formatRelative,
    formatDate,
  });
  const staleReasonLabel =
    loadMeta.staleReasonLabel || loadMeta.staleReasonMeta?.label || "Refresh request failed";
  const staleReasonText =
    loadMeta.staleReason || "Last refresh failed before new session data could be loaded.";
  const staleReasonSummary = staleReasonText
    ? `${staleReasonLabel}: ${staleReasonText}`
    : staleReasonLabel;
  const manualRetryReasonText =
    manualRetryState.reason ||
    (manualRetryState.disabled && retrySeconds > 0
      ? "Manual retry is disabled while automatic backoff is active."
      : "");

  if (listState.isError && !showStaleBanner) {
    return html`
      <${Paper} elevation=${0} sx=${{ height: "100%", display: "flex", flexDirection: "column" }}>
        <${Box} sx=${{ p: 1.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <${Typography} variant="subtitle2">Sessions</${Typography}>
        </${Box}>
        <${Divider} />
        <${Box} sx=${{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", p: 3, gap: 1.5 }}>
          <${Alert} severity=${listState.key === "not_found" ? "info" : "error"} variant="outlined" sx=${{ mb: 1 }}>
            ${listState.message || "Sessions not available"}
          </${Alert}>
          <${Button}
            variant="outlined"
            size="small"
            onClick=${handleRetry}
            disabled=${manualRetryState.disabled}
          >
            ${manualRetryState.label || "Retry now"}
          </${Button}>
        </${Box}>
      </${Paper}>
    `;
  }

  return html`
    <${Paper}
      elevation=${0}
      sx=${{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
      onClick=${handleListClick}
    >
      <!-- Header -->
      <${Box} sx=${{ p: 1.5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <${Typography} variant="subtitle2">Sessions</${Typography}>
        <${Stack} direction="row" spacing=${0.75} alignItems="center">
          ${typeof onToggleArchived === "function" &&
          archivedCount > 0 &&
          html`
            <${Button}
              size="small"
              variant="text"
              onClick=${() => onToggleArchived(!showArchived)}
              sx=${{ textTransform: "none", fontSize: "0.75rem" }}
            >
              ${showArchived
                ? `Hide Archived (${archivedCount})`
                : `Show Archived (${archivedCount})`}
            </${Button}>
          `}
          <${Button}
            size="small"
            variant="outlined"
            onClick=${handleCreateSession}
            sx=${{ textTransform: "none" }}
          >
            + New
          </${Button}>
        </${Stack}>
      </${Box}>

      ${showStaleBanner &&
      html`
        <${Box} sx=${{ px: 1.5, pb: 1 }}>
          <${Alert}
            severity="warning"
            variant="outlined"
            action=${html`
              <${Button}
                size="small"
                color="warning"
                onClick=${handleRetry}
                disabled=${manualRetryState.disabled}
              >
                ${manualRetryState.label || "Retry now"}
              </${Button}>
            `}
          >
            <${Typography} variant="body2" sx=${{ fontWeight: 600 }}>
              Session list is showing stale data.
            </${Typography}>
            <${Typography} variant="caption" component="div">
              Last successful refresh: ${lastSuccessLabel}
            </${Typography}>
            <${Typography} variant="caption" component="div">
              Freshness: cached data is being shown until the next successful refresh.
            </${Typography}>
            <${Typography} variant="caption" component="div">
              Reason: ${staleReasonSummary}
            </${Typography}>
            <${Typography} variant="caption" component="div">
              ${loadMeta.retriesExhausted
                ? `Automatic retries stopped after ${loadMeta.maxAttempts} attempts.`
                : `Retry ${retryAttemptDisplay}/${loadMeta.maxAttempts} in ${retrySeconds}s.`}
            </${Typography}>
            ${manualRetryReasonText
              ? html`
                  <${Typography} variant="caption" component="div">
                    ${manualRetryReasonText}
                  </${Typography}>
                `
              : null}
          </${Alert}>
        </${Box}>
      `}

      <!-- Search bar -->
      <${Box} sx=${{ px: 1.5, pb: 1 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder="Search sessions…"
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
          InputProps=${{
            startAdornment: html`
              <${InputAdornment} position="start">
                <${Typography} variant="caption" sx=${{ opacity: 0.5 }}>🔍</${Typography}>
              </${InputAdornment}>
            `,
          }}
          sx=${{
            "& .MuiInputBase-root": { height: 34, fontSize: "0.85rem" },
          }}
        />
      </${Box}>

      <!-- Filter chips -->
      <${Stack} direction="row" spacing=${0.75} sx=${{ px: 1.5, pb: 1, flexWrap: "wrap" }}>
        <${Chip}
          label=${`All (${allCount})`}
          size="small"
          variant=${resolvedSessionView === SESSION_VIEW_FILTER.all ? "filled" : "outlined"}
          color=${resolvedSessionView === SESSION_VIEW_FILTER.all ? "primary" : "default"}
          onClick=${() => setSessionView(SESSION_VIEW_FILTER.all)}
          clickable
        />
        <${Chip}
          label=${`In Progress (${activeCount})`}
          size="small"
          variant=${resolvedSessionView === SESSION_VIEW_FILTER.active ? "filled" : "outlined"}
          color=${resolvedSessionView === SESSION_VIEW_FILTER.active ? "primary" : "default"}
          onClick=${() => setSessionView(SESSION_VIEW_FILTER.active)}
          clickable
        />
        <${Chip}
          label=${`Historic (${historicCount})`}
          size="small"
          variant=${resolvedSessionView === SESSION_VIEW_FILTER.historic ? "filled" : "outlined"}
          color=${resolvedSessionView === SESSION_VIEW_FILTER.historic ? "primary" : "default"}
          onClick=${() => setSessionView(SESSION_VIEW_FILTER.historic)}
          clickable
        />
      </${Stack}>

      <${Box} sx=${{ px: 1.5, pb: 1 }}>
        <${Typography} variant="caption" color="text.secondary">
          History ready: ${reopenableHistoryCount} reopenable sessions · ${revealableHistoryCount} folders available
        </${Typography}>
      </${Box}>

      <${Divider} />

      <!-- Session list scroll area -->
      <${Box} sx=${{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
        <${List} dense disablePadding>
          ${active.length > 0 &&
          html`
            <${ListItem} disablePadding sx=${{ px: 1.5, pt: 1.5, pb: 0.5 }}>
              <${Typography} variant="overline" color="text.secondary" sx=${{ fontSize: "0.65rem", letterSpacing: 1 }}>
                In Progress
              </${Typography}>
            </${ListItem}>
            ${active.map(renderSessionItem)}
          `}
          ${active.length > 0 && recent.length > 0 && html`<${Divider} sx=${{ my: 0.5 }} />`}
          ${recent.length > 0 &&
          html`
            <${ListItem} disablePadding sx=${{ px: 1.5, pt: 1, pb: 0.5 }}>
              <${Typography} variant="overline" color="text.secondary" sx=${{ fontSize: "0.65rem", letterSpacing: 1 }}>
                Recent
              </${Typography}>
            </${ListItem}>
            ${recent.map(renderSessionItem)}
          `}
          ${(active.length > 0 || recent.length > 0) && archived.length > 0 && html`<${Divider} sx=${{ my: 0.5 }} />`}
          ${archived.length > 0 &&
          html`
            <${ListItem} disablePadding sx=${{ px: 1.5, pt: 1, pb: 0.5 }}>
              <${Typography} variant="overline" color="text.secondary" sx=${{ fontSize: "0.65rem", letterSpacing: 1 }}>
                Archived (${archived.length})
              </${Typography}>
            </${ListItem}>
            ${archived.map(renderSessionItem)}
          `}
        </${List}>

        ${filtered.length === 0 &&
        html`
          <${Box} sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", p: 4, gap: 1.5, textAlign: "center" }}>
            <${Typography} variant="h5" sx=${{ opacity: 0.4 }}>${resolveIcon(":chat:")}</${Typography}>
            <${Typography} variant="body2" color="text.secondary">
              ${emptyTitle}
            </${Typography}>
            <${Typography} variant="caption" color="text.disabled">
              ${emptyHint}
            </${Typography}>
            <${Stack} direction="row" spacing=${1} sx=${{ mt: 1 }}>
              <${Button}
                variant="outlined"
                size="small"
                onClick=${handleCreateSession}
                sx=${{ textTransform: "none" }}
              >
                + New Session
              </${Button}>
              ${hasSearch &&
              html`
                <${Button}
                  variant="text"
                  size="small"
                  onClick=${() => setSearch("")}
                  sx=${{ textTransform: "none" }}
                >
                  Clear search
                </${Button}>
              `}
            </${Stack}>
          </${Box}>
        `}
      </${Box}>

      <!-- Swipe hint for mobile (shown once) -->
      ${filtered.length > 0 &&
      html`
        <${Box} sx=${{ py: 0.5, textAlign: "center" }}>
          <${Typography} variant="caption" color="text.disabled" sx=${{ fontSize: "0.65rem" }}>
            ← Swipe items for actions
          </${Typography}>
        </${Box}>
      `}

      <${Menu}
        open=${Boolean(contextMenu)}
        onClose=${closeContextMenu}
        anchorReference="anchorPosition"
        anchorPosition=${contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <${MenuItem} onClick=${() => handleContextAction("open")}>
          ${resolveIcon(":chat:")}
          ${(() => {
            const target = (sessionsData.value || []).find((item) => item.id === contextMenu?.id);
            const historyState = getSessionHistoryState(target);
            return historyState.isHistoric ? " Open transcript" : " Open";
          })()}
        </${MenuItem}>
        ${(() => {
          const target = (sessionsData.value || []).find((item) => item.id === contextMenu?.id);
          const historyState = getSessionHistoryState(target);
          return historyState.isHistoric
            ? html`<${MenuItem} onClick=${() => handleContextAction("reopen")}>${resolveIcon(":history:")} ${historyState.reopenLabel}</${MenuItem}>`
            : null;
        })()}
        <${MenuItem} onClick=${() => handleContextAction("rename")}>${resolveIcon(":edit:")} Edit title</${MenuItem}>
        <${MenuItem} onClick=${() => handleContextAction("archive")}>
          ${(() => {
            const target = (sessionsData.value || []).find((item) => item.id === contextMenu?.id);
            return target?.status === "archived"
              ? html`${resolveIcon(":workflow:")} Resume work`
              : html`${resolveIcon(":box:")} Archive`;
          })()}
        </${MenuItem}>
        ${(() => {
          const target = (sessionsData.value || []).find((item) => item.id === contextMenu?.id);
          const historyState = getSessionHistoryState(target);
          return historyState.canRevealFolder
            ? html`<${MenuItem} onClick=${() => handleContextAction("reveal")}>${resolveIcon(":folder:")} Reveal folder</${MenuItem}>`
            : null;
        })()}
        <${MenuItem} onClick=${() => handleContextAction("copy-id")}>${resolveIcon(":copy:")} Copy ID</${MenuItem}>
        <${Divider} />
        ${(() => {
          const target = (sessionsData.value || []).find((item) => item.id === contextMenu?.id);
          const historyState = getSessionHistoryState(target);
          if (historyState.canDeleteHistory) {
            return html`
              <${MenuItem} onClick=${() => handleContextAction("delete-history")} sx=${{ color: "error.main" }}>
                ${resolveIcon(":trash:")} ${historyState.deleteLabel}
              </${MenuItem}>
            `;
          }
          return html`
            <${MenuItem} onClick=${() => handleContextAction("delete")} sx=${{ color: "error.main" }}>
              ${resolveIcon(":trash:")} Delete session
            </${MenuItem}>
          `;
        })()}
      </${Menu}>
    </${Paper}>
  `;
}
