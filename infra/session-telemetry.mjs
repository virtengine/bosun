import { resolve } from "node:path";

import {
  createCanonicalEventSchema,
  normalizeCanonicalEvent,
} from "./event-schema.mjs";
import { LiveEventProjector } from "./live-event-projector.mjs";
import { createProjectionContract } from "./projection-contract.mjs";
import { ProviderUsageLedger } from "./provider-usage-ledger.mjs";
import { RuntimeMetrics } from "./runtime-metrics.mjs";
import { exportHarnessTrace } from "./trace-export.mjs";
import {
  cloneHotPathValue,
  exportTraceWithBosunHotPathTelemetry,
  getBosunHotPathStatus,
} from "../lib/hot-path-runtime.mjs";
import { createHarnessTelemetryRuntime } from "./session-telemetry-runtime.mjs";

const DEFAULT_MAX_IN_MEMORY_EVENTS = 20_000;
const OBSERVABILITY_SPINES_KEY = Symbol.for("bosun.harnessObservability.spines");
const ALL_OBSERVABILITY_SPINES_KEY = Symbol.for("bosun.harnessObservability.allSpines");
const OBSERVABILITY_SPINES = globalThis[OBSERVABILITY_SPINES_KEY] instanceof Map
  ? globalThis[OBSERVABILITY_SPINES_KEY]
  : new Map();
if (!(globalThis[OBSERVABILITY_SPINES_KEY] instanceof Map)) {
  globalThis[OBSERVABILITY_SPINES_KEY] = OBSERVABILITY_SPINES;
}
const ALL_OBSERVABILITY_SPINES = globalThis[ALL_OBSERVABILITY_SPINES_KEY] instanceof Set
  ? globalThis[ALL_OBSERVABILITY_SPINES_KEY]
  : new Set();
if (!(globalThis[ALL_OBSERVABILITY_SPINES_KEY] instanceof Set)) {
  globalThis[ALL_OBSERVABILITY_SPINES_KEY] = ALL_OBSERVABILITY_SPINES;
}

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const cloneValue = cloneHotPathValue;
const CANONICAL_EVENT_SCHEMA = Object.freeze(createCanonicalEventSchema());
const HARNESS_PROJECTION_CONTRACT = Object.freeze(createProjectionContract());

function isLikelyTestRuntime() {
  if (process.env.BOSUN_TEST_SANDBOX === "1") return true;
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  if (process.env.VITEST_WORKER_ID) return true;
  if (process.env.NODE_ENV === "test") return true;
  const argv = Array.isArray(process.argv) ? process.argv.join(" ").toLowerCase() : "";
  return argv.includes("vitest") || argv.includes("--test");
}

function normalizeFilterTimestamp(value) {
  if (value == null || value === "") return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveHarnessTelemetryPaths(configDir) {
  const root = resolve(String(configDir || process.cwd()), ".cache", "harness", "observability");
  return {
    root,
    eventsPath: resolve(root, "events.jsonl"),
  };
}

export function normalizeCanonicalHarnessEvent(input = {}) {
  return normalizeCanonicalEvent(input);
}

export function createHarnessEventSchema() {
  return cloneValue(CANONICAL_EVENT_SCHEMA);
}

export function createHarnessProjectionContract() {
  return cloneValue(HARNESS_PROJECTION_CONTRACT);
}

export function buildHarnessProjectionFromEvents(events = [], options = {}) {
  const projector = new LiveEventProjector(options);
  const metrics = new RuntimeMetrics();
  const providerUsage = new ProviderUsageLedger();
  const normalizedEvents = (Array.isArray(events) ? events : [])
    .map((event) => normalizeCanonicalHarnessEvent(event));
  for (const event of normalizedEvents) {
    projector.record(event);
    metrics.record(event);
    providerUsage.record(event);
  }
  return {
    schema: createHarnessEventSchema(),
    projectionContract: createHarnessProjectionContract(),
    events: normalizedEvents.map(cloneValue),
    live: projector.getSnapshot(),
    metrics: metrics.getSummary(),
    providers: providerUsage.getUsageSummary(),
  };
}

export class HarnessObservabilitySpine {
  constructor(options = {}) {
    this.configDir = options.configDir;
    this.persist = options.persist ?? !isLikelyTestRuntime();
    this.maxInMemoryEvents = Math.max(
      100,
      Math.trunc(Number(options.maxInMemoryEvents) || DEFAULT_MAX_IN_MEMORY_EVENTS),
    );
    this.maxPersistBatchEvents = Math.max(
      1,
      Math.trunc(Number(options.maxPersistBatchEvents) || 512),
    );
    this.paths = resolveHarnessTelemetryPaths(this.configDir);
    this.projector = new LiveEventProjector(options);
    this.metrics = new RuntimeMetrics();
    this.providerUsage = new ProviderUsageLedger();
    this.runtime = createHarnessTelemetryRuntime({
      persist: this.persist,
      maxInMemoryEvents: this.maxInMemoryEvents,
      maxPersistBatchEvents: this.maxPersistBatchEvents,
      paths: this.paths,
      projector: this.projector,
      metrics: this.metrics,
      providerUsage: this.providerUsage,
    });
    this.schema = CANONICAL_EVENT_SCHEMA;
    this.projectionContract = HARNESS_PROJECTION_CONTRACT;
    this._loaded = false;
    ALL_OBSERVABILITY_SPINES.add(this);
  }

  _loadOnce() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.persist) return;
    this.runtime.restoreFromDisk({ eventsPath: this.paths.eventsPath });
  }

  _ingest(event, options = {}) {
    const normalized = normalizeCanonicalHarnessEvent(event);
    if (options.persist === false) {
      this.runtime.load([normalized]);
      return normalized;
    }
    this.runtime.record(normalized);
    return normalized;
  }

  recordEvent(event = {}) {
    this._loadOnce();
    return this._ingest(event, { persist: true });
  }

  listEvents(filter = {}) {
    this._loadOnce();
    const since = normalizeFilterTimestamp(filter.since);
    let events = this.runtime.getEvents();
    const exactFilterMap = [
      ["source", ["source"]],
      ["type", ["eventType", "type"]],
      ["category", ["category"]],
      ["taskId", ["taskId", "rootTaskId", "parentTaskId", "childTaskId"]],
      ["sessionId", ["sessionId", "rootSessionId", "parentSessionId", "childSessionId", "threadId"]],
      ["runId", ["runId", "rootRunId", "parentRunId", "childRunId"]],
      ["workflowId", ["workflowId"]],
      ["providerId", ["providerId"]],
      ["modelId", ["modelId"]],
      ["toolName", ["toolName", "toolId"]],
      ["approvalId", ["approvalId"]],
      ["actor", ["actor"]],
      ["filePath", ["filePath", "artifactPath"]],
      ["artifactId", ["artifactId"]],
      ["childSessionId", ["childSessionId"]],
      ["childTaskId", ["childTaskId"]],
      ["traceId", ["traceId"]],
      ["spanId", ["spanId", "parentSpanId"]],
      ["executionId", ["executionId", "parentExecutionId", "causedByExecutionId"]],
      ["surface", ["surface"]],
      ["channel", ["channel"]],
      ["action", ["action", "commandName"]],
      ["workspaceId", ["workspaceId"]],
      ["nodeId", ["nodeId"]],
      ["subagentId", ["subagentId"]],
    ];
    for (const [filterKey, candidateKeys] of exactFilterMap) {
      const expected = String(filter[filterKey] || "").trim();
      if (!expected) continue;
      events = events.filter((entry) => candidateKeys.some((key) => String(entry?.[key] || "").trim() === expected));
    }
    if (since != null) {
      events = events.filter((entry) => Number(entry.ts || Date.parse(entry.timestamp || 0)) >= since);
    }
    const limit = Number.isFinite(Number(filter.limit)) && Number(filter.limit) > 0
      ? Math.trunc(Number(filter.limit))
      : null;
    const sliced = limit ? events.slice(-limit) : events;
    return sliced.map(cloneValue);
  }

  getLiveSnapshot() {
    this._loadOnce();
    this.runtime.flushForeground();
    return {
      schema: createHarnessEventSchema(),
      projectionContract: createHarnessProjectionContract(),
      ...this.projector.getSnapshot(),
    };
  }

  getMetricsSummary() {
    this._loadOnce();
    this.runtime.flushForeground();
    return this.metrics.getSummary();
  }

  getProviderUsageSummary() {
    this._loadOnce();
    this.runtime.flushForeground();
    return this.providerUsage.getUsageSummary();
  }

  getSummary() {
    this._loadOnce();
    const events = this.runtime.getEvents();
    const lastEvent = events.at(-1) || null;
    const hotPathBridge = getBosunHotPathStatus();
    return {
      eventCount: events.length,
      lastEventAt: lastEvent?.timestamp || null,
      schema: createHarnessEventSchema(),
      projectionContract: createHarnessProjectionContract(),
      live: this.getLiveSnapshot(),
      metrics: this.getMetricsSummary(),
      providers: this.getProviderUsageSummary(),
      hotPath: {
        mode:
          hotPathBridge.mode === "native" || this.runtime.getStatus().reason === "native"
            ? "native"
            : "javascript",
        bridge: hotPathBridge,
        exec: hotPathBridge.exec,
        telemetryBridge: hotPathBridge.telemetry,
        telemetry: this.runtime.getStatus(),
      },
    };
  }

  exportTrace(filter = {}) {
    this._loadOnce();
    return exportHarnessTrace(this.listEvents(filter), filter);
  }

  async exportTraceAsync(filter = {}) {
    this._loadOnce();
    await this.runtime.flush();
    const nativeTrace = await exportTraceWithBosunHotPathTelemetry(filter);
    return nativeTrace || this.exportTrace(filter);
  }

  async flush() {
    this._loadOnce();
    await this.runtime.flush();
  }

  reset() {
    this._loaded = false;
    this.runtime.reset();
    this.projector.reset();
    this.metrics.reset();
    this.providerUsage.reset();
  }
}

export function getHarnessObservabilitySpine(options = {}) {
  const persist = options.persist ?? !isLikelyTestRuntime();
  const key = `${resolveHarnessTelemetryPaths(options.configDir).root}|${persist ? "persist" : "memory"}`;
  if (!OBSERVABILITY_SPINES.has(key)) {
    OBSERVABILITY_SPINES.set(key, new HarnessObservabilitySpine(options));
  }
  return OBSERVABILITY_SPINES.get(key);
}

export function createHarnessObservabilitySpine(options = {}) {
  return new HarnessObservabilitySpine(options);
}

export function recordHarnessTelemetryEvent(event, options = {}) {
  return getHarnessObservabilitySpine(options).recordEvent(event);
}

export function listHarnessTelemetryEvents(filter = {}, options = {}) {
  return getHarnessObservabilitySpine(options).listEvents(filter);
}

export function getHarnessTelemetrySummary(options = {}) {
  return getHarnessObservabilitySpine(options).getSummary();
}

export function getHarnessLiveTelemetrySnapshot(options = {}) {
  return getHarnessObservabilitySpine(options).getLiveSnapshot();
}

export function getHarnessProviderUsageSummary(options = {}) {
  return getHarnessObservabilitySpine(options).getProviderUsageSummary();
}

export function exportHarnessTelemetryTrace(filter = {}, options = {}) {
  return getHarnessObservabilitySpine(options).exportTrace(filter);
}

export async function exportHarnessTelemetryTraceAsync(filter = {}, options = {}) {
  return await getHarnessObservabilitySpine(options).exportTraceAsync(filter);
}

export function getHarnessHotPathStatus(options = {}) {
  return getHarnessObservabilitySpine(options).getSummary().hotPath;
}

export async function flushHarnessTelemetryRuntimeForTests() {
  await Promise.all(
    [...ALL_OBSERVABILITY_SPINES].map((spine) => spine.flush()),
  );
}

export function resetHarnessObservabilitySpinesForTests() {
  for (const spine of ALL_OBSERVABILITY_SPINES) {
    spine.reset();
  }
  OBSERVABILITY_SPINES.clear();
  ALL_OBSERVABILITY_SPINES.clear();
}
