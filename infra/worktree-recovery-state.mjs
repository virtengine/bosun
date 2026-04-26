import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEFAULT_RECOVERY_STATE = Object.freeze({
  health: "healthy",
  failureStreak: 0,
  failureCount: 0,
  successCount: 0,
  lastUpdatedAt: null,
  lastFailureAt: null,
  lastRecoveredAt: null,
  lastHealthyAt: null,
  recentEvents: Object.freeze([]),
});

const MAX_RECOVERY_EVENTS = 12;
const VALID_HEALTH = new Set(["healthy", "recovered", "failing", "degraded"]);
const VALID_OUTCOMES = new Set(["healthy_noop", "recreated", "recreation_failed"]);

function getStatusPath(repoRoot) {
  const override = String(process.env.STATUS_FILE || "").trim();
  if (override) {
    // If override is an absolute path, resolve it directly;
    // if it's relative, resolve it against the repo root.
    const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(override) || override.startsWith("\\\\");
    const isPosixAbsolute = override.startsWith("/");
    if (isWindowsAbsolute || isPosixAbsolute) {
      return resolve(override);
    }
    return resolve(repoRoot, override);
  }
  return resolve(repoRoot, ".cache", "orchestrator-status.json");
}

function toIsoTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return new Date().toISOString();
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function normalizeDetectedIssues(input) {
  const values = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const issues = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    issues.push(normalized);
  }
  return issues;
}

// Drop values that are obviously unresolved Mustache/template placeholders
// (e.g. "{{$ctx.data?.recoveryContext?.branch || ''}}") so they never leak
// into persisted state or the UI as identifying labels.
function sanitizeIdentifier(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.includes("{{") || text.includes("}}")) return null;
  return text;
}

function normalizeRecoveryEvent(event = {}) {
  const outcome = String(event?.outcome || "").trim().toLowerCase();
  return {
    outcome: VALID_OUTCOMES.has(outcome) ? outcome : "healthy_noop",
    reason: sanitizeIdentifier(event?.reason),
    branch: sanitizeIdentifier(event?.branch),
    taskId: sanitizeIdentifier(event?.taskId),
    worktreePath: sanitizeIdentifier(event?.worktreePath),
    phase: sanitizeIdentifier(event?.phase),
    error: String(event?.error || "").trim() || null,
    detectedIssues: normalizeDetectedIssues(event?.detectedIssues),
    timestamp: toIsoTimestamp(event?.timestamp),
  };
}

function normalizeWorktreeRecoveryState(input = null) {
  const source = input && typeof input === "object" ? input : {};
  const health = String(source.health || "").trim().toLowerCase();
  return {
    health: VALID_HEALTH.has(health) ? health : "healthy",
    failureStreak: Math.max(0, Number.parseInt(String(source.failureStreak || 0), 10) || 0),
    failureCount: Math.max(0, Number.parseInt(String(source.failureCount || 0), 10) || 0),
    successCount: Math.max(0, Number.parseInt(String(source.successCount || 0), 10) || 0),
    lastUpdatedAt: source.lastUpdatedAt ? toIsoTimestamp(source.lastUpdatedAt) : null,
    lastFailureAt: source.lastFailureAt ? toIsoTimestamp(source.lastFailureAt) : null,
    lastRecoveredAt: source.lastRecoveredAt ? toIsoTimestamp(source.lastRecoveredAt) : null,
    lastHealthyAt: source.lastHealthyAt ? toIsoTimestamp(source.lastHealthyAt) : null,
    recentEvents: Array.isArray(source.recentEvents)
      ? source.recentEvents.map((event) => normalizeRecoveryEvent(event)).slice(0, MAX_RECOVERY_EVENTS)
      : [],
  };
}

function buildNextWorktreeRecoveryState(currentState, event) {
  const state = normalizeWorktreeRecoveryState(currentState);
  const normalizedEvent = normalizeRecoveryEvent(event);
  const nextState = {
    ...state,
    lastUpdatedAt: normalizedEvent.timestamp,
  };

  if (normalizedEvent.outcome === "healthy_noop") {
    return {
      ...nextState,
      health:
        state.health === "recovered"
          ? "recovered"
          : (state.failureStreak > 0 ? state.health : "healthy"),
      lastHealthyAt: normalizedEvent.timestamp,
    };
  }

  const recentEvents = [normalizedEvent, ...state.recentEvents].slice(0, MAX_RECOVERY_EVENTS);
  if (normalizedEvent.outcome === "recreated") {
    return {
      ...nextState,
      health: "recovered",
      failureStreak: 0,
      successCount: state.successCount + 1,
      lastRecoveredAt: normalizedEvent.timestamp,
      lastHealthyAt: normalizedEvent.timestamp,
      recentEvents,
    };
  }

  const failureStreak = state.failureStreak + 1;
  return {
    ...nextState,
    health: failureStreak > 1 ? "degraded" : "failing",
    failureStreak,
    failureCount: state.failureCount + 1,
    lastFailureAt: normalizedEvent.timestamp,
    recentEvents,
  };
}

async function readStatusDocument(repoRoot) {
  const statusPath = getStatusPath(repoRoot);
  try {
    const raw = await readFile(statusPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readWorktreeRecoveryState(repoRoot) {
  const document = await readStatusDocument(repoRoot);
  return normalizeWorktreeRecoveryState(document.worktreeRecovery);
}

async function recordWorktreeRecoveryEvent(repoRoot, event) {
  const statusPath = getStatusPath(repoRoot);
  const document = await readStatusDocument(repoRoot);
  document.worktreeRecovery = buildNextWorktreeRecoveryState(document.worktreeRecovery, event);
  await mkdir(dirname(statusPath), { recursive: true });
  await writeFile(statusPath, JSON.stringify(document, null, 2), "utf8");
  return document.worktreeRecovery;
}

export {
  buildNextWorktreeRecoveryState,
  normalizeRecoveryEvent,
  normalizeWorktreeRecoveryState,
  readWorktreeRecoveryState,
  recordWorktreeRecoveryEvent,
};
