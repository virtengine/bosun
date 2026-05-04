import {
  deriveApprovalRequestJudgment,
  expireApprovalRequest,
  getApprovalRequest,
  resolveApprovalRequest,
  upsertWorkflowGateApprovalRequest,
} from "./approval-queue.mjs";
import { normalizeHarnessApprovalNodeOutput } from "./harness-output-contract.mjs";
import { buildWorkflowLineageContract } from "./workflow-contract.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildGateJudgment(decision, reason, extras = {}) {
  return {
    judgment: decision,
    judgmentReason: reason,
    ...extras,
  };
}

function throwGateJudgmentError(message, judgment, extras = {}) {
  const error = new Error(message);
  error.judgment = judgment?.judgment || null;
  error.judgmentReason = judgment?.judgmentReason || null;
  Object.assign(error, extras);
  throw error;
}

export async function executeHarnessApprovalNode(node, ctx, engine) {
  const mode = node.config?.mode || "condition";
  const timeoutMs = node.config?.timeoutMs || 300000;
  const onTimeout = node.config?.onTimeout || "proceed";
  const reason = ctx.resolve(node.config?.reason || "Waiting at gate");
  const pollInterval = node.config?.pollIntervalMs || 5000;

  ctx.log(node.id, `Gate (${mode}): ${reason}`);
  ctx.setNodeStatus?.(node.id, "waiting");
  engine?.emit?.("node:waiting", { nodeId: node.id, mode, reason });

  if (mode === "timeout") {
    await sleep(timeoutMs);
    const judgment = buildGateJudgment("ACCEPT", "gate.timeout_elapsed");
    return normalizeHarnessApprovalNodeOutput({
      success: true,
      status: "completed",
      output: { gateOpened: true, mode, waited: timeoutMs, reason, ...judgment },
      summary: reason,
      sessionId: ctx?.data?._workflowSessionId || null,
      rootSessionId: ctx?.data?._workflowRootSessionId || null,
      parentSessionId: ctx?.data?._workflowParentSessionId || null,
      runId: ctx?.id || null,
      workflowId: ctx?.data?._workflowId || null,
      workflowName: ctx?.data?._workflowName || null,
    });
  }

  if (mode === "condition" && node.config?.condition) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const fn = new Function("$data", "$ctx", `return (${node.config.condition});`);
        if (fn(ctx.data, ctx)) {
          const judgment = buildGateJudgment("ACCEPT", "gate.condition_met");
          return normalizeHarnessApprovalNodeOutput({
            success: true,
            status: "completed",
            output: { gateOpened: true, mode, waited: Date.now() - start, reason, ...judgment },
            summary: reason,
          });
        }
      } catch {}
      await sleep(pollInterval);
    }
    if (onTimeout === "fail") {
      throwGateJudgmentError(
        `Gate timed out after ${timeoutMs}ms: ${reason}`,
        buildGateJudgment("ESCALATE", "gate.condition_timeout_fail"),
        { mode, timeoutMs, nodeId: node?.id || null },
      );
    }
    const judgment = buildGateJudgment("ACCEPT", "gate.condition_timeout_proceed");
    return normalizeHarnessApprovalNodeOutput({
      success: true,
      status: "timed_out",
      output: { gateOpened: true, mode, timedOut: true, waited: timeoutMs, reason, ...judgment },
      summary: reason,
    });
  }

  const approvalKey = `_gate_${node.id}_approved`;
  const repoRoot = ctx?.data?.repoRoot || process.cwd();
  const approvalScopeId = normalizeText(
    ctx?.data?._workflowApprovalScopeId
    || `${ctx?.id || "run"}:${node.id}`,
  ) || `${ctx?.id || "run"}:${node.id}`;
  const gateRequest = upsertWorkflowGateApprovalRequest({
    runId: String(ctx?.id || "").trim() || null,
    workflowId: String(ctx?.data?._workflowId || "").trim() || null,
    workflowName: String(ctx?.data?._workflowName || "").trim() || null,
    taskId: String(ctx?.data?.taskId || "").trim() || null,
    taskTitle: String(ctx?.data?.taskTitle || "").trim() || null,
    nodeId: node.id,
    nodeLabel: node.label || null,
    reason,
    timeoutMs,
    onTimeout,
    pollIntervalMs: pollInterval,
    requestedBy: "flow.gate",
    mode: "manual",
  }, { repoRoot }).request;

  if (!ctx.data._pendingApprovalRequests || typeof ctx.data._pendingApprovalRequests !== "object") {
    ctx.data._pendingApprovalRequests = {};
  }
  ctx.data._pendingApprovalRequests[gateRequest.requestId] = {
    requestId: gateRequest.requestId,
    scopeType: gateRequest.scopeType,
    scopeId: gateRequest.scopeId,
    nodeId: gateRequest.nodeId,
    nodeLabel: gateRequest.nodeLabel,
    reason: gateRequest.reason,
    status: gateRequest.status,
    requestedAt: gateRequest.requestedAt,
    expiresAt: gateRequest.expiresAt || null,
  };
  engine?._checkpointRun?.(ctx);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const legacyApproved = ctx.data[approvalKey] || ctx.variables[approvalKey];
    if (legacyApproved) {
      try {
        const pending = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
        if (pending && pending.status === "pending") {
          resolveApprovalRequest(gateRequest.requestId, {
            repoRoot,
            decision: "approved",
            actorId: "legacy-context",
            note: "Approved through legacy workflow context variable.",
          });
        }
      } catch {}
      delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
      engine?._checkpointRun?.(ctx);
      const judgment = buildGateJudgment("ACCEPT", "gate.approved_legacy");
      return normalizeHarnessApprovalNodeOutput({
        success: true,
        status: "approved",
        approvalRequestId: gateRequest.requestId,
        approvalState: "approved",
        output: { gateOpened: true, mode: "manual", waited: Date.now() - start, reason, ...judgment },
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
      });
    }
    const currentRequest = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
    const approvalState = String(currentRequest?.status || "").trim().toLowerCase();
    if (approvalState === "approved" || approvalState === "denied") {
      delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
      engine?._checkpointRun?.(ctx);
      const approvalJudgment = deriveApprovalRequestJudgment(currentRequest, currentRequest?.resolution);
      const judgment = buildGateJudgment(approvalJudgment.decision, approvalJudgment.reason);
      if (approvalState === "denied") {
        throwGateJudgmentError(
          `Gate approval denied: ${reason}`,
          judgment,
          {
            approvalRequestId: gateRequest.requestId,
            approvalState,
            nodeId: node?.id || null,
          },
        );
      }
      return normalizeHarnessApprovalNodeOutput({
        success: true,
        status: approvalState,
        approvalRequestId: gateRequest.requestId,
        approvalState,
        output: { gateOpened: true, mode: "manual", waited: Date.now() - start, reason, ...judgment },
      });
    }
    await sleep(pollInterval);
  }

  const pending = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
  let expiredRequest = null;
  if (pending && pending.status === "pending") {
    expiredRequest = expireApprovalRequest(gateRequest.requestId, {
      repoRoot,
      actorId: "workflow-engine",
      note: `Gate timed out after ${timeoutMs}ms`,
    });
  }
  delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
  engine?._checkpointRun?.(ctx);
  const judgmentSource = expiredRequest?.request || pending || gateRequest;
  const approvalJudgment = deriveApprovalRequestJudgment(judgmentSource, expiredRequest?.request?.resolution);
  const judgment = buildGateJudgment(approvalJudgment.decision, approvalJudgment.reason);
  if (onTimeout === "fail") {
    throwGateJudgmentError(
      `Manual gate timed out after ${timeoutMs}ms: ${reason}`,
      judgment,
      {
        approvalRequestId: gateRequest.requestId,
        approvalState: "expired",
        nodeId: node?.id || null,
      },
    );
  }
  return normalizeHarnessApprovalNodeOutput({
    success: true,
    status: "expired",
    approvalRequestId: gateRequest.requestId,
    approvalState: "expired",
    output: { gateOpened: true, mode: "manual", timedOut: true, waited: timeoutMs, reason, ...judgment },
  });
}

export default executeHarnessApprovalNode;
