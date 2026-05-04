import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TUI_EVENT_TYPES = Object.freeze([
  "monitor:stats",
  "sessions:update",
  "session:event",
  "logs:stream",
  "workflow:status",
  "tasks:update",
]);

const RATE_LIMIT_BUCKET_SCHEMA = {
  type: "object",
  required: ["primary", "secondary", "credits", "unit"],
  additionalProperties: false,
  properties: {
    primary: { type: ["number", "null"] },
    secondary: { type: ["number", "null"] },
    credits: { type: ["number", "null"] },
    primaryLimit: { type: ["number", "null"] },
    secondaryLimit: { type: ["number", "null"] },
    creditsLimit: { type: ["number", "null"] },
    unit: { type: "string", minLength: 1 },
  },
};

const TOOL_COUNT_SCHEMA = {
  type: "object",
  required: ["name", "count"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "number", minimum: 0 },
  },
};

const ACTION_SCHEMA = {
  type: "object",
  required: ["type", "label", "level"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    level: { type: "string", minLength: 1 },
    timestamp: { type: ["string", "null"] },
  },
};

const FILE_COUNTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    openedFiles: { type: "number", minimum: 0 },
    editedFiles: { type: "number", minimum: 0 },
    referencedFiles: { type: "number", minimum: 0 },
    openOps: { type: "number", minimum: 0 },
    editOps: { type: "number", minimum: 0 },
  },
};

const CONTEXT_WINDOW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    usedTokens: { type: "number", minimum: 0 },
    totalTokens: { type: ["number", "null"], minimum: 0 },
    percent: { type: ["number", "null"], minimum: 0 },
  },
};

const RUNTIME_HEALTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string", minLength: 1 },
    severity: { type: "string", minLength: 1 },
    live: { type: "boolean" },
    idleMs: { type: "number", minimum: 0 },
    contextPressure: { type: "string", minLength: 1 },
    contextUsagePercent: { type: ["number", "null"], minimum: 0 },
    toolCalls: { type: "number", minimum: 0 },
    toolResults: { type: "number", minimum: 0 },
    errors: { type: "number", minimum: 0 },
    hasEdits: { type: "boolean" },
    hasCommits: { type: "boolean" },
    reasons: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
};

const SESSION_SUMMARY_SCHEMA = {
  type: "object",
  required: [
    "id",
    "taskId",
    "title",
    "type",
    "status",
    "workspaceId",
    "workspaceDir",
    "branch",
    "turnCount",
    "createdAt",
    "lastActiveAt",
    "idleMs",
    "elapsedMs",
    "recommendation",
    "preview",
    "lastMessage",
    "insights",
  ],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1 },
    taskId: { type: "string", minLength: 1 },
    title: { type: ["string", "null"] },
    type: { type: "string", minLength: 1 },
    status: { type: "string", minLength: 1 },
    workspaceId: { type: ["string", "null"] },
    workspaceDir: { type: ["string", "null"] },
    branch: { type: ["string", "null"] },
    turnCount: { type: "number", minimum: 0 },
    createdAt: { type: "string", minLength: 1 },
    lastActiveAt: { type: "string", minLength: 1 },
    idleMs: { type: "number", minimum: 0 },
    elapsedMs: { type: "number", minimum: 0 },
    recommendation: { type: "string" },
    preview: { type: ["string", "null"] },
    lastMessage: { type: ["string", "null"] },
    lifecycleStatus: { type: ["string", "null"] },
    runtimeState: { type: ["string", "null"] },
    runtimeUpdatedAt: { type: ["string", "null"] },
    runtimeIsLive: { type: "boolean" },
    tokenCount: { type: "number", minimum: 0 },
    inputTokens: { type: "number", minimum: 0 },
    outputTokens: { type: "number", minimum: 0 },
    totalTokens: { type: "number", minimum: 0 },
    totalEvents: { type: "number", minimum: 0 },
    lastEventType: { type: ["string", "null"] },
    hasEdits: { type: "boolean" },
    hasCommits: { type: "boolean" },
    toolCalls: { type: "number", minimum: 0 },
    toolResults: { type: "number", minimum: 0 },
    errors: { type: "number", minimum: 0 },
    commandExecutions: { type: "number", minimum: 0 },
    fileCounts: FILE_COUNTS_SCHEMA,
    topTools: {
      type: "array",
      items: TOOL_COUNT_SCHEMA,
    },
    recentActions: {
      type: "array",
      items: ACTION_SCHEMA,
    },
    contextWindow: CONTEXT_WINDOW_SCHEMA,
    contextUsagePercent: { type: ["number", "null"], minimum: 0 },
    contextPressure: { type: "string" },
    lastToolName: { type: ["string", "null"] },
    lastActionAt: { type: ["string", "null"] },
    runtimeHealth: RUNTIME_HEALTH_SCHEMA,
    insights: {},
  },
};

export const TUI_EVENT_SCHEMAS = Object.freeze({
  "monitor:stats": {
    type: "object",
    required: [
      "activeAgents",
      "maxAgents",
      "tokensIn",
      "tokensOut",
      "tokensTotal",
      "totalTokens",
      "throughputTps",
      "uptimeMs",
      "rateLimits",
    ],
    additionalProperties: false,
    properties: {
      activeAgents: { type: "number", minimum: 0 },
      maxAgents: { type: "number", minimum: 0 },
      tokensIn: { type: "number", minimum: 0 },
      tokensOut: { type: "number", minimum: 0 },
      tokensTotal: { type: "number", minimum: 0 },
      totalTokens: { type: "number", minimum: 0 },
      throughputTps: { type: "number", minimum: 0 },
      uptimeMs: { type: "number", minimum: 0 },
      activeSessionCount: { type: "number", minimum: 0 },
      completedSessionCount: { type: "number", minimum: 0 },
      totalSessionCount: { type: "number", minimum: 0 },
      rateLimits: {
        type: "object",
        additionalProperties: RATE_LIMIT_BUCKET_SCHEMA,
      },
      rateLimitSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          providerCount: { type: "number", minimum: 0 },
          providersNearExhaustion: { type: "number", minimum: 0 },
          providersExhausted: { type: "number", minimum: 0 },
        },
      },
      sessionHealth: {
        type: "object",
        additionalProperties: false,
        properties: {
          live: { type: "number", minimum: 0 },
          active: { type: "number", minimum: 0 },
          working: { type: "number", minimum: 0 },
          editing: { type: "number", minimum: 0 },
          committing: { type: "number", minimum: 0 },
          idle: { type: "number", minimum: 0 },
          stalled: { type: "number", minimum: 0 },
          blocked: { type: "number", minimum: 0 },
          completed: { type: "number", minimum: 0 },
        },
      },
      context: {
        type: "object",
        additionalProperties: false,
        properties: {
          liveSessionCount: { type: "number", minimum: 0 },
          completedSessionCount: { type: "number", minimum: 0 },
          sessionsNearContextLimit: { type: "number", minimum: 0 },
          sessionsHighContextPressure: { type: "number", minimum: 0 },
          maxContextUsagePercent: { type: ["number", "null"], minimum: 0 },
          avgContextUsagePercent: { type: ["number", "null"], minimum: 0 },
        },
      },
      toolSummary: {
        type: "object",
        additionalProperties: false,
        properties: {
          toolCalls: { type: "number", minimum: 0 },
          toolResults: { type: "number", minimum: 0 },
          errors: { type: "number", minimum: 0 },
          editOps: { type: "number", minimum: 0 },
          commitOps: { type: "number", minimum: 0 },
          sessionsWithEdits: { type: "number", minimum: 0 },
          sessionsWithCommits: { type: "number", minimum: 0 },
          topTools: {
            type: "array",
            items: TOOL_COUNT_SCHEMA,
          },
        },
      },
      activeSessions: {
        type: "array",
        items: SESSION_SUMMARY_SCHEMA,
      },
      executor: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          mode: { type: "string" },
          paused: { type: "boolean" },
          activeSlots: { type: "number", minimum: 0 },
          maxParallel: { type: "number", minimum: 0 },
          slots: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                taskId: { type: "string" },
                taskTitle: { type: "string" },
                sdk: { type: "string" },
                model: { type: "string" },
                status: { type: "string" },
                runningFor: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
      recovery: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          totals: {
            type: "object",
            additionalProperties: false,
            properties: {
              runs: { type: "number", minimum: 0 },
              failures: { type: "number", minimum: 0 },
              resumed: { type: "number", minimum: 0 },
              resetToTodo: { type: "number", minimum: 0 },
              reconciledDrift: { type: "number", minimum: 0 },
              skippedForActiveClaim: { type: "number", minimum: 0 },
              skippedForNoCommitBlock: { type: "number", minimum: 0 },
              resetUnstarted: { type: "number", minimum: 0 },
              staleSharedClaim: { type: "number", minimum: 0 },
              workflowOwnerlessReset: { type: "number", minimum: 0 },
            },
          },
          lastRun: { type: ["object", "null"] },
          recentRuns: { type: "array", items: { type: "object" } },
        },
      },
      harness: {
        type: ["object", "null"],
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          activeArtifactId: { type: ["string", "null"] },
          activeArtifactPath: { type: ["string", "null"] },
          activeProfile: { type: ["object", "null"] },
          validationMode: { type: ["string", "null"] },
          totals: {
            type: "object",
            additionalProperties: false,
            properties: {
              total: { type: "number", minimum: 0 },
              successful: { type: "number", minimum: 0 },
              failed: { type: "number", minimum: 0 },
              dryRuns: { type: "number", minimum: 0 },
              active: { type: "number", minimum: 0 },
            },
          },
          activeRunCount: { type: "number", minimum: 0 },
          activeRuns: { type: "array", items: { type: "object" } },
          lastRun: { type: ["object", "null"] },
          recentRuns: { type: "array", items: { type: "object" } },
        },
      },
    },
  },
  "sessions:update": {
    type: "array",
    items: SESSION_SUMMARY_SCHEMA,
  },
  "session:event": {
    type: "object",
    required: ["sessionId", "taskId", "session", "event"],
    additionalProperties: false,
    properties: {
      sessionId: { type: "string", minLength: 1 },
      taskId: { type: "string", minLength: 1 },
      session: {
        type: "object",
        required: ["id", "taskId", "type", "status", "lastActiveAt", "turnCount"],
        additionalProperties: true,
        properties: {
          id: { type: "string", minLength: 1 },
          taskId: { type: "string", minLength: 1 },
          type: { type: "string", minLength: 1 },
          status: { type: "string", minLength: 1 },
          lastActiveAt: { type: "string", minLength: 1 },
          turnCount: { type: "number", minimum: 0 },
        },
      },
      event: {
        type: "object",
        required: ["kind"],
        additionalProperties: true,
        properties: {
          kind: { type: "string", enum: ["message", "state"] },
        },
      },
    },
  },
  "logs:stream": {
    type: "object",
    required: ["logType", "raw", "line", "level", "timestamp", "filePath"],
    additionalProperties: false,
    properties: {
      logType: { type: "string", minLength: 1 },
      query: { type: ["string", "null"] },
      filePath: { type: ["string", "null"] },
      line: { type: "string" },
      raw: { type: "string" },
      level: { type: "string", minLength: 1 },
      timestamp: { type: ["string", "null"] },
    },
  },
  "workflow:status": {
    type: "object",
    required: ["runId", "workflowId", "eventType", "status", "timestamp"],
    additionalProperties: false,
    properties: {
      runId: { type: "string", minLength: 1 },
      workflowId: { type: "string", minLength: 1 },
      workflowName: { type: ["string", "null"] },
      eventType: { type: "string", minLength: 1 },
      status: { type: "string", minLength: 1 },
      nodeId: { type: ["string", "null"] },
      nodeType: { type: ["string", "null"] },
      nodeLabel: { type: ["string", "null"] },
      error: { type: ["string", "null"] },
      durationMs: { type: ["number", "null"], minimum: 0 },
      timestamp: { type: "number", minimum: 0 },
      meta: { type: ["object", "null"] },
    },
  },
  "tasks:update": {
    type: "object",
    required: ["reason", "sourceEvent", "patch"],
    additionalProperties: false,
    properties: {
      reason: { type: "string", minLength: 1 },
      sourceEvent: { type: "string", minLength: 1 },
      taskId: { type: ["string", "null"] },
      taskIds: {
        type: ["array", "null"],
        items: { type: "string", minLength: 1 },
      },
      status: { type: ["string", "null"] },
      workspaceId: { type: ["string", "null"] },
      projectId: { type: ["string", "null"] },
      patch: { type: "object", additionalProperties: true },
    },
  },
});

function numberOr(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, numberOr(value, fallback));
}

function roundMetric(value, precision = 4) {
  const numeric = nonNegativeNumber(value, 0);
  return Number(numeric.toFixed(precision));
}

function resolveCacheDir({ cacheDir, configDir } = {}) {
  if (cacheDir) return resolve(String(cacheDir));
  return resolve(String(configDir || process.cwd()), ".cache");
}

function normalizeRateLimits(rateLimits = {}) {
  const normalized = {};
  for (const [provider, bucket] of Object.entries(rateLimits || {})) {
    const key = String(provider || "").trim();
    if (!key || !bucket || typeof bucket !== "object") continue;
    normalized[key] = {
      primary: Number.isFinite(Number(bucket.primary)) ? Number(bucket.primary) : null,
      secondary: Number.isFinite(Number(bucket.secondary)) ? Number(bucket.secondary) : null,
      credits: bucket.credits == null ? null : (Number.isFinite(Number(bucket.credits)) ? Number(bucket.credits) : null),
      primaryLimit: bucket.primaryLimit == null ? null : (Number.isFinite(Number(bucket.primaryLimit)) ? Number(bucket.primaryLimit) : null),
      secondaryLimit: bucket.secondaryLimit == null ? null : (Number.isFinite(Number(bucket.secondaryLimit)) ? Number(bucket.secondaryLimit) : null),
      creditsLimit: bucket.creditsLimit == null ? null : (Number.isFinite(Number(bucket.creditsLimit)) ? Number(bucket.creditsLimit) : null),
      unit: String(bucket.unit || "count").trim() || "count",
    };
  }
  return normalized;
}

function normalizeTopTools(topTools = [], limit = 6) {
  return (Array.isArray(topTools) ? topTools : [])
    .map((entry) => ({
      name: String(entry?.name || "").trim(),
      count: Math.max(0, numberOr(entry?.count, 0)),
    }))
    .filter((entry) => entry.name && entry.count > 0)
    .slice(0, limit);
}

function normalizeRecentActions(recentActions = [], limit = 6) {
  return (Array.isArray(recentActions) ? recentActions : [])
    .map((entry) => ({
      type: String(entry?.type || "").trim() || "event",
      label: String(entry?.label || "").trim(),
      level: String(entry?.level || "info").trim() || "info",
      timestamp: entry?.timestamp == null ? null : String(entry.timestamp),
    }))
    .filter((entry) => entry.label)
    .slice(0, limit);
}

function normalizeFileCounts(fileCounts = {}) {
  const counts = fileCounts && typeof fileCounts === "object" ? fileCounts : {};
  return {
    openedFiles: nonNegativeNumber(counts.openedFiles, 0),
    editedFiles: nonNegativeNumber(counts.editedFiles, 0),
    referencedFiles: nonNegativeNumber(counts.referencedFiles, 0),
    openOps: nonNegativeNumber(counts.openOps, 0),
    editOps: nonNegativeNumber(counts.editOps, 0),
  };
}

function normalizeContextWindow(contextWindow = {}, fallbackUsedTokens = 0) {
  const snapshot = contextWindow && typeof contextWindow === "object" ? contextWindow : {};
  const usedTokens = nonNegativeNumber(snapshot.usedTokens, fallbackUsedTokens);
  const totalTokens = Number.isFinite(Number(snapshot.totalTokens)) && Number(snapshot.totalTokens) > 0
    ? Math.round(Number(snapshot.totalTokens))
    : null;
  const percent = Number.isFinite(Number(snapshot.percent))
    ? Math.max(0, Math.min(100, Number(Number(snapshot.percent).toFixed(1))))
    : (usedTokens > 0 && totalTokens
      ? Math.max(0, Math.min(100, Number(((usedTokens / totalTokens) * 100).toFixed(1))))
      : null);
  return {
    usedTokens,
    totalTokens,
    percent,
  };
}

function getContextPressureLevel(percent) {
  if (!Number.isFinite(Number(percent))) return "unknown";
  const safePercent = Number(percent);
  if (safePercent >= 95) return "critical";
  if (safePercent >= 85) return "high";
  if (safePercent >= 70) return "medium";
  return "low";
}

function normalizeRuntimeHealth(runtimeHealth = {}, fallback = {}) {
  const source = runtimeHealth && typeof runtimeHealth === "object" ? runtimeHealth : {};
  return {
    state: String(source.state || fallback.state || "unknown").trim() || "unknown",
    severity: String(source.severity || fallback.severity || "info").trim() || "info",
    live: Boolean(source.live ?? fallback.live ?? false),
    idleMs: nonNegativeNumber(source.idleMs, fallback.idleMs ?? 0),
    contextPressure: String(source.contextPressure || fallback.contextPressure || "unknown").trim() || "unknown",
    contextUsagePercent: Number.isFinite(Number(source.contextUsagePercent ?? fallback.contextUsagePercent))
      ? Math.max(0, Math.min(100, Number(Number(source.contextUsagePercent ?? fallback.contextUsagePercent).toFixed(1))))
      : null,
    toolCalls: nonNegativeNumber(source.toolCalls, fallback.toolCalls ?? 0),
    toolResults: nonNegativeNumber(source.toolResults, fallback.toolResults ?? 0),
    errors: nonNegativeNumber(source.errors, fallback.errors ?? 0),
    hasEdits: Boolean(source.hasEdits ?? fallback.hasEdits ?? false),
    hasCommits: Boolean(source.hasCommits ?? fallback.hasCommits ?? false),
    reasons: Array.isArray(source.reasons)
      ? source.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
      : (Array.isArray(fallback.reasons)
        ? fallback.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
        : []),
  };
}

function normalizeSessionSummary(session = {}) {
  const normalized = session && typeof session === "object" ? { ...session } : {};
  const createdAt = normalized.createdAt == null
    ? new Date().toISOString()
    : String(normalized.createdAt);
  const lastActiveAt = normalized.lastActiveAt == null
    ? createdAt
    : String(normalized.lastActiveAt);
  const createdAtMs = Date.parse(createdAt);
  const lastActiveAtMs = Date.parse(lastActiveAt);
  const now = Date.now();
  const tokenUsage = normalized?.tokenUsage || normalized?.insights?.tokenUsage || null;
  const inputTokens = Number(normalized.inputTokens ?? tokenUsage?.inputTokens ?? 0);
  const outputTokens = Number(normalized.outputTokens ?? tokenUsage?.outputTokens ?? 0);
  const totalTokens = Number(
    normalized.totalTokens ?? normalized.tokenCount ?? tokenUsage?.totalTokens ?? (inputTokens + outputTokens),
  );
  const contextWindow = normalizeContextWindow(
    normalized.contextWindow ?? normalized.insights?.contextWindow,
    totalTokens,
  );
  const contextUsagePercent = Number.isFinite(Number(normalized.contextUsagePercent))
    ? Math.max(0, Math.min(100, Number(Number(normalized.contextUsagePercent).toFixed(1))))
    : contextWindow.percent;
  const contextPressure = String(
    normalized.contextPressure || getContextPressureLevel(contextUsagePercent),
  ).trim() || getContextPressureLevel(contextUsagePercent);
  const runtimeHealth = normalizeRuntimeHealth(normalized.runtimeHealth, {
    state: normalized.runtimeState || normalized.status || "unknown",
    live: normalized.runtimeIsLive,
    idleMs: normalized.idleMs,
    contextPressure,
    contextUsagePercent,
    toolCalls: normalized.toolCalls,
    toolResults: normalized.toolResults,
    errors: normalized.errors,
    hasEdits: normalized.hasEdits,
    hasCommits: normalized.hasCommits,
  });
  normalized.inputTokens = Number.isFinite(inputTokens) ? Math.max(0, Math.round(inputTokens)) : 0;
  normalized.outputTokens = Number.isFinite(outputTokens) ? Math.max(0, Math.round(outputTokens)) : 0;
  normalized.totalTokens = Number.isFinite(totalTokens)
    ? Math.max(0, Math.round(totalTokens))
    : (normalized.inputTokens + normalized.outputTokens);
  normalized.createdAt = createdAt;
  normalized.lastActiveAt = lastActiveAt;
  normalized.branch = normalized.branch == null
    ? (normalized.branchName == null ? null : String(normalized.branchName))
    : String(normalized.branch);
  normalized.idleMs = nonNegativeNumber(
    normalized.idleMs,
    Number.isFinite(lastActiveAtMs) ? Math.max(0, now - lastActiveAtMs) : 0,
  );
  normalized.elapsedMs = nonNegativeNumber(
    normalized.elapsedMs,
    Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : normalized.idleMs,
  );
  normalized.recommendation = normalized.recommendation == null
    ? ""
    : String(normalized.recommendation);
  normalized.preview = normalized.preview == null
    ? (normalized.summary == null ? null : String(normalized.summary))
    : String(normalized.preview);
  normalized.lastMessage = normalized.lastMessage == null
    ? (normalized.agentLastMessage == null ? null : String(normalized.agentLastMessage))
    : String(normalized.lastMessage);
  normalized.insights = normalized.insights && typeof normalized.insights === "object"
    ? { ...normalized.insights }
    : {};
  normalized.tokenCount = normalized.totalTokens;
  normalized.totalEvents = nonNegativeNumber(normalized.totalEvents, 0);
  normalized.hasEdits = Boolean(normalized.hasEdits);
  normalized.hasCommits = Boolean(normalized.hasCommits);
  normalized.toolCalls = nonNegativeNumber(normalized.toolCalls, 0);
  normalized.toolResults = nonNegativeNumber(normalized.toolResults, 0);
  normalized.errors = nonNegativeNumber(normalized.errors, 0);
  normalized.commandExecutions = nonNegativeNumber(normalized.commandExecutions, 0);
  normalized.fileCounts = normalizeFileCounts(normalized.fileCounts);
  normalized.topTools = normalizeTopTools(normalized.topTools, 5);
  normalized.recentActions = normalizeRecentActions(normalized.recentActions, 6);
  normalized.contextWindow = contextWindow;
  normalized.contextUsagePercent = contextUsagePercent;
  normalized.contextPressure = contextPressure;
  normalized.runtimeIsLive = Boolean(normalized.runtimeIsLive);
  normalized.runtimeHealth = runtimeHealth;
  normalized.lastEventType = normalized.lastEventType == null ? null : String(normalized.lastEventType);
  normalized.lastToolName = normalized.lastToolName == null ? null : String(normalized.lastToolName);
  normalized.lastActionAt = normalized.lastActionAt == null ? null : String(normalized.lastActionAt);
  normalized.runtimeUpdatedAt = normalized.runtimeUpdatedAt == null ? null : String(normalized.runtimeUpdatedAt);
  return normalized;
}

function normalizeSessionList(sessions = []) {
  return Array.isArray(sessions) ? sessions.map((session) => normalizeSessionSummary(session)) : [];
}

function sumRuntimeTokens(runtimeStats = {}) {
  const sessions = Array.isArray(runtimeStats?.sessions) ? runtimeStats.sessions : [];
  return sessions.reduce((acc, session) => {
    acc.tokensIn += nonNegativeNumber(session?.inputTokens, 0);
    acc.tokensOut += nonNegativeNumber(session?.outputTokens, 0);
    return acc;
  }, { tokensIn: 0, tokensOut: 0 });
}

function summarizeRateLimits(rateLimits = {}) {
  const providers = Object.values(rateLimits || {});
  let providersNearExhaustion = 0;
  let providersExhausted = 0;
  for (const bucket of providers) {
    const ratios = [
      [bucket?.primary, bucket?.primaryLimit],
      [bucket?.secondary, bucket?.secondaryLimit],
      [bucket?.credits, bucket?.creditsLimit],
    ]
      .map(([remaining, limit]) => {
        const safeRemaining = Number(remaining);
        const safeLimit = Number(limit);
        if (Number.isFinite(safeRemaining) && Number.isFinite(safeLimit) && safeLimit > 0) {
          return safeRemaining / safeLimit;
        }
        if (Number.isFinite(safeRemaining)) {
          if (safeRemaining <= 0) return 0;
          if (safeRemaining <= 5) return 0.2;
        }
        return null;
      })
      .filter((value) => value != null);
    if (!ratios.length) continue;
    const minRatio = Math.min(...ratios);
    if (minRatio <= 0) providersExhausted += 1;
    else if (minRatio <= 0.2) providersNearExhaustion += 1;
  }
  return {
    providerCount: providers.length,
    providersNearExhaustion,
    providersExhausted,
  };
}

function summarizeSessions(activeSessions = [], runtimeStats = {}) {
  const liveSessions = normalizeSessionList(activeSessions);
  const completedSessions = normalizeSessionList(
    Array.isArray(runtimeStats?.completedSessions)
      ? runtimeStats.completedSessions
      : (Array.isArray(runtimeStats?.sessions) ? runtimeStats.sessions : []),
  );
  const sessionHealth = {
    live: 0,
    active: 0,
    working: 0,
    editing: 0,
    committing: 0,
    idle: 0,
    stalled: 0,
    blocked: 0,
    completed: Math.max(0, numberOr(runtimeStats?.sessionCount, completedSessions.length)),
  };
  let liveMaxContext = null;
  let liveContextTotal = 0;
  let liveContextCount = 0;
  let liveNearLimit = 0;
  let liveHighPressure = 0;
  let liveToolCalls = 0;
  let liveToolResults = 0;
  let liveErrors = 0;
  let liveEditOps = 0;
  let liveCommitOps = 0;
  let liveSessionsWithEdits = 0;
  let liveSessionsWithCommits = 0;
  const liveToolCounts = new Map();
  for (const session of liveSessions) {
    const healthState = String(session?.runtimeHealth?.state || session?.runtimeState || session?.status || "active").trim() || "active";
    const lifecycleStatus = String(session?.lifecycleStatus || session?.status || "").trim();
    sessionHealth.live += session.runtimeIsLive ? 1 : 0;
    if (sessionHealth[healthState] != null) {
      sessionHealth[healthState] += 1;
    } else if (lifecycleStatus.startsWith("blocked_") || lifecycleStatus === "implementation_done_commit_blocked") {
      sessionHealth.blocked += 1;
    } else {
      sessionHealth.active += 1;
    }
    const contextPercent = Number(session?.contextUsagePercent ?? session?.contextWindow?.percent);
    if (Number.isFinite(contextPercent)) {
      const safePercent = Math.max(0, Math.min(100, contextPercent));
      liveMaxContext = liveMaxContext == null ? safePercent : Math.max(liveMaxContext, safePercent);
      liveContextTotal += safePercent;
      liveContextCount += 1;
      if (safePercent >= 85) liveNearLimit += 1;
      if (safePercent >= 70) liveHighPressure += 1;
    }
    liveToolCalls += nonNegativeNumber(session?.toolCalls, 0);
    liveToolResults += nonNegativeNumber(session?.toolResults, 0);
    liveErrors += nonNegativeNumber(session?.errors, 0);
    liveEditOps += nonNegativeNumber(session?.fileCounts?.editOps, 0);
    if (session?.hasEdits) liveSessionsWithEdits += 1;
    if (session?.hasCommits) {
      liveSessionsWithCommits += 1;
      liveCommitOps += 1;
    }
    for (const tool of normalizeTopTools(session?.topTools, 8)) {
      liveToolCounts.set(tool.name, (liveToolCounts.get(tool.name) || 0) + tool.count);
    }
  }
  const runtimeContext = runtimeStats?.contextSummary && typeof runtimeStats.contextSummary === "object"
    ? runtimeStats.contextSummary
    : {};
  const completedMax = Number(runtimeContext.maxUsagePercent);
  const avgValues = [];
  if (liveContextCount > 0) avgValues.push(liveContextTotal / liveContextCount);
  if (Number.isFinite(Number(runtimeContext.avgUsagePercent))) avgValues.push(Number(runtimeContext.avgUsagePercent));
  return {
    activeSessionCount: liveSessions.length || nonNegativeNumber(runtimeStats?.activeSessionCount, 0),
    completedSessionCount: Math.max(0, numberOr(runtimeStats?.sessionCount, completedSessions.length)),
    totalSessionCount: (liveSessions.length || 0) + Math.max(0, numberOr(runtimeStats?.sessionCount, completedSessions.length)),
    activeSessions: liveSessions,
    sessionHealth,
    context: {
      liveSessionCount: liveSessions.length,
      completedSessionCount: Math.max(0, numberOr(runtimeStats?.sessionCount, completedSessions.length)),
      sessionsNearContextLimit: liveNearLimit + nonNegativeNumber(runtimeContext.sessionsNearLimit, 0),
      sessionsHighContextPressure: liveHighPressure + nonNegativeNumber(runtimeContext.sessionsHighPressure, 0),
      maxContextUsagePercent: [liveMaxContext, completedMax]
        .filter((value) => Number.isFinite(Number(value)))
        .reduce((max, value) => (max == null ? Number(value) : Math.max(max, Number(value))), null),
      avgContextUsagePercent: avgValues.length
        ? Number((avgValues.reduce((sum, value) => sum + Number(value), 0) / avgValues.length).toFixed(1))
        : null,
    },
    toolSummary: {
      toolCalls: liveToolCalls,
      toolResults: liveToolResults,
      errors: liveErrors,
      editOps: liveEditOps,
      commitOps: liveCommitOps,
      sessionsWithEdits: liveSessionsWithEdits,
      sessionsWithCommits: liveSessionsWithCommits,
      topTools: Array.from(liveToolCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    },
  };
}

function mergeToolSummary(liveToolSummary = {}, runtimeToolSummary = {}) {
  const toolCounts = new Map();
  for (const tool of normalizeTopTools(liveToolSummary?.topTools, 8)) {
    toolCounts.set(tool.name, (toolCounts.get(tool.name) || 0) + tool.count);
  }
  for (const tool of normalizeTopTools(runtimeToolSummary?.topTools, 8)) {
    toolCounts.set(tool.name, (toolCounts.get(tool.name) || 0) + tool.count);
  }
  return {
    toolCalls: nonNegativeNumber(liveToolSummary?.toolCalls, 0) + nonNegativeNumber(runtimeToolSummary?.toolCalls, 0),
    toolResults: nonNegativeNumber(liveToolSummary?.toolResults, 0) + nonNegativeNumber(runtimeToolSummary?.toolResults, 0),
    errors: nonNegativeNumber(liveToolSummary?.errors, 0) + nonNegativeNumber(runtimeToolSummary?.errors, 0),
    editOps: nonNegativeNumber(liveToolSummary?.editOps, 0) + nonNegativeNumber(runtimeToolSummary?.editOps, 0),
    commitOps: nonNegativeNumber(liveToolSummary?.commitOps, 0) + nonNegativeNumber(runtimeToolSummary?.commitOps, 0),
    sessionsWithEdits: nonNegativeNumber(liveToolSummary?.sessionsWithEdits, 0) + nonNegativeNumber(runtimeToolSummary?.sessionsWithEdits, 0),
    sessionsWithCommits: nonNegativeNumber(liveToolSummary?.sessionsWithCommits, 0) + nonNegativeNumber(runtimeToolSummary?.sessionsWithCommits, 0),
    topTools: Array.from(toolCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  };
}

export function buildMonitorStatsPayload({ agentPool, runtimeStats = {}, uptimeMs = 0 } = {}) {
  const agentPoolStats = typeof agentPool?.getTuiStats === "function"
    ? (agentPool.getTuiStats() || {})
    : (agentPool && typeof agentPool === "object" ? agentPool : {});
  const activeSessions = normalizeSessionList(
    agentPoolStats.activeSessions ?? runtimeStats.activeSessions ?? [],
  );

  const runtimeTokenTotals = sumRuntimeTokens(runtimeStats);
  const tokensIn = nonNegativeNumber(
    agentPoolStats.tokensIn,
    runtimeStats.totalInputTokens ?? runtimeTokenTotals.tokensIn,
  );
  const tokensOut = nonNegativeNumber(
    agentPoolStats.tokensOut,
    runtimeStats.totalOutputTokens ?? runtimeTokenTotals.tokensOut,
  );
  const tokensTotal = nonNegativeNumber(
    agentPoolStats.tokensTotal ?? agentPoolStats.totalTokens,
    tokensIn + tokensOut,
  );
  const resolvedUptimeMs = nonNegativeNumber(
    uptimeMs,
    runtimeStats.startedAt ? Date.now() - Number(runtimeStats.startedAt) : 0,
  );
  const throughputTps = Number.isFinite(Number(agentPoolStats.throughputTps))
    ? roundMetric(agentPoolStats.throughputTps)
    : (resolvedUptimeMs > 0 ? roundMetric(tokensTotal / (resolvedUptimeMs / 1000)) : 0);
  const rateLimits = normalizeRateLimits(agentPoolStats.rateLimits ?? runtimeStats.rateLimits);
  const rateLimitSummary = summarizeRateLimits(rateLimits);
  const sessionSummary = summarizeSessions(activeSessions, runtimeStats);
  const toolSummary = mergeToolSummary(sessionSummary.toolSummary, runtimeStats.toolSummary);

  return {
    activeAgents: nonNegativeNumber(agentPoolStats.activeAgents, 0),
    maxAgents: nonNegativeNumber(agentPoolStats.maxAgents, 0),
    tokensIn,
    tokensOut,
    tokensTotal,
    totalTokens: tokensTotal,
    throughputTps,
    uptimeMs: resolvedUptimeMs,
    activeSessionCount: sessionSummary.activeSessionCount,
    completedSessionCount: sessionSummary.completedSessionCount,
    totalSessionCount: sessionSummary.totalSessionCount,
    rateLimits,
    rateLimitSummary,
    sessionHealth: sessionSummary.sessionHealth,
    context: sessionSummary.context,
    toolSummary,
    activeSessions: sessionSummary.activeSessions,
    executor: agentPoolStats.executor && typeof agentPoolStats.executor === "object"
      ? agentPoolStats.executor
      : null,
    recovery: agentPoolStats.recovery && typeof agentPoolStats.recovery === "object"
      ? agentPoolStats.recovery
      : null,
    harness: agentPoolStats.harness && typeof agentPoolStats.harness === "object"
      ? agentPoolStats.harness
      : null,
  };
}

export function buildSessionsUpdatePayload(sessions = []) {
  return normalizeSessionList(sessions);
}

export function buildSessionEventPayload(payload = {}) {
  const event = payload?.event && typeof payload.event === "object"
    ? { ...payload.event }
    : { kind: "message", ...(payload?.message ? { message: payload.message } : {}) };
  const session = payload?.session && typeof payload.session === "object"
    ? buildSessionsUpdatePayload([payload.session])[0]
    : {};
  return {
    sessionId: String(payload?.sessionId || session?.id || payload?.session?.id || "").trim(),
    taskId: String(payload?.taskId || session?.taskId || payload?.session?.taskId || "").trim(),
    session,
    event,
  };
}

export function buildWorkflowStatusPayload(payload = {}) {
  return {
    runId: String(payload?.runId || "").trim(),
    workflowId: String(payload?.workflowId || "").trim(),
    workflowName: String(payload?.workflowName || payload?.name || "").trim() || null,
    eventType: String(payload?.eventType || payload?.event || "").trim(),
    status: String(payload?.status || "unknown").trim() || "unknown",
    nodeId: String(payload?.nodeId || "").trim() || null,
    nodeType: String(payload?.nodeType || "").trim() || null,
    nodeLabel: String(payload?.nodeLabel || "").trim() || null,
    error: String(payload?.error || "").trim() || null,
    durationMs: Number.isFinite(Number(payload?.durationMs)) ? Number(payload.durationMs) : null,
    timestamp: nonNegativeNumber(payload?.timestamp, Date.now()),
    meta: payload?.meta && typeof payload.meta === "object" ? { ...payload.meta } : null,
  };
}

export function buildLogStreamPayload({ logType, query = null, filePath = null, line = "" } = {}) {
  const raw = String(line || "");
  const levelMatch = raw.match(/\b(trace|debug|info|warn|warning|error|fatal)\b/i);
  const timestampMatch = raw.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  return {
    logType: String(logType || "system").trim() || "system",
    query: query == null ? null : String(query),
    filePath: filePath == null ? null : String(filePath),
    line: raw,
    raw,
    level: levelMatch ? levelMatch[1].toLowerCase().replace("warning", "warn") : "info",
    timestamp: timestampMatch ? timestampMatch[0] : null,
  };
}

export function buildTasksUpdatePayload(payload = {}, { sourceEvent = "invalidate" } = {}) {
  const normalized = payload && typeof payload === "object" ? payload : {};
  const patch = normalized.patch && typeof normalized.patch === "object"
    ? { ...normalized.patch }
    : { ...normalized };
  const reason = String(normalized.reason || sourceEvent || "tasks-changed").trim() || "tasks-changed";
  const taskIds = Array.isArray(normalized.taskIds)
    ? normalized.taskIds.map((taskId) => String(taskId || "").trim()).filter(Boolean)
    : null;
  return {
    reason,
    sourceEvent: String(sourceEvent || "invalidate").trim() || "invalidate",
    taskId: String(normalized.taskId || normalized.id || "").trim() || null,
    taskIds: taskIds && taskIds.length ? taskIds : null,
    status: String(normalized.status || "").trim() || null,
    workspaceId: String(normalized.workspaceId || "").trim() || null,
    projectId: String(normalized.projectId || "").trim() || null,
    patch,
  };
}

export function resolveTuiAuthToken({ env = process.env, cacheDir, configDir = process.cwd() } = {}) {
  const envCandidates = [
    env?.BOSUN_TUI_AUTH_TOKEN,
    env?.BOSUN_TUI_WS_TOKEN,
    env?.BOSUN_UI_TOKEN,
    env?.BOSUN_WS_TOKEN,
  ];
  for (const candidate of envCandidates) {
    const token = String(candidate || "").trim();
    if (token) return token;
  }

  const resolvedCacheDir = resolveCacheDir({ cacheDir, configDir });
  const candidateFiles = [
    resolve(resolvedCacheDir, "ui-token"),
    resolve(resolvedCacheDir, "ui-session-token.json"),
  ];
  for (const filePath of candidateFiles) {
    try {
      if (!existsSync(filePath)) continue;
      const raw = readFileSync(filePath, "utf8").trim();
      if (!raw) continue;
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        const token = String(parsed?.token || "").trim();
        if (token) return token;
        continue;
      }
      return raw;
    } catch {
      // ignore invalid cache files
    }
  }
  return "";
}

export function persistCompatibleTuiAuthToken(token, { cacheDir, configDir = process.cwd() } = {}) {
  const normalized = String(token || "").trim();
  if (!normalized) return "";
  const resolvedCacheDir = resolveCacheDir({ cacheDir, configDir });
  mkdirSync(resolvedCacheDir, { recursive: true });
  writeFileSync(resolve(resolvedCacheDir, "ui-token"), `${normalized}\n`, "utf8");
  return normalized;
}

export function createTuiStatsEmitter({ intervalMs = 2000, getPayload, emit } = {}) {
  let timer = null;
  let inFlight = null;

  const tick = async () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => (typeof getPayload === "function" ? getPayload() : null))
      .then(async (payload) => {
        if (payload && typeof emit === "function") {
          await emit(payload);
        }
        return payload;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    async tick() {
      return tick();
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, Math.max(250, Number(intervalMs) || 2000));
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get isRunning() {
      return Boolean(timer);
    },
  };
}
