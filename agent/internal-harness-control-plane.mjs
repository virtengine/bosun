import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import { createQueryEngine } from "./query-engine.mjs";
import {
  getHarnessRunFromStateLedger,
  listHarnessRunsFromStateLedger,
  writeHarnessRunToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import { recordHarnessTelemetryEvent } from "../infra/session-telemetry.mjs";

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeValidationMode(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  return ["off", "report", "enforce"].includes(normalized) ? normalized : "report";
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

const HARNESS_NO_OUTPUT_PLACEHOLDERS = new Set([
  "",
  "(agent completed with no text output)",
  "(resumed - no text output)",
  "(resumed — no text output)",
  "continued",
  "model response continued",
]);

function hasMeaningfulHarnessRuntimeResult(result = {}) {
  const output = String(result?.output ?? result?.finalResponse ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!HARNESS_NO_OUTPUT_PLACEHOLDERS.has(output)) return true;
  if (Array.isArray(result?.items) && result.items.length > 0) return true;
  return false;
}

function normalizeHarnessProviderSessionResult(result = {}) {
  if (!result || typeof result !== "object") return result;
  if (result.success !== true) return result;
  if (hasMeaningfulHarnessRuntimeResult(result)) return result;
  const noOutputMessage =
    toTrimmedString(result.output || result.finalResponse || "")
    || "(Agent completed with no text output)";
  return {
    ...result,
    success: false,
    status: toTrimmedString(result.status || "") || "no_output",
    blockedReason: toTrimmedString(result.blockedReason || "") || "no_output",
    error: toTrimmedString(result.error || "") || noOutputMessage,
  };
}

export function resolveHarnessControlPlanePaths(configDir) {
  const root = resolve(String(configDir || process.cwd()), ".cache", "harness");
  return {
    root,
    compiledDir: resolve(root, "compiled"),
    runsDir: resolve(root, "runs"),
    activeStatePath: resolve(root, "active-harness.json"),
  };
}

function resolveHarnessLedgerOptions(configDir) {
  return {
    anchorPath: resolveHarnessControlPlanePaths(configDir).runsDir,
  };
}

export function resolveHarnessSourcePath(sourcePath, options = {}) {
  const raw = toTrimmedString(sourcePath);
  if (!raw) return "";
  const candidates = [];
  if (/^[a-zA-Z]:[\\/]|^\//.test(raw)) {
    candidates.push(resolve(raw));
  } else {
    if (options.repoRoot) candidates.push(resolve(options.repoRoot, raw));
    if (options.configDir) candidates.push(resolve(options.configDir, raw));
    candidates.push(resolve(raw));
  }
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "";
}

export function readHarnessSourceFromPath(sourcePath, options = {}) {
  const resolvedPath = resolveHarnessSourcePath(sourcePath, options);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new Error(`Harness source file not found: ${sourcePath}`);
  }
  return {
    sourcePath: resolvedPath,
    source: readFileSync(resolvedPath, "utf8"),
  };
}

function writeJson(filePath, data) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readHarnessArtifact(artifactPath) {
  const resolvedPath = resolve(String(artifactPath || ""));
  if (!existsSync(resolvedPath)) {
    throw new Error(`Harness artifact not found: ${artifactPath}`);
  }
  return JSON.parse(readFileSync(resolvedPath, "utf8"));
}

export function readActiveHarnessState(configDir) {
  const { activeStatePath } = resolveHarnessControlPlanePaths(configDir);
  if (!existsSync(activeStatePath)) return null;
  return JSON.parse(readFileSync(activeStatePath, "utf8"));
}

export function readHarnessRunRecord(runPath) {
  const resolvedPath = resolve(String(runPath || ""));
  const runId = basename(resolvedPath, ".json");
  const configDir = resolve(dirname(resolvedPath), "..", "..", "..");
  try {
    const sqlRecord = getHarnessRunFromStateLedger(runId, resolveHarnessLedgerOptions(configDir));
    if (sqlRecord) return sqlRecord;
  } catch {
    // fall back to legacy JSON record below
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Harness run record not found: ${runPath}`);
  }
  return JSON.parse(readFileSync(resolvedPath, "utf8"));
}

export function readHarnessRunRecordById(configDir, runId) {
  const normalizedRunId = toTrimmedString(runId);
  if (!normalizedRunId) {
    throw new Error("Harness runId is required");
  }
  const sqlRecord = getHarnessRunFromStateLedger(normalizedRunId, resolveHarnessLedgerOptions(configDir));
  if (sqlRecord) return sqlRecord;
  const { runsDir } = resolveHarnessControlPlanePaths(configDir);
  return readHarnessRunRecord(resolve(runsDir, `${normalizedRunId}.json`));
}

function buildHarnessRunSummary(runRecord) {
  return {
    runId: runRecord.runId,
    taskId: runRecord.taskId || null,
    taskKey: runRecord.taskKey || null,
    mode: runRecord.mode,
    dryRun: runRecord.dryRun === true,
    success: runRecord.result?.success === true,
    status: runRecord.result?.status || null,
    startedAt: runRecord.startedAt,
    finishedAt: runRecord.finishedAt,
    artifactId: runRecord.artifactId || null,
    agentId: runRecord.compiledProfile?.agentId || null,
    eventCount: Array.isArray(runRecord.events) ? runRecord.events.length : 0,
    observability: runRecord.observability || null,
  };
}

function summarizeHarnessObservability(events = []) {
  const summary = {
    categories: {},
    eventTypes: {},
    approvals: 0,
    tools: 0,
    subagents: 0,
    fileMutations: 0,
    patchApplications: 0,
  };
  for (const event of Array.isArray(events) ? events : []) {
    const category = toTrimmedString(event?.category || "") || "runtime";
    const type = toTrimmedString(event?.type || event?.eventType || "") || "event";
    summary.categories[category] = Number(summary.categories[category] || 0) + 1;
    summary.eventTypes[type] = Number(summary.eventTypes[type] || 0) + 1;
    if (toTrimmedString(event?.approvalId || "")) summary.approvals += 1;
    if (toTrimmedString(event?.toolId || event?.toolName || "")) summary.tools += 1;
    if (/subagent/i.test(category) || /subagent/i.test(type)) summary.subagents += 1;
    if (
      /artifact|patch|file\.|mutation/i.test(category)
      || /artifact|patch|file\.|mutation/i.test(type)
      || toTrimmedString(event?.filePath || event?.artifactPath || event?.patchHash || "")
    ) {
      summary.fileMutations += 1;
    }
    if (/patch/i.test(type) || toTrimmedString(event?.patchHash || "")) {
      summary.patchApplications += 1;
    }
  }
  return summary;
}

function recordHarnessRunObservabilityEvents(runRecord, configDir) {
  const events = Array.isArray(runRecord?.events) ? runRecord.events : [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const eventType = toTrimmedString(rawEvent.eventType || rawEvent.type) || "event";
    recordHarnessTelemetryEvent({
      ...rawEvent,
      id: toTrimmedString(rawEvent.id || "") || undefined,
      timestamp: toTrimmedString(rawEvent.timestamp || "") || runRecord.recordedAt,
      eventType,
      type: eventType,
      source: toTrimmedString(rawEvent.source || "internal-harness-control-plane") || "internal-harness-control-plane",
      taskId: toTrimmedString(rawEvent.taskId || runRecord.taskId || "") || null,
      sessionId: toTrimmedString(rawEvent.sessionId || runRecord.runId || runRecord.taskId || "") || null,
      runId: toTrimmedString(rawEvent.runId || runRecord.runId || "") || null,
      actor: toTrimmedString(rawEvent.actor || runRecord.actor || "") || null,
      summary: toTrimmedString(rawEvent.summary || rawEvent.reason || rawEvent.message || "") || null,
      payload: rawEvent,
      meta: {
        sourceOrigin: runRecord.sourceOrigin || null,
        artifactId: runRecord.artifactId || null,
        controlPlaneRunId: runRecord.runId,
      },
    }, { configDir });
  }
}

export function compileHarnessSourceToArtifact(source, options = {}) {
  const validationMode = normalizeValidationMode(options.validationMode);
  const compileResult = compileInternalHarnessProfile(source, options);
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  ensureDir(paths.compiledDir);
  const artifactId = `${compileResult.agentId}-${compileResult.sourceHash.slice(0, 12)}`;
  const artifactPath = resolve(paths.compiledDir, `${artifactId}.json`);
  const artifact = {
    schemaVersion: 1,
    kind: "bosun-harness-artifact",
    artifactId,
    artifactPath,
    compiledAt: compileResult.compiledProfile.metadata.compiledAt,
    sourceOrigin: toTrimmedString(options.sourceOrigin || "inline") || "inline",
    sourcePath: toTrimmedString(options.sourcePath || "") || null,
    validationMode,
    isValid: compileResult.isValid,
    validationReport: compileResult.validationReport,
    compiledProfile: compileResult.compiledProfile,
    compiledProfileJson: compileResult.compiledProfileJson,
  };
  writeJson(artifactPath, artifact);
  recordHarnessTelemetryEvent({
    timestamp: artifact.compiledAt,
    eventType: "harness.artifact.compiled",
    type: "harness.artifact.compiled",
    source: "internal-harness-control-plane",
    category: "artifact",
    actor: toTrimmedString(options.actor || "api") || "api",
    artifactId,
    artifactPath,
    status: artifact.isValid === true ? "compiled" : "invalid",
    summary: artifact.compiledProfile?.name || artifact.compiledProfile?.agentId || "harness artifact",
    payload: {
      sourceOrigin: artifact.sourceOrigin,
      sourcePath: artifact.sourcePath,
      validationMode: artifact.validationMode,
      isValid: artifact.isValid,
      agentId: artifact.compiledProfile?.agentId || null,
      entryStageId: artifact.compiledProfile?.entryStageId || null,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: artifact.sourceOrigin,
    },
  }, { configDir: options.configDir });
  return {
    ...compileResult,
    artifact,
    artifactId,
    artifactPath,
  };
}

export function activateHarnessArtifact(artifactPath, options = {}) {
  const artifact = readHarnessArtifact(artifactPath);
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  const activeState = {
    schemaVersion: 1,
    kind: "bosun-active-harness",
    activatedAt: new Date().toISOString(),
    actor: toTrimmedString(options.actor || "api") || "api",
    artifactId: artifact.artifactId,
    artifactPath: resolve(String(artifact.artifactPath || artifactPath)),
    sourceOrigin: artifact.sourceOrigin || "inline",
    sourcePath: artifact.sourcePath || null,
    validationMode: artifact.validationMode || "report",
    isValid: artifact.isValid === true,
    lastRun: null,
    compiledProfile: {
      agentId: artifact.compiledProfile?.agentId || null,
      name: artifact.compiledProfile?.name || null,
      entryStageId: artifact.compiledProfile?.entryStageId || null,
      metadata: artifact.compiledProfile?.metadata || {},
    },
  };
  writeJson(paths.activeStatePath, activeState);
  recordHarnessTelemetryEvent({
    timestamp: activeState.activatedAt,
    eventType: "harness.artifact.activated",
    type: "harness.artifact.activated",
    source: "internal-harness-control-plane",
    category: "artifact",
    actor: activeState.actor,
    artifactId: activeState.artifactId,
    artifactPath: activeState.artifactPath,
    status: activeState.isValid === true ? "active" : "invalid",
    summary: activeState.compiledProfile?.name || activeState.compiledProfile?.agentId || "active harness",
    payload: {
      sourceOrigin: activeState.sourceOrigin,
      sourcePath: activeState.sourcePath,
      validationMode: activeState.validationMode,
      isValid: activeState.isValid,
      entryStageId: activeState.compiledProfile?.entryStageId || null,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: activeState.sourceOrigin,
    },
  }, { configDir: options.configDir });
  return activeState;
}

export function compileAndActivateHarnessSource(source, options = {}) {
  const compiled = compileHarnessSourceToArtifact(source, options);
  const activeState = activateHarnessArtifact(compiled.artifactPath, options);
  return { ...compiled, activeState };
}

export function recordHarnessRun(runInput, options = {}) {
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  ensureDir(paths.runsDir);
  const runId = toTrimmedString(options.runId || runInput?.runId || randomUUID());
  const startedAt = toTrimmedString(runInput?.startedAt || "") || new Date().toISOString();
  const finishedAt = toTrimmedString(runInput?.finishedAt || "") || new Date().toISOString();
  const runRecord = {
    schemaVersion: 1,
    kind: "bosun-harness-run-record",
    runId,
    taskId: toTrimmedString(runInput?.taskId || "") || null,
    taskKey: toTrimmedString(runInput?.taskKey || "") || null,
    actor: toTrimmedString(options.actor || runInput?.actor || "api") || "api",
    recordedAt: new Date().toISOString(),
    startedAt,
    finishedAt,
    mode: toTrimmedString(runInput?.mode || (runInput?.result?.dryRun ? "dry-run" : "run")) || "run",
    dryRun: runInput?.dryRun === true || runInput?.result?.dryRun === true,
    sourceOrigin: toTrimmedString(runInput?.sourceOrigin || "") || null,
    sourcePath: toTrimmedString(runInput?.sourcePath || "") || null,
    artifactId: toTrimmedString(runInput?.artifactId || "") || null,
    artifactPath: toTrimmedString(runInput?.artifactPath || "") || null,
    compiledProfile: runInput?.compiledProfile && typeof runInput.compiledProfile === "object"
      ? {
          agentId: runInput.compiledProfile.agentId || null,
          name: runInput.compiledProfile.name || null,
          entryStageId: runInput.compiledProfile.entryStageId || null,
          metadata: runInput.compiledProfile.metadata || {},
        }
      : null,
    result: runInput?.result && typeof runInput.result === "object"
      ? JSON.parse(JSON.stringify(runInput.result))
      : null,
    events: Array.isArray(runInput?.events)
      ? JSON.parse(JSON.stringify(runInput.events))
      : [],
    observability: summarizeHarnessObservability(runInput?.events),
  };
  const runPath = resolve(paths.runsDir, `${runId}.json`);
  writeJson(runPath, runRecord);
  try {
    writeHarnessRunToStateLedger(runRecord, resolveHarnessLedgerOptions(options.configDir));
  } catch {
    // best effort during SQL migration; JSON record remains the fallback source
  }
  recordHarnessRunObservabilityEvents(runRecord, options.configDir);
  recordHarnessTelemetryEvent({
    timestamp: runRecord.recordedAt,
    eventType: "harness.run.recorded",
    type: "harness.run.recorded",
    source: "internal-harness-control-plane",
    category: "control-plane",
    taskId: runRecord.taskId,
    sessionId: runRecord.runId,
    runId: runRecord.runId,
    actor: runRecord.actor,
    status: runRecord.result?.status || null,
    summary: runRecord.compiledProfile?.name || runRecord.compiledProfile?.agentId || "harness run",
    payload: {
      artifactId: runRecord.artifactId,
      dryRun: runRecord.dryRun,
      eventCount: Array.isArray(runRecord.events) ? runRecord.events.length : 0,
      observability: runRecord.observability,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: runRecord.sourceOrigin,
    },
  }, { configDir: options.configDir });

  const activeState = readActiveHarnessState(options.configDir);
  if (
    activeState &&
    runRecord.artifactPath &&
    resolve(String(activeState.artifactPath || "")) === resolve(runRecord.artifactPath)
  ) {
    const nextActiveState = {
      ...activeState,
      lastRun: buildHarnessRunSummary(runRecord),
    };
    writeJson(paths.activeStatePath, nextActiveState);
  }

  return {
    ...runRecord,
    runPath,
  };
}

export function listHarnessRuns(configDir, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.trunc(Number(options.limit))
    : 25;
  try {
    const sqlRecords = listHarnessRunsFromStateLedger({
      ...resolveHarnessLedgerOptions(configDir),
      limit,
    });
    if (Array.isArray(sqlRecords) && sqlRecords.length > 0) {
      return sqlRecords.map((record) => ({
        ...buildHarnessRunSummary(record),
        runRecord: record,
      }));
    }
  } catch {
    // fall back to legacy JSON records below
  }
  const { runsDir } = resolveHarnessControlPlanePaths(configDir);
  if (!existsSync(runsDir)) return [];
  const records = [];
  for (const fileName of readdirSync(runsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const runPath = resolve(runsDir, fileName);
    try {
      const record = readHarnessRunRecord(runPath);
      records.push({
        ...buildHarnessRunSummary(record),
        runPath,
      });
    } catch {
      // Ignore malformed run records so one bad file does not break the control plane.
    }
  }
  records.sort((left, right) => {
    const rightTime = Date.parse(right.finishedAt || right.startedAt || 0);
    const leftTime = Date.parse(left.finishedAt || left.startedAt || 0);
    return rightTime - leftTime;
  });
  return records.slice(0, limit);
}

export function summarizeHarnessRuns(configDir, options = {}) {
  const recentRuns = listHarnessRuns(configDir, {
    limit: Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.trunc(Number(options.limit))
      : 10,
  });
  const activeState = readActiveHarnessState(configDir);
  const totals = {
    total: recentRuns.length,
    successful: recentRuns.filter((run) => run.success === true).length,
    failed: recentRuns.filter((run) => run.success === false).length,
    dryRuns: recentRuns.filter((run) => run.dryRun === true).length,
  };
  return {
    enabled: activeState?.isValid === true || Boolean(activeState?.artifactPath),
    activeArtifactId: activeState?.artifactId || null,
    activeArtifactPath: activeState?.artifactPath || null,
    activeProfile: activeState?.compiledProfile || null,
    validationMode: activeState?.validationMode || null,
    totals,
    lastRun: activeState?.lastRun || recentRuns[0] || null,
    recentRuns,
  };
}

export function shouldEnforceHarnessValidation(validationMode) {
  return normalizeValidationMode(validationMode) === "enforce";
}

export function createHarnessFailoverController(options = {}) {
  const queryEngine = options.queryEngine || createQueryEngine(options.queryEngineOptions || options);
  return {
    policy: queryEngine.policy,
    clearAdapterFailureState(adapterName) {
      return queryEngine.clearAdapterFailureState(adapterName);
    },
    noteAdapterFailure(adapterName, err) {
      return queryEngine.noteAdapterFailure(adapterName, err);
    },
    async executeTurn(request = {}) {
      return await queryEngine.executeTurn(request);
    },
  };
}

export function createHarnessProviderSessionRuntime(options = {}) {
  const launchers = options.launchers && typeof options.launchers === "object"
    ? { ...options.launchers }
    : {};
  const resumers = options.resumers && typeof options.resumers === "object"
    ? { ...options.resumers }
    : {};
  const recoverers = options.recoverers && typeof options.recoverers === "object"
    ? { ...options.recoverers }
    : {};

  async function defaultRecoverer({ adapter }) {
    if (!adapter) return;
    if (typeof adapter.reset === "function") {
      await adapter.reset();
    }
    if (typeof adapter.init === "function") {
      await adapter.init();
    }
  }

  return {
    async launchSession(input = {}) {
      const sdkName = toTrimmedString(input.sdkName || input.sdk);
      const launcher = launchers[sdkName];
      if (typeof launcher !== "function") {
        throw new Error(`No launch handler is registered for SDK "${sdkName || "unknown"}"`);
      }
      return normalizeHarnessProviderSessionResult(await launcher(
        input.prompt,
        input.cwd,
        input.timeoutMs,
        input.extra || {},
      ));
    },
    async resumeSession(input = {}) {
      const strategy = toTrimmedString(input.strategy);
      const resumeHandler =
        resumers[strategy]
        || resumers[toTrimmedString(input.sdkName || input.sdk)]
        || null;
      if (typeof resumeHandler !== "function") {
        throw new Error(`No resume handler is registered for strategy "${strategy || "unknown"}"`);
      }
      return normalizeHarnessProviderSessionResult(await resumeHandler(
        input.threadId,
        input.prompt,
        input.cwd,
        input.timeoutMs,
        input.extra || {},
        input.sdkName || input.sdk,
      ));
    },
    async recoverSession(input = {}) {
      const adapterName = toTrimmedString(input.adapterName);
      const recoverHandler = recoverers[adapterName] || options.defaultRecoverer || defaultRecoverer;
      return await recoverHandler(input);
    },
  };
}

export function planPersistentThreadExecution(input = {}) {
  const taskKey = toTrimmedString(input.taskKey);
  const requestedSdk = toTrimmedString(input.requestedSdk || input.sdk);
  const existingRecord = input.existingRecord && typeof input.existingRecord === "object"
    ? { ...input.existingRecord }
    : null;
  const maxThreadTurns = toPositiveInteger(input.maxThreadTurns, 0) || 0;
  const warningThreshold = toPositiveInteger(input.warningThreshold, 0) || 0;
  const absoluteAgeMs = toPositiveInteger(input.absoluteAgeMs, 0) || 0;
  const refreshTurnsRemaining = toPositiveInteger(input.monitorRefreshTurnsRemaining, 0) || 0;
  const monitorTaskKey = toTrimmedString(input.monitorTaskKey);
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const result = {
    action: "launch_fresh",
    strategy: "launch_fresh",
    reason: existingRecord?.threadId ? "fresh_launch_required" : "no_persistent_thread",
    requestedSdk: requestedSdk || null,
    threadId: toTrimmedString(existingRecord?.threadId || "") || null,
    warnings: [],
    invalidateRecord: false,
    deleteRecord: false,
    markRecordDead: false,
    staleResumeState: false,
    turnsRemaining: maxThreadTurns > 0 ? maxThreadTurns - Number(existingRecord?.turnCount || 0) : null,
  };

  if (!taskKey || !existingRecord || existingRecord.alive !== true || !result.threadId) {
    return result;
  }

  const turnCount = Number(existingRecord.turnCount || 0);
  const turnsRemaining = result.turnsRemaining;

  if (
    monitorTaskKey
    && taskKey === monitorTaskKey
    && Number.isFinite(turnsRemaining)
    && turnsRemaining <= refreshTurnsRemaining
  ) {
    return {
      ...result,
      reason: "monitor_refresh_threshold",
      invalidateRecord: true,
      markRecordDead: true,
      warnings: [
        `proactively refreshing monitor-monitor thread with ${turnsRemaining} turns remaining`,
      ],
    };
  }

  if (warningThreshold > 0 && maxThreadTurns > 0 && turnCount >= warningThreshold && turnCount < maxThreadTurns) {
    result.warnings.push(
      `thread for task "${taskKey}" approaching exhaustion: ${turnCount}/${maxThreadTurns} turns (${turnsRemaining} remaining)`,
    );
  }

  if (maxThreadTurns > 0 && turnCount >= maxThreadTurns) {
    return {
      ...result,
      reason: "turn_limit_exceeded",
      invalidateRecord: true,
      markRecordDead: true,
    };
  }

  if (absoluteAgeMs > 0 && nowMs - Number(existingRecord.createdAt || 0) > absoluteAgeMs) {
    return {
      ...result,
      reason: "absolute_age_exceeded",
      invalidateRecord: true,
      markRecordDead: true,
    };
  }

  if (requestedSdk && toTrimmedString(existingRecord.sdk) && requestedSdk !== toTrimmedString(existingRecord.sdk)) {
    return {
      ...result,
      reason: "sdk_changed",
      invalidateRecord: true,
      markRecordDead: true,
    };
  }

  let strategy = "resume_generic";
  if (requestedSdk === "codex" && toTrimmedString(existingRecord.sdk) === "codex") strategy = "resume_codex";
  else if (requestedSdk === "copilot" && toTrimmedString(existingRecord.sdk) === "copilot") strategy = "resume_copilot";
  else if (requestedSdk === "claude" && toTrimmedString(existingRecord.sdk) === "claude") strategy = "resume_claude";
  else if (requestedSdk === "opencode" && toTrimmedString(existingRecord.sdk) === "opencode") strategy = "resume_opencode";
  else if (requestedSdk === "openai-native" && toTrimmedString(existingRecord.sdk) === "openai-native") strategy = "resume_openai-native";

  return {
    ...result,
    action: "resume_existing",
    strategy,
    reason: "resume_existing",
  };
}
