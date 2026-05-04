import { buildHarnessSurfacePayload } from "./harness-surface-payload.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function buildTelemetryFilter(url) {
  return {
    taskId: url.searchParams.get("taskId") || undefined,
    sessionId: url.searchParams.get("sessionId") || undefined,
    runId: url.searchParams.get("runId") || undefined,
    type: url.searchParams.get("type") || undefined,
    category: url.searchParams.get("category") || undefined,
    source: url.searchParams.get("source") || undefined,
    since: url.searchParams.get("since") || undefined,
    limit: url.searchParams.get("limit") || undefined,
  };
}

export async function tryHandleHarnessEventRoutes(context = {}) {
  const { req, res, path, url, deps = {} } = context;
  const {
    jsonResponse,
    getHarnessTelemetrySummary,
    getHarnessLiveTelemetrySnapshot,
    listHarnessTelemetryEvents,
    getHarnessProviderUsageSummary,
    exportHarnessTelemetryTrace,
    getHarnessRuntimeConfig,
    readActiveHarnessState,
    readHarnessArtifact,
    resolveUiConfigDir,
    listActiveHarnessRunSnapshots,
    hydrateHarnessRunListItems,
    mergeHarnessRunSummaries,
    listHarnessRuns,
    parseBooleanLike,
    getActiveHarnessRunSnapshot,
    readHarnessRunRecordById,
    listHarnessRunEvents,
    buildPersistedHarnessRunSummary,
    buildHarnessEventSummary,
    readJsonBody,
    executeHarnessRunRequest,
    activeHarnessRuns,
    invalidateHarnessApiCaches,
    resolveHarnessCompileSource,
    compileHarnessSourceToArtifact,
    buildHarnessCompilePayload,
    shouldEnforceHarnessValidation,
    activateHarnessArtifact,
    repoRoot,
  } = deps;

  if (path === "/api/telemetry/harness/summary") {
    try {
      jsonResponse(res, 200, { ok: true, data: getHarnessTelemetrySummary({ configDir: process.cwd() }) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/telemetry/harness/live") {
    try {
      jsonResponse(res, 200, { ok: true, data: getHarnessLiveTelemetrySnapshot({ configDir: process.cwd() }) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/telemetry/harness/events") {
    try {
      jsonResponse(res, 200, {
        ok: true,
        events: listHarnessTelemetryEvents(buildTelemetryFilter(url), { configDir: process.cwd() }),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/telemetry/harness/providers") {
    try {
      jsonResponse(res, 200, { ok: true, data: getHarnessProviderUsageSummary({ configDir: process.cwd() }) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/telemetry/harness/trace") {
    try {
      jsonResponse(res, 200, {
        ok: true,
        data: exportHarnessTelemetryTrace(buildTelemetryFilter(url), { configDir: process.cwd() }),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/active" && req.method === "GET") {
    try {
      const harnessConfig = getHarnessRuntimeConfig();
      const activeState = readActiveHarnessState(resolveUiConfigDir());
      let artifact = null;
      if (activeState?.artifactPath) {
        try {
          artifact = readHarnessArtifact(activeState.artifactPath);
        } catch {
          artifact = null;
        }
      }
      jsonResponse(res, 200, {
        ok: true,
        harnessConfig,
        activeState,
        artifact: artifact
          ? {
              artifactId: artifact.artifactId,
              artifactPath: artifact.artifactPath,
              isValid: artifact.isValid,
              sourceOrigin: artifact.sourceOrigin,
              sourcePath: artifact.sourcePath,
              compiledProfile: artifact.compiledProfile,
              validationReport: artifact.validationReport,
            }
          : null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/surface" && req.method === "GET") {
    try {
      const view = toTrimmedString(url.searchParams.get("view") || "all").toLowerCase() || "all";
      const limit = Number(url.searchParams.get("limit") || 25);
      const logLines = Number(url.searchParams.get("lines") || 30);
      const payload = await buildHarnessSurfacePayload({
        view,
        limit,
        logLines,
      }, deps);
      jsonResponse(res, 200, { ok: true, ...payload });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/runs" && req.method === "GET") {
    try {
      const limit = Number(url.searchParams.get("limit") || 25);
      const activeRuns = listActiveHarnessRunSnapshots();
      const persistedRuns = hydrateHarnessRunListItems(
        listHarnessRuns(resolveUiConfigDir(), { limit: Math.max(limit, 25) }),
      );
      let items = mergeHarnessRunSummaries(persistedRuns, activeRuns, Math.max(limit, 25));
      const stateFilter = toTrimmedString(url.searchParams.get("state") || "").toLowerCase();
      const waitingForOperatorFilter = url.searchParams.get("waitingForOperator");
      const staleFilter = url.searchParams.get("stale");
      if (stateFilter) {
        items = items.filter((item) => toTrimmedString(item?.health?.state || "").toLowerCase() === stateFilter);
      }
      if (waitingForOperatorFilter != null && waitingForOperatorFilter !== "") {
        const expected = parseBooleanLike(waitingForOperatorFilter, false);
        items = items.filter((item) => Boolean(item?.health?.waitingForOperator) === expected);
      }
      if (staleFilter != null && staleFilter !== "") {
        const expected = parseBooleanLike(staleFilter, false);
        items = items.filter((item) => Boolean(item?.health?.isStale) === expected);
      }
      jsonResponse(res, 200, {
        ok: true,
        activeRunCount: activeRuns.length,
        items: items.slice(0, Math.max(1, limit)),
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessRunEventsMatch = path.match(/^\/api\/harness\/runs\/([^/]+)\/events$/);
  if (harnessRunEventsMatch && req.method === "GET") {
    try {
      const runId = decodeURIComponent(harnessRunEventsMatch[1]);
      const run = getActiveHarnessRunSnapshot(runId) || readHarnessRunRecordById(resolveUiConfigDir(), runId);
      const payload = listHarnessRunEvents(run, {
        limit: Number(url.searchParams.get("limit")) || 120,
        direction: url.searchParams.get("direction") || "asc",
        type: url.searchParams.get("type") || "",
        category: url.searchParams.get("category") || "",
      });
      jsonResponse(res, 200, {
        ok: true,
        runId,
        summary: payload.summary,
        events: payload.events,
      });
    } catch (err) {
      jsonResponse(res, 404, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessRunMatch = path.match(/^\/api\/harness\/runs\/([^/]+)$/);
  if (harnessRunMatch && req.method === "GET") {
    try {
      const runId = decodeURIComponent(harnessRunMatch[1]);
      const activeRun = getActiveHarnessRunSnapshot(runId);
      const run = activeRun || (() => {
        const record = readHarnessRunRecordById(resolveUiConfigDir(), runId);
        return {
          ...record,
          ...buildPersistedHarnessRunSummary(record, null),
        };
      })();
      const eventSummary = buildHarnessEventSummary(run?.events);
      jsonResponse(res, 200, {
        ok: true,
        run,
        eventSummary: {
          ...eventSummary,
          normalizedEvents: undefined,
        },
        normalizedEvents: eventSummary.normalizedEvents,
      });
    } catch (err) {
      jsonResponse(res, 404, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessReplayMatch = path.match(/^\/api\/harness\/runs\/([^/]+)\/replay$/);
  if (harnessReplayMatch && req.method === "POST") {
    try {
      const sourceRunId = decodeURIComponent(harnessReplayMatch[1]);
      const sourceRun = readHarnessRunRecordById(resolveUiConfigDir(), sourceRunId);
      const body = await readJsonBody(req);
      const replayPayload = await executeHarnessRunRequest({
        ...(body && typeof body === "object" ? body : {}),
        ...(toTrimmedString(body?.artifactPath || "") ? {} : (sourceRun?.artifactPath ? { artifactPath: sourceRun.artifactPath } : {})),
        ...(toTrimmedString(body?.sourcePath || "") || toTrimmedString(body?.source || "")
          ? {}
          : (sourceRun?.sourcePath ? { sourcePath: sourceRun.sourcePath } : {})),
        ...(toTrimmedString(body?.taskId || "") ? {} : (sourceRun?.taskId ? { taskId: sourceRun.taskId } : {})),
        ...(toTrimmedString(body?.taskKey || "") ? {} : (sourceRun?.taskKey ? { taskKey: sourceRun.taskKey } : {})),
      }, {
        harnessConfig: getHarnessRuntimeConfig(),
        replayedFromRunId: sourceRunId,
      });
      jsonResponse(res, 200, replayPayload);
    } catch (err) {
      const statusCode = Number(err?.statusCode) || (String(err?.message || "").includes("not found") ? 404 : 400);
      jsonResponse(res, statusCode, {
        ok: false,
        error: err.message,
        ...(err?.payload && typeof err.payload === "object" ? err.payload : {}),
      });
    }
    return true;
  }

  const harnessNudgeMatch = path.match(/^\/api\/harness\/runs\/([^/]+)\/nudge$/);
  if (harnessNudgeMatch && req.method === "POST") {
    try {
      const runId = decodeURIComponent(harnessNudgeMatch[1]);
      const activeState = activeHarnessRuns.get(runId);
      if (!activeState) {
        jsonResponse(res, 404, { ok: false, error: `Active harness run not found: ${runId}` });
        return true;
      }
      const body = await readJsonBody(req);
      const prompt = toTrimmedString(body?.prompt || body?.instruction || "");
      const mode = toTrimmedString(body?.mode || "steer").toLowerCase() || "steer";
      const actor = toTrimmedString(body?.actor || "operator") || "operator";
      const reason = toTrimmedString(body?.reason || "manual_intervention") || "manual_intervention";
      if (!prompt) {
        jsonResponse(res, 400, { ok: false, error: "prompt is required" });
        return true;
      }
      const steerResult = activeState.sessionHandle?.steer?.(prompt, {
        kind: mode,
        actor,
        reason,
        requestedStageId: toTrimmedString(body?.stageId || "") || null,
      }) || {
        ok: false,
        delivered: false,
        reason: "not_steerable",
        interventionType: mode,
        stageId: null,
        targetTaskKey: null,
      };
      activeState.updatedAt = new Date().toISOString();
      activeHarnessRuns.set(runId, activeState);
      invalidateHarnessApiCaches();
      jsonResponse(res, steerResult.ok ? 200 : 409, {
        ok: steerResult.ok === true,
        runId,
        active: true,
        mode,
        actor,
        delivered: steerResult.delivered === true,
        reason: steerResult.reason || null,
        stageId: steerResult.stageId || null,
        targetTaskKey: steerResult.targetTaskKey || null,
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  const harnessStopMatch = path.match(/^\/api\/harness\/runs\/([^/]+)\/stop$/);
  if (harnessStopMatch && req.method === "POST") {
    try {
      const runId = decodeURIComponent(harnessStopMatch[1]);
      const activeState = activeHarnessRuns.get(runId);
      if (!activeState) {
        try {
          readHarnessRunRecordById(resolveUiConfigDir(), runId);
          jsonResponse(res, 200, { ok: true, runId, stopped: false, active: false, stopRequested: false });
        } catch (error) {
          jsonResponse(res, 404, { ok: false, error: error.message });
        }
        return true;
      }
      if (activeState.stopRequested === true) {
        jsonResponse(res, 200, {
          ok: true,
          runId,
          stopped: false,
          active: true,
          stopRequested: true,
          stopRequestedAt: activeState.stopRequestedAt || null,
          reason: activeState.stopRequestedReason || null,
        });
        return true;
      }
      const body = await readJsonBody(req);
      const reason = toTrimmedString(body?.reason || "operator_stop") || "operator_stop";
      activeState.stopRequested = true;
      activeState.stopRequestedAt = new Date().toISOString();
      activeState.stopRequestedReason = reason;
      activeHarnessRuns.set(runId, activeState);
      invalidateHarnessApiCaches();
      try {
        activeState.abortController?.abort?.(reason);
      } catch {
      }
      try {
        activeState.sessionHandle?.controller?.abort?.(reason);
      } catch {
      }
      jsonResponse(res, 200, {
        ok: true,
        runId,
        stopped: true,
        active: true,
        stopRequested: true,
        stopRequestedAt: activeState.stopRequestedAt,
        reason,
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/compile" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const harnessConfig = getHarnessRuntimeConfig();
      const sourceInfo = resolveHarnessCompileSource(body || {}, harnessConfig);
      const validationMode = toTrimmedString(body?.validationMode || harnessConfig.validationMode || "report").toLowerCase() || "report";
      const compiled = compileHarnessSourceToArtifact(sourceInfo.source, {
        configDir: resolveUiConfigDir(),
        repoRoot,
        sourceOrigin: sourceInfo.sourceOrigin,
        sourcePath: sourceInfo.sourcePath,
        validationMode,
      });
      const payload = buildHarnessCompilePayload(compiled, harnessConfig);
      jsonResponse(res, payload.ok ? 200 : 400, payload);
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/activate" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const harnessConfig = getHarnessRuntimeConfig();
      const validationMode = toTrimmedString(body?.validationMode || harnessConfig.validationMode || "report").toLowerCase() || "report";
      let artifact = null;
      let compiled = null;
      if (typeof body?.artifactPath === "string" && body.artifactPath.trim()) {
        artifact = readHarnessArtifact(body.artifactPath);
      } else {
        const sourceInfo = resolveHarnessCompileSource(body || {}, harnessConfig);
        compiled = compileHarnessSourceToArtifact(sourceInfo.source, {
          configDir: resolveUiConfigDir(),
          repoRoot,
          sourceOrigin: sourceInfo.sourceOrigin,
          sourcePath: sourceInfo.sourcePath,
          validationMode,
        });
        artifact = compiled.artifact;
      }

      if (artifact?.isValid !== true && shouldEnforceHarnessValidation(validationMode)) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Harness validation failed in enforce mode",
          validationReport: artifact?.validationReport || null,
          artifactPath: artifact?.artifactPath || null,
        });
        return true;
      }

      const activeState = activateHarnessArtifact(artifact.artifactPath, {
        configDir: resolveUiConfigDir(),
        actor: "api",
      });
      jsonResponse(res, 200, {
        ok: true,
        harnessConfig,
        artifactPath: artifact.artifactPath,
        artifactId: artifact.artifactId,
        activeState,
        compiledProfile: artifact.compiledProfile,
        validationReport: artifact.validationReport,
        compiledProfileJson: compiled?.compiledProfileJson || artifact.compiledProfileJson || null,
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/run" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const payload = await executeHarnessRunRequest(body, {
        harnessConfig: getHarnessRuntimeConfig(),
      });
      jsonResponse(res, 200, payload);
    } catch (err) {
      const statusCode = Number(err?.statusCode) || 400;
      jsonResponse(res, statusCode, {
        ok: false,
        error: err.message,
        ...(err?.payload && typeof err.payload === "object" ? err.payload : {}),
      });
    }
    return true;
  }

  return false;
}
