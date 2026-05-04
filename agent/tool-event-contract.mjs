function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeError(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || String(value);
  return String(value?.message || value);
}

function buildLineage(context = {}, envelope = {}, detail = {}) {
  const source = {
    ...(envelope?.lineage && typeof envelope.lineage === "object" ? envelope.lineage : {}),
    ...(detail?.lineage && typeof detail.lineage === "object" ? detail.lineage : {}),
  };
  return {
    sessionId: normalizeText(source.sessionId || context.sessionId) || null,
    rootSessionId: normalizeText(source.rootSessionId || context.rootSessionId) || null,
    parentSessionId: normalizeText(source.parentSessionId || context.parentSessionId) || null,
    threadId: normalizeText(source.threadId || context.threadId) || null,
    turnId: normalizeText(source.turnId || context.turnId) || null,
    runId: normalizeText(source.runId || context.runId) || null,
    workflowId: normalizeText(source.workflowId || context.workflowId) || null,
    taskId: normalizeText(source.taskId || context.taskId) || null,
    providerId: normalizeText(source.providerId || context.providerId) || null,
    providerTurnId: normalizeText(source.providerTurnId || context.providerTurnId) || null,
  };
}

export function normalizeToolEvent(event = {}) {
  const context = event?.context && typeof event.context === "object"
    ? cloneJson(event.context)
    : {};
  const lineage = buildLineage(context, {}, event);
  const policy = event?.policy && typeof event.policy === "object"
    ? cloneJson(event.policy)
    : null;
  return {
    type: normalizeText(event.type) || "tool_execution_update",
    timestamp: normalizeText(event.timestamp) || new Date().toISOString(),
    sequence: Number.isFinite(Number(event.sequence)) ? Math.trunc(Number(event.sequence)) : null,
    executionId: normalizeText(event.executionId || context.executionId) || null,
    approvalRequestId: normalizeText(
      event.approvalRequestId
      || event?.approval?.requestId
      || context?.approval?.requestId
      || context?.approvalRequestId,
    ) || null,
    toolName: normalizeText(event.toolName) || null,
    args: cloneJson(event.args) ?? {},
    context,
    lineage,
    policy,
    sessionId: lineage.sessionId,
    threadId: lineage.threadId,
    turnId: lineage.turnId,
    runId: lineage.runId,
    workflowId: lineage.workflowId,
    providerTurnId: lineage.providerTurnId,
    status: normalizeText(event.status) || null,
    attempt: Number.isFinite(Number(event.attempt)) ? Math.trunc(Number(event.attempt)) : null,
    attemptCount: Number.isFinite(Number(event.attemptCount)) ? Math.trunc(Number(event.attemptCount)) : null,
    nextAttempt: Number.isFinite(Number(event.nextAttempt)) ? Math.trunc(Number(event.nextAttempt)) : null,
    retry: cloneJson(event.retry) ?? null,
    approval: cloneJson(event.approval) ?? null,
    network: cloneJson(event.network) ?? null,
    sandbox: cloneJson(event.sandbox) ?? null,
    truncation: cloneJson(event.truncation) ?? null,
    hotPath: cloneJson(event.hotPath) ?? null,
    result: cloneJson(event.result) ?? null,
    request: cloneJson(event.request) ?? null,
    decision: normalizeText(event.decision) || null,
    error: normalizeError(event.error),
  };
}

export function createToolEvent(type, envelope = {}, detail = {}) {
  const context = detail?.context && typeof detail.context === "object"
    ? detail.context
    : (envelope?.context && typeof envelope.context === "object" ? envelope.context : {});
  return normalizeToolEvent({
    ...detail,
    type,
    executionId: detail?.executionId || envelope?.executionId || context?.executionId,
    toolName: detail?.toolName || envelope?.toolName,
    args: detail?.args ?? envelope?.args ?? {},
    context,
    lineage: detail?.lineage ?? envelope?.lineage ?? null,
    policy: detail?.policy ?? envelope?.policy ?? null,
  });
}

export default createToolEvent;
