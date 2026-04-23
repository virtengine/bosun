const DEFAULT_RECOVERY_STATE = Object.freeze({
  health: "healthy",
  failureStreak: 0,
  failureCount: 0,
  successCount: 0,
  recentEvents: Object.freeze([]),
});

function normalizeRecoveryEvent(event = {}) {
  return {
    outcome: String(event?.outcome || "").trim().toLowerCase() || "healthy_noop",
    reason: String(event?.reason || "").trim() || null,
    branch: String(event?.branch || "").trim() || null,
    taskId: String(event?.taskId || "").trim() || null,
    worktreePath: String(event?.worktreePath || "").trim() || null,
    phase: String(event?.phase || "").trim() || null,
    error: String(event?.error || "").trim() || null,
    detectedIssues: Array.isArray(event?.detectedIssues)
      ? event.detectedIssues.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    timestamp: String(event?.timestamp || "").trim() || null,
  };
}

function normalizeWorktreeRecoveryState(input = null) {
  const source = input && typeof input === "object" ? input : {};
  const health = String(source.health || "").trim().toLowerCase();
  return {
    health: ["healthy", "recovered", "failing", "degraded"].includes(health)
      ? health
      : "healthy",
    failureStreak: Math.max(0, Number.parseInt(String(source.failureStreak || 0), 10) || 0),
    failureCount: Math.max(0, Number.parseInt(String(source.failureCount || 0), 10) || 0),
    successCount: Math.max(0, Number.parseInt(String(source.successCount || 0), 10) || 0),
    recentEvents: Array.isArray(source.recentEvents)
      ? source.recentEvents.map((event) => normalizeRecoveryEvent(event))
      : [],
  };
}

function buildWorktreeRecoveryViewModel(input = null) {
  const state = normalizeWorktreeRecoveryState(input);
  let headline = "Managed worktrees healthy";
  let summary = "No recent poisoned-worktree repairs.";
  let tone = "success";

  if (state.health === "recovered") {
    headline = "Poisoned worktree recovered";
    summary = "Recent managed worktree recreation succeeded.";
    tone = "warning";
  } else if (state.health === "failing") {
    headline = "Worktree recovery in progress";
    summary = `${state.failureStreak} consecutive recovery failure${state.failureStreak === 1 ? "" : "s"}.`;
    tone = "warning";
  } else if (state.health === "degraded") {
    headline = "Repeated poisoned worktree failures";
    summary = `${state.failureStreak} consecutive recovery failures require operator attention.`;
    tone = "error";
  }

  const events = state.recentEvents.map((event, index) => {
    const cleanLabel = (value) => {
      const text = String(value || "").trim();
      if (!text) return null;
      if (text.includes("{{") || text.includes("}}")) return null;
      return text;
    };
    const pathLabel = cleanLabel(event.branch)
      || cleanLabel(event.taskId)
      || cleanLabel(event.worktreePath)
      || "unknown worktree";
    const issuesLabel = event.detectedIssues.length ? ` · ${event.detectedIssues.join(", ")}` : "";
    return {
      key: `${event.timestamp || "event"}-${index}`,
      title: event.outcome === "recreated" ? "Recreated poisoned worktree" : "Recovery failed",
      detail: `${pathLabel}${issuesLabel}`,
      timestamp: event.timestamp,
      error: event.error || null,
    };
  });

  return {
    ...state,
    headline,
    summary,
    tone,
    events,
  };
}

export {
  buildWorktreeRecoveryViewModel,
  normalizeWorktreeRecoveryState,
};
