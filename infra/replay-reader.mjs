import { existsSync, readFileSync } from "node:fs";

import { normalizeCanonicalEvent } from "./event-schema.mjs";
import {
  buildHarnessProjectionFromEvents,
  resolveHarnessTelemetryPaths,
} from "./session-telemetry.mjs";
import {
  listHarnessRunEventsFromStateLedger,
  listHarnessRunsFromStateLedger,
  listWorkflowEventsFromStateLedger,
  listWorkflowRunsFromStateLedger,
} from "../lib/state-ledger-sqlite.mjs";

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
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
}

function applyFilters(events = [], filter = {}) {
  let filtered = [...events];
  const exactKeys = [
    "taskId",
    "sessionId",
    "runId",
    "rootRunId",
    "workflowId",
    "providerId",
    "toolName",
    "approvalId",
    "subagentId",
    "childSessionId",
    "filePath",
  ];
  for (const key of exactKeys) {
    const expected = asText(filter[key]);
    if (!expected) continue;
    filtered = filtered.filter((event) => asText(event?.[key]) === expected);
  }
  return filtered;
}

export class ReplayReader {
  constructor(options = {}) {
    this.configDir = options.configDir;
    this.anchorPath = options.anchorPath;
  }

  listPersistedTelemetryEvents(filter = {}) {
    const paths = resolveHarnessTelemetryPaths(this.configDir);
    const events = readJsonLines(paths.eventsPath).map((entry) => normalizeCanonicalEvent(entry));
    return applyFilters(events, filter);
  }

  listStateLedgerEvents(options = {}) {
    const anchorPath = options.anchorPath || this.anchorPath;
    const workflowRunIds = Array.isArray(options.workflowRunIds) ? options.workflowRunIds : [];
    const harnessRunIds = Array.isArray(options.harnessRunIds) ? options.harnessRunIds : [];
    const events = [];

    const resolvedWorkflowRunIds = workflowRunIds.length > 0
      ? workflowRunIds
      : listWorkflowRunsFromStateLedger({ anchorPath }).map((run) => run.runId).filter(Boolean);
    for (const runId of resolvedWorkflowRunIds) {
      for (const event of listWorkflowEventsFromStateLedger(runId, { anchorPath })) {
        events.push(normalizeCanonicalEvent({
          ...event,
          eventType: event.eventType || event.type,
          type: event.type || event.eventType,
          source: event.source || "workflow-execution-ledger",
        }));
      }
    }

    const resolvedHarnessRunIds = harnessRunIds.length > 0
      ? harnessRunIds
      : listHarnessRunsFromStateLedger({ anchorPath }).map((run) => run.runId).filter(Boolean);
    for (const runId of resolvedHarnessRunIds) {
      for (const event of listHarnessRunEventsFromStateLedger(runId, { anchorPath })) {
        events.push(normalizeCanonicalEvent({
          ...event,
          eventType: event.eventType || event.type,
          type: event.type || event.eventType,
          runId: event.runId || runId,
          source: event.source || "state-ledger-sqlite",
        }));
      }
    }

    events.sort((left, right) => {
      const leftTs = Number(left?.ts || Date.parse(left?.timestamp || 0));
      const rightTs = Number(right?.ts || Date.parse(right?.timestamp || 0));
      if (leftTs !== rightTs) return leftTs - rightTs;
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    });
    return applyFilters(events, options);
  }

  readTelemetryProjection(filter = {}) {
    return buildHarnessProjectionFromEvents(this.listPersistedTelemetryEvents(filter));
  }

  readStateLedgerProjection(options = {}) {
    return buildHarnessProjectionFromEvents(this.listStateLedgerEvents(options));
  }
}

export function createReplayReader(options = {}) {
  return new ReplayReader(options);
}

export function buildReplayProjectionFromEvents(events = []) {
  return buildHarnessProjectionFromEvents(
    (Array.isArray(events) ? events : []).map((event) => normalizeCanonicalEvent(event)),
  );
}

export default createReplayReader;
