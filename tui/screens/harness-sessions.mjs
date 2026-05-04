function pad(text, width) {
  const value = String(text || "");
  if (width <= 0) return "";
  if (value.length >= width) return value.slice(0, width);
  return `${value}${" ".repeat(width - value.length)}`;
}

export function getHarnessRunState(run) {
  return String(
    run?.health?.state
    || run?.status
    || run?.outcome
    || run?.result?.status
    || run?.result?.outcome
    || "unknown",
  ).trim().toLowerCase();
}

export function getHarnessStateColor(state) {
  if (state === "working") return "blue";
  if (state === "waiting") return "yellow";
  if (state === "stalled" || state === "failed" || state === "aborted") return "red";
  if (state === "completed") return "green";
  return undefined;
}

export function getHarnessStateLabel(state) {
  if (!state) return "unknown";
  return state.replace(/[_-]+/g, " ");
}

export function getHarnessRunTimestamp(run) {
  const value = run?.updatedAt || run?.endedAt || run?.startedAt || run?.createdAt || 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function normalizeHarnessRuns(items) {
  const deduped = new Map();
  for (const run of Array.isArray(items) ? items : []) {
    if (!run || typeof run !== "object") continue;
    const runId = String(run?.runId || "").trim();
    if (!runId) continue;
    const existing = deduped.get(runId);
    if (!existing || getHarnessRunTimestamp(run) >= getHarnessRunTimestamp(existing)) {
      deduped.set(runId, run);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => getHarnessRunTimestamp(b) - getHarnessRunTimestamp(a));
}

export function formatHarnessStage(run) {
  return String(
    run?.currentStageId
    || run?.health?.approvalStageId
    || run?.stageId
    || run?.completedStageId
    || run?.result?.completedStageId
    || "—",
  ).trim() || "—";
}

export function getHarnessApprovalRequestId(run) {
  return String(
    run?.health?.approvalRequestId
    || run?.approvalRequestId
    || run?.requestId
    || run?.latestApproval?.requestId
    || "",
  ).trim();
}

export function getHarnessLatestEventSummary(run) {
  return String(
    run?.health?.lastEventSummary
    || run?.latestEvent?.summary
    || run?.summary
    || "",
  ).trim();
}

export function getHarnessAttentionDetail(run) {
  const state = getHarnessRunState(run);
  const approvalRequestId = getHarnessApprovalRequestId(run);
  const detail = String(run?.health?.attentionReason || run?.summary || "").trim();
  if (state === "waiting") {
    const base = detail || "Awaiting operator approval.";
    return approvalRequestId ? `${base} · ${approvalRequestId}` : base;
  }
  return detail || getHarnessLatestEventSummary(run) || "No summary yet";
}

export function projectHarnessRow(run, isSelected, width = 72) {
  const runId = String(run?.runId || "").trim();
  const state = getHarnessRunState(run);
  const stage = formatHarnessStage(run);
  const idleMs = Number(run?.health?.idleMs || 0) || 0;
  const summary = getHarnessLatestEventSummary(run) || getHarnessAttentionDetail(run);
  const left = `${runId.slice(0, 8) || "unknown"} ${stage} ${getHarnessStateLabel(state)}`;
  const right = idleMs > 0 ? `idle ${Math.round(idleMs / 1000)}s` : (run?.active ? "live" : "history");
  const head = `${left} ${right}`.trim();
  const text = `${head} · ${summary}`.trim();
  return {
    key: runId || head,
    color: getHarnessStateColor(state),
    inverse: isSelected,
    text: pad(text, width),
  };
}
