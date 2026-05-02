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

import {
  getNodeType,
  listNodeTypes,
  NodeStatus,
  registerNodeType,
  unregisterNodeType,
} from "./workflow-engine.mjs";
import {
  expireApprovalRequest,
  getApprovalRequest,
  resolveApprovalRequest,
  upsertWorkflowGateApprovalRequest,
} from "./approval-queue.mjs";
import { requireWorkflowActionApproval } from "./action-approval.mjs";
import {
  _completedWithPR,
  _noCommitCounts,
  _skipUntil,
  MAX_NO_COMMIT_ATTEMPTS,
} from "./workflow-nodes/transforms.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  spawn,
  spawnSync,
} from "node:child_process";

/**
 * Non-blocking async replacement for execFileSync / execSync.
 * Resolves with stdout; rejects with err.stdout / err.stderr / err.status like execFileSync errors.
 */
function spawnAsync(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const MAX_BUFFER = 10 * 1024 * 1024;
    const captureOutput = opts.stdio !== "inherit";
    const child = spawn(command, args || [], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: captureOutput ? "pipe" : "inherit",
      shell: opts.shell || false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > MAX_BUFFER) stdout = stdout.slice(stdout.length - MAX_BUFFER);
      });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    let timedOut = false;
    const timer = opts.timeout > 0 ? setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    }, opts.timeout) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`Command timed out after ${opts.timeout}ms: ${command}`);
        err.killed = true; err.stdout = stdout; err.stderr = stderr; err.status = null;
        return reject(err);
      }
      if (code !== 0) {
        const err = new Error(`Command failed with exit code ${code}`);
        err.stdout = stdout; err.stderr = stderr; err.status = code; err.exitCode = code;
        return reject(err);
      }
      resolve(stdout);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      err.stdout = stdout; err.stderr = stderr;
      reject(err);
    });
  });
}

function resolveWorkflowCwdValue(rawValue, fallback = process.cwd()) {
  const fallbackText = String(fallback || process.cwd()).trim() || process.cwd();
  const text = String(rawValue || "").trim();
  if (!text || isUnresolvedTemplateToken(text)) return fallbackText;
  return text;
}

function applyResolvedWorkflowEnv(baseEnv, resolvedEnvConfig) {
  const commandEnv = { ...baseEnv };
  if (!resolvedEnvConfig || typeof resolvedEnvConfig !== "object" || Array.isArray(resolvedEnvConfig)) {
    return commandEnv;
  }
  for (const [key, value] of Object.entries(resolvedEnvConfig)) {
    const name = String(key || "").trim();
    if (!name) continue;
    if (value == null) {
      delete commandEnv[name];
      continue;
    }
    const normalizedValue = typeof value === "string" ? value : JSON.stringify(value);
    if (isUnresolvedTemplateToken(normalizedValue)) {
      delete commandEnv[name];
      continue;
    }
    commandEnv[name] = normalizedValue;
  }
  return commandEnv;
}

function execSync(command, options = {}) {
  return nodeExecSync(command, {
    ...options,
    windowsHide: options.windowsHide ?? true,
  });
}

function execFileSync(file, args, options = {}) {
  return nodeExecFileSync(file, args, {
    ...options,
    windowsHide: options.windowsHide ?? true,
  });
}
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, emitSkillInvokeEvent, findRelevantSkills } from "../agent/bosun-skills.mjs";
import { readBenchmarkModeState, taskMatchesBenchmarkMode } from "../bench/benchmark-mode.mjs";
import { getSessionTracker } from "../infra/session-tracker.mjs";
import { formatTraceparent, traceAgentSession, traceTaskExecution } from "../infra/tracing.mjs";
import { runInIsolatedRunner } from "../infra/container-runner.mjs";
import { recordWorktreeRecoveryEvent } from "../infra/worktree-recovery-state.mjs";
import { repairCommonMojibake } from "../lib/mojibake-repair.mjs";
import {
  appendKnowledgeEntry,
  buildKnowledgeEntry,
  formatKnowledgeBriefing,
  initSharedKnowledge,
  retrieveKnowledgeEntries,
} from "../workspace/shared-knowledge.mjs";
import {
  findReusableSkillbookStrategies,
  getSkillbookStrategy,
  upsertSkillbookStrategy,
} from "../workspace/skillbook-store.mjs";
import {
  appendArtifactRecordToStateLedger,
  appendPromotedStrategyToStateLedger,
  upsertStateLedgerKeyValue,
} from "../lib/state-ledger-sqlite.mjs";
import { RunEvaluator } from "./run-evaluator.mjs";
import {
  buildWorkflowContractPromptBlock,
  loadWorkflowContract,
  validateWorkflowContract,
} from "./workflow-contract.mjs";
import { resolveAutoCommand } from "./project-detection.mjs";
import { loadConfig, readConfigDocument } from "../config/config.mjs";
import { resolveRepoRoot as resolveConfiguredRepoRoot } from "../config/repo-root.mjs";
import { resolveHeavyRunnerPolicy, runCommandInHeavyRunnerLease } from "./heavy-runner-pool.mjs";
import {
  bootstrapWorktreeForPath,
  deriveManagedTaskToken,
  fixGitConfigCorruption,
  pruneStaleWorktrees,
} from "../workspace/worktree-manager.mjs";
import { clearBlockedWorktreeIdentity, normalizeBaseBranch } from "../git/git-safety.mjs";
import { getBosunCoAuthorTrailer, shouldAddBosunCoAuthor } from "../git/git-commit-helpers.mjs";
import { buildConflictResolutionPrompt } from "../git/conflict-resolver.mjs";
import { buildArchitectEditorFrame, buildRepoTopologyContext, hasRepoMapContext } from "../lib/repo-map.mjs";
import {
  evaluateMarkdownSafety,
  recordMarkdownSafetyAuditEvent,
  resolveMarkdownSafetyPolicy,
} from "../lib/skill-markdown-safety.mjs";
import { shouldRequireManagedPrePush } from "../infra/guardrails.mjs";
import { getGitHubToken, invalidateTokenType } from "../github/github-auth-manager.mjs";
import {
  getBuiltinNodeDefinition,
  listBuiltinNodeDefinitions,
} from "./workflow-nodes/definitions.mjs";
import {
  CUSTOM_NODE_DIR_NAME,
  ensureCustomWorkflowNodesLoaded,
  getCustomNodeDir,
  scaffoldCustomNodeFile,
  startCustomNodeDiscovery,
  stopCustomNodeDiscovery,
} from "./workflow-nodes/custom-loader.mjs";

// CLAUDE:SUMMARY — workflow-nodes
// Registers built-in workflow node types and shared prompt/runtime actions for Bosun workflows.
const TAG = "[workflow-nodes]";
let customLoadPromise = null;
let customDiscoveryStarted = false;
const PORTABLE_WORKTREE_COUNT_COMMAND = "node -e \"const cp=require('node:child_process');const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND = "node -e \"const cp=require('node:child_process');cp.execSync('git worktree prune',{stdio:'ignore'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const DEFAULT_NON_RETRYABLE_WORKTREE_RECOVERY_MS = 15 * 60 * 1000;
const WORKFLOW_AGENT_HEARTBEAT_MS = (() => {
  const raw = Number(process.env.WORKFLOW_AGENT_HEARTBEAT_MS || 30000);
  if (!Number.isFinite(raw)) return 30000;
  return Math.max(5000, Math.min(120000, Math.trunc(raw)));
})();
const WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT = (() => {
  const raw = Number(process.env.WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT || 80);
  if (!Number.isFinite(raw)) return 80;
  return Math.max(20, Math.min(500, Math.trunc(raw)));
})();
const BOSUN_ATTACHED_PR_LABEL = "bosun-attached";
const BOSUN_CREATED_PR_LABEL = "bosun-pr-bosun-created";
const BOSUN_CREATED_PR_MARKER = "<!-- bosun-created -->";
const markdownSafetyPolicyCache = new Map();

function isUsableGitRepoRoot(candidate) {
  const repoRoot = String(candidate || "").trim();
  if (!repoRoot) return false;
  try {
    const topLevel = execGitArgsSync(["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return Boolean(topLevel);
  } catch {
    return false;
  }
}

function hasGitMetadata(candidate) {
  const repoRoot = String(candidate || "").trim();
  if (!repoRoot) return false;
  try {
    return existsSync(resolve(repoRoot, ".git"));
  } catch {
    return false;
  }
}

function findContainingGitRepoRoot(candidate) {
  let current = String(candidate || "").trim();
  if (!current) return "";
  try {
    current = resolve(current);
  } catch {
    return "";
  }
  while (current) {
    if (hasGitMetadata(current) || isUsableGitRepoRoot(current)) {
      return current;
    }
    const parent = resolve(current, "..");
    if (!parent || parent === current) break;
    current = parent;
  }
  return "";
}

function extractGitHubRepoSlug(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const match = normalized.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
  return match?.[1] ? String(match[1]).replace(/\.git$/i, "") : "";
}

function isLocalFilesystemGitRemote(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return true;
  const normalized = raw.replace(/\\/g, "/");
  if (
    /github\.com[:/]/i.test(normalized) ||
    /^(?:https?|ssh|git):\/\//i.test(raw) ||
    /^[^@\s]+@[^:\s]+:.+/.test(raw)
  ) {
    return false;
  }
  return /^(?:[A-Za-z]:\/|\/|\.{1,2}\/|file:\/\/|\/\/)/.test(normalized);
}

function resolvePreferredPushRemote(worktreePath, preferredRemote, repoHint = "") {
  const fallbackRemote = String(preferredRemote || "origin").trim() || "origin";
  let remoteListRaw = "";
  try {
    remoteListRaw = execGitArgsSync(["remote"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return fallbackRemote;
  }
  const remoteNames = remoteListRaw.split(/\r?\n/).map((value) => String(value || "").trim()).filter(Boolean);
  if (remoteNames.length === 0) return fallbackRemote;
  const normalizedRepoHint = String(repoHint || "").trim().replace(/\.git$/i, "").toLowerCase();
  const remotes = remoteNames.map((name) => {
    let url = "";
    try {
      url = execGitArgsSync(["remote", "get-url", name], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // ignore unreadable remote
    }
    const slug = extractGitHubRepoSlug(url).toLowerCase();
    return {
      name,
      url,
      slug,
      isLocal: isLocalFilesystemGitRemote(url),
    };
  });
  const preferred = remotes.find((remote) => remote.name === fallbackRemote);
  if (
    preferred &&
    !preferred.isLocal &&
    (!normalizedRepoHint || !preferred.slug || preferred.slug === normalizedRepoHint)
  ) {
    return preferred.name;
  }
  const repoMatched = remotes.find((remote) => !remote.isLocal && normalizedRepoHint && remote.slug === normalizedRepoHint);
  if (repoMatched) return repoMatched.name;
  const githubRemote = remotes.find((remote) => !remote.isLocal && remote.slug);
  if (githubRemote) return githubRemote.name;
  const networkRemote = remotes.find((remote) => !remote.isLocal);
  return networkRemote?.name || fallbackRemote;
}

function resolveWorkflowRepoRoot(node, ctx) {
  const taskPayload =
    ctx?.data?.task && typeof ctx.data.task === "object"
      ? ctx.data.task
      : null;
  const taskMeta =
    taskPayload?.meta && typeof taskPayload.meta === "object"
      ? taskPayload.meta
      : null;
  const repositoryHint = pickTaskString(
    cfgOrCtx(node, ctx, "repository"),
    ctx?.data?.repository,
    taskPayload?.repository,
    taskPayload?.repo,
    taskMeta?.repository,
    taskMeta?.repo,
  );
  const workspaceHint = pickTaskString(
    cfgOrCtx(node, ctx, "workspace"),
    ctx?.data?.workspace,
    taskPayload?.workspace,
    taskPayload?.workspaceId,
    taskMeta?.workspace,
    taskMeta?.workspaceId,
  );
  const explicitCandidates = [];
  for (const rawCandidate of [
    cfgOrCtx(node, ctx, "repoRoot"),
    ctx?.data?.repoRoot,
    taskPayload?.repoRoot,
    taskMeta?.repoRoot,
  ]) {
    const candidate = String(rawCandidate || "").trim();
    if (!candidate) continue;
    explicitCandidates.push(resolve(candidate));
  }
  for (const candidate of explicitCandidates) {
    if (repositoryHint) {
      const inferred = resolveTaskRepositoryRoot(repositoryHint, candidate, workspaceHint);
      if (inferred && hasGitMetadata(inferred)) return resolve(inferred);
    }
    if (hasGitMetadata(candidate)) return resolve(candidate);
  }
  if (!repositoryHint && explicitCandidates.length > 0) {
    return explicitCandidates[0];
  }
  const cwdCandidate = String(process.cwd() || "").trim();
  const containingCwdRepo = findContainingGitRepoRoot(cwdCandidate);
  const candidateSet = new Set();
  for (const rawCandidate of [
    cfgOrCtx(node, ctx, "repoRoot"),
    ctx?.data?.repoRoot,
    taskPayload?.repoRoot,
    taskMeta?.repoRoot,
    containingCwdRepo,
    resolveConfiguredRepoRoot({ cwd: process.cwd() }),
    process.cwd(),
  ]) {
    const candidate = String(rawCandidate || "").trim();
    if (!candidate) continue;
    candidateSet.add(resolve(candidate));
  }
  const candidates = [...candidateSet];
  for (const candidate of candidates) {
    if (repositoryHint) {
      const inferred = resolveTaskRepositoryRoot(repositoryHint, candidate, workspaceHint);
      if (inferred && isUsableGitRepoRoot(inferred)) return resolve(inferred);
    }
    if (isUsableGitRepoRoot(candidate)) return resolve(candidate);
  }
  if (repositoryHint) {
    for (const candidate of candidates) {
      const inferred = resolveTaskRepositoryRoot(repositoryHint, candidate, workspaceHint);
      if (inferred) return resolve(inferred);
    }
  }
  return candidates[0] || resolve(process.cwd());
}

function getRepoMarkdownSafetyPolicy(repoRoot) {
  const normalizedRoot = resolve(repoRoot || process.cwd());
  const cached = markdownSafetyPolicyCache.get(normalizedRoot);
  if (cached) return cached;
  let configData = {};
  try {
    ({ configData } = readConfigDocument(normalizedRoot));
  } catch {
    configData = {};
  }
  const policy = resolveMarkdownSafetyPolicy(configData);
  markdownSafetyPolicyCache.set(normalizedRoot, policy);
  return policy;
}

function appendBosunCreatedPrFooter(body = "") {
  const text = String(body || "");
  if (text.includes(BOSUN_CREATED_PR_MARKER) || /auto-created by bosun/i.test(text)) {
    return text;
  }
  const trimmed = text.trimEnd();
  const footer = `${BOSUN_CREATED_PR_MARKER}\nBosun-Origin: created`;
  return trimmed ? `${trimmed}\n\n---\n${footer}` : footer;
}

function taskHasReviewReference(task) {
  if (!task || typeof task !== "object") return false;
  const prNumber = Number.parseInt(String(task.prNumber || task.pr_number || ""), 10);
  if (Number.isFinite(prNumber) && prNumber > 0) return true;
  if (String(task.prUrl || task.pr_url || "").trim()) return true;
  if (Array.isArray(task.links?.prs) && task.links.prs.some((value) => String(value || "").trim())) {
    return true;
  }
  return false;
}

function shouldKeepTaskInReview(task, requestedStatus) {
  if (!taskHasReviewReference(task)) return false;
  if (String(task?.status || "").trim().toLowerCase() !== "inreview") return false;
  const nextStatus = String(requestedStatus || "").trim().toLowerCase();
  return nextStatus === "todo" || nextStatus === "inprogress" || nextStatus === "backlog";
}

function normalizeTaskAvailableStatuses(rawStatus) {
  const values = Array.isArray(rawStatus)
    ? rawStatus
    : String(rawStatus == null ? "todo" : rawStatus).split(",");
  const normalized = values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean)
    .map((value) => {
      if (value === "review" || value === "in-review") return "inreview";
      if (value === "backlog") return "todo";
      return value;
    });
  return Array.from(new Set(normalized.length > 0 ? normalized : ["todo"]));
}

function getNonRetryableWorktreeRecoveryMs() {
  try {
    const config = loadConfig();
    const minutes = Number(config?.workflowWorktreeRecoveryCooldownMin);
    if (!Number.isFinite(minutes)) {
      return DEFAULT_NON_RETRYABLE_WORKTREE_RECOVERY_MS;
    }
    return Math.max(1, Math.min(1440, Math.trunc(minutes))) * 60 * 1000;
  } catch {
    return DEFAULT_NON_RETRYABLE_WORKTREE_RECOVERY_MS;
  }
}

const HTML_TEXT_BREAK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function decodeHtmlEntities(value = "") {
  return String(value).replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const normalized = entity.toLowerCase();
    switch (normalized) {
      case "&nbsp;":
        return " ";
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
      case "&#39;":
        return "'";
      default:
        if (normalized.startsWith("&#x")) {
          return String.fromCodePoint(Number.parseInt(normalized.slice(3, -1), 16));
        }
        if (normalized.startsWith("&#")) {
          return String.fromCodePoint(Number.parseInt(normalized.slice(2, -1), 10));
        }
        return entity;
    }
  });
}

function stripHtmlToText(html = "") {
  const input = String(html ?? "");
  let plain = "";
  let index = 0;
  let skippedTagName = null;

  while (index < input.length) {
    const tagStart = input.indexOf("<", index);
    if (tagStart === -1) {
      if (!skippedTagName) plain += input.slice(index);
      break;
    }

    if (!skippedTagName && tagStart > index) {
      plain += input.slice(index, tagStart);
    }

    const tagEnd = input.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      if (!skippedTagName) plain += input.slice(tagStart).replace(/</g, " ");
      break;
    }

    const rawTag = input.slice(tagStart + 1, tagEnd).trim();
    const loweredTag = rawTag.toLowerCase();
    const isClosingTag = loweredTag.startsWith("/");
    const normalizedTag = isClosingTag ? loweredTag.slice(1).trimStart() : loweredTag;
    const tagName = normalizedTag.match(/^[a-z0-9]+/i)?.[0] ?? "";

    if (skippedTagName) {
      if (isClosingTag && tagName === skippedTagName) {
        skippedTagName = null;
        plain += " ";
      }
      index = tagEnd + 1;
      continue;
    }

    if (tagName === "script" || tagName === "style") {
      if (!isClosingTag && !normalizedTag.endsWith("/")) {
        skippedTagName = tagName;
      }
      index = tagEnd + 1;
      continue;
    }

    if (HTML_TEXT_BREAK_TAGS.has(tagName)) {
      plain += " ";
    }

    index = tagEnd + 1;
  }

  return decodeHtmlEntities(plain);
}


const PORT_TYPE_DESCRIPTIONS = Object.freeze({
  Any: "Wildcard payload",
  TaskDef: "Task definition/context payload",
  TriggerEvent: "Event payload emitted by trigger nodes",
  AgentResult: "Agent execution output",
  String: "Text payload",
  Boolean: "Boolean flag",
  Number: "Numeric payload",
  JSON: "Structured JSON payload",
  GitRef: "Git branch/hash/ref payload",
  PRUrl: "Pull request URL payload",
  LogStream: "Log output or command transcript",
  SessionRef: "Session identifier payload",
  CommandResult: "Command execution result",
});

const PORT_TYPE_COLORS = Object.freeze({
  Any: "#9ca3af",
  TaskDef: "#10b981",
  TriggerEvent: "#22c55e",
  AgentResult: "#8b5cf6",
  String: "#3b82f6",
  Boolean: "#14b8a6",
  Number: "#0ea5e9",
  JSON: "#06b6d4",
  GitRef: "#f97316",
  PRUrl: "#f43f5e",
  LogStream: "#eab308",
  SessionRef: "#a855f7",
  CommandResult: "#f59e0b",
});

function clonePortSpec(port, fallbackName = "default") {
  if (!port || typeof port !== "object") {
    const type = "Any";
    return {
      name: fallbackName,
      label: fallbackName,
      type,
      description: PORT_TYPE_DESCRIPTIONS[type],
      color: PORT_TYPE_COLORS[type] || null,
      accepts: [],
    };
  }
  const type = String(port.type || "Any").trim() || "Any";
  return {
    ...port,
    name: String(port.name || fallbackName).trim() || fallbackName,
    label: String(port.label || port.name || fallbackName).trim() || fallbackName,
    type,
    description: String(port.description || PORT_TYPE_DESCRIPTIONS[type] || "").trim(),
    color: String(port.color || PORT_TYPE_COLORS[type] || "").trim() || null,
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
  };
}

function makePort(name, type, description = "", extra = {}) {
  return clonePortSpec({
    name,
    label: name,
    type,
    description: description || PORT_TYPE_DESCRIPTIONS[type] || "",
    color: PORT_TYPE_COLORS[type] || null,
    ...extra,
  }, name || "default");
}

const CATEGORY_PORT_DEFAULTS = Object.freeze({
  trigger: Object.freeze({
    inputs: [],
    outputs: [makePort("default", "TriggerEvent")],
  }),
  condition: Object.freeze({
    inputs: [makePort("default", "JSON", "", { accepts: ["TriggerEvent", "TaskDef", "AgentResult", "String", "Any"] })],
    outputs: [makePort("default", "Boolean")],
  }),
  action: Object.freeze({
    inputs: [makePort("default", "TaskDef", "", { accepts: ["TriggerEvent", "JSON", "String", "Boolean", "Any"] })],
    outputs: [makePort("default", "JSON")],
  }),
  validation: Object.freeze({
    inputs: [makePort("default", "JSON", "", { accepts: ["TaskDef", "Any"] })],
    outputs: [makePort("default", "Boolean")],
  }),
  transform: Object.freeze({
    inputs: [makePort("default", "JSON", "", { accepts: ["Any", "String"] })],
    outputs: [makePort("default", "JSON")],
  }),
  notify: Object.freeze({
    inputs: [makePort("default", "String", "", { accepts: ["Any", "JSON", "AgentResult", "LogStream"] })],
    outputs: [makePort("default", "Any")],
  }),
  flow: Object.freeze({
    inputs: [makePort("default", "Any")],
    outputs: [makePort("default", "Any")],
  }),
  loop: Object.freeze({
    inputs: [makePort("default", "Any")],
    outputs: [makePort("default", "Any")],
  }),
  meeting: Object.freeze({
    inputs: [makePort("default", "SessionRef", "", { accepts: ["TriggerEvent", "Any"] })],
    outputs: [makePort("default", "JSON")],
  }),
  agent: Object.freeze({
    inputs: [makePort("default", "TaskDef", "", { accepts: ["TriggerEvent", "JSON", "String", "Any"] })],
    outputs: [makePort("default", "AgentResult")],
  }),
});

const NODE_PORT_OVERRIDES = Object.freeze({
  "trigger.manual": {
    outputs: [makePort("default", "TaskDef", "Manual dispatch payload")],
  },
  "trigger.event": {
    outputs: [makePort("default", "TriggerEvent", "Event payload")],
  },
  "action.run_agent": {
    inputs: [makePort("default", "TaskDef", "", { accepts: ["TriggerEvent", "String", "JSON", "Boolean", "Any"] })],
    outputs: [makePort("default", "AgentResult", "Agent response payload")],
  },
  "action.run_command": {
    inputs: [makePort("default", "String", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "Any"] })],
    outputs: [makePort("default", "CommandResult", "Command execution output", { accepts: ["LogStream"] })],
  },
  "action.git_operations": {
    inputs: [makePort("default", "GitRef", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "String", "Any"] })],
    outputs: [makePort("default", "GitRef", "Git operation result/ref")],
  },
  "action.push_branch": {
    inputs: [makePort("default", "GitRef", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "String", "Any"] })],
    outputs: [makePort("default", "GitRef")],
  },
  "action.detect_new_commits": {
    inputs: [makePort("default", "GitRef", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "String", "Any"] })],
    outputs: [makePort("default", "GitRef", "Commit detection summary")],
  },
  "action.auto_commit_dirty": {
    inputs: [makePort("default", "GitRef", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "String", "Any"] })],
    outputs: [makePort("default", "GitRef", "Auto-commit result")],
  },
  "action.create_pr": {
    inputs: [makePort("default", "GitRef", "", { accepts: ["TaskDef", "JSON", "TriggerEvent", "Boolean", "String", "Any"] })],
    outputs: [makePort("default", "PRUrl", "Pull request link payload")],
  },
  "transform.json_parse": {
    inputs: [makePort("default", "String", "", { accepts: ["JSON", "Any"] })],
    outputs: [makePort("default", "JSON")],
  },
  "condition.expression": {
    inputs: [makePort("default", "JSON", "", { accepts: ["TaskDef", "AgentResult", "Any"] })],
    outputs: [makePort("default", "Boolean")],
  },
  "notify.log": {
    inputs: [makePort("default", "LogStream", "", { accepts: ["String", "Any", "JSON"] })],
    outputs: [makePort("default", "LogStream")],
  },
  "action.continue_session": {
    inputs: [makePort("default", "SessionRef", "", { accepts: ["TaskDef", "Any"] })],
    outputs: [makePort("default", "AgentResult")],
  },
  "action.restart_agent": {
    inputs: [makePort("default", "SessionRef", "", { accepts: ["TaskDef", "Any"] })],
    outputs: [makePort("default", "AgentResult")],
  },
  "action.team_task_claim": {
    outputs: [
      makePort("default", "JSON", "Team task claim result"),
      makePort("claimed", "JSON", "Successful claim result"),
      makePort("unavailable", "JSON", "Claim conflict or missing task"),
    ],
  },
  "action.team_task_complete": {
    outputs: [
      makePort("default", "JSON", "Team task completion result"),
      makePort("completed", "JSON", "Completed task result"),
      makePort("released", "JSON", "Released task result"),
    ],
  },
  "action.team_message": {
    outputs: [
      makePort("default", "JSON", "Team message delivery result"),
      makePort("direct", "JSON", "Direct teammate message"),
      makePort("channel", "JSON", "Channel message"),
    ],
  },
});

const NODE_PRIMARY_FIELD_OVERRIDES = Object.freeze({
  "action.run_agent": ["model", "prompt", "stream"],
  "condition.expression": ["expression"],
  "trigger.event": ["eventType", "filter"],
  "trigger.schedule": ["intervalMs", "cron"],
  "trigger.scheduled_once": ["runAt", "timezone"],
  "action.git_operations": ["operation", "branch", "targetBranch"],
  "action.create_pr": ["title", "baseBranch", "headBranch"],
  "action.run_command": ["command", "cwd"],
  "notify.telegram": ["chatId", "message"],
  "action.team_init": ["teamId", "leadId", "defaultChannel"],
  "action.team_task_publish": ["title", "createdBy", "channelId"],
  "action.team_task_claim": ["taskId", "memberId", "actorId"],
  "action.team_task_complete": ["taskId", "memberId", "release"],
  "action.team_message": ["fromMemberId", "toMemberId", "channelId"],
  "action.team_inbox": ["memberId", "channelId", "limit"],
  "action.team_snapshot": ["includeTasks", "includeMessages", "includeRoster"],
});

function inferPrimaryFields(schemaProps = {}) {
  const keys = Object.keys(schemaProps || {});
  if (keys.length === 0) return [];
  const priority = [
    "model",
    "expression",
    "enabled",
    "branch",
    "branchName",
    "baseBranch",
    "headBranch",
    "eventType",
    "command",
    "message",
    "prompt",
    "query",
    "operation",
    "timeout",
  ];
  const selected = [];
  for (const key of priority) {
    if (keys.includes(key) && !selected.includes(key)) selected.push(key);
    if (selected.length >= 3) return selected;
  }
  for (const key of keys) {
    const field = schemaProps[key] || {};
    const type = String(field.type || "string");
    const isShortString = type === "string" && !field.format && !String(key).toLowerCase().includes("path");
    const isBoolean = type === "boolean";
    if (field.enum || isShortString || isBoolean) {
      if (!selected.includes(key)) selected.push(key);
    }
    if (selected.length >= 3) break;
  }
  return selected.slice(0, 3);
}

function buildNodePorts(type, handler) {
  const explicitPorts = handler?.ports || {};
  const explicitInputs = Array.isArray(handler?.inputs) ? handler.inputs : explicitPorts.inputs;
  const explicitOutputs = Array.isArray(handler?.outputs) ? handler.outputs : explicitPorts.outputs;
  if (Array.isArray(explicitInputs) || Array.isArray(explicitOutputs)) {
    return {
      inputs: (explicitInputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `input-${index + 1}`)),
      outputs: (explicitOutputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `output-${index + 1}`)),
    };
  }

  const override = NODE_PORT_OVERRIDES[type];
  if (override) {
    return {
      inputs: (override.inputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `input-${index + 1}`)),
      outputs: (override.outputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `output-${index + 1}`)),
    };
  }

  const [category] = String(type || "").split(".");
  const fallback = CATEGORY_PORT_DEFAULTS[category] || CATEGORY_PORT_DEFAULTS.flow;
  return {
    inputs: (fallback.inputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `input-${index + 1}`)),
    outputs: (fallback.outputs || []).map((port, index) => clonePortSpec(port, index === 0 ? "default" : `output-${index + 1}`)),
  };
}

function buildNodeUi(type, handler) {
  const schemaProps = handler?.schema?.properties || {};
  const explicitPrimaryFields = Array.isArray(handler?.ui?.primaryFields)
    ? handler.ui.primaryFields
    : null;
  const inferred = NODE_PRIMARY_FIELD_OVERRIDES[type] || inferPrimaryFields(schemaProps);
  return {
    ...(handler?.ui || {}),
    primaryFields: (explicitPrimaryFields || inferred)
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  };
}

function registerBuiltinNodeType(type, handler) {
  const ports = buildNodePorts(type, handler);
  const ui = buildNodeUi(type, handler);
  handler.ports = ports;
  handler.ui = ui;
  registerNodeType(type, handler);
}

function resolveSelfImprovementScope(ctx, node, overrides = {}) {
  const normalize = (value) => {
    const text = String(value ?? "").trim();
    return text || null;
  };
  const fromTask = ctx?.data?.task && typeof ctx.data.task === "object" ? ctx.data.task : null;
  const taskMeta = fromTask?.meta && typeof fromTask.meta === "object" ? fromTask.meta : null;
  return {
    repoRoot: normalize(overrides.repoRoot) || normalize(ctx?.data?.repoRoot) || process.cwd(),
    teamId: normalize(overrides.teamId) || normalize(taskMeta?.teamId) || normalize(ctx?.data?.teamId),
    workspaceId:
      normalize(overrides.workspaceId) ||
      normalize(taskMeta?.workspaceId) ||
      normalize(ctx?.data?._workspaceId) ||
      normalize(ctx?.data?.workspaceId),
    sessionId:
      normalize(overrides.sessionId) ||
      normalize(taskMeta?.sessionId) ||
      normalize(ctx?.data?.sessionId) ||
      normalize(ctx?.data?.threadId),
    runId: normalize(overrides.runId) || normalize(ctx?.data?.runId) || normalize(ctx?.id),
    workflowId:
      normalize(overrides.workflowId) ||
      normalize(ctx?.data?._workflowId) ||
      normalize(ctx?.data?.workflowId),
    taskId:
      normalize(overrides.taskId) ||
      normalize(ctx?.data?.taskId) ||
      normalize(fromTask?.id),
    taskTitle:
      normalize(overrides.taskTitle) ||
      normalize(ctx?.data?.taskTitle) ||
      normalize(fromTask?.title),
    agentId: normalize(overrides.agentId) || normalize(node?.id) || "workflow",
    agentType: normalize(overrides.agentType) || "workflow",
  };
}

function makeSelfImprovementEvaluator(ctx, options = {}) {
  const repoRoot = String(options.repoRoot || ctx?.data?.repoRoot || process.cwd()).trim() || process.cwd();
  return new RunEvaluator({
    configDir: repoRoot,
    ...(options.evaluatorConfig && typeof options.evaluatorConfig === "object"
      ? options.evaluatorConfig
      : {}),
  });
}

function normalizeSelfImprovementTagList(...values) {
  const out = [];
  const seen = new Set();
  const append = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) append(item);
    } else if (typeof value === "string" && value.includes(",")) {
      for (const item of value.split(",")) append(item);
    } else {
      append(value);
    }
  }
  return out;
}

function resolveSelfImprovementStrategy(evaluation, requestedStrategyId = null, fallbackStrategy = null) {
  if (requestedStrategyId && Array.isArray(evaluation?.strategies)) {
    const matched = evaluation.strategies.find((strategy) => strategy?.strategyId === requestedStrategyId);
    if (matched) return matched;
  }
  if (fallbackStrategy && typeof fallbackStrategy === "object") {
    return fallbackStrategy;
  }
  if (evaluation?.ratchet?.targetStrategy && typeof evaluation.ratchet.targetStrategy === "object") {
    return evaluation.ratchet.targetStrategy;
  }
  if (evaluation?.promotion?.selectedStrategy && typeof evaluation.promotion.selectedStrategy === "object") {
    return evaluation.promotion.selectedStrategy;
  }
  return Array.isArray(evaluation?.strategies) ? evaluation.strategies[0] || null : null;
}

function normalizeSkillbookGuidancePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const strategies = Array.isArray(value.strategies)
    ? value.strategies.filter((entry) => entry && typeof entry === "object")
    : [];
  const guidanceSummary = String(value.guidanceSummary || value.summary || "").trim();
  if (!guidanceSummary && strategies.length === 0) return null;
  return {
    ...value,
    strategies,
    guidanceSummary,
  };
}

function buildSkillbookPromptContext(guidance) {
  const normalized = normalizeSkillbookGuidancePayload(guidance);
  if (!normalized) return "";
  return String(normalized.guidanceSummary || "").trim();
}

async function resolveReusableSkillbookGuidance(ctx, options = {}) {
  const hasExplicitWorkflowId = Object.prototype.hasOwnProperty.call(options, "workflowId");
  const repoRoot = String(
    options.repoRoot
    || ctx?.data?.repoRoot
    || process.cwd(),
  ).trim() || process.cwd();
  const workflowId = String(
    hasExplicitWorkflowId
      ? options.workflowId
      : (
          ctx?.data?._workflowId
          || ctx?.data?.workflowId
          || ""
        )
  ).trim();
  const category = String(options.category || "strategy").trim() || "strategy";
  const scopeLevel = String(options.scopeLevel || "").trim();
  const scope = String(options.scope || "").trim();
  const status = String(options.status || "").trim() || "promoted";
  const query = String(options.query || "").trim();
  const tags = Array.isArray(options.tags) ? options.tags : normalizeSelfImprovementTagList(options.tags);
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : 5;
  const result = await findReusableSkillbookStrategies({
    repoRoot,
    workflowId: workflowId || undefined,
    category,
    scopeLevel: scopeLevel || undefined,
    scope: scope || undefined,
    status: status || undefined,
    query: query || undefined,
    tags,
    limit,
  });
  return {
    success: true,
    repoRoot,
    workflowId: workflowId || null,
    category,
    scopeLevel: scopeLevel || null,
    scope: scope || null,
    status: status || null,
    query: query || null,
    tags,
    total: result.total,
    matched: result.matched,
    strategies: result.strategies,
    guidanceSummary: result.guidanceSummary,
    skillbookPath: result.skillbookPath,
    strategyIds: result.strategies.map((entry) => entry?.strategyId).filter(Boolean),
  };
}

function summarizeRunGraphDiff(diff = null) {
  if (!diff || typeof diff !== "object") return null;
  const added = Array.isArray(diff?.executionDelta?.added) ? diff.executionDelta.added.length : 0;
  const removed = Array.isArray(diff?.executionDelta?.removed) ? diff.executionDelta.removed.length : 0;
  const changed = Array.isArray(diff?.executionDelta?.changed) ? diff.executionDelta.changed.length : 0;
  return {
    added,
    removed,
    changed,
    sample: {
      added: Array.isArray(diff?.executionDelta?.added) ? diff.executionDelta.added.slice(0, 3) : [],
      removed: Array.isArray(diff?.executionDelta?.removed) ? diff.executionDelta.removed.slice(0, 3) : [],
      changed: Array.isArray(diff?.executionDelta?.changed) ? diff.executionDelta.changed.slice(0, 3) : [],
    },
  };
}

async function persistSelfImprovementKnowledgeEntry(ctx, node, {
  evaluation,
  selectedStrategy,
  decision,
  repoRoot = "",
  targetFile = "",
  registryFile = "",
  scopeLevel = "workspace",
  scope = "",
  category = "strategy",
  status = "",
  tags = [],
  agentId = "",
  agentType = "",
  contentLines = [],
}) {
  if (!selectedStrategy || typeof selectedStrategy !== "object") {
    return {
      success: false,
      persisted: false,
      reason: "No strategy candidate available for promotion",
    };
  }

  const resolvedScope = resolveSelfImprovementScope(ctx, node, { repoRoot, agentId, agentType });
  const resolvedTargetFile = String(targetFile || "").trim();
  const resolvedRegistryFile = String(registryFile || "").trim();
  const resolvedScopeLevel = String(scopeLevel || "workspace").trim().toLowerCase() || "workspace";
  const resolvedCategory = String(category || "strategy").trim() || "strategy";
  const resolvedStatus = String(status || "").trim() || "promoted";
  const tagValues = normalizeSelfImprovementTagList(tags, selectedStrategy.tags || []);

  const initOpts = { repoRoot: resolvedScope.repoRoot };
  if (resolvedTargetFile) initOpts.targetFile = resolvedTargetFile;
  if (resolvedRegistryFile) initOpts.registryFile = resolvedRegistryFile;
  initSharedKnowledge(initOpts);

  const content = contentLines.filter(Boolean).join("\n");
  const entry = buildKnowledgeEntry({
    content,
    scope: String(scope || selectedStrategy.category || "self-improvement").trim(),
    category: resolvedCategory,
    scopeLevel: resolvedScopeLevel,
    teamId: resolvedScope.teamId,
    workspaceId: resolvedScope.workspaceId,
    sessionId: resolvedScope.sessionId,
    runId: resolvedScope.runId,
    workflowId: resolvedScope.workflowId || evaluation?.workflowId || null,
    taskRef: resolvedScope.taskId || null,
    strategyId: selectedStrategy.strategyId || null,
    confidence: selectedStrategy.confidence,
    verificationStatus: decision || evaluation?.promotion?.decision || "promote_strategy",
    verifiedAt: new Date().toISOString(),
    provenance: [
      `run:${evaluation?.runId || resolvedScope.runId || "unknown"}`,
      `workflow:${evaluation?.workflowId || resolvedScope.workflowId || "unknown"}`,
      ...(Array.isArray(selectedStrategy.evidence) ? selectedStrategy.evidence : []),
    ],
    evidence: Array.isArray(selectedStrategy.evidence) ? selectedStrategy.evidence : [],
    agentId: resolvedScope.agentId,
    agentType: resolvedScope.agentType,
    tags: tagValues,
  });

  const knowledgeResult = await appendKnowledgeEntry(entry, { skipRateLimit: true });
  const knowledgeNonFatal = !knowledgeResult.success
    && /duplicate entry|rate limited/i.test(String(knowledgeResult.reason || ""));
  if (!knowledgeResult.success && !knowledgeNonFatal) {
    return {
      success: false,
      persisted: false,
      reason: knowledgeResult.reason,
      strategyId: selectedStrategy.strategyId,
      entry,
    };
  }

  const skillbookResult = await upsertSkillbookStrategy({
    strategyId: selectedStrategy.strategyId || null,
    workflowId: resolvedScope.workflowId || evaluation?.workflowId || null,
    runId: evaluation?.runId || resolvedScope.runId || null,
    taskId: resolvedScope.taskId || null,
    sessionId: resolvedScope.sessionId || null,
    teamId: resolvedScope.teamId || null,
    workspaceId: resolvedScope.workspaceId || null,
    scope: entry.scope,
    scopeLevel: resolvedScopeLevel,
    category: resolvedCategory,
    decision: decision || evaluation?.promotion?.decision || "promote_strategy",
    status: resolvedStatus,
    verificationStatus: entry.verificationStatus,
    confidence: selectedStrategy.confidence,
    recommendation: selectedStrategy.recommendation,
    rationale: selectedStrategy.rationale,
    evidence: selectedStrategy.evidence || [],
    provenance: entry.provenance || [],
    tags: tagValues,
    benchmark: evaluation?.benchmark || null,
    metrics: evaluation?.metrics || null,
    evaluation: {
      runId: evaluation?.runId || null,
      workflowId: evaluation?.workflowId || null,
      score: evaluation?.score ?? null,
      grade: evaluation?.grade || null,
      promotion: evaluation?.promotion || null,
      ratchet: evaluation?.ratchet || null,
    },
    knowledge: {
      hash: knowledgeResult.hash || entry.hash,
      registryPath: knowledgeResult.registryPath || null,
      targetFile: resolvedTargetFile || null,
      entry,
      persisted: knowledgeResult.success === true,
      reason: knowledgeResult.reason || null,
    },
    summary: contentLines.find(Boolean) || selectedStrategy.recommendation || null,
  }, { repoRoot: resolvedScope.repoRoot });

  const ledgerResult = appendPromotedStrategyToStateLedger({
    strategyId: selectedStrategy.strategyId || null,
    workflowId: resolvedScope.workflowId || evaluation?.workflowId || null,
    runId: evaluation?.runId || resolvedScope.runId || null,
    taskId: resolvedScope.taskId || null,
    sessionId: resolvedScope.sessionId || null,
    teamId: resolvedScope.teamId || null,
    workspaceId: resolvedScope.workspaceId || null,
    scope: entry.scope,
    scopeId:
      resolvedScopeLevel === "team"
        ? resolvedScope.teamId
        : resolvedScopeLevel === "workspace"
          ? resolvedScope.workspaceId
          : resolvedScopeLevel === "session"
            ? resolvedScope.sessionId
            : resolvedScope.runId,
    scopeLevel: resolvedScopeLevel,
    category: resolvedCategory,
    decision: decision || evaluation?.promotion?.decision || "promote_strategy",
    status: resolvedStatus,
    verificationStatus: entry.verificationStatus,
    confidence: selectedStrategy.confidence,
    recommendation: selectedStrategy.recommendation,
    rationale: selectedStrategy.rationale,
    evidence: selectedStrategy.evidence || [],
    provenance: entry.provenance || [],
    tags: tagValues,
    benchmark: evaluation?.benchmark || null,
    metrics: evaluation?.metrics || null,
    evaluation: {
      runId: evaluation?.runId || null,
      workflowId: evaluation?.workflowId || null,
      score: evaluation?.score ?? null,
      grade: evaluation?.grade || null,
      promotion: evaluation?.promotion || null,
      ratchet: evaluation?.ratchet || null,
    },
    strategy: selectedStrategy,
    knowledge: {
      hash: knowledgeResult.hash || entry.hash,
      registryPath: knowledgeResult.registryPath || null,
      targetFile: resolvedTargetFile || null,
      entry,
      persisted: knowledgeResult.success === true,
      reason: knowledgeResult.reason || null,
    },
    updatedAt: entry.verifiedAt,
  }, { repoRoot: resolvedScope.repoRoot });

  return {
    success: true,
    persisted: true,
    strategyId: selectedStrategy.strategyId,
    decision: decision || evaluation?.promotion?.decision || "promote_strategy",
    status: resolvedStatus,
    entry,
    hash: knowledgeResult.hash || entry.hash,
    registryPath: knowledgeResult.registryPath || null,
    knowledgePersisted: knowledgeResult.success === true,
    knowledgeSkipped: knowledgeNonFatal,
    knowledgeReason: knowledgeResult.reason || null,
    skillbookPath: skillbookResult.path || null,
    skillbookEntry: skillbookResult.entry || null,
    ledgerPath: ledgerResult.path || null,
    ledgerEventId: ledgerResult.eventId || null,
  };
}

function shouldBypassGhPrCreationForTests() {
  const runningUnderVitest = Boolean(process.env.VITEST);
  const runningUnderNodeTest = process.argv.includes("--test") || Boolean(process.env.NODE_TEST_CONTEXT);
  return (runningUnderVitest || runningUnderNodeTest) && process.env.BOSUN_TEST_ALLOW_GH !== "true";
}

function shouldSkipGitRefreshForTests() {
  return Boolean(process.env.VITEST) && process.env.BOSUN_TEST_ALLOW_GIT_REFRESH !== "true";
}

function getNoopGitEditorCommand() {
  const nodeBinary = JSON.stringify(process.execPath);
  return `${nodeBinary} -e ""`;
}

function makeIsolatedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  // Force git to stay non-interactive inside Bosun-managed automation paths.
  env.GIT_TERMINAL_PROMPT = env.GIT_TERMINAL_PROMPT || "0";
  env.GCM_INTERACTIVE = env.GCM_INTERACTIVE || "never";
  env.GIT_MERGE_AUTOEDIT = env.GIT_MERGE_AUTOEDIT || "no";
  env.GIT_EDITOR = env.GIT_EDITOR || getNoopGitEditorCommand();
  env.GIT_SEQUENCE_EDITOR = env.GIT_SEQUENCE_EDITOR || env.GIT_EDITOR;
  return env;
}

function resolveGitCandidates(env = process.env) {
  const candidates = [];
  const envGitExe = env?.GIT_EXE || process.env.GIT_EXE;
  if (envGitExe) candidates.push(envGitExe);
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe",
    );
  } else {
    candidates.push(
      "/usr/bin/git",
      "/usr/local/bin/git",
      "/bin/git",
      "/opt/homebrew/bin/git",
    );
  }

  if (process.platform === "win32") {
    try {
      const whereOutput = execFileSync("where.exe", ["git"], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      for (const line of String(whereOutput || "").split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        candidates.push(candidate);
      }
    } catch {
      /* best-effort */
    }
  }

  candidates.push("git");
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === "win32"
      ? String(candidate || "").toLowerCase()
      : String(candidate || "");
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function buildGitExecutionEnv(baseEnv, gitBinary) {
  if (process.platform !== "win32") return baseEnv;
  const normalizedBinary = String(gitBinary || "").replace(/\//g, "\\");
  if (!normalizedBinary.includes("\\") || !normalizedBinary.toLowerCase().endsWith("\\git.exe")) {
    return baseEnv;
  }
  const env = { ...baseEnv };
  const pathKey = Object.prototype.hasOwnProperty.call(env, "Path")
    ? "Path"
    : "PATH";
  const existing = String(env[pathKey] ?? env.PATH ?? env.Path ?? "");
  const parts = existing
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  const binaryDir = dirname(normalizedBinary);
  const gitRoot = dirname(binaryDir);
  for (const dir of [
    binaryDir,
    `${gitRoot}\\cmd`,
    `${gitRoot}\\bin`,
    `${gitRoot}\\mingw64\\bin`,
    `${gitRoot}\\usr\\bin`,
  ]) {
    const normalizedDir = String(dir || "").replace(/\//g, "\\");
    if (!normalizedDir || seen.has(normalizedDir.toLowerCase())) continue;
    seen.add(normalizedDir.toLowerCase());
    parts.unshift(normalizedDir);
  }
  env[pathKey] = parts.join(";");
  if (pathKey === "PATH") env.Path = env[pathKey];
  else env.PATH = env[pathKey];
  return env;
}

function execGitArgsSync(args, options = {}) {
  if (!Array.isArray(args) || !args.length) {
    throw new Error("execGitArgsSync requires a non-empty args array");
  }
  const env = makeIsolatedGitEnv(options.env);
  const gitArgs = args.map((arg) => String(arg));
  let lastEnoent = null;
  for (const gitBinary of resolveGitCandidates(env)) {

    try {
      return execFileSync(gitBinary, gitArgs, {
        ...options,
        env: buildGitExecutionEnv(env, gitBinary),
        windowsHide: options.windowsHide ?? true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastEnoent = error;
        continue;
      }
      throw error;
    }
  }
  if (lastEnoent) throw lastEnoent;
  throw new Error("Git executable not found");
}

function buildPortableCommand(command = "") {
  const text = String(command || "").trim();
  if (!text) return { command: text, shell: false };
  if (process.platform !== "win32") return { command: text, shell: true };

  const normalized = text.replace(/\s+/g, " ").trim();
  if (/^npm(?:\.cmd)?\s+/i.test(normalized) || /^npx(?:\.cmd)?\s+/i.test(normalized)) {
    return { command: normalized, shell: true };
  }
  return { command: normalized, shell: true };
}

function buildExecSyncOptions(command, { cwd, timeout, encoding = "utf8", stdio = "pipe" } = {}) {
  const portable = buildPortableCommand(command);
  return {
    command: portable.command,
    options: {
      cwd,
      timeout,
      encoding,
      stdio,
      shell: portable.shell,
      windowsHide: true,
    },
  };
}

function trimLogText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeLineEndings(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function simplifyPathLabel(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return parts[0] || normalized;
}

const PR_EVENT_ALIAS_MAP = Object.freeze({
  open: "opened",
  opened: "opened",
  reopen: "opened",
  reopened: "opened",
  ready_for_review: "opened",
  readyforreview: "opened",
  synchronize: "opened",
  synchronized: "opened",
  edited: "opened",
  merge: "merged",
  merged: "merged",
  review_requested: "review_requested",
  reviewrequest: "review_requested",
  review_requested_event: "review_requested",
  changes_requested: "changes_requested",
  change_requested: "changes_requested",
  requested_changes: "changes_requested",
  approved: "approved",
  approval: "approved",
  close: "closed",
  closed: "closed",
});

function normalizePrEventName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw.replace(/[\s-]+/g, "_");
  return PR_EVENT_ALIAS_MAP[normalized] || normalized;
}

function evaluateTaskAssignedTriggerConfig(config = {}, eventData = {}) {
  const evtType = eventData?.eventType;
  let triggered = evtType === "task.assigned" || evtType === "task.review_fix_requested";
  if (!triggered) return false;

  const task = eventData?.task || eventData || {};
  const expectedAgentType = String(config?.agentType || "").trim().toLowerCase();
  if (expectedAgentType) {
    const candidateTypes = new Set(
      [
        eventData?.agentType,
        eventData?.assignedAgentType,
        eventData?.task?.agentType,
        eventData?.task?.assignedAgentType,
        eventData?.task?.agentProfile,
        task?.agentType,
        task?.assignedAgentType,
        task?.agentProfile,
      ]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    );
    triggered = candidateTypes.has(expectedAgentType);
  }

  if (triggered && config?.taskPattern) {
    try {
      const regex = new RegExp(String(config.taskPattern), "i");
      const searchableText = [
        eventData?.taskTitle,
        task?.title,
        ...(Array.isArray(task?.tags) ? task.tags : []),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ");
      triggered = regex.test(searchableText);
    } catch {
      triggered = false;
    }
  }

  if (triggered && config?.filter) {
    try {
      const fn = new Function("task", "$data", `return !!(${config.filter});`);
      triggered = Boolean(fn(task, eventData));
    } catch {
      triggered = false;
    }
  }

  return triggered;
}

function isManagedBosunWorktree(worktreePath, repoRoot) {
  const resolvedWorktree = resolve(String(worktreePath || ""));
  const managedRoot = resolve(String(repoRoot || process.cwd()), ".bosun", "worktrees");
  return (
    resolvedWorktree === managedRoot ||
    resolvedWorktree.startsWith(`${managedRoot}\\`) ||
    resolvedWorktree.startsWith(`${managedRoot}/`)
  );
}

function resolveManagedWorktreeGatePolicy(repoRoot) {
  try {
    const config = loadConfig(["node", "bosun", "--repo-root", repoRoot]);
    return config?.gates?.worktrees && typeof config.gates.worktrees === "object"
      ? config.gates.worktrees
      : null;
  } catch {
    return null;
  }
}

function shouldBootstrapManagedTaskWorktree(repoRoot, worktreePath) {
  if (!isManagedBosunWorktree(worktreePath, repoRoot)) return false;
  const gatePolicy = resolveManagedWorktreeGatePolicy(repoRoot);
  if (!gatePolicy) return true;
  return gatePolicy.requireBootstrap !== false || gatePolicy.requireReadiness !== false;
}

function ensureManagedTaskWorktreeReady(repoRoot, worktreePath) {
  if (!shouldBootstrapManagedTaskWorktree(repoRoot, worktreePath)) return;
  bootstrapWorktreeForPath(repoRoot, worktreePath);
}

function shouldEnforceManagedPushHook(repoRoot, worktreePath) {
  if (!isManagedBosunWorktree(worktreePath, repoRoot)) return false;
  if (!shouldRequireManagedPrePush(repoRoot)) return false;
  const gatePolicy = resolveManagedWorktreeGatePolicy(repoRoot);
  if (!gatePolicy) return true;
  return gatePolicy.enforcePushHook !== false;
}

function deriveManagedWorktreeDirName(taskId, branch) {
  const taskToken = deriveManagedTaskToken(taskId);
  const branchHash = createHash("sha1")
    .update(String(branch || "branch"))
    .digest("hex")
    .slice(0, 10);
  return `task-${taskToken}-${branchHash}`;
}

function sanitizeRepairArtifactToken(value, maxLength = 48) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function createManagedWorktreeRepairArtifacts({
  repoRoot,
  worktreePath,
  branch,
  baseBranch,
  taskId,
  detectedIssues = [],
  refreshError = "",
}) {
  if (!repoRoot || !worktreePath || !existsSync(worktreePath)) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactId = [
    timestamp,
    sanitizeRepairArtifactToken(deriveManagedTaskToken(taskId), 18) || "task",
    createHash("sha1")
      .update(`${branch || "branch"}:${worktreePath}`)
      .digest("hex")
      .slice(0, 8),
  ].join("-");
  const artifactRoot = resolve(repoRoot, ".cache", "worktree-repair", artifactId);
  const summaryPath = resolve(artifactRoot, "summary.json");
  const patchPath = resolve(artifactRoot, "changes.patch");
  const commitsPath = resolve(artifactRoot, "commits.patch");
  const statusPath = resolve(artifactRoot, "status.txt");

  try {
    mkdirSync(artifactRoot, { recursive: true });
  } catch {
    return null;
  }

  const summary = {
    taskId: String(taskId || "").trim() || null,
    branch: String(branch || "").trim() || null,
    baseBranch: String(baseBranch || "").trim() || null,
    worktreePath,
    artifactRoot,
    createdAt: new Date().toISOString(),
    detectedIssues: Array.isArray(detectedIssues)
      ? detectedIssues.map((issue) => String(issue || "").trim()).filter(Boolean)
      : [],
    refreshError: String(refreshError || "").trim() || null,
    head: null,
    aheadBehind: null,
    files: {
      summaryPath,
      patchPath: null,
      commitsPath: null,
      statusPath: null,
    },
  };

  const runGit = (args, fallback = "") => {
    try {
      return execGitArgsSync(args, {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    } catch {
      return fallback;
    }
  };

  const statusText = runGit(["status", "--short", "--branch"]);
  if (statusText) {
    writeFileSync(statusPath, `${statusText}\n`);
    summary.files.statusPath = statusPath;
  }

  const head = runGit(["rev-parse", "HEAD"]);
  if (head) summary.head = head;

  const aheadBehind = baseBranch
    ? runGit(["rev-list", "--left-right", "--count", `HEAD...${baseBranch}`])
    : "";
  if (aheadBehind) summary.aheadBehind = aheadBehind;

  if (baseBranch) {
    const diffPatch = runGit(["diff", "--binary", `${baseBranch}...HEAD`]);
    if (diffPatch) {
      writeFileSync(patchPath, `${diffPatch}\n`);
      summary.files.patchPath = patchPath;
    }

    const commitsPatch = runGit(["format-patch", "--stdout", `${baseBranch}..HEAD`]);
    if (commitsPatch) {
      writeFileSync(commitsPath, commitsPatch);
      summary.files.commitsPath = commitsPath;
    }
  }

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

const WORKFLOW_TELEGRAM_ICON_MAP = Object.freeze({
  check: "✅",
  close: "❌",
  alert: "⚠️",
  warning: "⚠️",
  help: "❓",
  info: "ℹ️",
  dot: "•",
  folder: "📁",
  refresh: "🔄",
  lock: "🔒",
  unlock: "🔓",
  play: "▶️",
  pause: "⏸️",
  stop: "⏹️",
  rocket: "🚀",
  gear: "⚙️",
  wrench: "🔧",
  search: "🔍",
  clipboard: "📋",
  chart: "📊",
  hourglass: "⏳",
  fire: "🔥",
  bug: "🐛",
  sparkles: "✨",
});

function decodeWorkflowUnicodeIconToken(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw.startsWith("u") ? raw.slice(1) : raw;
  if (!/^[0-9a-f]{4,6}$/.test(normalized)) return "";
  try {
    return String.fromCodePoint(parseInt(normalized, 16));
  } catch {
    return "";
  }
}

function normalizeWorkflowTelegramText(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.replace(/:([a-zA-Z0-9_+-]{2,}):/g, (token, iconName) => {
    const key = String(iconName || "").trim().toLowerCase();
    if (!key) return token;
    const squashed = key.replace(/[-+]/g, "");
    const glyph = WORKFLOW_TELEGRAM_ICON_MAP[key]
      || WORKFLOW_TELEGRAM_ICON_MAP[squashed]
      || decodeWorkflowUnicodeIconToken(key)
      || decodeWorkflowUnicodeIconToken(squashed);
    return glyph || token;
  });
}

function parsePathListingLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  const windowsMatch = raw.match(/^([A-Za-z]:\\[^:]+):(\d+):\s*(.+)?$/);
  if (windowsMatch) {
    return {
      path: windowsMatch[1],
      line: Number(windowsMatch[2]),
      detail: String(windowsMatch[3] || "").trim(),
    };
  }
  const unixMatch = raw.match(/^(\/[^:]+):(\d+):\s*(.+)?$/);
  if (unixMatch) {
    return {
      path: unixMatch[1],
      line: Number(unixMatch[2]),
      detail: String(unixMatch[3] || "").trim(),
    };
  }
  return null;
}

function extractSymbolHint(detail) {
  const text = String(detail || "");
  if (!text) return "";
  const patterns = [
    /\b(?:async\s+)?function\s+([A-Za-z0-9_$]+)/i,
    /\bclass\s+([A-Za-z0-9_$]+)/i,
    /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/i,
    /\b([A-Za-z0-9_$]+)\s*:\s*function\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function summarizePathListingBlock(value) {
  const lines = normalizeLineEndings(value)
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const entries = [];
  for (const line of lines) {
    const parsed = parsePathListingLine(line);
    if (parsed) entries.push(parsed);
  }

  if (entries.length < 3) return "";
  const fileStats = new Map();
  const symbols = new Set();
  for (const entry of entries) {
    const label = simplifyPathLabel(entry.path) || entry.path;
    const current = fileStats.get(label) || { count: 0 };
    current.count += 1;
    fileStats.set(label, current);
    const symbol = extractSymbolHint(entry.detail);
    if (symbol) symbols.add(symbol);
  }

  const fileList = Array.from(fileStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([label, stat]) => `${label} (${stat.count})`)
    .join(", ");
  const symbolList = Array.from(symbols).slice(0, 6).join(", ");

  const summaryParts = [
    `Indexed ${entries.length} code references across ${fileStats.size} file${fileStats.size === 1 ? "" : "s"}`,
  ];
  if (fileList) summaryParts.push(`Top files: ${fileList}`);
  if (symbolList) summaryParts.push(`Symbols: ${symbolList}`);

  return trimLogText(summaryParts.join(". "), 320);
}

function normalizeNarrativeText(value, options = {}) {
  const maxParagraphs = Number.isFinite(options.maxParagraphs) ? options.maxParagraphs : 4;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 2200;
  const raw = normalizeLineEndings(value);
  if (!raw) return "";

  const pathSummary = summarizePathListingBlock(raw);
  if (pathSummary) return pathSummary;

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => String(line || "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));

  const text = paragraphs.join("\n\n").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function summarizeAssistantUsage(data = {}) {
  const usage = data?.usage && typeof data.usage === "object" ? data.usage : data;
  if (!usage || typeof usage !== "object") return "";

  const pickNumber = (...keys) => {
    for (const key of keys) {
      const candidate = Number(usage?.[key]);
      if (Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return null;
  };

  const model = trimLogText(usage?.model || data?.model || "", 60);
  const prompt = pickNumber("prompt_tokens", "inputTokens", "promptTokens");
  const completion = pickNumber("completion_tokens", "outputTokens", "completionTokens");
  const total = pickNumber("total_tokens", "totalTokens");
  const durationMs = pickNumber("duration", "durationMs");
  const parts = [];

  if (model) parts.push(`model=${model}`);
  if (prompt != null) parts.push(`prompt=${prompt}`);
  if (completion != null) parts.push(`completion=${completion}`);
  if (total != null) parts.push(`total=${total}`);
  if (durationMs != null) parts.push(`duration=${Math.round(durationMs)}ms`);
  if (!parts.length) return "";
  return `Usage: ${parts.join(" ┬À ")}`;
}

function bindTaskContext(ctx, { taskId, taskTitle, task = null } = {}) {
  if (!ctx || typeof ctx !== "object") return;
  if (!ctx.data || typeof ctx.data !== "object") {
    ctx.data = {};
  }

  const normalizedTaskId = String(taskId || task?.id || task?.task_id || "").trim();
  if (normalizedTaskId) {
    ctx.data.taskId = normalizedTaskId;
    ctx.data.activeTaskId = normalizedTaskId;
  }

  const normalizedTaskTitle = String(taskTitle || task?.title || "").trim();
  if (normalizedTaskTitle) {
    ctx.data.taskTitle = normalizedTaskTitle;
  }

  if (task && typeof task === "object") {
    ctx.data.task = task;
    const taskWorktreePath = String(
      task.worktreePath ||
      task.workspacePath ||
      task.meta?.worktreePath ||
      task.meta?.workspacePath ||
      task.metadata?.worktreePath ||
      task.metadata?.workspacePath ||
      "",
    ).trim();
    if (taskWorktreePath && !String(ctx.data.worktreePath || "").trim()) {
      ctx.data.worktreePath = taskWorktreePath;
    }
  }
}
async function createKanbanTaskWithProject(kanban, taskData = {}, projectIdValue = "") {
  if (!kanban || typeof kanban.createTask !== "function") {
    throw new Error("Kanban adapter not available");
  }

  const payload =
    taskData && typeof taskData === "object" ? { ...taskData } : {};
  const resolvedProjectId = String(projectIdValue || payload.projectId || "").trim();

  if (resolvedProjectId) {
    payload.projectId = resolvedProjectId;
  }

  const createTaskParamNames = (() => {
    try {
      const inspectTarget =
        typeof kanban.createTask?.getMockImplementation === "function"
          ? kanban.createTask.getMockImplementation() || kanban.createTask
          : kanban.createTask;
      const source = Function.prototype.toString.call(inspectTarget);
      const parenMatch = source.match(/^[^(]*\(([^)]*)\)/s);
      if (parenMatch) {
        return String(parenMatch[1] || "")
          .split(",")
          .map((entry) =>
            String(entry || "")
              .trim()
              .replace(/^\.{3}/, "")
              .replace(/\s*=.*$/s, "")
              .trim(),
          )
          .filter(Boolean);
      }
      const arrowMatch = source.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
      if (arrowMatch?.[1]) return [arrowMatch[1]];
    } catch {
      // Fall back to the project-aware signature when adapter source is opaque.
    }
    return [];
  })();
  const firstParamName = String(createTaskParamNames[0] || "").toLowerCase();
  const secondParamName = String(createTaskParamNames[1] || "").toLowerCase();
  const payloadOnlyCreateTask =
    createTaskParamNames.length === 1 &&
    /(task|payload|spec|data)/i.test(firstParamName) &&
    !/project/i.test(firstParamName);
  const projectOnlyCreateTask =
    createTaskParamNames.length === 1 &&
    /project/i.test(firstParamName) &&
    !/(task|payload|spec|data)/i.test(firstParamName);
  const projectAwareCreateTask =
    createTaskParamNames.length >= 2 &&
    /project/i.test(firstParamName) &&
    /(task|payload|spec|data)/i.test(secondParamName);

  if (payloadOnlyCreateTask) {
    return kanban.createTask(payload);
  }

  if (projectOnlyCreateTask && !resolvedProjectId) {
    throw new Error("Kanban adapter requires a projectId to create planner tasks");
  }

  const taskPayload = { ...payload };
  delete taskPayload.projectId;
  if (projectAwareCreateTask) {
    return kanban.createTask(resolvedProjectId, taskPayload);
  }
  if (resolvedProjectId) {
    return kanban.createTask(resolvedProjectId, taskPayload);
  }
  if (createTaskParamNames.length === 0) {
    return kanban.createTask("", taskPayload);
  }
  return kanban.createTask(taskPayload);
}

function summarizeAssistantMessageData(data = {}) {
  const messageText = normalizeNarrativeText(
    extractStreamText(data?.content) ||
      extractStreamText(data?.text) ||
      extractStreamText(data?.deltaContent),
    { maxParagraphs: 1, maxChars: 260 },
  );
  if (messageText) return `Agent: ${trimLogText(messageText, 220)}`;

  const detailText = normalizeNarrativeText(data?.detailedContent, {
    maxParagraphs: 1,
    maxChars: 260,
  });
  if (detailText) return `Agent detail: ${trimLogText(detailText, 220)}`;

  const toolRequests = Array.isArray(data?.toolRequests)
    ? data.toolRequests
        .map((req) => String(req?.name || "").trim())
        .filter(Boolean)
    : [];
  if (toolRequests.length) {
    const unique = Array.from(new Set(toolRequests)).slice(0, 4).join(", ");
    return `Agent requested tools: ${unique}`;
  }

  const reasoningText = normalizeNarrativeText(data?.reasoningOpaque, {
    maxParagraphs: 1,
    maxChars: 220,
  });
  if (reasoningText) return `Thinking: ${trimLogText(reasoningText, 220)}`;

  return "";
}

function extractStreamText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "string") return entry;
        if (typeof entry?.text === "string") return entry.text;
        if (typeof entry?.content === "string") return entry.content;
        if (typeof entry?.deltaContent === "string") return entry.deltaContent;
        return "";
      })
      .filter(Boolean);
    return parts.join(" ");
  }
  if (typeof value === "object") {
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.content === "string") return value.content;
    if (typeof value?.deltaContent === "string") return value.deltaContent;
    if (typeof value?.detailedContent === "string") return value.detailedContent;
    if (typeof value?.summary === "string") return value.summary;
    if (typeof value?.reasoning === "string") return value.reasoning;
    if (typeof value?.reasoningOpaque === "string") return value.reasoningOpaque;
  }
  return "";
}

function summarizeAgentStreamEvent(event) {
  const type = String(event?.type || "").trim();
  if (!type) return "";

  // Ignore token-level deltas that create noisy duplicate run logs.
  if (
    /reasoning(?:_|[.])delta/i.test(type) ||
    /(?:^|[.])delta$/i.test(type) ||
    /(?:_|[.])delta(?:_|[.])/i.test(type)
  ) {
    return "";
  }

  if (type === "item.updated") {
    return "";
  }

  if (type === "tool_call") {
    return `Tool call: ${event?.tool_name || event?.data?.tool_name || "unknown"}`;
  }

  if (type === "function_call") {
    return `Tool call: ${event?.name || event?.tool_name || "unknown"}`;
  }

  if (type === "tool_result") {
    const name = event?.tool_name || event?.data?.tool_name || "unknown";
    return `Tool result: ${name}`;
  }

  if (type === "function_call_output" || type === "tool_output") {
    const name = event?.name || event?.tool_name || event?.data?.tool_name || "unknown";
    return `Tool result: ${name}`;
  }

  if (type === "error") {
    return `Agent error: ${trimLogText(event?.error || event?.message || "unknown error", 220)}`;
  }

  if (type === "assistant.usage") {
    const usageLine = summarizeAssistantUsage(event?.data || {});
    return usageLine || "Usage update";
  }

  if (type === "assistant.message") {
    return summarizeAssistantMessageData(event?.data || {});
  }

  const item = event?.item;
  if (item && (type === "item.completed" || type === "item.started")) {
    const itemType = String(item?.type || "").trim().toLowerCase();
    const toolName =
      item?.tool_name ||
      item?.toolName ||
      item?.name ||
      item?.call?.tool_name ||
      item?.call?.name ||
      item?.function?.name ||
      null;

    if (
      itemType === "tool_call" ||
      itemType === "mcp_tool_call" ||
      itemType === "function_call" ||
      itemType === "tool_use"
    ) {
      return `Tool call: ${toolName || "unknown"}`;
    }
    if (
      itemType === "tool_result" ||
      itemType === "mcp_tool_result" ||
      itemType === "tool_output"
    ) {
      return `Tool result: ${toolName || "unknown"}`;
    }

    const itemText = trimLogText(
      extractStreamText(item?.text) ||
        extractStreamText(item?.summary) ||
        extractStreamText(item?.content) ||
        extractStreamText(item?.message?.content) ||
        extractStreamText(item?.message?.text),
      220,
    );

    if (itemType.includes("reason") || itemType.includes("thinking")) {
      return itemText ? `Thinking: ${itemText}` : "Thinking...";
    }

    if (
      itemType === "agent_message" ||
      itemType === "assistant_message" ||
      itemType === "message"
    ) {
      return itemText ? `Agent: ${itemText}` : "";
    }

    if (itemText) {
      return `${itemType || "item"}: ${itemText}`;
    }
  }

  const messageText = trimLogText(
    extractStreamText(event?.message?.content) ||
      extractStreamText(event?.message?.text) ||
      extractStreamText(event?.content) ||
      extractStreamText(event?.text) ||
      extractStreamText(event?.data?.content) ||
      extractStreamText(event?.data?.text) ||
      extractStreamText(event?.data?.deltaContent) ||
      normalizeNarrativeText(event?.data?.detailedContent, {
        maxParagraphs: 1,
        maxChars: 220,
      }) ||
      "",
    220,
  );

  if (messageText) {
    if (
      type === "agent_message" ||
      type === "assistant_message" ||
      type === "message" ||
      type === "item.completed"
    ) {
      return `Agent: ${messageText}`;
    }
    return `${type}: ${messageText}`;
  }

  if (
    type === "turn.complete" ||
    type === "session.completed" ||
    type === "response.completed"
  ) {
    return `Agent event: ${type}`;
  }

  return "";
}

function buildAgentEventPreview(items = [], streamLines = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  const lines = [];
  if (Array.isArray(streamLines) && streamLines.length) {
    lines.push(...streamLines);
  }

  if (Array.isArray(items) && items.length) {
    for (const entry of items) {
      const line = summarizeAgentStreamEvent(entry);
      if (line) lines.push(line);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = trimLogText(line, 260);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  const limit = Number.isFinite(maxEvents)
    ? Math.max(10, Math.min(500, Math.trunc(maxEvents)))
    : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
  return deduped.slice(-limit);
}

function condenseAgentItems(items = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Number.isFinite(maxEvents)
    ? Math.max(10, Math.min(500, Math.trunc(maxEvents)))
    : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
  const slice = items.slice(-limit);
  return slice.map((entry) => ({
    type: String(entry?.type || entry?.item?.type || "event"),
    summary:
      summarizeAgentStreamEvent(entry) ||
      trimLogText(
        normalizeNarrativeText(
          extractStreamText(entry?.message?.content) ||
            extractStreamText(entry?.content) ||
            extractStreamText(entry?.text) ||
            extractStreamText(entry?.data?.content) ||
            extractStreamText(entry?.item?.text) ||
            extractStreamText(entry?.item?.content),
          { maxParagraphs: 1, maxChars: 220 },
        ),
        220,
      ) ||
      "event",
    timestamp: entry?.timestamp || entry?.data?.timestamp || null,
  }));
}

function buildAgentExecutionDigest(result = {}, streamLines = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  const eventPreview = buildAgentEventPreview(result?.items || [], streamLines, maxEvents);
  const thoughts = eventPreview
    .filter((line) => line.startsWith("Thinking:"))
    .map((line) => line.replace(/^Thinking:\s*/i, "").trim())
    .filter(Boolean);
  const actionLines = eventPreview
    .filter(
      (line) =>
        line.startsWith("Tool call:") ||
        line.startsWith("Tool result:") ||
        line.startsWith("Agent requested tools:"),
    )
    .map((line) =>
      line
        .replace(/^Tool call:\s*/i, "called ")
        .replace(/^Tool result:\s*/i, "received result from ")
        .replace(/^Agent requested tools:\s*/i, "requested tools ")
        .trim(),
    )
    .filter(Boolean);
  const agentMessages = eventPreview
    .filter((line) => line.startsWith("Agent:"))
    .map((line) => line.replace(/^Agent:\s*/i, "").trim())
    .filter(Boolean);

  let summary = normalizeNarrativeText(result?.output || "", { maxParagraphs: 2, maxChars: 900 });
  if (!summary || summary === "(Agent completed with no text output)") {
    summary = agentMessages[agentMessages.length - 1] || "";
  }
  if (!summary && eventPreview.length > 0) {
    summary = eventPreview[eventPreview.length - 1];
  }
  summary = trimLogText(summary, 900);

  const narrativeParts = [];
  if (summary && summary !== "(Agent completed with no text output)") {
    narrativeParts.push(summary);
  }
  if (thoughts.length) {
    narrativeParts.push(`Thought process: ${thoughts.slice(0, 4).join(" ")}`);
  }
  if (actionLines.length) {
    narrativeParts.push(`Actions: ${actionLines.slice(0, 8).join("; ")}`);
  }
  if (!narrativeParts.length && eventPreview.length) {
    narrativeParts.push(eventPreview.slice(-3).join(" "));
  }

  const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
  const retainedItems = condenseAgentItems(result?.items || [], maxEvents);
  const omittedItemCount = Math.max(0, itemCount - retainedItems.length);

  return {
    summary,
    narrative: narrativeParts.join("\n\n").trim(),
    thoughts: thoughts.slice(0, 8),
    stream: eventPreview,
    items: retainedItems,
    itemCount,
    omittedItemCount,
  };
}

const WORKFLOW_AGENT_PLACEHOLDER_OUTPUTS = new Set([
  "continued",
  "model response continued",
]);

const WORKFLOW_AGENT_REPO_BLOCK_PATTERNS = [
  /merge conflict/i,
  /unmerged files/i,
  /protected branch/i,
  /non-fast-forward/i,
  /push rejected/i,
  /failed to push/i,
  /pre-push hook/i,
  /hook declined/i,
  /cannot rebase/i,
];

const WORKFLOW_AGENT_ENV_BLOCK_PATTERNS = [
  /prompt[_ ]quality/i,
  /missing task (description|url)/i,
  /infrastructure[_ ]blocked/i,
  /repeated reconnect/i,
  /startup-only/i,
  /connection refused/i,
  /connection reset/i,
  /network/i,
  /timeout/i,
  /enoent/i,
  /not authenticated/i,
  /missing credentials/i,
  /command not found/i,
  /not recognized as an internal or external command/i,
];

const WORKFLOW_AGENT_COMMIT_BLOCK_PATTERNS = [
  /implementation_done_commit_blocked/i,
  /commit blocked/i,
  /pre-push hook/i,
  /git push/i,
  /git commit/i,
];

function pickWorkflowPromptString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || isUnresolvedTemplateToken(text)) continue;
    return text;
  }
  return "";
}

function resolveWorkflowTaskUrl(task = {}, ctx = {}) {
  const taskMeta = task?.meta && typeof task.meta === "object" ? task.meta : {};
  return pickWorkflowPromptString(
    ctx?.data?.taskUrl,
    task?.taskUrl,
    task?.url,
    taskMeta?.taskUrl,
    taskMeta?.task_url,
    taskMeta?.url,
  );
}

async function ensureWorkflowTaskPromptCompleteness(ctx, engine, nodeId, explicitTaskId = "") {
  const currentTask =
    ctx.data?.task && typeof ctx.data.task === "object"
      ? ctx.data.task
      : ctx.data?.taskDetail && typeof ctx.data.taskDetail === "object"
        ? ctx.data.taskDetail
        : ctx.data?.taskInfo && typeof ctx.data.taskInfo === "object"
          ? ctx.data.taskInfo
          : null;

  const taskId = pickWorkflowPromptString(
    explicitTaskId,
    currentTask?.id,
    currentTask?.taskId,
    ctx.data?.taskId,
  );

  let task = currentTask;
  let taskDescription = pickWorkflowPromptString(
    currentTask?.description,
    currentTask?.body,
    currentTask?.details,
    currentTask?.meta?.taskDescription,
    ctx.data?.taskDescription,
  );
  let taskUrl = resolveWorkflowTaskUrl(currentTask || {}, ctx);

  const missingFields = [];
  if (!taskDescription) missingFields.push("description");
  if (!taskUrl) missingFields.push("url");

  if (taskId && missingFields.length > 0 && typeof engine?.services?.kanban?.getTask === "function") {
    try {
      const fetchedTask = await engine.services.kanban.getTask(taskId);
      if (fetchedTask && typeof fetchedTask === "object") {
        task = task && typeof task === "object"
          ? { ...fetchedTask, ...task, meta: { ...(fetchedTask.meta || {}), ...(task.meta || {}) } }
          : fetchedTask;
        ctx.data.task = task;
        taskDescription = pickWorkflowPromptString(
          taskDescription,
          fetchedTask.description,
          fetchedTask.body,
          fetchedTask.details,
          fetchedTask.meta?.taskDescription,
        );
        taskUrl = pickWorkflowPromptString(taskUrl, resolveWorkflowTaskUrl(fetchedTask, ctx));
        if (taskDescription) ctx.data.taskDescription = taskDescription;
        if (taskUrl) ctx.data.taskUrl = taskUrl;
      }
    } catch (error) {
      ctx.log(
        nodeId,
        `Prompt completeness fetch failed for task ${taskId}: ${error?.message || error}`,
        "warn",
      );
    }
  }

  const remainingMissing = [];
  if (!taskDescription) remainingMissing.push("description");
  if (!taskUrl) remainingMissing.push("url");
  if (remainingMissing.length > 0) {
    return {
      ok: false,
      taskId,
      taskDescription,
      taskUrl,
      error:
        `prompt_quality_error: missing task ${remainingMissing.join(" and ")}` +
        `${taskId ? ` for ${taskId}` : ""}`,
    };
  }

  return { ok: true, taskId, task, taskDescription, taskUrl };
}

function appendWorkflowTaskPromptContext(prompt, promptState) {
  let nextPrompt = String(prompt || "").trim();
  const taskDescription = String(promptState?.taskDescription || "").trim();
  const taskUrl = String(promptState?.taskUrl || "").trim();
  if (taskDescription && !nextPrompt.includes(taskDescription) && !/## Description/i.test(nextPrompt)) {
    nextPrompt = `${nextPrompt}\n\n## Description\n${taskDescription}`;
  }
  if (taskUrl && !nextPrompt.includes(taskUrl)) {
    nextPrompt = `${nextPrompt}\n\n## Task Reference\n${taskUrl}`;
  }
  return nextPrompt;
}

function classifyWorkflowAgentBlockedStatus(result = {}) {
  const fragments = [];
  if (result?.error) fragments.push(String(result.error));
  if (result?.output) fragments.push(String(result.output));
  if (Array.isArray(result?.stream)) fragments.push(...result.stream.map((entry) => String(entry || "")));
  if (Array.isArray(result?.items)) {
    fragments.push(
      ...result.items.map((entry) => String(entry?.summary || entry?.content || entry?.type || "")),
    );
  }
  const text = fragments.join("\n");
  if (WORKFLOW_AGENT_COMMIT_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    return "implementation_done_commit_blocked";
  }
  if (WORKFLOW_AGENT_REPO_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    return "blocked_by_repo";
  }
  if (WORKFLOW_AGENT_ENV_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    return "blocked_by_env";
  }
  return null;
}

function deriveWorkflowAgentSessionStatus(result = {}, { streamEventCount = 0 } = {}) {
  const blockedStatus = classifyWorkflowAgentBlockedStatus(result);
  if (blockedStatus) return blockedStatus;
  const output = String(result?.output || "").replace(/\s+/g, " ").trim().toLowerCase();
  const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
  const noOutput = !output && itemCount === 0 && streamEventCount === 0;
  if (noOutput) return "no_output";
  if (WORKFLOW_AGENT_PLACEHOLDER_OUTPUTS.has(output) && itemCount === 0) {
    return "no_output";
  }
  return result?.success === true ? "completed" : "failed";
}

const SESSION_PLACEHOLDER_OUTPUTS = new Set([
  "continued",
  "model response continued",
  "turn completed",
  "session completed",
  "agent is composing a response...",
  "agent is composing a response…",
]);

function resolveSuccessfulWorkflowAgentSessionStatus(result = {}) {
  return classifyWorkflowAgentBlockedStatus(result) || "completed";
}

function pickLatestMeaningfulSessionMessage(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = String(message?.content || "").trim();
    if (!content) continue;
    const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
    if (SESSION_PLACEHOLDER_OUTPUTS.has(normalized)) continue;
    return content;
  }
  return "";
}

function deriveWorkflowExecutionSessionStatus(run = {}) {
  const terminalOutput = run?.data?._workflowTerminalOutput;
  const terminalMessage = String(run?.data?._workflowTerminalMessage || "").trim();
  const terminalStatus = String(run?.data?._workflowTerminalStatus || "")
    .trim()
    .toLowerCase();
  const errors = Array.isArray(run?.errors)
    ? run.errors
      .map((entry) => String(entry?.error || entry?.message || entry || "").trim())
      .filter(Boolean)
    : [];

  const fragments = [];
  if (terminalOutput && typeof terminalOutput === "object") {
    const implementationState = String(terminalOutput.implementationState || "").trim();
    const blockedReason = String(terminalOutput.blockedReason || "").trim();
    const error = String(terminalOutput.error || "").trim();
    if (implementationState) fragments.push(implementationState);
    if (blockedReason) fragments.push(blockedReason);
    if (error) fragments.push(error);
  } else if (terminalOutput != null) {
    const outputText = String(terminalOutput || "").trim();
    if (outputText) fragments.push(outputText);
  }
  if (terminalMessage) fragments.push(terminalMessage);

  if (fragments.length === 0 && errors.length === 0) {
    return terminalStatus === "failed" ? "failed" : "completed";
  }

  return deriveWorkflowAgentSessionStatus(
    {
      success: errors.length === 0 && terminalStatus !== "failed",
      output: fragments.join("\n"),
      error: errors.join("\n"),
    },
    { streamEventCount: 1 },
  );
}

function classifyPushBlockedReason(errorText = "", hasMergeConflict = false) {
  if (hasMergeConflict) return "blocked_by_repo";
  const normalized = String(errorText || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "implementation_done_commit_blocked";
  if (WORKFLOW_AGENT_COMMIT_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "implementation_done_commit_blocked";
  }
  if (WORKFLOW_AGENT_REPO_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "blocked_by_repo";
  }
  if (WORKFLOW_AGENT_ENV_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "blocked_by_env";
  }
  return "implementation_done_commit_blocked";
}

function normalizeLegacyWorkflowCommand(command) {
  let normalized = String(command || "");
  if (!normalized) return normalized;
  if (/--json\s+name,state,conclusion\b/i.test(normalized)) {
    normalized = normalized.replace(/--json\s+name,state,conclusion\b/gi, "--json name,state");
  }
  if (/grep\s+-c\s+worktree/i.test(normalized)) {
    normalized = /git\s+worktree\s+prune/i.test(normalized)
      ? PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND
      : PORTABLE_WORKTREE_COUNT_COMMAND;
  }
  return normalized;
}

let _contextCacheMod = null;
async function getContextCacheMod() {
  if (!_contextCacheMod) {
    _contextCacheMod = await import("../workspace/context-cache.mjs");
  }
  return _contextCacheMod;
}

async function compactWorkflowCommandResult({
  command = "",
  args = [],
  output = "",
  stderr = "",
  exitCode = 0,
  durationMs = null,
  sessionType = "flow",
} = {}) {
  const rawOutput = String(output || "");
  const rawStderr = String(stderr || "");
  const { compactCommandOutputPayload } = await getContextCacheMod();
  const compacted = await compactCommandOutputPayload(
    {
      command,
      args,
      output: rawOutput,
      stderr: rawStderr,
      exitCode,
      durationMs,
    },
    {
      sessionType,
      agentType: "workflow",
      force: true,
    },
  );

  const envelopeMeta = compacted.contextEnvelope?.meta && typeof compacted.contextEnvelope.meta === "object"
    ? compacted.contextEnvelope.meta
    : null;
  const synthesizedDiagnostics = compacted.commandDiagnostics || (
    envelopeMeta && (
      envelopeMeta.summary ||
      envelopeMeta.deltaSummary ||
      envelopeMeta.suggestedRerun ||
      envelopeMeta.hint ||
      envelopeMeta.lowSignal === true
    )
      ? {
          family: envelopeMeta.family || compacted.compactionFamily || null,
          runner: null,
          commandKey: null,
          summary: String(envelopeMeta.summary || ""),
          failedTargets: [],
          fileAnchors: [],
          insufficientSignal: envelopeMeta.lowSignal === true,
          deltaSummary: String(envelopeMeta.deltaSummary || ""),
          resolvedTargets: [],
          remainingTargets: [],
          newTargets: [],
          suggestedRerun: String(envelopeMeta.suggestedRerun || "") || null,
          hint: String(envelopeMeta.hint || ""),
        }
      : null
  );

  return {
    output: compacted.text || rawOutput || rawStderr,
    outputCompacted: compacted.compacted,
    rawOutputChars: compacted.originalChars,
    compactedOutputChars: compacted.compactedChars,
    outputToolLogId: compacted.toolLogId,
    outputRetrieveCommand: compacted.retrieveCommand,
    outputCompactionFamily: compacted.compactionFamily,
    outputCommandFamily: compacted.commandFamily,
    outputBudgetPolicy: compacted.budgetPolicy || null,
    outputBudgetReason: compacted.budgetReason || "",
    outputContextEnvelope: compacted.contextEnvelope || null,
    outputDiagnostics: synthesizedDiagnostics,
    outputSuggestedRerun: synthesizedDiagnostics?.suggestedRerun || null,
    outputDeltaSummary: synthesizedDiagnostics?.deltaSummary || "",
    outputHint: synthesizedDiagnostics?.hint || "",
    outputInsufficientSignal: synthesizedDiagnostics?.insufficientSignal === true,
    items: compacted.item ? [compacted.item] : [],
  };
}

function isValidationSandboxFailureText(text) {
  return /(?:sandbox|operation not permitted|permission denied|access is denied|read-only file system|EPERM|EACCES|denied by policy|seccomp)/i.test(
    String(text || ""),
  );
}

function isValidationBootstrapFailureText(text) {
  return /(?:\bENOENT\b|spawn\s+.+\s+ENOENT|not recognized as an internal or external command|is not recognized as a name of a cmdlet|command not found|executable file not found|no such file or directory|cannot find the file|failed to start|startup failure)/i.test(
    String(text || ""),
  );
}

function buildValidationFailureDiagnostic({
  command = "",
  args = [],
  status = "error",
  exitCode = null,
  stderr = "",
  output = "",
  timeoutMs = null,
  blocked = false,
  failureDiagnostic = null,
} = {}) {
  if (failureDiagnostic && typeof failureDiagnostic === "object") return failureDiagnostic;
  const normalizedStatus = String(status || "error").trim().toLowerCase();
  if (!blocked && normalizedStatus === "success" && Number(exitCode ?? 0) === 0) {
    return null;
  }
  const combinedText = [stderr, output]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";

  let category = "command_failure";
  let retryable = false;
  let summary = `Validation command exited with code ${exitCode ?? "unknown"}.`;

  if (blocked || normalizedStatus === "blocked") {
    category = "runner_unavailable";
    retryable = true;
    summary = "Isolated runner was unavailable before the validation command started.";
  } else if (normalizedStatus === "timeout" || /(?:timed out|ETIMEDOUT|SIGTERM)/i.test(combinedText)) {
    category = "timeout";
    retryable = true;
    const numericTimeoutMs = timeoutMs != null ? Number(timeoutMs) : NaN;
    if (Number.isFinite(numericTimeoutMs) && numericTimeoutMs > 0) {
      summary = `Validation timed out after ${numericTimeoutMs}ms.`;
    } else {
      summary = "Validation timed out after the configured timeout.";
    }
  } else if (isValidationSandboxFailureText(combinedText)) {
    category = "sandbox_error";
    retryable = false;
    summary = "Validation was blocked by sandbox or filesystem restrictions.";
  } else if (isValidationBootstrapFailureText(combinedText) || normalizedStatus === "error" && (exitCode == null || Number(exitCode) < 0)) {
    category = "bootstrap_failure";
    retryable = true;
    summary = "Validation could not start cleanly.";
  }

  const detail = String(combinedText || "").trim().split(/\r?\n/).find(Boolean) || "";
  return {
    category,
    retryable,
    summary,
    detail,
    status: normalizedStatus,
    exitCode: exitCode ?? null,
    blocked: blocked === true,
    command,
    args: Array.isArray(args) ? [...args] : [],
  };
}

function didValidationCommandPass(result = {}) {
  if (!result || result.blocked === true || result.failureDiagnostic) return false;
  const status = String(result.status || "success").trim().toLowerCase();
  if (status && status !== "success") return false;
  return Number(result.exitCode ?? 0) === 0;
}

function buildValidationResult({
  passed,
  exitCode = null,
  blocked = false,
  compacted = {},
  extras = {},
  failureDiagnostic = null,
} = {}) {
  return {
    passed,
    exitCode,
    blocked,
    ...(failureDiagnostic
      ? {
          failureKind: failureDiagnostic.category || null,
          retryable: failureDiagnostic.retryable === true,
          failureDiagnostic,
        }
      : {}),
    ...compacted,
    ...extras,
  };
}

function buildIsolatedRunnerResultExtras(result, lane) {
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  return {
    isolatedRunner: {
      lane: lane?.lane || "main",
      reason: lane?.reason || "unknown",
      provider: result?.provider || null,
      leaseId: result?.leaseId || null,
      artifactRoot: result?.artifactRoot || null,
      attempts: result?.attempts || 1,
      blocked: result?.blocked === true,
      failureDiagnostic: result?.failureDiagnostic || null,
      artifacts,
    },
    artifactRoot: result?.artifactRoot || null,
    artifacts,
    artifactPaths: artifacts.map((artifact) => artifact.path).filter(Boolean),
    artifactRetrieveCommands: artifacts
      .map((artifact) => artifact.retrieveCommand)
      .filter(Boolean),
  };
}

function resolveWorkflowCommandLane({ nodeType, commandType, command, engine }) {
  const scheduler = engine?.services?.scheduler;
  if (scheduler && typeof scheduler.selectWorkflowLane === "function") {
    return scheduler.selectWorkflowLane({ nodeType, commandType, command });
  }

  const normalizedNodeType = String(nodeType || "").trim();
  if (['validation.tests', 'validation.build', 'validation.lint'].includes(normalizedNodeType)) {
    return { lane: "isolated", reason: `workflow_node:${normalizedNodeType}`, heavy: true };
  }

  const normalizedCommandType = String(commandType || "").trim();
  if (["test", "build", "qualityGate"].includes(normalizedCommandType)) {
    return { lane: "isolated", reason: `command_type:${normalizedCommandType}`, heavy: true };
  }

  const rawCommand = String(command || "");
  if (/(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b|\bpre-?push\b|\bgit\s+diff\b|\bvitest\b|\bjest\b|\btsc\b)/i.test(rawCommand)) {
    return { lane: "isolated", reason: "command_pattern:default", heavy: true };
  }

  return { lane: "main", reason: "lightweight", heavy: false };
}

async function maybeRunWorkflowCommandInIsolation({
  node,
  ctx,
  engine,
  nodeType,
  command,
  args = [],
  cwd,
  timeoutMs,
  env = {},
  commandType = "",
  sessionType = "flow",
} = {}) {
  const lane = resolveWorkflowCommandLane({ nodeType, commandType, command, engine });
  if (lane?.lane !== "isolated") return null;

  ctx.log(node.id, `Offloading ${commandType || nodeType} to isolated runner (${lane.reason})`);
  const runner = engine?.services?.isolatedRunner;
  const execute = typeof runner?.run === "function" ? runner.run.bind(runner) : runInIsolatedRunner;
  const isolated = await execute({
    command,
    args,
    cwd,
    timeoutMs,
    env,
    requestType: commandType || nodeType,
    taskId: `${node.id || nodeType || "validation"}`,
    metadata: {
      nodeId: node.id || null,
      nodeType,
      commandType,
    },
  });
  const compacted = await compactWorkflowCommandResult({
    command,
    args,
    output: isolated?.stdout || "",
    stderr: isolated?.stderr || isolated?.error || "",
    exitCode: isolated?.exitCode,
    durationMs: isolated?.duration,
    sessionType,
  });

  return {
    lane,
    isolated,
    compacted,
    extras: buildIsolatedRunnerResultExtras(isolated, lane),
  };
}

function resolveWorkflowNodeValue(value, ctx) {
  if (typeof value === "string") {
    const resolved = ctx.resolve(value);
    if (resolved !== value) return resolved;

    const exactExpr = value.match(/^\{\{([\s\S]+)\}\}$/);
    if (exactExpr) {
      const expr = String(exactExpr[1] || "").trim();
      if (expr.includes("$ctx") || expr.includes("$data") || expr.includes("$output")) {
        try {
          const fn = new Function("$data", "$ctx", "$output", `return (${expr});`);
          const evalResult = fn(ctx.data || {}, ctx, null);
          if (evalResult !== undefined) return evalResult;
        } catch {
          // Fall through to unresolved template string when expression is invalid.
        }
      }
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowNodeValue(item, ctx));
  }
  if (value && typeof value === "object") {
    const resolved = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveWorkflowNodeValue(entry, ctx);
    }
    return resolved;
  }
  return value;
}

function parseBooleanSetting(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

async function recoverTimedBlockedWorkflowTasks({ kanban, ctx, node, projectId }) {
  if (!kanban || typeof kanban.listTasks !== "function" || typeof kanban.updateTask !== "function") {
    return { recoveredTaskIds: [], recoveredCount: 0 };
  }

  const blockedTasks = await kanban.listTasks(projectId, { status: "blocked" });
  const nowMs = Date.now();
  const recoveredTaskIds = [];
  const isWorkflowPlaceholder = (value) => {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return trimmed.startsWith("{{") && trimmed.endsWith("}}");
  };

  const resolveRetryAtMs = (task, autoRecovery) => {
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

  const hasStaleWorktreePlaceholders = (task) => [
    task?.blockedReason,
    task?.cooldownUntil,
    task?.meta?.autoRecovery?.retryAt,
    task?.meta?.worktreeFailure?.retryAt,
    task?.meta?.worktreeFailure?.blockedReason,
  ].some((value) => isWorkflowPlaceholder(value));

  for (const task of Array.isArray(blockedTasks) ? blockedTasks : []) {
    const autoRecovery = task?.meta?.autoRecovery;
    const worktreeFailure = task?.meta?.worktreeFailure;
    const hasPlaceholder = hasStaleWorktreePlaceholders(task);
    const isRecoverableBlockedTask = (
      autoRecovery &&
      typeof autoRecovery === "object" &&
      autoRecovery.active !== false
    ) || (
      worktreeFailure &&
      typeof worktreeFailure === "object"
    ) || hasPlaceholder;
    if (!isRecoverableBlockedTask) continue;

    const retryAtMs = resolveRetryAtMs(task, autoRecovery);
    if (Number.isFinite(retryAtMs) && retryAtMs > nowMs) continue;
    if (!Number.isFinite(retryAtMs) && !hasPlaceholder) continue;

    // If the task has a linked PR, recover to "inreview" instead of "todo"
    const hasPr = Boolean(
      task?.prNumber || task?.pr_number || task?.prUrl || task?.pr_url,
    );
    const recoveryStatus = hasPr ? "inreview" : "todo";

    await kanban.updateTask(task.id, {
      status: recoveryStatus,
      cooldownUntil: null,
      blockedReason: null,
      meta: {
        ...(task?.meta && typeof task.meta === "object" ? task.meta : {}),
        autoRecovery: {
          ...autoRecovery,
          active: false,
          recoveredAt: new Date(nowMs).toISOString(),
          recoveredStatus: recoveryStatus,
        },
      },
    });
    recoveredTaskIds.push(task.id);
  }

  if (recoveredTaskIds.length > 0) {
    ctx.log(node.id, `Recovered ${recoveredTaskIds.length} blocked task(s): ${recoveredTaskIds.join(", ")}`);
  }

  return { recoveredTaskIds, recoveredCount: recoveredTaskIds.length };
}

function getPathValue(value, pathExpression) {
  const path = String(pathExpression || "").trim();
  if (!path) return undefined;
  const parts = path
    .split(".")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  let cursor = value;
  for (const part of parts) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isFinite(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function collectWakePhraseCandidates(payload, payloadField = "") {
  const candidates = [];
  const seen = new Set();

  const appendCandidate = (field, rawValue) => {
    if (rawValue == null) return;
    if (Array.isArray(rawValue)) {
      rawValue.forEach((entry, idx) => appendCandidate(`${field}[${idx}]`, entry));
      return;
    }
    if (typeof rawValue === "object") {
      if (typeof rawValue.content === "string") {
        appendCandidate(`${field}.content`, rawValue.content);
      }
      if (typeof rawValue.text === "string") {
        appendCandidate(`${field}.text`, rawValue.text);
      }
      if (typeof rawValue.transcript === "string") {
        appendCandidate(`${field}.transcript`, rawValue.transcript);
      }
      return;
    }

    const text = String(rawValue).trim();
    if (!text) return;
    const key = `${field}::${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ field, text });
  };

  if (payloadField) {
    appendCandidate(payloadField, getPathValue(payload, payloadField));
    return candidates;
  }

  const commonFields = [
    "content",
    "text",
    "transcript",
    "message",
    "utterance",
    "payload.content",
    "payload.text",
    "payload.transcript",
    "event.content",
    "event.text",
    "event.transcript",
    "voice.content",
    "voice.transcript",
    "meta.transcript",
  ];
  for (const field of commonFields) {
    appendCandidate(field, getPathValue(payload, field));
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  messages.forEach((entry, idx) => appendCandidate(`messages[${idx}]`, entry));

  const transcriptEvents = Array.isArray(payload?.transcriptEvents) ? payload.transcriptEvents : [];
  transcriptEvents.forEach((entry, idx) => appendCandidate(`transcriptEvents[${idx}]`, entry));

  return candidates;
}

function detectWakePhraseMatch(text, phrase, options = {}) {
  const mode = String(options.mode || "contains").trim().toLowerCase() || "contains";
  const caseSensitive = options.caseSensitive === true;
  const source = String(text || "");
  const target = String(phrase || "");

  if (!source || !target) return { matched: false, mode };

  const sourceNormalized = caseSensitive ? source : source.toLowerCase();
  const targetNormalized = caseSensitive ? target : target.toLowerCase();

  if (mode === "exact") {
    return { matched: sourceNormalized.trim() === targetNormalized.trim(), mode };
  }
  if (mode === "starts_with") {
    return { matched: sourceNormalized.trimStart().startsWith(targetNormalized), mode };
  }
  if (mode === "regex") {
    try {
      const regex = new RegExp(target, caseSensitive ? "" : "i");
      return { matched: regex.test(source), mode };
    } catch (err) {
      return {
        matched: false,
        mode,
        error: `invalid regex: ${err?.message || err}`,
      };
    }
  }
  return { matched: sourceNormalized.includes(targetNormalized), mode: "contains" };
}

function normalizeWorkflowStack(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function getChildWorkflowLineage(ctx, childWorkflowId = "", extra = {}) {
  const sourceData = ctx?.data && typeof ctx.data === "object"
    ? ctx.data
    : {};
  const parentWorkflowId = String(
    extra.parentWorkflowId ?? sourceData._workflowId ?? "",
  ).trim();
  const workflowStack = normalizeWorkflowStack(extra.workflowStack ?? sourceData._workflowStack);
  if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
    workflowStack.push(parentWorkflowId);
  }

  const normalizedChildWorkflowId = String(childWorkflowId || "").trim();
  const parentRunId = String(extra.parentRunId ?? ctx?.id ?? "").trim() || null;
  const rootRunId = String(
    extra.rootRunId ??
      sourceData._workflowRootRunId ??
      parentRunId ??
      "",
  ).trim() || null;
  const retryOf = String(extra.retryOf ?? sourceData._retryOf ?? "").trim() || null;
  const retryMode = String(extra.retryMode ?? sourceData._retryMode ?? "").trim() || null;

  return {
    parentWorkflowId,
    parentRunId,
    rootRunId,
    retryOf,
    retryMode,
    workflowStack: normalizedChildWorkflowId
      ? [...workflowStack, normalizedChildWorkflowId]
      : [...workflowStack],
  };
}

function applyChildWorkflowLineage(ctx, inputData = {}, childWorkflowId = "", extra = {}) {
  const lineage = getChildWorkflowLineage(ctx, childWorkflowId, extra);
  const currentTaskId = String(
    extra.taskId ??
      ctx?.data?.taskId ??
      ctx?.data?.task?.id ??
      ctx?.data?.taskInfo?.id ??
      ctx?.data?.taskDetail?.id ??
      "",
  ).trim() || null;
  const rootTaskId = String(
    extra.rootTaskId ??
      ctx?.data?._workflowRootTaskId ??
      currentTaskId ??
      "",
  ).trim() || currentTaskId || null;
  const parentTaskId = String(
    extra.parentTaskId ??
      ctx?.data?._workflowParentTaskId ??
      currentTaskId ??
      "",
  ).trim() || currentTaskId || null;
  const currentSessionId = String(
    ctx?.data?._workflowSessionId ??
      "",
  ).trim() || null;
  const parentSessionId = String(
    extra.parentSessionId ??
      currentSessionId ??
      ctx?.data?._workflowParentSessionId ??
      currentTaskId ??
      "",
  ).trim() || currentTaskId || null;
  const rootSessionId = String(
    extra.rootSessionId ??
      ctx?.data?._workflowRootSessionId ??
      currentSessionId ??
      currentTaskId ??
      "",
  ).trim() || currentTaskId || null;
  const workflowSessionId = String(extra.workflowSessionId ?? "").trim() || null;
  const rawDelegationDepth = Number(
    extra.delegationDepth ??
      ctx?.data?._workflowDelegationDepth ??
      0,
  );
  const delegationDepth = Number.isFinite(rawDelegationDepth)
    ? Math.max(0, Math.trunc(rawDelegationDepth))
    : 0;
  return {
    ...(inputData && typeof inputData === "object" ? inputData : {}),
    _parentWorkflowId: lineage.parentWorkflowId || "",
    _workflowParentRunId: lineage.parentRunId,
    _workflowRootRunId: lineage.rootRunId,
    _workflowStack: lineage.workflowStack,
    _workflowRootTaskId: rootTaskId,
    _workflowParentTaskId: parentTaskId,
    _workflowSessionId: workflowSessionId || undefined,
    _workflowParentSessionId: parentSessionId,
    _workflowRootSessionId: rootSessionId,
    _workflowDelegationDepth: delegationDepth,
    ...(lineage.retryOf ? { _retryOf: lineage.retryOf } : {}),
    ...(lineage.retryMode ? { _retryMode: lineage.retryMode } : {}),
  };
}

function makeChildWorkflowExecuteOptions(ctx, extra = {}) {
  const lineage = getChildWorkflowLineage(ctx, extra.childWorkflowId || "", extra);
  const sourceNodeId = String(extra?.sourceNodeId || "").trim();
  return {
    ...(extra && typeof extra === "object" ? extra : {}),
    _parentRunId: lineage.parentRunId,
    _rootRunId: lineage.rootRunId,
    ...(sourceNodeId ? { _parentExecutionId: `node:${ctx?.id || "run"}:${sourceNodeId}` } : {}),
  };
}

function normalizeWorkflowDelegationDepth(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function resolveWorkflowDelegationLineage(ctx, extra = {}) {
  const taskId = String(
    extra.taskId ??
      ctx?.data?.taskId ??
      ctx?.data?.task?.id ??
      ctx?.data?.taskInfo?.id ??
      ctx?.data?.taskDetail?.id ??
      "",
  ).trim() || null;
  const currentSessionId = String(
    extra.currentSessionId ??
      ctx?.data?._workflowSessionId ??
      "",
  ).trim() || null;
  const rootTaskId = String(
    extra.rootTaskId ??
      ctx?.data?._workflowRootTaskId ??
      taskId ??
      "",
  ).trim() || taskId || null;
  const parentTaskId = String(
    extra.parentTaskId ??
      ctx?.data?._workflowParentTaskId ??
      taskId ??
      "",
  ).trim() || taskId || null;
  const parentSessionId = String(
    extra.parentSessionId ??
      currentSessionId ??
      ctx?.data?._workflowParentSessionId ??
      taskId ??
      "",
  ).trim() || taskId || null;
  const rootSessionId = String(
    extra.rootSessionId ??
      ctx?.data?._workflowRootSessionId ??
      currentSessionId ??
      taskId ??
      "",
  ).trim() || taskId || null;
  return {
    taskId,
    rootTaskId,
    parentTaskId,
    currentSessionId,
    parentSessionId,
    rootSessionId,
    parentRunId: String(extra.parentRunId ?? ctx?.id ?? "").trim() || null,
    rootRunId: String(
      extra.rootRunId ??
        ctx?.data?._workflowRootRunId ??
        ctx?.id ??
        "",
    ).trim() || null,
    delegationDepth: normalizeWorkflowDelegationDepth(
      extra.delegationDepth ?? ctx?.data?._workflowDelegationDepth,
      0,
    ),
  };
}

function buildDelegatedSessionId(ctx, nodeId, suffix = "", taskId = "") {
  return [
    taskId || "workflow",
    "delegate",
    String(ctx?.id || "run").trim() || "run",
    String(nodeId || "node").trim() || "node",
    String(suffix || "child").trim() || "child",
  ].join(":");
}

function rememberWorkflowDelegationSession(ctx, sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId || !ctx?.data || typeof ctx.data !== "object") return;
  const existing = Array.isArray(ctx.data._delegatedSessionIds)
    ? ctx.data._delegatedSessionIds
    : [];
  if (existing.includes(normalizedSessionId)) return;
  ctx.data._delegatedSessionIds = [...existing, normalizedSessionId];
}

function buildTrackedSessionMetadata(ctx, cwd, title, lineage = {}, extra = {}) {
  return {
    title: title || undefined,
    workspaceId: String(ctx?.data?.workspaceId || ctx?.data?.activeWorkspace || "").trim() || undefined,
    workspaceDir: String(cwd || "").trim() || undefined,
    branch:
      String(
        ctx?.data?.branch ||
        ctx?.data?.task?.branch ||
        ctx?.data?.task?.branchName ||
        ctx?.data?.taskDetail?.branch ||
        ctx?.data?.taskDetail?.branchName ||
        "",
      ).trim() || undefined,
    workflowId: String(extra.workflowId || ctx?.data?._workflowId || "").trim() || undefined,
    workflowName: String(extra.workflowName || ctx?.data?._workflowName || ctx?.data?._workflowId || "").trim() || undefined,
    sourceNodeId: String(extra.sourceNodeId || "").trim() || undefined,
    rootTaskId: String(lineage.rootTaskId || "").trim() || undefined,
    parentTaskId: String(lineage.parentTaskId || "").trim() || undefined,
    rootSessionId: String(lineage.rootSessionId || "").trim() || undefined,
    parentSessionId: String(lineage.parentSessionId || "").trim() || undefined,
    rootRunId: String(lineage.rootRunId || "").trim() || undefined,
    parentRunId: String(lineage.parentRunId || "").trim() || undefined,
    delegationDepth: normalizeWorkflowDelegationDepth(lineage.delegationDepth, 0),
    taskSessionId: String(extra.taskSessionId || "").trim() || undefined,
  };
}

function ensureTrackedSession(tracker, sessionId, options = {}) {
  if (!tracker || !sessionId) return null;
  const metadata = buildTrackedSessionMetadata(
    options.ctx,
    options.cwd,
    options.title,
    options.lineage,
    options.extra,
  );
  const existing = tracker.getSessionById(sessionId);
  if (!existing) {
    return tracker.createSession({
      id: sessionId,
      type: options.type || "task",
      taskId: options.taskId || sessionId,
      metadata,
    });
  }
  tracker.updateSessionStatus(sessionId, "active");
  if (options.title) {
    tracker.renameSession(sessionId, options.title);
  }
  existing.metadata = {
    ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
    ...metadata,
  };
  return existing;
}

async function syncTaskDelegationTopology(taskId, topologyPatch = {}, workflowRun = null) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return;
  try {
    const taskStoreMod = await ensureTaskStoreMod();
    if (workflowRun && typeof taskStoreMod.linkTaskWorkflowRun === "function") {
      taskStoreMod.linkTaskWorkflowRun(normalizedTaskId, workflowRun);
    }
    if (typeof taskStoreMod.updateTask !== "function") return;
    const currentTask =
      typeof taskStoreMod.getTask === "function"
        ? taskStoreMod.getTask(normalizedTaskId)
        : null;
    if (!currentTask) return;
    taskStoreMod.updateTask(normalizedTaskId, {
      topology: {
        ...(currentTask?.topology && typeof currentTask.topology === "object" ? currentTask.topology : {}),
        ...(topologyPatch && typeof topologyPatch === "object" ? topologyPatch : {}),
      },
    });
  } catch {
    // Task-store projection is best-effort during workflow execution.
  }
}

function attachWorkflowTaskMetadata(ctx, taskData = {}, extra = {}) {
  const payload = taskData && typeof taskData === "object" ? { ...taskData } : {};
  const existingMeta =
    payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
      ? { ...payload.meta }
      : {};
  const workflowMeta =
    existingMeta.workflow && typeof existingMeta.workflow === "object" && !Array.isArray(existingMeta.workflow)
      ? { ...existingMeta.workflow }
      : {};
  const nextWorkflowMeta = {
    ...workflowMeta,
    workflowId: String(extra.workflowId || ctx?.data?._workflowId || workflowMeta.workflowId || "").trim() || undefined,
    workflowName: String(extra.workflowName || ctx?.data?._workflowName || workflowMeta.workflowName || "").trim() || undefined,
    runId: String(extra.runId || ctx?.id || workflowMeta.runId || "").trim() || undefined,
    rootRunId: String(extra.rootRunId || ctx?.data?._workflowRootRunId || workflowMeta.rootRunId || "").trim() || undefined,
    parentRunId: String(extra.parentRunId || ctx?.data?._workflowParentRunId || workflowMeta.parentRunId || "").trim() || undefined,
    sourceNodeId: String(extra.sourceNodeId || workflowMeta.sourceNodeId || "").trim() || undefined,
    sourceNodeType: String(extra.sourceNodeType || workflowMeta.sourceNodeType || "").trim() || undefined,
    agentId: String(extra.agentId || workflowMeta.agentId || "").trim() || undefined,
    traceparent: String(extra.traceparent || formatTraceparent() || workflowMeta.traceparent || "").trim() || undefined,
  };
  if (Object.values(nextWorkflowMeta).every((value) => value == null || value === "")) {
    return payload;
  }
  existingMeta.workflow = nextWorkflowMeta;
  payload.meta = existingMeta;
  return payload;
}

function sanitizeLedgerKeyPart(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function buildWorkflowLedgerBase(ctx, extra = {}) {
  return {
    runId: ctx?.id || null,
    workflowId: ctx?.data?._workflowId || null,
    workflowName: ctx?.data?._workflowName || null,
    rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
    parentRunId: ctx?.data?._workflowParentRunId || null,
    taskId:
      ctx?.data?.taskId ||
      ctx?.data?.task?.id ||
      ctx?.data?.taskInfo?.id ||
      ctx?.data?.taskDetail?.id ||
      null,
    rootTaskId: ctx?.data?._workflowRootTaskId || null,
    parentTaskId: ctx?.data?._workflowParentTaskId || null,
    sessionId: ctx?.data?._workflowSessionId || null,
    rootSessionId: ctx?.data?._workflowRootSessionId || null,
    parentSessionId: ctx?.data?._workflowParentSessionId || null,
    delegationDepth: normalizeWorkflowDelegationDepth(ctx?.data?._workflowDelegationDepth, 0),
    retryOf: ctx?.data?._retryOf || null,
    retryMode: ctx?.data?._retryMode || null,
    ...extra,
  };
}

function buildNodeExecutionLedgerRef(ctx, node, kind, parts = [], label = null) {
  const nodeId = String(node?.id || "node").trim() || "node";
  const suffix = (Array.isArray(parts) ? parts : [parts])
    .map((part) => sanitizeLedgerKeyPart(part, "item"))
    .filter(Boolean)
    .join(":");
  return {
    executionKind: kind,
    executionId: `${kind}:${ctx?.id || "run"}:${nodeId}${suffix ? `:${suffix}` : ""}`,
    executionKey: `${kind}:${nodeId}${suffix ? `:${suffix}` : ""}`,
    executionLabel: label || node?.label || nodeId,
    parentExecutionId: `node:${ctx?.id || "run"}:${nodeId}`,
  };
}

function recordNodeLedgerEvent(engine, event = {}) {
  if (typeof engine?._recordLedgerEvent === "function") {
    engine._recordLedgerEvent(event);
  }
}

function buildPlannerExecutionLedgerRef(ctx, node, phase, label = null) {
  return buildNodeExecutionLedgerRef(
    ctx,
    node,
    "planner",
    [phase],
    label || node?.label || phase || "planner",
  );
}

function recordPlannerLedgerEvent(engine, ctx, node, eventType, {
  phase = "planner",
  label = null,
  status = null,
  attempt = undefined,
  error = null,
  summary = null,
  reason = null,
  meta = undefined,
} = {}) {
  const nextMeta = meta && typeof meta === "object" ? { ...meta } : {};
  if (!nextMeta.normalizedEventType) {
    if (eventType === "planner.plan_reasoning") {
      nextMeta.normalizedEventType = "plan_reasoning";
    } else if (
      eventType === "planner.plan_initialized"
      || eventType === "planner.plan_completed"
      || eventType === "planner.plan_failed"
    ) {
      nextMeta.normalizedEventType = "plan";
      nextMeta.plan = {
        phase,
        stepLabel: label || null,
        status: status || null,
        summary: summary || null,
        reason: reason || null,
      };
    } else if (eventType === "planner.step_started") {
      nextMeta.normalizedEventType = "current_plan_step";
      nextMeta.currentPlanStep = {
        phase,
        stepLabel: label || null,
        status: status || null,
      };
    } else if (
      eventType === "planner.step_completed"
      || eventType === "planner.step_blocked"
      || eventType === "planner.post_attachment"
    ) {
      nextMeta.normalizedEventType = "step_result";
      nextMeta.stepResult = {
        phase,
        stepLabel: label || null,
        status: status || null,
        summary: summary || null,
        reason: reason || null,
        attachmentKind: nextMeta.attachmentKind || null,
      };
    }
  }
  recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
    eventType,
    ...buildPlannerExecutionLedgerRef(ctx, node, phase, label),
    nodeId: node?.id || null,
    nodeType: node?.type || null,
    nodeLabel: node?.label || null,
    status,
    attempt,
    error,
    summary,
    reason,
    meta: nextMeta,
  }));
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task, maxComments = 6) {
  if (!task) return [];
  const raw = Array.isArray(task.comments)
    ? task.comments
    : Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
  const normalized = raw
    .map((comment) => {
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        author: comment?.author || comment?.user || null,
        createdAt: comment?.createdAt || comment?.created_at || null,
        body: trimmed.replace(/\s+/g, " ").slice(0, 600),
      };
    })
    .filter(Boolean);
  if (normalized.length <= maxComments) return normalized;
  return normalized.slice(-maxComments);
}

function normalizeTaskAttachments(task, maxAttachments = 10) {
  if (!task) return [];
  const combined = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
  if (combined.length <= maxAttachments) return combined;
  return combined.slice(0, maxAttachments);
}

function formatAttachmentLine(att) {
  const name = att.name || att.filename || att.title || "attachment";
  const kind = att.kind ? ` (${att.kind})` : "";
  const location = att.url || att.filePath || att.path || "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${suffix}`;
}

function formatCommentLine(comment) {
  const author = comment.author ? `@${comment.author}` : "comment";
  const when = comment.createdAt ? ` (${comment.createdAt})` : "";
  return `- ${author}${when}: ${comment.body}`;
}

const TASK_PROMPT_ANCHOR_HEADERS = [
  "## Task Context",
  "## Git Context",
  "## Git Attribution",
  "## Environment",
  "Task ID:",
  "Co-authored-by:",
];

function isStrictCacheAnchorMode() {
  return String(process.env.BOSUN_CACHE_ANCHOR_MODE || "")
    .trim()
    .toLowerCase() === "strict";
}

function collectCacheAnchorMarkers(values = {}, extra = []) {
  const markers = new Set();
  const add = (value) => {
    const normalized = String(value || "").trim();
    if (normalized) markers.add(normalized);
  };
  for (const value of Object.values(values || {})) add(value);
  for (const value of extra || []) add(value);
  return Array.from(markers);
}

function assertCacheAnchorSystemPrompt(candidate, markers = [], strictCacheAnchoring = false) {
  if (!strictCacheAnchoring) return;
  const leaked = markers.find((marker) => candidate.includes(marker));
  if (leaked) {
    throw new Error(
      `BOSUN_CACHE_ANCHOR_MODE=strict violation: system prompt leaked task-specific marker "${leaked}"`,
    );
  }
}

function buildTaskContextBlock(task) {
  if (!task) return "";
  const comments = normalizeTaskComments(task);
  const attachments = normalizeTaskAttachments(task);
  const reviewStatus = String(task?.reviewStatus || "").trim().toLowerCase();
  const reviewIssues = Array.isArray(task?.reviewIssues) ? task.reviewIssues : [];
  if (!comments.length && !attachments.length && reviewStatus !== "changes_requested") return "";
  const lines = ["## Task Context"];
  if (reviewStatus === "changes_requested") {
    lines.push("### Review Findings");
    if (reviewIssues.length > 0) {
      for (const issue of reviewIssues) lines.push(formatReviewIssueLine(issue));
    } else {
      lines.push("- Review requested changes, but no structured issue list was recorded.");
    }
  }
  if (comments.length) {
    lines.push("### Comments");
    for (const comment of comments) lines.push(formatCommentLine(comment));
  }
  if (attachments.length) {
    lines.push("### Attachments");
    for (const attachment of attachments) lines.push(formatAttachmentLine(attachment));
  }
  return lines.join("\n");
}

function buildWorkflowAgentToolContract(rootDir, agentProfileId = "") {
  const profileId = String(agentProfileId || "").trim();
  const effective = profileId
    ? getEffectiveTools(rootDir, profileId)
    : getEffectiveTools(rootDir, "__default__");
  const rawCfg = profileId ? getAgentToolConfig(rootDir, profileId) : null;
  const enabledBuiltinTools = (Array.isArray(effective?.builtinTools) ? effective.builtinTools : [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      id: String(tool?.id || "").trim(),
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || "").trim(),
    }))
    .filter((tool) => tool.id);
  const enabledMcpServers = Array.isArray(rawCfg?.enabledMcpServers)
    ? rawCfg.enabledMcpServers.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const manifest = {
    agentProfileId: profileId || null,
    enabledBuiltinTools,
    enabledMcpServers,
    toolBridge: {
      module: "./voice-tools.mjs",
      function: "executeToolCall(toolName, args, context)",
      quickUse: "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('get_workspace_context', {}, {});console.log(r?.result||r);})\"",
    },
  };
  return [
    "## Tool Capability Contract",
    "Use enabled tools by default before claiming work is blocked.",
    "Enabled tools JSON:",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "When uncertain about arguments, call get_admin_help via executeToolCall.",
  ].join("\n");
}

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  TRIGGERS — Events that initiate a workflow
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("trigger.manual", {
  describe: () => "Manual trigger — workflow starts on user request",
  schema: {
    type: "object",
    properties: {},
  },
  async execute(node, ctx, engine) {
    ctx.log(node.id, "Manual trigger fired");
    return { triggered: true, reason: "manual" };
  },
});

registerBuiltinNodeType("trigger.task_low", {
  describe: () =>
    "Fires when backlog task count drops below threshold. Self-queries kanban " +
    "when todoCount is not pre-populated in context data. Workspace-aware: " +
    "uses workspace context to scope the kanban query.",
  schema: {
    type: "object",
    properties: {
      threshold: { type: "number", default: 3, description: "Minimum todo count before triggering" },
      status: { type: "string", default: "todo", description: "Task status to count" },
      projectId: { type: "string", description: "Project ID to check (optional)" },
      countDraftTasks: { type: "boolean", default: false, description: "Also count draft tasks toward threshold" },
    },
  },
  async execute(node, ctx, engine) {
    const threshold = node.config?.threshold ?? 3;
    const status = node.config?.status ?? "todo";
    const countDrafts = node.config?.countDraftTasks === true;
    let todoCount = ctx.data?.todoCount ?? ctx.data?.backlogCount ?? null;

    // Self-query kanban if todoCount not pre-populated
    if (todoCount == null) {
      try {
        const projectId = cfgOrCtx(node, ctx, "projectId") || undefined;
        const workspaceId = ctx.data?._workspaceId || cfgOrCtx(node, ctx, "workspaceId") || undefined;
        const kanban = ctx.data?._services?.kanban;
        let tasks;
        const queryOpts = { status };
        if (workspaceId) queryOpts.workspace = workspaceId;
        if (kanban?.listTasks) {
          tasks = await kanban.listTasks(projectId, queryOpts);
        } else {
          const ka = await ensureKanbanAdapterMod();
          tasks = await ka.listTasks(projectId, queryOpts);
        }
        todoCount = Array.isArray(tasks) ? tasks.length : 0;

        // Optionally also count draft tasks
        if (countDrafts) {
          let draftTasks;
          const draftOpts = { status: "draft" };
          if (workspaceId) draftOpts.workspace = workspaceId;
          if (kanban?.listTasks) {
            draftTasks = await kanban.listTasks(projectId, draftOpts);
          } else {
            const ka = await ensureKanbanAdapterMod();
            draftTasks = await ka.listTasks(projectId, draftOpts);
          }
          const draftCount = Array.isArray(draftTasks) ? draftTasks.length : 0;
          todoCount += draftCount;
          ctx.log(node.id, `Self-queried kanban: ${todoCount} task(s) (todo + ${draftCount} draft) for workspace="${workspaceId || "all"}"`);
        } else {
          ctx.log(node.id, `Self-queried kanban: ${todoCount} task(s) with status "${status}" for workspace="${workspaceId || "all"}"`);
        }
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

registerBuiltinNodeType("trigger.schedule", {
  describe: () => "Fires on a cron-like schedule (checked by supervisor loop)",
  schema: {
    type: "object",
    properties: {
      intervalMs: { type: "number", default: 3600000, description: "Interval in milliseconds" },
      cron: { type: "string", description: "Cron expression (future support)" },
    },
  },
  async execute(node, ctx, engine) {
    const interval = node.config?.intervalMs ?? 3600000;
    const lastRun = ctx.data?._lastRunAt ?? 0;
    const elapsed = Date.now() - lastRun;
    const triggered = elapsed >= interval;
    ctx.log(node.id, `Schedule check: ${elapsed}ms elapsed, interval: ${interval}ms, triggered: ${triggered}`);
    return { triggered, elapsed, interval };
  },
});

registerBuiltinNodeType("trigger.event", {
  describe: () => "Fires on a specific bosun event (task.complete, pr.merged, etc.)",
  schema: {
    type: "object",
    properties: {
      eventType: { type: "string", description: "Event type to listen for" },
      filter: { type: "string", description: "Optional filter expression" },
    },
  },
  async execute(node, ctx, engine) {
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

registerBuiltinNodeType("trigger.meeting.wake_phrase", {
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
  async execute(node, ctx, engine) {
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

registerBuiltinNodeType("trigger.webhook", {
  describe: () => "Fires when a webhook is received at the workflow's endpoint",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Webhook path (auto-generated if empty)" },
      method: { type: "string", default: "POST", enum: ["GET", "POST"] },
    },
  },
  async execute(node, ctx, engine) {
    return { triggered: true, payload: ctx.data?.webhookPayload || {} };
  },
});

registerBuiltinNodeType("trigger.pr_event", {
  describe: () => "Fires on PR events (opened, merged, review requested, etc.)",
  schema: {
    type: "object",
    properties: {
      event: { type: "string", enum: ["opened", "merged", "review_requested", "changes_requested", "approved", "closed"], description: "PR event type" },
      events: {
        type: "array",
        items: { type: "string" },
        description: "Optional set of accepted PR event types (supports aliases like ready_for_review/synchronize)",
      },
      branchPattern: { type: "string", description: "Branch name regex filter" },
    },
  },
  async execute(node, ctx, engine) {
    const expectedEvents = [
      node.config?.event,
      ...(Array.isArray(node.config?.events) ? node.config.events : []),
    ]
      .map((value) => normalizePrEventName(value))
      .filter(Boolean);
    const actual = normalizePrEventName(
      ctx.data?.prEvent
      || (String(ctx.data?.eventType || "").startsWith("pr.")
        ? String(ctx.data.eventType).slice(3).trim()
        : ""),
    );
    const expectedSet = new Set(expectedEvents);
    let triggered = expectedSet.size > 0 ? expectedSet.has(actual) : Boolean(actual);
    if (triggered && node.config?.branchPattern) {
      const regex = new RegExp(node.config.branchPattern);
      triggered = regex.test(ctx.data?.branch || "");
    }
    return { triggered, prEvent: actual, expectedEvents };
  },
});

registerBuiltinNodeType("trigger.task_assigned", {
  describe: () => "Fires when a task is assigned to an agent",
  schema: {
    type: "object",
    properties: {
      agentType: { type: "string", description: "Filter by agent type (e.g., 'frontend')" },
      taskPattern: { type: "string", description: "Title/tag pattern to match" },
      filter: { type: "string", description: "JS expression filter (e.g., \"task.tags?.includes('backend')\")" },
    },
  },
  async execute(node, ctx, engine) {
    const triggered = evaluateTaskAssignedTriggerConfig(node.config, ctx.data);
    return { triggered, task: ctx.data };
  },
});

registerBuiltinNodeType("trigger.anomaly", {
  describe: () => "Fires when the anomaly detector reports an anomaly matching the configured criteria",
  schema: {
    type: "object",
    properties: {
      anomalyType: { type: "string", description: "Anomaly type filter (e.g., 'error_spike', 'stuck_agent', 'build_failure')" },
      minSeverity: { type: "string", enum: ["low", "medium", "high", "critical"], default: "medium", description: "Minimum severity to trigger" },
      agentFilter: { type: "string", description: "Regex to match agent ID or name" },
    },
  },
  async execute(node, ctx, engine) {
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

registerBuiltinNodeType("trigger.scheduled_once", {
  describe: () => "Fires once at or after a specific scheduled time (persistent — survives restarts)",
  schema: {
    type: "object",
    properties: {
      runAt: { type: "string", description: "ISO 8601 datetime or relative expression (e.g., '+30m', '+2h')" },
      reason: { type: "string", description: "Human-readable reason for the scheduled trigger" },
    },
    required: ["runAt"],
  },
  async execute(node, ctx, engine) {
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

registerBuiltinNodeType("trigger.workflow_call", {
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
  async execute(node, ctx, engine) {
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

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  CONDITIONS — Branching / routing logic
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("condition.expression", {
  describe: () => "Evaluate a JS expression to branch workflow execution",
  schema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JS expression. Access $data, $output, $ctx" },
    },
    required: ["expression"],
  },
  async execute(node, ctx, engine) {
    const expr = node.config?.expression;
    if (!expr) throw new Error("Expression is required");
    try {
      const fn = new Function("$data", "$ctx", "$output", `return (${expr});`);
      const allOutputs = {};
      for (const [k, v] of ctx.nodeOutputs) allOutputs[k] = v;
      const result = fn(ctx.data, ctx, allOutputs);
      ctx.log(node.id, `Expression "${expr}" → ${result}`);
      return { result: !!result, value: result };
    } catch (err) {
      throw new Error(`Expression error: ${err.message}`);
    }
  },
});

registerBuiltinNodeType("condition.task_has_tag", {
  describe: () => "Check if current task has a specific tag or label",
  schema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Tag to check for" },
      field: { type: "string", default: "tags", description: "Field to check (tags, labels, title)" },
    },
    required: ["tag"],
  },
  async execute(node, ctx, engine) {
    const tag = node.config?.tag?.toLowerCase();
    const field = node.config?.field || "tags";
    let haystack = ctx.data?.task?.[field] || ctx.data?.[field] || "";
    if (Array.isArray(haystack)) haystack = haystack.join(",").toLowerCase();
    else haystack = String(haystack).toLowerCase();
    const result = haystack.includes(tag);
    ctx.log(node.id, `Tag check: "${tag}" in ${field} → ${result}`);
    return { result, tag, field };
  },
});

registerBuiltinNodeType("condition.file_exists", {
  describe: () => "Check if a file or directory exists in the workspace",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path (supports {{variables}})" },
    },
    required: ["path"],
  },
  async execute(node, ctx, engine) {
    const filePath = ctx.resolve(node.config?.path || "");
    const exists = existsSync(filePath);
    ctx.log(node.id, `File check: "${filePath}" → ${exists}`);
    return { result: exists, path: filePath };
  },
});

registerBuiltinNodeType("condition.switch", {
  describe: () => "Multi-way branch based on a value matching cases",
  schema: {
    type: "object",
    properties: {
      value: { type: "string", description: "Expression to evaluate" },
      expression: { type: "string", description: "Legacy alias for value" },
      field: { type: "string", description: "Legacy field lookup key (fallback when no expression is provided)" },
      cases: {
        type: "object",
        description: "Map of case values to output port names",
        additionalProperties: { type: "string" },
      },
    },
    required: [],
  },
  async execute(node, ctx, engine) {
    let value;
    const expr = node.config?.value || node.config?.expression || "";
    if (expr) {
      try {
        const fn = new Function("$data", "$ctx", `return (${expr});`);
        value = fn(ctx.data, ctx);
      } catch {
        value = ctx.resolve(expr);
      }
    } else if (node.config?.field) {
      const field = String(node.config.field || "").trim();
      value = field ? ctx.data?.[field] : undefined;
      if (value === undefined && field) {
        for (const output of ctx.nodeOutputs?.values?.() || []) {
          if (
            output &&
            typeof output === "object" &&
            Object.prototype.hasOwnProperty.call(output, field)
          ) {
            value = output[field];
            break;
          }
        }
      }
    }
    const cases = node.config?.cases || {};
    const matchedPort = cases[String(value)] || "default";
    ctx.log(node.id, `Switch: "${value}" → port "${matchedPort}"`);
    return { value, matchedPort, port: matchedPort };
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  ACTIONS — Side-effect operations
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("action.run_agent", {
  describe: () => "Run a bosun agent with a prompt to perform work",
  schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Agent prompt (supports {{variables}})" },
      systemPrompt: { type: "string", description: "Optional stable system prompt for cache anchoring" },
      sdk: { type: "string", enum: ["codex", "copilot", "claude", "auto"], default: "auto" },
      model: { type: "string", description: "Optional model override for the selected SDK" },
      taskId: { type: "string", description: "Optional task ID used for task metadata lookup" },
      cwd: { type: "string", description: "Working directory for the agent" },
      mode: { type: "string", enum: ["ask", "agent", "plan", "web", "instant"], default: "agent", description: "Optional framing mode for the agent run" },
      executionRole: { type: "string", enum: ["architect", "editor"], description: "Optional architect/editor execution role override" },
      architectPlan: { type: "string", description: "Approved architect plan passed into editor/verify phases" },
      repoMapQuery: { type: "string", description: "Optional query used to select a compact repo map" },
      repoMapFileLimit: { type: "number", default: 12, description: "Maximum repo-map files to include" },
      timeoutMs: { type: "number", default: 3600000, description: "Agent timeout in ms" },
      agentProfile: { type: "string", description: "Agent profile name (e.g., 'frontend', 'backend')" },
      includeTaskContext: { type: "boolean", default: true, description: "Append task comments/attachments if available" },
      requireTaskPromptCompleteness: {
        type: "boolean",
        default: false,
        description: "Require task description and URL metadata before running the agent",
      },
      failOnError: { type: "boolean", default: false, description: "Throw when agent returns success=false (enables workflow retries)" },
      sessionId: { type: "string", description: "Existing session/thread ID to continue if available" },
      taskKey: { type: "string", description: "Stable key used for session-aware retries/resume" },
      autoRecover: { type: "boolean", default: true, description: "Enable continue/retry/fallback recovery ladder when agent fails" },
      continueOnSession: { type: "boolean", default: true, description: "Try continuing existing session before starting fresh" },
      continuePrompt: { type: "string", description: "Prompt used when continuing an existing session" },
      sessionRetries: { type: "number", default: 2, description: "Additional session-aware retries for execWithRetry" },
      maxContinues: { type: "number", default: 2, description: "Max idle-continue attempts for execWithRetry" },
      maxRetainedEvents: { type: "number", default: WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT, description: "Maximum agent events retained in run output" },
      candidateCount: { type: "number", default: 1, description: "Run N isolated agent candidates and select the best (N>1 enables selector mode)" },
      candidateSelector: {
        type: "string",
        enum: ["score", "first_success", "last_success"],
        default: "score",
        description: "Candidate selection strategy when candidateCount > 1",
      },
      candidatePromptTemplate: {
        type: "string",
        description:
          "Optional prompt suffix template for candidate mode. Supports {{candidateIndex}} and {{candidateCount}}",
      },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const prompt = ctx.resolve(node.config?.prompt || "");
    const sdk = node.config?.sdk || "auto";
    const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;
    const configuredCwd = ctx.resolve(node.config?.cwd || "");
    const runtimeWorktreePath = String(ctx.data?.worktreePath || "").trim();
    const cwd = isUnresolvedTemplateToken(configuredCwd)
      ? runtimeWorktreePath || process.cwd()
      : configuredCwd || runtimeWorktreePath || process.cwd();
    const trackedTaskId = String(
      ctx.data?.taskId ||
        ctx.data?.task?.id ||
        ctx.data?.taskDetail?.id ||
        ctx.resolve(node.config?.taskId || "") ||
        "",
    ).trim();
    const trackedTaskTitle = String(
      ctx.data?.task?.title ||
        ctx.data?.taskDetail?.title ||
        ctx.data?.taskInfo?.title ||
        ctx.data?.taskTitle ||
        trackedTaskId ||
        "",
    ).trim();
    const agentProfileId = String(
      ctx.resolve(node.config?.agentProfile || ctx.data?.agentProfile || ""),
    ).trim();
    const agentToolConfig = agentProfileId ? getAgentToolConfig(cwd, agentProfileId) : null;
    const enabledMcpServerIds = Array.isArray(agentToolConfig?.enabledMcpServers)
      ? agentToolConfig.enabledMcpServers.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const selectedMcpServers = agentToolConfig ? enabledMcpServerIds : undefined;
    const resolvedTimeoutMs = ctx.resolve(node.config?.timeoutMs ?? ctx.data?.taskTimeoutMs ?? 3600000);
    const timeoutMs = Number.isFinite(Number(resolvedTimeoutMs))
      ? Math.max(1000, Math.trunc(Number(resolvedTimeoutMs)))
      : 3600000;
    const effectiveMode = String(ctx.resolve(node.config?.mode || "agent") || "agent").trim().toLowerCase() || "agent";
    const architectPlan = String(
      ctx.resolve(node.config?.architectPlan || "") ||
      ctx.data?.architectPlan ||
      ctx.data?.planSummary ||
      "",
    ).trim();
    const includeTaskContext =
      node.config?.includeTaskContext !== false &&
      ctx.data?._taskIncludeContext !== false;
    const requireTaskPromptCompleteness =
      node.config?.requireTaskPromptCompleteness === true;
    const configuredSystemPrompt =
      ctx.resolve(node.config?.systemPrompt || "") ||
      ctx.data?._taskSystemPrompt ||
      "";
    const toolContract = buildWorkflowAgentToolContract(cwd, agentProfileId);
    const effectiveSystemPrompt = [configuredSystemPrompt, toolContract]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n\n");
    const strictCacheAnchoring = isStrictCacheAnchorMode();
    if (strictCacheAnchoring && effectiveSystemPrompt) {
      const task = ctx.data?.task || ctx.data?.taskDetail || ctx.data?.taskInfo || null;
      const taskDescription = String(
        task?.description ||
          task?.details ||
          ctx.data?.taskDescription ||
          ctx.data?.taskDetail?.description ||
          ctx.data?.taskInfo?.description ||
          "",
      ).trim();
      const taskBranch = String(
        ctx.data?.branch ||
          task?.branch ||
          task?.branchName ||
          task?.meta?.branch ||
          ctx.data?.taskDetail?.branchName ||
          ctx.data?.taskInfo?.branchName ||
          "",
      ).trim();
      const taskBaseBranch = String(
        ctx.data?.baseBranch ||
          task?.baseBranch ||
          task?.meta?.baseBranch ||
          ctx.data?.taskDetail?.baseBranch ||
          ctx.data?.taskInfo?.baseBranch ||
          "",
      ).trim();
      const taskWorktreePath = String(
        ctx.data?.worktreePath ||
          task?.worktreePath ||
          task?.meta?.worktreePath ||
          ctx.data?.taskDetail?.worktreePath ||
          ctx.data?.taskInfo?.worktreePath ||
          "",
      ).trim();
      const cacheAnchorMarkers = collectCacheAnchorMarkers(
        {
          taskId: trackedTaskId,
          taskTitle: trackedTaskTitle,
          taskDescription,
          branch: taskBranch,
          baseBranch: taskBaseBranch,
          worktreePath: taskWorktreePath,
        },
        TASK_PROMPT_ANCHOR_HEADERS,
      );
      assertCacheAnchorSystemPrompt(
        effectiveSystemPrompt,
        cacheAnchorMarkers,
        strictCacheAnchoring,
      );
    }
    let finalPrompt = prompt;
    const promptHasRepoMapContext = hasRepoMapContext(finalPrompt);
    const architectEditorFrame = buildArchitectEditorFrame({
      executionRole: ctx.resolve(node.config?.executionRole || ""),
      architectPlan,
      planSummary: architectPlan,
      includeRepoMap: !promptHasRepoMapContext,
      repoMap: node.config?.repoMap || ctx.data?.repoMap || null,
      repoMapFileLimit: node.config?.repoMapFileLimit,
      repoMapQuery: ctx.resolve(node.config?.repoMapQuery || ""),
      query: trackedTaskTitle || ctx.data?.taskDescription || prompt,
      prompt,
      taskTitle: trackedTaskTitle,
      taskDescription:
        ctx.data?.taskDescription ||
        ctx.data?.task?.description ||
        ctx.data?.task?.body ||
        ctx.data?.taskDetail?.description ||
        ctx.data?.taskInfo?.description ||
        "",
      changedFiles:
        (Array.isArray(ctx.data?.changedFiles) ? ctx.data.changedFiles : null) ||
        (Array.isArray(ctx.data?.task?.changedFiles) ? ctx.data.task.changedFiles : null) ||
        [],
      cwd,
      repoRoot: ctx.data?.repoRoot || cwd,
    }, effectiveMode);
    if (
      architectEditorFrame &&
      !String(finalPrompt || "").includes("## Architect/Editor Execution")
    ) {
      finalPrompt = `${architectEditorFrame}\n\n${finalPrompt}`;
    }
    const promptHasTaskContext =
      ctx.data?._taskPromptIncludesTaskContext === true ||
      String(finalPrompt || "").includes("## Task Context");
    if (includeTaskContext && !promptHasTaskContext) {
      const explicitContext =
        ctx.data?.taskContext ||
        ctx.data?.taskContextBlock ||
        null;
      const task = ctx.data?.task || ctx.data?.taskDetail || ctx.data?.taskInfo || null;
      const contextBlock = explicitContext || buildTaskContextBlock(task);
      if (contextBlock) finalPrompt = `${finalPrompt}\n\n${contextBlock}`;
    }

    if (requireTaskPromptCompleteness) {
      const promptCompleteness = await ensureWorkflowTaskPromptCompleteness(
        ctx,
        engine,
        node.id,
        trackedTaskId,
      );
      if (!promptCompleteness.ok) {
        ctx.log(node.id, promptCompleteness.error, "warn");
        if (node.config?.failOnError) {
          throw new Error(promptCompleteness.error);
        }
        return {
          success: false,
          error: promptCompleteness.error,
          output: "",
          sdk,
          items: [],
          threadId: null,
          sessionId: null,
          failureKind: "prompt_quality_error",
          blockedReason: "prompt_quality_error",
        };
      }
      finalPrompt = appendWorkflowTaskPromptContext(finalPrompt, promptCompleteness);
    }

    ctx.log(node.id, `Running agent (${sdk}) in ${cwd}`);

    // ==== Sub-workflow delegation ====
    // If an agent-type workflow exists (metadata.replaces.module =
    // "primary-agent.mjs") and its trigger filter matches this task,
    // delegate the full agent execution to that workflow instead of
    // running a single generic agent pass.
    // Guard: skip delegation when already inside an agent sub-workflow
    // to prevent infinite recursion.
    if (
      !ctx.data?._agentWorkflowActive &&
      typeof engine?.list === "function" &&
      typeof engine?.execute === "function"
    ) {
      const taskIdForDelegate = String(
        ctx.data?.taskId ||
        ctx.data?.task?.id ||
        "",
      ).trim();
      const taskTitleForDelegate = String(
        ctx.data?.taskTitle ||
        ctx.data?.task?.title ||
        "",
      ).trim();
      const taskForDelegate =
        ctx.data?.task && typeof ctx.data.task === "object"
          ? ctx.data.task
          : {
              id: taskIdForDelegate || undefined,
              title: taskTitleForDelegate || undefined,
            };
      const hasTaskContext = Boolean(
        taskIdForDelegate ||
        taskTitleForDelegate ||
        (taskForDelegate?.id && taskForDelegate?.title),
      );

      if (hasTaskContext) {
        const eventPayload = {
          ...(ctx.data && typeof ctx.data === "object" ? ctx.data : {}),
          eventType: "task.assigned",
          taskId: taskIdForDelegate || undefined,
          taskTitle: taskTitleForDelegate || undefined,
          task: taskForDelegate,
          agentType: String(
            ctx.data?.agentType ||
            ctx.data?.assignedAgentType ||
            ctx.data?.task?.agentType ||
            "",
          ).trim() || undefined,
        };
        const workflows = Array.isArray(engine.list?.()) ? engine.list() : [];
        const candidate = workflows.find((workflow) => {
          const hydratedWorkflow =
            workflow?.id &&
            (!Array.isArray(workflow?.nodes) || workflow.nodes.length === 0) &&
            typeof engine.get === "function"
              ? (engine.get(workflow.id) || workflow)
              : workflow;
          if (!hydratedWorkflow || hydratedWorkflow.enabled === false) return false;
          const replacesModule = String(hydratedWorkflow?.metadata?.replaces?.module || "").trim();
          if (replacesModule !== "primary-agent.mjs") return false;
          const nodes = Array.isArray(hydratedWorkflow?.nodes) ? hydratedWorkflow.nodes : [];
          return nodes.some((wfNode) => {
            if (wfNode?.type !== "trigger.task_assigned") return false;
            return evaluateTaskAssignedTriggerConfig(wfNode.config || {}, eventPayload);
          });
        });

        if (candidate?.id) {
          const delegationLineage = resolveWorkflowDelegationLineage(ctx, {
            taskId: taskIdForDelegate,
          });
          const taskSessionId = delegationLineage.parentSessionId || taskIdForDelegate || null;
          const childSessionId = buildDelegatedSessionId(
            ctx,
            node.id,
            [candidate.id, "workflow"].join(":"),
            taskIdForDelegate || delegationLineage.rootTaskId || "",
          );
          const childRunOpts = makeChildWorkflowExecuteOptions(ctx, {
            childWorkflowId: candidate.id,
            sourceNodeId: node.id,
          });
          const assignTransitionKey =
            String(ctx.data?._delegationTransitionKey || "").trim() ||
            ["assign", node.id, candidate.id, taskIdForDelegate || "task"].join(":");
          const existingAssignTransition =
            getExistingDelegationTransition(ctx, assignTransitionKey) ||
            (typeof ctx.getDelegationTransitionGuard === "function"
              ? ctx.getDelegationTransitionGuard(assignTransitionKey)
              : null);
          if (existingAssignTransition?.type === "run_agent_delegate") {
            return { ...existingAssignTransition.result };
          }

          recordDelegationAuditEvent(ctx, {
            type: "assign",
            eventType: "assign",
            taskId: taskIdForDelegate || null,
            taskTitle: taskTitleForDelegate || null,
            sessionId: childSessionId,
            parentSessionId: taskSessionId,
            rootSessionId: delegationLineage.rootSessionId,
            workflowNodeId: node.id,
            delegatedWorkflowId: candidate.id,
            delegatedWorkflowName: candidate.name || candidate.id,
            transitionKey: assignTransitionKey,
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
          const tracker = taskIdForDelegate ? getSessionTracker() : null;
          if (tracker && taskIdForDelegate) {
            ensureTrackedSession(tracker, taskSessionId, {
              ctx,
              cwd,
              title: taskTitleForDelegate || taskSessionId,
              taskId: taskIdForDelegate,
              type: "task",
              lineage: {
                ...delegationLineage,
                parentSessionId: taskSessionId,
                rootSessionId: delegationLineage.rootSessionId || taskSessionId,
              },
              extra: {
                sourceNodeId: node.id,
                taskSessionId,
              },
            });
            ensureTrackedSession(tracker, childSessionId, {
              ctx,
              cwd,
              title: `${candidate.name || candidate.id} for ${taskTitleForDelegate || taskIdForDelegate}`,
              taskId: taskIdForDelegate,
              type: "delegate",
              lineage: {
                ...delegationLineage,
                parentTaskId: taskIdForDelegate || delegationLineage.parentTaskId,
                parentSessionId: taskSessionId,
                rootSessionId: delegationLineage.rootSessionId || taskSessionId,
                parentRunId: ctx.id,
                rootRunId: delegationLineage.rootRunId || ctx.id,
                delegationDepth: delegationLineage.delegationDepth + 1,
              },
              extra: {
                workflowId: candidate.id,
                workflowName: candidate.name || candidate.id,
                sourceNodeId: node.id,
                taskSessionId,
              },
            });
            tracker.recordEvent(taskSessionId, {
              role: "system",
              type: "system",
              content: `Delegating to agent workflow "${candidate.name || candidate.id}"`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.recordEvent(childSessionId, {
              role: "system",
              type: "system",
              content: `Delegated workflow "${candidate.name || candidate.id}" started`,
              timestamp: new Date().toISOString(),
              _sessionType: "delegate",
            });
          }

          const delegatedInput = applyChildWorkflowLineage(
            ctx,
            {
              ...eventPayload,
              _agentWorkflowActive: true,
            },
            candidate.id,
            {
              taskId: taskIdForDelegate,
              rootTaskId: delegationLineage.rootTaskId || taskIdForDelegate || null,
              parentTaskId: taskIdForDelegate || delegationLineage.parentTaskId || null,
              workflowSessionId: childSessionId,
              parentSessionId: taskSessionId,
              rootSessionId: delegationLineage.rootSessionId || taskSessionId,
              delegationDepth: delegationLineage.delegationDepth + 1,
            },
          );
          rememberWorkflowDelegationSession(ctx, childSessionId);
          const resolveDelegatedWatchdogTimeoutMs = () => {
            const candidates = [
              ctx.resolve(node.config?.delegationWatchdogTimeoutMs),
              ctx.data?.delegationWatchdogTimeoutMs,
              ctx.data?.task?.delegationWatchdogTimeoutMs,
            ];
            for (const value of candidates) {
              const parsed = Number(value);
              if (Number.isFinite(parsed) && parsed > 0) return parsed;
            }
            return 300000;
          };
          const resolveDelegatedWatchdogMaxRecoveries = () => {
            const candidates = [
              ctx.resolve(node.config?.delegationWatchdogMaxRecoveries),
              ctx.data?.delegationWatchdogMaxRecoveries,
              ctx.data?.task?.delegationWatchdogMaxRecoveries,
            ];
            for (const value of candidates) {
              const parsed = Number(value);
              if (Number.isFinite(parsed) && parsed >= 0) return Math.min(5, Math.trunc(parsed));
            }
            return 1;
          };
          const delegatedWatchdogTimeoutMs = resolveDelegatedWatchdogTimeoutMs();
          const delegatedWatchdogMaxRecoveries = resolveDelegatedWatchdogMaxRecoveries();
          let watchdogRetryCount = 0;
          let subRun = null;
          let watchdogRecovered = false;
          let watchdogState = null;

          while (true) {
            subRun = await engine.execute(
              candidate.id,
              delegatedInput,
              childRunOpts,
            );

            const delegatedRunId = String(subRun?.runId || subRun?.id || "").trim();
            watchdogState = null;
            if (delegatedRunId) {
              if (typeof engine.getRunDetail === "function") {
                // Prefer a lightweight, per-run lookup when available to avoid hydrating full history.
                watchdogState = await engine.getRunDetail(delegatedRunId);
              } else if (typeof engine.getRunHistory === "function") {
                const delegatedHistory = engine.getRunHistory(candidate.id, 10);
                watchdogState = Array.isArray(delegatedHistory)
                  ? delegatedHistory.find((entry) => String(entry?.runId || "") === delegatedRunId) || null
                  : null;
              }
            }
            const stalledDelegationInner = Boolean(
              subRun?.status === "running" &&
              watchdogState?.status === "running" &&
              (watchdogState?.isStuck === true || Number(watchdogState?.stuckMs || 0) >= delegatedWatchdogTimeoutMs)
            );

            if (!stalledDelegationInner) break;
            if (watchdogRetryCount >= delegatedWatchdogMaxRecoveries) break;
            watchdogRetryCount += 1;
            watchdogRecovered = true;
          }

          const stalledDelegation = Boolean(
            subRun?.status === "running" &&
            watchdogState?.status === "running" &&
            (watchdogState?.isStuck === true || Number(watchdogState?.stuckMs || 0) >= delegatedWatchdogTimeoutMs)
          );
          const subTerminalOutput = subRun?.data?._workflowTerminalOutput;
          const subBlockedReason =
            subTerminalOutput && typeof subTerminalOutput === "object"
              ? String(subTerminalOutput.blockedReason || "").trim() || null
              : null;
          const subImplementationState =
            subTerminalOutput && typeof subTerminalOutput === "object"
              ? String(subTerminalOutput.implementationState || "").trim() || null
              : null;
          const subStatus = stalledDelegation ? "stalled" : deriveWorkflowExecutionSessionStatus(subRun);
          const subFailed = stalledDelegation || subStatus !== "completed";

          recordDelegationAuditEvent(ctx, {
            type: subFailed ? "owner-mismatch" : "handoff-complete",
            eventType: subFailed ? "owner-mismatch" : "handoff-complete",
            status: subStatus,
            taskId: taskIdForDelegate || null,
            taskTitle: taskTitleForDelegate || null,
            sessionId: childSessionId,
            parentSessionId: taskSessionId,
            rootSessionId: delegationLineage.rootSessionId || taskSessionId,
            workflowNodeId: node.id,
            delegatedWorkflowId: candidate.id,
            delegatedWorkflowName: candidate.name || candidate.id,
            childRunId: subRun?.id || null,
            transitionKey: [subFailed ? "owner-mismatch" : "handoff-complete", node.id, subRun?.id || candidate.id].join(":"),
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
          if (tracker && taskIdForDelegate) {
            tracker.recordEvent(taskSessionId, {
              role: "assistant",
              type: "agent_message",
              content: `Delegated workflow "${candidate.name || candidate.id}" completed with status=${subStatus}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.recordEvent(childSessionId, {
              role: subFailed ? "system" : "assistant",
              type: subFailed ? "error" : "agent_message",
              content: `Agent workflow "${candidate.name || candidate.id}" completed with status=${subStatus}`,
              timestamp: new Date().toISOString(),
              _sessionType: "delegate",
            });
            tracker.endSession(childSessionId, subStatus);
            if (taskSessionId === taskIdForDelegate) {
              tracker.endSession(taskSessionId, subStatus);
            }
          }
          await syncTaskDelegationTopology(
            taskIdForDelegate,
            {
              workflowId: candidate.id,
              workflowName: candidate.name || candidate.id,
              latestNodeId: node.id,
              latestRunId: String(subRun?.id || subRun?.runId || "").trim() || null,
              rootRunId: delegationLineage.rootRunId || ctx.id || null,
              parentRunId: ctx.id || null,
              latestSessionId: childSessionId,
              sessionId: childSessionId,
              rootSessionId: delegationLineage.rootSessionId || taskSessionId,
              parentSessionId: taskSessionId,
              rootTaskId: delegationLineage.rootTaskId || taskIdForDelegate || null,
              parentTaskId: taskIdForDelegate || delegationLineage.parentTaskId || null,
              delegationDepth: delegationLineage.delegationDepth + 1,
            },
            subRun?.id || subRun?.runId
              ? {
                  runId: String(subRun?.id || subRun?.runId || "").trim(),
                  workflowId: candidate.id,
                  workflowName: candidate.name || candidate.id,
                  nodeId: node.id,
                  status: subStatus,
                  outcome: subFailed ? "failed" : "completed",
                  summary: subTerminalOutput?.summary || null,
                  rootRunId: delegationLineage.rootRunId || ctx.id || null,
                  parentRunId: ctx.id || null,
                  taskId: taskIdForDelegate || null,
                  rootTaskId: delegationLineage.rootTaskId || taskIdForDelegate || null,
                  parentTaskId: taskIdForDelegate || delegationLineage.parentTaskId || null,
                  sessionId: childSessionId,
                  rootSessionId: delegationLineage.rootSessionId || taskSessionId,
                  parentSessionId: taskSessionId,
                  delegationDepth: delegationLineage.delegationDepth + 1,
                }
              : null,
          );

          const delegateResult = {
            success: !subFailed,
            delegated: true,
            childSessionId,
            subWorkflowId: candidate.id,
            subWorkflowName: candidate.name || candidate.id,
            subStatus,
            blockedReason: subBlockedReason,
            implementationState: subImplementationState,
            terminalOutput: subTerminalOutput,
            subRun,
            watchdogRecovered,
            recoveredFromStall: watchdogRecovered && !stalledDelegation,
            watchdogRetryCount,
            failureKind: stalledDelegation ? "stalled_delegation" : undefined,
            retryable: stalledDelegation ? true : undefined,
            runId: subRun?.id || null,
          };
          setDelegationTransitionResult(ctx, assignTransitionKey, {
            type: "run_agent_delegate",
            result: { ...delegateResult },
            childRunId: subRun?.id || null,
            delegatedWorkflowId: candidate.id,
          });
          return delegateResult;
        }
      }
    }

    // Use the engine's service injection to call agent pool
    const agentPool = engine.services?.agentPool;
    if (agentPool?.launchEphemeralThread) {
      const delegatedTaskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.task?.id || ctx.data?.taskId || null;
      const assignTransitionKey = buildDelegationTransitionKey("assign", [delegatedTaskId, node.id, cwd, sdk, model]);
      recordDelegationAuditEvent(ctx, {
        type: "assign",
        taskId: delegatedTaskId,
        nodeId: node.id,
        agentProfile: node.config?.agentProfile || null,
        sdk,
        model,
        transitionKey: assignTransitionKey,
        idempotencyKey: assignTransitionKey,
      });
      const parseCandidateCount = (value) => {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        return Math.max(1, Math.min(12, Math.trunc(num)));
      };
      let configuredCandidateCount = (() => {
        const taskMeta = ctx.data?.task?.meta || {};
        const execution = taskMeta?.execution || {};
        const dataExecution = ctx.data?.execution || ctx.data?.meta?.execution || {};
        const candidates = [
          node.config?.candidateCount,
          ctx.data?.candidateCount,
          ctx.data?.task?.candidateCount,
          ctx.data?.meta?.candidateCount,
          dataExecution?.candidateCount,
          ctx.data?.workflow?.candidateCount,
          execution?.candidateCount,
          taskMeta?.candidateCount,
          taskMeta?.swebench?.candidate_count,
        ];
        for (const candidate of candidates) {
          const parsed = parseCandidateCount(candidate);
          if (parsed && parsed > 0) return parsed;
        }
        return 1;
      })();
      if (configuredCandidateCount <= 1) {
        const taskIdForLookup = String(
          ctx.data?.taskId ||
            ctx.data?.task?.id ||
            ctx.resolve(node.config?.taskId || "") ||
            "",
        ).trim();
        const kanban = engine?.services?.kanban;
        if (taskIdForLookup && kanban && typeof kanban.getTask === "function") {
          try {
            const task = await kanban.getTask(taskIdForLookup);
            const taskMeta = task?.meta || {};
            const execution = taskMeta?.execution || {};
            const lookedUp = [
              task?.candidateCount,
              taskMeta?.candidateCount,
              execution?.candidateCount,
              taskMeta?.swebench?.candidate_count,
            ]
              .map((value) => parseCandidateCount(value))
              .find((value) => Number.isFinite(value) && value > 0);
            if (lookedUp && lookedUp > configuredCandidateCount) {
              configuredCandidateCount = lookedUp;
            }
          } catch {
            // best-effort lookup only
          }
        }
      }
      const selectorMode = String(
        ctx.resolve(node.config?.candidateSelector || "score") || "score",
      ).trim().toLowerCase();
      const candidatePromptTemplate = String(
        ctx.resolve(node.config?.candidatePromptTemplate || "") || "",
      ).trim();
      const runSinglePass = async (passPrompt, options = {}) => {
        const passLabel = String(options.passLabel || "").trim();
        const persistSession = options.persistSession !== false;
        let streamEventCount = 0;
        let lastStreamLog = "";
        const streamLines = [];
        const startedAt = Date.now();
        const resolvedSessionId = String(
          ctx.resolve(
            options.sessionId ??
              node.config?.sessionId ??
              ctx.data?.sessionId ??
              ctx.data?.threadId ??
              "",
          ) || "",
        ).trim();
        const sessionId = resolvedSessionId || null;
        const storedSessionOwnerNodeId = String(ctx.data?._agentSessionNodeId || "").trim() || null;
        const hasExplicitSessionOverride =
          options.sessionId != null
          || node.config?.sessionId != null
          || (sessionId && !storedSessionOwnerNodeId);
        const canContinueStoredSession =
          !!sessionId && (hasExplicitSessionOverride || storedSessionOwnerNodeId === node.id);
        const explicitTaskKey = String(ctx.resolve(node.config?.taskKey || "") || "").trim();
        const fallbackTaskKey = `${ctx.data?._workflowId || "workflow"}:${ctx.id}:${node.id}`;
        const recoveryTaskKey = options.taskKey || explicitTaskKey || fallbackTaskKey;
        const taskLineage = resolveWorkflowDelegationLineage(ctx, {
          taskId: trackedTaskId,
        });
        const taskSessionId = trackedTaskId
          ? (taskLineage.parentSessionId || trackedTaskId)
          : null;
        const childSessionId = trackedTaskId
          ? buildDelegatedSessionId(
              ctx,
              node.id,
              recoveryTaskKey || passLabel || "agent",
              trackedTaskId || taskLineage.rootTaskId || "",
            )
          : null;
        const autoRecover = options.autoRecover ?? (node.config?.autoRecover !== false);
        const continueOnSession =
          options.continueOnSession ?? (node.config?.continueOnSession !== false);
        const continuePrompt = ctx.resolve(
          node.config?.continuePrompt ||
            "Continue exactly where you left off. Resume execution from the last incomplete step, avoid redoing completed work, and finish the task end-to-end.",
        );
        const parsedSessionRetries = Number(ctx.resolve(node.config?.sessionRetries ?? 2));
        const parsedMaxContinues = Number(ctx.resolve(node.config?.maxContinues ?? 2));
        const sessionRetries = Number.isFinite(parsedSessionRetries)
          ? Math.max(0, Math.min(10, Math.floor(parsedSessionRetries)))
          : 2;
        const maxContinues = Number.isFinite(parsedMaxContinues)
          ? Math.max(0, Math.min(10, Math.floor(parsedMaxContinues)))
          : 2;
        const sdkOverride = sdk === "auto" ? undefined : sdk;
        const resolvedModelOverride = String(ctx.resolve(node.config?.model || "") || "").trim();
        const modelOverride =
          resolvedModelOverride && !/^\{\{.+\}\}$/.test(resolvedModelOverride)
            ? resolvedModelOverride
            : undefined;
        const resolvedMaxRetainedEvents = Number(ctx.resolve(node.config?.maxRetainedEvents));
        const maxRetainedEvents = Number.isFinite(resolvedMaxRetainedEvents)
          ? Math.max(10, Math.min(500, Math.trunc(resolvedMaxRetainedEvents)))
          : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
        const tracker = trackedTaskId ? getSessionTracker() : null;
        const trackedSessionType = trackedTaskId ? "task" : "flow";
        const assignTransitionKey =
          trackedTaskId
            ? (
                String(ctx.data?._delegationTransitionKey || "").trim() ||
                ["assign", node.id, recoveryTaskKey || "session", trackedTaskId].join(":")
              )
            : "";
        const agentExecutionLedgerRef = buildNodeExecutionLedgerRef(
          ctx,
          node,
          "agent",
          [sdkOverride || sdk || "auto"],
          node.label || node.id,
        );

        if (tracker && trackedTaskId) {
          ensureTrackedSession(tracker, taskSessionId, {
            ctx,
            cwd,
            title: trackedTaskTitle || taskSessionId,
            taskId: trackedTaskId,
            type: "task",
            lineage: {
              ...taskLineage,
              parentSessionId: taskSessionId,
              rootSessionId: taskLineage.rootSessionId || taskSessionId,
            },
            extra: {
              sourceNodeId: node.id,
              taskSessionId,
            },
          });
          ensureTrackedSession(tracker, childSessionId, {
            ctx,
            cwd,
            title: `${node.label || node.id} for ${trackedTaskTitle || trackedTaskId}`,
            taskId: trackedTaskId,
            type: "delegate",
            lineage: {
              ...taskLineage,
              parentTaskId: trackedTaskId || taskLineage.parentTaskId,
              parentSessionId: taskSessionId,
              rootSessionId: taskLineage.rootSessionId || taskSessionId,
              parentRunId: ctx.id,
              rootRunId: taskLineage.rootRunId || ctx.id,
              delegationDepth: taskLineage.delegationDepth + 1,
            },
            extra: {
              sourceNodeId: node.id,
              taskSessionId,
            },
          });
          tracker.recordEvent(taskSessionId, {
            role: "system",
            type: "system",
            content: `Workflow agent run started in ${cwd}`,
            timestamp: new Date().toISOString(),
            _sessionType: trackedSessionType,
          });
          tracker.recordEvent(childSessionId, {
            role: "system",
            type: "system",
            content: `Delegated agent node "${node.label || node.id}" started`,
            timestamp: new Date().toISOString(),
            _sessionType: "delegate",
          });
          rememberWorkflowDelegationSession(ctx, childSessionId);
        }
        if (trackedTaskId) {
          recordDelegationAuditEvent(ctx, {
            type: "assign",
            eventType: "assign",
            taskId: trackedTaskId,
            taskTitle: trackedTaskTitle || null,
            sessionId: childSessionId,
            parentSessionId: taskSessionId,
            rootSessionId: taskLineage.rootSessionId || taskSessionId,
            workflowNodeId: node.id,
            threadKey: recoveryTaskKey,
            transitionKey: assignTransitionKey,
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
        }

        const launchExtra = {};
        if (sessionId) launchExtra.resumeThreadId = sessionId;
        if (sdkOverride) launchExtra.sdk = sdkOverride;
        if (modelOverride) launchExtra.model = modelOverride;
        if (selectedMcpServers !== undefined) launchExtra.mcpServers = selectedMcpServers;
        const slotOwnerKey = `${recoveryTaskKey}:${node.id}`;
        const slotMeta = {
          taskKey: recoveryTaskKey,
          taskId: trackedTaskId || null,
          taskTitle: trackedTaskTitle || null,
          workflowRunId: String(ctx.id || "").trim() || null,
          workflowId: String(ctx.data?._workflowId || "").trim() || null,
          workflowName: String(ctx.data?._workflowName || ctx.data?._workflowId || "").trim() || null,
          workflowNodeId: node.id,
          workflowNodeLabel: String(node.label || node.id || "").trim() || null,
          cwd,
          sdk: sdkOverride || null,
          model: modelOverride || null,
          sessionType: trackedSessionType,
        };
        let slotWaitAnnounced = false;
        launchExtra.slotOwnerKey = slotOwnerKey;
        launchExtra.slotMeta = slotMeta;
        launchExtra.onSlotQueued = (slotState) => {
          slotWaitAnnounced = true;
          if (typeof ctx.setNodeStatus === "function") {
            ctx.setNodeStatus(node.id, "waiting");
          }
          const queueDepth = Math.max(
            1,
            Number(slotState?.queueDepth ?? slotState?.queuedSlots ?? 0),
          );
          const maxParallel = Math.max(1, Number(slotState?.maxParallel || 1));
          const activeSlots = Math.max(0, Number(slotState?.activeSlots || maxParallel));
          ctx.log(
            node.id,
            `${passLabel || "Agent"} waiting for shared agent slot (${activeSlots}/${maxParallel} active, queue=${queueDepth})`,
          );
        };
        launchExtra.onSlotAcquired = (slotState) => {
          if (typeof ctx.setNodeStatus === "function") {
            ctx.setNodeStatus(node.id, "running");
          }
          const waitedMs = Math.max(0, Number(slotState?.waitedMs || 0));
          if (slotWaitAnnounced || waitedMs > 0) {
            ctx.log(
              node.id,
              `${passLabel || "Agent"} acquired shared agent slot after ${Math.max(1, Math.round(waitedMs / 1000))}s`,
            );
          }
        };
        launchExtra.onEvent = (event) => {
          try {
            if (tracker && childSessionId) {
              tracker.recordEvent(childSessionId, {
                ...(event && typeof event === "object" ? event : { content: String(event || "") }),
                _sessionType: "delegate",
              });
            }
            const line = summarizeAgentStreamEvent(event);
            if (!line || line === lastStreamLog) return;
            lastStreamLog = line;
            streamEventCount += 1;
            if (streamLines.length >= maxRetainedEvents) {
              streamLines.shift();
            }
            streamLines.push(line);
            ctx.log(node.id, passLabel ? `${passLabel} ${line}` : line);
          } catch {
            // Stream callbacks must never crash workflow execution.
          }
        };

        const heartbeat = setInterval(() => {
          const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          ctx.log(node.id, `${passLabel || "Agent"} still running (${elapsedSec}s elapsed)`);
        }, WORKFLOW_AGENT_HEARTBEAT_MS);

        recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
          eventType: "agent.started",
          ...agentExecutionLedgerRef,
          sessionId: childSessionId,
          parentSessionId: taskSessionId,
          rootSessionId: taskLineage.rootSessionId || taskSessionId,
          taskId: trackedTaskId || null,
          parentTaskId: trackedTaskId || taskLineage.parentTaskId || null,
          rootTaskId: taskLineage.rootTaskId || trackedTaskId || null,
          delegationDepth: trackedTaskId ? taskLineage.delegationDepth + 1 : 0,
          status: "running",
          meta: {
            sdk: sdkOverride || sdk || null,
            sessionId,
            taskKey: recoveryTaskKey,
            sessionType: trackedSessionType,
          },
        }));
        let result = null;
        let success = false;
        const executeAgentPass = async (taskSpan = null) => {
          result = await traceAgentSession(
            {
              sessionId: sessionId || recoveryTaskKey || null,
              sdk: sdkOverride || sdk || null,
              threadKey: recoveryTaskKey,
              workflowId: ctx.data?._workflowId || null,
              workflowRunId: ctx.id,
              taskId: trackedTaskId || null,
              agentId: agentProfileId || node.id,
            },
            async (span) => {
              let tracedResult = null;
              if (
                autoRecover &&
                continueOnSession &&
                canContinueStoredSession &&
                typeof agentPool.continueSession === "function"
              ) {
                ctx.log(node.id, `${passLabel} Recovery: continuing existing session ${sessionId}`.trim());
                try {
                  recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                    eventType: "recovery.attempted",
                    ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["continue-session", sessionId || "session"], "continue-session"),
                    status: "running",
                    attempt: 1,
                    meta: { strategy: "continue_session", sessionId, taskKey: recoveryTaskKey },
                  }));
                tracedResult = await agentPool.continueSession(sessionId, continuePrompt, {
                  timeout: timeoutMs,
                  cwd,
                  sdk: sdkOverride,
                  model: modelOverride,
                  slotOwnerKey,
                  slotMeta,
                  onSlotQueued: launchExtra.onSlotQueued,
                  onSlotAcquired: launchExtra.onSlotAcquired,
                });
                  if (tracedResult?.success) {
                    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                      eventType: "recovery.succeeded",
                      ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["continue-session", sessionId || "session"], "continue-session"),
                      status: "completed",
                      attempt: 1,
                      meta: { strategy: "continue_session", sessionId, taskKey: recoveryTaskKey },
                    }));
                    ctx.log(node.id, `${passLabel} Recovery: continue-session succeeded`.trim());
                  } else {
                    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                      eventType: "recovery.failed",
                      ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["continue-session", sessionId || "session"], "continue-session"),
                      status: "failed",
                      attempt: 1,
                      error: tracedResult?.error || "unknown error",
                      meta: { strategy: "continue_session", sessionId, taskKey: recoveryTaskKey },
                    }));
                    ctx.log(
                      node.id,
                      `${passLabel} Recovery: continue-session failed (${tracedResult?.error || "unknown error"})`.trim(),
                      "warn",
                    );
                    tracedResult = null;
                  }
                } catch (err) {
                  recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                    eventType: "recovery.failed",
                    ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["continue-session", sessionId || "session"], "continue-session"),
                    status: "failed",
                    attempt: 1,
                    error: err?.message || String(err),
                    meta: { strategy: "continue_session", sessionId, taskKey: recoveryTaskKey },
                  }));
                  ctx.log(
                    node.id,
                    `${passLabel} Recovery: continue-session threw (${err?.message || err})`.trim(),
                    "warn",
                  );
                  tracedResult = null;
                }
              }

              if (!tracedResult && autoRecover && typeof agentPool.execWithRetry === "function") {
                ctx.log(
                  node.id,
                  `${passLabel} Recovery: execWithRetry taskKey=${recoveryTaskKey} retries=${sessionRetries} continues=${maxContinues}`.trim(),
                );
                recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                  eventType: "recovery.attempted",
                  ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["exec-with-retry", recoveryTaskKey], "execWithRetry"),
                  status: "running",
                  attempt: 1,
                  meta: { strategy: "exec_with_retry", taskKey: recoveryTaskKey, maxRetries: sessionRetries, maxContinues },
                }));
                tracedResult = await agentPool.execWithRetry(passPrompt, {
                  taskKey: recoveryTaskKey,
                  cwd,
                  timeoutMs,
                  maxRetries: sessionRetries,
                  maxContinues,
                  sessionType: trackedSessionType,
                  sdk: sdkOverride,
                  model: modelOverride,
                  mcpServers: selectedMcpServers,
                  onEvent: launchExtra.onEvent,
                  systemPrompt: effectiveSystemPrompt,
                  slotOwnerKey,
                  slotMeta,
                  onSlotQueued: launchExtra.onSlotQueued,
                  onSlotAcquired: launchExtra.onSlotAcquired,
                });
              }

              if (!tracedResult && autoRecover && typeof agentPool.launchOrResumeThread === "function") {
                ctx.log(node.id, `${passLabel} Recovery: launchOrResumeThread taskKey=${recoveryTaskKey}`.trim());
                recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                  eventType: "recovery.attempted",
                  ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["launch-or-resume", recoveryTaskKey], "launchOrResumeThread"),
                  status: "running",
                  attempt: 1,
                  meta: { strategy: "launch_or_resume_thread", taskKey: recoveryTaskKey },
                }));
                tracedResult = await agentPool.launchOrResumeThread(passPrompt, cwd, timeoutMs, {
                  taskKey: recoveryTaskKey,
                  sessionType: trackedSessionType,
                  sdk: sdkOverride,
                  model: modelOverride,
                  mcpServers: selectedMcpServers,
                  onEvent: launchExtra.onEvent,
                  systemPrompt: effectiveSystemPrompt,
                  slotOwnerKey,
                  slotMeta,
                  onSlotQueued: launchExtra.onSlotQueued,
                  onSlotAcquired: launchExtra.onSlotAcquired,
                });
              }

              if (!tracedResult) {
                recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
                  eventType: "recovery.attempted",
                  ...buildNodeExecutionLedgerRef(ctx, node, "recovery", ["launch-ephemeral", recoveryTaskKey], "launchEphemeralThread"),
                  status: "running",
                  attempt: 1,
                  meta: { strategy: "launch_ephemeral_thread", taskKey: recoveryTaskKey },
                }));
                tracedResult = await agentPool.launchEphemeralThread(passPrompt, cwd, timeoutMs, {
                  ...launchExtra,
                  systemPrompt: effectiveSystemPrompt,
                  slotOwnerKey,
                  slotMeta,
                  onSlotQueued: launchExtra.onSlotQueued,
                  onSlotAcquired: launchExtra.onSlotAcquired,
                });
              }
              const resolvedThreadId = tracedResult?.threadId || tracedResult?.sessionId || sessionId || null;
              if (resolvedThreadId) {
                span.attributes["bosun.session.id"] = resolvedThreadId;
                if (taskSpan) taskSpan.attributes["bosun.session.id"] = resolvedThreadId;
                const handoffTransitionKey = buildDelegationTransitionKey("handoff-complete", [delegatedTaskId, node.id, resolvedThreadId]);
                recordDelegationAuditEvent(ctx, {
                  type: "handoff-complete",
                  taskId: delegatedTaskId,
                  nodeId: node.id,
                  sessionId: childSessionId || resolvedThreadId,
                  parentSessionId: taskSessionId,
                  rootSessionId: taskLineage.rootSessionId || taskSessionId,
                  threadId: resolvedThreadId,
                  sdk,
                  model,
                  transitionKey: handoffTransitionKey,
                  idempotencyKey: handoffTransitionKey,
                });
              }
              return tracedResult;
            },
          );
          success = result?.success === true;
          if (result) {
            const strategy = result?.attempts || result?.continues || result?.resumed
              ? "exec_with_retry"
              : (sessionId ? "continue_or_resume" : "launch_ephemeral_thread");
            recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
              eventType: success ? "recovery.succeeded" : "recovery.failed",
              ...buildNodeExecutionLedgerRef(ctx, node, "recovery", [strategy, recoveryTaskKey], strategy),
              status: success ? "completed" : "failed",
              attempt: Number(result?.attempts || 1),
              error: success ? null : (result?.error || null),
              meta: {
                strategy,
                taskKey: recoveryTaskKey,
                threadId: result?.threadId || result?.sessionId || null,
                resumed: result?.resumed === true,
              },
            }));
          }
        };

        try {
          if (trackedTaskId) {
            await traceTaskExecution(
              {
                taskId: trackedTaskId,
                title: trackedTaskTitle || null,
                priority: ctx.data?.task?.priority || ctx.data?.taskDetail?.priority || null,
                assignee: ctx.data?.task?.assignee || ctx.data?.taskDetail?.assignee || agentProfileId || null,
                workflowId: ctx.data?._workflowId || null,
                workflowRunId: ctx.id,
                rootRunId: ctx.data?._workflowRootRunId || ctx.id,
                parentRunId: ctx.data?._workflowParentRunId || null,
                agentId: agentProfileId || node.id,
                sdk: sdkOverride || sdk || null,
                model: modelOverride || null,
                branch: String(
                  ctx.data?.branch ||
                    ctx.data?.task?.branch ||
                    ctx.data?.task?.branchName ||
                    ctx.data?.taskDetail?.branch ||
                    ctx.data?.taskDetail?.branchName ||
                    ""
                ).trim() || null,
              },
              async (taskSpan) => executeAgentPass(taskSpan),
            );
          } else {
            await executeAgentPass(null);
          }
        } finally {
          clearInterval(heartbeat);
        }
        ctx.log(node.id, `${passLabel || "Agent"} completed: success=${success} streamEvents=${streamEventCount}`);

        if (tracker && trackedTaskId) {
          if (streamEventCount === 0) {
            const fallbackContent = success
              ? String(result?.output || result?.message || "Agent run completed.").trim()
              : String(result?.error || "Agent run failed.").trim();
            if (fallbackContent) {
              tracker.recordEvent(childSessionId, {
                role: success ? "assistant" : "system",
                type: success ? "agent_message" : "error",
                content: fallbackContent,
                timestamp: new Date().toISOString(),
                _sessionType: "delegate",
              });
            }
          }
        }

        const threadId = result?.threadId || result?.sessionId || sessionId || null;
        if (trackedTaskId) {
          const terminalSessionStatus = success
            ? resolveSuccessfulWorkflowAgentSessionStatus(result)
            : deriveWorkflowAgentSessionStatus(result, { streamEventCount });
          const childSessionMessages = tracker?.getSessionById(childSessionId)?.messages || [];
          const visibleCompletionContent =
            pickLatestMeaningfulSessionMessage(childSessionMessages) ||
            String(result?.output || result?.message || "").trim();
          recordDelegationAuditEvent(ctx, {
            type: success ? "handoff-complete" : "owner-mismatch",
            eventType: success ? "handoff-complete" : "owner-mismatch",
            taskId: trackedTaskId,
            taskTitle: trackedTaskTitle || null,
            sessionId: childSessionId,
            parentSessionId: taskSessionId,
            rootSessionId: taskLineage.rootSessionId || taskSessionId,
            workflowNodeId: node.id,
            threadId,
            threadKey: recoveryTaskKey,
            transitionKey: success
              ? `${assignTransitionKey}:handoff`
              : `${assignTransitionKey}:failed`,
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
          tracker?.recordEvent(taskSessionId, {
            role: "assistant",
            type: "agent_message",
            content:
              visibleCompletionContent ||
              `Workflow agent node "${node.label || node.id}" completed with status=${terminalSessionStatus}`,
            timestamp: new Date().toISOString(),
            _sessionType: trackedSessionType,
          });
          tracker?.endSession(childSessionId, terminalSessionStatus);
          if (taskSessionId === trackedTaskId) {
            tracker?.endSession(taskSessionId, terminalSessionStatus);
          }
          await syncTaskDelegationTopology(trackedTaskId, {
            workflowId: ctx.data?._workflowId || null,
            workflowName: ctx.data?._workflowName || ctx.data?._workflowId || null,
            latestNodeId: node.id,
            latestRunId: ctx.id || null,
            rootRunId: taskLineage.rootRunId || ctx.id || null,
            parentRunId: taskLineage.parentRunId || null,
            latestSessionId: childSessionId,
            sessionId: childSessionId,
            rootSessionId: taskLineage.rootSessionId || taskSessionId,
            parentSessionId: taskSessionId,
            rootTaskId: taskLineage.rootTaskId || trackedTaskId || null,
            parentTaskId: trackedTaskId || taskLineage.parentTaskId || null,
            delegationDepth: taskLineage.delegationDepth + 1,
          });
        }
        if (persistSession && threadId) {
          ctx.data.sessionId = threadId;
          ctx.data.threadId = threadId;
          ctx.data._agentSessionNodeId = node.id;
          ctx.data._agentSessionTaskKey = recoveryTaskKey;
        }
        const digest = buildAgentExecutionDigest(result, streamLines, maxRetainedEvents);
        recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
          eventType: success ? "agent.completed" : "agent.failed",
          ...agentExecutionLedgerRef,
          sessionId: childSessionId,
          parentSessionId: taskSessionId,
          rootSessionId: taskLineage.rootSessionId || taskSessionId,
          taskId: trackedTaskId || null,
          parentTaskId: trackedTaskId || taskLineage.parentTaskId || null,
          rootTaskId: taskLineage.rootTaskId || trackedTaskId || null,
          delegationDepth: trackedTaskId ? taskLineage.delegationDepth + 1 : 0,
          status: success ? "completed" : "failed",
          durationMs: Date.now() - startedAt,
          error: success ? null : (result?.error || null),
          summary: digest.summary || null,
          meta: {
            sdk: result?.sdk || sdkOverride || sdk || null,
            threadId: result?.threadId || result?.sessionId || sessionId || null,
            resumed: result?.resumed === true,
            attempts: result?.attempts,
            continues: result?.continues,
            itemCount: digest.itemCount,
          },
        }));

        if (!success) {
          return {
            success: false,
            error:
              result?.error ||
              `Agent execution failed in node "${node.label || node.id}"`,
            output: result?.output,
            sdk: result?.sdk,
            items: result?.items,
            threadId,
            sessionId: threadId,
            childSessionId,
            attempts: result?.attempts,
            continues: result?.continues,
            resumed: result?.resumed,
            summary: digest.summary,
            narrative: digest.narrative,
            thoughts: digest.thoughts,
            stream: digest.stream,
            itemCount: digest.itemCount,
            omittedItemCount: digest.omittedItemCount,
          };
        }
        return {
          success: true,
          output: result?.output,
          summary: digest.summary,
          narrative: digest.narrative,
          thoughts: digest.thoughts,
          stream: digest.stream,
          sdk: result?.sdk,
          items: digest.items,
          itemCount: digest.itemCount,
          omittedItemCount: digest.omittedItemCount,
          threadId,
          sessionId: threadId,
          childSessionId,
          attempts: result?.attempts,
          continues: result?.continues,
          resumed: result?.resumed,
        };
      };

      if (configuredCandidateCount <= 1) {
        const singleResult = await runSinglePass(finalPrompt, { persistSession: true });
        if (!singleResult.success && node.config?.failOnError) {
          throw new Error(singleResult.error || "Agent execution failed");
        }
        return singleResult;
      }

      const repoGitReady = (() => {
        try {
          execSync("git rev-parse --is-inside-work-tree", {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (!repoGitReady) {
        ctx.log(
          node.id,
          `candidateCount=${configuredCandidateCount} requested but cwd is not a git repo. Falling back to single-pass.`,
          "warn",
        );
        const fallbackResult = await runSinglePass(finalPrompt, { persistSession: true });
        if (!fallbackResult.success && node.config?.failOnError) {
          throw new Error(fallbackResult.error || "Agent execution failed");
        }
        return fallbackResult;
      }

      const originalSessionId = ctx.data?.sessionId || null;
      const originalThreadId = ctx.data?.threadId || null;
      const safeBranchPart = (value) =>
        String(value || "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9._/-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "candidate";
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      const baselineHead = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }).trim();
      const batchToken = randomUUID().slice(0, 8);
      const candidateRuns = [];

      try {
        for (let idx = 1; idx <= configuredCandidateCount; idx += 1) {
          const candidateBranch =
            `${safeBranchPart(currentBranch)}-cand-${idx}-${batchToken}`.slice(0, 120);
          execSync(`git checkout -B "${candidateBranch}" "${baselineHead}"`, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 20000,
          });
          const suffix = candidatePromptTemplate
            ? candidatePromptTemplate
                .replace(/\{\{\s*candidateIndex\s*\}\}/g, String(idx))
                .replace(/\{\{\s*candidateCount\s*\}\}/g, String(configuredCandidateCount))
            : [
                "",
                `### Candidate Strategy ${idx}/${configuredCandidateCount}`,
                "You are one candidate solution in a multi-candidate selection workflow.",
                "Provide an end-to-end fix with clear verification; do not reference other candidates.",
              ].join("\n");
          const candidatePrompt = `${finalPrompt}\n${suffix}`;
          ctx.log(node.id, `Candidate ${idx}/${configuredCandidateCount}: running on branch ${candidateBranch}`);
          const run = await runSinglePass(candidatePrompt, {
            persistSession: false,
            autoRecover: false,
            continueOnSession: false,
            sessionId: null,
            taskKey: `${ctx.data?._workflowId || "workflow"}:${ctx.id}:${node.id}:candidate:${idx}`,
            passLabel: `[candidate ${idx}/${configuredCandidateCount}]`,
          });
          const postHead = execSync("git rev-parse HEAD", {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          }).trim();
          const hasCommit = Boolean(postHead && baselineHead && postHead !== baselineHead);
          const summaryLength = String(run?.summary || run?.output || "").trim().length;
          const scoreBase = run.success ? 100 : 0;
          const commitBonus = hasCommit ? 20 : 0;
          const outputBonus = Math.min(20, Math.trunc(summaryLength / 80));
          const score = scoreBase + commitBonus + outputBonus;
          candidateRuns.push({
            index: idx,
            branch: candidateBranch,
            head: postHead,
            hasCommit,
            score,
            ...run,
          });
        }
      } finally {
        if (originalSessionId) ctx.data.sessionId = originalSessionId;
        else delete ctx.data.sessionId;
        if (originalThreadId) ctx.data.threadId = originalThreadId;
        else delete ctx.data.threadId;
      }

      const selector = ["score", "first_success", "last_success"].includes(selectorMode)
        ? selectorMode
        : "score";
      const successfulCandidates = candidateRuns.filter((entry) => entry.success === true);
      let selected = null;
      if (selector === "first_success") {
        selected = successfulCandidates[0] || candidateRuns[0] || null;
      } else if (selector === "last_success") {
        selected =
          (successfulCandidates.length
            ? successfulCandidates[successfulCandidates.length - 1]
            : null) ||
          candidateRuns[candidateRuns.length - 1] ||
          null;
      } else {
        selected = [...candidateRuns].sort((a, b) => {
          if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
          if (Boolean(b.hasCommit) !== Boolean(a.hasCommit)) return b.hasCommit ? 1 : -1;
          return (a.index || 0) - (b.index || 0);
        })[0] || null;
      }

      if (!selected) {
        const err = "Candidate selection failed: no candidate results produced";
        if (node.config?.failOnError) throw new Error(err);
        return { success: false, error: err };
      }

      const selectedHead = selected.hasCommit ? selected.head : baselineHead;
      execSync(`git checkout -B "${currentBranch}" "${selectedHead}"`, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 20000,
      });
      for (const candidate of candidateRuns) {
        if (!candidate?.branch) continue;
        try {
          execSync(`git branch -D "${candidate.branch}"`, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 10000,
          });
        } catch {
          // best-effort cleanup only
        }
      }

      if (selected?.threadId) {
        ctx.data.sessionId = selected.threadId;
        ctx.data.threadId = selected.threadId;
      }
      const selectionSummary = {
        candidateCount: configuredCandidateCount,
        selector,
        selectedIndex: selected.index,
        selectedScore: selected.score,
        successfulCandidates: successfulCandidates.length,
        selectedHasCommit: selected.hasCommit,
      };
      ctx.data._agentCandidateSelection = selectionSummary;
      ctx.log(
        node.id,
        `Candidate selector chose #${selected.index}/${configuredCandidateCount} (strategy=${selector}, success=${successfulCandidates.length})`,
      );

      const response = {
        ...selected,
        candidateSelection: selectionSummary,
        candidates: candidateRuns.map((entry) => ({
          index: entry.index,
          success: entry.success === true,
          hasCommit: Boolean(entry.hasCommit),
          score: entry.score,
          summary: trimLogText(entry.summary || entry.output || "", 240),
          threadId: entry.threadId || null,
          error: entry.success ? null : trimLogText(entry.error || "", 180) || null,
        })),
      };
      if (!selected.success && node.config?.failOnError) {
        throw new Error(selected.error || "All candidates failed");
      }
      return response;
    }

    // Fallback: shell-based execution
    ctx.log(node.id, "Agent pool not available, using shell fallback");
    try {
      const output = execSync(
        `node -e "import('../agent/agent-pool.mjs').then(m => m.launchEphemeralThread(process.argv[1], process.argv[2], ${timeoutMs}).then(r => console.log(JSON.stringify(r))))" "${finalPrompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" "${cwd}"`,
        { cwd: resolve(dirname(new URL(import.meta.url).pathname)), timeout: timeoutMs + 30000, encoding: "utf8" }
      );
      const parsed = JSON.parse(output);
      if (node.config?.failOnError && parsed?.success === false) {
        throw new Error(trimLogText(parsed?.error || parsed?.output || "Agent reported failure", 400));
      }
      return parsed;
    } catch (err) {
      if (node.config?.failOnError) throw err;
      return { success: false, error: err.message };
    }
  },
});

registerBuiltinNodeType("action.run_command", {
  describe: () => "Execute a shell command in the workspace",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      args: {
        description: "Optional argv passed to the command without shell interpolation",
        oneOf: [
          { type: "array", items: { type: ["string", "number", "boolean"] } },
          { type: "string" },
        ],
      },
      cwd: { type: "string", description: "Working directory" },
      env: { type: "object", description: "Environment variables passed to the command (supports templates)", additionalProperties: true },
      timeoutMs: { type: "number", default: 300000 },
      shell: { type: "string", default: "auto", enum: ["auto", "bash", "pwsh", "cmd"] },
      commandType: {
        type: "string",
        enum: ["test", "build", "lint", "syntaxCheck", "qualityGate"],
        description: "Optional auto-resolution category when command is set to 'auto'",
      },
      captureOutput: { type: "boolean", default: true },
      parseJson: { type: "boolean", default: false, description: "Parse JSON output automatically" },
      failOnError: { type: "boolean", default: false, description: "Throw on non-zero exit status (enables workflow retries)" },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before running this command even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: ["command"],
  },
  async execute(node, ctx, engine) {
    const resolvedCommand = ctx.resolve(node.config?.command || "");
    const cwd = resolveWorkflowCwdValue(
      ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd()),
      ctx.data?.worktreePath || process.cwd(),
    );
    const commandType = typeof node.config?.commandType === "string" ? node.config.commandType.trim() : "";
    const autoCommandRoot = resolveWorkflowCwdValue(ctx.resolve(ctx.data?.repoRoot || cwd), cwd);
    const autoResolvedCommand = commandType
      ? resolveAutoCommand(String(resolvedCommand || ""), commandType, autoCommandRoot)
      : resolvedCommand;
    const command = normalizeLegacyWorkflowCommand(autoResolvedCommand);
    const resolvedEnvConfig = resolveWorkflowNodeValue(node.config?.env ?? {}, ctx);
    const commandEnv = applyResolvedWorkflowEnv(process.env, resolvedEnvConfig);

    const timeout = node.config?.timeoutMs || 300000;
    const resolvedArgsConfig = resolveWorkflowNodeValue(node.config?.args ?? [], ctx);
    const commandArgs = Array.isArray(resolvedArgsConfig)
      ? resolvedArgsConfig.map((value) => String(value))
      : typeof resolvedArgsConfig === "string" && resolvedArgsConfig.trim()
        ? [resolvedArgsConfig]
        : [];
    const shouldParseJson = node.config?.parseJson === true;
    const parseOutput = (rawOutput) => {
      const trimmed = rawOutput?.trim?.() ?? "";
      if (!shouldParseJson || !trimmed) return trimmed;
      try {
        return JSON.parse(trimmed);
      } catch {
        const lines = String(trimmed)
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const candidate = lines.length > 0 ? lines[lines.length - 1] : trimmed;
        try {
          return JSON.parse(candidate);
        } catch {
          return trimmed;
        }
      }
    };
    const usedArgv = commandArgs.length > 0;

    if (!command.trim()) {
      const reason =
        String(resolvedCommand || "").trim().toLowerCase() === "auto" && commandType
          ? `No ${commandType} command detected for ${autoCommandRoot || cwd}`
          : "No command configured";
      ctx.log(node.id, reason);
      return { success: false, output: "", stderr: "", exitCode: null, error: reason };
    }

    if (autoResolvedCommand !== resolvedCommand) {
      ctx.log(node.id, `Resolved auto ${commandType} command: ${autoResolvedCommand}`);
    }
    if (command !== autoResolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    const displayCommand = usedArgv ? `${command} ${commandArgs.join(" ")}`.trim() : command;
    ctx.log(node.id, `Running: ${displayCommand}`);
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.run_command",
      repoRoot: cwd,
      command,
      args: commandArgs,
    });
    const isolatedRun = await maybeRunWorkflowCommandInIsolation({
      node,
      ctx,
      engine,
      nodeType: "action.run_command",
      command,
      args: commandArgs,
      cwd,
      timeoutMs: timeout,
      env: commandEnv,
      commandType,
    });
    if (isolatedRun) {
      if (shouldParseJson) {
        const parsedOutput = parseOutput(isolatedRun.isolated?.stdout || isolatedRun.compacted.output || "");
        return {
          success: isolatedRun.isolated?.blocked !== true && Number(isolatedRun.isolated?.exitCode ?? 0) === 0,
          exitCode: isolatedRun.isolated?.exitCode ?? null,
          output: parsedOutput,
          ...isolatedRun.extras,
        };
      }
      const result = {
        success: isolatedRun.isolated?.blocked !== true && Number(isolatedRun.isolated?.exitCode ?? 0) === 0,
        exitCode: isolatedRun.isolated?.exitCode ?? null,
        blocked: isolatedRun.isolated?.blocked === true,
        error: isolatedRun.isolated?.error || null,
        ...isolatedRun.compacted,
        ...isolatedRun.extras,
      };
      if (node.config?.failOnError && !result.success) {
        throw new Error(trimLogText(result.output || result.error || "command failed", 400));
      }
      return result;
    }
    const startedAt = Date.now();
    try {
      const output = await spawnAsync(command, usedArgv ? commandArgs : [], {
        cwd,
        timeout,
        stdio: node.config?.captureOutput !== false ? "pipe" : "inherit",
        env: commandEnv,
        shell: !usedArgv,
      });
      ctx.log(node.id, `Command succeeded`);
      const parsedOutput = parseOutput(output);
      if (shouldParseJson || typeof parsedOutput !== "string") {
        return { success: true, output: parsedOutput, exitCode: 0 };
      }
      const compacted = await compactWorkflowCommandResult({
        command,
        args: commandArgs,
        output: parsedOutput,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      });
      return { success: true, exitCode: 0, ...compacted };
    } catch (err) {
      const output = err.stdout?.toString() || "";
      const stderr = err.stderr?.toString() || "";
      const compacted = await compactWorkflowCommandResult({
        command,
        args: commandArgs,
        output,
        stderr,
        exitCode: err.status,
        durationMs: Date.now() - startedAt,
      });
      const result = {
        success: false,
        exitCode: err.status,
        error: err.message,
        ...compacted,
      };
      if (node.config?.failOnError) {
        const reason = trimLogText(result.output || stderr || output || err.message, 400) || err.message;
        throw new Error(reason);
      }
      return result;
    }
  },
});

registerBuiltinNodeType("action.execute_workflow", {
  describe: () => "Execute another workflow by ID (synchronously or dispatch mode)",
  schema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Workflow ID to execute" },
      mode: { type: "string", enum: ["sync", "dispatch"], default: "sync" },
      input: {
        type: "object",
        description: "Input payload passed to the child workflow",
        additionalProperties: true,
      },
      triggerVars: {
        type: "object",
        description:
          "Custom variables forwarded as _triggerVars to the child workflow. " +
          "These are validated by the child's trigger.workflow_call node.",
        additionalProperties: true,
      },
      targetRepo: {
        type: "string",
        description:
          "Override the target repo for the child workflow. When omitted, " +
          "inherits the parent workflow's _targetRepo (if any).",
      },
      inheritContext: {
        type: "boolean",
        default: false,
        description: "Copy parent workflow context data into child input before applying input overrides",
      },
      includeKeys: {
        type: "array",
        items: { type: "string" },
        description: "Optional allow-list of context keys to inherit when inheritContext=true",
      },
      outputVariable: {
        type: "string",
        description: "Optional context key to store execution summary output",
      },
      failOnChildError: {
        type: "boolean",
        default: true,
        description: "In sync mode, throw when child workflow completes with errors",
      },
      allowRecursive: {
        type: "boolean",
        default: false,
        description: "Allow recursive workflow execution when true",
      },
    },
    required: ["workflowId"],
  },
  async execute(node, ctx, engine) {
    const workflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const modeRaw = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const mode = modeRaw || "sync";
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const inheritContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.inheritContext ?? false, ctx),
      false,
    );
    const failOnChildError = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnChildError ?? true, ctx),
      true,
    );
    const allowRecursive = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.allowRecursive ?? false, ctx),
      false,
    );
    const includeKeys = Array.isArray(node.config?.includeKeys)
      ? node.config.includeKeys
          .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
          .filter(Boolean)
      : [];

    if (!workflowId) {
      throw new Error("action.execute_workflow: 'workflowId' is required");
    }
    if (mode !== "sync" && mode !== "dispatch") {
      throw new Error(`action.execute_workflow: invalid mode "${mode}". Expected "sync" or "dispatch".`);
    }
    if (!engine || typeof engine.execute !== "function") {
      throw new Error("action.execute_workflow: workflow engine is not available");
    }
    if (typeof engine.get === "function" && !engine.get(workflowId)) {
      throw new Error(`action.execute_workflow: workflow "${workflowId}" not found`);
    }

    const resolvedInputConfig = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    if (
      resolvedInputConfig != null &&
      (typeof resolvedInputConfig !== "object" || Array.isArray(resolvedInputConfig))
    ) {
      throw new Error("action.execute_workflow: 'input' must resolve to an object");
    }
    const configuredInput =
      resolvedInputConfig && typeof resolvedInputConfig === "object"
        ? resolvedInputConfig
        : {};

    const sourceData =
      ctx.data && typeof ctx.data === "object"
        ? ctx.data
        : {};
    const inheritedInput = {};
    if (inheritContext) {
      if (includeKeys.length > 0) {
        for (const key of includeKeys) {
          if (Object.prototype.hasOwnProperty.call(sourceData, key)) {
            inheritedInput[key] = sourceData[key];
          }
        }
      } else {
        Object.assign(inheritedInput, sourceData);
      }
    }

    const parentWorkflowId = String(ctx.data?._workflowId || "").trim();
    const workflowStack = normalizeWorkflowStack(ctx.data?._workflowStack);
    if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
      workflowStack.push(parentWorkflowId);
    }
    if (!allowRecursive && workflowStack.includes(workflowId)) {
      const cyclePath = [...workflowStack, workflowId].join(" -> ");
      throw new Error(
        `action.execute_workflow: recursive workflow call blocked (${cyclePath}). ` +
          "Set allowRecursive=true to override.",
      );
    }

    const childInput = applyChildWorkflowLineage(ctx, {
      ...inheritedInput,
      ...configuredInput,
    }, workflowId);
    const childRunOpts = makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: workflowId, sourceNodeId: node.id });

    // Forward _triggerVars — explicit config takes precedence over inherited
    const triggerVarsConfig = resolveWorkflowNodeValue(node.config?.triggerVars ?? null, ctx);
    const parentTriggerVars = sourceData._triggerVars || {};
    if (triggerVarsConfig && typeof triggerVarsConfig === "object") {
      childInput._triggerVars = { ...parentTriggerVars, ...triggerVarsConfig };
    } else if (inheritContext && Object.keys(parentTriggerVars).length > 0) {
      childInput._triggerVars = parentTriggerVars;
    }

    // Forward _targetRepo — explicit config overrides parent
    const targetRepoConfig = String(ctx.resolve(node.config?.targetRepo || "") || "").trim();
    if (targetRepoConfig) {
      childInput._targetRepo = targetRepoConfig;
    } else if (sourceData._targetRepo && !childInput._targetRepo) {
      childInput._targetRepo = sourceData._targetRepo;
    }

    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching workflow "${workflowId}"`);
      let dispatched;
      try {
        dispatched = Promise.resolve(engine.execute(workflowId, childInput, childRunOpts));
      } catch (err) {
        dispatched = Promise.reject(err);
      }
      dispatched
        .then((childCtx) => {
          const status = childCtx?.errors?.length ? "failed" : "completed";
          ctx.log(node.id, `Dispatched workflow "${workflowId}" finished with status=${status}`);
        })
        .catch((err) => {
          ctx.log(node.id, `Dispatched workflow "${workflowId}" failed: ${err.message}`, "error");
        });

      const output = {
        success: true,
        queued: true,
        mode: "dispatch",
        workflowId,
        parentRunId: ctx.id,
        stackDepth: childInput._workflowStack.length,
      };
      if (outputVariable) {
        ctx.data[outputVariable] = output;
      }
      return output;
    }

    ctx.log(node.id, `Executing workflow "${workflowId}" (sync)`);
    const childCtx = await engine.execute(workflowId, childInput, childRunOpts);
    const childErrors = Array.isArray(childCtx?.errors)
      ? childCtx.errors.map((entry) => ({
          nodeId: entry?.nodeId || null,
          error: String(entry?.error || "unknown child workflow error"),
        }))
      : [];
    const status = childErrors.length > 0 ? "failed" : "completed";
    const output = {
      success: status === "completed",
      queued: false,
      mode: "sync",
      workflowId,
      runId: childCtx?.id || null,
      status,
      message: String(childCtx?.data?._workflowTerminalMessage || "").trim(),
      output: childCtx?.data?._workflowTerminalOutput,
      errorCount: childErrors.length,
      errors: childErrors,
    };

    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }

    if (status === "failed" && failOnChildError) {
      const reason = childErrors[0]?.error || "child workflow failed";
      const err = new Error(`action.execute_workflow: child workflow "${workflowId}" failed: ${reason}`);
      err.childWorkflow = output;
      throw err;
    }

    return output;
  },
});

registerBuiltinNodeType("action.inline_workflow", {
  describe: () =>
    "Execute an embedded workflow definition inline (sync or dispatch) without saving it. " +
    "Useful for parent workflows that need a local subgraph with its own run/context boundary.",
  schema: {
    type: "object",
    properties: {
      workflow: {
        type: "object",
        description:
          "Embedded workflow definition fragment. Supports { name, variables, nodes, edges, trigger, metadata }.",
        additionalProperties: true,
      },
      mode: { type: "string", enum: ["sync", "dispatch"], default: "sync" },
      input: {
        type: "object",
        description: "Input payload passed to the embedded workflow",
        additionalProperties: true,
      },
      inheritContext: {
        type: "boolean",
        default: false,
        description: "Copy parent workflow context data into child input before applying input overrides",
      },
      includeKeys: {
        type: "array",
        items: { type: "string" },
        description: "Optional allow-list of parent context keys to inherit when inheritContext=true",
      },
      outputVariable: {
        type: "string",
        description: "Optional context key to store execution summary output",
      },
      failOnChildError: {
        type: "boolean",
        default: true,
        description: "In sync mode, throw when the embedded workflow completes with errors",
      },
      forwardFields: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional allow-list of top-level fields from the embedded workflow's extracted outputs " +
          "to promote onto this node's output.",
      },
      extractFromNodes: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional child node IDs to extract outputs from. When omitted, the last completed " +
          "child node output is used.",
      },
      allowRecursive: {
        type: "boolean",
        default: false,
        description: "Allow recursive embedded workflow execution when true",
      },
    },
    required: ["workflow"],
  },
  async execute(node, ctx, engine) {
    const workflowDef = resolveWorkflowNodeValue(node.config?.workflow ?? null, ctx);
    const modeRaw = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const mode = modeRaw || "sync";
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const inheritContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.inheritContext ?? false, ctx),
      false,
    );
    const failOnChildError = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnChildError ?? true, ctx),
      true,
    );
    const allowRecursive = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.allowRecursive ?? false, ctx),
      false,
    );
    const includeKeys = Array.isArray(node.config?.includeKeys)
      ? node.config.includeKeys
          .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
          .filter(Boolean)
      : [];
    const forwardFields = Array.isArray(node.config?.forwardFields)
      ? node.config.forwardFields
          .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
          .filter(Boolean)
      : [];
    const extractFromNodes = Array.isArray(node.config?.extractFromNodes)
      ? node.config.extractFromNodes
          .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
          .filter(Boolean)
      : [];

    if (!workflowDef || typeof workflowDef !== "object" || Array.isArray(workflowDef)) {
      throw new Error("action.inline_workflow: 'workflow' must resolve to an object");
    }
    if (mode !== "sync" && mode !== "dispatch") {
      throw new Error(`action.inline_workflow: invalid mode "${mode}". Expected "sync" or "dispatch".`);
    }
    if (!engine || typeof engine.executeDefinition !== "function") {
      throw new Error("action.inline_workflow: workflow engine is not available");
    }

    const resolvedInputConfig = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    if (
      resolvedInputConfig != null &&
      (typeof resolvedInputConfig !== "object" || Array.isArray(resolvedInputConfig))
    ) {
      throw new Error("action.inline_workflow: 'input' must resolve to an object");
    }
    const configuredInput =
      resolvedInputConfig && typeof resolvedInputConfig === "object"
        ? resolvedInputConfig
        : {};

    const sourceData =
      ctx.data && typeof ctx.data === "object"
        ? ctx.data
        : {};
    const inheritedInput = {};
    if (inheritContext) {
      if (includeKeys.length > 0) {
        for (const key of includeKeys) {
          if (Object.prototype.hasOwnProperty.call(sourceData, key)) {
            inheritedInput[key] = sourceData[key];
          }
        }
      } else {
        Object.assign(inheritedInput, sourceData);
      }
    }

    const parentWorkflowId = String(ctx.data?._workflowId || "").trim() || "inline-parent";
    const workflowStack = normalizeWorkflowStack(ctx.data?._workflowStack);
    if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
      workflowStack.push(parentWorkflowId);
    }
    const inlineWorkflowId = String(workflowDef.id || `inline:${parentWorkflowId}:${node.id}`).trim();
    if (!allowRecursive && workflowStack.includes(inlineWorkflowId)) {
      const cyclePath = [...workflowStack, inlineWorkflowId].join(" -> ");
      throw new Error(
        `action.inline_workflow: recursive inline workflow call blocked (${cyclePath}). ` +
          "Set allowRecursive=true to override.",
      );
    }

    const childInput = applyChildWorkflowLineage(ctx, {
      ...inheritedInput,
      ...configuredInput,
    }, inlineWorkflowId, { parentWorkflowId });

    const inlineName = String(workflowDef.name || node.label || `Inline ${node.id}`).trim() || inlineWorkflowId;
    const executeInline = () => engine.executeDefinition({
      trigger: workflowDef.trigger || "trigger.workflow_call",
      ...workflowDef,
      id: inlineWorkflowId,
      name: inlineName,
      metadata: {
        ...(workflowDef.metadata || {}),
        inline: true,
        sourceNodeId: node.id,
        parentWorkflowId,
      },
    }, childInput, {
      ...makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: inlineWorkflowId, sourceNodeId: node.id }),
      force: true,
      sourceNodeId: node.id,
      inlineWorkflowId,
      inlineWorkflowName: inlineName,
    });

    const extractChildOutputs = (childCtx) => {
      const childOutputs = childCtx?.nodeOutputs instanceof Map
        ? Object.fromEntries(childCtx.nodeOutputs)
        : childCtx?.nodeOutputs && typeof childCtx.nodeOutputs === "object"
          ? { ...childCtx.nodeOutputs }
          : {};

      let extracted = {};
      if (extractFromNodes.length > 0) {
        for (const childNodeId of extractFromNodes) {
          if (Object.prototype.hasOwnProperty.call(childOutputs, childNodeId)) {
            extracted[childNodeId] = childOutputs[childNodeId];
          }
        }
        if (extractFromNodes.length === 1) {
          const single = extracted[extractFromNodes[0]];
          if (
            single &&
            typeof single === "object" &&
            single._workflowEnd === true &&
            single.output &&
            typeof single.output === "object" &&
            !Array.isArray(single.output)
          ) {
            extracted = { ...single.output };
          }
        }
      } else {
        const completedNodeIds = Array.from(childCtx?.nodeStatuses?.entries?.() || [])
          .filter(([, status]) => status === NodeStatus.COMPLETED)
          .map(([childNodeId]) => childNodeId);
        const lastCompletedNodeId = completedNodeIds[completedNodeIds.length - 1];
        if (lastCompletedNodeId && Object.prototype.hasOwnProperty.call(childOutputs, lastCompletedNodeId)) {
          const candidate = childOutputs[lastCompletedNodeId];
          if (
            candidate &&
            typeof candidate === "object" &&
            candidate._workflowEnd === true &&
            candidate.output &&
            typeof candidate.output === "object" &&
            !Array.isArray(candidate.output)
          ) {
            extracted = { ...candidate.output };
          } else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            extracted = { ...candidate };
          } else {
            extracted = { result: candidate };
          }
        }
      }

      if (forwardFields.length > 0 && extracted && typeof extracted === "object") {
        return Object.fromEntries(
          forwardFields
            .filter((field) => Object.prototype.hasOwnProperty.call(extracted, field))
            .map((field) => [field, extracted[field]]),
        );
      }
      return extracted;
    };

    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching inline workflow "${inlineWorkflowId}"`);
      let dispatched;
      try {
        dispatched = Promise.resolve(executeInline());
      } catch (err) {
        dispatched = Promise.reject(err);
      }
      dispatched
        .then((childCtx) => {
          const status = childCtx?.errors?.length ? "failed" : "completed";
          ctx.log(node.id, `Dispatched inline workflow "${inlineWorkflowId}" finished with status=${status}`);
        })
        .catch((err) => {
          ctx.log(node.id, `Dispatched inline workflow "${inlineWorkflowId}" failed: ${err.message}`, "error");
        });

      const output = {
        success: true,
        dispatched: true,
        mode: "dispatch",
        workflowId: inlineWorkflowId,
        matchedPort: "default",
        port: "default",
      };
      if (outputVariable) {
        ctx.data[outputVariable] = output;
      }
      return output;
    }

    ctx.log(node.id, `Executing inline workflow "${inlineWorkflowId}" (sync)`);
    const childCtx = await executeInline();
    const childErrors = Array.isArray(childCtx?.errors)
      ? childCtx.errors.map((entry) => ({
          nodeId: entry?.nodeId || null,
          error: String(entry?.error || "unknown child workflow error"),
        }))
      : [];
    const status = childErrors.length > 0 ? "failed" : "completed";
    const extracted = extractChildOutputs(childCtx);
    const output = {
      success: status === "completed",
      dispatched: false,
      mode: "sync",
      workflowId: inlineWorkflowId,
      runId: childCtx?.id || null,
      status,
      errorCount: childErrors.length,
      errors: childErrors,
      matchedPort: status === "completed" ? "default" : "error",
      port: status === "completed" ? "default" : "error",
      childOutputs: extracted,
      ...(extracted && typeof extracted === "object" ? extracted : {}),
    };

    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }

    if (status === "failed" && failOnChildError) {
      const reason = childErrors[0]?.error || "inline workflow failed";
      const err = new Error(`action.inline_workflow: child inline workflow "${inlineWorkflowId}" failed: ${reason}`);
      err.childWorkflow = output;
      throw err;
    }

    return output;
  },
});

registerBuiltinNodeType("meeting.start", {
  describe: () => "Create or reuse a meeting session for workflow-driven voice/video orchestration",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Optional session ID (auto-generated when empty)" },
      title: { type: "string", description: "Optional human-readable session title" },
      executor: { type: "string", description: "Preferred executor for this meeting session" },
      mode: { type: "string", description: "Preferred agent mode for this meeting session" },
      model: { type: "string", description: "Preferred model override for this meeting session" },
      wakePhrase: { type: "string", description: "Optional wake phrase metadata for downstream workflow logic" },
      metadata: { type: "object", description: "Additional metadata stored with the meeting session" },
      activate: { type: "boolean", default: true, description: "Mark meeting session active after creation/reuse" },
      maxMessages: { type: "number", description: "Optional session max message retention override" },
      failOnError: { type: "boolean", default: true, description: "Throw when meeting setup fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.startMeeting !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim() || undefined;
      const title = String(ctx.resolve(node.config?.title || "") || "").trim() || undefined;
      const executor = String(ctx.resolve(node.config?.executor || "") || "").trim() || undefined;
      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;
      const wakePhrase = String(ctx.resolve(node.config?.wakePhrase || "") || "").trim() || undefined;
      const metadataInput = resolveWorkflowNodeValue(node.config?.metadata || {}, ctx);
      const metadata =
        metadataInput && typeof metadataInput === "object" && !Array.isArray(metadataInput)
          ? { ...metadataInput }
          : {};
      if (title) metadata.title = title;
      if (wakePhrase) metadata.wakePhrase = wakePhrase;

      const activate = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.activate ?? true, ctx), true);
      const maxMessagesRaw = Number(resolveWorkflowNodeValue(node.config?.maxMessages, ctx));
      const maxMessages = Number.isFinite(maxMessagesRaw) && maxMessagesRaw > 0
        ? Math.trunc(maxMessagesRaw)
        : undefined;

      const result = await meeting.startMeeting({
        sessionId,
        metadata,
        agent: executor,
        mode,
        model,
        activate,
        maxMessages,
      });

      const activeSessionId = String(result?.sessionId || sessionId || "").trim() || null;
      if (activeSessionId) {
        ctx.data.meetingSessionId = activeSessionId;
        ctx.data.sessionId = ctx.data.sessionId || activeSessionId;
      }

      return {
        success: true,
        sessionId: activeSessionId,
        created: result?.created === true,
        session: result?.session || null,
        voice: result?.voice || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerBuiltinNodeType("meeting.send", {
  describe: () => "Send a meeting message through the meeting session dispatcher",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      message: { type: "string", description: "Message to send into the meeting session" },
      mode: { type: "string", description: "Optional per-message mode override" },
      model: { type: "string", description: "Optional per-message model override" },
      timeoutMs: { type: "number", description: "Optional per-message timeout in ms" },
      createIfMissing: { type: "boolean", default: true, description: "Create session automatically when missing" },
      allowInactive: { type: "boolean", default: false, description: "Allow sending when session is inactive" },
      failOnError: { type: "boolean", default: true, description: "Throw when sending fails" },
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.sendMeetingMessage !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.send requires sessionId (configure node.sessionId or run meeting.start first)");
      }
      const message = String(ctx.resolve(node.config?.message || "") || "").trim();
      if (!message) {
        throw new Error("meeting.send requires message");
      }

      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;
      const timeoutMsRaw = Number(resolveWorkflowNodeValue(node.config?.timeoutMs, ctx));
      const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
        ? Math.trunc(timeoutMsRaw)
        : undefined;
      const createIfMissing = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.createIfMissing ?? true, ctx), true);
      const allowInactive = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.allowInactive ?? false, ctx), false);

      const result = await meeting.sendMeetingMessage(sessionId, message, {
        mode,
        model,
        timeoutMs,
        createIfMissing,
        allowInactive,
      });

      const nextSessionId = String(result?.sessionId || sessionId).trim();
      if (nextSessionId) {
        ctx.data.meetingSessionId = nextSessionId;
        ctx.data.sessionId = ctx.data.sessionId || nextSessionId;
      }

      return {
        success: result?.ok !== false,
        sessionId: nextSessionId || null,
        messageId: result?.messageId || null,
        status: result?.status || null,
        responseText: result?.responseText || "",
        adapter: result?.adapter || null,
        observedEventCount: Number(result?.observedEventCount || 0),
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerBuiltinNodeType("meeting.transcript", {
  describe: () => "Fetch meeting transcript pages and optionally project as plain text",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      page: { type: "number", default: 1 },
      pageSize: { type: "number", default: 200 },
      includeMessages: { type: "boolean", default: true, description: "Include structured message array in output" },
      failOnError: { type: "boolean", default: true, description: "Throw when transcript retrieval fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.fetchMeetingTranscript !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.transcript requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const pageRaw = Number(resolveWorkflowNodeValue(node.config?.page ?? 1, ctx));
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
      const pageSizeRaw = Number(resolveWorkflowNodeValue(node.config?.pageSize ?? 200, ctx));
      const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.trunc(pageSizeRaw) : 200;
      const includeMessages = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeMessages ?? true, ctx), true);

      const transcript = await meeting.fetchMeetingTranscript(sessionId, {
        page,
        pageSize,
      });
      const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
      const transcriptText = messages
        .map((msg) => {
          const role = String(msg?.role || msg?.type || "system").trim().toLowerCase();
          const content = String(msg?.content || "").trim();
          if (!content) return "";
          return `${role}: ${content}`;
        })
        .filter(Boolean)
        .join("\n");

      return {
        success: true,
        sessionId,
        status: transcript?.status || null,
        page: Number(transcript?.page || page),
        pageSize: Number(transcript?.pageSize || pageSize),
        totalMessages: Number(transcript?.totalMessages || messages.length),
        totalPages: Number(transcript?.totalPages || 0),
        hasNextPage: transcript?.hasNextPage === true,
        hasPreviousPage: transcript?.hasPreviousPage === true,
        transcript: transcriptText,
        messages: includeMessages ? messages : undefined,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerBuiltinNodeType("meeting.vision", {
  describe: () => "Analyze a meeting video frame and persist a vision summary",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      frameDataUrl: { type: "string", description: "Base64 data URL for the current frame" },
      source: { type: "string", enum: ["screen", "camera"], default: "screen" },
      prompt: { type: "string", description: "Optional per-frame vision prompt override" },
      visionModel: { type: "string", description: "Optional vision model override" },
      minIntervalMs: { type: "number", description: "Minimum analysis interval for this session" },
      forceAnalyze: { type: "boolean", default: false, description: "Bypass dedupe/throttle checks" },
      width: { type: "number", description: "Optional frame width for transcript context" },
      height: { type: "number", description: "Optional frame height for transcript context" },
      executor: { type: "string", description: "Optional executor hint for vision context" },
      mode: { type: "string", description: "Optional mode hint for vision context" },
      model: { type: "string", description: "Optional model hint for vision context" },
      failOnError: { type: "boolean", default: true, description: "Throw when vision analysis fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.analyzeMeetingFrame !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.vision requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const frameDataUrl = String(
        ctx.resolve(node.config?.frameDataUrl || ctx.data?.frameDataUrl || ctx.data?.visionFrameDataUrl || ""),
      ).trim();
      if (!frameDataUrl) {
        throw new Error("meeting.vision requires frameDataUrl");
      }

      const source = String(ctx.resolve(node.config?.source || "screen") || "screen").trim() || "screen";
      const prompt = String(ctx.resolve(node.config?.prompt || "") || "").trim() || undefined;
      const visionModel = String(ctx.resolve(node.config?.visionModel || "") || "").trim() || undefined;
      const minIntervalRaw = Number(resolveWorkflowNodeValue(node.config?.minIntervalMs, ctx));
      const minIntervalMs = Number.isFinite(minIntervalRaw) && minIntervalRaw > 0
        ? Math.trunc(minIntervalRaw)
        : undefined;
      const forceAnalyze = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.forceAnalyze ?? false, ctx), false);
      const widthRaw = Number(resolveWorkflowNodeValue(node.config?.width, ctx));
      const heightRaw = Number(resolveWorkflowNodeValue(node.config?.height, ctx));
      const width = Number.isFinite(widthRaw) && widthRaw > 0 ? Math.trunc(widthRaw) : undefined;
      const height = Number.isFinite(heightRaw) && heightRaw > 0 ? Math.trunc(heightRaw) : undefined;
      const executor = String(ctx.resolve(node.config?.executor || "") || "").trim() || undefined;
      const mode = String(ctx.resolve(node.config?.mode || "") || "").trim() || undefined;
      const model = String(ctx.resolve(node.config?.model || "") || "").trim() || undefined;

      const result = await meeting.analyzeMeetingFrame(sessionId, frameDataUrl, {
        source,
        prompt,
        visionModel,
        minIntervalMs,
        forceAnalyze,
        width,
        height,
        executor,
        mode,
        model,
      });

      ctx.data.meetingSessionId = sessionId;
      if (result?.summary) {
        ctx.data.meetingVisionSummary = String(result.summary);
      }

      return {
        success: result?.ok !== false,
        sessionId: String(result?.sessionId || sessionId).trim(),
        analyzed: result?.analyzed === true,
        skipped: result?.skipped === true,
        reason: result?.reason || null,
        summary: result?.summary || "",
        provider: result?.provider || null,
        model: result?.model || null,
        frameHash: result?.frameHash || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerBuiltinNodeType("meeting.finalize", {
  describe: () => "Finalize a meeting session with status and optional note",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Meeting session ID (defaults to context session)" },
      status: {
        type: "string",
        enum: ["active", "paused", "completed", "archived", "failed", "cancelled"],
        default: "completed",
      },
      note: { type: "string", description: "Optional note recorded in session history" },
      failOnError: { type: "boolean", default: true, description: "Throw when finalization fails" },
    },
  },
  async execute(node, ctx, engine) {
    const meeting = engine.services?.meeting;
    if (!meeting || typeof meeting.stopMeeting !== "function") {
      throw new Error("Meeting service is not available");
    }

    const failOnError = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.failOnError ?? true, ctx), true);
    try {
      const sessionId = String(
        ctx.resolve(node.config?.sessionId || ctx.data?.meetingSessionId || ctx.data?.sessionId || ""),
      ).trim();
      if (!sessionId) {
        throw new Error("meeting.finalize requires sessionId (configure node.sessionId or run meeting.start first)");
      }

      const status = String(
        ctx.resolve(node.config?.status || "completed") || "completed",
      ).trim().toLowerCase() || "completed";
      const note = String(ctx.resolve(node.config?.note || "") || "").trim() || undefined;

      const result = await meeting.stopMeeting(sessionId, { status, note });
      return {
        success: result?.ok !== false,
        sessionId: String(result?.sessionId || sessionId).trim(),
        status: result?.status || status,
        session: result?.session || null,
      };
    } catch (err) {
      if (failOnError) throw err;
      return {
        success: false,
        error: String(err?.message || err),
      };
    }
  },
});

registerBuiltinNodeType("action.create_task", {
  describe: () => "Create a new task in the kanban board",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description" },
      status: { type: "string", default: "todo" },
      priority: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
      projectId: { type: "string" },
    },
    required: ["title"],
  },
  async execute(node, ctx, engine) {
    const title = ctx.resolve(node.config?.title || "");
    const description = ctx.resolve(node.config?.description || "");
    const kanban = engine.services?.kanban;

    ctx.log(node.id, `Creating task: ${title}`);

    if (kanban?.createTask) {
      const task = await createKanbanTaskWithProject(
        kanban,
        attachWorkflowTaskMetadata(ctx, {
          title,
          description,
          status: node.config?.status || "todo",
          priority: node.config?.priority,
          tags: node.config?.tags,
          projectId: node.config?.projectId,
        }, {
          sourceNodeId: node.id,
          sourceNodeType: node.type,
        }),
        node.config?.projectId,
      );
      bindTaskContext(ctx, {
        taskId: task?.id,
        taskTitle: task?.title || title,
        task,
      });
      return {
        success: true,
        taskId: task?.id || null,
        title: task?.title || title,
        task: task || null,
      };
    }
    return { success: false, error: "Kanban adapter not available" };
  },
});

registerBuiltinNodeType("action.update_task_status", {
  describe: () => "Update the status of an existing task",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID (supports {{variables}})" },
      status: { type: "string", enum: ["todo", "inprogress", "inreview", "done", "blocked", "archived"] },
      blockedReason: { type: "string", description: "Optional structured blocked-state reason persisted with the task" },
      taskTitle: { type: "string", description: "Optional task title for downstream event payloads" },
      previousStatus: { type: "string", description: "Optional explicit previous status" },
      workflowEvent: { type: "string", description: "Optional follow-up workflow event to emit after status update" },
      workflowData: { type: "object", description: "Additional payload for workflowEvent" },
      workflowDedupKey: { type: "string", description: "Optional dedup key for workflowEvent dispatch" },
    },
    required: ["taskId", "status"],
  },
  async execute(node, ctx, engine) {
    let taskId = ctx.resolve(node.config?.taskId || "");
    let status = node.config?.status;
    const kanban = engine.services?.kanban;
    const workflowEvent = ctx.resolve(node.config?.workflowEvent || "");
    const blockedReasonProvided = Object.prototype.hasOwnProperty.call(node.config || {}, "blockedReason");
    const blockedReason = blockedReasonProvided ? ctx.resolve(node.config?.blockedReason || "") : undefined;
    const workflowData =
      node.config?.workflowData && typeof node.config.workflowData === "object"
        ? node.config.workflowData
        : null;
    const taskTitle = ctx.resolve(node.config?.taskTitle || "");
    const previousStatus = ctx.resolve(node.config?.previousStatus || "");
    const workflowDedupKey = ctx.resolve(node.config?.workflowDedupKey || "");
    const updateOptions = {};
    updateOptions.source = "workflow";
    if (taskTitle) updateOptions.taskTitle = taskTitle;
    if (previousStatus) updateOptions.previousStatus = previousStatus;
    if (workflowEvent) updateOptions.workflowEvent = workflowEvent;
    if (workflowData) updateOptions.workflowData = workflowData;
    if (workflowDedupKey) updateOptions.workflowDedupKey = workflowDedupKey;

    if (isUnresolvedTemplateToken(taskId)) {
      const fallbackTaskId =
        ctx.data?.taskId ||
        ctx.data?.task?.id ||
        ctx.data?.task_id ||
        "";
      if (fallbackTaskId && !isUnresolvedTemplateToken(fallbackTaskId)) {
        taskId = String(fallbackTaskId);
      }
    }

    if (!taskId || isUnresolvedTemplateToken(taskId)) {
      const unresolvedValue = String(taskId || node.config?.taskId || "(empty)");
      ctx.log(node.id, `Skipping update_task_status due unresolved taskId: ${unresolvedValue}`);
      return {
        success: false,
        skipped: true,
        error: "unresolved_task_id",
        taskId: unresolvedValue,
        status,
      };
    }

    let currentTask =
      ctx.data?.task && String(ctx.data.task.id || "").trim() === String(taskId)
        ? ctx.data.task
        : null;
    if (!currentTask && typeof kanban?.getTask === "function") {
      try {
        currentTask = await kanban.getTask(taskId);
      } catch {
        currentTask = null;
      }
    }
    if (shouldKeepTaskInReview(currentTask, status)) {
      status = "inreview";
      updateOptions.previousStatus = updateOptions.previousStatus || "inreview";
    }

    if (kanban?.updateTaskStatus) {
      const createPrOutput =
        typeof ctx.getNodeOutput === "function"
          ? (ctx.getNodeOutput("create-pr") || ctx.getNodeOutput("pr") || ctx.getNodeOutput("create-pr-retry"))
          : null;

      const normalizeString = (value) => {
        if (value == null) return null;
        const text = String(value).trim();
        return text ? text : null;
      };
      const normalizePrNumber = (value) => {
        if (value == null || value === "") return null;
        const parsed = Number.parseInt(String(value), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };

      const branchForTask = normalizeString(
        node.config?.branchName ||
          node.config?.branch ||
          createPrOutput?.branch ||
          ctx.data?.branchName ||
          ctx.data?.branch ||
          ctx.data?.task?.branchName ||
          ctx.data?.task?.branch,
      );
      const prUrlForTask = normalizeString(
        node.config?.prUrl ||
          createPrOutput?.prUrl ||
          createPrOutput?.url ||
          ctx.data?.prUrl ||
          ctx.data?.task?.prUrl,
      );
      const prNumberForTask = normalizePrNumber(
        node.config?.prNumber ||
          createPrOutput?.prNumber ||
          ctx.data?.prNumber ||
          ctx.data?.task?.prNumber,
      );

      if (branchForTask) updateOptions.branchName = branchForTask;
      if (prUrlForTask) updateOptions.prUrl = prUrlForTask;
      if (prNumberForTask != null) updateOptions.prNumber = prNumberForTask;

      await kanban.updateTaskStatus(taskId, status, updateOptions);

      // Anti-thrash: mark task completed with PR to prevent re-scheduling
      if (status === "inreview" || status === "done") {
        _completedWithPR.add(taskId);
        // Clear any no-commit bounce counts — task succeeded
        _noCommitCounts.delete(taskId);
        _skipUntil.delete(taskId);
      }
      // Persist PR linkage/branch metadata so review rehydrate does not reset
      // in-review tasks back to todo due missing references.
      if (
        ((status === "inreview" || status === "inprogress") || blockedReasonProvided) &&
        typeof kanban.updateTask === "function" &&
        (branchForTask || prUrlForTask || prNumberForTask != null || blockedReasonProvided)
      ) {
        const linkagePatch = {};
        if (branchForTask) linkagePatch.branchName = branchForTask;
        if (prUrlForTask) linkagePatch.prUrl = prUrlForTask;
        if (prNumberForTask != null) linkagePatch.prNumber = prNumberForTask;
        if (blockedReasonProvided) linkagePatch.blockedReason = String(blockedReason || "").trim() || null;
        try {
          await kanban.updateTask(taskId, linkagePatch);
        } catch (err) {
          ctx.log(
            node.id,
            `Failed to persist task linkage metadata: ${err?.message || err}`,
            "warn",
          );
        }
      }

      bindTaskContext(ctx, {
        taskId,
        taskTitle,
      });
      return {
        success: true,
        taskId,
        taskTitle: taskTitle || null,
        status,
        workflowEvent: workflowEvent || null,
      };
    }
    return { success: false, error: "Kanban adapter not available" };
  },
});

registerBuiltinNodeType("action.git_operations", {
  describe: () => "Perform git operations (commit, push, create branch, etc.)",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["commit", "push", "create_branch", "checkout", "merge", "rebase", "status"] },
      operations: {
        type: "array",
        description: "Legacy multi-step operation list",
        items: {
          type: "object",
          properties: {
            op: { type: "string" },
            operation: { type: "string" },
            message: { type: "string" },
            branch: { type: "string" },
            name: { type: "string" },
            includeTags: { type: "boolean" },
            paths: { type: "array", items: { type: "string" } },
          },
        },
      },
      message: { type: "string", description: "Commit message (for commit operation)" },
      branch: { type: "string", description: "Branch name" },
      cwd: { type: "string" },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before running this git operation even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: [],
  },
  async execute(node, ctx, engine) {
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const resolveOpCommand = (opConfig = {}) => {
      const op = String(opConfig.op || opConfig.operation || "").trim();
      const branch = ctx.resolve(opConfig.branch || node.config?.branch || "");
      const message = ctx.resolve(opConfig.message || node.config?.message || "");
      const tagName = ctx.resolve(opConfig.name || "");
      const includeTags = opConfig.includeTags === true;
      const addPaths = Array.isArray(opConfig.paths) && opConfig.paths.length > 0
        ? opConfig.paths.map((path) => ctx.resolve(String(path))).join(" ")
        : "-A";

      const commands = {
        add: `git add ${addPaths}`,
        commit: `git add -A && git commit -m "${message.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
        tag: tagName ? `git tag ${tagName}` : "",
        push: includeTags
          ? "git push --set-upstream origin HEAD && git push --tags"
          : "git push --set-upstream origin HEAD",
        create_branch: `git checkout -b ${branch}`,
        checkout: `git checkout ${branch}`,
        merge: `git merge ${branch} --no-edit`,
        rebase: `git rebase ${branch}`,
        status: "git status --porcelain",
      };
      const cmd = commands[op];
      if (!cmd) {
        throw new Error(`Unknown git operation: ${op}`);
      }
      return { op, cmd };
    };

    const runGitCommand = ({ op, cmd }) => {
      ctx.log(node.id, `Git ${op}: ${cmd}`);
      const startedAt = Date.now();
      try {
        const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 120000 });
        return compactWorkflowCommandResult({
          command: cmd,
          output: output?.trim() || "",
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        }).then((compacted) => ({
          success: true,
          operation: op,
          command: cmd,
          ...compacted,
        }));
      } catch (err) {
        return compactWorkflowCommandResult({
          command: cmd,
          output: err.stdout?.toString() || "",
          stderr: err.stderr?.toString() || err.message,
          exitCode: err.status,
          durationMs: Date.now() - startedAt,
        }).then((compacted) => ({
          success: false,
          error: err.message,
          operation: op,
          command: cmd,
          ...compacted,
        }));
      }
    };

    const operationList = Array.isArray(node.config?.operations)
      ? node.config.operations
      : [];
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.git_operations",
      repoRoot: cwd,
    });
    if (operationList.length > 0) {
      const steps = [];
      for (const spec of operationList) {
        const resolved = resolveOpCommand(spec || {});
        const result = await runGitCommand(resolved);
        steps.push(result);
        if (result.success !== true) {
          return {
            success: false,
            operation: resolved.op,
            steps,
            error: result.error,
          };
        }
      }
      return { success: true, operation: "batch", steps };
    }

    const op = String(node.config?.operation || "").trim();
    if (!op) {
      return { success: false, error: "No git operation provided", operation: null };
    }
    const resolved = resolveOpCommand({ op });
    return await runGitCommand(resolved);
  },
});

registerBuiltinNodeType("action.create_pr", {
  describe: () =>
    "Create a pull request via GitHub CLI. Falls back to Bosun-managed handoff " +
    "when gh is unavailable or the operation fails with failOnError=false.",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "PR title" },
      body: { type: "string", description: "PR body" },
      base: { type: "string", description: "Base branch" },
      baseBranch: { type: "string", description: "Legacy alias for base branch" },
      branch: { type: "string", description: "Head branch (source)" },
      repoSlug: { type: "string", description: "GitHub repository slug (owner/repo)" },
      draft: { type: "boolean", default: false },
      labels: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Comma-separated or array of labels",
      },
      reviewers: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Comma-separated or array of reviewer handles",
      },
      enableAutoMerge: {
        type: "boolean",
        default: false,
        description: "Enable gh auto-merge immediately after PR creation/linking",
      },
      autoMerge: {
        type: "boolean",
        description: "Legacy alias for enableAutoMerge",
      },
      autoMergeMethod: {
        type: "string",
        enum: ["merge", "squash", "rebase"],
        default: "merge",
        description: "Merge method used with gh pr merge --auto",
      },
      mergeMethod: {
        type: "string",
        enum: ["merge", "squash", "rebase"],
        description: "Legacy alias for autoMergeMethod",
      },
      cwd: { type: "string" },
      failOnError: { type: "boolean", default: false, description: "If true, throw on gh failure instead of falling back" },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before creating a pull request even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: ["title"],
  },
  async execute(node, ctx, engine) {
    const resolveNodeValue = (value, fallback = "") => {
      try {
        const resolved = typeof ctx?.resolve === "function" ? ctx.resolve(value ?? fallback) : (value ?? fallback);
        return resolved ?? fallback;
      } catch (err) {
        ctx.log(node.id, `Failed to resolve PR node value: ${err?.message || err}`);
        return fallback;
      }
    };

    const PR_TEMPLATE_PLACEHOLDER_RE = /^\{\{\s*[\w.-]+\s*\}\}$/;
    const PR_TEMPLATE_INLINE_PLACEHOLDER_RE = /\{\{\s*[\w.-]+\s*\}\}/g;
    const normalizePrText = (value) => {
      if (value == null) return "";
      const text = String(value).trim();
      if (!text) return "";
      if (PR_TEMPLATE_PLACEHOLDER_RE.test(text)) return "";
      return text
        .replace(PR_TEMPLATE_INLINE_PLACEHOLDER_RE, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    };

    const title = normalizePrText(resolveNodeValue(node.config?.title, ""));
    const body = appendBosunCreatedPrFooter(String(resolveNodeValue(node.config?.body, "")));
    const baseInput = resolveNodeValue(node.config?.base ?? node.config?.baseBranch, "main");
    let base = String(baseInput || "main").trim() || "main";
    try {
      base = normalizeBaseBranch(base).branch;
    } catch {
    }
    const branch = String(resolveNodeValue(node.config?.branch, "")).trim();
    const repoSlug = String(
      resolveNodeValue(node.config?.repoSlug ?? ctx.data?.repoSlug ?? ctx.data?.repository, ""),
    ).trim();
    const draft = node.config?.draft === true;
    const failOnError = node.config?.failOnError === true;
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.create_pr",
      repoRoot: ctx?.data?.repoRoot
        || ctx?.data?.repoPath
        || resolveNodeValue(node.config?.cwd ?? ctx.data?.worktreePath ?? process.cwd(), process.cwd()),
    });
    const enableAutoMerge = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.enableAutoMerge ?? node.config?.autoMerge ?? false, ctx),
      false,
    );
    const autoMergeMethodRaw = String(
      resolveNodeValue(
        node.config?.autoMergeMethod ?? node.config?.mergeMethod ?? process.env.BOSUN_MERGE_METHOD,
        "merge",
      ),
    ).trim().toLowerCase();
    const autoMergeMethod = ["merge", "squash", "rebase"].includes(autoMergeMethodRaw)
      ? autoMergeMethodRaw
      : (process.env.BOSUN_MERGE_METHOD || "merge");
    const cwd = String(resolveNodeValue(node.config?.cwd ?? ctx.data?.worktreePath, process.cwd())).trim() || process.cwd();

    // Normalize labels/reviewers to arrays
    const toList = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return String(v).split(",").map((s) => s.trim()).filter(Boolean);
    };
    const labels = Array.from(new Set([
      ...toList(resolveNodeValue(node.config?.labels, "")),
      BOSUN_ATTACHED_PR_LABEL,
      BOSUN_CREATED_PR_LABEL,
    ]));
    const reviewers = toList(resolveNodeValue(node.config?.reviewers, ""));

    if (!title) {
      const error = "PR title is required";
      ctx.log(node.id, error);
      return { success: false, error, title, base, branch: branch || null, repoSlug: repoSlug || null };
    }

    // Resolve Bosun's best available GitHub token and inject as GH_TOKEN so that
    // `gh pr create` uses a user OAuth / App installation token rather than the
    // ambient GITHUB_TOKEN. GitHub suppresses pull_request CI workflow triggers
    // for events caused by GITHUB_TOKEN (loop-prevention), so using a real user
    // token here is what allows CI to fire automatically on the created PR.
    let ghTokenEnv = {};
    let resolvedTokenType = null;
    try {
      const [ghOwner, ghRepo] = repoSlug ? repoSlug.split("/") : [];
      const { token, type } = await getGitHubToken({ owner: ghOwner, repo: ghRepo });
      resolvedTokenType = type;
      // Only inject when we have a real user/app token, not an env-fallback
      // (which would be GITHUB_TOKEN itself — injecting it would be redundant).
      if (type !== "env") {
        ghTokenEnv = { GH_TOKEN: token };
      }
    } catch {
      // No auth available — fall back to ambient environment
    }

    const execOptions = {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: makeIsolatedGitEnv(ghTokenEnv),
      stdio: ["pipe", "pipe", "pipe"],
    };

    const maybeEnableAutoMerge = (prNumber) => {
      if (!enableAutoMerge) {
        return { enabled: false, attempted: false, success: false };
      }
      if (draft) {
        return { enabled: true, attempted: false, success: false, reason: "draft_pr", method: autoMergeMethod };
      }
      const parsedPrNumber = Number.parseInt(String(prNumber || ""), 10);
      if (!Number.isFinite(parsedPrNumber) || parsedPrNumber <= 0) {
        return { enabled: true, attempted: false, success: false, reason: "missing_pr_number", method: autoMergeMethod };
      }
      if (shouldBypassGhPrCreationForTests()) {
        return { enabled: true, attempted: false, success: false, reason: "test_runtime_skip", method: autoMergeMethod };
      }
      try {
        const mergeArgs = ["pr", "merge", String(parsedPrNumber), "--auto", `--${autoMergeMethod}`];
        if (repoSlug) mergeArgs.push("--repo", repoSlug);
        execFileSync("gh", mergeArgs, execOptions);
        ctx.log(node.id, `Auto-merge requested for PR #${parsedPrNumber} (${autoMergeMethod})`);
        return {
          enabled: true,
          attempted: true,
          success: true,
          method: autoMergeMethod,
          prNumber: parsedPrNumber,
        };
      } catch (err) {
        const error = err?.stderr?.toString?.()?.trim() || err?.message || String(err);
        ctx.log(node.id, `Auto-merge request failed for PR #${parsedPrNumber}: ${error}`);
        return {
          enabled: true,
          attempted: true,
          success: false,
          method: autoMergeMethod,
          prNumber: parsedPrNumber,
          error,
        };
      }
    };

    /** Re-resolve token after invalidating the current one (401 retry). */
    const retryWithFallbackToken = async () => {
      if (!resolvedTokenType) return false;
      invalidateTokenType(resolvedTokenType);
      try {
        const [ghOwner, ghRepo] = repoSlug ? repoSlug.split("/") : [];
        const { token, type } = await getGitHubToken({
          owner: ghOwner,
          repo: ghRepo,
          skipType: resolvedTokenType,
        });
        resolvedTokenType = type;
        if (type !== "env") {
          ghTokenEnv = { GH_TOKEN: token };
        } else {
          ghTokenEnv = {};
        }
        execOptions.env = makeIsolatedGitEnv(ghTokenEnv);
        ctx.log(node.id, `Retrying with fallback token (type=${type})`);
        return true;
      } catch {
        return false;
      }
    };

    const findExistingPr = () => {
      if (!branch) return null;
      try {
        const existingArgs = [
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "open",
          "--json",
          "number,url,title,headRefName,baseRefName",
        ];
        if (repoSlug) existingArgs.push("--repo", repoSlug);
        if (base) existingArgs.push("--base", base);
        const existingRaw = execFileSync("gh", existingArgs, execOptions).trim();
        const existingList = existingRaw ? JSON.parse(existingRaw) : [];
        if (!Array.isArray(existingList) || existingList.length === 0) return null;
        const existing = existingList.find((pr) => String(pr?.headRefName || "").trim() === branch) || existingList[0];
        const prNumber = Number.parseInt(existing?.number, 10);
        if (!Number.isFinite(prNumber) || prNumber <= 0) return null;
        if (labels.length) {
          try {
            const editArgs = ["pr", "edit", String(prNumber)];
            if (repoSlug) editArgs.push("--repo", repoSlug);
            editArgs.push("--add-label", labels.join(","));
            execFileSync("gh", editArgs, execOptions);
          } catch {
          }
        }
        const autoMergeState = maybeEnableAutoMerge(prNumber);
        return {
          success: true,
          existing: true,
          prUrl: String(existing?.url || "").trim(),
          prNumber,
          repoSlug: repoSlug || null,
          title,
          base: base || String(existing?.baseRefName || "").trim() || null,
          branch: branch || String(existing?.headRefName || "").trim() || null,
          draft,
          labels,
          reviewers,
          output: String(existing?.url || `existing-pr-${prNumber}`),
          autoMerge: autoMergeState,
        };
      } catch {
        return null;
      }
    };

    // Build gh pr create command
    const args = ["gh", "pr", "create"];
    if (repoSlug) args.push("--repo", repoSlug);
    args.push("--title", JSON.stringify(title));
    // gh pr create requires either --body (empty is allowed) or --fill* in non-interactive mode.
    args.push("--body", JSON.stringify(String(body)));
    if (base) args.push("--base", base);
    if (branch) args.push("--head", branch);
    if (draft) args.push("--draft");
    if (labels.length) args.push("--label", labels.join(","));
    if (reviewers.length) args.push("--reviewer", reviewers.join(","));

    const cmd = args.join(" ");
    console.log(`[workflow-nodes] create-pr: branch=${branch || "(empty)"} base=${base} cwd=${cwd} repo=${repoSlug || "(auto)"}`);
    ctx.log(node.id, `Creating PR: ${cmd}`);

    if (shouldBypassGhPrCreationForTests()) {
      ctx.log(node.id, "Skipping gh CLI PR creation in test runtime; using Bosun-managed handoff");
      return {
        success: true,
        handedOff: true,
        lifecycle: "bosun_managed",
        action: "pr_handoff",
        message: "gh CLI skipped in test runtime; Bosun manages pull-request lifecycle.",
        title,
        body,
        base,
        branch: branch || null,
        draft,
        labels,
        reviewers,
        cwd,
        repoSlug: repoSlug || null,
        ghError: "skipped_in_test_runtime",
        createdByBosun: true,
        autoMerge: {
          enabled: enableAutoMerge,
          attempted: false,
          success: false,
          reason: "test_runtime_skip",
          method: autoMergeMethod,
        },
      };
    }

    try {
      const output = execSync(cmd, execOptions);
      const trimmed = (output || "").trim();
      // gh pr create prints the PR URL on success
      const urlMatch = trimmed.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      const prNumber = urlMatch ? parseInt(urlMatch[1], 10) : null;
      const prUrl = urlMatch ? urlMatch[0] : trimmed;
      const autoMergeState = maybeEnableAutoMerge(prNumber);
      ctx.log(node.id, `PR created: ${prUrl}`);
      return {
        success: true,
        prUrl,
        prNumber,
        repoSlug: repoSlug || null,
        title,
        body,
        base,
        branch: branch || null,
        draft,
        labels,
        reviewers,
        output: trimmed,
        createdByBosun: true,
        autoMerge: autoMergeState,
      };
    } catch (err) {
      const errorMsg = err?.stderr?.toString?.()?.trim() || err?.message || String(err);
      const is401 = /401|bad credentials|requires authentication/i.test(errorMsg);

      // On 401: invalidate current token and retry once with the next fallback
      if (is401 && resolvedTokenType) {
        console.warn(`${TAG} create-pr: 401 from token type="${resolvedTokenType}", attempting fallback`);
        const retried = await retryWithFallbackToken();
        if (retried) {
          try {
            const retryOutput = execSync(cmd, execOptions);
            const trimmed = (retryOutput || "").trim();
            const urlMatch = trimmed.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
            const prNumber = urlMatch ? parseInt(urlMatch[1], 10) : null;
            const prUrl = urlMatch ? urlMatch[0] : trimmed;
            const autoMergeState = maybeEnableAutoMerge(prNumber);
            ctx.log(node.id, `PR created (after auth retry): ${prUrl}`);
            return {
              success: true,
              prUrl,
              prNumber,
              repoSlug: repoSlug || null,
              title,
              base,
              branch: branch || null,
              draft,
              labels,
              reviewers,
              output: trimmed,
              createdByBosun: true,
              autoMerge: autoMergeState,
            };
          } catch (retryErr) {
            const retryMsg = retryErr?.stderr?.toString?.()?.trim() || retryErr?.message || String(retryErr);
            console.warn(`${TAG} create-pr FAILED (after retry): ${retryMsg.substring(0, 200)}`);
            ctx.log(node.id, `PR creation failed after auth retry: ${retryMsg}`);
          }
        }
      }

      console.warn(`${TAG} create-pr FAILED: ${errorMsg.substring(0, 200)} (branch=${branch || "(empty)"})`);
      ctx.log(node.id, `PR creation failed: ${errorMsg}`);
      const existingPr = findExistingPr();
      if (existingPr) {
        console.log(`[workflow-nodes] create-pr: resolved existing PR #${existingPr.prNumber}`);
        ctx.log(node.id, `Resolved existing PR #${existingPr.prNumber}: ${existingPr.prUrl || "(url unavailable)"}`);
        return existingPr;
      }
      console.warn(`[workflow-nodes] create-pr: no existing PR found for branch=${branch || "(empty)"}, falling back`);
      if (failOnError) {
        return { success: false, error: errorMsg, command: cmd };
      }
      // Graceful fallback — preserve the PR payload and hand off lifecycle management
      // to Bosun without treating the node contract itself as a failure.
      ctx.log(node.id, `Falling back to Bosun-managed PR lifecycle handoff`);
      return {
        success: true,
        handedOff: true,
        lifecycle: "bosun_managed",
        action: "pr_handoff",
        message: "gh CLI failed; Bosun manages pull-request lifecycle.",
        title,
        body,
        base,
        branch: branch || null,
        draft,
        labels,
        reviewers,
        cwd,
        ghError: errorMsg,
        createdByBosun: true,
        autoMerge: {
          enabled: enableAutoMerge,
          attempted: false,
          success: false,
          reason: "pr_creation_failed",
          method: autoMergeMethod,
        },
      };
    }
  },
});

registerBuiltinNodeType("action.write_file", {
  describe: () => "Write content to a file in the workspace",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "File content" },
      append: { type: "boolean", default: false },
      mkdir: { type: "boolean", default: true },
    },
    required: ["path", "content"],
  },
  async execute(node, ctx, engine) {
    const filePath = ctx.resolve(node.config?.path || "");
    const rawContent = ctx.resolve(node.config?.content || "");
    const content = repairCommonMojibake(rawContent);
    if (node.config?.mkdir) {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    if (node.config?.append) {
      const fs = await import("node:fs");
      fs.appendFileSync(filePath, content, "utf8");
    } else {
      writeFileSync(filePath, content, "utf8");
    }
    const repairedMojibake = content !== String(rawContent ?? "");
    ctx.log(node.id, `Wrote ${filePath}${repairedMojibake ? " (encoding repaired)" : ""}`);
    return { success: true, path: filePath, repairedMojibake };
  },
});

registerBuiltinNodeType("action.read_file", {
  describe: () => "Read content from a file",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
  async execute(node, ctx, engine) {
    const filePath = ctx.resolve(node.config?.path || "");
    if (!existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const content = readFileSync(filePath, "utf8");
    return { success: true, content, path: filePath };
  },
});

registerBuiltinNodeType("action.set_variable", {
  describe: () => "Set a variable in the workflow context for downstream nodes",
  schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Variable name" },
      value: { type: "string", description: "Value (supports {{template}} and JS expressions)" },
      isExpression: { type: "boolean", default: false },
    },
    required: ["key"],
  },
  async execute(node, ctx, engine) {
    const key = node.config?.key;
    let value = node.config?.value || "";
    if (node.config?.isExpression) {
      try {
        const fn = new Function("$data", "$ctx", `return (${value});`);
        value = fn(ctx.data, ctx);
      } catch (err) {
        throw new Error(`Variable expression error: ${err.message}`);
      }
    } else {
      value = ctx.resolve(value);
    }
    ctx.data[key] = value;
    try {
      upsertStateLedgerKeyValue({
        scope: "run",
        scopeId: ctx?.id || "run",
        key,
        value,
        source: "workflow.action.set_variable",
        runId: ctx?.id || null,
        taskId: ctx?.data?.taskId || ctx?.data?.task?.id || null,
        sessionId: ctx?.data?.sessionId || null,
        metadata: {
          nodeId: node?.id || null,
          nodeType: node?.type || null,
          expression: node.config?.isExpression === true,
        },
      }, { repoRoot: resolveBosunNativeRootDir(ctx, engine) });
    } catch (err) {
      ctx.log(node.id, `State ledger key-value mirror failed: ${err.message}`, "warn");
    }
    ctx.log(node.id, `Set variable: ${key} = ${JSON.stringify(value)}`);
    return { key, value };
  },
});

registerBuiltinNodeType("action.team_init", {
  describe: () =>
    "Initialize a workflow-local agent team roster, channels, and leadership state for team workflows.",
  schema: {
    type: "object",
    properties: {
      teamId: { type: "string", description: "Stable workflow-local team identifier." },
      name: { type: "string", description: "Optional display name for the team." },
      leadId: { type: "string", description: "Lead/member id for the team coordinator." },
      defaultChannel: { type: "string", default: "team", description: "Default shared coordination channel." },
      reset: { type: "boolean", default: false, description: "When true, replace any existing workflow team state." },
      members: {
        type: "array",
        items: { type: "object" },
        description: "Initial team roster members.",
      },
      channels: {
        type: "array",
        items: { type: "object" },
        description: "Optional extra channels available to the team.",
      },
      outputVariable: { type: "string", description: "Optional context key to store the team init result." },
    },
  },
  async execute(node, ctx) {
    const now = new Date().toISOString();
    const members = Array.isArray(resolveWorkflowNodeValue(node.config?.members ?? [], ctx))
      ? resolveWorkflowNodeValue(node.config?.members ?? [], ctx)
      : [];
    const channels = Array.isArray(resolveWorkflowNodeValue(node.config?.channels ?? [], ctx))
      ? resolveWorkflowNodeValue(node.config?.channels ?? [], ctx)
      : [];
    const reset = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.reset ?? false, ctx), false);
    const teamId = normalizeTeamId(
      ctx.resolve(node.config?.teamId || "") ||
      ctx.data?.coordinationTeamId ||
      ctx.data?.teamId ||
      ctx.data?._workflowId ||
      `workflow-team-${ctx.id.slice(0, 8)}`,
    );
    const leadId = normalizeTeamId(
      ctx.resolve(node.config?.leadId || "") ||
      ctx.data?.coordinationReportsTo ||
      ctx.data?.leadId ||
      ctx.data?.agentId ||
      ctx.data?.agentProfile,
    );
    const defaultChannel = normalizeTeamId(ctx.resolve(node.config?.defaultChannel || "team")) || "team";
    const teamName = normalizeTeamId(ctx.resolve(node.config?.name || "")) || teamId;

    const teamState = updateWorkflowTeamState(ctx, (current) => {
      const next = reset
        ? {
            version: 1,
            teamId: null,
            name: null,
            leadId: null,
            defaultChannel: "team",
            initializedAt: null,
            updatedAt: null,
            roster: [],
            channels: [],
            tasks: [],
            messages: [],
            events: [],
          }
        : current;
      next.teamId = teamId;
      next.name = teamName;
      next.leadId = leadId || next.leadId || null;
      next.defaultChannel = defaultChannel;
      next.initializedAt = next.initializedAt || now;
      next.updatedAt = now;
      ensureTeamChannel(next, { channelId: defaultChannel, name: defaultChannel });
      for (const channel of channels) ensureTeamChannel(next, channel);
      if (next.leadId) {
        ensureTeamMember(next, { memberId: next.leadId, name: next.leadId, role: "lead" });
      }
      for (const member of members) ensureTeamMember(next, member);
      appendWorkflowTeamEvent(next, reset ? "team-reset" : "team-init", {
        actorId: next.leadId,
        memberId: next.leadId,
        summary: `${reset ? "Reset" : "Initialized"} workflow team ${teamId}`,
        status: "ready",
      });
      return next;
    });

    ctx.data.teamId = teamState.teamId;
    ctx.data.leadId = teamState.leadId;
    ctx.data._workflowTeamId = teamState.teamId;
    ctx.data._workflowTeamLeadId = teamState.leadId;
    ctx.data._workflowTeamChannel = teamState.defaultChannel;

    const result = {
      success: true,
      teamId: teamState.teamId,
      leadId: teamState.leadId,
      state: teamState,
      teamSummary: summarizeWorkflowTeamState(teamState),
      reset,
    };
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(node.id, `Initialized workflow team ${teamState.teamId} (${result.teamSummary.rosterCount} members)`);
    return result;
  },
});

registerBuiltinNodeType("action.team_task_publish", {
  describe: () =>
    "Publish one or more workflow-local shared team tasks that teammates can claim inside the current run.",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Single team task title." },
      description: { type: "string", description: "Single team task description." },
      tasks: {
        type: "array",
        items: { type: "object" },
        description: "Optional batch of team tasks to publish.",
      },
      createdBy: { type: "string", description: "Member id publishing the task(s)." },
      priority: { type: "string" },
      channelId: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      availableTo: { type: "array", items: { type: "string" } },
      metadata: { type: "object" },
      outputVariable: { type: "string" },
    },
  },
  async execute(node, ctx) {
    const now = new Date().toISOString();
    const createdBy = resolveTeamActorId(node, ctx, "createdBy");
    const publishedTasks = [];
    const teamState = updateWorkflowTeamState(ctx, (current) => {
      current.tasks = Array.isArray(current.tasks) ? current.tasks : [];
      current.events = Array.isArray(current.events) ? current.events : [];
      current.updatedAt = now;
      if (createdBy) ensureTeamMember(current, { memberId: createdBy, name: createdBy });
      const batch = Array.isArray(resolveWorkflowNodeValue(node.config?.tasks ?? [], ctx))
        ? resolveWorkflowNodeValue(node.config?.tasks ?? [], ctx)
        : [];
      const singleTask = {
        title: ctx.resolve(node.config?.title || ""),
        description: ctx.resolve(node.config?.description || ""),
        priority: ctx.resolve(node.config?.priority || ""),
        channelId: ctx.resolve(node.config?.channelId || ""),
        labels: resolveWorkflowNodeValue(node.config?.labels ?? [], ctx),
        tags: resolveWorkflowNodeValue(node.config?.tags ?? [], ctx),
        availableTo: resolveWorkflowNodeValue(node.config?.availableTo ?? [], ctx),
        metadata: resolveWorkflowNodeValue(node.config?.metadata ?? {}, ctx),
      };
      const sourceTasks = batch.length > 0
        ? batch
        : (singleTask.title || singleTask.description ? [singleTask] : []);
      for (const entry of sourceTasks) {
        const taskId = normalizeTeamId(entry.taskId || entry.id) || randomUUID();
        const existing = current.tasks.find((task) => task.taskId === taskId);
        const nextTask = {
          taskId,
          title: String(entry.title || entry.summary || taskId).trim(),
          description: typeof entry.description === "string" && entry.description.trim() ? entry.description.trim() : null,
          status: "open",
          priority: normalizeTeamId(entry.priority) || null,
          availableTo: normalizeTeamList(entry.availableTo),
          labels: normalizeTeamList(entry.labels),
          tags: normalizeTeamList(entry.tags),
          channelId: normalizeTeamId(entry.channelId),
          createdBy,
          claimedBy: null,
          completedBy: null,
          releasedBy: null,
          createdAt: existing?.createdAt || now,
          claimedAt: null,
          completedAt: null,
          releasedAt: null,
          claimHistory: Array.isArray(existing?.claimHistory) ? existing.claimHistory : [],
          metadata:
            entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
              ? cloneWorkflowTeamValue(entry.metadata)
              : {},
        };
        if (existing) {
          Object.assign(existing, nextTask);
          publishedTasks.push({ ...existing });
        } else {
          current.tasks.push(nextTask);
          publishedTasks.push({ ...nextTask });
        }
        appendWorkflowTeamEvent(current, "team-task-published", {
          actorId: createdBy,
          memberId: createdBy,
          taskId,
          status: "open",
          summary: `Published workflow team task ${taskId}`,
        });
      }
      return current;
    });
    const result = {
      success: true,
      teamId: teamState.teamId,
      publishedTasks,
      count: publishedTasks.length,
      teamSummary: summarizeWorkflowTeamState(teamState),
      state: teamState,
    };
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(node.id, `Published ${publishedTasks.length} workflow team task(s)`);
    return result;
  },
});

registerBuiltinNodeType("action.team_task_claim", {
  describe: () =>
    "Claim a workflow-local shared team task for a specific teammate or worker inside the current run.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Specific team task to claim." },
      memberId: { type: "string", description: "Teammate claiming the task." },
      actorId: { type: "string", description: "Alias for memberId." },
      match: { type: "object", description: "Optional matcher for first-available task selection." },
      failIfUnavailable: { type: "boolean", default: false },
      routeByOutcome: { type: "boolean", default: false, description: "When true, emit claimed/unavailable output ports." },
      outputVariable: { type: "string" },
    },
  },
  async execute(node, ctx) {
    const now = new Date().toISOString();
    const memberId = resolveTeamActorId(node, ctx);
    const requestedTaskId = normalizeTeamId(ctx.resolve(node.config?.taskId || ""));
    const failIfUnavailable = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failIfUnavailable ?? false, ctx),
      false,
    );
    const routeByOutcome = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.routeByOutcome ?? false, ctx),
      false,
    );
    const match = resolveWorkflowNodeValue(node.config?.match ?? {}, ctx);
    let claimResult = null;

    const teamState = updateWorkflowTeamState(ctx, (current) => {
      current.tasks = Array.isArray(current.tasks) ? current.tasks : [];
      current.events = Array.isArray(current.events) ? current.events : [];
      current.updatedAt = now;
      if (memberId) ensureTeamMember(current, { memberId, name: memberId });
      const candidate = requestedTaskId
        ? current.tasks.find((task) => task.taskId === requestedTaskId)
        : current.tasks.find((task) => (
          (task.status === "open" || task.status === "released") &&
          matchesTeamTask(task, match)
        ));
      if (!candidate) {
        claimResult = {
          success: !failIfUnavailable,
          claimed: false,
          outcome: "unavailable",
          reason: requestedTaskId ? "task_not_found" : "no_matching_task",
        };
        return current;
      }
      if (candidate.availableTo.length > 0 && memberId && !candidate.availableTo.includes(memberId)) {
        claimResult = {
          success: !failIfUnavailable,
          claimed: false,
          outcome: "unavailable",
          reason: "member_not_eligible",
          task: { ...candidate },
        };
        return current;
      }
      if (candidate.status === "claimed" && candidate.claimedBy && candidate.claimedBy !== memberId) {
        claimResult = {
          success: !failIfUnavailable,
          claimed: false,
          outcome: "unavailable",
          reason: "already_claimed",
          claimedBy: candidate.claimedBy,
          task: { ...candidate },
        };
        return current;
      }
      candidate.status = "claimed";
      candidate.claimedBy = memberId;
      candidate.claimedAt = now;
      candidate.releasedAt = null;
      candidate.releasedBy = null;
      candidate.claimHistory = Array.isArray(candidate.claimHistory) ? candidate.claimHistory : [];
      candidate.claimHistory.push({
        action: "claim",
        memberId,
        at: now,
        note: null,
      });
      appendWorkflowTeamEvent(current, "team-task-claimed", {
        actorId: memberId,
        memberId,
        taskId: candidate.taskId,
        status: "claimed",
        summary: `${memberId || "member"} claimed workflow team task ${candidate.taskId}`,
      });
      claimResult = {
        success: true,
        claimed: true,
        outcome: "claimed",
        task: { ...candidate },
      };
      return current;
    });

    if (!claimResult) {
      claimResult = {
        success: !failIfUnavailable,
        claimed: false,
        outcome: "unavailable",
        reason: "unknown",
      };
    }
    const result = {
      ...claimResult,
      teamId: teamState.teamId,
      memberId,
      teamSummary: summarizeWorkflowTeamState(teamState),
      state: teamState,
    };
    if (routeByOutcome) result.matchedPort = claimResult.outcome;
    if (claimResult.success === false && failIfUnavailable) {
      throw new Error(`action.team_task_claim: ${claimResult.reason}`);
    }
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(
      node.id,
      result.claimed
        ? `Claimed workflow team task ${result.task?.taskId || requestedTaskId}`
        : `Workflow team claim unavailable (${result.reason})`,
      result.claimed ? "info" : "warn",
    );
    return result;
  },
});

registerBuiltinNodeType("action.team_task_complete", {
  describe: () =>
    "Complete or release a claimed workflow-local team task while preserving auditable task history.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Workflow team task to complete or release." },
      memberId: { type: "string", description: "Member completing or releasing the task." },
      actorId: { type: "string", description: "Alias for memberId." },
      release: { type: "boolean", default: false, description: "Release the claim instead of completing the task." },
      force: { type: "boolean", default: false, description: "Allow completion/release by someone other than the claimant." },
      note: { type: "string", description: "Optional completion or release note." },
      routeByOutcome: { type: "boolean", default: false, description: "When true, emit completed/released output ports." },
      outputVariable: { type: "string" },
    },
    required: ["taskId"],
  },
  async execute(node, ctx) {
    const now = new Date().toISOString();
    const taskId = normalizeTeamId(ctx.resolve(node.config?.taskId || ""));
    const memberId = resolveTeamActorId(node, ctx);
    const release = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.release ?? false, ctx), false);
    const force = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.force ?? false, ctx), false);
    const routeByOutcome = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.routeByOutcome ?? false, ctx), false);
    const note = typeof ctx.resolve(node.config?.note || "") === "string"
      ? String(ctx.resolve(node.config?.note || "")).trim() || null
      : null;
    let transitionResult = null;

    const teamState = updateWorkflowTeamState(ctx, (current) => {
      current.tasks = Array.isArray(current.tasks) ? current.tasks : [];
      current.events = Array.isArray(current.events) ? current.events : [];
      current.updatedAt = now;
      const task = current.tasks.find((entry) => entry.taskId === taskId);
      if (!task) {
        transitionResult = { success: false, taskId, reason: "task_not_found", outcome: release ? "released" : "completed" };
        return current;
      }
      if (!force && task.claimedBy && memberId && task.claimedBy !== memberId) {
        transitionResult = {
          success: false,
          taskId,
          reason: "claim_owner_mismatch",
          claimedBy: task.claimedBy,
          task: { ...task },
          outcome: release ? "released" : "completed",
        };
        return current;
      }
      if (release) {
        task.status = "released";
        task.releasedBy = memberId;
        task.releasedAt = now;
        task.claimedBy = null;
        task.claimedAt = null;
        task.claimHistory = Array.isArray(task.claimHistory) ? task.claimHistory : [];
        task.claimHistory.push({ action: "release", memberId, at: now, note });
        appendWorkflowTeamEvent(current, "team-task-released", {
          actorId: memberId,
          memberId,
          taskId,
          status: "released",
          summary: `${memberId || "member"} released workflow team task ${taskId}`,
        });
      } else {
        task.status = "completed";
        task.completedBy = memberId;
        task.completedAt = now;
        task.claimHistory = Array.isArray(task.claimHistory) ? task.claimHistory : [];
        task.claimHistory.push({ action: "complete", memberId, at: now, note });
        appendWorkflowTeamEvent(current, "team-task-completed", {
          actorId: memberId,
          memberId,
          taskId,
          status: "completed",
          summary: `${memberId || "member"} completed workflow team task ${taskId}`,
        });
      }
      transitionResult = {
        success: true,
        taskId,
        released: release,
        completed: !release,
        outcome: release ? "released" : "completed",
        task: { ...task },
      };
      return current;
    });

    const result = {
      ...transitionResult,
      teamId: teamState.teamId,
      memberId,
      note,
      teamSummary: summarizeWorkflowTeamState(teamState),
      state: teamState,
    };
    if (routeByOutcome) result.matchedPort = transitionResult.outcome;
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(
      node.id,
      result.success
        ? `${release ? "Released" : "Completed"} workflow team task ${taskId}`
        : `Workflow team task transition failed (${result.reason})`,
      result.success ? "info" : "warn",
    );
    return result;
  },
});

registerBuiltinNodeType("action.team_message", {
  describe: () =>
    "Send a direct or channel message between teammates inside the current workflow run.",
  schema: {
    type: "object",
    properties: {
      fromMemberId: { type: "string", description: "Sender member id." },
      toMemberId: { type: "string", description: "Single direct recipient." },
      toMemberIds: { type: "array", items: { type: "string" }, description: "Multiple direct recipients." },
      channelId: { type: "string", description: "Channel to publish to when not sending direct." },
      subject: { type: "string" },
      content: { type: "string", description: "Message body." },
      taskId: { type: "string", description: "Optional related workflow team task id." },
      metadata: { type: "object" },
      routeByOutcome: { type: "boolean", default: false, description: "When true, emit direct/channel output ports." },
      outputVariable: { type: "string" },
    },
    required: ["content"],
  },
  async execute(node, ctx) {
    const now = new Date().toISOString();
    const fromMemberId = resolveTeamActorId(node, ctx, "fromMemberId");
    let deliveredMessage = null;
    const directRecipients = Array.from(new Set([
      ...normalizeTeamList(resolveWorkflowNodeValue(node.config?.toMemberIds ?? [], ctx)),
      ...normalizeTeamList(ctx.resolve(node.config?.toMemberId || "")),
    ]));
    const channelId = normalizeTeamId(
      ctx.resolve(node.config?.channelId || "") ||
      ctx.data?._workflowTeamChannel ||
      ctx.data?.channelId,
    );
    const content = String(ctx.resolve(node.config?.content || "") || "").trim();
    if (!content) throw new Error("action.team_message: 'content' is required");
    const subject = typeof ctx.resolve(node.config?.subject || "") === "string"
      ? String(ctx.resolve(node.config?.subject || "")).trim() || null
      : null;
    const taskId = normalizeTeamId(ctx.resolve(node.config?.taskId || ""));
    const metadata = resolveWorkflowNodeValue(node.config?.metadata ?? {}, ctx);
    const kind = directRecipients.length > 0 ? "direct" : "channel";
    const routeByOutcome = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.routeByOutcome ?? false, ctx), false);

    const teamState = updateWorkflowTeamState(ctx, (current) => {
      current.messages = Array.isArray(current.messages) ? current.messages : [];
      current.events = Array.isArray(current.events) ? current.events : [];
      current.updatedAt = now;
      if (fromMemberId) ensureTeamMember(current, { memberId: fromMemberId, name: fromMemberId });
      for (const memberId of directRecipients) ensureTeamMember(current, { memberId, name: memberId });
      const resolvedChannelId = kind === "channel"
        ? (channelId || current.defaultChannel || "team")
        : null;
      if (resolvedChannelId) ensureTeamChannel(current, { channelId: resolvedChannelId, name: resolvedChannelId });
      const message = {
        messageId: randomUUID(),
        kind,
        fromMemberId,
        toMemberIds: directRecipients,
        channelId: resolvedChannelId,
        subject,
        content,
        taskId,
        metadata:
          metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? cloneWorkflowTeamValue(metadata)
            : {},
        readBy: fromMemberId ? [fromMemberId] : [],
        createdAt: now,
      };
      current.messages.push(message);
      appendWorkflowTeamEvent(current, "team-message", {
        actorId: fromMemberId,
        memberId: fromMemberId,
        taskId,
        messageId: message.messageId,
        status: kind,
        summary: `${fromMemberId || "member"} sent a ${kind} workflow team message`,
      });
      deliveredMessage = { ...message };
      return current;
    });

    const result = {
      success: true,
      kind,
      outcome: kind,
      message: deliveredMessage,
      teamId: teamState.teamId,
      teamSummary: summarizeWorkflowTeamState(teamState),
      state: teamState,
    };
    if (routeByOutcome) result.matchedPort = kind;
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(node.id, `Sent ${kind} workflow team message${deliveredMessage?.messageId ? ` (${deliveredMessage.messageId})` : ""}`);
    return result;
  },
});

registerBuiltinNodeType("action.team_inbox", {
  describe: () =>
    "Read workflow-local direct and channel messages for a specific teammate inside the current run.",
  schema: {
    type: "object",
    properties: {
      memberId: { type: "string", description: "Teammate whose inbox should be read." },
      channelId: { type: "string", description: "Optional channel filter." },
      limit: { type: "number", default: 50, description: "Maximum number of messages to return." },
      includeDirect: { type: "boolean", default: true },
      includeChannels: { type: "boolean", default: true },
      includeBroadcast: { type: "boolean", default: true },
      markRead: { type: "boolean", default: false, description: "Mark returned messages as read by the member." },
      outputVariable: { type: "string" },
    },
  },
  async execute(node, ctx) {
    const memberId = resolveTeamActorId(node, ctx);
    const channelId = normalizeTeamId(ctx.resolve(node.config?.channelId || ""));
    const limit = Math.max(1, Math.min(500, Number(resolveWorkflowNodeValue(node.config?.limit ?? 50, ctx)) || 50));
    const includeDirect = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeDirect ?? true, ctx), true);
    const includeChannels = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeChannels ?? true, ctx), true);
    const includeBroadcast = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeBroadcast ?? true, ctx), true);
    const markRead = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.markRead ?? false, ctx), false);
    let inboxMessages = [];

    const teamState = updateWorkflowTeamState(ctx, (current) => {
      current.messages = Array.isArray(current.messages) ? current.messages : [];
      current.updatedAt = new Date().toISOString();
      inboxMessages = current.messages.filter((message) => {
        if (channelId && normalizeTeamId(message.channelId) !== channelId) return false;
        const directHit = includeDirect && normalizeTeamList(message.toMemberIds).includes(memberId);
        const channelHit = includeChannels && message.channelId && memberCanSeeChannel(current, memberId, message.channelId);
        const broadcastHit = includeBroadcast && !message.channelId && normalizeTeamList(message.toMemberIds).length === 0;
        return directHit || channelHit || broadcastHit;
      }).slice(-limit);
      if (markRead) {
        for (const message of inboxMessages) {
          message.readBy = Array.isArray(message.readBy) ? message.readBy : [];
          if (memberId && !message.readBy.includes(memberId)) message.readBy.push(memberId);
        }
      }
      return current;
    });

    const result = {
      success: true,
      teamId: teamState.teamId,
      memberId,
      channelId: channelId || null,
      messages: inboxMessages.map((message) => ({ ...message })),
      unreadCount: inboxMessages.filter((message) => !normalizeTeamList(message.readBy).includes(memberId)).length,
      teamSummary: summarizeWorkflowTeamState(teamState),
      state: teamState,
    };
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = result;
    ctx.log(node.id, `Read ${result.messages.length} workflow team inbox message(s) for ${memberId || "member"}`);
    return result;
  },
});

registerBuiltinNodeType("action.team_snapshot", {
  describe: () =>
    "Return the current workflow team roster, task board, message history, and compact summary for downstream decisions.",
  schema: {
    type: "object",
    properties: {
      includeRoster: { type: "boolean", default: true },
      includeTasks: { type: "boolean", default: true },
      includeMessages: { type: "boolean", default: true },
      includeEvents: { type: "boolean", default: true },
      messageLimit: { type: "number", default: 100 },
      outputVariable: { type: "string" },
    },
  },
  async execute(node, ctx) {
    const state = getWorkflowTeamState(ctx);
    const includeRoster = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeRoster ?? true, ctx), true);
    const includeTasks = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeTasks ?? true, ctx), true);
    const includeMessages = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeMessages ?? true, ctx), true);
    const includeEvents = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeEvents ?? true, ctx), true);
    const messageLimit = Math.max(1, Math.min(500, Number(resolveWorkflowNodeValue(node.config?.messageLimit ?? 100, ctx)) || 100));
    const snapshot = {
      success: true,
      teamId: state.teamId || null,
      leadId: state.leadId || null,
      teamSummary: summarizeWorkflowTeamState(state),
      roster: includeRoster ? cloneWorkflowTeamValue(state.roster || []) : [],
      tasks: includeTasks ? cloneWorkflowTeamValue(state.tasks || []) : [],
      messages: includeMessages ? cloneWorkflowTeamValue((state.messages || []).slice(-messageLimit)) : [],
      events: includeEvents ? cloneWorkflowTeamValue(state.events || []) : [],
      state,
    };
    const outputVariable = normalizeTeamId(ctx.resolve(node.config?.outputVariable || ""));
    if (outputVariable) ctx.data[outputVariable] = snapshot;
    ctx.log(node.id, `Captured workflow team snapshot for ${snapshot.teamId || "team"}`);
    return snapshot;
  },
});

registerBuiltinNodeType("action.delay", {
  describe: () => "Wait for a specified duration before continuing (supports ms, seconds, minutes, hours)",
  schema: {
    type: "object",
    properties: {
      ms: { type: "number", description: "Delay in milliseconds (direct)" },
      delayMs: { type: "number", description: "Legacy alias for ms" },
      durationMs: { type: "number", description: "Legacy alias for ms" },
      seconds: { type: "number", description: "Delay in seconds" },
      minutes: { type: "number", description: "Delay in minutes" },
      hours: { type: "number", description: "Delay in hours" },
      jitter: { type: "number", default: 0, description: "Random jitter percentage (0-100) to add/subtract from delay" },
      reason: { type: "string", description: "Human-readable reason for the delay (logged)" },
      message: { type: "string", description: "Legacy alias for reason" },
    },
  },
  async execute(node, ctx, engine) {
    const baseMs = Number(
      node.config?.ms ??
      node.config?.delayMs ??
      node.config?.durationMs ??
      0,
    );
    const seconds = Number(node.config?.seconds || 0);
    const minutes = Number(node.config?.minutes || 0);
    const hours = Number(node.config?.hours || 0);

    // Compute total delay from all duration fields
    let totalMs = Number.isFinite(baseMs) ? baseMs : 0;
    if (Number.isFinite(seconds) && seconds > 0) totalMs += seconds * 1000;
    if (Number.isFinite(minutes) && minutes > 0) totalMs += minutes * 60_000;
    if (Number.isFinite(hours) && hours > 0) totalMs += hours * 3_600_000;
    if (totalMs <= 0) totalMs = 1000; // Default 1s

    // Apply jitter
    const jitterPct = Math.min(Math.max(node.config?.jitter || 0, 0), 100);
    if (jitterPct > 0) {
      const jitterRange = totalMs * (jitterPct / 100);
      totalMs += Math.floor(Math.random() * jitterRange * 2 - jitterRange);
      totalMs = Math.max(totalMs, 100); // Floor at 100ms
    }

    const reason = ctx.resolve(node.config?.reason || node.config?.message || "");
    ctx.log(node.id, `Waiting ${totalMs}ms${reason ? ` (${reason})` : ""}`);
    await new Promise((r) => setTimeout(r, totalMs));
    return { waited: totalMs, reason };
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  VALIDATION — Verification gates
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("validation.screenshot", {
  describe: () => "Take a screenshot for visual verification and store in evidence",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to screenshot (local dev server, etc.)" },
      outputDir: { type: "string", default: ".bosun/evidence", description: "Directory to save screenshots" },
      filename: { type: "string", description: "Screenshot filename (auto-generated if empty)" },
      fullPage: { type: "boolean", default: true },
      viewport: {
        type: "object",
        properties: {
          width: { type: "number", default: 1280 },
          height: { type: "number", default: 720 },
        },
      },
      waitMs: { type: "number", default: 2000, description: "Wait time before screenshot" },
    },
    required: ["url"],
  },
  async execute(node, ctx, engine) {
    const url = ctx.resolve(node.config?.url || "http://localhost:3000");
    const outDir = ctx.resolve(node.config?.outputDir || ".bosun/evidence");
    const filename = ctx.resolve(node.config?.filename || `screenshot-${Date.now()}.png`);
    const fullPage = node.config?.fullPage !== false;
    const viewport = node.config?.viewport || { width: 1280, height: 720 };
    const waitMs = node.config?.waitMs || 2000;

    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, filename);

    ctx.log(node.id, `Taking screenshot of ${url}`);

    // Try multiple screenshot methods in order of preference
    // 1. Playwright (if available)
    // 2. Puppeteer (if available)
    // 3. Agent-based (ask agent to take screenshot via MCP)
    // 4. Fallback: generate a placeholder and note for manual

    const screenshotMethods = [
      {
        name: "playwright",
        test: () => {
          try { execSync("npx playwright --version", { stdio: "pipe", timeout: 10000 }); return true; } catch { return false; }
        },
        exec: () => {
          const script = `
            const { chromium } = require('playwright');
            (async () => {
              const browser = await chromium.launch({ headless: true });
              const page = await browser.newPage({ viewport: { width: ${viewport.width}, height: ${viewport.height} } });
              await page.goto('${url}', { waitUntil: 'networkidle' });
              await page.waitForTimeout(${waitMs});
              await page.screenshot({ path: '${outPath.replace(/\\/g, "\\\\")}', fullPage: ${fullPage} });
              await browser.close();
            })();
          `;
          const runRes = spawnSync("node", ["-e", script], {
            timeout: 60000,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
            shell: false,
          });
          if (runRes.status !== 0) {
            throw new Error((runRes.stderr || runRes.stdout || "Playwright screenshot command failed").trim());
          }
        },
      },
      {
        name: "mcp-devtools",
        test: () => true, // always available as a prompt option
        exec: () => {
          // This will be executed by the agent via MCP chrome devtools
          ctx.data._pendingScreenshots = ctx.data._pendingScreenshots || [];
          ctx.data._pendingScreenshots.push({
            url,
            outPath,
            viewport,
            fullPage,
            waitMs,
          });
          // Write metadata file for the agent to process
          writeFileSync(
            resolve(outDir, `${filename}.meta.json`),
            JSON.stringify({ url, viewport, fullPage, waitMs, createdAt: Date.now() }, null, 2),
            "utf8"
          );
        },
      },
    ];

    let method = "none";
    for (const m of screenshotMethods) {
      try {
        if (m.test()) {
          m.exec();
          method = m.name;
          break;
        }
      } catch (err) {
        ctx.log(node.id, `Screenshot method ${m.name} failed: ${err.message}`, "warn");
      }
    }

    return {
      success: true,
      screenshotPath: outPath,
      method,
      url,
      viewport,
    };
  },
});

registerBuiltinNodeType("validation.model_review", {
  describe: () => "Send evidence (screenshots, code, logs) to a non-agent model for independent verification",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence", description: "Directory with evidence files" },
      originalTask: { type: "string", description: "Original task description for context" },
      criteria: { type: "string", description: "Specific acceptance criteria to verify" },
      model: { type: "string", default: "auto", description: "Model to use for review" },
      strictMode: { type: "boolean", default: true, description: "Require explicit PASS to succeed" },
    },
    required: ["originalTask"],
  },
  async execute(node, ctx, engine) {
    const evidenceDir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    const originalTask = ctx.resolve(node.config?.originalTask || "");
    const criteria = ctx.resolve(node.config?.criteria || "");
    const strictMode = node.config?.strictMode !== false;

    ctx.log(node.id, `Model review: checking evidence in ${evidenceDir}`);

    // Collect evidence files
    const evidenceFiles = [];
    if (existsSync(evidenceDir)) {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(evidenceDir);
      for (const file of files) {
        if (file.endsWith(".meta.json")) continue;
        const filePath = resolve(evidenceDir, file);
        evidenceFiles.push({
          name: file,
          path: filePath,
          type: file.endsWith(".png") || file.endsWith(".jpg") ? "image" : "text",
        });
      }
    }

    if (evidenceFiles.length === 0) {
      ctx.log(node.id, "No evidence files found", "warn");
      return { passed: false, reason: "no_evidence", evidenceCount: 0 };
    }

    // Build the review prompt
    const reviewPrompt = `# Task Verification Review

## Original Task
${originalTask}

${criteria ? `## Acceptance Criteria\n${criteria}\n` : ""}

## Evidence Files
${evidenceFiles.map((f) => `- ${f.name} (${f.type})`).join("\n")}

## Instructions
Review the provided evidence (screenshots, code changes, logs) against the original task requirements.

Provide your assessment:
1. Does the implementation match the task requirements?
2. Are there any visual/functional issues visible in the screenshots?
3. Is the implementation complete or are there missing pieces?

## Verdict
Respond with exactly one of:
- **PASS** — Implementation meets all requirements
- **FAIL** — Implementation has issues (explain what's wrong)
- **PARTIAL** — Some requirements met but not all (explain what's missing)
`;

    // Use the agent pool for a non-agent model review
    const agentPool = engine.services?.agentPool;
    if (agentPool?.launchEphemeralThread) {
      const result = await agentPool.launchEphemeralThread(
        reviewPrompt,
        process.cwd(),
        5 * 60 * 1000, // 5-minute timeout for review
        { images: evidenceFiles.filter((f) => f.type === "image").map((f) => f.path) }
      );

      const output = result.output || "";
      const passed = strictMode
        ? /\bPASS\b/i.test(output) && !/\bFAIL\b/i.test(output)
        : !/\bFAIL\b/i.test(output);

      // Save review result
      const reviewPath = resolve(evidenceDir, `review-${Date.now()}.json`);
      writeFileSync(
        reviewPath,
        JSON.stringify({
          passed,
          originalTask,
          criteria,
          evidenceFiles: evidenceFiles.map((f) => f.name),
          reviewOutput: output,
          model: result.sdk,
          timestamp: Date.now(),
        }, null, 2),
        "utf8"
      );

      return {
        passed,
        reviewOutput: output,
        evidenceCount: evidenceFiles.length,
        reviewPath,
      };
    }

    // Fallback: mark for manual review
    ctx.log(node.id, "Agent pool not available for model review — marking for manual review", "warn");
    return {
      passed: false,
      reason: "manual_review_required",
      evidenceCount: evidenceFiles.length,
      evidenceDir,
    };
  },
});

function formatWorkflowArtifactRetrieveCommand(filePath, platform = process.platform) {
  const normalizedPath = String(filePath || "");
  if (!normalizedPath) return null;
  if (platform === "win32") {
    return `Get-Content -Raw "${normalizedPath.replace(/"/g, '""')}"`;
  }
  return `cat '${normalizedPath.replace(/'/g, `'"'"'`)}'`;
}

function buildHeavyRunnerResultExtras(result, lane) {
  const artifacts = Array.isArray(result?.artifactPointers)
    ? result.artifactPointers.map((artifact) => ({
        label: artifact?.label || artifact?.kind || null,
        path: artifact?.path || null,
        retrieveCommand: artifact?.retrieveCommand || formatWorkflowArtifactRetrieveCommand(artifact?.path),
      }))
    : [];
  const firstArtifactPath = artifacts.find((artifact) => artifact?.path)?.path || null;
  const artifactRoot = firstArtifactPath ? dirname(firstArtifactPath) : null;
  return {
    isolatedRunner: {
      lane: lane?.lane || result?.lease?.lane || "runner-pool",
      reason: lane?.reason || result?.failureKind || "unknown",
      provider: result?.lease?.runtime || null,
      leaseId: result?.lease?.leaseId || null,
      artifactRoot,
      attempts: result?.attempts || result?.lease?.attempts || result?.lease?.attempt || 1,
      blocked: result?.blocked === true,
      artifacts,
    },
    artifactRoot,
    artifacts,
    artifactPaths: artifacts.map((artifact) => artifact.path).filter(Boolean),
    artifactRetrieveCommands: artifacts
      .map((artifact) => artifact.retrieveCommand)
      .filter(Boolean),
  };
}

async function executeValidationCommandWithOptionalRunner({
  node,
  ctx,
  nodeType,
  command,
  cwd,
  timeoutMs,
} = {}) {
  const runnerPolicy = resolveHeavyRunnerPolicy({
    nodeType,
    command,
    timeoutMs,
    runner: node.config?.runner || null,
  });
  if (runnerPolicy.lane !== "runner-pool") return null;

  ctx.log(node.id, `Offloading ${runnerPolicy.intent || "validation"} to isolated ${runnerPolicy.runtime} runner pool`);
  const run = await runCommandInHeavyRunnerLease({
    command,
    cwd,
    timeoutMs,
    intent: runnerPolicy.intent,
    runtime: runnerPolicy.runtime,
    retries: runnerPolicy.retries,
    artifactRoot: runnerPolicy.artifactDir,
    commandPrefix: runnerPolicy.commandPrefix,
    runner: node.config?.runner || null,
    nodeType,
  });
  const compacted = await compactWorkflowCommandResult({
    command,
    output: run.stdout || "",
    stderr: run.stderr || "",
    exitCode: Number.isFinite(Number(run.exitCode)) ? Number(run.exitCode) : (run.ok ? 0 : 1),
    durationMs: Number.isFinite(Number(run.durationMs)) ? Number(run.durationMs) : 0,
  });

  return {
    run,
    compacted,
    baseResult: {
      executionLane: runnerPolicy.lane,
      executionLaneReason: runnerPolicy.reason,
      runnerLease: run.lease || null,
      runnerArtifactPointers: Array.isArray(run.artifactPointers) ? run.artifactPointers : [],
      ...buildHeavyRunnerResultExtras(run, {
        lane: runnerPolicy.lane,
        reason: runnerPolicy.reason,
      }),
    },
  };
}

registerBuiltinNodeType("validation.tests", {
  describe: () => "Run test suite and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm test", description: "Test command to run" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 600000 },
      requiredPassRate: { type: "number", default: 1.0, description: "Minimum pass rate (0-1)" },
      runner: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Force isolated runner execution" },
          runtime: { type: "string", enum: ["local-process", "local-container", "remote-sandbox"], default: "local-process" },
          retries: { type: "number", default: 0 },
          artifactDir: { type: "string", description: "Directory for persisted runner stdout/stderr artifacts" },
        },
      },
    },
  },
  async execute(node, ctx, engine) {
    const command = ctx.resolve(node.config?.command || "npm test");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 600000;
    const hasRunnerOverride = node.config?.runner != null;

    ctx.log(node.id, `Running tests: ${command}`);
    const startedAt = Date.now();
    if (!hasRunnerOverride) {
      const isolatedRun = await maybeRunWorkflowCommandInIsolation({
        node,
        ctx,
        engine,
        nodeType: "validation.tests",
        command,
        cwd,
        timeoutMs: timeout,
        commandType: "test",
      });
      if (isolatedRun) {
        const failureDiagnostic = buildValidationFailureDiagnostic({
          command,
          status: isolatedRun.isolated?.status,
          exitCode: isolatedRun.isolated?.exitCode,
          stderr: isolatedRun.isolated?.stderr || isolatedRun.isolated?.error || "",
          output: isolatedRun.isolated?.stdout || "",
          timeoutMs: timeout,
          blocked: isolatedRun.isolated?.blocked === true,
          failureDiagnostic: isolatedRun.isolated?.failureDiagnostic,
        });
        return buildValidationResult({
          passed: didValidationCommandPass({ ...isolatedRun.isolated, failureDiagnostic }),
          exitCode: isolatedRun.isolated?.exitCode ?? null,
          blocked: isolatedRun.isolated?.blocked === true,
          compacted: isolatedRun.compacted,
          extras: isolatedRun.extras,
          failureDiagnostic,
        });
      }
    }
    const runnerExecution = await executeValidationCommandWithOptionalRunner({
      node,
      ctx,
      nodeType: "validation.tests",
      command,
      cwd,
      timeoutMs: timeout,
    });
    if (runnerExecution) {
      const { run, compacted, baseResult } = runnerExecution;
      ctx.log(node.id, run.ok ? "Tests passed" : (run.blocked ? "Runner lease failed" : "Tests failed"), run.ok ? undefined : "error");
      return {
        passed: run.ok,
        exitCode: run.exitCode,
        blocked: run.blocked === true,
        reason: run.blocked ? (run.failureKind || "runner_lease_failed") : undefined,
        ...baseResult,
        ...compacted,
      };
    }

    try {
      const execution = buildExecSyncOptions(command, { cwd, timeout, encoding: "utf8", stdio: "pipe" });
      const output = execSync(execution.command, execution.options);
      ctx.log(node.id, "Tests passed");
      const compacted = await compactWorkflowCommandResult({
        command,
        output: output?.trim() || "",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      });
      return { passed: true, executionLane: "main", ...compacted };
    } catch (err) {
      const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
      ctx.log(node.id, "Tests failed", "error");
      const compacted = await compactWorkflowCommandResult({
        command,
        output,
        exitCode: err.status,
        durationMs: Date.now() - startedAt,
      });
      return { passed: false, exitCode: err.status, executionLane: "main", ...compacted };
    }
  },
});

registerBuiltinNodeType("validation.build", {
  describe: () => "Run build and verify it succeeds with 0 errors",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run build", description: "Build command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 600000 },
      zeroWarnings: { type: "boolean", default: false, description: "Fail on warnings too" },
      runner: {
        type: "object",
        properties: {
          enabled: { type: "boolean", description: "Force isolated runner execution" },
          runtime: { type: "string", enum: ["local-process", "local-container", "remote-sandbox"], default: "local-process" },
          retries: { type: "number", default: 0 },
          artifactDir: { type: "string", description: "Directory for persisted runner stdout/stderr artifacts" },
        },
      },
    },
  },
  async execute(node, ctx, engine) {
    const resolvedCommand = ctx.resolve(node.config?.command || "npm run build");
    const command = normalizeLegacyWorkflowCommand(resolvedCommand);
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 600000;
    const hasRunnerOverride = node.config?.runner != null;

    if (command !== resolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    ctx.log(node.id, `Building: ${command}`);
    const startedAt = Date.now();
    if (!hasRunnerOverride) {
      const isolatedRun = await maybeRunWorkflowCommandInIsolation({
        node,
        ctx,
        engine,
        nodeType: "validation.build",
        command,
        cwd,
        timeoutMs: timeout,
        commandType: "build",
      });
      if (isolatedRun) {
        const combinedOutput = `${isolatedRun.isolated?.stdout || ""}\n${isolatedRun.isolated?.stderr || ""}`;
        const hasWarnings = /warning/i.test(combinedOutput);
        if (node.config?.zeroWarnings && hasWarnings) {
          return {
            passed: false,
            reason: "warnings_found",
            exitCode: isolatedRun.isolated?.exitCode ?? 0,
            blocked: isolatedRun.isolated?.blocked === true,
            executionLane: isolatedRun.lane?.lane || "isolated",
            executionLaneReason: isolatedRun.lane?.reason || "isolated",
            ...isolatedRun.extras,
            ...isolatedRun.compacted,
          };
        }
        return {
          passed:
            isolatedRun.isolated?.blocked !== true &&
            Number(isolatedRun.isolated?.exitCode ?? 0) === 0,
          exitCode: isolatedRun.isolated?.exitCode ?? null,
          blocked: isolatedRun.isolated?.blocked === true,
          executionLane: isolatedRun.lane?.lane || "isolated",
          executionLaneReason: isolatedRun.lane?.reason || "isolated",
          ...isolatedRun.extras,
          ...isolatedRun.compacted,
        };
      }
    }
    const runnerExecution = await executeValidationCommandWithOptionalRunner({
      node,
      ctx,
      nodeType: "validation.build",
      command,
      cwd,
      timeoutMs: timeout,
    });
    if (runnerExecution) {
      const { run, compacted, baseResult } = runnerExecution;
      const combinedOutput = `${run.stdout || ""}\n${run.stderr || ""}`;
      const hasWarnings = /warning/i.test(combinedOutput);
      ctx.log(node.id, run.ok ? "Build completed" : (run.blocked ? "Runner lease failed" : "Build failed"), run.ok ? undefined : "error");
      if (run.ok && node.config?.zeroWarnings && hasWarnings) {
        return {
          passed: false,
          reason: "warnings_found",
          exitCode: run.exitCode,
          ...baseResult,
          ...compacted,
        };
      }
      return {
        passed: run.ok,
        exitCode: run.exitCode,
        blocked: run.blocked === true,
        reason: run.blocked ? (run.failureKind || "runner_lease_failed") : undefined,
        ...baseResult,
        ...compacted,
      };
    }

    try {
      const execution = buildExecSyncOptions(command, { cwd, timeout, encoding: "utf8", stdio: "pipe" });
      const output = execSync(execution.command, execution.options);
      const hasWarnings = /warning/i.test(output || "");
      const compacted = await compactWorkflowCommandResult({
        command,
        output: output?.trim() || "",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      });
      if (node.config?.zeroWarnings && hasWarnings) {
        return { passed: false, reason: "warnings_found", executionLane: "main", ...compacted };
      }
      return { passed: true, executionLane: "main", ...compacted };
    } catch (err) {
      const compacted = await compactWorkflowCommandResult({
        command,
        output: err.stdout?.toString() || "",
        stderr: err.stderr?.toString() || err.message,
        exitCode: err.status,
        durationMs: Date.now() - startedAt,
      });
      return { passed: false, exitCode: err.status, executionLane: "main", ...compacted };
    }
  },
});

registerBuiltinNodeType("validation.lint", {
  describe: () => "Run linter and verify results",
  schema: {
    type: "object",
    properties: {
      command: { type: "string", default: "npm run lint", description: "Lint command" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", default: 120000 },
    },
  },
  async execute(node, ctx, engine) {
    const command = ctx.resolve(node.config?.command || "npm run lint");
    if (!command || !command.trim()) {
      return { passed: true, output: "no lint configured", skipped: true };
    }
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const timeout = node.config?.timeoutMs || 120000;
    const isolatedRun = await maybeRunWorkflowCommandInIsolation({
      node,
      ctx,
      engine,
      nodeType: "validation.lint",
      command,
      cwd,
      timeoutMs: timeout,
      commandType: "qualityGate",
    });
    if (isolatedRun) {
      const failureDiagnostic = buildValidationFailureDiagnostic({
        command,
        status: isolatedRun.isolated?.status,
        exitCode: isolatedRun.isolated?.exitCode,
        stderr: isolatedRun.isolated?.stderr || isolatedRun.isolated?.error || "",
        output: isolatedRun.isolated?.stdout || "",
        timeoutMs: timeout,
        blocked: isolatedRun.isolated?.blocked === true,
        failureDiagnostic: isolatedRun.isolated?.failureDiagnostic,
      });
      return buildValidationResult({
        passed: didValidationCommandPass({ ...isolatedRun.isolated, failureDiagnostic }),
        exitCode: isolatedRun.isolated?.exitCode ?? null,
        blocked: isolatedRun.isolated?.blocked === true,
        compacted: isolatedRun.compacted,
        extras: isolatedRun.extras,
        failureDiagnostic,
      });
    }
    const startedAt = Date.now();
    try {
      const execution = buildExecSyncOptions(command, { cwd, timeout, encoding: "utf8", stdio: "pipe" });
      const output = execSync(execution.command, execution.options);
      const compacted = await compactWorkflowCommandResult({
        command,
        output: output?.trim() || "",
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      });
      return { passed: true, ...compacted };
    } catch (err) {
      const compacted = await compactWorkflowCommandResult({
        command,
        output: err.stdout?.toString() || "",
        stderr: err.stderr?.toString() || err.message,
        exitCode: err.status,
        durationMs: Date.now() - startedAt,
      });
      const failureDiagnostic = buildValidationFailureDiagnostic({
        command,
        status: /(?:timed out|ETIMEDOUT|SIGTERM)/i.test(String(err?.message || "")) ? "timeout" : "error",
        exitCode: err.status,
        stderr: err.stderr?.toString() || err.message,
        output: err.stdout?.toString() || "",
        timeoutMs: timeout,
      });
      return buildValidationResult({
        passed: false,
        exitCode: err.status,
        compacted,
        failureDiagnostic,
      });
    }
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  TRANSFORM — Data manipulation
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("transform.json_parse", {
  describe: () => "Parse JSON from a previous node's output",
  schema: {
    type: "object",
    properties: {
      input: { type: "string", description: "Source: node ID or {{variable}}" },
      field: { type: "string", description: "Field in source output containing JSON" },
    },
  },
  async execute(node, ctx, engine) {
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

registerBuiltinNodeType("transform.template", {
  describe: () => "Render a text template with context variables",
  schema: {
    type: "object",
    properties: {
      template: { type: "string", description: "Template text with {{variables}}" },
    },
    required: ["template"],
  },
  async execute(node, ctx, engine) {
    const result = ctx.resolve(node.config?.template || "");
    return { text: result };
  },
});

registerBuiltinNodeType("transform.aggregate", {
  describe: () => "Aggregate outputs from multiple nodes into a single object",
  schema: {
    type: "object",
    properties: {
      sources: { type: "array", items: { type: "string" }, description: "Node IDs to aggregate" },
    },
  },
  async execute(node, ctx, engine) {
    const sources = node.config?.sources || [];
    const aggregated = {};
    for (const src of sources) {
      aggregated[src] = ctx.getNodeOutput(src);
    }
    return { aggregated, count: sources.length };
  },
});

registerBuiltinNodeType("transform.llm_parse", {
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
  async execute(node, ctx, engine) {
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

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  NOTIFY — Notifications
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("notify.log", {
  describe: () => "Log a message (to console and workflow run log)",
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to log (supports {{variables}})" },
      level: { type: "string", enum: ["info", "warn", "error"], default: "info" },
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const message = ctx.resolve(node.config?.message || "");
    const level = node.config?.level || "info";
    ctx.log(node.id, message, level);
    console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`${TAG} ${message}`);
    return { logged: true, message };
  },
});

registerBuiltinNodeType("notify.telegram", {
  describe: () => "Send a message to Telegram chat",
  schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message text (supports {{variables}} and Markdown)" },
      chatId: { type: "string", description: "Chat ID (uses default if empty)" },
      silent: { type: "boolean", default: false },
      parseMode: { type: "string", enum: ["Markdown", "MarkdownV2", "HTML"], description: "Optional Telegram parse mode" },
    },
    required: ["message"],
  },
  async execute(node, ctx, engine) {
    const message = normalizeWorkflowTelegramText(ctx.resolve(node.config?.message || ""));
    const telegram = engine.services?.telegram;
    const options = {
      silent: node.config?.silent,
      parseMode: node.config?.parseMode || undefined,
    };

    if (telegram?.sendMessage) {
      await telegram.sendMessage(
        node.config?.chatId || undefined,
        message,
        options,
      );
      return { sent: true, message };
    }
    ctx.log(node.id, "Telegram service not available", "warn");
    return { sent: false, reason: "no_telegram" };
  },
});

registerBuiltinNodeType("notify.webhook_out", {
  describe: () => "Send an HTTP webhook notification",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Webhook URL" },
      method: { type: "string", default: "POST" },
      body: { type: "object", description: "Request body (supports {{variables}} in string values)" },
      headers: { type: "object" },
    },
    required: ["url"],
  },
  async execute(node, ctx, engine) {
    const url = ctx.resolve(node.config?.url || "");
    const method = node.config?.method || "POST";
    const body = node.config?.body ? JSON.stringify(node.config.body) : undefined;

    ctx.log(node.id, `Webhook ${method} to ${url}`);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...node.config?.headers,
        },
        body,
      });
      return { success: resp.ok, status: resp.status };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

registerNodeType("action.emit_event", {
  describe: () =>
    "Emit an internal workflow event and optionally dispatch matching trigger.event workflows",
  schema: {
    type: "object",
    properties: {
      eventType: { type: "string", description: "Event type to emit (for example session-stuck)" },
      payload: {
        type: "object",
        description: "Event payload object forwarded to matching workflows",
        additionalProperties: true,
      },
      dispatch: {
        type: "boolean",
        default: true,
        description: "When true, evaluate and execute matching event-trigger workflows",
      },
      includeCurrentWorkflow: {
        type: "boolean",
        default: false,
        description: "Allow dispatching the currently running workflow if it matches",
      },
      outputVariable: {
        type: "string",
        description: "Optional context key where event output will be stored",
      },
    },
    required: ["eventType"],
  },
  async execute(node, ctx, engine) {
    const eventType = String(ctx.resolve(node.config?.eventType || "") || "").trim();
    if (!eventType) throw new Error("action.emit_event: 'eventType' is required");

    const payload = resolveWorkflowNodeValue(node.config?.payload ?? {}, ctx);
    const shouldDispatch = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.dispatch ?? true, ctx),
      true,
    );
    const includeCurrentWorkflow = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.includeCurrentWorkflow ?? false, ctx),
      false,
    );
    const currentWorkflowId = String(ctx.data?._workflowId || "").trim();

    const output = {
      success: true,
      eventType,
      payload,
      dispatched: false,
      dispatchCount: 0,
      matched: [],
      runs: [],
    };

    if (shouldDispatch && engine?.evaluateTriggers && engine?.execute) {
      const matched = await engine.evaluateTriggers(eventType, payload || {});
      output.matched = matched;
      for (const trigger of matched) {
        const workflowId = String(trigger?.workflowId || "").trim();
        if (!workflowId) continue;
        if (!includeCurrentWorkflow && currentWorkflowId && workflowId === currentWorkflowId) {
          continue;
        }
        try {
          const childCtx = await engine.execute(
            workflowId,
            applyChildWorkflowLineage(ctx, {
              ...(payload && typeof payload === "object" ? payload : {}),
              eventType,
              _triggerSource: "workflow.emit_event",
              _triggeredByWorkflowId: currentWorkflowId || null,
              _triggeredByRunId: ctx.id,
            }, workflowId),
            {
              ...makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: workflowId, sourceNodeId: node.id }),
              force: true,
            },
          );
          const childErrors = Array.isArray(childCtx?.errors) ? childCtx.errors : [];
          output.runs.push({
            workflowId,
            runId: childCtx?.id || null,
            status: childErrors.length > 0 ? "failed" : "completed",
          });
        } catch (err) {
          output.runs.push({
            workflowId,
            runId: null,
            status: "failed",
            error: err?.message || String(err),
          });
        }
      }
      output.dispatchCount = output.runs.length;
      output.dispatched = output.dispatchCount > 0;
    }

    if (ctx?.data && typeof ctx.data === "object") {
      ctx.data.eventType = eventType;
      ctx.data.eventPayload = payload;
    }

    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }

    ctx.log(
      node.id,
      `Emitted event ${eventType} (dispatch=${output.dispatched}, runs=${output.dispatchCount})`,
    );
    return output;
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  AGENT-SPECIFIC — Specialized agent operations
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("agent.select_profile", {
  describe: () => "Select an agent profile based on task characteristics",
  schema: {
    type: "object",
    properties: {
      profiles: {
        type: "object",
        description: "Map of profile name → matching criteria",
        additionalProperties: {
          type: "object",
          properties: {
            titlePatterns: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            filePatterns: { type: "array", items: { type: "string" } },
          },
        },
      },
      default: { type: "string", default: "general", description: "Default profile if no match" },
    },
  },
  async execute(node, ctx, engine) {
    const profiles = node.config?.profiles || {};
    const taskTitle = (ctx.data?.taskTitle || "").toLowerCase();
    const taskTags = (ctx.data?.taskTags || []).map((t) => t.toLowerCase());

    for (const [profileName, criteria] of Object.entries(profiles)) {
      // Check title patterns
      if (criteria.titlePatterns) {
        for (const pattern of criteria.titlePatterns) {
          if (new RegExp(pattern, "i").test(taskTitle)) {
            ctx.log(node.id, `Matched profile "${profileName}" via title pattern`);
            return { profile: profileName, matchedBy: "title" };
          }
        }
      }
      // Check tags
      if (criteria.tags) {
        for (const tag of criteria.tags) {
          if (taskTags.includes(tag.toLowerCase())) {
            ctx.log(node.id, `Matched profile "${profileName}" via tag`);
            return { profile: profileName, matchedBy: "tag" };
          }
        }
      }
    }

    const defaultProfile = node.config?.default || "general";
    ctx.log(node.id, `No profile matched, using default: ${defaultProfile}`);
    return { profile: defaultProfile, matchedBy: "default" };
  },
});

function parsePlannerJsonFromText(value, { strictFence = false } = {}) {
  const text = normalizeLineEndings(String(value || ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    // Strip common agent prefixes: "Agent: ", "Assistant: ", etc.
    .replace(/^\s*(?:Agent|Assistant|Planner|Output)\s*:\s*/i, "")
    .trim();
  if (!text) return null;

  if (strictFence) {
    const strictMatch = text.match(/^```json\s*([\s\S]*?)\s*```$/i);
    if (!strictMatch) return null;
    try {
      const parsed = JSON.parse(String(strictMatch[1] || "").trim());
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  const candidates = [];
  // Match fenced blocks (```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = String(match[1] || "").trim();
    if (body) candidates.push(body);
  }
  // Also try stripped text without fences as raw JSON
  const strippedText = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  if (strippedText && !candidates.includes(strippedText)) {
    candidates.push(strippedText);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try extracting a balanced object from prose-wrapped output.
    }

    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const jsonSlice = candidate.slice(start, i + 1);
          try {
            const parsed = JSON.parse(jsonSlice);
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            // Keep scanning.
          }
        }
      }
    }
  }

  return null;
}

const PLANNER_SCORE_MAX = 10;
const PLANNER_RISK_LEVELS = ["low", "medium", "high", "critical"];
const PLANNER_RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
const CALIBRATED_MIN_IMPACT_SCORE = 7;
const CALIBRATED_MAX_RISK_WITHOUT_HUMAN = "medium";
const PLANNER_SCORE_MODE_RATIO = "ratio";
const PLANNER_SCORE_MODE_TEN = "ten";

function parsePlannerNumericScore(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? { numeric: value, scale: null } : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;

  const ratioMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(1|10|100)$/);
  if (ratioMatch) {
    const numeric = Number(ratioMatch[1]);
    const denom = Number(ratioMatch[2]);
    if (!Number.isFinite(numeric) || !Number.isFinite(denom) || denom <= 0) return null;
    return { numeric, scale: denom };
  }

  const percentMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (percentMatch) {
    const numeric = Number(percentMatch[1]);
    if (!Number.isFinite(numeric)) return null;
    return { numeric, scale: 100 };
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return { numeric, scale: null };
}

function normalizePlannerScore(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const parsed = parsePlannerNumericScore(value);
  if (!parsed) return null;

  let scaled = parsed.numeric;
  if (parsed.scale === 1) {
    scaled = parsed.numeric * PLANNER_SCORE_MAX;
  } else if (parsed.scale === 100) {
    scaled = parsed.numeric / 10;
  } else if (parsed.scale === 10) {
    scaled = parsed.numeric;
  } else if (scaled > 10 && scaled <= 100) {
    scaled = scaled / 10;
  } else if (scaled > 0 && scaled < 1) {
    const hasFractionalPart = Math.abs((scaled % 1)) > Number.EPSILON;
    if (!(preserveFractionalTenScale && hasFractionalPart)) {
      scaled = scaled * PLANNER_SCORE_MAX;
    }
  } else if (scaled === 1) {
    scaled = preferTenScaleIntegers ? 1 : PLANNER_SCORE_MAX;
  }

  const clamped = Math.max(0, Math.min(PLANNER_SCORE_MAX, scaled));
  return Math.round(clamped * 10) / 10;
}

function inferPlannerTaskScoreMode(task) {
  if (!task || typeof task !== "object") return PLANNER_SCORE_MODE_RATIO;
  const candidates = [task.impact, task.confidence, task.risk];
  for (const candidate of candidates) {
    const parsed = parsePlannerNumericScore(candidate);
    if (!parsed) continue;
    if (parsed.scale === 10) return PLANNER_SCORE_MODE_TEN;
    if (parsed.scale === 1 || parsed.scale === 100) return PLANNER_SCORE_MODE_RATIO;
    if (parsed.numeric > 1 && parsed.numeric <= PLANNER_SCORE_MAX) return PLANNER_SCORE_MODE_TEN;
    if (parsed.numeric > PLANNER_SCORE_MAX && parsed.numeric <= 100) return PLANNER_SCORE_MODE_RATIO;
  }
  return PLANNER_SCORE_MODE_RATIO;
}

function normalizePlannerRiskLevel(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (PLANNER_RISK_LEVELS.includes(raw)) return raw;

  if (raw) {
    if (/\b(critical|catastrophic|severe|blocker|sev[\s-]*0|sev[\s-]*1|data\s+loss|outage|downtime|rce)\b/.test(raw)) return "critical";
    if (/\b(high|significant|major|risky|dangerous|blast\s+radius|customer[\s-]*impact|security|compliance|incident|breaking\s+change|migration\s+risk)\b/.test(raw)) return "high";
    if (/\b(medium|moderate)\b/.test(raw)) return "medium";
    if (/\b(low|minor|trivial|safe)\b/.test(raw)) return "low";
  }

  const numeric = normalizePlannerScore(value, { preferTenScaleIntegers, preserveFractionalTenScale });
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 9) return "critical";
  if (numeric >= 7) return "high";
  if (numeric >= 4) return "medium";
  return "low";
}

function normalizePlannerTaskForCreation(task, index) {
  if (!task || typeof task !== "object") return null;
  const title = String(task.title || "").trim();
  if (!title) return null;

  const normalizeStringList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  };
  const normalizeRepoAreas = (value) => {
    const list = normalizeStringList(value);
    if (!list.length) return [];
    const dedup = new Set();
    const normalized = [];
    for (const area of list) {
      const key = area.toLowerCase();
      if (dedup.has(key)) continue;
      dedup.add(key);
      normalized.push(area);
    }
    return normalized;
  };
  const normalizeOptionalStringList = (value) => {
    if (Array.isArray(value)) return normalizeStringList(value);
    const entry = String(value || "").trim();
    return entry ? [entry] : [];
  };
  const normalizeScore = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(10, Math.round(numeric)));
  };
  const normalizeRiskLevel = (value) => {
    const raw = String(value || "").trim().toLowerCase();
    if (["low", "medium", "high", "critical"].includes(raw)) return raw;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    if (numeric >= 9) return "critical";
    if (numeric >= 7) return "high";
    if (numeric >= 4) return "medium";
    return "low";
  };
  const normalizeArchetype = (value) => {
    const normalized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || "";
  };
  const normalizeTaskGraphKey = (value, fallback = "") => {
    const normalized = String(value || fallback || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || "";
  };
  const inferArchetype = () => {
    const explicit =
      task.archetype ||
      task.task_archetype ||
      task.taskArchetype ||
      task.pattern ||
      "";
    const normalizedExplicit = normalizeArchetype(explicit);
    if (normalizedExplicit) return normalizedExplicit;
    const conventional = title
      .toLowerCase()
      .match(/^(?:\[[^\]]+\]\s*)?([a-z][a-z0-9_-]*)(?:\([^)]*\))?:/);
    if (conventional?.[1]) return normalizeArchetype(conventional[1]);
    if (title.toLowerCase().includes("test")) return "test";
    if (title.toLowerCase().includes("doc")) return "docs";
    if (title.toLowerCase().includes("refactor")) return "refactor";
    return "general";
  };
  const scoreMode = inferPlannerTaskScoreMode(task);
  const preferTenScaleIntegers = scoreMode === PLANNER_SCORE_MODE_TEN;

  const lines = [];
  const description = String(task.description || "").trim();
  if (description) lines.push(description);
  const acceptanceCriteria = normalizeStringList(task.acceptance_criteria);
  const verification = normalizeStringList(task.verification);
  const repoAreas = normalizeRepoAreas(task.repo_areas || task.repoAreas);
  const impact = normalizePlannerScore(task.impact, { preferTenScaleIntegers });
  const confidence = normalizePlannerScore(task.confidence, { preferTenScaleIntegers });
  const risk = normalizePlannerRiskLevel(task.risk, {
    preferTenScaleIntegers,
    preserveFractionalTenScale: scoreMode === PLANNER_SCORE_MODE_TEN,
  });
  const estimatedEffort = String(task.estimated_effort || task.estimatedEffort || "").trim().toLowerCase();
  const whyNow = String(task.why_now || task.whyNow || "").trim();
  const killCriteria = normalizeStringList(task.kill_criteria || task.killCriteria);
  const archetype = inferArchetype();
  const taskKey = normalizeTaskGraphKey(
    task.task_key || task.taskKey || task.key || task.id || "",
    title,
  );
  const parentTaskKey = normalizeTaskGraphKey(
    task.parent_task_key ||
      task.parentTaskKey ||
      task.parent_key ||
      task.parentKey ||
      task.parent_task_title ||
      task.parentTaskTitle ||
      task.parent_title ||
      task.parentTitle ||
      "",
  );
  const parentTaskId = String(task.parent_task_id || task.parentTaskId || "").trim() || null;
  const dependencyTaskKeys = Array.from(new Set([
    ...normalizeOptionalStringList(task.depends_on_task_keys),
    ...normalizeOptionalStringList(task.dependsOnTaskKeys),
    ...normalizeOptionalStringList(task.dependency_keys),
    ...normalizeOptionalStringList(task.dependencyKeys),
    ...normalizeOptionalStringList(task.depends_on_titles),
    ...normalizeOptionalStringList(task.dependsOnTitles),
    ...normalizeOptionalStringList(task.dependency_titles),
    ...normalizeOptionalStringList(task.dependencyTitles),
  ].map((entry) => normalizeTaskGraphKey(entry)).filter(Boolean)));
  const dependencyTaskIds = Array.from(new Set([
    ...normalizeOptionalStringList(task.depends_on_task_ids),
    ...normalizeOptionalStringList(task.dependsOnTaskIds),
    ...normalizeOptionalStringList(task.dependency_task_ids),
    ...normalizeOptionalStringList(task.dependencyTaskIds),
  ].map((entry) => String(entry || "").trim()).filter(Boolean)));
  const decompositionKind = String(task.decomposition_kind || task.decompositionKind || "").trim().toLowerCase() || null;
  const spawnWhen = String(task.spawn_when || task.spawnWhen || "").trim() || null;
  const mergeBackPolicy = String(task.merge_back_policy || task.mergeBackPolicy || "").trim() || null;

  const appendList = (heading, values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const items = values
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!items.length) return;
    lines.push("", `## ${heading}`);
    for (const item of items) lines.push(`- ${item}`);
  };

  appendList("Implementation Steps", task.implementation_steps);
  appendList("Acceptance Criteria", acceptanceCriteria);
  appendList("Verification", verification);

  const baseBranch = String(task.base_branch || "").trim();
  const workspace = String(task.workspace || "").trim();
  const repository = String(task.repository || task.repo || "").trim();
  const repositories = Array.isArray(task.repositories)
    ? task.repositories.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const priority = String(task.priority || "").trim().toLowerCase();
  const tags = Array.isArray(task.tags || task.labels)
    ? (task.tags || task.labels)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
    : [];
  const requestedStatus = String(task.status || "").trim().toLowerCase();
  const draft = Boolean(task.draft || requestedStatus === "draft");
  if (baseBranch) {
    lines.push("", `Base branch: \`${baseBranch}\``);
  }

  return {
    title,
    description: lines.join("\n").trim(),
    index,
    baseBranch: baseBranch || null,
    workspace: workspace || null,
    repository: repository || null,
    repositories,
    priority: ["low", "medium", "high", "critical"].includes(priority) ? priority : null,
    tags,
    draft,
    requestedStatus: requestedStatus || null,
    acceptanceCriteria,
    verification,
    repoAreas,
    impact,
    confidence,
    risk,
    archetype,
    estimatedEffort: estimatedEffort || null,
    whyNow: whyNow || null,
    killCriteria: killCriteria.length > 0 ? killCriteria : null,
    taskKey: taskKey || null,
    parentTaskKey: parentTaskKey || null,
    parentTaskId,
    dependencyTaskKeys,
    dependencyTaskIds,
    decompositionKind,
    spawnWhen,
    mergeBackPolicy,
  };
}
function extractPlannerTasksFromWorkflowOutput(output, maxTasks = 5) {
  const parsed = parsePlannerJsonFromText(output);
  if (!parsed || !Array.isArray(parsed.tasks)) return [];

  const max = Number.isFinite(Number(maxTasks))
    ? Math.max(1, Math.min(100, Math.trunc(Number(maxTasks))))
    : 5;
  const dedup = new Set();
  const tasks = [];
  for (let i = 0; i < parsed.tasks.length; i += 1) {
    const normalized = normalizePlannerTaskForCreation(parsed.tasks[i], i);
    if (!normalized) continue;
    const key = normalized.title.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    tasks.push(normalized);
  }
  return tasks.slice(0, max);
}

function validateStrictPlannerTaskPayload(output, expectedTaskCount = 5, opts = {}) {
  const requireExactCount = opts?.requireExactCount === true;
  const text = normalizeLineEndings(String(output || ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    .trim();
  if (!text) {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Planner output must be raw JSON or a single fenced JSON block with shape { \"tasks\": [...] }.",
    };
  }

  const fencedMatch = text.match(/^```json\s*([\s\S]*?)\s*```$/i);
  const rawJsonText = fencedMatch ? String(fencedMatch[1] || "").trim() : text;

  let parsed = null;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Planner output must be raw JSON or a single fenced JSON block with no surrounding prose.",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "invalid_format",
      message: "Planner output must parse to an object with shape { \"tasks\": [...] }.",
    };
  }

  if (!Array.isArray(parsed.tasks)) {
    return {
      ok: false,
      reason: "missing_tasks",
      message: "Planner output JSON must include a top-level \"tasks\" array.",
    };
  }

  const expected = Number.isFinite(Number(expectedTaskCount))
    ? Math.max(1, Math.min(100, Math.trunc(Number(expectedTaskCount))))
    : 5;
  if (requireExactCount && parsed.tasks.length !== expected) {
    return {
      ok: false,
      reason: "wrong_task_count",
      message: `Planner output must contain exactly ${expected} task(s); received ${parsed.tasks.length}.`,
    };
  }

  return { ok: true, parsed };
}
async function applyPlannerTaskGraphLinks({
  createdTaskRefs = [],
  graphRootTaskId = null,
  graphRootTaskKey = "",
  kanban = null,
}) {
  if (!Array.isArray(createdTaskRefs) || createdTaskRefs.length === 0) {
    return {
      appliedParentLinks: [],
      appliedDependencyLinks: [],
      skippedGraphLinks: [],
    };
  }

  let taskStoreMod = null;
  try {
    taskStoreMod = await ensureTaskStoreMod();
  } catch {
    taskStoreMod = null;
  }

  const appliedParentLinks = [];
  const appliedDependencyLinks = [];
  const skippedGraphLinks = [];
  const createdTaskIdsByKey = new Map();
  const fallbackDependencyLists = new Map();

  for (const entry of createdTaskRefs) {
    const taskKey = String(entry?.task?.taskKey || "").trim();
    const createdTaskId = String(entry?.createdTaskId || "").trim();
    if (taskKey && createdTaskId) createdTaskIdsByKey.set(taskKey, createdTaskId);
  }

  const resolveTaskIdReference = (taskKey = "", explicitTaskId = "") => {
    const normalizedTaskId = String(explicitTaskId || "").trim();
    if (normalizedTaskId) return normalizedTaskId;
    const normalizedTaskKey = String(taskKey || "").trim();
    if (!normalizedTaskKey) return null;
    if (createdTaskIdsByKey.has(normalizedTaskKey)) return createdTaskIdsByKey.get(normalizedTaskKey);
    if (graphRootTaskId && graphRootTaskKey && normalizedTaskKey === graphRootTaskKey) return graphRootTaskId;
    return null;
  };

  for (const entry of createdTaskRefs) {
    const plannerTask = entry?.task && typeof entry.task === "object" ? entry.task : null;
    const createdTaskId = String(entry?.createdTaskId || "").trim();
    if (!plannerTask || !createdTaskId) continue;

    const parentTaskId = resolveTaskIdReference(plannerTask.parentTaskKey, plannerTask.parentTaskId)
      || (!plannerTask.parentTaskKey && !plannerTask.parentTaskId && graphRootTaskId ? graphRootTaskId : null);
    if (parentTaskId && parentTaskId !== createdTaskId) {
      let applied = false;
      if (typeof taskStoreMod?.setTaskParent === "function") {
        const updated = taskStoreMod.setTaskParent(createdTaskId, parentTaskId, {
          source: "workflow-planner",
        });
        applied = Boolean(updated);
      }
      if (!applied && typeof kanban?.updateTask === "function") {
        await kanban.updateTask(createdTaskId, {
          parentTaskId,
          meta: { parentTaskId },
        });
        applied = true;
      }
      if (applied) {
        appliedParentLinks.push({
          childTaskId: createdTaskId,
          parentTaskId,
          taskKey: plannerTask.taskKey || null,
        });
      } else {
        skippedGraphLinks.push({
          type: "parent",
          childTaskId: createdTaskId,
          parentTaskId,
          reason: "parent_task_unavailable",
          taskKey: plannerTask.taskKey || null,
        });
      }
    }

    const dependencyRefs = [
      ...(Array.isArray(plannerTask.dependencyTaskIds)
        ? plannerTask.dependencyTaskIds.map((dependencyTaskId) => ({
            dependencyTaskId,
            dependencyTaskKey: "",
          }))
        : []),
      ...(Array.isArray(plannerTask.dependencyTaskKeys)
        ? plannerTask.dependencyTaskKeys.map((dependencyTaskKey) => ({
            dependencyTaskId: "",
            dependencyTaskKey,
          }))
        : []),
    ];
    for (const dependencyRef of dependencyRefs) {
      const dependencyTaskId = resolveTaskIdReference(
        dependencyRef.dependencyTaskKey,
        dependencyRef.dependencyTaskId,
      );
      if (!dependencyTaskId || dependencyTaskId === createdTaskId) continue;
      let applied = false;
      if (typeof taskStoreMod?.addTaskDependency === "function") {
        const updated = taskStoreMod.addTaskDependency(createdTaskId, dependencyTaskId, {
          source: "workflow-planner",
        });
        applied = Boolean(updated);
      }
      if (!applied && typeof kanban?.updateTask === "function") {
        const existing = fallbackDependencyLists.get(createdTaskId) || [];
        const nextDependencies = Array.from(new Set([...existing, dependencyTaskId]));
        fallbackDependencyLists.set(createdTaskId, nextDependencies);
        await kanban.updateTask(createdTaskId, {
          meta: {
            dependencyTaskIds: nextDependencies,
          },
        });
        applied = true;
      }
      if (applied) {
        appliedDependencyLinks.push({
          taskId: createdTaskId,
          dependencyTaskId,
          dependencyTaskKey: dependencyRef.dependencyTaskKey || null,
          taskKey: plannerTask.taskKey || null,
        });
      } else {
        skippedGraphLinks.push({
          type: "dependency",
          taskId: createdTaskId,
          dependencyTaskId,
          dependencyTaskKey: dependencyRef.dependencyTaskKey || null,
          reason: "dependency_task_unavailable",
          taskKey: plannerTask.taskKey || null,
        });
      }
    }
  }

  if (typeof taskStoreMod?.waitForStoreWrites === "function") {
    await taskStoreMod.waitForStoreWrites();
  }

  return {
    appliedParentLinks,
    appliedDependencyLinks,
    skippedGraphLinks,
  };
}
function resolvePlannerMaterializationDefaults(ctx) {
  const data =
    ctx?.data && typeof ctx.data === "object" && !Array.isArray(ctx.data)
      ? ctx.data
      : {};
  const dataMeta =
    data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? data.meta
      : {};
  const workspace = String(
    data.workspace ||
      data.workspaceId ||
      data._workspace ||
      data._workspaceId ||
      dataMeta.workspace ||
      process.env.BOSUN_WORKSPACE ||
      "",
  ).trim();
  const repository = String(
    data.repository ||
      data.repo ||
      data._targetRepo ||
      dataMeta.repository ||
      process.env.GITHUB_REPOSITORY ||
      "",
  ).trim();
  return {
    workspace,
    repository,
  };
}

function normalizePlannerAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveTaskRepoAreas(task) {
  const candidates = []
    .concat(Array.isArray(task?.repo_areas) ? task.repo_areas : [])
    .concat(Array.isArray(task?.repoAreas) ? task.repoAreas : [])
    .concat(Array.isArray(task?.meta?.repo_areas) ? task.meta.repo_areas : [])
    .concat(Array.isArray(task?.meta?.repoAreas) ? task.meta.repoAreas : [])
    .concat(Array.isArray(task?.meta?.planner?.repo_areas) ? task.meta.planner.repo_areas : [])
    .concat(Array.isArray(task?.meta?.planner?.repoAreas) ? task.meta.planner.repoAreas : []);
  if (!candidates.length) return [];
  const dedup = new Set();
  const normalized = [];
  for (const entry of candidates) {
    const area = String(entry || "").trim();
    if (!area) continue;
    const key = normalizePlannerAreaKey(area);
    if (!key || dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(area);
  }
  return normalized;
}
function resolvePlannerFeedbackContext(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => resolvePlannerFeedbackContext(entry))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  if (typeof value === "object") {
    const blocks = [];
    const seen = new Set();
    const pushBlock = (label, content) => {
      const normalized = String(content || "").trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const line = label ? `${label}: ${normalized}` : normalized;
      blocks.push(line);
    };
    pushBlock("issueAdvisorSummary", value.issueAdvisorSummary ?? value.issueAdvisor?.summary);
    pushBlock("recommendedAction", value.recommendedAction ?? value.issueAdvisor?.recommendedAction);
    const nextStepLabel = String(value.issueAdvisor?.nextStepLabel || "").trim();
    const nextStepGuidance = String(
      value.nextStepGuidance ?? value.issueAdvisor?.nextStepGuidance ?? "",
    ).trim();

    const dagStateSummary = value.dagStateSummary;
    pushBlock("nextStepGuidance", nextStepGuidance);
    if (
      nextStepLabel &&
      !nextStepGuidance.toLowerCase().includes(nextStepLabel.toLowerCase())
    ) {
      pushBlock("nextStepLabel", nextStepLabel);
    }
    if (dagStateSummary && typeof dagStateSummary === "object") {
      const completed = Array.isArray(dagStateSummary.completedNodes) ? dagStateSummary.completedNodes : [];
      const pending = Array.isArray(dagStateSummary.pendingNodes) ? dagStateSummary.pendingNodes : [];
      const currentNode = dagStateSummary.currentNode && typeof dagStateSummary.currentNode === "object"
        ? dagStateSummary.currentNode
        : null;
      if (completed.length) {
        pushBlock(
          "completedNodes",
          completed.map((node) => (node.id || "unknown") + " (" + (node.label || node.id || "unlabeled") + ")").join(", "),
        );
      }
      if (currentNode) {
        pushBlock(
          "currentNode",
          (currentNode.id || "unknown") + " (" + (currentNode.label || currentNode.id || "unlabeled") + ")",
        );
      }
      if (pending.length) {
        const pendingSummary = pending
          .filter((node) => {
            const label = String(node?.label || node?.id || "").trim().toLowerCase();
            return !label || !nextStepGuidance.toLowerCase().includes(label);
          })
          .map((node) => (node.id || "unknown") + " (" + (node.label || node.id || "unlabeled") + ")")
          .join(", ");
        pushBlock("pendingNodes", pendingSummary);
      }
    }
    if (blocks.length) return blocks.join("\n");
    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

function appendPlannerFeedbackContext(baseContext, plannerFeedback, promptText = "") {
  const contextText = String(baseContext || "").trim();
  const feedbackText = String(plannerFeedback || "").trim();
  const promptBase = String(promptText || "").trim();
  if (!feedbackText) return contextText;
  const feedbackSummary = feedbackText.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || feedbackText;
  if (contextText.includes(feedbackText) || contextText.includes(feedbackSummary) || promptBase.includes(feedbackText) || promptBase.includes(feedbackSummary)) return contextText;
  return [contextText, `Planner feedback context:\n${feedbackText}`].filter(Boolean).join("\n\n");
}

function resolvePlannerFeedbackObject(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizePlannerTaskArchetype(task) {
  const explicitArchetype = String(
    task?.archetype || task?.taskArchetype || task?.task_archetype || "",
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9()_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (explicitArchetype) return explicitArchetype;
  const title = String(task?.title || "").trim().toLowerCase();
  if (!title) return "general";
  const withoutPrefix = title.replace(/^\[[^\]]+\]\s*/, "").trim();
  const scoped = withoutPrefix.match(/^([a-z][a-z0-9_-]*)\(([^)]+)\)\s*:/);
  if (scoped) return scoped[1];
  const typed = withoutPrefix.match(/^([a-z][a-z0-9_-]*)\s*:/);
  if (typed) return typed[1];
  const fallback = withoutPrefix
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("_");
  return fallback || "general";
}
function resolvePlannerPatternKeys(task) {
  const archetype = normalizePlannerTaskArchetype(task);
  const areas = resolveTaskRepoAreas(task);
  const normalizedAreas = areas.length > 0
    ? areas.map((area) => normalizePlannerAreaKey(area)).filter(Boolean)
    : ["global"];
  return normalizedAreas.map((area) => `${area}::${archetype}`);
}

function resolvePlannerDebtTrendSignal(task) {
  const numericCandidates = [
    task?.debt_trend,
    task?.debtTrend,
    task?.meta?.debt_trend,
    task?.meta?.debtTrend,
    task?.meta?.planner?.debt_trend,
    task?.meta?.planner?.debtTrend,
    task?.meta?.planner?.debt_growth,
    task?.meta?.planner?.debtGrowth,
  ];
  for (const candidate of numericCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.min(5, Math.abs(numeric)));
    }
  }

  const textCandidates = [
    task?.debt_trend,
    task?.debtTrend,
    task?.meta?.debt_trend,
    task?.meta?.debtTrend,
    task?.meta?.planner?.debt_trend,
    task?.meta?.planner?.debtTrend,
    task?.meta?.planner?.why_now,
    task?.meta?.planner?.whyNow,
    task?.description,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  for (const text of textCandidates) {
    if (/(worsen|worsening|increase|increasing|growth|growing|upward|regress)/.test(text)) {
      return 2;
    }
    if (/(stable|flat|neutral|steady)/.test(text)) {
      return 1;
    }
  }
  return 0;
}

function hasTaskCommitEvidence(task) {
  const commitCandidates = [
    task?.hasCommits,
    task?.meta?.hasCommits,
    task?.meta?.execution?.hasCommits,
    task?.meta?.execution?.commitCount,
    task?.meta?.execution?.commits,
    task?.commitCount,
    task?.commits,
    task?.meta?.commits,
  ];
  for (const candidate of commitCandidates) {
    if (typeof candidate === "boolean") return candidate;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return true;
    if (Array.isArray(candidate) && candidate.length > 0) return true;
  }
  return false;
}

function createEmptyPlannerPatternPrior() {
  return {
    failureCount: 0,
    successCount: 0,
    failureWeight: 0,
    successWeight: 0,
    failureCounter: 0,
    negativePrior: 0,
    commitlessFailureCount: 0,
    commitlessSuccessCount: 0,
    commitlessFailureCounter: 0,
    signalTotals: {
      agentAttempts: 0,
      consecutiveNoCommits: 0,
      blockedReason: 0,
      debtTrend: 0,
    },
    lastUpdatedAt: null,
  };
}

function normalizePlannerPatternPrior(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return createEmptyPlannerPatternPrior();
  }
  const base = createEmptyPlannerPatternPrior();
  const signalTotals = entry.signalTotals && typeof entry.signalTotals === "object"
    ? entry.signalTotals
    : {};
  return {
    ...base,
    ...entry,
    signalTotals: {
      agentAttempts: Number(signalTotals.agentAttempts || 0),
      consecutiveNoCommits: Number(signalTotals.consecutiveNoCommits || 0),
      blockedReason: Number(signalTotals.blockedReason || 0),
      debtTrend: Number(signalTotals.debtTrend || 0),
    },
  };
}

function resolvePlannerOutcomeSignals(task, weights) {
  const attempts = Math.max(0, Number(task?.agentAttempts || task?.meta?.agentAttempts || 0));
  const noCommits = Math.max(
    0,
    Number(task?.consecutiveNoCommits || task?.meta?.consecutiveNoCommits || 0),
  );
  const blockedReason = String(task?.blockedReason || task?.meta?.blockedReason || "").trim();
  const debtTrendSignal = resolvePlannerDebtTrendSignal(task);
  const commitEvidence = hasTaskCommitEvidence(task);
  const status = String(task?.status || "").trim().toLowerCase();
  const completedStatus = ["done", "completed", "closed", "merged"].includes(status);
  const agentAttemptsPenalty = commitEvidence ? 0 : (attempts * weights.agentAttempts);
  const consecutiveNoCommitsPenalty = noCommits * weights.consecutiveNoCommits;
  const blockedPenalty = blockedReason ? weights.blockedReason : 0;
  const debtTrendPenalty = debtTrendSignal * weights.debtTrend;

  const failureWeight =
    agentAttemptsPenalty +
    consecutiveNoCommitsPenalty +
    blockedPenalty +
    debtTrendPenalty;
  const successWeight =
    (commitEvidence ? weights.commitSuccess : 0) +
    ((completedStatus && !blockedReason) ? weights.completedSuccess : 0);
  const commitlessFailureEvent = attempts > 0 && !commitEvidence;

  return {
    attempts,
    noCommits,
    blockedReason,
    debtTrendSignal,
    commitEvidence,
    commitlessFailureEvent,
    failureWeight,
    successWeight,
    failureComponents: {
      agentAttemptsPenalty,
      consecutiveNoCommitsPenalty,
      blockedPenalty,
      debtTrendPenalty,
    },
  };
}

function resolvePlannerPriorStatePath() {
  const configured = String(process.env.BOSUN_PLANNER_PATTERN_PRIORS_FILE || "").trim();
  if (configured) return configured;
  return resolve(process.cwd(), ".bosun", "workflow-runs", "planner-pattern-priors.json");
}

function shouldPersistPlannerPriorState() {
  if (String(process.env.BOSUN_DISABLE_PLANNER_PATTERN_PRIORS || "").trim().toLowerCase() === "true") {
    return false;
  }
  if (process.env.VITEST && process.env.BOSUN_TEST_ENABLE_PLANNER_PRIOR_PERSISTENCE !== "true") {
    return false;
  }
  return true;
}

function loadPlannerPriorState(statePath) {
  const base = { version: 1, patterns: {}, outcomes: {} };
  if (!statePath || !existsSync(statePath)) return base;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return base;
    return {
      version: 1,
      patterns:
        parsed.patterns && typeof parsed.patterns === "object"
          ? Object.fromEntries(
            Object.entries(parsed.patterns).map(([key, value]) => [
              key,
              normalizePlannerPatternPrior(value),
            ]),
          )
          : {},
      outcomes: parsed.outcomes && typeof parsed.outcomes === "object" ? parsed.outcomes : {},
    };
  } catch {
    return base;
  }
}

function savePlannerPriorState(statePath, state) {
  if (!statePath) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort persistence only.
  }
}

function replayPlannerOutcomes(existingTasks, priorState, weights) {
  if (!Array.isArray(existingTasks) || existingTasks.length === 0) return;
  const nowIso = new Date().toISOString();
  const maxOutcomes = 5000;

  for (const task of existingTasks) {
    const taskId = String(task?.id || task?.task_id || "").trim();
    if (!taskId) continue;
    const keys = resolvePlannerPatternKeys(task);
    if (!keys.length) continue;
    const signals = resolvePlannerOutcomeSignals(task, weights);
    const signature = JSON.stringify({
      status: String(task?.status || "").trim().toLowerCase(),
      attempts: signals.attempts,
      noCommits: signals.noCommits,
      blockedReason: signals.blockedReason.toLowerCase(),
      debtTrendSignal: signals.debtTrendSignal,
      hasCommits: hasTaskCommitEvidence(task),
    });
    if (priorState.outcomes?.[taskId]?.signature === signature) continue;
    priorState.outcomes[taskId] = { signature, updatedAt: nowIso };

    for (const key of keys) {
      const current = normalizePlannerPatternPrior(priorState.patterns[key]);
      const priorCounter = Math.max(0, Number(current.failureCounter || 0));
      const priorCommitlessCounter = Math.max(0, Number(current.commitlessFailureCounter || 0));
      if (signals.failureWeight > 0) {
        current.failureCount = Number(current.failureCount || 0) + 1;
        current.failureWeight = Number(current.failureWeight || 0) + signals.failureWeight;
        current.signalTotals.agentAttempts += signals.failureComponents.agentAttemptsPenalty;
        current.signalTotals.consecutiveNoCommits += signals.failureComponents.consecutiveNoCommitsPenalty;
        current.signalTotals.blockedReason += signals.failureComponents.blockedPenalty;
        current.signalTotals.debtTrend += signals.failureComponents.debtTrendPenalty;
      }
      if (signals.successWeight > 0) {
        current.successCount = Number(current.successCount || 0) + 1;
        current.successWeight = Number(current.successWeight || 0) + signals.successWeight;
      }
      if (signals.commitlessFailureEvent) {
        current.commitlessFailureCount = Number(current.commitlessFailureCount || 0) + 1;
      }
      if (signals.commitEvidence) {
        current.commitlessSuccessCount = Number(current.commitlessSuccessCount || 0) + 1;
      }
      current.failureCounter = Number(
        Math.max(
          0,
          (priorCounter * 0.82) + signals.failureWeight - (signals.successWeight * 0.95),
        ).toFixed(3),
      );
      current.commitlessFailureCounter = Number(
        Math.max(
          0,
          (priorCommitlessCounter * 0.86) +
            (signals.commitlessFailureEvent ? 1.25 : 0) -
            (signals.commitEvidence ? 1.1 : 0),
        ).toFixed(3),
      );
      current.lastUpdatedAt = nowIso;
      priorState.patterns[key] = current;
    }
  }

  const outcomeEntries = Object.entries(priorState.outcomes || {});
  if (outcomeEntries.length > maxOutcomes) {
    outcomeEntries
      .sort((a, b) => String(a[1]?.updatedAt || "").localeCompare(String(b[1]?.updatedAt || "")))
      .slice(0, outcomeEntries.length - maxOutcomes)
      .forEach(([id]) => {
        delete priorState.outcomes[id];
      });
  }
}

function rankPlannerTaskCandidates(tasks, priorState, rankingConfig) {
  const scored = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const impact = Number.isFinite(task?.impact) ? Number(task.impact) : 5;
    const confidence = Number.isFinite(task?.confidence) ? Number(task.confidence) : 5;
    const riskLevel = String(task?.risk || "").trim().toLowerCase();
    const riskPenalty = ({ low: 0, medium: 0.4, high: 0.9, critical: 1.6 })[riskLevel] || 0;
    const baseScore = (impact * 1.15) + (confidence * 0.85) - riskPenalty;

    const keys = resolvePlannerPatternKeys(task);
    const penalties = keys.map((key) => {
      const prior = priorState?.patterns?.[key];
      if (!prior || typeof prior !== "object") return { key, signalPenalty: 0, negativePrior: 0 };
      const failureCount = Number(prior.failureCount || 0);
      const successCount = Number(prior.successCount || 0);
      const failureWeight = Number(prior.failureWeight || 0);
      const successWeight = Number(prior.successWeight || 0);
      const configuredNegativePrior = Math.max(0, Number(prior.negativePrior || 0));
      const failureCounter = Number(prior.failureCounter || 0);
      const commitlessFailureCounter = Number(prior.commitlessFailureCounter || 0);
      const commitlessFailureCount = Number(prior.commitlessFailureCount || 0);
      const commitlessSuccessCount = Number(prior.commitlessSuccessCount || 0);
      const netFailureEvents = Math.max(0, failureCount - successCount);
      const netFailureWeight = Math.max(0, failureWeight - successWeight);
      const netCommitlessEvents = Math.max(0, commitlessFailureCount - commitlessSuccessCount);
      const recoveredFailureCounter = Math.min(Math.max(0, failureCounter - (Math.min(successCount, failureCount) * 0.9)), Math.max(0, failureCount - successCount + 1));
      const recoveredCommitlessCounter = Math.max(
        0,
        commitlessFailureCounter - (Math.min(commitlessSuccessCount, commitlessFailureCount) * 0.85),
      );
      const repeatedFailureSignal = Math.max(
        netFailureEvents,
        recoveredFailureCounter,
        netCommitlessEvents,
        recoveredCommitlessCounter,
      );
      const recoveryDiscount = successCount >= failureCount && successCount > 0 ? 0.05 : 1;
      const signalPenalty = Math.max(
        netFailureWeight * rankingConfig.signalPenaltyScale * 0.45 * recoveryDiscount,
        recoveredFailureCounter * rankingConfig.signalPenaltyScale * 0.35 * recoveryDiscount,
      );
      const stronglyRecovered = successCount > 0 && successCount >= failureCount;
      const unrecoveredFailureSignal = Math.max(
        netFailureEvents,
        Math.max(0, repeatedFailureSignal - Math.max(0, successCount * 0.75)),
      );
      const positiveRecoveryBalance = Math.max(0, successCount - failureCount);
      const negativePrior = stronglyRecovered
        ? 0
        : (
          unrecoveredFailureSignal >= rankingConfig.failureThreshold
            ? Math.max(
              configuredNegativePrior,
              Math.min(
                rankingConfig.maxNegativePrior,
                Math.max(
                  0,
                  rankingConfig.failurePriorStep * (unrecoveredFailureSignal - rankingConfig.failureThreshold + 1) - (positiveRecoveryBalance * 6),
                ),
              ),
            )
            : 0
        );
      const recoveryBonus = stronglyRecovered
        ? Math.max(1.25, Math.min(5.5, (successCount - failureCount + 1.5) * 2.8))
        : (successCount === failureCount && successCount > 0 ? 0.3 : 0);
      return {
        key,
        signalPenalty,
        negativePrior,
        recoveryBonus,
        failureCounter: recoveredFailureCounter,
        commitlessFailureCounter: recoveredCommitlessCounter,
        netCommitlessEvents,
      };
    });
    const totalRecoveryBonus = penalties.reduce(
      (sum, item) => sum + Math.max(0, item.recoveryBonus || 0),
      0,
    );
    const totalPenalty = penalties.reduce(
      (sum, item) => sum + Math.max(0, item.signalPenalty + item.negativePrior - (item.recoveryBonus || 0)),
      0,
    );
    const averagePenalty = penalties.length > 0 ? totalPenalty / penalties.length : 0;
    const averageRecoveryBonus = penalties.length > 0 ? totalRecoveryBonus / penalties.length : 0;
    const rankScore = baseScore - averagePenalty + Math.min(0.35, averageRecoveryBonus * 0.12);

    return {
      ...task,
      _ranking: {
        baseScore: Number(baseScore.toFixed(3)),
        penalty: Number(averagePenalty.toFixed(3)),
        score: Number(rankScore.toFixed(3)),
        patternKeys: keys,
        penalties,
      },
    };
  });

  scored.sort((a, b) => {
    if ((b?._ranking?.score || 0) !== (a?._ranking?.score || 0)) {
      return (b?._ranking?.score || 0) - (a?._ranking?.score || 0);
    }
    return Number(a?.index || 0) - Number(b?.index || 0);
  });
  return scored;
}

function rankPlannerTaskCandidatesForResume(tasks, plannerFeedback) {
  const resumeFeedback =
    plannerFeedback && typeof plannerFeedback === "object" && !Array.isArray(plannerFeedback)
      ? plannerFeedback
      : null;
  const taskList = Array.isArray(tasks) ? tasks : [];
  if (!resumeFeedback) return taskList;
  const hotTaskTitles = new Set(
    Array.isArray(resumeFeedback?.taskStore?.hotTasks)
      ? resumeFeedback.taskStore.hotTasks
          .map((task) => String(task?.title || "").trim().toLowerCase())
          .filter(Boolean)
      : [],
  );

  const normalizeResumeText = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b(validate|validation|stage|step|task|handoff|planner|resume|handling)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokenizeResumeText = (value) =>
    normalizeResumeText(value)
      .split(" ")
      .map((token) => {
        if (token.length > 3 && token.endsWith("s")) {
          return token.slice(0, -1);
        }
        return token;
      })
      .filter(Boolean);
  const matchesResumeLabel = (taskTokens, taskText, labelTokens, labelText) => {
    if (!labelText) return false;
    if (taskText === labelText) return true;
    if (taskText.includes(labelText)) return true;
    return labelTokens.length > 0 && labelTokens.every((token) => taskTokens.includes(token));
  };

  const nextStepLabel = String(resumeFeedback?.issueAdvisor?.nextStepLabel || "")
    .trim()
    .toLowerCase();
  const normalizedNextStep = normalizeResumeText(nextStepLabel);
  const dagStateSummary =
    resumeFeedback?.dagStateSummary && typeof resumeFeedback.dagStateSummary === "object"
      ? resumeFeedback.dagStateSummary
      : null;

  const completedLabels = (Array.isArray(dagStateSummary?.completedNodes) ? dagStateSummary.completedNodes : [])
    .map((node) => {
      const labelText = normalizeResumeText(node?.label || node?.title || node?.name || "");
      return {
        labelText,
        labelTokens: tokenizeResumeText(labelText),
      };
    })
    .filter((entry) => entry.labelText);

  const pendingNodes = Array.isArray(dagStateSummary?.pendingNodes) ? dagStateSummary.pendingNodes : [];
  const pendingOrder = pendingNodes
    .map((pendingNode, index) => {
      const labelText = normalizeResumeText(
        pendingNode?.label || pendingNode?.title || pendingNode?.name || pendingNode?.id || "",
      );
      return {
        index,
        labelText,
        labelTokens: tokenizeResumeText(labelText),
      };
    })
    .filter((entry) => entry.labelText);

  const rankedEntries = taskList
    .map((task, originalIndex) => {
      const title = normalizeResumeText(task?.title || "");
      const titleTokens = tokenizeResumeText(title);
      const taskIndex = Number.isFinite(Number(task?.index)) ? Number(task.index) : originalIndex;
      const exactMatch = normalizedNextStep && title === normalizedNextStep;
      const containsMatch = normalizedNextStep && !exactMatch && title.includes(normalizedNextStep);
      const pendingMatch = pendingOrder.find((entry) =>
        matchesResumeLabel(titleTokens, title, entry.labelTokens, entry.labelText),
      );
      const pendingIndex = pendingMatch ? pendingMatch.index : Number.POSITIVE_INFINITY;
      const completed = completedLabels.some((entry) =>
        matchesResumeLabel(titleTokens, title, entry.labelTokens, entry.labelText),
      );
      return {
        task,
        originalIndex,
        title,
        titleTokens,
        taskIndex,
        exactMatch,
        containsMatch,
        pendingIndex,
        completed,
      };
    })
    .filter((entry) => !entry.completed);

  if (!rankedEntries.length) return [];

  const exactMatchEntry = normalizedNextStep
    ? rankedEntries.find((entry) => entry.exactMatch) || rankedEntries.find((entry) => entry.containsMatch)
    : null;

  return rankedEntries
    .slice()
    .sort((a, b) => {
      const aIsResume = exactMatchEntry ? a === exactMatchEntry : false;
      const bIsResume = exactMatchEntry ? b === exactMatchEntry : false;
      if (aIsResume !== bIsResume) return aIsResume ? -1 : 1;

      const aHasPending = Number.isFinite(a.pendingIndex);
      const bHasPending = Number.isFinite(b.pendingIndex);
      if (aHasPending !== bHasPending) return aHasPending ? -1 : 1;
      if (aHasPending && bHasPending && a.pendingIndex !== b.pendingIndex) {
        return a.pendingIndex - b.pendingIndex;
      }

      const aHot = hotTaskTitles.has(String(a.task?.title || "").trim().toLowerCase());
      const bHot = hotTaskTitles.has(String(b.task?.title || "").trim().toLowerCase());
      if (aHot !== bHot) return aHot ? 1 : -1;

      return a.taskIndex - b.taskIndex;
    })
    .map(({ task }) => task);
}
function buildPlannerSkipReasonHistogram(skipped = []) {
  const histogram = {};
  for (const entry of skipped) {
    const reason = String(entry?.reason || "unknown");
    histogram[reason] = (histogram[reason] || 0) + 1;
  }
  return histogram;
}

registerBuiltinNodeType("action.materialize_planner_tasks", {
  describe: () => "Parse planner JSON output and create backlog tasks in Kanban",
  schema: {
    type: "object",
    properties: {
      plannerNodeId: { type: "string", default: "run-planner", description: "Node ID that produced planner output" },
      maxTasks: { type: "number", default: 5, description: "Maximum number of tasks to materialize" },
      status: { type: "string", default: "todo", description: "Status for created tasks" },
      dedup: { type: "boolean", default: true, description: "Skip titles already in backlog" },
      failOnZero: { type: "boolean", default: true, description: "Fail node when zero tasks are created" },
      minCreated: { type: "number", default: 1, description: "Minimum created tasks required for success" },
      projectId: { type: "string", description: "Optional explicit project ID for list/create operations" },
      minImpactScore: { type: "number", default: CALIBRATED_MIN_IMPACT_SCORE, description: "Minimum planner impact score required for creation; accepts 0-1 or 0-10 scales" },
      maxRiskWithoutHuman: { type: "string", default: CALIBRATED_MAX_RISK_WITHOUT_HUMAN, description: "Maximum planner risk level allowed for auto-creation (low|medium|high|critical)" },
      maxConcurrentRepoAreaTasks: { type: "number", default: 0, description: "Maximum concurrent backlog tasks per repo area (0 disables limit)" },
      failurePriorThreshold: { type: "number", default: 2, description: "Net repeated failures required before applying negative priors" },
      failurePriorStep: { type: "number", default: 1.5, description: "Penalty added per repeated failure beyond threshold" },
      maxFailurePriorPenalty: { type: "number", default: 8, description: "Cap for repeated-failure negative prior penalty" },
      feedbackSignalScale: { type: "number", default: 0.12, description: "Scale factor applied to weighted feedback signal penalties" },
      applyTaskGraph: { type: "boolean", default: true, description: "Apply parent/dependency graph links from planner output when supported" },
      parentTaskId: { type: "string", description: "Optional existing task ID to use as the parent for top-level planned tasks" },
    },
  },
  async execute(node, ctx, engine) {
    recordPlannerLedgerEvent(engine, ctx, node, "planner.step_started", {
      phase: "materialize",
      label: "materialize-planner-tasks",
      status: "running",
      meta: {
        plannerNodeId: String(ctx.resolve(node.config?.plannerNodeId || "run-planner")).trim() || "run-planner",
      },
    });
    const plannerNodeId = String(ctx.resolve(node.config?.plannerNodeId || "run-planner")).trim() || "run-planner";
    const plannerOutput = ctx.getNodeOutput(plannerNodeId) || {};
    const outputText = String(plannerOutput?.output || "").trim();
    const plannerPayload = parsePlannerJsonFromText(outputText);
    const maxTasks = Number(ctx.resolve(node.config?.maxTasks || ctx.data?.taskCount || 5)) || 5;
    const failOnZero = node.config?.failOnZero !== false;
    const minCreated = Number(ctx.resolve(node.config?.minCreated || 1)) || 1;
    const dedupEnabled = node.config?.dedup !== false;
    const status = String(ctx.resolve(node.config?.status || "todo")).trim() || "todo";
    const projectId = String(ctx.resolve(node.config?.projectId || "")).trim();
    const minImpactScore = normalizePlannerScore(
      ctx.resolve(node.config?.minImpactScore ?? CALIBRATED_MIN_IMPACT_SCORE),
      { preferTenScaleIntegers: true },
    );
    const maxRiskWithoutHuman = normalizePlannerRiskLevel(
      ctx.resolve(node.config?.maxRiskWithoutHuman ?? CALIBRATED_MAX_RISK_WITHOUT_HUMAN),
      { preferTenScaleIntegers: true },
    ) || CALIBRATED_MAX_RISK_WITHOUT_HUMAN;
    const maxConcurrentRepoAreaTasks = Number(ctx.resolve(node.config?.maxConcurrentRepoAreaTasks ?? 0));
    const rankingConfig = {
      failureThreshold: Math.max(1, Number(ctx.resolve(node.config?.failurePriorThreshold ?? 2)) || 2),
      failurePriorStep: Math.max(0, Number(ctx.resolve(node.config?.failurePriorStep ?? 1.5)) || 1.5),
      maxNegativePrior: Math.max(0, Number(ctx.resolve(node.config?.maxFailurePriorPenalty ?? 8)) || 8),
      signalPenaltyScale: Math.max(0, Number(ctx.resolve(node.config?.feedbackSignalScale ?? 0.12)) || 0.12),
    };
    const applyTaskGraph = node.config?.applyTaskGraph !== false;
    const graphRootTaskId =
      String(
        ctx.resolve(
          node.config?.parentTaskId ||
          plannerPayload?.root_task_id ||
          plannerPayload?.rootTaskId ||
          "",
        ) || "",
      ).trim() || null;
    const graphRootTaskKey = String(
      plannerPayload?.root_task_key ||
      plannerPayload?.rootTaskKey ||
      "",
    ).trim().toLowerCase();
    const plannerFeedback = resolvePlannerFeedbackObject(ctx.data?._plannerFeedback);
    const feedbackWeights = {
      agentAttempts: Math.max(
        0,
        Number(plannerFeedback?.rankingSignals?.weights?.agentAttempts || 0.6),
      ),
      consecutiveNoCommits: Math.max(
        0,
        Number(
          plannerFeedback?.rankingSignals?.weights?.consecutiveNoCommits || 1.3,
        ),
      ),
      blockedReason: Math.max(
        0,
        Number(plannerFeedback?.rankingSignals?.weights?.blockedReason || 1.8),
      ),
      debtTrend: Math.max(
        0,
        Number(plannerFeedback?.rankingSignals?.weights?.debtTrend || 0.7),
      ),
      commitSuccess: 2.2,
      completedSuccess: 0.8,
    };
    const materializationDefaults = resolvePlannerMaterializationDefaults(ctx);

    const enforceStrictPlannerPayload = node.config?.strictPlannerPayload === true;
    if (enforceStrictPlannerPayload) {
      const strictPayload = validateStrictPlannerTaskPayload(outputText, 5, { requireExactCount: false });
      if (!strictPayload.ok) {
        const outputPreview = outputText.length > 200
          ? `${outputText.slice(0, 200)}…`
          : outputText || "(empty)";
        const message = `Planner output from "${plannerNodeId}" failed validation: ${strictPayload.message} ` +
          `Output length: ${outputText.length} chars. Preview: ${outputPreview}`;
        recordPlannerLedgerEvent(engine, ctx, node, "planner.step_blocked", {
          phase: "materialize",
          label: "materialize-planner-tasks",
          status: "failed",
          error: message,
          reason: strictPayload.reason,
          summary: strictPayload.message,
          meta: {
            plannerNodeId,
            outputLength: outputText.length,
            outputPreview,
          },
        });
        ctx.log(node.id, message, failOnZero ? "error" : "warn");
        if (failOnZero) throw new Error(message);
        return {
          success: false,
          parsedCount: 0,
          createdCount: 0,
          skippedCount: 0,
          reason: strictPayload.reason,
          outputPreview,
        };
      }
    }

    const parsedTasks = extractPlannerTasksFromWorkflowOutput(outputText, Number.MAX_SAFE_INTEGER);
    if (!parsedTasks.length) {
      const outputPreview = outputText.length > 200
        ? `${outputText.slice(0, 200)}…`
        : outputText || "(empty)";
      const message = `Planner output from "${plannerNodeId}" did not include parseable tasks. ` +
        `Output length: ${outputText.length} chars. Preview: ${outputPreview}`;
      recordPlannerLedgerEvent(engine, ctx, node, "planner.step_blocked", {
        phase: "materialize",
        label: "materialize-planner-tasks",
        status: "failed",
        error: message,
        reason: "no_parseable_tasks",
        summary: "Planner output did not include parseable tasks.",
        meta: {
          plannerNodeId,
          outputLength: outputText.length,
          outputPreview,
        },
      });
      ctx.log(node.id, message, failOnZero ? "error" : "warn");
      if (failOnZero) throw new Error(message);
      return {
        success: false,
        parsedCount: 0,
        createdCount: 0,
        skippedCount: 0,
        reason: "no_parseable_tasks",
        outputPreview,
      };
    }

    const kanban = engine.services?.kanban;
    if (!kanban?.createTask) {
      throw new Error("Kanban adapter not available for planner materialization");
    }

    const existingTitleSet = new Set();
    const existingBacklogAreaCounts = new Map();
    let existingRows = [];
    const shouldFetchExistingTasks =
      Boolean(kanban?.listTasks)
      && (
        dedupEnabled
        || (Number.isFinite(maxConcurrentRepoAreaTasks) && maxConcurrentRepoAreaTasks > 0)
        || (Number.isFinite(rankingConfig.failureThreshold) && rankingConfig.failureThreshold > 0)
      );
    if (shouldFetchExistingTasks) {
      try {
        const existing = await kanban.listTasks(projectId, {});
        existingRows = Array.isArray(existing) ? existing : [];
        for (const row of existingRows) {
          const title = String(row?.title || "").trim().toLowerCase();
          if (dedupEnabled && title) existingTitleSet.add(title);
          const rowStatus = String(row?.status || "").trim().toLowerCase();
          const isBacklog = !["done", "completed", "closed", "cancelled", "canceled", "archived"].includes(rowStatus);
          if (!isBacklog) continue;
          const rowAreas = resolveTaskRepoAreas(row);
          for (const area of rowAreas) {
            const key = normalizePlannerAreaKey(area);
            if (!key) continue;
            existingBacklogAreaCounts.set(key, (existingBacklogAreaCounts.get(key) || 0) + 1);
          }
        }
      } catch (err) {
        ctx.log(node.id, `Could not prefetch tasks for dedup: ${err.message}`, "warn");
      }
    }
    const priorStatePath = shouldPersistPlannerPriorState()
      ? resolvePlannerPriorStatePath()
      : "";
    const priorState = loadPlannerPriorState(priorStatePath);
    replayPlannerOutcomes(existingRows, priorState, feedbackWeights);
    const feedbackHotTasks = Array.isArray(plannerFeedback?.taskStore?.hotTasks)
      ? plannerFeedback.taskStore.hotTasks
      : [];
    replayPlannerOutcomes(feedbackHotTasks, priorState, feedbackWeights);
    const feedbackPatterns = Array.isArray(plannerFeedback?.rankingSignals?.patterns)
      ? plannerFeedback.rankingSignals.patterns
      : [];
    for (const pattern of feedbackPatterns) {
      if (!pattern || typeof pattern !== "object") continue;
      const key = String(
        pattern.key ||
          buildPlannerPatternKey(
            pattern.repoArea || pattern.repo_area || "global",
            pattern.archetype || "general",
          ),
      ).trim();
      if (!key) continue;
      const entry = normalizePlannerPatternPrior(priorState.patterns[key]);
      const incomingCounter = Math.max(0, Number(pattern.failureCounter || 0));
      const incomingFailures = Math.max(0, Number(pattern.failures || 0));
      const incomingSuccesses = Math.max(0, Number(pattern.successes || 0));
      const incomingCommitlessCounter = Math.max(
        0,
        Number(pattern.commitlessFailureCounter || pattern.commitless_counter || 0),
      );
      const incomingCommitlessFailures = Math.max(
        0,
        Number(pattern.commitlessFailures || pattern.commitless_failures || 0),
      );
      const incomingCommitlessSuccesses = Math.max(
        0,
        Number(pattern.commitlessSuccesses || pattern.commitless_successes || 0),
      );
      entry.failureCounter = Number(
        Math.max(entry.failureCounter || 0, incomingCounter).toFixed(3),
      );
      entry.negativePrior = Math.max(
        Math.max(0, Number(entry.negativePrior || 0)),
        Math.max(0, Number(pattern.negativePrior || 0)),
      );
      entry.failureCount = Math.max(
        Number(entry.failureCount || 0),
        incomingFailures,
      );
      entry.successCount = Math.max(
        Number(entry.successCount || 0),
        incomingSuccesses,
      );
      entry.commitlessFailureCounter = Number(
        Math.max(entry.commitlessFailureCounter || 0, incomingCommitlessCounter).toFixed(3),
      );
      entry.commitlessFailureCount = Math.max(
        Number(entry.commitlessFailureCount || 0),
        incomingCommitlessFailures,
      );
      entry.commitlessSuccessCount = Math.max(
        Number(entry.commitlessSuccessCount || 0),
        incomingCommitlessSuccesses,
      );
      entry.lastUpdatedAt = new Date().toISOString();
      priorState.patterns[key] = entry;
    }
    if (priorStatePath) {
      savePlannerPriorState(priorStatePath, priorState);
    }
    const existingTaskByTitle = new Map();
    for (const row of existingRows) {
      const titleKey = String(row?.title || "").trim().toLowerCase();
      if (!titleKey || existingTaskByTitle.has(titleKey)) continue;
      existingTaskByTitle.set(titleKey, row);
    }
    const rankedTasks = rankPlannerTaskCandidatesForResume(
      rankPlannerTaskCandidates(parsedTasks, priorState, rankingConfig),
      plannerFeedback,
    );

    const created = [];
    const createdTaskRefs = [];
    const skipped = [];
    const materializationOutcomes = [];
    const createdAreaCounts = new Map();
    for (const task of rankedTasks) {
      if (created.length >= maxTasks) break;
      const baseOutcome = {
        title: task.title,
        impact: task.impact,
        confidence: task.confidence,
        risk: task.risk,
      };
      const key = task.title.toLowerCase();
      if (dedupEnabled && existingTitleSet.has(key)) {
        const existingTask = existingTaskByTitle.get(key);
        const existingTaskId = String(existingTask?.id || existingTask?.task_id || "").trim() || null;
        skipped.push({ title: task.title, reason: "duplicate_title", existingTaskId });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "duplicate_title", existingTaskId });
        continue;
      }
      if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0) {
        skipped.push({ title: task.title, reason: "missing_acceptance_criteria" });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "missing_acceptance_criteria" });
        continue;
      }
      if (!Array.isArray(task.verification) || task.verification.length === 0) {
        skipped.push({ title: task.title, reason: "missing_verification" });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "missing_verification" });
        continue;
      }
      if (!Array.isArray(task.repoAreas) || task.repoAreas.length === 0) {
        skipped.push({ title: task.title, reason: "missing_repo_areas" });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "missing_repo_areas" });
        continue;
      }
      if (Number.isFinite(minImpactScore) && Number.isFinite(task.impact) && task.impact < minImpactScore) {
        skipped.push({ title: task.title, reason: "below_min_impact", impact: task.impact, minImpactScore });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "below_min_impact" });
        continue;
      }
      const taskRiskOrder = PLANNER_RISK_ORDER[String(task.risk || "").toLowerCase()];
      const maxRiskOrder = PLANNER_RISK_ORDER[String(maxRiskWithoutHuman || "").toLowerCase()];
      if (Number.isFinite(taskRiskOrder) && Number.isFinite(maxRiskOrder) && taskRiskOrder > maxRiskOrder) {
        skipped.push({ title: task.title, reason: "risk_above_threshold", risk: task.risk, maxRiskWithoutHuman });
        materializationOutcomes.push({ ...baseOutcome, created: false, reason: "risk_above_threshold" });
        continue;
      }
      if (Number.isFinite(maxConcurrentRepoAreaTasks) && maxConcurrentRepoAreaTasks > 0) {
        let saturated = false;
        const saturatedAreas = [];
        for (const area of task.repoAreas) {
          const areaKey = normalizePlannerAreaKey(area);
          if (!areaKey) continue;
          const existingCount = existingBacklogAreaCounts.get(areaKey) || 0;
          const createdCount = createdAreaCounts.get(areaKey) || 0;
          if ((existingCount + createdCount) >= maxConcurrentRepoAreaTasks) {
            saturated = true;
            saturatedAreas.push(area);
          }
        }
        if (saturated) {
          skipped.push({
            title: task.title,
            reason: "repo_area_saturated",
            repoAreas: saturatedAreas,
            maxConcurrentRepoAreaTasks,
          });
          materializationOutcomes.push({ ...baseOutcome, created: false, reason: "repo_area_saturated" });
          continue;
        }
      }

      const payload = {
        title: task.title,
        description: task.description,
        status,
      };
      if (task.priority) payload.priority = task.priority;
      if (task.workspace || materializationDefaults.workspace) {
        payload.workspace = task.workspace || materializationDefaults.workspace;
      }
      if (task.repository || materializationDefaults.repository) {
        payload.repository = task.repository || materializationDefaults.repository;
      }
      if (Array.isArray(task.repositories) && task.repositories.length > 0) {
        payload.repositories = task.repositories;
      }
      if (Array.isArray(task.tags) && task.tags.length > 0) payload.tags = task.tags;
      if (task.baseBranch) payload.baseBranch = task.baseBranch;
      if (task.draft || String(status || "").trim().toLowerCase() === "draft") {
        payload.draft = true;
      }
      if (projectId) payload.projectId = projectId;
      if (Array.isArray(task.repoAreas) && task.repoAreas.length > 0) {
        payload.repo_areas = task.repoAreas;
      }
      const existingMeta =
        payload.meta && typeof payload.meta === "object" && !Array.isArray(payload.meta)
          ? { ...payload.meta }
          : {};
      if (payload.workspace && !existingMeta.workspace) {
        existingMeta.workspace = payload.workspace;
      }
      if (payload.repository && !existingMeta.repository) {
        existingMeta.repository = payload.repository;
      }
      if (Array.isArray(task.repoAreas) && task.repoAreas.length > 0 && !Array.isArray(existingMeta.repo_areas)) {
        existingMeta.repo_areas = task.repoAreas;
      }
      existingMeta.planner = {
        nodeId: plannerNodeId,
        index: task.index,
        archetype: task.archetype || null,
        impact: task.impact,
        confidence: task.confidence,
        risk: task.risk,
        estimated_effort: task.estimatedEffort,
        archetype: task.archetype,
        repo_areas: task.repoAreas,
        why_now: task.whyNow,
        kill_criteria: task.killCriteria,
        acceptance_criteria: task.acceptanceCriteria,
        verification: task.verification,
        task_key: task.taskKey || null,
        parent_task_key: task.parentTaskKey || null,
        parent_task_id: task.parentTaskId || null,
        depends_on_task_keys: Array.isArray(task.dependencyTaskKeys) ? task.dependencyTaskKeys : [],
        depends_on_task_ids: Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : [],
        decomposition_kind: task.decompositionKind || null,
        spawn_when: task.spawnWhen || null,
        merge_back_policy: task.mergeBackPolicy || null,
      };
      payload.meta = existingMeta;
      const createdTask = await createKanbanTaskWithProject(
        kanban,
        attachWorkflowTaskMetadata(ctx, payload, {
          sourceNodeId: node.id,
          sourceNodeType: node.type,
        }),
        projectId,
      );
      created.push({
        id: createdTask?.id || null,
        title: task.title,
      });
      createdTaskRefs.push({
        task,
        createdTaskId: createdTask?.id || null,
      });
      materializationOutcomes.push({ ...baseOutcome, created: true, reason: null });
      for (const area of task.repoAreas) {
        const areaKey = normalizePlannerAreaKey(area);
        if (!areaKey) continue;
        createdAreaCounts.set(areaKey, (createdAreaCounts.get(areaKey) || 0) + 1);
      }
      existingTitleSet.add(key);
    }

    const graphMaterialization = applyTaskGraph
      ? await applyPlannerTaskGraphLinks({
          createdTaskRefs,
          graphRootTaskId,
          graphRootTaskKey,
          kanban,
        })
      : {
          appliedParentLinks: [],
          appliedDependencyLinks: [],
          skippedGraphLinks: [],
        };

    const createdCount = created.length;
    const skippedCount = skipped.length;
    const graphAppliedCount =
      graphMaterialization.appliedParentLinks.length +
      graphMaterialization.appliedDependencyLinks.length;
    const graphSkippedCount = graphMaterialization.skippedGraphLinks.length;
    const skipReasonHistogram = buildPlannerSkipReasonHistogram(skipped);
    ctx.log(
      node.id,
      `Planner materialization parsed=${parsedTasks.length} created=${createdCount} skipped=${skippedCount} graphApplied=${graphAppliedCount} graphSkipped=${graphSkippedCount} histogram=${JSON.stringify(skipReasonHistogram)}`,
    );

    const requiredCreated = Math.min(Math.max(1, minCreated), Math.max(1, maxTasks));

    if (failOnZero && createdCount < requiredCreated) {
      recordPlannerLedgerEvent(engine, ctx, node, "planner.step_blocked", {
        phase: "materialize",
        label: "materialize-planner-tasks",
        status: "failed",
        error: `Planner materialization created ${createdCount} tasks (required: ${requiredCreated})`,
        reason: "insufficient_created_tasks",
        summary: `Created ${createdCount} tasks but required ${requiredCreated}.`,
        meta: {
          plannerNodeId,
          parsedCount: parsedTasks.length,
          createdCount,
          skippedCount,
          graphAppliedCount,
          graphSkippedCount,
          skipReasonHistogram,
        },
      });
      throw new Error(
        `Planner materialization created ${createdCount} tasks (required: ${requiredCreated})`,
      );
    }

    recordPlannerLedgerEvent(engine, ctx, node, "planner.plan_reasoning", {
      phase: "ranking",
      label: "planner-ranking",
      status: "completed",
      summary: `Planner candidates ranked: parsed=${parsedTasks.length}, created=${createdCount}, skipped=${skippedCount}`,
      meta: {
        plannerNodeId,
        parsedCount: parsedTasks.length,
        createdCount,
        skippedCount,
        graphAppliedCount,
        graphSkippedCount,
        skipReasonHistogram,
        rankedTasks: rankedTasks.slice(0, maxTasks).map((task) => ({
          title: task.title,
          archetype: task.archetype || null,
          score: task?._ranking?.score,
          penalty: task?._ranking?.penalty,
          patternKeys: task?._ranking?.patternKeys || [],
        })),
      },
    });
    recordPlannerLedgerEvent(engine, ctx, node, "planner.post_attachment", {
      phase: "materialize-output",
      label: "materialized-planner-tasks",
      status: "completed",
      summary: `Materialized ${createdCount} task(s) from planner output.`,
      meta: {
        plannerNodeId,
        attachmentKind: "materialized_tasks",
        created,
        skipped,
        graphMaterialization,
        skipReasonHistogram,
      },
    });
    recordPlannerLedgerEvent(engine, ctx, node, "planner.step_completed", {
      phase: "materialize",
      label: "materialize-planner-tasks",
      status: createdCount >= requiredCreated ? "completed" : "failed",
      summary: `Planner materialization parsed=${parsedTasks.length} created=${createdCount} skipped=${skippedCount}`,
      meta: {
        plannerNodeId,
        parsedCount: parsedTasks.length,
        createdCount,
        skippedCount,
        graphAppliedCount,
        graphSkippedCount,
        skipReasonHistogram,
      },
    });

    return {
      success: createdCount >= requiredCreated,
      parsedCount: parsedTasks.length,
      createdCount,
      skippedCount,
      skipReasonHistogram,
      materializationOutcomes,
      created,
      skipped,
      graphMaterialization,
      tasks: parsedTasks,
      rankedTasks: rankedTasks.slice(0, maxTasks).map((task) => ({
        title: task.title,
        archetype: task.archetype || null,
        score: task?._ranking?.score,
        penalty: task?._ranking?.penalty,
        patternKeys: task?._ranking?.patternKeys || [],
      })),
    };
  },
});
registerBuiltinNodeType("agent.run_planner", {
  describe: () => "Run the task planner agent to generate new backlog tasks",
  schema: {
    type: "object",
    properties: {
      taskCount: { type: "number", default: 5, description: "Number of tasks to generate" },
      context: { type: "string", description: "Additional context for the planner" },
      prompt: { type: "string", description: "Optional explicit planner prompt override" },
      outputVariable: { type: "string", description: "Optional context key to store planner output text" },
      repoMap: { type: "object", description: "Optional explicit repo map context" },
      repoMapQuery: { type: "string", description: "Optional query used to select a compact repo topology" },
      repoMapFileLimit: { type: "number", default: 8, description: "Maximum repo-map files to include" },
      projectId: { type: "string" },
      dedup: { type: "boolean", default: true },
      timeoutMs: { type: "number", default: 960000, description: "Node timeout in ms (recommended >= agentTimeoutMs)" },
      agentTimeoutMs: { type: "number", default: 900000, description: "Planner agent execution timeout in ms" },
      maxRetries: { type: "number", default: 0, description: "Retry attempts for planner node" },
      retryable: { type: "boolean", default: false, description: "Whether planner node should auto-retry on failure" },
      maxRetainedEvents: { type: "number", default: WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT, description: "Maximum planner events retained in run output" },
      includeSkillbookGuidance: { type: "boolean", default: true, description: "Whether to inject reusable skillbook strategies into planner prompts." },
      skillbookNodeId: { type: "string", description: "Optional node ID whose output should be used as planner skillbook guidance." },
      skillbookLimit: { type: "number", default: 5, description: "Maximum reusable strategies to inject when auto-loading guidance." },
    },
  },
  async execute(node, ctx, engine) {
    const count = Number(ctx.resolve(node.config?.taskCount || 5)) || 5;
    const context = ctx.resolve(node.config?.context || "");
    const plannerFeedback = resolvePlannerFeedbackContext(ctx.data?._plannerFeedback);
    const explicitPrompt = ctx.resolve(node.config?.prompt || "");
    const outputVariable = ctx.resolve(node.config?.outputVariable || "");
    const repoMapQuery = ctx.resolve(node.config?.repoMapQuery || "");
    const includeSkillbookGuidance = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.includeSkillbookGuidance ?? true, ctx),
      true,
    );
    const skillbookNodeId = String(ctx.resolve(node.config?.skillbookNodeId || "") || "").trim();
    const skillbookLimit = Number.isFinite(Number(resolveWorkflowNodeValue(node.config?.skillbookLimit ?? 5, ctx)))
      ? Math.max(1, Math.trunc(Number(resolveWorkflowNodeValue(node.config?.skillbookLimit ?? 5, ctx))))
      : 5;
    const configuredNodeTimeout = Number(ctx.resolve(node.config?.timeoutMs || node.config?.timeout || 0));
    const configuredAgentTimeout = Number(ctx.resolve(node.config?.agentTimeoutMs || 0));

    let agentTimeoutMs = Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0
      ? Math.max(10000, Math.trunc(configuredAgentTimeout))
      : 9 * 60 * 1000;
    if (!(Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0) && Number.isFinite(configuredNodeTimeout) && configuredNodeTimeout > 15000) {
      agentTimeoutMs = Math.max(10000, Math.trunc(configuredNodeTimeout) - 5000);
    }

    ctx.log(node.id, `Running planner for ${count} tasks`);

    // This delegates to the existing planner prompt flow
    const agentPool = engine.services?.agentPool;
    const plannerPrompt = engine.services?.prompts?.planner;
    const basePrompt = explicitPrompt || plannerPrompt || "";
    let skillbookGuidance = normalizeSkillbookGuidancePayload(
      skillbookNodeId
        ? ctx.getNodeOutput?.(skillbookNodeId)
        : null,
    ) || normalizeSkillbookGuidancePayload(ctx.data?._skillbookGuidance);
    if (!skillbookGuidance && includeSkillbookGuidance) {
      skillbookGuidance = await resolveReusableSkillbookGuidance(ctx, {
        workflowId: ctx.data?._workflowId || "",
        category: "strategy",
        status: "promoted",
        query: [
          context,
          ctx.data?.taskTitle,
          ctx.data?.taskDescription,
          ctx.data?.prompt,
        ].filter(Boolean).join(" "),
        limit: skillbookLimit,
      });
      if (skillbookGuidance.matched > 0) {
        ctx.data._skillbookGuidance = skillbookGuidance;
      }
    }
    const skillbookPromptContext = buildSkillbookPromptContext(skillbookGuidance);
    const fullPromptForRepoMapCheck = [basePrompt, context, plannerFeedback, skillbookPromptContext].filter(Boolean).join("\n\n");
    const promptHasRepoMap = hasRepoMapContext(fullPromptForRepoMapCheck);
    const repoTopologyContext = (node.config?.repoMap || repoMapQuery)
      && !promptHasRepoMap
      ? buildRepoTopologyContext({
        repoMap: node.config?.repoMap || ctx.data?.repoMap || null,
        repoMapFileLimit: node.config?.repoMapFileLimit ?? 8,
        repoMapQuery,
        query: [context, explicitPrompt, plannerPrompt].filter(Boolean).join(" "),
        prompt: explicitPrompt || plannerPrompt || "",
        userMessage: context,
        taskTitle: ctx.data?.taskTitle || ctx.data?.task?.title || "",
        taskDescription:
          ctx.data?.taskDescription ||
          ctx.data?.task?.description ||
          ctx.data?.task?.body ||
          ctx.data?.taskDetail?.description ||
          ctx.data?.taskInfo?.description ||
          "",
        changedFiles:
          (Array.isArray(ctx.data?.changedFiles) ? ctx.data.changedFiles : null) ||
          (Array.isArray(ctx.data?.task?.changedFiles) ? ctx.data.task.changedFiles : null) ||
          [],
        cwd: process.cwd(),
        repoRoot: ctx.data?.repoRoot || process.cwd(),
      })
      : "";
    // Enforce strict output instructions to ensure the downstream materialize node
    // can parse the planner output. The planner prompt already defines the contract,
    // but we reinforce it here to prevent agents from wrapping output in prose.
    const effectiveContext = appendPlannerFeedbackContext(context, plannerFeedback, basePrompt);
    const plannerExecutionContext = [
      effectiveContext,
      skillbookPromptContext,
      repoTopologyContext,
    ].filter(Boolean).join("\n\n");
    const outputEnforcement =
      `\n\n## CRITICAL OUTPUT REQUIREMENT\n` +
      `Generate exactly ${count} new tasks.\n` +
      (plannerExecutionContext
        ? `${plannerExecutionContext}\n\n`
        : "\n") +
      `Your response MUST be a single fenced JSON block with shape { "tasks": [...] }.\n` +
      `Do NOT include status updates, analysis notes, tool commentary, questions, or prose outside the JSON block.\n` +
      `The downstream system will parse your output as JSON — any extra text will cause task creation to fail.`;
    const promptText = basePrompt
      ? `${basePrompt}${outputEnforcement}`
      : "";

    if (agentPool?.launchEphemeralThread && promptText) {
      let streamEventCount = 0;
      let lastStreamLog = "";
      const streamLines = [];
      const startedAt = Date.now();
      const maxRetainedEvents = Number.isFinite(Number(node.config?.maxRetainedEvents))
        ? Math.max(10, Math.min(500, Math.trunc(Number(node.config.maxRetainedEvents))))
        : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
      const launchExtra = {
        onEvent: (event) => {
          try {
            const line = summarizeAgentStreamEvent(event);
            if (!line || line === lastStreamLog) return;
            lastStreamLog = line;
            streamEventCount += 1;
            if (streamLines.length >= maxRetainedEvents) {
              streamLines.shift();
            }
            streamLines.push(line);
            ctx.log(node.id, line);
            recordPlannerLedgerEvent(engine, ctx, node, "planner.plan_reasoning", {
              phase: "generation",
              label: "planner-stream",
              status: "running",
              summary: line,
              meta: {
                taskCount: count,
                streamEventCount,
                rawEventType: String(event?.type || event?.eventType || event?.kind || "").trim() || null,
              },
            });
          } catch {
            // Stream callbacks must never crash workflow execution.
          }
        },
      };

      recordPlannerLedgerEvent(engine, ctx, node, "planner.plan_initialized", {
        phase: "plan",
        label: "run-planner",
        status: "running",
        summary: `Planner initialized for ${count} tasks.`,
        meta: {
          taskCount: count,
          outputVariable: outputVariable || null,
          repoMapQuery: repoMapQuery || null,
          plannerFeedbackPresent: Boolean(plannerFeedback),
          skillbookGuidancePresent: Boolean(skillbookPromptContext),
        },
      });
      recordPlannerLedgerEvent(engine, ctx, node, "planner.step_started", {
        phase: "generation",
        label: "generate-planner-output",
        status: "running",
        meta: {
          taskCount: count,
          outputVariable: outputVariable || null,
        },
      });

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        ctx.log(
          node.id,
          `Planner still running (${elapsedSec}s elapsed, streamEvents=${streamEventCount})`,
        );
      }, WORKFLOW_AGENT_HEARTBEAT_MS);

      let result;
      try {
        result = await agentPool.launchEphemeralThread(
          promptText,
          process.cwd(),
          agentTimeoutMs,
          launchExtra,
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err || "planner execution failed");
        recordPlannerLedgerEvent(engine, ctx, node, "planner.step_blocked", {
          phase: "generation",
          label: "generate-planner-output",
          status: "failed",
          error: errorMessage,
          reason: "planner_execution_failed",
          summary: "Planner execution failed before returning output.",
          meta: {
            taskCount: count,
            streamEventCount,
          },
        });
        recordPlannerLedgerEvent(engine, ctx, node, "planner.plan_failed", {
          phase: "plan",
          label: "run-planner",
          status: "failed",
          error: errorMessage,
          reason: "planner_execution_failed",
          meta: {
            taskCount: count,
            streamEventCount,
          },
        });
        ctx.log(node.id, `Planner failed: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
          output: "",
          taskCount: count,
          stream: streamLines.slice(),
          streamEventCount,
        };
      } finally {
        clearInterval(heartbeat);
      }

      ctx.log(
        node.id,
        `Planner completed: success=${result.success} streamEvents=${streamEventCount}`,
      );

      const threadId = result.threadId || result.sessionId || null;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      if (outputVariable) {
        ctx.data[outputVariable] = String(result.output || "").trim();
      }
      const digest = buildAgentExecutionDigest(result, streamLines, maxRetainedEvents);
      const plannerOutput = String(result.output || "").trim();
      const plannerSucceeded = result.success === true;
      recordPlannerLedgerEvent(engine, ctx, node, "planner.plan_reasoning", {
        phase: "reasoning",
        label: "planner-digest",
        status: plannerSucceeded ? "completed" : "failed",
        summary: digest.summary || `Planner returned ${digest.itemCount || 0} structured items.`,
        meta: {
          taskCount: count,
          itemCount: digest.itemCount,
          omittedItemCount: digest.omittedItemCount,
          threadId,
          sdk: result.sdk || null,
          narrative: digest.narrative || null,
          thoughts: Array.isArray(digest.thoughts) ? digest.thoughts.slice(0, 12) : [],
          items: Array.isArray(digest.items) ? digest.items.slice(0, 8) : [],
        },
      });
      if (plannerOutput) {
        recordPlannerLedgerEvent(engine, ctx, node, "planner.post_attachment", {
          phase: "planner-output",
          label: "planner-output",
          status: plannerSucceeded ? "completed" : "failed",
          summary: "Planner output captured for downstream materialization.",
          meta: {
            taskCount: count,
            attachmentKind: "planner_output",
            outputVariable: outputVariable || null,
            threadId,
            outputPreview: plannerOutput.slice(0, 600),
          },
        });
      }
      recordPlannerLedgerEvent(engine, ctx, node, plannerSucceeded ? "planner.step_completed" : "planner.step_blocked", {
        phase: "generation",
        label: "generate-planner-output",
        status: plannerSucceeded ? "completed" : "failed",
        error: plannerSucceeded ? null : (result.error || "planner execution reported failure"),
        reason: plannerSucceeded ? null : "planner_execution_unsuccessful",
        summary: plannerSucceeded
          ? `Planner generated output for ${count} tasks.`
          : "Planner execution returned an unsuccessful result.",
        meta: {
          taskCount: count,
          itemCount: digest.itemCount,
          omittedItemCount: digest.omittedItemCount,
          threadId,
          streamEventCount,
        },
      });
      recordPlannerLedgerEvent(engine, ctx, node, plannerSucceeded ? "planner.plan_completed" : "planner.plan_failed", {
        phase: "plan",
        label: "run-planner",
        status: plannerSucceeded ? "completed" : "failed",
        error: plannerSucceeded ? null : (result.error || "planner execution reported failure"),
        reason: plannerSucceeded ? null : "planner_execution_unsuccessful",
        summary: plannerSucceeded
          ? `Planner completed with ${digest.itemCount || 0} items.`
          : "Planner completed without a successful result.",
        meta: {
          taskCount: count,
          itemCount: digest.itemCount,
          threadId,
          sdk: result.sdk || null,
          streamEventCount,
        },
      });
      return {
        success: result.success,
        output: plannerOutput,
        text: plannerOutput,
        result: plannerOutput,
        summary: digest.summary,
        narrative: digest.narrative,
        thoughts: digest.thoughts,
        stream: digest.stream,
        taskCount: count,
        sdk: result.sdk,
        items: digest.items,
        itemCount: digest.itemCount,
        omittedItemCount: digest.omittedItemCount,
        threadId,
        sessionId: threadId,
      };
    }

    return {
      success: false,
      error: explicitPrompt
        ? "Agent pool not available"
        : "Agent pool or planner prompt not available",
    };
  },
});
registerBuiltinNodeType("agent.evidence_collect", {
  describe: () => "Collect all evidence from .bosun/evidence for review",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence" },
      types: { type: "array", items: { type: "string" }, default: ["png", "jpg", "json", "log", "txt"] },
    },
  },
  async execute(node, ctx, engine) {
    const dir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      return { files: [], count: 0, dir };
    }
    const { readdirSync, statSync } = await import("node:fs");
    const types = node.config?.types || ["png", "jpg", "json", "log", "txt"];
    const files = readdirSync(dir)
      .filter((f) => {
        const ext = f.split(".").pop()?.toLowerCase();
        return types.includes(ext);
      })
      .map((f) => ({
        name: f,
        path: resolve(dir, f),
        size: statSync(resolve(dir, f)).size,
        type: f.split(".").pop()?.toLowerCase(),
      }));

    return { files, count: files.length, dir };
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  FLOW CONTROL — Gates, barriers, and routing
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("flow.gate", {
  describe: () => "Pause workflow execution until a condition is met or manual approval is given",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["manual", "condition", "timeout"],
        default: "condition",
        description: "Gate mode: manual (requires approval), condition (auto-check expression), timeout (wait then proceed)",
      },
      condition: { type: "string", description: "JS expression that must return true to open gate (condition mode)" },
      timeoutMs: { type: "number", default: 300000, description: "Max wait time before gate auto-opens or fails (ms)" },
      onTimeout: { type: "string", enum: ["proceed", "fail"], default: "proceed", description: "Action when timeout is reached" },
      pollIntervalMs: { type: "number", default: 5000, description: "How often to re-evaluate the condition (ms)" },
      reason: { type: "string", description: "Human-readable description of what this gate is waiting for" },
    },
  },
  async execute(node, ctx, engine) {
    const mode = node.config?.mode || "condition";
    const timeoutMs = node.config?.timeoutMs || 300000;
    const onTimeout = node.config?.onTimeout || "proceed";
    const reason = ctx.resolve(node.config?.reason || "Waiting at gate");
    const pollInterval = node.config?.pollIntervalMs || 5000;

    ctx.log(node.id, `Gate (${mode}): ${reason}`);
    ctx.setNodeStatus?.(node.id, "waiting");
    engine?.emit?.("node:waiting", { nodeId: node.id, mode, reason });

    if (mode === "timeout") {
      // Simple wait
      await new Promise((r) => setTimeout(r, timeoutMs));
      return { gateOpened: true, mode, waited: timeoutMs, reason };
    }

    if (mode === "condition" && node.config?.condition) {
      // Poll-based condition check
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const fn = new Function("$data", "$ctx", `return (${node.config.condition});`);
          if (fn(ctx.data, ctx)) {
            const waited = Date.now() - start;
            return { gateOpened: true, mode, waited, reason };
          }
        } catch { /* condition eval failed, keep waiting */ }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
      // Timeout reached
      if (onTimeout === "fail") {
        throw new Error(`Gate timed out after ${timeoutMs}ms: ${reason}`);
      }
      return { gateOpened: true, mode, timedOut: true, waited: timeoutMs, reason };
    }

    // Manual mode or fallback: create a durable approval request and keep the
    // legacy context-variable path working for existing callers.
    const approvalKey = `_gate_${node.id}_approved`;
    const repoRoot =
      String(
        ctx?.data?.repoRoot
        || ctx?.data?.repoPath
        || process.env.REPO_ROOT
        || process.cwd(),
      ).trim() || process.cwd();
    const runId = String(ctx?.data?._dagState?.runId || ctx?.id || "").trim() || null;
    const gateRequest = runId
      ? upsertWorkflowGateApprovalRequest({
        runId,
        rootRunId: ctx?.data?._workflowRootRunId || runId,
        parentRunId: ctx?.data?._workflowParentRunId || null,
        workflowId: ctx?.data?._workflowId || ctx?.data?._dagState?.workflowId || null,
        workflowName: ctx?.data?._workflowName || ctx?.data?._dagState?.workflowName || null,
        taskId: ctx?.data?.taskId || null,
        taskTitle: ctx?.data?.taskTitle || null,
        nodeId: node.id,
        nodeLabel: node.label || null,
        reason,
        timeoutMs,
        onTimeout,
        pollIntervalMs: pollInterval,
        requestedBy: "flow.gate",
        mode: "manual",
      }, { repoRoot }).request
      : null;
    if (gateRequest) {
      if (!ctx.data._pendingApprovalRequests || typeof ctx.data._pendingApprovalRequests !== "object") {
        ctx.data._pendingApprovalRequests = {};
      }
      ctx.data._pendingApprovalRequests[gateRequest.requestId] = {
        requestId: gateRequest.requestId,
        scopeType: gateRequest.scopeType,
        scopeId: gateRequest.scopeId,
        nodeId: gateRequest.nodeId,
        nodeLabel: gateRequest.nodeLabel,
        reason: gateRequest.reason,
        status: gateRequest.status,
        requestedAt: gateRequest.requestedAt,
        expiresAt: gateRequest.expiresAt || null,
      };
      engine?._checkpointRun?.(ctx);
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const legacyApproved = ctx.data[approvalKey] || ctx.variables[approvalKey];
      if (legacyApproved) {
        if (gateRequest && String(gateRequest.requestId || "").trim()) {
          try {
            const pending = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
            if (pending && pending.status === "pending") {
              resolveApprovalRequest(gateRequest.requestId, {
                repoRoot,
                decision: "approved",
                actorId: "legacy-context",
                note: "Approved through legacy workflow context variable.",
              });
            }
          } catch {}
        }
        if (gateRequest && ctx.data?._pendingApprovalRequests?.[gateRequest.requestId]) {
          delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
          engine?._checkpointRun?.(ctx);
        }
        return {
          gateOpened: true,
          mode: "manual",
          waited: Date.now() - start,
          reason,
          approvalRequestId: gateRequest?.requestId || null,
          approvalState: "approved",
        };
      }
      if (gateRequest) {
        const currentRequest = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
        const approvalState = String(currentRequest?.status || "").trim().toLowerCase();
        if (approvalState === "approved") {
          if (ctx.data?._pendingApprovalRequests?.[gateRequest.requestId]) {
            delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
            engine?._checkpointRun?.(ctx);
          }
          return {
            gateOpened: true,
            mode: "manual",
            waited: Date.now() - start,
            reason,
            approvalRequestId: gateRequest.requestId,
            approvalState,
          };
        }
        if (approvalState === "denied") {
          if (ctx.data?._pendingApprovalRequests?.[gateRequest.requestId]) {
            delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
            engine?._checkpointRun?.(ctx);
          }
          throw new Error(`Manual gate denied by operator: ${reason}`);
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (gateRequest) {
      try {
        const pending = getApprovalRequest(gateRequest.scopeType, gateRequest.scopeId, { repoRoot });
        if (pending && pending.status === "pending") {
          expireApprovalRequest(gateRequest.requestId, {
            repoRoot,
            actorId: "system:timeout",
            note: `Manual gate timed out after ${timeoutMs}ms.`,
          });
        }
      } catch {}
      if (ctx.data?._pendingApprovalRequests?.[gateRequest.requestId]) {
        delete ctx.data._pendingApprovalRequests[gateRequest.requestId];
        engine?._checkpointRun?.(ctx);
      }
    }
    if (onTimeout === "fail") {
      throw new Error(`Manual gate timed out after ${timeoutMs}ms: ${reason}`);
    }
    return {
      gateOpened: true,
      mode: "manual",
      timedOut: true,
      waited: timeoutMs,
      reason,
      approvalRequestId: gateRequest?.requestId || null,
      approvalState: "expired",
    };
  },
});

registerBuiltinNodeType("flow.join", {
  describe: () => "Explicitly join multiple branches before continuing",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["all", "any", "quorum"],
        default: "all",
        description: "Join condition. 'all' waits for all listed sources, 'any' waits for one, 'quorum' waits for N",
      },
      sourceNodeIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit source node IDs to evaluate at join time",
      },
      quorum: {
        type: "number",
        description: "Required count when mode='quorum'",
      },
      includeSkipped: {
        type: "boolean",
        default: true,
        description: "Whether skipped sources count as arrived",
      },
      failOnUnmet: {
        type: "boolean",
        default: false,
        description: "Throw when join criteria are not met",
      },
    },
  },
  async execute(node, ctx, engine) {
    const mode = String(ctx.resolve(node.config?.mode || "all") || "all").toLowerCase();
    const includeSkipped = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.includeSkipped ?? true, ctx),
      true,
    );
    const failOnUnmet = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnUnmet ?? false, ctx),
      false,
    );

    const configuredSourceIds = Array.isArray(node.config?.sourceNodeIds)
      ? node.config.sourceNodeIds
      : [];
    const sourceNodeIds = configuredSourceIds
      .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
      .filter(Boolean);

    const statuses = sourceNodeIds.map((sourceNodeId) => {
      const status = typeof ctx.getNodeStatus === "function"
        ? String(ctx.getNodeStatus(sourceNodeId) || "pending").toLowerCase()
        : "pending";
      return { sourceNodeId, status };
    });

    const arrivedStates = includeSkipped
      ? new Set(["completed", "failed", "skipped"])
      : new Set(["completed", "failed"]);
    const arrived = statuses.filter((entry) => arrivedStates.has(entry.status));
    const pendingSources = statuses
      .filter((entry) => !arrivedStates.has(entry.status))
      .map((entry) => entry.sourceNodeId);

    const resolvedQuorumRaw = Number(ctx.resolve(node.config?.quorum ?? 0));
    const resolvedQuorum = Number.isFinite(resolvedQuorumRaw)
      ? Math.max(1, Math.trunc(resolvedQuorumRaw))
      : Math.max(1, sourceNodeIds.length || 1);

    let joined = true;
    if (sourceNodeIds.length > 0) {
      if (mode === "any") {
        joined = arrived.length > 0;
      } else if (mode === "quorum") {
        joined = arrived.length >= Math.min(resolvedQuorum, sourceNodeIds.length);
      } else {
        joined = pendingSources.length === 0;
      }
    }

    if (!joined && failOnUnmet) {
      throw new Error(
        `Join criteria not met for node ${node.id}: mode=${mode}, pending=${pendingSources.join(",") || "none"}`,
      );
    }

    return {
      joined,
      mode,
      sourceCount: sourceNodeIds.length,
      arrivedCount: arrived.length,
      pendingSources,
      quorum: mode === "quorum" ? resolvedQuorum : undefined,
      includeSkipped,
    };
  },
});

registerBuiltinNodeType("flow.end", {
  describe: () => "End the workflow immediately with explicit terminal status",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "failed"],
        default: "completed",
      },
      message: { type: "string", description: "Terminal reason or summary" },
      output: {
        description: "Optional structured output persisted on workflow terminal metadata",
      },
    },
  },
  async execute(node, ctx, engine) {
    const rawStatus = String(ctx.resolve(node.config?.status || "completed") || "completed")
      .trim()
      .toLowerCase();
    const status = rawStatus === "failed" ? "failed" : "completed";
    const message = String(ctx.resolve(node.config?.message || "") || "").trim();
    const output = resolveWorkflowNodeValue(node.config?.output, ctx);

    if (message) {
      const level = status === "failed" ? "warn" : "info";
      ctx.log(node.id, `Workflow end requested (${status}): ${message}`, level);
    }

    return {
      _workflowEnd: true,
      status,
      message,
      output,
      nodeId: node.id,
      timestamp: Date.now(),
    };
  },
});

const UNIVERSAL_FLOW_NODE = {
  describe: () => "Run a universal reusable subworkflow (alias of execute-workflow pattern)",
  schema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Shared subworkflow to run" },
      mode: { type: "string", enum: ["sync", "dispatch"], default: "sync" },
      input: { type: "object", additionalProperties: true },
      inheritContext: { type: "boolean", default: true },
      outputVariable: { type: "string" },
      allowRecursive: { type: "boolean", default: false },
    },
    required: ["workflowId"],
  },
  async execute(node, ctx, engine) {
    const workflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const mode = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const inheritContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.inheritContext ?? true, ctx),
      true,
    );
    const allowRecursive = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.allowRecursive ?? false, ctx),
      false,
    );

    if (!workflowId) {
      throw new Error("flow.universal: 'workflowId' is required");
    }
    if (!engine || typeof engine.execute !== "function") {
      throw new Error("flow.universal: workflow engine is not available");
    }
    if (mode !== "sync" && mode !== "dispatch") {
      throw new Error(`flow.universal: invalid mode \"${mode}\"`);
    }

    const resolvedInputConfig = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    if (
      resolvedInputConfig != null &&
      (typeof resolvedInputConfig !== "object" || Array.isArray(resolvedInputConfig))
    ) {
      throw new Error("flow.universal: 'input' must resolve to an object");
    }
    const configuredInput = resolvedInputConfig && typeof resolvedInputConfig === "object"
      ? resolvedInputConfig
      : {};

    const sourceData = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
    const inheritedInput = inheritContext ? { ...sourceData } : {};

    const parentWorkflowId = String(ctx.data?._workflowId || "").trim();
    const workflowStack = normalizeWorkflowStack(ctx.data?._workflowStack);
    if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
      workflowStack.push(parentWorkflowId);
    }
    if (!allowRecursive && workflowStack.includes(workflowId)) {
      const cyclePath = [...workflowStack, workflowId].join(" -> ");
      throw new Error(
        `flow.universal: recursive workflow call blocked (${cyclePath}). Set allowRecursive=true to override.`,
      );
    }

    const childInput = applyChildWorkflowLineage(ctx, {
      ...inheritedInput,
      ...configuredInput,
    }, workflowId);
    const childRunOpts = makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: workflowId, sourceNodeId: node.id });
    const trackedTaskId = String(
      ctx.data?.taskId ||
      ctx.data?.task?.id ||
      ctx.data?.taskDetail?.id ||
      ctx.data?.taskInfo?.id ||
      "",
    ).trim();
    const trackedTaskTitle = String(
      ctx.data?.taskTitle ||
      ctx.data?.task?.title ||
      ctx.data?.taskDetail?.title ||
      ctx.data?.taskInfo?.title ||
      trackedTaskId,
    ).trim();
    const tracker = trackedTaskId ? getSessionTracker() : null;
    if (tracker && trackedTaskId) {
      const existing = tracker.getSessionById(trackedTaskId);
      if (!existing) {
        tracker.createSession({
          id: trackedTaskId,
          type: "task",
          taskId: trackedTaskId,
          metadata: {
            title: trackedTaskTitle || trackedTaskId,
            workspaceId: String(ctx.data?.workspaceId || ctx.data?.activeWorkspace || "").trim() || undefined,
            workspaceDir: String(ctx.data?.worktreePath || ctx.data?.workspaceDir || "").trim() || undefined,
            branch:
              String(
                ctx.data?.branch ||
                ctx.data?.task?.branchName ||
                ctx.data?.taskDetail?.branchName ||
                ctx.data?.taskInfo?.branchName ||
                "",
              ).trim() || undefined,
          },
        });
      } else {
        tracker.updateSessionStatus(trackedTaskId, "active");
        if (trackedTaskTitle) tracker.renameSession(trackedTaskId, trackedTaskTitle);
      }
      tracker.recordEvent(trackedTaskId, {
        role: "system",
        type: "system",
        content: `Delegating to workflow "${workflowId}"`,
        timestamp: new Date().toISOString(),
        _sessionType: "task",
      });
    }

    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching universal workflow \"${workflowId}\"`);
      let dispatched;
      try {
        dispatched = Promise.resolve(engine.execute(workflowId, childInput, childRunOpts));
      } catch (err) {
        dispatched = Promise.reject(err);
      }
      dispatched
        .then((childCtx) => {
          const status = childCtx?.errors?.length ? "failed" : "completed";
          if (tracker && trackedTaskId) {
            tracker.recordEvent(trackedTaskId, {
              role: status === "completed" ? "assistant" : "system",
              type: status === "completed" ? "agent_message" : "error",
              content: `Workflow "${workflowId}" ${status}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.updateSessionStatus(trackedTaskId, status);
          }
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" finished with status=${status}`);
        })
        .catch((err) => {
          if (tracker && trackedTaskId) {
            tracker.updateSessionStatus(trackedTaskId, "failed");
            tracker.recordEvent(trackedTaskId, {
              role: "system",
              type: "error",
              content: `Workflow "${workflowId}" failed: ${err.message}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
          }
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" failed: ${err.message}`, "error");
        });

      const output = {
        success: true,
        queued: true,
        mode: "dispatch",
        workflowId,
        parentRunId: ctx.id,
      };
      if (outputVariable) ctx.data[outputVariable] = output;
      return output;
    }

    ctx.log(node.id, `Executing universal workflow \"${workflowId}\" (sync)`);
    const childCtx = await engine.execute(workflowId, childInput, childRunOpts);
    const errorCount = Array.isArray(childCtx?.errors) ? childCtx.errors.length : 0;
    const output = {
      success: errorCount === 0,
      queued: false,
      mode: "sync",
      workflowId,
      runId: childCtx?.id || null,
      status: errorCount > 0 ? "failed" : "completed",
      message: String(childCtx?.data?._workflowTerminalMessage || "").trim(),
      output: childCtx?.data?._workflowTerminalOutput,
      errorCount,
    };
    if (tracker && trackedTaskId) {
      tracker.recordEvent(trackedTaskId, {
        role: output.status === "completed" ? "assistant" : "system",
        type: output.status === "completed" ? "agent_message" : "error",
        content: `Workflow "${workflowId}" ${output.status}${output.message ? `: ${output.message}` : ""}`,
        timestamp: new Date().toISOString(),
        _sessionType: "task",
      });
      tracker.updateSessionStatus(trackedTaskId, output.status);
    }
    if (outputVariable) ctx.data[outputVariable] = output;
    return output;
  },
};

registerBuiltinNodeType("flow.universal", UNIVERSAL_FLOW_NODE);
registerBuiltinNodeType("flow.universial", UNIVERSAL_FLOW_NODE);

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  LOOP / ITERATION
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("loop.for_each", {
  describe: () =>
    "Iterate over an array, executing a sub-workflow for each item. " +
    "Supports sync or dispatch fan-out via maxConcurrent and provides per-item " +
    "context injection under the configured variable name.",
  schema: {
    type: "object",
    properties: {
      items: { type: "string", description: "Expression that resolves to an array" },
      variable: { type: "string", default: "item", description: "Variable name for current item" },
      indexVariable: { type: "string", default: "index", description: "Variable name for current index" },
      maxIterations: { type: "number", default: 50, description: "Cap on total iterations" },
      maxConcurrent: { type: "number", default: 1, description: "Parallel fan-out width (1 = sequential)" },
      workflowId: { type: "string", description: "Sub-workflow to execute for each item (optional)" },
      mode: {
        type: "string",
        enum: ["sync", "dispatch"],
        default: "sync",
        description: "sync waits for child workflows; dispatch fires and forgets",
      },
    },
    required: ["items"],
  },
  async execute(node, ctx, engine) {
    const expr = node.config?.items || "[]";
    let items;
    try {
      const fn = new Function("$data", "$ctx", `return (${expr});`);
      items = fn(ctx.data, ctx);
    } catch {
      items = [];
    }
    if (!Array.isArray(items)) items = [items];
    const max = node.config?.maxIterations || 50;
    items = items.slice(0, max);
    const varName = node.config?.variable || "item";
    const indexVar = node.config?.indexVariable || "index";
    const maxConcurrent = Math.max(1, node.config?.maxConcurrent || 1);
    const subWorkflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const modeRaw = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const mode = modeRaw === "dispatch" ? "dispatch" : "sync";

    // Store items for downstream processing (backward compat)
    ctx.data[`_loop_${node.id}_items`] = items;
    ctx.data[`_loop_${node.id}_count`] = items.length;

    const results = [];

    // If a sub-workflow is specified, fan-out execution across items
    if (subWorkflowId && engine?.execute) {
      ctx.log(
        node.id,
        `Fan-out: ${items.length} item(s), concurrency=${maxConcurrent}, workflow=${subWorkflowId}, mode=${mode}`,
      );

      // Process items in batches of maxConcurrent
      for (let batchStart = 0; batchStart < items.length; batchStart += maxConcurrent) {
        const batch = items.slice(batchStart, batchStart + maxConcurrent);
        const batchPromises = batch.map(async (item, batchIdx) => {
          const itemIndex = batchStart + batchIdx;
          const itemData = applyChildWorkflowLineage(ctx, {
            ...ctx.data,
            [varName]: item,
            [indexVar]: itemIndex,
            _loopParentNodeId: node.id,
            _loopIteration: itemIndex,
            _loopTotal: items.length,
          }, subWorkflowId);
          try {
            const childRunOpts = makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: subWorkflowId, sourceNodeId: node.id });
            if (mode === "dispatch") {
              const dispatched = Promise.resolve(engine.execute(subWorkflowId, itemData, childRunOpts));
              dispatched
                .then((runCtx) => {
                  const status = runCtx?.errors?.length ? "failed" : "completed";
                  ctx.log(
                    node.id,
                    `Dispatched loop child "${subWorkflowId}" iteration ${itemIndex} finished with status=${status}`,
                  );
                })
                .catch((err) => {
                  ctx.log(
                    node.id,
                    `Dispatched loop child "${subWorkflowId}" iteration ${itemIndex} failed: ${err.message}`,
                    "error",
                  );
                });
              return {
                index: itemIndex,
                item,
                success: true,
                queued: true,
                workflowId: subWorkflowId,
                mode: "dispatch",
                parentRunId: ctx.id,
              };
            }
            const runCtx = await engine.execute(subWorkflowId, itemData, childRunOpts);
            const ok = !runCtx?.errors?.length;
            return {
              index: itemIndex,
              item,
              success: ok,
              queued: false,
              workflowId: subWorkflowId,
              mode: "sync",
              runId: runCtx?.id || null,
            };
          } catch (err) {
            return { index: itemIndex, item, success: false, error: err?.message || String(err) };
          }
        });
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }
    } else {
      // No sub-workflow — store items for downstream node access (legacy mode)
      for (let i = 0; i < items.length; i++) {
        ctx.data[varName] = items[i];
        ctx.data[indexVar] = i;
        results.push({ index: i, item: items[i], success: true });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;
    ctx.log(node.id, `Loop complete: ${successCount} succeeded, ${failCount} failed out of ${items.length}`);

    return {
      items,
      count: items.length,
      totalItems: items.length,
      variable: varName,
      results,
      successCount,
      failCount,
    };
  },
});

registerBuiltinNodeType("loop.while", {
  describe: () =>
    "Repeat a sub-workflow until a condition evaluates to false or max iterations " +
    "are reached. Enables convergence loops (generate→verify→revise) by executing " +
    "a child workflow repeatedly and passing each iteration's output as input to the next.",
  schema: {
    type: "object",
    properties: {
      condition: {
        type: "string",
        description:
          "JS expression evaluated AFTER each iteration. Loop continues while this is truthy. " +
          "Access $data (accumulated state), $iteration (current 0-based index), $result (last iteration output).",
      },
      workflowId: { type: "string", description: "Sub-workflow to execute each iteration" },
      maxIterations: { type: "number", default: 10, description: "Safety cap on total iterations" },
      stateVariable: {
        type: "string",
        default: "loopState",
        description: "Context key that accumulates state across iterations",
      },
      delayMs: { type: "number", default: 0, description: "Delay between iterations (ms)" },
      earlyExitOn: {
        type: "string",
        enum: ["success", "failure", "never"],
        default: "never",
        description: "Stop early when sub-workflow succeeds or fails",
      },
    },
    required: ["condition"],
  },
  async execute(node, ctx, engine) {
    const condExpr = node.config?.condition || "false";
    const subWorkflowId = ctx.resolve(node.config?.workflowId || "");
    const maxIter = Math.max(1, Math.min(200, Number(node.config?.maxIterations) || 10));
    const stateVar = node.config?.stateVariable || "loopState";
    const delayMs = Math.max(0, Number(node.config?.delayMs) || 0);
    const earlyExitOn = node.config?.earlyExitOn || "never";

    const iterations = [];
    let loopState = ctx.data[stateVar] || {};
    let converged = false;
    let lastResult = null;

    for (let i = 0; i < maxIter; i++) {
      ctx.log(node.id, `While-loop iteration ${i + 1}/${maxIter}`);

      // Execute sub-workflow if specified
      if (subWorkflowId && engine?.execute) {
        const iterInput = applyChildWorkflowLineage(ctx, {
          ...ctx.data,
          [stateVar]: loopState,
          _whileIteration: i,
          _whileMaxIterations: maxIter,
          _previousAttempts: iterations.map((r) => r.output),
        }, subWorkflowId);

        try {
          const childCtx = await engine.execute(subWorkflowId, iterInput, {
            ...makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: subWorkflowId, sourceNodeId: node.id }),
            force: true,
          });
          const ok = !childCtx?.errors?.length;
          const childOutputs = childCtx?.nodeOutputs
            ? Object.fromEntries(childCtx.nodeOutputs)
            : {};
          lastResult = { success: ok, outputs: childOutputs, runId: childCtx?.id || null };

          // Merge child outputs into loop state
          loopState = { ...loopState, ...childOutputs, _lastSuccess: ok, _iteration: i };
          iterations.push({ index: i, success: ok, output: childOutputs });

          // Early exit
          if (earlyExitOn === "success" && ok) {
            ctx.log(node.id, `Early exit: sub-workflow succeeded on iteration ${i + 1}`);
            converged = true;
            break;
          }
          if (earlyExitOn === "failure" && !ok) {
            ctx.log(node.id, `Early exit: sub-workflow failed on iteration ${i + 1}`);
            converged = true;
            break;
          }
        } catch (err) {
          lastResult = { success: false, error: err.message };
          iterations.push({ index: i, success: false, error: err.message });
          loopState = { ...loopState, _lastSuccess: false, _lastError: err.message, _iteration: i };
        }
      } else {
        // No sub-workflow — just evaluate condition each cycle (useful with
        // back-edge patterns where downstream inline nodes modify context)
        lastResult = { success: true, data: ctx.data };
        loopState = { ...loopState, _iteration: i };
        iterations.push({ index: i, success: true });
      }

      // Update context with accumulated state
      ctx.data[stateVar] = loopState;

      // Evaluate continue condition
      try {
        const fn = new Function("$data", "$iteration", "$result", "$state",
          `return (${condExpr});`);
        const shouldContinue = fn(ctx.data, i, lastResult, loopState);
        if (!shouldContinue) {
          ctx.log(node.id, `Condition false after iteration ${i + 1} — loop converged`);
          converged = true;
          break;
        }
      } catch (err) {
        ctx.log(node.id, `Condition eval error: ${err.message} — stopping loop`, "warn");
        converged = true;
        break;
      }

      // Inter-iteration delay
      if (delayMs > 0 && i < maxIter - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const totalIterations = iterations.length;
    const successCount = iterations.filter((r) => r.success).length;
    ctx.log(node.id,
      `While-loop done: ${totalIterations} iteration(s), ${successCount} succeeded, converged=${converged}`);

    return {
      converged,
      iterations: totalIterations,
      maxIterations: maxIter,
      successCount,
      failCount: totalIterations - successCount,
      results: iterations,
      finalState: loopState,
      lastResult,
    };
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  SESSION / AGENT MANAGEMENT — Direct session control
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("action.continue_session", {
  describe: () => "Re-attach to an existing agent session and send a continuation prompt",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to continue (supports {{variables}})" },
      prompt: { type: "string", description: "Continuation prompt for the agent" },
      timeoutMs: { type: "number", default: 1800000, description: "Timeout for continuation in ms" },
      strategy: { type: "string", enum: ["continue", "retry", "refine", "finish_up"], default: "continue", description: "Continuation strategy" },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const sessionId = ctx.resolve(node.config?.sessionId || ctx.data?.sessionId || "");
    const prompt = ctx.resolve(node.config?.prompt || "Continue working on the current task.");
    const timeout = node.config?.timeoutMs || 1800000;
    const strategy = node.config?.strategy || "continue";
    const issueAdvisor =
      ctx.data?._issueAdvisor && typeof ctx.data._issueAdvisor === "object"
        ? ctx.data._issueAdvisor
        : null;
    const dagStateSummary =
      ctx.data?._plannerFeedback?.dagStateSummary && typeof ctx.data._plannerFeedback.dagStateSummary === "object"
        ? ctx.data._plannerFeedback.dagStateSummary
        : null;
    const continuationPrefix = issueAdvisor
      ? [
        "Issue-advisor continuation context:",
        `- Recommendation: ${issueAdvisor.recommendedAction || "continue"}`,
        issueAdvisor.summary ? `- Summary: ${issueAdvisor.summary}` : null,
        issueAdvisor.nextStepGuidance ? `- Guidance: ${issueAdvisor.nextStepGuidance}` : null,
        dagStateSummary?.counts ? `- DAG counts: completed=${Number(dagStateSummary.counts.completed ?? 0) || 0}, failed=${Number(dagStateSummary.counts.failed ?? 0) || 0}, pending=${Number(dagStateSummary.counts.pending ?? 0) || 0}` : null,
      ].filter(Boolean).join("\n") + "\n\n"
      : "";
    const enrichedPrompt = continuationPrefix ? `${continuationPrefix}${prompt}` : prompt;

    ctx.log(node.id, `Continuing session ${sessionId} (strategy: ${strategy})`);

    const agentPool = engine.services?.agentPool;
    if (agentPool?.continueSession) {
      const result = await agentPool.continueSession(sessionId, enrichedPrompt, { timeout, strategy });

      // Propagate session ID for downstream chaining
      const threadId = result.threadId || sessionId;
      ctx.data.sessionId = threadId;
      ctx.data.threadId = threadId;

      return { success: result.success, output: result.output, sessionId: threadId, strategy };
    }

    // Fallback: use ephemeral thread with continuation context
    if (agentPool?.launchEphemeralThread) {
      const continuation = strategy === "retry"
        ? `Start over on this task. Previous attempt failed.\n\n${enrichedPrompt}`
        : strategy === "refine"
        ? `Refine your previous work. Specifically:\n\n${enrichedPrompt}`
        : strategy === "finish_up"
        ? `Wrap up the current task. Commit, push, and hand off PR lifecycle to Bosun. Ensure tests pass.\n\n${enrichedPrompt}`
        : `Continue where you left off.\n\n${enrichedPrompt}`;

      const result = await agentPool.launchEphemeralThread(continuation, ctx.data?.worktreePath || process.cwd(), timeout);

      // Propagate new session ID from fallback
      const threadId = result.threadId || result.sessionId || sessionId;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      return { success: result.success, output: result.output, sessionId: threadId, strategy, fallback: true };
    }

    return { success: false, error: "Agent pool not available" };
  },
});

registerBuiltinNodeType("action.restart_agent", {
  describe: () => "Kill and restart an agent session from scratch",
  schema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to restart" },
      reason: { type: "string", description: "Reason for restart (logged and given as context)" },
      sdk: { type: "string", enum: ["codex", "copilot", "claude", "auto"], default: "auto" },
      prompt: { type: "string", description: "New prompt for the restarted agent" },
      cwd: { type: "string", description: "Working directory" },
      timeoutMs: { type: "number", default: 3600000 },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const sessionId = ctx.resolve(node.config?.sessionId || ctx.data?.sessionId || "");
    const reason = ctx.resolve(node.config?.reason || "workflow restart");
    const prompt = ctx.resolve(node.config?.prompt || "");
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());

    ctx.log(node.id, `Restarting agent session ${sessionId}: ${reason}`);

    const agentPool = engine.services?.agentPool;

    // Try to kill existing session first
    if (sessionId && agentPool?.killSession) {
      try {
        await agentPool.killSession(sessionId);
        ctx.log(node.id, `Killed previous session ${sessionId}`);
      } catch (err) {
        ctx.log(node.id, `Could not kill session ${sessionId}: ${err.message}`, "warn");
      }
    }

    // Launch new session
    if (agentPool?.launchEphemeralThread) {
      const result = await agentPool.launchEphemeralThread(
        `Previous attempt failed (reason: ${reason}). Starting fresh.\n\n${prompt}`,
        cwd,
        node.config?.timeoutMs || 3600000
      );

      // Propagate new session/thread IDs for downstream chaining
      const newThreadId = result.threadId || result.sessionId || null;
      if (newThreadId) {
        ctx.data.sessionId = newThreadId;
        ctx.data.threadId = newThreadId;
      }

      return { success: result.success, output: result.output, newSessionId: newThreadId, previousSessionId: sessionId, threadId: newThreadId };
    }

    return { success: false, error: "Agent pool not available" };
  },
});

registerBuiltinNodeType("action.bosun_cli", {
  describe: () => "Run a bosun CLI command (task, monitor, agent, etc.)",
  schema: {
    type: "object",
    properties: {
      subcommand: { type: "string", enum: [
        "task list", "task create", "task get", "task update", "task delete",
        "task stats", "task plan", "task import",
        "agent list", "agent continue", "agent kill",
        "--daemon-status", "--echo-logs",
        "config show", "config doctor",
      ], description: "Bosun CLI subcommand" },
      args: { type: "string", description: "Additional arguments (e.g., --status todo --json)" },
      parseJson: { type: "boolean", default: true, description: "Parse JSON output automatically" },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before running this Bosun CLI command even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: ["subcommand"],
  },
  async execute(node, ctx, engine) {
    const sub = node.config?.subcommand || "";
    const args = ctx.resolve(node.config?.args || "");
    const cmd = `bosun ${sub} ${args}`.trim();

    ctx.log(node.id, `Running: ${cmd}`);
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.bosun_cli",
      repoRoot: ctx?.data?.repoRoot || process.cwd(),
      command: "bosun",
      args: [sub, args].filter(Boolean),
    });
    try {
      const output = execSync(cmd, { encoding: "utf8", timeout: 60000, stdio: "pipe" });
      let parsed = output?.trim();
      if (node.config?.parseJson !== false) {
        try { parsed = JSON.parse(parsed); } catch { /* not JSON, keep as string */ }
      }
      return { success: true, output: parsed, command: cmd };
    } catch (err) {
      return { success: false, error: err.message, command: cmd };
    }
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  BOSUN NATIVE TOOLS — Invoke Bosun's built-in/custom tools and workflows
//  from within workflow nodes. These nodes enable:
//    1. Programmatic tool invocation with structured I/O (action.bosun_tool)
//    2. Lightweight sub-workflow invocation with data piping (action.invoke_workflow)
//    3. Direct Bosun function calls (action.bosun_function)
//
//  Design: Every node produces structured output that can be piped via
//  {{nodeId.field}} templates to downstream nodes. Output extraction,
//  variable storage, and port-based routing are supported across all nodes.
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

/** Module-scope lazy caches for Bosun tool imports (per AGENTS.md rules). */
let _customToolsMod = null;
async function getCustomToolsMod() {
  if (!_customToolsMod) {
    _customToolsMod = await import("../agent/agent-custom-tools.mjs");
  }
  return _customToolsMod;
}

function resolveBosunNativeRootDir(ctx, engine, explicitRoot = "") {
  const resolvedExplicit = String(explicitRoot || "").trim();
  if (resolvedExplicit) return resolvedExplicit;

  const ctxRoot = String(ctx?.data?.worktreePath || ctx?.data?.repoRoot || "").trim();
  if (ctxRoot) return ctxRoot;

  const workflowDir = String(engine?.workflowDir || "").trim();
  if (workflowDir) {
    const normalizedWorkflowDir = resolve(workflowDir);
    const workflowDirName = basename(normalizedWorkflowDir).toLowerCase();
    if (workflowDirName === "workflows") {
      const parentDir = dirname(normalizedWorkflowDir);
      if (basename(parentDir).toLowerCase() === ".bosun") {
        return dirname(parentDir);
      }
      return parentDir;
    }
    return dirname(normalizedWorkflowDir);
  }

  return process.cwd();
}

let _kanbanMod = null;
async function getKanbanMod() {
  if (!_kanbanMod) {
    _kanbanMod = await import("../kanban/kanban-adapter.mjs");
  }
  return _kanbanMod;
}

// ==== action.bosun_tool ====
// Invoke any Bosun built-in or custom tool programmatically with structured
// input/output. Unlike action.bosun_cli (which shells out), this executes
// the tool script directly in-process and returns parsed, structured data.

registerBuiltinNodeType("action.bosun_tool", {
  describe: () =>
    "Invoke a Bosun built-in or custom tool programmatically. Returns " +
    "structured output that downstream workflow nodes can consume via " +
    "{{nodeId.field}} templates. Supports field extraction, output mapping, " +
    "and port-based routing for conditional branching.",
  schema: {
    type: "object",
    properties: {
      toolId: {
        type: "string",
        description:
          "ID of the Bosun tool to invoke (e.g. 'list-todos', 'test-file-pairs', " +
          "'git-hot-files', 'imports-graph', 'dead-exports-scan', or any custom tool ID)",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "CLI arguments passed to the tool script. Supports {{variable}} interpolation.",
      },
      env: {
        type: "object",
        description: "Environment variables to pass to the tool process",
        additionalProperties: { type: "string" },
      },
      cwd: {
        type: "string",
        description: "Working directory for tool execution (default: workspace root)",
      },
      timeoutMs: {
        type: "number",
        default: 60000,
        description: "Maximum execution time in milliseconds",
      },
      parseJson: {
        type: "boolean",
        default: true,
        description: "Automatically parse JSON output into structured data",
      },
      extract: {
        type: "object",
        description:
          "Structured data extraction config — extract specific fields from " +
          "tool output for downstream piping (same schema as action.mcp_tool_call).",
        properties: {
          root: { type: "string", description: "Root path to start extraction from" },
          fields: {
            type: "object",
            description: "Map of outputKey → sourcePath (dot-path, wildcard, JSON pointer)",
            additionalProperties: { type: "string" },
          },
          defaults: { type: "object", additionalProperties: true },
          types: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      outputMap: {
        type: "object",
        description: "Rename/reshape output fields for downstream nodes",
        additionalProperties: true,
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store result in ctx.data",
      },
      portConfig: {
        type: "object",
        description: "Output port routing based on tool result (for conditional branching)",
        properties: {
          field: { type: "string", description: "Field to use as port selector (default: 'success')" },
          map: { type: "object", additionalProperties: { type: "string" } },
          default: { type: "string", description: "Default port (default: 'default')" },
        },
      },
    },
    required: ["toolId"],
  },
  async execute(node, ctx, engine) {
    const toolId = ctx.resolve(node.config?.toolId || "");
    if (!toolId) throw new Error("action.bosun_tool: 'toolId' is required");

    const rootDir = resolveBosunNativeRootDir(ctx, engine);
    const cwd = ctx.resolve(node.config?.cwd || "") || rootDir;
    const timeoutMs = node.config?.timeoutMs || 60000;

    // Resolve args with template interpolation
    const rawArgs = Array.isArray(node.config?.args) ? node.config.args : [];
    const resolvedArgs = rawArgs.map((a) => String(ctx.resolve(a) ?? ""));

    // Resolve environment variables
    const envOverrides = {};
    if (node.config?.env && typeof node.config.env === "object") {
      for (const [key, value] of Object.entries(node.config.env)) {
        envOverrides[key] = String(ctx.resolve(value) ?? "");
      }
    }

    ctx.log(node.id, `Invoking Bosun tool: ${toolId} ${resolvedArgs.join(" ")}`.trim());
    const toolStartedAt = Date.now();
    const bosunToolLedgerRef = buildNodeExecutionLedgerRef(ctx, node, "tool", ["bosun", toolId], toolId);
    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
      eventType: "tool.started",
      ...bosunToolLedgerRef,
      toolId,
      toolName: toolId,
      status: "running",
      meta: {
        provider: "bosun",
        cwd,
        args: resolvedArgs,
      },
    }));

    const toolsMod = await getCustomToolsMod();

    // Verify tool exists
    const toolInfo = toolsMod.getCustomTool(rootDir, toolId);
    if (!toolInfo) {
      ctx.log(node.id, `Tool "${toolId}" not found`, "error");
      const errResult = {
        success: false,
        error: `Tool "${toolId}" not found. Available tools: ${toolsMod.listCustomTools(rootDir).map((t) => t.id).join(", ")}`,
        toolId,
        matchedPort: "error",
        port: "error",
      };
      recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
        eventType: "tool.failed",
        ...bosunToolLedgerRef,
        toolId,
        toolName: toolId,
        status: "failed",
        durationMs: Date.now() - toolStartedAt,
        error: errResult.error,
        meta: { provider: "bosun", cwd },
      }));
      if (node.config?.outputVariable) ctx.data[node.config.outputVariable] = errResult;
      return errResult;
    }

    // Execute tool
    let toolResult;
    try {
      toolResult = await toolsMod.invokeCustomTool(rootDir, toolId, resolvedArgs, {
        timeout: timeoutMs,
        cwd,
        env: envOverrides,
      });
    } catch (err) {
      ctx.log(node.id, `Tool execution failed: ${err.message}`, "error");
      const errResult = {
        success: false,
        error: err.message,
        toolId,
        matchedPort: "error",
        port: "error",
      };
      recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
        eventType: "tool.failed",
        ...bosunToolLedgerRef,
        toolId,
        toolName: toolId,
        status: "failed",
        durationMs: Date.now() - toolStartedAt,
        error: errResult.error,
        meta: { provider: "bosun", cwd },
      }));
      recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
        eventType: "tool.failed",
        ...bosunToolLedgerRef,
        toolId,
        toolName: toolId,
        status: "failed",
        durationMs: Date.now() - toolStartedAt,
        error: err.message,
        meta: { provider: "bosun", cwd },
      }));
      if (node.config?.outputVariable) ctx.data[node.config.outputVariable] = errResult;
      return errResult;
    }

    // Parse output
    const exitSuccess = toolResult.exitCode === 0;
    let data = toolResult.stdout?.trim() || "";
    if (node.config?.parseJson !== false && data) {
      try { data = JSON.parse(data); } catch { /* keep as string */ }
    }

    let output = {
      success: exitSuccess,
      toolId,
      exitCode: toolResult.exitCode,
      data,
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      toolTitle: toolInfo.entry?.title || toolId,
      toolCategory: toolInfo.entry?.category || "unknown",
    };

    // ==== Structured data extraction (same pattern as MCP tool call) ====
    if (node.config?.extract && exitSuccess) {
      const adapter = await getMcpAdapter();
      const sourceData = typeof data === "object" && data !== null ? data : { text: data };
      const extracted = adapter.extractMcpOutput(sourceData, node.config.extract);
      output = { ...output, extracted, ...extracted };
      ctx.log(node.id, `Extracted ${Object.keys(extracted).length} field(s)`);
    }

    // ==== Output mapping ====
    if (node.config?.outputMap && exitSuccess) {
      const adapter = await getMcpAdapter();
      const mapped = adapter.mapOutputFields(output, node.config.outputMap, ctx);
      output = { ...output, mapped, ...mapped };
      ctx.log(node.id, `Mapped ${Object.keys(mapped).length} field(s)`);
    }

    // ==== Port-based routing ====
    if (node.config?.portConfig) {
      const adapter = await getMcpAdapter();
      const port = adapter.resolveOutputPort(output, node.config.portConfig);
      output.matchedPort = port;
      output.port = port;
    } else {
      output.matchedPort = exitSuccess ? "default" : "error";
      output.port = exitSuccess ? "default" : "error";
    }

    // Store in ctx.data if requested
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }

    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
      eventType: exitSuccess ? "tool.completed" : "tool.failed",
      ...bosunToolLedgerRef,
      toolId,
      toolName: toolId,
      status: exitSuccess ? "completed" : "failed",
      durationMs: Date.now() - toolStartedAt,
      error: exitSuccess ? null : (toolResult.stderr || null),
      summary: typeof data === "string" ? data.slice(0, 240) : null,
      meta: {
        provider: "bosun",
        cwd,
        exitCode: toolResult.exitCode,
      },
    }));
    if (exitSuccess) {
      ctx.log(node.id, `Tool "${toolId}" completed (exit ${toolResult.exitCode})`);
    } else {
      ctx.log(node.id, `Tool "${toolId}" failed (exit ${toolResult.exitCode}): ${toolResult.stderr?.slice(0, 200)}`, "warn");
    }

    return output;
  },
});

// ==== action.invoke_workflow ====
// Lightweight sub-workflow invocation with automatic output forwarding.
// While action.execute_workflow is comprehensive, this node provides
// simpler ergonomics for the common case of "run workflow X and pipe
// its output to the next node".

registerBuiltinNodeType("action.invoke_workflow", {
  describe: () =>
    "Invoke another workflow and pipe its output to downstream nodes. " +
    "Simpler than action.execute_workflow — designed for workflow-to-workflow " +
    "data piping. Automatically forwards the child workflow's final node " +
    "outputs as structured data accessible via {{nodeId.field}} templates.",
  schema: {
    type: "object",
    properties: {
      workflowId: {
        type: "string",
        description: "ID of the workflow to invoke (supports {{variable}} templates)",
      },
      input: {
        type: "object",
        description: "Input data passed to the child workflow (supports {{variable}} templates)",
        additionalProperties: true,
      },
      mode: {
        type: "string",
        enum: ["sync", "dispatch"],
        default: "sync",
        description: "sync: wait for result; dispatch: fire-and-forget",
      },
      forwardFields: {
        type: "array",
        items: { type: "string" },
        description:
          "List of field names to extract from the child workflow's output " +
          "and promote to this node's top-level output. By default, all " +
          "child output fields are forwarded.",
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the full invocation result in ctx.data",
      },
      timeout: {
        type: "number",
        default: 300000,
        description: "Maximum wait time for sync mode (ms)",
      },
      failOnError: {
        type: "boolean",
        default: false,
        description: "Throw (fail this node) if the child workflow has errors. Default: false (soft fail).",
      },
      pipeContext: {
        type: "boolean",
        default: false,
        description: "Pass all current context data as input to the child workflow",
      },
      extractFromNodes: {
        type: "array",
        items: { type: "string" },
        description:
          "List of node IDs in the child workflow whose outputs should be " +
          "extracted and forwarded. If empty, the last completed node's output " +
          "is forwarded.",
      },
    },
    required: ["workflowId"],
  },
  async execute(node, ctx, engine) {
    const workflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const mode = String(ctx.resolve(node.config?.mode || "sync") || "sync").trim().toLowerCase();
    const failOnError = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnError ?? false, ctx),
      false,
    );
    const pipeContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.pipeContext ?? false, ctx),
      false,
    );

    if (!workflowId) {
      throw new Error("action.invoke_workflow: 'workflowId' is required");
    }
    if (!engine || typeof engine.execute !== "function") {
      throw new Error("action.invoke_workflow: workflow engine is not available");
    }
    if (typeof engine.get === "function" && !engine.get(workflowId)) {
      const notFoundMsg = `action.invoke_workflow: workflow "${workflowId}" not found`;
      if (failOnError) throw new Error(notFoundMsg);
      ctx.log(node.id, notFoundMsg, "warn");
      return { success: false, error: notFoundMsg, workflowId, mode, matchedPort: "error", port: "error" };
    }

    // Build child input from config + optional context piping
    const resolvedInput = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    const childInput = applyChildWorkflowLineage(ctx, {
      ...(pipeContext ? { ...ctx.data } : {}),
      ...(typeof resolvedInput === "object" && resolvedInput !== null ? resolvedInput : {}),
    }, workflowId);
    const childRunOpts = makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: workflowId, sourceNodeId: node.id });

    // ==== Dispatch mode ====
    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching workflow "${workflowId}" (fire-and-forget)`);
      let promise;
      try {
        promise = Promise.resolve(engine.execute(workflowId, childInput, childRunOpts));
      } catch (err) {
        promise = Promise.reject(err);
      }
      promise.catch((err) => {
        ctx.log(node.id, `Dispatched workflow "${workflowId}" failed: ${err.message}`, "error");
      });
      const output = {
        success: true,
        dispatched: true,
        workflowId,
        mode: "dispatch",
        matchedPort: "default",
        port: "default",
      };
      if (node.config?.outputVariable) ctx.data[node.config.outputVariable] = output;
      return output;
    }

    // ==== Sync mode — execute and harvest output ====
    ctx.log(node.id, `Invoking workflow "${workflowId}" (sync)`);

    let childCtx;
    const timeoutMs = node.config?.timeout || 300000;
    try {
      childCtx = await Promise.race([
        engine.execute(workflowId, childInput, childRunOpts),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Workflow "${workflowId}" timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (err) {
      ctx.log(node.id, `Workflow "${workflowId}" failed: ${err.message}`, "error");
      if (failOnError) throw err;
      return {
        success: false,
        error: err.message,
        workflowId,
        mode: "sync",
        matchedPort: "error",
        port: "error",
      };
    }

    const childErrors = Array.isArray(childCtx?.errors) ? childCtx.errors : [];
    const hasErrors = childErrors.length > 0;

    // ==== Extract outputs from child workflow ====
    const forwardedData = {};
    const extractFromNodes = Array.isArray(node.config?.extractFromNodes) ? node.config.extractFromNodes : [];

    if (childCtx?.nodeOutputs) {
      if (extractFromNodes.length > 0) {
        // Extract from specific named nodes
        for (const nodeId of extractFromNodes) {
          const nodeOut = childCtx.getNodeOutput(nodeId);
          if (nodeOut != null) {
            forwardedData[nodeId] = nodeOut;
            // Also flatten scalar fields to top-level
            if (typeof nodeOut === "object" && nodeOut !== null && !Array.isArray(nodeOut)) {
              Object.assign(forwardedData, nodeOut);
            }
          }
        }
      } else {
        // Forward all node outputs (last one wins for field name conflicts)
        for (const [nodeId, nodeOut] of childCtx.nodeOutputs) {
          if (typeof nodeOut === "object" && nodeOut !== null && !Array.isArray(nodeOut)) {
            Object.assign(forwardedData, nodeOut);
          }
        }
      }
    }

    // Apply forwardFields filter if specified
    const forwardFields = Array.isArray(node.config?.forwardFields) ? node.config.forwardFields : [];
    let filteredData;
    if (forwardFields.length > 0) {
      filteredData = {};
      for (const field of forwardFields) {
        if (Object.prototype.hasOwnProperty.call(forwardedData, field)) {
          filteredData[field] = forwardedData[field];
        }
      }
    } else {
      filteredData = forwardedData;
    }

    const output = {
      success: !hasErrors,
      workflowId,
      mode: "sync",
      runId: childCtx?.id || null,
      errorCount: childErrors.length,
      errors: childErrors.map((e) => ({
        nodeId: e?.nodeId || null,
        error: String(e?.error || "unknown"),
      })),
      childData: childCtx?.data || {},
      ...filteredData,
      matchedPort: hasErrors ? "error" : "default",
      port: hasErrors ? "error" : "default",
    };

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }

    if (hasErrors) {
      ctx.log(node.id, `Workflow "${workflowId}" completed with ${childErrors.length} error(s)`, "warn");
      if (failOnError) {
        const reason = childErrors[0]?.error || "child workflow failed";
        throw new Error(`action.invoke_workflow: "${workflowId}" failed: ${reason}`);
      }
    } else {
      ctx.log(node.id, `Workflow "${workflowId}" completed (${Object.keys(filteredData).length} field(s) forwarded)`);
    }

    return output;
  },
});

// ==== action.bosun_function ====
// Invoke an internal Bosun module function directly. This is the most
// powerful integration point — it allows workflows to call any registered
// Bosun capability (task operations, git operations, tool discovery, etc.)
// with structured input/output.

/**
 * Registry of callable Bosun functions.
 * Each entry: { module, fn, description, params }
 * Modules are lazy-imported to keep startup lean.
 */
const BOSUN_FUNCTION_REGISTRY = Object.freeze({
  // ==== Tool operations ====
  "tools.list": {
    description: "List all available Bosun tools (built-in + custom + global)",
    params: ["rootDir"],
    async invoke(args, ctx, engine) {
      const mod = await getCustomToolsMod();
      const rootDir = resolveBosunNativeRootDir(ctx, engine, args.rootDir);
      return mod.listCustomTools(rootDir, { includeBuiltins: true });
    },
  },
  "tools.get": {
    description: "Get details of a specific Bosun tool by ID",
    params: ["rootDir", "toolId"],
    async invoke(args, ctx, engine) {
      const mod = await getCustomToolsMod();
      const rootDir = resolveBosunNativeRootDir(ctx, engine, args.rootDir);
      const result = mod.getCustomTool(rootDir, args.toolId);
      if (!result) return { found: false, toolId: args.toolId };
      return { found: true, ...result.entry };
    },
  },
  "tools.builtin": {
    description: "List all built-in tool definitions",
    params: [],
    async invoke() {
      const mod = await getCustomToolsMod();
      return mod.listBuiltinTools();
    },
  },
  // ==== Task operations ====
  "tasks.list": {
    description: "List tasks from the kanban board",
    params: ["status", "limit"],
    async invoke(args, ctx, engine) {
      const kanban = engine?.services?.kanban;
      if (!kanban || typeof kanban.listTasks !== "function") {
        throw new Error("Kanban service not available");
      }
      const opts = {};
      if (args.status) opts.status = args.status;
      if (args.limit) opts.limit = Number(args.limit);
      return kanban.listTasks(opts);
    },
  },
  "tasks.get": {
    description: "Get a specific task by ID",
    params: ["taskId"],
    async invoke(args, ctx, engine) {
      const kanban = engine?.services?.kanban;
      if (!kanban || typeof kanban.getTask !== "function") {
        throw new Error("Kanban service not available");
      }
      return kanban.getTask(args.taskId);
    },
  },
  "tasks.create": {
    description: "Create a new task",
    params: ["title", "description", "priority", "labels"],
    async invoke(args, ctx, engine) {
      const kanban = engine?.services?.kanban;
      if (!kanban || typeof kanban.createTask !== "function") {
        throw new Error("Kanban service not available");
      }
      return kanban.createTask({
        title: args.title,
        description: args.description || "",
        priority: args.priority || "medium",
        labels: Array.isArray(args.labels) ? args.labels : [],
      });
    },
  },
  "tasks.update": {
    description: "Update a task's status or fields",
    params: ["taskId", "status", "fields"],
    async invoke(args, ctx, engine) {
      const kanban = engine?.services?.kanban;
      if (!kanban || typeof kanban.updateTask !== "function") {
        throw new Error("Kanban service not available");
      }
      const update = {};
      if (args.status) update.status = args.status;
      if (args.fields && typeof args.fields === "object") Object.assign(update, args.fields);
      return kanban.updateTask(args.taskId, update);
    },
  },
  // ==== Git operations ====
  "git.status": {
    description: "Get git status of the working directory",
    params: ["cwd"],
    async invoke(args, ctx) {
      const cwd = args.cwd || ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
      try {
        const output = execSync("git status --porcelain", { encoding: "utf8", cwd, timeout: 15000, stdio: "pipe" });
        const lines = output.trim().split("\n").filter(Boolean);
        return {
          clean: lines.length === 0,
          changedFiles: lines.length,
          files: lines.map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
        };
      } catch (err) {
        return { clean: false, error: err.message, changedFiles: -1, files: [] };
      }
    },
  },
  "git.log": {
    description: "Get recent git log entries",
    params: ["cwd", "count", "format"],
    async invoke(args, ctx) {
      const cwd = args.cwd || ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
      const count = Math.min(Math.max(1, Number(args.count) || 10), 100);
      try {
        const output = execSync(
          `git log --oneline -${count} --format="%H|%an|%ai|%s"`,
          { encoding: "utf8", cwd, timeout: 15000, stdio: "pipe" },
        );
        const commits = output.trim().split("\n").filter(Boolean).map((line) => {
          const [hash, author, date, ...rest] = line.split("|");
          return { hash, author, date, message: rest.join("|") };
        });
        return { commits, count: commits.length };
      } catch (err) {
        return { commits: [], count: 0, error: err.message };
      }
    },
  },
  "git.branch": {
    description: "Get current branch name and list branches",
    params: ["cwd"],
    async invoke(args, ctx) {
      const cwd = args.cwd || ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
      try {
        const lines = execFileSync("git", ["for-each-ref", "--format=%(HEAD)|%(refname:short)", "refs/heads"], {
          encoding: "utf8",
          cwd,
          timeout: 4000,
          stdio: "pipe",
        })
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const branches = [];
        let current = "";
        for (const line of lines) {
          const [headMarker, ...rest] = line.split("|");
          const branchName = rest.join("|").trim();
          if (!branchName) continue;
          branches.push(branchName);
          if (headMarker === "*") current = branchName;
        }
        if (!current) {
          current = execFileSync("git", ["branch", "--show-current"], {
            encoding: "utf8",
            cwd,
            timeout: 2000,
            stdio: "pipe",
          }).trim();
        }
        return { current, branches, branchCount: branches.length };
      } catch (err) {
        return { current: "", branches: [], branchCount: 0, error: err.message };
      }
    },
  },
  // ==== Workflow operations ====
  "workflows.list": {
    description: "List all registered workflows",
    params: [],
    async invoke(args, ctx, engine) {
      if (!engine || typeof engine.list !== "function") {
        throw new Error("Workflow engine not available");
      }
      const workflows = engine.list();
      return workflows.map((w) => ({
        id: w.id,
        name: w.name,
        enabled: w.enabled !== false,
        category: w.category || "custom",
        nodeCount: (w.nodes || []).length,
        edgeCount: (w.edges || []).length,
      }));
    },
  },
  "workflows.get": {
    description: "Get a workflow definition by ID",
    params: ["workflowId"],
    async invoke(args, ctx, engine) {
      if (!engine || typeof engine.get !== "function") {
        throw new Error("Workflow engine not available");
      }
      return engine.get(args.workflowId) || null;
    },
  },
  // ==== Config operations ====
  "config.show": {
    description: "Show current Bosun configuration",
    params: ["rootDir"],
    async invoke(args, ctx) {
      const rootDir = args.rootDir || ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
      try {
        const configPath = resolve(rootDir, ".bosun", "bosun.config.json");
        if (!existsSync(configPath)) return { exists: false, config: {} };
        return { exists: true, config: JSON.parse(readFileSync(configPath, "utf8")) };
      } catch (err) {
        return { exists: false, error: err.message, config: {} };
      }
    },
  },
});

registerBuiltinNodeType("action.bosun_function", {
  describe: () =>
    "Invoke an internal Bosun function directly (tasks, git, tools, workflows, config). " +
    "Returns structured output that downstream nodes can consume. More powerful " +
    "than action.bosun_cli — no subprocess overhead, direct structured data.",
  schema: {
    type: "object",
    properties: {
      function: {
        type: "string",
        enum: Object.keys(BOSUN_FUNCTION_REGISTRY),
        description: "Function to invoke. Available: " + Object.keys(BOSUN_FUNCTION_REGISTRY).join(", "),
      },
      args: {
        type: "object",
        description: "Arguments for the function (varies per function). Supports {{variable}} interpolation.",
        additionalProperties: true,
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the result in ctx.data",
      },
      extract: {
        type: "object",
        description: "Structured data extraction config (same as action.mcp_tool_call)",
        properties: {
          root: { type: "string" },
          fields: { type: "object", additionalProperties: { type: "string" } },
          defaults: { type: "object", additionalProperties: true },
          types: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      outputMap: {
        type: "object",
        description: "Rename/reshape output fields for downstream nodes",
        additionalProperties: true,
      },
    },
    required: ["function"],
  },
  async execute(node, ctx, engine) {
    const fnName = ctx.resolve(node.config?.function || "");
    if (!fnName) throw new Error("action.bosun_function: 'function' is required");

    const fnDef = BOSUN_FUNCTION_REGISTRY[fnName];
    if (!fnDef) {
      throw new Error(
        `action.bosun_function: unknown function "${fnName}". ` +
        `Available: ${Object.keys(BOSUN_FUNCTION_REGISTRY).join(", ")}`,
      );
    }

    // Resolve args with template interpolation
    const rawArgs = node.config?.args || {};
    const resolvedArgs = {};
    for (const [key, value] of Object.entries(rawArgs)) {
      resolvedArgs[key] = typeof value === "string" ? ctx.resolve(value) : resolveWorkflowNodeValue(value, ctx);
    }

    ctx.log(node.id, `Calling bosun.${fnName}(${JSON.stringify(resolvedArgs).slice(0, 200)})`);

    let result;
    try {
      result = await fnDef.invoke(resolvedArgs, ctx, engine);
    } catch (err) {
      ctx.log(node.id, `bosun.${fnName} failed: ${err.message}`, "error");
      return {
        success: false,
        function: fnName,
        error: err.message,
        matchedPort: "error",
        port: "error",
      };
    }

    let output = {
      success: true,
      function: fnName,
      data: result,
      matchedPort: "default",
      port: "default",
    };

    // Promote data fields to top-level for {{nodeId.field}} access
    if (result && typeof result === "object" && !Array.isArray(result)) {
      Object.assign(output, result);
    }

    // ==== Structured data extraction ====
    if (node.config?.extract) {
      const adapter = await getMcpAdapter();
      const sourceData = typeof result === "object" && result !== null ? result : { data: result };
      const extracted = adapter.extractMcpOutput(sourceData, node.config.extract);
      output = { ...output, extracted, ...extracted };
      ctx.log(node.id, `Extracted ${Object.keys(extracted).length} field(s)`);
    }

    // ==== Output mapping ====
    if (node.config?.outputMap) {
      const adapter = await getMcpAdapter();
      const mapped = adapter.mapOutputFields(output, node.config.outputMap, ctx);
      output = { ...output, mapped, ...mapped };
    }

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }

    ctx.log(node.id, `bosun.${fnName} completed`);
    return output;
  },
});

registerBuiltinNodeType("action.handle_rate_limit", {
  describe: () => "Intelligently handle API rate limits with exponential backoff and provider rotation",
  schema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "API provider that was rate limited (auto-detected if empty)" },
      baseDelayMs: { type: "number", default: 60000, description: "Base delay before retry (ms)" },
      maxDelayMs: { type: "number", default: 600000, description: "Maximum delay cap (ms)" },
      maxRetries: { type: "number", default: 5, description: "Maximum retry attempts" },
      fallbackProvider: { type: "string", enum: ["codex", "copilot", "claude", "none"], default: "none", description: "Alternative provider to try" },
      strategy: { type: "string", enum: ["wait", "rotate", "skip"], default: "wait", description: "Rate limit strategy" },
    },
  },
  async execute(node, ctx, engine) {
    const attempt = ctx.data?._rateLimitAttempt || 0;
    const maxRetries = node.config?.maxRetries || 5;
    const strategy = node.config?.strategy || "wait";

    if (attempt >= maxRetries) {
      ctx.log(node.id, `Rate limit: exhausted ${maxRetries} retries`, "error");
      return { success: false, action: "exhausted", attempts: attempt };
    }

    if (strategy === "skip") {
      ctx.log(node.id, "Rate limit: skipping (strategy=skip)");
      return { success: true, action: "skipped" };
    }

    if (strategy === "rotate" && node.config?.fallbackProvider && node.config.fallbackProvider !== "none") {
      ctx.log(node.id, `Rate limit: rotating to ${node.config.fallbackProvider}`);
      ctx.data._activeProvider = node.config.fallbackProvider;
      return { success: true, action: "rotated", provider: node.config.fallbackProvider };
    }

    // Exponential backoff
    const baseDelay = node.config?.baseDelayMs || 60000;
    const maxDelay = node.config?.maxDelayMs || 600000;
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

    ctx.log(node.id, `Rate limit: waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
    await new Promise((r) => setTimeout(r, delay));

    ctx.data._rateLimitAttempt = attempt + 1;
    return { success: true, action: "waited", delayMs: delay, attempt: attempt + 1 };
  },
});

registerBuiltinNodeType("action.ask_user", {
  describe: () => "Pause workflow and ask the user for input via Telegram or UI",
  schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask the user" },
      options: { type: "array", items: { type: "string" }, description: "Quick-reply options (optional)" },
      timeoutMs: { type: "number", default: 3600000, description: "How long to wait for response" },
      channel: { type: "string", enum: ["telegram", "ui", "both"], default: "both", description: "Where to ask" },
      variable: { type: "string", default: "userResponse", description: "Variable name to store the response" },
    },
    required: ["question"],
  },
  async execute(node, ctx, engine) {
    const question = ctx.resolve(node.config?.question || "");
    const options = node.config?.options || [];
    const channel = node.config?.channel || "both";
    const timeout = node.config?.timeoutMs || 3600000;

    ctx.log(node.id, `Asking user: ${question}`);

    // Send via Telegram if configured
    if ((channel === "telegram" || channel === "both") && engine.services?.telegram?.sendMessage) {
      const optionsText = options.length ? `\n\nOptions: ${options.join(" | ")}` : "";
      await engine.services.telegram.sendMessage(undefined, `:help: **Workflow Question**\n\n${question}${optionsText}`);
    }

    // Store question for UI polling
    ctx.data._pendingQuestion = { question, options, askedAt: Date.now(), timeout };

    // In real implementation, this would await a response
    // For now, return the question for the UI to handle
    const varName = node.config?.variable || "userResponse";
    const response = ctx.data[varName] || null;

    return {
      asked: true,
      question,
      options,
      response,
      variable: varName,
      channel,
    };
  },
});

registerBuiltinNodeType("action.analyze_errors", {
  describe: () => "Run the error detector on recent logs and classify failures",
  schema: {
    type: "object",
    properties: {
      logSource: { type: "string", enum: ["agent", "build", "test", "all"], default: "all", description: "Which logs to analyze" },
      timeWindowMs: { type: "number", default: 3600000, description: "How far back to look (ms)" },
      minSeverity: { type: "string", enum: ["info", "warn", "error", "fatal"], default: "error" },
      outputVariable: { type: "string", default: "errorAnalysis", description: "Variable to store analysis" },
    },
  },
  async execute(node, ctx, engine) {
    const source = node.config?.logSource || "all";
    const timeWindow = node.config?.timeWindowMs || 3600000;
    const minSeverity = node.config?.minSeverity || "error";

    ctx.log(node.id, `Analyzing errors from ${source} (last ${timeWindow}ms)`);

    // Try to use the anomaly detector service
    const detector = engine.services?.anomalyDetector;
    if (detector?.analyzeRecent) {
      const analysis = await detector.analyzeRecent({ source, timeWindow, minSeverity });
      if (node.config?.outputVariable) {
        ctx.data[node.config.outputVariable] = analysis;
      }
      return { success: true, ...analysis };
    }

    // Fallback: check for recent error files in .bosun/
    const errorDir = resolve(process.cwd(), ".bosun", "errors");
    const errors = [];
    if (existsSync(errorDir)) {
      const { readdirSync, statSync } = await import("node:fs");
      const cutoff = Date.now() - timeWindow;
      for (const file of readdirSync(errorDir)) {
        const filePath = resolve(errorDir, file);
        const stat = statSync(filePath);
        if (stat.mtimeMs > cutoff) {
          try {
            const content = readFileSync(filePath, "utf8");
            errors.push({ file, content: content.slice(0, 2000), time: stat.mtimeMs });
          } catch { /* skip unreadable */ }
        }
      }
    }

    const analysis = {
      errorCount: errors.length,
      errors: errors.slice(0, 10),
      source,
      timeWindow,
      analyzedAt: Date.now(),
    };

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = analysis;
    }

    return { success: true, ...analysis };
  },
});

registerBuiltinNodeType("action.refresh_worktree", {
  describe: () => "Refresh git worktree state — fetch, pull, or reset to clean state",
  schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["fetch", "pull", "reset_hard", "clean", "checkout_main"], default: "fetch" },
      cwd: { type: "string", description: "Working directory" },
      branch: { type: "string", description: "Branch to operate on" },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before destructive refresh operations even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: ["operation"],
  },
  async execute(node, ctx, engine) {
    const op = node.config?.operation || "fetch";
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    const branch = ctx.resolve(node.config?.branch || "main");

    const commands = {
      fetch: "git fetch --all --prune",
      pull: `git pull origin ${branch} --rebase`,
      reset_hard: "git reset --hard HEAD && git clean -fd",
      clean: "git clean -fd",
      checkout_main: `git checkout ${branch} && git pull origin ${branch}`,
    };

    const cmd = commands[op];
    if (!cmd) throw new Error(`Unknown worktree operation: ${op}`);

    ctx.log(node.id, `Refreshing worktree (${op}): ${cmd}`);
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.refresh_worktree",
      repoRoot: cwd,
    });
    try {
      const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 120000, shell: true });
      return { success: true, output: output?.trim(), operation: op };
    } catch (err) {
      return { success: false, error: err.message, operation: op };
    }
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  MCP Tool Call — execute a tool on an installed MCP server
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

// Lazy-import MCP registry — cached at module scope per AGENTS.md rules.
let _mcpRegistry = null;
async function getMcpRegistry() {
  if (!_mcpRegistry) {
    _mcpRegistry = await import("./mcp-registry.mjs");
  }
  return _mcpRegistry;
}

/**
 * Spawn a stdio MCP server, send a JSON-RPC request, and collect the response.
 * Implements the MCP stdio transport: newline-delimited JSON-RPC over stdin/stdout.
 *
 * @param {Object} server — resolved MCP server config (command, args, env)
 * @param {string} method — JSON-RPC method (e.g. "tools/call", "tools/list")
 * @param {Object} params — JSON-RPC params
 * @param {number} timeoutMs — max wait time
 * @returns {Promise<Object>} — JSON-RPC result
 */
function mcpStdioRequest(server, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(server.env || {}) };
    const child = spawn(server.command, server.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
      timeout: timeoutMs + 5000,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const requestId = randomUUID();

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`MCP stdio request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      // Try to parse complete JSON-RPC responses (newline-delimited)
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          // Handle initialize response — send the actual tool call
          if (msg.id === `${requestId}-init` && msg.result) {
            // Send initialized notification
            const initialized = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
            child.stdin.write(initialized);
            // Now send the actual tool call
            const toolCall = JSON.stringify({
              jsonrpc: "2.0",
              id: requestId,
              method,
              params,
            }) + "\n";
            child.stdin.write(toolCall);
          }
          // Handle the actual tool call response
          if (msg.id === requestId && !settled) {
            settled = true;
            clearTimeout(timer);
            child.kill("SIGTERM");
            if (msg.error) {
              reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
            } else {
              resolve(msg.result);
            }
          }
        } catch {
          // Not valid JSON yet — partial line, keep accumulating
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`MCP stdio spawn error: ${err.message}`));
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`MCP server exited with code ${code}: ${stderr.slice(0, 500)}`));
        } else {
          reject(new Error("MCP server closed without responding"));
        }
      }
    });

    // Send initialize request first (MCP protocol handshake)
    const initRequest = JSON.stringify({
      jsonrpc: "2.0",
      id: `${requestId}-init`,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bosun-workflow", version: "1.0.0" },
      },
    }) + "\n";
    child.stdin.write(initRequest);
  });
}

/**
 * Send an HTTP JSON-RPC request to a URL-based MCP server.
 *
 * @param {string} url — MCP server URL
 * @param {string} method — JSON-RPC method
 * @param {Object} params — JSON-RPC params
 * @param {number} timeoutMs — max wait time
 * @returns {Promise<Object>} — JSON-RPC result
 */
async function mcpUrlRequest(url, method, params, timeoutMs = 30000) {
  const requestId = randomUUID();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`MCP URL request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// ==== Lazy-import MCP workflow adapter ====
let _mcpAdapter = null;
async function getMcpAdapter() {
  if (!_mcpAdapter) {
    _mcpAdapter = await import("./mcp-workflow-adapter.mjs");
  }
  return _mcpAdapter;
}

/**
 * Internal helper: execute a single MCP tool call and return structured output.
 * Shared by action.mcp_tool_call and action.mcp_pipeline.
 */
async function _executeMcpToolCall(serverId, toolName, input, timeoutMs, ctx) {
  const registry = await getMcpRegistry();
  const rootDir = ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
  const resolved = await registry.resolveMcpServersForAgent(rootDir, [serverId]);

  if (!resolved || !resolved.length) {
    return {
      success: false,
      error: `MCP server "${serverId}" not found. Install it first via the library.`,
      server: serverId,
      tool: toolName,
      data: null,
      text: "",
    };
  }

  const server = resolved[0];

  // Resolve any {{variable}} references in tool input
  const resolvedInput = {};
  for (const [key, value] of Object.entries(input || {})) {
    resolvedInput[key] = typeof value === "string" ? ctx.resolve(value) : value;
  }

  let result;
  if (server.transport === "url" && server.url) {
    result = await mcpUrlRequest(server.url, "tools/call", {
      name: toolName,
      arguments: resolvedInput,
    }, timeoutMs);
  } else if (server.command) {
    result = await mcpStdioRequest(server, "tools/call", {
      name: toolName,
      arguments: resolvedInput,
    }, timeoutMs);
  } else {
    throw new Error(`MCP server "${serverId}" has no command or url configured`);
  }

  // Parse MCP content blocks into structured data using the adapter
  const adapter = await getMcpAdapter();
  const parsed = adapter.parseMcpContent(result);

  return {
    success: !parsed.isError,
    server: serverId,
    tool: toolName,
    data: parsed.data,
    text: parsed.text,
    contentType: parsed.contentType,
    isError: parsed.isError,
    images: parsed.images,
    resources: parsed.resources,
    result: result?.content || result,
  };
}

registerBuiltinNodeType("action.mcp_tool_call", {
  describe: () =>
    "Call a tool on an installed MCP server with structured output extraction. " +
    "Supports field extraction, output mapping, type coercion, and port-based " +
    "routing — enabling MCP tools to be first-class workflow data sources.",
  schema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server ID from the library (e.g. 'github', 'filesystem', 'context7')",
      },
      tool: {
        type: "string",
        description: "Tool name to invoke on the MCP server",
      },
      input: {
        type: "object",
        description: "Tool input arguments (server-specific). Supports {{variable}} interpolation.",
        additionalProperties: true,
      },
      timeoutMs: {
        type: "number",
        default: 30000,
        description: "Timeout in ms for the MCP tool call",
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the full result in ctx.data",
      },
      extract: {
        type: "object",
        description:
          "Structured data extraction config. Extract specific fields from the " +
          "MCP tool output into a clean typed object for downstream piping.",
        properties: {
          root: {
            type: "string",
            description: "Root path to start extraction from (e.g. 'data' or 'data.items')",
          },
          fields: {
            type: "object",
            description:
              "Map of outputKey → sourcePath. Supports dot-paths ('items[0].title'), " +
              "JSON pointers ('/data/items/0'), and array wildcards ('items[*].name').",
            additionalProperties: { type: "string" },
          },
          defaults: {
            type: "object",
            description: "Default values for fields that are missing or null",
            additionalProperties: true,
          },
          types: {
            type: "object",
            description: "Type coercion map: fieldName → 'string'|'number'|'boolean'|'array'|'integer'|'json'",
            additionalProperties: { type: "string" },
          },
        },
      },
      outputMap: {
        type: "object",
        description:
          "Rename/reshape output fields for downstream nodes. " +
          "Map of newFieldName → sourcePath (string) or spec object with " +
          "_literal, _template, _from+_transform, _concat.",
        additionalProperties: true,
      },
      portConfig: {
        type: "object",
        description:
          "Configure output port routing based on tool result. " +
          "Enables conditional workflow branching.",
        properties: {
          field: { type: "string", description: "Field to use as port selector (default: 'success')" },
          map: {
            type: "object",
            description: "Map field values to port names (e.g. {'true': 'default', 'false': 'error'})",
            additionalProperties: { type: "string" },
          },
          default: { type: "string", description: "Default port name (default: 'default')" },
        },
      },
    },
    required: ["server", "tool"],
  },
  async execute(node, ctx, engine) {
    const serverId = ctx.resolve(node.config?.server || "");
    const toolName = ctx.resolve(node.config?.tool || "");
    const timeoutMs = node.config?.timeoutMs || 30000;

    if (!serverId) throw new Error("action.mcp_tool_call: 'server' is required");
    if (!toolName) throw new Error("action.mcp_tool_call: 'tool' is required");

    ctx.log(node.id, `MCP tool call: ${serverId}/${toolName}`);
    const mcpToolStartedAt = Date.now();
    const mcpToolLedgerRef = buildNodeExecutionLedgerRef(ctx, node, "tool", ["mcp", serverId, toolName], `${serverId}/${toolName}`);
    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
      eventType: "tool.started",
      ...mcpToolLedgerRef,
      toolId: toolName,
      toolName,
      serverId,
      status: "running",
      meta: { provider: "mcp", serverId },
    }));

    let rawOutput;
    try {
      rawOutput = await _executeMcpToolCall(serverId, toolName, node.config?.input, timeoutMs, ctx);
    } catch (err) {
      ctx.log(node.id, `MCP tool call failed: ${err.message}`);
      const failedResult = {
        success: false,
        error: err.message,
        server: serverId,
        tool: toolName,
        matchedPort: "error",
        port: "error",
      };
      recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
        eventType: "tool.failed",
        ...mcpToolLedgerRef,
        toolId: toolName,
        toolName,
        serverId,
        status: "failed",
        durationMs: Date.now() - mcpToolStartedAt,
        error: err.message,
        meta: { provider: "mcp", serverId },
      }));
      return failedResult;
    }

    if (!rawOutput.success) {
      ctx.log(node.id, `MCP tool returned error: ${rawOutput.error || "unknown"}`);
    } else {
      ctx.log(node.id, `MCP tool call completed (${rawOutput.contentType})`);
    }

    // ==== Structured data extraction ====
    const adapter = await getMcpAdapter();
    let extracted = rawOutput;

    if (node.config?.extract) {
      const sourceData = rawOutput.data ?? rawOutput;
      const extractedFields = adapter.extractMcpOutput(sourceData, node.config.extract);
      extracted = { ...rawOutput, extracted: extractedFields };
      // Also merge extracted fields to top-level for easy {{nodeId.fieldName}} access
      Object.assign(extracted, extractedFields);
      ctx.log(node.id, `Extracted ${Object.keys(extractedFields).length} field(s)`);
    }

    // ==== Output mapping ====
    if (node.config?.outputMap) {
      const mappedFields = adapter.mapOutputFields(extracted, node.config.outputMap, ctx);
      extracted = { ...extracted, mapped: mappedFields };
      // Merge mapped fields to top-level
      Object.assign(extracted, mappedFields);
      ctx.log(node.id, `Mapped ${Object.keys(mappedFields).length} field(s)`);
    }

    // ==== Port-based routing ====
    const port = adapter.resolveOutputPort(extracted, node.config?.portConfig);
    extracted.matchedPort = port;
    extracted.port = port;

    // Store in ctx.data if outputVariable is set
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = extracted;
    }

    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
      eventType: rawOutput.success ? "tool.completed" : "tool.failed",
      ...mcpToolLedgerRef,
      toolId: toolName,
      toolName,
      serverId,
      status: rawOutput.success ? "completed" : "failed",
      durationMs: Date.now() - mcpToolStartedAt,
      error: rawOutput.success ? null : (rawOutput.error || null),
      summary: rawOutput.text ? String(rawOutput.text).slice(0, 240) : null,
      meta: {
        provider: "mcp",
        serverId,
        contentType: rawOutput.contentType || null,
      },
    }));

    return extracted;
  },
});

registerBuiltinNodeType("action.mcp_list_tools", {
  describe: () =>
    "List available tools on an installed MCP server, including their input " +
    "schemas. Useful for dynamic tool discovery and auto-wiring in pipelines.",
  schema: {
    type: "object",
    properties: {
      server: {
        type: "string",
        description: "MCP server ID from the library",
      },
      timeoutMs: {
        type: "number",
        default: 30000,
        description: "Timeout in ms",
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the tool list in ctx.data",
      },
      includeSchemas: {
        type: "boolean",
        default: true,
        description: "Include input schemas for each tool (for auto-wiring)",
      },
    },
    required: ["server"],
  },
  async execute(node, ctx, engine) {
    const serverId = ctx.resolve(node.config?.server || "");
    const timeoutMs = node.config?.timeoutMs || 30000;

    if (!serverId) throw new Error("action.mcp_list_tools: 'server' is required");

    ctx.log(node.id, `Listing tools for MCP server: ${serverId}`);

    const registry = await getMcpRegistry();
    const rootDir = ctx.data?.worktreePath || ctx.data?.repoRoot || process.cwd();
    const resolved = await registry.resolveMcpServersForAgent(rootDir, [serverId]);

    if (!resolved || !resolved.length) {
      ctx.log(node.id, `MCP server "${serverId}" not found — skipping list-tools`);
      return { success: false, error: `MCP server "${serverId}" not found`, server: serverId, tools: [], toolNames: [] };
    }

    const server = resolved[0];
    let result;

    try {
      if (server.transport === "url" && server.url) {
        result = await mcpUrlRequest(server.url, "tools/list", {}, timeoutMs);
      } else if (server.command) {
        result = await mcpStdioRequest(server, "tools/list", {}, timeoutMs);
      } else {
        throw new Error(`MCP server "${serverId}" has no command or url`);
      }
    } catch (err) {
      ctx.log(node.id, `Failed to list tools: ${err.message}`);
      return { success: false, error: err.message, server: serverId, tools: [], toolNames: [] };
    }

    const tools = result?.tools || [];
    const toolNames = tools.map((t) => t.name);
    ctx.log(node.id, `Found ${tools.length} tool(s): ${toolNames.slice(0, 10).join(", ")}${tools.length > 10 ? "..." : ""}`);

    // Build tool catalog with schemas for auto-wiring
    const catalog = tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: node.config?.includeSchemas !== false ? (t.inputSchema || null) : null,
      // Extract required params for pipeline auto-wiring
      requiredParams: t.inputSchema?.required || [],
      paramNames: t.inputSchema?.properties ? Object.keys(t.inputSchema.properties) : [],
    }));

    const output = { success: true, server: serverId, tools: catalog, toolNames, toolCount: tools.length };
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }
    return output;
  },
});

// ==== action.mcp_pipeline — Chain multiple MCP tool calls with data piping ====

registerBuiltinNodeType("action.mcp_pipeline", {
  describe: () =>
    "Execute a chain of MCP tool calls in sequence, piping structured output " +
    "from each step to the next. Each step can extract specific fields from " +
    "the previous step's output and use them as input arguments for the next " +
    "tool call. Supports cross-server pipelines (e.g. GitHub → Slack).",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description:
          "Ordered list of MCP tool invocations. Each step receives the " +
          "previous step's output and can reference it via inputMap.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique step identifier" },
            server: { type: "string", description: "MCP server ID" },
            tool: { type: "string", description: "Tool name on that server" },
            input: {
              type: "object",
              description: "Static input arguments (supports {{variable}} templates)",
              additionalProperties: true,
            },
            inputMap: {
              type: "object",
              description:
                "Map previous step output → this step's input params. " +
                "Keys are input parameter names, values are paths into " +
                "the previous step's output (e.g. 'data.items[0].owner').",
              additionalProperties: true,
            },
            extract: {
              type: "object",
              description: "Field extraction config (same as action.mcp_tool_call extract)",
            },
            outputMap: {
              type: "object",
              description: "Rename/reshape this step's output before piping to next step",
              additionalProperties: true,
            },
            condition: {
              type: "string",
              description:
                "Expression that must be truthy to execute this step. " +
                "Use {{prev.fieldName}} to reference previous step output.",
            },
            continueOnError: {
              type: "boolean",
              default: false,
              description: "Continue pipeline execution even if this step fails",
            },
            timeoutMs: { type: "number", default: 30000 },
          },
          required: ["server", "tool"],
        },
      },
      outputVariable: {
        type: "string",
        description: "Variable name to store the final pipeline result in ctx.data",
      },
      stopOnFirstError: {
        type: "boolean",
        default: true,
        description: "Stop pipeline execution on first step failure",
      },
    },
    required: ["steps"],
  },
  async execute(node, ctx, engine) {
    const adapter = await getMcpAdapter();
    const pipelineSpec = adapter.createPipelineSpec(node.config?.steps || []);

    if (!pipelineSpec.valid) {
      const errorMsg = `Pipeline validation failed: ${pipelineSpec.errors.join("; ")}`;
      ctx.log(node.id, errorMsg, "error");
      return { success: false, error: errorMsg, steps: [], stepCount: 0 };
    }

    const stopOnFirstError = node.config?.stopOnFirstError !== false;
    const steps = pipelineSpec.steps;
    const stepResults = [];
    let prevOutput = {};   // Output from previous step — available for piping
    let allSuccess = true;

    ctx.log(node.id, `Executing MCP pipeline: ${steps.length} step(s)`);

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepTag = `[${step.id}] ${step.server}/${step.tool}`;

      // ==== Condition check ====
      if (step.condition) {
        // Inject previous output into context for condition evaluation
        const condCtx = { ...ctx.data, prev: prevOutput };
        const condValue = ctx.resolve(step.condition);
        // Evaluate simple truthy check
        if (!condValue || condValue === "false" || condValue === "0" || condValue === step.condition) {
          ctx.log(node.id, `${stepTag}: condition not met, skipping`);
          stepResults.push({
            id: step.id,
            server: step.server,
            tool: step.tool,
            success: true,
            skipped: true,
            reason: "condition_not_met",
          });
          continue;
        }
      }

      // ==== Build input from pipeline wiring ====
      let stepInput = {};

      // Start with static input (supports {{variable}} templates)
      if (step.input && typeof step.input === "object") {
        for (const [key, value] of Object.entries(step.input)) {
          stepInput[key] = typeof value === "string" ? ctx.resolve(value) : value;
        }
      }

      // Overlay piped input from previous step
      if (step.inputMap && typeof step.inputMap === "object") {
        const pipedInput = adapter.buildPipelineInput(prevOutput, step.inputMap, ctx);
        Object.assign(stepInput, pipedInput);
      }

      // ==== Execute tool call ====
      ctx.log(node.id, `${stepTag}: executing (step ${i + 1}/${steps.length})`);
      let stepOutput;

      try {
        stepOutput = await _executeMcpToolCall(
          ctx.resolve(step.server),
          ctx.resolve(step.tool),
          stepInput,
          step.timeoutMs,
          ctx,
        );
      } catch (err) {
        ctx.log(node.id, `${stepTag}: failed — ${err.message}`, "error");
        stepOutput = {
          success: false,
          error: err.message,
          server: step.server,
          tool: step.tool,
        };
      }

      // ==== Extract structured fields ====
      if (step.extract && stepOutput.success) {
        const sourceData = stepOutput.data ?? stepOutput;
        const extractedFields = adapter.extractMcpOutput(sourceData, step.extract);
        stepOutput = { ...stepOutput, extracted: extractedFields };
        Object.assign(stepOutput, extractedFields);
      }

      // ==== Output mapping ====
      if (step.outputMap && stepOutput.success) {
        const mappedFields = adapter.mapOutputFields(stepOutput, step.outputMap, ctx);
        stepOutput = { ...stepOutput, mapped: mappedFields };
        Object.assign(stepOutput, mappedFields);
      }

      // Store step output in context for template resolution
      ctx.data[`_mcp_pipeline_${step.id}`] = stepOutput;
      prevOutput = stepOutput;

      stepResults.push({
        id: step.id,
        server: step.server,
        tool: step.tool,
        success: stepOutput.success,
        skipped: false,
        output: stepOutput,
      });

      if (!stepOutput.success) {
        allSuccess = false;
        ctx.log(node.id, `${stepTag}: step failed`, "warn");
        if (stopOnFirstError && !step.continueOnError) {
          ctx.log(node.id, `Pipeline halted at step ${step.id}`, "error");
          break;
        }
      } else {
        ctx.log(node.id, `${stepTag}: completed`);
      }
    }

    const completedSteps = stepResults.filter((s) => !s.skipped && s.success).length;
    const failedSteps = stepResults.filter((s) => !s.skipped && !s.success).length;
    const skippedSteps = stepResults.filter((s) => s.skipped).length;

    ctx.log(
      node.id,
      `Pipeline done: ${completedSteps} succeeded, ${failedSteps} failed, ${skippedSteps} skipped`,
    );

    const output = {
      success: allSuccess,
      stepCount: steps.length,
      completedSteps,
      failedSteps,
      skippedSteps,
      steps: stepResults,
      // Final step's output is piped as the pipeline's top-level output
      finalOutput: prevOutput,
      // Promote final step's data fields to top-level for easy {{nodeId.field}} access
      ...(prevOutput?.data && typeof prevOutput.data === "object" ? prevOutput.data : {}),
      matchedPort: allSuccess ? "default" : "error",
      port: allSuccess ? "default" : "error",
    };

    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = output;
    }

    return output;
  },
});

// ==== transform.mcp_extract — Extract structured data from any MCP output ====

registerBuiltinNodeType("transform.mcp_extract", {
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
  async execute(node, ctx, engine) {
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

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
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
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

/** Module-scope lazy caches for task lifecycle imports. */
let _taskClaimsMod = null;
const _taskClaimsInitPromises = new Map();
let _taskComplexityMod = null;
let _kanbanAdapterMod = null;
let _agentPoolMod = null;
let _libraryManagerMod = null;
let _configMod = null;
let _gitSafetyMod = null;
let _diffStatsMod = null;
let _sharedStateManagerMod = null;
const SHARED_STATE_ACTIVE_STALE_THRESHOLD_MS =
  Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000;
const TERMINAL_SHARED_STATE_STATUSES = new Set([
  "complete",
  "completed",
  "failed",
  "abandoned",
  "released",
]);

async function ensureTaskClaimsMod() {
  if (!_taskClaimsMod) _taskClaimsMod = await import("../task/task-claims.mjs");
  return _taskClaimsMod;
}
async function ensureSharedStateManagerMod() {
  if (!_sharedStateManagerMod) {
    _sharedStateManagerMod = await import("../workspace/shared-state-manager.mjs");
  }
  return _sharedStateManagerMod;
}
function pickTaskString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}
function deriveTaskBranch(task = {}) {
  const explicit = pickTaskString(
    task?.branch,
    task?.branchName,
    task?.meta?.branch,
    task?.metadata?.branch,
  );
  if (explicit) return explicit;
  const taskId = pickTaskString(task?.id, task?.task_id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const titleSlug = pickTaskString(task?.title, "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = titleSlug || "task";
  if (taskId) return `task/${taskId}-${suffix}`;
  return `task/${suffix}`;
}
function looksLikeFilesystemPath(value) {
  const text = String(value || "").trim();
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\");
}
function resolveTaskRepositoryRoot(taskRepository, currentRepoRoot, workspaceHint = "") {
  const repository = String(taskRepository || "").trim();
  const repoRoot = String(currentRepoRoot || "").trim();
  const workspaceId = String(workspaceHint || "").trim();
  if (!repoRoot) return "";
  const portableRoot = resolve(repoRoot).replace(/\\/g, "/");
  const marker = "/.bosun/workspaces/";
  const markerIndex = portableRoot.toLowerCase().indexOf(marker);
  if (!repository) {
    return markerIndex >= 0 ? portableRoot.slice(0, markerIndex) : resolve(repoRoot);
  }
  const repoName = repository.split("/").pop();
  if (!repoName) return markerIndex >= 0 ? portableRoot.slice(0, markerIndex) : resolve(repoRoot);
  const candidates = [];

  if (markerIndex >= 0) {
    const actualRepoRoot = portableRoot.slice(0, markerIndex);
    const remainder = portableRoot.slice(markerIndex + marker.length).split("/").filter(Boolean);
    const currentRepoName = String(remainder[1] || "").trim();
    const workspaceRoot = resolve(actualRepoRoot, "..");
    if (currentRepoName && currentRepoName.toLowerCase() === repoName.toLowerCase()) {
      candidates.push(actualRepoRoot);
    }
    candidates.push(resolve(workspaceRoot, repoName));
  }

  candidates.push(
    resolve(repoRoot, "..", repoName),
    resolve(repoRoot, ".bosun", "workspaces", workspaceId || String(process.env.BOSUN_WORKSPACE || "").trim(), repoName),
  );

  for (const candidate of candidates) {
    if (!candidate || candidate.includes("workspaces/")) {
      // keep candidate even when BOSUN_WORKSPACE is empty; resolve() will normalize it.
    }
    try {
      if (hasGitMetadata(candidate) || isUsableGitRepoRoot(candidate)) return candidate;
    } catch {
      // ignore invalid candidate
    }
  }
  return "";
}
function sameResolvedPath(leftPath, rightPath) {
  const left = resolve(String(leftPath || ""));
  const right = resolve(String(rightPath || ""));
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
async function ensureTaskClaimsInitialized(ctx, claims, explicitRepoRoot = "") {
  if (typeof claims?.initTaskClaims !== "function") return;
  const requestedRepoRoot = pickTaskString(
    explicitRepoRoot,
    ctx?.data?.repoRoot,
    resolveConfiguredRepoRoot({ cwd: process.cwd() }),
    process.cwd(),
  );
  const repoRoot =
    resolveTaskRepositoryRoot("", requestedRepoRoot)
    || requestedRepoRoot
    || process.cwd();
  const repoKey = resolve(repoRoot);
  const initFn = claims.initTaskClaims;
  const cachedEntry = _taskClaimsInitPromises.get(repoKey);
  let initPromise = cachedEntry?.initFn === initFn ? cachedEntry.promise : null;
  if (!initPromise) {
    initPromise = initFn({ repoRoot }).catch((err) => {
      _taskClaimsInitPromises.delete(repoKey);
      throw err;
    });
    _taskClaimsInitPromises.set(repoKey, { initFn, promise: initPromise });
  }
  await initPromise;
}
function isSharedStateOwnershipActive(state, now = Date.now()) {
  if (!state || typeof state !== "object") return false;
  const ownerId = pickTaskString(state.ownerId, state.owner_id);
  if (!ownerId) return false;
  const attemptStatus = pickTaskString(state.attemptStatus, state.attempt_status).toLowerCase();
  if (attemptStatus && TERMINAL_SHARED_STATE_STATUSES.has(attemptStatus)) return false;
  const heartbeatText = pickTaskString(state.ownerHeartbeat, state.owner_heartbeat);
  const heartbeatMs = Date.parse(heartbeatText);
  if (!Number.isFinite(heartbeatMs)) return false;
  if (now - heartbeatMs > SHARED_STATE_ACTIVE_STALE_THRESHOLD_MS) return false;
  return true;
}
async function getPersistedOwnedTaskIds(node, ctx) {
  const requestedRepoRoot = pickTaskString(
    cfgOrCtx(node, ctx, "repoRoot"),
    ctx?.data?.repoRoot,
    resolveConfiguredRepoRoot({ cwd: process.cwd() }),
    process.cwd(),
  );
  const repoRoot =
    resolveTaskRepositoryRoot("", requestedRepoRoot)
    || requestedRepoRoot
    || process.cwd();
  const activeTaskIds = new Set();
  try {
    const claims = await ensureTaskClaimsMod();
    await ensureTaskClaimsInitialized(ctx, claims, repoRoot);
    if (typeof claims.listClaims === "function") {
      const persistedClaims = await claims.listClaims();
      for (const claim of persistedClaims || []) {
        const taskId = pickTaskString(claim?.task_id, claim?.taskId);
        if (taskId) activeTaskIds.add(taskId);
      }
    }
  } catch (err) {
    ctx?.log?.(node.id, `Persisted claim filter warning: ${err?.message || err}`);
  }
  try {
    const sharedStateManager = await ensureSharedStateManagerMod();
    if (typeof sharedStateManager.getAllSharedStates === "function") {
      const sharedStates = await sharedStateManager.getAllSharedStates(repoRoot);
      const now = Date.now();
      for (const [rawTaskId, state] of Object.entries(sharedStates || {})) {
        const taskId = pickTaskString(state?.taskId, state?.task_id, rawTaskId);
        if (!taskId) continue;
        if (isSharedStateOwnershipActive(state, now)) {
          activeTaskIds.add(taskId);
        }
      }
    }
  } catch (err) {
    ctx?.log?.(node.id, `Shared state filter warning: ${err?.message || err}`);
  }
  return activeTaskIds;
}
async function ensureTaskComplexityMod() {
  if (!_taskComplexityMod) _taskComplexityMod = await import("../task/task-complexity.mjs");
  return _taskComplexityMod;
}
async function ensureConfigMod() {
  if (!_configMod) _configMod = await import("../config/config.mjs");
  return _configMod;
}
async function ensureLibraryManagerMod() {
  if (!_libraryManagerMod) _libraryManagerMod = await import("../infra/library-manager.mjs");
  return _libraryManagerMod;
}
async function ensureKanbanAdapterMod() {
  if (!_kanbanAdapterMod) _kanbanAdapterMod = await import("../kanban/kanban-adapter.mjs");
  return _kanbanAdapterMod;
}
async function ensureAgentPoolMod() {
  if (!_agentPoolMod) _agentPoolMod = await import("../agent/agent-pool.mjs");
  return _agentPoolMod;
}
async function ensureGitSafetyMod() {
  if (!_gitSafetyMod) _gitSafetyMod = await import("../git/git-safety.mjs");
  return _gitSafetyMod;
}
async function ensureDiffStatsMod() {
  if (!_diffStatsMod) _diffStatsMod = await import("../git/diff-stats.mjs");
  return _diffStatsMod;
}
function normalizeWorkflowSdkKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "";
  if (raw.includes("copilot")) return "copilot";
  if (raw.includes("codex") || raw.includes("gpt")) return "codex";
  if (raw.includes("claude")) return "claude";
  if (raw.includes("gemini")) return "gemini";
  if (raw.includes("opencode")) return "opencode";
  return raw;
}
function sdkToComplexityExecutorType(sdk) {
  if (sdk === "copilot") return "COPILOT";
  if (sdk === "codex") return "CODEX";
  return "";
}
function buildWorkflowBaseExecutorProfile(sdk, defaults = {}) {
  const executor = sdkToComplexityExecutorType(sdk);
  if (!executor) return null;
  return {
    name: defaults.name || sdk,
    executor,
    variant: defaults.variant || "DEFAULT",
    role: defaults.role || "primary",
    weight: Number.isFinite(Number(defaults.weight)) ? Number(defaults.weight) : 100,
    enabled: defaults.enabled !== false,
    codexProfile: defaults.codexProfile || "",
  };
}
function resolveWorkflowExecutorPreference(config, defaultSdk) {
  const defaultSdkKey = normalizeWorkflowSdkKey(defaultSdk);
  if (defaultSdkKey) {
    return {
      sdk: defaultSdkKey,
      model: "",
      baseProfile: buildWorkflowBaseExecutorProfile(defaultSdkKey, {
        name: `default-${defaultSdkKey}`,
      }),
    };
  }

  const configuredExecutors = Array.isArray(config?.executorConfig?.executors)
    ? config.executorConfig.executors.filter((entry) => entry?.enabled !== false)
    : [];
  const primaryExecutor = configuredExecutors[0] || null;
  if (primaryExecutor?.executor) {
    const configuredSdk = normalizeWorkflowSdkKey(primaryExecutor.executor);
    if (configuredSdk) {
      return {
        sdk: configuredSdk,
        model: Array.isArray(primaryExecutor.models)
          ? String(primaryExecutor.models[0] || "").trim()
          : "",
        baseProfile: buildWorkflowBaseExecutorProfile(configuredSdk, {
          name: primaryExecutor.name || configuredSdk,
          variant: primaryExecutor.variant || "DEFAULT",
          role: primaryExecutor.role || "primary",
          weight: primaryExecutor.weight,
          enabled: primaryExecutor.enabled !== false,
          codexProfile: primaryExecutor.codexProfile || "",
        }),
      };
    }
  }

  const internalSdk = normalizeWorkflowSdkKey(config?.internalExecutor?.sdk);
  if (internalSdk) {
    return {
      sdk: internalSdk,
      model: "",
      baseProfile: buildWorkflowBaseExecutorProfile(internalSdk, {
        name: `internal-${internalSdk}`,
      }),
    };
  }

  const primaryAgentSdk = normalizeWorkflowSdkKey(config?.primaryAgent);
  if (primaryAgentSdk) {
    return {
      sdk: primaryAgentSdk,
      model: "",
      baseProfile: buildWorkflowBaseExecutorProfile(primaryAgentSdk, {
        name: `primary-${primaryAgentSdk}`,
      }),
    };
  }

  return null;
}
let _taskStoreMod = null;
async function ensureTaskStoreMod() {
  if (!_taskStoreMod) _taskStoreMod = await import("../task/task-store.mjs");
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

function getDelegationAuditTrail(ctx) {
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!Array.isArray(runtimeState.delegationAuditTrail)) {
    runtimeState.delegationAuditTrail = Array.isArray(ctx?.data?._delegationAuditTrail)
      ? [...ctx.data._delegationAuditTrail]
      : [];
  }
  if (ctx?.data && !Array.isArray(ctx.data._delegationAuditTrail)) {
    ctx.data._delegationAuditTrail = runtimeState.delegationAuditTrail;
  }
  return runtimeState.delegationAuditTrail;
}

function appendDelegationAuditEvent(ctx, event) {
  if (!ctx || !event || typeof event !== "object") return;
  const trail = getDelegationAuditTrail(ctx);
  const normalized = {
    at: new Date().toISOString(),
    ...event,
  };
  const dedupeKey = `${normalized.type || "event"}:${normalized.taskId || ""}:${normalized.claimToken || ""}:${normalized.instanceId || ""}`;
  if (normalized.type === "owner-mismatch") {
    const exists = trail.some((entry) => {
      const entryKey = `${entry?.type || "event"}:${entry?.taskId || ""}:${entry?.claimToken || ""}:${entry?.instanceId || ""}`;
      return entryKey === dedupeKey;
    });
    if (exists) return;
  }
  trail.push(normalized);
  if (ctx?.data) { ctx.data._delegationAuditTrail = trail; ctx.data._workflowDelegationTrail = trail; }
}

function buildDelegationTransitionKey(type, parts = []) {
  return [type, ...parts]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(":");
}

function recordDelegationAuditEvent(ctx, event = {}) {
  const result = typeof ctx?.recordDelegationEvent === "function"
    ? ctx.recordDelegationEvent(event)
    : null;
  if (!result) {
    appendDelegationAuditEvent(ctx, {
      ...event,
      transitionKey: event?.transitionKey || event?.idempotencyKey,
      idempotencyKey: event?.idempotencyKey || event?.transitionKey,
    });
  }
  return result;
}

function cloneWorkflowTeamValue(value) {
  if (value == null) return value;
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function getWorkflowTeamState(ctx) {
  if (typeof ctx?.getWorkflowTeamState === "function") {
    return ctx.getWorkflowTeamState();
  }
  return cloneWorkflowTeamValue(ctx?.data?._workflowTeamState || ctx?.data?.workflowTeamState || {
    version: 1,
    teamId: null,
    name: null,
    leadId: null,
    defaultChannel: "team",
    initializedAt: null,
    updatedAt: null,
    roster: [],
    channels: [],
    tasks: [],
    messages: [],
    events: [],
  });
}

function setWorkflowTeamState(ctx, state) {
  if (typeof ctx?.setWorkflowTeamState === "function") {
    return ctx.setWorkflowTeamState(state);
  }
  if (!ctx?.data || typeof ctx.data !== "object") ctx.data = {};
  ctx.data._workflowTeamState = cloneWorkflowTeamValue(state);
  ctx.data.workflowTeamState = cloneWorkflowTeamValue(state);
  return cloneWorkflowTeamValue(state);
}

function updateWorkflowTeamState(ctx, updater) {
  const current = getWorkflowTeamState(ctx);
  const next = typeof updater === "function"
    ? updater(cloneWorkflowTeamValue(current))
    : { ...current, ...(updater || {}) };
  return setWorkflowTeamState(ctx, next || current);
}

function normalizeTeamId(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeTeamList(value) {
  const items = Array.isArray(value) ? value : [value];
  return Array.from(new Set(
    items
      .map((entry) => normalizeTeamId(entry))
      .filter(Boolean),
  ));
}

function ensureTeamMember(state, memberLike = {}) {
  const memberId = normalizeTeamId(
    memberLike.memberId ||
    memberLike.id ||
    memberLike.agentId ||
    memberLike.name,
  );
  if (!memberId) return null;
  state.roster = Array.isArray(state.roster) ? state.roster : [];
  let member = state.roster.find((entry) => entry.memberId === memberId);
  if (!member) {
    member = {
      memberId,
      name: normalizeTeamId(memberLike.name) || memberId,
      role: normalizeTeamId(memberLike.role) || null,
      reportsTo: normalizeTeamId(memberLike.reportsTo) || null,
      level: Number.isFinite(Number(memberLike.level)) ? Number(memberLike.level) : null,
      channels: normalizeTeamList(memberLike.channels),
      tags: normalizeTeamList(memberLike.tags),
      skills: normalizeTeamList(memberLike.skills),
      metadata:
        memberLike.metadata && typeof memberLike.metadata === "object" && !Array.isArray(memberLike.metadata)
          ? cloneWorkflowTeamValue(memberLike.metadata)
          : {},
      joinedAt: memberLike.joinedAt || new Date().toISOString(),
      active: memberLike.active !== false,
    };
    state.roster.push(member);
    return member;
  }
  member.name = normalizeTeamId(memberLike.name) || member.name || memberId;
  member.role = normalizeTeamId(memberLike.role) || member.role || null;
  member.reportsTo = normalizeTeamId(memberLike.reportsTo) || member.reportsTo || null;
  if (Number.isFinite(Number(memberLike.level))) member.level = Number(memberLike.level);
  member.channels = Array.from(new Set([
    ...normalizeTeamList(member.channels),
    ...normalizeTeamList(memberLike.channels),
  ]));
  member.tags = Array.from(new Set([
    ...normalizeTeamList(member.tags),
    ...normalizeTeamList(memberLike.tags),
  ]));
  member.skills = Array.from(new Set([
    ...normalizeTeamList(member.skills),
    ...normalizeTeamList(memberLike.skills),
  ]));
  if (memberLike.metadata && typeof memberLike.metadata === "object" && !Array.isArray(memberLike.metadata)) {
    member.metadata = { ...(member.metadata || {}), ...cloneWorkflowTeamValue(memberLike.metadata) };
  }
  if (memberLike.active != null) member.active = memberLike.active !== false;
  return member;
}

function ensureTeamChannel(state, channelLike = {}) {
  const channelId = normalizeTeamId(channelLike.channelId || channelLike.id || channelLike.name);
  if (!channelId) return null;
  state.channels = Array.isArray(state.channels) ? state.channels : [];
  let channel = state.channels.find((entry) => entry.channelId === channelId);
  if (!channel) {
    channel = {
      channelId,
      name: normalizeTeamId(channelLike.name) || channelId,
      kind: normalizeTeamId(channelLike.kind) || "channel",
      members: normalizeTeamList(channelLike.members),
      topic: typeof channelLike.topic === "string" && channelLike.topic.trim() ? channelLike.topic.trim() : null,
      metadata:
        channelLike.metadata && typeof channelLike.metadata === "object" && !Array.isArray(channelLike.metadata)
          ? cloneWorkflowTeamValue(channelLike.metadata)
          : {},
      createdAt: channelLike.createdAt || new Date().toISOString(),
    };
    state.channels.push(channel);
    return channel;
  }
  channel.name = normalizeTeamId(channelLike.name) || channel.name || channelId;
  channel.kind = normalizeTeamId(channelLike.kind) || channel.kind || "channel";
  channel.members = Array.from(new Set([
    ...normalizeTeamList(channel.members),
    ...normalizeTeamList(channelLike.members),
  ]));
  if (typeof channelLike.topic === "string" && channelLike.topic.trim()) {
    channel.topic = channelLike.topic.trim();
  }
  if (channelLike.metadata && typeof channelLike.metadata === "object" && !Array.isArray(channelLike.metadata)) {
    channel.metadata = { ...(channel.metadata || {}), ...cloneWorkflowTeamValue(channelLike.metadata) };
  }
  return channel;
}

function appendWorkflowTeamEvent(state, type, payload = {}) {
  state.events = Array.isArray(state.events) ? state.events : [];
  const event = {
    eventId: randomUUID(),
    type,
    at: new Date().toISOString(),
    ...cloneWorkflowTeamValue(payload),
  };
  state.events.push(event);
  return event;
}

function resolveTeamActorId(node, ctx, preferredKey = "memberId") {
  return normalizeTeamId(
    cfgOrCtx(node, ctx, preferredKey) ||
    cfgOrCtx(node, ctx, "actorId") ||
    ctx?.data?.agentId ||
    ctx?.data?.agentProfile ||
    ctx?.data?.task?.assignee ||
    ctx?.data?.leadId ||
    ctx?.data?._workflowTeamLeadId,
  );
}

function memberCanSeeChannel(state, memberId, channelId) {
  if (!memberId || !channelId) return false;
  const channel = Array.isArray(state.channels)
    ? state.channels.find((entry) => entry.channelId === channelId)
    : null;
  if (!channel) return true;
  const members = normalizeTeamList(channel.members);
  if (members.length === 0) return true;
  return members.includes(memberId);
}

function matchesTeamTask(task, match = {}) {
  if (!task || typeof task !== "object") return false;
  const normalizedMatch =
    match && typeof match === "object" && !Array.isArray(match)
      ? match
      : {};
  const titleContains = String(normalizedMatch.titleContains || "").trim().toLowerCase();
  if (titleContains && !String(task.title || "").toLowerCase().includes(titleContains)) return false;
  const requiredStatus = normalizeTeamId(normalizedMatch.status);
  if (requiredStatus && String(task.status || "").trim().toLowerCase() !== requiredStatus.toLowerCase()) return false;
  const requiredTag = normalizeTeamId(normalizedMatch.tag);
  if (requiredTag && !normalizeTeamList(task.tags).includes(requiredTag)) return false;
  const requiredLabel = normalizeTeamId(normalizedMatch.label);
  if (requiredLabel && !normalizeTeamList(task.labels).includes(requiredLabel)) return false;
  const requiredChannel = normalizeTeamId(normalizedMatch.channelId);
  if (requiredChannel && normalizeTeamId(task.channelId) !== requiredChannel) return false;
  return true;
}

function summarizeWorkflowTeamState(state) {
  const roster = Array.isArray(state?.roster) ? state.roster : [];
  const channels = Array.isArray(state?.channels) ? state.channels : [];
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  const events = Array.isArray(state?.events) ? state.events : [];
  return {
    teamId: normalizeTeamId(state?.teamId),
    name: normalizeTeamId(state?.name),
    leadId: normalizeTeamId(state?.leadId),
    defaultChannel: normalizeTeamId(state?.defaultChannel) || "team",
    rosterCount: roster.length,
    channelCount: channels.length,
    taskCount: tasks.length,
    openTaskCount: tasks.filter((task) => task.status === "open" || task.status === "released").length,
    claimedTaskCount: tasks.filter((task) => task.status === "claimed").length,
    completedTaskCount: tasks.filter((task) => task.status === "completed").length,
    messageCount: messages.length,
    eventCount: events.length,
    lastUpdatedAt: state?.updatedAt || state?.initializedAt || null,
  };
}

function getDelegationTransitionStore(ctx) {
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!runtimeState.delegationTransitionResults || typeof runtimeState.delegationTransitionResults !== "object") {
    runtimeState.delegationTransitionResults = {};
  }
  return runtimeState.delegationTransitionResults;
}

const delegationTransitionResultCache = new Map();

function getExistingDelegationTransition(ctx, transitionKey) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  return getDelegationTransitionStore(ctx)[key] || delegationTransitionResultCache.get(key) || null;
}

function setDelegationTransitionResult(ctx, transitionKey, value) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  getDelegationTransitionStore(ctx)[key] = value;
  delegationTransitionResultCache.set(key, value);
  return value;
}

function getClaimTransitionState(ctx, taskId, idempotencyKey) {
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!runtimeState.claimTransitions || typeof runtimeState.claimTransitions !== "object") {
    runtimeState.claimTransitions = Object.create(null);
  }
  const normalizedTaskId = String(taskId || "").trim();
  const normalizedKey = String(idempotencyKey || normalizedTaskId).trim();
  const bucketKey = `${normalizedTaskId}::${normalizedKey}`;
  if (!runtimeState.claimTransitions[bucketKey]) {
    runtimeState.claimTransitions[bucketKey] = { taskId: normalizedTaskId, idempotencyKey: normalizedKey };
  }
  return runtimeState.claimTransitions[bucketKey];
}

function getReleaseTransitionState(ctx, kind, taskId) {
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!runtimeState.releaseTransitions || typeof runtimeState.releaseTransitions !== "object") {
    runtimeState.releaseTransitions = Object.create(null);
  }
  const key = `${String(kind || "release").trim()}:${String(taskId || "").trim()}`;
  if (!runtimeState.releaseTransitions[key]) {
    runtimeState.releaseTransitions[key] = { kind, taskId: String(taskId || "").trim() };
  }
  return runtimeState.releaseTransitions[key];
}

function getDelegationGuardStore(ctx) {
  if (!ctx?.data || typeof ctx.data !== "object") return {};
  if (!ctx.data._delegationTransitionGuards || typeof ctx.data._delegationTransitionGuards !== "object") {
    ctx.data._delegationTransitionGuards = {};
  }
  return ctx.data._delegationTransitionGuards;
}

function beginDelegationTransition(ctx, key, meta = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return { shouldRun: true, key: null, entry: null };
  const guards = getDelegationGuardStore(ctx);
  const existing = guards[normalizedKey];
  if (existing?.status === "completed") {
    return { shouldRun: false, key: normalizedKey, entry: existing, completed: true };
  }
  if (existing?.status === "in_progress") {
    return { shouldRun: false, key: normalizedKey, entry: existing, inProgress: true };
  }
  const next = {
    key: normalizedKey,
    status: "in_progress",
    startedAt: new Date().toISOString(),
    ...meta,
  };
  guards[normalizedKey] = next;
  return { shouldRun: true, key: normalizedKey, entry: next };
}

function completeDelegationTransition(ctx, key, meta = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  const guards = getDelegationGuardStore(ctx);
  const next = {
    ...(guards[normalizedKey] || {}),
    ...meta,
    key: normalizedKey,
    status: "completed",
    completedAt: new Date().toISOString(),
  };
  guards[normalizedKey] = next;
  return next;
}

function failDelegationTransition(ctx, key, meta = {}) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return null;
  const guards = getDelegationGuardStore(ctx);
  const next = {
    ...(guards[normalizedKey] || {}),
    ...meta,
    key: normalizedKey,
    status: "failed",
    failedAt: new Date().toISOString(),
  };
  guards[normalizedKey] = next;
  return next;
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

function isMissingRegisteredWorktreeError(err) {
  const detail = formatExecSyncError(err).toLowerCase();
  return detail.includes("missing but already registered worktree");
}

function findExistingWorktreePathForBranch(repoRoot, branch) {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) return "";
  try {
    const raw = execGitArgsSync(["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      timeout: 10000,
    });
    const entries = String(raw || "").split(/\r?\n\r?\n/).map((chunk) => chunk.trim()).filter(Boolean);
    for (const entry of entries) {
      let worktreePath = "";
      let branchRef = "";
      for (const line of entry.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length).trim();
        if (line.startsWith("branch ")) branchRef = line.slice("branch ".length).trim();
      }
      if (!worktreePath || !branchRef) continue;
      const shortRef = branchRef.replace(/^refs\/heads\//, "");
      if (shortRef === normalizedBranch || branchRef === normalizedBranch) {
        return worktreePath;
      }
    }
  } catch {
    // Best-effort lookup only.
  }
  return "";
}

function localBranchExists(repoRoot, branch) {
  const normalizedBranch = String(branch || "").trim().replace(/^refs\/heads\//, "");
  if (!normalizedBranch) return false;
  try {
    execGitArgsSync(["show-ref", "--verify", "--quiet", `refs/heads/${normalizedBranch}`], {
      cwd: repoRoot,
      timeout: 5000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function isValidGitWorktreePath(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return false;
  try {
    const inside = execGitArgsSync(["rev-parse", "--is-inside-work-tree"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().toLowerCase();
    if (inside !== "true") return false;
    // A nested folder inside the main repo also returns inside-work-tree=true.
    // Reuse is safe only when the path itself is the git top-level root.
    const topLevel = execGitArgsSync(["rev-parse", "--show-toplevel"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const normalize = (value) =>
      resolve(String(value || ""))
        .replace(/\\/g, "/")
        .replace(/\/+$/, "");
    return normalize(topLevel) === normalize(worktreePath);
  } catch {
    return false;
  }
}

function resolveGitDirForWorktree(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return "";
  try {
    const topLevel = execGitArgsSync(["rev-parse", "--show-toplevel"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const normalize = (value) =>
      resolve(String(value || ""))
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .toLowerCase();
    if (normalize(topLevel) !== normalize(worktreePath)) return "";
    const gitDir = execGitArgsSync(["rev-parse", "--git-dir"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!gitDir) return "";
    return resolve(worktreePath, gitDir);
  } catch {
    return "";
  }
}

function hasUnresolvedGitOperation(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return false;
  try {
    const gitDir = resolveGitDirForWorktree(worktreePath);
    if (!gitDir || !existsSync(gitDir)) return true;
    for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (existsSync(resolve(gitDir, marker))) return true;
    }
    const unmerged = execGitArgsSync(["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return Boolean(unmerged);
  } catch {
    return true;
  }
}

function listUnmergedFiles(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return [];
  try {
    const raw = execGitArgsSync(["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return raw
      ? raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function hasGitStateMarker(worktreePath, markerName) {
  if (!worktreePath || !markerName) return false;
  try {
    const gitDir = resolveGitDirForWorktree(worktreePath);
    return Boolean(gitDir && existsSync(resolve(gitDir, markerName)));
  } catch {
    return false;
  }
}

function finalizeMergeCommitIfReady(worktreePath) {
  if (!hasGitStateMarker(worktreePath, "MERGE_HEAD")) {
    return { finalized: false, mergeInProgress: false, remainingConflicts: listUnmergedFiles(worktreePath) };
  }

  const remainingConflicts = listUnmergedFiles(worktreePath);
  if (remainingConflicts.length > 0) {
    return { finalized: false, mergeInProgress: true, remainingConflicts };
  }

  try {
    execGitArgsSync(["commit", "--no-edit"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { finalized: true, mergeInProgress: false, remainingConflicts: [] };
  } catch (error) {
    return {
      finalized: false,
      mergeInProgress: hasGitStateMarker(worktreePath, "MERGE_HEAD"),
      remainingConflicts: listUnmergedFiles(worktreePath),
      error: formatExecSyncError(error),
    };
  }
}

function abortMergeOperation(worktreePath) {
  try {
    execGitArgsSync(["merge", "--abort"], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // best effort
  }
}

async function resolvePushMergeConflictWithAgent({
  node,
  ctx,
  engine,
  worktreePath,
  baseBranch,
  conflictFiles,
  sdk,
  promptTemplate,
}) {
  const runAgentNodeType = getNodeType("action.run_agent");
  if (!runAgentNodeType?.execute) {
    return {
      success: false,
      remainingConflicts: conflictFiles,
      error: "action.run_agent is unavailable for merge conflict resolution",
    };
  }

  const configuredPrompt = String(ctx.resolve(promptTemplate || "") || "").trim();
  const prompt = configuredPrompt || buildConflictResolutionPrompt({
    conflictFiles,
    upstreamBranch: baseBranch,
  });
  const conflictCtx = Object.create(ctx);
  conflictCtx.data = {
    ...(ctx.data || {}),
    worktreePath,
    _agentWorkflowActive: true,
    _taskIncludeContext: false,
  };

  const agentResult = await runAgentNodeType.execute({
    id: `${node.id}-merge-conflict-resolver`,
    type: "action.run_agent",
    config: {
      prompt,
      cwd: worktreePath,
      sdk: sdk || "auto",
      includeTaskContext: false,
      continueOnSession: false,
      failOnError: false,
    },
  }, conflictCtx, engine);

  const finalizeResult = finalizeMergeCommitIfReady(worktreePath);
  const remainingConflicts = finalizeResult.remainingConflicts || listUnmergedFiles(worktreePath);
  const mergeInProgress = finalizeResult.mergeInProgress || hasGitStateMarker(worktreePath, "MERGE_HEAD");
  return {
    success: remainingConflicts.length === 0 && !mergeInProgress,
    agentResult,
    finalizedMerge: finalizeResult.finalized === true,
    remainingConflicts,
    mergeInProgress,
    error: finalizeResult.error || null,
  };
}

function hasTrackedGitChanges(worktreePath) {
  if (!worktreePath || !existsSync(worktreePath)) return false;
  try {
    const status = execGitArgsSync(
      ["status", "--porcelain", "--untracked-files=no"],
      {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    return Boolean(status);
  } catch {
    return true;
  }
}

function countCommitsBehindBase(worktreePath, baseBranch) {
  if (!worktreePath || !existsSync(worktreePath) || !baseBranch) return 0;
  try {
    const counts = execGitArgsSync(
      ["rev-list", "--left-right", "--count", `HEAD...${baseBranch}`],
      {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    const match = counts.match(/^(\d+)\s+(\d+)$/);
    return match ? Number(match[2]) : 0;
  } catch {
    return 0;
  }
}

function refreshManagedWorktreeReuse(
  nodeId,
  ctx,
  repoRoot,
  worktreePath,
  baseBranch,
  baseBranchShort,
  fetchTimeout,
  options = {},
) {
  if (!existsSync(worktreePath) || shouldSkipGitRefreshForTests()) {
    return {
      healthy: existsSync(worktreePath),
      repairArtifacts: null,
      detectedIssues: [],
    };
  }
  // Discard dirty tracked files before rebasing so the pull --rebase
  // doesn't fail with "your local changes would be overwritten".
  try {
    const dirty = execGitArgsSync(["status", "--porcelain", "--untracked-files=no"], {
      cwd: worktreePath, encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (dirty) {
      execGitArgsSync(["reset", "--hard", "HEAD"], {
        cwd: worktreePath, encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } catch {
    /* best-effort */
  }
  let refreshError = "";
  try {
    execGitArgsSync(["pull", "--rebase", "origin", baseBranchShort], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: fetchTimeout,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    refreshError = formatExecSyncError(error);
  }
  if (!existsSync(worktreePath)) {
    return {
      healthy: false,
      repairArtifacts: null,
      detectedIssues: refreshError ? ["refresh_failed"] : [],
    };
  }
  if (hasUnresolvedGitOperation(worktreePath)) {
    const detail = refreshError ? ` (${refreshError})` : "";
    ctx.log(
      nodeId,
      `Managed worktree refresh left unresolved git state, recreating: ${worktreePath}${detail}`,
    );
    const detectedIssues = ["unresolved_git_operation", ...(refreshError ? ["refresh_failed"] : [])];
    const repairArtifacts = createManagedWorktreeRepairArtifacts({
      repoRoot,
      worktreePath,
      branch: options.branch,
      baseBranch,
      taskId: options.taskId,
      detectedIssues,
      refreshError,
    });
    cleanupBrokenManagedWorktree(repoRoot, worktreePath);
    return {
      healthy: false,
      repairArtifacts,
      detectedIssues,
    };
  }
  const reasons = [];
  const detectedIssues = [];
  if (hasTrackedGitChanges(worktreePath)) reasons.push("tracked changes after refresh");
  if (hasTrackedGitChanges(worktreePath)) detectedIssues.push("tracked_changes_after_refresh");
  const behindCount = countCommitsBehindBase(worktreePath, baseBranch);
  if (behindCount > 0) reasons.push(`${behindCount} commit(s) behind ${baseBranch}`);
  if (behindCount > 0) detectedIssues.push("behind_base_after_refresh");
  if (reasons.length === 0) {
    return {
      healthy: true,
      repairArtifacts: null,
      detectedIssues: [],
    };
  }
  if (refreshError) detectedIssues.unshift("refresh_failed");
  if (refreshError) reasons.unshift(`refresh failed: ${refreshError}`);
  ctx.log(
    nodeId,
    `Managed worktree refresh did not yield a clean up-to-date branch, recreating: ${worktreePath} (${reasons.join("; ")})`,
  );
  const repairArtifacts = createManagedWorktreeRepairArtifacts({
    repoRoot,
    worktreePath,
    branch: options.branch,
    baseBranch,
    taskId: options.taskId,
    detectedIssues,
    refreshError,
  });
  cleanupBrokenManagedWorktree(repoRoot, worktreePath);
  return {
    healthy: false,
    repairArtifacts,
    detectedIssues,
  };
}

function cleanupBrokenManagedWorktree(repoRoot, worktreePath) {
  if (!worktreePath) return;
  const linkedGitDir = resolveGitDirForWorktree(worktreePath);
  try {
    execGitArgsSync(["worktree", "remove", String(worktreePath), "--force"], {
      cwd: repoRoot,
      encoding: "utf8",
      // Best-effort cleanup should fail fast instead of hanging the workflow.
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort: stale metadata can make removal fail; fallback to filesystem cleanup.
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    if (linkedGitDir && existsSync(linkedGitDir)) {
      rmSync(linkedGitDir, { recursive: true, force: true });
    }
  } catch {
    /* best-effort */
  }
  try {
    execGitArgsSync(["worktree", "prune"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Anti-thrash state — imported from transforms.mjs (single source of truth).
 * Shared between monolithic workflow-nodes.mjs and modular triggers.mjs.
 */
const NO_COMMIT_BASE_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
const NO_COMMIT_MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const STRICT_START_GUARD_MISSING_TASK = /^(1|true|yes|on)$/i.test(
  String(process.env.BOSUN_STRICT_START_GUARD_MISSING_TASK || "").trim(),
);

// ==== trigger.task_available ====

registerBuiltinNodeType("trigger.task_available", {
  describe: () =>
    "Polling trigger that fires when queued tasks are available. Handles " +
    "slot limits, anti-thrash filtering, cooldowns, task sorting (fire " +
    "tasks first), and listTasks retry with backoff.",
  schema: {
    type: "object",
    properties: {
      maxParallel: { type: "number", default: 3, description: "Maximum parallel task slots" },
      pollIntervalMs: { type: "number", default: 30000, description: "Poll interval in ms" },
      projectId: { type: "string", description: "Kanban project ID (optional)" },
      status: { type: "string", default: "todo", description: "Status to poll for" },
      statuses: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered status list to poll, e.g. [\"inreview\", \"todo\"]",
      },
      filterCodexScoped: { type: "boolean", default: true, description: "Only codex-scoped tasks" },
      filterDrafts: { type: "boolean", default: true, description: "Exclude draft tasks" },
      listRetries: { type: "number", default: 3, description: "Retries for listTasks calls" },
      listRetryDelayMs: { type: "number", default: 2000, description: "Base delay between retries" },
      repoAreaParallelLimit: { type: "number", default: 0, description: "Per-repo-area active task cap (0 disables limit)" },
      respectBenchmarkMode: { type: "boolean", default: true, description: "Honor repo-local benchmark mode task filtering" },
      enforceStartGuards: { type: "boolean", default: true, description: "Filter out tasks blocked by dependency/sprint DAG start guards" },
      sprintOrderMode: { type: "string", enum: ["parallel", "sequential"], description: "Optional global sprint-order override when evaluating guards" },
      strictStartGuardMissingTask: { type: "boolean", default: false, description: "When true, task_not_found from start guards blocks dispatch and emits audit events" },
    },
  },
  async execute(node, ctx, engine) {
    const maxParallel = node.config?.maxParallel ?? 3;
    const statuses = normalizeTaskAvailableStatuses(node.config?.statuses ?? node.config?.status ?? "todo");
    const status = statuses[0] || "todo";
    const projectId = cfgOrCtx(node, ctx, "projectId") || undefined;
    const filterDrafts = node.config?.filterDrafts !== false;
    const listRetries = node.config?.listRetries ?? 3;
    const listRetryDelayMs = node.config?.listRetryDelayMs ?? 2000;
    const repoAreaParallelLimit = Number(node.config?.repoAreaParallelLimit ?? 0);
    const respectBenchmarkMode = node.config?.respectBenchmarkMode !== false;
    const enforceStartGuards = node.config?.enforceStartGuards !== false;
    const sprintOrderMode = String(node.config?.sprintOrderMode || "").trim().toLowerCase();
    const strictStartGuardMissingTask =
      typeof node.config?.strictStartGuardMissingTask === "boolean"
        ? node.config.strictStartGuardMissingTask
        : STRICT_START_GUARD_MISSING_TASK;

    // Check slot availability
    const activeSlotCount = ctx.data?.activeSlotCount ?? 0;
    if (activeSlotCount >= maxParallel) {
      ctx.log(node.id, `All ${maxParallel} slot(s) in use — skipping`);
      return { triggered: false, reason: "slots_full", activeSlotCount, maxParallel };
    }

    // Query kanban with retry + backoff
    let tasks = [];
    let lastErr = null;
    for (let attempt = 0; attempt <= listRetries; attempt++) {
      try {
        const kanban = ctx.data?._services?.kanban || engine?.services?.kanban;
        if (statuses.includes("todo")) {
          try {
            await recoverTimedBlockedWorkflowTasks({ kanban, ctx, node, projectId });
          } catch (recoveryErr) {
            ctx.log(node.id, `Blocked task recovery warning: ${recoveryErr?.message || recoveryErr}`);
          }
        }
        const fetchedTasks = [];
        if (kanban?.listTasks) {
          for (const requestedStatus of statuses) {
            const listed = await kanban.listTasks(projectId, { status: requestedStatus });
            fetchedTasks.push(...(Array.isArray(listed) ? listed : []));
          }
        } else {
          const ka = await ensureKanbanAdapterMod();
          for (const requestedStatus of statuses) {
            const listed = await ka.listTasks(projectId, { status: requestedStatus });
            fetchedTasks.push(...(Array.isArray(listed) ? listed : []));
          }
        }
        const seenTaskIds = new Set();
        tasks = fetchedTasks.filter((task) => {
          const taskId = String(task?.id || task?.task_id || "").trim();
          if (!taskId || seenTaskIds.has(taskId)) return false;
          seenTaskIds.add(taskId);
          return true;
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < listRetries) {
          const delay = listRetryDelayMs * Math.pow(2, attempt);
          ctx.log(node.id, `listTasks attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    if (lastErr) {
      ctx.log(node.id, `listTasks failed after ${listRetries + 1} attempts: ${lastErr.message}`);
      return { triggered: false, reason: "list_error", error: lastErr.message };
    }

    // Client-side status filter (backend may not respect status param)
    if (tasks?.length > 0) {
      const allowedStatuses = new Set(statuses);
      tasks = tasks.filter((t) => allowedStatuses.has(String(t?.status || "").trim().toLowerCase()));
    }
    // Draft filter
    if (filterDrafts && tasks?.length > 0) {
      tasks = tasks.filter((t) => !t.draft && !t.isDraft);
    }
    if (!tasks || tasks.length === 0) {
      return { triggered: false, reason: "no_tasks", taskCount: 0 };
    }

    // Anti-thrash + cooldown filters
    const activeTaskIds = ctx.data?.activeTaskIds || [];
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

    let persistedOwnershipFilteredCount = 0;
    if (statuses.includes("todo") && tasks.length > 0) {
      const persistedOwnedTaskIds = await getPersistedOwnedTaskIds(node, ctx);
      if (persistedOwnedTaskIds.size > 0) {
        const beforeFilterCount = tasks.length;
        tasks = tasks.filter((task) => {
          const taskId = pickTaskString(task?.id, task?.task_id);
          return taskId && !persistedOwnedTaskIds.has(taskId);
        });
        persistedOwnershipFilteredCount = beforeFilterCount - tasks.length;
        if (persistedOwnershipFilteredCount > 0) {
          ctx.log(
            node.id,
            `Persisted ownership filtered ${persistedOwnershipFilteredCount} task(s) with live claims/shared state`,
          );
        }
      }
    }

    if (tasks.length === 0) {
      return {
        triggered: false,
        reason: "all_filtered",
        taskCount: 0,
        persistedOwnershipFilteredCount,
      };
    }

    let benchmarkMode = null;
    if (respectBenchmarkMode && tasks.length > 0) {
      try {
        const benchmarkRepoRoot =
          cfgOrCtx(node, ctx, "repoRoot")
          || cfgOrCtx(node, ctx, "workspace")
          || process.cwd();
        benchmarkMode = readBenchmarkModeState(benchmarkRepoRoot);
        if (benchmarkMode.enabled) {
          const beforeCount = tasks.length;
          tasks = tasks.filter((task) =>
            taskMatchesBenchmarkMode(task, benchmarkMode, { repoRoot: benchmarkRepoRoot }),
          );
          const filteredCount = beforeCount - tasks.length;
          if (filteredCount > 0) {
            ctx.log(
              node.id,
              `Benchmark mode filtered ${filteredCount} competing task(s) for ${benchmarkMode.providerId || "benchmark"} focus`,
            );
          }
          if (tasks.length === 0) {
            return {
              triggered: false,
              reason: "benchmark_mode_filtered",
              taskCount: 0,
              benchmarkMode,
            };
          }
        }
      } catch (err) {
        ctx.log(node.id, `Benchmark mode filter warning: ${err?.message || err}`);
      }
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
            benchmarkMode,
          };
        }
      }
    }

    // Sort: inreview first, then fire tasks, then by priority, then by created date
    tasks.sort((a, b) => {
      const aStatus = String(a?.status || "").trim().toLowerCase();
      const bStatus = String(b?.status || "").trim().toLowerCase();
      const aInReview = aStatus === "inreview";
      const bInReview = bStatus === "inreview";
      if (aInReview && !bInReview) return -1;
      if (!aInReview && bInReview) return 1;
      const aFire = (a.labels || []).some((l) => typeof l === "string" ? l.includes("fire") : l?.name?.includes("fire"));
      const bFire = (b.labels || []).some((l) => typeof l === "string" ? l.includes("fire") : l?.name?.includes("fire"));
      if (aFire && !bFire) return -1;
      if (!aFire && bFire) return 1;
      const aPri = a.priority ?? 999;
      const bPri = b.priority ?? 999;
      if (aPri !== bPri) return aPri - bPri;
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
          benchmarkMode,
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
          ctx.data.repoRoot = taskWorkspace;
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
      }
      const resolvedRepoRoot = resolveTaskRepositoryRoot(
        taskRepository,
        pickTaskString(ctx.data.repoRoot, process.cwd()),
      );
      if (resolvedRepoRoot) {
        ctx.data.repoRoot = resolvedRepoRoot;
      }
      const taskRepositories = Array.isArray(primaryTask.repositories)
        ? primaryTask.repositories
        : [];
      if (taskRepositories.length > 0) {
        ctx.data.repositories = taskRepositories;
      }
      const baseBranch = pickTaskString(primaryTask.baseBranch, primaryTask.base_branch);
      if (baseBranch) ctx.data.baseBranch = baseBranch;
      const branch = deriveTaskBranch(primaryTask);
      if (branch) ctx.data.branch = branch;
      ctx.data.taskMeta = primaryTask?.meta && typeof primaryTask.meta === "object"
        ? { ...primaryTask.meta }
        : {};
    }

    ctx.log(node.id, `Found ${toDispatch.length} task(s) ready (${remaining} slot(s) free)`);
    return {
      triggered: true,
      tasks: toDispatch,
      task: primaryTask,
      taskTitle: primaryTask ? pickTaskString(primaryTask.title, primaryTask.task_title) : "",
      taskCount: toDispatch.length,
      availableSlots: remaining,
      selectedTaskId: primaryTask ? pickTaskString(primaryTask.id, primaryTask.task_id) : "",
      persistedOwnershipFilteredCount,
      auditEvents: startGuardAuditEvents,
      benchmarkMode,
    };
  },
});
// ==== condition.slot_available ====

registerBuiltinNodeType("condition.slot_available", {
  describe: () =>
    "Gate checking both global and per-base-branch concurrency limits.",
  schema: {
    type: "object",
    properties: {
      maxParallel: { type: "number", default: 3, description: "Maximum concurrent slots" },
      baseBranchLimit: { type: "number", default: 0, description: "Per-base-branch limit (0 = unlimited)" },
      baseBranch: { type: "string", description: "Base branch to check against" },
    },
  },
  async execute(node, ctx, engine) {
    const maxParallel = node.config?.maxParallel ?? 3;
    const baseBranchLimit = node.config?.baseBranchLimit ?? 0;
    const activeSlotCount = ctx.data?.activeSlotCount ?? 0;
    const slotsAvailable = activeSlotCount < maxParallel;

    let baseBranchOk = true;
    if (baseBranchLimit > 0) {
      const baseBranch = cfgOrCtx(node, ctx, "baseBranch");
      if (baseBranch) {
        const counts = ctx.data?.baseBranchSlotCounts || {};
        const key = baseBranch.replace(/^origin\//, "");
        baseBranchOk = (counts[key] ?? 0) < baseBranchLimit;
      }
    }

    const result = slotsAvailable && baseBranchOk;
    ctx.log(node.id, `Slot check: ${activeSlotCount}/${maxParallel}, perBranch=${baseBranchOk} → ${result}`);
    return { result, slotsAvailable, baseBranchOk, activeSlotCount, maxParallel };
  },
});

// ==== action.allocate_slot ====
registerBuiltinNodeType("action.release_slot", {
  describe: () =>
    "Release a previously allocated execution slot. Restores saved env vars " +
    "for parallel isolation. Idempotent — safe on double-call.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID whose slot to release" },
    },
  },
  async execute(node, ctx, engine) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const slot = ctx.data?._allocatedSlot;

    if (slot && slot.taskId === taskId) {
      if (slot._envSnapshot && typeof slot._envSnapshot === "object") {
        for (const [key, val] of Object.entries(slot._envSnapshot)) {
          if (val === undefined) delete process.env[key];
          else process.env[key] = val;
        }
      }
      slot.status = "released";
      slot.releasedAt = Date.now();
      slot.durationMs = slot.releasedAt - (slot.startedAt || slot.releasedAt);
      ctx.data._allocatedSlot = null;
    }

    ctx.log(node.id, `Slot released: ${taskId || "(unknown)"}`);
    return { success: true, taskId, releasedAt: Date.now() };
  },
});

// ==== action.claim_task ====

registerBuiltinNodeType("action.allocate_slot", {
  describe: () =>
    "Reserve a parallel execution slot. Saves process env snapshot for " +
    "parallel isolation and stores slot metadata in workflow context.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID" },
      taskTitle: { type: "string", description: "Task title" },
      branch: { type: "string", description: "Git branch" },
      baseBranch: { type: "string", description: "Base branch" },
    },
    required: ["taskId"],
  },
  async execute(node, ctx, engine) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const taskTitle = cfgOrCtx(node, ctx, "taskTitle", "(untitled)");
    const branch = cfgOrCtx(node, ctx, "branch");
    const baseBranch = cfgOrCtx(node, ctx, "baseBranch");

    if (!taskId) throw new Error("action.allocate_slot: taskId is required");

    const agentInstanceId = `wf-${randomUUID().slice(0, 8)}`;
    const slotInfo = {
      taskId,
      taskTitle,
      branch,
      baseBranch,
      startedAt: Date.now(),
      agentInstanceId,
      status: "running",
    };

    // Save env snapshot for parallel isolation (restored by release_slot)
    const envSnapshot = {};
    const envPrefixes = ["VE_", "BOSUN_", "COPILOT_", "CLAUDE_", "CODEX_"];
    for (const key of Object.keys(process.env)) {
      if (envPrefixes.some((p) => key.startsWith(p))) {
        envSnapshot[key] = process.env[key];
      }
    }
    slotInfo._envSnapshot = envSnapshot;

    // Store in workflow context
    ctx.data._allocatedSlot = slotInfo;
    ctx.data._agentInstanceId = agentInstanceId;
    ctx.data.taskId = taskId;
    ctx.data.taskTitle = taskTitle;
    ctx.data.branch = branch;
    ctx.data.baseBranch = baseBranch;

    ctx.log(node.id, `Slot allocated: "${taskTitle}" (${taskId}) agent=${agentInstanceId}`);
    return { success: true, slot: slotInfo, agentInstanceId };
  },
});

// ==== action.claim_task ====

registerBuiltinNodeType("action.claim_task", {
  describe: () =>
    "Acquire a distributed task claim with auto-renewal. Prevents duplicate " +
    "execution across orchestrators. Stores claim token + renewal timer in " +
    "context for release_claim.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID to claim" },
      taskTitle: { type: "string", description: "Task title" },
      ttlMinutes: { type: "number", default: 180, description: "Claim TTL in minutes" },
      renewIntervalMs: { type: "number", default: 60000, description: "Renewal interval (1 min default)" },
      instanceId: { type: "string", description: "Orchestrator instance ID (auto-gen if omitted)" },
      branch: { type: "string", description: "Branch for claim metadata" },
      sdk: { type: "string", description: "SDK for claim metadata" },
      model: { type: "string", description: "Model for claim metadata" },
    },
    required: ["taskId"],
  },
  async execute(node, ctx, engine) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const taskTitle = cfgOrCtx(node, ctx, "taskTitle");
    const ttlMinutes = node.config?.ttlMinutes ?? 180;
    const renewIntervalMs = node.config?.renewIntervalMs ?? 60000;
    const instanceId = cfgOrCtx(node, ctx, "instanceId") || ctx.data?._agentInstanceId || `wf-${randomUUID().slice(0, 8)}`;
    const branch = cfgOrCtx(node, ctx, "branch");
    const sdk = cfgOrCtx(node, ctx, "resolvedSdk", cfgOrCtx(node, ctx, "sdk"));
    const model = cfgOrCtx(node, ctx, "resolvedModel", cfgOrCtx(node, ctx, "model"));
    const transitionType = String(
      cfgOrCtx(node, ctx, "delegationTransitionType", cfgOrCtx(node, ctx, "transitionType")) || "assign",
    ).trim() || "assign";
    const transitionKey = String(
      cfgOrCtx(node, ctx, "delegationTransitionKey", cfgOrCtx(node, ctx, "idempotencyKey")) || "",
    ).trim();
    const idempotencyKey = String(
      cfgOrCtx(node, ctx, "idempotencyKey")
      || ctx.data?._claimIdempotencyKey
      || node.config?.delegationKey
      || taskId
      || "",
    ).trim();
    const effectiveTransitionKey = transitionKey || idempotencyKey;

    if (!taskId) throw new Error("action.claim_task: taskId is required");

    const replayGuard = effectiveTransitionKey && typeof ctx?.getDelegationTransitionGuard === "function"
      ? ctx.getDelegationTransitionGuard(effectiveTransitionKey)
      : null;
    if (replayGuard?.claimToken) {
      ctx.data._claimToken = replayGuard.claimToken;
      ctx.data._claimInstanceId = replayGuard.instanceId || instanceId;
      return {
        success: true,
        taskId,
        claimToken: replayGuard.claimToken,
        instanceId: replayGuard.instanceId || instanceId,
        transitionKey: effectiveTransitionKey,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const transitionGuard = effectiveTransitionKey
      ? beginDelegationTransition(ctx, effectiveTransitionKey, {
          type: transitionType,
          eventType: transitionType,
          taskId,
          nodeId: node.id,
          instanceId,
        })
      : null;
    if (transitionGuard?.completed) {
      const completedResult = transitionGuard.entry?.result || null;
      if (completedResult?.claimToken) {
        ctx.data._claimToken = completedResult.claimToken;
      } else if (transitionGuard.entry?.claimToken) {
        ctx.data._claimToken = transitionGuard.entry.claimToken;
      }
      ctx.data._claimInstanceId =
        completedResult?.instanceId || transitionGuard.entry?.instanceId || instanceId;
      return {
        ...(completedResult || {
          success: true,
          taskId,
          claimToken: transitionGuard.entry?.claimToken || null,
          instanceId: transitionGuard.entry?.instanceId || instanceId,
        }),
        transitionKey: effectiveTransitionKey,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const transition = getClaimTransitionState(ctx, taskId, idempotencyKey);
    if (transition.completed && transition.result?.success) {
      const replayedResult = {
        ...transition.result,
        success: true,
        taskId,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
      if (effectiveTransitionKey && typeof ctx?.setDelegationTransitionGuard === "function") {
        ctx.setDelegationTransitionGuard(effectiveTransitionKey, {
          ...(ctx.getDelegationTransitionGuard?.(effectiveTransitionKey) || {}),
          type: transitionType,
          eventType: transitionType,
          taskId,
          claimToken: replayedResult.claimToken || null,
          instanceId: replayedResult.instanceId || instanceId,
          nodeId: node.id,
          transitionKey: effectiveTransitionKey,
          status: "completed",
        });
      }
      ctx.data._claimToken = replayedResult.claimToken || ctx.data._claimToken || null;
      ctx.data._claimInstanceId = replayedResult.instanceId || ctx.data._claimInstanceId || instanceId;
      return replayedResult;
    }

    if (transition.inFlightPromise) {
      const inFlightResult = await transition.inFlightPromise;
      return {
        ...inFlightResult,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const claims = await ensureTaskClaimsMod();
    const runtimeState = getWorkflowRuntimeState(ctx);
    const renewClaimFn =
      typeof claims.renewTaskClaim === "function"
        ? claims.renewTaskClaim.bind(claims)
        : typeof claims.renewClaim === "function"
          ? claims.renewClaim.bind(claims)
          : null;
    const handleFatalRenewal = (message, token) => {
      ctx.log(node.id, `Claim renewal fatal: ${message} — aborting task`);
      if (runtimeState.claimRenewTimer) {
        try { clearInterval(runtimeState.claimRenewTimer); } catch { /* ok */ }
      }
      runtimeState.claimRenewTimer = null;
      ctx.data._claimRenewTimer = null;
      ctx.data._claimStolen = true;
      const ownerMismatchKey = buildDelegationTransitionKey("renew", [
        taskId,
        token || ctx.data?._claimToken || "none",
        "owner-mismatch",
      ]);
      recordDelegationAuditEvent(ctx, {
        type: "owner-mismatch",
        eventType: "owner-mismatch",
        taskId,
        claimToken: token || ctx.data?._claimToken || null,
        instanceId,
        reason: message,
        error: message,
        nodeId: node.id,
        transitionKey: ownerMismatchKey,
        idempotencyKey: ownerMismatchKey,
      });
    };

    transition.inFlightPromise = (async () => {
      try {
        await ensureTaskClaimsInitialized(ctx, claims);
      } catch (initErr) {
        ctx.log(node.id, `Claim init failed: ${initErr.message}`);
        failDelegationTransition(ctx, effectiveTransitionKey || transitionKey || idempotencyKey, {
          type: transitionType,
          eventType: transitionType,
          taskId,
          nodeId: node.id,
          error: initErr.message,
        });
        return { success: false, error: initErr.message, taskId, alreadyClaimed: false };
      }

      let claimResult;
      try {
        claimResult = await claims.claimTask({
          taskId,
          instanceId,
          ttlMinutes,
          metadata: {
            task_title: taskTitle,
            branch,
            owner: "workflow-engine",
            sdk,
            model: model || null,
            pid: process.pid,
            idempotency_key: idempotencyKey || null,
          },
        });
      } catch (err) {
        ctx.log(node.id, `Claim failed: ${err.message}`);
        failDelegationTransition(ctx, effectiveTransitionKey || transitionKey || idempotencyKey, {
          type: transitionType,
          eventType: transitionType,
          taskId,
          nodeId: node.id,
          error: err.message,
        });
        return { success: false, error: err.message, taskId, alreadyClaimed: false };
      }

      if (claimResult?.success) {
        const token = claimResult.token || claimResult.claim?.claim_token || null;
        ctx.data._claimToken = token;
        ctx.data._claimInstanceId = instanceId;
        transition.completed = true;
        transition.claimToken = token;
        transition.instanceId = instanceId;
        transition.result = {
          success: true,
          taskId,
          claimToken: token,
          instanceId,
          alreadyClaimed: false,
          transitionKey: effectiveTransitionKey || `assign:${taskId}:${instanceId}`,
        };
        appendDelegationAuditEvent(ctx, {
          type: transitionType,
          eventType: transitionType,
          taskId,
          idempotencyKey: effectiveTransitionKey || idempotencyKey,
          claimToken: token,
          nodeId: node.id,
          transitionKey: effectiveTransitionKey || `assign:${taskId}:${instanceId}`,
          instanceId,
        });
        if (effectiveTransitionKey && typeof ctx?.setDelegationTransitionGuard === "function") {
          ctx.setDelegationTransitionGuard(effectiveTransitionKey, {
            type: transitionType,
            eventType: transitionType,
            taskId,
            claimToken: token,
            instanceId,
            nodeId: node.id,
            transitionKey: effectiveTransitionKey,
            status: "completed",
          });
        }
        if (effectiveTransitionKey) {
          completeDelegationTransition(ctx, effectiveTransitionKey, {
            type: transitionType,
            eventType: transitionType,
            taskId,
            claimToken: token,
            instanceId,
            nodeId: node.id,
            transitionKey: effectiveTransitionKey,
            result: transition.result,
          });
        }

        if (renewIntervalMs > 0 && renewClaimFn && !runtimeState.claimRenewTimer) {
          const renewTimer = setInterval(async () => {
            try {
              const renewalResult = await renewClaimFn({ taskId, claimToken: token, instanceId, ttlMinutes });
              if (renewalResult && renewalResult.success === false) {
                const resultError = String(renewalResult.error || "claim_renew_failed");
                const fatalResult = ["claimed_by_different_instance", "claim_token_mismatch",
                  "task_not_claimed", "owner_mismatch", "attempt_token_mismatch"].some((e) => resultError.includes(e));
                if (fatalResult) {
                  handleFatalRenewal(resultError, token);
                } else {
                  ctx.log(node.id, `Claim renewal warning: ${resultError}`);
                }
              } else if (renewalResult?.success) {
                const claimRenewKey = buildDelegationTransitionKey("renew", [
                  taskId,
                  token || ctx.data?._claimToken || "none",
                  "claim-renew",
                ]);
                recordDelegationAuditEvent(ctx, {
                  type: "claim-renew",
                  eventType: "claim-renew",
                  taskId,
                  claimToken: token || ctx.data?._claimToken || null,
                  instanceId,
                  nodeId: node.id,
                  transitionKey: claimRenewKey,
                  idempotencyKey: claimRenewKey,
                });
              }
            } catch (renewErr) {
              const msg = renewErr?.message || String(renewErr);
              const fatal = ["claimed_by_different_instance", "claim_token_mismatch",
                "task_not_claimed", "owner_mismatch", "attempt_token_mismatch"].some((e) => msg.includes(e));
              if (fatal) {
                handleFatalRenewal(msg, token);
              } else {
                ctx.log(node.id, `Claim renewal warning: ${msg}`);
              }
            }
          }, renewIntervalMs);
          if (renewTimer.unref) renewTimer.unref();
          runtimeState.claimRenewTimer = renewTimer;
          ctx.data._claimRenewTimer = renewTimer;
        }

        ctx.log(node.id, `Task claimed: ${taskId}`);
        return transition.result;
      }

      ctx.log(node.id, `Task already claimed: ${taskId}`);
      failDelegationTransition(ctx, effectiveTransitionKey || transitionKey || idempotencyKey, {
        type: transitionType,
        eventType: transitionType,
        taskId,
        nodeId: node.id,
        error: claimResult?.error || "unknown",
        alreadyClaimed: true,
      });
      return { success: false, taskId, error: claimResult?.error || "unknown", alreadyClaimed: true };
    })();

    try {
      return await transition.inFlightPromise;
    } finally {
      transition.inFlightPromise = null;
    }
  },
});

// ==== action.release_claim ====

registerBuiltinNodeType("action.release_claim", {
  describe: () =>
    "Release a distributed task claim + cancel renewal timer. Idempotent.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID to release claim for" },
      claimToken: { type: "string", description: "Claim token (auto-read from ctx)" },
      instanceId: { type: "string", description: "Instance ID (auto-read from ctx)" },
    },
  },
  async execute(node, ctx, engine) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const claimToken = cfgOrCtx(node, ctx, "claimToken") || ctx.data?._claimToken || "";
    const instanceId = cfgOrCtx(node, ctx, "instanceId") || ctx.data?._claimInstanceId || "";

    const runtimeState = getWorkflowRuntimeState(ctx);
    const renewTimer = runtimeState.claimRenewTimer || ctx.data?._claimRenewTimer;
    if (renewTimer) {
      try { clearInterval(renewTimer); } catch { /* ok */ }
    }
    runtimeState.claimRenewTimer = null;
    ctx.data._claimRenewTimer = null;

    if (!taskId || !claimToken) {
      ctx.log(node.id, `No claim to release for ${taskId || "(unknown)"}`);
      return { success: true, skipped: true, reason: "no_claim" };
    }

    const transitionKey = String(
      cfgOrCtx(node, ctx, "transitionKey", cfgOrCtx(node, ctx, "idempotencyKey")) || `release:${taskId}`,
    ).trim() || `release:${taskId}`;
    const transitionGuard = beginDelegationTransition(ctx, transitionKey, {
      type: "release-claim",
      eventType: "release-claim",
      taskId,
      claimToken,
      instanceId,
      nodeId: node.id,
    });
    if (transitionGuard.completed) {
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      return {
        ...(transitionGuard.entry?.result || { success: true, taskId, claimToken, instanceId }),
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const transition = getReleaseTransitionState(ctx, "claim", taskId);
    if (transition.completed) {
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      completeDelegationTransition(ctx, transitionKey, {
        type: "release-claim",
        eventType: "release-claim",
        taskId,
        claimToken,
        instanceId,
        nodeId: node.id,
        transitionKey,
        result: transition.result || { success: true, taskId, claimToken, instanceId },
      });
      return {
        ...(transition.result || { success: true, taskId, claimToken, instanceId }),
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const claims = await ensureTaskClaimsMod();
    try {
      await ensureTaskClaimsInitialized(ctx, claims);
    } catch (initErr) {
      ctx.log(node.id, `Claim release init warning: ${initErr.message}`);
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      transition.completed = true;
      transition.result = { success: true, taskId, claimToken, instanceId, warning: initErr.message };
      completeDelegationTransition(ctx, transitionKey, {
        type: "release-claim",
        eventType: "release-claim",
        taskId,
        claimToken,
        instanceId,
        nodeId: node.id,
        transitionKey,
        result: transition.result,
      });
      return transition.result;
    }
    const releaseClaimFn =
      typeof claims.releaseTaskClaim === "function"
        ? claims.releaseTaskClaim.bind(claims)
        : typeof claims.releaseTask === "function"
          ? claims.releaseTask.bind(claims)
          : null;
    try {
      if (!releaseClaimFn) throw new Error("no claim release function available");
      await releaseClaimFn({ taskId, claimToken, instanceId });
      ctx.log(node.id, `Claim released for ${taskId}`);
      transition.result = { success: true, taskId, claimToken, instanceId };
    } catch (err) {
      ctx.log(node.id, `Claim release warning: ${err.message}`);
      transition.result = { success: true, taskId, claimToken, instanceId, warning: err.message };
    }
    transition.completed = true;
    completeDelegationTransition(ctx, transitionKey, {
      type: "release-claim",
      eventType: "release-claim",
      taskId,
      claimToken,
      instanceId,
      nodeId: node.id,
      transitionKey,
      result: transition.result,
    });
    ctx.data._claimToken = null;
    ctx.data._claimInstanceId = null;
    return transition.result;
  },
});


// ==== action.resolve_executor ====

registerBuiltinNodeType("action.resolve_executor", {
  describe: () =>
    "Pick SDK + model via complexity routing, env overrides, or defaults.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      taskTitle: { type: "string" },
      taskDescription: { type: "string" },
      defaultSdk: { type: "string", default: "auto", description: "Fallback SDK" },
      sdkOverride: { type: "string", description: "Force a specific SDK" },
      modelOverride: { type: "string", description: "Force a specific model" },
    },
  },
  async execute(node, ctx, engine) {
    const defaultSdk = cfgOrCtx(node, ctx, "defaultSdk", "auto");
    const sdkOverride = cfgOrCtx(node, ctx, "sdkOverride");
    const modelOverride = cfgOrCtx(node, ctx, "modelOverride");
    const repoRoot = cfgOrCtx(node, ctx, "repoRoot")
      || cfgOrCtx(node, ctx, "workspace")
      || process.cwd();
    const task = {
      id: cfgOrCtx(node, ctx, "taskId"),
      title: cfgOrCtx(node, ctx, "taskTitle"),
      description: cfgOrCtx(node, ctx, "taskDescription"),
      tags: Array.isArray(ctx.data?.task?.tags) ? ctx.data.task.tags : [],
    };
    const requestedAgentProfileId = String(
      cfgOrCtx(node, ctx, "agentProfile")
      || ctx.data?.task?.agentProfile
      || ctx.data?.agentProfile
      || "",
    ).trim();
    const taskText = [task.title, task.description].filter(Boolean).join("\n");
    const inferredResolutionTags = [];
    if (/\btest(?:s|ing)?\b/i.test(taskText)) inferredResolutionTags.push("test", "tests");
    if (/\b(?:ci|cd|pipeline|workflow|github actions?)\b/i.test(taskText)) inferredResolutionTags.push("ci", "cd", "pipeline");
    if (/\b(?:merge conflict|conflicts|rebase|cherry-pick)\b/i.test(taskText)) inferredResolutionTags.push("conflict", "merge");
    if (/\b(?:implement|implementation|feature|build|ship)\b/i.test(taskText)) inferredResolutionTags.push("implementation");
    if (/\b(?:docs?|documentation|readme)\b/i.test(taskText)) inferredResolutionTags.push("docs", "documentation");
    const resolutionTags = Array.from(new Set([
      ...task.tags,
      ...inferredResolutionTags,
      String(ctx.data?.task?.type || "").trim(),
      String(ctx.data?.task?.agentType || "").trim(),
      String(ctx.data?.task?.assignedAgentType || "").trim(),
      String(ctx.data?.agentType || "").trim(),
      String(ctx.data?.assignedAgentType || "").trim(),
    ].map((value) => String(value || "").trim()).filter(Boolean)));
    let profileDecision = null;
    let configuredExecutorPreference = null;
    ctx.data.resolvedSkillIds = [];
    ctx.data.resolvedLibraryPlan = null;

    // Check env var overrides (mirrors TaskExecutor behavior)
    const envModel =
      process.env.COPILOT_MODEL || process.env.CLAUDE_MODEL || process.env.CODEX_MODEL || "";

    // Manual override takes precedence
    if (sdkOverride && sdkOverride !== "auto") {
      const model = modelOverride || envModel || "";
      ctx.data.resolvedSdk = sdkOverride;
      ctx.data.resolvedModel = model;
      ctx.log(node.id, `Executor override: sdk=${sdkOverride}, model=${model}`);
      return { success: true, sdk: sdkOverride, model, tier: "override", profile: null };
    }

    try {
      const library = await ensureLibraryManagerMod();
      const criteria = {
        title: task.title,
        description: task.description,
        tags: resolutionTags,
        agentType: ctx.data?.task?.agentType || ctx.data?.agentType || "",
        repoRoot,
        changedFiles: Array.isArray(ctx.data?.changedFiles) ? ctx.data.changedFiles : [],
      };
      const planResult = library.resolveLibraryPlan?.(
        repoRoot,
        criteria,
        {
          topN: Math.max(10, requestedAgentProfileId ? 25 : 10),
          skillTopN: 5,
        },
      );
      const candidates = Array.isArray(planResult?.candidates) ? planResult.candidates : [];
      const bestCandidate = planResult?.best || null;
      const autoMinScore = Number(planResult?.auto?.thresholds?.minScore || 12);
      const scoreQualified = Number(bestCandidate?.score || 0) >= autoMinScore;
      const matchedCandidate = requestedAgentProfileId
        ? candidates.find((candidate) => String(candidate?.id || "").trim() === requestedAgentProfileId) || null
        : ((planResult?.auto?.shouldAutoApply || scoreQualified) ? bestCandidate : null);
      if (!requestedAgentProfileId && bestCandidate && !planResult?.auto?.shouldAutoApply) {
        ctx.log(
          node.id,
          `Profile match below auto threshold; ignoring candidate ${String(bestCandidate.id || "unknown")}`,
        );
      }
      const profile = matchedCandidate?.profile || null;
      const profileId = String(matchedCandidate?.id || "").trim();
      if (requestedAgentProfileId && !profileId) {
        ctx.log(
          node.id,
          `Requested agent profile "${requestedAgentProfileId}" not found; falling back to executor defaults`,
        );
      }
      if (profileId && profile) {
        profileDecision = { id: profileId, profile };
        ctx.data.agentProfile = profileId;
        ctx.data.resolvedAgentProfile = {
          id: profileId,
          name: matchedCandidate?.name || profile?.name || profileId,
          ...profile,
        };
        const resolvedPlan = planResult?.plan && planResult.plan.agentProfileId === profileId
          ? planResult.plan
          : null;
        const skillIds = resolvedPlan && Array.isArray(resolvedPlan.skillIds)
          ? resolvedPlan.skillIds.map((value) => String(value || "").trim()).filter(Boolean)
          : Array.isArray(profile.skills)
            ? profile.skills.map((value) => String(value || "").trim()).filter(Boolean)
            : [];
        ctx.data.resolvedSkillIds = skillIds;
        ctx.data.resolvedLibraryPlan = resolvedPlan;
      }
    } catch (err) {
      ctx.log(node.id, `Library profile resolution failed: ${err.message}`);
    }

    if (!profileDecision?.profile) {
      try {
        const configMod = await ensureConfigMod();
        configuredExecutorPreference = resolveWorkflowExecutorPreference(
          configMod.loadConfig?.(process.argv, { reloadEnv: false }) || null,
          defaultSdk,
        );
      } catch (err) {
        ctx.log(node.id, `Executor config resolution failed: ${err.message}`);
      }
    }

    // Complexity-based routing
    try {
      const complexity = await ensureTaskComplexityMod();
      if (complexity.resolveExecutorForTask && complexity.executorToSdk) {
        const baseProfile = profileDecision?.profile
          ? {
              name: profileDecision.id,
              executor: profileDecision.profile.sdk || "CODEX",
              model: profileDecision.profile.model || "",
              variant: "DEFAULT",
              role: "primary",
              weight: 100,
              enabled: true,
            }
          : configuredExecutorPreference?.baseProfile || undefined;
        if (!baseProfile && configuredExecutorPreference?.sdk) {
          const configuredModel =
            modelOverride || envModel || configuredExecutorPreference.model || "";
          ctx.data.resolvedSdk = configuredExecutorPreference.sdk;
          ctx.data.resolvedModel = configuredModel;
          ctx.log(
            node.id,
            `Executor configured: sdk=${configuredExecutorPreference.sdk}, model=${configuredModel}`,
          );
          return {
            success: true,
            sdk: configuredExecutorPreference.sdk,
            model: configuredModel,
            tier: "configured",
            profile: null,
            complexity: null,
          };
        }
        const resolved = complexity.resolveExecutorForTask(task, baseProfile);
        let sdk = complexity.executorToSdk(resolved.executor);
        const profileSdkRaw = String(profileDecision?.profile?.sdk || "").trim().toLowerCase();
        const profileModelRaw = String(profileDecision?.profile?.model || "").trim().toLowerCase();
        if (profileSdkRaw) {
          if (profileSdkRaw.includes("claude")) sdk = "claude";
          else if (profileSdkRaw.includes("copilot")) sdk = "copilot";
          else if (profileSdkRaw.includes("codex")) sdk = "codex";
        } else if (profileModelRaw) {
          if (profileModelRaw.includes("claude")) sdk = "claude";
          else if (profileModelRaw.includes("gpt") || profileModelRaw.includes("codex")) sdk = "codex";
        } else if (configuredExecutorPreference?.sdk) {
          sdk = configuredExecutorPreference.sdk;
        }
        const model =
          modelOverride ||
          envModel ||
          profileDecision?.profile?.model ||
          configuredExecutorPreference?.model ||
          resolved.model ||
          "";
        const tier = profileDecision?.profile ? "profile" : (resolved.tier || "default");
        ctx.data.resolvedSdk = sdk;
        ctx.data.resolvedModel = model;
        ctx.log(node.id, `Executor: sdk=${sdk}, model=${model}, tier=${tier}`);
        return {
          success: true,
          sdk,
          model,
          tier,
          profile: profileDecision?.id || resolved.name || null,
          complexity: resolved.complexity || null,
        };
      }
    } catch (err) {
      ctx.log(node.id, `Complexity routing failed: ${err.message}`);
    }

    // Fallback
    let sdk = configuredExecutorPreference?.sdk || defaultSdk;
    if (!sdk || sdk === "auto") {
      try {
        const pool = await ensureAgentPoolMod();
        sdk = pool.getPoolSdkName?.() || "codex";
      } catch {
        sdk = "codex";
      }
    }
    const model =
      modelOverride ||
      envModel ||
      profileDecision?.profile?.model ||
      configuredExecutorPreference?.model ||
      "";
    ctx.data.resolvedSdk = sdk;
    ctx.data.resolvedModel = model;
    const fallbackTier = profileDecision?.profile ? "profile" : "default";
    ctx.log(node.id, `Executor fallback: sdk=${sdk}`);
    return { success: true, sdk, model, tier: fallbackTier, profile: profileDecision?.id || null };
  },
});

// ==== action.acquire_worktree ====

export function classifyAcquireWorktreeFailure(errorInput) {
  const errorMessage = String(errorInput?.message || errorInput || "worktree_acquisition_failed");
  const normalized = errorMessage.trim();

  if (/managed worktree was removed after stale refresh state/i.test(normalized)) {
    return {
      errorMessage: normalized,
      retryable: false,
      failureKind: "branch_refresh_conflict",
      blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
      detectedIssues: ["refresh_conflict"],
      phase: "post-pull",
    };
  }

  if (
    /worktree runtime setup incomplete/i.test(normalized) ||
    /missing worktree setup files/i.test(normalized) ||
    /git core\.hooksPath/i.test(normalized)
  ) {
    return {
      errorMessage: normalized,
      retryable: false,
      failureKind: "worktree_runtime_setup_incomplete",
      blockedReason: normalized,
      detectedIssues: ["runtime_setup_incomplete"],
      phase: "runtime-setup",
    };
  }

  return {
    errorMessage: normalized,
    retryable: true,
    failureKind: "worktree_acquisition_failed",
    blockedReason: normalized,
    detectedIssues: [],
    phase: null,
  };
}

registerBuiltinNodeType("action.acquire_worktree", {
  describe: () =>
    "Create or checkout a git worktree for isolated task execution. " +
    "Fetches base branch, creates worktree, handles branch conflicts.",
  schema: {
    type: "object",
    properties: {
      repoRoot: { type: "string", description: "Repository root path" },
      branch: { type: "string", description: "Working branch name" },
      taskId: { type: "string", description: "Task ID (worktree owner)" },
      baseBranch: { type: "string", default: "origin/main", description: "Base branch" },
      defaultTargetBranch: { type: "string", default: "origin/main", description: "Fallback" },
      fetchTimeout: { type: "number", default: 30000, description: "Git fetch timeout (ms)" },
      worktreeTimeout: { type: "number", default: 60000, description: "Worktree creation timeout (ms)" },
    },
    required: ["branch", "taskId"],
  },
  async execute(node, ctx, engine) {
    // Outer guard: ensure we ALWAYS return structured output with recoveryNote
    // so downstream {{acquire-worktree.recoveryNote}} templates never stay literal.
    let taskId, branch, repoRoot, baseBranch;
    try {
    taskId = cfgOrCtx(node, ctx, "taskId");
    branch = cfgOrCtx(node, ctx, "branch");
    repoRoot = findContainingGitRepoRoot(resolveWorkflowRepoRoot(node, ctx))
      || resolveWorkflowRepoRoot(node, ctx);
    const baseBranchRaw = cfgOrCtx(node, ctx, "baseBranch", "origin/main");
    const defaultTargetBranch = cfgOrCtx(node, ctx, "defaultTargetBranch", "origin/main");
    baseBranch = pickGitRef(baseBranchRaw, defaultTargetBranch, "origin/main", "main");
    const fetchTimeout = node.config?.fetchTimeout ?? 30000;
    const worktreeTimeout = node.config?.worktreeTimeout ?? 60000;
    const recoveryState = {
      recreated: false,
      detectedIssues: new Set(),
      phase: null,
      worktreePath: null,
      repairArtifacts: null,
    };
    const persistRecoveryEvent = async (event) => {
      const payload = {
        reason: "poisoned_worktree",
        branch,
        taskId,
        worktreePath: event?.worktreePath || recoveryState.worktreePath || null,
        phase: event?.phase || recoveryState.phase || null,
        detectedIssues: event?.detectedIssues || Array.from(recoveryState.detectedIssues),
        error: event?.error || null,
        outcome: event?.outcome || "healthy_noop",
        timestamp: new Date().toISOString(),
      };
      try {
        await recordWorktreeRecoveryEvent(repoRoot, payload);
      } catch (err) {
        ctx.log(
          node.id,
          `[worktree-recovery] failed to persist recovery event: ${
            err && err.message ? err.message : String(err)
          }`,
        );
      }
      const details = [
        `outcome=${payload.outcome}`,
        `branch=${payload.branch}`,
        payload.taskId ? `taskId=${payload.taskId}` : "",
        payload.phase ? `phase=${payload.phase}` : "",
        payload.worktreePath ? `path=${payload.worktreePath}` : "",
        payload.error ? `error=${payload.error}` : "",
      ].filter(Boolean).join(" ");
      ctx.log(node.id, `[worktree-recovery] ${details}`);
    };

    if (!branch) throw new Error("action.acquire_worktree: branch is required");
    if (!taskId) throw new Error("action.acquire_worktree: taskId is required");
    ctx.data.repoRoot = repoRoot;
    ctx.data.baseBranch = baseBranch;

    // Non-git directory — agent spawns directly
    let isGit = existsSync(resolve(repoRoot, ".git"));
    if (!isGit) {
      const parentRepoRoot = resolve(repoRoot, "..");
      if (
        basename(String(repoRoot || "").trim()).toLowerCase() === ".bosun"
        && existsSync(resolve(parentRepoRoot, ".git"))
      ) {
        repoRoot = parentRepoRoot;
        ctx.data.repoRoot = repoRoot;
        isGit = true;
      }
    }
    if (!isGit) {
      const containingRepoRoot = findContainingGitRepoRoot(repoRoot);
      if (containingRepoRoot && containingRepoRoot !== repoRoot) {
        repoRoot = containingRepoRoot;
        ctx.data.repoRoot = repoRoot;
        isGit = existsSync(resolve(repoRoot, ".git"));
      }
    }
    if (!isGit) {
      ctx.data.worktreePath = repoRoot;
      ctx.data._worktreeCreated = false;
      ctx.data._worktreeManaged = false;
      ctx.log(node.id, `Non-git directory — using ${repoRoot} directly`);
      return { success: true, worktreePath: repoRoot, created: false, noGit: true };
    }

    // Repair known main-repo git metadata/config corruption before any worktree command runs.
    fixGitConfigCorruption(repoRoot);

    try {
      // Ensure base branch ref is fresh
      const baseBranchShort = baseBranch.replace(/^origin\//, "");
      const notePoisonedWorktree = (phase, worktreePath, issues = []) => {
        recoveryState.recreated = true;
        recoveryState.phase = phase;
        recoveryState.worktreePath = worktreePath || recoveryState.worktreePath || null;
        for (const issue of issues) {
          const normalized = String(issue || "").trim();
          if (normalized) recoveryState.detectedIssues.add(normalized);
        }
      };
      if (!shouldSkipGitRefreshForTests()) {
        try {
          execGitArgsSync(["fetch", "origin", baseBranchShort, "--no-tags"], {
            cwd: repoRoot, encoding: "utf8",
            timeout: fetchTimeout,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          // Best-effort fetch — offline or transient issue is OK
        }
      }

      const worktreesDir = resolve(repoRoot, ".bosun", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      // Keep managed worktree paths short on Windows to avoid MAX_PATH checkout failures.
      const worktreePath = resolve(worktreesDir, deriveManagedWorktreeDirName(taskId, branch));

      if (!existsSync(worktreePath)) {
        cleanupBrokenManagedWorktree(repoRoot, worktreePath);
      }

      // Ensure long paths are enabled for this repo before checkout.
      try {
        execGitArgsSync(["config", "--local", "core.longpaths", "true"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Best-effort; older git builds or non-Windows hosts may ignore this.
      }

      if (existsSync(worktreePath)) {
        if (!isValidGitWorktreePath(worktreePath)) {
          ctx.log(node.id, `Managed worktree is invalid, recreating: ${worktreePath}`);
          notePoisonedWorktree("pre-reuse", worktreePath, ["missing_git_metadata"]);
          cleanupBrokenManagedWorktree(repoRoot, worktreePath);
        } else if (hasUnresolvedGitOperation(worktreePath)) {
          ctx.log(node.id, `Managed worktree has unresolved git state, recreating: ${worktreePath}`);
          notePoisonedWorktree("pre-reuse", worktreePath, ["unresolved_git_operation"]);
          cleanupBrokenManagedWorktree(repoRoot, worktreePath);
        }
      }

      if (existsSync(worktreePath)) {
        const refreshResult = refreshManagedWorktreeReuse(
          node.id,
          ctx,
          repoRoot,
          worktreePath,
          baseBranch,
          baseBranchShort,
          fetchTimeout,
          { taskId, branch },
        );
        if (refreshResult?.repairArtifacts) {
          recoveryState.repairArtifacts = refreshResult.repairArtifacts;
        }
        if (existsSync(worktreePath)) {
          fixGitConfigCorruption(repoRoot);
          ctx.data.worktreePath = worktreePath;
          ctx.data._worktreeCreated = false;
          ctx.data._worktreeManaged = true;
          ensureManagedTaskWorktreeReady(repoRoot, worktreePath);
          await persistRecoveryEvent({
            outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
            worktreePath,
          });
          ctx.log(node.id, `Reusing worktree: ${worktreePath}`);
          const cleared1 = clearBlockedWorktreeIdentity(worktreePath);
          if (cleared1) ctx.log(node.id, `Cleared blocked test git identity from worktree: ${worktreePath}`);
          return { success: true, worktreePath, created: false, reused: true, branch, baseBranch };
        }
      }

      // Create fresh worktree
      let attachedExistingBranch = false;
      const branchExistsLocally = localBranchExists(repoRoot, branch);
      let existingBranchWorktree = branchExistsLocally
        ? findExistingWorktreePathForBranch(repoRoot, branch)
        : "";
      if (existingBranchWorktree && !existsSync(existingBranchWorktree)) {
        ctx.log(
          node.id,
          `Pruning stale registered worktree for branch ${branch}: ${existingBranchWorktree}`,
        );
        notePoisonedWorktree("attached-branch", existingBranchWorktree, ["missing_git_metadata"]);
        cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
        existingBranchWorktree = "";
      }
      if (existingBranchWorktree && existsSync(existingBranchWorktree)) {
        const existingWorktreeIsBroken = (
          !isValidGitWorktreePath(existingBranchWorktree) ||
          hasUnresolvedGitOperation(existingBranchWorktree)
        ) && isManagedBosunWorktree(existingBranchWorktree, repoRoot);
        if (existingWorktreeIsBroken) {
          ctx.log(
            node.id,
            `Existing branch worktree is invalid or unresolved, recreating managed path: ${existingBranchWorktree}`,
          );
          notePoisonedWorktree("attached-branch", existingBranchWorktree, [
            !isValidGitWorktreePath(existingBranchWorktree)
              ? "missing_git_metadata"
              : "unresolved_git_operation",
          ]);
          cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
          existingBranchWorktree = "";
        }
      }
      if (existingBranchWorktree && existsSync(existingBranchWorktree) &&
        isValidGitWorktreePath(existingBranchWorktree) &&
        !hasUnresolvedGitOperation(existingBranchWorktree)
      ) {
        const refreshResult = refreshManagedWorktreeReuse(
          node.id,
          ctx,
          repoRoot,
          existingBranchWorktree,
          baseBranch,
          baseBranchShort,
          fetchTimeout,
          { taskId, branch },
        );
        if (refreshResult?.repairArtifacts) {
          recoveryState.repairArtifacts = refreshResult.repairArtifacts;
        }
        if (existsSync(existingBranchWorktree) &&
          isValidGitWorktreePath(existingBranchWorktree) &&
          !hasUnresolvedGitOperation(existingBranchWorktree)
        ) {
          fixGitConfigCorruption(repoRoot);
          ctx.data.worktreePath = existingBranchWorktree;
          ctx.data._worktreeCreated = false;
          ctx.data._worktreeManaged = true;
          ensureManagedTaskWorktreeReady(repoRoot, existingBranchWorktree);
          await persistRecoveryEvent({
            outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
            worktreePath: existingBranchWorktree,
          });
          ctx.log(node.id, `Reusing existing branch worktree: ${existingBranchWorktree}`);
          const cleared2 = clearBlockedWorktreeIdentity(existingBranchWorktree);
          if (cleared2) ctx.log(node.id, `Cleared blocked test git identity from worktree: ${existingBranchWorktree}`);
          return {
            success: true,
            worktreePath: existingBranchWorktree,
            created: false,
            reused: true,
            reusedExistingBranch: true,
            branch,
            baseBranch,
          };
        }
      }
      try {
        execGitArgsSync(
          branchExistsLocally
            ? ["worktree", "add", worktreePath, branch]
            : ["worktree", "add", worktreePath, "-b", branch, baseBranch],
          { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
        );
        attachedExistingBranch = branchExistsLocally;
      } catch (createErr) {
        if (!isExistingBranchWorktreeError(createErr) && !isMissingRegisteredWorktreeError(createErr)) {
          throw new Error(`Worktree creation failed: ${formatExecSyncError(createErr)}`);
        }
        existingBranchWorktree = findExistingWorktreePathForBranch(repoRoot, branch);
        if (existingBranchWorktree && !existsSync(existingBranchWorktree)) {
          ctx.log(
            node.id,
            `Pruning stale registered worktree for branch ${branch}: ${existingBranchWorktree}`,
          );
          notePoisonedWorktree("attached-branch", existingBranchWorktree, ["missing_git_metadata"]);
          cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
        }
        if (existingBranchWorktree && existsSync(existingBranchWorktree)) {
          const existingWorktreeIsBroken = (
            !isValidGitWorktreePath(existingBranchWorktree) ||
            hasUnresolvedGitOperation(existingBranchWorktree)
          ) && isManagedBosunWorktree(existingBranchWorktree, repoRoot);
          if (existingWorktreeIsBroken) {
            ctx.log(
              node.id,
              `Existing branch worktree is invalid or unresolved, recreating managed path: ${existingBranchWorktree}`,
            );
            notePoisonedWorktree("attached-branch", existingBranchWorktree, [
              !isValidGitWorktreePath(existingBranchWorktree)
                ? "missing_git_metadata"
                : "unresolved_git_operation",
            ]);
            cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
          }
        }
        if (existingBranchWorktree && existsSync(existingBranchWorktree) &&
          isValidGitWorktreePath(existingBranchWorktree) &&
          !hasUnresolvedGitOperation(existingBranchWorktree)
        ) {
          const refreshResult = refreshManagedWorktreeReuse(
            node.id,
            ctx,
            repoRoot,
            existingBranchWorktree,
            baseBranch,
            baseBranchShort,
            fetchTimeout,
            { taskId, branch },
          );
          if (refreshResult?.repairArtifacts) {
            recoveryState.repairArtifacts = refreshResult.repairArtifacts;
          }
        }
        if (existingBranchWorktree && existsSync(existingBranchWorktree) &&
          isValidGitWorktreePath(existingBranchWorktree) &&
          !hasUnresolvedGitOperation(existingBranchWorktree)
        ) {
          fixGitConfigCorruption(repoRoot);
          ctx.data.worktreePath = existingBranchWorktree;
          ctx.data._worktreeCreated = false;
          ctx.data._worktreeManaged = true;
          ensureManagedTaskWorktreeReady(repoRoot, existingBranchWorktree);
          await persistRecoveryEvent({
            outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
            worktreePath: existingBranchWorktree,
          });
          ctx.log(node.id, `Reusing existing branch worktree: ${existingBranchWorktree}`);
          const cleared2 = clearBlockedWorktreeIdentity(existingBranchWorktree);
          if (cleared2) ctx.log(node.id, `Cleared blocked test git identity from worktree: ${existingBranchWorktree}`);
          return {
            success: true,
            worktreePath: existingBranchWorktree,
            created: false,
            reused: true,
            reusedExistingBranch: true,
            branch,
            baseBranch,
          };
        }
        // Branch already exists — attach worktree to existing branch.
        try {
          execGitArgsSync(
            ["worktree", "add", worktreePath, branch],
            { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
          );
          attachedExistingBranch = true;
        } catch (reuseErr) {
          if (isMissingRegisteredWorktreeError(reuseErr)) {
            ctx.log(
              node.id,
              `Pruning missing registered worktree before retry for branch ${branch}: ${worktreePath}`,
            );
            notePoisonedWorktree("attached-branch", worktreePath, ["missing_git_metadata"]);
            cleanupBrokenManagedWorktree(repoRoot, worktreePath);
            execGitArgsSync(
              ["worktree", "add", worktreePath, branch],
              { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
            );
            attachedExistingBranch = true;
          } else {
          const existingBranchWorktree = findExistingWorktreePathForBranch(repoRoot, branch);
          if (existingBranchWorktree && !existsSync(existingBranchWorktree)) {
            ctx.log(
              node.id,
              `Pruning stale registered worktree for branch ${branch}: ${existingBranchWorktree}`,
            );
            notePoisonedWorktree("attached-branch", existingBranchWorktree, ["missing_git_metadata"]);
            cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
          }
          if (existingBranchWorktree && existsSync(existingBranchWorktree)) {
            const existingWorktreeIsBroken = (
              !isValidGitWorktreePath(existingBranchWorktree) ||
              hasUnresolvedGitOperation(existingBranchWorktree)
            ) && isManagedBosunWorktree(existingBranchWorktree, repoRoot);
            if (existingWorktreeIsBroken) {
              ctx.log(
                node.id,
                `Existing branch worktree is invalid or unresolved, recreating managed path: ${existingBranchWorktree}`,
              );
              notePoisonedWorktree("attached-branch", existingBranchWorktree, [
                !isValidGitWorktreePath(existingBranchWorktree)
                  ? "missing_git_metadata"
                  : "unresolved_git_operation",
              ]);
              cleanupBrokenManagedWorktree(repoRoot, existingBranchWorktree);
            }
          }
          if (existingBranchWorktree && existsSync(existingBranchWorktree) &&
            isValidGitWorktreePath(existingBranchWorktree) &&
            !hasUnresolvedGitOperation(existingBranchWorktree)
          ) {
            const refreshResult = refreshManagedWorktreeReuse(
              node.id,
              ctx,
              repoRoot,
              existingBranchWorktree,
              baseBranch,
              baseBranchShort,
              fetchTimeout,
              { taskId, branch },
            );
            if (refreshResult?.repairArtifacts) {
              recoveryState.repairArtifacts = refreshResult.repairArtifacts;
            }
          }
          if (existingBranchWorktree && existsSync(existingBranchWorktree) &&
            isValidGitWorktreePath(existingBranchWorktree) &&
            !hasUnresolvedGitOperation(existingBranchWorktree)
          ) {
            fixGitConfigCorruption(repoRoot);
            ctx.data.worktreePath = existingBranchWorktree;
            ctx.data._worktreeCreated = false;
            ctx.data._worktreeManaged = true;
            ensureManagedTaskWorktreeReady(repoRoot, existingBranchWorktree);
            await persistRecoveryEvent({
              outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
              worktreePath: existingBranchWorktree,
            });
            ctx.log(node.id, `Reusing existing branch worktree: ${existingBranchWorktree}`);
            const cleared2 = clearBlockedWorktreeIdentity(existingBranchWorktree);
            if (cleared2) ctx.log(node.id, `Cleared blocked test git identity from worktree: ${existingBranchWorktree}`);
            return {
              success: true,
              worktreePath: existingBranchWorktree,
              created: false,
              reused: true,
              reusedExistingBranch: true,
              branch,
              baseBranch,
            };
          }
          throw new Error(
            `Worktree creation failed: ${formatExecSyncError(createErr)}; ` +
            `reuse failed: ${formatExecSyncError(reuseErr)}`,
          );
          }
        }
      }
      if (attachedExistingBranch) {
        const refreshResult = refreshManagedWorktreeReuse(
          node.id,
          ctx,
          repoRoot,
          worktreePath,
          baseBranch,
          baseBranchShort,
          fetchTimeout,
          { taskId, branch },
        );
        if (refreshResult?.repairArtifacts) {
          recoveryState.repairArtifacts = refreshResult.repairArtifacts;
        }
        if (!existsSync(worktreePath)) {
          notePoisonedWorktree("post-pull", worktreePath, ["refresh_conflict"]);
          throw new Error(
            `Worktree refresh failed for existing branch ${branch}; managed worktree was removed after stale refresh state`,
          );
        }
      }
      fixGitConfigCorruption(repoRoot);
      const cleared3 = clearBlockedWorktreeIdentity(worktreePath);
      if (cleared3) ctx.log(node.id, `Cleared blocked test git identity from worktree: ${worktreePath}`);

      ctx.data.worktreePath = worktreePath;
      ctx.data._worktreeCreated = true;
      ctx.data._worktreeManaged = true;
      ensureManagedTaskWorktreeReady(repoRoot, worktreePath);
      await persistRecoveryEvent({
        outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
        worktreePath,
      });
      ctx.log(node.id, `Worktree created: ${worktreePath} (branch: ${branch}, base: ${baseBranch})`);
      return { success: true, worktreePath, created: true, branch, baseBranch };
    } catch (err) {
      const classified = classifyAcquireWorktreeFailure(err);
      const {
        errorMessage,
        retryable,
        failureKind,
        blockedReason,
        detectedIssues,
        phase,
      } = classified;
      const recordedAt = new Date().toISOString();
      const autoRecoverDelayMs = retryable ? 0 : getNonRetryableWorktreeRecoveryMs();
      const retryAt = retryable ? null : new Date(Date.now() + autoRecoverDelayMs).toISOString();
      if (!retryable) {
        await recordWorktreeRecoveryEvent(repoRoot, {
          outcome: "recreation_failed",
          reason: "poisoned_worktree",
          phase,
          branch,
          taskId,
          worktreePath: resolve(
            repoRoot,
            ".bosun",
            "worktrees",
            deriveManagedWorktreeDirName(taskId, branch)
          ),
          detectedIssues,
          error: errorMessage,
        });
      }
      ctx.log(node.id, `Worktree acquisition failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        branch,
        baseBranch,
        retryable,
        failureKind,
        recordedAt,
        autoRecoverDelayMs,
        retryAt,
        blockedReason,
        repairArtifacts: retryable ? null : recoveryState.repairArtifacts,
        recoveryNote: retryable || !retryAt ? "" : ` — blocked until ${retryAt}`,
      };
    }
    } catch (outerErr) {
      // Outer catch: guard throws, cfgOrCtx errors, or any uncaught path.
      // Always return structured output so {{acquire-worktree.recoveryNote}} resolves.
      const errorMessage = String(outerErr?.message || outerErr || "acquire_worktree_outer_failure");
      ctx.log(node.id, `Worktree acquisition outer error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        branch: branch || "",
        baseBranch: baseBranch || "",
        retryable: true,
        failureKind: "acquire_outer_error",
        recordedAt: new Date().toISOString(),
        autoRecoverDelayMs: 0,
        retryAt: null,
        blockedReason: errorMessage,
        recoveryNote: "",
      };
    }
  },
});

// ==== action.recover_worktree ====

registerBuiltinNodeType("action.recover_worktree", {
  describe: () =>
    "Clean up a broken worktree so a fresh acquire can succeed. " +
    "Removes the directory, prunes git worktree list, and resets context data.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Path of the broken worktree" },
      branch: { type: "string", description: "Branch that was being used" },
      repoRoot: { type: "string", description: "Repository root" },
      taskId: { type: "string", description: "Owning task ID" },
    },
  },
  execute: async (_config, ctx) => {
    const worktreePath = cfgOrCtx(_config, ctx, "worktreePath") ||
      ctx.getNodeOutput("acquire-worktree")?.worktreePath || "";
    const branch = cfgOrCtx(_config, ctx, "branch") ||
      ctx.getNodeOutput("acquire-worktree")?.branch || "";
    const repoRoot = cfgOrCtx(_config, ctx, "repoRoot") ||
      ctx.getNodeOutput("acquire-worktree")?.repoRoot ||
      ctx.data?.repoRoot || process.cwd();
    const taskId = cfgOrCtx(_config, ctx, "taskId") ||
      ctx.getNodeOutput("acquire-worktree")?.taskId ||
      ctx.data?.taskId || "";

    const cleaned = [];
    try {
      // 1. Force-remove via git worktree remove
      if (worktreePath && existsSync(worktreePath)) {
        try {
          execSync(`git worktree remove --force "${worktreePath}"`, {
            cwd: repoRoot, timeout: 30000, stdio: "pipe",
          });
          cleaned.push("git-worktree-remove");
        } catch { /* may already be gone */ }
      }
      // 2. Remove the directory itself if still present
      if (worktreePath && existsSync(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        cleaned.push("rmSync-dir");
      }
      // 3. Resolve and remove the linked gitdir entry
      try {
        const gitdir = resolveGitDirForWorktree(worktreePath, repoRoot);
        if (gitdir && existsSync(gitdir)) {
          rmSync(gitdir, { recursive: true, force: true });
          cleaned.push("rmSync-gitdir");
        }
      } catch { /* best-effort */ }
      // 4. Prune stale worktree references
      try {
        execSync("git worktree prune", { cwd: repoRoot, timeout: 15000, stdio: "pipe" });
        cleaned.push("git-worktree-prune");
      } catch { /* best-effort */ }
      // 5. Fix any git config corruption left behind
      try {
        fixGitConfigCorruption(repoRoot);
        cleaned.push("fix-git-config");
      } catch { /* best-effort */ }
      // 6. Reset context data so retry starts fresh
      if (ctx.data) {
        delete ctx.data.worktreePath;
        delete ctx.data.worktreeDir;
        cleaned.push("ctx-data-reset");
      }

      return { success: true, cleaned, worktreePath, taskId, branch };
    } catch (err) {
      const errorMessage =
        String(err?.message || err || "recover_worktree_failed");
      return { success: false, error: errorMessage, cleaned, worktreePath, taskId, branch };
    }
  },
});

// ==== action.sweep_task_worktrees ====

registerBuiltinNodeType("action.sweep_task_worktrees", {
  describe: () =>
    "Sweep stale or orphan worktrees for a completed/failed task. " +
    "If taskId is given, only removes worktrees belonging to that task; " +
    "otherwise removes all managed worktrees older than maxAgeMs.",
  schema: {
    type: "object",
    properties: {
      repoRoot: { type: "string", description: "Repository root" },
      taskId: { type: "string", description: "Task ID whose worktrees to remove" },
      maxAgeMs: { type: "number", default: 43200000, description: "Max age in ms (default 12h)" },
    },
  },
  execute: async (_config, ctx) => {
    const repoRoot = cfgOrCtx(_config, ctx, "repoRoot") ||
      ctx.data?.repoRoot || process.cwd();
    const taskId = cfgOrCtx(_config, ctx, "taskId") ||
      ctx.data?.taskId || "";
    const maxAgeMs = Number(cfgOrCtx(_config, ctx, "maxAgeMs")) || 43200000;

    const { readdirSync, statSync } = await import("node:fs");
    const wtBase = resolve(repoRoot, ".bosun", "worktrees");
    const removed = [];
    const errors = [];
    let scanned = 0;

    if (!existsSync(wtBase)) {
      return { success: true, removed, scanned, errors, taskId };
    }

    const now = Date.now();
    for (const entry of readdirSync(wtBase)) {
      const entryPath = resolve(wtBase, entry);
      try {
        const st = statSync(entryPath);
        if (!st.isDirectory()) continue;
        scanned++;

        const belongsToTask = taskId && isManagedBosunWorktree(entryPath) &&
          entry.includes(taskId.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 30));
        const isStale = (now - st.mtimeMs) > maxAgeMs;

        if (belongsToTask || (!taskId && isStale)) {
          try {
            execSync(`git worktree remove --force "${entryPath}"`, {
              cwd: repoRoot, timeout: 30000, stdio: "pipe",
            });
          } catch { /* may not be registered */ }
          if (existsSync(entryPath)) {
            rmSync(entryPath, { recursive: true, force: true });
          }
          removed.push(entry);
        }
      } catch (err) {
        errors.push({ entry, error: String(err?.message || err) });
      }
    }

    // Prune any dangling references
    try {
      execSync("git worktree prune", { cwd: repoRoot, timeout: 15000, stdio: "pipe" });
    } catch { /* best-effort */ }

    return { success: true, removed, scanned, errors, taskId };
  },
});

// ==== action.release_worktree ====

registerBuiltinNodeType("action.release_worktree", {
  describe: () =>
    "Release a git worktree. Idempotent. Optionally prunes stale entries.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Worktree path to release" },
      repoRoot: { type: "string", description: "Repository root" },
      taskId: { type: "string", description: "Task ID (owner)" },
      prune: { type: "boolean", default: false, description: "Run git worktree prune" },
      removeTimeout: { type: "number", default: 30000, description: "Timeout for removal (ms)" },
    },
  },
  async execute(node, ctx, engine) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const shouldPrune = node.config?.prune === true;
    const removeTimeout = node.config?.removeTimeout ?? 30000;

    const isManaged =
      Boolean(ctx.data?._worktreeManaged) ||
      isManagedBosunWorktree(worktreePath, repoRoot);

    if (!worktreePath || !isManaged) {
      ctx.log(node.id, `No worktree to release for ${taskId || "(unknown)"}`);
      return { success: true, skipped: true, reason: "no_worktree" };
    }

    const transition = getReleaseTransitionState(ctx, "worktree", taskId || worktreePath);
    if (transition.completed) {
      return {
        ...(transition.result || { success: true, worktreePath, taskId, released: true }),
        replayed: true,
      };
    }

    try {
      if (existsSync(worktreePath)) {
        try {
          execGitArgsSync(["worktree", "remove", String(worktreePath), "--force"], {
            cwd: repoRoot, encoding: "utf8", timeout: removeTimeout,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          /* best-effort — directory might already be gone */
        }
      }

      if (shouldPrune) {
        try {
          execGitArgsSync(["worktree", "prune"], {
            cwd: repoRoot, encoding: "utf8", timeout: 15000,
          });
        } catch { /* best-effort */ }
      }

      fixGitConfigCorruption(repoRoot);

      ctx.data._worktreeCreated = false;
      ctx.data._worktreeManaged = false;
      ctx.log(node.id, `Worktree released: ${worktreePath}`);
      transition.completed = true;
      transition.result = {
        success: true,
        worktreePath,
        taskId,
        claimToken: ctx.data?._claimToken || null,
        instanceId: ctx.data?._claimInstanceId || null,
        released: true,
      };
      return transition.result;
    } catch (err) {
      ctx.log(node.id, `Worktree release warning: ${err.message}`);
      transition.completed = true;
      transition.result = {
        success: true,
        worktreePath,
        taskId,
        claimToken: ctx.data?._claimToken || null,
        instanceId: ctx.data?._claimInstanceId || null,
        warning: err.message,
      };
      return transition.result;
    }
  },
});

registerBuiltinNodeType("action.recover_worktree", {
  describe: () =>
    "Recover a failed task worktree by releasing any managed worktree for the task so acquisition can retry cleanly.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Worktree path to release if known" },
      repoRoot: { type: "string", description: "Repository root" },
      taskId: { type: "string", description: "Task ID (owner)" },
      prune: { type: "boolean", default: true, description: "Run git worktree prune after recovery" },
      removeTimeout: { type: "number", default: 30000, description: "Timeout for removal (ms)" },
    },
  },
  async execute(node, ctx, engine) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath") || ctx.data?.worktreePath || "";
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
    const taskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.taskId || "";
    const removeTimeout = Number(node.config?.removeTimeout ?? 30000);
    const shouldPrune = node.config?.prune !== false;

    const releaseNode = {
      ...node,
      config: {
        ...(node.config || {}),
        worktreePath,
        repoRoot,
        taskId,
        removeTimeout,
        prune: shouldPrune,
      },
    };
    const result = await getNodeType("action.release_worktree")?.execute?.(releaseNode, ctx);
    const sweepResult = await getNodeType("action.sweep_task_worktrees")?.execute?.(
      {
        id: `${node.id}:sweep`,
        type: "action.sweep_task_worktrees",
        config: {
          repoRoot,
          taskId,
          timeout: removeTimeout,
        },
      },
      ctx,
      engine,
    );
    let pruneResult = null;
    if (shouldPrune) {
      try {
        pruneResult = await pruneStaleWorktrees(repoRoot);
      } catch (err) {
        ctx.log(node.id, `Worktree prune warning: ${err?.message || err}`);
      }
    }
    ctx.data.worktreePath = "";
    return {
      success: result?.success !== false,
      recovered: true,
      worktreePath,
      released: result?.released === true,
      skipped: result?.skipped === true,
      removedWorktrees: Array.isArray(sweepResult?.removed) ? sweepResult.removed : [],
      prunedOrphans: Number(pruneResult?.pruned || 0),
      warning: result?.warning,
    };
  },
});

registerBuiltinNodeType("action.sweep_task_worktrees", {
  describe: () =>
    "Sweep managed task worktrees for a task by removing matching .bosun/worktrees entries and pruning git metadata.",
  schema: {
    type: "object",
    properties: {
      repoRoot: { type: "string", description: "Repository root" },
      taskId: { type: "string", description: "Task ID (owner)" },
      maxAgeMs: { type: "number", default: 43200000, description: "Fallback max age in ms when taskId is omitted" },
      timeout: { type: "number", default: 15000, description: "Timeout for git worktree prune (ms)" },
    },
  },
  async execute(node, ctx, engine) {
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
    const taskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.taskId || "";
    const maxAgeMs = Number(node.config?.maxAgeMs ?? 43200000);
    const timeout = Number(node.config?.timeout ?? 15000);
    const managedRoot = resolve(repoRoot, ".bosun", "worktrees");
    const removed = [];
    const errors = [];
    let scanned = 0;

    try {
      if (existsSync(managedRoot)) {
        const entries = readdirSync(managedRoot);
        const taskToken = taskId ? deriveManagedTaskToken(taskId) : "";
        const now = Date.now();
        for (const entry of entries) {
          const entryPath = resolve(managedRoot, entry);
          if (!existsSync(entryPath)) continue;
          try {
            const stats = statSync(entryPath);
            if (!stats.isDirectory()) continue;
            scanned += 1;
            const matchesTask = taskToken && entry.includes(taskToken);
            const isStale = !taskToken && Number.isFinite(stats.mtimeMs)
              ? now - stats.mtimeMs > maxAgeMs
              : false;
            if (!matchesTask && !isStale) continue;
            try {
              execGitArgsSync(["worktree", "remove", String(entryPath), "--force"], {
                cwd: repoRoot,
                encoding: "utf8",
                timeout,
                stdio: ["ignore", "pipe", "pipe"],
              });
            } catch {
              // Orphaned directories may no longer be registered; fall back to rmSync below.
            }
            if (existsSync(entryPath)) {
              rmSync(entryPath, { recursive: true, force: true });
            }
            removed.push(entry);
          } catch (err) {
            errors.push({ entry, error: String(err?.message || err) });
          }
        }
      }
    } catch (err) {
      errors.push({ entry: managedRoot, error: String(err?.message || err) });
    }

    try {
      execGitArgsSync(["worktree", "prune"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });
      fixGitConfigCorruption(repoRoot);
      ctx.log(
        node.id,
        `Swept task worktrees for ${taskId || "(unknown task)"}: removed=${removed.length}, scanned=${scanned}`,
      );
      return { success: true, taskId, swept: true, removed, scanned, errors };
    } catch (err) {
      ctx.log(node.id, `Task worktree sweep warning: ${err.message}`);
      return { success: true, taskId, swept: false, removed, scanned, errors, warning: err.message };
    }
  },
});
const readWorkflowContractHandler = {
  describe: () =>
    "Read a project WORKFLOW.md runtime contract and stage it for session-start prompt injection.",
  schema: {
    type: "object",
    properties: {
      projectRoot: { type: "string", description: "Project root containing WORKFLOW.md" },
      repoRoot: { type: "string", description: "Fallback project root" },
      worktreePath: { type: "string", description: "Active project worktree path" },
      outputVariable: { type: "string", description: "Optional ctx.data key for the loaded contract" },
      logPreviewChars: {
        type: "number",
        default: 1200,
        description: "Maximum contract characters to include in the workflow log",
      },
    },
  },
  async execute(node, ctx, engine) {
    const projectRoot = cfgOrCtx(node, ctx, "projectRoot")
      || cfgOrCtx(node, ctx, "worktreePath")
      || cfgOrCtx(node, ctx, "repoRoot")
      || process.cwd();
    const outputVariable = cfgOrCtx(node, ctx, "outputVariable") || "_workflowContract";
    const logPreviewChars = Number(cfgOrCtx(node, ctx, "logPreviewChars") || 1200);
    const contract = loadWorkflowContract(projectRoot, { useCache: false });

    ctx.data._workflowContractProjectRoot = projectRoot;
    ctx.data._workflowContractPath = contract.path || "";
    ctx.data._workflowContract = contract;

    if (outputVariable) {
      ctx.data[outputVariable] = contract;
    }

    if (!contract.exists) {
      ctx.data._workflowContractPromptBlock = "";
      ctx.log(node.id, "No WORKFLOW.md detected at " + contract.path);
      return {
        success: true,
        found: false,
        skipped: true,
        projectRoot,
        path: contract.path,
      };
    }

    const promptBlock = buildWorkflowContractPromptBlock(contract);
    ctx.data._workflowContractPromptBlock = promptBlock;
    const preview = promptBlock.length > logPreviewChars
      ? promptBlock.slice(0, logPreviewChars) + "…"
      : promptBlock;
    ctx.log(node.id, "Injected WORKFLOW.md contract into session context:\n" + preview);

    return {
      success: true,
      found: true,
      skipped: false,
      projectRoot,
      path: contract.path,
      contract,
      promptBlock,
    };
  },
};

registerNodeType("read-workflow-contract", readWorkflowContractHandler);
registerNodeType("action.read_workflow_contract", readWorkflowContractHandler);

const workflowContractValidationHandler = {
  describe: () =>
    "Validate required WORKFLOW.md contract fields before session work begins.",
  schema: {
    type: "object",
    properties: {
      projectRoot: { type: "string", description: "Project root containing WORKFLOW.md" },
      contractVariable: {
        type: "string",
        description: "ctx.data key containing a previously loaded contract object",
      },
      failOnInvalid: {
        type: "boolean",
        default: true,
        description: "Throw when required WORKFLOW.md fields are missing",
      },
    },
  },
  async execute(node, ctx, engine) {
    const projectRoot = cfgOrCtx(node, ctx, "projectRoot")
      || cfgOrCtx(node, ctx, "worktreePath")
      || cfgOrCtx(node, ctx, "repoRoot")
      || ctx.data?._workflowContractProjectRoot
      || process.cwd();
    const contractVariable = cfgOrCtx(node, ctx, "contractVariable") || "_workflowContract";
    const failOnInvalid = node.config?.failOnInvalid !== false;
    const loadedContract =
      ctx.data?.[contractVariable] && typeof ctx.data[contractVariable] === "object"
        ? ctx.data[contractVariable]
        : loadWorkflowContract(projectRoot, { useCache: false });
    const validation = validateWorkflowContract(loadedContract);

    ctx.data._workflowContractValidation = validation;

    if (!loadedContract.exists) {
      ctx.log(node.id, "No WORKFLOW.md found — skipping contract validation");
      return {
        success: true,
        skipped: true,
        found: false,
        valid: true,
        contract: loadedContract,
        errors: [],
      };
    }

    if (!validation.valid) {
      const detail = validation.errors.map((entry) => entry.message).join(" ");
      const message = "WORKFLOW.md contract validation failed for " + loadedContract.path + ". " + detail;
      ctx.log(node.id, message, "error");
      if (failOnInvalid) {
        throw new Error(message);
      }
      return {
        success: false,
        skipped: false,
        found: true,
        valid: false,
        contract: loadedContract,
        errors: validation.errors,
      };
    }

    ctx.log(
      node.id,
      "Validated WORKFLOW.md contract: terminalStates=[" + validation.contract.terminalStates.join(", ") + "], forbiddenPatterns=" + validation.contract.forbiddenPatterns.length,
    );
    return {
      success: true,
      skipped: false,
      found: true,
      valid: true,
      contract: validation.contract,
      errors: [],
    };
  },
};

registerNodeType("workflow-contract-validation", workflowContractValidationHandler);
registerNodeType("action.workflow_contract_validation", workflowContractValidationHandler);

// ==== action.build_task_prompt ====

registerBuiltinNodeType("action.build_task_prompt", {
  describe: () =>
    "Compose the full agent prompt from task data, AGENTS.md, comments, " +
    "copilot-instructions.md, agent status endpoint, and co-author trailer.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      taskTitle: { type: "string" },
      taskDescription: { type: "string" },
      taskUrl: { type: "string" },
      branch: { type: "string" },
      baseBranch: { type: "string" },
      worktreePath: { type: "string" },
      repoRoot: { type: "string" },
      repoSlug: { type: "string" },
      workspace: { type: "string" },
      repository: { type: "string" },
      repositories: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
      },
      retryReason: { type: "string", description: "Reason for retry (if retrying)" },
      includeAgentsMd: { type: "boolean", default: true },
      includeComments: { type: "boolean", default: true },
      includeGitContext: { type: "boolean", default: true },
      includeStatusEndpoint: { type: "boolean", default: true },
      includeMemory: { type: "boolean", default: true },
      teamId: { type: "string" },
      workspaceId: { type: "string" },
      sessionId: { type: "string" },
      runId: { type: "string" },
      promptTemplate: { type: "string", description: "Custom template (overrides)" },
    },
    required: ["taskTitle"],
  },
  async execute(node, ctx, engine) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const taskTitle = cfgOrCtx(node, ctx, "taskTitle");
    const taskDescription = cfgOrCtx(node, ctx, "taskDescription");
    const branch = cfgOrCtx(node, ctx, "branch");
    const baseBranch = cfgOrCtx(node, ctx, "baseBranch");
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
    const repoSlug = cfgOrCtx(node, ctx, "repoSlug");
    const retryReason = cfgOrCtx(node, ctx, "retryReason");
    const includeAgentsMd = node.config?.includeAgentsMd !== false;
    const includeComments = node.config?.includeComments !== false;
    const includeGitContext = node.config?.includeGitContext !== false;
    const includeStatusEndpoint = node.config?.includeStatusEndpoint !== false;
    const includeMemory = node.config?.includeMemory !== false;
    ctx.data._taskIncludeContext = includeComments;
    const customTemplate = cfgOrCtx(node, ctx, "promptTemplate");
    const workflowIssueAdvisor =
      ctx.data?._issueAdvisor && typeof ctx.data._issueAdvisor === "object"
        ? ctx.data._issueAdvisor
        : null;
    const workflowDagStateSummary =
      ctx.data?._plannerFeedback?.dagStateSummary && typeof ctx.data._plannerFeedback.dagStateSummary === "object"
        ? ctx.data._plannerFeedback.dagStateSummary
        : null;
    const taskPayload =
      ctx.data?.task && typeof ctx.data.task === "object"
        ? ctx.data.task
        : null;
    const taskMeta =
      taskPayload?.meta && typeof taskPayload.meta === "object"
        ? taskPayload.meta
        : null;

    const TASK_TEMPLATE_PLACEHOLDER_RE = /^\{\{\s*[\w.-]+\s*\}\}$/;
    const TASK_TEMPLATE_INLINE_PLACEHOLDER_RE = /\{\{\s*[\w.-]+\s*\}\}/g;
    const TASK_PROMPT_INVALID_VALUES = new Set([
      "internal server error",
      "{\"ok\":false,\"error\":\"internal server error\"}",
      "{\"error\":\"internal server error\"}",
    ]);
    const normalizeString = (value) => {
      if (value == null) return "";
      const text = String(value).trim();
      if (!text) return "";
      if (TASK_TEMPLATE_PLACEHOLDER_RE.test(text)) return "";
      const sanitized = text
        .replace(TASK_TEMPLATE_INLINE_PLACEHOLDER_RE, " ")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (!sanitized) return "";
      if (TASK_PROMPT_INVALID_VALUES.has(sanitized.toLowerCase())) return "";
      return sanitized;
    };
    const pickFirstString = (...values) => {
      for (const value of values) {
        const normalized = normalizeString(value);
        if (normalized) return normalized;
      }
      return "";
    };
    const appendUniqueString = (store, seen, value) => {
      const normalized = normalizeString(value);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      store.push(normalized);
    };
    const normalizeStringArray = (...values) => {
      const out = [];
      const seen = new Set();
      for (const value of values) {
        if (Array.isArray(value)) {
          for (const item of value) appendUniqueString(out, seen, item);
          continue;
        }
        if (typeof value === "string") {
          if (value.includes(",")) {
            for (const item of value.split(",")) appendUniqueString(out, seen, item);
          } else {
            appendUniqueString(out, seen, value);
          }
          continue;
        }
      }
      return out;
    };
    const resolvePromptValue = (key) => {
      if (Object.prototype.hasOwnProperty.call(node.config || {}, key)) {
        const resolved = ctx.resolve(node.config[key]);
        if (resolved != null && resolved !== "") return resolved;
      }
      const ctxValue = ctx.data?.[key];
      if (ctxValue != null && ctxValue !== "") return ctxValue;
      return null;
    };
    const normalizedTaskId = pickFirstString(
      resolvePromptValue("taskId"),
      taskPayload?.id,
      taskPayload?.taskId,
      taskMeta?.taskId,
      taskId,
    );
    const resolvedTaskTitle = pickFirstString(
      resolvePromptValue("taskTitle"),
      taskPayload?.title,
      taskMeta?.taskTitle,
      taskTitle,
    );
    const normalizedTaskTitle =
      resolvedTaskTitle && resolvedTaskTitle.toLowerCase() !== "untitled task"
        ? resolvedTaskTitle
        : normalizedTaskId
          ? `Task ${normalizedTaskId}`
          : "Untitled task";
    const normalizedTaskDescription = pickFirstString(
      resolvePromptValue("taskDescription"),
      taskPayload?.description,
      taskPayload?.body,
      taskMeta?.taskDescription,
      taskDescription,
    );
    const normalizedTaskUrl = pickFirstString(
      resolvePromptValue("taskUrl"),
      taskPayload?.taskUrl,
      taskPayload?.url,
      taskMeta?.taskUrl,
      taskMeta?.task_url,
      taskMeta?.url,
      ctx.data?.taskUrl,
    );
    const normalizedBranch = normalizeString(branch);
    const normalizedBaseBranch = normalizeString(baseBranch);
    const normalizedWorktreePath = normalizeString(worktreePath);
    const normalizedRepoRoot = normalizeString(repoRoot) || process.cwd();
    const normalizedRepoSlug = normalizeString(repoSlug);
    const normalizedRetryReason = normalizeString(retryReason);
    const workspace = pickFirstString(
      resolvePromptValue("workspace"),
      taskPayload?.workspace,
      taskMeta?.workspace,
    );
    const repository = pickFirstString(
      resolvePromptValue("repository"),
      taskPayload?.repository,
      taskPayload?.repo,
      taskMeta?.repository,
    );
    const repositories = normalizeStringArray(
      resolvePromptValue("repositories"),
      taskPayload?.repositories,
      taskMeta?.repositories,
    );
    const primaryRepository = pickFirstString(repository, normalizedRepoSlug);
    const allowedRepositories = normalizeStringArray(repositories, primaryRepository);
    const memoryTeamId = pickFirstString(
      resolvePromptValue("teamId"),
      taskPayload?.teamId,
      taskMeta?.teamId,
      process.env.BOSUN_TEAM_ID,
      process.env.BOSUN_TEAM,
      normalizedRepoSlug,
    );
    const memoryWorkspaceId = pickFirstString(
      resolvePromptValue("workspaceId"),
      taskPayload?.workspaceId,
      taskMeta?.workspaceId,
      workspace,
      ctx.data?._workspaceId,
      process.env.BOSUN_WORKSPACE_ID,
      process.env.BOSUN_WORKSPACE,
    );
    const memorySessionId = pickFirstString(
      resolvePromptValue("sessionId"),
      taskPayload?.sessionId,
      taskMeta?.sessionId,
      ctx.data?.sessionId,
      process.env.BOSUN_SESSION_ID,
    );
    const memoryRunId = pickFirstString(
      resolvePromptValue("runId"),
      taskPayload?.runId,
      taskMeta?.runId,
      ctx.data?.runId,
      ctx.id,
      ctx.id,
      process.env.BOSUN_RUN_ID,
    );
    const matchedSkills = findRelevantSkills(
      normalizedRepoRoot,
      normalizedTaskTitle,
      normalizedTaskDescription || "",
      {},
    );
    const activeSkillFiles = matchedSkills.map((skill) => skill.filename);
    const strictCacheAnchoring = isStrictCacheAnchorMode();
    const customTemplateValues = {
      taskId: normalizedTaskId,
      taskTitle: normalizedTaskTitle,
      taskDescription: normalizedTaskDescription,
      taskUrl: normalizedTaskUrl,
      branch: normalizedBranch,
      baseBranch: normalizedBaseBranch,
      worktreePath: normalizedWorktreePath,
      repoRoot: normalizedRepoRoot,
      repoSlug: normalizedRepoSlug,
      workspace,
      repository: primaryRepository,
      repositories: allowedRepositories.join(", "),
      retryReason: normalizedRetryReason,
    };
    const renderCustomTemplate = (template) => {
      const lookup = new Map();
      const register = (key, value) => {
        const normalizedKey = String(key || "").trim();
        if (!normalizedKey) return;
        const normalizedValue = normalizeString(value);
        lookup.set(normalizedKey, normalizedValue);
        lookup.set(normalizedKey.toLowerCase(), normalizedValue);
        lookup.set(normalizedKey.toUpperCase(), normalizedValue);
      };
      for (const [key, value] of Object.entries(customTemplateValues)) {
        register(key, value);
        register(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"), value);
      }
      return String(template || "")
        .replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_full, key) => {
          const lookupKey = String(key || "").trim();
          if (!lookupKey) return "";
          if (lookup.has(lookupKey)) return lookup.get(lookupKey);
          if (lookup.has(lookupKey.toLowerCase())) return lookup.get(lookupKey.toLowerCase());
          if (lookup.has(lookupKey.toUpperCase())) return lookup.get(lookupKey.toUpperCase());
          return "";
        })
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    };

    const buildStableSystemPrompt = () =>
      [
        "# Bosun Agent Persona",
        "You are an autonomous AI coding agent operating inside Bosun.",
        "Follow the task details and project instructions provided in the user message.",
        "Be concise, rigorous, and complete tasks end-to-end with verified results.",
      ].join("\n");

    const stripPromptMemorySection = (content, docName) => {
      const text = String(content || "");
      if (!text) return "";
      if (!/AGENTS\.md$/i.test(String(docName || ""))) return text;
      const learningsHeaderRe = /^## Agent Learnings\s*$/im;
      const sectionMatch = learningsHeaderRe.exec(text);
      if (!sectionMatch) return text;
      const sectionStart = sectionMatch.index;
      const headerLength = sectionMatch[0].length;
      const before = text.slice(0, sectionStart).trimEnd();
      const afterSection = text.slice(sectionStart + headerLength);
      const nextSectionMatch = /^##\s+/m.exec(afterSection);
      if (!nextSectionMatch) return before;
      const afterIndex = sectionStart + headerLength + nextSectionMatch.index;
      return `${before}\n\n${text.slice(afterIndex).trimStart()}`.trim();
    };

    const cacheAnchorMarkers = collectCacheAnchorMarkers(
      {
        taskId: normalizedTaskId,
        taskTitle: normalizedTaskTitle,
        taskDescription: normalizedTaskDescription,
        retryReason: normalizedRetryReason,
        branch: normalizedBranch,
        baseBranch: normalizedBaseBranch,
        worktreePath: normalizedWorktreePath,
      },
      TASK_PROMPT_ANCHOR_HEADERS,
    );

    const buildGitContextBlock = async () => {
      if (!includeGitContext) return "";
      const root = normalizedWorktreePath || normalizedRepoRoot;
      if (!root) return "";
      if (!existsSync(resolve(root, ".git"))) return "";

      try {
        const diffStatsMod = await ensureDiffStatsMod();
        const commits =
          diffStatsMod.getRecentCommits?.(root, 8) || [];
        let diffSummary =
          diffStatsMod.getCompactDiffSummary?.(root, {
            baseBranch: normalizedBaseBranch || "origin/main",
          }) || "";

        if (diffSummary && diffSummary.length > 2000) {
          diffSummary = `${diffSummary.slice(0, 2000)}…`;
        }

        const lines = ["## Git Context"];
        if (Array.isArray(commits) && commits.length > 0) {
          lines.push("### Recent Commits");
          for (const commit of commits) lines.push(`- ${commit}`);
        }
        if (diffSummary && diffSummary !== "(no diff stats available)") {
          lines.push("### Diff Summary");
          lines.push("```");
          lines.push(diffSummary);
          lines.push("```");
        }
        return lines.length > 1 ? lines.join("\n") : "";
      } catch {
        return "";
      }
    };

    if (customTemplate) {
      const renderedTemplate = renderCustomTemplate(customTemplate);
      const stableSystemPrompt = buildStableSystemPrompt();
      assertCacheAnchorSystemPrompt(stableSystemPrompt, cacheAnchorMarkers, strictCacheAnchoring);
      ctx.data._taskPrompt = renderedTemplate;
      ctx.data._taskUserPrompt = renderedTemplate;
      ctx.data._taskSystemPrompt = stableSystemPrompt;
      ctx.log(node.id, `Prompt from custom template (${renderedTemplate.length} chars)`);
      return {
        success: true,
        prompt: renderedTemplate,
        userPrompt: renderedTemplate,
        systemPrompt: stableSystemPrompt,
        source: "custom",
      };
    }

    const userParts = [];

    // Header
    userParts.push(`# Task: ${normalizedTaskTitle}`);
    if (normalizedTaskId) userParts.push(`Task ID: ${normalizedTaskId}`);
    userParts.push("");

    // Retry context (if applicable)
    if (normalizedRetryReason) {
      userParts.push("## Retry Context");
      userParts.push(`Previous attempt failed: ${normalizedRetryReason}`);
      userParts.push("Try a different approach this time.");
      userParts.push("");
    }

    // Description
    if (normalizedTaskDescription) {
      userParts.push("## Description");
      userParts.push(normalizedTaskDescription);
      userParts.push("");
    }

    if (normalizedTaskUrl) {
      userParts.push("## Task Reference");
      userParts.push(normalizedTaskUrl);
      userParts.push("");
    }

    if (workflowIssueAdvisor || workflowDagStateSummary) {
      userParts.push("## Workflow Continuation Context");
      if (workflowIssueAdvisor?.recommendedAction) userParts.push(`- **Issue Advisor Action:** ${workflowIssueAdvisor.recommendedAction}`);
      if (workflowIssueAdvisor?.summary) userParts.push(`- **Issue Advisor Summary:** ${workflowIssueAdvisor.summary}`);
      if (workflowIssueAdvisor?.nextStepGuidance) userParts.push(`- **Next-Step Guidance:** ${workflowIssueAdvisor.nextStepGuidance}`);
      if (workflowDagStateSummary?.counts) {
        userParts.push(`- **DAG Counts:** completed=${Number(workflowDagStateSummary.counts.completed ?? 0) || 0}, failed=${Number(workflowDagStateSummary.counts.failed ?? 0) || 0}, pending=${Number(workflowDagStateSummary.counts.pending ?? 0) || 0}`);
      }
      if (workflowDagStateSummary?.revisionCount !== undefined) userParts.push(`- **DAG Revisions:** ${workflowDagStateSummary.revisionCount}`);
      userParts.push("");
    }

    if (includeComments) {
      const taskContextBlock = buildTaskContextBlock(taskPayload);
      if (taskContextBlock) {
        userParts.push(taskContextBlock);
        userParts.push("");
        ctx.data._taskPromptIncludesTaskContext = true;
      }
    }

    const gitContextBlock = await buildGitContextBlock();
    if (gitContextBlock) {
      userParts.push(gitContextBlock);
      userParts.push("");
    }

    // Environment context
    userParts.push("## Environment");
    const envLines = [];
    if (normalizedWorktreePath) envLines.push(`- **Working Directory:** ${normalizedWorktreePath}`);
    if (normalizedBranch) envLines.push(`- **Branch:** ${normalizedBranch}`);
    if (normalizedBaseBranch) envLines.push(`- **Base Branch:** ${normalizedBaseBranch}`);
    if (normalizedRepoSlug) envLines.push(`- **Repository:** ${normalizedRepoSlug}`);
    if (normalizedRepoRoot) envLines.push(`- **Repo Root:** ${normalizedRepoRoot}`);
    if (envLines.length) userParts.push(envLines.join("\n"));
    userParts.push("");

    // Workspace and repository scope guardrails.
    userParts.push("## Workspace Scope Contract");
    if (workspace) userParts.push(`- **Workspace:** ${workspace}`);
    if (primaryRepository) userParts.push(`- **Primary Repository:** ${primaryRepository}`);
    if (allowedRepositories.length > 0) {
      userParts.push("- **Allowed Repositories:**");
      for (const allowedRepo of allowedRepositories) {
        userParts.push(`  - ${allowedRepo}`);
      }
    } else {
      userParts.push("- **Allowed Repositories:** (not declared)");
    }
    if (normalizedWorktreePath) userParts.push(`- **Write Scope Root:** ${normalizedWorktreePath}`);
    userParts.push("");
    userParts.push("Hard boundaries:");
    if (normalizedWorktreePath) {
      userParts.push(`1. Modify files only inside \`${normalizedWorktreePath}\`.`);
    } else {
      userParts.push("1. Modify files only inside the active repository working directory.");
    }
    userParts.push("2. Modify code only in the allowed repositories listed above.");
    userParts.push("3. If required work depends on an unlisted repository, stop and report `blocked: cross-repo dependency`.");
    userParts.push("4. In completion notes, list every repository you touched and why.");
    userParts.push("");

    let workflowContractPromptBlock = String(ctx.data?._workflowContractPromptBlock || "").trim();
    if (!workflowContractPromptBlock) {
      const workflowContract = ctx.data?._workflowContract;
      if (workflowContract?.raw && workflowContract?.found) {
        const sourcePath = workflowContract.path || "WORKFLOW.md";
        workflowContractPromptBlock = [
          "## WORKFLOW.md Contract",
          `- **Source:** ${sourcePath}`,
          "- **Behavior:** Treat this file as a project-specific runtime contract.",
          "",
          String(workflowContract.raw).trim(),
        ].join("\n").trim();
      } else if (workflowContract?.exists && workflowContract?.content) {
        workflowContractPromptBlock = buildWorkflowContractPromptBlock(workflowContract);
      }
    }
    if (workflowContractPromptBlock) {
      userParts.push(workflowContractPromptBlock);
      userParts.push("");
    }

    // AGENTS.md + copilot-instructions.md
    if (includeAgentsMd) {
      const searchDirs = [normalizedWorktreePath || normalizedRepoRoot, normalizedRepoRoot].filter(Boolean);
      const docFiles = ["AGENTS.md", ".github/copilot-instructions.md"];
      const loaded = new Set();
      const markdownSafetyPolicy = getRepoMarkdownSafetyPolicy(normalizedRepoRoot);
      for (const dir of searchDirs) {
        for (const doc of docFiles) {
          const fullPath = resolve(dir, doc);
          if (loaded.has(doc)) continue;
          try {
            if (existsSync(fullPath)) {
              const content = stripPromptMemorySection(
                readFileSync(fullPath, "utf8"),
                doc,
              ).trim();
              if (content && content.length > 10) {
                const decision = evaluateMarkdownSafety(
                  content,
                  {
                    channel: "task-prompt-context",
                    sourceKind: "documentation",
                    sourcePath: doc,
                    sourceRoot: normalizedRepoRoot,
                    documentationContext: true,
                  },
                  markdownSafetyPolicy,
                );
                if (decision.blocked) {
                  ctx.log(
                    node.id,
                    `Skipped unsafe prompt context from ${doc}: ${decision.safety.reasons.join(", ")}`,
                  );
                  recordMarkdownSafetyAuditEvent(
                    {
                      channel: "task-prompt-context",
                      sourceKind: "documentation",
                      sourcePath: doc,
                      reasons: decision.safety.reasons,
                      score: decision.safety.score,
                      findings: decision.safety.findings,
                    },
                    { policy: markdownSafetyPolicy, rootDir: normalizedRepoRoot },
                  );
                  continue;
                }
                loaded.add(doc);
                userParts.push(`## ${doc}`);
                userParts.push(content);
                userParts.push("");
              }
            }
          } catch { /* best-effort */ }
        }
      }
    }

    if (includeMemory) {
      try {
        const retrievedMemory = await retrieveKnowledgeEntries({
          repoRoot: normalizedRepoRoot,
          teamId: memoryTeamId,
          workspaceId: memoryWorkspaceId,
          sessionId: memorySessionId,
          runId: memoryRunId,
          taskId: normalizedTaskId,
          taskTitle: normalizedTaskTitle,
          taskDescription: normalizedTaskDescription,
          query: [
            normalizedTaskTitle,
            normalizedTaskDescription,
            normalizedRetryReason,
          ]
            .filter(Boolean)
            .join(" "),
          limit: 4,
        });
        const memoryBriefing = formatKnowledgeBriefing(retrievedMemory, {
          maxEntries: 4,
        });
        if (memoryBriefing) {
          userParts.push(memoryBriefing);
          userParts.push("");
          ctx.data._taskRetrievedMemory = retrievedMemory;
        }
      } catch (err) {
        ctx.log(node.id, `Persistent memory retrieval failed (non-fatal): ${err.message}`);
      }
    }

    // Agent status endpoint
    if (includeStatusEndpoint) {
      const port = process.env.AGENT_ENDPOINT_PORT || process.env.BOSUN_AGENT_ENDPOINT_PORT || "";
      if (port) {
        userParts.push("## Agent Status Endpoint");
        userParts.push(`POST http://127.0.0.1:${port}/status — Report progress`);
        userParts.push(`POST http://127.0.0.1:${port}/heartbeat — Heartbeat ping`);
        userParts.push(`POST http://127.0.0.1:${port}/error — Report errors`);
        userParts.push(`POST http://127.0.0.1:${port}/complete — Signal completion`);
        userParts.push("");
      }
    }

    userParts.push("## Tool Discovery");
    userParts.push(
      "Bosun uses a compact MCP discovery layer for external MCP servers and the custom tool library.",
    );
    userParts.push(
      "Preferred flow: `search` -> `get_schema` -> `execute`.",
    );
    userParts.push(
      "Only eager tools are preloaded below to keep context small. Use `call_discovered_tool` only as a direct fallback when orchestration code is unnecessary.",
    );
    userParts.push("");

    // Skill-driven eager tools belong with task context to preserve cache anchoring.
    const taskScopedEagerTools = getToolsPromptBlock(normalizedRepoRoot, {
      activeSkills: activeSkillFiles,
      includeBuiltins: true,
      eagerOnly: true,
      discoveryMode: true,
      emitReflectHint: true,
      limit: 12,
    });
    if (taskScopedEagerTools) {
      userParts.push(taskScopedEagerTools);
      userParts.push("");
    }

    const relevantSkillsBlock = buildRelevantSkillsPromptBlock(
      normalizedRepoRoot,
      normalizedTaskTitle,
      normalizedTaskDescription || "",
      {},
    );
    if (relevantSkillsBlock) {
      userParts.push(relevantSkillsBlock);
      userParts.push("");
    }

    // Inject library-resolved skills from agent.select_profile.
    // These are skills assigned to the matched agent profile or scored by
    // the library resolver's buildSkillSelection — distinct from the
    // filesystem-based .bosun/skills/ resolved above.
    const librarySkillIds = Array.isArray(ctx.data?.resolvedSkillIds) ? ctx.data.resolvedSkillIds : [];
    if (librarySkillIds.length > 0) {
      try {
        const library = await ensureLibraryManagerMod();
        const libraryRoot = normalizedRepoRoot || process.cwd();
        const fsSkillNames = new Set(matchedSkills.map((s) => String(s.filename || "").replace(/\.md$/i, "").toLowerCase()));
        const librarySkillParts = [];
        for (const skillId of librarySkillIds) {
          if (fsSkillNames.has(skillId.toLowerCase())) continue;
          const entry = library.getEntry?.(libraryRoot, skillId);
          if (!entry) continue;
          const content = library.getEntryContent?.(libraryRoot, entry);
          if (!content || (typeof content === "string" && !content.trim())) continue;
          const body = typeof content === "string" ? content.trim() : JSON.stringify(content, null, 2);
          emitSkillInvokeEvent(skillId, entry.name || skillId, {
            taskId: normalizedTaskId,
            executor: ctx.data?.resolvedSdk,
            source: "library",
          });
          librarySkillParts.push(`### Skill: ${entry.name || skillId} (\`${skillId}\`)`);
          librarySkillParts.push(body);
          librarySkillParts.push("");
        }
        if (librarySkillParts.length > 0) {
          userParts.push("## Library Skills");
          userParts.push(...librarySkillParts);
        }
      } catch (err) {
        ctx.log(node.id, `Library skill injection failed (non-fatal): ${err.message}`);
      }
    }

    const coAuthorTrailer = shouldAddBosunCoAuthor({ taskId: normalizedTaskId })
      ? getBosunCoAuthorTrailer()
      : "";
    if (coAuthorTrailer) {
      userParts.push("## Git Attribution");
      userParts.push("Add this trailer to all commits:");
      userParts.push(coAuthorTrailer);
      userParts.push("");
    }

    const userPrompt = userParts.join("\n").trim();
    const systemPrompt = buildStableSystemPrompt();
    assertCacheAnchorSystemPrompt(systemPrompt, cacheAnchorMarkers, strictCacheAnchoring);

    ctx.data._taskPrompt = userPrompt;
    ctx.data._taskUserPrompt = userPrompt;
    ctx.data._taskSystemPrompt = systemPrompt;
    ctx.log(
      node.id,
      `Prompt built (user=${userPrompt.length} chars, system=${systemPrompt.length} chars, strict=${strictCacheAnchoring})`,
    );
    return {
      success: true,
      prompt: userPrompt,
      userPrompt,
      systemPrompt,
      source: "generated",
      length: userPrompt.length,
      systemLength: systemPrompt.length,
      cacheAnchorMode: strictCacheAnchoring ? "strict" : "default",
    };
  },
});


registerBuiltinNodeType("action.persist_memory", {
  describe: () =>
    "Persist a scoped team/workspace/session/run memory entry for later prompt retrieval.",
  schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The durable lesson or memory to store." },
      scope: { type: "string", description: "Optional topical scope such as testing or auth." },
      category: { type: "string", default: "pattern" },
      scopeLevel: {
        type: "string",
        enum: ["team", "workspace", "session", "run"],
        default: "workspace",
      },
      tags: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
      },
      taskId: { type: "string" },
      repoRoot: { type: "string" },
      targetFile: { type: "string", description: "Knowledge markdown file (defaults to AGENTS.md)." },
      registryFile: { type: "string", description: "Persistent registry JSON path." },
      agentId: { type: "string" },
      agentType: { type: "string", default: "workflow" },
      teamId: { type: "string" },
      workspaceId: { type: "string" },
      sessionId: { type: "string" },
      runId: { type: "string" },
    },
    required: ["content"],
  },
  async execute(node, ctx, engine) {
    const TASK_TEMPLATE_PLACEHOLDER_RE = /^\{\{\s*[\w.-]+\s*\}\}$/;
    const TASK_TEMPLATE_INLINE_PLACEHOLDER_RE = /\{\{\s*[\w.-]+\s*\}\}/g;
    const normalizeString = (value) => {
      if (value == null) return "";
      const text = String(value).trim();
      if (!text) return "";
      if (TASK_TEMPLATE_PLACEHOLDER_RE.test(text)) return "";
      return text
        .replace(TASK_TEMPLATE_INLINE_PLACEHOLDER_RE, " ")
        .replace(/[ 	]{2,}/g, " ")
        .trim();
    };
    const pickFirstString = (...values) => {
      for (const value of values) {
        const normalized = normalizeString(value);
        if (normalized) return normalized;
      }
      return "";
    };
    const normalizeStringArray = (...values) => {
      const out = [];
      const seen = new Set();
      const append = (value) => {
        const normalized = normalizeString(value);
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(normalized);
      };
      for (const value of values) {
        if (Array.isArray(value)) {
          for (const item of value) append(item);
        } else if (typeof value === "string" && value.includes(",")) {
          for (const item of value.split(",")) append(item);
        } else {
          append(value);
        }
      }
      return out;
    };
    const resolveValue = (key) => {
      if (Object.prototype.hasOwnProperty.call(node.config || {}, key)) {
        const resolved = ctx.resolve(node.config[key]);
        if (resolved != null && resolved !== "") return resolved;
      }
      const ctxValue = ctx.data?.[key];
      if (ctxValue != null && ctxValue !== "") return ctxValue;
      return null;
    };

    const taskPayload =
      ctx.data?.task && typeof ctx.data.task === "object"
        ? ctx.data.task
        : null;
    const taskMeta =
      taskPayload?.meta && typeof taskPayload.meta === "object"
        ? taskPayload.meta
        : null;
    const repoRoot = pickFirstString(resolveValue("repoRoot"), process.cwd()) || process.cwd();
    const repoSlug = pickFirstString(
      resolveValue("repoSlug"),
      taskPayload?.repository,
      taskPayload?.repo,
      taskMeta?.repository,
    );
    const workspace = pickFirstString(
      resolveValue("workspace"),
      taskPayload?.workspace,
      taskMeta?.workspace,
    );
    const taskId = pickFirstString(
      resolveValue("taskId"),
      taskPayload?.id,
      taskPayload?.taskId,
      taskMeta?.taskId,
    );
    const entry = buildKnowledgeEntry({
      content: pickFirstString(resolveValue("content")),
      scope: pickFirstString(resolveValue("scope")),
      category: pickFirstString(resolveValue("category"), "pattern") || "pattern",
      taskRef: taskId || null,
      scopeLevel: pickFirstString(resolveValue("scopeLevel"), "workspace") || "workspace",
      teamId: pickFirstString(
        resolveValue("teamId"),
        taskPayload?.teamId,
        taskMeta?.teamId,
        process.env.BOSUN_TEAM_ID,
        process.env.BOSUN_TEAM,
        repoSlug,
      ),
      workspaceId: pickFirstString(
        resolveValue("workspaceId"),
        taskPayload?.workspaceId,
        taskMeta?.workspaceId,
        workspace,
        ctx.data?._workspaceId,
        process.env.BOSUN_WORKSPACE_ID,
        process.env.BOSUN_WORKSPACE,
      ),
      sessionId: pickFirstString(
        resolveValue("sessionId"),
        taskPayload?.sessionId,
        taskMeta?.sessionId,
        ctx.data?.sessionId,
        process.env.BOSUN_SESSION_ID,
      ),
      runId: pickFirstString(
        resolveValue("runId"),
        taskPayload?.runId,
        taskMeta?.runId,
        ctx.data?.runId,
        ctx.id,
        process.env.BOSUN_RUN_ID,
      ),
      agentId: pickFirstString(resolveValue("agentId"), `workflow:${node.id}`) || `workflow:${node.id}`,
      agentType: pickFirstString(resolveValue("agentType"), "workflow") || "workflow",
      tags: normalizeStringArray(resolveValue("tags")),
    });

    try {
      const initOpts = {
        repoRoot,
        targetFile: pickFirstString(resolveValue("targetFile"), "AGENTS.md") || "AGENTS.md",
      };
      const registryFile = pickFirstString(resolveValue("registryFile"));
      if (registryFile) initOpts.registryFile = registryFile;
      initSharedKnowledge(initOpts);

      const result = await appendKnowledgeEntry(entry);
      if (!result.success) {
        const nonFatal = /duplicate entry|rate limited/i.test(String(result.reason || ""));
        ctx.log(node.id, `Persistent memory ${nonFatal ? "skipped" : "failed"}: ${result.reason}`);
        if (nonFatal) {
          return {
            success: true,
            persisted: false,
            skipped: true,
            reason: result.reason,
            entry,
            scopeLevel: entry.scopeLevel,
          };
        }
        return {
          success: false,
          persisted: false,
          error: result.reason,
          reason: result.reason,
          entry,
          scopeLevel: entry.scopeLevel,
        };
      }

      ctx.data._lastPersistedMemory = entry;
      ctx.data._lastPersistedMemoryResult = result;
      try {
        appendArtifactRecordToStateLedger({
          artifactId: `memory:${entry.hash || result.hash || randomUUID()}`,
          runId: entry.runId || ctx.id || null,
          rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
          taskId: entry.taskRef || taskId || null,
          sessionId: entry.sessionId || null,
          nodeId: node?.id || null,
          kind: "shared_knowledge_entry",
          path: result.registryPath || initOpts.targetFile || null,
          summary: entry.content?.slice(0, 240) || "Persisted shared knowledge entry",
          metadata: {
            scope: entry.scope,
            scopeLevel: entry.scopeLevel,
            category: entry.category,
            tags: entry.tags || [],
            hash: result.hash || entry.hash || null,
          },
        }, { repoRoot });
      } catch (ledgerErr) {
        ctx.log(node.id, `State ledger artifact mirror failed: ${ledgerErr.message}`, "warn");
      }
      ctx.log(node.id, `Persistent memory stored at ${entry.scopeLevel} scope`);
      return {
        success: true,
        persisted: true,
        entry,
        hash: result.hash || entry.hash,
        registryPath: result.registryPath || null,
        scopeLevel: entry.scopeLevel,
      };
    } catch (err) {
      ctx.log(node.id, `Persistent memory error: ${err.message}`);
      return {
        success: false,
        persisted: false,
        error: err.message,
        entry,
        scopeLevel: entry.scopeLevel,
      };
    }
  },
});

registerBuiltinNodeType("action.load_skillbook_strategies", {
  describe: () =>
    "Load ranked reusable strategies from the Bosun skillbook for planning, recovery, and self-improvement flows.",
  schema: {
    type: "object",
    properties: {
      strategyId: { type: "string", description: "Optional specific strategy ID to load directly." },
      workflowId: { type: "string", description: "Workflow ID filter. Defaults to current workflow." },
      repoRoot: { type: "string", description: "Repo/config root used to resolve the skillbook path." },
      category: { type: "string", default: "strategy" },
      scopeLevel: { type: "string", enum: ["team", "workspace", "session", "run"] },
      scope: { type: "string", description: "Optional scope value used to narrow strategy selection." },
      status: { type: "string", default: "promoted" },
      query: { type: "string", description: "Free-text relevance query used to rank strategies." },
      tags: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
        description: "Optional tags used to require or boost matching strategies.",
      },
      limit: { type: "number", default: 5 },
      outputVariable: { type: "string", description: "Optional context key to store the guidance payload." },
    },
  },
  async execute(node, ctx) {
    const strategyId = String(ctx.resolve(node.config?.strategyId || "") || "").trim();
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    let output;
    if (strategyId) {
      const strategy = await getSkillbookStrategy(strategyId, {
        repoRoot: String(ctx.resolve(node.config?.repoRoot || "") || ctx.data?.repoRoot || process.cwd()).trim() || process.cwd(),
      });
      output = {
        success: true,
        repoRoot: String(ctx.resolve(node.config?.repoRoot || "") || ctx.data?.repoRoot || process.cwd()).trim() || process.cwd(),
        strategyId,
        total: strategy ? 1 : 0,
        matched: strategy ? 1 : 0,
        strategies: strategy ? [strategy] : [],
        guidanceSummary: strategy
          ? `Reusable strategy guidance:\n- ${strategy.recommendation || strategy.strategyId}${strategy.rationale ? `\n  rationale: ${strategy.rationale}` : ""}`
          : "",
        skillbookPath: null,
        strategyIds: strategy ? [strategy.strategyId] : [],
      };
    } else {
      output = await resolveReusableSkillbookGuidance(ctx, {
        repoRoot: ctx.resolve(node.config?.repoRoot || ""),
        workflowId: ctx.resolve(node.config?.workflowId || ""),
        category: ctx.resolve(node.config?.category || "strategy"),
        scopeLevel: ctx.resolve(node.config?.scopeLevel || ""),
        scope: ctx.resolve(node.config?.scope || ""),
        status: ctx.resolve(node.config?.status || "promoted"),
        query:
          ctx.resolve(node.config?.query || "")
          || [
            ctx.data?.taskTitle,
            ctx.data?.taskDescription,
            ctx.data?.lastError,
            ctx.data?.prompt,
            ctx.data?.context,
          ].filter(Boolean).join(" "),
        tags: resolveWorkflowNodeValue(node.config?.tags ?? [], ctx),
        limit: resolveWorkflowNodeValue(node.config?.limit ?? 5, ctx),
      });
    }
    ctx.data._skillbookGuidance = output;
    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }
    ctx.log(
      node.id,
      output.matched > 0
        ? `Loaded ${output.matched} reusable skillbook strategie(s)`
        : "No reusable skillbook strategies matched current context",
    );
    return output;
  },
});

registerBuiltinNodeType("action.evaluate_run", {
  describe: () =>
    "Evaluate a workflow run and emit self-improvement insights, benchmarks, and promotion recommendations.",
  schema: {
    type: "object",
    properties: {
      runId: { type: "string", description: "Run ID to evaluate. Defaults to the current run." },
      workflowId: { type: "string", description: "Workflow ID override for trend lookup." },
      repoRoot: { type: "string", description: "Repo/config root used for evaluation history." },
      outputVariable: { type: "string", description: "Variable name to store the evaluation result in ctx.data." },
      includeTrend: { type: "boolean", default: true },
      recordHistory: {
        type: "boolean",
        default: true,
        description: "Persist the evaluation into durable history for trend-aware self-improvement.",
      },
      evaluatorConfig: {
        type: "object",
        description: "Optional penalty/threshold overrides for RunEvaluator.",
        additionalProperties: true,
      },
    },
  },
  async execute(node, ctx, engine) {
    const resolvedRunId = String(ctx.resolve(node.config?.runId || "") || ctx.data?.runId || ctx.id || "").trim();
    if (!resolvedRunId) {
      throw new Error("action.evaluate_run: runId is required");
    }

    const repoRoot = String(ctx.resolve(node.config?.repoRoot || "") || ctx.data?.repoRoot || process.cwd()).trim() || process.cwd();
    const includeTrend = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.includeTrend ?? true, ctx), true);
    const recordHistory = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.recordHistory ?? true, ctx), true);
    const evaluator = makeSelfImprovementEvaluator(ctx, {
      repoRoot,
      evaluatorConfig: resolveWorkflowNodeValue(node.config?.evaluatorConfig ?? {}, ctx),
    });

    let runDetail = null;
    if (engine?.getRunDetail) {
      runDetail = engine.getRunDetail(resolvedRunId);
    }
    if (!runDetail && resolvedRunId === ctx.id) {
      runDetail = {
        runId: ctx.id,
        workflowId: ctx.data?._workflowId || null,
        detail: engine?._serializeRunContext ? engine._serializeRunContext(ctx, true) : ctx.toJSON(Date.now()),
      };
    }
    if (!runDetail) {
      throw new Error(`action.evaluate_run: run "${resolvedRunId}" not found`);
    }

    const workflowId = String(
      ctx.resolve(node.config?.workflowId || "") ||
      runDetail.workflowId ||
      runDetail?.detail?.data?._workflowId ||
      ctx.data?._workflowId ||
      "unknown",
    ).trim() || "unknown";
    const result = evaluator.evaluate(runDetail, { workflowId, includeTrend, recordHistory });
    const reusableGuidance = await resolveReusableSkillbookGuidance(ctx, {
      repoRoot,
      workflowId,
      category: "strategy",
      status: "promoted",
      query: [
        runDetail?.detail?.data?.taskTitle,
        runDetail?.detail?.data?.taskDescription,
        result?.promotion?.summary,
        result?.promotion?.rationale,
      ].filter(Boolean).join(" "),
      tags: Array.isArray(result?.promotion?.selectedStrategy?.tags)
        ? result.promotion.selectedStrategy.tags
        : [],
      limit: 5,
    });
    if (reusableGuidance.matched > 0) {
      result.skillbookGuidance = reusableGuidance;
      result.reusableStrategies = reusableGuidance.strategies;
      result.reusableStrategySummary = reusableGuidance.guidanceSummary;
      ctx.data._skillbookGuidance = reusableGuidance;
    }
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    if (outputVariable) {
      ctx.data[outputVariable] = result;
    }
    ctx.data._lastRunEvaluation = result;
    ctx.data._lastRunEvaluationRunId = resolvedRunId;
    ctx.data._selfImprovementInsights = result.insights;
    ctx.log(node.id, `Evaluated run ${resolvedRunId} (score=${result.score}, decision=${result.promotion?.decision || "hold"})`);
    return {
      success: true,
      runId: resolvedRunId,
      workflowId,
      ...result,
    };
  },
});

registerBuiltinNodeType("action.promote_strategy", {
  describe: () =>
    "Persist a verified self-improvement strategy or benchmark baseline into shared knowledge.",
  schema: {
    type: "object",
    properties: {
      evaluationNodeId: { type: "string", description: "Node ID that produced action.evaluate_run output." },
      strategyId: { type: "string", description: "Specific strategy ID to promote. Defaults to the evaluator-selected strategy." },
      force: { type: "boolean", default: false, description: "Persist even when the evaluator recommends hold." },
      scopeLevel: {
        type: "string",
        enum: ["team", "workspace", "session", "run"],
        default: "workspace",
      },
      scope: { type: "string", description: "Optional topical scope for retrieval." },
      category: { type: "string", default: "strategy" },
      repoRoot: { type: "string" },
      targetFile: { type: "string" },
      registryFile: { type: "string" },
      outputVariable: { type: "string" },
      tags: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
      },
      agentId: { type: "string" },
      agentType: { type: "string" },
    },
  },
  async execute(node, ctx) {
    const evaluationNodeId = String(ctx.resolve(node.config?.evaluationNodeId || "") || "").trim();
    const evaluation =
      (evaluationNodeId ? ctx.getNodeOutput?.(evaluationNodeId) : null) ||
      ctx.data?._lastRunEvaluation ||
      null;
    if (!evaluation || typeof evaluation !== "object") {
      throw new Error("action.promote_strategy: evaluation result not found");
    }

    const requestedStrategyId = String(ctx.resolve(node.config?.strategyId || "") || "").trim() || null;
    const selectedStrategy = resolveSelfImprovementStrategy(evaluation, requestedStrategyId);
    if (!selectedStrategy) {
      return {
        success: false,
        persisted: false,
        reason: "No strategy candidate available for promotion",
      };
    }

    const force = parseBooleanSetting(resolveWorkflowNodeValue(node.config?.force ?? false, ctx), false);
    if (!force && evaluation?.promotion?.shouldPromote !== true) {
      return {
        success: true,
        persisted: false,
        skipped: true,
        reason: evaluation?.promotion?.summary || "Evaluator did not recommend promotion",
        strategyId: selectedStrategy.strategyId,
      };
    }

    const result = await persistSelfImprovementKnowledgeEntry(ctx, node, {
      evaluation,
      selectedStrategy,
      decision: evaluation?.promotion?.decision || "promote_strategy",
      repoRoot: ctx.resolve(node.config?.repoRoot || ""),
      targetFile: ctx.resolve(node.config?.targetFile || ""),
      registryFile: ctx.resolve(node.config?.registryFile || ""),
      scopeLevel: ctx.resolve(node.config?.scopeLevel || "workspace"),
      scope: ctx.resolve(node.config?.scope || ""),
      category: ctx.resolve(node.config?.category || "strategy"),
      status: "promoted",
      tags: ctx.resolve(node.config?.tags || ""),
      agentId: ctx.resolve(node.config?.agentId || ""),
      agentType: ctx.resolve(node.config?.agentType || ""),
      contentLines: [
        `Promoted strategy for workflow ${evaluation?.workflowId || ctx.data?._workflowId || "unknown"}: ${selectedStrategy.recommendation}`,
        selectedStrategy.rationale ? `Rationale: ${selectedStrategy.rationale}` : "",
        evaluation?.benchmark
          ? `Benchmark: score=${evaluation.score}, grade=${evaluation.grade}, throughputPerMinute=${evaluation.benchmark.throughputPerMinute}, retryDensity=${evaluation.benchmark.retryDensity}, traceCoverage=${evaluation.benchmark.traceCoverage}`
          : "",
        evaluation?.promotion?.rationale ? `Promotion rationale: ${evaluation.promotion.rationale}` : "",
      ],
    });
    if (!result.success) return result;
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const output = { ...result };
    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }
    ctx.data._lastPromotedStrategy = output;
    ctx.log(node.id, `Promoted strategy ${selectedStrategy.strategyId} into shared knowledge`);
    return output;
  },
});

registerBuiltinNodeType("action.apply_self_improvement_ratchet", {
  describe: () =>
    "Persist compare/keep/revert ratchet decisions for self-improvement runs and emit proof metadata into the execution ledger.",
  schema: {
    type: "object",
    properties: {
      evaluationNodeId: { type: "string", description: "Node ID that produced action.evaluate_run output." },
      strategyId: { type: "string", description: "Optional strategy override for apply/revert decisions." },
      repoRoot: { type: "string" },
      targetFile: { type: "string" },
      registryFile: { type: "string" },
      scopeLevel: {
        type: "string",
        enum: ["team", "workspace", "session", "run"],
        default: "workspace",
      },
      scope: { type: "string", description: "Optional topical scope for knowledge persistence." },
      category: { type: "string", default: "strategy" },
      outputVariable: { type: "string" },
      tags: {
        anyOf: [
          { type: "array", items: { type: "string" } },
          { type: "string" },
        ],
      },
      agentId: { type: "string" },
      agentType: { type: "string" },
    },
  },
  async execute(node, ctx, engine) {
    const evaluationNodeId = String(ctx.resolve(node.config?.evaluationNodeId || "") || "").trim();
    const evaluation =
      (evaluationNodeId ? ctx.getNodeOutput?.(evaluationNodeId) : null) ||
      ctx.data?._lastRunEvaluation ||
      null;
    if (!evaluation || typeof evaluation !== "object") {
      throw new Error("action.apply_self_improvement_ratchet: evaluation result not found");
    }

    const workflowId = String(evaluation?.workflowId || ctx.data?._workflowId || "").trim() || "unknown";
    const repoRoot = String(ctx.resolve(node.config?.repoRoot || "") || ctx.data?.repoRoot || process.cwd()).trim() || process.cwd();
    const evaluator = makeSelfImprovementEvaluator(ctx, { repoRoot });
    const requestedStrategyId = String(ctx.resolve(node.config?.strategyId || "") || "").trim() || null;
    const fallbackDecision = evaluation?.promotion?.decision === "capture_baseline"
      ? "capture_baseline"
      : (evaluation?.promotion?.decision === "promote_strategy"
          ? "apply_candidate"
          : (evaluation?.promotion?.decision === "investigate_regression" ? "keep_baseline" : "hold"));
    const ratchet = evaluation?.ratchet && typeof evaluation.ratchet === "object"
      ? JSON.parse(JSON.stringify(evaluation.ratchet))
      : { decision: fallbackDecision };
    const decision = String(ratchet?.decision || "hold").trim() || "hold";
    const selectedStrategy = resolveSelfImprovementStrategy(
      evaluation,
      requestedStrategyId,
      ratchet?.targetStrategy || null,
    );
    const candidateSnapshot = ratchet?.candidate && typeof ratchet.candidate === "object"
      ? JSON.parse(JSON.stringify(ratchet.candidate))
      : {
          runId: evaluation?.runId || ctx.data?._lastRunEvaluationRunId || ctx.id,
          workflowId,
          score: evaluation?.score ?? 0,
          grade: evaluation?.grade || "F",
          timestamp: new Date().toISOString(),
          strategyId: selectedStrategy?.strategyId || null,
          strategy: selectedStrategy || null,
          benchmark: evaluation?.benchmark || null,
          metrics: evaluation?.metrics || null,
          promotionDecision: evaluation?.promotion?.decision || null,
        };
    const comparison = ratchet?.comparison && typeof ratchet.comparison === "object"
      ? JSON.parse(JSON.stringify(ratchet.comparison))
      : null;

    let executionDiff = null;
    const baselineRunId = String(
      comparison?.baselineRunId ||
      ratchet?.baseline?.runId ||
      ratchet?.stateBefore?.activeBaseline?.runId ||
      "",
    ).trim();
    const candidateRunId = String(candidateSnapshot?.runId || evaluation?.runId || ctx.id || "").trim();
    if (
      baselineRunId &&
      candidateRunId &&
      baselineRunId !== candidateRunId &&
      typeof engine?.diffRunGraphs === "function"
    ) {
      executionDiff = summarizeRunGraphDiff(engine.diffRunGraphs(baselineRunId, candidateRunId));
      if (comparison && executionDiff) {
        comparison.executionDiff = executionDiff;
      }
    }

    let knowledge = null;
    if (["capture_baseline", "apply_candidate", "revert_to_baseline"].includes(decision)) {
      if (!selectedStrategy) {
        return {
          success: false,
          persisted: false,
          decision,
          reason: "Ratchet decision requires a strategy snapshot, but none was available",
        };
      }
      const actionVerb = decision === "revert_to_baseline" ? "Reverted" : "Persisted";
      const targetRunId = decision === "revert_to_baseline"
        ? String(ratchet?.previousBaseline?.runId || "").trim() || null
        : candidateRunId;
      knowledge = await persistSelfImprovementKnowledgeEntry(ctx, node, {
        evaluation,
        selectedStrategy,
        decision,
        repoRoot,
        targetFile: ctx.resolve(node.config?.targetFile || ""),
        registryFile: ctx.resolve(node.config?.registryFile || ""),
        scopeLevel: ctx.resolve(node.config?.scopeLevel || "workspace"),
        scope: ctx.resolve(node.config?.scope || ""),
        category: ctx.resolve(node.config?.category || "strategy"),
        status: decision === "revert_to_baseline" ? "reverted" : "promoted",
        tags: normalizeSelfImprovementTagList(
          ctx.resolve(node.config?.tags || ""),
          "ratchet",
          decision,
        ),
        agentId: ctx.resolve(node.config?.agentId || ""),
        agentType: ctx.resolve(node.config?.agentType || ""),
        contentLines: [
          `${actionVerb} ratchet strategy for workflow ${workflowId}: ${selectedStrategy.recommendation}`,
          decision === "revert_to_baseline"
            ? `Reverted to baseline run ${targetRunId || "unknown"} after candidate run ${candidateRunId || "unknown"} regressed.`
            : `Candidate run ${targetRunId || "unknown"} ${decision === "capture_baseline" ? "captured as the initial baseline" : "applied as the new baseline"}.`,
          selectedStrategy.rationale ? `Rationale: ${selectedStrategy.rationale}` : "",
          ratchet?.summary ? `Ratchet summary: ${ratchet.summary}` : "",
          ratchet?.rationale ? `Ratchet rationale: ${ratchet.rationale}` : "",
          evaluation?.benchmark
            ? `Benchmark: score=${evaluation.score}, grade=${evaluation.grade}, throughputPerMinute=${evaluation.benchmark.throughputPerMinute}, retryDensity=${evaluation.benchmark.retryDensity}, traceCoverage=${evaluation.benchmark.traceCoverage}`
            : "",
        ],
      });
      if (!knowledge.success) {
        return {
          success: false,
          persisted: false,
          decision,
          reason: knowledge.reason || "Failed to persist ratchet strategy evidence",
          knowledge,
        };
      }
    }

    const persistence = evaluator.recordRatchetDecision(workflowId, {
      decisionId: `${workflowId}:${decision}:${candidateRunId || Date.now()}`,
      timestamp: new Date().toISOString(),
      runId: candidateRunId || null,
      decision,
      summary: ratchet?.summary || evaluation?.promotion?.summary || `Ratchet decision ${decision}`,
      rationale: ratchet?.rationale || evaluation?.promotion?.rationale || null,
      candidate: candidateSnapshot,
      baseline: ratchet?.baseline || ratchet?.stateBefore?.activeBaseline || null,
      previousBaseline: ratchet?.previousBaseline || ratchet?.stateBefore?.previousBaseline || null,
      comparison,
      selectedStrategyId: evaluation?.promotion?.selectedStrategyId || selectedStrategy?.strategyId || null,
      targetStrategyId: selectedStrategy?.strategyId || null,
      targetStrategy: selectedStrategy || null,
      knowledge,
    });

    const stateAfter = persistence?.stateAfter || evaluator.getRatchetState(workflowId);
    const output = {
      success: true,
      persisted: true,
      workflowId,
      runId: candidateRunId || null,
      decision,
      summary: ratchet?.summary || persistence?.decision?.summary || null,
      rationale: ratchet?.rationale || persistence?.decision?.rationale || null,
      comparison,
      executionDiff,
      knowledge,
      stateBefore: persistence?.stateBefore || ratchet?.stateBefore || null,
      stateAfter,
      activeBaselineRunId: stateAfter?.activeBaseline?.runId || null,
      previousBaselineRunId: stateAfter?.previousBaseline?.runId || null,
    };

    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    if (outputVariable) {
      ctx.data[outputVariable] = output;
    }
    ctx.data._selfImprovementRatchet = output;

    recordNodeLedgerEvent(engine, buildWorkflowLedgerBase(ctx, {
      eventType: "proof.emitted",
      ...buildNodeExecutionLedgerRef(ctx, node, "proof", ["ratchet", decision], node.label || node.id),
      nodeId: node?.id || null,
      nodeType: node?.type || null,
      nodeLabel: node?.label || null,
      status: "completed",
      summary: output.summary || `Ratchet decision ${decision}`,
      meta: {
        kind: "self_improvement_ratchet",
        attachmentKind: "self_improvement_ratchet",
        decision,
        workflowId,
        candidateRunId: candidateRunId || null,
        baselineRunId: baselineRunId || null,
        activeBaselineRunId: stateAfter?.activeBaseline?.runId || null,
        previousBaselineRunId: stateAfter?.previousBaseline?.runId || null,
        strategyId: selectedStrategy?.strategyId || null,
        comparison,
        executionDiff,
        knowledgeHash: knowledge?.hash || null,
        registryPath: knowledge?.registryPath || null,
      },
    }));

    ctx.log(node.id, `Ratchet decision ${decision} recorded for workflow ${workflowId}`);
    return output;
  },
});

// ==== action.auto_commit_dirty ====
// Safety net: if the agent left uncommitted work in the worktree, stage + commit
// so that detect_new_commits can see it and the work isn't silently destroyed.

registerBuiltinNodeType("action.auto_commit_dirty", {
  describe: () =>
    "Check the worktree for uncommitted changes and auto-commit them so " +
    "downstream nodes (detect_new_commits, push_branch) can pick them up. " +
    "This prevents agent work from being silently destroyed when the worktree is released.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Worktree to check" },
      taskId: { type: "string", description: "Task ID for commit message" },
      commitMessage: { type: "string", description: "Override commit message" },
    },
    required: ["worktreePath"],
  },
  async execute(node, ctx, engine) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const taskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.taskId || "unknown";

    if (!worktreePath) {
      ctx.log(node.id, "auto_commit_dirty: no worktreePath — skipping");
      return { success: false, committed: false, reason: "no worktreePath" };
    }

    let porcelain = "";
    try {
      porcelain = execGitArgsSync(["status", "--porcelain"], {
        cwd: worktreePath, encoding: "utf8", timeout: 10000,
      }).trim();
    } catch (err) {
      ctx.log(node.id, `git status failed: ${err.message}`);
      return { success: false, committed: false, reason: err.message };
    }

    if (!porcelain) {
      ctx.log(node.id, "Worktree clean — nothing to auto-commit");
      return { success: true, committed: false, reason: "clean" };
    }

    const dirtyCount = porcelain.split("\n").filter(Boolean).length;
    ctx.log(node.id, `Found ${dirtyCount} dirty file(s) — auto-committing`);

    try {
      execGitArgsSync(["add", "-A"], {
        cwd: worktreePath, encoding: "utf8", timeout: 15000,
      });
    } catch (err) {
      ctx.log(node.id, `git add -A failed: ${err.message}`);
      return { success: false, committed: false, reason: `git add failed: ${err.message}` };
    }

    const message = cfgOrCtx(node, ctx, "commitMessage")
      || `chore: auto-commit agent work (${taskId.substring(0, 12)})`;
    try {
      execGitArgsSync(
        ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "--no-verify", "-m", message],
        { cwd: worktreePath, encoding: "utf8", timeout: 20000 },
      );
    } catch (err) {
      const errText = (err.stderr || err.stdout || err.message || "").toLowerCase();
      if (errText.includes("nothing to commit")) {
        ctx.log(node.id, "Nothing to commit after staging (all changes already committed)");
        return { success: true, committed: false, reason: "nothing_to_commit" };
      }
      ctx.log(node.id, `git commit failed: ${err.message}`);
      return { success: false, committed: false, reason: `git commit failed: ${err.message}` };
    }

    ctx.log(node.id, `Auto-committed ${dirtyCount} file(s) for task ${taskId.substring(0, 12)}`);
    return { success: true, committed: true, dirtyCount };
  },
});

// ==== action.detect_new_commits ====

registerBuiltinNodeType("action.detect_new_commits", {
  describe: () =>
    "Compare pre/post execution HEAD to detect new commits. Also checks " +
    "for unpushed commits vs base and collects diff stats.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Worktree path (soft-fails if not set)" },
      preExecHead: { type: "string", description: "HEAD hash before agent (auto from ctx)" },
      baseBranch: { type: "string", description: "Base branch for diff stats" },
    },
  },
  async execute(node, ctx, engine) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const baseBranch = cfgOrCtx(node, ctx, "baseBranch", "origin/main");

    if (!worktreePath) {
      ctx.log(node.id, "action.detect_new_commits: worktreePath not set — skipping commit detection");
      return { success: false, error: "worktreePath required", hasCommits: false, hasNewCommits: false, unpushedCount: 0 };
    }

    // Read preExecHead from record-head node output or ctx
    const preExecHead = cfgOrCtx(node, ctx, "preExecHead")
      || ctx.data?._preExecHead
      || (() => {
        // Try to get from record-head node output
        const out = ctx.nodeOutputs?.get?.("record-head");
        return typeof out === "string" ? out.trim()
          : typeof out?.output === "string" ? out.output.trim()
          : "";
      })();

    // Get current HEAD
    let postExecHead = "";
    try {
      postExecHead = execGitArgsSync(["rev-parse", "HEAD"], {
        cwd: worktreePath, encoding: "utf8", timeout: 5000,
      }).trim();
    } catch (err) {
      ctx.log(node.id, `Failed to get HEAD: ${err.message}`);
      return { success: false, error: err.message, hasCommits: false };
    }

    const hasNewCommits = !!(preExecHead && postExecHead && preExecHead !== postExecHead);

    // Also check for unpushed commits vs base (three-tier validation)
    let hasUnpushed = false;
    let commitCount = 0;
    let commitMessages = [];
    try {
      const log = execGitArgsSync(["log", "--oneline", `${baseBranch}..HEAD`], {
        cwd: worktreePath, encoding: "utf8", timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const lines = log ? log.split("\n").filter(Boolean) : [];
      commitCount = lines.length;
      hasUnpushed = commitCount > 0;
      // Capture commit subjects (strip leading short-hash) for PR descriptions
      commitMessages = lines.map(l => l.replace(/^[0-9a-f]+\s+/, "")).slice(0, 50);
    } catch {
      /* best-effort */
    }

    // Changed files list (for PR descriptions)
    let changedFiles = [];
    if (hasNewCommits || hasUnpushed) {
      try {
        const nameOnly = execGitArgsSync(["diff", "--name-only", `${baseBranch}..HEAD`], {
          cwd: worktreePath, encoding: "utf8", timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        changedFiles = nameOnly ? nameOnly.split("\n").filter(Boolean).slice(0, 100) : [];
      } catch { /* best-effort */ }
    }

    // Diff stats
    let diffStats = null;
    if (hasNewCommits || hasUnpushed) {
      try {
        const statOutput = execGitArgsSync(["diff", "--stat", `${baseBranch}..HEAD`], {
          cwd: worktreePath, encoding: "utf8", timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        if (statOutput) {
          const lastLine = statOutput.split("\n").pop() || "";
          const filesMatch = lastLine.match(/(\d+)\s+files?\s+changed/);
          const insertMatch = lastLine.match(/(\d+)\s+insertions?/);
          const deleteMatch = lastLine.match(/(\d+)\s+deletions?/);
          diffStats = {
            filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
            insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
            deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
          };
        }
      } catch { /* best-effort */ }
    }

    // Use hasNewCommits OR hasUnpushed — covers resumed worktrees
    const hasCommits = hasNewCommits || hasUnpushed;

    // ==== Anti-thrash: record no-commit bounces with exponential cooldown ====
    const taskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.taskId || "";
    if (!hasCommits && taskId) {
      const count = (_noCommitCounts.get(taskId) || 0) + 1;
      _noCommitCounts.set(taskId, count);
      const cooldown = Math.min(
        NO_COMMIT_BASE_COOLDOWN_MS * Math.pow(2, count - 1),
        NO_COMMIT_MAX_COOLDOWN_MS,
      );
      _skipUntil.set(taskId, Date.now() + cooldown);
      console.warn(
        `[workflow-nodes] anti-thrash: task ${taskId.substring(0, 8)} no-commit bounce #${count} — cooldown ${Math.round(cooldown / 60000)}min`,
      );
    }

    ctx.data._hasNewCommits = hasCommits;
    ctx.data._postExecHead = postExecHead;
    ctx.data._commitCount = commitCount;
    ctx.data._diffStats = diffStats;
    ctx.data._commitMessages = commitMessages;
    ctx.data._changedFiles = changedFiles;

    ctx.log(
      node.id,
      `Commits: new=${hasNewCommits} unpushed=${hasUnpushed} count=${commitCount} ` +
      `pre=${preExecHead?.slice(0, 8) || "?"} post=${postExecHead?.slice(0, 8) || "?"}`,
    );
    return {
      success: true,
      hasCommits,
      hasNewCommits,
      hasUnpushed,
      commitCount,
      commitMessages,
      changedFiles,
      preExecHead,
      postExecHead,
      diffStats,
    };
  },
});

// ==== action.push_branch ====

registerBuiltinNodeType("action.push_branch", {
  describe: () =>
    "Push the current branch to the remote. Includes remote sync, optional " +
    "base-merge validation with conflict resolution, empty-diff guard, and protected branch safety.",
  schema: {
    type: "object",
    properties: {
      worktreePath: { type: "string", description: "Working directory to push from" },
      branch: { type: "string", description: "Branch name being pushed" },
      baseBranch: { type: "string", description: "Base branch to rebase onto" },
      remote: { type: "string", default: "origin", description: "Remote name" },
      forceWithLease: { type: "boolean", default: true, description: "Use --force-with-lease" },
      skipHooks: { type: "boolean", default: false, description: "Skip git pre-push hooks (--no-verify) for non-managed repos only" },
      rebaseBeforePush: { type: "boolean", default: true, description: "Rebase onto base before push" },
      mergeBaseBeforePush: { type: "boolean", default: false, description: "Merge the base branch into the worktree before push so PR conflicts surface locally" },
      autoResolveMergeConflicts: { type: "boolean", default: false, description: "When merge-base validation conflicts, run an agent to resolve them before pushing" },
      conflictResolverSdk: { type: "string", enum: ["auto", "copilot", "codex", "claude"], default: "auto", description: "SDK used for merge conflict resolution agent runs" },
      conflictResolverPrompt: { type: "string", description: "Optional custom prompt for merge conflict resolution agent runs" },
      emptyDiffGuard: { type: "boolean", default: true, description: "Abort if no files changed vs base" },
      syncMainForModuleBranch: { type: "boolean", default: false, description: "Also sync base with main" },
      pushTimeout: { type: "number", default: 120000, description: "Push timeout (ms)" },
      protectedBranches: {
        type: "array", items: { type: "string" },
        default: ["main", "master", "develop", "production"],
        description: "Branches that cannot be force-pushed",
      },
      requireApproval: { type: "boolean", default: false, description: "Force operator approval before pushing even when the global risky-action toggle is off." },
      approvalReason: { type: "string", description: "Optional extra operator-facing reason shown in the approval queue." },
      approvalTimeoutMs: { type: "number", default: 900000, description: "Maximum time to wait for operator approval before failing." },
      approvalPollIntervalMs: { type: "number", default: 5000, description: "Polling interval used while waiting for operator approval." },
      approvalOnTimeout: { type: "string", enum: ["fail", "proceed"], default: "fail", description: "Behavior when operator approval is not provided before the timeout." },
    },
    required: ["worktreePath"],
  },
  async execute(node, ctx, engine) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const branch = cfgOrCtx(node, ctx, "branch", "");
    const baseBranch = cfgOrCtx(node, ctx, "baseBranch", "origin/main");
    const repoRoot = cfgOrCtx(node, ctx, "repoRoot") || ctx.data.repoRoot || process.cwd();
    const configuredRemote = String(node.config?.remote || "origin").trim() || "origin";
    const repoHint = pickTaskString(
      ctx?.data?.repo,
      ctx?.data?.repository,
      ctx?.data?.repoSlug,
      ctx?.data?.task?.repo,
      ctx?.data?.task?.repository,
      ctx?.data?.task?.meta?.repo,
      ctx?.data?.task?.meta?.repository,
    );
    const remote = resolvePreferredPushRemote(worktreePath, configuredRemote, repoHint);
    const forceWithLease = node.config?.forceWithLease !== false;
    const managedPushHooksRequired = shouldEnforceManagedPushHook(repoRoot, worktreePath);
    const skipHooks = typeof node.config?.skipHooks === "boolean"
      ? node.config.skipHooks
      : false;
    const rebaseBeforePush = node.config?.rebaseBeforePush !== false;
    const mergeBaseBeforePush = node.config?.mergeBaseBeforePush === true;
    const autoResolveMergeConflicts = node.config?.autoResolveMergeConflicts === true;
    const conflictResolverSdk = String(ctx.resolve(node.config?.conflictResolverSdk || "auto") || "auto").trim() || "auto";
    const conflictResolverPrompt = String(node.config?.conflictResolverPrompt || "");
    const emptyDiffGuard = node.config?.emptyDiffGuard !== false;
    const syncMain = node.config?.syncMainForModuleBranch === true;
    const pushTimeout = node.config?.pushTimeout || 120000;
    const protectedBranches = node.config?.protectedBranches
      || ["main", "master", "develop", "production"];

    ctx.data._pushMergeConflict = false;
    ctx.data._pushConflictFiles = [];
    ctx.data._pushConflictResolved = false;

    if (!worktreePath) {
      ctx.log(node.id, "action.push_branch: worktreePath not set - refusing push");
      return {
        success: false,
        pushed: false,
        branch: branch.replace(/^origin\//, ""),
        remote,
        error: "action.push_branch: worktreePath is required",
        implementationDone: false,
        blockedReason: "missing_worktree_path",
        implementationState: null,
      };
    }

    if (remote !== configuredRemote) {
      ctx.log(node.id, `Remapped push remote ${configuredRemote} -> ${remote} for ${repoHint || branch || "worktree"}`);
    }

    if (managedPushHooksRequired && skipHooks) {
      ctx.log(node.id, "Managed worktree push blocked: skipHooks is forbidden by guardrails");
      return {
        success: false,
        pushed: false,
        error: "Managed Bosun worktrees must run local pre-push validation before push",
      };
    }

    if (managedPushHooksRequired) {
      bootstrapWorktreeForPath(repoRoot, worktreePath);
    }

    // Safety check: don't push to protected branches
    const cleanBranch = branch.replace(/^origin\//, "");
    if (protectedBranches.includes(cleanBranch)) {
      ctx.log(node.id, `Refusing to push to protected branch: ${cleanBranch}`);
      return {
        success: false,
        error: `Protected branch: ${cleanBranch}`,
        pushed: false,
        implementationDone: true,
        blockedReason: "blocked_by_repo",
        implementationState: "implementation_done_commit_blocked",
      };
    }

    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.push_branch",
      repoRoot,
    });

    // ==== Fetch (always, independent of rebase) ====
    // Must succeed before push so --force-with-lease has fresh remote tracking refs.
    try {
      execGitArgsSync(["fetch", remote, "--no-tags"], {
        cwd: worktreePath, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (fetchErr) {
      ctx.log(node.id, `Fetch failed (will push anyway): ${fetchErr.message?.slice(0, 200)}`);
    }

    // ==== Rebase-before-push ====
    if (rebaseBeforePush || mergeBaseBeforePush) {
      // Step 1: if the remote already has commits on this branch (previous run / partial push),
      // rebase local onto origin/${cleanBranch} first so we incorporate those commits and
      // the subsequent push is a clean fast-forward instead of a diverged force-push.
      const remoteTrackingRef = `${remote}/${cleanBranch}`;
      try {
        execGitArgsSync(["rev-parse", "--verify", remoteTrackingRef], {
          cwd: worktreePath, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
        });
        // Remote branch exists — check if it diverges from local
        const behindCount = execGitArgsSync(
          ["rev-list", "--count", `HEAD..${remoteTrackingRef}`],
          { cwd: worktreePath, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }
        ).trim();
        if (parseInt(behindCount, 10) > 0) {
          try {
            execGitArgsSync(["rebase", remoteTrackingRef], {
              cwd: worktreePath, encoding: "utf8", timeout: 60000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            ctx.log(node.id, `Synced local with ${remoteTrackingRef} (was ${behindCount} behind)`);
          } catch (syncErr) {
            try { execGitArgsSync(["rebase", "--abort"], { cwd: worktreePath, timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }); } catch { /* ok */ }
            ctx.log(node.id, `Sync with ${remoteTrackingRef} conflicted, skipping: ${syncErr.message?.slice(0, 200)}`);
          }
        }
      } catch { /* remote branch doesn't exist yet — normal for first push */ }

      // Step 2: integrate the base branch before pushing.
      if (mergeBaseBeforePush) {
        try {
          execGitArgsSync(["merge", "--no-edit", baseBranch], {
            cwd: worktreePath,
            encoding: "utf8",
            timeout: 120000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          ctx.log(node.id, `Merged ${baseBranch} into ${cleanBranch || "HEAD"}`);
        } catch (mergeErr) {
          const conflictFiles = listUnmergedFiles(worktreePath);
          if (conflictFiles.length === 0) {
            const detail = formatExecSyncError(mergeErr);
            ctx.log(node.id, `Merge of ${baseBranch} failed before push: ${detail}`);
            return {
              success: false,
              pushed: false,
              branch: cleanBranch,
              remote,
              error: detail,
              implementationDone: true,
              blockedReason: classifyPushBlockedReason(detail, false),
              implementationState: "implementation_done_commit_blocked",
            };
          }

          ctx.log(node.id, `Merge of ${baseBranch} conflicted in ${conflictFiles.length} file(s)`);
          let resolution = {
            success: false,
            remainingConflicts: conflictFiles,
            mergeInProgress: true,
            error: null,
          };
          if (autoResolveMergeConflicts) {
            resolution = await resolvePushMergeConflictWithAgent({
              node,
              ctx,
              engine,
              worktreePath,
              baseBranch,
              conflictFiles,
              sdk: conflictResolverSdk,
              promptTemplate: conflictResolverPrompt,
            });
          }

          if (!resolution.success) {
            const remainingConflicts = resolution.remainingConflicts?.length
              ? resolution.remainingConflicts
              : conflictFiles;
            abortMergeOperation(worktreePath);
            ctx.data._pushMergeConflict = true;
            ctx.data._pushConflictFiles = remainingConflicts;
            return {
              success: false,
              pushed: false,
              branch: cleanBranch,
              remote,
              mergeConflict: true,
              conflictFiles: remainingConflicts,
              conflictResolved: false,
              agentAttempted: autoResolveMergeConflicts,
              error: resolution.error || `Merge conflict while integrating ${baseBranch}`,
              implementationDone: true,
              blockedReason: classifyPushBlockedReason(
                resolution.error || `Merge conflict while integrating ${baseBranch}`,
                true,
              ),
              implementationState: "implementation_done_commit_blocked",
            };
          }

          ctx.data._pushConflictResolved = true;
          ctx.log(node.id, `Resolved merge conflict against ${baseBranch}; continuing with push`);
        }
      } else {
        try {
          execGitArgsSync(["rebase", baseBranch], {
            cwd: worktreePath, encoding: "utf8", timeout: 60000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          ctx.log(node.id, `Rebased onto ${baseBranch}`);
        } catch (rebaseErr) {
          // Abort rebase on conflict — push what we have
          try {
            execGitArgsSync(["rebase", "--abort"], {
              cwd: worktreePath, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
            });
          } catch { /* already aborted */ }
          ctx.log(node.id, `Rebase onto ${baseBranch} conflicted, skipping: ${rebaseErr.message?.slice(0, 200)}`);
        }
      }
    }

    // ==== Optional: sync base branch with main (for module branches) ====
    if (syncMain && baseBranch !== "origin/main" && baseBranch !== "main") {
      try {
        execGitArgsSync(["merge", `${remote}/main`, "--no-edit"], {
          cwd: worktreePath, timeout: 30000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        ctx.log(node.id, `Synced with ${remote}/main for module branch`);
      } catch (mergeErr) {
        try {
          execGitArgsSync(["merge", "--abort"], {
            cwd: worktreePath, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
          });
        } catch { /* already aborted */ }
        ctx.log(node.id, `Main sync conflict, skipping: ${mergeErr.message?.slice(0, 200)}`);
      }
    }

    // ==== Empty diff guard ====
    if (emptyDiffGuard) {
      try {
        const diffOutput = execGitArgsSync(["diff", "--name-only", `${baseBranch}..HEAD`], {
          cwd: worktreePath, encoding: "utf8", timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const changedFiles = diffOutput ? diffOutput.split("\n").filter(Boolean).length : 0;
        if (changedFiles === 0) {
          ctx.log(node.id, "No files changed vs base — aborting push");
          ctx.data._pushSkipped = true;
          return {
            success: false,
            error: "No files changed vs base",
            pushed: false,
            changedFiles: 0,
            implementationDone: false,
            blockedReason: null,
            implementationState: null,
          };
        }
        ctx.data._changedFileCount = changedFiles;
      } catch {
        /* best-effort — still try to push */
      }
    }

    // ==== Hard zero-diff guard (always active) ====
    try {
      const headSha = execGitArgsSync(["rev-parse", "HEAD"], {
        cwd: worktreePath, encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mainSha = execGitArgsSync(["rev-parse", `${remote}/main`], {
        cwd: worktreePath, encoding: "utf8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (headSha && mainSha && headSha === mainSha) {
        ctx.log(node.id, `HEAD is identical to ${remote}/main — aborting push to prevent PR wipe`);
        ctx.data._pushSkipped = true;
        return {
          success: false,
          error: `HEAD matches ${remote}/main — refusing push`,
          pushed: false,
          implementationDone: false,
          blockedReason: null,
          implementationState: null,
        };
      }
    } catch { /* best-effort */ }

    // ==== Push ====
    const pushArgs = ["push"];
    if (forceWithLease) pushArgs.push("--force-with-lease");
    if (skipHooks) pushArgs.push("--no-verify");
    pushArgs.push("--set-upstream", remote, "HEAD");

    try {
      const output = execGitArgsSync(pushArgs, {
        cwd: worktreePath, encoding: "utf8", timeout: pushTimeout,
        stdio: ["ignore", "pipe", "pipe"],
      });
      ctx.log(node.id, `Push succeeded: ${cleanBranch || "HEAD"} → ${remote}`);
      return {
        success: true,
        pushed: true,
        branch: cleanBranch,
        remote,
        mergeBaseBeforePush,
        conflictResolved: ctx.data._pushConflictResolved === true,
        implementationDone: true,
        blockedReason: null,
        implementationState: null,
        output: output?.trim()?.slice(0, 500) || "",
      };
    } catch (err) {
      ctx.log(node.id, `Push failed: ${err.message?.slice(0, 300)}`);
      const blockedReason = classifyPushBlockedReason(err.message || "", false);
      return {
        success: false,
        pushed: false,
        branch: cleanBranch,
        remote,
        error: err.message?.slice(0, 500),
        implementationDone: true,
        blockedReason,
        implementationState: "implementation_done_commit_blocked",
      };
    }
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  WEB SEARCH — Structured web search for research workflows
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("action.web_search", {
  describe: () =>
    "Perform a structured web search query and return results. Useful for " +
    "research workflows (e.g., Aletheia-style math/science agents) that need " +
    "to navigate literature or verify claims against external sources.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (supports {{variables}})" },
      maxResults: { type: "number", default: 5, description: "Maximum results to return" },
      engine: {
        type: "string",
        enum: ["mcp", "fetch", "agent"],
        default: "fetch",
        description:
          "Search method: 'mcp' uses registered MCP web search tool, " +
          "'fetch' calls a search API directly, 'agent' delegates to an agent with web access",
      },
      extractContent: {
        type: "boolean",
        default: false,
        description: "Fetch and extract text content from result URLs",
      },
      apiUrl: {
        type: "string",
        description: "Custom search API endpoint (for fetch engine)",
      },
    },
    required: ["query"],
  },
  async execute(node, ctx, engine) {
    const query = ctx.resolve(node.config?.query || "");
    const maxResults = Math.max(1, Math.min(20, Number(node.config?.maxResults) || 5));
    const searchEngine = node.config?.engine || "fetch";

    if (!query) {
      throw new Error("action.web_search: 'query' is required");
    }

    ctx.log(node.id, `Web search (${searchEngine}): "${query}" (max ${maxResults})`);

    // ==== MCP-based search ====
    if (searchEngine === "mcp") {
      try {
        const { getMcpRegistry } = await import("./mcp-registry.mjs");
        const registry = getMcpRegistry?.();
        if (registry?.callTool) {
          const result = await registry.callTool("web_search", { query, maxResults });
          const results = Array.isArray(result) ? result : result?.results || [result];
          return {
            success: true,
            engine: "mcp",
            query,
            resultCount: results.length,
            results: results.slice(0, maxResults),
          };
        }
      } catch (err) {
        ctx.log(node.id, `MCP search failed: ${err.message}, falling back to fetch`, "warn");
      }
    }

    // ==== Agent-based search ====
    if (searchEngine === "agent") {
      const agentPool = engine?.services?.agentPool;
      if (agentPool?.launchEphemeralThread) {
        const searchPrompt =
          `Search the web for: "${query}"\n\n` +
          `Return the top ${maxResults} results as a JSON array of objects with ` +
          `fields: title, url, snippet. Return ONLY the JSON array, no other text.`;
        const result = await agentPool.launchEphemeralThread(
          searchPrompt, process.cwd(), 120000,
        );
        let parsed = [];
        try {
          const jsonMatch = (result.output || "").match(/\[[\s\S]*\]/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch { /* best-effort */ }
        return {
          success: true,
          engine: "agent",
          query,
          resultCount: parsed.length,
          results: parsed.slice(0, maxResults),
          rawOutput: result.output?.slice(0, 2000),
        };
      }
    }

    // ==== Fetch-based search (default) ====
    try {
      const { default: fetchFn } = await import("../infra/fetch-runtime.mjs");
      const fetch = fetchFn || globalThis.fetch;

      // Use DuckDuckGo instant answer API (no API key required)
      const apiUrl = node.config?.apiUrl ||
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

      const response = await fetch(apiUrl, {
        headers: { "User-Agent": "Bosun-Workflow/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();

      const results = [];

      // Parse DuckDuckGo response format
      if (data.AbstractText) {
        results.push({
          title: data.Heading || query,
          url: data.AbstractURL || "",
          snippet: data.AbstractText,
          source: data.AbstractSource || "DuckDuckGo",
        });
      }
      for (const topic of data.RelatedTopics || []) {
        if (results.length >= maxResults) break;
        if (topic.Text) {
          results.push({
            title: topic.Text?.slice(0, 100),
            url: topic.FirstURL || "",
            snippet: topic.Text,
          });
        }
        // Nested topics
        for (const sub of topic.Topics || []) {
          if (results.length >= maxResults) break;
          if (sub.Text) {
            results.push({
              title: sub.Text?.slice(0, 100),
              url: sub.FirstURL || "",
              snippet: sub.Text,
            });
          }
        }
      }

      // Extract content from URLs if requested
      if (node.config?.extractContent && results.length > 0) {
        for (let i = 0; i < Math.min(3, results.length); i++) {
          if (!results[i].url) continue;
          try {
            const pageResp = await fetch(results[i].url, {
              headers: { "User-Agent": "Bosun-Workflow/1.0" },
              signal: AbortSignal.timeout(10000),
            });
            const html = await pageResp.text();
            // Convert markup to plain text without regex script/style filters.
            const plain = stripHtmlToText(html);
            results[i].content = plain
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 5000);
          } catch { /* best-effort */ }
        }
      }

      return {
        success: results.length > 0,
        engine: "fetch",
        query,
        resultCount: results.length,
        results,
      };
    } catch (err) {
      ctx.log(node.id, `Fetch search failed: ${err.message}`, "warn");
      return {
        success: false,
        engine: "fetch",
        query,
        resultCount: 0,
        results: [],
        error: err.message,
      };
    }
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  CONTROL FLOW — Try/Catch Error Boundary
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("flow.try_catch", {
  describe: () => "Error boundary — execute a sub-workflow and catch failures gracefully",
  schema: {
    type: "object",
    properties: {
      tryWorkflowId: {
        type: "string",
        description: "Workflow ID to execute in the 'try' block",
      },
      catchWorkflowId: {
        type: "string",
        description: "Optional workflow ID to execute on error (receives $error in data)",
      },
      finallyWorkflowId: {
        type: "string",
        description: "Optional workflow ID to always execute after try/catch",
      },
      tryNodes: {
        type: "array",
        items: { type: "string" },
        description: "Alternative: list of node IDs from the parent workflow to treat as the try block",
      },
      errorVariable: {
        type: "string",
        default: "$error",
        description: "Variable name to store the caught error object",
      },
      propagateError: {
        type: "boolean",
        default: false,
        description: "If true, re-throw the error after catch/finally (bubble to parent)",
      },
      maxRetries: {
        type: "number",
        default: 0,
        description: "Auto-retry the try block up to N times before falling through to catch",
      },
      retryDelayMs: {
        type: "number",
        default: 1000,
        description: "Delay between retries in ms",
      },
    },
  },
  async execute(node, ctx, engine) {
    const tryWfId = ctx.resolve(node.config?.tryWorkflowId || "");
    const catchWfId = ctx.resolve(node.config?.catchWorkflowId || "");
    const finallyWfId = ctx.resolve(node.config?.finallyWorkflowId || "");
    const errorVar = node.config?.errorVariable || "$error";
    const propagate = node.config?.propagateError === true;
    const maxRetries = Math.max(0, Math.min(10, node.config?.maxRetries || 0));
    const retryDelay = Math.max(0, node.config?.retryDelayMs || 1000);

    let tryResult = null;
    let caughtError = null;
    let catchResult = null;
    let finallyResult = null;
    let attempts = 0;

    // ==== TRY ====
    if (tryWfId && engine?.execute) {
      const attemptLimit = 1 + maxRetries;
      while (attempts < attemptLimit) {
        attempts++;
        try {
          ctx.log(node.id, `try: executing workflow "${tryWfId}" (attempt ${attempts}/${attemptLimit})`);
          const runCtx = await engine.execute(
            tryWfId,
            applyChildWorkflowLineage(ctx, { ...ctx.data }, tryWfId),
            makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: tryWfId, sourceNodeId: node.id }),
          );
          const hasErrors = runCtx?.errors?.length > 0;
          if (hasErrors) {
            const msg = runCtx.errors.map((e) => e.error || e.message || String(e)).join("; ");
            throw new Error(msg);
          }
          tryResult = { success: true, runId: runCtx?.id || null, attempt: attempts };
          caughtError = null; // Clear any previous retry errors on success
          break; // success — exit retry loop
        } catch (err) {
          caughtError = err;
          if (attempts < attemptLimit) {
            ctx.log(node.id, `try: attempt ${attempts} failed, retrying in ${retryDelay}ms…`);
            await new Promise((r) => setTimeout(r, retryDelay));
          }
        }
      }
    } else if (!tryWfId) {
      // No sub-workflow — the try block is a no-op (node acts as passthrough)
      tryResult = { success: true, passthrough: true };
    } else {
      tryResult = { success: true, noEngine: true };
    }

    // ==== CATCH ====
    if (caughtError) {
      ctx.log(node.id, `catch: error from try block — ${caughtError.message}`);
      const errorObj = {
        message: caughtError.message,
        name: caughtError.name || "Error",
        stack: caughtError.stack || null,
        attempt: attempts,
      };
      ctx.data[errorVar] = errorObj;
      tryResult = { success: false, error: errorObj.message, attempt: attempts };

      if (catchWfId && engine?.execute) {
        try {
          ctx.log(node.id, `catch: executing workflow "${catchWfId}"`);
          const catchCtx = await engine.execute(
            catchWfId,
            applyChildWorkflowLineage(ctx, { ...ctx.data, [errorVar]: errorObj }, catchWfId),
            makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: catchWfId, sourceNodeId: node.id }),
          );
          catchResult = { executed: true, runId: catchCtx?.id || null };
        } catch (catchErr) {
          catchResult = { executed: true, error: catchErr.message };
          ctx.log(node.id, `catch workflow also failed: ${catchErr.message}`, "warn");
        }
      }
    }

    // ==== FINALLY ====
    if (finallyWfId && engine?.execute) {
      try {
        ctx.log(node.id, `finally: executing workflow "${finallyWfId}"`);
        const finallyCtx = await engine.execute(
          finallyWfId,
          applyChildWorkflowLineage(ctx, { ...ctx.data }, finallyWfId),
          makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: finallyWfId, sourceNodeId: node.id }),
        );
        finallyResult = { executed: true, runId: finallyCtx?.id || null };
      } catch (finErr) {
        finallyResult = { executed: true, error: finErr.message };
        ctx.log(node.id, `finally workflow failed: ${finErr.message}`, "warn");
      }
    }

    // ==== Propagate ====
    if (caughtError && propagate) {
      throw caughtError;
    }

    return {
      tryResult,
      catchResult,
      finallyResult,
      hadError: !!caughtError,
      errorMessage: caughtError?.message || null,
      attempts,
    };
  },
});

// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ
//  CONTROL FLOW — Parallel Execution
// ÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉÔòÉ

registerBuiltinNodeType("flow.parallel", {
  describe: () => "Execute multiple named branches (sub-workflows) simultaneously and collect all results",
  schema: {
    type: "object",
    properties: {
      branches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name:       { type: "string", description: "Branch label (used as key in results)" },
            workflowId: { type: "string", description: "Workflow ID to execute for this branch" },
            data:       { type: "object", description: "Optional data overrides for this branch" },
          },
          required: ["name", "workflowId"],
        },
        description: "List of branches to execute in parallel",
      },
      failStrategy: {
        type: "string",
        enum: ["all-settled", "fail-fast"],
        default: "all-settled",
        description: "'all-settled' waits for every branch; 'fail-fast' aborts remaining on first failure",
      },
      timeoutMs: {
        type: "number",
        default: 300000,
        description: "Maximum time to wait for all branches (ms)",
      },
    },
    required: ["branches"],
  },
  async execute(node, ctx, engine) {
    const branches = Array.isArray(node.config?.branches) ? node.config.branches : [];
    const strategy = node.config?.failStrategy || "all-settled";
    const timeoutMs = node.config?.timeoutMs || 300_000;

    if (branches.length === 0) {
      return { branches: [], results: {}, successCount: 0, failCount: 0 };
    }

    if (!engine?.execute) {
      throw new Error("flow.parallel requires an engine with sub-workflow execution support");
    }

    ctx.log(node.id, `parallel: launching ${branches.length} branches (${strategy})`);

    const makeBranchPromise = (branch) => {
      const wfId = ctx.resolve(branch.workflowId || "");
      if (!wfId) {
        return Promise.resolve({ name: branch.name, success: false, error: "Missing workflowId" });
      }
      const branchData = applyChildWorkflowLineage(
        ctx,
        { ...ctx.data, ...(branch.data || {}), _parallelBranch: branch.name },
        wfId,
      );
      return engine.execute(
        wfId,
        branchData,
        makeChildWorkflowExecuteOptions(ctx, { childWorkflowId: wfId, sourceNodeId: node.id }),
      ).then(
        (runCtx) => {
          const hasErrors = runCtx?.errors?.length > 0;
          return {
            name: branch.name,
            success: !hasErrors,
            runId: runCtx?.id || null,
            error: hasErrors ? runCtx.errors[0]?.error : null,
          };
        },
        (err) => ({
          name: branch.name,
          success: false,
          runId: null,
          error: err?.message || String(err),
        }),
      );
    };

    let branchResults;

    if (strategy === "fail-fast") {
      // Use Promise.all — first rejection aborts
      const timeout$ = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Parallel branches timed out after ${timeoutMs}ms`)), timeoutMs),
      );
      try {
        const raw = await Promise.race([
          Promise.all(branches.map((b) => {
            return makeBranchPromise(b).then((r) => {
              if (!r.success) throw Object.assign(new Error(r.error || "Branch failed"), { branchName: r.name });
              return r;
            });
          })),
          timeout$,
        ]);
        branchResults = raw;
      } catch (err) {
        // One branch failed fast
        branchResults = [{ name: err.branchName || "unknown", success: false, error: err.message }];
      }
    } else {
      // all-settled — wait for every branch
      const timeout$ = new Promise((resolve) =>
        setTimeout(() => resolve("__timeout__"), timeoutMs),
      );
      const allSettled$ = Promise.allSettled(branches.map(makeBranchPromise)).then((settled) =>
        settled.map((s, i) =>
          s.status === "fulfilled"
            ? s.value
            : { name: branches[i]?.name || `branch-${i}`, success: false, error: s.reason?.message || String(s.reason) },
        ),
      );

      const winner = await Promise.race([allSettled$, timeout$]);
      if (winner === "__timeout__") {
        branchResults = branches.map((b) => ({ name: b.name, success: false, error: "Timed out" }));
      } else {
        branchResults = winner;
      }
    }

    const results = {};
    for (const r of branchResults) results[r.name] = r;

    const successCount = branchResults.filter((r) => r.success).length;
    const failCount = branchResults.length - successCount;

    ctx.log(node.id, `parallel: ${successCount}/${branchResults.length} branches succeeded`);

    return {
      branches: branchResults.map((r) => r.name),
      results,
      successCount,
      failCount,
      totalBranches: branches.length,
    };
  },
});
export { registerNodeType, getNodeType, listNodeTypes, unregisterNodeType } from "./workflow-engine.mjs";
export {
  buildTaskContextBlock,
  evaluateTaskAssignedTriggerConfig,
  getBuiltinNodeDefinition,
  listBuiltinNodeDefinitions,
};
export {
  CALIBRATED_MAX_RISK_WITHOUT_HUMAN,
  normalizePlannerAreaKey,
};
export {
  CUSTOM_NODE_DIR_NAME,
  ensureCustomWorkflowNodesLoaded,
  getCustomNodeDir,
  inspectCustomWorkflowNodePlugins,
  scaffoldCustomNodeFile,
  startCustomNodeDiscovery,
  stopCustomNodeDiscovery,
} from "./workflow-nodes/custom-loader.mjs";
export async function ensureWorkflowNodeTypesLoaded(options = {}) {
  if (!customLoadPromise || options.forceReload) {
    customLoadPromise = ensureCustomWorkflowNodesLoaded(options);
  }
  await customLoadPromise;
  if (!customDiscoveryStarted) {
    startCustomNodeDiscovery(options);
    customDiscoveryStarted = true;
  }
  return listNodeTypes();
}
