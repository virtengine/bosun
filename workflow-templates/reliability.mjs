/**
 * reliability.mjs — Reliability & maintenance workflow templates.
 *
 * Templates:
 *   - Error Recovery (recommended)
 *   - Anomaly Watchdog (recommended)
 *   - Workspace Hygiene (recommended)
 *   - Health Check
 *   - Task Finalization Guard (recommended)
 *   - Task Repair Worktree (recommended)
 *   - Task Orphan Worktree Recovery (recommended)
 *   - Task Status Transition Manager
 *   - Incident Response (recommended)
 *   - Task Archiver (recommended)
 *   - Sync Engine (recommended)
 *   - Recover Blocked Task (Worktree) (recommended) — sub-workflow
 *   - Recover Blocked Worktree Tasks (recommended) — orchestrator
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Error Recovery
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const ERROR_RECOVERY_TEMPLATE = {
  id: "template-error-recovery",
  name: "Error Recovery",
  description:
    "Automated error recovery flow when an agent crashes or fails. " +
    "Analyzes logs, attempts auto-fix, and escalates if needed.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    maxRetries: 3,
    recoveryStrategyLimit: 5,
  },
  nodes: [
    node("trigger", "trigger.event", "Agent Failed", {
      eventType: "task.failed",
    }, { x: 400, y: 50 }),

    node("check-retries", "condition.expression", "Retries Left?", {
      expression: "($data?.retryCount || 0) < ($data?.maxRetries || 3)",
    }, { x: 400, y: 180 }),

    node("load-recovery-strategies", "action.load_skillbook_strategies", "Load Recovery Strategies", {
      repoRoot: "{{repoRoot}}",
      workflowId: "template-error-recovery",
      query:
        "Recovery guidance for task {{taskTitle}}. Last error: {{lastError}}. " +
        "Changed files: {{$data?._changedFiles || []}}",
      limit: "{{recoveryStrategyLimit}}",
      outputVariable: "reusableStrategies",
    }, { x: 200, y: 250 }),

    node("analyze-error", "action.run_agent", "Analyze Failure", {
      prompt:
        "Analyze the following task failure and suggest the most likely minimal fix.\n\n" +
        "Task: {{taskTitle}} ({{taskId}})\n" +
        "Retry attempt: {{$data?.retryCount || 0}}/{{$data?.maxRetries || 3}}\n" +
        "Branch: {{branch}}\n" +
        "Base branch: {{baseBranch}}\n" +
        "Worktree: {{worktreePath}}\n\n" +
        "Reusable prior strategies:\n{{$ctx.getNodeOutput('load-recovery-strategies')?.guidanceSummary || 'None found.'}}\n\n" +
        "Last error:\n{{lastError}}",
      timeoutMs: 300000,
    }, { x: 200, y: 360 }),

    node("retry-task", "action.run_agent", "Retry Task", {
      prompt:
        "{{taskExecutorRetryPrompt}}\n\n" +
        "Failure context:\n" +
        "- taskId: {{taskId}}\n" +
        "- taskTitle: {{taskTitle}}\n" +
        "- branch: {{branch}}\n" +
        "- baseBranch: {{baseBranch}}\n" +
        "- worktreePath: {{worktreePath}}\n" +
        "- retryCount: {{$data?.retryCount || 0}}/{{$data?.maxRetries || 3}}\n" +
        "- lastError: {{lastError}}\n" +
        "- reusableStrategies: {{$ctx.getNodeOutput('load-recovery-strategies')?.guidanceSummary || ''}}\n" +
        "- recoveryAnalysis: {{$ctx.getNodeOutput('analyze-error')?.output || ''}}\n\n" +
        "Use the analysis to choose a different approach if the previous attempt failed.",
      timeoutMs: 3600000,
      failOnError: true,
      maxRetries: "{{maxRetries}}",
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 200, y: 520 }),

    node("retry-succeeded", "condition.expression", "Retry Succeeded?", {
      expression: "$ctx.getNodeOutput('retry-task')?.success === true",
    }, { x: 200, y: 620, outputs: ["yes", "no"] }),

    node("notify-recovered", "notify.log", "Log Recovery Success", {
      message: "Task {{taskId}} recovered automatically by error-recovery workflow",
      level: "info",
    }, { x: 90, y: 760 }),

    node("escalate", "notify.telegram", "Escalate to Human", {
      message:
        ":alert: Task **{{taskTitle}}** failed after {{maxRetries}} attempts. Manual intervention needed.\n\n" +
        "Last error: {{lastError}}\n\n" +
        "Recovery analysis: {{$ctx.getNodeOutput('analyze-error')?.output || ''}}",
    }, { x: 600, y: 620 }),

    node("chain-repair", "action.execute_workflow", "Trigger Repair Workflow", {
      workflowId: "template-task-repair-worktree",
      mode: "dispatch",
      input:
        "(() => { const analysisRaw = String($ctx.getNodeOutput('analyze-error')?.output || '').trim(); const retryOutputRaw = String($ctx.getNodeOutput('retry-task')?.output || '').trim(); const retryErrorRaw = String($ctx.getNodeOutput('retry-task')?.error || '').trim(); const truncate = (value, limit = 2000) => value.length > limit ? `${value.slice(0, limit)}...` : value; const diagnostics = [String($data?.lastError || '').trim(), analysisRaw ? `Recovery analysis:\n${truncate(analysisRaw)}` : '', retryOutputRaw ? `Retry output:\n${truncate(retryOutputRaw)}` : '', retryErrorRaw ? `Retry error:\n${truncate(retryErrorRaw)}` : ''].filter(Boolean).join('\n\n'); return { eventType: 'task.failed', taskId: $data?.taskId, taskTitle: $data?.taskTitle, worktreePath: $data?.worktreePath, branch: $data?.branch, baseBranch: $data?.baseBranch, error: diagnostics || String($data?.lastError || ''), recoveryAnalysis: truncate(analysisRaw), retryResult: { success: $ctx.getNodeOutput('retry-task')?.success === true, output: truncate(retryOutputRaw), error: truncate(retryErrorRaw) } }; })()",
    }, { x: 400, y: 760 }),
  ],
  edges: [
    edge("trigger", "check-retries"),
    edge("check-retries", "load-recovery-strategies", { condition: "$output?.result === true" }),
    edge("check-retries", "escalate", { condition: "$output?.result !== true" }),
    edge("load-recovery-strategies", "analyze-error"),
    edge("analyze-error", "retry-task"),
    edge("retry-task", "retry-succeeded"),
    edge("retry-succeeded", "notify-recovered", { condition: "$output?.result === true", port: "yes" }),
    edge("retry-succeeded", "chain-repair", { condition: "$output?.result !== true", port: "no" }),
    edge("chain-repair", "escalate"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.1.0",
    tags: ["error", "recovery", "autofix"],
    requiredTemplates: ["template-task-repair-worktree"],
    replaces: {
      module: "monitor.mjs",
      functions: ["runCodexRecovery"],
      calledFrom: ["monitor.mjs:runMonitorMonitorCycle"],
      description: "Replaces hardcoded error recovery logic. " +
        "Retry/escalate decisions are now visual workflow branches.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Anomaly Watchdog (death-loop / stall detection)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const ANOMALY_WATCHDOG_TEMPLATE = {
  id: "template-anomaly-watchdog",
  name: "Anomaly Watchdog",
  description:
    "Real-time anomaly detection for agent sessions — catches death loops, " +
    "stalls, token overflows, rebase spirals, and thought spinning. " +
    "Automatically intervenes or escalates depending on severity.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    stallThresholdMs: 300000,
    maxTokenUsage: 0.9,
    maxConsecutiveErrors: 5,
  },
  nodes: [
    node("trigger", "trigger.event", "Agent Anomaly Detected", {
      eventType: "agent.anomaly",
      filter: "$event?.severity === 'high' || $event?.severity === 'critical'",
    }, { x: 400, y: 50 }),

    node("classify", "condition.switch", "Classify Anomaly", {
      value: "$data?.anomalyType || 'unknown'",
      cases: {
        "DEATH_LOOP": "death-loop",
        "STALL": "stall",
        "TOKEN_OVERFLOW": "token-overflow",
        "REBASE_SPIRAL": "rebase-spiral",
        "THOUGHT_SPIN": "thought-spin",
      },
    }, { x: 400, y: 200, outputs: ["death-loop", "stall", "token-overflow", "rebase-spiral", "thought-spin", "default"] }),

    node("kill-and-restart", "action.restart_agent", "Kill & Restart Agent", {
      sessionId: "{{sessionId}}",
      reason: "Death loop detected — agent cycling through the same error pattern",
      prompt: "The previous session entered a death loop. Start fresh with a different approach.\n\nOriginal task: {{taskTitle}}",
    }, { x: 100, y: 380 }),

    node("nudge-stall", "action.continue_session", "Nudge Stalled Agent", {
      sessionId: "{{sessionId}}",
      prompt: "You appear to be stalled. Please continue working on the current task. If you are stuck, describe the blocker and try a different approach.",
      strategy: "continue",
    }, { x: 300, y: 380 }),

    node("trim-context", "action.continue_session", "Trim Context & Continue", {
      sessionId: "{{sessionId}}",
      prompt: "Your context window is nearly full. Summarize your progress so far in 2-3 sentences, then continue with the most critical remaining work.",
      strategy: "refine",
    }, { x: 500, y: 380 }),

    node("fix-rebase", "action.run_command", "Fix Stuck Rebase", {
      command: "git rebase --abort 2>/dev/null; git reset --hard HEAD; git checkout -B {{branch}} origin/{{branch}} 2>/dev/null || true",
      cwd: "{{worktreePath}}",
    }, { x: 700, y: 380 }),

    node("break-spin", "action.continue_session", "Break Thought Spin", {
      sessionId: "{{sessionId}}",
      prompt: "Stop your current analysis. You are repeating the same reasoning. Take a concrete action NOW:\n1. Make a specific code change, OR\n2. Run a specific command, OR\n3. Report that you are blocked and need help.\nDo NOT continue analyzing.",
      strategy: "continue",
    }, { x: 900, y: 380 }),

    node("log-intervention", "notify.log", "Log Intervention", {
      message: "Anomaly watchdog intervened: {{anomalyType}} for session {{sessionId}}",
      level: "warn",
    }, { x: 400, y: 550 }),

    node("alert-telegram", "notify.telegram", "Alert Human", {
      message: ":alert: Agent anomaly detected: **{{anomalyType}}**\nSession: {{sessionId}}\nTask: {{taskTitle}}\nIntervention: auto-applied\nThresholds: stall={{stallThresholdMs}}ms token={{maxTokenUsage}} maxErrors={{maxConsecutiveErrors}}",
    }, { x: 400, y: 700 }),
  ],
  edges: [
    edge("trigger", "classify"),
    edge("classify", "kill-and-restart", { port: "death-loop" }),
    edge("classify", "nudge-stall", { port: "stall" }),
    edge("classify", "trim-context", { port: "token-overflow" }),
    edge("classify", "fix-rebase", { port: "rebase-spiral" }),
    edge("classify", "break-spin", { port: "thought-spin" }),
    edge("kill-and-restart", "log-intervention"),
    edge("nudge-stall", "log-intervention"),
    edge("trim-context", "log-intervention"),
    edge("fix-rebase", "log-intervention"),
    edge("break-spin", "log-intervention"),
    edge("log-intervention", "alert-telegram"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["anomaly", "watchdog", "death-loop", "stall", "reliability"],
    replaces: {
      module: "anomaly-detector.mjs",
      functions: ["AnomalyDetector.processLine", "onAnomaly callback"],
      calledFrom: ["monitor.mjs:startAgentAlertTailer"],
      description: "Replaces hardcoded anomaly detection responses with a visual " +
        "workflow. Each anomaly type (death loop, stall, token overflow, rebase " +
        "spiral, thought spin) routes to a specific intervention node.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Workspace Hygiene (maintenance + reaper)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const WORKSPACE_HYGIENE_TEMPLATE = {
  id: "template-workspace-hygiene",
  name: "Workspace Hygiene",
  description:
    "Scheduled maintenance sweep: prune orphaned worktrees, kill stale " +
    "processes, rotate logs, and clean up old agent evidence. Keeps " +
    "your dev environment lean.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    staleProcessMaxAge: "15m",
    worktreeMaxAge: "48h",
    logRetentionDays: 7,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Daily Cleanup", {
      intervalMs: 86400000,
      cron: "0 3 * * *",
    }, { x: 400, y: 50 }),

    node("prune-worktrees", "action.run_command", "Prune Worktrees", {
      command: "node -e \"const cp=require('node:child_process');cp.execSync('git worktree prune',{stdio:'ignore'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"",
    }, { x: 150, y: 200 }),

    node("kill-stale", "action.run_command", "Kill Stale Processes", {
      command: "bosun maintenance --kill-stale --max-age {{staleProcessMaxAge}}",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("rotate-logs", "action.run_command", "Rotate Agent Logs", {
      command: "node -e \"const fs=require('node:fs');const path=require('node:path');const root=path.resolve('.bosun','logs');const cutoff=Date.now()-((Number('{{logRetentionDays}}')||7)*86400000);let removed=0;const walk=(dir)=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile()&&entry.name.endsWith('.log')){const stat=fs.statSync(full);if(Number(stat.mtimeMs||0)<cutoff){fs.rmSync(full,{force:true});removed+=1;}}}};walk(root);process.stdout.write('Rotated '+removed+'\\n');\"",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("clean-evidence", "action.run_command", "Clean Old Evidence", {
      command: "node -e \"const fs=require('node:fs');const path=require('node:path');const root=path.resolve('.bosun','evidence');const cutoff=Date.now()-((Number('{{logRetentionDays}}')||7)*86400000);let removed=0;const walk=(dir)=>{if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.isFile()){const stat=fs.statSync(full);if(Number(stat.mtimeMs||0)<cutoff){fs.rmSync(full,{force:true});removed+=1;}}}};walk(root);process.stdout.write('Cleaned '+removed+'\\n');\"",
      continueOnError: true,
    }, { x: 150, y: 380 }),

    node("check-disk", "action.run_command", "Check Disk Usage", {
      command: "du -sh .bosun/ 2>/dev/null || dir /s .bosun 2>nul",
    }, { x: 400, y: 380 }),

    node("gc-git", "action.run_command", "Git GC", {
      command: "git gc --auto --quiet",
      continueOnError: true,
    }, { x: 650, y: 380 }),

    node("summary", "notify.log", "Log Summary", {
      message: "Workspace hygiene sweep completed (max worktree age target: {{worktreeMaxAge}})",
      level: "info",
    }, { x: 400, y: 540 }),
  ],
  edges: [
    edge("trigger", "prune-worktrees"),
    edge("trigger", "kill-stale"),
    edge("trigger", "rotate-logs"),
    edge("prune-worktrees", "clean-evidence"),
    edge("kill-stale", "check-disk"),
    edge("rotate-logs", "gc-git"),
    edge("clean-evidence", "summary"),
    edge("check-disk", "summary"),
    edge("gc-git", "summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["maintenance", "cleanup", "worktree", "hygiene"],
    replaces: {
      module: "maintenance.mjs",
      functions: ["runMaintenanceSweep", "killStaleOrchestrators", "reapStuckGitPushes", "cleanupWorktrees"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the hardcoded maintenance sweep with a visual workflow. " +
        "Worktree pruning, stale process cleanup, log rotation, and git gc " +
        "become explicit, configurable workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Health Check & Config Doctor
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const HEALTH_CHECK_TEMPLATE = {
  id: "template-health-check",
  name: "Health Check",
  description:
    "Periodic system health check: validates config, verifies SDK " +
    "availability, checks git state, and reports any issues found.",
  category: "reliability",
  enabled: true,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 3600000,
    maxBenchmarkRuns: 12,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Health Check", {
      intervalMs: "{{intervalMs}}",
      cron: "0 * * * *",
    }, { x: 400, y: 50 }),

    node("check-config", "action.bosun_cli", "Check Config", {
      subcommand: "doctor",
      args: "--json",
    }, { x: 150, y: 200 }),

    node("check-git", "action.run_command", "Check Git State", {
      command: "node -e \"const cp=require('node:child_process');const status=cp.execSync('git status --porcelain',{encoding:'utf8'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(status + (status.endsWith('\\\\n') ? '' : '\\\\n') + count + '\\\\n');\"",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("check-agents", "action.run_command", "Check Agent Status", {
      command: "node -e \"const cp=require('node:child_process');try{process.stdout.write(cp.execSync('bosun --daemon-status',{encoding:'utf8'}));}catch{process.stdout.write('daemon not running\\\\n');}\"",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("has-issues", "condition.expression", "Any Issues?", {
      expression: "($ctx.getNodeOutput('check-config')?.success === false) || (($ctx.getNodeOutput('check-config')?.output || '').includes('ERROR')) || (($ctx.getNodeOutput('check-config')?.output || '').includes('CRITICAL')) || ($ctx.getNodeOutput('check-git')?.success === false) || ($ctx.getNodeOutput('check-agents')?.success === false)",
    }, { x: 400, y: 380 }),

    node("log-ratchet-keep", "notify.log", "Log Ratchet Keep", {
      message: "Self-improvement ratchet kept baseline for run {{$ctx.getNodeOutput('apply-ratchet')?.runId || ''}}: {{$ctx.getNodeOutput('apply-ratchet')?.summary || 'no baseline change'}}",
      level: "warn",
    }, { x: 1320, y: 1120 }),

    node("log-no-runs", "notify.log", "Log No Benchmark Data", {
      message: "Health check self-improvement skipped: no recent completed or failed workflow runs available.",
      level: "debug",
    }, { x: 1120, y: 540 }),

    node("alert", "notify.telegram", "Alert Issues Found", {
      message: ":heart: Health check found issues — run `bosun doctor` for details",
    }, { x: 200, y: 540 }),

    node("all-ok", "notify.telegram", "All Healthy", {
      message: "Health check passed — all systems operational",
      level: "info",
    }, { x: 600, y: 540 }),

    node("collect-recent-runs", "action.run_command", "Collect Recent Runs", {
      command:
        "node -e \"const fs=require('node:fs');const path=require('node:path');const base=path.join(process.cwd(),'.bosun','workflow-runs');const entries=fs.existsSync(base)?fs.readdirSync(base).filter((name)=>name.endsWith('.json')).sort().slice(-Number(process.env.BOSUN_HEALTH_MAX_BENCHMARK_RUNS||12)):[];const runIds=entries.map((name)=>path.basename(name,'.json'));process.stdout.write(JSON.stringify({runIds,latestRunId:runIds.at(-1)||''}));\"",
      env: {
        BOSUN_HEALTH_MAX_BENCHMARK_RUNS: "{{maxBenchmarkRuns}}",
      },
      parseJson: true,
      continueOnError: true,
    }, { x: 400, y: 640 }),

    node("has-recent-runs", "condition.expression", "Recent Runs Available?", {
      expression:
        "Array.isArray($ctx.getNodeOutput('collect-recent-runs')?.output?.runIds) && $ctx.getNodeOutput('collect-recent-runs')?.output?.runIds.length > 0",
    }, { x: 400, y: 760, outputs: ["yes", "no"] }),

    node("evaluate-latest-run", "action.evaluate_run", "Evaluate Latest Run", {
      runId: "{{collect-recent-runs.output.latestRunId}}",
      repoRoot: "{{repoRoot}}",
      includeTrend: true,
      recordHistory: true,
      outputVariable: "healthCheckEvaluation",
    }, { x: 220, y: 900 }),

    node("apply-ratchet", "action.apply_self_improvement_ratchet", "Apply Ratchet", {
      evaluationNodeId: "evaluate-latest-run",
      repoRoot: "{{repoRoot}}",
      outputVariable: "healthCheckRatchet",
    }, { x: 220, y: 1030 }),

    node("ratchet-applied", "condition.expression", "Ratchet Applied?", {
      expression:
        "['apply_candidate','capture_baseline','promote_strategy'].includes(String($ctx.getNodeOutput('apply-ratchet')?.decision || ''))",
    }, { x: 160, y: 1160, outputs: ["yes", "no"] }),

    node("ratchet-reverted", "condition.expression", "Ratchet Reverted?", {
      expression:
        "['revert_to_baseline','keep_baseline'].includes(String($ctx.getNodeOutput('apply-ratchet')?.decision || ''))",
    }, { x: 360, y: 1160, outputs: ["yes", "no"] }),

    node("log-ratchet-revert", "notify.log", "Log Ratchet Revert", {
      message:
        "Health check reverted or held baseline after latest run evaluation: {{$ctx.getNodeOutput('apply-ratchet')?.summary || $ctx.getNodeOutput('apply-ratchet')?.decision || 'no decision'}}",
      level: "warn",
    }, { x: 480, y: 1290 }),

    node("log-ratchet-applied", "notify.log", "Log Ratchet Applied", {
      message:
        "Health check ratchet updated from latest run evaluation: {{$ctx.getNodeOutput('apply-ratchet')?.summary || $ctx.getNodeOutput('apply-ratchet')?.decision || 'applied'}}",
      level: "info",
    }, { x: 160, y: 1290 }),
  ],
  edges: [
    edge("trigger", "check-config"),
    edge("trigger", "check-git"),
    edge("trigger", "check-agents"),
    edge("check-config", "has-issues"),
    edge("check-git", "has-issues"),
    edge("check-agents", "has-issues"),
    edge("has-issues", "alert", { condition: "$output?.result === true" }),
    edge("has-issues", "all-ok", { condition: "$output?.result !== true" }),
    edge("alert", "collect-recent-runs"),
    edge("all-ok", "collect-recent-runs"),
    edge("collect-recent-runs", "has-recent-runs"),
    edge("has-recent-runs", "evaluate-latest-run", { condition: "$output?.result === true", port: "yes" }),
    edge("has-recent-runs", "log-no-runs", { condition: "$output?.result !== true", port: "no" }),
    edge("evaluate-latest-run", "apply-ratchet"),
    edge("apply-ratchet", "ratchet-applied"),
    edge("ratchet-applied", "log-ratchet-applied", { condition: "$output?.result === true", port: "yes" }),
    edge("ratchet-applied", "ratchet-reverted", { condition: "$output?.result !== true", port: "no" }),
    edge("ratchet-reverted", "log-ratchet-revert", { condition: "$output?.result === true", port: "yes" }),
    edge("ratchet-reverted", "log-ratchet-keep", { condition: "$output?.result !== true", port: "no" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.1.0",
    tags: ["health", "config", "doctor", "monitoring", "self-improvement", "benchmark"],
    replaces: {
      module: "config-doctor.mjs",
      functions: ["runConfigDoctor"],
      calledFrom: ["cli.mjs:doctor command"],
      description: "Replaces manual config-doctor runs with a scheduled health " +
        "check workflow. Config validation, git state, and agent status " +
        "checks run in parallel with automatic alerting.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Finalization Guard
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_FINALIZATION_GUARD_TEMPLATE = {
  id: "template-task-finalization-guard",
  name: "Task Finalization Guard",
  description:
    "Shared post-completion quality gate for all agents. Runs pre-push " +
    "validation in the task worktree, normalizes status transitions, and " +
    "hands off failures to a dedicated repair workflow.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    finalizationTimeoutMs: 3600000,
    baseBranch: "main",
    finalizationCommand:
      "node -e \"const cp=require('node:child_process');const cmds=['npm run prepush --if-present','npm run prepush:check --if-present','npm run build','npm test','npm run lint --if-present'];for(const cmd of cmds){cp.execSync(cmd,{stdio:'inherit'});} \"",
  },
  nodes: [
    node("trigger", "trigger.event", "Task Completed", {
      eventType: "task.completed",
    }, { x: 400, y: 50 }),

    node("has-worktree", "condition.expression", "Worktree Context Available?", {
      expression: "Boolean($data?.worktreePath)",
    }, { x: 400, y: 190 }),

    node("run-finalization", "action.run_command", "Run Finalization Checks", {
      command: "{{finalizationCommand}}",
      cwd: "{{worktreePath}}",
      timeoutMs: "{{finalizationTimeoutMs}}",
      continueOnError: true,
    }, { x: 220, y: 330 }),

    node("checks-passed", "condition.expression", "Checks Passed?", {
      expression: "$ctx.getNodeOutput('run-finalization')?.success === true",
    }, { x: 220, y: 470 }),

    node("has-pr", "condition.expression", "Lifecycle Already Linked?", {
      expression: "Boolean($data?.prNumber || $data?.prUrl)",
    }, { x: 120, y: 620 }),

    node("create-pr", "action.create_pr", "Handoff Lifecycle If Missing", {
      title: "{{taskTitle}}",
      body: "## Summary\n\n{{taskDescription}}\n\nPR created by task finalization guard to ensure lifecycle handoff.\n\n---\nTask-ID: {{taskId}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      failOnError: true,
      maxRetries: 3,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 120, y: 760 }),

    node("create-pr-success", "condition.expression", "Lifecycle Handoff Recorded?", {
      expression: "$ctx.getNodeOutput('create-pr')?.success === true",
    }, { x: 120, y: 830, outputs: ["yes", "no"] }),

    node("mark-inreview", "action.update_task_status", "Set In Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
      workflowEvent: "task.finalization_passed",
      workflowData: {
        stage: "finalization",
        result: "passed",
        branch: "{{branch}}",
        worktreePath: "{{worktreePath}}",
        prNumber: "{{prNumber}}",
        prUrl: "{{prUrl}}",
      },
    }, { x: 240, y: 900 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Dispatch PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$data?.prNumber ?? $ctx.getNodeOutput('create-pr')?.prNumber ?? null}}",
        prUrl: "{{$data?.prUrl || $ctx.getNodeOutput('create-pr')?.prUrl || ''}}",
        repo: "{{$data?.repo || $data?.repoSlug || $data?.repository || $ctx.getNodeOutput('create-pr')?.repoSlug || ''}}",
      },
    }, { x: 240, y: 1040 }),

    node("mark-todo-failed", "action.update_task_status", "Mark Todo (Checks Failed)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
      workflowEvent: "task.finalization_failed",
      workflowData: {
        stage: "finalization",
        reason: "verification_failed",
        branch: "{{branch}}",
        worktreePath: "{{worktreePath}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 480, y: 620 }),

    node("mark-todo-missing", "action.update_task_status", "Mark Todo (Missing Context)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
      workflowEvent: "task.finalization_failed",
      workflowData: {
        stage: "finalization",
        reason: "missing_worktree_context",
        branch: "{{branch}}",
        worktreePath: "{{worktreePath}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 620, y: 330 }),
    node("has-pr-missing-context", "condition.expression", "PR Linked Without Worktree?", {
      expression: "Boolean($data?.prNumber || $data?.prUrl)",
    }, { x: 620, y: 450, outputs: ["yes", "no"] }),

    node("notify-skip-missing-context", "notify.log", "Skip Missing Context With PR", {
      message: "Task {{taskId}} finalization skipped quality gate: missing worktree context but PR linkage exists",
      level: "warn",
    }, { x: 620, y: 560 }),

    node("notify-pass", "notify.log", "Log Finalization Success", {
      message: "Task {{taskId}} finalization passed — moved to inreview",
      level: "info",
    }, { x: 240, y: 1180 }),

    node("chain-archiver", "flow.universal", "Queue Archival", {
      workflowId: "template-task-archiver",
      mode: "dispatch",
      input: "({taskId: $data?.taskId, taskTitle: $data?.taskTitle, completedAt: new Date().toISOString(), taskJson: JSON.stringify($data?.task || {id: $data?.taskId, title: $data?.taskTitle})})",
    }, { x: 240, y: 1320 }),

    node("end-success", "flow.end", "End Success", {
      status: "completed",
      message: "Task finalization guard completed successfully for {{taskId}}",
      output: {
        outcome: "passed",
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
      },
    }, { x: 240, y: 1450 }),

    node("notify-fail", "notify.telegram", "Notify Finalization Failure", {
      message: ":alert: Task finalization failed for **{{taskTitle}}** ({{taskId}}). Repair workflow handoff triggered.",
    }, { x: 540, y: 900 }),

    node("end-failed", "flow.end", "End Failed", {
      status: "failed",
      message: "Task finalization guard failed for {{taskId}}",
      output: {
        outcome: "failed",
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
      },
    }, { x: 540, y: 1040 }),
  ],
  edges: [
    edge("trigger", "has-worktree"),
    edge("has-worktree", "run-finalization", { condition: "$output?.result === true" }),
    edge("has-worktree", "has-pr-missing-context", { condition: "$output?.result !== true" }),
    edge("has-pr-missing-context", "notify-skip-missing-context", { condition: "$output?.result === true", port: "yes" }),
    edge("has-pr-missing-context", "mark-todo-missing", { condition: "$output?.result !== true", port: "no" }),
    edge("run-finalization", "checks-passed"),
    edge("checks-passed", "has-pr", { condition: "$output?.result === true" }),
    edge("checks-passed", "mark-todo-failed", { condition: "$output?.result !== true" }),
    edge("has-pr", "mark-inreview", { condition: "$output?.result === true" }),
    edge("has-pr", "create-pr", { condition: "$output?.result !== true" }),
    edge("create-pr", "create-pr-success"),
    edge("create-pr-success", "mark-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("create-pr-success", "mark-todo-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("mark-inreview", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "notify-pass"),
    edge("notify-skip-missing-context", "end-success"),
    edge("notify-pass", "chain-archiver"),
    edge("chain-archiver", "end-success"),
    edge("mark-todo-failed", "notify-fail"),
    edge("mark-todo-missing", "notify-fail"),
    edge("notify-fail", "end-failed"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-26T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["finalization", "quality-gate", "prepush", "handoff", "reliability"],
    requiredTemplates: ["template-task-archiver", "template-bosun-pr-progressor"],
    replaces: {
      module: "task-executor.mjs",
      functions: ["_handleTaskResult finalization gate"],
      calledFrom: ["task-executor.mjs:_handleTaskResult"],
      description:
        "Adds a shared post-completion finalization workflow so task quality " +
        "checks and status transitions are consistent across all agents.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Repair Worktree
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_REPAIR_WORKTREE_TEMPLATE = {
  id: "template-task-repair-worktree",
  name: "Task Repair Worktree",
  description:
    "Recovery workflow for tasks that fail execution or finalization. " +
    "Refreshes worktree state, runs a repair agent, re-validates quality " +
    "gates, and escalates only after automated repair fails.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    repairTimeoutMs: 5400000,
    verificationTimeoutMs: 3600000,
    repoRoot: "",
    defaultTargetBranch: "main",
    baseBranch: "main",
    verificationCommand:
      "node -e \"const cp=require('node:child_process');const cmds=['npm run prepush --if-present','npm run prepush:check --if-present','npm run build','npm test','npm run lint --if-present'];for(const cmd of cmds){cp.execSync(cmd,{stdio:'inherit'});} \"",
    repairPrompt:
      "Task {{taskId}} ({{taskTitle}}) failed. Error: {{error}}. Repair the implementation in {{worktreePath}} without bypassing tests, then leave the branch ready for Bosun PR lifecycle handoff.",
  },
  nodes: [
    node("trigger-failed", "trigger.event", "Task Failed", {
      eventType: "task.failed",
    }, { x: 250, y: 50 }),

    node("trigger-finalization", "trigger.event", "Finalization Failed", {
      eventType: "task.finalization_failed",
    }, { x: 550, y: 50 }),

    node("has-branch-context", "condition.expression", "Branch Context Available?", {
      expression: "Boolean($data?.repoRoot) && Boolean($data?.branch) && Boolean($data?.taskId)",
    }, { x: 400, y: 180, outputs: ["yes", "no"] }),

    node("recover-repair-worktree", "action.recover_worktree", "Reset Broken Worktree", {
      worktreePath: "{{worktreePath}}",
      branch: "{{branch}}",
      repoRoot: "{{repoRoot}}",
      taskId: "{{taskId}}",
    }, { x: 220, y: 320 }),

    node("acquire-repair-worktree", "action.acquire_worktree", "Acquire Clean Worktree", {
      repoRoot: "{{repoRoot}}",
      branch: "{{branch}}",
      taskId: "{{taskId}}",
      baseBranch: "{{baseBranch}}",
      defaultTargetBranch: "{{defaultTargetBranch}}",
    }, { x: 220, y: 460 }),

    node("acquired-repair-worktree", "condition.expression", "Clean Worktree Ready?", {
      expression: "$ctx.getNodeOutput('acquire-repair-worktree')?.success === true",
    }, { x: 220, y: 600, outputs: ["yes", "no"] }),

    node("has-worktree", "condition.expression", "Fallback Worktree Context Available?", {
      expression: "Boolean($data?.worktreePath)",
    }, { x: 560, y: 320, outputs: ["yes", "no"] }),

    node("refresh-worktree", "action.refresh_worktree", "Refresh Worktree", {
      operation: "fetch",
      cwd: "{{$ctx.getNodeOutput('acquire-repair-worktree')?.worktreePath || $data?.worktreePath || ''}}",
      continueOnError: true,
    }, { x: 400, y: 740 }),

    node("repair-agent", "action.run_agent", "Repair Task", {
      prompt: "{{repairPrompt}}",
      cwd: "{{$ctx.getNodeOutput('acquire-repair-worktree')?.worktreePath || $data?.worktreePath || ''}}",
      timeoutMs: "{{repairTimeoutMs}}",
    }, { x: 400, y: 880 }),

    node("verify", "action.run_command", "Re-run Quality Gates", {
      command: "{{verificationCommand}}",
      cwd: "{{$ctx.getNodeOutput('acquire-repair-worktree')?.worktreePath || $data?.worktreePath || ''}}",
      timeoutMs: "{{verificationTimeoutMs}}",
      continueOnError: true,
    }, { x: 400, y: 1020 }),

    node("verify-passed", "condition.expression", "Repair Passed?", {
      expression: "$ctx.getNodeOutput('verify')?.success === true",
    }, { x: 400, y: 1160 }),

    node("create-pr", "action.create_pr", "Handoff/Refresh Lifecycle", {
      title: "{{taskTitle}}",
      body: "## Summary\n\n{{taskDescription}}\n\nAutomated repair run — code fixes applied and validated.\n\n---\nTask-ID: {{taskId}}",
      base: "{{baseBranch}}",
      branch: "{{branch}}",
      failOnError: true,
      maxRetries: 3,
      retryDelayMs: 15000,
      continueOnError: true,
    }, { x: 250, y: 1300 }),

    node("create-pr-success", "condition.expression", "Lifecycle Handoff Ready?", {
      expression: "$ctx.getNodeOutput('create-pr')?.success === true",
    }, { x: 250, y: 1370, outputs: ["yes", "no"] }),

    node("mark-inreview", "action.update_task_status", "Set In Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
      workflowEvent: "task.repair_succeeded",
      workflowData: {
        stage: "repair",
        result: "passed",
        branch: "{{branch}}",
        worktreePath: "{{worktreePath}}",
      },
    }, { x: 250, y: 1440 }),

    node("clear-repair-blocked-success", "action.bosun_function", "Clear Repair Blocked State", {
      function: "tasks.update",
      args: {
        taskId: "{{taskId}}",
        metaDeleteKeys: ["autoRecovery", "worktreeFailure", "blockedReason"],
        fields: {
          cooldownUntil: null,
          blockedReason: null,
          blockedContext: null,
          repairState: "completed",
        },
      },
    }, { x: 250, y: 1510 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Dispatch PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        prNumber: "{{$data?.prNumber ?? $ctx.getNodeOutput('create-pr')?.prNumber ?? null}}",
        prUrl: "{{$data?.prUrl || $ctx.getNodeOutput('create-pr')?.prUrl || ''}}",
        repo: "{{$data?.repo || $data?.repoSlug || $data?.repository || $ctx.getNodeOutput('create-pr')?.repoSlug || ''}}",
      },
    }, { x: 250, y: 1650 }),

    node("mark-todo", "action.update_task_status", "Mark Todo (Repair Failed)", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
      workflowEvent: "task.repair_failed",
      workflowData: {
        stage: "repair",
        reason: "verification_failed",
        branch: "{{branch}}",
        worktreePath: "{{worktreePath}}",
        baseBranch: "{{baseBranch}}",
      },
    }, { x: 560, y: 1300 }),

    node("clear-repair-blocked-failure", "action.bosun_function", "Clear Failed Repair Blocked State", {
      function: "tasks.update",
      args: {
        taskId: "{{taskId}}",
        metaDeleteKeys: ["autoRecovery", "worktreeFailure", "blockedReason"],
        fields: {
          cooldownUntil: null,
          blockedReason: null,
        },
      },
    }, { x: 560, y: 1440 }),

    node("notify-success", "notify.telegram", "Notify Repair Success", {
      message: ":check: Repair workflow recovered **{{taskTitle}}** ({{taskId}}) and moved it to inreview.",
      silent: true,
    }, { x: 250, y: 1790 }),

    node("notify-escalate", "notify.telegram", "Escalate Repair Failure", {
      message: ":alert: Repair workflow could not recover **{{taskTitle}}** ({{taskId}}). Manual intervention required.",
    }, { x: 560, y: 1580 }),

    node("no-worktree", "notify.log", "Missing Worktree Context", {
      message: "Task repair skipped for {{taskId}} — missing worktreePath in event payload",
      level: "warn",
    }, { x: 720, y: 460 }),
  ],
  edges: [
    edge("trigger-failed", "has-branch-context"),
    edge("trigger-finalization", "has-branch-context"),
    edge("has-branch-context", "recover-repair-worktree", { condition: "$output?.result === true", port: "yes" }),
    edge("has-branch-context", "has-worktree", { condition: "$output?.result !== true", port: "no" }),
    edge("recover-repair-worktree", "acquire-repair-worktree"),
    edge("acquire-repair-worktree", "acquired-repair-worktree"),
    edge("acquired-repair-worktree", "refresh-worktree", { condition: "$output?.result === true", port: "yes" }),
    edge("acquired-repair-worktree", "no-worktree", { condition: "$output?.result !== true", port: "no" }),
    edge("has-worktree", "refresh-worktree", { condition: "$output?.result === true", port: "yes" }),
    edge("has-worktree", "no-worktree", { condition: "$output?.result !== true", port: "no" }),
    edge("refresh-worktree", "repair-agent"),
    edge("repair-agent", "verify"),
    edge("verify", "verify-passed"),
    edge("verify-passed", "create-pr", { condition: "$output?.result === true" }),
    edge("verify-passed", "mark-todo", { condition: "$output?.result !== true" }),
    edge("create-pr", "create-pr-success"),
    edge("create-pr-success", "mark-inreview", { condition: "$output?.result === true", port: "yes" }),
    edge("create-pr-success", "mark-todo", { condition: "$output?.result !== true", port: "no" }),
    edge("mark-inreview", "clear-repair-blocked-success"),
    edge("clear-repair-blocked-success", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "notify-success"),
    edge("mark-todo", "clear-repair-blocked-failure"),
    edge("clear-repair-blocked-failure", "notify-escalate"),
    edge("no-worktree", "notify-escalate"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-26T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["repair", "recovery", "worktree", "resilience", "automation"],
    requiredTemplates: ["template-bosun-pr-progressor"],
    replaces: {
      module: "task-executor.mjs",
      functions: ["retry/escalation recovery path"],
      calledFrom: ["task-executor.mjs:_handleTaskResult"],
      description:
        "Introduces a dedicated automated repair workflow that takes over " +
        "when task execution or finalization fails.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Orphan Worktree Recovery
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_ORPHAN_WORKTREE_RECOVERY_TEMPLATE = {
  id: "template-task-orphan-worktree-recovery",
  name: "Task Orphan Worktree Recovery",
  description:
    "Scheduled workflow-owned recovery for orphaned task worktrees. " +
    "Scans .cache/worktrees for abandoned task branches, auto-commits pending " +
    "changes, pushes recoverable branches, records PR handoff, and updates " +
    "task status to inreview when successful.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 1800000,
    baseBranch: "origin/main",
    maxRecoverPerSweep: 20,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Scheduled Recovery Sweep", {
      intervalMs: "{{intervalMs}}",
      cron: "*/30 * * * *",
    }, { x: 420, y: 50 }),

    node("recover", "action.run_command", "Recover Orphan Worktrees", {
      command:
        "node tools/workflow-orphan-worktree-recovery.mjs " +
        "--base \"{{baseBranch}}\" " +
        "--max \"{{maxRecoverPerSweep}}\"",
      failOnError: false,
    }, { x: 420, y: 190 }),

    node("parse-recovery", "transform.json_parse", "Parse Recovery Summary", {
      input: "recover",
      field: "output",
    }, { x: 420, y: 330 }),

    node("parse-ok", "condition.expression", "Recovery Summary Valid?", {
      expression: "$ctx.getNodeOutput('parse-recovery')?.success === true",
    }, { x: 420, y: 470, outputs: ["yes", "no"] }),

    node("has-recovered", "condition.expression", "Recovered Branches?", {
      expression: "Number($ctx.getNodeOutput('parse-recovery')?.data?.recovered || 0) > 0",
    }, { x: 420, y: 610, outputs: ["yes", "no"] }),

    node("log-recovered", "notify.log", "Log Recovery Success", {
      message:
        "Orphan recovery: recovered={{parse-recovery.data.recovered}} " +
        "skipped={{parse-recovery.data.skipped}} failed={{parse-recovery.data.failed}}",
      level: "info",
    }, { x: 250, y: 760 }),

    node("log-idle", "notify.log", "Log No Work", {
      message:
        "Orphan recovery: no recoverable orphaned worktrees found " +
        "(scanned={{parse-recovery.data.scanned}}, skipped={{parse-recovery.data.skipped}}).",
      level: "debug",
    }, { x: 560, y: 760 }),

    node("log-parse-failed", "notify.log", "Log Recovery Parse Failure", {
      message:
        "Orphan recovery workflow produced invalid JSON output. " +
        "Check tools/workflow-orphan-worktree-recovery.mjs execution logs.",
      level: "warn",
    }, { x: 760, y: 610 }),
  ],
  edges: [
    edge("trigger", "recover"),
    edge("recover", "parse-recovery"),
    edge("parse-recovery", "parse-ok"),
    edge("parse-ok", "has-recovered", { condition: "$output?.result === true", port: "yes" }),
    edge("parse-ok", "log-parse-failed", { condition: "$output?.result !== true", port: "no" }),
    edge("has-recovered", "log-recovered", { condition: "$output?.result === true", port: "yes" }),
    edge("has-recovered", "log-idle", { condition: "$output?.result !== true", port: "no" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-04T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["orphan", "recovery", "worktree", "lifecycle", "reliability"],
    replaces: {
      module: "task-executor.mjs",
      functions: ["_recoverOrphanedWorktrees"],
      calledFrom: ["task-executor.mjs:start"],
      description:
        "Moves orphaned worktree recovery out of the legacy task-executor " +
        "startup path and into a dedicated scheduled workflow.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Status Transition Manager
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_STATUS_TRANSITION_MANAGER_TEMPLATE = {
  id: "template-task-status-transition-manager",
  name: "Task Status Transition Manager",
  description:
    "Central workflow-owned task status transitions. Consumes task lifecycle " +
    "transition requests from executors/monitor and applies canonical status updates.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {},
  nodes: [
    node("trigger", "trigger.event", "Transition Requested", {
      eventType: "task.transition.requested",
    }, { x: 420, y: 60 }),

    node("route-status", "condition.switch", "Route Target Status", {
      value: "$data?.targetStatus || $data?.status || ''",
      cases: {
        inprogress: "inprogress",
        inreview: "inreview",
        done: "done",
        todo: "todo",
      },
    }, {
      x: 420,
      y: 220,
      outputs: ["inprogress", "inreview", "done", "todo", "default"],
    }),

    node("set-inprogress", "action.update_task_status", "Set In Progress", {
      taskId: "{{taskId}}",
      status: "inprogress",
      taskTitle: "{{taskTitle}}",
    }, { x: 120, y: 390 }),

    node("set-inreview", "action.update_task_status", "Set In Review", {
      taskId: "{{taskId}}",
      status: "inreview",
      taskTitle: "{{taskTitle}}",
    }, { x: 320, y: 390 }),

    node("set-done", "action.update_task_status", "Set Done", {
      taskId: "{{taskId}}",
      status: "done",
      taskTitle: "{{taskTitle}}",
    }, { x: 520, y: 390 }),

    node("set-todo", "action.update_task_status", "Set Todo", {
      taskId: "{{taskId}}",
      status: "todo",
      taskTitle: "{{taskTitle}}",
    }, { x: 720, y: 390 }),

    node("unknown-status", "notify.log", "Unknown Status Requested", {
      message: "Task {{taskId}} transition ignored: unsupported target status '{{targetStatus}}'",
      level: "warn",
    }, { x: 420, y: 520 }),
  ],
  edges: [
    edge("trigger", "route-status"),
    edge("route-status", "set-inprogress", { port: "inprogress" }),
    edge("route-status", "set-inreview", { port: "inreview" }),
    edge("route-status", "set-done", { port: "done" }),
    edge("route-status", "set-todo", { port: "todo" }),
    edge("route-status", "unknown-status", { port: "default" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-02-27T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["task", "status", "lifecycle", "workflow-owned"],
    replaces: {
      module: "task-executor.mjs",
      functions: ["direct status transition writes"],
      calledFrom: [
        "task-executor.mjs:executeTask",
        "task-executor.mjs:_recoverInterruptedInProgressTasks",
        "task-executor.mjs:_handleTaskResult",
      ],
      description:
        "Moves task state mutations from executor code into a dedicated " +
        "workflow so all status changes are auditable and event-driven.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Incident Response
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const INCIDENT_RESPONSE_TEMPLATE = {
  id: "template-incident-response",
  name: "Incident Response",
  description:
    "Automated incident management: detects error spikes or anomalous " +
    "patterns, creates an incident task, assigns an agent for investigation, " +
    "collects evidence, and escalates via notification channels.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.anomaly",
  variables: {
    errorThreshold: 5,
    escalationDelayMs: 600000,
    autoAssignAgent: true,
  },
  nodes: [
    node("trigger", "trigger.anomaly", "Error Spike Detected", {
      anomalyTypes: ["error-spike", "death-loop", "agent-stall"],
      threshold: "{{errorThreshold}}",
    }, { x: 400, y: 50 }),

    node("should-assign", "condition.expression", "Auto Assign Agent?", {
      expression: "Boolean($data?.autoAssignAgent !== false)",
    }, { x: 250, y: 690, outputs: ["yes", "no"] }),

    node("delay-escalation", "action.delay", "Escalation Delay", {
      ms: "{{escalationDelayMs}}",
      reason: "Allowing automatic mitigation window before escalation",
    }, { x: 150, y: 620 }),

    node("collect-evidence", "agent.evidence_collect", "Collect Evidence", {
      sources: ["logs", "git-status", "process-list", "recent-errors"],
      lookbackMinutes: 30,
    }, { x: 400, y: 200 }),

    node("classify-incident", "action.run_agent", "Classify Incident", {
      prompt: `# Incident Classification

Analyze the collected evidence:
{{evidence}}

Classify the incident:
1. **SEVERITY**: critical / high / medium / low
2. **CATEGORY**: agent-crash / build-failure / resource-exhaustion / stuck-process / unknown
3. **ROOT CAUSE**: One-line hypothesis
4. **IMPACT**: What is affected and who is impacted
5. **RECOMMENDED ACTION**: Immediate steps to mitigate

Output as JSON: { "severity": "...", "category": "...", "rootCause": "...", "impact": "...", "action": "..." }`,
      sdk: "auto",
      timeoutMs: 300000,
    }, { x: 400, y: 370 }),

    node("is-critical", "condition.expression", "Is Critical?", {
      expression: "($ctx.getNodeOutput('classify-incident')?.output || '').includes('\"severity\": \"critical\"') || ($ctx.getNodeOutput('classify-incident')?.output || '').includes('\"severity\":\"critical\"')",
    }, { x: 400, y: 540, outputs: ["yes", "no"] }),

    node("create-incident-task", "action.create_task", "Create Incident Task", {
      title: ":alert: Incident: {{incidentCategory}}",
      description: "Auto-detected incident.\n\nEvidence: {{evidence}}\n\nClassification: {{classification}}",
      tags: ["incident", "auto-detected"],
      priority: "high",
    }, { x: 400, y: 690 }),

    node("assign-agent", "action.run_agent", "Investigate & Mitigate", {
      prompt: `# Incident Investigation

An incident has been detected and classified:
{{classification}}

Evidence collected:
{{evidence}}

Your task:
1. Investigate the root cause in detail
2. Apply immediate mitigation if safe to do so
3. Document what you find and what you changed
4. If you cannot resolve it, document what you know for human review

Be conservative — prefer safe mitigations over aggressive fixes.`,
      sdk: "auto",
      timeoutMs: 1800000,
    }, { x: 250, y: 840 }),

    node("alert-critical", "notify.telegram", "Critical Incident Alert", {
      message: ":alert: **CRITICAL INCIDENT**\n\nCategory: {{incidentCategory}}\nRoot cause: {{rootCause}}\n\nAgent investigating. Immediate attention may be required.",
    }, { x: 150, y: 540 }),

    node("alert-standard", "notify.log", "Log Incident", {
      message: "Incident detected (non-critical): {{incidentCategory}} — agent assigned",
      level: "warn",
    }, { x: 600, y: 690 }),

    node("resolution-log", "notify.log", "Log Resolution", {
      message: "Incident response complete — see task for details",
      level: "info",
    }, { x: 400, y: 990 }),
  ],
  edges: [
    edge("trigger", "collect-evidence"),
    edge("collect-evidence", "classify-incident"),
    edge("classify-incident", "is-critical"),
    edge("is-critical", "delay-escalation", { condition: "$output?.result === true", port: "yes" }),
    edge("is-critical", "create-incident-task", { condition: "$output?.result !== true", port: "no" }),
    edge("delay-escalation", "alert-critical"),
    edge("alert-critical", "create-incident-task"),
    edge("create-incident-task", "alert-standard"),
    edge("create-incident-task", "should-assign"),
    edge("should-assign", "assign-agent", { condition: "$output?.result === true", port: "yes" }),
    edge("should-assign", "resolution-log", { condition: "$output?.result !== true", port: "no" }),
    edge("assign-agent", "resolution-log"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["incident", "response", "detection", "escalation", "reliability"],
    replaces: {
      module: "error-detector.mjs",
      functions: ["handleErrorSpike", "escalateAnomaly"],
      calledFrom: ["anomaly-detector.mjs:onAnomaly"],
      description:
        "Replaces reactive error handling with a structured incident response " +
        "workflow. Evidence collection, classification, task creation, and " +
        "agent assignment become explicit, auditable steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Archiver
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_ARCHIVER_TEMPLATE = {
  id: "template-task-archiver",
  name: "Task Archiver",
  description:
    "Automated archival of completed tasks — migrates old completed/cancelled " +
    "tasks to local archives, cleans up agent sessions, prunes archives " +
    "beyond retention, and optionally chains into Sprint Retrospective.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    ageHours: 24,
    maxArchivePerSweep: 50,
    retentionDays: 90,
    pruneEnabled: true,
    dryRun: false,
  },
  nodes: [
    node("trigger", "trigger.event", "Task Completed", {
      eventType: "task.status_changed",
      filter: "($event?.newStatus === 'done' || $event?.newStatus === 'cancelled')",
    }, { x: 400, y: 50 }),

    node("check-age", "condition.expression", "Old Enough to Archive?", {
      expression:
        "(() => { " +
        "const completedAt = new Date($data?.completedAt || $data?.updatedAt || 0); " +
        "if (isNaN(completedAt.getTime())) return false; " +
        "const ageHours = (Date.now() - completedAt.getTime()) / (1000 * 60 * 60); " +
        "return ageHours >= ($data?.ageHours || 24); " +
        "})()",
    }, { x: 400, y: 200, outputs: ["yes", "no"] }),

    node("check-already-archived", "condition.expression", "Already Archived?", {
      expression: "$data?.alreadyArchived === true",
    }, { x: 400, y: 350, outputs: ["yes", "no"] }),

    node("archive-to-file", "action.run_command", "Archive to Daily File", {
      command:
        "node -e \"" +
        "const {archiveTaskToFile} = await import('./task-archiver.mjs'); " +
        "const result = await archiveTaskToFile(JSON.parse(process.env.TASK_JSON)); " +
        "console.log(JSON.stringify({success: !!result, path: result}));\" ",
      env: { TASK_JSON: "{{taskJson}}", MAX_PER_SWEEP: "{{maxArchivePerSweep}}", DRY_RUN: "{{dryRun}}" },
      continueOnError: true,
    }, { x: 200, y: 500 }),

    node("cleanup-sessions", "action.run_command", "Cleanup Agent Sessions", {
      command:
        "node -e \"" +
        "const {cleanupAgentSessions} = await import('./task-archiver.mjs'); " +
        "const count = await cleanupAgentSessions('{{taskId}}', '{{attemptId}}'); " +
        "console.log(JSON.stringify({cleaned: count}));\" ",
      continueOnError: true,
    }, { x: 200, y: 650 }),

    node("delete-from-backend", "action.run_command", "Delete from Backend", {
      command:
        "node -e \"" +
        "const {deleteTaskFromVK} = await import('./task-archiver.mjs'); " +
        "const ok = await deleteTaskFromVK(null, '{{taskId}}'); " +
        "console.log(JSON.stringify({deleted: ok}));\" ",
      continueOnError: true,
    }, { x: 200, y: 800 }),

    node("should-prune", "condition.expression", "Prune Old Archives?", {
      expression: "Boolean($data?.pruneEnabled !== false)",
    }, { x: 500, y: 800, outputs: ["yes", "no"] }),

    node("prune-archives", "action.run_command", "Prune Expired Archives", {
      command:
        "node -e \"" +
        "const {pruneOldArchives} = await import('./task-archiver.mjs'); " +
        "const count = await pruneOldArchives({retentionDays: {{retentionDays}}}); " +
        "console.log(JSON.stringify({pruned: count}));\" ",
      continueOnError: true,
    }, { x: 500, y: 950 }),

    node("log-result", "notify.log", "Log Archive Result", {
      message: "Task {{taskId}} archived successfully. Sessions cleaned, backend updated.",
      level: "info",
    }, { x: 400, y: 1100 }),

    node("skip-log", "notify.log", "Skip — Not Ready", {
      message: "Task {{taskId}} not yet old enough to archive (threshold: {{ageHours}}h)",
      level: "debug",
    }, { x: 600, y: 350 }),

    node("already-archived-log", "notify.log", "Already Archived", {
      message: "Task {{taskId}} was already archived — skipping",
      level: "debug",
    }, { x: 600, y: 500 }),
  ],
  edges: [
    edge("trigger", "check-age"),
    edge("check-age", "check-already-archived", { condition: "$output?.result === true", port: "yes" }),
    edge("check-age", "skip-log", { condition: "$output?.result !== true", port: "no" }),
    edge("check-already-archived", "already-archived-log", { condition: "$output?.result === true", port: "yes" }),
    edge("check-already-archived", "archive-to-file", { condition: "$output?.result !== true", port: "no" }),
    edge("archive-to-file", "cleanup-sessions"),
    edge("cleanup-sessions", "delete-from-backend"),
    edge("delete-from-backend", "should-prune"),
    edge("should-prune", "prune-archives", { condition: "$output?.result === true", port: "yes" }),
    edge("should-prune", "log-result", { condition: "$output?.result !== true", port: "no" }),
    edge("prune-archives", "log-result"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["archive", "cleanup", "task", "maintenance", "reliability"],
    replaces: {
      module: "task-archiver.mjs",
      functions: [
        "archiveCompletedTasks",
        "archiveTaskToFile",
        "cleanupAgentSessions",
        "pruneOldArchives",
        "deleteTaskFromVK",
      ],
      calledFrom: [
        "monitor.mjs:startup",
        "monitor.mjs:safeSetInterval(archiveCompletedTasks)",
      ],
      description:
        "Replaces the monolithic archiveCompletedTasks sweep with an " +
        "event-driven workflow. Each task completion fires the archiver " +
        "instead of a periodic cron sweep, enabling per-task auditing " +
        "and eliminating batch-scan overhead.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Sync Engine (Kanban ↔ Internal Task Store)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SYNC_ENGINE_TEMPLATE = {
  id: "template-sync-engine",
  name: "Kanban Sync Engine",
  description:
    "Two-way synchronisation between internal task store and external " +
    "kanban backends (GitHub Issues, Jira). Pulls new/changed tasks " +
    "from the external board, pushes internal status updates outward, " +
    "detects conflicts, and handles rate-limit back-off.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    syncPolicy: "internal-primary",
    syncIntervalMs: 60000,
    failureAlertThreshold: 3,
    rateLimitAlertThreshold: 3,
    backoffIntervalMs: 300000,
    backoffThreshold: 5,
  },
  nodes: [
    node("trigger", "trigger.event", "Sync Trigger", {
      eventType: "sync.requested",
      description: "Fires on task status changes, startup, or periodic heartbeat",
      intervalMs: "{{syncIntervalMs}}",
    }, { x: 400, y: 50 }),

    node("pull-external", "action.run_command", "Pull from External", {
      command:
        "node -e \"" +
        "const {createSyncEngine} = await import('./sync-engine.mjs'); " +
        "const engine = createSyncEngine({projectId: '{{projectId}}'}); " +
        "const result = await engine.pullFromExternal(); " +
        "console.log(JSON.stringify(result));\" ",
      timeoutMs: 120000,
      continueOnError: true,
    }, { x: 200, y: 200 }),

    node("pull-ok", "condition.expression", "Pull Succeeded?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('pull-external'); " +
        "return out?.success !== false && (!out?.errors || out.errors.length === 0); })()",
    }, { x: 200, y: 380, outputs: ["yes", "no"] }),

    node("push-internal", "action.run_command", "Push to External", {
      command:
        "node -e \"" +
        "const {createSyncEngine} = await import('./sync-engine.mjs'); " +
        "const engine = createSyncEngine({projectId: '{{projectId}}'}); " +
        "const result = await engine.pushToExternal(); " +
        "console.log(JSON.stringify(result));\" ",
      timeoutMs: 120000,
      continueOnError: true,
    }, { x: 200, y: 530 }),

    node("push-ok", "condition.expression", "Push Succeeded?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('push-internal'); " +
        "return out?.success !== false && (!out?.errors || out.errors.length === 0); })()",
    }, { x: 200, y: 700, outputs: ["yes", "no"] }),

    node("check-rate-limit", "condition.expression", "Rate Limited?", {
      expression:
        "(() => { " +
        "const pull = $ctx.getNodeOutput('pull-external'); " +
        "const push = $ctx.getNodeOutput('push-internal'); " +
        "const allErrors = [...(pull?.errors || []), ...(push?.errors || [])]; " +
        "const rateLimitHits = allErrors.filter(e => /rate.limit|429|throttl/i.test(String(e))).length; " +
        "return rateLimitHits >= ($data?.rateLimitAlertThreshold || 3); " +
        "})()",
    }, { x: 500, y: 700, outputs: ["yes", "no"] }),

    node("handle-rate-limit", "action.handle_rate_limit", "Back-off & Retry", {
      delayMs: "{{backoffIntervalMs}}",
      maxRetries: "{{backoffThreshold}}",
      reason: "External kanban rate limit hit during sync",
    }, { x: 700, y: 700 }),

    node("count-failures", "action.set_variable", "Track Consecutive Failures", {
      key: "consecutiveFailures",
      value:
        "(() => { const prev = Number($data?.consecutiveFailures || 0); return prev + 1; })()",
      isExpression: true,
    }, { x: 500, y: 380 }),

    node("should-alert", "condition.expression", "Alert Threshold?", {
      expression: "Number($data?.consecutiveFailures || 0) >= Number($data?.failureAlertThreshold || 3)",
    }, { x: 500, y: 530, outputs: ["yes", "no"] }),

    node("alert-failures", "notify.telegram", "Sync Failure Alert", {
      message:
        ":warning: Kanban sync has failed **{{consecutiveFailures}}** consecutive times.\n" +
        "Policy: {{syncPolicy}}\n" +
        "Last errors: {{lastSyncErrors}}",
    }, { x: 700, y: 530 }),

    node("log-success", "notify.log", "Log Sync Success", {
      message: "Kanban sync complete — pulled: {{pullCount}}, pushed: {{pushCount}}, conflicts: {{conflictCount}}",
      level: "info",
    }, { x: 200, y: 880 }),

    node("log-partial", "notify.log", "Log Partial Sync", {
      message: "Kanban sync partial — some operations failed. Errors: {{lastSyncErrors}}",
      level: "warn",
    }, { x: 500, y: 880 }),
  ],
  edges: [
    edge("trigger", "pull-external"),
    edge("pull-external", "pull-ok"),
    edge("pull-ok", "push-internal", { condition: "$output?.result === true", port: "yes" }),
    edge("pull-ok", "count-failures", { condition: "$output?.result !== true", port: "no" }),
    edge("push-internal", "push-ok"),
    edge("push-ok", "check-rate-limit", { condition: "$output?.result !== true", port: "no" }),
    edge("push-ok", "log-success", { condition: "$output?.result === true", port: "yes" }),
    edge("check-rate-limit", "handle-rate-limit", { condition: "$output?.result === true", port: "yes" }),
    edge("check-rate-limit", "count-failures", { condition: "$output?.result !== true", port: "no" }),
    edge("handle-rate-limit", "log-partial"),
    edge("count-failures", "should-alert"),
    edge("should-alert", "alert-failures", { condition: "$output?.result === true", port: "yes" }),
    edge("should-alert", "log-partial", { condition: "$output?.result !== true", port: "no" }),
    edge("alert-failures", "log-partial"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-06-01T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["sync", "kanban", "github", "jira", "bidirectional"],
    replaces: {
      module: "sync-engine.mjs",
      functions: [
        "SyncEngine.pullFromExternal",
        "SyncEngine.pushToExternal",
        "SyncEngine.sync",
      ],
      calledFrom: [
        "monitor.mjs:initSyncEngine",
        "sync-engine.mjs:SyncEngine.start",
      ],
      description:
        "Replaces the SyncEngine class lifecycle with a workflow. " +
        "Pull/push/rate-limit steps become visible, auditable nodes. " +
        "Event-driven triggers replace the fixed-interval timer, and " +
        "failure alerting is built into the flow.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Recover Blocked Task (Worktree) — sub-workflow
//  Invoked by template-recover-blocked-worktrees via loop.for_each dispatch.
//  Each item arrives as $data.item; falls back to $data.* for standalone use.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RECOVER_BLOCKED_TASK_TEMPLATE = {
  id: "template-recover-blocked-task",
  name: "Recover Blocked Task (Worktree)",
  description:
    "Sub-workflow invoked once per blocked task by template-recover-blocked-worktrees. " +
    "Sweeps stale worktrees for the task, acquires a clean one, and unblocks the task " +
    "so it re-enters the normal task lifecycle. Works across all workspace repos — " +
    "repo context is sourced entirely from the task's own stored metadata.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.event",
  variables: {
    baseBranch: "main",
    defaultTargetBranch: "origin/main",
  },
  nodes: [
    node("trigger", "trigger.event", "Recovery Requested", {
      eventType: "task.blocked.recovery_requested",
    }, { x: 400, y: 50 }),

    node("check-context", "condition.expression", "Has Task Context?", {
      expression:
        "Boolean($data?.item?.taskId || $data?.taskId) && " +
        "Boolean($data?.item?.branch || $data?.item?.branchName || $data?.branch || $data?.branchName || $data?.item?.meta?.worktreeFailure?.branch || $data?.meta?.worktreeFailure?.branch) && " +
        "Boolean($data?.item?.repoRoot || $data?.item?.workspace || $data?.repoRoot || $data?.workspace || $data?.item?.meta?.worktreeFailure?.repoRoot || $data?.meta?.worktreeFailure?.repoRoot)",
    }, { x: 400, y: 190, outputs: ["yes", "no"] }),

    node("recover-wt", "action.recover_worktree", "Reset Broken Worktree", {
      taskId:       "{{$data?.item?.taskId || $data?.taskId || ''}}",
      branch:       "{{$data?.item?.branch || $data?.item?.branchName || $data?.branch || $data?.branchName || $data?.item?.meta?.worktreeFailure?.branch || $data?.meta?.worktreeFailure?.branch || ''}}",
      repoRoot:     "{{$data?.item?.repoRoot || $data?.item?.workspace || $data?.repoRoot || $data?.workspace || $data?.item?.meta?.worktreeFailure?.repoRoot || $data?.meta?.worktreeFailure?.repoRoot || ''}}",
      worktreePath: "{{$data?.item?.worktreePath || $data?.worktreePath || $data?.item?.meta?.worktreeFailure?.worktreePath || $data?.meta?.worktreeFailure?.worktreePath || ''}}",
    }, { x: 250, y: 340 }),

    node("acquire-wt", "action.acquire_worktree", "Acquire Clean Worktree", {
      taskId:               "{{$data?.item?.taskId || $data?.taskId || ''}}",
      branch:               "{{$data?.item?.branch || $data?.item?.branchName || $data?.branch || $data?.branchName || $data?.item?.meta?.worktreeFailure?.branch || $data?.meta?.worktreeFailure?.branch || ''}}",
      repoRoot:             "{{$data?.item?.repoRoot || $data?.item?.workspace || $data?.repoRoot || $data?.workspace || $data?.item?.meta?.worktreeFailure?.repoRoot || $data?.meta?.worktreeFailure?.repoRoot || ''}}",
      baseBranch:           "{{$data?.item?.baseBranch || $data?.baseBranch || $data?.item?.meta?.worktreeFailure?.baseBranch || $data?.meta?.worktreeFailure?.baseBranch || baseBranch}}",
      defaultTargetBranch:  "{{$data?.item?.defaultTargetBranch || $data?.defaultTargetBranch || $data?.item?.meta?.worktreeFailure?.defaultTargetBranch || $data?.meta?.worktreeFailure?.defaultTargetBranch || defaultTargetBranch}}",
    }, { x: 250, y: 490 }),

    node("check-acquired", "condition.expression", "Worktree Acquired?", {
      expression: "$ctx.getNodeOutput('acquire-wt')?.success === true",
    }, { x: 250, y: 640, outputs: ["yes", "no"] }),

    node("unblock-task", "action.update_task_status", "Unblock Task", {
      taskId:        "{{$data?.item?.taskId || $data?.taskId || ''}}",
      status:        "todo",
      taskTitle:     "{{$data?.item?.taskTitle || $data?.taskTitle || $data?.item?.taskId || $data?.taskId || ''}}",
      workflowEvent: "task.blocked.recovery_succeeded",
      workflowData: {
        stage:  "worktree_recovery",
        result: "recovered",
        branch: "{{$data?.item?.branch || $data?.item?.branchName || $data?.branch || $data?.branchName || $data?.item?.meta?.worktreeFailure?.branch || $data?.meta?.worktreeFailure?.branch || ''}}",
        worktreePath: "{{$ctx.getNodeOutput('acquire-wt')?.worktreePath || ''}}",
      },
    }, { x: 250, y: 790 }),

    node("clear-blocked-meta", "action.bosun_function", "Clear Blocked Metadata", {
      function: "tasks.update",
      args: {
        taskId: "{{$data?.item?.taskId || $data?.taskId || ''}}",
        metaDeleteKeys: ["autoRecovery", "worktreeFailure", "consecutiveRecoveryFailures", "blockedReason"],
        fields: {
          blockedReason: null,
        },
      },
    }, { x: 250, y: 940 }),

    node("log-success", "notify.log", "Log Recovery Success", {
      message:
        ":check: Worktree recovery succeeded for task " +
        "{{$data?.item?.taskId || $data?.taskId}} " +
        "({{$data?.item?.taskTitle || $data?.taskTitle || 'unknown'}}). " +
        "Task unblocked and returned to todo.",
      level: "info",
    }, { x: 250, y: 1090 }),

    node("log-no-context", "notify.log", "Log Missing Context", {
      message:
        "Blocked task recovery skipped — missing taskId or branch in dispatch payload. " +
        "Item: {{JSON.stringify($data?.item || {})}}",
      level: "warn",
    }, { x: 620, y: 340 }),

    node("log-acquire-failed", "notify.log", "Log Acquire Failure", {
      message:
        ":warning: Worktree recovery failed for task " +
        "{{$data?.item?.taskId || $data?.taskId}} — could not acquire a clean worktree. " +
        "Branch: {{$data?.item?.branch || $data?.branch || 'unknown'}}. Manual intervention may be required.",
      level: "warn",
    }, { x: 620, y: 790 }),
  ],
  edges: [
    edge("trigger", "check-context"),
    edge("check-context", "recover-wt",       { condition: "$output?.result === true",  port: "yes" }),
    edge("check-context", "log-no-context",   { condition: "$output?.result !== true",  port: "no" }),
    edge("recover-wt",    "acquire-wt"),
    edge("acquire-wt",    "check-acquired"),
    edge("check-acquired", "unblock-task",        { condition: "$output?.result === true",  port: "yes" }),
    edge("check-acquired", "log-acquire-failed",  { condition: "$output?.result !== true",  port: "no" }),
    edge("unblock-task",      "clear-blocked-meta"),
    edge("clear-blocked-meta", "log-success"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["recovery", "worktree", "blocked", "resilience", "sub-workflow"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Recover Blocked Worktree Tasks — orchestrator
//  Scheduled sweep that finds all blocked tasks and dispatches the sub-workflow
//  for each one. Completely repo-agnostic — no repoRoot template variable.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RECOVER_BLOCKED_WORKTREES_TEMPLATE = {
  id: "template-recover-blocked-worktrees",
  name: "Recover Blocked Worktree Tasks",
  description:
    "Scheduled operator-assist workflow that finds all tasks blocked due to worktree " +
    "failures, sweeps their stale worktrees, and re-queues each as todo. Works across " +
    "every repo in the workspace — repo context is read from each task's own metadata, " +
    "so no repo configuration is needed here.",
  category: "reliability",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    scheduleIntervalMs: 1800000,
    maxPerSweep: 20,
    maxConcurrent: 2,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Scheduled Worktree Recovery Sweep", {
      intervalMs: "{{scheduleIntervalMs}}",
      cron: "*/30 * * * *",
    }, { x: 400, y: 50 }),

    node("query-blocked", "action.run_command", "Query Blocked Tasks", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        let repoRoot = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        if (repoRoot.toLowerCase().includes(mirrorMarker)) {
          const r = path.resolve(repoRoot, "..", "..", "..", "..");
          if (fs.existsSync(path.join(r, "kanban", "kanban-adapter.mjs"))) repoRoot = r;
        }
        const kanbanUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        import(kanbanUrl)
          .then(k => k.listTasks(undefined, { status: "blocked" }))
          .then(tasks => {
            const limit = parseInt(process.env.MAX_PER_SWEEP || "20");
            const blocked = (tasks || [])
              .map(t => {
                const meta = t && typeof t.meta === "object" ? t.meta : {};
                const worktreeFailure = meta && typeof meta.worktreeFailure === "object" ? meta.worktreeFailure : {};
                const branch = t?.branch || t?.branchName || t?.metadata?.branch || meta?.branch || worktreeFailure?.branch || null;
                const repoRoot = t?.repoRoot || t?.workspace || t?.metadata?.repoRoot || t?.metadata?.workspace || meta?.repoRoot || meta?.workspace || worktreeFailure?.repoRoot || null;
                const worktreePath = t?.worktreePath || t?.metadata?.worktreePath || meta?.worktreePath || worktreeFailure?.worktreePath || null;
                const baseBranch = t?.baseBranch || t?.metadata?.baseBranch || meta?.baseBranch || worktreeFailure?.baseBranch || null;
                const defaultTargetBranch = t?.defaultTargetBranch || t?.metadata?.defaultTargetBranch || meta?.defaultTargetBranch || worktreeFailure?.defaultTargetBranch || null;
                const minimalMeta = {};
                if (worktreeFailure && typeof worktreeFailure === "object") {
                  minimalMeta.worktreeFailure = {
                    branch: worktreeFailure?.branch || branch || null,
                    repoRoot: worktreeFailure?.repoRoot || repoRoot || null,
                    worktreePath: worktreeFailure?.worktreePath || worktreePath || null,
                    baseBranch: worktreeFailure?.baseBranch || baseBranch || null,
                    defaultTargetBranch: worktreeFailure?.defaultTargetBranch || defaultTargetBranch || null,
                  };
                }
                if (typeof meta?.blockedReason === "string" && meta.blockedReason.trim()) {
                  minimalMeta.blockedReason = meta.blockedReason.trim();
                }
                if (meta?.autoRecovery && typeof meta.autoRecovery === "object") {
                  minimalMeta.autoRecovery = {
                    active: meta.autoRecovery.active === true,
                    recoveredAt: meta.autoRecovery.recoveredAt || null,
                    recoveredStatus: meta.autoRecovery.recoveredStatus || null,
                  };
                }
                return {
                  taskId:       t?.id,
                  taskTitle:    t?.title || t?.id,
                  branch,
                  repoRoot,
                  worktreePath,
                  repository:   t?.repository || t?.metadata?.repository || meta?.repository || null,
                  baseBranch,
                  defaultTargetBranch,
                  meta: minimalMeta,
                };
              })
              .filter(t => t && t.taskId && t.branch && t.repoRoot)
              .slice(0, limit)
              ;
            console.log(JSON.stringify(blocked));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_PER_SWEEP: "{{maxPerSweep}}" },
      parseJson: true,
    }, { x: 400, y: 190 }),

    node("count-blocked", "action.set_variable", "Count Blocked Tasks", {
      key: "blockedTaskCount",
      value: "$ctx.getNodeOutput('query-blocked')?.output?.length || 0",
      isExpression: true,
    }, { x: 250, y: 280 }),

    node("check-has-tasks", "condition.expression", "Any Blocked Tasks?", {
      expression: "Array.isArray($ctx.getNodeOutput('query-blocked')?.output) && $ctx.getNodeOutput('query-blocked').output.length > 0",
    }, { x: 400, y: 360, outputs: ["yes", "no"] }),

    node("recover-each", "loop.for_each", "Recover Each Blocked Task", {
      items:         "$ctx.getNodeOutput('query-blocked')?.output || []",
      variable:      "item",
      indexVariable: "recoveryIndex",
      maxConcurrent: "{{maxConcurrent}}",
      workflowId:    "template-recover-blocked-task",
      mode:          "dispatch",
    }, { x: 400, y: 510 }),

    node("prune-worktrees", "action.run_command", "Prune Stale Worktree Refs", {
      command: "git",
      args: ["worktree", "prune", "--verbose"],
      continueOnError: true,
    }, { x: 400, y: 650 }),

    node("log-summary", "notify.log", "Log Recovery Summary", {
      message:
        ":broom: Blocked worktree recovery sweep dispatched for " +
        "{{blockedTaskCount}} task(s). " +
        "maxConcurrent={{maxConcurrent}} maxPerSweep={{maxPerSweep}}",
      level: "info",
    }, { x: 250, y: 790 }),

    node("log-idle", "notify.log", "Log No Blocked Tasks", {
      message: "Blocked worktree recovery sweep: no blocked tasks with branch context found.",
      level: "debug",
    }, { x: 620, y: 510 }),
  ],
  edges: [
    edge("trigger",         "query-blocked"),
    edge("query-blocked",   "count-blocked"),
    edge("count-blocked",   "check-has-tasks"),
    edge("check-has-tasks", "recover-each",  { condition: "$output?.result === true",  port: "yes" }),
    edge("check-has-tasks", "log-idle",      { condition: "$output?.result !== true",  port: "no" }),
    edge("recover-each",    "prune-worktrees"),
    edge("prune-worktrees", "log-summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-06-01T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["recovery", "worktree", "blocked", "resilience", "automation", "scheduled"],
    requiredTemplates: ["template-recover-blocked-task"],
  },
};
