/* ─────────────────────────────────────────────────────────────
 *  Kanban Board Component — GitHub Projects-style task board
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useRef, useEffect, useMemo, useLayoutEffect } from "preact/hooks";
import htm from "htm";
import { signal, computed } from "@preact/signals";
import {
  tasksData,
  tasksLoaded,
  tasksPage,
  showToast,
  runOptimistic,
  loadTasks,
  normalizeTaskLifecycleStatus,
  classifyTaskLifecycleAction,
  mergeTaskRecords,
  KANBAN_PAGE_SIZE,
} from "../modules/state.js";
import { apiFetch } from "../modules/api.js";
import { haptic, showConfirm } from "../modules/telegram.js";
import { formatRelative, truncate, cloneValue } from "../modules/utils.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { getAgentDisplay } from "../modules/agent-display.js";
import { buildTaskHierarchyModel, deriveTaskHierarchyView, getTaskHierarchyTaskType } from "../modules/task-hierarchy.js";
import { AppContextMenu, useContextMenuState } from "./context-menu.js";
import { Card, CardContent, Chip, IconButton, TextField, InputAdornment, Typography, Box, Stack, Button, Menu, MenuItem, Paper, Tooltip, Badge, Divider } from "@mui/material";

const html = htm.bind(h);

/* ─── Column definitions ─── */
const COLUMN_MAP = {
  draft: ["draft"],
  backlog: ["backlog", "open", "new", "todo"],
  blocked: ["blocked", "error", "failed"],
  inProgress: ["in-progress", "inprogress", "working", "active", "assigned"],
  inReview: ["in-review", "inreview", "review", "pr-open", "pr-review"],
  done: ["done", "completed", "closed", "merged", "cancelled"],
};

const COLUMNS = [
  { id: "draft", title: "Drafts", icon: "\u{1F4DD}", color: "var(--color-warning, #f59e0b)" },
  { id: "backlog", title: "Backlog", icon: "\u{1F4CB}", color: "var(--text-secondary)" },
  { id: "blocked", title: "Blocked", icon: "\u26D4", color: "var(--color-error, #ef4444)" },
  { id: "inProgress", title: "In Progress", icon: "\u{1F528}", color: "var(--color-inprogress, #3b82f6)" },
  { id: "inReview", title: "In Review", icon: "\u{1F440}", color: "var(--color-inreview, #f59e0b)" },
  { id: "done", title: "Done", icon: "\u2705", color: "var(--color-done, #22c55e)" },
];

const COLUMN_TO_STATUS = {
  draft: "draft",
  backlog: "todo",
  blocked: "blocked",
  inProgress: "inprogress",
  inReview: "inreview",
  done: "done",
};

const PRIORITY_COLORS = {
  critical: "var(--color-critical, #dc2626)",
  high: "var(--color-high, #f59e0b)",
  medium: "var(--color-medium, #3b82f6)",
  low: "var(--color-low, #8b95a2)",
};

const PRIORITY_LABELS = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

const LOAD_MORE_THRESHOLD_PX = 140;
const AUTO_LOAD_MAX_TASKS = 1000;
const KANBAN_BOARD_FILTER_SCHEMA_VERSION = 2;
const KANBAN_BOARD_FILTER_STORAGE_PREFIX = "kanban-board-filters";
const KANBAN_BOARD_FILTER_LEGACY_KEY = "ve-kanban-board-filters";
const KANBAN_BOARD_GLOBAL_SCOPE = "global";
const DEFAULT_BOARD_FILTERS = Object.freeze({ repo: "", assignee: "", priority: "", search: "" });
const BOARD_FILTER_KEYS = ["repo", "assignee", "priority", "search"];
const ALLOWED_PRIORITIES = new Set(["critical", "high", "medium", "low"]);
const MAX_FILTER_SEARCH_LENGTH = 120;

function matchTaskId(a, b) {
  return String(a) === String(b);
}

function getBoardFilterStorage(storage) {
  if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function normalizeBoardWorkspaceScope(workspaceId) {
  const raw = String(workspaceId || "").trim();
  return raw || KANBAN_BOARD_GLOBAL_SCOPE;
}

export function buildBoardFilterStorageKey(workspaceId) {
  return `${KANBAN_BOARD_FILTER_STORAGE_PREFIX}:${normalizeBoardWorkspaceScope(workspaceId)}`;
}

function trimFilterValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeBoardFilters(filters, options = {}) {
  const raw = filters && typeof filters === "object" ? filters : {};
  const result = { ...DEFAULT_BOARD_FILTERS };
  for (const key of BOARD_FILTER_KEYS) {
    result[key] = trimFilterValue(raw[key]);
  }
  result.search = result.search.slice(0, MAX_FILTER_SEARCH_LENGTH);

  if (!ALLOWED_PRIORITIES.has(result.priority)) result.priority = "";

  const repoSet = options?.allowedRepos instanceof Set ? options.allowedRepos : null;
  const assigneeSet = options?.allowedAssignees instanceof Set ? options.allowedAssignees : null;
  if (repoSet && repoSet.size > 0 && result.repo && !repoSet.has(result.repo)) result.repo = "";
  if (assigneeSet && assigneeSet.size > 0 && result.assignee && !assigneeSet.has(result.assignee)) result.assignee = "";
  return result;
}

function areBoardFiltersEqual(a, b) {
  return (
    String(a?.repo || "") === String(b?.repo || "") &&
    String(a?.assignee || "") === String(b?.assignee || "") &&
    String(a?.priority || "") === String(b?.priority || "") &&
    String(a?.search || "") === String(b?.search || "")
  );
}

function readRawPersistedBoardFilters(storage, key, workspaceScope) {
  const raw = storage?.getItem?.(key);
  if (!raw) return { filters: null, invalid: false, exists: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { filters: null, invalid: true, exists: true };
    if (parsed.version !== KANBAN_BOARD_FILTER_SCHEMA_VERSION) return { filters: null, invalid: true, exists: true };
    const payloadWorkspace = normalizeBoardWorkspaceScope(parsed.workspace);
    if (payloadWorkspace !== normalizeBoardWorkspaceScope(workspaceScope)) {
      return { filters: null, invalid: true, exists: true };
    }
    if (!parsed.filters || typeof parsed.filters !== "object") {
      return { filters: null, invalid: true, exists: true };
    }
    return { filters: parsed.filters, invalid: false, exists: true };
  } catch {
    return { filters: null, invalid: true, exists: true };
  }
}

function shouldRewritePersistedBoardFilters(rawFilters, sanitized) {
  if (!rawFilters || typeof rawFilters !== "object") return true;
  for (const key of BOARD_FILTER_KEYS) {
    if (trimFilterValue(rawFilters[key]) !== sanitized[key]) return true;
  }
  return false;
}

export function readPersistedBoardFilters({ storage, workspaceId, validateWith } = {}) {
  const resolvedStorage = getBoardFilterStorage(storage);
  if (!resolvedStorage) return { ...DEFAULT_BOARD_FILTERS };

  const workspaceScope = normalizeBoardWorkspaceScope(workspaceId);
  const scopedKey = buildBoardFilterStorageKey(workspaceScope);
  const scopedResult = readRawPersistedBoardFilters(resolvedStorage, scopedKey, workspaceScope);
  if (scopedResult.invalid) {
    persistBoardFilters({
      storage: resolvedStorage,
      workspaceId: workspaceScope,
      filters: DEFAULT_BOARD_FILTERS,
    });
    return { ...DEFAULT_BOARD_FILTERS };
  }

  let rawFilters = scopedResult.filters;
  if (!rawFilters && workspaceScope === KANBAN_BOARD_GLOBAL_SCOPE) {
    const legacyResult = readRawPersistedBoardFilters(
      resolvedStorage,
      KANBAN_BOARD_FILTER_LEGACY_KEY,
      workspaceScope,
    );
    rawFilters = legacyResult.filters;
    if (rawFilters) {
      persistBoardFilters({
        storage: resolvedStorage,
        workspaceId: workspaceScope,
        filters: rawFilters,
      });
    } else if (legacyResult.invalid) {
      resolvedStorage?.removeItem?.(KANBAN_BOARD_FILTER_LEGACY_KEY);
    }
  }

  const sanitized = sanitizeBoardFilters(rawFilters || DEFAULT_BOARD_FILTERS, validateWith);
  if (
    rawFilters &&
    shouldRewritePersistedBoardFilters(rawFilters, sanitized)
  ) {
    persistBoardFilters({
      storage: resolvedStorage,
      workspaceId: workspaceScope,
      filters: sanitized,
    });
  }
  return sanitized;
}

export function persistBoardFilters({ storage, workspaceId, filters } = {}) {
  const resolvedStorage = getBoardFilterStorage(storage);
  if (!resolvedStorage) return false;
  const workspaceScope = normalizeBoardWorkspaceScope(workspaceId);
  const payload = {
    version: KANBAN_BOARD_FILTER_SCHEMA_VERSION,
    workspace: workspaceScope,
    filters: sanitizeBoardFilters(filters),
  };
  try {
    resolvedStorage.setItem(buildBoardFilterStorageKey(workspaceScope), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function getColumnForStatus(status) {
  const s = (status || "").toLowerCase();
  for (const [col, statuses] of Object.entries(COLUMN_MAP)) {
    if (statuses.includes(s)) return col;
  }
  return "backlog";
}

function getTaskTags(task) {
  if (!task) return [];
  const raw = Array.isArray(task.tags) && task.tags.length
    ? task.tags
    : Array.isArray(task?.meta?.tags)
      ? task.meta.tags
      : [];
  return raw.filter((tag) => String(tag || "").trim().toLowerCase() !== "draft");
}

function getTaskBaseBranch(task) {
  if (!task) return "";
  return (
    task.baseBranch ||
    task.base_branch ||
    task.meta?.baseBranch ||
    task.meta?.base_branch ||
    ""
  );
}

function getTaskPrLinkage(task) {
  if (!task) return [];
  const records = [];
  const seen = new Set();
  const append = (record) => {
    if (!record || typeof record !== "object") return;
    const branchName = String(record.branchName || "").trim();
    const prUrl = String(record.prUrl || "").trim();
    const prNumber = Number.parseInt(String(record.prNumber ?? ""), 10);
    if (!branchName && !prUrl && !(Number.isFinite(prNumber) && prNumber > 0)) return;
    const normalized = {
      branchName,
      prUrl,
      prNumber: Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null,
      source: String(record.source || task?.meta?.prLinkageSource || "").trim(),
      freshness: String(record.freshness || task?.meta?.prLinkageFreshness || "").trim(),
      linkedAt: String(record.linkedAt || "").trim(),
      updatedAt: String(record.updatedAt || task?.meta?.prLinkageUpdatedAt || "").trim(),
    };
    const key = [normalized.branchName.toLowerCase(), normalized.prNumber || "", normalized.prUrl.toLowerCase()].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    records.push(normalized);
  };
  (Array.isArray(task.prLinkage) ? task.prLinkage : []).forEach(append);
  (Array.isArray(task?.meta?.prLinkage) ? task.meta.prLinkage : []).forEach(append);
  append(task);
  return records;
}

function getPrimaryTaskPrLinkage(task) {
  return getTaskPrLinkage(task)[0] || null;
}

function formatPrLinkageFreshnessLabel(linkage) {
  const freshness = String(linkage?.freshness || "").trim().toLowerCase();
  const timestamp = String(linkage?.updatedAt || linkage?.linkedAt || "").trim();
  const relative = timestamp ? formatRelative(timestamp) : "";
  if (freshness === "stale") {
    return relative ? `PR freshness: Stale (${relative})` : "PR freshness: Stale";
  }
  if (freshness === "fresh") {
    return relative ? `PR freshness: Fresh (${relative})` : "PR freshness: Fresh";
  }
  if (relative) {
    return `PR freshness: Updated ${relative}`;
  }
  return "PR freshness: Linked";
}

function getTaskRuntimeSnapshot(task) {
  return task?.runtimeSnapshot || task?.meta?.runtimeSnapshot || null;
}

function getTaskSharedReviewIncident(task) {
  if (String(task?.status || "").trim().toLowerCase() !== "inreview") return null;
  const reviewHealth = task?.meta?.reviewHealth;
  if (!reviewHealth || typeof reviewHealth !== "object") return null;
  if (String(reviewHealth.failureScope || "").trim().toLowerCase() !== "shared") return null;
  const failingJobs = Array.isArray(reviewHealth.failingJobs)
    ? reviewHealth.failingJobs.map((job) => String(job || "").trim()).filter(Boolean)
    : [];
  return {
    label: "SHARED CI",
    detail: failingJobs.length > 0
      ? `Shared CI incident on base branch: ${truncate(failingJobs.join(", "), 72)}`
      : "Shared CI incident on base branch.",
  };
}

function getTaskBlockedPreview(task) {
  const direct = String(
    task?.blockedReason ||
    task?.meta?.worktreeFailure?.blockedReason ||
    task?.meta?.blockedContext?.summary ||
    "",
  ).trim();
  if (direct) return direct;
  const timeline = Array.isArray(task?.timeline) ? task.timeline : [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const message = String(
      timeline[index]?.message ||
      timeline[index]?.reason ||
      timeline[index]?.error ||
      "",
    ).trim();
    if (/worktree failed|pre-pr validation failed|blocked/i.test(message)) {
      return message;
    }
  }
  return "";
}

function getTaskEpic(task) {
  return String(task?.epic || task?.epicName || task?.meta?.epic || task?.meta?.epicName || "").trim();
}

function getTaskSprint(task) {
  return String(task?.sprintName || task?.sprint || task?.meta?.sprintName || task?.meta?.sprintId || "").trim();
}

function getTaskStoryPoints(task) {
  const value = task?.storyPoints ?? task?.story_points ?? task?.points ?? task?.meta?.storyPoints;
  return Number.isFinite(Number(value)) && String(value).trim() !== "" ? String(value) : "";
}

function getTaskDueDate(task) {
  return String(task?.dueDate || task?.due_date || task?.meta?.dueDate || "").trim();
}

function getHierarchySortOrder(model, id) {
  return model?.originalOrderById?.get?.(String(id || "")) ?? Number.MAX_SAFE_INTEGER;
}

function summarizeChildStatusRollup(tasks = []) {
  const counts = { active: 0, review: 0, blocked: 0, done: 0, backlog: 0 };
  for (const task of tasks) {
    const status = String(task?.status || "").toLowerCase();
    if (COLUMN_MAP.inProgress.includes(status)) counts.active += 1;
    else if (COLUMN_MAP.inReview.includes(status)) counts.review += 1;
    else if (COLUMN_MAP.blocked.includes(status)) counts.blocked += 1;
    else if (COLUMN_MAP.done.includes(status)) counts.done += 1;
    else counts.backlog += 1;
  }
  return [
    counts.active ? `${counts.active} active` : "",
    counts.review ? `${counts.review} review` : "",
    counts.blocked ? `${counts.blocked} blocked` : "",
    counts.done ? `${counts.done} done` : "",
    counts.backlog ? `${counts.backlog} backlog` : "",
  ].filter(Boolean);
}

export function buildKanbanColumnItems(tasks = [], hierarchyView = null, hierarchyModel = null) {
  const rows = Array.isArray(tasks) ? [...tasks] : [];
  const groupedTaskIds = new Set();
  const coveredHeaderTaskIds = new Set();
  const groups = new Map();
  const taskById = hierarchyModel?.taskById || new Map();
  const epicGroupById = new Map((hierarchyView?.epicGroups || []).map((entry) => [String(entry.id || ""), entry]));
  rows.sort((left, right) => getHierarchySortOrder(hierarchyModel, left?.id) - getHierarchySortOrder(hierarchyModel, right?.id));

  const ensureGroup = (key, create) => {
    if (!groups.has(key)) groups.set(key, create());
    return groups.get(key);
  };

  for (const task of rows) {
    const taskId = String(task?.id || "");
    const node = hierarchyView?.nodeStateById?.get?.(taskId) || null;
    const parentId = String(node?.meta?.parentTaskId || "");
    if (parentId && hierarchyView?.nodeStateById?.get?.(parentId)?.isParentNode) {
      const parentNode = hierarchyView.nodeStateById.get(parentId);
      const parentTask = taskById.get(parentId) || parentNode?.task || null;
      const group = ensureGroup(`parent:${parentId}`, () => ({
        key: `parent:${parentId}`,
        kind: "parent",
        parentTask,
        parentNode,
        title: parentTask?.title || parentId,
        children: [],
      }));
      if (parentTask?.id) coveredHeaderTaskIds.add(String(parentTask.id));
      if (taskId === parentId) {
        coveredHeaderTaskIds.add(taskId);
        continue;
      }
      groupedTaskIds.add(taskId);
      group.children.push(task);
      continue;
    }

    const epicId = String(node?.meta?.epicId || "");
    const epicGroup = epicId ? epicGroupById.get(epicId) : null;
    const taskType = getTaskHierarchyTaskType(task, "task");
    if (epicGroup && epicGroup.visibleTaskCount > 1 && taskType !== "epic") {
      const anchorTask = epicGroup.anchorTaskId ? taskById.get(epicGroup.anchorTaskId) : null;
      const group = ensureGroup(`epic:${epicId}`, () => ({
        key: `epic:${epicId}`,
        kind: "epic",
        parentTask: anchorTask,
        parentNode: anchorTask ? hierarchyView?.nodeStateById?.get?.(String(anchorTask.id)) || null : null,
        epicGroup,
        title: epicGroup.label || epicId,
        children: [],
      }));
      if (anchorTask?.id) coveredHeaderTaskIds.add(String(anchorTask.id));
      if (anchorTask?.id && taskId === String(anchorTask.id)) {
        coveredHeaderTaskIds.add(taskId);
        continue;
      }
      groupedTaskIds.add(taskId);
      group.children.push(task);
    }
  }

  const items = [];
  for (const group of groups.values()) {
    if (!group.children.length) continue;
    group.children.sort((left, right) => getHierarchySortOrder(hierarchyModel, left?.id) - getHierarchySortOrder(hierarchyModel, right?.id));
    const groupOrder = group.parentTask?.id
      ? getHierarchySortOrder(hierarchyModel, group.parentTask.id)
      : Math.min(...group.children.map((entry) => getHierarchySortOrder(hierarchyModel, entry?.id)));
    items.push({
      kind: "group",
      order: groupOrder,
      group,
    });
  }

  for (const task of rows) {
    const taskId = String(task?.id || "");
    if (groupedTaskIds.has(taskId) || coveredHeaderTaskIds.has(taskId)) continue;
    items.push({
      kind: "task",
      order: getHierarchySortOrder(hierarchyModel, taskId),
      task,
    });
  }

  items.sort((left, right) => left.order - right.order);
  return items;
}

function getTaskTypeBadgeLabel(taskType) {
  const normalized = String(taskType || "task").toLowerCase();
  if (normalized === "epic") return "EPIC";
  if (normalized === "subtask") return "SUBTASK";
  return "TASK";
}

function isTerminalTaskStatus(status) {
  return ["done", "completed", "closed", "merged", "cancelled"].includes(String(status || "").toLowerCase());
}

function isBlockedTaskStatus(status) {
  return ["blocked", "error", "failed"].includes(String(status || "").toLowerCase());
}

function getKanbanGroupVisibleChildren(group, hierarchyModel = null) {
  if (!group || !hierarchyModel?.taskById) return [];
  if (group.kind === "parent") {
    return (group.parentNode?.visibleChildIds || [])
      .map((taskId) => hierarchyModel.taskById.get(String(taskId)))
      .filter(Boolean);
  }
  const anchorTaskId = String(group.parentTask?.id || group.epicGroup?.anchorTaskId || "");
  return (group.epicGroup?.visibleTaskIds || [])
    .map((taskId) => hierarchyModel.taskById.get(String(taskId)))
    .filter((task) => {
      if (!task) return false;
      const taskId = String(task.id || "");
      if (anchorTaskId && taskId === anchorTaskId) return false;
      return getTaskHierarchyTaskType(task, "task") !== "epic";
    });
}

function buildKanbanGroupSummary(group, col, hierarchyModel = null) {
  const parentTask = group?.parentTask || null;
  const taskType = group?.kind === "epic" ? "epic" : getTaskHierarchyTaskType(parentTask, "task");
  const visibleChildren = getKanbanGroupVisibleChildren(group, hierarchyModel);
  const totalChildren = visibleChildren.length || group?.children?.length || 0;
  const completedCount = visibleChildren.reduce((sum, task) => sum + (isTerminalTaskStatus(task?.status) ? 1 : 0), 0);
  const blockedCount = visibleChildren.reduce((sum, task) => sum + (isBlockedTaskStatus(task?.status) ? 1 : 0), 0);
  const collapseKey = group?.kind === "epic"
    ? (group?.epicGroup?.collapseKey || group?.parentNode?.collapseKey || group?.key)
    : (group?.parentNode?.collapseKey || group?.key);
  return {
    collapseKey,
    title: String(parentTask?.title || group?.title || "Grouped work").trim(),
    parentTaskId: String(parentTask?.id || ""),
    typeLabel: getTaskTypeBadgeLabel(taskType),
    totalChildren,
    blockedCount,
    columnChildCount: group?.children?.length || 0,
    progressLabel: totalChildren > 0 ? `${completedCount}/${totalChildren} done` : null,
    statusLabel: parentTask?.status ? getTaskStatusLabel(parentTask.status) : null,
    columnLabel: group?.children?.length ? `${group.children.length} in ${col?.title || "this column"}` : null,
    statusRollup: summarizeChildStatusRollup(visibleChildren),
  };
}

function getTaskStatusLabel(status) {
  const columnId = getColumnForStatus(status);
  return COLUMNS.find((column) => column.id === columnId)?.title || "Task";
}

/* ─── Derived column data ─── */
const columnData = computed(() => {
  const tasks = tasksData.value || [];
  const cols = {};
  for (const col of COLUMNS) {
    cols[col.id] = [];
  }
  for (const task of tasks) {
    const col = getColumnForStatus(task.status);
    if (cols[col]) cols[col].push(task);
  }
  return cols;
});

/* ─── Drag state (module-level signals) ─── */
const dragTaskId = signal(null);
const dragOverCol = signal(null);

/* ─── Touch drag state ─── */
const touchDragId = signal(null);
const touchOverCol = signal(null);
let _touchClone = null;
let _touchStartX = 0;
let _touchStartY = 0;
let _touchMoved = false;
let _touchDragReady = false;
let _touchHoldTimer = null;
let _touchSuppressClickUntil = 0;

const TOUCH_DRAG_DELAY_MS = 180;
const TOUCH_DRAG_START_PX = 6;
const TOUCH_CANCEL_PX = 14;

function queueBoardTasksRefresh() {
  // Reset to page 0 so both the upcoming WS-triggered refresh and our own
  // delayed refresh fetch the first page, replacing the full dataset with
  // fresh data. Without this, a stale tasksPage > 0 causes loadTasks() to
  // fetch only a later page and overwrite the full list, making tasks vanish.
  if (tasksPage) tasksPage.value = 0;
  setTimeout(() => {
    void loadTasks({ pageSize: KANBAN_PAGE_SIZE });
  }, 500);
}

/* ─── Touch drag helpers ─── */

function _createTouchClone(el) {
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.className = "kanban-card touch-drag-clone";
  clone.style.position = "fixed";
  clone.style.width = rect.width + "px";
  clone.style.left = rect.left + "px";
  clone.style.top = rect.top + "px";
  clone.style.zIndex = "9999";
  clone.style.pointerEvents = "none";
  document.body.appendChild(clone);
  return clone;
}

function _moveTouchClone(clone, x, y) {
  if (!clone) return;
  const w = parseFloat(clone.style.width) || 0;
  clone.style.left = (x - w / 2) + "px";
  clone.style.top = (y - 40) + "px";
}

function _removeTouchClone() {
  if (_touchClone && _touchClone.parentNode) {
    _touchClone.parentNode.removeChild(_touchClone);
  }
  _touchClone = null;
}

function _clearTouchHoldTimer() {
  if (_touchHoldTimer) {
    clearTimeout(_touchHoldTimer);
    _touchHoldTimer = null;
  }
}

function _setTouchDragActive(active) {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("kanban-dragging", active);
}

function _columnFromPoint(x, y) {
  const elements = document.elementsFromPoint
    ? document.elementsFromPoint(x, y)
    : [document.elementFromPoint(x, y)].filter(Boolean);
  for (const el of elements) {
    if (!el?.closest) continue;
    const colEl = el.closest(".kanban-column");
    if (!colEl) continue;
    for (const col of COLUMNS) {
      if (colEl.getAttribute("data-col") === col.id) return col.id;
    }
  }
  return null;
}


async function confirmBoardTaskTransition(task, newStatus) {
  const prev = normalizeTaskLifecycleStatus(task?.status || "todo");
  const next = normalizeTaskLifecycleStatus(newStatus);
  const action = classifyTaskLifecycleAction(prev, next);
  const taskLabel = String(task?.title || task?.id || "this task").trim();

  if (action === "start") {
    const ok = await showConfirm(
      `Start ${taskLabel} now? This dispatches or resumes execution immediately.`,
    );
    return { ok, action, nextStatus: "inprogress" };
  }

  if (action === "pause") {
    const ok = await showConfirm(
      `Pause ${taskLabel} and move it back to backlog? You can resume by moving it to In Progress again.`,
    );
    return { ok, action, nextStatus: next === "draft" ? "draft" : "todo" };
  }

  return { ok: true, action, nextStatus: next };
}

async function executeBoardTransition(task, newStatus, columnLabel) {
  if (!task?.id) return { ok: false, cancelled: true, action: "noop" };
  const decision = await confirmBoardTaskTransition(task, newStatus);
  if (!decision.ok) return { ok: false, cancelled: true, action: decision.action };

  const taskId = task.id;
  const wantsDraft = decision.nextStatus === "draft";
  const optimisticStatus = decision.action === "start" ? "inprogress" : decision.nextStatus;
  const prev = cloneValue(tasksData.value);

  await runOptimistic(
    () => {
      tasksData.value = tasksData.value.map((t) =>
        matchTaskId(t.id, taskId) ? { ...t, status: optimisticStatus, draft: wantsDraft } : t,
      );
    },
    async () => {
      if (decision.action === "start") {
        const startRes = await apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId }),
        });
        const detail = await apiFetch(
          `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
          { _silent: true },
        ).catch(() => null);
        const merged = detail?.data || startRes?.data || null;
        if (merged) {
          tasksData.value = tasksData.value.map((t) =>
            matchTaskId(t.id, taskId) ? mergeTaskRecords(t, merged) : t,
          );
        }
        return startRes;
      }

      const res = await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          status: decision.nextStatus,
          draft: wantsDraft,
          lifecycleAction: decision.action,
          pauseExecution: decision.action === "pause",
        }),
      });
      if (res?.data) {
        tasksData.value = tasksData.value.map((t) =>
          matchTaskId(t.id, taskId) ? mergeTaskRecords(t, res.data) : t,
        );
      }
      return res;
    },
    () => {
      tasksData.value = prev;
    },
  );

  showToast(`Moved to ${columnLabel || "updated status"}`, "success");
  queueBoardTasksRefresh();
  return { ok: true, cancelled: false, action: decision.action, status: optimisticStatus };
}

async function _handleTouchDrop(colId) {
  const taskId = touchDragId.value;
  touchDragId.value = null;
  touchOverCol.value = null;
  if (!taskId || !colId) return;

  const currentTask = (tasksData.value || []).find((t) => matchTaskId(t.id, taskId));
  if (!currentTask) return;
  const currentCol = getColumnForStatus(currentTask.status);
  if (currentCol === colId) return;

  const newStatus = COLUMN_TO_STATUS[colId] || "todo";
  const col = COLUMNS.find((c) => c.id === colId);
  haptic("medium");

  try {
    await executeBoardTransition(currentTask, newStatus, col?.title || colId);
  } catch (err) {
    showToast(err?.message || "Failed to move task", "error");
  }
}

/* ─── Inline create for a column ─── */
async function createTaskInColumn(columnStatus, title) {
  haptic("medium");
  try {
    await apiFetch("/api/tasks/create", {
      method: "POST",
      body: JSON.stringify({
        title,
        status: columnStatus,
        draft: columnStatus === "draft",
      }),
    });
    showToast("Task created", "success");
    await loadTasks();
  } catch {
    /* toast via apiFetch */
  }
}

/* ─── KanbanCard ─── */
function KanbanCard({ task, onOpen, onContextMenu = null, compact = false, nested = false }) {
  const onDragStart = useCallback((e) => {
    dragTaskId.value = task.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
    e.currentTarget.classList.add("dragging");
  }, [task.id]);

  const onDragEnd = useCallback((e) => {
    dragTaskId.value = null;
    e.currentTarget.classList.remove("dragging");
  }, [task.id]);

  /* ─ Touch drag handlers ─ */
  const onTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch || e.touches.length > 1) return;
    _touchStartX = touch.clientX;
    _touchStartY = touch.clientY;
    _touchMoved = false;
    _touchDragReady = false;
    _clearTouchHoldTimer();
    _touchHoldTimer = setTimeout(() => {
      _touchDragReady = true;
      _touchHoldTimer = null;
    }, TOUCH_DRAG_DELAY_MS);
  }, [task.id]);

  const onTouchMove = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - _touchStartX;
    const dy = touch.clientY - _touchStartY;

    // Only start drag after a small threshold to distinguish from scroll
    const movedFar = Math.abs(dx) > TOUCH_CANCEL_PX || Math.abs(dy) > TOUCH_CANCEL_PX;
    if (!_touchDragReady) {
      if (movedFar) {
        _clearTouchHoldTimer();
        touchDragId.value = null;
        touchOverCol.value = null;
      }
      return;
    }

    if (!_touchMoved && Math.abs(dx) < TOUCH_DRAG_START_PX && Math.abs(dy) < TOUCH_DRAG_START_PX) return;

    if (!_touchMoved) {
      _touchMoved = true;
      touchDragId.value = task.id;
      _removeTouchClone();
      _touchClone = _createTouchClone(e.currentTarget);
      _setTouchDragActive(true);
      haptic("medium");
    }

    e.preventDefault(); // prevent scroll during drag
    _moveTouchClone(_touchClone, touch.clientX, touch.clientY);

    const colId = _columnFromPoint(touch.clientX, touch.clientY);
    touchOverCol.value = colId;
  }, []);

  const onTouchEnd = useCallback((e) => {
    _clearTouchHoldTimer();
    const colId = touchOverCol.value;
    _removeTouchClone();
    if (_touchMoved) {
      _touchSuppressClickUntil = Date.now() + 350;
      if (e?.preventDefault) e.preventDefault();
    }
    if (_touchMoved && colId) {
      _handleTouchDrop(colId);
    } else {
      touchDragId.value = null;
      touchOverCol.value = null;
    }
    _touchMoved = false;
    _touchDragReady = false;
    _setTouchDragActive(false);
  }, []);

  const onTouchCancel = useCallback(() => {
    _clearTouchHoldTimer();
    _removeTouchClone();
    touchDragId.value = null;
    touchOverCol.value = null;
    _touchMoved = false;
    _touchDragReady = false;
    _setTouchDragActive(false);
  }, []);

  const priorityColor = PRIORITY_COLORS[task.priority] || null;
  const priorityLabel = PRIORITY_LABELS[task.priority] || null;
  const tags = getTaskTags(task);
  const baseBranch = getTaskBaseBranch(task);
  const runtime = getTaskRuntimeSnapshot(task);
  const epic = getTaskEpic(task);
  const sprint = getTaskSprint(task);
  const storyPoints = getTaskStoryPoints(task);
  const dueDate = getTaskDueDate(task);
  const blockedPreview = getTaskBlockedPreview(task);
  const prLinkage = getPrimaryTaskPrLinkage(task);
  const sharedReviewIncident = getTaskSharedReviewIncident(task);
  const taskType = getTaskHierarchyTaskType(task, "task");
  const repoName = task.repo || task.repository || "";
  const issueNum = task.issueNumber || task.issue_number || (typeof task.id === "string" && /^\d+$/.test(task.id) ? task.id : null);
  const hasAgent = Boolean(
    task?.assignee ||
    task?.meta?.execution?.sdk ||
    task?.meta?.execution?.executor ||
    task?.sdk ||
    task?.executor ||
    task?.agent ||
    task?.agentName,
  );
  const agentDisplay = hasAgent ? getAgentDisplay(task) : null;

  const isDragging = dragTaskId.value === task.id || (touchDragId.value === task.id && _touchMoved);
  const cardClassName = [
    "kanban-card",
    isDragging ? "dragging" : "",
    compact ? "kanban-card-compact" : "",
    nested ? "kanban-card-nested" : "",
    compact ? "kanban-card-checklist" : "",
  ].filter(Boolean).join(" ");
  const compactStatusTone = isTerminalTaskStatus(task?.status)
    ? "done"
    : isBlockedTaskStatus(task?.status)
      ? "blocked"
      : "open";
  const compactIndicator = compactStatusTone === "done"
    ? "✓"
    : compactStatusTone === "blocked"
      ? "!"
      : "•";

  return html`
    <${Card}
      className=${cardClassName}
      data-task-type=${taskType}
      sx=${{
        cursor: 'pointer',
        mb: 1,
        opacity: isDragging ? 0.5 : 1,
        transition: 'box-shadow 0.2s, opacity 0.2s',
        '&:hover': { boxShadow: 3 },
      }}
      draggable="true"
      onDragStart=${onDragStart}
      onDragEnd=${onDragEnd}
      onTouchStart=${onTouchStart}
      onTouchMove=${onTouchMove}
      onTouchEnd=${onTouchEnd}
      onTouchCancel=${onTouchCancel}
      onClick=${() => {
        if (Date.now() < _touchSuppressClickUntil) return;
        onOpen(task.id);
      }}
      onContextMenu=${(event) => {
        if (typeof onContextMenu !== "function") return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, event);
      }}
    >
      <${CardContent} sx=${{ p: compact ? '8px !important' : '10px !important', '&:last-child': { pb: compact ? '8px !important' : '10px !important' } }}>
        ${compact
          ? html`
              <div class="kanban-checklist-row">
                <span class="kanban-checklist-mark kanban-checklist-mark-${compactStatusTone}" aria-hidden="true">${compactIndicator}</span>
                <div class="kanban-checklist-body">
                  <div class="kanban-checklist-topline">
                    <span class="kanban-checklist-type">${getTaskTypeBadgeLabel(taskType)}</span>
                    <span class="kanban-checklist-title">${truncate(task.title || "(untitled)", 72)}</span>
                  </div>
                  <div class="kanban-checklist-meta">
                    <span>${getTaskStatusLabel(task.status)}</span>
                    ${(issueNum || task.pr) && html`<span>${task.pr ? '#' + task.pr : '#' + issueNum}</span>`}
                    ${priorityLabel && html`<span>${priorityLabel}</span>`}
                    ${task.created_at && html`<span>${formatRelative(task.created_at)}</span>`}
                    ${agentDisplay && html`
                      <${Tooltip} title=${agentDisplay.label}>
                        <span class="kanban-icon-cap">${agentDisplay.icon}</span>
                      </${Tooltip}>
                    `}
                  </div>
                  ${String(task?.status || "").toLowerCase() === "blocked" && html`
                    <div class="kanban-checklist-note">${truncate(blockedPreview || "Blocked task. Open details for diagnostics.", 72)}</div>
                  `}
                </div>
              </div>
            `
          : html`
              <${Stack} direction="row" spacing=${0.5} alignItems="center" flexWrap="wrap" sx=${{ mb: 0.5 }}>
                ${repoName && html`
                  <${Typography} variant="caption" color="text.secondary">${repoName}</${Typography}>
                `}
                ${(issueNum || task.pr) && html`
                  <${Typography} variant="caption" color="text.secondary">${task.pr ? '#' + task.pr : '#' + issueNum}</${Typography}>
                `}
                ${priorityLabel && html`
                  <${Chip} label=${priorityLabel} size="small" sx=${{ backgroundColor: priorityColor, color: '#fff', height: 18, fontSize: '0.65rem' }} />
                `}
                ${runtime?.state === "running" && html`
                  <${Chip} label="LIVE" size="small" color="success" sx=${{ height: 18, fontSize: '0.65rem' }} />
                `}
                ${runtime?.state === "queued" && html`
                  <${Chip} label="QUEUED" size="small" color="warning" sx=${{ height: 18, fontSize: '0.65rem' }} />
                `}
                ${sharedReviewIncident && html`
                  <${Chip} label=${sharedReviewIncident.label} size="small" color="warning" variant="outlined" sx=${{ height: 18, fontSize: '0.65rem', fontWeight: 700 }} />
                `}
              </${Stack}>
              <${Typography} variant="body2" fontWeight=${500}>${truncate(task.title || "(untitled)", 80)}</${Typography}>
              ${task.description && html`
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: 'block', mt: 0.5 }}>${truncate(task.description, 72)}</${Typography}>
              `}
              ${sharedReviewIncident && html`
                <${Typography} variant="caption" sx=${{ display: 'block', mt: 0.5, color: 'var(--color-warning, #f59e0b)', fontWeight: 600 }}>
                  ${sharedReviewIncident.detail}
                </${Typography}>
              `}
              ${String(task?.status || "").toLowerCase() === "blocked" && html`
                <${Typography} variant="caption" sx=${{ display: 'block', mt: 0.5, color: 'var(--color-error, #ef4444)', fontWeight: 600 }}>
                  ${truncate(blockedPreview || "Blocked task. Open details for diagnostics.", 96)}
                </${Typography}>
              `}
              ${(epic || sprint || storyPoints || dueDate) && html`
                <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" sx=${{ mt: 0.75 }}>
                  ${epic && html`<${Chip} label=${`Epic: ${truncate(epic, 18)}`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${sprint && html`<${Chip} label=${`Sprint: ${truncate(sprint, 18)}`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${storyPoints && html`<${Chip} label=${`${storyPoints} pts`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${dueDate && html`<${Chip} label=${`Due: ${truncate(dueDate, 18)}`} size="small" variant="outlined" color="warning" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                </${Stack}>
              `}
              ${prLinkage && html`
                <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" sx=${{ mt: 0.75 }}>
                  ${prLinkage.prNumber && html`<${Chip} label=${`PR #${prLinkage.prNumber}`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${prLinkage.branchName && html`<${Chip} label=${`Branch: ${truncate(prLinkage.branchName, 18)}`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${prLinkage.source && html`<${Chip} label=${`PR source: ${truncate(prLinkage.source, 16)}`} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                  ${(prLinkage.freshness || prLinkage.updatedAt || prLinkage.linkedAt) && html`<${Chip} label=${formatPrLinkageFreshnessLabel(prLinkage)} size="small" color=${prLinkage.freshness === "stale" ? "warning" : "success"} sx=${{ height: 20, fontSize: '0.65rem' }} />`}
                </${Stack}>
              `}
              ${baseBranch && html`
                <${Typography} variant="caption" color="text.secondary" sx=${{ display: 'block', mt: 0.5 }}>Base: ${truncate(baseBranch, 24)}</${Typography}>
              `}
              ${tags.length > 0 && html`
                <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" sx=${{ mt: 0.5 }}>
                  ${tags.map((tag) => html`<${Chip} key=${tag} label=${'#' + tag} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`)}
                </${Stack}>
              `}
              <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ mt: 0.5 }}>
                ${agentDisplay && html`
                  <${Tooltip} title=${agentDisplay.label}>
                    <span class="kanban-icon-cap">${agentDisplay.icon}</span>
                  </${Tooltip}>
                `}
                <${Typography} variant="caption" color="text.secondary">${typeof task.id === "string" ? truncate(task.id, 12) : task.id}</${Typography}>
                ${task.created_at && html`<${Typography} variant="caption" color="text.secondary">${formatRelative(task.created_at)}</${Typography}>`}
              </${Stack}>
            `}
      </${CardContent}>
    </${Card}>
  `;
}

function KanbanGroupShell({
  group,
  col,
  hierarchyModel = null,
  onOpen,
  onContextMenu = null,
  collapsed = false,
  onToggleCollapse = null,
  forceExpanded = false,
}) {
  const summary = buildKanbanGroupSummary(group, col, hierarchyModel);
  const isCollapsed = forceExpanded ? false : collapsed;
  const parentClickable = summary.parentTaskId && typeof onOpen === "function";
  const shellClassName = [
    "kanban-group-shell",
    group?.kind === "epic" ? "kanban-group-shell-epic" : "kanban-group-shell-parent",
    isCollapsed ? "is-collapsed" : "is-expanded",
  ].join(" ");
  const headerContent = html`
    <span class="kanban-group-shell-type">${summary.typeLabel}</span>
    <span class="kanban-group-shell-title">${truncate(summary.title, 92)}</span>
  `;

  return html`
    <section class=${shellClassName} data-group-kind=${group?.kind || "group"}>
      <div class="kanban-group-shell-head">
        <button
          type="button"
          class="kanban-group-shell-toggle"
          aria-expanded=${String(!isCollapsed)}
          aria-label=${`${isCollapsed ? "Expand" : "Collapse"} ${summary.title}`}
          onClick=${() => onToggleCollapse?.(summary.collapseKey)}
        >
          ${isCollapsed ? "▸" : "▾"}
        </button>
        ${parentClickable
          ? html`
              <button type="button" class="kanban-group-shell-open" onClick=${() => onOpen(summary.parentTaskId)}>
                ${headerContent}
              </button>
            `
          : html`<div class="kanban-group-shell-open is-static">${headerContent}</div>`}
      </div>
      <div class="kanban-group-shell-pills">
        ${summary.progressLabel && html`<span class="kanban-group-pill">${summary.progressLabel}</span>`}
        ${summary.statusLabel && html`<span class="kanban-group-pill">${summary.statusLabel}</span>`}
        ${summary.columnLabel && html`<span class="kanban-group-pill">${summary.columnLabel}</span>`}
        ${summary.blockedCount > 0 && html`<span class="kanban-group-pill kanban-group-pill-blocked">${summary.blockedCount} blocked</span>`}
      </div>
      ${summary.statusRollup.length > 0 && html`
        <div class="kanban-group-shell-rollup">
          ${summary.statusRollup.map((label) => html`<span key=${label} class="kanban-group-rollup-item">${label}</span>`)}
        </div>
      `}
      ${isCollapsed
        ? html`<div class="kanban-group-shell-collapsed-note">${summary.columnChildCount} child tasks hidden</div>`
        : html`
            <div class=${`kanban-group-children ${group?.kind === "epic" ? "kanban-group-children-rich" : "kanban-group-children-checklist"}`}>
              ${group.children.map((task) => html`
                <${KanbanCard}
                  key=${task.id}
                  task=${task}
                  onOpen=${onOpen}
                  onContextMenu=${onContextMenu}
                  compact=${group?.kind !== "epic"}
                  nested=${true}
                />
              `)}
            </div>
          `}
    </section>
  `;
}

/* ─── KanbanColumn ─── */
function KanbanColumn({
  col,
  tasks,
  hierarchyView = null,
  hierarchyModel = null,
  onOpen,
  onTaskContextMenu = null,
  collapsedGroups = {},
  onToggleGroupCollapse = null,
  forceExpanded = false,
  totalCount = 0,
  hasMoreTasks = false,
  loadingMoreTasks = false,
  onLoadMoreTasks = null,
  autoLoadMore = true,
  globalTaskCount = 0,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const inputRef = useRef(null);
  const cardsRef = useRef(null);
  const tailSentinelRef = useRef(null);
  const lastAutoLoadCountRef = useRef(-1);

  useEffect(() => {
    if (showCreate && inputRef.current) inputRef.current.focus();
  }, [showCreate]);

  const triggerLoadMore = useCallback(() => {
    if (!hasMoreTasks || loadingMoreTasks || typeof onLoadMoreTasks !== "function") return false;
    void onLoadMoreTasks();
    return true;
  }, [hasMoreTasks, loadingMoreTasks, onLoadMoreTasks]);

  useEffect(() => {
    if (!autoLoadMore || !hasMoreTasks || typeof onLoadMoreTasks !== "function") {
      lastAutoLoadCountRef.current = -1;
      return;
    }
    const root = cardsRef.current;
    const sentinel = tailSentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = globalTaskCount;
          if (lastAutoLoadCountRef.current === key || loadingMoreTasks) continue;
          lastAutoLoadCountRef.current = key;
          void onLoadMoreTasks();
        }
      },
      {
        root,
        rootMargin: "0px 0px 160px 0px",
        threshold: 0,
      },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [autoLoadMore, hasMoreTasks, loadingMoreTasks, onLoadMoreTasks, globalTaskCount]);

  useLayoutEffect(() => {
    const root = cardsRef.current;
    if (!autoLoadMore || !root || !hasMoreTasks || loadingMoreTasks || typeof onLoadMoreTasks !== "function") return;
    const remaining = root.scrollHeight - root.scrollTop - root.clientHeight;
    const underfilled = root.scrollHeight <= root.clientHeight + LOAD_MORE_THRESHOLD_PX;
    if (!underfilled && remaining > LOAD_MORE_THRESHOLD_PX) return;
    const key = globalTaskCount;
    if (lastAutoLoadCountRef.current === key) return;
    lastAutoLoadCountRef.current = key;
    void onLoadMoreTasks();
  }, [autoLoadMore, hasMoreTasks, loadingMoreTasks, onLoadMoreTasks, globalTaskCount, showCreate]);

  const onCardsScroll = useCallback((event) => {
    if (!autoLoadMore) return;
    const el = event?.currentTarget;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining > LOAD_MORE_THRESHOLD_PX) return;
    lastAutoLoadCountRef.current = globalTaskCount;
    triggerLoadMore();
  }, [autoLoadMore, globalTaskCount, triggerLoadMore]);

  const onCardsWheel = useCallback((event) => {
    const el = event?.currentTarget;
    if (!el) return;
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX || 0)) return;
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    if (!canScroll) return;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) return;
    event.stopPropagation();
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dragOverCol.value = col.id;
  }, [col.id]);

  const onDragLeave = useCallback(() => {
    if (dragOverCol.value === col.id) dragOverCol.value = null;
  }, [col.id]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    dragOverCol.value = null;
    const taskId = e.dataTransfer.getData("text/plain") || dragTaskId.value;
    dragTaskId.value = null;
    if (!taskId) return;

    const currentTask = (tasksData.value || []).find((t) => matchTaskId(t.id, taskId));
    if (!currentTask) return;
    const currentCol = getColumnForStatus(currentTask.status);
    if (currentCol === col.id) return;

    const newStatus = COLUMN_TO_STATUS[col.id] || "todo";
    const leavingDraft = currentCol === "draft" && col.id !== "draft";
    haptic("medium");

    const prev = cloneValue(tasksData.value);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            matchTaskId(t.id, taskId) ? { ...t, status: newStatus, ...(leavingDraft ? { draft: false } : {}) } : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/update", {
            method: "POST",
            body: JSON.stringify({ taskId, status: newStatus, ...(leavingDraft ? { draft: false } : {}) }),
          });
          if (res?.data) {
            tasksData.value = tasksData.value.map((t) =>
              matchTaskId(t.id, taskId) ? mergeTaskRecords(t, res.data) : t,
            );
          }
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      showToast(`Moved to ${col.title}`, "success");
      queueBoardTasksRefresh();
    } catch (err) {
      showToast(err?.message || "Failed to move task", "error");
    }
  }, [col.id, col.title]);

  const handleInlineKeyDown = useCallback((e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      createTaskInColumn(COLUMN_TO_STATUS[col.id] || "todo", e.target.value.trim());
      e.target.value = "";
      setShowCreate(false);
    }
    if (e.key === "Escape") {
      setShowCreate(false);
    }
  }, [col.id]);

  const isOver = dragOverCol.value === col.id || touchOverCol.value === col.id;
  const liveCount = tasks.length;
  const columnItems = useMemo(
    () => buildKanbanColumnItems(tasks, hierarchyView, hierarchyModel),
    [tasks, hierarchyView, hierarchyModel],
  );
  const serverCount = Number.isFinite(Number(totalCount)) && Number(totalCount) > 0 ? Number(totalCount) : 0;
  const countLabel = hasMoreTasks
    ? (serverCount > liveCount ? `${liveCount}/${serverCount}` : `${liveCount}+`)
    : liveCount;

  return html`
    <div
      class="kanban-column ${isOver ? 'drag-over' : ''}"
      data-col=${col.id}
      onDragOver=${onDragOver}
      onDragLeave=${onDragLeave}
      onDrop=${onDrop}
    >
      <${Box} className="kanban-column-head" sx=${{ display: 'flex', alignItems: 'center', gap: 1, p: 1, borderBottom: '2px solid ' + col.color }}>
        <${Typography} variant="subtitle2">${col.icon} ${col.title}</${Typography}>
        <${Chip} label=${countLabel} size="small" />
        <${IconButton} size="small" onClick=${() => { setShowCreate(!showCreate); haptic(); }} title=${"Add task to " + col.title}>+</${IconButton}>
      </${Box}>
      <div
        ref=${cardsRef}
        class="kanban-cards"
        onScroll=${onCardsScroll}
        onWheel=${onCardsWheel}
      >
        ${showCreate && html`
          <${TextField}
            inputRef=${inputRef}
            fullWidth
            size="small"
            placeholder="Task title…"
            onKeyDown=${handleInlineKeyDown}
            onBlur=${() => setShowCreate(false)}
            sx=${{ mb: 1 }}
          />
        `}
        ${columnItems.length
          ? columnItems.map((item) => item.kind === "group"
            ? html`
                <${KanbanGroupShell}
                  key=${item.group.key}
                  group=${item.group}
                  col=${col}
                  hierarchyModel=${hierarchyModel}
                  onOpen=${onOpen}
                  onContextMenu=${onTaskContextMenu}
                  collapsed=${collapsedGroups?.[buildKanbanGroupSummary(item.group, col, hierarchyModel).collapseKey] === true}
                  onToggleCollapse=${onToggleGroupCollapse}
                  forceExpanded=${forceExpanded}
                />
              `
            : html`
                <${KanbanCard}
                  key=${item.task.id}
                  task=${item.task}
                  onOpen=${onOpen}
                  onContextMenu=${onTaskContextMenu}
                />
              `)
          : html`<${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: 'center', py: 2 }}>Drop tasks here</${Typography}>`
        }
        ${hasMoreTasks && html`
          <div ref=${tailSentinelRef} class="kanban-tail-sentinel"></div>
        `}
      </div>
      ${hasMoreTasks && html`
        <div class="kanban-column-footer">
          <button
            type="button"
            class="kanban-load-more"
            onClick=${() => triggerLoadMore()}
            disabled=${loadingMoreTasks}
            aria-label=${loadingMoreTasks ? `Loading more ${col.title} tasks` : `Load more ${col.title} tasks`}
          >
            <span class="kanban-load-more-label">${loadingMoreTasks ? "Loading more tasks..." : `Load more ${col.title}`}</span>
            <span class="kanban-load-more-icon" aria-hidden="true">⌄</span>
          </button>
        </div>
      `}
      <div class="kanban-scroll-fade"></div>
    </div>
  `;
}

/* ─── KanbanFilter ─── */
function KanbanFilter({ tasks, filters, onFilterChange }) {
  const repos = useMemo(() => {
    const set = new Set();
    (tasks || []).forEach((t) => {
      if (t.repo || t.repository) set.add(t.repo || t.repository);
    });
    return [...set].sort();
  }, [tasks]);

  const assignees = useMemo(() => {
    const set = new Set();
    (tasks || []).forEach((t) => {
      if (t.assignee) set.add(t.assignee);
    });
    return [...set].sort();
  }, [tasks]);

  const priorities = ["critical", "high", "medium", "low"];

  const [showDropdown, setShowDropdown] = useState(null);

  const setFilter = useCallback((key, value) => {
    onFilterChange({ ...filters, [key]: value });
    setShowDropdown(null);
    setAnchorEl(null);
  }, [filters, onFilterChange]);

  const clearAll = useCallback(() => {
    onFilterChange({ repo: "", assignee: "", priority: "", search: "" });
    setShowDropdown(null);
    setAnchorEl(null);
  }, [onFilterChange]);

  const hasFilters = filters.repo || filters.assignee || filters.priority || filters.search;

  const [anchorEl, setAnchorEl] = useState(null);

  const handleDropdownClick = useCallback((name, event) => {
    if (showDropdown === name) {
      setShowDropdown(null);
      setAnchorEl(null);
    } else {
      setShowDropdown(name);
      setAnchorEl(event.currentTarget);
    }
  }, [showDropdown]);

  const handleMenuClose = useCallback(() => {
    setShowDropdown(null);
    setAnchorEl(null);
  }, []);

  return html`
    <${Box} className="kanban-filter-bar" sx=${{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', p: 1 }}>
      <${TextField}
        size="small"
        placeholder="Filter by keyword or field"
        value=${filters.search || ""}
        onInput=${(e) => onFilterChange({ ...filters, search: e.target.value })}
        InputProps=${{
          startAdornment: html`<${InputAdornment} position="start">${resolveIcon(":search:")}</${InputAdornment}>`,
        }}
        sx=${{ minWidth: 220 }}
      />
      <${Stack} direction="row" spacing=${0.5} alignItems="center" flexWrap="wrap">
        ${repos.length > 1 && html`
          <${Chip}
            label=${iconText(':box: ' + (filters.repo || 'Repository'))}
            variant=${filters.repo ? 'filled' : 'outlined'}
            onClick=${(e) => handleDropdownClick("repo", e)}
            onDelete=${filters.repo ? () => setFilter("repo", "") : undefined}
            size="small"
          />
          <${Menu}
            anchorEl=${showDropdown === "repo" ? anchorEl : null}
            open=${showDropdown === "repo"}
            onClose=${handleMenuClose}
          >
            <${MenuItem} selected=${!filters.repo} onClick=${() => setFilter("repo", "")}>All repositories</${MenuItem}>
            ${repos.map((r) => html`
              <${MenuItem} key=${r} selected=${filters.repo === r} onClick=${() => setFilter("repo", r)}>${r}</${MenuItem}>
            `)}
          </${Menu}>
        `}
        <${Chip}
          label=${'◉ ' + (filters.priority ? (PRIORITY_LABELS[filters.priority] || filters.priority) : 'Priority')}
          variant=${filters.priority ? 'filled' : 'outlined'}
          onClick=${(e) => handleDropdownClick("priority", e)}
          onDelete=${filters.priority ? () => setFilter("priority", "") : undefined}
          size="small"
        />
        <${Menu}
          anchorEl=${showDropdown === "priority" ? anchorEl : null}
          open=${showDropdown === "priority"}
          onClose=${handleMenuClose}
        >
          <${MenuItem} selected=${!filters.priority} onClick=${() => setFilter("priority", "")}>All priorities</${MenuItem}>
          ${priorities.map((p) => html`
            <${MenuItem} key=${p} selected=${filters.priority === p} onClick=${() => setFilter("priority", p)}>
              <${Box} component="span" sx=${{ width: 10, height: 10, borderRadius: '50%', backgroundColor: PRIORITY_COLORS[p], display: 'inline-block', mr: 1 }} />
              ${p.charAt(0).toUpperCase() + p.slice(1)}
            </${MenuItem}>
          `)}
        </${Menu}>
        ${assignees.length > 0 && html`
          <${Chip}
            label=${iconText(':user: ' + (filters.assignee || 'Assignee'))}
            variant=${filters.assignee ? 'filled' : 'outlined'}
            onClick=${(e) => handleDropdownClick("assignee", e)}
            onDelete=${filters.assignee ? () => setFilter("assignee", "") : undefined}
            size="small"
          />
          <${Menu}
            anchorEl=${showDropdown === "assignee" ? anchorEl : null}
            open=${showDropdown === "assignee"}
            onClose=${handleMenuClose}
          >
            <${MenuItem} selected=${!filters.assignee} onClick=${() => setFilter("assignee", "")}>All assignees</${MenuItem}>
            ${assignees.map((a) => html`
              <${MenuItem} key=${a} selected=${filters.assignee === a} onClick=${() => setFilter("assignee", a)}>${a}</${MenuItem}>
            `)}
          </${Menu}>
        `}
        ${hasFilters && html`
          <${Chip} label="✕ Clear" size="small" onClick=${clearAll} onDelete=${clearAll} />
        `}
      </${Stack}>
    </${Box}>
  `;
}

/* ─── KanbanBoard (main export) ─── */
export function KanbanBoard({ onOpenTask, hasMoreTasks = false, loadingMoreTasks = false, onLoadMoreTasks = null, columnTotals = {}, totalTasks = 0, workspaceId = "", hierarchyModel = null, tasks = null }) {
  const workspaceScope = normalizeBoardWorkspaceScope(workspaceId);
  const [hydratedWorkspaceScope, setHydratedWorkspaceScope] = useState(workspaceScope);
  const [filters, setFilters] = useState(() => readPersistedBoardFilters({ workspaceId: workspaceScope }));
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const {
    contextMenu: taskContextMenu,
    openContextMenu: openTaskContextMenuState,
    closeContextMenu: closeTaskContextMenu,
  } = useContextMenuState();
  const allTasks = Array.isArray(tasks) ? tasks : (tasksData.value || []);
  const boardTasksLoaded = Boolean(tasksLoaded.value);
  const sharedHierarchyModel = useMemo(
    () => hierarchyModel && typeof hierarchyModel === "object"
      ? hierarchyModel
      : buildTaskHierarchyModel(allTasks),
    [allTasks, hierarchyModel],
  );
  const knownRepos = useMemo(() => {
    const repos = new Set();
    for (const task of allTasks) {
      const repoName = String(task?.repo || task?.repository || "").trim();
      if (repoName) repos.add(repoName);
    }
    return repos;
  }, [allTasks]);
  const knownAssignees = useMemo(() => {
    const assignees = new Set();
    for (const task of allTasks) {
      const assignee = String(task?.assignee || "").trim();
      if (assignee) assignees.add(assignee);
    }
    return assignees;
  }, [allTasks]);

  useEffect(() => {
    const hydrated = readPersistedBoardFilters({
      workspaceId: workspaceScope,
      validateWith: boardTasksLoaded
        ? { allowedRepos: knownRepos, allowedAssignees: knownAssignees }
        : undefined,
    });
    setFilters((prev) => (areBoardFiltersEqual(prev, hydrated) ? prev : hydrated));
    setHydratedWorkspaceScope(workspaceScope);
  }, [boardTasksLoaded, knownAssignees, knownRepos, workspaceScope]);

  useEffect(() => {
    if (!boardTasksLoaded) return;
    setFilters((prev) => {
      const sanitized = sanitizeBoardFilters(prev, {
        allowedRepos: knownRepos,
        allowedAssignees: knownAssignees,
      });
      return areBoardFiltersEqual(prev, sanitized) ? prev : sanitized;
    });
  }, [boardTasksLoaded, knownRepos, knownAssignees]);

  useEffect(() => {
    if (hydratedWorkspaceScope !== workspaceScope) return;
    persistBoardFilters({ workspaceId: workspaceScope, filters });
  }, [workspaceScope, hydratedWorkspaceScope, filters]);

  const hierarchyView = useMemo(() => deriveTaskHierarchyView(sharedHierarchyModel, {
    matchTask: (task) => {
      if (filters.repo && (task?.repo || task?.repository) !== filters.repo) return false;
      if (filters.assignee && task?.assignee !== filters.assignee) return false;
      if (filters.priority && task?.priority !== filters.priority) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const searchDoc = `${task?.title || ""} ${task?.description || ""} ${task?.id || ""} ${task?.repo || task?.repository || ""} ${task?.assignee || ""}`.toLowerCase();
        if (!searchDoc.includes(q)) return false;
      }
      return true;
    },
  }), [filters, sharedHierarchyModel]);

  const filteredTasks = useMemo(
    () => [...hierarchyView.visibleTaskIds]
      .map((taskId) => sharedHierarchyModel.taskById.get(taskId))
      .filter(Boolean),
    [hierarchyView.visibleTaskIds, sharedHierarchyModel],
  );

  const cols = useMemo(() => {
    const result = {};
    for (const col of COLUMNS) result[col.id] = [];
    for (const task of filteredTasks) {
      const col = getColumnForStatus(task.status);
      if (result[col]) result[col].push(task);
    }
    return result;
  }, [filteredTasks]);

  const hasBoardFilters = Boolean(filters.repo || filters.assignee || filters.priority || filters.search);
  const resolvedTotalTasks = Number.isFinite(Number(totalTasks)) && Number(totalTasks) > 0
    ? Number(totalTasks)
    : allTasks.length;
  const autoLoadMore = !hasBoardFilters && resolvedTotalTasks <= AUTO_LOAD_MAX_TASKS;
  const toggleGroupCollapse = useCallback((collapseKey) => {
    if (!collapseKey) return;
    setCollapsedGroups((prev) => ({
      ...prev,
      [collapseKey]: !prev[collapseKey],
    }));
  }, []);

  const openTaskContextMenu = useCallback((task, event) => {
    if (!task?.id) return;
    openTaskContextMenuState({
      taskId: task.id,
    }, event);
  }, [openTaskContextMenuState]);

  const handleTaskContextAction = useCallback(async (action) => {
    const taskId = String(taskContextMenu?.taskId || "").trim();
    if (!taskId) {
      closeTaskContextMenu();
      return;
    }
    const task = (tasksData.value || []).find((entry) => matchTaskId(entry?.id, taskId)) || null;
    if (!task) {
      closeTaskContextMenu();
      return;
    }
    if (action === "open") {
      closeTaskContextMenu();
      onOpenTask?.(taskId);
      return;
    }
    if (action === "copy-id") {
      closeTaskContextMenu();
      try {
        await navigator.clipboard.writeText(taskId);
      } catch {
      }
      return;
    }
    const nextStatus = COLUMN_TO_STATUS[action] || null;
    closeTaskContextMenu();
    if (!nextStatus) return;
    try {
      await executeBoardTransition(task, nextStatus, getTaskStatusLabel(nextStatus));
    } catch (error) {
      showToast(error?.message || "Failed to update task", "error");
    }
  }, [closeTaskContextMenu, onOpenTask, taskContextMenu?.taskId]);

  return html`
    <${Box} className="kanban-container">
      <${KanbanFilter} tasks=${allTasks} filters=${filters} onFilterChange=${setFilters} />
      <${Box} sx=${{ px: 1, pb: 0.5, color: "text.secondary", fontSize: 12 }}>
        Total tasks: ${resolvedTotalTasks}
        ${!autoLoadMore ? " · Auto-load paused for large boards (use Load more per column)." : ""}
      </${Box}>
      <${Box} className="kanban-board" sx=${{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1 }}>
        ${COLUMNS.map((col) => html`
          <${KanbanColumn}
            key=${col.id}
            col=${col}
            tasks=${cols[col.id] || []}
            hierarchyView=${hierarchyView}
            hierarchyModel=${sharedHierarchyModel}
            totalCount=${columnTotals?.[col.id] ?? (cols[col.id] || []).length}
            hasMoreTasks=${hasMoreTasks}
            loadingMoreTasks=${loadingMoreTasks}
            onLoadMoreTasks=${onLoadMoreTasks}
            autoLoadMore=${autoLoadMore}
            globalTaskCount=${allTasks.length}
            onOpen=${onOpenTask}
            onTaskContextMenu=${openTaskContextMenu}
            collapsedGroups=${collapsedGroups}
            onToggleGroupCollapse=${toggleGroupCollapse}
            forceExpanded=${hasBoardFilters}
          />
        `)}
      </${Box}>
      <${AppContextMenu}
        menu=${taskContextMenu}
        onClose=${closeTaskContextMenu}
        items=${[
          { key: "open", label: "Open task", icon: ":chat:", onClick: () => handleTaskContextAction("open") },
          { key: "backlog", label: "Move to Backlog", icon: ":clipboard:", onClick: () => handleTaskContextAction("backlog") },
          { key: "in-progress", label: "Move to In Progress", icon: ":play:", onClick: () => handleTaskContextAction("inProgress") },
          { key: "in-review", label: "Move to In Review", icon: ":eye:", onClick: () => handleTaskContextAction("inReview") },
          { key: "blocked", label: "Move to Blocked", icon: ":alert:", onClick: () => handleTaskContextAction("blocked") },
          { key: "done", label: "Move to Done", icon: ":check:", onClick: () => handleTaskContextAction("done") },
          { kind: "divider", key: "copy-divider" },
          { key: "copy-id", label: "Copy ID", icon: ":copy:", onClick: () => handleTaskContextAction("copy-id") },
        ]}
      />
    </${Box}>
  `;
}


