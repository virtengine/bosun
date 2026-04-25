/**
 * fleet-coordinator.mjs — Multi-workstation coordination for bosun.
 *
 * Provides:
 *   - Repo fingerprinting: detect identical repos across workstations
 *   - Fleet discovery: enumerate active instances working on the same repo
 *   - Coordinator election integration: single leader dispatches tasks
 *   - Task slot aggregation: total parallel capacity across fleet
 *   - Conflict-aware task dispatch: order + assign tasks to minimize conflicts
 *   - Maintenance mode: when backlog is empty, fleet enters maintenance
 *
 * The coordinator (elected via presence.mjs) is the only instance that:
 *   1. Triggers the task planner to generate new backlog items
 *   2. Assigns execution order and workstation routing hints
 *   3. Broadcasts fleet status updates
 *
 * Non-coordinator instances:
 *   - Report their presence and capacity
 *   - Pull tasks from kanban backlog in the assigned order
 *   - Contribute shared knowledge entries
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initPresence,
  buildLocalPresence,
  listActiveInstances,
  selectCoordinator,
  getPresenceState,
} from "../infra/presence.mjs";
import { sanitizeGitEnv } from "../git/git-safety.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Workflow Event Bridge ────────────────────────────────────────────────────
// The daemon injects its workflow-event queue. Library callers (like the task
// simulator) intentionally run without monitor side effects, so this must stay
// a no-op until a real owner wires it up.
let _queueWorkflowEvent = null;
export function setFleetWorkflowEventQueue(queueFn) {
  _queueWorkflowEvent = typeof queueFn === "function" ? queueFn : null;
}
function emitFleetEvent(eventType, eventData = {}, opts = {}) {
  if (!_queueWorkflowEvent) return;
  _queueWorkflowEvent(eventType, eventData, opts);
}

// ── Repo Fingerprinting ──────────────────────────────────────────────────────

function buildGitEnv() {
  return sanitizeGitEnv();
}

function normalizeRoutingToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function readHierarchyField(source, candidates = []) {
  if (!source || typeof source !== "object") return "";
  for (const key of candidates) {
    const value = source?.[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function listPeerCapabilities(peer) {
  return Array.isArray(peer?.capabilities)
    ? peer.capabilities
        .map((value) => normalizeRoutingToken(value))
        .filter(Boolean)
    : [];
}

function getTaskRoutingProfile(task) {
  return {
    scope: readHierarchyField(task, ["scope"]),
    teamId: readHierarchyField(task, ["coordinationTeamId", "teamId"]),
    role: readHierarchyField(task, ["coordinationRole", "teamRole", "role"]),
    reportsTo: readHierarchyField(task, ["coordinationReportsTo", "reportsTo"]),
    level: readHierarchyField(task, ["coordinationLevel", "teamLevel", "level"]),
  };
}

function getPeerRoutingProfile(peer) {
  return {
    teamId: readHierarchyField(peer, ["teamId", "team_id", "coordinationTeamId"]),
    role: readHierarchyField(peer, ["teamRole", "team_role", "coordinationRole", "workspace_role", "role"]),
    reportsTo: readHierarchyField(peer, ["reportsTo", "reports_to", "coordinationReportsTo"]),
    level: readHierarchyField(peer, ["teamLevel", "team_level", "coordinationLevel"]),
    capabilities: listPeerCapabilities(peer),
  };
}

function scorePeerForTask(peer, task) {
  const taskProfile = getTaskRoutingProfile(task);
  const peerProfile = getPeerRoutingProfile(peer);
  const reasons = [];
  let score = 0;

  const taskTeam = normalizeRoutingToken(taskProfile.teamId);
  const peerTeam = normalizeRoutingToken(peerProfile.teamId);
  if (taskTeam && peerTeam && taskTeam === peerTeam) {
    score += 80;
    reasons.push("team-match");
  }

  const taskRole = normalizeRoutingToken(taskProfile.role);
  const peerRole = normalizeRoutingToken(peerProfile.role);
  if (taskRole && peerRole && taskRole === peerRole) {
    score += 60;
    reasons.push("role-match");
  }

  const taskReportsTo = normalizeRoutingToken(taskProfile.reportsTo);
  const peerReportsTo = normalizeRoutingToken(peerProfile.reportsTo);
  const peerId = normalizeRoutingToken(peer?.instance_id);
  const peerLabel = normalizeRoutingToken(peer?.instance_label);
  if (
    taskReportsTo &&
    (
      taskReportsTo === peerReportsTo ||
      taskReportsTo === peerId ||
      taskReportsTo === peerLabel
    )
  ) {
    score += 40;
    reasons.push("reports-to-match");
  }

  const taskLevel = normalizeRoutingToken(taskProfile.level);
  const peerLevel = normalizeRoutingToken(peerProfile.level);
  if (taskLevel && peerLevel && taskLevel === peerLevel) {
    score += 20;
    reasons.push("level-match");
  }

  const taskScope = normalizeRoutingToken(taskProfile.scope);
  if (
    taskScope &&
    peerProfile.capabilities.some((value) => value.includes(taskScope))
  ) {
    score += 25;
    reasons.push("capability-match");
  }

  if (
    taskRole &&
    peerProfile.capabilities.some((value) =>
      value === taskRole || value.includes(taskRole),
    )
  ) {
    score += 15;
    reasons.push("role-capability-match");
  }

  return { score, reasons };
}

function selectBestPeerForTask(task, peers, defaultPeer) {
  if (!task || !Array.isArray(peers) || peers.length === 0) {
    return { peer: defaultPeer, reasons: [] };
  }
  let bestPeer = defaultPeer;
  let bestReasons = [];
  let bestScore = -1;
  for (const peer of peers) {
    const candidate = scorePeerForTask(peer, task);
    if (candidate.score > bestScore) {
      bestScore = candidate.score;
      bestPeer = peer;
      bestReasons = candidate.reasons;
    }
  }
  if (bestScore <= 0) {
    return { peer: defaultPeer, reasons: [] };
  }
  return { peer: bestPeer, reasons: bestReasons };
}

/**
 * Generate a stable fingerprint for a git repository.
 * Two workstations with the same repo will produce the same fingerprint.
 *
 * Components (in order of reliability):
 *   1. Remote origin URL (normalized — strips .git suffix, protocol variance)
 *   2. Fallback: first commit hash (immutable root of the repo)
 */
export function computeRepoFingerprint(repoRoot) {
  if (!repoRoot) return null;

  // Ensure repoRoot is actually inside a git worktree.
  try {
    const isWorktree = execSync("git rev-parse --is-inside-work-tree", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (isWorktree !== "true") {
      return null;
    }
  } catch {
    return null;
  }

  // Try remote origin URL first (most reliable for same-repo detection)
  let remoteUrl = null;
  try {
    remoteUrl = execSync("git config --get remote.origin.url", {
      cwd: repoRoot,
      encoding: "utf8",
      env: buildGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // no remote configured
  }

  if (remoteUrl) {
    const normalized = normalizeGitUrl(remoteUrl);
    return {
      method: "remote-origin",
      raw: remoteUrl,
      normalized,
      hash: hashString(normalized),
    };
  }

  // Fallback: first commit hash (root of the DAG)
  try {
    const rootCommit = execSync("git rev-list --max-parents=0 HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      env: buildGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().split("\n")[0];

    if (rootCommit) {
      return {
        method: "root-commit",
        raw: rootCommit,
        normalized: rootCommit,
        hash: hashString(rootCommit),
      };
    }
  } catch {
    // not a git repo or no commits
  }

  return null;
}

/**
 * Normalize a git URL to strip protocol/auth/suffix variance.
 * Examples:
 *   https://github.com/acme/widgets.git → github.com/acme/widgets
 *   git@github.com:acme/widgets.git     → github.com/acme/widgets
 *   ssh://git@github.com/acme/widgets   → github.com/acme/widgets
 */
export function normalizeGitUrl(url) {
  if (!url) return "";
  let s = String(url).trim();

  // Strip protocol
  s = s.replace(/^(?:https?|ssh|git):\/\//, "");

  // Strip user@ prefix (git@github.com: or user@host/)
  s = s.replace(/^[^@]+@/, "");

  // Normalize SSH colon syntax (github.com:org/repo → github.com/org/repo)
  s = s.replace(/^([^/:]+):/, "$1/");

  // Strip .git suffix
  s = s.replace(/\.git$/, "");

  // Strip trailing slashes
  while (s.endsWith("/")) s = s.slice(0, -1);

  return s.toLowerCase();
}

function hashString(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// ── Fleet State ──────────────────────────────────────────────────────────────

const FLEET_STATE_FILENAME = "fleet-state.json";

const fleetState = {
  initialized: false,
  repoFingerprint: null,
  isCoordinator: false,
  fleetSize: 0,
  totalSlots: 0,
  localSlots: 0,
  mode: "solo", // solo | fleet | maintenance
  peers: [],        // instances with same repo fingerprint
  dispatchOrder: [], // task IDs in conflict-minimized order
  lastSyncAt: null,
};

/**
 * Initialize fleet coordination.
 * Must be called after presence.mjs is initialized.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - Git repository root
 * @param {number} opts.localSlots - Max parallel agents on this workstation
 * @param {number} [opts.ttlMs] - Presence TTL (default: 5 min)
 * @param {object} [opts.localWorkspace] - Workspace identity from registry
 */
export async function initFleet(opts = {}) {
  const { repoRoot, localSlots = 6, ttlMs = 5 * 60 * 1000, localWorkspace } = opts;

  if (!repoRoot) {
    console.warn("[fleet] No repo root provided — running in solo mode");
    fleetState.mode = "solo";
    fleetState.localSlots = localSlots;
    fleetState.totalSlots = localSlots;
    fleetState.initialized = true;
    return fleetState;
  }

  // Compute repo fingerprint
  fleetState.repoFingerprint = computeRepoFingerprint(repoRoot);
  fleetState.localSlots = localSlots;

  // Ensure presence is initialized
  await initPresence({ repoRoot, localWorkspace });

  // Discover fleet
  await refreshFleet({ ttlMs });

  fleetState.initialized = true;
  console.log(
    `[fleet] initialized: mode=${fleetState.mode}, peers=${fleetState.fleetSize}, ` +
    `totalSlots=${fleetState.totalSlots}, fingerprint=${fleetState.repoFingerprint?.hash || "none"}`,
  );

  return fleetState;
}

/**
 * Refresh fleet state from presence data.
 * Called periodically by the maintenance loop.
 */
export async function refreshFleet({ ttlMs = 5 * 60 * 1000 } = {}) {
  const nowMs = Date.now();
  const allInstances = listActiveInstances({ nowMs, ttlMs });
  const localFingerprint = fleetState.repoFingerprint?.hash;

  if (!localFingerprint || allInstances.length <= 1) {
    // Solo mode — only us
    fleetState.mode = "solo";
    fleetState.fleetSize = 1;
    fleetState.totalSlots = fleetState.localSlots;
    fleetState.peers = [];
    fleetState.isCoordinator = true; // solo = always coordinator
    fleetState.lastSyncAt = new Date().toISOString();
    return fleetState;
  }

  // Filter to peers with matching repo fingerprint
  const peers = allInstances.filter((inst) => {
    const peerFingerprint = inst.repo_fingerprint;
    return peerFingerprint && peerFingerprint === localFingerprint;
  });

  fleetState.peers = peers;
  fleetState.fleetSize = Math.max(1, peers.length);

  // Aggregate capacity
  let totalSlots = 0;
  for (const peer of peers) {
    totalSlots += typeof peer.max_parallel === "number" ? peer.max_parallel : 6;
  }
  // Ensure we count ourselves even if not yet in the presence list
  if (!peers.some((p) => p.instance_id === getPresenceState().instance_id)) {
    totalSlots += fleetState.localSlots;
    fleetState.fleetSize += 1;
  }
  fleetState.totalSlots = totalSlots || fleetState.localSlots;

  // Determine if we're the coordinator
  const coordinator = selectCoordinator({ nowMs, ttlMs });
  const myId = getPresenceState().instance_id;
  fleetState.isCoordinator = coordinator?.instance_id === myId;

  // Fleet vs solo
  fleetState.mode = fleetState.fleetSize > 1 ? "fleet" : "solo";
  fleetState.lastSyncAt = new Date().toISOString();

  return fleetState;
}

// ── Fleet-Aware Presence Payload ─────────────────────────────────────────────

/**
 * Build a presence payload enriched with fleet coordination data.
 * This is broadcast to other instances so they can match repos.
 */
export function buildFleetPresence(extra = {}) {
  const base = buildLocalPresence(extra);
  return {
    ...base,
    repo_fingerprint: fleetState.repoFingerprint?.hash || null,
    max_parallel: fleetState.localSlots,
    fleet_mode: fleetState.mode,
    is_coordinator: fleetState.isCoordinator,
  };
}

// ── Conflict-Aware Task Ordering ────────────────────────────────────────────

/**
 * File-path based conflict graph for tasks.
 * Tasks touching overlapping file paths should not run in parallel.
 *
 * @param {Array<{id: string, title: string, scope?: string, filePaths?: string[]}>} tasks
 * @returns {Array<Array<string>>} waves — groups of task IDs safe for parallel execution
 */
export function buildExecutionWaves(tasks) {
  if (!tasks || tasks.length === 0) return [];

  // Build scope-based conflict sets (tasks with same scope conflict)
  const scopeMap = new Map(); // scope → [taskId, ...]
  const fileMap = new Map();  // filePath → [taskId, ...]
  const taskById = new Map();

  for (const task of tasks) {
    const id = task.id || task.title;
    taskById.set(id, task);

    // Scope-based conflicts
    const scope = task.scope || extractScopeFromTask(task.title);
    if (scope) {
      if (!scopeMap.has(scope)) scopeMap.set(scope, []);
      scopeMap.get(scope).push(id);
    }

    // File-path based conflicts (when available)
    if (Array.isArray(task.filePaths)) {
      for (const fp of task.filePaths) {
        const normalizedPath = fp.replace(/\\/g, "/").toLowerCase();
        if (!fileMap.has(normalizedPath)) fileMap.set(normalizedPath, []);
        fileMap.get(normalizedPath).push(id);
      }
    }
  }

  // Build adjacency list (conflict graph)
  const conflicts = new Map(); // taskId → Set<conflicting taskIds>
  for (const [, taskIds] of [...scopeMap, ...fileMap]) {
    if (taskIds.length > 1) {
      for (let i = 0; i < taskIds.length; i++) {
        for (let j = i + 1; j < taskIds.length; j++) {
          if (!conflicts.has(taskIds[i])) conflicts.set(taskIds[i], new Set());
          if (!conflicts.has(taskIds[j])) conflicts.set(taskIds[j], new Set());
          conflicts.get(taskIds[i]).add(taskIds[j]);
          conflicts.get(taskIds[j]).add(taskIds[i]);
        }
      }
    }
  }

  // Greedy graph coloring (Welsh-Powell) for wave assignment
  const allIds = tasks.map((t) => t.id || t.title);
  const sortedIds = [...allIds].sort((a, b) => {
    const ca = conflicts.get(a)?.size || 0;
    const cb = conflicts.get(b)?.size || 0;
    return cb - ca; // highest degree first
  });

  const waves = [];
  const assigned = new Set();

  for (const taskId of sortedIds) {
    if (assigned.has(taskId)) continue;

    // Find first wave this task can join (no conflicts with existing members)
    let placed = false;
    for (const wave of waves) {
      const hasConflict = wave.some(
        (wId) => conflicts.get(taskId)?.has(wId) || conflicts.get(wId)?.has(taskId),
      );
      if (!hasConflict) {
        wave.push(taskId);
        assigned.add(taskId);
        placed = true;
        break;
      }
    }

    if (!placed) {
      waves.push([taskId]);
      assigned.add(taskId);
    }
  }

  return waves;
}

/**
 * Extract scope from a task title (conventional commit format).
 * E.g., "feat(veid): add flow" → "veid"
 */
function extractScopeFromTask(title) {
  if (!title) return null;
  const m = title.match(
    /^(?:\[P\d+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  return m ? m[1].toLowerCase() : null;
}

// ── Workstation Task Assignment ──────────────────────────────────────────────

/**
 * Given a set of execution waves and fleet peers, assign tasks to workstations.
 * Returns a dispatch plan that each workstation can consume.
 *
 * @param {Array<Array<string>>} waves - Output of buildExecutionWaves
 * @param {Array<{instance_id: string, max_parallel?: number, capabilities?: string[]}>} peers
 * @returns {object} dispatchPlan
 */
export function assignTasksToWorkstations(waves, peers, taskMap = new Map()) {
  if (!peers || peers.length === 0 || !waves || waves.length === 0) {
    return { assignments: [], totalTasks: 0, totalPeers: 0 };
  }

  const assignments = [];
  let waveIndex = 0;

  for (const wave of waves) {
    waveIndex++;
    const waveAssignments = [];

    // Round-robin distribute tasks in this wave across peers
      for (let i = 0; i < wave.length; i++) {
        const taskId = wave[i];
        const peer = peers[i % peers.length];
        const task = taskMap.get(taskId);
        const { peer: bestPeer, reasons } = selectBestPeerForTask(task, peers, peer);

        waveAssignments.push({
          taskId,
          taskTitle: task?.title || taskId,
          wave: waveIndex,
          assignedTo: bestPeer.instance_id,
          assignedToLabel: bestPeer.instance_label || bestPeer.instance_id,
          assignmentReasons: reasons,
        });
      }

    assignments.push(...waveAssignments);
  }

  const result = {
    assignments,
    totalTasks: assignments.length,
    totalPeers: peers.length,
    waveCount: waves.length,
    createdAt: new Date().toISOString(),
  };

  emitFleetEvent("fleet.tasks_assigned", {
    totalTasks: result.totalTasks,
    totalPeers: result.totalPeers,
    waveCount: result.waveCount,
  }, { dedupKey: `fleet-assign-${result.createdAt}` });

  return result;
}

// ── Backlog Depth Calculator ─────────────────────────────────────────────────

/**
 * Calculate how many tasks should be in the backlog based on fleet size.
 * More workstations = deeper backlog to keep everyone busy.
 *
 * @param {object} opts
 * @param {number} opts.totalSlots - Total parallel agent slots across fleet
 * @param {number} opts.currentBacklog - Current todo tasks in backlog
 * @param {number} [opts.bufferMultiplier=3] - How many rounds of work to buffer
 * @param {number} [opts.minTasks=6] - Minimum backlog depth
 * @param {number} [opts.maxTasks=100] - Cap to prevent over-generation
 * @returns {object} { targetDepth, deficit, shouldGenerate }
 */
export function calculateBacklogDepth(opts = {}) {
  const {
    totalSlots = 6,
    currentBacklog = 0,
    bufferMultiplier = 3,
    minTasks = 6,
    maxTasks = 100,
  } = opts;

  // Target: enough tasks for N full rounds of parallel execution
  const rawTarget = totalSlots * bufferMultiplier;
  const targetDepth = Math.max(minTasks, Math.min(rawTarget, maxTasks));
  const deficit = Math.max(0, targetDepth - currentBacklog);

  return {
    totalSlots,
    currentBacklog,
    targetDepth,
    deficit,
    shouldGenerate: deficit > 0,
    formula: `${totalSlots} slots × ${bufferMultiplier} buffer = ${rawTarget} (clamped to ${targetDepth})`,
  };
}

// ── Maintenance Mode Detection ───────────────────────────────────────────────

/**
 * Determine if the fleet should enter maintenance mode.
 * Maintenance mode means: all functional work is done, switch to
 * housekeeping (dependency updates, test coverage, refactoring, docs).
 *
 * @param {object} status - Project status
 * @returns {object} { isMaintenanceMode, reason }
 */
export function detectMaintenanceMode(status) {
  if (!status) return { isMaintenanceMode: false, reason: "no status data" };

  const counts = status.counts || {};
  const backlog = status.backlog_remaining ?? 0;
  const running = counts.running ?? 0;
  const review = counts.review ?? 0;
  const todo = counts.todo ?? 0;

  // Maintenance mode: nothing to do AND nothing in progress
  if (backlog === 0 && todo === 0 && running === 0 && review === 0) {
    emitFleetEvent("fleet.maintenance_mode", {
      isMaintenanceMode: true,
      reason: "all tasks completed — no backlog, no active work",
    });
    return {
      isMaintenanceMode: true,
      reason: "all tasks completed — no backlog, no active work",
    };
  }

  return {
    isMaintenanceMode: false,
    reason: `active: backlog=${backlog} todo=${todo} running=${running} review=${review}`,
  };
}

// ── Task List Sharing ────────────────────────────────────────────────────────

/**
 * @typedef {object} SharedTaskList
 * @property {string} instanceId  - Which workstation published this list
 * @property {string} instanceLabel
 * @property {string} repoFingerprint
 * @property {Array<{id: string, title: string, status: string, size?: string, complexity?: string}>} tasks
 * @property {string} publishedAt - ISO timestamp
 */

const SHARED_TASKS_FILENAME = "fleet-tasks.json";

/**
 * Publish this workstation's current task list so peers can pull it.
 * Called periodically by the fleet sync loop.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - Git repository root for persistence
 * @param {Array<object>} opts.tasks - Current tasks (from kanban or orchestrator)
 * @returns {SharedTaskList}
 */
export async function publishTaskList({ repoRoot, tasks = [] } = {}) {
  const presenceState = getPresenceState();
  const payload = {
    instanceId: presenceState.instance_id,
    instanceLabel: presenceState.instance_label || presenceState.instance_id,
    repoFingerprint: fleetState.repoFingerprint?.hash || null,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title || "",
      status: t.status || "unknown",
      size: t.size || t.metadata?.size || null,
      complexity: t.complexity || null,
    })),
    publishedAt: new Date().toISOString(),
  };

  try {
    const dir = resolve(repoRoot || process.cwd(), FLEET_STATE_DIR);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, SHARED_TASKS_FILENAME);
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.warn(`[fleet] publishTaskList error: ${err.message}`);
  }

  return payload;
}

/**
 * Read another workstation's shared task list (from their fleet-tasks.json).
 * In practice, workstations share this via a shared filesystem or git sync.
 *
 * @param {string} filePath - Path to the fleet-tasks.json file
 * @returns {SharedTaskList|null}
 */
export async function readPeerTaskList(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    // Validate shape
    if (!data.instanceId || !Array.isArray(data.tasks)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Bootstrap a new workstation from an existing peer's task list.
 * When a new workstation joins with no local backlog, it can pull tasks
 * from the coordinator or any active peer.
 *
 * @param {object} opts
 * @param {Array<SharedTaskList>} opts.peerLists - Task lists from peers
 * @param {string} [opts.myInstanceId] - This workstation's instance ID (to exclude self)
 * @returns {{ tasks: Array, source: string, sourceLabel: string }|null}
 */
export function bootstrapFromPeer({ peerLists = [], myInstanceId } = {}) {
  if (!peerLists.length) return null;

  // Filter to peers with matching repo fingerprint (if we have one)
  const myFingerprint = fleetState.repoFingerprint?.hash;
  let candidates = peerLists;
  if (myFingerprint) {
    candidates = peerLists.filter(
      (pl) => pl.repoFingerprint === myFingerprint,
    );
  }

  // Exclude self
  if (myInstanceId) {
    candidates = candidates.filter((pl) => pl.instanceId !== myInstanceId);
  }

  if (!candidates.length) return null;

  // Pick the peer with the most todo tasks
  let best = null;
  let bestTodoCount = 0;
  for (const pl of candidates) {
    const todoCount = pl.tasks.filter((t) => t.status === "todo").length;
    if (todoCount > bestTodoCount) {
      bestTodoCount = todoCount;
      best = pl;
    }
  }

  if (!best || bestTodoCount === 0) return null;

  return {
    tasks: best.tasks.filter((t) => t.status === "todo"),
    source: best.instanceId,
    sourceLabel: best.instanceLabel,
    totalAvailable: bestTodoCount,
  };
}

// ── Task Auto-Generation Trigger ─────────────────────────────────────────────

/**
 * @typedef {object} AutoGenDecision
 * @property {boolean} shouldGenerate  - Whether to trigger task generation
 * @property {string}  reason          - Why/why not
 * @property {number}  deficit         - How many tasks are needed
 * @property {boolean} needsApproval   - Whether user approval is required first
 * @property {string}  mode            - "auto" | "confirm" | "skip"
 */

/** @type {number|null} Last time auto-gen was triggered */
let lastAutoGenTimestamp = null;

/**
 * Decide whether to trigger automatic task generation.
 *
 * Conditions for generation:
 *   1. Backlog is below threshold (based on fleet capacity)
 *   2. Cooldown has elapsed since last generation
 *   3. This instance is the coordinator (in fleet mode)
 *
 * @param {object} opts
 * @param {number} opts.currentBacklog    - Current todo task count
 * @param {string} [opts.plannerMode]     - Deprecated, ignored. Kept for backward compat.
 * @param {number} [opts.cooldownMs=3600000] - Min time between generations (default: 1 hour)
 * @param {boolean} [opts.requireApproval=true] - Whether to require user confirmation
 * @returns {AutoGenDecision}
 */
export function shouldAutoGenerateTasks({
  currentBacklog = 0,
  plannerMode: _plannerMode,
  cooldownMs = 60 * 60 * 1000,
  requireApproval = true,
} = {}) {
  // Not coordinator in fleet mode → skip (only coordinator generates)
  if (fleetState.mode === "fleet" && !fleetState.isCoordinator) {
    return {
      shouldGenerate: false,
      reason: "not fleet coordinator",
      deficit: 0,
      needsApproval: false,
      mode: "skip",
    };
  }

  // Cooldown check
  if (lastAutoGenTimestamp && Date.now() - lastAutoGenTimestamp < cooldownMs) {
    const remainingMs = cooldownMs - (Date.now() - lastAutoGenTimestamp);
    return {
      shouldGenerate: false,
      reason: `cooldown active (${Math.ceil(remainingMs / 60000)} min remaining)`,
      deficit: 0,
      needsApproval: false,
      mode: "skip",
    };
  }

  // Calculate backlog depth
  const depth = calculateBacklogDepth({
    totalSlots: fleetState.totalSlots || fleetState.localSlots,
    currentBacklog,
  });

  if (!depth.shouldGenerate) {
    return {
      shouldGenerate: false,
      reason: `backlog sufficient (${currentBacklog}/${depth.targetDepth})`,
      deficit: 0,
      needsApproval: false,
      mode: "skip",
    };
  }

  return {
    shouldGenerate: true,
    reason: `backlog low (${currentBacklog}/${depth.targetDepth}, deficit=${depth.deficit})`,
    deficit: depth.deficit,
    needsApproval: requireApproval,
    mode: requireApproval ? "confirm" : "auto",
  };
}

/**
 * Mark that auto-generation was triggered (for cooldown tracking).
 */
export function markAutoGenTriggered() {
  lastAutoGenTimestamp = Date.now();
  emitFleetEvent("fleet.auto_gen_triggered", {
    triggeredAt: new Date(lastAutoGenTimestamp).toISOString(),
  });
}

/**
 * Reset auto-gen cooldown (for testing).
 */
export function resetAutoGenCooldown() {
  lastAutoGenTimestamp = null;
}
// ── Fleet State Persistence ──────────────────────────────────────────────────

const FLEET_STATE_DIR = ".cache/bosun";

async function getFleetStatePath(repoRoot) {
  const dir = resolve(repoRoot || process.cwd(), FLEET_STATE_DIR);
  await mkdir(dir, { recursive: true });
  return resolve(dir, FLEET_STATE_FILENAME);
}

export async function persistFleetState(repoRoot) {
  try {
    const path = await getFleetStatePath(repoRoot);
    const payload = {
      ...fleetState,
      peers: fleetState.peers.map((p) => ({
        instance_id: p.instance_id,
        instance_label: p.instance_label,
        max_parallel: p.max_parallel,
        capabilities: p.capabilities,
        host: p.host,
      })),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
  } catch (err) {
    console.warn(`[fleet] persist error: ${err.message}`);
  }
}

export async function loadFleetState(repoRoot) {
  try {
    const path = await getFleetStatePath(repoRoot);
    if (!existsSync(path)) return null;
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Public Getters ───────────────────────────────────────────────────────────

export function getFleetState() {
  return { ...fleetState };
}

export function isFleetCoordinator() {
  return fleetState.isCoordinator;
}

export function getFleetMode() {
  return fleetState.mode;
}

export function getFleetSize() {
  return fleetState.fleetSize;
}

export function getTotalFleetSlots() {
  return fleetState.totalSlots;
}

/**
 * Format a human-readable fleet status summary.
 */
export function formatFleetSummary() {
  const fp = fleetState.repoFingerprint;
  const lines = [
    `:server: Fleet Status: ${fleetState.mode.toUpperCase()}`,
    `Repo: ${fp?.normalized || "unknown"} (${fp?.hash?.slice(0, 8) || "no fingerprint"})`,
    `Coordinator: ${fleetState.isCoordinator ? "THIS INSTANCE" : "remote"}`,
    `Fleet size: ${fleetState.fleetSize} workstation(s)`,
    `Total slots: ${fleetState.totalSlots}`,
    `Local slots: ${fleetState.localSlots}`,
  ];

  if (fleetState.peers.length > 0) {
    lines.push("", "Peers:");
    for (const peer of fleetState.peers) {
      const label = peer.instance_label || peer.instance_id;
      const slots = peer.max_parallel ?? "?";
      const host = peer.host || "unknown";
      const coordTag = peer.is_coordinator ? " :star:" : "";
      lines.push(`  • ${label}${coordTag} — ${host} (${slots} slots)`);
    }
  }

  if (fleetState.lastSyncAt) {
    lines.push("", `Last sync: ${fleetState.lastSyncAt}`);
  }

  return lines.join("\n");
}
