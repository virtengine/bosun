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
  };
}

function sortByCreatedAt(values = []) {
  return [...values].sort((left, right) => String(left?.createdAt || "").localeCompare(String(right?.createdAt || "")));
}

export function createSessionSnapshotStore(options = {}) {
  const filePath = resolveSnapshotStorePath(options.filePath);
  const maxSnapshotsPerSession = Number.isFinite(Number(options.maxSnapshotsPerSession))
    ? Math.max(10, Number(options.maxSnapshotsPerSession))
    : 64;
  const maxEventsPerSession = Number.isFinite(Number(options.maxEventsPerSession))
    ? Math.max(25, Number(options.maxEventsPerSession))
    : 256;
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

  function persist() {
    ensureLoaded();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
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
