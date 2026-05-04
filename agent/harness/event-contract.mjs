import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function inferHarnessEventCategory(type) {
  const normalized = toTrimmedString(type).toLowerCase();
  if (!normalized) return "runtime";
  if (normalized.includes("approval")) return "approval";
  if (normalized.includes("intervention") || normalized.includes("steer")) return "intervention";
  if (normalized.includes("followup")) return "followup";
  if (normalized.includes("stage")) return "turn";
  if (normalized.includes("session")) return "session";
  return "runtime";
}

export const HARNESS_EVENT_CONTRACT_SCHEMA_VERSION = 1;
export const HARNESS_EVENT_TYPES = Object.freeze([
  "harness:session-start",
  "harness:stage-start",
  "harness:stage-result",
  "harness:stage-transition",
  "harness:stage-backoff",
  "harness:stage-failed",
  "harness:approval-requested",
  "harness:approval-resolved",
  "harness:intervention-requested",
  "harness:intervention-delivered",
  "harness:followup-queued",
  "harness:completed",
  "harness:failed",
  "harness:aborted",
]);

export function isHarnessEventType(value) {
  return HARNESS_EVENT_TYPES.includes(toTrimmedString(value));
}

export function createHarnessEventContract(options = {}) {
  const runtimeConfig = options.runtimeConfig && typeof options.runtimeConfig === "object"
    ? options.runtimeConfig
    : {};
  const runContract = options.runContract && typeof options.runContract === "object"
    ? options.runContract
    : {};
  return {
    schemaVersion: HARNESS_EVENT_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-internal-harness-event-contract",
    eventTypes: HARNESS_EVENT_TYPES,
    requiredFields: ["type", "timestamp", "runId", "sessionId", "taskKey"],
    defaults: {
      source: toTrimmedString(options.source || "internal-harness-runtime") || "internal-harness-runtime",
      runId: runContract.runId || null,
      rootRunId: runContract.rootRunId || runContract.metadata?.rootRunId || null,
      parentRunId: runContract.parentRunId || runContract.metadata?.parentRunId || null,
      sessionId: runContract.sessionId || null,
      taskKey: runContract.taskKey || runtimeConfig.surface?.taskKey || null,
      taskId: runContract.taskId || runtimeConfig.surface?.taskId || null,
      taskTitle: runContract.taskTitle || runtimeConfig.surface?.taskTitle || null,
      actor: runContract.actor || runContract.metadata?.requestedBy || runtimeConfig.surface?.requestedBy || null,
      verb: runContract.verb || null,
      payload: {
        runtimeConfigKind: runtimeConfig.kind || null,
      },
    },
  };
}

export function normalizeHarnessEvent(event = {}, defaults = {}) {
  const sourceEvent = event && typeof event === "object" ? event : {};
  const type = toTrimmedString(event.type || event.eventType || defaults.type || defaults.eventType || "harness:event")
    || "harness:event";
  const timestamp = toTrimmedString(event.timestamp || defaults.timestamp || new Date().toISOString())
    || new Date().toISOString();
  const payload = {
    ...toPlainObject(defaults.payload),
    ...toPlainObject(event.payload),
  };

  return {
    ...sourceEvent,
    schemaVersion: HARNESS_EVENT_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-harness-event",
    id: toTrimmedString(event.id || defaults.id || "") || randomUUID(),
    sequence: Number.isFinite(Number(event.sequence))
      ? Number(event.sequence)
      : Number.isFinite(Number(defaults.sequence))
        ? Number(defaults.sequence)
        : null,
    type,
    eventType: type,
    category: toTrimmedString(event.category || defaults.category || inferHarnessEventCategory(type)) || "runtime",
    source: toTrimmedString(event.source || defaults.source || "internal-harness-runtime") || "internal-harness-runtime",
    timestamp,
    runId: toTrimmedString(event.runId || defaults.runId || "") || null,
    rootRunId: toTrimmedString(event.rootRunId || defaults.rootRunId || "") || null,
    parentRunId: toTrimmedString(event.parentRunId || defaults.parentRunId || "") || null,
    sessionId: toTrimmedString(event.sessionId || defaults.sessionId || "") || null,
    threadId: toTrimmedString(event.threadId || defaults.threadId || "") || null,
    taskKey: toTrimmedString(event.taskKey || defaults.taskKey || "") || null,
    taskId: toTrimmedString(event.taskId || defaults.taskId || "") || null,
    taskTitle: toTrimmedString(event.taskTitle || defaults.taskTitle || "") || null,
    stageId: toTrimmedString(event.stageId || defaults.stageId || "") || null,
    stageType: toTrimmedString(event.stageType || defaults.stageType || "") || null,
    verb: toTrimmedString(event.verb || defaults.verb || "") || null,
    status: toTrimmedString(event.status || defaults.status || "") || null,
    actor: toTrimmedString(event.actor || defaults.actor || "") || null,
    reason: toTrimmedString(event.reason || defaults.reason || "") || null,
    toStageId: toTrimmedString(event.toStageId || defaults.toStageId || "") || null,
    requestId: toTrimmedString(event.requestId || defaults.requestId || "") || null,
    approvalId: toTrimmedString(event.approvalId || defaults.approvalId || "") || null,
    toolName: toTrimmedString(event.toolName || defaults.toolName || "") || null,
    payload,
    result: event.result ?? defaults.result ?? null,
  };
}

export default normalizeHarnessEvent;
