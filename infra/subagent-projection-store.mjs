function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
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

function resolveSubagentKey(event = {}) {
  return asText(event.subagentId || event.childSessionId || event.childRunId || event.childTaskId);
}

export class SubagentProjectionStore {
  constructor() {
    this._subagents = new Map();
  }

  record(event = {}) {
    const key = resolveSubagentKey(event);
    if (!key) return;
    const timestamp = normalizeTimestamp(event.timestamp);
    const entry = this._subagents.get(key) || {
      key,
      subagentId: asText(event.subagentId),
      childSessionId: asText(event.childSessionId),
      childTaskId: asText(event.childTaskId),
      childRunId: asText(event.childRunId),
      parentSessionId: asText(event.parentSessionId || event.sessionId),
      rootSessionId: asText(event.rootSessionId),
      parentTaskId: asText(event.parentTaskId || event.taskId),
      runId: asText(event.runId),
      rootRunId: asText(event.rootRunId),
      workflowId: asText(event.workflowId),
      workflowName: asText(event.workflowName),
      providerId: asText(event.providerId),
      toolName: asText(event.toolName || event.toolId),
      status: null,
      updatedAt: timestamp,
      totalEvents: 0,
      lastEventType: null,
      eventIds: [],
    };
    entry.updatedAt = timestamp;
    entry.subagentId = asText(event.subagentId) || entry.subagentId;
    entry.childSessionId = asText(event.childSessionId) || entry.childSessionId;
    entry.childTaskId = asText(event.childTaskId) || entry.childTaskId;
    entry.childRunId = asText(event.childRunId) || entry.childRunId;
    entry.parentSessionId = asText(event.parentSessionId || event.sessionId) || entry.parentSessionId;
    entry.rootSessionId = asText(event.rootSessionId) || entry.rootSessionId;
    entry.parentTaskId = asText(event.parentTaskId || event.taskId) || entry.parentTaskId;
    entry.runId = asText(event.runId) || entry.runId;
    entry.rootRunId = asText(event.rootRunId) || entry.rootRunId;
    entry.workflowId = asText(event.workflowId) || entry.workflowId;
    entry.workflowName = asText(event.workflowName) || entry.workflowName;
    entry.providerId = asText(event.providerId) || entry.providerId;
    entry.toolName = asText(event.toolName || event.toolId) || entry.toolName;
    entry.status = asText(event.status) || entry.status;
    entry.totalEvents += 1;
    entry.lastEventType = asText(event.eventType || event.type) || entry.lastEventType;
    const eventId = asText(event.id || event.eventId);
    if (eventId && !entry.eventIds.includes(eventId)) entry.eventIds.push(eventId);
    this._subagents.set(key, entry);
  }

  getSnapshot() {
    return Array.from(this._subagents.values()).sort(sortByUpdatedAtDescending).map(cloneValue);
  }

  reset() {
    this._subagents.clear();
  }
}

export default SubagentProjectionStore;
