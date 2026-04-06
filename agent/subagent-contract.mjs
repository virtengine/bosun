function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export const SUBAGENT_CONTRACT_SCHEMA_VERSION = 2;
export const SUBAGENT_STATUS_VALUES = Object.freeze([
  "planned",
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "aborted",
]);

const TERMINAL_SUBAGENT_STATES = new Set(["completed", "failed", "aborted"]);

export function normalizeSubagentStatus(value, fallback = "pending") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  if (SUBAGENT_STATUS_VALUES.includes(normalized)) return normalized;
  return normalized.replace(/[^a-z0-9_-]+/g, "_") || fallback;
}

export function isTerminalSubagentStatus(value) {
  return TERMINAL_SUBAGENT_STATES.has(normalizeSubagentStatus(value, ""));
}

export function createSubagentContract(input = {}) {
  const record = toPlainObject(input);
  const contract = toPlainObject(record.contract);
  const toolPolicy = toPlainObject(contract.toolPolicy || record.toolPolicy);
  const memoryPolicy = toPlainObject(contract.memoryPolicy || record.memoryPolicy);
  const reportingPolicy = toPlainObject(contract.reportingPolicy || record.reportingPolicy);
  const escalationPolicy = toPlainObject(contract.escalationPolicy || record.escalationPolicy);
  const allowedTools = Array.isArray(toolPolicy.allowedTools)
    ? toolPolicy.allowedTools.map((entry) => toTrimmedString(entry)).filter(Boolean)
    : [];
  const deniedTools = Array.isArray(toolPolicy.deniedTools)
    ? toolPolicy.deniedTools.map((entry) => toTrimmedString(entry)).filter(Boolean)
    : [];
  return {
    schemaVersion: SUBAGENT_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-subagent-contract",
    spawnRecordShape: [
      "spawnId",
      "parentSessionId",
      "parentThreadId",
      "childSessionId",
      "childThreadId",
      "taskKey",
      "role",
      "status",
      "completedAt",
      "lastError",
      "lastEventType",
    ],
    statuses: [...SUBAGENT_STATUS_VALUES],
    terminalStatuses: [...TERMINAL_SUBAGENT_STATES],
    completionPropagation: "Child completion, failure, and abort updates are recorded here and surfaced to parent sessions via session-manager.",
    waitSemantics: ["waitForSubagent", "completeSubagent", "failSubagent", "abortSubagent", "getSpawnState"],
    delegationRules: {
      freshConversation: contract.freshConversation !== false,
      allowNestedDelegation: toolPolicy.allowNestedDelegation === true,
      inheritedMemoryMode: toTrimmedString(memoryPolicy.mode || "read_only") || "read_only",
      progressReportingMode: toTrimmedString(reportingPolicy.mode || "one_way_progress") || "one_way_progress",
      escalationMode: toTrimmedString(escalationPolicy.mode || "none") || "none",
    },
    currentRecord: {
      spawnId: toTrimmedString(record.spawnId || "") || null,
      parentSessionId: toTrimmedString(record.parentSessionId || "") || null,
      parentThreadId: toTrimmedString(record.parentThreadId || "") || null,
      childSessionId: toTrimmedString(record.childSessionId || "") || null,
      childThreadId: toTrimmedString(record.childThreadId || "") || null,
      status: normalizeSubagentStatus(record.status || "pending"),
      metadata: toPlainObject(record.metadata),
      toolPolicy: {
        allowedTools,
        deniedTools,
        allowNestedDelegation: toolPolicy.allowNestedDelegation === true,
      },
      memoryPolicy: {
        mode: toTrimmedString(memoryPolicy.mode || "read_only") || "read_only",
        inheritedState: toPlainObject(memoryPolicy.inheritedState),
      },
      reportingPolicy: {
        mode: toTrimmedString(reportingPolicy.mode || "one_way_progress") || "one_way_progress",
        progressOnly: reportingPolicy.progressOnly !== false,
      },
      escalationPolicy: {
        mode: toTrimmedString(escalationPolicy.mode || "none") || "none",
        waitForResponse: escalationPolicy.waitForResponse === true,
      },
    },
  };
}

export default createSubagentContract;
