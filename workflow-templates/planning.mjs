/**
 * planning.mjs — Planning & reporting workflow templates.
 *
 * Templates:
 *   - Task Planner (recommended)
 *   - Task Replenish (Scheduled)
 *   - Nightly Report
 *   - Sprint Retrospective
 *   - Weekly Fitness Summary
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Task Planner (auto-replenish backlog)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_PLANNER_TEMPLATE = {
  id: "template-task-planner",
  name: "Task Planner",
  description:
    "Automatically generates new backlog tasks when the todo count drops " +
    "below a configurable threshold. Replaces the previous hardcoded " +
    "TASK_PLANNER_MODE / REPLENISH_ENABLED env-var system.",
  category: "planning",
  enabled: true,
  recommended: true,
  trigger: "trigger.task_low",
  variables: {
    minTodoCount: 3,
    taskCount: 5,
    dedupHours: 24,
    failureCooldownMinutes: 30,
    prompt: "",
    plannerContext:
      "Focus on high-value implementation work. Avoid duplicating existing tasks.",
  },
  nodes: [
    node("trigger", "trigger.task_low", "Backlog Low?", {
      threshold: "{{minTodoCount}}",
      status: "todo",
    }, { x: 400, y: 50 }),

    node("check-dedup", "condition.expression", "Dedup Window", {
      expression:
        "(() => {" +
        " const now = Date.now();" +
        " const lastSuccessAt = Number($data?._lastPlannerRun || 0);" +
        " const lastFailureAt = Number($data?._lastPlannerFailureAt || 0);" +
        " const successWindowMs = Number($data?.dedupHours || 24) * 3600000;" +
        " const failureWindowMs = Number($data?.failureCooldownMinutes || 30) * 60000;" +
        " return (now - lastSuccessAt) > successWindowMs && (now - lastFailureAt) > failureWindowMs;" +
        "})()",
    }, { x: 400, y: 180 }),

    node("log-start", "notify.log", "Log Planner Start", {
      message: "Task planner triggered: {{trigger.todoCount}} tasks remaining (threshold: {{minTodoCount}})",
      level: "info",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: "{{taskCount}}",
      context: "{{plannerContext}}",
      prompt: "{{prompt}}",
      repoMapQuery: "{{plannerContext}} {{prompt}}",
      repoMapFileLimit: 8,
      dedup: true,
      timeoutMs: 960000,
      agentTimeoutMs: 900000,
      maxRetries: 0,
      retryable: false,
    }, { x: 400, y: 440 }),

    node("materialize-tasks", "action.materialize_planner_tasks", "Create Tasks", {
      plannerNodeId: "run-planner",
      maxTasks: "{{taskCount}}",
      status: "todo",
      dedup: true,
      failOnZero: true,
      minCreated: 1,
    }, { x: 400, y: 570 }),

    node("check-result", "condition.expression", "Planner Succeeded?", {
      expression: "$ctx.getNodeOutput('materialize-tasks')?.success === true && ($ctx.getNodeOutput('materialize-tasks')?.createdCount || 0) > 0",
    }, { x: 400, y: 700 }),

    node("set-timestamp", "action.set_variable", "Update Last Run", {
      key: "_lastPlannerRun",
      value: "Date.now()",
      isExpression: true,
    }, { x: 200, y: 830 }),

    node("notify-done", "notify.telegram", "Notify Tasks Created", {
      message: ":folder: Task planner created {{materialize-tasks.createdCount}} backlog tasks (skipped {{materialize-tasks.skippedCount}} duplicates).",
      silent: true,
    }, { x: 200, y: 960 }),

    node("notify-skip", "notify.log", "Log Dedup Skip", {
      message: "Task planner skipped: within dedup window",
      level: "info",
    }, { x: 650, y: 180 }),

    node("notify-fail", "notify.log", "Log Planner Failure", {
      message: "Task planner failed to materialize tasks from planner output",
      level: "warn",
    }, { x: 600, y: 830 }),

    // Cooldown on failure: stamp _lastPlannerRun so the dedup window
    // prevents immediate retry without blocking normal planning for a full day.
    node("set-timestamp-fail", "action.set_variable", "Cooldown After Failure", {
      key: "_lastPlannerFailureAt",
      value: "Date.now()",
      isExpression: true,
    }, { x: 600, y: 960 }),
  ],
  edges: [
    edge("trigger", "check-dedup"),
    edge("check-dedup", "log-start", { condition: "$output?.result === true" }),
    edge("check-dedup", "notify-skip", { condition: "$output?.result !== true" }),
    edge("log-start", "run-planner"),
    edge("run-planner", "materialize-tasks"),
    edge("materialize-tasks", "check-result"),
    edge("check-result", "set-timestamp", { condition: "$output?.result === true" }),
    edge("check-result", "notify-fail", { condition: "$output?.result !== true" }),
    edge("set-timestamp", "notify-done"),
    edge("notify-fail", "set-timestamp-fail"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planner", "backlog", "automation"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the hardcoded task planner status loop. " +
        "Task counting, gap analysis, and replenishment are visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Replenish (periodic/schedule-based)
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_REPLENISH_TEMPLATE = {
  id: "template-task-replenish",
  name: "Task Replenish (Scheduled)",
  description:
    "Periodically checks backlog and replenishes tasks on a schedule. " +
    "This replaces the previous INTERNAL_EXECUTOR_REPLENISH_ENABLED env var " +
    "with a configurable visual workflow.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 3600000,
    minTodoCount: 5,
    taskCount: 8,
    prompt: "",
    plannerContext:
      "Scheduled replenishment run. Prioritize implementation tasks that build on recent PRs.",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Check", {
      intervalMs: "{{intervalMs}}",
    }, { x: 400, y: 50 }),

    node("check-backlog", "trigger.task_low", "Check Backlog Level", {
      threshold: "{{minTodoCount}}",
    }, { x: 400, y: 180 }),

    node("needs-tasks", "condition.expression", "Needs Replenishment?", {
      expression: "$ctx.getNodeOutput('check-backlog')?.triggered === true",
    }, { x: 400, y: 310 }),

    node("run-planner", "agent.run_planner", "Generate Tasks", {
      taskCount: "{{taskCount}}",
      context: "{{plannerContext}}",
      prompt: "{{prompt}}",
      repoMapQuery: "{{plannerContext}} {{prompt}}",
      repoMapFileLimit: 8,
      timeoutMs: 960000,
      agentTimeoutMs: 900000,
      maxRetries: 0,
      retryable: false,
    }, { x: 400, y: 440 }),

    node("materialize-tasks", "action.materialize_planner_tasks", "Create Tasks", {
      plannerNodeId: "run-planner",
      maxTasks: "{{taskCount}}",
      status: "todo",
      dedup: true,
      failOnZero: true,
      minCreated: 1,
    }, { x: 400, y: 570 }),

    node("notify", "notify.telegram", "Notify", {
      message: ":refresh: Scheduled replenishment created {{materialize-tasks.createdCount}} tasks (skipped {{materialize-tasks.skippedCount}}).",
      silent: true,
    }, { x: 400, y: 700 }),

    node("skip-log", "notify.log", "No Replenish Needed", {
      message: "Scheduled replenishment check: backlog sufficient, skipping",
    }, { x: 700, y: 310 }),
  ],
  edges: [
    edge("trigger", "check-backlog"),
    edge("check-backlog", "needs-tasks"),
    edge("needs-tasks", "run-planner", { condition: "$output?.result === true" }),
    edge("needs-tasks", "skip-log", { condition: "$output?.result !== true" }),
    edge("run-planner", "materialize-tasks"),
    edge("materialize-tasks", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["replenish", "schedule", "backlog"],
    replaces: {
      module: "monitor.mjs",
      functions: ["startTaskPlannerStatusLoop (scheduled variant)"],
      calledFrom: ["monitor.mjs:startProcess"],
      description: "Replaces the cron-based task replenishment loop in monitor. " +
        "Backlog scanning and planner execution become visual workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Nightly Report
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const NIGHTLY_REPORT_TEMPLATE = {
  id: "template-nightly-report",
  name: "Nightly Report",
  description:
    "Generates a daily summary of agent activity: tasks completed, " +
    "PRs merged, errors encountered, and token usage. Sends to Telegram.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    reportHour: 23,
    reportTimezone: "UTC",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Nightly at 11pm", {
      intervalMs: 86400000,
      cron: "0 {{reportHour}} * * *",
    }, { x: 400, y: 50 }),

    node("get-task-stats", "action.run_command", "Get Task Stats", {
      command: "bosun task stats --json",
      continueOnError: true,
    }, { x: 150, y: 200 }),

    node("get-pr-stats", "action.run_command", "Get PR Stats", {
      command: "gh pr list --state all --json number,state,mergedAt --limit 50",
      continueOnError: true,
    }, { x: 400, y: 200 }),

    node("get-agent-stats", "action.run_command", "Get Agent Stats", {
      command: "bosun agent stats --json 2>/dev/null || echo '{}'",
      continueOnError: true,
    }, { x: 650, y: 200 }),

    node("generate-report", "action.run_agent", "Generate Report", {
      prompt: `Generate a concise daily activity report from the following data.

## Task Stats
{{taskStats}}

## PR Activity
{{prStats}}

## Agent Activity
{{agentStats}}

Format as a Telegram-friendly message with emoji headers. Include:
- Tasks completed today vs yesterday
- PRs merged / opened / closed
- Agent success rate
- Notable errors or anomalies
- Recommendations for tomorrow`,
      timeoutMs: 300000,
    }, { x: 400, y: 380 }),

    node("send-report", "notify.telegram", "Send Report", {
      message: ":chart: **Daily Bosun Report** ({{reportTimezone}})\n\n{{reportOutput}}",
    }, { x: 400, y: 540 }),
  ],
  edges: [
    edge("trigger", "get-task-stats"),
    edge("trigger", "get-pr-stats"),
    edge("trigger", "get-agent-stats"),
    edge("get-task-stats", "generate-report"),
    edge("get-pr-stats", "generate-report"),
    edge("get-agent-stats", "generate-report"),
    edge("generate-report", "send-report"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["report", "daily", "telegram", "analytics"],
    replaces: {
      module: "telegram-sentinel.mjs",
      functions: ["dailyDigest", "sendStatusReport"],
      calledFrom: ["monitor.mjs:startSentinelBridge"],
      description: "Replaces ad-hoc Telegram status reporting with a scheduled " +
        "nightly report workflow. Stats gathering runs in parallel, then " +
        "an agent generates a formatted summary.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Sprint Retrospective
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SPRINT_RETROSPECTIVE_TEMPLATE = {
  id: "template-sprint-retrospective",
  name: "Sprint Retrospective",
  description:
    "Weekly automated retrospective: gathers metrics on tasks completed, " +
    "PRs merged, agent success rates, and common failure patterns. " +
    "Generates improvement suggestions and creates action item tasks.",
  category: "planning",
  enabled: true,
  trigger: "trigger.schedule",
  variables: {
    lookbackDays: 7,
    lookbackWindowMs: 604800000,
    createImprovementTasks: true,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Weekly Retro", {
      intervalMs: 604800000,
      cron: "0 9 * * 1",
    }, { x: 400, y: 50 }),

    node("task-metrics", "action.bosun_cli", "Gather Task Metrics", {
      command: "task list --format json --since {{lookbackDays}}d",
      continueOnError: true,
    }, { x: 200, y: 200 }),

    node("pr-metrics", "action.run_command", "Gather PR Metrics", {
      command: "gh pr list --state all --json number,title,state,createdAt,mergedAt,closedAt --limit 50",
      continueOnError: true,
    }, { x: 600, y: 200 }),

    node("error-analysis", "action.analyze_errors", "Analyze Error Patterns", {
      timeWindowMs: "{{lookbackWindowMs}}",
      groupBy: "category",
    }, { x: 200, y: 350 }),

    node("agent-stats", "action.bosun_cli", "Agent Performance", {
      command: "status --json",
      continueOnError: true,
    }, { x: 600, y: 350 }),

    node("generate-retro", "action.run_agent", "Generate Retrospective", {
      prompt: `# Sprint Retrospective Analysis

Analyze the following data from the past {{lookbackDays}} days:

## Task Metrics
{{taskMetrics}}

## PR Metrics
{{prMetrics}}

## Error Patterns
{{errorAnalysis}}

## Agent Performance
{{agentStats}}

Generate a retrospective report with these sections:

### :chart: Key Metrics
- Tasks completed vs created
- Average task cycle time
- PR merge rate and average review time
- Agent success rate

### :check: What Went Well
- Highlight successful patterns and wins

### :close: What Didn't Go Well
- Identify bottlenecks and recurring issues

### :target: Action Items
For each improvement suggestion, output a line:
ACTION: [title] | [description]

Be specific and actionable. Limit to 3-5 improvement items.`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 400, y: 520 }),

    node("has-actions", "condition.expression", "Has Action Items?", {
      expression: "($ctx.getNodeOutput('generate-retro')?.output || '').includes('ACTION:')",
    }, { x: 400, y: 680, outputs: ["yes", "no"] }),

    node("create-tasks", "action.run_agent", "Create Improvement Tasks", {
      prompt: `# Create Improvement Tasks

From the retrospective output, extract all lines starting with ACTION:
and create a bosun task for each one.

Use the CLI: bosun task create --title "[title]" --description "[description]" --tag improvement --tag retro

Only create tasks if {{createImprovementTasks}} is true.`,
      sdk: "auto",
      timeoutMs: 300000,
    }, { x: 250, y: 830 }),

    node("send-report", "notify.telegram", "Send Retro Report", {
      message: ":clipboard: **Weekly Retrospective** (past {{lookbackDays}} days)\n\n{{retroOutput}}",
    }, { x: 400, y: 980 }),

    node("log-no-actions", "notify.log", "No Actions Needed", {
      message: "Sprint retrospective complete — no action items generated",
      level: "info",
    }, { x: 600, y: 830 }),
  ],
  edges: [
    edge("trigger", "task-metrics"),
    edge("trigger", "pr-metrics"),
    edge("task-metrics", "error-analysis"),
    edge("pr-metrics", "agent-stats"),
    edge("error-analysis", "generate-retro"),
    edge("agent-stats", "generate-retro"),
    edge("generate-retro", "has-actions"),
    edge("has-actions", "create-tasks", { condition: "$output?.result === true", port: "yes" }),
    edge("has-actions", "log-no-actions", { condition: "$output?.result !== true", port: "no" }),
    edge("create-tasks", "send-report"),
    edge("log-no-actions", "send-report"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planning", "retrospective", "metrics", "improvement", "weekly"],
    replaces: {
      module: "telegram-sentinel.mjs",
      functions: ["weeklyDigest"],
      calledFrom: ["monitor.mjs:scheduleWeeklyDigest"],
      description:
        "Replaces simple weekly digest with a comprehensive retrospective " +
        "workflow. Metrics gathering, AI analysis, action item creation, " +
        "and reporting are structured as workflow stages.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Weekly Fitness Summary
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const WEEKLY_FITNESS_SUMMARY_TEMPLATE = {
  id: "template-weekly-fitness-summary",
  name: "Weekly Fitness Summary",
  description:
    "Weekly evaluator workflow that scores delivery fitness using throughput, " +
    "regression rate, merge success, reopened tasks, and debt growth. " +
    "Produces follow-up actions and can materialize them as backlog tasks.",
  category: "planning",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    scheduleCron: "0 9 * * 1",
    lookbackDays: 7,
    evaluatorFocus:
      "Bias toward systemic fixes that reduce regressions and execution thrash.",
    createFollowupTasks: true,
    maxFollowupTasks: 4,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Weekly Schedule", {
      intervalMs: 604800000,
      cron: "{{scheduleCron}}",
    }, { x: 420, y: 40 }),

    node("task-metrics", "action.bosun_cli", "Collect Task Metrics", {
      subcommand: "task list",
      args: "--json",
      parseJson: true,
      continueOnError: true,
    }, { x: 150, y: 180 }),

    node("pr-metrics", "action.run_command", "Collect PR Metrics", {
      command: "gh pr list --state all --json number,state,mergedAt,closedAt,createdAt,updatedAt,title,body --limit 200",
      continueOnError: true,
    }, { x: 420, y: 180 }),

    node("debt-metrics", "action.run_command", "Collect Debt Signals", {
      command: "node -e \"const fs=require('fs');const p='.bosun/workflow-runs/task-debt-ledger.jsonl';if(!fs.existsSync(p)){console.log('[]');process.exit(0);}const lines=fs.readFileSync(p,'utf8').split(/\\r?\\n/).filter(Boolean);console.log(JSON.stringify(lines.slice(-500).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean)));\"",
      continueOnError: true,
    }, { x: 690, y: 180 }),

    node("read-previous-summary", "action.read_file", "Read Prior Summary", {
      path: ".bosun/workflow-runs/weekly-fitness-summary.latest.json",
    }, { x: 960, y: 180 }),

    node("summarize-fitness-metrics", "action.set_variable", "Summarize Fitness Metrics", {
      key: "fitnessSummary",
      value:
        "(() => {" +
        "  try {" +
        "    const now = Date.now();" +
        "    const lookbackDays = Math.max(1, Number($data?.lookbackDays || 7));" +
        "    const windowMs = lookbackDays * 24 * 60 * 60 * 1000;" +
        "    const currentStart = now - windowMs;" +
        "    const previousStart = currentStart - windowMs;" +
        "    const previousEnd = currentStart;" +
        "    const toNumber = (v, fallback = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };" +
        "    const toIso = (ms) => new Date(ms).toISOString();" +
        "    const parseJsonSafe = (raw) => { try { return JSON.parse(String(raw)); } catch { return null; } };" +
        "    const extractCanonicalItems = (value) => {" +
        "      if (!value || typeof value !== 'object') return null;" +
        "      const keys = ['items', 'tasks', 'entries', 'records', 'results', 'data'];" +
        "      for (const key of keys) {" +
        "        if (Array.isArray(value[key])) return value[key].filter(Boolean);" +
        "      }" +
        "      return null;" +
        "    };" +
        "    const parseSource = (raw, depth = 0) => {" +
        "      if (depth > 3) return { items: [], degraded: true, parsedAny: false, partial: false };" +
        "      if (Array.isArray(raw)) return { items: raw.filter(Boolean), degraded: false, parsedAny: raw.length > 0, partial: false };" +
        "      if (raw && typeof raw === 'object') {" +
        "        const canonical = extractCanonicalItems(raw) ?? extractCanonicalItems(raw.output) ?? extractCanonicalItems(raw.result) ?? extractCanonicalItems(raw.payload);" +
        "        if (canonical) return { items: canonical, degraded: false, parsedAny: canonical.length > 0, partial: false };" +
        "        const wrappedCandidates = [raw.output, raw.result, raw.payload, raw.data, raw.stdout, raw.content, raw.text, raw.json];" +
        "        for (const candidate of wrappedCandidates) {" +
        "          if (candidate == null) continue;" +
        "          const parsedCandidate = parseSource(candidate, depth + 1);" +
        "          if (parsedCandidate.items.length > 0 || parsedCandidate.parsedAny || parsedCandidate.degraded === false) return parsedCandidate;" +
        "        }" +
        "        return { items: [], degraded: Object.keys(raw).length > 0, parsedAny: false, partial: false };" +
        "      }" +
        "      if (typeof raw !== 'string') return { items: [], degraded: true, parsedAny: false, partial: false };" +
        "      const trimmed = raw.trim();" +
        "      if (!trimmed) return { items: [], degraded: false, parsedAny: false, partial: false };" +
        "      const parsed = parseJsonSafe(trimmed);" +
        "      if (Array.isArray(parsed)) return { items: parsed.filter(Boolean), degraded: false, parsedAny: true, partial: false };" +
        "      if (parsed && typeof parsed === 'object') {" +
        "        const canonical = extractCanonicalItems(parsed) ?? extractCanonicalItems(parsed.output) ?? extractCanonicalItems(parsed.result) ?? extractCanonicalItems(parsed.payload);" +
        "        if (canonical) return { items: canonical, degraded: false, parsedAny: true, partial: false };" +
        "      }" +
        "      const lines = trimmed.split(/\\r?\\n/).filter((line) => line.trim() !== '');" +
        "      const parsedLines = [];" +
        "      let failedLines = 0;" +
        "      for (const line of lines) {" +
        "        const parsedLine = parseJsonSafe(line);" +
        "        if (parsedLine == null) { failedLines += 1; continue; }" +
        "        if (Array.isArray(parsedLine)) parsedLines.push(...parsedLine.filter(Boolean));" +
        "        else parsedLines.push(parsedLine);" +
        "      }" +
        "      if (parsedLines.length > 0) return { items: parsedLines, degraded: failedLines > 0, parsedAny: true, partial: failedLines > 0 };" +
        "      return { items: [], degraded: true, parsedAny: false, partial: false };" +
        "    };" +
        "    const getTs = (item) => {" +
        "      if (!item || typeof item !== 'object') return null;" +
        "      const fields = ['completedAt', 'closedAt', 'mergedAt', 'resolvedAt', 'updatedAt', 'createdAt', 'timestamp', 'ts', 'date', 'completed_at', 'closed_at', 'merged_at', 'resolved_at', 'updated_at', 'created_at'];" +
        "      for (const key of fields) {" +
        "        const value = item[key];" +
        "        if (!value) continue;" +
        "        const ms = Date.parse(String(value));" +
        "        if (Number.isFinite(ms)) return ms;" +
        "        if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;" +
        "      }" +
        "      return null;" +
        "    };" +
        "    const normalizeBucket = (items) => {" +
        "      const stamped = [];" +
        "      const unstamped = [];" +
        "      for (const item of items) {" +
        "        const ts = getTs(item);" +
        "        if (ts == null) unstamped.push(item); else stamped.push({ item, ts });" +
        "      }" +
        "      return { stamped, unstamped };" +
        "    };" +
        "    const splitWindows = (items) => {" +
        "      const { stamped, unstamped } = normalizeBucket(items);" +
        "      const current = stamped.filter((entry) => entry.ts >= currentStart && entry.ts <= now).map((entry) => entry.item);" +
        "      const previous = stamped.filter((entry) => entry.ts >= previousStart && entry.ts < previousEnd).map((entry) => entry.item);" +
        "      const usedFallbackWindow = stamped.length === 0 && unstamped.length > 0;" +
        "      if (usedFallbackWindow) return { current: unstamped, previous: [], usedFallbackWindow };" +
        "      return { current, previous, usedFallbackWindow };" +
        "    };" +
        "    const metric = (name, value, previous, direction, unit, confidence, status, notes = []) => {" +
        "      const hasCurrent = typeof value === 'number' && Number.isFinite(value);" +
        "      const hasPrevious = typeof previous === 'number' && Number.isFinite(previous);" +
        "      return {" +
        "        name," +
        "        value: hasCurrent ? value : null," +
        "        previous: hasPrevious ? previous : null," +
        "        delta: hasCurrent && hasPrevious ? Number((value - previous).toFixed(2)) : null," +
        "        direction," +
        "        unit," +
        "        confidence," +
        "        status," +
        "        notes: notes.filter(Boolean)," +
        "      };" +
        "    };" +
        "    const sourceStatus = (nodeOut, parsedList, parsedMeta = {}) => {" +
        "      const output = nodeOut?.output;" +
        "      const hasPayload = (() => {" +
        "        if (output == null) return false;" +
        "        if (Array.isArray(output)) return true;" +
        "        if (typeof output === 'string') return output.trim() !== '';" +
        "        if (typeof output === 'object') {" +
        "          const wrapped = [output.stdout, output.content, output.text, output.json, output.output, output.result, output.payload, output.data];" +
        "          if (wrapped.some((v) => (typeof v === 'string' ? v.trim() !== '' : v != null))) return true;" +
        "          return Object.keys(output).length > 0;" +
        "        }" +
        "        return true;" +
        "      })();" +
        "      const success = nodeOut?.success !== false;" +
        "      if (!hasPayload) return { status: 'missing', confidence: 'low' };" +
        "      if (!Array.isArray(parsedList)) return { status: 'degraded', confidence: 'low' };" +
        "      if (parsedMeta?.degraded || parsedMeta?.partial) return { status: 'degraded', confidence: parsedList.length > 0 ? 'medium' : 'low' };" +
        "      if (!success) return { status: 'degraded', confidence: parsedList.length > 0 ? 'medium' : 'low' };" +
        "      return { status: 'ok', confidence: parsedList.length > 0 ? 'high' : 'medium' };" +
        "    };" +
        "    const taskNode = $ctx.getNodeOutput('task-metrics') || {};" +
        "    const prNode = $ctx.getNodeOutput('pr-metrics') || {};" +
        "    const debtNode = $ctx.getNodeOutput('debt-metrics') || {};" +
        "    const prevNode = $ctx.getNodeOutput('read-previous-summary') || {};" +
        "    const taskParsed = parseSource(taskNode.output);" +
        "    const prParsed = parseSource(prNode.output);" +
        "    const debtParsed = parseSource(debtNode.output);" +
        "    const tasks = taskParsed.items;" +
        "    const prs = prParsed.items;" +
        "    const debt = debtParsed.items;" +
        "    const taskHealth = sourceStatus(taskNode, tasks, taskParsed);" +
        "    const prHealth = sourceStatus(prNode, prs, prParsed);" +
        "    const debtHealth = sourceStatus(debtNode, debt, debtParsed);" +
        "    const taskSplit = splitWindows(tasks);" +
        "    const prSplit = splitWindows(prs);" +
        "    const debtSplit = splitWindows(debt);" +
        "    const doneStatuses = new Set(['done', 'closed', 'completed', 'merged', 'resolved']);" +
        "    const isDone = (item) => doneStatuses.has(String(item?.status ?? item?.state ?? '').toLowerCase());" +
        "    const taskTelemetryUnavailable = taskHealth.status === 'missing' || (taskHealth.status === 'degraded' && tasks.length === 0);" +
        "    const throughputCurrent = taskTelemetryUnavailable ? null : taskSplit.current.filter(isDone).length;" +
        "    const throughputPrevious = taskTelemetryUnavailable ? null : taskSplit.previous.filter(isDone).length;" +
        "    const reopenedCount = (items) => items.filter((item) => {" +
        "      if (!item || typeof item !== 'object') return false;" +
        "      const reopenCount = toNumber(item.reopenCount ?? item.reopenedCount ?? item.reopen_count ?? item.reopened_count, 0);" +
        "      if (reopenCount > 0) return true;" +
        "      if (item.reopened === true) return true;" +
        "      const status = String(item.status ?? item.state ?? '').toLowerCase();" +
        "      return status.includes('reopen');" +
        "    }).length;" +
        "    const reopenedCurrent = taskTelemetryUnavailable ? null : reopenedCount(taskSplit.current);" +
        "    const reopenedPrevious = taskTelemetryUnavailable ? null : reopenedCount(taskSplit.previous);" +
        "    const classifyRegression = (pr) => /revert|regression|rollback|hotfix/i.test(String(pr?.title || '') + ' ' + String(pr?.body || ''));" +
        "    const regressionCurrentCount = prSplit.current.filter(classifyRegression).length;" +
        "    const regressionPreviousCount = prSplit.previous.filter(classifyRegression).length;" +
        "    const regressionCurrentRate = prSplit.current.length > 0 ? Number(((regressionCurrentCount / prSplit.current.length) * 100).toFixed(2)) : null;" +
        "    const regressionPreviousRate = prSplit.previous.length > 0 ? Number(((regressionPreviousCount / prSplit.previous.length) * 100).toFixed(2)) : null;" +
        "    const mergedCount = (items) => items.filter((pr) => String(pr?.state || '').toLowerCase() === 'merged' || Boolean(pr?.mergedAt) || Boolean(pr?.merged_at) || pr?.merged === true).length;" +
        "    const closedCount = (items) => items.filter((pr) => {" +
        "      const state = String(pr?.state || '').toLowerCase();" +
        "      return state === 'closed' || state === 'merged' || Boolean(pr?.closedAt) || Boolean(pr?.closed_at) || Boolean(pr?.mergedAt) || Boolean(pr?.merged_at);" +
        "    }).length;" +
        "    const mergeClosedCurrent = closedCount(prSplit.current);" +
        "    const mergeClosedPrevious = closedCount(prSplit.previous);" +
        "    const mergeSuccessCurrent = mergeClosedCurrent > 0 ? Number(((mergedCount(prSplit.current) / mergeClosedCurrent) * 100).toFixed(2)) : null;" +
        "    const mergeSuccessPrevious = mergeClosedPrevious > 0 ? Number(((mergedCount(prSplit.previous) / mergeClosedPrevious) * 100).toFixed(2)) : null;" +
        "    const debtDelta = (entries) => {" +
        "      let total = 0;" +
        "      for (const entry of entries) {" +
        "        if (entry == null) continue;" +
        "        if (typeof entry === 'number') { total += entry; continue; }" +
        "        if (typeof entry !== 'object') continue;" +
        "        if (Number.isFinite(Number(entry.debtDelta))) { total += Number(entry.debtDelta); continue; }" +
        "        if (Number.isFinite(Number(entry.delta))) { total += Number(entry.delta); continue; }" +
        "        if (Number.isFinite(Number(entry.netChange))) { total += Number(entry.netChange); continue; }" +
        "        const amt = Number.isFinite(Number(entry.amount)) ? Number(entry.amount) : 1;" +
        "        const kind = String(entry.type || entry.event || entry.action || '').toLowerCase();" +
        "        if (/resolved|burn|paydown|decrease|closed/.test(kind)) total -= amt;" +
        "        else if (/created|added|increase|opened|new/.test(kind)) total += amt;" +
        "      }" +
        "      return Number(total.toFixed(2));" +
        "    };" +
        "    const debtCurrent = debtSplit.current.length > 0 ? debtDelta(debtSplit.current) : null;" +
        "    const debtPrevious = debtSplit.previous.length > 0 ? debtDelta(debtSplit.previous) : null;" +
        "    const priorRaw = prevNode?.success === true ? (parseSource(prevNode.content).items?.[0] ?? parseJsonSafe(prevNode.content)) : null;" +
        "    const priorParsed = priorRaw?.fitnessSummary && typeof priorRaw.fitnessSummary === 'object' ? priorRaw.fitnessSummary : (priorRaw && typeof priorRaw === 'object' ? priorRaw : null);" +
        "    const metricConfidence = (primaryHealth, hasValue, usedFallbackWindow) => {" +
        "      if (!hasValue) return 'low';" +
        "      if (primaryHealth.status === 'missing') return 'low';" +
        "      if (primaryHealth.status === 'degraded') return 'low';" +
        "      if (usedFallbackWindow) return 'medium';" +
        "      return primaryHealth.confidence || 'medium';" +
        "    };" +
        "    const throughputMetric = metric('throughput', throughputCurrent, throughputPrevious, 'up_is_good', 'tasks', metricConfidence(taskHealth, throughputCurrent != null, taskSplit.usedFallbackWindow), taskHealth.status, [throughputCurrent == null ? 'Task telemetry unavailable for this window.' : '', taskSplit.usedFallbackWindow ? 'No task timestamps detected; treated all records as current week.' : '']);" +
        "    const regressionMetric = metric('regression_rate', regressionCurrentRate, regressionPreviousRate, 'down_is_good', 'percent', metricConfidence(prHealth, regressionCurrentRate != null, prSplit.usedFallbackWindow), prHealth.status, [regressionCurrentRate == null ? 'Insufficient PR sample to compute regression rate.' : '', prSplit.usedFallbackWindow ? 'No PR timestamps detected; treated all records as current week.' : '']);" +
        "    const mergeMetric = metric('merge_success', mergeSuccessCurrent, mergeSuccessPrevious, 'up_is_good', 'percent', metricConfidence(prHealth, mergeSuccessCurrent != null, prSplit.usedFallbackWindow), prHealth.status, [mergeSuccessCurrent == null ? 'No closed or merged PRs in scope.' : '', prSplit.usedFallbackWindow ? 'No PR timestamps detected; treated all records as current week.' : '']);" +
        "    const reopenedMetric = metric('reopened_tasks', reopenedCurrent, reopenedPrevious, 'down_is_good', 'tasks', metricConfidence(taskHealth, reopenedCurrent != null, taskSplit.usedFallbackWindow), taskHealth.status, [reopenedCurrent == null ? 'Task telemetry unavailable for this window.' : '', taskSplit.usedFallbackWindow ? 'No task timestamps detected; treated all records as current week.' : '']);" +
        "    const debtMetric = metric('debt_growth', debtCurrent, debtPrevious, 'down_is_good', 'points', metricConfidence(debtHealth, debtCurrent != null, debtSplit.usedFallbackWindow), debtHealth.status, [debtCurrent == null ? 'No debt ledger events in scope.' : '', debtSplit.usedFallbackWindow ? 'No debt timestamps detected; treated all records as current week.' : '']);" +
        "    const metrics = { throughput: throughputMetric, regression_rate: regressionMetric, merge_success: mergeMetric, reopened_tasks: reopenedMetric, debt_growth: debtMetric };" +
        "    const metricKeys = ['throughput', 'regression_rate', 'merge_success', 'reopened_tasks', 'debt_growth'];" +
        "    const trendDeltas = metricKeys.reduce((acc, key) => { const d = metrics?.[key]?.delta; acc[key] = Number.isFinite(d) ? d : null; return acc; }, {});" +
        "    const normalizePriorTrendDelta = (metricName) => {" +
        "      const direct = priorParsed?.priorWeekTrendDeltas?.[metricName];" +
        "      if (Number.isFinite(Number(direct))) return Number(Number(direct).toFixed(2));" +
        "      const trend = priorParsed?.trendDeltas?.[metricName];" +
        "      if (Number.isFinite(Number(trend))) return Number(Number(trend).toFixed(2));" +
        "      const metricDelta = priorParsed?.metrics?.[metricName]?.delta;" +
        "      if (Number.isFinite(Number(metricDelta))) return Number(Number(metricDelta).toFixed(2));" +
        "      return null;" +
        "    };" +
        "    const priorWeekTrendDeltas = metricKeys.reduce((acc, key) => { acc[key] = normalizePriorTrendDelta(key); return acc; }, {});" +
        "    const priorWeekDeltas = priorWeekTrendDeltas;" +
        "    const priorWeekMetrics = priorParsed?.metrics && typeof priorParsed.metrics === 'object' ? priorParsed.metrics : null;" +
        "    const alertThresholds = { throughput: 1, regression_rate: 2.5, merge_success: 2.5, reopened_tasks: 1, debt_growth: 1 };" +
        "    const metricTrendAlerts = Object.entries(metrics).flatMap(([metricName, m]) => {" +
        "      if (m == null || m.delta == null) return [];" +
        "      if (String(m.confidence || '').toLowerCase() === 'low') return [];" +
        "      const delta = Number(m.delta);" +
        "      const isRegression = (m.direction === 'up_is_good' && delta < 0) || (m.direction === 'down_is_good' && delta > 0);" +
        "      if (!isRegression) return [];" +
        "      const absDelta = Math.abs(delta);" +
        "      const threshold = alertThresholds[metricName] ?? 1;" +
        "      const severity = absDelta >= threshold * 2 ? 'high' : absDelta >= threshold ? 'medium' : 'low';" +
        "      return [{ metric: metricName, severity, delta, reason: `${metricName} moved in a negative direction by ${delta} ${m.unit}.` }];" +
        "    });" +
        "    const sourceHealth = {" +
        "      tasks: { ...taskHealth, count: tasks.length }," +
        "      prs: { ...prHealth, count: prs.length }," +
        "      debt: { ...debtHealth, count: debt.length }," +
        "    };" +
        "    const sourceTelemetryAlerts = Object.entries(sourceHealth).flatMap(([sourceName, health]) => {" +
        "      if (health?.status === 'ok') return [];" +
        "      const severity = health?.status === 'missing' ? 'high' : 'medium';" +
        "      const reason = health?.status === 'missing' ? `${sourceName} telemetry missing; metric interpretation may be limited.` : `${sourceName} telemetry partially parsed; confidence reduced.`;" +
        "      return [{ metric: `telemetry:${sourceName}`, severity, delta: null, reason }];" +
        "    });" +
        "    const trendAlerts = [...metricTrendAlerts, ...sourceTelemetryAlerts];" +
        "    const confidenceValues = Object.values(metrics).map((m) => m?.confidence || 'low');" +
        "    const overallConfidence = confidenceValues.every((c) => c === 'high') ? 'high' : confidenceValues.some((c) => c === 'low') ? 'low' : 'medium';" +
        "    const plannerSignals = {" +
        "      schemaVersion: '1.0'," +
        "      overallConfidence," +
        "      trendAlertCount: trendAlerts.length," +
        "      highSeverityAlertCount: trendAlerts.filter((a) => a?.severity === 'high').length," +
        "      sourceStatus: Object.fromEntries(Object.entries(sourceHealth).map(([k, v]) => [k, v?.status || 'missing']))," +
        "      metricStatus: Object.fromEntries(metricKeys.map((k) => [k, metrics?.[k]?.status || 'missing']))," +
        "      metricConfidence: Object.fromEntries(metricKeys.map((k) => [k, metrics?.[k]?.confidence || 'low']))," +
        "      metricValues: Object.fromEntries(metricKeys.map((k) => [k, Number.isFinite(metrics?.[k]?.value) ? Number(metrics[k].value) : null]))," +
        "      trendDeltas," +
        "      priorWeekTrendDeltas," +
        "    };" +
        "    const plannerArtifact = {" +
        "      schemaVersion: '1.0'," +
        "      generatedAt: toIso(now)," +
        "      lookbackDays," +
        "      sourceStatus: plannerSignals.sourceStatus," +
        "      metricConfidence: plannerSignals.metricConfidence," +
        "      metricValues: plannerSignals.metricValues," +
        "      trendDeltas," +
        "      priorWeekTrendDeltas," +
        "      trendAlertCount: plannerSignals.trendAlertCount," +
        "      highSeverityAlertCount: plannerSignals.highSeverityAlertCount," +
        "      trendAlerts," +
        "    };" +
        "    return {" +
        "      schemaVersion: '1.0'," +
        "      generatedAt: toIso(now)," +
        "      lookbackDays," +
        "      window: { currentStart: toIso(currentStart), currentEnd: toIso(now), previousStart: toIso(previousStart), previousEnd: toIso(previousEnd) }," +
        "      sourceHealth," +
        "      metrics," +
        "      trendDeltas," +
        "      trendAlerts," +
        "      priorWeekTrendDeltas," +
        "      priorWeekDeltas," +
        "      priorWeekMetrics," +
        "      plannerSignals," +
        "      plannerArtifact," +
        "      dataQuality: {" +
        "        overallConfidence," +
        "        missingSources: Object.entries(sourceHealth).filter(([, v]) => v.status === 'missing').map(([k]) => k)," +
        "        degradedSources: Object.entries(sourceHealth).filter(([, v]) => v.status === 'degraded').map(([k]) => k)," +
        "      }," +
        "    };" +
        "  } catch (error) {" +
        "    return {" +
        "      schemaVersion: '1.0'," +
        "      generatedAt: new Date().toISOString()," +
        "      lookbackDays: Number($data?.lookbackDays || 7)," +
        "      sourceHealth: {" +
        "        tasks: { status: 'missing', confidence: 'low', count: 0 }," +
        "        prs: { status: 'missing', confidence: 'low', count: 0 }," +
        "        debt: { status: 'missing', confidence: 'low', count: 0 }," +
        "      }," +
        "      metrics: {" +
        "        throughput: { value: null, previous: null, delta: null, confidence: 'low', status: 'missing' }," +
        "        regression_rate: { value: null, previous: null, delta: null, confidence: 'low', status: 'missing' }," +
        "        merge_success: { value: null, previous: null, delta: null, confidence: 'low', status: 'missing' }," +
        "        reopened_tasks: { value: null, previous: null, delta: null, confidence: 'low', status: 'missing' }," +
        "        debt_growth: { value: null, previous: null, delta: null, confidence: 'low', status: 'missing' }," +
        "      }," +
        "      trendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "      trendAlerts: [{ metric: 'summary', severity: 'high', delta: null, reason: `Fitness summary fallback engaged: ${error?.message || 'unknown error'}` }]," +
        "      priorWeekTrendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "      priorWeekDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "      priorWeekMetrics: null," +
        "      plannerSignals: {" +
        "        schemaVersion: '1.0'," +
        "        overallConfidence: 'low'," +
        "        trendAlertCount: 1," +
        "        highSeverityAlertCount: 1," +
        "        sourceStatus: { tasks: 'missing', prs: 'missing', debt: 'missing' }," +
        "        metricStatus: { throughput: 'missing', regression_rate: 'missing', merge_success: 'missing', reopened_tasks: 'missing', debt_growth: 'missing' }," +
        "        metricConfidence: { throughput: 'low', regression_rate: 'low', merge_success: 'low', reopened_tasks: 'low', debt_growth: 'low' }," +
        "        metricValues: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "        trendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "        priorWeekTrendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "      }," +
        "      plannerArtifact: {" +
        "        schemaVersion: '1.0'," +
        "        generatedAt: new Date().toISOString()," +
        "        lookbackDays: Number($data?.lookbackDays || 7)," +
        "        sourceStatus: { tasks: 'missing', prs: 'missing', debt: 'missing' }," +
        "        metricConfidence: { throughput: 'low', regression_rate: 'low', merge_success: 'low', reopened_tasks: 'low', debt_growth: 'low' }," +
        "        metricValues: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "        trendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "        priorWeekTrendDeltas: { throughput: null, regression_rate: null, merge_success: null, reopened_tasks: null, debt_growth: null }," +
        "        trendAlertCount: 1," +
        "        highSeverityAlertCount: 1," +
        "        trendAlerts: [{ metric: 'summary', severity: 'high', delta: null, reason: `Fitness summary fallback engaged: ${error?.message || 'unknown error'}` }]," +
        "      }," +
        "      dataQuality: { overallConfidence: 'low', missingSources: ['tasks', 'prs', 'debt'], degradedSources: [] }," +
        "    };" +
        "  }" +
        "})()",
      isExpression: true,
    }, { x: 420, y: 360 }),

    node("serialize-fitness-summary", "action.set_variable", "Serialize Fitness Summary", {
      key: "fitnessSummaryJson",
      value: "(() => JSON.stringify($data?.fitnessSummary || {}, null, 2))()",
      isExpression: true,
    }, { x: 420, y: 500 }),

    node("render-trend-alerts", "action.set_variable", "Render Trend Alerts", {
      key: "fitnessTrendAlertsText",
      value: "(() => { const alerts = Array.isArray($data?.fitnessSummary?.trendAlerts) ? $data.fitnessSummary.trendAlerts : []; if (!alerts.length) return 'No negative trend alerts this week.'; return alerts.map((a, idx) => `${idx + 1}. ${a.metric} (${a.severity}) - ${a.reason}`).join('\\n'); })()",
      isExpression: true,
    }, { x: 420, y: 640 }),

    node("persist-fitness-summary", "action.write_file", "Persist Fitness Summary Artifact", {
      path: ".bosun/workflow-runs/weekly-fitness-summary.latest.json",
      content: "{{fitnessSummaryJson}}",
      mkdir: true,
    }, { x: 420, y: 780 }),

    node("evaluate-fitness", "action.run_agent", "Evaluate Fitness", {
      prompt: `# Weekly Delivery Fitness Evaluation

Evaluate the last {{lookbackDays}} days using this machine-readable summary:

Metrics to evaluate:
- Throughput
- Regression rate
- Merge success
- Reopened tasks
- Debt growth

## Weekly Fitness JSON
{{fitnessSummaryJson}}

## Negative Trend Alerts
{{fitnessTrendAlertsText}}

Focus directive: {{evaluatorFocus}}

Requirements:
- Respect confidence and status on each metric.
- If a metric has low confidence or missing telemetry, call that out explicitly and avoid overconfident recommendations.
- Use prior-week deltas when available.
- If one telemetry source is unavailable, still provide a stable scorecard and best-effort recommendations.

Return sections:
1) Scorecard (0-100) with one line per metric and confidence
2) Root-cause analysis of the largest drag
3) Countermeasures ranked by impact/cost
4) FOLLOW_UP_ACTION lines using format:
FOLLOW_UP_ACTION: [title] | [description] | [repo_area] | [risk] | [effort]

Only include FOLLOW_UP_ACTION lines for changes that are worth implementing this week.`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 420, y: 930 }),

    node("has-followups", "condition.expression", "Follow-ups Enabled + Present", {
      expression: "($data?.createFollowupTasks === true) && (($ctx.getNodeOutput('evaluate-fitness')?.output || '').includes('FOLLOW_UP_ACTION:'))",
    }, { x: 420, y: 1090 }),

    node("build-followup-json", "action.run_agent", "Build Follow-up Tasks JSON", {
      prompt: `Convert FOLLOW_UP_ACTION lines below into a single JSON object with shape { "tasks": [...] }.

Source:
{{evaluate-fitness.output}}

Structured context:
{{fitnessSummaryJson}}

Rules:
- Generate at most {{maxFollowupTasks}} tasks
- Include fields: task_key, title, description, implementation_steps, files, tests, api_contracts, acceptance_criteria, verification, priority, tags, base_branch, impact, confidence, risk, estimated_effort, repo_areas, why_now, kill_criteria
- Use sprint_id, epic_id, parent_task_key, and depends_on_task_keys when the work belongs in an existing sprint/epic or has DAG ordering
- Use trend deltas from the summary artifact to justify urgency and avoid parse errors
- Keep tasks implementation-ready and avoid duplicates
- Return only JSON`,
      sdk: "auto",
      timeoutMs: 300000,
    }, { x: 220, y: 1260 }),

    node("materialize-followups", "action.materialize_planner_tasks", "Materialize Follow-up Tasks", {
      plannerNodeId: "build-followup-json",
      maxTasks: "{{maxFollowupTasks}}",
      status: "todo",
      dedup: true,
      failOnZero: false,
      minCreated: 0,
    }, { x: 220, y: 1420 }),

    node("notify-summary", "notify.telegram", "Send Weekly Fitness Summary", {
      message: ":chart: Weekly fitness evaluation complete. Follow-up tasks created: {{materialize-followups.createdCount}}\\n\\nTrend alerts:\\n{{fitnessTrendAlertsText}}\\n\\n{{evaluate-fitness.output}}",
      silent: true,
    }, { x: 420, y: 1580 }),

    node("log-no-followups", "notify.log", "No Follow-up Tasks", {
      message: "Weekly fitness evaluation completed with no follow-up task creation.",
      level: "info",
    }, { x: 620, y: 1260 }),
  ],
  edges: [
    edge("trigger", "task-metrics"),
    edge("trigger", "pr-metrics"),
    edge("trigger", "debt-metrics"),
    edge("trigger", "read-previous-summary"),
    edge("task-metrics", "summarize-fitness-metrics"),
    edge("pr-metrics", "summarize-fitness-metrics"),
    edge("debt-metrics", "summarize-fitness-metrics"),
    edge("read-previous-summary", "summarize-fitness-metrics"),
    edge("summarize-fitness-metrics", "serialize-fitness-summary"),
    edge("serialize-fitness-summary", "render-trend-alerts"),
    edge("render-trend-alerts", "persist-fitness-summary"),
    edge("persist-fitness-summary", "evaluate-fitness"),
    edge("evaluate-fitness", "has-followups"),
    edge("has-followups", "build-followup-json", { condition: "$output?.result === true" }),
    edge("has-followups", "log-no-followups", { condition: "$output?.result !== true" }),
    edge("build-followup-json", "materialize-followups"),
    edge("materialize-followups", "notify-summary"),
    edge("log-no-followups", "notify-summary"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-07T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["planning", "weekly", "fitness", "evaluation", "debt", "throughput"],
    replaces: {
      module: "monitor.mjs",
      functions: ["scheduleWeeklyFitnessSummary"],
      calledFrom: ["monitor.mjs:startProcess"],
      description:
        "Adds a weekly evaluator loop that measures delivery fitness and " +
        "optionally materializes improvement actions as tasks.",
    },
  },
};

