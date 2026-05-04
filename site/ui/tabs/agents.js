/* ─────────────────────────────────────────────────────────────
 *  Tab: Agents — thread/slot cards, capacity, detail expansion
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  Typography, Box, Stack, CardContent, Button, IconButton, Chip,
  Divider, Paper, TextField, CircularProgress, Alert, Tooltip,
  Tabs, Tab, Skeleton, Avatar, LinearProgress,
  List, ListItem, ListItemButton, ListItemText, ListItemIcon,
  Menu, MenuItem, Accordion, AccordionSummary, AccordionDetails,
  Select, FormControl, InputLabel,
} from "@mui/material";

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  executorData,
  agentsData,
  statusData,
  telemetrySummary,
  agentLogQuery,
  agentLogFile,
  agentWorkspaceTarget,
  showToast,
  refreshTab,
  scheduleRefresh,
} from "../modules/state.js";
import { navigateTo, routeParams, setRouteParams } from "../modules/router.js";
import {
  activeWorkspaceId,
  loadWorkspaces,
  workspaces as managedWorkspaces,
} from "../components/workspace-switcher.js";
import { ICONS } from "../modules/icons.js";
import { formatCompactCount } from "../modules/session-insights.js";
import { formatRelative, truncate } from "../modules/utils.js";
import {
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  resolveSessionWorkspaceHint,
} from "../modules/session-api.js";
import {
  Card,
  Badge,
  StatCard,
  SkeletonCard,
  EmptyState,
} from "../components/shared.js";
import { ProgressBar } from "../components/charts.js";
import { Collapsible } from "../components/forms.js";
import {
  loadSessions,
  loadSessionMessages,
  selectedSessionId,
  sessionsData,
  sessionMessages,
  sessionMessagesSessionId,
} from "../components/session-list.js";
import { ChatView } from "../components/chat-view.js";
import { DiffViewer } from "../components/diff-viewer.js";

/* ─── Status indicator helpers ─── */
function statusColor(s) {
  const map = {
    idle: "var(--color-todo)",
    busy: "var(--color-inprogress)",
    running: "var(--color-inprogress)",
    error: "var(--color-error)",
    done: "var(--color-done)",
  };
  return map[(s || "").toLowerCase()] || "var(--text-secondary)";
}

function StatusDot({ status }) {
  return html`<span
    class="status-dot"
    style="background:${statusColor(status)}"
  ></span>`;
}

/* ─── Duration formatting ─── */
function formatDuration(startedAt) {
  if (!startedAt) return "";
  const sec = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function formatMsDuration(ms) {
  const safeMs = Math.max(0, Number(ms || 0));
  if (safeMs < 1000) return String(safeMs) + "ms";
  const sec = Math.round(safeMs / 1000);
  if (sec < 60) return String(sec) + "s";
  if (sec < 3600) return String(Math.floor(sec / 60)) + "m " + String(sec % 60) + "s";
  return String(Math.floor(sec / 3600)) + "h " + String(Math.floor((sec % 3600) / 60)) + "m";
}

function getHarnessRunState(run) {
  return String(
    run?.health?.state
    || run?.status
    || run?.outcome
    || run?.result?.status
    || run?.result?.outcome
    || "unknown",
  ).trim().toLowerCase();
}

function getHarnessStateMeta(state) {
  const normalized = String(state || "").trim().toLowerCase();
  const base = {
    label: normalized ? normalized.replace(/[_-]+/g, " ") : "unknown",
    background: "rgba(148, 163, 184, 0.16)",
    color: "var(--text-secondary)",
  };
  if (normalized === "working") {
    return { label: "Working", background: "rgba(59, 130, 246, 0.16)", color: "var(--color-inprogress)" };
  }
  if (normalized === "waiting") {
    return { label: "Waiting", background: "rgba(245, 158, 11, 0.18)", color: "var(--color-warning, #f59e0b)" };
  }
  if (normalized === "stalled") {
    return { label: "Stalled", background: "rgba(239, 68, 68, 0.16)", color: "var(--color-error)" };
  }
  if (normalized === "completed") {
    return { label: "Completed", background: "rgba(16, 185, 129, 0.16)", color: "var(--color-done)" };
  }
  if (normalized === "failed") {
    return { label: "Failed", background: "rgba(239, 68, 68, 0.16)", color: "var(--color-error)" };
  }
  if (normalized === "aborted") {
    return { label: "Aborted", background: "rgba(244, 63, 94, 0.14)", color: "var(--color-error)" };
  }
  if (normalized === "stop_requested") {
    return { label: "Stop Requested", background: "rgba(251, 146, 60, 0.18)", color: "var(--color-warning, #f59e0b)" };
  }
  return base;
}

function getHarnessRunTimestamp(run) {
  const value = run?.updatedAt || run?.endedAt || run?.startedAt || run?.createdAt || run?.timestamp || 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function normalizeHarnessRuns(...sources) {
  const deduped = new Map();
  sources.flat().forEach((run) => {
    if (!run || typeof run !== "object") return;
    const runId = String(run?.runId || "").trim();
    if (!runId) return;
    const existing = deduped.get(runId);
    if (!existing) {
      deduped.set(runId, run);
      return;
    }
    const existingTs = getHarnessRunTimestamp(existing);
    const nextTs = getHarnessRunTimestamp(run);
    if (nextTs > existingTs || (run?.active && !existing?.active)) {
      deduped.set(runId, { ...existing, ...run });
    }
  });
  return Array.from(deduped.values()).sort((a, b) => getHarnessRunTimestamp(b) - getHarnessRunTimestamp(a));
}

function matchesHarnessMonitorFilter(run, filter) {
  const state = getHarnessRunState(run);
  if (filter === "active") return run?.active === true || state === "working";
  if (filter === "waiting") return run?.approvalPending === true || run?.health?.waitingForOperator === true || state === "waiting";
  if (filter === "stalled") return state === "stalled";
  if (filter === "attention") {
    return ["waiting", "stalled", "failed", "aborted", "stop_requested"].includes(state)
      || run?.approvalPending === true
      || run?.health?.waitingForOperator === true;
  }
  return true;
}

function formatHarnessStage(run) {
  return String(
    run?.currentStageId
    || run?.health?.approvalStageId
    || run?.stageId
    || run?.completedStageId
    || run?.result?.completedStageId
    || "—",
  ).trim() || "—";
}

function getHarnessApprovalRequestId(run) {
  return String(
    run?.health?.approvalRequestId
    || run?.approvalRequestId
    || run?.requestId
    || run?.latestApproval?.requestId
    || "",
  ).trim();
}

function getHarnessAttentionReason(run) {
  return String(run?.health?.attentionReason || "").trim();
}

function getHarnessLatestEventSummary(run) {
  return String(
    run?.health?.lastEventSummary
    || run?.latestEvent?.summary
    || "",
  ).trim();
}

function getHarnessAttentionDetail(run) {
  const state = getHarnessRunState(run);
  const attentionReason = getHarnessAttentionReason(run);
  const approvalRequestId = getHarnessApprovalRequestId(run);
  if (state === "waiting") {
    const base = attentionReason || "Awaiting operator approval.";
    return approvalRequestId ? `${base} · ${approvalRequestId}` : base;
  }
  if (attentionReason) return attentionReason;
  return String(run?.summary || run?.health?.state || "No summary yet").trim();
}

function normalizeAgentLiveness(payload) {
  if (Array.isArray(payload?.agents)) return payload.agents;
  if (Array.isArray(payload)) return payload;
  return [];
}

function normalizeAgentErrorPatterns(payload) {
  if (Array.isArray(payload?.patterns)) return payload.patterns;
  if (Array.isArray(payload?.errors)) return payload.errors;
  return [];
}

function getAgentMonitorSummary(event) {
  return String(
    event?.message
    || event?.summary
    || event?.payload?.message
    || event?.payload?.summary
    || event?.payload?.reason
    || event?.payload?.status
    || "",
  ).replace(/\s+/g, " ").trim();
}

function formatTurnTokens(turn) {
  const total = Number(turn?.totalTokens || 0);
  const input = Number(turn?.inputTokens || 0);
  const output = Number(turn?.outputTokens || 0);
  if (total > 0 || input > 0 || output > 0) {
    return String(total || input + output) + " tok" + ((input || output) ? (" · in " + input + " / out " + output) : "");
  }
  return "—";
}

function resolveTurnDurationMs(turn, pair) {
  const explicitDuration = Number(turn?.durationMs || 0);
  if (explicitDuration > 0) return explicitDuration;
  const startedAt = Date.parse(String(turn?.startedAt || pair?.user?.timestamp || pair?.assistant?.timestamp || ""));
  const endedAt = Date.parse(String(turn?.endedAt || pair?.assistant?.timestamp || pair?.user?.timestamp || ""));
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
    return endedAt - startedAt;
  }
  return 0;
}

function buildTurnTimeline(messages, turns) {
  const turnEntries = Array.isArray(turns) ? turns : [];
  const byIndex = new Map(turnEntries.map((turn) => [Number(turn?.turnIndex || 0), turn]));
  const grouped = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const turnIndex = Number.isFinite(Number(message?.turnIndex)) ? Number(message.turnIndex) : null;
    if (turnIndex == null) continue;
    const bucket = grouped.get(turnIndex) || { user: null, assistant: null };
    const role = String(message?.role || "").toLowerCase();
    if (role === "user" && !bucket.user) bucket.user = message;
    if (role === "assistant") bucket.assistant = message;
    grouped.set(turnIndex, bucket);
  }
  const allIndexes = Array.from(new Set([...byIndex.keys(), ...grouped.keys()])).sort((a, b) => a - b);
  return allIndexes.map((turnIndex) => {
    const turn = byIndex.get(turnIndex) || {};
    const pair = grouped.get(turnIndex) || { user: null, assistant: null };
    return {
      turnIndex,
      user: pair.user,
      assistant: pair.assistant,
      startedAt: turn.startedAt || pair.user?.timestamp || pair.assistant?.timestamp || null,
      endedAt: turn.endedAt || pair.assistant?.timestamp || pair.user?.timestamp || null,
      durationMs: resolveTurnDurationMs(turn, pair),
      inputTokens: Number(turn.inputTokens || 0),
      outputTokens: Number(turn.outputTokens || 0),
      totalTokens: Number(turn.totalTokens || 0),
      status: turn.status || (pair.assistant ? "completed" : pair.user ? "in_progress" : "pending"),
    };
  });
}

function taskSortScore(task) {
  const rawId = String(task?.id || "");
  const digits = rawId.match(/\d+/g);
  const numeric = digits?.length ? Number(digits[digits.length - 1]) : NaN;
  if (Number.isFinite(numeric)) return numeric;
  const createdAt = new Date(task?.createdAt || task?.created_at || 0).getTime();
  if (Number.isFinite(createdAt) && createdAt > 0) return createdAt;
  return 0;
}

function formatTaskOptionLabel(task) {
  const rawId = String(task?.id || "").trim();
  const digits = rawId.match(/\d+/g);
  const numberToken = digits?.length ? digits[digits.length - 1] : rawId || "?";
  return `#${numberToken} ${task?.title || "(untitled task)"}`;
}

function normalizeDispatchTaskChoices(tasks) {
  if (!Array.isArray(tasks)) return [];
  const deduped = [];
  const seenTaskIds = new Set();
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const status = String(task?.status || "").toLowerCase();
    const dispatchable =
      task?.draft === true || status === "draft" || status === "todo";
    if (!dispatchable) continue;
    const taskId = String(task?.id ?? task?.taskId ?? "").trim();
    if (!taskId || seenTaskIds.has(taskId)) continue;
    seenTaskIds.add(taskId);
    deduped.push({ ...task, id: taskId });
  }
  return deduped.sort((a, b) => taskSortScore(b) - taskSortScore(a));
}

function fleetSlotKey(index, slot) {
  const taskId = String(slot?.taskId || "").trim() || "na";
  const sessionId = String(slot?.sessionId || "").trim() || "na";
  return `slot-${index}:${taskId}:${sessionId}`;
}

function resolveFleetSlotIndex(slot, fallbackIndex = 0) {
  const slotIndex = Number(slot?.slotIndex);
  return Number.isFinite(slotIndex) && slotIndex >= 0 ? slotIndex : fallbackIndex;
}

function fleetThreadKey(thread, index) {
  const taskKey = String(thread?.taskKey || "").trim() || "na";
  const id = String(thread?.id || "").trim() || "na";
  return `thread-${index}:${taskKey}:${id}`;
}

function resolveFleetEntrySessionId(entry) {
  const sessionId = String(entry?.session?.id || "").trim();
  if (sessionId) return sessionId;
  if (entry?.isTaskFallback || entry?.slot?.synthetic) return "";
  return String(entry?.slot?.sessionId || "").trim();
}

function buildSessionLogQueryParts(values = []) {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function buildSessionLogQuery(values = []) {
  return buildSessionLogQueryParts(values).join(" ");
}

function isSessionSignalAction(action = {}) {
  const level = String(action?.level || "").toLowerCase();
  const label = String(action?.label || "");
  return (
    level === "error"
    || /(warn|error|failed|exception|timeout|anomal|retry|blocked|fatal)/i.test(label)
  );
}

function buildSessionFocusedLogText(entry, rawLogText = "") {
  const lines = [];
  const session = entry?.session || null;
  const insights = session?.insights || null;
  const totals = insights?.totals || null;
  const recentActions = Array.isArray(insights?.recentActions) ? insights.recentActions : [];
  const signalActions = recentActions.filter(isSessionSignalAction);
  const editedFiles = Array.isArray(insights?.activityDiff?.files) ? insights.activityDiff.files : [];
  const queryParts = buildSessionLogQueryParts([
    entry?.slot?.taskId,
    entry?.session?.taskId,
    entry?.session?.id,
    entry?.slot?.branch,
    entry?.session?.branch,
  ]);

  lines.push("Session-focused signals");
  lines.push("=====================");
  lines.push(
    `Session: ${session?.title || session?.taskTitle || entry?.slot?.taskTitle || entry?.slot?.taskId || entry?.session?.id || "unknown"}`,
  );
  if (queryParts.length) {
    lines.push(`Keys: ${queryParts.join(" | ")}`);
  }
  if (totals) {
    lines.push(
      `Totals: ${totals.messages || 0} messages, ${totals.toolCalls || 0} tool calls, ${totals.errors || 0} errors`,
    );
  }
  if (signalActions.length) {
    lines.push("");
    lines.push("Warnings / errors");
    lines.push("-----------------");
    signalActions.slice(0, 8).forEach((action) => {
      lines.push(`- [${String(action.timestamp || "").replace("T", " ").replace("Z", "")}] ${action.label}`);
    });
  }
  if (editedFiles.length) {
    lines.push("");
    lines.push("Touched files");
    lines.push("-------------");
    editedFiles.slice(0, 8).forEach((file) => {
      lines.push(`- ${file.path} (${file.edits || 0} edits)`);
    });
  }

  const raw = String(rawLogText || "").trim();
  if (raw) {
    lines.push("");
    lines.push("Raw focused log lines");
    lines.push("---------------------");
    lines.push(raw);
  } else if (!signalActions.length) {
    lines.push("");
    lines.push("No session-specific warnings or log lines found yet.");
  }

  return lines.join("\n");
}

const FLEET_SESSION_SCOPE = Object.freeze({
  all: "all",
  active: "active",
  historic: "historic",
});

function getFleetEntryTitle(entry) {
  return (
    entry?.slot?.taskTitle
    || entry?.session?.taskTitle
    || entry?.session?.title
    || entry?.session?.taskId
    || entry?.session?.id
    || "(untitled)"
  );
}

function formatFleetStateLabel(value, fallback = "Unknown") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getFleetEntryStatus(entry) {
  return getFleetEntryStatusMeta(entry).key;
}

function isFleetEntryActive(entry) {
  if (!entry || typeof entry !== "object") return false;
  return getFleetEntryStatusMeta(entry).isActive === true;
}

function getFleetEntryResponseTimestamp(entry) {
  const session = entry?.session || null;
  const recentActions = Array.isArray(session?.insights?.recentActions) ? session.insights.recentActions : [];
  const turns = Array.isArray(session?.turns) ? session.turns : [];
  const candidates = [
    ...recentActions.map((action) => action?.timestamp),
    ...turns.flatMap((turn) => [turn?.completedAt, turn?.updatedAt, turn?.endedAt, turn?.startedAt]),
    session?.lastMessageAt,
    session?.runtimeUpdatedAt,
    getSessionRecencyTimestamp(session),
    entry?.slot?.startedAt,
  ];
  let winner = "";
  let winnerMs = Number.NEGATIVE_INFINITY;
  for (const value of candidates) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const parsedMs = Date.parse(normalized);
    if (!Number.isFinite(parsedMs)) continue;
    if (parsedMs >= winnerMs) {
      winner = normalized;
      winnerMs = parsedMs;
    }
  }
  return winner;
}

function getFleetEntryResponseAgeMs(entry) {
  const timestamp = getFleetEntryResponseTimestamp(entry);
  const parsedMs = Date.parse(String(timestamp || ""));
  if (!Number.isFinite(parsedMs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - parsedMs);
}

function getFleetEntryActivityLabel(entry) {
  const responsePath = resolveFleetEntrySessionId(entry) ? "stream" : "logs";
  const timestamp = getFleetEntryResponseTimestamp(entry);
  if (timestamp) {
    const prefix = isFleetEntryActive(entry)
      ? `Responding via ${responsePath}`
      : `Last ${responsePath} response`;
    return `${prefix} ${formatRelative(timestamp)}`;
  }
  if (isFleetEntryActive(entry)) return `Awaiting ${responsePath} response`;
  return "";
}

function getFleetEntryCanonicalKey(entry) {
  const sessionId = resolveFleetEntrySessionId(entry);
  if (sessionId) return `session:${sessionId}`;
  const taskId = String(entry?.slot?.taskId || entry?.session?.taskId || "").trim();
  if (taskId) return `task:${taskId}`;
  return String(entry?.key || "");
}

function compareFleetEntries(a, b) {
  const aActive = Number(isFleetEntryActive(a));
  const bActive = Number(isFleetEntryActive(b));
  if (aActive !== bActive) return bActive - aActive;
  const aResponseAgeMs = getFleetEntryResponseAgeMs(a);
  const bResponseAgeMs = getFleetEntryResponseAgeMs(b);
  const aResponding = Number(aActive && Number.isFinite(aResponseAgeMs) && aResponseAgeMs <= 2 * 60 * 1000);
  const bResponding = Number(bActive && Number.isFinite(bResponseAgeMs) && bResponseAgeMs <= 2 * 60 * 1000);
  if (aResponding !== bResponding) return bResponding - aResponding;
  const aHasTurns = Number(Number(a?.session?.turnCount || 0) > 0);
  const bHasTurns = Number(Number(b?.session?.turnCount || 0) > 0);
  if (aHasTurns !== bHasTurns) return bHasTurns - aHasTurns;
  const aResponseMs = Date.parse(String(getFleetEntryResponseTimestamp(a) || "")) || 0;
  const bResponseMs = Date.parse(String(getFleetEntryResponseTimestamp(b) || "")) || 0;
  if (aResponseMs !== bResponseMs) return bResponseMs - aResponseMs;
  const aRealSlot = Number(Boolean(a?.slot && !a?.slot?.synthetic));
  const bRealSlot = Number(Boolean(b?.slot && !b?.slot?.synthetic));
  if (aRealSlot !== bRealSlot) return bRealSlot - aRealSlot;
  return getFleetEntryTimestamp(b) - getFleetEntryTimestamp(a);
}

function dedupeFleetEntries(entries = []) {
  const deduped = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const canonicalKey = getFleetEntryCanonicalKey(entry);
    const existing = deduped.get(canonicalKey);
    if (!existing || compareFleetEntries(entry, existing) < 0) {
      deduped.set(canonicalKey, entry);
    }
  }
  return Array.from(deduped.values()).sort(compareFleetEntries);
}

function buildFleetStatusMeta(key, fallbackLabel = "Unknown") {
  const normalized = String(key || "").trim().toLowerCase();
  if (!normalized) {
    return { key: "unknown", label: fallbackLabel, tone: "historic", isActive: false };
  }
  if (["running", "busy", "active", "working", "inprogress"].includes(normalized)) {
    return { key: normalized, label: "Active", tone: "active", isActive: true };
  }
  if (normalized === "inreview") {
    return { key: normalized, label: "Review", tone: "warning", isActive: false };
  }
  if (["queued", "pending"].includes(normalized)) {
    return { key: normalized, label: normalized === "queued" ? "Queued" : "Pending", tone: "warning", isActive: false };
  }
  if (normalized === "recent") {
    return { key: "recent", label: "Recent", tone: "warning", isActive: false };
  }
  if (["idle", "paused", "waiting"].includes(normalized)) {
    return { key: normalized, label: formatFleetStateLabel(normalized), tone: "warning", isActive: false };
  }
  if (["blocked_by_env", "blocked", "error", "failed", "stalled", "stale", "aborted", "stop_requested"].includes(normalized)) {
    return { key: normalized, label: formatFleetStateLabel(normalized), tone: "error", isActive: false };
  }
  if (["done", "completed", "complete", "historic", "stopped"].includes(normalized)) {
    return { key: normalized, label: normalized === "historic" ? "Historic" : normalized === "stopped" ? "Not live" : "Completed", tone: "historic", isActive: false };
  }
  return { key: normalized, label: formatFleetStateLabel(normalized, fallbackLabel), tone: "historic", isActive: false };
}

function getFleetEntryStatusMeta(entry) {
  if (!entry || typeof entry !== "object") {
    return { key: "unknown", label: "Unknown", tone: "historic", isActive: false };
  }

  const slotStatus = String(entry?.slot?.status || "").trim().toLowerCase();
  const isSyntheticFallback = entry?.isTaskFallback || entry?.slot?.synthetic;
  const runtimeState = entry?.session ? getSessionRuntimeState(entry.session) : null;
  const lifecycleState = String(
    entry?.session?.lifecycleStatus
    || entry?.session?.lifecycle?.status
    || entry?.session?.status
    || "",
  ).trim().toLowerCase();
  if (isSyntheticFallback && !entry?.session) {
    if (slotStatus === "inreview") {
      return { key: slotStatus, label: "Review", tone: "warning", isActive: false };
    }
    return {
      key: slotStatus || "task_only",
      label: slotStatus ? formatFleetStateLabel(slotStatus) : "Task only",
      tone: "historic",
      isActive: false,
    };
  }
  if (runtimeState?.key && runtimeState.key !== "running") {
    return buildFleetStatusMeta(runtimeState.key, runtimeState.label || "Not live");
  }
  if (lifecycleState && !["active", "running", "busy", "inprogress"].includes(lifecycleState)) {
    return buildFleetStatusMeta(lifecycleState, "Not live");
  }
  if (slotStatus) {
    return buildFleetStatusMeta(slotStatus);
  }

  if (runtimeState?.key === "running") {
    return { key: "running", label: "Active", tone: "active", isActive: true };
  }
  if (runtimeState?.label) {
    return buildFleetStatusMeta(runtimeState.key || "unknown", runtimeState.label);
  }

  return {
    key: entry?.isHistory ? "historic" : "unknown",
    label: entry?.isHistory ? "Historic" : "Unknown",
    tone: "historic",
    isActive: false,
  };
}

function getFleetEntryTimestamp(entry) {
  return new Date(
    entry?.slot?.startedAt
    || entry?.session?.lastActiveAt
    || entry?.session?.updatedAt
    || entry?.session?.createdAt
    || entry?.session?.startedAt
    || 0,
  ).getTime() || 0;
}

function getFleetEntrySearchBlob(entry) {
  return [
    getFleetEntryTitle(entry),
    entry?.slot?.taskId,
    entry?.session?.taskId,
    entry?.session?.id,
    entry?.slot?.branch,
    entry?.session?.branch,
    entry?.slot?.status,
    entry?.session?.status,
  ]
    .map((part) => String(part || "").toLowerCase())
    .join(" ");
}

function getFleetEntryTokenUsage(entry) {
  const session = entry?.session || null;
  const tokenUsage = session?.insights?.tokenUsage || null;
  const totalTokens = Number(session?.totalTokens ?? tokenUsage?.totalTokens ?? 0);
  const inputTokens = Number(session?.inputTokens ?? tokenUsage?.inputTokens ?? 0);
  const outputTokens = Number(session?.outputTokens ?? tokenUsage?.outputTokens ?? 0);
  return {
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

function buildFleetEntryTokenTooltip(entry) {
  const usage = getFleetEntryTokenUsage(entry);
  const total = usage.totalTokens || (usage.inputTokens + usage.outputTokens);
  if (total <= 0) return "No token usage yet";
  const ratio = usage.outputTokens > 0
    ? `${(usage.inputTokens / Math.max(usage.outputTokens, 1)).toFixed(2)}:1 in/out`
    : "output pending";
  return `Input ${usage.inputTokens.toLocaleString()} · Output ${usage.outputTokens.toLocaleString()} · Total ${total.toLocaleString()} · ${ratio}`;
}

function renderFleetEntryTokenSplit(entry) {
  const usage = getFleetEntryTokenUsage(entry);
  const total = usage.totalTokens || (usage.inputTokens + usage.outputTokens);
  if (total <= 0) return null;
  return html`
    <${Tooltip} title=${buildFleetEntryTokenTooltip(entry)} arrow>
      <span class="fleet-slot-token-split" aria-label=${`Input ${usage.inputTokens} Output ${usage.outputTokens}`}>
        <span class="fleet-slot-token-segment"><strong>In</strong> ${formatCompactCount(usage.inputTokens)}</span>
        <span class="fleet-slot-token-divider">/</span>
        <span class="fleet-slot-token-segment"><strong>Out</strong> ${formatCompactCount(usage.outputTokens)}</span>
      </span>
    <//>
  `;
}

function getFleetEntryRelativeTime(entry) {
  const raw =
    entry?.slot?.startedAt
    || entry?.session?.lastActiveAt
    || entry?.session?.updatedAt
    || entry?.session?.createdAt
    || entry?.session?.startedAt;
  return raw ? formatRelative(raw) : "";
}

function isActiveSessionRecord(session) {
  if (!session || typeof session !== "object") return false;
  const runtimeState = getSessionRuntimeState(session);
  return runtimeState?.key === "running";
}

function getFleetEntryOriginLabel(entry) {
  if (entry?.isTaskFallback) return "Task only";
  if (entry?.slot && !entry?.slot?.synthetic) {
    return `Dedicated slot ${(entry.index ?? 0) + 1}`;
  }
  if (entry?.session && !entry?.slot) {
    return isFleetEntryActive(entry) ? "Session only" : "Session history";
  }
  return entry?.slot ? "Dedicated slot" : "Session";
}

function getFleetEntryMetaLabel(entry) {
  const identifier =
    entry?.slot?.taskId
    || entry?.session?.taskId
    || entry?.session?.id
    || "unknown";
  return `${getFleetEntryOriginLabel(entry)} · ${identifier}`;
}
/* ─── Workspace Viewer Modal ─── */
function WorkspaceViewer({ agent, onClose }) {
  const [logText, setLogText] = useState("Loading…");
  const [contextData, setContextData] = useState(null);
  const [steerInput, setSteerInput] = useState("");
  const [activeTab, setActiveTab] = useState("stream");
  const [streamPaused, setStreamPaused] = useState(false);
  const [streamFilter, setStreamFilter] = useState("all");
  const [streamSearch, setStreamSearch] = useState("");
  const [fileFilter, setFileFilter] = useState("all");
  const [fileSearch, setFileSearch] = useState("");
  const [streamSnapshot, setStreamSnapshot] = useState({
    events: [],
    fileAccess: null,
    capturedAt: null,
  });
  const [expandedEventItems, setExpandedEventItems] = useState(() => new Set());
  const [expandedFileItems, setExpandedFileItems] = useState(() => new Set());
  const [expandedModelResponse, setExpandedModelResponse] = useState(false);
  const logRef = useRef(null);

  const query = buildSessionLogQuery([
    agent.sessionId,
    agent.taskId,
    agent.branch,
  ]);
  const linkedSession =
    (sessionsData.value || []).find((s) => {
      if (!s) return false;
      const sid = String(s.id || "");
      const taskId = String(s.taskId || "");
      const branch = String(s.branch || "");
      return (
        (agent.sessionId && sid === String(agent.sessionId)) ||
        (agent.taskId && taskId === String(agent.taskId)) ||
        (agent.branch && branch === String(agent.branch))
      );
    }) || null;
  const sessionId =
    contextData?.session?.id || agent.sessionId || linkedSession?.id || null;

  useEffect(() => {
    if (!query) return;
    let active = true;

    const fetchLogs = () => {
      apiFetch(`/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=200`, { _silent: true })
        .then((res) => {
          if (!active) return;
          const data = res.data ?? res ?? "";
          const content =
            typeof data === "string"
              ? data
              : data?.content || data?.lines || data?.data || "";
          const text = Array.isArray(content)
            ? content.join("\n")
            : content || "";
          setLogText(text || "(no logs yet)");
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        })
        .catch(() => { if (active) setLogText("(failed to load logs)"); });
    };


    const fetchContext = () => {
      apiFetch(`/api/agent-context?query=${encodeURIComponent(query)}`, { _silent: true })
        .then((res) => { if (active) setContextData(res.data ?? res ?? null); })
        .catch(() => {});
    };

    fetchLogs();
    fetchContext();
    const interval = setInterval(() => {
      fetchLogs();
      fetchContext();
    }, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [query]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const fetchSession = () => {
      if (!active) return;
      loadSessionMessages(sessionId, { limit: 50 });
    };
    fetchSession();
    const interval = setInterval(fetchSession, 4000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    setStreamPaused(false);
    setStreamFilter("all");
    setStreamSearch("");
    setFileFilter("all");
    setFileSearch("");
    setStreamSnapshot({ events: [], fileAccess: null, capturedAt: null });
    setExpandedEventItems(new Set());
    setExpandedFileItems(new Set());
    setExpandedModelResponse(false);
  }, [query]);

  const handleStop = async () => {
    if (agent.index == null) return;
    const ok = await showConfirm(`Force-stop agent on "${truncate(agent.taskTitle || agent.taskId || "task", 40)}"?`);
    if (!ok) return;
    haptic("heavy");
    try {
      await apiFetch("/api/executor/stop-slot", {
        method: "POST",
        body: JSON.stringify({ slotIndex: agent.index, taskId: agent.taskId }),
      });
      showToast("Stop signal sent", "success");
      onClose();
      scheduleRefresh(200);
    } catch { /* toast via apiFetch */ }
  };

  const handleSteer = () => {
    if (!steerInput.trim()) return;
    sendCommandToChat(`/steer ${steerInput.trim()}`);
    showToast("Steer command sent", "success");
    setSteerInput("");
  };

  const copyToClipboard = (text, successMessage) => {
    if (!text) return;
    if (!navigator?.clipboard?.writeText) {
      showToast("Clipboard unavailable", "error");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(successMessage || "Copied", "success"))
      .catch(() => showToast("Copy failed", "error"));
  };

  const downloadText = (filename, content) => {
    if (!content) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const toggleExpandedEvent = useCallback((key) => {
    if (!key) return;
    setExpandedEventItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleExpandedFile = useCallback((key) => {
    if (!key) return;
    setExpandedFileItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toMultilineText = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const toSingleLinePreview = (value, limit = 220) => {
    const compact = String(value || "").replace(/\s+/g, " ").trim();
    if (!compact) return "";
    return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
  };

  const isModelResponseMessage = (msg) => {
    if (!msg) return false;
    const role = String(msg.role || "").toLowerCase();
    const type = String(msg.type || "").toLowerCase();
    if (role === "assistant") return true;
    if (
      type === "agent_message" ||
      type === "assistant" ||
      type === "assistant_message"
    ) {
      return true;
    }
    if (role) return false;
    if (!msg.content) return false;
    return ![
      "tool_call",
      "tool_result",
      "tool_output",
      "error",
      "stream_error",
      "system",
      "user",
    ].includes(type);
  };

  const renderChanges = () => {
    const ctx = contextData?.context;
    const matches = contextData?.matches || {};
    const diagnostics = contextData?.diagnostics || {};
    const sessionInfo = contextData?.session || null;
    const slotInfo = contextData?.slot || null;
    const actionHistory = contextData?.actionHistory || contextData?.toolHistory || [];
    const fileAccess = contextData?.fileAccessSummary || null;
    const fileAccessFiles = fileAccess?.files || [];
    const streamMessages = String(sessionMessagesSessionId.value || "") === String(sessionId || "")
      ? (sessionMessages.value || [])
      : [];
    const latestModelResponse =
      streamMessages
        .slice()
        .reverse()
        .find((msg) => isModelResponseMessage(msg)) || null;
    const latestModelResponseText = latestModelResponse
      ? toMultilineText(latestModelResponse.content || "")
      : "";
    const rawToolEvents = streamMessages
      .filter((msg) => msg?.type === "tool_call" || msg?.type === "tool_result" || msg?.type === "error")
      .slice(-200)
      .map((evt, index) => ({
        ...evt,
        _id: evt?.id || `${evt?.type || "evt"}-${evt?.timestamp || evt?.createdAt || index}`,
      }));
    const liveToolEvents = rawToolEvents.slice().reverse();
    const liveFileAccess = (() => {
      const map = new Map();
      const counts = { read: 0, write: 0, other: 0 };
      const filePattern = /([a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql))/g;
      const classify = (detail) => {
        const lowered = String(detail || "").toLowerCase();
        if (lowered.includes("apply_patch") || lowered.includes("write")) return "write";
        if (/\b(rg|cat|sed|ls|stat|head|tail|grep|find)\b/.test(lowered)) return "read";
        return "other";
      };
      const addFile = (path, kind) => {
        if (!path) return;
        const entry = map.get(path) || { path, kinds: new Set() };
        if (!entry.kinds.has(kind)) {
          entry.kinds.add(kind);
          if (counts[kind] != null) counts[kind] += 1;
          else counts.other += 1;
        }
        map.set(path, entry);
      };
      for (const evt of rawToolEvents) {
        if (!evt?.content) continue;
        const kind = classify(evt.content);
        const matches = evt.content.matchAll(filePattern);
        for (const match of matches) {
          addFile(match?.[1], kind);
        }
      }
      for (const changed of fileAccessFiles) {
        if (changed?.path) addFile(changed.path, "write");
      }
      if (map.size === 0) return null;
      return {
        files: Array.from(map.values()).map((entry) => ({
          path: entry.path,
          kinds: Array.from(entry.kinds),
        })),
        counts,
      };
    })();
    const toolEvents = streamPaused ? streamSnapshot.events : liveToolEvents;
    const snapshotMeta = streamPaused ? streamSnapshot.capturedAt : null;

    const formatReason = (reason) => {
      const map = {
        "no-matching-slots-or-worktrees": "No matching active slots or worktrees found.",
        "no-session-match": "No matching session found.",
        "no-worktree-match": "No matching worktree found.",
        "worktree-path-missing": "Matched worktree path missing or inaccessible.",
      };
      return map[reason] || reason;
    };

    const renderMatchList = (title, items, renderItem) => {
      if (!items || items.length === 0) return null;
      return html`
        <div class="card mb-sm">
          <div class="card-title">${title}</div>
          ${items.map((item, i) => html`
            <div class="meta-text" key=${i}>
              ${renderItem(item)}
            </div>
          `)}
        </div>
      `;
    };

    const hasMatches =
      (matches.worktrees && matches.worktrees.length > 0) ||
      (matches.slots && matches.slots.length > 0) ||
      (matches.sessions && matches.sessions.length > 0);
    const hasActions = actionHistory.length > 0 || toolEvents.length > 0;
    const hasFileAccess = fileAccessFiles.length > 0 || liveFileAccess?.files?.length > 0;
    const showUnavailable =
      !ctx &&
      !sessionInfo &&
      !slotInfo &&
      !hasMatches &&
      !hasActions &&
      !hasFileAccess;

    if (showUnavailable) {
      const reasons = diagnostics?.reasons || [];
      const hints = diagnostics?.hints || [];
      return html`
        <div class="workspace-context">
          <div class="card mb-sm">
            <div class="card-title">Workspace Context Unavailable</div>
            <div class="meta-text">Query: ${contextData?.query || query || "unknown"}</div>
            ${reasons.length > 0 &&
              html`<div class="meta-text mt-xs">
                ${reasons.map((r) => formatReason(r)).join(" ")}
              </div>`}
            ${hints.length > 0 &&
              html`<div class="meta-text mt-xs">
                ${hints.join(" ")}
              </div>`}
            ${(diagnostics?.searched?.activeSlots != null ||
              diagnostics?.searched?.activeWorktrees != null ||
              diagnostics?.searched?.sessions != null) &&
              html`<div class="meta-text mt-xs">
                Searched: ${diagnostics?.searched?.activeSlots ?? 0} slots · ${diagnostics?.searched?.activeWorktrees ?? 0} worktrees · ${diagnostics?.searched?.sessions ?? 0} sessions
              </div>`}
          </div>

          ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
            html`<span class="mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
          ${renderMatchList("Slot Matches", matches.slots, (slot) =>
            html`<span class="mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
          ${renderMatchList("Session Matches", matches.sessions, (sess) =>
            html`<span class="mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}

          ${sessionInfo && html`
            <div class="card mb-sm">
              <div class="card-title">Session</div>
              <div class="meta-text">
                <span class="mono">${sessionInfo.id || sessionInfo.taskId}</span>
                ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
              </div>
              ${sessionInfo.preview &&
                html`<div class="meta-text mt-xs">${truncate(sessionInfo.preview, 120)}</div>`}
              <${Button} variant="text" size="small" onClick=${() => setActiveTab("stream")}>
                ${iconText(":chat: View Stream")}
              <//>
            </div>
          `}
        </div>
      `;
    }

    const renderActionHistory = () => {
      if (!sessionInfo && actionHistory.length === 0) return null;
      return html`
        <div class="card mb-sm">
          <div class="card-title">Action History</div>
          ${actionHistory.length === 0 &&
            html`<div class="meta-text">No recent tool actions recorded</div>`}
          ${actionHistory.map((action, i) => {
            const label =
              action.type === "tool_result"
                ? "RESULT"
                : action.tool || "TOOL";
            const detail = action.detail || action.content || "";
            return html`
              <div class="meta-text" key=${i}>
                <span class="mono">${label}</span>
                ${detail ? ` ${truncate(detail, 140)}` : ""}
                ${action.timestamp ? ` · ${formatRelative(action.timestamp)}` : ""}
              </div>
            `;
          })}
        </div>
      `;
    };

    const renderLiveToolEvents = () => {
      if (!sessionInfo && toolEvents.length === 0) return null;
      const counts = toolEvents.reduce(
        (acc, evt) => {
          acc.all += 1;
          if (evt.type === "tool_result") acc.result += 1;
          else if (evt.type === "error") acc.error += 1;
          else acc.tool += 1;
          return acc;
        },
        { all: 0, tool: 0, result: 0, error: 0 },
      );
      const search = streamSearch.trim().toLowerCase();
      const filteredEvents = toolEvents.filter((evt) => {
        if (streamFilter !== "all") {
          if (streamFilter === "tool" && evt.type !== "tool_call") return false;
          if (streamFilter === "result" && evt.type !== "tool_result") return false;
          if (streamFilter === "error" && evt.type !== "error") return false;
        }
        if (!search) return true;
        const haystack = `${evt.tool || ""} ${evt.content || ""} ${evt.detail || ""}`
          .toLowerCase();
        return haystack.includes(search);
      });
      const exportText = filteredEvents.map((evt) => {
        const label = evt.type === "tool_result" ? "RESULT" : evt.type === "error" ? "ERROR" : "TOOL";
        const ts = evt.timestamp || evt.createdAt || "";
        const tool = evt.tool ? ` ${evt.tool}` : "";
        const body = evt.content || evt.detail || "";
        return `${ts ? `[${ts}] ` : ""}${label}${tool} ${body}`.trim();
      }).join("\n");
      const toolLabel = (type) => (
        type === "tool_result" ? "RESULT" : type === "error" ? "ERROR" : "TOOL"
      );
      return html`
        <div class="card mb-sm">
          <div class="card-title">Live Tool/Event Stream</div>
          <div class="stream-toolbar">
            <div class="chip-group stream-chips">
              <${Button} variant="text" size="small"
                onClick=${() => setStreamFilter("all")}
              >
                All (${counts.all})
              <//>
              <${Chip} label=${`Tool (${counts.tool})`} size="small"
                onClick=${() => setStreamFilter("tool")}
                color=${streamFilter === "tool" ? "primary" : "default"}
                variant=${streamFilter === "tool" ? "filled" : "outlined"}
              />
              <${Chip} label=${`Result (${counts.result})`} size="small"
                onClick=${() => setStreamFilter("result")}
                color=${streamFilter === "result" ? "primary" : "default"}
                variant=${streamFilter === "result" ? "filled" : "outlined"}
              />
              <${Chip} label=${`Error (${counts.error})`} size="small"
                onClick=${() => setStreamFilter("error")}
                color=${streamFilter === "error" ? "primary" : "default"}
                variant=${streamFilter === "error" ? "filled" : "outlined"}
              />
            </div>
            <div class="stream-actions">
              <div class="stream-search">
                <span class="icon-inline">${ICONS.search}</span>
                <${TextField}
                  size="small"
                  placeholder="Filter events..."
                  value=${streamSearch}
                  onInput=${(e) => setStreamSearch(e.target.value)}
                />
              </div>
              <${Button} variant="text" size="small" onClick=${() => {
                if (!streamPaused) {
                  setStreamSnapshot({
                    events: liveToolEvents,
                    fileAccess: liveFileAccess,
                    capturedAt: new Date().toISOString(),
                  });
                  setStreamPaused(true);
                } else {
                  setStreamPaused(false);
                  setStreamSnapshot({ events: [], fileAccess: null, capturedAt: null });
                }
              }}>
                ${iconText(streamPaused ? ":play: Resume" : ":pause: Pause")}
              <//>
              <${Button} variant="text" size="small"
                onClick=${() => copyToClipboard(exportText, "Stream copied")}
                disabled=${filteredEvents.length === 0}
              >
                <span class="icon-inline">${ICONS.copy}</span> Copy
              <//>
              <${Button} variant="text" size="small"
                onClick=${() => downloadText(
                  `tool-stream-${agent.taskId || agent.branch || "agent"}.txt`,
                  exportText,
                )}
                disabled=${filteredEvents.length === 0}
              >
                <span class="icon-inline">${ICONS.download}</span> Export
              <//>
            </div>
          </div>
          ${streamPaused && snapshotMeta &&
            html`<div class="meta-text mt-xs">Paused at ${snapshotMeta}</div>`}
          ${latestModelResponseText &&
            html`
              <div class="stream-final-response ${expandedModelResponse ? "expanded" : ""}">
                <${Button} variant="text" size="small"
                  className="stream-item-toggle stream-item-toggle-final"
                  onClick=${() => setExpandedModelResponse((prev) => !prev)}
                >
                  <div class="stream-item-header">
                    <span class="stream-tag stream-tag-model">MODEL</span>
                    <span class="stream-item-title">Latest model response</span>
                    ${latestModelResponse?.timestamp &&
                      html`<span class="stream-item-time">
                        ${formatRelative(latestModelResponse.timestamp)}
                      </span>`}
                  </div>
                  <div class="stream-item-preview">
                    ${toSingleLinePreview(latestModelResponseText, 260)}
                  </div>
                  <span class="stream-item-chevron">${expandedModelResponse ? "▾" : "▸"}</span>
                <//>
                <div class="stream-item-details ${expandedModelResponse ? "expanded" : ""}">
                  <div class="stream-item-details-inner">
                    <pre class="stream-item-pre">${latestModelResponseText}</pre>
                  </div>
                </div>
              </div>
            `}
          ${filteredEvents.length === 0 &&
            html`<div class="stream-empty">
              <div class="stream-empty-icon">${resolveIcon(":server:")}</div>
              <div class="stream-empty-text">
                ${toolEvents.length === 0 ? "No tool events yet" : "No events match filters"}
              </div>
            </div>`}
          ${filteredEvents.length > 0 &&
            html`<div class="stream-list">
              ${filteredEvents.map((evt) => {
                const rowKey = evt._id;
                const bodyText = toMultilineText(evt.content || evt.detail || "");
                const hasBody = bodyText.trim().length > 0;
                const expanded = rowKey ? expandedEventItems.has(rowKey) : false;
                return html`
                  <div class="stream-item stream-${evt.type} ${expanded ? "expanded" : ""}" key=${rowKey}>
                    <${Button} variant="text" size="small"
                      className="stream-item-toggle"
                      onClick=${() => hasBody && toggleExpandedEvent(rowKey)}
                      disabled=${!hasBody}
                    >
                      <div class="stream-item-header">
                        <span class="stream-tag stream-tag-${evt.type}">
                          ${toolLabel(evt.type)}
                        </span>
                        ${evt.tool && html`<span class="stream-item-tool mono">${evt.tool}</span>`}
                        <span class="stream-item-title">
                          ${toSingleLinePreview(bodyText, 240) || "No details"}
                        </span>
                        ${evt.timestamp && html`<span class="stream-item-time">${formatRelative(evt.timestamp)}</span>`}
                      </div>
                      ${hasBody && html`<span class="stream-item-chevron">${expanded ? "▾" : "▸"}</span>`}
                    <//>
                    ${hasBody && html`
                      <div class="stream-item-details ${expanded ? "expanded" : ""}">
                        <div class="stream-item-details-inner ${bodyText.length > 1600 ? "stream-item-details-scroll" : ""}">
                          <pre class="stream-item-pre">${bodyText}</pre>
                        </div>
                      </div>
                    `}
                  </div>
                `;
              })}
            </div>`}
        </div>
      `;
    };

    const renderFileAccess = () => {
      if (!sessionInfo && !fileAccess && !liveFileAccess) return null;
      const summarySource = (streamPaused ? streamSnapshot.fileAccess : liveFileAccess) || fileAccess;
      const summaryCounts = summarySource?.counts || {};
      const summaryFiles = summarySource?.files || [];
      const counts = {
        read: summaryCounts.read ?? summaryFiles.filter((f) => f.kinds?.includes("read")).length,
        write: summaryCounts.write ?? summaryFiles.filter((f) => f.kinds?.includes("write")).length,
        other: summaryCounts.other ?? summaryFiles.filter((f) => f.kinds?.includes("other")).length,
      };
      const search = fileSearch.trim().toLowerCase();
      const filteredFiles = summaryFiles.filter((entry) => {
        if (fileFilter !== "all" && !entry.kinds?.includes(fileFilter)) return false;
        if (!search) return true;
        return entry.path?.toLowerCase().includes(search);
      });
      const exportText = filteredFiles.map((entry) => {
        const kinds = entry.kinds?.length ? ` (${entry.kinds.join(", ")})` : "";
        return `${entry.path}${kinds}`;
      }).join("\n");
      return html`
        <div class="card mb-sm">
          <div class="card-title">File Access</div>
          <div class="stream-toolbar">
            <div class="chip-group stream-chips">
              <${Chip} label=${`All (${summaryFiles.length})`} size="small"
                onClick=${() => setFileFilter("all")}
                color=${fileFilter === "all" ? "primary" : "default"}
                variant=${fileFilter === "all" ? "filled" : "outlined"}
              />
              <${Chip} label=${`Read (${counts.read})`} size="small"
                onClick=${() => setFileFilter("read")}
                color=${fileFilter === "read" ? "primary" : "default"}
                variant=${fileFilter === "read" ? "filled" : "outlined"}
              />
              <${Chip} label=${`Write (${counts.write})`} size="small"
                onClick=${() => setFileFilter("write")}
                color=${fileFilter === "write" ? "primary" : "default"}
                variant=${fileFilter === "write" ? "filled" : "outlined"}
              />
              <${Chip} label=${`Other (${counts.other})`} size="small"
                onClick=${() => setFileFilter("other")}
                color=${fileFilter === "other" ? "primary" : "default"}
                variant=${fileFilter === "other" ? "filled" : "outlined"}
              />
            </div>
            <div class="stream-actions">
              <div class="stream-search">
                <span class="icon-inline">${ICONS.search}</span>
                <${TextField}
                  size="small"
                  placeholder="Filter files..."
                  value=${fileSearch}
                  onInput=${(e) => setFileSearch(e.target.value)}
                />
              </div>
              <${Button} variant="text" size="small"
                onClick=${() => copyToClipboard(exportText, "File list copied")}
                disabled=${filteredFiles.length === 0}
              >
                <span class="icon-inline">${ICONS.copy}</span> Copy
              <//>
              <${Button} variant="text" size="small"
                onClick=${() => downloadText(
                  `file-access-${agent.taskId || agent.branch || "agent"}.txt`,
                  exportText,
                )}
                disabled=${filteredFiles.length === 0}
              >
                <span class="icon-inline">${ICONS.download}</span> Export
              <//>
            </div>
          </div>
          <div class="meta-text">
            ${counts.read} read · ${counts.write} written · ${counts.other} other
          </div>
          ${streamPaused && snapshotMeta &&
            html`<div class="meta-text mt-xs">Paused at ${snapshotMeta}</div>`}
          ${filteredFiles.length === 0 &&
            html`<div class="stream-empty">
              <div class="stream-empty-icon">${resolveIcon(":folder:")}</div>
              <div class="stream-empty-text">
                ${summaryFiles.length === 0 ? "No file access recorded" : "No files match filters"}
              </div>
            </div>`}
          ${filteredFiles.length > 0 &&
            html`<div class="stream-list">
              ${filteredFiles.map((entry) => {
                const rowKey = `${entry.path || "unknown"}::${(entry.kinds || []).join(",")}`;
                const expanded = expandedFileItems.has(rowKey);
                const details = [
                  `Path: ${entry.path || "unknown"}`,
                  entry.kinds?.length
                    ? `Access kinds: ${entry.kinds.join(", ")}`
                    : "Access kinds: unknown",
                ].join("\n");
                return html`
                  <div class="stream-item stream-file ${expanded ? "expanded" : ""}" key=${rowKey}>
                    <${Button} variant="text" size="small"
                      className="stream-item-toggle"
                      onClick=${() => toggleExpandedFile(rowKey)}
                    >
                      <div class="stream-item-header">
                        <span class="stream-tag stream-tag-file">FILE</span>
                        <span class="stream-item-title mono">${entry.path}</span>
                      </div>
                      <span class="stream-item-chevron">${expanded ? "▾" : "▸"}</span>
                    <//>
                    <div class="stream-item-details ${expanded ? "expanded" : ""}">
                      <div class="stream-item-details-inner">
                        <pre class="stream-item-pre">${details}</pre>
                      </div>
                    </div>
                  </div>
                `;
              })}
            </div>`}
        </div>
      `;
    };

    const files = ctx?.changedFiles || [];
    const commits = ctx?.recentCommits || [];
    const aheadBehind = ctx?.gitAheadBehind || "";
    return html`
      <div class="workspace-context">
        ${ctx && html`
          <div class="card mb-sm">
            <div class="card-title">Branch</div>
            <div class="meta-text">${ctx.gitBranch || agent.branch || "unknown"}</div>
            <div class="meta-text mt-xs">${ctx.path || "unknown path"}</div>
            ${aheadBehind &&
              html`<div class="meta-text mt-xs">Ahead/Behind: ${aheadBehind}</div>`}
          </div>
        `}
        ${sessionInfo && html`
          <div class="card mb-sm">
            <div class="card-title">Session</div>
            <div class="meta-text">
              <span class="mono">${sessionInfo.id || sessionInfo.taskId}</span>
              ${sessionInfo.status ? ` · ${sessionInfo.status}` : ""}
            </div>
            ${sessionInfo.lastActiveAt &&
              html`<div class="meta-text mt-xs">Last Active: ${sessionInfo.lastActiveAt}</div>`}
            ${sessionInfo.preview &&
              html`<div class="meta-text mt-xs">${truncate(sessionInfo.preview, 140)}</div>`}
            <${Button} variant="text" size="small" className="mt-sm" onClick=${() => setActiveTab("stream")}>
              ${iconText(":chat: View Stream")}
            <//>
          </div>
        `}
        ${slotInfo && html`
          <div class="card mb-sm">
            <div class="card-title">Active Slot</div>
            <div class="meta-text">
              ${slotInfo.taskTitle || slotInfo.taskId || "slot"}
              ${slotInfo.status ? ` · ${slotInfo.status}` : ""}
            </div>
            ${slotInfo.branch &&
              html`<div class="meta-text mt-xs">Branch: ${slotInfo.branch}</div>`}
          </div>
        `}
        ${renderActionHistory()}
        ${renderLiveToolEvents()}
        ${renderFileAccess()}
        ${renderMatchList("Worktree Matches", matches.worktrees, (wt) =>
          html`<span class="mono">${wt.name || wt.branch || "worktree"}</span> ${wt.path ? `· ${wt.path}` : ""}`)}
        ${renderMatchList("Slot Matches", matches.slots, (slot) =>
          html`<span class="mono">${slot.taskId || slot.taskTitle || "slot"}</span> ${slot.branch ? `· ${slot.branch}` : ""}`)}
        ${renderMatchList("Session Matches", matches.sessions, (sess) =>
          html`<span class="mono">${sess.id || sess.taskId || "session"}</span> ${sess.status ? `· ${sess.status}` : ""}`)}
        ${commits.length > 0 &&
        html`
          <div class="card mb-sm">
            <div class="card-title">Recent Commits</div>
            ${commits.map(
              (cm) => html`
                <div class="meta-text" key=${cm.hash}>
                  <span class="mono">${cm.hash}</span> ${cm.message || ""} ${cm.time ? `· ${cm.time}` : ""}
                </div>
              `,
            )}
          </div>
        `}
        ${ctx && html`
          <div class="card mb-sm">
            <div class="card-title">Changed Files</div>
            ${files.length === 0 &&
            html`<div class="meta-text">Clean working tree</div>`}
            ${files.map(
              (f) => html`
                <div class="meta-text" key=${f.file}>
                  <span class="mono">${f.code}</span> ${f.file}
                </div>
              `,
            )}
          </div>
        `}
        ${ctx?.diffSummary &&
        html`
          <div class="card">
            <div class="card-title">Diff Summary</div>
            <pre class="workspace-diff">${ctx.diffSummary}</pre>
          </div>
        `}
      </div>
    `;
  };

  return html`
    <div class="modal-overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal-content modal-content-wide workspace-modal-content">
        <div class="modal-handle" />
        <div class="workspace-viewer">
          <div class="workspace-header">
            <div>
              <div class="task-card-title">
                <${StatusDot} status=${agent.status || "busy"} />
                ${agent.taskTitle || "(no title)"}
              </div>
              <div class="task-card-meta">
                ${agent.branch || "?"} · Slot ${(agent.index ?? 0) + 1} · ${formatDuration(agent.startedAt)}
              </div>
            </div>
            <${IconButton} size="small" onClick=${onClose}>${resolveIcon("✕")}<//>
          </div>
          <div class="session-detail-tabs workspace-tabs">
            <${Button} variant="text" size="small"
              className=${`session-detail-tab ${activeTab === "stream" ? "active" : ""}`}
              onClick=${() => setActiveTab("stream")}
            >${iconText(":chat: Stream")}<//>
            <${Button} variant="text" size="small"
              className=${`session-detail-tab ${activeTab === "changes" ? "active" : ""}`}
              onClick=${() => setActiveTab("changes")}
            >${iconText(":edit: Changes")}<//>
            <${Button} variant="text" size="small"
              className=${`session-detail-tab ${activeTab === "logs" ? "active" : ""}`}
              onClick=${() => setActiveTab("logs")}
            >${iconText(":file: Logs")}<//>
          </div>

          <div class="workspace-body">
            ${activeTab === "stream" &&
            html`
              ${sessionId
                ? html`<${ChatView} sessionId=${sessionId} readOnly=${true} />`
                : html`
                    <div class="chat-view chat-empty-state">
                      <div class="session-empty-icon">${resolveIcon(":chat:")}</div>
                      <div class="session-empty-text">No session stream available</div>
                    </div>
                  `}
            `}
            ${activeTab === "changes" && renderChanges()}
            ${activeTab === "logs" &&
            html`<div class="workspace-log" ref=${logRef}>${logText}</div>`}
          </div>

          <div class="workspace-controls">
            <${TextField}
              size="small"
              variant="outlined"
              fullWidth
              placeholder="Steer agent…"
              value=${steerInput}
              onInput=${(e) => setSteerInput(e.target.value)}
              onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); handleSteer(); } }}
            />
            <${Button} variant="contained" color="primary" size="small" onClick=${handleSteer}>${resolveIcon(":target:")}<//>
            <${Button} variant="contained" color="error" size="small"
              disabled=${agent.index == null}
              onClick=${handleStop}
            >${iconText(":ban: Stop")}<//>
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ─── Dispatch Section ─── */
function DispatchSection({ freeSlots, inputRef, className = "" }) {
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dispatching, setDispatching] = useState(false);
  const [taskChoices, setTaskChoices] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const latestTaskRequestRef = useRef(0);
  const mountedRef = useRef(true);

  const canDispatch = Boolean(taskId.trim() || prompt.trim());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDispatchTasks = useCallback(() => {
    const requestId = latestTaskRequestRef.current + 1;
    latestTaskRequestRef.current = requestId;
    setTasksLoading(true);
    apiFetch("/api/tasks?page=0&pageSize=200", { _silent: true })
      .then((res) => {
        if (!mountedRef.current || latestTaskRequestRef.current !== requestId) return;
        const choices = normalizeDispatchTaskChoices(res?.data);
        setTaskChoices(choices);
      })
      .catch(() => {
        if (!mountedRef.current || latestTaskRequestRef.current !== requestId) return;
        setTaskChoices([]);
      })
      .finally(() => {
        if (!mountedRef.current || latestTaskRequestRef.current !== requestId) return;
        setTasksLoading(false);
      });
  }, []);

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      loadDispatchTasks();
    };
    tick();
    const interval = setInterval(tick, 12000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [loadDispatchTasks]);

  const handleDispatch = async () => {
    if (!canDispatch || dispatching) return;
    haptic();
    setDispatching(true);
    try {
      const body = taskId.trim()
        ? { taskId: taskId.trim() }
        : { prompt: prompt.trim() };
      const res = await apiFetch("/api/executor/dispatch", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.ok !== false) {
        showToast("Dispatch started", "success");
        setTaskId("");
        setPrompt("");
        loadDispatchTasks();
        scheduleRefresh(200);
      }
    } catch {
      /* toast via apiFetch */
    } finally {
      setDispatching(false);
    }
  };

  return html`
    <${Card}
      title="Dispatch"
      subtitle="Start a dedicated agent with a backlog task or focused prompt"
      className=${className}
    >
      <div class="dispatch-section">
        <div class="meta-text mb-sm">
          ${freeSlots > 0
            ? `${freeSlots} slot${freeSlots > 1 ? "s" : ""} currently free`
            : "All slots are active — dispatch still creates a dedicated agent"}
        </div>
        <div class="input-row">
          <${Select}
            size="small"
            fullWidth
            aria-label="Task"
            value=${taskId}
            ref=${inputRef}
            onChange=${(e) => { setTaskId(e.target.value); if (e.target.value) setPrompt(""); }}
            displayEmpty
          >
            <${MenuItem} value="">
              ${tasksLoading ? "Loading tasks…" : "Select backlog or draft task"}
            <//>
            ${taskChoices.map((task, i) => html`
              <${MenuItem} key=${`${task.id}-${i}`} value=${task.id}>
                ${formatTaskOptionLabel(task)}
              <//>
            `)}
          <//>
        </div>
        <div class="divider-label">or</div>
        <${TextField}
          size="small"
          multiline
          rows=${2}
          fullWidth
          placeholder="Freeform prompt…"
          value=${prompt}
          onInput=${(e) => { setPrompt(e.target.value); if (e.target.value) setTaskId(""); }}
        />
        <${Button} variant="contained" color="primary"
          disabled=${!canDispatch || dispatching}
          onClick=${handleDispatch}
        >
          ${dispatching ? "Dispatching…" : iconText(":rocket: Dispatch")}
        <//>
      </div>
    <//>
  `;
}

/* ─── AgentsTab ─── */
export function AgentsTab() {
  const executor = executorData.value;
  const agents = agentsData?.value || [];
  const status = statusData.value || null;
  const telemetry = telemetrySummary.value || null;
  const execData = executor?.data;
  const harnessStatus = status?.harness || null;
  const harnessTelemetry = telemetry?.harness || null;
  const workspaceSummary = execData?.workspaceSummary || null;
  const globalSlots = execData?.slots || [];
  const slots = workspaceSummary?.slots || globalSlots;
  const globalMaxParallel = execData?.maxParallel || (globalSlots.length || 0);
  const maxParallel = Number(
    workspaceSummary?.maxParallel
    || globalMaxParallel
    || slots.length
    || 0,
  ) || 0;
  const configuredSlots = Math.max(0, Number(workspaceSummary?.configuredSlots || 0) || 0);
  const activeWorkflowRuns = Math.max(0, Number(execData?.activeWorkflowRuns || 0) || 0);
  const derivedActiveSlots = slots.filter((slot) => {
    const status = String(slot?.status || "").toLowerCase();
    return status === "running" || status === "busy";
  }).length;
  const activeSlots = slots.length ? derivedActiveSlots : (workspaceSummary?.activeSlots || 0);

  const [expandedSlot, setExpandedSlot] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [fleetSearch, setFleetSearch] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  const [harnessFilter, setHarnessFilter] = useState("attention");
  const [harnessActionByRun, setHarnessActionByRun] = useState({});
  const [focusedHarnessRunId, setFocusedHarnessRunId] = useState("");
  const [focusedHarnessSource, setFocusedHarnessSource] = useState("");
  const [agentEventStatus, setAgentEventStatus] = useState(null);
  const [agentLiveness, setAgentLiveness] = useState([]);
  const [agentErrorPatterns, setAgentErrorPatterns] = useState([]);
  const [agentRecentEvents, setAgentRecentEvents] = useState([]);
  const [fleetSessionsSnapshot, setFleetSessionsSnapshot] = useState([]);
  const [isCompact, setIsCompact] = useState(() => {
    try { return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false; }
    catch { return false; }
  });
  const dispatchInputRef = useRef(null);
  const workspaceTarget = agentWorkspaceTarget.value;
  const activeWorkspace = (managedWorkspaces.value || []).find(
    (entry) => String(entry?.id || "").trim() === String(activeWorkspaceId.value || "").trim(),
  ) || null;
  const activeWorkspaceExecutors = activeWorkspace?.executors || null;
  const harnessRouteParams = routeParams.value || {};
  const routeHarnessRunId = String(harnessRouteParams?.harnessRunId || "").trim();
  const routeHarnessSource = String(harnessRouteParams?.harnessSource || "").trim();

  const filteredSlots = useMemo(() => {
    const q = fleetSearch.trim().toLowerCase();
    if (!q) return slots;
    return slots.filter((slot, i) => {
      const blob = getFleetEntrySearchBlob({ slot, session: null });
      return blob.includes(q);
    });
  }, [slots, fleetSearch]);

  const allSessions = fleetSessionsSnapshot;
  const slotTaskIds = new Set(
    slots.map((slot) => String(slot?.taskId || "").trim()).filter(Boolean),
  );
  const slotSessionIds = new Set(
    slots.flatMap((slot) => [
      String(slot?.sessionId || "").trim(),
      String(slot?.taskId || "").trim(),
    ].filter(Boolean)),
  );
  const activeSessions = allSessions.filter((session) => isActiveSessionRecord(session));
  const activeSessionCount = activeSessions.length;
  const activeSessionOnlyCount = activeSessions.filter((session) => {
    const sessionId = String(session?.id || "").trim();
    const taskId = String(session?.taskId || "").trim();
    if (sessionId && slotSessionIds.has(sessionId)) return false;
    if (taskId && (slotTaskIds.has(taskId) || slotSessionIds.has(taskId))) return false;
    return true;
  }).length;
  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return allSessions;
    return allSessions.filter((s) => {
      const blob = [
        s?.title, s?.taskTitle, s?.id, s?.taskId, s?.branch, s?.status,
      ].map((p) => String(p || "").toLowerCase()).join(" ");
      return blob.includes(q);
    });
  }, [allSessions, sessionSearch]);

  useEffect(() => {
    const current = selectedSessionId.value;
    const sessions = sessionsData.value || [];
    if (current || sessions.length === 0) return;
    const activeSession =
      sessions.find((s) => isActiveSessionRecord(s)) ||
      sessions[0];
    if (activeSession?.id) {
      selectedSessionId.value = activeSession.id;
    }
  }, [sessionsData.value, selectedSessionId.value]);

  useEffect(() => {
    let active = true;
    const refreshTaskSessions = async () => {
      if (!active || document.hidden) return;
      const sessions = await loadSessions({ type: "task", workspace: "all" });
      if (!active) return;
      if (Array.isArray(sessions)) {
        setFleetSessionsSnapshot(sessions);
      }
    };
    void refreshTaskSessions();
    const interval = setInterval(refreshTaskSessions, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!workspaceTarget) return;
    const slotIndex = slots.findIndex((s) => {
      const targetTask = workspaceTarget.taskId || "";
      const targetBranch = workspaceTarget.branch || "";
      return (
        (targetTask && s.taskId === targetTask) ||
        (targetBranch && s.branch === targetBranch)
      );
    });
    if (slotIndex >= 0) {
      setSelectedAgent({
        ...slots[slotIndex],
        index: resolveFleetSlotIndex(slots[slotIndex], slotIndex),
      });
    } else {
      setSelectedAgent({
        taskId: workspaceTarget.taskId || null,
        taskTitle: workspaceTarget.taskTitle || workspaceTarget.branch || "Workspace",
        branch: workspaceTarget.branch || null,
        status: "idle",
        index: null,
      });
    }
    agentWorkspaceTarget.value = null;
  }, [workspaceTarget, slots]);

  useEffect(() => {
    if (!routeHarnessRunId) return;
    setFocusedHarnessRunId(routeHarnessRunId);
    setFocusedHarnessSource(routeHarnessSource || "workflow approvals");
    setRouteParams({}, { replace: true, skipGuard: true });
  }, [routeHarnessRunId, routeHarnessSource]);

  useEffect(() => {
    let cancelled = false;
    const loadAgentMonitor = async () => {
      if (cancelled || document.hidden) return;
      try {
        const [statusPayload, livenessPayload, errorPayload, recentEventsPayload] = await Promise.all([
          apiFetch("/api/agents/events/status"),
          apiFetch("/api/agents/events/liveness"),
          apiFetch("/api/agents/events/errors"),
          apiFetch("/api/agents/events?limit=25"),
        ]);
        if (cancelled) return;
        setAgentEventStatus(statusPayload || null);
        setAgentLiveness(normalizeAgentLiveness(livenessPayload));
        setAgentErrorPatterns(normalizeAgentErrorPatterns(errorPayload));
        setAgentRecentEvents(Array.isArray(recentEventsPayload?.events) ? recentEventsPayload.events : []);
      } catch {
        if (cancelled) return;
      }
    };
    void loadAgentMonitor();
    const interval = setInterval(() => {
      void loadAgentMonitor();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(() => {});
  }, []);

  useEffect(() => {
    let mq;
    try { mq = globalThis.matchMedia?.("(max-width: 768px)"); }
    catch { mq = null; }
    if (!mq) return undefined;
    const handler = (event) => setIsCompact(event.matches);
    handler(mq);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  /* Navigate to logs tab with agent query pre-filled */
  const viewAgentLogs = (query) => {
    haptic();
    if (agentLogQuery) agentLogQuery.value = query;
    if (agentLogFile) agentLogFile.value = "";
    navigateTo("logs");
  };

  /* Force stop a specific agent slot */
  const handleForceStop = async (slot) => {
    const ok = await showConfirm(
      `Force-stop agent working on "${truncate(slot.taskTitle || slot.taskId || "task", 40)}"?`,
    );
    if (!ok) return;
    haptic("heavy");
    try {
      await apiFetch("/api/executor/stop-slot", {
        method: "POST",
        body: JSON.stringify({ slotIndex: slot.index, taskId: slot.taskId }),
      });
      showToast("Stop signal sent", "success");
      scheduleRefresh(200);
    } catch {
      /* toast via apiFetch */
    }
  };

  /* Toggle expanded detail view for a slot */
  const toggleExpand = (i) => {
    haptic();
    setExpandedSlot(expandedSlot === i ? null : i);
  };

  /* Open workspace viewer for an agent */
  const openWorkspace = (slot, i) => {
    haptic();
    setSelectedAgent({ ...slot, index: i });
  };

  /* Capacity utilisation */
  const freeSlots = Math.max(0, maxParallel - activeSlots);
  const capacityPct =
    maxParallel > 0 ? Math.round((activeSlots / maxParallel) * 100) : 0;

  /* Aggregate stats */
  /* Status counts and health summary */
  const statusCounts = slots.reduce(
    (acc, slot) => {
      const status = String(slot.status || "busy").toLowerCase();
      if (status === "busy" || status === "running") acc.running += 1;
      else if (status === "error") acc.error += 1;
      else if (status === "done") acc.done += 1;
      else if (status === "idle") acc.idle += 1;
      else acc.other += 1;
      return acc;
    },
    { running: 0, error: 0, done: 0, idle: 0, other: 0 },
  );
  const idleSlots = Math.max(0, maxParallel - activeSlots);
  const hasActiveWorkload =
    activeSlots > 0
    || activeSessionCount > 0
    || activeWorkflowRuns > 0;
  const healthLabel =
    statusCounts.error > 0
      ? "Needs Attention"
      : hasActiveWorkload
        ? "Healthy"
        : "Idle";
  const healthColor =
    statusCounts.error > 0
      ? "var(--color-error)"
      : hasActiveWorkload
        ? "var(--color-done)"
        : "var(--text-secondary)";
  const healthParts = [];
  if (activeSlots > 0) {
    healthParts.push(`${activeSlots} dedicated slot${activeSlots === 1 ? "" : "s"} active`);
    healthParts.push(`${idleSlots} idle`);
  }
  if (activeSessionOnlyCount > 0) {
    healthParts.push(`${activeSessionOnlyCount} session-only agent${activeSessionOnlyCount === 1 ? "" : "s"} active`);
  } else if (activeSessionCount > 0 && activeSlots === 0) {
    healthParts.push(`${activeSessionCount} active session${activeSessionCount === 1 ? "" : "s"} tracked`);
  }
  if (activeWorkflowRuns > 0) {
    healthParts.push(`${activeWorkflowRuns} workflow run${activeWorkflowRuns === 1 ? "" : "s"} active`);
  }
  const healthSubtext =
    statusCounts.error > 0
      ? `${statusCounts.error} slot${statusCounts.error === 1 ? "" : "s"} reporting errors`
      : healthParts.length
        ? healthParts.join(" · ")
        : "No active workloads";
  const lastErrorSlot = slots.find((slot) => slot.lastError);
  const workspaceHeader = activeWorkspace
    ? `${activeWorkspace.name || activeWorkspace.id} · ${String(activeWorkspaceExecutors?.pool || "shared")} pool`
    : "All workspaces · shared pool";
  const workspaceHeaderDetailParts = [];
  if (configuredSlots > 0) {
    workspaceHeaderDetailParts.push(`${configuredSlots} configured slots`);
  } else {
    workspaceHeaderDetailParts.push(`${maxParallel || 0} runtime slots visible`);
  }
  if (globalMaxParallel > 0 && globalMaxParallel !== maxParallel) {
    workspaceHeaderDetailParts.push(`${globalMaxParallel} global runtime slots visible`);
  }
  const workspaceHeaderDetail = workspaceHeaderDetailParts.join(" · ");
  const fleetMetrics = [
    { label: "Dedicated Slots", value: activeSlots },
    { label: "Session Only", value: activeSessionOnlyCount },
    { label: "Active Sessions", value: activeSessionCount },
    { label: "Workflows", value: activeWorkflowRuns },
    { label: "Idle Slots", value: idleSlots },
    { label: "Errors", value: statusCounts.error },
  ];
  const harnessRuns = useMemo(
    () => normalizeHarnessRuns(
      Array.isArray(harnessStatus?.recentRuns) ? harnessStatus.recentRuns : [],
      Array.isArray(harnessTelemetry?.recentRuns) ? harnessTelemetry.recentRuns : [],
      harnessStatus?.lastRun ? [harnessStatus.lastRun] : [],
      harnessTelemetry?.lastRun ? [harnessTelemetry.lastRun] : [],
    ),
    [harnessStatus, harnessTelemetry],
  );
  const harnessActiveCount = Math.max(
    Number(harnessStatus?.activeRunCount || 0) || 0,
    Number(harnessTelemetry?.activeRunCount || 0) || 0,
    harnessRuns.filter((run) => run?.active === true || getHarnessRunState(run) === "working").length,
  );
  const harnessWaitingCount = harnessRuns.filter(
    (run) => run?.approvalPending === true || run?.health?.waitingForOperator === true || getHarnessRunState(run) === "waiting",
  ).length;
  const harnessStalledCount = harnessRuns.filter((run) => getHarnessRunState(run) === "stalled").length;
  const harnessWorkingCount = harnessRuns.filter((run) => getHarnessRunState(run) === "working").length;
  const harnessApprovalCount = harnessRuns.filter((run) => run?.approvalPending === true || run?.health?.waitingForOperator === true).length;
  const targetedHarnessRun = useMemo(
    () => focusedHarnessRunId
      ? harnessRuns.find((run) => String(run?.runId || "").trim() === focusedHarnessRunId) || null
      : null,
    [focusedHarnessRunId, harnessRuns],
  );
  useEffect(() => {
    if (!focusedHarnessRunId || !targetedHarnessRun) return;
    if (matchesHarnessMonitorFilter(targetedHarnessRun, harnessFilter)) return;
    setHarnessFilter("all");
  }, [focusedHarnessRunId, harnessFilter, targetedHarnessRun]);
  const harnessVisibleRuns = useMemo(
    () => {
      const filtered = harnessRuns.filter((run) => matchesHarnessMonitorFilter(run, harnessFilter));
      if (!focusedHarnessRunId) return filtered.slice(0, 6);
      const target = harnessRuns.find((run) => String(run?.runId || "").trim() === focusedHarnessRunId);
      if (!target) return filtered.slice(0, 6);
      const ordered = [target, ...filtered.filter((run) => String(run?.runId || "").trim() !== focusedHarnessRunId)];
      return ordered.slice(0, 6);
    },
    [focusedHarnessRunId, harnessRuns, harnessFilter],
  );
  const harnessSummaryText = harnessRuns.length
    ? [
        `${harnessActiveCount} active`,
        `${harnessWaitingCount} waiting`,
        `${harnessStalledCount} stalled`,
        `${harnessApprovalCount} approvals`,
      ].join(" · ")
    : "Harness telemetry appears here after the first run.";
  const harnessFilterOptions = [
    { key: "attention", label: `Attention (${harnessWaitingCount + harnessStalledCount})` },
    { key: "active", label: `Active (${harnessActiveCount})` },
    { key: "waiting", label: `Waiting (${harnessWaitingCount})` },
    { key: "stalled", label: `Stalled (${harnessStalledCount})` },
    { key: "all", label: `All (${harnessRuns.length})` },
  ];
  const trackedAgentCount = Math.max(
    Number(agentEventStatus?.trackedAgents || 0) || 0,
    agentLiveness.length,
  );
  const aliveAgentCount = agentLiveness.filter((entry) => entry?.alive !== false).length;
  const staleAgentCount = agentLiveness.filter((entry) => entry?.alive === false).length;
  const agentEventLogSize = Number(agentEventStatus?.eventLogSize || 0) || 0;
  const agentListenerCount = Number(agentEventStatus?.listenerCount || 0) || 0;
  const agentMonitorSummaryText = trackedAgentCount > 0 || agentEventLogSize > 0
    ? [
        `${trackedAgentCount} tracked`,
        `${aliveAgentCount} alive`,
        `${staleAgentCount} stale`,
        `${agentErrorPatterns.length} patterns`,
      ].join(" · ")
    : "Agent event-bus telemetry appears here once live activity is recorded.";
  const visibleAgentLiveness = agentLiveness.slice(0, 6);
  const visibleAgentErrorPatterns = agentErrorPatterns.slice(0, 5);
  const visibleAgentEvents = agentRecentEvents.slice(0, 6);

  const handleFleetRefresh = () => {
    haptic();
    refreshTab("agents", { force: true });
  };

  const resolveHarnessApproval = useCallback(async (run, decision) => {
    const runId = String(run?.runId || "").trim();
    const requestId = getHarnessApprovalRequestId(run);
    if (!runId || !requestId) {
      showToast("Harness approval request is missing request metadata.", "error");
      return;
    }
    const actionKey = `${runId}:${decision}`;
    setHarnessActionByRun((current) => ({ ...current, [runId]: actionKey }));
    haptic(decision === "approved" ? "light" : "heavy");
    try {
      await apiFetch(`/api/harness/approvals/${encodeURIComponent(requestId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          actor: "operator",
          note: decision === "approved"
            ? `Approved from harness monitor for stage ${formatHarnessStage(run)}.`
            : `Denied from harness monitor for stage ${formatHarnessStage(run)}.`,
        }),
      });
      showToast(
        decision === "approved" ? "Harness approval granted." : "Harness approval denied.",
        decision === "approved" ? "success" : "warning",
      );
      scheduleRefresh(200);
      scheduleRefresh(1200);
    } catch {
      // apiFetch surfaces the error toast
    } finally {
      setHarnessActionByRun((current) => {
        const next = { ...current };
        delete next[runId];
        return next;
      });
    }
  }, []);

  const handleFocusDispatch = () => {
    haptic();
    if (dispatchInputRef.current) {
      dispatchInputRef.current.focus();
      dispatchInputRef.current.select?.();
    }
  };

  /* Loading state */
  if (!executor && !agents.length)
    return html`<${Card} title="Loading…"><${SkeletonCard} count=${3} /><//>`;

  return html`
    <div class="fleet-layout">
      <div class="fleet-span">
        <${Card}
          title="Fleet Overview"
          subtitle="Capacity, health, and quick actions"
          className="fleet-overview-card"
        >
          <div class="fleet-subtext" style=${{ marginBottom: "0.75rem" }}>
            Workspace: ${workspaceHeader} · ${workspaceHeaderDetail}
          </div>
          <div class="fleet-hero">
            <div class="fleet-health">
              <div class="fleet-label">Health</div>
              <div class="fleet-health-value">
                <span
                  class="fleet-health-dot"
                  style=${`background:${healthColor}`}
                ></span>
                <span>${healthLabel}</span>
              </div>
              <div class="fleet-subtext">${healthSubtext}</div>
              ${lastErrorSlot && statusCounts.error > 0 &&
              html`<div class="fleet-alert">
                Last error: ${truncate(lastErrorSlot.lastError || "Unknown error", 90)}
              </div>`}
            </div>

            <div class="fleet-capacity">
              <div class="fleet-label">Capacity</div>
              <div class="fleet-capacity-value">
                <span class="numeral">${activeSlots}</span>
                <span class="fleet-capacity-divider">/</span>
                <span class="numeral">${maxParallel}</span>
              </div>
              <div class="fleet-subtext">
                <span class="numeral">${capacityPct}%</span> used · <span class="numeral">${freeSlots}</span> free
              </div>
              <div class="fleet-capacity-bar">
                <${ProgressBar} percent=${capacityPct} />
              </div>
            </div>
          </div>

          <div class="fleet-metrics">
            ${fleetMetrics.map(
              (metric) => html`
                <div class="fleet-metric" key=${metric.label}>
                  <div class="fleet-metric-label">${metric.label}</div>
                  <div class="fleet-metric-value numeral">${metric.value}</div>
                </div>
              `,
            )}
          </div>

          <div class="fleet-quick-actions">
            <${Button} variant="contained" color="primary" size="small" onClick=${handleFocusDispatch}>
              ${iconText(":rocket: Dispatch")}
            <//>
            <${Button} variant="outlined" size="small" onClick=${handleFleetRefresh}>
              ↻ Refresh
            <//>
            <${Button} variant="text" size="small"
              onClick=${() => navigateTo("logs")}
            >
              ${iconText(":file: Logs")}
            <//>
          </div>
        <//>
      </div>

      <div class="fleet-column">
        <${DispatchSection}
          freeSlots=${freeSlots}
          inputRef=${dispatchInputRef}
          className="fleet-dispatch-card"
        />

        <${Card} className="fleet-harness-card">
          <${Collapsible}
            title=${harnessActiveCount > 0
              ? html`Harness Monitor · <span class="numeral">${harnessActiveCount}</span> active`
              : "Harness Monitor"}
            defaultOpen=${true}
          >
            <div class="meta-text mb-sm">${harnessSummaryText}</div>
            <div class="fleet-metrics" style=${{ marginBottom: "0.75rem" }}>
              ${[
                { label: "Working", value: harnessWorkingCount },
                { label: "Waiting", value: harnessWaitingCount },
                { label: "Stalled", value: harnessStalledCount },
                { label: "Approvals", value: harnessApprovalCount },
              ].map((metric) => html`
                <div class="fleet-metric" key=${metric.label}>
                  <div class="fleet-metric-label">${metric.label}</div>
                  <div class="fleet-metric-value numeral">${metric.value}</div>
                </div>
              `)}
            </div>
            <div class="fleet-session-scope fleet-session-filter" style=${{ marginBottom: "0.75rem", flexWrap: "wrap" }}>
              ${harnessFilterOptions.map((option) => html`
                <${Button}
                  key=${option.key}
                  variant="text"
                  size="small"
                  className=${`fleet-session-scope-btn fleet-session-filter-btn ${harnessFilter === option.key ? "active" : ""}`}
                  onClick=${() => {
                    haptic();
                    setHarnessFilter(option.key);
                  }}
                >
                  ${option.label}
                <//>
              `)}
            </div>
            ${harnessVisibleRuns.length
              ? html`<div class="fleet-turn-timeline">
                  ${harnessVisibleRuns.map((run) => {
                    const state = getHarnessRunState(run);
                    const stateMeta = getHarnessStateMeta(state);
                    const idleMs = Number(run?.health?.idleMs || 0) || 0;
                    const stage = formatHarnessStage(run);
                    const lastInterventionBy = String(run?.lastInterventionBy || run?.health?.lastInterventionBy || "").trim();
                    const attentionDetail = getHarnessAttentionDetail(run);
                    const latestEventSummary = getHarnessLatestEventSummary(run);
                    const attentionSinceAt = run?.health?.attentionSinceAt || null;
                    const lastEventAt = run?.health?.lastEventAt || run?.latestEventAt || null;
                    const approvalRequestId = getHarnessApprovalRequestId(run);
                    const actionState = harnessActionByRun[String(run?.runId || "").trim()] || "";
                    const waitingForApproval = run?.health?.waitingForOperator || run?.approvalPending;
                    const isTargetedRun = focusedHarnessRunId && String(run?.runId || "").trim() === focusedHarnessRunId;
                    return html`
                      <div
                        class="task-card fleet-turn-card"
                        key=${run.runId}
                        style=${isTargetedRun ? {
                          borderColor: "var(--color-inprogress, #60a5fa)",
                          boxShadow: "0 0 0 1px rgba(96, 165, 250, 0.35)",
                        } : {}}
                      >
                        <div class="task-card-header">
                          <div>
                            <div class="task-card-title">${truncate(run?.name || run?.runId || "(unnamed harness run)", 64)}</div>
                            <div class="task-card-meta">
                              ${run?.runId || "unknown"} · stage ${stage}
                              ${run?.active ? " · live" : ""}
                              ${idleMs > 0 ? ` · idle ${formatMsDuration(idleMs)}` : ""}
                            </div>
                          </div>
                          <${Chip}
                            size="small"
                            label=${stateMeta.label}
                            sx=${{
                              fontWeight: 700,
                              background: stateMeta.background,
                              color: stateMeta.color,
                            }}
                          />
                        </div>
                        ${isTargetedRun
                          ? html`<div class="task-card-meta" style=${{ marginTop: "0.2rem", color: "var(--color-inprogress, #60a5fa)" }}>
                              Focused from ${focusedHarnessSource || "workflow approvals"}
                            </div>`
                          : null}
                        <div class="meta-text">
                          ${attentionDetail}
                        </div>
                        <div class="task-card-meta" style=${{ marginTop: "0.35rem" }}>
                          ${run?.startedAt ? `Started ${formatRelative(run.startedAt)}` : "Start time unavailable"}
                          ${run?.updatedAt ? ` · Updated ${formatRelative(run.updatedAt)}` : ""}
                          ${lastInterventionBy ? ` · Last control by ${lastInterventionBy}` : ""}
                        </div>
                        ${(latestEventSummary && latestEventSummary !== attentionDetail) || attentionSinceAt || lastEventAt
                          ? html`<div class="task-card-meta" style=${{ marginTop: "0.2rem" }}>
                              ${attentionSinceAt ? `Attention since ${formatRelative(attentionSinceAt)}` : ""}
                              ${lastEventAt ? `${attentionSinceAt ? " · " : ""}Last event ${formatRelative(lastEventAt)}` : ""}
                              ${latestEventSummary && latestEventSummary !== attentionDetail ? ` · ${latestEventSummary}` : ""}
                            </div>`
                          : null}
                        ${waitingForApproval && approvalRequestId
                          ? html`<div class="btn-row mt-sm">
                              <${Button}
                                variant="contained"
                                color="success"
                                size="small"
                                disabled=${Boolean(actionState)}
                                onClick=${() => resolveHarnessApproval(run, "approved")}
                              >
                                ${actionState === `${run.runId}:approved`
                                  ? "Approving…"
                                  : iconText(":white_check_mark: Approve")}
                              <//>
                              <${Button}
                                variant="outlined"
                                color="warning"
                                size="small"
                                disabled=${Boolean(actionState)}
                                onClick=${() => resolveHarnessApproval(run, "denied")}
                              >
                                ${actionState === `${run.runId}:denied`
                                  ? "Denying…"
                                  : iconText(":no_entry: Deny")}
                              <//>
                            </div>`
                          : null}
                      </div>
                    `;
                  })}
                </div>`
              : html`<${EmptyState}
                  message=${harnessRuns.length
                    ? "No harness runs match this filter."
                    : "No harness runs have been reported yet."}
                />`}
          <//>
        <//>

        <${Card} className="fleet-slotmap-card">
          <${Collapsible} title="Slot Map" defaultOpen=${!isCompact}>
            <div class="meta-text mb-sm">Tap a slot to open the workspace.</div>
            <div class="slot-grid">
              ${Array.from(
                { length: Math.max(maxParallel, slots.length, activeSlots, 1) },
                (_, i) => {
                  const slot = slots[i];
                  const st = slot ? slot.status || "busy" : "idle";
                  return html`
                    <div
                      key=${fleetSlotKey(i, slot)}
                      class="slot-cell slot-${st}"
                      title=${slot
                        ? `${slot.taskTitle || slot.taskId} (${st})`
                        : `Slot ${i + 1} idle`}
                      onClick=${() => slot && openWorkspace(slot, resolveFleetSlotIndex(slot, i))}
                    >
                      <${StatusDot} status=${st} />
                      <span class="slot-label">${i + 1}</span>
                    </div>
                  `;
                },
              )}
            </div>
          <//>
        <//>

        <${Card} className="fleet-slotmap-card">
          <${Collapsible}
            title=${trackedAgentCount > 0
              ? html`Agent Live Monitor · <span class="numeral">${trackedAgentCount}</span> tracked`
              : "Agent Live Monitor"}
            defaultOpen=${!isCompact}
          >
            <div class="meta-text mb-sm">${agentMonitorSummaryText}</div>
            <div class="fleet-metrics" style=${{ marginBottom: "0.75rem" }}>
              ${[
                { label: "Tracked", value: trackedAgentCount },
                { label: "Alive", value: aliveAgentCount },
                { label: "Stale", value: staleAgentCount },
                { label: "Patterns", value: agentErrorPatterns.length },
                { label: "Events", value: agentEventLogSize },
                { label: "Listeners", value: agentListenerCount },
              ].map((metric) => html`
                <div class="fleet-metric" key=${metric.label}>
                  <div class="fleet-metric-label">${metric.label}</div>
                  <div class="fleet-metric-value numeral">${metric.value}</div>
                </div>
              `)}
            </div>
            <div class="task-card-meta" style=${{ marginBottom: "0.5rem" }}>
              Event bus started: ${agentEventStatus?.started === true ? "yes" : "no"}
            </div>
            <div class="task-card-meta" style=${{ marginBottom: "0.35rem", fontWeight: 700 }}>
              Liveness Detail
            </div>
            ${visibleAgentLiveness.length
              ? html`<div class="fleet-turn-timeline">
                  ${visibleAgentLiveness.map((entry, index) => {
                    const key = String(entry?.agentId || entry?.sessionId || entry?.taskId || `agent-${index}`).trim();
                    const staleMs = Number(entry?.staleSinceMs || 0) || 0;
                    const summary = String(entry?.summary || entry?.reason || entry?.taskTitle || "").trim();
                    return html`
                      <div class="task-card fleet-turn-card" key=${key}>
                        <div class="task-card-header">
                          <div>
                            <div class="task-card-title">${truncate(key, 64)}</div>
                            <div class="task-card-meta">
                              ${String(entry?.status || entry?.state || entry?.health || (entry?.alive === false ? "stale" : "alive")).trim() || "unknown"}
                              ${entry?.lastHeartbeatAt ? ` · heartbeat ${formatRelative(entry.lastHeartbeatAt)}` : ""}
                              ${staleMs > 0 ? ` · stale ${formatMsDuration(staleMs)}` : ""}
                            </div>
                          </div>
                          <${Chip}
                            size="small"
                            label=${entry?.alive === false ? "stale" : "alive"}
                            sx=${{
                              fontWeight: 700,
                              background: entry?.alive === false ? "rgba(239, 68, 68, 0.16)" : "rgba(16, 185, 129, 0.16)",
                              color: entry?.alive === false ? "var(--color-error)" : "var(--color-done)",
                            }}
                          />
                        </div>
                        <div class="meta-text">${summary || "No liveness summary reported."}</div>
                      </div>
                    `;
                  })}
                </div>`
              : html`<${EmptyState} message="No liveness detail reported yet." />`}
            <div class="task-card-meta" style=${{ marginTop: "0.75rem", marginBottom: "0.35rem", fontWeight: 700 }}>
              Error Pattern Detail
            </div>
            ${visibleAgentErrorPatterns.length
              ? html`<div class="fleet-turn-timeline">
                  ${visibleAgentErrorPatterns.map((entry, index) => {
                    const key = String(entry?.pattern || entry?.error || entry?.message || `pattern-${index}`).trim();
                    const count = Number(entry?.count || entry?.hits || entry?.occurrences || 0) || 0;
                    const scope = String(entry?.taskId || entry?.sessionId || entry?.agentId || entry?.source || "").trim();
                    return html`
                      <div class="task-card fleet-turn-card" key=${key}>
                        <div class="task-card-header">
                          <div>
                            <div class="task-card-title">${truncate(key, 64)}</div>
                            <div class="task-card-meta">
                              <span class="numeral">${count}</span> hits
                              ${scope ? ` · ${scope}` : ""}
                            </div>
                          </div>
                          <${Chip}
                            size="small"
                            label=${count > 0 ? "active" : "clear"}
                            sx=${{
                              fontWeight: 700,
                              background: count > 0 ? "rgba(245, 158, 11, 0.18)" : "rgba(16, 185, 129, 0.16)",
                              color: count > 0 ? "var(--color-warning, #f59e0b)" : "var(--color-done)",
                            }}
                          />
                        </div>
                      </div>
                    `;
                  })}
                </div>`
              : html`<${EmptyState} message="No recurring error patterns detected." />`}
            <div class="task-card-meta" style=${{ marginTop: "0.75rem", marginBottom: "0.35rem", fontWeight: 700 }}>
              Recent Agent Events
            </div>
            ${visibleAgentEvents.length
              ? html`<div class="fleet-turn-timeline">
                  ${visibleAgentEvents.map((event, index) => {
                    const eventType = String(event?.type || event?.eventType || "event").trim() || "event";
                    const taskScope = String(event?.taskId || event?.agentId || event?.sessionId || "").trim();
                    const summary = getAgentMonitorSummary(event);
                    return html`
                      <div class="task-card fleet-turn-card" key=${String(event?.id || `${eventType}-${index}`)}>
                        <div class="task-card-header">
                          <div>
                            <div class="task-card-title">${eventType}</div>
                            <div class="task-card-meta">
                              ${event?.timestamp ? formatRelative(event.timestamp) : "timestamp unavailable"}
                              ${taskScope ? ` · ${taskScope}` : ""}
                            </div>
                          </div>
                        </div>
                        <div class="meta-text">${summary || "No event summary available."}</div>
                      </div>
                    `;
                  })}
                </div>`
              : html`<${EmptyState} message="No recent agent events recorded." />`}
          <//>
        <//>
      </div>

      <div class="fleet-column">
        <${Card} className="fleet-active-card">
          <${Collapsible}
            title=${activeSlots > 0
              ? html`Active Slots · <span class="numeral">${activeSlots}</span> active`
              : "Active Slots"}
            defaultOpen=${!isCompact}
          >
            <div class="meta-text mb-sm">
              ${activeSlots > 0
                ? html`<span class="numeral">${activeSlots}</span> active · <span class="numeral">${freeSlots}</span> free`
                : "No active slots"}
            </div>
            <${TextField}
              size="small" variant="outlined" placeholder="Filter by task, branch, status…"
              value=${fleetSearch}
              onInput=${(e) => setFleetSearch(e?.target?.value || "")}
              fullWidth
              sx=${{ mb: 1, "& .MuiInputBase-input": { fontSize: "0.82rem" } }}
            />
            ${filteredSlots.length
                ? filteredSlots.map(
                    (slot, i) => html`
                    <div
                      key=${fleetSlotKey(i, slot)}
                      class="task-card fleet-agent-card ${expandedSlot === i
                        ? "task-card-expanded"
                        : ""}"
                    >
                      <div
                        class="task-card-header"
                        onClick=${() => toggleExpand(i)}
                        style="cursor:pointer"
                      >
                        <div>
                          <div class="task-card-title">
                            <${StatusDot} status=${slot.status || "busy"} />
                            ${slot.taskTitle || "(no title)"}
                          </div>
                          <div class="task-card-meta">
                            ${slot.taskId || "?"} · Agent
                            ${slot.agentInstanceId || "n/a"} · ${slot.sdk || "?"}${slot.model ? ` · ${slot.model}` : ""}
                          </div>
                        </div>
                        <${Badge}
                          status=${slot.status || "busy"}
                          text=${slot.status || "busy"}
                        />
                      </div>
                      <div class="flex-between">
                        <div class="meta-text">Attempt <span class="numeral">${slot.attempt || 1}</span></div>
                        ${slot.startedAt && html`
                          <div class="agent-duration numeral">${formatDuration(slot.startedAt)}</div>
                        `}
                      </div>

                      ${(slot.status === "running" || slot.status === "busy") &&
                    html`
                      <div class="agent-progress-bar mt-sm">
                        <div
                          class="agent-progress-bar-fill agent-progress-pulse"
                        ></div>
                      </div>
                    `}

                    ${expandedSlot === i &&
                    html`
                      <div class="agent-detail mt-sm">
                        ${slot.branch &&
                        html`<div class="meta-text">Branch: ${slot.branch}</div>`}
                        ${slot.startedAt &&
                        html`<div class="meta-text">
                          Started: ${formatRelative(slot.startedAt)}
                        </div>`}
                        ${slot.completedCount != null &&
                        html`<div class="meta-text">
                          Completed: <span class="numeral">${slot.completedCount}</span> tasks
                        </div>`}
                        ${slot.avgDurationMs &&
                        html`<div class="meta-text">
                          Avg: ${Math.round(slot.avgDurationMs / 1000)}s
                        </div>`}
                        ${slot.model &&
                        html`<div class="meta-text">Model: ${slot.model}</div>`}
                        ${slot.lastError &&
                        html`<div
                          class="meta-text"
                          style="color:var(--color-error)"
                        >
                          Last error: ${truncate(slot.lastError, 100)}
                        </div>`}
                      </div>
                    `}

                    <div class="btn-row mt-sm">
                      <${Button} variant="text" size="small"
                        onClick=${() =>
                          viewAgentLogs(
                            (slot.taskId || slot.branch || "").slice(0, 12),
                          )}
                      >
                        ${iconText(":file: Logs")}
                      <//>
                      <${Button} variant="text" size="small"
                        onClick=${() =>
                          sendCommandToChat(
                            `/steer focus on ${slot.taskTitle || slot.taskId}`,
                          )}
                      >
                        ${iconText(":target: Steer")}
                      <//>
                      <${Button} variant="text" size="small"
                        onClick=${() => openWorkspace(slot, resolveFleetSlotIndex(slot, i))}
                      >
                        ${iconText(":search: View")}
                      <//>
                      <${Button} variant="contained" color="error" size="small"
                        onClick=${() => handleForceStop({ ...slot, index: resolveFleetSlotIndex(slot, i) })}
                      >
                        ${iconText(":ban: Stop")}
                      <//>
                    </div>
                  </div>
                `,
              )
            : html`<${EmptyState} message=${fleetSearch.trim()
              ? "No slots match this search."
              : activeSlots > 0
                ? "Active slots reported, but slot details haven't arrived yet."
                : "No active agents."} />`}
        <//>
      <//>
      </div>

      <div class="fleet-span">
        <${Card} className="fleet-sessions-card">
          <${Collapsible}
            title=${`Sessions · ${allSessions.length} total`}
            defaultOpen=${!isCompact}
          >
            <${TextField}
              size="small" variant="outlined" placeholder="Filter sessions by title, ID, task…"
              value=${sessionSearch}
              onInput=${(e) => setSessionSearch(e?.target?.value || "")}
              fullWidth
              sx=${{ mb: 1, "& .MuiInputBase-input": { fontSize: "0.82rem" } }}
            />
            ${filteredSessions.length
              ? filteredSessions.map((s) => html`
                <div
                  key=${s.id}
                  class="task-card fleet-agent-card"
                  style="cursor:pointer"
                  onClick=${() => {
                    haptic();
                    selectedSessionId.value = s.id;
                    navigateTo("agents");
                  }}
                >
                  <div class="task-card-header">
                    <div class="session-turn-chip">Turns ${s.turnCount || 0}</div>
                    <div>
                      <div class="task-card-title">
                        <${StatusDot} status=${s.status || "idle"} />
                        ${truncate(s.title || s.taskTitle || s.taskId || s.id || "(untitled)", 60)}
                      </div>
                      <div class="task-card-meta">
                        ${s.id || "?"}
                        ${s.taskId ? ` · ${s.taskId}` : ""}
                        ${s.branch ? ` · ${s.branch}` : ""}
                        · Turns ${s.turnCount || 0}
                      </div>
                      <div class="task-card-meta">
                        ${`Turns ${Number(s.turnCount || 0)}`}
                        ${Number(s.elapsedMs || 0) > 0 ? ` · ${formatMsDuration(s.elapsedMs || 0)}` : ""}
                      </div>
                      ${renderFleetEntryTokenSplit({ session: s })}
                    </div>
                    <${Badge} status=${s.status || "idle"} text=${s.status || "idle"} />
                  </div>
                </div>
              `)
              : html`<${EmptyState} message=${sessionSearch.trim()
                ? "No sessions match this search."
                : "No sessions yet."} />`}
          <//>
        <//>
      </div>

      ${agents.length > 0 &&
      html`
        <div class="fleet-span">
          <${Collapsible} title="Agent Threads" defaultOpen=${false}>
            <${Card} className="fleet-threads-card">
              <div class="stats-grid">
                ${agents.map(
                  (t, i) => html`
                    <${StatCard}
                      key=${fleetThreadKey(t, i)}
                      value=${t.turnCount || 0}
                      label="${truncate(t.taskKey || `Thread ${i}`, 20)} (${t.sdk ||
                      "?"})"
                    />
                  `,
                )}
              </div>
            <//>
          <//>
        </div>
      `}

    </div>

    ${selectedAgent && html`
      <${WorkspaceViewer}
        agent=${selectedAgent}
        onClose=${() => setSelectedAgent(null)}
      />
    `}
  `;
}

/* ─── Context Viewer for session detail tab ─── */
function ContextViewer({ query, sessionId = "", taskId = "", branch = "" }) {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  const fetchContext = useCallback(() => {
    if (!query && !sessionId && !taskId && !branch) return;
    const params = new URLSearchParams();
    if (query) params.set("query", String(query));
    if (sessionId) params.set("sessionId", String(sessionId));
    if (taskId) params.set("taskId", String(taskId));
    if (branch) params.set("branch", String(branch));
    apiFetch(`/api/agent-context?${params.toString()}`, { _silent: true })
      .then((res) => {
        const d = res.data ?? res ?? null;
        setCtx(d);
        setLoading(false);
        setError(null);
      })
      .catch((err) => {
        setLoading(false);
        setError(err.message || "Failed to load context");
      });
  }, [query, sessionId, taskId, branch]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setCtx(null);
    fetchContext();

    intervalRef.current = setInterval(fetchContext, 10000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fetchContext]);

  const parseCommits = (detailed) => {
    if (!detailed) return [];
    return detailed.split("\n").filter(Boolean).map((line) => {
      const parts = line.split("||");
      return { hash: parts[0] || "", message: parts[1] || "", time: parts[2] || "" };
    });
  };

  const parseStatus = (raw) => {
    if (!raw) return [];
    return raw.split("\n").filter(Boolean).map((line) => {
      const code = line.substring(0, 2).trim() || "?";
      const file = line.substring(3);
      return { code, file };
    });
  };

  const parseAheadBehind = (raw) => {
    if (!raw) return { ahead: 0, behind: 0 };
    const parts = raw.split(/\s+/);
    return { ahead: parseInt(parts[0], 10) || 0, behind: parseInt(parts[1], 10) || 0 };
  };

  const statusColor = (code) => {
    if (code === "M" || code === "MM") return "var(--color-inprogress)";
    if (code === "A") return "var(--color-done)";
    if (code === "D") return "var(--color-error)";
    if (code === "?" || code === "??") return "var(--text-secondary)";
    return "var(--text-primary)";
  };

  const statusLabel = (code) => {
    const map = { M: "Modified", MM: "Modified", A: "Added", D: "Deleted", "?": "Untracked", "??": "Untracked", R: "Renamed", C: "Copied" };
    return map[code] || code;
  };

  const copyContext = () => {

    const c = ctx.context;
    const ab = parseAheadBehind(c.gitAheadBehind);
    const commits = parseCommits(c.gitLogDetailed);
    const files = parseStatus(c.gitStatus);
    let text = `## Workspace Context\n`;
    text += `Branch: ${c.gitBranch || "unknown"}\n`;
    text += `Path: ${c.path || "unknown"}\n`;
    text += `Status: ${files.length === 0 ? "Clean" : `${files.length} changed file(s)`}\n`;
    if (ab.ahead || ab.behind) text += `Ahead: ${ab.ahead}, Behind: ${ab.behind}\n`;
    if (commits.length) {
      text += `\n### Recent Commits\n`;
      commits.forEach((cm) => { text += `${cm.hash} ${cm.message} (${cm.time})\n`; });
    }
    if (files.length) {
      text += `\n### Modified Files\n`;
      files.forEach((f) => { text += `[${f.code}] ${f.file}\n`; });
    }
    if (!navigator?.clipboard?.writeText) {
      showToast("Clipboard unavailable", "error");
      return;
    }
    navigator.clipboard.writeText(text).then(() => showToast("Context copied", "success")).catch(() => showToast("Copy failed", "error"));
  };

  if (loading) {
    return html`<div class="chat-view" style="padding:16px;">
      <${SkeletonCard} height="40px" />
      <${SkeletonCard} height="120px" className="mt-sm" />
      <${SkeletonCard} height="80px" className="mt-sm" />
    </div>`;
  }

  if (error) {
    return html`<div class="chat-view chat-empty-state">
      <div class="session-empty-icon" style="color:var(--color-error)">${resolveIcon(":alert:")}</div>
      <div class="session-empty-text">${error}</div>
      <${Button} variant="contained" color="primary" size="small" className="mt-sm" onClick=${() => { setLoading(true); setError(null); fetchContext(); }}>${iconText(":refresh: Retry")}<//>
    </div>`;
  }

  if (!ctx?.context) {
    const sessionMeta = ctx?.session || null;
    const matches = Array.isArray(ctx?.matches) ? ctx.matches.filter(Boolean) : [];
    return html`<div class="chat-view chat-empty-state" style="padding:16px; align-items:flex-start; text-align:left;">
      <div class="session-empty-icon">${resolveIcon(":clipboard:")}</div>
      <div class="session-empty-text">No workspace context available yet</div>
      ${sessionMeta && html`
        <div class="meta-text mt-sm">
          Session: <span class="mono">${sessionMeta.id || sessionMeta.taskId || "unknown"}</span>
          ${sessionMeta.status ? ` · ${sessionMeta.status}` : ""}
        </div>
      `}
      ${matches.length > 0 && html`
        <div class="meta-text mt-sm">Matches: ${matches.slice(0, 3).join(" · ")}</div>
      `}
      <div class="meta-text mt-sm">Context is captured once a linked worktree is available.</div>
    </div>`;
  }

  const c = ctx.context;
  const ab = parseAheadBehind(c.gitAheadBehind);
  const commits = parseCommits(c.gitLogDetailed);
  const files = parseStatus(c.gitStatus);
  const isDirty = files.length > 0;

  return html`
    <div class="chat-view" style="padding:12px; overflow-y:auto;">
      <!-- Toolbar -->
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-bottom:12px;">
        <${Button} variant="text" size="small" onClick=${() => { setLoading(true); fetchContext(); }}>
          <span class="icon-inline">${ICONS.refresh}</span> Refresh
        <//>
        <${Button} variant="text" size="small" onClick=${copyContext}>
          <span class="icon-inline">${ICONS.copy}</span> Copy Context
        <//>
      </div>

      <!-- Branch & Status -->
      <div class="card mb-sm">
        <div class="card-title" style="display:flex; align-items:center; gap:8px;">
          <span class="icon-inline">${ICONS.git}</span> Branch & Status
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:8px;">
          <div style="flex:1; min-width:120px;">
            <div class="meta-text">Branch</div>
            <div style="font-weight:600; font-family:monospace; font-size:13px;">${c.gitBranch || "unknown"}</div>
          </div>
          <div>
            <div class="meta-text">Status</div>
            <${Badge}
              status=${isDirty ? "inprogress" : "done"}
              text=${isDirty ? `${files.length} changed` : "Clean"}
            />
          </div>
          ${(ab.ahead > 0 || ab.behind > 0) && html`
            <div>
              <div class="meta-text">Sync</div>
              <div style="font-size:13px;">
                ${ab.ahead > 0 ? html`<span style="color:var(--color-done)">↑${ab.ahead}</span>` : null}
                ${ab.ahead > 0 && ab.behind > 0 ? " " : null}
                ${ab.behind > 0 ? html`<span style="color:var(--color-error)">↓${ab.behind}</span>` : null}
              </div>
            </div>
          `}
        </div>
      </div>

      <!-- Working Directory -->
      <div class="card mb-sm">
        <div class="card-title" style="display:flex; align-items:center; gap:8px;">
          <span class="icon-inline">${ICONS.folder}</span> Working Directory
        </div>
        <div style="font-family:monospace; font-size:12px; color:var(--text-secondary); margin-top:6px; word-break:break-all;">
          ${c.path || "unknown"}
        </div>
      </div>

      <!-- Recent Commits -->
      ${commits.length > 0 && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.clock}</span> Recent Commits
          </div>
          <div style="margin-top:8px;">
            ${commits.map((cm) => html`
              <div key=${cm.hash} style="display:flex; gap:8px; align-items:baseline; padding:4px 0; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06));">
                <code style="color:var(--color-inprogress); font-size:12px; flex-shrink:0;">${cm.hash}</code>
                <span style="flex:1; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${cm.message}</span>
                <span class="meta-text" style="flex-shrink:0; font-size:11px;">${cm.time}</span>
              </div>
            `)}
          </div>
        </div>
      `}

      <!-- Modified Files -->
      ${files.length > 0 && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.edit}</span> Modified Files
            <${Badge} text="${files.length}" className="ml-auto" />
          </div>
          <div style="margin-top:8px;">
            ${files.map((f) => html`
              <div key=${f.file} style="display:flex; gap:8px; align-items:center; padding:4px 0; border-bottom:1px solid var(--border-color, rgba(255,255,255,0.06));">
                <code style="color:${statusColor(f.code)}; font-size:11px; font-weight:700; min-width:20px; text-align:center;" title=${statusLabel(f.code)}>${f.code}</code>
                <span style="font-family:monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${f.file}</span>
              </div>
            `)}
          </div>
        </div>
      `}

      <!-- Diff Stats -->
      ${c.gitDiffStat && html`
        <div class="card mb-sm">
          <div class="card-title" style="display:flex; align-items:center; gap:8px;">
            <span class="icon-inline">${ICONS.terminal}</span> Diff Summary
          </div>
          <pre style="font-size:11px; margin:8px 0 0; white-space:pre-wrap; color:var(--text-secondary); overflow-x:auto;">${c.gitDiffStat}</pre>
        </div>
      `}
    </div>
  `;
}

/* ─── Fleet Full Session View ─── */
function FleetSessionsPanel({ slots, sessions = [], taskFallbackEntries = [], onOpenWorkspace, onForceStop }) {
  const [detailTab, setDetailTab] = useState("stream");
  const [sessionScope, setSessionScope] = useState(FLEET_SESSION_SCOPE.all);
  const [sessionSearch, setSessionSearch] = useState("");
  const [selectedEntryKey, setSelectedEntryKey] = useState(null);
  const [copiedSessionId, setCopiedSessionId] = useState("");
  const [logText, setLogText] = useState("(no logs yet)");
  const logRef = useRef(null);
  const allSessions = Array.isArray(sessions) ? sessions : [];

  const copySessionId = (sessionId) => {
    if (!sessionId) return;
    if (!navigator?.clipboard?.writeText) {
      setCopiedSessionId("");
      showToast("Copy failed", "error");
      return;
    }
    setCopiedSessionId(sessionId);
    try {
      navigator.clipboard
        .writeText(sessionId)
        .then(() => showToast("Session ID copied", "success"))
        .catch(() => {
          setCopiedSessionId("");
          showToast("Copy failed", "error");
        });
    } catch (_err) {
      setCopiedSessionId("");
      showToast("Copy failed", "error");
    }
  };

  /* Stabilise entries with useMemo so the reference only changes when the
     underlying data actually changes – prevents infinite render loops that
     previously caused "insertBefore" DOM errors. */
  const entries = useMemo(() => {
    const slotEntries = (slots || [])
      .map((slot, index) => {
        const session =
          allSessions.find((s) => s?.id && slot?.sessionId && s.id === slot.sessionId) ||
          allSessions.find((s) => {
            if (!slot?.taskId) return false;
            return s?.taskId === slot.taskId || s?.id === slot.taskId;
          }) ||
          null;
        const resolvedIndex = resolveFleetSlotIndex(slot, index);
        const key = fleetSlotKey(resolvedIndex, slot);
        return { key, slot, index: resolvedIndex, session };
      })
      .sort((a, b) => {
        const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
        const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
        return bScore - aScore;
      });

    const activeSessionIds = new Set(
      slotEntries.map((entry) => String(entry?.session?.id || "").trim()).filter(Boolean),
    );
    const activeTaskIds = new Set(
      slotEntries.map((entry) => String(entry?.slot?.taskId || entry?.session?.taskId || "").trim()).filter(Boolean),
    );
    const fallbackEntries = (taskFallbackEntries || [])
      .filter((task) => {
        const taskId = String(task?.id || task?.taskId || "").trim();
        if (!taskId) return false;
        if (activeTaskIds.has(taskId) || activeSessionIds.has(taskId)) return false;
        return true;
      })
      .map((task, index) => ({
        key: `task-${String(task?.id || task?.taskId || index).trim()}`,
        slot: {
          taskId: String(task?.id || task?.taskId || "").trim(),
          taskTitle: task?.title || task?.taskTitle || "(untitled task)",
          branch: task?.branchName || task?.branch || task?.meta?.branchName || "",
          baseBranch: task?.baseBranch || task?.meta?.baseBranch || null,
          status: task?.status || task?.runtimeSnapshot?.state || "idle",
          sessionId: "",
          startedAt:
            task?.lastActivityAt ||
            task?.updatedAt ||
            task?.createdAt ||
            null,
          synthetic: true,
        },
        index: (slots || []).length + index,
        session:
          allSessions.find((session) => {
            const sessionTaskId = String(session?.taskId || session?.id || "").trim();
            return sessionTaskId === String(task?.id || task?.taskId || "").trim();
          }) || null,
        isTaskFallback: true,
      }));

    return dedupeFleetEntries([...slotEntries, ...fallbackEntries]);
  }, [slots, allSessions, taskFallbackEntries]);

  const historyEntries = useMemo(() => {
    const activeSessionIds = new Set(
      entries.map((entry) => String(entry?.session?.id || "").trim()).filter(Boolean),
    );
    const activeTaskIds = new Set(
      entries.map((entry) => String(entry?.slot?.taskId || "").trim()).filter(Boolean),
    );
    return allSessions
      .filter((session) => {
        if (!session || typeof session !== "object") return false;
        const id = String(session.id || "").trim();
        if (!id) return false;
        const taskId = String(session.taskId || "").trim();
        if (activeSessionIds.has(id)) return false;
        if (taskId && activeTaskIds.has(taskId)) return false;
        return true;
      })
      .map((session) => ({
        key: `session-${String(session.id || "").trim()}`,
        slot: null,
        index: null,
        session,
        isHistory: true,
      }))
      .sort(compareFleetEntries);
  }, [allSessions, entries]);

  const allEntries = useMemo(
    () => dedupeFleetEntries([...entries, ...historyEntries]),
    [entries, historyEntries],
  );

  const scopeCounts = useMemo(() => {
    const allCount = allEntries.length;
    const activeCount = allEntries.filter((entry) => isFleetEntryActive(entry)).length;
    const historicCount = allCount - activeCount;
    return { allCount, activeCount, historicCount };
  }, [allEntries]);

  const scopedEntries = useMemo(() => {
    if (sessionScope === FLEET_SESSION_SCOPE.active) {
      return allEntries.filter((entry) => isFleetEntryActive(entry));
    }
    if (sessionScope === FLEET_SESSION_SCOPE.historic) {
      return allEntries.filter((entry) => !isFleetEntryActive(entry));
    }
    return allEntries;
  }, [allEntries, sessionScope]);

  const visibleEntries = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) return scopedEntries;
    return scopedEntries.filter((entry) => getFleetEntrySearchBlob(entry).includes(query));
  }, [scopedEntries, sessionSearch]);

  /* Build a stable fingerprint so the effect only fires when entries actually
     change rather than on every render (entries is now memoised but we still
     guard with a primitive dep). */
  const entriesFingerprint = visibleEntries.map((e) => e.key).join(",");

  useEffect(() => {
    if (!visibleEntries.length) {
      setSelectedEntryKey(null);
      return;
    }
    const existing = visibleEntries.some((entry) => entry.key === selectedEntryKey);
    if (!existing) setSelectedEntryKey(visibleEntries[0].key);
  }, [entriesFingerprint, sessionScope, sessionSearch]);

  const selectedEntry =
    visibleEntries.find((entry) => entry.key === selectedEntryKey)
    || visibleEntries[0]
    || null;
  const resolvedSessionId = resolveFleetEntrySessionId(selectedEntry);
  const streamSessionId = resolvedSessionId || null;
  const diffSessionId = resolvedSessionId || null;
  const contextSessionId = resolvedSessionId || "";
  const contextTaskId =
    selectedEntry?.slot?.taskId
    || selectedEntry?.session?.taskId
    || "";
  const contextBranch =
    selectedEntry?.slot?.branch
    || selectedEntry?.session?.branch
    || "";
  const contextQuery = buildSessionLogQuery([
    contextSessionId,
    contextTaskId,
    contextBranch,
  ]);
  const diffWorkspace = resolveSessionWorkspaceHint(selectedEntry?.session || null, "all") || "all";

  useEffect(() => {
    if (streamSessionId) selectedSessionId.value = streamSessionId;
  }, [streamSessionId]);

  useEffect(() => {
    const query = buildSessionLogQuery([
      selectedEntry?.session?.id,
      selectedEntry?.slot?.sessionId,
      selectedEntry?.slot?.taskId,
      selectedEntry?.session?.taskId,
      selectedEntry?.slot?.branch,
      selectedEntry?.session?.branch,
    ]);
    if (!query) {
      setLogText("(no logs yet)");
      return undefined;
    }
    let active = true;
    const fetchLogs = () => {
      apiFetch(`/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=220`, { _silent: true })
        .then((res) => {
          if (!active) return;
          const data = res.data ?? res ?? "";
          const content =
            typeof data === "string"
              ? data
              : data?.content || data?.lines || data?.data || "";
          const text = Array.isArray(content) ? content.join("\n") : content || "";
          setLogText(text || "(no logs yet)");
          if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
        })
        .catch(() => {
          if (active) setLogText("(failed to load logs)");
        });
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedEntry?.key]);

  const focusedLogText = buildSessionFocusedLogText(selectedEntry, logText);

  return html`
    <${Card}
      title="Fleet Session View"
      subtitle="Dedicated slots and session-tracked agents with full execution detail"
      className="fleet-fullview-card"
    >
      <div class="fleet-fullview" style=${{ display: "flex", gap: "16px", alignItems: "stretch", minHeight: "720px", flexWrap: "wrap" }}>
        <div class="fleet-slot-rail" style=${{ display: "flex", flexDirection: "column", minHeight: 0, flex: "0 0 320px", maxWidth: "360px", width: "100%" }}>
          <div class="fleet-session-rail-header">
            <div class="fleet-session-rail-title">Sessions</div>
            <div class="fleet-session-rail-subtitle">${scopeCounts.allCount} total</div>
          </div>
          <div class="fleet-session-search">
            <input
              class="fleet-session-search-input"
              type="text"
              placeholder="Search task, session, branch..."
              value=${sessionSearch}
              onInput=${(e) => setSessionSearch(e?.target?.value || "")}
            />
          </div>
          <div class="fleet-session-scope fleet-session-filter">
            <${Button} variant="text" size="small"
              className=${`fleet-session-scope-btn fleet-session-filter-btn ${sessionScope === FLEET_SESSION_SCOPE.all ? "active" : ""}`}
              onClick=${() => {
                haptic();
                setSessionScope(FLEET_SESSION_SCOPE.all);
              }}
            >
              All (${scopeCounts.allCount})
            <//>
            <${Button} variant="text" size="small"
              className=${`fleet-session-scope-btn fleet-session-filter-btn ${sessionScope === FLEET_SESSION_SCOPE.active ? "active" : ""}`}
              onClick=${() => {
                haptic();
                setSessionScope(FLEET_SESSION_SCOPE.active);
              }}
            >
              Active (${scopeCounts.activeCount})
            <//>
            <${Button} variant="text" size="small"
              className=${`fleet-session-scope-btn fleet-session-filter-btn ${sessionScope === FLEET_SESSION_SCOPE.historic ? "active" : ""}`}
              onClick=${() => {
                haptic();
                setSessionScope(FLEET_SESSION_SCOPE.historic);
              }}
            >
              Historic (${scopeCounts.historicCount})
            <//>
          </div>
          <div class="fleet-slot-list-scroll" style=${{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
            ${visibleEntries.length === 0
              ? html`<div class="meta-text fleet-session-empty">
                  ${sessionSearch.trim()
                    ? "No sessions match this search."
                    : sessionScope === FLEET_SESSION_SCOPE.active
                      ? "No active sessions"
                      : sessionScope === FLEET_SESSION_SCOPE.historic
                        ? "No historic sessions"
                        : "No sessions yet"}
                </div>`
              : html`${visibleEntries.map((entry) => {
                  const entryStatus = getFleetEntryStatusMeta(entry);
                  const relativeTime = getFleetEntryRelativeTime(entry);
                  const activityLabel = getFleetEntryActivityLabel(entry);
                  const sessionId = resolveFleetEntrySessionId(entry);
                  return html`
                    <${Button} variant="text" size="small" component="div"
                      key=${entry.key}
                      className=${`fleet-slot-item ${selectedEntry?.key === entry.key ? "active" : ""} ${entry.isHistory ? "history" : ""}`}
                      onClick=${() => {
                        haptic();
                        setSelectedEntryKey(entry.key);
                        setDetailTab("stream");
                      }}
                    >
                      <div class="fleet-slot-item-header">
                        <div class="fleet-slot-item-title">
                          <${StatusDot} status=${entry.slot?.status || entry.session?.status || "busy"} />
                          ${truncate(getFleetEntryTitle(entry), 58)}
                        </div>
                        ${relativeTime
                          ? html`<div class="fleet-slot-item-time">${relativeTime}</div>`
                          : null}
                      </div>
                      <div class="fleet-slot-item-meta fleet-slot-item-meta-primary">
                        ${getFleetEntryMetaLabel(entry)}
                      </div>
                      <div class="fleet-slot-item-meta fleet-slot-item-meta-secondary">
                        <span class="fleet-slot-meta-turns">Turns ${Number(entry.session?.turnCount || 0)}</span>
                        ${activityLabel
                          ? html`<span class="fleet-slot-meta-response">${activityLabel}</span>`
                          : null}
                        <span class=${`fleet-slot-state-badge ${entryStatus.tone || "historic"}`}>
                          ${entryStatus.label || "Unknown"}
                        </span>
                        ${sessionId
                          ? html`<button
                              type="button"
                              class="fleet-session-id-pill"
                              data-session-id=${sessionId}
                              data-copied=${copiedSessionId === sessionId ? "true" : "false"}
                              aria-label=${`Copy session ID ${sessionId}`}
                              onClick=${() => copySessionId(sessionId)}
                              onAnimationEnd=${(event) => {
                                if (event?.target !== event?.currentTarget) return;
                                if (copiedSessionId === sessionId) setCopiedSessionId("");
                              }}
                            >
                              <span class="fleet-session-id-pill-text mono">${sessionId.slice(0, 8)}</span>
                              <span class="fleet-session-id-pill-icon fleet-icon-clamp" aria-hidden="true">${copiedSessionId === sessionId ? "✓" : ICONS.copy}</span>
                            </button>`
                          : null}
                        ${entry.slot?.branch
                          ? html`<span class="fleet-slot-meta-branch">${entry.slot.branch}</span>`
                          : entry.session?.branch
                            ? html`<span class="fleet-slot-meta-branch">${entry.session.branch}</span>`
                            : null}
                      </div>
                    <//>
                  `;
                })}`}
          </div>
        </div>
        <div class="session-detail fleet-session-detail" style=${{ minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 420px" }}>
          ${selectedEntry
            ? html`
                <div class="fleet-session-header">
                  <div>
                    <div class="task-card-title">
                      <${StatusDot} status=${selectedEntry.slot?.status || selectedEntry.session?.status || "busy"} />
                      ${selectedEntry.slot?.taskTitle
                        || selectedEntry.session?.taskTitle
                        || selectedEntry.session?.title
                        || selectedEntry.session?.taskId
                        || "(untitled)"}
                    </div>
                    <div class="task-card-meta">
                      ${selectedEntry.slot?.taskId || selectedEntry.session?.taskId || selectedEntry.session?.id || "?"}
                      ${` · ${getFleetEntryOriginLabel(selectedEntry)}`}
                      ${selectedEntry.slot?.branch
                        ? ` · ${selectedEntry.slot.branch}`
                        : selectedEntry.session?.branch
                          ? ` · ${selectedEntry.session.branch}`
                          : ""}
                    </div>
                    <div class="task-card-meta">
                      ${getFleetEntryActivityLabel(selectedEntry) || `Responses via ${resolveFleetEntrySessionId(selectedEntry) ? "stream" : "logs"}`}
                    </div>
                  </div>
                  ${selectedEntry.slot && !selectedEntry.isTaskFallback && html`
                    <div class="btn-row">
                      <${Button} variant="text" size="small" onClick=${() => onOpenWorkspace(selectedEntry.slot, selectedEntry.index)}>
                        ${iconText(":search: Workspace")}
                      <//>
                      <${Button} variant="contained" color="error" size="small" onClick=${() => onForceStop({ ...selectedEntry.slot, index: selectedEntry.index })}>
                        ${iconText(":ban: Stop")}
                      <//>
                    </div>
                  `}
                </div>
                <div class="session-detail-tabs">
                  <${Button} variant="text" size="small"
                    className=${`session-detail-tab ${detailTab === "stream" ? "active" : ""}`}
                    onClick=${() => setDetailTab("stream")}
                  >${iconText(":chat: Stream")}<//>
                  <${Button} variant="text" size="small"
                    className=${`session-detail-tab ${detailTab === "context" ? "active" : ""}`}
                    onClick=${() => setDetailTab("context")}
                  >${iconText(":clipboard: Context")}<//>
                  <${Button} variant="text" size="small"
                    className=${`session-detail-tab ${detailTab === "diff" ? "active" : ""}`}
                    onClick=${() => setDetailTab("diff")}
                  >${iconText(":edit: Diff")}<//>
                  <${Button} variant="text" size="small"
                    className=${`session-detail-tab ${detailTab === "logs" ? "active" : ""}`}
                    onClick=${() => setDetailTab("logs")}
                  >${iconText(":file: Logs")}<//>
                  <${Button} variant="text" size="small"
                    className=${`session-detail-tab ${detailTab === "turns" ? "active" : ""}`}
                    onClick=${() => setDetailTab("turns")}
                  >${iconText(":repeat: Turns")}<//>
                </div>
                <div class="fleet-session-body" style=${{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: "4px" }}>
                  ${detailTab === "stream"
                    ? streamSessionId
                      ? html`<${ChatView} sessionId=${streamSessionId} readOnly=${true} />`
                      : html`
                          <div class="chat-view chat-empty-state">
                            <div class="session-empty-icon">${resolveIcon(":chat:")}</div>
                            <div class="session-empty-text">No linked chat session found for this slot</div>
                          </div>
                        `
                    : detailTab === "context"
                      ? (contextQuery || contextSessionId || contextTaskId || contextBranch)
                        ? html`<${ContextViewer}
                            query=${contextQuery}
                            sessionId=${contextSessionId}
                            taskId=${contextTaskId}
                            branch=${contextBranch}
                          />`
                        : html`
                            <div class="chat-view chat-empty-state">
                              <div class="session-empty-icon">${resolveIcon(":clipboard:")}</div>
                              <div class="session-empty-text">No context source available</div>
                            </div>
                          `
                      : detailTab === "diff"
                        ? diffSessionId
                          ? html`<${DiffViewer}
                              sessionId=${diffSessionId}
                              workspace=${diffWorkspace}
                              activitySummary=${selectedEntry?.session?.insights?.activityDiff || null}
                            />`
                          : html`
                              <div class="chat-view chat-empty-state">
                                <div class="session-empty-icon">${resolveIcon(":edit:")}</div>
                                <div class="session-empty-text">Diff requires a linked session</div>
                              </div>
                            `
                        : detailTab === "logs"
                          ? html`<div class="workspace-log fleet-session-log" ref=${logRef}>${focusedLogText}</div>`
                          : detailTab === "turns"
                            ? (() => {
                                const timeline = buildTurnTimeline(streamSessionId
                                  && String(sessionMessagesSessionId.value || "") === String(streamSessionId)
                                  ? (sessionMessages.value || [])
                                  : [], selectedEntry?.session?.turns || []);
                                return timeline.length
                                  ? html`<div class="fleet-turn-timeline">
                                      ${timeline.map((turn) => html`
                                        <div class="task-card fleet-turn-card" key=${"turn-" + turn.turnIndex}>
                                          <div class="task-card-header">
                                            <div>
                                              <div class="task-card-title">Turn ${Number(turn.turnIndex || 0) + 1}</div>
                                              <div class="task-card-meta">${formatTurnTokens(turn)} · ${formatMsDuration(turn.durationMs || 0)} · ${turn.status || "unknown"}</div>
                                            </div>
                                          </div>
                                          <div class="meta-text">${turn.user?.content ? "User: " + truncate(String(turn.user.content), 180) : "User: —"}</div>
                                          <div class="meta-text">${turn.assistant?.content ? "Assistant: " + truncate(String(turn.assistant.content), 220) : "Assistant: pending"}</div>
                                        </div>
                                      `)}
                                    </div>`
                                  : html`<div class="chat-view chat-empty-state">
                                      <div class="session-empty-icon">${resolveIcon(":repeat:")}</div>
                                      <div class="session-empty-text">No turn timeline available yet</div>
                                    </div>`;
                              })()
                            : null}
                </div>
              `
            : html`
                <div class="chat-view chat-empty-state">
                  <div class="session-empty-icon">${resolveIcon(":chat:")}</div>
                  <div class="session-empty-text">Select a slot to open full session view</div>
                </div>
              `}
        </div>
      </div>
    <//>
  `;
}

/* ─── Fleet Sessions Tab (standalone) ─── */
export function FleetSessionsTab() {
  const executor = executorData.value;
  const execData = executor?.data;
  const slots = execData?.workspaceSummary?.slots || execData?.slots || [];
  const [taskFallbackEntries, setTaskFallbackEntries] = useState([]);
  const [fleetSessionsSnapshot, setFleetSessionsSnapshot] = useState([]);

  useEffect(() => {
    let active = true;
    const refreshTaskSessions = async () => {
      if (!active || document.hidden) return;
      const sessions = await loadSessions({ type: "task", workspace: "all" });
      if (!active) return;
      if (Array.isArray(sessions)) {
        setFleetSessionsSnapshot(sessions);
      }
    };
    void refreshTaskSessions();
    const interval = setInterval(refreshTaskSessions, 15000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const loadFallbackTasks = () => {
      if (!active || document.hidden) return;
      apiFetch("/api/tasks?limit=1000", { _silent: true })
        .then((res) => {
          if (!active) return;
          const rows = Array.isArray(res?.data) ? res.data : [];
          const filtered = rows.filter((task) => {
            const status = String(task?.status || "").trim().toLowerCase();
            return status === "inprogress" || status === "inreview";
          });
          setTaskFallbackEntries(filtered);
        })
        .catch(() => {
          if (active) setTaskFallbackEntries([]);
        });
    };
    loadFallbackTasks();
    const interval = setInterval(loadFallbackTasks, 20000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  /* Force stop a specific agent slot */
  const handleForceStop = async (slot) => {
    const ok = await showConfirm(
      `Force-stop agent working on "${truncate(slot.taskTitle || slot.taskId || "task", 40)}"?`,
    );
    if (!ok) return;
    haptic("heavy");
    try {
      await apiFetch("/api/executor/stop-slot", {
        method: "POST",
        body: JSON.stringify({ slotIndex: slot.index, taskId: slot.taskId }),
      });
      showToast("Stop signal sent", "success");
      scheduleRefresh(200);
    } catch {
      /* toast via apiFetch */
    }
  };

  /* Open workspace viewer for an agent */
  const [selectedAgent, setSelectedAgent] = useState(null);
  const openWorkspace = (slot, i) => {
    haptic();
    setSelectedAgent({ ...slot, index: i });
  };

  return html`
    <div class="fleet-layout">
      <div class="fleet-span">
        <${FleetSessionsPanel}
          slots=${slots}
          sessions=${fleetSessionsSnapshot}
          taskFallbackEntries=${taskFallbackEntries}
          onOpenWorkspace=${openWorkspace}
          onForceStop=${handleForceStop}
        />
      </div>
    </div>
    ${selectedAgent && html`
      <${WorkspaceViewer}
        agent=${selectedAgent}
        onClose=${() => setSelectedAgent(null)}
      />
    `}
  `;
}
