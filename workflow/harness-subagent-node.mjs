import { normalizeHarnessSubagentNodeOutput } from "./harness-output-contract.mjs";
import { buildWorkflowLineageContract } from "./workflow-contract.mjs";
import {
  beginWorkflowLinkedSessionExecution,
  resolveWorkflowSessionManager,
} from "./harness-session-node.mjs";
import { buildDelegatedExecutionStateSnapshot } from "./delegation-runtime.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function parseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function buildChildSessionId(ctx, workflowId, nodeId) {
  const taskId = normalizeText(ctx?.data?.taskId || ctx?.data?.task?.id);
  const runId = normalizeText(ctx?.id || "run") || "run";
  const child = normalizeText(workflowId || "workflow") || "workflow";
  const prefix = taskId || "workflow";
  return `${prefix}:subagent:${runId}:${normalizeText(nodeId || "node") || "node"}:${child}`;
}

export async function executeHarnessSubagentNode(node, ctx, engine, resolved = {}) {
  const workflowId = normalizeText(resolved.workflowId);
  const mode = normalizeText(resolved.mode || "sync").toLowerCase() || "sync";
  const outputVariable = normalizeText(resolved.outputVariable);
  const failOnChildError = parseBoolean(resolved.failOnChildError, true);
  const childInput = resolved.childInput && typeof resolved.childInput === "object"
    ? { ...resolved.childInput }
    : {};
  const childRunOptions =
    resolved.childRunOptions && typeof resolved.childRunOptions === "object"
      ? { ...resolved.childRunOptions }
      : {
          _parentRunId: ctx?.id || null,
          _rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
        };
  if (!workflowId) {
    throw new Error("action.execute_workflow: 'workflowId' is required");
  }
  if (!engine || typeof engine.execute !== "function") {
    throw new Error("action.execute_workflow: workflow engine is not available");
  }

  const sessionManager = resolveWorkflowSessionManager(engine);
  const parentSessionId = normalizeText(ctx?.data?._workflowSessionId || ctx?.data?._workflowParentSessionId) || null;
  const rootSessionId = normalizeText(ctx?.data?._workflowRootSessionId || parentSessionId) || parentSessionId;
  const childSessionId = buildChildSessionId(ctx, workflowId, node?.id);
  const lineage = buildWorkflowLineageContract({
    runId: ctx?.id,
    workflowId: ctx?.data?._workflowId,
    workflowName: ctx?.data?._workflowName,
    rootRunId: ctx?.data?._workflowRootRunId,
    parentRunId: ctx?.data?._workflowParentRunId,
    sessionId: parentSessionId,
    rootSessionId,
    parentSessionId,
    childSessionId,
    taskId: ctx?.data?.taskId || ctx?.data?.task?.id,
    taskTitle: ctx?.data?.taskTitle || ctx?.data?.task?.title,
    nodeId: node?.id,
    nodeLabel: node?.label || node?.id,
    delegationDepth: Number(ctx?.data?._workflowDelegationDepth || 0) || 0,
  });

  const childSessionLink = beginWorkflowLinkedSessionExecution(ctx, node, engine, {
    sessionId: childSessionId,
    threadId: childSessionId,
    parentSessionId,
    rootSessionId: rootSessionId || childSessionId,
    taskId: ctx?.data?.taskId || ctx?.data?.task?.id || null,
    taskTitle: ctx?.data?.taskTitle || ctx?.data?.task?.title || null,
    taskKey: childSessionId,
    sessionType: "workflow-subagent",
    scope: "workflow-flow",
    source: "workflow-harness-subagent",
    metadata: {
      workflowRunId: ctx?.id || null,
      workflowId,
      workflowNodeId: node?.id || null,
    },
  });

  childInput._workflowParentRunId = normalizeText(ctx?.id) || null;
  childInput._workflowRootRunId = normalizeText(ctx?.data?._workflowRootRunId || ctx?.id) || normalizeText(ctx?.id) || null;
  childInput._workflowParentSessionId = parentSessionId;
  childInput._workflowRootSessionId = rootSessionId || parentSessionId || childSessionId;
  childInput._workflowSessionId = childSessionId;
  childInput._workflowDelegationDepth = Number(ctx?.data?._workflowDelegationDepth || 0) + 1;
  childInput._delegatedSessionIds = [
    ...(Array.isArray(ctx?.data?._delegatedSessionIds) ? ctx.data._delegatedSessionIds : []),
    childSessionId,
  ];
  childInput._executionStateScopes = buildDelegatedExecutionStateSnapshot(ctx, {
    workflowId,
    nodeId: node?.id,
    childSessionId,
    parentSessionId,
    rootSessionId: rootSessionId || parentSessionId || childSessionId,
    parentRunId: ctx?.id || null,
    rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
    delegationDepth: childInput._workflowDelegationDepth,
  });

  if (mode === "dispatch") {
    let dispatched;
    try {
      dispatched = Promise.resolve(engine.execute(workflowId, childInput, childRunOptions));
    } catch (error) {
      dispatched = Promise.reject(error);
    }
    dispatched
      .then(() => {
        sessionManager.finalizeExternalExecution(childSessionId, {
          success: true,
          status: "completed",
          result: { queued: false },
        });
      })
      .catch((error) => {
        sessionManager.finalizeExternalExecution(childSessionId, {
          success: false,
          status: "failed",
          error: error?.message || String(error),
        });
      });
    const output = normalizeHarnessSubagentNodeOutput({
      success: true,
      status: "queued",
      workflowId,
      childSessionId,
      parentSessionId,
      rootSessionId,
      lineage,
      output: {
        queued: true,
        mode: "dispatch",
        workflowId,
        parentRunId: ctx?.id || null,
        childSessionId,
      },
    });
    if (outputVariable) ctx.data[outputVariable] = output;
    return output;
  }

  const childCtx = await engine.execute(workflowId, childInput, {
    ...childRunOptions,
    _parentExecutionId: ctx?.id || null,
  });
  const childErrors = Array.isArray(childCtx?.errors)
    ? childCtx.errors.map((entry) => ({
        nodeId: entry?.nodeId || null,
        error: String(entry?.error || "unknown child workflow error"),
      }))
    : [];
  const status = childErrors.length > 0 ? "failed" : "completed";
  const terminalMessage = normalizeText(childCtx?.data?._workflowTerminalMessage || "") || null;
  const terminalOutput = childCtx?.data?._workflowTerminalOutput ?? null;
  sessionManager.finalizeExternalExecution(childSessionId, {
    success: status === "completed",
    status,
    result: childCtx,
    error: childErrors[0]?.error || null,
  });

  const output = normalizeHarnessSubagentNodeOutput({
    success: status === "completed",
    status,
    workflowId,
    runId: childCtx?.id || null,
    childSessionId,
    parentSessionId,
    rootSessionId,
    lineage,
    output: {
      queued: false,
      mode: "sync",
      workflowId,
      runId: childCtx?.id || null,
      status,
      errorCount: childErrors.length,
      errors: childErrors,
      message: terminalMessage,
      output: terminalOutput,
    },
    error: childErrors[0]?.error || null,
  });
  output.queued = false;
  output.mode = "sync";
  output.errorCount = childErrors.length;
  output.errors = childErrors;
  output.message = terminalMessage;
  output.output = terminalOutput;
  if (outputVariable) ctx.data[outputVariable] = output;
  if (status === "failed" && failOnChildError) {
    const err = new Error(`action.execute_workflow: child workflow "${workflowId}" failed: ${childErrors[0]?.error || "child workflow failed"}`);
    err.childWorkflow = output;
    throw err;
  }
  return output;
}

export default executeHarnessSubagentNode;
