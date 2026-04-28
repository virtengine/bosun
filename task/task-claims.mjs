/**
 * task-claims.mjs — Distributed task claiming with idempotency and conflict resolution.
 *
 * Provides:
 *   - Idempotent task claiming across multiple workstations
 *   - Deterministic duplicate claim resolution
 *   - Persistent claim tokens
 *   - Integration with presence.mjs for fleet coordination
 *   - Telegram channel announcement support
 *
 * Architecture:
 *   - Claims are stored in .cache/bosun/task-claims.json
 *   - Each claim has a unique token (UUID) for idempotency
 *   - Claims include instance_id, timestamp, and TTL
 *   - Duplicate claims are resolved by instance priority (from presence.mjs)
 *   - Stale claims are auto-swept based on TTL
 *
 * Usage:
 *   import { claimTask, releaseTask, listClaims } from './task-claims.mjs';
 *
 *   const claim = await claimTask({
 *     taskId: 'abc123',
 *     instanceId: 'workstation-1',
 *     ttlMinutes: 60,
 *   });
 *
 *   if (claim.success) {
 *     // Work on task
 *     await releaseTask({ taskId: 'abc123', claimToken: claim.token });
 *   }
 */

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import {
  appendTaskClaimAuditToStateLedger,
  syncTaskClaimsRegistryToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import {
  getPresenceState,
  initPresence,
  notePresence,
  buildLocalPresence,
  listActiveInstances,
  selectCoordinator,
} from "../infra/presence.mjs";
import {
  claimTaskInSharedState,
  forceClaimTaskInSharedState,
  renewSharedStateHeartbeat,
  releaseSharedState,
} from "../workspace/shared-state-manager.mjs";
import { inferScopePaths } from "../workspace/scope-locks.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const CLAIMS_FILENAME = "task-claims.json";
const AUDIT_FILENAME = "task-claims-audit.jsonl";
const DEFAULT_TTL_MINUTES = 60;
const CACHE_DIR = ".cache/bosun";
const DEFAULT_OWNER_STALE_TTL_MS = 10 * 60 * 1000;
const FS_RETRY_DELAY_MS = 40;
const FS_RETRY_MAX = 4;
const CLAIMS_REPLACE_RETRY_DELAY_MS = 100;
const CLAIMS_REPLACE_RETRY_MAX = 20;
const CLAIMS_LOCK_FILENAME = "task-claims.lock";
const CLAIMS_LOCK_RETRY_DELAY_MS = 25;
const CLAIMS_LOCK_TIMEOUT_MS = 15_000;

// Shared state configuration from environment
const SHARED_STATE_ENABLED = process.env.SHARED_STATE_ENABLED !== "false"; // default true
const SHARED_STATE_HEARTBEAT_INTERVAL_MS = Number(process.env.SHARED_STATE_HEARTBEAT_INTERVAL_MS) || 60_000;
const SHARED_STATE_STALE_THRESHOLD_MS = Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000;
const SHARED_STATE_MAX_RETRIES = Number(process.env.SHARED_STATE_MAX_RETRIES) || 3;
const SHARED_STATE_FATAL_CLAIM_REASONS = new Set([
  "existing_owner_active",
  "owner_mismatch",
  "attempt_token_mismatch",
  "task_ignored",
  "scope_lock_conflict",
  "scope_lock_owner_mismatch",
]);

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  initialized: false,
  repoRoot: null,
  claimsPath: null,
  auditPath: null,
  lockPath: null,
};

function normalizeRepoRoot(repoRoot) {
  const candidate = String(repoRoot || "").trim();
  return candidate ? resolve(candidate) : "";
}

async function ensureRepoContext(repoRoot) {
  const normalizedRepoRoot = normalizeRepoRoot(repoRoot);
  if (!normalizedRepoRoot) return;
  if (!state.initialized || normalizeRepoRoot(state.repoRoot) !== normalizedRepoRoot) {
    await initTaskClaims({ repoRoot: normalizedRepoRoot });
  }
}

// ── In-process mutex ─────────────────────────────────────────────────────────
// Serializes all load→modify→save cycles on the claims registry to prevent
// concurrent async operations from clobbering each other's writes.
let _registryLockChain = Promise.resolve();

function parseRegistryLock(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      pid: Number(parsed.pid),
      lockToken: String(parsed.lockToken || "").trim(),
      startedAt: String(parsed.startedAt || "").trim() || null,
      argv: Array.isArray(parsed.argv) ? parsed.argv.map((entry) => String(entry || "")) : [],
    };
  } catch {
    return null;
  }
}

async function readRegistryLock() {
  if (!state.lockPath || !existsSync(state.lockPath)) {
    return null;
  }
  try {
    const raw = await readFile(state.lockPath, "utf8");
    return parseRegistryLock(raw);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function releaseRegistryFileLock(lockToken) {
  if (!state.lockPath) {
    return;
  }
  let current = null;
  try {
    current = await readRegistryLock();
  } catch {
    current = null;
  }
  if (current?.lockToken !== lockToken) {
    return;
  }
  try {
    await unlink(state.lockPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

async function acquireRegistryFileLock() {
  ensureInitialized();
  const lockToken = crypto.randomUUID();
  const deadline = Date.now() + CLAIMS_LOCK_TIMEOUT_MS;
  const payload = JSON.stringify(
    {
      pid: process.pid,
      lockToken,
      startedAt: new Date().toISOString(),
      argv: [...process.argv],
    },
    null,
    2,
  );

  while (Date.now() <= deadline) {
    try {
      await writeFile(state.lockPath, payload, {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        async release() {
          await releaseRegistryFileLock(lockToken);
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") {
        throw err;
      }
      const existing = await readRegistryLock();
      if (!isProcessAlive(existing?.pid)) {
        try {
          await unlink(state.lockPath);
        } catch (unlinkErr) {
          if (unlinkErr?.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
        continue;
      }
      await sleep(CLAIMS_LOCK_RETRY_DELAY_MS);
    }
  }

  const existing = await readRegistryLock();
  throw new Error(
    `[task-claims] Timed out waiting for claims lock ${state.lockPath} (owner PID ${existing?.pid || "unknown"}).`,
  );
}

/**
 * Execute `fn` while holding an exclusive in-process lock on the claims
 * registry.  All callers that do load→modify→save MUST use this to prevent
 * the read-modify-write race where a concurrent save reverts another
 * caller's changes.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withRegistryLock(fn) {
  const runWithLock = async () => {
    const fileLock = await acquireRegistryFileLock();
    try {
      return await fn();
    } finally {
      await fileLock.release();
    }
  };
  const next = _registryLockChain.then(runWithLock, runWithLock);
  // Swallow rejections in the chain itself so a failure in one call
  // doesn't permanently poison all subsequent callers.
  _registryLockChain = next.catch(() => {});
  return next;
}
function normalizeSharedClaimConflictReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (normalized.startsWith("conflict:")) {
    return normalized.slice("conflict:".length).trim();
  }
  return normalized;
}

function isFatalSharedClaimConflict(reason, { treatWrappedAsFatal = true } = {}) {
  const raw = String(reason || "").trim().toLowerCase();
  if (!raw) return false;
  // For a first-claim or conflict-resolution context, unwrap "conflict:" prefix and check.
  // For a stale-override context, conflict:-prefixed reasons are non-fatal (local stale detection wins).
  const normalized = treatWrappedAsFatal ? normalizeSharedClaimConflictReason(raw) : raw;
  if (SHARED_STATE_FATAL_CLAIM_REASONS.has(normalized)) return true;
  if (normalized.startsWith("task_ignored")) return true;
  return false;
}

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the task claims system.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] - Repository root path
 * @returns {Promise<void>}
 */
export async function initTaskClaims(opts = {}) {
  state.repoRoot = opts.repoRoot || process.cwd();
  const cacheDir = resolve(state.repoRoot, CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });
  state.claimsPath = resolve(cacheDir, CLAIMS_FILENAME);
  state.auditPath = resolve(cacheDir, AUDIT_FILENAME);
  state.lockPath = resolve(cacheDir, CLAIMS_LOCK_FILENAME);
  state.initialized = true;

  // Ensure presence is initialized and register ourselves so that
  // shouldTreatClaimAsStale() can see this instance as "alive".
  // Without this, the presence registry may be empty, causing the
  // stale-check to fall through to PID-based detection which breaks
  // across process restarts with the same instance ID.
  try {
    await initPresence({ repoRoot: state.repoRoot });
    const selfPresence = buildLocalPresence();
    if (selfPresence?.instance_id) {
      await notePresence(selfPresence, { source: "task-claims-init" });
    }
  } catch (err) {
    console.warn(`[task-claims] presence init warning: ${err?.message || err}`);
  }
}

function ensureInitialized() {
  if (!state.initialized) {
    throw new Error("task-claims not initialized. Call initTaskClaims() first.");
  }
}

// ── Claim Registry I/O ───────────────────────────────────────────────────────

/**
 * Load the claims registry from disk.
 *
 * @returns {Promise<object>} Registry object with claims map
 */
async function loadClaimsRegistry() {
  ensureInitialized();
  if (!existsSync(state.claimsPath)) {
    return { version: 1, claims: {}, updated_at: new Date().toISOString() };
  }
  try {
    const raw = await readFile(state.claimsPath, "utf8");
    const parsed = parseRegistryPayload(raw);
    const data = parsed.data;
    const registry = {
      version: data.version || 1,
      claims: data.claims || {},
      updated_at: data.updated_at || new Date().toISOString(),
    };
    if (parsed.recovered) {
      const detail = parsed.details.length ? parsed.details.join(", ") : "partial";
      console.warn(`[task-claims] Recovered registry (${detail}); rewriting clean copy.`);
      try {
        await saveClaimsRegistry(registry);
      } catch (rewriteErr) {
        console.warn(
          `[task-claims] Failed to rewrite recovered registry: ${rewriteErr.message}`,
        );
      }
    }
    return registry;
  } catch (err) {
    console.warn(`[task-claims] Failed to load registry: ${err.message}`);
    try {
      const suffix = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");
      const corruptPath = `${state.claimsPath}.corrupt-${suffix}`;
      await rename(state.claimsPath, corruptPath);
      console.warn(
        `[task-claims] Corrupt registry moved to ${corruptPath}`,
      );
    } catch {
      /* best effort */
    }
    return { version: 1, claims: {}, updated_at: new Date().toISOString() };
  }
}

function parseRegistryPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("registry file empty");
  }
  try {
    return { data: JSON.parse(trimmed), recovered: false, details: [] };
  } catch (err) {
    const extraction = extractJsonObject(raw);
    if (!extraction) throw err;
    const { jsonText, leadingJunk, trailingJunk } = extraction;
    const data = JSON.parse(jsonText);
    const details = [];
    if (leadingJunk) details.push("leading junk trimmed");
    if (trailingJunk) details.push("trailing junk trimmed");
    return { data, recovered: true, details };
  }
}

function extractJsonObject(raw) {
  const firstNonWhitespace = raw.search(/\S/);
  if (firstNonWhitespace === -1) return null;
  const startIndex = raw.indexOf("{", firstNonWhitespace);
  if (startIndex === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const jsonText = raw.slice(startIndex, i + 1);
        const trailing = raw.slice(i + 1);
        return {
          jsonText,
          leadingJunk: startIndex > firstNonWhitespace,
          trailingJunk: trailing.trim().length > 0,
        };
      }
    }
  }
  return null;
}

/**
 * Save the claims registry to disk.
 *
 * @param {object} registry - Claims registry object
 * @returns {Promise<void>}
 */
async function saveClaimsRegistry(registry) {
  ensureInitialized();
  registry.updated_at = new Date().toISOString();
  const payload = JSON.stringify(registry, null, 2);
  let persisted = false;
  // Include a UUID to prevent tmp-path collisions when multiple save calls
  // happen in the same millisecond within the same process.
  const tmpPath = `${state.claimsPath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  await writeFile(tmpPath, payload, { encoding: "utf8", flush: true });
  try {
    await retryFsOperation(
      () => rename(tmpPath, state.claimsPath),
      { maxRetries: CLAIMS_REPLACE_RETRY_MAX, delayMs: CLAIMS_REPLACE_RETRY_DELAY_MS },
    );
    persisted = true;
  } catch (err) {
    const reason = err?.message || err;
    try {
      await unlink(tmpPath);
    } catch {
      /* best effort */
    }
    throw new Error(
      `[task-claims] Failed to replace claims registry atomically (${reason}). Refusing non-atomic overwrite to avoid corrupting ${state.claimsPath}.`,
    );
  }

  if (!persisted) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best effort */
    }
    return;
  }

  try {
    await unlink(tmpPath);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.warn(
        `[task-claims] Temporary registry cleanup warning: ${err?.message || err}`,
      );
    }
  }
  try {
    syncTaskClaimsRegistryToStateLedger(registry, { repoRoot: state.repoRoot });
  } catch (err) {
    console.warn(`[task-claims] State ledger sync failed: ${err?.message || err}`);
  }
}

// ── Audit Log ────────────────────────────────────────────────────────────────

/**
 * Append an audit entry to the claims audit log.
 *
 * @param {object} entry - Audit entry
 * @returns {Promise<void>}
 */
async function appendAuditEntry(entry) {
  ensureInitialized();
  const auditEntry = {
    ...entry,
    timestamp: entry.timestamp || new Date().toISOString(),
  };
  const line = JSON.stringify(auditEntry);
  try {
    await writeFile(state.auditPath, line + "\n", { flag: "a" });
  } catch (err) {
    console.warn(`[task-claims] Failed to write audit entry: ${err.message}`);
  }
  try {
    appendTaskClaimAuditToStateLedger(auditEntry, { repoRoot: state.repoRoot });
  } catch (err) {
    console.warn(`[task-claims] State ledger audit sync failed: ${err?.message || err}`);
  }
}

// ── Claim Token Generation ───────────────────────────────────────────────────

/**
 * Generate a unique claim token.
 *
 * @returns {string} UUID-based claim token
 */
function generateClaimToken() {
  return crypto.randomUUID();
}

function parseDuration(value, fallbackMs) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isRetriableFsError(err) {
  const code = err?.code;
  return (
    code === "EPERM" ||
    code === "EBUSY" ||
    code === "EACCES" ||
    code === "ENOTEMPTY" ||
    code === "EEXIST"
  );
}

async function retryFsOperation(fn, { maxRetries = FS_RETRY_MAX, delayMs = FS_RETRY_DELAY_MS } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableFsError(err) || attempt === maxRetries - 1) {
        throw err;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(Math.floor(n), 0);
    return true;
  } catch {
    return false;
  }
}

async function noteClaimOwnerPresence(instanceId, metadata = {}, source = "task-claim") {
  const normalizedInstanceId = String(instanceId || "").trim();
  if (!normalizedInstanceId) return;
  const pid = Number(metadata?.pid);
  try {
    const presence = {
      ...(buildLocalPresence() || {}),
      instance_id: normalizedInstanceId,
      host: metadata?.host || os.hostname(),
      pid: Number.isFinite(pid) && pid > 0 ? pid : process.pid,
    };
    if (presence?.instance_id) {
      await notePresence(presence, { source });
    }
  } catch (err) {
    console.warn(`[task-claims] presence note warning for ${normalizedInstanceId}: ${err?.message || err}`);
  }
}

function shouldTreatClaimAsStale(claim, ownerStaleTtlMs) {
  if (!claim || !claim.instance_id) {
    return { stale: false, reason: null };
  }

  const claimHost = String(claim?.metadata?.host || "").trim();
  const claimPid = Number(claim?.metadata?.pid);
  const localHost = os.hostname();
  const sameHost =
    claimHost &&
    localHost &&
    claimHost.toLowerCase() === String(localHost).toLowerCase();
  if (
    sameHost &&
    Number.isFinite(claimPid) &&
    claimPid > 0
  ) {
    if (isProcessAlive(claimPid)) {
      return { stale: false, reason: null };
    }
    return { stale: true, reason: "owner_stale" };
  }

  const activeInstances = listActiveInstances({ ttlMs: ownerStaleTtlMs });
  if (Array.isArray(activeInstances) && activeInstances.length > 0) {
    const ownerActive = activeInstances.some(
      (entry) => String(entry?.instance_id || "") === String(claim.instance_id),
    );
    if (!ownerActive) {
      return { stale: true, reason: "owner_stale" };
    }
  }

  if (
    sameHost &&
    Number.isFinite(claimPid) &&
    claimPid > 0 &&
    !isProcessAlive(claimPid)
  ) {
    return { stale: true, reason: "owner_stale" };
  }

  return { stale: false, reason: null };
}

// ── Claim Expiry ─────────────────────────────────────────────────────────────

/**
 * Check if a claim is expired.
 *
 * @param {object} claim - Claim object
 * @param {Date} [now] - Current time (for testing)
 * @returns {boolean} True if expired
 */
function isClaimExpired(claim, now = new Date()) {
  if (!claim || !claim.expires_at) return true;
  const expiresAt = new Date(claim.expires_at);
  return now >= expiresAt;
}

/**
 * Sweep expired claims from the registry.
 *
 * @param {object} registry - Claims registry
 * @param {Date} [now] - Current time (for testing)
 * @returns {object} { registry, expiredCount }
 */
function sweepExpiredClaims(registry, now = new Date()) {
  let expiredCount = 0;
  for (const [taskId, claim] of Object.entries(registry.claims)) {
    if (isClaimExpired(claim, now)) {
      delete registry.claims[taskId];
      expiredCount++;
    }
  }
  return { registry, expiredCount };
}

function sweepInactiveClaims(
  registry,
  {
    now = new Date(),
    includeExpired = false,
    ownerStaleTtlMs = DEFAULT_OWNER_STALE_TTL_MS,
  } = {},
) {
  let expiredCount = 0;
  let staleCount = 0;

  for (const [taskId, claim] of Object.entries(registry.claims || {})) {
    if (!includeExpired && isClaimExpired(claim, now)) {
      delete registry.claims[taskId];
      expiredCount += 1;
      continue;
    }

    const staleCheck = shouldTreatClaimAsStale(claim, ownerStaleTtlMs);
    if (staleCheck.stale) {
      delete registry.claims[taskId];
      staleCount += 1;
    }
  }

  return { registry, expiredCount, staleCount };
}

// ── Duplicate Claim Resolution ───────────────────────────────────────────────

/**
 * Resolve a duplicate claim conflict deterministically.
 *
 * When two instances claim the same task, we resolve by:
 *   1. Coordinator priority (coordinator always wins)
 *   2. Coordinator priority number (lower wins)
 *   3. Timestamp (earlier claim wins)
 *   4. Instance ID (lexicographic comparison for determinism)
 *
 * @param {object} existingClaim - The existing claim
 * @param {object} newClaim - The new claim attempting to claim
 * @param {object} opts - Resolution options
 * @param {number} [opts.ttlMs] - Presence TTL for coordinator selection
 * @returns {object} { winner, loser, reason }
 */
function resolveDuplicateClaim(existingClaim, newClaim, opts = {}) {
  const { ttlMs = 5 * 60 * 1000 } = opts;
  const nowMs = Date.now();

  // Get coordinator from presence system
  const coordinator = selectCoordinator({ nowMs, ttlMs });
  const coordinatorId = coordinator?.instance_id;

  // Rule 1: Coordinator always wins
  if (coordinatorId) {
    if (existingClaim.instance_id === coordinatorId && newClaim.instance_id !== coordinatorId) {
      return {
        winner: existingClaim,
        loser: newClaim,
        reason: "existing_is_coordinator",
      };
    }
    if (newClaim.instance_id === coordinatorId && existingClaim.instance_id !== coordinatorId) {
      return {
        winner: newClaim,
        loser: existingClaim,
        reason: "new_is_coordinator",
      };
    }
  }

  // Rule 2: Lower coordinator priority wins (if both have priorities)
  const existingPriority = existingClaim.coordinator_priority ?? 100;
  const newPriority = newClaim.coordinator_priority ?? 100;
  if (existingPriority !== newPriority) {
    return existingPriority < newPriority
      ? {
          winner: existingClaim,
          loser: newClaim,
          reason: "existing_lower_priority",
        }
      : {
          winner: newClaim,
          loser: existingClaim,
          reason: "new_lower_priority",
        };
  }

  // Rule 3: Earlier timestamp wins
  const existingTime = new Date(existingClaim.claimed_at).getTime();
  const newTime = new Date(newClaim.claimed_at).getTime();
  if (existingTime !== newTime) {
    return existingTime < newTime
      ? {
          winner: existingClaim,
          loser: newClaim,
          reason: "existing_earlier",
        }
      : {
          winner: newClaim,
          loser: existingClaim,
          reason: "new_earlier",
        };
  }

  // Rule 4: Lexicographic instance ID comparison (deterministic tie-breaker)
  const comparison = existingClaim.instance_id.localeCompare(newClaim.instance_id);
  if (comparison < 0) {
    return {
      winner: existingClaim,
      loser: newClaim,
      reason: "existing_instance_id_lower",
    };
  } else if (comparison > 0) {
    return {
      winner: newClaim,
      loser: existingClaim,
      reason: "new_instance_id_lower",
    };
  }

  // Should never reach here (same instance claiming twice)
  return {
    winner: existingClaim,
    loser: newClaim,
    reason: "same_instance",
  };
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Claim a task for this instance.
 *
 * @param {object} opts
 * @param {string} opts.taskId - Task ID to claim
 * @param {string} [opts.instanceId] - Instance ID (defaults to presence state)
 * @param {number} [opts.ttlMinutes] - Claim TTL in minutes
 * @param {string} [opts.claimToken] - Idempotency token (auto-generated if not provided)
 * @param {object} [opts.metadata] - Additional metadata
 * @returns {Promise<object>} { success, token, claim?, error?, resolution? }
 */
export async function claimTask(opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  return withRegistryLock(() => _claimTaskInner(opts));
}

async function _claimTaskInner(opts) {
  const {
    taskId,
    instanceId = getPresenceState().instance_id,
    ttlMinutes = DEFAULT_TTL_MINUTES,
    claimToken = generateClaimToken(),
    metadata = {},
    ownerStaleTtlMs = parseDuration(
      opts.ownerStaleTtlMs ?? process.env.TASK_CLAIM_OWNER_STALE_TTL_MS,
      DEFAULT_OWNER_STALE_TTL_MS,
    ),
  } = opts;

  if (!taskId) {
    return { success: false, error: "taskId is required" };
  }

  if (!instanceId) {
    return { success: false, error: "instanceId is required" };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  // Load registry and sweep expired claims
  let registry = await loadClaimsRegistry();
  const sweepResult = sweepExpiredClaims(registry, now);
  registry = sweepResult.registry;

  // Check for existing claim
  const existingClaim = registry.claims[taskId];

  // Build new claim
  const presenceState = getPresenceState();
  const scopePaths = inferScopePaths({ metadata }, state.repoRoot);
  const claimMetadata = {
    ...metadata,
    host: metadata?.host || os.hostname(),
    pid: Number.isFinite(Number(metadata?.pid))
      ? Number(metadata.pid)
      : process.pid,
  };
  if (scopePaths.length > 0) {
    claimMetadata.scopePaths = scopePaths;
  }

  const newClaim = {
    task_id: taskId,
    instance_id: instanceId,
    claim_token: claimToken,
    claimed_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ttl_minutes: ttlMinutes,
    coordinator_priority: presenceState.coordinator_priority ?? 100,
    metadata: claimMetadata,
  };
  const syncSharedClaimOrRollback = async ({
    warningLabel,
    successLabel,
    rollbackClaim = null,
    isStaleOverride = false,
  }) => {
    if (!SHARED_STATE_ENABLED) return { success: true };

    try {
      const sharedResult = await claimTaskInSharedState(
        taskId,
        instanceId,
        claimToken,
        Math.floor(SHARED_STATE_STALE_THRESHOLD_MS / 1000),
        state.repoRoot,
        {
          metadata: claimMetadata,
          scopePaths,
        },
      );
      if (!sharedResult.success) {
        const reason = sharedResult.reason || "shared_state_claim_failed";
        console.info(`[task-claims] ${warningLabel} for ${taskId}: ${reason}`);

        if (isFatalSharedClaimConflict(reason, { treatWrappedAsFatal: !isStaleOverride })) {
          const normalizedReason = normalizeSharedClaimConflictReason(reason) || reason;
          if (rollbackClaim) {
            registry.claims[taskId] = rollbackClaim;
          } else {
            delete registry.claims[taskId];
          }
          await saveClaimsRegistry(registry);
          await appendAuditEntry({
            action: "claim_sync_rollback",
            task_id: taskId,
            instance_id: instanceId,
            claim_token: claimToken,
            rollback_reason: normalizedReason,
            rollback_to_instance: rollbackClaim?.instance_id || null,
          });
          return { success: false, error: normalizedReason };
        }

        // Non-fatal rejection on stale override: force-update the shared state
        // so heartbeat renewals match the actual (local) owner.
        if (isStaleOverride) {
          try {
            const forceResult = await forceClaimTaskInSharedState(
              taskId,
              instanceId,
              claimToken,
              Math.floor(SHARED_STATE_STALE_THRESHOLD_MS / 1000),
              state.repoRoot,
              {
                metadata: claimMetadata,
                scopePaths,
              },
            );
            if (forceResult.success) {
              console.info(`[task-claims] Shared state force-claimed after stale override for ${taskId}`);
            } else {
              console.warn(`[task-claims] Shared state force-claim failed for ${taskId}: ${forceResult.reason}`);
            }
          } catch (forceErr) {
            console.warn(`[task-claims] Shared state force-claim error for ${taskId}: ${forceErr.message}`);
          }
        }

        return { success: true };
      }

      console.info(`[task-claims] ${successLabel} for ${taskId}`);
      return { success: true };
    } catch (err) {
      console.warn(`[task-claims] Shared state sync failed for ${taskId}: ${err.message}`);
      return { success: true };
    }
  };

  // If no existing claim, grant immediately
  if (!existingClaim) {
    registry.claims[taskId] = newClaim;
    await saveClaimsRegistry(registry);
    await appendAuditEntry({
      action: "claim",
      task_id: taskId,
      instance_id: instanceId,
      claim_token: claimToken,
      expires_at: expiresAt.toISOString(),
    });

    const sharedSync = await syncSharedClaimOrRollback({
      warningLabel: "Shared state claim warning",
      successLabel: "Shared state synced",
      rollbackClaim: null,
    });
    if (!sharedSync.success) {
      return { success: false, error: sharedSync.error };
    }

    await noteClaimOwnerPresence(instanceId, claimMetadata, "task-claim");

    return { success: true, token: claimToken, claim: newClaim };
  }

  // Idempotency: If existing claim has same token, return it
  if (existingClaim.claim_token === claimToken) {
    return { success: true, token: claimToken, claim: existingClaim, idempotent: true };
  }

  const staleCheck = shouldTreatClaimAsStale(existingClaim, ownerStaleTtlMs);
  if (staleCheck.stale) {
    registry.claims[taskId] = newClaim;
    await saveClaimsRegistry(registry);
    await appendAuditEntry({
      action: "claim_override",
      task_id: taskId,
      instance_id: instanceId,
      claim_token: claimToken,
      expires_at: expiresAt.toISOString(),
      previous_instance: existingClaim.instance_id,
      previous_token: existingClaim.claim_token,
      resolution_reason: staleCheck.reason,
    });

    const sharedSync = await syncSharedClaimOrRollback({
      warningLabel: "Shared state override warning",
      successLabel: "Shared state synced after override",
      rollbackClaim: null,
      isStaleOverride: true,
    });
    if (!sharedSync.success) {
      return { success: false, error: sharedSync.error };
    }

    await noteClaimOwnerPresence(instanceId, claimMetadata, "task-claim-override");

    return {
      success: true,
      token: claimToken,
      claim: newClaim,
      resolution: {
        override: true,
        reason: staleCheck.reason,
        previous_instance: existingClaim.instance_id,
      },
    };
  }

  // Duplicate claim detected — resolve conflict
  const resolution = resolveDuplicateClaim(existingClaim, newClaim);

  if (resolution.winner === newClaim) {
    // New claim wins — replace existing
    registry.claims[taskId] = newClaim;
    await saveClaimsRegistry(registry);
    await appendAuditEntry({
      action: "claim_override",
      task_id: taskId,
      instance_id: instanceId,
      claim_token: claimToken,
      expires_at: expiresAt.toISOString(),
      previous_instance: existingClaim.instance_id,
      previous_token: existingClaim.claim_token,
      resolution_reason: resolution.reason,
    });

    const sharedSync = await syncSharedClaimOrRollback({
      warningLabel: "Shared state override warning",
      successLabel: "Shared state synced after override",
      rollbackClaim: existingClaim,
    });
    if (!sharedSync.success) {
      return { success: false, error: sharedSync.error };
    }

    await noteClaimOwnerPresence(instanceId, claimMetadata, "task-claim-override");

    return {
      success: true,
      token: claimToken,
      claim: newClaim,
      resolution: {
        override: true,
        reason: resolution.reason,
        previous_instance: existingClaim.instance_id,
      },
    };
  } else {
    // Existing claim wins — reject new claim
    await appendAuditEntry({
      action: "claim_rejected",
      task_id: taskId,
      instance_id: instanceId,
      claim_token: claimToken,
      existing_instance: existingClaim.instance_id,
      existing_token: existingClaim.claim_token,
      resolution_reason: resolution.reason,
    });
    return {
      success: false,
      error: "task_already_claimed",
      existing_instance: existingClaim.instance_id,
      existing_claim: existingClaim,
      resolution: {
        override: false,
        reason: resolution.reason,
      },
    };
  }
}

/**
 * Release a claimed task.
 *
 * @param {object} opts
 * @param {string} opts.taskId - Task ID to release
 * @param {string} [opts.claimToken] - Claim token (for verification)
 * @param {string} [opts.instanceId] - Instance ID (defaults to presence state)
 * @param {boolean} [opts.force] - Force release even if not owned
 * @returns {Promise<object>} { success, error? }
 */
export async function releaseTask(opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  return withRegistryLock(() => _releaseTaskInner(opts));
}

async function _releaseTaskInner(opts) {
  const {
    taskId,
    claimToken,
    instanceId = getPresenceState().instance_id,
    force = false,
  } = opts;

  if (!taskId) {
    return { success: false, error: "taskId is required" };
  }

  const registry = await loadClaimsRegistry();
  const claim = registry.claims[taskId];

  if (!claim) {
    return { success: false, error: "task_not_claimed" };
  }

  // Verify ownership unless force=true
  if (!force) {
    if (claim.instance_id !== instanceId) {
      return {
        success: false,
        error: "task_claimed_by_different_instance",
        owner: claim.instance_id,
      };
    }
    if (claimToken && claim.claim_token !== claimToken) {
      return {
        success: false,
        error: "claim_token_mismatch",
      };
    }
  }

  // Release the claim
  delete registry.claims[taskId];
  await saveClaimsRegistry(registry);
  await appendAuditEntry({
    action: force ? "release_forced" : "release",
    task_id: taskId,
    instance_id: instanceId,
    claim_token: claimToken,
    previous_owner: claim.instance_id,
  });

  // Release shared state (mark complete if not forced, abandoned if forced)
  if (SHARED_STATE_ENABLED) {
    try {
      const sharedResult = await releaseSharedState(
        taskId,
        claim.claim_token,
        force ? "abandoned" : "complete",
        force ? "Force released by user" : undefined,
        state.repoRoot,
        { ownerId: claim.instance_id },
      );
      if (!sharedResult.success) {
        console.info(`[task-claims] Shared state release warning for ${taskId}: ${sharedResult.reason}`);
      } else {
        console.info(`[task-claims] Shared state released for ${taskId}`);
      }
    } catch (err) {
      console.warn(`[task-claims] Shared state release failed for ${taskId}: ${err.message}`);
    }
  }

  return { success: true };
}

/**
 * Renew an existing claim (extend TTL).
 *
 * @param {object} opts
 * @param {string} opts.taskId - Task ID
 * @param {string} [opts.claimToken] - Claim token (for verification)
 * @param {string} [opts.instanceId] - Instance ID (defaults to presence state)
 * @param {number} [opts.ttlMinutes] - New TTL in minutes
 * @returns {Promise<object>} { success, claim?, error? }
 */
export async function renewClaim(opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  return withRegistryLock(() => _renewClaimInner(opts));
}

async function _renewClaimInner(opts) {
  const {
    taskId,
    claimToken,
    instanceId = getPresenceState().instance_id,
    ttlMinutes = DEFAULT_TTL_MINUTES,
  } = opts;

  if (!taskId) {
    return { success: false, error: "taskId is required" };
  }

  const registry = await loadClaimsRegistry();
  const claim = registry.claims[taskId];

  if (!claim) {
    return { success: false, error: "task_not_claimed" };
  }

  // Verify ownership
  if (claim.instance_id !== instanceId) {
    return {
      success: false,
      error: "task_claimed_by_different_instance",
      owner: claim.instance_id,
    };
  }
  if (claimToken && claim.claim_token !== claimToken) {
    return {
      success: false,
      error: "claim_token_mismatch",
    };
  }

  // Renew the claim
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  claim.expires_at = expiresAt.toISOString();
  claim.ttl_minutes = ttlMinutes;
  claim.renewed_at = now.toISOString();

  // Refresh our own presence so shouldTreatClaimAsStale() continues to
  // see this instance as active between fleet-sync intervals.
  try {
    await noteClaimOwnerPresence(instanceId, claim.metadata || {}, "claim-renew");
  } catch {
    /* best-effort — don't fail the renewal for a presence write error */
  }

  await saveClaimsRegistry(registry);
  await appendAuditEntry({
    action: "renew",
    task_id: taskId,
    instance_id: instanceId,
    claim_token: claimToken,
    expires_at: expiresAt.toISOString(),
  });

  // Renew shared state heartbeat
  if (SHARED_STATE_ENABLED) {
    try {
      const sharedResult = await renewSharedStateHeartbeat(
        taskId,
        instanceId,
        claimToken,
        state.repoRoot,
        {
          metadata: claim.metadata || {},
        },
      );
      if (!sharedResult.success) {
        const reason = sharedResult.reason || "unknown";
        // Token/owner mismatch in shared state means another orchestrator has
        // taken over. Remove local ownership so this process does not retain a
        // stale claim that blocks redispatch after we abort.
        if (
          reason === "attempt_token_mismatch" ||
          reason === "owner_mismatch" ||
          reason === "scope_lock_owner_mismatch"
        ) {
          delete registry.claims[taskId];
          await saveClaimsRegistry(registry);
          await appendAuditEntry({
            action: "renew_forfeit",
            task_id: taskId,
            instance_id: instanceId,
            claim_token: claimToken,
            forfeit_reason: reason,
          });
          console.warn(`[task-claims] Shared state heartbeat FATAL for ${taskId}: ${reason} — surfacing as claim failure`);
          return { success: false, error: reason };
        }
        console.info(`[task-claims] Shared state heartbeat renewal warning for ${taskId}: ${reason}`);
      }
    } catch (err) {
      console.warn(`[task-claims] Shared state heartbeat renewal failed for ${taskId}: ${err.message}`);
    }
  }

  return { success: true, claim };
}

/**
 * Get a claim by task ID.
 *
 * @param {string} taskId - Task ID
 * @returns {Promise<object|null>} Claim object or null
 */
export async function getClaim(taskId, opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  const registry = await loadClaimsRegistry();
  return registry.claims[taskId] || null;
}

/**
 * List all active claims.
 *
 * @param {object} opts
 * @param {string} [opts.instanceId] - Filter by instance ID
 * @param {boolean} [opts.includeExpired] - Include expired claims
 * @returns {Promise<Array<object>>} Array of claim objects
 */
export async function listClaims(opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  return withRegistryLock(() => _listClaimsInner(opts));
}

async function _listClaimsInner(opts = {}) {
  const {
    instanceId,
    includeExpired = false,
    ownerStaleTtlMs = parseDuration(
      opts.ownerStaleTtlMs ?? process.env.TASK_CLAIM_OWNER_STALE_TTL_MS,
      DEFAULT_OWNER_STALE_TTL_MS,
    ),
  } = opts;

  let registry = await loadClaimsRegistry();
  const sweepResult = sweepInactiveClaims(registry, {
    includeExpired,
    ownerStaleTtlMs,
  });
  registry = sweepResult.registry;
  if (sweepResult.expiredCount > 0 || sweepResult.staleCount > 0) {
    await saveClaimsRegistry(registry);
  }

  let claims = Object.values(registry.claims);

  if (instanceId) {
    claims = claims.filter((c) => c.instance_id === instanceId);
  }

  return claims;
}

/**
 * Check if a task is claimed.
 *
 * @param {string} taskId - Task ID
 * @returns {Promise<boolean>} True if claimed (and not expired)
 */
export async function isTaskClaimed(taskId, opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  const claim = await getClaim(taskId, opts);
  if (!claim) return false;
  return !isClaimExpired(claim);
}

/**
 * Get claim statistics.
 *
 * @returns {Promise<object>} Statistics object
 */
export async function getClaimStats(opts = {}) {
  await ensureRepoContext(opts.repoRoot);
  ensureInitialized();
  const registry = await loadClaimsRegistry();
  const now = new Date();

  let active = 0;
  let expired = 0;
  const byInstance = new Map();

  for (const claim of Object.values(registry.claims)) {
    if (isClaimExpired(claim, now)) {
      expired++;
    } else {
      active++;
      const count = byInstance.get(claim.instance_id) || 0;
      byInstance.set(claim.instance_id, count + 1);
    }
  }

  return {
    total: active + expired,
    active,
    expired,
    by_instance: Object.fromEntries(byInstance),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

// For testing
export const _test = {
  sweepExpiredClaims,
  sweepInactiveClaims,
  resolveDuplicateClaim,
  isClaimExpired,
  loadClaimsRegistry,
  saveClaimsRegistry,
  withRegistryLock,
  acquireRegistryFileLock,
  readRegistryLock,
  generateClaimToken,
  retryFsOperation,
  isRetriableFsError,
};
