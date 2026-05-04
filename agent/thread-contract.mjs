import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export const THREAD_CONTRACT_SCHEMA_VERSION = 1;
export const THREAD_STATUS_VALUES = Object.freeze([
  "idle",
  "running",
  "waiting_approval",
  "resuming",
  "replaying",
  "completed",
  "failed",
  "aborted",
  "closed",
  "dry_run",
  "invalidated",
]);

const TERMINAL_THREAD_STATES = new Set(["completed", "failed", "aborted", "closed", "invalidated"]);

const THREAD_STATUS_ALIASES = Object.freeze({
  active: "running",
  ready: "idle",
  errored: "failed",
  complete: "completed",
  cancelled: "aborted",
  canceled: "aborted",
});

export function normalizeThreadStatus(value, fallback = "idle") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  const aliased = THREAD_STATUS_ALIASES[normalized] || normalized;
  if (THREAD_STATUS_VALUES.includes(aliased)) return aliased;
  return aliased.replace(/[^a-z0-9_-]+/g, "_") || fallback;
}

export const normalizeThreadLifecycleState = normalizeThreadStatus;

export function isTerminalThreadStatus(value) {
  return TERMINAL_THREAD_STATES.has(normalizeThreadStatus(value, ""));
}

export const isTerminalThreadState = isTerminalThreadStatus;

export function createBosunThreadId(prefix = "thread") {
  const normalized = toTrimmedString(prefix).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "thread";
  return `${normalized}-${randomUUID()}`;
}

export function createThreadContract(input = {}) {
  const record = toPlainObject(input);
  return {
    schemaVersion: THREAD_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-thread-contract",
    idRules: {
      generator: "createBosunThreadId",
      requiredIdentifiers: ["threadId", "rootThreadId"],
      rootLineageIdentifiers: ["parentThreadId", "parentSessionId", "rootThreadId", "rootSessionId"],
    },
    lineageRules: {
      attachByParentThreadId: true,
      inheritRootIdentifiersFromParent: true,
      lineageDepthField: "lineageDepth",
    },
    statuses: [...THREAD_STATUS_VALUES],
    terminalStatuses: [...TERMINAL_THREAD_STATES],
    currentRecord: {
      threadId: toTrimmedString(record.threadId || "") || null,
      sessionId: toTrimmedString(record.sessionId || "") || null,
      rootThreadId: toTrimmedString(record.rootThreadId || "") || null,
      rootSessionId: toTrimmedString(record.rootSessionId || "") || null,
      status: normalizeThreadStatus(record.status || "idle"),
      metadata: toPlainObject(record.metadata),
    },
  };
}

export default createThreadContract;
