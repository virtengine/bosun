/**
 * workflow-nodes.mjs — Built-in Workflow Node Types for Bosun
 *
 * Registers all standard node types that can be used in workflow definitions.
 * Node types are organized by category:
 *
 *   TRIGGERS    — Events that start workflow execution
 *   CONDITIONS  — Branching logic / gates
 *   ACTIONS     — Side-effect operations (run agent, create task, etc.)
 *   VALIDATION  — Verification gates (screenshots, tests, model review)
 *   TRANSFORM   — Data transformation / aggregation
 *   NOTIFY      — Notifications (telegram, log, etc.)
 *
 * Each node type must export:
 *   execute(node, ctx, engine) → Promise<any>   — The node's logic
 *   describe() → string                         — Human-readable description
 *   schema → object                             — JSON Schema for node config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseCronExpression } from "../cron-scheduler.mjs";
import {
  normalizePlannerAreaKey,
  resolveTaskRepoAreas,
} from "./agent.mjs";
import {
  _completedWithPR,
  _noCommitCounts,
  _skipUntil,
  cfgOrCtx,
  deriveTaskBranch,
  ensureKanbanAdapterMod,
  ensureTaskClaimsInitialized,
  ensureTaskClaimsMod,
  ensureTaskStoreMod,
  looksLikeFilesystemPath,
  MAX_NO_COMMIT_ATTEMPTS,
  normalizeMirroredRepoRoot,
  normalizeCanStartGuardResult,
  pickTaskString,
  resolveTaskRepositoryRoot,
  STRICT_START_GUARD_MISSING_TASK,
} from "./transforms.mjs";
import { resolve, dirname } from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";

import {
  registerNodeType,
  BOSUN_ATTACHED_PR_LABEL,
  PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND,
  PORTABLE_WORKTREE_COUNT_COMMAND,
  TAG,
  WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT,
  WORKFLOW_AGENT_HEARTBEAT_MS,
  WORKFLOW_TELEGRAM_ICON_MAP,
  bindTaskContext,
  buildAgentEventPreview,
  buildAgentExecutionDigest,
  buildGitExecutionEnv,
  buildTaskContextBlock,
  buildWorkflowAgentToolContract,
  collectWakePhraseCandidates,
  condenseAgentItems,
  createKanbanTaskWithProject,
  decodeWorkflowUnicodeIconToken,
  deriveManagedWorktreeDirName,
  detectWakePhraseMatch,
  evaluateTaskAssignedTriggerConfig,
  execGitArgsSync,
  extractStreamText,
  extractSymbolHint,
  formatAttachmentLine,
  formatCommentLine,
  getPathValue,
  isBosunStateComment,
  isManagedBosunWorktree,
  makeIsolatedGitEnv,
  normalizeLegacyWorkflowCommand,
  normalizeLineEndings,
  normalizeNarrativeText,
  normalizePrEventName,
  normalizeTaskAttachments,
  normalizeTaskComments,
  normalizeWorkflowStack,
  normalizeWorkflowTelegramText,
  parseBooleanSetting,
  parsePathListingLine,
  resolveGitCandidates,
  resolveWorkflowNodeValue,
  simplifyPathLabel,
  summarizeAgentStreamEvent,
  summarizeAssistantMessageData,
  summarizeAssistantUsage,
  summarizePathListingBlock,
  trimLogText,
} from "./definitions.mjs";

function clearTaskIdentityContext(data) {
  if (!data || typeof data !== "object") return;
  for (const key of [
    "taskId",
    "activeTaskId",
    "taskTitle",
    "task",
    "taskInfo",
    "taskDetail",
    "taskDescription",
    "branch",
    "branchName",
    "baseBranch",
    "_workflowRootTaskId",
    "_workflowParentTaskId",
    "_workflowRootSessionId",
    "_workflowParentSessionId",
  ]) {
    delete data[key];
  }
}

async function resolveExplicitTaskContext(ctx, engine, explicitTaskId, explicitTaskTitle) {
  const normalizedTaskId = String(explicitTaskId || "").trim();
  if (!normalizedTaskId) return null;
  let attemptedLookup = false;
  let matchingCandidate = null;

  const providedCandidates = [
    ctx?.data?.task,
    ctx?.data?.taskDetail,
    ctx?.data?.taskInfo,
  ];
  for (const candidate of providedCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const candidateId = String(candidate.id || candidate.task_id || "").trim();
    if (candidateId !== normalizedTaskId) continue;
    matchingCandidate = candidate;
    break;
  }

  const mergeResolvedTask = (task) => (
    matchingCandidate && typeof matchingCandidate === "object"
      ? { ...matchingCandidate, ...task }
      : task
  );

  const kanban = ctx?.data?._services?.kanban || engine?.services?.kanban || null;
  if (typeof kanban?.getTask === "function") {
    attemptedLookup = true;
    try {
      const task = await kanban.getTask(normalizedTaskId);
      if (task && typeof task === "object") {
        return {
          taskId: normalizedTaskId,
          taskTitle: pickTaskString(
            explicitTaskTitle,
            task.title,
            task.task_title,
            matchingCandidate?.title,
            matchingCandidate?.task_title,
          ),
          task: mergeResolvedTask(task),
        };
      }
    } catch {
      // fall through to task-store lookup
    }
  }

  const taskStore =
    ctx?.data?._services?.taskStore ||
    engine?.services?.taskStore ||
    null;
  if (typeof taskStore?.getTask === "function") {
    attemptedLookup = true;
    try {
      const task = await taskStore.getTask(normalizedTaskId);
      if (task && typeof task === "object") {
        return {
          taskId: normalizedTaskId,
          taskTitle: pickTaskString(
            explicitTaskTitle,
            task.title,
            task.task_title,
            matchingCandidate?.title,
            matchingCandidate?.task_title,
          ),
          task: mergeResolvedTask(task),
        };
      }
    } catch {
      // stale explicit task context should fall back to normal polling
    }
  }

  if (matchingCandidate) {
    return {
      taskId: normalizedTaskId,
      taskTitle: pickTaskString(
        explicitTaskTitle,
        matchingCandidate.title,
        matchingCandidate.task_title,
        normalizedTaskId,
      ),
      task: matchingCandidate,
    };
  }

  if (!attemptedLookup) {
    return {
      taskId: normalizedTaskId,
      taskTitle: pickTaskString(explicitTaskTitle, normalizedTaskId),
      task: { id: normalizedTaskId, title: pickTaskString(explicitTaskTitle, normalizedTaskId) },
    };
  }

  return null;
}

registerNodeType("trigger.manual", {
  describe: () => "Manual trigger — workflow starts on user request",
  schema: {
    type: "object",
    properties: {},
  },
  outputs: [
    {
      name: "default",
      label: "Task",
      type: "TaskDef",
      description: "Default task payload emitted when a manual workflow run starts.",
    },
  ],
  ui: {
    primaryFields: [],
  },
  async execute(node, ctx) {
    ctx.log(node.id, "Manual trigger fired");
    return { triggered: true, reason: "manual" };
  },
});

registerNodeType("trigger.task_low", {
  describe: () =>
    "Fires when backlog task count drops below threshold. Self-queries kanban " +
    "when todoCount is not pre-populated in context data.",
  schema: {
    type: "object",
    properties: {
      threshold: { type: "number", default: 3, description: "Minimum todo count before triggering" },
      status: { type: "string", default: "todo", description: "Task status to count" },
      projectId: { type: "string", description: "Project ID to check (optional)" },
    },
  },
  async execute(node, ctx) {
    const threshold = node.config?.threshold ?? 3;
    const status = node.config?.status ?? "todo";
    let todoCount = ctx.data?.todoCount ?? ctx.data?.backlogCount ?? null;

    // Self-query kanban if todoCount not pre-populated
    if (todoCount == null) {
      try {
        const projectId = cfgOrCtx(node, ctx, "projectId") || undefined;
        const kanban = ctx.data?._services?.kanban;
        let tasks;
        if (kanban?.listTasks) {
          tasks = await kanban.listTasks(projectId, { status });
        } else {
          const ka = await ensureKanbanAdapterMod();
          tasks = await ka.listTasks(projectId, { status });
        }
        todoCount = Array.isArray(tasks) ? tasks.length : 0;
        ctx.log(node.id, `Self-queried kanban: ${todoCount} task(s) with status "${status}"`);
      } catch (err) {
        ctx.log(node.id, `Kanban query failed: ${err?.message || err} — using 0`);
        todoCount = 0;
      }
    }

    const triggered = todoCount < threshold;
    ctx.log(node.id, `Task count: ${todoCount}, threshold: ${threshold}, triggered: ${triggered}`);
    return { triggered, todoCount, threshold };
  },
});

registerNodeType("trigger.schedule", {
  describe: () => "Fires on a cron-like schedule or interval (checked by supervisor loop)",
  schema: {
    type: "object",
    properties: {
      intervalMs: { type: "number", default: 3600000, description: "Interval in milliseconds (ignored when cron is set)" },
      cron: { type: "string", description: "Standard 5-field cron expression (min hour dom mon dow)" },
      timezone: { type: "string", default: "UTC", description: "Timezone for cron evaluation (currently UTC only)" },
    },
  },
  async execute(node, ctx) {
    const cronExpr = typeof node.config?.cron === "string" ? node.config.cron.trim() : "";

    if (cronExpr) {
      try {
        const parsed = parseCronExpression(cronExpr);
        const lastRun = ctx.data?._lastRunAt ? new Date(ctx.data._lastRunAt) : new Date(0);
        const nextRun = parsed.next(lastRun);
        const now = new Date();
        const triggered = now >= nextRun;
        ctx.log(node.id, `Cron check: expr="${cronExpr}", nextRun=${nextRun.toISOString()}, triggered=${triggered}`);
        return { triggered, cron: cronExpr, nextRunAt: nextRun.toISOString() };
      } catch (err) {
        ctx.log(node.id, `Cron parse error: ${err?.message || err}`);
        return { triggered: false, error: err?.message || "invalid cron" };
      }
    }

    const interval = node.config?.intervalMs ?? 3600000;
    const lastRun = ctx.data?._lastRunAt ?? 0;
    const elapsed = Date.now() - lastRun;
    const triggered = elapsed >= interval;
    ctx.log(node.id, `Schedule check: ${elapsed}ms elapsed, interval: ${interval}ms, triggered: ${triggered}`);
    return { triggered, elapsed, interval };
  },
});

registerNodeType("trigger.event", {
  describe: () => "Fires on a specific bosun event (task.complete, pr.merged, etc.)",
  schema: {
    type: "object",
    properties: {
      eventType: { type: "string", description: "Event type to listen for" },
      filter: { type: "string", description: "Optional filter expression" },
    },
  },
  async execute(node, ctx) {
    const expected = node.config?.eventType;
    const actual = ctx.data?.eventType || ctx.eventType;
    const triggered = expected === actual;
    if (triggered && node.config?.filter) {
      try {
        const fn = new Function("$event", `return (${node.config.filter});`);
        return { triggered: fn(ctx.data), eventType: actual };
      } catch {
        return { triggered: false, reason: "filter_error" };
      }
    }
    return { triggered, eventType: actual };
  },
});

registerNodeType("trigger.meeting.wake_phrase", {
  describe: () => "Fires when a transcript/event payload contains the configured wake phrase",
  schema: {
    type: "object",
    properties: {
      wakePhrase: { type: "string", description: "Wake phrase to match (alias: phrase)" },
      phrase: { type: "string", description: "Alias for wakePhrase" },
      mode: {
        type: "string",
        enum: ["contains", "starts_with", "exact", "regex"],
        default: "contains",
      },
      caseSensitive: { type: "boolean", default: false },
      text: {
        type: "string",
        description: "Optional explicit text to inspect before payload-derived fields",
      },
      payloadField: {
        type: "string",
        description: "Optional payload path to inspect (e.g. content, payload.transcript)",
      },
      sessionId: { type: "string", description: "Optional sessionId filter" },
      role: { type: "string", description: "Optional role filter (user|assistant|system)" },
      failOnInvalidRegex: {
        type: "boolean",
        default: false,
        description: "Throw when regex mode is invalid instead of soft-failing",
      },
    },
  },
  async execute(node, ctx) {
    const eventData = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
    const resolveValue = (value) => (
      typeof ctx?.resolve === "function" ? ctx.resolve(value) : value
    );

    const wakePhrase = String(
      resolveValue(node.config?.wakePhrase || node.config?.phrase || eventData?.wakePhrase || ""),
    ).trim();
    if (!wakePhrase) {
      return { triggered: false, reason: "wake_phrase_missing" };
    }

    const expectedSessionId = String(resolveValue(node.config?.sessionId || "")).trim();
    const actualSessionId = String(
      eventData?.sessionId || eventData?.meetingSessionId || eventData?.session?.id || "",
    ).trim();
    if (expectedSessionId) {
      if (!actualSessionId) {
        return {
          triggered: false,
          reason: "session_missing",
          expectedSessionId,
        };
      }
      if (expectedSessionId !== actualSessionId) {
        return {
          triggered: false,
          reason: "session_mismatch",
          expectedSessionId,
          sessionId: actualSessionId,
        };
      }
    }

    const expectedRole = String(resolveValue(node.config?.role || "")).trim().toLowerCase();
    const actualRole = String(
      eventData?.role || eventData?.speakerRole || eventData?.participantRole || "",
    ).trim().toLowerCase();
    if (expectedRole) {
      if (!actualRole) {
        return {
          triggered: false,
          reason: "role_missing",
          expectedRole,
          sessionId: actualSessionId || null,
        };
      }
      if (expectedRole !== actualRole) {
        return {
          triggered: false,
          reason: "role_mismatch",
          expectedRole,
          role: actualRole,
          sessionId: actualSessionId || null,
        };
      }
    }

    const payloadField = String(resolveValue(node.config?.payloadField || "")).trim();
    const configuredText = String(resolveValue(node.config?.text || "") || "").trim();
    const candidates = configuredText
      ? [{ field: "text", text: configuredText }]
      : [];
    candidates.push(...collectWakePhraseCandidates(eventData, payloadField));
    if (!candidates.length) {
      return {
        triggered: false,
        reason: "payload_missing",
        wakePhrase,
        sessionId: actualSessionId || null,
        role: actualRole || null,
      };
    }

    const mode = String(resolveValue(node.config?.mode || "contains")).trim().toLowerCase() || "contains";
    const caseSensitive = parseBooleanSetting(
      resolveValue(node.config?.caseSensitive ?? false),
      false,
    );
    const failOnInvalidRegex = parseBooleanSetting(
      resolveValue(node.config?.failOnInvalidRegex ?? false),
      false,
    );

    for (const candidate of candidates) {
      const matched = detectWakePhraseMatch(candidate.text, wakePhrase, {
        mode,
        caseSensitive,
      });
      if (matched.error) {
        if (failOnInvalidRegex) {
          throw new Error(`trigger.meeting.wake_phrase: ${matched.error}`);
        }
        return {
          triggered: false,
          reason: "invalid_regex",
          error: matched.error,
          wakePhrase,
          mode,
        };
      }
      if (matched.matched) {
        return {
          triggered: true,
          wakePhrase,
          mode: matched.mode,
          sessionId: actualSessionId || null,
          role: actualRole || null,
          matchedField: candidate.field,
          matchedText: candidate.text.length > 240
            ? `${candidate.text.slice(0, 237)}...`
            : candidate.text,
        };
      }
    }

    return {
      triggered: false,
      reason: "wake_phrase_not_found",
      wakePhrase,
      mode,
      sessionId: actualSessionId || null,
      role: actualRole || null,
      inspectedFields: candidates.slice(0, 12).map((entry) => entry.field),
    };
  },
});

registerNodeType("trigger.webhook", {
  describe: () => "Fires when a webhook is received at the workflow's endpoint",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Webhook path (auto-generated if empty)" },
      method: { type: "string", default: "POST", enum: ["GET", "POST"] },
    },
  },
  async execute(node, ctx) {
    return { triggered: true, payload: ctx.data?.webhookPayload || {} };
  },
});

registerNodeType("trigger.pr_event", {
  describe: () => "Fires on PR events (opened, merged, review requested, etc.)",
  schema: {
    type: "object",
    properties: {
      event: { type: "string", enum: ["opened", "merged", "review_requested", "changes_requested", "approved", "closed"], description: "PR event type" },
      events: { type: "array", items: { type: "string" }, description: "List of accepted PR events" },
      branchPattern: { type: "string", description: "Branch name regex filter" },
    },
  },
  async execute(node, ctx) {
    const expectedEvents = Array.isArray(node.config?.events)
      ? node.config.events.map((value) => normalizePrEventName(value)).filter(Boolean)
      : [];
    const expectedSingle = normalizePrEventName(node.config?.event);
    if (expectedSingle) expectedEvents.push(expectedSingle);

    const actual = normalizePrEventName(
      ctx.data?.prEvent ||
      (String(ctx.data?.eventType || "").startsWith("pr.")
        ? String(ctx.data?.eventType || "").slice(3)
        : ""),
    );

    let triggered = expectedEvents.length > 0
      ? expectedEvents.includes(actual)
      : Boolean(actual);
    if (triggered && node.config?.branchPattern) {
      const regex = new RegExp(node.config.branchPattern);
      triggered = regex.test(ctx.data?.branch || "");
    }
    return { triggered, prEvent: actual };
  },
});

registerNodeType("trigger.task_assigned", {
  describe: () => "Fires when a task is assigned to an agent",
  schema: {
    type: "object",
    properties: {
      agentType: { type: "string", description: "Filter by agent type (e.g., 'frontend')" },
      taskPattern: { type: "string", description: "Title/tag pattern to match" },
      filter: { type: "string", description: "Optional JS expression evaluated against task and event data" },
    },
  },
  async execute(node, ctx) {
    const eventData = {
      ...(ctx.data && typeof ctx.data === "object" ? ctx.data : {}),
    };
    if (!eventData.eventType) {
      eventData.eventType = String(ctx.eventType || "").trim() || undefined;
    }
    if (!eventData.task && typeof eventData.taskTitle === "string") {
      eventData.task = { title: eventData.taskTitle };
    }
    const triggered = evaluateTaskAssignedTriggerConfig(node.config || {}, eventData);
    return { triggered, task: eventData.task || eventData };
  },
});

registerNodeType("trigger.anomaly", {
  describe: () => "Fires when the anomaly detector reports an anomaly matching the configured criteria",
  schema: {
    type: "object",
    properties: {
      anomalyType: { type: "string", description: "Anomaly type filter (e.g., 'error_spike', 'stuck_agent', 'build_failure')" },
      minSeverity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium", description: "Minimum severity to trigger" },
      agentFilter: { type: "string", description: "Regex to match agent ID or name" },
    },
  },
  async execute(node, ctx) {
    const expected = node.config?.anomalyType;
    const actual = ctx.data?.anomalyType || ctx.data?.type;
    const typeMatch = !expected || expected === actual;

    // Severity ranking
    const severityRank = { low: 1, medium: 2, high: 3, critical: 4 };
    const minSev = severityRank[node.config?.minSeverity || "medium"] || 2;
    const actualSev = severityRank[ctx.data?.severity] || 0;
    const sevMatch = actualSev >= minSev;

    // Agent filter
    let agentMatch = true;
    if (node.config?.agentFilter && ctx.data?.agentId) {
      try {
        agentMatch = new RegExp(node.config.agentFilter, "i").test(ctx.data.agentId);
      } catch { agentMatch = false; }
    }

    const triggered = typeMatch && sevMatch && agentMatch;
    return {
      triggered,
      anomaly: ctx.data,
      anomalyType: actual,
      severity: ctx.data?.severity,
      agentId: ctx.data?.agentId,
    };
  },
});

registerNodeType("trigger.scheduled_once", {
  describe: () => "Fires once at or after a specific scheduled time (persistent — survives restarts)",
  schema: {
    type: "object",
    properties: {
      runAt: { type: "string", description: "ISO 8601 datetime or relative expression (e.g., '+30m', '+2h')" },
      reason: { type: "string", description: "Human-readable reason for the scheduled trigger" },
    },
    required: ["runAt"],
  },
  async execute(node, ctx) {
    const rawRunAt = ctx.resolve(node.config?.runAt || "");
    let runAtMs;

    // Parse relative time expressions: +30m, +2h, +1d
    const relMatch = rawRunAt.match(/^\+(\d+)([smhd])$/);
    if (relMatch) {
      const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      runAtMs = Date.now() + (parseInt(relMatch[1], 10) * (multipliers[relMatch[2]] || 60000));
    } else {
      runAtMs = new Date(rawRunAt).getTime();
    }

    if (isNaN(runAtMs)) {
      return { triggered: false, reason: "invalid_runAt", raw: rawRunAt };
    }

    const triggered = Date.now() >= runAtMs;
    return {
      triggered,
      runAt: new Date(runAtMs).toISOString(),
      reason: node.config?.reason || "",
      remainingMs: triggered ? 0 : runAtMs - Date.now(),
    };
  },
});

registerNodeType("trigger.workflow_call", {
  describe: () =>
    "Fires when this workflow is invoked by another workflow via action.execute_workflow. " +
    "Defines expected input parameters that callers should provide.",
  schema: {
    type: "object",
    properties: {
      inputs: {
        type: "object",
        description:
          "Declares expected input parameters. Keys are variable names, " +
          "values are objects with { type, description, required, default }.",
        additionalProperties: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["string", "number", "boolean", "object", "array"] },
            description: { type: "string" },
            required: { type: "boolean", default: false },
            default: { description: "Default value when caller does not supply this input" },
          },
        },
      },
    },
  },
  async execute(node, ctx) {
    // Validate required inputs from _triggerVars or context data
    const inputDefs = node.config?.inputs || {};
    const callerVars = ctx.data?._triggerVars || ctx.data || {};
    const missing = [];
    const resolved = {};

    for (const [key, def] of Object.entries(inputDefs)) {
      const value = callerVars[key] ?? ctx.data?.[key] ?? def?.default;
      if (def?.required && (value === undefined || value === null || value === "")) {
        missing.push(key);
      }
      resolved[key] = value;
      // Inject resolved input into context data for downstream nodes
      ctx.data[key] = value;
    }

    if (missing.length > 0) {
      ctx.log(node.id, `Missing required inputs: ${missing.join(", ")}`, "warn");
      return {
        triggered: true,
        valid: false,
        missing,
        reason: `Missing required inputs: ${missing.join(", ")}`,
      };
    }

    ctx.log(node.id, `Workflow call trigger: ${Object.keys(resolved).length} input(s) resolved`);
    return {
      triggered: true,
      valid: true,
      inputs: resolved,
      calledBy: ctx.data?._workflowStack?.slice(-2, -1)?.[0] || null,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONDITIONS — Branching / routing logic
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("trigger.task_available", {
  describe: () =>
    "Polling trigger that fires when todo tasks are available. Handles " +
    "slot limits, anti-thrash filtering, cooldowns, task sorting (fire " +
    "tasks first, then review tasks before new tasks), and listTasks retry with backoff.",
  schema: {
    type: "object",
    properties: {
      maxParallel: { type: "number", default: 3, description: "Maximum parallel task slots" },
      pollIntervalMs: { type: "number", default: 30000, description: "Poll interval in ms" },
      projectId: { type: "string", description: "Kanban project ID (optional)" },
      status: { type: "string", default: "todo", description: "Status to poll for (single status, overridden by statuses)" },
      statuses: {
        type: "array",
        items: { type: "string" },
        description:
          "Ordered list of statuses to poll. Tasks from earlier statuses are " +
          "prioritized over later ones (e.g. [\"inreview\", \"todo\"] dispatches " +
          "review fixes before new work). Falls back to singular 'status' if omitted.",
      },
      filterCodexScoped: { type: "boolean", default: true, description: "Only codex-scoped tasks" },
      filterDrafts: { type: "boolean", default: true, description: "Exclude draft tasks" },
      listRetries: { type: "number", default: 3, description: "Retries for listTasks calls" },
      listRetryDelayMs: { type: "number", default: 2000, description: "Base delay between retries" },
      repoAreaParallelLimit: { type: "number", default: 0, description: "Per-repo-area active task cap (0 disables limit)" },
      enforceStartGuards: { type: "boolean", default: true, description: "Filter out tasks blocked by dependency/sprint DAG start guards" },
      requireTaskPromptCompleteness: {
        type: "boolean",
        default: false,
        description: "Skip tasks missing prompt-critical description or URL metadata before dispatch",
      },
      sprintOrderMode: { type: "string", enum: ["parallel", "sequential"], description: "Optional global sprint-order override when evaluating guards" },
      strictStartGuardMissingTask: { type: "boolean", default: false, description: "When true, task_not_found from start guards blocks dispatch and emits audit events" },
    },
  },
  async execute(node, ctx, engine) {
    const isWorkflowPlaceholder = (value) => {
      if (typeof value !== "string") return false;
      const trimmed = value.trim();
      return trimmed.startsWith("{{") && trimmed.endsWith("}}");
    };
    const hasStaleWorktreePlaceholders = (task) => [
      task?.blockedReason,
      task?.cooldownUntil,
      task?.meta?.autoRecovery?.retryAt,
      task?.meta?.worktreeFailure?.retryAt,
      task?.meta?.worktreeFailure?.blockedReason,
    ].some((value) => isWorkflowPlaceholder(value));
    const resolveBlockedTaskRetryAtMs = (task, autoRecovery) => {
      const candidates = [
        autoRecovery?.retryAt,
        task?.cooldownUntil,
        task?.meta?.worktreeFailure?.retryAt,
      ];
      for (const candidate of candidates) {
        if (!candidate || isWorkflowPlaceholder(candidate)) continue;
        const parsed = Date.parse(String(candidate));
        if (Number.isFinite(parsed)) return parsed;
      }
      return null;
    };
    const shouldRecoverBlockedTask = (task, nowMs) => {
      if (String(task?.status || "").trim().toLowerCase() !== "blocked") return false;
      const autoRecovery = task?.meta?.autoRecovery;
      const worktreeFailure = task?.meta?.worktreeFailure;
      const failureKind = String(
        worktreeFailure?.failureKind || autoRecovery?.failureKind || "",
      ).trim();
      const hasPlaceholder = hasStaleWorktreePlaceholders(task);
      const isWorktreeRecovery = (
        autoRecovery
        && typeof autoRecovery === "object"
        && autoRecovery.active !== false
        && String(autoRecovery.reason || "").trim() === "worktree_failure"
      ) || (
        worktreeFailure
        && typeof worktreeFailure === "object"
      ) || hasPlaceholder;
      if (!isWorktreeRecovery) return false;
      if (failureKind === "branch_refresh_conflict" && !hasPlaceholder) return false;
      const retryAtMs = resolveBlockedTaskRetryAtMs(task, autoRecovery);
      if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) return false;
      if (!Number.isFinite(retryAtMs) && !hasPlaceholder) return false;
      return true;
    };
    const maxParallel = node.config?.maxParallel ?? 3;
    const singleStatus = node.config?.status ?? "todo";
    const statusesRaw = Array.isArray(node.config?.statuses) ? node.config.statuses : null;
    const statuses = statusesRaw && statusesRaw.length > 0
      ? statusesRaw.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean)
      : [singleStatus];
    const projectId = cfgOrCtx(node, ctx, "projectId") || undefined;
    const filterDrafts = node.config?.filterDrafts !== false;
    const listRetries = node.config?.listRetries ?? 3;
    const listRetryDelayMs = node.config?.listRetryDelayMs ?? 2000;
    const repoAreaParallelLimit = Number(node.config?.repoAreaParallelLimit ?? 0);
    const enforceStartGuards = node.config?.enforceStartGuards !== false;
    const requireTaskPromptCompleteness =
      node.config?.requireTaskPromptCompleteness === true;
    const sprintOrderMode = String(node.config?.sprintOrderMode || "").trim().toLowerCase();
    const strictStartGuardMissingTask =
      typeof node.config?.strictStartGuardMissingTask === "boolean"
        ? node.config.strictStartGuardMissingTask
        : STRICT_START_GUARD_MISSING_TASK;

    const explicitTaskId = String(
      ctx.data?.taskId
      || ctx.data?.task?.id
      || ctx.data?.taskDetail?.id
      || "",
    ).trim();
    const explicitTaskTitle = pickTaskString(
      ctx.data?.taskTitle,
      ctx.data?.task?.title,
      ctx.data?.taskDetail?.title,
    );
    if (explicitTaskId) {
      const resolvedExplicitTask = await resolveExplicitTaskContext(
        ctx,
        engine,
        explicitTaskId,
        explicitTaskTitle,
      );
      if (!resolvedExplicitTask) {
        ctx.log(node.id, `Ignoring stale explicit task context for ${explicitTaskId}`);
        clearTaskIdentityContext(ctx.data);
      } else {
        bindTaskContext(ctx, resolvedExplicitTask);
        const explicitBranch = deriveTaskBranch(resolvedExplicitTask.task);
        if (explicitBranch) {
          ctx.data.branch = explicitBranch;
          ctx.data.branchName = explicitBranch;
        }
        ctx.log(node.id, `Using provided task context for ${explicitTaskId}`);
        return {
          triggered: true,
          reason: "direct_task",
          taskId: explicitTaskId,
          taskTitle: resolvedExplicitTask.taskTitle || null,
          task: resolvedExplicitTask.task || { id: explicitTaskId, title: resolvedExplicitTask.taskTitle || undefined },
          tasks: [{ id: explicitTaskId }],
        };
      }
    }

    // Check slot availability
    const slotSnapshot =
      typeof engine?.getTaskLifecycleSlotSnapshot === "function"
        ? engine.getTaskLifecycleSlotSnapshot()
        : null;
    const workflowActiveRuns =
      typeof engine?.getActiveRuns === "function"
        ? engine.getActiveRuns()
        : [];
    const workflowActiveTaskIds = Array.from(new Set(
      Array.isArray(slotSnapshot?.activeTaskIds) && slotSnapshot.activeTaskIds.length > 0
        ? slotSnapshot.activeTaskIds
        : workflowActiveRuns
          .map((run) => String(run?.taskId || "").trim())
          .filter(Boolean),
    ));
    const activeSlotCount = Number(
      ctx.data?.activeSlotCount
      ?? slotSnapshot?.activeSlotCount
      ?? (workflowActiveTaskIds.length > 0 ? workflowActiveTaskIds.length : 0),
    ) || 0;
    if (
      slotSnapshot?.baseBranchSlotCounts
      && typeof slotSnapshot.baseBranchSlotCounts === "object"
    ) {
      ctx.data.baseBranchSlotCounts = slotSnapshot.baseBranchSlotCounts;
    }
    ctx.data.activeSlotCount = activeSlotCount;
    ctx.data.activeTaskIds = workflowActiveTaskIds;
    if (activeSlotCount >= maxParallel) {
      ctx.log(node.id, `All ${maxParallel} slot(s) in use — skipping`);
      return { triggered: false, reason: "slots_full", activeSlotCount, maxParallel };
    }

    const kanban = ctx.data?._services?.kanban || engine?.services?.kanban;
    const nowMs = Date.now();
    if (kanban?.listTasks && typeof kanban.updateTask === "function") {
      try {
        const blockedTasks = await kanban.listTasks(projectId, { status: "blocked" });
        if (Array.isArray(blockedTasks) && blockedTasks.length > 0) {
          for (const blockedTask of blockedTasks) {
            if (!shouldRecoverBlockedTask(blockedTask, nowMs)) continue;
            const recoveredStatus = Boolean(
              blockedTask?.prNumber || blockedTask?.pr_number || blockedTask?.prUrl || blockedTask?.pr_url,
            )
              ? "inreview"
              : "todo";
            await kanban.updateTask(String(blockedTask.id || blockedTask.task_id || "").trim(), {
              status: recoveredStatus,
              cooldownUntil: null,
              blockedReason: null,
            });
          }
        }
      } catch (err) {
        ctx.log(node.id, `Blocked-task recovery skipped: ${err?.message || err}`);
      }
    }

    // Query kanban for each status with retry + backoff, merge results
    let tasks = [];
    let lastErr = null;
    const statusPriorityMap = new Map();
    for (let si = 0; si < statuses.length; si++) {
      statusPriorityMap.set(statuses[si], si);
    }
    for (const queryStatus of statuses) {
      let statusTasks = [];
      for (let attempt = 0; attempt <= listRetries; attempt++) {
        try {
          if (kanban?.listTasks) {
            statusTasks = await kanban.listTasks(projectId, { status: queryStatus });
          } else {
            const ka = await ensureKanbanAdapterMod();
            statusTasks = await ka.listTasks(projectId, { status: queryStatus });
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < listRetries) {
            const delay = listRetryDelayMs * Math.pow(2, attempt);
            ctx.log(node.id, `listTasks(${queryStatus}) attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (statusTasks?.length > 0) {
        // Client-side status filter + tag source status for priority sorting
        for (const t of statusTasks) {
          if (t.status === queryStatus) {
            t._sourceStatusPriority = statusPriorityMap.get(queryStatus) ?? 999;
            tasks.push(t);
          }
        }
      }
    }
    if (lastErr && tasks.length === 0) {
      ctx.log(node.id, `listTasks failed after ${listRetries + 1} attempts: ${lastErr.message}`);
      return { triggered: false, reason: "list_error", error: lastErr.message };
    }

    // Deduplicate tasks across statuses (same id may appear in multiple queries)
    const seenIds = new Set();
    tasks = tasks.filter((t) => {
      const id = String(t.id || t.task_id || "");
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    // Draft filter
    if (filterDrafts && tasks?.length > 0) {
      tasks = tasks.filter((t) => !t.draft && !t.isDraft);
    }
    if (requireTaskPromptCompleteness && tasks?.length > 0) {
      const resolvePromptTaskUrl = (task = {}) => {
        const taskMeta = task?.meta && typeof task.meta === "object" ? task.meta : {};
        const taskId = pickTaskString(
          task?.id,
          task?.taskId,
          task?.task_id,
          taskMeta?.taskId,
          taskMeta?.task_id,
        );
        return pickTaskString(
          task?.taskUrl,
          task?.task_url,
          task?.url,
          taskMeta?.taskUrl,
          taskMeta?.task_url,
          taskMeta?.url,
          taskId ? `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}` : "",
        );
      };
      const eligibleTasks = [];
      const filteredTasks = [];
      for (const task of tasks) {
        const taskId = String(task?.id || task?.task_id || "").trim();
        let hydratedTask = task;
        let taskDescription = pickTaskString(
          task?.description,
          task?.task_description,
          task?.body,
          task?.details,
          task?.meta?.taskDescription,
          task?.meta?.task_description,
        );
        let taskUrl = resolvePromptTaskUrl(task);
        if ((!taskDescription || !taskUrl) && taskId && typeof kanban?.getTask === "function") {
          try {
            const fetchedTask = await kanban.getTask(taskId);
            if (fetchedTask && typeof fetchedTask === "object") {
              hydratedTask = {
                ...fetchedTask,
                ...task,
                meta: {
                  ...(fetchedTask.meta || {}),
                  ...(task.meta || {}),
                },
              };
              taskDescription = pickTaskString(
                taskDescription,
                fetchedTask.description,
                fetchedTask.task_description,
                fetchedTask.body,
                fetchedTask.details,
                fetchedTask.meta?.taskDescription,
                fetchedTask.meta?.task_description,
              );
              taskUrl = pickTaskString(taskUrl, resolvePromptTaskUrl(fetchedTask));
            }
          } catch (err) {
            ctx.log(node.id, `Prompt completeness lookup failed for ${taskId}: ${err?.message || err}`);
          }
        }
        if (taskDescription && taskUrl) {
          eligibleTasks.push(hydratedTask);
          continue;
        }
        filteredTasks.push({
          taskId: taskId || "(missing-id)",
          missing: [
            taskDescription ? null : "description",
            taskUrl ? null : "url",
          ].filter(Boolean),
        });
      }
      if (filteredTasks.length > 0) {
        const sample = filteredTasks
          .slice(0, 3)
          .map((entry) => `${entry.taskId}:${entry.missing.join("+")}`)
          .join(", ");
        ctx.log(node.id, `Prompt completeness filtered ${filteredTasks.length} task(s): ${sample}`);
      }
      tasks = eligibleTasks;
      if (tasks.length === 0) {
        return {
          triggered: false,
          reason: "prompt_quality_filtered",
          taskCount: 0,
          filteredTasks,
        };
      }
    }
    if (!tasks || tasks.length === 0) {
      return { triggered: false, reason: "no_tasks", taskCount: 0 };
    }

    // Anti-thrash + cooldown filters
    const activeTaskIds = Array.isArray(ctx.data?.activeTaskIds) && ctx.data.activeTaskIds.length > 0
      ? ctx.data.activeTaskIds
      : workflowActiveTaskIds;
    const now = Date.now();
    tasks = tasks.filter((t) => {
      const id = String(t.id || t.task_id || "");
      if (!id) return false;
      // Already running
      if (activeTaskIds.includes(id)) return false;
      // Already completed with PR this session
      if (_completedWithPR.has(id)) return false;
      // Skip-until cooldown (anti-thrash)
      const skipUntil = _skipUntil.get(id);
      if (skipUntil && now < skipUntil) return false;
      // Persisted task cooldown survives workflow/session boundaries.
      const persistedCooldownUntil = Date.parse(String(t.cooldownUntil || ""));
      if (Number.isFinite(persistedCooldownUntil) && now < persistedCooldownUntil) return false;
      // Hard-blocked after MAX_NO_COMMIT_ATTEMPTS
      const noCommitCount = _noCommitCounts.get(id) || 0;
      if (noCommitCount >= MAX_NO_COMMIT_ATTEMPTS) return false;
      // Explicit cooldowns from context
      const cooldowns = ctx.data?.taskCooldowns || {};
      const cd = cooldowns[id];
      if (cd && now < cd) return false;
      // Blocked task IDs
      const blocked = ctx.data?.blockedTaskIds || [];
      if (blocked.includes(id)) return false;
      return true;
    });

    if (tasks.length === 0) {
      return { triggered: false, reason: "all_filtered", taskCount: 0 };
    }

    let persistedOwnershipFilteredCount = 0;
    try {
      const claimsMod = await ensureTaskClaimsMod();
      await ensureTaskClaimsInitialized(ctx, claimsMod);
      if (typeof claimsMod.listClaims === "function") {
        const repoRoot = resolve(pickTaskString(
          ctx?.data?.repoRoot,
          ctx?.data?.workspace,
          process.cwd(),
        ));
        const activeClaims = await claimsMod.listClaims({ repoRoot });
        if (Array.isArray(activeClaims) && activeClaims.length > 0) {
          const claimedTaskIds = new Set(
            activeClaims
              .map((claim) => String(claim?.task_id || claim?.taskId || "").trim())
              .filter(Boolean),
          );
          const beforeFilterCount = tasks.length;
          tasks = tasks.filter((task) => !claimedTaskIds.has(String(task?.id || task?.task_id || "").trim()));
          persistedOwnershipFilteredCount = Math.max(0, beforeFilterCount - tasks.length);
        }
      }
    } catch (err) {
      ctx.log(node.id, `Persisted claim filtering skipped: ${err?.message || err}`);
    }

    if (tasks.length === 0) {
      return {
        triggered: false,
        reason: persistedOwnershipFilteredCount > 0 ? "all_claimed" : "all_filtered",
        taskCount: 0,
        persistedOwnershipFilteredCount,
      };
    }

    // DAG / sprint-order guard: only dispatch tasks that can legally start.
    let startGuardAuditEvents = [];
    if (enforceStartGuards && tasks.length > 0) {
      let canStartFn =
        ctx.data?._services?.taskStore?.canStartTask
        || engine?.services?.taskStore?.canStartTask
        || null;
      if (typeof canStartFn !== "function") {
        try {
          const taskStore = await ensureTaskStoreMod();
          canStartFn = taskStore?.canStartTask || taskStore?.canTaskStart || null;
        } catch {
          canStartFn = null;
        }
      }

      if (typeof canStartFn === "function") {
        const allowed = [];
        const blocked = [];
        const auditEvents = [];
        for (const task of tasks) {
          const taskId = String(task?.id || task?.task_id || "").trim();
          if (!taskId) continue;
          let guardRaw = null;
          try {
            guardRaw = await canStartFn(
              taskId,
              sprintOrderMode === "sequential" || sprintOrderMode === "parallel"
                ? { sprintOrderMode }
                : {},
            );
          } catch (err) {
            const event = {
              type: "start_guard_error",
              taskId,
              reason: `guard_error:${err?.message || String(err)}`,
            };
            blocked.push({ taskId, reason: event.reason });
            auditEvents.push(event);
            continue;
          }

          const guard = normalizeCanStartGuardResult(guardRaw);
          const taskNotFound = guard.reason === "task_not_found";
          const bypassMissingTask = taskNotFound && !strictStartGuardMissingTask;
          if (guard.canStart || bypassMissingTask) {
            allowed.push(task);
            if (bypassMissingTask) {
              auditEvents.push({
                type: "start_guard_bypass",
                taskId,
                reason: "task_not_found",
                strict: false,
              });
            }
          } else {
            const blockedEntry = {
              taskId,
              reason: guard.reason,
              blockingTaskIds: guard.blockingTaskIds,
              missingDependencyTaskIds: guard.missingDependencyTaskIds,
              blockingSprintIds: guard.blockingSprintIds,
              blockingEpicIds: guard.blockingEpicIds,
              sprintOrderMode: guard.sprintOrderMode,
              sprintTaskOrderMode: guard.sprintTaskOrderMode,
              strict: Boolean(taskNotFound && strictStartGuardMissingTask),
            };
            blocked.push(blockedEntry);
            auditEvents.push({ type: "start_guard_blocked", ...blockedEntry });
          }
        }

        tasks = allowed;
        startGuardAuditEvents = auditEvents;

        if (blocked.length > 0) {
          const sample = blocked.slice(0, 3).map((entry) => `${entry.taskId}:${entry.reason}`).join(", ");
          ctx.log(node.id, `Start guard filtered ${blocked.length} task(s): ${sample}`);
        }
        if (auditEvents.length > 0) {
          const preview = auditEvents
            .slice(0, 3)
            .map((entry) => `${entry.type}:${entry.taskId}:${entry.reason}`)
            .join(", ");
          ctx.log(node.id, `Start guard audit events (${auditEvents.length}): ${preview}`);
        }
        if (tasks.length === 0) {
          return {
            triggered: false,
            reason: "start_guard_blocked",
            taskCount: 0,
            blocked,
            auditEvents,
          };
        }
      }
    }

    // Sort: status priority first (inreview before todo), then fire tasks,
    // then by numeric priority, then by created date (oldest first — FIFO).
    // This ensures review/fix tasks get dispatched before new work starts.
    tasks.sort((a, b) => {
      // 1. Status priority: earlier statuses in the config array come first
      const aStatusPri = a._sourceStatusPriority ?? 999;
      const bStatusPri = b._sourceStatusPriority ?? 999;
      if (aStatusPri !== bStatusPri) return aStatusPri - bStatusPri;
      // 2. Fire labels
      const aFire = (a.labels || []).some((l) => typeof l === "string" ? l.includes("fire") : l?.name?.includes("fire"));
      const bFire = (b.labels || []).some((l) => typeof l === "string" ? l.includes("fire") : l?.name?.includes("fire"));
      if (aFire && !bFire) return -1;
      if (!aFire && bFire) return 1;
      // 3. Numeric priority (lower = higher priority)
      const aPri = a.priority ?? 999;
      const bPri = b.priority ?? 999;
      if (aPri !== bPri) return aPri - bPri;
      // 4. Created date (oldest first — FIFO)
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });

    const remaining = maxParallel - activeSlotCount;
    let toDispatch = tasks.slice(0, remaining);
    if (Number.isFinite(repoAreaParallelLimit) && repoAreaParallelLimit > 0 && toDispatch.length > 0) {
      const activeTaskAreaCounts =
        ctx.data?.activeTaskAreaCounts && typeof ctx.data.activeTaskAreaCounts === "object"
          ? ctx.data.activeTaskAreaCounts
          : {};
      const projectedAreaCounts = new Map();
      for (const [key, value] of Object.entries(activeTaskAreaCounts)) {
        const areaKey = normalizePlannerAreaKey(key);
        const count = Number(value);
        if (!areaKey || !Number.isFinite(count) || count <= 0) continue;
        projectedAreaCounts.set(areaKey, Math.trunc(count));
      }

      const selected = [];
      for (const candidate of tasks) {
        if (selected.length >= remaining) break;
        const areas = resolveTaskRepoAreas(candidate);
        if (!areas.length) {
          selected.push(candidate);
          continue;
        }
        let blocked = false;
        for (const area of areas) {
          const areaKey = normalizePlannerAreaKey(area);
          if (!areaKey) continue;
          const current = projectedAreaCounts.get(areaKey) || 0;
          if (current >= repoAreaParallelLimit) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        selected.push(candidate);
        for (const area of areas) {
          const areaKey = normalizePlannerAreaKey(area);
          if (!areaKey) continue;
          projectedAreaCounts.set(areaKey, (projectedAreaCounts.get(areaKey) || 0) + 1);
        }
      }
      toDispatch = selected;
      if (toDispatch.length === 0) {
        return {
          triggered: false,
          reason: "repo_area_parallel_limit",
          taskCount: 0,
          availableSlots: remaining,
          repoAreaParallelLimit,
          auditEvents: startGuardAuditEvents,
        };
      }
    }

    const primaryTask = toDispatch[0] || null;
    if (primaryTask) {
      const taskId = pickTaskString(primaryTask.id, primaryTask.task_id);
      const taskTitle = pickTaskString(primaryTask.title, primaryTask.task_title);
      bindTaskContext(ctx, { taskId, taskTitle, task: primaryTask });
      const taskDescription = pickTaskString(
        primaryTask.description,
        primaryTask.task_description,
      );
      if (taskDescription) ctx.data.taskDescription = taskDescription;
      const taskWorkspace = pickTaskString(
        primaryTask.workspace,
        primaryTask.workspacePath,
        primaryTask.meta?.workspace,
        primaryTask.metadata?.workspace,
      );
      if (taskWorkspace) {
        ctx.data.workspace = taskWorkspace;
        if (!pickTaskString(ctx.data.repoRoot) && looksLikeFilesystemPath(taskWorkspace)) {
          ctx.data.repoRoot = normalizeMirroredRepoRoot(taskWorkspace);
        }
      }
      const taskRepository = pickTaskString(
        primaryTask.repository,
        primaryTask.repo,
        primaryTask.meta?.repository,
        primaryTask.metadata?.repository,
      );
      if (taskRepository) {
        ctx.data.repository = taskRepository;
        ctx.data.repoSlug = taskRepository;
        const resolvedRepoRoot = resolveTaskRepositoryRoot(
          taskRepository,
          pickTaskString(ctx.data.repoRoot, process.cwd()),
        );
        if (resolvedRepoRoot) {
          ctx.data.repoRoot = resolvedRepoRoot;
        }
      }
      const taskRepositories = Array.isArray(primaryTask.repositories)
        ? primaryTask.repositories
        : [];
      if (taskRepositories.length > 0) {
        ctx.data.repositories = taskRepositories;
      }
      if (looksLikeFilesystemPath(ctx.data.repoRoot || "")) {
        const repoNameHint = taskRepository ? String(taskRepository).split("/").pop() : "";
        ctx.data.repoRoot = normalizeMirroredRepoRoot(ctx.data.repoRoot, repoNameHint);
      }
      const baseBranch = pickTaskString(primaryTask.baseBranch, primaryTask.base_branch);
      if (baseBranch) ctx.data.baseBranch = baseBranch;
      const branch = deriveTaskBranch(primaryTask);
      if (branch) {
        ctx.data.branch = branch;
        ctx.data.branchName = branch;
      }
      ctx.data._taskBranchBinding = {
        taskId,
        resolvedBranch: branch || null,
        resolvedBaseBranch: baseBranch || null,
        candidates: {
          baseBranch: primaryTask?.baseBranch ?? primaryTask?.base_branch ?? null,
          target: primaryTask?.target ?? null,
          "meta.targetBranch": primaryTask?.meta?.targetBranch ?? primaryTask?.metadata?.targetBranch ?? null,
        },
      };
    }

    ctx.log(node.id, `Found ${toDispatch.length} task(s) ready (${remaining} slot(s) free)`);
    return {
      triggered: true,
      tasks: toDispatch,
      task: primaryTask,
      taskCount: toDispatch.length,
      taskTitle: primaryTask ? pickTaskString(primaryTask.title, primaryTask.task_title) : null,
      availableSlots: remaining,
      selectedTaskId: primaryTask ? pickTaskString(primaryTask.id, primaryTask.task_id) : "",
      persistedOwnershipFilteredCount,
      auditEvents: startGuardAuditEvents,
    };
  },
});
// ── condition.slot_available ────────────────────────────────────────────────
