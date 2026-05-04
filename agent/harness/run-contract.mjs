const HARNESS_RUN_VERB_SET = new Set([
  "initial",
  "continue",
  "retry",
  "steer",
  "followup",
  "abort",
  "resume",
]);

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

export const HARNESS_RUN_CONTRACT_SCHEMA_VERSION = 1;
export const HARNESS_RUN_VERBS = Object.freeze([...HARNESS_RUN_VERB_SET]);
export const HARNESS_RUN_ACTIONS = HARNESS_RUN_VERBS;

export function normalizeHarnessRunVerb(value, fallback = "initial") {
  const normalized = toTrimmedString(value).toLowerCase();
  return HARNESS_RUN_VERB_SET.has(normalized)
    ? normalized
    : fallback;
}

export function createHarnessRunContract(input = {}, defaults = {}) {
  const source = input && typeof input === "object"
    ? input
    : { prompt: input };
  const metadata = {
    ...toPlainObject(defaults.metadata),
    ...toPlainObject(source.metadata),
  };
  const prompt = toTrimmedString(source.prompt || source.message || "");
  const followupMessage = toTrimmedString(source.followupMessage || metadata.followupMessage || "");
  const requestedStageId = toTrimmedString(source.requestedStageId || metadata.requestedStageId || "") || null;
  const verb = normalizeHarnessRunVerb(
    source.verb || metadata.verb || defaults.verb,
    normalizeHarnessRunVerb(defaults.verb, "initial"),
  );

  const runId = toTrimmedString(source.runId || defaults.runId || "") || null;
  const rootRunId = toTrimmedString(source.rootRunId || defaults.rootRunId || "") || null;
  const parentRunId = toTrimmedString(source.parentRunId || defaults.parentRunId || "") || null;
  const sessionId = toTrimmedString(source.sessionId || defaults.sessionId || "") || null;
  const threadId = toTrimmedString(source.threadId || defaults.threadId || "") || null;
  const taskKey = toTrimmedString(source.taskKey || defaults.taskKey || "") || null;
  const taskId = toTrimmedString(source.taskId || defaults.taskId || "") || null;
  const taskTitle = toTrimmedString(source.taskTitle || defaults.taskTitle || "") || null;
  const surface = toTrimmedString(source.surface || metadata.surface || defaults.surface || "") || null;
  const channel = toTrimmedString(source.channel || metadata.channel || defaults.channel || "") || null;
  const actor = toTrimmedString(source.actor || metadata.actor || metadata.requestedBy || defaults.actor || "") || null;
  const retryOfRunId = toTrimmedString(source.retryOfRunId || metadata.retryOfRunId || defaults.retryOfRunId || "") || null;
  const resumeFromRunId = toTrimmedString(source.resumeFromRunId || metadata.resumeFromRunId || defaults.resumeFromRunId || "") || null;

  metadata.parentRunId = metadata.parentRunId || parentRunId;
  metadata.rootRunId = metadata.rootRunId || rootRunId;
  metadata.runId = metadata.runId || runId;
  metadata.sessionId = metadata.sessionId || sessionId;
  metadata.taskKey = metadata.taskKey || taskKey;
  metadata.taskId = metadata.taskId || taskId;
  metadata.taskTitle = metadata.taskTitle || taskTitle;
  metadata.requestId = toTrimmedString(metadata.requestId || source.requestId || defaults.requestId || "") || null;
  metadata.traceId = toTrimmedString(metadata.traceId || source.traceId || defaults.traceId || "") || null;
  metadata.surface = metadata.surface || surface;
  metadata.channel = metadata.channel || channel;
  metadata.requestedBy = metadata.requestedBy || actor;

  return {
    schemaVersion: HARNESS_RUN_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-internal-harness-run-contract",
    supportedActions: HARNESS_RUN_VERBS,
    requiredMetadataFields: ["runId", "sessionId", "taskKey"],
    verb,
    requestedAt: toTrimmedString(source.requestedAt || defaults.requestedAt || new Date().toISOString()) || new Date().toISOString(),
    runId,
    rootRunId,
    parentRunId,
    sessionId,
    threadId,
    taskKey,
    taskId,
    taskTitle,
    surface,
    channel,
    actor,
    requestedStageId,
    retryOfRunId,
    resumeFromRunId,
    prompt: prompt || null,
    followupMessage: followupMessage || null,
    metadata,
  };
}

export function normalizeHarnessRunInput(input = {}, defaults = {}) {
  const source = input && typeof input === "object"
    ? input
    : { prompt: input };
  const action = normalizeHarnessRunVerb(source.action || source.verb || defaults.action || defaults.verb, "initial");
  const metadata = {
    ...toPlainObject(defaults.metadata),
    ...toPlainObject(source.metadata),
  };
  metadata.runId = toTrimmedString(metadata.runId || defaults.runId || "") || null;
  metadata.sessionId = toTrimmedString(metadata.sessionId || defaults.sessionId || "") || null;
  metadata.taskKey = toTrimmedString(metadata.taskKey || defaults.taskKey || "") || null;
  return {
    action,
    verb: action,
    prompt: toTrimmedString(source.prompt || source.message || ""),
    metadata,
  };
}

export default createHarnessRunContract;
