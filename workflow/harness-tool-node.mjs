import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { normalizeHarnessToolNodeOutput } from "./harness-output-contract.mjs";
import { buildWorkflowLineageContract } from "./workflow-contract.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function resolvePort(success, payload = {}) {
  if (payload?.port) return payload.port;
  if (payload?.matchedPort) return payload.matchedPort;
  return success ? "default" : "error";
}

export async function executeHarnessToolNode({
  node,
  ctx,
  engine,
  rootDir,
  cwd,
  timeoutMs,
  toolId,
  resolvedArgs = [],
  envOverrides = {},
  toolInfo,
  toolsMod,
  outputAdapter = null,
}) {
  const repoRoot = normalizeText(rootDir || cwd || ctx?.data?.repoRoot || process.cwd()) || process.cwd();
  const orchestrator = createToolOrchestrator({
    cwd,
    repoRoot,
    approvalOptions: {
      repoRoot,
      approvalScopeType: "workflow-action",
      timeoutMs: node.config?.approvalTimeoutMs,
      pollIntervalMs: node.config?.approvalPollIntervalMs,
      onTimeout: node.config?.approvalOnTimeout,
      nodeId: node.id,
      nodeLabel: node.label || node.id,
      nodeType: node.type,
    },
    toolSources: [{
      source: "workflow-bosun-tool",
      definitions: [{
        id: toolId,
        name: toolInfo?.entry?.title || toolId,
        description: toolInfo?.entry?.description || null,
        requiresApproval: node.config?.requireApproval === true || toolInfo?.entry?.requiresApproval === true,
        approvalReason: node.config?.approvalReason || null,
        sandbox: "inherit",
        handler: async () => toolsMod.invokeCustomTool(rootDir, toolId, resolvedArgs, {
          timeout: timeoutMs,
          cwd,
          env: envOverrides,
        }),
      }],
    }],
    onEvent: (event) => {
      const eventType = normalizeText(event?.type);
      if (!eventType || typeof ctx?.log !== "function") return;
      if (eventType === "approval_requested") {
        ctx.log(node.id, `Tool approval requested: ${event?.approval?.requestId || event?.request?.requestId || toolId}`);
      }
    },
  });

  try {
    const workflowRunId = String(ctx?.data?._runId || ctx?.data?.runId || ctx?.id || "").trim() || null;
    const toolResult = await orchestrator.execute(toolId, {
      args: resolvedArgs,
      cwd,
      env: envOverrides,
      timeoutMs,
    }, {
      repoRoot,
      runId: workflowRunId,
      workflowId: String(ctx?.data?._workflowId || "").trim() || null,
      taskId: String(ctx?.data?.taskId || ctx?.data?.task?.id || "").trim() || null,
      taskTitle: String(ctx?.data?.taskTitle || ctx?.data?.task?.title || "").trim() || null,
      nodeId: node.id,
      nodeLabel: node.label || node.id,
      nodeType: node.type,
      sessionId: String(ctx?.data?._workflowSessionId || ctx?.data?._sessionId || "").trim() || null,
      rootSessionId: String(ctx?.data?._workflowRootSessionId || "").trim() || null,
      parentSessionId: String(ctx?.data?._workflowParentSessionId || "").trim() || null,
      requestedBy: "workflow",
      approval: {
        scopeType: "workflow-action",
      },
    });

    const exitSuccess = toolResult?.exitCode === 0;
    let data = toolResult?.stdout?.trim() || "";
    if (node.config?.parseJson !== false && data) {
      try { data = JSON.parse(data); } catch {}
    }

    let output = {
      success: exitSuccess,
      toolId,
      exitCode: toolResult?.exitCode ?? null,
      data,
      stdout: toolResult?.stdout,
      stderr: toolResult?.stderr,
      toolTitle: toolInfo?.entry?.title || toolId,
      toolCategory: toolInfo?.entry?.category || "unknown",
    };

    if (node.config?.extract && exitSuccess && outputAdapter) {
      const sourceData = typeof data === "object" && data !== null ? data : { text: data };
      const extracted = outputAdapter.extractMcpOutput(sourceData, node.config.extract);
      output = { ...output, extracted, ...extracted };
    }
    if (node.config?.outputMap && exitSuccess && outputAdapter) {
      const mapped = outputAdapter.mapOutputFields(output, node.config.outputMap, ctx);
      output = { ...output, mapped, ...mapped };
    }
    if (node.config?.portConfig && outputAdapter) {
      const port = outputAdapter.resolveOutputPort(output, node.config.portConfig);
      output.matchedPort = port;
      output.port = port;
    } else {
      output.matchedPort = exitSuccess ? "default" : "error";
      output.port = exitSuccess ? "default" : "error";
    }

    return normalizeHarnessToolNodeOutput({
      ...output,
      sessionId: ctx?.data?._workflowSessionId || null,
      rootSessionId: ctx?.data?._workflowRootSessionId || null,
      parentSessionId: ctx?.data?._workflowParentSessionId || null,
      runId: ctx?.id || null,
      workflowId: ctx?.data?._workflowId || null,
      workflowName: ctx?.data?._workflowName || null,
      lineage: buildWorkflowLineageContract({
        runId: ctx?.id,
        workflowId: ctx?.data?._workflowId,
        workflowName: ctx?.data?._workflowName,
        rootRunId: ctx?.data?._workflowRootRunId,
        parentRunId: ctx?.data?._workflowParentRunId,
        sessionId: ctx?.data?._workflowSessionId,
        rootSessionId: ctx?.data?._workflowRootSessionId,
        parentSessionId: ctx?.data?._workflowParentSessionId,
        taskId: ctx?.data?.taskId || ctx?.data?.task?.id,
        taskTitle: ctx?.data?.taskTitle || ctx?.data?.task?.title,
        nodeId: node?.id,
        nodeLabel: node?.label || node?.id,
      }),
      matchedPort: resolvePort(exitSuccess, output),
      port: resolvePort(exitSuccess, output),
      output: output.data,
    });
  } catch (error) {
    const approvalBlocked = Boolean(error?.request || error?.approval);
    return normalizeHarnessToolNodeOutput({
      success: false,
      error: approvalBlocked
        ? `Tool \"${toolId}\" requires operator approval${error?.message ? `: ${error.message}` : ""}`
        : (error?.message || String(error)),
      toolId,
      sessionId: ctx?.data?._workflowSessionId || null,
      rootSessionId: ctx?.data?._workflowRootSessionId || null,
      parentSessionId: ctx?.data?._workflowParentSessionId || null,
      runId: ctx?.data?._runId || ctx?.data?.runId || ctx?.id || null,
      workflowId: ctx?.data?._workflowId || null,
      workflowName: ctx?.data?._workflowName || null,
      approvalRequestId: error?.request?.requestId || error?.approval?.requestId || null,
      approvalState: error?.approval?.approvalState || null,
      matchedPort: "error",
      port: "error",
    });
  }
}

export default executeHarnessToolNode;
