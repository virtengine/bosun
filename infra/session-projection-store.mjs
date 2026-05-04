function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniquePush(list, value, limit = 20) {
  const normalized = asText(value);
  if (!normalized) return;
  if (!list.includes(normalized)) list.push(normalized);
  while (list.length > limit) list.shift();
}

function sortByUpdatedAtDescending(left, right) {
  const leftTime = Date.parse(String(left?.updatedAt || left?.timestamp || 0));
  const rightTime = Date.parse(String(right?.updatedAt || right?.timestamp || 0));
  return rightTime - leftTime;
}

function normalizeTimestamp(value) {
  const text = asText(value);
  if (text) return text;
  return new Date().toISOString();
}

export class SessionProjectionStore {
  constructor() {
    this._sessions = new Map();
    this._runs = new Map();
  }

  record(event = {}) {
    const timestamp = normalizeTimestamp(event.timestamp);
    const sessionId = asText(event.sessionId);
    const runId = asText(event.runId);

    if (sessionId) {
      const sessionEntry = this._sessions.get(sessionId) || {
        id: sessionId,
        sessionId,
        rootSessionId: asText(event.rootSessionId) || sessionId,
        parentSessionId: asText(event.parentSessionId),
        taskId: asText(event.taskId),
        threadId: asText(event.threadId),
        runId,
        rootRunId: asText(event.rootRunId),
        workflowId: asText(event.workflowId),
        workflowName: asText(event.workflowName),
        status: null,
        updatedAt: timestamp,
        totalEvents: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalRetries: 0,
        artifactMutations: 0,
        subagentEvents: 0,
        lastEventType: null,
        lastToolName: null,
        lastApprovalId: null,
        lastArtifactPath: null,
        childSessionIds: [],
        childTaskIds: [],
        childRunIds: [],
        providerIds: [],
        toolNames: [],
        approvalIds: [],
        subagentIds: [],
      };
      sessionEntry.updatedAt = timestamp;
      sessionEntry.rootSessionId = asText(event.rootSessionId) || sessionEntry.rootSessionId || sessionId;
      sessionEntry.parentSessionId = asText(event.parentSessionId) || sessionEntry.parentSessionId;
      sessionEntry.taskId = asText(event.taskId) || sessionEntry.taskId;
      sessionEntry.threadId = asText(event.threadId) || sessionEntry.threadId;
      sessionEntry.runId = runId || sessionEntry.runId;
      sessionEntry.rootRunId = asText(event.rootRunId) || sessionEntry.rootRunId;
      sessionEntry.workflowId = asText(event.workflowId) || sessionEntry.workflowId;
      sessionEntry.workflowName = asText(event.workflowName) || sessionEntry.workflowName;
      sessionEntry.status = asText(event.status) || sessionEntry.status;
      sessionEntry.lastEventType = asText(event.eventType || event.type) || sessionEntry.lastEventType;
      sessionEntry.lastToolName = asText(event.toolName || event.toolId) || sessionEntry.lastToolName;
      sessionEntry.lastApprovalId = asText(event.approvalId) || sessionEntry.lastApprovalId;
      sessionEntry.totalEvents += 1;
      sessionEntry.totalTokens += Number(event.tokenUsage?.totalTokens || 0);
      sessionEntry.totalCostUsd += Number(event.costUsd || 0);
      sessionEntry.totalRetries += Number(event.retryCount || 0);
      if (asText(event.filePath || event.artifactPath || event.patchHash || event.artifactId)) {
        sessionEntry.artifactMutations += 1;
        sessionEntry.lastArtifactPath = asText(event.filePath || event.artifactPath) || sessionEntry.lastArtifactPath;
      }
      if (asText(event.childSessionId || event.childTaskId || event.childRunId || event.subagentId)) {
        sessionEntry.subagentEvents += 1;
      }
      uniquePush(sessionEntry.childSessionIds, event.childSessionId);
      uniquePush(sessionEntry.childTaskIds, event.childTaskId);
      uniquePush(sessionEntry.childRunIds, event.childRunId);
      uniquePush(sessionEntry.providerIds, event.providerId);
      uniquePush(sessionEntry.toolNames, event.toolName || event.toolId);
      uniquePush(sessionEntry.approvalIds, event.approvalId);
      uniquePush(sessionEntry.subagentIds, event.subagentId);
      this._sessions.set(sessionId, sessionEntry);
    }

    if (runId) {
      const runEntry = this._runs.get(runId) || {
        runId,
        rootRunId: asText(event.rootRunId) || runId,
        parentRunId: asText(event.parentRunId),
        threadId: asText(event.threadId),
        sessionId,
        workflowId: asText(event.workflowId),
        workflowName: asText(event.workflowName),
        status: null,
        updatedAt: timestamp,
        totalEvents: 0,
        toolCalls: 0,
        approvalCount: 0,
        artifactMutations: 0,
        subagentEvents: 0,
        childSessionIds: [],
        childTaskIds: [],
        childRunIds: [],
        providerIds: [],
        toolNames: [],
        approvalIds: [],
        subagentIds: [],
      };
      runEntry.updatedAt = timestamp;
      runEntry.rootRunId = asText(event.rootRunId) || runEntry.rootRunId || runId;
      runEntry.parentRunId = asText(event.parentRunId) || runEntry.parentRunId;
      runEntry.threadId = asText(event.threadId) || runEntry.threadId;
      runEntry.sessionId = sessionId || runEntry.sessionId;
      runEntry.workflowId = asText(event.workflowId) || runEntry.workflowId;
      runEntry.workflowName = asText(event.workflowName) || runEntry.workflowName;
      runEntry.status = asText(event.status) || runEntry.status;
      runEntry.totalEvents += 1;
      if (asText(event.toolName || event.toolId)) runEntry.toolCalls += 1;
      if (asText(event.approvalId)) runEntry.approvalCount += 1;
      if (asText(event.filePath || event.artifactPath || event.patchHash || event.artifactId)) runEntry.artifactMutations += 1;
      if (asText(event.childSessionId || event.childTaskId || event.childRunId || event.subagentId)) runEntry.subagentEvents += 1;
      uniquePush(runEntry.childSessionIds, event.childSessionId);
      uniquePush(runEntry.childTaskIds, event.childTaskId);
      uniquePush(runEntry.childRunIds, event.childRunId);
      uniquePush(runEntry.providerIds, event.providerId);
      uniquePush(runEntry.toolNames, event.toolName || event.toolId);
      uniquePush(runEntry.approvalIds, event.approvalId);
      uniquePush(runEntry.subagentIds, event.subagentId);
      this._runs.set(runId, runEntry);
    }
  }

  getSnapshot() {
    return {
      sessions: Array.from(this._sessions.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      runs: Array.from(this._runs.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
    };
  }

  reset() {
    this._sessions.clear();
    this._runs.clear();
  }
}

export default SessionProjectionStore;
