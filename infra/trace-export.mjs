function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function toTraceTimestampMicros(value) {
  const ms = Date.parse(String(value || ""));
  if (Number.isFinite(ms)) return ms * 1000;
  return Date.now() * 1000;
}

function buildTraceArgs(event = {}) {
  return {
    source: asText(event.source),
    category: asText(event.category),
    taskId: asText(event.taskId),
    sessionId: asText(event.sessionId),
    threadId: asText(event.threadId),
    runId: asText(event.runId),
    rootRunId: asText(event.rootRunId),
    parentRunId: asText(event.parentRunId),
    childRunId: asText(event.childRunId),
    traceId: asText(event.traceId),
    spanId: asText(event.spanId),
    parentSpanId: asText(event.parentSpanId),
    executionId: asText(event.executionId),
    executionKey: asText(event.executionKey),
    executionKind: asText(event.executionKind),
    executionLabel: asText(event.executionLabel),
    parentExecutionId: asText(event.parentExecutionId),
    causedByExecutionId: asText(event.causedByExecutionId),
    parentSessionId: asText(event.parentSessionId),
    childSessionId: asText(event.childSessionId),
    parentTaskId: asText(event.parentTaskId),
    childTaskId: asText(event.childTaskId),
    subagentId: asText(event.subagentId),
    providerId: asText(event.providerId),
    providerKind: asText(event.providerKind),
    modelId: asText(event.modelId),
    toolId: asText(event.toolId),
    toolName: asText(event.toolName),
    approvalId: asText(event.approvalId),
    artifactId: asText(event.artifactId),
    artifactPath: asText(event.artifactPath),
    filePath: asText(event.filePath),
    fileHash: asText(event.fileHash),
    patchHash: asText(event.patchHash),
    workflowId: asText(event.workflowId),
    workflowName: asText(event.workflowName),
    nodeId: asText(event.nodeId),
    nodeType: asText(event.nodeType),
    nodeLabel: asText(event.nodeLabel),
    stageId: asText(event.stageId),
    stageType: asText(event.stageType),
    commandId: asText(event.commandId),
    commandName: asText(event.commandName),
    surface: asText(event.surface),
    channel: asText(event.channel),
    action: asText(event.action),
    workspaceId: asText(event.workspaceId),
    repoRoot: asText(event.repoRoot),
    branch: asText(event.branch),
    prNumber: event.prNumber == null ? null : Number(event.prNumber),
    prUrl: asText(event.prUrl),
    actor: asText(event.actor),
    status: asText(event.status),
    retryCount: Number(event.retryCount || 0),
    durationMs: Number(event.durationMs || 0),
    latencyMs: Number(event.latencyMs || event.durationMs || 0),
    tokenUsage: event.tokenUsage || null,
    costUsd: Number(event.costUsd || 0),
    summary: asText(event.summary || event.reason || event.message),
  };
}

export function exportHarnessTrace(events = [], options = {}) {
  const processName = asText(options.processName) || "bosun-harness";
  const threadFallback = asText(options.threadName) || "runtime";
  const traceEvents = (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .map((event) => {
      const timestamp = String(event.timestamp || new Date().toISOString());
      const durationMs = Number(event.durationMs || event.latencyMs || 0);
      return {
        name: asText(event.eventType || event.type) || "event",
        cat: asText(event.category || event.source) || "runtime",
        ph: durationMs > 0 ? "X" : "i",
        s: durationMs > 0 ? undefined : "t",
        ts: toTraceTimestampMicros(timestamp),
        dur: durationMs > 0 ? Math.trunc(durationMs * 1000) : undefined,
        pid: processName,
        tid: asText(event.threadId || event.sessionId || event.runId || event.taskId) || threadFallback,
        args: buildTraceArgs(event),
      };
    });
  return {
    schemaVersion: 1,
    format: "chrome-trace",
    displayTimeUnit: "ms",
    traceEvents,
  };
}
