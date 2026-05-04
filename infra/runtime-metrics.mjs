function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function ensureMetricEntry(map, key, factory) {
  if (!map.has(key)) {
    map.set(key, factory());
  }
  return map.get(key);
}

function toSortedArray(map, comparator) {
  return Array.from(map.values())
    .sort(comparator)
    .map(cloneValue);
}

export class RuntimeMetrics {
  constructor() {
    this._totals = {
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      totalLatencyMs: 0,
      measuredEvents: 0,
      retries: 0,
      approvals: 0,
      artifactMutations: 0,
      patchApplications: 0,
      subagentEvents: 0,
    };
    this._byCategory = new Map();
    this._byType = new Map();
    this._bySource = new Map();
    this._byStatus = new Map();
    this._toolMetrics = new Map();
    this._providerMetrics = new Map();
  }

  record(event = {}) {
    const eventType = asText(event.eventType || event.type) || "event";
    const category = asText(event.category) || "runtime";
    const source = asText(event.source) || "unknown";
    const status = asText(event.status);
    const toolKey = asText(event.toolName || event.toolId);
    const providerKey = asText(event.providerId || event.modelId);
    const inputTokens = Number(event.tokenUsage?.inputTokens || 0);
    const outputTokens = Number(event.tokenUsage?.outputTokens || 0);
    const totalTokens = Number(event.tokenUsage?.totalTokens || inputTokens + outputTokens || 0);
    const costUsd = Number(event.costUsd || 0);
    const latencyMs = Number(event.latencyMs || event.durationMs || 0);
    const retryCount = Number(event.retryCount || 0);

    this._totals.events += 1;
    this._totals.inputTokens += inputTokens;
    this._totals.outputTokens += outputTokens;
    this._totals.totalTokens += totalTokens;
    this._totals.costUsd += costUsd;
    this._totals.retries += retryCount;
    if (asText(event.approvalId)) this._totals.approvals += 1;
    if (asText(event.filePath || event.artifactPath || event.patchHash || event.artifactId)) this._totals.artifactMutations += 1;
    if (asText(event.patchHash) || eventType.includes("patch")) this._totals.patchApplications += 1;
    if (asText(event.childSessionId || event.childTaskId || event.childRunId || event.subagentId)) this._totals.subagentEvents += 1;
    if (Number.isFinite(latencyMs) && latencyMs > 0) {
      this._totals.totalLatencyMs += latencyMs;
      this._totals.measuredEvents += 1;
    }

    ensureMetricEntry(this._byCategory, category, () => ({ key: category, count: 0 })).count += 1;
    ensureMetricEntry(this._byType, eventType, () => ({ key: eventType, count: 0 })).count += 1;
    ensureMetricEntry(this._bySource, source, () => ({ key: source, count: 0 })).count += 1;
    if (status) ensureMetricEntry(this._byStatus, status, () => ({ key: status, count: 0 })).count += 1;

    if (toolKey) {
      const toolEntry = ensureMetricEntry(this._toolMetrics, toolKey, () => ({
        key: toolKey,
        toolId: asText(event.toolId),
        toolName: asText(event.toolName || event.toolId),
        count: 0,
        retries: 0,
        totalLatencyMs: 0,
        totalTokens: 0,
      }));
      toolEntry.count += 1;
      toolEntry.retries += retryCount;
      toolEntry.totalLatencyMs += latencyMs > 0 ? latencyMs : 0;
      toolEntry.totalTokens += totalTokens;
    }

    if (providerKey) {
      const providerEntry = ensureMetricEntry(this._providerMetrics, providerKey, () => ({
        key: providerKey,
        providerId: asText(event.providerId),
        modelId: asText(event.modelId),
        count: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalLatencyMs: 0,
      }));
      providerEntry.count += 1;
      providerEntry.totalTokens += totalTokens;
      providerEntry.totalCostUsd += costUsd;
      providerEntry.totalLatencyMs += latencyMs > 0 ? latencyMs : 0;
    }
  }

  getSummary() {
    const averageLatencyMs = this._totals.measuredEvents > 0
      ? this._totals.totalLatencyMs / this._totals.measuredEvents
      : 0;
    return {
      totals: {
        ...this._totals,
        averageLatencyMs,
      },
      byCategory: toSortedArray(this._byCategory, (left, right) => right.count - left.count),
      byType: toSortedArray(this._byType, (left, right) => right.count - left.count),
      bySource: toSortedArray(this._bySource, (left, right) => right.count - left.count),
      byStatus: toSortedArray(this._byStatus, (left, right) => right.count - left.count),
      tools: toSortedArray(this._toolMetrics, (left, right) => right.count - left.count),
      providers: toSortedArray(this._providerMetrics, (left, right) => right.count - left.count),
    };
  }

  reset() {
    this._totals = {
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      totalLatencyMs: 0,
      measuredEvents: 0,
      retries: 0,
      approvals: 0,
      artifactMutations: 0,
      patchApplications: 0,
      subagentEvents: 0,
    };
    this._byCategory.clear();
    this._byType.clear();
    this._bySource.clear();
    this._byStatus.clear();
    this._toolMetrics.clear();
    this._providerMetrics.clear();
  }
}
