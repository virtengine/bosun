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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import {
  buildPlannerSkipReasonHistogram,
  CALIBRATED_MAX_RISK_WITHOUT_HUMAN,
  CALIBRATED_MIN_IMPACT_SCORE,
  extractPlannerTasksFromWorkflowOutput,
  loadPlannerPriorState,
  parsePlannerJsonFromText,
  normalizePlannerAreaKey,
  normalizePlannerRiskLevel,
  normalizePlannerScore,
  PLANNER_RISK_ORDER,
  rankPlannerTaskCandidates,
  rankPlannerTaskCandidatesForResume,
  replayPlannerOutcomes,
  resolvePlannerMaterializationDefaults,
  resolvePlannerPriorFeedbackWeights,
  resolvePlannerPriorRankingConfig,
  resolvePlannerPriorStatePath,
  resolveTaskRepoAreas,
  savePlannerPriorState,
  shouldPersistPlannerPriorState,
} from "./agent.mjs";
import {
  cfgOrCtx,
  ensureAgentPoolMod,
  ensureTaskClaimsInitialized,
  ensureTaskClaimsMod,
  ensureTaskComplexityMod,
  ensureTaskStoreMod,
  formatExecSyncError,
  getWorkflowRuntimeState,
  isExistingBranchWorktreeError,
  isUnresolvedTemplateToken,
  pickTaskString,
  pickGitRef,
  resolveTaskRepositoryRoot,
} from "./transforms.mjs";
import { requireWorkflowActionApproval } from "../action-approval.mjs";
import { resolve, dirname, basename } from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";

/**
 * Non-blocking async replacement for execFileSync / execSync.
 * Uses spawn internally so the Node.js event loop is never stalled.
 * Resolves with stdout string; rejects with an error shaped like execFileSync's
 * errors (err.stdout, err.stderr, err.status, err.exitCode).
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
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { readConfigDocument } from "../../config/config.mjs";
import { resolveRepoRoot as resolveConfiguredRepoRoot } from "../../config/repo-root.mjs";
import { shouldRequireManagedPrePush } from "../../infra/guardrails.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { recordWorktreeRecoveryEvent } from "../../infra/worktree-recovery-state.mjs";
import { buildConflictResolutionPrompt } from "../../git/conflict-resolver.mjs";
import { normalizeBaseBranch } from "../../git/git-safety.mjs";
import { getBosunCoAuthorTrailer, shouldAddBosunCoAuthor } from "../../git/git-commit-helpers.mjs";
import { buildArchitectEditorFrame, hasRepoMapContext } from "../../lib/repo-map.mjs";
import {
  evaluateMarkdownSafety,
  recordMarkdownSafetyAuditEvent,
  resolveMarkdownSafetyPolicy,
} from "../../lib/skill-markdown-safety.mjs";
import {
  appendKnowledgeEntry,
  buildKnowledgeEntry,
  formatKnowledgeBriefing,
  initSharedKnowledge,
  retrieveKnowledgeEntries,
} from "../../workspace/shared-knowledge.mjs";
import { repairCommonMojibake } from "../../lib/mojibake-repair.mjs";
import { bootstrapWorktreeForPath, fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";

import {
  registerNodeType,
  BOSUN_ATTACHED_PR_LABEL,
  BOSUN_CREATED_PR_LABEL,
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

// CLAUDE:SUMMARY — workflow-nodes/actions
// Implements built-in workflow action nodes, including task prompt assembly and execution helpers.
const BOSUN_CREATED_PR_MARKER = "<!-- bosun-created -->";
const markdownSafetyPolicyCache = new Map();

function isUsableGitRepoRoot(candidate) {
  return Boolean(resolveGitTopLevelRoot(candidate));
}

function resolveGitTopLevelRoot(candidate) {
  const repoRoot = String(candidate || "").trim();
  if (!repoRoot) return "";
  if (isUnresolvedTemplateToken(repoRoot)) return "";
  try {
    const stats = statSync(repoRoot);
    if (!stats.isDirectory()) return "";
  } catch {
    return "";
  }
  try {
    return execGitArgsSync(["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
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
  const original = current;
  while (current) {
    const topLevel = resolveGitTopLevelRoot(current);
    if (hasGitMetadata(current) || topLevel) {
      return resolve(topLevel || current);
    }
    const parent = resolve(current, "..");
    if (
      basename(current).toLowerCase() === ".bosun"
      && parent
      && parent !== current
      && hasGitMetadata(parent)
    ) {
      return parent;
    }
    if (!parent || parent === current) break;
    current = parent;
  }
  return resolveGitTopLevelRoot(original) || "";
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
    if (hasGitMetadata(candidate) || isUsableGitRepoRoot(candidate)) {
      return resolveGitTopLevelRoot(candidate) || resolve(candidate);
    }
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
    if (isUsableGitRepoRoot(candidate)) {
      return resolveGitTopLevelRoot(candidate) || resolve(candidate);
    }
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
    if (WORKFLOW_AGENT_PLACEHOLDER_OUTPUTS.has(normalized)) continue;
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

function shouldEnforceManagedPushHook(repoRoot, worktreePath) {
  if (!isManagedBosunWorktree(worktreePath, repoRoot)) return false;
  try {
    return shouldRequireManagedPrePush(repoRoot);
  } catch {
    return true;
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
  const { getNodeType } = await import("../workflow-engine.mjs");
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

function appendBosunCreatedPrFooter(body = "") {
  const text = String(body || "");
  if (text.includes(BOSUN_CREATED_PR_MARKER) || /auto-created by bosun/i.test(text)) {
    return text;
  }
  const trimmed = text.trimEnd();
  const footer = `${BOSUN_CREATED_PR_MARKER}\nBosun-Origin: created`;
  return trimmed ? `${trimmed}\n\n---\n${footer}` : footer;
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


registerNodeType("action.run_agent", {
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
      delegationWatchdogTimeoutMs: { type: "number", default: 300000, description: "Stall threshold for delegated non-task workflows in ms" },
      delegationWatchdogMaxRecoveries: { type: "number", default: 1, description: "Maximum watchdog recovery retries for delegated workflows" },
    },
    required: ["prompt"],
  },
  async execute(node, ctx, engine) {
    const prompt = ctx.resolve(node.config?.prompt || "");
    const sdk = node.config?.sdk || "auto";
    const configuredCwd = ctx.resolve(node.config?.cwd || "");
    const runtimeWorktreePath = String(ctx.data?.worktreePath || "").trim();
    const cwd = isUnresolvedTemplateToken(configuredCwd)
      ? runtimeWorktreePath || process.cwd()
      : configuredCwd || runtimeWorktreePath || process.cwd();
    const _explicitTaskId = String(
      ctx.data?.taskId ||
        ctx.data?.task?.id ||
        ctx.data?.taskDetail?.id ||
        ctx.resolve(node.config?.taskId || "") ||
        "",
    ).trim();
    /* When no explicit taskId is available (e.g. PR Watchdog dispatch-fix-agent),
       auto-generate a stable per-invocation ID so every workflow agent run
       appears in Sessions and is linked back to its parent workflow run. */
    const trackedTaskId = _explicitTaskId ||
      `wf-${String(ctx.data?._workflowId || ctx.id || "run").slice(0, 12)}-${String(ctx.id || "").slice(0, 8)}-${node.id}`;
    const _isAutoGeneratedSession = !_explicitTaskId;
    const trackedTaskTitle = String(
      ctx.data?.task?.title ||
        ctx.data?.taskDetail?.title ||
        ctx.data?.taskInfo?.title ||
        ctx.data?.taskTitle ||
        (_isAutoGeneratedSession
          ? `${String(ctx.data?._workflowName || ctx.data?._workflowId || "Workflow").slice(0, 40)} › ${node.config?.label || node.id}`
          : "") ||
        trackedTaskId ||
        "",
    ).trim();
    const agentProfileId = String(
      ctx.resolve(node.config?.agentProfile || ctx.data?.agentProfile || ""),
    ).trim();
    const resolvedTimeout = Number(ctx.resolve(node.config?.timeoutMs ?? 3600000));
    const timeoutMs = Number.isFinite(resolvedTimeout) && resolvedTimeout > 0
      ? resolvedTimeout
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
    const strictCacheAnchoring =
      String(process.env.BOSUN_CACHE_ANCHOR_MODE || "")
        .trim()
        .toLowerCase() === "strict";
    const normalizeMarker = (value) => String(value || "").trim();
    const fallbackMarkers = [
      trackedTaskId,
      trackedTaskTitle,
      ctx.data?.taskDescription,
      ctx.data?.task?.description,
      ctx.data?.task?.body,
      ctx.data?.branch,
      ctx.data?.baseBranch,
      ctx.data?.worktreePath,
      ctx.data?.repoRoot,
      ctx.data?.repoSlug,
    ]
      .map(normalizeMarker)
      .filter(Boolean);
    const dynamicMarkers =
      Array.isArray(ctx.data?._taskPromptDynamicMarkers) &&
      ctx.data._taskPromptDynamicMarkers.length > 0
        ? ctx.data._taskPromptDynamicMarkers
        : fallbackMarkers;
    const assertStableSystemPrompt = (candidate) => {
      if (!strictCacheAnchoring) return;
      const leaked = dynamicMarkers.find((marker) => candidate.includes(marker));
      if (leaked) {
        throw new Error(
          `BOSUN_CACHE_ANCHOR_MODE=strict violation: system prompt leaked task-specific marker \"${leaked}\"`,
        );
      }
    };
    const toolContract = buildWorkflowAgentToolContract(cwd, agentProfileId);
    const effectiveSystemPrompt = String(configuredSystemPrompt || "").trim();
    assertStableSystemPrompt(effectiveSystemPrompt);
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
      repoRoot:
        String(ctx.data?.repoRoot || "").trim() && !isUnresolvedTemplateToken(ctx.data?.repoRoot)
          ? ctx.data.repoRoot
          : cwd,
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
    if (toolContract && !String(finalPrompt || "").includes("## Tool Capability Contract")) {
      finalPrompt = `${finalPrompt}\n\n${toolContract}`;
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
          const childRunOpts = {
            _parentRunId: ctx?.id || null,
            _rootRunId:
              String(
                ctx?.data?._workflowRootRunId ||
                ctx?.data?._rootRunId ||
                ctx?.id ||
                "",
              ).trim() || ctx?.id || null,
            _parentExecutionId: `node:${ctx?.id || "run"}:${node.id}`,
          };
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
            workflowNodeId: node.id,
            delegatedWorkflowId: candidate.id,
            delegatedWorkflowName: candidate.name || candidate.id,
            transitionKey: assignTransitionKey,
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
          const tracker = taskIdForDelegate ? getSessionTracker() : null;
          if (tracker && taskIdForDelegate) {
            if (!tracker.getSessionById(taskIdForDelegate)) {
              tracker.createSession({
                id: taskIdForDelegate,
                type: "task",
                taskId: taskIdForDelegate,
                metadata: {
                  title: taskTitleForDelegate || taskIdForDelegate,
                  workspaceId: String(ctx.data?.workspaceId || ctx.data?.activeWorkspace || "").trim() || undefined,
                  workspaceDir: String(cwd || "").trim() || undefined,
                  branch:
                    String(
                      ctx.data?.branch ||
                      ctx.data?.task?.branchName ||
                      "",
                    ).trim() || undefined,
                },
              });
            } else {
              tracker.updateSessionStatus(taskIdForDelegate, "active");
            }
            tracker.recordEvent(taskIdForDelegate, {
              role: "system",
              type: "system",
              content: `Delegating to agent workflow "${candidate.name || candidate.id}"`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
          }

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
              {
                ...eventPayload,
                _agentWorkflowActive: true,
              },
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
            const stalledDelegation = Boolean(
              subRun?.status === "running" &&
              watchdogState?.status === "running" &&
              (watchdogState?.isStuck === true || Number(watchdogState?.stuckMs || 0) >= delegatedWatchdogTimeoutMs)
            );

            if (!stalledDelegation) break;
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
            workflowNodeId: node.id,
            delegatedWorkflowId: candidate.id,
            delegatedWorkflowName: candidate.name || candidate.id,
            childRunId: subRun?.id || null,
            transitionKey: [subFailed ? "owner-mismatch" : "handoff-complete", node.id, subRun?.id || candidate.id].join(":"),
            at: Date.now(),
            timestamp: new Date().toISOString(),
          });
          if (tracker && taskIdForDelegate) {
            tracker.recordEvent(taskIdForDelegate, {
              role: subFailed ? "system" : "assistant",
              type: subFailed ? "error" : "agent_message",
              content: `Agent workflow "${candidate.name || candidate.id}" completed with status=${subStatus}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.endSession(taskIdForDelegate, subStatus);
          }

          const delegateResult = {
            success: !subFailed,
            delegated: true,
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
        const explicitTaskKey = String(ctx.resolve(node.config?.taskKey || "") || "").trim();
        const fallbackTaskKey =
          sessionId ||
          `${ctx.data?._workflowId || "workflow"}:${ctx.id}:${node.id}`;
        const recoveryTaskKey = options.taskKey || explicitTaskKey || fallbackTaskKey;
        const autoRecover = options.autoRecover ?? (node.config?.autoRecover !== false);
        const continueOnSession =
          options.continueOnSession ?? (node.config?.continueOnSession !== false);
        const continuePrompt = ctx.resolve(
          node.config?.continuePrompt ||
            "Continue exactly where you left off. Resume execution from the last incomplete step, avoid redoing completed work, and finish the task end-to-end.",
        );
        const parsedSessionRetries = Number(node.config?.sessionRetries);
        const parsedMaxContinues = Number(node.config?.maxContinues);
        const sessionRetries = Number.isFinite(parsedSessionRetries)
          ? Math.max(0, Math.min(10, Math.floor(parsedSessionRetries)))
          : 2;
        const maxContinues = Number.isFinite(parsedMaxContinues)
          ? Math.max(0, Math.min(10, Math.floor(parsedMaxContinues)))
          : 2;
        const sdkOverride = sdk === "auto" ? undefined : sdk;
        const modelOverride = node.config?.model
          ? String(ctx.resolve(node.config.model) || "").trim() || undefined
          : undefined;
        const maxRetainedEvents = Number.isFinite(Number(node.config?.maxRetainedEvents))
          ? Math.max(10, Math.min(500, Math.trunc(Number(node.config.maxRetainedEvents))))
          : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
        const tracker = trackedTaskId ? getSessionTracker() : null;
        const trackedSessionType = trackedTaskId ? "task" : "flow";

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
                workspaceDir: String(cwd || "").trim() || undefined,
                branch:
                  String(
                    ctx.data?.branch ||
                      ctx.data?.task?.branchName ||
                      ctx.data?.taskDetail?.branchName ||
                      "",
                  ).trim() || undefined,
                /* Workflow linkage — allows Sessions UI to trace back to the run */
                workflowRunId: String(ctx.id || "").trim() || undefined,
                workflowId: String(ctx.data?._workflowId || "").trim() || undefined,
                workflowName: String(ctx.data?._workflowName || ctx.data?._workflowId || "").trim() || undefined,
                autoGenerated: _isAutoGeneratedSession || undefined,
              },
            });
          } else {
            tracker.updateSessionStatus(trackedTaskId, "active");
            if (trackedTaskTitle) {
              tracker.renameSession(trackedTaskId, trackedTaskTitle);
            }
          }
          tracker.recordEvent(trackedTaskId, {
            role: "system",
            type: "system",
            content: `Workflow agent run started in ${cwd}`,
            timestamp: new Date().toISOString(),
            _sessionType: trackedSessionType,
          });
        }

        const launchExtra = {};
        if (sessionId) launchExtra.resumeThreadId = sessionId;
        if (sdkOverride) launchExtra.sdk = sdkOverride;
        if (modelOverride) launchExtra.model = modelOverride;
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
            if (tracker && trackedTaskId) {
              tracker.recordEvent(trackedTaskId, {
                ...(event && typeof event === "object" ? event : { content: String(event || "") }),
                _sessionType: trackedSessionType,
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

        let result = null;
        let success = false;
        try {
          if (
            autoRecover &&
            continueOnSession &&
            sessionId &&
            typeof agentPool.continueSession === "function"
          ) {
            ctx.log(node.id, `${passLabel} Recovery: continuing existing session ${sessionId}`.trim());
            try {
              result = await agentPool.continueSession(sessionId, continuePrompt, {
                timeout: timeoutMs,
                cwd,
                sdk: sdkOverride,
                model: modelOverride,
                slotOwnerKey,
                slotMeta,
                onSlotQueued: launchExtra.onSlotQueued,
                onSlotAcquired: launchExtra.onSlotAcquired,
              });
              if (result?.success) {
                ctx.log(node.id, `${passLabel} Recovery: continue-session succeeded`.trim());
              } else {
                ctx.log(
                  node.id,
                  `${passLabel} Recovery: continue-session failed (${result?.error || "unknown error"})`.trim(),
                  "warn",
                );
                result = null;
              }
            } catch (err) {
              ctx.log(
                node.id,
                `${passLabel} Recovery: continue-session threw (${err?.message || err})`.trim(),
                "warn",
              );
              result = null;
            }
          }

          if (!result && autoRecover && typeof agentPool.execWithRetry === "function") {
            ctx.log(
              node.id,
              `${passLabel} Recovery: execWithRetry taskKey=${recoveryTaskKey} retries=${sessionRetries} continues=${maxContinues}`.trim(),
            );
            result = await agentPool.execWithRetry(passPrompt, {
              taskKey: recoveryTaskKey,
              cwd,
              timeoutMs,
              maxRetries: sessionRetries,
              maxContinues,
              sessionType: trackedSessionType,
              sdk: sdkOverride,
              model: modelOverride,
              onEvent: launchExtra.onEvent,
              systemPrompt: effectiveSystemPrompt,
              slotOwnerKey,
              slotMeta,
              onSlotQueued: launchExtra.onSlotQueued,
              onSlotAcquired: launchExtra.onSlotAcquired,
            });
          }

          if (!result && autoRecover && typeof agentPool.launchOrResumeThread === "function") {
            ctx.log(node.id, `${passLabel} Recovery: launchOrResumeThread taskKey=${recoveryTaskKey}`.trim());
            result = await agentPool.launchOrResumeThread(passPrompt, cwd, timeoutMs, {
              taskKey: recoveryTaskKey,
              sessionType: trackedSessionType,
              sdk: sdkOverride,
              model: modelOverride,
              onEvent: launchExtra.onEvent,
              systemPrompt: effectiveSystemPrompt,
              slotOwnerKey,
              slotMeta,
              onSlotQueued: launchExtra.onSlotQueued,
              onSlotAcquired: launchExtra.onSlotAcquired,
            });
          }

          if (!result) {
            result = await agentPool.launchEphemeralThread(passPrompt, cwd, timeoutMs, {
              ...launchExtra,
              systemPrompt: effectiveSystemPrompt,
              slotOwnerKey,
              slotMeta,
              onSlotQueued: launchExtra.onSlotQueued,
              onSlotAcquired: launchExtra.onSlotAcquired,
            });
          }
          success = result?.success === true;
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
              tracker.recordEvent(trackedTaskId, {
                role: success ? "assistant" : "system",
                type: success ? "agent_message" : "error",
                content: fallbackContent,
                timestamp: new Date().toISOString(),
                _sessionType: trackedSessionType,
              });
            }
          }
          tracker.endSession(
            trackedTaskId,
            deriveWorkflowAgentSessionStatus(result, { streamEventCount }),
          );
        }

        const threadId = result?.threadId || result?.sessionId || sessionId || null;
        if (persistSession && threadId) {
          ctx.data.sessionId = threadId;
          ctx.data.threadId = threadId;
        }
        const digest = buildAgentExecutionDigest(result, streamLines, maxRetainedEvents);

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
    const recoveryState = {
      recreated: false,
      detectedIssues: new Set(),
      phase: null,
      worktreePath: null,
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
      const details = [
        `outcome=${payload.outcome}`,
        `branch=${payload.branch}`,
        payload.taskId ? `taskId=${payload.taskId}` : "",
        payload.phase ? `phase=${payload.phase}` : "",
        payload.worktreePath ? `path=${payload.worktreePath}` : "",
        payload.detectedIssues.length ? `issues=${payload.detectedIssues.join(",")}` : "",
        payload.error ? `error=${payload.error}` : "",
      ].filter(Boolean).join(" ");
      ctx.log(node.id, `[worktree-recovery] ${details}`);
      await recordWorktreeRecoveryEvent(repoRoot, payload);
    };

    try {
      const escapedPrompt = String(finalPrompt || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      const escapedCwd = String(cwd || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      const output = execSync(
        `node -e "import('../../agent/agent-pool.mjs').then(m => m.launchEphemeralThread(process.argv[1], process.argv[2], ${timeoutMs}).then(r => console.log(JSON.stringify(r))))" "${escapedPrompt}" "${escapedCwd}"`,
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

registerNodeType("action.run_command", {
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
    const command = normalizeLegacyWorkflowCommand(resolvedCommand);
    const cwd = resolveWorkflowCwdValue(
      ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd()),
      ctx.data?.worktreePath || process.cwd(),
    );
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

    if (command !== resolvedCommand) {
      ctx.log(node.id, `Normalized legacy command for portability: ${command}`);
    }
    ctx.log(node.id, `Running: ${usedArgv ? `${command} ${commandArgs.join(" ")}`.trim() : command}`);
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.run_command",
      repoRoot: cwd,
      command,
      args: commandArgs,
    });
    try {
      const output = await spawnAsync(command, usedArgv ? commandArgs : [], {
        cwd,
        timeout,
        stdio: node.config?.captureOutput !== false ? "pipe" : "inherit",
        env: commandEnv,
        shell: !usedArgv,
      });
      ctx.log(node.id, `Command succeeded`);
      return { success: true, output: parseOutput(output), exitCode: 0 };
    } catch (err) {
      const output = err.stdout?.toString() || "";
      const stderr = err.stderr?.toString() || "";
      const result = {
        success: false,
        output: parseOutput(output),
        stderr,
        exitCode: err.status,
        error: err.message,
      };
      if (node.config?.failOnError) {
        const reason = trimLogText(stderr || output || err.message, 400) || err.message;
        throw new Error(reason);
      }
      return result;
    }
  },
});

registerNodeType("action.execute_workflow", {
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

    const childInput = {
      ...inheritedInput,
      ...configuredInput,
      _workflowStack: [...workflowStack, workflowId],
    };

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
        dispatched = Promise.resolve(engine.execute(workflowId, childInput));
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
    const childCtx = await engine.execute(workflowId, childInput);
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

registerNodeType("action.create_task", {
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
      const task = await createKanbanTaskWithProject(kanban, {
        title,
        description,
        status: node.config?.status || "todo",
        priority: node.config?.priority,
        tags: node.config?.tags,
        projectId: node.config?.projectId,
      }, node.config?.projectId);
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

registerNodeType("action.update_task_status", {
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
    const status = node.config?.status;
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

    if (status === "inreview") {
      const prNodeOutput =
        ctx.getNodeOutput?.("create-pr") ||
        ctx.data?.createPr ||
        {};
      const prNumber = Number(
        prNodeOutput?.prNumber ??
        prNodeOutput?.number ??
        ctx.data?.prNumber,
      );
      const prUrl = String(
        prNodeOutput?.prUrl ||
        prNodeOutput?.url ||
        ctx.data?.prUrl ||
        "",
      ).trim();
      const branchName = String(
        prNodeOutput?.branch ||
        ctx.data?.branch ||
        ctx.data?.task?.branchName ||
        "",
      ).trim();
      if (branchName) updateOptions.branchName = branchName;
      if (Number.isFinite(prNumber) && prNumber > 0) updateOptions.prNumber = prNumber;
      if (prUrl) updateOptions.prUrl = prUrl;
    }

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

    if (kanban?.updateTaskStatus) {
      await kanban.updateTaskStatus(taskId, status, updateOptions);
      if ((status === "inreview" || blockedReasonProvided) && typeof kanban.updateTask === "function") {
        const patch = {};
        if (updateOptions.branchName) patch.branchName = updateOptions.branchName;
        if (updateOptions.prNumber) patch.prNumber = updateOptions.prNumber;
        if (updateOptions.prUrl) patch.prUrl = updateOptions.prUrl;
        if (blockedReasonProvided) patch.blockedReason = String(blockedReason || "").trim() || null;
        if (Object.keys(patch).length > 0) {
          await kanban.updateTask(taskId, patch);
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

registerNodeType("action.git_operations", {
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
        commit: `git add -A && git commit -m "${message.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
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
      try {
        const output = execSync(cmd, { cwd, encoding: "utf8", timeout: 120000 });
        return { success: true, output: output?.trim(), operation: op, command: cmd };
      } catch (err) {
        return { success: false, error: err.message, operation: op, command: cmd };
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
        const result = runGitCommand(resolved);
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
    return runGitCommand(resolved);
  },
});

registerNodeType("action.create_pr", {
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
      repoSlug: { type: "string", description: "Optional owner/repo override for gh commands" },
      draft: { type: "boolean", default: false },
      labels: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Comma-separated or array of labels",
      },
      reviewers: {
        oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
        description: "Comma-separated or array of reviewer handles",
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

    const title = normalizePrText(ctx.resolve(node.config?.title || ""));
    const body = ctx.resolve(node.config?.body || "");
    const resolvedBody = appendBosunCreatedPrFooter(body);
    const baseInput = ctx.resolve(node.config?.base || node.config?.baseBranch || "main");
    let base = String(baseInput || "main").trim() || "main";
    try {
      base = normalizeBaseBranch(base).branch;
    } catch {
    }
    const branch = ctx.resolve(node.config?.branch || "");
    const repoSlug = ctx.resolve(node.config?.repoSlug || ctx.data?.repoSlug || "");
    const draft = node.config?.draft === true;
    const failOnError = node.config?.failOnError === true;
    const cwd = ctx.resolve(node.config?.cwd || ctx.data?.worktreePath || process.cwd());
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.create_pr",
      repoRoot: ctx?.data?.repoRoot || ctx?.data?.repoPath || cwd,
    });

    // Normalize labels/reviewers to arrays
    const toList = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String).filter(Boolean);
      return String(v).split(",").map((s) => s.trim()).filter(Boolean);
    };
    const labels = Array.from(new Set([
      ...toList(ctx.resolve(node.config?.labels || "")),
      BOSUN_ATTACHED_PR_LABEL,
      BOSUN_CREATED_PR_LABEL,
    ]));
    const reviewers = toList(ctx.resolve(node.config?.reviewers || ""));
    if (!title) {
      const error = "PR title is required";
      ctx.log(node.id, error);
      return { success: false, error, title, base, branch: branch || null, repoSlug: repoSlug || null };
    }
    const execOptions = {
      cwd,
      encoding: "utf8",
      timeout: 60000,
      env: makeIsolatedGitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
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
            const editArgs = ["pr", "edit", String(prNumber), "--add-label", labels.join(",")];
            if (repoSlug) editArgs.push("--repo", repoSlug);
            execFileSync("gh", editArgs, execOptions);
          } catch {
          }
        }
        return {
          success: true,
          existing: true,
          prUrl: String(existing?.url || "").trim(),
          prNumber,
          title,
          base: base || String(existing?.baseRefName || "").trim() || null,
          branch: branch || String(existing?.headRefName || "").trim() || null,
          draft,
          labels,
          reviewers,
          output: String(existing?.url || `existing-pr-${prNumber}`),
        };
      } catch {
        return null;
      }
    };

    // Build gh pr create command
    const args = ["gh", "pr", "create"];
    args.push("--title", JSON.stringify(title));
    // gh pr create requires either --body (empty is allowed) or --fill* in non-interactive mode.
    args.push("--body", JSON.stringify(String(resolvedBody)));
    if (base) args.push("--base", base);
    if (branch) args.push("--head", branch);
    if (repoSlug) args.push("--repo", repoSlug);
    if (draft) args.push("--draft");
    if (labels.length) args.push("--label", labels.join(","));
    if (reviewers.length) args.push("--reviewer", reviewers.join(","));

    const cmd = args.join(" ");
    ctx.log(node.id, `Creating PR: ${cmd}`);

    try {
      const output = execSync(cmd, execOptions);
      const trimmed = (output || "").trim();
      // gh pr create prints the PR URL on success
      const urlMatch = trimmed.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      const prNumber = urlMatch ? parseInt(urlMatch[1], 10) : null;
      const prUrl = urlMatch ? urlMatch[0] : trimmed;
      ctx.log(node.id, `PR created: ${prUrl}`);
      return {
        success: true,
        prUrl,
        prNumber,
        title,
        base,
        branch: branch || null,
        draft,
        labels,
        reviewers,
        output: trimmed,
        createdByBosun: true,
      };
    } catch (err) {
      const errorMsg = err?.stderr?.toString?.()?.trim() || err?.message || String(err);
      ctx.log(node.id, `PR creation failed: ${errorMsg}`);
      const existingPr = findExistingPr();
      if (existingPr) {
        ctx.log(node.id, `Resolved existing PR #${existingPr.prNumber}: ${existingPr.prUrl || "(url unavailable)"}`);
        return existingPr;
      }
      if (failOnError) {
        return { success: false, error: errorMsg, command: cmd };
      }
      // Graceful fallback — record handoff for Bosun management
      ctx.log(node.id, `Falling back to Bosun-managed PR lifecycle handoff`);
      return {
        success: true,
        handedOff: true,
        lifecycle: "bosun_managed",
        action: "pr_handoff",
        message: "gh CLI failed; Bosun manages pull-request lifecycle.",
        title,
        body: resolvedBody,
        base,
        branch: branch || null,
        draft,
        labels,
        reviewers,
        cwd,
        ghError: errorMsg,
        createdByBosun: true,
      };
    }
  },
});

registerNodeType("action.write_file", {
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
  async execute(node, ctx) {
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

registerNodeType("action.read_file", {
  describe: () => "Read content from a file",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
  async execute(node, ctx) {
    const filePath = ctx.resolve(node.config?.path || "");
    if (!existsSync(filePath)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    const content = readFileSync(filePath, "utf8");
    return { success: true, content, path: filePath };
  },
});

registerNodeType("action.set_variable", {
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
  async execute(node, ctx) {
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
    ctx.log(node.id, `Set variable: ${key} = ${JSON.stringify(value)}`);
    return { key, value };
  },
});

registerNodeType("action.delay", {
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
  async execute(node, ctx) {
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

// ═══════════════════════════════════════════════════════════════════════════
//  VALIDATION — Verification gates
// ═══════════════════════════════════════════════════════════════════════════

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

registerNodeType("action.materialize_planner_tasks", {
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
      applyTaskGraph: { type: "boolean", default: true, description: "Apply parent/dependency graph links from planner output when supported" },
      parentTaskId: { type: "string", description: "Optional existing task ID to use as the parent for top-level planned tasks" },
    },
  },
  async execute(node, ctx, engine) {
    const plannerNodeId = String(ctx.resolve(node.config?.plannerNodeId || "run-planner")).trim() || "run-planner";
    const plannerOutput = ctx.getNodeOutput(plannerNodeId) || {};
    const outputText = String(plannerOutput?.output || "").trim();
    const plannerPayload = parsePlannerJsonFromText(outputText);
    const maxTasks = Number(ctx.resolve(node.config?.maxTasks || ctx.data?.taskCount || 5)) || 5;
    const failOnZero = node.config?.failOnZero !== false;
    // Use nullish coalescing so an explicit minCreated:0 is respected (not coerced to 1).
    // Default: 1 when failOnZero is true (classic behaviour), 0 when failOnZero is false
    // (all-skipped idempotent resumes should still succeed).
    const minCreated = Number(ctx.resolve(node.config?.minCreated ?? (failOnZero ? 1 : 0)));
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
    const materializationDefaults = resolvePlannerMaterializationDefaults(ctx);
    const plannerFeedback =
      ctx.data?._plannerFeedback && typeof ctx.data._plannerFeedback === "object" && !Array.isArray(ctx.data._plannerFeedback)
        ? ctx.data._plannerFeedback
        : {};
    const rankingConfig = resolvePlannerPriorRankingConfig(plannerFeedback?.rankingSignals?.config || null);
    const feedbackWeights = resolvePlannerPriorFeedbackWeights(plannerFeedback?.rankingSignals?.weights || null);

    const parsedTasks = extractPlannerTasksFromWorkflowOutput(outputText, Number.MAX_SAFE_INTEGER);
    if (!parsedTasks.length) {
      // Log diagnostic info to help debug planner output format issues
      const outputPreview = outputText.length > 200
        ? `${outputText.slice(0, 200)}…`
        : outputText || "(empty)";
      const message = `Planner output from "${plannerNodeId}" did not include parseable tasks. ` +
        `Output length: ${outputText.length} chars. Preview: ${outputPreview}`;
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
        impact: task.impact,
        confidence: task.confidence,
        risk: task.risk,
        estimated_effort: task.estimatedEffort,
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
      const createdTask = await createKanbanTaskWithProject(kanban, payload, projectId);
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

    // When failOnZero is true enforce at least 1 (or minCreated, whichever is larger).
    // When failOnZero is false the caller explicitly accepts 0 created tasks (idempotent resume).
    const minRequired = failOnZero ? Math.max(1, minCreated) : minCreated;
    if (failOnZero && createdCount < minRequired) {
      throw new Error(
        `Planner materialization created ${createdCount} tasks (required: ${minRequired})`,
      );
    }

    return {
      success: createdCount >= minRequired,
      parsedCount: parsedTasks.length,
      createdCount,
      skippedCount,
      skipReasonHistogram,
      materializationOutcomes,
      created,
      skipped,
      graphMaterialization,
      rankedTasks,
      tasks: parsedTasks,
    };
  },
});

registerNodeType("action.continue_session", {
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

registerNodeType("action.restart_agent", {
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

registerNodeType("action.bosun_cli", {
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

// ═══════════════════════════════════════════════════════════════════════════
//  BOSUN NATIVE TOOLS — Invoke Bosun's built-in/custom tools and workflows
//  from within workflow nodes. These nodes enable:
//    1. Programmatic tool invocation with structured I/O (action.bosun_tool)
//    2. Lightweight sub-workflow invocation with data piping (action.invoke_workflow)
//    3. Direct Bosun function calls (action.bosun_function)
//
//  Design: Every node produces structured output that can be piped via
//  {{nodeId.field}} templates to downstream nodes. Output extraction,
//  variable storage, and port-based routing are supported across all nodes.
// ═══════════════════════════════════════════════════════════════════════════

/** Module-scope lazy caches for Bosun tool imports (per AGENTS.md rules). */
let _customToolsMod = null;
async function getCustomToolsMod() {
  if (!_customToolsMod) {
    _customToolsMod = await import("../../agent/agent-custom-tools.mjs");
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
    _kanbanMod = await import("../../kanban/kanban-adapter.mjs");
  }
  return _kanbanMod;
}

// ── action.bosun_tool ─────────────────────────────────────────────────────
// Invoke any Bosun built-in or custom tool programmatically with structured
// input/output. Unlike action.bosun_cli (which shells out), this executes
// the tool script directly in-process and returns parsed, structured data.

registerNodeType("action.bosun_tool", {
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

    // ── Structured data extraction (same pattern as MCP tool call) ──
    if (node.config?.extract && exitSuccess) {
      const adapter = await getMcpAdapter();
      const sourceData = typeof data === "object" && data !== null ? data : { text: data };
      const extracted = adapter.extractMcpOutput(sourceData, node.config.extract);
      output = { ...output, extracted, ...extracted };
      ctx.log(node.id, `Extracted ${Object.keys(extracted).length} field(s)`);
    }

    // ── Output mapping ──
    if (node.config?.outputMap && exitSuccess) {
      const adapter = await getMcpAdapter();
      const mapped = adapter.mapOutputFields(output, node.config.outputMap, ctx);
      output = { ...output, mapped, ...mapped };
      ctx.log(node.id, `Mapped ${Object.keys(mapped).length} field(s)`);
    }

    // ── Port-based routing ──
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

    if (exitSuccess) {
      ctx.log(node.id, `Tool "${toolId}" completed (exit ${toolResult.exitCode})`);
    } else {
      ctx.log(node.id, `Tool "${toolId}" failed (exit ${toolResult.exitCode}): ${toolResult.stderr?.slice(0, 200)}`, "warn");
    }

    return output;
  },
});

// ── action.invoke_workflow ────────────────────────────────────────────────
// Lightweight sub-workflow invocation with automatic output forwarding.
// While action.execute_workflow is comprehensive, this node provides
// simpler ergonomics for the common case of "run workflow X and pipe
// its output to the next node".

registerNodeType("action.invoke_workflow", {
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
    const childInput = {
      ...(pipeContext ? { ...ctx.data } : {}),
      ...(typeof resolvedInput === "object" && resolvedInput !== null ? resolvedInput : {}),
      _parentWorkflowId: ctx.data?._workflowId || "",
      _workflowStack: normalizeWorkflowStack(ctx.data?._workflowStack),
    };
    const parentId = String(ctx.data?._workflowId || "").trim();
    if (parentId && childInput._workflowStack[childInput._workflowStack.length - 1] !== parentId) {
      childInput._workflowStack.push(parentId);
    }
    childInput._workflowStack.push(workflowId);

    // ── Dispatch mode ──
    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching workflow "${workflowId}" (fire-and-forget)`);
      let promise;
      try {
        promise = Promise.resolve(engine.execute(workflowId, childInput));
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

    // ── Sync mode — execute and harvest output ──
    ctx.log(node.id, `Invoking workflow "${workflowId}" (sync)`);

    let childCtx;
    const timeoutMs = node.config?.timeout || 300000;
    try {
      childCtx = await Promise.race([
        engine.execute(workflowId, childInput),
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

    // ── Extract outputs from child workflow ──
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

// ── action.bosun_function ─────────────────────────────────────────────────
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
  // ── Tool operations ──
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
  // ── Task operations ──
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
  // ── Git operations ──
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
  // ── Workflow operations ──
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
  // ── Config operations ──
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

registerNodeType("action.bosun_function", {
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

    // ── Structured data extraction ──
    if (node.config?.extract) {
      const adapter = await getMcpAdapter();
      const sourceData = typeof result === "object" && result !== null ? result : { data: result };
      const extracted = adapter.extractMcpOutput(sourceData, node.config.extract);
      output = { ...output, extracted, ...extracted };
      ctx.log(node.id, `Extracted ${Object.keys(extracted).length} field(s)`);
    }

    // ── Output mapping ──
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

registerNodeType("action.handle_rate_limit", {
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
  async execute(node, ctx) {
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

registerNodeType("action.ask_user", {
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

registerNodeType("action.analyze_errors", {
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

registerNodeType("action.refresh_worktree", {
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

    const repoRoot = (() => {
      try {
        return execGitArgsSync(["rev-parse", "--show-toplevel"], {
          cwd,
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || cwd;
      } catch {
        return cwd;
      }
    })();

    const describeState = (state) => {
      const issueText = Array.isArray(state?.issues) ? state.issues.join(", ") : "";
      const conflictText = Array.isArray(state?.conflictFiles) && state.conflictFiles.length > 0
        ? ` conflicts=${state.conflictFiles.join(",")}`
        : "";
      return `${issueText}${conflictText}`.trim() || "unknown";
    };

    const handleInvalidState = (phase) => {
      const state = inspectManagedWorktreeState(cwd);
      if (!state.invalid) return null;
      const detail = describeState(state);
      if (!isManagedBosunWorktree(cwd, repoRoot)) {
        return {
          success: false,
          operation: op,
          repoRoot,
          invalidState: state,
          needsManualResolution: true,
          error: `Worktree refresh blocked during ${phase}: ${detail}`,
        };
      }
      resetManagedWorktree(repoRoot, cwd, state.gitDir);
      return {
        success: false,
        operation: op,
        repoRoot,
        invalidState: state,
        removed: true,
        needsReacquire: true,
        error: `Managed worktree was removed after stale refresh state during ${phase}: ${detail}`,
      };
    };

    const commands = {
      fetch: [["fetch", "--all", "--prune"]],
      pull: [["pull", "origin", branch, "--rebase"]],
      reset_hard: [["reset", "--hard", "HEAD"], ["clean", "-fd"]],
      clean: [["clean", "-fd"]],
      checkout_main: [["checkout", branch], ["pull", "origin", branch]],
    };

    const steps = commands[op];
    if (!steps) throw new Error(`Unknown worktree operation: ${op}`);

    const preflightFailure = handleInvalidState("preflight");
    if (preflightFailure) {
      ctx.log(node.id, preflightFailure.error, "warn");
      return preflightFailure;
    }

    ctx.log(node.id, `Refreshing worktree (${op}) in ${cwd}`);
    await requireWorkflowActionApproval({
      node,
      ctx,
      engine,
      nodeType: "action.refresh_worktree",
      repoRoot,
    });
    try {
      const output = steps
        .map((args) => execGitArgsSync(args, {
          cwd,
          encoding: "utf8",
          timeout: 120000,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim())
        .filter(Boolean)
        .join("\n");
      const postflightFailure = handleInvalidState("post-refresh");
      if (postflightFailure) {
        ctx.log(node.id, postflightFailure.error, "warn");
        return { ...postflightFailure, output };
      }
      return { success: true, output, operation: op, repoRoot };
    } catch (err) {
      const recoveryFailure = handleInvalidState("error-recovery");
      if (recoveryFailure) {
        ctx.log(node.id, recoveryFailure.error, "warn");
        return recoveryFailure;
      }
      return { success: false, error: err.message, operation: op, repoRoot };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  MCP Tool Call — execute a tool on an installed MCP server
// ═══════════════════════════════════════════════════════════════════════════

// Lazy-import MCP registry — cached at module scope per AGENTS.md rules.
let _mcpRegistry = null;
async function getMcpRegistry() {
  if (!_mcpRegistry) {
    _mcpRegistry = await import("../mcp-registry.mjs");
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

// ── Lazy-import MCP workflow adapter — cached at module scope per AGENTS.md rules.
let _mcpAdapter = null;
async function getMcpAdapter() {
  if (!_mcpAdapter) {
    _mcpAdapter = await import("../mcp-workflow-adapter.mjs");
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

registerNodeType("action.mcp_tool_call", {
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
  async execute(node, ctx) {
    const serverId = ctx.resolve(node.config?.server || "");
    const toolName = ctx.resolve(node.config?.tool || "");
    const timeoutMs = node.config?.timeoutMs || 30000;

    if (!serverId) throw new Error("action.mcp_tool_call: 'server' is required");
    if (!toolName) throw new Error("action.mcp_tool_call: 'tool' is required");

    ctx.log(node.id, `MCP tool call: ${serverId}/${toolName}`);

    let rawOutput;
    try {
      rawOutput = await _executeMcpToolCall(serverId, toolName, node.config?.input, timeoutMs, ctx);
    } catch (err) {
      ctx.log(node.id, `MCP tool call failed: ${err.message}`);
      return {
        success: false,
        error: err.message,
        server: serverId,
        tool: toolName,
        matchedPort: "error",
        port: "error",
      };
    }

    if (!rawOutput.success) {
      ctx.log(node.id, `MCP tool returned error: ${rawOutput.error || "unknown"}`);
    } else {
      ctx.log(node.id, `MCP tool call completed (${rawOutput.contentType})`);
    }

    // ── Structured data extraction ──
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

    // ── Output mapping ──
    if (node.config?.outputMap) {
      const mappedFields = adapter.mapOutputFields(extracted, node.config.outputMap, ctx);
      extracted = { ...extracted, mapped: mappedFields };
      // Merge mapped fields to top-level
      Object.assign(extracted, mappedFields);
      ctx.log(node.id, `Mapped ${Object.keys(mappedFields).length} field(s)`);
    }

    // ── Port-based routing ──
    const port = adapter.resolveOutputPort(extracted, node.config?.portConfig);
    extracted.matchedPort = port;
    extracted.port = port;

    // Store in ctx.data if outputVariable is set
    if (node.config?.outputVariable) {
      ctx.data[node.config.outputVariable] = extracted;
    }

    return extracted;
  },
});

registerNodeType("action.mcp_list_tools", {
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
  async execute(node, ctx) {
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

// ── action.mcp_pipeline — Chain multiple MCP tool calls with data piping ──

registerNodeType("action.mcp_pipeline", {
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
  async execute(node, ctx) {
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

      // ── Condition check ──
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

      // ── Build input from pipeline wiring ──
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

      // ── Execute tool call ──
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

      // ── Extract structured fields ──
      if (step.extract && stepOutput.success) {
        const sourceData = stepOutput.data ?? stepOutput;
        const extractedFields = adapter.extractMcpOutput(sourceData, step.extract);
        stepOutput = { ...stepOutput, extracted: extractedFields };
        Object.assign(stepOutput, extractedFields);
      }

      // ── Output mapping ──
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

// ── transform.mcp_extract — Extract structured data from any MCP output ──

registerNodeType("action.allocate_slot", {
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
  async execute(node, ctx) {
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
    const envPrefixes = ["VE_", "VK_", "BOSUN_", "COPILOT_", "CLAUDE_", "CODEX_"];
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

// ── action.release_slot ─────────────────────────────────────────────────────

registerNodeType("action.release_slot", {
  describe: () =>
    "Release a previously allocated execution slot. Restores saved env vars " +
    "for parallel isolation. Idempotent — safe on double-call.",
  schema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task ID whose slot to release" },
    },
  },
  async execute(node, ctx) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const slot = ctx.data?._allocatedSlot;

    if (slot && slot.taskId === taskId) {
      // Restore env vars saved during allocation
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

function recordDelegationAuditEvent(ctx, event) {
  if (!ctx || !event || typeof event !== "object") return null;
  if (typeof ctx.recordDelegationEvent === "function") return ctx.recordDelegationEvent(event);
  const data = ctx.data || (ctx.data = {});
  const trail = Array.isArray(data._delegationAuditTrail) ? data._delegationAuditTrail : [];
  data._delegationAuditTrail = trail;
  data._workflowDelegationTrail = trail;
  const key = String(event.transitionKey || event.idempotencyKey || event.key || "").trim();
  if (key) {
    const existing = trail.find((entry) => String(entry?.transitionKey || entry?.idempotencyKey || entry?.key || "").trim() === key);
    if (existing) return existing;
  }
  const entry = { ...event };
  trail.push(entry);
  return {
    ...entry,
    recorded: true,
  };
}

function getDelegationTransitionStore(ctx) {
  const runtimeState = getWorkflowRuntimeState(ctx);
  if (!runtimeState.delegationTransitionResults || typeof runtimeState.delegationTransitionResults !== "object") {
    runtimeState.delegationTransitionResults = {};
  }
  return runtimeState.delegationTransitionResults;
}

function getExistingDelegationTransition(ctx, transitionKey) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  return getDelegationTransitionStore(ctx)[key] || null;
}

function setDelegationTransitionResult(ctx, transitionKey, value) {
  const key = String(transitionKey || "").trim();
  if (!key) return null;
  getDelegationTransitionStore(ctx)[key] = value;
  return value;
}

function persistDelegationTransitionGuard(ctx, transitionKey, value = {}) {
  const key = String(transitionKey || "").trim();
  if (!key || typeof ctx?.setDelegationTransitionGuard !== "function") return null;
  return ctx.setDelegationTransitionGuard(key, {
    ...value,
    transitionKey: value?.transitionKey || key,
    idempotencyKey: value?.idempotencyKey || key,
  });
}

// ── action.claim_task ───────────────────────────────────────────────────────

registerNodeType("action.claim_task", {
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
      renewIntervalMs: { type: "number", default: 300000, description: "Renewal interval (5 min default)" },
      instanceId: { type: "string", description: "Orchestrator instance ID (auto-gen if omitted)" },
      branch: { type: "string", description: "Branch for claim metadata" },
      sdk: { type: "string", description: "SDK for claim metadata" },
      model: { type: "string", description: "Model for claim metadata" },
    },
    required: ["taskId"],
  },
  async execute(node, ctx) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const taskTitle = cfgOrCtx(node, ctx, "taskTitle");
    const ttlMinutes = node.config?.ttlMinutes ?? 180;
    const renewIntervalMs = node.config?.renewIntervalMs ?? 300000;
    const instanceId = cfgOrCtx(node, ctx, "instanceId") || ctx.data?._agentInstanceId || `wf-${randomUUID().slice(0, 8)}`;
    const branch = cfgOrCtx(node, ctx, "branch");
    const sdk = cfgOrCtx(node, ctx, "resolvedSdk", cfgOrCtx(node, ctx, "sdk"));
    const model = cfgOrCtx(node, ctx, "resolvedModel", cfgOrCtx(node, ctx, "model"));

    if (!taskId) throw new Error("action.claim_task: taskId is required");

    const runtimeState = getWorkflowRuntimeState(ctx);
    if (!runtimeState.delegationTransitionResults || typeof runtimeState.delegationTransitionResults !== "object") {
      runtimeState.delegationTransitionResults = {};
    }
    const delegationTransitionType = String(cfgOrCtx(node, ctx, "delegationTransitionType") || "").trim();
    const delegationTransitionKey = String(cfgOrCtx(node, ctx, "delegationTransitionKey") || "").trim();
    const stableDefaultTransitionKey = [
      delegationTransitionType || "assign",
      taskId,
    ].join(":");
    const idempotencyKey = String(
      delegationTransitionKey ||
      cfgOrCtx(node, ctx, "idempotencyKey", "") || stableDefaultTransitionKey,
    ).trim();
    const transition = idempotencyKey
      ? (runtimeState.delegationTransitionResults[idempotencyKey] ||= {
          type: "claim_task",
          transitionKey: idempotencyKey,
          inFlightPromise: null,
          result: null,
          completed: false,
        })
      : null;
    const existingTransition = idempotencyKey
      ? getExistingDelegationTransition(ctx, idempotencyKey)
      : null;
    const persistedTransition = !existingTransition && idempotencyKey && typeof ctx.getDelegationTransitionGuard === "function"
      ? ctx.getDelegationTransitionGuard(idempotencyKey)
      : null;
    const replayTransition = existingTransition || persistedTransition;
    if (replayTransition && replayTransition.type === "claim_task") {
      if (replayTransition.claimToken) ctx.data._claimToken = replayTransition.claimToken;
      if (replayTransition.instanceId) ctx.data._claimInstanceId = replayTransition.instanceId;
      return {
        ...(replayTransition.result || {
          success: true,
          taskId,
          claimToken: replayTransition.claimToken || null,
          instanceId: replayTransition.instanceId || instanceId,
        }),
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    if (transition?.completed && transition.result) {
      if (transition.claimToken) ctx.data._claimToken = transition.claimToken;
      if (transition.instanceId) ctx.data._claimInstanceId = transition.instanceId;
      return {
        ...transition.result,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    if (transition?.inFlightPromise) {
      const inFlightResult = await transition.inFlightPromise;
      return {
        ...inFlightResult,
        replayed: true,
        deduped: true,
        idempotentReplay: true,
      };
    }

    const claims = await ensureTaskClaimsMod();
    const renewClaimFn =
      typeof claims.renewClaim === "function"
        ? claims.renewClaim.bind(claims)
        : typeof claims.renewTaskClaim === "function"
          ? claims.renewTaskClaim.bind(claims)
          : null;
    const handleFatalRenewal = (message, token) => {
      ctx.log(node.id, `Claim renewal fatal: ${message} — aborting task`);
      if (runtimeState.claimRenewTimer) {
        try { clearInterval(runtimeState.claimRenewTimer); } catch { }
      }
      runtimeState.claimRenewTimer = null;
      ctx.data._claimRenewTimer = null;
      ctx.data._claimStolen = true;
      const ownerMismatchKey = ["owner-mismatch", taskId, instanceId, token || ctx.data?._claimToken || "none", "renew"].join(":");
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

    const claimExecution = (async () => {
      persistDelegationTransitionGuard(ctx, idempotencyKey, {
        type: "claim_task",
        status: "in_progress",
        taskId,
        instanceId,
      });
      try {
        await ensureTaskClaimsInitialized(ctx, claims);
      } catch (initErr) {
        ctx.log(node.id, `Claim init failed: ${initErr.message}`);
        const failureResult = { success: false, error: initErr.message, taskId, alreadyClaimed: false };
        if (transition) {
          transition.completed = false;
          transition.result = null;
        }
        persistDelegationTransitionGuard(ctx, idempotencyKey, {
          type: "claim_task",
          status: "failed",
          taskId,
          instanceId,
          error: initErr.message,
          result: { ...failureResult },
        });
        return failureResult;
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
        const failureResult = { success: false, error: err.message, taskId, alreadyClaimed: false };
        if (transition) {
          transition.completed = false;
          transition.result = null;
        }
        persistDelegationTransitionGuard(ctx, idempotencyKey, {
          type: "claim_task",
          status: "failed",
          taskId,
          instanceId,
          error: err.message,
          result: { ...failureResult },
        });
        return failureResult;
      }

      if (claimResult?.success) {
        const token = claimResult.token || claimResult.claim?.claim_token || null;
        ctx.data._claimToken = token;
        ctx.data._claimInstanceId = instanceId;
        if (transition) {
          transition.completed = true;
          transition.claimToken = token;
          transition.instanceId = instanceId;
        }
        recordDelegationAuditEvent(ctx, {
          type: delegationTransitionType || "assign",
          eventType: delegationTransitionType || "assign",
          nodeId: node.id,
          taskId,
          instanceId,
          claimToken: token,
          at: Date.now(),
          timestamp: new Date().toISOString(),
          transitionKey: delegationTransitionKey || [delegationTransitionType || "assign", taskId, instanceId].join(":"),
          idempotencyKey: delegationTransitionKey || idempotencyKey,
        });

        if (renewIntervalMs > 0 && renewClaimFn && !runtimeState.claimRenewTimer) {
          const renewTimer = setInterval(async () => {
            try {
              const renewResult = await renewClaimFn({ taskId, claimToken: token, instanceId, ttlMinutes });
              if (renewResult && renewResult.success === false) {
                const resultError = String(renewResult.error || renewResult.reason || "claim_renew_failed");
                const fatalResult = ["claimed_by_different_instance", "claim_token_mismatch", "task_not_claimed", "owner_mismatch", "attempt_token_mismatch"]
                  .some((entry) => resultError.includes(entry));
                if (fatalResult) {
                  handleFatalRenewal(resultError, token);
                } else {
                  ctx.log(node.id, `Claim renewal warning: ${resultError}`);
                }
              } else if (renewResult?.success) {
                const claimRenewKey = ["claim-renew", taskId, instanceId, token || "none"].join(":");
                recordDelegationAuditEvent(ctx, {
                  type: "claim-renew",
                  eventType: "claim-renew",
                  nodeId: node.id,
                  taskId,
                  instanceId,
                  claimToken: token,
                  at: Date.now(),
                  timestamp: new Date().toISOString(),
                  transitionKey: claimRenewKey,
                  idempotencyKey: claimRenewKey,
                });
              }
            } catch (renewErr) {
              const msg = renewErr?.message || String(renewErr);
              const fatal = ["claimed_by_different_instance", "claim_token_mismatch", "task_not_claimed", "owner_mismatch", "attempt_token_mismatch"]
                .some((entry) => msg.includes(entry));
              if (fatal) {
                handleFatalRenewal(msg, token);
              } else {
                ctx.log(node.id, `Claim renewal warning: ${msg}`);
              }
            }
          }, renewIntervalMs);
          if (renewTimer.unref) renewTimer.unref();
          runtimeState.claimRenewTimer = renewTimer;
          ctx.data._claimRenewTimer = null;
        }

        ctx.log(node.id, `Task "${taskTitle}" claimed (ttl=${ttlMinutes}min, renew=${renewIntervalMs}ms)`);
        const successResult = { success: true, taskId, claimToken: token, instanceId };
        if (transition) transition.result = { ...successResult };
        persistDelegationTransitionGuard(ctx, idempotencyKey, {
          type: "claim_task",
          status: "completed",
          taskId,
          claimToken: token,
          instanceId,
          result: { ...successResult },
        });
        if (idempotencyKey) {
          setDelegationTransitionResult(ctx, idempotencyKey, {
            type: "claim_task",
            claimToken: token,
            instanceId,
            result: { ...successResult },
          });
        }
        return successResult;
      }

      if (claimResult?.alreadyClaimed) {
        const owner = claimResult?.claim?.holder?.instance_id || claimResult?.claim?.instance_id || null;
        const failureResult = { success: false, taskId, alreadyClaimed: true, claimedBy: owner, error: "task_already_claimed" };
        if (transition) {
          transition.completed = false;
          transition.result = null;
        }
        persistDelegationTransitionGuard(ctx, idempotencyKey, {
          type: "claim_task",
          status: "failed",
          taskId,
          instanceId,
          claimedBy: owner,
          error: "task_already_claimed",
          result: { ...failureResult },
        });
        return failureResult;
      }

      ctx.log(node.id, `Claim error: ${claimResult?.error || "unknown"}`);
      const failureResult = { success: false, taskId, error: claimResult?.error || "unknown", alreadyClaimed: false };
      if (transition) {
        transition.completed = false;
        transition.result = null;
      }
      persistDelegationTransitionGuard(ctx, idempotencyKey, {
        type: "claim_task",
        status: "failed",
        taskId,
        instanceId,
        error: claimResult?.error || "unknown",
        result: { ...failureResult },
      });
      return failureResult;
    })();
    if (transition) transition.inFlightPromise = claimExecution;
    try {
      return await claimExecution;
    } finally {
      if (transition) transition.inFlightPromise = null;
    }
  },
});
// ── action.release_claim ────────────────────────────────────────────────────

registerNodeType("action.release_claim", {
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
  async execute(node, ctx) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const claimToken = cfgOrCtx(node, ctx, "claimToken") || ctx.data?._claimToken || "";
    const instanceId = cfgOrCtx(node, ctx, "instanceId") || ctx.data?._claimInstanceId || "";
    const transitionKey = String(
      cfgOrCtx(node, ctx, "transitionKey") ||
      cfgOrCtx(node, ctx, "idempotencyKey") ||
      (taskId ? `release:${taskId}` : "")
    ).trim();
    const existingTransition = transitionKey
      ? getExistingDelegationTransition(ctx, transitionKey)
      : null;
    const persistedTransition = !existingTransition && transitionKey && typeof ctx.getDelegationTransitionGuard === "function"
      ? ctx.getDelegationTransitionGuard(transitionKey)
      : null;
    const replayTransition = existingTransition || persistedTransition;
    if (replayTransition?.type === "release_claim" && replayTransition?.status === "completed") {
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      return {
        ...(replayTransition.result || { success: true, taskId }),
        deduped: true,
        idempotentReplay: true,
      };
    }


    // Always cancel the renewal timer first.
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

    const claims = await ensureTaskClaimsMod();
    try {
      await ensureTaskClaimsInitialized(ctx, claims);
    } catch (initErr) {
      ctx.log(node.id, `Claim release init warning: ${initErr.message}`);
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      return { success: true, taskId, warning: initErr.message };
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
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      ctx.log(node.id, `Claim released for ${taskId}`);
      const successResult = { success: true, taskId };
      if (transitionKey) {
        setDelegationTransitionResult(ctx, transitionKey, {
          type: "release_claim",
          status: "completed",
          taskId,
          result: { ...successResult },
        });
        persistDelegationTransitionGuard(ctx, transitionKey, {
          type: "release_claim",
          status: "completed",
          taskId,
          result: { ...successResult },
        });
      }
      return successResult;
    } catch (err) {
      // Release is best-effort — log but don't fail
      ctx.log(node.id, `Claim release warning: ${err.message}`);
      ctx.data._claimToken = null;
      ctx.data._claimInstanceId = null;
      const warningResult = { success: true, taskId, warning: err.message };
      if (transitionKey) {
        setDelegationTransitionResult(ctx, transitionKey, {
          type: "release_claim",
          status: "completed",
          taskId,
          warning: err.message,
          result: { ...warningResult },
        });
        persistDelegationTransitionGuard(ctx, transitionKey, {
          type: "release_claim",
          status: "completed",
          taskId,
          warning: err.message,
          result: { ...warningResult },
        });
      }
      return warningResult;
    }
  },
});

// ── action.resolve_executor ─────────────────────────────────────────────────

registerNodeType("action.resolve_executor", {
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
  async execute(node, ctx) {
    const defaultSdk = cfgOrCtx(node, ctx, "defaultSdk", "auto");
    const sdkOverride = cfgOrCtx(node, ctx, "sdkOverride");
    const modelOverride = cfgOrCtx(node, ctx, "modelOverride");
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
    const taskTitle = cfgOrCtx(node, ctx, "taskTitle") || ctx.data?.taskTitle || ctx.data?.task?.title || "";
    const taskDescription =
      cfgOrCtx(node, ctx, "taskDescription") ||
      ctx.data?.taskDescription ||
      ctx.data?.task?.description ||
      "";
    const taskTags = Array.isArray(ctx.data?.task?.tags) ? ctx.data.task.tags : [];

    const normalizeSdkName = (value) => {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw) return "";
      if (raw === "claude_code" || raw === "claude") return "claude";
      if (raw === "copilot") return "copilot";
      if (raw === "codex") return "codex";
      return raw;
    };

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
      const { resolveLibraryPlan } = await import("../../infra/library-manager.mjs");
      const planResult = resolveLibraryPlan(repoRoot, {
        title: taskTitle,
        description: taskDescription,
        tags: taskTags,
      });
      const plan = planResult?.plan || null;
      const profile = planResult?.best?.profile || null;
      if (plan && plan.agentProfileId) {
        ctx.data.agentProfile = plan.agentProfileId;
        ctx.data.resolvedAgentProfile = profile || { id: plan.agentProfileId };
        ctx.data.resolvedSkillIds = Array.isArray(plan.skillIds) ? plan.skillIds : [];

        const profileSdk = normalizeSdkName(profile?.sdk);
        const profileModel = String(profile?.model || "").trim();
        if (profileSdk) {
          const model = modelOverride || envModel || profileModel || "";
          ctx.data.resolvedSdk = profileSdk;
          ctx.data.resolvedModel = model;
          ctx.log(node.id, `Executor profile: sdk=${profileSdk}, model=${model}, profile=${plan.agentProfileId}`);
          return {
            success: true,
            sdk: profileSdk,
            model,
            tier: "profile",
            profile: plan.agentProfileId,
          };
        }
      }
    } catch (err) {
      ctx.log(node.id, `Library profile resolution failed: ${err.message}`);
    }

    // Complexity-based routing
    try {
      const complexity = await ensureTaskComplexityMod();
      const task = {
        id: cfgOrCtx(node, ctx, "taskId"),
        title: taskTitle,
        description: taskDescription,
      };

      if (complexity.resolveExecutorForTask && complexity.executorToSdk) {
        const resolved = complexity.resolveExecutorForTask(task);
        const sdk = complexity.executorToSdk(resolved.executor);
        const model = modelOverride || envModel || resolved.model || "";
        ctx.data.resolvedSdk = sdk;
        ctx.data.resolvedModel = model;
        ctx.log(node.id, `Executor: sdk=${sdk}, model=${model}, tier=${resolved.tier || "default"}`);
        return {
          success: true,
          sdk,
          model,
          tier: resolved.tier || "default",
          profile: resolved.name || null,
          complexity: resolved.complexity || null,
        };
      }
    } catch (err) {
      ctx.log(node.id, `Complexity routing failed: ${err.message}`);
    }

    // Fallback
    let sdk = defaultSdk;
    if (sdk === "auto") {
      try {
        const pool = await ensureAgentPoolMod();
        sdk = pool.getPoolSdkName?.() || "codex";
      } catch {
        sdk = "codex";
      }
    }
    const model = modelOverride || envModel || "";
    ctx.data.resolvedSdk = sdk;
    ctx.data.resolvedModel = model;
    ctx.log(node.id, `Executor fallback: sdk=${sdk}`);
    return { success: true, sdk, model, tier: "default", profile: null };
  },
});

// ── action.acquire_worktree ─────────────────────────────────────────────────

function resolveWorktreeGitDir(worktreePath) {
  const gitMetadataPath = resolve(worktreePath, ".git");
  if (!existsSync(gitMetadataPath)) return "";
  try {
    if (statSync(gitMetadataPath).isDirectory()) return gitMetadataPath;
  } catch {
    return "";
  }
  try {
    const raw = readFileSync(gitMetadataPath, "utf8").trim();
    const match = raw.match(/^gitdir:\s*(.+)$/im);
    if (!match?.[1]) return "";
    return resolve(dirname(gitMetadataPath), match[1].trim());
  } catch {
    return "";
  }
}

function isManagedWorktreeGitDir(gitDir, repoRoot) {
  const normalizedGitDir = resolve(String(gitDir || ""));
  if (!normalizedGitDir) return false;
  const managedGitDirRoot = resolve(String(repoRoot || process.cwd()), ".git", "worktrees");
  return (
    normalizedGitDir === managedGitDirRoot ||
    normalizedGitDir.startsWith(`${managedGitDirRoot}\\`) ||
    normalizedGitDir.startsWith(`${managedGitDirRoot}/`)
  );
}

export function classifyAcquireWorktreeFailure(errorInput) {
  const errorMessage = String(errorInput?.message || errorInput || "worktree_acquisition_failed").trim();

  if (/managed worktree was removed after stale refresh state/i.test(errorMessage)) {
    return {
      errorMessage,
      retryable: false,
      failureKind: "branch_refresh_conflict",
      blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
      detectedIssues: ["refresh_conflict"],
      phase: "post-pull",
    };
  }

  if (
    /worktree runtime setup incomplete/i.test(errorMessage)
    || /missing worktree setup files/i.test(errorMessage)
    || /git core\.hooksPath/i.test(errorMessage)
  ) {
    return {
      errorMessage,
      retryable: false,
      failureKind: "worktree_runtime_setup_incomplete",
      blockedReason: errorMessage,
      detectedIssues: ["runtime_setup_incomplete"],
      phase: "runtime-setup",
    };
  }

  return {
    errorMessage,
    retryable: true,
    failureKind: "worktree_acquisition_failed",
    blockedReason: errorMessage,
    detectedIssues: [],
    phase: null,
  };
}

function inspectManagedWorktreeState(worktreePath) {
  const issues = [];
  const conflictFiles = [];
  const gitMetadataPath = resolve(worktreePath, ".git");
  if (!existsSync(gitMetadataPath)) {
    issues.push("missing_git_metadata");
    return { invalid: true, issues, conflictFiles, gitDir: "" };
  }

  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (!gitDir || !existsSync(gitDir)) {
    issues.push("missing_gitdir");
  } else {
    for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
      if (existsSync(resolve(gitDir, marker))) issues.push(marker);
    }
  }

  try {
    const unresolvedOutput = execSync("git diff --name-only --diff-filter=U", {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (unresolvedOutput) {
      conflictFiles.push(...unresolvedOutput.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean));
    }
  } catch {
    issues.push("git_diff_failed");
  }

  if (conflictFiles.length > 0) issues.push("unmerged_index");

  return {
    invalid: issues.length > 0,
    issues,
    conflictFiles,
    gitDir,
  };
}

function clearWorktreeGitState(gitDir, repoRoot = "") {
  if (!isManagedWorktreeGitDir(gitDir, repoRoot)) return;
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    try {
      rmSync(resolve(gitDir, marker), { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
}

function resetManagedWorktree(repoRoot, worktreePath, gitDir = "") {
  clearWorktreeGitState(gitDir, repoRoot);
  try {
    execGitArgsSync(["worktree", "remove", String(worktreePath), "--force"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort. Fall back to deleting the directory if git metadata is already broken.
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
  const managedGitDirRoot = resolve(repoRoot, ".git", "worktrees");
  const normalizedGitDir = gitDir ? resolve(String(gitDir)) : "";
  if (
    normalizedGitDir &&
    normalizedGitDir.toLowerCase().startsWith(managedGitDirRoot.toLowerCase())
  ) {
    try {
      rmSync(normalizedGitDir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
  try {
    execGitArgsSync(["worktree", "prune"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Best-effort.
  }
}

registerNodeType("action.acquire_worktree", {
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
  async execute(node, ctx) {
    const taskId = cfgOrCtx(node, ctx, "taskId");
    const branch = cfgOrCtx(node, ctx, "branch");
    const resolvedRepoRoot = resolveWorkflowRepoRoot(node, ctx);
    let repoRoot = findContainingGitRepoRoot(resolvedRepoRoot) || resolvedRepoRoot;
    const baseBranchRaw = cfgOrCtx(node, ctx, "baseBranch", "origin/main");
    const defaultTargetBranch = cfgOrCtx(node, ctx, "defaultTargetBranch", "origin/main");
    const baseBranch = pickGitRef(baseBranchRaw, defaultTargetBranch, "origin/main", "main");
    const fetchTimeout = node.config?.fetchTimeout ?? 30000;
    const worktreeTimeout = node.config?.worktreeTimeout ?? 60000;
    const recoveryState = {
      recreated: false,
      detectedIssues: new Set(),
      phase: null,
      worktreePath: null,
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
      const details = [
        `outcome=${payload.outcome}`,
        `branch=${payload.branch}`,
        payload.taskId ? `taskId=${payload.taskId}` : "",
        payload.phase ? `phase=${payload.phase}` : "",
        payload.worktreePath ? `path=${payload.worktreePath}` : "",
        payload.detectedIssues.length ? `issues=${payload.detectedIssues.join(",")}` : "",
        payload.error ? `error=${payload.error}` : "",
      ].filter(Boolean).join(" ");
      ctx.log(node.id, `[worktree-recovery] ${details}`);
      await recordWorktreeRecoveryEvent(repoRoot, payload);
    };

    if (!branch) throw new Error("action.acquire_worktree: branch is required");
    if (!taskId) throw new Error("action.acquire_worktree: taskId is required");

    // Non-git directory — agent spawns directly
    let isGit = existsSync(resolve(repoRoot, ".git"));
    if (!isGit) {
      const parentRepoRoot = resolve(repoRoot, "..");
      if (
        basename(String(repoRoot || "").trim()).toLowerCase() === ".bosun"
        && existsSync(resolve(parentRepoRoot, ".git"))
      ) {
        repoRoot = parentRepoRoot;
        isGit = true;
      }
    }
    if (!isGit) {
      const containingRepoRoot = findContainingGitRepoRoot(repoRoot);
      if (containingRepoRoot && containingRepoRoot !== repoRoot) {
        repoRoot = containingRepoRoot;
        isGit = existsSync(resolve(repoRoot, ".git"));
      }
    }
    ctx.data.repoRoot = repoRoot;
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
      const findAttachedWorktreeForBranch = async () => {
        try {
          const output = execSync("git worktree list --porcelain", {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 10000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const lines = String(output || "").split(/\r?\n/);
          let currentPath = "";
          let currentBranch = "";
          for (const line of lines) {
            if (!line.trim()) {
              if (currentPath && currentBranch === branch) return currentPath;
              currentPath = "";
              currentBranch = "";
              continue;
            }
            if (line.startsWith("worktree ")) {
              currentPath = line.slice("worktree ".length).trim();
              continue;
            }
            if (line.startsWith("branch ")) {
              const branchRef = line.slice("branch ".length).trim();
              currentBranch = branchRef.replace(/^refs\/heads\//, "");
            }
          }
        } catch {
          // best-effort only
        }
        return "";
      };

      const localBranchExists = () => {
        try {
          execGitArgsSync(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
            cwd: repoRoot,
            timeout: 5000,
            stdio: ["ignore", "ignore", "ignore"],
          });
          return true;
        } catch {
          return false;
        }
      };

      const invalidateBrokenReusableWorktree = (candidatePath, phaseLabel) => {
        const state = inspectManagedWorktreeState(candidatePath);
        if (!state.invalid) return false;
        const details = [
          state.issues.join(", "),
          state.conflictFiles.length > 0 ? `conflicts=${state.conflictFiles.join(",")}` : "",
        ].filter(Boolean).join(" ");
        if (!isManagedBosunWorktree(candidatePath, repoRoot)) {
          throw new Error(
            `Attached worktree for ${branch} is in unresolved git state (${details || "unknown"})`,
          );
        }
        ctx.log(node.id, `Discarding broken managed worktree (${phaseLabel}): ${candidatePath} ${details}`.trim());
        recoveryState.recreated = true;
        recoveryState.phase = phaseLabel;
        recoveryState.worktreePath = candidatePath;
        for (const issue of state.issues || []) {
          const normalized = String(issue || "").trim();
          if (normalized) recoveryState.detectedIssues.add(normalized);
        }
        resetManagedWorktree(repoRoot, candidatePath, state.gitDir);
        return true;
      };

      // Ensure base branch ref is fresh
      const baseBranchShort = baseBranch.replace(/^origin\//, "");
      try {
        execGitArgsSync(["fetch", "origin", baseBranchShort, "--no-tags"], {
          cwd: repoRoot, encoding: "utf8",
          timeout: fetchTimeout,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // Best-effort fetch — offline or transient issue is OK
      }

      const worktreesDir = resolve(repoRoot, ".bosun", "worktrees");
      mkdirSync(worktreesDir, { recursive: true });
      // Keep managed worktree paths short on Windows to avoid MAX_PATH checkout failures.
      const worktreePath = resolve(worktreesDir, deriveManagedWorktreeDirName(taskId, branch));

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
        // Reuse existing worktree — pull latest base if possible
        let recreatedManagedWorktree = invalidateBrokenReusableWorktree(worktreePath, "pre-reuse");
        if (!recreatedManagedWorktree && existsSync(worktreePath)) {
          try {
            // Discard any dirty tracked files before rebasing so the pull
            // doesn't fail with "your local changes would be overwritten".
            const dirty = execGitArgsSync(["status", "--porcelain"], {
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
              execGitArgsSync(["clean", "-fd"], {
                cwd: worktreePath, encoding: "utf8",
                timeout: 10000,
                stdio: ["ignore", "pipe", "pipe"],
              });
            }
          } catch {
            /* best-effort — dirty state handled by post-pull invalidity check below */
          }
          try {
            execGitArgsSync(["pull", "--rebase", "origin", baseBranchShort], {
              cwd: worktreePath, encoding: "utf8",
              timeout: fetchTimeout,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch {
            /* rebase failures are non-fatal only if the worktree remains reusable */
          }
          recreatedManagedWorktree = invalidateBrokenReusableWorktree(worktreePath, "post-pull");
        }
        if (!recreatedManagedWorktree && existsSync(worktreePath)) {
          fixGitConfigCorruption(repoRoot);
          ctx.data.worktreePath = worktreePath;
          ctx.data.baseBranch = baseBranch;
          ctx.data._worktreeCreated = false;
          ctx.data._worktreeManaged = true;
          await persistRecoveryEvent({
            outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
            worktreePath,
          });
          ctx.log(node.id, `Reusing worktree: ${worktreePath}`);
          return { success: true, worktreePath, created: false, reused: true, branch, baseBranch };
        }
      }

      // Create fresh worktree
      const branchExistsLocally = localBranchExists();
      try {
        execGitArgsSync(
          branchExistsLocally
            ? ["worktree", "add", worktreePath, branch]
            : ["worktree", "add", worktreePath, "-b", branch, baseBranch],
          { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
        );
      } catch (createErr) {
        const createErrDetail = String(createErr?.stderr || createErr?.message || "");

        // "invalid reference" means a previous failed worktree-add left an orphaned
        // local branch ref (branch exists in git metadata but has no valid object).
        // Delete it and create fresh from base so the task can proceed.
        if (branchExistsLocally && /invalid reference/i.test(createErrDetail)) {
          try {
            execGitArgsSync(["branch", "-D", branch], {
              cwd: repoRoot, encoding: "utf8", timeout: 5000,
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch { /* best-effort cleanup */ }
          // Retry fresh creation — let any failure propagate as a normal error
          execGitArgsSync(["worktree", "add", worktreePath, "-b", branch, baseBranch], {
            cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout,
          });
        } else if (!isExistingBranchWorktreeError(createErr)) {
          throw new Error(`Worktree creation failed: ${formatExecSyncError(createErr)}`);
        } else {
          const attachedPath = await findAttachedWorktreeForBranch();
          let recreatedAttachedWorktree = false;
          if (attachedPath && existsSync(attachedPath)) {
            if (invalidateBrokenReusableWorktree(attachedPath, "attached-branch")) {
              fixGitConfigCorruption(repoRoot);
              execGitArgsSync(
                branchExistsLocally
                  ? ["worktree", "add", worktreePath, branch]
                  : ["worktree", "add", worktreePath, "-b", branch, baseBranch],
                { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
              );
              recreatedAttachedWorktree = true;
            } else {
              fixGitConfigCorruption(repoRoot);
              ctx.data.worktreePath = attachedPath;
              ctx.data.baseBranch = baseBranch;
              ctx.data._worktreeCreated = false;
              ctx.data._worktreeManaged = true;
              await persistRecoveryEvent({
                outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
                worktreePath: attachedPath,
              });
              ctx.log(node.id, `Reusing existing branch worktree: ${attachedPath}`);
              return {
                success: true,
                worktreePath: attachedPath,
                created: false,
                reused: true,
                reusedExistingBranch: true,
                branch,
                baseBranch,
              };
            }
          }
          if (!recreatedAttachedWorktree) {
            // Branch already exists — attach worktree to existing branch.
            try {
              execGitArgsSync(
                ["worktree", "add", worktreePath, branch],
                { cwd: repoRoot, encoding: "utf8", timeout: worktreeTimeout },
              );
            } catch (reuseErr) {
              throw new Error(
                `Worktree creation failed: ${formatExecSyncError(createErr)}; ` +
                `reuse failed: ${formatExecSyncError(reuseErr)}`,
              );
            }
          }
        }
      }
      clearWorktreeGitState(resolveWorktreeGitDir(worktreePath), repoRoot);
      fixGitConfigCorruption(repoRoot);

      ctx.data.worktreePath = worktreePath;
      ctx.data.baseBranch = baseBranch;
      ctx.data._worktreeCreated = true;
      ctx.data._worktreeManaged = true;
      await persistRecoveryEvent({
        outcome: recoveryState.recreated ? "recreated" : "healthy_noop",
        worktreePath,
      });
      ctx.log(node.id, `Worktree created: ${worktreePath} (branch: ${branch}, base: ${baseBranch})`);
      return { success: true, worktreePath, created: true, branch, baseBranch };
    } catch (err) {
      // Safely derive recovery context without assuming try-block scoped bindings exist here.
      const safeRecoveryState =
        typeof recoveryState !== "undefined" && recoveryState
          ? recoveryState
          : {
              phase: "post-pull",
              worktreePath:
                (typeof worktreePath !== "undefined" && worktreePath) ||
                (ctx?.data && ctx.data.worktreePath) ||
                undefined,
              detectedIssues: new Set(["refresh_conflict"]),
            };
      const safePersistRecoveryEvent =
        typeof persistRecoveryEvent === "function" ? persistRecoveryEvent : async () => {};
      const safeWorktreePath =
        (typeof worktreePath !== "undefined" && worktreePath) ||
        safeRecoveryState.worktreePath ||
        (ctx?.data && ctx.data.worktreePath) ||
        undefined;

      if (/managed worktree was removed after stale refresh state/i.test(String(err?.message || ""))) {
        await safePersistRecoveryEvent({
          outcome: "recreation_failed",
          phase: safeRecoveryState.phase || "post-pull",
          worktreePath: safeRecoveryState.worktreePath || safeWorktreePath,
          detectedIssues: Array.from(
            safeRecoveryState.detectedIssues && safeRecoveryState.detectedIssues.size
              ? safeRecoveryState.detectedIssues
              : ["refresh_conflict"],
          ),
          error: String(err?.message || err),
        });
      }
      const classified = classifyAcquireWorktreeFailure(err);
      ctx.log(node.id, `Worktree acquisition failed: ${classified.errorMessage}`);
      return {
        success: false,
        error: classified.errorMessage,
        branch,
        baseBranch,
        retryable: classified.retryable,
        failureKind: classified.failureKind,
        blockedReason: classified.blockedReason,
        detectedIssues: classified.detectedIssues,
        phase: classified.phase,
      };
    }
  },
});

// ── action.release_worktree ─────────────────────────────────────────────────

registerNodeType("action.release_worktree", {
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
  async execute(node, ctx) {
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

      ctx.data._worktreeCreated = false;
      ctx.data._worktreeManaged = false;
      ctx.log(node.id, `Worktree released: ${worktreePath}`);
      return { success: true, worktreePath, released: true };
    } catch (err) {
      ctx.log(node.id, `Worktree release warning: ${err.message}`);
      return { success: true, worktreePath, warning: err.message };
    }
  },
});

// ── action.build_task_prompt ────────────────────────────────────────────────

registerNodeType("action.build_task_prompt", {
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
  async execute(node, ctx) {
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
      process.env.BOSUN_RUN_ID,
    );
    const matchedSkills = findRelevantSkills(
      normalizedRepoRoot,
      normalizedTaskTitle,
      normalizedTaskDescription || "",
      {},
    );
    const activeSkillFiles = matchedSkills.map((skill) => skill.filename);
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
      issueAdvisorSummary: normalizeString(ctx.data?._issueAdvisor?.summary || ctx.data?._plannerFeedback?.issueAdvisorSummary || ""),
      issueAdvisorRecommendation: normalizeString(ctx.data?._issueAdvisor?.recommendedAction || ""),
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

    const strictCacheAnchoring =
      String(process.env.BOSUN_CACHE_ANCHOR_MODE || "")
        .trim()
        .toLowerCase() === "strict";
    const dynamicMarkers = [
      normalizedTaskId,
      normalizedTaskTitle,
      normalizedTaskDescription,
      normalizedRetryReason,
      normalizedBranch,
      normalizedBaseBranch,
      normalizedWorktreePath,
      normalizedRepoRoot,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    ctx.data._taskPromptDynamicMarkers = dynamicMarkers;

    const buildStableSystemPrompt = () =>
      [
        "# Bosun Agent Persona",
        "You are an autonomous AI coding agent operating inside Bosun.",
        "Follow the task details and project instructions provided in the user message.",
        "Be concise, rigorous, and complete tasks end-to-end with verified results.",
      ].join("\n");

    const assertStableSystemPrompt = (candidate) => {
      if (!strictCacheAnchoring) return;
      const leaked = dynamicMarkers.find((marker) => candidate.includes(marker));
      if (leaked) {
        throw new Error(
          `BOSUN_CACHE_ANCHOR_MODE=strict violation: system prompt leaked task-specific marker "${leaked}"`,
        );
      }
    };

    const buildGitContextBlock = async () => {
      if (!includeGitContext) return "";
      const root = normalizedWorktreePath || normalizedRepoRoot;
      if (!root) return "";
      if (!existsSync(resolve(root, ".git"))) return "";

      try {
        const diffStatsMod = await import("../../git/diff-stats.mjs");
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
      assertStableSystemPrompt(stableSystemPrompt);
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

    const workflowIssueAdvisor =
      ctx.data?._issueAdvisor && typeof ctx.data._issueAdvisor === "object"
        ? ctx.data._issueAdvisor
        : null;
    const workflowDagStateSummary =
      ctx.data?._plannerFeedback?.dagStateSummary && typeof ctx.data._plannerFeedback.dagStateSummary === "object"
        ? ctx.data._plannerFeedback.dagStateSummary
        : null;
    const userParts = [];
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

    const eagerToolBlock = getToolsPromptBlock(normalizedRepoRoot, {
      activeSkills: activeSkillFiles,
      includeBuiltins: true,
      eagerOnly: true,
      discoveryMode: true,
      emitReflectHint: true,
      limit: 12,
    });
    if (eagerToolBlock) {
      userParts.push(eagerToolBlock);
      userParts.push("");
    }

    // Instructions
    userParts.push("## Instructions");
    userParts.push(
      "1. Read and understand the task description above.\n" +
      "2. Follow the project instructions in AGENTS.md.\n" +
      "3. Respect the Workspace Scope Contract and never cross repository boundaries.\n" +
      "4. Load and apply the matched important skills already inlined above.\n" +
      "5. Use the discovery MCP tools for non-eager MCP/custom tools before assuming a capability is unavailable.\n" +
      "6. Implement the required changes.\n" +
      "7. Ensure tests pass and build is clean with 0 warnings.\n" +
      "8. Commit your changes using conventional commits.\n" +
      "9. Never ask for user input — you are autonomous.\n" +
      "10. Use all available tools to verify your work.",
    );
    userParts.push("");

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
    assertStableSystemPrompt(systemPrompt);

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


registerNodeType("action.persist_memory", {
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
  async execute(node, ctx) {
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
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
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

// ── action.auto_commit_dirty ────────────────────────────────────────────────
// Safety net: if the agent left uncommitted work in the worktree, stage + commit
// so that detect_new_commits can see it and the work isn't silently destroyed.

registerNodeType("action.auto_commit_dirty", {
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
  async execute(node, ctx) {
    const worktreePath = cfgOrCtx(node, ctx, "worktreePath");
    const taskId = cfgOrCtx(node, ctx, "taskId") || ctx.data?.taskId || "unknown";

    if (!worktreePath) {
      ctx.log(node.id, "auto_commit_dirty: no worktreePath — skipping");
      return { success: false, committed: false, reason: "no worktreePath" };
    }

    // Check for uncommitted changes (tracked modified + untracked)
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

    // Stage everything
    try {
      execGitArgsSync(["add", "-A"], {
        cwd: worktreePath, encoding: "utf8", timeout: 15000,
      });
    } catch (err) {
      ctx.log(node.id, `git add -A failed: ${err.message}`);
      return { success: false, committed: false, reason: `git add failed: ${err.message}` };
    }

    // Commit
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

// ── action.detect_new_commits ───────────────────────────────────────────────

registerNodeType("action.detect_new_commits", {
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
  async execute(node, ctx) {
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
    try {
      const log = execGitArgsSync(["log", "--oneline", `${baseBranch}..HEAD`], {
        cwd: worktreePath, encoding: "utf8", timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      commitCount = log ? log.split("\n").filter(Boolean).length : 0;
      hasUnpushed = commitCount > 0;
    } catch {
      /* best-effort */
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

    ctx.data._hasNewCommits = hasCommits;
    ctx.data._postExecHead = postExecHead;
    ctx.data._commitCount = commitCount;
    ctx.data._diffStats = diffStats;

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
      preExecHead,
      postExecHead,
      diffStats,
    };
  },
});

// ── action.push_branch ──────────────────────────────────────────────────────

registerNodeType("action.push_branch", {
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
      skipHooks: { type: "boolean", default: true, description: "Skip git pre-push hooks (--no-verify)" },
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
    const repoRoot = resolveWorkflowRepoRoot(node, ctx);
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
    const skipHooks = typeof node.config?.skipHooks === "boolean"
      ? node.config.skipHooks
      : !shouldEnforceManagedPushHook(repoRoot, worktreePath);
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

    const cleanBranch = branch.replace(/^origin\//, "");
    if (remote !== configuredRemote) {
      ctx.log(node.id, `Remapped push remote ${configuredRemote} -> ${remote} for ${repoHint || cleanBranch || "worktree"}`);
    }

    if (shouldEnforceManagedPushHook(repoRoot, worktreePath)) {
      bootstrapWorktreeForPath(repoRoot, worktreePath);
    }

    // Safety check: don't push to protected branches
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

    try {
      execGitArgsSync(["fetch", remote, "--no-tags"], {
        cwd: worktreePath, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (fetchErr) {
      ctx.log(node.id, `Fetch failed (will push anyway): ${fetchErr.message?.slice(0, 200)}`);
    }

    if (rebaseBeforePush || mergeBaseBeforePush) {
      const remoteTrackingRef = `${remote}/${cleanBranch}`;
      try {
        execGitArgsSync(["rev-parse", "--verify", remoteTrackingRef], {
          cwd: worktreePath, timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
        });
        const behindCount = execGitArgsSync(
          ["rev-list", "--count", `HEAD..${remoteTrackingRef}`],
          { cwd: worktreePath, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
        if (parseInt(behindCount, 10) > 0) {
          try {
            execGitArgsSync(["rebase", remoteTrackingRef], {
              cwd: worktreePath, encoding: "utf8", timeout: 60000,
              stdio: ["ignore", "pipe", "pipe"],
            });
            ctx.log(node.id, `Synced local with ${remoteTrackingRef} (was ${behindCount} behind)`);
          } catch (syncErr) {
            try {
              execGitArgsSync(["rebase", "--abort"], {
                cwd: worktreePath, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
              });
            } catch {
              // best effort
            }
            ctx.log(node.id, `Sync with ${remoteTrackingRef} conflicted, skipping: ${syncErr.message?.slice(0, 200)}`);
          }
        }
      } catch {
        // remote branch does not exist yet
      }

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
          try {
            execGitArgsSync(["rebase", "--abort"], {
              cwd: worktreePath, timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
            });
          } catch {
            // best effort
          }
          ctx.log(node.id, `Rebase onto ${baseBranch} conflicted, skipping: ${rebaseErr.message?.slice(0, 200)}`);
        }
      }
    }

    // ── Optional: sync base branch with main (for module branches) ──
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

    // ── Empty diff guard ──
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

    try {
      const headSha = execGitArgsSync(["rev-parse", "HEAD"], {
        cwd: worktreePath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const mainSha = execGitArgsSync(["rev-parse", `${remote}/main`], {
        cwd: worktreePath, encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
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
    } catch {
      // best effort
    }

    // ── Push ──
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

// ═══════════════════════════════════════════════════════════════════════════
//  WEB SEARCH — Structured web search for research workflows
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("action.web_search", {
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

    // ── MCP-based search ────────────────────────────────────────────────
    if (searchEngine === "mcp") {
      try {
        const { getMcpRegistry } = await import("../mcp-registry.mjs");
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

    // ── Agent-based search ──────────────────────────────────────────────
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

    // ── Fetch-based search (default) ────────────────────────────────────
    try {
      const { default: fetchFn } = await import("../../infra/fetch-runtime.mjs");
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
            results[i].content = stripHtmlToText(html)
              .replace(/\s+/g, " ")
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

// ═══════════════════════════════════════════════════════════════════════════
//  Export all registered types for introspection
// ═══════════════════════════════════════════════════════════════════════════
