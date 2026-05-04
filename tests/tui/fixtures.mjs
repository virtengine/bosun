export const monitorStatsFixture = {
  uptimeMs: 90_000,
  runtimeMs: 45_000,
  totalCostUsd: 12.5,
  totalSessions: 4,
  activeSessions: 1,
  totalTasks: 3,
  activeTasks: 1,
  completedTasks: 1,
  failedTasks: 1,
  workflows: { active: ["wf-1"], total: 3 },
  agents: { online: 2, total: 4 },
  retryQueue: {
    count: 1,
    items: [
      {
        taskId: "task-7",
        taskTitle: "Retry flaky test",
        retryCount: 2,
        nextRetryAt: "2026-03-23T00:00:02.000Z",
        lastError: "timeout",
      },
    ],
  },
  cpu: { usage: 17.4 },
  memory: { used: 256 * 1024 * 1024, total: 1024 * 1024 * 1024 },
  tokensIn: 12_300,
  tokensOut: 4_560,
  tokensTotal: 16_860,
  activeSessionCount: 1,
  completedSessionCount: 1,
  totalSessionCount: 2,
  sessionHealth: {
    live: 1,
    active: 0,
    working: 0,
    editing: 1,
    committing: 0,
    idle: 0,
    stalled: 0,
    blocked: 0,
    completed: 1,
  },
  context: {
    liveSessionCount: 1,
    completedSessionCount: 1,
    sessionsNearContextLimit: 1,
    sessionsHighContextPressure: 1,
    maxContextUsagePercent: 92,
    avgContextUsagePercent: 92,
  },
  rateLimitSummary: {
    providerCount: 1,
    providersNearExhaustion: 1,
    providersExhausted: 0,
  },
  toolSummary: {
    toolCalls: 3,
    toolResults: 2,
    errors: 0,
    editOps: 1,
    commitOps: 0,
    sessionsWithEdits: 1,
    sessionsWithCommits: 0,
    topTools: [
      { name: "apply_patch", count: 1 },
      { name: "command_execution", count: 1 },
    ],
  },
  executor: {
    mode: "internal",
    paused: false,
    activeSlots: 1,
    maxParallel: 3,
    slots: [
      {
        taskId: "task-1",
        taskTitle: "Investigate failing build",
        sdk: "codex",
        model: "gpt-5.4",
        status: "running",
        runningFor: 95,
      },
    ],
  },
  recovery: {
    totals: {
      runs: 4,
      failures: 0,
      resumed: 2,
      resetToTodo: 3,
      reconciledDrift: 1,
      skippedForActiveClaim: 2,
      skippedForNoCommitBlock: 0,
      resetUnstarted: 1,
      staleSharedClaim: 2,
      workflowOwnerlessReset: 1,
    },
    lastRun: {
      trigger: "interval",
      scannedCount: 3,
      resumedCount: 1,
      resetToTodoCount: 1,
      reconciledDriftCount: 1,
      skippedForActiveClaimCount: 1,
      skippedForNoCommitBlockCount: 0,
      resetUnstartedCount: 0,
      staleSharedClaimCount: 1,
      workflowOwnerlessResetCount: 1,
      durationMs: 4200,
    },
    recentRuns: [],
  },
};

export const sessionsFixture = [
  {
    id: "session-active-1",
    status: "active",
    title: "Investigate failing build",
    taskId: "task-1",
    createdAt: "2026-03-23T00:00:00.000Z",
    lastActiveAt: "2026-03-23T00:00:30.000Z",
    turnCount: 3,
    elapsedMs: 30_000,
    recommendation: "continue",
    lastMessage: "Applied the first fix candidate",
    branch: "ve/fix-build",
    metadata: { pid: 4120, workspaceId: "ws-1", workspaceDir: "/tmp/ws-1", model: "gpt-5.4", agent: "primary" },
    insights: { contextWindow: { usedTokens: 2300, totalTokens: 32000 } },
    contextWindow: { usedTokens: 184000, totalTokens: 200000, percent: 92 },
    contextUsagePercent: 92,
    contextPressure: "critical",
    topTools: [{ name: "apply_patch", count: 1 }],
    recentActions: [{ type: "tool_call", label: "apply_patch", level: "info", timestamp: "2026-03-23T00:00:25.000Z" }],
    runtimeHealth: {
      state: "editing",
      severity: "critical",
      live: true,
      idleMs: 1000,
      contextPressure: "critical",
      contextUsagePercent: 92,
      toolCalls: 2,
      toolResults: 1,
      errors: 0,
      hasEdits: true,
      hasCommits: false,
      reasons: ["critical_context", "edits"],
    },
  },
  {
    id: "session-done-2",
    status: "completed",
    title: "Merge cleanup",
    taskId: "task-2",
    createdAt: "2026-03-23T00:00:00.000Z",
    lastActiveAt: "2026-03-23T00:00:20.000Z",
    turnCount: 6,
    elapsedMs: 20_000,
    metadata: { pid: 5120 },
  },
];

export const tasksFixture = [
  { id: "task-1", title: "Fix CI failure", status: "todo" },
  { id: "task-2", title: "Review PR #404", status: "inprogress" },
  { id: "task-3", title: "Ship release notes", status: "done" },
];

export const sessionDetailFixture = {
  ok: true,
  session: {
    ...sessionsFixture[0],
    turnCount: 24,
    turns: Array.from({ length: 24 }, (_, index) => ({
      id: `turn-${index + 1}`,
      number: index + 1,
      timestamp: `2026-03-23T00:00:${String(index).padStart(2, "0")}.000Z`,
      tokenDelta: 120 + index,
      durationMs: 900 + index * 25,
      eventType: index % 3 === 0 ? "tool_call" : index % 3 === 1 ? "assistant" : "tool_result",
    })),
    messages: [
      { timestamp: "2026-03-23T00:00:00.000Z", role: "user", content: "Start debugging" },
      { timestamp: "2026-03-23T00:00:05.000Z", role: "assistant", content: "Loaded the relevant logs" },
    ],
  },
};

export const sessionDiffFixture = {
  ok: true,
  summary: "2 files changed",
  diff: {
    files: [
      { filename: "src/app.mjs", additions: 8, deletions: 2 },
      { filename: "tests/app.test.mjs", additions: 4, deletions: 0 },
    ],
  },
};

export const FIXTURE_STATS = {
  ...monitorStatsFixture,
  tokensIn: 1234,
  tokensOut: 5678,
  tokensTotal: 6912,
  activeSessions: sessionsFixture,
};

export const FIXTURE_SESSIONS = [
  {
    ...sessionsFixture[0],
    title: "Synthesized failing smoke test",
  },
  ...sessionsFixture.slice(1),
];

monitorStatsFixture.activeSessions = sessionsFixture;

export const FIXTURE_TASKS = [
  { id: "task-1", title: "Fix CI failure", status: "todo" },
  { id: "task-2", title: "Review PR #404", status: "inprogress" },
  { id: "task-3", title: "Ship release notes", status: "done" },
  { id: "task-4", title: "Triage websocket bridge", status: "blocked" },
  { id: "task-5", title: "Ship smoke test", status: "done" },
];

export const tuiConfigFixture = {
  ok: true,
  meta: {
    configPath: "/tmp/bosun.config.json",
  },
  sections: [
    {
      id: "general",
      label: "General",
      items: [
        {
          kind: "field",
          id: "projectName",
          path: "projectName",
          depth: 0,
          label: "projectName",
          valueText: "Bosun Demo",
          sourceLabel: "from config",
          description: "Display name",
          editorKind: "string",
          readOnly: false,
          masked: false,
          enumValues: [],
        },
      ],
    },
    {
      id: "kanban",
      label: "Kanban",
      items: [
        {
          kind: "group",
          id: "group:kanban",
          path: "kanban",
          depth: 0,
          label: "kanban",
        },
        {
          kind: "field",
          id: "kanban.backend",
          path: "kanban.backend",
          depth: 1,
          label: "backend",
          valueText: "github",
          sourceLabel: "from config",
          description: "Backend",
          editorKind: "enum",
          readOnly: false,
          masked: false,
          enumValues: ["internal", "github", "jira", "repo-mirror"],
        },
      ],
    },
  ],
};

export function createMockWsClient() {
  const listeners = new Map();
  return {
    host: "127.0.0.1",
    port: 3080,
    connectCalled: 0,
    disconnectCalled: 0,
    connect() {
      this.connectCalled += 1;
    },
    disconnect() {
      this.disconnectCalled += 1;
    },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback);
    },
    async getConfigTree() {
      return tuiConfigFixture;
    },
    async saveConfigField(path, value) {
      const target = tuiConfigFixture.sections
        .flatMap((section) => section.items)
        .find((item) => item.path === path);
      if (target) {
        target.valueText = String(value);
      }
      return { ok: true, path };
    },
    emit(event, payload) {
      for (const callback of listeners.get(event) || []) callback(payload);
    },
  };
}
