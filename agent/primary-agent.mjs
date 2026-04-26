/**
 * primary-agent.mjs — Adapter that selects the primary agent implementation.
 *
 * Transitional architecture note:
 * Canonical harness lifecycle, session ownership, and per-turn orchestration
 * live in `session-manager.mjs`, `internal-harness-runtime.mjs`, and
 * `agent/harness/*`. Shell transport parity lives in
 * `shell/shell-adapter-registry.mjs`. Do not add new long-term lifecycle
 * ownership here.
 *
 * Supports Codex SDK, Copilot SDK, and Claude SDK.
 * Includes timeout detection and automatic failover between adapters.
 */

import { loadConfig } from "../config/config.mjs";
import { ensureCodexConfig, printConfigSummary } from "../shell/codex-config.mjs";
import { ensureRepoConfigs, printRepoConfigSummary } from "../config/repo-config.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { buildArchitectEditorFrame } from "../lib/repo-map.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { buildContextEnvelope, maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { getEntry, getEntryContent, resolveAgentProfileLibraryMetadata } from "../infra/library-manager.mjs";
import { execPooledPrompt } from "./agent-pool.mjs";
import { executorToAdapterName, normalizeProviderAdapterName } from "./provider-registry.mjs";
import { createProviderKernel } from "./provider-kernel.mjs";
import { readHarnessExecutorFabric } from "./harness-executor-config.mjs";
import { createQueryEngine } from "./query-engine.mjs";
import {
  createHarnessFailoverController,
  createHarnessProviderSessionRuntime,
} from "./internal-harness-control-plane.mjs";
import { getBosunSessionManager } from "./session-manager.mjs";
import { buildToolCapabilityContract } from "./tool-orchestrator.mjs";
import { normalizeProviderDefinitionId } from "./providers/index.mjs";
import { createShellSessionCompat } from "../shell/shell-session-compat.mjs";
import { createShellAdapterRegistry } from "../shell/shell-adapter-registry.mjs";

/** Valid agent interaction modes */
const CORE_MODES = ["ask", "agent", "plan", "web", "instant"];
/** Custom modes loaded from library */
const _customModes = new Map();

const MODE_ALIASES = Object.freeze({
  code: "agent",
  implement: "agent",
  execute: "agent",
  architect: "plan",
  design: "plan",
  chat: "ask",
  question: "ask",
  fast: "instant",
  quick: "instant",
  browser: "web",
});

/** Current interaction mode — affects how prompts are framed */
let agentMode = "agent";
const primarySessionManager = getBosunSessionManager();

/**
 * Mode-specific prompt prefixes prepended to user messages.
 * - "ask"   → brief, direct answer without tool use
 * - "agent" → full agentic behavior (default, no prefix needed)
 * - "plan"  → create a plan but do not execute it
 * - "web"   → web-style direct answer, avoid file changes or heavy tooling
 * - "instant" → ultra-fast answer path for back-and-forth
 */
const MODE_PREFIXES = {
  ask: "[MODE: ask] Respond briefly and directly. Avoid using tools unless absolutely necessary. Do not make code changes.\n\n",
  agent: "",
  plan: "[MODE: plan] Create a detailed plan for the following request but do NOT execute it. Outline the steps, files involved, and approach without making any changes.\n\n",
  web: "[MODE: web] Respond in a concise, web-assistant style. Prioritize immediate answers and lightweight checks. Avoid code edits and long-running operations unless explicitly requested.\n\n",
  instant: "[MODE: instant] Respond immediately with the fastest useful answer. Keep it short, avoid deep tool use, and do not make code changes unless explicitly requested.\n\n",
};

const MODE_EXEC_POLICIES = Object.freeze({
  web: {
    timeoutMs: Number(process.env.PRIMARY_AGENT_WEB_TIMEOUT_MS) || 2 * 60 * 1000,
    maxFailoverAttempts: Number(process.env.PRIMARY_AGENT_WEB_FAILOVER_ATTEMPTS) || 0,
  },
  instant: {
    timeoutMs: Number(process.env.PRIMARY_AGENT_INSTANT_TIMEOUT_MS) || 90 * 1000,
    maxFailoverAttempts: Number(process.env.PRIMARY_AGENT_INSTANT_FAILOVER_ATTEMPTS) || 0,
  },
});

function normalizePrimarySessionScope(sessionType = "primary", explicitScope = "") {
  const normalizedScope = String(explicitScope || "").trim();
  if (normalizedScope) return normalizedScope;
  const normalizedType = String(sessionType || "primary").trim() || "primary";
  return normalizedType === "primary" ? "primary" : normalizedType;
}

function getPrimarySessionCompat(sessionType = "primary", scope = "") {
  return createShellSessionCompat({
    adapterName: activeAdapter.name,
    providerSelection: activeExecutorSelection || activeAdapter.name,
    scope: normalizePrimarySessionScope(sessionType, scope),
    sessionType,
    sessionManager: primarySessionManager,
  });
}

const primarySessionAbortControllers = new Map();

function setPrimarySessionAbortController(sessionId, controller = null) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;
  if (!controller) {
    primarySessionAbortControllers.delete(normalizedSessionId);
    return null;
  }
  primarySessionAbortControllers.set(normalizedSessionId, controller);
  return controller;
}

function getPrimarySessionAbortController(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  return normalizedSessionId ? (primarySessionAbortControllers.get(normalizedSessionId) || null) : null;
}

function normalizePrimaryControllerPrompt(runRequest = {}) {
  return String(
    runRequest.prompt
    || runRequest.message
    || runRequest.userMessage
    || "",
  ).trim();
}

function bindPrimarySessionController(sessionId, defaults = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const primarySessionCompat = getPrimarySessionCompat(
    defaults.sessionType || "primary",
    defaults.scope || "",
  );
  if (!normalizedSessionId || typeof primarySessionCompat?.bindController !== "function") {
    return null;
  }
  return primarySessionCompat.bindController(normalizedSessionId, {
    abort(reason = "aborted") {
      const abortController = getPrimarySessionAbortController(normalizedSessionId);
      if (abortController && !abortController.signal.aborted) {
        try {
          abortController.abort(reason);
        } catch {
          /* best effort */
        }
      }
    },
    steer(prompt, meta = {}) {
      if (typeof activeAdapter?.steer !== "function") {
        return {
          ok: false,
          delivered: false,
          reason: "not_steerable",
          interventionType: String(meta?.kind || meta?.type || "steer").trim() || "steer",
          stageId: null,
          targetTaskKey: normalizedSessionId,
        };
      }
      try {
        const response = activeAdapter.steer(prompt);
        return {
          ok: response !== false,
          delivered: response !== false,
          reason: response === false ? "adapter_rejected" : null,
          interventionType: String(meta?.kind || meta?.type || "steer").trim() || "steer",
          stageId: null,
          targetTaskKey: normalizedSessionId,
        };
      } catch (error) {
        return {
          ok: false,
          delivered: false,
          reason: String(error?.message || error || "steer_failed"),
          interventionType: String(meta?.kind || meta?.type || "steer").trim() || "steer",
          stageId: null,
          targetTaskKey: normalizedSessionId,
        };
      }
    },
    async run(runRequest = {}) {
      const prompt = normalizePrimaryControllerPrompt(runRequest);
      if (!prompt) {
        throw new Error(`Primary session "${normalizedSessionId}" continuation requires a prompt`);
      }
      const abortController =
        runRequest.abortController instanceof AbortController
          ? runRequest.abortController
          : new AbortController();
      setPrimarySessionAbortController(normalizedSessionId, abortController);
      try {
        return await execPrimaryPrompt(prompt, {
          ...defaults,
          ...runRequest,
          sessionId: normalizedSessionId,
          abortController,
          metadata: {
            ...(defaults.metadata && typeof defaults.metadata === "object" ? defaults.metadata : {}),
            ...(runRequest.metadata && typeof runRequest.metadata === "object" ? runRequest.metadata : {}),
          },
          skipUserMessageRecord: runRequest.skipUserMessageRecord ?? false,
        });
      } finally {
        if (getPrimarySessionAbortController(normalizedSessionId) === abortController) {
          setPrimarySessionAbortController(normalizedSessionId, null);
        }
      }
    },
  });
}

function normalizeAgentMode(rawMode, fallback = "agent") {
  const normalized = String(rawMode || "").trim().toLowerCase();
  if (!normalized) return fallback;
  const mapped = MODE_ALIASES[normalized] || normalized;
  return getValidModes().includes(mapped) ? mapped : fallback;
}

/**
 * Get all valid modes including dynamically registered custom modes.
 * @returns {string[]}
 */
function getValidModes() {
  return [...CORE_MODES, ..._customModes.keys()];
}

/**
 * Get mode prefix for a given mode, including custom modes.
 * @param {string} mode
 * @returns {string}
 */
function getModePrefix(mode) {
  if (MODE_PREFIXES[mode] !== undefined) return MODE_PREFIXES[mode];
  const custom = _customModes.get(mode);
  return custom?.prefix || "";
}

/**
 * Get execution policy for a given mode, including custom modes.
 * @param {string} mode
 * @returns {object|null}
 */
function getModeExecPolicy(mode) {
  if (MODE_EXEC_POLICIES[mode]) return MODE_EXEC_POLICIES[mode];
  const custom = _customModes.get(mode);
  return custom?.execPolicy || null;
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(Boolean);
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const value = Number(bytes);
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const size = value / Math.pow(1024, idx);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[idx]}`;
}

function formatAttachmentLine(attachment) {
  const name = attachment.name || attachment.filename || attachment.title || "attachment";
  const kind = attachment.kind ? ` (${attachment.kind})` : "";
  const sizeText = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  const location =
    attachment.filePath ||
    attachment.path ||
    attachment.url ||
    attachment.uri ||
    "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${sizeText}${suffix}`;
}

function appendAttachmentsToPrompt(message, attachments) {
  const list = normalizeAttachments(attachments);
  if (!list.length) return { message, appended: false };
  const lines = ["", "Attachments:", ...list.map(formatAttachmentLine)];
  return { message: `${message}${lines.join("\n")}`, appended: true };
}





function summarizeContextCompressionItems(items) {
  const envelope = buildContextEnvelope({ scope: "continuation", items });
  if (!envelope) return null;
  return {
    total: envelope.meta?.total || 0,
    counts: envelope.meta?.counts || { agent: 0, user: 0, tool: 0, other: 0 },
    detail: envelope.meta?.detail || "",
    toolFamilies: envelope.meta?.toolFamilies || {},
    budgetPolicies: envelope.meta?.budgetPolicies || {},
    lowSignalToolCount: envelope.meta?.lowSignalToolCount || 0,
    content: envelope.content,
  };
}

function buildPrimaryToolCapabilityContract(options = {}) {
  return buildToolCapabilityContract(options);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function resolveSelectedAgentProfileContext(rootDir, agentProfileId) {
  const id = String(agentProfileId || "").trim();
  if (!id) return null;
  const entry = getEntry(rootDir, id);
  if (!entry || entry.type !== "agent") return null;
  const profile = getEntryContent(rootDir, entry);
  if (!profile || typeof profile !== "object") return null;

  const metadata = resolveAgentProfileLibraryMetadata(entry, profile);
  const promptEntry = profile?.promptOverride ? getEntry(rootDir, profile.promptOverride) : null;
  const promptContent = promptEntry ? getEntryContent(rootDir, promptEntry) : null;
  const skills = toStringArray(profile?.skills)
    .map((skillId) => {
      const skillEntry = getEntry(rootDir, skillId);
      if (!skillEntry || skillEntry.type !== "skill") return null;
      return {
        id: skillEntry.id,
        name: skillEntry.name || skillEntry.id,
        content: String(getEntryContent(rootDir, skillEntry) || "").trim(),
      };
    })
    .filter(Boolean);

  return {
    id: entry.id,
    name: entry.name || entry.id,
    description: entry.description || "",
    profile,
    metadata,
    promptOverride: promptEntry
      ? {
        id: promptEntry.id,
        name: promptEntry.name || promptEntry.id,
        content: typeof promptContent === "string"
          ? promptContent.trim()
          : String(promptContent || "").trim(),
      }
      : null,
    skills,
  };
}

function buildPrimaryAgentProfileContract(options = {}) {
  let rootDir = "";
  try {
    rootDir = String(options.cwd || resolveRepoRoot() || process.cwd()).trim();
  } catch {
    rootDir = String(options.cwd || process.cwd()).trim();
  }
  const selected = resolveSelectedAgentProfileContext(rootDir, options.agentProfileId);
  if (!selected) return { block: "", preferredMode: "", preferredModel: "" };

  const profileInstructions = String(
    selected.profile?.instructions
      || selected.profile?.manualInstructions
      || selected.profile?.voiceInstructions
      || "",
  ).trim();
  const summary = {
    id: selected.id,
    name: selected.name,
    description: selected.description,
    agentCategory: selected.metadata.agentCategory,
    interactiveMode: selected.metadata.interactiveMode,
    interactiveLabel: selected.metadata.interactiveLabel,
    sdk: String(selected.profile?.sdk || "").trim() || null,
    model: String(selected.profile?.model || "").trim() || null,
    showInChatDropdown: selected.metadata.showInChatDropdown,
    skillIds: selected.skills.map((skill) => skill.id),
  };
  const lines = [
    "## Selected Agent Profile",
    "Apply this profile consistently unless the user explicitly overrides it.",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
  ];
  if (profileInstructions) {
    lines.push("## Profile Instructions", profileInstructions);
  }
  if (selected.promptOverride?.content) {
    lines.push(`## Prompt Override: ${selected.promptOverride.name}`, selected.promptOverride.content);
  }
  if (selected.skills.length > 0) {
    lines.push("## Profile Skills");
    for (const skill of selected.skills) {
      if (!skill.content) continue;
      lines.push(`### ${skill.name}`, skill.content);
    }
  }
  return {
    block: lines.join("\n\n"),
    preferredMode: String(selected.metadata.interactiveMode || "").trim(),
    preferredModel: String(selected.profile?.model || "").trim(),
  };
}

const ADAPTERS = createShellAdapterRegistry({
  withRuntimeOptions(adapterName, options = {}) {
    return normalizeProviderAdapterName(adapterName) === "opencode-sdk"
      ? withProviderRuntimeOptions(options)
      : options;
  },
});

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

let activeAdapter = ADAPTERS["codex-sdk"];
let activeExecutorSelection = "codex-sdk";
let primaryProfile = null;
let primaryFallbackReason = null;
let initialized = false;
const primaryQueryEngine = createQueryEngine();
const primaryFailoverController = createHarnessFailoverController({
  queryEngine: primaryQueryEngine,
});
const primaryProviderSessionRuntime = createHarnessProviderSessionRuntime();
const primaryProviderKernel = createProviderKernel({
  adapters: ADAPTERS,
  getConfig: () => loadConfig() || {},
  env: process.env,
  readBusy: readAdapterBusy,
  getAdapterCapabilities,
  sessionManager: primarySessionManager,
});

const CONFIG_WARNING_THROTTLE_MS = 5 * 60 * 1000;
const _configWarningCache = new Map();

function warnConfigIssueThrottled(key, message) {
  const now = Date.now();
  const prev = _configWarningCache.get(key) || 0;
  if (now - prev < CONFIG_WARNING_THROTTLE_MS) {
    return;
  }
  _configWarningCache.set(key, now);
  console.warn(message);
}

function normalizePrimarySdkName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-sdk$/, "");
}

function ensurePrimaryAgentConfigs(primaryName) {
  const primarySdk = normalizePrimarySdkName(primaryName) || "codex";
  const allowRuntimeCodexMutation = envFlagEnabled(
    process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION,
  );
  let repoRoot = "";
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    repoRoot = "";
  }

  if (repoRoot) {
    if (!process.env.REPO_ROOT) process.env.REPO_ROOT = repoRoot;
    if (!process.env.BOSUN_AGENT_REPO_ROOT) {
      process.env.BOSUN_AGENT_REPO_ROOT = repoRoot;
    }
    try {
      const repoResult = ensureRepoConfigs(repoRoot, {
        primarySdk,
      });
      const logLines = [];
      printRepoConfigSummary(repoResult, (msg) => logLines.push(msg));
      if (logLines.some((line) => line.includes("created") || line.includes("updated"))) {
        console.log("[primary-agent] Repo config refresh:");
        for (const line of logLines) console.log(`[primary-agent] ${line}`);
      }
    } catch (err) {
      warnConfigIssueThrottled(
        `repo-config:${repoRoot}`,
        `[primary-agent] failed to ensure repo config for ${repoRoot}: ${err?.message || err}`,
      );
    }
  }

  try {
    const codexResult = ensureCodexConfig({
      env: process.env,
      primarySdk,
      dryRun: !allowRuntimeCodexMutation,
    });
    if (!codexResult?.noChanges) {
      if (!allowRuntimeCodexMutation) {
        console.log(
          "[primary-agent] Codex config drift detected (runtime is read-only; run `node cli.mjs --setup` to apply).",
        );
      } else {
        console.log("[primary-agent] Codex config refresh:");
      }
      printConfigSummary(codexResult, (msg) => console.log(`[primary-agent] ${msg}`));
    }
  } catch (err) {
    warnConfigIssueThrottled(
      "codex-config",
      `[primary-agent] failed to ensure Codex config: ${err?.message || err}`,
    );
  }
}

function normalizePrimaryAgent(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "codex-sdk";
  const normalized = normalizeProviderAdapterName(raw);
  if (normalized !== "codex-sdk" || raw === "codex" || raw === "codex-sdk") {
    return normalized;
  }
  if (["copilot", "copilot-sdk", "github-copilot"].includes(raw)) return "copilot-sdk";
  if (["claude", "claude-sdk", "claude_code", "claude-code"].includes(raw)) return "claude-sdk";
  if (["gemini", "gemini-sdk", "google-gemini"].includes(raw)) return "gemini-sdk";
  if (["opencode", "opencode-sdk", "open-code"].includes(raw)) return "opencode-sdk";
  return raw;
}

function resolvePrimarySelectionToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalizedProviderId = normalizeProviderDefinitionId(raw, "");
  if (normalizedProviderId && normalizedProviderId === raw.toLowerCase()) {
    return normalizedProviderId;
  }
  const resolvedSelection = resolveAgentSelection(raw);
  if (resolvedSelection?.selectionId === raw) {
    return raw;
  }
  return normalizePrimaryAgent(raw);
}

function selectPrimaryExecutor(config) {
  const executors = config?.executorConfig?.executors || [];
  if (!executors.length) return null;
  const primary = executors.find(
    (e) => (e.role || "").toLowerCase() === "primary",
  );
  return primary || executors[0];
}

function executorToAdapter(executor) {
  return executorToAdapterName(executor);
}

function readAdapterBusy(adapter) {
  try {
    return adapter.isBusy();
  } catch {
    return false;
  }
}

function getAdapterCapabilities(adapter) {
  return {
    sessions: typeof adapter.listSessions === "function",
    steering: typeof adapter.steer === "function",
    sdkCommands: adapter.sdkCommands || [],
  };
}

function resolveAgentSelection(name) {
  return primaryProviderKernel.resolveSelection(name);
}

function resolvePrimaryAgent(nameOrConfig) {
  if (typeof nameOrConfig === "string" && nameOrConfig.trim()) {
    return resolvePrimarySelectionToken(nameOrConfig);
  }
  if (nameOrConfig && typeof nameOrConfig === "object") {
    const harnessPrimary = resolvePrimarySelectionToken(nameOrConfig?.harness?.primaryExecutor || "");
    if (harnessPrimary) return harnessPrimary;
    const configuredDefault = normalizeProviderDefinitionId(
      nameOrConfig?.providers?.defaultProvider || "",
      "",
    );
    if (configuredDefault) return configuredDefault;
    const direct = resolvePrimarySelectionToken(nameOrConfig.primaryAgent);
    if (direct) return direct;
  }
  if (process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK) {
    return resolvePrimarySelectionToken(
      process.env.PRIMARY_AGENT || process.env.PRIMARY_AGENT_SDK,
    );
  }
  const cfg = loadConfig();
  const harnessPrimary = resolvePrimarySelectionToken(cfg?.harness?.primaryExecutor || "");
  if (harnessPrimary) return harnessPrimary;
  const configuredDefault = normalizeProviderDefinitionId(
    cfg?.providers?.defaultProvider || process.env.BOSUN_PROVIDER_DEFAULT || "",
    "",
  );
  if (configuredDefault) return configuredDefault;
  const direct = resolvePrimarySelectionToken(cfg?.primaryAgent || "");
  if (direct) return direct;
  primaryProfile = selectPrimaryExecutor(cfg);
  const profileName = String(primaryProfile?.name || "").trim();
  if (profileName) return profileName;
  const mapped = executorToAdapter(primaryProfile?.executor);
  return mapped || "codex-sdk";
}

function resolveActiveProviderRuntimeConfig() {
  const runtime = primaryProviderKernel.resolveRuntime(
    activeExecutorSelection,
    activeAdapter?.name,
  );
  if (!runtime.providerId || !runtime.providerConfig) {
    return null;
  }
  return {
    providerId: runtime.providerId,
    providerConfig: runtime.providerConfig,
  };
}

function withProviderRuntimeOptions(options = {}) {
  return primaryProviderKernel.withRuntimeOptions(
    activeAdapter?.name,
    activeExecutorSelection,
    options,
  );
}

function createPrimaryExecutionSession(adapterName = "", options = {}) {
  return primaryProviderKernel.createExecutionSession({
    adapterName: adapterName || activeAdapter.name,
    selectionId: activeExecutorSelection || adapterName || activeAdapter?.name || "",
    sessionId: options.sessionId || null,
    threadId: options.threadId || options.sessionId || null,
    model: options.model || null,
    metadata: options.metadata || {},
    cwd: options.cwd || null,
    repoRoot: options.repoRoot || options.cwd || null,
    sessionManager: options.sessionManager || primarySessionManager,
    onEvent: options.onEvent,
    subagentMaxParallel: options.subagentMaxParallel,
  });
}

function finalizePrimaryTurnResult(result) {
  if (result == null || typeof result !== "object") return result;
  const text =
    String(
      result.finalResponse
      || result.output
      || result.text
      || result.message
      || "",
    ).trim();
  return {
    ...result,
    finalResponse: result.finalResponse || text,
    text: result.text || text,
    message: result.message || text,
  };
}

export function setPrimaryAgent(name) {
  const resolved = resolveAgentSelection(name);
  if (resolved) {
    activeAdapter = ADAPTERS[resolved.adapterName] || ADAPTERS["codex-sdk"];
    activeExecutorSelection =
      resolved.selectionId || activeAdapter.name || "codex-sdk";
    return activeAdapter.name;
  }

  const normalized = normalizePrimaryAgent(name);
  const adapterName = ADAPTERS[normalized] ? normalized : "codex-sdk";
  activeAdapter = ADAPTERS[adapterName] || ADAPTERS["codex-sdk"];
  activeExecutorSelection = adapterName;
  return activeAdapter.name;
}

export function getPrimaryAgentName() {
  return activeAdapter?.name || "codex-sdk";
}

export function getPrimaryAgentSelection() {
  return activeExecutorSelection || getPrimaryAgentName();
}

export async function switchPrimaryAgent(name) {
  const target = resolveAgentSelection(name);
  if (!target) {
    return { ok: false, reason: "unknown_agent" };
  }
  activeAdapter = ADAPTERS[target.adapterName];
  activeExecutorSelection = target.selectionId || target.adapterName;
  primaryFallbackReason = null;
  initialized = false;
  try {
    await initPrimaryAgent(target.selectionId || target.adapterName);
    return { ok: true, name: getPrimaryAgentName() };
  } catch (err) {
    return { ok: false, reason: err?.message || "init_failed" };
  }
}

export async function initPrimaryAgent(nameOrConfig = null) {
  if (initialized) return getPrimaryAgentName();
  const desired = resolvePrimaryAgent(nameOrConfig);
  setPrimaryAgent(desired);
  if (
    primaryProfile?.name &&
    (activeExecutorSelection === activeAdapter.name || !activeExecutorSelection)
  ) {
    activeExecutorSelection = String(primaryProfile.name).trim() || activeAdapter.name;
  }

  if (
    activeAdapter.name === "codex-sdk" &&
    envFlagEnabled(process.env.CODEX_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Codex SDK disabled — attempting fallback";
    if (!envFlagEnabled(process.env.COPILOT_SDK_DISABLED)) {
      setPrimaryAgent("copilot-sdk");
    } else if (!envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)) {
      setPrimaryAgent("claude-sdk");
    } else if (!envFlagEnabled(process.env.GEMINI_SDK_DISABLED)) {
      setPrimaryAgent("gemini-sdk");
    } else if (!envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
      setPrimaryAgent("opencode-sdk");
    }
  }

  if (
    activeAdapter.name === "claude-sdk" &&
    envFlagEnabled(process.env.CLAUDE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Claude SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "gemini-sdk" &&
    envFlagEnabled(process.env.GEMINI_SDK_DISABLED)
  ) {
    primaryFallbackReason = "Gemini SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  if (
    activeAdapter.name === "opencode-sdk" &&
    envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)
  ) {
    primaryFallbackReason = "OpenCode SDK disabled — falling back to Codex";
    setPrimaryAgent("codex-sdk");
  }

  ensurePrimaryAgentConfigs(activeAdapter.name);

  const ok = await activeAdapter.init();
  if (activeAdapter.name === "copilot-sdk" && ok === false) {
    primaryFallbackReason = "Copilot SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "gemini-sdk" && ok === false) {
    primaryFallbackReason = "Gemini SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }
  if (activeAdapter.name === "opencode-sdk" && ok === false) {
    primaryFallbackReason = "OpenCode SDK unavailable — falling back to Codex";
    setPrimaryAgent("codex-sdk");
    ensurePrimaryAgentConfigs(activeAdapter.name);
    await activeAdapter.init();
  }

  initialized = true;
  try {
    const cfg = loadConfig() || {};
    const harness = cfg.harness || {};
    const executors = Array.isArray(harness.executors) ? harness.executors : [];
    const enabledExecutors = executors.filter((e) => e?.enabled !== false);
    const primaryExecutor = harness.primaryExecutor || "<unset>";
    const defaultProvider = cfg.providers?.defaultProvider || "<unset>";
    const adapterName = getPrimaryAgentName();
    const runtime = String(cfg.agentRuntime || "harness").toLowerCase();
    const nativeRouting = runtime === "harness" ? "openai-native-adapter" : "sdk-cli";
    console.log(
      `[harness] active: agentRuntime=${runtime} ` +
      `harness.enabled=${harness.enabled !== false} ` +
      `primaryExecutor=${primaryExecutor} ` +
      `defaultProvider=${defaultProvider} ` +
      `executors=${enabledExecutors.length}/${executors.length} ` +
      `primaryAdapter=${adapterName} ` +
      `routing=${nativeRouting}` +
      (primaryFallbackReason ? ` fallback="${primaryFallbackReason}"` : "")
    );
  } catch (err) {
    // Banner is best-effort; never block agent init on logging failure
    console.warn(`[harness] startup banner failed: ${err?.message || err}`);
  }
  return getPrimaryAgentName();
}

/** Default timeout for primary agent execution (45 minutes — agents may work for extended periods) */
const PRIMARY_EXEC_TIMEOUT_MS = Number(process.env.PRIMARY_AGENT_TIMEOUT_MS) || 45 * 60 * 1000;

/** Maximum number of failover attempts across adapters */
const MAX_FAILOVER_ATTEMPTS = 2;

/** Ordered fallback chain — if the current adapter times out, try the next */
const FALLBACK_ORDER = [
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
];

function mapAdapterToPoolSdk(adapterName) {
  const normalized = String(adapterName || "").trim().toLowerCase();
  if (normalized === "copilot-sdk") return "copilot";
  if (normalized === "claude-sdk") return "claude";
  return "codex";
}

function shouldUseIsolatedPoolExecution(adapter, options = {}) {
  if (options.forceIsolated === true) return true;
  if (options.allowConcurrent === false) return false;
  if (!adapter || typeof adapter.isBusy !== "function") return false;
  if (!adapter.isBusy()) return false;

  const requestedSessionId = options.sessionId
    ? String(options.sessionId)
    : "";
  let activeSessionId = "";
  try {
    const info = adapter.getInfo ? adapter.getInfo() : null;
    activeSessionId = String(info?.sessionId || info?.threadId || "");
  } catch {
    activeSessionId = "";
  }

  if (!requestedSessionId || !activeSessionId) return true;
  return requestedSessionId !== activeSessionId;
}

/**
 * Wrap a promise with a timeout. Rejects with a clear error when exceeded.
 * If an AbortController is provided, it will be signalled on timeout so the
 * underlying agent session can clean up (reset activeTurn, unsubscribe, etc.).
 */
function withTimeout(promise, ms, label = "operation", abortController = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortController && !abortController.signal.aborted) {
        try { abortController.abort("timeout"); } catch { /* best effort */ }
      }
      reject(new Error(`AGENT_TIMEOUT: ${label} did not respond within ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function execPrimaryPrompt(userMessage, options = {}) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  const selectedProfile = buildPrimaryAgentProfileContract(options);
  const sessionType =
    (options && options.sessionType ? String(options.sessionType) : "") ||
    "primary";
  const sessionScope = normalizePrimarySessionScope(sessionType, options.scope);
  const existingPrimarySessionId = primarySessionManager.getActiveSessionId(sessionScope);
  const defaultSessionId = existingPrimarySessionId || `primary-${activeAdapter.name}`;
  const sessionId =
    (options && options.sessionId ? String(options.sessionId) : "") ||
    defaultSessionId;
  const effectiveMode = normalizeAgentMode(
    options.mode || selectedProfile.preferredMode || agentMode,
    agentMode,
  );
  const primarySessionCompat = getPrimarySessionCompat(sessionType, sessionScope);
  const sessionRecord = primarySessionCompat.ensureManagedSession(sessionId, {
    sessionType,
    taskKey: sessionId,
    cwd: options.cwd || "",
    status: "idle",
    metadata: {
      mode: effectiveMode,
    },
  });
  primarySessionCompat.switchSession(sessionRecord.sessionId, {
    sessionType,
    taskKey: sessionRecord.taskKey,
    cwd: options.cwd || sessionRecord.cwd || "",
    status: "active",
    metadata: {
      mode: effectiveMode,
    },
  });
  bindPrimarySessionController(sessionRecord.sessionId, {
    ...options,
    sessionId: sessionRecord.sessionId,
    sessionType,
    scope: sessionScope,
    cwd: options.cwd || sessionRecord.cwd || "",
    model: options.model,
    metadata: {
      mode: effectiveMode,
      ...(options.metadata && typeof options.metadata === "object" ? options.metadata : {}),
    },
  });
  const effectiveModel = options.model || selectedProfile.preferredModel || undefined;
  const modePolicy = getModeExecPolicy(effectiveMode);
  const timeoutMs = options.timeoutMs || modePolicy?.timeoutMs || PRIMARY_EXEC_TIMEOUT_MS;
  const maxFailoverAttempts = Number.isInteger(options.maxFailoverAttempts)
    ? Math.max(0, Number(options.maxFailoverAttempts))
    : modePolicy?.maxFailoverAttempts ?? MAX_FAILOVER_ATTEMPTS;
  const tracker = getSessionTracker();
  const attachments = normalizeAttachments(options.attachments);
  const attachmentsAppended = options.attachmentsAppended === true;

  // Apply mode prefix (options.mode overrides the global setting for this call)
  const modePrefix = getModePrefix(effectiveMode);
  const messageWithAttachments = attachments.length && !attachmentsAppended
    ? appendAttachmentsToPrompt(userMessage, attachments).message
    : userMessage;
  const architectEditorFrame = buildArchitectEditorFrame(options, effectiveMode);
  const toolContract = buildPrimaryToolCapabilityContract(options);
  const messageWithToolContract = [selectedProfile.block, architectEditorFrame, toolContract, messageWithAttachments]
    .filter(Boolean)
    .join("\n\n");
  const framedMessage = modePrefix ? modePrefix + messageWithToolContract : messageWithToolContract;

  // Record user message (original, without mode prefix)
  if (options.skipUserMessageRecord !== true) {
    tracker.recordEvent(sessionId, {
      role: "user",
      content: userMessage,
      attachments: attachments.length ? attachments : undefined,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
      _mode: effectiveMode,
    });
  }

  if (shouldUseIsolatedPoolExecution(activeAdapter, options)) {
    const pooled = await execPooledPrompt(framedMessage, {
      timeoutMs,
      onEvent: options.onEvent,
      abortController: options.abortController,
      cwd: options.cwd,
      model: effectiveModel,
      sdk: mapAdapterToPoolSdk(activeAdapter.name),
      sessionType,
    });
    const pooledText =
      typeof pooled === "string"
        ? pooled
        : pooled?.finalResponse || pooled?.text || pooled?.message || JSON.stringify(pooled);
    tracker.recordEvent(sessionId, {
      role: "assistant",
      content: pooledText,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
    });
    const compressionSummary = summarizeContextCompressionItems(pooled?.items);
    if (compressionSummary) {
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "system",
        content: compressionSummary.content,
        timestamp: new Date().toISOString(),
        meta: {
          contextCompression: compressionSummary,
        },
      });
    }
    primarySessionCompat.registerExecution(sessionId, {
      sessionType,
      taskKey: sessionId,
      cwd: options.cwd || "",
      status: "active",
      threadId: pooled?.threadId || null,
      metadata: {
        isolatedPool: true,
        mode: effectiveMode,
      },
    });
    return pooled;
  }

  const recordAssistantTurn = (result, extraMetadata = {}) => {
    if (!result) return;
    const text = typeof result === "string"
      ? result
      : result.finalResponse || result.text || result.message || JSON.stringify(result);
    const assistantItems = Array.isArray(result?.items) ? result.items : [];
    const latestAssistantItem = [...assistantItems]
      .reverse()
      .find((item) => String(item?.role || "").toLowerCase() === "assistant" && String(item?.text || "").trim());
    tracker.recordEvent(sessionId, {
      id: latestAssistantItem?.id || undefined,
      role: "assistant",
      content: text,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
      meta: result?.usage
        ? {
            usage: { ...result.usage },
          }
        : undefined,
      _compressed: latestAssistantItem?._compressed || undefined,
      _originalLength:
        Number.isFinite(Number(latestAssistantItem?._originalLength))
          ? Number(latestAssistantItem._originalLength)
          : undefined,
      _cachedLogId: latestAssistantItem?._cachedLogId || undefined,
    });
    const compressionSummary = summarizeContextCompressionItems(result?.items);
    if (compressionSummary) {
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "system",
        content: compressionSummary.content,
        timestamp: new Date().toISOString(),
        meta: {
          contextCompression: compressionSummary,
          ...extraMetadata,
        },
      });
    }
  };

  const outcome = await primaryFailoverController.executeTurn({
    adapters: ADAPTERS,
    initialAdapterName: activeAdapter.name,
    fallbackOrder: FALLBACK_ORDER,
    maxFailoverAttempts,
    includeAdapter(name) {
      const envDisabledKey = `${name.replace("-sdk", "").toUpperCase()}_SDK_DISABLED`;
      return !envFlagEnabled(process.env[envDisabledKey]);
    },
    async prepareAdapter({ adapterName, attempt, previousAdapterName, lastError }) {
      if (attempt === 0) return;
      console.warn(
        `[primary-agent] :alert: Failing over from ${previousAdapterName} to ${adapterName} (reason: ${lastError?.message || "unknown"})`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "failover",
        content: `:alert: Agent "${previousAdapterName}" failed — switching to "${adapterName}": ${lastError?.message || "timeout/error"}`,
        timestamp: new Date().toISOString(),
      });
      setPrimaryAgent(adapterName);
      primaryFallbackReason = `Failover from ${previousAdapterName}: ${lastError?.message || "timeout"}`;
      await ADAPTERS[adapterName].init();
    },
    async executeAdapterTurn({ adapterName, recovered }) {
      const providerSession = createPrimaryExecutionSession(adapterName, {
        sessionId,
        threadId: sessionId,
        model: effectiveModel,
        cwd: options.cwd || null,
        repoRoot: options.repoRoot || options.cwd || null,
        sessionManager: primarySessionManager,
        onEvent: options.onEvent,
        subagentMaxParallel: options.subagentMaxParallel,
        metadata: {
          mode: effectiveMode,
          ...(recovered ? { recovered: true } : {}),
        },
      });
      const timeoutAbort = new AbortController();
      if (options.abortController?.signal) {
        const callerSignal = options.abortController.signal;
        if (callerSignal.aborted) {
          timeoutAbort.abort(callerSignal.reason);
        } else {
          callerSignal.addEventListener("abort", () => {
            timeoutAbort.abort(callerSignal.reason || "user_stop");
          }, { once: true });
        }
      }
      const rawResult = await withTimeout(
        providerSession.runTurn(framedMessage, {
          ...options,
          sessionId,
          threadId: sessionId,
          model: effectiveModel,
          abortController: timeoutAbort,
          metadata: {
            mode: effectiveMode,
            ...(recovered ? { recovered: true } : {}),
          },
          sessionManager: primarySessionManager,
          subagentMaxParallel: options.subagentMaxParallel,
        }),
        timeoutMs,
        recovered ? `${adapterName}.exec.retry` : `${adapterName}.exec`,
        timeoutAbort,
      );
      const compressedItems = await maybeCompressSessionItems(rawResult?.items, {
        sessionType,
        agentType: adapterName,
        sessionId,
        force: options.forceContextShredding === true,
        skip: options.skipContextShredding === true,
      });
      return finalizePrimaryTurnResult({
        ...rawResult,
        items: compressedItems,
      });
    },
    async recoverAdapter({ adapterName, adapter, retry, maxRetries }) {
      console.warn(
        `[primary-agent] :arrows_counterclockwise: recovering ${adapterName} session (${retry}/${maxRetries})`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "recovery",
        content: `:arrows_counterclockwise: Recovering ${adapterName} session (${retry}/${maxRetries}) before any failover.`,
        timestamp: new Date().toISOString(),
      });
      await primaryProviderSessionRuntime.recoverSession({
        adapterName,
        adapter,
        retry,
        maxRetries,
      });
    },
    onFailure({ adapterName, error }) {
      const isTimeout = error?.message?.startsWith("AGENT_TIMEOUT");
      console.error(
        `[primary-agent] ${isTimeout ? ":clock: Timeout" : ":close: Error"} with ${adapterName}: ${error.message}`,
      );
    },
    onRecoveryFailure({ adapterName, retry, maxRetries, error }) {
      console.error(
        `[primary-agent] :close: recovery attempt ${retry}/${maxRetries} failed for ${adapterName}: ${error?.message || error}`,
      );
    },
    onSuccess({ adapterName, result, recovered }) {
      recordAssistantTurn(result, recovered ? { recovered: true } : {});
      primarySessionCompat.registerExecution(sessionId, {
        sessionType,
        providerSelection: activeExecutorSelection || adapterName,
        adapterName,
        taskKey: sessionId,
        cwd: options.cwd || "",
        status: "active",
        threadId: result?.threadId || result?.sessionId || null,
        metadata: {
          mode: effectiveMode,
          ...(recovered ? { recovered: true } : {}),
          providerSessionId: result?.sessionId || null,
        },
      });
    },
    onFailoverSuppressed({ adapterName, error, waitReason }) {
      console.warn(
        `[primary-agent] failover suppressed for ${adapterName}: ${waitReason}`,
      );
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "error",
        content: `:warning: ${adapterName} error: ${error?.message || "unknown error"}. Failover suppressed (${waitReason}).`,
        timestamp: new Date().toISOString(),
      });
    },
    onExhausted({ error, isTimeout }) {
      tracker.recordEvent(sessionId, {
        role: "system",
        type: "error",
        content: isTimeout
          ? `:clock: All agents timed out. The AI service may be experiencing issues. Your message was saved — please try again shortly.`
          : `:close: Agent error: ${error?.message || error}. Your message was saved — please try again.`,
        timestamp: new Date().toISOString(),
      });
    },
  });

  if (outcome.ok) {
    return outcome.result;
  }

  if (outcome.suppressed) {
    primarySessionCompat.registerExecution(sessionId, {
      sessionType,
      providerSelection: activeExecutorSelection || outcome.adapterName,
      adapterName: outcome.adapterName,
      taskKey: sessionId,
      cwd: options.cwd || "",
      status: "failed",
      error: outcome.error?.message || "unknown error",
      metadata: {
        mode: effectiveMode,
        failoverSuppressed: true,
      },
    });
    return {
      finalResponse: `:warning: ${outcome.adapterName} error: ${outcome.error?.message || "unknown error"}. Failover suppressed (${outcome.waitReason}).`,
      items: [],
      usage: null,
    };
  }

  primarySessionCompat.registerExecution(sessionId, {
    sessionType,
    providerSelection: activeExecutorSelection || activeAdapter.name,
    adapterName: activeAdapter.name,
    taskKey: sessionId,
    cwd: options.cwd || "",
    status: "failed",
    error: outcome.error?.message || "unknown",
    metadata: {
      mode: effectiveMode,
      allAdaptersFailed: true,
    },
  });
  return {
    finalResponse: `:close: All agent adapters failed. Last error: ${outcome.error?.message || "unknown"}`,
    items: [],
    usage: null,
  };
}

export async function steerPrimaryPrompt(message) {
  if (!initialized) {
    await initPrimaryAgent();
  }
  return activeAdapter.steer(message);
}

export function isPrimaryBusy() {
  return activeAdapter.isBusy();
}

export function getPrimaryAgentInfo() {
  const info = activeAdapter.getInfo ? activeAdapter.getInfo() : {};
  return {
    adapter: activeAdapter.name,
    selectionId: activeExecutorSelection || activeAdapter.name,
    provider: activeAdapter.provider,
    profile: primaryProfile,
    fallbackReason: primaryFallbackReason,
    sessionId: info.sessionId || info.threadId || null,
    threadId: info.threadId || null,
    turnCount: info.turnCount || 0,
    isActive: !!info.isActive,
    isBusy: !!info.isBusy,
  };
}

export async function resetPrimaryAgent() {
  if (!initialized) {
    await initPrimaryAgent();
  }
  if (activeAdapter.reset) {
    await activeAdapter.reset();
  }
}

export function getPrimarySessionId() {
  return getPrimarySessionCompat().getActiveSessionId()
    || (activeAdapter.getSessionId ? activeAdapter.getSessionId() : null);
}

export async function listPrimarySessions() {
  const primarySessionCompat = getPrimarySessionCompat();
  const adapterSessions = activeAdapter.listSessions ? await activeAdapter.listSessions() : [];
  return primarySessionCompat.listSessions({ extraSessions: adapterSessions });
}

export async function switchPrimarySession(id) {
  const result = activeAdapter.switchSession ? await activeAdapter.switchSession(id) : undefined;
  getPrimarySessionCompat().switchSession(id, {
    sessionType: "primary",
    taskKey: id,
    status: "active",
  });
  return result;
}

export async function createPrimarySession(id) {
  const result = activeAdapter.createSession ? await activeAdapter.createSession(id) : undefined;
  const createdId = String(result?.id || result?.sessionId || id || "").trim() || id;
  const primarySessionCompat = getPrimarySessionCompat();
  primarySessionCompat.createSession(createdId, {
    taskKey: createdId,
    status: "idle",
  });
  primarySessionCompat.switchSession(createdId, {
    taskKey: createdId,
    status: "active",
  });
  return result;
}

// ── Agent mode & SDK command API ─────────────────────────────────────────────

/**
 * Get the current interaction mode ("ask" | "agent" | "plan" | "web" | "instant").
 * @returns {string}
 */
export function getAgentMode() {
  return agentMode;
}

/**
 * Set the interaction mode.
 * @param {"ask"|"agent"|"plan"|"web"|"instant"} mode
 * @returns {{ ok: boolean, mode: string, error?: string }}
 */
export function setAgentMode(mode) {
  const normalized = normalizeAgentMode(mode, "");
  if (!getValidModes().includes(normalized)) {
    return { ok: false, mode: agentMode, error: `Invalid mode "${mode}". Valid: ${getValidModes().join(", ")}` };
  }
  agentMode = normalized;
  return { ok: true, mode: agentMode };
}

/**
 * Build the full prompt with mode prefix applied.
 * @param {string} userMessage
 * @returns {string}
 */
export function applyModePrefix(userMessage) {
  const prefix = getModePrefix(agentMode);
  return prefix ? prefix + userMessage : userMessage;
}

/**
 * Register a custom interaction mode at runtime.
 * Core modes cannot be overridden.
 * @param {string} id
 * @param {{ prefix?: string, execPolicy?: object|null, toolFilter?: object|null, description?: string }} config
 */
export function registerCustomMode(id, config) {
  if (!id || typeof id !== "string") return;
  const modeId = id.trim().toLowerCase();
  if (CORE_MODES.includes(modeId)) return;
  _customModes.set(modeId, {
    prefix: config.prefix || "",
    execPolicy: config.execPolicy || null,
    toolFilter: config.toolFilter || null,
    description: config.description || "",
  });
}

/**
 * List all available modes (core + custom) with metadata.
 * @returns {Array<{id: string, description: string, core: boolean}>}
 */
export function listAvailableModes() {
  const modes = CORE_MODES.map((m) => ({
    id: m,
    description: MODE_PREFIXES[m]?.slice(0, 80) || "Full agentic behavior",
    core: true,
  }));
  for (const [id, cfg] of _customModes) {
    modes.push({ id, description: cfg.description, core: false });
  }
  return modes;
}

/**
 * Get all registered custom modes.
 * @returns {Array<{id: string, prefix: string, execPolicy: object|null, toolFilter: object|null, description: string}>}
 */
export function getCustomModes() {
  return [..._customModes.entries()].map(([id, cfg]) => ({ id, ...cfg }));
}

/**
 * Get the list of available agent adapters with capabilities.
 * @returns {Array<{id:string, name:string, provider:string, available:boolean, busy:boolean, capabilities:object}>}
 */
export function getAvailableAgents() {
  return primaryProviderKernel.listProviders().map((entry) => ({
    ...entry,
    adapterId: normalizeProviderAdapterName(entry.adapterId || entry.id),
  }));
}

try {
  const bootConfig = loadConfig() || {};
  const preferredSelection = resolvePrimaryAgent(bootConfig);
  if (preferredSelection) {
    setPrimaryAgent(preferredSelection);
  } else {
    const fabric = readHarnessExecutorFabric(bootConfig);
    if (fabric.primaryExecutorId) {
      setPrimaryAgent(fabric.primaryExecutorId);
    }
  }
} catch {
}

/**
 * Get the list of SDK commands supported by a specific adapter (or the active one).
 * @param {string} [adapterName]
 * @returns {string[]}
 */
export function getSdkCommands(adapterName) {
  const normalized = adapterName ? normalizeProviderAdapterName(adapterName) : null;
  const adapter = normalized ? ADAPTERS[normalized] : activeAdapter;
  return adapter?.sdkCommands || [];
}

/**
 * Forward an SDK-native command to the active (or specified) adapter.
 * @param {string} command  — e.g. "/compact", "/model"
 * @param {string} [args]   — optional arguments string
 * @param {string} [adapterName] — target adapter (defaults to active)
 * @param {object} [options] — execution overrides (e.g. cwd/sessionId)
 * @returns {Promise<string|object>}
 */
export async function execSdkCommand(command, args = "", adapterName, options = {}) {
  const normalized = adapterName ? normalizeProviderAdapterName(adapterName) : null;
  const adapter = normalized ? ADAPTERS[normalized] : activeAdapter;
  if (!adapter) {
    throw new Error(`Unknown adapter: ${adapterName || "(none)"}`);
  }
  const cmd = command.startsWith("/") ? command : `/${command}`;
  if (!adapter.sdkCommands?.includes(cmd) && cmd !== "/clear") {
    throw new Error(`Command "${cmd}" not supported by ${adapter.name}. Supported: ${(adapter.sdkCommands || []).join(", ")}`);
  }
  if (typeof adapter.execSdkCommand !== "function") {
    throw new Error(`Adapter ${adapter.name} does not support SDK commands.`);
  }
  return adapter.execSdkCommand(cmd, args, options);
}
