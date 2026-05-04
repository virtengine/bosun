export const COVERAGE_EXECUTE_ORIGINAL_PREFIXES = new Set([
  "condition",
  "flow",
  "loop",
  "read-workflow-contract",
  "transform",
  "trigger",
  "workflow-contract-validation",
]);

export function shouldExecuteOriginalForCoverage(type) {
  const normalized = String(type || "").trim();
  if (!normalized) return false;
  const prefix = normalized.split(".")[0];
  return COVERAGE_EXECUTE_ORIGINAL_PREFIXES.has(prefix);
}

export function createCoverageStubResult(type) {
  return {
    success: true,
    ok: true,
    passed: true,
    result: true,
    value: true,
    blocked: false,
    deferred: false,
    skipped: false,
    status: "completed",
    output: "{}",
    stdout: "{}",
    stderr: "",
    parsed: {},
    json: {},
    exitCode: 0,
    repo: "virtengine/bosun",
    repoSlug: "virtengine/bosun",
    prNumber: 1,
    prUrl: "https://github.com/virtengine/bosun/pull/1",
    url: "https://github.com/virtengine/bosun/pull/1",
    branch: "feat/test",
    baseBranch: "main",
    actionable: [],
    commentFindings: [],
    qualityChecks: [],
    signals: {},
    stubbedForCoverage: true,
    nodeType: String(type || "").trim(),
  };
}
