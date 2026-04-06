/* ─────────────────────────────────────────────────────────────
 *  Tab: Workflows — N8N-style Visual Workflow Builder
 *  Drag-and-drop canvas for creating/editing Bosun workflows
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch, onWsMessage } from "../modules/api.js";
import { showToast, refreshTab } from "../modules/state.js";
import { navigateTo, routeParams, setRouteParams } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { resolveIcon } from "../modules/icon-utils.js";
import { formatDate, formatDuration, formatRelative } from "../modules/utils.js";
import {
  buildDraftFlowchartMap,
  buildDraftFlowchartMetadata,
  HISTORY_LIMIT,
  HISTORY_COMMIT_DEBOUNCE_MS,
  buildCollapsedGraph,
  buildNodeStatusesFromRunDetail,
  convertSelectionToSubworkflow,
  createHistoryState,
  createNodeGroup,
  getNodeSearchMetadata,
  hydrateCanvasEdges,
  moveWorkflowGroupByDelta,
  parseGraphSnapshot,
  pushHistorySnapshot,
  redoHistory,
  resolveNodeOutputPreview,
  resolveWorkflowGroupBounds,
  searchNodeTypes,
  serializeGraphSnapshot,
  toggleWorkflowGroupCollapsed,
  undoHistory,
  validateCanvasEdgePorts,
  canUpdateCanvasEdgePortMapping,
} from "./workflow-canvas-utils.mjs";
import { createSession } from "../components/session-list.js";
import { buildSessionApiPath, resolveSessionWorkspaceHint } from "../modules/session-api.js";
import { Card, Badge, EmptyState } from "../components/shared.js";
import {
  Typography, Box, Stack, Card as MuiCard, CardContent, Button, IconButton, Chip,
  TextField, Select, MenuItem, FormControl, InputLabel, Switch,
  FormControlLabel, Tooltip, Paper, Divider, CircularProgress, Alert,
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tabs, Tab, Fab, Menu as MuiMenu,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from "@mui/material";
import { activeWorkspaceId } from "../components/workspace-switcher.js";

/* ═══════════════════════════════════════════════════════════════
 *  State
 * ═══════════════════════════════════════════════════════════════ */

const workflows = signal([]);
const templates = signal([]);
const nodeTypes = signal([]);
const activeWorkflow = signal(null);
const workflowRuns = signal([]);
const workflowRunsTotal = signal(0);
const workflowRunsHasMore = signal(false);
const workflowRunsNextOffset = signal(0);
const workflowRunsLoadingMore = signal(false);
const workflowRunsLoading = signal(false);
const workflowRunsError = signal("");
const workflowRunsScopeId = signal(null);
const selectedRunId = signal(null);
const selectedRunDetail = signal(null);
const workflowRunDetailLoading = signal(false);
const workflowRunDetailError = signal("");
const canvasZoom = signal(1);
const canvasOffset = signal({ x: 0, y: 0 });
const selectedNodeId = signal(null);
const selectedEdgeId = signal(null);
const draggingNode = signal(null);
const connectingFrom = signal(null);
const viewMode = signal("list"); // "list" | "canvas" | "runs" | "code"
const WORKFLOW_RUN_PAGE_SIZE = 20;
const WORKFLOW_RUN_MAX_FETCH = 5000;
const WORKFLOW_LIVE_POLL_MS = 3000;
const WORKFLOW_LIVE_WS_BATCH_MS = 90;
const UNKNOWN_OUTPUT_PORT_LABEL = "Unknown output port";
const UNKNOWN_INPUT_PORT_LABEL = "Unknown input port";
const NODE_COMPLETION_FLASH_MS = 1400;
const NODE_RUNNING_HINT_MS = 500;
const EDGE_FLOW_ANIMATION_MS = 1200;
const WORKFLOW_NODE_HEADER_HEIGHT = 44;
const NODE_HEADER = WORKFLOW_NODE_HEADER_HEIGHT;
const NODE_HEADER_H = WORKFLOW_NODE_HEADER_HEIGHT;
const workflowRunsLimit = signal(WORKFLOW_RUN_PAGE_SIZE);

// ── Execute Dialog state ──────────────────────────────────────────────────
const executeDialogOpen = signal(false);
const executeDialogWorkflow = signal(null);   // full workflow def
const executeDialogVars = signal({});          // editable variable overrides
const executeDialogLaunching = signal(false);
const executeDialogResult = signal(null);      // { ok, error?, ... }
const executeDialogMode = signal("quick");     // "quick" | "advanced"
const executeDialogRepos = signal([]);         // workspace repos for target-repo selector
const executeDialogTargetRepo = signal("");    // selected target repo name
const executeDialogWaitSync = signal(false);   // wait for completion toggle
const installDialogOpen = signal(false);
const installDialogTemplate = signal(null);
const installDialogVars = signal({});
const installDialogMode = signal("quick");
const installDialogInstalling = signal(false);
const installDialogResult = signal(null);
const workflowsLoading = signal(false);
const templatesLoading = signal(false);
const nodeTypesLoading = signal(false);

function getWorkflowNameById(workflowId) {
  const id = String(workflowId || "").trim();
  if (!id) return "";
  return (workflows.value || []).find((workflow) => workflow?.id === id)?.name || id;
}

function buildWorkflowRunApiPath(pathname, workspaceId = activeWorkspaceId.value) {
  const text = String(pathname || "").trim();
  if (!text) return "/api/workflows/runs";
  const [basePath, queryString = ""] = text.split("?");
  const searchParams = new URLSearchParams(queryString);
  if (workspaceId) {
    searchParams.set("workspace", workspaceId);
  }
  const nextQuery = searchParams.toString();
  return nextQuery ? `${basePath}?${nextQuery}` : basePath;
}

function appendQueryParams(pathname, params = {}) {
  const text = String(pathname || "").trim();
  if (!text) return "";
  const [basePath, queryString = ""] = text.split("?");
  const searchParams = new URLSearchParams(queryString);
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    const nextValue = String(value).trim();
    if (!nextValue) continue;
    searchParams.set(key, nextValue);
  }
  const nextQuery = searchParams.toString();
  return nextQuery ? `${basePath}?${nextQuery}` : basePath;
}

function resetWorkflowRunsState(scopeWorkflowId = null) {
  workflowRuns.value = [];
  workflowRunsTotal.value = 0;
  workflowRunsHasMore.value = false;
  workflowRunsNextOffset.value = 0;
  workflowRunsLoadingMore.value = false;
  workflowRunsScopeId.value = scopeWorkflowId ? String(scopeWorkflowId) : null;
  workflowRunsLimit.value = WORKFLOW_RUN_PAGE_SIZE;
}

function mergeWorkflowRunPages(existingRuns, nextRuns) {
  const merged = [];
  const seen = new Set();
  for (const run of [...(existingRuns || []), ...(nextRuns || [])]) {
    const runId = String(run?.runId || "").trim();
    const dedupeKey = runId || JSON.stringify(run);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(run);
  }
  return merged;
}

function mergeWorkflowRunRefresh(existingRuns, nextRuns) {
  const merged = [];
  const seen = new Set();
  for (const run of [...(nextRuns || []), ...(existingRuns || [])]) {
    const runId = String(run?.runId || "").trim();
    const dedupeKey = runId || JSON.stringify(run);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    merged.push(run);
  }
  return merged;
}

function cloneVars(input) {
  if (!input || typeof input !== "object") return {};
  try {
    if (typeof structuredClone === "function") return structuredClone(input);
  } catch {}
  return JSON.parse(JSON.stringify(input));
}

function returnToWorkflowList() {
  selectedNodeId.value = null;
  selectedEdgeId.value = null;
  selectedRunId.value = null;
  selectedRunDetail.value = null;
  resetWorkflowRunsState();
  viewMode.value = "list";
  setRouteParams({}, { replace: true, skipGuard: true });
}

function openWorkflowCanvas(workflowId) {
  const id = String(workflowId || "").trim();
  if (!id) return;
  apiFetch(`/api/workflows/${encodeURIComponent(id)}`)
    .then((data) => {
      activeWorkflow.value = data?.workflow || (workflows.value || []).find((workflow) => workflow.id === id) || null;
      if (activeWorkflow.value) {
        viewMode.value = "canvas";
      }
    })
    .catch(() => {
      const existing = (workflows.value || []).find((workflow) => workflow.id === id) || null;
      if (existing) {
        activeWorkflow.value = existing;
        viewMode.value = "canvas";
      }
    });
}

export function openWorkflowRunsView(workflowId, runId = null) {
  const scopedWorkflowId = String(workflowId || "").trim() || null;
  resetWorkflowRunsState(scopedWorkflowId);
  selectedRunId.value = null;
  selectedRunDetail.value = null;
  viewMode.value = "runs";
  const route = { runsView: true };
  if (scopedWorkflowId) route.runsWorkflowId = scopedWorkflowId;
  if (runId) route.runId = runId;
  setRouteParams(route, { replace: false, skipGuard: true });
  loadRuns(scopedWorkflowId, { reset: true }).catch(() => {});
  if (runId) {
    loadRunDetail(runId, { workflowId: scopedWorkflowId }).catch(() => {});
  }
}

const WORKFLOW_COPILOT_MAX_CHARS = 5000;

function formatWorkflowCopilotBlock(value, maxChars = WORKFLOW_COPILOT_MAX_CHARS) {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxChars) return json;
    const omitted = json.length - maxChars;
    return `${json.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
  } catch {
    const text = String(value ?? "");
    if (text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
  }
}

function summarizeWorkflowNodes(workflow, limit = 20) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  if (!nodes.length) return "No nodes defined.";
  const lines = nodes.slice(0, limit).map((node, index) => {
    const nodeId = String(node?.id || `node-${index + 1}`).trim();
    const nodeType = String(node?.type || "unknown").trim();
    const nodeName =
      String(node?.name || node?.label || node?.title || "").trim() || null;
    const configKeys = Object.keys(node?.config || {}).slice(0, 6);
    const configSummary = configKeys.length ? ` config keys: ${configKeys.join(", ")}` : "";
    return `${index + 1}. ${nodeId} [${nodeType}]${nodeName ? ` - ${nodeName}` : ""}${configSummary}`;
  });
  if (nodes.length > limit) {
    lines.push(`... ${nodes.length - limit} more node(s) omitted`);
  }
  return lines.join("\n");
}

function summarizeWorkflowEdges(workflow, limit = 24) {
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  if (!edges.length) return "No edges defined.";
  const lines = edges.slice(0, limit).map((edge, index) => {
    const from = String(edge?.source || edge?.from || "?").trim() || "?";
    const to = String(edge?.target || edge?.to || "?").trim() || "?";
    const fromPort = String(edge?.sourcePort || edge?.fromPort || "").trim();
    const toPort = String(edge?.targetPort || edge?.toPort || "").trim();
    const portSummary = fromPort || toPort ? ` (${fromPort || "default"} -> ${toPort || "default"})` : "";
    return `${index + 1}. ${from} -> ${to}${portSummary}`;
  });
  if (edges.length > limit) {
    lines.push(`... ${edges.length - limit} more edge(s) omitted`);
  }
  return lines.join("\n");
}

function summarizeWorkflowNodeLinks(workflow, nodeId, direction = "incoming", limit = 10) {
  const safeNodeId = String(nodeId || "").trim();
  if (!safeNodeId) return direction === "outgoing" ? "No downstream edges." : "No upstream edges.";
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const relevant = edges.filter((edge) => {
    const sourceId = String(edge?.source || edge?.from || "").trim();
    const targetId = String(edge?.target || edge?.to || "").trim();
    return direction === "outgoing" ? sourceId === safeNodeId : targetId === safeNodeId;
  });
  if (!relevant.length) return direction === "outgoing" ? "No downstream edges." : "No upstream edges.";
  const lines = relevant.slice(0, limit).map((edge, index) => {
    const sourceId = String(edge?.source || edge?.from || "?").trim() || "?";
    const targetId = String(edge?.target || edge?.to || "?").trim() || "?";
    const sourcePort = String(edge?.sourcePort || edge?.fromPort || "").trim() || "default";
    const targetPort = String(edge?.targetPort || edge?.toPort || "").trim() || "default";
    return `${index + 1}. ${sourceId}:${sourcePort} -> ${targetId}:${targetPort}`;
  });
  if (relevant.length > limit) {
    lines.push(`... ${relevant.length - limit} more ${direction} edge(s) omitted`);
  }
  return lines.join("\n");
}

function summarizeRunNodeStatuses(run, limit = 25) {
  const nodeStatuses = buildNodeStatusesFromRunDetail(run);
  const entries = Object.entries(nodeStatuses || {});
  if (!entries.length) return "No node status data recorded.";
  const sorted = entries.sort((a, b) => {
    const rankDiff = getNodeStatusRank(a[1]) - getNodeStatusRank(b[1]);
    if (rankDiff !== 0) return rankDiff;
    return String(a[0]).localeCompare(String(b[0]));
  });
  const lines = sorted.slice(0, limit).map(([nodeId, status], index) => (
    `${index + 1}. ${nodeId}: ${status || "unknown"}`
  ));
  if (sorted.length > limit) {
    lines.push(`... ${sorted.length - limit} more node status entries omitted`);
  }
  return lines.join("\n");
}

function summarizeRunNodeOutputs(run, limit = 12) {
  const outputs = run?.detail?.nodeOutputs && typeof run.detail.nodeOutputs === "object"
    ? run.detail.nodeOutputs
    : {};
  const entries = Object.entries(outputs);
  if (!entries.length) return "No node outputs recorded.";
  const lines = entries.slice(0, limit).map(([nodeId, output], index) => {
    const summary = String(output?.summary || "").trim();
    const narrative = String(output?.narrative || "").trim();
    if (summary || narrative) {
      const parts = [summary, narrative].filter(Boolean);
      return `${index + 1}. ${nodeId}: ${parts.join(" | ")}`;
    }
    return `${index + 1}. ${nodeId}: ${formatWorkflowCopilotBlock(output, 500)}`;
  });
  if (entries.length > limit) {
    lines.push(`... ${entries.length - limit} more node output entries omitted`);
  }
  return lines.join("\n");
}

function getRunDagCounts(run) {
  const dagCounts = run?.detail?.dagState?.counts;
  if (dagCounts && typeof dagCounts === "object") {
    return {
      nodeCount: Number(dagCounts.nodeCount ?? dagCounts.total ?? run?.nodeCount ?? 0) || 0,
      completed: Number(dagCounts.completed ?? dagCounts.completedCount ?? run?.completedCount ?? 0) || 0,
      failed: Number(dagCounts.failed ?? dagCounts.failedCount ?? run?.failedCount ?? 0) || 0,
      skipped: Number(dagCounts.skipped ?? dagCounts.skippedCount ?? run?.skippedCount ?? 0) || 0,
      active: Number(dagCounts.active ?? dagCounts.activeNodeCount ?? run?.activeNodeCount ?? 0) || 0,
    };
  }
  return {
    nodeCount: Number(run?.nodeCount || 0) || 0,
    completed: Number(run?.completedCount || 0) || 0,
    failed: Number(run?.failedCount || 0) || 0,
    skipped: Number(run?.skippedCount || 0) || 0,
    active: Number(run?.activeNodeCount || 0) || 0,
  };
}

function formatRetryModeLabel(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === "from_failed") return "Retry from failed step";
  if (normalized === "from_scratch") return "Retry from scratch";
  return normalized || "Unknown retry mode";
}

function formatRetryDecisionReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return "No retry decision reason recorded.";
  if (normalized === "issue_advisor.replan_from_failed") return "Issue advisor recommends replanning from the failure boundary.";
  if (normalized === "issue_advisor.resume_remaining") return "Issue advisor recommends resuming remaining work.";
  if (normalized === "issue_advisor.inspect_failure") return "Issue advisor recommends inspection before trusting resume state.";
  if (normalized === "dag_state.no_completed_nodes") return "No completed nodes were available to resume from.";
  if (normalized === "dag_state.multiple_failures") return "Multiple failed nodes suggest a clean rerun is safer.";
  if (normalized === "dag_state.localized_resume") return "Completed upstream work can be reused for a localized retry.";
  if (normalized.startsWith("fallback:")) {
    return `Fallback retry policy selected ${formatRetryModeLabel(normalized.replace("fallback:", ""))}.`;
  }
  return normalized.replaceAll("_", " ");
}

function formatIssueAdvisorAction(action) {
  const normalized = String(action || "").trim().toLowerCase();
  if (normalized === "replan_from_failed") return "Replan from failed node";
  if (normalized === "replan_subgraph") return "Replan downstream subgraph";
  if (normalized === "rerun_same_step") return "Rerun same step";
  if (normalized === "spawn_fix_step") return "Spawn targeted fix step";
  if (normalized === "resume_remaining") return "Resume remaining work";
  if (normalized === "inspect_failure") return "Inspect failure first";
  if (normalized === "continue") return "Continue";
  return normalized ? normalized.replaceAll("_", " ") : "No recommendation";
}

function formatGovernanceLabel(value, fallback = "—") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized.replaceAll("_", " ");
}

function formatBudgetCents(value, currency = "USD") {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD").trim() || "USD",
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${String(currency || "USD").trim() || "USD"}`;
  }
}

function readWorkflowGovernance(run = {}) {
  const detail = run?.detail && typeof run.detail === "object" ? run.detail : {};
  const goalAncestry = Array.isArray(run?.goalAncestry)
    ? run.goalAncestry
    : (Array.isArray(detail?.goalAncestry) ? detail.goalAncestry : []);
  const budgetPolicy =
    run?.budgetPolicy && typeof run.budgetPolicy === "object"
      ? run.budgetPolicy
      : (detail?.budgetPolicy && typeof detail.budgetPolicy === "object" ? detail.budgetPolicy : null);
  const budgetOutcome =
    run?.budgetOutcome && typeof run.budgetOutcome === "object"
      ? run.budgetOutcome
      : (detail?.budgetOutcome && typeof detail.budgetOutcome === "object" ? detail.budgetOutcome : null);
  const executionPolicy =
    run?.executionPolicy && typeof run.executionPolicy === "object"
      ? run.executionPolicy
      : (detail?.executionPolicy && typeof detail.executionPolicy === "object" ? detail.executionPolicy : null);
  const policyOutcome =
    run?.policyOutcome && typeof run.policyOutcome === "object"
      ? run.policyOutcome
      : (detail?.policyOutcome && typeof detail.policyOutcome === "object" ? detail.policyOutcome : null);
  const heartbeatRun =
    run?.heartbeatRun && typeof run.heartbeatRun === "object"
      ? run.heartbeatRun
      : (detail?.heartbeatRun && typeof detail.heartbeatRun === "object" ? detail.heartbeatRun : null);
  const wakeupRequest =
    run?.wakeupRequest && typeof run.wakeupRequest === "object"
      ? run.wakeupRequest
      : (detail?.wakeupRequest && typeof detail.wakeupRequest === "object" ? detail.wakeupRequest : null);
  const approvalPending =
    run?.approvalPending === true
    || detail?.approvalPending === true
    || (
      executionPolicy?.approvalRequired === true
      && (!executionPolicy?.approvalState || executionPolicy.approvalState === "pending")
    )
    || (
      budgetPolicy?.approvalRequired === true
      && ["near_limit", "exceeded"].includes(String(budgetOutcome?.status || "").trim().toLowerCase())
    );
  return {
    goalAncestry,
    primaryGoalId: String(run?.primaryGoalId || detail?.primaryGoalId || "").trim() || null,
    primaryGoalTitle: String(run?.primaryGoalTitle || detail?.primaryGoalTitle || "").trim() || null,
    goalDepth: Number.isFinite(Number(run?.goalDepth ?? detail?.goalDepth)) ? Number(run?.goalDepth ?? detail?.goalDepth) : null,
    budgetPolicy,
    budgetOutcome,
    executionPolicy,
    policyOutcome,
    heartbeatRun,
    wakeupRequest,
    approvalPending,
  };
}

function summarizeLedgerEvent(event) {
  if (!event || typeof event !== "object") return "Unknown event";
  const parts = [String(event.eventType || "event").trim() || "event"];
  if (event.nodeId) parts.push(String(event.nodeId).trim());
  if (event.status) parts.push(`status=${String(event.status).trim()}`);
  if (event.retryMode) parts.push(`mode=${String(event.retryMode).trim()}`);
  if (event.error) parts.push(`error=${String(event.error).trim()}`);
  return parts.join(" · ");
}

function mergeApprovalRequestLists(...sources) {
  const byId = new Map();
  sources.flat().forEach((entry) => {
    if (!entry || typeof entry !== "object") return;
    const requestId = String(entry?.requestId || "").trim();
    if (!requestId) return;
    const existing = byId.get(requestId);
    if (!existing) {
      byId.set(requestId, entry);
      return;
    }
    const existingAt = Date.parse(String(existing?.updatedAt || existing?.requestedAt || 0));
    const nextAt = Date.parse(String(entry?.updatedAt || entry?.requestedAt || 0));
    if (!Number.isFinite(existingAt) || nextAt >= existingAt) {
      byId.set(requestId, { ...existing, ...entry });
    }
  });
  return Array.from(byId.values()).sort((left, right) =>
    String(right?.updatedAt || right?.requestedAt || "").localeCompare(
      String(left?.updatedAt || left?.requestedAt || ""),
    ));
}

function normalizeApprovalScopeType(value) {
  return String(value || "").trim().toLowerCase() || "other";
}

function getApprovalScopeLabel(scopeType) {
  const normalized = normalizeApprovalScopeType(scopeType);
  if (normalized === "workflow-run") return "Workflow Runs";
  if (normalized === "workflow-gate") return "Workflow Gates";
  if (normalized === "workflow-action") return "Workflow Actions";
  if (normalized === "harness-run") return "Harness Runs";
  return "Other";
}

function getApprovalScopeBadgeStyles(scopeType) {
  const normalized = normalizeApprovalScopeType(scopeType);
  if (normalized === "workflow-run") {
    return { background: "#3b82f624", color: "#93c5fd" };
  }
  if (normalized === "workflow-gate") {
    return { background: "#f59e0b24", color: "#fbbf24" };
  }
  if (normalized === "workflow-action") {
    return { background: "#8b5cf624", color: "#c4b5fd" };
  }
  if (normalized === "harness-run") {
    return { background: "#14b8a624", color: "#99f6e4" };
  }
  return { background: "#47556924", color: "#cbd5e1" };
}

function summarizeProofBundleEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  const label = String(entry.label || entry.kind || "").trim();
  const summary = String(entry.summary || "").trim();
  const path = String(entry.path || "").trim();
  if (label) parts.push(label);
  if (summary && summary !== label) parts.push(summary);
  if (path) parts.push(path);
  return parts.join(" · ");
}

function summarizePlannerTimelineEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  const step = String(
    entry.currentPlanStep?.stepLabel
    || entry.stepResult?.stepLabel
    || entry.plan?.stepLabel
    || entry.stepLabel
    || entry.nodeLabel
    || entry.nodeId
    || "",
  ).trim();
  const summary = String(entry.summary || entry.reason || entry.error || "").trim();
  const attachmentKind = String(entry.stepResult?.attachmentKind || entry.attachmentKind || "").trim();
  if (step) parts.push(step);
  if (summary) parts.push(summary);
  if (attachmentKind) parts.push(attachmentKind.replaceAll("_", " "));
  return parts.join(" · ");
}

function summarizeWorkflowAuditWorkflowEvent(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  const eventType = String(entry.eventType || "workflow.event").trim();
  const label = String(
    entry.summary
    || entry.executionLabel
    || entry.nodeLabel
    || entry.toolName
    || entry.nodeId
    || entry.executionId
    || "",
  ).trim();
  const status = String(entry.status || "").trim();
  const childRunId = String(entry.childRunId || "").trim();
  const reason = String(entry.reason || entry.error || "").trim();
  if (eventType) parts.push(eventType);
  if (label && label !== eventType) parts.push(label);
  if (status) parts.push(status);
  if (childRunId) parts.push(`child ${childRunId}`);
  if (reason) parts.push(reason);
  return parts.join(" · ");
}

function summarizeWorkflowAuditToolCall(call) {
  if (!call || typeof call !== "object") return "";
  const parts = [];
  const label = String(call.summary || call.toolName || call.toolId || call.callId || "tool call").trim();
  const status = String(call.status || "").trim();
  const provider = String(call.provider || "").trim();
  const serverId = String(call.serverId || "").trim();
  const nodeId = String(call.nodeId || "").trim();
  const durationMs = Number(call.durationMs || 0);
  if (label) parts.push(label);
  if (status && status !== label) parts.push(status);
  if (provider) parts.push(provider);
  else if (serverId) parts.push(`server ${serverId}`);
  if (nodeId) parts.push(`node ${nodeId}`);
  if (Number.isFinite(durationMs) && durationMs > 0) parts.push(formatDuration(durationMs));
  return parts.join(" · ");
}

function summarizeWorkflowAuditArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return "";
  const parts = [];
  const label = String(artifact.summary || artifact.path || artifact.kind || artifact.artifactId || "artifact").trim();
  const kind = String(artifact.kind || "").trim();
  const nodeId = String(artifact.nodeId || "").trim();
  const sessionId = String(artifact.sessionId || "").trim();
  if (label) parts.push(label);
  if (kind && kind !== label) parts.push(kind);
  if (nodeId) parts.push(`node ${nodeId}`);
  if (sessionId) parts.push(`session ${sessionId}`);
  return parts.join(" · ");
}

function summarizeWorkflowAuditOperatorAction(action) {
  if (!action || typeof action !== "object") return "";
  const parts = [];
  const actionType = String(action.actionType || action.eventType || "operator.action").trim();
  const actorId = String(action.actorId || "").trim();
  const targetId = String(action.targetId || "").trim();
  const status = String(action.status || "").trim();
  const summary = String(
    action.metadata?.summary
    || action.result?.summary
    || action.request?.summary
    || "",
  ).trim();
  if (actionType) parts.push(actionType.replaceAll("_", " "));
  if (actorId) parts.push(`by ${actorId}`);
  if (targetId) parts.push(`target ${targetId}`);
  if (status) parts.push(status);
  if (summary) parts.push(summary);
  return parts.join(" · ");
}

function summarizeWorkflowAuditClaimEvent(event) {
  if (!event || typeof event !== "object") return "";
  const parts = [];
  const action = String(event.action || event.status || event.eventType || "claim").trim();
  const instanceId = String(event.instanceId || event.instance_id || "").trim();
  const claimToken = String(event.claimToken || event.claim_token || "").trim();
  const summary = String(event.summary || "").trim();
  if (action) parts.push(action.replaceAll("_", " "));
  if (instanceId) parts.push(`by ${instanceId}`);
  if (claimToken) parts.push(`token ${claimToken}`);
  if (summary) parts.push(summary);
  return parts.join(" · ");
}

function summarizeWorkflowAuditPromotedStrategyEvent(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  const label = String(entry.recommendation || entry.decision || entry.strategyId || "strategy").trim();
  const status = String(entry.status || "").trim();
  const verificationStatus = String(entry.verificationStatus || "").trim();
  const confidence = Number.isFinite(Number(entry.confidence)) ? Number(entry.confidence) : null;
  const rationale = String(entry.rationale || "").trim();
  if (label) parts.push(label);
  if (status) parts.push(status);
  if (verificationStatus) parts.push(verificationStatus);
  if (confidence != null) parts.push(`confidence ${confidence}`);
  if (rationale) parts.push(rationale);
  return parts.join(" · ");
}

function summarizeWorkflowTeamTaskEntry(task) {
  if (!task || typeof task !== "object") return "";
  const parts = [];
  const title = String(task.title || task.taskId || "task").trim();
  const status = String(task.status || "").trim();
  const claimedBy = String(task.claimedBy || "").trim();
  const completedBy = String(task.completedBy || "").trim();
  if (title) parts.push(title);
  if (status) parts.push(status);
  if (completedBy) parts.push(`done by ${completedBy}`);
  else if (claimedBy) parts.push(`claimed by ${claimedBy}`);
  return parts.join(" · ");
}

function summarizeWorkflowTeamMessageEntry(message) {
  if (!message || typeof message !== "object") return "";
  const parts = [];
  const fromMemberId = String(message.fromMemberId || "member").trim();
  const kind = String(message.kind || "message").trim();
  const channelId = String(message.channelId || "").trim();
  const recipients = Array.isArray(message.toMemberIds)
    ? message.toMemberIds.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const content = String(message.content || "").trim();
  parts.push(fromMemberId);
  if (kind === "direct" && recipients.length > 0) {
    parts.push(`to ${recipients.join(", ")}`);
  } else if (channelId) {
    parts.push(`#${channelId}`);
  } else {
    parts.push(kind);
  }
  if (content) parts.push(content.length > 120 ? `${content.slice(0, 117)}…` : content);
  return parts.join(" · ");
}

function toRunGraphTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRunGraphByTime(left, right) {
  const delta =
    toRunGraphTimestamp(left?.startedAt || left?.endedAt || left?.updatedAt)
    - toRunGraphTimestamp(right?.startedAt || right?.endedAt || right?.updatedAt);
  if (delta !== 0) return delta;
  return String(left?.runId || left?.executionId || "").localeCompare(String(right?.runId || right?.executionId || ""));
}

function formatRunGraphRunKind(kind) {
  const normalized = String(kind || "").trim().toLowerCase();
  if (!normalized) return "run";
  return normalized.replaceAll("_", " ");
}

function formatRunGraphExecutionLabel(entry) {
  if (!entry || typeof entry !== "object") return "execution";
  return String(
    entry.executionLabel
    || entry.nodeLabel
    || entry.toolName
    || entry.nodeId
    || entry.executionKind
    || entry.executionId
    || "execution",
  ).trim();
}

function summarizeRunGraphTimelineEvent(entry) {
  if (!entry || typeof entry !== "object") return "workflow event";
  const parts = [];
  const eventType = String(entry.eventType || "event").trim();
  const label = String(entry.nodeLabel || entry.toolName || entry.nodeId || "").trim();
  const status = String(entry.status || "").trim();
  const childRunId = String(entry.childRunId || "").trim();
  const error = String(entry.error || "").trim();
  parts.push(eventType || "event");
  if (label) parts.push(label);
  if (status) parts.push(`status=${status}`);
  if (childRunId) parts.push(`child=${childRunId}`);
  if (error) parts.push(`error=${error}`);
  return parts.join(" · ");
}

function buildRunGraphStats(runGraph) {
  const runs = Array.isArray(runGraph?.runs) ? runGraph.runs : [];
  const executions = Array.isArray(runGraph?.executions) ? runGraph.executions : [];
  const timeline = Array.isArray(runGraph?.timeline) ? runGraph.timeline : [];
  const edges = Array.isArray(runGraph?.edges) ? runGraph.edges : [];
  return {
    runCount: runs.length,
    executionCount: executions.length,
    timelineCount: timeline.length,
    edgeCount: edges.length,
    retryEdgeCount: edges.filter((entry) => entry?.type === "retry").length,
    causalEdgeCount: edges.filter((entry) => entry?.type === "causal").length,
    executionEdgeCount: edges.filter((entry) => entry?.type === "execution").length,
    executionRunEdgeCount: edges.filter((entry) => entry?.type === "execution-run").length,
  };
}

function buildRunGraphLineageRows(runGraph, requestedRunId = "") {
  const runs = Array.isArray(runGraph?.runs) ? runGraph.runs : [];
  if (runs.length === 0) return [];
  const runMap = new Map(
    runs.map((entry) => [
      entry.runId,
      {
        ...entry,
        children: [],
      },
    ]),
  );
  for (const entry of runMap.values()) {
    const parent = entry.parentRunId ? runMap.get(entry.parentRunId) : null;
    if (parent) parent.children.push(entry);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (entry, depth = 0) => {
    if (!entry || seen.has(entry.runId)) return;
    seen.add(entry.runId);
    entry.children.sort(compareRunGraphByTime);
    ordered.push({
      ...entry,
      depth,
      isRequested: entry.runId === requestedRunId,
    });
    for (const child of entry.children) {
      visit(child, depth + 1);
    }
  };
  const roots = Array.from(runMap.values())
    .filter((entry) => !entry.parentRunId || !runMap.has(entry.parentRunId))
    .sort(compareRunGraphByTime);
  for (const root of roots) visit(root, 0);
  const remaining = Array.from(runMap.values())
    .filter((entry) => !seen.has(entry.runId))
    .sort(compareRunGraphByTime);
  for (const entry of remaining) visit(entry, 0);
  return ordered;
}

function buildRunGraphExecutionRows(runGraph) {
  const executions = Array.isArray(runGraph?.executions) ? runGraph.executions.slice() : [];
  executions.sort(compareRunGraphByTime);
  return executions;
}

function summarizeRunExecutionInsights(run, limit = 12) {
  const issueAdvisor =
    run?.detail?.issueAdvisor && typeof run.detail.issueAdvisor === "object"
      ? run.detail.issueAdvisor
      : null;
  const counts = getRunDagCounts(run);
  const ledgerEvents = Array.isArray(run?.ledger?.events) ? run.ledger.events : [];
  const lines = [
    `- Completed nodes: ${counts.completed}/${counts.nodeCount}`,
    `- Failed nodes: ${counts.failed}`,
    `- Skipped nodes: ${counts.skipped}`,
    `- Active nodes: ${counts.active}`,
    `- Root run: ${String(run?.rootRunId || run?.detail?.dagState?.rootRunId || "—")}`,
    `- Parent run: ${String(run?.parentRunId || run?.detail?.dagState?.parentRunId || "—")}`,
    `- Retry of: ${String(run?.retryOf || run?.detail?.dagState?.retryOf || "—")}`,
    `- Retry mode: ${formatRetryModeLabel(run?.retryMode || run?.detail?.dagState?.retryMode || "")}`,
    `- Retry decision: ${formatRetryDecisionReason(run?.retryDecisionReason)}`,
    `- Issue advisor action: ${formatIssueAdvisorAction(issueAdvisor?.recommendedAction)}`,
    `- Issue advisor summary: ${String(issueAdvisor?.summary || "None recorded.")}`,
  ];
  if (ledgerEvents.length) {
    lines.push("");
    lines.push("Recent Ledger Events");
    const recent = ledgerEvents.slice(-limit);
    for (const entry of recent) {
      lines.push(`- ${entry?.timestamp ? formatDate(entry.timestamp) : "unknown time"} · ${summarizeLedgerEvent(entry)}`);
    }
  }
  return lines.join("\n");
}

function buildWorkflowExplainPrompt(workflow) {
  const workflowId = String(workflow?.id || "").trim() || "(unknown)";
  const workflowName = String(workflow?.name || workflowId).trim() || workflowId;
  const description = String(workflow?.description || "").trim() || "None provided.";
  const variables = workflow?.variables && typeof workflow.variables === "object"
    ? workflow.variables
    : {};
  return [
    "You are helping inside Bosun with a workflow authoring review.",
    "Explain this workflow in plain English, identify the riskiest nodes or missing guardrails, and suggest the smallest high-leverage improvements.",
    "",
    "Return:",
    "1. A concise summary of what the workflow is trying to do",
    "2. The critical nodes or transitions that matter most",
    "3. Failure risks, ambiguity, or missing validation/retry/observability",
    "4. Concrete next edits Bosun should make",
    "",
    "Workflow Context",
    `- Name: ${workflowName}`,
    `- ID: ${workflowId}`,
    `- Enabled: ${workflow?.enabled === false ? "no" : "yes"}`,
    `- Core workflow: ${workflow?.core === true ? "yes" : "no"}`,
    `- Description: ${description}`,
    `- Node count: ${Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0}`,
    `- Edge count: ${Array.isArray(workflow?.edges) ? workflow.edges.length : 0}`,
    "",
    "Variables",
    formatWorkflowCopilotBlock(variables, 2500),
    "",
    "Node Summary",
    summarizeWorkflowNodes(workflow),
    "",
    "Edge Summary",
    summarizeWorkflowEdges(workflow),
    "",
    "Raw Workflow Snapshot",
    formatWorkflowCopilotBlock({
      id: workflow?.id,
      name: workflow?.name,
      description: workflow?.description,
      enabled: workflow?.enabled,
      core: workflow?.core,
      metadata: workflow?.metadata || {},
    }, 2500),
  ].join("\n");
}

function buildWorkflowNodePrompt(workflow, node, nodeTypeMap = new Map()) {
  if (!node) return "";
  const workflowId = String(workflow?.id || "").trim() || "(unknown)";
  const workflowName = String(workflow?.name || workflowId).trim() || workflowId;
  const nodeType = String(node?.type || "unknown").trim() || "unknown";
  const typeInfo = nodeTypeMap.get(nodeType) || null;
  const schemaKeys = Object.keys(typeInfo?.schema?.properties || {});
  return [
    "You are helping inside Bosun with workflow node authoring.",
    "Explain what this node does, how it interacts with adjacent nodes, what is risky or underspecified, and which exact config edits Bosun should make next.",
    "",
    "Return:",
    "1. Node purpose",
    "2. Upstream/downstream interaction notes",
    "3. Risks, missing validation, or bad defaults",
    "4. Concrete config or graph edits",
    "",
    "Workflow Context",
    `- Workflow: ${workflowName}`,
    `- Workflow ID: ${workflowId}`,
    `- Node count: ${Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0}`,
    `- Edge count: ${Array.isArray(workflow?.edges) ? workflow.edges.length : 0}`,
    "",
    "Node Context",
    `- Node ID: ${String(node?.id || "").trim() || "(unknown)"}`,
    `- Label: ${String(node?.label || node?.name || "").trim() || "(none)"}`,
    `- Type: ${nodeType}`,
    `- Category: ${nodeType.split(".")[0] || "unknown"}`,
    `- Description: ${String(typeInfo?.description || "").trim() || "None provided."}`,
    `- Schema keys: ${schemaKeys.length ? schemaKeys.join(", ") : "None"}`,
    "",
    "Upstream Edges",
    summarizeWorkflowNodeLinks(workflow, node?.id, "incoming"),
    "",
    "Downstream Edges",
    summarizeWorkflowNodeLinks(workflow, node?.id, "outgoing"),
    "",
    "Node Config",
    formatWorkflowCopilotBlock(node?.config || {}, 3500),
    "",
    "Raw Node Snapshot",
    formatWorkflowCopilotBlock(node, 3500),
  ].join("\n");
}

function buildRunCopilotPrompt(run, intent = "ask") {
  const workflowName = String(run?.workflowName || getWorkflowNameById(run?.workflowId) || run?.workflowId || "Unknown Workflow").trim();
  const status = String(run?.status || "unknown").trim() || "unknown";
  const errors = Array.isArray(run?.detail?.errors) ? run.detail.errors : [];
  const logs = Array.isArray(run?.detail?.logs) ? run.detail.logs : [];
  const failed = intent === "fix" || status === "failed";
  const request = failed
    ? "Analyze why this workflow run failed. Identify the root cause, name the most likely failing node or nodes, propose the smallest concrete fix, and say whether Bosun should retry from failed state or rerun from the beginning."
    : "Explain what happened in this workflow run, call out unusual or risky behavior, and suggest the next debugging or hardening steps.";
  return [
    "You are helping inside Bosun with workflow run analysis.",
    request,
    "",
    "Return:",
    "1. Short diagnosis",
    "2. Evidence from the run",
    failed ? "3. Concrete fix plan" : "3. Recommended next steps",
    failed ? "4. Retry advice: retry from failed, rerun from start, or do not retry yet" : "4. Risks or follow-up checks",
    "",
    "Run Context",
    `- Workflow: ${workflowName}`,
    `- Workflow ID: ${String(run?.workflowId || "").trim() || "(unknown)"}`,
    `- Run ID: ${String(run?.runId || "").trim() || "(unknown)"}`,
    `- Status: ${status}`,
    `- Started: ${formatDate(run?.startedAt)}`,
    `- Finished: ${run?.endedAt ? formatDate(run.endedAt) : "Running"}`,
    `- Duration: ${formatDuration(run?.duration)}`,
    `- Active nodes: ${Number(run?.activeNodeCount || 0)}`,
    `- Error count: ${Number(run?.errorCount || errors.length)}`,
    `- Log count: ${Number(run?.logCount || logs.length)}`,
    "",
    "Execution Insights",
    summarizeRunExecutionInsights(run, 10),
    "",
    "Node Statuses",
    summarizeRunNodeStatuses(run),
    "",
    "Node Output Summaries",
    summarizeRunNodeOutputs(run),
    "",
    "Errors",
    formatWorkflowCopilotBlock(errors.slice(0, 8), 3500),
    "",
    "Recent Logs",
    formatWorkflowCopilotBlock(logs.slice(-40), 4000),
  ].join("\n");
}

function buildRunNodeCopilotPrompt(run, nodeId, opts = {}) {
  const safeNodeId = String(nodeId || "").trim();
  if (!safeNodeId) return "";
  const workflow = opts?.workflow || null;
  const node = Array.isArray(workflow?.nodes)
    ? workflow.nodes.find((entry) => String(entry?.id || "").trim() === safeNodeId) || null
    : null;
  const nodeStatuses = buildNodeStatusesFromRunDetail(run);
  const nodeOutputs = run?.detail?.nodeOutputs && typeof run.detail.nodeOutputs === "object"
    ? run.detail.nodeOutputs
    : {};
  const errors = Array.isArray(run?.detail?.errors) ? run.detail.errors : [];
  const relatedErrors = errors.filter((entry) => formatWorkflowCopilotBlock(entry, 500).includes(safeNodeId));
  const failed = String(opts?.intent || "").trim().toLowerCase() === "fix"
    || String(nodeStatuses[safeNodeId] || "").trim().toLowerCase() === "failed";
  return [
    "You are helping inside Bosun with workflow run node analysis.",
    failed
      ? "Diagnose why this node failed or behaved incorrectly, identify the root cause, and propose the smallest concrete fix Bosun should make."
      : "Explain what happened in this node during the run, what inputs or outputs matter, and what Bosun should inspect next.",
    "",
    "Return:",
    "1. Short diagnosis",
    "2. Evidence from this node",
    failed ? "3. Concrete fix plan" : "3. Recommended next checks",
    failed ? "4. Retry advice for this node or run" : "4. Risks or follow-up notes",
    "",
    "Run Context",
    `- Workflow ID: ${String(run?.workflowId || workflow?.id || "").trim() || "(unknown)"}`,
    `- Run ID: ${String(run?.runId || "").trim() || "(unknown)"}`,
    `- Run status: ${String(run?.status || "unknown").trim() || "unknown"}`,
    `- Started: ${formatDate(run?.startedAt)}`,
    `- Finished: ${run?.endedAt ? formatDate(run.endedAt) : "Running"}`,
    "",
    "Node Context",
    `- Node ID: ${safeNodeId}`,
    `- Node label: ${String(node?.label || node?.name || "").trim() || "(none)"}`,
    `- Node type: ${String(node?.type || "").trim() || "(unknown)"}`,
    `- Node status: ${String(nodeStatuses[safeNodeId] || "unknown").trim() || "unknown"}`,
    "",
    "Node Config",
    formatWorkflowCopilotBlock(node?.config || {}, 2500),
    "",
    "Node Output",
    formatWorkflowCopilotBlock(nodeOutputs[safeNodeId] ?? null, 3500),
    "",
    "Node Errors",
    formatWorkflowCopilotBlock(relatedErrors.length ? relatedErrors : errors.slice(0, 8), 3000),
  ].join("\n");
}

async function fetchWorkflowCopilotPrompt(endpoint, fetchOptions = {}) {
  const safeEndpoint = String(endpoint || "").trim();
  if (!safeEndpoint) return null;
  try {
    const data = await apiFetch(safeEndpoint, fetchOptions);
    const prompt = String(data?.prompt || "").trim();
    return prompt || null;
  } catch {
    return null;
  }
}

async function startWorkflowCopilotSession({
  endpoint = "",
  fetchOptions = {},
  fallbackPrompt = "",
  title = "",
  successToast = "",
} = {}) {
  const prompt = await fetchWorkflowCopilotPrompt(endpoint, fetchOptions) || String(fallbackPrompt || "").trim();
  return openWorkflowCopilotChat(prompt, { title, successToast });
}

async function openWorkflowCopilotChat(prompt, opts = {}) {
  const content = String(prompt || "").trim();
  if (!content) {
    showToast("Workflow copilot prompt was empty", "error");
    return null;
  }
  const successToast = String(opts?.successToast || "Opened workflow copilot chat").trim();
  try {
    const created = await createSession({
      type: "primary",
      reuseFresh: false,
      ...(opts?.title ? { title: String(opts.title) } : {}),
    });
    const session = created?.session || null;
    const sessionId = String(session?.id || "").trim();
    if (!sessionId) throw new Error("Session creation failed");
    const messagePath = buildSessionApiPath(sessionId, "message", {
      workspace: resolveSessionWorkspaceHint(session, "active"),
    });
    if (!messagePath) throw new Error("Session path unavailable");
    await apiFetch(messagePath, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    const navigated = navigateTo("chat", {
      params: { sessionId },
      forceRefresh: true,
    });
    if (!navigated) {
      showToast("Workflow copilot session started. Open Chat after resolving unsaved changes.", "info");
      return sessionId;
    }
    showToast(successToast, "success");
    return sessionId;
  } catch (err) {
    showToast(`Failed to start workflow copilot: ${err.message || "Unknown error"}`, "error");
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function loadWorkflows() {
  workflowsLoading.value = true;
  try {
    const data = await apiFetch("/api/workflows");
    if (data?.workflows) workflows.value = data.workflows;
  } catch (err) {
    console.error("[workflows] Failed to load:", err);
  } finally {
    workflowsLoading.value = false;
  }
}

async function loadTemplates() {
  templatesLoading.value = true;
  try {
    const data = await apiFetch("/api/workflows/templates");
    if (data?.templates) templates.value = data.templates;
  } catch (err) {
    console.error("[workflows] Failed to load templates:", err);
  } finally {
    templatesLoading.value = false;
  }
}

async function loadNodeTypes() {
  nodeTypesLoading.value = true;
  try {
    const data = await apiFetch("/api/workflows/node-types");
    if (data?.nodeTypes) nodeTypes.value = data.nodeTypes;
  } catch (err) {
    console.error("[workflows] Failed to load node types:", err);
  } finally {
    nodeTypesLoading.value = false;
  }
}

async function saveWorkflow(def, options = {}) {
  const activate = options?.activate !== false;
  const toastMessage = options?.toastMessage ?? "Workflow saved";
  const suppressToast = options?.suppressToast === true;
  try {
    const data = await apiFetch("/api/workflows/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    if (data?.workflow) {
      if (activate) {
        activeWorkflow.value = data.workflow;
        setRouteParams({ workflowId: data.workflow.id }, { replace: true, skipGuard: true });
      }
      if (!suppressToast) showToast(toastMessage, "success");
      loadWorkflows();
    }
    return data?.workflow;
  } catch (err) {
    if (!suppressToast) showToast(`Failed to save workflow: ${err?.message || err}`, "error");
  }
}

async function exportWorkflow(workflow) {
  if (!workflow) return;
  try {
    const content = JSON.stringify({
      ...workflow,
      metadata: {
        ...(workflow?.metadata || {}),
        flowchart: buildDraftFlowchartMetadata(workflow),
      },
    }, null, 2);
    try {
      await navigator?.clipboard?.writeText(content);
      showToast("Workflow JSON copied to clipboard", "success");
    } catch {}

    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflow.name || workflow.id || "workflow"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast("Export failed: " + (err.message || err), "error");
  }
}

async function deleteWorkflow(id) {
  try {
    await apiFetch(`/api/workflows/${id}`, { method: "DELETE" });
    showToast("Workflow deleted", "success");
    if (activeWorkflow.value?.id === id) {
      activeWorkflow.value = null;
      viewMode.value = "list";
      setRouteParams({}, { replace: true, skipGuard: true });
    }
    loadWorkflows();
  } catch (err) {
    showToast("Failed to delete workflow", "error");
  }
}

async function executeWorkflow(id, customVars = {}) {
  try {
    const payload = { dispatch: true, ...customVars };
    // Thread _targetRepo into the execution input if set
    if (customVars._targetRepo) {
      payload._targetRepo = customVars._targetRepo;
    }
    // Support waitForCompletion override
    if (customVars.waitForCompletion === true) {
      payload.dispatch = false;
      payload.waitForCompletion = true;
    }
    const data = await apiFetch(`/api/workflows/${id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    showToast("Workflow dispatched", "success");
    setTimeout(() => {
      loadRuns(id).catch(() => {});
    }, 600);
    return data;
  } catch (err) {
    showToast("Failed to execute workflow", "error");
  }
}

/**
 * Open the Execute Dialog for a workflow — fetches its full definition,
 * reads its variables, and shows a form that lets users customize before launch.
 * Also fetches workspace repos so users can target a specific repo.
 */
async function openExecuteDialog(workflowId) {
  try {
    const [detail, reposData] = await Promise.all([
      apiFetch(`/api/workflows/${workflowId}`),
      apiFetch("/api/workspaces/active/repos").catch(() => null),
    ]);
    const wf = detail?.workflow;
    if (!wf) { showToast("Workflow not found", "error"); return; }
    executeDialogWorkflow.value = wf;
    const vars = cloneVars(wf.variables);
    executeDialogVars.value = vars;
    executeDialogResult.value = null;
    executeDialogLaunching.value = false;
    executeDialogWaitSync.value = false;

    // Extract repos from active workspace
    const repos = Array.isArray(reposData?.repos) ? reposData.repos : [];
    executeDialogRepos.value = repos;
    // Pre-select primary repo or first repo
    const primary = repos.find((r) => r.primary);
    executeDialogTargetRepo.value = primary?.name || repos[0]?.name || "";

    const requiredCount = Object.values(vars).filter((v) => v === "" || v == null).length;
    executeDialogMode.value = requiredCount > 0 ? "quick" : "advanced";
    executeDialogOpen.value = true;
  } catch (err) {
    showToast("Failed to load workflow", "error");
  }
}

function closeExecuteDialog() {
  executeDialogOpen.value = false;
  executeDialogWorkflow.value = null;
  executeDialogVars.value = {};
  executeDialogResult.value = null;
  executeDialogLaunching.value = false;
  executeDialogMode.value = "quick";
  executeDialogRepos.value = [];
  executeDialogTargetRepo.value = "";
  executeDialogWaitSync.value = false;
}

async function launchFromDialog() {
  const wf = executeDialogWorkflow.value;
  if (!wf) return;
  executeDialogLaunching.value = true;
  executeDialogResult.value = null;
  try {
    const rawVars = executeDialogVars.value || {};
    const payload = {};
    for (const [key, val] of Object.entries(rawVars)) {
      if (typeof val === "string") {
        const trimmed = val.trim();
        if (
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
          try {
            payload[key] = JSON.parse(trimmed);
            continue;
          } catch {
            // keep as string when parsing fails; dialog validation already blocks obvious JSON errors
          }
        }
      }
      payload[key] = val;
    }
    const data = await executeWorkflow(wf.id, {
      ...payload,
      _targetRepo: executeDialogTargetRepo.value || undefined,
      waitForCompletion: executeDialogWaitSync.value || undefined,
    });
    executeDialogResult.value = { ok: true, ...data };
    setTimeout(() => closeExecuteDialog(), 1200);
  } catch (err) {
    executeDialogResult.value = { ok: false, error: err.message };
  } finally {
    executeDialogLaunching.value = false;
  }
}

/** Convert camelCase / snake_case key to "Human Label" */
function humanizeVarKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Infer a short helper text for a variable key */
function inferVarHelp(key, value) {
  const k = key.toLowerCase();
  if (k.includes("testcommand") || k.includes("test_command") || k === "testframework" || k === "test_framework") return "Test command for your project — select from presets or enter custom";
  if (k.includes("buildcommand") || k.includes("build_command")) return "Build command for your project — select from presets or enter custom";
  if (k.includes("lintcommand") || k.includes("lint_command") || k.includes("lintcmd")) return "Lint/style check command — select from presets or enter custom";
  if (k.includes("syntaxcheck") || k.includes("syntax_check")) return "Syntax/compile check command — select from presets or enter custom";
  if (k === "basebranch" || k === "base_branch" || k === "defaultbasebranch") return "Base branch for PRs — select from common options or enter custom";
  if (k.includes("timeout") || k.includes("delay") || k.includes("cooldown")) return "Duration in milliseconds";
  if (k.includes("branch")) return "Git branch name";
  if (k.includes("url") || k.includes("endpoint")) return "URL / endpoint";
  if (k.includes("path") || k.includes("dir")) return "File system path";
  if (k.includes("max") || k.includes("min") || k.includes("limit") || k.includes("count")) return "Numeric limit";
  if (k.includes("enabled") || k.includes("skip") || k.includes("force") || k.includes("dry")) return "Toggle on/off";
  if (k.includes("problem") || k.includes("prompt") || k.includes("query") || k.includes("description")) return "Free-form text";
  if (typeof value === "boolean") return "Toggle on/off";
  if (typeof value === "number") return "Numeric value";
  return "";
}

function inferVarOptions(key, value) {
  const k = String(key || "").toLowerCase();
  const options = [];

  if (k.includes("executor") || k.includes("sdk")) {
    options.push("auto", "codex", "claude", "copilot");
  } else if (k.includes("bumptype") || k.includes("bump_type")) {
    options.push("patch", "minor", "major");
  } else if (k.includes("testcommand") || k.includes("test_command") || k === "testframework" || k === "test_framework") {
    options.push("npm test", "yarn test", "pnpm test", "pytest", "poetry run pytest", "go test ./...", "cargo test", "mvn test", "./gradlew test", "dotnet test", "bundle exec rspec", "make test");
  } else if (k.includes("buildcommand") || k.includes("build_command")) {
    options.push("npm run build", "yarn build", "pnpm build", "go build ./...", "cargo build", "mvn package -DskipTests", "./gradlew build", "dotnet build", "python -m build", "make");
  } else if (k.includes("lintcommand") || k.includes("lint_command") || k.includes("lintcmd")) {
    options.push("npm run lint", "npx eslint .", "ruff check .", "golangci-lint run", "cargo clippy -- -D warnings", "dotnet format --verify-no-changes", "bundle exec rubocop");
  } else if (k.includes("syntaxcheck") || k.includes("syntax_check")) {
    options.push("node --check", "npx tsc --noEmit", "python -m py_compile", "go vet ./...", "cargo check", "dotnet build --no-restore");
  } else if (k === "basebranch" || k === "base_branch" || k === "defaultbasebranch" || k === "targetbranch") {
    options.push("main", "master", "develop", "staging");
  }

  // Keep typed value when this field has known preset options.
  if (options.length > 0 && typeof value === "string" && value.trim()) {
    options.unshift(value.trim());
  }
  const deduped = [];
  const seen = new Set();
  for (const opt of options) {
    const keyText = String(opt);
    if (seen.has(keyText)) continue;
    seen.add(keyText);
    deduped.push({ value: opt, label: String(opt) });
  }
  return deduped;
}

function inferVarInputKind(key, value) {
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  if (Array.isArray(value) || (value && typeof value === "object")) return "json";
  if (inferVarOptions(key, value).length > 0) return "select";
  return "text";
}

function isLongTextVar(key, value) {
  const k = String(key || "").toLowerCase();
  return (
    k.includes("prompt") ||
    k.includes("problem") ||
    k.includes("description") ||
    k.includes("query") ||
    k.includes("body") ||
    k.includes("content") ||
    k.includes("instructions") ||
    (typeof value === "string" && value.length > 80)
  );
}

function isQuickVarKey(key) {
  const k = String(key || "").toLowerCase();
  return (
    k.includes("task") ||
    k.includes("prompt") ||
    k.includes("problem") ||
    k.includes("message") ||
    k.includes("query") ||
    k.includes("executor") ||
    k.includes("sdk") ||
    k.includes("model") ||
    k.includes("branch") ||
    k.includes("title") ||
    k.includes("testcommand") || k.includes("test_command") ||
    k === "testframework" || k === "test_framework" ||
    k.includes("buildcommand") || k.includes("build_command") ||
    k.includes("lintcommand") || k.includes("lint_command") ||
    k.includes("syntaxcheck") || k.includes("syntax_check")
  );
}

function formatVarPreview(value) {
  if (value == null) return "empty";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "empty";
    return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 42 ? `${json.slice(0, 42)}…` : json;
  } catch {
    return String(value);
  }
}

function isMissingVarValue(raw, inputKind) {
  if (inputKind === "toggle") return false;
  if (raw == null) return true;
  if (typeof raw === "string") return raw.trim() === "";
  if (Array.isArray(raw)) return raw.length === 0;
  return false;
}

/**
 * ExecuteWorkflowDialog — MUI Dialog that lists all workflow variables
 * with editable fields so users can customise before launch.
 */
function ExecuteWorkflowDialog() {
  const open = executeDialogOpen.value;
  const wf = executeDialogWorkflow.value;
  const vars = executeDialogVars.value;
  const launching = executeDialogLaunching.value;
  const result = executeDialogResult.value;
  const mode = executeDialogMode.value;

  if (!open || !wf) return null;

  const entries = Object.entries(vars || {});
  const hasVars = entries.length > 0;

  const descriptors = entries.map(([key, value]) => {
    const inputKind = inferVarInputKind(key, value);
    return {
      key,
      value,
      label: humanizeVarKey(key),
      help: inferVarHelp(key, value),
      required: value === "" || value == null,
      inputKind,
      options: inferVarOptions(key, value),
      quick: isQuickVarKey(key) || value === "" || value == null,
    };
  });

  const required = descriptors.filter((d) => d.required);
  const optional = descriptors.filter((d) => !d.required);
  const quickOptional = optional.filter((d) => d.quick).slice(0, 4);
  const quickKeys = new Set([...required, ...quickOptional].map((d) => d.key));
  const quickFields = descriptors.filter((d) => quickKeys.has(d.key));

  const updateVar = (key, val) => {
    executeDialogVars.value = { ...executeDialogVars.value, [key]: val };
    executeDialogResult.value = null;
  };

  const resetDefaults = () => {
    if (wf.variables) {
      executeDialogVars.value = cloneVars(wf.variables);
    }
    executeDialogMode.value = required.length > 0 ? "quick" : "advanced";
    executeDialogResult.value = null;
  };

  const invalidJsonFields = [];
  const missingRequiredFields = [];
  for (const desc of descriptors) {
    const current = vars?.[desc.key];
    if (desc.required && isMissingVarValue(current, desc.inputKind)) {
      missingRequiredFields.push(desc.label);
    }
    if (desc.inputKind === "json" && !isMissingVarValue(current, desc.inputKind)) {
      try {
        JSON.parse(String(current));
      } catch {
        invalidJsonFields.push(desc.label);
      }
    }
  }
  const canLaunch = !launching && missingRequiredFields.length === 0 && invalidJsonFields.length === 0;

  const renderField = (descriptor) => {
    const { key, value, label, help, inputKind, options, required: isRequired } = descriptor;
    const current = vars?.[key] ?? value;

    if (inputKind === "toggle") {
      return html`
        <${FormControlLabel}
          key=${key}
          control=${html`<${Switch}
            checked=${Boolean(current)}
            onChange=${(e) => updateVar(key, e.target.checked)}
            size="small"
          />`}
          label=${html`<span>${label}${isRequired ? html` <span style="color:#f59e0b">*</span>` : ""}</span>`}
          sx=${{ mb: 1 }}
        />
        ${help && html`<${Typography} variant="caption" sx=${{ color: "text.secondary", display: "block", mt: -0.5, mb: 1, ml: 5.5 }}>${help}<//>`}
      `;
    }

    if (inputKind === "number") {
      return html`
        <${TextField}
          key=${key}
          label=${label + (isRequired ? " *" : "")}
          type="number"
          value=${current ?? ""}
          onChange=${(e) => updateVar(key, e.target.value === "" ? "" : Number(e.target.value))}
          helperText=${help}
          size="small"
          fullWidth
          sx=${{ mb: 1.5 }}
        />
      `;
    }

    if (inputKind === "json") {
      return html`
        <${TextField}
          key=${key}
          label=${label + (isRequired ? " *" : "")}
          value=${current ?? ""}
          onChange=${(e) => updateVar(key, e.target.value)}
          helperText=${help || "JSON object or array"}
          size="small"
          fullWidth
          multiline
          minRows=${3}
          maxRows=${8}
          sx=${{ mb: 1.5, "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.82rem" } }}
        />
      `;
    }

    if (inputKind === "select" && options.length > 0) {
      return html`
        <${FormControl} key=${key} fullWidth size="small" sx=${{ mb: 1.5 }}>
          <${InputLabel}>${label + (isRequired ? " *" : "")}</${InputLabel}>
          <${Select}
            value=${current ?? ""}
            label=${label + (isRequired ? " *" : "")}
            onChange=${(e) => updateVar(key, e.target.value)}
          >
            ${options.map((opt) => html`<${MenuItem} key=${String(opt.value)} value=${opt.value}>${opt.label}</${MenuItem}>`)}
          </${Select}>
          <${Typography} variant="caption" sx=${{ color: "text.secondary", mt: 0.5, ml: 1.5 }}>
            ${help || "Preset options"}.
          </${Typography}>
        </${FormControl}>
      `;
    }

    const multiline = isLongTextVar(key, current);
    return html`
      <${TextField}
        key=${key}
        label=${label + (isRequired ? " *" : "")}
        value=${current ?? ""}
        onChange=${(e) => updateVar(key, e.target.value)}
        helperText=${help}
        size="small"
        fullWidth
        multiline=${multiline}
        minRows=${multiline ? 2 : undefined}
        maxRows=${multiline ? 6 : undefined}
        sx=${{ mb: 1.5 }}
      />
    `;
  };

  return html`
    <${Dialog}
      open=${true}
      onClose=${closeExecuteDialog}
      maxWidth="md"
      fullWidth
      PaperProps=${{ sx: { bgcolor: 'var(--color-bg-secondary, #1a1f2e)', color: 'var(--color-text, #e8eaf0)', borderRadius: '12px' } }}
    >
      <${DialogTitle} sx=${{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <span class="icon-inline">${resolveIcon("play")}</span>
        <span>Execute: ${wf.name}</span>
      <//>

      <${DialogContent} dividers>
        ${wf.description && html`
          <${Typography} variant="body2" sx=${{ color: 'text.secondary', mb: 2 }}>
            ${wf.description}
          <//>
        `}

        ${/* ── Target Repository Selector ── */ ""}
        ${executeDialogRepos.value.length > 1 && html`
          <${FormControl} fullWidth size="small" sx=${{ mb: 2 }}>
            <${InputLabel}>Target Repository</${InputLabel}>
            <${Select}
              value=${executeDialogTargetRepo.value || ""}
              label="Target Repository"
              onChange=${(e) => { executeDialogTargetRepo.value = e.target.value; }}
            >
              ${executeDialogRepos.value.map((repo) => html`
                <${MenuItem} key=${repo.name} value=${repo.name}>
                  <${Stack} direction="row" alignItems="center" spacing=${1}>
                    <span>${repo.name}</span>
                    ${repo.primary && html`<${Chip} label="primary" size="small" sx=${{ height: 18, fontSize: "10px" }} />`}
                  </${Stack}>
                </${MenuItem}>
              `)}
            </${Select}>
            <${Typography} variant="caption" sx=${{ color: "text.secondary", mt: 0.5, ml: 1.5 }}>
              Which repository in this workspace should this workflow target.
            </${Typography}>
          </${FormControl}>
        `}
        ${executeDialogRepos.value.length === 1 && html`
          <${Chip}
            label=${`Repo: ${executeDialogRepos.value[0]?.name || "default"}`}
            size="small"
            variant="outlined"
            sx=${{ mb: 2, fontSize: "11px" }}
          />
        `}

        ${!hasVars && html`
          <${Alert} severity="info" sx=${{ mb: 2 }}>
            This workflow has no configurable variables. It will run with defaults.
          <//>
        `}

        ${hasVars && html`
          <${Tabs}
            value=${mode}
            onChange=${(_e, next) => { executeDialogMode.value = next; }}
            variant="fullWidth"
            sx=${{ mb: 2, minHeight: 38, "& .MuiTab-root": { minHeight: 38, textTransform: "none", fontSize: "0.8rem" } }}
          >
            <${Tab} value="quick" label=${`Quick (${quickFields.length})`} />
            <${Tab} value="advanced" label=${`Advanced (${descriptors.length})`} />
          </${Tabs}>
        `}

        ${missingRequiredFields.length > 0 && html`
          <${Alert} severity="warning" sx=${{ mb: 1.5 }}>
            Missing required fields: ${missingRequiredFields.join(", ")}
          </${Alert}>
        `}
        ${invalidJsonFields.length > 0 && html`
          <${Alert} severity="error" sx=${{ mb: 1.5 }}>
            Invalid JSON in: ${invalidJsonFields.join(", ")}
          </${Alert}>
        `}

        ${mode === "quick" && hasVars && html`
          ${quickFields.map(renderField)}
          ${optional.length > 0 && html`
            <${Divider} sx=${{ my: 1.5 }} />
            <${Typography} variant="subtitle2" sx=${{ mb: 1, fontWeight: 600 }}>
              Optional Defaults <${Chip} label=${String(optional.length)} size="small" sx=${{ ml: 1, height: 20, fontSize: "11px" }} />
            </${Typography}>
            <${Box} sx=${{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
              ${optional.map((item) => html`
                <${Chip}
                  key=${item.key}
                  size="small"
                  variant="outlined"
                  label=${`${item.label}: ${formatVarPreview(vars[item.key])}`}
                  sx=${{ fontSize: "10px" }}
                />
              `)}
            </${Box}>
            <${Button}
              size="small"
              variant="text"
              onClick=${() => { executeDialogMode.value = "advanced"; }}
              sx=${{ mt: 1, textTransform: "none" }}
            >
              Open Advanced Overrides
            </${Button}>
          `}
        `}

        ${mode === "advanced" && hasVars && html`
          ${required.length > 0 && html`
            <${Typography} variant="subtitle2" sx=${{ mb: 1, color: "#f59e0b", fontWeight: 600 }}>
              Required Parameters
            <//>
            ${required.map(renderField)}
            <${Divider} sx=${{ my: 1.5 }} />
          `}

          ${optional.length > 0 && html`
            <${Typography} variant="subtitle2" sx=${{ mb: 1, fontWeight: 600 }}>
              Optional Parameters <${Chip} label=${String(optional.length)} size="small" sx=${{ ml: 1, height: 20, fontSize: "11px" }} />
            </${Typography}>
            ${optional.map(renderField)}
          `}
        `}

        ${hasVars && html`
          <${Box} sx=${{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
            <${Button} size="small" variant="text" onClick=${resetDefaults} sx=${{ textTransform: 'none', fontSize: '12px' }}>
              Reset to Defaults
            <//>
          <//>
        `}

        <${Divider} sx=${{ my: 2 }} />
        <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mb: 1 }}>
          Runtime execution options
        </${Typography}>
        <${FormControlLabel}
          control=${html`<${Switch}
            checked=${!!executeDialogWaitSync.value}
            onChange=${(e) => { executeDialogWaitSync.value = e.target.checked; }}
            size="small"
          />`}
          label="Wait for completion (sync mode)"
          sx=${{ mb: 1 }}
        />

        ${result?.ok && html`
          <${Alert} severity="success" sx=${{ mt: 2 }}>Workflow dispatched successfully!<//>
        `}
        ${result && !result.ok && html`
          <${Alert} severity="error" sx=${{ mt: 2 }}>${result.error || "Launch failed"}<//>
        `}
      <//>

      <${DialogActions} sx=${{ px: 3, py: 2 }}>
        <${Button} onClick=${closeExecuteDialog} sx=${{ textTransform: 'none' }}>Cancel<//>
        <${Button}
          variant="contained"
          onClick=${launchFromDialog}
          disabled=${!canLaunch}
          startIcon=${launching ? html`<${CircularProgress} size=${16} />` : null}
          sx=${{ textTransform: 'none' }}
        >
          ${launching ? "Launching…" : "Launch Workflow"}
        <//>
      <//>
    <//>
  `;
}

function InstallTemplateDialog() {
  const open = installDialogOpen.value;
  const template = installDialogTemplate.value;
  const vars = installDialogVars.value;
  const installing = installDialogInstalling.value;
  const result = installDialogResult.value;

  if (!open || !template) return null;

  const descriptors = (Array.isArray(template.variables) ? template.variables : []).map((variable) => {
    const defaultValue = variable?.defaultValue;
    const inputKind = variable?.input || inferVarInputKind(variable?.key, defaultValue);
    const options = Array.isArray(variable?.options)
      ? variable.options.map((entry) => (
          entry && typeof entry === "object"
            ? { value: entry.value, label: entry.label ?? String(entry.value) }
            : { value: entry, label: String(entry) }
        ))
      : inferVarOptions(variable?.key, defaultValue);
    return {
      key: String(variable?.key || "").trim(),
      label: humanizeVarKey(variable?.key || ""),
      help: variable?.description || inferVarHelp(variable?.key, defaultValue),
      required: variable?.required === true || defaultValue === "" || defaultValue == null,
      inputKind,
      options,
      quick: variable?.required === true || isQuickVarKey(variable?.key),
      defaultValue,
    };
  }).filter((entry) => entry.key);

  const required = descriptors.filter((entry) => entry.required);
  const optional = descriptors.filter((entry) => !entry.required);
  const quickOptional = optional.filter((entry) => entry.quick).slice(0, 4);
  const quickKeys = new Set([...required, ...quickOptional].map((entry) => entry.key));
  const quickFields = descriptors.filter((entry) => quickKeys.has(entry.key));

  const missingRequiredFields = [];
  const invalidJsonFields = [];
  for (const descriptor of descriptors) {
    const current = vars?.[descriptor.key];
    if (descriptor.required && isMissingVarValue(current, descriptor.inputKind)) {
      missingRequiredFields.push(descriptor.label);
    }
    if (descriptor.inputKind === "json" && !isMissingVarValue(current, descriptor.inputKind)) {
      try {
        JSON.parse(String(current));
      } catch {
        invalidJsonFields.push(descriptor.label);
      }
    }
  }
  const canInstall = !installing && missingRequiredFields.length === 0 && invalidJsonFields.length === 0;

  const updateVar = (key, value) => {
    installDialogVars.value = { ...installDialogVars.value, [key]: value };
    installDialogResult.value = null;
  };

  const resetDefaults = () => {
    const defaults = {};
    for (const descriptor of descriptors) {
      defaults[descriptor.key] = descriptor.defaultValue ?? "";
    }
    installDialogVars.value = defaults;
    installDialogMode.value = required.length > 0 ? "quick" : "advanced";
    installDialogResult.value = null;
  };

  const renderField = (descriptor) => {
    const current = vars?.[descriptor.key] ?? descriptor.defaultValue;
    if (descriptor.inputKind === "toggle") {
      return html`
        <${FormControlLabel}
          key=${descriptor.key}
          control=${html`<${Switch}
            checked=${Boolean(current)}
            onChange=${(e) => updateVar(descriptor.key, e.target.checked)}
            size="small"
          />`}
          label=${html`<span>${descriptor.label}${descriptor.required ? html` <span style="color:#f59e0b">*</span>` : ""}</span>`}
          sx=${{ mb: 1 }}
        />
      `;
    }
    if (descriptor.inputKind === "number") {
      return html`
        <${TextField}
          key=${descriptor.key}
          label=${descriptor.label + (descriptor.required ? " *" : "")}
          type="number"
          value=${current ?? ""}
          onChange=${(e) => updateVar(descriptor.key, e.target.value === "" ? "" : Number(e.target.value))}
          helperText=${descriptor.help}
          size="small"
          fullWidth
          sx=${{ mb: 1.5 }}
        />
      `;
    }
    if (descriptor.inputKind === "json") {
      return html`
        <${TextField}
          key=${descriptor.key}
          label=${descriptor.label + (descriptor.required ? " *" : "")}
          value=${current ?? ""}
          onChange=${(e) => updateVar(descriptor.key, e.target.value)}
          helperText=${descriptor.help || "JSON object or array"}
          size="small"
          fullWidth
          multiline
          minRows=${3}
          maxRows=${8}
          sx=${{ mb: 1.5, "& .MuiInputBase-input": { fontFamily: "monospace", fontSize: "0.82rem" } }}
        />
      `;
    }
    if (descriptor.inputKind === "select" && descriptor.options.length > 0) {
      return html`
        <${FormControl} key=${descriptor.key} fullWidth size="small" sx=${{ mb: 1.5 }}>
          <${InputLabel}>${descriptor.label + (descriptor.required ? " *" : "")}</${InputLabel}>
          <${Select}
            value=${current ?? ""}
            label=${descriptor.label + (descriptor.required ? " *" : "")}
            onChange=${(e) => updateVar(descriptor.key, e.target.value)}
          >
            ${descriptor.options.map((opt) => html`<${MenuItem} key=${String(opt.value)} value=${opt.value}>${opt.label}</${MenuItem}>`)}
          </${Select}>
        </${FormControl}>
      `;
    }
    const multiline = isLongTextVar(descriptor.key, current);
    return html`
      <${TextField}
        key=${descriptor.key}
        label=${descriptor.label + (descriptor.required ? " *" : "")}
        value=${current ?? ""}
        onChange=${(e) => updateVar(descriptor.key, e.target.value)}
        helperText=${descriptor.help}
        size="small"
        fullWidth
        multiline=${multiline}
        minRows=${multiline ? 2 : undefined}
        maxRows=${multiline ? 6 : undefined}
        sx=${{ mb: 1.5 }}
      />
    `;
  };

  const handleInstall = async () => {
    if (!canInstall) return;
    installDialogInstalling.value = true;
    installDialogResult.value = null;
    try {
      const overrides = {};
      for (const descriptor of descriptors) {
        const current = installDialogVars.value?.[descriptor.key];
        if (descriptor.inputKind === "json") {
          if (isMissingVarValue(current, descriptor.inputKind)) continue;
          overrides[descriptor.key] = JSON.parse(String(current));
          continue;
        }
        if (descriptor.inputKind === "number") {
          if (current === "" || current == null) continue;
          overrides[descriptor.key] = Number(current);
          continue;
        }
        if (descriptor.inputKind === "toggle") {
          overrides[descriptor.key] = !!current;
          continue;
        }
        if (current === undefined) continue;
        overrides[descriptor.key] = current;
      }
      const workflow = await installTemplate(template.id, overrides);
      if (workflow) {
        closeInstallTemplateDialog();
        return;
      }
      installDialogResult.value = { ok: false, error: "Install failed" };
    } catch (err) {
      installDialogResult.value = { ok: false, error: err.message || "Install failed" };
    } finally {
      installDialogInstalling.value = false;
    }
  };

  return html`
    <${Dialog}
      open=${true}
      onClose=${closeInstallTemplateDialog}
      maxWidth="md"
      fullWidth
      PaperProps=${{ sx: { bgcolor: 'var(--color-bg-secondary, #1a1f2e)', color: 'var(--color-text, #e8eaf0)', borderRadius: '12px' } }}
    >
      <${DialogTitle} sx=${{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <span class="icon-inline">${resolveIcon("download")}</span>
        <span>Install: ${template.name}</span>
      <//>

      <${DialogContent} dividers>
        ${template.description && html`<${Typography} variant="body2" sx=${{ color: 'text.secondary', mb: 2 }}>${template.description}<//>`}
        <${Alert} severity="info" sx=${{ mb: 2 }}>
          Recommended values are prefilled. Adjust them if this workflow should be tuned for your repo during installation.
        </${Alert}>

        <${Tabs}
          value=${installDialogMode.value}
          onChange=${(_e, next) => { installDialogMode.value = next; }}
          variant="fullWidth"
          sx=${{ mb: 2, minHeight: 38, "& .MuiTab-root": { minHeight: 38, textTransform: "none", fontSize: "0.8rem" } }}
        >
          <${Tab} value="quick" label=${`Quick (${quickFields.length})`} />
          <${Tab} value="advanced" label=${`Advanced (${descriptors.length})`} />
        </${Tabs}>

        ${missingRequiredFields.length > 0 && html`<${Alert} severity="warning" sx=${{ mb: 1.5 }}>Missing required fields: ${missingRequiredFields.join(", ")}</${Alert}>`}
        ${invalidJsonFields.length > 0 && html`<${Alert} severity="error" sx=${{ mb: 1.5 }}>Invalid JSON in: ${invalidJsonFields.join(", ")}</${Alert}>`}

        ${installDialogMode.value === "quick" ? html`
          ${quickFields.map(renderField)}
          ${optional.length > 0 && html`
            <${Divider} sx=${{ my: 1.5 }} />
            <${Box} sx=${{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
              ${optional.map((item) => html`<${Chip} key=${item.key} size="small" variant="outlined" label=${`${item.label}: ${formatVarPreview(vars[item.key])}`} sx=${{ fontSize: "10px" }} />`)}
            </${Box}>
            <${Button} size="small" variant="text" onClick=${() => { installDialogMode.value = "advanced"; }} sx=${{ mt: 1, textTransform: "none" }}>
              Open Advanced Overrides
            </${Button}>
          `}
        ` : html`
          ${required.length > 0 && html`${required.map(renderField)}<${Divider} sx=${{ my: 1.5 }} />`}
          ${optional.map(renderField)}
        `}

        <${Box} sx=${{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <${Button} size="small" variant="text" onClick=${resetDefaults} sx=${{ textTransform: 'none', fontSize: '12px' }}>
            Reset to Defaults
          <//>
        <//>

        ${result && !result.ok && html`<${Alert} severity="error" sx=${{ mt: 2 }}>${result.error || "Install failed"}</${Alert}>`}
      <//>

      <${DialogActions} sx=${{ px: 3, py: 2 }}>
        <${Button} onClick=${closeInstallTemplateDialog} sx=${{ textTransform: 'none' }}>Cancel<//>
        <${Button}
          variant="contained"
          onClick=${handleInstall}
          disabled=${!canInstall}
          startIcon=${installing ? html`<${CircularProgress} size=${16} />` : null}
          sx=${{ textTransform: 'none' }}
        >
          ${installing ? "Installing…" : "Install Workflow"}
        <//>
      <//>
    <//>
  `;
}

async function setWorkflowEnabled(id, enabled) {
  try {
    const detail = await apiFetch(`/api/workflows/${id}`);
    const wf = detail?.workflow;
    if (!wf) throw new Error("Workflow not found");

    const data = await apiFetch("/api/workflows/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...wf,
        enabled: enabled !== false,
      }),
    });

    const saved = data?.workflow;
    if (!saved) throw new Error("Workflow save failed");

    if (activeWorkflow.value?.id === saved.id) {
      activeWorkflow.value = saved;
    }
    workflows.value = (workflows.value || []).map((item) =>
      item.id === saved.id ? { ...item, enabled: saved.enabled !== false } : item,
    );

    showToast(saved.enabled === false ? "Workflow paused" : "Workflow resumed", "success");
    loadWorkflows();
    return saved;
  } catch (err) {
    showToast(
      enabled === false ? "Failed to pause workflow" : "Failed to resume workflow",
      "error",
    );
    return null;
  }
}

async function installTemplate(templateId, overrides = {}) {
  try {
    const data = await apiFetch("/api/workflows/install-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId, overrides }),
    });
    if (data?.workflow) {
      activeWorkflow.value = data.workflow;
      viewMode.value = "canvas";
      showToast("Template installed", "success");
      loadWorkflows();
      setRouteParams({ workflowId: data.workflow.id }, { replace: false, skipGuard: true });
      return data.workflow;
    }
  } catch (err) {
    showToast("Failed to install template", "error");
  }
  return null;
}

function openInstallTemplateDialog(templateId) {
  const template = (templates.value || []).find((entry) => String(entry?.id || "") === String(templateId || "")) || null;
  if (!template) {
    showToast("Template not found", "error");
    return;
  }
  const variableList = Array.isArray(template.variables) ? template.variables : [];
  if (variableList.length === 0) {
    installTemplate(template.id).catch(() => {});
    return;
  }
  const defaults = {};
  for (const variable of variableList) {
    const key = String(variable?.key || "").trim();
    if (!key) continue;
    defaults[key] = cloneVars(variable?.defaultValue ?? "");
  }
  installDialogTemplate.value = template;
  installDialogVars.value = defaults;
  installDialogMode.value = variableList.some((variable) => variable?.required) ? "quick" : "advanced";
  installDialogInstalling.value = false;
  installDialogResult.value = null;
  installDialogOpen.value = true;
}

function closeInstallTemplateDialog() {
  installDialogOpen.value = false;
  installDialogTemplate.value = null;
  installDialogVars.value = {};
  installDialogMode.value = "quick";
  installDialogInstalling.value = false;
  installDialogResult.value = null;
}

async function applyTemplateUpdate(workflowId, mode = "replace", force = false) {
  try {
    const data = await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}/template-update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, force }),
    });
    if (data?.workflow) {
      showToast(
        mode === "copy"
          ? "Updated template copy created"
          : "Workflow updated to latest template",
        "success",
      );
      loadWorkflows();
      return data.workflow;
    }
  } catch (err) {
    showToast(`Template update failed: ${err.message}`, "error");
  }
  return null;
}

async function relayoutTemplateWorkflow(workflowId) {
  try {
    const data = await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}/reflow-layout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId }),
    });
    if (data?.workflow) {
      const refreshed = data.workflow;
      workflows.value = (workflows.value || []).map((workflow) => (
        workflow.id === refreshed.id ? refreshed : workflow
      ));
      if (activeWorkflow.value?.id === refreshed.id) {
        activeWorkflow.value = refreshed;
      }
      showToast("Workflow layout refreshed", "success");
      return refreshed;
    }
  } catch (err) {
    showToast(`Failed to refresh workflow layout: ${err.message}`, "error");
  }
  return null;
}

async function relayoutInstalledTemplateWorkflows() {
  try {
    const data = await apiFetch("/api/workflows/reflow-template-layouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const result = data?.result || {};
    const updated = Number(result.updated || 0);
    await loadWorkflows();
    if (activeWorkflow.value?.id) {
      const updatedActive = (workflows.value || []).find((workflow) => workflow.id === activeWorkflow.value.id);
      if (updatedActive) activeWorkflow.value = updatedActive;
    }
    showToast(
      updated > 0 ? `Refreshed layout for ${updated} template workflow${updated === 1 ? "" : "s"}` : "No template workflows needed relayout",
      "success",
    );
    return result;
  } catch (err) {
    showToast(`Failed to refresh template layouts: ${err.message}`, "error");
  }
  return null;
}

async function loadRuns(workflowId, opts = {}) {
  const append = opts.append === true;
  const preserveExisting = opts.preserveExisting === true && !append;
  const hasScopedWorkflowId = workflowId !== undefined;
  const scopedWorkflowId = hasScopedWorkflowId
    ? (workflowId ? String(workflowId) : null)
    : workflowRunsScopeId.value;
  try {
    if (opts.reset === true) {
      resetWorkflowRunsState(scopedWorkflowId);
    }
    const rawLimit =
      opts.limit != null
        ? Number(opts.limit)
        : (append || preserveExisting ? WORKFLOW_RUN_PAGE_SIZE : Number(workflowRunsLimit.value));
    const rawOffset =
      opts.offset != null
        ? Number(opts.offset)
        : (append ? Number(workflowRunsNextOffset.value || workflowRuns.value.length) : 0);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), WORKFLOW_RUN_MAX_FETCH)
        : WORKFLOW_RUN_PAGE_SIZE;
    const offset =
      Number.isFinite(rawOffset) && rawOffset > 0
        ? Math.max(0, Math.floor(rawOffset))
        : 0;
    const baseUrl = scopedWorkflowId
      ? `/api/workflows/${scopedWorkflowId}/runs`
      : "/api/workflows/runs";
    if (append) workflowRunsLoadingMore.value = true;
    else workflowRunsLoading.value = true;
    workflowRunsError.value = "";
    const existingRunCount = Array.isArray(workflowRuns.value) ? workflowRuns.value.length : 0;
    const data = await apiFetch(buildWorkflowRunApiPath(`${baseUrl}?limit=${limit}&offset=${offset}`));
    if (data?.runs) {
      const pageRuns = Array.isArray(data.runs) ? data.runs : [];
      const mergedRuns = append
        ? mergeWorkflowRunPages(workflowRuns.value, pageRuns)
        : (preserveExisting ? mergeWorkflowRunRefresh(workflowRuns.value, pageRuns) : pageRuns);
      const total = Number(data?.pagination?.total);
      const nextOffset = Number(data?.pagination?.nextOffset);
      const hasMore = data?.pagination?.hasMore === true;
      const effectiveLoadedCount = preserveExisting
        ? Math.max(existingRunCount, mergedRuns.length)
        : mergedRuns.length;
      workflowRuns.value = mergedRuns;
      workflowRunsScopeId.value = scopedWorkflowId;
      workflowRunsLimit.value = mergedRuns.length;
      workflowRunsTotal.value = Number.isFinite(total) ? total : effectiveLoadedCount;
      workflowRunsNextOffset.value = preserveExisting
        ? Math.max(effectiveLoadedCount, Number.isFinite(nextOffset) ? nextOffset : 0)
        : (Number.isFinite(nextOffset) ? nextOffset : mergedRuns.length);
      workflowRunsHasMore.value = hasMore || effectiveLoadedCount < workflowRunsTotal.value;
    }
  } catch (err) {
    workflowRunsError.value = String(err?.message || "Failed to load workflow runs");
    console.error("[workflows] Failed to load runs:", err);
  } finally {
    if (!append) workflowRunsLoading.value = false;
    workflowRunsLoadingMore.value = false;
  }
}

async function loadRunDetail(runId, opts = {}) {
  if (!runId) return;
  const safeRunId = String(runId || "").trim();
  const previousRunId = String(selectedRunId.value || "").trim();
  const clearCurrentDetail =
    previousRunId !== safeRunId
    || String(selectedRunDetail.value?.runId || "").trim() !== safeRunId;
  selectedRunId.value = safeRunId;
  if (clearCurrentDetail) {
    selectedRunDetail.value = null;
  }
  workflowRunDetailLoading.value = true;
  workflowRunDetailError.value = "";
  try {
    const data = await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}`));
    if (data?.run) {
      const scopedWorkflowId = String(opts?.workflowId || workflowRunsScopeId.value || data.run.workflowId || "").trim() || null;
      if (scopedWorkflowId) {
        workflowRunsScopeId.value = scopedWorkflowId;
      }
      selectedRunDetail.value = data.run;
      viewMode.value = "runs";
      const route = { runsView: true, runId: safeRunId };
      if (scopedWorkflowId) route.runsWorkflowId = scopedWorkflowId;
      setRouteParams(route, { replace: false, skipGuard: true });
      workflowRunDetailError.value = "";
      return;
    }
    selectedRunDetail.value = null;
    workflowRunDetailError.value = "Workflow run not found.";
  } catch (err) {
    selectedRunDetail.value = null;
    workflowRunDetailError.value = String(err?.message || "Failed to load run details");
  } finally {
    workflowRunDetailLoading.value = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Node Type Metadata (colors, icons)
 * ═══════════════════════════════════════════════════════════════ */

const NODE_CATEGORY_META = {
  trigger:    { color: "#10b981", bg: "#10b98120", icon: "zap", label: "Triggers" },
  condition:  { color: "#f59e0b", bg: "#f59e0b20", icon: "filter", label: "Conditions" },
  action:     { color: "#3b82f6", bg: "#3b82f620", icon: "play", label: "Actions" },
  validation: { color: "#8b5cf6", bg: "#8b5cf620", icon: "check", label: "Validation" },
  transform:  { color: "#ec4899", bg: "#ec489920", icon: "refresh", label: "Transform" },
  notify:     { color: "#06b6d4", bg: "#06b6d420", icon: "bell", label: "Notify" },
  agent:      { color: "#f97316", bg: "#f9731620", icon: "bot", label: "Agent" },
  loop:       { color: "#64748b", bg: "#64748b20", icon: "repeat", label: "Loop" },
};

function getNodeMeta(type) {
  const [cat] = (type || "").split(".");
  return NODE_CATEGORY_META[cat] || { color: "#6b7280", bg: "#6b728020", icon: "diamond", label: "Other" };
}

function stripEmoji(text) {
  return String(text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const PORT_TYPE_META = {
  Any: { color: "#9ca3af", description: "Wildcard payload" },
  TaskDef: { color: "#10b981", description: "Task definition/context payload" },
  TriggerEvent: { color: "#22c55e", description: "Event payload emitted by trigger nodes" },
  AgentResult: { color: "#8b5cf6", description: "Agent execution output" },
  String: { color: "#3b82f6", description: "Text payload" },
  Boolean: { color: "#14b8a6", description: "Boolean flag" },
  Number: { color: "#0ea5e9", description: "Numeric payload" },
  JSON: { color: "#06b6d4", description: "Structured JSON payload" },
  GitRef: { color: "#f97316", description: "Git branch/hash/ref payload" },
  PRUrl: { color: "#f43f5e", description: "Pull request URL payload" },
  LogStream: { color: "#eab308", description: "Log output or command transcript" },
  SessionRef: { color: "#a855f7", description: "Session identifier payload" },
  CommandResult: { color: "#f59e0b", description: "Command execution result" },
};

function normalizePortDescriptor(port, direction, index) {
  const fallbackName = index === 0 ? "default" : `${direction}-${index + 1}`;
  if (!port || typeof port !== "object") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: "Any",
      description: PORT_TYPE_META.Any.description,
      accepts: [],
      color: PORT_TYPE_META.Any.color,
    };
  }
  const type = String(port.type || "Any").trim() || "Any";
  const typeMeta = PORT_TYPE_META[type] || PORT_TYPE_META.Any;
  return {
    ...port,
    name: String(port.name || fallbackName).trim() || fallbackName,
    label: String(port.label || port.name || fallbackName).trim() || fallbackName,
    type,
    description: String(port.description || typeMeta.description || "").trim(),
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
    color: String(port.color || typeMeta.color || "").trim() || typeMeta.color,
  };
}

function isWildcardPortType(type) {
  const normalized = String(type || "").trim();
  return normalized === "*" || normalized === "Any";
}

function isPortConnectionCompatible(sourcePort, targetPort) {
  if (!sourcePort || !targetPort) return { compatible: true, reason: null };
  const sourceType = String(sourcePort.type || "Any").trim() || "Any";
  const targetType = String(targetPort.type || "Any").trim() || "Any";
  const accepted = new Set(
    [targetType, ...(Array.isArray(targetPort.accepts) ? targetPort.accepts : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (isWildcardPortType(sourceType) || isWildcardPortType(targetType) || accepted.has("*") || accepted.has("Any")) {
    return { compatible: true, reason: null };
  }
  if (sourceType === targetType || accepted.has(sourceType)) {
    return { compatible: true, reason: null };
  }
  return {
    compatible: false,
    reason: `${sourcePort.label || sourcePort.name} emits ${sourceType}, but ${targetPort.label || targetPort.name} expects ${targetType}`,
  };
}

function resolveNodePorts(node, nodeTypeMap) {
  const typeInfo = nodeTypeMap.get(node?.type) || null;
  const typePorts = typeInfo?.ports || {};
  const typeInputs = Array.isArray(typeInfo?.inputs) ? typeInfo.inputs : typePorts.inputs;
  const typeOutputs = Array.isArray(typeInfo?.outputs) ? typeInfo.outputs : typePorts.outputs;
  const inputSource = Array.isArray(node?.inputPorts) && node.inputPorts.length
    ? node.inputPorts
    : typeInputs;
  const outputSource = Array.isArray(node?.outputPorts) && node.outputPorts.length
    ? node.outputPorts
    : typeOutputs;
  const inputs = (Array.isArray(inputSource) ? inputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "input", index));
  const outputs = (Array.isArray(outputSource) ? outputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "output", index));
  return {
    inputs: inputs.length ? inputs : [normalizePortDescriptor(null, "input", 0)],
    outputs: outputs.length ? outputs : [normalizePortDescriptor(null, "output", 0)],
  };
}

function resolveRequestedEdgePortName(edge, primaryKey, legacyKey) {
  if (!edge || typeof edge !== "object") return "";
  for (const key of [primaryKey, legacyKey]) {
    if (!key || !Object.prototype.hasOwnProperty.call(edge, key)) continue;
    const value = String(edge[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function resolveEdgePortDescriptor(ports, requestedName) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const normalizedName = String(requestedName || "").trim();
  if (!normalizedName) return ports[0] || null;
  return ports.find((port) => port.name === normalizedName) || null;
}

function buildUnknownEdgePortMessage(edge, direction, requestedName, ports = []) {
  const safeName = String(requestedName || "").trim();
  const label = direction === "output" ? "output" : "input";
  const available = (Array.isArray(ports) ? ports : [])
    .map((port) => String(port?.name || "").trim())
    .filter(Boolean);
  const suffix = available.length ? ` Available ${label} ports: ${available.join(", ")}.` : "";
  const edgeId = edge?.id || `${edge?.source || "?"}->${edge?.target || "?"}`;
  return `Unknown ${label} port "${safeName}" on edge ${edgeId}.${suffix}`;
}

function validateEdgePortMapping(edge, nodeLookup, nodeTypeMap) {
  const sourceNode = nodeLookup.get(edge?.source) || null;
  const targetNode = nodeLookup.get(edge?.target) || null;
  const sourcePorts = resolveNodePorts(sourceNode, nodeTypeMap).outputs;
  const targetPorts = resolveNodePorts(targetNode, nodeTypeMap).inputs;
  const requestedSourcePortName = resolveRequestedEdgePortName(edge, "sourcePort", "fromPort");
  const requestedTargetPortName = resolveRequestedEdgePortName(edge, "targetPort", "toPort");
  const sourcePort = resolveEdgePortDescriptor(sourcePorts, requestedSourcePortName || "default");
  const targetPort = resolveEdgePortDescriptor(targetPorts, requestedTargetPortName || "default");
  const issues = [];

  if (requestedSourcePortName && !sourcePort) {
    issues.push({
      code: "unknown-output-port",
      message: buildUnknownEdgePortMessage(edge, "output", requestedSourcePortName, sourcePorts),
    });
  }
  if (requestedTargetPortName && !targetPort) {
    issues.push({
      code: "unknown-input-port",
      message: buildUnknownEdgePortMessage(edge, "input", requestedTargetPortName, targetPorts),
    });
  }

  if (sourcePort && targetPort) {
    const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
    if (!compatibility.compatible) {
      issues.push({
        code: "invalid-port-binding",
        message: `Invalid port binding: ${compatibility.reason || "Port types are incompatible"}`,
      });
    }
  }

  return {
    issues,
    sourceNode,
    targetNode,
    sourcePorts,
    targetPorts,
    sourcePort,
    targetPort,
    requestedSourcePortName,
    requestedTargetPortName,
  };
}

function sanitizeInlineFieldValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function pickInlineFieldKeys(typeInfo, node, maxFields = 3) {
  const schema = typeInfo?.schema?.properties || {};
  const keys = Object.keys(schema);
  const preferred = Array.isArray(typeInfo?.ui?.primaryFields)
    ? typeInfo.ui.primaryFields
    : [];
  const selected = [];
  for (const key of preferred) {
    if (keys.includes(key) && !selected.includes(key)) selected.push(key);
  }
  if (selected.length >= maxFields) return selected.slice(0, maxFields);
  const fallbackPriority = ["model", "expression", "enabled", "branch", "branchName", "eventType", "command", "message", "prompt"];
  for (const key of fallbackPriority) {
    if (keys.includes(key) && !selected.includes(key)) selected.push(key);
    if (selected.length >= maxFields) break;
  }
  return selected.slice(0, maxFields);
}

function getInlineFieldDescriptors(typeInfo, node, maxFields = 3) {
  const schema = typeInfo?.schema?.properties || {};
  const config = node?.config || {};
  const keys = pickInlineFieldKeys(typeInfo, node, maxFields);
  return keys
    .map((key) => {
      const fieldSchema = schema[key] || {};
      const value = config[key] ?? fieldSchema.default ?? "";
      const type = fieldSchema.type || "string";
      const isEnum = Array.isArray(fieldSchema.enum) && fieldSchema.enum.length > 0;
      const shortString = type === "string" && String(value || "").length <= 42;
      const supported = isEnum || type === "boolean" || type === "number" || shortString;
      if (!supported) return null;
      return {
        key,
        value: sanitizeInlineFieldValue(value),
        schema: fieldSchema,
        fieldType: type,
        isEnum,
      };
    })
    .filter(Boolean)
    .slice(0, maxFields);
}

/* ═══════════════════════════════════════════════════════════════
 *  Canvas — SVG-based Workflow Editor
 * ═══════════════════════════════════════════════════════════════ */

function WorkflowCanvas({ workflow, onSave, nodeTypes: availableNodeTypes = [] }) {
  const canvasRef = useRef(null);
  const [nodes, setNodes] = useState(workflow?.nodes || []);
  const [edges, setEdges] = useState(workflow?.edges || []);
  const [groups, setGroups] = useState(workflow?.groups || []);
  const [dragState, setDragState] = useState(null);
  const [panStart, setPanStart] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [editingNode, setEditingNode] = useState(null);
  const [showNodePalette, setShowNodePalette] = useState(false);
  const [nodePaletteQuery, setNodePaletteQuery] = useState("");
  const [paletteInsertPoint, setPaletteInsertPoint] = useState(null);
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState(null);
  const [spacePanning, setSpacePanning] = useState(false);
  const [connectionHint, setConnectionHint] = useState(null);
  const [portHoverHint, setPortHoverHint] = useState(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importJsonText, setImportJsonText] = useState("");
  const [inlinePreview, setInlinePreview] = useState(null);
  const [historyState, setHistoryState] = useState(() => createHistoryState(workflow?.nodes || [], workflow?.edges || [], workflow?.groups || []));
  const [marquee, setMarquee] = useState(null);
  const [liveHighlightEnabled, setLiveHighlightEnabled] = useState(true);
  const [liveRun, setLiveRun] = useState(null);
  const [recentRuns, setRecentRuns] = useState([]);
  const [recentRunsTotal, setRecentRunsTotal] = useState(0);
  const [recentRunsLoading, setRecentRunsLoading] = useState(false);
  const [runsPanelOpen, setRunsPanelOpen] = useState(true);
  const [liveNodeStatuses, setLiveNodeStatuses] = useState({});
  const [liveNodeOutputPreviews, setLiveNodeOutputPreviews] = useState({});
  const [liveNodeFlashStates, setLiveNodeFlashStates] = useState({});
  const [liveNodeRunningHints, setLiveNodeRunningHints] = useState({});
  const [liveEdgeActivity, setLiveEdgeActivity] = useState({});
  const [liveNowTick, setLiveNowTick] = useState(Date.now());
  const marqueeStartRef = useRef(null);
  const multiDragRef = useRef({});
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const groupsRef = useRef(groups);
  const historyRef = useRef(historyState);
  const historyTimerRef = useRef(null);
  const historyPendingSnapshotRef = useRef(null);
  const saveTimer = useRef(null);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const liveEventQueueRef = useRef([]);
  const liveEventFlushTimerRef = useRef(null);
  // Derived live status helpers
  const hasLiveStatuses = Object.keys(liveNodeStatuses).length > 0;
  const liveActiveNodes = Object.values(liveNodeStatuses).filter(
    (s) => s === "running" || s === "active" || s === "in_progress",
  ).length;
  const liveRunDuration = liveRun?.status === "running" && liveRun?.startedAt
    ? Math.max(0, liveNowTick - Number(liveRun.startedAt))
    : Number(liveRun?.duration) || 0;
  const workflowSnapshotKey = useMemo(
    () => serializeGraphSnapshot(workflow?.nodes || [], workflow?.edges || [], workflow?.groups || []),
    [workflow?.nodes, workflow?.edges, workflow?.groups],
  );
  const nodeTypeMap = useMemo(
    () => new Map((availableNodeTypes || []).map((type) => [type.type, type])),
    [availableNodeTypes],
  );
  const currentSelectedEdgeId = selectedEdgeId.value;
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === currentSelectedEdgeId) || null,
    [currentSelectedEdgeId, edges],
  );
  const ensureNodePortMetadata = useCallback((node) => {
    const ports = resolveNodePorts(node, nodeTypeMap);
    return {
      ...node,
      inputPorts: ports.inputs,
      outputPorts: ports.outputs,
    };
  }, [nodeTypeMap]);

  const normalizeNodesForCanvas = useCallback((nodeList = []) => (
    (Array.isArray(nodeList) ? nodeList : []).map((node) => ensureNodePortMetadata(node))
  ), [ensureNodePortMetadata]);
  const nodeLookup = useMemo(
    () => new Map((nodes || []).map((node) => [node.id, node])),
    [nodes],
  );
  const normalizeEdgesForCanvas = useCallback((edgeList = [], nodeList = nodesRef.current || []) => (
    hydrateCanvasEdges(normalizeNodesForCanvas(nodeList), edgeList, nodeTypeMap)
  ), [nodeTypeMap, normalizeNodesForCanvas]);
  const edgePortValidationIssues = useMemo(() => (
    validateCanvasEdgePorts(nodes, normalizeEdgesForCanvas(edges, nodes), nodeTypeMap)
  ), [edges, nodeTypeMap, nodes, normalizeEdgesForCanvas]);
  const reportEdgeValidationIssues = useCallback(() => {
    if (!edgePortValidationIssues.length) return false;
    const firstIssue = edgePortValidationIssues[0] || null;
    if (firstIssue?.edgeId) {
      selectedEdgeId.value = firstIssue.edgeId;
    }
    showToast(firstIssue?.message || "Workflow has invalid edge port bindings", "error");
    return true;
  }, [edgePortValidationIssues]);
  const createWorkflowSnapshotForCopilot = useCallback(() => ({
    ...(workflow || {}),
    nodes: normalizeNodesForCanvas(nodesRef.current || []),
    edges: normalizeEdgesForCanvas(edgesRef.current || []),
    groups: Array.isArray(groupsRef.current) ? [...groupsRef.current] : [],
  }), [normalizeEdgesForCanvas, normalizeNodesForCanvas, workflow]);
  const openWorkflowCopilotFromCanvas = useCallback(async ({
    intent = "explain",
    nodeId = "",
    title = "",
    successToast = "",
  } = {}) => {
    const snapshot = createWorkflowSnapshotForCopilot();
    const safeWorkflowId = String(snapshot?.id || workflow?.id || "").trim();
    const safeNodeId = String(nodeId || "").trim();
    const fallbackNode = safeNodeId
      ? (snapshot.nodes || []).find((entry) => String(entry?.id || "").trim() === safeNodeId) || null
      : null;
    const fallbackPrompt = safeNodeId
      ? buildWorkflowNodePrompt(snapshot, fallbackNode, nodeTypeMap)
      : buildWorkflowExplainPrompt(snapshot);
    if (!safeWorkflowId) {
      return openWorkflowCopilotChat(fallbackPrompt, { title, successToast });
    }
    return startWorkflowCopilotSession({
      endpoint: `/api/workflows/${encodeURIComponent(safeWorkflowId)}/copilot-context`,
      fetchOptions: {
        method: "POST",
        body: JSON.stringify({
          intent,
          ...(safeNodeId ? { nodeId: safeNodeId } : {}),
          workflow: snapshot,
        }),
      },
      fallbackPrompt,
      title,
      successToast,
    });
  }, [createWorkflowSnapshotForCopilot, nodeTypeMap, workflow]);
  useEffect(() => { selectedNodeIdsRef.current = selectedNodeIds; }, [selectedNodeIds]);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  }, [nodes, edges]);

  useEffect(() => {
    const nextNodes = normalizeNodesForCanvas(workflow?.nodes || []);
    const nextEdges = normalizeEdgesForCanvas(workflow?.edges || []);
    const nextGroups = workflow?.groups || [];
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyPendingSnapshotRef.current = null;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    const nextHistory = createHistoryState(nextNodes, nextEdges);
    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
    setSelectedNodeIds(new Set());
    setSelectedGroupId(null);
    selectedNodeId.value = null;
    selectedEdgeId.value = null;
    setEditingNode(null);
    setContextMenu(null);
    setShowNodePalette(false);
  }, [normalizeEdgesForCanvas, workflow?.id, workflowSnapshotKey, normalizeNodesForCanvas]);

  useEffect(() => {
    if (!workflow?.id) {
      setLiveRun(null);
      setRecentRuns([]);
      setRecentRunsTotal(0);
      setRecentRunsLoading(false);
      setLiveNodeStatuses({});
      setLiveNodeOutputPreviews({});
      setLiveNodeFlashStates({});
      setLiveNodeRunningHints({});
      setLiveEdgeActivity({});
      return;
    }
    let cancelled = false;

    const pollLiveRun = async () => {
      try {
        setRecentRunsLoading(true);
        const data = await apiFetch(`/api/workflows/${encodeURIComponent(workflow.id)}/runs?limit=12`);
        if (cancelled) return;
        const runs = Array.isArray(data?.runs) ? data.runs : [];
        const total = Number(data?.pagination?.total);
        setRecentRuns(runs);
        setRecentRunsTotal(Number.isFinite(total) ? total : runs.length);
        const running = runs.find((run) => run?.status === "running");
        const targetRun = running || runs[0] || null;
        if (!targetRun?.runId) {
          setLiveRun(null);
          setLiveNodeStatuses({});
          setLiveNodeRunningHints({});
          setLiveNodeOutputPreviews({});
          setLiveNodeFlashStates({});
          setLiveEdgeActivity({});
          return;
        }
        if (!liveHighlightEnabled) {
          setLiveRun(targetRun);
          setLiveNodeStatuses({});
          setLiveNodeRunningHints({});
          setLiveNodeOutputPreviews({});
          setLiveNodeFlashStates({});
          setLiveEdgeActivity({});
          return;
        }
        if (targetRun.status !== "running") {
          setLiveRun(targetRun);
          setLiveNodeStatuses({});
          return;
        }
        const detailResponse = await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${targetRun.runId}`));
        if (cancelled) return;
        const detailedRun = detailResponse?.run || targetRun;
        setLiveRun(detailedRun);
        const runStatuses = buildNodeStatusesFromRunDetail(detailedRun);
        const normalizedStatuses = {};
        for (const [nodeId, status] of Object.entries(runStatuses || {})) {
          normalizedStatuses[nodeId] = normalizeLiveNodeStatus(status);
        }
        setLiveNodeStatuses(normalizedStatuses);
        const nodeOutputs = detailedRun?.detail?.nodeOutputs && typeof detailedRun.detail.nodeOutputs === "object"
          ? detailedRun.detail.nodeOutputs
          : {};
        setLiveNodeOutputPreviews((prev) => {
          const next = { ...prev };
          for (const node of nodesRef.current || []) {
            const nodeId = String(node?.id || "").trim();
            if (!nodeId || !Object.prototype.hasOwnProperty.call(nodeOutputs, nodeId)) continue;
            const preview = resolveNodeOutputPreview(node?.type, null, nodeOutputs[nodeId]);
            const lines = Array.isArray(preview?.lines)
              ? preview.lines.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 3)
              : [];
            if (!lines.length && preview?.tokenCount == null) continue;
            next[nodeId] = {
              lines,
              tokenCount: Number.isFinite(Number(preview?.tokenCount))
                ? Math.max(0, Math.round(Number(preview.tokenCount)))
                : null,
              updatedAt: Date.now(),
            };
          }
          return next;
        });
      } catch {
        if (cancelled) return;
      } finally {
        if (!cancelled) setRecentRunsLoading(false);
      }
    };

    pollLiveRun();
    const pollTimer = setInterval(pollLiveRun, WORKFLOW_LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
    };
  }, [liveHighlightEnabled, workflow?.id]);

  useEffect(() => {
    if (!liveHighlightEnabled) return undefined;
    const timer = setInterval(() => setLiveNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [liveHighlightEnabled, liveRun?.status]);

  useEffect(() => {
    if (!liveHighlightEnabled) return;
    const now = Date.now();
    setLiveNodeFlashStates((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [nodeId, flash] of Object.entries(next)) {
        if (!flash || Number(flash.until) <= now) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setLiveNodeRunningHints((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [nodeId, until] of Object.entries(next)) {
        if (Number(until || 0) <= now) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setLiveEdgeActivity((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [edgeId, info] of Object.entries(next)) {
        if (!info || now - Number(info.ts || 0) > EDGE_FLOW_ANIMATION_MS) {
          delete next[edgeId];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [liveNowTick, liveHighlightEnabled]);

  useEffect(() => {
    if (!liveHighlightEnabled || !workflow?.id) return undefined;
    const flushQueuedEvents = () => {
      if (liveEventFlushTimerRef.current) {
        clearTimeout(liveEventFlushTimerRef.current);
        liveEventFlushTimerRef.current = null;
      }
      const queued = liveEventQueueRef.current.splice(0, liveEventQueueRef.current.length);
      if (!queued.length) return;
      setLiveNowTick(Date.now());
      setLiveRun((prev) => {
        let next = prev;
        for (const event of queued) {
          if (event.kind !== "run") continue;
          if (!next || next.runId !== event.runId) {
            next = {
              ...(next || {}),
              runId: event.runId,
              workflowId: event.workflowId || workflow.id,
              workflowName: event.workflowName || workflow.name,
              startedAt: event.timestamp || Date.now(),
            };
          }
          next = {
            ...next,
            runId: event.runId,
            workflowId: event.workflowId || next.workflowId || workflow.id,
            workflowName: event.workflowName || next.workflowName || workflow.name,
            status: event.status || next.status || "running",
            duration: Number.isFinite(Number(event.duration)) ? Number(event.duration) : next.duration,
            endedAt: event.status && event.status !== "running"
              ? (event.timestamp || Date.now())
              : next.endedAt,
          };
        }
        return next;
      });
      setLiveNodeStatuses((prev) => {
        const next = { ...prev };
        for (const event of queued) {
          if (event.kind !== "node" || !event.nodeId) continue;
          next[event.nodeId] = normalizeLiveNodeStatus(event.status);
        }
        return next;
      });
      setLiveNodeOutputPreviews((prev) => {
        const next = { ...prev };
        for (const event of queued) {
          if (event.kind !== "node" || !event.nodeId) continue;
          if (event.outputPreview || event.error) {
            const lines = Array.isArray(event.outputPreview?.lines)
              ? event.outputPreview.lines
              : (event.error ? [String(event.error)] : []);
            next[event.nodeId] = {
              lines: lines.slice(0, 3),
              tokenCount: Number.isFinite(Number(event.outputPreview?.tokenCount))
                ? Math.max(0, Math.round(Number(event.outputPreview.tokenCount)))
                : null,
              updatedAt: event.timestamp || Date.now(),
            };
          }
        }
        return next;
      });
      setLiveNodeFlashStates((prev) => {
        const next = { ...prev };
        const now = Date.now();
        for (const event of queued) {
          if (event.kind !== "node" || !event.nodeId) continue;
          const normalized = normalizeLiveNodeStatus(event.status);
          if (normalized === "success" || normalized === "fail" || normalized === "skipped") {
            next[event.nodeId] = {
              state: normalized,
              until: now + NODE_COMPLETION_FLASH_MS,
            };
          }
        }
        for (const [nodeId, flash] of Object.entries(next)) {
          if (!flash || Number(flash.until) <= now) delete next[nodeId];
        }
        return next;
      });
      setLiveNodeRunningHints((prev) => {
        const next = { ...prev };
        const now = Date.now();
        let changed = false;
        for (const event of queued) {
          if (event.kind !== "node" || !event.nodeId) continue;
          const normalized = normalizeLiveNodeStatus(event.status);
          if (normalized === "running") {
            next[event.nodeId] = now + NODE_RUNNING_HINT_MS;
            changed = true;
            continue;
          }
          if (normalized === "success" || normalized === "fail" || normalized === "skipped") {
            if (next[event.nodeId]) {
              delete next[event.nodeId];
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      setLiveEdgeActivity((prev) => {
        const next = { ...prev };
        const now = Date.now();
        for (const event of queued) {
          if (event.kind !== "edge" || !event.edgeId) continue;
          next[event.edgeId] = {
            ts: Number(event.timestamp) || now,
            source: event.source || null,
            target: event.target || null,
            reason: event.reason || "flow",
          };
        }
        for (const [edgeId, info] of Object.entries(next)) {
          if (!info || now - Number(info.ts || 0) > EDGE_FLOW_ANIMATION_MS) {
            delete next[edgeId];
          }
        }
        return next;
      });
    };

    const scheduleEventFlush = () => {
      if (liveEventFlushTimerRef.current) return;
      liveEventFlushTimerRef.current = setTimeout(flushQueuedEvents, WORKFLOW_LIVE_WS_BATCH_MS);
    };

    const unsub = onWsMessage((msg) => {
      if (msg?.type !== "workflow-run-events") return;
      const payload = msg?.payload || {};
      const payloadWorkflowId = String(payload.workflowId || "").trim();
      if (payloadWorkflowId !== String(workflow.id || "").trim()) return;
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (!events.length) return;
      liveEventQueueRef.current.push(...events);
      scheduleEventFlush();
    });

    return () => {
      if (liveEventFlushTimerRef.current) {
        clearTimeout(liveEventFlushTimerRef.current);
        liveEventFlushTimerRef.current = null;
      }
      liveEventQueueRef.current = [];
      try {
        unsub?.();
      } catch {}
    };
  }, [liveHighlightEnabled, workflow?.id, workflow?.name]);

  const renderGraph = useMemo(() => buildCollapsedGraph({ nodes, edges, groups }), [nodes, edges, groups]);
  const draftFlowchart = useMemo(() => buildDraftFlowchartMap({
    nodes,
    edges,
    groups,
    metadata: workflow?.metadata || {},
  }), [edges, groups, nodes, workflow?.metadata]);
  const renderNodes = renderGraph.visibleNodes || [];
  const renderEdges = renderGraph.visibleEdges || [];
  const activeGroup = useMemo(() => {
    if (selectedGroupId) {
      return (groups || []).find((group) => group.id === selectedGroupId) || null;
    }
    if (!selectedNodeIds.size) return null;
    return (groups || []).find((group) => {
      const selected = [...selectedNodeIds];
      return selected.every((nodeId) => group.nodeIds.includes(nodeId));
    }) || null;
  }, [groups, selectedGroupId, selectedNodeIds]);
  // Canvas dimensions
  const NODE_W = 220;
  const NODE_H = 118;
  const PORT_R = 8;

  const focusDraftFlowchartStep = useCallback((step) => {
    if (!step) return;
    const runtimeNodeIds = Array.isArray(step.runtimeNodeIds) ? step.runtimeNodeIds.filter(Boolean) : [];
    if (step.groupId && (groupsRef.current || []).some((group) => group.id === step.groupId)) {
      setSelectedGroupId(step.groupId);
      setSelectedNodeIds(new Set(runtimeNodeIds));
      selectedNodeId.value = runtimeNodeIds[0] || null;
      selectedEdgeId.value = null;
      setEditingNode(null);
      return;
    }
    const targetNodeId = runtimeNodeIds[0] || step.primaryNodeId || "";
    if (!targetNodeId) return;
    setSelectedGroupId(null);
    setSelectedNodeIds(new Set([targetNodeId]));
    selectedNodeId.value = targetNodeId;
    selectedEdgeId.value = null;
    setEditingNode(null);
  }, []);

  const toCanvas = useCallback((clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }, [zoom, pan]);


  const setHistory = useCallback((nextHistory) => {
    historyRef.current = nextHistory;
    setHistoryState(nextHistory);
  }, []);

  const flushPendingHistory = useCallback(() => {
    if (!historyPendingSnapshotRef.current) return historyRef.current;
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    const snapshot = parseGraphSnapshot(historyPendingSnapshotRef.current);
    historyPendingSnapshotRef.current = null;
    const nextHistory = pushHistorySnapshot(historyRef.current, snapshot.nodes, snapshot.edges, snapshot.groups || [], HISTORY_LIMIT);
    if (nextHistory !== historyRef.current) setHistory(nextHistory);
    return nextHistory;
  }, [setHistory]);

  const scheduleHistoryCommit = useCallback((nextNodes, nextEdges) => {
    historyPendingSnapshotRef.current = serializeGraphSnapshot(nextNodes, nextEdges, groupsRef.current || []);
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyTimerRef.current = setTimeout(() => {
      const snapshot = parseGraphSnapshot(historyPendingSnapshotRef.current);
      historyPendingSnapshotRef.current = null;
      historyTimerRef.current = null;
      const nextHistory = pushHistorySnapshot(historyRef.current, snapshot.nodes, snapshot.edges, snapshot.groups || [], HISTORY_LIMIT);
      if (nextHistory !== historyRef.current) setHistory(nextHistory);
    }, HISTORY_COMMIT_DEBOUNCE_MS);
  }, [setHistory]);

  const buildPersistedWorkflowDefinition = useCallback((baseWorkflow, nextNodes, nextEdges, nextGroups = groupsRef.current || []) => {
    if (!baseWorkflow) return null;
    const normalizedNodes = normalizeNodesForCanvas(nextNodes);
    const normalizedEdges = normalizeEdgesForCanvas(nextEdges, normalizedNodes);
    const safeGroups = Array.isArray(nextGroups) ? nextGroups : [];
    return {
      ...baseWorkflow,
      metadata: {
        ...(baseWorkflow?.metadata || {}),
        flowchart: buildDraftFlowchartMetadata({
          ...baseWorkflow,
          nodes: normalizedNodes,
          edges: normalizedEdges,
          groups: safeGroups,
          metadata: baseWorkflow?.metadata || {},
        }),
      },
      nodes: normalizedNodes,
      edges: normalizedEdges,
      groups: safeGroups,
    };
  }, [normalizeEdgesForCanvas, normalizeNodesForCanvas]);

  const scheduleSave = useCallback((nextNodes, nextEdges, nextGroups = groupsRef.current || []) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = serializeGraphSnapshot(normalizeNodesForCanvas(nextNodes), normalizeEdgesForCanvas(nextEdges, nextNodes), groupsRef.current || []);
    saveTimer.current = setTimeout(() => {
      if (!workflow?.id) return;
      const latest = parseGraphSnapshot(snapshot);
      const persistedWorkflow = buildPersistedWorkflowDefinition(
        workflow,
        latest.nodes,
        latest.edges,
        latest.groups || nextGroups,
      );
      if (persistedWorkflow) saveWorkflow(persistedWorkflow);
    }, 1500);
  }, [buildPersistedWorkflowDefinition, normalizeEdgesForCanvas, normalizeNodesForCanvas, workflow]);

  const applyGraphChange = useCallback((updater, options = {}) => {
    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const currentGroups = groupsRef.current;
    const nextGraph = updater({ nodes: currentNodes, edges: currentEdges, groups: currentGroups });
    if (!nextGraph) return null;
    const nextNodes = normalizeNodesForCanvas(nextGraph.nodes ?? currentNodes);
    const nextEdges = nextGraph.edges ?? currentEdges;
    const nextGroups = nextGraph.groups ?? currentGroups;
    if (nextNodes === currentNodes && nextEdges === currentEdges && nextGroups === currentGroups) return null;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    groupsRef.current = nextGroups;
    scheduleSave(nextNodes, nextEdges, nextGroups);
    if (options.history === "debounced") {
      scheduleHistoryCommit(nextNodes, nextEdges);
    } else if (options.history !== "skip") {
      flushPendingHistory();
      const nextHistory = pushHistorySnapshot(historyRef.current, nextNodes, nextEdges, nextGroups, HISTORY_LIMIT);
      if (nextHistory !== historyRef.current) setHistory(nextHistory);
    }
    return { nodes: nextNodes, edges: nextEdges, groups: nextGroups };
  }, [flushPendingHistory, normalizeNodesForCanvas, scheduleHistoryCommit, scheduleSave, setHistory]);

  const getDefaultInsertPoint = useCallback(() => {
    if ((mousePos.x || mousePos.y) && Number.isFinite(mousePos.x) && Number.isFinite(mousePos.y)) {
      return mousePos;
    }
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 300, y: 300 };
    return toCanvas(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
  }, [mousePos, toCanvas]);

  const openNodePalette = useCallback((point = getDefaultInsertPoint()) => {
    setPaletteInsertPoint(point);
    setNodePaletteQuery("");
    setShowNodePalette(true);
    setContextMenu(null);
  }, [getDefaultInsertPoint]);

  const closeNodePalette = useCallback(() => {
    setShowNodePalette(false);
    setNodePaletteQuery("");
  }, []);

  const applyHistorySnapshot = useCallback((snapshot) => {
    const nextNodes = normalizeNodesForCanvas(snapshot?.nodes || []);
    const nextEdges = snapshot?.edges || [];
    const nextGroups = snapshot?.groups || [];
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    historyPendingSnapshotRef.current = null;
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    groupsRef.current = nextGroups;
    setNodes(nextNodes);
    setEdges(nextEdges);
    setGroups(nextGroups);
    setSelectedNodeIds(new Set());
    setSelectedGroupId(null);
    selectedNodeId.value = null;
    selectedEdgeId.value = null;
    setEditingNode(null);
    setContextMenu(null);
    scheduleSave(nextNodes, nextEdges, nextGroups);
  }, [normalizeNodesForCanvas, scheduleSave]);

  const undoCanvas = useCallback(() => {
    const readyHistory = flushPendingHistory();
    const { history: nextHistory, snapshot } = undoHistory(readyHistory);
    if (nextHistory === readyHistory) return;
    setHistory(nextHistory);
    applyHistorySnapshot(snapshot);
  }, [applyHistorySnapshot, flushPendingHistory, setHistory]);

  const redoCanvas = useCallback(() => {
    const readyHistory = flushPendingHistory();
    const { history: nextHistory, snapshot } = redoHistory(readyHistory, HISTORY_LIMIT);
    if (nextHistory === readyHistory) return;
    setHistory(nextHistory);
    applyHistorySnapshot(snapshot);
  }, [applyHistorySnapshot, flushPendingHistory, setHistory]);

  useEffect(() => {
    const onKeyDown = (e) => {
      const target = e.target;
      const inInput = target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      );
      const modKey = e.ctrlKey || e.metaKey;
      const lowerKey = String(e.key || "").toLowerCase();
      if (e.code === "Space") {
        if (inInput) return;
        e.preventDefault();
        setSpacePanning(true);
        return;
      }
      if (e.key === "Escape") {
        if (showNodePalette) {
          e.preventDefault();
          closeNodePalette();
          return;
        }
        if (showShortcutOverlay) {
          e.preventDefault();
          setShowShortcutOverlay(false);
          return;
        }
        if (contextMenu) {
          e.preventDefault();
          setContextMenu(null);
          return;
        }
        if (connecting) {
          e.preventDefault();
          setConnecting(null);
          return;
        }
        if (!inInput && editingNode) {
          e.preventDefault();
          setEditingNode(null);
          return;
        }
      }
      if (!inInput && !modKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        openNodePalette();
        return;
      }
      if (!inInput && !modKey && !e.altKey && e.key === "?") {
        e.preventDefault();
        setShowShortcutOverlay((current) => !current);
        return;
      }
      if (!inInput && modKey && !e.altKey && lowerKey === "a") {
        e.preventDefault();
        const ids = new Set(nodesRef.current.map((node) => node.id));
        setSelectedNodeIds(ids);
        selectedNodeId.value = ids.size ? [...ids][0] : null;
        selectedEdgeId.value = null;
        return;
      }
      if (!inInput && modKey && !e.altKey && lowerKey === "z") {
        e.preventDefault();
        if (e.shiftKey) redoCanvas();
        else undoCanvas();
        return;
      }
      if (!inInput && modKey && !e.altKey && lowerKey === "y") {
        e.preventDefault();
        redoCanvas();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !inInput) {
        const ids = selectedNodeIdsRef.current;
        if (ids.size > 0) {
          e.preventDefault();
          applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
            nodes: currentNodes.filter((node) => !ids.has(node.id)),
            edges: currentEdges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
          }));
          setSelectedNodeIds(new Set());
    setSelectedGroupId(null);
          selectedNodeId.value = null;
          setEditingNode(null);
          return;
        }
        if (selectedEdgeId.value) {
          e.preventDefault();
          const edgeId = selectedEdgeId.value;
          applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
            nodes: currentNodes,
            edges: currentEdges.filter((edge) => edge.id !== edgeId),
          }));
          selectedEdgeId.value = null;
        }
      }
    };
    const onKeyUp = (e) => {
      if (e.code !== "Space") return;
      setSpacePanning(false);
    };
    const onWindowBlur = () => {
      setSpacePanning(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [applyGraphChange, closeNodePalette, connecting, contextMenu, editingNode, openNodePalette, redoCanvas, showNodePalette, showShortcutOverlay, undoCanvas]);

  // ── Mouse events ──────────────────────────────────────────

  const movePointer = useCallback((clientX, clientY) => {
    const canvasPos = toCanvas(clientX, clientY);
    setMousePos(canvasPos);

    if (panStart) {
      setPan({ x: clientX - panStart.x, y: clientY - panStart.y });
      return;
    }
    if (marqueeStartRef.current) {
      const start = marqueeStartRef.current;
      setMarquee({
        x: Math.min(start.x, canvasPos.x),
        y: Math.min(start.y, canvasPos.y),
        w: Math.abs(canvasPos.x - start.x),
        h: Math.abs(canvasPos.y - start.y),
      });
      return;
    }
    if (dragState) {
      if (dragState.kind === "group") {
        const deltaX = canvasPos.x - dragState.anchorX;
        const deltaY = canvasPos.y - dragState.anchorY;
        applyGraphChange(({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }) => (
          moveWorkflowGroupByDelta(
            { nodes: currentNodes, edges: currentEdges, groups: currentGroups },
            dragState.groupId,
            deltaX,
            deltaY,
          )
        ), { history: "debounced" });
        return;
      }
      const newPrimaryX = canvasPos.x - dragState.offsetX;
      const newPrimaryY = canvasPos.y - dragState.offsetY;
      const deltaX = newPrimaryX - dragState.startX;
      const deltaY = newPrimaryY - dragState.startY;
      applyGraphChange(({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }) => ({
        nodes: currentNodes.map((node) => {
          if (node.id === dragState.nodeId) {
            return { ...node, position: { x: newPrimaryX, y: newPrimaryY } };
          }
          const startPos = multiDragRef.current[node.id];
          if (startPos !== undefined) {
            return { ...node, position: { x: startPos.x + deltaX, y: startPos.y + deltaY } };
          }
          return node;
        }),
        edges: currentEdges,
        groups: currentGroups,
      }), { history: "debounced" });
    }
  }, [applyGraphChange, toCanvas, panStart, dragState]);

  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || spacePanning))) {
      // Middle click or ctrl/space + drag = pan
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      e.preventDefault();
    } else if (e.button === 0 && e.target === canvasRef.current?.querySelector(".canvas-bg")) {
      // Click/drag on background: start marquee selection
      if (!e.shiftKey) {
        selectedNodeId.value = null;
        selectedEdgeId.value = null;
        setSelectedNodeIds(new Set());
    setSelectedGroupId(null);
      }
      setEditingNode(null);
      setContextMenu(null);
      const canvasPos = toCanvas(e.clientX, e.clientY);
      marqueeStartRef.current = canvasPos;
      setMarquee({ x: canvasPos.x, y: canvasPos.y, w: 0, h: 0 });
    }
  }, [pan, spacePanning, toCanvas]);

  const onMouseMove = useCallback((e) => {
    movePointer(e.clientX, e.clientY);
  }, [movePointer]);

  const onMouseUp = useCallback(() => {
    if (panStart) setPanStart(null);
    if (dragState) {
      setDragState(null);
      multiDragRef.current = {};
      flushPendingHistory();
    }
    if (connecting) {
      setConnecting(null);
    }
    if (marqueeStartRef.current) {
      const m = marquee;
      if (m && m.w > 4 && m.h > 4) {
        const ids = new Set();
        for (const node of nodesRef.current) {
          const nx = node.position?.x || 0;
          const ny = node.position?.y || 0;
          if (nx + NODE_W > m.x && nx < m.x + m.w && ny + NODE_H > m.y && ny < m.y + m.h) {
            ids.add(node.id);
          }
        }
        if (ids.size > 0) {
          setSelectedNodeIds(ids);
          selectedNodeId.value = [...ids][0];
        }
      }
      marqueeStartRef.current = null;
      setMarquee(null);
    }
  }, [panStart, dragState, connecting, marquee, flushPendingHistory]);

  const onPointerDown = useCallback((e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    const isNodeTarget = Boolean(e.target?.closest?.(".wf-node"));
    if (!isNodeTarget) {
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      selectedNodeId.value = null;
      selectedEdgeId.value = null;
      setEditingNode(null);
      setContextMenu(null);
    }
    try {
      canvasRef.current?.setPointerCapture?.(e.pointerId);
    } catch {}
    e.preventDefault();
  }, [pan]);

  const onPointerMove = useCallback((e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    if (!panStart && !dragState && !connecting) return;
    movePointer(e.clientX, e.clientY);
    e.preventDefault();
  }, [panStart, dragState, connecting, movePointer]);

  const onPointerUp = useCallback((e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    try {
      canvasRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {}
    if (panStart) setPanStart(null);
    if (dragState) {
      setDragState(null);
      multiDragRef.current = {};
      flushPendingHistory();
    }
    if (connecting) {
      setConnecting(null);
    }
    e.preventDefault();
  }, [panStart, dragState, connecting, flushPendingHistory]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.2, Math.min(3, z + delta)));
  }, []);

  const onCanvasDoubleClick = useCallback((e) => {
    const target = e.target;
    const isBackgroundTarget =
      target === e.currentTarget ||
      target?.classList?.contains?.("canvas-bg");
    if (!isBackgroundTarget) return;
    e.preventDefault();
    openNodePalette(toCanvas(e.clientX, e.clientY));
  }, [openNodePalette, toCanvas]);

  // ── Node interaction ──────────────────────────────────────

  const startGroupDrag = useCallback((groupId, clientX, clientY) => {
    const normalizedGroupId = String(groupId || "").trim();
    if (!normalizedGroupId) return false;
    const group = (groups || []).find((entry) => entry.id === normalizedGroupId) || null;
    if (!group) return false;
    const canvasPos = toCanvas(clientX, clientY);
    const startPositions = Object.fromEntries(
      (nodes || [])
        .filter((entry) => group.nodeIds?.includes(entry.id))
        .map((entry) => [entry.id, { x: entry.position?.x || 0, y: entry.position?.y || 0 }]),
    );
    setSelectedGroupId(group.id);
    setSelectedNodeIds(new Set(group.nodeIds || []));
    selectedNodeId.value = null;
    selectedEdgeId.value = null;
    setEditingNode(null);
    setContextMenu(null);
    setDragState({
      kind: "group",
      groupId: group.id,
      anchorX: canvasPos.x,
      anchorY: canvasPos.y,
      startPositions,
    });
    return true;
  }, [groups, nodes, toCanvas]);

  const onGroupMouseDown = useCallback((groupId, e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    startGroupDrag(groupId, e.clientX, e.clientY);
  }, [startGroupDrag]);

  const onGroupPointerDown = useCallback((groupId, e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    e.stopPropagation();
    if (startGroupDrag(groupId, e.clientX, e.clientY)) {
      try {
        canvasRef.current?.setPointerCapture?.(e.pointerId);
      } catch {}
      e.preventDefault();
    }
  }, [startGroupDrag]);

  const onGroupContextMenu = useCallback((groupId, e) => {
    e.preventDefault();
    e.stopPropagation();
    const group = (groups || []).find((entry) => entry.id === String(groupId || "").trim()) || null;
    if (!group) return;
    setSelectedGroupId(group.id);
    setSelectedNodeIds(new Set(group.nodeIds || []));
    selectedNodeId.value = null;
    selectedEdgeId.value = null;
    setContextMenu({ x: e.clientX, y: e.clientY, groupId: group.id });
  }, [groups]);

  const onNodeMouseDown = useCallback((nodeId, e) => {
    e.stopPropagation();
    let newSelectedIds;
    if (e.shiftKey) {
      // Shift-click: toggle node in/out of selection
      newSelectedIds = new Set(selectedNodeIds);
      if (newSelectedIds.has(nodeId)) newSelectedIds.delete(nodeId);
      else newSelectedIds.add(nodeId);
      setSelectedNodeIds(newSelectedIds);
      selectedNodeId.value = nodeId;
    } else if (selectedNodeIds.has(nodeId) && selectedNodeIds.size > 1) {
      // Clicking a node already in multi-selection: keep all selected, drag all
      newSelectedIds = selectedNodeIds;
    } else {
      // Normal click: single-select
      newSelectedIds = new Set([nodeId]);
      setSelectedNodeIds(newSelectedIds);
      selectedNodeId.value = nodeId;
    }
    setContextMenu(null);
    const proxyNode = renderNodes.find((entry) => entry.id === nodeId && entry.isGroupProxy);
    if (proxyNode) {
      startGroupDrag(proxyNode.groupId, e.clientX, e.clientY);
      return;
    }
    const canvasPos = toCanvas(e.clientX, e.clientY);
    setSelectedGroupId(null);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      // Store start positions for all nodes in the drag group
      multiDragRef.current = {};
      for (const id of newSelectedIds) {
        const nd = nodes.find(n2 => n2.id === id);
        if (nd) multiDragRef.current[id] = { x: nd.position?.x || 0, y: nd.position?.y || 0 };
      }
      setDragState({
        nodeId,
        offsetX: canvasPos.x - (node.position?.x || 0),
        offsetY: canvasPos.y - (node.position?.y || 0),
        startX: node.position?.x || 0,
        startY: node.position?.y || 0,
      });
    }
  }, [nodes, renderNodes, selectedNodeIds, startGroupDrag, toCanvas]);

  const onNodePointerDown = useCallback((nodeId, e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    e.stopPropagation();
    const proxyNode = renderNodes.find((entry) => entry.id === nodeId && entry.isGroupProxy);
    if (proxyNode) {
      if (startGroupDrag(proxyNode.groupId, e.clientX, e.clientY)) {
        try {
          canvasRef.current?.setPointerCapture?.(e.pointerId);
        } catch {}
        e.preventDefault();
      }
      return;
    }
    const newSelectedIds = new Set([nodeId]);
    setSelectedNodeIds(newSelectedIds);
    setSelectedGroupId(null);
    selectedNodeId.value = nodeId;
    setContextMenu(null);
    const canvasPos = toCanvas(e.clientX, e.clientY);
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      multiDragRef.current = { [nodeId]: { x: node.position?.x || 0, y: node.position?.y || 0 } };
      setDragState({
        nodeId,
        offsetX: canvasPos.x - (node.position?.x || 0),
        offsetY: canvasPos.y - (node.position?.y || 0),
        startX: node.position?.x || 0,
        startY: node.position?.y || 0,
      });
    }
    try {
      canvasRef.current?.setPointerCapture?.(e.pointerId);
    } catch {}
    e.preventDefault();
  }, [nodes, renderNodes, startGroupDrag, toCanvas]);

  const onNodeDoubleClick = useCallback((nodeId) => {
    setEditingNode(nodeId);
  }, []);

  const onNodeContextMenu = useCallback((nodeId, e) => {
    e.preventDefault();
    e.stopPropagation();
    const proxyNode = renderNodes.find((entry) => entry.id === nodeId && entry.isGroupProxy);
    if (proxyNode) {
      onGroupContextMenu(proxyNode.groupId, e);
      return;
    }
    selectedNodeId.value = nodeId;
    setSelectedGroupId(null);
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
  }, [onGroupContextMenu, renderNodes]);

  // ── Port / connection interaction ─────────────────────────

  const showConnectionHint = useCallback((message, clientX, clientY) => {
    setConnectionHint({
      message,
      x: Math.max(12, Math.round(clientX || 0) + 12),
      y: Math.max(12, Math.round(clientY || 0) + 12),
      expiresAt: Date.now() + 2200,
    });
  }, []);

  const showPortHoverHint = useCallback((port, clientX, clientY) => {
    if (!port) {
      setPortHoverHint(null);
      return;
    }
    const type = String(port.type || "Any").trim() || "Any";
    const description = String(port.description || "").trim();
    const label = String(port.label || port.name || "Port").trim() || "Port";
    setPortHoverHint({
      message: `${label} (${type})${description ? ` - ${description}` : ""}`,
      x: Math.max(12, Math.round(clientX || 0) + 12),
      y: Math.max(12, Math.round(clientY || 0) + 12),
    });
  }, []);

  const getNodeById = useCallback((nodeId) => (renderNodes.find((node) => node.id === nodeId) || nodesRef.current.find((node) => node.id === nodeId) || null), [renderNodes]);

  const getOutputPortDescriptor = useCallback((nodeId, portName = "default") => {
    const node = getNodeById(nodeId);
    if (!node) return null;
    const ports = resolveNodePorts(node, nodeTypeMap).outputs;
    return ports.find((port) => port.name === portName) || ports[0] || null;
  }, [getNodeById, nodeTypeMap]);

  const getInputPortDescriptor = useCallback((nodeId, portName = "default") => {
    const node = getNodeById(nodeId);
    if (!node) return null;
    const ports = resolveNodePorts(node, nodeTypeMap).inputs;
    return ports.find((port) => port.name === portName) || ports[0] || null;
  }, [getNodeById, nodeTypeMap]);

  const getEdgePortBindingState = useCallback((edge) => {
    if (!edge) return null;
    const validation = validateEdgePortMapping(edge, nodeLookup, nodeTypeMap);
    return {
      edge,
      sourceNode: validation.sourceNode,
      targetNode: validation.targetNode,
      sourcePorts: validation.sourcePorts,
      targetPorts: validation.targetPorts,
      requestedSourcePort: validation.requestedSourcePortName || validation.sourcePort?.name || "default",
      requestedTargetPort: validation.requestedTargetPortName || validation.targetPort?.name || "default",
      sourcePort: validation.sourcePort,
      targetPort: validation.targetPort,
      validationErrors: validation.issues.map((issue) => issue.message),
    };
  }, [nodeLookup, nodeTypeMap]);

  const updateEdgePortMapping = useCallback((edgeId, patch = {}) => {
    const edge = edgesRef.current.find((entry) => entry.id === edgeId) || null;
    if (!edge) return false;

    const patchCheck = canUpdateCanvasEdgePortMapping(edge, patch, nodesRef.current, nodeTypeMap);
    if (!patchCheck.allowed) {
      showToast(patchCheck.blockingIssue?.message || "Invalid port binding", "error");
      return false;
    }

    const validation = patchCheck.validation;
    const nextSourcePortName = validation.sourcePort?.name || validation.requestedSourcePortName || "default";
    const nextTargetPortName = validation.targetPort?.name || validation.requestedTargetPortName || "default";
    const nextEdgeId = `${edge.source}:${nextSourcePortName}->${edge.target}:${nextTargetPortName}`;
    const duplicate = edgesRef.current.some((entry) => (
      entry.id !== edgeId
      && entry.source === edge.source
      && entry.target === edge.target
      && String(entry.sourcePort ?? entry.fromPort ?? "default").trim() === nextSourcePortName
      && String(entry.targetPort ?? entry.toPort ?? "default").trim() === nextTargetPortName
    ));
    if (duplicate) {
      showToast("An edge with the selected port binding already exists", "error");
      return false;
    }

    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: currentNodes,
      edges: currentEdges.map((entry) => {
        if (entry.id !== edgeId) return entry;
        return {
          ...entry,
          ...patch,
          id: nextEdgeId,
          sourcePort: nextSourcePortName,
          targetPort: nextTargetPortName,
          sourcePortType: validation.sourcePort?.type || "Any",
          targetPortType: validation.targetPort?.type || "Any",
        };
      }),
    }));
    selectedEdgeId.value = nextEdgeId;
    return true;
  }, [applyGraphChange, nodeTypeMap]);

  const onOutputPortMouseDown = useCallback((nodeId, portName, e) => {
    e.stopPropagation();
    const sourcePort = getOutputPortDescriptor(nodeId, portName);
    setConnecting({
      sourceId: nodeId,
      sourcePort: sourcePort?.name || portName || "default",
      startX: e.clientX,
      startY: e.clientY,
    });
  }, [getOutputPortDescriptor]);

  const onOutputPortPointerDown = useCallback((nodeId, portName, e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    e.stopPropagation();
    const sourcePort = getOutputPortDescriptor(nodeId, portName);
    setConnecting({
      sourceId: nodeId,
      sourcePort: sourcePort?.name || portName || "default",
      startX: e.clientX,
      startY: e.clientY,
    });
    movePointer(e.clientX, e.clientY);
    try {
      canvasRef.current?.setPointerCapture?.(e.pointerId);
    } catch {}
    e.preventDefault();
  }, [getOutputPortDescriptor, movePointer]);

  const onInputPortMouseUp = useCallback((nodeId, targetPortName = "default", eventMeta = null) => {
    if (connecting && connecting.sourceId !== nodeId) {
      const sourcePort = getOutputPortDescriptor(connecting.sourceId, connecting.sourcePort || "default");
      const targetPort = getInputPortDescriptor(nodeId, targetPortName);
      const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
      if (!compatibility.compatible) {
        showConnectionHint(
          compatibility.reason || "Incompatible port types",
          eventMeta?.clientX || mousePos.x,
          eventMeta?.clientY || mousePos.y,
        );
        setConnecting(null);
        return;
      }
      const edgeId = `${connecting.sourceId}:${sourcePort?.name || "default"}->${nodeId}:${targetPort?.name || "default"}`;
      const exists = edgesRef.current.some((edge) =>
        edge.source === connecting.sourceId
        && edge.target === nodeId
        && String(edge.sourcePort || "default") === String(sourcePort?.name || "default")
        && String(edge.targetPort || "default") === String(targetPort?.name || "default")
      );
      if (!exists) {
        applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
          nodes: currentNodes,
          edges: [...currentEdges, {
            id: edgeId,
            source: connecting.sourceId,
            target: nodeId,
            sourcePort: sourcePort?.name || "default",
            targetPort: targetPort?.name || "default",
            sourcePortType: sourcePort?.type || "Any",
            targetPortType: targetPort?.type || "Any",
          }],
        }));
      }
    }
    setConnecting(null);
  }, [applyGraphChange, connecting, getInputPortDescriptor, getOutputPortDescriptor, mousePos.x, mousePos.y, showConnectionHint]);

  const onInputPortPointerUp = useCallback((nodeId, portName, e) => {
    if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
    e.stopPropagation();
    onInputPortMouseUp(nodeId, portName, { clientX: e.clientX, clientY: e.clientY });
    e.preventDefault();
  }, [onInputPortMouseUp]);

  // ── CRUD ──────────────────────────────────────────────────

  const addNode = useCallback((type, position = paletteInsertPoint || getDefaultInsertPoint()) => {
    const id = `node-${Date.now()}-${Math.round(Math.random() * 1000)}`;
    const name = type.split(".").pop();
    const typeInfo = nodeTypeMap.get(type) || null;
    const nextConfig = {};
    const schemaProps = typeInfo?.schema?.properties || {};
    for (const [key, field] of Object.entries(schemaProps)) {
      if (Object.prototype.hasOwnProperty.call(field || {}, "default")) {
        nextConfig[key] = field.default;
      }
    }
    const ports = resolveNodePorts({ type }, nodeTypeMap);
    const newNode = {
      id,
      type,
      label: name?.replace(/_/g, " ") || type,
      config: nextConfig,
      position: position || { x: 300, y: 300 },
      inputPorts: ports.inputs,
      outputPorts: ports.outputs,
      outputs: ["default"],
    };
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: [...currentNodes, newNode],
      edges: currentEdges,
    }));
    selectedNodeId.value = id;
    selectedEdgeId.value = null;
    setSelectedNodeIds(new Set([id]));
    closeNodePalette();
    haptic("light");
  }, [applyGraphChange, closeNodePalette, getDefaultInsertPoint, nodeTypeMap, paletteInsertPoint]);

  const deleteNode = useCallback((nodeId) => {
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: currentNodes.filter((node) => node.id !== nodeId),
      edges: currentEdges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    }));
    if (selectedNodeId.value === nodeId) selectedNodeId.value = null;
    setSelectedNodeIds((current) => {
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    setEditingNode(null);
    setContextMenu(null);
  }, [applyGraphChange]);

  const deleteEdge = useCallback((edgeId) => {
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: currentNodes,
      edges: currentEdges.filter((edge) => edge.id !== edgeId),
    }));
    selectedEdgeId.value = null;
  }, [applyGraphChange]);

  const duplicateNode = useCallback((nodeId) => {
    const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!sourceNode) return;
    const clone = {
      ...sourceNode,
      id: `node-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      position: {
        x: (sourceNode.position?.x || 0) + 40,
        y: (sourceNode.position?.y || 0) + 40,
      },
    };
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: [...currentNodes, clone],
      edges: currentEdges,
    }));
    selectedNodeId.value = clone.id;
    selectedEdgeId.value = null;
    setSelectedNodeIds(new Set([clone.id]));
    setContextMenu(null);
  }, [applyGraphChange]);

  const updateNodeConfig = useCallback((nodeId, configPatch) => {
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: currentNodes.map((node) => (
        node.id === nodeId ? { ...node, config: { ...node.config, ...configPatch } } : node
      )),
      edges: currentEdges,
    }), { history: "debounced" });
  }, [applyGraphChange]);

  const updateNodeLabel = useCallback((nodeId, label) => {
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges }) => ({
      nodes: currentNodes.map((node) => (
        node.id === nodeId ? { ...node, label } : node
      )),
      edges: currentEdges,
    }), { history: "debounced" });
  }, [applyGraphChange]);


  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!connectionHint) return undefined;
    const remaining = Math.max(120, (connectionHint.expiresAt || Date.now() + 1200) - Date.now());
    const timer = setTimeout(() => {
      setConnectionHint((current) => (current === connectionHint ? null : current));
    }, remaining);
    return () => clearTimeout(timer);
  }, [connectionHint]);

  useEffect(() => {
    if (connecting) return undefined;
    setPortHoverHint(null);
    return undefined;
  }, [connecting]);

  const handleCreateGroup = useCallback(() => {
    const nodeIds = [...selectedNodeIds].filter(Boolean);
    if (nodeIds.length < 2) return;
    const label = window.prompt("Group name", "New Group");
    if (label == null) return;
    const nextGroupId = `group-${Date.now()}`;
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }) => ({
      nodes: currentNodes,
      edges: currentEdges,
      groups: createNodeGroup({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }, nodeIds, {
        id: nextGroupId,
        label,
        color: "#8b5cf6",
      }).groups,
    }));
    setSelectedGroupId(nextGroupId);
  }, [applyGraphChange, selectedNodeIds]);

  const handleToggleActiveGroup = useCallback(() => {
    if (!activeGroup) return;
    applyGraphChange(({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }) => ({
      nodes: currentNodes,
      edges: currentEdges,
      groups: toggleWorkflowGroupCollapsed({ nodes: currentNodes, edges: currentEdges, groups: currentGroups }, activeGroup.id).groups,
    }));
    setSelectedGroupId(activeGroup.id);
  }, [activeGroup, applyGraphChange]);

  const handleImportWorkflowJson = useCallback(async () => {
    try {
      const parsed = JSON.parse(importJsonText);
      const payload = parsed?.workflow ? parsed : { workflow: parsed };
      const data = await apiFetch("/api/workflows/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (data?.workflow) {
        activeWorkflow.value = data.workflow;
        viewMode.value = "canvas";
        setImportDialogOpen(false);
        setImportJsonText("");
        showToast("Workflow imported", "success");
        loadWorkflows();
      }
    } catch (err) {
      showToast("Import failed: " + (err.message || err), "error");
    }
  }, [importJsonText]);

  const handleImportWorkflowFile = useCallback(async (event) => {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportJsonText(text);
    setImportDialogOpen(true);
    event.target.value = "";
  }, []);

  const handleConvertToSubworkflow = useCallback(async () => {
    const nodeIds = [...selectedNodeIds].filter(Boolean);
    if (!workflow?.id || nodeIds.length === 0) return;
    const childName = window.prompt("New sub-workflow name", `${workflow.name || "Workflow"} Sub-workflow`);
    if (childName == null) return;
    const converted = convertSelectionToSubworkflow({ ...workflow, nodes, edges, groups }, nodeIds, {
      childWorkflowId: `sub-${Date.now()}`,
      childName,
      executeNodeId: `execute-sub-${Date.now()}`,
      executeNodeLabel: childName,
    });
    const persistedChild = buildPersistedWorkflowDefinition(
      converted.childWorkflow,
      converted.childWorkflow?.nodes || [],
      converted.childWorkflow?.edges || [],
      converted.childWorkflow?.groups || [],
    );
    const savedChild = await saveWorkflow(persistedChild || converted.childWorkflow, { activate: false, suppressToast: true });
    if (!savedChild?.id) return;
    const parentWithSavedId = {
      ...converted.parentWorkflow,
      nodes: converted.parentWorkflow.nodes.map((node) => (
        node.id === converted.executeNode.id
          ? { ...node, config: { ...(node.config || {}), workflowId: savedChild.id } }
          : node
      )),
    };
    const persistedParent = buildPersistedWorkflowDefinition(
      parentWithSavedId,
      parentWithSavedId?.nodes || [],
      parentWithSavedId?.edges || [],
      parentWithSavedId?.groups || [],
    );
    const savedParent = await saveWorkflow(persistedParent || parentWithSavedId, { toastMessage: "Sub-workflow created" });
    if (savedParent) {
      setSelectedNodeIds(new Set([converted.executeNode.id]));
      selectedNodeId.value = converted.executeNode.id;
      setSelectedGroupId(null);
    }
  }, [buildPersistedWorkflowDefinition, convertSelectionToSubworkflow, edges, groups, nodes, selectedNodeIds, workflow]);

  const handleExpandInline = useCallback(async () => {
    const selectedId = String(selectedNodeId.value || "").trim();
    const node = nodes.find((entry) => entry.id === selectedId) || null;
    const workflowId = String(node?.config?.workflowId || "").trim();
    if (!workflowId) return;
    try {
      const data = await apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}`);
      if (data?.workflow) setInlinePreview(data.workflow);
    } catch (err) {
      showToast("Failed to load inline workflow preview", "error");
    }
  }, [nodes]);
  // ── Render helpers ────────────────────────────────────────

  const getNodeCenter = (nodeId) => {
    const n = renderNodes.find((value) => value.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    const width = Number(n?.size?.width || NODE_W);
    const height = Number(n?.size?.height || NODE_H);
    return { x: (n.position?.x || 0) + width / 2, y: (n.position?.y || 0) + height / 2 };
  };

  const getNodePortPosition = (nodeId, direction, portName = "default") => {
    const n = renderNodes.find((value) => value.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    const ports = resolveNodePorts(n, nodeTypeMap)[direction === "input" ? "inputs" : "outputs"];
    const index = Math.max(0, ports.findIndex((port) => port.name === portName));
    const spread = 24;
    const width = Number(n?.size?.width || NODE_W);
    const height = Number(n?.size?.height || NODE_H);
    const centerY = height / 2 + 10;
    const offsetY = (index - ((ports.length - 1) / 2)) * spread;
    return {
      x: (n.position?.x || 0) + (direction === "input" ? 0 : width),
      y: (n.position?.y || 0) + centerY + offsetY,
    };
  };

  // Bezier curve between points
  const curvePath = (x1, y1, x2, y2) => {
    const dx = Math.abs(x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  // ── Render ────────────────────────────────────────────────

  return html`
    <div
      class="wf-canvas-container"
      data-ptr-ignore="true"
      style="position: relative; width: 100%; overflow: hidden; overscroll-behavior: contain; background: var(--color-bg-secondary, #0f1117);"
    >

      <!-- Toolbar -->
      <div class="wf-toolbar" style="position: absolute; top: 12px; left: 12px; right: 12px; z-index: 20; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <${Button} variant="text" size="small" onClick=${returnToWorkflowList}>
          ← Back to Workflows
        <//>
        <${Button}
          variant="outlined"
          size="small"
          onClick=${() => openWorkflowCopilotFromCanvas({
            intent: "explain",
            title: `Explain workflow ${workflow?.name || workflow?.id || ""}`.trim(),
            successToast: "Opened workflow explanation chat",
          })}
        >
          <span class="btn-icon">${resolveIcon("bot")}</span>
          Explain With Bosun
        <//>
        <${Button} variant="contained" size="small" onClick=${() => openNodePalette()} sx=${{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style="font-size: 18px;">+</span> Add Node /
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => {
          if (!workflow) return;
          if (reportEdgeValidationIssues()) return;
          const persistedWorkflow = buildPersistedWorkflowDefinition(
            workflow,
            nodesRef.current,
            edgesRef.current,
            groupsRef.current,
          );
          if (persistedWorkflow) saveWorkflow(persistedWorkflow);
        }}>
          <span class="btn-icon">${resolveIcon("save")}</span>
          Save
        <//>
        <${Button}
          variant="outlined"
          size="small"
          sx=${workflow?.enabled === false ? { opacity: 0.65 } : {}}
          onClick=${() => {
            if (!workflow?.id) return;
            if (workflow?.enabled === false) {
              showToast("Workflow is paused. Resume it before running.", "warning");
              return;
            }
            if (reportEdgeValidationIssues()) {
              return;
            }
            openExecuteDialog(workflow.id);
          }}
        >
          <span class="btn-icon">${resolveIcon("play")}</span>
          Run
        <//>
        <${Button}
          variant="outlined"
          size="small"
          onClick=${() => openWorkflowRunsView(workflow?.id)}
        >
          <span class="btn-icon">${resolveIcon("chart")}</span>
          Runs
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => { viewMode.value = "code"; }}>
          <span class="btn-icon">${resolveIcon("settings")}</span>
          Code
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => exportWorkflow({ ...workflow, nodes, edges, groups })}>
          <span class="btn-icon">${resolveIcon("save")}</span>
          Export
        <//>
        <input type="file" accept="application/json,.json" style="display:none;" id="workflow-import-file" onChange=${handleImportWorkflowFile} />
        <${Button} variant="outlined" size="small" onClick=${() => setImportDialogOpen(true)}>
          <span class="btn-icon">${resolveIcon("download")}</span>
          Import
        <//>
        <${Button} variant="text" size="small" onClick=${() => document.getElementById("workflow-import-file")?.click()}>Upload JSON<//>
        ${workflow?.metadata?.installedFrom && html`<${Button}
          variant="outlined"
          size="small"
          onClick=${() => relayoutTemplateWorkflow(workflow.id)}
        >
          <span class="btn-icon">${resolveIcon("refresh")}</span>
          Re-layout
        <//>`}
        ${workflow?.core !== true && html`<${Button}
          variant="outlined"
          size="small"
          onClick=${() => {
            if (!workflow?.id) return;
            setWorkflowEnabled(workflow.id, workflow?.enabled === false);
          }}
        >
          <span class="btn-icon">${resolveIcon(workflow?.enabled === false ? "play" : "pause")}</span>
          ${workflow?.enabled === false ? "Resume" : "Pause"}
        <//>`}
        ${workflow?.core === true && html`<span class="wf-badge" style="background: #8b5cf620; color: #a78bfa; font-size: 11px; font-weight: 600;">Core</span>`}
        <${Button} variant="text" size="small" disabled=${historyState.past.length === 0} onClick=${undoCanvas}>Undo<//>
        <${Button} variant="text" size="small" disabled=${historyState.future.length === 0} onClick=${redoCanvas}>Redo<//>
        <${Button} variant="text" size="small" onClick=${() => setShowShortcutOverlay(true)}>Shortcuts ?<//>
        <div style="flex:1;"></div>
        ${selectedNodeIds.size > 1 && html`<${Button} variant="text" size="small" onClick=${handleCreateGroup}>Create Group<//>`}
        ${activeGroup && html`<${Button} variant="text" size="small" onClick=${handleToggleActiveGroup}>${activeGroup.collapsed ? "Expand Group" : "Collapse Group"}<//>`}
        ${selectedNodeIds.size > 0 && html`<${Button} variant="text" size="small" onClick=${handleConvertToSubworkflow}>Convert to Sub-workflow<//>`}
        ${(() => { const selected = nodes.find((entry) => entry.id === selectedNodeId.value); return selected && ["action.execute_workflow", "flow.universal"].includes(selected.type); })() && html`<${Button} variant="text" size="small" onClick=${handleExpandInline}>Expand Inline<//>`}
        ${selectedNodeIds.size > 1 && html`
          <span class="wf-badge" style="font-size: 11px; background: #3b82f640; color: #60a5fa; border: 1px solid #3b82f660;">
            ${selectedNodeIds.size} nodes selected · Del to delete
          </span>
        `}
        <span class="wf-badge" style="font-size: 11px; opacity: 0.7;">
          ${nodes.length} nodes · ${edges.length} edges · Zoom: ${Math.round(zoom * 100)}%
        </span>
        <span class="wf-badge" style="font-size: 11px; opacity: 0.75;">
          ${workflow?.enabled === false ? "Paused" : "Active"} · Pan: touch drag, Ctrl/Space + drag
        </span>
        <div style="display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--color-text-secondary, #8b95a5);">
          <${Switch}
            size="small"
            checked=${liveHighlightEnabled}
            onChange=${(e) => setLiveHighlightEnabled(Boolean(e.target.checked))}
          />
          <span>Live highlights</span>
        </div>
        ${liveHighlightEnabled && liveRun?.runId && html`
          <span class="wf-badge" style="font-size: 11px; background: ${getRunStatusBadgeStyles(liveRun.status).bg}; color: ${getRunStatusBadgeStyles(liveRun.status).color};">
            ${liveRun.status === "running" ? "Live Run" : "Last Run"} · ${formatDuration(liveRunDuration)}
          </span>
        `}
        ${liveHighlightEnabled && hasLiveStatuses && html`
          <span class="wf-badge" style="font-size: 11px; background: var(--accent-soft, rgba(59,130,246,0.18)); color: var(--accent, #60a5fa);">
            ${liveActiveNodes} active node${liveActiveNodes === 1 ? "" : "s"}
          </span>
        `}
        <${Button} variant="text" size="small" onClick=${() => setZoom(1)}>Reset Zoom<//>
        <${Button} variant="text" size="small" onClick=${() => setPan({ x: 0, y: 0 })}>Reset Pan<//>
        <${Button} variant="text" size="small" onClick=${returnToWorkflowList}>← Back to Workflows<//>
      </div>

      <div style="position: absolute; top: 64px; right: 12px; z-index: 18; width: min(340px, calc(100vw - 24px)); pointer-events: none; display: flex; flex-direction: column; gap: 12px;">
        <div style="pointer-events: auto; background: var(--bg-card, #2b2a27); border: 1px solid var(--color-border, #2a3040); border-radius: 12px; backdrop-filter: blur(8px); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.28)); overflow: hidden; color: var(--color-text, #e8eaf0);">
          <div style="display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom: 1px solid var(--color-border, #2a3040);">
            <span class="icon-inline">${resolveIcon("chart")}</span>
            <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.02em; flex:1;">Workflow Runs</div>
            <span class="wf-badge" style="font-size: 10px; background: var(--bg-secondary, #1f2937); color: var(--text-secondary, #cbd5e1);">${recentRunsTotal || recentRuns.length} total</span>
            ${recentRuns.some((run) => run?.status === "running") && html`<span class="wf-badge" style="font-size: 10px; background: var(--accent-soft, rgba(59,130,246,0.18)); color: var(--accent, #60a5fa);">active</span>`}
            <${Button} variant="text" size="small" onClick=${() => setRunsPanelOpen((open) => !open)}>${runsPanelOpen ? "Hide" : "Show"}<//>
          </div>
          ${runsPanelOpen && html`
            <div style="padding: 10px 10px 12px; display:flex; flex-direction:column; gap:8px;">
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <${Button} variant="outlined" size="small" onClick=${() => openWorkflowRunsView(workflow?.id)}>View all runs<//>
                ${liveRun?.runId && html`<${Button} variant="text" size="small" onClick=${() => openWorkflowRunsView(workflow?.id, liveRun.runId)}>Open current run<//>`}
              </div>
              ${recentRunsLoading && recentRuns.length === 0 && html`<div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">Loading recent runs…</div>`}
              ${!recentRunsLoading && recentRuns.length === 0 && html`<div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">No runs recorded for this workflow yet.</div>`}
              ${recentRuns.map((run) => {
                const styles = getRunStatusBadgeStyles(run?.status);
                const lastActivityAt = getRunActivityAt(run);
                return html`
                  <button
                    key=${run.runId}
                    type="button"
                    onClick=${() => openWorkflowRunsView(workflow?.id, run.runId)}
                    style="text-align:left; width:100%; border:1px solid ${run?.status === 'running' ? 'var(--accent, #60a5fa)' : 'var(--color-border, #2a3040)'}; border-radius:10px; background:var(--bg-secondary, #111827); color:inherit; padding:10px; display:flex; gap:10px; cursor:pointer; box-shadow: var(--shadow-sm, none);"
                  >
                    <div style="flex:1; min-width:0;">
                      <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                        <span class="wf-badge" style="background:${styles.bg}; color:${styles.color}; font-size:10px;">${run?.status || 'unknown'}</span>
                        <span style="font-size:11px; color: var(--color-text-secondary, #94a3b8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${String(run?.runId || '').slice(0, 12) || 'run'}</span>
                      </div>
                      <div style="font-size:12px; font-weight:600; color:var(--color-text, #e5e7eb); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${formatRelative(run?.startedAt)}</div>
                      <div style="font-size:11px; color: var(--color-text-secondary, #8b95a5); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        ${formatDuration(run?.status === 'running' && run?.startedAt ? Math.max(0, liveNowTick - Number(run.startedAt)) : Number(run?.duration) || 0)}
                        ${lastActivityAt ? ` · active ${formatRelative(lastActivityAt)}` : ''}
                        ${run?.errorCount ? ` · ${run.errorCount} error${run.errorCount === 1 ? '' : 's'}` : ''}
                      </div>
                    </div>
                    <div style="display:flex; align-items:center; color:var(--color-text-secondary, #94a3b8);">${resolveIcon('arrow-right') || '→'}</div>
                  </button>
                `;
              })}
            </div>
          `}
        </div>
        <div style="pointer-events: auto; background: var(--bg-card, #2b2a27); border: 1px solid var(--color-border, #2a3040); border-radius: 12px; backdrop-filter: blur(8px); box-shadow: var(--shadow-lg, 0 10px 30px rgba(0,0,0,0.28)); overflow: hidden; color: var(--color-text, #e8eaf0);">
          <div style="display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom: 1px solid var(--color-border, #2a3040);">
            <span class="icon-inline">${resolveIcon("git-branch") || ICONS.dot}</span>
            <div style="font-size: 12px; font-weight: 700; letter-spacing: 0.02em; flex:1;">Draft Flowchart</div>
            <span class="wf-badge" style="font-size: 10px; background: var(--bg-secondary, #1f2937); color: var(--text-secondary, #cbd5e1);">${draftFlowchart.steps.length} step${draftFlowchart.steps.length === 1 ? "" : "s"}</span>
            <span class="wf-badge" style="font-size: 10px; background: ${draftFlowchart.source === "derived" ? "rgba(245,158,11,0.18)" : "rgba(96,165,250,0.18)"}; color: ${draftFlowchart.source === "derived" ? "#fbbf24" : "#93c5fd"};">${draftFlowchart.source === "derived" ? "Derived" : "Saved"}</span>
          </div>
          <div style="padding: 10px 10px 12px; display:flex; flex-direction:column; gap:10px;">
            <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
              Flowchart Map keeps the design view linked to built runtime nodes so we can inspect the plan and execution shape together.
            </div>
            ${draftFlowchart.steps.length === 0 && html`
              <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
                Add nodes or groups to start building a linked flowchart view.
              </div>
            `}
            ${draftFlowchart.steps.length > 0 && html`
              <div style="display:flex; flex-direction:column; gap:8px; max-height: 300px; overflow:auto;">
                ${draftFlowchart.steps.map((step, index) => html`
                  <button
                    key=${step.id}
                    type="button"
                    onClick=${() => focusDraftFlowchartStep(step)}
                    style="text-align:left; width:100%; border:1px solid ${selectedNodeIds.has(step.primaryNodeId) || selectedGroupId === step.groupId ? 'var(--accent, #60a5fa)' : 'var(--color-border, #2a3040)'}; border-radius:10px; background:var(--bg-secondary, #111827); color:inherit; padding:10px; display:flex; gap:10px; cursor:pointer;"
                  >
                    <div style="display:flex; flex-direction:column; align-items:center; gap:4px; min-width:26px;">
                      <span style="font-size:11px; color: var(--color-text-secondary, #94a3b8);">#${index + 1}</span>
                      <span class="wf-badge" style="font-size:10px; background:${step.kind === "group" ? "rgba(16,185,129,0.18)" : "rgba(148,163,184,0.18)"}; color:${step.kind === "group" ? "#6ee7b7" : "#cbd5e1"};">${step.kind}</span>
                    </div>
                    <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
                      <div style="font-size:12px; font-weight:600; color:var(--color-text, #e5e7eb); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${step.label}</div>
                      <div style="font-size:11px; color: var(--color-text-secondary, #8b95a5);">
                        ${step.runtimeNodeCount} runtime node${step.runtimeNodeCount === 1 ? "" : "s"}
                        ${step.groupId ? ` · group ${step.groupId}` : ""}
                      </div>
                      <div style="font-size:11px; color: var(--color-text-secondary, #94a3b8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        Runtime: ${(step.runtimeNodeLabels || []).join(" · ") || step.runtimeNodeIds.join(" · ") || "No runtime nodes linked"}
                      </div>
                    </div>
                  </button>
                `)}
              </div>
            `}
            ${draftFlowchart.links.length > 0 && html`
              <div style="display:flex; flex-direction:column; gap:6px;">
                <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.02em; color: var(--color-text-secondary, #8b95a5);">Flowchart Links</div>
                <div style="display:flex; flex-direction:column; gap:4px; max-height: 120px; overflow:auto;">
                  ${draftFlowchart.links.map((link) => html`
                    <div key=${link.id} style="font-size:11px; color: var(--color-text-secondary, #cbd5e1); border:1px solid var(--color-border, #243041); border-radius:8px; padding:6px 8px; background:rgba(15,23,42,0.45);">
                      ${(link.sourceStep?.label || link.sourceStepId)} → ${(link.targetStep?.label || link.targetStepId)}
                      ${link.edgeIds?.length ? ` · ${link.edgeIds.length} runtime edge${link.edgeIds.length === 1 ? "" : "s"}` : ""}
                    </div>
                  `)}
                </div>
              </div>
            `}
          </div>
        </div>
      </div>

      <${NodePalette}
        open=${showNodePalette}
        nodeTypes=${availableNodeTypes}
        insertPoint=${paletteInsertPoint || getDefaultInsertPoint()}
        query=${nodePaletteQuery}
        onQueryChange=${setNodePaletteQuery}
        onSelect=${(type) => addNode(type, paletteInsertPoint || getDefaultInsertPoint())}
        onClose=${closeNodePalette}
      />
      <${KeyboardShortcutOverlay}
        open=${showShortcutOverlay}
        onClose=${() => setShowShortcutOverlay(false)}
        canUndo=${historyState.past.length > 0}
        canRedo=${historyState.future.length > 0}
      />

      <!-- SVG Canvas -->
      <svg
        ref=${canvasRef}
        style="position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; user-select: none; -webkit-user-select: none; cursor: ${panStart ? 'grabbing' : dragState ? 'move' : spacePanning ? 'grab' : marqueeStartRef.current ? 'crosshair' : 'default'};"
        onMouseDown=${onMouseDown}
        onMouseMove=${onMouseMove}
        onMouseUp=${onMouseUp}
        onMouseLeave=${onMouseUp}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}
        onWheel=${onWheel}
        onDblClick=${onCanvasDoubleClick}
        onContextMenu=${(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="translate(${pan.x} ${pan.y}) scale(${zoom})">
            <circle cx="1" cy="1" r="0.5" fill="#ffffff10" />
          </pattern>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280" />
          </marker>
          <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.3" />
          </filter>
          <filter id="node-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#3b82f6" flood-opacity="0.5" />
          </filter>
        </defs>

        <!-- Background grid — covers entire pannable area -->
        <rect class="canvas-bg" x="-10000" y="-10000" width="30000" height="30000" fill="url(#grid-pattern)" />

        <g transform="translate(${pan.x} ${pan.y}) scale(${zoom})">

          <!-- Groups -->
          ${(groups || []).filter((group) => group.collapsed !== true).map((group) => {
            const bounds = resolveWorkflowGroupBounds({ nodes, groups }, group.id);
            const isSelected = selectedGroupId === group.id;
            return html`
              <g key=${group.id}>
                <rect
                  x=${bounds.x}
                  y=${bounds.y}
                  width=${bounds.width}
                  height=${bounds.height}
                  rx="16"
                  fill=${group.color + "18"}
                  stroke=${isSelected ? group.color : (group.color + "88")}
                  stroke-width=${isSelected ? 2.2 : 1.4}
                  style="cursor: grab;"
                  onMouseDown=${(e) => onGroupMouseDown(group.id, e)}
                  onPointerDown=${(e) => onGroupPointerDown(group.id, e)}
                  onContextMenu=${(e) => onGroupContextMenu(group.id, e)}
                />
                <text
                  x=${bounds.x + 14}
                  y=${bounds.y + 22}
                  fill=${group.color}
                  font-size="12"
                  font-weight="700"
                  style="pointer-events: none; user-select: none;"
                >${group.label}</text>
              </g>
            `;
          })}

          <!-- Edges -->
          ${renderEdges.map(edge => {
            const sourcePort = getOutputPortDescriptor(edge.source, edge.sourcePort || "default");
            const from = getNodePortPosition(edge.source, "output", edge.sourcePort || "default");
            const to = getNodePortPosition(edge.target, "input", edge.targetPort || "default");
            const isSelected = selectedEdgeId.value === edge.id;
            const hasCondition = !!edge.condition;
            const edgeColor = sourcePort?.color || (hasCondition ? "#f59e0b" : "#6b7280");
            const edgePath = curvePath(from.x, from.y, to.x, to.y);
            const isActiveFlow = liveHighlightEnabled && liveEdgeActivity[edge.id];
            return html`
              <g
                key=${edge.id}
                class="wf-edge"
                onClick=${(e) => {
                  e.stopPropagation();
                  selectedEdgeId.value = edge.id;
                  selectedNodeId.value = null;
                  setSelectedNodeIds(new Set());
                  setEditingNode(null);
                }}
              >
                <path
                  d=${edgePath}
                  fill="none"
                  stroke=${isSelected ? "#3b82f6" : edgeColor}
                  stroke-width=${isSelected ? 3 : 2}
                  stroke-dasharray=${hasCondition ? "6,4" : "none"}
                  marker-end="url(#arrowhead)"
                  style=${`cursor: pointer; transition: stroke 0.15s, stroke-width 0.15s; ${isActiveFlow ? "filter: drop-shadow(0 0 6px rgba(96,165,250,0.45));" : ""}`}
                />
                ${isActiveFlow && html`
                  <path
                    d=${edgePath}
                    fill="none"
                    stroke="#93c5fd"
                    stroke-width="1.6"
                    stroke-dasharray="12,8"
                    marker-end="url(#arrowhead)"
                    opacity="0.9"
                    style="pointer-events: none;"
                  >
                    <animate attributeName="stroke-dashoffset" values="0;-20" dur="0.45s" repeatCount="indefinite" />
                  </path>
                `}
                <!-- Invisible wider hit area -->
                <path
                  d=${edgePath}
                  fill="none"
                  stroke="transparent"
                  stroke-width="12"
                  style="cursor: pointer;"
                />
                ${isActiveFlow && html`
                  <circle r="3.4" fill="#93c5fd" opacity="0.95">
                    <animateMotion dur="0.95s" repeatCount="1" rotate="auto" path=${edgePath} />
                  </circle>
                `}
                ${hasCondition && html`
                  <text
                    x=${(from.x + to.x) / 2}
                    y=${(from.y + to.y) / 2 - 8}
                    text-anchor="middle"
                    fill="#f59e0b"
                    font-size="10"
                    font-family="monospace"
                  >${edge.condition?.slice(0, 30)}${edge.condition?.length > 30 ? "…" : ""}</text>
                `}
                ${isSelected && html`
                  <text
                    x=${(from.x + to.x) / 2}
                    y=${(from.y + to.y) / 2 + 16}
                    text-anchor="middle"
                    fill="#ef4444"
                    font-size="11"
                    style="cursor: pointer;"
                    onClick=${(e) => { e.stopPropagation(); deleteEdge(edge.id); }}
                  >Remove</text>
                `}
              </g>
            `;
          })}

          <!-- Connecting line (while dragging) -->
          ${connecting && html`
            ${(() => {
              const start = getNodePortPosition(connecting.sourceId, "output", connecting.sourcePort || "default");
              const sourcePort = getOutputPortDescriptor(connecting.sourceId, connecting.sourcePort || "default");
              return html`
            <line
              x1=${start.x}
              y1=${start.y}
              x2=${mousePos.x}
              y2=${mousePos.y}
              stroke=${(sourcePort?.color || "#3b82f6") + "80"}
              stroke-width="2"
              stroke-dasharray="6,4"
            />
            `;
            })()}
          `}

          <!-- Nodes -->
          ${renderNodes.map(node => {
            const meta = getNodeMeta(node.type);
            const typeInfo = nodeTypeMap.get(node.type) || null;
            const ports = resolveNodePorts(node, nodeTypeMap);
            const inlineFields = getInlineFieldDescriptors(typeInfo, node, 2);
            const isSelected = selectedNodeIds.has(node.id);
            const nodeRunStatus = liveHighlightEnabled ? normalizeLiveNodeStatus(liveNodeStatuses[node.id]) : null;
            const nodeFlash = liveNodeFlashStates[node.id] || null;
            const flashState = nodeFlash?.state || "";
            const executionVisuals = getCanvasNodeExecutionVisuals(nodeRunStatus, isSelected, meta.color, flashState);
            const nodeStatusStyles = getRunStatusBadgeStyles(nodeRunStatus);
            const preview = resolveNodeOutputPreview(node.type, liveNodeOutputPreviews[node.id], null);
            const previewLines = preview.lines.slice(0, 3);
            const hasPreview = previewLines.length > 0 || preview.tokenCount != null;
            const runningHintUntil = Number(liveNodeRunningHints[node.id] || 0);
            const hasRunningHint = runningHintUntil > liveNowTick;
            const spinnerVisible = nodeRunStatus === "running" || hasRunningHint;
            const previewPanelY = NODE_HEADER_H + 8;
            const previewPanelH = Math.max(30, NODE_H - previewPanelY - 8);
            const x = node.position?.x || 0;
            const y = node.position?.y || 0;
            return html`
              <g
                key=${node.id}
                class=${`wf-node${spinnerVisible ? " wf-node-running" : ""}${flashState ? ` wf-node-flash-${flashState}` : ""}`}
                transform="translate(${x} ${y})"
                onMouseDown=${(e) => onNodeMouseDown(node.id, e)}
                onPointerDown=${(e) => onNodePointerDown(node.id, e)}
                onDblClick=${() => onNodeDoubleClick(node.id)}
                onContextMenu=${(e) => onNodeContextMenu(node.id, e)}
                style="cursor: grab;"
                filter=${executionVisuals.filter}
              >
                <!-- Node body -->
                <rect
                  width=${NODE_W}
                  height=${NODE_H}
                  rx="8"
                  fill=${executionVisuals.fill}
                  stroke=${executionVisuals.stroke}
                  stroke-width=${executionVisuals.strokeWidth}
                />
                ${spinnerVisible && html`
                  <rect
                    x="1.5"
                    y="1.5"
                    width=${NODE_W - 3}
                    height=${NODE_H - 3}
                    rx="7"
                    fill="none"
                    stroke="#93c5fd"
                    stroke-opacity="0.85"
                    stroke-width="1.6"
                    stroke-dasharray="10 6"
                  >
                    <animate attributeName="stroke-dashoffset" values="0;-32" dur="1s" repeatCount="indefinite" />
                  </rect>
                `}

                <!-- Category color strip -->
                <rect
                  width="4"
                  height=${NODE_H}
                  rx="2"
                  fill=${meta.color}
                />

                <!-- Label -->
                <text
                  x=${NODE_W / 2}
                  y="24"
                  text-anchor="middle"
                  fill="white"
                  font-size="13"
                  font-weight="600"
                >${stripEmoji(node.label || node.type).slice(0, 25)}</text>

                <!-- Type subtitle -->
                <text
                  x=${NODE_W / 2}
                  y="40"
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="10"
                >${node.type}</text>

                ${inlineFields.length > 0 && html`
                  <foreignObject
                    x="10"
                    y="48"
                    width=${NODE_W - 20}
                    height="56"
                    style="overflow: visible;"
                    onMouseDown=${(e) => e.stopPropagation()}
                    onPointerDown=${(e) => e.stopPropagation()}
                  >
                    <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex; flex-direction:column; gap:4px; font-size:10px;">
                      ${inlineFields.map((field) => {
                        const label = String(field.key || "").replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim();
                        if (field.isEnum) {
                          return html`
                            <label key=${field.key} style="display:flex; flex-direction:column; gap:2px; color:#94a3b8;">
                              <span>${label}</span>
                              <select
                                value=${field.value ?? ""}
                                style="height:18px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e2e8f0; font-size:10px;"
                                onInput=${(e) => updateNodeConfig(node.id, { [field.key]: e.target.value })}
                                onMouseDown=${(e) => e.stopPropagation()}
                              >
                                <option value="">-</option>
                                ${(field.schema.enum || []).map((opt) => html`<option key=${String(opt)} value=${opt}>${String(opt)}</option>`)}
                              </select>
                            </label>
                          `;
                        }
                        if (field.fieldType === "boolean") {
                          return html`
                            <label key=${field.key} style="display:flex; align-items:center; gap:6px; color:#94a3b8;">
                              <input
                                type="checkbox"
                                checked=${Boolean(field.value)}
                                onInput=${(e) => updateNodeConfig(node.id, { [field.key]: e.target.checked })}
                                onMouseDown=${(e) => e.stopPropagation()}
                              />
                              <span>${label}</span>
                            </label>
                          `;
                        }
                        return html`
                          <label key=${field.key} style="display:flex; flex-direction:column; gap:2px; color:#94a3b8;">
                            <span>${label}</span>
                            <input
                              type=${field.fieldType === "number" ? "number" : "text"}
                              value=${field.value ?? ""}
                              style="height:18px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e2e8f0; font-size:10px; padding:0 4px;"
                              onInput=${(e) => updateNodeConfig(node.id, {
                                [field.key]: field.fieldType === "number" ? Number(e.target.value || 0) : e.target.value,
                              })}
                              onMouseDown=${(e) => e.stopPropagation()}
                            />
                          </label>
                        `;
                      })}
                    </div>
                  </foreignObject>
                `}

                ${ports.inputs.map((port) => {
                  const pos = getNodePortPosition(node.id, "input", port.name);
                  const localY = pos.y - y;
                  const sourcePort = connecting ? getOutputPortDescriptor(connecting.sourceId, connecting.sourcePort || "default") : null;
                  const compatibility = connecting && connecting.sourceId !== node.id
                    ? isPortConnectionCompatible(sourcePort, port)
                    : { compatible: true };
                  const strokeColor = connecting && connecting.sourceId !== node.id
                    ? (compatibility.compatible ? "#22c55e" : "#ef4444")
                    : (port.color || "#4a5568");
                  const cursorStyle = connecting && connecting.sourceId !== node.id && !compatibility.compatible
                    ? "not-allowed"
                    : "crosshair";
                  return html`
                    <circle
                      key=${`in-${node.id}-${port.name}`}
                      cx="0"
                      cy=${localY}
                      r=${PORT_R}
                      fill="#0f172a"
                      stroke=${strokeColor}
                      stroke-width="2"
                      style=${`cursor: ${cursorStyle};`}
                      onMouseUp=${(e) => onInputPortMouseUp(node.id, port.name, { clientX: e.clientX, clientY: e.clientY })}
                      onPointerUp=${(e) => onInputPortPointerUp(node.id, port.name, e)}
                      onMouseEnter=${(e) => {
                        showPortHoverHint(port, e.clientX, e.clientY);
                        if (connecting && connecting.sourceId !== node.id && !compatibility.compatible) {
                          showConnectionHint(compatibility.reason || "Incompatible port types", e.clientX, e.clientY);
                        }
                      }}
                      onMouseMove=${(e) => showPortHoverHint(port, e.clientX, e.clientY)}
                      onMouseLeave=${() => setPortHoverHint(null)}
                    >
                      <title>${`${port.label} (${port.type})${port.description ? ` - ${port.description}` : ""}`}</title>
                    </circle>
                  `;
                })}

                ${ports.outputs.map((port) => {
                  const pos = getNodePortPosition(node.id, "output", port.name);
                  const localY = pos.y - y;
                  return html`
                    <circle
                      key=${`out-${node.id}-${port.name}`}
                      cx=${NODE_W}
                      cy=${localY}
                      r=${PORT_R}
                      fill="#0f172a"
                      stroke=${port.color || meta.color}
                      stroke-width="2"
                      style="cursor: crosshair;"
                      onMouseDown=${(e) => onOutputPortMouseDown(node.id, port.name, e)}
                      onPointerDown=${(e) => onOutputPortPointerDown(node.id, port.name, e)}
                      onMouseEnter=${(e) => showPortHoverHint(port, e.clientX, e.clientY)}
                      onMouseMove=${(e) => showPortHoverHint(port, e.clientX, e.clientY)}
                      onMouseLeave=${() => setPortHoverHint(null)}
                    >
                      <title>${`${port.label} (${port.type})${port.description ? ` - ${port.description}` : ""}`}</title>
                    </circle>
                  `;
                })}
              </g>
            `;
          })}

          <!-- Marquee selection box -->
          ${marquee && html`
            <rect
              x=${marquee.x}
              y=${marquee.y}
              width=${marquee.w}
              height=${marquee.h}
              fill="rgba(59, 130, 246, 0.08)"
              stroke="#3b82f6"
              stroke-width=${1.5 / zoom}
              stroke-dasharray="${5 / zoom},${3 / zoom}"
              style="pointer-events: none;"
            />
          `}
        </g>
      </svg>

      ${connectionHint && html`
        <div
          style="position: fixed; left: ${connectionHint.x}px; top: ${connectionHint.y}px; z-index: 40; max-width: 320px; padding: 6px 8px; border-radius: 6px; background: #111827; color: #fca5a5; border: 1px solid #ef444480; font-size: 11px; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,0.35);"
        >
          ${connectionHint.message}
        </div>
      `}

      ${portHoverHint && html`
        <div
          style="position: fixed; left: ${portHoverHint.x}px; top: ${portHoverHint.y}px; z-index: 39; max-width: 340px; padding: 6px 8px; border-radius: 6px; background: #0f172a; color: #cbd5e1; border: 1px solid #334155; font-size: 11px; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,0.35);"
        >
          ${portHoverHint.message}
        </div>
      `}

      <!-- Context Menu -->
      ${contextMenu && html`
        <div class="wf-context-menu" style="position: fixed; left: ${contextMenu.x}px; top: ${contextMenu.y}px; z-index: 50;">
          ${contextMenu.groupId ? html`
            <${MenuItem} onClick=${() => { handleToggleActiveGroup(); setContextMenu(null); }}>
              <span class="btn-icon">${resolveIcon(activeGroup?.collapsed ? "play" : "pause")}</span>
              ${activeGroup?.collapsed ? "Expand Group" : "Collapse Group"}
            <//>
          ` : html`
            <${MenuItem}
              onClick=${() => {
                const node = nodes.find((entry) => entry.id === contextMenu.nodeId) || null;
                setContextMenu(null);
                openWorkflowCopilotFromCanvas({
                  intent: "node",
                  nodeId: contextMenu.nodeId,
                  title: `Ask Bosun about node ${node?.label || contextMenu.nodeId}`.trim(),
                  successToast: "Opened node copilot chat",
                });
              }}
            >
              <span class="btn-icon">${resolveIcon("bot")}</span>
              Ask Bosun About Node
            <//>
            <${MenuItem} onClick=${() => { setEditingNode(contextMenu.nodeId); setContextMenu(null); }}>
              <span class="btn-icon">${resolveIcon("settings")}</span>
              Edit Config
            <//>
            <${MenuItem} onClick=${() => duplicateNode(contextMenu.nodeId)}>
              <span class="btn-icon">${resolveIcon("clipboard")}</span>
              Duplicate
            <//>
          `}
          ${selectedNodeIds.size > 1 && html`
            <${MenuItem} onClick=${() => { handleCreateGroup(); setContextMenu(null); }}>
              <span class="btn-icon">${resolveIcon("plus")}</span>
              Create Group
            <//>
          `}
          ${activeGroup && !contextMenu.groupId && html`
            <${MenuItem} onClick=${() => { handleToggleActiveGroup(); setContextMenu(null); }}>
              <span class="btn-icon">${resolveIcon(activeGroup.collapsed ? "play" : "pause")}</span>
              ${activeGroup.collapsed ? "Expand Group" : "Collapse Group"}
            <//>
          `}
          ${!contextMenu.groupId && html`
            <${MenuItem} onClick=${() => { deleteNode(contextMenu.nodeId); }} sx=${{ color: '#ef4444' }}>
              <span class="btn-icon">${resolveIcon("trash")}</span>
              Delete
            <//>
          `}
        </div>
      `}

      <${Dialog} open=${importDialogOpen} onClose=${() => setImportDialogOpen(false)} maxWidth="md" fullWidth>
        <${DialogTitle}>Import Workflow JSON</${DialogTitle}>
        <${DialogContent}>
          <textarea value=${importJsonText} onInput=${(e) => setImportJsonText(e.target.value)} style="width:100%; min-height:260px; font-family:monospace; font-size:12px; background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:8px; padding:12px;" placeholder='{"name":"Imported Workflow","nodes":[],"edges":[]}' />
        </${DialogContent}>
        <${DialogActions}>
          <${Button} onClick=${() => setImportDialogOpen(false)}>Cancel<//>
          <${Button} variant="contained" onClick=${handleImportWorkflowJson}>Import<//>
        </${DialogActions}>
      </${Dialog}>

      <${Dialog} open=${Boolean(inlinePreview)} onClose=${() => setInlinePreview(null)} maxWidth="lg" fullWidth>
        <${DialogTitle}>Inline Sub-workflow Preview</${DialogTitle}>
        <${DialogContent}>
          ${inlinePreview && html`
            <div style="font-size:12px; color:var(--color-text-secondary,#94a3b8); margin-bottom:10px;">${inlinePreview.name} · ${inlinePreview.nodes?.length || 0} nodes · ${inlinePreview.edges?.length || 0} edges</div>
            <svg viewBox="0 0 1200 480" style="width:100%; height:420px; background:#0f1117; border:1px solid #1f2937; border-radius:10px;">
              ${(inlinePreview.edges || []).map((edge) => {
                const source = (inlinePreview.nodes || []).find((node) => node.id === edge.source);
                const target = (inlinePreview.nodes || []).find((node) => node.id === edge.target);
                if (!source || !target) return null;
                const x1 = (source.position?.x || 0) + 220;
                const y1 = (source.position?.y || 0) + 59;
                const x2 = (target.position?.x || 0);
                const y2 = (target.position?.y || 0) + 59;
                return html`<path d=${curvePath(x1, y1, x2, y2)} fill="none" stroke="#64748b" stroke-width="2" />`;
              })}
              ${(inlinePreview.nodes || []).map((node) => html`
                <g key=${node.id} transform="translate(${node.position?.x || 0} ${node.position?.y || 0})">
                  <rect width="220" height="118" rx="10" fill="#111827" stroke="#334155" />
                  <text x="110" y="24" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="700">${stripEmoji(node.label || node.type).slice(0, 28)}</text>
                  <text x="110" y="42" text-anchor="middle" fill="#94a3b8" font-size="11">${node.type}</text>
                </g>
              `)}
            </svg>
          `}
        </${DialogContent}>
      </${Dialog}>

      ${!editingNode && selectedEdge && html`
        ${(() => {
          const binding = getEdgePortBindingState(selectedEdge);
          if (!binding) return null;
          const sourceLabel = binding.sourceNode?.label || binding.edge.source;
          const targetLabel = binding.targetNode?.label || binding.edge.target;
          const sourceOptions = binding.sourcePorts.some((port) => port.name === binding.requestedSourcePort)
            ? binding.sourcePorts
            : [{ name: binding.requestedSourcePort, label: `${binding.requestedSourcePort} (missing)` }, ...binding.sourcePorts];
          const targetOptions = binding.targetPorts.some((port) => port.name === binding.requestedTargetPort)
            ? binding.targetPorts
            : [{ name: binding.requestedTargetPort, label: `${binding.requestedTargetPort} (missing)` }, ...binding.targetPorts];
          return html`
            <div class="wf-config-panel" style="position: absolute; top: 0; right: 0; width: 380px; height: 100%; background: var(--color-bg, #0d1117); border-left: 1px solid var(--color-border, #2a3040); z-index: 25; overflow-y: auto; padding: 16px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                <span class="icon-inline" style="font-size: 20px; color: #60a5fa;">${resolveIcon("git-branch") || ICONS.dot}</span>
                <div style="flex: 1;">
                  <div style="font-size: 16px; font-weight: 700; color: var(--color-text, white);">Port Bindings</div>
                  <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">${sourceLabel} → ${targetLabel}</div>
                </div>
                <${IconButton} size="small" onClick=${() => { selectedEdgeId.value = null; }}>
                  ${resolveIcon("close") || "✕"}
                </${IconButton}>
              </div>

              <div style="display: grid; gap: 12px; margin-bottom: 16px;">
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 6px;">Source Port</label>
                    <select
                      aria-label="Select source port"
                      class="wf-input"
                      value=${binding.requestedSourcePort}
                      onChange=${(e) => updateEdgePortMapping(binding.edge.id, { sourcePort: e.target.value })}
                    >
                    ${sourceOptions.map((port) => html`<option key=${port.name} value=${port.name}>${port.label || port.name}</option>`)}
                  </select>
                </div>
                <div>
                  <label style="display: block; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 6px;">Target Port</label>
                    <select
                      aria-label="Select target port"
                      class="wf-input"
                      value=${binding.requestedTargetPort}
                      onChange=${(e) => updateEdgePortMapping(binding.edge.id, { targetPort: e.target.value })}
                    >
                    ${targetOptions.map((port) => html`<option key=${port.name} value=${port.name}>${port.label || port.name}</option>`)}
                  </select>
                </div>
              </div>

              ${binding.validationErrors.length > 0 && html`
                <div style="margin-bottom: 16px; border: 1px solid #7f1d1d; background: #450a0a; color: #fecaca; border-radius: 8px; padding: 10px 12px;">
                  <div style="font-size: 12px; font-weight: 700; margin-bottom: 6px;">Validation Error</div>
                  <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
                    ${binding.validationErrors.some((message) => String(message || "").includes(UNKNOWN_OUTPUT_PORT_LABEL)) && html`
                      <span style="display: inline-flex; align-items: center; border: 1px solid #991b1b; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600;">${UNKNOWN_OUTPUT_PORT_LABEL}</span>
                    `}
                    ${binding.validationErrors.some((message) => String(message || "").includes(UNKNOWN_INPUT_PORT_LABEL)) && html`
                      <span style="display: inline-flex; align-items: center; border: 1px solid #991b1b; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600;">${UNKNOWN_INPUT_PORT_LABEL}</span>
                    `}
                  </div>
                  <div style="display: grid; gap: 4px; font-size: 12px;">
                    ${binding.validationErrors.map((message) => html`<div key=${message}>${message}</div>`)}
                  </div>
                </div>
              `}

              <div style="display: grid; gap: 8px; margin-bottom: 16px;">
                <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
                  <strong style="color: var(--color-text, white);">Edge ID:</strong> ${binding.edge.id}
                </div>
                <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
                  <strong style="color: var(--color-text, white);">Source:</strong> ${binding.edge.source}
                </div>
                <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
                  <strong style="color: var(--color-text, white);">Target:</strong> ${binding.edge.target}
                </div>
                ${binding.edge.condition && html`
                  <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5);">
                    <strong style="color: var(--color-text, white);">Condition:</strong> ${binding.edge.condition}
                  </div>
                `}
                ${binding.edge.backEdge && html`
                  <div style="font-size: 12px; color: #fbbf24;">Back-edge routing enabled</div>
                `}
              </div>

              <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <${Button} variant="outlined" size="small" onClick=${() => { selectedEdgeId.value = null; }}>
                  Close
                </${Button}>
                <${Button} variant="outlined" color="error" size="small" onClick=${() => deleteEdge(binding.edge.id)}>
                  Delete Edge
                </${Button}>
              </div>
            </div>
          `;
        })()}
      `}

      <!-- Node Config Editor (side panel) -->
      ${editingNode && html`
        ${(() => {
          const editingNodeDef = nodes.find((n) => n.id === editingNode) || null;
          const editingTypeInfo = nodeTypeMap.get(editingNodeDef?.type) || null;
          const inlineDescriptors = getInlineFieldDescriptors(editingTypeInfo, editingNodeDef, 3);
          return html`
        <${NodeConfigEditor}
          node=${editingNodeDef}
          nodeTypes=${availableNodeTypes}
          inlineFieldKeys=${inlineDescriptors.map((field) => field.key)}
          onUpdate=${(config) => updateNodeConfig(editingNode, config)}
          onUpdateLabel=${(label) => updateNodeLabel(editingNode, label)}
          onAskBosun=${() => openWorkflowCopilotFromCanvas({
            intent: "node",
            nodeId: editingNode,
            title: `Ask Bosun about node ${editingNodeDef?.label || editingNode}`.trim(),
            successToast: "Opened node copilot chat",
          })}
          onClose=${() => setEditingNode(null)}
          onDelete=${() => deleteNode(editingNode)}
        />
          `;
        })()}
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Node Palette — categorized node type picker
 * ═══════════════════════════════════════════════════════════════ */

function NodePalette({
  open,
  nodeTypes: types,
  insertPoint,
  query,
  onQueryChange,
  onSelect,
  onClose,
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const results = useMemo(() => {
    const safeTypes = types || [];
    return searchNodeTypes(safeTypes, query, Math.max(1, safeTypes.length || 1));
  }, [types, query]);

  useEffect(() => {
    if (!open) return;
    setSelectedIndex(0);
  }, [open, query]);

  useEffect(() => {
    if (selectedIndex < results.length) return;
    setSelectedIndex(0);
  }, [results.length, selectedIndex]);

  const renderChips = (items = [], fallback = "None") => {
    const safeList = Array.isArray(items) ? items : [];
    if (!safeList.length) {
      return html`<span class="wf-node-chip wf-node-chip-fallback">${fallback}</span>`;
    }
    const limit = 4;
    const visible = safeList.slice(0, limit);
    const remainder = Math.max(0, safeList.length - visible.length);
    return html`
      ${visible.map((value, index) => html`<span key=${`${value}-${index}`} class="wf-node-chip">${value}</span>`)}
      ${remainder > 0 && html`<span class="wf-node-chip wf-node-chip-more">+${remainder}</span>`}
    `;
  };

  if (!open) return null;

  const totalTypes = types?.length || 0;
  const selected = results[selectedIndex] || results[0] || null;
  const submit = (item) => {
    if (!item) return;
    onSelect(item.type);
  };
  const pointLabel = `${Math.round(insertPoint?.x || 0)}, ${Math.round(insertPoint?.y || 0)}`;

  return html`
    <div class="wf-palette-backdrop" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="wf-palette">
        <div class="wf-palette-header">
          <div class="wf-palette-title-group">
            <div class="wf-palette-title">Insert workflow node</div>
            <div class="wf-palette-subtitle">${totalTypes} node types · insert at ${pointLabel}</div>
          </div>
          <${IconButton} size="small" onClick=${onClose} sx=${{ fontSize: '16px', lineHeight: 1 }}>
            <span class="icon-inline">${resolveIcon("✕")}</span>
          <//>
        </div>
        <${TextField}
          size="small"
          variant="outlined"
          placeholder="Search by name, category, description, or config input..."
          value=${query}
          onInput=${(e) => onQueryChange(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelectedIndex((current) => results.length ? Math.min(current + 1, results.length - 1) : 0);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedIndex((current) => Math.max(current - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              submit(selected);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          sx=${{ flex: 1 }}
          autoFocus
        />
        <div class="wf-palette-hints">
          <span>${results.length} matches</span>
          <span>·</span>
          <span>↵ insert</span>
          <span>·</span>
          <span>↑↓ navigate</span>
        </div>
        <div class="wf-palette-results">
          ${results.map((item, index) => {
            const meta = NODE_CATEGORY_META[item.category] || { color: "#6b7280", bg: "#6b728020", label: item.category };
            const io = getNodeSearchMetadata(item);
            return html`
              <button
                key=${item.type}
                type="button"
                class=${`wf-node-search-item ${index === selectedIndex ? "active" : ""}`}
                style=${`border-color: ${index === selectedIndex ? '#3b82f6aa' : 'var(--color-border, #2a3040)'}; background: ${index === selectedIndex ? 'rgba(59,130,246,0.12)' : 'var(--color-bg-secondary, #131722)'};`}
                onMouseEnter=${() => setSelectedIndex(index)}
                onClick=${() => submit(item)}
              >
                <div class="wf-node-search-item-top">
                  <span class="wf-node-search-label">${item.label}</span>
                  <span
                    class="wf-node-category-badge"
                    style=${`color:${meta.color}; background:${meta.bg}; border-color:${meta.color}33;`}
                  >
                    ${meta.label || item.category}
                  </span>
                  ${item.badge
                    ? html`<span
                        class="wf-node-category-badge"
                        style=${`color:${item.isCustom ? "#f472b6" : "#cbd5e1"}; background:${item.isCustom ? "rgba(244,114,182,0.2)" : "rgba(148,163,184,0.2)"}; border-color:${item.isCustom ? "#f472b655" : "#94a3b855"};`}
                      >
                        ${item.badge}
                      </span>`
                    : ""}
                  <span class="wf-node-search-type">${item.type}</span>
                </div>
                <div class="wf-node-search-description">${item.description || "No description available."}</div>
                <div class="wf-node-chip-row">
                  <div class="wf-node-chip-group">
                    <span class="wf-node-chip-label">Inputs</span>
                    <div class="wf-node-chip-list">
                      ${renderChips(io.inputs, "None")}
                    </div>
                  </div>
                  <div class="wf-node-chip-group">
                    <span class="wf-node-chip-label">Outputs</span>
                    <div class="wf-node-chip-list">
                      ${renderChips(io.outputs, "Default")}
                    </div>
                  </div>
                </div>
              </button>
            `;
          })}
          ${results.length === 0 && html`
            <div class="wf-node-search-empty">No matching nodes</div>
          `}
        </div>
      </div>
    </div>
  `;
}

function KeyboardShortcutOverlay({ open, onClose, canUndo, canRedo }) {
  if (!open) return null;
  const shortcuts = [
    { keys: "/", description: "Open fuzzy node search" },
    { keys: "Double-click canvas", description: "Insert a node at that position" },
    { keys: "?", description: "Show this shortcut reference" },
    { keys: "Ctrl/Cmd + Z", description: canUndo ? "Undo last graph change" : "Undo unavailable" },
    { keys: "Ctrl/Cmd + Shift + Z", description: canRedo ? "Redo last undone change" : "Redo unavailable" },
    { keys: "Ctrl/Cmd + Y", description: canRedo ? "Alternate redo shortcut" : "Alternate redo unavailable" },
    { keys: "Ctrl/Cmd + A", description: "Select all nodes" },
    { keys: "Delete / Backspace", description: "Delete selected node or edge" },
    { keys: "Space + drag", description: "Pan the canvas" },
    { keys: "Ctrl/Cmd + drag", description: "Alternate mouse panning" },
    { keys: "Shift + click", description: "Add or remove a node from the selection" },
  ];
  return html`
    <${Dialog} open=${open} onClose=${onClose} maxWidth="sm" fullWidth>
      <${DialogTitle}>Canvas Shortcuts<//>
      <${DialogContent} dividers>
        <div class="wf-shortcuts-grid">
          ${shortcuts.map((shortcut) => html`
            <div key=${shortcut.keys} class="wf-shortcut-row">
              <code class="wf-shortcut-key">${shortcut.keys}</code>
              <span class="wf-shortcut-desc">${shortcut.description}</span>
            </div>
          `)}
        </div>
      <//>
      <${DialogActions}>
        <${Button} onClick=${onClose}>Close<//>
      <//>
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Smart Presets — real bosun commands and agent prompts
 * ═══════════════════════════════════════════════════════════════ */

const COMMAND_PRESETS = {
  testing: [
    { label: "Run Tests (npm)", cmd: "npm test", icon: "beaker" },
    { label: "Run Tests (yarn)", cmd: "yarn test", icon: "beaker" },
    { label: "Run Tests (pnpm)", cmd: "pnpm test", icon: "beaker" },
    { label: "Run Tests (pytest)", cmd: "pytest", icon: "beaker" },
    { label: "Run Tests (Go)", cmd: "go test ./...", icon: "beaker" },
    { label: "Run Tests (Rust)", cmd: "cargo test", icon: "beaker" },
    { label: "Run Tests (Java/Maven)", cmd: "mvn test", icon: "beaker" },
    { label: "Run Tests (Java/Gradle)", cmd: "./gradlew test", icon: "beaker" },
    { label: "Run Tests (.NET)", cmd: "dotnet test", icon: "beaker" },
    { label: "Run Tests (Ruby)", cmd: "bundle exec rspec", icon: "beaker" },
    { label: "Run Single File", cmd: 'npx vitest run tests/{{testFile}}', icon: "target" },
    { label: "Syntax Check (Node)", cmd: "npm run syntax:check", icon: "check" },
    { label: "Syntax Check (Python)", cmd: "python -m py_compile", icon: "check" },
    { label: "Syntax Check (Go)", cmd: "go vet ./...", icon: "check" },
    { label: "Syntax Check (Rust)", cmd: "cargo check", icon: "check" },
  ],
  build: [
    { label: "Build (npm)", cmd: "npm run build", icon: "hammer" },
    { label: "Build (yarn)", cmd: "yarn build", icon: "hammer" },
    { label: "Build (pnpm)", cmd: "pnpm build", icon: "hammer" },
    { label: "Build (Go)", cmd: "go build ./...", icon: "hammer" },
    { label: "Build (Rust)", cmd: "cargo build", icon: "hammer" },
    { label: "Build (Maven)", cmd: "mvn package -DskipTests", icon: "hammer" },
    { label: "Build (Gradle)", cmd: "./gradlew build", icon: "hammer" },
    { label: "Build (.NET)", cmd: "dotnet build", icon: "hammer" },
    { label: "Build (Python)", cmd: "python -m build", icon: "hammer" },
    { label: "Build (Make)", cmd: "make", icon: "hammer" },
    { label: "Build Watch", cmd: "npm run build -- --watch", icon: "eye" },
    { label: "Type Check (TS)", cmd: "npx tsc --noEmit", icon: "ruler" },
  ],
  lint: [
    { label: "Lint (npm)", cmd: "npm run lint", icon: "search" },
    { label: "Lint (ESLint)", cmd: "npx eslint .", icon: "search" },
    { label: "Lint (Python/Ruff)", cmd: "ruff check .", icon: "search" },
    { label: "Lint (Python/Flake8)", cmd: "flake8", icon: "search" },
    { label: "Lint (Go)", cmd: "golangci-lint run", icon: "search" },
    { label: "Lint (Rust)", cmd: "cargo clippy -- -D warnings", icon: "search" },
    { label: "Lint (Ruby)", cmd: "bundle exec rubocop", icon: "search" },
    { label: "Lint (.NET)", cmd: "dotnet format --verify-no-changes", icon: "search" },
  ],
  git: [
    { label: "Diff Stats", cmd: "git diff --stat main...HEAD", icon: "chart" },
    { label: "Git Status", cmd: "git status --porcelain", icon: "clipboard" },
    { label: "Stage All", cmd: "git add -A", icon: "download" },
    { label: "Commit", cmd: 'git commit -m "{{commitMessage}}"', icon: "save" },
    { label: "Push", cmd: "git push --set-upstream origin HEAD", icon: "rocket" },
  ],
  github: [
    { label: "Check CI", cmd: "gh pr checks --json name,state", icon: "search" },
    { label: "Merge PR (squash)", cmd: "gh pr merge --auto --squash", icon: "git" },
    { label: "Close PR", cmd: 'gh pr close --comment "{{reason}}"', icon: "ban" },
    { label: "PR Diff", cmd: "gh pr diff --stat", icon: "chart" },
    { label: "PR Handoff Note", cmd: 'echo "Bosun manages PR lifecycle after push; direct PR commands are disabled."', icon: "edit" },
    { label: "Add Label", cmd: 'gh pr edit --add-label "{{label}}"', icon: "tag" },
    { label: "Request Review", cmd: 'gh pr edit --add-reviewer {{reviewer}}', icon: "eye" },
  ],
  bosun: [
    { label: "List Tasks", cmd: "bosun task list --status todo --json", icon: "clipboard" },
    { label: "Count Tasks", cmd: "bosun task list --status todo --count", icon: "hash" },
    { label: "Task Stats", cmd: "bosun task stats --json", icon: "chart" },
    { label: "Plan Tasks", cmd: "bosun task plan --count 5", icon: "compass" },
    { label: "Create Task", cmd: 'bosun task create --title "{{title}}" --status todo', icon: "plus" },
    { label: "Monitor Status", cmd: "bosun --daemon-status", icon: "heart" },
  ],
  session: [
    { label: "Continue Session", cmd: 'bosun agent continue --session "{{sessionId}}" --prompt "continue"', icon: "play" },
    { label: "Restart Agent", cmd: 'bosun agent restart --session "{{sessionId}}"', icon: "refresh" },
    { label: "Kill Agent", cmd: 'bosun agent kill --session "{{sessionId}}"', icon: "stop" },
    { label: "List Sessions", cmd: "bosun agent list --json", icon: "server" },
  ],
  screenshots: [
    { label: "Desktop Screenshot", cmd: "bosun screenshot --viewport 1280x720", icon: "monitor" },
    { label: "Mobile Screenshot", cmd: "bosun screenshot --viewport 375x812", icon: "phone" },
    { label: "All Viewports", cmd: "bosun screenshot --viewport desktop,mobile", icon: "camera" },
  ],
};

const AGENT_PROMPT_PRESETS = [
  { label: "Continue Working", icon: "play", prompt: "Continue working on the current task. Pick up where you left off. Review your previous output and continue.", category: "session" },
  { label: "Fix Errors", icon: "settings", prompt: "Fix the following errors. Do NOT introduce new issues:\n\n{{lastError}}\n\nTask: {{taskTitle}}\nFiles changed: {{changedFiles}}", category: "fix" },
  { label: "PR Review", icon: "search", prompt: "Review this PR for quality, bugs, security issues, test coverage, and documentation.\n\nProvide:\n1. Summary of changes\n2. Issues found (critical/warning/info)\n3. Verdict: APPROVE, REQUEST_CHANGES, or COMMENT", category: "review" },
  { label: "Merge Decision", icon: "git", prompt: "Analyze this PR and decide the merge strategy. Consider: CI status, diff size, code quality, test coverage.\n\nDecide exactly ONE action:\n- merge_after_ci_pass: Ready to merge\n- prompt: Agent needs to continue working (explain what)\n- close_pr: PR should be closed (explain why)\n- re_attempt: Task should be restarted from scratch\n- manual_review: Needs human review (explain why)\n- wait: CI still running, check back later\n- noop: No action needed", category: "strategy" },
  { label: "Frontend Implement", icon: "palette", prompt: "Implement the following frontend changes:\n\nTask: {{taskTitle}}\n{{taskDescription}}\n\nRequirements:\n- Must pass build (npm run build) with 0 warnings\n- Must pass lint (npm run lint)\n- Match the provided design specs\n- Add/update tests if applicable", category: "implement" },
  { label: "Plan Tasks", icon: "clipboard", prompt: "Analyze the codebase and create {{planCount}} actionable improvement tasks.\n\nFor each task provide:\n- title: Concise action-oriented title\n- description: What needs to change and why\n- priority: 1-5 (1=highest)\n- tags: Relevant labels\n- complexity: low, medium, or high\n\nFocus on: code quality, missing tests, documentation gaps, performance improvements, and technical debt.", category: "planning" },
  { label: "Analyze Failure", icon: "bug", prompt: "Analyze this agent failure and suggest a fix:\n\nError: {{lastError}}\nTask: {{taskTitle}}\nAttempt: {{retryCount}}/{{maxRetries}}\n\nProvide:\n1. Root cause analysis\n2. Concrete fix steps\n3. Should we retry or escalate?", category: "fix" },
  { label: "Error Recovery", icon: "shield", prompt: "The previous agent attempt failed. Here's what happened:\n\n{{lastError}}\n\nOriginal task: {{taskTitle}}\n\nApproach this differently:\n1. Identify what went wrong\n2. Try an alternative approach\n3. Ensure tests pass before committing", category: "fix" },
  { label: "Code Analysis", icon: "chart", prompt: "Analyze the codebase for:\n\n1. Code complexity hotspots\n2. Test coverage gaps\n3. Security vulnerabilities\n4. Performance bottlenecks\n5. Documentation completeness\n\nOutput a structured JSON report.", category: "review" },
  { label: "Refactor", icon: "repeat", prompt: "Refactor {{targetFile}} to:\n\n1. Reduce complexity\n2. Extract reusable functions\n3. Improve naming conventions\n4. Add JSDoc comments\n5. Ensure all existing tests still pass\n\nDo NOT change external behavior.", category: "implement" },
];

const TRIGGER_EVENT_PRESETS = [
  { label: "Task Failed", value: "task.failed", icon: "close" },
  { label: "Task Completed", value: "task.completed", icon: "check" },
  { label: "Task Assigned", value: "task.assigned", icon: "user" },
  { label: "PR Merged", value: "pr.merged", icon: "git" },
  { label: "PR Opened", value: "pr.opened", icon: "mail" },
  { label: "Agent Started", value: "agent.started", icon: "bot" },
  { label: "Agent Crashed", value: "agent.crashed", icon: "zap" },
  { label: "Rate Limited", value: "rate.limited", icon: "alert" },
  { label: "Build Failed", value: "build.failed", icon: "hammer" },
  { label: "Deploy Completed", value: "deploy.completed", icon: "rocket" },
  { label: "Session Ended", value: "session.ended", icon: "plug" },
];

const CRON_PRESETS = [
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Every 30 min", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
];

const EXPRESSION_PRESETS = [
  { label: "CI Passed", expr: "$ctx.getNodeOutput('check-ci')?.passed === true" },
  { label: "Previous Succeeded", expr: "$output?.success === true" },
  { label: "Retries Left", expr: "($data?.retryCount || 0) < ($data?.maxRetries || 3)" },
  { label: "Has Errors", expr: "$data?.errorCount > 0" },
  { label: "Is Draft PR", expr: "$data?.pr?.draft === true" },
  { label: "Large Diff", expr: "($data?.additions + $data?.deletions) > 500" },
  { label: "Task Tagged", expr: "($data?.tags || []).includes('{{tag}}')" },
  { label: "Branch Match", expr: "/^(feat|fix)\\//.test($data?.branch || '')" },
];

/* ═══════════════════════════════════════════════════════════════
 *  Workflow Agent Library Picker
 *  — Lets users select an agent profile from the Library
 * ═══════════════════════════════════════════════════════════════ */

function WorkflowAgentLibraryPicker({ config, onUpdate }) {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadAgents = useCallback(async () => {
    if (agents.length > 0) { setExpanded(e => !e); return; }
    setLoading(true);
    try {
      const res = await apiFetch("/api/library?type=agent&agentType=task");
      const data = Array.isArray(res?.data) ? res.data : [];
      setAgents(data);
    } catch { /* ignore */ }
    setLoading(false);
    setExpanded(true);
  }, [agents.length]);

  const selectAgent = useCallback((agent) => {
    onUpdate("agentProfileId", agent.id);
    if (agent.content?.prompt) onUpdate("prompt", agent.content?.prompt);
    if (agent.content?.model) onUpdate("model", agent.content.model);
    haptic?.("light");
    showToast(`Agent "${agent.name || agent.id}" applied`);
  }, [onUpdate]);

  const selected = config?.agentProfileId;

  return html`
    <div style="margin-top: 10px; margin-bottom: 6px;">
      <${Button}
        onClick=${loadAgents}
        variant="outlined"
        size="small"
        sx=${{ width: '100%', padding: '7px 10px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: '#1a1f2e', color: '#c9d1d9', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', textTransform: 'none' }}
      >
        <span class="btn-icon" style="color: #60a5fa;">${resolveIcon("users")}</span>
        <span style="flex: 1; text-align: left; font-weight: 500;">Library Agent Profiles</span>
        ${selected && html`<span style="font-size: 10px; background: #1e3a5f; color: #60a5fa; padding: 1px 6px; border-radius: 4px;">${selected}</span>`}
        <span style="font-size: 10px; color: #6b7280;">${loading ? "…" : (expanded ? ICONS.chevronDown : ICONS.arrowRight)}</span>
      <//>
      ${expanded && html`
        <div style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; padding-right: 4px;">
          ${agents.length === 0 && html`<div style="font-size: 11px; color: #6b7280; padding: 6px;">No agent profiles in library.</div>`}
          ${agents.map(a => html`
            <${Button}
              key=${a.id}
              onClick=${() => selectAgent(a)}
              variant="outlined"
              size="small"
              sx=${{ padding: '6px 10px', fontSize: '11px', border: '1px solid ' + (selected === a.id ? '#2563eb' : '#2a3040'), borderRadius: '6px', background: selected === a.id ? '#1e3a5f' : '#161b22', color: '#c9d1d9', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s', textTransform: 'none', display: 'block', width: '100%' }}
            >
              <div style="font-weight: 500; display: flex; align-items: center; gap: 6px;">
                <span class="btn-icon" style="color: ${selected === a.id ? '#60a5fa' : '#6b7280'};">${resolveIcon("user")}</span>
                <span>${a.name || a.id}</span>
                ${selected === a.id && html`<span style="margin-left: auto; font-size: 9px; color: #60a5fa;">● active</span>`}
              </div>
              ${a.description && html`<div style="font-size: 10px; color: #6b7280; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${a.description}</div>`}
            <//>
          `)}
        </div>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Node Config Editor (right side panel)
 * ═══════════════════════════════════════════════════════════════ */

function NodeConfigEditor({ node, nodeTypes: types, inlineFieldKeys = [], onUpdate, onUpdateLabel, onAskBosun, onClose, onDelete }) {
  if (!node) return null;

  const meta = getNodeMeta(node.type);
  const typeInfo = (types || []).find(nt => nt.type === node.type);
  const schema = typeInfo?.schema?.properties || {};
  const config = node.config || {};
  const hiddenInlineKeys = new Set((inlineFieldKeys || []).map((key) => String(key || "").trim()).filter(Boolean));
  const schemaEntries = Object.entries(schema).filter(([key]) => !hiddenInlineKeys.has(key));
  const [presetExpanded, setPresetExpanded] = useState(true);

  const onFieldChange = useCallback((key, value) => {
    onUpdate({ [key]: value });
  }, [onUpdate]);

  const applyPreset = useCallback((overrides) => {
    onUpdate(overrides);
    haptic?.("light");
  }, [onUpdate]);

  // Determine which smart section to render
  const nodeCategory = node.type.split(".")[0];
  const nodeAction = node.type.split(".")[1] || "";

  return html`
    <div class="wf-config-panel" style="position: absolute; top: 0; right: 0; width: 380px; height: 100%; background: var(--color-bg, #0d1117); border-left: 1px solid var(--color-border, #2a3040); z-index: 25; overflow-y: auto; padding: 16px;">

      <!-- Header -->
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span class="icon-inline" style="font-size: 20px;">${resolveIcon(meta.icon) || ICONS.dot}</span>
        <div style="flex: 1;">
          <${TextField}
            size="small"
            variant="standard"
            value=${node.label || ""}
            onInput=${(e) => onUpdateLabel(e.target.value)}
            fullWidth
            InputProps=${{ disableUnderline: true, sx: { color: "var(--color-text, white)", fontSize: "15px", fontWeight: 600, padding: "2px 0" } }}
          />
          <div style="font-size: 11px; color: ${meta.color}; font-family: monospace;">${node.type}</div>
        </div>
        <${IconButton} size="small" onClick=${onClose}>
          <span class="icon-inline">${resolveIcon("✕")}</span>
        <//>
      </div>

      <!-- Description -->
      ${typeInfo?.description && html`
        <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; padding: 8px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 8px;">
          ${typeInfo.description}
        </div>
      `}
      ${typeof onAskBosun === "function" && html`
        <${Button}
          onClick=${onAskBosun}
          variant="outlined"
          size="small"
          sx=${{ width: "100%", marginBottom: "12px", textTransform: "none" }}
        >
          <span class="btn-icon">${resolveIcon("bot")}</span>
          Ask Bosun About This Node
        <//>
      `}

      <!-- ═══ Smart Presets: action.run_command ═══ -->
      ${node.type === "action.run_command" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div
            style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 8px; opacity: 0.9;"
            onClick=${() => setPresetExpanded(!presetExpanded)}
          >
            <span class="icon-inline" style="font-size: 11px; color: #f59e0b;">${resolveIcon("zap")}</span>
            <span style="font-size: 12px; font-weight: 600; color: #f59e0b;">Quick Commands</span>
            <span style="font-size: 10px; margin-left: auto; color: #6b7280;">${presetExpanded ? ICONS.chevronDown : ICONS.arrowRight}</span>
          </div>
          ${presetExpanded && Object.entries(COMMAND_PRESETS).map(([group, items]) => html`
            <div key=${group} style="margin-bottom: 6px;">
              <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; padding-left: 4px;">${group}</div>
              <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                ${items.map(p => html`
                  <${Button}
                    key=${p.label}
                    onClick=${() => applyPreset({ command: p.cmd })}
                    variant="outlined"
                    size="small"
                    title=${p.cmd}
                    sx=${{ padding: '3px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.command === p.cmd ? '#1e3a5f' : '#1a1f2e', color: config.command === p.cmd ? '#60a5fa' : '#c9d1d9', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all 0.1s', textTransform: 'none' }}
                  >
                    <span class="btn-icon">${resolveIcon(p.icon)}</span>
                    ${p.label}
                  <//>
                `)}
              </div>
            </div>
          `)}
        </div>
      `}

      <!-- ═══ Smart Presets: action.run_agent / agent.* ═══ -->
      ${(node.type === "action.run_agent" || nodeCategory === "agent") && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div
            style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 8px;"
            onClick=${() => setPresetExpanded(!presetExpanded)}
          >
            <span class="icon-inline" style="font-size: 11px; color: #a78bfa;">${resolveIcon("bot")}</span>
            <span style="font-size: 12px; font-weight: 600; color: #a78bfa;">Agent Prompt Templates</span>
            <span style="font-size: 10px; margin-left: auto; color: #6b7280;">${presetExpanded ? ICONS.chevronDown : ICONS.arrowRight}</span>
          </div>
          ${presetExpanded && html`
            <div style="display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; padding-right: 4px;">
              ${AGENT_PROMPT_PRESETS.map(p => html`
                <${Button}
                  key=${p.label}
                  onClick=${() => applyPreset({ prompt: p.prompt })}
                  variant="outlined"
                  size="small"
                  sx=${{ padding: '6px 10px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: '#1a1f2e', color: '#c9d1d9', cursor: 'pointer', textAlign: 'left', transition: 'all 0.1s', lineHeight: 1.3, textTransform: 'none', display: 'block', width: '100%' }}
                >
                  <div style="font-weight: 500; display: flex; align-items: center; gap: 6px;">
                    <span class="btn-icon">${resolveIcon(p.icon)}</span>
                    <span>${p.label}</span>
                  </div>
                  <div style="font-size: 10px; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.prompt.split("\n")[0].slice(0, 60)}…</div>
                <//>
              `)}
            </div>
          `}
          ${(node.type === "action.run_agent") && html`
            <${WorkflowAgentLibraryPicker} config=${config} onUpdate=${onFieldChange} />
            <div style="margin-top: 8px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #a78bfa;">
              <div style="font-size: 10px; color: #a78bfa; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px;">
                <span class="btn-icon">${resolveIcon("lightbulb")}</span>
                Agent Variables
              </div>
              <div style="font-size: 10px; color: #6b7280; font-family: monospace; line-height: 1.6;">
                ${"{{taskTitle}}"} · ${"{{taskDescription}}"} · ${"{{lastError}}"}<br/>
                ${"{{branch}}"} · ${"{{changedFiles}}"} · ${"{{retryCount}}"}<br/>
                ${"{{sessionId}}"} · ${"{{maxRetries}}"} · ${"{{planCount}}"}
              </div>
            </div>
          `}
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.event ═══ -->
      ${node.type === "trigger.event" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("zap")}</span>
            Event Types
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${TRIGGER_EVENT_PRESETS.map(p => html`
              <${Button}
                key=${p.value}
                onClick=${() => applyPreset({ eventType: p.value })}
                variant="outlined"
                size="small"
                sx=${{ padding: '3px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.eventType === p.value ? '#0d3320' : '#1a1f2e', color: config.eventType === p.value ? '#34d399' : '#c9d1d9', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none' }}
              >
                <span class="btn-icon">${resolveIcon(p.icon)}</span>
                ${p.label}
              <//>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.cron / trigger.schedule ═══ -->
      ${(node.type === "trigger.cron" || node.type === "trigger.schedule") && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("clock")}</span>
            Schedule Presets
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${CRON_PRESETS.map(p => html`
              <${Button}
                key=${p.value}
                onClick=${() => applyPreset({ cron: p.value })}
                variant="outlined"
                size="small"
                sx=${{ padding: '3px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.cron === p.value ? '#0d3320' : '#1a1f2e', color: config.cron === p.value ? '#34d399' : '#c9d1d9', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none' }}
              >
                ${p.label}
              <//>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.pr_event ═══ -->
      ${node.type === "trigger.pr_event" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("git")}</span>
            PR Events
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${["opened", "merged", "review_requested", "changes_requested", "approved", "closed"].map(ev => html`
              <${Button}
                key=${ev}
                onClick=${() => applyPreset({ event: ev })}
                variant="outlined"
                size="small"
                sx=${{ padding: '3px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.event === ev ? '#0d3320' : '#1a1f2e', color: config.event === ev ? '#34d399' : '#c9d1d9', cursor: 'pointer', whiteSpace: 'nowrap', textTransform: 'none' }}
              >
                ${ev.replace(/_/g, " ")}
              <//>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: condition.expression ═══ -->
      ${node.type === "condition.expression" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #f472b6; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("terminal")}</span>
            Expression Presets
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px;">
            ${EXPRESSION_PRESETS.map(p => html`
              <${Button}
                key=${p.label}
                onClick=${() => applyPreset({ expression: p.expr })}
                variant="outlined"
                size="small"
                sx=${{ padding: '4px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: '#1a1f2e', color: '#c9d1d9', cursor: 'pointer', textAlign: 'left', textTransform: 'none', display: 'block', width: '100%' }}
              >
                <span style="font-weight: 500;">${p.label}</span>
                <span style="font-size: 10px; color: #6b7280; margin-left: 6px; font-family: monospace;">${p.expr.slice(0, 45)}${p.expr.length > 45 ? "…" : ""}</span>
              <//>
            `)}
          </div>
          <div style="margin-top: 6px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #f472b6;">
            <div style="font-size: 10px; color: #f472b6; font-weight: 600;">Context Variables</div>
            <div style="font-size: 10px; color: #6b7280; font-family: monospace; line-height: 1.6;">
              <b>$data</b> — workflow input data<br/>
              <b>$ctx</b> — execution context<br/>
              <b>$output</b> — all node outputs map<br/>
              <b>$ctx.getNodeOutput('id')</b> — specific node result
            </div>
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: condition.switch ═══ -->
      ${node.type === "condition.switch" && html`
        <div style="margin-bottom: 14px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #f472b6;">
          <div style="font-size: 10px; color: #f472b6; font-weight: 600;">Switch Node</div>
          <div style="font-size: 10px; color: #6b7280; line-height: 1.5;">
            Routes workflow to different edges based on the value of a field.<br/>
            Connect edges with <b>conditions</b> matching case names.
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: notify.telegram ═══ -->
      ${node.type === "notify.telegram" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #38bdf8; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("mail")}</span>
            Message Templates
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px;">
            ${[
              { label: "Task Done", icon: "check", msg: "Task completed: {{taskTitle}}" },
              { label: "Task Failed", icon: "alert", msg: "Task {{taskTitle}} failed after {{retryCount}} attempts. Manual intervention needed." },
              { label: "PR Merged", icon: "git", msg: "PR merged: {{prTitle}} → {{baseBranch}}" },
              { label: "Review Done", icon: "edit", msg: "PR review complete for {{branch}}: {{verdict}}" },
              { label: "Tasks Planned", icon: "clipboard", msg: "Task planner added {{newTaskCount}} tasks to backlog" },
              { label: "Deployed", icon: "rocket", msg: "Deployment to production completed for {{branch}}" },
              { label: "Needs Review", icon: "eye", msg: "PR needs manual review: {{reason}}" },
              { label: "Rate Limited", icon: "alert", msg: "Agent rate limited. Cooling down for {{cooldownSec}}s. Provider: {{provider}}" },
            ].map(p => html`
              <${Button}
                key=${p.label}
                onClick=${() => applyPreset({ message: p.msg })}
                variant="outlined"
                size="small"
                sx=${{ padding: '4px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: '#1a1f2e', color: '#c9d1d9', cursor: 'pointer', textAlign: 'left', textTransform: 'none', display: 'block', width: '100%' }}
              >
                <span style="display: inline-flex; align-items: center; gap: 6px;">
                  <span class="btn-icon">${resolveIcon(p.icon)}</span>
                  <span>${p.label}</span>
                </span>
              <//>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: notify.log ═══ -->
      ${node.type === "notify.log" && html`
        <div style="margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 4px;">
          ${["info", "warn", "error", "debug"].map(lv => html`
            <${Button}
              key=${lv}
              onClick=${() => applyPreset({ level: lv })}
              variant="outlined"
              size="small"
              sx=${{ padding: '3px 10px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.level === lv ? '#1e293b' : '#1a1f2e', color: lv === 'error' ? '#ef4444' : lv === 'warn' ? '#f59e0b' : lv === 'debug' ? '#6b7280' : '#60a5fa', cursor: 'pointer', textTransform: 'none' }}
            >
              ${lv.toUpperCase()}
            <//>
          `)}
        </div>
      `}

      <!-- ═══ Smart Presets: validation nodes ═══ -->
      ${nodeCategory === "validation" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("check")}</span>
            Validation Commands
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${[
              ...(nodeAction === "build" ? [
                { label: "npm run build", cmd: "npm run build" },
                { label: "yarn build", cmd: "yarn build" },
                { label: "go build", cmd: "go build ./..." },
                { label: "cargo build", cmd: "cargo build" },
                { label: "mvn package", cmd: "mvn package -DskipTests" },
                { label: "gradlew build", cmd: "./gradlew build" },
                { label: "dotnet build", cmd: "dotnet build" },
                { label: "make", cmd: "make" },
                { label: "Zero Warnings", cmd: "npm run build", extra: { zeroWarnings: true } },
              ] : []),
              ...(nodeAction === "tests" ? [
                { label: "npm test", cmd: "npm test" },
                { label: "Vitest", cmd: "npx vitest run" },
                { label: "Jest", cmd: "npx jest" },
                { label: "pytest", cmd: "pytest" },
                { label: "go test", cmd: "go test ./..." },
                { label: "cargo test", cmd: "cargo test" },
                { label: "mvn test", cmd: "mvn test" },
                { label: "dotnet test", cmd: "dotnet test" },
                { label: "rspec", cmd: "bundle exec rspec" },
              ] : []),
              ...(nodeAction === "lint" ? [
                { label: "npm run lint", cmd: "npm run lint" },
                { label: "ESLint", cmd: "npx eslint ." },
                { label: "Ruff", cmd: "ruff check ." },
                { label: "golangci-lint", cmd: "golangci-lint run" },
                { label: "Clippy", cmd: "cargo clippy -- -D warnings" },
                { label: "Rubocop", cmd: "bundle exec rubocop" },
              ] : []),
            ].map(p => html`
              <${Button}
                key=${p.label}
                onClick=${() => applyPreset({ command: p.cmd, ...(p.extra || {}) })}
                variant="outlined"
                size="small"
                sx=${{ padding: '3px 8px', fontSize: '11px', border: '1px solid #2a3040', borderRadius: '6px', background: config.command === p.cmd ? '#0d3320' : '#1a1f2e', color: config.command === p.cmd ? '#34d399' : '#c9d1d9', cursor: 'pointer', textTransform: 'none' }}
              >
                ${p.label}
              <//>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Config Fields (schema-driven) ═══ -->
      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${schemaEntries.map(([key, fieldSchema]) => {
          const value = config[key] ?? fieldSchema.default ?? "";
          const fieldType = fieldSchema.type || "string";
          const isRequired = typeInfo?.schema?.required?.includes(key);

          return html`
            <div key=${key} class="wf-config-field">
              <label style="display: block; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 4px;">
                ${key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}
                ${isRequired && html`<span style="color: #ef4444;">*</span>`}
              </label>
              ${fieldSchema.description && html`
                <div style="font-size: 10px; color: var(--color-text-secondary, #6b7280); margin-bottom: 4px;">${fieldSchema.description}</div>
              `}

              ${fieldType === "boolean" ? html`
                <${FormControlLabel}
                  control=${html`<${Switch}
                    checked=${!!value}
                    onChange=${(e) => onFieldChange(key, e.target.checked)}
                    size="small"
                  />`}
                  label=${value ? "Enabled" : "Disabled"}
                />
              ` : fieldType === "number" ? html`
                <${TextField}
                  type="number"
                  size="small"
                  variant="outlined"
                  value=${value}
                  onInput=${(e) => onFieldChange(key, Number(e.target.value))}
                  fullWidth
                  placeholder=${fieldSchema.default != null ? `Default: ${fieldSchema.default}` : ""}
                />
              ` : fieldSchema.enum ? html`
                <${Select}
                  value=${value}
                  onChange=${(e) => onFieldChange(key, e.target.value)}
                  size="small"
                  fullWidth
                >
                  <${MenuItem} value="">— select —</${MenuItem}>
                  ${fieldSchema.enum.map(opt => html`<${MenuItem} key=${opt} value=${opt}>${opt}</${MenuItem}>`)}
                </${Select}>
              ` : (typeof value === "string" && value.length > 80) || key === "prompt" || key === "expression" || key === "template" || key === "command" || key === "body" || key === "message" || key === "filter" ? html`
                <${TextField}
                  multiline
                  rows=${key === "prompt" ? 6 : 4}
                  size="small"
                  variant="outlined"
                  value=${typeof value === "object" ? JSON.stringify(value, null, 2) : value}
                  onInput=${(e) => onFieldChange(key, e.target.value)}
                  fullWidth
                  placeholder=${fieldSchema.default != null ? String(fieldSchema.default) : ""}
                />
              ` : html`
                <${TextField}
                  size="small"
                  variant="outlined"
                  value=${typeof value === "object" ? JSON.stringify(value) : value}
                  onInput=${(e) => onFieldChange(key, e.target.value)}
                  fullWidth
                  placeholder=${fieldSchema.default != null ? String(fieldSchema.default) : ""}
                />
              `}
            </div>
          `;
        })}
      </div>

      <!-- No schema fields hint -->
      ${schemaEntries.length === 0 && html`
        <div style="padding: 12px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 8px; text-align: center; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #6b7280;">Advanced settings only.</div>
          <div style="font-size: 10px; color: #4b5563; margin-top: 4px;">Primary fields are editable inline on the node body.</div>
        </div>
      `}

      <!-- Continue on Error toggle -->
      <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border, #2a3040);">
        <${FormControlLabel}
          control=${html`<${Switch}
            checked=${!!config.continueOnError}
            onChange=${(e) => onUpdate({ continueOnError: e.target.checked })}
            size="small"
          />`}
          label="Continue on Error"
        />
        <div style="font-size: 10px; color: var(--color-text-secondary, #6b7280); margin-top: 4px;">
          If checked, workflow continues even if this node fails
        </div>
      </div>

      <!-- Timeout -->
      <div style="margin-top: 12px;">
        <${TextField}
          type="number"
          size="small"
          variant="outlined"
          label="Timeout (ms)"
          value=${config.timeout || ""}
          onInput=${(e) => onUpdate({ timeout: Number(e.target.value) || undefined })}
          placeholder="Default: 600000"
          fullWidth
        />
      </div>

      <!-- Delete button -->
      <${Button}
        onClick=${() => { if (confirm("Delete this node?")) onDelete(); }}
        variant="outlined"
        size="small"
        sx=${{ width: '100%', marginTop: '20px', background: '#dc262620', color: '#ef4444', borderColor: '#ef444440', textTransform: 'none' }}
      >
        <span class="btn-icon">${resolveIcon("trash")}</span>
        Delete Node
      <//>

      <!-- Raw JSON -->
      <details style="margin-top: 16px;">
        <summary style="cursor: pointer; font-size: 12px; color: var(--color-text-secondary, #6b7280);">Raw JSON</summary>
        <pre style="font-size: 10px; color: #8b95a5; background: #1a1f2e; padding: 8px; border-radius: 6px; overflow-x: auto; margin-top: 6px; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(node, null, 2)}</pre>
      </details>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Workflow List View
 * ═══════════════════════════════════════════════════════════════ */

function humanizeWorkflowCategory(category) {
  const normalized = String(category || "custom").trim();
  if (!normalized) return "Custom";
  return normalized
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeWorkflowCategoryMeta(source, fallbackCategory = "custom") {
  const key = String(source?.category || fallbackCategory || "custom").trim() || "custom";
  const order = Number(source?.categoryOrder);
  return {
    key,
    label: String(source?.categoryLabel || humanizeWorkflowCategory(key)),
    icon: String(source?.categoryIcon || "settings"),
    order: Number.isFinite(order) ? order : 99,
  };
}

function groupItemsByWorkflowCategory(items, getSource) {
  const groups = new Map();
  for (const item of items || []) {
    const meta = normalizeWorkflowCategoryMeta(getSource(item), item?.category);
    if (!groups.has(meta.key)) groups.set(meta.key, { ...meta, items: [] });
    groups.get(meta.key).items.push(item);
  }
  return Array.from(groups.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

function resolveWorkflowTemplateSource(workflow, templateLookupById, templateLookupByName) {
  const templateState = workflow?.metadata?.templateState || null;
  const candidates = [
    templateState?.templateId,
    workflow?.metadata?.installedFrom,
    templateState?.templateName,
    workflow?.name,
  ];
  for (const candidate of candidates) {
    const key = String(candidate || "").trim();
    if (!key) continue;
    if (templateLookupById.has(key)) return templateLookupById.get(key);
    if (templateLookupByName.has(key)) return templateLookupByName.get(key);
  }
  return null;
}

function WorkflowListView() {
  const wfs = workflows.value || [];
  const tmpls = templates.value || [];
  const isWorkflowListLoading = workflowsLoading.value;
  const isTemplateListLoading = templatesLoading.value;
  const installedTemplateIds = new Set();
  wfs.forEach((wf) => {
    if (wf.metadata?.installedFrom) installedTemplateIds.add(wf.metadata.installedFrom);
    installedTemplateIds.add(wf.name);
  });
  const availableTemplates = tmpls.filter((t) => {
    if (installedTemplateIds.has(t.id) || installedTemplateIds.has(t.name)) return false;
    return true;
  });
  const templateLookup = useMemo(() => {
    const byId = new Map();
    const byName = new Map();
    tmpls.forEach((template) => {
      const id = String(template?.id || "").trim();
      const name = String(template?.name || "").trim();
      if (id) byId.set(id, template);
      if (name) byName.set(name, template);
    });
    return { byId, byName };
  }, [tmpls]);
  const workflowGroups = useMemo(() => {
    return groupItemsByWorkflowCategory(wfs, (wf) => {
      return (
        resolveWorkflowTemplateSource(wf, templateLookup.byId, templateLookup.byName)
        || { category: wf?.category || "custom" }
      );
    });
  }, [wfs, templateLookup]);
  const availableTemplateGroups = useMemo(() => {
    return groupItemsByWorkflowCategory(availableTemplates, (template) => template);
  }, [availableTemplates]);

  return html`
    <div style="padding: 0 4px;">

      <!-- Header -->
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <h2 style="margin: 0; font-size: 18px; font-weight: 700;">Workflows</h2>
        <${Button}
          type="button"
          variant="contained"
          size="small"
          onClick=${() => {
            const newWf = {
              name: "New Workflow",
              description: "",
              category: "custom",
              enabled: true,
              nodes: [],
              edges: [],
              variables: {},
            };
            saveWorkflow(newWf).then(wf => {
              if (wf) {
                activeWorkflow.value = wf;
                viewMode.value = "canvas";
              }
            });
          }}
        >
          <span class="btn-icon">${resolveIcon("plus")}</span>
          Create Workflow
        <//>
        <${Button} type="button" variant="outlined" size="small" onClick=${() => { selectedRunId.value = null; selectedRunDetail.value = null; resetWorkflowRunsState(); viewMode.value = "runs"; loadRuns(null, { reset: true }); }}>
          <span class="btn-icon">${resolveIcon("chart")}</span>
          Run History
        <//>
        <${Button} type="button" variant="outlined" size="small" onClick=${() => relayoutInstalledTemplateWorkflows()}>
          <span class="btn-icon">${resolveIcon("refresh")}</span>
          Re-layout Installed Templates
        <//>
      </div>

      <!-- Active Workflows -->
      ${isWorkflowListLoading && html`
        <div style="text-align: center; padding: 40px 20px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; margin-bottom: 24px; border: 1px solid var(--color-border, #2a3040);">
          <${CircularProgress} size=${28} />
          <div style="font-size: 16px; font-weight: 600; margin-top: 12px; margin-bottom: 8px;">Loading workflows…</div>
          <div style="font-size: 13px; color: var(--color-text-secondary, #8b95a5);">Fetching installed workflows and template metadata.</div>
        </div>
      `}

      ${!isWorkflowListLoading && wfs.length > 0 && html`
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
            Your Workflows (${wfs.length})
          </h3>
          ${workflowGroups.map((group) => html`
            <div key=${group.key} style="margin-bottom: 20px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--color-border, #2a304060);">
                <span class="icon-inline" style="font-size: 16px;">${resolveIcon(group.icon) || ICONS.dot}</span>
                <span style="font-size: 13px; font-weight: 600; color: var(--color-text-secondary, #8b95a5);">${group.label}</span>
                <span style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">(${group.items.length})</span>
              </div>
              <div style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
                ${group.items.map(wf => html`
                  ${(() => {
                    const templateState = wf.metadata?.templateState || null;
                    const hasTemplateUpdate = templateState?.updateAvailable === true;
                    const isCustomizedTemplate = templateState?.isCustomized === true;
                    const isCore = wf.core === true;
                    return html`
                  <div key=${wf.id} class="wf-card" style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; padding: 14px; border: 1px solid var(--color-border, #2a3040); cursor: pointer; transition: border-color 0.15s; display: flex; flex-direction: column; gap: 8px;"
                       onClick=${() => {
                         apiFetch("/api/workflows/" + wf.id).then(d => {
                           activeWorkflow.value = d?.workflow || wf;
                           viewMode.value = "canvas";
                         }).catch(() => { activeWorkflow.value = wf; viewMode.value = "canvas"; });
                       }}>
                    <div style="display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;">
                      <span class="icon-inline" style="font-size: 14px; flex: 0 0 auto; margin-top: 1px;">${resolveIcon(getNodeMeta(wf.trigger || "action")?.icon) || ICONS.dot}</span>
                      <span style="font-weight: 600; font-size: 14px; flex: 1 1 160px; min-width: 0; line-height: 1.25;">${wf.name}</span>
                      <span style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
                        <span class="wf-badge" style="background: ${wf.enabled ? '#10b98130' : '#6b728030'}; color: ${wf.enabled ? '#10b981' : '#6b7280'}; font-size: 10px; white-space: nowrap;">
                          ${wf.enabled ? "Active" : "Paused"}
                        </span>
                        ${isCore && html`
                          <span class="wf-badge" style="background: #8b5cf620; color: #a78bfa; font-size: 10px; font-weight: 600; white-space: nowrap;">
                            Core
                          </span>
                        `}
                        ${templateState?.templateId && html`
                          <span class="wf-badge" style="background: #3b82f620; color: #60a5fa; font-size: 10px; white-space: nowrap;">
                            Template
                          </span>
                        `}
                        ${isCustomizedTemplate && html`
                          <span class="wf-badge" style="background: #f59e0b20; color: #f59e0b; font-size: 10px; white-space: nowrap;">
                            Customized
                          </span>
                        `}
                        ${hasTemplateUpdate && html`
                          <span class="wf-badge" style="background: #ef444420; color: #f87171; font-size: 10px; white-space: nowrap;">
                            Update Available
                          </span>
                        `}
                      </span>
                    </div>
                    ${wf.description && html`
                      <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 8px; line-height: 1.4;">
                        ${wf.description.slice(0, 120)}${wf.description.length > 120 ? "…" : ""}
                      </div>
                    `}
                    ${templateState?.templateId && html`
                      <div style="font-size: 11px; color: var(--color-text-secondary, #7f8aa0); margin-bottom: 8px;">
                        ${templateState.templateName || templateState.templateId}
                        ${templateState.installedTemplateVersion && templateState.templateVersion && templateState.installedTemplateVersion !== templateState.templateVersion && html`
                          <span> · v${templateState.installedTemplateVersion} → v${templateState.templateVersion}</span>
                        `}
                      </div>
                    `}
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 2px;">
                      <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--color-text-secondary, #6b7280);">
                        <span style="white-space: nowrap;">${wf.nodeCount || 0} nodes</span>
                        <span>·</span>
                        <span class="wf-badge" style="font-size: 10px; padding: 2px 8px; background: var(--color-bg, #0d1117); color: var(--color-text-secondary, #8b95a5); white-space: nowrap;">
                          ${group.label}
                        </span>
                      </div>
                      <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap; justify-content: flex-end;">
                        ${hasTemplateUpdate && html`
                          <${Button}
                            variant="text"
                            size="small"
                            sx=${{ fontSize: '11px', borderColor: '#f59e0b80', color: '#f59e0b', textTransform: 'none', whiteSpace: 'nowrap' }}
                          onClick=${async (e) => {
                            e.stopPropagation();
                            if (!isCustomizedTemplate) {
                              await applyTemplateUpdate(wf.id, "replace", true);
                              return;
                            }
                            const choice = window.prompt(
                              "Template update available for customized workflow.\nType 'copy' to create an updated copy, or 'replace' to overwrite this workflow.",
                              "copy",
                            );
                            const normalized = String(choice || "").trim().toLowerCase();
                            if (normalized === "copy") {
                              await applyTemplateUpdate(wf.id, "copy", false);
                              return;
                            }
                            if (normalized === "replace") {
                              const ok = window.confirm("Replace this customized workflow with latest template? This cannot be undone.");
                              if (!ok) return;
                              await applyTemplateUpdate(wf.id, "replace", true);
                            }
                          }}
                          >
                            <span class="icon-inline">${resolveIcon("refresh")}</span>
                            Update
                          <//>
                        `}
                        ${!isCore && html`<${Button}
                          variant="text"
                          size="small"
                          sx=${{ fontSize: '11px', textTransform: 'none', whiteSpace: 'nowrap' }}
                          onClick=${(e) => {
                            e.stopPropagation();
                            setWorkflowEnabled(wf.id, !wf.enabled);
                          }}
                        >
                          <span class="icon-inline">${resolveIcon(wf.enabled ? "pause" : "play")}</span>
                          ${wf.enabled ? "Pause" : "Resume"}
                        <//>`}
                        <${Button}
                          variant="text"
                          size="small"
                          sx=${{ fontSize: '11px', textTransform: 'none', whiteSpace: 'nowrap', ...(wf.enabled ? {} : { opacity: 0.65 }) }}
                          onClick=${(e) => {
                            e.stopPropagation();
                            if (!wf.enabled) {
                              showToast("Workflow is paused. Resume it before running.", "warning");
                              return;
                            }
                            openExecuteDialog(wf.id);
                          }}
                        >
                          <span class="icon-inline">${resolveIcon("play")}</span>
                        <//>
                        <${Button}
                          variant="text"
                          size="small"
                          sx=${{ fontSize: '11px', textTransform: 'none', whiteSpace: 'nowrap' }}
                          onClick=${(e) => {
                            e.stopPropagation();
                            exportWorkflow(wf);
                          }}
                        >
                          <span class="icon-inline">${resolveIcon("save")}</span>
                        <//>
                        ${!isCore && html`<${Button} variant="text" size="small" sx=${{ fontSize: '11px', color: '#ef4444', textTransform: 'none', whiteSpace: 'nowrap' }} onClick=${(e) => { e.stopPropagation(); if (confirm("Delete " + wf.name + "?")) deleteWorkflow(wf.id); }}>
                          <span class="icon-inline">${resolveIcon("trash")}</span>
                        <//>`}
                      </div>
                    </div>
                  </div>
                `;
                  })()}
                `)}
              </div>
            </div>
          `)}
        </div>
      `}

      ${!isWorkflowListLoading && wfs.length === 0 && html`
        <div style="text-align: center; padding: 40px 20px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; margin-bottom: 24px; border: 1px solid var(--color-border, #2a3040);">
          <div style="font-size: 36px; margin-bottom: 12px;">
            <span class="icon-inline">${resolveIcon("refresh")}</span>
          </div>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No Workflows Yet</div>
          <div style="font-size: 13px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 16px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            Workflows automate your development pipeline — from PR merging
            to error recovery. Install a template below or create one from scratch.
          </div>
          <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
            <${Button} variant="contained" size="small" onClick=${() => {
              const newWf = { name: "New Workflow", description: "", category: "custom", enabled: true, nodes: [], edges: [], variables: {} };
              saveWorkflow(newWf).then(wf => { if (wf) { activeWorkflow.value = wf; viewMode.value = "canvas"; } });
            }}>+ Create Blank<//>
            ${availableTemplates.length > 0 && html`
              <${Button} variant="outlined" size="small" sx=${{ borderColor: '#f59e0b60', color: '#f59e0b', textTransform: 'none' }} onClick=${() => openInstallTemplateDialog(availableTemplates[0]?.id)}>
                <span class="btn-icon">${resolveIcon("zap")}</span>
                Quick Install: ${availableTemplates[0]?.name}
              <//>
            `}
          </div>
        </div>
      `}

      <!-- Templates (grouped by category, deduped against installed) -->
      <div>
        <h3 style="font-size: 14px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
          Available Templates (${isTemplateListLoading ? "…" : availableTemplates.length})${!isTemplateListLoading && tmpls.length !== availableTemplates.length ? html` <span style="font-size: 11px; font-weight: 400; opacity: 0.6;">· ${tmpls.length - availableTemplates.length} installed</span>` : ""}
        </h3>
        ${isTemplateListLoading && html`
          <div style="text-align: center; padding: 24px; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 8px;">
            <${CircularProgress} size=${18} />
            <span>Loading templates…</span>
          </div>
        `}
        ${!isTemplateListLoading && availableTemplates.length === 0 && html`
          <div style="text-align: center; padding: 24px; opacity: 0.5; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px;">
            <span class="icon-inline">${resolveIcon("star")}</span>
            <span>All templates are installed!</span>
          </div>
        `}
        ${!isTemplateListLoading && availableTemplateGroups.map((group) => html`
          <div key=${group.key} style="margin-bottom: 20px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--color-border, #2a304060);">
              <span class="icon-inline" style="font-size: 16px;">${resolveIcon(group.icon) || ICONS.dot}</span>
              <span style="font-size: 13px; font-weight: 600; color: var(--color-text-secondary, #8b95a5);">${group.label}</span>
              <span style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">(${group.items.length})</span>
            </div>
            <div style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));">
              ${group.items.map(t => html`
                <div key=${t.id} class="wf-card wf-template-card" style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; padding: 14px; border: 1px solid var(--color-border, #2a304080);">
                  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                    <span class="icon-inline" style="font-size: 14px;">${resolveIcon(t.categoryIcon || group.icon) || ICONS.dot}</span>
                    <span style="font-weight: 600; font-size: 14px; flex: 1;">${t.name}</span>
                    ${t.recommended && html`
                      <span class="wf-badge" style="background: #10b98125; color: #10b981; border-color: #10b98140; font-size: 10px; padding: 2px 8px; font-weight: 600; letter-spacing: 0.3px; display: inline-flex; align-items: center; gap: 4px;">
                        <span class="icon-inline">${resolveIcon("star")}</span>
                        Recommended
                      </span>
                    `}
                  </div>
                  <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 10px; line-height: 1.4;">
                    ${t.description?.slice(0, 120)}${(t.description?.length || 0) > 120 ? "…" : ""}
                  </div>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
                    ${(t.tags || []).map(tag => html`
                      <span key=${tag} class="wf-badge" style="font-size: 10px; padding: 2px 6px;">${tag}</span>
                    `)}
                  </div>
                  <div style="display: flex; gap: 8px; align-items: center;">
                    <span style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">${t.nodeCount} nodes</span>
                    <div style="flex: 1;"></div>
                    <${Button}
                      variant="contained"
                      size="small"
                      onClick=${() => openInstallTemplateDialog(t.id)}
                    >
                      Install →
                    <//>
                  </div>
                </div>
              `)}
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run History View
 * ═══════════════════════════════════════════════════════════════ */

function normalizeLiveNodeStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return "";
  if (s === "success" || s === "done" || s === "complete") return "completed";
  if (s === "fail" || s === "error" || s === "errored") return "failed";
  if (s === "in_progress" || s === "active" || s === "executing") return "running";
  if (s === "idle" || s === "queued") return "pending";
  return s;
}

function getRunStatusBadgeStyles(status) {
  const normalized = normalizeLiveNodeStatus(status) || String(status || "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "success") return { bg: "#10b98130", color: "#10b981" };
  if (normalized === "failed" || normalized === "fail") return { bg: "#ef444430", color: "#ef4444" };
  if (normalized === "running") return { bg: "#3b82f630", color: "#60a5fa" };
  if (normalized === "skipped") return { bg: "#94a3b830", color: "#94a3b8" };
  return { bg: "#6b728030", color: "#9ca3af" };
}

function getCanvasNodeExecutionVisuals(status, isSelected, selectedColor, flashState = "") {
  const normalized = normalizeLiveNodeStatus(status) || String(status || "").trim().toLowerCase();
  if (normalized === "running") {
    return { fill: "#10233f", stroke: "#60a5fa", strokeWidth: 2.5, filter: "url(#node-glow)" };
  }
  if (normalized === "failed" || normalized === "fail" || flashState === "fail") {
    return { fill: "#2a1217", stroke: "#ef4444", strokeWidth: 2.25, filter: "url(#node-shadow)" };
  }
  if (normalized === "completed" || normalized === "success" || flashState === "success") {
    return { fill: "#0f2a23", stroke: "#10b981", strokeWidth: 2, filter: "url(#node-shadow)" };
  }
  if (normalized === "skipped" || flashState === "skipped") {
    return { fill: "#1f2430", stroke: "#94a3b8", strokeWidth: 2, filter: "url(#node-shadow)" };
  }
  if (normalized === "waiting" || normalized === "pending") {
    return { fill: "#2f2310", stroke: "#f59e0b", strokeWidth: 2, filter: "url(#node-shadow)" };
  }
  return {
    fill: isSelected ? "#1e293b" : "#1a1f2e",
    stroke: isSelected ? selectedColor : "#2a3040",
    strokeWidth: isSelected ? 2 : 1,
    filter: isSelected ? "url(#node-glow)" : "url(#node-shadow)",
  };
}

function getNodeStatusRank(status) {
  const normalized = normalizeLiveNodeStatus(status) || status;
  if (normalized === "running") return 0;
  if (normalized === "failed" || normalized === "fail") return 1;
  if (status === "waiting") return 2;
  if (status === "pending") return 3;
  if (normalized === "completed" || normalized === "success") return 4;
  if (normalized === "skipped") return 5;
  return 6;
}

function getRunActivityAt(run) {
  const lastLogAt = Number(run?.lastLogAt);
  const lastProgressAt = Number(run?.lastProgressAt);
  const startedAt = Number(run?.startedAt);
  const candidates = [lastLogAt, lastProgressAt, startedAt].filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function normalizeWorkflowRunTriggerSource(run) {
  const rawSource = String(run?.triggerSource || "").trim().toLowerCase();
  const triggerEvent = String(run?.triggerEvent || "").trim().toLowerCase();
  if (!rawSource) {
    return triggerEvent ? "event" : "unknown";
  }
  if (rawSource === "manual") return "manual";
  if (
    rawSource === "monitor-event" ||
    rawSource === "monitor" ||
    rawSource === "schedule-poll" ||
    rawSource === "startup" ||
    rawSource === "manual-sweep" ||
    rawSource.includes("schedule")
  ) {
    return "monitor-event";
  }
  if (
    rawSource === "event" ||
    rawSource === "ui-server" ||
    rawSource === "ui-event" ||
    rawSource.includes("webhook") ||
    triggerEvent
  ) {
    return "event";
  }
  return rawSource;
}

function getWorkflowRunTriggerLabel(run) {
  const normalizedSource = normalizeWorkflowRunTriggerSource(run);
  const rawSource = String(run?.triggerSource || "").trim().toLowerCase();
  const triggerEvent = String(run?.triggerEvent || "").trim();
  if (normalizedSource === "manual") return "manual";
  if (normalizedSource === "monitor-event") {
    if (triggerEvent) return `monitor:${triggerEvent}`;
    if (rawSource && rawSource !== "monitor-event") return `monitor:${rawSource}`;
    return "monitor";
  }
  if (normalizedSource === "event") {
    if (triggerEvent) return `event:${triggerEvent}`;
    return rawSource || "event";
  }
  return rawSource || normalizedSource || "unknown";
}

function getNodeCardBorder(status) {
  if (status === "running") return "#3b82f680";
  if (status === "failed") return "#ef444480";
  if (status === "waiting") return "#f59e0b80";
  return "var(--color-border, #2a3040)";
}

function safePrettyJson(value) {
  try {
    const json = JSON.stringify(value, null, 2);
    const maxChars = 120000;
    if (json.length <= maxChars) return json;
    const omitted = json.length - maxChars;
    return `${json.slice(0, maxChars)}\n\n… [truncated ${omitted} chars]`;
  } catch {
    return String(value ?? "");
  }
}

function RunHistoryView() {
  const runs = workflowRuns.value || [];
  const runsLoading = workflowRunsLoading.value === true;
  const runsError = String(workflowRunsError.value || "").trim();
  const totalRuns = Number(workflowRunsTotal.value || runs.length);
  const hasMoreRuns = workflowRunsHasMore.value === true;
  const loadingMoreRuns = workflowRunsLoadingMore.value === true;
  const selectedRun = selectedRunDetail.value;
  const runDetailLoading = workflowRunDetailLoading.value === true;
  const runDetailError = String(workflowRunDetailError.value || "").trim();
  const scopedWorkflowId = String(workflowRunsScopeId.value || "").trim();
  const scopedWorkflowName = scopedWorkflowId ? getWorkflowNameById(scopedWorkflowId) : "";
  const workflowNameMap = new Map((workflows.value || []).map((wf) => [wf.id, wf.name]));
  const [nowTick, setNowTick] = useState(Date.now());
  const [approvalRequests, setApprovalRequests] = useState([]);
  const [approvalStatusFilter, setApprovalStatusFilter] = useState("pending");
  const [approvalScopeFilter, setApprovalScopeFilter] = useState("all");
  const [approvalQueueLoading, setApprovalQueueLoading] = useState(false);
  const [operatorHarnessRuns, setOperatorHarnessRuns] = useState([]);
  const hasRunningRuns = runs.some((run) => run?.status === "running");
  const selectedRunIsRunning = selectedRun?.status === "running";
  const [statusFilter, setStatusFilter] = useState("all");
  const [workflowFilter, setWorkflowFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [logsPaneSearch, setLogsPaneSearch] = useState("");
  const [errorsPaneSearch, setErrorsPaneSearch] = useState("");
  const [ledgerPaneSearch, setLedgerPaneSearch] = useState("");
  const [rawPaneSearch, setRawPaneSearch] = useState("");
  const [selectedRunEvaluation, setSelectedRunEvaluation] = useState(null);
  const [selectedRunForensics, setSelectedRunForensics] = useState(null);
  const [selectedRunSnapshots, setSelectedRunSnapshots] = useState([]);
  const [runDiagnosticsLoading, setRunDiagnosticsLoading] = useState(false);
  const [runActionBusy, setRunActionBusy] = useState("");
  const normalizedSearch = String(searchQuery || "").trim().toLowerCase();

  const loadApprovals = useCallback(async (statusOverride = approvalStatusFilter) => {
    setApprovalQueueLoading(true);
    try {
      const status = statusOverride || "pending";
      const [workflowData, harnessData, harnessRunsData] = await Promise.all([
        apiFetch(buildWorkflowRunApiPath(
          appendQueryParams("/api/workflows/approvals", {
            limit: 100,
            status,
          }),
        )).catch(() => ({ requests: [] })),
        apiFetch(appendQueryParams("/api/harness/approvals", {
          limit: 100,
          status,
          includeResolved: status === "all" ? "1" : "",
        })).catch(() => ({ requests: [] })),
        apiFetch("/api/harness/runs?limit=8").catch(() => ({ runs: [] })),
      ]);
      setApprovalRequests(mergeApprovalRequestLists(
        Array.isArray(workflowData?.requests) ? workflowData.requests : [],
        Array.isArray(harnessData?.requests) ? harnessData.requests : [],
      ));
      setOperatorHarnessRuns(Array.isArray(harnessRunsData?.runs) ? harnessRunsData.runs : []);
    } catch (err) {
      console.error("[workflows] Failed to load approvals:", err);
    } finally {
      setApprovalQueueLoading(false);
    }
  }, [approvalStatusFilter]);

  const approvalQueuePendingCount = useMemo(
    () => approvalRequests.filter((entry) => String(entry?.status || "").trim().toLowerCase() === "pending").length,
    [approvalRequests],
  );
  const approvalScopeCounts = useMemo(() => {
    const counts = {
      all: approvalRequests.length,
      pending: 0,
      "workflow-run": 0,
      "workflow-gate": 0,
      "workflow-action": 0,
      "harness-run": 0,
      other: 0,
    };
    for (const entry of approvalRequests) {
      const status = String(entry?.status || "").trim().toLowerCase();
      const scopeType = normalizeApprovalScopeType(entry?.scopeType);
      if (status === "pending") counts.pending += 1;
      if (Object.prototype.hasOwnProperty.call(counts, scopeType)) counts[scopeType] += 1;
      else counts.other += 1;
    }
    return counts;
  }, [approvalRequests]);
  const filteredApprovalRequests = useMemo(() => {
    if (approvalScopeFilter === "all") return approvalRequests;
    return approvalRequests.filter((entry) => normalizeApprovalScopeType(entry?.scopeType) === approvalScopeFilter);
  }, [approvalRequests, approvalScopeFilter]);
  useEffect(() => {
    setLogsPaneSearch("");
    setErrorsPaneSearch("");
    setLedgerPaneSearch("");
    setRawPaneSearch("");
  }, [selectedRunId.value]);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    loadApprovals(approvalStatusFilter).catch(() => {});
  }, [approvalStatusFilter, loadApprovals]);

  useEffect(() => {
    let cancelled = false;
    const pollMs = hasRunningRuns || selectedRunIsRunning ? 8000 : 20000;

    const poll = async () => {
      if (cancelled) return;
      const activeRunId = String(selectedRunId.value || "").trim();
      if (!activeRunId) {
        await loadRuns(undefined, { preserveExisting: true }).catch(() => {});
        await loadApprovals(approvalStatusFilter).catch(() => {});
        return;
      }
      if (!cancelled && selectedRunIsRunning) {
        await loadRunDetail(selectedRunId.value).catch(() => {});
      }
    };

    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [approvalStatusFilter, hasRunningRuns, loadApprovals, selectedRunIsRunning, selectedRunId.value]);

  const workflowOptions = useMemo(() => {
    const map = new Map();
    for (const run of runs) {
      const id = String(run?.workflowId || "").trim();
      if (!id || map.has(id)) continue;
      const name =
        run?.workflowName ||
        workflowNameMap.get(id) ||
        id;
      map.set(id, name);
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [runs, workflows.value]);

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      const runStatus = String(run?.status || "unknown");
      const runWorkflowId = String(run?.workflowId || "");
      const runWorkflowName =
        String(run?.workflowName || workflowNameMap.get(runWorkflowId) || runWorkflowId)
          .toLowerCase();
      const runTriggerSource = normalizeWorkflowRunTriggerSource(run);
      const runTriggerEvent = String(run?.triggerEvent || "").toLowerCase();
      const runId = String(run?.runId || "").toLowerCase();

      if (statusFilter !== "all" && runStatus !== statusFilter) return false;
      if (workflowFilter !== "all" && runWorkflowId !== workflowFilter) return false;
      if (triggerFilter !== "all" && runTriggerSource !== triggerFilter) return false;
      if (
        normalizedSearch &&
        !runWorkflowName.includes(normalizedSearch) &&
        !runTriggerEvent.includes(normalizedSearch) &&
        !runId.includes(normalizedSearch)
      ) {
        return false;
      }
      return true;
    });
  }, [runs, workflowNameMap, statusFilter, workflowFilter, triggerFilter, normalizedSearch]);

  const runCounts = useMemo(() => {
    const counts = { all: runs.length, running: 0, failed: 0, completed: 0, paused: 0 };
    for (const run of runs) {
      const status = String(run?.status || "");
      if (status in counts) counts[status] += 1;
    }
    return counts;
  }, [runs]);

  const runMetrics = useMemo(() => {
    const completed = Number(runCounts.completed || 0);
    const failed = Number(runCounts.failed || 0);
    const settled = completed + failed;
    const successRate = settled > 0 ? Math.round((completed / settled) * 100) : 0;
    const stuckCount = runs.filter((run) => run?.status === "running" && run?.isStuck).length;
    const activeNodes = runs
      .filter((run) => run?.status === "running")
      .reduce((sum, run) => sum + Number(run?.activeNodeCount || 0), 0);
    return {
      settled,
      successRate,
      stuckCount,
      activeNodes,
    };
  }, [runs, runCounts]);

  const canLoadMoreRuns =
    hasMoreRuns && runs.length < WORKFLOW_RUN_MAX_FETCH;
  const triggerLoadMoreRuns = useCallback(() => {
    if (!canLoadMoreRuns || loadingMoreRuns) return false;
    const nextOffset = Number(workflowRunsNextOffset.value || runs.length);
    if (nextOffset >= totalRuns && totalRuns > 0) return false;
    void loadRuns(undefined, {
      append: true,
      offset: nextOffset,
      limit: WORKFLOW_RUN_PAGE_SIZE,
    });
    return true;
  }, [canLoadMoreRuns, loadingMoreRuns, runs.length, totalRuns]);
  const resolveQueuedApproval = useCallback(async (request, decision) => {
    if (!request?.requestId) return;
    const notePrompt = decision === "approved" ? "Optional approval note" : "Reason for denying approval";
    const note = window.prompt(notePrompt, "") || "";
    try {
      const scopeType = String(request?.scopeType || "").trim().toLowerCase();
      const endpoint = scopeType === "workflow-run" && request.scopeId
        ? buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(request.scopeId)}/approval`)
        : scopeType === "harness-run"
          ? `/api/harness/approvals/${encodeURIComponent(request.requestId)}/resolve`
          : buildWorkflowRunApiPath(`/api/workflows/approvals/${encodeURIComponent(request.requestId)}/resolve`);
      await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify({ decision, note }),
      });
      showToast(decision === "approved" ? "Approval request granted" : "Approval request denied", "success");
      await loadApprovals(approvalStatusFilter);
      const requestRunId = String(request?.runId || "").trim();
      if (scopeType !== "harness-run" && requestRunId && selectedRunId.value === requestRunId) {
        setTimeout(() => loadRunDetail(requestRunId), 250);
      } else if (request.scopeType === "workflow-run" && request.scopeId && selectedRunId.value === request.scopeId) {
        setTimeout(() => loadRunDetail(request.scopeId), 250);
      }
    } catch (err) {
      showToast("Approval resolution failed: " + (err.message || err), "error");
    }
  }, [approvalStatusFilter, loadApprovals]);
  const describeApprovalRequest = useCallback((request) => {
    const scopeType = String(request?.scopeType || "").trim().toLowerCase();
    if (scopeType === "workflow-gate") {
      return `Manual Gate · ${request?.nodeLabel || request?.nodeId || request?.scopeId || "gate"}`;
    }
    if (scopeType === "workflow-action") {
      return `Action Approval · ${request?.action?.label || request?.nodeLabel || request?.nodeType || request?.scopeId || "action"}`;
    }
    if (scopeType === "harness-run") {
      return `Harness Run · ${request?.taskTitle || request?.runId || request?.scopeId || "harness"}`;
    }
    return `Workflow Run · ${request?.workflowName || request?.runId || request?.scopeId || "run"}`;
  }, []);
  const describeApprovalTarget = useCallback((request) => {
    const parts = [];
    const scopeType = String(request?.scopeType || "").trim().toLowerCase();
    if (scopeType === "harness-run") {
      if (request?.taskTitle) parts.push(request.taskTitle);
      if (request?.stageId) parts.push(`stage ${request.stageId}`);
      if (request?.runId) parts.push(`run ${request.runId}`);
      return parts.join(" · ") || "No harness target metadata";
    }
    if (request?.workflowName) parts.push(request.workflowName);
    if (request?.taskTitle) parts.push(request.taskTitle);
    if (request?.runId) parts.push(`run ${request.runId}`);
    return parts.join(" · ") || "No workflow target metadata";
  }, []);
  const operatorInboxItems = useMemo(() => {
    const approvals = approvalRequests
      .filter((entry) => String(entry?.status || "").trim().toLowerCase() === "pending")
      .map((request) => ({
        key: `approval:${request.requestId}`,
        kind: "approval",
        label: describeApprovalRequest(request),
        detail: describeApprovalTarget(request),
        state: String(request?.status || "pending").trim().toLowerCase() || "pending",
        createdAt: request?.requestedAt || request?.createdAt || request?.updatedAt || null,
        request,
      }));
    const harnessAttention = operatorHarnessRuns
      .filter((run) => {
        const state = String(
          run?.health?.state
          || run?.status
          || run?.outcome
          || run?.result?.status
          || "",
        ).trim().toLowerCase();
        return state === "waiting" || state === "stalled";
      })
      .map((run) => ({
        key: `harness:${run.runId}`,
        kind: "harness-attention",
        label: String(run?.taskTitle || run?.name || run?.runId || "Harness run").trim(),
        detail: String(
          run?.health?.attentionReason
          || run?.health?.lastEventSummary
          || run?.latestEvent?.summary
          || run?.summary
          || "Harness run needs operator attention."
        ).trim(),
        state: String(
          run?.health?.state
          || run?.status
          || run?.outcome
          || run?.result?.status
          || "unknown"
        ).trim().toLowerCase(),
        createdAt: run?.updatedAt || run?.createdAt || run?.startedAt || null,
        run,
      }));
    return [...approvals, ...harnessAttention].sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime() || 0;
      const bTime = new Date(b?.createdAt || 0).getTime() || 0;
      return bTime - aTime;
    });
  }, [approvalRequests, describeApprovalRequest, describeApprovalTarget, operatorHarnessRuns]);
  const openApprovalTarget = useCallback((request) => {
    const scopeType = normalizeApprovalScopeType(request?.scopeType);
    const requestRunId = String(request?.runId || "").trim();
    const requestScopeId = String(request?.scopeId || "").trim();
    if (scopeType === "harness-run") {
      navigateTo("agents", {
        params: {
          harnessRunId: requestRunId || requestScopeId,
          harnessSource: "workflow-approvals",
        },
      });
      return;
    }
    if (requestRunId) {
      loadRunDetail(requestRunId);
      return;
    }
    if (scopeType === "workflow-run" && requestScopeId) {
      loadRunDetail(requestScopeId);
      return;
    }
    const workflowId = String(request?.workflowId || "").trim();
    if (workflowId) {
      openWorkflowCanvas(workflowId);
    }
  }, []);
  const openOperatorInboxItem = useCallback((item) => {
    if (item?.kind === "approval") {
      openApprovalTarget(item.request);
      return;
    }
    if (item?.kind === "harness-attention") {
      const runId = String(item?.run?.runId || "").trim();
      if (!runId) return;
      navigateTo("agents", {
        params: {
          harnessRunId: runId,
          harnessSource: "workflow-operator-inbox",
        },
      });
    }
  }, [openApprovalTarget]);
  const openRunCopilot = useCallback((run, intent = "ask") => {
    const safeRunId = String(run?.runId || "").trim();
    const safeIntent = String(intent || "ask").trim().toLowerCase();
    if (!safeRunId) return null;
    return startWorkflowCopilotSession({
      endpoint: buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/copilot-context?intent=${encodeURIComponent(safeIntent)}`),
      fallbackPrompt: buildRunCopilotPrompt(run, safeIntent),
      title: `${safeIntent === "fix" ? "Fix failed workflow run" : "Ask about workflow run"} ${safeRunId}`.trim(),
      successToast: safeIntent === "fix" ? "Opened failed-run fix chat" : "Opened workflow run analysis chat",
    });
  }, []);
  const openRunNodeCopilot = useCallback((run, nodeId, intent = "node", workflow = null) => {
    const safeRunId = String(run?.runId || "").trim();
    const safeNodeId = String(nodeId || "").trim();
    const safeIntent = String(intent || "node").trim().toLowerCase();
    if (!safeRunId || !safeNodeId) return null;
    return startWorkflowCopilotSession({
      endpoint: buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/copilot-context?intent=${encodeURIComponent(safeIntent)}&nodeId=${encodeURIComponent(safeNodeId)}`),
      fallbackPrompt: buildRunNodeCopilotPrompt(run, safeNodeId, { intent: safeIntent, workflow }),
      title: `${safeIntent === "fix" ? "Fix node" : "Ask Bosun about node"} ${safeNodeId}`.trim(),
      successToast: safeIntent === "fix" ? "Opened node fix chat" : "Opened node copilot chat",
    });
  }, []);
  const requestWorkflowRunRetry = useCallback(async (run, explicitMode = "") => {
    const safeRunId = String(run?.runId || "").trim();
    if (!safeRunId) return;
    try {
      const retryInfo = await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/retry`), {
        method: "POST",
        body: JSON.stringify({}),
      });
      const options = Array.isArray(retryInfo?.options) ? retryInfo.options : [];
      const recommended =
        options.find((entry) => entry?.recommended) ||
        options.find((entry) => String(entry?.mode || "").trim() === String(retryInfo?.recommendedMode || "").trim()) ||
        options[0] ||
        null;

      let selectedMode = String(explicitMode || "").trim().toLowerCase();
      if (!selectedMode) {
        if (options.length <= 1) {
          selectedMode = String(recommended?.mode || retryInfo?.recommendedMode || "from_failed").trim().toLowerCase();
        } else {
          const promptLines = [
            `Retry mode for workflow run ${safeRunId}:`,
            "",
            ...options.map((entry) => {
              const mode = String(entry?.mode || "").trim();
              const label = String(entry?.label || formatRetryModeLabel(mode)).trim();
              const description = String(entry?.description || "").trim();
              const suffix = entry?.recommended ? " (recommended)" : "";
              return `- ${mode}: ${label}${suffix}${description ? ` — ${description}` : ""}`;
            }),
            "",
            `Recommended: ${String(recommended?.mode || retryInfo?.recommendedMode || "from_failed")}`,
            retryInfo?.summary ? `Why: ${retryInfo.summary}` : "",
            retryInfo?.recommendedReason ? `Signal: ${formatRetryDecisionReason(retryInfo.recommendedReason)}` : "",
            "",
            "Type from_failed or from_scratch.",
          ].filter(Boolean);
          const choice = window.prompt(
            promptLines.join("\n"),
            String(recommended?.mode || retryInfo?.recommendedMode || "from_failed"),
          );
          if (choice == null) return;
          selectedMode = String(choice || "").trim().toLowerCase();
        }
      }

      if (selectedMode !== "from_failed" && selectedMode !== "from_scratch") {
        showToast("Retry cancelled: invalid retry mode", "warning");
        return;
      }

      const result = await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/retry`), {
        method: "POST",
        body: JSON.stringify({ mode: selectedMode }),
      });
      showToast(`Run retry initiated: ${formatRetryModeLabel(result?.mode || selectedMode)}`, "success");
      setTimeout(() => loadRunDetail(safeRunId), 1000);
    } catch (err) {
      showToast("Retry failed: " + (err.message || err), "error");
    }
  }, []);
  const refreshRunDiagnostics = useCallback(async (runId = selectedRunId.value) => {
    const safeRunId = String(runId || "").trim();
    if (!safeRunId) return;
    setRunDiagnosticsLoading(true);
    try {
      const [evaluationData, forensicsData, snapshotsData] = await Promise.all([
        apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/evaluate`)).catch(() => null),
        apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/forensics`)).catch(() => null),
        apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/snapshots`)).catch(() => null),
      ]);
      setSelectedRunEvaluation(evaluationData?.evaluation || evaluationData || null);
      setSelectedRunForensics(forensicsData?.forensics || forensicsData || null);
      setSelectedRunSnapshots(Array.isArray(snapshotsData?.snapshots) ? snapshotsData.snapshots : []);
    } finally {
      setRunDiagnosticsLoading(false);
    }
  }, []);
  const captureRunSnapshot = useCallback(async (runId = selectedRunId.value) => {
    const safeRunId = String(runId || "").trim();
    if (!safeRunId) return;
    setRunActionBusy("snapshot");
    try {
      await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/snapshot`), {
        method: "POST",
        body: JSON.stringify({}),
      });
      showToast("Run snapshot captured", "success");
      await refreshRunDiagnostics(safeRunId);
    } catch (err) {
      showToast("Snapshot failed: " + (err.message || err), "error");
    } finally {
      setRunActionBusy("");
    }
  }, [refreshRunDiagnostics]);
  const restoreRunSnapshot = useCallback(async (runId = selectedRunId.value) => {
    const safeRunId = String(runId || "").trim();
    if (!safeRunId) return;
    const snapshotOptions = selectedRunSnapshots
      .map((entry) => String(entry?.snapshotId || entry?.id || "").trim())
      .filter(Boolean);
    const snapshotId = window.prompt(
      snapshotOptions.length
        ? `Snapshot ID to restore:\n\n${snapshotOptions.join("\n")}`
        : "Snapshot ID to restore",
      snapshotOptions[0] || "",
    );
    if (snapshotId == null || !String(snapshotId).trim()) return;
    setRunActionBusy("restore");
    try {
      await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/restore`), {
        method: "POST",
        body: JSON.stringify({ snapshotId: String(snapshotId).trim() }),
      });
      showToast("Run restore requested", "success");
      setTimeout(() => loadRunDetail(safeRunId), 500);
      await refreshRunDiagnostics(safeRunId);
    } catch (err) {
      showToast("Restore failed: " + (err.message || err), "error");
    } finally {
      setRunActionBusy("");
    }
  }, [refreshRunDiagnostics, selectedRunSnapshots]);
  const remediateRun = useCallback(async (runId = selectedRunId.value) => {
    const safeRunId = String(runId || "").trim();
    if (!safeRunId) return;
    const note = window.prompt("Optional remediation note", "") || "";
    setRunActionBusy("remediate");
    try {
      await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}/remediate`), {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      });
      showToast("Run remediation requested", "success");
      setTimeout(() => loadRunDetail(safeRunId), 500);
      await refreshRunDiagnostics(safeRunId);
    } catch (err) {
      showToast("Remediation failed: " + (err.message || err), "error");
    } finally {
      setRunActionBusy("");
    }
  }, [refreshRunDiagnostics]);

  useEffect(() => {
    if (!selectedRunId.value) {
      setSelectedRunEvaluation(null);
      setSelectedRunForensics(null);
      setSelectedRunSnapshots([]);
    } else {
      setSelectedRunEvaluation(null);
      setSelectedRunForensics(null);
      setSelectedRunSnapshots([]);
    }
  }, [selectedRunId.value]);

  if (selectedRunId.value && runDetailLoading && !selectedRun) {
    return html`
      <div style="padding: 0 4px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
          <${Button} variant="text" size="small" onClick=${() => { selectedRunId.value = null; selectedRunDetail.value = null; workflowRunDetailError.value = ""; }}>
            ← Back to Run History
          <//>
          <h2 style="margin:0; font-size:18px; font-weight:700;">Loading Run ${String(selectedRunId.value || "").slice(0, 12) || ""}</h2>
        </div>
        <div style="min-height:260px; display:flex; align-items:center; justify-content:center; padding:32px; border:1px solid var(--color-border,#2a3040); border-radius:12px; background:var(--color-bg-secondary,#1a1f2e);">
          <div style="display:flex; flex-direction:column; align-items:center; gap:12px; color:var(--color-text-secondary,#94a3b8);">
            <${CircularProgress} size=${28} />
            <div style="font-size:13px;">Fetching run details…</div>
          </div>
        </div>
      </div>
    `;
  }

  if (selectedRunId.value && !selectedRun && runDetailError) {
    return html`
      <div style="padding: 0 4px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap;">
          <${Button} variant="text" size="small" onClick=${() => { selectedRunId.value = null; selectedRunDetail.value = null; workflowRunDetailError.value = ""; }}>
            ← Back to Run History
          <//>
          <h2 style="margin:0; font-size:18px; font-weight:700;">Run Details</h2>
        </div>
        <${Alert}
          severity="warning"
          action=${html`<${Button} color="inherit" size="small" onClick=${() => loadRunDetail(selectedRunId.value)}>Retry<//>`}
        >
          ${runDetailError}
        </${Alert}>
      </div>
    `;
  }

  if (selectedRun) {
    const statusStyles = getRunStatusBadgeStyles(selectedRun.status);
    const logs = Array.isArray(selectedRun?.detail?.logs) ? selectedRun.detail.logs : [];
    const errors = Array.isArray(selectedRun?.detail?.errors) ? selectedRun.detail.errors : [];
    const currentWorkflow =
      (workflows.value || []).find((workflow) => workflow?.id === selectedRun.workflowId) || null;
    const nodeStatuses = buildNodeStatusesFromRunDetail(selectedRun);
    const nodeOutputs = selectedRun?.detail?.nodeOutputs || {};
    const nodeIds = Object.keys(nodeStatuses).sort((a, b) => {
      const rankDiff = getNodeStatusRank(nodeStatuses[a]) - getNodeStatusRank(nodeStatuses[b]);
      if (rankDiff !== 0) return rankDiff;
      return String(a).localeCompare(String(b));
    });
    const finishedAt = selectedRun.status === "running" ? null : selectedRun.endedAt;
    const liveDuration = selectedRun.status === "running" && selectedRun.startedAt
      ? Math.max(0, nowTick - selectedRun.startedAt)
      : selectedRun.duration;
    const lastActivityAt = getRunActivityAt(selectedRun);
    const staleMs = selectedRun.status === "running" && lastActivityAt
      ? Math.max(0, nowTick - lastActivityAt)
      : 0;
    const showStuck = selectedRun.status === "running" && selectedRun.isStuck;
    const issueAdvisor =
      selectedRun?.detail?.issueAdvisor && typeof selectedRun.detail.issueAdvisor === "object"
        ? selectedRun.detail.issueAdvisor
        : null;
    const proofBundle =
      selectedRun?.proofBundle && typeof selectedRun.proofBundle === "object"
        ? selectedRun.proofBundle
        : { summary: {}, plannerTimeline: [], decisions: [], evidence: [], artifacts: [] };
    const plannerTimeline = Array.isArray(selectedRun?.plannerTimeline)
      ? selectedRun.plannerTimeline
      : (Array.isArray(proofBundle?.plannerTimeline) ? proofBundle.plannerTimeline : []);
    const proofSummary = proofBundle?.summary && typeof proofBundle.summary === "object"
      ? proofBundle.summary
      : {};
    const proofDecisions = Array.isArray(proofBundle?.decisions) ? proofBundle.decisions : [];
    const proofEvidence = Array.isArray(proofBundle?.evidence) ? proofBundle.evidence : [];
    const proofArtifacts = Array.isArray(proofBundle?.artifacts) ? proofBundle.artifacts : [];
    const governance = readWorkflowGovernance(selectedRun);
    const workflowTeamState =
      selectedRun?.workflowTeamState && typeof selectedRun.workflowTeamState === "object"
        ? selectedRun.workflowTeamState
        : (selectedRun?.detail?.workflowTeamState && typeof selectedRun.detail.workflowTeamState === "object"
            ? selectedRun.detail.workflowTeamState
            : (selectedRun?.detail?.data?._workflowTeamState && typeof selectedRun.detail.data._workflowTeamState === "object"
                ? selectedRun.detail.data._workflowTeamState
                : null));
    const teamSummary =
      selectedRun?.teamSummary && typeof selectedRun.teamSummary === "object"
        ? selectedRun.teamSummary
        : (selectedRun?.detail?.teamSummary && typeof selectedRun.detail.teamSummary === "object"
            ? selectedRun.detail.teamSummary
            : (selectedRun?.detail?.data?._workflowTeamSummary && typeof selectedRun.detail.data._workflowTeamSummary === "object"
                ? selectedRun.detail.data._workflowTeamSummary
                : null));
    const teamRoster = Array.isArray(workflowTeamState?.roster) ? workflowTeamState.roster : [];
    const teamTasks = Array.isArray(workflowTeamState?.tasks) ? workflowTeamState.tasks : [];
    const teamMessages = Array.isArray(workflowTeamState?.messages) ? workflowTeamState.messages : [];
    const teamEvents = Array.isArray(workflowTeamState?.events) ? workflowTeamState.events : [];
    const runGraph = selectedRun?.runGraph && typeof selectedRun.runGraph === "object"
      ? selectedRun.runGraph
      : null;
    const runGraphStats = buildRunGraphStats(runGraph);
    const runGraphLineage = buildRunGraphLineageRows(runGraph, selectedRun.runId);
    const runGraphExecutions = buildRunGraphExecutionRows(runGraph);
    const runGraphTimeline = Array.isArray(runGraph?.timeline) ? runGraph.timeline.slice().reverse() : [];
    const uniqueDelegationIds = (values = []) => {
      const seen = new Set();
      const out = [];
      for (const value of Array.isArray(values) ? values : []) {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
      }
      return out;
    };
    const rawDelegationTopology =
      selectedRun?.delegationTopology && typeof selectedRun.delegationTopology === "object"
        ? selectedRun.delegationTopology
        : (selectedRun?.detail?.delegationTopology && typeof selectedRun.detail.delegationTopology === "object"
            ? selectedRun.detail.delegationTopology
            : (selectedRun?.detail?.data?._delegationTopology && typeof selectedRun.detail.data._delegationTopology === "object"
                ? selectedRun.detail.data._delegationTopology
                : null));
    const delegationTopology = rawDelegationTopology
      ? {
          runId: String(rawDelegationTopology.runId || selectedRun.runId || "").trim() || null,
          rootRunId: String(rawDelegationTopology.rootRunId || selectedRun.rootRunId || "").trim() || null,
          parentRunId: String(rawDelegationTopology.parentRunId || selectedRun.parentRunId || "").trim() || null,
          taskId: String(rawDelegationTopology.taskId || selectedRun.taskId || "").trim() || null,
          rootTaskId: String(rawDelegationTopology.rootTaskId || "").trim() || null,
          parentTaskId: String(rawDelegationTopology.parentTaskId || "").trim() || null,
          sessionId: String(rawDelegationTopology.sessionId || selectedRun.primarySessionId || selectedRun.sessionId || "").trim() || null,
          rootSessionId: String(rawDelegationTopology.rootSessionId || "").trim() || null,
          parentSessionId: String(rawDelegationTopology.parentSessionId || "").trim() || null,
          delegationDepth: Number.isFinite(Number(rawDelegationTopology.delegationDepth))
            ? Math.max(0, Math.trunc(Number(rawDelegationTopology.delegationDepth)))
            : 0,
          childRunIds: uniqueDelegationIds(rawDelegationTopology.childRunIds || []),
          childSessionIds: uniqueDelegationIds(rawDelegationTopology.childSessionIds || []),
          familyRunIds: uniqueDelegationIds(rawDelegationTopology.familyRunIds || []),
          familySessionIds: uniqueDelegationIds(rawDelegationTopology.familySessionIds || []),
        }
      : null;
    const delegationTaskLineage = [
      delegationTopology?.taskId ? `task ${delegationTopology.taskId}` : "",
      delegationTopology?.parentTaskId && delegationTopology.parentTaskId !== delegationTopology.taskId
        ? `parent ${delegationTopology.parentTaskId}`
        : "",
      delegationTopology?.rootTaskId
        && delegationTopology.rootTaskId !== delegationTopology.parentTaskId
        && delegationTopology.rootTaskId !== delegationTopology.taskId
        ? `root ${delegationTopology.rootTaskId}`
        : "",
    ].filter(Boolean);
    const delegationSessionLineage = [
      delegationTopology?.sessionId ? `current ${delegationTopology.sessionId}` : "",
      delegationTopology?.parentSessionId && delegationTopology.parentSessionId !== delegationTopology.sessionId
        ? `parent ${delegationTopology.parentSessionId}`
        : "",
      delegationTopology?.rootSessionId
        && delegationTopology.rootSessionId !== delegationTopology.parentSessionId
        && delegationTopology.rootSessionId !== delegationTopology.sessionId
        ? `root ${delegationTopology.rootSessionId}`
        : "",
    ].filter(Boolean);
    const dagCounts = getRunDagCounts(selectedRun);
    const dagRevisions = Array.isArray(selectedRun?.detail?.dagState?.revisions) ? selectedRun.detail.dagState.revisions : [];
    const ledgerEvents = Array.isArray(selectedRun?.ledger?.events) ? selectedRun.ledger.events : [];
    const auditActivity =
      selectedRun?.auditActivity && typeof selectedRun.auditActivity === "object"
        ? selectedRun.auditActivity
        : {};
    const auditTaskTraceEvents = Array.isArray(auditActivity?.taskTraceEvents) ? auditActivity.taskTraceEvents : [];
    const auditWorkflowEvents = Array.isArray(auditActivity?.workflowEvents) ? auditActivity.workflowEvents : [];
    const auditPromotedStrategies = Array.isArray(auditActivity?.promotedStrategies) ? auditActivity.promotedStrategies : [];
    const auditPromotedStrategyEvents = Array.isArray(auditActivity?.promotedStrategyEvents) ? auditActivity.promotedStrategyEvents : [];
    const auditEvents = Array.isArray(auditActivity?.auditEvents) ? auditActivity.auditEvents : [];
    const auditArtifacts = Array.isArray(auditActivity?.artifacts) ? auditActivity.artifacts : [];
    const auditToolCalls = Array.isArray(auditActivity?.toolCalls) ? auditActivity.toolCalls : [];
    const auditOperatorActions = Array.isArray(auditActivity?.operatorActions) ? auditActivity.operatorActions : [];
    const auditClaimEvents = Array.isArray(auditActivity?.claimEvents) ? auditActivity.claimEvents : [];
    const auditSessionIds = Array.isArray(auditActivity?.sessionIds) ? auditActivity.sessionIds : [];
    const auditAgentIds = Array.isArray(auditActivity?.agentIds) ? auditActivity.agentIds : [];
    const auditSummary = auditActivity?.summary && typeof auditActivity.summary === "object"
      ? auditActivity.summary
      : {};
    const auditSourceLabel = String(
      auditSummary?.stateSource
      || auditSummary?.storage
      || auditSummary?.store
      || auditSummary?.source
      || "state ledger / SQLite",
    ).trim();
    const auditSessionActivity =
      auditActivity?.sessionActivity && typeof auditActivity.sessionActivity === "object"
        ? auditActivity.sessionActivity
        : null;
    const auditAgentActivity =
      auditActivity?.agentActivity && typeof auditActivity.agentActivity === "object"
        ? auditActivity.agentActivity
        : null;
    const derivedAuditClaimEvents = auditClaimEvents.length
      ? auditClaimEvents
      : auditEvents
        .filter((entry) => String(entry?.auditType || "").trim().toLowerCase() === "task_claim")
        .map((entry) => ({
          ...(entry?.record && typeof entry.record === "object" ? entry.record : {}),
          auditId: entry?.auditId || null,
          timestamp: entry?.timestamp || null,
          status: entry?.status || null,
          eventType: entry?.eventType || null,
          summary: entry?.summary || null,
        }));
    const derivedAuditOperatorActions = auditOperatorActions.length
      ? auditOperatorActions
      : auditEvents
        .filter((entry) => String(entry?.auditType || "").trim().toLowerCase() === "operator_action")
        .map((entry) => ({
          ...(entry?.record && typeof entry.record === "object" ? entry.record : {}),
          auditId: entry?.auditId || null,
          createdAt: entry?.timestamp || null,
          updatedAt: entry?.timestamp || null,
          status: entry?.status || null,
          eventType: entry?.eventType || null,
          summary: entry?.summary || null,
        }));
    const recentAuditWorkflowEvents = auditWorkflowEvents.slice().reverse().slice(0, 8);
    const recentAuditTaskTraceEvents = auditTaskTraceEvents.slice().reverse().slice(0, 8);
    const recentAuditToolCalls = auditToolCalls.slice().reverse().slice(0, 8);
    const recentAuditArtifacts = auditArtifacts.slice().reverse().slice(0, 8);
    const recentAuditPromotedStrategies = auditPromotedStrategies.slice().reverse().slice(0, 8);
    const recentAuditPromotedStrategyEvents = auditPromotedStrategyEvents.slice().reverse().slice(0, 8);
    const recentAuditClaimEvents = derivedAuditClaimEvents.slice().reverse().slice(0, 8);
    const recentAuditOperatorActions = derivedAuditOperatorActions.slice().reverse().slice(0, 8);
    const durableSessionIds = uniqueDelegationIds([
      selectedRun?.primarySessionId,
      selectedRun?.sessionId,
      delegationTopology?.sessionId,
      delegationTopology?.parentSessionId,
      delegationTopology?.rootSessionId,
      ...(Array.isArray(delegationTopology?.childSessionIds) ? delegationTopology.childSessionIds : []),
      ...(Array.isArray(delegationTopology?.familySessionIds) ? delegationTopology.familySessionIds : []),
      ...(Array.isArray(auditSessionIds) ? auditSessionIds : []),
      auditSessionActivity?.sessionId,
    ]);
    const latestAuditTrace = recentAuditTaskTraceEvents[0] || null;
    const latestPromotedStrategy = recentAuditPromotedStrategies[0] || null;
    const latestAuditWorkflowEvent = recentAuditWorkflowEvents[0] || null;
    const normalizedLogsSearch = String(logsPaneSearch || "").trim().toLowerCase();
    const normalizedErrorsSearch = String(errorsPaneSearch || "").trim().toLowerCase();
    const normalizedLedgerSearch = String(ledgerPaneSearch || "").trim().toLowerCase();
    const normalizedRawSearch = String(rawPaneSearch || "").trim().toLowerCase();
    const filteredLogs = logs.filter((entry) => {
      if (!normalizedLogsSearch) return true;
      return safePrettyJson(entry).toLowerCase().includes(normalizedLogsSearch);
    });
    const filteredErrors = errors.filter((entry) => {
      if (!normalizedErrorsSearch) return true;
      return safePrettyJson(entry).toLowerCase().includes(normalizedErrorsSearch);
    });
    const filteredLedgerEvents = ledgerEvents.filter((event) => {
      if (!normalizedLedgerSearch) return true;
      const line = `${safePrettyJson(event)} ${summarizeLedgerEvent(event)}`.toLowerCase();
      return line.includes(normalizedLedgerSearch);
    });
    const rawRunJson = safePrettyJson(selectedRun);
    const rawRunLines = rawRunJson.split("\n");
    const filteredRawLines = normalizedRawSearch
      ? rawRunLines.filter((line) => line.toLowerCase().includes(normalizedRawSearch))
      : rawRunLines;
    const recommendedRetryMode =
      selectedRun?.status === "failed"
        ? ((selectedRun?.issueAdvisorRecommendation === "replan_from_failed" || selectedRun?.issueAdvisorRecommendation === "replan_subgraph") ? "from_scratch" : "from_failed")
        : "";
    const recommendedRetryLabel = formatRetryModeLabel(recommendedRetryMode);

    return html`
      <div style="padding: 0 4px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
          <${Button} variant="text" size="small" onClick=${() => { selectedRunId.value = null; selectedRunDetail.value = null; }}>
            ← Back to Run History
          <//>
          ${selectedRun.workflowId && html`<${Button} variant="text" size="small" onClick=${() => openWorkflowCanvas(selectedRun.workflowId)}>Open Workflow<//>`}
          <h2 style="margin: 0; font-size: 18px; font-weight: 700;">Run Details</h2>
          <${Button} variant="text" size="small" onClick=${() => loadRunDetail(selectedRun.runId)}>Refresh<//>
          <${Button} variant="text" size="small" onClick=${() => refreshRunDiagnostics(selectedRun.runId)} disabled=${runDiagnosticsLoading}>
            ${runDiagnosticsLoading ? "Refreshing Diagnostics…" : "Refresh Diagnostics"}
          <//>
          <${Button} variant="outlined" size="small" onClick=${() => captureRunSnapshot(selectedRun.runId)} disabled=${runActionBusy === "snapshot"}>
            ${runActionBusy === "snapshot" ? "Capturing…" : "Capture Snapshot"}
          <//>
          <${Button} variant="outlined" size="small" onClick=${() => restoreRunSnapshot(selectedRun.runId)} disabled=${runActionBusy === "restore" || selectedRunSnapshots.length === 0}>
            ${runActionBusy === "restore" ? "Restoring…" : "Restore Snapshot"}
          <//>
          <${Button} variant="outlined" size="small" color="warning" onClick=${() => remediateRun(selectedRun.runId)} disabled=${runActionBusy === "remediate"}>
            ${runActionBusy === "remediate" ? "Remediating…" : "Remediate Run"}
          <//>
          <${Button}
            variant="outlined"
            size="small"
            onClick=${() => openRunCopilot(selectedRun, "ask")}
          >
            <span class="btn-icon">${resolveIcon("bot")}</span>
            Ask Bosun
          <//>
          ${selectedRun.status === "failed" && html`
            <${Button}
              variant="contained"
              size="small"
              color="error"
              onClick=${() => openRunCopilot(selectedRun, "fix")}
            >
              <span class="btn-icon">${resolveIcon("settings")}</span>
              Fix With Bosun
            <//>
          `}
          ${selectedRun.status === "failed" && html`
            <${Button}
              variant="contained"
              size="small"
              color="warning"
              onClick=${() => requestWorkflowRunRetry(selectedRun, recommendedRetryMode)}
            >
              <span class="btn-icon">${resolveIcon("refresh")}</span>
              ${recommendedRetryMode ? recommendedRetryLabel : "Retry Run"}
            <//>
          `}
          ${selectedRun.status === "failed" && html`
            <${Button}
              variant="outlined"
              size="small"
              onClick=${() => requestWorkflowRunRetry(selectedRun)}
            >
              <span class="btn-icon">${resolveIcon("settings")}</span>
              Retry Options
            <//>
          `}
          ${selectedRun.status === "running" && html`
            <${Button}
              variant="contained"
              size="small"
              color="error"
              onClick=${async () => {
                try {
                  await apiFetch(buildWorkflowRunApiPath("/api/workflows/runs/" + encodeURIComponent(selectedRun.runId) + "/cancel"), { method: "POST" });
                  showToast("Run cancellation requested", "success");
                  setTimeout(() => loadRunDetail(selectedRun.runId), 1000);
                } catch (err) {
                  showToast("Cancel failed: " + (err.message || err), "error");
                }
              }}
            >
              <span class="btn-icon">${resolveIcon("close")}</span>
              Stop Run
            <//>
          `}
        </div>

        <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px; margin-bottom: 12px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="font-size: 14px; font-weight: 700;">
              ${selectedRun.workflowName || workflowNameMap.get(selectedRun.workflowId) || selectedRun.workflowId || "Unknown Workflow"}
            </span>
            <span class="wf-badge" style="background: ${statusStyles.bg}; color: ${statusStyles.color};">
              ${selectedRun.status || "unknown"}
            </span>
            ${governance.approvalPending && html`
              <span class="wf-badge" style="background:#f59e0b24; color:#fbbf24; border-color:#f59e0b55;">
                Approval Hold
              </span>
            `}
            ${governance.policyOutcome?.blocked === true && html`
              <span class="wf-badge" style="background:#ef444420; color:#fca5a5; border-color:#ef444455;">
                Governance Blocked
              </span>
            `}
            ${governance.budgetOutcome?.status && governance.budgetOutcome.status !== "ok" && html`
              <span class="wf-badge" style="background:#0ea5e920; color:#7dd3fc; border-color:#0ea5e955;">
                Budget ${formatGovernanceLabel(governance.budgetOutcome.status)}
              </span>
            `}
            ${showStuck && html`
              <span class="wf-badge" style="background: #f59e0b2f; color: #f59e0b; border-color: #f59e0b50;">
                Stuck
              </span>
            `}
          </div>
          <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); line-height: 1.6;">
            <div><b>Workflow ID:</b> <code>${selectedRun.workflowId || "—"}</code></div>
            <div><b>Run ID:</b> <code>${selectedRun.runId || "—"}</code></div>
            <div><b>Started:</b> ${formatDate(selectedRun.startedAt)} (${formatRelative(selectedRun.startedAt)})</div>
            <div><b>Finished:</b> ${finishedAt ? formatDate(finishedAt) : "Running"}</div>
            <div><b>Duration:</b> ${formatDuration(liveDuration)}</div>
            <div><b>Last Activity:</b> ${lastActivityAt ? `${formatDate(lastActivityAt)} (${formatRelative(lastActivityAt)})` : "—"}</div>
            ${selectedRun.status === "running" && html`<div><b>No Progress For:</b> ${formatDuration(staleMs)}</div>`}
            <div><b>Nodes:</b> ${selectedRun.nodeCount || 0} · <b>Logs:</b> ${selectedRun.logCount || logs.length} · <b>Errors:</b> ${selectedRun.errorCount || errors.length}</div>
            <div><b>Active Nodes:</b> ${selectedRun.activeNodeCount || 0}</div>
            <div><b>Trigger:</b> ${getWorkflowRunTriggerLabel(selectedRun)}</div>
            <div><b>Root Run:</b> <code>${selectedRun.rootRunId || "—"}</code></div>
            <div><b>Parent Run:</b> <code>${selectedRun.parentRunId || "—"}</code></div>
            <div><b>Retry Of:</b> <code>${selectedRun.retryOf || "—"}</code></div>
          </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 12px;">
          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#3b82f620; color:#93c5fd;">Execution Insight</span>
              ${issueAdvisor?.recommendedAction && html`
                <span class="wf-badge" style="background:#f59e0b24; color:#fbbf24;">
                  ${formatIssueAdvisorAction(issueAdvisor.recommendedAction)}
                </span>
              `}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Completed:</b> ${dagCounts.completed}/${dagCounts.nodeCount}</div>
              <div><b>Failed:</b> ${dagCounts.failed} · <b>Skipped:</b> ${dagCounts.skipped} · <b>Active:</b> ${dagCounts.active}</div>
              <div><b>Recommendation:</b> ${formatIssueAdvisorAction(issueAdvisor?.recommendedAction)}</div>
              <div><b>Decision Class:</b> ${formatIssueAdvisorAction(issueAdvisor?.retryDecisionClass || issueAdvisor?.recommendedAction)}</div>
              <div style="margin-top: 6px; color: #e5e7eb;">${issueAdvisor?.summary || "No issue-advisor summary recorded for this run."}</div>
              ${issueAdvisor?.nextStepGuidance && html`<div style="margin-top: 6px; color: #cbd5e1;">${issueAdvisor.nextStepGuidance}</div>`}
            </div>
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#10b98120; color:#6ee7b7;">Recovery & Lineage</span>
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Retry Mode:</b> ${selectedRun.retryMode ? formatRetryModeLabel(selectedRun.retryMode) : "—"}</div>
              <div><b>Retry Decision:</b> ${formatRetryDecisionReason(selectedRun.retryDecisionReason)}</div>
              <div><b>Root Run:</b> <code>${selectedRun.rootRunId || "—"}</code></div>
              <div><b>Parent Run:</b> <code>${selectedRun.parentRunId || "—"}</code></div>
              <div><b>Retry Of:</b> <code>${selectedRun.retryOf || "—"}</code></div>
              <div><b>Delegation Depth:</b> ${delegationTopology?.delegationDepth ?? 0}</div>
              <div><b>Task Lineage:</b> ${delegationTaskLineage.length > 0 ? delegationTaskLineage.join(" · ") : "—"}</div>
              <div><b>Session Lineage:</b> ${delegationSessionLineage.length > 0 ? delegationSessionLineage.join(" · ") : "—"}</div>
              <div><b>Child Runs:</b> ${Number(delegationTopology?.childRunIds?.length || 0)} · <b>Child Sessions:</b> ${Number(delegationTopology?.childSessionIds?.length || 0)}</div>
              <div><b>Family Runs:</b> ${Number(delegationTopology?.familyRunIds?.length || 0)} · <b>Family Sessions:</b> ${Number(delegationTopology?.familySessionIds?.length || 0)}</div>
              <div><b>Durable Sessions:</b> ${durableSessionIds.length || 0}${durableSessionIds[0] ? ` · primary ${durableSessionIds[0]}` : ""}</div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
              ${selectedRun.parentRunId && html`
                <${Button} variant="outlined" size="small" onClick=${() => loadRunDetail(selectedRun.parentRunId)}>
                  Open Parent Run
                <//>
              `}
              ${selectedRun.rootRunId && selectedRun.rootRunId !== selectedRun.runId && html`
                <${Button} variant="outlined" size="small" onClick=${() => loadRunDetail(selectedRun.rootRunId)}>
                  Open Root Run
                <//>
              `}
              ${Array.isArray(delegationTopology?.childRunIds) ? delegationTopology.childRunIds.slice(0, 3).map((childRunId) => (
                childRunId && childRunId !== selectedRun.runId
                  ? html`
                      <${Button} key=${`child-run-${childRunId}`} variant="outlined" size="small" onClick=${() => loadRunDetail(childRunId)}>
                        Open Child Run
                      <//>
                    `
                  : null
              )) : null}
            </div>
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#8b5cf620; color:#c4b5fd;">Governance & Goals</span>
              ${governance.approvalPending && html`
                <span class="wf-badge" style="background:#f59e0b24; color:#fbbf24;">Approval Pending</span>
              `}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Primary Goal:</b> ${governance.primaryGoalTitle || governance.primaryGoalId || "—"}</div>
              <div><b>Goal Depth:</b> ${governance.goalDepth ?? "—"} · <b>Goal Ancestry:</b> ${governance.goalAncestry.length}</div>
              ${governance.goalAncestry.length > 0 && html`
                <div style="margin-top: 6px; color: #e9d5ff;">
                  ${governance.goalAncestry.map((entry) => String(entry?.title || entry?.goalId || "goal").trim() || "goal").join(" → ")}
                </div>
              `}
              <div style="margin-top: 6px;"><b>Budget:</b> ${formatGovernanceLabel(governance.budgetOutcome?.status, "not configured")}</div>
              <div><b>Spent:</b> ${formatBudgetCents(governance.budgetPolicy?.spentCents, governance.budgetPolicy?.currency)} · <b>Budget Window:</b> ${formatBudgetCents(governance.budgetPolicy?.budgetCents, governance.budgetPolicy?.currency)}</div>
              <div><b>Remaining:</b> ${formatBudgetCents(governance.budgetPolicy?.remainingCents, governance.budgetPolicy?.currency)} · <b>Reserved:</b> ${formatBudgetCents(governance.budgetPolicy?.reservedCents, governance.budgetPolicy?.currency)}</div>
              <div style="margin-top: 6px;"><b>Execution Policy:</b> ${formatGovernanceLabel(governance.executionPolicy?.mode, governance.executionPolicy ? "configured" : "not configured")}</div>
              <div><b>Approval State:</b> ${formatGovernanceLabel(governance.executionPolicy?.approvalState, governance.approvalPending ? "pending" : "not required")}</div>
              <div><b>Policy Outcome:</b> ${formatGovernanceLabel(governance.policyOutcome?.status, "—")} · <b>Violations:</b> ${Number(governance.policyOutcome?.violationCount || 0)}</div>
              <div style="margin-top: 6px;"><b>Heartbeat Run:</b> <code>${governance.heartbeatRun?.runId || "—"}</code>${governance.heartbeatRun?.status ? ` · ${formatGovernanceLabel(governance.heartbeatRun.status)}` : ""}</div>
              <div><b>Wakeup Request:</b> <code>${governance.wakeupRequest?.requestId || "—"}</code>${governance.wakeupRequest?.source ? ` · ${formatGovernanceLabel(governance.wakeupRequest.source)}` : ""}</div>
            </div>
            ${governance.approvalPending && html`
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
                <${Button}
                  variant="contained"
                  size="small"
                  color="success"
                  onClick=${async () => {
                    try {
                      const note = window.prompt("Optional approval note", "") || "";
                      await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(selectedRun.runId)}/approval`), {
                        method: "POST",
                        body: JSON.stringify({ decision: "approved", note }),
                      });
                      showToast("Workflow approval granted", "success");
                      setTimeout(() => loadRunDetail(selectedRun.runId), 250);
                    } catch (err) {
                      showToast("Approval failed: " + (err.message || err), "error");
                    }
                  }}
                >
                  Approve Run
                <//>
                <${Button}
                  variant="outlined"
                  size="small"
                  color="warning"
                  onClick=${async () => {
                    try {
                      const note = window.prompt("Reason for denying approval", "") || "";
                      await apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(selectedRun.runId)}/approval`), {
                        method: "POST",
                        body: JSON.stringify({ decision: "denied", note }),
                      });
                      showToast("Workflow approval denied", "success");
                      setTimeout(() => loadRunDetail(selectedRun.runId), 250);
                    } catch (err) {
                      showToast("Denial failed: " + (err.message || err), "error");
                    }
                  }}
                >
                  Deny Run
                <//>
              </div>
            `}
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#06b6d420; color:#67e8f9;">Team Coordination</span>
              ${teamSummary?.teamId && html`
                <span class="wf-badge" style="background:#164e6320; color:#a5f3fc;">
                  ${teamSummary.teamId}
                </span>
              `}
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Lead:</b> ${teamSummary?.leadId || workflowTeamState?.leadId || "—"}</div>
              <div><b>Members:</b> ${Number(teamSummary?.rosterCount || teamRoster.length || 0)} · <b>Channels:</b> ${Number(teamSummary?.channelCount || workflowTeamState?.channels?.length || 0)}</div>
              <div><b>Shared Team Tasks:</b> ${Number(teamSummary?.taskCount || teamTasks.length || 0)} · <b>Open:</b> ${Number(teamSummary?.openTaskCount || 0)} · <b>Claimed:</b> ${Number(teamSummary?.claimedTaskCount || 0)} · <b>Completed:</b> ${Number(teamSummary?.completedTaskCount || 0)}</div>
              <div><b>Team Messages:</b> ${Number(teamSummary?.messageCount || teamMessages.length || 0)} · <b>Coordination Events:</b> ${Number(teamSummary?.eventCount || teamEvents.length || 0)}</div>
              <div style="margin-top: 6px;"><b>Default Channel:</b> ${teamSummary?.defaultChannel || workflowTeamState?.defaultChannel || "—"}</div>
              <div><b>Last Updated:</b> ${teamSummary?.lastUpdatedAt ? `${formatDate(teamSummary.lastUpdatedAt)} (${formatRelative(teamSummary.lastUpdatedAt)})` : "—"}</div>
            </div>
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#22c55e20; color:#86efac;">Planner & Proof</span>
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Planner Events:</b> ${Number(proofSummary.plannerEventCount || plannerTimeline.length || 0)}</div>
              <div><b>Decisions:</b> ${Number(proofSummary.decisionCount || proofDecisions.length || 0)} · <b>Evidence:</b> ${Number(proofSummary.evidenceCount || proofEvidence.length || 0)} · <b>Artifacts:</b> ${Number(proofSummary.artifactCount || proofArtifacts.length || 0)}</div>
              ${plannerTimeline[plannerTimeline.length - 1]?.summary && html`
                <div style="margin-top: 6px; color: #e5e7eb;">${plannerTimeline[plannerTimeline.length - 1].summary}</div>
              `}
              ${proofDecisions[0]?.summary && html`
                <div style="margin-top: 6px; color: #cbd5e1;">Decision: ${proofDecisions[0].summary}</div>
              `}
            </div>
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#f9731620; color:#fdba74;">State Ledger Audit</span>
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Audit Events:</b> ${auditEvents.length} · <b>Trace Events:</b> ${Number(auditSummary.taskTraceCount || auditActivity?.taskTraceCount || auditTaskTraceEvents.length || 0)}</div>
              <div><b>Workflow Events:</b> ${Number(auditSummary.workflowEventCount || auditWorkflowEvents.length || 0)} · <b>Tool Calls:</b> ${Number(auditSummary.toolCallCount || auditToolCalls.length || 0)} · <b>Artifacts:</b> ${Number(auditSummary.artifactCount || auditArtifacts.length || 0)}</div>
              <div><b>Claims:</b> ${Number(auditSummary.claimEventCount || derivedAuditClaimEvents.length || 0)} · <b>Promoted Strategy Events:</b> ${auditPromotedStrategyEvents.length}</div>
              <div><b>Promoted Strategies:</b> ${Number(auditSummary.promotedStrategyCount || auditPromotedStrategies.length || 0)} · <b>Operator Actions:</b> ${Number(auditSummary.operatorActionCount || derivedAuditOperatorActions.length || 0)}</div>
              <div><b>Source:</b> ${auditSourceLabel}</div>
              <div><b>Tracked Sessions:</b> ${auditSessionIds.length} · <b>Tracked Agents:</b> ${auditAgentIds.length}</div>
              <div><b>Session:</b> <code>${auditSessionActivity?.sessionId || selectedRun.primarySessionId || selectedRun.sessionId || "—"}</code></div>
              <div><b>Agent:</b> <code>${auditAgentActivity?.agentId || "—"}</code></div>
              <div><b>Known Sessions:</b> ${auditSessionIds.length ? auditSessionIds.join(", ") : "—"}</div>
              <div><b>Known Agents:</b> ${auditAgentIds.length ? auditAgentIds.join(", ") : "—"}</div>
              <div><b>Latest Session Event:</b> ${auditSessionActivity?.latestEventType || "—"}${auditSessionActivity?.updatedAt ? ` · ${formatRelative(auditSessionActivity.updatedAt)}` : ""}</div>
              <div><b>Latest Agent Event:</b> ${auditAgentActivity?.latestEventType || "—"}${auditAgentActivity?.updatedAt ? ` · ${formatRelative(auditAgentActivity.updatedAt)}` : ""}</div>
              ${latestAuditWorkflowEvent && html`
                <div style="margin-top: 6px; color: #bfdbfe;">Workflow: ${summarizeWorkflowAuditWorkflowEvent(latestAuditWorkflowEvent) || latestAuditWorkflowEvent.eventType || "workflow event"}</div>
              `}
              ${latestAuditTrace && html`
                <div style="margin-top: 6px; color: #e5e7eb;">Trace: ${latestAuditTrace.eventType || "event"}${latestAuditTrace.summary ? ` · ${latestAuditTrace.summary}` : ""}</div>
              `}
              ${latestPromotedStrategy && html`
                <div style="margin-top: 6px; color: #fed7aa;">Strategy: ${latestPromotedStrategy.recommendation || latestPromotedStrategy.decision || latestPromotedStrategy.strategyId}</div>
              `}
            </div>
          </div>

          <div style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 10px; border: 1px solid var(--color-border, #2a3040); padding: 14px;">
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <span class="wf-badge" style="background:#a855f720; color:#d8b4fe;">Execution Graph</span>
            </div>
            <div style="font-size: 12px; color: var(--color-text-secondary, #cbd5e1); line-height: 1.6;">
              <div><b>Runs:</b> ${runGraphStats.runCount} · <b>Execution Steps:</b> ${runGraphStats.executionCount}</div>
              <div><b>Timeline Events:</b> ${runGraphStats.timelineCount} · <b>Edges:</b> ${runGraphStats.edgeCount}</div>
              <div><b>Retries:</b> ${runGraphStats.retryEdgeCount} · <b>Causal Links:</b> ${runGraphStats.causalEdgeCount}</div>
              <div><b>Execution Links:</b> ${runGraphStats.executionEdgeCount} · <b>Execution→Run Links:</b> ${runGraphStats.executionRunEdgeCount}</div>
              ${runGraph?.rootRunId && html`<div style="margin-top: 6px; color: #e9d5ff;"><b>Graph Root:</b> <code>${runGraph.rootRunId}</code></div>`}
            </div>
          </div>
        </div>

        <details open style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Run Diagnostics & Recovery</summary>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-top:8px;">
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Run Evaluation</div>
              ${selectedRunEvaluation
                ? html`
                    <div><b>Status:</b> ${selectedRunEvaluation.status || selectedRunEvaluation.outcome || selectedRunEvaluation.verdict || "unknown"}</div>
                    ${(selectedRunEvaluation.score ?? selectedRunEvaluation.healthScore ?? selectedRunEvaluation.confidence) !== undefined && html`
                      <div><b>Score:</b> ${selectedRunEvaluation.score ?? selectedRunEvaluation.healthScore ?? selectedRunEvaluation.confidence}</div>
                    `}
                    <div style="margin-top:6px;">${selectedRunEvaluation.summary || selectedRunEvaluation.reason || selectedRunEvaluation.recommendation || "Evaluation data loaded."}</div>
                    ${Array.isArray(selectedRunEvaluation.issues) && selectedRunEvaluation.issues.slice(0, 3).map((issue, index) => html`
                      <div key=${`evaluation-issue-${index}`} style="margin-top:6px;color:#fcd34d;">
                        ${(typeof issue === "string" ? issue : issue?.summary || issue?.message || issue?.reason || issue?.title || "").trim() || "Issue recorded"}
                      </div>
                    `)}
                  `
                : html`<div style="opacity:0.6;">No evaluation recorded for this run.</div>`}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Run Forensics</div>
              ${selectedRunForensics
                ? html`
                    <div>${selectedRunForensics.summary || selectedRunForensics.reason || selectedRunForensics.status || "Forensics data loaded."}</div>
                    ${Array.isArray(selectedRunForensics.failedNodes) && selectedRunForensics.failedNodes.length > 0 && html`
                      <div style="margin-top:6px;"><b>Failed Nodes:</b> ${selectedRunForensics.failedNodes.slice(0, 3).map((entry) => String(entry?.nodeId || entry?.id || entry)).join(", ")}</div>
                    `}
                    ${Array.isArray(selectedRunForensics.artifacts) && selectedRunForensics.artifacts.length > 0 && html`
                      <div style="margin-top:6px;"><b>Artifacts:</b> ${selectedRunForensics.artifacts.slice(0, 3).map((entry) => String(entry?.path || entry?.label || entry?.name || entry)).join(", ")}</div>
                    `}
                    ${Array.isArray(selectedRunForensics.trace) && selectedRunForensics.trace.slice(0, 3).map((entry, index) => html`
                      <div key=${`forensics-trace-${index}`} style="margin-top:6px;color:#bfdbfe;">
                        ${(typeof entry === "string" ? entry : entry?.summary || entry?.message || entry?.reason || entry?.eventType || "").trim() || "Trace event"}
                      </div>
                    `)}
                  `
                : html`<div style="opacity:0.6;">No forensics snapshot recorded for this run.</div>`}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Run Snapshots</div>
              ${selectedRunSnapshots.length === 0
                ? html`<div style="opacity:0.6;">No snapshots recorded.</div>`
                : selectedRunSnapshots.slice(0, 6).map((entry, index) => html`
                    <div key=${`snapshot-${index}`} style="margin-bottom:8px;">
                      <div><b>${entry?.snapshotId || entry?.id || `snapshot-${index + 1}`}</b></div>
                      <div style="opacity:0.8;">${entry?.status || entry?.result || "saved"}${entry?.createdAt || entry?.timestamp ? ` · ${entry.createdAt || entry.timestamp}` : ""}</div>
                    </div>
                  `)}
              <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
                <${Button} variant="outlined" size="small" onClick=${() => captureRunSnapshot(selectedRun.runId)} disabled=${runActionBusy === "snapshot"}>
                  Capture Snapshot
                <//>
                <${Button} variant="outlined" size="small" onClick=${() => restoreRunSnapshot(selectedRun.runId)} disabled=${runActionBusy === "restore" || selectedRunSnapshots.length === 0}>
                  Restore Snapshot
                <//>
                <${Button} variant="outlined" size="small" color="warning" onClick=${() => remediateRun(selectedRun.runId)} disabled=${runActionBusy === "remediate"}>
                  Remediate Run
                <//>
              </div>
            </div>
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Team Coordination (${Number(teamSummary?.rosterCount || teamRoster.length || 0)} members · ${Number(teamSummary?.taskCount || teamTasks.length || 0)} tasks)</summary>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-top:8px;">
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Team Members</div>
              ${teamRoster.length === 0
                ? html`<div style="opacity:0.6;">No workflow team roster recorded for this run.</div>`
                : teamRoster.map((member, index) => html`
                  <div key=${`team-member-${index}`} style="margin-bottom:8px;">
                    <div><b>${member.name || member.memberId || "member"}</b>${member.role ? ` · ${member.role}` : ""}</div>
                    <div style="opacity:0.8;"><code>${member.memberId || "—"}</code>${member.reportsTo ? ` · reports to ${member.reportsTo}` : ""}</div>
                    <div style="margin-top:2px;">${Array.isArray(member.channels) && member.channels.length ? `Channels: ${member.channels.join(", ")}` : "Channels: —"}</div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Shared Team Tasks</div>
              ${teamTasks.length === 0
                ? html`<div style="opacity:0.6;">No workflow-local shared tasks recorded.</div>`
                : teamTasks.map((task, index) => html`
                  <div key=${`team-task-${index}`} style="margin-bottom:8px;">
                    <div><b>${summarizeWorkflowTeamTaskEntry(task) || task.taskId || "task"}</b></div>
                    <div style="opacity:0.8;"><code>${task.taskId || "—"}</code>${task.channelId ? ` · #${task.channelId}` : ""}</div>
                    ${task.description && html`<div style="margin-top:2px;">${task.description}</div>`}
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Team Messages</div>
              ${teamMessages.length === 0
                ? html`<div style="opacity:0.6;">No direct or channel coordination messages recorded.</div>`
                : teamMessages.slice().reverse().slice(0, 12).map((message, index) => html`
                  <div key=${`team-message-${index}`} style="margin-bottom:8px;">
                    <div><b>${summarizeWorkflowTeamMessageEntry(message) || message.messageId || "message"}</b></div>
                    <div style="opacity:0.8;">${message.createdAt ? `${formatDate(message.createdAt)} (${formatRelative(message.createdAt)})` : "unknown time"}</div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Coordination Events</div>
              ${teamEvents.length === 0
                ? html`<div style="opacity:0.6;">No workflow team coordination events recorded.</div>`
                : teamEvents.slice().reverse().slice(0, 12).map((event, index) => html`
                  <div key=${`team-event-${index}`} style="margin-bottom:8px;">
                    <div><b>${String(event.type || "event").replaceAll("-", " ")}</b>${event.status ? ` · ${event.status}` : ""}</div>
                    <div style="opacity:0.8;">${event.at ? `${formatDate(event.at)} (${formatRelative(event.at)})` : "unknown time"}</div>
                    ${event.summary && html`<div style="margin-top:2px;">${event.summary}</div>`}
                  </div>
                `)}
            </div>
          </div>
        </details>

        <details open style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Execution Lineage (${runGraphLineage.length})</summary>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${runGraphLineage.length === 0 && html`<div style="font-size:12px; opacity:0.6;">No execution lineage recorded for this run family.</div>`}
            ${runGraphLineage.map((entry) => {
              const entryStatusStyles = getRunStatusBadgeStyles(entry.status);
              const indentPx = Math.min(Number(entry.depth || 0), 6) * 18;
              return html`
                <div
                  key=${`run-graph-lineage-${entry.runId}`}
                  style=${{
                    marginLeft: `${indentPx}px`,
                    border: `1px solid ${entry.isRequested ? "#8b5cf680" : "#334155"}`,
                    borderRadius: "8px",
                    padding: "10px",
                    background: entry.isRequested ? "#1f1830" : "#0f172a",
                    fontSize: "12px",
                    color: "#cbd5e1",
                  }}
                >
                  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <b style="color:#f8fafc;">${entry.workflowName || entry.workflowId || entry.runId || "run"}</b>
                    <span class="wf-badge" style="background: ${entryStatusStyles.bg}; color: ${entryStatusStyles.color};">${entry.status || "unknown"}</span>
                    <span class="wf-badge">${formatRunGraphRunKind(entry.runKind)}</span>
                    ${entry.isRequested && html`<span class="wf-badge" style="background:#8b5cf620; color:#c4b5fd;">Selected</span>`}
                    ${entry.retryOf && html`<span class="wf-badge" style="background:#f59e0b20; color:#fbbf24;">${formatRetryModeLabel(entry.retryMode || "from_failed")}</span>`}
                  </div>
                  <div style="margin-top:6px; line-height:1.6;">
                    <div><b>Run:</b> <code>${entry.runId || "—"}</code></div>
                    <div><b>Started:</b> ${entry.startedAt ? `${formatDate(entry.startedAt)} (${formatRelative(entry.startedAt)})` : "—"}</div>
                    <div><b>Finished:</b> ${entry.endedAt ? `${formatDate(entry.endedAt)} (${formatRelative(entry.endedAt)})` : "—"}</div>
                    <div><b>Parent:</b> <code>${entry.parentRunId || "—"}</code></div>
                    <div><b>Retry Of:</b> <code>${entry.retryOf || "—"}</code></div>
                    <div><b>Task:</b> ${entry.taskTitle || entry.taskId || "—"}</div>
                    <div><b>Session:</b> <code>${entry.sessionId || "—"}</code></div>
                  </div>
                  <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
                    ${entry.runId && entry.runId !== selectedRun.runId && html`
                      <${Button} variant="outlined" size="small" onClick=${() => loadRunDetail(entry.runId)}>
                        Open This Run
                      <//>
                    `}
                  </div>
                </div>
              `;
            })}
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Delegation Topology (${Number(delegationTopology?.familyRunIds?.length || delegationTopology?.childRunIds?.length || 0)})</summary>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-top:8px;">
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Task Lineage</div>
              ${delegationTopology
                ? html`
                    <div><b>Task:</b> <code>${delegationTopology.taskId || "—"}</code></div>
                    <div><b>Parent Task:</b> <code>${delegationTopology.parentTaskId || "—"}</code></div>
                    <div><b>Root Task:</b> <code>${delegationTopology.rootTaskId || "—"}</code></div>
                    <div><b>Delegation Depth:</b> ${delegationTopology.delegationDepth}</div>
                    ${delegationTaskLineage.length > 0 && html`<div style="margin-top:6px;">${delegationTaskLineage.join(" · ")}</div>`}
                  `
                : html`<div style="opacity:0.6;">No explicit task delegation topology recorded.</div>`}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Session Lineage</div>
              ${delegationTopology
                ? html`
                    <div><b>Session:</b> <code>${delegationTopology.sessionId || "—"}</code></div>
                    <div><b>Parent Session:</b> <code>${delegationTopology.parentSessionId || "—"}</code></div>
                    <div><b>Root Session:</b> <code>${delegationTopology.rootSessionId || "—"}</code></div>
                    <div><b>Child Sessions:</b> ${Number(delegationTopology.childSessionIds?.length || 0)}</div>
                    <div><b>Family Sessions:</b> ${Number(delegationTopology.familySessionIds?.length || 0)}</div>
                    ${delegationSessionLineage.length > 0 && html`<div style="margin-top:6px;">${delegationSessionLineage.join(" · ")}</div>`}
                  `
                : html`<div style="opacity:0.6;">No explicit session delegation topology recorded.</div>`}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Run Family</div>
              ${delegationTopology
                ? html`
                    <div><b>Run:</b> <code>${delegationTopology.runId || selectedRun.runId || "—"}</code></div>
                    <div><b>Parent Run:</b> <code>${delegationTopology.parentRunId || "—"}</code></div>
                    <div><b>Root Run:</b> <code>${delegationTopology.rootRunId || "—"}</code></div>
                    <div><b>Child Runs:</b> ${Number(delegationTopology.childRunIds?.length || 0)}</div>
                    <div><b>Family Runs:</b> ${Number(delegationTopology.familyRunIds?.length || 0)}</div>
                    ${Array.isArray(delegationTopology.childRunIds) && delegationTopology.childRunIds.length > 0
                      ? html`
                          <div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:6px;">
                            ${delegationTopology.childRunIds.map((childRunId) => html`
                              <${Button} key=${`delegation-child-${childRunId}`} variant="outlined" size="small" onClick=${() => loadRunDetail(childRunId)}>
                                ${childRunId}
                              <//>
                            `)}
                          </div>
                        `
                      : html`<div style="margin-top:6px; opacity:0.6;">No child runs recorded for this delegation family.</div>`}
                  `
                : html`<div style="opacity:0.6;">No explicit run delegation topology recorded.</div>`}
            </div>
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Execution Activity (${runGraphExecutions.length})</summary>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${runGraphExecutions.length === 0 && html`<div style="font-size:12px; opacity:0.6;">No execution-step lineage recorded.</div>`}
            ${runGraphExecutions.slice(0, 24).map((entry, index) => {
              const executionStatusStyles = getRunStatusBadgeStyles(entry.status);
              return html`
                <div key=${`run-graph-execution-${index}`} style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
                  <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                    <b style="color:#f8fafc;">${formatRunGraphExecutionLabel(entry)}</b>
                    <span class="wf-badge" style="background: ${executionStatusStyles.bg}; color: ${executionStatusStyles.color};">${entry.status || "unknown"}</span>
                    <span class="wf-badge">${String(entry.executionKind || "execution").replaceAll("_", " ")}</span>
                    ${Number(entry.attempt || 0) > 0 && html`<span class="wf-badge">attempt ${entry.attempt}</span>`}
                  </div>
                  <div style="margin-top:6px; line-height:1.6;">
                    <div><b>Execution:</b> <code>${entry.executionId || "—"}</code></div>
                    <div><b>Run:</b> <code>${entry.runId || "—"}</code></div>
                    <div><b>Node:</b> ${entry.nodeLabel || entry.nodeId || entry.nodeType || "—"}</div>
                    <div><b>Tool:</b> ${entry.toolName || entry.toolId || "—"}${entry.serverId ? ` · server ${entry.serverId}` : ""}</div>
                    <div><b>Parent Execution:</b> <code>${entry.parentExecutionId || "—"}</code></div>
                    <div><b>Caused By:</b> <code>${entry.causedByExecutionId || "—"}</code></div>
                    <div><b>Child Runs:</b> ${Array.isArray(entry.childRunIds) && entry.childRunIds.length ? entry.childRunIds.join(", ") : "—"}</div>
                    <div><b>Window:</b> ${entry.startedAt ? formatDate(entry.startedAt) : "—"}${entry.endedAt ? ` → ${formatDate(entry.endedAt)}` : ""}</div>
                    ${Array.isArray(entry.errors) && entry.errors[0] && html`<div style="color:#fca5a5;"><b>Error:</b> ${entry.errors[0]}</div>`}
                  </div>
                </div>
              `;
            })}
            ${runGraphExecutions.length > 24 && html`<div style="font-size:12px; opacity:0.7;">Showing the first 24 execution steps.</div>`}
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Execution Timeline (${runGraphTimeline.length})</summary>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${runGraphTimeline.length === 0 && html`<div style="font-size:12px; opacity:0.6;">No execution timeline events recorded.</div>`}
            ${runGraphTimeline.slice(0, 30).map((entry, index) => html`
              <div key=${`run-graph-timeline-${index}`} style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
                <div style="color:#c4b5fd;">${entry?.timestamp ? `${formatDate(entry.timestamp)} (${formatRelative(entry.timestamp)})` : "unknown time"}</div>
                <div style="margin-top:4px;"><b>${summarizeRunGraphTimelineEvent(entry)}</b></div>
                <div style="margin-top:4px;"><b>Run:</b> <code>${entry?.runId || "—"}</code> · <b>Execution:</b> <code>${entry?.executionId || "—"}</code></div>
              </div>
            `)}
            ${runGraphTimeline.length > 30 && html`<div style="font-size:12px; opacity:0.7;">Showing the most recent 30 timeline events.</div>`}
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Planner Timeline (${plannerTimeline.length})</summary>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${plannerTimeline.length === 0 && html`<div style="font-size:12px; opacity:0.6;">No planner timeline events recorded.</div>`}
            ${plannerTimeline.slice().reverse().map((entry, index) => html`
              <div key=${`planner-event-${index}`} style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
                <div style="color:#93c5fd;">${entry?.timestamp ? `${formatDate(entry.timestamp)} (${formatRelative(entry.timestamp)})` : "unknown time"}</div>
                <div style="margin-top:4px;"><b>${entry.normalizedEventType || entry.eventType || "planner.event"}</b></div>
                ${entry.normalizedEventType && entry.normalizedEventType !== entry.eventType && html`
                  <div style="margin-top:2px; opacity:0.7;"><code>${entry.eventType}</code></div>
                `}
                <div style="margin-top:4px;">${summarizePlannerTimelineEntry(entry) || "Planner timeline event"}</div>
              </div>
            `)}
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">State Ledger Activity (${auditEvents.length} normalized events · ${auditWorkflowEvents.length} workflow events)</summary>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-top:8px;">
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Session & Agent Activity</div>
              <div><b>Tracked Sessions:</b> ${auditSessionIds.length || 0}</div>
              <div><b>Durable Session Family:</b> ${durableSessionIds.length || 0}</div>
              <div><b>Current Session:</b> <code>${auditSessionActivity?.sessionId || auditSessionIds[0] || selectedRun.primarySessionId || selectedRun.sessionId || "—"}</code></div>
              <div><b>Latest Event:</b> ${auditSessionActivity?.latestEventType || "—"}${auditSessionActivity?.latestStatus ? ` · ${auditSessionActivity.latestStatus}` : ""}</div>
              <div><b>Latest Task:</b> ${auditSessionActivity?.latestTaskTitle || auditSessionActivity?.latestTaskId || "—"}</div>
              <div><b>Latest Workflow:</b> ${auditSessionActivity?.latestWorkflowName || auditSessionActivity?.latestWorkflowId || "—"}</div>
              <div><b>Event Count:</b> ${Number(auditSessionActivity?.eventCount || 0)}</div>
              ${auditSessionActivity?.updatedAt && html`
                <div style="margin-top:6px; opacity:0.8;">Updated ${formatDate(auditSessionActivity.updatedAt)} (${formatRelative(auditSessionActivity.updatedAt)})</div>
              `}
              ${auditSessionActivity?.lastSummary && html`
                <div style="margin-top:6px;">${auditSessionActivity.lastSummary}</div>
              `}
              ${auditSessionIds.length > 1 && html`
                <div style="margin-top:6px;"><b>All Sessions:</b> ${auditSessionIds.map((sessionId) => html`<code key=${sessionId} style="margin-right:4px;">${sessionId}</code>`)}</div>
              `}
              ${durableSessionIds.length > 1 && html`
                <div style="margin-top:6px;"><b>Durable Sessions:</b> ${durableSessionIds.map((sessionId) => html`<code key=${sessionId} style="margin-right:4px;">${sessionId}</code>`)}</div>
              `}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Agent Activity</div>
              <div><b>Tracked Agents:</b> ${auditAgentIds.length || 0}</div>
              <div><b>Current Agent:</b> <code>${auditAgentActivity?.agentId || auditAgentIds[0] || "—"}</code></div>
              <div><b>Latest Event:</b> ${auditAgentActivity?.latestEventType || "—"}${auditAgentActivity?.latestStatus ? ` · ${auditAgentActivity.latestStatus}` : ""}</div>
              <div><b>Latest Task:</b> ${auditAgentActivity?.latestTaskTitle || auditAgentActivity?.latestTaskId || "—"}</div>
              <div><b>Latest Workflow:</b> ${auditAgentActivity?.latestWorkflowName || auditAgentActivity?.latestWorkflowId || "—"}</div>
              <div><b>Event Count:</b> ${Number(auditAgentActivity?.eventCount || 0)}</div>
              ${auditAgentActivity?.updatedAt && html`
                <div style="margin-top:6px; opacity:0.8;">Updated ${formatDate(auditAgentActivity.updatedAt)} (${formatRelative(auditAgentActivity.updatedAt)})</div>
              `}
              ${auditAgentActivity?.lastSummary && html`
                <div style="margin-top:6px;">${auditAgentActivity.lastSummary}</div>
              `}
              ${auditAgentIds.length > 1 && html`
                <div style="margin-top:6px;"><b>All Agents:</b> ${auditAgentIds.map((agentId) => html`<code key=${agentId} style="margin-right:4px;">${agentId}</code>`)}</div>
              `}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Recent Trace Events</div>
              ${recentAuditTaskTraceEvents.length === 0
                ? html`<div style="opacity:0.6;">No state-ledger trace events found for this run.</div>`
                : recentAuditTaskTraceEvents.map((entry, index) => html`
                  <div key=${`audit-trace-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.eventType || "event"}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;"><code>${entry.nodeLabel || entry.nodeId || entry.runId || "—"}</code>${entry.agentId ? ` · agent ${entry.agentId}` : ""}</div>
                    ${entry.summary && html`<div style="margin-top:2px;">${entry.summary}</div>`}
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Promoted Strategies</div>
              ${recentAuditPromotedStrategies.length === 0
                ? html`<div style="opacity:0.6;">No promoted strategies recorded for this run.</div>`
                : recentAuditPromotedStrategies.map((entry, index) => html`
                  <div key=${`audit-strategy-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.recommendation || entry.decision || entry.strategyId}</b></div>
                    <div style="opacity:0.8;">${entry.status || "unknown"}${entry.verificationStatus ? ` · ${entry.verificationStatus}` : ""}${entry.confidence != null ? ` · confidence ${entry.confidence}` : ""}</div>
                    ${entry.rationale && html`<div style="margin-top:2px;">${entry.rationale}</div>`}
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Workflow Ledger Events</div>
              ${recentAuditWorkflowEvents.length === 0
                ? html`<div style="opacity:0.6;">No workflow lifecycle events recorded in the state ledger.</div>`
                : recentAuditWorkflowEvents.map((entry, index) => html`
                  <div key=${`audit-workflow-event-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.eventType || "workflow.event"}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;">${entry.timestamp ? `${formatDate(entry.timestamp)} (${formatRelative(entry.timestamp)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditWorkflowEvent(entry) || entry.summary || "Workflow event"}</div>
                    <div style="margin-top:2px;"><b>Execution:</b> <code>${entry.executionId || "—"}</code> · <b>Node:</b> <code>${entry.nodeId || "—"}</code></div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Tool Calls</div>
              ${recentAuditToolCalls.length === 0
                ? html`<div style="opacity:0.6;">No tool calls recorded for this run.</div>`
                : recentAuditToolCalls.map((entry, index) => html`
                  <div key=${`audit-tool-call-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.toolName || entry.toolId || "tool"}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;">${entry.startedAt ? `${formatDate(entry.startedAt)} (${formatRelative(entry.startedAt)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditToolCall(entry) || entry.summary || "Tool call"}</div>
                    <div style="margin-top:2px;"><b>Call:</b> <code>${entry.callId || "—"}</code></div>
                    ${entry.cwd && html`<div style="margin-top:2px;"><b>CWD:</b> <code>${entry.cwd}</code></div>`}
                    ${entry.error && html`<div style="margin-top:2px; color:#fca5a5;"><b>Error:</b> ${entry.error}</div>`}
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Artifacts</div>
              ${recentAuditArtifacts.length === 0
                ? html`<div style="opacity:0.6;">No artifacts recorded for this run.</div>`
                : recentAuditArtifacts.map((entry, index) => html`
                  <div key=${`audit-artifact-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.kind || "artifact"}</b>${entry.path ? ` · ${entry.path}` : ""}</div>
                    <div style="opacity:0.8;">${entry.createdAt ? `${formatDate(entry.createdAt)} (${formatRelative(entry.createdAt)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditArtifact(entry) || entry.summary || "Artifact"}</div>
                    <div style="margin-top:2px;"><b>Artifact:</b> <code>${entry.artifactId || "—"}</code></div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Operator Actions</div>
              ${recentAuditOperatorActions.length === 0
                ? html`<div style="opacity:0.6;">No operator actions were linked to this run.</div>`
                : recentAuditOperatorActions.map((entry, index) => html`
                  <div key=${`audit-operator-action-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.actionType || entry.eventType || "operator.action"}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;">${entry.createdAt ? `${formatDate(entry.createdAt)} (${formatRelative(entry.createdAt)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditOperatorAction(entry) || entry.summary || "Operator action"}</div>
                    <div style="margin-top:2px;"><b>Action:</b> <code>${entry.actionId || entry.auditId || "—"}</code></div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Claim Events</div>
              ${recentAuditClaimEvents.length === 0
                ? html`<div style="opacity:0.6;">No task-claim events were linked to this run.</div>`
                : recentAuditClaimEvents.map((entry, index) => html`
                  <div key=${`audit-claim-event-${index}`} style="margin-bottom:8px;">
                    <div><b>${String(entry.action || entry.status || "claim").replaceAll("_", " ")}</b>${entry.instanceId || entry.instance_id ? ` · ${entry.instanceId || entry.instance_id}` : ""}</div>
                    <div style="opacity:0.8;">${entry.timestamp ? `${formatDate(entry.timestamp)} (${formatRelative(entry.timestamp)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditClaimEvent(entry) || entry.summary || "Claim event"}</div>
                    <div style="margin-top:2px;"><b>Task:</b> <code>${entry.taskId || entry.task_id || auditSummary.taskId || selectedRun.taskId || "—"}</code></div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Promoted Strategy Events</div>
              ${recentAuditPromotedStrategyEvents.length === 0
                ? html`<div style="opacity:0.6;">No promoted-strategy event history recorded for this run.</div>`
                : recentAuditPromotedStrategyEvents.map((entry, index) => html`
                  <div key=${`audit-promoted-strategy-event-${index}`} style="margin-bottom:8px;">
                    <div><b>${entry.strategyId || entry.recommendation || "strategy"}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;">${entry.createdAt ? `${formatDate(entry.createdAt)} (${formatRelative(entry.createdAt)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${summarizeWorkflowAuditPromotedStrategyEvent(entry) || "Promoted strategy event"}</div>
                  </div>
                `)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Unified Audit Timeline</div>
              ${auditEvents.length === 0
                ? html`<div style="opacity:0.6;">No normalized audit events recorded for this run.</div>`
                : auditEvents.slice(0, 12).map((entry, index) => html`
                  <div key=${`audit-event-${index}`} style="margin-bottom:8px;">
                    <div><b>${(entry.auditType || "audit").replace(/_/g, " ")}</b>${entry.status ? ` · ${entry.status}` : ""}</div>
                    <div style="opacity:0.8;">${entry.timestamp ? `${formatDate(entry.timestamp)} (${formatRelative(entry.timestamp)})` : "unknown time"}</div>
                    <div style="margin-top:2px;">${entry.summary || entry.eventType || "Audit event"}</div>
                    <div style="margin-top:2px;"><b>Run:</b> <code>${entry.runId || selectedRun.runId || "—"}</code>${entry.sessionId ? html` · <b>Session:</b> <code>${entry.sessionId}</code>` : ""}</div>
                  </div>
                `)}
            </div>
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Proof Bundle (${proofEvidence.length + proofArtifacts.length})</summary>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:10px; margin-top:8px;">
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Decisions</div>
              ${proofDecisions.length === 0
                ? html`<div style="opacity:0.6;">No decision metadata recorded.</div>`
                : proofDecisions.slice(0, 8).map((entry, index) => html`<div key=${`decision-${index}`} style="margin-bottom:6px;">${summarizeProofBundleEntry(entry) || entry?.decision || "decision"}</div>`)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Evidence</div>
              ${proofEvidence.length === 0
                ? html`<div style="opacity:0.6;">No evidence metadata recorded.</div>`
                : proofEvidence.slice(0, 10).map((entry, index) => html`<div key=${`evidence-${index}`} style="margin-bottom:6px;">${summarizeProofBundleEntry(entry) || entry?.kind || "evidence"}</div>`)}
            </div>
            <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
              <div style="font-weight:600; margin-bottom:6px;">Artifacts</div>
              ${proofArtifacts.length === 0
                ? html`<div style="opacity:0.6;">No artifact metadata recorded.</div>`
                : proofArtifacts.slice(0, 10).map((entry, index) => html`<div key=${`artifact-${index}`} style="margin-bottom:6px;">${summarizeProofBundleEntry(entry) || entry?.kind || "artifact"}</div>`)}
            </div>
          </div>
        </details>

        <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px;">
          <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">DAG Revisions (${dagRevisions.length})</summary>
          <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
            ${dagRevisions.length === 0 && html`<div style="font-size:12px; opacity:0.6;">No DAG revision history recorded.</div>`}
            ${dagRevisions.map((revision) => html`
              <div style="border:1px solid #334155; border-radius:6px; padding:8px; background:#0f172a; font-size:12px; color:#cbd5e1;">
                <div><b>Revision ${revision.index}:</b> ${revision.reason || "update"}</div>
                <div><b>Recorded:</b> ${formatDate(revision.recordedAt)}</div>
                <div><b>Counts:</b> completed=${Number(revision?.counts?.completed || 0)}, failed=${Number(revision?.counts?.failed || 0)}, pending=${Number(revision?.counts?.pending || 0)}</div>
                <div><b>Preserved:</b> ${(Array.isArray(revision?.preservedCompletedNodeIds) && revision.preservedCompletedNodeIds.length) ? revision.preservedCompletedNodeIds.join(", ") : "—"}</div>
                <div><b>Focus:</b> ${(Array.isArray(revision?.focusNodeIds) && revision.focusNodeIds.length) ? revision.focusNodeIds.join(", ") : "—"}</div>
                <div><b>Graph Before:</b> nodes=${Array.isArray(revision?.graphBefore?.nodes) ? revision.graphBefore.nodes.length : 0}, edges=${Array.isArray(revision?.graphBefore?.edges) ? revision.graphBefore.edges.length : 0}</div>
                <div><b>Graph After:</b> nodes=${Array.isArray(revision?.graphAfter?.nodes) ? revision.graphAfter.nodes.length : 0}, edges=${Array.isArray(revision?.graphAfter?.edges) ? revision.graphAfter.edges.length : 0}</div>
              </div>
            `)}
          </div>
        </details>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          <h3 style="margin: 0; font-size: 14px; color: var(--color-text-secondary, #8b95a5);">Node Execution</h3>
          ${nodeIds.length === 0 && html`<div style="font-size: 12px; opacity: 0.6;">No node execution data recorded.</div>`}
          ${nodeIds.map((nodeId) => {
            const nodeStatus = nodeStatuses[nodeId];
            const nodeStatusStyles = getRunStatusBadgeStyles(nodeStatus);
            const nodeOutput = nodeOutputs[nodeId];
            const nodeSummary = typeof nodeOutput?.summary === "string" ? nodeOutput.summary.trim() : "";
            const nodeNarrative = typeof nodeOutput?.narrative === "string" ? nodeOutput.narrative.trim() : "";
            return html`
              <details key=${nodeId} style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid ${getNodeCardBorder(nodeStatus)}; border-radius: 8px; padding: 8px 10px;">
                <summary style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                  <code style="font-size: 12px;">${nodeId}</code>
                  <span class="wf-badge" style="background: ${nodeStatusStyles.bg}; color: ${nodeStatusStyles.color};">
                    ${nodeStatus || "unknown"}
                  </span>
                </summary>
                ${(nodeSummary || nodeNarrative) && html`
                  <div style="margin-top: 8px; font-size: 12px; color: #d1d5db; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-word;">
                    ${nodeSummary ? html`<div><b>Summary:</b> ${nodeSummary}</div>` : ""}
                    ${nodeNarrative ? html`<div style="margin-top: ${nodeSummary ? "6px" : "0"};"><b>Narrative:</b> ${nodeNarrative}</div>` : ""}
                  </div>
                `}
                <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px;">
                  <${Button}
                    variant="outlined"
                    size="small"
                    onClick=${() => openRunNodeCopilot(selectedRun, nodeId, "node", currentWorkflow)}
                  >
                    <span class="btn-icon">${resolveIcon("bot")}</span>
                    Ask Bosun About This Node
                  <//>
                  ${String(nodeStatus || "").trim().toLowerCase() === "failed" && html`
                    <${Button}
                      variant="contained"
                      size="small"
                      color="error"
                      onClick=${() => openRunNodeCopilot(selectedRun, nodeId, "fix", currentWorkflow)}
                    >
                      <span class="btn-icon">${resolveIcon("settings")}</span>
                      Fix This Node
                    <//>
                  `}
                </div>
                <pre style="margin-top: 8px; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: #c9d1d9; background: #111827; border-radius: 6px; padding: 8px;">${safePrettyJson(nodeOutput)}</pre>
              </details>
            `;
          })}
        </div>

        <div style="margin-top: 14px; display: grid; gap: 10px;">
          <details open style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 8px 10px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Run Logs (${filteredLogs.length}/${logs.length})</summary>
            <${TextField}
              size="small"
              variant="outlined"
              fullWidth
              placeholder="Search run logs..."
              value=${logsPaneSearch}
              onInput=${(event) => setLogsPaneSearch(event.target.value)}
              sx=${{ mt: 1, mb: 1 }}
            />
            ${filteredLogs.length === 0
              ? html`<div style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary, #8b95a5);">No log entries match this filter.</div>`
              : html`
                <div style="display:flex; flex-direction:column; gap:6px; max-height:360px; overflow:auto;">
                  ${filteredLogs.slice(-120).map((entry, index) => html`
                    <div key=${`log-${index}`} style="background:#111827; border:1px solid #1f2937; border-radius:6px; padding:8px;">
                      <pre style="margin:0; white-space:pre-wrap; word-break:break-word; font-size:11px; color:#c9d1d9;">${safePrettyJson(entry)}</pre>
                    </div>
                  `)}
                </div>
              `}
          </details>
          <details open style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 8px 10px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Errors (${filteredErrors.length}/${errors.length})</summary>
            <${TextField}
              size="small"
              variant="outlined"
              fullWidth
              placeholder="Search errors..."
              value=${errorsPaneSearch}
              onInput=${(event) => setErrorsPaneSearch(event.target.value)}
              sx=${{ mt: 1, mb: 1 }}
            />
            ${filteredErrors.length === 0
              ? html`<div style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary, #8b95a5);">No errors match this filter.</div>`
              : html`
                <div style="display:flex; flex-direction:column; gap:6px; max-height:260px; overflow:auto;">
                  ${filteredErrors.slice(-80).map((entry, index) => html`
                    <div key=${`err-${index}`} style="background:#111827; border:1px solid #3f1f2a; border-radius:6px; padding:8px;">
                      <pre style="margin:0; white-space:pre-wrap; word-break:break-word; font-size:11px; color:#fca5a5;">${safePrettyJson(entry)}</pre>
                    </div>
                  `)}
                </div>
              `}
          </details>
          <details open style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 8px 10px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Execution Ledger (${filteredLedgerEvents.length}/${ledgerEvents.length})</summary>
            <${TextField}
              size="small"
              variant="outlined"
              fullWidth
              placeholder="Search ledger events..."
              value=${ledgerPaneSearch}
              onInput=${(event) => setLedgerPaneSearch(event.target.value)}
              sx=${{ mt: 1, mb: 1 }}
            />
            ${filteredLedgerEvents.length === 0
              ? html`<div style="margin-top: 8px; font-size: 12px; color: var(--color-text-secondary, #8b95a5);">No ledger events recorded.</div>`
              : html`
                <div style="margin-top: 8px; display:flex; flex-direction:column; gap:6px;">
                  ${filteredLedgerEvents.slice(-120).map((event, index) => html`
                    <div key=${`${event?.timestamp || "event"}-${index}`} style="background:#111827; border:1px solid #1f2937; border-radius:6px; padding:8px;">
                      <div style="font-size:11px; color:#93c5fd; margin-bottom:4px;">
                        ${event?.timestamp ? `${formatDate(event.timestamp)} (${formatRelative(event.timestamp)})` : "unknown time"}
                      </div>
                      <div style="font-size:12px; color:#e5e7eb;">${summarizeLedgerEvent(event)}</div>
                    </div>
                  `)}
                </div>
              `}
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 8px 10px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Raw Run JSON</summary>
            <${TextField}
              size="small"
              variant="outlined"
              fullWidth
              placeholder="Search raw JSON lines..."
              value=${rawPaneSearch}
              onInput=${(event) => setRawPaneSearch(event.target.value)}
              sx=${{ mt: 1, mb: 1 }}
            />
            <pre style="margin-top: 8px; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: #c9d1d9; background: #111827; border-radius: 6px; padding: 8px; max-height:420px; overflow:auto;">${filteredRawLines.join("\n")}</pre>
          </details>
        </div>
      </div>
    `;
  }

  return html`
    <div style="padding: 0 4px;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <${Button} variant="text" size="small" onClick=${returnToWorkflowList}>← Back to Workflows<//>
        ${scopedWorkflowId && html`<${Button} variant="text" size="small" onClick=${() => openWorkflowCanvas(scopedWorkflowId)}>Open Workflow<//>`}
        <h2 style="margin: 0; font-size: 18px; font-weight: 700;">Run History${scopedWorkflowName ? ` · ${scopedWorkflowName}` : ""}</h2>
        <${Button}
          variant="text"
          size="small"
          onClick=${() => loadRuns(undefined, { preserveExisting: true })}
          disabled=${runsLoading}
        >
          ${runsLoading ? html`<${CircularProgress} size=${14} sx=${{ mr: 0.5 }} /> Refreshing…` : "Refresh"}
        <//>
        ${canLoadMoreRuns && html`
          <${Button}
            variant="text"
            size="small"
            onClick=${() => triggerLoadMoreRuns()}
            disabled=${loadingMoreRuns}
          >
            ${loadingMoreRuns ? "Loading…" : "Load older"}
          <//>
        `}
        ${hasRunningRuns && html`<span class="wf-badge" style="background: #3b82f630; color: #60a5fa;">Live</span>`}
        ${runsLoading && runs.length > 0 && html`
          <span class="wf-badge" style="background:#38bdf820; color:#7dd3fc; display:flex; align-items:center; gap:6px;">
            <${CircularProgress} size=${12} sx=${{ color: "#7dd3fc" }} />
            Loading
          </span>
        `}
      </div>

      ${runsError && html`
        <${Alert}
          severity="warning"
          sx=${{ mb: 1.5 }}
          action=${html`<${Button} color="inherit" size="small" onClick=${() => loadRuns(undefined, { preserveExisting: true })}>Retry<//>`}
        >
          ${runsError}
        </${Alert}>
      `}

      <div class="wf-runs-toolbar">
        <${TextField}
          size="small"
          variant="outlined"
          placeholder="Search workflow, run ID, trigger event..."
          value=${searchQuery}
          onInput=${(e) => setSearchQuery(e.target.value)}
        />
        <${Select} size="small" value=${workflowFilter} onChange=${(e) => setWorkflowFilter(e.target.value)}>
          <${MenuItem} value="all">All Workflows</${MenuItem}>
          ${workflowOptions.map((opt) => html`<${MenuItem} value=${opt.id}>${opt.name}</${MenuItem}>`)}
        </${Select}>
        <${Select} size="small" value=${statusFilter} onChange=${(e) => setStatusFilter(e.target.value)}>
          <${MenuItem} value="all">All Statuses</${MenuItem}>
          <${MenuItem} value="running">Running</${MenuItem}>
          <${MenuItem} value="failed">Failed</${MenuItem}>
          <${MenuItem} value="completed">Completed</${MenuItem}>
        </${Select}>
        <${Select} size="small" value=${triggerFilter} onChange=${(e) => setTriggerFilter(e.target.value)}>
          <${MenuItem} value="all">All Trigger Types</${MenuItem}>
          <${MenuItem} value="manual">Manual</${MenuItem}>
          <${MenuItem} value="monitor-event">Monitor Event</${MenuItem}>
          <${MenuItem} value="event">Event</${MenuItem}>
          <${MenuItem} value="unknown">Unknown</${MenuItem}>
        </${Select}>
      </div>

      <div class="wf-runs-filters">
        <${Chip}
          label=${`All ${totalRuns}`}
          onClick=${() => setStatusFilter("all")}
          variant=${statusFilter === "all" ? "filled" : "outlined"}
          size="small"
        />
        <${Chip}
          label=${`Running ${runCounts.running}`}
          onClick=${() => setStatusFilter("running")}
          variant=${statusFilter === "running" ? "filled" : "outlined"}
          size="small"
        />
        <${Chip}
          label=${`Failed ${runCounts.failed}`}
          onClick=${() => setStatusFilter("failed")}
          variant=${statusFilter === "failed" ? "filled" : "outlined"}
          size="small"
        />
        <${Chip}
          label=${`Completed ${runCounts.completed}`}
          onClick=${() => setStatusFilter("completed")}
          variant=${statusFilter === "completed" ? "filled" : "outlined"}
          size="small"
        />
        <${Chip}
          label=${`Paused ${runCounts.paused}`}
          onClick=${() => setStatusFilter("paused")}
          variant=${statusFilter === "paused" ? "filled" : "outlined"}
          size="small"
        />
        <span class="wf-runs-count">${filteredRuns.length} shown</span>
        <span class="wf-runs-count">${runs.length} loaded</span>
        <span class="wf-runs-count">${totalRuns} total</span>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px;">
        <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:8px;padding:10px;">
          <div style="font-size:11px;opacity:0.7;">Success Rate</div>
          <div style="font-size:20px;font-weight:700;line-height:1.2;">${runMetrics.successRate}%</div>
          <div style="font-size:11px;opacity:0.6;">${runMetrics.settled} settled runs</div>
        </div>
        <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:8px;padding:10px;">
          <div style="font-size:11px;opacity:0.7;">Running</div>
          <div style="font-size:20px;font-weight:700;line-height:1.2;color:#60a5fa;">${runCounts.running}</div>
          <div style="font-size:11px;opacity:0.6;">${runMetrics.activeNodes} active nodes</div>
        </div>
        <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:8px;padding:10px;">
          <div style="font-size:11px;opacity:0.7;">Failed</div>
          <div style="font-size:20px;font-weight:700;line-height:1.2;color:#f87171;">${runCounts.failed}</div>
          <div style="font-size:11px;opacity:0.6;">Need triage</div>
        </div>
        <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:8px;padding:10px;">
          <div style="font-size:11px;opacity:0.7;">Stuck Running</div>
          <div style="font-size:20px;font-weight:700;line-height:1.2;color:${runMetrics.stuckCount > 0 ? "#fbbf24" : "#34d399"};">${runMetrics.stuckCount}</div>
          <div style="font-size:11px;opacity:0.6;">Potential intervention</div>
        </div>
      </div>

      <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:10px;padding:12px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="wf-badge" style="background:#38bdf820;color:#7dd3fc;">Operator Inbox</span>
              <span class="wf-runs-count">${operatorInboxItems.length} open item(s)</span>
            </div>
            <div style="font-size:12px;color:var(--color-text-secondary,#8b95a5);margin-top:4px;">
              Pending workflow approvals plus waiting or stalled harness runs
            </div>
          </div>
          <${Button} variant="text" size="small" onClick=${() => loadApprovals(approvalStatusFilter)} disabled=${approvalQueueLoading}>
            ${approvalQueueLoading ? "Refreshing…" : "Refresh Inbox"}
          <//>
        </div>
        ${operatorInboxItems.length === 0
          ? html`<div style="font-size:12px;color:var(--color-text-secondary,#8b95a5);">No operator inbox items right now.</div>`
          : html`
              <div style="display:flex;flex-direction:column;gap:8px;">
                ${operatorInboxItems.map((item) => html`
                  <div key=${item.key} style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span class="wf-badge" style="background:${item.kind === "approval" ? "#f59e0b24" : "#a855f720"};color:${item.kind === "approval" ? "#fbbf24" : "#d8b4fe"};">
                          ${item.kind === "approval" ? "approval" : "harness attention"}
                        </span>
                        <span class="wf-badge">${item.state || "unknown"}</span>
                        <span style="font-size:12px;font-weight:600;color:#e5e7eb;">${item.label}</span>
                      </div>
                      <div style="font-size:11px;color:#93c5fd;">
                        ${item.createdAt ? `${formatDate(item.createdAt)} (${formatRelative(item.createdAt)})` : "queued now"}
                      </div>
                    </div>
                    <div style="margin-top:6px;font-size:12px;color:var(--color-text-secondary,#cbd5e1);line-height:1.6;">
                      ${item.detail || "No additional detail recorded."}
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                      <${Button} variant="outlined" size="small" onClick=${() => openOperatorInboxItem(item)}>
                        ${item.kind === "approval" ? "Open Target" : "Open Harness Monitor"}
                      <//>
                      ${item.kind === "approval" && html`
                        <${Button} variant="contained" size="small" color="success" onClick=${() => resolveQueuedApproval(item.request, "approved")}>
                          Approve Request
                        <//>
                        <${Button} variant="outlined" size="small" color="warning" onClick=${() => resolveQueuedApproval(item.request, "denied")}>
                          Deny Request
                        <//>
                      `}
                    </div>
                  </div>
                `)}
              </div>
            `}
      </div>

      <div style="background:var(--color-bg-secondary,#1a1f2e);border:1px solid var(--color-border,#2a3040);border-radius:10px;padding:12px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="wf-badge" style="background:#f59e0b24;color:#fbbf24;">Approval Queue</span>
            <span class="wf-runs-count">Pending Approvals ${approvalQueuePendingCount}</span>
            <span class="wf-runs-count">${filteredApprovalRequests.length} shown</span>
            <span class="wf-runs-count">${approvalRequests.length} loaded</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <${Select} size="small" value=${approvalStatusFilter} onChange=${(event) => setApprovalStatusFilter(event.target.value)}>
              <${MenuItem} value="pending">Pending Only</${MenuItem}>
              <${MenuItem} value="all">Pending + Resolved</${MenuItem}>
            </${Select}>
            <${Select} size="small" value=${approvalScopeFilter} onChange=${(event) => setApprovalScopeFilter(event.target.value)}>
              <${MenuItem} value="all">All Scopes</${MenuItem}>
              <${MenuItem} value="workflow-run">Workflow Runs</${MenuItem}>
              <${MenuItem} value="workflow-gate">Workflow Gates</${MenuItem}>
              <${MenuItem} value="workflow-action">Workflow Actions</${MenuItem}>
              <${MenuItem} value="harness-run">Harness Runs</${MenuItem}>
            </${Select}>
            <${Button} variant="text" size="small" onClick=${() => loadApprovals(approvalStatusFilter)} disabled=${approvalQueueLoading}>
              ${approvalQueueLoading ? "Refreshing…" : "Refresh Queue"}
            <//>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
          ${[
            { key: "all", label: `All ${approvalScopeCounts.all}` },
            { key: "workflow-run", label: `Runs ${approvalScopeCounts["workflow-run"]}` },
            { key: "workflow-gate", label: `Gates ${approvalScopeCounts["workflow-gate"]}` },
            { key: "workflow-action", label: `Actions ${approvalScopeCounts["workflow-action"]}` },
            { key: "harness-run", label: `Harness ${approvalScopeCounts["harness-run"]}` },
          ].map((option) => html`
            <${Chip}
              key=${option.key}
              label=${option.label}
              onClick=${() => setApprovalScopeFilter(option.key)}
              variant=${approvalScopeFilter === option.key ? "filled" : "outlined"}
              size="small"
            />
          `)}
        </div>
        ${approvalRequests.length === 0
          ? html`<div style="font-size:12px;color:var(--color-text-secondary,#8b95a5);">No approval requests are currently queued.</div>`
          : filteredApprovalRequests.length === 0
            ? html`<div style="font-size:12px;color:var(--color-text-secondary,#8b95a5);">No approval requests match the selected scope filter.</div>`
          : html`
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${filteredApprovalRequests.map((request) => {
                const requestStatus = String(request?.status || "pending").trim().toLowerCase() || "pending";
                const canResolve = requestStatus === "pending";
                const requestRunId = String(request?.runId || "").trim();
                const requestScopeType = String(request?.scopeType || "").trim().toLowerCase();
                const scopeBadge = getApprovalScopeBadgeStyles(requestScopeType);
                return html`
                  <div key=${request.requestId} style="background:#111827;border:1px solid #1f2937;border-radius:8px;padding:10px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span class="wf-badge" style="background:${requestStatus === "pending" ? "#f59e0b24" : (requestStatus === "approved" ? "#22c55e22" : "#ef444422")};color:${requestStatus === "pending" ? "#fbbf24" : (requestStatus === "approved" ? "#86efac" : "#fca5a5")};">
                          ${requestStatus}
                        </span>
                        <span class="wf-badge" style="background:${scopeBadge.background};color:${scopeBadge.color};">
                          ${getApprovalScopeLabel(requestScopeType)}
                        </span>
                        <span style="font-size:12px;font-weight:600;color:#e5e7eb;">${describeApprovalRequest(request)}</span>
                      </div>
                      <div style="font-size:11px;color:#93c5fd;">
                        ${request?.requestedAt ? `${formatDate(request.requestedAt)} (${formatRelative(request.requestedAt)})` : "queued now"}
                      </div>
                    </div>
                    <div style="margin-top:6px;font-size:12px;color:var(--color-text-secondary,#cbd5e1);line-height:1.6;">
                      <div><b>Target:</b> ${describeApprovalTarget(request)}</div>
                      <div><b>Reason:</b> ${request?.reason || "No approval reason recorded."}</div>
                      ${requestScopeType === "harness-run" && html`<div><b>Harness Stage:</b> <code>${request?.stageId || "—"}</code>${request?.stageType ? ` · ${request.stageType}` : ""}${request?.requestedBy ? ` · requested by ${request.requestedBy}` : ""}</div>`}
                      ${request?.nodeId && html`<div><b>${requestScopeType === "workflow-action" ? "Action Node" : "Gate Node"}:</b> <code>${request.nodeId}</code>${request?.nodeLabel ? ` · ${request.nodeLabel}` : ""}${request?.nodeType ? ` · ${request.nodeType}` : ""}</div>`}
                      ${request?.action?.preview && html`<div><b>Preview:</b> <code>${request.action.preview}</code></div>`}
                      ${request?.preview && requestScopeType === "harness-run" && html`<div><b>Preview:</b> <code>${request.preview}</code></div>`}
                      ${request?.resolution?.actorId && html`<div><b>Resolved By:</b> ${request.resolution.actorId}${request?.resolution?.note ? ` · ${request.resolution.note}` : ""}</div>`}
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
                      <${Button} variant="outlined" size="small" onClick=${() => openApprovalTarget(request)}>
                        ${requestScopeType === "harness-run" ? "Open Harness Monitor" : requestRunId ? "Open Run" : "Open Target"}
                      <//>
                      ${canResolve && html`
                        <${Button} variant="contained" size="small" color="success" onClick=${() => resolveQueuedApproval(request, "approved")}>
                          Approve Request
                        <//>
                        <${Button} variant="outlined" size="small" color="warning" onClick=${() => resolveQueuedApproval(request, "denied")}>
                          Deny Request
                        <//>
                      `}
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
      </div>

      ${runsLoading && runs.length === 0 && html`
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:40px; color:var(--color-text-secondary,#94a3b8);">
          <${CircularProgress} size=${28} />
          <div>Loading workflow runs…</div>
        </div>
      `}

      ${!runsLoading && runs.length === 0 && html`
        <div style="text-align: center; padding: 40px; opacity: 0.5;">No workflow runs yet</div>
      `}

      ${!runsLoading && runs.length > 0 && filteredRuns.length === 0 && html`
        <div style="text-align: center; padding: 28px; opacity: 0.6;">
          <div>No runs match the current filters yet.</div>
          ${canLoadMoreRuns && html`
            <div style="margin-top: 6px;">Bosun has loaded ${runs.length} of ${totalRuns} run(s); use Load more runs to search older history.</div>
          `}
        </div>
      `}

      <${TableContainer} component=${Paper} variant="outlined" sx=${{ maxHeight: 480, overflow: "auto" }}>
        <${Table} size="small" stickyHeader>
          <${TableHead}>
            <${TableRow}>
              <${TableCell}>Workflow<//>
              <${TableCell}>Status<//>
              <${TableCell}>Trigger<//>
              <${TableCell}>Started<//>
              <${TableCell}>Duration<//>
              <${TableCell}>Nodes<//>
              <${TableCell} align="right">Run ID<//>
            </${TableRow}>
          <//>
          <${TableBody}>
            ${filteredRuns.map((run) => {
              const styles = getRunStatusBadgeStyles(run.status);
              const runName = run.workflowName || workflowNameMap.get(run.workflowId) || run.workflowId;
              const liveDuration = run.status === "running" && run.startedAt
                ? Math.max(0, nowTick - run.startedAt)
                : run.duration;
              const triggerLabel = getWorkflowRunTriggerLabel(run);
              return html`
                <${TableRow}
                  key=${run.runId}
                  hover
                  selected=${selectedRunId.value === run.runId}
                  sx=${{ cursor: "pointer" }}
                  onClick=${() => loadRunDetail(run.runId, { workflowId: run.workflowId })}
                >
                  <${TableCell}>
                    <${Typography} variant="body2" sx=${{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
                      ${runName || "Unknown"}
                    <//>
                  <//>
                  <${TableCell}>
                    <${Stack} direction="row" spacing=${0.5} alignItems="center">
                      <${Chip}
                        size="small"
                        label=${run.status || "unknown"}
                        sx=${{ background: styles.bg, color: styles.color, fontWeight: 600, fontSize: "11px" }}
                      />
                      ${run.isStuck && html`<${Chip} size="small" label="stuck" color="warning" variant="outlined" />`}
                      ${run.retryOf && html`<${Chip} size="small" label="retry" color="success" variant="outlined" />`}
                    <//>
                  <//>
                  <${TableCell}>
                    <${Typography} variant="caption">${triggerLabel}<//>
                  <//>
                  <${TableCell}>
                    <${Typography} variant="caption" sx=${{ whiteSpace: "nowrap" }}>${formatRelative(run.startedAt)}<//>
                  <//>
                  <${TableCell}>
                    <${Typography} variant="caption" sx=${{ whiteSpace: "nowrap" }}>${formatDuration(liveDuration)}<//>
                  <//>
                  <${TableCell}>
                    <${Typography} variant="caption">${run.nodeCount || 0}${run.errorCount ? html` · <span style="color:#f87171">${run.errorCount} err</span>` : ""}<//>
                  <//>
                  <${TableCell} align="right">
                    <${Typography} variant="caption" sx=${{ fontFamily: "monospace", opacity: 0.7 }}>${String(run.runId || "").slice(0, 12)}<//>
                  <//>
                </${TableRow}>
              `;
            })}
          <//>
        </${Table}>
      <//>
      ${canLoadMoreRuns && html`
        <div style="display: flex; justify-content: center; margin-top: 12px;">
          <${Button}
            type="button"
            variant="outlined"
            size="small"
            onClick=${() => triggerLoadMoreRuns()}
            disabled=${loadingMoreRuns}
          >
            ${loadingMoreRuns ? "Loading more runs..." : `Load more runs (${runs.length}/${totalRuns})`}
          <//>
        </div>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Code View — JSON Editor for Workflows
 * ═══════════════════════════════════════════════════════════════ */

function WorkflowCodeView({ workflow, onSave }) {
  const [code, setCode] = useState("");
  const [originalCode, setOriginalCode] = useState("");
  const [errors, setErrors] = useState([]);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (!workflow?.id) return;
    apiFetch(`/api/workflows/${encodeURIComponent(workflow.id)}/code`)
      .then(data => {
        if (data?.code) {
          setCode(data.code);
          setOriginalCode(data.code);
          setErrors([]);
          setIsDirty(false);
        }
      })
      .catch(() => showToast("Failed to load workflow code", "error"));
  }, [workflow?.id]);

  const handleCodeChange = useCallback((e) => {
    const newCode = e.target.value;
    setCode(newCode);
    setIsDirty(newCode !== originalCode);

    try {
      JSON.parse(newCode);
      setErrors([]);
    } catch (err) {
      const lineMatch = String(err.message).match(/position\s+(\d+)/i);
      let line;
      if (lineMatch) {
        const pos = parseInt(lineMatch[1], 10);
        line = newCode.slice(0, pos).split("\n").length;
      }
      setErrors([{ message: err.message, line }]);
    }
  }, [originalCode]);

  const handleSave = useCallback(async () => {
    if (!workflow?.id || !isDirty) return;
    setSaving(true);
    try {
      const resp = await apiFetch(`/api/workflows/${encodeURIComponent(workflow.id)}/code`, {
        method: "PUT",
        body: JSON.stringify({ code }),
      });
      if (resp?.ok) {
        showToast("Workflow updated from code", "success");
        setOriginalCode(code);
        setIsDirty(false);
        if (resp.workflow && onSave) onSave(resp.workflow);
      } else if (resp?.errors) {
        setErrors(resp.errors.map(e => typeof e === "string" ? { message: e } : e));
        showToast("Validation errors — check below", "error");
      }
    } catch (err) {
      showToast("Failed to save: " + (err.message || err), "error");
    } finally {
      setSaving(false);
    }
  }, [workflow?.id, code, isDirty, onSave]);

  const handleRevert = useCallback(() => {
    setCode(originalCode);
    setIsDirty(false);
    setErrors([]);
  }, [originalCode]);

  const handleFormat = useCallback(() => {
    try {
      const parsed = JSON.parse(code);
      const formatted = JSON.stringify(parsed, null, 2);
      setCode(formatted);
      setIsDirty(formatted !== originalCode);
      setErrors([]);
    } catch {
      showToast("Cannot format — fix JSON syntax errors first", "warning");
    }
  }, [code, originalCode]);

  const lineCount = code.split("\n").length;

  return html`
    <div style="padding: 0 4px; display: flex; flex-direction: column; height: calc(100vh - 120px);">
      <!-- Toolbar -->
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
        <${Button} variant="text" size="small" onClick=${() => { viewMode.value = "canvas"; }}>
          ← Back to Canvas
        <//>
        <h2 style="margin: 0; font-size: 18px; font-weight: 700; flex: 1;">
          Code View: ${workflow?.name || "Workflow"}
        </h2>
        <${Button} variant="outlined" size="small" onClick=${handleFormat} disabled=${saving}>
          Format JSON
        <//>
        <${Button} variant="outlined" size="small" onClick=${handleRevert} disabled=${!isDirty || saving}>
          Revert
        <//>
        <${Button} variant="contained" size="small" onClick=${handleSave} disabled=${!isDirty || errors.length > 0 || saving}>
          ${saving ? "Saving…" : "Save"}
        <//>
        ${isDirty && html`
          <${Chip} label="Unsaved changes" size="small" color="warning" variant="outlined" />
        `}
      </div>

      <!-- Error bar -->
      ${errors.length > 0 && html`
        <${Alert} severity="error" style="margin-bottom: 8px; font-size: 12px;">
          ${errors.map((e, i) => html`
            <div key=${i}>${e.line ? `Line ${e.line}: ` : ""}${e.message}</div>
          `)}
        <//>
      `}

      <!-- Editor area -->
      <div style="flex: 1; display: flex; border: 1px solid ${errors.length > 0 ? '#ef4444' : 'var(--color-border, #2a3040)'}; border-radius: 8px; overflow: hidden; background: #0d1117;">
        <!-- Line numbers -->
        <div style="padding: 12px 8px; background: #161b22; color: #484f58; font-family: 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; line-height: 1.6; text-align: right; user-select: none; min-width: 48px; border-right: 1px solid #21262d;">
          ${Array.from({ length: lineCount }, (_, i) => html`<div key=${i}>${i + 1}</div>`)}
        </div>

        <!-- Code textarea -->
        <textarea
          ref=${textareaRef}
          value=${code}
          onInput=${handleCodeChange}
          spellcheck=${false}
          style="flex: 1; padding: 12px; background: transparent; color: #e6edf3; font-family: 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; line-height: 1.6; border: none; outline: none; resize: none; tab-size: 2; white-space: pre; overflow: auto;"
          onKeyDown=${(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const ta = e.target;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const newVal = code.slice(0, start) + "  " + code.slice(end);
              setCode(newVal);
              setIsDirty(newVal !== originalCode);
              requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
            }
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              handleSave();
            }
          }}
        />
      </div>

      <!-- Status bar -->
      <div style="display: flex; align-items: center; gap: 12px; padding: 6px 4px; font-size: 11px; color: var(--color-text-secondary, #8b95a5);">
        <span>${lineCount} lines</span>
        <span>${code.length} characters</span>
        <span>JSON${errors.length === 0 ? " ✓" : " ✗"}</span>
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Main Tab Export
 * ═══════════════════════════════════════════════════════════════ */

export function WorkflowsTab() {
  useEffect(() => {
    loadWorkflows();
    loadTemplates();
    loadNodeTypes();
  }, []);

  useEffect(() => {
    const onWorkspaceSwitched = () => {
      activeWorkflow.value = null;
      selectedRunId.value = null;
      selectedRunDetail.value = null;
      resetWorkflowRunsState();
      viewMode.value = "list";
      setRouteParams({}, { replace: true, skipGuard: true });
      loadWorkflows();
      loadTemplates();
      loadNodeTypes();
    };
    window.addEventListener("ve:workspace-switched", onWorkspaceSwitched);
    return () => {
      window.removeEventListener("ve:workspace-switched", onWorkspaceSwitched);
    };
  }, []);

  useEffect(() => {
    const route = routeParams.value || {};
    const workflowId = String(route.workflowId || "").trim();
    const runId = String(route.runId || "").trim();
    const runsWorkflowId = String(route.runsWorkflowId || "").trim();
    const wantsRuns = Boolean(route.runsView) || Boolean(runId);

    if (wantsRuns) {
      resetWorkflowRunsState(runsWorkflowId || null);
      viewMode.value = "runs";
      loadRuns(runsWorkflowId || null, { reset: true });
      if (runId) {
        loadRunDetail(runId, { workflowId: runsWorkflowId || null });
      } else {
        selectedRunId.value = null;
        selectedRunDetail.value = null;
      }
      return;
    }

    if (workflowId) {
      apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}`)
        .then((d) => {
          activeWorkflow.value = d?.workflow || activeWorkflow.value;
          if (activeWorkflow.value?.id === workflowId || d?.workflow?.id === workflowId) {
            viewMode.value = "canvas";
          }
        })
        .catch(() => {
          const existing = (workflows.value || []).find((wf) => wf.id === workflowId);
          if (existing) {
            activeWorkflow.value = existing;
            viewMode.value = "canvas";
          }
        });
      return;
    }

    if (viewMode.value !== "list") {
      selectedRunId.value = null;
      selectedRunDetail.value = null;
      activeWorkflow.value = null;
      viewMode.value = "list";
    }
  }, [routeParams.value]);

  useEffect(() => {
    const mode = viewMode.value;
    if (mode === "canvas" && activeWorkflow.value?.id) {
      setRouteParams(
        { workflowId: activeWorkflow.value.id },
        { replace: true, skipGuard: true },
      );
      return;
    }
    if (mode === "runs") {
      if (selectedRunId.value) {
        const route = { runsView: true, runId: selectedRunId.value };
        if (workflowRunsScopeId.value) route.runsWorkflowId = workflowRunsScopeId.value;
        setRouteParams(route, { replace: true, skipGuard: true });
      } else {
        const route = { runsView: true };
        if (workflowRunsScopeId.value) route.runsWorkflowId = workflowRunsScopeId.value;
        setRouteParams(route, { replace: true, skipGuard: true });
      }
      return;
    }
    setRouteParams({}, { replace: true, skipGuard: true });
  }, [viewMode.value, activeWorkflow.value?.id, selectedRunId.value]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key !== "Escape") return;
      const activeTag = document.activeElement?.tagName || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(activeTag)) return;
      if (viewMode.value !== "list") {
        e.preventDefault();
        returnToWorkflowList();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const mode = viewMode.value;

  return html`
    <style>
      .wf-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 14px;
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 8px;
        background: var(--color-bg-secondary, #1a1f2e);
        color: var(--color-text, white);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }
      .wf-btn:hover { border-color: #3b82f6; background: var(--bg-card-hover); }
      .wf-btn-primary { background: #3b82f6; border-color: #3b82f6; color: white; }
      .wf-btn-primary:hover { background: #2563eb; }
      .wf-btn-danger:hover { border-color: #ef4444; background: #dc262620; }
      .wf-btn-ghost { background: var(--bg-card); border-color: var(--color-border, #374151); color: var(--color-text-secondary, #d1d5db); }
      .wf-btn-ghost:hover { background: var(--bg-card-hover); border-color: #60a5fa; color: var(--color-text, #e5e7eb); }
      .wf-btn-sm { padding: 3px 8px; font-size: 11px; border-radius: 6px; }
      .wf-btn .btn-icon { display: inline-flex; align-items: center; justify-content: center; line-height: 0; vertical-align: middle; }
      .wf-btn .btn-icon svg { width: 1em; height: 1em; display: inline-block; stroke-width: 1.8; }
      .wf-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 500;
        background: var(--color-bg-secondary, #1a1f2e);
        color: var(--color-text-secondary, #8b95a5);
        border: 1px solid var(--color-border, #2a3040);
      }
      .wf-input {
        width: 100%;
        padding: 6px 10px;
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 6px;
        background: var(--color-bg-secondary, #1a1f2e);
        color: var(--color-text, white);
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
      }
      .wf-input:focus { border-color: #3b82f6; }
      .wf-textarea { font-family: monospace; font-size: 12px; resize: vertical; min-height: 60px; }
      .wf-runs-toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 2fr) repeat(3, minmax(140px, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .wf-runs-filters {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .wf-chip {
        background: var(--bg-card);
        color: var(--color-text-secondary, #cbd5e1);
        border: 1px solid var(--color-border, #334155);
        border-radius: 999px;
        font-size: 11px;
        padding: 4px 10px;
        cursor: pointer;
      }
      .wf-chip.active {
        color: #dbeafe;
        border-color: #2563eb;
        background: #1d4ed833;
      }
      .wf-runs-count {
        margin-left: auto;
        font-size: 11px;
        color: var(--color-text-secondary, #8b95a5);
      }
      @media (max-width: 900px) {
        .wf-runs-toolbar {
          grid-template-columns: 1fr;
        }
        .wf-runs-count {
          margin-left: 0;
        }
      }
      .wf-card { transition: border-color 0.15s, transform 0.1s; }
      .wf-card:hover { border-color: #3b82f680 !important; }
      .wf-template-card:hover { border-color: #f59e0b80 !important; }
      .wf-palette-item:hover { background: var(--color-bg-secondary, #1a1f2e) !important; }
      .wf-context-menu {
        background: var(--color-bg, #0d1117);
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .wf-context-menu button {
        display: block;
        width: 100%;
        padding: 8px 14px;
        border: none;
        background: none;
        color: var(--color-text, white);
        font-size: 13px;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
      }
      .wf-context-menu button:hover { background: var(--color-bg-secondary, #1a1f2e); }
      .wf-preset-btn:hover { border-color: #3b82f6 !important; background: var(--bg-card-hover) !important; }
      .wf-preset-section { animation: wf-fade-in 0.15s ease; }
      @keyframes wf-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      .wf-node-running rect:first-child {
        animation: wf-node-running-pulse 1.1s ease-in-out infinite;
      }
      .wf-node-flash-success rect:first-child {
        animation: wf-node-flash-success 0.45s ease-in-out 2;
      }
      .wf-node-flash-fail rect:first-child {
        animation: wf-node-flash-fail 0.45s ease-in-out 2;
      }
      .wf-node-flash-skipped rect:first-child {
        animation: wf-node-flash-skipped 0.45s ease-in-out 2;
      }
      @keyframes wf-node-running-pulse {
        0%, 100% { stroke-opacity: 0.6; }
        50% { stroke-opacity: 1; }
      }
      @keyframes wf-node-flash-success {
        0%, 100% { filter: none; }
        50% { filter: drop-shadow(0 0 10px rgba(16, 185, 129, 0.65)); }
      }
      @keyframes wf-node-flash-fail {
        0%, 100% { filter: none; }
        50% { filter: drop-shadow(0 0 10px rgba(239, 68, 68, 0.65)); }
      }
      @keyframes wf-node-flash-skipped {
        0%, 100% { filter: none; }
        50% { filter: drop-shadow(0 0 8px rgba(148, 163, 184, 0.55)); }
      }
      .wf-canvas-container { height: calc(100vh - 140px); min-height: 500px; }
      @media (min-width: 1200px) { .wf-canvas-container { height: calc(100vh - 120px); min-height: 700px; } }
    </style>

    <div
      class="wf-theme"
      style="padding: 8px; --color-bg: var(--bg-card); --color-bg-secondary: var(--bg-secondary); --color-border: var(--border); --color-text: var(--text-primary); --color-text-secondary: var(--text-secondary);"
    >
      ${mode === "code" && activeWorkflow.value
        ? html`<${WorkflowCodeView} workflow=${activeWorkflow.value} onSave=${(wf) => { activeWorkflow.value = wf; viewMode.value = "canvas"; }} />`
        : mode === "canvas" && activeWorkflow.value
        ? html`<${WorkflowCanvas} workflow=${activeWorkflow.value} nodeTypes=${nodeTypes.value} />`
        : mode === "runs"
        ? html`<${RunHistoryView} />`
        : html`<${WorkflowListView} />`
      }
      <${ExecuteWorkflowDialog} />
      <${InstallTemplateDialog} />
    </div>
  `;
}
