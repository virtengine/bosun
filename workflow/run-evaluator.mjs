/**
 * run-evaluator.mjs — Post-run quality evaluation and remediation suggestions.
 *
 * Evaluates completed/failed workflow runs to produce quality scores,
 * grade classifications, and actionable remediation suggestions.
 *
 * Features:
 *   - Configurable penalty/threshold values
 *   - Auto-trigger integration via engine run:complete event
 *   - Evaluation history persistence with trend analysis
 *   - Per-workflow evaluation tracks
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[run-evaluator]";

// ── Default penalties (all configurable via constructor) ────────────────────

const DEFAULTS = {
  penaltyFailedNode: 10,
  penaltyRetriedNode: 5,
  penaltySkippedNode: 2,
  penaltySlowRunMs: 5 * 60 * 1000,
  penaltySlowRun: 5,
  penaltySlowNodeMs: 2 * 60 * 1000,
  penaltySlowNode: 10,
  penaltyHighErrorRate: 20,
  highErrorRateThreshold: 0.5,
  maxHistoryPerWorkflow: 50,
  maxRatchetDecisionsPerWorkflow: 30,
  regressionDeclineThreshold: 8,
  promotionMinScore: 88,
  promotionMinConfidence: 0.65,
};

export const RUN_EVALUATION_JUDGMENTS = Object.freeze({
  ACCEPT: "ACCEPT",
  RETRY: "RETRY",
  ESCALATE: "ESCALATE",
});

function computeGrade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

function roundMetric(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function buildRunEvaluationJudgment({ metrics = {}, issues = [], remediation = {}, governance = null }) {
  const failedNodes = Number(metrics?.failedNodes || 0);
  const hasRuntimeErrors = issues.some((issue) => String(issue?.severity ?? "").trim().toLowerCase() === "error");
  if (governance?.approvalPending === true) {
    return {
      decision: RUN_EVALUATION_JUDGMENTS.ESCALATE,
      reason: "governance.approval_pending",
      summary: "Run requires operator approval before it can continue.",
      retryMode: null,
      operatorRequired: true,
      blocked: true,
    };
  }
  if (governance?.blocked === true) {
    return {
      decision: RUN_EVALUATION_JUDGMENTS.ESCALATE,
      reason: "governance.blocked",
      summary: "Run is blocked by budget or execution policy constraints.",
      retryMode: null,
      operatorRequired: false,
      blocked: true,
    };
  }
  if ((remediation?.canAutoRetry === true && remediation?.suggestedRetryMode)
    || (failedNodes > 0 && remediation?.canAutoFix === true)) {
    return {
      decision: RUN_EVALUATION_JUDGMENTS.RETRY,
      reason: remediation?.retryReason || (remediation?.canAutoFix ? "remediation.auto_fixable" : "remediation.auto_retry"),
      summary: remediation?.summary || "Run can be retried with automated remediation.",
      retryMode: remediation?.suggestedRetryMode || null,
      operatorRequired: false,
      blocked: false,
    };
  }
  if (failedNodes > 0 || hasRuntimeErrors) {
    return {
      decision: RUN_EVALUATION_JUDGMENTS.ESCALATE,
      reason: "run.manual_review_required",
      summary: remediation?.summary || "Run requires manual review before another attempt.",
      retryMode: remediation?.suggestedRetryMode || null,
      operatorRequired: false,
      blocked: false,
    };
  }
  return {
    decision: RUN_EVALUATION_JUDGMENTS.ACCEPT,
    reason: "run.accepted",
    summary: "Run output accepted.",
    retryMode: null,
    operatorRequired: false,
    blocked: false,
  };
}

function trimText(value, maxLength = 220) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeTraceEvents(detail = {}) {
  const events = Array.isArray(detail?.data?._taskWorkflowEvents)
    ? detail.data._taskWorkflowEvents
    : [];
  return events.filter((event) => event && typeof event === "object");
}

function cleanGovernanceObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function normalizeGovernanceText(value, maxLength = 220) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeGovernanceInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.trunc(parsed);
  return Math.max(min, Math.min(max, rounded));
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
      const goalId = normalizeGovernanceText(
        entry.goalId || entry.id || entry.goal?.id || entry.goal?.goalId || "",
        160,
      );
      const title = normalizeGovernanceText(
        entry.title || entry.goalTitle || entry.name || entry.goal?.title || entry.goal?.name || "",
        240,
      );
      const depth = normalizeGovernanceInteger(entry.depth ?? index, { min: 0, max: 1_000 });
      if (!goalId && !title) return null;
      return cleanGovernanceObject({
        goalId: goalId || null,
        title: title || null,
        parentGoalId: normalizeGovernanceText(entry.parentGoalId || entry.parentId || "", 160) || null,
        kind: normalizeGovernanceText(entry.kind || entry.type || "", 80) || null,
        status: normalizeGovernanceText(entry.status || "", 80) || null,
        source: normalizeGovernanceText(entry.source || "", 120) || null,
        depth,
      });
    })
    .filter(Boolean);
  if (normalized.length > 0) return normalized;

  if (!fallbackGoal || typeof fallbackGoal !== "object") return [];
  const fallbackGoalId = normalizeGovernanceText(fallbackGoal.goalId || fallbackGoal.id || "", 160);
  const fallbackTitle = normalizeGovernanceText(fallbackGoal.title || fallbackGoal.name || "", 240);
  if (!fallbackGoalId && !fallbackTitle) return [];
  return [cleanGovernanceObject({
    goalId: fallbackGoalId || null,
    title: fallbackTitle || null,
    kind: normalizeGovernanceText(fallbackGoal.kind || fallbackGoal.type || "", 80) || null,
    status: normalizeGovernanceText(fallbackGoal.status || "", 80) || null,
    source: normalizeGovernanceText(fallbackGoal.source || "", 120) || null,
    depth: 0,
  })];
}

function buildGoalState(data = {}) {
  const primaryGoalSource =
    data?.primaryGoal ||
    data?._primaryGoal ||
    data?.goal ||
    data?._goal ||
    null;
  const goalAncestry = normalizeGoalAncestry(
    data?.goalAncestry || data?._goalAncestry || data?.workflowGoalAncestry || data?._workflowGoalAncestry,
    primaryGoalSource,
  );
  const primaryGoal = goalAncestry.at(-1) || null;
  return {
    goalAncestry,
    primaryGoalId: primaryGoal?.goalId || normalizeGovernanceText(data?.primaryGoalId || data?._primaryGoalId || "", 160) || null,
    primaryGoalTitle: primaryGoal?.title || normalizeGovernanceText(data?.primaryGoalTitle || data?._primaryGoalTitle || "", 240) || null,
    goalDepth: primaryGoal
      ? normalizeGovernanceInteger(primaryGoal.depth, { min: 0, max: 1_000 }) ?? Math.max(goalAncestry.length - 1, 0)
      : null,
  };
}

function normalizeSuccessCriteria(raw, fallbackAcceptanceCriteria = []) {
  const source = Array.isArray(raw)
    ? raw
    : (Array.isArray(fallbackAcceptanceCriteria) ? fallbackAcceptanceCriteria : []);
  return source
    .map((entry, index) => {
      if (typeof entry === "string") {
        const title = normalizeGovernanceText(entry, 240);
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
      const id = normalizeGovernanceText(entry.id || entry.criterionId || entry.key || `criterion-${index + 1}`, 120);
      const title = normalizeGovernanceText(entry.title || entry.name || entry.criterion || entry.description || "", 240);
      const description = normalizeGovernanceText(entry.description || entry.detail || entry.summary || "", 320) || "";
      const rawStatus = String(entry.status || "").trim().toLowerCase();
      const status = ["pending", "in_progress", "partial", "satisfied", "failed", "waived", "blocked"].includes(rawStatus)
        ? rawStatus
        : (entry.satisfied === true ? "satisfied" : "pending");
      return cleanGovernanceObject({
        id: id || `criterion-${index + 1}`,
        title: title || description || id || `criterion-${index + 1}`,
        description,
        status,
        blocking: entry.blocking === true || entry.required === true || entry.optional === false,
      });
    })
    .filter(Boolean);
}

function normalizeConstraintState(raw = {}) {
  if (!raw) return null;
  const source = Array.isArray(raw) ? { violations: raw } : (typeof raw === "object" ? raw : null);
  if (!source) return null;
  const violations = Array.isArray(source.violations || source.items || source.constraintViolations)
    ? (source.violations || source.items || source.constraintViolations)
      .map((entry, index) => {
        const ruleId = normalizeGovernanceText(entry?.constraintId || entry?.ruleId || entry?.id || `constraint-${index + 1}`, 120);
        const message = normalizeGovernanceText(entry?.message || entry?.reason || entry?.description || "", 320);
        if (!ruleId && !message) return null;
        return cleanGovernanceObject({
          constraintId: ruleId || `constraint-${index + 1}`,
          type: normalizeGovernanceText(entry?.type || entry?.kind || "constraint", 80) || "constraint",
          severity: normalizeGovernanceText(entry?.severity || "", 40) || ((entry?.blocking === true || entry?.blocked === true) ? "error" : "warning"),
          status: normalizeGovernanceText(entry?.status || "", 40) || ((entry?.blocking === true || entry?.blocked === true) ? "blocked" : "open"),
          message: message || null,
          blocking: entry?.blocking === true || entry?.blocked === true,
        });
      })
      .filter(Boolean)
    : [];
  const blockingViolationCount = violations.filter((entry) => entry?.blocking === true).length;
  const violationCount = violations.length;
  const blocked = source.blocked === true || blockingViolationCount > 0;
  const approvalPending = source.approvalPending === true || normalizeGovernanceText(source.approvalState || "", 40) === "pending";
  const status = normalizeGovernanceText(source.status || "", 40) || (blocked ? "blocked" : (violationCount > 0 ? "warning" : "ok"));
  if (violationCount === 0 && !blocked && !approvalPending && !status) return null;
  return cleanGovernanceObject({
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
  const budgetTokens = normalizeGovernanceInteger(raw.budgetTokens ?? raw.limitTokens ?? raw.maxTokens, { min: 0 });
  const inputTokens = normalizeGovernanceInteger(raw.inputTokens, { min: 0 }) ?? 0;
  const outputTokens = normalizeGovernanceInteger(raw.outputTokens, { min: 0 }) ?? 0;
  const totalTokens = normalizeGovernanceInteger(raw.totalTokens ?? (inputTokens + outputTokens), { min: 0 });
  const reservedTokens = normalizeGovernanceInteger(raw.reservedTokens, { min: 0 }) ?? 0;
  const remainingTokens = normalizeGovernanceInteger(
    raw.remainingTokens ?? (budgetTokens != null ? budgetTokens - (totalTokens || 0) - reservedTokens : null),
    { min: Number.MIN_SAFE_INTEGER },
  );
  const utilizationRatio = budgetTokens && budgetTokens > 0
    ? clamp01(((totalTokens || 0) + reservedTokens) / budgetTokens)
    : null;
  const exceeded = budgetTokens != null ? ((totalTokens || 0) + reservedTokens) > budgetTokens : false;
  const nearLimitThresholdTokens = normalizeGovernanceInteger(raw.nearLimitThresholdTokens ?? raw.warningTokens, { min: 0 });
  const nearLimit = !exceeded && budgetTokens != null
    ? (
        (nearLimitThresholdTokens != null && remainingTokens != null && remainingTokens <= nearLimitThresholdTokens)
        || ((utilizationRatio ?? 0) >= 0.9)
      )
    : false;
  const status = normalizeGovernanceText(raw.status || "", 40) || (exceeded ? "exceeded" : (nearLimit ? "near_limit" : "ok"));
  if (budgetTokens == null && totalTokens == null && !status) return null;
  return cleanGovernanceObject({
    status,
    budgetTokens,
    inputTokens,
    outputTokens,
    totalTokens,
    reservedTokens,
    remainingTokens,
    utilizationRatio: utilizationRatio != null ? roundMetric(utilizationRatio) : null,
    nearLimit,
    exceeded,
    approvalRequired: raw.approvalRequired === true,
  });
}

function normalizeGoalProgress(raw = {}, successCriteria = []) {
  const source = raw && typeof raw === "object" ? raw : {};
  const completedCriteriaCount = normalizeGovernanceInteger(source.completedCriteriaCount, { min: 0 })
    ?? successCriteria.filter((entry) => ["satisfied", "waived"].includes(entry.status)).length;
  const totalCriteriaCount = normalizeGovernanceInteger(source.totalCriteriaCount, { min: 0 })
    ?? successCriteria.length;
  const completionRatio = clamp01(
    source.completionRatio ?? (totalCriteriaCount > 0 ? completedCriteriaCount / totalCriteriaCount : 0),
  );
  const status = normalizeGovernanceText(source.status || "", 40)
    || (completionRatio === 1 ? "satisfied" : (completionRatio > 0 ? "partial" : "pending"));
  if (!status && totalCriteriaCount === 0 && !normalizeGovernanceText(source.summary || "", 320)) return null;
  return cleanGovernanceObject({
    status,
    summary: normalizeGovernanceText(source.summary || "", 320) || null,
    completedCriteriaCount,
    totalCriteriaCount,
    completionRatio: roundMetric(completionRatio),
  });
}

function buildObjectiveFrame(data = {}) {
  const successCriteria = normalizeSuccessCriteria(
    data?.successCriteria || data?._successCriteria || data?.criteria,
    data?.acceptanceCriteria || data?._acceptanceCriteria,
  );
  const goalProgress = normalizeGoalProgress(data?.goalProgress || data?._goalProgress, successCriteria);
  const constraintState = normalizeConstraintState(data?.constraintState || data?._constraintState || data?.constraints);
  const tokenBudget = normalizeTokenBudget(data?.tokenBudget || data?._tokenBudget);
  const blocked = constraintState?.blocked === true
    || constraintState?.approvalPending === true
    || tokenBudget?.status === "exceeded";
  if (successCriteria.length === 0 && !goalProgress && !constraintState && !tokenBudget) return null;
  return cleanGovernanceObject({
    successCriteria,
    goalProgress,
    constraintState,
    tokenBudget,
    blocked,
  });
}

function normalizeHeartbeatRun(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const runId = normalizeGovernanceText(raw.runId || raw.heartbeatRunId || raw.id || "", 160);
  const status = normalizeGovernanceText(raw.status || raw.state || "", 80);
  const sourceRunId = normalizeGovernanceText(raw.sourceRunId || raw.parentRunId || raw.originRunId || "", 160);
  const wakeAt = normalizeGovernanceText(raw.wakeAt || raw.resumeAt || raw.nextWakeAt || "", 80);
  const lastHeartbeatAt = normalizeGovernanceText(raw.lastHeartbeatAt || raw.heartbeatAt || raw.lastSeenAt || "", 80);
  const attempt = normalizeGovernanceInteger(raw.attempt ?? raw.retryCount, { min: 0, max: 10_000 });
  if (!runId && !status && !sourceRunId && !wakeAt && !lastHeartbeatAt && attempt == null) return null;
  return cleanGovernanceObject({
    runId: runId || null,
    status: status || null,
    sourceRunId: sourceRunId || null,
    wakeAt: wakeAt || null,
    lastHeartbeatAt: lastHeartbeatAt || null,
    trigger: normalizeGovernanceText(raw.trigger || raw.reason || "", 160) || null,
    attempt,
  });
}

function normalizeWakeupRequest(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const requestId = normalizeGovernanceText(raw.requestId || raw.id || raw.wakeupRequestId || "", 160);
  const source = normalizeGovernanceText(raw.source || raw.reason || raw.trigger || "", 160);
  const requestedAt = normalizeGovernanceText(raw.requestedAt || raw.createdAt || "", 80);
  const wakeAt = normalizeGovernanceText(raw.wakeAt || raw.resumeAt || raw.scheduledFor || "", 80);
  if (!requestId && !source && !requestedAt && !wakeAt) return null;
  return cleanGovernanceObject({
    requestId: requestId || null,
    source: source || null,
    requestedAt: requestedAt || null,
    wakeAt: wakeAt || null,
    taskId: normalizeGovernanceText(raw.taskId || "", 160) || null,
    sessionId: normalizeGovernanceText(raw.sessionId || raw.threadId || "", 160) || null,
  });
}

function normalizeBudgetPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const budgetCents = normalizeGovernanceInteger(raw.budgetCents ?? raw.limitCents ?? raw.limit, { min: 0 });
  const spentCents = normalizeGovernanceInteger(raw.spentCents ?? raw.usedCents ?? raw.actualCents ?? raw.spent, { min: 0 });
  const reservedCents = normalizeGovernanceInteger(raw.reservedCents ?? raw.pendingCents, { min: 0 });
  const remainingCents = normalizeGovernanceInteger(
    raw.remainingCents ?? (budgetCents != null ? budgetCents - (spentCents || 0) - (reservedCents || 0) : null),
  );
  if (budgetCents == null && spentCents == null && reservedCents == null && remainingCents == null) return null;
  return cleanGovernanceObject({
    budgetCents,
    spentCents: spentCents ?? 0,
    reservedCents: reservedCents ?? 0,
    remainingCents,
    nearLimitThresholdCents: normalizeGovernanceInteger(raw.nearLimitThresholdCents ?? raw.warningCents, { min: 0 }),
    currency: normalizeGovernanceText(raw.currency || "USD", 16) || "USD",
    approvalRequired: raw.approvalRequired === true,
    owner: normalizeGovernanceText(raw.owner || raw.team || "", 160) || null,
  });
}

function buildBudgetOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const budgetCents = normalizeGovernanceInteger(policy.budgetCents, { min: 0 });
  const spentCents = normalizeGovernanceInteger(policy.spentCents, { min: 0 }) ?? 0;
  const reservedCents = normalizeGovernanceInteger(policy.reservedCents, { min: 0 }) ?? 0;
  const effectiveSpend = spentCents + reservedCents;
  const remainingCents = normalizeGovernanceInteger(
    policy.remainingCents ?? (budgetCents != null ? budgetCents - effectiveSpend : null),
  );
  const utilizationRatio = budgetCents && budgetCents > 0
    ? Math.max(0, Number((effectiveSpend / budgetCents).toFixed(3)))
    : 0;
  const nearLimitThreshold = normalizeGovernanceInteger(policy.nearLimitThresholdCents, { min: 0 });
  const exceeded = budgetCents != null ? effectiveSpend > budgetCents : false;
  const nearLimit = !exceeded && budgetCents != null
    ? (
        (nearLimitThreshold != null && remainingCents != null && remainingCents <= nearLimitThreshold) ||
        utilizationRatio >= 0.9
      )
    : false;
  return cleanGovernanceObject({
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
  const ruleId = normalizeGovernanceText(entry.ruleId || entry.id || `${index}`, 160);
  const message = normalizeGovernanceText(entry.message || entry.reason || entry.summary || "", 260);
  if (!ruleId && !message) return null;
  return cleanGovernanceObject({
    ruleId: ruleId || null,
    message: message || null,
    severity: normalizeGovernanceText(entry.severity || "warning", 40) || "warning",
    blocking: entry.blocking === true || entry.blocked === true,
    nodeId: normalizeGovernanceText(entry.nodeId || "", 160) || null,
  });
}

function normalizeExecutionPolicy(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const violations = Array.isArray(raw.violations)
    ? raw.violations.map((entry, index) => normalizePolicyViolation(entry, index)).filter(Boolean)
    : [];
  const blocked = raw.blocked === true || raw.requiresApproval === true && raw.approvalState === "pending";
  if (violations.length === 0 && !blocked && !raw.approvalRequired && !raw.approvalState && !raw.mode) return null;
  return cleanGovernanceObject({
    mode: normalizeGovernanceText(raw.mode || raw.policyMode || "", 80) || null,
    blocked,
    approvalRequired: raw.approvalRequired === true || raw.requiresApproval === true,
    approvalState: normalizeGovernanceText(raw.approvalState || raw.state || "", 80) || null,
    violations,
  });
}

function buildPolicyOutcome(policy = null) {
  if (!policy || typeof policy !== "object") return null;
  const violations = Array.isArray(policy.violations) ? policy.violations : [];
  const blockingViolationCount = violations.filter((entry) => entry?.blocking === true).length;
  const violationCount = violations.length;
  const blocked = policy.blocked === true || blockingViolationCount > 0;
  return cleanGovernanceObject({
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
  const budgetOutcome = buildBudgetOutcome(budgetPolicy);
  const policyOutcome = buildPolicyOutcome(executionPolicy);
  const objectiveFrame = buildObjectiveFrame(raw?.objectiveFrame || raw?._objectiveFrame || raw);
  const approvalPending =
    (executionPolicy?.approvalRequired === true && (!executionPolicy?.approvalState || executionPolicy.approvalState === "pending")) ||
    (budgetPolicy?.approvalRequired === true && ["exceeded", "near_limit"].includes(budgetOutcome?.status || ""));
  return cleanGovernanceObject({
    ...goalState,
    heartbeatRun,
    wakeupRequest,
    budgetPolicy,
    executionPolicy,
    budgetOutcome,
    policyOutcome,
    successCriteria: objectiveFrame?.successCriteria || [],
    goalProgress: objectiveFrame?.goalProgress || null,
    constraintState: objectiveFrame?.constraintState || null,
    tokenBudget: objectiveFrame?.tokenBudget || null,
    objectiveFrame,
    approvalPending,
    blocked: policyOutcome?.blocked === true || budgetOutcome?.status === "exceeded" || objectiveFrame?.blocked === true,
  });
}

function extractRunGovernance(runDetail, detail) {
  return extractGovernanceState({
    ...(runDetail && typeof runDetail === "object" ? runDetail : {}),
    ...(runDetail?.ledger && typeof runDetail.ledger === "object" ? runDetail.ledger : {}),
    ...(detail && typeof detail === "object" ? detail : {}),
    ...(detail?.data && typeof detail.data === "object" ? detail.data : {}),
  });
}

function formatBudgetCents(value, currency = "USD") {
  if (!Number.isFinite(Number(value))) return null;
  return `${currency} ${(Number(value) / 100).toFixed(2)}`;
}

function inferIssueCategory(issue = {}) {
  const text = `${issue?.message || ""} ${issue?.suggestion || ""}`.toLowerCase();
  if (/budget|approval|policy|guardrail|violation|governance|blocked/.test(text)) return "governance";
  if (/timeout|slow|latency|batching|optimi[sz]e/.test(text)) return "performance";
  if (/permission|credential|forbidden|unauthorized|access/.test(text)) return "permissions";
  if (/config|path|resource|not found|does not exist|verify/.test(text)) return "configuration";
  if (/retry|transient|backoff/.test(text)) return "reliability";
  if (/replan|workflow|resume|step/.test(text)) return "workflow";
  return "quality";
}

function inferStrategyAction(issue = {}, remediationAction = null) {
  const type = String(remediationAction?.type || "").trim().toLowerCase();
  if (type === "request_budget_approval") return "request_budget_approval";
  if (type === "review_budget") return "review_budget_headroom";
  if (type === "request_execution_approval") return "request_execution_approval";
  if (type === "resolve_policy_violation") return "resolve_policy_violation";
  if (type === "increase_timeout") return "tune_timeout";
  if (type === "tune_retry_policy") return "tune_retry_policy";
  if (type === "check_config") return "tighten_configuration_validation";
  if (type === "check_permissions") return "verify_permissions";
  if (type === "replan_workflow") return "replan_downstream_graph";
  if (type === "inspect_failure") return "inspect_before_retry";
  const category = inferIssueCategory(issue);
  if (category === "governance") return "resolve_governance_block";
  if (category === "performance") return "split_or_batch_work";
  if (category === "configuration") return "tighten_configuration_validation";
  if (category === "permissions") return "verify_permissions";
  if (category === "workflow") return "replan_downstream_graph";
  if (category === "reliability") return "tune_retry_policy";
  return "review_failure_mode";
}

function computeStrategyConfidence({ score, metrics, issueSeverity = "warning", traceCoverage = 0, trend = null }) {
  let confidence = 0.45;
  confidence += clamp01(score / 100) * 0.25;
  confidence += clamp01(1 - (metrics?.errorRate || 0)) * 0.15;
  confidence += clamp01(traceCoverage) * 0.1;
  if (issueSeverity === "error") confidence += 0.08;
  if (trend?.trend === "declining") confidence += 0.08;
  if ((metrics?.failedNodes || 0) === 1) confidence += 0.06;
  return roundMetric(clamp01(confidence), 3);
}

function buildStrategyId(workflowId, action, nodeId, category) {
  const base = [workflowId || "workflow", action || "strategy", nodeId || "global", category || "general"]
    .filter(Boolean)
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-");
  return base.slice(0, 120);
}

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRatchetSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const runId = String(snapshot.runId || "").trim();
  if (!runId) return null;
  return {
    runId,
    workflowId: String(snapshot.workflowId || "").trim() || null,
    score: Number.isFinite(Number(snapshot.score)) ? Number(snapshot.score) : 0,
    grade: String(snapshot.grade || "").trim() || "F",
    timestamp: String(snapshot.timestamp || "").trim() || new Date().toISOString(),
    strategyId: String(snapshot.strategyId || snapshot.strategy?.strategyId || "").trim() || null,
    strategy: snapshot.strategy && typeof snapshot.strategy === "object" ? cloneJson(snapshot.strategy) : null,
    benchmark: snapshot.benchmark && typeof snapshot.benchmark === "object" ? cloneJson(snapshot.benchmark) : null,
    metrics: snapshot.metrics && typeof snapshot.metrics === "object" ? cloneJson(snapshot.metrics) : null,
    promotionDecision: String(snapshot.promotionDecision || "").trim() || null,
    knowledge: snapshot.knowledge && typeof snapshot.knowledge === "object" ? cloneJson(snapshot.knowledge) : null,
  };
}

function normalizeRatchetState(raw = {}) {
  const decisions = Array.isArray(raw?.decisions)
    ? raw.decisions
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => cloneJson(entry))
    : [];
  return {
    activeBaseline: normalizeRatchetSnapshot(raw?.activeBaseline),
    previousBaseline: normalizeRatchetSnapshot(raw?.previousBaseline),
    lastDecision: raw?.lastDecision && typeof raw.lastDecision === "object" ? cloneJson(raw.lastDecision) : null,
    decisions,
  };
}

// ── RunEvaluator ────────────────────────────────────────────────────────────

export class RunEvaluator {
  #config;
  #historyPath = null;
  /** @type {Map<string, Array<{ runId: string, score: number, grade: string, timestamp: string }>>} */
  #history = new Map();
  #ratchet = new Map();
  #autoTriggerEngine = null;

  /**
   * @param {object} [opts] — override any default penalty / threshold
   * @param {string} [opts.configDir] — enables evaluation history persistence
   * @param {number} [opts.penaltyFailedNode]
   * @param {number} [opts.penaltyRetriedNode]
   * @param {number} [opts.penaltySkippedNode]
   * @param {number} [opts.penaltySlowRunMs]
   * @param {number} [opts.penaltySlowRun]
   * @param {number} [opts.penaltySlowNodeMs]
   * @param {number} [opts.penaltySlowNode]
   * @param {number} [opts.penaltyHighErrorRate]
   * @param {number} [opts.highErrorRateThreshold]
   * @param {number} [opts.maxHistoryPerWorkflow]
   */
  constructor(opts = {}) {
    this.#config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (opts[key] !== undefined && typeof opts[key] === "number") {
        this.#config[key] = opts[key];
      }
    }
    if (opts.configDir) {
      const bosunDir = resolve(opts.configDir, ".bosun");
      this.#historyPath = resolve(bosunDir, "evaluation-history.json");
      this.#loadHistory();
    }
  }

  /**
   * Attach to a workflow engine for auto-triggered evaluation.
   * Listens to `run:complete` events and evaluates automatically.
   *
   * @param {object} engine — must expose `.on(event, handler)` and `.getRunDetail(runId)`
   * @returns {void}
   */
  attachToEngine(engine) {
    if (!engine?.on || !engine?.getRunDetail) return;
    this.#autoTriggerEngine = engine;
    engine.on("run:complete", (evt) => {
      try {
        const detail = engine.getRunDetail(evt?.runId);
        if (detail) {
          this.evaluate(detail, {
            workflowId: evt?.workflowId || detail?.workflowId || detail?.detail?.data?._workflowId || "unknown",
            runId: evt?.runId || null,
            recordHistory: true,
          });
        }
      } catch (err) {
        console.warn(`${TAG} auto-evaluation failed: ${err?.message || err}`);
      }
    });
  }

  /**
   * Evaluate a completed/failed run and return quality metrics + remediation.
   *
   * @param {object} runDetail - The run detail object (from engine.getRunDetail())
   * @returns {{ score: number, grade: string, issues: Array, metrics: object, remediation: object }}
   */
  evaluate(runDetail, options = {}) {
    if (!runDetail) {
      return this._emptyResult("No run detail provided");
    }

    const detail = runDetail.detail || runDetail;
    const nodeStatuses = detail.nodeStatuses || {};
    const nodeOutputs = detail.nodeOutputs || {};
    const retryAttempts = detail.retryAttempts || {};
    const errors = Array.isArray(detail.errors) ? detail.errors : [];
    const nodeTimings = detail.nodeTimings || {};
    const workflowId = String(
      options.workflowId ||
      runDetail.workflowId ||
      detail?.data?._workflowId ||
      "unknown",
    ).trim() || "unknown";
    const evaluationTimestamp = this._resolveHistoryTimestamp(runDetail, detail);
    const traceEvents = normalizeTraceEvents(detail);
    const trend = options.includeTrend === false ? null : this.getTrend(workflowId);
    const governance = extractRunGovernance(runDetail, detail);

    // ── Compute metrics ───────────────────────────────────────────────
    const totalDurationMs = Number.isFinite(detail.duration)
      ? detail.duration
      : (detail.startedAt && detail.endedAt
          ? Math.max(0, detail.endedAt - detail.startedAt)
          : 0);

    let failedNodes = 0;
    let completedNodes = 0;
    let skippedNodes = 0;
    let retriedNodes = 0;
    let totalNodeCount = 0;
    let slowestNode = { nodeId: null, durationMs: 0 };
    let totalNodeDurationMs = 0;
    const nodeDurations = {};

    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      totalNodeCount++;
      if (status === "completed") completedNodes++;
      if (status === "failed") failedNodes++;
      if (status === "skipped") skippedNodes++;

      const retries = Number(retryAttempts[nodeId]) || 0;
      if (retries > 0) retriedNodes++;

      const timing = nodeTimings[nodeId];
      if (timing?.startedAt && timing?.endedAt) {
        const dur = Math.max(0, timing.endedAt - timing.startedAt);
        nodeDurations[nodeId] = dur;
        totalNodeDurationMs += dur;
        if (dur > slowestNode.durationMs) {
          slowestNode = { nodeId, durationMs: dur };
        }
      }
    }

    const avgNodeDurationMs = totalNodeCount > 0
      ? Math.round(totalNodeDurationMs / totalNodeCount)
      : 0;
    const executedNodes = completedNodes + failedNodes;
    const errorRate = executedNodes > 0 ? failedNodes / executedNodes : 0;

    const metrics = {
      totalDurationMs,
      avgNodeDurationMs,
      slowestNode: slowestNode.nodeId ? slowestNode : null,
      failedNodes,
      completedNodes,
      retriedNodes,
      skippedNodes,
      totalNodeCount,
      errorRate: roundMetric(errorRate),
      goalDepth: governance?.goalDepth ?? null,
      goalAncestryCount: Array.isArray(governance?.goalAncestry) ? governance.goalAncestry.length : 0,
      budgetStatus: governance?.budgetOutcome?.status || null,
      policyStatus: governance?.policyOutcome?.status || null,
      governanceBlocked: governance?.blocked === true,
      approvalPending: governance?.approvalPending === true,
      policyViolationCount: governance?.policyOutcome?.violationCount ?? 0,
      blockingViolationCount: governance?.policyOutcome?.blockingViolationCount ?? 0,
      successCriteriaCount: Array.isArray(governance?.successCriteria) ? governance.successCriteria.length : 0,
      completedCriteriaCount: governance?.goalProgress?.completedCriteriaCount ?? 0,
      goalProgressStatus: governance?.goalProgress?.status || null,
      goalCompletionRatio: governance?.goalProgress?.completionRatio ?? null,
      constraintStatus: governance?.constraintState?.status || null,
      constraintViolationCount: governance?.constraintState?.violationCount ?? 0,
      blockingConstraintViolationCount: governance?.constraintState?.blockingViolationCount ?? 0,
      tokenBudgetStatus: governance?.tokenBudget?.status || null,
      tokenUtilizationRatio: governance?.tokenBudget?.utilizationRatio ?? null,
      totalTokens: governance?.tokenBudget?.totalTokens ?? 0,
    };

    // ── Compute score ─────────────────────────────────────────────────
    let score = 100;
    const issues = [];

    // Penalty: failed nodes
    if (failedNodes > 0) {
      const penalty = failedNodes * this.#config.penaltyFailedNode;
      score -= penalty;
      for (const [nodeId, status] of Object.entries(nodeStatuses)) {
        if (status === "failed") {
          const nodeErrors = errors.filter((e) => e.nodeId === nodeId);
          const errMsg = nodeErrors.length > 0 ? nodeErrors[0].error : "Unknown error";
          issues.push({
            severity: "error",
            nodeId,
            message: `Node failed: ${errMsg}`,
            suggestion: this._suggestFixForError(errMsg),
          });
        }
      }
    }

    // Penalty: retried nodes
    if (retriedNodes > 0) {
      const penalty = retriedNodes * this.#config.penaltyRetriedNode;
      score -= penalty;
      for (const [nodeId, count] of Object.entries(retryAttempts)) {
        if (Number(count) > 0) {
          issues.push({
            severity: "warning",
            nodeId,
            message: `Node required ${count} retries`,
            suggestion: "Check for transient failures or increase retry delay",
          });
        }
      }
    }

    // Penalty: skipped nodes
    if (skippedNodes > 0) {
      score -= skippedNodes * this.#config.penaltySkippedNode;
    }

    // Penalty: slow total duration
    if (totalDurationMs > this.#config.penaltySlowRunMs) {
      score -= this.#config.penaltySlowRun;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Run took ${Math.round(totalDurationMs / 1000)}s (>${Math.round(this.#config.penaltySlowRunMs / 1000)}s threshold)`,
        suggestion: "Consider optimising slow nodes or splitting workflow",
      });
    }

    // Penalty: any single node > threshold
    if (slowestNode.durationMs > this.#config.penaltySlowNodeMs) {
      score -= this.#config.penaltySlowNode;
      issues.push({
        severity: "warning",
        nodeId: slowestNode.nodeId,
        message: `Slowest node took ${Math.round(slowestNode.durationMs / 1000)}s`,
        suggestion: "Consider adding a timeout or batching work",
      });
    }

    // Penalty: high error rate
    if (errorRate > this.#config.highErrorRateThreshold) {
      score -= this.#config.penaltyHighErrorRate;
      issues.push({
        severity: "error",
        nodeId: null,
        message: `Error rate is ${Math.round(errorRate * 100)}% (>${Math.round(this.#config.highErrorRateThreshold * 100)}% threshold)`,
        suggestion: "Review workflow design — most nodes are failing",
      });
    }

    if (governance?.budgetOutcome?.status === "exceeded") {
      score -= 15;
      issues.push({
        severity: "error",
        nodeId: null,
        message: `Workflow budget exceeded (${formatBudgetCents(governance.budgetPolicy?.spentCents, governance.budgetPolicy?.currency)} spent${Number(governance.budgetPolicy?.reservedCents || 0) > 0 ? ` + ${formatBudgetCents(governance.budgetPolicy?.reservedCents, governance.budgetPolicy?.currency)} reserved` : ""} vs ${formatBudgetCents(governance.budgetPolicy?.budgetCents, governance.budgetPolicy?.currency)} budget).`,
        suggestion: governance?.budgetPolicy?.approvalRequired
          ? "Request budget approval or reduce scope before retrying"
          : "Reduce workflow scope or split the run into smaller phases",
      });
    } else if (governance?.budgetOutcome?.status === "near_limit") {
      score -= 4;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Workflow budget is near limit (${formatBudgetCents(governance.budgetPolicy?.remainingCents, governance.budgetPolicy?.currency)} remaining).`,
        suggestion: governance?.budgetPolicy?.approvalRequired
          ? "Request approval before the next expensive retry"
          : "Trim scope or checkpoint progress before continuing",
      });
    }

    if (governance?.policyOutcome?.blocked === true) {
      score -= 15;
      issues.push({
        severity: "error",
        nodeId: null,
        message: governance?.approvalPending
          ? "Execution policy is blocked pending approval."
          : `Execution policy blocked the run${governance.executionPolicy?.mode ? ` (${governance.executionPolicy.mode})` : ""}.`,
        suggestion: governance?.approvalPending
          ? "Obtain the required approval before retrying"
          : "Resolve blocking policy violations before continuing",
      });
    } else if ((governance?.policyOutcome?.violationCount || 0) > 0) {
      score -= Math.min(6, (governance.policyOutcome.violationCount || 0) * 2);
    }

    if (Array.isArray(governance?.executionPolicy?.violations)) {
      for (const violation of governance.executionPolicy.violations) {
        issues.push({
          severity: violation?.blocking ? "error" : "warning",
          nodeId: violation?.nodeId || null,
          message: violation?.message
            ? `Policy violation (${violation.ruleId || "rule"}): ${violation.message}`
            : `Policy violation (${violation.ruleId || "rule"})`,
          suggestion: violation?.blocking
            ? "Resolve the blocking policy violation before retrying"
            : "Review the policy warning before promotion",
        });
      }
    }

    const incompleteBlockingCriteria = Array.isArray(governance?.successCriteria)
      ? governance.successCriteria.filter((criterion) => (
        criterion?.blocking === true
        && !["satisfied", "waived"].includes(String(criterion?.status || "").trim().toLowerCase())
      ))
      : [];
    if (incompleteBlockingCriteria.length > 0) {
      score -= Math.min(12, incompleteBlockingCriteria.length * 4);
      for (const criterion of incompleteBlockingCriteria.slice(0, 8)) {
        issues.push({
          severity: "error",
          nodeId: null,
          message: `Blocking success criterion incomplete: ${criterion.title || criterion.id || "criterion"}`,
          suggestion: "Finish the required success criterion or explicitly waive it before promotion",
        });
      }
    } else if (
      (Array.isArray(governance?.successCriteria) && governance.successCriteria.length > 0)
      && governance?.goalProgress?.completionRatio != null
      && governance.goalProgress.completionRatio < 1
    ) {
      score -= 3;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Goal progress is only ${Math.round(governance.goalProgress.completionRatio * 100)}% complete.`,
        suggestion: "Review the remaining success criteria before promotion",
      });
    }

    if (governance?.constraintState?.blocked === true) {
      score -= 12;
      issues.push({
        severity: "error",
        nodeId: null,
        message: "Constraint state is blocked and must be resolved before the run can be accepted.",
        suggestion: governance?.constraintState?.approvalPending === true
          ? "Obtain the required approval before retrying"
          : "Resolve blocking constraint violations before continuing",
      });
    } else if ((governance?.constraintState?.violationCount || 0) > 0) {
      score -= Math.min(8, (governance.constraintState.violationCount || 0) * 2);
      for (const violation of governance.constraintState.violations.slice(0, 8)) {
        issues.push({
          severity: violation?.blocking ? "error" : "warning",
          nodeId: null,
          message: violation?.message
            ? `Constraint violation (${violation.constraintId || "constraint"}): ${violation.message}`
            : `Constraint violation (${violation.constraintId || "constraint"})`,
          suggestion: violation?.blocking
            ? "Resolve the blocking constraint before retrying"
            : "Review the constraint warning before promotion",
        });
      }
    }

    if (governance?.tokenBudget?.status === "exceeded") {
      score -= 10;
      issues.push({
        severity: "error",
        nodeId: null,
        message: `Token budget exceeded (${governance.tokenBudget.totalTokens || 0} used${governance.tokenBudget.budgetTokens != null ? ` vs ${governance.tokenBudget.budgetTokens} budget` : ""}).`,
        suggestion: governance?.tokenBudget?.approvalRequired
          ? "Request additional token budget or reduce scope before retrying"
          : "Reduce scope or checkpoint progress before continuing",
      });
    } else if (governance?.tokenBudget?.status === "near_limit") {
      score -= 4;
      issues.push({
        severity: "warning",
        nodeId: null,
        message: `Token budget is near limit (${governance.tokenBudget.remainingTokens ?? 0} remaining).`,
        suggestion: "Checkpoint progress and trim additional work before the next retry",
      });
    }

    score = Math.max(0, Math.min(100, score));
    const grade = computeGrade(score);

    // ── Remediation ───────────────────────────────────────────────────
    const remediation = this._buildRemediation(runDetail, detail, nodeStatuses, errors, metrics, retryAttempts, governance);
    const benchmark = this._buildBenchmark(detail, metrics, traceEvents);
    const strategies = this._buildStrategies({
      workflowId,
      runDetail,
      detail,
      metrics,
      score,
      grade,
      issues,
      remediation,
      benchmark,
      trend,
      traceEvents,
    });
    const promotion = this._buildPromotionDecision({
      workflowId,
      score,
      grade,
      metrics,
      trend,
      strategies,
      remediation,
      benchmark,
      governance,
    });
    const ratchet = this._buildRatchetDecision({
      workflowId,
      runDetail,
      score,
      grade,
      metrics,
      benchmark,
      strategies,
      promotion,
      timestamp: evaluationTimestamp,
    });
    const insights = this._buildInsights({
      workflowId,
      runDetail,
      detail,
      score,
      grade,
      metrics,
      issues,
      remediation,
      benchmark,
      trend,
      traceEvents,
      strategies,
      promotion,
      ratchet,
      governance,
    });
    const judgment = buildRunEvaluationJudgment({ metrics, issues, remediation, governance });

    const result = { score, grade, issues, metrics, governance, remediation, benchmark, strategies, promotion, ratchet, insights, judgment };

    if (options.recordHistory === true) {
      this.#recordHistory(
        workflowId,
        options.runId || runDetail?.runId || detail?.id || null,
        result,
        evaluationTimestamp,
      );
    }

    return result;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  _emptyResult(reason) {
    return {
      score: 0,
      grade: "F",
      issues: [{ severity: "error", nodeId: null, message: reason, suggestion: null }],
      metrics: {
        totalDurationMs: 0,
        avgNodeDurationMs: 0,
        slowestNode: null,
        failedNodes: 0,
        completedNodes: 0,
        retriedNodes: 0,
        skippedNodes: 0,
        totalNodeCount: 0,
        errorRate: 0,
        goalDepth: null,
        goalAncestryCount: 0,
        budgetStatus: null,
        policyStatus: null,
        governanceBlocked: false,
        approvalPending: false,
        policyViolationCount: 0,
        blockingViolationCount: 0,
        successCriteriaCount: 0,
        completedCriteriaCount: 0,
        goalProgressStatus: null,
        goalCompletionRatio: null,
        constraintStatus: null,
        constraintViolationCount: 0,
        blockingConstraintViolationCount: 0,
        tokenBudgetStatus: null,
        tokenUtilizationRatio: null,
        totalTokens: 0,
      },
      governance: null,
      remediation: {
        canAutoFix: false,
        canAutoRetry: false,
        fixActions: [],
        suggestedRetryMode: null,
        retryReason: null,
        summary: reason,
      },
      benchmark: {
        executedNodes: 0,
        throughputPerMinute: 0,
        retryDensity: 0,
        skipRatio: 0,
        traceEventCount: 0,
        traceCoverage: 0,
        medianNodeDurationMs: 0,
        dominantFailureMode: "unknown",
        comparisonKey: "unknown",
      },
      strategies: [],
      promotion: {
        workflowId: "unknown",
        decision: "hold",
        shouldPromote: false,
        selectedStrategyId: null,
        selectedStrategy: null,
        regressionDetected: false,
        candidateCount: 0,
        promotableCount: 0,
        benchmarkWindow: null,
        thresholds: {
          minScore: this.#config.promotionMinScore,
          minConfidence: this.#config.promotionMinConfidence,
        },
        summary: reason,
        rationale: reason,
      },
      ratchet: {
        workflowId: "unknown",
        decision: "hold",
        shouldPromoteCandidate: false,
        shouldRevertToBaseline: false,
        shouldKeepBaseline: false,
        candidate: null,
        baseline: null,
        previousBaseline: null,
        targetStrategy: null,
        comparison: null,
        summary: reason,
        rationale: reason,
      },
      insights: {
        workflowId: "unknown",
        runId: null,
        taskId: null,
        summary: reason,
        benchmark: null,
        trend: null,
        governance: null,
        topIssues: [],
        traceSample: [],
        strategyIds: [],
        promotion: null,
        ratchet: null,
        score: 0,
        grade: "F",
        metrics: {
          totalDurationMs: 0,
          avgNodeDurationMs: 0,
          slowestNode: null,
          failedNodes: 0,
          completedNodes: 0,
          retriedNodes: 0,
          skippedNodes: 0,
          totalNodeCount: 0,
          errorRate: 0,
        },
      },
      judgment: {
        decision: RUN_EVALUATION_JUDGMENTS.ESCALATE,
        reason: "run.missing_detail",
        summary: reason,
        retryMode: null,
        operatorRequired: false,
        blocked: false,
      },
    };
  }

  _buildRemediation(runDetail, detail, nodeStatuses, errors, metrics, retryAttempts = {}, governance = null) {
    const fixActions = [];
    const failedNodeIds = [];
    const issueAdvisor =
      detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
        ? detail.issueAdvisor
        : null;
    const dagState =
      detail?.dagState && typeof detail.dagState === "object"
        ? detail.dagState
        : null;

    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (status !== "failed") continue;
      failedNodeIds.push(nodeId);

      const nodeErrors = errors.filter((e) => e.nodeId === nodeId);
      const errMsg = nodeErrors.length > 0 ? nodeErrors[0].error : "";

      if (/timed?\s*out/i.test(errMsg)) {
        fixActions.push({
          type: "increase_timeout",
          nodeId,
          description: "Increase node timeout",
          action: { field: "config.timeoutMs", suggestion: "double" },
        });
      } else if (/not\s*found/i.test(errMsg) || /does\s*not\s*exist/i.test(errMsg)) {
        fixActions.push({
          type: "check_config",
          nodeId,
          description: "Check node configuration — referenced resource not found",
          action: { field: "config", suggestion: "verify" },
        });
      } else if (/permission|unauthorized|forbidden/i.test(errMsg)) {
        fixActions.push({
          type: "check_permissions",
          nodeId,
          description: "Permission error — check credentials/access",
          action: { field: "config", suggestion: "verify_access" },
        });
      } else if (errMsg) {
        fixActions.push({
          type: "review_error",
          nodeId,
          description: `Review error: ${errMsg.slice(0, 120)}`,
          action: { field: null, suggestion: "manual_review" },
        });
      }
    }

    for (const [nodeId, count] of Object.entries(retryAttempts || {})) {
      const retries = Number(count) || 0;
      if (retries <= 0) continue;
      fixActions.push({
        type: "tune_retry_policy",
        nodeId,
        description: `Node retried ${retries} time(s) — review retry delay or transient dependency handling`,
        action: { field: "config.retryDelayMs", suggestion: "increase_or_backoff" },
      });
    }

    if (governance?.budgetOutcome?.status === "exceeded") {
      fixActions.push({
        type: "request_budget_approval",
        nodeId: null,
        description: "Workflow exceeded its budget guardrail and needs budget approval or a narrower scope.",
        action: { field: "budgetPolicy", suggestion: "request_approval_or_reduce_scope" },
      });
    } else if (governance?.budgetOutcome?.status === "near_limit") {
      fixActions.push({
        type: "review_budget",
        nodeId: null,
        description: "Workflow is near its budget limit; checkpoint or narrow scope before the next retry.",
        action: { field: "budgetPolicy", suggestion: "review_remaining_budget" },
      });
    }

    if (governance?.approvalPending === true) {
      fixActions.push({
        type: "request_execution_approval",
        nodeId: null,
        description: "Execution policy requires approval before the workflow can continue.",
        action: { field: "executionPolicy.approvalState", suggestion: "request_approval" },
      });
    }

    if (Array.isArray(governance?.executionPolicy?.violations)) {
      for (const violation of governance.executionPolicy.violations) {
        fixActions.push({
          type: "resolve_policy_violation",
          nodeId: violation?.nodeId || null,
          description: violation?.message
            ? `Resolve policy violation ${violation.ruleId || ""}: ${violation.message}`.trim()
            : `Resolve policy violation ${violation?.ruleId || ""}`.trim(),
          action: { field: "executionPolicy", suggestion: "resolve_violation" },
        });
      }
    }

    const incompleteBlockingCriteria = Array.isArray(governance?.successCriteria)
      ? governance.successCriteria.filter((criterion) => (
        criterion?.blocking === true
        && !["satisfied", "waived"].includes(String(criterion?.status || "").trim().toLowerCase())
      ))
      : [];
    for (const criterion of incompleteBlockingCriteria) {
      fixActions.push({
        type: "complete_success_criterion",
        nodeId: null,
        description: `Complete blocking success criterion: ${criterion.title || criterion.id || "criterion"}`,
        action: { field: "successCriteria", suggestion: "finish_or_waive_blocking_criterion" },
      });
    }

    if (
      (Array.isArray(governance?.successCriteria) && governance.successCriteria.length > 0)
      && governance?.goalProgress?.completionRatio != null
      && governance.goalProgress.completionRatio < 1
    ) {
      fixActions.push({
        type: "review_goal_progress",
        nodeId: null,
        description: `Goal progress is ${Math.round(governance.goalProgress.completionRatio * 100)}%; review remaining success criteria.`,
        action: { field: "goalProgress", suggestion: "close_remaining_criteria" },
      });
    }

    if (Array.isArray(governance?.constraintState?.violations)) {
      for (const violation of governance.constraintState.violations) {
        fixActions.push({
          type: "resolve_constraint_violation",
          nodeId: null,
          description: violation?.message
            ? `Resolve constraint violation ${violation.constraintId || ""}: ${violation.message}`.trim()
            : `Resolve constraint violation ${violation?.constraintId || ""}`.trim(),
          action: { field: "constraintState", suggestion: "resolve_constraint" },
        });
      }
    }

    if (governance?.tokenBudget?.status === "exceeded") {
      fixActions.push({
        type: "request_token_budget_approval",
        nodeId: null,
        description: "Run exceeded its token budget and needs more budget or narrower scope.",
        action: { field: "tokenBudget", suggestion: "request_approval_or_reduce_scope" },
      });
    } else if (governance?.tokenBudget?.status === "near_limit") {
      fixActions.push({
        type: "review_token_budget",
        nodeId: null,
        description: "Run is near its token budget; checkpoint or narrow scope before another retry.",
        action: { field: "tokenBudget", suggestion: "review_remaining_budget" },
      });
    }

    let suggestedRetryMode = null;
    let retryReason = null;
    if (issueAdvisor?.recommendedAction === "resume_remaining") {
      suggestedRetryMode = "from_failed";
      retryReason = "issue_advisor.resume_remaining";
    } else if (issueAdvisor?.recommendedAction === "replan_from_failed") {
      suggestedRetryMode = "from_scratch";
      retryReason = "issue_advisor.replan_from_failed";
      fixActions.push({
        type: "replan_workflow",
        nodeId: failedNodeIds[0] || null,
        description: "Issue advisor recommends replanning from the failed boundary before re-running.",
        action: { field: null, suggestion: "replan" },
      });
    } else if (issueAdvisor?.recommendedAction === "inspect_failure") {
      suggestedRetryMode = null;
      retryReason = "issue_advisor.inspect_failure";
      fixActions.push({
        type: "inspect_failure",
        nodeId: failedNodeIds[0] || null,
        description: "Inspect failure details before retrying; resume state may not be trustworthy yet.",
        action: { field: null, suggestion: "inspect" },
      });
    } else if (failedNodeIds.length === 1) {
      suggestedRetryMode = "from_failed";
      retryReason = "failed_node_count.single";
    } else if (failedNodeIds.length > 1) {
      suggestedRetryMode = "from_scratch";
      retryReason = "failed_node_count.multiple";
    }

    const canAutoFix = fixActions.length > 0 &&
      fixActions.every((a) => a.type === "increase_timeout" || a.type === "check_config");

    const canAutoRetry = Boolean(
      suggestedRetryMode &&
      issueAdvisor?.recommendedAction !== "inspect_failure" &&
      governance?.blocked !== true &&
      governance?.constraintState?.blocked !== true &&
      governance?.approvalPending !== true,
    );
    const governanceSummary = governance?.blocked === true
      ? (governance?.approvalPending === true
          ? "Governance blocked retry until approval is granted."
          : "Governance blocked retry until budget/policy issues are resolved.")
      : (governance?.budgetOutcome?.status === "near_limit"
          ? "Workflow is near its budget guardrail; continue carefully."
          : null);
    const summary = issueAdvisor?.summary ||
      governanceSummary ||
      (failedNodeIds.length
        ? `Detected ${failedNodeIds.length} failed node(s); recommended retry is ${suggestedRetryMode || "manual review"}.`
        : "No remediation required.");

    return {
      canAutoFix,
      canAutoRetry,
      fixActions,
      suggestedRetryMode,
      retryReason,
      failedNodeIds,
      lineage: {
        rootRunId: runDetail?.rootRunId || dagState?.rootRunId || null,
        parentRunId: runDetail?.parentRunId || dagState?.parentRunId || null,
        retryOf: runDetail?.retryOf || dagState?.retryOf || null,
      },
      governance,
      summary,
    };
  }

  _buildBenchmark(detail, metrics, traceEvents = []) {
    const executedNodes = Math.max(1, metrics.completedNodes + metrics.failedNodes);
    const throughputPerMinute = metrics.totalDurationMs > 0
      ? roundMetric((metrics.completedNodes / Math.max(metrics.totalDurationMs, 1)) * 60_000)
      : 0;
    const retryDensity = roundMetric(metrics.retriedNodes / executedNodes);
    const skipRatio = roundMetric(metrics.skippedNodes / Math.max(1, metrics.totalNodeCount));
    const traceCoverage = roundMetric(clamp01(traceEvents.length / Math.max(1, (metrics.totalNodeCount * 2) + 2)));
    const nodeDurations = Object.values(detail?.nodeTimings || {})
      .map((timing) => {
        const startedAt = Number(timing?.startedAt);
        const endedAt = Number(timing?.endedAt);
        if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
        return endedAt - startedAt;
      })
      .filter((value) => Number.isFinite(value));
    const medianNodeDurationMs = nodeDurations.length > 0
      ? (() => {
          const sorted = [...nodeDurations].sort((left, right) => left - right);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 === 0
            ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
            : Math.round(sorted[mid]);
        })()
      : 0;
    const dominantFailureMode = metrics.failedNodes > 0
      ? (metrics.errorRate >= this.#config.highErrorRateThreshold ? "high_error_rate" : "isolated_failure")
      : (metrics.retriedNodes > 0 ? "retry_thrash" : "healthy");

    return {
      executedNodes,
      throughputPerMinute,
      retryDensity,
      skipRatio,
      traceEventCount: traceEvents.length,
      traceCoverage,
      medianNodeDurationMs,
      dominantFailureMode,
      comparisonKey: [
        dominantFailureMode,
        metrics.failedNodes,
        metrics.retriedNodes,
        medianNodeDurationMs,
      ].join(":"),
    };
  }

  _buildStrategies({
    workflowId,
    detail,
    metrics,
    score,
    grade,
    issues,
    remediation,
    benchmark,
    trend,
    traceEvents,
  }) {
    const strategies = [];
    const remediationByNode = new Map(
      (Array.isArray(remediation?.fixActions) ? remediation.fixActions : [])
        .filter((action) => action?.nodeId)
        .map((action) => [action.nodeId, action]),
    );

    for (const issue of issues) {
      const remediationAction = issue?.nodeId ? remediationByNode.get(issue.nodeId) || null : null;
      const category = inferIssueCategory(issue);
      const action = inferStrategyAction(issue, remediationAction);
      const confidence = computeStrategyConfidence({
        score,
        metrics,
        issueSeverity: issue?.severity,
        traceCoverage: benchmark?.traceCoverage || 0,
        trend,
      });
      const nodeTraceCount = issue?.nodeId
        ? traceEvents.filter((event) => event?.nodeId === issue.nodeId).length
        : traceEvents.length;
      const strategyId = buildStrategyId(workflowId, action, issue?.nodeId, category);
      strategies.push({
        strategyId,
        workflowId,
        nodeId: issue?.nodeId || null,
        category,
        action,
        title: trimText(issue?.message || remediationAction?.description || action, 140),
        recommendation: trimText(
          remediationAction?.description ||
            issue?.suggestion ||
            remediation?.summary ||
            "Review and promote the verified mitigation.",
          280,
        ),
        rationale: trimText(
          [
            issue?.message,
            issue?.suggestion,
            remediationAction?.description,
            trend?.trend === "declining" ? `Trend is ${trend.trend}.` : "",
          ].filter(Boolean).join(" "),
          400,
        ),
        confidence,
        severity: issue?.severity || "warning",
        evidence: [
          issue?.nodeId ? `node:${issue.nodeId}` : null,
          remediationAction?.type ? `fix:${remediationAction.type}` : null,
          `trace-events:${nodeTraceCount}`,
          `grade:${grade}`,
        ].filter(Boolean),
        tags: [
          "self-improvement",
          "workflow",
          category,
          action,
          issue?.severity || "warning",
        ],
        benchmark: {
          score,
          grade,
          traceCoverage: benchmark?.traceCoverage || 0,
          retryDensity: benchmark?.retryDensity || 0,
          throughputPerMinute: benchmark?.throughputPerMinute || 0,
        },
      });
    }

    if (strategies.length === 0 && score >= this.#config.promotionMinScore) {
      const confidence = computeStrategyConfidence({
        score,
        metrics,
        issueSeverity: "warning",
        traceCoverage: benchmark?.traceCoverage || 0,
        trend,
      });
      strategies.push({
        strategyId: buildStrategyId(workflowId, "preserve_current_pattern", "global", "quality"),
        workflowId,
        nodeId: null,
        category: "quality",
        action: "preserve_current_pattern",
        title: "Preserve current workflow pattern",
        recommendation: "Current workflow execution is healthy; preserve the existing execution pattern as a benchmark baseline.",
        rationale: trimText(
          `Run achieved grade ${grade} with score ${score} and no actionable issues.`,
          240,
        ),
        confidence,
        severity: "info",
        evidence: [
          `grade:${grade}`,
          `score:${score}`,
          `trace-events:${traceEvents.length}`,
        ],
        tags: ["self-improvement", "workflow", "baseline", "quality"],
        benchmark: {
          score,
          grade,
          traceCoverage: benchmark?.traceCoverage || 0,
          retryDensity: benchmark?.retryDensity || 0,
          throughputPerMinute: benchmark?.throughputPerMinute || 0,
        },
      });
    }

    return strategies;
  }

  _buildPromotionDecision({ workflowId, score, grade, metrics, trend, strategies, remediation, benchmark, governance }) {
    const promotableStrategies = strategies.filter((strategy) =>
      strategy.confidence >= this.#config.promotionMinConfidence && strategy.severity !== "info",
    );
    const baselineStrategies = strategies.filter((strategy) => strategy.action === "preserve_current_pattern");
    const regressionDetected =
      trend?.trend === "declining" &&
      Number.isFinite(trend?.avgScore) &&
      (trend.avgScore - score) >= this.#config.regressionDeclineThreshold;
    const blockedByGovernance = governance?.blocked === true || governance?.approvalPending === true;
    const shouldPromote = !blockedByGovernance && (
      promotableStrategies.length > 0 ||
      (score >= this.#config.promotionMinScore && baselineStrategies.length > 0)
    );
    const selected = promotableStrategies[0] || baselineStrategies[0] || null;
    let decision = "hold";
    if (regressionDetected) decision = "investigate_regression";
    else if (shouldPromote && selected) decision = selected.action === "preserve_current_pattern" ? "capture_baseline" : "promote_strategy";

    return {
      workflowId,
      decision,
      shouldPromote,
      selectedStrategyId: selected?.strategyId || null,
      selectedStrategy: selected || null,
      regressionDetected,
      blockedByGovernance,
      governanceStatus: governance?.policyOutcome?.status || governance?.budgetOutcome?.status || null,
      candidateCount: strategies.length,
      promotableCount: promotableStrategies.length,
      benchmarkWindow: benchmark?.comparisonKey || null,
      thresholds: {
        minScore: this.#config.promotionMinScore,
        minConfidence: this.#config.promotionMinConfidence,
      },
      summary: blockedByGovernance
        ? `Governance is holding workflow ${workflowId} for approval or policy/budget resolution before promotion.`
        : regressionDetected
        ? `Workflow ${workflowId} is regressing relative to recent runs; inspect before promoting changes.`
        : (selected
            ? `Selected strategy "${selected.title}" for ${decision}.`
            : `No strategy met promotion thresholds for workflow ${workflowId}.`),
      rationale: trimText(
        [
          `grade=${grade}`,
          `score=${score}`,
          `failedNodes=${metrics.failedNodes}`,
          blockedByGovernance ? `governance=${governance?.policyOutcome?.status || governance?.budgetOutcome?.status || "hold"}` : "",
          remediation?.summary || "",
          trend?.trend ? `trend=${trend.trend}` : "",
        ].filter(Boolean).join(" "),
        320,
      ),
    };
  }

  _buildRatchetDecision({
    workflowId,
    runDetail,
    score,
    grade,
    metrics,
    benchmark,
    strategies,
    promotion,
    timestamp,
  }) {
    const state = this.getRatchetState(workflowId);
    const activeBaseline = state?.activeBaseline || null;
    const previousBaseline = state?.previousBaseline || null;
    const selectedStrategy =
      promotion?.selectedStrategy ||
      (Array.isArray(strategies) ? strategies[0] || null : null);
    const candidate = normalizeRatchetSnapshot({
      runId: runDetail?.runId || runDetail?.detail?.id || null,
      workflowId,
      score,
      grade,
      timestamp,
      strategyId: selectedStrategy?.strategyId || null,
      strategy: selectedStrategy,
      benchmark,
      metrics,
      promotionDecision: promotion?.decision || null,
    });

    if (!candidate) {
      return {
        workflowId,
        decision: "hold",
        shouldPromoteCandidate: false,
        shouldRevertToBaseline: false,
        shouldKeepBaseline: false,
        candidate: null,
        baseline: activeBaseline,
        previousBaseline,
        targetStrategy: null,
        comparison: null,
        stateBefore: state,
        summary: `No ratchet candidate was available for workflow ${workflowId}.`,
        rationale: "Missing candidate run snapshot.",
      };
    }

    if (!activeBaseline) {
      const shouldCapture = Boolean(selectedStrategy) && promotion?.shouldPromote === true;
      return {
        workflowId,
        decision: shouldCapture ? "capture_baseline" : "hold",
        shouldPromoteCandidate: shouldCapture,
        shouldRevertToBaseline: false,
        shouldKeepBaseline: !shouldCapture,
        candidate,
        baseline: null,
        previousBaseline,
        targetStrategy: shouldCapture ? cloneJson(selectedStrategy) : null,
        comparison: null,
        stateBefore: state,
        summary: shouldCapture
          ? `Captured run ${candidate.runId} as the first ratchet baseline for workflow ${workflowId}.`
          : `Workflow ${workflowId} has no ratchet baseline yet; holding until a promotable candidate appears.`,
        rationale: trimText(
          [
            `score=${score}`,
            `grade=${grade}`,
            promotion?.summary || "",
          ].filter(Boolean).join(" "),
          320,
        ),
      };
    }

    const scoreDelta = roundMetric(score - Number(activeBaseline.score || 0), 2);
    const throughputDelta = roundMetric(
      Number(benchmark?.throughputPerMinute || 0) - Number(activeBaseline?.benchmark?.throughputPerMinute || 0),
      3,
    );
    const retryDensityDelta = roundMetric(
      Number(benchmark?.retryDensity || 0) - Number(activeBaseline?.benchmark?.retryDensity || 0),
      3,
    );
    const traceCoverageDelta = roundMetric(
      Number(benchmark?.traceCoverage || 0) - Number(activeBaseline?.benchmark?.traceCoverage || 0),
      3,
    );
    const errorRateDelta = roundMetric(
      Number(metrics?.errorRate || 0) - Number(activeBaseline?.metrics?.errorRate || 0),
      3,
    );
    const regressions = [];
    const improvements = [];
    if (scoreDelta >= 3) improvements.push("score");
    else if (scoreDelta <= -this.#config.regressionDeclineThreshold) regressions.push("score");
    if (throughputDelta >= 0.5) improvements.push("throughput");
    else if (throughputDelta <= -0.75) regressions.push("throughput");
    if (retryDensityDelta <= -0.05) improvements.push("retry_density");
    else if (retryDensityDelta >= 0.05) regressions.push("retry_density");
    if (traceCoverageDelta >= 0.08) improvements.push("trace_coverage");
    else if (traceCoverageDelta <= -0.08) regressions.push("trace_coverage");
    if (errorRateDelta <= -0.1) improvements.push("error_rate");
    else if (errorRateDelta >= 0.1) regressions.push("error_rate");

    const comparison = {
      baselineRunId: activeBaseline.runId,
      candidateRunId: candidate.runId,
      scoreDelta,
      throughputDelta,
      retryDensityDelta,
      traceCoverageDelta,
      errorRateDelta,
      improvements,
      regressions,
    };
    const regressionDetected = promotion?.regressionDetected === true || regressions.length >= 2;
    const baselineChanged = candidate.runId !== activeBaseline.runId;
    const canApplyCandidate =
      baselineChanged &&
      Boolean(selectedStrategy?.strategyId) &&
      selectedStrategy?.strategyId !== activeBaseline.strategyId &&
      promotion?.shouldPromote === true &&
      regressions.length === 0 &&
      (improvements.length > 0 || scoreDelta >= 2);

    let decision = "keep_baseline";
    let targetStrategy = cloneJson(activeBaseline.strategy || null);
    let summary = `Kept baseline ${activeBaseline.runId} for workflow ${workflowId}.`;
    let rationale = [
      `baseline=${activeBaseline.runId}`,
      `candidate=${candidate.runId}`,
      `scoreDelta=${scoreDelta}`,
      promotion?.summary || "",
    ].filter(Boolean).join(" ");

    if (regressionDetected && previousBaseline?.runId && previousBaseline.runId !== activeBaseline.runId) {
      decision = "revert_to_baseline";
      targetStrategy = cloneJson(previousBaseline.strategy || null);
      summary = `Reverted workflow ${workflowId} to baseline ${previousBaseline.runId} after regression against active baseline ${activeBaseline.runId}.`;
      rationale = [
        `baseline=${activeBaseline.runId}`,
        `revertTo=${previousBaseline.runId}`,
        `candidate=${candidate.runId}`,
        `regressions=${regressions.join(",") || "trend"}`,
        promotion?.summary || "",
      ].filter(Boolean).join(" ");
    } else if (canApplyCandidate) {
      decision = "apply_candidate";
      targetStrategy = cloneJson(selectedStrategy);
      summary = `Applied candidate run ${candidate.runId} as the new ratchet baseline for workflow ${workflowId}.`;
      rationale = [
        `baseline=${activeBaseline.runId}`,
        `candidate=${candidate.runId}`,
        `improvements=${improvements.join(",") || "score"}`,
        `scoreDelta=${scoreDelta}`,
        promotion?.summary || "",
      ].filter(Boolean).join(" ");
    } else if (regressionDetected) {
      summary = `Detected regression for workflow ${workflowId}, but no older baseline was available to revert to; keeping the current baseline.`;
      rationale = [
        `baseline=${activeBaseline.runId}`,
        `candidate=${candidate.runId}`,
        `regressions=${regressions.join(",") || "trend"}`,
        promotion?.summary || "",
      ].filter(Boolean).join(" ");
    }

    return {
      workflowId,
      decision,
      shouldPromoteCandidate: decision === "capture_baseline" || decision === "apply_candidate",
      shouldRevertToBaseline: decision === "revert_to_baseline",
      shouldKeepBaseline: decision === "keep_baseline",
      candidate,
      baseline: activeBaseline,
      previousBaseline,
      targetStrategy,
      comparison,
      stateBefore: state,
      summary,
      rationale: trimText(rationale, 360),
    };
  }

  _buildInsights({
    workflowId,
    runDetail,
    detail,
    score,
    grade,
    metrics,
    issues,
    remediation,
    benchmark,
    trend,
    traceEvents,
    strategies,
    promotion,
    ratchet,
    governance,
  }) {
    const issueAdvisor =
      detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
        ? detail.issueAdvisor
        : null;
    return {
      workflowId,
      runId: runDetail?.runId || detail?.id || null,
      taskId:
        detail?.data?.taskId ||
        detail?.data?.task?.id ||
        traceEvents.find((event) => event?.taskId)?.taskId ||
        null,
      summary: trimText(
        [
          issueAdvisor?.summary,
          governance?.blocked ? "Governance blocked promotion/retry." : "",
          remediation?.summary,
          promotion?.summary,
        ].filter(Boolean).join(" "),
        420,
      ),
      benchmark,
      trend,
      governance,
      topIssues: issues.slice(0, 5).map((issue) => ({
        severity: issue?.severity || "warning",
        nodeId: issue?.nodeId || null,
        message: trimText(issue?.message || "", 180),
        suggestion: trimText(issue?.suggestion || "", 180),
      })),
      traceSample: traceEvents.slice(-5).map((event) => ({
        eventType: event?.eventType || null,
        nodeId: event?.nodeId || null,
        status: event?.status || null,
        summary: trimText(event?.summary || event?.error || "", 140),
        timestamp: event?.timestamp || null,
      })),
      strategyIds: strategies.map((strategy) => strategy.strategyId),
      promotion,
      ratchet,
      score,
      grade,
      metrics,
    };
  }

  _suggestFixForError(errMsg) {
    if (!errMsg) return null;
    if (/timed?\s*out/i.test(errMsg)) return "Increase node timeout";
    if (/not\s*found/i.test(errMsg) || /does\s*not\s*exist/i.test(errMsg)) return "Check configuration paths/IDs";
    if (/permission|unauthorized|forbidden/i.test(errMsg)) return "Check permissions/credentials";
    return "Review error details";
  }

  // ── History & Trends ──────────────────────────────────────────────────

  /**
   * Get evaluation history for a workflow.
   * @param {string} workflowId
   * @param {number} [limit=20]
   * @returns {Array<{ runId: string, score: number, grade: string, timestamp: string }>}
   */
  getHistory(workflowId) {
    return this.#history.get(workflowId) || [];
  }

  /**
   * Get trend data for a workflow (average score over recent evaluations).
   * @param {string} workflowId
   * @returns {{ avgScore: number, trend: "improving"|"stable"|"declining", evaluationCount: number, recentGrades: string[] }|null}
   */
  getTrend(workflowId) {
    const entries = this.#history.get(workflowId);
    if (!entries || entries.length === 0) return null;

    const scores = entries.map((e) => e.score);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    const recentEntries = entries.slice(-5);
    const recentGrades = recentEntries.map((e) => e.grade);

    // Determine trend by comparing first half vs second half
    let trend = "stable";
    if (scores.length >= 4) {
      const mid = Math.floor(scores.length / 2);
      const firstHalf = scores.slice(0, mid);
      const secondHalf = scores.slice(mid);
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
      if (secondAvg - firstAvg > 5) trend = "improving";
      else if (firstAvg - secondAvg > 5) trend = "declining";
    }

    return {
      avgScore,
      trend,
      evaluationCount: entries.length,
      recentGrades,
      recentEntries: recentEntries.map((entry) => ({ ...entry })),
      latestScore: entries.at(-1)?.score ?? null,
    };
  }

  getRatchetState(workflowId) {
    return normalizeRatchetState(this.#ratchet.get(workflowId) || {});
  }

  recordRatchetDecision(workflowId, payload = {}) {
    const normalizedWorkflowId = String(workflowId || "").trim() || "unknown";
    const state = this.getRatchetState(normalizedWorkflowId);
    const now = String(payload.timestamp || new Date().toISOString()).trim() || new Date().toISOString();
    const candidate = normalizeRatchetSnapshot(payload.candidate);
    const baseline = normalizeRatchetSnapshot(payload.baseline || state.activeBaseline);
    const previousBaseline = normalizeRatchetSnapshot(payload.previousBaseline || state.previousBaseline);
    let nextActiveBaseline = normalizeRatchetSnapshot(state.activeBaseline);
    let nextPreviousBaseline = normalizeRatchetSnapshot(state.previousBaseline);
    const decision = String(payload.decision || "hold").trim() || "hold";
    const targetStrategy = payload.targetStrategy && typeof payload.targetStrategy === "object"
      ? cloneJson(payload.targetStrategy)
      : null;
    const knowledge = payload.knowledge && typeof payload.knowledge === "object"
      ? cloneJson(payload.knowledge)
      : null;

    if (decision === "capture_baseline" && candidate) {
      nextActiveBaseline = normalizeRatchetSnapshot({
        ...candidate,
        strategy: targetStrategy || candidate.strategy,
        knowledge,
      });
      nextPreviousBaseline = null;
    } else if (decision === "apply_candidate" && candidate) {
      nextPreviousBaseline = normalizeRatchetSnapshot(state.activeBaseline);
      nextActiveBaseline = normalizeRatchetSnapshot({
        ...candidate,
        strategy: targetStrategy || candidate.strategy,
        knowledge,
      });
    } else if (decision === "revert_to_baseline" && previousBaseline) {
      nextPreviousBaseline = normalizeRatchetSnapshot(state.activeBaseline);
      nextActiveBaseline = normalizeRatchetSnapshot({
        ...previousBaseline,
        strategy: targetStrategy || previousBaseline.strategy,
        knowledge,
      });
    }

    const recorded = {
      decisionId: String(payload.decisionId || `${normalizedWorkflowId}:${decision}:${candidate?.runId || now}`).trim(),
      timestamp: now,
      workflowId: normalizedWorkflowId,
      runId: String(payload.runId || candidate?.runId || "").trim() || null,
      decision,
      summary: trimText(payload.summary || "", 320) || null,
      rationale: trimText(payload.rationale || "", 360) || null,
      baselineRunId: baseline?.runId || null,
      previousBaselineRunId: previousBaseline?.runId || null,
      activeBaselineRunIdAfter: nextActiveBaseline?.runId || null,
      previousBaselineRunIdAfter: nextPreviousBaseline?.runId || null,
      selectedStrategyId: String(payload.selectedStrategyId || targetStrategy?.strategyId || candidate?.strategyId || "").trim() || null,
      targetStrategyId: String(payload.targetStrategyId || targetStrategy?.strategyId || "").trim() || null,
      comparison: payload.comparison && typeof payload.comparison === "object"
        ? cloneJson(payload.comparison)
        : null,
      knowledge,
    };

    const decisions = Array.isArray(state.decisions) ? [...state.decisions, recorded] : [recorded];
    while (decisions.length > this.#config.maxRatchetDecisionsPerWorkflow) {
      decisions.shift();
    }

    const nextState = normalizeRatchetState({
      activeBaseline: nextActiveBaseline,
      previousBaseline: nextPreviousBaseline,
      lastDecision: recorded,
      decisions,
    });
    this.#ratchet.set(normalizedWorkflowId, nextState);
    this.#saveHistory();
    return {
      workflowId: normalizedWorkflowId,
      stateBefore: state,
      stateAfter: nextState,
      decision: recorded,
    };
  }

  _resolveHistoryTimestamp(runDetail, detail = runDetail?.detail || runDetail) {
    const candidates = [
      detail?.endedAt,
      detail?.startedAt,
      runDetail?.endedAt,
      runDetail?.startedAt,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
        return new Date(candidate).toISOString();
      }
      if (typeof candidate === "string" && candidate.trim()) {
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
    }
    return new Date().toISOString();
  }

  #recordHistory(workflowId, runId, result, timestamp = new Date().toISOString()) {
    if (!this.#history.has(workflowId)) {
      this.#history.set(workflowId, []);
    }
    const entries = this.#history.get(workflowId);
    const normalizedRunId = String(runId || "unknown").trim() || "unknown";
    const nextEntry = {
      runId: normalizedRunId,
      score: result.score,
      grade: result.grade,
      timestamp,
    };
    const existingIndex = entries.findIndex((entry) => String(entry?.runId || "").trim() === normalizedRunId);
    if (existingIndex >= 0) {
      entries[existingIndex] = nextEntry;
    } else {
      entries.push(nextEntry);
    }
    entries.sort((left, right) => {
      const leftTs = Date.parse(left?.timestamp || "") || 0;
      const rightTs = Date.parse(right?.timestamp || "") || 0;
      if (leftTs !== rightTs) return leftTs - rightTs;
      return String(left?.runId || "").localeCompare(String(right?.runId || ""));
    });
    while (entries.length > this.#config.maxHistoryPerWorkflow) {
      entries.shift();
    }
    this.#saveHistory();
  }

  // ── Persistence ───────────────────────────────────────────────────────

  #loadHistory() {
    if (!this.#historyPath) return;
    try {
      if (!existsSync(this.#historyPath)) return;
      const raw = readFileSync(this.#historyPath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object") {
        for (const [wfId, entries] of Object.entries(data)) {
          if (Array.isArray(entries)) {
            this.#history.set(wfId, entries);
          }
        }
        if (data.__ratchet && typeof data.__ratchet === "object") {
          for (const [wfId, state] of Object.entries(data.__ratchet)) {
            this.#ratchet.set(wfId, normalizeRatchetState(state));
          }
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load evaluation history: ${err?.message || err}`);
    }
  }

  #saveHistory() {
    if (!this.#historyPath) return;
    try {
      const dir = dirname(this.#historyPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [wfId, entries] of this.#history) {
        data[wfId] = entries;
      }
      if (this.#ratchet.size > 0) {
        data.__ratchet = {};
        for (const [wfId, state] of this.#ratchet) {
          data.__ratchet[wfId] = state;
        }
      }
      writeFileSync(this.#historyPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save evaluation history: ${err?.message || err}`);
    }
  }
}
