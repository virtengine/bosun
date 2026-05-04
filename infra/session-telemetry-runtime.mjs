import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  appendEventsWithBosunHotPathTelemetry,
  cloneHotPathValue,
  flushBosunHotPathTelemetry,
} from "../lib/hot-path-runtime.mjs";

const DEFAULT_STATUS = Object.freeze({
  service: "telemetry",
  mode: "javascript",
  transport: "in_process",
  available: true,
  reason: "javascript",
  queuedEvents: 0,
  queuedPersistEvents: 0,
  processedEvents: 0,
  droppedEvents: 0,
  persistBatches: 0,
  persistedEvents: 0,
  persistFailures: 0,
  pendingPersistBytes: 0,
  maxInMemoryEvents: 0,
  maxPersistBatchEvents: 0,
  inMemoryEvents: 0,
  analyticsHighWatermark: 0,
  persistHighWatermark: 0,
  nativeMirrorQueuedEvents: 0,
  nativeMirrorFlushes: 0,
  nativeMirrorFailures: 0,
  restoredFromDisk: false,
  restoredEvents: 0,
  lastRestoreAt: null,
  lastRestoredEventAt: null,
  liveSessions: 0,
  liveRuns: 0,
  activeSessions: 0,
  activeRuns: 0,
  latestSessionId: null,
  latestRunId: null,
  latestLiveStatus: null,
  lastBufferedEventAt: null,
  lastEnqueueAt: null,
  lastDrainAt: null,
  lastPersistAt: null,
});

const DEFAULT_ANALYTICS_DRAIN_BATCH = 256;
const DEFAULT_PERSIST_BATCH_EVENTS = 512;
const DEFAULT_RESTORE_MAX_BYTES = 16 * 1024 * 1024;
const QUEUE_COMPACT_THRESHOLD = 1024;

function scheduleBackground(fn) {
  if (typeof setImmediate === "function") {
    setImmediate(fn);
    return;
  }
  setTimeout(fn, 0);
}

function waitForBackgroundTurn() {
  return new Promise((resolve) => scheduleBackground(resolve));
}

class IndexedQueue {
  constructor() {
    this.items = [];
    this.offset = 0;
  }

  get length() {
    return this.items.length - this.offset;
  }

  push(value) {
    this.items.push(value);
    return this.length;
  }

  drain(limit = Number.POSITIVE_INFINITY) {
    const count = Math.min(
      this.length,
      Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : this.length,
    );
    if (count <= 0) return [];
    const start = this.offset;
    const end = start + count;
    const values = this.items.slice(start, end);
    this.items.fill(undefined, start, end);
    this.offset = end;
    this.#compactIfNeeded();
    return values;
  }

  clear() {
    this.items = [];
    this.offset = 0;
  }

  #compactIfNeeded() {
    if (this.offset === 0) return;
    if (this.offset >= this.items.length) {
      this.clear();
      return;
    }
    if (this.offset < QUEUE_COMPACT_THRESHOLD || this.offset * 2 < this.items.length) {
      return;
    }
    this.items = this.items.slice(this.offset);
    this.offset = 0;
  }
}

class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.trunc(Number(capacity) || 1));
    this.buffer = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }

  get size() {
    return this.length;
  }

  push(value) {
    if (this.length < this.capacity) {
      this.buffer[(this.start + this.length) % this.capacity] = value;
      this.length += 1;
      return 0;
    }
    this.buffer[this.start] = value;
    this.start = (this.start + 1) % this.capacity;
    return 1;
  }

  toArray() {
    if (this.length === 0) return [];
    const values = new Array(this.length);
    for (let index = 0; index < this.length; index += 1) {
      values[index] = this.buffer[(this.start + index) % this.capacity];
    }
    return values;
  }

  clear() {
    this.buffer = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }
}

function createStatus(maxInMemoryEvents, maxPersistBatchEvents) {
  return {
    ...DEFAULT_STATUS,
    maxInMemoryEvents,
    maxPersistBatchEvents,
  };
}

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeStatus(value) {
  const normalized = asText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function isTerminalStatus(value) {
  return new Set(["completed", "failed", "cancelled", "canceled", "aborted", "terminated", "skipped"]).has(
    normalizeStatus(value),
  );
}

function readJsonLines(filePath, options = {}) {
  if (!filePath || !existsSync(filePath)) {
    return {
      entries: [],
      fileBytes: 0,
      readBytes: 0,
      truncated: false,
    };
  }

  const maxBytes = Number.isFinite(Number(options.maxBytes))
    ? Math.max(0, Math.trunc(Number(options.maxBytes)))
    : DEFAULT_RESTORE_MAX_BYTES;
  const maxEvents = Number.isFinite(Number(options.maxEvents))
    ? Math.max(1, Math.trunc(Number(options.maxEvents)))
    : null;
  const fileBytes = Math.max(0, Number(statSync(filePath).size || 0));
  const readBytes = maxBytes > 0 ? Math.min(fileBytes, maxBytes) : fileBytes;
  let raw = "";

  if (readBytes <= 0) {
    return {
      entries: [],
      fileBytes,
      readBytes: 0,
      truncated: fileBytes > 0,
    };
  }

  if (readBytes === fileBytes) {
    raw = readFileSync(filePath, "utf8");
  } else {
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(readBytes);
      readSync(fd, buffer, 0, readBytes, Math.max(0, fileBytes - readBytes));
      raw = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const firstNewline = raw.indexOf("\n");
    raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
  }

  let entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  let truncated = readBytes < fileBytes;
  if (maxEvents != null && entries.length > maxEvents) {
    entries = entries.slice(-maxEvents);
    truncated = true;
  }

  return {
    entries,
    fileBytes,
    readBytes,
    truncated,
  };
}

export class HarnessTelemetryRuntime {
  constructor(options = {}) {
    this.persist = options.persist === true;
    this.maxInMemoryEvents = Math.max(
      100,
      Math.trunc(Number(options.maxInMemoryEvents) || 20_000),
    );
    this.maxPersistBatchEvents = Math.max(
      1,
      Math.trunc(Number(options.maxPersistBatchEvents) || DEFAULT_PERSIST_BATCH_EVENTS),
    );
    this.maxRestoreBytes = Math.max(
      64 * 1024,
      Math.trunc(Number(options.maxRestoreBytes) || DEFAULT_RESTORE_MAX_BYTES),
    );
    this.maxRestoreEvents = Math.max(
      1,
      Math.trunc(Number(options.maxRestoreEvents) || this.maxInMemoryEvents),
    );
    this.paths = options.paths || {};
    this.projector = options.projector;
    this.metrics = options.metrics;
    this.providerUsage = options.providerUsage;
    this.events = new RingBuffer(this.maxInMemoryEvents);
    this.pendingAnalytics = new IndexedQueue();
    this.pendingPersist = new IndexedQueue();
    this.pendingNativeMirror = new IndexedQueue();
    this.analyticsScheduled = false;
    this.persistScheduled = false;
    this.nativeMirrorScheduled = false;
    this.persistPromise = null;
    this.nativeMirrorPromise = null;
    this.status = createStatus(this.maxInMemoryEvents, this.maxPersistBatchEvents);
  }

  _syncProjectionStatus() {
    const snapshot = typeof this.projector?.getSnapshot === "function"
      ? this.projector.getSnapshot()
      : {};
    const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
    const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
    const latestSession = sessions[0] || null;
    const latestRun = runs[0] || null;
    const latestBufferedEvent = this.events.toArray().at(-1) || null;
    this.status.liveSessions = sessions.length;
    this.status.liveRuns = runs.length;
    this.status.activeSessions = sessions.filter((entry) => {
      const status = normalizeStatus(entry?.status);
      return Boolean(status) && !isTerminalStatus(status) && status !== "idle";
    }).length;
    this.status.activeRuns = runs.filter((entry) => {
      const status = normalizeStatus(entry?.status);
      return Boolean(status) && !isTerminalStatus(status) && status !== "idle";
    }).length;
    this.status.latestSessionId = asText(latestSession?.sessionId) || null;
    this.status.latestRunId = asText(latestRun?.runId) || null;
    this.status.latestLiveStatus = normalizeStatus(latestSession?.status || latestRun?.status) || null;
    this.status.lastBufferedEventAt = asText(latestBufferedEvent?.timestamp) || null;
  }

  _appendEvent(normalized, { persist = false } = {}) {
    this.status.droppedEvents += this.events.push(normalized);
    this.status.inMemoryEvents = this.events.size;
    const queuedEvents = this.pendingAnalytics.push(normalized);
    this.status.queuedEvents = queuedEvents;
    this.status.analyticsHighWatermark = Math.max(this.status.analyticsHighWatermark, queuedEvents);
    this.status.lastEnqueueAt = new Date().toISOString();

    if (persist && this.persist) {
      const serialized = JSON.stringify(normalized);
      const bytes = Buffer.byteLength(`${serialized}\n`, "utf8");
      const queuedPersistEvents = this.pendingPersist.push({ serialized, bytes });
      this.status.queuedPersistEvents = queuedPersistEvents;
      this.status.pendingPersistBytes += bytes;
      this.status.persistHighWatermark = Math.max(this.status.persistHighWatermark, queuedPersistEvents);
    }

    const nativeQueuedEvents = this.pendingNativeMirror.push(normalized);
    this.status.nativeMirrorQueuedEvents = nativeQueuedEvents;
  }

  load(entries = [], options = {}) {
    for (const entry of entries) {
      this._appendEvent(entry, { persist: false });
    }
    this.flushForeground();
    this._scheduleNativeMirrorFlush();
    if (options?.source === "disk") {
      this.status.restoredFromDisk = true;
      this.status.restoredEvents += entries.length;
      this.status.lastRestoreAt = new Date().toISOString();
      this.status.lastRestoredEventAt = asText(entries.at(-1)?.timestamp) || this.status.lastRestoredEventAt;
    }
    return {
      restoredFromDisk: options?.source === "disk",
      restoredEvents: entries.length,
      liveSessions: this.status.liveSessions,
      liveRuns: this.status.liveRuns,
      activeSessions: this.status.activeSessions,
      activeRuns: this.status.activeRuns,
      latestSessionId: this.status.latestSessionId,
      latestRunId: this.status.latestRunId,
      latestLiveStatus: this.status.latestLiveStatus,
      lastEventAt: this.status.lastBufferedEventAt,
    };
  }

  record(normalized) {
    this._appendEvent(normalized, { persist: true });
    this._scheduleAnalyticsDrain();
    this._schedulePersistFlush();
    this._scheduleNativeMirrorFlush();
    return normalized;
  }

  _drainAnalytics(limit = DEFAULT_ANALYTICS_DRAIN_BATCH) {
    const batch = this.pendingAnalytics.drain(limit);
    let processed = 0;
    for (const event of batch) {
      this.projector.record(event);
      this.metrics.record(event);
      this.providerUsage.record(event);
      processed += 1;
    }
    if (processed > 0) {
      this.status.processedEvents += processed;
      this.status.lastDrainAt = new Date().toISOString();
    }
    this.status.queuedEvents = this.pendingAnalytics.length;
    return processed;
  }

  _drainAnalyticsFully() {
    let processed = 0;
    while (this.pendingAnalytics.length > 0) {
      processed += this._drainAnalytics(Number.POSITIVE_INFINITY);
    }
    return processed;
  }

  _scheduleAnalyticsDrain() {
    if (this.analyticsScheduled) return;
    this.analyticsScheduled = true;
    scheduleBackground(() => {
      this.analyticsScheduled = false;
      this._drainAnalytics(256);
      if (this.pendingAnalytics.length > 0) {
        this._scheduleAnalyticsDrain();
      }
    });
  }

  async _flushPersistBatch() {
    if (!this.persist || this.pendingPersist.length === 0) return;
    const batch = this.pendingPersist.drain(this.maxPersistBatchEvents);
    const batchBytes = batch.reduce((total, entry) => total + Number(entry?.bytes || 0), 0);
    this.status.queuedPersistEvents = this.pendingPersist.length;
    this.status.pendingPersistBytes = Math.max(0, this.status.pendingPersistBytes - batchBytes);

    try {
      await mkdir(dirname(this.paths.eventsPath), { recursive: true });
      await appendFile(
        this.paths.eventsPath,
        `${batch.map((entry) => entry.serialized).join("\n")}\n`,
        "utf8",
      );
      this.status.persistBatches += 1;
      this.status.persistedEvents += batch.length;
      this.status.lastPersistAt = new Date().toISOString();
    } catch {
      this.status.persistFailures += 1;
    }
  }

  async _runPersistLoop() {
    try {
      while (this.pendingPersist.length > 0) {
        await this._flushPersistBatch();
      }
    } finally {
      this.persistPromise = null;
      if (this.pendingPersist.length > 0) {
        this._schedulePersistFlush();
      }
    }
  }

  _schedulePersistFlush() {
    if (!this.persist || this.persistScheduled) return;
    this.persistScheduled = true;
    scheduleBackground(() => {
      this.persistScheduled = false;
      if (!this.persistPromise) {
        this.persistPromise = this._runPersistLoop();
      }
    });
  }

  async _flushNativeMirrorBatch() {
    if (this.pendingNativeMirror.length === 0) return;
    const batch = this.pendingNativeMirror.drain(Math.max(1, this.maxPersistBatchEvents * 2));
    this.status.nativeMirrorQueuedEvents = this.pendingNativeMirror.length;
    try {
      await appendEventsWithBosunHotPathTelemetry(batch, {
        maxInMemoryEvents: this.maxInMemoryEvents,
      });
      this.status.nativeMirrorFlushes += 1;
    } catch {
      this.status.nativeMirrorFailures += 1;
    }
  }

  async _runNativeMirrorLoop() {
    try {
      while (this.pendingNativeMirror.length > 0) {
        await this._flushNativeMirrorBatch();
      }
      await flushBosunHotPathTelemetry();
    } finally {
      this.nativeMirrorPromise = null;
      if (this.pendingNativeMirror.length > 0) {
        this._scheduleNativeMirrorFlush();
      }
    }
  }

  _scheduleNativeMirrorFlush() {
    if (this.nativeMirrorScheduled) return;
    this.nativeMirrorScheduled = true;
    scheduleBackground(() => {
      this.nativeMirrorScheduled = false;
      if (!this.nativeMirrorPromise) {
        this.nativeMirrorPromise = this._runNativeMirrorLoop();
      }
    });
  }

  flushForeground() {
    this._drainAnalyticsFully();
    this._syncProjectionStatus();
  }

  restoreFromDisk(options = {}) {
    const restore = readJsonLines(options?.eventsPath || this.paths?.eventsPath, {
      maxBytes: options?.maxRestoreBytes ?? this.maxRestoreBytes,
      maxEvents: options?.maxRestoreEvents ?? this.maxRestoreEvents,
    });
    const entries = restore.entries;
    if (entries.length === 0) {
      this.flushForeground();
      return {
        restoredFromDisk: false,
        restoredEvents: 0,
        liveSessions: this.status.liveSessions,
        liveRuns: this.status.liveRuns,
        activeSessions: this.status.activeSessions,
        activeRuns: this.status.activeRuns,
        latestSessionId: this.status.latestSessionId,
        latestRunId: this.status.latestRunId,
        latestLiveStatus: this.status.latestLiveStatus,
        lastEventAt: this.status.lastBufferedEventAt,
      };
    }
    this.status.restoreTruncated = restore.truncated;
    this.status.restoredFileBytes = restore.fileBytes;
    this.status.restoredReadBytes = restore.readBytes;
    return this.load(entries, { source: "disk" });
  }

  async flush() {
    this.flushForeground();
    while (true) {
      if (this.persistScheduled) {
        await waitForBackgroundTurn();
        continue;
      }
      if (this.persistPromise) {
        await this.persistPromise;
        continue;
      }
      if (this.nativeMirrorScheduled) {
        await waitForBackgroundTurn();
        continue;
      }
      if (this.nativeMirrorPromise) {
        await this.nativeMirrorPromise;
        continue;
      }
      if (this.pendingPersist.length > 0) {
        await this._runPersistLoop();
        continue;
      }
      if (this.pendingNativeMirror.length > 0) {
        await this._runNativeMirrorLoop();
        continue;
      }
      break;
    }
    this.flushForeground();
  }

  getEvents() {
    this.flushForeground();
    return this.events.toArray();
  }

  getStatus() {
    this.flushForeground();
    return cloneHotPathValue(this.status);
  }

  reset() {
    this.events.clear();
    this.pendingAnalytics.clear();
    this.pendingPersist.clear();
    this.pendingNativeMirror.clear();
    this.analyticsScheduled = false;
    this.persistScheduled = false;
    this.nativeMirrorScheduled = false;
    this.persistPromise = null;
    this.nativeMirrorPromise = null;
    this.status = createStatus(this.maxInMemoryEvents, this.maxPersistBatchEvents);
  }
}

export function createHarnessTelemetryRuntime(options = {}) {
  return new HarnessTelemetryRuntime(options);
}

export default createHarnessTelemetryRuntime;
