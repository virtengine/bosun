import {
  getApprovalRequestById,
  upsertApprovalRequest,
} from "../workflow/approval-queue.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeApprovalState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["approved", "pending", "denied", "expired"].includes(normalized)) return normalized;
  return null;
}

function normalizeApprovalMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["never", "manual", "always", "auto", "inherit"].includes(normalized)) return normalized;
  return "auto";
}

function asSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
}

function inferToolRiskLevel(tool = {}) {
  const normalized = normalizeText(tool.riskLevel || tool.metadata?.riskLevel).toLowerCase();
  if (["critical", "high", "medium", "low"].includes(normalized)) return normalized;
  if (tool.requiresApproval === true) return "high";
  return "low";
}

function resolveScopeType(context = {}, defaults = {}) {
  return normalizeText(
    context?.approval?.scopeType || context.approvalScopeType || defaults.approvalScopeType || "harness-run",
  ) || "harness-run";
}

function resolveScopeId(context = {}, defaults = {}) {
  return normalizeText(
    context?.approval?.scopeId
    || context.approvalScopeId
    || context.runId
    || context.sessionId
    || context.taskKey
    || defaults.approvalScopeId,
  ) || null;
}

function buildRequestId(tool = {}, context = {}, defaults = {}) {
  const explicitRequestId = normalizeText(
    context?.approval?.requestId || context.requestId || defaults.requestId,
  );
  if (explicitRequestId) return explicitRequestId;
  const scopeType = resolveScopeType(context, defaults) || "harness-run";
  const scopeId = resolveScopeId(context, defaults)
    || normalizeText(tool?.id || tool?.name)
    || "tool";
  return `${scopeType}:${scopeId}`;
}

function lookupStoredApprovalState(context = {}, options = {}) {
  const requestId = normalizeText(
    context?.approval?.requestId || context.approvalRequestId || options.requestId,
  );
  if (!requestId) return null;
  const repoRoot = normalizeText(options.repoRoot || context.repoRoot || context.cwd || process.cwd());
  const stored = getApprovalRequestById(requestId, { repoRoot });
  return normalizeApprovalState(stored?.status);
}

function buildApprovalRequest(tool = {}, context = {}, evaluation = {}, options = {}) {
  const toolId = normalizeText(tool.id || tool.name || evaluation.toolId);
  const scopeType = resolveScopeType(context, options);
  const requestId = buildRequestId(tool, context, options);
  const scopeId = normalizeText(
    context?.approval?.scopeId
    || context.approvalScopeId
    || requestId.replace(/^[^:]+:/, "")
    || requestId,
  );
  const runId = normalizeText(context.runId || context.sessionId || "");
  const taskId = normalizeText(context.taskId || "");
  const taskTitle = normalizeText(context.taskTitle || context.metadata?.taskTitle || "");
  const requestedBy = normalizeText(
    context?.approval?.requestedBy
    || context.requestedBy
    || options.requestedBy,
  ) || "tool-orchestrator";
  const reason = normalizeText(
    tool.approvalReason
    || context?.approval?.note
    || options.pendingReason
    || evaluation.reason,
  ) || `Tool ${toolId || "execution"} requires operator approval.`;
  const request = {
    requestId,
    scopeType,
    scopeId,
    reason,
    requestedBy,
    preview: normalizeText(options.preview || context?.approval?.preview || context.preview) || null,
  };
  if (scopeType === "workflow-action") {
    request.runId = runId || normalizeText(options.runId);
    request.nodeId = normalizeText(context.nodeId || options.nodeId || toolId);
    request.nodeLabel = normalizeText(context.nodeLabel || options.nodeLabel || tool?.name || toolId) || null;
    request.nodeType = normalizeText(context.nodeType || options.nodeType || "tool") || "tool";
    request.actionKey = normalizeText(context.actionKey || options.actionKey || toolId) || null;
    request.actionLabel = normalizeText(context.actionLabel || options.actionLabel || tool?.name || toolId) || null;
    if (Number.isFinite(Number(options.timeoutMs))) request.timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs)));
    if (Number.isFinite(Number(options.pollIntervalMs))) request.pollIntervalMs = Math.max(1, Math.trunc(Number(options.pollIntervalMs)));
    if (normalizeText(options.onTimeout)) request.onTimeout = normalizeText(options.onTimeout);
  } else if (scopeType === "harness-run") {
    request.runId = runId || scopeId;
    request.taskId = taskId || null;
    request.taskTitle = taskTitle || null;
    request.stageId = normalizeText(context.stageId || options.stageId || `tool:${toolId}`) || `tool:${toolId}`;
    request.stageType = normalizeText(context.stageType || options.stageType || "tool") || "tool";
    if (Number.isFinite(Number(options.timeoutMs))) request.timeoutMs = Math.max(0, Math.trunc(Number(options.timeoutMs)));
  }
  return request;
}

export function evaluateToolApproval(tool = {}, context = {}, options = {}) {
  const toolId = normalizeText(tool.id || tool.name);
  const allowlisted = asSet(options.allowlistedTools);
  const denylisted = asSet(options.denylistedTools);
  const mode = normalizeApprovalMode(
    tool.approvalMode
    ?? context?.approval?.mode
    ?? context.approvalMode
    ?? options.defaultMode,
  );
  const currentState = normalizeApprovalState(
    context?.approval?.decision
    || context?.approval?.state
    || context.approvalDecision
    || context.approvalState,
  );
  const storedState = !currentState ? lookupStoredApprovalState(context, options) : null;
  const effectiveState = currentState || storedState;
  const riskLevel = inferToolRiskLevel(tool);
  const policyRequiresApproval = context.executionPolicy?.approvalRequired === true;
  const needsApproval = (
    denylisted.has(toolId)
    || (toolId && !allowlisted.has(toolId) && (
      tool.requiresApproval === true
      || policyRequiresApproval
      || mode === "always"
      || (mode !== "never" && ["high", "critical"].includes(riskLevel))
    ))
  );

  if (effectiveState === "approved") {
    return {
      toolId,
      approvalRequired: needsApproval,
      approvalState: "approved",
      blocked: false,
      mode,
      riskLevel,
      reason: null,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
      requestId: buildRequestId(tool, context, options),
    };
  }

  if (effectiveState === "denied" || effectiveState === "expired") {
    return {
      toolId,
      approvalRequired: needsApproval,
      approvalState: effectiveState,
      blocked: true,
      mode,
      riskLevel,
      reason: normalizeText(context?.approval?.note || context.approvalNote)
        || `Tool ${toolId || "execution"} was ${effectiveState}.`,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
      requestId: buildRequestId(tool, context, options),
    };
  }

  if (!needsApproval || mode === "never" || allowlisted.has(toolId)) {
    return {
      toolId,
      approvalRequired: false,
      approvalState: "not_required",
      blocked: false,
      mode,
      riskLevel,
      reason: null,
      scopeType: resolveScopeType(context, options),
      scopeId: resolveScopeId(context, options),
      requestId: buildRequestId(tool, context, options),
    };
  }

  return {
    toolId,
    approvalRequired: true,
    approvalState: "pending",
    blocked: true,
    mode,
    riskLevel,
    reason: normalizeText(tool.approvalReason || context?.approval?.note || options.pendingReason)
      || `Tool ${toolId || "execution"} requires operator approval.`,
    scopeType: resolveScopeType(context, options),
    scopeId: resolveScopeId(context, options),
    requestId: buildRequestId(tool, context, options),
  };
}

export function createToolApprovalManager(defaultOptions = {}) {
  return {
    evaluate(tool, context = {}, options = {}) {
      return evaluateToolApproval(tool, context, { ...defaultOptions, ...options });
    },
    assertApproved(tool, context = {}, options = {}) {
      const result = evaluateToolApproval(tool, context, { ...defaultOptions, ...options });
      if (result.blocked) {
        throw new Error(result.reason || `Tool ${result.toolId || "execution"} is blocked pending approval.`);
      }
      return result;
    },
    request(tool, context = {}, options = {}) {
      const mergedOptions = { ...defaultOptions, ...options };
      const approval = evaluateToolApproval(tool, context, mergedOptions);
      if (!approval.blocked) {
        return { approval, request: null, persisted: false };
      }
      const repoRoot = normalizeText(mergedOptions.repoRoot || context.repoRoot || context.cwd || process.cwd());
      const request = buildApprovalRequest(tool, context, approval, mergedOptions);
      let persisted = null;
      try {
        persisted = upsertApprovalRequest(request, { repoRoot });
      } catch {
        persisted = { ok: false, request };
      }
      return {
        approval: {
          ...approval,
          requestId: persisted?.request?.requestId || approval.requestId || null,
          scopeId: persisted?.request?.scopeId || approval.scopeId || null,
        },
        request: persisted?.request || null,
        persisted: Boolean(persisted?.ok),
      };
    },
  };
}

export default createToolApprovalManager;
