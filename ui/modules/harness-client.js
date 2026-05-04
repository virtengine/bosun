function appendQuery(path, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    params.set(key, normalized);
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function buildHarnessSurfacePath(view = "all", options = {}) {
  return appendQuery("/api/harness/surface", {
    view,
    limit: options.limit,
    lines: options.lines,
  });
}

export function buildHarnessRunPath(runId = "", action = "", query = {}) {
  const safeId = encodeURIComponent(String(runId || "").trim());
  if (!safeId) return action ? `/api/harness/runs/${action}` : "/api/harness/runs";
  const suffix = action ? `/${String(action).trim()}` : "";
  return appendQuery(`/api/harness/runs/${safeId}${suffix}`, query);
}

export function buildHarnessApprovalPath(requestId = "", action = "", query = {}) {
  const safeId = encodeURIComponent(String(requestId || "").trim());
  const suffix = action ? `/${String(action).trim()}` : "";
  const base = safeId ? `/api/harness/approvals/${safeId}${suffix}` : "/api/harness/approvals";
  return appendQuery(base, query);
}

export function buildHarnessTelemetryPath(kind = "events", query = {}) {
  return appendQuery(`/api/telemetry/harness/${String(kind || "events").trim()}`, query);
}

export function buildHarnessSubagentPath(id = "", query = {}) {
  const safeId = encodeURIComponent(String(id || "").trim());
  const base = safeId ? `/api/harness/subagents/${safeId}` : "/api/harness/subagents";
  return appendQuery(base, query);
}

export function buildHarnessThreadPath(taskKey = "", action = "", query = {}) {
  const safeTaskKey = encodeURIComponent(String(taskKey || "").trim());
  const suffix = action ? `/${String(action).trim()}` : "";
  const base = safeTaskKey
    ? `/api/harness/threads/${safeTaskKey}${suffix}`
    : `/api/harness/threads${suffix}`;
  return appendQuery(base, query);
}

export function buildHarnessProviderSdkPath() {
  return "/api/providers/sdk";
}
