function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export async function tryHandleHarnessApprovalRoutes(context = {}) {
  const { req, res, path, url, deps = {} } = context;
  const {
    jsonResponse,
    parseBooleanLike,
    resolveHarnessApprovalRepoRoot,
    readJsonBody,
    activeHarnessRuns,
    recordActiveHarnessRunControlEvent,
    buildHarnessApprovalWakePrompt,
    buildHarnessActiveRunSnapshot,
    readHarnessRunRecordById,
    resolveUiConfigDir,
    invalidateHarnessApiCaches,
  } = deps;

  if (path === "/api/harness/approvals" && req.method === "GET") {
    try {
      const {
        listApprovalRequests,
        reconcileHarnessRunApprovalRequests,
      } = await import("../../workflow/approval-queue.mjs");
      const approvalsRepoRoot = resolveHarnessApprovalRepoRoot();
      reconcileHarnessRunApprovalRequests({
        repoRoot: approvalsRepoRoot,
        activeRunIds: new Set(activeHarnessRuns.keys()),
      });
      const listed = listApprovalRequests({
        repoRoot: approvalsRepoRoot,
        scopeType: "harness-run",
        status: url.searchParams.get("status") || "",
        includeResolved: parseBooleanLike(url.searchParams.get("includeResolved"), false),
        limit: Number(url.searchParams.get("limit") || 100),
      });
      jsonResponse(res, 200, {
        ok: true,
        path: listed.path,
        requests: listed.requests,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return true;
  }

  if (path.startsWith("/api/harness/approvals/")) {
    try {
      const subPath = path.replace("/api/harness/approvals/", "");
      const segments = subPath.split("/").map(decodeURIComponent);
      const requestId = toTrimmedString(segments[0] || "");
      const action = toTrimmedString(segments[1] || "");
      if (!requestId) {
        jsonResponse(res, 400, { ok: false, error: "requestId is required" });
        return true;
      }
      if (action !== "resolve" || req.method !== "POST") {
        jsonResponse(res, 404, { ok: false, error: "Approval action not found" });
        return true;
      }
      const {
        getApprovalRequestById,
        resolveApprovalRequest,
      } = await import("../../workflow/approval-queue.mjs");
      const approvalsRepoRoot = resolveHarnessApprovalRepoRoot();
      const request = getApprovalRequestById(requestId, { repoRoot: approvalsRepoRoot });
      if (!request || toTrimmedString(request?.scopeType) !== "harness-run") {
        jsonResponse(res, 404, { ok: false, error: "Harness approval request not found" });
        return true;
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const decision = toTrimmedString(body?.decision || "").toLowerCase();
      if (!["approved", "denied"].includes(decision)) {
        jsonResponse(res, 400, { ok: false, error: "decision must be approved or denied" });
        return true;
      }
      const actorId = toTrimmedString(body?.actorId || body?.actor || "ui-operator") || "ui-operator";
      const note = toTrimmedString(body?.note || "");
      const resolved = resolveApprovalRequest(request.requestId, {
        repoRoot: approvalsRepoRoot,
        decision,
        actorId,
        note,
      });
      const runId = toTrimmedString(request?.runId || request?.scopeId || "");
      const activeState = runId ? activeHarnessRuns.get(runId) : null;
      let wake = null;
      if (activeState?.sessionHandle?.steer) {
        recordActiveHarnessRunControlEvent(runId, {
          type: "harness:approval-resolved",
          runId,
          taskKey: activeState.taskKey,
          requestId: request.requestId,
          stageId: toTrimmedString(request?.stageId || "") || null,
          stageType: toTrimmedString(request?.stageType || "") || null,
          decision,
          actor: actorId,
          note,
          status: decision,
          timestamp: new Date().toISOString(),
        });
        wake = activeState.sessionHandle.steer(buildHarnessApprovalWakePrompt(request, {
          decision,
          actorId,
          note,
        }), {
          kind: "approval",
          actor: actorId,
          reason: decision,
          decision,
          note,
          requestId: request.requestId,
          requestedStageId: toTrimmedString(request?.stageId || "") || null,
        });
        activeState.updatedAt = new Date().toISOString();
        activeHarnessRuns.set(runId, activeState);
        invalidateHarnessApiCaches();
      }
      jsonResponse(res, 200, {
        ok: true,
        request: resolved.request,
        active: Boolean(activeState),
        wake,
        updateResult: resolved.updateResult || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err?.message || String(err) });
    }
    return true;
  }

  const harnessApprovalMatch = path.match(/^\/api\/harness\/runs\/([^/]+)\/approval$/);
  if (harnessApprovalMatch && (req.method === "GET" || req.method === "POST")) {
    try {
      const runId = decodeURIComponent(harnessApprovalMatch[1]);
      const approvalsRepoRoot = resolveHarnessApprovalRepoRoot();
      const {
        getHarnessRunApprovalRequest,
        resolveApprovalRequest,
        upsertHarnessRunApprovalRequest,
      } = await import("../../workflow/approval-queue.mjs");
      const activeState = activeHarnessRuns.get(runId);
      let persistedRun = null;
      if (!activeState) {
        try {
          persistedRun = readHarnessRunRecordById(resolveUiConfigDir(), runId);
        } catch {
          persistedRun = null;
        }
      }
      let request = getHarnessRunApprovalRequest(runId, { repoRoot: approvalsRepoRoot });
      if (req.method === "GET") {
        jsonResponse(res, 200, {
          ok: true,
          request,
          approvalPending: toTrimmedString(request?.status || "") === "pending",
          active: Boolean(activeState),
          runId,
        });
        return true;
      }
      const body = await readJsonBody(req);
      const decision = toTrimmedString(body?.decision || "").toLowerCase();
      if (["approved", "denied"].includes(decision)) {
        if (!request) {
          jsonResponse(res, 409, { ok: false, error: "No pending harness approval request exists for this run." });
          return true;
        }
        const actor = toTrimmedString(body?.actorId || body?.actor || "operator") || "operator";
        const note = toTrimmedString(body?.note || "");
        const resolved = resolveApprovalRequest(request.requestId, {
          repoRoot: approvalsRepoRoot,
          decision,
          actorId: actor,
          note,
        });
        let wake = null;
        if (activeState?.sessionHandle?.steer) {
          recordActiveHarnessRunControlEvent(runId, {
            type: "harness:approval-resolved",
            runId,
            taskKey: activeState.taskKey,
            requestId: request.requestId,
            stageId: resolved.request?.stageId || toTrimmedString(body?.stageId || "") || null,
            stageType: resolved.request?.stageType || null,
            decision,
            actor,
            note,
            status: decision,
            timestamp: new Date().toISOString(),
          });
          wake = activeState.sessionHandle.steer(buildHarnessApprovalWakePrompt(resolved.request, {
            decision,
            actorId: actor,
            note,
          }), {
            kind: "approval",
            actor,
            reason: decision,
            decision,
            note,
            requestId: request.requestId,
            requestedStageId: resolved.request?.stageId || toTrimmedString(body?.stageId || "") || null,
          });
          activeState.updatedAt = new Date().toISOString();
          activeHarnessRuns.set(runId, activeState);
          invalidateHarnessApiCaches();
        }
        jsonResponse(res, 200, {
          ok: true,
          runId,
          request: resolved.request,
          active: Boolean(activeState),
          wake,
          updateResult: resolved.updateResult || null,
        });
        return true;
      }

      const activeSnapshot = activeState ? buildHarnessActiveRunSnapshot(activeState) : null;
      const stageId =
        toTrimmedString(body?.stageId || "")
        || toTrimmedString(activeSnapshot?.latestStageId || persistedRun?.result?.currentStageId || "")
        || null;
      const stageType =
        toTrimmedString(body?.stageType || "")
        || toTrimmedString(activeSnapshot?.latestEvent?.stageType || "")
        || (Array.isArray(activeState?.compiledProfile?.stages)
          ? toTrimmedString(activeState.compiledProfile.stages.find((entry) => toTrimmedString(entry?.id || "") === stageId)?.type || "")
          : "")
        || null;
      const actor = toTrimmedString(body?.actor || body?.requestedBy || "operator") || "operator";
      const reason = toTrimmedString(body?.reason || "Harness run requires operator approval before continuation.")
        || "Harness run requires operator approval before continuation.";
      const preview = toTrimmedString(body?.preview || activeSnapshot?.latestEvent?.summary || persistedRun?.result?.error || "") || null;
      const created = upsertHarnessRunApprovalRequest({
        runId,
        taskId: activeState?.taskId || persistedRun?.taskId || null,
        taskTitle: toTrimmedString(body?.taskTitle || "") || null,
        taskKey: activeState?.taskKey || persistedRun?.taskKey || null,
        stageId,
        stageType,
        agentId: activeState?.compiledProfile?.agentId || persistedRun?.compiledProfile?.agentId || null,
        artifactId: activeState?.artifactId || persistedRun?.artifactId || null,
        sourceOrigin: activeState?.sourceOrigin || persistedRun?.sourceOrigin || null,
        sourcePath: activeState?.sourcePath || persistedRun?.sourcePath || null,
        requestedBy: actor,
        reason,
        preview,
        timeoutMs: body?.timeoutMs,
        mode: toTrimmedString(body?.mode || "manual") || "manual",
      }, { repoRoot: approvalsRepoRoot });
      request = created.request;
      if (activeState && request) {
        recordActiveHarnessRunControlEvent(runId, {
          type: "harness:approval-requested",
          runId,
          taskKey: activeState.taskKey,
          requestId: request.requestId,
          stageId,
          stageType,
          actor,
          reason,
          status: "pending",
          timestamp: new Date().toISOString(),
        });
        activeState.updatedAt = new Date().toISOString();
        activeHarnessRuns.set(runId, activeState);
        invalidateHarnessApiCaches();
      }
      jsonResponse(res, request ? 200 : 400, {
        ok: Boolean(request),
        runId,
        request,
        approvalPending: Boolean(request && toTrimmedString(request.status || "") === "pending"),
        active: Boolean(activeState),
        created: created?.created === true,
        reopened: created?.reopened === true,
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}
