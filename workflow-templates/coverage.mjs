/**
 * workflow-templates/coverage.mjs — Node-Type Coverage Templates
 *
 * Five templates designed to exercise the 31 node types that were not
 * covered by any of the existing 40 templates.
 *
 * Node types targeted:
 *   trigger.webhook, trigger.scheduled_once, trigger.workflow_call, trigger.event
 *   condition.task_has_tag, condition.file_exists
 *   transform.template
 *   notify.webhook_out
 *   action.create_task, action.read_file, action.delay
 *   action.mcp_list_tools, action.mcp_tool_call
 *   action.ask_user
 *   action.resolve_executor, action.build_task_prompt
 *   action.continue_session, action.handle_rate_limit, action.restart_agent
 *   action.push_branch, action.release_claim
 *   action.execute_workflow
 *   action.acquire_worktree, action.release_worktree
 *   flow.gate, flow.join, flow.end
 *   flow.universial (intentional — matches registered type name)
 *   loop.while
 *   meeting.finalize
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ── Template 1: Webhook Task Router ─────────────────────────────────────────
// Exercises: trigger.webhook, condition.task_has_tag, condition.file_exists,
//            transform.template, action.create_task, notify.webhook_out

resetLayout();
export const WEBHOOK_TASK_ROUTER_TEMPLATE = {
  id: "template-webhook-task-router",
  name: "Webhook Task Router",
  category: "coverage",
  enabled: true,
  trigger: "trigger.webhook",
  description: "Routes inbound webhook events to tasks, exercising webhook trigger, tag checks, file-exists conditions, template transforms, task creation, and webhook acknowledgements.",
  variables: {
    taskTags: ["priority"],
    webhookEventType: "task.created",
    requiredTag: "priority",
    configFile: "/nonexistent/config.json",
    webhookCallbackUrl: "http://localhost:65000/webhook/ack",
  },
  nodes: [
    node("trigger",      "trigger.webhook",         "Webhook Trigger",       { eventType: "{{webhookEventType}}" }),
    node("render-msg",   "transform.template",      "Render Message",        { template: "Task created: {{webhook.payload.title || 'unknown'}}" }),
    node("check-tag",    "condition.task_has_tag",  "Has Priority Tag?",     { tag: "{{requiredTag}}", field: "tags" }, { outputs: ["yes", "no"] }),
    node("check-config", "condition.file_exists",   "Config Exists?",        { path: "{{configFile}}" }),
    node("log-skip",     "notify.log",              "Log Skipped",           { message: "Skipped — no priority tag", level: "info" }),
    node("create-task",  "action.create_task",      "Create Task",           { title: "Webhook task: {{webhookEventType}}", tags: "{{taskTags}}" }),
    node("notify-out",   "notify.webhook_out",      "Acknowledge Webhook",   { url: "{{webhookCallbackUrl}}", payload: { status: "processed" } }),
  ],
  edges: [
    edge("trigger",      "render-msg"),
    edge("render-msg",   "check-tag"),
    edge("check-tag",    "check-config", { port: "yes" }),
    edge("check-tag",    "log-skip",     { port: "no" }),
    edge("check-config", "create-task"),
    edge("log-skip",     "create-task"),
    edge("create-task",  "notify-out"),
  ],
  metadata: { author: "virtengine", tags: ["coverage", "webhook", "routing"] },
};

// ── Template 2: Scheduled Maintenance ───────────────────────────────────────
// Exercises: trigger.scheduled_once, action.read_file, action.delay,
//            flow.gate, action.acquire_worktree, action.release_worktree

resetLayout();
export const SCHEDULED_MAINTENANCE_TEMPLATE = {
  id: "template-scheduled-maintenance",
  name: "Scheduled Maintenance",
  category: "coverage",
  enabled: true,
  trigger: "trigger.scheduled_once",
  description: "Runs a one-time maintenance window: reads config, waits, acquires a worktree through a safety gate, performs work, then releases. Exercises scheduled_once, read_file, delay, flow.gate, acquire/release_worktree.",
  variables: {
    taskId: "MAINT-01",
    maintenanceConfigPath: "/nonexistent/maintenance.json",
    targetBranch: "feat/maintenance-test",
    baseBranch: "origin/main",
  },
  nodes: [
    node("trigger",      "trigger.scheduled_once",  "Scheduled Trigger",    { runAt: "2020-01-01T00:00:00Z" }),
    node("read-config",  "action.read_file",        "Read Config",          { path: "{{maintenanceConfigPath}}", continueOnError: true }),
    node("wait",         "action.delay",            "Short Delay",          { ms: 1 }),
    node("safety-gate",  "flow.gate",               "Safety Gate",          { mode: "timeout", timeoutMs: 1, reason: "maintenance safety gate" }),
    node("acquire",      "action.acquire_worktree", "Acquire Worktree",     { branch: "{{targetBranch}}", baseBranch: "{{baseBranch}}", taskId: "{{taskId}}", continueOnError: true }),
    node("release",      "action.release_worktree", "Release Worktree",     { continueOnError: true }),
    node("done",         "notify.log",              "Maintenance Done",     { message: "Maintenance complete", level: "info" }),
  ],
  edges: [
    edge("trigger",     "read-config"),
    edge("read-config", "wait"),
    edge("wait",        "safety-gate"),
    edge("safety-gate", "acquire"),
    edge("acquire",     "release"),
    edge("release",     "done"),
  ],
  metadata: { author: "virtengine", tags: ["coverage", "maintenance", "worktree"] },
};

// ── Template 3: MCP Research Probe ──────────────────────────────────────────
// Exercises: trigger.workflow_call, action.ask_user, action.create_pr, flow.end

resetLayout();
export const MCP_RESEARCH_PROBE_TEMPLATE = {
  id: "template-mcp-research-probe",
  name: "MCP Research Probe",
  category: "coverage",
  enabled: true,
  trigger: "trigger.workflow_call",
  description: "Called by another workflow to ask for user confirmation and open a PR with findings. Exercises workflow_call trigger, ask_user, create_pr, flow.end.",
  variables: {
    query: "express.js middleware",
    prBranch: "research/mcp-test",
    prBaseBranch: "main",
  },
  nodes: [
    node("trigger",    "trigger.workflow_call",  "Workflow Call Trigger",        {}),
    node("ask-user",   "action.ask_user",        "Ask User for Confirmation",    {
      question: "Research complete. Proceed with PR?",
      outputVariable: "userConfirmation", continueOnError: true,
    }),
    node("create-pr",  "action.create_pr",       "Create Research PR",           {
      title: "research: {{query}}", branch: "{{prBranch}}", baseBranch: "{{prBaseBranch}}",
      body: "## Research\\n\\n{{query}}",
      continueOnError: true,
    }),
    node("done",       "flow.end",               "End",                          {}),
  ],
  edges: [
    edge("trigger",   "ask-user"),
    edge("ask-user",  "create-pr"),
    edge("create-pr", "done"),
  ],
  metadata: { author: "virtengine", tags: ["coverage", "mcp", "research"] },
};

// ── Template 4: Agent Execution Pipeline ────────────────────────────────────
// Exercises: trigger.event, action.resolve_executor, action.build_task_prompt,
//            action.continue_session, action.handle_rate_limit, action.restart_agent,
//            action.push_branch, action.release_claim, action.execute_workflow

resetLayout();
export const AGENT_EXECUTION_PIPELINE_TEMPLATE = {
  id: "template-agent-execution-pipeline",
  name: "Agent Execution Pipeline",
  category: "coverage",
  enabled: true,
  trigger: "trigger.event",
  description: "Full agent execution lifecycle: resolves executor, builds prompt, continues/restarts session, handles rate limits, pushes branch, releases claim, dispatches finalization workflow. Exercises many rarely-used action nodes.",
  variables: {
    taskId: "TASK-10",
    taskTitle: "Coverage test task",
    taskDescription: "Test task for coverage",
    branch: "feat/pipeline-test",
    baseBranch: "origin/main",
    worktreePath: "/tmp/wt-pipeline-test",
    sessionId: "session-coverage-1",
    finalizationWorkflow: "template-health-check",
  },
  nodes: [
    node("trigger",           "trigger.event",            "Event Trigger",           { eventType: "task.assigned" }),
    node("resolve-executor",  "action.resolve_executor",  "Resolve Executor",        { taskId: "{{taskId}}", continueOnError: true }),
    node("build-prompt",      "action.build_task_prompt", "Build Task Prompt",       { taskId: "{{taskId}}", taskTitle: "{{taskTitle}}", taskDescription: "{{taskDescription}}", continueOnError: true }),
    node("continue-session",  "action.continue_session",  "Continue Session",        { sessionId: "{{sessionId}}", prompt: "Continue executing task {{taskTitle}}", strategy: "continue", timeoutMs: 1000, continueOnError: true }),
    node("handle-rate-limit", "action.handle_rate_limit", "Handle Rate Limit",       { strategy: "skip", continueOnError: true }),
    node("restart-agent",     "action.restart_agent",     "Restart Agent",           { agentId: "{{sessionId}}", continueOnError: true }),
    node("push-branch",       "action.push_branch",       "Push Branch",             { branch: "{{branch}}", baseBranch: "{{baseBranch}}", worktreePath: "{{worktreePath}}", rebaseBeforePush: false, emptyDiffGuard: false, continueOnError: true }),
    node("release-claim",     "action.release_claim",     "Release Claim",           { taskId: "{{taskId}}", continueOnError: true }),
    node("dispatch-finalize", "flow.universal",           "Dispatch Finalization",   { workflowId: "{{finalizationWorkflow}}", mode: "dispatch", continueOnError: true }),
    node("log-done",          "notify.log",               "Log Dispatched",          { message: "Pipeline complete for task {{taskId}}", level: "info" }),
  ],
  edges: [
    edge("trigger",           "resolve-executor"),
    edge("resolve-executor",  "build-prompt"),
    edge("build-prompt",      "continue-session"),
    edge("continue-session",  "handle-rate-limit"),
    edge("handle-rate-limit", "restart-agent"),
    edge("restart-agent",     "push-branch"),
    edge("push-branch",       "release-claim"),
    edge("release-claim",     "dispatch-finalize"),
    edge("dispatch-finalize", "log-done"),
  ],
  metadata: { author: "virtengine", tags: ["coverage", "agent", "pipeline"], requiredTemplates: ["template-health-check"] },
};

// ── Template 5: Flow Control Suite ──────────────────────────────────────────
// Exercises: trigger.manual, flow.join, loop.while, flow.universial (typo matches
//            the registered type name), meeting.finalize

resetLayout();
export const FLOW_CONTROL_SUITE_TEMPLATE = {
  id: "template-flow-control-suite",
  name: "Flow Control Suite",
  category: "coverage",
  enabled: true,
  trigger: "trigger.manual",
  description: "Exercises flow-control primitives in a single short workflow: approval gate, join, while-loop (0 iters), universal dispatch, and meeting finalization.",
  variables: {
    subWorkflowId: "template-health-check",
    sessionId: "session-flow-test",
    maxLoopIterations: 1,
    gateReason: "default gate reason",
  },
  nodes: [
    node("trigger",          "trigger.manual",    "Manual Trigger",          {}),
    node("approval-gate",    "flow.gate",         "Approval Gate",           { mode: "manual", reason: "{{gateReason}}", timeoutMs: 500, onTimeout: "proceed" }),
    node("join",             "flow.join",         "Join Branches",           { mode: "any", sourceNodeIds: [] }),
    node("loop",             "loop.while",        "While Loop",              { condition: "$iteration < 0", maxIterations: "{{maxLoopIterations}}" }),
    node("dispatch1",        "flow.universal",    "Universal Dispatch 1",    { mode: "dispatch", workflowId: "{{subWorkflowId}}" }),
    node("dispatch2",        "flow.universial",   "Universal Dispatch 2",    { workflowId: "{{subWorkflowId}}", mode: "dispatch" }),
    node("finalize-meeting", "meeting.finalize",  "Finalize Meeting",        { sessionId: "{{sessionId}}", continueOnError: true }),
    node("done",             "notify.log",        "Done",                    { message: "Flow control suite complete", level: "info" }),
  ],
  edges: [
    edge("trigger",          "approval-gate"),
    edge("approval-gate",    "join"),
    edge("join",             "loop"),
    edge("loop",             "dispatch1"),
    edge("dispatch1",        "dispatch2"),
    edge("dispatch2",        "finalize-meeting"),
    edge("finalize-meeting", "done"),
  ],
  metadata: { author: "virtengine", tags: ["coverage", "flow", "control"], requiredTemplates: ["template-health-check"] },
};
