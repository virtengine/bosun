import { getBosunSessionManager } from "../agent/session-manager.mjs";
import { normalizeHarnessSessionNodeOutput } from "./harness-output-contract.mjs";
import { buildWorkflowLineageContract } from "./workflow-contract.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function rememberDelegatedSessionId(ctx, sessionId) {
  const normalized = normalizeText(sessionId);
  if (!normalized || !ctx?.data || typeof ctx.data !== "object") return;
  const existing = Array.isArray(ctx.data._delegatedSessionIds) ? ctx.data._delegatedSessionIds : [];
  if (!existing.includes(normalized)) {
    ctx.data._delegatedSessionIds = [...existing, normalized];
  }
}

export function resolveWorkflowSessionManager(engine = {}) {
  return engine?.services?.sessionManager || getBosunSessionManager();
}

export function buildWorkflowHarnessSessionBinding(ctx, node, options = {}) {
  const lineage = buildWorkflowLineageContract({
    runId: ctx?.id,
    workflowId: ctx?.data?._workflowId,
    workflowName: ctx?.data?._workflowName,
    parentRunId: ctx?.data?._workflowParentRunId,
    rootRunId: ctx?.data?._workflowRootRunId,
    sessionId: options.parentSessionId ?? ctx?.data?._workflowSessionId,
    rootSessionId: options.rootSessionId ?? ctx?.data?._workflowRootSessionId,
    parentSessionId: options.parentSessionId ?? ctx?.data?._workflowSessionId ?? ctx?.data?._workflowParentSessionId,
    taskId: options.taskId ?? ctx?.data?.taskId ?? ctx?.data?.task?.id,
    taskTitle: options.taskTitle ?? ctx?.data?.taskTitle ?? ctx?.data?.task?.title,
    nodeId: node?.id,
    nodeLabel: node?.label || node?.id,
    childSessionId: options.sessionId,
    delegationDepth: options.delegationDepth ?? ctx?.data?._workflowDelegationDepth ?? 0,
  });
  return {
    sessionId: normalizeText(options.sessionId) || null,
    threadId: normalizeText(options.threadId) || null,
    taskKey: normalizeText(options.taskKey || options.sessionId || ctx?.id) || null,
    cwd: normalizeText(options.cwd) || null,
    status: normalizeText(options.status || "running") || "running",
    sessionType: normalizeText(options.sessionType || "workflow-agent") || "workflow-agent",
    scope: normalizeText(options.scope || (lineage.taskId ? "workflow-task" : "workflow-flow")) || "workflow-flow",
    runtimeRole: normalizeText(options.runtimeRole || "worker") || "worker",
    lineage,
    metadata: {
      source: normalizeText(options.source || "workflow-harness-session") || "workflow-harness-session",
      workflowRunId: lineage.runId,
      workflowId: lineage.workflowId,
      workflowName: lineage.workflowName,
      workflowNodeId: lineage.nodeId,
      workflowNodeLabel: lineage.nodeLabel,
      taskId: lineage.taskId,
      taskTitle: lineage.taskTitle,
      runtimeRole: normalizeText(options.runtimeRole || "worker") || "worker",
      ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
    },
  };
}

export function beginWorkflowLinkedSessionExecution(ctx, node, engine, options = {}) {
  const sessionManager = resolveWorkflowSessionManager(engine);
  const binding = buildWorkflowHarnessSessionBinding(ctx, node, options);
  if (!binding.sessionId) {
    return { sessionManager, binding, session: null };
  }
  const parentSessionId = normalizeText(binding.lineage.parentSessionId);
  const rootSessionId = normalizeText(binding.lineage.rootSessionId);
  if (rootSessionId && !sessionManager.getSession(rootSessionId)) {
    sessionManager.beginExternalSession({
      sessionId: rootSessionId,
      threadId: rootSessionId,
      scope: binding.scope,
      sessionType: binding.sessionType,
      taskKey: rootSessionId,
      cwd: binding.cwd,
      metadata: {
        ...binding.metadata,
        source: "workflow-harness-root-session",
      },
      source: "workflow-harness-root-session",
    });
  }
  if (parentSessionId && !sessionManager.getSession(parentSessionId)) {
    sessionManager.beginExternalSession({
      sessionId: parentSessionId,
      threadId: parentSessionId,
      parentSessionId:
        rootSessionId && rootSessionId !== parentSessionId
          ? rootSessionId
          : null,
      scope: binding.scope,
      sessionType: binding.sessionType,
      taskKey: parentSessionId,
      cwd: binding.cwd,
      metadata: {
        ...binding.metadata,
        source: "workflow-harness-parent-session",
      },
      source: "workflow-harness-parent-session",
    });
  }
  const session = sessionManager.beginExternalSession({
    sessionId: binding.sessionId,
    threadId: binding.runtimeRole === "overseer" ? binding.threadId || binding.sessionId : null,
    parentSessionId,
    scope: binding.scope,
    sessionType: binding.sessionType,
    taskKey: binding.taskKey,
    cwd: binding.cwd,
    metadata: binding.metadata,
    source: binding.metadata.source,
  });
  const shouldDeferWorkerAttachment =
    binding.runtimeRole !== "overseer"
    && (options.deferWorkerAttachment !== false);
  sessionManager.registerExecution(binding.sessionId, {
    sessionType: binding.sessionType,
    taskKey: binding.taskKey,
    threadId: shouldDeferWorkerAttachment ? null : binding.threadId,
    cwd: binding.cwd,
    status: binding.status,
    metadata: binding.metadata,
    scope: binding.scope,
  });
  rememberDelegatedSessionId(ctx, binding.sessionId);
  return { sessionManager, binding, session };
}

export function finalizeWorkflowLinkedSessionExecution(link = {}, execution = {}) {
  const sessionId = normalizeText(link?.binding?.sessionId || execution?.sessionId);
  if (!sessionId || typeof link?.sessionManager?.finalizeExternalExecution !== "function") {
    return normalizeHarnessSessionNodeOutput({
      ...execution,
      sessionId,
      lineage: link?.binding?.lineage || null,
    });
  }
  const finalized = link.sessionManager.finalizeExternalExecution(sessionId, {
    status: execution?.status,
    success: execution?.success,
    error: execution?.error,
    threadId: execution?.threadId || link?.binding?.threadId,
    result: execution?.result || execution?.output || execution,
  });
  return normalizeHarnessSessionNodeOutput({
    ...execution,
    sessionId,
    threadId: execution?.threadId || link?.binding?.threadId || null,
    rootSessionId: link?.binding?.lineage?.rootSessionId || null,
    parentSessionId: link?.binding?.lineage?.parentSessionId || null,
    lineage: link?.binding?.lineage || null,
    status: finalized?.status || execution?.status,
  });
}

export default beginWorkflowLinkedSessionExecution;
