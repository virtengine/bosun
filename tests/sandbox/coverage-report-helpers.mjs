export const COVERAGE_EXECUTE_ORIGINAL_PREFIXES = new Set([
  "condition",
  "flow",
  "loop",
  "read-workflow-contract",
  "transform",
  "trigger",
  "workflow-contract-validation",
]);

export function shouldStubCoverageGates() {
  return String(process.env.BOSUN_STUB_GATES || "").trim() === "1";
}

export function shouldExecuteOriginalForCoverage(type) {
  const normalized = String(type || "").trim();
  if (!normalized) return false;
  const prefix = normalized.split(".")[0];
  return COVERAGE_EXECUTE_ORIGINAL_PREFIXES.has(prefix);
}

export function createCoverageNodeResult(type, options = {}) {
  const normalizedType = String(type || "").trim();
  const passed = options.passed !== false;
  const blocked = options.blocked === true || passed === false;
  const reason = options.reason ? String(options.reason) : "";
  const summary = options.summary ? String(options.summary) : (passed ? "coverage gate passed" : "coverage gate blocked");
  return {
    success: passed,
    ok: passed,
    passed,
    result: passed,
    value: passed,
    blocked,
    deferred: false,
    skipped: false,
    status: passed ? "completed" : "failed",
    output: JSON.stringify({ passed, blocked, reason, summary, nodeType: normalizedType }),
    stdout: JSON.stringify({ passed, blocked, reason, summary, nodeType: normalizedType }),
    stderr: passed ? "" : reason,
    parsed: { passed, blocked, reason, summary, nodeType: normalizedType },
    json: { passed, blocked, reason, summary, nodeType: normalizedType },
    exitCode: passed ? 0 : 1,
    repo: options.repo || "virtengine/bosun",
    repoSlug: options.repoSlug || options.repo || "virtengine/bosun",
    prNumber: options.prNumber || 1,
    prUrl: options.prUrl || "https://github.com/virtengine/bosun/pull/1",
    url: options.url || options.prUrl || "https://github.com/virtengine/bosun/pull/1",
    branch: options.branch || "feat/test",
    baseBranch: options.baseBranch || "main",
    actionable: options.actionable || [],
    commentFindings: options.commentFindings || [],
    qualityChecks: options.qualityChecks || [],
    signals: options.signals || {},
    stubbedForCoverage: options.stubbedForCoverage === true,
    nodeType: normalizedType,
    reason,
    summary,
  };
}

export function createCoverageStubResult(type, options = {}) {
  return createCoverageNodeResult(type, {
    ...options,
    passed: true,
    blocked: false,
    stubbedForCoverage: true,
    summary: options.summary || "stubbed side-effecting node for coverage run",
  });
}
