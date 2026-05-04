/**
 * agents.mjs — Agent-related workflow templates.
 *
 * Templates:
 *   - Frontend Agent
 *   - Review Agent (recommended)
 *   - Custom Agent Profile
 *   - Agent Session Monitor (recommended)
 *   - Backend Agent (recommended)
 *   - Voice + Video Rollout (Parallel Lanes)
 *   - Meeting Orchestrator + Subworkflow Chain
 */

import { node, edge, resetLayout, embedSubWorkflow, wire } from "./_helpers.mjs";
import { VALIDATION_GATE_SUB, PR_CHECK_HANDOFF_SUB } from "./sub-workflows.mjs";

const AGENT_SESSION_MONITOR_COMMAND = [
  'node -e "',
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const { pathToFileURL } = require('node:url');",
  "const cwd = process.cwd();",
  "const mirrorMarker = `${path.sep}.bosun${path.sep}workspaces${path.sep}`.toLowerCase();",
  "let repoRoot = cwd;",
  "if (cwd.toLowerCase().includes(mirrorMarker)) {",
  "const sourceRepoRoot = path.resolve(cwd, '..', '..', '..', '..');",
  "if (fs.existsSync(path.join(sourceRepoRoot, 'infra', 'session-tracker.mjs'))) repoRoot = sourceRepoRoot;",
  "}",
  "const trackerModuleUrl = pathToFileURL(path.join(repoRoot, 'infra', 'session-tracker.mjs')).href;",
  "import(trackerModuleUrl).then(({ getSessionTracker }) => {",
  "const tracker = getSessionTracker();",
  "const sessions = tracker.getActiveSessions().map((session) => {",
  "const progress = tracker.getProgressStatus(session.taskId);",
  "return {",
  "id: session.taskId,",
  "taskId: session.taskId,",
  "taskTitle: session.taskTitle || null,",
  "status: progress.status,",
  "idleMs: progress.idleMs,",
  "totalEvents: progress.totalEvents,",
  "elapsedMs: progress.elapsedMs,",
  "lastEventType: progress.lastEventType,",
  "recommendation: progress.recommendation,",
  "tokenPercent: null",
  "};",
  "});",
  "console.log(JSON.stringify(sessions));",
  "}).catch((err) => { console.error(err?.stack || String(err)); process.exit(1); });",
  '"',
].join("");

const buildAgentSessionMonitorParseExpression = (rawExpression) => [
  "(() => {",
  `const raw = String(${rawExpression} || '[]');`,
  "const lines = raw.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);",
  "const candidate = lines.length ? lines[lines.length - 1] : '[]';",
  "try {",
  "const parsed = JSON.parse(candidate);",
  "return Array.isArray(parsed) ? parsed : [];",
  "} catch {",
  "return [];",
  "}",
  "})()",
].join("");

const AGENT_SESSION_MONITOR_LIST_PARSE_EXPRESSION = buildAgentSessionMonitorParseExpression(
  "$ctx.getNodeOutput('list-sessions')?.output",
);

const AGENT_SESSION_MONITOR_HEALTH_PARSE_EXPRESSION = buildAgentSessionMonitorParseExpression(
  "$ctx.getNodeOutput('check-health')?.output",
);

// ═══════════════════════════════════════════════════════════════════════════
//  Frontend Agent with Screenshot Validation
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const FRONTEND_AGENT_TEMPLATE = {
  id: "template-frontend-agent",
  name: "Frontend Agent",
  description:
    "Front-end development agent that validates work by taking screenshots, " +
    "storing them as evidence, and having an independent model verify the " +
    "implementation matches the task requirements before marking complete.",
  category: "agents",
  enabled: true,
  trigger: "trigger.task_assigned",
  variables: {
    devServerUrl: "http://localhost:3000",
    evidenceDir: ".bosun/evidence",
    screenshotCount: 3,
  },
  nodes: [
    node("trigger", "trigger.task_assigned", "Task Assigned", {
      agentType: "frontend",
      taskPattern: "feat\\(.*\\)|fix\\(.*\\)|style\\(.*\\)|ui|frontend|css|component",
    }, { x: 400, y: 50 }),

    node("select-profile", "agent.select_profile", "Select Agent Profile", {
      profiles: {
        frontend: {
          titlePatterns: ["ui", "frontend", "css", "component", "page", "layout", "style", "design"],
          tags: ["frontend", "ui", "css", "component"],
        },
        fullstack: {
          titlePatterns: ["api.*ui", "full.?stack"],
          tags: ["fullstack"],
        },
      },
      default: "frontend",
    }, { x: 400, y: 160 }),

    node("run-agent", "action.run_agent", "Run Frontend Agent", {
      prompt: `# Frontend Development Task

## Task: {{taskTitle}}

## Description
{{taskDescription}}

## Special Instructions
You are a **frontend specialist** agent. Your focus areas:
- HTML/CSS layout and styling
- JavaScript/TypeScript UI logic
- Component architecture and state management
- Responsive design and accessibility
- Visual accuracy matching design specifications

## CRITICAL: Evidence Collection
After completing your implementation:
1. Start the dev server if not running
2. Take screenshots of ALL pages/components you changed
3. Save each screenshot to \`.bosun/evidence/\` directory
4. Include screenshots of: main view, mobile view, any interactive states
5. Name files descriptively: \`homepage-desktop.png\`, \`modal-open.png\`, etc.
6. Capture at least {{screenshotCount}} key screenshots across target states/viewports.

## Workflow
1. Read task requirements carefully
2. Implement all frontend changes
3. Run \`npm run build\` to verify no errors
4. Run \`npm run lint\` to verify no warnings
5. Start dev server and screenshot all changed pages
6. Commit and push

## Do NOT mark task complete yourself — the validation workflow handles that.`,
      sdk: "auto",
      cwd: "{{worktreePath}}",
      timeoutMs: 7200000,
      agentProfile: "frontend",
    }, { x: 400, y: 280 }),

    node("verify-build", "validation.build", "Verify Build", {
      command: "npm run build",
      cwd: "{{worktreePath}}",
      zeroWarnings: true,
    }, { x: 150, y: 420 }),

    node("verify-lint", "validation.lint", "Verify Lint", {
      command: "npm run lint",
      cwd: "{{worktreePath}}",
    }, { x: 650, y: 420 }),

    node("screenshot-desktop", "validation.screenshot", "Screenshot Desktop", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "desktop-{{taskId}}.png",
      viewport: { width: 1920, height: 1080 },
    }, { x: 100, y: 560 }),

    node("screenshot-tablet", "validation.screenshot", "Screenshot Tablet", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "tablet-{{taskId}}.png",
      viewport: { width: 768, height: 1024 },
    }, { x: 400, y: 560 }),

    node("screenshot-mobile", "validation.screenshot", "Screenshot Mobile", {
      url: "{{devServerUrl}}",
      outputDir: "{{evidenceDir}}",
      filename: "mobile-{{taskId}}.png",
      viewport: { width: 375, height: 812 },
    }, { x: 700, y: 560 }),

    node("collect-evidence", "agent.evidence_collect", "Collect Evidence", {
      evidenceDir: "{{evidenceDir}}",
    }, { x: 400, y: 700 }),

    node("model-review", "validation.model_review", "Model Verification", {
      evidenceDir: "{{evidenceDir}}",
      originalTask: "{{taskTitle}}: {{taskDescription}}",
      criteria: "Visual implementation matches requirements. No broken layouts. Responsive design works across viewports. No console errors visible.",
      strictMode: true,
    }, { x: 400, y: 840 }),

    node("check-review", "condition.expression", "Review Passed?", {
      expression: "$output?.model_review?.passed === true || $data?.modelReviewPassed === true",
    }, { x: 400, y: 960 }),

    node("mark-success", "action.update_task_status", "Mark Task Done", {
      taskId: "{{taskId}}",
      status: "done",
    }, { x: 200, y: 1080 }),

    node("notify-success", "notify.telegram", "Notify Success", {
      message: ":check: Frontend task **{{taskTitle}}** passed visual verification and is complete.",
    }, { x: 200, y: 1200 }),

    node("notify-failure", "notify.telegram", "Notify Review Failed", {
      message: "❌ Frontend task **{{taskTitle}}** failed visual verification.\n" +
        "Evidence dir: `{{evidenceDir}}`\n" +
        "Reason: `{{model-review.reason}}`\n" +
        "Evidence count: `{{model-review.evidenceCount}}`\n" +
        "Review output: {{model-review.reviewOutput}}",
    }, { x: 600, y: 1080 }),

    node("log-failure", "notify.log", "Log Failure", {
      message: "Frontend verification failed for {{taskId}}: evidenceDir={{evidenceDir}} reason={{model-review.reason}} evidenceCount={{model-review.evidenceCount}}",
      level: "warn",
    }, { x: 600, y: 1200 }),
  ],
  edges: [
    edge("trigger", "select-profile"),
    edge("select-profile", "run-agent"),
    edge("run-agent", "verify-build"),
    edge("run-agent", "verify-lint"),
    edge("verify-build", "screenshot-desktop"),
    edge("verify-build", "screenshot-tablet"),
    edge("verify-build", "screenshot-mobile"),
    edge("verify-lint", "screenshot-desktop"),
    edge("screenshot-desktop", "collect-evidence"),
    edge("screenshot-tablet", "collect-evidence"),
    edge("screenshot-mobile", "collect-evidence"),
    edge("collect-evidence", "model-review"),
    edge("model-review", "check-review"),
    edge("check-review", "mark-success", { condition: "$output?.result === true" }),
    edge("check-review", "notify-failure", { condition: "$output?.result !== true" }),
    edge("mark-success", "notify-success"),
    edge("notify-failure", "log-failure"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["frontend", "agent", "validation", "screenshot"],
    replaces: {
      module: "agent-hooks.mjs",
      functions: ["screenshotValidation", "evidenceCollection"],
      calledFrom: ["monitor.mjs:startFreshSession"],
      description: "Replaces hardcoded frontend agent profile with a visual workflow. " +
        "Screenshot capture, model verification, and evidence collection are explicit steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Review Agent (automated PR review)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const REVIEW_AGENT_TEMPLATE = {
  id: "template-review-agent",
  name: "Review Agent",
  description:
    "Automatically runs code review when a PR is opened or updated. " +
    "Checks build, tests, and code quality, then posts review comments.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {},
  nodes: [
    node("trigger", "trigger.pr_event", "PR Opened/Updated", {
      event: "opened",
    }, { x: 400, y: 50 }),

    node("run-build", "validation.build", "Run Build", {
      command: "npm run build",
    }, { x: 200, y: 200 }),

    node("run-tests", "validation.tests", "Run Tests", {
      command: "npm test",
    }, { x: 600, y: 200 }),

    node("run-review", "action.run_agent", "Agent Review", {
      prompt: `# Code Review

Review the changes in the current branch. Check for:
1. Code quality and best practices
2. Potential bugs or edge cases
3. Test coverage for new features
4. Documentation updates if needed

Provide a structured review with specific file:line references.`,
      timeoutMs: 900000,
    }, { x: 400, y: 350 }),

    node("aggregate", "transform.aggregate", "Collect Results", {
      sources: ["run-build", "run-tests", "run-review"],
    }, { x: 400, y: 500 }),

    node("notify", "notify.telegram", "Post Review", {
      message: ":edit: PR review complete for {{branch}}",
    }, { x: 400, y: 640 }),
  ],
  edges: [
    edge("trigger", "run-build"),
    edge("trigger", "run-tests"),
    edge("run-build", "run-review"),
    edge("run-tests", "run-review"),
    edge("run-review", "aggregate"),
    edge("aggregate", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["review", "pr", "automation"],
    replaces: {
      module: "review-agent.mjs",
      functions: ["ReviewAgent.runReview", "createReviewAgent"],
      calledFrom: ["monitor.mjs:checkEpicBranches"],
      description: "Replaces the ReviewAgent class with a visual workflow. " +
        "Build, test, and AI review steps run in parallel with results aggregated.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Custom Agent Profile (starter template)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const CUSTOM_AGENT_TEMPLATE = {
  id: "template-custom-agent",
  name: "Custom Agent Profile",
  description:
    "Starter template for creating a custom agent profile with " +
    "configurable validation, notification, and completion gates. " +
    "Duplicate and customize to match your specific workflow.",
  category: "agents",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    agentName: "my-custom-agent",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start", {}, { x: 400, y: 50 }),

    node("set-context", "action.set_variable", "Set Context", {
      key: "agentProfile",
      value: "{{agentName}}",
    }, { x: 400, y: 180 }),

    node("run-agent", "action.run_agent", "Run Agent", {
      prompt: "# Custom Agent Task\n\nTask: {{taskTitle}}\n{{taskDescription}}",
      sdk: "auto",
    }, { x: 400, y: 310 }),

    node("verify", "validation.tests", "Run Verification", {
      command: "npm test",
    }, { x: 400, y: 440 }),

    node("check-result", "condition.expression", "Passed?", {
      expression: "$ctx.getNodeOutput('verify')?.passed === true",
    }, { x: 400, y: 570 }),

    node("complete", "action.update_task_status", "Mark Complete", {
      taskId: "{{taskId}}",
      status: "done",
    }, { x: 200, y: 700 }),

    node("fail-notify", "notify.log", "Log Failure", {
      message: "Custom agent verification failed for {{taskId}}",
      level: "warn",
    }, { x: 600, y: 700 }),
  ],
  edges: [
    edge("trigger", "set-context"),
    edge("set-context", "run-agent"),
    edge("run-agent", "verify"),
    edge("verify", "check-result"),
    edge("check-result", "complete", { condition: "$output?.result === true" }),
    edge("check-result", "fail-notify", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["custom", "agent", "starter"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Agent Session Monitor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const AGENT_SESSION_MONITOR_TEMPLATE = {
  id: "template-agent-session-monitor",
  name: "Agent Session Monitor",
  description:
    "Monitors active agent sessions for timeouts, excessive token usage, " +
    "or inactivity. Auto-continues stalled agents or escalates hung ones.",
  category: "agents",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    checkIntervalMs: 300000,
    maxIdleMs: 600000,
    maxTokenPercent: 85,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Check Every 5min", {
      intervalMs: "{{checkIntervalMs}}",
      cron: "*/5 * * * *",
    }, { x: 400, y: 50 }),

    node("list-sessions", "action.run_command", "List Active Sessions", {
      command: AGENT_SESSION_MONITOR_COMMAND,
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("has-active", "condition.expression", "Any Active?", {
      expression: `${AGENT_SESSION_MONITOR_LIST_PARSE_EXPRESSION}.length > 0`,
    }, { x: 400, y: 340 }),

    node("check-health", "action.run_command", "Check Session Health", {
      command: AGENT_SESSION_MONITOR_COMMAND,
      continueOnError: true,
    }, { x: 200, y: 490 }),

    node("has-issues", "condition.expression", "Any Unhealthy?", {
      expression: `(() => { const sessions = ${AGENT_SESSION_MONITOR_HEALTH_PARSE_EXPRESSION}; const maxIdleMs = Number($data?.maxIdleMs || 600000); const maxTokenPercent = Number($data?.maxTokenPercent || 85); return sessions.some((item) => { const status = String(item?.status || '').toLowerCase(); const idleMs = Number(item?.idleMs || 0); const tokenPercent = Number(item?.tokenPercent); return status === 'idle' || status === 'stalled' || status === 'timeout' || idleMs > maxIdleMs || (Number.isFinite(tokenPercent) && tokenPercent >= maxTokenPercent); }); })()`,
    }, { x: 200, y: 640 }),

    node("auto-continue", "action.continue_session", "Auto-Continue Stalled", {
      prompt: "You appear to have stalled. Please continue working on the current task.",
      strategy: "continue",
      timeoutMs: 300000,
    }, { x: 100, y: 800 }),

    node("alert-hung", "notify.telegram", "Alert Hung Sessions", {
      message: ":dot: Agent session appears hung — auto-continue attempted. Check status.",
    }, { x: 100, y: 950 }),

    node("all-healthy", "notify.log", "Sessions Healthy", {
      message: "All active agent sessions are healthy",
      level: "info",
    }, { x: 450, y: 640 }),

    node("no-sessions", "notify.log", "No Active Sessions", {
      message: "No active agent sessions to monitor",
      level: "info",
    }, { x: 600, y: 490 }),
  ],
  edges: [
    edge("trigger", "list-sessions"),
    edge("list-sessions", "has-active"),
    edge("has-active", "check-health", { condition: "$output?.result === true" }),
    edge("has-active", "no-sessions", { condition: "$output?.result !== true" }),
    edge("check-health", "has-issues"),
    edge("has-issues", "auto-continue", { condition: "$output?.result === true" }),
    edge("has-issues", "all-healthy", { condition: "$output?.result !== true" }),
    edge("auto-continue", "alert-hung"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["agent", "monitor", "session", "health"],
    replaces: {
      module: "session-tracker.mjs",
      functions: ["SessionTracker.checkHealth", "pollAgentAlerts"],
      calledFrom: ["monitor.mjs:startAgentAlertTailer"],
      description: "Replaces hardcoded agent session monitoring with a visual " +
        "workflow. Health checks, stall detection, and auto-continuation " +
        "are configurable workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Completion Agent
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BACKEND_AGENT_TEMPLATE = (() => {
  resetLayout();

  // ── Embed sub-workflows ────────────────────────────────────────────────
  const mainValidation = embedSubWorkflow(VALIDATION_GATE_SUB, "main-");
  const retryValidation = embedSubWorkflow(VALIDATION_GATE_SUB, "retry-");
  const retry2Validation = embedSubWorkflow(VALIDATION_GATE_SUB, "retry2-");
  const mainPrHandoff = embedSubWorkflow(PR_CHECK_HANDOFF_SUB, "main-");
  const retryPrHandoff = embedSubWorkflow(PR_CHECK_HANDOFF_SUB, "retry-");
  const retry2PrHandoff = embedSubWorkflow(PR_CHECK_HANDOFF_SUB, "retry2-");

  return {
    id: "template-backend-agent",
    name: "Task Completion Agent",
    description:
      "General-purpose task completion agent with a test-first methodology. " +
      "Writes tests first, implements the feature, validates with build + lint, " +
      "then creates a PR. Works with any language/framework — commands are " +
      "auto-detected from your project or fully customizable.",
    category: "agents",
    enabled: true,
    recommended: true,
    trigger: "trigger.task_assigned",
    variables: {
      testCommand: "npm test",
      buildCommand: "npm run build",
      lintCommand: "",
      baseBranch: "main",
      protectedBranches: ["main", "master", "develop", "production"],
      agentSdk: "auto",
      timeoutMs: 3600000,
      testTimeoutMs: 1800000,
      autoFixTimeoutMs: 1200000,
    },
    nodes: [
      node("trigger", "trigger.task_assigned", "Task Assigned", {
      }, { x: 400, y: 50 }),

      node("plan-work", "action.run_agent", "Plan Implementation", {
        prompt: "Analyze the task requirements and create a step-by-step implementation plan. Identify which files need to be modified, what tests need to be written, and any API contracts to maintain.",
        outputVariable: "plan",
        mode: "plan",
        executionRole: "architect",
        repoMapQuery: "{{taskTitle}} {{taskDescription}}",
        repoMapFileLimit: 8,
        sdk: "{{agentSdk}}",
        timeoutMs: "{{timeoutMs}}",
      }, { x: 400, y: 180 }),

      node("write-tests", "action.run_agent", "Write Tests First", {
        prompt: `# Test-First Development

Based on the plan:
{{plan}}

Write comprehensive tests FIRST before any implementation:
1. Unit tests for new functions/methods
2. Integration tests for API endpoints if applicable
3. Edge cases and error scenarios

Use the project's test command: {{testCommand}}
Create a descriptive test commit message that names the behavior or surface covered.
Example: "test: cover portal login validation"`,
        sdk: "{{agentSdk}}",
  timeoutMs: "{{testTimeoutMs}}",
      }, { x: 400, y: 330 }),

      node("implement", "action.run_agent", "Implement Feature", {
        prompt: `# Implement Feature

The tests have been written. Now implement the feature to make them pass:
1. Follow existing code conventions
2. Add proper error handling
3. Ensure all new tests pass
4. Do NOT modify the tests — make the code fit the contract

Run \`{{testCommand}}\` after implementation.
Create a descriptive feat/fix commit message that names the shipped capability.
Example: "feat: add portal login rate limiting"`,
        sdk: "{{agentSdk}}",
        timeoutMs: "{{timeoutMs}}",
      }, { x: 400, y: 490 }),

      // ── Main Validation Gate (build → test → lint) via sub-workflow ────
      ...mainValidation.nodes,

      node("all-passed", "condition.expression", "All Checks Passed?", {
        expression: `$ctx.getNodeOutput('main-build')?.passed === true && $ctx.getNodeOutput('main-test')?.passed === true && $ctx.getNodeOutput('main-lint')?.passed === true`,
      }, { x: 400, y: 1040, outputs: ["yes", "no"] }),

      // ── Main Push + PR path ────────────────────────────────────────────
      node("push-branch", "action.push_branch", "Push Branch", {
        worktreePath: "{{worktreePath}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        rebaseBeforePush: false,
        mergeBaseBeforePush: true,
        autoResolveMergeConflicts: true,
        conflictResolverSdk: "{{agentSdk}}",
        emptyDiffGuard: true,
        protectedBranches: "{{protectedBranches}}",
      }, { x: 250, y: 1110 }),

      node("push-ok", "condition.expression", "Push OK?", {
        expression: "$ctx.getNodeOutput('push-branch')?.pushed === true",
      }, { x: 250, y: 1170, outputs: ["yes", "no"] }),

      node("create-pr", "action.create_pr", "Handoff PR Lifecycle", {
        title: "feat: {{taskTitle}}",
        body: "## Summary\n\n{{taskDescription}}\n\n## Approach\n\nTest-first methodology: tests written before implementation.\n\n### Plan\n\n{{plan}}\n\n## Validation\n\nAll checks passing (build, test, lint).\n\n---\nTask-ID: {{taskId}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        failOnError: true,
        maxRetries: 3,
        retryDelayMs: 15000,
        continueOnError: true,
      }, { x: 250, y: 1170 }),

      // ── Main PR handoff (pr-ok? → set-inreview → dispatch) via sub-wf ─
      ...mainPrHandoff.nodes,

      node("notify-done", "notify.log", "Task Complete", {
        message: "Task completion agent finished task — PR lifecycle handoff recorded",
        level: "info",
      }, { x: 180, y: 1320 }),

      node("notify-pr-failed", "notify.telegram", "Escalate Lifecycle Handoff Failure", {
        message: ":alert: Task completion agent passed validation for {{taskTitle}} but failed to record Bosun PR lifecycle handoff after retries. Manual follow-up required.",
      }, { x: 420, y: 1320 }),

      // ── Retry path (validation failed → auto-fix → re-validate) ───────
      node("set-validation-summary", "action.set_variable", "Summarize Validation Output", {
        key: "validationSummary",
        value: [
          "(() => {",
          "function fmtGate(label, out) {",
          "  if (!out || !Object.keys(out).length) return label + ': (not run)';",
          "  const diag = out.outputDiagnostics || {};",
          "  const lines = [label + ': ' + (out.passed === true ? 'PASSED' : 'FAILED')];",
          "  if (diag.summary) lines.push('  Summary: ' + diag.summary);",
          "  const targets = diag.failedTargets || [];",
          "  if (targets.length) {",
          "    lines.push('  Failed targets (' + targets.length + '):');",
          "    targets.slice(0, 20).forEach(t => lines.push('    - ' + t));",
          "    if (targets.length > 20) lines.push('    ... and ' + (targets.length - 20) + ' more');",
          "  }",
          "  const rerun = out.outputSuggestedRerun || diag.suggestedRerun || '';",
          "  if (rerun) lines.push('  Rerun: `' + rerun + '`');",
          "  const hint = out.outputHint || diag.hint || '';",
          "  if (hint) lines.push('  Hint: ' + hint);",
          "  if (out.output) lines.push('  Output:\\n' + String(out.output).slice(0, 5000));",
          "  return lines.join('\\n');",
          "}",
          "const build = $ctx.getNodeOutput('main-build') || {};",
          "const test = $ctx.getNodeOutput('main-test') || {};",
          "const lint = $ctx.getNodeOutput('main-lint') || {};",
          "return [",
          "  '## Validation Results',",
          "  '',",
          "  fmtGate('Build', build),",
          "  '',",
          "  fmtGate('Test', test),",
          "  '',",
          "  fmtGate('Lint', lint),",
          "].join('\\n');",
          "})()",
        ].join(" "),
        isExpression: true,
      }, { x: 620, y: 1090 }),

      node("auto-fix", "action.run_agent", "Auto-Fix Validation Failures", {
        prompt: `# Fix Validation Failures — Pass 1

The first validation pass failed for task **{{taskTitle}}**.

Plan:
{{plan}}

{{validationSummary}}

STRATEGY:
1. Look at which gates failed (Build / Test / Lint) and focus on those.
2. Check the **Failed Targets** — these are the exact tests/files/packages that broke.
3. Fix compilation errors first, then test failures, then lint issues.
4. Use the **Suggested Rerun Command** (if shown) to iterate on just the failing targets.
5. Once targeted failures pass, run all three gates to confirm everything is green.

RULES:
- Do NOT weaken, remove, or bypass tests.
- Keep the original task scope.
- Create a descriptive fix commit message that names the concrete failure resolved.`,
        sdk: "{{agentSdk}}",
        timeoutMs: "{{autoFixTimeoutMs}}",
      }, { x: 620, y: 1170 }),

      // ── Retry Validation Gate (build → test → lint) via sub-workflow ───
      ...retryValidation.nodes,

      node("retry-passed", "condition.expression", "Retry Checks Passed?", {
        expression: `$ctx.getNodeOutput('retry-build')?.passed === true && $ctx.getNodeOutput('retry-test')?.passed === true && $ctx.getNodeOutput('retry-lint')?.passed === true`,
      }, { x: 620, y: 1690, outputs: ["yes", "no"] }),

      // ── Retry Push + PR path ───────────────────────────────────────────
      node("push-branch-retry", "action.push_branch", "Push Branch (Retry)", {
        worktreePath: "{{worktreePath}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        rebaseBeforePush: false,
        mergeBaseBeforePush: true,
        autoResolveMergeConflicts: true,
        conflictResolverSdk: "{{agentSdk}}",
        emptyDiffGuard: true,
        protectedBranches: "{{protectedBranches}}",
      }, { x: 450, y: 1760 }),

      node("push-ok-retry", "condition.expression", "Push OK? (Retry)", {
        expression: "$ctx.getNodeOutput('push-branch-retry')?.pushed === true",
      }, { x: 450, y: 1820, outputs: ["yes", "no"] }),

      node("create-pr-retry", "action.create_pr", "Handoff PR Lifecycle (After Retry)", {
        title: "feat: {{taskTitle}}",
        body: "## Summary\n\n{{taskDescription}}\n\n## Approach\n\nTest-first methodology with one automated remediation pass.\n\n### Plan\n\n{{plan}}\n\n## Validation\n\nAll checks passing after auto-fix remediation.\n\n---\nTask-ID: {{taskId}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        failOnError: true,
        maxRetries: 3,
        retryDelayMs: 15000,
        continueOnError: true,
      }, { x: 450, y: 1820 }),

      // ── Retry PR handoff via sub-workflow ──────────────────────────────
      ...retryPrHandoff.nodes,

      node("notify-done-retry", "notify.log", "Task Complete (After Retry)", {
        message: "Task completion agent finished task after retry — PR lifecycle handoff recorded",
        level: "info",
      }, { x: 360, y: 1980 }),

      // ── Retry-2 path (2nd remediation: escalated context) ─────────────
      node("set-retry2-summary", "action.set_variable", "Summarize Retry-1 Output", {
        key: "retry2Summary",
        value: [
          "(() => {",
          "function fmtGate(label, out) {",
          "  if (!out || !Object.keys(out).length) return label + ': (not run)';",
          "  const diag = out.outputDiagnostics || {};",
          "  const lines = [label + ': ' + (out.passed === true ? 'PASSED' : 'FAILED')];",
          "  if (diag.summary) lines.push('  Summary: ' + diag.summary);",
          "  const targets = diag.failedTargets || [];",
          "  if (targets.length) {",
          "    lines.push('  Failed (' + targets.length + '):');",
          "    targets.slice(0, 15).forEach(t => lines.push('    - ' + t));",
          "    if (targets.length > 15) lines.push('    ... +' + (targets.length - 15) + ' more');",
          "  }",
          "  const rerun = out.outputSuggestedRerun || diag.suggestedRerun || '';",
          "  if (rerun) lines.push('  Rerun: `' + rerun + '`');",
          "  if (diag.deltaSummary) lines.push('  Delta: ' + diag.deltaSummary);",
          "  if (out.output) lines.push('  Output:\\n' + String(out.output).slice(0, 3500));",
          "  return lines.join('\\n');",
          "}",
          "const b1 = $ctx.getNodeOutput('main-build') || {};",
          "const t1 = $ctx.getNodeOutput('main-test') || {};",
          "const l1 = $ctx.getNodeOutput('main-lint') || {};",
          "const b2 = $ctx.getNodeOutput('retry-build') || {};",
          "const t2 = $ctx.getNodeOutput('retry-test') || {};",
          "const l2 = $ctx.getNodeOutput('retry-lint') || {};",
          "return [",
          "  '## Validation History (both passes failed)',",
          "  '',",
          "  '### Pass 1 \u2014 Original',",
          "  fmtGate('Build', b1), fmtGate('Test', t1), fmtGate('Lint', l1),",
          "  '',",
          "  '### Pass 2 \u2014 After First Auto-Fix',",
          "  fmtGate('Build', b2), fmtGate('Test', t2), fmtGate('Lint', l2),",
          "].join('\\n');",
          "})()",
        ].join(" "),
        isExpression: true,
      }, { x: 820, y: 1820 }),

      node("auto-fix-2", "action.run_agent", "Auto-Fix (Escalated, Pass 2)", {
        prompt: `# Fix Validation Failures — FINAL AUTOMATED ATTEMPT

This is the SECOND and LAST automated remediation pass for task **{{taskTitle}}**.
The first auto-fix attempt DID NOT resolve all issues. You MUST take a different approach.

Plan:
{{plan}}

{{retry2Summary}}

ANALYSIS STEPS:
1. Compare **Failed Targets** between Pass 1 and Pass 2.
   - Same targets still failing → previous fix was wrong, try a different approach.
   - New targets appearing → previous fix broke something else, fix both.
   - Some resolved → partially right, focus on remaining.
2. Check the **Delta** field to see what changed between runs.
3. Use the **Rerun** command to iterate on just the failing targets.

CRITICAL RULES:
- Do NOT repeat the same fix that already failed.
- If a test is genuinely wrong or testing stale behavior, fix the test AND the code.
- If build/lint/test configs are misconfigured, fix the config.
- Do NOT weaken, remove, or skip tests. Do NOT add --force or --no-verify flags.
- Keep the original task scope — do not revert the feature.

Run build + tests + lint locally and confirm ALL pass before finishing.
Create a descriptive commit: "fix: <concrete failure resolved>"`,
        sdk: "{{agentSdk}}",
        timeoutMs: "{{autoFixTimeoutMs}}",
      }, { x: 820, y: 1900 }),

      // ── Retry-2 Validation Gate via sub-workflow ───────────────────────
      ...retry2Validation.nodes,

      node("retry2-passed", "condition.expression", "Retry-2 Checks Passed?", {
        expression: `$ctx.getNodeOutput('retry2-build')?.passed === true && $ctx.getNodeOutput('retry2-test')?.passed === true && $ctx.getNodeOutput('retry2-lint')?.passed === true`,
      }, { x: 820, y: 2400, outputs: ["yes", "no"] }),

      // ── Retry-2 Push + PR path ─────────────────────────────────────────
      node("push-branch-retry2", "action.push_branch", "Push Branch (Retry 2)", {
        worktreePath: "{{worktreePath}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        rebaseBeforePush: false,
        mergeBaseBeforePush: true,
        autoResolveMergeConflicts: true,
        conflictResolverSdk: "{{agentSdk}}",
        emptyDiffGuard: true,
        protectedBranches: "{{protectedBranches}}",
      }, { x: 650, y: 2470 }),

      node("push-ok-retry2", "condition.expression", "Push OK? (Retry 2)", {
        expression: "$ctx.getNodeOutput('push-branch-retry2')?.pushed === true",
      }, { x: 650, y: 2530, outputs: ["yes", "no"] }),

      node("create-pr-retry2", "action.create_pr", "Handoff PR Lifecycle (After Retry 2)", {
        title: "feat: {{taskTitle}}",
        body: "## Summary\n\n{{taskDescription}}\n\n## Approach\n\nTest-first methodology with two automated remediation passes.\n\n### Plan\n\n{{plan}}\n\n## Validation\n\nAll checks passing after 2nd remediation round.\n\n---\nTask-ID: {{taskId}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        failOnError: true,
        maxRetries: 3,
        retryDelayMs: 15000,
        continueOnError: true,
      }, { x: 650, y: 2530 }),

      // ── Retry-2 PR handoff via sub-workflow ────────────────────────────
      ...retry2PrHandoff.nodes,

      node("notify-done-retry2", "notify.log", "Task Complete (After Retry 2)", {
        message: "Task completion agent finished task after 2nd retry — PR lifecycle handoff recorded",
        level: "info",
      }, { x: 560, y: 2690 }),

      // ── Final failure: block task to stop re-dispatch loop ─────────────
      node("set-blocked-validation", "action.update_task_status", "Block Task (Validation Exhausted)", {
        taskId: "{{taskId}}",
        status: "blocked",
        taskTitle: "{{taskTitle}}",
        blockedReason: "Validation failed after 2 automated remediation passes",
      }, { x: 1020, y: 2470 }),

      node("notify-fail", "notify.telegram", "Checks Failed (Exhausted)", {
        message: ":alert: Backend agent: validation failed for task {{taskTitle}} even after 2 remediation passes. Task blocked — manual review needed.",
      }, { x: 1020, y: 2560 }),

      node("notify-pr-failed-retry", "notify.telegram", "Escalate Lifecycle Failure (Retry Path)", {
        message: ":alert: Task completion agent remediation passed for {{taskTitle}} but Bosun PR lifecycle handoff failed after retries. Manual follow-up required.",
      }, { x: 620, y: 1980 }),

      node("notify-pr-failed-retry2", "notify.telegram", "Escalate Lifecycle Failure (Retry 2)", {
        message: ":alert: Task completion agent 2nd remediation passed for {{taskTitle}} but Bosun PR lifecycle handoff failed. Manual follow-up required.",
      }, { x: 820, y: 2690 }),
    ],
    edges: [
      edge("trigger", "plan-work"),
      edge("plan-work", "write-tests"),
      edge("write-tests", "implement"),

      // implement → main validation gate
      wire("implement", mainValidation.entryNodeId),
      ...mainValidation.edges,
      wire(mainValidation.exitNodeId, "all-passed"),

      // Main pass → push → PR → handoff
      edge("all-passed", "push-branch", { condition: "$output?.result === true", port: "yes" }),
      edge("all-passed", "set-validation-summary", { condition: "$output?.result !== true", port: "no" }),
      edge("push-branch", "push-ok"),
      edge("push-ok", "create-pr", { condition: "$output?.result === true", port: "yes" }),
      edge("push-ok", "notify-pr-failed", { condition: "$output?.result !== true", port: "no" }),
      wire("create-pr", mainPrHandoff.entryNodeId),
      ...mainPrHandoff.edges,
      wire(mainPrHandoff.exitNodeId, "notify-done"),
      edge(mainPrHandoff.entryNodeId, "notify-pr-failed", { condition: "$output?.result !== true", port: "no" }),

      // Retry path: auto-fix → retry validation → push → PR → handoff
      edge("set-validation-summary", "auto-fix"),
      wire("auto-fix", retryValidation.entryNodeId),
      ...retryValidation.edges,
      wire(retryValidation.exitNodeId, "retry-passed"),

      edge("retry-passed", "push-branch-retry", { condition: "$output?.result === true", port: "yes" }),
      edge("retry-passed", "set-retry2-summary", { condition: "$output?.result !== true", port: "no" }),
      edge("push-branch-retry", "push-ok-retry"),
      edge("push-ok-retry", "create-pr-retry", { condition: "$output?.result === true", port: "yes" }),
      edge("push-ok-retry", "notify-pr-failed-retry", { condition: "$output?.result !== true", port: "no" }),
      wire("create-pr-retry", retryPrHandoff.entryNodeId),
      ...retryPrHandoff.edges,
      wire(retryPrHandoff.exitNodeId, "notify-done-retry"),
      edge(retryPrHandoff.entryNodeId, "notify-pr-failed-retry", { condition: "$output?.result !== true", port: "no" }),

      // Retry-2 path: escalated auto-fix → retry2 validation → push → PR → handoff
      edge("set-retry2-summary", "auto-fix-2"),
      wire("auto-fix-2", retry2Validation.entryNodeId),
      ...retry2Validation.edges,
      wire(retry2Validation.exitNodeId, "retry2-passed"),

      edge("retry2-passed", "push-branch-retry2", { condition: "$output?.result === true", port: "yes" }),
      edge("retry2-passed", "set-blocked-validation", { condition: "$output?.result !== true", port: "no" }),
      edge("set-blocked-validation", "notify-fail"),
      edge("push-branch-retry2", "push-ok-retry2"),
      edge("push-ok-retry2", "create-pr-retry2", { condition: "$output?.result === true", port: "yes" }),
      edge("push-ok-retry2", "notify-pr-failed-retry2", { condition: "$output?.result !== true", port: "no" }),
      wire("create-pr-retry2", retry2PrHandoff.entryNodeId),
      ...retry2PrHandoff.edges,
      wire(retry2PrHandoff.exitNodeId, "notify-done-retry2"),
      edge(retry2PrHandoff.entryNodeId, "notify-pr-failed-retry2", { condition: "$output?.result !== true", port: "no" }),
    ],
    metadata: {
      author: "bosun",
      version: 4,
      createdAt: "2025-02-25T00:00:00Z",
      templateVersion: "3.1.0",
      tags: ["agent", "task-completion", "test-first", "tdd", "multi-language", "multi-remediation"],
      replaces: {
        module: "primary-agent.mjs",
        functions: ["runAgentWithTask"],
        calledFrom: ["task-executor.mjs:executeTask"],
        description:
          "Replaces generic agent task execution with a structured " +
          "workflow. Test-first methodology, build/lint gates, and Bosun-managed PR lifecycle handoff " +
          "are enforced as distinct workflow stages. Works with any language/framework.",
      },
    },
  };
})();

// ═══════════════════════════════════════════════════════════════════════════
//  Voice + Video Rollout (Parallel Lanes)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const VOICE_VIDEO_PARALLEL_ROLLOUT_TEMPLATE = {
  id: "template-voice-video-parallel-rollout",
  name: "Voice + Video Rollout (Parallel Lanes)",
  description:
    "Launches three agent lanes in parallel (capture pipeline, provider adapters, " +
    "and QA/rollout hardening) to accelerate Voice + Video delivery while keeping " +
    "workstreams isolated by worktree.",
  category: "agents",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    lane1Worktree: "{{worktreePath}}",
    lane2Worktree: "{{worktreePath}}",
    lane3Worktree: "{{worktreePath}}",
    integrationBranch: "feat/voice-video-integration",
    definitionOfDone:
      "Voice + vision works end-to-end, provider fallback is explicit, and tests cover config + transport + failure paths.",
  },
  nodes: [
    node("trigger", "trigger.manual", "Launch Parallel Rollout", {}, { x: 500, y: 50 }),

    node("check-worktrees", "condition.expression", "Worktrees Distinct?", {
      expression:
        "(() => { " +
        "const a = String($data?.lane1Worktree || '').trim(); " +
        "const b = String($data?.lane2Worktree || '').trim(); " +
        "const c = String($data?.lane3Worktree || '').trim(); " +
        "if (!a || !b || !c) return false; " +
        "return new Set([a, b, c]).size === 3; " +
        "})()",
    }, { x: 500, y: 170 }),

    node("notify-worktree-error", "notify.telegram", "Invalid Worktree Setup", {
      message:
        "Parallel rollout aborted. Configure three distinct worktrees in " +
        "`lane1Worktree`, `lane2Worktree`, and `lane3Worktree` before launching.",
    }, { x: 860, y: 170 }),

    node("kickoff-log", "notify.log", "Kickoff Parallel Lanes", {
      message:
        "Starting parallel rollout on branch {{integrationBranch}} with 3 lanes.",
      level: "info",
    }, { x: 500, y: 290 }),

    node("lane-capture-core", "action.run_agent", "Lane 1: Capture Core", {
      prompt:
        "# Lane 1 - Capture Core\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Voice video config/schema/env/settings keys\n" +
        "2. Browser capture loop (screen/camera), adaptive FPS, compression, change detection\n" +
        "3. Overlay controls + capture state indicators\n\n" +
        "Guardrails:\n" +
        "- Do not touch provider dispatch code owned by Lane 2\n" +
        "- Keep changes bounded to UI/config paths\n" +
        "- Add/extend tests for capture throttling and config behavior\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane1Worktree}}",
      timeoutMs: 5400000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 120, y: 450 }),

    node("lane-provider-bridge", "action.run_agent", "Lane 2: Provider Bridge", {
      prompt:
        "# Lane 2 - Provider Bridge\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Server-side vision frame ingress route and validation\n" +
        "2. Provider dispatch in voice relay (OpenAI image path, Gemini live path, Claude vision path)\n" +
        "3. Rate-limits, payload caps, and fallback semantics\n\n" +
        "Guardrails:\n" +
        "- Do not edit overlay/capture UI owned by Lane 1\n" +
        "- Keep provider logic behind explicit feature flags\n" +
        "- Add/extend tests for endpoint validation and provider routing\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane2Worktree}}",
      timeoutMs: 5400000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 500, y: 450 }),

    node("lane-hardening", "action.run_agent", "Lane 3: QA + Rollout", {
      prompt:
        "# Lane 3 - QA + Rollout Hardening\n\n" +
        "Work only in this lane's worktree. Focus on:\n" +
        "1. Integration tests, resilience tests, and docs updates\n" +
        "2. Migration/rollout notes and operator controls\n" +
        "3. Conflict-free merge guidance across Lane 1 and Lane 2 outputs\n\n" +
        "Guardrails:\n" +
        "- Avoid touching core capture loop and provider dispatch internals unless a test proves breakage\n" +
        "- Keep this lane focused on verification, docs, and release safety\n" +
        "- Produce a concise verification summary\n\n" +
        "Target branch: {{integrationBranch}}\n" +
        "Definition of done: {{definitionOfDone}}",
      sdk: "auto",
      cwd: "{{lane3Worktree}}",
      timeoutMs: 3600000,
      includeTaskContext: false,
      failOnError: true,
    }, { x: 880, y: 450 }),

    node("aggregate", "transform.aggregate", "Aggregate Lane Results", {
      sources: ["lane-capture-core", "lane-provider-bridge", "lane-hardening"],
    }, { x: 500, y: 640 }),

    node("all-passed", "condition.expression", "All Lanes Passed?", {
      expression:
        "$ctx.getNodeOutput('lane-capture-core')?.success === true && " +
        "$ctx.getNodeOutput('lane-provider-bridge')?.success === true && " +
        "$ctx.getNodeOutput('lane-hardening')?.success === true",
    }, { x: 500, y: 770 }),

    node("notify-success", "notify.telegram", "Notify Success", {
      message:
        "Parallel Voice + Video rollout lanes completed successfully on {{integrationBranch}}. " +
        "Proceed to integration and final verification.",
    }, { x: 300, y: 910 }),

    node("notify-failure", "notify.telegram", "Notify Failure", {
      message:
        "Parallel Voice + Video rollout has lane failures on {{integrationBranch}}. " +
        "Inspect lane outputs before integration.",
    }, { x: 700, y: 910 }),
  ],
  edges: [
    edge("trigger", "check-worktrees"),
    edge("check-worktrees", "kickoff-log", { condition: "$output?.result === true" }),
    edge("check-worktrees", "notify-worktree-error", { condition: "$output?.result !== true" }),
    edge("kickoff-log", "lane-capture-core"),
    edge("kickoff-log", "lane-provider-bridge"),
    edge("kickoff-log", "lane-hardening"),
    edge("lane-capture-core", "aggregate"),
    edge("lane-provider-bridge", "aggregate"),
    edge("lane-hardening", "aggregate"),
    edge("aggregate", "all-passed"),
    edge("all-passed", "notify-success", { condition: "$output?.result === true" }),
    edge("all-passed", "notify-failure", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-28T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["voice", "video", "parallel", "subagents", "rollout"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Meeting Orchestrator + Subworkflow Chain
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const MEETING_SUBWORKFLOW_CHAIN_TEMPLATE = {
  id: "template-meeting-subworkflow-chain",
  name: "Meeting Orchestrator + Subworkflow Chain",
  description:
    "Runs a meeting session start/send/vision/transcript/finalize flow, applies " +
    "a wake-phrase trigger + transcript quality guard, then invokes a child " +
    "workflow via action.execute_workflow for post-meeting automation.",
  category: "agents",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    sessionTitle: "Sprint Planning Sync",
    meetingExecutor: "codex",
    wakePhrase: "bosun wake",
    openingMessage:
      "Kick off planning review. Capture decisions, blockers, and next actions.",
    frameDataUrl: "",
    visionSource: "screen",
    visionPrompt:
      "Summarize visible meeting context, shared docs, and any blockers shown.",
    visionModel: "",
    visionMinIntervalMs: 1500,
    forceVisionAnalyze: false,
    minTranscriptChars: 140,
    childWorkflowId: "template-task-planner",
    finalizeDisposition: "completed",
    notifyPrefix: ":memo:",
  },
  nodes: [
    node("trigger", "trigger.manual", "Start Meeting Orchestration", {}, { x: 450, y: 50 }),

    node("meeting-start", "meeting.start", "Meeting Start", {
      title: "{{sessionTitle}}",
      executor: "{{meetingExecutor}}",
      wakePhrase: "{{wakePhrase}}",
      includeTaskContext: true,
    }, { x: 450, y: 190 }),

    node("meeting-send", "meeting.send", "Send Opening Prompt", {
      message: "{{openingMessage}}",
      role: "system",
    }, { x: 450, y: 320 }),

    node("meeting-vision", "meeting.vision", "Analyze Meeting Frame", {
      frameDataUrl: "{{frameDataUrl}}",
      source: "{{visionSource}}",
      prompt: "{{visionPrompt}}",
      visionModel: "{{visionModel}}",
      minIntervalMs: "{{visionMinIntervalMs}}",
      forceAnalyze: "{{forceVisionAnalyze}}",
      failOnError: false,
    }, { x: 450, y: 450 }),

    node("meeting-transcript", "meeting.transcript", "Capture Transcript", {
      includeMessages: true,
    }, { x: 450, y: 580 }),

    node("wake-phrase-trigger", "trigger.meeting.wake_phrase", "Wake Phrase Trigger", {
      wakePhrase: "{{wakePhrase}}",
      text: "{{meeting-transcript.transcript}}",
      mode: "contains",
    }, { x: 450, y: 710 }),

    node("guard-transcript", "condition.expression", "Wake Phrase + Transcript Guard", {
      expression:
        "(() => { const transcript = String($ctx.getNodeOutput('meeting-transcript')?.transcript || ''); const minChars = Number($data?.minTranscriptChars || 0); const hasWake = $ctx.getNodeOutput('wake-phrase-trigger')?.triggered === true; return transcript.length >= minChars && hasWake; })()",
    }, { x: 450, y: 840 }),

    node("notify-guard-failed", "notify.telegram", "Notify Guard Failed", {
      message:
        "{{notifyPrefix}} Meeting transcript guard failed for **{{sessionTitle}}**. " +
        "Wake phrase missing or transcript shorter than {{minTranscriptChars}} chars.",
    }, { x: 840, y: 840 }),

    node("execute-child-workflow", "action.execute_workflow", "Run Child Workflow", {
      workflowId: "{{childWorkflowId}}",
      mode: "sync",
      inheritContext: true,
      includeKeys: [
        "meetingSessionId",
        "sessionTitle",
        "wakePhrase",
        "meetingVisionSummary",
      ],
      input: {
        parentWorkflowId: "{{_workflowId}}",
        parentRunId: "{{_workflowRunId}}",
        sessionTitle: "{{sessionTitle}}",
        wakePhrase: "{{wakePhrase}}",
        transcript: "{{meeting-transcript.transcript}}",
        visionSummary: "{{meeting-vision.summary}}",
      },
      outputVariable: "childWorkflowResult",
      failOnChildError: false,
    }, { x: 450, y: 980 }),

    node("child-workflow-ok", "condition.expression", "Child Workflow Succeeded?", {
      expression:
        "$ctx.getNodeOutput('execute-child-workflow')?.success === true",
    }, { x: 450, y: 1110 }),

    node("notify-chain-success", "notify.telegram", "Notify Chain Success", {
      message:
        "{{notifyPrefix}} Meeting workflow chained into **{{childWorkflowId}}** " +
        "successfully for **{{sessionTitle}}**.",
    }, { x: 250, y: 1230 }),

    node("notify-chain-failed", "notify.telegram", "Notify Chain Failure", {
      message:
        ":alert: Meeting flow completed but child workflow **{{childWorkflowId}}** failed " +
        "or timed out for **{{sessionTitle}}**.",
    }, { x: 650, y: 1230 }),

    node("meeting-finalize", "meeting.finalize", "Finalize Meeting Session", {
      status: "{{finalizeDisposition}}",
      note: "Meeting subworkflow chain finalized.",
    }, { x: 450, y: 1360 }),

    node("final-log", "notify.log", "Record Final Outcome", {
      message:
        "Meeting orchestration finalized for {{sessionTitle}} with child workflow {{childWorkflowId}}",
      level: "info",
    }, { x: 450, y: 1490 }),
  ],
  edges: [
    edge("trigger", "meeting-start"),
    edge("meeting-start", "meeting-send"),
    edge("meeting-send", "meeting-vision"),
    edge("meeting-vision", "meeting-transcript"),
    edge("meeting-transcript", "wake-phrase-trigger"),
    edge("wake-phrase-trigger", "guard-transcript"),
    edge("guard-transcript", "execute-child-workflow", { condition: "$output?.result === true", port: "yes" }),
    edge("guard-transcript", "notify-guard-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("execute-child-workflow", "child-workflow-ok"),
    edge("child-workflow-ok", "notify-chain-success", { condition: "$output?.result === true", port: "yes" }),
    edge("child-workflow-ok", "notify-chain-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("notify-chain-success", "meeting-finalize"),
    edge("notify-chain-failed", "meeting-finalize"),
    edge("notify-guard-failed", "meeting-finalize"),
    edge("meeting-finalize", "final-log"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-28T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["meeting", "subworkflow", "chaining", "agents"],
    requiredTemplates: ["template-task-planner"],
  },
};
