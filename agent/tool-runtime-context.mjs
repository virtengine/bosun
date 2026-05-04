import { randomUUID } from "node:crypto";
import {
  normalizeToolSandboxMode,
  normalizeToolTruncationPolicy,
} from "./tool-contract.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeOptionalText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  ));
}

function normalizeApprovalState(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["approved", "pending", "denied", "expired"].includes(normalized)) return normalized;
  return null;
}

function normalizeApprovalMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["inherit", "never", "manual", "always", "auto"].includes(normalized)) return normalized;
  return "inherit";
}

function normalizeNetworkMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["inherit", "deny", "allow", "restricted", "offline"].includes(normalized)) return normalized;
  return "inherit";
}

function normalizeApprovalContext(context = {}, defaults = {}) {
  const merged = {
    ...(defaults?.approval && typeof defaults.approval === "object" ? defaults.approval : {}),
    ...(context?.approval && typeof context.approval === "object" ? context.approval : {}),
  };
  return {
    mode: normalizeApprovalMode(
      merged.mode ?? context.approvalMode ?? defaults.approvalMode,
    ),
    state: normalizeApprovalState(
      merged.state ?? context.approvalState ?? defaults.approvalState,
    ),
    decision: normalizeApprovalState(
      merged.decision ?? context.approvalDecision ?? defaults.approvalDecision,
    ),
    requestId: normalizeOptionalText(
      merged.requestId ?? context.approvalRequestId ?? defaults.approvalRequestId,
    ),
    scopeType: normalizeOptionalText(
      merged.scopeType ?? context.approvalScopeType ?? defaults.approvalScopeType,
    ),
    scopeId: normalizeOptionalText(
      merged.scopeId ?? context.approvalScopeId ?? defaults.approvalScopeId,
    ),
    note: normalizeOptionalText(
      merged.note ?? context.approvalNote ?? defaults.approvalNote,
    ),
    requestedBy: normalizeOptionalText(
      merged.requestedBy ?? context.requestedBy ?? defaults.requestedBy,
    ),
  };
}

function normalizeNetworkContext(context = {}, defaults = {}) {
  const merged = {
    ...(defaults?.network && typeof defaults.network === "object" ? defaults.network : {}),
    ...(context?.network && typeof context.network === "object" ? context.network : {}),
  };
  return {
    mode: normalizeNetworkMode(
      merged.mode ?? context.networkMode ?? defaults.networkMode,
    ),
    requestedHosts: uniqueStrings(
      merged.requestedHosts ?? context.requestedHosts ?? defaults.requestedHosts,
    ),
    allowedHosts: uniqueStrings(
      merged.allowedHosts ?? context.allowedHosts ?? defaults.allowedHosts,
    ),
    blockedHosts: uniqueStrings(
      merged.blockedHosts ?? context.blockedHosts ?? defaults.blockedHosts,
    ),
  };
}

function normalizeRetryContext(context = {}, defaults = {}) {
  const merged = {
    ...(defaults?.retry && typeof defaults.retry === "object" ? cloneJson(defaults.retry) : {}),
    ...(context?.retry && typeof context.retry === "object" ? cloneJson(context.retry) : {}),
  };
  return {
    maxAttempts: Number.isFinite(Number(merged.maxAttempts ?? merged.attempts))
      ? Math.max(1, Math.trunc(Number(merged.maxAttempts ?? merged.attempts)))
      : null,
    backoffMs: Number.isFinite(Number(merged.backoffMs))
      ? Math.max(0, Math.trunc(Number(merged.backoffMs)))
      : null,
    strategy: normalizeOptionalText(merged.strategy) || null,
  };
}

export function normalizeToolRuntimeContext(context = {}, defaults = {}) {
  const mergedMetadata = {
    ...(defaults?.metadata && typeof defaults.metadata === "object" ? cloneJson(defaults.metadata) : {}),
    ...(context?.metadata && typeof context.metadata === "object" ? cloneJson(context.metadata) : {}),
  };
  const sessionId = normalizeOptionalText(context.sessionId ?? defaults.sessionId ?? context.threadId ?? defaults.threadId);
  const approval = normalizeApprovalContext(context, defaults);
  return {
    cwd: normalizeOptionalText(context.cwd ?? defaults.cwd),
    repoRoot: normalizeOptionalText(context.repoRoot ?? defaults.repoRoot),
    sessionId,
    rootSessionId: normalizeOptionalText(context.rootSessionId ?? defaults.rootSessionId ?? sessionId),
    parentSessionId: normalizeOptionalText(context.parentSessionId ?? defaults.parentSessionId),
    threadId: normalizeOptionalText(context.threadId ?? defaults.threadId ?? sessionId),
    turnId: normalizeOptionalText(context.turnId ?? defaults.turnId),
    parentTurnId: normalizeOptionalText(context.parentTurnId ?? defaults.parentTurnId),
    runId: normalizeOptionalText(context.runId ?? defaults.runId),
    workflowId: normalizeOptionalText(context.workflowId ?? defaults.workflowId),
    taskId: normalizeOptionalText(context.taskId ?? defaults.taskId),
    taskKey: normalizeOptionalText(context.taskKey ?? defaults.taskKey),
    sessionType: normalizeOptionalText(context.sessionType ?? defaults.sessionType),
    mode: normalizeOptionalText(context.mode ?? defaults.mode),
    surface: normalizeOptionalText(context.surface ?? defaults.surface),
    sdk: normalizeOptionalText(context.sdk ?? defaults.sdk),
    adapterName: normalizeOptionalText(context.adapterName ?? defaults.adapterName),
    providerSelection: normalizeOptionalText(context.providerSelection ?? defaults.providerSelection),
    providerId: normalizeOptionalText(context.providerId ?? defaults.providerId),
    providerConfig:
      context?.providerConfig && typeof context.providerConfig === "object" && !Array.isArray(context.providerConfig)
        ? cloneJson(context.providerConfig)
        : (
          defaults?.providerConfig && typeof defaults.providerConfig === "object" && !Array.isArray(defaults.providerConfig)
            ? cloneJson(defaults.providerConfig)
            : null
        ),
    providerTurnId: normalizeOptionalText(context.providerTurnId ?? defaults.providerTurnId),
    executor: normalizeOptionalText(context.executor ?? defaults.executor),
    model: normalizeOptionalText(context.model ?? defaults.model),
    agentProfileId: normalizeOptionalText(context.agentProfileId ?? defaults.agentProfileId),
    requestId: normalizeOptionalText(context.requestId ?? defaults.requestId),
    correlationId: normalizeOptionalText(context.correlationId ?? defaults.correlationId),
    executionId: normalizeOptionalText(context.executionId ?? defaults.executionId),
    sandbox: normalizeToolSandboxMode(context.sandbox ?? defaults.sandbox),
    requestedBy: normalizeOptionalText(context.requestedBy ?? defaults.requestedBy),
    approval,
    approvalRequestId: normalizeOptionalText(
      context.approvalRequestId
      ?? defaults.approvalRequestId
      ?? approval.requestId,
    ),
    network: normalizeNetworkContext(context, defaults),
    retry: normalizeRetryContext(context, defaults),
    truncation: normalizeToolTruncationPolicy(
      context.truncation,
      defaults.truncation,
    ),
    metadata: mergedMetadata,
  };
}

export function mergeToolRuntimeContext(base = {}, override = {}) {
  return normalizeToolRuntimeContext(override, base);
}

export function buildToolExecutionEnvelope(toolName, args = {}, context = {}, defaults = {}) {
  const normalizedContext = normalizeToolRuntimeContext(context, defaults);
  const executionId = normalizeOptionalText(
    context.executionId
    ?? defaults.executionId
    ?? normalizedContext.executionId,
  ) || `tool-${randomUUID()}`;
  const nextContext = {
    ...normalizedContext,
    executionId,
    approvalRequestId: normalizedContext.approvalRequestId || normalizedContext.approval?.requestId || null,
  };
  return {
    executionId,
    toolName: normalizeText(toolName),
    args: cloneJson(args) ?? {},
    context: nextContext,
    lineage: {
      sessionId: nextContext.sessionId,
      rootSessionId: nextContext.rootSessionId,
      parentSessionId: nextContext.parentSessionId,
      threadId: nextContext.threadId,
      turnId: nextContext.turnId,
      runId: nextContext.runId,
      workflowId: nextContext.workflowId,
      taskId: nextContext.taskId,
      providerId: nextContext.providerId,
      providerTurnId: nextContext.providerTurnId,
    },
    policy: {
      approval: cloneJson(nextContext.approval),
      network: cloneJson(nextContext.network),
      sandbox: nextContext.sandbox,
      retry: cloneJson(nextContext.retry),
      truncation: cloneJson(nextContext.truncation),
    },
  };
}

export default normalizeToolRuntimeContext;
