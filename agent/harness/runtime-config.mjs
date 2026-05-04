function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPositiveInteger(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => toTrimmedString(entry)).filter(Boolean)
    : [];
}

export const HARNESS_RUNTIME_CONFIG_SCHEMA_VERSION = 1;

export function buildHarnessCompileOptions(options = {}) {
  return {
    defaultAgentId: options.defaultAgentId,
    defaultTaskKey: options.defaultTaskKey,
    defaultSessionType: options.defaultSessionType || options.sessionType || "task",
    defaultSdk: options.sdk || options.defaultSdk,
    defaultModel: options.model || options.defaultModel,
    defaultCwd: options.cwd || options.defaultCwd || process.cwd(),
  };
}

export function createHarnessRuntimeConfig(profile = {}, options = {}) {
  const resolvedTaskKey = toTrimmedString(options.taskKey || profile.taskKey || profile.agentId || profile.name || "harness");
  const resolvedRunId = toTrimmedString(options.runId || options.sessionId || resolvedTaskKey || profile.agentId || "harness-run");
  const resolvedSessionId = toTrimmedString(options.sessionId || resolvedRunId || resolvedTaskKey || profile.agentId || "harness-session");
  const defaultTimeoutMs = toPositiveInteger(
    options.defaultTimeoutMs || options.timeoutMs || profile.timeoutMs,
    null,
  );
  const providerSelectionId = toTrimmedString(
    options.providerSelection
    || options.selectionId
    || options.provider
    || profile.provider
    || "",
  ) || null;
  const adapterName = toTrimmedString(options.adapterName || "") || null;
  const allowedTools = Array.from(new Set([
    ...toStringArray(profile.allowedTools),
    ...toStringArray(options.allowedTools),
  ]));

  return {
    schemaVersion: HARNESS_RUNTIME_CONFIG_SCHEMA_VERSION,
    kind: "bosun-harness-runtime-config",
    profileDefaults: {
      agentId: toTrimmedString(profile.agentId || "") || null,
      profileName: toTrimmedString(profile.name || profile.agentId || "") || null,
      entryStageId: toTrimmedString(profile.entryStageId || "") || null,
      cwd: toTrimmedString(profile.cwd || options.cwd || process.cwd()) || process.cwd(),
      sessionType: toTrimmedString(profile.sessionType || options.sessionType || "harness") || "harness",
      sdk: toTrimmedString(profile.sdk || options.sdk || "") || null,
      model: toTrimmedString(profile.model || options.model || "") || null,
      taskKey: toTrimmedString(profile.taskKey || options.taskKey || profile.agentId || "") || null,
      provider: toTrimmedString(profile.provider || "") || null,
    },
    providerSelection: {
      providerSelectionId,
      providerId: toTrimmedString(options.providerId || providerSelectionId || "") || null,
      adapterName,
      model: toTrimmedString(options.providerModel || options.model || profile.model || "") || null,
      metadata: toPlainObject(options.providerMetadata),
    },
    toolPolicy: {
      allowedTools,
      capabilityContract:
        typeof options.toolCapabilityContract === "string"
          ? options.toolCapabilityContract
          : null,
      approvalMode: toTrimmedString(options.approvalMode || "") || null,
      networkPolicy: toTrimmedString(options.networkPolicy || "") || null,
      metadata: toPlainObject(options.toolPolicyMetadata),
    },
    surface: {
      surface: toTrimmedString(options.surface || options.sourceOrigin || "") || null,
      channel: toTrimmedString(options.channel || "") || null,
      requestedBy: toTrimmedString(options.requestedBy || "") || null,
      runId: resolvedRunId || null,
      sessionId: resolvedSessionId || null,
      taskId: toTrimmedString(options.taskId || profile.taskId || "") || null,
      taskTitle: toTrimmedString(options.taskTitle || profile.taskTitle || profile.name || "") || null,
      taskKey: resolvedTaskKey || null,
      repoRoot: toTrimmedString(options.repoRoot || options.approvalRepoRoot || "") || null,
      cwd: toTrimmedString(options.cwd || profile.cwd || process.cwd()) || process.cwd(),
      metadata: toPlainObject(options.surfaceMetadata),
    },
    execution: {
      dryRun: options.dryRun === true,
      timeoutMs: defaultTimeoutMs,
      validationMode: toTrimmedString(options.validationMode || "") || null,
      mcpServers: toStringArray(options.mcpServers),
      slotOwnerKey: toTrimmedString(options.slotOwnerKey || "") || null,
      slotMaxParallel: toPositiveInteger(options.slotMaxParallel, null),
      forceContextShredding: options.forceContextShredding === true,
      skipContextShredding: options.skipContextShredding === true,
      metadata: toPlainObject(options.executionMetadata),
    },
  };
}

export function resolveHarnessStageRuntime(stage = {}, runtimeConfig = {}) {
  const profileDefaults = runtimeConfig.profileDefaults || {};
  const providerSelection = runtimeConfig.providerSelection || {};
  return {
    stageId: toTrimmedString(stage.id || "") || null,
    taskKey: toTrimmedString(stage.taskKey || runtimeConfig.surface?.taskKey || profileDefaults.taskKey || "") || null,
    provider: toTrimmedString(stage.provider || providerSelection.providerId || profileDefaults.provider || "") || null,
    sessionType: toTrimmedString(stage.sessionType || profileDefaults.sessionType || "harness") || "harness",
    cwd: toTrimmedString(stage.cwd || profileDefaults.cwd || runtimeConfig.surface?.cwd || process.cwd()) || process.cwd(),
    sdk: toTrimmedString(stage.sdk || profileDefaults.sdk || "") || null,
    model: toTrimmedString(stage.model || providerSelection.model || profileDefaults.model || "") || null,
    timeoutMs: toPositiveInteger(stage.timeoutMs || runtimeConfig.execution?.timeoutMs, null),
    toolPolicy: runtimeConfig.toolPolicy || {},
    surface: runtimeConfig.surface || {},
  };
}

export default createHarnessRuntimeConfig;
