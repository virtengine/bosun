function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export class ProviderUsageLedger {
  constructor() {
    this._providers = new Map();
  }

  record(event = {}) {
    const providerId = asText(event.providerId);
    const modelId = asText(event.modelId);
    if (!providerId && !modelId) return;
    const key = `${providerId || "unknown"}::${modelId || "default"}`;
    const entry = this._providers.get(key) || {
      providerId,
      modelId,
      requests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      totalLatencyMs: 0,
      retryCount: 0,
      lastUsedAt: null,
      sessionIds: new Set(),
      taskIds: new Set(),
    };
    entry.requests += 1;
    entry.totalTokens += Number(event.tokenUsage?.totalTokens || 0);
    entry.inputTokens += Number(event.tokenUsage?.inputTokens || 0);
    entry.outputTokens += Number(event.tokenUsage?.outputTokens || 0);
    entry.totalCostUsd += Number(event.costUsd || 0);
    entry.totalLatencyMs += Number(event.latencyMs || event.durationMs || 0);
    entry.retryCount += Number(event.retryCount || 0);
    entry.lastUsedAt = String(event.timestamp || new Date().toISOString());
    if (asText(event.sessionId)) entry.sessionIds.add(String(event.sessionId));
    if (asText(event.taskId)) entry.taskIds.add(String(event.taskId));
    this._providers.set(key, entry);
  }

  getUsageSummary() {
    return Array.from(this._providers.values())
      .map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        requests: entry.requests,
        totalTokens: entry.totalTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalCostUsd: entry.totalCostUsd,
        totalLatencyMs: entry.totalLatencyMs,
        retryCount: entry.retryCount,
        lastUsedAt: entry.lastUsedAt,
        sessionIds: Array.from(entry.sessionIds),
        taskIds: Array.from(entry.taskIds),
      }))
      .sort((left, right) => right.requests - left.requests)
      .map(cloneValue);
  }

  reset() {
    this._providers.clear();
  }
}

