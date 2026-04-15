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

let _mcpAdapter = null;
async function getMcpAdapter() {
  if (!_mcpAdapter) {
    _mcpAdapter = await import("../mcp-workflow-adapter.mjs");
  }
  return _mcpAdapter;
}

registerNodeType("transform.json_parse", {
  describe: () => "Parse JSON from a previous node's output",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Source: node ID or {{variable}}" },
      field: { type: "string", description: "Field in source output containing JSON" },
    },
  },
  async execute(node, ctx) {
    const sourceId = node.config?.input;
    const field = node.config?.field || "output";
    let raw = sourceId ? ctx.getNodeOutput(sourceId)?.[field] : ctx.resolve(node.config?.value || "");
    if (typeof raw !== "string") raw = JSON.stringify(raw);
    try {
      return { data: JSON.parse(raw), success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

registerNodeType("transform.template", {
  describe: () => "Render a text template with context variables",
  schema: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template text with {{variables}}" },
    },
    required: ["template"],
  },
  async execute(node, ctx) {
    const result = ctx.resolve(node.config?.template || "");
    return { text: result };
  },
});

registerNodeType("transform.aggregate", {
  describe: () => "Aggregate outputs from multiple nodes into a single object",
  schema: {
    type: "object",
    properties: {
      sources: { type: "array", items: { type: "string" }, description: "Node IDs to aggregate" },
    },
  },
  async execute(node, ctx) {
    const sources = node.config?.sources || [];
    const aggregated = {};
    for (const src of sources) {
      aggregated[src] = ctx.getNodeOutput(src);
    }
    return { aggregated, count: sources.length };
  },
});

registerNodeType("transform.llm_parse", {
  describe: () =>
    "Parse unstructured LLM output into structured fields using regex patterns " +
    "or keyword extraction. Essential for routing decisions based on LLM verdicts " +
    "(e.g., PASS/FAIL/PARTIAL, correct/minor/critical).",
  schema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "Source text to parse — node ID, {{variable}}, or literal text",
      },
      field: {
        type: "string",
        default: "output",
        description: "Field name within source node output (when input is a node ID)",
      },
      patterns: {
        type: "object",
        description:
          "Map of field names to regex patterns. Each pattern is applied to the input; " +
          "the first capture group (or full match) is stored under that key. " +
          'Example: { "verdict": "\\\\b(PASS|FAIL|PARTIAL)\\\\b", "score": "score:\\\\s*(\\\\d+)" }',
        additionalProperties: { type: "string" },
      },
      keywords: {
        type: "object",
        description:
          "Map of field names to keyword lists. The first keyword found in the input is stored. " +
          'Example: { "severity": ["critical", "minor", "correct"] }',
        additionalProperties: {
          type: "array",
          items: { type: "string" },
        },
      },
      outputPort: {
        type: "string",
        description:
          "Which parsed field to use as the matchedPort for downstream routing. " +
          "If set, the value of that parsed field becomes the output port.",
      },
    },
    required: [],
  },
  async execute(node, ctx) {
    // Resolve the input text
    let text = "";
    const inputRef = ctx.resolve(node.config?.input || "");
    const field = node.config?.field || "output";

    if (inputRef && ctx.getNodeOutput(inputRef)) {
      // Input is a node ID — grab the specified field
      const nodeOutput = ctx.getNodeOutput(inputRef);
      text = String(
        nodeOutput?.[field] ?? nodeOutput?.reviewOutput ?? nodeOutput?.text ?? JSON.stringify(nodeOutput) ?? "",
      );
    } else {
      // Input is a template/literal
      text = String(inputRef || "");
    }

    const parsed = {};

    // Apply regex patterns
    const patterns = node.config?.patterns || {};
    for (const [key, patternStr] of Object.entries(patterns)) {
      try {
        const regex = new RegExp(patternStr, "i");
        const match = text.match(regex);
        if (match) {
          parsed[key] = match[1] !== undefined ? match[1] : match[0];
        } else {
          parsed[key] = null;
        }
      } catch (err) {
        ctx.log(node.id, `Pattern "${key}" error: ${err.message}`, "warn");
        parsed[key] = null;
      }
    }

    // Apply keyword extraction
    const keywords = node.config?.keywords || {};
    const lowerText = text.toLowerCase();
    for (const [key, wordList] of Object.entries(keywords)) {
      if (!Array.isArray(wordList)) continue;
      const found = wordList.find((w) => lowerText.includes(String(w).toLowerCase()));
      parsed[key] = found || null;
    }

    // Determine output port for routing
    const portField = node.config?.outputPort || "";
    let matchedPort = "default";
    if (portField && parsed[portField] != null) {
      matchedPort = String(parsed[portField]).toLowerCase().trim();
    }

    ctx.log(node.id, `Parsed: ${JSON.stringify(parsed)}, port=${matchedPort}`);

    return {
      parsed,
      matchedPort,
      port: matchedPort,
      inputLength: text.length,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  NOTIFY — Notifications
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("transform.mcp_extract", {
  describe: () =>
    "Extract and reshape structured data from an upstream MCP tool call or " +
    "any node output. Supports dot-path fields, JSON pointers, array wildcards, " +
    "type coercion, default values, and output mapping. Essential for piping " +
    "specific data points between MCP tool calls in a workflow.",
  schema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Source node ID to extract from (e.g. 'mcp-github-prs')",
      },
      sourceField: {
        type: "string",
        default: "data",
        description: "Field within the source node's output to extract from",
      },
      root: {
        type: "string",
        description: "Root path within the source data (narrows extraction scope)",
      },
      fields: {
        type: "object",
        description:
          "Map of outputKey → sourcePath (dot-path, JSON pointer, or wildcard). " +
          "Example: { 'prTitles': 'items[*].title', 'firstAuthor': 'items[0].user.login' }",
        additionalProperties: { type: "string" },
      },
      defaults: {
        type: "object",
        description: "Default values for missing fields",
        additionalProperties: true,
      },
      types: {
        type: "object",
        description: "Type coercion: fieldName → 'string'|'number'|'boolean'|'array'|'integer'|'json'",
        additionalProperties: { type: "string" },
      },
      outputMap: {
        type: "object",
        description: "Additional output mapping/reshaping after extraction",
        additionalProperties: true,
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store extracted data in ctx.data",
      },
    },
    required: ["source", "fields"],
  },
  async execute(node, ctx) {
    const sourceNodeId = ctx.resolve(node.config?.source || "");
    const sourceField = node.config?.sourceField || "data";

    if (!sourceNodeId) throw new Error("transform.mcp_extract: 'source' node ID is required");

    const sourceOutput = ctx.getNodeOutput(sourceNodeId);
    if (!sourceOutput) {
      ctx.log(node.id, `Source node "${sourceNodeId}" has no output — using empty object`);
      return { success: false, error: `No output from node "${sourceNodeId}"`, extracted: {} };
    }

    // Get the specific field from the source output
    const adapter = await getMcpAdapter();
    let sourceData = sourceField ? adapter.getByPath(sourceOutput, sourceField) : sourceOutput;

    // Fall back to full output if field doesn't exist
    if (sourceData === undefined) {
      sourceData = sourceOutput;
    }

    // Extract fields
    const extractConfig = {
      root: node.config?.root,
      fields: node.config?.fields || {},
      defaults: node.config?.defaults || {},
      types: node.config?.types || {},
    };

    const extracted = adapter.extractMcpOutput(sourceData, extractConfig);
    ctx.log(node.id, `Extracted ${Object.keys(extracted).length} field(s) from "${sourceNodeId}"`);

    // Optional output mapping
    let finalOutput = { success: true, extracted, ...extracted };

    if (node.config?.outputMap) {
      const mapped = adapter.mapOutputFields(finalOutput, node.config.outputMap, ctx);
      finalOutput = { ...finalOutput, mapped, ...mapped };
    }

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = finalOutput;
    }

    return finalOutput;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  TASK LIFECYCLE — Workflow-first task execution primitives
//
//  These node types decompose the monolithic TaskExecutor.executeTask() flow
//  into composable DAG nodes, enabling the full task lifecycle to run as a
//  native workflow (template-task-lifecycle).
//
//  Every node follows the contract:
//    execute(node, ctx, engine) → { success: boolean, ... }
//    describe() → string
//    schema → JSON Schema with required[] where applicable
//
//  Design principles:
//    1. Idempotent cleanup — release nodes are safe on double-call
//    2. Context-first — nodes auto-read ctx.data when config is omitted
//    3. Rich return values — every return contains enough info for conditions
//    4. Error boundary — nodes never throw unless config is fatally wrong
// ═══════════════════════════════════════════════════════════════════════════

/** Module-scope lazy caches for task lifecycle imports. */
let _taskClaimsMod = null;
let _taskComplexityMod = null;
let _kanbanAdapterMod = null;
let _agentPoolMod = null;
let _gitSafetyMod = null;
let _diffStatsMod = null;

async function ensureTaskClaimsMod() {
  if (!_taskClaimsMod) _taskClaimsMod = await import("../../task/task-claims.mjs");
  return _taskClaimsMod;
}
function pickTaskString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}
function filterAsciiAlphaNumeric(value, maxLength = Number.POSITIVE_INFINITY) {
  let out = "";
  for (const char of String(value || "")) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isDigit && !isUpper && !isLower) continue;
    out += char;
    if (out.length >= maxLength) break;
  }
  return out;
}
function slugifyTaskBranchSegment(value, maxLength = 48) {
  let out = "";
  let pendingDash = false;
  for (const rawChar of String(value || "").toLowerCase()) {
    const code = rawChar.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 122;
    if (isDigit || isLower) {
      if (pendingDash && out.length > 0 && out.length < maxLength) out += "-";
      pendingDash = false;
      out += rawChar;
      if (out.length >= maxLength) break;
      continue;
    }
    pendingDash = out.length > 0;
  }
  return out;
}
function deriveTaskBranch(task = {}) {
  const explicit = pickTaskString(
    task?.branch,
    task?.branchName,
    task?.meta?.branch,
    task?.metadata?.branch,
  );
  if (explicit) return explicit;
  const taskId = filterAsciiAlphaNumeric(pickTaskString(task?.id, task?.task_id), 12);
  const titleSlug = slugifyTaskBranchSegment(pickTaskString(task?.title, "task"), 48);
  const suffix = titleSlug || "task";
  if (taskId) return `task/${taskId}-${suffix}`;
  return `task/${suffix}`;
}
function looksLikeFilesystemPath(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\");
}
function resolveTaskRepositoryRoot(taskRepository, currentRepoRoot) {
  const repository = String(taskRepository || "").trim();
  const repoRoot = String(currentRepoRoot || "").trim();
  if (!repository || !repoRoot) return "";
  const repoName = repository.split("/").pop();
  if (!repoName) return "";
  const normalizedRepoRoot = repoRoot.replace(/\\/g, "/");
  const mirrorToken = "/.bosun/workspaces/";
  if (normalizedRepoRoot.includes(mirrorToken)) {
    const prefix = normalizedRepoRoot.slice(0, normalizedRepoRoot.indexOf(mirrorToken));
    const prefixName = String(prefix.split("/").filter(Boolean).pop() || "").toLowerCase();
    const inferredRepoRoot = prefixName === String(repoName).toLowerCase()
      ? prefix
      : resolve(prefix, repoName);
    try {
      if (existsSync(resolve(inferredRepoRoot, ".git"))) return inferredRepoRoot;
    } catch {
      // ignore invalid inferred path
    }
  }
  const candidates = [
    resolve(repoRoot, "..", repoName),
    resolve(repoRoot, ".bosun", "workspaces", String(process.env.BOSUN_WORKSPACE || "").trim(), repoName),
  ];
  for (const candidate of candidates) {
    if (!candidate || candidate.includes("workspaces/")) {
      // keep candidate even when BOSUN_WORKSPACE is empty; resolve() will normalize it.
    }
    try {
      if (existsSync(resolve(candidate, ".git"))) return candidate;
    } catch {
      // ignore invalid candidate
    }
  }
  return "";
}
async function ensureTaskClaimsInitialized(ctx, claims) {
  if (typeof claims?.initTaskClaims !== "function") return;
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!runtimeState.taskClaimsInitPromises || typeof runtimeState.taskClaimsInitPromises !== "object") {
    runtimeState.taskClaimsInitPromises = {};
  }
  const repoRoot = resolve(pickTaskString(
    ctx?.data?.repoRoot,
    ctx?.data?.workspace,
    process.cwd(),
  ));
  if (!runtimeState.taskClaimsInitPromises[repoRoot]) {
    runtimeState.taskClaimsInitPromises[repoRoot] = claims.initTaskClaims({ repoRoot }).catch((err) => {
      delete runtimeState.taskClaimsInitPromises[repoRoot];
      throw err;
    });
  }
  await runtimeState.taskClaimsInitPromises[repoRoot];
}
async function ensureTaskComplexityMod() {
  if (!_taskComplexityMod) _taskComplexityMod = await import("../../task/task-complexity.mjs");
  return _taskComplexityMod;
}
async function ensureKanbanAdapterMod() {
  if (!_kanbanAdapterMod) _kanbanAdapterMod = await import("../../kanban/kanban-adapter.mjs");
  return _kanbanAdapterMod;
}
async function ensureAgentPoolMod() {
  if (!_agentPoolMod) _agentPoolMod = await import("../../agent/agent-pool.mjs");
  return _agentPoolMod;
}
async function ensureGitSafetyMod() {
  if (!_gitSafetyMod) _gitSafetyMod = await import("../../git/git-safety.mjs");
  return _gitSafetyMod;
}
async function ensureDiffStatsMod() {
  if (!_diffStatsMod) _diffStatsMod = await import("../../git/diff-stats.mjs");
  return _diffStatsMod;
}
let _taskStoreMod = null;
async function ensureTaskStoreMod() {
  if (!_taskStoreMod) _taskStoreMod = await import("../../task/task-store.mjs");
  return _taskStoreMod;
}

function normalizeCanStartGuardResult(raw) {
  if (typeof raw === "boolean") {
    return {
      canStart: raw,
      reason: raw ? "ok" : "blocked",
      blockingTaskIds: [],
      missingDependencyTaskIds: [],
      blockingSprintIds: [],
      blockingEpicIds: [],
    };
  }
  const data = raw && typeof raw === "object" ? raw : {};
  const canStart = data.canStart !== false;
  return {
    canStart,
    reason: String(data.reason || (canStart ? "ok" : "blocked")).trim() || (canStart ? "ok" : "blocked"),
    blockingTaskIds: Array.isArray(data.blockingTaskIds) ? data.blockingTaskIds : [],
    missingDependencyTaskIds: Array.isArray(data.missingDependencyTaskIds) ? data.missingDependencyTaskIds : [],
    blockingSprintIds: Array.isArray(data.blockingSprintIds) ? data.blockingSprintIds : [],
    blockingEpicIds: Array.isArray(data.blockingEpicIds) ? data.blockingEpicIds : [],
    sprintOrderMode: data.sprintOrderMode || null,
    sprintTaskOrderMode: data.sprintTaskOrderMode || null,
  };
}
/** Resolve a config value, falling back to ctx.data, then defaultVal. */
function cfgOrCtx(node, ctx, key, defaultVal = "") {
  const raw = node.config?.[key];
  if (raw != null && raw !== "") return ctx.resolve(String(raw));
  const ctxVal = ctx.data?.[key];
  if (ctxVal != null && ctxVal !== "") return String(ctxVal);
  return defaultVal;
}

function getWorkflowRuntimeState(ctx) {
  if (!ctx || typeof ctx !== "object") return {};
  if (!ctx.__workflowRuntimeState || typeof ctx.__workflowRuntimeState !== "object") {
    ctx.__workflowRuntimeState = {};
  }
  return ctx.__workflowRuntimeState;
}

function isUnresolvedTemplateToken(value) {
  return /{{[^{}]+}}/.test(String(value || ""));
}

function normalizeGitRefValue(value) {
  const text = String(value ?? "").trim();
  if (!text || isUnresolvedTemplateToken(text)) return "";
  const lowered = text.toLowerCase();
  if (lowered === "null" || lowered === "undefined") return "";
  return text;
}

function pickGitRef(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeGitRefValue(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function formatExecSyncError(err) {
  if (!err) return "unknown error";
  const detail = [err?.stderr, err?.stdout, err?.message]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" | ");
  return trimLogText(detail || String(err?.message || err), 420);
}

function isExistingBranchWorktreeError(err) {
  const detail = formatExecSyncError(err).toLowerCase();
  return detail.includes("already exists") || detail.includes("is already checked out");
}

/**
 * Anti-thrash state — module-scope to survive across workflow runs.
 * Mirrors TaskExecutor._noCommitCounts / _skipUntil / _completedWithPR.
 */
const _noCommitCounts = new Map();
const _skipUntil = new Map();
const _completedWithPR = new Set();
const MAX_NO_COMMIT_ATTEMPTS = 3;
const NO_COMMIT_BASE_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
const NO_COMMIT_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const STRICT_START_GUARD_MISSING_TASK = /^(1|true|yes|on)$/i.test(
  String(process.env.BOSUN_STRICT_START_GUARD_MISSING_TASK || "").trim(),
);

// ── trigger.task_available ──────────────────────────────────────────────────







export {
  _completedWithPR,
  cfgOrCtx,
  ensureKanbanAdapterMod,
  ensureTaskClaimsInitialized,
  ensureTaskClaimsMod,
  ensureTaskStoreMod,
  formatExecSyncError,
  getWorkflowRuntimeState,
  isExistingBranchWorktreeError,
  isUnresolvedTemplateToken,
  normalizeCanStartGuardResult,
  normalizeGitRefValue,
  pickGitRef,
  STRICT_START_GUARD_MISSING_TASK,
};

export {
  _noCommitCounts,
  _skipUntil,
  MAX_NO_COMMIT_ATTEMPTS,
};

export {
  deriveTaskBranch,
  looksLikeFilesystemPath,
  pickTaskString,
  resolveTaskRepositoryRoot,
};

export {
  ensureAgentPoolMod,
  ensureTaskComplexityMod,
};
