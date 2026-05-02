import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../config/config.mjs";
import {
  createTask,
  getTask as getKanbanTask,
  listTasks,
  updateTask,
  updateTaskStatus,
} from "../kanban/kanban-adapter.mjs";
import {
  execWithRetry,
  launchEphemeralThread,
  launchOrResumeThread,
} from "../agent/agent-pool.mjs";
import {
  getIsolatedRunnerPoolStatus,
  runInIsolatedRunner,
} from "../infra/container-runner.mjs";
import { createMeetingWorkflowService } from "../workflow/meeting-workflow-service.mjs";
import {
  getWorkflowEngine,
} from "../workflow/workflow-engine.mjs";
import { ensureWorkflowNodeTypesLoaded } from "../workflow/workflow-nodes.mjs";
import {
  installTemplate,
  reconcileInstalledTemplates,
  resolveWorkflowTemplateConfig,
  resolveWorkflowTemplateIds,
} from "../workflow/workflow-templates.mjs";
import {
  canStartTask,
  configureTaskStore,
  loadStore,
  waitForStoreWrites,
} from "./task-store.mjs";
/** Resolve the kanban state JSON path using common env/config heuristics. */
function resolveKanbanStorePath() {
  if (process.env.BOSUN_STORE_PATH) return process.env.BOSUN_STORE_PATH;
  const base = process.env.REPO_ROOT || process.cwd();
  return resolve(base, ".bosun", ".cache", "kanban-state.json");
}

const TASK_SIMULATION_TEMPLATE_ID = "template-task-lifecycle";
const TASK_SIMULATION_PR_PROGRESSOR_TEMPLATE_ID = "template-bosun-pr-progressor";
const TASK_SIMULATION_TEMPLATE_FORCE_UPDATE_IDS = [
  "template-task-batch-processor",
  "template-task-lifecycle",
  "template-task-finalization-guard",
  "template-agent-session-monitor",
  "template-bosun-pr-watchdog",
  "template-bosun-pr-progressor",
  "template-github-kanban-sync",
  "template-recover-blocked-task",
  "template-recover-blocked-worktrees",
];
const BOSUN_LOCAL_OPS_BRANCH = "bosun/codex-self-improvement-loop-commits";
const SIMULATOR_RUNTIME_DRIFT_FILES = Object.freeze([
  "workflow/workflow-engine.mjs",
  "workflow/workflow-nodes/actions.mjs",
  "workflow/workflow-nodes.mjs",
  "workflow-templates/task-lifecycle.mjs",
  "task/task-claims.mjs",
  "task/task-store.mjs",
]);

function readCurrentGitBranch(repoRoot) {
  try {
    const result = spawnSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env },
    });
    return String(result?.stdout || "").trim();
  } catch {
    return "";
  }
}

function isBosunLocalOpsBranch(branchName) {
  return String(branchName || "").trim().toLowerCase() === BOSUN_LOCAL_OPS_BRANCH;
}

function isSyntheticSimulationBaseBranch(branchName) {
  const normalized = String(branchName || "").trim().toLowerCase();
  if (!normalized) return false;
  return (
    isBosunLocalOpsBranch(normalized)
    || /^monitor(?:[-/]|$)/.test(normalized)
    || normalized.includes("postmerge-sync")
  );
}

export function resolveTaskSimulationDefaultTargetBranch(
  config = {},
  repoRoot = process.cwd(),
  options = {},
) {
  const explicitOverride = String(
    options.defaultTargetBranch || process.env.BOSUN_SIMULATE_TARGET_BRANCH || "",
  ).trim();
  if (explicitOverride) return explicitOverride;

  const configuredBranch = String(
    config?.branchRouting?.defaultBranch || config?.defaultTargetBranch || "",
  ).trim();
  const normalizedConfigured = configuredBranch.toLowerCase();
  const currentBranch = readCurrentGitBranch(repoRoot);
  const normalizedCurrent = currentBranch.toLowerCase();
  const shouldPreferCurrentBranch =
    Boolean(currentBranch)
    && normalizedCurrent !== "head"
    && normalizedCurrent !== "main"
    && normalizedCurrent !== "master"
    && !normalizedCurrent.startsWith("task/")
    && !isBosunLocalOpsBranch(normalizedCurrent)
    && (
      !configuredBranch
      || normalizedConfigured === "origin/main"
      || normalizedConfigured === "main"
    );

  if (shouldPreferCurrentBranch) {
    return currentBranch;
  }
  return configuredBranch || "origin/main";
}

function shouldOverrideSimulationTaskBaseBranch(task, defaultTargetBranch) {
  const normalizedDefault = String(defaultTargetBranch || "").trim().toLowerCase();
  const taskBaseBranch = String(task?.baseBranch || task?.base_branch || "").trim().toLowerCase();
  if (isSyntheticSimulationBaseBranch(taskBaseBranch)) {
    return true;
  }
  if (
    !normalizedDefault
    || normalizedDefault === "origin/main"
    || normalizedDefault === "main"
  ) {
    return false;
  }
  return !taskBaseBranch || taskBaseBranch === "origin/main" || taskBaseBranch === "main";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function parseTaskPrNumber(task = {}) {
  const rawValue =
    task?.prNumber
    ?? task?.pr_number
    ?? task?.pullRequestNumber
    ?? task?.pull_request_number
    ?? task?.meta?.prNumber
    ?? task?.meta?.pr_number
    ?? task?.meta?.pullRequestNumber
    ?? task?.meta?.pull_request_number
    ?? null;
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRepoFromPrUrl(prUrl = "") {
  const match = String(prUrl || "").trim().match(/github\.com\/([^/]+\/[^/?#]+)/i);
  return match ? String(match[1] || "").trim() : "";
}

function normalizeSimulationTaskStatus(task = {}) {
  return firstNonEmptyString(
    task?.status,
    task?.state,
    task?.taskStatus,
    task?.task_status,
    task?.meta?.status,
    task?.meta?.state,
    task?.meta?.taskStatus,
    task?.meta?.task_status,
  ).toLowerCase().replace(/[\s_-]+/g, "");
}

function isTerminalSimulationTaskStatus(task = {}) {
  const normalizedStatus = normalizeSimulationTaskStatus(task);
  return normalizedStatus === "done" || normalizedStatus === "completed" || normalizedStatus === "cancelled";
}

function resolveSimulationTaskPrContext(task = {}, defaultTargetBranch = "") {
  const prUrl = firstNonEmptyString(
    task?.prUrl,
    task?.pr_url,
    task?.pullRequestUrl,
    task?.pull_request_url,
    task?.meta?.prUrl,
    task?.meta?.pr_url,
    task?.meta?.pullRequestUrl,
    task?.meta?.pull_request_url,
  );
  return {
    prNumber: parseTaskPrNumber(task),
    prUrl,
    repo: firstNonEmptyString(
      task?.repo,
      task?.repoSlug,
      task?.repo_slug,
      task?.repository,
      task?.repositorySlug,
      task?.meta?.repo,
      task?.meta?.repoSlug,
      task?.meta?.repo_slug,
      task?.meta?.repository,
      task?.meta?.repositorySlug,
      parseRepoFromPrUrl(prUrl),
    ),
    branch: firstNonEmptyString(
      task?.branch,
      task?.branchName,
      task?.branch_name,
      task?.headRefName,
      task?.head_ref_name,
      task?.meta?.branch,
      task?.meta?.branchName,
      task?.meta?.branch_name,
      task?.meta?.headRefName,
      task?.meta?.head_ref_name,
    ),
    baseBranch: firstNonEmptyString(
      task?.baseBranch,
      task?.base_branch,
      task?.targetBranch,
      task?.target_branch,
      task?.meta?.baseBranch,
      task?.meta?.base_branch,
      defaultTargetBranch,
    ),
  };
}

function resolveTaskSimulationTemplateId(task = null, defaultTargetBranch = "") {
  const normalizedStatus = normalizeSimulationTaskStatus(task);
  if (normalizedStatus !== "inreview") {
    return TASK_SIMULATION_TEMPLATE_ID;
  }
  const taskBaseBranch = firstNonEmptyString(
    task?.baseBranch,
    task?.base_branch,
    task?.targetBranch,
    task?.target_branch,
    task?.meta?.baseBranch,
    task?.meta?.base_branch,
  );
  if (isSyntheticSimulationBaseBranch(taskBaseBranch)) {
    return TASK_SIMULATION_TEMPLATE_ID;
  }
  const prContext = resolveSimulationTaskPrContext(task, defaultTargetBranch);
  return prContext.prNumber && (prContext.repo || prContext.prUrl)
    ? TASK_SIMULATION_PR_PROGRESSOR_TEMPLATE_ID
    : TASK_SIMULATION_TEMPLATE_ID;
}

function buildSimulationTaskInput(task, defaultTargetBranch) {
  const clonedTask = cloneJson(task);
  if (!clonedTask) return clonedTask;
  if (!shouldOverrideSimulationTaskBaseBranch(clonedTask, defaultTargetBranch)) {
    return clonedTask;
  }
  return {
    ...clonedTask,
    baseBranch: defaultTargetBranch,
    base_branch: defaultTargetBranch,
  };
}

function buildSimulationExecutionInput(task, defaultTargetBranch, templateId = TASK_SIMULATION_TEMPLATE_ID) {
  if (!task) return {};
  if (templateId !== TASK_SIMULATION_PR_PROGRESSOR_TEMPLATE_ID) {
    return {
      task: buildSimulationTaskInput(task, defaultTargetBranch),
    };
  }
  const prContext = resolveSimulationTaskPrContext(task, defaultTargetBranch);
  return {
    ...(prContext.branch ? { branch: prContext.branch } : {}),
    ...(prContext.baseBranch ? { baseBranch: prContext.baseBranch } : {}),
    ...(prContext.prNumber ? { prNumber: prContext.prNumber } : {}),
    ...(prContext.prUrl ? { prUrl: prContext.prUrl } : {}),
    ...(prContext.repo ? { repo: prContext.repo } : {}),
  };
}

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function getFlagValue(args = [], ...flags) {
  for (const flag of flags) {
    const directIdx = args.indexOf(flag);
    if (directIdx >= 0) {
      return String(args[directIdx + 1] || "").trim();
    }
    const inline = args.find((arg) => String(arg || "").startsWith(`${flag}=`));
    if (inline) {
      return String(inline).slice(flag.length + 1).trim();
    }
  }
  return "";
}

const TASK_SIMULATION_FLAGS_WITH_VALUES = new Set([
  "--config-dir",
  "--lock-path",
  "--log-dir",
  "--mode",
  "--repo-root",
  "--state-path",
]);

function getPositionalTaskArgs(args = []) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "");
    if (!arg) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg.includes("=")) continue;
    if (TASK_SIMULATION_FLAGS_WITH_VALUES.has(arg)) {
      index += 1;
    }
  }
  return positional;
}

function cloneJson(value) {
  return value == null ? value ?? null : JSON.parse(JSON.stringify(value));
}

function safeReadFileHash(filePath = "") {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function normalizePathForJson(filePath = "") {
  return String(filePath || "").replace(/\\/g, "/");
}

class TaskSimulationProcessExitError extends Error {
  constructor(code = 0) {
    super(`process.exit(${Number(code) || 0}) called during task simulation`);
    this.name = "TaskSimulationProcessExitError";
    this.exitCode = Number(code) || 0;
  }
}

function formatConsoleCaptureArg(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function withCapturedConsole(enabled, fn) {
  if (!enabled) {
    return { result: await fn(), consoleLines: [] };
  }
  const consoleLines = [];
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const capture = (level) => (...args) => {
    consoleLines.push({
      level,
      message: args.map((value) => formatConsoleCaptureArg(value)).join(" ").trim(),
    });
  };
  console.log = capture("log");
  console.warn = capture("warn");
  console.error = capture("error");
  try {
    return { result: await fn(), consoleLines };
  } catch (error) {
    if (error && typeof error === "object") {
      error.consoleLines = consoleLines;
    }
    throw error;
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
}

async function withInterceptedProcessExit(fn) {
  const originalExit = process.exit;
  process.exit = ((code = 0) => {
    throw new TaskSimulationProcessExitError(code);
  });
  try {
    return await fn();
  } finally {
    process.exit = originalExit;
  }
}

function showHelp(stdout = console.log) {
  stdout(`
  bosun simulate — Live workflow-backed task simulation

  SUBCOMMANDS
    task [id]                Run the real task lifecycle workflow for a task
    task restart             Re-run the last simulated task from scratch
    task resume              Resume the last simulated run from its failure point

  OPTIONS
    --json                   Emit structured JSON output
    --mode <mode>            Retry mode for 'resume': from_failed (default),
                             from_scratch, replan_from_failed, or replan_subgraph
    --diagnose               Include simulator diagnostics in JSON output

  EXAMPLES
    bosun simulate task
    bosun simulate task 97d41516-caca-4c78-10c1-ec0000000000
    bosun simulate task restart --json
    bosun simulate task resume
    bosun simulate task resume --mode replan_from_failed
`);
}

function resolveSimulationStatePath(repoRoot, options = {}) {
  if (options.statePath) return resolve(options.statePath);
  return resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
}

function resolveSimulationLockPath(repoRoot, options = {}) {
  if (options.lockPath) return resolve(options.lockPath);
  return resolve(repoRoot, ".bosun", ".cache", "task-simulator.pid");
}

function buildRuntimeDriftDiagnostics(runtime = {}) {
  const repoRoot = runtime.repoRoot ? resolve(runtime.repoRoot) : process.cwd();
  const workspaceMirrorRoot = runtime.workspaceMirrorRoot || resolve(repoRoot, ".bosun", "workspaces");
  const files = SIMULATOR_RUNTIME_DRIFT_FILES.map((relativePath) => {
    const sourcePath = resolve(repoRoot, relativePath);
    const mirrorPath = resolve(workspaceMirrorRoot, relativePath);
    const sourceHash = safeReadFileHash(sourcePath);
    const mirrorHash = safeReadFileHash(mirrorPath);
    return {
      relativePath,
      sourcePath: normalizePathForJson(sourcePath),
      mirrorPath: normalizePathForJson(mirrorPath),
      sourceExists: Boolean(sourceHash),
      mirrorExists: Boolean(mirrorHash),
      sourceHash,
      mirrorHash,
      differs: Boolean(sourceHash && mirrorHash && sourceHash !== mirrorHash),
    };
  });
  return {
    repoRoot: normalizePathForJson(repoRoot),
    workflowDir: normalizePathForJson(runtime.workflowDir || resolve(repoRoot, ".bosun", "workflows")),
    runsDir: normalizePathForJson(runtime.runsDir || resolve(repoRoot, ".bosun", "workflow-runs")),
    workspaceMirrorRoot: normalizePathForJson(workspaceMirrorRoot),
    driftFiles: files,
    hasMirrorDrift: files.some((entry) => entry.differs),
  };
}

function readSimulationState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeRunStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function resolveRunTaskId(run = {}) {
  return String(
    run?.taskId
    || run?.rootTaskId
    || run?.data?.taskId
    || run?.data?.task?.id
    || run?.detail?.taskId
    || run?.detail?.rootTaskId
    || run?.detail?.data?.taskId
    || run?.detail?.data?.task?.id
    || "",
  ).trim();
}

function resolveRunTaskTitle(run = {}) {
  return String(
    run?.taskTitle
    || run?.title
    || run?.data?.taskTitle
    || run?.data?.title
    || run?.data?.task?.title
    || run?.detail?.taskTitle
    || run?.detail?.title
    || run?.detail?.data?.taskTitle
    || run?.detail?.data?.task?.title
    || "",
  ).trim();
}

function readSimulationRunArtifact(runsDir = "", runId = "") {
  const normalizedRunsDir = String(runsDir || "").trim();
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunsDir || !normalizedRunId) return null;
  const artifactPath = resolve(normalizedRunsDir, `${normalizedRunId}.json`);
  if (!existsSync(artifactPath)) return null;
  try {
    return JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    return null;
  }
}

function resolveResumeArtifactTaskIds(runArtifact = null) {
  const taskIds = new Set();
  const appendTaskId = (value) => {
    const normalized = String(value || "").trim();
    if (normalized) taskIds.add(normalized);
  };
  appendTaskId(resolveRunTaskId(runArtifact));
  for (const task of runArtifact?.nodeOutputs?.trigger?.filteredTasks || []) {
    appendTaskId(task?.taskId || task?.id);
  }
  for (const task of runArtifact?.nodeOutputs?.trigger?.tasks || []) {
    appendTaskId(task?.taskId || task?.id);
  }
  return [...taskIds];
}

function resolveRunWorkflowId(run = {}) {
  return String(
    run?.workflowId
    || run?.detail?.workflowId
    || run?.detail?.data?._workflowId
    || "",
  ).trim();
}

function resolveRunRootRunId(run = {}) {
  return String(
    run?.rootRunId
    || run?.detail?.rootRunId
    || run?.detail?.dagState?.rootRunId
    || run?.detail?.data?._workflowRootRunId
    || "",
  ).trim();
}

function resolveRunId(run = {}) {
  return String(run?.runId || run?.id || run?.detail?.runId || "").trim();
}

function resolveRunCheckpointCursor(run = {}) {
  const value =
    run?.latestCheckpoint?.eventCursor
    ?? run?.detail?.latestCheckpoint?.eventCursor
    ?? run?.eventCursor
    ?? null;
  return Number.isFinite(Number(value)) ? Number(value) : -1;
}

function countCompletedNodeStatuses(run = {}) {
  const statuses =
    run?.nodeStatuses && typeof run.nodeStatuses === "object"
      ? run.nodeStatuses
      : run?.detail?.nodeStatuses && typeof run.detail.nodeStatuses === "object"
        ? run.detail.nodeStatuses
        : {};
  return Object.values(statuses).filter(
    (status) => normalizeRunStatus(status) === "completed",
  ).length;
}

function resolveRunTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveResumeCandidateScore(run = {}, savedRunId = "") {
  const status = normalizeRunStatus(run?.status || run?.detail?.status);
  const statusRank =
    status === "running"
      ? 4
      : status === "failed"
        ? 3
        : status === "paused"
          ? 2
          : status && status !== "completed" && status !== "cancelled"
            ? 1
            : 0;
  return [
    statusRank,
    resolveRunCheckpointCursor(run),
    countCompletedNodeStatuses(run),
    resolveRunTimestamp(
      run?.updatedAt
      || run?.detail?.updatedAt
      || run?.detail?.latestCheckpoint?.updatedAt
      || run?.endedAt
      || run?.startedAt,
    ),
    resolveRunTimestamp(run?.startedAt || run?.detail?.startedAt),
    resolveRunId(run) === savedRunId ? 1 : 0,
  ];
}

function compareResumeCandidateScores(left = [], right = []) {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const delta = Number(left[index] || 0) - Number(right[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function pickBestResumeCandidate(candidates = [], savedRunId = "") {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const bestScore = resolveResumeCandidateScore(best, savedRunId);
    const candidateScore = resolveResumeCandidateScore(candidate, savedRunId);
    return compareResumeCandidateScores(candidateScore, bestScore) > 0
      ? candidate
      : best;
  }, null);
}

function resolveResumeRunId(savedState, runtime = {}) {
  const savedRunId = String(savedState?.runId || "").trim();
  if (!savedRunId) return "";
  const taskId = String(savedState?.taskId || "").trim();
  const workflowId = String(savedState?.workflowId || "").trim();
  const engine = runtime?.engine;
  if (typeof engine?.getRunHistory !== "function") return savedRunId;
  let runHistory = [];
  try {
    runHistory = engine.getRunHistory(workflowId || null, 200);
  } catch {
    return savedRunId;
  }
  if (!Array.isArray(runHistory) || runHistory.length === 0) return savedRunId;

  const savedRun =
    runHistory.find((entry) => resolveRunId(entry) === savedRunId) || null;
  const fallbackTaskIds = taskId
    ? [taskId]
    : resolveResumeArtifactTaskIds(
      readSimulationRunArtifact(runtime?.runsDir, savedRunId),
    );
  const lineageRootRunId =
    resolveRunRootRunId(savedRun) || resolveRunRootRunId(savedState) || savedRunId;
  const matchingCandidates = runHistory.filter((entry) => {
    const runId = resolveRunId(entry);
    if (!runId) return false;
    if (workflowId && resolveRunWorkflowId(entry) !== workflowId) return false;
    if (taskId && resolveRunTaskId(entry) !== taskId) return false;
    if (!lineageRootRunId) return true;
    return (
      runId === savedRunId
      || resolveRunRootRunId(entry) === lineageRootRunId
      || String(entry?.retryOf || entry?.detail?.retryOf || "").trim() === savedRunId
      || String(entry?.parentRunId || entry?.detail?.parentRunId || "").trim() === savedRunId
    );
  });
  if (matchingCandidates.length === 0) return savedRunId;
  let bestCandidate = pickBestResumeCandidate(matchingCandidates, savedRunId);
  const bestCandidateStatus = normalizeRunStatus(bestCandidate?.status || bestCandidate?.detail?.status);
  const strictLineageIsTerminal =
    !bestCandidateStatus || bestCandidateStatus === "completed" || bestCandidateStatus === "cancelled";
  if ((taskId || fallbackTaskIds.length > 0) && strictLineageIsTerminal) {
    const sameTaskCandidates = runHistory.filter((entry) => {
      const runId = resolveRunId(entry);
      if (!runId) return false;
      if (workflowId && resolveRunWorkflowId(entry) !== workflowId) return false;
      const entryTaskId = resolveRunTaskId(entry);
      if (taskId) return entryTaskId === taskId;
      return fallbackTaskIds.includes(entryTaskId);
    });
    const bestTaskCandidate = pickBestResumeCandidate(sameTaskCandidates, savedRunId);
    if (bestTaskCandidate) {
      const taskCandidateScore = resolveResumeCandidateScore(bestTaskCandidate, savedRunId);
      const strictCandidateScore = resolveResumeCandidateScore(bestCandidate, savedRunId);
      if (compareResumeCandidateScores(taskCandidateScore, strictCandidateScore) > 0) {
        bestCandidate = bestTaskCandidate;
      }
    }
  }
  return resolveRunId(bestCandidate) || savedRunId;
}

function writeSimulationState(statePath, payload) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(payload, null, 2), "utf8");
}

function parseSimulationLock(raw) {
  const text = String(raw || "").trim();
  if (!text) return { pid: null, raw: text, data: null };
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return {
        pid: Number(
          data?.pid ??
          data?.processId ??
          data?.ownerPid ??
          data?.process?.pid,
        ),
        raw: text,
        data,
      };
    } catch {
      return { pid: Number(text), raw: text, data: null };
    }
  }
  return { pid: Number(text), raw: text, data: null };
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES";
  }
}

function readSimulationLock(lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    return parseSimulationLock(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function acquireSimulationLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockToken = randomUUID();
  const lockPayload = {
    pid: process.pid,
    lockToken,
    startedAt: new Date().toISOString(),
    argv: [...process.argv],
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, JSON.stringify(lockPayload, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        release() {
          const current = readSimulationLock(lockPath);
          if (current?.data?.lockToken !== lockToken) return;
          try {
            unlinkSync(lockPath);
          } catch {
            /* best effort */
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readSimulationLock(lockPath);
      if (isProcessAlive(existing?.pid)) {
        throw new Error(
          `Another task simulator instance is already running (PID ${existing.pid || "unknown"})`,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* retry once after stale-lock cleanup */
      }
    }
  }

  throw new Error("Failed to acquire task simulator lock");
}

function buildAgentPoolService(overrides = {}) {
  const service = {
    launchEphemeralThread,
    launchOrResumeThread,
    execWithRetry,
    async continueSession(sessionId, prompt, opts = {}) {
      const timeout = Number(opts.timeout) || 60 * 60 * 1000;
      const cwd = opts.cwd || process.cwd();
      return launchOrResumeThread(prompt, cwd, timeout, {
        taskKey: sessionId,
        sdk: opts.sdk,
        model: opts.model,
      });
    },
  };
  return {
    ...service,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function buildKanbanService(overrides = {}) {
  const service = {
    createTask,
    updateTaskStatus,
    updateTask,
    listTasks,
    getTask: getKanbanTask,
  };
  return {
    ...service,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}

function installConfiguredTemplates(engine, config) {
  const workflowDefaults =
    config?.workflowDefaults && typeof config.workflowDefaults === "object"
      ? config.workflowDefaults
      : {};
  const typedWorkflowTemplateConfig =
    typeof resolveWorkflowTemplateConfig === "function"
      ? resolveWorkflowTemplateConfig(config?.workflows || [])
      : { templateIds: [], overridesById: {} };
  const typedWorkflowTemplateIds = new Set(
    Array.isArray(typedWorkflowTemplateConfig?.templateIds)
      ? typedWorkflowTemplateConfig.templateIds
      : [],
  );
  const requestedTemplateOverridesById = {
    ...(workflowDefaults.templateOverridesById || {}),
    ...(typedWorkflowTemplateConfig.overridesById || {}),
  };
  const requestedTemplateIds = new Set(
    typeof resolveWorkflowTemplateIds === "function"
      ? resolveWorkflowTemplateIds({
          profileId: workflowDefaults.profile || "balanced",
          templateIds: workflowDefaults.templates || [],
          workflows: config?.workflows || [],
        })
      : [],
  );
  requestedTemplateIds.add(TASK_SIMULATION_TEMPLATE_ID);
  requestedTemplateIds.add(TASK_SIMULATION_PR_PROGRESSOR_TEMPLATE_ID);
  const workflowDefaultAutoInstallEnabled = workflowDefaults.autoInstall !== false;
  for (const templateId of requestedTemplateIds) {
    const overrides = requestedTemplateOverridesById?.[templateId] || {};
    let installed = (engine.list?.() || []).find(
      (wf) => String(wf?.metadata?.installedFrom || "").trim() === templateId,
    );
    if (
      !installed &&
      (typedWorkflowTemplateIds.has(templateId) || workflowDefaultAutoInstallEnabled)
    ) {
      try {
        installed = installTemplate(templateId, engine, overrides);
      } catch (error) {
        const alreadyInstalled =
          String(error?.message || "").includes("already installed");
        if (!alreadyInstalled) throw error;
        installed = (engine.list?.() || []).find(
          (wf) => String(wf?.metadata?.installedFrom || "").trim() === templateId,
        );
      }
    }
    if (!installed) continue;
    const def = engine.get?.(installed.id);
    if (!def) continue;
    if (!def.metadata?.pausedByWorkflow) {
      def.enabled = true;
    }
    def.variables = {
      ...(def.variables || {}),
      ...overrides,
    };
    def.metadata = {
      ...(def.metadata || {}),
      configuredFrom: typedWorkflowTemplateIds.has(templateId)
        ? "workflows.config"
        : "workflowDefaults",
    };
    engine.save(def);
  }

  if (typeof reconcileInstalledTemplates === "function") {
    const reconcile = reconcileInstalledTemplates(engine, {
      autoUpdateUnmodified: true,
      forceUpdateTemplateIds: TASK_SIMULATION_TEMPLATE_FORCE_UPDATE_IDS,
    });
    if (
      typeof engine.load === "function" &&
      (Number(reconcile?.autoUpdated || 0) > 0 ||
        Number(reconcile?.metadataUpdated || 0) > 0 ||
        (Array.isArray(reconcile?.updatedWorkflowIds) &&
          reconcile.updatedWorkflowIds.length > 0))
    ) {
      engine.load();
    }
  }
}

function resolveInstalledWorkflowId(engine, templateId) {
  const installed = (engine.list?.() || []).find(
    (workflow) =>
      String(workflow?.metadata?.installedFrom || "").trim()
      === templateId &&
      workflow?.enabled !== false,
  );
  if (installed?.id) return installed.id;
  const fallback = (engine.list?.() || []).find(
    (workflow) =>
      String(workflow?.metadata?.installedFrom || "").trim()
      === templateId,
  );
  if (fallback?.id) return fallback.id;
  return "";
}

function resolveInstalledTaskLifecycleWorkflowId(engine) {
  return resolveInstalledWorkflowId(engine, TASK_SIMULATION_TEMPLATE_ID);
}

function resolveWorkflowTemplateIdFromDefinition(definition = null) {
  return String(definition?.metadata?.installedFrom || "").trim();
}

function resolveSimulationWorkflowSelection(runtime = {}, task = null) {
  const templateId = resolveTaskSimulationTemplateId(task, runtime.defaultTargetBranch);
  if (templateId === TASK_SIMULATION_TEMPLATE_ID) {
    return {
      workflowId: runtime.workflowId,
      templateId,
    };
  }
  const workflowId = resolveInstalledWorkflowId(runtime.engine, templateId);
  if (workflowId) {
    return { workflowId, templateId };
  }
  const runtimeWorkflowDefinition =
    typeof runtime.engine?.get === "function"
      ? runtime.engine.get(runtime.workflowId)
      : null;
  if (resolveWorkflowTemplateIdFromDefinition(runtimeWorkflowDefinition) === templateId) {
    return {
      workflowId: runtime.workflowId,
      templateId,
    };
  }
  throw new Error(`Installed workflow for ${templateId} not found`);
}

export async function createTaskSimulationRuntime(options = {}) {
  const config = options.config || loadConfig(process.argv);
  const repoRoot = resolve(
    options.repoRoot || config?.repoRoot || process.env.REPO_ROOT || process.cwd(),
  );
  const defaultTargetBranch = resolveTaskSimulationDefaultTargetBranch(
    config,
    repoRoot,
    options,
  );
  const effectiveConfig = {
    ...(config && typeof config === "object" ? config : {}),
    defaultTargetBranch,
    branchRouting: {
      ...(config?.branchRouting && typeof config.branchRouting === "object"
        ? config.branchRouting
        : {}),
      defaultBranch: defaultTargetBranch,
    },
  };
  const storePath = resolve(options.storePath || resolveKanbanStorePath());
  configureTaskStore({ storePath });
  loadStore();

  await ensureWorkflowNodeTypesLoaded({ repoRoot });

  const promptServices =
    effectiveConfig?.agentPrompts && typeof effectiveConfig.agentPrompts === "object"
      ? { ...effectiveConfig.agentPrompts }
      : {};
  let meetingService = options.services?.meeting || null;
  if (!meetingService) {
    try {
      meetingService = createMeetingWorkflowService();
    } catch {
      meetingService = null;
    }
  }
  const workflowDir = options.workflowDir
    ? resolve(options.workflowDir)
    : resolve(repoRoot, ".bosun", "workflows");
  const runsDir = options.runsDir
    ? resolve(options.runsDir)
    : resolve(repoRoot, ".bosun", "workflow-runs");
  const services = {
    kanban: buildKanbanService(options.services?.kanban),
    agentPool: buildAgentPoolService(options.services?.agentPool),
    taskStore: {
      canStartTask,
      ...(options.services?.taskStore || {}),
    },
    prompts: Object.keys(promptServices).length > 0 ? promptServices : null,
    isolatedRunner: {
      run: runInIsolatedRunner,
      getStatus: getIsolatedRunnerPoolStatus,
      ...(options.services?.isolatedRunner || {}),
    },
    meeting: meetingService,
    ...(options.services || {}),
  };

  const engine = options.engine || getWorkflowEngine({
    services,
    workflowDir,
    runsDir,
    configDir: repoRoot,
    detectInterruptedRuns: false,
  });
  if (!options.skipInstall) {
    installConfiguredTemplates(engine, effectiveConfig);
  }
  const workflowId =
    options.workflowId || resolveInstalledTaskLifecycleWorkflowId(engine);
  if (!workflowId) {
    throw new Error(
      `Installed workflow for ${TASK_SIMULATION_TEMPLATE_ID} not found`,
    );
  }
  if (defaultTargetBranch) {
    const workflowDefinition =
      typeof engine.get === "function" ? engine.get(workflowId) : null;
    if (
      workflowDefinition &&
      typeof workflowDefinition === "object" &&
      String(workflowDefinition?.metadata?.installedFrom || "").trim() === TASK_SIMULATION_TEMPLATE_ID
    ) {
      workflowDefinition.variables = {
        ...(workflowDefinition.variables || {}),
        defaultTargetBranch,
      };
      if (typeof engine.save === "function") {
        engine.save(workflowDefinition);
      }
    }
  }
  return {
    config: effectiveConfig,
    engine,
    repoRoot,
    storePath,
    workflowDir,
    runsDir,
    workflowId,
    defaultTargetBranch,
    statePath: resolveSimulationStatePath(repoRoot, options),
    async close() {
      await waitForStoreWrites();
    },
  };
}

function buildSimulationReport({
  workflowId,
  workflowDefinition = null,
  ctx,
  runtime = {},
  task = null,
  explicitTaskId = "",
  restarted = false,
  resumed = false,
  resumeMode = null,
  originalRunId = null,
  statePath = "",
  statusEvents = [],
  engineConsole = [],
  executionError = null,
}) {
  const triggerNodeId = "trigger";
  const triggerOutput = ctx?.getNodeOutput?.(triggerNodeId) || null;
  const taskId = String(
    ctx?.data?.taskId || triggerOutput?.taskId || explicitTaskId || "",
  ).trim();
  const resolvedTask =
    ctx?.data?.task
    || triggerOutput?.task
    || task
    || null;
  const nodes = Array.isArray(ctx?.definition?.nodes)
    ? ctx.definition.nodes
    : Array.isArray(workflowDefinition?.nodes)
      ? workflowDefinition.nodes
    : [];
  const inferredStatus =
    executionError
      ? "failed"
      :
    triggerOutput?.triggered === false && triggerOutput?.reason === "no_tasks"
      ? "no_task"
      : triggerOutput?.triggered === false
        ? "skipped"
        : Array.isArray(ctx?.errors) && ctx.errors.length > 0
          ? "failed"
          : String(ctx?.data?._workflowTerminalStatus || "completed")
            .trim()
            .toLowerCase() || "completed";
  const nodeReports = nodes.map((node) => ({
    id: node?.id || null,
    label: node?.label || node?.id || null,
    type: node?.type || null,
    status: ctx?.getNodeStatus?.(node?.id) || "pending",
    input: cloneJson(ctx?.getNodeInput?.(node?.id) ?? null),
    output: cloneJson(ctx?.getNodeOutput?.(node?.id) ?? null),
    timing: cloneJson(ctx?.getNodeTiming?.(node?.id) ?? null),
  }));
  const agentLineage = nodeReports
    .filter((node) => String(node?.type || "") === "action.run_agent" || String(node?.id || "").startsWith("run-agent-"))
    .map((node) => ({
      id: node.id,
      status: node.status,
      lineageRunId: node.output?.lineageRunId || node.output?.runId || node.input?.lineageRunId || null,
      sessionId: node.output?.sessionId || node.output?.session?.id || node.input?.sessionId || null,
      blockedReason: node.output?.blockedReason || node.output?.reason || null,
      implementationState: node.output?.implementationState || null,
    }));
  const completedNodeIds = nodeReports
    .filter((node) => node.status === "completed")
    .map((node) => node.id)
    .filter(Boolean);
  const runtimeDiagnostics = buildRuntimeDriftDiagnostics(runtime);
  const resolvedWorkflowId = String(
    workflowId || ctx?.definition?.id || workflowDefinition?.id || "",
  ).trim();
  const templateId =
    resolveWorkflowTemplateIdFromDefinition(ctx?.definition)
    || resolveWorkflowTemplateIdFromDefinition(workflowDefinition)
    || TASK_SIMULATION_TEMPLATE_ID;
  return {
    templateId,
    workflowId: resolvedWorkflowId || null,
    runId: ctx?.id || null,
    status: inferredStatus,
    explicitTaskId: explicitTaskId || null,
    restarted,
    resumed,
    resumeMode: resumeMode || null,
    originalRunId: originalRunId || null,
    taskId: taskId || null,
    taskTitle: String(
      resolvedTask?.title || ctx?.data?.taskTitle || triggerOutput?.taskTitle || "",
    ).trim() || null,
    trigger: cloneJson(triggerOutput),
    restartStatePath: statePath || null,
    errors: [
      ...(Array.isArray(ctx?.errors) ? [...ctx.errors] : []),
      ...(executionError ? [normalizeExecutionError(executionError)] : []),
    ],
    logs: Array.isArray(ctx?.logs) ? [...ctx.logs] : [],
    statusEvents: Array.isArray(statusEvents)
      ? statusEvents.map((entry) => cloneJson(entry))
      : [],
    engineConsole: Array.isArray(engineConsole)
      ? engineConsole.map((entry) => cloneJson(entry))
      : [],
    data: cloneJson(ctx?.data || {}),
    diagnostics: {
      mode: resumed ? "resume" : restarted ? "restart" : explicitTaskId ? "explicit-task" : "next-runnable-task",
      retryMode: resumed ? resumeMode || "from_failed" : null,
      originalRunId: originalRunId || null,
      completedNodeIds,
      agentLineage,
      runtime: runtimeDiagnostics,
      replayRisk: {
        reusedCompletedAgentNodes: resumed && agentLineage.some((entry) => entry.status === "completed" && entry.lineageRunId && entry.lineageRunId !== ctx?.id),
        mirrorDrift: runtimeDiagnostics.hasMirrorDrift,
      },
    },
    nodes: nodeReports,
  };
}

function normalizeExecutionError(error) {
  if (!error) return null;
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
    exitCode:
      Number.isFinite(Number(error?.exitCode)) ? Number(error.exitCode) : null,
    stack: typeof error?.stack === "string" ? error.stack : null,
  };
}

function formatSimulationReport(report = {}) {
  const lines = [
    `template=${report.templateId || TASK_SIMULATION_TEMPLATE_ID} status=${report.status || "unknown"} runId=${report.runId || "n/a"} workflow=${report.workflowId || "n/a"}`,
  ];
  if (report.taskId) {
    lines.push(`task=${report.taskId}${report.taskTitle ? ` ${report.taskTitle}` : ""}`);
  }
  if (report.resumed) {
    lines.push(`mode=resume retryMode=${report.resumeMode || "from_failed"}${report.originalRunId ? ` originalRunId=${report.originalRunId}` : ""}`);
  } else if (report.restarted) {
    lines.push("mode=restart");
  } else if (report.explicitTaskId) {
    lines.push("mode=explicit-task");
  } else {
    lines.push("mode=next-runnable-task");
  }
  for (const node of report.nodes || []) {
    lines.push(`- ${node.id}\t${node.status}\t${node.type}`);
  }
  return lines;
}

export async function executeTaskSimulationCommand(args, options = {}) {
  const normalizedArgs =
    Array.isArray(args) && args[0] === "simulate" ? args.slice(1) : args;
  const subcommand = normalizedArgs?.[0] || "";
  const stdout = options.stdout || ((line) => console.log(line));
  if (
    !subcommand ||
    subcommand === "help" ||
    hasFlag(normalizedArgs, "--help", "-h")
  ) {
    showHelp(stdout);
    return { ok: true, command: "help" };
  }
  if (subcommand !== "task") {
    throw new Error(`Unknown simulate subcommand: ${subcommand}`);
  }

  const taskArgs = normalizedArgs.slice(1);
  const asJson = hasFlag(taskArgs, "--json") || options.json === true;
  const cliStatePath = getFlagValue(taskArgs, "--state-path");
  const cliLockPath = getFlagValue(taskArgs, "--lock-path");
  const runtime =
    options.runtime || await createTaskSimulationRuntime(options);
  const statePath = resolveSimulationStatePath(runtime.repoRoot, {
    statePath: cliStatePath || options.statePath || runtime.statePath,
  });
  const lockPath = resolveSimulationLockPath(runtime.repoRoot, {
    ...options,
    ...(cliLockPath ? { lockPath: cliLockPath } : {}),
  });
  const positional = getPositionalTaskArgs(taskArgs);
  let explicitTaskId = String(positional[0] || "").trim();
  let restarted = false;
  let resumed = false;
  let resumeRunId = "";
  let resumeMode = "from_failed";
  let savedState = null;

  if (explicitTaskId.toLowerCase() === "restart") {
    savedState = readSimulationState(statePath);
    explicitTaskId = String(savedState?.taskId || "").trim();
    if (!explicitTaskId) {
      throw new Error("No prior simulated task recorded for restart");
    }
    restarted = true;
  } else if (explicitTaskId.toLowerCase() === "resume") {
      resumeMode = getFlagValue(taskArgs, "--mode") || "from_failed";
      savedState = readSimulationState(statePath);
    resumeRunId = resolveResumeRunId(savedState, runtime);
    if (!resumeRunId) {
      throw new Error(
        "No prior simulation run recorded for resume — run `bosun simulate task` first",
      );
    }
    // Restore task identity from state for display / report
    explicitTaskId = String(savedState?.taskId || "").trim();
    resumed = true;
  }

  const kanbanTask =
    explicitTaskId && !resumed && typeof runtime.engine?.services?.kanban?.getTask === "function"
      ? await runtime.engine.services.kanban.getTask(explicitTaskId)
      : explicitTaskId && resumed && typeof runtime.engine?.services?.kanban?.getTask === "function"
        ? await runtime.engine.services.kanban.getTask(explicitTaskId).catch(() => null)
        : null;
  if (explicitTaskId && !kanbanTask && !resumed) {
    throw new Error(`Task "${explicitTaskId}" not found`);
  }
  if (resumed && kanbanTask && isTerminalSimulationTaskStatus(kanbanTask)) {
    throw new Error(
      `Task "${explicitTaskId}" is already ${normalizeSimulationTaskStatus(kanbanTask)}; resume is not allowed for terminal tasks`,
    );
  }
  const workflowSelection =
    explicitTaskId && !resumed
      ? resolveSimulationWorkflowSelection(runtime, kanbanTask)
      : {
          workflowId: runtime.workflowId,
          templateId:
            resolveWorkflowTemplateIdFromDefinition(
              typeof runtime.engine?.get === "function"
                ? runtime.engine.get(runtime.workflowId)
                : null,
            ) || TASK_SIMULATION_TEMPLATE_ID,
        };

  const input = {
    repoRoot: runtime.repoRoot,
    _triggerSource: restarted ? "simulate.task.restart" : "simulate.task",
    _simulation: true,
  };
  if (explicitTaskId && !resumed) {
    input.taskId = explicitTaskId;
    input.taskTitle = kanbanTask?.title || "";
    if (kanbanTask) {
      Object.assign(input, buildSimulationExecutionInput(
        kanbanTask,
        runtime.defaultTargetBranch,
        workflowSelection.templateId,
      ));
    }
  }

  const statusEvents = [];
  const onStatus = (event) => {
    statusEvents.push(cloneJson(event));
  };
  runtime.engine.on?.("workflow:status", onStatus);
  const simulationLock = acquireSimulationLock(lockPath);
  try {
    const captureConsole = asJson || options.forceJsonOutput === true;
    let ctx = null;
    let consoleLines = [];
    let executionError = null;
    let originalRunId = null;
    try {
      if (resumed) {
        const execution = await withCapturedConsole(
          captureConsole,
          async () => withInterceptedProcessExit(
            () => runtime.engine.retryRun(resumeRunId, { mode: resumeMode }),
          ),
        );
        const retryResult = execution.result;
        ctx = retryResult?.ctx || null;
        originalRunId = resumeRunId;
        consoleLines = execution.consoleLines;
      } else {
        const execution = await withCapturedConsole(
          captureConsole,
          async () => withInterceptedProcessExit(
            () => runtime.engine.execute(workflowSelection.workflowId, input),
          ),
        );
        ctx = execution.result;
        consoleLines = execution.consoleLines;
      }
    } catch (error) {
      executionError = error;
      consoleLines = Array.isArray(error?.consoleLines) ? error.consoleLines : [];
    }
    const report = buildSimulationReport({
      workflowId: ctx?.definition?.id || workflowSelection.workflowId,
      workflowDefinition:
        typeof runtime.engine?.get === "function"
          ? (ctx?.definition || runtime.engine.get(ctx?.definition?.id || workflowSelection.workflowId))
          : null,
      ctx,
      runtime,
      task: kanbanTask,
      explicitTaskId,
      restarted,
      resumed,
      resumeMode: resumed ? resumeMode : null,
      originalRunId,
      statePath,
      statusEvents,
      engineConsole: consoleLines,
      executionError,
    });
    if (report.runId) {
      let recoveredRunState = null;
      try {
        if (typeof runtime.engine?.getRunHistory === "function") {
          const history = runtime.engine.getRunHistory(
            report.workflowId || savedState?.workflowId || null,
            200,
          );
          if (Array.isArray(history)) {
            const recoveryRunId = String(
              originalRunId || resumeRunId || savedState?.runId || "",
            ).trim();
            recoveredRunState =
              history.find((entry) => resolveRunId(entry) === recoveryRunId)
              || null;
          }
        }
      } catch {
        recoveredRunState = null;
      }
      const preservedTaskId = String(
        report.taskId
        || explicitTaskId
        || savedState?.taskId
        || resolveRunTaskId(recoveredRunState)
        || "",
      ).trim() || null;
      const preservedTaskTitle = String(
        report.taskTitle
        || savedState?.taskTitle
        || resolveRunTaskTitle(recoveredRunState)
        || "",
      ).trim() || null;
      const preservedWorkflowId = String(
        report.workflowId || savedState?.workflowId || "",
      ).trim() || null;
      const preservePriorRunState =
        resumed
        && (!report.taskId || !explicitTaskId)
        && String(originalRunId || "").trim();
      const persistedRunId = preservePriorRunState
        ? String(originalRunId || "").trim()
        : report.runId;
      writeSimulationState(statePath, {
        taskId: preservedTaskId,
        taskTitle: preservedTaskTitle,
        runId: persistedRunId,
        workflowId: preservedWorkflowId,
        repoRoot: runtime.repoRoot,
        savedAt: new Date().toISOString(),
      });
    }
    if (asJson || options.forceJsonOutput === true) {
      stdout(JSON.stringify(report, null, 2));
    } else {
      for (const line of formatSimulationReport(report)) stdout(line);
    }
    return { ok: true, command: "task", report };
  } finally {
    simulationLock.release();
    runtime.engine.off?.("workflow:status", onStatus);
    await runtime.close?.();
  }
}

export async function runTaskSimulationCli(args, options = {}) {
  return executeTaskSimulationCommand(
    ["simulate", ...(Array.isArray(args) ? args : [])],
    options,
  );
}

export default runTaskSimulationCli;
