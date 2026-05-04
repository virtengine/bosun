import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createReplayReader } from "../infra/replay-reader.mjs";
import { WorkflowExecutionLedger } from "../workflow/execution-ledger.mjs";
import { createSessionSnapshotStore } from "./session-snapshot-store.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function createSnapshotId() {
  return `replay-${randomUUID()}`;
}

function createCheckpointId() {
  return `checkpoint-${randomUUID()}`;
}

function normalizeStatus(value, fallback = "idle") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9_-]+/g, "_");
}

function toSafeInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : fallback;
}

function normalizeBoundaryType(value, fallback = "event_boundary") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  return normalized.replace(/[^a-z0-9_-]+/g, "_");
}

function inferBoundaryType(input = {}, fallback = "event_boundary") {
  const explicit = normalizeBoundaryType(input.boundaryType || input?.meta?.boundaryType || "", "");
  if (explicit) return explicit;
  const eventType = toTrimmedString(input.eventType || "").toLowerCase();
  const action = toTrimmedString(input.action || "").toLowerCase();
  if (
    eventType.startsWith("node.")
    || eventType.startsWith("harness:stage")
    || toTrimmedString(input.nodeId || input.stageId || input.currentStageId || "")
  ) {
    return "node_boundary";
  }
  if (
    eventType.includes("turn")
    || eventType.startsWith("provider.turn")
    || action.startsWith("session_")
    || action.startsWith("steer_")
    || action.startsWith("external_execution_")
    || action === "execution_registered"
  ) {
    return "turn_boundary";
  }
  return fallback;
}

function normalizeReplayCheckpoint(input = {}, fallback = {}) {
  const source = input && typeof input === "object" ? input : {};
  const cursor = source.cursor && typeof source.cursor === "object" ? source.cursor : {};
  const counters = source.counters && typeof source.counters === "object" ? source.counters : {};
  const updatedAt = toTrimmedString(
    source.updatedAt
    || source.timestamp
    || fallback.updatedAt
    || fallback.createdAt
    || "",
  ) || nowIso();
  const messageCursor = toSafeInteger(source.messageCursor ?? cursor.message ?? fallback.messageCursor, null);
  const turnCursor = toSafeInteger(source.turnCursor ?? cursor.turn ?? fallback.turnCursor, null);
  const eventCursor = toSafeInteger(source.eventCursor ?? cursor.event ?? fallback.eventCursor, null);
  const spillCount = toSafeInteger(source.spillCount ?? counters.spillCount ?? fallback.spillCount, 0);
  const toolCallCount = toSafeInteger(source.toolCallCount ?? counters.toolCallCount ?? fallback.toolCallCount, 0);
  const toolResultCount = toSafeInteger(source.toolResultCount ?? counters.toolResultCount ?? fallback.toolResultCount, 0);
  return {
    checkpointId: toTrimmedString(source.checkpointId || fallback.checkpointId || "") || createCheckpointId(),
    snapshotId: toTrimmedString(source.snapshotId || fallback.snapshotId || "") || null,
    replayCursor: toTrimmedString(source.replayCursor || source.snapshotId || fallback.replayCursor || fallback.snapshotId || "") || null,
    sessionId: toTrimmedString(source.sessionId || fallback.sessionId || "") || null,
    runId: toTrimmedString(source.runId || fallback.runId || "") || null,
    threadId: toTrimmedString(source.threadId || fallback.threadId || "") || null,
    parentSessionId: toTrimmedString(source.parentSessionId || fallback.parentSessionId || "") || null,
    rootSessionId: toTrimmedString(source.rootSessionId || fallback.rootSessionId || source.sessionId || fallback.sessionId || "") || null,
    status: normalizeStatus(source.status || fallback.status || "idle"),
    action: toTrimmedString(source.action || fallback.action || "") || null,
    eventType: toTrimmedString(source.eventType || fallback.eventType || "") || null,
    boundaryType: inferBoundaryType(source, inferBoundaryType(fallback)),
    providerTurnId: toTrimmedString(source.providerTurnId || fallback.providerTurnId || "") || null,
    stageId: toTrimmedString(source.stageId || source.currentStageId || fallback.stageId || fallback.currentStageId || "") || null,
    nodeId: toTrimmedString(source.nodeId || fallback.nodeId || "") || null,
    nodeType: toTrimmedString(source.nodeType || fallback.nodeType || "") || null,
    summary: toTrimmedString(source.summary || fallback.summary || "") || null,
    updatedAt,
    messageCursor,
    turnCursor,
    eventCursor,
    spillCount,
    toolCallCount,
    toolResultCount,
    cursor: {
      replay: toTrimmedString(source.replayCursor || source.snapshotId || fallback.replayCursor || fallback.snapshotId || "") || null,
      message: messageCursor,
      turn: turnCursor,
      event: eventCursor,
    },
    counters: {
      spillCount,
      toolCallCount,
      toolResultCount,
    },
    meta: cloneValue(source.meta || fallback.meta || {}),
  };
}

function resolveExistingPath(...candidates) {
  for (const candidate of candidates) {
    const normalized = toTrimmedString(candidate);
    if (!normalized) continue;
    const absolute = resolve(normalized);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function resolveReplayPaths(options = {}) {
  const configDir = resolveExistingPath(
    options.configDir,
    process.env.BOSUN_CONFIG_DIR,
  );
  const runsDir = resolveExistingPath(
    options.runsDir,
    process.env.BOSUN_RUNS_DIR,
    configDir ? resolve(configDir, "workflow-runs") : null,
  );
  return {
    configDir: configDir || null,
    runsDir: runsDir || null,
  };
}

function summarizeProjection(projection = {}) {
  const live = projection?.live && typeof projection.live === "object" ? projection.live : null;
  const sessions = Array.isArray(live?.sessions) ? live.sessions : [];
  const runs = Array.isArray(live?.runs) ? live.runs : [];
  return {
    eventCount: Array.isArray(projection?.events) ? projection.events.length : 0,
    sessionCount: sessions.length,
    runCount: runs.length,
    latestSession: sessions[0] || null,
    latestRun: runs[0] || null,
    live,
  };
}

function buildLiveRestoreState(sessionId, coldRestore = {}, latestSnapshot = null, latestCheckpoint = null) {
  const telemetry = coldRestore?.telemetry || null;
  const stateLedger = coldRestore?.stateLedger || null;
  const executionLedger = coldRestore?.executionLedger || null;
  const latestSession = telemetry?.latestSession || stateLedger?.latestSession || null;
  const latestRun = telemetry?.latestRun || stateLedger?.latestRun || executionLedger?.latestRun || null;
  const latestEvent = executionLedger?.latestEvent || null;
  const checkpoint = latestCheckpoint || executionLedger?.latestCheckpoint || latestSnapshot?.checkpoint || null;
  const status =
    checkpoint?.status
    || latestSession?.status
    || latestRun?.status
    || executionLedger?.status
    || latestSnapshot?.status
    || null;
  return {
    source:
      checkpoint
        ? "checkpoint"
        : ((telemetry?.sessionCount || telemetry?.runCount)
            ? "telemetry"
            : ((stateLedger?.sessionCount || stateLedger?.runCount)
                ? "state-ledger"
                : (executionLedger?.runCount ? "execution-ledger" : null))),
    sessionId: toTrimmedString(checkpoint?.sessionId || latestSession?.sessionId || sessionId || "") || null,
    threadId: toTrimmedString(checkpoint?.threadId || latestSession?.threadId || latestRun?.threadId || latestSnapshot?.threadId || "") || null,
    runId: toTrimmedString(checkpoint?.runId || latestRun?.runId || latestSnapshot?.runId || "") || null,
    status: normalizeStatus(status, "idle"),
    updatedAt:
      checkpoint?.updatedAt
      || latestSession?.updatedAt
      || latestRun?.updatedAt
      || latestEvent?.timestamp
      || latestSnapshot?.createdAt
      || null,
  };
}

function buildResumePointer({ latestCheckpoint = null, latestSnapshot = null, liveStatus = null } = {}) {
  if (latestCheckpoint) {
    return {
      checkpointId: latestCheckpoint.checkpointId,
      snapshotId: latestCheckpoint.snapshotId || latestCheckpoint.replayCursor || null,
      replayCursor: latestCheckpoint.replayCursor || latestCheckpoint.snapshotId || null,
      threadId: latestCheckpoint.threadId || null,
      runId: latestCheckpoint.runId || null,
      status: latestCheckpoint.status || null,
      action: latestCheckpoint.action || null,
      eventType: latestCheckpoint.eventType || null,
      boundaryType: latestCheckpoint.boundaryType || null,
      messageCursor: latestCheckpoint.messageCursor ?? null,
      turnCursor: latestCheckpoint.turnCursor ?? null,
      spillCount: latestCheckpoint.spillCount ?? 0,
      updatedAt: latestCheckpoint.updatedAt || null,
    };
  }
  if (latestSnapshot) {
    return {
      snapshotId: latestSnapshot.snapshotId,
      replayCursor: latestSnapshot.snapshotId,
      threadId: latestSnapshot.threadId,
      runId: latestSnapshot.runId || null,
      status: latestSnapshot.status,
      action: latestSnapshot.action,
      eventType: latestSnapshot.eventType || null,
      boundaryType: latestSnapshot?.checkpoint?.boundaryType || null,
    };
  }
  if (liveStatus?.threadId || liveStatus?.runId) {
    return {
      snapshotId: null,
      replayCursor: null,
      threadId: liveStatus.threadId,
      runId: liveStatus.runId,
      status: liveStatus.status,
      action: `cold_restore:${liveStatus.source || "persisted"}`,
      eventType: null,
      boundaryType: liveStatus.source === "checkpoint" ? "checkpoint_restore" : null,
      updatedAt: liveStatus.updatedAt || null,
    };
  }
  return null;
}

function createEventEmitter(hooks = []) {
  const listeners = [...new Set(hooks.filter((hook) => typeof hook === "function"))];
  return (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
      }
    }
  };
}

export function createReplaySnapshot(input = {}) {
  const createdAt = nowIso();
  const snapshotId = toTrimmedString(input.snapshotId || "") || createSnapshotId();
  const base = {
    snapshotId,
    sessionId: toTrimmedString(input.sessionId || "") || null,
    runId: toTrimmedString(input.runId || "") || null,
    threadId: toTrimmedString(input.threadId || "") || null,
    parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
    parentThreadId: toTrimmedString(input.parentThreadId || "") || null,
    rootSessionId: toTrimmedString(input.rootSessionId || input.sessionId || "") || null,
    action: toTrimmedString(input.action || "snapshot") || "snapshot",
    eventType: toTrimmedString(input.eventType || "") || null,
    status: normalizeStatus(input.status || "idle"),
    summary: toTrimmedString(input.summary || "") || null,
    createdAt,
    state: cloneValue(input.state || {}),
    result: cloneValue(input.result),
  };
  return {
    ...base,
    checkpoint: input.checkpoint
      ? normalizeReplayCheckpoint(input.checkpoint, {
          ...base,
          checkpointId: snapshotId,
          snapshotId,
          replayCursor: snapshotId,
          updatedAt: createdAt,
          summary: base.summary,
        })
      : null,
  };
}

function mergeReplaySnapshot(snapshot, patch = {}) {
  const next = {
    ...snapshot,
    ...toPlainObject(patch),
  };
  next.snapshotId = toTrimmedString(next.snapshotId || snapshot.snapshotId);
  next.sessionId = toTrimmedString(next.sessionId || snapshot.sessionId || "") || null;
  next.runId = toTrimmedString(next.runId || snapshot.runId || "") || null;
  next.threadId = toTrimmedString(next.threadId || snapshot.threadId || "") || null;
  next.parentSessionId = toTrimmedString(next.parentSessionId || snapshot.parentSessionId || "") || null;
  next.parentThreadId = toTrimmedString(next.parentThreadId || snapshot.parentThreadId || "") || null;
  next.rootSessionId = toTrimmedString(next.rootSessionId || snapshot.rootSessionId || next.sessionId || "") || null;
  next.action = toTrimmedString(next.action || snapshot.action || "snapshot") || "snapshot";
  next.eventType = toTrimmedString(next.eventType || snapshot.eventType || "") || null;
  next.status = normalizeStatus(next.status || snapshot.status);
  next.summary = toTrimmedString(next.summary || snapshot.summary || "") || null;
  next.state = cloneValue(next.state || snapshot.state || {});
  next.result = cloneValue(next.result ?? snapshot.result);
  next.createdAt = toTrimmedString(next.createdAt || snapshot.createdAt || "") || nowIso();
  next.checkpoint = next.checkpoint
    ? normalizeReplayCheckpoint(next.checkpoint, {
        ...snapshot?.checkpoint,
        ...snapshot,
        ...next,
        checkpointId: next.snapshotId,
        snapshotId: next.snapshotId,
        replayCursor: next.snapshotId,
        updatedAt: next.createdAt,
      })
    : null;
  return next;
}

export function createSessionReplayStore(options = {}) {
  const events = new Map();
  const snapshotStore = options.snapshotStore || createSessionSnapshotStore({
    maxSnapshotsPerSession: options.maxSnapshotsPerSession,
  });
  const maxSnapshotsPerSession = Number.isFinite(Number(options.maxSnapshotsPerSession))
    ? Math.max(10, Number(options.maxSnapshotsPerSession))
    : 64;
  const maxEventsPerSession = Number.isFinite(Number(options.maxEventsPerSession))
    ? Math.max(25, Number(options.maxEventsPerSession))
    : 256;
  const emitEvent = createEventEmitter([options.onEvent]);
  const replayPaths = resolveReplayPaths(options);

  function getBucket(store, sessionId) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    if (!store.has(normalizedSessionId)) {
      store.set(normalizedSessionId, []);
    }
    return store.get(normalizedSessionId);
  }

  function captureSnapshot(input = {}) {
    const snapshot = mergeReplaySnapshot(createReplaySnapshot(input), input);
    snapshotStore.capture(snapshot);
    emitEvent({
      type: "replay:snapshot-captured",
      sessionId: snapshot.sessionId,
      snapshotId: snapshot.snapshotId,
      action: snapshot.action,
      status: snapshot.status,
      timestamp: snapshot.createdAt,
    });
    return cloneValue(snapshot);
  }

  function recordEvent(sessionId, event, meta = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("Replay event requires a sessionId");
    }
    const bucket = getBucket(events, normalizedSessionId);
    if (bucket.length === 0) {
      const persisted = snapshotStore.readSession(normalizedSessionId);
      for (const entry of Array.isArray(persisted?.events) ? persisted.events : []) {
        bucket.push(cloneValue(entry));
      }
    }
    const entry = {
      eventId: `event-${randomUUID()}`,
      sessionId: normalizedSessionId,
      type: toTrimmedString(event?.type || meta.type || "event") || "event",
      timestamp: toTrimmedString(event?.timestamp || meta.timestamp || "") || nowIso(),
      payload: cloneValue(event || {}),
      meta: cloneValue(meta || {}),
    };
    bucket.push(entry);
    while (bucket.length > maxEventsPerSession) {
      bucket.shift();
    }
    snapshotStore.writeSession(normalizedSessionId, {
      snapshots: snapshotStore.list(normalizedSessionId),
      events: bucket,
      checkpoint: event?.checkpoint ?? meta?.checkpoint ?? snapshotStore.getCheckpoint(normalizedSessionId) ?? null,
    });
    emitEvent({
      type: "replay:event-recorded",
      sessionId: normalizedSessionId,
      eventType: entry.type,
      timestamp: entry.timestamp,
    });
    return cloneValue(entry);
  }

  function listSnapshots(sessionId, options_ = {}) {
    return snapshotStore.list(sessionId, options_);
  }

  function listEvents(sessionId, options_ = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    const bucket = normalizedSessionId
      ? (events.get(normalizedSessionId) || snapshotStore.listEvents(normalizedSessionId))
      : [];
    const limit = Number.isFinite(Number(options_.limit)) ? Math.max(1, Number(options_.limit)) : bucket.length;
    return bucket.slice(Math.max(0, bucket.length - limit)).map((entry) => cloneValue(entry));
  }

  function getLatestSnapshot(sessionId) {
    return snapshotStore.getLatest(sessionId);
  }

  function getLatestCheckpoint(sessionId) {
    const latestSnapshot = getLatestSnapshot(sessionId);
    const stored = snapshotStore.getCheckpoint(sessionId) || latestSnapshot?.checkpoint || null;
    return stored
      ? normalizeReplayCheckpoint(stored, latestSnapshot
        ? {
            ...latestSnapshot,
            checkpointId: latestSnapshot.snapshotId,
            snapshotId: latestSnapshot.snapshotId,
            replayCursor: latestSnapshot.snapshotId,
            updatedAt: latestSnapshot.createdAt,
          }
        : {})
      : null;
  }

  function buildColdRestoreState(sessionId, options_ = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) {
      return {
        restored: false,
        sources: [],
        telemetry: null,
        stateLedger: null,
        executionLedger: null,
        liveStatus: null,
      };
    }

    const paths = resolveReplayPaths({
      ...replayPaths,
      ...options_,
    });
    if (!paths.configDir && !paths.runsDir) {
      return {
        restored: false,
        sources: [],
        telemetry: null,
        stateLedger: null,
        executionLedger: null,
        liveStatus: null,
      };
    }

    const telemetryProjection = paths.configDir
      ? createReplayReader({
          configDir: paths.configDir,
          anchorPath: paths.runsDir || undefined,
        }).readTelemetryProjection({ sessionId: normalizedSessionId })
      : { events: [], live: { sessions: [], runs: [] } };
    const stateLedgerProjection = paths.runsDir
      ? createReplayReader({
          configDir: paths.configDir || undefined,
          anchorPath: paths.runsDir,
        }).readStateLedgerProjection({
          anchorPath: paths.runsDir,
          sessionId: normalizedSessionId,
        })
      : { events: [], live: { sessions: [], runs: [] } };
    const ledgerRestore = paths.runsDir
      ? new WorkflowExecutionLedger({ runsDir: paths.runsDir }).buildRestoreState({
          sessionId: normalizedSessionId,
          eventLimit: options_.eventLimit || 25,
        })
      : {
          source: "execution-ledger",
          runCount: 0,
          activeRunCount: 0,
          terminalRunCount: 0,
          sessionIds: [],
          runIds: [],
          status: null,
          latestRun: null,
          latestEvent: null,
          runs: [],
          recentEvents: [],
        };
    const telemetry = summarizeProjection(telemetryProjection);
    const stateLedger = summarizeProjection(stateLedgerProjection);
    const latestSnapshot = getLatestSnapshot(normalizedSessionId);
    const latestCheckpoint = getLatestCheckpoint(normalizedSessionId) || ledgerRestore?.latestCheckpoint || null;
    const sources = [];
    if (latestCheckpoint) sources.push("checkpoint");
    if (telemetry.eventCount > 0) sources.push("telemetry");
    if (stateLedger.eventCount > 0) sources.push("state-ledger");
    if ((ledgerRestore?.runCount || 0) > 0) sources.push("execution-ledger");
    return {
      restored: sources.length > 0,
      sources,
      latestCheckpoint,
      telemetry: {
        ...telemetry,
        events: telemetryProjection.events,
      },
      stateLedger: {
        ...stateLedger,
        events: stateLedgerProjection.events,
      },
      executionLedger: ledgerRestore,
      liveStatus: buildLiveRestoreState(normalizedSessionId, {
        telemetry,
        stateLedger,
        executionLedger: ledgerRestore,
      }, latestSnapshot, latestCheckpoint),
    };
  }

  function buildResumeState(sessionId, options_ = {}) {
    const latestSnapshot = getLatestSnapshot(sessionId);
    const latestCheckpoint = getLatestCheckpoint(sessionId);
    const recentSnapshots = listSnapshots(sessionId, { limit: options_.snapshotLimit || 10 });
    const recentEvents = listEvents(sessionId, { limit: options_.eventLimit || 25 });
    const coldRestore = options_.includeColdRestore === false
      ? {
          restored: false,
          sources: [],
          latestCheckpoint: null,
          telemetry: null,
          stateLedger: null,
          executionLedger: null,
          liveStatus: null,
        }
      : buildColdRestoreState(sessionId, options_);
    const resolvedCheckpoint = latestCheckpoint || coldRestore.latestCheckpoint || coldRestore.executionLedger?.latestCheckpoint || null;
    const liveStatus = coldRestore.liveStatus || null;
    return {
      sessionId: toTrimmedString(sessionId) || null,
      latestSnapshot,
      latestCheckpoint: resolvedCheckpoint,
      snapshots: recentSnapshots,
      events: recentEvents,
      coldRestore,
      liveStatus,
      resumeFrom: buildResumePointer({
        latestCheckpoint: resolvedCheckpoint,
        latestSnapshot,
        liveStatus,
      }),
    };
  }

  function snapshot() {
    return {
      snapshots: snapshotStore.snapshot(),
      events: Object.fromEntries(
        [...events.entries()].map(([sessionId, entries]) => [sessionId, entries.map((entry) => cloneValue(entry))]),
      ),
    };
  }

  function hydrate(snapshotValue = {}) {
    events.clear();
    snapshotStore.hydrate(snapshotValue?.snapshots || {});
    for (const [sessionId, entries] of Object.entries(snapshotValue?.events || {})) {
      events.set(
        sessionId,
        (Array.isArray(entries) ? entries : []).map((entry) => ({
          eventId: toTrimmedString(entry?.eventId || "") || `event-${randomUUID()}`,
          sessionId: toTrimmedString(entry?.sessionId || sessionId) || sessionId,
          type: toTrimmedString(entry?.type || "event") || "event",
          timestamp: toTrimmedString(entry?.timestamp || "") || nowIso(),
          payload: cloneValue(entry?.payload || {}),
          meta: cloneValue(entry?.meta || {}),
        })),
      );
    }
    return snapshot();
  }

  return {
    captureSnapshot,
    recordEvent,
    listSnapshots,
    listEvents,
    getLatestSnapshot,
    getLatestCheckpoint,
    buildColdRestoreState,
    buildResumeState,
    getSnapshotStore() {
      return snapshotStore;
    },
    snapshot,
    hydrate,
  };
}

export default createSessionReplayStore;
