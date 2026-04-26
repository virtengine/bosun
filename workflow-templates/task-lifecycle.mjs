/**
 * task-lifecycle.mjs — Core Task Lifecycle Workflow Template
 *
 * This template replaces the monolithic TaskExecutor.executeTask() flow with
 * a composable DAG workflow. It is the centrepiece of the workflow-first
 * architecture: every step from task polling through PR creation runs as a
 * workflow node.
 *
 * Templates:
 *   - Task Lifecycle (full task execution pipeline)
 *
 * DAG overview (full):
 *   trigger.task_available
 *     → condition.slot_available
 *       → action.allocate_slot
 *         → action.claim_task
 *           → [claim OK?]
 *             YES → action.update_task_status (→ inprogress)
 *               → action.acquire_worktree
 *                 → [worktree OK?]
 *                   YES → action.resolve_executor
 *                     → record HEAD
 *                     → action.build_task_prompt
 *                       → action.run_agent
 *                         → [claim stolen?]
 *                           NO → action.detect_new_commits
 *                             → [has commits?]
 *                               YES → action.push_branch → action.create_pr
 *                                     → set inreview
 *                               NO  → set todo (cooldown)
 *                           YES → log & set todo
 *                         → release-worktree → release-claim → release-slot
 *                   NO  → [retryable?]
 *                         YES → recover-worktree → retry acquire
 *                               → [retry OK?]
 *                                  YES → rejoin main flow
 *                                  NO  → release-claim → set todo → release-slot → notify
 *                         NO  → release-claim → set blocked → release-slot → notify
 *             NO → release-slot → log skipped
 */

import { node, edge, resetLayout, agentPhase } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Task Lifecycle — Full Task Execution Pipeline
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_LIFECYCLE_TEMPLATE = {
  id: "template-task-lifecycle",
  name: "Task Lifecycle",
  description:
    "Complete task execution pipeline: poll for tasks → claim → worktree → " +
    "agent dispatch → commit detection → PR creation → status transition. " +
    "Replaces the monolithic TaskExecutor.executeTask() method with a " +
    "composable workflow DAG.",
  category: "task-execution",
  enabled: true,
  core: true,
  recommended: true,
  trigger: "trigger.task_available",
  variables: {
    maxParallel: 3,
    baseBranchLimit: 0,
    pollIntervalMs: 30000,
    claimTtlMinutes: 180,
    claimRenewIntervalMs: 60000,
    defaultSdk: "auto",
    defaultTargetBranch: "origin/main",
    taskTimeoutMs: 21600000, // 6 hours
    prePrValidationEnabled: true,
    prePrValidationCommand: "auto",
    autoMergeOnCreate: false,
    autoMergeMethod: "squash",
    prBody: "Task-ID: {{taskId}}\n\nAutomated PR for task {{taskId}}",
    delegationWatchdogTimeoutMs: 300000,
    delegationWatchdogMaxRecoveries: 1,
    maxRetries: 2,
    maxContinues: 3,
    protectedBranches: ["main", "master", "develop", "production"],
  },
  nodes: [
    // ── Trigger: Poll for available tasks ────────────────────────────────
    node("trigger", "trigger.task_available", "Poll for Tasks", {
      maxParallel: "{{maxParallel}}",
      pollIntervalMs: "{{pollIntervalMs}}",
      statuses: ["todo"],
      filterCodexScoped: true,
      filterDrafts: true,
    }, { x: 400, y: 50 }),

    // ── Gate: Check slot availability ────────────────────────────────────
    node("check-slots", "condition.slot_available", "Slots Available?", {
      maxParallel: "{{maxParallel}}",
      baseBranchLimit: "{{baseBranchLimit}}",
      baseBranch: "{{defaultTargetBranch}}",
    }, { x: 400, y: 180 }),

    // ── Allocate execution slot (no sdk/model yet — resolved later) ─────
    node("allocate-slot", "action.allocate_slot", "Allocate Slot", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 400, y: 310 }),

    // ── Claim task (with auto-renewal) ───────────────────────────────────
    node("claim-task", "action.claim_task", "Claim Task", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      ttlMinutes: "{{claimTtlMinutes}}",
      renewIntervalMs: "{{claimRenewIntervalMs}}",
      branch: "{{branch}}",
    }, { x: 400, y: 440 }),

    // ── Check claim result ───────────────────────────────────────────────
    node("claim-ok", "condition.expression", "Claim Succeeded?", {
      expression: "$ctx.getNodeOutput('claim-task')?.success === true",
    }, { x: 400, y: 570, outputs: ["yes", "no"] }),

    // ── Set status → inprogress ──────────────────────────────────────────
    node("set-inprogress", "action.update_task_status", "Set In-Progress", {
      taskId: "{{taskId}}",
      status: "inprogress",
      taskTitle: "{{taskTitle}}",
    }, { x: 300, y: 700 }),

    // ── Acquire worktree ─────────────────────────────────────────────────
    node("acquire-worktree", "action.acquire_worktree", "Acquire Worktree", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "{{defaultTargetBranch}}",
    }, { x: 300, y: 830 }),

    // ── Check worktree result ────────────────────────────────────────────
    node("worktree-ok", "condition.expression", "Worktree OK?", {
      expression: "$ctx.getNodeOutput('acquire-worktree')?.success === true",
    }, { x: 300, y: 960, outputs: ["yes", "no"] }),

    // ── Resolve executor (SDK + model) — AFTER worktree, BEFORE prompt ──
    node("resolve-executor", "action.resolve_executor", "Resolve Executor", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      repoRoot: "{{repoRoot}}",
      workspace: "{{workspace}}",
      defaultSdk: "{{defaultSdk}}",
    }, { x: 200, y: 1090 }),

    // ── Record pre-execution HEAD ────────────────────────────────────────
    node("record-head", "action.run_command", "Record HEAD", {
      command: "git rev-parse HEAD",
      cwd: "{{worktreePath}}",
    }, { x: 200, y: 1220 }),

    // ── Optional per-project WORKFLOW.md contract ───────────────────────
    node("read-workflow-contract", "read-workflow-contract", "Read WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 200, y: 1350 }),

    node("workflow-contract-validation", "workflow-contract-validation", "Validate WORKFLOW.md", {
      repoRoot: "{{repoRoot}}",
      worktreePath: "{{worktreePath}}",
    }, { x: 200, y: 1480 }),

    // ── Build agent prompt ───────────────────────────────────────────────
    node("build-prompt", "action.build_task_prompt", "Build Prompt", {
      taskId: "{{taskId}}",
      taskTitle: "{{taskTitle}}",
      taskDescription: "{{taskDescription}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      repoSlug: "{{repoSlug}}",
      workspace: "{{workspace}}",
      repository: "{{repository}}",
      repositories: "{{repositories}}",
    }, { x: 200, y: 1610 }),
    // ── Execute agent (phase 1: planning) ───────────────────────────────
    agentPhase("run-agent-plan", "Agent Plan",
      "{{_taskPrompt}}\n\nExecution phase: planning. Produce a concrete implementation plan and identify required tests. Do not make code changes in this phase.",
      { delegateTaskWorkflow: false, delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}", delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}" }, { x: 200, y: 1740 }),

    // ── Execute agent (phase 2: tests-first) ────────────────────────────
    agentPhase("run-agent-tests", "Agent Tests",
      "{{_taskPrompt}}\n\nExecution phase: tests. Write or update tests first for the target behavior, then validate failures/pass criteria before implementation changes.",
      { delegateTaskWorkflow: false, delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}", delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}" }, { x: 200, y: 1545 }),

    // ── Execute agent (phase 3: implementation + verification) ──────────
    agentPhase("run-agent-implement", "Agent Implement",
      "{{_taskPrompt}}\n\nExecution phase: implementation. Complete implementation after tests exist, run required verification (tests/lint/build), then commit, push, and create/update PR.",
      { delegateTaskWorkflow: false, delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}", delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}" }, { x: 200, y: 1610 }),

    node("plan-agent-ok", "condition.expression", "Plan Agent Succeeded?", {
      expression: "$ctx.getNodeOutput('run-agent-plan')?.success === true",
    }, { x: 380, y: 1740, outputs: ["yes", "no"] }),

    node("tests-agent-ok", "condition.expression", "Tests Agent Succeeded?", {
      expression: "$ctx.getNodeOutput('run-agent-tests')?.success === true",
    }, { x: 380, y: 1545, outputs: ["yes", "no"] }),

    node("implement-agent-ok", "condition.expression", "Implement Agent Succeeded?", {
      expression:
        "$ctx.getNodeOutput('run-agent-implement')?.success === true"
        + " || $ctx.getNodeOutput('run-agent-implement')?.implementationState === 'implementation_done_commit_blocked'",
    }, { x: 380, y: 1610, outputs: ["yes", "no"] }),

    node("set-blocked-agent-plan-failed", "action.update_task_status", "Set Blocked (Plan Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('run-agent-plan')?.blockedReason || $ctx.getNodeOutput('run-agent-plan')?.failureKind || $ctx.getNodeOutput('run-agent-plan')?.error || 'agent_plan_failed'}}",
    }, { x: 560, y: 1740 }),

    node("set-blocked-agent-tests-failed", "action.update_task_status", "Set Blocked (Tests Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('run-agent-tests')?.blockedReason || $ctx.getNodeOutput('run-agent-tests')?.failureKind || $ctx.getNodeOutput('run-agent-tests')?.error || 'agent_tests_failed'}}",
    }, { x: 560, y: 1545 }),

    node("set-blocked-agent-implement-failed", "action.update_task_status", "Set Blocked (Implement Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('run-agent-implement')?.blockedReason || $ctx.getNodeOutput('run-agent-implement')?.failureKind || $ctx.getNodeOutput('run-agent-implement')?.error || 'agent_implement_failed'}}",
    }, { x: 560, y: 1610 }),

    // ── Check if claim was stolen during agent execution ─────────────────
    node("claim-stolen", "condition.expression", "Claim Stolen?", {
      expression: "$data._claimStolen === true",
    }, { x: 200, y: 1610, outputs: ["yes", "no"] }),

    // ── Auto-commit dirty worktree (safety net) ────────────────────────
    node("auto-commit-dirty", "action.auto_commit_dirty", "Auto Commit Dirty", {
      worktreePath: "{{worktreePath}}",
      taskId: "{{taskId}}",
    }, { x: 120, y: 1680 }),

    // ── Detect new commits ───────────────────────────────────────────────
    node("detect-commits", "action.detect_new_commits", "Detect Commits", {
      worktreePath: "{{worktreePath}}",
      baseBranch: "{{baseBranch}}",
    }, { x: 120, y: 1740 }),

    // ── Branch: has new commits? ─────────────────────────────────────────
    node("has-commits", "condition.expression", "Has Commits?", {
      expression: "$ctx.getNodeOutput('detect-commits')?.hasCommits === true",
    }, { x: 120, y: 1870, outputs: ["yes", "no"] }),

    node("no-commit-retries-exhausted", "condition.expression", "No-Commit Retries Exhausted?", {
      expression: "$ctx.getNodeOutput('detect-commits')?.retryExhausted === true",
    }, { x: 350, y: 1870, outputs: ["yes", "no"] }),

    // ── SUCCESS PATH: Local quality gate before push/PR ──────────────────
    node("pre-pr-validation", "action.run_command", "Pre-PR Validation", {
      command: "{{prePrValidationCommand}}",
      commandType: "qualityGate",
      cwd: "{{worktreePath}}",
      failOnError: false,
    }, { x: -120, y: 1940 }),

    node("pre-pr-validation-ok", "condition.expression", "Validation Passed?", {
      expression:
        "(() => {" +
        "const enabled = $data?.prePrValidationEnabled !== false;" +
        "if (!enabled) return true;" +
        "const out = $ctx.getNodeOutput('pre-pr-validation');" +
        "if (!out) return false;" +
        "if (out.success === true) return true;" +
        "const code = Number(out.exitCode);" +
        "return Number.isFinite(code) && code === 0;" +
        "})()",
    }, { x: -120, y: 2060, outputs: ["yes", "no"] }),

    node("set-fix-summary", "action.set_variable", "Set Fix Summary", {
      variable: "validationFixSummary",
      value: "Pre-PR validation failed for task {{taskId}}. Apply the smallest viable fix and rerun validation.",
    }, { x: 160, y: 1940 }),

    agentPhase("auto-fix-validation", "Auto Fix Validation",
      "{{_taskPrompt}}\n\nExecution phase: validation autofix pass 1. The previous pre-PR validation failed. Fix only the reported validation issue below, then stop.\n\nValidation failure details:\n{{$ctx.getNodeOutput('pre-pr-validation')?.stderr || $ctx.getNodeOutput('pre-pr-validation')?.output || $ctx.getNodeOutput('pre-pr-validation')?.error || 'Validation output unavailable.'}}",
      { delegateTaskWorkflow: false, delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}", delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}" }, { x: 160, y: 2060 }),

    node("retry-pre-pr-validation", "action.run_command", "Retry Pre-PR Validation", {
      command: "{{prePrValidationCommand}}",
      commandType: "qualityGate",
      cwd: "{{worktreePath}}",
      failOnError: false,
    }, { x: 160, y: 2180 }),

    node("retry-validation-ok", "condition.expression", "Retry Validation Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('retry-pre-pr-validation'); if (!out) return false; if (out.success === true) return true; const code = Number(out.exitCode); return Number.isFinite(code) && code === 0; })()",
    }, { x: 160, y: 2300, outputs: ["yes", "no"] }),

    node("set-fix2-summary", "action.set_variable", "Set Fix Summary 2", {
      variable: "validationFixSummary2",
      value: "Validation retry still failed for task {{taskId}}. Attempt one final focused repair before blocking the task.",
    }, { x: 320, y: 2060 }),

    agentPhase("auto-fix-validation-2", "Auto Fix Validation 2",
      "{{_taskPrompt}}\n\nExecution phase: validation autofix pass 2. Retry only the remaining reported validation failures below, then stop.\n\nValidation failure details:\n{{$ctx.getNodeOutput('retry-pre-pr-validation')?.stderr || $ctx.getNodeOutput('retry-pre-pr-validation')?.output || $ctx.getNodeOutput('retry-pre-pr-validation')?.error || 'Validation output unavailable.'}}",
      { delegateTaskWorkflow: false, delegationWatchdogTimeoutMs: "{{delegationWatchdogTimeoutMs}}", delegationWatchdogMaxRecoveries: "{{delegationWatchdogMaxRecoveries}}" }, { x: 320, y: 2180 }),

    node("retry2-pre-pr-validation", "action.run_command", "Retry Pre-PR Validation 2", {
      command: "{{prePrValidationCommand}}",
      commandType: "qualityGate",
      cwd: "{{worktreePath}}",
      failOnError: false,
    }, { x: 320, y: 2300 }),

    node("retry2-validation-ok", "condition.expression", "Retry Validation 2 Passed?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('retry2-pre-pr-validation'); if (!out) return false; if (out.success === true) return true; const code = Number(out.exitCode); return Number.isFinite(code) && code === 0; })()",
    }, { x: 320, y: 2420, outputs: ["yes", "no"] }),

    node("log-validation-failed", "notify.log", "Log Validation Failed", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — pre-PR validation failed after two autofix attempts, blocking task",
      level: "warn",
    }, { x: 460, y: 2180 }),

    node("set-blocked-validation-failed", "action.update_task_status", "Set Blocked (Validation Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "pre_pr_validation_failed",
    }, { x: 460, y: 2300 }),

    node("notify-validation-blocked", "notify.telegram", "Notify Validation Blocked", {
      message: "⚠️ Task \"{{taskTitle}}\" ({{taskId}}) blocked after repeated pre-PR validation failures.",
    }, { x: 460, y: 2420 }),
    node("auto-commit-pre-push", "action.auto_commit_dirty", "Auto Commit Before Push", {
      worktreePath: "{{worktreePath}}",
      taskId: "{{taskId}}",
    }, { x: 0, y: 1940 }),
    // ── SUCCESS PATH: Push branch (with merge-base refresh + empty-diff guard) ───────
    node("push-branch", "action.push_branch", "Push Branch", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      rebaseBeforePush: false,
      mergeBaseBeforePush: true,
      autoResolveMergeConflicts: true,
      conflictResolverSdk: "auto",
      emptyDiffGuard: true,
      protectedBranches: "{{protectedBranches}}",
    }, { x: 0, y: 2000 }),

    // ── SUCCESS PATH: Check push result ──────────────────────────────────
    node("push-ok", "condition.expression", "Push OK?", {
      expression: "$ctx.getNodeOutput('push-branch')?.pushed === true",
    }, { x: 0, y: 2130, outputs: ["yes", "no"] }),

    node("build-pr-body", "action.set_variable", "Build PR Body", {
      variable: "prBody",
      value: "{{prBody}}",
    }, { x: 0, y: 2195 }),

    // ── SUCCESS PATH: Create PR ──────────────────────────────────────────
    node("create-pr", "action.create_pr", "Create PR", {
      title: "{{taskTitle}}",
      body: "{{prBody}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      cwd: "{{worktreePath}}",
      enableAutoMerge: "{{autoMergeOnCreate}}",
      autoMergeMethod: "{{autoMergeMethod}}",
    }, { x: 0, y: 2260 }),

    node("pr-created", "condition.expression", "PR Linked?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr')?.success === true && ($ctx.getNodeOutput('create-pr')?.prNumber || $ctx.getNodeOutput('create-pr')?.prUrl))",
    }, { x: 0, y: 2325, outputs: ["yes", "no"] }),

    // ── SUCCESS PATH: Set status → inreview ──────────────────────────────
    node("set-inreview", "action.update_task_status", "Set In-Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 0, y: 2390 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Handoff PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "sync",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr')?.prNumber ?? $data?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr')?.prUrl || $data?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: -120, y: 2520 }),

    // ── SUCCESS PATH: Log success ────────────────────────────────────────
    node("log-success", "notify.log", "Log Success", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) completed — PR linked",
      level: "info",
    }, { x: -120, y: 2650 }),

    // ── NO COMMITS PATH: Log no-commit ───────────────────────────────────
    node("log-no-commits", "notify.log", "Log No Commits", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — no new commits, returning to todo",
      level: "warn",
    }, { x: 350, y: 2000 }),

    node("log-no-commits-exhausted", "notify.log", "Log No Commits Exhausted", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — repeated no-commit runs exhausted retries, blocking task",
      level: "warn",
    }, { x: 520, y: 2000 }),

    node("set-blocked-no-commits", "action.update_task_status", "Set Blocked (No Commits)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('detect-commits')?.blockedReason || 'repeated_no_commit_runs'}}",
    }, { x: 520, y: 2130 }),

    // ── NO COMMITS PATH: Set status → todo (cooldown) ────────────────────
    node("set-todo-cooldown", "action.update_task_status", "Set Todo (Cooldown)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 350, y: 2130 }),

    // ── PUSH FAILED PATH: Set status → todo ──────────────────────────────
    node("set-todo-push-failed", "action.update_task_status", "Set Todo (Push Fail)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 180, y: 2260 }),

    node("push-failure-blocking", "condition.expression", "Push Failure Blocks?", {
      expression: "$ctx.getNodeOutput('push-branch')?.implementationDone === true",
    }, { x: 360, y: 2195, outputs: ["yes", "no"] }),

    node("push-pr-linked", "condition.expression", "Existing PR Linked?", {
      expression: "Boolean($data?.prNumber || $data?.prUrl || $data?.task?.prNumber || $data?.task?.prUrl)",
    }, { x: 180, y: 2325, outputs: ["yes", "no"] }),

    node("set-blocked-push-failed", "action.update_task_status", "Set Blocked (Push Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('push-branch')?.blockedReason || $ctx.getNodeOutput('push-branch')?.error || 'implementation_done_commit_blocked'}}",
    }, { x: 360, y: 2325 }),

    // ── CLAIM STOLEN PATH: Log ───────────────────────────────────────────
    node("build-pr-body-stolen", "action.set_variable", "Build PR Body (Recovered)", {
      variable: "prBody",
      value: "{{prBody}}",
    }, { x: 400, y: 1680 }),

    node("create-pr-retry", "action.create_pr", "Recover PR Link", {
      title: "{{taskTitle}}",
      body: "{{prBody}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      cwd: "{{worktreePath}}",
      failOnError: false,
      enableAutoMerge: "{{autoMergeOnCreate}}",
      autoMergeMethod: "{{autoMergeMethod}}",
    }, { x: 400, y: 1740 }),

    node("pr-created-stolen", "condition.expression", "PR Linked After Claim Loss?", {
      expression: "Boolean($ctx.getNodeOutput('create-pr-retry')?.success === true && ($ctx.getNodeOutput('create-pr-retry')?.prNumber || $ctx.getNodeOutput('create-pr-retry')?.prUrl))",
    }, { x: 400, y: 1870, outputs: ["yes", "no"] }),

    node("set-inreview-stolen", "action.update_task_status", "Set In-Review (Recovered)", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 250, y: 2000 }),

    node("handoff-pr-progressor-stolen", "action.execute_workflow", "Handoff PR Progressor (Recovered)", {
      workflowId: "template-bosun-pr-progressor",
      mode: "sync",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr-retry')?.prNumber ?? $data?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr-retry')?.prUrl || $data?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr-retry')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: 120, y: 2130 }),

    node("log-claim-stolen-recovered", "notify.log", "Log Claim Loss Recovery", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — claim lost after PR link recovery, keeping inreview",
      level: "warn",
    }, { x: 120, y: 2260 }),

    node("log-claim-stolen", "notify.log", "Log Claim Stolen", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — claim was stolen, aborting",
      level: "warn",
    }, { x: 550, y: 2000 }),

    // ── CLAIM STOLEN PATH: Set todo ──────────────────────────────────────
    node("set-todo-stolen", "action.update_task_status", "Set Todo (Stolen)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 550, y: 2130 }),

    node("join-outcomes", "flow.join", "Join Outcome Paths", {
      mode: "all",
      sourceNodeIds: ["log-success", "set-todo-push-failed", "set-blocked-push-failed", "set-todo-cooldown", "set-blocked-no-commits", "notify-validation-blocked", "set-todo-stolen", "log-claim-stolen-recovered"],
      includeSkipped: true,
    }, { x: 200, y: 2560 }),

    // ── CLEANUP: Release worktree (all paths converge) ───────────────────
    node("release-worktree", "action.release_worktree", "Release Worktree", {
      worktreePath: "{{worktreePath}}",
      repoRoot: "{{repoRoot}}",
      taskId: "{{taskId}}",
    }, { x: 200, y: 2700 }),

    // ── CLEANUP: Release claim ───────────────────────────────────────────
    node("release-claim", "action.release_claim", "Release Claim", {
      taskId: "{{taskId}}",
    }, { x: 200, y: 2830 }),

    // ── CLEANUP: Release slot ────────────────────────────────────────────
    node("release-slot", "action.release_slot", "Release Slot", {
      taskId: "{{taskId}}",
    }, { x: 200, y: 2960 }),

    // ── FAILURE: Claim failed — release slot and skip ────────────────────
    node("release-slot-claim-failed", "action.release_slot", "Release Slot (Claim Fail)", {
      taskId: "{{taskId}}",
    }, { x: 650, y: 700 }),

    node("log-claim-failed", "notify.log", "Log Claim Failed", {
      message: "Task \"{{taskTitle}}\" ({{taskId}}) — already claimed, skipping",
      level: "info",
    }, { x: 650, y: 830 }),

    // ── FAILURE: Worktree failed — release claim, slot ───────────────────
    node("release-claim-wt-failed", "action.release_claim", "Release Claim (WT Fail)", {
      taskId: "{{taskId}}",
    }, { x: 600, y: 1090 }),

    node("wt-failure-blocking", "condition.expression", "Non-Retryable WT Failure?", {
      expression:
        "(() => { const retry = $ctx.getNodeOutput('retry-acquire-wt'); const latest = retry && retry.success === false ? retry : $ctx.getNodeOutput('acquire-worktree'); return latest?.retryable === false; })()",
    }, { x: 600, y: 1220, outputs: ["yes", "no"] }),

    node("set-blocked-wt-failed", "action.update_task_status", "Set Blocked (WT Fail)", {
      taskId: "{{taskId}}",
      status: "blocked",
      taskTitle: "{{taskTitle}}",
      blockedReason: "{{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.blockedReason || $ctx.getNodeOutput('retry-acquire-wt')?.error || '') : ($ctx.getNodeOutput('acquire-worktree')?.blockedReason || $ctx.getNodeOutput('acquire-worktree')?.error || '')}}",
    }, { x: 470, y: 1350 }),
    
    node("annotate-blocked-wt-failed", "action.bosun_function", "Annotate Blocked (WT Fail)", {
      function: "tasks.update",
      args: {
        taskId: "{{taskId}}",
        fields: {
          cooldownUntil: "{{(() => { const retry = $ctx.getNodeOutput('retry-acquire-wt'); const output = retry && retry.success === false ? retry : ($ctx.getNodeOutput('acquire-worktree') || {}); return output.retryAt || null; })()}}",
          blockedReason: "{{(() => { const retry = $ctx.getNodeOutput('retry-acquire-wt'); const output = retry && retry.success === false ? retry : ($ctx.getNodeOutput('acquire-worktree') || {}); return output.blockedReason || output.error || null; })()}}",
          meta: "{{(() => { const current = ($data.meta && typeof $data.meta === 'object') ? $data.meta : (($data.taskMeta && typeof $data.taskMeta === 'object') ? $data.taskMeta : {}); const retry = $ctx.getNodeOutput('retry-acquire-wt'); const output = retry && retry.success === false ? retry : ($ctx.getNodeOutput('acquire-worktree') || {}); const worktreePath = output.worktreePath || $data.worktreePath || ''; const repoRoot = $data.repoRoot || $data.workspace || current.repoRoot || current.workspace || ''; const branch = $data.branch || $data.branchName || current.branch || current.branchName || ''; const baseBranch = $data.baseBranch || current.baseBranch || ''; const defaultTargetBranch = $data.defaultTargetBranch || current.defaultTargetBranch || ''; return { ...current, autoRecovery: { active: true, reason: 'worktree_failure', failureKind: output.failureKind || 'branch_refresh_conflict', retryAt: output.retryAt || null, recoveryDelayMs: output.autoRecoverDelayMs || null, error: output.error || '', recordedAt: output.recordedAt || null }, worktreeFailure: { failureKind: output.failureKind || 'branch_refresh_conflict', retryable: output.retryable !== false, retryAt: output.retryAt || null, blockedReason: output.blockedReason || output.error || '', error: output.error || '', recordedAt: output.recordedAt || null, repairArtifacts: output.repairArtifacts || null, branch, repoRoot, baseBranch, defaultTargetBranch, worktreePath } }; })()}}",
        },
      },
    }, { x: 470, y: 1480, outputs: ["default", "error"] }),

    node("dispatch-wt-repair", "action.execute_workflow", "Dispatch WT Repair", {
      workflowId: "template-task-repair-worktree",
      mode: "{{ $data?._simulation === true ? 'sync' : 'dispatch' }}",
      input: {
        eventType: "task.failed",
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        repoRoot: "{{repoRoot}}",
        worktreePath: "{{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.worktreePath || $data.worktreePath || '') : ($ctx.getNodeOutput('acquire-worktree')?.worktreePath || $data.worktreePath || '')}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        defaultTargetBranch: "{{defaultTargetBranch}}",
        error: "{{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.error || $ctx.getNodeOutput('retry-acquire-wt')?.blockedReason || 'worktree acquisition failed') : ($ctx.getNodeOutput('acquire-worktree')?.error || $ctx.getNodeOutput('acquire-worktree')?.blockedReason || 'worktree acquisition failed')}}",
        failureKind: "{{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.failureKind || 'branch_refresh_conflict') : ($ctx.getNodeOutput('acquire-worktree')?.failureKind || 'branch_refresh_conflict')}}",
        repairArtifacts: "{{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.repairArtifacts || null) : ($ctx.getNodeOutput('acquire-worktree')?.repairArtifacts || null)}}",
      },
    }, { x: 470, y: 1610 }),

    node("set-todo-wt-failed", "action.update_task_status", "Set Todo (WT Fail)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 730, y: 1350 }),

    node("release-slot-wt-failed", "action.release_slot", "Release Slot (WT Fail)", {
      taskId: "{{taskId}}",
    }, { x: 600, y: 1480 }),

    node("notify-wt-failed", "notify.telegram", "Notify WT Failed", {
      message: "⚠️ Worktree failed for \"{{taskTitle}}\" ({{taskId}}){{$ctx.getNodeOutput('retry-acquire-wt')?.success === false ? ($ctx.getNodeOutput('retry-acquire-wt')?.recoveryNote || '') : ($ctx.getNodeOutput('acquire-worktree')?.recoveryNote || '')}}",
    }, { x: 600, y: 1740 }),

    // ── AUTO-RECOVERY: Retry worktree acquisition once after cleanup ─────
    node("wt-retry-eligible", "condition.expression", "Retryable WT Failure?", {
      expression: "$ctx.getNodeOutput('acquire-worktree')?.retryable === true",
    }, { x: 850, y: 960, outputs: ["yes", "no"] }),

    node("recover-worktree", "action.recover_worktree", "Clean Broken WT", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
    }, { x: 850, y: 1090 }),

    node("retry-acquire-wt", "action.acquire_worktree", "Retry Acquire WT", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "{{defaultTargetBranch}}",
    }, { x: 850, y: 1220 }),

    node("retry-wt-ok", "condition.expression", "Retry WT OK?", {
      expression: "$ctx.getNodeOutput('retry-acquire-wt')?.success === true",
    }, { x: 850, y: 1350, outputs: ["yes", "no"] }),

    // ── CLEANUP: Sweep task worktrees at end of lifecycle ────────────────
    // Uses action.sweep_task_worktrees (not recover_worktree) so all worktrees
    // belonging to this taskId are physically removed from .bosun/worktrees/
    // once the task is complete and submitted, then git worktree prune cleans refs.
    node("sweep-task-wts", "action.sweep_task_worktrees", "Sweep Task WTs", {
      repoRoot: "{{repoRoot}}",
      taskId: "{{taskId}}",
    }, { x: 200, y: 3090 }),
  ],
  edges: [
    // Main flow
    edge("trigger", "check-slots"),
    edge("check-slots", "allocate-slot", { condition: "$output?.result === true" }),
    edge("allocate-slot", "claim-task"),
    edge("claim-task", "claim-ok"),
    edge("claim-ok", "set-inprogress", { condition: "$output?.result === true", port: "yes" }),
    edge("set-inprogress", "acquire-worktree"),
    edge("acquire-worktree", "worktree-ok"),
    edge("worktree-ok", "resolve-executor", { condition: "$output?.result === true", port: "yes" }),
    edge("resolve-executor", "record-head"),
    edge("record-head", "read-workflow-contract"),
    edge("read-workflow-contract", "workflow-contract-validation"),
    edge("workflow-contract-validation", "build-prompt"),
    edge("build-prompt", "run-agent-plan"),
    edge("run-agent-plan", "plan-agent-ok"),
    edge("plan-agent-ok", "run-agent-tests", { condition: "$output?.result === true", port: "yes" }),
    edge("plan-agent-ok", "set-blocked-agent-plan-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-agent-plan-failed", "join-outcomes"),
    edge("run-agent-tests", "tests-agent-ok"),
    edge("tests-agent-ok", "run-agent-implement", { condition: "$output?.result === true", port: "yes" }),
    edge("tests-agent-ok", "set-blocked-agent-tests-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-agent-tests-failed", "join-outcomes"),
    edge("run-agent-implement", "implement-agent-ok"),
    edge("implement-agent-ok", "claim-stolen", { condition: "$output?.result === true", port: "yes" }),
    edge("implement-agent-ok", "set-blocked-agent-implement-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-agent-implement-failed", "join-outcomes"),

    // Post-agent: check claim
    edge("claim-stolen", "auto-commit-dirty", { condition: "$output?.result !== true", port: "no" }),
    edge("auto-commit-dirty", "detect-commits"),
    edge("detect-commits", "has-commits"),

    // Success path (has commits)
    edge("has-commits", "pre-pr-validation", { condition: "$output?.result === true", port: "yes" }),
    edge("pre-pr-validation", "pre-pr-validation-ok"),
    edge("pre-pr-validation-ok", "auto-commit-pre-push", { condition: "$output?.result === true", port: "yes" }),
    edge("pre-pr-validation-ok", "set-fix-summary", { condition: "$output?.result !== true", port: "no" }),
    edge("set-fix-summary", "auto-fix-validation"),
    edge("auto-fix-validation", "retry-pre-pr-validation"),
    edge("retry-pre-pr-validation", "retry-validation-ok"),
    edge("retry-validation-ok", "auto-commit-pre-push", { condition: "$output?.result === true", port: "yes" }),
    edge("retry-validation-ok", "set-fix2-summary", { condition: "$output?.result !== true", port: "no" }),
    edge("set-fix2-summary", "auto-fix-validation-2"),
    edge("auto-fix-validation-2", "retry2-pre-pr-validation"),
    edge("retry2-pre-pr-validation", "retry2-validation-ok"),
    edge("retry2-validation-ok", "auto-commit-pre-push", { condition: "$output?.result === true", port: "yes" }),
    edge("retry2-validation-ok", "log-validation-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("log-validation-failed", "set-blocked-validation-failed"),
    edge("set-blocked-validation-failed", "notify-validation-blocked"),
    edge("notify-validation-blocked", "join-outcomes"),
    edge("auto-commit-pre-push", "push-branch"),
    edge("push-branch", "push-ok"),
    edge("push-ok", "build-pr-body", { condition: "$output?.result === true", port: "yes" }),
    edge("build-pr-body", "create-pr"),
    edge("create-pr", "pr-created"),
    edge("pr-created", "set-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("pr-created", "set-todo-push-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-inreview", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "log-success"),
    edge("log-success", "join-outcomes"),

    // Push failed path
    edge("push-ok", "push-failure-blocking", { condition: "$output?.result !== true", port: "no" }),
    edge("push-failure-blocking", "push-pr-linked", { condition: "$output?.result === true", port: "yes" }),
    edge("push-pr-linked", "set-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("push-pr-linked", "set-blocked-push-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("push-failure-blocking", "set-todo-push-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-push-failed", "join-outcomes"),
    edge("set-todo-push-failed", "join-outcomes"),

    // No-commits path
    edge("has-commits", "no-commit-retries-exhausted", { condition: "$output?.result !== true", port: "no" }),
    edge("no-commit-retries-exhausted", "log-no-commits-exhausted", { condition: "$output?.result === true", port: "yes" }),
    edge("log-no-commits-exhausted", "set-blocked-no-commits"),
    edge("set-blocked-no-commits", "join-outcomes"),
    edge("no-commit-retries-exhausted", "log-no-commits", { condition: "$output?.result !== true", port: "no" }),
    edge("log-no-commits", "set-todo-cooldown"),
    edge("set-todo-cooldown", "join-outcomes"),

    // Claim stolen path
    edge("claim-stolen", "build-pr-body-stolen", { condition: "$output?.result === true", port: "yes" }),
    edge("build-pr-body-stolen", "create-pr-retry"),
    edge("create-pr-retry", "pr-created-stolen"),
    edge("pr-created-stolen", "set-inreview-stolen", { condition: "$output?.result === true", port: "yes" }),
    edge("set-inreview-stolen", "handoff-pr-progressor-stolen"),
    edge("handoff-pr-progressor-stolen", "log-claim-stolen-recovered"),
    edge("log-claim-stolen-recovered", "join-outcomes"),
    edge("pr-created-stolen", "log-claim-stolen", { condition: "$output?.result !== true", port: "no" }),
    edge("log-claim-stolen", "set-todo-stolen"),
    edge("set-todo-stolen", "join-outcomes"),

    // Shared cleanup (all outcome paths converge here)
    edge("join-outcomes", "release-worktree"),
    edge("release-worktree", "release-claim"),
    edge("release-claim", "release-slot"),
    edge("release-slot", "sweep-task-wts"),

    // Claim failed path
    edge("claim-ok", "release-slot-claim-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("release-slot-claim-failed", "log-claim-failed"),

    // Worktree failed path — auto-recovery attempt first
    edge("worktree-ok", "wt-retry-eligible", { condition: "$output?.result !== true", port: "no" }),

    // Retryable: clean up broken worktree and re-acquire
    edge("wt-retry-eligible", "recover-worktree", { condition: "$output?.result === true", port: "yes" }),
    edge("recover-worktree", "retry-acquire-wt"),
    edge("retry-acquire-wt", "retry-wt-ok"),
    // Retry succeeded — rejoin main flow at resolve-executor
    edge("retry-wt-ok", "resolve-executor", { condition: "$output?.result === true", port: "yes" }),
    // Retry failed — fall through to original failure path
    edge("retry-wt-ok", "release-claim-wt-failed", { condition: "$output?.result !== true", port: "no" }),

    // Non-retryable: skip recovery, go directly to failure path
    edge("wt-retry-eligible", "release-claim-wt-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("release-claim-wt-failed", "wt-failure-blocking"),
    edge("wt-failure-blocking", "set-blocked-wt-failed", { condition: "$output?.result === true", port: "yes" }),
    edge("wt-failure-blocking", "set-todo-wt-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("set-blocked-wt-failed", "annotate-blocked-wt-failed"),
    edge("annotate-blocked-wt-failed", "dispatch-wt-repair"),
    edge("annotate-blocked-wt-failed", "dispatch-wt-repair", {
      id: "annotate-blocked-wt-failed->dispatch-wt-repair#error",
      port: "error",
    }),
    edge("dispatch-wt-repair", "release-slot-wt-failed"),
    edge("set-todo-wt-failed", "release-slot-wt-failed"),
    edge("release-slot-wt-failed", "notify-wt-failed"),
  ],
  metadata: {
    author: "bosun",
    version: 5,
    createdAt: "2026-03-01T00:00:00Z",
    templateVersion: "2.1.0",
    tags: ["task", "lifecycle", "executor", "workflow-first", "core"],
    requiredTemplates: ["template-bosun-pr-progressor", "template-task-repair-worktree"],
    replaces: {
      module: "task-executor.mjs",
      functions: [
        "executeTask",
        "_pollLoop",
        "_handleTaskResult",
        "_buildTaskPrompt",
        "_processBacklogReplenishment",
      ],
      calledFrom: ["monitor.mjs:startProcess", "monitor.mjs:runMonitorMonitorCycle"],
      description:
        "Replaces the entire TaskExecutor.executeTask() monolith with a " +
        "composable DAG workflow. Each step (claim, worktree, agent, PR) " +
        "is an independent workflow node with explicit success/failure branches.",
    },
  },
};
