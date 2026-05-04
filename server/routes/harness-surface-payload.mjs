export async function buildHarnessSurfacePayload(options = {}, deps = {}) {
  const view = String(options?.view || "all").trim().toLowerCase() || "all";
  const limit = Math.max(1, Math.min(Number(options?.limit) || 25, 100));
  const logLines = Math.max(10, Math.min(Number(options?.logLines) || 30, 200));
  const includeAgents = view === "all" || view === "agents";
  const includeWorkflows = view === "all" || view === "workflows";
  const includeTelemetry = view === "all" || view === "telemetry" || view === "agents";
  const includeLogs = view === "all" || view === "logs";

  const harnessSummary = deps.getHarnessTelemetrySummary({ configDir: process.cwd() });
  const harnessLive = deps.getHarnessLiveTelemetrySnapshot({ configDir: process.cwd() });
  const harnessProviders = deps.getHarnessProviderUsageSummary({ configDir: process.cwd() });
  const harnessRuns = deps.mergeHarnessRunSummaries(
    deps.hydrateHarnessRunListItems(deps.listHarnessRuns(deps.resolveUiConfigDir(), { limit: Math.max(limit, 8) })),
    deps.listActiveHarnessRunSnapshots(),
    Math.max(limit, 8),
  );
  const { listApprovalRequests } = await import("../../workflow/approval-queue.mjs");
  const harnessApprovals = (() => {
    try {
      const listed = listApprovalRequests({
        repoRoot: deps.resolveHarnessApprovalRepoRoot(),
        scopeType: "harness-run",
        status: "pending",
        includeResolved: false,
        limit,
      });
      return Array.isArray(listed?.requests) ? listed.requests : [];
    } catch {
      return [];
    }
  })();

  const payload = {
    view,
    harness: {
      summary: harnessSummary,
      live: harnessLive,
      providers: harnessProviders,
      runs: harnessRuns,
      approvals: harnessApprovals,
    },
  };

  if (includeAgents) {
    payload.sessions = deps.getCurrentSessionSnapshot();
    payload.retryQueue = deps.getRetryQueueSurfaceSnapshot();
    payload.agent = deps.getAgentSurfaceSnapshot(limit);
  }

  if (includeTelemetry) {
    payload.telemetry = {
      monitor: deps.buildCurrentTuiMonitorStats(),
      harnessSummary,
      harnessLive,
      harnessProviders,
    };
  }

  if (includeWorkflows) {
    payload.workflows = {
      approvals: await deps.listWorkflowSurfaceApprovals(limit),
      runs: await deps.listWorkflowSurfaceRuns(Math.min(limit, 8)),
    };
  }

  if (includeLogs) {
    payload.logs = {
      tail: await deps.getLatestLogTail(logLines),
    };
  }

  return payload;
}
