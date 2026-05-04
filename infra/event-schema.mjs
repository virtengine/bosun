import { randomUUID } from "node:crypto";

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return cloneValue(value);
}

function normalizeTimestamp(value) {
  const text = asText(value);
  if (text) return text;
  return new Date().toISOString();
}

function normalizeTokenUsage(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const inputTokens = asNumber(
    source.inputTokens
    ?? source.promptTokens
    ?? source.prompt_tokens
    ?? source.input_tokens,
  ) || 0;
  const outputTokens = asNumber(
    source.outputTokens
    ?? source.completionTokens
    ?? source.completion_tokens
    ?? source.output_tokens,
  ) || 0;
  const totalTokens = asNumber(
    source.totalTokens
    ?? source.total_tokens
    ?? source.total,
  ) || (inputTokens + outputTokens);
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function pickText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function pickNumber(...values) {
  for (const value of values) {
    const numeric = asNumber(value);
    if (numeric != null) return numeric;
  }
  return null;
}

function trimUndefinedEntries(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

export const CANONICAL_EVENT_SCHEMA_VERSION = 1;
export const CANONICAL_EVENT_CATEGORIES = Object.freeze([
  "agent",
  "approval",
  "artifact",
  "control-plane",
  "provider",
  "runtime",
  "session",
  "subagent",
  "system",
  "telegram",
  "tool",
  "tui",
  "workflow",
]);

export function inferCanonicalEventCategory(eventType, source, payload = {}) {
  const normalizedType = String(eventType || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (
    asText(payload.category)
    || asText(payload.filePath)
    || asText(payload.patchHash)
    || asText(payload.artifactId)
  ) {
    const explicitCategory = asText(payload.category);
    if (explicitCategory) return explicitCategory;
    return "artifact";
  }
  if (
    asText(payload.subagentId)
    || asText(payload.childSessionId)
    || asText(payload.childTaskId)
    || asText(payload.childRunId)
    || normalizedType.includes("subagent")
    || normalizedType.includes("delegate")
  ) return "subagent";
  if (asText(payload.approvalId) || normalizedType.includes("approval")) return "approval";
  if (asText(payload.toolName) || asText(payload.toolId) || normalizedType.includes("tool") || normalizedType.includes("hook")) return "tool";
  if (
    asText(payload.providerId)
    || asText(payload.provider)
    || asText(payload.providerKind)
    || asText(payload.modelId)
    || normalizedType.includes("provider")
    || normalizedType.includes("model")
    || normalizedType.includes("token")
  ) return "provider";
  if (normalizedSource.includes("workflow") || normalizedType.startsWith("node.") || normalizedType.startsWith("run.")) return "workflow";
  if (normalizedType.includes("telegram")) return "telegram";
  if (normalizedType.includes("tui")) return "tui";
  if (normalizedType.includes("task") || normalizedType.includes("session")) return "session";
  if (normalizedType.includes("system") || normalizedSource.includes("monitor")) return "system";
  if (normalizedSource.includes("agent")) return "agent";
  return "runtime";
}

export function normalizeCanonicalEvent(input = {}) {
  const timestamp = normalizeTimestamp(input.timestamp || input.ts);
  const payload = normalizeJsonObject(input.payload);
  const meta = normalizeJsonObject(input.meta);
  const tokenUsage = normalizeTokenUsage(
    input.tokenUsage
    || input.usage
    || payload?.usage
    || meta?.usage,
  );
  const eventType = asText(input.eventType || input.type || payload?.type) || "event";
  const source = asText(input.source || meta?.source) || "unknown";
  const category = asText(input.category) || inferCanonicalEventCategory(eventType, source, {
    ...(payload || {}),
    ...(meta || {}),
    ...input,
  });
  const taskId = pickText(input.taskId, payload?.taskId, meta?.taskId, input.session?.taskId);
  const sessionId = pickText(input.sessionId, payload?.sessionId, meta?.sessionId, input.session?.id) || taskId;
  return trimUndefinedEntries({
    schemaVersion: CANONICAL_EVENT_SCHEMA_VERSION,
    id: asText(input.id || input.eventId) || randomUUID(),
    timestamp,
    ts: asNumber(input.ts) || Date.parse(timestamp),
    eventType,
    type: asText(input.type) || eventType,
    category,
    source,
    taskId,
    sessionId,
    rootTaskId: pickText(input.rootTaskId, payload?.rootTaskId, meta?.rootTaskId),
    parentTaskId: pickText(input.parentTaskId, payload?.parentTaskId, meta?.parentTaskId),
    childTaskId: pickText(input.childTaskId, payload?.childTaskId, meta?.childTaskId),
    delegationDepth: pickNumber(input.delegationDepth, payload?.delegationDepth, meta?.delegationDepth),
    threadId: pickText(input.threadId, payload?.threadId, meta?.threadId),
    turnId: pickText(input.turnId, payload?.turnId, meta?.turnId),
    runId: pickText(input.runId, payload?.runId, meta?.runId),
    rootRunId: pickText(input.rootRunId, payload?.rootRunId, meta?.rootRunId),
    parentRunId: pickText(input.parentRunId, payload?.parentRunId, meta?.parentRunId),
    childRunId: pickText(input.childRunId, payload?.childRunId, meta?.childRunId),
    workflowId: pickText(input.workflowId, payload?.workflowId, meta?.workflowId),
    workflowName: pickText(input.workflowName, payload?.workflowName, meta?.workflowName),
    nodeId: pickText(input.nodeId, payload?.nodeId, meta?.nodeId),
    nodeType: pickText(input.nodeType, payload?.nodeType, meta?.nodeType),
    nodeLabel: pickText(input.nodeLabel, payload?.nodeLabel, meta?.nodeLabel),
    stageId: pickText(input.stageId, payload?.stageId, meta?.stageId),
    stageType: pickText(input.stageType, payload?.stageType, meta?.stageType),
    providerId: pickText(input.providerId, input.provider, payload?.providerId, payload?.provider, meta?.providerId, meta?.provider),
    providerKind: pickText(input.providerKind, payload?.providerKind, meta?.providerKind),
    providerTurnId: pickText(input.providerTurnId, payload?.providerTurnId, meta?.providerTurnId),
    modelId: pickText(input.modelId, payload?.modelId, meta?.modelId),
    requestId: pickText(input.requestId, payload?.requestId, meta?.requestId),
    traceId: pickText(input.traceId, payload?.traceId, meta?.traceId),
    spanId: pickText(input.spanId, payload?.spanId, meta?.spanId),
    parentSpanId: pickText(input.parentSpanId, payload?.parentSpanId, meta?.parentSpanId),
    executionId: pickText(input.executionId, payload?.executionId, meta?.executionId),
    executionKey: pickText(input.executionKey, payload?.executionKey, meta?.executionKey),
    executionKind: pickText(input.executionKind, payload?.executionKind, meta?.executionKind),
    executionLabel: pickText(input.executionLabel, payload?.executionLabel, meta?.executionLabel),
    parentExecutionId: pickText(input.parentExecutionId, payload?.parentExecutionId, meta?.parentExecutionId),
    causedByExecutionId: pickText(input.causedByExecutionId, payload?.causedByExecutionId, meta?.causedByExecutionId),
    rootSessionId: pickText(input.rootSessionId, payload?.rootSessionId, meta?.rootSessionId),
    parentSessionId: pickText(input.parentSessionId, payload?.parentSessionId, meta?.parentSessionId),
    childSessionId: pickText(input.childSessionId, payload?.childSessionId, meta?.childSessionId),
    subagentId: pickText(input.subagentId, payload?.subagentId, meta?.subagentId),
    toolId: pickText(input.toolId, payload?.toolId, meta?.toolId),
    toolName: pickText(input.toolName, input.name, payload?.toolName, payload?.name, meta?.toolName),
    approvalId: pickText(input.approvalId, payload?.approvalId, meta?.approvalId),
    artifactId: pickText(input.artifactId, payload?.artifactId, meta?.artifactId),
    artifactPath: pickText(input.artifactPath, input.filePath, payload?.artifactPath, payload?.filePath, meta?.artifactPath, meta?.filePath),
    filePath: pickText(input.filePath, payload?.filePath, meta?.filePath, input.artifactPath, payload?.artifactPath, meta?.artifactPath),
    fileHash: pickText(input.fileHash, payload?.fileHash, meta?.fileHash),
    patchHash: pickText(input.patchHash, payload?.patchHash, meta?.patchHash),
    commandId: pickText(input.commandId, payload?.commandId, meta?.commandId),
    commandName: pickText(input.commandName, payload?.commandName, meta?.commandName),
    surface: pickText(input.surface, payload?.surface, meta?.surface),
    channel: pickText(input.channel, payload?.channel, meta?.channel),
    action: pickText(input.action, payload?.action, meta?.action),
    workspaceId: pickText(input.workspaceId, payload?.workspaceId, meta?.workspaceId),
    repoRoot: pickText(input.repoRoot, payload?.repoRoot, meta?.repoRoot),
    branch: pickText(input.branch, payload?.branch, meta?.branch),
    prNumber: pickNumber(input.prNumber, payload?.prNumber, meta?.prNumber),
    prUrl: pickText(input.prUrl, payload?.prUrl, meta?.prUrl),
    actor: pickText(input.actor, payload?.actor, meta?.actor),
    status: pickText(input.status, payload?.status, meta?.status),
    attempt: pickNumber(input.attempt, payload?.attempt, meta?.attempt),
    retryCount: pickNumber(input.retryCount, payload?.retryCount, meta?.retryCount),
    durationMs: pickNumber(input.durationMs, payload?.durationMs, meta?.durationMs),
    latencyMs: pickNumber(input.latencyMs, input.durationMs, payload?.latencyMs, payload?.durationMs, meta?.latencyMs, meta?.durationMs),
    costUsd: pickNumber(input.costUsd, input.cost, payload?.costUsd, payload?.cost, meta?.costUsd, meta?.cost),
    tokenUsage,
    summary: asText(input.summary || payload?.summary || meta?.summary),
    reason: asText(input.reason || payload?.reason || meta?.reason),
    message: asText(input.message || input.content || payload?.message || payload?.content),
    payload,
    meta,
  });
}

export function normalizeCanonicalBusEvent(event = {}) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  return normalizeCanonicalEvent({
    id: payload.eventId || payload.id || undefined,
    timestamp: new Date(Number(event.ts || Date.now())).toISOString(),
    ts: Number(event.ts || Date.now()),
    type: event.type,
    eventType: event.type,
    source: "agent-event-bus",
    category: payload.category || inferCanonicalEventCategory(event.type, "agent-event-bus", payload),
    taskId: event.taskId,
    sessionId: payload.sessionId || payload.threadId || event.taskId,
    rootTaskId: payload.rootTaskId || null,
    parentTaskId: payload.parentTaskId || null,
    childTaskId: payload.childTaskId || null,
    delegationDepth: payload.delegationDepth || null,
    threadId: payload.threadId || null,
    runId: payload.runId || null,
    rootRunId: payload.rootRunId || null,
    parentRunId: payload.parentRunId || null,
    childRunId: payload.childRunId || null,
    workflowId: payload.workflowId || null,
    workflowName: payload.workflowName || null,
    nodeId: payload.nodeId || null,
    nodeType: payload.nodeType || null,
    nodeLabel: payload.nodeLabel || null,
    stageId: payload.stageId || null,
    stageType: payload.stageType || null,
    providerId: payload.providerId || payload.provider || payload.sdk || null,
    providerKind: payload.providerKind || null,
    providerTurnId: payload.providerTurnId || null,
    modelId: payload.modelId || null,
    requestId: payload.requestId || null,
    traceId: payload.traceId || null,
    spanId: payload.spanId || null,
    parentSpanId: payload.parentSpanId || null,
    executionId: payload.executionId || null,
    executionKey: payload.executionKey || null,
    executionKind: payload.executionKind || null,
    executionLabel: payload.executionLabel || null,
    parentExecutionId: payload.parentExecutionId || null,
    causedByExecutionId: payload.causedByExecutionId || null,
    rootSessionId: payload.rootSessionId || null,
    parentSessionId: payload.parentSessionId || null,
    childSessionId: payload.childSessionId || null,
    subagentId: payload.subagentId || null,
    toolId: payload.toolId || null,
    toolName: payload.toolName || payload.hookId || null,
    approvalId: payload.approvalId || payload.requestId || null,
    artifactId: payload.artifactId || null,
    artifactPath: payload.artifactPath || payload.filePath || null,
    filePath: payload.filePath || payload.artifactPath || null,
    fileHash: payload.fileHash || null,
    patchHash: payload.patchHash || null,
    commandId: payload.commandId || null,
    commandName: payload.commandName || null,
    surface: payload.surface || null,
    channel: payload.channel || null,
    action: payload.action || null,
    workspaceId: payload.workspaceId || null,
    repoRoot: payload.repoRoot || null,
    branch: payload.branch || null,
    prNumber: payload.prNumber || null,
    prUrl: payload.prUrl || null,
    actor: payload.actor || payload.source || "agent-event-bus",
    status: payload.status || null,
    attempt: payload.attempt || null,
    retryCount: payload.retryCount || null,
    durationMs: payload.durationMs || null,
    latencyMs: payload.latencyMs || payload.durationMs || null,
    costUsd: payload.costUsd || payload.cost || null,
    tokenUsage: payload.tokenUsage || payload.usage || null,
    summary: payload.summary || payload.title || payload.reason || payload.message || payload.error || null,
    reason: payload.reason || payload.error || null,
    message: payload.message || payload.error || null,
    payload,
    meta: {
      source: "agent-event-bus",
      taskStatus: payload.taskStatus || null,
      sdk: payload.sdk || null,
      branch: payload.branch || null,
      ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
    },
  });
}

export function createCanonicalEventSchema() {
  return {
    schemaVersion: CANONICAL_EVENT_SCHEMA_VERSION,
    kind: "bosun-canonical-event-schema",
    requiredIdentifiers: ["id", "timestamp", "eventType"],
    lineageIdentifiers: [
      "sessionId",
      "threadId",
      "runId",
      "rootRunId",
      "parentRunId",
      "rootSessionId",
      "parentSessionId",
      "childSessionId",
      "taskId",
      "rootTaskId",
      "parentTaskId",
      "childTaskId",
      "subagentId",
      "approvalId",
      "executionId",
      "parentExecutionId",
      "causedByExecutionId",
    ],
    categories: [...CANONICAL_EVENT_CATEGORIES],
    eventTypeNamingRule: "dot.separated or namespace:qualified runtime event names are allowed, but persisted events normalize to eventType plus timestamp/id lineage.",
    timestampRule: "timestamp is required as ISO-8601; ts is the derived epoch-millis field used for filtering and ordering.",
    payloadRule: "payload/meta remain optional normalized JSON objects; primary queryable identifiers must be lifted to top-level fields.",
  };
}

export default normalizeCanonicalEvent;
