import { apiFetch } from "./api.js";
import { buildSessionApiPath } from "./session-api.js";

const SESSION_PHASE_DEFINITIONS = Object.freeze({
  planning: Object.freeze({
    id: "planning",
    label: "Planning",
    tone: "info",
    description: "Clarifying goals, inspecting context, and shaping the next execution path.",
    promptRule: "Stay plan-first: gather context, define constraints, and make the next step explicit before acting.",
    toolRule: "Prefer discovery, read-only inspection, and outlining tools until the path is clear.",
    uiState: "draft",
  }),
  building: Object.freeze({
    id: "building",
    label: "Building",
    tone: "primary",
    description: "Implementing concrete changes, assembling outputs, or preparing deliverables.",
    promptRule: "Keep the implementation loop tight: make focused changes, explain intent, and verify incrementally.",
    toolRule: "Favor edit, diff, patch, and targeted verification tools that create forward progress.",
    uiState: "build",
  }),
  staging: Object.freeze({
    id: "staging",
    label: "Staging",
    tone: "warning",
    description: "Preparing a checkpoint, approval gate, handoff, or release boundary.",
    promptRule: "Package readiness clearly: summarize risks, blockers, and the exact gate or handoff that comes next.",
    toolRule: "Prefer validation, packaging, checkpoint, and approval-aware tools over broad new changes.",
    uiState: "checkpoint",
  }),
  running: Object.freeze({
    id: "running",
    label: "Running",
    tone: "success",
    description: "A live worker, workflow, or delegated execution is actively in motion.",
    promptRule: "Prioritize progress reporting, continuity, and runtime safety while execution is live.",
    toolRule: "Use runtime-safe monitoring, continuation, and observability tools instead of disruptive reconfiguration.",
    uiState: "live",
  }),
  editing: Object.freeze({
    id: "editing",
    label: "Editing",
    tone: "secondary",
    description: "The workspace is being actively changed and should stay grounded in diffs.",
    promptRule: "Keep edits incremental, stay anchored to the current diff, and validate before widening scope.",
    toolRule: "Favor file edits, patch review, and targeted test runs that keep the working tree legible.",
    uiState: "workspace",
  }),
});

const PHASE_KEYWORD_MAP = Object.freeze({
  planning: ["plan", "planning", "research", "analy", "discover", "decompose", "spec", "scope", "triage"],
  building: ["build", "implement", "implementation", "refactor", "fix", "write", "code", "compose"],
  staging: ["stage", "staging", "review", "verify", "validation", "approve", "approval", "gate", "handoff", "release", "checkpoint", "package"],
  editing: ["edit", "editing", "patch", "diff", "commit", "workspace", "change"],
});

function normalizePhaseId(value, fallback = "planning") {
  const normalized = String(
    typeof value === "object" && value !== null
      ? (value.id || value.key || value.phase || "")
      : (value || "")
  ).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SESSION_PHASE_DEFINITIONS, normalized)
    ? normalized
    : fallback;
}

function normalizeRuntimeState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (["active", "busy", "working", "inprogress"].includes(normalized)) return "running";
  if (["ended", "done", "complete"].includes(normalized)) return "completed";
  return normalized;
}

function matchPhaseKeywords(haystack, phaseId) {
  const lower = String(haystack || "").trim().toLowerCase();
  if (!lower) return false;
  return (PHASE_KEYWORD_MAP[phaseId] || []).some((keyword) => lower.includes(keyword));
}

function deriveSessionPhaseId(session = {}) {
  const metadata = session?.metadata && typeof session.metadata === "object"
    ? session.metadata
    : {};
  const runtimeHealth = session?.runtimeHealth || session?.insights?.runtimeHealth || null;
  const explicitPhase =
    session?.surface?.phase?.id
    || session?.surface?.phase?.key
    || session?.operatorPhase?.id
    || session?.operatorPhase?.key
    || metadata.operatorPhase
    || metadata.phase
    || metadata.sessionPhase
    || "";
  if (explicitPhase) return normalizePhaseId(explicitPhase, "planning");

  const stageHint = [
    session?.currentStageId,
    session?.entryStageId,
    metadata.currentStageId,
    metadata.entryStageId,
  ].filter(Boolean).join(" ");
  const focusText = [
    session?.sessionType,
    session?.scope,
    session?.taskTitle,
    session?.taskKey,
    metadata.surface,
    metadata.mode,
    metadata.intent,
    metadata.source,
  ].filter(Boolean).join(" ");
  const lifecycleState = normalizeRuntimeState(session?.lifecycleStatus || session?.status || "");
  const runtimeState = normalizeRuntimeState(
    session?.runtimeState
    || runtimeHealth?.state
    || metadata.runtimeState
    || session?.status
    || "",
  );
  const hasEdits = Boolean(runtimeHealth?.hasEdits || runtimeHealth?.hasCommits || metadata.hasEdits || metadata.hasCommits);
  const hasActiveWorker = Boolean(
    session?.activeWorkerId
    || session?.activeWorker?.workerId
    || session?.activeWorker?.threadId
  );

  if (hasEdits || runtimeState === "editing") return "editing";
  if (["waiting_approval", "paused", "queued", "retrying", "resuming", "blocked"].includes(lifecycleState)) return "staging";
  if (matchPhaseKeywords(stageHint, "editing")) return "editing";
  if (matchPhaseKeywords(stageHint, "staging")) return "staging";
  if (matchPhaseKeywords(stageHint, "planning")) return "planning";
  if (matchPhaseKeywords(stageHint, "building")) return "building";
  if (matchPhaseKeywords(focusText, "planning")) return "planning";
  if (matchPhaseKeywords(focusText, "building")) return "building";
  if (["running", "working", "committing"].includes(runtimeState) || hasActiveWorker) return "running";
  if (["task", "workflow", "workflow-overseer", "subagent"].includes(String(session?.sessionType || "").trim().toLowerCase())) return "building";
  return "planning";
}

export function getSessionPhaseState(session = null) {
  const surfacePhase = session?.surface?.phase && typeof session.surface.phase === "object"
    ? session.surface.phase
    : null;
  const phaseId = normalizePhaseId(surfacePhase || deriveSessionPhaseId(session), "planning");
  const definition = SESSION_PHASE_DEFINITIONS[phaseId];
  return {
    ...definition,
    ...(surfacePhase || {}),
    id: phaseId,
    label: String(surfacePhase?.label || definition.label),
    tone: String(surfacePhase?.tone || definition.tone),
    description: String(surfacePhase?.description || definition.description),
    promptRule: String(surfacePhase?.promptRule || definition.promptRule),
    toolRule: String(surfacePhase?.toolRule || definition.toolRule),
    uiState: String(surfacePhase?.uiState || definition.uiState),
  };
}

export async function updateSessionSurface(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("Session id is required");
  }
  const workspace = String(options?.workspace || "active").trim() || "active";
  const path = buildSessionApiPath(normalizedSessionId, "surface", { workspace });
  if (!path) {
    throw new Error("Session path unavailable");
  }
  const body = {
    ...(options && typeof options === "object" ? options : {}),
  };
  delete body.workspace;
  return apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function loadSessionBranches(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("Session id is required");
  }
  const workspace = String(options?.workspace || "active").trim() || "active";
  const repoPath = String(options?.repoPath || "").trim();
  const query = repoPath ? { repoPath } : undefined;
  const path = buildSessionApiPath(normalizedSessionId, "branches", {
    workspace,
    query,
  });
  if (!path) {
    throw new Error("Session path unavailable");
  }
  return apiFetch(path, { _silent: true });
}

export function replaceSessionInList(sessions, nextSession) {
  const list = Array.isArray(sessions) ? sessions : [];
  const normalizedSessionId = String(nextSession?.id || "").trim();
  if (!normalizedSessionId) return list.slice();
  let replaced = false;
  const nextList = list.map((session) => {
    if (String(session?.id || "").trim() !== normalizedSessionId) return session;
    replaced = true;
    return {
      ...session,
      ...nextSession,
      metadata: {
        ...(session?.metadata && typeof session.metadata === "object" ? session.metadata : {}),
        ...(nextSession?.metadata && typeof nextSession.metadata === "object" ? nextSession.metadata : {}),
      },
      surface: nextSession?.surface || session?.surface || null,
    };
  });
  if (!replaced) nextList.unshift(nextSession);
  return nextList;
}
