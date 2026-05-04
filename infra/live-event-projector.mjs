import { SessionProjectionStore } from "./session-projection-store.mjs";
import { ApprovalProjectionStore } from "./approval-projection-store.mjs";
import { SubagentProjectionStore } from "./subagent-projection-store.mjs";

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
  if (!list.includes(normalized)) {
    list.push(normalized);
  }
  while (list.length > limit) list.shift();
}

function normalizeTimestamp(value) {
  const text = asText(value);
  if (text) return text;
  return new Date().toISOString();
}

function pushBounded(list, value, limit) {
  list.push(value);
  while (list.length > limit) list.shift();
}

function sortByUpdatedAtDescending(left, right) {
  const leftTime = Date.parse(String(left?.updatedAt || left?.timestamp || 0));
  const rightTime = Date.parse(String(right?.updatedAt || right?.timestamp || 0));
  return rightTime - leftTime;
}

function hasArtifactIdentity(event = {}) {
  return Boolean(
    asText(event.artifactId)
    || asText(event.artifactPath)
    || asText(event.filePath)
    || asText(event.patchHash),
  );
}

export class LiveEventProjector {
  constructor(options = {}) {
    this._recentLimit = Math.max(10, Math.trunc(Number(options.recentLimit) || 100));
    this._recentEvents = [];
    this._sessionStore = new SessionProjectionStore();
    this._approvalStore = new ApprovalProjectionStore();
    this._subagentStore = new SubagentProjectionStore();
    this._providers = new Map();
    this._tools = new Map();
    this._artifacts = new Map();
  }

  record(event = {}) {
    const timestamp = normalizeTimestamp(event.timestamp);
    pushBounded(this._recentEvents, {
      id: asText(event.id),
      timestamp,
      eventType: asText(event.eventType || event.type) || "event",
      category: asText(event.category) || "runtime",
      source: asText(event.source) || "unknown",
      sessionId: asText(event.sessionId),
      runId: asText(event.runId),
      taskId: asText(event.taskId),
      providerId: asText(event.providerId),
      toolName: asText(event.toolName || event.toolId),
      approvalId: asText(event.approvalId),
      filePath: asText(event.filePath || event.artifactPath),
      patchHash: asText(event.patchHash),
      childSessionId: asText(event.childSessionId),
      childTaskId: asText(event.childTaskId),
      childRunId: asText(event.childRunId),
      subagentId: asText(event.subagentId),
      surface: asText(event.surface || event.channel),
      action: asText(event.action || event.commandName),
      status: asText(event.status),
      summary: asText(event.summary || event.reason || event.message),
    }, this._recentLimit);

    this._sessionStore.record(event);
    this._approvalStore.record(event);
    this._subagentStore.record(event);

    const providerKey = asText(event.providerId || event.modelId);
    if (providerKey) {
      const providerEntry = this._providers.get(providerKey) || {
        key: providerKey,
        providerId: asText(event.providerId),
        modelId: asText(event.modelId),
        updatedAt: timestamp,
        totalEvents: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalLatencyMs: 0,
      };
      providerEntry.updatedAt = timestamp;
      providerEntry.providerId = asText(event.providerId) || providerEntry.providerId;
      providerEntry.modelId = asText(event.modelId) || providerEntry.modelId;
      providerEntry.totalEvents += 1;
      providerEntry.totalTokens += Number(event.tokenUsage?.totalTokens || 0);
      providerEntry.totalCostUsd += Number(event.costUsd || 0);
      providerEntry.totalLatencyMs += Number(event.latencyMs || event.durationMs || 0);
      this._providers.set(providerKey, providerEntry);
    }

    const toolKey = asText(event.toolId || event.toolName);
    if (toolKey) {
      const toolEntry = this._tools.get(toolKey) || {
        key: toolKey,
        toolId: asText(event.toolId),
        toolName: asText(event.toolName || event.toolId),
        updatedAt: timestamp,
        totalCalls: 0,
        totalLatencyMs: 0,
        totalRetries: 0,
        sessionIds: [],
        runIds: [],
      };
      toolEntry.updatedAt = timestamp;
      toolEntry.toolId = asText(event.toolId) || toolEntry.toolId;
      toolEntry.toolName = asText(event.toolName || event.toolId) || toolEntry.toolName;
      toolEntry.totalCalls += 1;
      toolEntry.totalLatencyMs += Number(event.latencyMs || event.durationMs || 0);
      toolEntry.totalRetries += Number(event.retryCount || 0);
      uniquePush(toolEntry.sessionIds, event.sessionId);
      uniquePush(toolEntry.runIds, event.runId);
      this._tools.set(toolKey, toolEntry);
    }

    const artifactKey = asText(event.artifactId || event.filePath || event.artifactPath || event.patchHash);
    if (artifactKey) {
      const artifactEntry = this._artifacts.get(artifactKey) || {
        key: artifactKey,
        artifactId: asText(event.artifactId),
        artifactPath: asText(event.artifactPath),
        patchHash: asText(event.patchHash),
        filePath: asText(event.filePath || event.artifactPath),
        taskId: asText(event.taskId),
        sessionId: asText(event.sessionId),
        runId: asText(event.runId),
        workflowId: asText(event.workflowId),
        updatedAt: timestamp,
        totalEvents: 0,
        lastEventType: null,
        status: null,
      };
      artifactEntry.updatedAt = timestamp;
      artifactEntry.totalEvents += 1;
      artifactEntry.lastEventType = asText(event.eventType || event.type) || artifactEntry.lastEventType;
      artifactEntry.status = asText(event.status) || artifactEntry.status;
      artifactEntry.artifactId = asText(event.artifactId) || artifactEntry.artifactId;
      artifactEntry.artifactPath = asText(event.artifactPath) || artifactEntry.artifactPath;
      artifactEntry.filePath = asText(event.filePath || event.artifactPath) || artifactEntry.filePath;
      artifactEntry.patchHash = asText(event.patchHash) || artifactEntry.patchHash;
      artifactEntry.taskId = asText(event.taskId) || artifactEntry.taskId;
      artifactEntry.sessionId = asText(event.sessionId) || artifactEntry.sessionId;
      artifactEntry.runId = asText(event.runId) || artifactEntry.runId;
      artifactEntry.workflowId = asText(event.workflowId) || artifactEntry.workflowId;
      this._artifacts.set(artifactKey, artifactEntry);
    } else if (hasArtifactIdentity(event)) {
      // Defensive no-op to keep artifact handling explicit when identifiers are partial.
    }
  }

  getSnapshot() {
    const sessionSnapshot = this._sessionStore.getSnapshot();
    return {
      sessions: sessionSnapshot.sessions,
      runs: sessionSnapshot.runs,
      providers: Array.from(this._providers.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      tools: Array.from(this._tools.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      approvals: this._approvalStore.getSnapshot(),
      artifacts: Array.from(this._artifacts.values()).sort(sortByUpdatedAtDescending).map(cloneValue),
      subagents: this._subagentStore.getSnapshot(),
      recentEvents: this._recentEvents.map(cloneValue),
    };
  }

  reset() {
    this._recentEvents = [];
    this._sessionStore.reset();
    this._approvalStore.reset();
    this._subagentStore.reset();
    this._providers.clear();
    this._tools.clear();
    this._artifacts.clear();
  }
}
