import { normalizeHarnessSubagentNodeOutput } from "./harness-output-contract.mjs";
import { buildWorkflowLineageContract } from "./workflow-contract.mjs";
import {
  beginWorkflowLinkedSessionExecution,
  resolveWorkflowSessionManager,
} from "./harness-session-node.mjs";
import { buildDelegatedExecutionStateSnapshot } from "./delegation-runtime.mjs";
import {
  describeMultimodalFallback,
  ensureBrowserWorkerIsolation,
} from "../voice/vision-session-state.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function parseStringArray(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [value])
      .map((entry) => normalizeText(entry))
      .filter(Boolean),
  ));
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

const DEFAULT_NESTED_DELEGATION_DENYLIST = Object.freeze([
  "spawn_subagent",
  "spawn_agent",
  "wait_subagent",
  "wait_for_subagent",
  "cancel_subagent",
  "abort_subagent",
  "close_agent",
  "list_subagents",
]);

const BROWSER_TOOL_HINT_RE = /(playwright|browser|page|tab|screenshot|vision|image|dom|navigate|click)/i;

function buildSubagentContract(resolved = {}, childInput = {}, executionStateScopes = {}) {
  const configured = toPlainObject(resolved.subagentContract || childInput._subagentContract);
  const configuredToolPolicy = toPlainObject(configured.toolPolicy);
  const configuredMemoryPolicy = toPlainObject(configured.memoryPolicy);
  const configuredReportingPolicy = toPlainObject(configured.reportingPolicy);
  const configuredEscalationPolicy = toPlainObject(configured.escalationPolicy);
  const allowNestedDelegation = parseBoolean(
    resolved.allowNestedDelegation ?? configuredToolPolicy.allowNestedDelegation,
    false,
  );
  const deniedTools = [
    ...parseStringArray(configuredToolPolicy.deniedTools),
    ...parseStringArray(resolved.deniedTools),
    ...(allowNestedDelegation ? [] : DEFAULT_NESTED_DELEGATION_DENYLIST),
  ];
  return {
    freshConversation: parseBoolean(
      resolved.freshConversation ?? configured.freshConversation,
      true,
    ),
    toolPolicy: {
      allowedTools: [
        ...parseStringArray(configuredToolPolicy.allowedTools),
        ...parseStringArray(resolved.allowedTools),
      ],
      deniedTools,
      allowNestedDelegation,
    },
    memoryPolicy: {
      mode: normalizeText(
        resolved.inheritedMemoryMode || configuredMemoryPolicy.mode || "read_only",
      ) || "read_only",
      inheritedState: toPlainObject(
        configuredMemoryPolicy.inheritedState && Object.keys(configuredMemoryPolicy.inheritedState).length > 0
          ? configuredMemoryPolicy.inheritedState
          : executionStateScopes,
      ),
    },
    reportingPolicy: {
      mode: normalizeText(
        resolved.progressReportingMode || configuredReportingPolicy.mode || "one_way_progress",
      ) || "one_way_progress",
      progressOnly: configuredReportingPolicy.progressOnly !== false,
    },
    escalationPolicy: {
      mode: normalizeText(
        resolved.escalationMode || configuredEscalationPolicy.mode || "wait_for_response",
      ) || "wait_for_response",
      waitForResponse: parseBoolean(
        resolved.waitForResponse ?? configuredEscalationPolicy.waitForResponse,
        true,
      ),
    },
  };
}

function shouldEnableBrowserIsolation(resolved = {}, contract = {}) {
  if (resolved.browserIsolation === false) return false;
  if (resolved.browserIsolation === true) return true;
  if (resolved.browserWorker && typeof resolved.browserWorker === "object") return true;
  const allowedTools = Array.isArray(contract?.toolPolicy?.allowedTools) ? contract.toolPolicy.allowedTools : [];
  const deniedTools = Array.isArray(contract?.toolPolicy?.deniedTools) ? contract.toolPolicy.deniedTools : [];
  return [...allowedTools, ...deniedTools].some((toolName) => BROWSER_TOOL_HINT_RE.test(normalizeText(toolName)));
}

function collectBrowserCapabilities(resolved = {}, contract = {}) {
  return Array.from(new Set([
    ...(Array.isArray(resolved.browserCapabilities) ? resolved.browserCapabilities : []),
    ...(Array.isArray(resolved.browserTools) ? resolved.browserTools : []),
    ...(Array.isArray(contract?.toolPolicy?.allowedTools) ? contract.toolPolicy.allowedTools.filter((toolName) => BROWSER_TOOL_HINT_RE.test(normalizeText(toolName))) : []),
  ].map((entry) => normalizeText(entry)).filter(Boolean)));
}

function buildBrowserWorkerBinding(resolved = {}, contract = {}, lineage = {}) {
  if (!shouldEnableBrowserIsolation(resolved, contract)) return null;
  const requestedCapabilities = collectBrowserCapabilities(resolved, contract);
  const multimodalFallbackMode = normalizeText(
    resolved.multimodalFallbackMode
    || resolved.browserWorker?.multimodalFallback?.mode
    || "vision_summary_to_text",
  ) || "vision_summary_to_text";
  return ensureBrowserWorkerIsolation(lineage.childSessionId, {
    parentSessionId: lineage.parentSessionId,
    rootSessionId: lineage.rootSessionId,
    profileScope: normalizeText(resolved.browserProfileScope || resolved.browserWorker?.profileScope || "isolated-subagent") || "isolated-subagent",
    requestedCapabilities,
    toolHints: requestedCapabilities,
    metadata: {
      workflowId: lineage.workflowId,
      workflowRunId: lineage.runId,
      workflowNodeId: lineage.nodeId,
      delegationDepth: lineage.delegationDepth,
    },
    multimodalFallback: {
      enabled: resolved.multimodalFallback !== false,
      mode: multimodalFallbackMode,
      reason: "browser_worker_isolated",
    },
  });
}

function detectWaitForResponseEscalation(childCtx = {}, terminalOutput = null, terminalMessage = "", contract = {}) {
  const escalationPolicy = toPlainObject(contract.escalationPolicy);
  const candidates = [
    childCtx?.data?._subagentEscalation,
    childCtx?.data?.subagentEscalation,
    terminalOutput?.escalation,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const type = normalizeText(candidate.type || "");
    if (candidate.waitForResponse === true || type === "wait_for_response") {
      return {
        type: "wait_for_response",
        waitForResponse: true,
        message: normalizeText(candidate.message || candidate.reason || terminalMessage) || "Subagent requested operator input.",
        details: toPlainObject(candidate.details || terminalOutput),
      };
    }
  }
  const explicitWait =
    childCtx?.data?._waitForResponse === true
    || childCtx?.data?._subagentWaitForResponse === true
    || terminalOutput?.waitForResponse === true
    || normalizeText(childCtx?.status || childCtx?.data?._workflowTerminalStatus || terminalOutput?.status).toLowerCase() === "waiting";
  if (!explicitWait) return null;
  if (escalationPolicy.waitForResponse !== true && normalizeText(escalationPolicy.mode).toLowerCase() !== "wait_for_response") {
    return null;
  }
  return {
    type: "wait_for_response",
    waitForResponse: true,
    message: normalizeText(
      childCtx?.data?._waitForResponseMessage
      || terminalOutput?.message
      || terminalMessage,
    ) || "Subagent requested operator input.",
    details: toPlainObject(terminalOutput),
  };
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
  const subagentContract = buildSubagentContract(resolved, childInput, childInput._executionStateScopes);
  const browserWorker = buildBrowserWorkerBinding(resolved, subagentContract, lineage);
  if (browserWorker) {
    childInput._browserWorker = browserWorker;
    childInput._browserProfileContext = {
      workerId: browserWorker.workerId,
      profileId: browserWorker.profileId,
      profileDir: browserWorker.profileDir,
      profileScope: browserWorker.profileScope,
    };
    childInput._multimodalFallback = browserWorker.multimodalFallback;
  }
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
      subagentContract,
      browserWorker,
    },
  });
  childInput._subagentContract = subagentContract;
  childInput._subagentParentSessionId = parentSessionId;
  childInput._subagentProgressReporting = subagentContract.reportingPolicy;
  childInput._subagentEscalationPolicy = subagentContract.escalationPolicy;
  if (childSessionLink?.session) {
    childSessionLink.session.metadata = {
      ...(childSessionLink.session.metadata && typeof childSessionLink.session.metadata === "object"
        ? childSessionLink.session.metadata
        : {}),
      subagentContract,
      browserWorker,
    };
  }
  const subagentControl = sessionManager.getSubagentControl?.() || null;
  subagentControl?.updateSubagent?.(childSessionId, {
    contract: subagentContract,
    lastEventType: "subagent:contract-bound",
    metadata: {
      browserWorker,
    },
  });

  if (mode === "dispatch") {
    subagentControl?.recordSubagentProgress?.(childSessionId, {
      status: "waiting",
      message: `Dispatched child workflow "${workflowId}".`,
      eventType: "subagent:dispatch-queued",
      details: {
        workflowId,
        mode: "dispatch",
      },
    });
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
        subagentContract,
        browserWorker,
      },
    });
    if (outputVariable) ctx.data[outputVariable] = output;
    return output;
  }

  const childCtx = await engine.execute(workflowId, childInput, {
    ...childRunOptions,
    _parentExecutionId: ctx?.id || null,
  });
  subagentControl?.recordSubagentProgress?.(childSessionId, {
    status: "running",
    message: `Child workflow "${workflowId}" started.`,
    eventType: "subagent:running",
    details: {
      workflowId,
      mode: "sync",
    },
  });
  const childErrors = Array.isArray(childCtx?.errors)
    ? childCtx.errors.map((entry) => ({
        nodeId: entry?.nodeId || null,
        error: String(entry?.error || "unknown child workflow error"),
      }))
    : [];
  const terminalMessage = normalizeText(childCtx?.data?._workflowTerminalMessage || "") || null;
  const terminalOutput = childCtx?.data?._workflowTerminalOutput ?? null;
  const waitForResponseEscalation = childErrors.length === 0
    ? detectWaitForResponseEscalation(childCtx, terminalOutput, terminalMessage, subagentContract)
    : null;
  const status = childErrors.length > 0 ? "failed" : (waitForResponseEscalation ? "waiting" : "completed");
  const multimodalFallback = browserWorker
    ? describeMultimodalFallback(childSessionId, {
      reason:
        status === "failed"
          ? "child_workflow_failed"
          : (status === "waiting" ? "child_workflow_waiting" : "child_workflow_completed"),
    })
    : null;
  sessionManager.finalizeExternalExecution(childSessionId, {
    success: status !== "failed",
    status,
    result: childCtx,
    error: childErrors[0]?.error || null,
  });
  if (waitForResponseEscalation) {
    subagentControl?.escalateSubagent?.(childSessionId, {
      ...waitForResponseEscalation,
      details: {
        ...(waitForResponseEscalation.details && typeof waitForResponseEscalation.details === "object" ? waitForResponseEscalation.details : {}),
        browserWorker,
        multimodalFallback,
      },
    });
  } else {
    subagentControl?.recordSubagentProgress?.(childSessionId, {
      status,
      message:
        status === "completed"
          ? `Child workflow "${workflowId}" completed.`
          : `Child workflow "${workflowId}" failed.`,
      eventType: status === "completed" ? "subagent:completed" : "subagent:failed",
      details: {
        workflowId,
        message: terminalMessage,
        browserWorker,
        multimodalFallback,
      },
    });
  }

  const output = normalizeHarnessSubagentNodeOutput({
    success: status !== "failed",
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
      waitForResponse: waitForResponseEscalation?.waitForResponse === true,
      escalation: waitForResponseEscalation,
      subagentContract,
      browserWorker,
      multimodalFallback,
    },
    error: childErrors[0]?.error || null,
  });
  output.queued = false;
  output.mode = "sync";
  output.errorCount = childErrors.length;
  output.errors = childErrors;
  output.message = terminalMessage;
  output.output = terminalOutput;
  output.waitForResponse = waitForResponseEscalation?.waitForResponse === true;
  output.escalation = waitForResponseEscalation;
  output.subagentContract = subagentContract;
  output.browserWorker = browserWorker;
  output.multimodalFallback = multimodalFallback;
  if (outputVariable) ctx.data[outputVariable] = output;
  if (status === "failed" && failOnChildError) {
    const err = new Error(`action.execute_workflow: child workflow "${workflowId}" failed: ${childErrors[0]?.error || "child workflow failed"}`);
    err.childWorkflow = output;
    throw err;
  }
  return output;
}

export default executeHarnessSubagentNode;
