/**
 * tests/sandbox/fixtures.mjs — Deterministic GitHub fixture factories
 *
 * Every factory returns a fully-populated, realistic GitHub API object so
 * the exec-sandbox's gh-CLI mock can return correct data for any command
 * without ever hitting the real GitHub API.
 *
 * Template scenario registry maps each template-id → the set of pre-built
 * GitHub objects it needs for a clean, non-flaky run.
 */

// ──────────────────────────────────────────────────────────────────────────
//  Core factory functions
// ──────────────────────────────────────────────────────────────────────────

const BASE_DATE = new Date("2026-01-01T00:00:00Z");
const agoDate = (days) => new Date(BASE_DATE - days * 86_400_000).toISOString();

export function makeUser(login = "dev-user", extra = {}) {
  return {
    login,
    id: Math.abs(login.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % 100_000 + 1,
    node_id: `U_${login}`,
    avatar_url: `https://avatars.githubusercontent.com/${login}`,
    html_url: `https://github.com/${login}`,
    type: "User",
    ...extra,
  };
}

export function makeLabel(name, color = "0075ca", extra = {}) {
  return { id: name.length * 100, name, color, description: "", ...extra };
}

export function makeIssue(number, overrides = {}) {
  const title   = overrides.title   ?? `Issue #${number}: Test issue`;
  const body    = overrides.body    ?? `This is the body of issue #${number}.`;
  const state   = overrides.state   ?? "open";
  const labels  = overrides.labels  ?? [];
  const assignee = overrides.assignee ?? null;
  const createdAt = overrides.createdAt ?? agoDate(10);

  return {
    number,
    id: 100000 + number,
    node_id: `I_${number}`,
    title,
    body,
    state,
    html_url: `https://github.com/virtengine/bosun/issues/${number}`,
    url: `https://api.github.com/repos/virtengine/bosun/issues/${number}`,
    user: makeUser(overrides.user ?? "dev-user"),
    assignee: assignee ? makeUser(assignee) : null,
    assignees: assignee ? [makeUser(assignee)] : [],
    labels: labels.map((l) => (typeof l === "string" ? makeLabel(l) : l)),
    milestone: overrides.milestone ?? null,
    comments: overrides.comments ?? 0,
    created_at: createdAt,
    updated_at: overrides.updatedAt ?? createdAt,
    closed_at: state === "closed" ? agoDate(1) : null,
    body_text: body,
    ...overrides,
  };
}

export function makePR(number, overrides = {}) {
  const title  = overrides.title  ?? `PR #${number}: Test pull request`;
  const body   = overrides.body   ?? `This PR adds feature #${number}.`;
  const state  = overrides.state  ?? "open";
  const branch = overrides.branch ?? `feat/pr-${number}`;
  const base   = overrides.base   ?? "main";
  const draft  = overrides.draft  ?? false;

  return {
    number,
    id: 200000 + number,
    node_id: `PR_${number}`,
    title,
    body,
    state,
    draft,
    html_url: `https://github.com/virtengine/bosun/pull/${number}`,
    url: `https://api.github.com/repos/virtengine/bosun/pulls/${number}`,
    head: {
      ref: branch,
      sha: `abc${number}def1234567890abcdef1234567890abcd`,
      repo: makeRepo(),
    },
    base: {
      ref: base,
      sha: `base${number}efgh1234567890abcdef1234567890abc`,
      repo: makeRepo(),
    },
    user: makeUser(overrides.user ?? "dev-user"),
    labels: (overrides.labels ?? []).map((l) => (typeof l === "string" ? makeLabel(l) : l)),
    assignees: (overrides.assignees ?? []).map((l) => makeUser(l)),
    requested_reviewers: (overrides.reviewers ?? []).map((l) => makeUser(l)),
    mergeable: overrides.mergeable ?? "MERGEABLE",
    mergeable_state: overrides.mergeableState ?? "clean",
    merged: state === "merged",
    merged_at: state === "merged" ? agoDate(0) : null,
    closed_at: state === "closed" || state === "merged" ? agoDate(0) : null,
    created_at: overrides.createdAt ?? agoDate(5),
    updated_at: overrides.updatedAt ?? agoDate(1),
    additions: overrides.additions ?? 42,
    deletions: overrides.deletions ?? 7,
    changed_files: overrides.changedFiles ?? 3,
    commits: overrides.commits ?? 2,
    comments: overrides.comments ?? 0,
    review_comments: overrides.reviewComments ?? 0,
    ...overrides,
  };
}

export function makeRepo(overrides = {}) {
  return {
    id: 999001,
    name: overrides.name ?? "bosun",
    full_name: `${overrides.owner ?? "virtengine"}/${overrides.name ?? "bosun"}`,
    owner: makeUser(overrides.owner ?? "virtengine"),
    private: overrides.private ?? false,
    html_url: `https://github.com/${overrides.owner ?? "virtengine"}/${overrides.name ?? "bosun"}`,
    description: overrides.description ?? "Bosun AI orchestration system",
    default_branch: overrides.defaultBranch ?? "main",
    open_issues_count: overrides.openIssues ?? 3,
    ...overrides,
  };
}

export function makeRelease(tagName = "v1.0.0", overrides = {}) {
  return {
    id: 500000,
    tag_name: tagName,
    name: overrides.name ?? tagName,
    body: overrides.body ?? "Release notes for " + tagName,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
    html_url: `https://github.com/virtengine/bosun/releases/tag/${tagName}`,
    created_at: agoDate(3),
    published_at: agoDate(3),
    assets: overrides.assets ?? [],
    ...overrides,
  };
}

export function makeCheckRun(name, state = "SUCCESS", overrides = {}) {
  return {
    name,
    state,
    status: state === "SUCCESS" ? "completed" : state.toLowerCase(),
    conclusion: state === "SUCCESS" ? "success" : state === "FAILURE" ? "failure" : "neutral",
    html_url: `https://github.com/virtengine/bosun/actions/runs/12345`,
    started_at: agoDate(0),
    completed_at: agoDate(0),
    ...overrides,
  };
}

export function makeWorkflowRun(id = 1, status = "completed", conclusion = "success") {
  return {
    id,
    name: "CI",
    status,
    conclusion,
    head_branch: "main",
    html_url: `https://github.com/virtengine/bosun/actions/runs/${id}`,
    created_at: agoDate(0),
    updated_at: agoDate(0),
  };
}

export function makeCommit(sha = "abc123", overrides = {}) {
  return {
    sha: sha.padEnd(40, "0"),
    node_id: `COMMIT_${sha}`,
    commit: {
      message: overrides.message ?? "chore: test commit",
      author: { name: "Dev User", email: "dev@example.com", date: agoDate(1) },
    },
    html_url: `https://github.com/virtengine/bosun/commit/${sha}`,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  Pre-built scenario sets (used by template-specific tests)
// ──────────────────────────────────────────────────────────────────────────

export const scenarios = {
  /** A single open, ready-to-merge PR with green CI */
  greenPR: (n = 42) => ({
    prs:    [makePR(n, { title: "feat: add login", labels: ["review-ready"], mergeable: "MERGEABLE" })],
    issues: [],
    checks: [makeCheckRun("ci/tests", "SUCCESS"), makeCheckRun("ci/lint", "SUCCESS")],
    releases: [makeRelease("v1.0.0")],
  }),

  /** PR that has merge conflicts */
  conflictPR: (n = 55) => ({
    prs:    [makePR(n, { title: "feat/conflict", mergeableState: "dirty", mergeable: "CONFLICTING" })],
    issues: [],
    checks: [makeCheckRun("ci/tests", "SUCCESS")],
    releases: [],
  }),

  /** Several stale PRs (untouched > 14 days) */
  stalePRs: () => ({
    prs: [
      makePR(10, { title: "feat: old feature 1", updatedAt: agoDate(20), createdAt: agoDate(30) }),
      makePR(11, { title: "feat: old feature 2", updatedAt: agoDate(25), createdAt: agoDate(40) }),
      makePR(12, { title: "feat: recent update",  updatedAt: agoDate(2),  createdAt: agoDate(10) }),
    ],
    issues: [],
    checks: [],
    releases: [],
  }),

  /** A release-ready state: several merged PRs, existing release */
  releaseReady: () => ({
    prs: [
      makePR(20, { title: "feat: new feature A", state: "merged" }),
      makePR(21, { title: "fix: critical patch", state: "merged" }),
      makePR(22, { title: "docs: update readme", state: "merged" }),
    ],
    issues: [],
    checks: [],
    releases: [makeRelease("v0.9.0")],
  }),

  /** Active kanban tasks */
  kanbanState: () => ({
    prs: [
      makePR(30, { title: "feat: TASK-1 implementation" }),
      makePR(31, { title: "feat: TASK-2 implementation" }),
    ],
    issues: [
      makeIssue(1, { title: "TASK-1: Implement auth", state: "open" }),
      makeIssue(2, { title: "TASK-2: Add dark mode",  state: "open" }),
    ],
    checks: [],
    releases: [],
  }),

  /** Security audit state: some vulnerable deps */
  securityAudit: () => ({
    prs: [],
    issues: [],
    checks: [],
    releases: [],
    auditOutput: JSON.stringify({
      vulnerabilities: {
        "lodash": { severity: "high", via: ["prototype-pollution"], range: "<4.17.21", fixAvailable: true },
      },
      metadata: { vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, info: 0, total: 1 } },
    }),
  }),

  /** CI/CD deploy state */
  cicdDeploy: () => ({
    prs:    [makePR(42, { title: "feat: deploy candidate" })],
    issues: [],
    checks: [makeCheckRun("ci/tests", "SUCCESS"), makeCheckRun("ci/build", "SUCCESS")],
    releases: [makeRelease("v1.2.0")],
  }),
};

// ──────────────────────────────────────────────────────────────────────────
//  Per-template fixture registry
//  Maps template-id → { scenario, inputVars }
// ──────────────────────────────────────────────────────────────────────────

export const TEMPLATE_FIXTURES = {
  "template-pr-merge-strategy":            { scenario: scenarios.greenPR(42),      inputVars: { prNumber: 42,  branch: "feat/login",      baseBranch: "main" } },
  "template-pr-review-quality-striker":    { scenario: scenarios.greenPR(43),      inputVars: { prNumber: 43, repo: "virtengine/bosun", prUrl: "https://github.com/virtengine/bosun/pull/43", event: "review_requested" } },
  "template-pr-triage":                    { scenario: scenarios.greenPR(100),     inputVars: { prNumber: 100, prTitle: "feat: dark mode", prBody: "Adds dark mode", prAuthor: "dev-user" } },
  "template-pr-conflict-resolver":         { scenario: scenarios.conflictPR(55),   inputVars: { prNumber: 55,  branch: "feat/conflicts" } },
  "template-pr-fix-single":                { scenario: scenarios.greenPR(56),      inputVars: { item: { repo: "virtengine/bosun", number: 56, n: 56, branch: "feat/pr-fix", baseBranch: "main", title: "Fix PR #56", reason: "ci_failed", prDigest: { core: { branch: "feat/pr-fix", baseBranch: "main", title: "Fix PR #56" }, files: [], reviews: [], reviewComments: [], issueComments: [], checks: [] } } } },
  "template-pr-security-fix-single":       { scenario: scenarios.greenPR(57),      inputVars: { item: { repo: "virtengine/bosun", number: 57, n: 57, branch: "feat/pr-security-fix", baseBranch: "main", title: "Fix security PR #57", failedCheckNames: ["CodeQL"], securityCheckNames: ["CodeQL"], alerts: [], prDigest: { core: { branch: "feat/pr-security-fix", baseBranch: "main", title: "Fix security PR #57" }, files: [], reviews: [], reviewComments: [], checks: [] } } } },
  "template-stale-pr-reaper":              { scenario: scenarios.stalePRs(),        inputVars: {} },
  "template-release-drafter":              { scenario: scenarios.releaseReady(),    inputVars: { tagName: "v1.1.0" } },
  "template-sonarqube-pr-striker":         { scenario: scenarios.greenPR(44),      inputVars: { prNumber: 44, repo: "virtengine/bosun" } },
  "template-bosun-pr-progressor":          { scenario: scenarios.greenPR(60),      inputVars: { taskId: "TASK-PR-1", taskTitle: "Progress PR", prNumber: 60, prUrl: "https://github.com/virtengine/bosun/pull/60", repo: "virtengine/bosun", branch: "feat/pr-progress", baseBranch: "main" } },
  "template-bosun-pr-watchdog":            { scenario: scenarios.greenPR(60),      inputVars: { prNumber: 60 } },
  "template-github-kanban-sync":           { scenario: scenarios.kanbanState(),     inputVars: {} },
  "template-sdk-conflict-resolver":        { scenario: scenarios.conflictPR(70),   inputVars: { prNumber: 70, branch: "fix/sdk-conflict" } },
  "template-review-agent":                 { scenario: scenarios.greenPR(80),      inputVars: { prNumber: 80, branch: "feat/review" } },
  "template-frontend-agent":               { scenario: scenarios.greenPR(81),      inputVars: { prNumber: 81, taskId: "TASK-1", branch: "feat/frontend" } },
  "template-custom-agent":                 { scenario: scenarios.greenPR(82),      inputVars: { prNumber: 82, taskId: "TASK-2", branch: "feat/custom" } },
  "template-agent-session-monitor":        { scenario: scenarios.greenPR(83),      inputVars: { sessionId: "session-001" } },
  "template-backend-agent":               { scenario: scenarios.greenPR(84),      inputVars: { prNumber: 84, taskId: "TASK-3", branch: "feat/backend" } },
  "template-voice-video-parallel-rollout": { scenario: scenarios.cicdDeploy(),     inputVars: { branch: "feat/av" } },
  "template-meeting-subworkflow-chain":    { scenario: scenarios.greenPR(90),      inputVars: { meetingId: "sprint-planning-1" } },
  "template-task-planner":                 { scenario: scenarios.kanbanState(),     inputVars: { taskCount: 5 } },
  "template-task-replenish":              { scenario: scenarios.kanbanState(),     inputVars: {} },
  "template-nightly-report":              { scenario: scenarios.releaseReady(),    inputVars: {} },
  "template-sprint-retrospective":         { scenario: scenarios.kanbanState(),     inputVars: { sprintNumber: 42 } },
  "template-weekly-fitness-summary":       { scenario: scenarios.kanbanState(),     inputVars: { lookbackDays: 7, maxFollowupTasks: 3, createFollowupTasks: true } },
  "template-build-deploy":                { scenario: scenarios.cicdDeploy(),     inputVars: { branch: "main", environment: "staging" } },
  "template-release-pipeline":            { scenario: scenarios.releaseReady(),    inputVars: { tagName: "v1.1.0", releaseBranch: "main" } },
  "template-canary-deploy":               { scenario: scenarios.cicdDeploy(),     inputVars: { branch: "main", environment: "production", promotionDelayMs: 10 } },
  "template-error-recovery":              { scenario: scenarios.greenPR(91),      inputVars: { errorType: "build-failure", taskId: "TASK-4" } },
  "template-anomaly-watchdog":            { scenario: scenarios.kanbanState(),     inputVars: {} },
  "template-workspace-hygiene":           { scenario: scenarios.greenPR(92),      inputVars: {} },
  "template-health-check":                { scenario: scenarios.greenPR(93),      inputVars: {} },
  "template-task-finalization-guard":     { scenario: scenarios.greenPR(95),      inputVars: { taskId: "TASK-5", prNumber: 95, worktreePath: "/tmp/wt/task-5", branch: "feat/task-5", baseBranch: "main" } },
  "template-task-repair-worktree":        { scenario: scenarios.greenPR(96),      inputVars: { taskId: "TASK-6", worktreePath: "/tmp/wt/task-6", branch: "feat/task-6" } },
  "template-task-orphan-worktree-recovery": { scenario: scenarios.greenPR(96),    inputVars: { repoRoot: "/workspace", baseBranch: "origin/main", maxRecoverPerSweep: 5 } },
  "template-task-status-transition-manager": { scenario: scenarios.kanbanState(), inputVars: { taskId: "TASK-1", toStatus: "inprogress" } },
  "template-incident-response":           { scenario: scenarios.greenPR(97),      inputVars: { incidentId: "INC-001", severity: "high" } },
  "template-task-archiver":               { scenario: scenarios.kanbanState(),     inputVars: {} },
  "template-sync-engine":                 { scenario: scenarios.kanbanState(),     inputVars: {} },
  "template-dependency-audit":            { scenario: scenarios.securityAudit(),   inputVars: {} },
  "template-secret-scanner":             { scenario: scenarios.securityAudit(),   inputVars: {} },
  "template-code-quality-striker":       { scenario: scenarios.greenPR(202),      inputVars: {} },
  "template-continuation-loop":         { scenario: scenarios.kanbanState(),     inputVars: { taskId: "TASK-1", worktreePath: "/tmp/wt/task-1", pollIntervalMs: 1, maxTurns: 1, stuckThresholdMs: 1, onStuck: "pause", terminalStates: ["done", "cancelled"] } },
  "template-task-lifecycle":              { scenario: scenarios.greenPR(98),      inputVars: { taskId: "TASK-7", worktreePath: "/tmp/wt/task-7", branch: "feat/task-7", baseBranch: "main", prNumber: 98 } },
  "template-task-batch-processor":        { scenario: scenarios.kanbanState(),     inputVars: { batchSize: 3 } },
  "template-task-batch-pr":              { scenario: scenarios.greenPR(99),      inputVars: { prNumber: 99, branch: "feat/batch", worktreePath: "/tmp/wt/batch", baseBranch: "main" } },
  "template-research-agent":             { scenario: scenarios.kanbanState(),     inputVars: { problem: "Prove the Pythagorean theorem", domain: "mathematics", maxIterations: 3 } },
  // Coverage templates — exercise the 31 previously-unexercised node types
  "template-webhook-task-router":        { scenario: scenarios.kanbanState(),     inputVars: { taskTags: ["priority"], webhookEventType: "task.created", requiredTag: "priority", configFile: "/nonexistent/config.json", webhookCallbackUrl: "http://localhost:65000/webhook/ack", task: { tags: ["priority"] }, webhookPayload: { title: "Priority webhook task" } } },
  "template-scheduled-maintenance":      { scenario: scenarios.greenPR(200),      inputVars: { maintenanceConfigPath: "/nonexistent/maintenance.json", targetBranch: "feat/maintenance-test", baseBranch: "origin/main" } },
  "template-mcp-research-probe":         { scenario: scenarios.kanbanState(),     inputVars: { query: "express.js middleware", mcpServer: "_test_mcp_", researchTool: "resolve-library-id", prBranch: "research/mcp-test", prBaseBranch: "main" } },
  "template-agent-execution-pipeline":   { scenario: scenarios.greenPR(201),      inputVars: { eventType: "task.assigned", taskId: "TASK-10", taskTitle: "Coverage test task", taskDescription: "Implement coverage improvements.", branch: "feat/pipeline-test", baseBranch: "origin/main", worktreePath: "/tmp/wt-pipeline-test", sessionId: "session-coverage-1", defaultSdk: "auto", finalizationWorkflow: "template-health-check" } },
  "template-flow-control-suite":         { scenario: scenarios.kanbanState(),     inputVars: { subWorkflowId: "template-health-check", maxLoopIterations: 1 } },
  "template-workflow-composition":       { scenario: scenarios.kanbanState(),     inputVars: { childWorkflowId: "template-health-check", inputPayload: "{}" } },
  "template-inline-workflow-composition": { scenario: scenarios.kanbanState(),     inputVars: { inputPayload: "{\"steps\":[\"lint\",\"test\",\"build\"],\"strict\":true}", defaultStageOwner: "bosun" } },
  "template-git-health-pipeline":        { scenario: scenarios.kanbanState(),     inputVars: { cleanupWorkflow: "template-health-check", churnThreshold: "10" } },
  "template-bosun-tool-pipeline":        { scenario: scenarios.kanbanState(),     inputVars: { targetTool: "list-todos", toolArgs: "" } },
  "template-mcp-to-bosun-bridge":        { scenario: scenarios.kanbanState(),     inputVars: { mcpServer: "github", mcpTool: "list_pull_requests", mcpInput: "{}", processingWorkflow: "" } },
  "template-mcp-iterative-research":     { scenario: scenarios.kanbanState(),     inputVars: { topics: '["node.js best practices"]', mcpServer: "context7", mcpTool: "resolve-library-id" } },
  "template-mcp-tool-chain":             { scenario: scenarios.kanbanState(),     inputVars: { mcpServer: "github", toolName: "list_pull_requests", toolInput: "{}" } },
  "template-mcp-github-pr-monitor":      { scenario: scenarios.kanbanState(),     inputVars: { owner: "virtengine", repo: "bosun", checkInterval: "*/30 * * * *", prThreshold: "5" } },
  "template-mcp-cross-server-pipeline":  { scenario: scenarios.kanbanState(),     inputVars: { githubOwner: "virtengine", githubRepo: "bosun" } },
  "template-task-fullstack":             { scenario: scenarios.greenPR(210),      inputVars: { taskId: "TASK-FS-1", worktreePath: "/tmp/wt/fullstack", branch: "feat/fullstack", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 2, maxContinues: 3, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
  "template-task-backend":               { scenario: scenarios.greenPR(211),      inputVars: { taskId: "TASK-BE-1", worktreePath: "/tmp/wt/backend", branch: "feat/backend", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 2, maxContinues: 3, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
  "template-task-frontend":              { scenario: scenarios.greenPR(212),      inputVars: { taskId: "TASK-FE-1", worktreePath: "/tmp/wt/frontend", branch: "feat/frontend", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 2, maxContinues: 3, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
  "template-task-debug":                 { scenario: scenarios.greenPR(213),      inputVars: { taskId: "TASK-DBG-1", worktreePath: "/tmp/wt/debug", branch: "fix/debug", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 3, maxContinues: 4, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
  "template-task-cicd":                  { scenario: scenarios.cicdDeploy(),      inputVars: { taskId: "TASK-CI-1", worktreePath: "/tmp/wt/cicd", branch: "feat/cicd", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 2, maxContinues: 3, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
  "template-task-design":                { scenario: scenarios.greenPR(214),      inputVars: { taskId: "TASK-DS-1", worktreePath: "/tmp/wt/design", branch: "feat/design", baseBranch: "main", taskTimeoutMs: 21600000, maxRetries: 2, maxContinues: 3, testCommand: "auto", buildCommand: "auto", lintCommand: "auto" } },
};
