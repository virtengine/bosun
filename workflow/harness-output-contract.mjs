function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneValue(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizePort(port, fallback = "default") {
  const normalized = normalizeText(port).toLowerCase();
  return normalized || fallback;
}

export function normalizeWorkflowHarnessOutput(kind, payload = {}, options = {}) {
  const success = payload?.success !== false;
  const status = normalizeText(
    payload?.status
    || payload?.approvalState
    || payload?.subStatus
    || (success ? "completed" : "failed"),
  ).toLowerCase() || (success ? "completed" : "failed");
  const output = {
    kind: normalizeText(kind) || "workflow-harness",
    success,
    status,
    runId: normalizeText(payload?.runId || payload?.childRunId) || null,
    workflowId: normalizeText(payload?.workflowId) || null,
    workflowName: normalizeText(payload?.workflowName) || null,
    sessionId: normalizeText(payload?.sessionId) || null,
    threadId: normalizeText(payload?.threadId || payload?.sessionId) || null,
    rootSessionId: normalizeText(payload?.rootSessionId) || null,
    parentSessionId: normalizeText(payload?.parentSessionId) || null,
    childSessionId: normalizeText(payload?.childSessionId) || null,
    approvalRequestId: normalizeText(payload?.approvalRequestId) || null,
    approvalState: normalizeText(payload?.approvalState) || null,
    spawnId: normalizeText(payload?.spawnId) || null,
    output: cloneValue(payload?.output ?? payload?.result ?? null),
    summary: normalizeText(payload?.summary || payload?.message) || null,
    error: normalizeText(payload?.error) || null,
    matchedPort: (payload?.matchedPort || payload?.port) ? normalizePort(payload?.matchedPort || payload?.port) : null,
    port: (payload?.port || payload?.matchedPort) ? normalizePort(payload?.port || payload?.matchedPort) : null,
    lineage: cloneValue(payload?.lineage) || null,
    meta: cloneValue(payload?.meta || options.meta) || {},
  };
  const promotedOutput =
    output.output && typeof output.output === "object" && !Array.isArray(output.output)
      ? cloneValue(output.output)
      : null;
  if (promotedOutput) {
    for (const [key, value] of Object.entries(promotedOutput)) {
      if (output[key] === undefined) {
        output[key] = value;
      }
    }
  }
  return output;
}

export function normalizeHarnessSessionNodeOutput(payload = {}, options = {}) {
  return normalizeWorkflowHarnessOutput("harness-session", payload, options);
}

export function normalizeHarnessToolNodeOutput(payload = {}, options = {}) {
  const output = normalizeWorkflowHarnessOutput("harness-tool", payload, options);
  const exitCode = Number(payload?.exitCode);
  return {
    ...output,
    toolId: normalizeText(payload?.toolId) || null,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    stdout: typeof payload?.stdout === "string" ? payload.stdout : null,
    stderr: typeof payload?.stderr === "string" ? payload.stderr : null,
    toolTitle: normalizeText(payload?.toolTitle) || null,
    toolCategory: normalizeText(payload?.toolCategory) || null,
  };
}

export function normalizeHarnessApprovalNodeOutput(payload = {}, options = {}) {
  return normalizeWorkflowHarnessOutput("harness-approval", payload, options);
}

export function normalizeHarnessSubagentNodeOutput(payload = {}, options = {}) {
  return normalizeWorkflowHarnessOutput("harness-subagent", payload, options);
}

export default normalizeWorkflowHarnessOutput;
