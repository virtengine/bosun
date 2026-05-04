import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename, dirname, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  getWorkflowRunFromStateLedger,
  listWorkflowRunFamilyFromStateLedger,
  listWorkflowRunsFromStateLedger,
  writeWorkflowStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import { recordHarnessTelemetryEvent } from "../infra/session-telemetry.mjs";

const TAG = "[execution-ledger]";
const STATE_LEDGER_TAG = "[state-ledger]";
const LEDGER_DIR_NAME = "execution-ledger";
const STATE_LEDGER_FILENAME = "state-ledger.sqlite";
const STATE_LEDGER_SCHEMA_VERSION = 1;
const STATE_LEDGER_BUSY_TIMEOUT_MS = 5_000;
const LEDGER_READ_CACHE_TTL_MS = 5_000;
const _stateLedgerCache = new Map();

function isLikelyTestRuntime() {
  if (process.env.BOSUN_TEST_SANDBOX === "1") return true;
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  if (process.env.VITEST_WORKER_ID) return true;
  if (process.env.JEST_WORKER_ID) return true;
  if (process.env.NODE_ENV === "test") return true;
  const argv = Array.isArray(process.argv) ? process.argv.join(" ").toLowerCase() : "";
  return argv.includes("vitest") || argv.includes("--test");
}

function isPathInside(parentPath, childPath) {
  const parent = resolve(String(parentPath || ""));
  const child = resolve(String(childPath || ""));
  if (!parent || !child) return false;
  if (process.platform === "win32") {
    const normalizedParent = parent.toLowerCase();
    const normalizedChild = child.toLowerCase();
    return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`) || normalizedChild.startsWith(`${normalizedParent}/`);
  }
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizeLedgerDocument(runId, doc = {}) {
  const governanceState = extractGovernanceState(doc);
  const events = Array.isArray(doc.events) ? doc.events : [];
  const latestEvent = events.at(-1) || null;
  const terminalEvent = [...events].reverse().find((event) => (
    String(event?.eventType || "").trim() === "run.end"
    || String(event?.eventType || "").trim() === "run.error"
    || String(event?.eventType || "").trim() === "run.cancelled"
  )) || null;
  const resolvedStatus = terminalEvent?.status || latestEvent?.status || doc.status || null;
  const resolvedUpdatedAt = latestEvent?.timestamp || doc.updatedAt || doc.startedAt || null;
  const resolvedEndedAt = terminalEvent?.timestamp || doc.endedAt || null;
  return {
    version: 3,
    runId,
    workflowId: doc.workflowId || null,
    workflowName: doc.workflowName || null,
    rootRunId: doc.rootRunId || runId,
    parentRunId: doc.parentRunId || null,
    retryOf: doc.retryOf || null,
    retryMode: doc.retryMode || null,
    runKind: doc.runKind || null,
    sessionId: doc.sessionId || null,
    threadId: doc.threadId || null,
    traceId: doc.traceId || null,
    spanId: doc.spanId || null,
    parentSpanId: doc.parentSpanId || null,
    providerId: doc.providerId || null,
    providerTurnId: doc.providerTurnId || null,
    modelId: doc.modelId || null,
    approvalId: doc.approvalId || null,
    actor: doc.actor || null,
    startedAt: doc.startedAt || null,
    endedAt: resolvedEndedAt,
    status: resolvedStatus,
    updatedAt: resolvedUpdatedAt,
    goalAncestry: governanceState.goalAncestry || [],
    primaryGoalId: governanceState.primaryGoalId || null,
    primaryGoalTitle: governanceState.primaryGoalTitle || null,
    goalDepth: governanceState.goalDepth ?? null,
    heartbeatRun: governanceState.heartbeatRun || null,
    wakeupRequest: governanceState.wakeupRequest || null,
    budgetPolicy: governanceState.budgetPolicy || null,
    executionPolicy: governanceState.executionPolicy || null,
    budgetOutcome: governanceState.budgetOutcome || null,
    policyOutcome: governanceState.policyOutcome || null,
    successCriteria: governanceState.successCriteria || [],
    goalProgress: governanceState.goalProgress || null,
    constraintState: governanceState.constraintState || null,
    tokenBudget: governanceState.tokenBudget || null,
    objectiveFrame: governanceState.objectiveFrame || null,
    latestCheckpoint: doc.latestCheckpoint && typeof doc.latestCheckpoint === "object"
      ? JSON.parse(JSON.stringify(doc.latestCheckpoint))
      : null,
    events,
  };
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function inferRepoRoot(startDir) {
  let current = resolve(String(startDir || process.cwd()));
  while (true) {
    if (existsSync(resolve(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveBosunHomeDir() {
  const explicit = String(
    process.env.BOSUN_HOME || process.env.BOSUN_DIR || "",
  ).trim();
  if (explicit) return resolve(explicit);

  const base = String(
    process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || "",
  ).trim();
  if (!base) return null;
  if (/[/\\]bosun$/i.test(base)) return resolve(base);
  return resolve(base, "bosun");
}

function findBosunDir(startPath) {
  if (!startPath) return null;
  let current = resolve(String(startPath));
  while (true) {
    if (basename(current).toLowerCase() === ".bosun") {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeTimestamp(value) {
  return asText(value) || new Date().toISOString();
}

function toJsonText(value) {
  return JSON.stringify(value ?? null);
}

function parseJsonText(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeGoalAncestry(raw, fallbackGoal = null) {
  const source = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.goalAncestry)
      ? raw.goalAncestry
      : Array.isArray(raw?.ancestry)
        ? raw.ancestry
        : [];
  const normalized = source
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => {
      const goalId = asText(entry.goalId || entry.id || entry.goal?.id || entry.goal?.goalId);
      const title = asText(entry.title || entry.goalTitle || entry.name || entry.goal?.title || entry.goal?.name);
      if (!goalId && !title) return null;
      return cleanObject({
        goalId: goalId || null,
        title: title || null,
        parentGoalId: asText(entry.parentGoalId || entry.parentId) || null,
        kind: asText(entry.kind || entry.type) || null,
        status: asText(entry.status) || null,
        source: asText(entry.source) || null,
        depth: asInteger(entry.depth ?? index),
      });
    })
    .filter(Boolean);
  if (normalized.length > 0) return normalized;

  if (!fallbackGoal || typeof fallbackGoal !== "object") return [];
  const goalId = asText(fallbackGoal.goalId || fallbackGoal.id);
  const title = asText(fallbackGoal.title || fallbackGoal.name);
  if (!goalId && !title) return [];
  return [cleanObject({
    goalId: goalId || null,
    title: title || null,
    kind: asText(fallbackGoal.kind || fallbackGoal.type) || null,
    status: asText(fallbackGoal.status) || null,
    source: asText(fallbackGoal.source) || null,
    depth: 0,
  })];
}

function buildGoalState(raw = {}) {
  const primaryGoalSource = raw?.primaryGoal || raw?._primaryGoal || raw?.goal || raw?._goal || null;
  const goalAncestry = normalizeGoalAncestry(
    raw?.goalAncestry || raw?._goalAncestry || raw?.workflowGoalAncestry || raw?._workflowGoalAncestry,
    primaryGoalSource,
  );
  const primaryGoal = goalAncestry.at(-1) || null;
  return {
    goalAncestry,
    primaryGoalId: primaryGoal?.goalId || asText(raw?.primaryGoalId || raw?._primaryGoalId) || null,
    primaryGoalTitle: primaryGoal?.title || asText(raw?.primaryGoalTitle || raw?._primaryGoalTitle) || null,
    goalDepth: primaryGoal ? (asInteger(primaryGoal.depth) ?? Math.max(goalAncestry.length - 1, 0)) : null,
  };
}

function clampUnitRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, Number(parsed.toFixed(3))));
}

function normalizeSuccessCriteria(raw, fallbackAcceptanceCriteria = []) {
  const source = Array.isArray(raw)
    ? raw
    : (Array.isArray(fallbackAcceptanceCriteria) ? fallbackAcceptanceCriteria : []);
  return source
    .map((entry, index) => {
      if (typeof entry === "string") {
        const title = asText(entry);
        if (!title) return null;
        return {
          id: `criterion-${index + 1}`,
          title,
          description: "",
          status: "pending",
          blocking: true,
        };
      }
      if (!entry || typeof entry !== "object") return null;
      const id = asText(entry.id || entry.criterionId || entry.key || `criterion-${index + 1}`);
      const title = asText(entry.title || entry.name || entry.criterion || entry.description);
      const description = asText(entry.description || entry.detail || entry.summary) || "";
      const rawStatus = String(entry.status || "").trim().toLowerCase();
      const status = ["pending", "in_progress", "partial", "satisfied", "failed", "waived", "blocked"].includes(rawStatus)
        ? rawStatus
        : (entry.satisfied === true ? "satisfied" : "pending");
      return cleanObject({
        id: id || `criterion-${index + 1}`,
        title: title || description || id || `criterion-${index + 1}`,
        description,
        status,
        blocking: entry.blocking === true || entry.required === true || entry.optional === false,
      });
    })
    .filter(Boolean);
}

function normalizeConstraintViolation(entry = {}, index = 0) {
  const constraintId = asText(entry.constraintId || entry.ruleId || entry.id || `constraint-${index + 1}`);
  const type = asText(entry.type || entry.kind) || "constraint";
  const message = asText(entry.message || entry.reason || entry.description);
  if (!constraintId && !type && !message) return null;
  const severity = asText(entry.severity || "") || (entry.blocking === true || entry.blocked === true ? "error" : "warning");
  const status = asText(entry.status || "") || (entry.blocking === true || entry.blocked === true ? "blocked" : "open");
  return cleanObject({
    constraintId: constraintId || `constraint-${index + 1}`,
    type,
    severity,
    status,
    message: message || null,
    blocking: entry.blocking === true || entry.blocked === true,
  });
}

function normalizeConstraintState(raw = {}) {
  if (!raw) return null;
  const source = Array.isArray(raw) ? { violations: raw } : (typeof raw === "object" ? raw : null);
  if (!source) return null;
  const violations = Array.isArray(source.violations || source.items || source.constraintViolations)
    ? (source.violations || source.items || source.constraintViolations)
      .map((entry, index) => normalizeConstraintViolation(entry, index))
      .filter(Boolean)
    : [];
  const blockingViolationCount = violations.filter((entry) => entry?.blocking === true).length;
  const violationCount = violations.length;
  const blocked = source.blocked === true || blockingViolationCount > 0;
  const approvalPending = source.approvalPending === true || asText(source.approvalState) === "pending";
  const status = asText(source.status) || (blocked ? "blocked" : (violationCount > 0 ? "warning" : "ok"));
  if (violationCount === 0 && !blocked && !approvalPending && !status) return null;
  return cleanObject({
    status,
    blocked,
    approvalPending,
    violationCount,
    blockingViolationCount,
    violations,
  });
}

function normalizeTokenBudget(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const budgetTokens = asInteger(raw.budgetTokens ?? raw.limitTokens ?? raw.maxTokens);
  const inputTokens = asInteger(raw.inputTokens) ?? 0;
  const outputTokens = asInteger(raw.outputTokens) ?? 0;
  const totalTokens = asInteger(raw.totalTokens ?? (inputTokens + outputTokens));
  const reservedTokens = asInteger(raw.reservedTokens) ?? 0;
  const remainingTokens = asInteger(
    raw.remainingTokens ?? (budgetTokens != null ? budgetTokens - (totalTokens || 0) - reservedTokens : null),
  );
  const utilizationRatio = budgetTokens && budgetTokens > 0
    ? clampUnitRatio(((totalTokens || 0) + reservedTokens) / budgetTokens)
    : null;
  const exceeded = budgetTokens != null ? ((totalTokens || 0) + reservedTokens) > budgetTokens : false;
  const nearLimitThresholdTokens = asInteger(raw.nearLimitThresholdTokens ?? raw.warningTokens);
  const nearLimit = !exceeded && budgetTokens != null
    ? (
        (nearLimitThresholdTokens != null && remainingTokens != null && remainingTokens <= nearLimitThresholdTokens)
        || ((utilizationRatio ?? 0) >= 0.9)
      )
    : false;
  const status = asText(raw.status) || (exceeded ? "exceeded" : (nearLimit ? "near_limit" : "ok"));
  if (budgetTokens == null && totalTokens == null && !status) return null;
  return cleanObject({
    status,
    budgetTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    reservedTokens,
    remainingTokens,
    utilizationRatio,
    nearLimit,
    exceeded,
    approvalRequired: raw.approvalRequired === true,
  });
}

function normalizeGoalProgress(raw = {}, successCriteria = []) {
  const source = raw && typeof raw === "object" ? raw : {};
  const completedCriteriaCount = asInteger(source.completedCriteriaCount)
    ?? successCriteria.filter((entry) => ["satisfied", "waived"].includes(entry.status)).length;
  const totalCriteriaCount = asInteger(source.totalCriteriaCount)
    ?? successCriteria.length;
  const completionRatio = clampUnitRatio(
    source.completionRatio ?? (totalCriteriaCount > 0 ? completedCriteriaCount / totalCriteriaCount : null),
  );
  const status = asText(source.status)
    || (completionRatio === 1 ? "satisfied" : (completionRatio != null && completionRatio > 0 ? "partial" : "pending"));
  if (!status && totalCriteriaCount === 0 && !asText(source.summary)) return null;
  return cleanObject({
    status,
    summary: asText(source.summary) || null,
    completedCriteriaCount,
    totalCriteriaCount,
    completionRatio,
  });
}

function buildObjectiveFrame(raw = {}) {
  const successCriteria = normalizeSuccessCriteria(
    raw?.successCriteria || raw?._successCriteria || raw?.criteria,
    raw?.acceptanceCriteria || raw?._acceptanceCriteria,
  );
  const goalProgress = normalizeGoalProgress(raw?.goalProgress || raw?._goalProgress, successCriteria);
  const constraintState = normalizeConstraintState(raw?.constraintState || raw?._constraintState || raw?.constraints);
  const tokenBudget = normalizeTokenBudget(raw?.tokenBudget || raw?._tokenBudget);
  const blocked = constraintState?.blocked === true
    || constraintState?.approvalPending === true
    || tokenBudget?.status === "exceeded";
  if (successCriteria.length === 0 && !goalProgress && !constraintState && !tokenBudget) return null;
  return cleanObject({
    successCriteria,
    goalProgress,
    constraintState,
    tokenBudget,
    blocked,
  });
}

function normalizeHeartbeatRun(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const runId = asText(raw.runId || raw.heartbeatRunId || raw.id);
  const status = asText(raw.status || raw.state);
  const sourceRunId = asText(raw.sourceRunId || raw.parentRunId || raw.originRunId);
  const wakeAt = asText(raw.wakeAt || raw.resumeAt || raw.nextWakeAt);
  const lastHeartbeatAt = asText(raw.lastHeartbeatAt || raw.heartbeatAt || raw.lastSeenAt);
  const attempt = asInteger(raw.attempt ?? raw.retryCount);
  if (!runId && !status && !sourceRunId && !wakeAt && !lastHeartbeatAt && attempt == null) return null;
  return cleanObject({
    runId: runId || null,
    status: status || null,
    sourceRunId: sourceRunId || null,
    wakeAt: wakeAt || null,
    lastHeartbeatAt: lastHeartbeatAt || null,
    trigger: asText(raw.trigger || raw.reason) || null,
    attempt,
  });
}

function normalizeWakeupRequest(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = asText(raw.requestId || raw.id || raw.wakeupRequestId);
  const source = asText(raw.source || raw.reason || raw.trigger);
  const requestedAt = asText(raw.requestedAt || raw.createdAt);
  const wakeAt = asText(raw.wakeAt || raw.resumeAt || raw.scheduledFor);
  if (!requestId && !source && !requestedAt && !wakeAt) return null;
  return cleanObject({
    requestId: requestId || null,
    source: source || null,
    requestedAt: requestedAt || null,
    wakeAt: wakeAt || null,
    taskId: asText(raw.taskId) || null,
    sessionId: asText(raw.sessionId || raw.threadId) || null,
  });
}

function normalizeBudgetPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const budgetWindow = asText(raw.budgetWindow || raw.window || raw.period);
  const budgetCents = asInteger(raw.budgetCents ?? raw.limitCents ?? raw.limit);
  const spentCents = asInteger(raw.spentCents ?? raw.usedCents ?? raw.actualCents ?? raw.spent);
  const reservedCents = asInteger(raw.reservedCents ?? raw.pendingCents);
  const remainingCents = asInteger(
    raw.remainingCents ?? (budgetCents != null ? budgetCents - (spentCents || 0) - (reservedCents || 0) : null),
  );
  if (budgetWindow == null && budgetCents == null && spentCents == null && reservedCents == null && remainingCents == null) return null;
  return cleanObject({
    budgetWindow: budgetWindow || null,
    budgetCents,
    spentCents: spentCents ?? 0,
    reservedCents: reservedCents ?? 0,
    remainingCents,
    nearLimitThresholdCents: asInteger(raw.nearLimitThresholdCents ?? raw.warningCents),
    currency: asText(raw.currency || "USD") || "USD",
    approvalRequired: raw.approvalRequired === true,
    owner: asText(raw.owner || raw.team) || null,
  });
}

function buildBudgetOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const budgetCents = asInteger(policy.budgetCents);
  const spentCents = asInteger(policy.spentCents) ?? 0;
  const reservedCents = asInteger(policy.reservedCents) ?? 0;
  const effectiveSpend = spentCents + reservedCents;
  const remainingCents = asInteger(policy.remainingCents ?? (budgetCents != null ? budgetCents - effectiveSpend : null));
  const utilizationRatio = budgetCents && budgetCents > 0
    ? Math.max(0, Number((effectiveSpend / budgetCents).toFixed(3)))
    : 0;
  const nearLimitThreshold = asInteger(policy.nearLimitThresholdCents);
  const exceeded = budgetCents != null ? effectiveSpend > budgetCents : false;
  const nearLimit = !exceeded && budgetCents != null
    ? ((nearLimitThreshold != null && remainingCents != null && remainingCents <= nearLimitThreshold) || utilizationRatio >= 0.9)
    : false;
  return cleanObject({
    status: exceeded ? "exceeded" : (nearLimit ? "near_limit" : "ok"),
    budgetCents,
    spentCents,
    reservedCents,
    remainingCents,
    utilizationRatio,
    exceeded,
    nearLimit,
    approvalRequired: policy.approvalRequired === true,
  });
}

function normalizePolicyViolation(entry = {}, index = 0) {
  const ruleId = asText(entry.ruleId || entry.id || `${index}`);
  const message = asText(entry.message || entry.reason || entry.summary);
  if (!ruleId && !message) return null;
  return cleanObject({
    ruleId: ruleId || null,
    message: message || null,
    severity: asText(entry.severity || "warning") || "warning",
    blocking: entry.blocking === true || entry.blocked === true,
    nodeId: asText(entry.nodeId) || null,
  });
}

function normalizeExecutionPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const violations = Array.isArray(raw.violations)
    ? raw.violations.map((entry, index) => normalizePolicyViolation(entry, index)).filter(Boolean)
    : [];
  const blocked = raw.blocked === true || (raw.requiresApproval === true && raw.approvalState === "pending");
  if (violations.length === 0 && !blocked && !raw.approvalRequired && !raw.approvalState && !raw.mode) return null;
  return cleanObject({
    mode: asText(raw.mode || raw.policyMode) || null,
    blocked,
    approvalRequired: raw.approvalRequired === true || raw.requiresApproval === true,
    approvalState: asText(raw.approvalState || raw.state) || null,
    violations,
  });
}

function buildPolicyOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const violations = Array.isArray(policy.violations) ? policy.violations : [];
  const blockingViolationCount = violations.filter((entry) => entry?.blocking === true).length;
  const violationCount = violations.length;
  const blocked = policy.blocked === true || blockingViolationCount > 0;
  return cleanObject({
    status: blocked ? "blocked" : (violationCount > 0 ? "warning" : "ok"),
    blocked,
    approvalRequired: policy.approvalRequired === true,
    approvalState: policy.approvalState || null,
    violationCount,
    blockingViolationCount,
  });
}

function extractGovernanceState(raw = {}) {
  const goalState = buildGoalState(raw);
  const heartbeatRun = normalizeHeartbeatRun(raw?.heartbeatRun || raw?._heartbeatRun);
  const wakeupRequest = normalizeWakeupRequest(raw?.wakeupRequest || raw?._wakeupRequest);
  const budgetPolicy = normalizeBudgetPolicy(raw?.budgetPolicy || raw?._budgetPolicy);
  const executionPolicy = normalizeExecutionPolicy(raw?.executionPolicy || raw?._executionPolicy);
  const objectiveFrame = buildObjectiveFrame(raw?.objectiveFrame || raw?._objectiveFrame || raw);
  return cleanObject({
    ...goalState,
    heartbeatRun,
    wakeupRequest,
    budgetPolicy,
    executionPolicy,
    budgetOutcome: buildBudgetOutcome(budgetPolicy),
    policyOutcome: buildPolicyOutcome(executionPolicy),
    successCriteria: objectiveFrame?.successCriteria || [],
    goalProgress: objectiveFrame?.goalProgress || null,
    constraintState: objectiveFrame?.constraintState || null,
    tokenBudget: objectiveFrame?.tokenBudget || null,
    objectiveFrame,
  });
}

function resolveOwnedStateLedgerPath(runsDir) {
  const normalizedRunsDir = resolve(String(runsDir || process.cwd()));
  const repoRoot = inferRepoRoot(normalizedRunsDir);
  const bosunHomeDir = resolveBosunHomeDir();
  const isWithinBosunHome = bosunHomeDir
    ? normalizedRunsDir.toLowerCase().startsWith(resolve(bosunHomeDir).toLowerCase())
    : false;
  const bosunDir = findBosunDir(normalizedRunsDir)
    || (repoRoot ? resolve(repoRoot, ".bosun") : null)
    || (isWithinBosunHome ? resolve(bosunHomeDir) : null);
  if (bosunDir) {
    return resolve(bosunDir, ".cache", STATE_LEDGER_FILENAME);
  }
  const explicit = String(process.env.BOSUN_STATE_LEDGER_PATH || "").trim();
  if (explicit) {
    if (isLikelyTestRuntime()) {
      const sandboxRoot = String(process.env.BOSUN_TEST_SANDBOX_ROOT || "").trim();
      if (!sandboxRoot || !isPathInside(sandboxRoot, normalizedRunsDir)) {
        return null;
      }
    }
    return explicit === ":memory:" ? explicit : resolve(explicit);
  }
  return null;
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRuntimeStatus(value) {
  const normalized = asText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function isTerminalRuntimeStatus(value) {
  return new Set(["completed", "failed", "cancelled", "canceled", "aborted", "terminated", "skipped"]).has(
    normalizeRuntimeStatus(value),
  );
}

function normalizeCheckpointBoundaryType(value, fallback = "event_boundary") {
  const normalized = asText(value);
  if (!normalized) return fallback;
  return normalized.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
}

function inferExecutionCheckpointBoundary(source = {}, fallback = "event_boundary") {
  const explicit = normalizeCheckpointBoundaryType(source?.boundaryType || source?.meta?.checkpoint?.boundaryType, "");
  if (explicit) return explicit;
  const eventType = asText(source?.eventType)?.toLowerCase() || "";
  if (eventType.startsWith("node.")) return "node_boundary";
  if (eventType.includes("turn") || eventType.startsWith("provider.turn") || eventType.startsWith("run.")) {
    return "turn_boundary";
  }
  if (asText(source?.nodeId || source?.stageId)) return "node_boundary";
  return fallback;
}

function shouldPersistExecutionCheckpoint(source = {}) {
  const explicitCheckpoint = source?.checkpoint && typeof source.checkpoint === "object";
  if (explicitCheckpoint) return true;
  const eventType = asText(source?.eventType)?.toLowerCase() || "";
  if (
    eventType.startsWith("run.")
    || eventType.startsWith("node.")
    || eventType.includes("turn")
    || eventType.startsWith("provider.turn")
  ) {
    return true;
  }
  return Boolean(
    asText(source?.nodeId || source?.stageId || source?.providerTurnId)
    || asInteger(source?.messageCursor ?? source?.cursor?.message) != null
    || asInteger(source?.turnCursor ?? source?.cursor?.turn) != null
    || asInteger(source?.spillCount ?? source?.counters?.spillCount) != null,
  );
}

function buildExecutionCheckpoint(raw = {}, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const cursor = source.cursor && typeof source.cursor === "object" ? source.cursor : {};
  const counters = source.counters && typeof source.counters === "object" ? source.counters : {};
  const sourceMeta = source.meta && typeof source.meta === "object" ? source.meta : {};
  const fallbackMeta = fallback.meta && typeof fallback.meta === "object" ? fallback.meta : {};
  const checkpointMeta = cleanObject({
    nodeLabel: asText(sourceMeta.nodeLabel || fallbackMeta.nodeLabel) || null,
    stageLabel: asText(sourceMeta.stageLabel || fallbackMeta.stageLabel) || null,
    executionKey: asText(sourceMeta.executionKey || fallbackMeta.executionKey) || null,
    executionKind: asText(sourceMeta.executionKind || fallbackMeta.executionKind) || null,
    runKind: asText(sourceMeta.runKind || fallbackMeta.runKind) || null,
    sessionType: asText(sourceMeta.sessionType || fallbackMeta.sessionType) || null,
    workerGeneration: asInteger(sourceMeta.workerGeneration ?? fallbackMeta.workerGeneration),
    executionCount: asInteger(sourceMeta.executionCount ?? fallbackMeta.executionCount),
  });
  const messageCursor = asInteger(source.messageCursor ?? cursor.message ?? fallback.messageCursor);
  const turnCursor = asInteger(source.turnCursor ?? cursor.turn ?? fallback.turnCursor);
  const eventCursor = asInteger(source.eventCursor ?? cursor.event ?? fallback.eventCursor);
  const spillCount = asInteger(source.spillCount ?? counters.spillCount ?? fallback.spillCount) ?? 0;
  const toolCallCount = asInteger(source.toolCallCount ?? counters.toolCallCount ?? fallback.toolCallCount) ?? 0;
  const toolResultCount = asInteger(source.toolResultCount ?? counters.toolResultCount ?? fallback.toolResultCount) ?? 0;
  const checkpointId = asText(source.checkpointId || fallback.checkpointId);
  const snapshotId = asText(source.snapshotId || fallback.snapshotId);
  const replayCursor = asText(source.replayCursor || snapshotId || fallback.replayCursor || fallback.snapshotId);
  const updatedAt = normalizeTimestamp(source.updatedAt || source.timestamp || fallback.updatedAt || fallback.timestamp);
  if (
    !checkpointId
    && !snapshotId
    && !replayCursor
    && !asText(source.sessionId || fallback.sessionId)
    && !asText(source.runId || fallback.runId)
    && !asText(source.threadId || fallback.threadId)
    && !asText(source.eventType || fallback.eventType)
    && messageCursor == null
    && turnCursor == null
    && eventCursor == null
    && spillCount === 0
    && toolCallCount === 0
    && toolResultCount === 0
  ) {
    return null;
  }
  return cleanObject({
    checkpointId: checkpointId || snapshotId || replayCursor || null,
    snapshotId: snapshotId || null,
    replayCursor: replayCursor || null,
    sessionId: asText(source.sessionId || fallback.sessionId) || null,
    runId: asText(source.runId || fallback.runId) || null,
    threadId: asText(source.threadId || fallback.threadId) || null,
    rootRunId: asText(source.rootRunId || fallback.rootRunId) || null,
    parentRunId: asText(source.parentRunId || fallback.parentRunId) || null,
    status: asText(source.status || fallback.status) || null,
    action: asText(source.action || fallback.action) || null,
    eventType: asText(source.eventType || fallback.eventType) || null,
    boundaryType: inferExecutionCheckpointBoundary(source, inferExecutionCheckpointBoundary(fallback)),
    providerTurnId: asText(source.providerTurnId || fallback.providerTurnId) || null,
    stageId: asText(source.stageId || fallback.stageId) || null,
    nodeId: asText(source.nodeId || fallback.nodeId) || null,
    nodeType: asText(source.nodeType || fallback.nodeType) || null,
    summary: asText(source.summary || fallback.summary) || null,
    updatedAt,
    messageCursor,
    turnCursor,
    eventCursor,
    spillCount,
    toolCallCount,
    toolResultCount,
    cursor: cleanObject({
      replay: replayCursor || null,
      message: messageCursor,
      turn: turnCursor,
      event: eventCursor,
    }),
    counters: {
      spillCount,
      toolCallCount,
      toolResultCount,
    },
    meta: checkpointMeta,
  });
}

function summarizeLedgerForRestore(ledger = {}) {
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  const latestEvent = events.at(-1) || null;
  const sessionIdentity = collectSessionIdentityFromLedger(ledger) || {};
  const taskIdentity = collectTaskIdentityFromLedger(ledger) || {};
  const latestCheckpoint = buildExecutionCheckpoint(
    ledger?.latestCheckpoint || latestEvent?.checkpoint || latestEvent?.meta?.checkpoint || null,
    {
      runId: ledger?.runId || null,
      rootRunId: ledger?.rootRunId || ledger?.runId || null,
      parentRunId: ledger?.parentRunId || null,
      sessionId: ledger?.sessionId || sessionIdentity.sessionId || null,
      threadId: ledger?.threadId || null,
      status: latestEvent?.status || ledger?.status || null,
      eventType: latestEvent?.eventType || null,
      providerTurnId: latestEvent?.providerTurnId || ledger?.providerTurnId || null,
      nodeId: latestEvent?.nodeId || null,
      nodeType: latestEvent?.nodeType || null,
      stageId: latestEvent?.stageId || null,
      updatedAt: latestEvent?.timestamp || ledger?.updatedAt || ledger?.startedAt || null,
      summary: latestEvent?.summary || null,
    },
  );
  return cleanObject({
    runId: ledger?.runId || null,
    rootRunId: ledger?.rootRunId || ledger?.runId || null,
    parentRunId: ledger?.parentRunId || null,
    sessionId: ledger?.sessionId || sessionIdentity.sessionId || null,
    rootSessionId: sessionIdentity.rootSessionId || ledger?.sessionId || null,
    parentSessionId: sessionIdentity.parentSessionId || null,
    threadId: ledger?.threadId || null,
    workflowId: ledger?.workflowId || null,
    workflowName: ledger?.workflowName || null,
    runKind: ledger?.runKind || pickRunKind(ledger) || null,
    taskId: taskIdentity.taskId || null,
    rootTaskId: taskIdentity.rootTaskId || null,
    parentTaskId: taskIdentity.parentTaskId || null,
    taskTitle: taskIdentity.taskTitle || null,
    status: ledger?.status || null,
    startedAt: ledger?.startedAt || null,
    endedAt: ledger?.endedAt || null,
    updatedAt: ledger?.updatedAt || latestEvent?.timestamp || ledger?.startedAt || null,
    eventCount: events.length,
    latestEventType: latestEvent?.eventType || null,
    latestEventAt: latestEvent?.timestamp || null,
    latestCheckpoint,
    objectiveFrame: ledger?.objectiveFrame || null,
    goalProgress: ledger?.goalProgress || null,
    constraintState: ledger?.constraintState || null,
    tokenBudget: ledger?.tokenBudget || null,
    active: Boolean(
      normalizeRuntimeStatus(ledger?.status)
      && !isTerminalRuntimeStatus(ledger?.status)
      && normalizeRuntimeStatus(ledger?.status) !== "idle"
    ),
    terminal: isTerminalRuntimeStatus(ledger?.status),
  });
}

function matchesRestoreFilter(summary = {}, filter = {}) {
  const requestedRunId = asText(filter?.runId);
  const requestedRootRunId = asText(filter?.rootRunId);
  const requestedSessionId = asText(filter?.sessionId);
  const requestedWorkflowId = asText(filter?.workflowId);
  if (requestedRunId && summary.runId !== requestedRunId) return false;
  if (requestedRootRunId && summary.rootRunId !== requestedRootRunId) return false;
  if (requestedSessionId && summary.sessionId !== requestedSessionId) return false;
  if (requestedWorkflowId && summary.workflowId !== requestedWorkflowId) return false;
  return true;
}

function trimEdgeDashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function stableKeyPart(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = trimEdgeDashes(normalized);
  return trimmed || fallback;
}

function pickRunKind(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const kind = String(event?.runKind || event?.meta?.runKind || event?.meta?.sessionType || "").trim();
    if (kind) return kind;
  }
  return ledger?.runKind || null;
}

function collectTaskIdentityFromLedger(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const taskId = String(
      event?.taskId || meta?.taskId || meta?.task?.id || meta?.taskInfo?.id || meta?.taskDetail?.id || "",
    ).trim();
    if (taskId) {
      return {
        taskId,
        taskTitle: String(
          meta?.taskTitle || meta?.task?.title || meta?.taskInfo?.title || meta?.taskDetail?.title || "",
        ).trim() || null,
        rootTaskId: String(event?.rootTaskId || meta?.rootTaskId || taskId || "").trim() || taskId,
        parentTaskId: String(event?.parentTaskId || meta?.parentTaskId || "").trim() || null,
        delegationDepth: Number.isFinite(Number(event?.delegationDepth ?? meta?.delegationDepth))
          ? Math.max(0, Math.trunc(Number(event?.delegationDepth ?? meta?.delegationDepth)))
          : 0,
        source: "ledger",
      };
    }
  }
  return null;
}

function collectSessionIdentityFromLedger(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const sessionId = String(
      event?.sessionId || meta?.sessionId || meta?.threadId || meta?.chatSessionId || event?.threadId || "",
    ).trim();
    if (!sessionId) continue;
    return {
      sessionId,
      rootSessionId: String(event?.rootSessionId || meta?.rootSessionId || sessionId || "").trim() || sessionId,
      parentSessionId: String(event?.parentSessionId || meta?.parentSessionId || "").trim() || null,
      sessionType: String(meta?.sessionType || meta?.runKind || "").trim() || null,
      delegationDepth: Number.isFinite(Number(event?.delegationDepth ?? meta?.delegationDepth))
        ? Math.max(0, Math.trunc(Number(event?.delegationDepth ?? meta?.delegationDepth)))
        : 0,
      source: "ledger",
    };
  }
  return null;
}

function inferExecutionShape(runId, event = {}) {
  const eventType = String(event?.eventType || "event").trim() || "event";
  const explicitKind = String(event?.executionKind || "").trim() || null;
  const nodeId = String(event?.nodeId || "").trim();
  const toolId = String(event?.toolId || "").trim();
  const toolName = String(event?.toolName || "").trim();
  const serverId = String(event?.serverId || event?.server || "").trim();
  const strategy = String(event?.meta?.strategy || event?.strategy || "").trim();
  const attempt = Number(event?.attempt || event?.meta?.attempt || 0);

  let executionKind = explicitKind;
  if (!executionKind) {
    if (eventType.startsWith("node.")) executionKind = "node";
    else if (eventType.startsWith("tool.")) executionKind = "tool";
    else if (eventType.startsWith("agent.")) executionKind = "agent";
    else if (eventType.startsWith("planner.")) executionKind = "planner";
    else if (eventType.startsWith("proof.")) executionKind = "proof";
    else if (eventType.startsWith("artifact.")) executionKind = "artifact";
    else if (eventType.startsWith("recovery.")) executionKind = "recovery";
    else executionKind = "run";
  }

  let executionId = String(event?.executionId || "").trim();
  let executionKey = String(event?.executionKey || "").trim();
  let executionLabel = String(event?.executionLabel || "").trim() || null;
  let parentExecutionId = String(event?.parentExecutionId || "").trim() || null;

  if (!executionId) {
    switch (executionKind) {
      case "node": {
        const resolvedNodeId = nodeId || "unknown";
        executionId = `node:${runId}:${resolvedNodeId}`;
        executionKey = executionKey || `node:${resolvedNodeId}`;
        executionLabel = executionLabel || event?.nodeLabel || resolvedNodeId;
        parentExecutionId = parentExecutionId || `run:${runId}`;
        break;
      }
      case "tool": {
        const toolKey = stableKeyPart(toolName || toolId || `${serverId}:${toolName}` || "tool");
        executionId = `tool:${runId}:${nodeId || "run"}:${toolKey}`;
        executionKey = executionKey || `tool:${nodeId || "run"}:${toolKey}`;
        executionLabel = executionLabel || toolName || toolId || (serverId && toolName ? `${serverId}/${toolName}` : "tool");
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "agent": {
        const agentKey = stableKeyPart(event?.agentId || event?.sdk || nodeId || "agent");
        executionId = `agent:${runId}:${nodeId || "run"}:${agentKey}`;
        executionKey = executionKey || `agent:${nodeId || "run"}:${agentKey}`;
        executionLabel = executionLabel || event?.agentLabel || event?.sdk || event?.nodeLabel || nodeId || "agent";
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "recovery": {
        const strategyKey = stableKeyPart(strategy || eventType || "recovery");
        const attemptKey = Number.isFinite(attempt) && attempt > 0 ? `:${attempt}` : "";
        executionId = `recovery:${runId}:${nodeId || "run"}:${strategyKey}${attemptKey}`;
        executionKey = executionKey || `recovery:${nodeId || "run"}:${strategyKey}`;
        executionLabel = executionLabel || strategy || eventType;
        parentExecutionId = parentExecutionId || (nodeId ? `agent:${runId}:${nodeId}:${stableKeyPart(event?.sdk || nodeId || "agent")}` : `run:${runId}`);
        break;
      }
      case "planner": {
        const stepKey = stableKeyPart(
          event?.meta?.stepKey
          || event?.meta?.attachmentKind
          || event?.reason
          || eventType
          || "planner",
          "planner",
        );
        const attemptKey = Number.isFinite(attempt) && attempt > 0 ? `:${attempt}` : "";
        executionId = `planner:${runId}:${nodeId || "run"}:${stepKey}${attemptKey}`;
        executionKey = executionKey || `planner:${nodeId || "run"}:${stepKey}`;
        executionLabel = executionLabel || event?.meta?.stepLabel || event?.summary || eventType;
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "proof":
      case "artifact": {
        const proofKey = stableKeyPart(
          event?.meta?.attachmentKind
          || event?.meta?.kind
          || event?.meta?.path
          || event?.summary
          || eventType
          || executionKind,
          executionKind,
        );
        executionId = `${executionKind}:${runId}:${nodeId || "run"}:${proofKey}`;
        executionKey = executionKey || `${executionKind}:${nodeId || "run"}:${proofKey}`;
        executionLabel = executionLabel || event?.meta?.stepLabel || event?.summary || eventType;
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "run":
      default:
        executionId = `run:${runId}`;
        executionKey = executionKey || `run:${event?.workflowId || runId}`;
        executionLabel = executionLabel || event?.workflowName || event?.workflowId || runId;
        parentExecutionId = parentExecutionId || null;
        break;
    }
  }

  if (!executionKey) executionKey = executionId;

  return {
    executionKind,
    executionId,
    executionKey,
    executionLabel,
    parentExecutionId,
  };
}

function shouldMarkStarted(eventType) {
  return [
    "run.start",
    "node.started",
    "tool.started",
    "agent.started",
    "planner.plan_initialized",
    "planner.step_started",
    "recovery.attempted",
  ].includes(String(eventType || ""));
}

function shouldMarkEnded(eventType) {
  const normalized = String(eventType || "");
  return [
    "run.end",
    "run.error",
    "run.cancelled",
    "node.completed",
    "node.failed",
    "node.skipped",
    "tool.completed",
    "tool.failed",
    "agent.completed",
    "agent.failed",
    "agent.cancelled",
    "planner.plan_completed",
    "planner.plan_failed",
    "planner.step_completed",
    "planner.step_blocked",
    "planner.post_attachment",
    "proof.emitted",
    "artifact.emitted",
    "recovery.succeeded",
    "recovery.failed",
  ].includes(normalized);
}

function summarizeExecutionDiff(left, right) {
  return (
    (left?.status || null) !== (right?.status || null)
    || Number(left?.attempt || 0) !== Number(right?.attempt || 0)
    || Number(left?.childRunIds?.length || 0) !== Number(right?.childRunIds?.length || 0)
  );
}

export class WorkflowExecutionLedger {
  constructor({ runsDir } = {}) {
    this.runsDir = resolve(String(runsDir || process.cwd()));
    this.ledgerDir = resolve(this.runsDir, LEDGER_DIR_NAME);
    this._runLedgerCache = new Map();
    this._runFamilyCache = new Map();
    this._runGraphCache = new Map();
  }

  _readCached(map, key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return null;
    const cached = map.get(normalizedKey);
    if (!cached) return null;
    if ((Date.now() - cached.ts) > LEDGER_READ_CACHE_TTL_MS) {
      map.delete(normalizedKey);
      return null;
    }
    return cached.value;
  }

  _writeCached(map, key, value) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || value == null) return value;
    map.set(normalizedKey, { ts: Date.now(), value });
    return value;
  }

  _invalidateRunCaches(runId = "", rootRunId = "") {
    const normalizedRunId = String(runId || "").trim();
    const normalizedRootRunId = String(rootRunId || "").trim();
    if (normalizedRunId) {
      this._runLedgerCache.delete(normalizedRunId);
      this._runGraphCache.delete(normalizedRunId);
    }
    if (normalizedRootRunId) {
      this._runFamilyCache.delete(normalizedRootRunId);
      this._runGraphCache.delete(normalizedRootRunId);
    }
  }

  _stateLedgerPath() {
    return resolveOwnedStateLedgerPath(this.runsDir);
  }

  _canReadStateLedger() {
    const stateLedgerPath = this._stateLedgerPath();
    if (!stateLedgerPath) return false;
    return stateLedgerPath === ":memory:" || existsSync(stateLedgerPath);
  }

  _shouldWriteStateLedger() {
    return Boolean(this._stateLedgerPath());
  }

  _ensureDir() {
    mkdirSync(this.ledgerDir, { recursive: true });
  }

  _ledgerPath(runId) {
    return resolve(this.ledgerDir, `${runId}.json`);
  }

  getRunLedger(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;
    const cached = this._readCached(this._runLedgerCache, normalizedRunId);
    if (cached) return cached;
    const filePath = this._ledgerPath(normalizedRunId);
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        return this._writeCached(
          this._runLedgerCache,
          normalizedRunId,
          normalizeLedgerDocument(normalizedRunId, parsed),
        );
      } catch {
        /* sqlite fallback below */
      }
    }
    if (!this._canReadStateLedger()) return null;
    try {
      return this._writeCached(
        this._runLedgerCache,
        normalizedRunId,
        getWorkflowRunFromStateLedger(normalizedRunId, { anchorPath: this.runsDir }),
      );
    } catch {
      return null;
    }
  }

  listRunLedgers() {
    const byRunId = new Map();
    if (this._canReadStateLedger()) {
      try {
        for (const ledger of listWorkflowRunsFromStateLedger({ anchorPath: this.runsDir })) {
          if (ledger?.runId) {
            byRunId.set(ledger.runId, ledger);
          }
        }
      } catch {
        /* best effort */
      }
    }
    if (!existsSync(this.ledgerDir)) return Array.from(byRunId.values());
    try {
      for (const ledger of readdirSync(this.ledgerDir)
        .filter((file) => extname(file).toLowerCase() === ".json")
        .map((file) => this.getRunLedger(basename(file, ".json")))
        .filter(Boolean)) {
        byRunId.set(ledger.runId, ledger);
      }
      return Array.from(byRunId.values());
    } catch {
      return Array.from(byRunId.values());
    }
  }

  getRunFamily(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return [];
    const rootRunId = ledger.rootRunId || ledger.runId;
    const cached = this._readCached(this._runFamilyCache, rootRunId);
    if (cached) return cached;
    if (this._canReadStateLedger()) {
      try {
        const family = listWorkflowRunFamilyFromStateLedger(runId, { anchorPath: this.runsDir })
          .filter(Boolean)
          .map((entry) => {
            if (!entry?.runId) return entry;
            const cached = this._readCached(this._runLedgerCache, entry.runId);
            if (cached) {
              return normalizeLedgerDocument(entry.runId, {
                ...entry,
                ...cached,
                events: cached?.events || entry?.events || [],
              });
            }
            const filePath = this._ledgerPath(entry.runId);
            if (existsSync(filePath)) {
              try {
                const parsed = JSON.parse(readFileSync(filePath, "utf8"));
                return normalizeLedgerDocument(entry.runId, {
                  ...entry,
                  ...parsed,
                  events: parsed?.events || entry?.events || [],
                });
              } catch {
                return entry;
              }
            }
            return entry;
          })
          .sort((left, right) => {
            const delta = toTimestamp(left?.startedAt || left?.updatedAt) - toTimestamp(right?.startedAt || right?.updatedAt);
            if (delta !== 0) return delta;
            return String(left?.runId || "").localeCompare(String(right?.runId || ""));
          });
        if (family.length > 0) {
          for (const entry of family) {
            if (entry?.runId) this._writeCached(this._runLedgerCache, entry.runId, entry);
          }
          return this._writeCached(this._runFamilyCache, rootRunId, family);
        }
      } catch {
        /* file fallback below */
      }
    }
    const family = this.listRunLedgers()
      .filter((entry) => (entry?.rootRunId || entry?.runId) === rootRunId)
      .sort((left, right) => {
        const delta = toTimestamp(left?.startedAt || left?.updatedAt) - toTimestamp(right?.startedAt || right?.updatedAt);
        if (delta !== 0) return delta;
        return String(left?.runId || "").localeCompare(String(right?.runId || ""));
      });
    return this._writeCached(this._runFamilyCache, rootRunId, family);
  }

  getTaskIdentity(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return null;
    return collectTaskIdentityFromLedger(ledger);
  }

  getSessionIdentity(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return null;
    return collectSessionIdentityFromLedger(ledger);
  }

  listTaskRunEntries() {
    return this.listRunLedgers()
      .map((ledger) => {
        const taskIdentity = collectTaskIdentityFromLedger(ledger);
        if (!taskIdentity?.taskId) return null;
        return {
          runId: ledger.runId,
          rootRunId: ledger.rootRunId || ledger.runId,
          taskId: taskIdentity.taskId,
          taskTitle: taskIdentity.taskTitle || null,
          startedAt: ledger.startedAt || null,
          updatedAt: ledger.updatedAt || null,
          status: ledger.status || null,
        };
      })
      .filter(Boolean);
  }

  buildRunGraph(runId) {
    const cachedGraph = this._readCached(this._runGraphCache, runId);
    if (cachedGraph) return cachedGraph;
    const family = this.getRunFamily(runId);
    if (!family.length) return null;

    const requested = this.getRunLedger(runId) || family.find((entry) => entry?.runId === runId) || family[0];
    const rootRunId = requested?.rootRunId || requested?.runId || String(runId || "").trim() || null;
    const runs = family.map((ledger) => {
      const taskIdentity = collectTaskIdentityFromLedger(ledger);
      const sessionIdentity = collectSessionIdentityFromLedger(ledger);
      return {
        runId: ledger.runId,
        workflowId: ledger.workflowId || null,
        workflowName: ledger.workflowName || null,
        rootRunId: ledger.rootRunId || ledger.runId,
        parentRunId: ledger.parentRunId || null,
        retryOf: ledger.retryOf || null,
        retryMode: ledger.retryMode || null,
        runKind: pickRunKind(ledger),
        startedAt: ledger.startedAt || null,
        endedAt: ledger.endedAt || null,
        updatedAt: ledger.updatedAt || null,
        status: ledger.status || null,
        taskId: taskIdentity?.taskId || null,
        taskTitle: taskIdentity?.taskTitle || null,
        rootTaskId: taskIdentity?.rootTaskId || taskIdentity?.taskId || null,
        parentTaskId: taskIdentity?.parentTaskId || null,
        sessionId: sessionIdentity?.sessionId || null,
        rootSessionId: sessionIdentity?.rootSessionId || sessionIdentity?.sessionId || null,
        parentSessionId: sessionIdentity?.parentSessionId || null,
        sessionType: sessionIdentity?.sessionType || null,
        delegationDepth: Math.max(
          Number(taskIdentity?.delegationDepth || 0),
          Number(sessionIdentity?.delegationDepth || 0),
        ),
      };
    });

    const seenTimelineKeys = new Set();
    const timeline = family
      .flatMap((ledger) =>
        (Array.isArray(ledger?.events) ? ledger.events : [])
          .map((event) => ({
            ...event,
            runId: event?.runId || ledger.runId,
            rootRunId: event?.rootRunId || ledger.rootRunId || ledger.runId,
            parentRunId: event?.parentRunId || ledger.parentRunId || null,
          }))
          .filter((event) => {
            const normalizedSeq = Number.isFinite(Number(event?.seq)) ? Number(event.seq) : null;
            const dedupeKey = normalizedSeq != null
              ? JSON.stringify([
                  event?.runId || null,
                  normalizedSeq,
                  event?.eventType || null,
                  event?.executionKey || event?.executionId || event?.nodeId || null,
                ])
              : JSON.stringify([
                  event?.id || null,
                  event?.runId || null,
                  event?.timestamp || null,
                  event?.eventType || null,
                  event?.executionId || null,
                  event?.executionKey || null,
                ]);
            if (seenTimelineKeys.has(dedupeKey)) return false;
            seenTimelineKeys.add(dedupeKey);
            return true;
          }),
      )
      .sort((left, right) => {
        const delta = toTimestamp(left?.timestamp) - toTimestamp(right?.timestamp);
        if (delta !== 0) return delta;
        const seqDelta = Number(left?.seq || 0) - Number(right?.seq || 0);
        if (seqDelta !== 0) return seqDelta;
        return String(left?.runId || "").localeCompare(String(right?.runId || ""));
      });

    const edges = [];
    const seenEdgeKeys = new Set();
    const pushEdge = (edge) => {
      const key = JSON.stringify(edge);
      if (seenEdgeKeys.has(key)) return;
      seenEdgeKeys.add(key);
      edges.push(edge);
    };

    for (const ledger of family) {
      if (ledger?.parentRunId) {
        pushEdge({
          type: "parent-child",
          parentRunId: ledger.parentRunId,
          childRunId: ledger.runId,
          rootRunId: ledger.rootRunId || ledger.runId,
        });
      }
      if (ledger?.retryOf) {
        pushEdge({
          type: "retry",
          parentRunId: ledger.retryOf,
          childRunId: ledger.runId,
          mode: ledger.retryMode || null,
          rootRunId: ledger.rootRunId || ledger.runId,
        });
      }
    }

    const executionMap = new Map();
    for (const event of timeline) {
      const executionId = String(event?.executionId || "").trim();
      const resolvedExecutionId = executionId || inferExecutionShape(event?.runId || requested?.runId || rootRunId, event).executionId;
      const shape = inferExecutionShape(event?.runId || requested?.runId || rootRunId, {
        ...event,
        executionId: resolvedExecutionId,
      });
      const current = executionMap.get(shape.executionId) || {
        executionId: shape.executionId,
        executionKey: shape.executionKey,
        executionKind: shape.executionKind,
        executionLabel: shape.executionLabel,
        nodeId: event?.nodeId || null,
        nodeType: event?.nodeType || null,
        nodeLabel: event?.nodeLabel || null,
        toolId: event?.toolId || null,
        toolName: event?.toolName || null,
        serverId: event?.serverId || event?.server || null,
        runId: event?.runId || null,
        rootRunId: event?.rootRunId || null,
        parentRunId: event?.parentRunId || null,
        parentExecutionId: shape.parentExecutionId || null,
        causedByExecutionId: event?.causedByExecutionId || null,
        childRunIds: [],
        retryOf: event?.retryOf || null,
        retryMode: event?.retryMode || null,
        status: null,
        startedAt: null,
        endedAt: null,
        attempt: 0,
        eventTypes: [],
        errors: [],
      };
      current.executionKey = current.executionKey || shape.executionKey;
      current.executionKind = current.executionKind || shape.executionKind;
      current.executionLabel = current.executionLabel || shape.executionLabel;
      current.nodeId = current.nodeId || event?.nodeId || null;
      current.nodeType = current.nodeType || event?.nodeType || null;
      current.nodeLabel = current.nodeLabel || event?.nodeLabel || null;
      current.toolId = current.toolId || event?.toolId || null;
      current.toolName = current.toolName || event?.toolName || null;
      current.serverId = current.serverId || event?.serverId || event?.server || null;
      current.runId = current.runId || event?.runId || null;
      current.rootRunId = current.rootRunId || event?.rootRunId || null;
      current.parentRunId = current.parentRunId || event?.parentRunId || null;
      current.parentExecutionId = current.parentExecutionId || shape.parentExecutionId || null;
      current.causedByExecutionId = current.causedByExecutionId || event?.causedByExecutionId || null;
      current.retryOf = current.retryOf || event?.retryOf || null;
      current.retryMode = current.retryMode || event?.retryMode || null;
      current.eventTypes.push(String(event?.eventType || "event"));
      current.attempt = Math.max(current.attempt, Number(event?.attempt || 0));
      if (shouldMarkStarted(event?.eventType) && !current.startedAt) {
        current.startedAt = event.timestamp || null;
      }
      if (shouldMarkEnded(event?.eventType)) {
        current.endedAt = event.timestamp || current.endedAt || null;
        current.status = event?.status || current.status || null;
      } else if (event?.status) {
        current.status = event.status;
      }
      if (event?.error) current.errors.push(String(event.error));
      if (event?.childRunId && !current.childRunIds.includes(event.childRunId)) {
        current.childRunIds.push(event.childRunId);
      }
      executionMap.set(shape.executionId, current);

      if (shape.parentExecutionId) {
        pushEdge({
          type: "execution",
          parentExecutionId: shape.parentExecutionId,
          childExecutionId: shape.executionId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
      if (event?.causedByExecutionId) {
        pushEdge({
          type: "causal",
          parentExecutionId: event.causedByExecutionId,
          childExecutionId: shape.executionId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
      if (event?.childRunId) {
        pushEdge({
          type: "execution-run",
          parentExecutionId: shape.executionId,
          childRunId: event.childRunId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
    }

    const executions = Array.from(executionMap.values()).sort((left, right) => {
      const delta = toTimestamp(left?.startedAt || left?.endedAt) - toTimestamp(right?.startedAt || right?.endedAt);
      if (delta !== 0) return delta;
      return String(left?.executionId || "").localeCompare(String(right?.executionId || ""));
    });

    const graph = {
      requestedRunId: requested?.runId || null,
      rootRunId,
      runs,
      edges,
      timeline,
      executions,
    };
    this._writeCached(this._runGraphCache, runId, graph);
    if (rootRunId) this._writeCached(this._runGraphCache, rootRunId, graph);
    return graph;
  }

  diffRunGraphs(baseRunId, comparisonRunId) {
    const baseLedger = this.getRunLedger(baseRunId);
    const comparisonLedger = this.getRunLedger(comparisonRunId);
    if (!baseLedger || !comparisonLedger) return null;

    const toExecutionMap = (ledger) => {
      const map = new Map();
      for (const event of Array.isArray(ledger?.events) ? ledger.events : []) {
        const shape = inferExecutionShape(ledger.runId, event);
        const key = shape.executionKey || shape.executionId;
        const current = map.get(key) || {
          executionId: shape.executionId,
          executionKey: key,
          executionKind: shape.executionKind,
          executionLabel: shape.executionLabel,
          nodeId: event?.nodeId || null,
          runId: ledger.runId,
          status: null,
          attempt: 0,
          childRunIds: [],
        };
        current.status = event?.status || current.status || null;
        current.attempt = Math.max(current.attempt, Number(event?.attempt || 0));
        if (event?.childRunId && !current.childRunIds.includes(event.childRunId)) {
          current.childRunIds.push(event.childRunId);
        }
        map.set(key, current);
      }
      return map;
    };

    const baseExecutions = toExecutionMap(baseLedger);
    const comparisonExecutions = toExecutionMap(comparisonLedger);
    const allIds = new Set([...baseExecutions.keys(), ...comparisonExecutions.keys()]);
    const added = [];
    const removed = [];
    const changed = [];

    for (const executionKey of allIds) {
      const left = baseExecutions.get(executionKey) || null;
      const right = comparisonExecutions.get(executionKey) || null;
      if (!left && right) {
        added.push({
          executionKey,
          executionKind: right.executionKind || null,
          comparisonStatus: right.status || null,
          nodeId: right.nodeId || null,
        });
        continue;
      }
      if (left && !right) {
        removed.push({
          executionKey,
          executionKind: left.executionKind || null,
          baseStatus: left.status || null,
          nodeId: left.nodeId || null,
        });
        continue;
      }
      if (!left || !right) continue;
      if (summarizeExecutionDiff(left, right)) {
        changed.push({
          executionKey,
          executionKind: left.executionKind || right.executionKind || null,
          nodeId: left.nodeId || right.nodeId || null,
          baseStatus: left.status || null,
          comparisonStatus: right.status || null,
          baseAttempt: Number(left.attempt || 0),
          comparisonAttempt: Number(right.attempt || 0),
          baseChildRunCount: Number(left.childRunIds?.length || 0),
          comparisonChildRunCount: Number(right.childRunIds?.length || 0),
        });
      }
    }

    return {
      baseRunId: baseLedger.runId,
      comparisonRunId: comparisonLedger.runId,
      executionDelta: {
        added,
        removed,
        changed,
      },
    };
  }

  buildRestoreState(filter = {}) {
    const requestedRunId = asText(filter?.runId);
    const requestedRootRunId = asText(filter?.rootRunId);
    const eventLimit = Number.isFinite(Number(filter?.eventLimit))
      ? Math.max(1, Math.trunc(Number(filter.eventLimit)))
      : 50;
    let ledgers = requestedRunId
      ? this.getRunFamily(requestedRunId)
      : this.listRunLedgers();
    const runSummaries = ledgers
      .map((ledger) => summarizeLedgerForRestore(ledger))
      .filter((summary) => matchesRestoreFilter(summary, {
        ...filter,
        ...(requestedRunId && !requestedRootRunId ? { rootRunId: null } : {}),
      }))
      .sort((left, right) => {
        const delta = toTimestamp(right?.updatedAt || right?.latestEventAt) - toTimestamp(left?.updatedAt || left?.latestEventAt);
        if (delta !== 0) return delta;
        return String(left?.runId || "").localeCompare(String(right?.runId || ""));
      });

    if (requestedRootRunId) {
      ledgers = ledgers.filter((ledger) => String(ledger?.rootRunId || ledger?.runId || "").trim() === requestedRootRunId);
    } else if (runSummaries.length > 0) {
      const allowed = new Set(runSummaries.map((entry) => entry.runId));
      ledgers = ledgers.filter((ledger) => allowed.has(ledger?.runId));
    }

    const recentEvents = ledgers
      .flatMap((ledger) => (Array.isArray(ledger?.events) ? ledger.events : []).map((event) => cleanObject({
        ...event,
        runId: event?.runId || ledger?.runId || null,
        rootRunId: event?.rootRunId || ledger?.rootRunId || ledger?.runId || null,
        parentRunId: event?.parentRunId || ledger?.parentRunId || null,
        sessionId: event?.sessionId || ledger?.sessionId || null,
        threadId: event?.threadId || ledger?.threadId || null,
        workflowId: event?.workflowId || ledger?.workflowId || null,
        workflowName: event?.workflowName || ledger?.workflowName || null,
      })))
      .sort((left, right) => {
        const delta = toTimestamp(left?.timestamp) - toTimestamp(right?.timestamp);
        if (delta !== 0) return delta;
        return String(left?.id || "").localeCompare(String(right?.id || ""));
      })
      .slice(-eventLimit);

    const latestRun = runSummaries[0] || null;
    const latestEvent = recentEvents.at(-1) || null;
    const latestCheckpoint = buildExecutionCheckpoint(
      latestRun?.latestCheckpoint || latestEvent?.checkpoint || latestEvent?.meta?.checkpoint || null,
      {
        runId: latestRun?.runId || latestEvent?.runId || null,
        rootRunId: latestRun?.rootRunId || latestEvent?.rootRunId || null,
        parentRunId: latestRun?.parentRunId || latestEvent?.parentRunId || null,
        sessionId: latestRun?.sessionId || latestEvent?.sessionId || null,
        threadId: latestRun?.threadId || latestEvent?.threadId || null,
        status: latestRun?.status || latestEvent?.status || null,
        eventType: latestEvent?.eventType || latestRun?.latestEventType || null,
        providerTurnId: latestEvent?.providerTurnId || null,
        nodeId: latestEvent?.nodeId || null,
        nodeType: latestEvent?.nodeType || null,
        stageId: latestEvent?.stageId || null,
        updatedAt: latestRun?.updatedAt || latestEvent?.timestamp || null,
        summary: latestEvent?.summary || null,
      },
    );
    return {
      source: "execution-ledger",
      runCount: runSummaries.length,
      activeRunCount: runSummaries.filter((entry) => entry.active).length,
      terminalRunCount: runSummaries.filter((entry) => entry.terminal).length,
      sessionIds: [...new Set(runSummaries.map((entry) => entry.sessionId).filter(Boolean))],
      runIds: runSummaries.map((entry) => entry.runId).filter(Boolean),
      status: latestRun?.status || latestEvent?.status || null,
      latestRun,
      latestEvent,
      latestCheckpoint,
      objectiveFrame: latestRun?.objectiveFrame || null,
      goalProgress: latestRun?.goalProgress || null,
      constraintState: latestRun?.constraintState || null,
      tokenBudget: latestRun?.tokenBudget || null,
      runs: runSummaries,
      recentEvents,
    };
  }

  ensureRun(meta = {}) {
    const runId = String(meta.runId || "").trim();
    if (!runId) {
      throw new Error(`${TAG} runId is required`);
    }

    this._ensureDir();
    const existing = this.getRunLedger(runId);
    const governanceState = extractGovernanceState(meta);
    const merged = normalizeLedgerDocument(runId, {
      ...existing,
      ...cleanObject(meta),
      ...governanceState,
      rootRunId: meta.rootRunId || existing?.rootRunId || runId,
      sessionId: meta.sessionId || existing?.sessionId || null,
      threadId: meta.threadId || existing?.threadId || null,
      traceId: meta.traceId || existing?.traceId || null,
      spanId: meta.spanId || existing?.spanId || null,
      parentSpanId: meta.parentSpanId || existing?.parentSpanId || null,
      providerId: meta.providerId || existing?.providerId || null,
      providerTurnId: meta.providerTurnId || existing?.providerTurnId || null,
      modelId: meta.modelId || existing?.modelId || null,
      approvalId: meta.approvalId || existing?.approvalId || null,
      actor: meta.actor || existing?.actor || null,
      events: existing?.events || [],
    });
    merged.latestCheckpoint = meta.checkpoint
      ? buildExecutionCheckpoint(
          meta.checkpoint,
          {
            runId: merged.runId,
            rootRunId: merged.rootRunId,
            parentRunId: merged.parentRunId,
            sessionId: merged.sessionId,
            threadId: merged.threadId,
            status: merged.status,
            providerTurnId: merged.providerTurnId,
            updatedAt: merged.updatedAt || merged.startedAt || null,
          },
        )
      : (existing?.latestCheckpoint || null);
    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    if (this._shouldWriteStateLedger()) {
      try {
        writeWorkflowStateLedger(
          { runDocument: merged },
          { anchorPath: this.runsDir },
        );
      } catch (err) {
        console.warn(`${STATE_LEDGER_TAG} workflow run sync failed: ${String(err?.message || err)}`);
      }
    }
    this._invalidateRunCaches(runId, merged.rootRunId || runId);
    return merged;
  }

  appendEvent(event = {}) {
    const runId = String(event.runId || "").trim();
    if (!runId) {
      throw new Error(`${TAG} event.runId is required`);
    }

    const timestamp = String(event.timestamp || new Date().toISOString()).trim() || new Date().toISOString();
    const shape = inferExecutionShape(runId, event);
    this._ensureDir();
    const existing = this.getRunLedger(runId);
    const eventMeta = event.meta && typeof event.meta === "object" ? event.meta : {};
    const existingSessionIdentity = collectSessionIdentityFromLedger(existing || {});
    const governanceState = extractGovernanceState({
      ...existing,
      ...event,
      ...eventMeta,
    });
    const ledger = normalizeLedgerDocument(runId, {
      ...existing,
      runId,
      workflowId: event.workflowId || null,
      workflowName: event.workflowName || null,
      rootRunId: event.rootRunId || existing?.rootRunId || runId,
      parentRunId: event.parentRunId || existing?.parentRunId || null,
      sessionId: event.sessionId || existing?.sessionId || null,
      threadId: event.threadId || existing?.threadId || null,
      traceId: event.traceId || existing?.traceId || null,
      spanId: event.spanId || existing?.spanId || null,
      parentSpanId: event.parentSpanId || existing?.parentSpanId || null,
      providerId: event.providerId || existing?.providerId || null,
      providerTurnId: event.providerTurnId || existing?.providerTurnId || null,
      modelId: event.modelId || existing?.modelId || null,
      approvalId: event.approvalId || existing?.approvalId || null,
      actor: event.actor || existing?.actor || null,
      retryOf: event.retryOf || existing?.retryOf || null,
      retryMode: event.retryMode || existing?.retryMode || null,
      runKind: event.runKind || event.meta?.runKind || existing?.runKind || undefined,
      startedAt: event.eventType === "run.start"
        ? timestamp
        : (existing?.startedAt || undefined),
      endedAt: event.eventType === "run.end" || event.eventType === "run.error" || event.eventType === "run.cancelled"
        ? timestamp
        : (existing?.endedAt || undefined),
      status: event.status || existing?.status || undefined,
      updatedAt: timestamp,
      ...governanceState,
      events: Array.isArray(existing?.events) ? existing.events : [],
    });

    const nextSeq = (ledger.events.at(-1)?.seq || 0) + 1;
    const payload = cleanObject({
      id: randomUUID(),
      seq: nextSeq,
      timestamp,
      eventType: String(event.eventType || "event").trim() || "event",
      category: event.category || null,
      runId,
      workflowId: event.workflowId || ledger.workflowId || null,
      workflowName: event.workflowName || ledger.workflowName || null,
      rootRunId: event.rootRunId || ledger.rootRunId || runId,
      parentRunId: event.parentRunId || ledger.parentRunId || null,
      retryOf: event.retryOf || ledger.retryOf || null,
      retryMode: event.retryMode || ledger.retryMode || null,
      runKind: event.runKind || event.meta?.runKind || ledger.runKind || null,
      executionId: shape.executionId,
      executionKey: shape.executionKey,
      executionKind: shape.executionKind,
      executionLabel: shape.executionLabel,
      rootTaskId: event.rootTaskId || null,
      parentTaskId: event.parentTaskId || null,
      childTaskId: event.childTaskId || null,
      sessionId: event.sessionId || ledger.sessionId || null,
      rootSessionId: event.rootSessionId || existingSessionIdentity?.rootSessionId || null,
      parentSessionId: event.parentSessionId || existingSessionIdentity?.parentSessionId || null,
      childSessionId: event.childSessionId || null,
      threadId: event.threadId || ledger.threadId || null,
      traceId: event.traceId || ledger.traceId || null,
      spanId: event.spanId || ledger.spanId || null,
      parentSpanId: event.parentSpanId || ledger.parentSpanId || null,
      parentExecutionId: event.parentExecutionId || shape.parentExecutionId || null,
      causedByExecutionId: event.causedByExecutionId || null,
      childRunId: event.childRunId || null,
      rootSessionId: event.rootSessionId || null,
      parentSessionId: event.parentSessionId || null,
      childSessionId: event.childSessionId || null,
      rootTaskId: event.rootTaskId || null,
      parentTaskId: event.parentTaskId || null,
      childTaskId: event.childTaskId || null,
      delegationDepth: Number.isFinite(Number(event.delegationDepth))
        ? Number(event.delegationDepth)
        : (Number.isFinite(Number(existingSessionIdentity?.delegationDepth))
            ? Number(existingSessionIdentity.delegationDepth)
            : undefined),
      subagentId: event.subagentId || null,
      nodeId: event.nodeId || null,
      nodeType: event.nodeType || null,
      nodeLabel: event.nodeLabel || null,
      stageId: event.stageId || null,
      stageType: event.stageType || null,
      toolId: event.toolId || null,
      toolName: event.toolName || null,
      serverId: event.serverId || event.server || null,
      artifactId: event.artifactId || null,
      artifactPath: event.artifactPath || event.filePath || null,
      filePath: event.filePath || event.artifactPath || null,
      fileHash: event.fileHash || null,
      patchHash: event.patchHash || null,
      commandId: event.commandId || null,
      commandName: event.commandName || null,
      surface: event.surface || null,
      channel: event.channel || null,
      action: event.action || null,
      workspaceId: event.workspaceId || null,
      repoRoot: event.repoRoot || null,
      branch: event.branch || null,
      prNumber: Number.isFinite(Number(event.prNumber)) ? Number(event.prNumber) : undefined,
      prUrl: event.prUrl || null,
      providerId: event.providerId || ledger.providerId || null,
      providerTurnId: event.providerTurnId || ledger.providerTurnId || null,
      modelId: event.modelId || ledger.modelId || null,
      approvalId: event.approvalId || ledger.approvalId || null,
      artifactId: event.artifactId || null,
      artifactPath: event.artifactPath || event.filePath || null,
      filePath: event.filePath || event.artifactPath || null,
      fileHash: event.fileHash || null,
      patchHash: event.patchHash || null,
      subagentId: event.subagentId || null,
      commandId: event.commandId || null,
      commandName: event.commandName || null,
      surface: event.surface || null,
      channel: event.channel || null,
      action: event.action || null,
      actor: event.actor || ledger.actor || null,
      status: event.status || null,
      attempt: Number.isFinite(Number(event.attempt)) ? Number(event.attempt) : undefined,
      durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : undefined,
      latencyMs: Number.isFinite(Number(event.latencyMs)) ? Number(event.latencyMs) : undefined,
      costUsd: Number.isFinite(Number(event.costUsd)) ? Number(event.costUsd) : undefined,
      tokenUsage: event.tokenUsage && typeof event.tokenUsage === "object"
        ? {
            inputTokens: Number(event.tokenUsage.inputTokens || 0),
            outputTokens: Number(event.tokenUsage.outputTokens || 0),
            totalTokens: Number(event.tokenUsage.totalTokens || 0),
          }
        : undefined,
      error: event.error ? String(event.error) : null,
      summary: event.summary ? String(event.summary) : null,
      reason: event.reason ? String(event.reason) : null,
      primaryGoalId: governanceState.primaryGoalId || ledger.primaryGoalId || undefined,
      primaryGoalTitle: governanceState.primaryGoalTitle || ledger.primaryGoalTitle || undefined,
      goalDepth: governanceState.goalDepth ?? ledger.goalDepth ?? undefined,
      heartbeatRunId: governanceState.heartbeatRun?.runId || ledger.heartbeatRun?.runId || undefined,
      wakeupRequestId: governanceState.wakeupRequest?.requestId || ledger.wakeupRequest?.requestId || undefined,
      budgetStatus: governanceState.budgetOutcome?.status || ledger.budgetOutcome?.status || undefined,
      policyStatus: governanceState.policyOutcome?.status || ledger.policyOutcome?.status || undefined,
      meta: Object.keys(eventMeta).length > 0
        ? {
            ...eventMeta,
            ...(governanceState.goalAncestry?.length ? { goalAncestry: governanceState.goalAncestry } : {}),
            ...(governanceState.heartbeatRun ? { heartbeatRun: governanceState.heartbeatRun } : {}),
            ...(governanceState.wakeupRequest ? { wakeupRequest: governanceState.wakeupRequest } : {}),
            ...(governanceState.budgetPolicy ? { budgetPolicy: governanceState.budgetPolicy } : {}),
            ...(governanceState.executionPolicy ? { executionPolicy: governanceState.executionPolicy } : {}),
            ...(governanceState.budgetOutcome ? { budgetOutcome: governanceState.budgetOutcome } : {}),
            ...(governanceState.policyOutcome ? { policyOutcome: governanceState.policyOutcome } : {}),
            ...(governanceState.successCriteria?.length ? { successCriteria: governanceState.successCriteria } : {}),
            ...(governanceState.goalProgress ? { goalProgress: governanceState.goalProgress } : {}),
            ...(governanceState.constraintState ? { constraintState: governanceState.constraintState } : {}),
            ...(governanceState.tokenBudget ? { tokenBudget: governanceState.tokenBudget } : {}),
            ...(governanceState.objectiveFrame ? { objectiveFrame: governanceState.objectiveFrame } : {}),
          }
        : undefined,
    });

    ledger.events.push(payload);
    ledger.updatedAt = timestamp;
    if (payload.eventType === "run.start" && !ledger.startedAt) {
      ledger.startedAt = timestamp;
    }
    if (payload.runKind && !ledger.runKind) ledger.runKind = payload.runKind;
    if (payload.eventType === "run.end" || payload.eventType === "run.error" || payload.eventType === "run.cancelled") {
      ledger.endedAt = timestamp;
      ledger.status = payload.status || ledger.status || null;
    } else if (payload.status && !String(payload.eventType).startsWith("node.")) {
      ledger.status = payload.status;
    }
    ledger.goalAncestry = governanceState.goalAncestry || ledger.goalAncestry || [];
    ledger.primaryGoalId = governanceState.primaryGoalId || ledger.primaryGoalId || null;
    ledger.primaryGoalTitle = governanceState.primaryGoalTitle || ledger.primaryGoalTitle || null;
    ledger.goalDepth = governanceState.goalDepth ?? ledger.goalDepth ?? null;
    ledger.heartbeatRun = governanceState.heartbeatRun || ledger.heartbeatRun || null;
    ledger.wakeupRequest = governanceState.wakeupRequest || ledger.wakeupRequest || null;
    ledger.budgetPolicy = governanceState.budgetPolicy || ledger.budgetPolicy || null;
    ledger.executionPolicy = governanceState.executionPolicy || ledger.executionPolicy || null;
    ledger.budgetOutcome = governanceState.budgetOutcome || ledger.budgetOutcome || null;
    ledger.policyOutcome = governanceState.policyOutcome || ledger.policyOutcome || null;
    ledger.successCriteria = governanceState.successCriteria || ledger.successCriteria || [];
    ledger.goalProgress = governanceState.goalProgress || ledger.goalProgress || null;
    ledger.constraintState = governanceState.constraintState || ledger.constraintState || null;
    ledger.tokenBudget = governanceState.tokenBudget || ledger.tokenBudget || null;
    ledger.objectiveFrame = governanceState.objectiveFrame || ledger.objectiveFrame || null;
    if (shouldPersistExecutionCheckpoint(event.checkpoint || eventMeta.checkpoint || payload)) {
      ledger.latestCheckpoint = buildExecutionCheckpoint(
        event.checkpoint || eventMeta.checkpoint || payload.checkpoint || null,
        {
          checkpointId: payload.id,
          runId: ledger.runId,
          rootRunId: ledger.rootRunId,
          parentRunId: ledger.parentRunId,
          sessionId: payload.sessionId || ledger.sessionId || null,
          threadId: payload.threadId || ledger.threadId || null,
          status: payload.status || ledger.status || null,
          action: payload.action || null,
          eventType: payload.eventType || null,
          providerTurnId: payload.providerTurnId || ledger.providerTurnId || null,
          nodeId: payload.nodeId || null,
          nodeType: payload.nodeType || null,
          stageId: payload.stageId || null,
          updatedAt: payload.timestamp || ledger.updatedAt || null,
          summary: payload.summary || null,
          messageCursor: payload.meta?.checkpoint?.messageCursor,
          turnCursor: payload.meta?.checkpoint?.turnCursor,
          eventCursor: payload.seq,
          spillCount: payload.meta?.checkpoint?.spillCount,
          toolCallCount: payload.meta?.checkpoint?.toolCallCount,
          toolResultCount: payload.meta?.checkpoint?.toolResultCount,
          meta: payload.meta,
        },
      );
      if (ledger.latestCheckpoint) {
        payload.checkpoint = ledger.latestCheckpoint;
      }
    }

    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    if (this._shouldWriteStateLedger()) {
      try {
        writeWorkflowStateLedger(
          {
            runDocument: ledger,
            appendedEvent: payload,
          },
          { anchorPath: this.runsDir },
        );
      } catch (err) {
        console.warn(`${STATE_LEDGER_TAG} workflow event sync failed: ${String(err?.message || err)}`);
      }
    }
    recordHarnessTelemetryEvent({
      ...payload,
      type: payload.eventType,
      eventType: payload.eventType,
      source: "workflow-execution-ledger",
      taskId: event.taskId || event.meta?.taskId || payload.taskId || null,
      retryCount: payload.attempt,
      payload,
      meta: payload.meta,
    }, { configDir: dirname(this.runsDir) });
    this._invalidateRunCaches(runId, ledger.rootRunId || runId);
    return payload;
  }
}
