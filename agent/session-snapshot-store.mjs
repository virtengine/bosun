import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SNAPSHOT_STORE_HARD_LIMIT_BYTES = 5 * 1024 * 1024;

function truncateSnapshotString(value, maxLength = 2048) {
  const text = toTrimmedString(value);
  if (!text) return text || null;
  if (text.length <= maxLength) return text;
  const keepHead = Math.max(256, Math.floor(maxLength * 0.75));
  const keepTail = Math.max(64, maxLength - keepHead);
  return `${text.slice(0, keepHead)}… [truncated ${text.length - keepHead - keepTail} chars] ${text.slice(-keepTail)}`;
}

function summarizeSnapshotValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return truncateSnapshotString(value, 2048);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 4) {
    if (Array.isArray(value)) {
      return { _summary: "array", length: value.length };
    }
    return { _summary: "object", keys: Object.keys(value).length };
  }
  if (Array.isArray(value)) {
    const tailLimit = depth === 0 ? 12 : 8;
    const kept = value.slice(-tailLimit).map((entry) => summarizeSnapshotValue(entry, depth + 1));
    if (value.length > tailLimit) {
      kept.unshift({
        _truncated: {
          droppedEntries: value.length - tailLimit,
        },
      });
    }
    return kept;
  }
  const entries = Object.entries(value);
  const keyLimit = depth === 0 ? 24 : 16;
  const compacted = {};
  for (const [key, entry] of entries.slice(0, keyLimit)) {
    compacted[key] = summarizeSnapshotValue(entry, depth + 1);
  }
  if (entries.length > keyLimit) {
    compacted._truncated = {
      droppedKeys: entries.length - keyLimit,
    };
  }
  return compacted;
}

function withSnapshotTruncation(value, note, originalBytes = null) {
  if (!value || typeof value !== "object") return value;
  const existing = value._truncated && typeof value._truncated === "object" ? value._truncated : {};
  const existingNotes = Array.isArray(existing.notes)
    ? existing.notes.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  return {
    ...value,
    _truncated: {
      at: new Date().toISOString(),
      originalBytes: Number.isFinite(Number(originalBytes))
        ? Number(originalBytes)
        : (Number.isFinite(Number(existing.originalBytes)) ? Number(existing.originalBytes) : null),
      notes: [...new Set([...existingNotes, note])],
    },
  };
}

function compactSnapshotEntry(snapshot = {}, note, originalBytes = null) {
  return withSnapshotTruncation({
    snapshotId: toTrimmedString(snapshot.snapshotId || "") || null,
    sessionId: toTrimmedString(snapshot.sessionId || "") || null,
    runId: toTrimmedString(snapshot.runId || "") || null,
    threadId: toTrimmedString(snapshot.threadId || "") || null,
    parentSessionId: toTrimmedString(snapshot.parentSessionId || "") || null,
    parentThreadId: toTrimmedString(snapshot.parentThreadId || "") || null,
    rootSessionId: toTrimmedString(snapshot.rootSessionId || snapshot.sessionId || "") || null,
    action: toTrimmedString(snapshot.action || "snapshot") || "snapshot",
    eventType: toTrimmedString(snapshot.eventType || "") || null,
    status: toTrimmedString(snapshot.status || "idle") || "idle",
    summary: truncateSnapshotString(snapshot.summary || "", 2048),
    createdAt: toTrimmedString(snapshot.createdAt || "") || null,
    checkpoint: summarizeSnapshotValue(snapshot.checkpoint || null, 0),
    state: summarizeSnapshotValue(snapshot.state || {}, 0),
    result: summarizeSnapshotValue(snapshot.result, 0),
  }, note, originalBytes);
}

function compactEventEntry(event = {}, note, originalBytes = null) {
  return withSnapshotTruncation({
    eventId: toTrimmedString(event.eventId || "") || null,
    sessionId: toTrimmedString(event.sessionId || "") || null,
    type: toTrimmedString(event.type || "event") || "event",
    timestamp: toTrimmedString(event.timestamp || "") || null,
    payload: summarizeSnapshotValue(event.payload || {}, 0),
    meta: summarizeSnapshotValue(event.meta || {}, 0),
  }, note, originalBytes);
}

function compactCheckpointEntry(checkpoint = {}, note, originalBytes = null) {
  return withSnapshotTruncation(
    summarizeSnapshotValue(checkpoint || {}, 0),
    note,
    originalBytes,
  );
}

function compactSnapshotStoreState(inputState, note, originalBytes = null) {
  const snapshots = {};
  const events = {};
  const checkpoints = {};
  const lastTouchedAt = { ...(inputState?.lastTouchedAt || {}) };
  for (const [sessionId, entries] of Object.entries(inputState?.snapshots || {})) {
    const source = Array.isArray(entries) ? entries : [];
    snapshots[sessionId] = source.slice(-5).map((entry) => compactSnapshotEntry(entry, note, originalBytes));
  }
  for (const [sessionId, entries] of Object.entries(inputState?.events || {})) {
    const source = Array.isArray(entries) ? entries : [];
    events[sessionId] = source.slice(-20).map((entry) => compactEventEntry(entry, note, originalBytes));
  }
  for (const [sessionId, checkpoint] of Object.entries(inputState?.checkpoints || {})) {
    checkpoints[sessionId] = compactCheckpointEntry(checkpoint, note, originalBytes);
  }
  return {
    snapshots,
    events,
    checkpoints,
    lastTouchedAt,
  };
}

function serializeSnapshotStoreState(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    const message = String(error?.message || error || "").trim();
    if (/invalid string length/i.test(message)) {
      return null;
    }
    throw error;
  }
}

function resolveSnapshotStorePath(filePath = "") {
  const explicit = toTrimmedString(filePath);
  if (explicit) return resolve(explicit);
  const testCacheDir = toTrimmedString(process.env.BOSUN_TEST_CACHE_DIR || "");
  return testCacheDir
    ? resolve(testCacheDir, "session-snapshots.json")
    : resolve(__dirname, "..", "logs", "session-snapshots.json");
}

function normalizeStoreShape(snapshot = {}) {
  return {
    snapshots: snapshot?.snapshots && typeof snapshot.snapshots === "object" ? cloneValue(snapshot.snapshots) : {},
    events: snapshot?.events && typeof snapshot.events === "object" ? cloneValue(snapshot.events) : {},
    checkpoints: snapshot?.checkpoints && typeof snapshot.checkpoints === "object" ? cloneValue(snapshot.checkpoints) : {},
    lastTouchedAt: snapshot?.lastTouchedAt && typeof snapshot.lastTouchedAt === "object" ? cloneValue(snapshot.lastTouchedAt) : {},
  };
}

function sortByCreatedAt(values = []) {
  return [...values].sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")));
}

export function createSessionSnapshotStore(options = {}) {
  const filePath = resolveSnapshotStorePath(options.filePath);
  const maxSnapshotsPerSession = Number.isFinite(Number(options.maxSnapshotsPerSession))
    ? Math.max(10, Number(options.maxSnapshotsPerSession))
    : 20;
  const maxEventsPerSession = Number.isFinite(Number(options.maxEventsPerSession))
    ? Math.max(25, Number(options.maxEventsPerSession))
    : 80;
  // Cap total sessions retained on disk so the snapshot store cannot grow
  // unbounded and block the event loop on every persist().
  const maxSessions = Number.isFinite(Number(options.maxSessions))
    ? Math.max(5, Number(options.maxSessions))
    : 50;
  let loaded = false;
  let state = normalizeStoreShape();

  function ensureLoaded() {
    if (loaded) return;
    if (existsSync(filePath)) {
      try {
        state = normalizeStoreShape(JSON.parse(readFileSync(filePath, "utf8")));
      } catch {
        state = normalizeStoreShape();
      }
    }
    loaded = true;
  }

  function pruneToMaxSessions() {
    const ids = new Set([
      ...Object.keys(state.snapshots || {}),
      ...Object.keys(state.events || {}),
      ...Object.keys(state.checkpoints || {}),
    ]);
    if (ids.size <= maxSessions) return;
    const ranked = [...ids].map((id) => ({
      id,
      ts: String(state.lastTouchedAt?.[id] || ""),
    })).sort((a, b) => a.ts.localeCompare(b.ts)); // oldest first
    const toDrop = ranked.slice(0, ids.size - maxSessions);
    for (const { id } of toDrop) {
      delete state.snapshots[id];
      delete state.events[id];
      delete state.checkpoints[id];
      delete state.lastTouchedAt[id];
    }
  }

  function persist() {
    ensureLoaded();
    pruneToMaxSessions();
    mkdirSync(dirname(filePath), { recursive: true });
    // Compact (un-indented) JSON keeps the file small enough that the
    // synchronous write does not block the event loop for whole seconds.
    let serialized = serializeSnapshotStoreState(state);
    if (!serialized) {
      state = compactSnapshotStoreState(
        state,
        "snapshot-store: compacted after serialization failure",
      );
      serialized = serializeSnapshotStoreState(state);
    }
    if (!serialized || serialized.length > SNAPSHOT_STORE_HARD_LIMIT_BYTES) {
      const originalBytes = typeof serialized === "string" ? serialized.length : null;
      state = compactSnapshotStoreState(
        state,
        serialized
          ? "snapshot-store: compacted after size limit"
          : "snapshot-store: fell back to compact summary after serialization failure",
        originalBytes,
      );
      serialized = serializeSnapshotStoreState(state);
      if (!serialized) {
        throw new RangeError("Invalid string length");
      }
    }
    writeFileSync(filePath, serialized, "utf8");
  }

  function readSession(sessionId) {
    ensureLoaded();
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    return {
      snapshots: cloneValue(state.snapshots[normalizedSessionId] || []),
      events: cloneValue(state.events[normalizedSessionId] || []),
      checkpoint: cloneValue(state.checkpoints[normalizedSessionId] || null),
    };
  }

  function writeSession(sessionId, payload = {}) {
    ensureLoaded();
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) throw new Error("sessionId is required");
    state.snapshots[normalizedSessionId] = sortByCreatedAt(payload.snapshots || []).slice(-maxSnapshotsPerSession);
    state.events[normalizedSessionId] = cloneValue(payload.events || []).slice(-maxEventsPerSession);
    if (Object.prototype.hasOwnProperty.call(payload, "checkpoint")) {
      state.checkpoints[normalizedSessionId] = cloneValue(payload.checkpoint || null);
    } else if (!Object.prototype.hasOwnProperty.call(state.checkpoints, normalizedSessionId)) {
      state.checkpoints[normalizedSessionId] = null;
    }
    state.lastTouchedAt[normalizedSessionId] = new Date().toISOString();
    persist();
    return readSession(normalizedSessionId);
  }

  return {
    filePath,
    capture(snapshot = {}) {
      const normalizedSessionId = toTrimmedString(snapshot.sessionId || "");
      if (!normalizedSessionId) {
        throw new Error("Replay snapshot requires a sessionId");
      }
      const existing = readSession(normalizedSessionId) || { snapshots: [], events: [] };
      const nextSnapshots = existing.snapshots.filter((entry) => entry?.snapshotId !== snapshot?.snapshotId);
      nextSnapshots.push(cloneValue(snapshot));
      return writeSession(normalizedSessionId, {
        snapshots: nextSnapshots,
        events: existing.events,
        checkpoint: snapshot?.checkpoint ?? existing.checkpoint ?? null,
      }).snapshots.slice(-1)[0] || cloneValue(snapshot);
    },
    appendEvent(sessionId, event = {}) {
      const normalizedSessionId = toTrimmedString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("Replay event requires a sessionId");
      }
      const existing = readSession(normalizedSessionId) || { snapshots: [], events: [] };
      const nextEvents = [...existing.events, cloneValue(event)].slice(-maxEventsPerSession);
      return writeSession(normalizedSessionId, {
        snapshots: existing.snapshots,
        events: nextEvents,
        checkpoint: event?.checkpoint ?? existing.checkpoint ?? null,
      }).events.slice(-1)[0] || cloneValue(event);
    },
    list(sessionId, options_ = {}) {
      const session = readSession(sessionId);
      const snapshots = session?.snapshots || [];
      const limit = Number.isFinite(Number(options_.limit)) ? Math.max(1, Number(options_.limit)) : snapshots.length;
      return snapshots.slice(Math.max(0, snapshots.length - limit)).map((entry) => cloneValue(entry));
    },
    listEvents(sessionId, options_ = {}) {
      const session = readSession(sessionId);
      const events = session?.events || [];
      const limit = Number.isFinite(Number(options_.limit)) ? Math.max(1, Number(options_.limit)) : events.length;
      return events.slice(Math.max(0, events.length - limit)).map((entry) => cloneValue(entry));
    },
    getLatest(sessionId) {
      const snapshots = this.list(sessionId);
      return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
    },
    getCheckpoint(sessionId) {
      return this.readSession(sessionId)?.checkpoint || null;
    },
    writeCheckpoint(sessionId, checkpoint = null) {
      const normalizedSessionId = toTrimmedString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("sessionId is required");
      }
      const existing = readSession(normalizedSessionId) || { snapshots: [], events: [], checkpoint: null };
      return writeSession(normalizedSessionId, {
        snapshots: existing.snapshots,
        events: existing.events,
        checkpoint,
      }).checkpoint || cloneValue(checkpoint);
    },
    readSession,
    writeSession,
    deleteSession(sessionId) {
      ensureLoaded();
      const normalizedSessionId = toTrimmedString(sessionId);
      if (!normalizedSessionId) return false;
      delete state.snapshots[normalizedSessionId];
      delete state.events[normalizedSessionId];
      delete state.checkpoints[normalizedSessionId];
      delete state.lastTouchedAt[normalizedSessionId];
      persist();
      return true;
    },
    listSessionIds() {
      ensureLoaded();
      return [...new Set([
        ...Object.keys(state.snapshots || {}),
        ...Object.keys(state.events || {}),
        ...Object.keys(state.checkpoints || {}),
      ])];
    },
    snapshot() {
      ensureLoaded();
      return normalizeStoreShape(state);
    },
    hydrate(snapshot = {}) {
      state = normalizeStoreShape(snapshot);
      loaded = true;
      persist();
      return this.snapshot();
    },
  };
}

export default createSessionSnapshotStore;
