/**
 * voice-action-dispatcher.mjs — Direct JavaScript action dispatcher for voice agents.
 *
 * The voice model returns JSON action intents. This module:
 *   1. Parses the action intent (tool calls, task operations, agent delegations)
 *   2. Executes the action directly via Bosun's JavaScript APIs (no MCP bridge)
 *   3. Returns structured results back to the voice session
 *
 * Supported action types:
 *   - task.*       → kanban CRUD (list, get, create, update, delete, stats, search)
 *   - agent.*      → agent delegation (/ask, /agent, /plan via primary-agent)
 *   - session.*    → session management (list, history, create)
 *   - system.*     → system status, fleet, config
 *   - workspace.*  → file read, directory list, code search
 *   - tool.*       → MCP tool passthrough (Bosun processes tool calls server-side)
 *   - workflow.*   → workflow management (list, trigger)
 *   - skill.*      → skill/prompt management (list, get)
 *
 * @module voice-action-dispatcher
 */

import { loadConfig } from "../config/config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName, setPrimaryAgent, getAgentMode, setAgentMode } from "../agent/primary-agent.mjs";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  appendVoiceTurnTraceEvent,
  beginVoiceTurnTrace,
  completeVoiceTurnTrace,
  getVoiceTurnTrace as getVoiceTurnTraceState,
} from "./vision-session-state.mjs";

// ── Module-scope lazy imports ───────────────────────────────────────────────

let _kanbanAdapter = null;
let _sessionTracker = null;
let _fleetCoordinator = null;
let _agentSupervisor = null;
let _sharedStateManager = null;
let _agentPrompts = null;
let _bosunSkills = null;
let _workflowTemplates = null;
let _workflowEngine = null;
let _taskStore = null;

async function getKanban() {
  if (!_kanbanAdapter) {
    _kanbanAdapter = await import("../kanban/kanban-adapter.mjs");
  }
  return _kanbanAdapter;
}

async function getSessionTracker() {
  if (!_sessionTracker) {
    _sessionTracker = await import("../infra/session-tracker.mjs");
  }
  return _sessionTracker;
}

async function getFleetCoordinator() {
  if (!_fleetCoordinator) {
    _fleetCoordinator = await import("../agent/fleet-coordinator.mjs");
  }
  return _fleetCoordinator;
}

async function getSupervisor() {
  if (!_agentSupervisor) {
    _agentSupervisor = await import("../agent/agent-supervisor.mjs");
  }
  return _agentSupervisor;
}

async function getSharedState() {
  if (!_sharedStateManager) {
    _sharedStateManager = await import("../workspace/shared-state-manager.mjs");
  }
  return _sharedStateManager;
}

async function getAgentPrompts() {
  if (!_agentPrompts) {
    _agentPrompts = await import("../agent/agent-prompts.mjs");
  }
  return _agentPrompts;
}

async function getBosunSkills() {
  if (!_bosunSkills) {
    _bosunSkills = await import("../agent/bosun-skills.mjs");
  }
  return _bosunSkills;
}

async function getWorkflowTemplates() {
  if (!_workflowTemplates) {
    _workflowTemplates = await import("../workflow/workflow-templates.mjs");
  }
  return _workflowTemplates;
}

async function getWorkflowEngineModule() {
  if (!_workflowEngine) {
    _workflowEngine = await import("../workflow/workflow-engine.mjs");
  }
  return _workflowEngine;
}

async function getTaskStore() {
  if (!_taskStore) {
    try {
      _taskStore = await import("../task/task-store.mjs");
    } catch {
      _taskStore = null;
    }
  }
  return _taskStore;
}

// ── Constants ───────────────────────────────────────────────────────────────

const VALID_EXECUTORS = new Set([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
]);

const VALID_AGENT_MODES = new Set(["ask", "agent", "plan", "web", "instant"]);

const MODE_ALIASES = Object.freeze({
  code: "agent",
  architect: "plan",
  chat: "ask",
  question: "ask",
  implement: "agent",
  execute: "agent",
  design: "plan",
  browser: "web",
  fast: "instant",
  quick: "instant",
});

// ── Action intent schema ────────────────────────────────────────────────────

/**
 * @typedef {Object} VoiceActionIntent
 * @property {string}  action  — Dotted action name, e.g. "task.list", "agent.ask"
 * @property {Object}  params  — Action-specific parameters
 * @property {string}  [id]    — Optional correlation ID for response matching
 */

/**
 * @typedef {Object} VoiceActionResult
 * @property {boolean}     ok       — Whether the action succeeded
 * @property {string}      action   — Echo of the action name
 * @property {any}         data     — Result payload
 * @property {string|null} error    — Error message if !ok
 * @property {string}      [id]     — Correlation ID echo
 * @property {number}      durationMs — Execution time in ms
 */

// ── Action registry ─────────────────────────────────────────────────────────

/**
 * Registry of action handlers.
 * Key: action name (e.g. "task.list")
 * Value: async (params, context) => result data
 */
const ACTION_HANDLERS = {};

function registerAction(name, handler) {
  ACTION_HANDLERS[name] = handler;
}

function normalizeCandidatePath(input) {
  if (!input) return "";
  try {
    return resolvePath(String(input));
  } catch {
    return String(input || "");
  }
}

async function resolveDelegationCwd(sessionId = "") {
  const id = String(sessionId || "").trim();
  if (!id) return process.cwd();
  try {
    const tracker = await getSessionTracker();
    const session =
      tracker.getSessionById?.(id) || tracker.getSession?.(id) || null;
    const metadata = session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
    const explicit = normalizeCandidatePath(metadata?.workspaceDir);
    if (explicit && existsSync(explicit)) return explicit;
  } catch {
    // best effort
  }
  return process.cwd();
}

// ── Task actions ────────────────────────────────────────────────────────────

registerAction("task.list", async (params) => {
  const kanban = await getKanban();
  const status = String(params.status || "all").trim().toLowerCase();
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  const tasks = await kanban.listTasks(undefined, {
    status: status === "all" ? undefined : status,
  });
  const limited = Array.isArray(tasks) ? tasks.slice(0, limit) : [];
  return {
    count: limited.length,
    total: Array.isArray(tasks) ? tasks.length : 0,
    tasks: limited.map((t) => ({
      id: t.id || t.number,
      title: t.title,
      status: t.status,
      assignee: t.assignee || t.assignees?.[0] || "unassigned",
      labels: t.labels || [],
      priority: t.priority || null,
    })),
  };
});

registerAction("task.get", async (params) => {
  const kanban = await getKanban();
  const taskId = String(params.taskId || params.id || "").trim();
  if (!taskId) throw new Error("taskId is required");
  const task = await kanban.getTask(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  return {
    id: task.id || task.number,
    title: task.title,
    status: task.status,
    description: task.body || task.description || "",
    assignee: task.assignee || task.assignees?.[0] || "unassigned",
    labels: task.labels || [],
    priority: task.priority || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
});

registerAction("task.create", async (params) => {
  const kanban = await getKanban();
  const title = String(params.title || "").trim();
  if (!title) throw new Error("title is required");
  const result = await kanban.createTask(undefined, {
    title,
    body: params.description || params.body || "",
    priority: params.priority,
    labels: Array.isArray(params.labels) ? params.labels : [],
  });
  return {
    id: result.id || result.number,
    title: result.title || title,
    status: result.status || "todo",
    message: `Task created: ${result.title || title}`,
  };
});

registerAction("task.update", async (params) => {
  const kanban = await getKanban();
  const taskId = String(params.taskId || params.id || "").trim();
  if (!taskId) throw new Error("taskId is required");
  const patch = {};
  if (params.status) patch.status = params.status;
  if (params.title) patch.title = params.title;
  if (params.description) patch.description = params.description;
  if (params.priority) patch.priority = params.priority;
  if (params.labels) patch.labels = params.labels;
  if (params.assignee) patch.assignee = params.assignee;
  await kanban.updateTask(taskId, patch);
  return { taskId, updated: Object.keys(patch), message: `Task ${taskId} updated.` };
});

registerAction("task.updateStatus", async (params) => {
  const kanban = await getKanban();
  const taskId = String(params.taskId || params.id || "").trim();
  const status = String(params.status || "").trim().toLowerCase();
  if (!taskId) throw new Error("taskId is required");
  if (!status) throw new Error("status is required");
  await kanban.updateTaskStatus(taskId, status);
  return { taskId, status, message: `Task ${taskId} moved to ${status}.` };
});

registerAction("task.delete", async (params) => {
  const kanban = await getKanban();
  const taskId = String(params.taskId || params.id || "").trim();
  if (!taskId) throw new Error("taskId is required");
  await kanban.deleteTask(taskId);
  return { taskId, message: `Task ${taskId} deleted.` };
});

registerAction("task.search", async (params) => {
  const kanban = await getKanban();
  const query = String(params.query || params.q || "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  const tasks = await kanban.listTasks(undefined, {});
  const matches = (Array.isArray(tasks) ? tasks : []).filter((t) => {
    const text = `${t.title || ""} ${t.body || t.description || ""} ${(t.labels || []).join(" ")}`.toLowerCase();
    return text.includes(query.toLowerCase());
  });
  return {
    query,
    count: Math.min(matches.length, limit),
    total: matches.length,
    tasks: matches.slice(0, limit).map((t) => ({
      id: t.id || t.number,
      title: t.title,
      status: t.status,
    })),
  };
});

registerAction("task.stats", async () => {
  const kanban = await getKanban();
  const tasks = await kanban.listTasks(undefined, {});
  const all = Array.isArray(tasks) ? tasks : [];
  const byStatus = {};
  for (const t of all) {
    const s = t.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  return {
    total: all.length,
    byStatus,
    backlog: byStatus.todo || 0,
    inProgress: byStatus.inprogress || 0,
    inReview: byStatus.inreview || 0,
    done: byStatus.done || 0,
  };
});

registerAction("task.comment", async (params) => {
  const kanban = await getKanban();
  const taskId = String(params.taskId || params.id || "").trim();
  const body = String(params.body || params.comment || params.message || "").trim();
  if (!taskId) throw new Error("taskId is required");
  if (!body) throw new Error("comment body is required");
  await kanban.addComment(taskId, body);
  return { taskId, message: `Comment added to task ${taskId}.` };
});

// ── Agent delegation actions ────────────────────────────────────────────────

registerAction("agent.delegate", async (params, context) => {
  const cfg = loadConfig();
  const message = String(params.message || params.prompt || "").trim();
  if (!message) throw new Error("message is required");

  const rawExecutor = String(
    params.executor || context.executor || cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk",
  ).trim().toLowerCase();
  const executor = VALID_EXECUTORS.has(rawExecutor) ? rawExecutor : (cfg.primaryAgent || "codex-sdk");

  const rawMode = String(params.mode || context.mode || "agent").trim().toLowerCase();
  const mode = MODE_ALIASES[rawMode] || (VALID_AGENT_MODES.has(rawMode) ? rawMode : "agent");
  const model = String(params.model || context.model || "").trim() || undefined;
  const sessionId = String(context.sessionId || "").trim() || `voice-dispatch-${Date.now()}`;
  const cwd = await resolveDelegationCwd(sessionId);

  const previousAgent = getPrimaryAgentName();
  if (executor !== previousAgent) {
    setPrimaryAgent(executor);
  }

  try {
    const result = await execPrimaryPrompt(message, {
      mode,
      model,
      cwd,
      sessionId,
      scope: `voice-dispatch:${sessionId}`,
      sessionType: "voice-dispatch",
      timeoutMs: 5 * 60 * 1000,
    });
    const text = typeof result === "string"
      ? result
      : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
    const truncated = text.length > 4000 ? text.slice(0, 4000) + "... (truncated)" : text;
    return { executor, mode, response: truncated };
  } finally {
    if (executor !== previousAgent) {
      try { setPrimaryAgent(previousAgent); } catch { /* best effort */ }
    }
  }
});

registerAction("agent.ask", async (params, context) => {
  return ACTION_HANDLERS["agent.delegate"]({ ...params, mode: "ask" }, context);
});

registerAction("agent.plan", async (params, context) => {
  return ACTION_HANDLERS["agent.delegate"]({ ...params, mode: "plan" }, context);
});

registerAction("agent.code", async (params, context) => {
  return ACTION_HANDLERS["agent.delegate"]({ ...params, mode: "agent" }, context);
});

registerAction("agent.web", async (params, context) => {
  return ACTION_HANDLERS["agent.delegate"]({ ...params, mode: "web" }, context);
});

registerAction("agent.instant", async (params, context) => {
  return ACTION_HANDLERS["agent.delegate"]({ ...params, mode: "instant" }, context);
});

registerAction("agent.status", async () => {
  const name = getPrimaryAgentName();
  const mode = getAgentMode();
  return {
    activeAgent: name,
    mode,
    status: "available",
    message: `${name} is active in ${mode} mode.`,
  };
});

registerAction("agent.switch", async (params) => {
  const executor = String(params.executor || params.agent || "").trim().toLowerCase();
  if (!executor) throw new Error("executor is required");
  if (!VALID_EXECUTORS.has(executor)) {
    throw new Error(`Invalid executor: ${executor}. Valid: ${[...VALID_EXECUTORS].join(", ")}`);
  }
  const previous = getPrimaryAgentName();
  setPrimaryAgent(executor);
  return { previous, current: executor, message: `Switched from ${previous} to ${executor}.` };
});

registerAction("agent.setMode", async (params) => {
  const rawMode = String(params.mode || "").trim().toLowerCase();
  const mode = MODE_ALIASES[rawMode] || (VALID_AGENT_MODES.has(rawMode) ? rawMode : null);
  if (!mode) {
    throw new Error(`Invalid mode: ${rawMode}. Valid: ${[...VALID_AGENT_MODES].join(", ")}`);
  }
  const previous = getAgentMode();
  setAgentMode(mode);
  return { previous, current: mode, message: `Agent mode set to ${mode}.` };
});

// ── Session actions ─────────────────────────────────────────────────────────

registerAction("session.list", async (params) => {
  const tracker = await getSessionTracker();
  const includeHistory = params.includeHistory !== false;
  const sessions = tracker.listAllSessions
    ? tracker.listAllSessions()
    : (tracker.listSessions ? tracker.listSessions() : []);
  const filtered = includeHistory
    ? sessions
    : sessions.filter((session) => String(session?.status || "").toLowerCase() === "active");
  const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 100);
  const page = Math.max(Number(params.page) || 1, 1);
  const offset = (page - 1) * limit;
  const paged = filtered.slice(offset, offset + limit);
  return {
    page,
    limit,
    total: filtered.length,
    count: paged.length,
    sessions: paged.map((s) => ({
      id: s.id || s.taskId,
      type: s.type || "task",
      status: s.status,
      title: s.title || s.taskTitle || null,
      turnCount: s.turnCount || 0,
      createdAt: s.createdAt || null,
      lastActive: s.lastActiveAt || s.lastActivityAt,
      preview: s.preview || s.lastMessage || null,
    })),
  };
});

registerAction("session.history", async (params) => {
  const tracker = await getSessionTracker();
  const sessionId = String(params.sessionId || params.id || "").trim();
  if (!sessionId) throw new Error("sessionId is required");
  const session = tracker.getSessionById?.(sessionId) || tracker.getSession?.(sessionId) || null;
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 200);
  const fullTranscript = params.fullTranscript === true;
  const messages = (session.messages || []).slice(-limit);
  return {
    sessionId,
    count: messages.length,
    totalMessages: (session.messages || []).length,
    messages: messages.map((m) => ({
      role: m.role || m.type,
      content: fullTranscript
        ? m.content
        : (typeof m.content === "string" ? m.content.slice(0, 500) : String(m.content || "")),
      timestamp: m.timestamp,
    })),
  };
});

registerAction("session.create", async (params, context) => {
  const tracker = await getSessionTracker();
  const sessionId = params.id || `voice-live-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const session = tracker.createSession
    ? tracker.createSession({
        id: sessionId,
        type: params.type || "voice",
        metadata: {
          title: params.title || `Voice session ${sessionId.slice(-6)}`,
          agent: params.executor || context.executor || getPrimaryAgentName(),
          mode: params.mode || context.mode || getAgentMode(),
          source: "voice-dispatch",
          parentSessionId: context.sessionId || null,
        },
      })
    : null;
  if (!session) throw new Error("Session tracker does not support createSession");
  return {
    sessionId: session.id,
    type: session.type,
    status: session.status,
    message: `Live session ${session.id} created (direct handoff — no background queue).`,
  };
});

// ── System actions ──────────────────────────────────────────────────────────

registerAction("system.status", async () => {
  const cfg = loadConfig();
  const name = getPrimaryAgentName();
  const mode = getAgentMode();
  return {
    primaryAgent: name,
    agentMode: mode,
    kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend || "internal",
    projectName: cfg.projectName || "unknown",
    configMode: cfg.mode || "generic",
    voiceEnabled: cfg.voice?.enabled !== false,
  };
});

registerAction("system.fleet", async () => {
  try {
    const fleet = await getFleetCoordinator();
    const status = fleet.getFleetStatus ? fleet.getFleetStatus() : {};
    return status;
  } catch {
    return { message: "Fleet coordinator not available." };
  }
});

registerAction("system.config", async (params) => {
  const cfg = loadConfig();
  const key = String(params.key || "").trim();
  const normalizedConfig = {
    primaryAgent: cfg.primaryAgent || getPrimaryAgentName(),
    mode: cfg.mode || "generic",
    kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend || "internal",
    projectName: cfg.projectName || cfg.project || process.env.PROJECT_NAME || "unknown",
    autoFixEnabled: cfg.autoFixEnabled,
    watchEnabled: cfg.watchEnabled,
    voiceEnabled: cfg.voice?.enabled !== false,
  };
  if (key) {
    const value = normalizedConfig[key] ?? cfg[key];
    return value !== undefined ? { [key]: value } : { error: `Config key "${key}" not found.` };
  }
  return normalizedConfig;
});

registerAction("system.health", async () => {
  const cfg = loadConfig();
  const name = getPrimaryAgentName();
  let fleetOk = false;
  try {
    const fleet = await getFleetCoordinator();
    fleetOk = Boolean(fleet.getFleetStatus);
  } catch { /* not available */ }

  return {
    healthy: true,
    primaryAgent: name,
    fleetAvailable: fleetOk,
    uptime: process.uptime(),
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
});

// ── Workspace actions ───────────────────────────────────────────────────────

registerAction("workspace.readFile", async (params) => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const filePath = String(params.filePath || params.path || "").trim();
  if (!filePath) throw new Error("filePath is required");
  const fullPath = resolve(process.cwd(), filePath);
  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n");
  const start = Math.max((Number(params.startLine) || 1) - 1, 0);
  const end = Number(params.endLine) || lines.length;
  const slice = lines.slice(start, end).join("\n");
  return {
    filePath,
    lineCount: end - start,
    content: slice.length > 4000 ? slice.slice(0, 4000) + "\n... (truncated)" : slice,
  };
});

registerAction("workspace.listDir", async (params) => {
  const { readdirSync, statSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const dirPath = String(params.path || params.dir || ".").trim();
  const fullPath = resolve(process.cwd(), dirPath);
  const entries = readdirSync(fullPath).slice(0, 100);
  return {
    path: dirPath,
    entries: entries.map((name) => {
      try {
        const isDir = statSync(join(fullPath, name)).isDirectory();
        return { name, type: isDir ? "directory" : "file" };
      } catch {
        return { name, type: "unknown" };
      }
    }),
  };
});

registerAction("workspace.search", async (params) => {
  const { execSync } = await import("node:child_process");
  const query = String(params.query || params.q || "").trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(Number(params.maxResults) || 20, 1), 100);
  const filePattern = params.filePattern ? `--include="${params.filePattern}"` : "";
  try {
    const result = execSync(
      `grep -rn ${filePattern} "${query}" . --max-count=${limit} 2>/dev/null || true`,
      { encoding: "utf8", timeout: 10_000, cwd: process.cwd() },
    );
    const lines = result.trim().split("\n").filter(Boolean);
    return { query, count: lines.length, matches: lines.slice(0, limit) };
  } catch {
    return { query, count: 0, matches: [] };
  }
});

// ── MCP tool passthrough ────────────────────────────────────────────────────

registerAction("tool.call", async (params, context) => {
  const toolName = String(params.toolName || params.name || "").trim();
  if (!toolName) throw new Error("toolName is required");
  const toolArgs = params.args || params.arguments || {};
  const sessionId = String(context?.sessionId || "").trim();
  const turnId = String(context?.turnId || "").trim();
  if (sessionId && turnId) {
    appendVoiceTurnTraceEvent(sessionId, {
      turnId,
      type: "tool.dispatch",
      toolName,
    });
  }
  const { executeToolCall } = await import("./voice-tools.mjs");
  try {
    const result = await executeToolCall(toolName, toolArgs, context);
    if (sessionId && turnId) {
      appendVoiceTurnTraceEvent(sessionId, {
        turnId,
        type: "tool.complete",
        toolName,
      });
    }
    return result;
  } catch (err) {
    if (sessionId && turnId) {
      appendVoiceTurnTraceEvent(sessionId, {
        turnId,
        type: "tool.error",
        toolName,
        reason: "tool_error",
        detail: err?.message,
      });
    }
    throw err;
  }
});

// ── Workflow actions ────────────────────────────────────────────────────────

registerAction("workflow.list", async () => {
  const wf = await getWorkflowTemplates();
  const templates = wf.listTemplates ? wf.listTemplates() : [];
  return {
    count: templates.length,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name || t.id,
      description: t.description || "",
    })),
  };
});

registerAction("workflow.get", async (params) => {
  const wf = await getWorkflowTemplates();
  const id = String(params.id || params.templateId || "").trim();
  if (!id) throw new Error("workflow template id is required");
  const template = wf.getTemplate ? wf.getTemplate(id) : null;
  if (!template) throw new Error(`Workflow template "${id}" not found`);
  return {
    id: template.id,
    name: template.name || template.id,
    description: template.description || "",
    steps: template.steps || template.nodes || [],
  };
});

registerAction("workflow.saved_list", async () => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.list) throw new Error("Workflow engine is unavailable");
  const workflows = engine.list();
  return {
    count: Array.isArray(workflows) ? workflows.length : 0,
    workflows: (Array.isArray(workflows) ? workflows : []).map((workflow) => ({
      id: workflow?.id || null,
      name: workflow?.name || workflow?.id || null,
      enabled: workflow?.enabled !== false,
      triggerCount: Array.isArray(workflow?.triggers) ? workflow.triggers.length : 0,
      nodeCount: Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0,
      edgeCount: Array.isArray(workflow?.edges) ? workflow.edges.length : 0,
      updatedAt: workflow?.updatedAt || null,
    })),
  };
});

registerAction("workflow.runs", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.getRunHistory) throw new Error("Workflow run history is unavailable");
  const workflowId = String(params.workflowId || params.id || "").trim() || null;
  const rawLimit = Number(params.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(200, Math.floor(rawLimit))
    : 20;
  const statusFilter = String(params.status || "").trim().toLowerCase();
  let runs = engine.getRunHistory(workflowId, limit);
  runs = Array.isArray(runs) ? runs : [];
  if (statusFilter) {
    runs = runs.filter((run) => String(run?.status || "").trim().toLowerCase() === statusFilter);
  }
  return {
    count: runs.length,
    runs: runs.map((run) => ({
      runId: run?.runId || null,
      workflowId: run?.workflowId || null,
      workflowName: run?.workflowName || null,
      status: run?.status || "unknown",
      startedAt: run?.startedAt || null,
      endedAt: run?.endedAt ?? null,
      duration: run?.duration ?? null,
      errorCount: run?.errorCount ?? 0,
      logCount: run?.logCount ?? 0,
      isStuck: run?.isStuck === true,
      triggerEvent: run?.triggerEvent || null,
      triggerSource: run?.triggerSource || null,
    })),
  };
});

registerAction("workflow.run_get", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.getRunDetail) throw new Error("Workflow run detail is unavailable");
  const runId = String(params.runId || params.id || "").trim();
  if (!runId) throw new Error("runId is required");
  const run = engine.getRunDetail(runId);
  if (!run) throw new Error(`Workflow run "${runId}" not found`);
  return run;
});

registerAction("workflow.save", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.save) throw new Error("Workflow engine is unavailable");
  const def = params?.definition;
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new Error("definition object is required");
  }
  const workflowId = String(params.workflowId || def.id || "").trim();
  const payload = { ...def };
  if (workflowId) payload.id = workflowId;
  if (!Array.isArray(payload.nodes)) payload.nodes = [];
  if (!Array.isArray(payload.edges)) payload.edges = [];
  if (!payload.name) payload.name = payload.id || "Voice Workflow";
  const saved = engine.save(payload);
  return {
    id: saved.id,
    name: saved.name || saved.id,
    enabled: saved.enabled !== false,
    nodeCount: Array.isArray(saved.nodes) ? saved.nodes.length : 0,
    edgeCount: Array.isArray(saved.edges) ? saved.edges.length : 0,
  };
});

registerAction("workflow.delete", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.delete) throw new Error("Workflow engine is unavailable");
  const workflowId = String(params.workflowId || params.id || "").trim();
  if (!workflowId) throw new Error("workflowId is required");
  const deleted = await engine.delete(workflowId);
  return { ok: Boolean(deleted), workflowId };
});

registerAction("workflow.execute", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.execute) throw new Error("Workflow engine is unavailable");
  const workflowId = String(params.workflowId || params.id || "").trim();
  if (!workflowId) throw new Error("workflowId is required");
  const input = params?.input && typeof params.input === "object" ? params.input : {};
  const force = params?.force === true;
  const ctx = await engine.execute(workflowId, input, { force });
  return {
    runId: ctx?.id || null,
    workflowId,
    status: Array.isArray(ctx?.errors) && ctx.errors.length > 0 ? "failed" : "completed",
    errorCount: Array.isArray(ctx?.errors) ? ctx.errors.length : 0,
  };
});

registerAction("workflow.retry", async (params) => {
  const wfEngineMod = await getWorkflowEngineModule();
  const engine = typeof wfEngineMod.getWorkflowEngine === "function"
    ? wfEngineMod.getWorkflowEngine()
    : null;
  if (!engine?.retryRun) throw new Error("Workflow retry is unavailable");
  const runId = String(params.runId || params.id || "").trim();
  if (!runId) throw new Error("runId is required");
  const mode = String(params.mode || "from_failed").trim().toLowerCase() === "from_scratch"
    ? "from_scratch"
    : "from_failed";
  const currentRun = engine?.getRunDetail ? engine.getRunDetail(runId) : null;
  if (!currentRun) throw new Error(`Workflow run "${runId}" not found`);
  const currentStatus = String(currentRun?.status || "").trim().toLowerCase();
  const retryOptions = typeof engine.getRetryOptions === "function"
    ? engine.getRetryOptions(runId)
    : null;
  const safeInterruptedResume =
    mode === "from_failed" &&
    retryOptions?.guardedState?.code === "create_tasks_pending" &&
    retryOptions?.guardedState?.safeResume === true &&
    retryOptions?.recommendedMode === "from_failed";
  const createTasksPendingGuard = retryOptions?.guardedState?.code === "create_tasks_pending";
  if (mode === "from_failed" && currentStatus !== "failed" && !createTasksPendingGuard) {
    throw new Error(`retry mode "from_failed" requires a failed run (current=${currentRun?.status || "unknown"})`);
  }
  const resolvedRetry = safeInterruptedResume
    ? {
        mode,
        operatorAction: "resume",
        decisionReason: retryOptions?.recommendedReason || "create_tasks_pending.resume_only",
        blocked: false,
        guardedState: retryOptions?.guardedState || null,
        retryArgs: {
          mode,
          _resumeInterrupted: true,
          ...(retryOptions?.recommendedReason
            ? { _decisionReason: retryOptions.recommendedReason }
            : {}),
        },
      }
    : (
        createTasksPendingGuard && typeof engine.resolveOperatorRetry === "function"
          ? engine.resolveOperatorRetry(runId, mode)
          : null
      );
  if (resolvedRetry?.blocked) {
    throw new Error(resolvedRetry.blockedMessage || "Workflow retry is blocked for this run state.");
  }
  const retryArgs = resolvedRetry?.retryArgs || { mode };
  if (safeInterruptedResume && !resolvedRetry?.retryArgs) {
    retryArgs._resumeInterrupted = true;
    if (retryOptions?.recommendedReason) retryArgs._decisionReason = retryOptions.recommendedReason;
  }
  const result = await engine.retryRun(runId, retryArgs);
  return {
    ...result,
    operatorAction:
      resolvedRetry?.operatorAction || (mode === "from_scratch" ? "restart" : "retry"),
    decisionReason: resolvedRetry?.decisionReason || null,
    guardedState: resolvedRetry?.guardedState || retryOptions?.guardedState || null,
  };
});

// ── Skill/prompt actions ────────────────────────────────────────────────────

registerAction("skill.list", async () => {
  const skills = await getBosunSkills();
  const builtins = skills.BUILTIN_SKILLS || [];
  return {
    count: builtins.length,
    skills: builtins.map((s) => ({
      filename: s.filename,
      title: s.title,
      tags: s.tags || [],
      scope: s.scope || "global",
    })),
  };
});

registerAction("prompt.list", async () => {
  const prompts = await getAgentPrompts();
  const defs = prompts.getAgentPromptDefinitions
    ? prompts.getAgentPromptDefinitions()
    : prompts.AGENT_PROMPT_DEFINITIONS || [];
  return {
    count: defs.length,
    prompts: defs.map((d) => ({
      key: d.key,
      filename: d.filename,
      description: d.description || "",
    })),
  };
});

registerAction("prompt.get", async (params) => {
  const prompts = await getAgentPrompts();
  const key = String(params.key || params.name || "").trim();
  if (!key) throw new Error("prompt key is required");
  const content = prompts.getDefaultPromptTemplate
    ? prompts.getDefaultPromptTemplate(key)
    : "";
  if (!content) throw new Error(`Prompt "${key}" not found`);
  const truncated = content.length > 3000 ? content.slice(0, 3000) + "\n... (truncated)" : content;
  return { key, content: truncated };
});

// ── Batch action support ────────────────────────────────────────────────────

registerAction("batch", async (params, context) => {
  const actions = Array.isArray(params.actions) ? params.actions : [];
  if (!actions.length) throw new Error("actions array is required");
  if (actions.length > 10) throw new Error("Maximum 10 actions per batch");
  const results = await dispatchVoiceActions(actions, context);
  return { count: results.length, results };
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * List all registered action names.
 * @returns {string[]}
 */
export function listAvailableActions() {
  return Object.keys(ACTION_HANDLERS).sort();
}

/**
 * Check if an action is registered.
 * @param {string} action
 * @returns {boolean}
 */
export function hasAction(action) {
  return Boolean(ACTION_HANDLERS[String(action || "").trim()]);
}

/**
 * Get a descriptive manifest of all available actions for prompt injection.
 * @returns {Array<{ action: string, description: string }>}
 */
export function getActionManifest() {
  return [
    { action: "task.list", description: "List tasks from the kanban board. params: { status?, limit? }" },
    { action: "task.get", description: "Get task details. params: { taskId }" },
    { action: "task.create", description: "Create a new task. params: { title, description?, priority?, labels? }" },
    { action: "task.update", description: "Update task fields. params: { taskId, status?, title?, priority?, labels? }" },
    { action: "task.updateStatus", description: "Move task to a new status. params: { taskId, status }" },
    { action: "task.delete", description: "Delete a task. params: { taskId }" },
    { action: "task.search", description: "Search tasks by text. params: { query, limit? }" },
    { action: "task.stats", description: "Get task statistics. params: {}" },
    { action: "task.comment", description: "Add a comment to a task. params: { taskId, body }" },
    { action: "agent.delegate", description: "Delegate work to an agent. params: { message, executor?, mode?, model? }" },
    { action: "agent.ask", description: "Ask an agent a question (read-only). params: { message, executor? }" },
    { action: "agent.plan", description: "Ask an agent to create a plan. params: { message, executor? }" },
    { action: "agent.code", description: "Ask an agent to write/modify code. params: { message, executor? }" },
    { action: "agent.status", description: "Get active agent status. params: {}" },
    { action: "agent.switch", description: "Switch the primary agent. params: { executor }" },
    { action: "agent.web", description: "Ask for web-style concise response. params: { message, executor?, model? }" },
    { action: "agent.instant", description: "Ask for instant fast back-and-forth response. params: { message, executor?, model? }" },
    { action: "agent.setMode", description: "Set agent interaction mode. params: { mode: ask|agent|plan|web|instant }" },
    { action: "session.list", description: "List active sessions. params: { limit? }" },
    { action: "session.history", description: "Get session message history. params: { sessionId, limit? }" },
    { action: "session.create", description: "Create a new session. params: { type?, executor? }" },
    { action: "system.status", description: "Get system status. params: {}" },
    { action: "system.fleet", description: "Get fleet coordination status. params: {}" },
    { action: "system.config", description: "Get config values. params: { key? }" },
    { action: "system.health", description: "Get system health. params: {}" },
    { action: "workspace.readFile", description: "Read a file. params: { filePath, startLine?, endLine? }" },
    { action: "workspace.listDir", description: "List directory contents. params: { path? }" },
    { action: "workspace.search", description: "Search code. params: { query, filePattern?, maxResults? }" },
    { action: "tool.call", description: "Call a registered tool by name. params: { toolName, args }" },
    { action: "workflow.list", description: "List workflow templates. params: {}" },
    { action: "workflow.get", description: "Get a workflow template. params: { id }" },
    { action: "workflow.saved_list", description: "List installed workflow definitions. params: {}" },
    { action: "workflow.runs", description: "List workflow run history. params: { workflowId?, status?, limit? }" },
    { action: "workflow.run_get", description: "Get a workflow run detail. params: { runId }" },
    { action: "workflow.save", description: "Create/update a workflow definition. params: { workflowId?, definition }" },
    { action: "workflow.delete", description: "Delete a workflow definition. params: { workflowId }" },
    { action: "workflow.execute", description: "Execute a workflow now. params: { workflowId, input?, force? }" },
    { action: "workflow.retry", description: "Retry a workflow run. params: { runId, mode?: from_failed|from_scratch }" },
    { action: "skill.list", description: "List available skills. params: {}" },
    { action: "prompt.list", description: "List agent prompt definitions. params: {}" },
    { action: "prompt.get", description: "Get a prompt template. params: { key }" },
    { action: "batch", description: "Execute multiple actions. params: { actions: [{ action, params }] }" },
  ];
}

function ensureDispatchTraceContext(context = {}) {
  const sessionId = String(context?.sessionId || "").trim();
  const existingTurnId = String(context?.turnId || "").trim();
  if (!sessionId || (context?.traceTurns !== true && !existingTurnId)) {
    return { traceEnabled: false, sessionId: "", turnId: null, autoTurn: false };
  }
  if (existingTurnId) {
    return { traceEnabled: true, sessionId, turnId: existingTurnId, autoTurn: false };
  }
  const started = beginVoiceTurnTrace(sessionId, {
    transport: context?.transport,
    phase: context?.phase,
    source: "voice-action-dispatch",
    mode: context?.mode,
    model: context?.model,
  });
  return { traceEnabled: true, sessionId, turnId: started?.turnId || null, autoTurn: true };
}

function recordDispatchTrace(traceContext, event = {}) {
  if (!traceContext?.traceEnabled || !traceContext?.turnId) return;
  appendVoiceTurnTraceEvent(traceContext.sessionId, { ...event, turnId: traceContext.turnId });
}

function finishDispatchTrace(traceContext, details = {}) {
  if (!traceContext?.autoTurn || !traceContext?.turnId) return;
  completeVoiceTurnTrace(traceContext.sessionId, {
    turnId: traceContext.turnId,
    outcome: details?.outcome || "completed",
  });
}

function getDispatchFingerprint(intent = {}) {
  const action = String(intent?.action || "").trim();
  const correlationId = String(intent?.id || "").trim();
  if (correlationId) return `id:${correlationId}`;
  try {
    return `hash:${createHash("sha256").update(`${action}:${JSON.stringify(intent?.params || {})}`).digest("hex")}`;
  } catch {
    return `hash:${createHash("sha256").update(`${action}:${String(intent?.params || "")}`).digest("hex")}`;
  }
}

function hasPriorDispatchForFingerprint(traceContext, fingerprint) {
  if (!traceContext?.traceEnabled || !traceContext?.turnId || !fingerprint) return false;
  const normalizedFingerprint = String(fingerprint).trim();
  // Only treat id-based fingerprints as eligible for duplicate suppression.
  // This allows legitimate retries when the model re-issues an action without a new `id`.
  if (!normalizedFingerprint.startsWith("id:")) return false;
  const trace = getVoiceTurnTraceState(traceContext.sessionId, { turnId: traceContext.turnId });
  const turn = trace?.turns?.[0];
  if (!turn) return false;
  return (turn.events || []).some((event) => {
    const eventFingerprint = String(event?.fingerprint || "").trim();
    return eventFingerprint === normalizedFingerprint && event?.type !== "turn.start";
  });
}

/**
 * Dispatch a voice action intent and return structured results.
 *
 * The voice model can return JSON like:
 *   { "action": "task.list", "params": { "status": "todo" } }
 *
 * Bosun processes this directly via JavaScript and returns:
 *   { "ok": true, "action": "task.list", "data": { "count": 5, "tasks": [...] } }
 *
 * @param {VoiceActionIntent} intent — { action, params, id? }
 * @param {Object} context — { sessionId, executor, mode, model, userId }
 * @returns {Promise<VoiceActionResult>}
 */
export async function dispatchVoiceAction(intent, context = {}) {
  const startMs = Date.now();
  const action = String(intent?.action || "").trim();
  const params = intent?.params || {};
  const correlationId = intent?.id || null;
  const traceContext = ensureDispatchTraceContext(context);

  if (!action) {
    recordDispatchTrace(traceContext, { type: "action.mismatch", reason: "missing_action" });
    finishDispatchTrace(traceContext, { outcome: "mismatch" });
    return {
      ok: false,
      action: "",
      data: null,
      error: "action is required",
      id: correlationId,
      durationMs: Date.now() - startMs,
    };
  }

  const handler = ACTION_HANDLERS[action];
  const fingerprint = getDispatchFingerprint(intent);
  if (hasPriorDispatchForFingerprint(traceContext, fingerprint)) {
    recordDispatchTrace(traceContext, {
      type: "action.skip",
      action,
      id: correlationId,
      reason: "duplicate_dispatch",
      fingerprint,
    });
    finishDispatchTrace(traceContext, { outcome: "duplicate_skipped" });
    return {
      ok: false,
      action,
      data: null,
      error: `Duplicate action skipped: ${action || fingerprint}`,
      id: correlationId,
      durationMs: Date.now() - startMs,
    };
  }

  if (!handler) {
    recordDispatchTrace(traceContext, {
      type: "action.mismatch",
      action,
      id: correlationId,
      reason: "unknown_action",
      fingerprint,
    });
    finishDispatchTrace(traceContext, { outcome: "mismatch" });
    return {
      ok: false,
      action,
      data: null,
      error: `Unknown action: ${action}. Available: ${listAvailableActions().join(", ")}`,
      id: correlationId,
      durationMs: Date.now() - startMs,
    };
  }

  recordDispatchTrace(traceContext, { type: "action.dispatch", action, id: correlationId, fingerprint });
  try {
    const data = await handler(params, traceContext.traceEnabled ? { ...context, turnId: traceContext.turnId } : context);
    const durationMs = Date.now() - startMs;
    recordDispatchTrace(traceContext, { type: "action.complete", action, id: correlationId, durationMs, fingerprint });
    finishDispatchTrace(traceContext, { outcome: "completed" });
    return {
      ok: true,
      action,
      data,
      error: null,
      id: correlationId,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startMs;
    console.error("[voice-action-dispatcher] %s error: %s", String(action || "unknown"), String(err?.message || err || "unknown"));
    recordDispatchTrace(traceContext, {
      type: "action.error",
      action,
      id: correlationId,
      reason: "handler_error",
      detail: err?.message,
      durationMs,
      fingerprint,
    });
    finishDispatchTrace(traceContext, { outcome: "error" });
    return {
      ok: false,
      action,
      data: null,
      error: err.message,
      id: correlationId,
      durationMs,
    };
  }
}

/**
 * Process a batch of voice action intents sequentially.
 * @param {VoiceActionIntent[]} intents
 * @param {Object} context
 * @returns {Promise<VoiceActionResult[]>}
 */
export async function dispatchVoiceActions(intents, context = {}) {
  if (!Array.isArray(intents)) return [];
  const limited = intents.slice(0, 20);
  const traceContext = ensureDispatchTraceContext(context);
  if (!traceContext.traceEnabled) {
    return Promise.all(limited.map((intent) => dispatchVoiceAction(intent, context)));
  }

  const tracedContext = { ...context, traceTurns: true, turnId: traceContext.turnId };
  const seenFingerprints = new Set();
  const results = [];
  for (const intent of limited) {
    const fingerprint = getDispatchFingerprint(intent);
    if (seenFingerprints.has(fingerprint)) {
      const action = String(intent?.action || "").trim();
      const correlationId = intent?.id || null;
      recordDispatchTrace(traceContext, {
        type: "action.skip",
        action,
        id: correlationId,
        reason: "duplicate_dispatch",
        fingerprint,
      });
      results.push({
        ok: false,
        action,
        data: null,
        error: `Duplicate action skipped: ${action || fingerprint}`,
        id: correlationId,
        durationMs: 0,
      });
      continue;
    }
    seenFingerprints.add(fingerprint);
    results.push(await dispatchVoiceAction(intent, tracedContext));
  }
  finishDispatchTrace(traceContext, {
    outcome: results.some((result) => result?.ok === false) ? "completed_with_errors" : "completed",
  });
  return results;
}

/**
 * Generate the system prompt section describing available actions for the voice model.
 * This is injected into the voice agent's instructions so it knows what actions
 * it can return as JSON.
 *
 * @returns {string}
 */
export function getVoiceActionPromptSection() {
  const manifest = getActionManifest();
  const lines = [
    "",
    "## Available Bosun Actions",
    "",
    "You can perform any of these actions by returning a JSON object with the following structure:",
    "",
    "```json",
    '{ "action": "<action_name>", "params": { ... } }',
    "```",
    "",
    "Actions:",
    "",
  ];
  for (const entry of manifest) {
    lines.push(`- **${entry.action}** — ${entry.description}`);
  }
  lines.push("");
  lines.push("For multiple actions at once, use the batch action:");
  lines.push("");
  lines.push("```json");
  lines.push('{ "action": "batch", "params": { "actions": [');
  lines.push('  { "action": "task.stats", "params": {} },');
  lines.push('  { "action": "agent.status", "params": {} }');
  lines.push("] } }");
  lines.push("```");
  lines.push("");
  lines.push("When I ask about tasks, agents, or system state, use these actions to get real data.");
  lines.push("Return the JSON action object, and I will process it and give you the results.");
  lines.push("Then speak the results to the user naturally.");
  lines.push("");
  return lines.join("\n");
}
