/**
 * task-batch.mjs — Task Batch Processor Workflow Template
 *
 * Picks up multiple tasks from the kanban backlog and dispatches them in
 * parallel using the loop.for_each fan-out node. Each task lifecycle is
 * dispatched without blocking the batch run on full child completion.
 *
 * Templates:
 *   - TASK_BATCH_PROCESSOR_TEMPLATE (primary batch dispatch)
 *   - TASK_BATCH_PR_TEMPLATE (batch → agent → PR shortcut)
 *
 * DAG overview:
 *   trigger.task_available
 *     → condition.expression (is coordinator or solo?)
 *       → action.run_command (list todo tasks)
 *         → loop.for_each (fan-out, maxConcurrent dispatches at a time)
 *           → dispatch sub-workflow: template-task-lifecycle per task
 *         → action.set_variable (record batch results)
 *           → condition.expression (any failures?)
 *             → notify.telegram (failure alert)
 *             → notify.log (summary)
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

function requireNonEmptyBatchString(item, index, key) {
  const value = typeof item?.[key] === "string" ? item[key].trim() : "";
  if (!value) {
    throw new Error(`Invalid task-batch payload: item[${index}].${key} must be a non-empty string`);
  }
  return value;
}

function normalizeOptionalBatchString(value, maxLength = 128) {
  if (value == null) return value;
  const normalized = String(value).trim();
  if (!normalized) return "";
  return normalized.slice(0, maxLength);
}

export function validateTaskBatchPayload(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("Invalid task-batch payload: expected an array of task batch items");
  }

  return payload.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid task-batch payload: item[${index}] must be an object`);
    }

    const normalized = {
      ...item,
      taskId: requireNonEmptyBatchString(item, index, "taskId"),
      taskTitle: requireNonEmptyBatchString(item, index, "taskTitle"),
      status: requireNonEmptyBatchString(item, index, "status"),
      repository: requireNonEmptyBatchString(item, index, "repository"),
      workspace: requireNonEmptyBatchString(item, index, "workspace"),
    };

    if (Object.prototype.hasOwnProperty.call(item, "branch")) {
      normalized.branch = normalizeOptionalBatchString(item.branch, 128);
    }
    if (Object.prototype.hasOwnProperty.call(item, "scope")) {
      normalized.scope = normalizeOptionalBatchString(item.scope, 128);
    }

    return normalized;
  });
}

export function isTaskBatchDispatchEligible(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return false;
  if (String(task.status || "").trim().toLowerCase() !== "todo") return false;
  const cooldownUntil = Date.parse(String(task.cooldownUntil || ""));
  if (Number.isFinite(cooldownUntil) && Date.now() < cooldownUntil) return false;

  const description = typeof task.description === "string" ? task.description.trim() : "";
  const title = typeof task.title === "string" ? task.title.trim() : "";
  const branchName =
    typeof task.branchName === "string" ? task.branchName.trim()
      : typeof task.branch === "string" ? task.branch.trim()
        : "";
  const baseBranch = typeof task.baseBranch === "string" ? task.baseBranch.trim() : "";
  const repository = typeof task.repository === "string" ? task.repository.trim() : "";
  const workspace = typeof task.workspace === "string" ? task.workspace.trim() : "";
  const tags = Array.isArray(task.tags)
    ? task.tags.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const plannerMeta = task.meta && typeof task.meta.planner === "object";
  const workflowMeta = task.meta && typeof task.meta.workflow === "object";
  const repoAreas = Array.isArray(task.meta?.repo_areas)
    ? task.meta.repo_areas.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const hasContentSignal = Boolean(description || tags.length > 0 || (title && title !== String(task.id || "").trim()));
  const hasExecutionSignal = Boolean(
    branchName ||
    baseBranch ||
    repository ||
    workspace ||
    plannerMeta ||
    workflowMeta ||
    repoAreas.length > 0
  );

  return hasContentSignal && hasExecutionSignal;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Task Batch Processor — Parallel Task Dispatch
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_BATCH_PROCESSOR_TEMPLATE = {
  id: "template-task-batch-processor",
  name: "Task Batch Processor",
  description:
    "Monitors the task backlog and dispatches multiple tasks in parallel " +
    "using the Task Lifecycle sub-workflow. Automatically picks up tasks " +
    "when backlog drops below threshold, fans out execution across " +
    "available slots, and reports batch results.",
  category: "task-execution",
  enabled: true,
  core: true,
  recommended: true,
  trigger: "trigger.task_available",
  variables: {
    maxConcurrent: 3,
    pollStatus: "todo",
    maxBatchSize: 10,
    subWorkflow: "template-task-lifecycle",
    notifyChannel: "telegram",
  },
  nodes: [
    // ── Trigger: Tasks available for processing ──────────────────────────
    node("trigger", "trigger.task_available", "Tasks Available?", {
      maxParallel: "{{maxConcurrent}}",
      pollIntervalMs: 15000,
      status: "{{pollStatus}}",
    }, { x: 400, y: 50 }),

    // ── Gate: Fleet coordinator check (skip if not coordinator) ──────────
    node("check-coordinator", "condition.expression", "Is Coordinator?", {
      expression: "$data?.isCoordinator !== false",
    }, { x: 400, y: 180 }),

    // ── Query kanban for available tasks ─────────────────────────────────
    node("query-tasks", "action.run_command", "Query Task Backlog", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const cwd = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        let repoRoot = cwd;
        if (cwd.toLowerCase().includes(mirrorMarker)) {
          const sourceRepoRoot = path.resolve(cwd, "..", "..", "..", "..");
          if (fs.existsSync(path.join(sourceRepoRoot, "kanban", "kanban-adapter.mjs"))) repoRoot = sourceRepoRoot;
        }
        process.env.REPO_ROOT = repoRoot;
        process.env.BOSUN_STORE_PATH = path.join(repoRoot, ".bosun", ".cache", "kanban-state.json");
        const kanbanModuleUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        const looksDispatchable = ${isTaskBatchDispatchEligible.toString()};
        import(kanbanModuleUrl)
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const filtered = (tasks || []).filter((task) => looksDispatchable(task));
            const batch = filtered.slice(0, parseInt(process.env.MAX_BATCH || "10"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              status: t.status,
              branch: t.branch || t.branchName || t.metadata?.branch || t.metadata?.branchName || null,
              scope: t.scope || t.metadata?.scope || null,
              repository: typeof t?.repository === "string" ? t.repository.trim() : null,
              workspace: typeof t?.workspace === "string" ? t.workspace.trim() : null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      cwd: "{{repoRoot}}",
      parseJson: true,
    }, { x: 400, y: 310 }),

    // ── Fan-out: dispatch each task to the lifecycle workflow ─────────────
    node("dispatch-tasks", "loop.for_each", "Dispatch Tasks", {
      items: "$ctx.getNodeOutput('query-tasks')?.output || []",
      variable: "currentTask",
      indexVariable: "taskIndex",
      maxConcurrent: "{{maxConcurrent}}",
      workflowId: "{{subWorkflow}}",
      mode: "dispatch",
    }, { x: 400, y: 440 }),

    node("join-dispatch", "flow.join", "Join Dispatch Branches", {
      mode: "all",
      sourceNodeIds: ["dispatch-tasks"],
      includeSkipped: true,
    }, { x: 400, y: 505 }),

    // ── Record batch results ─────────────────────────────────────────────
    node("record-results", "action.set_variable", "Record Results", {
      key: "batchResult",
      value: "{{dispatch-tasks}}",
    }, { x: 400, y: 570 }),

    node("has-batch-failures", "condition.expression", "Any Batch Failures?", {
      expression: "Number($data?.batchResult?.failCount || 0) > 0",
    }, { x: 400, y: 700 }),

    node("notify-failures", "notify.telegram", "Batch Failure Alert", {
      channel: "{{notifyChannel}}",
      message: "Task batch needs attention: {{batchResult.failCount}} failed out of {{batchResult.totalItems}} ({{batchResult.successCount}} succeeded)",
    }, { x: 220, y: 830 }),

    node("log-summary", "notify.log", "Batch Summary", {
      message: "Task batch completed: {{batchResult.successCount}}/{{batchResult.totalItems}} succeeded ({{batchResult.failCount}} failed)",
      level: "info",
    }, { x: 580, y: 830 }),
  ],
  edges: [
    edge("trigger", "check-coordinator"),
    edge("check-coordinator", "query-tasks", { condition: "$output === true || $output?.result === true || $output?.value === true || $output?.triggered === true" }),
    edge("query-tasks", "dispatch-tasks"),
    edge("dispatch-tasks", "join-dispatch"),
    edge("join-dispatch", "record-results"),
    edge("record-results", "has-batch-failures"),
    edge("has-batch-failures", "notify-failures", { condition: "$output?.result === true" }),
    edge("has-batch-failures", "log-summary", { condition: "$output?.result !== true" }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-15T00:00:00Z",
    templateVersion: "1.0.1",
    tags: ["task", "batch", "parallel", "dispatch", "lifecycle"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Task Batch → PR Shortcut — Pick tasks, run agent, create PRs
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const TASK_BATCH_PR_TEMPLATE = {
  id: "template-task-batch-pr",
  name: "Task Batch → PR",
  description:
    "Simplified batch processor that picks todo tasks, runs the agent on " +
    "each, and creates pull requests for any that produce commits. Ideal " +
    "for autonomous mode where tasks should flow straight to PRs.",
  category: "task-execution",
  enabled: true,
  recommended: false,
  trigger: "trigger.task_available",
  variables: {
    maxConcurrent: 2,
    pollStatus: "todo",
    maxBatchSize: 5,
    defaultBaseBranch: "main",
    draftPR: true,
  },
  nodes: [
    // ── Trigger ──────────────────────────────────────────────────────────
    node("trigger", "trigger.task_available", "Tasks Available?", {
      maxParallel: "{{maxConcurrent}}",
      pollIntervalMs: 15000,
      status: "{{pollStatus}}",
    }, { x: 400, y: 50 }),

    // ── Query for tasks ──────────────────────────────────────────────────
    node("query-tasks", "action.run_command", "List Todo Tasks", {
      command: "node",
      args: ["-e", `
        const fs = require("node:fs");
        const path = require("node:path");
        const { pathToFileURL } = require("node:url");
        const cwd = process.cwd();
        const mirrorMarker = (path.sep + ".bosun" + path.sep + "workspaces" + path.sep).toLowerCase();
        let repoRoot = cwd;
        if (cwd.toLowerCase().includes(mirrorMarker)) {
          const sourceRepoRoot = path.resolve(cwd, "..", "..", "..", "..");
          if (fs.existsSync(path.join(sourceRepoRoot, "kanban", "kanban-adapter.mjs"))) repoRoot = sourceRepoRoot;
        }
        process.env.REPO_ROOT = repoRoot;
        process.env.BOSUN_STORE_PATH = path.join(repoRoot, ".bosun", ".cache", "kanban-state.json");
        const kanbanModuleUrl = pathToFileURL(path.join(repoRoot, "kanban", "kanban-adapter.mjs")).href;
        const looksDispatchable = ${isTaskBatchDispatchEligible.toString()};
        import(kanbanModuleUrl)
          .then(k => k.listTasks(undefined, { status: "todo" }))
          .then(tasks => {
            const filtered = (tasks || []).filter((task) => looksDispatchable(task));
            const batch = filtered.slice(0, parseInt(process.env.MAX_BATCH || "5"));
            console.log(JSON.stringify(batch.map(t => ({
              taskId: t.id,
              taskTitle: t.title || t.id,
              branch: t.branch || t.branchName || t.metadata?.branch || t.metadata?.branchName || null,
              repository: typeof t?.repository === "string" ? t.repository.trim() : null,
              workspace: typeof t?.workspace === "string" ? t.workspace.trim() : null,
            }))));
          })
          .catch(e => { console.error(e.message); process.exit(1); });
      `],
      env: { MAX_BATCH: "{{maxBatchSize}}" },
      cwd: "{{repoRoot}}",
      parseJson: true,
    }, { x: 400, y: 180 }),

    // ── Fan-out: per-task agent + PR ─────────────────────────────────────
    node("for-each-task", "loop.for_each", "Process Each Task", {
      items: "$ctx.getNodeOutput('query-tasks')?.output || []",
      variable: "task",
      indexVariable: "idx",
      maxConcurrent: "{{maxConcurrent}}",
    }, { x: 400, y: 310 }),

    // ── Per-task: set status to inprogress ───────────────────────────────
    node("set-inprogress", "action.update_task_status", "Mark In-Progress", {
      taskId: "{{task.taskId}}",
      status: "inprogress",
    }, { x: 400, y: 440 }),

    // ── Per-task: run agent ──────────────────────────────────────────────
    node("run-agent", "action.run_agent", "Run Agent", {
      taskId: "{{task.taskId}}",
      taskTitle: "{{task.taskTitle}}",
      branch: "{{task.branch}}",
    }, { x: 400, y: 570 }),

    // ── Per-task: detect commits ─────────────────────────────────────────
    node("detect-commits", "action.detect_new_commits", "Check Commits", {
      taskId: "{{task.taskId}}",
      worktreePath: "{{worktreePath}}",
      failOnError: false,
    }, { x: 400, y: 700 }),

    // ── Per-task: push + create PR ───────────────────────────────────────
    node("push-branch", "action.git_operations", "Push Branch", {
      operation: "push",
      cwd: "{{worktreePath}}",
    }, { x: 400, y: 830 }),

    node("create-pr", "action.create_pr", "Create PR", {
      title: "{{task.taskTitle}}",
      body: "## Summary\n\n{{task.taskDescription}}\n\n---\nTask-ID: {{task.taskId}}",
      base: "{{defaultBaseBranch}}",
      branch: "{{task.branch}}",
      draft: "{{draftPR}}",
    }, { x: 400, y: 960 }),

    // ── Per-task: mark review ────────────────────────────────────────────
    node("set-inreview", "action.update_task_status", "Mark In-Review", {
      taskId: "{{task.taskId}}",
      status: "inreview",
    }, { x: 400, y: 1090 }),

    node("handoff-pr-progressor", "action.execute_workflow", "Dispatch PR Progressor", {
      workflowId: "template-bosun-pr-progressor",
      mode: "dispatch",
      input: {
        taskId: "{{task.taskId}}",
        taskTitle: "{{task.taskTitle}}",
        branch: "{{task.branch}}",
        baseBranch: "{{defaultBaseBranch}}",
        prNumber: "{{$ctx.getNodeOutput('create-pr')?.prNumber ?? null}}",
        prUrl: "{{$ctx.getNodeOutput('create-pr')?.prUrl || ''}}",
        repo: "{{$ctx.getNodeOutput('create-pr')?.repoSlug || $data?.repo || $data?.repoSlug || $data?.repository || ''}}",
      },
    }, { x: 400, y: 1160 }),

    node("join-batch-outcomes", "flow.join", "Join Batch Outcomes", {
      mode: "all",
      sourceNodeIds: ["detect-commits", "handoff-pr-progressor"],
      includeSkipped: true,
    }, { x: 400, y: 1230 }),

    // ── Batch complete notification ──────────────────────────────────────
    node("notify", "notify.log", "Batch Complete", {
      message: "Task batch PR pipeline complete",
      level: "info",
    }, { x: 400, y: 1220 }),
  ],
  edges: [
    edge("trigger", "query-tasks"),
    edge("query-tasks", "for-each-task"),
    edge("for-each-task", "set-inprogress"),
    edge("set-inprogress", "run-agent"),
    edge("run-agent", "detect-commits"),
    edge("detect-commits", "push-branch", { condition: "result.hasNewCommits === true" }),
    edge("push-branch", "create-pr"),
    edge("create-pr", "set-inreview"),
    edge("detect-commits", "join-batch-outcomes", { condition: "result.hasNewCommits !== true" }),
    edge("set-inreview", "handoff-pr-progressor"),
    edge("handoff-pr-progressor", "join-batch-outcomes"),
    edge("join-batch-outcomes", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 2,
    createdAt: "2026-03-15T00:00:00Z",
    templateVersion: "1.1.0",
    tags: ["task", "batch", "pr", "agent", "autonomous"],
    requiredTemplates: ["template-bosun-pr-progressor"],
  },
};
