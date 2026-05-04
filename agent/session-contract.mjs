import { randomUUID } from "node:crypto";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export const SESSION_CONTRACT_SCHEMA_VERSION = 1;
export const SESSION_STATUS_VALUES = Object.freeze([
  "idle",
  "running",
  "waiting_approval",
  "resuming",
  "replaying",
  "retrying",
  "blocked",
  "completed",
  "failed",
  "aborted",
  "dry_run",
  "approval_denied",
  "approval_expired",
  "invalid_stage",
  "loop_limit_exceeded",
]);
export const SESSION_LIFECYCLE_STATES = SESSION_STATUS_VALUES;

const TERMINAL_SESSION_STATES = new Set([
  "completed",
  "failed",
  "aborted",
  "approval_denied",
  "approval_expired",
  "invalid_stage",
  "loop_limit_exceeded",
]);

const SESSION_STATUS_ALIASES = Object.freeze({
  active: "running",
  approved: "running",
  complete: "completed",
  cancelled: "aborted",
  canceled: "aborted",
  denied: "approval_denied",
  expired: "approval_expired",
  error: "failed",
});

export function normalizeSessionStatus(value, fallback = "idle") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  const aliased = SESSION_STATUS_ALIASES[normalized] || normalized;
  if (SESSION_STATUS_VALUES.includes(aliased)) return aliased;
  return aliased.replace(/[^a-z0-9_-]+/g, "_") || fallback;
}

export const normalizeSessionLifecycleState = normalizeSessionStatus;

export function isTerminalSessionStatus(value) {
  return TERMINAL_SESSION_STATES.has(normalizeSessionStatus(value, ""));
}

export const isTerminalSessionState = isTerminalSessionStatus;

export function canTransitionSessionStatus(fromState, toState) {
  const from = normalizeSessionStatus(fromState, "idle");
  const to = normalizeSessionStatus(toState, from);
  if (from === to) return true;
  if (!isTerminalSessionStatus(from)) return true;
  return ["resuming", "replaying", "retrying", "running"].includes(to);
}

export const canTransitionSessionState = canTransitionSessionStatus;

export function createBosunSessionId(prefix = "session") {
  const normalized = toTrimmedString(prefix).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "session";
  return `${normalized}-${randomUUID()}`;
}

export function buildSessionIdentifiers(input = {}, parentRecord = null) {
  const sessionId = toTrimmedString(input.sessionId || input.id || input.logicalSessionId || "")
    || createBosunSessionId(input.profileName || input.agentId || "session");
  const runId = toTrimmedString(input.runId || sessionId) || sessionId;
  const rootSessionId = toTrimmedString(
    input.rootSessionId || parentRecord?.rootSessionId || parentRecord?.sessionId || sessionId,
  ) || sessionId;
  return {
    sessionId,
    runId,
    rootSessionId,
  };
}

export function createSessionContract(input = {}) {
  const record = toPlainObject(input);
  const identifiers = buildSessionIdentifiers(record);
  return {
    schemaVersion: SESSION_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-session-contract",
    sessionId: identifiers.sessionId,
    runId: identifiers.runId,
    rootSessionId: identifiers.rootSessionId,
    requiredIdentifiers: ["sessionId", "runId", "rootSessionId"],
    currentIdentifiers: identifiers,
    lifecycleStates: [...SESSION_STATUS_VALUES],
    terminalStates: [...TERMINAL_SESSION_STATES],
    validTransitionRule: "Any non-terminal state may transition freely; terminal states may only move to resuming, replaying, retrying, or running.",
    resumeFields: ["replayCursor", "replayedFromSessionId", "replayFromSnapshotId"],
    providerSessionFields: ["providerSelection", "adapterName", "providerSessionId"],
    runtimeTurnFields: ["activeThreadId", "threadIds", "currentStageId", "lastActiveAt"],
    sessionRecord: {
      sessionType: toTrimmedString(record.sessionType || "") || null,
      parentSessionId: toTrimmedString(record.parentSessionId || "") || null,
      parentThreadId: toTrimmedString(record.parentThreadId || "") || null,
      lineageDepth: Number.isFinite(Number(record.lineageDepth)) ? Number(record.lineageDepth) : 0,
      status: normalizeSessionStatus(record.status || "idle"),
      metadata: toPlainObject(record.metadata),
    },
  };
}

export default createSessionContract;
