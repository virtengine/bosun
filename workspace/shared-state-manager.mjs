/**
 * @fileoverview Shared State Manager for Bosun Task Coordination
 *
 * Manages distributed task execution state across multiple agents and workstations.
 * Provides atomic operations for claiming, updating, and releasing task ownership
 * with heartbeat-based liveness detection and conflict resolution.
 *
 * Designed for eventual consistency on distributed filesystems.
 */

import { readFile, writeFile, mkdir, rename, unlink, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireScopeLocks,
  inferScopePaths,
  releaseScopeLocks,
  renewScopeLocks,
} from "./scope-locks.mjs";

/**
 * @typedef {Object} EventLogEntry
 * @property {string} timestamp - ISO 8601 timestamp
 * @property {string} event - Event type (claimed/renewed/released/abandoned/failed/conflict)
 * @property {string} ownerId - Owner identifier at time of event
 * @property {string} [details] - Optional event details
 */

/**
 * @typedef {Object} TaskSharedState
 * @property {string} taskId - Unique task identifier
 * @property {string} ownerId - Current owner (workstation ID + agent ID)
 * @property {string} ownerHeartbeat - ISO 8601 timestamp of last heartbeat
 * @property {string} attemptToken - UUID for this attempt
 * @property {string} attemptStarted - ISO 8601 timestamp when attempt began
 * @property {string} attemptStatus - claimed/working/failed/abandoned/complete
 * @property {number} retryCount - Number of previous attempts
 * @property {string} [lastError] - Error message from last failure
 * @property {string} [ignoreReason] - Reason task should be ignored by agents
 * @property {string[]} [scopePaths] - Paths currently locked for this task
 * @property {object} [scopeLockMetadata] - Metadata used when claiming scope locks
 * @property {EventLogEntry[]} eventLog - Chronological event history
 */

/**
 * @typedef {Object} SharedStateRegistry
 * @property {string} version - Schema version
 * @property {string} lastUpdated - ISO 8601 timestamp
 * @property {Object.<string, TaskSharedState>} tasks - Map of taskId to state
 */

const REGISTRY_VERSION = "1.0.0";
const EXECUTION_STATE_SCOPE_VERSION = "1.0.0";
const EXECUTION_STATE_SCOPE_NAMES = Object.freeze(["execution", "stream", "global"]);
const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_EVENT_LOG_ENTRIES = 100;
const RENAME_RETRY_DELAY_MS = 60;
const RENAME_MAX_RETRIES = 8;
const COPY_MAX_RETRIES = 3;
const WRITE_MAX_RETRIES = 3;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RETRYABLE_FS_ERRORS = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
  "ENOTEMPTY",
  "EMFILE",
  "ENFILE",
]);

function isRetryableFsError(error) {
  const code = error?.code || "";
  return RETRYABLE_FS_ERRORS.has(code);
}

async function retryFsOperation(fn, { maxRetries, delayMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableFsError(error) || attempt === maxRetries) break;
      await delay(delayMs * (attempt + 1));
    }
  }
  throw lastError;
}

async function safeUnlink(path) {
  try {
    if (existsSync(path)) await unlink(path);
  } catch {
    // best effort
  }
}

function getWriteFileOptions() {
  if (process.env.VITEST) {
    return { encoding: "utf-8" };
  }
  return { encoding: "utf-8", flush: true };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function cloneExecutionStateValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (typeof globalThis.structuredClone === "function") {
    try {
      return globalThis.structuredClone(value);
    } catch {
      // Fall through to manual clone for unsupported values.
    }
  }
  if (Array.isArray(value)) {
    return value.map((entry) => cloneExecutionStateValue(entry));
  }
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneExecutionStateValue(entry)]),
  );
}

function normalizeExecutionStateScopeName(scopeName) {
  const normalized = String(scopeName || "").trim().toLowerCase();
  return EXECUTION_STATE_SCOPE_NAMES.includes(normalized) ? normalized : "execution";
}

function normalizeExecutionStateScopeEntry(scopeName, raw = {}) {
  const normalizedScopeName = normalizeExecutionStateScopeName(scopeName);
  const source = isPlainObject(raw) ? raw : {};
  const current = source.current ?? source.state ?? {};
  const inherited = source.inherited ?? {};
  const metadata = source.metadata ?? {};
  return {
    scope: normalizedScopeName,
    visibility: source.visibility || normalizedScopeName,
    writable: source.writable !== false,
    current: isPlainObject(current) ? cloneExecutionStateValue(current) : {},
    inherited: isPlainObject(inherited) ? cloneExecutionStateValue(inherited) : {},
    metadata: isPlainObject(metadata) ? cloneExecutionStateValue(metadata) : {},
  };
}

export function createEmptyExecutionStateScopes() {
  return {
    version: EXECUTION_STATE_SCOPE_VERSION,
    execution: normalizeExecutionStateScopeEntry("execution"),
    stream: normalizeExecutionStateScopeEntry("stream"),
    global: normalizeExecutionStateScopeEntry("global"),
  };
}

export function normalizeExecutionStateScopes(raw = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const scopesSource = isPlainObject(source.scopes) ? source.scopes : source;
  const normalized = createEmptyExecutionStateScopes();
  normalized.version = String(source.version || EXECUTION_STATE_SCOPE_VERSION);
  for (const scopeName of EXECUTION_STATE_SCOPE_NAMES) {
    normalized[scopeName] = normalizeExecutionStateScopeEntry(scopeName, scopesSource[scopeName]);
  }
  return normalized;
}

export function getExecutionStateScopeEntry(scopes, scopeName) {
  const normalized = normalizeExecutionStateScopes(scopes);
  return normalized[normalizeExecutionStateScopeName(scopeName)];
}

export function getExecutionStateScopeValue(scopes, scopeName) {
  const entry = getExecutionStateScopeEntry(scopes, scopeName);
  return cloneExecutionStateValue(entry.current);
}

export function mergeExecutionStateValues(baseValue = {}, nextValue = {}) {
  const base = isPlainObject(baseValue) ? baseValue : {};
  const next = isPlainObject(nextValue) ? nextValue : {};
  const merged = cloneExecutionStateValue(base);
  for (const [key, value] of Object.entries(next)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeExecutionStateValues(merged[key], value);
    } else {
      merged[key] = cloneExecutionStateValue(value);
    }
  }
  return merged;
}

export function updateExecutionStateScope(scopes, scopeName, updater, options = {}) {
  const normalized = normalizeExecutionStateScopes(scopes);
  const entry = normalized[normalizeExecutionStateScopeName(scopeName)];
  if (!entry.writable && options.force !== true) {
    return normalized;
  }
  const current = cloneExecutionStateValue(entry.current);
  const nextValue = typeof updater === "function"
    ? updater(current, cloneExecutionStateValue(entry))
    : updater;
  entry.current = options.merge === true
    ? mergeExecutionStateValues(current, nextValue)
    : (isPlainObject(nextValue) ? cloneExecutionStateValue(nextValue) : {});
  return normalized;
}

export function createInheritedExecutionStateScopes(parentScopes, options = {}) {
  const parent = normalizeExecutionStateScopes(parentScopes);
  const inheritedScopes = createEmptyExecutionStateScopes();
  for (const scopeName of EXECUTION_STATE_SCOPE_NAMES) {
    const override = isPlainObject(options[scopeName]) ? options[scopeName] : {};
    const parentEntry = parent[scopeName];
    inheritedScopes[scopeName] = normalizeExecutionStateScopeEntry(scopeName, {
      writable: override.writable ?? parentEntry.writable,
      metadata: mergeExecutionStateValues(parentEntry.metadata, override.metadata || {}),
      inherited: override.inherited ?? cloneExecutionStateValue(parentEntry.current),
      current: override.current ?? {},
    });
  }
  return inheritedScopes;
}

/**
 * Get the path to the shared state registry file
 * @param {string} [repoRoot] - Repository root path
 * @returns {string} Registry file path
 */
function getRegistryPath(repoRoot = process.cwd()) {
  return join(repoRoot, ".cache", "bosun", "shared-task-states.json");
}

/**
 * Ensure registry directory exists
 * @param {string} registryPath - Registry file path
 * @returns {Promise<void>}
 */
async function ensureRegistryDir(registryPath) {
  const dir = dirname(registryPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Load registry from disk with corruption recovery
 * @param {string} registryPath - Registry file path
 * @returns {Promise<SharedStateRegistry>}
 */
async function loadRegistry(registryPath) {
  try {
    if (!existsSync(registryPath)) {
      return createEmptyRegistry();
    }

    const content = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(content);

    // Validate structure
    // Repair instead of wipe: preserve any valid task entries while fixing
    // missing/invalid structural fields. Wiping on minor corruption was causing
    // active claims to be lost, leading to cascading "claim was stolen" failures.
    let repaired = false;
    if (!registry.version) {
      registry.version = REGISTRY_VERSION;
      repaired = true;
    }
    if (!registry.tasks || typeof registry.tasks !== "object" || Array.isArray(registry.tasks)) {
      registry.tasks = {};
      repaired = true;
    }
    if (repaired) {
      console.warn(
        "[SharedStateManager] Invalid registry structure, repaired (preserved existing task entries)",
      );
    }

    return registry;
  } catch (error) {
    console.error(
      "[SharedStateManager] Registry corruption detected:",
      error.message,
    );

    // Attempt to backup corrupted file
    try {
      const backupPath = `${registryPath}.corrupt-${Date.now()}.bak`;
      await rename(registryPath, backupPath);
      console.log(
        `[SharedStateManager] Corrupted registry backed up to: ${backupPath}`,
      );
    } catch (backupError) {
      console.error(
        "[SharedStateManager] Failed to backup corrupted registry:",
        backupError.message,
      );
    }

    return createEmptyRegistry();
  }
}

/**
 * Create empty registry structure
 * @returns {SharedStateRegistry}
 */
function createEmptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    lastUpdated: new Date().toISOString(),
    tasks: {},
  };
}

/**
 * Save registry to disk with atomic write
 * @param {string} registryPath - Registry file path
 * @param {SharedStateRegistry} registry - Registry data
 * @returns {Promise<void>}
 */
async function saveRegistry(registryPath, registry) {
  await ensureRegistryDir(registryPath);

  registry.lastUpdated = new Date().toISOString();

  const tempPath = `${registryPath}.tmp-${randomUUID()}`;

  try {
    const payload = JSON.stringify(registry, null, 2);
    await writeFile(tempPath, payload, getWriteFileOptions());

    // Atomic rename (with retries for Windows file-lock hiccups)
    try {
      await retryFsOperation(
        () => rename(tempPath, registryPath),
        { maxRetries: RENAME_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
      );
      return;
    } catch (renameError) {
      const code = renameError?.code || "unknown";

      // Fallback: copy temp over destination (less atomic, but more reliable on Windows).
      try {
        await retryFsOperation(
          () => copyFile(tempPath, registryPath),
          { maxRetries: COPY_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
        );
        await safeUnlink(tempPath);
        console.warn(
          `[SharedStateManager] Atomic rename failed (${code}); copied registry instead.`,
        );
        return;
      } catch (copyError) {
        // Final fallback: direct write to target.
        try {
          await retryFsOperation(
            () => writeFile(registryPath, payload, getWriteFileOptions()),
            { maxRetries: WRITE_MAX_RETRIES, delayMs: RENAME_RETRY_DELAY_MS },
          );
          await safeUnlink(tempPath);
          console.warn(
            `[SharedStateManager] Atomic rename failed (${code}); wrote registry directly.`,
          );
          return;
        } catch (fallbackError) {
          throw copyError || renameError || fallbackError;
        }
      }
    }
  } catch (error) {
    // Clean up temp file on failure
    await safeUnlink(tempPath);
    throw error;
  }
}

/**
 * Add event to task's event log
 * @param {TaskSharedState} state - Task state
 * @param {string} event - Event type
 * @param {string} ownerId - Owner ID
 * @param {string} [details] - Optional details
 */
function logEvent(state, event, ownerId, details) {
  if (!state.eventLog) {
    state.eventLog = [];
  }

  state.eventLog.push({
    timestamp: new Date().toISOString(),
    event,
    ownerId,
    ...(details && { details }),
  });

  // Keep log bounded
  if (state.eventLog.length > MAX_EVENT_LOG_ENTRIES) {
    state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG_ENTRIES);
  }
}

/**
 * Check if a heartbeat is stale
 * @param {string} heartbeat - ISO timestamp
 * @param {number} staleThresholdMs - Threshold in milliseconds
 * @returns {boolean}
 */
function isHeartbeatStale(heartbeat, staleThresholdMs) {
  if (!heartbeat) {
    return true;
  }

  const heartbeatTime = Date.parse(String(heartbeat));
  if (!Number.isFinite(heartbeatTime)) {
    return true;
  }

  const thresholdMs =
    Number.isFinite(staleThresholdMs) && staleThresholdMs >= 0
      ? staleThresholdMs
      : DEFAULT_TTL_SECONDS * 1000;
  const now = Date.now();
  return now - heartbeatTime > thresholdMs;
}

function getScopeLockOptions(existingState, options = {}, repoRoot = process.cwd()) {
  const metadata =
    options?.metadata && typeof options.metadata === "object"
      ? { ...options.metadata }
      : existingState?.scopeLockMetadata && typeof existingState.scopeLockMetadata === "object"
        ? { ...existingState.scopeLockMetadata }
        : {};
  const scopePaths = inferScopePaths(
    {
      scopePaths: options?.scopePaths || existingState?.scopePaths || [],
      metadata,
    },
    repoRoot,
  );
  return { scopePaths, metadata };
}

async function transferScopeLocksForClaim({
  taskId,
  repoRoot = process.cwd(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  nextOwnerId,
  nextAttemptToken,
  nextScopePaths = [],
  nextMetadata = {},
  previousState = null,
}) {
  const previousLockOptions = previousState
    ? getScopeLockOptions(
        previousState,
        {
          metadata: previousState.scopeLockMetadata || {},
          scopePaths: previousState.scopePaths || [],
        },
        repoRoot,
      )
    : { scopePaths: [], metadata: {} };

  if (previousState?.ownerId && previousState?.attemptToken) {
    await releaseScopeLocks({
      taskId,
      ownerId: previousState.ownerId,
      attemptToken: previousState.attemptToken,
      repoRoot,
    });
  }

  const lockResult = await acquireScopeLocks({
    taskId,
    ownerId: nextOwnerId,
    attemptToken: nextAttemptToken,
    repoRoot,
    ttlSeconds,
    metadata: nextMetadata,
    scopePaths: nextScopePaths,
  });
  if (lockResult.success || !previousState?.ownerId || !previousState?.attemptToken) {
    return lockResult;
  }

  try {
    const restoreResult = await acquireScopeLocks({
      taskId,
      ownerId: previousState.ownerId,
      attemptToken: previousState.attemptToken,
      repoRoot,
      ttlSeconds: previousState.ttlSeconds || ttlSeconds,
      metadata: previousLockOptions.metadata,
      scopePaths: previousLockOptions.scopePaths,
    });
    if (!restoreResult.success) {
      console.warn(
        `[SharedStateManager] Failed to restore previous scope locks for ${taskId}: ${restoreResult.reason || "unknown"}`,
      );
    }
  } catch (restoreError) {
    console.warn(
      `[SharedStateManager] Failed to restore previous scope locks for ${taskId}: ${restoreError?.message || restoreError}`,
    );
  }

  return lockResult;
}

/**
 * Resolve conflict between two claims
 * @param {TaskSharedState} existing - Existing state
 * @param {string} newOwnerId - New claimant
 * @param {number} staleThresholdMs - Heartbeat staleness threshold
 * @returns {{winner: string, reason: string}} - Resolution decision
 */
function resolveConflict(existing, newOwnerId, staleThresholdMs) {
  const existingStale = isHeartbeatStale(
    existing.ownerHeartbeat,
    staleThresholdMs,
  );

  if (existingStale) {
    return {
      winner: newOwnerId,
      reason: "existing_owner_stale",
    };
  }

  // Both active - prefer existing owner (first-come-first-served)
  return {
    winner: existing.ownerId,
    reason: "existing_owner_active",
  };
}

/**
 * Claim a task in shared state with heartbeat-based leasing
 *
 * @param {string} taskId - Task identifier
 * @param {string} ownerId - Owner identifier (workstationId + agentId)
 * @param {string} attemptToken - Unique attempt token
 * @param {number} [ttlSeconds=300] - Heartbeat TTL in seconds
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string, state?: TaskSharedState}>}
 */
export async function claimTaskInSharedState(
  taskId,
  ownerId,
  attemptToken,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  repoRoot = process.cwd(),
  options = {},
) {
  const registryPath = getRegistryPath(repoRoot);
  const staleThresholdMs = ttlSeconds * 1000;

  try {
    const registry = await loadRegistry(registryPath);
    const existing = registry.tasks[taskId];
    const now = new Date().toISOString();
    const { scopePaths, metadata } = getScopeLockOptions(existing, options, repoRoot);

    // Task has ignore flag - cannot claim
    if (existing?.ignoreReason) {
      return {
        success: false,
        reason: `task_ignored: ${existing.ignoreReason}`,
      };
    }

    // No existing claim or terminal status - claim it
    if (
      !existing ||
      existing.attemptStatus === "complete" ||
      existing.attemptStatus === "failed" ||
      existing.attemptStatus === "abandoned" ||
      existing.attemptStatus === "ignored"
    ) {
      const lockResult = await acquireScopeLocks({
        taskId,
        ownerId,
        attemptToken,
        repoRoot,
        ttlSeconds,
        metadata,
        scopePaths,
      });
      if (!lockResult.success) {
        return {
          success: false,
          reason: lockResult.reason || "scope_lock_conflict",
          scopeLockConflict: lockResult.conflict || null,
          scopeLockConflicts: lockResult.conflicts || [],
        };
      }

      const newState = {
        taskId,
        ownerId,
        ownerHeartbeat: now,
        attemptToken,
        attemptStarted: now,
        attemptStatus: "claimed",
        retryCount: existing ? existing.retryCount + 1 : 0,
        ttlSeconds,
        scopePaths: lockResult.scopePaths,
        scopeLockMetadata: metadata,
        eventLog: existing?.eventLog || [],
      };

      if (existing?.lastError) {
        newState.lastError = existing.lastError;
      }

      logEvent(newState, "claimed", ownerId);
      registry.tasks[taskId] = newState;
      await saveRegistry(registryPath, registry);

      return { success: true, state: newState };
    }

    // Existing claim - check for conflict
    if (existing.ownerId !== ownerId) {
      const existingStaleMs = (existing.ttlSeconds || ttlSeconds) * 1000;
      const resolution = resolveConflict(existing, ownerId, existingStaleMs);

      if (resolution.winner === ownerId) {
        const lockResult = await transferScopeLocksForClaim({
          taskId,
          repoRoot,
          ttlSeconds,
          nextOwnerId: ownerId,
          nextAttemptToken: attemptToken,
          nextScopePaths: scopePaths,
          nextMetadata: metadata,
          previousState: existing,
        });
        if (!lockResult.success) {
          return {
            success: false,
            reason: lockResult.reason || "scope_lock_conflict",
            scopeLockConflict: lockResult.conflict || null,
            scopeLockConflicts: lockResult.conflicts || [],
          };
        }

        // Take over stale claim
        const newState = {
          ...existing,
          ownerId,
          ownerHeartbeat: now,
          attemptToken,
          attemptStarted: now,
          attemptStatus: "claimed",
          retryCount: existing.retryCount + 1,
          ttlSeconds,
          scopePaths: lockResult.scopePaths,
          scopeLockMetadata: metadata,
        };

        logEvent(
          newState,
          "conflict",
          ownerId,
          `takeover: ${resolution.reason}`,
        );
        registry.tasks[taskId] = newState;
        await saveRegistry(registryPath, registry);

        return { success: true, state: newState };
      } else {
        // Existing owner wins
        logEvent(
          existing,
          "conflict",
          ownerId,
          `rejected: ${resolution.reason}`,
        );
        registry.tasks[taskId] = existing;
        await saveRegistry(registryPath, registry);

        return {
          success: false,
          reason: `conflict: ${resolution.reason}`,
          state: existing,
        };
      }
    }

    // Same owner reclaiming - update heartbeat
    const lockResult = await acquireScopeLocks({
      taskId,
      ownerId,
      attemptToken,
      repoRoot,
      ttlSeconds,
      scopePaths,
      metadata,
    });
    if (!lockResult.success) {
      return {
        success: false,
        reason: lockResult.reason || "scope_lock_owner_mismatch",
        scopeLockConflict: lockResult.mismatch || null,
        scopeLockConflicts: lockResult.mismatches || [],
      };
    }

    existing.ownerHeartbeat = now;
    existing.attemptToken = attemptToken;
    existing.ttlSeconds = ttlSeconds;
    existing.scopePaths = lockResult.scopePaths;
    existing.scopeLockMetadata = metadata;
    logEvent(existing, "reclaimed", ownerId);
    registry.tasks[taskId] = existing;
    await saveRegistry(registryPath, registry);

    return { success: true, state: existing };
  } catch (error) {
    console.error("[SharedStateManager] Failed to claim task:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Force-claim a task in shared state, bypassing conflict resolution.
 *
 * Used when local stale detection has confirmed the previous owner is dead
 * but the shared state heartbeat is still fresh (e.g., after a release that
 * refreshed the heartbeat). This ensures the shared state reflects the actual
 * current owner so heartbeat renewals succeed.
 *
 * @param {string} taskId - Task identifier
 * @param {string} ownerId - New owner identifier
 * @param {string} attemptToken - New attempt token
 * @param {number} [ttlSeconds] - TTL for stale detection
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, state?: TaskSharedState, reason?: string}>}
 */
export async function forceClaimTaskInSharedState(
  taskId,
  ownerId,
  attemptToken,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  repoRoot = process.cwd(),
  options = {},
) {
  const registryPath = getRegistryPath(repoRoot);
  try {
    const registry = await loadRegistry(registryPath);
    const existing = registry.tasks[taskId];
    const now = new Date().toISOString();
    const { scopePaths, metadata } = getScopeLockOptions(existing, options, repoRoot);

    const lockResult = await transferScopeLocksForClaim({
      taskId,
      repoRoot,
      ttlSeconds,
      nextOwnerId: ownerId,
      nextAttemptToken: attemptToken,
      nextScopePaths: scopePaths,
      nextMetadata: metadata,
      previousState: existing,
    });
    if (!lockResult.success) {
      return {
        success: false,
        reason: lockResult.reason || "scope_lock_conflict",
        scopeLockConflict: lockResult.conflict || null,
        scopeLockConflicts: lockResult.conflicts || [],
      };
    }

    const newState = {
      taskId,
      ownerId,
      ownerHeartbeat: now,
      attemptToken,
      attemptStarted: now,
      attemptStatus: "claimed",
      retryCount: existing ? (existing.retryCount || 0) + 1 : 0,
      ttlSeconds,
      scopePaths: lockResult.scopePaths,
      scopeLockMetadata: metadata,
      eventLog: existing?.eventLog || [],
    };
    if (existing?.lastError) newState.lastError = existing.lastError;

    logEvent(
      newState,
      "conflict",
      ownerId,
      `force_takeover: local_stale_override (prev: ${existing?.ownerId || "none"})`,
    );
    registry.tasks[taskId] = newState;
    await saveRegistry(registryPath, registry);
    return { success: true, state: newState };
  } catch (error) {
    console.error("[SharedStateManager] Failed to force-claim task:", error);
    return { success: false, reason: `error: ${error.message}` };
  }
}

/**
 * Renew heartbeat for an active task claim
 *
 * @param {string} taskId - Task identifier
 * @param {string} ownerId - Owner identifier
 * @param {string} attemptToken - Attempt token for verification
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function renewSharedStateHeartbeat(
  taskId,
  ownerId,
  attemptToken,
  repoRoot = process.cwd(),
  options = {},
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (state.ownerId !== ownerId) {
      return {
        success: false,
        reason: "owner_mismatch",
      };
    }

    if (state.attemptToken !== attemptToken) {
      return {
        success: false,
        reason: "attempt_token_mismatch",
      };
    }

    if (
      state.attemptStatus === "complete" ||
      state.attemptStatus === "failed"
    ) {
      return {
        success: false,
        reason: `task_already_${state.attemptStatus}`,
      };
    }

    const lockResult = await renewScopeLocks({
      taskId,
      ownerId,
      attemptToken,
      repoRoot,
      ttlSeconds: state.ttlSeconds || DEFAULT_TTL_SECONDS,
      scopePaths: state.scopePaths || [],
      metadata:
        options?.metadata && typeof options.metadata === "object"
          ? options.metadata
          : state.scopeLockMetadata || {},
    });
    if (!lockResult.success) {
      return {
        success: false,
        reason: "scope_lock_owner_mismatch",
      };
    }

    state.ownerHeartbeat = new Date().toISOString();
    state.attemptStatus = "working";
    state.scopePaths = lockResult.scopePaths;
    logEvent(state, "renewed", ownerId);

    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to renew heartbeat:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Release task claim by marking it complete, failed, or abandoned
 *
 * @param {string} taskId - Task identifier
 * @param {string} attemptToken - Attempt token for verification
 * @param {'complete'|'failed'|'abandoned'} status - Final status
 * @param {string} [errorMessage] - Error message if failed
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function releaseSharedState(
  taskId,
  attemptToken,
  status,
  errorMessage,
  repoRoot = process.cwd(),
  { ownerId } = {},
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (state.attemptToken !== attemptToken) {
      // Fallback: allow release by ownerId when token doesn't match
      // (token can diverge after claim-stolen rollbacks or takeovers)
      if (!ownerId || state.ownerId !== ownerId) {
        return {
          success: false,
          reason: "attempt_token_mismatch",
        };
      }
    }

    state.attemptStatus = status;
    // Clear heartbeat so the entry is immediately stale for resolveConflict.
    // A released task should never block the next claim attempt.
    state.ownerHeartbeat = null;

    if (errorMessage) {
      state.lastError = errorMessage;
    }

    const releaseAttemptToken =
      String(state.attemptToken || "") === String(attemptToken || "")
        ? attemptToken
        : null;
    await releaseScopeLocks({
      taskId,
      ownerId: ownerId || state.ownerId,
      attemptToken: releaseAttemptToken,
      repoRoot,
    });

    logEvent(state, "released", state.ownerId, `status: ${status}`);

    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to release state:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Get current shared state for a task
 *
 * @param {string} taskId - Task identifier
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<TaskSharedState|null>}
 */
export async function getSharedState(taskId, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    return registry.tasks[taskId] || null;
  } catch (error) {
    console.error("[SharedStateManager] Failed to get shared state:", error);
    return null;
  }
}

/**
 * Get all shared states (for monitoring/debugging)
 *
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<Object.<string, TaskSharedState>>}
 */
export async function getAllSharedStates(repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    return registry.tasks || {};
  } catch (error) {
    console.error(
      "[SharedStateManager] Failed to get all shared states:",
      error,
    );
    return {};
  }
}

/**
 * Sweep through tasks and mark stale owners as abandoned
 *
 * @param {number} staleThresholdMs - Heartbeat staleness threshold in milliseconds
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{sweptCount: number, abandonedTasks: string[]}>}
 */
export async function sweepStaleSharedStates(
  staleThresholdMs,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const abandonedTasks = [];
    let sweptCount = 0;

    for (const [taskId, state] of Object.entries(registry.tasks)) {
      // Skip already completed/failed tasks
      if (
        state.attemptStatus === "complete" ||
        state.attemptStatus === "failed"
      ) {
        continue;
      }

      // Skip tasks with ignore flag
      if (state.ignoreReason) {
        continue;
      }

      if (isHeartbeatStale(state.ownerHeartbeat, staleThresholdMs)) {
        state.attemptStatus = "abandoned";
        state.lastError = `Heartbeat stale (last: ${state.ownerHeartbeat})`;
        await releaseScopeLocks({
          taskId,
          ownerId: state.ownerId,
          attemptToken: state.attemptToken,
          repoRoot,
        });
        logEvent(state, "abandoned", "system", "stale_heartbeat");

        abandonedTasks.push(taskId);
        sweptCount++;
      }
    }

    if (sweptCount > 0) {
      await saveRegistry(registryPath, registry);
    }

    return { sweptCount, abandonedTasks };
  } catch (error) {
    console.error("[SharedStateManager] Failed to sweep stale states:", error);
    return { sweptCount: 0, abandonedTasks: [] };
  }
}

/**
 * Check if a task should be retried or permanently ignored
 *
 * @param {string} taskId - Task identifier
 * @param {number} maxRetries - Maximum retry attempts
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{shouldRetry: boolean, reason: string}>}
 */
export async function shouldRetryTask(
  taskId,
  maxRetries,
  repoRoot = process.cwd(),
) {
  try {
    const state = await getSharedState(taskId, repoRoot);

    if (!state) {
      return { shouldRetry: true, reason: "no_previous_attempts" };
    }

    if (state.ignoreReason) {
      return { shouldRetry: false, reason: `ignored: ${state.ignoreReason}` };
    }

    if (state.attemptStatus === "complete") {
      return { shouldRetry: false, reason: "already_complete" };
    }

    if (state.retryCount >= maxRetries) {
      return {
        shouldRetry: false,
        reason: `max_retries_exceeded: ${state.retryCount}/${maxRetries}`,
      };
    }

    // Check if currently claimed by active owner
    if (
      state.attemptStatus === "claimed" ||
      state.attemptStatus === "working"
    ) {
      const staleThresholdMs = (state.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
      if (!isHeartbeatStale(state.ownerHeartbeat, staleThresholdMs)) {
        return {
          shouldRetry: false,
          reason: "currently_owned_by_active_agent",
        };
      }
    }

    return { shouldRetry: true, reason: "eligible_for_retry" };
  } catch (error) {
    console.error(
      "[SharedStateManager] Failed to check retry eligibility:",
      error,
    );
    return { shouldRetry: true, reason: "error_checking_state" };
  }
}

/**
 * Mark a task as permanently ignored by agents
 *
 * @param {string} taskId - Task identifier
 * @param {string} reason - Reason for ignoring (e.g., "human_created", "invalid_spec")
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function setIgnoreFlag(taskId, reason, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    let state = registry.tasks[taskId];

    if (!state) {
      // Create new state entry for ignored task
      state = {
        taskId,
        ownerId: "system",
        ownerHeartbeat: new Date().toISOString(),
        attemptToken: "N/A",
        attemptStarted: new Date().toISOString(),
        attemptStatus: "ignored",
        retryCount: 0,
        ignoreReason: reason,
        eventLog: [],
      };
    } else {
      state.ignoreReason = reason;
    }

    logEvent(state, "ignored", "system", reason);
    registry.tasks[taskId] = state;
    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to set ignore flag:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Clear ignore flag from a task
 *
 * @param {string} taskId - Task identifier
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{success: boolean, reason?: string}>}
 */
export async function clearIgnoreFlag(taskId, repoRoot = process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);

  try {
    const registry = await loadRegistry(registryPath);
    const state = registry.tasks[taskId];

    if (!state) {
      return {
        success: false,
        reason: "task_not_found",
      };
    }

    if (!state.ignoreReason) {
      return {
        success: false,
        reason: "not_ignored",
      };
    }

    delete state.ignoreReason;
    logEvent(state, "unignored", "system");
    await saveRegistry(registryPath, registry);

    return { success: true };
  } catch (error) {
    console.error("[SharedStateManager] Failed to clear ignore flag:", error);
    return {
      success: false,
      reason: `error: ${error.message}`,
    };
  }
}

/**
 * Clean up old completed/failed task states
 *
 * @param {number} retentionDays - Days to retain completed tasks
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<{cleanedCount: number, cleanedTasks: string[]}>}
 */
export async function cleanupOldStates(
  retentionDays,
  repoRoot = process.cwd(),
) {
  const registryPath = getRegistryPath(repoRoot);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - retentionMs;

  try {
    const registry = await loadRegistry(registryPath);
    const cleanedTasks = [];
    let cleanedCount = 0;

    for (const [taskId, state] of Object.entries(registry.tasks)) {
      // Only clean up completed/failed tasks
      if (
        state.attemptStatus !== "complete" &&
        state.attemptStatus !== "failed"
      ) {
        continue;
      }

      // Check if old enough (use attemptStarted as fallback when heartbeat was cleared on release)
      const lastUpdate = new Date(state.ownerHeartbeat || state.attemptStarted || 0).getTime();
      if (lastUpdate < cutoffTime) {
        delete registry.tasks[taskId];
        cleanedTasks.push(taskId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      await saveRegistry(registryPath, registry);
      console.log(
        `[SharedStateManager] Cleaned up ${cleanedCount} old task states`,
      );
    }

    return { cleanedCount, cleanedTasks };
  } catch (error) {
    console.error("[SharedStateManager] Failed to cleanup old states:", error);
    return { cleanedCount: 0, cleanedTasks: [] };
  }
}

/**
 * Get statistics about current shared state
 *
 * @param {string} [repoRoot] - Repository root path
 * @returns {Promise<Object>}
 */
export async function getStateStatistics(repoRoot = process.cwd()) {
  try {
    const registry = await loadRegistry(getRegistryPath(repoRoot));
    const stats = {
      total: 0,
      claimed: 0,
      working: 0,
      complete: 0,
      failed: 0,
      abandoned: 0,
      ignored: 0,
      stale: 0,
      byOwner: {},
    };

    for (const state of Object.values(registry.tasks)) {
      stats.total++;

      if (state.ignoreReason) {
        stats.ignored++;
      } else {
        stats[state.attemptStatus] = (stats[state.attemptStatus] || 0) + 1;

        if (!stats.byOwner[state.ownerId]) {
          stats.byOwner[state.ownerId] = 0;
        }
        stats.byOwner[state.ownerId]++;
      }

      if (
        state.attemptStatus !== "complete" &&
        state.attemptStatus !== "failed" &&
        state.attemptStatus !== "ignored"
      ) {
        const staleMs = (state.ttlSeconds || DEFAULT_TTL_SECONDS) * 1000;
        if (isHeartbeatStale(state.ownerHeartbeat, staleMs)) {
          stats.stale++;
        }
      }
    }

    return stats;
  } catch (error) {
    console.error("[SharedStateManager] Failed to get statistics:", error);
    return {
      total: 0,
      claimed: 0,
      working: 0,
      complete: 0,
      failed: 0,
      abandoned: 0,
      ignored: 0,
      stale: 0,
      byOwner: {},
    };
  }
}

// Export constants for external use
export {
  REGISTRY_VERSION,
  EXECUTION_STATE_SCOPE_VERSION,
  EXECUTION_STATE_SCOPE_NAMES,
  DEFAULT_TTL_SECONDS,
  MAX_EVENT_LOG_ENTRIES,
};
