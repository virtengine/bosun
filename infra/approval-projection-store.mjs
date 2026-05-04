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

export class ApprovalProjectionStore {
  constructor() {
    this._approvals = new Map();
  }

  record(event = {}) {
    const approvalId = asText(event.approvalId);
    if (!approvalId) return;
    const timestamp = normalizeTimestamp(event.timestamp);
    const entry = this._approvals.get(approvalId) || {
      approvalId,
      sessionId: asText(event.sessionId),
      rootSessionId: asText(event.rootSessionId),
      parentSessionId: asText(event.parentSessionId),
      runId: asText(event.runId),
      rootRunId: asText(event.rootRunId),
      taskId: asText(event.taskId),
      toolId: asText(event.toolId),
      toolName: asText(event.toolName),
      actor: asText(event.actor),
      status: null,
      updatedAt: timestamp,
      decisions: 0,
      eventIds: [],
    };
    entry.updatedAt = timestamp;
    entry.sessionId = asText(event.sessionId) || entry.sessionId;
    entry.rootSessionId = asText(event.rootSessionId) || entry.rootSessionId;
    entry.parentSessionId = asText(event.parentSessionId) || entry.parentSessionId;
    entry.runId = asText(event.runId) || entry.runId;
    entry.rootRunId = asText(event.rootRunId) || entry.rootRunId;
    entry.taskId = asText(event.taskId) || entry.taskId;
    entry.toolId = asText(event.toolId) || entry.toolId;
    entry.toolName = asText(event.toolName) || entry.toolName;
    entry.actor = asText(event.actor) || entry.actor;
    entry.status = asText(event.status) || entry.status;
    entry.decisions += 1;
    const eventId = asText(event.id || event.eventId);
    if (eventId && !entry.eventIds.includes(eventId)) entry.eventIds.push(eventId);
    this._approvals.set(approvalId, entry);
  }

  getSnapshot() {
    return Array.from(this._approvals.values()).sort(sortByUpdatedAtDescending).map(cloneValue);
  }

  reset() {
    this._approvals.clear();
  }
}

export default ApprovalProjectionStore;
