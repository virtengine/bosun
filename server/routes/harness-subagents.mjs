function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeQueryFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function buildLineagePayload(deps = {}, sessionId = "") {
  const sessionManager = deps.getBosunSessionManager?.();
  if (!sessionManager) {
    return {
      sessionId: toTrimmedString(sessionId) || null,
      lineage: null,
      items: [],
      threads: [],
    };
  }
  const normalizedSessionId = toTrimmedString(sessionId);
  const lineageView = normalizedSessionId
    ? sessionManager.getLineageView?.(normalizedSessionId) || null
    : null;
  const graph = sessionManager.getLineageGraph?.();
  const items = normalizedSessionId
    ? graph?.getSubagents?.(normalizedSessionId) || []
    : sessionManager.getSubagentControl?.()?.listSpawnRecords?.() || [];
  const threads = normalizedSessionId
    ? lineageView?.threadLineage || []
    : sessionManager.getThreadRegistry?.()?.listThreads?.() || [];
  return {
    sessionId: normalizedSessionId || null,
    lineage: lineageView,
    items,
    threads,
  };
}

export function getHarnessSubagentSnapshot(deps = {}, sessionId = "") {
  return buildLineagePayload(deps, sessionId);
}

export async function tryHandleHarnessSubagentRoutes(context = {}) {
  const { req, res, path, url, deps = {} } = context;
  const { jsonResponse, getBosunSessionManager } = deps;

  if (path === "/api/harness/subagents" && req.method === "GET") {
    try {
      const sessionId = toTrimmedString(url.searchParams.get("sessionId") || "");
      const parentSessionId = toTrimmedString(url.searchParams.get("parentSessionId") || "");
      const status = toTrimmedString(url.searchParams.get("status") || "");
      const includeThreads = normalizeQueryFlag(url.searchParams.get("includeThreads"));
      const payload = buildLineagePayload(deps, sessionId || parentSessionId);
      let items = Array.isArray(payload.items) ? payload.items : [];
      if (parentSessionId) {
        items = items.filter((entry) => toTrimmedString(entry?.parentSessionId) === parentSessionId);
      }
      if (status) {
        items = items.filter((entry) => toTrimmedString(entry?.status).toLowerCase() === status.toLowerCase());
      }
      jsonResponse(res, 200, {
        ok: true,
        sessionId: payload.sessionId,
        items,
        lineage: payload.lineage || null,
        threads: includeThreads ? payload.threads : undefined,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  const subagentMatch = path.match(/^\/api\/harness\/subagents\/([^/]+)$/);
  if (subagentMatch && req.method === "GET") {
    try {
      const lookupId = decodeURIComponent(subagentMatch[1]);
      const sessionManager = getBosunSessionManager();
      const subagentControl = sessionManager.getSubagentControl?.();
      const record = subagentControl?.getSubagent?.(lookupId) || null;
      if (!record) {
        jsonResponse(res, 404, { ok: false, error: `Harness subagent not found: ${lookupId}` });
        return true;
      }
      const payload = buildLineagePayload(deps, record.parentSessionId || record.childSessionId || "");
      jsonResponse(res, 200, {
        ok: true,
        record,
        lineage: payload.lineage || null,
        threadLineage: Array.isArray(payload.threads) ? payload.threads : [],
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if ((path === "/api/harness/threads" || path === "/api/threads") && req.method === "GET") {
    try {
      const items = deps.getActiveThreads?.() || [];
      jsonResponse(res, 200, {
        ok: true,
        items,
        data: items,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/threads/reset" && req.method === "POST") {
    try {
      deps.clearThreadRegistry?.();
      jsonResponse(res, 200, { ok: true, cleared: true });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  const threadInvalidateMatch = path.match(/^\/api\/harness\/threads\/([^/]+)\/invalidate$/);
  if (threadInvalidateMatch && req.method === "POST") {
    try {
      const taskKey = decodeURIComponent(threadInvalidateMatch[1]);
      const invalidated = deps.invalidateThread?.(taskKey) === true;
      jsonResponse(res, invalidated ? 200 : 404, {
        ok: invalidated,
        taskKey,
        invalidated,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}
