/**
 * voice-tools.mjs — Voice-callable tools for the Realtime API.
 *
 * Each tool mirrors a bosun API endpoint or system operation.
 * Tools use OpenAI function-calling schema.
 *
 * @module voice-tools
 */

import { loadConfig } from "../config/config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName, setPrimaryAgent, getAgentMode, setAgentMode } from "../agent/primary-agent.mjs";
import { getBosunSessionManager } from "../agent/session-manager.mjs";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveAgentRepoRoot } from "../config/repo-root.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { getVisionSessionState } from "./vision-session-state.mjs";
import { TOOL_DEFS } from "./voice-tool-definitions.mjs";
import { injectToolResultContext } from "../workspace/context-injector.mjs";
import * as projectDetection from "../workflow/project-detection.mjs";
const { resolveManagedWorktreeCommand } = projectDetection;

// ── Voice response shaping (inspired by claude-phone VOICE_CONTEXT pattern) ──

/**
 * Injected as a preamble into every ask_agent_context prompt so the agent
 * returns TTS-ready responses.  The markers are identical to claude-phone's
 * convention so responses composed by any Claude-family executor are
 * automatically shaped for spoken delivery.
 */
const VOICE_CONTEXT_PREAMBLE = `[VOICE CONTEXT]
This query comes from a voice call. Respond concisely and conversationally.
PREFER: VOICE_RESPONSE: [your answer in 2 sentences, ≤40 words — this is what gets spoken]
For code results or lists, summarise the key finding verbally instead of dumping raw output.
[END VOICE CONTEXT]

`;

/**
 * Regular expressions for commands that are considered safe to execute
 * directly in the workspace shell. Shared so they can be maintained and
 * potentially tested independently of the call site.
 */
const SAFE_WORKSPACE_COMMAND_PATTERNS = [
  /^git\s+(status|log|diff\s|show\s|branch|remote|tag|stash\s+list|ls-files|rev-parse|shortlog|describe)\b/i,
  /^git\s+diff$/i,
  /^git\s+log$/i,
  /^npm\s+(test|run\s+(test|lint|build|check)|ls|audit)\b/i,
  /^node\s+(--version|-v)$/i,
  /^npm\s+(--version|-v)$/i,
  /^ls(\s|$)/i,
  /^cat\s+/i,
  /^head\s+/i,
  /^tail(\s|$)/i,
  /^wc(\s|$)/i,
  /^find\s+/i,
  /^grep(\s|$)/i,
  /^echo\s+/i,
  /^pwd$/i,
  /^which\s+/i,
  /^type\s+/i,
];

function tokenizeWorkspaceCommand(rawCmd) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < rawCmd.length; index += 1) {
    const char = rawCmd[index];

    if (quote) {
      if (char === "\\") {
        const next = rawCmd[index + 1];
        if (next === quote || next === "\\") {
          current += next;
          index += 1;
          continue;
        }
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return {
      error: "Unterminated quoted string in workspace command.",
      tokens: [],
    };
  }

  if (current) {
    tokens.push(current);
  }

  return { error: null, tokens };
}

function isWorkspaceVerificationCommand(commandName, cmdArgs = []) {
  const normalizedCommand = String(commandName || "").trim().toLowerCase();
  const normalizedArgs = (Array.isArray(cmdArgs) ? cmdArgs : []).map((arg) =>
    String(arg || "").trim().toLowerCase()
  );
  const firstArg = normalizedArgs[0] || "";
  const secondArg = normalizedArgs[1] || "";
  return (
    (normalizedCommand === "npm"
      && (
        firstArg === "test"
        || (firstArg === "run" && (secondArg === "test" || secondArg === "build" || secondArg === "check"))
      ))
    || (normalizedCommand === "node"
      && normalizedArgs.some((arg) =>
        arg.includes("vitest")
        || arg.includes("syntax-check")
      ))
  );
}

function describeWorkspaceCommandNoOutput(commandName, cmdArgs = []) {
  const normalizedCommand = String(commandName || "").trim().toLowerCase();
  const normalizedArgs = (Array.isArray(cmdArgs) ? cmdArgs : []).map((arg) =>
    String(arg || "").trim().toLowerCase()
  );
  const firstArg = normalizedArgs[0] || "";
  if (normalizedCommand === "git" && firstArg === "status") {
    return "Command completed with no output. For `git status`, this usually means the workspace is clean.";
  }
  if (normalizedCommand === "git" && firstArg === "diff") {
    return "Command completed with no output. For `git diff`, this usually means there is no diff for the requested paths.";
  }
  if (isWorkspaceVerificationCommand(commandName, cmdArgs)) {
    return "Command completed successfully with no output. Exit status 0 is still a usable pass/fail artifact for this test or build command.";
  }
  return "Command completed with no output. Run one command per tool call and use a direct test or build command when you need a pass/fail artifact.";
}

function describeWorkspaceCommandTruncatedOutput(commandName, cmdArgs = [], output = "") {
  const trimmed = String(output || "").trim();
  if (!trimmed) return describeWorkspaceCommandNoOutput(commandName, cmdArgs);
  if (!isWorkspaceVerificationCommand(commandName, cmdArgs)) {
    return `${trimmed.slice(0, 3000)}\n… (truncated)`;
  }
  const headChars = 1800;
  const tailChars = 900;
  const head = trimmed.slice(0, headChars).trimEnd();
  const tail = trimmed.slice(-tailChars).trimStart();
  const excerpts = [];
  if (head) excerpts.push(head);
  if (tail && tail !== head) excerpts.push(`...\n${tail}`);
  return [
    "Command completed successfully, but the output exceeded the inline limit.",
    "Exit status 0 is still a usable pass/fail artifact for this test or build command.",
    "",
    excerpts.join("\n"),
  ].join("\n").trim();
}

/**
 * Extract the TTS-ready fragment from an agent response.
 *
 * Priority:
 *   1. Content after a `VOICE_RESPONSE:` (or `🗣️ VOICE_RESPONSE:`) marker.
 *   2. First non-empty sentence (≤120 words) with code fences stripped.
 *
 * Always returns a plain string safe for TTS without backtick escaping.
 */
function formatVoiceToolResult(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;

  // 1) Honour explicit VOICE_RESPONSE: marker (claude-phone convention)
  const markerMatch = raw.match(/(?:🗣️\s*)?VOICE_RESPONSE:\s*([^\n]+)/i);
  if (markerMatch) {
    return markerMatch[1].trim();
  }

  // 2) Strip markdown: code fences, inline code, bullet markers
  const stripped = raw
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/^[#>*-]+ /gm, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .trim();

  // 3) Truncate to a maximum of 100 words for spoken clarity
  const words = stripped.split(/\s+/);
  if (words.length <= 100) return stripped;
  return words.slice(0, 100).join(" ") + "…";
}

const DELEGATE_NO_OUTPUT_PLACEHOLDERS = new Set([
  "",
  "(agent completed with no text output)",
  "(resumed - no text output)",
  "(resumed — no text output)",
  "continued",
  "model response continued",
  "turn completed",
  "session completed",
]);

function extractDelegateResultText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  return String(
    result.finalResponse
      || result.output
      || result.text
      || result.message
      || result.error
      || "",
  ).trim();
}

function hasMeaningfulDelegateResult(result) {
  const output = extractDelegateResultText(result).replace(/\s+/g, " ").trim().toLowerCase();
  if (!DELEGATE_NO_OUTPUT_PLACEHOLDERS.has(output)) return true;
  if (Array.isArray(result?.items) && result.items.length > 0) return true;
  return false;
}

function isDelegatedToolSession(context = {}) {
  const sessionType = String(context?.sessionType || "").trim().toLowerCase();
  return sessionType === "delegate" || sessionType.endsWith("-delegate");
}

function isDelegatedLiveSessionContext(context = {}) {
  const sessionIds = [
    context?.sessionId,
    context?.parentSessionId,
    context?.rootSessionId,
  ].map((value) => String(value || "").trim().toLowerCase());
  return sessionIds.some((value) => value.startsWith("delegate-live-"));
}

function normalizeDelegateSessionResult(result) {
  if (typeof result === "string") {
    return {
      success: !DELEGATE_NO_OUTPUT_PLACEHOLDERS.has(result.replace(/\s+/g, " ").trim().toLowerCase()),
      output: result,
      status: "completed",
    };
  }
  if (!result || typeof result !== "object") {
    return {
      success: false,
      output: "",
      status: "no_output",
      blockedReason: "no_output",
      error: "(Agent completed with no text output)",
    };
  }
  if (result.success !== true) return result;
  if (hasMeaningfulDelegateResult(result)) return result;
  const placeholder = extractDelegateResultText(result) || "(Agent completed with no text output)";
  return {
    ...result,
    success: false,
    status: String(result.status || "").trim() || "no_output",
    blockedReason: String(result.blockedReason || "").trim() || "no_output",
    error: String(result.error || "").trim() || placeholder,
    output: String(result.output || "").trim() || placeholder,
  };
}

// ── Module-scope lazy imports ───────────────────────────────────────────────

let _kanbanAdapter = null;
let _sessionTracker = null;
let _fleetCoordinator = null;
let _agentSupervisor = null;
let _sharedStateManager = null;
let _agentPool = null;
let _workflowEngine = null;

const VALID_EXECUTORS = new Set([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
  "openai-native",
]);
const VALID_AGENT_MODES = new Set(["ask", "agent", "plan", "web", "instant"]);
const MODE_ALIASES = Object.freeze({
  code: "agent",
  architect: "plan",
  design: "plan",
  chat: "ask",
  question: "ask",
  fast: "instant",
  quick: "instant",
  browser: "web",
});

function normalizeVoiceExecutor(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (VALID_EXECUTORS.has(raw)) return raw;
  if (raw === "codex") return "codex-sdk";
  if (raw === "copilot") return "copilot-sdk";
  if (raw === "claude") return "claude-sdk";
  if (raw === "gemini") return "gemini-sdk";
  if (raw === "opencode") return "opencode-sdk";
  if (
    raw === "openai-native"
    || raw === "openai_native"
    || raw === "azure"
    || raw === "azure-openai"
    || raw === "azure-openai-responses"
    || raw === "openai-responses"
  ) {
    return "openai-native";
  }
  return raw;
}

function resolveManagedSessionExecutor(context = {}) {
  const manager = typeof getBosunSessionManager === "function" ? getBosunSessionManager() : null;
  if (!manager || typeof manager.getSession !== "function") return "";
  const sessionIds = [
    context?.sessionId,
    context?.parentSessionId,
    context?.rootSessionId,
    context?.threadId,
  ];
  for (const sessionId of sessionIds) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) continue;
    const session = manager.getSession(normalizedSessionId);
    if (!session || typeof session !== "object") continue;
    const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
    const activeWorker = session.activeWorker && typeof session.activeWorker === "object"
      ? session.activeWorker
      : {};
    const candidates = [
      activeWorker.providerSelection,
      activeWorker.adapterName,
      metadata.providerSelection,
      metadata.adapterName,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeVoiceExecutor(candidate);
      if (VALID_EXECUTORS.has(normalized)) {
        return normalized;
      }
    }
  }
  return "";
}

function cloneVoiceProviderConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(JSON.stringify(value));
}

function resolveManagedSessionProviderDetails(context = {}) {
  const manager = typeof getBosunSessionManager === "function" ? getBosunSessionManager() : null;
  if (!manager || typeof manager.getSession !== "function") {
    return {
      providerSelection: "",
      providerId: "",
      providerConfig: null,
      model: "",
    };
  }
  const sessionIds = [
    context?.sessionId,
    context?.parentSessionId,
    context?.rootSessionId,
    context?.threadId,
  ];
  for (const sessionId of sessionIds) {
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) continue;
    const session = manager.getSession(normalizedSessionId);
    if (!session || typeof session !== "object") continue;
    const metadata = session.metadata && typeof session.metadata === "object" ? session.metadata : {};
    const activeWorker = session.activeWorker && typeof session.activeWorker === "object"
      ? session.activeWorker
      : {};
    const providerConfig =
      cloneVoiceProviderConfig(activeWorker.providerConfig)
      || cloneVoiceProviderConfig(metadata.providerConfig)
      || null;
    const providerSelectionCandidates = [
      providerConfig?.selectionId,
      activeWorker.providerSelection,
      metadata.providerSelection,
      activeWorker.providerId,
      metadata.providerId,
      providerConfig?.provider,
      providerConfig?.providerId,
    ];
    const providerIdCandidates = [
      activeWorker.providerId,
      metadata.providerId,
      providerConfig?.provider,
      providerConfig?.providerId,
    ];
    const providerSelection = providerSelectionCandidates
      .map((candidate) => String(candidate || "").trim())
      .find((candidate) => candidate && candidate !== "openai-native" && candidate !== "codex-sdk")
      || "";
    const providerId = providerIdCandidates
      .map((candidate) => String(candidate || "").trim())
      .find(Boolean)
      || "";
    const model = String(
      providerConfig?.model
      || activeWorker.model
      || metadata.model
      || context?.model
      || "",
    ).trim();
    return {
      providerSelection,
      providerId,
      providerConfig,
      model,
    };
  }
  return {
    providerSelection: "",
    providerId: "",
    providerConfig: null,
    model: "",
  };
}

function resolveVoiceExecutor({
  requestedExecutor,
  context = {},
  cfg = {},
  pool = null,
  preferPoolExecutor = false,
} = {}) {
  const poolExecutor = typeof pool?.resolvePoolSdkName === "function"
    ? pool.resolvePoolSdkName()
    : "";
  const managedSessionExecutor = resolveManagedSessionExecutor(context);
  const normalizedRequestedExecutor = normalizeVoiceExecutor(requestedExecutor);
  const runtimeHintCandidates = [
    context?.sdk,
    context?.providerSelection,
    context?.adapterName,
    managedSessionExecutor,
    poolExecutor,
    context?.executor,
    cfg?.voice?.delegateExecutor,
    cfg?.primaryAgent,
  ];
  const runtimeHintExecutor = runtimeHintCandidates
    .map((candidate) => normalizeVoiceExecutor(candidate))
    .find((candidate) => VALID_EXECUTORS.has(candidate)) || "";
  if (
    preferPoolExecutor
    && normalizedRequestedExecutor === "codex-sdk"
    && runtimeHintExecutor
    && runtimeHintExecutor !== "codex-sdk"
  ) {
    return runtimeHintExecutor;
  }
  const candidates = preferPoolExecutor
    ? [
        normalizedRequestedExecutor,
        context?.sdk,
        context?.providerSelection,
        context?.adapterName,
        managedSessionExecutor,
        poolExecutor,
        context?.executor,
        cfg?.voice?.delegateExecutor,
        cfg?.primaryAgent,
        "codex-sdk",
      ]
    : [
        normalizedRequestedExecutor,
        context?.executor,
        context?.sdk,
        context?.providerSelection,
        context?.adapterName,
        managedSessionExecutor,
        cfg?.voice?.delegateExecutor,
        poolExecutor,
        cfg?.primaryAgent,
        "codex-sdk",
      ];
  for (const candidate of candidates) {
    const normalized = normalizeVoiceExecutor(candidate);
    if (VALID_EXECUTORS.has(normalized)) {
      return normalized;
    }
  }
  return "codex-sdk";
}

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

async function getAgentPool() {
  if (!_agentPool) {
    _agentPool = await import("../agent/agent-pool.mjs");
  }
  return _agentPool;
}

async function getWorkflowEngineModule() {
  if (!_workflowEngine) {
    _workflowEngine = await import("../workflow/workflow-engine.mjs");
  }
  return _workflowEngine;
}

async function resolveKanbanContext() {
  const cfg = loadConfig();
  const kanbanMod = await getKanban();
  const adapter = typeof kanbanMod.getKanbanAdapter === "function"
    ? kanbanMod.getKanbanAdapter()
    : null;
  if (!adapter) {
    throw new Error("Kanban adapter is unavailable");
  }
  const projects = typeof adapter.listProjects === "function"
    ? await adapter.listProjects()
    : [];
  const configuredProjectId = String(
    cfg?.kanban?.projectId || process.env.KANBAN_PROJECT_ID || process.env.VK_PROJECT_ID || "",
  ).trim() || null;
  const discoveredProjectIds = (Array.isArray(projects) ? projects : [])
    .map((project) => String(project?.id || project?.project_id || "").trim())
    .filter(Boolean);
  const projectIds = [];
  if (configuredProjectId) {
    projectIds.push(configuredProjectId);
  }
  for (const id of discoveredProjectIds) {
    if (!projectIds.includes(id)) projectIds.push(id);
  }
  if (!projectIds.length) {
    projectIds.push(null);
  }
  return { kanbanMod, adapter, projects, projectIds, projectId: projectIds[0] || null };
}

async function listTasksAcrossProjects(context = {}, filters = {}) {
  const { adapter, projectIds } = await resolveKanbanContext();
  const ids = Array.isArray(projectIds) && projectIds.length ? projectIds : [null];
  const all = [];
  const seen = new Set();
  let firstErr = null;
  for (const projectId of ids) {
    try {
      const tasks = await adapter.listTasks(projectId, filters);
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const stableId = String(task?.id || task?.number || `${projectId || "default"}:${task?.title || ""}`).trim();
        if (!stableId || seen.has(stableId)) continue;
        seen.add(stableId);
        all.push(task);
      }
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  if (!all.length && firstErr) {
    throw firstErr;
  }
  return all;
}

async function getLatestVisionSummary(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById
      ? tracker.getSessionById(id)
      : (tracker.getSession ? tracker.getSession(id) : null);
    const metaSummary = String(session?.metadata?.latestVisionSummary || "").trim();
    if (metaSummary) return `[Vision] ${metaSummary}`;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (String(msg?.role || "").trim().toLowerCase() !== "system") continue;
      const text = String(msg?.content || "").trim();
      if (!text) continue;
      if (/^\[Vision\s/i.test(text)) return text;
    }
  } catch {
    // best effort: continue without visual context
  }
  return "";
}

function appendVisionSummary(message, visionSummary) {
  const base = String(message || "").trim();
  const summary = String(visionSummary || "").trim();
  if (!base || !summary) return base;
  return `${base}\n\nLive visual context from this call:\n${summary}`;
}

function extractLatestTextFromHistoryItems(history = []) {
  const items = Array.isArray(history) ? history : [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const role = String(item?.role || "").trim().toLowerCase();
    if (role && role !== "user") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j];
      const transcript = String(part?.transcript || "").trim();
      if (transcript) return transcript;
      const text = String(part?.text || part?.input_text || "").trim();
      if (text) return text;
    }
    const direct = String(item?.text || item?.message || "").trim();
    if (direct) return direct;
  }
  return "";
}

function resolveAskAgentMessage(args = {}) {
  const direct = String(
    args?.message
      || args?.prompt
      || args?.query
      || args?.request
      || args?.text
      || args?.instruction
      || "",
  ).trim();
  if (direct) return direct;
  const nested = args?.context && typeof args.context === "object" ? args.context : null;
  const nestedDirect = String(
    nested?.message
      || nested?.prompt
      || nested?.query
      || nested?.request
      || nested?.text
      || "",
  ).trim();
  if (nestedDirect) return nestedDirect;
  const historyDerived = extractLatestTextFromHistoryItems(nested?.history);
  if (historyDerived) return historyDerived;
  return "";
}

function resolveVisionQuery(args = {}) {
  const direct = String(
    args?.query
      || args?.prompt
      || args?.question
      || args?.request
      || args?.message
      || args?.text
      || "",
  ).trim();
  if (direct) return direct;
  const nested = args?.context && typeof args.context === "object" ? args.context : null;
  const nestedDirect = String(
    nested?.query
      || nested?.prompt
      || nested?.question
      || nested?.request
      || nested?.message
      || nested?.text
      || "",
  ).trim();
  if (nestedDirect) return nestedDirect;
  const historyDerived = extractLatestTextFromHistoryItems(nested?.history);
  if (historyDerived) return historyDerived;
  return "";
}

async function getRecentSessionContextSnippet(sessionId, limit = 8) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById?.(id) || tracker.getSession?.(id) || null;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const filtered = messages
      .filter((m) => {
        const role = String(m?.role || "").trim().toLowerCase();
        if (role !== "user" && role !== "assistant") return false;
        const text = String(m?.content || "").trim();
        return Boolean(text);
      })
      .slice(-Math.max(1, Math.min(Number(limit) || 8, 20)));
    if (!filtered.length) return "";
    const lines = filtered.map((m) => {
      const role = String(m.role || "").trim().toUpperCase();
      const text = String(m.content || "").replace(/\s+/g, " ").trim();
      const capped = text.length > 320 ? `${text.slice(0, 320)}...` : text;
      return `[${role}] ${capped}`;
    });
    return lines.join("\n");
  } catch {
    return "";
  }
}

function parseObjectArg(value, fieldName) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      throw new Error(`${fieldName} must decode to a JSON object`);
    } catch (err) {
      throw new Error(`Invalid JSON for ${fieldName}: ${err.message}`);
    }
  }
  throw new Error(`${fieldName} must be an object or JSON string`);
}

function normalizeStringArrayArg(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || "").trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to delimiter splitting
    }
  }
  return raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasExplicitConfirmation(args = {}) {
  if (!args || typeof args !== "object") return false;
  if (args.confirm === true) return true;
  const confirmation = String(args.confirmation || "").trim();
  if (!confirmation) return false;
  return /\b(yes|confirm|confirmed|confirmation|proceed|proceeding)\b/i.test(confirmation);
}

function toCompactPromptSyncUpdate(entry) {
  return {
    key: String(entry?.key || ""),
    updateAvailable: entry?.updateAvailable === true,
    needsReview: entry?.needsReview === true,
    reason: String(entry?.reason || "unknown"),
  };
}

function parseAnyJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const firstObj = raw.indexOf("{");
  const lastObj = raw.lastIndexOf("}");
  if (firstObj >= 0 && lastObj > firstObj) {
    try {
      return JSON.parse(raw.slice(firstObj, lastObj + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

function normalizeWorkflowDefinition(def, args = {}) {
  const input = def && typeof def === "object" && !Array.isArray(def) ? { ...def } : {};
  if (typeof args.workflowId === "string" && args.workflowId.trim()) {
    input.id = args.workflowId.trim();
  } else if (typeof args.id === "string" && args.id.trim()) {
    input.id = args.id.trim();
  }
  if (!input.name) {
    const fallbackName = String(args.name || "").trim();
    input.name = fallbackName || input.id || "Voice Workflow";
  }
  if (typeof args.description === "string" && args.description.trim()) {
    input.description = args.description.trim();
  }
  if (!Array.isArray(input.nodes)) input.nodes = [];
  if (!Array.isArray(input.edges)) input.edges = [];
  if (!Array.isArray(input.triggers) && input.triggers != null) input.triggers = [];
  if (!input.variables || typeof input.variables !== "object" || Array.isArray(input.variables)) {
    input.variables = {};
  }
  if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    input.metadata = {};
  }
  input.metadata.updatedBy = "voice-tool";
  if (typeof args.enabled === "boolean") {
    input.enabled = args.enabled;
  } else if (input.enabled == null) {
    input.enabled = false;
  }
  return input;
}

function normalizeCandidatePath(input) {
  if (!input) return "";
  try {
    return resolvePath(String(input));
  } catch {
    return String(input || "");
  }
}

async function resolveDelegationCwd(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById?.(id) || tracker.getSession?.(id) || null;
    const metadata = session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
    const explicit = normalizeCandidatePath(metadata?.workspaceDir);
    if (explicit && existsSync(explicit)) return explicit;
  } catch {
    // best effort
  }
  return "";
}

async function resolveToolCwd(context = {}) {
  const sessionId = String(context?.sessionId || "").trim();
  const fromSession = await resolveDelegationCwd(sessionId);
  if (fromSession && existsSync(fromSession)) return fromSession;
  const explicitCwd = String(context?.cwd || "").trim();
  if (explicitCwd && existsSync(explicitCwd)) return explicitCwd;
  const repoRoot = resolveAgentRepoRoot();
  if (repoRoot && existsSync(repoRoot)) return repoRoot;
  return process.cwd();
}

async function getWorkspaceContextSummary(context = {}) {
  const sessionId = String(context?.sessionId || "").trim();
  const cwd = await resolveToolCwd(context);
  const repoRoot = resolveAgentRepoRoot();
  let metadata = {};
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById?.(sessionId) || tracker.getSession?.(sessionId) || null;
    metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  } catch {
    metadata = {};
  }
  return {
    sessionId: sessionId || null,
    workspaceId: String(metadata?.workspaceId || "").trim() || null,
    workspaceDir: String(metadata?.workspaceDir || "").trim() || null,
    repository: String(metadata?.repository || metadata?.repo || "").trim() || null,
    cwd,
    repoRoot,
  };
}

function makeVoiceHandoffSessionId() {
  return `voice-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isPrivilegedVoiceContext(context = {}) {
  const source = String(context?.authSource || "").trim().toLowerCase();
  return source === "desktop-api-key" || source === "fallback" || source === "unsafe";
}

function canRunWritableWorkspaceCommand(context = {}) {
  if (isPrivilegedVoiceContext(context)) return true;
  return !isVoiceLikeToolContext(context);
}

function resolveWorkspaceCommandExecutable(commandName) {
  if (process.platform === "win32" && commandName === "npm") {
    return "npm.cmd";
  }
  return commandName;
}

function shouldUseWorkspaceCommandShell(commandName) {
  return process.platform === "win32" && commandName === "npm";
}

function hasUnsafeWorkspaceShellMetacharacters(rawCmd) {
  const value = String(rawCmd || "");
  return /&&|\|\||[|;\x60]/.test(value)
    || /\$\(/.test(value)
    || /(?:^|\s)\d*>(?=\s|$)/.test(value)
    || /(?:^|\s)[<>](?=\s|$)/.test(value);
}

function resolveWorkspaceCommandTimeoutMs(commandName, args = []) {
  const normalizedArgs = args.map((arg) => String(arg || "").toLowerCase());
  if (commandName === "npm") {
    const firstArg = normalizedArgs[0] || "";
    const secondArg = normalizedArgs[1] || "";
    if (firstArg === "test" || (firstArg === "run" && (secondArg === "test" || secondArg === "build" || secondArg === "check"))) {
      return 300_000;
    }
    return 120_000;
  }
  if (
    commandName === "node"
    && normalizedArgs.some((arg) =>
      arg.includes("vitest")
      || arg.endsWith("tools/vitest-runner.mjs")
      || arg.endsWith("tools\\vitest-runner.mjs")
    )
  ) {
    return 300_000;
  }
  return 20_000;
}

function resolveWorkspaceCommandMaxBuffer(commandName, args = []) {
  const normalizedArgs = args.map((arg) => String(arg || "").toLowerCase());
  if (commandName === "npm") {
    const firstArg = normalizedArgs[0] || "";
    const secondArg = normalizedArgs[1] || "";
    if (
      firstArg === "test"
      || (firstArg === "run" && (secondArg === "test" || secondArg === "build" || secondArg === "check"))
    ) {
      return 16 * 1024 * 1024;
    }
    return 4 * 1024 * 1024;
  }
  if (commandName === "node" && normalizedArgs.some((arg) => arg.includes("vitest"))) {
    return 16 * 1024 * 1024;
  }
  return 4 * 1024 * 1024;
}

// ── Tool Definitions (OpenAI function-calling format) ────────────────────────



// ── Tool Execution ──────────────────────────────────────────────────────────

/**
 * Get tool definitions in OpenAI format.
 */
export function getToolDefinitions() {
  return TOOL_DEFS;
}

const VOICE_APPROVAL_REQUIRED_TOOLS = new Set([
  "create_task",
  "update_task_status",
  "delegate_to_agent",
  "run_command",
  "bosun_slash_command",
  "invoke_mcp_tool",
  "create_workflow",
  "update_workflow_definition",
  "execute_workflow",
  "retry_workflow_run",
  "sync_prompt_defaults",
]);

function isVoiceLikeToolContext(context = {}) {
  const surface = String(context?.surface || "").trim().toLowerCase();
  const sessionType = String(context?.sessionType || "").trim().toLowerCase();
  if (surface) {
    return surface === "voice" || surface.startsWith("voice-");
  }
  if (sessionType) {
    return sessionType === "voice" || sessionType.startsWith("voice");
  }
  return true;
}

function buildVoiceToolRegistryDefinitions(options = {}) {
  const requireVoiceApprovals = options.requireVoiceApprovals !== false;
  return TOOL_DEFS.map((definition) => {
    const name = String(definition?.name || "").trim();
    return {
      id: name,
      name,
      description: String(definition?.description || "").trim() || null,
      requiresApproval: requireVoiceApprovals && VOICE_APPROVAL_REQUIRED_TOOLS.has(name),
      networkAccess: name === "invoke_mcp_tool" ? "restricted" : "inherit",
      handler: async (toolArgs, toolContext) => {
        const handler = TOOL_HANDLERS[name];
        if (typeof handler !== "function") {
          throw new Error(`Unknown tool: ${name}`);
        }
        return await handler(toolArgs, toolContext);
      },
    };
  }).filter((entry) => entry.id);
}

async function buildVoiceToolRuntimeContext(toolName, context = {}, options = {}) {
  const cwd = await resolveToolCwd(context);
  const privileged = isPrivilegedVoiceContext(context);
  const defaultApprovalMode = (
    context?.approval?.mode
    || context?.approvalMode
    || (context?.executionPolicy?.approvalRequired === true || context?.requireApproval === true
      ? "manual"
      : "auto")
  );
  return {
    ...context,
    cwd,
    repoRoot: String(context?.repoRoot || resolveAgentRepoRoot(cwd)).trim() || cwd,
    sessionId: String(context?.sessionId || "").trim() || null,
    runId: String(context?.runId || context?.sessionId || "").trim() || null,
    surface: String(context?.surface || options.defaultSurface || "voice").trim() || "voice",
    sessionType: String(context?.sessionType || options.defaultSessionType || "voice").trim() || "voice",
    requestedBy: String(context?.requestedBy || context?.userId || options.defaultRequestedBy || "voice").trim() || "voice",
    approval: {
      ...(context?.approval && typeof context.approval === "object" ? context.approval : {}),
      mode: String(defaultApprovalMode).trim() || "auto",
      ...(privileged
        ? {
            decision: String(context?.approval?.decision || "approved").trim() || "approved",
            state: String(context?.approval?.state || "approved").trim() || "approved",
          }
        : {}),
      scopeType: String(context?.approval?.scopeType || context?.approvalScopeType || "harness-run").trim() || "harness-run",
      scopeId: String(
        context?.approval?.scopeId
        || context?.approvalScopeId
        || context?.runId
        || context?.sessionId
        || `${String(toolName || "").trim() || "tool"}:${String(context?.turnId || "").trim() || "voice"}`,
      ).trim() || null,
    },
  };
}

/**
 * Execute a tool call by name with given arguments.
 * @param {string} toolName
 * @param {object} args
 * @param {object} context — { sessionId, userId }
 * @returns {Promise<{ result: string, error?: string }>}
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const handler = TOOL_HANDLERS[normalizedToolName];
  if (!handler) {
    return { result: null, error: `Unknown tool: ${toolName}` };
  }
  try {
    const voiceLikeContext = isVoiceLikeToolContext(context);
    const runtimeContext = await buildVoiceToolRuntimeContext(normalizedToolName, context, {
      defaultSurface: voiceLikeContext ? "voice" : "bosun-tool",
      defaultSessionType: voiceLikeContext ? "voice" : "tool-bridge",
      defaultRequestedBy: voiceLikeContext ? "voice" : "bosun-tool",
    });
    const orchestrator = createToolOrchestrator({
      cwd: runtimeContext.cwd,
      repoRoot: runtimeContext.repoRoot,
      approvalOptions: {
        repoRoot: runtimeContext.repoRoot,
        approvalScopeType: runtimeContext?.approval?.scopeType || "harness-run",
        approvalScopeId: runtimeContext?.approval?.scopeId || runtimeContext?.runId || runtimeContext?.sessionId || normalizedToolName,
      },
      toolSources: [{
        source: voiceLikeContext ? "voice" : "bosun-tool",
        definitions: buildVoiceToolRegistryDefinitions({
          requireVoiceApprovals: voiceLikeContext,
        }),
      }],
      truncation: {
        maxChars: 4000,
        tailChars: 400,
      },
      onEvent: context?.onEvent,
    });
    const result = await orchestrator.execute(normalizedToolName, args, runtimeContext);
    const injectedResult = await injectToolResultContext(
      normalizedToolName,
      args,
      result,
      runtimeContext,
    );
    return { result: typeof injectedResult === "string" ? injectedResult : JSON.stringify(injectedResult, null, 2) };
  } catch (err) {
    console.error("[voice-tools] %s error: %s", String(toolName || "unknown"), String(err?.message || err || "unknown"));
    return {
      result: null,
      error: err.message,
      approvalRequestId: String(err?.request?.requestId || err?.approval?.requestId || "").trim() || null,
      approval: err?.approval || null,
    };
  }
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  async list_tasks(args) {
    const status = args.status || "all";
    const limit = args.limit || 20;
    const tasks = await listTasksAcrossProjects({}, {
      status: status === "all" ? undefined : status,
    });
    const limited = tasks.slice(0, limit);
    return limited.map(t => ({
      id: t.id || t.number,
      title: t.title,
      status: t.status,
      assignee: t.assignee || t.assignees?.[0] || "unassigned",
      labels: t.labels || [],
    }));
  },

  async get_task(args) {
    const { adapter } = await resolveKanbanContext();
    const task = await adapter.getTask(args.taskId);
    if (!task) return `Task ${args.taskId} not found.`;
    return {
      id: task.id || task.number,
      title: task.title,
      status: task.status,
      description: task.body || task.description || "(no description)",
      assignee: task.assignee || "unassigned",
      labels: task.labels || [],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  },

  async create_task(args) {
    const { adapter, projectId } = await resolveKanbanContext();
    const result = await adapter.createTask(projectId, {
      title: args.title,
      body: args.description || "",
      priority: args.priority,
      labels: args.labels,
    });
    return `Created task: ${result.title || args.title} (ID: ${result.id || result.number})`;
  },

  async update_task_status(args) {
    const { adapter } = await resolveKanbanContext();
    await adapter.updateTaskStatus(args.taskId, args.status);
    return `Task ${args.taskId} moved to ${args.status}.`;
  },

  async delegate_to_agent(args, context) {
    const cfg = loadConfig();
    const pool = await getAgentPool();
    const voiceLikeContext = isVoiceLikeToolContext(context);
    if ((!voiceLikeContext && isDelegatedToolSession(context)) || isDelegatedLiveSessionContext(context)) {
      return "{RESPONSE}: Nested delegate_to_agent calls are blocked for delegated sessions. Continue in the current delegated session or poll the existing background session instead of spawning another live delegate.";
    }
    const managedProviderDetails = resolveManagedSessionProviderDetails(context);
    const executor = resolveVoiceExecutor({
      requestedExecutor: args.executor,
      context,
      cfg,
      pool,
      preferPoolExecutor: !voiceLikeContext,
    });

    const rawMode = String(args.mode || context.mode || "agent")
      .trim()
      .toLowerCase();
    const mode = MODE_ALIASES[rawMode] || (VALID_AGENT_MODES.has(rawMode) ? rawMode : "agent");
    const providerSelection = String(
      context?.providerSelection
      || context?.providerId
      || context?.provider
      || managedProviderDetails.providerSelection
      || managedProviderDetails.providerId
      || "",
    ).trim() || undefined;
    const providerId = String(
      context?.providerId
      || context?.provider
      || managedProviderDetails.providerId
      || "",
    ).trim() || undefined;
    const providerConfigBase =
      cloneVoiceProviderConfig(context?.providerConfig)
      || managedProviderDetails.providerConfig
      || null;
    const inheritedProviderModel = String(
      providerConfigBase?.model
      || managedProviderDetails.model
      || "",
    ).trim();
    const requestedModel = String(
      args.model
      || context.model
      || "",
    ).trim();
    const model = (
      executor === "openai-native" && inheritedProviderModel
        ? inheritedProviderModel
        : (requestedModel || inheritedProviderModel)
    ) || undefined;
    const providerConfig = providerConfigBase || providerSelection || providerId || model
      ? {
          ...(providerConfigBase || {}),
          ...(providerSelection && !providerConfigBase?.selectionId ? { selectionId: providerSelection } : {}),
          ...(providerId && !providerConfigBase?.provider ? { provider: providerId } : {}),
          ...(providerId && !providerConfigBase?.providerId ? { providerId } : {}),
          ...(model ? { model } : {}),
        }
      : null;
    const parentSessionId = String(context.sessionId || "").trim() || null;
    const baseSessionType = String(context.sessionType || "").trim() || (voiceLikeContext ? "voice" : "delegate");
    const sessionType = voiceLikeContext
      ? "voice-delegate"
      : (baseSessionType === "delegate" ? "delegate" : `${baseSessionType}-delegate`);
    const sessionScope = voiceLikeContext ? "voice" : "delegate";
    const sessionSource = String(context.surface || (voiceLikeContext ? "voice" : "bosun-tool")).trim() || "bosun-tool";
    const trackerEventLabel = voiceLikeContext ? "Voice Delegation" : "Delegation";
    const trackerEventTypePrefix = voiceLikeContext ? "voice_live_delegation" : "delegation";
    const cwd = await resolveToolCwd(context);
    const workspaceContext = await getWorkspaceContextSummary(context);
    const visionSummary = await getLatestVisionSummary(parentSessionId || "");
    const delegateMessage = appendVisionSummary(args.message, visionSummary);
    const shortTitle = String(args.message || "").trim().slice(0, 90) || (voiceLikeContext ? "Voice task" : "Delegated task");
    const rootSessionId = String(context.rootSessionId || parentSessionId || "").trim() || null;

    // ── Create a live session for direct execution (no background queue) ──
    const liveSessionId = `${voiceLikeContext ? "voice-live" : "delegate-live"}-${Date.now()}-${randomUUID().slice(0, 6)}`;

    try {
      const tracker = await getSessionTracker();
      if (tracker.createSession) {
        const existingSession =
          tracker.getSessionById?.(liveSessionId)
          || tracker.getSession?.(liveSessionId)
          || null;
        if (!existingSession) {
          tracker.createSession({
            id: liveSessionId,
            type: sessionType,
            metadata: {
              title: shortTitle,
              agent: executor,
              mode,
              model,
              parentSessionId,
              rootSessionId,
              providerSelection,
              providerId,
              ...(providerConfig ? { providerConfig } : {}),
              workspaceDir: cwd,
              workspaceContext,
              source: sessionSource,
            },
          });
        }
      }
      // Link to parent session
      if (parentSessionId && tracker.recordEvent) {
        tracker.recordEvent(parentSessionId, {
          role: "system",
          content: `[${trackerEventLabel}] Started live session ${liveSessionId} → ${executor} (${mode})`,
          timestamp: new Date().toISOString(),
          meta: {
            source: sessionSource,
            eventType: trackerEventTypePrefix,
            liveSessionId,
            executor,
            mode,
          },
        });
      }
    } catch { /* best effort session tracking */ }

    // ── Execute directly in new live session (fire-and-forget) ──
    pool.launchOrResumeThread(delegateMessage, cwd, 5 * 60_000, {
      taskKey: liveSessionId,
      sessionId: liveSessionId,
      sessionScope,
      sessionType,
      parentSessionId: parentSessionId || undefined,
      rootSessionId: rootSessionId || undefined,
      sdk: executor,
      ...(providerSelection ? { providerSelection } : {}),
      ...(providerId ? { provider: providerId } : {}),
      ...(providerConfig ? { providerConfig } : {}),
      pinSdk: !voiceLikeContext,
      mode,
      model,
      metadata: {
        title: shortTitle,
        agent: executor,
        mode,
        model,
        parentSessionId,
        rootSessionId,
        providerSelection,
        providerId,
        ...(providerConfig ? { providerConfig } : {}),
        workspaceDir: cwd,
        workspaceContext,
        source: sessionSource,
      },
    })
      .then(async (rawResult) => {
        const result = normalizeDelegateSessionResult(rawResult);
        const trimmed = extractDelegateResultText(result)
          || (result?.success === false ? JSON.stringify(result) : "");
        const completionStatus = String(
          result?.blockedReason
          || result?.status
          || (result?.success === true ? "completed" : "failed"),
        ).trim() || (result?.success === true ? "completed" : "failed");
        const completionEventType = result?.success === true
          ? `${trackerEventTypePrefix}_complete`
          : `${trackerEventTypePrefix}_blocked`;
        try {
          const tracker = await getSessionTracker();
          if (tracker.recordEvent) {
            if (trimmed) {
              tracker.recordEvent(liveSessionId, {
                role: result?.success === true ? "assistant" : "system",
                content: trimmed.slice(0, 4000),
                timestamp: new Date().toISOString(),
                meta: { source: sessionSource, eventType: completionEventType, executor, mode, status: completionStatus },
              });
            }
            if (parentSessionId) {
              tracker.recordEvent(parentSessionId, {
                role: result?.success === true ? "system" : "assistant",
                content: result?.success === true
                  ? `[${trackerEventLabel} Complete] Session ${liveSessionId} finished.`
                  : `[${trackerEventLabel} Blocked] Session ${liveSessionId} ended with status ${completionStatus}.`,
                timestamp: new Date().toISOString(),
                meta: { source: sessionSource, eventType: completionEventType, liveSessionId, status: completionStatus },
              });
            }
          }
          if (tracker.updateSessionStatus) {
            tracker.updateSessionStatus(liveSessionId, completionStatus);
          }
        } catch {
          // best effort
        }
      })
      .catch(async (err) => {
        try {
          const tracker = await getSessionTracker();
          if (tracker.recordEvent) {
            tracker.recordEvent(liveSessionId, {
              role: "system",
              content: `[${trackerEventLabel} Error] ${err?.message || "Unknown error"}`,
              timestamp: new Date().toISOString(),
              meta: { source: sessionSource, eventType: `${trackerEventTypePrefix}_error`, liveSessionId },
            });
          }
          if (tracker.updateSessionStatus) {
            tracker.updateSessionStatus(liveSessionId, "error");
          }
        } catch {
          // best effort
        }
      });

    return `{RESPONSE}: Delegation started in live session ${liveSessionId}. Agent "${executor}" is running in ${mode} mode. Use list_sessions and get_session_history to track progress.`;
  },

  async ask_agent_context(args, context) {
    const cfg = loadConfig();
    const pool = await getAgentPool();
    const executor = resolveVoiceExecutor({ context, cfg, pool });

    const mode = "instant";
    const model = String(args.model || context?.model || "").trim() || undefined;
    const sessionId = String(context?.sessionId || "").trim() || `voice-ask-${Date.now()}`;
    const cwd = await resolveToolCwd(context);
    const visionSummary = await getLatestVisionSummary(sessionId);
    const userAsk = resolveAskAgentMessage(args);
    if (!userAsk) {
      return "{RESPONSE}: I need a specific question to ask the project agent.";
    }
    const sessionSnippet = await getRecentSessionContextSnippet(sessionId, 8);
    const contextBlock = sessionSnippet
      ? `\n\nRecent session context:\n${sessionSnippet}\n`
      : "";
    // Inject voice preamble so the agent returns TTS-shaped responses
    const message = VOICE_CONTEXT_PREAMBLE + appendVisionSummary(`${userAsk}${contextBlock}`, visionSummary);

    try {
      const result = await pool.execPooledPrompt(message, {
        sdk: executor,
        mode,
        model,
        cwd,
        timeoutMs: 15_000,
        sessionType: "voice-ask",
      });
      const text = typeof result === "string"
        ? result
        : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
      const trimmed = String(text || "").trim();
      if (!trimmed) return "{RESPONSE}: Agent returned no content.";
      const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}... (truncated)` : trimmed;
      // Apply TTS-safe formatting (extracts VOICE_RESPONSE: marker if present)
      return `{RESPONSE}: ${formatVoiceToolResult(clipped)}`;
    } catch (err) {
      const reason = String(err?.message || "instant query timed out").trim();
      const isTimeout = /timeout|time.out|timed.out|aborted/i.test(reason);
      if (isTimeout) {
        // Only auto-background on timeout — surface genuine errors directly.
        const backgroundMsg = await TOOL_HANDLERS.delegate_to_agent(
          { message: `${userAsk}${contextBlock}`, executor, mode: "agent", model },
          context,
        );
        const cleanedBackgroundMsg = String(backgroundMsg || "")
          .replace(/^\{RESPONSE\}:\s*/i, "")
          .trim();
        return `{RESPONSE}: Query is taking longer than expected; handing off to a live agent session. ${cleanedBackgroundMsg}`;
      }
      return `{RESPONSE}: Agent query failed: ${reason}`;
    }
  },

  async ask_agent_context_legacy_fallback(args, context) {
    // Reserved for explicit compatibility only.
    const model = String(args.model || context?.model || "").trim() || undefined;
    const sessionId = String(context?.sessionId || "").trim() || `voice-ask-${Date.now()}`;
    const cwd = await resolveToolCwd(context);
    const visionSummary = await getLatestVisionSummary(sessionId);
    const message = appendVisionSummary(args.message, visionSummary);
    try {
      const fallback = await execPrimaryPrompt(message, {
        mode: "instant",
        model,
        sessionId,
        scope: `voice-ask:${sessionId}`,
        sessionType: "voice-ask",
        cwd,
      });
      const text = typeof fallback === "string"
        ? fallback
        : fallback?.finalResponse || fallback?.text || fallback?.message || JSON.stringify(fallback);
      return `{RESPONSE}: ${String(text || "").trim() || "No response."}`;
    } catch (fallbackErr) {
      return `{RESPONSE}: Quick agent query failed: ${fallbackErr?.message || "unknown error"}`;
    }
  },

  async get_agent_status() {
    const name = getPrimaryAgentName();
    let activeSessions = [];
    try {
      const pool = await getAgentPool();
      activeSessions = typeof pool.getActiveSessions === "function"
        ? pool.getActiveSessions().slice(0, 20)
        : [];
    } catch {
      activeSessions = [];
    }
    return {
      activeAgent: name,
      status: "available",
      activeSessions: activeSessions.length,
      activeSessionThreads: activeSessions.map((entry) => ({
        taskKey: entry.taskKey || null,
        sdk: entry.sdk || null,
        threadId: entry.threadId || null,
        ageMs: entry.age || null,
      })),
      message: `${name} is the active primary agent.`,
    };
  },

  async switch_agent(args) {
    const previous = getPrimaryAgentName();
    setPrimaryAgent(args.executor);
    return `Switched primary agent from ${previous} to ${args.executor}.`;
  },

  async list_sessions(args) {
    const tracker = await getSessionTracker();
    const includeHistory = args.includeHistory !== false;
    // Use listAllSessions for complete active + history view
    const sessions = tracker.listAllSessions ? tracker.listAllSessions() : [];
    const filtered = includeHistory
      ? sessions
      : sessions.filter(s => s.status === "active");
    const limit = args.limit || 10;
    const page = Math.max(Number(args.page) || 1, 1);
    const offset = (page - 1) * limit;
    const paged = filtered.slice(offset, offset + limit);
    return {
      page,
      limit,
      total: filtered.length,
      sessions: paged.map(s => ({
        id: s.id || s.taskId,
        title: s.title || s.taskTitle || null,
        type: s.type || "task",
        status: s.status,
        turnCount: s.turnCount || 0,
        createdAt: s.createdAt || null,
        lastActive: s.lastActiveAt || s.lastActivityAt,
        preview: s.preview || s.lastMessage || null,
      })),
    };
  },

  async get_session_history(args) {
    const tracker = await getSessionTracker();
    const sessionId = String(args.sessionId || "").trim();
    if (!sessionId) return "sessionId is required.";
    // Use getSessionById (canonical) then fall back to getSession
    const session = tracker.getSessionById?.(sessionId) || tracker.getSession?.(sessionId) || null;
    if (!session) return `Session ${sessionId} not found.`;
    const fullTranscript = args.fullTranscript === true;
    const limit = args.limit || 20;
    const messages = (session.messages || []).slice(-limit);
    return {
      sessionId,
      title: session.taskTitle || session.title || sessionId,
      type: session.type || "task",
      status: session.status || "unknown",
      turnCount: session.turnCount || 0,
      createdAt: session.createdAt || null,
      messageCount: messages.length,
      totalMessages: (session.messages || []).length,
      messages: messages.map(m => ({
        role: m.role || m.type,
        content: fullTranscript
          ? m.content
          : (typeof m.content === "string" && m.content.length > 500
            ? m.content.slice(0, 500) + "..."
            : m.content),
        timestamp: m.timestamp,
      })),
    };
  },

  async get_system_status(args, context) {
    const cfg = loadConfig();
    const name = getPrimaryAgentName();
    const workspace = await getWorkspaceContextSummary(context);
    return {
      primaryAgent: name,
      kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend || "internal",
      projectName: cfg.projectName || "unknown",
      mode: cfg.mode || "generic",
      voiceEnabled: cfg.voice?.enabled !== false,
      workspace,
    };
  },

  async get_fleet_status() {
    try {
      const fleet = await getFleetCoordinator();
      const status = fleet.getFleetStatus ? fleet.getFleetStatus() : {};
      return status;
    } catch {
      return { error: "Fleet coordinator not available" };
    }
  },

  async run_command(args, context) {
    const rawCmd = String(args.command || "").trim();
    const cmd = rawCmd.toLowerCase();

    if (rawCmd.startsWith("/")) {
      return TOOL_HANDLERS.bosun_slash_command({ command: rawCmd }, context);
    }

    // Map to existing tool handlers where possible
    if (cmd === "status" || cmd === "health") {
      return TOOL_HANDLERS.get_system_status({}, context);
    }
    if (cmd === "config" || cmd === "config show") {
      if (isPrivilegedVoiceContext(context)) {
        return TOOL_HANDLERS.get_effective_config({}, context);
      }
      return TOOL_HANDLERS.get_config({}, context);
    }
    if (cmd === "fleet" || cmd === "fleet status") {
      return TOOL_HANDLERS.get_fleet_status({}, context);
    }
    if (cmd === "tasks" || cmd.startsWith("tasks ")) {
      const statusArg = cmd.split(/\s+/)[1] || "all";
      return TOOL_HANDLERS.list_tasks({ status: statusArg }, context);
    }
    if (cmd === "agents") {
      return TOOL_HANDLERS.get_agent_status({}, context);
    }
    if (cmd === "version") {
      try {
        const { readFileSync } = await import("node:fs");
        const { resolve } = await import("node:path");
        const pkgPath = resolve(process.cwd(), "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        return `Bosun v${pkg.version}`;
      } catch {
        return "Version unavailable.";
      }
    }
    if (cmd === "sync") {
      return TOOL_HANDLERS.ask_agent_context(
        { message: "Run git fetch in the workspace and report what changed in one sentence.", mode: "instant" },
        context,
      );
    }
    if (cmd === "maintenance" || cmd.startsWith("maintenance ")) {
      return TOOL_HANDLERS.delegate_to_agent(
        { message: `Execute maintenance command: ${rawCmd}`, mode: "agent" },
        context,
      );
    }

    if (cmd === "commands" || cmd === "helpfull") {
      return TOOL_HANDLERS.bosun_slash_command({ command: "/helpfull" }, context);
    }

    const supported = ["status", "health", "config", "fleet", "tasks", "agents", "version", "sync", "maintenance", "commands", "helpfull", "/<slash>"];
    return `Unknown command "${rawCmd}". Supported: ${supported.join(", ")}. For shell commands use run_workspace_command.`;
  },

  async get_pr_status(args) {
    try {
      const { spawnSync } = await import("node:child_process");
      const limit = Math.max(1, Math.min(100, Number.parseInt(String(args.limit || 10), 10) || 10));
      const result = spawnSync(
        "gh",
        [
          "pr",
          "list",
          "--limit",
          String(limit),
          "--json",
          "number,title,state,author,url",
          "--jq",
          ".[] | {number, title, state, author: .author.login}",
        ],
        { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (result.error || result.status !== 0) {
        throw new Error(String(result.stderr || result.stdout || "gh pr list failed").trim());
      }
      return String(result.stdout || "").trim() || "No open pull requests.";
    } catch {
      return "Could not fetch PR status. Ensure gh CLI is installed.";
    }
  },

  async get_config(args, context) {
    const cfg = loadConfig();
    const mergedContext = {
      ...(context && typeof context === "object" ? context : {}),
      ...(args?.context && typeof args.context === "object" ? args.context : {}),
      ...(args?.authSource ? { authSource: args.authSource } : {}),
    };
    if (args.key) {
      const value = cfg[args.key];
      return value !== undefined ? { [args.key]: value } : `Config key "${args.key}" not found.`;
    }
    if (args.full === true || isPrivilegedVoiceContext(mergedContext)) {
      return cfg;
    }
    // Return safe summary
    return {
      primaryAgent: cfg.primaryAgent,
      mode: cfg.mode,
      kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend,
      projectName: cfg.projectName,
      autoFixEnabled: cfg.autoFixEnabled,
      watchEnabled: cfg.watchEnabled,
      voiceEnabled: cfg.voice?.enabled !== false,
    };
  },

  async update_config(args) {
    return `Config update for "${args.key}" = "${args.value}" noted. Please apply via Settings UI for persistence.`;
  },

  async get_effective_config(args, context) {
    if (!isPrivilegedVoiceContext(context)) {
      return "Full config dump requires owner/admin session context.";
    }
    const cfg = loadConfig();
    // Full effective settings dump for owner/admin sessions
    const safe = { ...cfg };
    // Redact sensitive fields
    const REDACT = ["telegramToken", "openaiKey", "claudeKey", "geminiKey", "azureKey",
      "githubToken", "slackToken", "discordToken", "webhookSecret", "privateKey"];
    for (const key of REDACT) {
      if (safe[key]) safe[key] = "***";
    }
    // Deep-redact nested objects
    for (const section of ["voice", "telegram", "github", "jira", "slack"]) {
      if (safe[section] && typeof safe[section] === "object") {
        for (const subKey of Object.keys(safe[section])) {
          if (/key|token|secret|password|credential/i.test(subKey)) {
            safe[section][subKey] = "***";
          }
        }
      }
    }
    if (args.key) {
      const val = safe[args.key];
      return val !== undefined ? { [args.key]: val } : `Config key "${args.key}" not found.`;
    }
    return safe;
  },

  async get_admin_help() {
    const toolNames = TOOL_DEFS.map(t => t.name).sort();
    const slashCommands = [
      "/instant <prompt>", "/ask <prompt>", "/agent <task>", "/handoff <task>",
      "/status", "/health", "/tasks [status]", "/agents", "/fleet", "/version",
      "/prompts", "/promptsync [apply [keys...]]",
      "/config", "/commands", "/mcp <tool> [server=<name>]", "/workspace <shell cmd>",
      "/shell <cmd>", "/run <cmd>",
    ];
    try {
      const { listAvailableActions } = await import("./voice-action-dispatcher.mjs");
      const actions = listAvailableActions();
      return {
        voiceTools: toolNames,
        voiceToolCount: toolNames.length,
        slashCommands,
        dispatchActions: actions,
        dispatchActionCount: actions.length,
        helpTip: "Use list_sessions, get_session_history(fullTranscript=true), or any slash command via bosun_slash_command.",
      };
    } catch {
      return {
        voiceTools: toolNames,
        voiceToolCount: toolNames.length,
        slashCommands,
        helpTip: "Dispatch actions unavailable.",
      };
    }
  },

  async search_code(args, context) {
    try {
      const { spawnSync } = await import("node:child_process");
      const limit = Math.max(1, Math.min(200, Number.parseInt(String(args.maxResults || 20), 10) || 20));
      const query = String(args.query || "");
      const filePattern = String(args.filePattern || "").trim();
      const cwd = await resolveToolCwd(context);
      const grepArgs = ["-rn", query, ".", "--max-count", String(limit)];
      if (filePattern) {
        grepArgs.splice(2, 0, "--include", filePattern);
      }
      const result = spawnSync("grep", grepArgs, {
        encoding: "utf8",
        timeout: 10_000,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(String(result.stderr || result.stdout || "grep failed").trim());
      }
      const out = String(result.stdout || "").trim();
      return out || `No matches found for "${args.query}".`;
    } catch {
      return `Search failed for "${args.query}".`;
    }
  },

  async read_file_content(args, context) {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    try {
      const filePath = String(
        args.filePath
          || args.path
          || args?.context?.filePath
          || args?.context?.path
          || "",
      ).trim();
      if (!filePath) {
        return "filePath is required. Provide filePath (or path) relative to the workspace root.";
      }
      const cwd = await resolveToolCwd(context);
      const fullPath = resolve(cwd, filePath);
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split("\n");
      const start = (args.startLine || 1) - 1;
      const end = args.endLine || lines.length;
      const slice = lines.slice(start, end).join("\n");
      return slice.length > 3000 ? slice.slice(0, 3000) + "\n... (truncated)" : slice;
    } catch (err) {
      return `Could not read ${String(args.filePath || args.path || "(unknown path)")}: ${err.message}`;
    }
  },

  async list_directory(args, context) {
    const { readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const cwd = await resolveToolCwd(context);
      const dir = resolve(cwd, args.path || ".");
      const entries = readdirSync(dir).slice(0, 50);
      return entries.map(name => {
        try {
          const isDir = statSync(join(dir, name)).isDirectory();
          return isDir ? `${name}/` : name;
        } catch {
          return name;
        }
      });
    } catch (err) {
      return `Could not list ${args.path || "."}: ${err.message}`;
    }
  },

  async get_workspace_context(args, context) {
    return await getWorkspaceContextSummary(context);
  },

  async query_live_view(args, context) {
    const sessionId = String(context?.sessionId || "").trim();
    if (!sessionId) {
      return "{RESPONSE}: Live vision query requires an active session.";
    }
    const query = resolveVisionQuery(args)
      || "Describe what is visible right now and highlight any coding errors, failing commands, UI blockers, or next actionable step.";
    const state = getVisionSessionState(sessionId);
    const frameDataUrl = String(state?.lastFrameDataUrl || "").trim();
    if (!frameDataUrl) {
      return "{RESPONSE}: No live frame is available yet. Start camera/screen sharing and try again.";
    }
    try {
      const { analyzeVisionFrame } = await import("./voice-relay.mjs");
      const analysis = await analyzeVisionFrame(frameDataUrl, {
        source: String(state?.lastFrameSource || "screen").trim() || "screen",
        context: {
          sessionId,
          executor: context?.executor,
          mode: context?.mode,
          model: context?.model,
        },
        prompt: query,
      });
      const summary = String(analysis?.summary || "").trim();
      if (!summary) return "{RESPONSE}: Vision model returned no summary.";
      return `{RESPONSE}: ${summary}`;
    } catch (err) {
      return `{RESPONSE}: Live vision query failed: ${String(err?.message || "unknown error")}`;
    }
  },

  async get_recent_logs(args, context) {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const cwd = await resolveToolCwd(context);
      const logsDir = resolve(cwd, "logs");
      const type = String(args.type || "agent").trim().toLowerCase();
      const lines = Math.min(Math.max(Number(args.lines) || 50, 1), 5000);
      const files = readdirSync(logsDir)
        .filter((f) => {
          if (!f.endsWith(".log")) return false;
          if (type === "all") return true;
          return f.toLowerCase().includes(type);
        })
        .sort((a, b) => {
          try {
            return statSync(join(logsDir, b)).mtimeMs - statSync(join(logsDir, a)).mtimeMs;
          } catch { return 0; }
        });
      if (!files.length) return `No ${type} logs found.`;
      if (args.listOnly === true) {
        return {
          type,
          count: files.length,
          files: files.map((name) => {
            try {
              const stat = statSync(join(logsDir, name));
              return {
                name,
                size: stat.size,
                mtime: new Date(stat.mtimeMs).toISOString(),
              };
            } catch {
              return { name, size: null, mtime: null };
            }
          }),
        };
      }
      const requestedFile = String(args.file || args.filename || "").trim();
      const targetFile = requestedFile
        ? files.find((candidate) => candidate === requestedFile) || files[0]
        : files[0];
      const content = readFileSync(join(logsDir, targetFile), "utf8");
      if (args.full === true) {
        return content.length > 150_000 ? `${content.slice(-150_000)}\n... (trimmed to last 150000 chars)` : content;
      }
      const logLines = content.trim().split("\n");
      return logLines.slice(-lines).join("\n");
    } catch {
      return "Could not read logs.";
    }
  },

  async search_tasks(args) {
    const query = String(args.query || "").trim().toLowerCase();
    if (!query) return "Search query is required.";
    const limit = args.limit || 20;
    const tasks = await listTasksAcrossProjects({}, { status: undefined });
    const matches = (Array.isArray(tasks) ? tasks : []).filter((t) => {
      const text = `${t.title || ""} ${t.body || t.description || ""} ${(t.labels || []).join(" ")}`.toLowerCase();
      return text.includes(query);
    });
    return {
      query: args.query,
      count: Math.min(matches.length, limit),
      total: matches.length,
      tasks: matches.slice(0, limit).map((t) => ({
        id: t.id || t.number,
        title: t.title,
        status: t.status,
        labels: t.labels || [],
      })),
    };
  },

  async get_task_stats() {
    const tasks = await listTasksAcrossProjects({}, { status: undefined });
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
  },

  async delete_task(args) {
    const { adapter } = await resolveKanbanContext();
    const taskId = String(args.taskId || "").trim();
    if (!taskId) return "taskId is required.";
    await adapter.deleteTask(taskId);
    return `Task ${taskId} deleted.`;
  },

  async comment_on_task(args) {
    const { adapter } = await resolveKanbanContext();
    const taskId = String(args.taskId || "").trim();
    const body = String(args.body || "").trim();
    if (!taskId) return "taskId is required.";
    if (!body) return "comment body is required.";
    await adapter.addComment(taskId, body);
    return `Comment added to task ${taskId}.`;
  },

  async set_agent_mode(args) {
    const rawMode = String(args.mode || "").trim().toLowerCase();
    const VALID = new Set(["ask", "agent", "plan"]);
    if (!VALID.has(rawMode)) return `Invalid mode: ${rawMode}. Use: ask, agent, plan`;
    const previous = getAgentMode();
    setAgentMode(rawMode);
    return `Agent mode changed from ${previous} to ${rawMode}.`;
  },

  async list_workflows() {
    let installed = [];
    try {
      const wfEngineMod = await getWorkflowEngineModule();
      const engine = typeof wfEngineMod.getWorkflowEngine === "function"
        ? wfEngineMod.getWorkflowEngine()
        : null;
      installed = engine?.list ? engine.list() : [];
    } catch {
      installed = [];
    }
    try {
      const wf = await import("../workflow/workflow-templates.mjs");
      const templates = wf.listTemplates ? wf.listTemplates() : [];
      return {
        count: templates.length,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name || t.id,
          description: (t.description || "").slice(0, 100),
        })),
        workflowCount: Array.isArray(installed) ? installed.length : 0,
        workflows: (Array.isArray(installed) ? installed : []).map((w) => ({
          id: w.id,
          name: w.name || w.id,
          enabled: w.enabled !== false,
          triggerCount: Array.isArray(w.triggers)
            ? w.triggers.length
            : (w.trigger ? 1 : 0),
          nodeCount: Number(w.nodeCount || (Array.isArray(w.nodes) ? w.nodes.length : 0)),
          edgeCount: Number(w.edgeCount || (Array.isArray(w.edges) ? w.edges.length : 0)),
          updatedAt: w?.metadata?.updatedAt || w.updatedAt || null,
        })),
      };
    } catch {
      return {
        count: 0,
        templates: [],
        workflowCount: Array.isArray(installed) ? installed.length : 0,
        workflows: (Array.isArray(installed) ? installed : []).map((w) => ({
          id: w.id,
          name: w.name || w.id,
          enabled: w.enabled !== false,
          triggerCount: Array.isArray(w.triggers)
            ? w.triggers.length
            : (w.trigger ? 1 : 0),
          nodeCount: Number(w.nodeCount || (Array.isArray(w.nodes) ? w.nodes.length : 0)),
          edgeCount: Number(w.edgeCount || (Array.isArray(w.edges) ? w.edges.length : 0)),
          updatedAt: w?.metadata?.updatedAt || w.updatedAt || null,
        })),
        error: "Workflow templates not available.",
      };
    }
  },

  async create_workflow(args = {}) {
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.save) return { ok: false, error: "Workflow engine is unavailable." };

    const hasDefinition = args.definition != null && args.definition !== "";
    const defInput = hasDefinition
      ? parseObjectArg(args.definition, "definition")
      : {};
    const normalized = normalizeWorkflowDefinition(defInput, args);
    const saved = engine.save(normalized);
    return {
      ok: true,
      workflow: {
        id: saved.id,
        name: saved.name || saved.id,
        enabled: saved.enabled !== false,
        nodeCount: Array.isArray(saved.nodes) ? saved.nodes.length : 0,
        edgeCount: Array.isArray(saved.edges) ? saved.edges.length : 0,
        updatedAt: saved?.metadata?.updatedAt || null,
      },
    };
  },

  async update_workflow_definition(args = {}) {
    const workflowId = String(args.workflowId || args.id || "").trim();
    if (!workflowId) return { ok: false, error: "workflowId is required." };
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.get || !engine?.save) return { ok: false, error: "Workflow engine is unavailable." };
    const existing = engine.get(workflowId);
    if (!existing) return { ok: false, error: `Workflow "${workflowId}" not found.` };

    const patchObj = parseObjectArg(
      args.patch ?? args.definition ?? args.workflow ?? {},
      "patch",
    );
    const replace = args.replace === true;
    const merged = replace
      ? { ...patchObj }
      : {
          ...existing,
          ...patchObj,
          metadata: {
            ...(existing.metadata || {}),
            ...(patchObj.metadata || {}),
          },
        };
    const normalized = normalizeWorkflowDefinition(merged, {
      ...args,
      workflowId,
      name: merged.name || existing.name,
    });
    const saved = engine.save(normalized);
    return {
      ok: true,
      workflow: {
        id: saved.id,
        name: saved.name || saved.id,
        enabled: saved.enabled !== false,
        nodeCount: Array.isArray(saved.nodes) ? saved.nodes.length : 0,
        edgeCount: Array.isArray(saved.edges) ? saved.edges.length : 0,
        updatedAt: saved?.metadata?.updatedAt || null,
      },
    };
  },

  async delete_workflow(args = {}) {
    const workflowId = String(args.workflowId || args.id || "").trim();
    if (!workflowId) return { ok: false, error: "workflowId is required." };
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.delete) return { ok: false, error: "Workflow engine is unavailable." };
    const deleted = await engine.delete(workflowId);
    return { ok: Boolean(deleted), workflowId, deleted: Boolean(deleted) };
  },

  async create_workflow_from_template(args = {}) {
    const templateId = String(args.templateId || args.id || "").trim();
    if (!templateId) return { ok: false, error: "templateId is required." };
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.save || !engine?.execute) return { ok: false, error: "Workflow engine is unavailable." };
    const wfTemplates = await import("../workflow/workflow-templates.mjs");
    if (typeof wfTemplates.installTemplate !== "function") {
      return { ok: false, error: "Workflow template installer is unavailable." };
    }
    const overrides = parseObjectArg(args.overrides ?? {}, "overrides");
    const saved = wfTemplates.installTemplate(templateId, engine, overrides);
    const executeAfterCreate = args.executeAfterCreate === true;
    let run = null;
    if (executeAfterCreate) {
      const input = parseObjectArg(args.input ?? {}, "input");
      const ctx = await engine.execute(saved.id, input);
      run = {
        runId: ctx?.id || null,
        status: Array.isArray(ctx?.errors) && ctx.errors.length > 0 ? "failed" : "completed",
        errorCount: Array.isArray(ctx?.errors) ? ctx.errors.length : 0,
      };
    }
    return {
      ok: true,
      workflow: {
        id: saved.id,
        name: saved.name || saved.id,
        enabled: saved.enabled !== false,
        installedFrom: saved?.metadata?.installedFrom || templateId,
        nodeCount: Array.isArray(saved.nodes) ? saved.nodes.length : 0,
        edgeCount: Array.isArray(saved.edges) ? saved.edges.length : 0,
      },
      run,
    };
  },

  async generate_workflow_with_agent(args = {}, context = {}) {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return { ok: false, error: "prompt is required." };
    const cfg = loadConfig();
    const pool = await getAgentPool();
    const executor = resolveVoiceExecutor({
      requestedExecutor: args.executor,
      context,
      cfg,
      pool,
    });

    const generationPrompt =
      "Generate a Bosun workflow JSON definition only. " +
      "Return strict JSON with keys: name, description, enabled, variables, nodes, edges, triggers, metadata. " +
      "Do not include markdown fences.\n\n" +
      `User request:\n${prompt}`;
    const result = await pool.execPooledPrompt(generationPrompt, {
      sdk: executor,
      mode: "agent",
      sessionId: context?.sessionId || `voice-workflow-generate-${Date.now()}`,
      metadata: { source: "voice-workflow-generator" },
      timeoutMs: 45_000,
      sessionType: "voice-workflow-generate",
    });
    const text = typeof result === "string"
      ? result
      : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
    const parsed = parseAnyJson(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        error: "Agent did not return valid workflow JSON.",
        raw: String(text || "").slice(0, 2000),
      };
    }
    const normalized = normalizeWorkflowDefinition(parsed, {
      enabled: typeof args.enabled === "boolean" ? args.enabled : false,
    });
    const shouldSave = args.save !== false;
    if (!shouldSave) {
      return { ok: true, saved: false, workflow: normalized };
    }
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.save) return { ok: false, error: "Workflow engine is unavailable." };
    const saved = engine.save(normalized);
    return {
      ok: true,
      saved: true,
      workflow: {
        id: saved.id,
        name: saved.name || saved.id,
        enabled: saved.enabled !== false,
        nodeCount: Array.isArray(saved.nodes) ? saved.nodes.length : 0,
        edgeCount: Array.isArray(saved.edges) ? saved.edges.length : 0,
      },
    };
  },

  async get_workflow_definition(args = {}) {
    const workflowId = String(args.workflowId || args.id || "").trim();
    if (!workflowId) return { ok: false, error: "workflowId is required." };
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.get) {
      return { ok: false, error: "Workflow engine is unavailable." };
    }
    const workflow = engine.get(workflowId);
    if (!workflow) return { ok: false, error: `Workflow "${workflowId}" not found.` };
    return {
      ok: true,
      workflow: {
        ...workflow,
        nodeCount: Array.isArray(workflow.nodes) ? workflow.nodes.length : 0,
        edgeCount: Array.isArray(workflow.edges) ? workflow.edges.length : 0,
        triggerCount: Array.isArray(workflow.triggers) ? workflow.triggers.length : 0,
      },
    };
  },

  async execute_workflow(args = {}) {
    const workflowId = String(args.workflowId || args.id || "").trim();
    if (!workflowId) return { ok: false, error: "workflowId is required." };
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.execute) return { ok: false, error: "Workflow engine is unavailable." };
    const input = parseObjectArg(args.input ?? {}, "input");
    const force = args.force === true;
    const ctx = await engine.execute(workflowId, input, { force });
    return {
      ok: true,
      run: {
        runId: ctx?.id || null,
        workflowId,
        status: Array.isArray(ctx?.errors) && ctx.errors.length > 0 ? "failed" : "completed",
        startedAt: Number(ctx?.startedAt) || null,
        endedAt: Number(ctx?.endedAt) || Date.now(),
        duration: Number(ctx?.duration) || null,
        errorCount: Array.isArray(ctx?.errors) ? ctx.errors.length : 0,
      },
    };
  },

  async list_workflow_runs(args = {}) {
    const workflowId = String(args.workflowId || args.id || "").trim();
    const statusFilter = String(args.status || "").trim().toLowerCase();
    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(200, Math.floor(rawLimit))
      : 20;
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.getRunHistory) {
      return { ok: false, error: "Workflow engine run history is unavailable." };
    }
    let runs = engine.getRunHistory(workflowId || null, limit);
    runs = Array.isArray(runs) ? runs : [];
    if (statusFilter) {
      runs = runs.filter((run) => String(run?.status || "").trim().toLowerCase() === statusFilter);
    }
    return {
      ok: true,
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
        activeNodeCount: run?.activeNodeCount ?? 0,
        isStuck: run?.isStuck === true,
        stuckMs: run?.stuckMs ?? 0,
        triggerEvent: run?.triggerEvent || null,
        triggerSource: run?.triggerSource || null,
      })),
    };
  },

  async get_workflow_run(args = {}) {
    const runId = String(args.runId || args.id || "").trim();
    if (!runId) return { ok: false, error: "runId is required." };
    const includeLogs = args.includeLogs !== false;
    const includeNodeStatusEvents = args.includeNodeStatusEvents === true;
    const rawLogLimit = Number(args.logLimit);
    const logLimit = Number.isFinite(rawLogLimit) && rawLogLimit > 0
      ? Math.min(500, Math.floor(rawLogLimit))
      : 120;
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.getRunDetail) {
      return { ok: false, error: "Workflow engine run detail is unavailable." };
    }
    const run = engine.getRunDetail(runId);
    if (!run) return { ok: false, error: `Workflow run "${runId}" not found.` };
    const detail = run?.detail && typeof run.detail === "object" ? run.detail : {};
    const logs = Array.isArray(detail.logs) ? detail.logs : [];
    const errors = Array.isArray(detail.errors) ? detail.errors : [];
    const nodeStatusEvents = Array.isArray(detail.nodeStatusEvents)
      ? detail.nodeStatusEvents
      : [];
    return {
      ok: true,
      run: {
        runId: run?.runId || runId,
        workflowId: run?.workflowId || null,
        workflowName: run?.workflowName || null,
        status: run?.status || "unknown",
        startedAt: run?.startedAt || null,
        endedAt: run?.endedAt ?? null,
        duration: run?.duration ?? null,
        errorCount: run?.errorCount ?? errors.length,
        logCount: run?.logCount ?? logs.length,
        nodeCount: run?.nodeCount ?? null,
        completedCount: run?.completedCount ?? null,
        failedCount: run?.failedCount ?? null,
        skippedCount: run?.skippedCount ?? null,
        activeNodeCount: run?.activeNodeCount ?? null,
        isStuck: run?.isStuck === true,
        triggerEvent: run?.triggerEvent || null,
        triggerSource: run?.triggerSource || null,
        data: detail?.data || null,
        errors,
        logs: includeLogs ? logs.slice(-logLimit) : [],
        nodeStatuses: detail?.nodeStatuses || {},
        nodeStatusEvents: includeNodeStatusEvents ? nodeStatusEvents : [],
      },
    };
  },

  async retry_workflow_run(args = {}) {
    const runId = String(args.runId || args.id || "").trim();
    if (!runId) return { ok: false, error: "runId is required." };
    const requestedMode = String(args.mode || "from_failed").trim().toLowerCase();
    const mode = requestedMode === "from_scratch" ? "from_scratch" : "from_failed";
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.retryRun) {
      return { ok: false, error: "Workflow retry is unavailable." };
    }
    const currentRun = engine?.getRunDetail ? engine.getRunDetail(runId) : null;
    if (!currentRun) return { ok: false, error: `Workflow run "${runId}" not found.` };
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
      return {
        ok: false,
        error: `retry mode "from_failed" requires a failed run. Current status is "${currentRun?.status || "unknown"}".`,
      };
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
      return {
        ok: false,
        error: resolvedRetry.blockedMessage || "Workflow retry is blocked for this run state.",
        mode: resolvedRetry.mode || mode,
        operatorAction: resolvedRetry.operatorAction || null,
        decisionReason: resolvedRetry.decisionReason || null,
        guardedState: resolvedRetry.guardedState || retryOptions?.guardedState || null,
        retryOptions,
      };
    }
    const retryArgs = resolvedRetry?.retryArgs || { mode };
    if (safeInterruptedResume && !resolvedRetry?.retryArgs) {
      retryArgs._resumeInterrupted = true;
      if (retryOptions?.recommendedReason) retryArgs._decisionReason = retryOptions.recommendedReason;
    }
    const result = await engine.retryRun(runId, retryArgs);
    return {
      ok: true,
      mode,
      originalRunId: result?.originalRunId || runId,
      retryRunId: result?.retryRunId || null,
      status: result?.ctx?.errors?.length ? "failed" : "running_or_completed",
      operatorAction:
        resolvedRetry?.operatorAction || (mode === "from_scratch" ? "restart" : "retry"),
      decisionReason: resolvedRetry?.decisionReason || null,
      guardedState: resolvedRetry?.guardedState || retryOptions?.guardedState || null,
    };
  },

  async analyze_workflow(args = {}) {
    const wfEngineMod = await getWorkflowEngineModule();
    const engine = typeof wfEngineMod.getWorkflowEngine === "function"
      ? wfEngineMod.getWorkflowEngine()
      : null;
    if (!engine?.list || !engine?.getRunHistory) {
      return { ok: false, error: "Workflow engine is unavailable." };
    }
    const workflowId = String(args.workflowId || args.id || "").trim();
    const rawLimit = Number(args.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(200, Math.floor(rawLimit))
      : 30;
    const targets = workflowId
      ? [engine.get(workflowId)].filter(Boolean)
      : engine.list().map((w) => engine.get(w.id)).filter(Boolean);
    if (workflowId && !targets.length) {
      return { ok: false, error: `Workflow "${workflowId}" not found.` };
    }
    const analyses = targets.map((wf) => {
      const runs = engine.getRunHistory(wf.id, limit) || [];
      const byStatus = {};
      for (const run of runs) {
        const status = String(run?.status || "unknown").trim().toLowerCase();
        byStatus[status] = (byStatus[status] || 0) + 1;
      }
      const failedCount = Number(byStatus.failed || 0);
      const completedCount = Number(byStatus.completed || 0);
      const evaluated = failedCount + completedCount;
      const failureRate = evaluated > 0 ? failedCount / evaluated : null;
      const latest = runs[0] || null;
      return {
        workflowId: wf.id,
        name: wf.name || wf.id,
        enabled: wf.enabled !== false,
        nodeCount: Array.isArray(wf.nodes) ? wf.nodes.length : Number(wf.nodeCount || 0),
        edgeCount: Array.isArray(wf.edges) ? wf.edges.length : Number(wf.edgeCount || 0),
        runCount: runs.length,
        byStatus,
        failureRate,
        latestRun: latest
          ? {
              runId: latest.runId || null,
              status: latest.status || "unknown",
              startedAt: latest.startedAt || null,
              duration: latest.duration ?? null,
              errorCount: latest.errorCount ?? 0,
              isStuck: latest.isStuck === true,
            }
          : null,
      };
    });
    return {
      ok: true,
      count: analyses.length,
      analyses,
    };
  },

  async list_skills() {
    try {
      const skills = await import("../agent/bosun-skills.mjs");
      const builtins = skills.BUILTIN_SKILLS || [];
      return {
        count: builtins.length,
        skills: builtins.map((s) => ({
          filename: s.filename,
          title: s.title,
          tags: s.tags || [],
        })),
      };
    } catch {
      return { count: 0, skills: [] };
    }
  },

  async list_prompts() {
    try {
      const prompts = await import("../agent/agent-prompts.mjs");
      const defs = prompts.getAgentPromptDefinitions
        ? prompts.getAgentPromptDefinitions()
        : prompts.AGENT_PROMPT_DEFINITIONS || [];
      let sync = {
        summary: {
          total: 0,
          missing: 0,
          upToDate: 0,
          updateAvailable: 0,
          needsReview: 0,
        },
        updateCandidates: [],
      };
      try {
        if (typeof prompts.getPromptDefaultUpdateStatus === "function") {
          const cwd = await resolveToolCwd({});
          const status = prompts.getPromptDefaultUpdateStatus(cwd);
          const updates = Array.isArray(status?.updates) ? status.updates : [];
          sync = {
            summary: status?.summary || sync.summary,
            updateCandidates: updates
              .filter((entry) => entry?.updateAvailable === true || entry?.needsReview === true)
              .map(toCompactPromptSyncUpdate),
          };
        }
      } catch {
        // best effort prompt sync metadata
      }
      return {
        count: defs.length,
        prompts: defs.map((d) => ({
          key: d.key,
          filename: d.filename,
          description: (d.description || "").slice(0, 80),
        })),
        sync,
      };
    } catch {
      return {
        count: 0,
        prompts: [],
        sync: {
          summary: {
            total: 0,
            missing: 0,
            upToDate: 0,
            updateAvailable: 0,
            needsReview: 0,
          },
          updateCandidates: [],
        },
      };
    }
  },

  async sync_prompt_defaults(args, context) {
    const apply = args?.apply === true;
    const cwd = await resolveToolCwd(context);
    const prompts = await import("../agent/agent-prompts.mjs");
    const getStatus = prompts.getPromptDefaultUpdateStatus;
    const applyUpdates = prompts.applyPromptDefaultUpdates;
    if (typeof getStatus !== "function" || typeof applyUpdates !== "function") {
      return {
        ok: false,
        error: "Prompt sync helpers are unavailable in agent-prompts.mjs.",
      };
    }

    if (!apply) {
      const status = getStatus(cwd);
      const updates = Array.isArray(status?.updates) ? status.updates : [];
      return {
        ok: true,
        workspaceDir: status?.workspaceDir || null,
        summary: status?.summary || {
          total: 0,
          missing: 0,
          upToDate: 0,
          updateAvailable: 0,
          needsReview: 0,
        },
        updates: updates.map(toCompactPromptSyncUpdate),
      };
    }

    const keys = normalizeStringArrayArg(args?.keys);
    const updateResult = applyUpdates(cwd, keys.length ? { keys } : {});
    return {
      ok: true,
      workspaceDir: updateResult?.workspaceDir || null,
      updated: Array.isArray(updateResult?.updated) ? updateResult.updated : [],
      skipped: Array.isArray(updateResult?.skipped) ? updateResult.skipped : [],
      summary: {
        requestedKeys: keys,
        updated: Array.isArray(updateResult?.updated) ? updateResult.updated.length : 0,
        skipped: Array.isArray(updateResult?.skipped) ? updateResult.skipped.length : 0,
      },
    };
  },

  async dispatch_action(args, context) {
    const action = String(args.action || "").trim();
    if (!action) return { error: "action name is required" };
    try {
      const { dispatchVoiceAction } = await import("./voice-action-dispatcher.mjs");
      const result = await dispatchVoiceAction(
        { action, params: args.params || {} },
        context,
      );
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Generic MCP gateway — routes arbitrary MCP tool calls through the agent
   * rather than requiring a bespoke voice-tool wrapper for each MCP operation.
   *
   * The approach (inspired by claude-phone's structured prompting):
   *   • Build a precise, structured prompt asking the agent to invoke the tool
   *   • Request a short spoken confirmation as the VOICE_RESPONSE: reply
   *   • Fall back gracefully if the agent can't find the tool
   *
  * This deliberately reuses the pooled agent for one-shot execution and
  * returns a clear error if invocation fails.
   */
  async invoke_mcp_tool(args, context) {
    const tool = String(args.tool || "").trim();
    if (!tool) return "{RESPONSE}: tool name is required.";
    const server = String(args.server || "").trim();
    const mcpArgs = args.args && typeof args.args === "object" ? args.args : {};
    const toolRef = server
      ? `the "${tool}" tool from the "${server}" MCP server`
      : `the "${tool}" MCP tool`;
    const serverHint = server ? ` Use the "${server}" MCP server.` : "";
    const argsJson = Object.keys(mcpArgs).length
      ? `\n\nCall it with these exact arguments:\n${JSON.stringify(mcpArgs, null, 2)}`
      : "";
    // Use a direct, strict MCP invocation prompt — no VOICE_CONTEXT preamble that
    // might confuse MCP routing in the executor.
    const taskPrompt =
      `Invoke ${toolRef} right now.${serverHint}${argsJson}\n\n` +
      `IMPORTANT: Actually call the tool — do not just describe it.\n` +
      `After invoking, respond ONLY with:\n` +
      `VOICE_RESPONSE: [exactly 1 sentence confirming what happened or the key result]`;

    const cfg = loadConfig();
    const pool = await getAgentPool();
    const executor = resolveVoiceExecutor({ context, cfg, pool });
    const model = String(context?.model || "").trim() || undefined;
    const cwd = await resolveToolCwd(context);

    try {
      const result = await pool.execPooledPrompt(taskPrompt, {
        sdk: executor,
        mode: "instant",
        model,
        cwd,
        timeoutMs: 15_000,
        sessionType: "voice-mcp",
      });
      const text = typeof result === "string"
        ? result
        : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
      const trimmed = String(text || "").trim();
      if (!trimmed) return "{RESPONSE}: MCP tool returned no output.";
      return `{RESPONSE}: ${formatVoiceToolResult(trimmed)}`;
    } catch (err) {
      const reason = String(err?.message || "tool invocation failed").trim();
      return `{RESPONSE}: MCP tool invocation failed: ${reason}. Please verify the tool/server name and arguments.`;
    }
  },

  /**
   * Pre-warm the agent with a quick repo overview so follow-up codebase
   * questions benefit from cached context instead of a cold-start lookup.
   *
   * Fire-and-forget: returns immediately and loads in the background.
   */
  async warm_codebase_context(args, context) {
    const cwd = await resolveToolCwd(context);
    let topLevel = [];
    try {
      const { readdirSync } = await import("node:fs");
      topLevel = readdirSync(cwd)
        .filter((n) => !n.startsWith(".") && n !== "node_modules")
        .slice(0, 25);
    } catch {
      // best effort
    }
    const warmPrompt = `You are being pre-loaded with workspace context for an upcoming voice session.\nTop-level items in the project: ${topLevel.join(", ") || "(unknown)"}\nBriefly orient yourself to the project structure so you can answer questions quickly.`;
    TOOL_HANDLERS.ask_agent_context({ message: warmPrompt, mode: "instant" }, context).catch(() => {});
    return "{RESPONSE}: Codebase context pre-loading started in the background.";
  },

  // ── Slash Command Router ─────────────────────────────────────────────────

  /**
   * Routes Bosun slash commands to the appropriate tool handler.
  * Supports /instant, /ask, /background (/bg), /status, /tasks, /agents,
  * /health, /version, /mcp, /prompts, /promptsync.
   */
  async bosun_slash_command(args, context) {
    const raw = String(args.command || "").trim();
    if (!raw.startsWith("/")) {
      return `{RESPONSE}: Command must start with / (received: "${raw}"). Example: /instant summarize the auth module.`;
    }
    const parts = raw.slice(1).split(/\s+/);
    const base = parts[0].toLowerCase();
    const rest = parts.slice(1).join(" ").trim();

    // ── Agent mode shortcuts ──────────────────────────────────────────────
    const INLINE_MODES = { instant: "instant", ask: "ask" };
    if (INLINE_MODES[base] !== undefined) {
      if (!rest) return `{RESPONSE}: Usage: /${base} <prompt>`;
      return TOOL_HANDLERS.ask_agent_context(
        { message: rest, mode: INLINE_MODES[base] },
        context,
      );
    }

    const HANDOFF_BASES = new Set(["background", "bg", "agent", "handoff"]);
    if (HANDOFF_BASES.has(base)) {
      if (!rest) return `{RESPONSE}: Usage: /${base} <task description>`;
      return TOOL_HANDLERS.delegate_to_agent(
        { message: rest, mode: "agent" },
        context,
      );
    }

    // ── System info commands ──────────────────────────────────────────────
    const INFO_BASES = new Set(["status", "health", "tasks", "agents", "fleet", "version", "config"]);
    if (INFO_BASES.has(base)) {
      return TOOL_HANDLERS.run_command(
        { command: rest ? `${base} ${rest}` : base },
        context,
      );
    }

    // ── /mcp <tool_name> [server=<name>] ─────────────────────────────────
    if (base === "mcp") {
      const mcpParts = rest.split(/\s+/);
      const toolName = mcpParts[0] || "";
      if (!toolName) return `{RESPONSE}: Usage: /mcp <tool_name> [server=<name>]`;
      // Parse optional server=<name> or bare server name from remaining tokens
      let server = "";
      for (const tok of mcpParts.slice(1)) {
        const m = tok.match(/^server=(.+)$/i);
        if (m) { server = m[1]; break; }
        if (!tok.includes("=")) { server = tok; break; }
      }
      return TOOL_HANDLERS.invoke_mcp_tool({ tool: toolName, server }, context);
    }

    // ── /help — full listing of voice capabilities ──────────────────────
    if (base === "help" || base === "helpfull") {
      return TOOL_HANDLERS.get_admin_help({}, context);
    }

    // ── /logs [type] [lines] ─────────────────────────────────────────────
    if (base === "logs" || base === "log" || base === "agentlogs") {
      const logParts = rest.split(/\s+/);
      const type = logParts[0] || (base === "agentlogs" ? "agent" : "agent");
      const lines = Number(logParts[1]) || 50;
      return TOOL_HANDLERS.get_recent_logs({ type, lines }, context);
    }

    // ── /sessions [limit] ────────────────────────────────────────────────
    if (base === "sessions" || base === "history") {
      const limit = Number(rest) || 10;
      return TOOL_HANDLERS.list_sessions({ limit, includeHistory: base === "history" }, context);
    }

    // ── /effectiveconfig ─────────────────────────────────────────────────
    if (base === "effectiveconfig" || base === "fullconfig" || base === "configdump") {
      return TOOL_HANDLERS.get_effective_config({ key: rest || undefined }, context);
    }

    // ── /pr [limit] ─────────────────────────────────────────────────────
    if (base === "pr" || base === "prs" || base === "pullrequests") {
      const limit = Number(rest) || 10;
      return TOOL_HANDLERS.get_pr_status({ limit }, context);
    }

    if (base === "commands") {
      return TOOL_HANDLERS.bosun_slash_command({ command: "/helpfull" }, context);
    }

    // ── /prompts + /promptsync [apply [keys...]] ────────────────────────
    if (base === "prompts" || base === "promptsync") {
      if (!rest) {
        return TOOL_HANDLERS.sync_prompt_defaults({ apply: false }, context);
      }
      const lowerRest = rest.toLowerCase();
      if (lowerRest === "apply" || lowerRest.startsWith("apply ")) {
        const keyText = String(rest.slice(5) || "").trim();
        const keys = normalizeStringArrayArg(keyText);
        return TOOL_HANDLERS.sync_prompt_defaults(
          keys.length ? { apply: true, keys } : { apply: true },
          context,
        );
      }
      return "{RESPONSE}: Usage: /promptsync [apply [key1,key2 or key1 key2]]";
    }

    // ── /workspace <shell command> ────────────────────────────────────────
    if (base === "workspace" || base === "shell" || base === "run") {
      if (!rest) return `{RESPONSE}: Usage: /${base} <shell command>`;
      return TOOL_HANDLERS.run_workspace_command({ command: rest }, context);
    }

    const supported = [
      "/instant", "/ask", "/agent", "/handoff", "/status", "/health", "/tasks", "/agents",
      "/fleet", "/version", "/config", "/effectiveconfig", "/commands", "/help", "/helpfull",
      "/logs", "/sessions", "/history", "/pr", "/prs", "/pullrequests", "/mcp", "/workspace",
      "/shell", "/run", "/prompts", "/promptsync",
    ];
    return `{RESPONSE}: Unknown slash command "${raw}". Supported commands: ${supported.join(", ")}.`;
  },

  // ── Workspace Shell Execution ────────────────────────────────────────────

  /**
  * Runs a safe, read-only shell command in the workspace and returns stdout.
  * Non-safe commands are blocked for non-owner sessions and require explicit
  * confirmation for owner/admin direct execution.
   */
  async run_workspace_command(args, context) {
    const rawCmd = String(args.command || "").trim();
    if (!rawCmd) return "{RESPONSE}: command is required.";

    // Only execute obviously read-only commands directly, based on the
    // shared SAFE_WORKSPACE_COMMAND_PATTERNS defined at module scope.
    const SAFE_PATTERNS = SAFE_WORKSPACE_COMMAND_PATTERNS;

    const isSafe = SAFE_PATTERNS.some((p) => p.test(rawCmd));
    if (!isSafe && !canRunWritableWorkspaceCommand(context)) {
      return "{RESPONSE}: Blocked non-read-only workspace command for this session. Ask an owner/admin to run it, or switch to a delegated agent workflow.";
    }

    try {
      const { spawnSync } = await import("node:child_process");
      const cwd = await resolveToolCwd(context);
      const repoRoot = resolveAgentRepoRoot();
      const effectiveCmd = resolveManagedWorktreeCommand(rawCmd, {
        repoRoot,
        executionDir: cwd,
      });
      const { error: tokenError, tokens } = tokenizeWorkspaceCommand(effectiveCmd);
      if (tokenError) {
        return `{RESPONSE}: ${tokenError}`;
      }
      if (tokens.length === 0) {
        return "{RESPONSE}: command is required.";
      }
      const commandAllowlist = Object.freeze({
        git: "git",
        npm: "npm",
        node: "node",
        ls: "ls",
        cat: "cat",
        head: "head",
        tail: "tail",
        wc: "wc",
        find: "find",
        grep: "grep",
        echo: "echo",
        pwd: "pwd",
        which: "which",
        type: "type",
      });
      const requestedCmd = String(tokens[0] || "").toLowerCase();
      const safeCmd = commandAllowlist[requestedCmd];
      if (!safeCmd) {
        return "{RESPONSE}: Command is not allowlisted for direct execution.";
      }
      const cmdArgs = tokens.slice(1);
      const executable = resolveWorkspaceCommandExecutable(safeCmd);
      const useShell = shouldUseWorkspaceCommandShell(safeCmd);
      const hasShellMeta = hasUnsafeWorkspaceShellMetacharacters(effectiveCmd);
      if (hasShellMeta) {
        return "{RESPONSE}: Shell metacharacters are not allowed in direct workspace commands. Run one command per tool call without &&, |, ;, >, $, or backticks.";
      }
      const timeoutMs = resolveWorkspaceCommandTimeoutMs(safeCmd, cmdArgs);
      const maxBuffer = resolveWorkspaceCommandMaxBuffer(safeCmd, cmdArgs);
      const res = spawnSync(executable, cmdArgs, {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        cwd,
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const err = new Error(String(res.stderr || res.stdout || "command failed").trim());
        err.stderr = res.stderr;
        err.stdout = res.stdout;
        throw err;
      }
      const trimmed = String(res.stdout || "").trim();
      if (!trimmed) return describeWorkspaceCommandNoOutput(safeCmd, cmdArgs);
      return trimmed.length > 3000
        ? describeWorkspaceCommandTruncatedOutput(safeCmd, cmdArgs, trimmed)
        : trimmed;
    } catch (err) {
      const stderr = String(err?.stderr || "").trim();
      const stdout = String(err?.stdout || "").trim();
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      const summary = String(err?.message || "command failed").split("\n")[0];
      return `Command failed: ${summary}${combined ? `\n${combined.slice(0, 500)}` : ""}`;
    }
  },

  // ── Background Session Polling ───────────────────────────────────────────

  /**
   * Polls a background session started by delegate_to_agent.
   * Returns the current status and the last few messages.
   */
  async poll_background_session(args, context) {
    const bgId = String(args.backgroundSessionId || "").trim();
    if (!bgId) return "{RESPONSE}: backgroundSessionId is required.";
    const limit = Math.min(Number(args.limit) || 5, 20);

    try {
      const tracker = await getSessionTracker();
      const session =
        tracker.getSessionById?.(bgId) || tracker.getSession?.(bgId) || null;
      if (!session) {
        return `{RESPONSE}: Background session "${bgId}" not found. It may have expired or the ID is incorrect.`;
      }

      const status = String(session.status || "running").trim();
      const messages = (Array.isArray(session.messages) ? session.messages : []).slice(-limit);

      // Find the most informative recent message (assistant or system summary)
      const relevant = messages
        .filter((m) => {
          const role = String(m?.role || "").toLowerCase();
          const content = String(m?.content || "");
          return (
            (role === "assistant" || (role === "system" && content.includes("{RESPONSE}"))) &&
            content.trim().length > 0
          );
        })
        .slice(-1)[0];

      const latestText = relevant
        ? formatVoiceToolResult(
            String(relevant.content || "")
              .replace(/^\{RESPONSE\}:\s*/i, "")
              .trim(),
          )
        : "(no output yet)";

      return `{RESPONSE}: Background session ${bgId} is ${status}. Latest: ${latestText}`;
    } catch (err) {
      return `{RESPONSE}: Could not poll session: ${String(err?.message || "unknown error")}`;
    }
  },
};

export { TOOL_DEFS as VOICE_TOOLS };

/**
 * Convenience export so voice-relay.mjs (and future callers) can trigger a
 * context warm-up at voice session open without importing internal handlers.
 *
 * @param {object} context — voice call context ({ sessionId, executor, ... })
 * @returns {Promise<void>}
 */
export async function warmCodebaseContext(context = {}) {
  await TOOL_HANDLERS.warm_codebase_context({}, context).catch(() => {});
}
