/* ─────────────────────────────────────────────────────────────
 *  Tab: Tasks — board, search, filters, task CRUD
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { signal } from "@preact/signals";
import {
  tasksData,
  tasksLoaded,
  tasksPage,
  tasksPageSize,
  tasksFilter,
  tasksPriority,
  tasksSearch,
  tasksSort,
  tasksTotalPages,
  tasksTotal,
  tasksStatusCounts,
  executorData,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  loadTasks,
  updateTaskManualState,
  setPendingChange,
  clearPendingChange,
  sanitizeTaskText,
  isPlaceholderTaskDescription,
  KANBAN_PAGE_SIZE,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  formatDuration,
  truncate,
  formatBytes,
  debounce,
  exportAsCSV,
  exportAsJSON,
  countChangedFields,
} from "../modules/utils.js";
import { navigateTo } from "../modules/router.js";
import {
  buildTaskHierarchyModel,
  deriveTaskHierarchyView,
  flattenTaskHierarchyView,
} from "../modules/task-hierarchy.js";
import {
  loadSessions,
  loadSessionMessages,
  selectedSessionId,
} from "../components/session-list.js";
import {
  Modal,
  SaveDiscardBar,
  Card,
  SkeletonCard,
  EmptyState
} from "../components/shared.js";
import { MarkdownTaskEditor, MarkdownTaskViewer } from "../components/task-markdown.js";
import { DiffViewer } from "../components/diff-viewer.js";
import {
  SegmentedControl,
  SearchInput,
  Toggle as ImportedToggle,
} from "../components/forms.js";
import { KanbanBoard } from "../components/kanban-board.js";
import { VoiceMicButton, VoiceMicButtonInline } from "../modules/voice.js";
import {
  workspaces as managedWorkspaces,
  activeWorkspaceId,
  loadWorkspaces,
} from "../components/workspace-switcher.js";
import {
  Card as MuiCard, CardContent, Typography, Box, Stack, Chip, TextField, Select,
  MenuItem, Button, IconButton, Tabs, Tab, Tooltip, Divider,
  Paper, CircularProgress, Skeleton, Alert, Switch, FormControlLabel,
  Menu as MuiMenu, Fab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TableSortLabel, ToggleButton, ToggleButtonGroup, Badge,
  Autocomplete,
} from "@mui/material";

/* ─── View mode toggle ─── */
const viewMode = signal("kanban");
const Toggle = typeof ImportedToggle === "function" ? ImportedToggle : () => null;
const DAG_SPRINT_ENDPOINT_CANDIDATES = [
  "/api/tasks/sprints",
  "/api/tasks/dag/sprints",
  "/api/tasks/dag/index",
];
const DAG_GRAPH_ENDPOINT_CANDIDATES = [
  "/api/tasks/dag",
  "/api/tasks/graph",
  "/api/tasks/dependencies",
];
const DAG_GLOBAL_ENDPOINT_CANDIDATES = [
  "/api/tasks/dag-of-dags",
  "/api/tasks/dag/global",
  "/api/tasks/graph/global",
];
const DAG_EPIC_DEPENDENCY_ENDPOINT_CANDIDATES = [
  "/api/tasks/epic-dependencies",
  "/api/tasks/epics/dependencies",
  "/api/tasks/dag/epics",
];
const EMPTY_DAG_GRAPH = {
  title: "",
  description: "",
  nodes: [],
  edges: [],
};
const DAG_EDGE_STYLES = {
  "depends-on": { color: "var(--accent)", dash: "" },
  dependency: { color: "var(--accent)", dash: "" },
  sequential: { color: "var(--color-warning)", dash: "7 4" },
  sequence: { color: "var(--color-warning)", dash: "7 4" },
  blocks: { color: "var(--color-error)", dash: "2 4" },
};
const DAG_MIN_ZOOM = 0.25;
const DAG_MAX_ZOOM = 2.4;

/* ─── Status/Priority → MUI Chip color ─── */
function statusChipColor(status) {
  const s = String(status || "").toLowerCase();
  if (["inprogress", "running", "working", "active", "assigned", "started"].includes(s)) return "info";
  if (["inreview", "review", "pr-open", "pr-review"].includes(s)) return "warning";
  if (["done", "completed", "merged", "closed"].includes(s)) return "success";
  if (["error", "blocked", "failed", "cancelled"].includes(s)) return "error";
  if (s === "critical") return "error";
  if (s === "high") return "warning";
  if (s === "medium") return "info";
  if (s === "warning" || s === "manual") return "warning";
  return "default";
}

/* ─── Status chip definitions ─── */
const STATUS_CHIPS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "todo", label: "Todo" },
  { value: "inprogress", label: "Active" },
  { value: "inreview", label: "Review" },
  { value: "done", label: "Done" },
  { value: "blocked", label: "Blocked" },
];

const PRIORITY_CHIPS = [
  { value: "", label: "Any" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const SORT_OPTIONS = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
];

/* Maps snapshot-bar labels → tasksFilter values */
const SNAPSHOT_STATUS_MAP = {
  Backlog: "todo",
  Active: "inprogress",
  Review: "inreview",
  Done: "done",
  Blocked: "blocked",
};

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, "": 4 };

const SYSTEM_TAGS = new Set([
  "draft",
  "todo",
  "inprogress",
  "inreview",
  "done",
  "cancelled",
  "error",
  "blocked",
  "critical",
  "high",
  "medium",
  "low",
  "codex:ignore",
  "codex:claimed",
  "codex:working",
  "codex:stale",
  "bosun",
  "codex-mointor",
]);

const IGNORE_LABEL = "codex:ignore";

function labelMatchesIgnore(label) {
  const name = typeof label === "string" ? label : label?.name || "";
  return String(name || "").trim().toLowerCase() === IGNORE_LABEL;
}

function isTaskManual(task) {
  if (!task) return false;
  if (task.manual === true || task.isIgnored === true) return true;
  if (task.meta?.codex?.isIgnored) return true;
  if (Array.isArray(task?.meta?.labels) && task.meta.labels.some(labelMatchesIgnore))
    return true;
  if (Array.isArray(task?.labels) && task.labels.some(labelMatchesIgnore)) return true;
  return false;
}

function getManualReason(task) {
  return (
    task?.ignoreReason ||
    task?.meta?.codex?.ignoreReason ||
    ""
  );
}

function normalizeTagInput(input) {
  if (!input) return [];
  const values = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized) || SYSTEM_TAGS.has(normalized)) continue;
    if (/^(?:upstream|base|target)(?:_branch)?[:=]/i.test(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function getTaskTags(task) {
  if (!task) return [];
  const direct = normalizeTagInput(task.tags || []);
  if (direct.length) return direct;
  const metaTags = normalizeTagInput(task?.meta?.tags || []);
  if (metaTags.length) return metaTags;
  const metaLabels = Array.isArray(task?.meta?.labels)
    ? task.meta.labels.map((label) =>
        typeof label === "string" ? label : label?.name || "",
      )
    : [];
  return normalizeTagInput(metaLabels);
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

function attachmentKey(att) {
  if (!att) return "";
  return att.url || att.filePath || att.relativePath || att.name || "";
}

function normalizeTaskAttachments(task) {
  if (!task) return [];
  const combined = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
  const seen = new Set();
  const out = [];
  for (const att of combined) {
    const key = attachmentKey(att);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(att);
  }
  return out;
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task) {
  if (!task) return [];
  const raw = Array.isArray(task.comments)
    ? task.comments
    : Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
  return raw
    .map((comment) => {
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        id: comment?.id || null,
        author: comment?.author || comment?.user || comment?.by || null,
        createdAt: comment?.createdAt || comment?.created_at || null,
        body: trimmed,
      };
    })
    .filter(Boolean);
}

function isImageAttachment(att) {
  const kind = String(att?.kind || "").toLowerCase();
  if (kind === "image") return true;
  const type = String(att?.contentType || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  const name = String(att?.name || att?.filename || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
}

function unsavedChangesMessage(changeCount) {
  const count = Math.max(0, Number(changeCount || 0));
  return `You have unsaved changes (${count})`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function toText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeDagDependencyList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .map((item) => toText(item))
    .filter(Boolean);
}


function normalizeDependencyInput(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,]/)
        .flatMap((entry) => String(entry || "").split(/\s+/));
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const normalized = toText(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getTaskDependencyIds(task) {
  const deps = [
    ...(Array.isArray(task?.dependencyTaskIds) ? task.dependencyTaskIds : []),
    ...(Array.isArray(task?.dependsOn) ? task.dependsOn : []),
    ...(Array.isArray(task?.meta?.dependencyTaskIds) ? task.meta.dependencyTaskIds : []),
    ...(Array.isArray(task?.meta?.dependsOn) ? task.meta.dependsOn : []),
  ];
  return normalizeDependencyInput(deps);
}

function getTaskSprintId(task) {
  return toText(task?.sprintId || task?.meta?.sprintId || "");
}

function getTaskSprintOrder(task) {
  const raw = task?.sprintOrder ?? task?.meta?.sprintOrder;
  if (raw == null || raw === "") return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : "";
}
function pickTaskField(task, keys = []) {
  for (const key of keys) {
    const direct = task?.[key];
    if (direct != null && String(direct).trim() !== "") return direct;
    const meta = task?.meta?.[key];
    if (meta != null && String(meta).trim() !== "") return meta;
  }
  return "";
}

function normalizeTaskAssigneesInput(task) {
  const value = pickTaskField(task, ["assignees"]);
  if (Array.isArray(value)) {
    return value
      .map((entry) => toText(entry?.name || entry))
      .filter(Boolean)
      .join(", ");
  }
  return toText(value);
}

function normalizeTaskDueDateInput(task) {
  const value = toText(pickTaskField(task, ["dueDate", "due", "due_at", "dueAt"]));
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export function normalizeSubtaskRow(entry, fallbackParentTaskId = "") {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: toText(entry.id || entry.taskId),
    title: toText(entry.title || entry.summary || entry.name, "(untitled subtask)"),
    status: toText(entry.status || entry.state),
    assignee: toText(entry.assignee || entry.owner),
    taskType: normalizeTaskTypeValue(entry?.taskType || entry?.type || entry?.kind || entry?.meta?.taskType || entry?.meta?.type, "subtask"),
    storyPoints: toText(entry.storyPoints || entry.points),
    epicId: toText(entry.epicId || entry.epic || entry.epic_id || entry?.meta?.epicId),
    dueDate: normalizeTaskDueDateInput(entry),
    blockedReason: toText(entry.blockedReason || entry?.meta?.blockedReason),
    dependencyTaskIds: normalizeDependencyInput(
      entry.dependencyTaskIds
        || entry.dependsOn
        || entry.dependencies
        || entry?.meta?.dependencyTaskIds
        || entry?.meta?.dependsOn,
    ),
    labels: normalizeTagInput(entry.tags || entry.labels || entry?.meta?.tags || []),
    parentTaskId: toText(
      entry.parentTaskId || entry.parentId || entry.parent_task_id || entry?.meta?.parentTaskId,
      fallbackParentTaskId,
    ),
  };
}

function normalizeSubtasksPayload(raw) {
  const payload = extractDagPayload(raw);
  const rows = toArray(payload?.subtasks || payload?.items || payload?.tasks || payload);
  return rows
    .map((entry) => normalizeSubtaskRow(entry))
    .filter((entry) => entry && entry.id);
}

function mergeSubtaskLists(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const entry of Array.isArray(list) ? list : []) {
      const normalized = normalizeSubtaskRow(entry);
      if (!normalized?.id) continue;
      merged.set(normalized.id, {
        ...(merged.get(normalized.id) || {}),
        ...normalized,
      });
    }
  }
  return [...merged.values()];
}

export function buildTaskHierarchyPath(task, hierarchyModel = null) {
  const taskById = hierarchyModel?.taskById || new Map();
  const path = [];
  const seen = new Set();
  let cursor = task;
  while (cursor && typeof cursor === "object") {
    const cursorId = toText(cursor.id || cursor.taskId);
    if (!cursorId || seen.has(cursorId)) break;
    seen.add(cursorId);
    path.unshift(cursor);
    const parentId = toText(
      cursor.parentTaskId || cursor.parentId || cursor.parent_task_id || cursor?.meta?.parentTaskId,
    );
    if (!parentId) break;
    cursor = taskById.get(parentId) || null;
  }
  return path;
}

function buildTaskSearchDocument(task) {
  return `${task?.title || ""} ${task?.description || ""} ${task?.id || ""} ${getTaskBaseBranch(task)} ${getTaskTags(task).join(" ")}`
    .toLowerCase();
}

function getTaskListIssueTypeLabel(task) {
  const type = normalizeTaskTypeValue(
    task?.taskType || task?.type || task?.kind || task?.meta?.taskType || task?.meta?.type,
    "task",
  );
  return type === "epic" ? "Epic" : type === "subtask" ? "Sub-task" : "Task";
}

function getTaskListStatusTone(status) {
  const normalized = normalizeTaskStatusValue(status);
  if (["done", "completed", "closed", "merged", "cancelled"].includes(normalized)) return "done";
  if (["blocked", "error", "failed"].includes(normalized)) return "blocked";
  if (["inreview", "review", "pr-open", "pr-review"].includes(normalized)) return "review";
  if (["inprogress", "working", "active", "assigned", "running"].includes(normalized)) return "active";
  if (["draft"].includes(normalized)) return "draft";
  return "backlog";
}

function compareTasksForHierarchicalList(a, b, listSortCol = "", listSortDir = "desc") {
  if (!listSortCol) return 0;
  const dir = listSortDir === "asc" ? 1 : -1;
  let av;
  let bv;
  if (listSortCol === "priority") {
    av = PRIORITY_ORDER[a?.priority || ""] ?? 4;
    bv = PRIORITY_ORDER[b?.priority || ""] ?? 4;
    return dir * (av - bv);
  }
  if (listSortCol === "updated") {
    const tsA = a?.updated_at || a?.updated;
    const tsB = b?.updated_at || b?.updated;
    av = tsA ? (typeof tsA === "number" ? tsA : new Date(tsA).getTime()) : 0;
    bv = tsB ? (typeof tsB === "number" ? tsB : new Date(tsB).getTime()) : 0;
    return dir * (av - bv);
  }
  if (listSortCol === "status") {
    av = a?.status || "";
    bv = b?.status || "";
  } else if (listSortCol === "title") {
    av = (a?.title || "").toLowerCase();
    bv = (b?.title || "").toLowerCase();
  } else if (listSortCol === "repo") {
    av = a?.repository || a?.workspace || "";
    bv = b?.repository || b?.workspace || "";
  } else if (listSortCol === "branch") {
    av = getTaskBaseBranch(a);
    bv = getTaskBaseBranch(b);
  } else {
    return 0;
  }
  return dir * String(av).localeCompare(String(bv));
}

export function buildHierarchicalTaskRows(rootNodes = [], options = {}) {
  const rows = [];
  const sortChildren = typeof options?.sortChildren === "function" ? options.sortChildren : (items) => items;
  const collapsedState = options?.collapsedState || {};
  const hasSearch = options?.hasSearch === true;

  const visit = (node, depth = 0, forceShowDescendants = false) => {
    if (!node?.task) return;
    const childStates = Array.isArray(node.children) ? node.children : [];
    const hasChildren = childStates.length > 0;
    const shouldAttachChildren = !hasSearch || forceShowDescendants || node.directMatch;
    const visibleChildren = shouldAttachChildren
      ? childStates
      : childStates.filter((entry) => entry?.visible);
    const orderedChildren = sortChildren(visibleChildren);
    const autoExpanded = hasSearch && (node.descendantMatch || node.directMatch);
    const isCollapsed = hasChildren ? (!autoExpanded && collapsedState[node.collapseKey] === true) : false;

    rows.push({
      id: node.id,
      task: node.task,
      node,
      depth,
      hasChildren,
      isCollapsed,
      isExpanded: hasChildren && !isCollapsed,
      progressDone: node.completedDescendantCount || 0,
      progressTotal: node.descendantCount || 0,
      blockedCount: node.blockedDescendantCount || 0,
      matchState: node.searchMatchState || "none",
    });

    if (hasChildren && !isCollapsed) {
      for (const child of orderedChildren) {
        visit(child, depth + 1, shouldAttachChildren);
      }
    }
  };

  for (const root of sortChildren(rootNodes)) {
    if (!root?.task) continue;
    if (!hasSearch || root.visible) visit(root, 0, false);
  }
  return rows;
}

function extractDagPayload(raw) {
  if (raw && typeof raw === "object" && "data" in raw && raw.data != null) {
    return raw.data;
  }
  return raw || {};
}

function normalizeSprintOptions(raw) {
  const payload = extractDagPayload(raw);
  const candidates = [
    payload?.sprints,
    payload?.sprintList,
    payload?.items,
    payload?.data?.sprints,
  ];
  const source = candidates.find(
    (value) => Array.isArray(value) && value.length > 0,
  ) || toArray(payload);
  return source
    .map((entry, index) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        return { id: entry, label: entry, status: "", goal: "" };
      }
      const id = toText(entry.id || entry.slug || entry.name || `sprint-${index + 1}`);
      if (!id) return null;
      return {
        id,
        label: toText(entry.label || entry.title || entry.name, id),
        status: toText(entry.status),
        goal: toText(entry.goal),
        executionMode: toText(entry.executionMode || entry.taskOrderMode || entry.sprintOrderMode || "parallel", "parallel"),
        taskOrderMode: toText(entry.taskOrderMode || entry.executionMode || entry.sprintOrderMode || "parallel", "parallel"),
      };
    })
    .filter(Boolean);
}

function normalizeDagNode(node, index) {
  const id = toText(
    node?.id || node?.nodeId || node?.taskId || node?.key || `node-${index + 1}`,
  );
  const taskId = toText(node?.taskId || node?.id || node?.task?.id || "");
  const orderRaw =
    node?.sprintOrder ??
    node?.sequence ??
    node?.order ??
    node?.position ??
    node?.index;
  const order = Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : null;
  return {
    id,
    taskId,
    title: toText(node?.title || node?.label || node?.name || taskId || id, "(untitled)"),
    description: toText(node?.description || node?.summary || ""),
    status: toText(node?.status || node?.state || ""),
    priority: toText(node?.priority),
    sprintId: toText(node?.sprintId || node?.sprint || ""),
    order,
    dependencies: normalizeDagDependencyList(
      node?.dependencies ||
        node?.dependsOn ||
        node?.requires ||
        node?.prerequisites,
    ),
  };
}

function buildDagDepthMap(levelSource = []) {
  const levels = Array.isArray(levelSource) ? levelSource : [];
  const depthMap = new Map();
  levels.forEach((level, depth) => {
    const entries = Array.isArray(level)
      ? level
      : Array.isArray(level?.nodes)
        ? level.nodes
        : [];
    entries.forEach((entry) => {
      const id = toText(entry?.id || entry?.taskId || entry);
      if (id && !depthMap.has(id)) depthMap.set(id, depth);
    });
  });
  return depthMap;
}

function buildTopologicalDepthMap(nodes = [], rawEdges = []) {
  const depthMap = new Map();
  const indegree = new Map();
  const outgoing = new Map();
  const ids = new Set();
  for (const node of nodes) {
    const id = toText(node?.id || node?.taskId);
    if (!id) continue;
    ids.add(id);
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of rawEdges || []) {
    const sourceId = toText(edge?.source || edge?.from || edge?.parent || edge?.dependsOn);
    const targetId = toText(edge?.target || edge?.to || edge?.child || edge?.taskId);
    if (!sourceId || !targetId || !ids.has(sourceId) || !ids.has(targetId) || sourceId === targetId) continue;
    outgoing.get(sourceId)?.push(targetId);
    indegree.set(targetId, (indegree.get(targetId) || 0) + 1);
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  queue.forEach((id) => depthMap.set(id, 0));

  while (queue.length) {
    const sourceId = queue.shift();
    const nextDepth = (depthMap.get(sourceId) || 0) + 1;
    for (const targetId of outgoing.get(sourceId) || []) {
      if (!depthMap.has(targetId) || (depthMap.get(targetId) || 0) < nextDepth) {
        depthMap.set(targetId, nextDepth);
      }
      const nextDegree = (indegree.get(targetId) || 0) - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) queue.push(targetId);
    }
  }

  return depthMap;
}

function normalizeDagGraph(raw, fallbackTitle = "") {
  const payload = extractDagPayload(raw);
  const graph =
    payload?.graph ||
    payload?.dag ||
    payload?.sprintDag ||
    payload?.sprintGraph ||
    payload?.globalDag ||
    payload?.globalGraph ||
    payload;

  const nodeSourceCandidates = [
    graph?.nodes,
    graph?.tasks,
    graph?.items,
    payload?.nodes,
    payload?.tasks,
    payload?.items,
  ];
  const edgeSourceCandidates = [
    graph?.edges,
    graph?.links,
    graph?.dependencies,
    payload?.edges,
    payload?.links,
    payload?.dependencies,
  ];

  const rawNodes =
    nodeSourceCandidates.find((value) => Array.isArray(value) && value.length > 0) || [];
  const depthByLevel = buildDagDepthMap(graph?.levels || payload?.levels || []);
  const provisionalNodes = rawNodes.map(normalizeDagNode).filter((node) => node && node.id);
  const rawEdges =
    edgeSourceCandidates.find((value) => Array.isArray(value) && value.length > 0) || [];
  const depthByTopology = depthByLevel.size
    ? new Map()
    : buildTopologicalDepthMap(provisionalNodes, rawEdges);
  const nodes = provisionalNodes.map((node) => {
    const depth = Number.isFinite(Number(node?.depth))
      ? Number(node.depth)
      : depthByLevel.get(node.id)
        ?? (node.taskId ? depthByLevel.get(node.taskId) : null)
        ?? depthByTopology.get(node.id)
        ?? (node.taskId ? depthByTopology.get(node.taskId) : null);
    return {
      ...node,
      depth: Number.isFinite(Number(depth)) ? Number(depth) : null,
    };
  });
  const idLookup = new Map();
  for (const node of nodes) {
    idLookup.set(node.id, node.id);
    if (node.taskId) idLookup.set(node.taskId, node.id);
  }

  const edges = [];
  const seen = new Set();
  const pushEdge = (source, target, kind = "depends-on") => {
    const src = idLookup.get(source) || source;
    const dst = idLookup.get(target) || target;
    if (!src || !dst) return;
    const key = `${src}->${dst}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: src, target: dst, kind });
  };

  for (const edge of rawEdges) {
    if (!edge || typeof edge !== "object") continue;
    pushEdge(
      toText(edge.source || edge.from || edge.parent || edge.dependsOn),
      toText(edge.target || edge.to || edge.child || edge.taskId),
      toText(edge.kind || edge.type || "depends-on"),
    );
  }
  if (!edges.length) {
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        pushEdge(dep, node.id, "depends-on");
      }
    }
  }

  return {
    title: toText(graph?.title || payload?.title || fallbackTitle, fallbackTitle),
    description: toText(graph?.description || payload?.description || ""),
    nodes,
    edges,
  };
}

function normalizeEpicDependenciesPayload(raw) {
  const payload = extractDagPayload(raw);
  const rows = toArray(payload?.data || payload?.items || payload);
  return rows
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const epicId = toText(entry.epicId || entry.id || entry.epic);
      if (!epicId) return null;
      return {
        epicId,
        dependencies: normalizeDependencyInput(entry.dependencies || entry.dependsOn || []),
      };
    })
    .filter(Boolean);
}

function buildEpicDagGraph(tasks = [], epicDependencies = []) {
  const epicMap = new Map();
  const pushEpicNode = (epicId) => {
    const id = toText(epicId);
    if (!id) return null;
    if (!epicMap.has(id)) {
      epicMap.set(id, { id, title: id, taskIds: [], statusCounts: new Map(), dependencies: [] });
    }
    return epicMap.get(id);
  };

  for (const task of tasks || []) {
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    if (!epicId) continue;
    const node = pushEpicNode(epicId);
    node.taskIds.push(task.id);
    const status = toText(task?.status || "todo", "todo").toLowerCase();
    node.statusCounts.set(status, (node.statusCounts.get(status) || 0) + 1);
  }

  const depMap = new Map();
  const addEdge = (from, to, kind = "dependency") => {
    const src = toText(from);
    const dst = toText(to);
    if (!src || !dst || src === dst) return;
    pushEpicNode(src);
    const node = pushEpicNode(dst);
    if (node && !node.dependencies.includes(src)) node.dependencies.push(src);
    const key = `${src}->${dst}:${kind}`;
    if (!depMap.has(key)) depMap.set(key, { source: src, target: dst, kind });
  };

  for (const row of epicDependencies || []) {
    for (const dep of row.dependencies || []) addEdge(dep, row.epicId, "blocks");
  }

  const taskById = new Map((tasks || []).map((task) => [String(task?.id || ""), task]));
  for (const task of tasks || []) {
    const targetEpic = toText(task?.epicId || task?.meta?.epicId);
    if (!targetEpic) continue;
    for (const depId of normalizeDependencyInput(task?.dependencyTaskIds || task?.dependsOn || task?.meta?.dependencyTaskIds || [])) {
      const depTask = taskById.get(String(depId));
      const sourceEpic = toText(depTask?.epicId || depTask?.meta?.epicId);
      if (!sourceEpic || sourceEpic === targetEpic) continue;
      addEdge(sourceEpic, targetEpic, "dependency");
    }
  }

  const indegree = new Map();
  const outgoing = new Map();
  for (const epicId of epicMap.keys()) {
    indegree.set(epicId, 0);
    outgoing.set(epicId, []);
  }
  for (const edge of depMap.values()) {
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }

  const queue = [];
  for (const [id, degree] of indegree.entries()) if (degree === 0) queue.push(id);
  const level = new Map();
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    const nextLevel = (level.get(id) || 0) + 1;
    for (const dst of outgoing.get(id) || []) {
      if (!level.has(dst) || (level.get(dst) || 0) < nextLevel) level.set(dst, nextLevel);
      const degree = (indegree.get(dst) || 0) - 1;
      indegree.set(dst, degree);
      if (degree === 0) queue.push(dst);
    }
  }

  const nodes = [...epicMap.values()].map((entry) => {
    const statuses = [...entry.statusCounts.entries()].sort((a, b) => b[1] - a[1]);
    const dominantStatus = statuses[0]?.[0] || "todo";
    return {
      id: entry.id,
      taskId: null,
      title: `Epic ${entry.title}`,
      status: dominantStatus,
      depth: level.get(entry.id) || 0,
      order: entry.taskIds.length,
      taskCount: entry.taskIds.length,
      dependencies: [...entry.dependencies],
      epicId: entry.id,
    };
  });

  const edges = [...depMap.values()];
  return {
    title: "Epic Dependency DAG",
    description: "Epic-level execution dependencies.",
    nodes,
    edges,
  };
}
function slugifyPlanningId(value, fallback = "item") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeTaskTypeValue(value, fallback = "task") {
  const normalized = toText(value, fallback).toLowerCase();
  return ["epic", "task", "subtask"].includes(normalized) ? normalized : fallback;
}

function normalizeTaskStatusValue(value) {
  return toText(value).toLowerCase();
}

function isTerminalTaskStatus(value) {
  return ["done", "completed", "closed", "merged", "cancelled"].includes(normalizeTaskStatusValue(value));
}

function isQueuedTask(task) {
  const runtime = getTaskRuntimeSnapshot(task);
  return runtime?.state === "queued" || normalizeTaskStatusValue(task?.status) === "queued";
}

function isBacklogDraftTask(task) {
  const status = normalizeTaskStatusValue(task?.status);
  return status === "draft" || status === "todo" || status === "backlog" || status === "planned" || status === "";
}

function isExecutionTask(task) {
  return isActiveStatus(task?.status) || isReviewStatus(task?.status) || isQueuedTask(task);
}

function filterDagGraphByIds(graph = EMPTY_DAG_GRAPH, allowedIds = null, resolver = (node) => toText(node?.id || node?.taskId)) {
  if (!allowedIds || allowedIds === "all") return graph;
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(Array.isArray(allowedIds) ? allowedIds : []);
  const nodes = (graph?.nodes || []).filter((node) => allowed.has(resolver(node)) || allowed.has(toText(node?.id || node?.taskId)));
  const nodeIds = new Set(nodes.map((node) => toText(node?.id || node?.taskId)).filter(Boolean));
  const edges = (graph?.edges || []).filter((edge) => nodeIds.has(toText(edge?.source || edge?.from)) && nodeIds.has(toText(edge?.target || edge?.to)));
  return { ...graph, nodes, edges };
}

function buildEpicCatalog(tasks = [], epicDependencies = []) {
  const catalog = new Map();
  const ensureEpic = (epicId) => {
    const id = toText(epicId);
    if (!id) return null;
    if (!catalog.has(id)) {
      catalog.set(id, {
        id,
        label: id,
        taskIds: [],
        dependencies: [],
        completedCount: 0,
        activeCount: 0,
      });
    }
    return catalog.get(id);
  };
  for (const task of tasks || []) {
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    if (!epicId) continue;
    const entry = ensureEpic(epicId);
    if (!entry) continue;
    entry.taskIds.push(task.id);
    if (normalizeTaskTypeValue(task?.type) === "epic") {
      entry.label = toText(task?.title, epicId);
      entry.anchorTaskId = task.id;
    }
    if (isTerminalTaskStatus(task?.status)) entry.completedCount += 1;
    if (isExecutionTask(task)) entry.activeCount += 1;
  }
  for (const row of epicDependencies || []) {
    const entry = ensureEpic(row?.epicId);
    if (!entry) continue;
    entry.dependencies = normalizeDependencyInput(row?.dependencies || []);
  }
  return [...catalog.values()]
    .map((entry) => ({
      ...entry,
      taskIds: normalizeDependencyInput(entry.taskIds),
      taskCount: normalizeDependencyInput(entry.taskIds).length,
    }))
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function buildDagPlanningState({ tasks = [], sprintId = "all", sprintOrderMode = "parallel", sprintOptions = [], epicDependencies = [] }) {
  const scopedTasks = (tasks || []).filter((task) => sprintId === "all" ? true : getTaskSprintId(task) === sprintId);
  const allTaskMap = new Map((tasks || []).map((task) => [toText(task?.id), task]));
  const scopedTaskIds = new Set(scopedTasks.map((task) => toText(task?.id)).filter(Boolean));
  const sprintModeMap = new Map((sprintOptions || []).map((sprint) => [sprint.id, toText(sprint.executionMode || sprint.taskOrderMode || 'parallel', 'parallel')]));
  const epicDependencyMap = new Map((epicDependencies || []).map((row) => [toText(row?.epicId), normalizeDependencyInput(row?.dependencies || [])]));
  const tasksByEpic = new Map();
  for (const task of tasks || []) {
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    if (!epicId) continue;
    const list = tasksByEpic.get(epicId) || [];
    list.push(task);
    tasksByEpic.set(epicId, list);
  }
  const isSequentialBlocked = (task) => {
    const taskSprintId = getTaskSprintId(task);
    const mode = sprintModeMap.get(taskSprintId) || sprintOrderMode;
    if (mode !== 'sequential') return false;
    const currentOrder = Number(getTaskSprintOrder(task));
    if (!Number.isFinite(currentOrder) || currentOrder <= 1) return false;
    return scopedTasks.some((candidate) => getTaskSprintId(candidate) === taskSprintId && Number(getTaskSprintOrder(candidate)) < currentOrder && !isTerminalTaskStatus(candidate?.status));
  };
  const isEpicBlocked = (task) => {
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    if (!epicId) return false;
    const requiredEpics = epicDependencyMap.get(epicId) || [];
    if (!requiredEpics.length) return false;
    return requiredEpics.some((requiredEpicId) => {
      const epicTasks = tasksByEpic.get(requiredEpicId) || [];
      if (!epicTasks.length) return true;
      return epicTasks.some((candidate) => !isTerminalTaskStatus(candidate?.status));
    });
  };
  const isDependencyBlocked = (task) => getTaskDependencyIds(task).some((depId) => {
    const dependencyTask = allTaskMap.get(depId);
    return !dependencyTask || !isTerminalTaskStatus(dependencyTask?.status);
  });
  const backlogTaskIds = new Set();
  const executionTaskIds = new Set();
  const readyTaskIds = new Set();
  const sprintIdsByFocus = { all: new Set(), backlog: new Set(), execution: new Set(), ready: new Set() };
  const epicIdsByFocus = { all: new Set(), backlog: new Set(), execution: new Set(), ready: new Set() };
  for (const task of scopedTasks) {
    const taskId = toText(task?.id);
    const taskSprintId = getTaskSprintId(task);
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    sprintIdsByFocus.all.add(taskSprintId || 'unassigned');
    if (epicId) epicIdsByFocus.all.add(epicId);
    if (isBacklogDraftTask(task)) {
      backlogTaskIds.add(taskId);
      sprintIdsByFocus.backlog.add(taskSprintId || 'unassigned');
      if (epicId) epicIdsByFocus.backlog.add(epicId);
    }
    if (isExecutionTask(task)) {
      executionTaskIds.add(taskId);
      sprintIdsByFocus.execution.add(taskSprintId || 'unassigned');
      if (epicId) epicIdsByFocus.execution.add(epicId);
    }
    const ready = !isBacklogDraftTask(task) && !isExecutionTask(task) && !isTerminalTaskStatus(task?.status) && !isDependencyBlocked(task) && !isEpicBlocked(task) && !isSequentialBlocked(task);
    if (ready) {
      readyTaskIds.add(taskId);
      sprintIdsByFocus.ready.add(taskSprintId || 'unassigned');
      if (epicId) epicIdsByFocus.ready.add(epicId);
    }
  }
  return {
    scopedTaskIds,
    backlogTaskIds,
    executionTaskIds,
    readyTaskIds,
    sprintIdsByFocus,
    epicIdsByFocus,
    epicCatalog: buildEpicCatalog(tasks, epicDependencies),
    counts: {
      all: scopedTaskIds.size,
      backlog: backlogTaskIds.size,
      execution: executionTaskIds.size,
      ready: readyTaskIds.size,
    },
  };
}

function extractGlobalDagPayload(...sources) {
  for (const source of sources) {
    const payload = extractDagPayload(source);
    if (!payload || typeof payload !== "object") continue;
    const candidate =
      payload?.dagOfDags ||
      payload?.globalDag ||
      payload?.globalGraph ||
      payload?.overviewDag ||
      payload?.overviewGraph;
    if (candidate) return candidate;
  }
  return null;
}

function buildSprintPathCandidates(basePath, sprintId) {
  if (!sprintId || sprintId === "all") return [basePath];
  const encoded = encodeURIComponent(sprintId);
  const join = basePath.includes("?") ? "&" : "?";
  return [
    `${basePath}${join}sprintId=${encoded}`,
    `${basePath}${join}sprint=${encoded}`,
    `${basePath}${join}id=${encoded}`,
    basePath,
  ];
}

async function fetchFirstAvailableDagPath(paths = []) {
  const attempts = Array.from(new Set(paths)).filter(Boolean);
  for (const path of attempts) {
    try {
      const payload = await apiFetch(path, { _silent: true });
      return { path, payload };
    } catch {
      // Try next endpoint candidate.
    }
  }
  return null;
}

export function buildTaskDescriptionFallback(rawTitle, rawDescription) {
  const title = sanitizeTaskText(rawTitle || "");
  const description = sanitizeTaskText(rawDescription || "");
  if (isPlaceholderTaskDescription(description)) {
    if (!title) {
      return "No description provided yet. Add scope, key files, and acceptance checks before dispatch.";
    }
    return `Implementation notes for "${title}". Include scope, key files, risks, and acceptance checks before dispatch.`;
  }
  if (description) return description;
  if (!title) {
    return "No description provided yet. Add scope, key files, and acceptance checks before dispatch.";
  }
  return `Implementation notes for "${title}". Include scope, key files, risks, and acceptance checks before dispatch.`;
}

function buildTaskDetailPath(taskId, options = {}) {
  const params = new URLSearchParams({ taskId: String(taskId || "") });
  if (options.includeDag === false) params.set("includeDag", "0");
  if (options.includeWorkflowRuns === false) params.set("includeWorkflowRuns", "0");
  return `/api/tasks/detail?${params.toString()}`;
}


function getTaskCollectionValues(task, keys = []) {
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    const value = task?.[key] ?? task?.meta?.[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        const marker = JSON.stringify(item);
        if (seen.has(marker)) continue;
        seen.add(marker);
        out.push(item);
      }
      continue;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        if (item == null) continue;
        const marker = JSON.stringify(item);
        if (seen.has(marker)) continue;
        seen.add(marker);
        out.push(item);
      }
    }
  }
  return out;
}

function buildTaskHistoryEntries(task) {
  const rows = getTaskCollectionValues(task, [
    "statusHistory",
    "history",
    "timeline",
    "eventLog",
    "events",
    "activity",
  ]);
  return rows
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        return {
          type: "event",
          label: entry,
          status: "",
          source: "",
          timestamp: null,
        };
      }
      const status = String(entry.status || entry.to || entry.nextStatus || "").trim();
      const fromStatus = String(entry.from || entry.previousStatus || "").trim();
      const eventName = String(entry.event || entry.type || entry.kind || "").trim();
      const source = String(entry.source || entry.by || entry.actor || "").trim();
      const timestamp =
        entry.timestamp ||
        entry.createdAt ||
        entry.updatedAt ||
        entry.at ||
        null;
      const label = eventName || (status ? `${fromStatus ? `${fromStatus} -> ` : ""}${status}` : "Task event");
      return {
        type: eventName || "status",
        label,
        status,
        source,
        timestamp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 40);
}

function pickTaskWorkflowSessionId(entry) {
  if (!entry || typeof entry !== "object") return "";
  for (const value of [
    entry.sessionId,
    entry.primarySessionId,
    entry.threadId,
    entry.agentSessionId,
    entry.meta?.sessionId,
    entry.meta?.threadId,
  ]) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function uniqueTaskWorkflowIdentityList(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeTaskWorkflowDelegationTopology(entry = {}) {
  const rawTopology =
    entry?.delegationTopology && typeof entry.delegationTopology === "object"
      ? entry.delegationTopology
      : (entry?.detail?.delegationTopology && typeof entry.detail.delegationTopology === "object"
          ? entry.detail.delegationTopology
          : (entry?.detail?.data?._delegationTopology && typeof entry.detail.data._delegationTopology === "object"
              ? entry.detail.data._delegationTopology
              : (entry?.data?._delegationTopology && typeof entry.data._delegationTopology === "object"
                  ? entry.data._delegationTopology
                  : null)));
  const topology = rawTopology && typeof rawTopology === "object" ? rawTopology : {};
  const pickString = (...candidates) => {
    for (const value of candidates) {
      const normalized = String(value || "").trim();
      if (normalized) return normalized;
    }
    return "";
  };
  const pickList = (...candidates) => {
    for (const value of candidates) {
      if (Array.isArray(value) && value.length > 0) return uniqueTaskWorkflowIdentityList(value);
    }
    return [];
  };
  const delegationDepthRaw = Number(topology.delegationDepth ?? entry?.delegationDepth ?? 0);
  const normalized = {
    runId: pickString(topology.runId, entry?.runId),
    rootRunId: pickString(topology.rootRunId, entry?.rootRunId),
    parentRunId: pickString(topology.parentRunId, entry?.parentRunId),
    taskId: pickString(topology.taskId, entry?.taskId, entry?.meta?.taskId, entry?.data?.taskId),
    rootTaskId: pickString(topology.rootTaskId, entry?.rootTaskId),
    parentTaskId: pickString(topology.parentTaskId, entry?.parentTaskId),
    sessionId: pickString(topology.sessionId, pickTaskWorkflowSessionId(entry)),
    rootSessionId: pickString(topology.rootSessionId, entry?.rootSessionId),
    parentSessionId: pickString(topology.parentSessionId, entry?.parentSessionId),
    delegationDepth: Number.isFinite(delegationDepthRaw) ? Math.max(0, Math.trunc(delegationDepthRaw)) : 0,
    childRunIds: pickList(topology.childRunIds, entry?.childRunIds),
    childSessionIds: pickList(topology.childSessionIds, entry?.childSessionIds),
    familyRunIds: pickList(topology.familyRunIds, entry?.familyRunIds),
    familySessionIds: pickList(topology.familySessionIds, entry?.familySessionIds),
  };
  const hasData = Object.entries(normalized).some(([key, value]) =>
    Array.isArray(value) ? value.length > 0 : (key === "delegationDepth" ? value > 0 : Boolean(value)),
  );
  return hasData ? normalized : null;
}

export function normalizeTaskWorkflowRunEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === "string") {
    const workflowId = String(entry || "").trim();
    return workflowId
      ? {
          workflowId,
          workflowName: "",
          workflowLabel: workflowId,
          runId: "",
          status: "",
          outcome: "",
          result: "",
          summary: "",
          timestamp: null,
          startedAt: null,
          endedAt: null,
          duration: null,
          sessionId: "",
          primarySessionId: "",
          hasRunLink: false,
          hasSessionLink: false,
          url: "",
          nodeId: "",
          plannerTimeline: [],
          proofBundle: null,
          proofSummary: null,
          issueAdvisor: null,
          runGraph: null,
          meta: {},
        }
      : null;
  }
  const workflowId = String(entry.workflowId || entry.id || entry.templateId || "").trim();
  const workflowName = String(entry.workflowName || entry.name || "").trim();
  const runId = String(entry.runId || entry.executionId || entry.attemptId || "").trim();
  const status = String(entry.status || "").trim();
  const outcome = String(entry.outcome || "").trim();
  const summary = String(entry.summary || entry.message || entry.reason || "").trim();
  const result = summary || String(entry.result || "").trim();
  const startedAt = entry.startedAt || entry.createdAt || null;
  const endedAt = entry.endedAt || entry.completedAt || entry.timestamp || null;
  const timestamp = endedAt || startedAt || null;
  const duration = Number.isFinite(Number(entry.duration))
    ? Number(entry.duration)
    : (startedAt && endedAt
        ? Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime())
        : null);
  const sessionId = pickTaskWorkflowSessionId(entry);
  const plannerTimeline = Array.isArray(entry.plannerTimeline)
    ? entry.plannerTimeline
    : (Array.isArray(entry.proofBundle?.plannerTimeline) ? entry.proofBundle.plannerTimeline : []);
  const proofBundle =
    entry.proofBundle && typeof entry.proofBundle === "object"
      ? { ...entry.proofBundle }
      : null;
  const proofSummary =
    entry.proofSummary && typeof entry.proofSummary === "object"
      ? { ...entry.proofSummary }
      : null;
  const delegationTopology = normalizeTaskWorkflowDelegationTopology(entry);
  return {
    workflowId,
    workflowName,
    workflowLabel: workflowName || workflowId || "workflow",
    runId,
    status,
    outcome,
    result,
    summary,
    timestamp,
    startedAt,
    endedAt,
    duration,
    sessionId,
    primarySessionId: String(entry.primarySessionId || sessionId).trim(),
    hasRunLink: Boolean(runId),
    hasSessionLink: Boolean(sessionId),
    url: String(entry.url || "").trim(),
    nodeId: String(entry.nodeId || "").trim(),
    plannerTimeline,
    proofBundle,
    proofSummary,
    issueAdvisor: entry.issueAdvisor && typeof entry.issueAdvisor === "object" ? { ...entry.issueAdvisor } : null,
    runGraph: entry.runGraph && typeof entry.runGraph === "object" ? { ...entry.runGraph } : null,
    rootRunId: delegationTopology?.rootRunId || String(entry.rootRunId || "").trim(),
    parentRunId: delegationTopology?.parentRunId || String(entry.parentRunId || "").trim(),
    rootTaskId: delegationTopology?.rootTaskId || String(entry.rootTaskId || "").trim(),
    parentTaskId: delegationTopology?.parentTaskId || String(entry.parentTaskId || "").trim(),
    rootSessionId: delegationTopology?.rootSessionId || String(entry.rootSessionId || "").trim(),
    parentSessionId: delegationTopology?.parentSessionId || String(entry.parentSessionId || "").trim(),
    delegationDepth: Number.isFinite(Number(delegationTopology?.delegationDepth ?? entry.delegationDepth))
      ? Math.max(0, Math.trunc(Number(delegationTopology?.delegationDepth ?? entry.delegationDepth)))
      : 0,
    childRunIds: Array.isArray(delegationTopology?.childRunIds) ? [...delegationTopology.childRunIds] : [],
    childSessionIds: Array.isArray(delegationTopology?.childSessionIds) ? [...delegationTopology.childSessionIds] : [],
    familyRunIds: Array.isArray(delegationTopology?.familyRunIds) ? [...delegationTopology.familyRunIds] : [],
    familySessionIds: Array.isArray(delegationTopology?.familySessionIds) ? [...delegationTopology.familySessionIds] : [],
    delegationTopology: delegationTopology ? { ...delegationTopology } : null,
    meta: entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {},
  };
}

function summarizeTaskWorkflowPlannerEvent(entry) {
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  const stepLabel = String(entry.stepLabel || entry.nodeLabel || entry.nodeId || "").trim();
  const summary = String(entry.summary || entry.reason || entry.error || "").trim();
  const attachmentKind = String(entry.attachmentKind || "").trim();
  const createdCount = Number(entry.createdCount || 0);
  const skippedCount = Number(entry.skippedCount || 0);
  if (stepLabel) parts.push(stepLabel);
  if (summary) parts.push(summary);
  if (attachmentKind) parts.push(attachmentKind.replaceAll("_", " "));
  if (createdCount > 0 || skippedCount > 0) {
    parts.push(`created ${createdCount} / skipped ${skippedCount}`);
  }
  return parts.join(" · ");
}

function buildTaskWorkflowProofBadges(run) {
  const summary = run?.proofSummary && typeof run.proofSummary === "object" ? run.proofSummary : {};
  const badges = [];
  const plannerEventCount = Number(summary.plannerEventCount || run?.plannerTimeline?.length || 0);
  const decisionCount = Number(summary.decisionCount || 0);
  const evidenceCount = Number(summary.evidenceCount || 0);
  const artifactCount = Number(summary.artifactCount || 0);
  if (plannerEventCount > 0) badges.push(`${plannerEventCount} planner events`);
  if (decisionCount > 0) badges.push(`${decisionCount} decisions`);
  if (evidenceCount > 0) badges.push(`${evidenceCount} evidence`);
  if (artifactCount > 0) badges.push(`${artifactCount} artifacts`);
  return badges;
}

export function buildTaskWorkflowRunLineageBadges(run) {
  const topology = run?.delegationTopology && typeof run.delegationTopology === "object"
    ? run.delegationTopology
    : normalizeTaskWorkflowDelegationTopology(run);
  const runGraph = run?.runGraph && typeof run.runGraph === "object" ? run.runGraph : null;
  const runCount = Array.isArray(runGraph?.runs) ? runGraph.runs.length : 0;
  const executionCount = Array.isArray(runGraph?.executions) ? runGraph.executions.length : 0;
  const timelineCount = Array.isArray(runGraph?.timeline) ? runGraph.timeline.length : 0;
  const retryCount = Array.isArray(runGraph?.edges)
    ? runGraph.edges.filter((entry) => entry?.type === "retry").length
    : 0;
  const badges = [];
  if (runCount > 0) badges.push(`${runCount} runs`);
  if (executionCount > 0) badges.push(`${executionCount} execution steps`);
  if (timelineCount > 0) badges.push(`${timelineCount} lineage events`);
  if (retryCount > 0) badges.push(`${retryCount} retries`);
  if (Number(topology?.delegationDepth || 0) > 0) badges.push(`depth ${Number(topology.delegationDepth)}`);
  if (Array.isArray(topology?.childRunIds) && topology.childRunIds.length > 0) {
    badges.push(`${topology.childRunIds.length} child runs`);
  }
  if (Array.isArray(topology?.childSessionIds) && topology.childSessionIds.length > 0) {
    badges.push(`${topology.childSessionIds.length} child sessions`);
  }
  return badges;
}

function buildTaskWorkflowRunTopologyLines(run) {
  const topology = run?.delegationTopology && typeof run.delegationTopology === "object"
    ? run.delegationTopology
    : normalizeTaskWorkflowDelegationTopology(run);
  if (!topology) return [];
  const taskLine = [
    topology.taskId ? `task ${topology.taskId}` : "",
    topology.parentTaskId && topology.parentTaskId !== topology.taskId ? `parent ${topology.parentTaskId}` : "",
    topology.rootTaskId && topology.rootTaskId !== topology.parentTaskId && topology.rootTaskId !== topology.taskId
      ? `root ${topology.rootTaskId}`
      : "",
  ].filter(Boolean);
  const sessionLine = [
    topology.sessionId ? `current ${truncate(topology.sessionId, 36)}` : "",
    topology.parentSessionId && topology.parentSessionId !== topology.sessionId
      ? `parent ${truncate(topology.parentSessionId, 36)}`
      : "",
    topology.rootSessionId && topology.rootSessionId !== topology.parentSessionId && topology.rootSessionId !== topology.sessionId
      ? `root ${truncate(topology.rootSessionId, 36)}`
      : "",
  ].filter(Boolean);
  const familyLine = [
    Array.isArray(topology.childRunIds) && topology.childRunIds.length > 0 ? `${topology.childRunIds.length} child runs` : "",
    Array.isArray(topology.childSessionIds) && topology.childSessionIds.length > 0 ? `${topology.childSessionIds.length} child sessions` : "",
    Array.isArray(topology.familyRunIds) && topology.familyRunIds.length > 1 ? `${topology.familyRunIds.length} family runs` : "",
  ].filter(Boolean);
  return [
    taskLine.length > 0 ? `Task lineage: ${taskLine.join(" · ")}` : "",
    sessionLine.length > 0 ? `Session ancestry: ${sessionLine.join(" · ")}` : "",
    familyLine.length > 0 ? familyLine.join(" · ") : "",
  ].filter(Boolean);
}

function buildTaskWorkflowRuns(task) {
  const rows = getTaskCollectionValues(task, [
    "workflowRuns",
    "workflowHistory",
    "workflows",
  ]);
  return rows
    .map((entry) => normalizeTaskWorkflowRunEntry(entry))
    .filter((entry) => entry && (entry.workflowId || entry.runId || entry.status || entry.result))
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 30);
}

export function buildTaskWorkflowRunMetaLine(run) {
  const parts = [];
  const label = String(run?.workflowLabel || run?.workflowName || run?.workflowId || "workflow").trim();
  if (label) parts.push(label);
  if (run?.runId) parts.push(`run ${run.runId}`);
  if (run?.timestamp) parts.push(formatRelative(run.timestamp));
  if (Number.isFinite(Number(run?.duration)) && Number(run.duration) > 0) {
    parts.push(formatDuration(Number(run.duration)));
  }
  return parts.join(" · ");
}

export function buildTaskWorkflowRunStatusLine(run) {
  const parts = [];
  const status = String(run?.status || "").trim();
  const outcome = String(run?.outcome || "").trim();
  const summary = String(run?.summary || run?.result || "").trim();
  if (status) parts.push(status);
  if (outcome && outcome !== status) parts.push(outcome);
  if (summary && summary !== status && summary !== outcome) parts.push(summary);
  return parts.join(" · ") || "No status summary";
}

function getTaskAuditText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function getTaskAuditValue(record, keys = []) {
  if (!record || typeof record !== "object") return "";
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) {
      const normalized = value.map((entry) => getTaskAuditText(entry)).filter(Boolean);
      if (normalized.length) return normalized.join(", ");
      continue;
    }
    const text = getTaskAuditText(value);
    if (text) return text;
  }
  return "";
}

function getTaskAuditNestedSummary(value) {
  if (!value || typeof value !== "object") return "";
  return getTaskAuditValue(value, [
    "summary",
    "message",
    "description",
    "title",
    "path",
    "reason",
    "error",
    "status",
    "decision",
    "recommendation",
    "kind",
    "type",
    "action",
    "actionType",
    "targetId",
    "toolName",
    "command",
    "cwd",
  ]);
}

function getTaskAuditTimestamp(record = {}) {
  return getTaskAuditValue(record, [
    "timestamp",
    "createdAt",
    "updatedAt",
    "startedAt",
    "completedAt",
    "promotedAt",
    "expires_at",
    "expiresAt",
    "claimed_at",
    "claimedAt",
    "renewed_at",
    "renewedAt",
  ]);
}

function formatTaskAuditTimestamp(record = {}) {
  const timestamp = getTaskAuditTimestamp(record);
  return timestamp ? formatRelative(timestamp) : "";
}

function formatTaskAuditConfidence(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  if (numeric >= 0 && numeric <= 1) return `${Math.round(numeric * 100)}%`;
  return String(numeric);
}

function summarizeTaskAuditClaim(claim = {}) {
  const bits = [];
  const owner = getTaskAuditValue(claim, ["instance_id", "instanceId", "owner", "ownerId"]);
  const token = getTaskAuditValue(claim, ["claim_token", "claimToken"]);
  const expiresAt = getTaskAuditValue(claim, ["expires_at", "expiresAt"]);
  const reason = getTaskAuditValue(claim, ["resolution_reason", "resolutionReason"]);
  if (owner) bits.push(`owner ${owner}`);
  if (token) bits.push(`token ${truncate(token, 24)}`);
  if (expiresAt) bits.push(`expires ${formatRelative(expiresAt)}`);
  if (reason) bits.push(reason);
  return bits.join(" · ") || "Claim snapshot recorded";
}

function summarizeTaskAuditClaimEvent(event = {}) {
  const action = getTaskAuditValue(event, ["action", "eventType"]) || "claim event";
  const owner = getTaskAuditValue(event, [
    "instance_id",
    "instanceId",
    "owner",
    "existing_instance",
    "existingInstance",
    "previous_instance",
    "previousInstance",
  ]);
  const reason = getTaskAuditValue(event, [
    "resolution_reason",
    "resolutionReason",
    "rollback_reason",
    "rollbackReason",
    "forfeit_reason",
    "forfeitReason",
  ]);
  return [action, owner ? `instance ${owner}` : "", reason].filter(Boolean).join(" · ") || "Claim event";
}

function summarizeTaskAuditToolCall(call = {}) {
  const toolName = getTaskAuditValue(call, ["toolName", "toolId"]) || "tool call";
  const status = getTaskAuditValue(call, ["status"]);
  const summary = getTaskAuditValue(call, ["summary"]) || getTaskAuditNestedSummary(call.response) || getTaskAuditNestedSummary(call.request);
  return [toolName, status && status !== toolName ? status : "", summary && summary !== status ? summary : ""]
    .filter(Boolean)
    .join(" · ") || "Tool call";
}

function summarizeTaskAuditArtifact(artifact = {}) {
  return getTaskAuditValue(artifact, ["summary", "path", "kind"]) || getTaskAuditNestedSummary(artifact.metadata) || "Artifact";
}

function summarizeTaskAuditOperatorAction(action = {}) {
  const actionType = getTaskAuditValue(action, ["actionType", "action"]) || "operator action";
  const targetId = getTaskAuditValue(action, ["targetId"]);
  const status = getTaskAuditValue(action, ["status"]);
  const summary = getTaskAuditNestedSummary(action.result) || getTaskAuditNestedSummary(action.metadata) || getTaskAuditNestedSummary(action.request);
  return [actionType, targetId ? `target ${targetId}` : "", status, summary].filter(Boolean).join(" · ") || "Operator action";
}

function summarizeTaskAuditPromotedStrategy(entry = {}) {
  const recommendation = getTaskAuditValue(entry, ["recommendation", "decision", "strategyId"]) || "strategy";
  const status = getTaskAuditValue(entry, ["status"]);
  const verification = getTaskAuditValue(entry, ["verificationStatus", "verification_status"]);
  const rationale = getTaskAuditValue(entry, ["rationale"]) || getTaskAuditNestedSummary(entry.document) || getTaskAuditNestedSummary(entry.payload);
  return [recommendation, status, verification, rationale].filter(Boolean).join(" · ") || "Promoted strategy";
}

function summarizeTaskAuditTraceEvent(event = {}) {
  const eventType = getTaskAuditValue(event, ["eventType"]) || "trace event";
  const summary = getTaskAuditValue(event, ["summary", "error"]) || getTaskAuditNestedSummary(event.meta) || getTaskAuditNestedSummary(event.payload);
  return [eventType, summary].filter(Boolean).join(" · ") || "Trace event";
}

function summarizeTaskAuditSessionActivity(activity = {}) {
  const summary = getTaskAuditValue(activity, ["lastSummary", "latestTaskTitle", "latestWorkflowName"]);
  const eventType = getTaskAuditValue(activity, ["latestEventType"]);
  const status = getTaskAuditValue(activity, ["latestStatus"]);
  const error = getTaskAuditValue(activity, ["lastErrorText"]);
  return [summary, eventType, status, error].filter(Boolean).join(" · ") || "Session activity";
}

function summarizeTaskAuditAgentActivity(activity = {}) {
  const summary = getTaskAuditValue(activity, ["lastSummary", "latestTaskTitle", "latestWorkflowName"]);
  const eventType = getTaskAuditValue(activity, ["latestEventType"]);
  const status = getTaskAuditValue(activity, ["latestStatus"]);
  const error = getTaskAuditValue(activity, ["lastErrorText"]);
  return [summary, eventType, status, error].filter(Boolean).join(" · ") || "Agent activity";
}

function resolveTaskWorkflowRunDelegationTopology(run = {}) {
  const candidates = [
    run?.delegationTopology,
    run?.meta?.delegationTopology,
    run?.detail?.delegationTopology,
    run?.detail?.data?._delegationTopology,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") return candidate;
  }
  return null;
}

function collectTaskWorkflowRunSessionIds(run = {}) {
  const topology = resolveTaskWorkflowRunDelegationTopology(run);
  const values = [
    run?.sessionId,
    run?.primarySessionId,
    run?.meta?.sessionId,
    run?.meta?.primarySessionId,
    topology?.sessionId,
    topology?.rootSessionId,
    topology?.parentSessionId,
    ...(Array.isArray(run?.sessionIds) ? run.sessionIds : []),
    ...(Array.isArray(topology?.sessionIds) ? topology.sessionIds : []),
  ];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function collectTaskDurableSessionIds(task = {}, workflowRuns = [], auditActivity = null) {
  const values = [
    task?.sessionId,
    task?.primarySessionId,
    task?.meta?.sessionId,
    task?.meta?.primarySessionId,
    ...(Array.isArray(task?.meta?.linkedSessionIds) ? task.meta.linkedSessionIds : []),
    ...(Array.isArray(auditActivity?.sessionIds) ? auditActivity.sessionIds : []),
    auditActivity?.sessionActivity?.sessionId,
  ];
  for (const run of workflowRuns || []) {
    values.push(...collectTaskWorkflowRunSessionIds(run));
  }
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function summarizeTaskDelegationTopology(topology = {}) {
  if (!topology || typeof topology !== "object") return "";
  const parts = [];
  const depth = Number(topology.delegationDepth);
  const rootTaskId = String(topology.rootTaskId || "").trim();
  const parentTaskId = String(topology.parentTaskId || "").trim();
  const rootSessionId = String(topology.rootSessionId || "").trim();
  const sessionCount = Array.isArray(topology.sessionIds) ? topology.sessionIds.length : 0;
  if (Number.isFinite(depth) && depth >= 0) parts.push(`depth ${depth}`);
  if (rootTaskId) parts.push(`root task ${rootTaskId}`);
  if (parentTaskId && parentTaskId !== rootTaskId) parts.push(`parent task ${parentTaskId}`);
  if (rootSessionId) parts.push(`root session ${rootSessionId}`);
  if (sessionCount > 0) parts.push(`${sessionCount} durable sessions`);
  return parts.join(" · ") || "Delegation topology recorded";
}

function buildTaskDelegationTopologyRows(workflowRuns = []) {
  return (workflowRuns || [])
    .map((run) => {
      const topology = resolveTaskWorkflowRunDelegationTopology(run);
      if (!topology) return null;
      return {
        run,
        topology,
        durableSessionIds: collectTaskWorkflowRunSessionIds(run),
        summary: summarizeTaskDelegationTopology(topology),
      };
    })
    .filter(Boolean);
}

function resolveTaskAuditSourceLabel(taskAuditActivity = null) {
  if (!taskAuditActivity || typeof taskAuditActivity !== "object") return "";
  const summary =
    taskAuditActivity.summary && typeof taskAuditActivity.summary === "object"
      ? taskAuditActivity.summary
      : {};
  return getTaskAuditValue(summary, ["stateSource", "storage", "store", "source"]) || "state ledger / SQLite";
}

export async function openTaskWorkflowRun(run, deps = {}) {
  const navigate = deps.navigateTo || navigateTo;
  let openRuns = deps.openWorkflowRunsView;
  if (!openRuns) {
    const wfMod = await import("./workflows.js");
    openRuns = wfMod.openWorkflowRunsView;
  }
  const workflowId = String(run?.workflowId || "").trim();
  const runId = String(run?.runId || "").trim();
  if (!runId) return false;
  const navigated = navigate("workflows");
  if (navigated === false) return false;
  openRuns(workflowId, runId);
  return true;
}

export async function openTaskWorkflowAgentHistory(run, deps = {}) {
  const navigate = deps.navigateTo || navigateTo;
  const loadAllSessions = deps.loadSessions || loadSessions;
  const loadMessages = deps.loadSessionMessages || loadSessionMessages;
  const selectedStore = deps.selectedSessionId || selectedSessionId;
  const sessionId = pickTaskWorkflowSessionId(run);
  if (!sessionId) return false;
  const navigated = navigate("agents");
  if (navigated === false) return false;
  await loadAllSessions({ type: "task", workspace: "all" });
  selectedStore.value = sessionId;
  await loadMessages(sessionId, { limit: 50 });
  return true;
}

export function pickTaskLinkedSessionId(task) {
  if (!task || typeof task !== "object") return "";
  for (const value of [
    task.sessionId,
    task.primarySessionId,
    task.meta?.sessionId,
    task.meta?.primarySessionId,
  ]) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  const rows = getTaskCollectionValues(task, [
    "workflowRuns",
    "workflowHistory",
    "workflows",
    "runs",
  ]);
  for (const entry of rows) {
    const sessionId = pickTaskWorkflowSessionId(entry);
    if (sessionId) return sessionId;
  }
  return "";
}

export async function openTaskLinkedSession(task, deps = {}) {
  const sessionId = pickTaskLinkedSessionId(task);
  if (!sessionId) return false;
  return openTaskWorkflowAgentHistory({ primarySessionId: sessionId }, deps);
}

function getTaskWorktreePath(task) {
  for (const value of [
    task?.worktreePath,
    task?.workspacePath,
    task?.meta?.worktreePath,
    task?.meta?.workspacePath,
    task?.meta?.execution?.worktreePath,
    task?.runtimeSnapshot?.slot?.worktreePath,
  ]) {
    const normalized = String(value || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function buildVsCodeFolderUri(worktreePath, scheme = "vscode") {
  const normalizedPath = String(worktreePath || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return "";
  return `${scheme}://file/${encodeURI(normalizedPath)}`;
}

export function buildTaskWorkspaceLaunchers(task) {
  const worktreePath = getTaskWorktreePath(task);
  if (!worktreePath) return [];
  const launchers = [
    {
      id: "vscode",
      label: "VS Code",
      href: buildVsCodeFolderUri(worktreePath, "vscode"),
    },
    {
      id: "vscode-insiders",
      label: "VS Code Insiders",
      href: buildVsCodeFolderUri(worktreePath, "vscode-insiders"),
    },
  ];
  return launchers.filter((entry) => entry.href);
}

function buildTaskRelatedLinks(task) {
  const links = [];
  const branch =
    task?.branchName ||
    task?.branch ||
    task?.meta?.branch ||
    task?.meta?.branchName ||
    "";
  const prNumber =
    task?.prNumber ||
    task?.pr ||
    task?.pr_number ||
    task?.meta?.prNumber ||
    task?.meta?.pr ||
    task?.meta?.pr_number ||
    task?.meta?.pr?.number ||
    "";
  const prUrl =
    task?.prUrl ||
    task?.pr_url ||
    task?.meta?.prUrl ||
    task?.meta?.pr_url ||
    task?.meta?.pr?.url ||
    "";
  const baseBranch = getTaskBaseBranch(task);

  if (branch) links.push({ kind: "Branch", value: branch, url: "", emphasis: true });
  if (baseBranch) links.push({ kind: "Base", value: baseBranch, url: "" });
  if (prNumber) links.push({ kind: "PR", value: `#${prNumber}`, url: prUrl || "", emphasis: true });
  if (prUrl) links.push({ kind: "PR URL", value: prUrl, url: prUrl });
  return links;
}

function renderTaskRelatedLinks(relatedLinks, { onReviewDiff = null } = {}) {
  if (!Array.isArray(relatedLinks) || !relatedLinks.length) {
    if (!onReviewDiff) return "No branch or PR links recorded.";
    return html`
      <div style=${{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
        <button
          type="button"
          class="task-related-link-chip"
          onClick=${onReviewDiff}
        >
          ${resolveIcon("edit") || "✎"} Review Diff
        </button>
      </div>
    `;
  }

  return html`
    <div style=${{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
      ${relatedLinks.map((item, index) => html`
        ${item.url
          ? html`
              <a
                key=${`task-link-${index}`}
                class="task-related-link-chip"
                data-emphasis=${item.emphasis ? "true" : "false"}
                href=${item.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span class="task-related-link-kind">${item.kind}</span>
                <span class="task-related-link-value">${item.value}</span>
              </a>
            `
          : html`
              <span
                key=${`task-link-${index}`}
                class="task-related-link-chip"
                data-emphasis=${item.emphasis ? "true" : "false"}
              >
                <span class="task-related-link-kind">${item.kind}</span>
                <span class="task-related-link-value">${item.value}</span>
              </span>
            `}
      `)}
      ${onReviewDiff && html`
        <button
          type="button"
          class="task-related-link-chip"
          data-emphasis="true"
          onClick=${onReviewDiff}
        >
          <span class="task-related-link-kind">Review</span>
          <span class="task-related-link-value">Open Diff</span>
        </button>
      `}
    </div>
  `;
}

function buildTaskAgentList(task) {
  const values = [];
  const pushValue = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || values.includes(normalized)) return;
    values.push(normalized);
  };

  pushValue(task?.assignee);
  const assignees = task?.assignees || task?.meta?.assignees;
  if (Array.isArray(assignees)) {
    for (const item of assignees) {
      if (typeof item === "string") pushValue(item);
      else pushValue(item?.name || item?.id || item?.agentId);
    }
  }

  pushValue(task?.meta?.execution?.sdk);
  pushValue(task?.meta?.execution?.model);
  pushValue(task?.meta?.executor);
  return values;
}

async function confirmTaskLifecycleTransition(task, newStatus) {
  const next = normalizeTaskLifecycleStatus(newStatus);
  const prev = normalizeTaskLifecycleStatus(task?.status || "todo");
  const action = classifyTaskLifecycleAction(prev, next);
  const taskLabel = sanitizeTaskText(task?.title || task?.id || "this task");

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

async function applyTaskLifecycleTransition(task, requestedStatus) {
  if (!task?.id) return { ok: false, cancelled: true, action: "noop" };
  const decision = await confirmTaskLifecycleTransition(task, requestedStatus);
  if (!decision.ok) return { ok: false, cancelled: true, action: decision.action };

  const wantsDraft = decision.nextStatus === "draft";
  const prevTasks = cloneValue(tasksData.value);
  const optimisticStatus = decision.action === "start"
    ? String(task?.status || "todo")
    : decision.nextStatus;
  let apiResult = null;

  await runOptimistic(
    () => {
      tasksData.value = tasksData.value.map((row) =>
        row.id === task.id ? { ...row, status: optimisticStatus, draft: wantsDraft } : row,
      );
    },
    async () => {
      if (decision.action === "start") {
        apiResult = await apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId: task.id }),
        });
        const detail = await apiFetch(
          `/api/tasks/detail?taskId=${encodeURIComponent(task.id)}`,
          { _silent: true },
        ).catch(() => null);
        const merged = detail?.data || apiResult?.data || null;
        if (merged) {
          tasksData.value = tasksData.value.map((row) =>
            row.id === task.id ? { ...row, ...merged } : row,
          );
        }
        return apiResult;
      }

      apiResult = await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          status: decision.nextStatus,
          draft: wantsDraft,
          lifecycleAction: decision.action,
          pauseExecution: decision.action === "pause",
        }),
      });
      if (apiResult?.data) {
        tasksData.value = tasksData.value.map((row) =>
          row.id === task.id ? { ...row, ...apiResult.data } : row,
        );
      }
      return apiResult;
    },
    () => {
      tasksData.value = prevTasks;
    },
  );

  const resolvedStatus =
    String(apiResult?.data?.status || "").trim() || optimisticStatus;

  return {
    ok: true,
    cancelled: false,
    action: decision.action,
    status: resolvedStatus,
    response: apiResult,
  };
}
export function StartTaskModal({
  task,
  defaultSdk = "auto",
  allowTaskIdInput = false,
  presentation = "modal",
  onClose,
  onStart,
}) {
  const [sdk, setSdk] = useState(defaultSdk || "auto");
  const [model, setModel] = useState("");
  const [taskIdInput, setTaskIdInput] = useState(task?.id || "");
  const [starting, setStarting] = useState(false);
  const initialSnapshotRef = useRef({
    sdk: defaultSdk || "auto",
    model: "",
    taskIdInput: task?.id || "",
  });
  const pendingKey = useMemo(
    () => `modal:start-task:${task?.id || "manual"}`,
    [task?.id],
  );

  useEffect(() => {
    const next = {
      sdk: defaultSdk || "auto",
      model: "",
      taskIdInput: task?.id || "",
    };
    initialSnapshotRef.current = next;
    setSdk(next.sdk);
    setModel(next.model);
    setTaskIdInput(next.taskIdInput);
  }, [defaultSdk, task?.id, task?.meta?.codex?.isIgnored, task?.meta?.labels]);

  const canModel = sdk && sdk !== "auto";

  const EXECUTOR_MODELS = {
    codex: [
      "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex",
      "gpt-5.1-codex-mini", "gpt-5.1-codex-max",
      "gpt-5.2", "gpt-5.1", "gpt-5-mini",
    ],
    copilot: [
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5",
      "claude-sonnet-4", "claude-haiku-4.5",
      "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini",
      "gpt-5.2", "gpt-5.1", "gpt-5-mini",
      "gemini-3.1-pro", "gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro",
      "grok-code-fast-1",
    ],
    claude: [
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5",
      "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5",
    ],
  };

  const resolvedTaskId = (task?.id || taskIdInput || "").trim();
  const currentSnapshot = useMemo(
    () => ({
      sdk: sdk || "auto",
      model: model || "",
      taskIdInput: taskIdInput || "",
    }),
    [model, sdk, taskIdInput],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, currentSnapshot),
    [currentSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setSdk(base.sdk || "auto");
    setModel(base.model || "");
    setTaskIdInput(base.taskIdInput || task?.id || "");
    showToast("Changes discarded", "info");
  }, [task?.id]);

  const handleStart = async ({ closeAfterStart = true } = {}) => {
    if (starting) return;
    if (!resolvedTaskId) {
      showToast("Task ID is required", "error");
      return false;
    }
    setStarting(true);
    try {
      await onStart?.({
        taskId: resolvedTaskId,
        sdk: sdk && sdk !== "auto" ? sdk : undefined,
        model: model.trim() ? model.trim() : undefined,
      });
      initialSnapshotRef.current = {
        sdk: sdk || "auto",
        model: model || "",
        taskIdInput: taskIdInput || "",
      };
      if (closeAfterStart) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      /* toast via apiFetch */
      return false;
    } finally {
      setStarting(false);
    }
  };

  return html`
    <${Modal}
      title="Start Task"
      onClose=${onClose}
      contentClassName=${"modal-content-wide task-detail-modal-jira" + (presentation === "side-sheet" ? " task-detail-side-sheet" : "")}
      layout=${presentation === "side-sheet" ? "side-sheet" : "sheet"}
      resizable=${presentation === "side-sheet"}
      widthStorageKey="tasks.task-detail.width"
      defaultWidth=${860}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleStart({ closeAfterStart: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${starting ? "Task dispatch is still running" : ""}
    >
      ${task?.id || task?.title
        ? html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1 }}>
              ${task?.title || "(untitled)"} · ${task?.id || "—"}
            <//>`
        : html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1 }}>
              Enter a task ID to manually dispatch it. Manual starts work even if automation is paused.
            <//>`}
      <${Stack} spacing=${2}>
        ${(allowTaskIdInput || !task?.id) &&
        html`
          <${Autocomplete}
            freeSolo
            size="small"
            fullWidth
            options=${(() => {
              const STARTABLE = new Set(["draft", "backlog", "open", "new", "todo", "blocked", "error", "failed"]);

              const getGroup = (s) => {
                const lower = (s || "").toLowerCase();
                if (lower === "draft") return "Draft";
                if (["blocked", "error", "failed"].includes(lower)) return "Blocked";
                return "Todo";
              };
              return (tasksData.value || [])
                .filter(t => STARTABLE.has((t.status || "").toLowerCase()))
                .map(t => ({ id: t.id, title: t.title || "(untitled)", status: t.status, group: getGroup(t.status) }))
                .sort((a, b) => a.group.localeCompare(b.group) || (a.title || "").localeCompare(b.title || ""));
            })()}
            groupBy=${(opt) => opt.group || ""}
            getOptionLabel=${(opt) => typeof opt === "string" ? opt : opt.title ? `${opt.title} (${opt.id})` : opt.id || ""}
            isOptionEqualToValue=${(opt, val) => opt.id === (typeof val === "string" ? val : val?.id)}
            inputValue=${taskIdInput}
            onInputChange=${(_, val) => setTaskIdInput(val || "")}
            onChange=${(_, val) => {
              if (val && typeof val === "object" && val.id) {
                setTaskIdInput(val.id);
              } else if (typeof val === "string") {
                setTaskIdInput(val);
              }
            }}
            renderInput=${(params) => html`<${TextField} ...${params} label="Task ID" placeholder="Search or enter task ID" />`}
            renderOption=${(props, opt) => html`<li ...${props} key=${opt.id}><${Box} sx=${{ display: "flex", flexDirection: "column" }}><${Typography} variant="body2">${opt.title}<//><${Typography} variant="caption" color="text.secondary">${opt.id}<//><//>
            </li>`}
            disablePortal
          />
        `}
        <${TextField}
          select
          label="Executor SDK"
          size="small"
          fullWidth
          value=${sdk}
          onChange=${(e) => setSdk(e.target.value)}
        >
          ${["auto", "codex", "copilot", "claude"].map(
            (opt) => html`<${MenuItem} key=${opt} value=${opt}>${opt}<//>`
          )}
        <//>
        <${TextField}
          select
          label="Model Override (optional)"
          size="small"
          fullWidth
          value=${model}
          disabled=${!canModel}
          onChange=${(e) => setModel(e.target.value)}
        >
          <${MenuItem} value="">Auto (default)<//>
          ${canModel && (EXECUTOR_MODELS[sdk] || []).map(m => html`<${MenuItem} key=${m} value=${m}>${m}<//>`)}
        <//>
        <${Button}
          variant="contained"
          fullWidth
          onClick=${() => {
            void handleStart({ closeAfterStart: true });
          }}
          disabled=${starting || !resolvedTaskId}
        >
          ${starting ? "Starting…" : iconText(":play: Start Task")}
        <//>
      <//>
      <${SaveDiscardBar}
        dirty=${hasUnsaved}
        message=${unsavedChangesMessage(changeCount)}
        saveLabel="Start Task"
        discardLabel="Discard"
        onSave=${() => {
          void handleStart({ closeAfterStart: false });
        }}
        onDiscard=${resetToInitial}
        saving=${starting}
      />
    <//>
  `;
}

function TriggerTemplateCard({
  template,
  saving,
  onToggleEnabled,
  onSaveTemplate,
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(template?.name || "");
  const [description, setDescription] = useState(template?.description || "");
  const [action, setAction] = useState(template?.action || "create-task");
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(
    template?.minIntervalMinutes || "",
  );
  const [triggerJson, setTriggerJson] = useState(
    JSON.stringify(template?.trigger || { anyOf: [] }, null, 2),
  );
  const [configJson, setConfigJson] = useState(
    JSON.stringify(template?.config || {}, null, 2),
  );

  useEffect(() => {
    setName(template?.name || "");
    setDescription(template?.description || "");
    setAction(template?.action || "create-task");
    setMinIntervalMinutes(template?.minIntervalMinutes || "");
    setTriggerJson(JSON.stringify(template?.trigger || { anyOf: [] }, null, 2));
    setConfigJson(JSON.stringify(template?.config || {}, null, 2));
    setError("");
  }, [template?.id, template?.name, template?.description, template?.action, template?.enabled]);

  const state = template?.state || {};
  const stats = template?.stats || {};
  const recentSpawned = Array.isArray(stats.recentSpawned)
    ? stats.recentSpawned
    : [];
  const runningAgents = Array.isArray(stats.runningAgents)
    ? stats.runningAgents
    : [];

  const handleSave = async () => {
    try {
      setError("");
      const parsedTrigger = JSON.parse(triggerJson || "{}");
      const parsedConfig = JSON.parse(configJson || "{}");
      await onSaveTemplate({
        ...template,
        name: String(name || "").trim() || template?.id,
        description: String(description || "").trim(),
        action,
        minIntervalMinutes:
          Number.isFinite(Number(minIntervalMinutes)) &&
          Number(minIntervalMinutes) > 0
            ? Number(minIntervalMinutes)
            : undefined,
        trigger: parsedTrigger,
        config: parsedConfig,
      });
      setEditing(false);
    } catch (err) {
      setError(err?.message || "Invalid JSON in template fields");
    }
  };

  return html`
    <${Paper} sx=${{ mb: 1.25, p: 1.5 }}>
      <${Stack} direction="row" justifyContent="space-between" alignItems="flex-start" spacing=${1.25}>
        <${Box} sx=${{ minWidth: 0 }}>
          <${Typography} variant="subtitle2" sx=${{ fontSize: 13 }}>${template?.name || template?.id}<//>
          <${Typography} variant="caption" color="text.secondary" sx=${{ wordBreak: 'break-all' }}>${template?.id || ""}<//>
        <//>
        <${FormControlLabel}
          control=${h(Switch, {
            checked: template?.enabled === true,
            disabled: saving,
            onChange: (event) => onToggleEnabled(template, event.target.checked),
            size: "small",
          })}
          label="enabled"
          sx=${{ '& .MuiFormControlLabel-label': { fontSize: 12, color: 'text.secondary' } }}
        />
      <//>

      ${template?.description && html`<${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.75 }}>${template.description}<//>`}

      <${Stack} direction="row" flexWrap="wrap" gap=${0.75} sx=${{ mt: 1 }}>
        <${Chip} label=${"spawned: " + (stats.spawnedTotal || 0)} size="small" variant="outlined" />
        <${Chip} label=${"active: " + (stats.activeCount || 0)} size="small" variant="outlined" />
        <${Chip} label=${"running: " + runningAgents.length} size="small" variant="outlined" />
        <${Chip} label=${"action: " + (template?.action || "create-task")} size="small" variant="outlined" />
      <//>

      <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 1, display: 'block' }}>
        Last success: ${state?.last_success_at ? formatRelative(state.last_success_at) : "never"}
        ${state?.last_error ? ` · Last error: ${truncate(state.last_error, 100)}` : ""}
      <//>

      ${runningAgents.length > 0 && html`
        <${Typography} variant="caption" sx=${{ mt: 1, fontWeight: 600, display: 'block' }}>Running agents<//>
        <${Stack} spacing=${0.5} sx=${{ mt: 0.5 }}>
          ${runningAgents.map((entry) => html`
            <${Typography} variant="caption" color="text.secondary">
              ${entry.taskId} · ${entry.sdk || "auto"}${entry.model ? ` · ${entry.model}` : ""}
            <//>
          `)}
        <//>
      `}

      ${recentSpawned.length > 0 && html`
        <${Typography} variant="caption" sx=${{ mt: 1, fontWeight: 600, display: 'block' }}>Recent spawned tasks<//>
        <${Stack} spacing=${0.5} sx=${{ mt: 0.5 }}>
          ${recentSpawned.map((entry) => html`
            <${Typography} variant="caption" color="text.secondary">
              ${entry.id} · ${entry.status || "todo"} · ${entry.createdAt ? formatRelative(entry.createdAt) : "unknown"}
            <//>
          `)}
        <//>
      `}

      ${editing && html`
        <${Stack} spacing=${1} sx=${{ mt: 1.25 }}>
          <${TextField} size="small" fullWidth value=${name} onChange=${(e) => setName(e.target.value)} placeholder="Template name" />
          <${TextField} size="small" fullWidth value=${description} onChange=${(e) => setDescription(e.target.value)} placeholder="Description" />
          <${Stack} direction="row" spacing=${1}>
            <${TextField} select size="small" fullWidth value=${action} onChange=${(e) => setAction(e.target.value)}>
              <${MenuItem} value="create-task">create-task<//>
            <//>
            <${TextField}
              size="small"
              fullWidth
              type="number"
              inputProps=${{ min: 1 }}
              value=${minIntervalMinutes}
              onChange=${(e) => setMinIntervalMinutes(e.target.value)}
              placeholder="Min interval (minutes)"
            />
          <//>
          <${TextField} multiline rows=${6} fullWidth size="small" value=${triggerJson} onChange=${(e) => setTriggerJson(e.target.value)} />
          <${TextField} multiline rows=${6} fullWidth size="small" value=${configJson} onChange=${(e) => setConfigJson(e.target.value)} />
          ${error && html`<${Alert} severity="error" variant="outlined" sx=${{ py: 0 }}>${error}<//>`}
        <//>
      `}

      <${Stack} direction="row" spacing=${1} sx=${{ mt: 1.25 }}>
        <${Button} variant="text" size="small" onClick=${() => setEditing((prev) => !prev)}>
          ${editing ? "Close Editor" : "Edit"}
        <//>
        ${editing && html`
          <${Button} variant="contained" size="small" disabled=${saving} onClick=${handleSave}>
            ${saving ? "Saving…" : "Save Template"}
          <//>
        `}
      <//>
    <//>
  `;
}

function sanitizeTriggerTemplatePayload(template = {}) {
  if (!template || typeof template !== "object") {
    return {};
  }
  const payload = {};
  for (const key of [
    "id",
    "name",
    "description",
    "enabled",
    "action",
    "minIntervalMinutes",
    "trigger",
    "config",
  ]) {
    if (Object.prototype.hasOwnProperty.call(template, key)) {
      payload[key] = template[key];
    }
  }
  return payload;
}

function TriggerTemplatesModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [defaults, setDefaults] = useState({ executor: "auto", model: "auto" });
  const [templates, setTemplates] = useState([]);

  const defaultsBaselineRef = useRef({ executor: "auto", model: "auto" });
  const pendingKey = "modal:trigger-templates";

  const defaultsSnapshot = useMemo(
    () => ({
      executor: String(defaults?.executor || "auto"),
      model: String(defaults?.model || "auto"),
    }),
    [defaults],
  );
  const defaultsDirtyCount = useMemo(
    () => countChangedFields(defaultsBaselineRef.current, defaultsSnapshot),
    [defaultsSnapshot],
  );
  const hasUnsavedDefaults = defaultsDirtyCount > 0;

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/triggers/templates", { _silent: true });
      const data = res?.data || {};
      setEnabled(data.enabled === true);
      const normalizedDefaults =
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" };
      defaultsBaselineRef.current = {
        executor: String(normalizedDefaults.executor || "auto"),
        model: String(normalizedDefaults.model || "auto"),
      };
      setDefaults(normalizedDefaults);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      setError(err?.message || "Failed to load templates");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTemplates();
  }, []);

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsavedDefaults);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsavedDefaults]);

  const persistUpdate = async (payload) => {
    setSaving(true);
    setError("");
    try {
      const res = await apiFetch("/api/triggers/templates/update", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = res?.data || {};
      setEnabled(data.enabled === true);
      const normalizedDefaults =
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" };
      defaultsBaselineRef.current = {
        executor: String(normalizedDefaults.executor || "auto"),
        model: String(normalizedDefaults.model || "auto"),
      };
      setDefaults(normalizedDefaults);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      showToast("Template settings updated", "success");
      scheduleRefresh(200);
    } catch (err) {
      setError(err?.message || "Failed to update templates");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSystem = async (nextEnabled) => {
    setEnabled(nextEnabled);
    try {
      await persistUpdate({ enabled: nextEnabled });
    } catch {
      setEnabled((prev) => !prev);
    }
  };

  const handleSaveDefaults = async ({ closeAfterSave = false } = {}) => {
    try {
      await persistUpdate({ defaults });
      if (closeAfterSave) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      return false;
    }
  };

  const handleDiscardDefaults = useCallback(() => {
    const base = defaultsBaselineRef.current || { executor: "auto", model: "auto" };
    setDefaults({
      executor: base.executor || "auto",
      model: base.model || "auto",
    });
    showToast("Changes discarded", "info");
  }, []);

  const handleToggleTemplate = async (template, nextEnabled) => {
    await persistUpdate({
      template: {
        ...sanitizeTriggerTemplatePayload(template),
        enabled: nextEnabled,
      },
    });
  };

  const handleSaveTemplate = async (template) => {
    await persistUpdate({ template: sanitizeTriggerTemplatePayload(template) });
  };

  return html`
    <${Modal}
      title="Trigger Templates"
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      unsavedChanges=${defaultsDirtyCount}
      onSaveBeforeClose=${() => handleSaveDefaults({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        handleDiscardDefaults();
        return true;
      }}
      activeOperationLabel=${saving ? "Template update request is still running" : ""}
    >
      <div class="flex-col" style="gap:10px;">
        <div class="card" style="padding:10px 12px;">
          <div class="flex-between" style="gap:10px;align-items:center;">
            <div>
              <div class="card-subtitle">Trigger System</div>
              <div class="meta-text">Enable/disable the full trigger template engine.</div>
            </div>
            <label class="meta-text" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <${Switch} size="small" checked=${enabled} disabled=${saving} onChange=${(event) => handleToggleSystem(event.target.checked)} />
              ${enabled ? "enabled" : "disabled"}
            </label>
          </div>

          <${Alert} severity="info" variant="outlined" sx=${{ mt: 1.25 }}>
            Trigger Templates are reusable automation rules. Each template watches for a trigger condition and can automatically create follow-up task work using the configured action and defaults below.
          </${Alert}>

          <div class="input-row" style="margin-top:10px;">
            <${Select}
              size="small"
              value=${defaults.executor || "auto"}
              onChange=${(e) => setDefaults({ ...defaults, executor: e.target.value })}
              disabled=${saving}
            >
              ${["auto", "codex", "copilot", "claude"].map(
                (opt) => html`<${MenuItem} value=${opt}>default executor: ${opt}</${MenuItem}>`,
              )}
            </${Select}>
            <${TextField} size="small" variant="outlined" value=${defaults.model || "auto"} disabled=${saving} onInput=${(e) => setDefaults({ ...defaults, model: e.target.value })} placeholder="default model (auto)" fullWidth />
          </div>
          <div class="btn-row" style="margin-top:8px;">
            <${Button} variant="outlined" size="small" disabled=${saving} onClick=${handleSaveDefaults}>
              Save Defaults
            <//>
            <${Button} variant="text" size="small" disabled=${loading || saving} onClick=${loadTemplates}>
              Refresh
            <//>
          </div>


        </div>

        ${error && html`<div class="meta-text" style="color:var(--color-error);">${error}</div>`}

        ${loading && html`<${SkeletonCard} />`}

        ${!loading && templates.length === 0 && html`
          <${EmptyState}
            message="No trigger templates found"
            description="Add templates in bosun.config.json under triggerSystem.templates. These templates define automation rules that can create follow-up task work when their trigger conditions match."
          />
        `}

        ${!loading && templates.map((template) => html`
          <${TriggerTemplateCard}
            key=${template.id}
            template=${template}
            saving=${saving}
            onToggleEnabled=${handleToggleTemplate}
            onSaveTemplate=${handleSaveTemplate}
          />
        `)}
        <${SaveDiscardBar}
          dirty=${hasUnsavedDefaults}
          message=${unsavedChangesMessage(defaultsDirtyCount)}
          saveLabel="Save Defaults"
          discardLabel="Discard"
          onSave=${() => {
            void handleSaveDefaults({ closeAfterSave: false });
          }}
          onDiscard=${handleDiscardDefaults}
          saving=${saving}
        />
      </div>
    <//>
  `;
}

/* ─── Helper: is a task actively running / in review? ─── */
function isActiveStatus(s) {
  return ["inprogress", "running", "working", "active", "assigned", "started"].includes(String(s || ""));
}
function isReviewStatus(s) {
  return ["inreview", "review", "pr-open", "pr-review"].includes(String(s || ""));
}

function getTaskRuntimeSnapshot(task) {
  return task?.runtimeSnapshot || task?.meta?.runtimeSnapshot || null;
}

function hasLiveExecutionEvidence(task) {
  const runtime = getTaskRuntimeSnapshot(task);
  if (runtime?.isLive === true) return true;
  if (runtime?.state === "running") return true;
  if (runtime?.slot?.taskId) return true;
  return false;
}

async function reactivateTaskSession(taskId, options = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return false;

  const askFirst = options?.askFirst !== false;
  const title = String(options?.title || "this task").trim();

  if (askFirst) {
    const ok = await showConfirm(
      `Task moved to review. Reactivate agent session for "${title}" now?`,
    );
    if (!ok) return false;
  }

  haptic("medium");
  const res = await apiFetch("/api/tasks/start", {
    method: "POST",
    body: JSON.stringify({ taskId: normalizedTaskId }),
  });
  if (res?.queued) {
    showToast("Agent reactivation queued (waiting for free slot)", "info");
  } else if (res?.wasPaused) {
    showToast("Agent reactivated (executor was paused)", "warning");
  } else {
    showToast("Agent session reactivated", "success");
  }

  const nextStatus = String(res?.data?.status || (res?.queued ? "queued" : "inprogress")).trim() || "todo";
  tasksData.value = (tasksData.value || []).map((t) =>
    String(t?.id || "").trim() === normalizedTaskId
      ? {
          ...t,
          ...(res?.data || {}),
          status: nextStatus,
        }
      : t,
  );
  scheduleRefresh(150);
  return true;
}

/* ─── TaskProgressModal — live view for in-progress tasks ─── */
export function TaskProgressModal({ task, onClose }) {
  const [liveTask, setLiveTask] = useState(task);
  const [health, setHealth] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const logEndRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const taskRes = await apiFetch(
          buildTaskDetailPath(task.id, {
            includeDag: false,
            includeWorkflowRuns: false,
          }),
          { _silent: true },
        );
        if (!cancelled && taskRes?.data) setLiveTask(taskRes.data);

        const healthRes = await apiFetch(`/api/supervisor/task/${task.id}`, { _silent: true });
        if (!cancelled && healthRes?.taskId) setHealth(healthRes);

        const branch = task.branch || (taskRes?.data?.branch) || "";
        if (branch) {
          const logRes = await apiFetch(
            `/api/agent-logs/tail?file=${encodeURIComponent(branch)}&lines=40`,
            { _silent: true },
          );
          if (!cancelled && logRes?.data?.lines) {
            setLogs(logRes.data.lines);
            setLogsLoading(false);
          } else if (!cancelled) {
            setLogsLoading(false);
          }
        } else {
          if (!cancelled) setLogsLoading(false);
        }
      } catch {
        if (!cancelled) setLogsLoading(false);
      }
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [task.id]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const runtime = getTaskRuntimeSnapshot(liveTask || task);

  const healthScore = health?.currentHealthScore ?? health?.averageHealthScore ?? null;
  const healthColor =
    healthScore == null ? "var(--text-hint)"
    : healthScore >= 80 ? "var(--color-done)"
    : healthScore >= 50 ? "var(--color-inprogress)"
    : "var(--color-error)";

  const startedRelative = liveTask?.created ? formatRelative(liveTask.created) : "—";
  const agentLabel = liveTask?.assignee || task.assignee || "Agent";
  const branchLabel = liveTask?.branch || task.branch || "—";
  const runtimeState = runtime?.state || "pending";
  const runtimeLabel = runtime?.statusLabel || "Live execution";
  const activeSlots = Number(runtime?.executor?.activeSlots || 0);
  const maxParallel = Number(runtime?.executor?.maxParallel || 0);

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    setCancelling(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "cancelled" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "cancelled" } : t,
      );
      showToast("Task cancelled", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
    setCancelling(false);
  };

  const handleMarkReview = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "inreview" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "inreview" } : t,
      );
      showToast("Task moved to review", "success");
      await reactivateTaskSession(task.id, {
        askFirst: true,
        title: task?.title || task?.id || "this task",
      }).catch(() => {});
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  return html`
    <${Modal}
      title=${liveTask?.title || task.title || "Task Progress"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-progress-modal"
    >
      
      <div class="tp-hero">
        <div class="tp-pulse-dot"></div>
        <div class="tp-hero-title">
          <div class="tp-hero-status-label">${iconText(`:zap: ${runtimeLabel}`)}</div>
        </div>
        <${Badge} status="inprogress" text=${runtimeState} />
      </div>

      
      <div class="tp-meta-strip">
        <div class="tp-meta-item">
          <span class="tp-meta-label">Agent</span>
          <span class="tp-meta-value">${agentLabel}</span>
        </div>
        <div class="tp-meta-item">
          <span class="tp-meta-label">Branch</span>
          <span class="tp-meta-value mono">${branchLabel}</span>
        </div>
        <div class="tp-meta-item">
          <span class="tp-meta-label">Started</span>
          <span class="tp-meta-value">${startedRelative}</span>
        </div>
        ${healthScore != null && html`
          <div class="tp-meta-item">
            <span class="tp-meta-label">Health</span>
            <span class="tp-meta-value" style="color:${healthColor};">${healthScore}%</span>
          </div>
        `}
        ${liveTask?.priority && html`
          <div class="tp-meta-item">
            <span class="tp-meta-label">Priority</span>
            <span class="tp-meta-value"><${Badge} status=${liveTask.priority} text=${liveTask.priority} /></span>
          </div>
        `}
      </div>

      
      <div class="tp-section">
        <div class="tp-section-title">Progress · step ${currentStep + 1} of ${steps.length}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${steps.map((step, i) => {
            const done = i < currentStep;
            const active = i === currentStep;
            const pending = i > currentStep;
            return html`
              <div
                key=${i}
                style="display:flex;align-items:center;gap:10px;font-size:13px;
                       color:${done ? "var(--color-done)" : active ? "var(--text-bright)" : "var(--text-hint)"};
                       font-weight:${active ? "600" : "400"};"
              >
                <span style="font-size:14px;flex-shrink:0;">
                  ${done ? resolveIcon(":check:") : active ? resolveIcon(":refresh:") : ICONS.dot}
                </span>
                <span>${step.label}</span>
                ${active && html`
                  <span style="margin-left:auto;font-size:11px;color:var(--color-inprogress);
                                animation:fadeInOut 2s ease-in-out infinite;">working…</span>
                `}
              </div>
            `;
          })}
        </div>
      </div>

      
      <div class="tp-section" style="padding-top:0;">
        <div class="tp-section-title">Live Log Tail</div>
        <div class="tp-log-container">
          ${logsLoading && html`<div class="tp-log-loading">Fetching logs…</div>`}
          ${!logsLoading && logs.length === 0 && html`
            <div class="tp-log-empty">No log output yet for branch: ${branchLabel}</div>
          `}
          ${logs.map((line, i) => html`<div class="tp-log-line" key=${i}>${line}</div>`)}
          <div ref=${logEndRef}></div>
        </div>
      </div>

      
      <div class="btn-row tp-actions">
        <${Tooltip} title="Guide the agent mid-task"><${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/steer " + task.id); onClose(); }}>${iconText(":chat: Steer")}<//><//>
        <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}>${iconText(":file: Logs")}<//>
        <${Button} variant="outlined" size="small" onClick=${handleMarkReview}>→ Move to Review<//>
        <${Button} variant="text" size="small" style=${{ color: "var(--color-error)" }} onClick=${handleCancel} disabled=${cancelling}>${cancelling ? "Cancelling…" : iconText("✕ Cancel")}<//>
      </div>
    <//>
  `;
}

/* ─── TaskReviewModal — view for in-review tasks ─── */
export function TaskReviewModal({ task, onClose, onStart }) {
  const [liveTask, setLiveTask] = useState(task);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const taskRes = await apiFetch(
          buildTaskDetailPath(task.id, {
            includeDag: false,
            includeWorkflowRuns: false,
          }),
          { _silent: true },
        );
        if (!cancelled && taskRes?.data) setLiveTask(taskRes.data);

        const healthRes = await apiFetch(`/api/supervisor/task/${task.id}`, { _silent: true });
        if (!cancelled && healthRes?.taskId) setHealth(healthRes);
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [task.id]);

  const healthScore = health?.currentHealthScore ?? health?.averageHealthScore ?? null;
  const reviewVerdict = health?.reviewVerdict ?? null;
  const qualityScore = health?.qualityScore ?? null;

  const prNumber = liveTask?.pr || task.pr;
  const branchLabel = liveTask?.branch || task.branch || "—";
  const agentLabel = liveTask?.assignee || task.assignee || "Agent";
  const updatedRelative = liveTask?.updated ? formatRelative(liveTask.updated) : "—";
  const reviewAttachments = normalizeTaskAttachments(liveTask || task);

  /* Derive simulated CI checks */
  const checks = useMemo(() => {
    const base = [
      { label: "Build", status: "pass" },
      { label: "Tests", status: prNumber ? "pass" : "pending" },
      { label: "Lint", status: "pass" },
      { label: "PR opened", status: prNumber ? "pass" : "pending" },
    ];
    if (reviewVerdict === "fail") base.push({ label: "Review", status: "fail" });
    else if (reviewVerdict) base.push({ label: "Review", status: "pass" });
    return base;
  }, [prNumber, reviewVerdict]);

  const handleMarkDone = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "done" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "done" } : t,
      );
      showToast("Task marked done", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const handleReopen = async () => {
    haptic("light");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "inprogress" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "inprogress" } : t,
      );
      showToast("Task reopened as active", "success");
      await reactivateTaskSession(task.id, {
        askFirst: false,
        title: task?.title || task?.id || "this task",
      }).catch(() => {});
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "cancelled" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "cancelled" } : t,
      );
      showToast("Task cancelled", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const allPass = checks.every((c) => c.status === "pass");

  return html`
    <${Modal}
      title=${liveTask?.title || task.title || "In Review"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-review-modal"
    >
      
      <div class="tr-hero">
        <span class="tr-review-icon">${resolveIcon(":search:")}</span>
        <div class="tr-hero-title">
          <div class="tr-hero-status-label">In Review</div>
          ${prNumber && html`
            <a
              class="tr-pr-badge"
              href="#"
              onClick=${(e) => { e.preventDefault(); haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}
            >
              ${iconText(`PR #${prNumber} · View diff :arrowRight:`)}
            </a>
          `}
          ${!prNumber && html`<span style="font-size:12px;color:var(--text-hint);">No PR yet</span>`}
        </div>
        <${Badge} status="inreview" text="review" />
      </div>

      
      <div class="tr-meta-grid">
        <div class="tr-meta-item">
          <span class="tr-meta-label">Agent</span>
          <span class="tr-meta-value">${agentLabel}</span>
        </div>
        <div class="tr-meta-item">
          <span class="tr-meta-label">Branch</span>
          <span class="tr-meta-value mono">${branchLabel}</span>
        </div>
        <div class="tr-meta-item">
          <span class="tr-meta-label">Last Updated</span>
          <span class="tr-meta-value">${updatedRelative}</span>
        </div>
        ${qualityScore != null && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Quality</span>
            <span class="tr-meta-value" style="color:${qualityScore >= 75 ? "var(--color-done)" : "var(--color-error)"};">
              ${qualityScore}%
            </span>
          </div>
        `}
        ${healthScore != null && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Agent Health</span>
            <span class="tr-meta-value">${healthScore}%</span>
          </div>
        `}
        ${liveTask?.priority && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Priority</span>
            <span class="tr-meta-value"><${Badge} status=${liveTask.priority} text=${liveTask.priority} /></span>
          </div>
        `}
      </div>

      
      <div class="tr-section">
        <div class="tr-section-title">
          Checks ${allPass ? iconText("— :check: All passing") : ""}
        </div>
        <div class="tr-checks-row">
          ${checks.map((c) => html`
            <div class="tr-check-item ${c.status}" key=${c.label}>
              ${resolveIcon(c.status === "pass" ? ":check:" : c.status === "fail" ? ":close:" : ":clock:")}
              ${c.label}
            </div>
          `)}
        </div>
      </div>

      
      ${(liveTask?.description || task.description) && html`
        <div class="tr-section" style="padding-top:0;">
          <div class="tr-section-title">Description</div>
          <${MarkdownTaskViewer}
            value=${liveTask?.description || task.description}
            className="task-review-markdown"
            maxHeight="220px"
          />
        </div>
      `}
      ${reviewAttachments.length > 0 && html`
        <div class="tr-section">
          <div class="tr-section-title">Attachments</div>
          <div class="task-attachments-list">
            ${reviewAttachments.map((att, index) => {
              const name = att.name || att.filename || "attachment";
              const url = att.url || att.filePath || att.path || "";
              const size = att.size ? formatBytes(att.size) : "";
              const isImage = isImageAttachment(att);
              return html`
                <div class="task-attachment-item" key=${att.id || `${name}-${index}`}>
                  ${isImage && url
                    ? html`<img class="task-attachment-thumb" src=${url} alt=${name} />`
                    : html`<span class="task-attachment-icon">${resolveIcon(":link:")}</span>`}
                  <div class="task-attachment-meta">
                    ${url
                      ? html`<a class="task-attachment-name" href=${url} target="_blank" rel="noopener">${name}</a>`
                      : html`<span class="task-attachment-name">${name}</span>`}
                    <div class="task-attachment-sub">
                      ${(att.kind || "file")}${size ? ` · ${size}` : ""}
                    </div>
                  </div>
                </div>
              `;
            })}
          </div>
        </div>
      `}

      
      <div class="btn-row tr-actions">
        <${Tooltip} title="Mark as merged / done"><${Button} variant="contained" size="small" onClick=${handleMarkDone} disabled=${merging}>${iconText("✓ Mark Done")}<//><//>
        <${Button} variant="outlined" size="small" onClick=${handleReopen}>${iconText(":workflow: Reopen as Active")}<//>
        <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}>${iconText(":file: Logs")}<//>
        ${prNumber && html`
          <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}>${iconText(":search: Diff")}<//>
        `}
        <${Button} variant="text" size="small" style=${{ color: "var(--color-error)" }} onClick=${handleCancel}>${iconText("✕ Cancel")}<//>
      </div>
    <//>
  `;
}

/* ─── TaskDetailModal ─── */
export function TaskDetailModal({ task, onClose, onStart, onOpenTask = null, presentation = "modal", taskCatalog = [], epicCatalog = [], isHydrating = false, hierarchyModel = null, hierarchyNodeState = null, onUpdateHierarchySubtasks = null }) {
  const hierarchySubtasks = useMemo(
    () => (hierarchyNodeState?.children || [])
      .map((entry) => normalizeSubtaskRow(entry?.task || { id: entry?.id, parentTaskId: task?.id }, task?.id))
      .filter(Boolean),
    [hierarchyNodeState, task?.id],
  );
  const [title, setTitle] = useState(sanitizeTaskText(task?.title || ""));
  const [description, setDescription] = useState(buildTaskDescriptionFallback(task?.title, task?.description));
  const [baseBranch, setBaseBranch] = useState(getTaskBaseBranch(task));
  const [status, setStatus] = useState(task?.status || "todo");
  const [priority, setPriority] = useState(task?.priority || "");
  const [tagsInput, setTagsInput] = useState(
    getTaskTags(task).join(", "),
  );
  const [attachments, setAttachments] = useState(
    normalizeTaskAttachments(task),
  );
  const [comments, setComments] = useState(
    normalizeTaskComments(task),
  );
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [dependenciesInput, setDependenciesInput] = useState(
    getTaskDependencyIds(task).join(", "),
  );
  const [savingDependencies, setSavingDependencies] = useState(false);
  const [dependencyFeedback, setDependencyFeedback] = useState("");
  const [sprintOptions, setSprintOptions] = useState([]);
  const [selectedSprintId, setSelectedSprintId] = useState(getTaskSprintId(task));
  const [sprintOrderInput, setSprintOrderInput] = useState(getTaskSprintOrder(task));
  const [savingSprint, setSavingSprint] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [draft, setDraft] = useState(
    Boolean(task?.draft || task?.status === "draft"),
  );
  const [saving, setSaving] = useState(false);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [rewriting, setRewriting] = useState(false);
  const [manualOverride, setManualOverride] = useState(isTaskManual(task));
  const [manualBusy, setManualBusy] = useState(false);
  const [manualReason, setManualReason] = useState(getManualReason(task));
  const [workspaceId, setWorkspaceId] = useState(
    task?.workspace || activeWorkspaceId.value || "",
  );
  const [repository, setRepository] = useState(task?.repository || "");
  const [assignee, setAssignee] = useState(
    toText(pickTaskField(task, ["assignee"])),
  );
  const [assigneesInput, setAssigneesInput] = useState(
    normalizeTaskAssigneesInput(task),
  );
  const [epicId, setEpicId] = useState(
    toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
  );
  const [goalId, setGoalId] = useState(
    toText(pickTaskField(task, ["goalId", "primaryGoalId"])),
  );
  const [parentGoalId, setParentGoalId] = useState(
    toText(pickTaskField(task, ["parentGoalId"])),
  );
  const [storyPoints, setStoryPoints] = useState(
    toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
  );
  const [budgetWindow, setBudgetWindow] = useState(
    toText(pickTaskField(task, ["budgetWindow"])),
  );
  const [budgetCents, setBudgetCents] = useState(
    toText(pickTaskField(task, ["budgetCents"])),
  );
  const [budgetCurrency, setBudgetCurrency] = useState(
    toText(pickTaskField(task, ["budgetCurrency"])) || "USD",
  );
  const [coordinationTeamId, setCoordinationTeamId] = useState(
    toText(pickTaskField(task, ["coordinationTeamId"])),
  );
  const [coordinationRole, setCoordinationRole] = useState(
    toText(pickTaskField(task, ["coordinationRole"])),
  );
  const [coordinationReportsTo, setCoordinationReportsTo] = useState(
    toText(pickTaskField(task, ["coordinationReportsTo"])),
  );
  const [coordinationLevel, setCoordinationLevel] = useState(
    toText(pickTaskField(task, ["coordinationLevel"])),
  );
  const [dueDate, setDueDate] = useState(normalizeTaskDueDateInput(task));
  const [parentTaskId, setParentTaskId] = useState(
    toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
  );
  const [subtasks, setSubtasks] = useState(() => mergeSubtaskLists(hierarchySubtasks));
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [creatingSubtask, setCreatingSubtask] = useState(false);
  const [replanProposal, setReplanProposal] = useState(
    task?.meta?.replanProposal && typeof task.meta.replanProposal === "object"
      ? task.meta.replanProposal
      : null,
  );
  const [replanning, setReplanning] = useState(false);
  const [applyingReplan, setApplyingReplan] = useState(false);
  const [planningActionMode, setPlanningActionMode] = useState("replan");
  const attachmentInputRef = useRef(null);
  const initialSnapshotRef = useRef({
    title: sanitizeTaskText(task?.title || ""),
    description: buildTaskDescriptionFallback(task?.title, task?.description),
    baseBranch: getTaskBaseBranch(task),
    status: task?.status || "todo",
    priority: task?.priority || "",
    tagsInput: getTaskTags(task).join(", "),
    draft: Boolean(task?.draft || task?.status === "draft"),
    assignee: toText(pickTaskField(task, ["assignee"])),
    assigneesInput: normalizeTaskAssigneesInput(task),
    epicId: toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
    goalId: toText(pickTaskField(task, ["goalId", "primaryGoalId"])),
    parentGoalId: toText(pickTaskField(task, ["parentGoalId"])),
    storyPoints: toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
    budgetWindow: toText(pickTaskField(task, ["budgetWindow"])),
    budgetCents: toText(pickTaskField(task, ["budgetCents"])),
    budgetCurrency: toText(pickTaskField(task, ["budgetCurrency"])) || "USD",
    coordinationTeamId: toText(pickTaskField(task, ["coordinationTeamId"])),
    coordinationRole: toText(pickTaskField(task, ["coordinationRole"])),
    coordinationReportsTo: toText(pickTaskField(task, ["coordinationReportsTo"])),
    coordinationLevel: toText(pickTaskField(task, ["coordinationLevel"])),
    dueDate: normalizeTaskDueDateInput(task),
    parentTaskId: toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
  });
  const pendingKey = useMemo(
    () => `modal:task-detail:${task?.id || "unknown"}`,
    [task?.id],
  );
  const activeWsId = activeWorkspaceId.value || "";
  const canDispatch = Boolean(onStart && task?.id);
  const [workspaceLauncherAnchor, setWorkspaceLauncherAnchor] = useState(null);
  const linkedSessionId = useMemo(() => pickTaskLinkedSessionId(task), [
    task?.id,
    task?.sessionId,
    task?.primarySessionId,
    task?.meta,
    task?.workflowRuns,
    task?.workflowHistory,
    task?.workflows,
    task?.runs,
  ]);
  const taskWorkspaceLaunchers = useMemo(() => buildTaskWorkspaceLaunchers(task), [
    task?.id,
    task?.worktreePath,
    task?.workspacePath,
    task?.meta,
    task?.runtimeSnapshot,
  ]);

  const historyEntries = useMemo(() => buildTaskHistoryEntries(task), [
    task?.id,
    task?.status,
    task?.statusHistory,
    task?.history,
    task?.timeline,
    task?.eventLog,
    task?.events,
    task?.activity,
  ]);
  const baseWorkflowRuns = useMemo(() => buildTaskWorkflowRuns(task), [
    task?.id,
    task?.workflowRuns,
    task?.workflowHistory,
    task?.workflows,
  ]);
  const taskAuditActivity = useMemo(() => {
    if (task?.auditActivity && typeof task.auditActivity === "object") return task.auditActivity;
    if (task?.meta?.auditActivity && typeof task.meta.auditActivity === "object") return task.meta.auditActivity;
    return null;
  }, [task?.auditActivity, task?.meta]);
  const taskAuditSummary = taskAuditActivity?.summary && typeof taskAuditActivity.summary === "object"
    ? taskAuditActivity.summary
    : {};
  const taskAuditEvents = Array.isArray(taskAuditActivity?.auditEvents) ? taskAuditActivity.auditEvents : [];
  const taskAuditArtifacts = Array.isArray(taskAuditActivity?.artifacts) ? taskAuditActivity.artifacts : [];
  const taskAuditToolCalls = Array.isArray(taskAuditActivity?.toolCalls) ? taskAuditActivity.toolCalls : [];
  const taskAuditOperatorActions = Array.isArray(taskAuditActivity?.operatorActions) ? taskAuditActivity.operatorActions : [];
  const taskAuditPromotedStrategies = Array.isArray(taskAuditActivity?.promotedStrategies) ? taskAuditActivity.promotedStrategies : [];
  const taskAuditPromotedStrategyEvents = Array.isArray(taskAuditActivity?.promotedStrategyEvents)
    ? taskAuditActivity.promotedStrategyEvents
    : [];
  const taskAuditTraceEvents = Array.isArray(taskAuditActivity?.taskTraceEvents) ? taskAuditActivity.taskTraceEvents : [];
  const taskAuditClaim = taskAuditActivity?.claim && typeof taskAuditActivity.claim === "object"
    ? taskAuditActivity.claim
    : null;
  const taskAuditClaimEvents = Array.isArray(taskAuditActivity?.claimEvents) ? taskAuditActivity.claimEvents : [];
  const taskAuditSessionIds = Array.isArray(taskAuditActivity?.sessionIds) ? taskAuditActivity.sessionIds : [];
  const taskAuditAgentIds = Array.isArray(taskAuditActivity?.agentIds) ? taskAuditActivity.agentIds : [];
  const taskAuditSessionActivity =
    taskAuditActivity?.sessionActivity && typeof taskAuditActivity.sessionActivity === "object"
      ? taskAuditActivity.sessionActivity
      : null;
  const taskAuditAgentActivity =
    taskAuditActivity?.agentActivity && typeof taskAuditActivity.agentActivity === "object"
      ? taskAuditActivity.agentActivity
      : null;
  const taskAuditWorkflowRuns = useMemo(() => {
    if (!Array.isArray(taskAuditActivity?.workflowRuns)) return [];
    return taskAuditActivity.workflowRuns
      .map((entry) => normalizeTaskWorkflowRunEntry(entry))
      .filter((entry) => entry && (entry.workflowId || entry.runId || entry.status || entry.result));
  }, [taskAuditActivity?.workflowRuns]);
  const workflowRuns = useMemo(() => {
    const merged = [...baseWorkflowRuns, ...taskAuditWorkflowRuns];
    const deduped = [];
    const seen = new Set();
    for (const run of merged) {
      const key = String(
        run?.runId
          || `${run?.workflowId || ""}:${run?.nodeId || ""}:${run?.timestamp || run?.startedAt || run?.status || ""}`,
      ).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(run);
    }
    deduped.sort((a, b) => {
      const ta = a?.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b?.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
    return deduped.slice(0, 30);
  }, [baseWorkflowRuns, taskAuditWorkflowRuns]);
  const taskTopology = useMemo(() => (
    task?.topology && typeof task.topology === "object" ? task.topology : {}
  ), [task?.topology]);
  const taskGraphPath = useMemo(() => uniqueTaskWorkflowIdentityList(taskTopology?.graphPath || []), [taskTopology]);
  const taskSessionAncestry = useMemo(() => [
    taskTopology?.sessionId ? `current ${truncate(taskTopology.sessionId, 36)}` : "",
    taskTopology?.parentSessionId && taskTopology.parentSessionId !== taskTopology.sessionId
      ? `parent ${truncate(taskTopology.parentSessionId, 36)}`
      : "",
    taskTopology?.rootSessionId
      && taskTopology.rootSessionId !== taskTopology.parentSessionId
      && taskTopology.rootSessionId !== taskTopology.sessionId
      ? `root ${truncate(taskTopology.rootSessionId, 36)}`
      : "",
  ].filter(Boolean), [taskTopology]);
  const hasTaskAuditContent = Boolean(
    taskAuditEvents.length
    || taskAuditArtifacts.length
    || taskAuditToolCalls.length
    || taskAuditOperatorActions.length
    || taskAuditPromotedStrategies.length
    || taskAuditPromotedStrategyEvents.length
    || taskAuditTraceEvents.length
    || taskAuditClaim
    || taskAuditClaimEvents.length
    || taskAuditWorkflowRuns.length
    || taskAuditSessionIds.length
    || taskAuditAgentIds.length
    || taskAuditSessionActivity
    || taskAuditAgentActivity,
  );
  const taskAuditEventCount = Number(taskAuditSummary.eventCount || taskAuditEvents.length || 0);
  const taskAuditClaimEventCount = Number(taskAuditSummary.claimEventCount || taskAuditClaimEvents.length || 0);
  const taskAuditRunCount = Number(taskAuditSummary.runCount || taskAuditWorkflowRuns.length || 0);
  const taskAuditToolCallCount = Number(taskAuditSummary.toolCallCount || taskAuditToolCalls.length || 0);
  const taskAuditArtifactCount = Number(taskAuditSummary.artifactCount || taskAuditArtifacts.length || 0);
  const taskAuditOperatorActionCount = Number(taskAuditSummary.operatorActionCount || taskAuditOperatorActions.length || 0);
  const taskAuditPromotedStrategyCount = Number(taskAuditSummary.promotedStrategyCount || taskAuditPromotedStrategies.length || 0);
  const taskAuditTraceCount = Number(taskAuditSummary.taskTraceCount || taskAuditTraceEvents.length || 0);
  const taskAuditSourceLabel = useMemo(() => resolveTaskAuditSourceLabel(taskAuditActivity), [
    taskAuditActivity,
  ]);
  const taskDurableSessionIds = useMemo(() => collectTaskDurableSessionIds(task, workflowRuns, taskAuditActivity), [
    task?.id,
    task?.sessionId,
    task?.primarySessionId,
    task?.meta,
    workflowRuns,
    taskAuditActivity,
  ]);
  const taskPrimaryDurableSessionId =
    taskAuditSessionActivity?.sessionId || linkedSessionId || taskDurableSessionIds[0] || "";
  const taskDelegationTopologyRows = useMemo(() => buildTaskDelegationTopologyRows(workflowRuns), [
    workflowRuns,
  ]);
  const maxTaskDelegationDepth = taskDelegationTopologyRows.reduce((maxDepth, entry) => {
    const depth = Number(entry?.topology?.delegationDepth);
    if (!Number.isFinite(depth)) return maxDepth;
    return Math.max(maxDepth, depth);
  }, 0);
  const plannerState = task?.meta?.plannerState?.latestReplan || null;
  const planningMode = String(replanProposal?.mode || plannerState?.mode || "replan").trim().toLowerCase() === "decompose"
    ? "decompose"
    : "replan";
  const planningLabel = planningMode === "decompose" ? "Decomposition" : "Replan";
  const planningVerb = planningMode === "decompose" ? "decompose" : "replan";
  const plannerQueuePlan = replanProposal?.queuePlan && typeof replanProposal.queuePlan === "object"
    ? replanProposal.queuePlan
    : (plannerState?.queuePlan && typeof plannerState.queuePlan === "object" ? plannerState.queuePlan : null);
  const plannerOwnedTaskIds = Array.isArray(replanProposal?.createdTaskIds)
    ? replanProposal.createdTaskIds.map((entry) => String(entry || "").trim()).filter(Boolean)
    : Array.isArray(plannerQueuePlan?.steps)
      ? plannerQueuePlan.steps.map((entry) => String(entry?.taskId || "").trim()).filter(Boolean)
      : [];
  const plannerOwnedSubtasks = plannerOwnedTaskIds.length > 0
    ? subtasks.filter((entry) => plannerOwnedTaskIds.includes(String(entry?.id || "").trim()))
    : [];
  const historyTableRef = useRef(null);
  const [historyScrollTop, setHistoryScrollTop] = useState(0);
  const [historyViewportHeight, setHistoryViewportHeight] = useState(320);
  const HISTORY_ROW_HEIGHT = 46;
  const HISTORY_SCROLL_BUFFER = 16;
  const historyFirstVisible = Math.floor(historyScrollTop / HISTORY_ROW_HEIGHT);
  const historyStartIdx = Math.max(0, historyFirstVisible - HISTORY_SCROLL_BUFFER);
  const historyVisibleCount = Math.ceil(historyViewportHeight / HISTORY_ROW_HEIGHT);
  const historyEndIdx = Math.min(
    historyEntries.length,
    historyFirstVisible + historyVisibleCount + HISTORY_SCROLL_BUFFER,
  );
  const historyTopSpacer = historyStartIdx * HISTORY_ROW_HEIGHT;
  const historyBottomSpacer = Math.max(0, (historyEntries.length - historyEndIdx) * HISTORY_ROW_HEIGHT);
  const visibleHistoryEntries = historyEntries.slice(historyStartIdx, historyEndIdx);
  // ── Execution Plan state ──────────────────────────────────────────────────
  const [executionPlan, setExecutionPlan] = useState(null);
  const [executionPlanLoading, setExecutionPlanLoading] = useState(false);
  const [expandedNodes, setExpandedNodes] = useState({});
  const [expandedStages, setExpandedStages] = useState({});
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [activeTab, setActiveTab] = useState("details");
  const hierarchyPath = useMemo(() => buildTaskHierarchyPath(task, hierarchyModel), [task, hierarchyModel]);
  const hierarchyParentLink = hierarchyPath.length > 1 ? hierarchyPath[hierarchyPath.length - 2] : null;
  const childStats = useMemo(() => {
    const rows = Array.isArray(subtasks) ? subtasks : [];
    let done = 0;
    let blocked = 0;
    let open = 0;
    for (const entry of rows) {
      const tone = getTaskListStatusTone(entry?.status);
      if (tone === "done") done += 1;
      else if (tone === "blocked") blocked += 1;
      else open += 1;
    }
    return {
      total: rows.length,
      done,
      blocked,
      open,
      progressLabel: rows.length > 0 ? `${done}/${rows.length} done` : "No child work yet",
    };
  }, [subtasks]);

  const fetchExecutionPlan = useCallback((mode = "resolve") => {
    if (!task?.id) return;
    if (mode === "resolve") { setExecutionPlan(null); setExecutionPlanLoading(true); }
    else { setDryRunLoading(true); }
    const wsParam = typeof window !== "undefined" && window.__bosunWorkspaceId ? `&workspace=${encodeURIComponent(window.__bosunWorkspaceId)}` : "";
    fetch(`/api/tasks/execution-plan?taskId=${encodeURIComponent(task.id)}${wsParam}&mode=${mode}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok) {
          if (mode === "resolve") setExecutionPlan(data);
          else { setExecutionPlan(data); setDryRunResults(data.dryRunResults || null); }
        }
      })
      .catch(() => {})
      .finally(() => { setExecutionPlanLoading(false); setDryRunLoading(false); });
  }, [task?.id]);

  useEffect(() => {
    if (activeTab !== "execution") return;
    fetchExecutionPlan("resolve");
  }, [activeTab, fetchExecutionPlan]);

  useEffect(() => {
    if (activeTab !== "history") return;
    const el = historyTableRef.current;
    if (!el) return;
    setHistoryViewportHeight(el.clientHeight || 320);
    const onScroll = (event) => {
      setHistoryScrollTop(event.target.scrollTop || 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setHistoryViewportHeight(entry.contentRect.height || 320);
        }
      });
      resizeObserver.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, [activeTab]);

  const handleOpenWorkflowRun = useCallback(async (run) => {
    try {
      await openTaskWorkflowRun(run);
    } catch {
      showToast("Unable to open workflow run", "error");
    }
  }, []);
  const handleOpenWorkflowAgentHistory = useCallback(async (run) => {
    try {
      await openTaskWorkflowAgentHistory(run);
    } catch {
      showToast("Unable to open linked agent session", "error");
    }
  }, []);
  const renderWorkflowActivityCard = useCallback((run, key) => {
    const metaLine = buildTaskWorkflowRunMetaLine(run);
    const statusLine = buildTaskWorkflowRunStatusLine(run);
    const plannerPreview = Array.isArray(run?.plannerTimeline) ? run.plannerTimeline.slice(-3).reverse() : [];
    const proofBadges = buildTaskWorkflowProofBadges(run);
    const lineageBadges = buildTaskWorkflowRunLineageBadges(run);
    const topologyLines = buildTaskWorkflowRunTopologyLines(run);
    const latestDecision = String(
      run?.proofSummary?.latestDecision?.summary
      || run?.issueAdvisor?.summary
      || "",
    ).trim();
    const latestArtifact = String(
      run?.proofSummary?.latestArtifact?.path
      || run?.proofSummary?.latestArtifact?.summary
      || run?.proofSummary?.latestEvidence?.summary
      || "",
    ).trim();
    return html`
      <div
        class="task-comment-item task-workflow-run-card"
        key=${key}
        data-clickable=${run.hasRunLink ? "true" : "false"}
        role=${run.hasRunLink ? "button" : undefined}
        tabIndex=${run.hasRunLink ? 0 : undefined}
        onClick=${run.hasRunLink ? () => { void handleOpenWorkflowRun(run); } : undefined}
        onKeyDown=${run.hasRunLink
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void handleOpenWorkflowRun(run);
              }
            }
          : undefined}
      >
        <div class="task-workflow-run-head">
          <div style="min-width:0;flex:1;">
            <div class="task-comment-meta">${metaLine || "workflow"}</div>
            <div class="task-comment-body">${statusLine}</div>
            ${run.nodeId ? html`<div class="task-comment-meta">Node: ${run.nodeId}</div>` : null}
            ${proofBadges.length > 0 ? html`
              <div class="task-comment-meta" style=${{ marginTop: "6px" }}>
                ${proofBadges.join(" · ")}
              </div>
            ` : null}
            ${lineageBadges.length > 0 ? html`
              <div class="task-comment-meta" style=${{ marginTop: proofBadges.length > 0 ? "4px" : "6px" }}>
                Lineage: ${lineageBadges.join(" · ")}
              </div>
            ` : null}
            ${topologyLines.length > 0 ? html`
              <div style=${{ marginTop: lineageBadges.length > 0 || proofBadges.length > 0 ? "4px" : "6px", display: "flex", flexDirection: "column", gap: "4px" }}>
                ${topologyLines.map((line, index) => html`
                  <div class="task-comment-meta" key=${`topology-${index}`}>${line}</div>
                `)}
              </div>
            ` : null}
            ${latestDecision ? html`
              <div class="task-comment-body" style=${{ marginTop: "6px" }}>
                Decision: ${latestDecision}
              </div>
            ` : null}
            ${latestArtifact ? html`
              <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                Proof: ${latestArtifact}
              </div>
            ` : null}
            ${plannerPreview.length > 0 ? html`
              <div style=${{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" }}>
                ${plannerPreview.map((entry, index) => html`
                  <div class="task-comment-meta" key=${`planner-preview-${index}`}>
                    ${summarizeTaskWorkflowPlannerEvent(entry)}
                  </div>
                `)}
              </div>
            ` : null}
          </div>
          <div class="task-workflow-run-actions" onClick=${(event) => event.stopPropagation()}>
            ${run.hasRunLink ? html`
              <${Button} variant="outlined" size="small" onClick=${() => { void handleOpenWorkflowRun(run); }}>
                Open Run
              <//>
            ` : null}
            ${run.hasSessionLink ? html`
              <${Button} variant="text" size="small" onClick=${() => { void handleOpenWorkflowAgentHistory(run); }}>
                Agent History
              <//>
            ` : null}
          </div>
        </div>
      </div>
    `;
  }, [handleOpenWorkflowRun, handleOpenWorkflowAgentHistory]);
  const handleOpenLinkedSession = useCallback(async () => {
    try {
      const opened = await openTaskLinkedSession(task);
      if (!opened) {
        showToast("No linked session recorded for this task", "warning");
      }
    } catch {
      showToast("Unable to open linked session", "error");
    }
  }, [task]);
  const handleOpenRelatedTask = useCallback((taskId) => {
    const nextTaskId = toText(taskId);
    if (!nextTaskId) return;
    if (typeof onOpenTask === "function") {
      onOpenTask(nextTaskId);
      return;
    }
    if (typeof window !== "undefined") {
      window.location.hash = buildTaskDetailPath(nextTaskId);
    }
  }, [onOpenTask]);

  const toggleNodeExpand = useCallback((stageIdx, nodeId) => {
    setExpandedNodes((prev) => ({ ...prev, [`${stageIdx}-${nodeId}`]: !prev[`${stageIdx}-${nodeId}`] }));
  }, []);
  const toggleStageExpand = useCallback((stageIdx) => {
    setExpandedStages((prev) => ({ ...prev, [stageIdx]: !prev[stageIdx] }));
  }, []);

  const relatedLinks = useMemo(() => buildTaskRelatedLinks(task), [
    task?.id,
    task?.branch,
    task?.branchName,
    task?.pr,
    task?.prNumber,
    task?.prUrl,
    task?.meta,
  ]);
  const primaryPrLink = useMemo(() => {
    const withUrl = relatedLinks.find((entry) => entry?.kind === "PR" && entry?.url);
    if (withUrl) return withUrl;
    return relatedLinks.find((entry) => entry?.kind === "PR URL" && entry?.url) || null;
  }, [relatedLinks]);
  const handleOpenWorkspaceLauncherMenu = useCallback((event) => {
    setWorkspaceLauncherAnchor(event.currentTarget);
  }, []);
  const handleCloseWorkspaceLauncherMenu = useCallback(() => {
    setWorkspaceLauncherAnchor(null);
  }, []);
  const handleCopyWorktreePath = useCallback(async () => {
    const worktreePath = getTaskWorktreePath(task);
    if (!worktreePath) {
      showToast("No worktree path recorded for this task", "warning");
      return;
    }
    try {
      await globalThis.navigator?.clipboard?.writeText?.(worktreePath);
      showToast("Worktree path copied", "success");
    } catch {
      showToast("Unable to copy worktree path", "error");
    } finally {
      handleCloseWorkspaceLauncherMenu();
    }
  }, [handleCloseWorkspaceLauncherMenu, task]);
  const handleOpenReviewDiff = useCallback(() => {
    setActiveTab("diff");
  }, []);
  const taskAgents = useMemo(() => buildTaskAgentList(task), [
    task?.id,
    task?.assignee,
    task?.assignees,
    task?.meta,
  ]);
  const taskDiagnostics = task?.diagnostics || task?.meta?.diagnostics || null;
  const stableCause = taskDiagnostics?.stableCause || null;
  const apiRecovery = taskDiagnostics?.supervisor?.apiErrorRecovery || null;
  const hasDiagnostics = Boolean(
    stableCause ||
    taskDiagnostics?.lastError ||
    taskDiagnostics?.errorPattern ||
    taskDiagnostics?.blockedReason ||
    taskDiagnostics?.cooldownUntil ||
    apiRecovery,
  );
  const canStartInfo = task?.canStart || task?.meta?.canStart || null;
  const blockedContext = task?.blockedContext || task?.meta?.blockedContext || null;
  const blockedBy = Array.isArray(blockedContext?.blockedBy)
    ? blockedContext.blockedBy
    : Array.isArray(canStartInfo?.blockedBy)
      ? canStartInfo.blockedBy
      : [];
  const blockedEvidence = [
    ...(Array.isArray(blockedContext?.timelineEvidence)
      ? blockedContext.timelineEvidence.map((entry) => ({ ...entry, kind: "timeline" }))
      : []),
    ...(Array.isArray(blockedContext?.logEvidence)
      ? blockedContext.logEvidence.map((entry) => ({ ...entry, kind: "log" }))
      : []),
  ].slice(0, 6);
  const lifetimeTotals = task?.lifetimeTotals
    || task?.meta?.lifetimeTotals
    || task?.runtimeSnapshot?.lifetimeTotals
    || null;
  const lifetimeAttempts = Number(lifetimeTotals?.attemptsCount || 0);
  const lifetimeTokenCount = Number(lifetimeTotals?.tokenCount || 0);
  const lifetimeDurationMs = Number(lifetimeTotals?.durationMs || 0);
  const formatLifetimeDuration = (durationMs) => {
    const value = Number(durationMs || 0);
    if (!Number.isFinite(value) || value <= 0) return "0s";
    const seconds = Math.floor(value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
  };

  const currentDependencyIds = useMemo(() => normalizeDependencyInput(dependenciesInput), [dependenciesInput]);
  const taskCatalogOptions = useMemo(() => (taskCatalog || []).filter((entry) => toText(entry?.id) && toText(entry?.id) !== toText(task?.id)), [taskCatalog, task?.id]);
  const dependencySuggestions = useMemo(() => taskCatalogOptions.filter((entry) => !currentDependencyIds.includes(toText(entry?.id))).slice(0, 10), [currentDependencyIds, taskCatalogOptions]);
  const currentEpicEntry = useMemo(() => (epicCatalog || []).find((entry) => entry.id === epicId) || null, [epicCatalog, epicId]);
  const currentParentTask = useMemo(() => {
    const nextParentId = toText(parentTaskId);
    if (!nextParentId) return null;
    return hierarchyModel?.taskById?.get?.(nextParentId)
      || taskCatalogOptions.find((entry) => toText(entry?.id) === nextParentId)
      || null;
  }, [hierarchyModel, parentTaskId, taskCatalogOptions]);

  const editableSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      baseBranch: baseBranch || "",
      status: status || "todo",
      priority: priority || "",
      tagsInput: tagsInput || "",
      draft: Boolean(draft),
      assignee: assignee || "",
      assigneesInput: assigneesInput || "",
      epicId: epicId || "",
      goalId: goalId || "",
      parentGoalId: parentGoalId || "",
      storyPoints: storyPoints || "",
      budgetWindow: budgetWindow || "",
      budgetCents: budgetCents || "",
      budgetCurrency: budgetCurrency || "",
      coordinationTeamId: coordinationTeamId || "",
      coordinationRole: coordinationRole || "",
      coordinationReportsTo: coordinationReportsTo || "",
      coordinationLevel: coordinationLevel || "",
      dueDate: dueDate || "",
      parentTaskId: parentTaskId || "",
    }),
    [
      assignee,
      assigneesInput,
      budgetCents,
      budgetCurrency,
      budgetWindow,
      baseBranch,
      coordinationLevel,
      coordinationReportsTo,
      coordinationRole,
      coordinationTeamId,
      description,
      draft,
      dueDate,
      epicId,
      goalId,
      parentGoalId,
      parentTaskId,
      priority,
      status,
      storyPoints,
      tagsInput,
      title,
    ],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, editableSnapshot),
    [baselineVersion, editableSnapshot],
  );
  const hasUnsaved = changeCount > 0;
  const activePlanningVerb = String(planningActionMode || planningMode || "replan").trim().toLowerCase() === "decompose"
    ? "decompose"
    : "replan";
  const activeOperationLabel = saving
    ? "Task save is in progress"
    : rewriting
      ? "Improve with AI is still running"
      : replanning
        ? `AI ${activePlanningVerb} is still running`
        : applyingReplan
          ? `Applying ${activePlanningVerb} graph changes`
          : uploadingAttachment
          ? "Attachment upload is still running"
          : manualBusy
            ? "Manual takeover update is in progress"
            : "";

  const workspaceOptions = managedWorkspaces.value || [];
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((ws) => ws.id === workspaceId) || null,
    [workspaceId, workspaceOptions],
  );
  const repositoryOptions = selectedWorkspace?.repos || [];

  useEffect(() => {
    const nextTitle = sanitizeTaskText(task?.title || "");
    const nextDescription = buildTaskDescriptionFallback(task?.title, task?.description);
    const nextBaseBranch = getTaskBaseBranch(task);
    const nextStatus = task?.status || "todo";
    const nextPriority = task?.priority || "";
    const nextTags = getTaskTags(task).join(", ");
    const nextDraft = Boolean(task?.draft || task?.status === "draft");
    setTitle(nextTitle);
    setDescription(nextDescription);
    setBaseBranch(nextBaseBranch);
    setStatus(nextStatus);
    setPriority(nextPriority);
    setTagsInput(nextTags);
    setAttachments(normalizeTaskAttachments(task));
    setComments(normalizeTaskComments(task));
    setCommentDraft("");
    setDependenciesInput(getTaskDependencyIds(task).join(", "));
    setDependencyFeedback("");
    setSelectedSprintId(getTaskSprintId(task));
    setSprintOrderInput(getTaskSprintOrder(task));
    setDraft(nextDraft);
    setManualOverride(isTaskManual(task));
    setManualReason(getManualReason(task));
    setWorkspaceId(task?.workspace || activeWorkspaceId.value || "");
    setRepository(task?.repository || "");
    setAssignee(toText(pickTaskField(task, ["assignee"])));
    setAssigneesInput(normalizeTaskAssigneesInput(task));
    setEpicId(toText(pickTaskField(task, ["epicId", "epic", "epic_id"])));
    setGoalId(toText(pickTaskField(task, ["goalId", "primaryGoalId"])));
    setParentGoalId(toText(pickTaskField(task, ["parentGoalId"])));
    setStoryPoints(toText(pickTaskField(task, ["storyPoints", "points", "story_points"])));
    setBudgetWindow(toText(pickTaskField(task, ["budgetWindow"])));
    setBudgetCents(toText(pickTaskField(task, ["budgetCents"])));
    setBudgetCurrency(toText(pickTaskField(task, ["budgetCurrency"])) || "USD");
    setCoordinationTeamId(toText(pickTaskField(task, ["coordinationTeamId"])));
    setCoordinationRole(toText(pickTaskField(task, ["coordinationRole"])));
    setCoordinationReportsTo(toText(pickTaskField(task, ["coordinationReportsTo"])));
    setCoordinationLevel(toText(pickTaskField(task, ["coordinationLevel"])));
    setDueDate(normalizeTaskDueDateInput(task));
    setParentTaskId(toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])));
    setSubtasks(mergeSubtaskLists(hierarchySubtasks));
    initialSnapshotRef.current = {
      title: nextTitle,
      description: nextDescription,
      baseBranch: nextBaseBranch,
      status: nextStatus,
      priority: nextPriority,
      tagsInput: nextTags,
      draft: nextDraft,
      assignee: toText(pickTaskField(task, ["assignee"])),
      assigneesInput: normalizeTaskAssigneesInput(task),
      epicId: toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
      goalId: toText(pickTaskField(task, ["goalId", "primaryGoalId"])),
      parentGoalId: toText(pickTaskField(task, ["parentGoalId"])),
      storyPoints: toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
      budgetWindow: toText(pickTaskField(task, ["budgetWindow"])),
      budgetCents: toText(pickTaskField(task, ["budgetCents"])),
      budgetCurrency: toText(pickTaskField(task, ["budgetCurrency"])) || "USD",
      coordinationTeamId: toText(pickTaskField(task, ["coordinationTeamId"])),
      coordinationRole: toText(pickTaskField(task, ["coordinationRole"])),
      coordinationReportsTo: toText(pickTaskField(task, ["coordinationReportsTo"])),
      coordinationLevel: toText(pickTaskField(task, ["coordinationLevel"])),
      dueDate: normalizeTaskDueDateInput(task),
      parentTaskId: toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
    };
    setBaselineVersion((v) => v + 1);
  }, [hierarchySubtasks, task?.id]);

  useEffect(() => {
    setSubtasks((prev) => mergeSubtaskLists(hierarchySubtasks, prev));
  }, [hierarchySubtasks]);

  useEffect(() => {
    setReplanProposal(
      task?.meta?.replanProposal && typeof task.meta.replanProposal === "object"
        ? task.meta.replanProposal
        : null,
    );
  }, [task?.id, task?.meta?.replanProposal]);
  useEffect(() => {
    setPlanningActionMode(String(task?.meta?.replanProposal?.mode || plannerState?.mode || "replan"));
  }, [task?.id, task?.meta?.replanProposal?.mode, plannerState?.mode]);

  useEffect(() => {
    if (!workspaceOptions.length) {
      loadWorkspaces().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (workspaceId || !activeWsId) return;
    setWorkspaceId(activeWsId);
  }, [activeWsId, workspaceId]);

  useEffect(() => {
    if (!repositoryOptions.length) {
      if (repository) setRepository("");
      return;
    }
    if (!repositoryOptions.some((repo) => repo?.slug === repository)) {
      const primary = repositoryOptions.find((repo) => repo?.primary);
      setRepository(primary?.slug || repositoryOptions[0]?.slug || "");
    }
  }, [workspaceId, repositoryOptions.length]);

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const handleDiscardChanges = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setBaseBranch(base.baseBranch || "");
    setStatus(base.status || "todo");
    setPriority(base.priority || "");
    setTagsInput(base.tagsInput || "");
    setDraft(Boolean(base.draft));
    setAssignee(base.assignee || "");
    setAssigneesInput(base.assigneesInput || "");
    setEpicId(base.epicId || "");
    setGoalId(base.goalId || "");
    setParentGoalId(base.parentGoalId || "");
    setStoryPoints(base.storyPoints || "");
    setBudgetWindow(base.budgetWindow || "");
    setBudgetCents(base.budgetCents || "");
    setBudgetCurrency(base.budgetCurrency || "USD");
    setCoordinationTeamId(base.coordinationTeamId || "");
    setCoordinationRole(base.coordinationRole || "");
    setCoordinationReportsTo(base.coordinationReportsTo || "");
    setCoordinationLevel(base.coordinationLevel || "");
    setDueDate(base.dueDate || "");
    setParentTaskId(base.parentTaskId || "");
    showToast("Changes discarded", "info");
  }, []);

  const handleSave = async ({ closeAfterSave = true } = {}) => {
    setSaving(true);
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    const cleanTitle = sanitizeTaskText(title).trim();
    const cleanDescription = buildTaskDescriptionFallback(title, description);
    const cleanTagsInput = sanitizeTaskText(tagsInput || "");
    const tags = normalizeTagInput(cleanTagsInput);
    const wantsDraft = draft || status === "draft";
    const nextStatus = wantsDraft ? "draft" : status;
    const assigneeValue = toText(assignee);
    const assigneesValue = normalizeDependencyInput(assigneesInput);
    const epicValue = toText(epicId);
    const goalValue = toText(goalId);
    const parentGoalValue = toText(parentGoalId);
    const storyPointsValue = toText(storyPoints);
    const budgetWindowValue = toText(budgetWindow);
    const budgetCentsValue = toText(budgetCents);
    const budgetCurrencyValue = toText(budgetCurrency) || "USD";
    const coordinationTeamIdValue = toText(coordinationTeamId);
    const coordinationRoleValue = toText(coordinationRole);
    const coordinationReportsToValue = toText(coordinationReportsTo);
    const coordinationLevelValue = toText(coordinationLevel);
    const dueDateValue = toText(dueDate);
    const parentTaskValue = toText(parentTaskId);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  title: cleanTitle,
                  description: cleanDescription,
                  baseBranch,
                  status: nextStatus,
                  priority: priority || null,
                  tags,
                  draft: wantsDraft,
                  workspace: workspaceId || null,
                  repository: repository || null,
                  assignee: assigneeValue || null,
                  assignees: assigneesValue,
                  epicId: epicValue || null,
                  goalId: goalValue || null,
                  primaryGoalId: goalValue || null,
                  parentGoalId: parentGoalValue || null,
                  storyPoints: storyPointsValue || null,
                  budgetWindow: budgetWindowValue || null,
                  budgetCents: budgetCentsValue || null,
                  budgetCurrency: budgetCurrencyValue || null,
                  coordinationTeamId: coordinationTeamIdValue || null,
                  coordinationRole: coordinationRoleValue || null,
                  coordinationReportsTo: coordinationReportsToValue || null,
                  coordinationLevel: coordinationLevelValue || null,
                  dueDate: dueDateValue || null,
                  parentTaskId: parentTaskValue || null,
                }
              : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/edit", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              title: cleanTitle,
              description: cleanDescription,
              baseBranch,
              status: nextStatus,
              priority,
              tags,
              draft: wantsDraft,
              workspace: workspaceId || undefined,
              repository: repository || undefined,
              assignee: assigneeValue || undefined,
              assignees: assigneesValue.length ? assigneesValue : undefined,
              epicId: epicValue || undefined,
              goalId: goalValue || undefined,
              parentGoalId: parentGoalValue || undefined,
              storyPoints: storyPointsValue || undefined,
              budgetWindow: budgetWindowValue || undefined,
              budgetCents: budgetCentsValue || undefined,
              budgetCurrency: budgetCurrencyValue || undefined,
              coordinationTeamId: coordinationTeamIdValue || undefined,
              coordinationRole: coordinationRoleValue || undefined,
              coordinationReportsTo: coordinationReportsToValue || undefined,
              coordinationLevel: coordinationLevelValue || undefined,
              dueDate: dueDateValue || undefined,
              parentTaskId: parentTaskValue || undefined,
            }),
          });
          if (res?.data)
            tasksData.value = tasksData.value.map((t) =>
              t.id === task.id ? { ...t, ...res.data } : t,
            );
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      showToast("Task saved", "success");
      setTitle(cleanTitle);
      setDescription(cleanDescription);
      initialSnapshotRef.current = {
        title: cleanTitle,
        description: cleanDescription,
        baseBranch,
        status: nextStatus,
        priority: priority || "",
        tagsInput: cleanTagsInput,
        draft: wantsDraft,
        assignee: assigneeValue,
        assigneesInput: assigneesValue.join(", "),
        epicId: epicValue,
        goalId: goalValue,
        parentGoalId: parentGoalValue,
        storyPoints: storyPointsValue,
        budgetWindow: budgetWindowValue,
        budgetCents: budgetCentsValue,
        budgetCurrency: budgetCurrencyValue,
        coordinationTeamId: coordinationTeamIdValue,
        coordinationRole: coordinationRoleValue,
        coordinationReportsTo: coordinationReportsToValue,
        coordinationLevel: coordinationLevelValue,
        dueDate: dueDateValue,
        parentTaskId: parentTaskValue,
      };
      setBaselineVersion((v) => v + 1);
      clearPendingChange(pendingKey);
      if (closeAfterSave) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      /* toast via apiFetch */
      return false;
    } finally {
      setSaving(false);
    }
  };
  const handleStatusUpdate = async (newStatus) => {
    haptic("medium");
    try {
      const result = await applyTaskLifecycleTransition(task, newStatus);
      if (!result?.ok || result?.cancelled) return;

      if (result.status === "done" || result.status === "cancelled") {
        onClose();
      } else {
        setStatus(result.status);
        setDraft(result.status === "draft");
      }

      if (result.status === "inreview") {
        await reactivateTaskSession(task.id, {
          askFirst: true,
          title: task?.title || task?.id || "this task",
        }).catch(() => {});
      }
    } catch {
      /* toast */
    }
  };
  const handleStart = () => {
    if (onStart) onStart(task);
  };

  const uploadAttachments = async (files) => {
    if (!task?.id || uploadingAttachment) return;
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    setUploadingAttachment(true);
    try {
      const form = new FormData();
      form.append("taskId", task.id);
      if (task?.backend) form.append("backend", task.backend);
      for (const file of list) {
        form.append("file", file, file.name || "attachment");
      }
      const res = await apiFetch("/api/tasks/attachments/upload", {
        method: "POST",
        body: form,
      });
      if (Array.isArray(res?.attachments)) {
        setAttachments(res.attachments);
      } else {
        showToast("Attachment upload failed", "error");
      }
    } catch {
      showToast("Attachment upload failed", "error");
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleAttachmentPick = (e) => {
    const files = e.target?.files;
    if (files && files.length) uploadAttachments(files);
    if (e.target) e.target.value = "";
  };

  const handleAttachmentPaste = (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      uploadAttachments(files);
    }
  };


  const loadSprintAssignments = useCallback(async () => {
    const sprintMeta = await fetchFirstAvailableDagPath(DAG_SPRINT_ENDPOINT_CANDIDATES);
    const options = normalizeSprintOptions(sprintMeta?.payload);
    setSprintOptions(options);
    if (!options.length) return;
    setSelectedSprintId((prev) => {
      if (prev && options.some((entry) => entry.id === prev)) return prev;
      const taskSprint = getTaskSprintId(task);
      if (taskSprint && options.some((entry) => entry.id === taskSprint)) return taskSprint;
      return options[0].id;
    });
  }, [task?.id]);
  const loadSubtasks = useCallback(async () => {
    if (!task?.id) return;
    setSubtasksLoading(true);
    try {
      const res = await apiFetch(`/api/tasks/subtasks?taskId=${encodeURIComponent(task.id)}`, {
        _silent: true,
      });
      const nextSubtasks = normalizeSubtasksPayload(res);
      setSubtasks(mergeSubtaskLists(hierarchySubtasks, nextSubtasks));
      onUpdateHierarchySubtasks?.(task.id, nextSubtasks);
    } catch {
      setSubtasks(mergeSubtaskLists(hierarchySubtasks));
    } finally {
      setSubtasksLoading(false);
    }
  }, [hierarchySubtasks, onUpdateHierarchySubtasks, task?.id]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await Promise.all([loadSprintAssignments(), loadSubtasks()]);
      } catch {
        if (!cancelled) {
          setSprintOptions([]);
          setSubtasks([]);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [loadSprintAssignments, loadSubtasks]);

  const handlePostComment = async () => {
    if (!task?.id || postingComment) return;
    const body = sanitizeTaskText(commentDraft || "").trim();
    if (!body) return;
    setPostingComment(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/comment", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          comment: body,
          body,
          text: body,
        }),
      });
      const payload = res?.data || res || {};
      const nextComments = normalizeTaskComments(
        payload?.task ||
          (Array.isArray(payload?.comments)
            ? { comments: payload.comments }
            : Array.isArray(payload?.data?.comments)
              ? { comments: payload.data.comments }
              : null),
      );
      if (nextComments.length) {
        setComments(nextComments);
      } else {
        setComments((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}`,
            author: "you",
            createdAt: new Date().toISOString(),
            body,
          },
        ]);
      }
      setCommentDraft("");
      scheduleRefresh(120);
      showToast("Comment posted", "success");
    } catch {
      /* toast via apiFetch */
    } finally {
      setPostingComment(false);
    }
  };

  const handleSaveDependencies = async () => {
    if (!task?.id || savingDependencies) return;
    const dependencies = normalizeDependencyInput(dependenciesInput);
    const payload = {
      taskId: task.id,
      dependencies,
    };
    if (selectedSprintId) payload.sprintId = selectedSprintId;
    if (sprintOrderInput !== "") {
      const sprintOrderNumber = Number(sprintOrderInput);
      if (Number.isFinite(sprintOrderNumber)) {
        payload.sprintOrder = sprintOrderNumber;
      }
    }

    setSavingDependencies(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/dependencies", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const nextDeps = normalizeDependencyInput(
        res?.data?.dependencies ||
          res?.dependencies ||
          res?.data?.task?.dependencyTaskIds ||
          dependencies,
      );
      setDependenciesInput(nextDeps.join(", "));
      setDependencyFeedback(nextDeps.length ? "Dependencies saved." : "Dependencies cleared.");
      showToast("Dependencies updated", "success");
      scheduleRefresh(120);
    } catch {
      setDependencyFeedback("Failed to update dependencies.");
    } finally {
      setSavingDependencies(false);
    }
  };

  const handleSaveSprintAssignment = async () => {
    if (!task?.id || savingSprint) return;
    const sprintId = toText(selectedSprintId);
    if (!sprintId) {
      showToast("Select a sprint first", "warning");
      return;
    }
    const sprintOrderNumber = sprintOrderInput === ""
      ? null
      : Number(sprintOrderInput);
    const payload = {
      taskId: task.id,
      sprintOrder: Number.isFinite(sprintOrderNumber) ? sprintOrderNumber : null,
    };

    setSavingSprint(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      await apiFetch(`/api/tasks/sprints/${encodeURIComponent(sprintId)}/tasks`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("Sprint assignment updated", "success");
      scheduleRefresh(120);
      setDependencyFeedback("Sprint assignment saved.");
    } catch {
      setDependencyFeedback("Failed to save sprint assignment.");
    } finally {
      setSavingSprint(false);
    }
  };

  const stageDependenciesInput = useCallback((nextDependencies) => {
    setDependenciesInput(normalizeDependencyInput(nextDependencies).join(", "));
  }, []);

  const handleDependencyChipRemove = useCallback((dependencyId) => {
    stageDependenciesInput(currentDependencyIds.filter((entry) => entry !== dependencyId));
  }, [currentDependencyIds, stageDependenciesInput]);

  const handleDependencyChipAdd = useCallback((dependencyId) => {
    stageDependenciesInput([...currentDependencyIds, dependencyId]);
  }, [currentDependencyIds, stageDependenciesInput]);

  const handleSprintOrderNudge = useCallback(async (delta) => {
    const sprintId = toText(selectedSprintId || getTaskSprintId(task));
    if (!sprintId) {
      showToast("Select a sprint first", "warning");
      return;
    }
    const baseOrder = Number(sprintOrderInput || getTaskSprintOrder(task) || 1);
    const nextOrder = Math.max(1, (Number.isFinite(baseOrder) ? baseOrder : 1) + delta);
    setSprintOrderInput(String(nextOrder));
    setSavingSprint(true);
    try {
      await apiFetch(`/api/tasks/sprints/${encodeURIComponent(sprintId)}/tasks`, {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, sprintOrder: nextOrder }),
      });
      setDependencyFeedback(`Sprint order updated to ${nextOrder}.`);
      showToast("Sprint order updated", "success");
      scheduleRefresh(120);
    } catch {
      setDependencyFeedback("Failed to update sprint order.");
    } finally {
      setSavingSprint(false);
    }
  }, [selectedSprintId, sprintOrderInput, task]);

  const handleCreateSubtask = async () => {
    if (!task?.id || creatingSubtask) return;
    const cleanTitle = sanitizeTaskText(subtaskTitle || "").trim();
    if (!cleanTitle) return;
    setCreatingSubtask(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/subtasks", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          parentTaskId: task.id,
          title: cleanTitle,
        }),
      });
      setSubtaskTitle("");
      showToast("Subtask created", "success");
      await loadSubtasks();
      scheduleRefresh(120);
    } catch {
      showToast("Failed to create subtask", "error");
    } finally {
      setCreatingSubtask(false);
    }
  };
  const handleInlineSubtaskUpdate = useCallback(async (subtask, patch, successMessage = "Child task updated") => {
    const subtaskId = toText(subtask?.id);
    if (!subtaskId) return false;
    const optimistic = normalizeSubtaskRow({ ...subtask, ...patch }, task?.id);
    setSubtasks((prev) => mergeSubtaskLists(prev, optimistic ? [optimistic] : []));
    try {
      const res = await apiFetch("/api/tasks/edit", {
        method: "POST",
        body: JSON.stringify({
          taskId: subtaskId,
          ...patch,
        }),
      });
      const saved = normalizeSubtaskRow(res?.data || res?.task || { ...subtask, ...patch }, task?.id);
      setSubtasks((prev) => mergeSubtaskLists(prev, saved ? [saved] : []));
      showToast(successMessage, "success");
      scheduleRefresh(120);
      return true;
    } catch {
      await loadSubtasks();
      return false;
    }
  }, [loadSubtasks, task?.id]);
  const handleGenerateReplan = async (mode = "replan") => {
    if (!task?.id || replanning) return;
    const normalizedMode = String(mode || "replan").trim().toLowerCase() === "decompose" ? "decompose" : "replan";
    setPlanningActionMode(normalizedMode);
    setReplanning(true);
    haptic("medium");
    try {
      const res = await apiFetch(
        normalizedMode === "decompose" ? "/api/tasks/decompose/propose" : "/api/tasks/replan/propose",
        {
        method: "POST",
          body: JSON.stringify({ taskId: task.id, planningMode: normalizedMode }),
        },
      );
      const nextProposal = res?.proposal || res?.data || res?.task?.meta?.replanProposal || null;
      if (nextProposal) {
        setReplanProposal(nextProposal);
        showToast(normalizedMode === "decompose" ? "Decomposition proposal generated" : "Replan proposal generated", "success");
        scheduleRefresh(120);
      } else {
        showToast(normalizedMode === "decompose" ? "Decomposition proposal was empty" : "Replan proposal was empty", "warning");
      }
    } catch {
      /* toast via apiFetch */
    } finally {
      setReplanning(false);
    }
  };
  const handleApplyReplan = async () => {
    if (!task?.id || applyingReplan || !replanProposal) return;
    const normalizedMode = String(replanProposal?.mode || "replan").trim().toLowerCase() === "decompose" ? "decompose" : "replan";
    setPlanningActionMode(normalizedMode);
    const subtaskCount = Array.isArray(replanProposal?.subtasks) ? replanProposal.subtasks.length : 0;
    const ok = await showConfirm(
      subtaskCount > 0
        ? `Apply this ${normalizedMode === "decompose" ? "decomposition" : "replan"} and create ${subtaskCount} subtasks?`
        : `Apply this ${normalizedMode === "decompose" ? "decomposition" : "replan"} to update task planning state?`,
    );
    if (!ok) return;
    setApplyingReplan(true);
    haptic("medium");
    try {
      const res = await apiFetch(normalizedMode === "decompose" ? "/api/tasks/decompose/apply" : "/api/tasks/replan/apply", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, planningMode: normalizedMode }),
      });
      const appliedProposal = res?.proposal || res?.data?.proposal || null;
      const createdSubtasks = Array.isArray(res?.createdSubtasks)
        ? res.createdSubtasks
        : Array.isArray(res?.data?.createdSubtasks)
          ? res.data.createdSubtasks
          : [];
      if (appliedProposal) setReplanProposal(appliedProposal);
      if (createdSubtasks.length > 0) {
        setSubtasks((prev) => normalizeSubtasksPayload({ subtasks: [...prev, ...createdSubtasks] }));
      }
      showToast(
        createdSubtasks.length > 0
          ? `${normalizedMode === "decompose" ? "Decomposition" : "Replan"} applied: ${createdSubtasks.length} subtasks created`
          : `${normalizedMode === "decompose" ? "Decomposition" : "Replan"} applied`,
        "success",
      );
      await loadSubtasks();
      scheduleRefresh(120);
    } catch {
      /* toast via apiFetch */
    } finally {
      setApplyingReplan(false);
    }
  };
  const handleRetry = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id }),
      });
      showToast("Task retried", "success");
      onClose();
      scheduleRefresh(150);
    } catch {
      /* toast */
    }
  };

  const handleUnblock = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/unblock", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "todo" }),
      });
      showToast("Task moved back to todo", "success");
      onClose();
      scheduleRefresh(150);
    } catch {
      /* toast */
    }
  };

  const handleManualToggle = async (next) => {
    if (!task?.id || manualBusy) return;
    if (next) {
      const ok = await showConfirm(
        "Mark this task for manual takeover? Automation will skip it.",
      );
      if (!ok) return;
    }
    haptic("medium");
    const prevTasks = cloneValue(tasksData.value);
    const prevManual = manualOverride;
    const reason = String(manualReason || "").trim();
    setManualBusy(true);
    try {
      await runOptimistic(
        () => {
          setManualOverride(next);
          updateTaskManualState(task.id, next, reason || "manual");
        },
        async () => {
          const res = await apiFetch(
            next ? "/api/tasks/ignore" : "/api/tasks/unignore",
            {
              method: "POST",
              body: JSON.stringify({
                taskId: task.id,
                ...(next && reason ? { reason } : {}),
              }),
            },
          );
          return res;
        },
        () => {
          tasksData.value = prevTasks;
          setManualOverride(prevManual);
        },
      );
      showToast(
        next
          ? "Task marked for manual takeover"
          : "Task returned to automation",
        "success",
      );
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
    setManualBusy(false);
  };

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    await handleStatusUpdate("cancelled");
  };

  return html`
    <${Modal}
      title=${task?.title || "Task Detail"}
      onClose=${onClose}
      contentClassName=${fullScreen
        ? "task-detail-fullscreen"
        : "modal-content-wide task-detail-modal-jira" + (presentation === "side-sheet" ? " task-detail-side-sheet" : "")}
      layout=${fullScreen ? "sheet" : (presentation === "side-sheet" ? "side-sheet" : "sheet")}
      resizable=${!fullScreen && presentation === "side-sheet"}
      widthStorageKey="tasks.task-detail.width"
      defaultWidth=${900}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSave({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        handleDiscardChanges();
        return true;
      }}
      activeOperationLabel=${activeOperationLabel}
    >
      ${/* ── Breadcrumb ── */ ""}
      <div class="task-detail-breadcrumb">
        <span>Tasks</span>
        <span>/</span>
        <span style="color:var(--color-text);font-weight:500;user-select:all;">${task?.id?.slice(0, 8) || "New"}</span>
        ${task?.priority && html`<span class="task-priority-dot" data-priority=${task.priority}></span>`}
        ${manualOverride && html`<span class="exec-plan-badge" style="background:#fbbf2420;color:#fbbf24;">MANUAL</span>`}
        <span class="task-hierarchy-type-pill">${getTaskListIssueTypeLabel(task)}</span>
      </div>

      ${/* ── Title + Actions ── */ ""}
      <div class="task-detail-title-area" style="display:flex;gap:12px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <input class="task-detail-title-input" value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="Task title" />
          ${isHydrating && html`
            <div class="meta-text" style=${{ marginTop: "6px", display: "flex", alignItems: "center", gap: "6px" }}>
              <${CircularProgress} size=${12} thickness=${5} />
              <span>Refreshing task details…</span>
            </div>
          `}
        </div>
        <div style="display:flex;gap:6px;align-items:center;padding-top:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
          <button class="task-status-btn" data-status=${status}>
            ${(status || "todo").toUpperCase()}
          </button>
          ${canDispatch && html`
            <${Button} variant="contained" size="small" onClick=${handleStart}>
              ${iconText(":play: Dispatch")}
            <//>
          `}
          ${taskWorkspaceLaunchers.length > 0 && html`
            <${Button}
              variant="outlined"
              size="small"
              component="a"
              href=${taskWorkspaceLaunchers[0].href}
              target="_blank"
              rel="noopener noreferrer"
              title=${getTaskWorktreePath(task)}
            >
              VS Code
            <//>
            <${IconButton}
              size="small"
              className="task-action-icon-btn"
              onClick=${handleOpenWorkspaceLauncherMenu}
              title="Open worktree in editor"
            >
              ${resolveIcon("chevronDown") || "▾"}
            <//>
          `}
          ${primaryPrLink?.url && html`
            <${Button}
              variant="outlined"
              size="small"
              component="a"
              href=${primaryPrLink.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              ${primaryPrLink.value || "PR"}
            <//>
          `}
          ${linkedSessionId && html`
            <${Button} variant="outlined" size="small" onClick=${handleOpenLinkedSession}>
              Session
            <//>
          `}
          <button class="task-action-icon-btn"
            onClick=${() => setFullScreen(!fullScreen)}
            title=${fullScreen ? "Exit fullscreen" : "Fullscreen"}>
            ${fullScreen ? resolveIcon("minimize") || "⊟" : resolveIcon("maximize") || "⊞"}
          </button>
        </div>
      </div>
      <div class="task-hierarchy-summary">
        <div class="task-hierarchy-summary-main">
          <div class="task-hierarchy-links">
            ${hierarchyParentLink && html`
              <button type="button" class="task-hierarchy-link-chip" onClick=${() => handleOpenRelatedTask(hierarchyParentLink.id)}>
                Parent · ${truncate(hierarchyParentLink.title || hierarchyParentLink.id, 48)}
              </button>
            `}
            ${currentEpicEntry && html`
              <span class="task-hierarchy-link-chip">
                Epic · ${truncate(currentEpicEntry.label || currentEpicEntry.id, 48)}
              </span>
            `}
            ${currentParentTask && !hierarchyParentLink && html`
              <button type="button" class="task-hierarchy-link-chip" onClick=${() => handleOpenRelatedTask(currentParentTask.id)}>
                Parent · ${truncate(currentParentTask.title || currentParentTask.id, 48)}
              </button>
            `}
          </div>
          <div class="task-hierarchy-trail" role="navigation" aria-label="Task hierarchy breadcrumbs">
            ${hierarchyPath.length > 0
              ? hierarchyPath.map((entry, index) => html`
                  <button
                    type="button"
                    key=${`${entry.id || entry.title}-${index}`}
                    class="task-hierarchy-crumb"
                    disabled=${index === hierarchyPath.length - 1}
                    onClick=${() => handleOpenRelatedTask(entry.id)}
                  >
                    ${truncate(entry.title || entry.id || "Task", 40)}
                  </button>
                `)
              : html`<span class="task-hierarchy-crumb is-current">${truncate(title || task?.id || "Task", 40)}</span>`}
          </div>
        </div>
        <div class="task-hierarchy-summary-stats">
          <div class="task-hierarchy-stat-card">
            <div class="task-hierarchy-stat-label">Child Progress</div>
            <div class="task-hierarchy-stat-value">${childStats.progressLabel}</div>
          </div>
          <div class="task-hierarchy-stat-card">
            <div class="task-hierarchy-stat-label">Open</div>
            <div class="task-hierarchy-stat-value">${childStats.open}</div>
          </div>
          <div class="task-hierarchy-stat-card">
            <div class="task-hierarchy-stat-label">Blocked</div>
            <div class="task-hierarchy-stat-value">${childStats.blocked}</div>
          </div>
          <div class="task-hierarchy-stat-card">
            <div class="task-hierarchy-stat-label">Done</div>
            <div class="task-hierarchy-stat-value">${childStats.done}</div>
          </div>
        </div>
      </div>
      ${taskWorkspaceLaunchers.length > 0 && html`
        <${MuiMenu}
          anchorEl=${workspaceLauncherAnchor}
          open=${Boolean(workspaceLauncherAnchor)}
          onClose=${handleCloseWorkspaceLauncherMenu}
        >
          ${taskWorkspaceLaunchers.map((launcher) => html`
            <${MenuItem}
              key=${launcher.id}
              component="a"
              href=${launcher.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick=${handleCloseWorkspaceLauncherMenu}
            >
              ${launcher.label}
            <//>
          `)}
          <${MenuItem} onClick=${handleCopyWorktreePath}>Copy Worktree Path<//>
        <//>
      `}

      ${/* ── Tab Bar (Jira style) ── */ ""}
      <div class="task-tab-bar">
        <button class="task-tab-btn" data-active=${activeTab === "details"} onClick=${() => setActiveTab("details")}>
          ${resolveIcon("edit") || "✎"} Details
        </button>
        <button class="task-tab-btn" data-active=${activeTab === "execution"} onClick=${() => setActiveTab("execution")}>
          ${resolveIcon("play")} Execution Plan
          ${executionPlan?.stageCount > 0 && html`<span class="task-tab-count">${executionPlan.stageCount}</span>`}
        </button>
        <button class="task-tab-btn" data-active=${activeTab === "history"} onClick=${() => setActiveTab("history")}>
          ${resolveIcon("clock") || "⏱"} History
          ${historyEntries.length > 0 && html`<span class="task-tab-count">${historyEntries.length}</span>`}
        </button>
        <button class="task-tab-btn" data-active=${activeTab === "diff"} onClick=${() => setActiveTab("diff")}>
          ${resolveIcon("edit") || "✎"} Diff
        </button>
      </div>

      ${/* ── Content Body ───────────────────────────────────────────── */ ""}
      <div style="padding:${fullScreen ? '20px 24px' : '0'};">

      ${/* ── DETAILS TAB — Two-column Jira layout ─────────────────── */ ""}
      ${activeTab === "details" && html`<div class="task-detail-columns">

      ${/* ── LEFT: Main Content ── */ ""}
      <div class="task-detail-main">

        <div class="task-section">
          <div class="task-section-title">Overview</div>
          <div class="task-section-body">
            <div class="task-overview-grid">
              <div class="task-overview-card">
                <div class="task-comment-meta">Hierarchy</div>
                <div class="task-comment-body">
                  ${hierarchyParentLink
                    ? truncate(hierarchyParentLink.title || hierarchyParentLink.id, 52)
                    : currentParentTask
                      ? truncate(currentParentTask.title || currentParentTask.id, 52)
                      : "Top-level task"}
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${currentEpicEntry ? `Epic ${currentEpicEntry.label || currentEpicEntry.id}` : "No epic linked"}
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Child Work</div>
                <div class="task-comment-body">${childStats.progressLabel}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${childStats.open} open · ${childStats.blocked} blocked · ${childStats.done} done
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Dependencies</div>
                <div class="task-comment-body">${currentDependencyIds.length ? `${currentDependencyIds.length} linked` : "No dependencies"}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${blockedBy.length ? `${blockedBy.length} currently blocking` : "No active blockers recorded"}
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Execution Context</div>
                <div class="task-comment-body">${taskAgents.length ? taskAgents.join(" · ") : "No agent assignment recorded."}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${workflowRuns.length} workflow runs · ${lifetimeAttempts.toLocaleString("en-US")} attempts
                </div>
              </div>
            </div>
            ${relatedLinks.length > 0 && html`
              <div style=${{ marginTop: "12px" }}>
                <div class="task-comment-meta" style=${{ marginBottom: "6px" }}>Development Links</div>
                <div class="task-comment-body">${renderTaskRelatedLinks(relatedLinks, { onReviewDiff: handleOpenReviewDiff })}</div>
              </div>
            `}
          </div>
        </div>

        ${(task?.status === "blocked" || canStartInfo?.canStart === false) && html`
          <div class="task-section">
            <div class="task-section-title">
              ${task?.status === "blocked" ? "Why Bosun Is Holding This Task" : "Why This Task Cannot Start Yet"}
              ${blockedContext?.workflowRunCount > 0 && html`<span class="task-tab-count">${blockedContext.workflowRunCount}</span>`}
            </div>
            <div class="task-section-body">
              <div class="task-blocked-banner" data-category=${blockedContext?.category || "guard"}>
                <div class="task-blocked-banner-title">
                  ${blockedContext?.headline || "This task cannot start yet."}
                </div>
                <div class="task-blocked-banner-copy">
                  ${blockedContext?.summary || blockedContext?.reason || "Bosun paused this task because a dependency, workflow guard, or recovery issue is still unresolved."}
                </div>
                ${blockedContext?.recommendation && html`
                  <div class="task-blocked-banner-copy">${blockedContext.recommendation}</div>
                `}
                ${blockedContext?.reason && blockedContext.reason !== blockedContext.summary && html`
                  <div class="task-blocked-banner-copy">Recorded reason: ${blockedContext.reason}</div>
                `}
              </div>

              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:12px;">
                ${blockedContext?.workflowRunCount > 0 && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Workflow runs</div>
                    <div class="task-comment-body">${blockedContext.workflowRunCount.toLocaleString("en-US")}</div>
                  </div>
                `}
                ${blockedContext?.prePrValidationFailureCount > 0 && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Validation loops</div>
                    <div class="task-comment-body">${blockedContext.prePrValidationFailureCount.toLocaleString("en-US")} pre-PR validation failures</div>
                  </div>
                `}
                ${blockedContext?.worktreeFailureCount > 0 && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Worktree failures</div>
                    <div class="task-comment-body">${blockedContext.worktreeFailureCount.toLocaleString("en-US")} acquisition failures</div>
                  </div>
                `}
                ${blockedBy.length > 0 && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Blocking tasks</div>
                    <div class="task-comment-body">${blockedBy.length.toLocaleString("en-US")} unresolved dependencies</div>
                  </div>
                `}
              </div>

              ${blockedBy.length > 0 && html`
                <div class="task-comments-list" style=${{ marginTop: "12px" }}>
                  ${blockedBy.map((entry, index) => html`
                    <div class="task-comment-item" key=${`blocked-by-${index}`}>
                      <div class="task-comment-meta">${entry.taskId || "dependency"}</div>
                      <div class="task-comment-body">${entry.reason || "Not ready yet"}</div>
                    </div>
                  `)}
                </div>
              `}

              ${blockedEvidence.length > 0 && html`
                <div class="task-comments-list" style=${{ marginTop: "12px" }}>
                  ${blockedEvidence.map((entry, index) => html`
                    <div class="task-comment-item" key=${`blocked-evidence-${index}`}>
                      <div class="task-comment-meta">
                        ${entry.kind === "log" ? entry.source || "monitor log" : entry.source || "timeline"}
                        ${entry.timestamp ? ` · ${formatRelative(entry.timestamp)}` : ""}
                      </div>
                      <div class="task-comment-body">${entry.message}</div>
                    </div>
                  `)}
                </div>
              `}
            </div>
          </div>
        `}

        ${hasDiagnostics && html`
          <div class="task-section">
            <div class="task-section-title">Diagnostics</div>
            <div class="task-section-body">
              ${stableCause && html`
                <div class="task-blocked-banner" data-category=${stableCause.severity || "diagnostic"}>
                  <div class="task-blocked-banner-title">${stableCause.title || "Task diagnostics available"}</div>
                  <div class="task-blocked-banner-copy">${stableCause.summary || "Bosun recorded a stable failure cause for this task."}</div>
                  ${stableCause.code && html`
                    <div class="task-blocked-banner-copy">Stable cause: ${stableCause.code}</div>
                  `}
                </div>
              `}

              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:12px;">
                ${taskDiagnostics?.errorPattern && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Error pattern</div>
                    <div class="task-comment-body">${taskDiagnostics.errorPattern}</div>
                  </div>
                `}
                ${taskDiagnostics?.cooldownUntil && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Cooldown until</div>
                    <div class="task-comment-body">${formatRelative(taskDiagnostics.cooldownUntil)}</div>
                  </div>
                `}
                ${apiRecovery && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Continue attempts</div>
                    <div class="task-comment-body">${Number(apiRecovery.continueAttempts || 0).toLocaleString("en-US")}</div>
                  </div>
                `}
                ${taskDiagnostics?.blockedReason && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Blocked reason</div>
                    <div class="task-comment-body">${taskDiagnostics.blockedReason}</div>
                  </div>
                `}
              </div>

              ${taskDiagnostics?.lastError && html`
                <div class="task-comments-list" style=${{ marginTop: "12px" }}>
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Last backend error</div>
                    <div class="task-comment-body">${taskDiagnostics.lastError}</div>
                  </div>
                </div>
              `}
            </div>
          </div>
        `}
        ${/* Description */ ""}
        <div class="task-section">
          <div class="task-section-title">Description</div>
          <div class="task-section-body">
            <${MarkdownTaskEditor}
              value=${description}
              onChange=${setDescription}
              placeholder="Add scope, acceptance criteria, dependencies, and key files..."
              minHeight=${340}
              disabled=${saving}
            />
            <div class="task-markdown-toolbar">
              <div class="task-markdown-help">Rich Markdown supported. Use the mode switch for preview or WYSIWYG editing.</div>
              <div class="task-markdown-toolbar-actions">
                <${VoiceMicButton}
                  onTranscript=${(t) => setDescription((prev) => (prev ? `${prev}\n\n${t}` : t))}
                  disabled=${saving || rewriting}
                  size="sm"
                />
              <${Tooltip} title="Use AI to expand and improve this task description">
                <${Button}
                  variant="text" size="small"
                  style=${{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "5px 10px", opacity: !title.trim() ? 0.45 : 1 }}
                  disabled=${!title.trim() || rewriting || saving}
                  onClick=${async () => {
                    if (!title.trim() || rewriting) return;
                    setRewriting(true);
                    haptic("medium");
                    try {
                      const res = await apiFetch("/api/tasks/rewrite", {
                        method: "POST",
                        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
                      });
                      if (res?.data) {
                        if (res.data.title) setTitle(res.data.title);
                        if (res.data.description) setDescription(res.data.description);
                        showToast("Task description improved", "success");
                        haptic("medium");
                      }
                    } catch { /* toast via apiFetch */ }
                    setRewriting(false);
                  }}
                >
                  ${rewriting
                    ? html`<span style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon(":clock:")}</span> Improving…`
                    : html`${iconText(":star: Improve with AI")}`
                  }
                <//>
              <//>
              </div>
            </div>
          </div>
        </div>

        ${/* Development / Execution */ ""}
        <div class="task-section" onPaste=${handleAttachmentPaste}>
          <div class="task-section-title">
            Development / Execution
            <span class="task-tab-count">${attachments.length}</span>
            <span style="margin-left:auto;">
              <${Button}
                variant="text" size="small"
                type="button"
                onClick=${() => attachmentInputRef.current && attachmentInputRef.current.click()}
                disabled=${uploadingAttachment}
              >
                Upload
              <//>
            </span>
          </div>
          <div class="task-section-body">
            <div class="task-overview-grid" style=${{ marginBottom: "12px" }}>
              <div class="task-overview-card">
                <div class="task-comment-meta">Branch / PR</div>
                <div class="task-comment-body">${renderTaskRelatedLinks(relatedLinks, { onReviewDiff: handleOpenReviewDiff })}</div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Execution Lineage</div>
                <div class="task-comment-body">${workflowRuns.length
                  ? `${workflowRuns.filter((run) => Array.isArray(run?.runGraph?.runs) && run.runGraph.runs.length > 0).length} run graphs · ${workflowRuns.reduce((total, run) => total + Number(run?.runGraph?.executions?.length || 0), 0)} execution steps`
                  : "No execution lineage linked yet."}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${workflowRuns.length
                    ? `${workflowRuns.reduce((total, run) => total + Number(run?.runGraph?.timeline?.length || 0), 0)} lineage events`
                    : ""}
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Delegation Topology</div>
                <div class="task-comment-body">${taskGraphPath.length > 1
                  ? `Task graph: ${taskGraphPath.join(" → ")}`
                  : (taskTopology?.latestRunId || taskTopology?.latestSessionId || taskTopology?.rootTaskId || taskTopology?.parentTaskId
                      ? `${taskTopology.workflowName || taskTopology.workflowId || "workflow"} · ${taskTopology.rootTaskId || task?.id || "task"}`
                      : "No delegated topology linked yet.")}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${[
                    Number.isFinite(Number(taskTopology?.delegationDepth)) ? `Delegation depth ${Number(taskTopology.delegationDepth || 0)}` : "",
                    taskTopology?.latestRunId ? `run ${taskTopology.latestRunId}` : "",
                    taskTopology?.latestSessionId ? `session ${truncate(taskTopology.latestSessionId, 36)}` : "",
                    taskDelegationTopologyRows.length ? `${taskDelegationTopologyRows.length} delegated run families` : "",
                  ].filter(Boolean).join(" · ")}
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${taskSessionAncestry.length > 0 ? `Session ancestry: ${taskSessionAncestry.join(" · ")}` : ""}
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Planning / Proof</div>
                <div class="task-comment-body">${workflowRuns.length
                  ? `${workflowRuns.reduce((total, run) => total + Number(run?.proofSummary?.plannerEventCount || run?.plannerTimeline?.length || 0), 0)} planner events · ${workflowRuns.reduce((total, run) => total + Number(run?.proofSummary?.evidenceCount || 0), 0)} evidence items`
                  : "No planner or proof events linked yet."}</div>
              </div>
            </div>
            <input
              ref=${attachmentInputRef}
              type="file"
              multiple
              style="display:none"
              onChange=${handleAttachmentPick}
            />
            ${attachments.length === 0 && !uploadingAttachment && html`
              <div class="meta-text">No attachments uploaded.</div>
            `}
            ${uploadingAttachment && html`
              <div class="meta-text">Uploading attachments...</div>
            `}
            ${attachments.length > 0 && html`
              <div class="task-attachments-list">
                ${attachments.map((att, index) => {
                  const name = att.name || att.filename || "attachment";
                  const url = att.url || att.filePath || att.path || "";
                  const size = att.size ? formatBytes(att.size) : "";
                  const isImage = isImageAttachment(att);
                  return html`
                    <div class="task-attachment-item" key=${att.id || `${name}-${index}`}>
                      ${isImage && url
                        ? html`<img class="task-attachment-thumb" src=${url} alt=${name} />`
                        : html`<span class="task-attachment-icon">${resolveIcon(":link:")}</span>`}
                      <div class="task-attachment-meta">
                        ${url
                          ? html`<a class="task-attachment-name" href=${url} target="_blank" rel="noopener">${name}</a>`
                          : html`<span class="task-attachment-name">${name}</span>`}
                        <div class="task-attachment-sub">
                          ${(att.kind || "file")}${size ? ` · ${size}` : ""}
                        </div>
                      </div>
                    </div>
                  `;
                })}
              </div>
            `}
          </div>
        </div>

        ${/* AI Replan */ ""}
        <div class="task-section">
          <div class="task-section-title">
            Planning Adjustments
            ${replanProposal?.status && html`<span class="task-tab-count">${replanProposal.status}</span>`}
            <span style="margin-left:auto;display:flex;gap:6px;">
              <${Button}
                variant="text"
                size="small"
                onClick=${() => { void handleGenerateReplan("replan"); }}
                disabled=${replanning || applyingReplan}
              >
                ${replanning ? "Planning…" : "Generate"}
              <//>
              <${Button}
                variant="text"
                size="small"
                onClick=${() => { void handleGenerateReplan("decompose"); }}
                disabled=${replanning || applyingReplan}
              >
                Decompose
              <//>
              <${Button}
                variant="contained"
                size="small"
                onClick=${handleApplyReplan}
                disabled=${applyingReplan || replanning || !replanProposal}
              >
                ${applyingReplan ? "Applying…" : "Apply"}
              <//>
            </span>
          </div>
          <div class="task-section-body">
            ${!replanProposal && html`
              <div class="meta-text">
                Generate a graph-aware replan to adjust the current task graph, or use Decompose to turn this task into a planner-owned child graph with explicit subtasks and dependencies.
              </div>
            `}
            ${replanProposal && html`
              <div class="task-comments-list" style=${{ marginBottom: "10px" }}>
                <div class="task-comment-item">
                  <div class="task-comment-meta">
                    ${planningLabel}
                    ${replanProposal.recommendedAction || "replan" ? ` · ${replanProposal.recommendedAction || "replan"}` : ""}
                    ${plannerState?.generatedAt ? ` · ${formatRelative(plannerState.generatedAt)}` : ""}
                    ${Array.isArray(replanProposal.createdTaskIds) && replanProposal.createdTaskIds.length > 0
                      ? ` · ${replanProposal.createdTaskIds.length} created`
                      : ""}
                  </div>
                  <div class="task-comment-body">${replanProposal.summary || "Replan proposal available."}</div>
                  ${replanProposal.planReasoning && html`
                    <div class="task-comment-meta" style=${{ marginTop: "6px", whiteSpace: "pre-wrap" }}>
                      ${replanProposal.planReasoning}
                    </div>
                  `}
                  ${(replanProposal.currentPlanStep || replanProposal.stopReason) && html`
                    <div class="task-comment-meta" style=${{ marginTop: "6px" }}>
                      ${replanProposal.currentPlanStep ? `Next: ${replanProposal.currentPlanStep}` : ""}
                      ${replanProposal.currentPlanStep && replanProposal.stopReason ? " · " : ""}
                      ${replanProposal.stopReason ? `Stop: ${replanProposal.stopReason}` : ""}
                    </div>
                  `}
                  ${replanProposal.parentTaskPatch && Object.keys(replanProposal.parentTaskPatch).length > 0 && html`
                    <div class="task-comment-meta" style=${{ marginTop: "8px" }}>
                      Parent patch:
                      ${replanProposal.parentTaskPatch.status ? ` status=${replanProposal.parentTaskPatch.status}` : ""}
                      ${replanProposal.parentTaskPatch.blockedReason ? ` · ${replanProposal.parentTaskPatch.blockedReason}` : ""}
                    </div>
                  `}
                </div>
                ${(planningMode === "decompose" || plannerOwnedSubtasks.length > 0) && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Planner Child Graph</div>
                    <div class="task-comment-body">
                      ${plannerOwnedSubtasks.length > 0
                        ? `${plannerOwnedSubtasks.length} planner-owned child tasks are now attached to this parent task.`
                      : "This proposal will create a planner-owned child graph under the current task when applied."}
                    </div>
                  </div>
                `}
                ${plannerQueuePlan && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">
                      Queue Plan
                      ${plannerQueuePlan.queueStrategy ? ` · ${plannerQueuePlan.queueStrategy}` : ""}
                      ${plannerQueuePlan.counts?.stepCount ? ` · ${plannerQueuePlan.counts.stepCount} steps` : ""}
                      ${plannerQueuePlan.counts?.createdTaskCount ? ` · ${plannerQueuePlan.counts.createdTaskCount} mapped` : ""}
                    </div>
                    <div class="task-comment-body">
                      ${plannerQueuePlan.summary || "Planner queue graph available."}
                    </div>
                    ${Array.isArray(plannerQueuePlan.steps) && plannerQueuePlan.steps.map((entry) => html`
                      <div class="task-comment-meta" key=${`queue-step-${entry.id || entry.order || entry.title}`}>
                        ${entry.order}. ${entry.title}
                        ${entry.status ? ` · ${entry.status}` : ""}
                        ${entry.dependsOnStepIds?.length > 0 ? ` · depends on ${entry.dependsOnStepIds.join(", ")}` : ""}
                        ${entry.dependsOnTaskIds?.length > 0 ? ` · external deps ${entry.dependsOnTaskIds.join(", ")}` : ""}
                        ${entry.taskId ? ` · task ${entry.taskId}` : ""}
                      </div>
                    `)}
                  </div>
                `}
                ${Array.isArray(replanProposal.subtasks) && replanProposal.subtasks.map((entry, index) => html`
                  <div class="task-comment-item" key=${`replan-subtask-${index}`}>
                    <div class="task-comment-meta">
                      ${index + 1}. ${entry.priority || "medium"}
                      ${entry.storyPoints ? ` · ${entry.storyPoints} pts` : ""}
                      ${Array.isArray(entry.dependsOnIndexes) && entry.dependsOnIndexes.length > 0
                        ? ` · depends on ${entry.dependsOnIndexes.map((dep) => dep + 1).join(", ")}`
                        : ""}
                      ${Array.isArray(entry.dependsOnTaskIds) && entry.dependsOnTaskIds.length > 0
                        ? ` · external deps ${entry.dependsOnTaskIds.join(", ")}`
                        : ""}
                    </div>
                    <div class="task-comment-body">${entry.title}</div>
                    <div class="task-comment-meta" style=${{ whiteSpace: "pre-wrap", marginTop: "4px" }}>
                      ${entry.description}
                    </div>
                    ${Array.isArray(entry.acceptanceCriteria) && entry.acceptanceCriteria.length > 0 && html`
                      <div class="task-comment-meta" style=${{ marginTop: "6px" }}>
                        Acceptance: ${entry.acceptanceCriteria.join(" | ")}
                      </div>
                    `}
                  </div>
                `)}
                ${plannerOwnedSubtasks.length > 0 && plannerOwnedSubtasks.map((entry) => {
                  const dependencyIds = [
                    ...(Array.isArray(entry?.dependencyTaskIds) ? entry.dependencyTaskIds : []),
                    ...(Array.isArray(entry?.dependsOn) ? entry.dependsOn : []),
                  ].map((value) => String(value || "").trim()).filter(Boolean);
                  return html`
                    <div class="task-comment-item" key=${`planner-owned-${entry.id || entry.title || Math.random()}`}>
                      <div class="task-comment-meta">
                        planner-owned
                        ${entry.status ? ` · ${entry.status}` : ""}
                        ${dependencyIds.length > 0 ? ` · deps ${dependencyIds.join(", ")}` : ""}
                      </div>
                      <div class="task-comment-body">${entry.title || entry.id || "Child task"}</div>
                      ${entry.description && html`
                        <div class="task-comment-meta" style=${{ whiteSpace: "pre-wrap", marginTop: "4px" }}>
                          ${entry.description}
                        </div>
                      `}
                    </div>
                  `;
                })}
                ${Array.isArray(replanProposal.notes) && replanProposal.notes.length > 0 && html`
                  <div class="task-comment-item">
                    <div class="task-comment-meta">Operator notes</div>
                    <div class="task-comment-body">${replanProposal.notes.join("\n")}</div>
                  </div>
                `}
              </div>
            `}
          </div>
        </div>

        ${/* Child Work */ ""}
        <div class="task-section">
          <div class="task-section-title">
            Child Work
            ${subtasks.length > 0 && html`<span class="task-tab-count">${subtasks.length}</span>`}
            <span class="task-tab-count">${childStats.open} open</span>
            ${childStats.blocked > 0 && html`<span class="task-tab-count">${childStats.blocked} blocked</span>`}
            ${childStats.done > 0 && html`<span class="task-tab-count">${childStats.done} done</span>`}
            <span style="margin-left:auto;">
              <${Button}
                variant="text"
                size="small"
                onClick=${loadSubtasks}
                disabled=${subtasksLoading || creatingSubtask}
              >
                ${subtasksLoading ? "Refreshing…" : "Refresh"}
              <//>
            </span>
          </div>
          <div class="task-section-body">
            <div class="task-child-work-toolbar">
              <${TextField}
                size="small"
                placeholder="Create child task summary"
                value=${subtaskTitle}
                onInput=${(e) => setSubtaskTitle(e.target.value)}
                fullWidth
              />
              <${Button}
                variant="contained"
                size="small"
                disabled=${creatingSubtask || !sanitizeTaskText(subtaskTitle || "").trim()}
                onClick=${handleCreateSubtask}
              >
                ${creatingSubtask ? "Creating…" : "+ Child"}
              <//>
            </div>
            <div class="task-child-work-list">
              ${!subtasksLoading && !subtasks.length && html`<div class="meta-text">No subtasks yet.</div>`}
              ${subtasks.map((subtask) => html`
                <div class="task-subtask-row" key=${subtask.id}>
                  <div class="task-subtask-main">
                    <button type="button" class="task-subtask-open" onClick=${() => handleOpenRelatedTask(subtask.id)}>
                      <div class="task-subtask-title-row">
                        <span class="task-hierarchy-type-pill">${getTaskListIssueTypeLabel(subtask)}</span>
                        <strong>${subtask.title}</strong>
                      </div>
                      <div class="task-comment-meta">
                        <span style="user-select:all">${subtask.id}</span>
                        ${subtask.status ? ` · ${subtask.status}` : ""}
                        ${subtask.storyPoints ? ` · ${subtask.storyPoints} pts` : ""}
                        ${subtask.dueDate ? ` · due ${subtask.dueDate}` : ""}
                      </div>
                    </button>
                  </div>
                  <div class="task-subtask-controls">
                    <${Select}
                      size="small"
                      value=${subtask.status || "todo"}
                      onChange=${(e) => { void handleInlineSubtaskUpdate(subtask, { status: e.target.value }, "Child status updated"); }}
                    >
                      ${["draft", "todo", "inprogress", "inreview", "blocked", "done", "cancelled"].map(
                        (entryStatus) => html`<${MenuItem} value=${entryStatus}>${entryStatus}</${MenuItem}>`,
                      )}
                    </${Select}>
                    <${TextField}
                      size="small"
                      defaultValue=${subtask.assignee || ""}
                      placeholder="Assign"
                      onBlur=${(e) => {
                        const nextValue = toText(e.target.value);
                        if (nextValue === toText(subtask.assignee)) return;
                        void handleInlineSubtaskUpdate(subtask, { assignee: nextValue || null }, nextValue ? "Child assignee updated" : "Child assignee cleared");
                      }}
                      onKeyDown=${(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                    <${Button} variant="text" size="small" onClick=${() => handleOpenRelatedTask(subtask.id)}>Open<//>
                  </div>
                  ${(subtask.dependencyTaskIds?.length > 0 || subtask.blockedReason || subtask.labels?.length > 0) && html`
                    <div class="task-subtask-signals">
                      ${subtask.dependencyTaskIds?.length > 0 && html`
                        <span class="task-subtask-signal">Deps: ${subtask.dependencyTaskIds.join(", ")}</span>
                      `}
                      ${subtask.blockedReason && html`
                        <span class="task-subtask-signal task-subtask-signal-blocked">${truncate(subtask.blockedReason, 96)}</span>
                      `}
                      ${subtask.labels?.length > 0 && html`
                        <span class="task-subtask-signal">Labels: ${subtask.labels.join(", ")}</span>
                      `}
                    </div>
                  `}
                </div>
              `)}
            </div>
          </div>
        </div>

        ${/* Activity */ ""}
        <div class="task-section">
          <div class="task-section-title">
            Activity
            ${comments.length > 0 && html`<span class="task-tab-count">${comments.length}</span>`}
            ${historyEntries.length > 0 && html`<span class="task-tab-count">${historyEntries.length} history</span>`}
          </div>
          <div class="task-section-body">
            <div class="task-comments-list">
              ${comments.length > 0
                ? comments.map((comment, index) => html`
                  <div class="task-comment-item" key=${comment.id || `comment-${index}`}>
                    <div class="task-comment-meta">
                      ${comment.author ? `@${comment.author}` : "comment"}
                      ${comment.createdAt ? ` · ${formatRelative(comment.createdAt)}` : ""}
                    </div>
                    <div class="task-comment-body">${comment.body}</div>
                  </div>
                `)
                : html`<div class="meta-text">No comments yet. Add one below.</div>`}
            </div>
            <div class="task-comment-composer" style=${{ marginTop: "10px" }}>
              <${TextField}
                multiline
                rows=${2}
                size="small"
                placeholder="Add a comment or status update..."
                value=${commentDraft}
                onInput=${(e) => setCommentDraft(e.target.value)}
                fullWidth
              />
              <${Button}
                variant="contained"
                size="small"
                disabled=${postingComment || !sanitizeTaskText(commentDraft || "").trim()}
                onClick=${handlePostComment}
              >
                ${postingComment ? "Posting…" : "Post Comment"}
              <//>
            </div>
            <div class="task-overview-grid" style=${{ marginTop: "14px" }}>
              <div class="task-overview-card">
                <div class="task-comment-meta">Timeline Events</div>
                <div class="task-comment-body">${historyEntries.length ? `${historyEntries.length} recorded entries` : "No timeline history yet."}</div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Workflow Runs</div>
                <div class="task-comment-body">${workflowRuns.length ? `${workflowRuns.length} linked runs` : "No workflow runs linked yet."}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${workflowRuns.filter((run) => String(run?.status || "").toLowerCase() === "failed").length} failed
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Durable Sessions</div>
                <div class="task-comment-body">${taskDurableSessionIds.length
                  ? `${taskDurableSessionIds.length} linked session IDs`
                  : "No durable session lineage linked yet."}</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${[taskPrimaryDurableSessionId ? `primary ${truncate(taskPrimaryDurableSessionId, 36)}` : "", taskAuditSourceLabel ? `source ${taskAuditSourceLabel}` : ""].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div class="task-overview-card">
                <div class="task-comment-meta">Audit Trail</div>
                <div class="task-comment-body">${hasTaskAuditContent
                  ? `${taskAuditEventCount} events · ${taskAuditToolCallCount} tool calls · ${taskAuditArtifactCount} artifacts`
                  : "No state ledger / SQLite audit linked yet."}</div>
              </div>
            </div>
          </div>
        </div>

        ${/* Workflow Activity */ ""}
        ${workflowRuns.length > 0 && html`
          <div class="task-section">
            <div class="task-section-title">Execution Activity</div>
            <div class="task-section-body">
              <div class="task-comments-list">
                ${workflowRuns.map((run, index) => renderWorkflowActivityCard(run, `workflow-${index}`))}
              </div>
            </div>
          </div>
        `}

      </div>

      ${/* ── RIGHT: Sidebar ── */ ""}
      <div class="task-detail-sidebar">
        <div class="task-sidebar-group-title" data-group="primary">Primary Details</div>

        ${/* Status */ ""}
        <div class="task-sidebar-field" data-field="status">
          <div class="task-sidebar-label">Status</div>
          <div class="task-sidebar-value">
            <${Select}
              size="small"
              value=${status}
              onChange=${(e) => {
                const next = e.target.value;
                setStatus(next);
                if (next === "draft") setDraft(true);
                else if (draft) setDraft(false);
              }}
              fullWidth
            >
              ${["draft", "todo", "inprogress", "inreview", "blocked", "done", "cancelled"].map(
                (s) => html`<${MenuItem} value=${s}>${s}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
        </div>

        ${/* Priority */ ""}
        <div class="task-sidebar-field" data-field="priority">
          <div class="task-sidebar-label">Priority</div>
          <div class="task-sidebar-value">
            <${Select}
              size="small"
              value=${priority}
              onChange=${(e) => setPriority(e.target.value)}
              fullWidth
            >
              <${MenuItem} value="">No priority</${MenuItem}>
              ${["low", "medium", "high", "critical"].map(
                (p) => html`<${MenuItem} value=${p}>${p}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
        </div>

        ${/* Assignee */ ""}
        <div class="task-sidebar-field" data-field="assignee">
          <div class="task-sidebar-label">Assignee</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Assignee"
              value=${assignee}
              onInput=${(e) => setAssignee(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Assignees */ ""}
        <div class="task-sidebar-field" data-field="assignees">
          <div class="task-sidebar-label">Assignees</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="alice, bob"
              value=${assigneesInput}
              onInput=${(e) => setAssigneesInput(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Sprint */ ""}
        <div class="task-sidebar-field" data-field="sprint">
          <div class="task-sidebar-label">Sprint</div>
          <div class="task-sidebar-value">
            <div style="display:flex;gap:6px;">
              <${Select}
                size="small"
                value=${selectedSprintId}
                onChange=${(e) => setSelectedSprintId(e.target.value)}
                style=${{ flex: 1 }}
              >
                <${MenuItem} value="">No sprint</${MenuItem}>
                ${sprintOptions.map((sprint) => html`
                  <${MenuItem} key=${sprint.id} value=${sprint.id}>${sprint.label}</${MenuItem}>
                `)}
              </${Select}>
              <${TextField}
                size="small"
                type="number"
                placeholder="#"
                value=${sprintOrderInput}
                onInput=${(e) => setSprintOrderInput(e.target.value)}
                inputProps=${{ min: 1, step: 1 }}
                style=${{ width: "60px" }}
              />
            </div>
          </div>
        </div>

        ${/* Story Points */ ""}
        <div class="task-sidebar-field" data-field="story-points">
          <div class="task-sidebar-label">Story Points</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              type="number"
              placeholder="Points"
              value=${storyPoints}
              onInput=${(e) => setStoryPoints(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Due Date */ ""}
        <div class="task-sidebar-field" data-field="due-date">
          <div class="task-sidebar-label">Due Date</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              type="date"
              value=${dueDate}
              onInput=${(e) => setDueDate(e.target.value)}
              InputLabelProps=${{ shrink: true }}
              fullWidth
            />
          </div>
        </div>

        ${/* Epic */ ""}
        <div class="task-sidebar-field" data-field="epic">
          <div class="task-sidebar-label">Epic</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Epic"
              value=${epicId}
              onInput=${(e) => setEpicId(e.target.value)}
              fullWidth
            />
            ${epicCatalog.length > 0 && html`
              <div class="tag-row" style=${{ marginTop: "6px" }}>
                ${epicCatalog.slice(0, 6).map((entry) => html`<button type="button" class="tag-chip task-structure-chip ${epicId === entry.id ? "task-structure-chip-active" : ""}" style="font-size:10px;" onClick=${() => setEpicId(entry.id)}>${entry.label}</button>`)}
              </div>
            `}
            ${currentEpicEntry?.anchorTaskId && html`
              <div class="meta-text" style=${{ marginTop: "6px" }}>
                <button type="button" class="task-inline-link-btn" onClick=${() => handleOpenRelatedTask(currentEpicEntry.anchorTaskId)}>Open epic task</button>
              </div>
            `}
          </div>
        </div>

        ${/* Goal */ ""}
        <div class="task-sidebar-group-title" data-group="planning">Planning & Automation</div>
        <div class="task-sidebar-field" data-field="goal">
          <div class="task-sidebar-label">Goal</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Primary goal ID"
              value=${goalId}
              onInput=${(e) => setGoalId(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Parent Goal */ ""}
        <div class="task-sidebar-field" data-field="parent-goal">
          <div class="task-sidebar-label">Parent Goal</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Parent goal ID"
              value=${parentGoalId}
              onInput=${(e) => setParentGoalId(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Coordination Team */ ""}
        <div class="task-sidebar-field" data-field="coordination-team">
          <div class="task-sidebar-label">Coordination Team</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Team ID"
              value=${coordinationTeamId}
              onInput=${(e) => setCoordinationTeamId(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Coordination Role */ ""}
        <div class="task-sidebar-field" data-field="coordination-role">
          <div class="task-sidebar-label">Coordination Role</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="planner, implementer, reviewer"
              value=${coordinationRole}
              onInput=${(e) => setCoordinationRole(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Reports To */ ""}
        <div class="task-sidebar-field" data-field="reports-to">
          <div class="task-sidebar-label">Reports To</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Supervisor or lead ID"
              value=${coordinationReportsTo}
              onInput=${(e) => setCoordinationReportsTo(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Coordination Level */ ""}
        <div class="task-sidebar-field" data-field="coordination-level">
          <div class="task-sidebar-label">Coordination Level</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="squad, program, org"
              value=${coordinationLevel}
              onInput=${(e) => setCoordinationLevel(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Parent Task */ ""}
        <div class="task-sidebar-field" data-field="parent-task">
          <div class="task-sidebar-label">Parent Task</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="Parent task ID"
              value=${parentTaskId}
              onInput=${(e) => setParentTaskId(e.target.value)}
              fullWidth
            />
            ${currentParentTask && html`
              <div class="meta-text" style=${{ marginTop: "6px", display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                <span>Linked parent: <strong>${currentParentTask.title || currentParentTask.id}</strong></span>
                <button type="button" class="task-inline-link-btn" onClick=${() => handleOpenRelatedTask(currentParentTask.id)}>Open</button>
              </div>
            `}
          </div>
        </div>

        ${/* Budget Window */ ""}
        <div class="task-sidebar-field" data-field="budget-window">
          <div class="task-sidebar-label">Budget Window</div>
          <div class="task-sidebar-value">
            <${TextField}
              size="small"
              variant="outlined"
              placeholder="2026-Q2"
              value=${budgetWindow}
              onInput=${(e) => setBudgetWindow(e.target.value)}
              fullWidth
            />
          </div>
        </div>

        ${/* Budget */ ""}
        <div class="task-sidebar-field" data-field="budget">
          <div class="task-sidebar-label">Budget</div>
          <div class="task-sidebar-value">
            <div style="display:flex;gap:6px;">
              <${TextField}
                size="small"
                variant="outlined"
                type="number"
                placeholder="Budget cents"
                value=${budgetCents}
                onInput=${(e) => setBudgetCents(e.target.value)}
                inputProps=${{ min: 0, step: 1 }}
                style=${{ flex: 1 }}
              />
              <${TextField}
                size="small"
                variant="outlined"
                placeholder="USD"
                value=${budgetCurrency}
                onInput=${(e) => setBudgetCurrency(e.target.value.toUpperCase())}
                style=${{ width: "88px" }}
              />
            </div>
          </div>
        </div>

        ${/* Tags */ ""}
        <div class="task-sidebar-field" data-field="labels">
          <div class="task-sidebar-label">Tags</div>
          <div class="task-sidebar-value">
            <${TextField} size="small" variant="outlined" placeholder="Tags (comma-separated)" value=${tagsInput} onInput=${(e) => setTagsInput(e.target.value)} fullWidth />
            ${normalizeTagInput(tagsInput).length > 0 && html`
              <div class="tag-row" style=${{ marginTop: "4px" }}>
                ${normalizeTagInput(tagsInput).map(
                  (tag) => html`<span class="tag-chip">#${tag}</span>`,
                )}
              </div>
            `}
          </div>
        </div>

        ${/* Workspace & Repository */ ""}
        <div class="task-sidebar-field" data-field="workspace">
          <div class="task-sidebar-label">Workspace</div>
          <div class="task-sidebar-value">
            <${Select}
              size="small"
              value=${workspaceId}
              onChange=${(e) => setWorkspaceId(e.target.value)}
              fullWidth
            >
              <${MenuItem} value="">Active workspace</${MenuItem}>
              ${workspaceOptions.map(
                (ws) => html`<${MenuItem} value=${ws.id}>${ws.name || ws.id}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
        </div>

        <div class="task-sidebar-field" data-field="repository">
          <div class="task-sidebar-label">Repository</div>
          <div class="task-sidebar-value">
            <${Select}
              size="small"
              value=${repository}
              onChange=${(e) => setRepository(e.target.value)}
              disabled=${!repositoryOptions.length}
              fullWidth
            >
              <${MenuItem} value="">
                ${repositoryOptions.length ? "Auto repository" : "No repos in workspace"}
              </${MenuItem}>
              ${repositoryOptions.map(
                (repo) =>
                  html`<${MenuItem} value=${repo.slug}>${repo.name}${repo.primary ? " (Primary)" : ""}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
        </div>

        ${/* Base Branch */ ""}
        <div class="task-sidebar-field" data-field="base-branch">
          <div class="task-sidebar-label">Base Branch</div>
          <div class="task-sidebar-value">
            <${TextField} size="small" variant="outlined" placeholder="e.g. feature/xyz" value=${baseBranch} onInput=${(e) => setBaseBranch(e.target.value)} fullWidth />
          </div>
        </div>

        ${/* Draft toggle */ ""}
        <div class="task-sidebar-field" data-field="draft">
          <div class="task-sidebar-label">Draft</div>
          <div class="task-sidebar-value">
            <${Toggle}
              label="Keep in backlog"
              checked=${draft}
              onChange=${(next) => {
                setDraft(next);
                if (next) setStatus("draft");
                else if (status === "draft") setStatus("todo");
              }}
            />
          </div>
        </div>

        ${/* Manual Override toggle */ ""}
        <div class="task-sidebar-field" data-field="manual">
          <div class="task-sidebar-label">Manual</div>
          <div class="task-sidebar-value">
            <${Toggle}
              label="Exclude from automation"
              checked=${manualOverride}
              disabled=${manualBusy || !task?.id}
              onChange=${handleManualToggle}
            />
            ${manualOverride && html`
              <${TextField} size="small" variant="outlined" placeholder="Reason (optional)" value=${manualReason} disabled=${manualBusy} onInput=${(e) => setManualReason(e.target.value)} fullWidth style=${{ marginTop: "6px" }} />
              <div class="meta-text" style=${{ marginTop: "4px" }}>Bosun will skip this task until cleared.</div>
            `}
          </div>
        </div>

        ${/* Dependencies */ ""}
        <div class="task-sidebar-field" data-field="dependencies" style="flex-direction:column;gap:6px;">
          <div class="task-sidebar-label" style="width:auto;">Dependencies</div>
          <div class="task-sidebar-value">
            ${currentEpicEntry && html`<div class="meta-text" style=${{ marginBottom: "6px" }}>Epic: ${currentEpicEntry.label} · ${currentEpicEntry.taskCount} tasks</div>`}
            <${TextField}
              multiline
              rows=${2}
              size="small"
              placeholder="Dependency task IDs (comma or newline separated)"
              value=${dependenciesInput}
              onInput=${(e) => setDependenciesInput(e.target.value)}
              fullWidth
            />
            ${currentDependencyIds.length > 0 && html`
              <div class="tag-row" style=${{ marginTop: "6px" }}>
                ${currentDependencyIds.map((depId) => html`<button type="button" class="tag-chip task-structure-chip" onClick=${() => handleDependencyChipRemove(depId)} title="Remove dependency">${depId} ×</button>`)}
              </div>
            `}
            ${dependencySuggestions.length > 0 && html`
              <div style=${{ marginTop: "6px" }}>
                <div class="meta-text" style=${{ marginBottom: "4px" }}>Quick add</div>
                <div class="tag-row">
                  ${dependencySuggestions.map((entry) => html`<button type="button" class="tag-chip task-structure-chip task-structure-chip-muted" onClick=${() => handleDependencyChipAdd(entry.id)}>${entry.id}: ${truncate(entry.title || entry.id, 20)}</button>`)}
                </div>
              </div>
            `}
            <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap;">
              <${Button} variant="outlined" size="small" disabled=${savingDependencies} onClick=${handleSaveDependencies}>
                ${savingDependencies ? "Saving…" : "Save Deps"}
              <//>
              <${Button} variant="outlined" size="small" disabled=${savingSprint || !selectedSprintId} onClick=${handleSaveSprintAssignment}>
                ${savingSprint ? "Saving…" : "Save Sprint"}
              <//>
              <${Button} variant="text" size="small" disabled=${savingSprint} onClick=${() => handleSprintOrderNudge(-1)}>↑<//>
              <${Button} variant="text" size="small" disabled=${savingSprint} onClick=${() => handleSprintOrderNudge(1)}>↓<//>
            </div>
            ${dependencyFeedback && html`<span class="meta-text">${dependencyFeedback}</span>`}
          </div>
        </div>

        ${/* Meta info */ ""}
        ${task?.meta?.triggerTemplate?.id && html`
          <div class="task-sidebar-field" data-field="trigger">
            <div class="task-sidebar-label">Trigger</div>
            <div class="task-sidebar-value" style="font-size:11px;opacity:0.7;">${task.meta.triggerTemplate.id}</div>
          </div>
        `}
        ${(task?.meta?.execution?.sdk || task?.meta?.execution?.model) && html`
          <div class="task-sidebar-field" data-field="exec-override">
            <div class="task-sidebar-label">Exec Override</div>
            <div class="task-sidebar-value" style="font-size:11px;opacity:0.7;">
              ${task?.meta?.execution?.sdk || "auto"}${task?.meta?.execution?.model ? ` · ${task.meta.execution.model}` : ""}
            </div>
          </div>
        `}
        ${task?.branch && html`
          <div class="task-sidebar-field" data-field="branch">
            <div class="task-sidebar-label">Branch</div>
            <div class="task-sidebar-value" style="font-size:11px;user-select:all;word-break:break-all;">${task.branch}</div>
          </div>
        `}

        <div class="task-sidebar-field" data-field="runtime-metrics">
          <div class="task-sidebar-label">Execution</div>
          <div class="task-sidebar-value">
            <div class="task-comment-item">
              <div class="task-comment-meta">Attempts count</div>
              <div class="task-comment-body">${lifetimeAttempts.toLocaleString("en-US")}</div>
            </div>
            <div class="task-comment-item">
              <div class="task-comment-meta">Total tokens</div>
              <div class="task-comment-body">${lifetimeTokenCount.toLocaleString("en-US")}</div>
            </div>
            <div class="task-comment-item">
              <div class="task-comment-meta">Total runtime</div>
              <div class="task-comment-body">${formatLifetimeDuration(lifetimeDurationMs)}</div>
            </div>
          </div>
        </div>

        ${/* Timestamps */ ""}
        <div class="task-timestamps" data-field="timestamps">
          ${task?.created_at && html`<div class="task-timestamp-row">Created ${new Date(task.created_at).toLocaleString()}</div>`}
          ${task?.updated_at && html`<div class="task-timestamp-row">Updated ${formatRelative(task.updated_at)}</div>`}
        </div>

        ${/* Save bar */ ""}
        <div class="task-save-bar" data-field="save-actions">
          <${SaveDiscardBar}
            dirty=${hasUnsaved}
            message=${unsavedChangesMessage(changeCount)}
            saveLabel="Save Changes"
            discardLabel="Discard"
            onSave=${() => {
              void handleSave({ closeAfterSave: false });
            }}
            onDiscard=${handleDiscardChanges}
            saving=${saving}
            disabled=${Boolean(activeOperationLabel && !saving)}
          />
        </div>

        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${(task?.status === "error" || task?.status === "cancelled") && html`
            <${Button} variant="contained" size="small" onClick=${handleRetry}>↻ Retry<//>
          `}
          ${task?.status === "blocked" && html`
            <${Button} variant="contained" size="small" onClick=${handleUnblock}>↺ Move To Todo<//>
          `}
          <${Button}
            variant="outlined" size="small"
            onClick=${() => { void handleSave({ closeAfterSave: true }); }}
            disabled=${saving}
          >
            ${saving ? "Saving…" : iconText(":save: Save")}
          <//>
          <${Button} variant="text" size="small" onClick=${() => handleStatusUpdate("inreview")}>→ Review<//>
          <${Button} variant="text" size="small" onClick=${() => handleStatusUpdate("done")}>${iconText("✓ Done")}<//>
          ${task?.status !== "cancelled" && html`
            <${Button}
              variant="text" size="small"
              style=${{ color: "var(--color-error)" }}
              onClick=${handleCancel}
            >
              ${iconText("✕ Cancel")}
            <//>
          `}
          ${task?.id && html`
            <${Button}
              variant="text" size="small"
              onClick=${() => {
                haptic();
                sendCommandToChat("/logs " + task.id);
              }}
            >
              ${iconText(":file: Logs")}
            <//>
          `}
        </div>

      </div>

      </div>`}

      ${/* ── EXECUTION TAB ───────────────────────────────────────────── */ ""}
      ${activeTab === "execution" && html`<div style="display:contents;">

      ${/* ── Execution Plan Visualization (Premium) ─────────────────── */ ""}
      <div class="exec-plan-stage" style="margin:0 0 14px;">
        <div class="exec-plan-stage-header" style="background:transparent;border-bottom:none;padding:12px 16px;">
          <span style="font-weight:700;font-size:0.9em;flex:1;">${resolveIcon("play")} Execution Plan</span>
          ${executionPlanLoading && html`<span style="font-size:0.8em;opacity:0.6;">Loading…</span>`}
          ${executionPlan && html`<span style="font-size:0.8em;opacity:0.6;">${executionPlan.stageCount || 0} workflows · ${executionPlan.agentRunTotal || 0} agent runs</span>`}
          ${executionPlan?.validationIssues?.length > 0 && html`
            <span class="exec-plan-badge" style="background:#ef444420;color:#f87171;">
              ${executionPlan.validationIssues.filter((v) => v.level === "error").length} errors
            </span>
          `}
        </div>
        <div class="exec-plan-stage-body">
          ${/* ── Action buttons ── */ ""}
          <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center;">
            <button style="padding:6px 14px;border-radius:6px;border:1px solid var(--border-color,#444);background:var(--color-bg-secondary,#1a1f2e);color:var(--color-text,#e0e0e0);font-size:0.8em;cursor:pointer;"
              onClick=${() => fetchExecutionPlan("resolve")} disabled=${executionPlanLoading}>
              ${resolveIcon("refresh")} Refresh Plan
            </button>
            <button style="padding:6px 14px;border-radius:6px;border:1px solid #3b82f660;background:#3b82f620;color:#60a5fa;font-size:0.8em;cursor:pointer;font-weight:600;"
              onClick=${() => fetchExecutionPlan("dry-run")} disabled=${dryRunLoading || executionPlanLoading}>
              ${dryRunLoading ? "Simulating…" : `${resolveIcon("play")} Dry Run Simulation`}
            </button>
            ${executionPlan?.mode === "dry-run" && html`
              <span style="font-size:0.8em;color:#10b981;font-weight:600;">${resolveIcon("check") || "✓"} Dry-run complete</span>
            `}
          </div>

            ${/* ── Validation Issues ── */ ""}
            ${executionPlan?.validationIssues?.length > 0 && html`
              <div style="margin-bottom:10px;border:1px solid #ef444440;border-radius:6px;padding:8px;background:#ef444410;">
                <div style="font-weight:600;font-size:0.8em;color:#f87171;margin-bottom:4px;">${resolveIcon("warning")} Validation Issues</div>
                ${executionPlan.validationIssues.map((issue, ii) => html`
                  <div key=${`vi-${ii}`} style="font-size:0.75em;padding:2px 0;display:flex;gap:4px;align-items:start;">
                    <span style="color:${issue.level === 'error' ? '#f87171' : '#fbbf24'};flex-shrink:0;">${issue.level === "error" ? "✗" : "⚠"}</span>
                    <span><strong>${issue.workflowName}:</strong> ${issue.message}</span>
                  </div>
                `)}
              </div>
            `}

            ${!executionPlan && !executionPlanLoading && html`
              <div style="opacity:0.6;font-size:0.85em;padding:8px;">No execution plan data available.</div>
            `}

            ${/* ── Workflow Stages (Enhanced) ── */ ""}
            ${executionPlan?.stages?.map((stage, si) => {
              const matchColors = {
                task_assigned: { bg: "#3b82f620", color: "#60a5fa", label: "Task Match" },
                polling: { bg: "#6b728020", color: "#9ca3af", label: "Lifecycle" },
                pr_event: { bg: "#8b5cf620", color: "#a78bfa", label: "PR Event" },
                schedule: { bg: "#06b6d420", color: "#22d3ee", label: "Scheduled" },
                event: { bg: "#f5932020", color: "#fb923c", label: "Event" },
                anomaly: { bg: "#ef444420", color: "#f87171", label: "Anomaly" },
                webhook: { bg: "#84cc1620", color: "#a3e635", label: "Webhook" },
                manual: { bg: "#6b728020", color: "#d1d5db", label: "Manual" },
                workflow_call: { bg: "#14b8a620", color: "#2dd4bf", label: "Sub-call" },
              };
              const mc = matchColors[stage.matchType] || { bg: "#33333320", color: "#888", label: stage.matchType };

              return html`
              <div key=${`stage-${si}`} class="exec-plan-stage">
                <div class="exec-plan-stage-header" onClick=${() => toggleStageExpand(si)}>
                  <span style="font-size:0.8em;opacity:0.5;">${expandedStages[si] !== false ? "▾" : "▸"}</span>
                  ${stage.core ? html`<span class="exec-plan-badge" style="background:#8b5cf620;color:#a78bfa;">CORE</span>` : ""}
                  <strong style="font-size:0.9em;flex:1;">${stage.workflowName}</strong>
                  <span class="exec-plan-badge" style="background:${mc.bg};color:${mc.color};">${mc.label}</span>
                  <span style="font-size:0.75em;opacity:0.5;">${stage.nodeCount} nodes · ${stage.agentRunCount} agents</span>
                  <span style="font-size:0.65em;opacity:0.35;text-transform:uppercase;">${stage.category || ""}</span>
                </div>

                ${expandedStages[si] !== false && html`
                  <div class="exec-plan-stage-body">
                    ${stage.description ? html`<div style="font-size:0.8em;opacity:0.6;margin-bottom:10px;">${stage.description}</div>` : ""}

                    ${/* ── Node Pipeline ── */ ""}
                    <div style="display:flex;flex-direction:column;gap:0;">
                      ${(stage.nodes || []).map((nd, ni) => {
                        const isExpanded = expandedNodes[`${si}-${nd.id}`];
                        const nodeColor = nd.isAgentRun ? "#3b82f6"
                          : nd.isTrigger ? "#eab308"
                          : nd.isCondition ? "#8b5cf6"
                          : nd.isCommand || nd.isValidation ? "#22c55e"
                          : nd.isStatusUpdate ? "#ef4444"
                          : nd.isPromptBuilder ? "#f59e0b"
                          : nd.isCreatePr || nd.isPushBranch ? "#06b6d4"
                          : nd.isSubWorkflow ? "#14b8a6"
                          : nd.isNotify ? "#64748b"
                          : "#6b7280";
                        const hasIssue = nd.expressionValid === false || !nd.typeRegistered || (nd.unresolvedVars?.length > 0);
                        const dryRunNode = dryRunResults?.find((dr) => dr.workflowId === stage.workflowId)?.nodes?.find((dn) => dn.id === nd.id);

                        return html`
                          <div key=${`n-${ni}`}>
                            ${ni > 0 && html`<div class="exec-plan-connector"></div>`}
                            <div class="exec-plan-node" style="border-color:${hasIssue ? '#ef4444' : nodeColor + '40'};">
                              <div class="exec-plan-node-header" onClick=${() => toggleNodeExpand(si, nd.id)}>
                                <span style="width:22px;height:22px;border-radius:6px;background:${nodeColor}20;color:${nodeColor};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">${ni + 1}</span>
                                <span style="font-size:0.7em;color:${nodeColor};opacity:0.8;min-width:70px;font-weight:500;">${nd.type.split(".").pop()}</span>
                                <strong style="flex:1;font-size:0.85em;">${nd.label}</strong>
                                ${hasIssue ? html`<span style="color:#ef4444;font-size:0.7em;">✗</span>` : ""}

                                ${/* Agent badges */ ""}
                                ${nd.isAgentRun && nd.resolvedAgent ? html`
                                  <span class="exec-plan-skill-tag" style="background:${nodeColor}15;color:${nodeColor};border-color:${nodeColor}30;">
                                    ${resolveIcon("bot")} ${nd.resolvedAgent} ${nd.confidence ? `(${Math.round(nd.confidence * 100)}%)` : ""}
                                  </span>
                                ` : ""}
                                ${nd.isAgentRun && !nd.resolvedAgent && nd.resolveMode === "library" ? html`
                                  <span class="exec-plan-badge" style="background:#f59e0b20;color:#fbbf24;">Auto-Resolve</span>
                                ` : ""}

                                ${/* Context flow chips */ ""}
                                ${nd.contextPreview?.hasTaskPrompt ? html`<span class="exec-plan-context-chip">TaskPrompt</span>` : ""}
                                ${nd.contextPreview?.hasPreviousOutput ? html`<span class="exec-plan-context-chip" style="background:#8b5cf615;color:#a78bfa;border-color:#8b5cf630;">PrevOutput</span>` : ""}

                                ${/* Status indicators */ ""}
                                ${nd.isStatusUpdate ? html`<span class="exec-plan-badge" style="background:#ef444420;color:#fca5a5;">→ ${nd.targetStatus}</span>` : ""}
                                ${nd.isCommand ? html`<span style="font-size:0.65em;font-family:monospace;opacity:0.5;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nd.commandResolved || nd.commandRaw}</span>` : ""}
                                ${nd.isPromptBuilder ? html`<span class="exec-plan-badge" style="background:#f59e0b20;color:#fbbf24;">Builds TaskPrompt</span>` : ""}
                                ${nd.isCreatePr ? html`<span class="exec-plan-badge" style="background:#06b6d420;color:#22d3ee;">Creates PR</span>` : ""}

                                ${dryRunNode ? html`<span style="font-size:0.65em;color:${dryRunNode.status === 'simulated' || dryRunNode.status === 'COMPLETED' ? '#10b981' : '#fbbf24'};">● ${dryRunNode.status}</span>` : ""}
                                <span style="font-size:0.65em;opacity:0.3;">${isExpanded ? "▾" : "▸"}</span>
                              </div>

                              ${isExpanded && html`
                                <div class="exec-plan-node-body">
                                  ${/* ── Inputs from previous nodes ── */ ""}
                                  ${nd.inputsFrom?.length > 0 ? html`
                                    <div style="margin-bottom:8px;padding:6px 8px;background:var(--bg-surface,#0d1117);border-radius:6px;border:1px solid var(--border-color,#333);">
                                      <div style="font-size:0.85em;opacity:0.6;margin-bottom:4px;font-weight:600;">Inputs From:</div>
                                      <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                        ${nd.inputsFrom.map((inp) => html`
                                          <span class="exec-plan-context-chip" style="background:#3b82f610;color:#60a5fa;border-color:#3b82f625;">
                                            ${inp.nodeLabel} ${inp.port ? `[${inp.port}]` : ""} ${inp.condition ? `if: ${inp.condition.slice(0, 30)}` : ""}
                                          </span>
                                        `)}
                                      </div>
                                    </div>
                                  ` : ""}

                                  <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px;align-items:start;">
                                    <span style="opacity:0.5;">Type:</span>
                                    <span style="font-family:monospace;">${nd.type}${!nd.typeRegistered ? html` <span style="color:#ef4444;">✗ unregistered</span>` : ""}</span>

                                    ${nd.isTrigger && nd.taskPattern ? html`
                                      <span style="opacity:0.5;">Pattern:</span>
                                      <span style="font-family:monospace;">${nd.taskPattern} ${nd.patternMatches === true ? html`<span style="color:#10b981;">✓ matches</span>` : nd.patternMatches === false ? html`<span style="color:#ef4444;">✗ no match</span>` : ""}</span>
                                    ` : ""}

                                    ${nd.isTrigger && nd.prEvents ? html`
                                      <span style="opacity:0.5;">PR Events:</span>
                                      <span>${nd.prEvents.join(", ")}</span>
                                    ` : ""}

                                    ${nd.isTrigger && nd.eventTypes?.length > 0 ? html`
                                      <span style="opacity:0.5;">Event Types:</span>
                                      <span>${nd.eventTypes.join(", ")}</span>
                                    ` : ""}

                                    ${nd.isTrigger && nd.intervalMs ? html`
                                      <span style="opacity:0.5;">Interval:</span>
                                      <span>${Math.round(nd.intervalMs / 60000)}min</span>
                                    ` : ""}

                                    ${nd.isCondition && nd.expression ? html`
                                      <span style="opacity:0.5;">Expression:</span>
                                      <span style="font-family:monospace;word-break:break-all;">${nd.expression}${nd.expressionValid === false ? html` <span style="color:#ef4444;">✗ ${nd.expressionError}</span>` : html` <span style="color:#10b981;">✓</span>`}</span>
                                    ` : ""}
                                    ${nd.isCondition && nd.cases ? html`
                                      <span style="opacity:0.5;">Cases:</span>
                                      <span>${nd.cases.join(", ")}</span>
                                    ` : ""}

                                    ${nd.isAgentRun ? html`
                                      <span style="opacity:0.5;">SDK:</span><span>${nd.sdk || "auto"}</span>
                                      <span style="opacity:0.5;">Model:</span><span>${nd.model || "auto"}</span>
                                      <span style="opacity:0.5;">Timeout:</span><span>${Math.round((nd.timeoutMs || 3600000) / 60000)}min</span>
                                      <span style="opacity:0.5;">Retries:</span><span>${nd.maxRetries ?? 2} retries, ${nd.maxContinues ?? 2} continues</span>
                                      <span style="opacity:0.5;">Resolve:</span><span style="font-weight:500;color:${nd.resolveMode === 'library' ? '#f59e0b' : '#60a5fa'};">${nd.resolveMode || "manual"}${nd.resolveMode === "library" ? " (auto)" : ""}</span>
                                      <span style="opacity:0.5;">CWD:</span><span style="font-family:monospace;">${nd.cwd || "auto"}</span>
                                    ` : ""}

                                    ${nd.isCommand ? html`
                                      <span style="opacity:0.5;">Command:</span>
                                      <span style="font-family:monospace;word-break:break-all;">${nd.commandResolved || nd.commandRaw}</span>
                                      <span style="opacity:0.5;">CWD:</span><span style="font-family:monospace;">${nd.commandCwd}</span>
                                      <span style="opacity:0.5;">Timeout:</span><span>${Math.round((nd.commandTimeout || 300000) / 1000)}s</span>
                                      <span style="opacity:0.5;">Fail on error:</span><span>${nd.failOnError ? "Yes" : "No"}</span>
                                    ` : ""}

                                    ${nd.isResolveExecutor ? html`
                                      <span style="opacity:0.5;">SDK Override:</span><span>${nd.sdkOverride || "auto"}</span>
                                      <span style="opacity:0.5;">Model Override:</span><span>${nd.modelOverride || "auto"}</span>
                                    ` : ""}

                                    ${nd.isSubWorkflow ? html`
                                      <span style="opacity:0.5;">Sub-workflow:</span><span style="font-family:monospace;">${nd.targetWorkflowId || "—"}</span>
                                      <span style="opacity:0.5;">Inherit ctx:</span><span>${nd.inheritContext ? "Yes" : "No"}</span>
                                    ` : ""}

                                    ${nd.isValidation ? html`
                                      <span style="opacity:0.5;">${nd.validationType} cmd:</span>
                                      <span style="font-family:monospace;">${nd.commandResolved || nd.commandRaw || "auto-detect"}</span>
                                    ` : ""}

                                    ${nd.isPromptBuilder ? html`
                                      <span style="opacity:0.5;">Output:</span><span>${"{{TaskPrompt}}"}</span>
                                      <span style="opacity:0.5;">Include Skills:</span><span>${nd.includeSkills !== false ? "Yes" : "No"}</span>
                                      <span style="opacity:0.5;">Include Agent Instructions:</span><span>${nd.includeAgentInstructions !== false ? "Yes" : "No"}</span>
                                    ` : ""}

                                    ${nd.isCreatePr ? html`
                                      <span style="opacity:0.5;">PR Title:</span><span>${nd.prTitle || "auto"}</span>
                                      <span style="opacity:0.5;">Base Branch:</span><span>${nd.prBaseBranch || "main"}</span>
                                    ` : ""}

                                    ${nd.joinMode ? html`
                                      <span style="opacity:0.5;">Join mode:</span><span>${nd.joinMode}</span>
                                    ` : ""}

                                    ${nd.isNotify && nd.logMessage ? html`
                                      <span style="opacity:0.5;">Message:</span><span>${nd.logMessage}</span>
                                    ` : ""}

                                    ${nd.unresolvedVars?.length > 0 ? html`
                                      <span style="opacity:0.5;color:#fbbf24;">Unresolved:</span>
                                      <span style="color:#fbbf24;">${nd.unresolvedVars.map((v) => `{{${v}}}`).join(", ")}</span>
                                    ` : ""}
                                  </div>

                                  ${/* ── Agent: Context Preview ── */ ""}
                                  ${nd.isAgentRun && nd.contextPreview ? html`
                                    <div style="margin-top:8px;padding:6px 8px;background:#1a1a2e;border-radius:6px;border:1px solid #333;">
                                      <div style="font-size:0.85em;opacity:0.6;margin-bottom:4px;font-weight:600;">${resolveIcon("link") || "🔗"} Context Injected:</div>
                                      <div style="display:flex;flex-wrap:wrap;gap:4px;">
                                        ${nd.contextPreview.hasTaskPrompt ? html`<span class="exec-plan-context-chip">Task Prompt (built by build_task_prompt)</span>` : ""}
                                        ${nd.contextPreview.hasPreviousOutput ? html`<span class="exec-plan-context-chip" style="background:#8b5cf615;color:#a78bfa;border-color:#8b5cf630;">Previous Agent Output</span>` : ""}
                                        ${nd.contextPreview.hasWorktreePath ? html`<span class="exec-plan-context-chip" style="background:#22c55e15;color:#4ade80;border-color:#22c55e30;">Worktree Path</span>` : ""}
                                        ${nd.contextPreview.hasBranchName ? html`<span class="exec-plan-context-chip" style="background:#06b6d415;color:#22d3ee;border-color:#06b6d430;">Branch Name</span>` : ""}
                                        ${nd.contextPreview.hasPrUrl ? html`<span class="exec-plan-context-chip" style="background:#8b5cf615;color:#c4b5fd;border-color:#8b5cf630;">PR Link</span>` : ""}
                                        ${nd.includeTaskContext ? html`<span class="exec-plan-context-chip" style="background:#f59e0b15;color:#fbbf24;border-color:#f59e0b30;">Full Task Context</span>` : ""}
                                        ${(nd.contextPreview.injectedVariables || []).map((v) => html`
                                          <span class="exec-plan-context-chip" style="background:#64748b15;color:#94a3b8;border-color:#64748b30;">${"{{" + v + "}}"}</span>
                                        `)}
                                      </div>
                                    </div>
                                  ` : ""}

                                  ${/* ── Agent: resolved skills with descriptions ── */ ""}
                                  ${nd.isAgentRun && nd.resolvedSkills?.length > 0 ? html`
                                    <div style="margin-top:8px;padding:8px;background:var(--bg-surface,#0d1117);border-radius:6px;border:1px solid var(--border-color,#333);">
                                      <div style="font-size:0.85em;opacity:0.6;margin-bottom:6px;font-weight:600;">${resolveIcon("star")} Resolved Skills (${nd.resolvedSkills.length}):</div>
                                      ${nd.resolvedSkills.map((sk) => html`
                                        <div style="display:flex;gap:8px;padding:4px 0;align-items:start;border-bottom:1px solid var(--border-color,#222);">
                                          <span class="exec-plan-skill-tag">${sk.name} ${sk.score ? `${Math.round(sk.score * 100)}%` : ""}</span>
                                          ${sk.source ? html`<span style="opacity:0.35;font-size:0.85em;">(${sk.source})</span>` : ""}
                                          ${sk.description ? html`<span style="opacity:0.5;font-size:0.85em;flex:1;">${sk.description.slice(0, 120)}${sk.description.length > 120 ? "…" : ""}</span>` : ""}
                                        </div>
                                      `)}
                                    </div>
                                  ` : ""}

                                  ${/* ── Agent: resolved tools ── */ ""}
                                  ${nd.isAgentRun && nd.resolvedTools && (nd.resolvedTools.builtin?.length > 0 || nd.resolvedTools.mcp?.length > 0) ? html`
                                    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                                      <span style="opacity:0.6;font-size:0.85em;">${resolveIcon("tool")} Tools:</span>
                                      ${[...(nd.resolvedTools.builtin || []), ...(nd.resolvedTools.mcp || [])].map((t) => html`
                                        <span style="padding:1px 6px;border-radius:4px;font-size:0.75em;background:#22c55e10;color:#4ade80;border:1px solid #22c55e25;">${t}</span>
                                      `)}
                                    </div>
                                  ` : ""}

                                  ${/* ── Agent: alternatives ── */ ""}
                                  ${nd.isAgentRun && nd.alternatives?.length > 0 ? html`
                                    <div style="margin-top:6px;opacity:0.5;font-size:0.85em;">
                                      <span>Alternatives: ${nd.alternatives.map((a) => `${a.name} (${Math.round((a.confidence || 0) * 100)}%)`).join(", ")}</span>
                                    </div>
                                  ` : ""}

                                  ${/* ── Agent: prompt preview ── */ ""}
                                  ${nd.isAgentRun && nd.promptResolved ? html`
                                    <details style="margin-top:8px;">
                                      <summary style="cursor:pointer;opacity:0.6;font-size:0.85em;font-weight:500;">Prompt Preview (${nd.promptResolved.length} chars)</summary>
                                      <pre style="margin-top:4px;padding:8px;background:#00000030;border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;font-size:0.8em;line-height:1.5;">${nd.promptResolved.slice(0, 3000)}${nd.promptResolved.length > 3000 ? "\n…(truncated)" : ""}</pre>
                                    </details>
                                  ` : ""}
                                </div>
                              `}
                            </div>
                          </div>
                        `;
                      })}
                    </div>

                    ${/* ── Edge routing ── */ ""}
                    ${stage.edges?.some((e) => e.condition || e.sourcePort || e.isBackEdge) && html`
                      <details style="margin-top:10px;">
                        <summary style="cursor:pointer;font-size:0.8em;opacity:0.5;font-weight:500;">Edge Routing (${stage.edges.length} edges)</summary>
                        <div style="margin-top:6px;font-size:0.75em;font-family:monospace;">
                          ${stage.edges.filter((e) => e.condition || e.sourcePort || e.isBackEdge).map((e) => html`
                            <div style="padding:3px 0;display:flex;gap:6px;align-items:center;">
                              <span>${e.source}</span>
                              <span style="opacity:0.3;">→</span>
                              <span>${e.target}</span>
                              ${e.sourcePort ? html`<span style="color:#a78bfa;">[${e.sourcePort}]</span>` : ""}
                              ${e.condition ? html`<span style="opacity:0.5;color:${e.conditionValid === false ? '#ef4444' : '#4ade80'};">${e.condition.length > 60 ? e.condition.slice(0, 60) + "…" : e.condition}</span>` : ""}
                              ${e.isBackEdge ? html`<span style="color:#fbbf24;">↩ loop</span>` : ""}
                              ${e.conditionValid === false ? html`<span style="color:#ef4444;">✗ ${e.conditionError}</span>` : ""}
                            </div>
                          `)}
                        </div>
                      </details>
                    `}
                  </div>
                `}
              </div>
            `;})}

            ${/* ── Dry-run results summary ── */ ""}
            ${dryRunResults && html`
              <div style="margin-top:10px;border:1px solid #10b98140;border-radius:8px;padding:10px;background:#10b98110;">
                <div style="font-weight:600;font-size:0.85em;color:#10b981;margin-bottom:6px;">${resolveIcon("check")} Dry-Run Simulation Results</div>
                ${dryRunResults.map((dr) => html`
                  <div style="font-size:0.8em;padding:3px 0;display:flex;gap:8px;align-items:center;">
                    <span style="font-weight:500;">${dr.workflowName}</span>
                    <span class="exec-plan-badge" style="background:${dr.status === 'completed' ? '#10b98120' : dr.status === 'error' ? '#ef444420' : '#fbbf2420'};color:${dr.status === 'completed' ? '#10b981' : dr.status === 'error' ? '#ef4444' : '#fbbf24'};">
                      ${dr.status}
                    </span>
                    ${dr.error ? html`<span style="color:#ef4444;font-size:0.9em;">${dr.error}</span>` : ""}
                    ${dr.nodes?.length > 0 ? html`<span style="opacity:0.5;">(${dr.nodes.length} nodes simulated)</span>` : ""}
                  </div>
                `)}
              </div>
            `}
        </div>
      </div>

      </div>`}

      ${/* ── HISTORY TAB ─────────────────────────────────────────────── */ ""}
      ${activeTab === "diff" && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Review Diff</div>
          <div style=${{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div class="task-comment-meta">
              Compare the task branch or linked session against its recorded base so completed PRs stay reviewable from the task itself.
            </div>
            <${DiffViewer}
              taskId=${task?.id || ""}
              title=${task?.title || "Task Diff"}
              taskSnapshot=${task || null}
            />
          </div>
        </div>
      `}

      ${activeTab === "history" && html`<div style="display:contents;">

      ${historyEntries.length > 0 ? html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">History Timeline</div>
          <${TableContainer} ref=${historyTableRef} component=${Paper} variant="outlined" sx=${{ maxHeight: 360, overflow: "auto" }}>
            <${Table} size="small" stickyHeader>
              <${TableHead}>
                <${TableRow}>
                  <${TableCell}>When<//>
                  <${TableCell}>Source<//>
                  <${TableCell}>Event<//>
                </${TableRow}>
              <//>
              <${TableBody}>
                ${historyTopSpacer > 0
                  ? html`<${TableRow}><${TableCell} colSpan=${3} sx=${{ p: 0, border: 0, height: `${historyTopSpacer}px` }} /><//>`
                  : null}
                ${visibleHistoryEntries.map((entry, index) => html`
                  <${TableRow} key=${`history-${historyStartIdx + index}`} hover>
                    <${TableCell} sx=${{ whiteSpace: "nowrap" }}>
                      ${entry.timestamp ? formatRelative(entry.timestamp) : "Time unknown"}
                    <//>
                    <${TableCell}>
                      <${Chip}
                        size="small"
                        variant="outlined"
                        color="default"
                        label=${entry.source || "system"}
                      />
                    <//>
                    <${TableCell}>${entry.label}<//>
                  </${TableRow}>
                `)}
                ${historyBottomSpacer > 0
                  ? html`<${TableRow}><${TableCell} colSpan=${3} sx=${{ p: 0, border: 0, height: `${historyBottomSpacer}px` }} /><//>`
                  : null}
              <//>
            </${Table}>
          <//>
        </div>
      ` : ""}

      ${relatedLinks.length > 0 && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Branch and PR Links</div>
          <div class="task-comments-list">
            ${relatedLinks.map((item, index) => html`
              <div class="task-comment-item" key=${`link-${index}`}>
                <div class="task-comment-meta">${item.kind}</div>
                <div class="task-comment-body">
                  ${renderTaskRelatedLinks([item])}
                </div>
              </div>
            `)}
          </div>
        </div>
      `}

      ${/* workflow activity in history tab too */ ""}
      ${workflowRuns.length > 0 && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Workflow Activity</div>
          <${TableContainer} component=${Paper} variant="outlined">
            <${Table} size="small" stickyHeader>
              <${TableHead}>
                <${TableRow}>
                  <${TableCell}>Workflow<//>
                  <${TableCell}>Run<//>
                  <${TableCell}>Status<//>
                  <${TableCell}>Timing<//>
                  <${TableCell} align="right">Actions<//>
                </${TableRow}>
              <//>
              <${TableBody}>
                ${workflowRuns.map((run, index) => html`
                  <${TableRow} key=${`wf-hist-${index}`} hover>
                    <${TableCell}>
                      <${Typography} variant="body2">${run.workflowName || run.workflowId || "workflow"}<//>
                      ${run.nodeId ? html`<${Typography} variant="caption" color="text.secondary">Node: ${run.nodeId}<//>` : null}
                    <//>
                    <${TableCell}>
                      <${Typography} variant="caption" sx=${{ fontFamily: "monospace" }}>
                        ${run.runId || run.id || "-"}
                      <//>
                    <//>
                    <${TableCell}>
                      <${Chip}
                        size="small"
                        color=${statusChipColor(run.status || run.outcome || "default")}
                        label=${run.status || run.outcome || "unknown"}
                      />
                    <//>
                    <${TableCell}>
                      <${Typography} variant="caption">
                        ${run.startedAt ? formatRelative(run.startedAt) : (run.timestamp ? formatRelative(run.timestamp) : "Unknown")}
                      <//>
                    <//>
                    <${TableCell} align="right">
                      <${Stack} direction="row" spacing=${0.5} justifyContent="flex-end">
                        ${run.hasRunLink ? html`
                          <${Button} variant="outlined" size="small" onClick=${() => { void handleOpenWorkflowRun(run); }}>
                            Open Run
                          <//>
                        ` : null}
                        ${run.hasSessionLink ? html`
                          <${Button} variant="text" size="small" onClick=${() => { void handleOpenWorkflowAgentHistory(run); }}>
                            Agent
                          <//>
                        ` : null}
                      <//>
                    <//>
                  </${TableRow}>
                `)}
              <//>
            </${Table}>
          <//>
        </div>
      `}

      ${hasTaskAuditContent && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Audit Trail</div>
          <div class="tag-row" style=${{ marginBottom: "8px" }}>
            ${taskAuditClaim ? html`<span class="tag-chip">active claim</span>` : null}
            ${taskAuditEventCount > 0 ? html`<span class="tag-chip">${taskAuditEventCount} audit events</span>` : null}
            ${taskAuditClaimEventCount > 0 ? html`<span class="tag-chip">${taskAuditClaimEventCount} claim events</span>` : null}
            ${taskAuditRunCount > 0 ? html`<span class="tag-chip">${taskAuditRunCount} ledger workflow runs</span>` : null}
            ${taskAuditToolCallCount > 0 ? html`<span class="tag-chip">${taskAuditToolCallCount} tool calls</span>` : null}
            ${taskAuditArtifactCount > 0 ? html`<span class="tag-chip">${taskAuditArtifactCount} artifacts</span>` : null}
            ${taskAuditOperatorActionCount > 0 ? html`<span class="tag-chip">${taskAuditOperatorActionCount} operator actions</span>` : null}
            ${taskAuditPromotedStrategyCount > 0 ? html`<span class="tag-chip">${taskAuditPromotedStrategyCount} promoted strategies</span>` : null}
            ${taskAuditPromotedStrategyEvents.length > 0 ? html`<span class="tag-chip">${taskAuditPromotedStrategyEvents.length} strategy events</span>` : null}
            ${taskAuditTraceCount > 0 ? html`<span class="tag-chip">${taskAuditTraceCount} task trace events</span>` : null}
          </div>
          ${(taskAuditSessionIds.length > 0 || taskAuditAgentIds.length > 0) && html`
            <div class="tag-row" style=${{ marginBottom: "8px" }}>
              ${taskAuditSessionIds.slice(0, 6).map((entry, index) => html`<span class="tag-chip" key=${`audit-session-${index}`}>session ${truncate(entry, 28)}</span>`)}
              ${taskAuditAgentIds.slice(0, 6).map((entry, index) => html`<span class="tag-chip" key=${`audit-agent-${index}`}>agent ${truncate(entry, 28)}</span>`)}
            </div>
          `}
          <div class="task-comments-list">
            ${taskAuditClaim || taskAuditClaimEvents.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Claim Ledger</div>
                <div class="task-comment-body">${taskAuditClaim ? summarizeTaskAuditClaim(taskAuditClaim) : "No active task claim recorded."}</div>
                <div class="task-comment-meta">
                  ${taskAuditClaim?.claim_token
                    ? `token ${truncate(taskAuditClaim.claim_token, 24)}`
                    : taskAuditClaimEvents.length
                      ? `${taskAuditClaimEventCount} claim lifecycle events`
                      : ""}
                </div>
                ${taskAuditClaimEvents.slice(-3).reverse().map((entry, index) => html`
                  <div key=${`claim-event-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${summarizeTaskAuditClaimEvent(entry)}
                    ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditSessionActivity || taskAuditAgentActivity || taskAuditSessionIds.length > 0 || taskAuditAgentIds.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Session & Agent Activity</div>
                <div class="task-comment-body">
                  ${taskAuditSessionActivity?.sessionId || taskAuditSessionIds[0]
                    ? html`<span><b>Session:</b> <code>${taskAuditSessionActivity?.sessionId || taskAuditSessionIds[0]}</code></span>`
                    : "No linked session activity recorded."}
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${taskAuditSessionActivity
                    ? summarizeTaskAuditSessionActivity(taskAuditSessionActivity)
                    : ""}
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${taskAuditAgentActivity?.agentId || taskAuditAgentIds[0]
                    ? summarizeTaskAuditAgentActivity(taskAuditAgentActivity || { agentId: taskAuditAgentIds[0] })
                    : ""}
                </div>
                ${(taskAuditSessionActivity?.lastSummary || taskAuditAgentActivity?.lastSummary) && html`
                  <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${taskAuditSessionActivity?.lastSummary || taskAuditAgentActivity?.lastSummary}
                  </div>
                `}
              </div>
            ` : null}
            ${taskDurableSessionIds.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Durable Session Topology</div>
                <div class="task-comment-body">
                  <span><b>Primary Session:</b> <code>${taskPrimaryDurableSessionId || taskDurableSessionIds[0]}</code></span>
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${taskDurableSessionIds.length} durable session IDs · ${taskAuditSourceLabel || "source state ledger / SQLite"}
                </div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  ${taskDurableSessionIds.slice(0, 4).map((sessionId) => html`<code key=${sessionId} style="margin-right:4px;">${sessionId}</code>`)}
                </div>
              </div>
            ` : null}
            ${taskDelegationTopologyRows.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Delegation Topology</div>
                <div class="task-comment-body">${taskDelegationTopologyRows.length} delegated workflow run families linked to this task.</div>
                <div class="task-comment-meta" style=${{ marginTop: "4px" }}>
                  max depth ${maxTaskDelegationDepth} · ${taskDelegationTopologyRows.reduce((total, entry) => total + Number(entry?.durableSessionIds?.length || 0), 0)} run-linked sessions
                </div>
                ${taskDelegationTopologyRows.slice(0, 4).map((entry, index) => html`
                  <div key=${`task-delegation-topology-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.run.workflowName || entry.run.workflowId || entry.run.runId || "workflow"} · ${entry.summary}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditToolCalls.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Tool Calls</div>
                <div class="task-comment-body">${Number(taskAuditSummary.toolCallCount || taskAuditToolCalls.length || 0)} recorded tool invocations.</div>
                ${taskAuditToolCalls.slice(0, 4).map((entry, index) => html`
                  <div key=${`tool-call-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.toolName || entry.toolId || "tool"}
                    ${entry.status ? ` · ${entry.status}` : ""}
                    ${entry.provider ? ` · ${entry.provider}` : ""}
                    ${entry.summary ? ` · ${entry.summary}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditArtifacts.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Artifacts</div>
                <div class="task-comment-body">${Number(taskAuditSummary.artifactCount || taskAuditArtifacts.length || 0)} artifact records captured.</div>
                ${taskAuditArtifacts.slice(0, 4).map((entry, index) => html`
                  <div key=${`artifact-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.kind || "artifact"}
                    ${entry.path ? ` · ${entry.path}` : ""}
                    ${entry.summary ? ` · ${entry.summary}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditOperatorActions.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Operator Actions</div>
                <div class="task-comment-body">${Number(taskAuditSummary.operatorActionCount || taskAuditOperatorActions.length || 0)} operator actions linked to this task.</div>
                ${taskAuditOperatorActions.slice(0, 4).map((entry, index) => html`
                  <div key=${`operator-action-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.actionType || "action"}
                    ${entry.status ? ` · ${entry.status}` : ""}
                    ${entry.actorId ? ` · ${entry.actorId}` : ""}
                    ${entry.targetId ? ` · target ${entry.targetId}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditPromotedStrategies.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Promoted Strategies</div>
                <div class="task-comment-body">${Number(taskAuditSummary.promotedStrategyCount || taskAuditPromotedStrategies.length || 0)} promoted strategy records available.</div>
                ${taskAuditPromotedStrategies.slice(0, 4).map((entry, index) => html`
                  <div key=${`promoted-strategy-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.recommendation || entry.decision || entry.strategyId || "strategy"}
                    ${entry.status ? ` · ${entry.status}` : ""}
                    ${entry.verificationStatus ? ` · ${entry.verificationStatus}` : ""}
                    ${entry.confidence != null ? ` · confidence ${entry.confidence}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditPromotedStrategyEvents.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Promoted Strategy Events</div>
                <div class="task-comment-body">${taskAuditPromotedStrategyEvents.length} promotion lifecycle events captured.</div>
                ${taskAuditPromotedStrategyEvents.slice(0, 4).map((entry, index) => html`
                  <div key=${`promoted-strategy-event-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.decision || entry.status || entry.strategyId || "event"}
                    ${entry.verificationStatus ? ` · ${entry.verificationStatus}` : ""}
                    ${entry.createdAt ? ` · ${formatRelative(entry.createdAt)}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditTraceEvents.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Task Trace Events</div>
                <div class="task-comment-body">${Number(taskAuditSummary.taskTraceCount || taskAuditTraceEvents.length || 0)} ledger trace events recorded.</div>
                ${taskAuditTraceEvents.slice(0, 4).map((entry, index) => html`
                  <div key=${`task-trace-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${entry.eventType || "event"}
                    ${entry.status ? ` · ${entry.status}` : ""}
                    ${entry.nodeLabel || entry.nodeId ? ` · ${entry.nodeLabel || entry.nodeId}` : ""}
                    ${entry.summary ? ` · ${entry.summary}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditWorkflowRuns.length > 0 ? html`
              <div class="task-comment-item">
                <div class="task-comment-meta">Ledger Workflow Runs</div>
                <div class="task-comment-body">${Number(taskAuditSummary.runCount || taskAuditWorkflowRuns.length || 0)} workflow runs linked from the state ledger.</div>
                ${taskAuditWorkflowRuns.slice(0, 4).map((run, index) => html`
                  <div key=${`audit-run-${index}`} class="task-comment-meta" style=${{ marginTop: "4px" }}>
                    ${run.workflowName || run.workflowId || "workflow"}
                    ${run.runId ? ` · run ${run.runId}` : ""}
                    ${run.status ? ` · ${run.status}` : ""}
                    ${run.timestamp ? ` · ${formatRelative(run.timestamp)}` : ""}
                  </div>
                `)}
              </div>
            ` : null}
            ${taskAuditEvents.slice(0, 12).map((entry, index) => html`
              <div class="task-comment-item" key=${`audit-${index}`}>
                <div class="task-comment-meta">
                  ${(entry.auditType || "audit").replace(/_/g, " ")}
                  ${entry.timestamp ? ` · ${formatRelative(entry.timestamp)}` : ""}
                </div>
                <div class="task-comment-body">${entry.summary || entry.eventType || entry.auditType || "Audit event"}</div>
                <div class="task-comment-meta">
                  ${[
                    entry.runId ? `run ${entry.runId}` : "",
                    entry.sessionId ? `session ${entry.sessionId}` : "",
                    entry.agentId ? `agent ${entry.agentId}` : "",
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
            `)}
          </div>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;" open>
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Recent Audit Events (${taskAuditEventCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditEvents.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No ledger timeline events recorded yet.</div></div>`
                : taskAuditEvents.slice(0, 12).map((entry, index) => html`
                    <div class="task-comment-item" key=${`audit-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${(entry.auditType || "audit").replace(/_/g, " ")}
                        ${entry.timestamp ? ` · ${formatRelative(entry.timestamp)}` : ""}
                      </div>
                      <div class="task-comment-body">${entry.summary || entry.eventType || entry.auditType || "Audit event"}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.runId ? `run ${entry.runId}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                          entry.agentId ? `agent ${entry.agentId}` : "",
                          entry.workflowId ? `workflow ${entry.workflowId}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Task Claims (${taskAuditClaimEventCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditClaimEvents.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No claim events recorded for this task.</div></div>`
                : taskAuditClaimEvents.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`claim-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["action", "eventType"]) || "claim event"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditClaimEvent(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          getTaskAuditValue(entry, ["claim_token", "claimToken"]) ? `token ${truncate(getTaskAuditValue(entry, ["claim_token", "claimToken"]), 24)}` : "",
                          getTaskAuditValue(entry, ["expires_at", "expiresAt"]) ? `expires ${formatRelative(getTaskAuditValue(entry, ["expires_at", "expiresAt"]))}` : "",
                          getTaskAuditValue(entry, ["previous_instance", "previousInstance"]) ? `prev ${getTaskAuditValue(entry, ["previous_instance", "previousInstance"])}` : "",
                          getTaskAuditValue(entry, ["rollback_to_instance", "rollbackToInstance"]) ? `rollback ${getTaskAuditValue(entry, ["rollback_to_instance", "rollbackToInstance"])}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Workflow Runs (${taskAuditRunCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditWorkflowRuns.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No ledger-linked workflow runs recorded for this task.</div></div>`
                : taskAuditWorkflowRuns.slice(0, 8).map((run, index) => html`
                    <div class="task-comment-item" key=${`audit-run-detail-${index}`}>
                      <div class="task-comment-meta">${buildTaskWorkflowRunMetaLine(run)}</div>
                      <div class="task-comment-body">${buildTaskWorkflowRunStatusLine(run)}</div>
                      <div class="task-comment-meta">
                        ${[
                          run.nodeId ? `node ${run.nodeId}` : "",
                          pickTaskWorkflowSessionId(run) ? `session ${pickTaskWorkflowSessionId(run)}` : "",
                          run.hasRunLink ? "open from Workflow Activity" : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Tool Calls (${taskAuditToolCallCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditToolCalls.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No tool calls recorded in the ledger.</div></div>`
                : taskAuditToolCalls.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`tool-call-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["toolName", "toolId"]) || "tool"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditToolCall(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.callId ? `call ${entry.callId}` : "",
                          entry.nodeId ? `node ${entry.nodeId}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                          Number.isFinite(Number(entry.durationMs)) && Number(entry.durationMs) > 0 ? formatDuration(Number(entry.durationMs)) : "",
                          entry.cwd ? truncate(entry.cwd, 64) : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Artifacts (${taskAuditArtifactCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditArtifacts.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No artifacts recorded in the ledger.</div></div>`
                : taskAuditArtifacts.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`artifact-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["kind"]) || "artifact"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditArtifact(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.artifactId ? `artifact ${entry.artifactId}` : "",
                          entry.runId ? `run ${entry.runId}` : "",
                          entry.nodeId ? `node ${entry.nodeId}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Operator Actions (${taskAuditOperatorActionCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditOperatorActions.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No operator actions recorded for this task.</div></div>`
                : taskAuditOperatorActions.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`operator-action-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["actionType", "action"]) || "operator action"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditOperatorAction(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.actorId ? `actor ${entry.actorId}` : "",
                          entry.scope ? `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                          entry.actionId ? `action ${entry.actionId}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Promoted Strategies (${taskAuditPromotedStrategyCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditPromotedStrategies.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No promoted strategies recorded for this task.</div></div>`
                : taskAuditPromotedStrategies.slice(0, 8).map((entry, index) => html`
                    <div class="task-comment-item" key=${`strategy-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["recommendation", "decision", "strategyId"]) || "strategy"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditPromotedStrategy(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.strategyId ? `strategy ${entry.strategyId}` : "",
                          entry.runId ? `run ${entry.runId}` : "",
                          entry.workflowId ? `workflow ${entry.workflowId}` : "",
                          formatTaskAuditConfidence(entry.confidence) ? `confidence ${formatTaskAuditConfidence(entry.confidence)}` : "",
                          entry.knowledgeHash ? `knowledge ${truncate(entry.knowledgeHash, 24)}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Strategy Event History (${taskAuditPromotedStrategyEvents.length})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditPromotedStrategyEvents.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No promoted-strategy event history recorded yet.</div></div>`
                : taskAuditPromotedStrategyEvents.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`strategy-event-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["category", "decision", "recommendation", "strategyId"]) || "strategy event"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditPromotedStrategy(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.strategyId ? `strategy ${entry.strategyId}` : "",
                          entry.scope ? `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}` : "",
                          entry.runId ? `run ${entry.runId}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
          <details style="background: var(--color-bg-secondary, #1a1f2e); border: 1px solid var(--color-border, #2a3040); border-radius: 8px; padding: 10px 12px; margin-top: 12px;">
            <summary style="cursor: pointer; font-weight: 600; font-size: 13px;">Trace Events (${taskAuditTraceCount})</summary>
            <div class="task-comments-list" style=${{ marginTop: "8px" }}>
              ${taskAuditTraceEvents.length === 0
                ? html`<div class="task-comment-item"><div class="task-comment-body">No task trace events recorded in the ledger.</div></div>`
                : taskAuditTraceEvents.slice(-8).reverse().map((entry, index) => html`
                    <div class="task-comment-item" key=${`trace-detail-${index}`}>
                      <div class="task-comment-meta">
                        ${getTaskAuditValue(entry, ["eventType"]) || "trace event"}
                        ${formatTaskAuditTimestamp(entry) ? ` · ${formatTaskAuditTimestamp(entry)}` : ""}
                      </div>
                      <div class="task-comment-body">${summarizeTaskAuditTraceEvent(entry)}</div>
                      <div class="task-comment-meta">
                        ${[
                          entry.runId ? `run ${entry.runId}` : "",
                          entry.workflowId ? `workflow ${entry.workflowId}` : "",
                          entry.sessionId ? `session ${entry.sessionId}` : "",
                          entry.agentId ? `agent ${entry.agentId}` : "",
                          Number.isFinite(Number(entry.durationMs)) && Number(entry.durationMs) > 0 ? formatDuration(Number(entry.durationMs)) : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  `)}
            </div>
          </details>
        </div>
      `}

      ${historyEntries.length === 0 && workflowRuns.length === 0 && relatedLinks.length === 0 && !hasTaskAuditContent ? html`
        <div style="padding:24px;text-align:center;opacity:0.5;font-size:0.9em;">No history, workflow runs, or links recorded yet.</div>
      ` : ""}

      </div>`}

      </div>
    <//>
  `;
}

function DagGraphSection({
  title,
  description = "",
  graph = EMPTY_DAG_GRAPH,
  onOpenTask,
  onActivateNode,
  onCreateEdge,
  onDeleteEdge,
  allowWiring = false,
  interactionMode = "open",
  graphKey = "dag",
  emptyMessage = "No DAG nodes available for this view yet.",
  highlightNodeIds = null,
}) {
  const stageRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [isPanning, setIsPanning] = useState(false);
  const [wireSourceId, setWireSourceId] = useState("");
  const [wiringBusy, setWiringBusy] = useState(false);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState("");
  const [wireDrag, setWireDrag] = useState(null);
  const [wireHoverId, setWireHoverId] = useState("");
  const isWireMode = allowWiring && interactionMode === "wire";
  const wireHoverIdRef = useRef("");
  const wireDragCleanupRef = useRef(null);

  const sortedNodes = useMemo(() => {
    const nodes = [...(graph?.nodes || [])];
    nodes.sort((a, b) => {
      const ad = Number.isFinite(a?.depth) ? Number(a.depth) : Number.MAX_SAFE_INTEGER;
      const bd = Number.isFinite(b?.depth) ? Number(b.depth) : Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
      const ao = Number.isFinite(a?.order) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b?.order) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return String(a?.title || a?.id || "").localeCompare(String(b?.title || b?.id || ""));
    });
    return nodes;
  }, [graph?.nodes]);

  const levels = useMemo(() => {
    const map = new Map();
    for (const node of sortedNodes) {
      const depth = Number.isFinite(node?.depth)
        ? Number(node.depth)
        : Number.isFinite(node?.order)
          ? Number(node.order)
          : 0;
      const key = Math.max(0, Math.trunc(depth));
      const list = map.get(key) || [];
      list.push(node);
      map.set(key, list);
    }
    if (!map.size && sortedNodes.length) map.set(0, [...sortedNodes]);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [sortedNodes]);

  const layout = useMemo(() => {
    const nodeWidth = 250;
    const nodeHeight = 92;
    const colGap = 130;
    const rowGap = 34;
    const marginX = 40;
    const marginY = 28;

    const positions = new Map();
    let maxRows = 1;
    levels.forEach(([, nodes], colIdx) => {
      maxRows = Math.max(maxRows, nodes.length);
      nodes.forEach((node, rowIdx) => {
        const x = marginX + colIdx * (nodeWidth + colGap);
        const y = marginY + rowIdx * (nodeHeight + rowGap);
        positions.set(String(node.id), { x, y, width: nodeWidth, height: nodeHeight, node });
      });
    });

    const totalWidth = Math.max(720, marginX * 2 + Math.max(1, levels.length) * nodeWidth + Math.max(0, levels.length - 1) * colGap);
    const totalHeight = Math.max(360, marginY * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
    return { positions, totalWidth, totalHeight };
  }, [levels]);

  const edges = useMemo(() => {
    const raw = Array.isArray(graph?.edges) ? graph.edges : [];
    return raw
      .map((edge, idx) => {
        const sourceId = String(edge?.source || edge?.from || "").trim();
        const targetId = String(edge?.target || edge?.to || "").trim();
        if (!sourceId || !targetId) return null;
        const source = layout.positions.get(sourceId);
        const target = layout.positions.get(targetId);
        if (!source || !target) return null;
        const kind = toText(edge?.kind || edge?.type || "depends-on", "depends-on").toLowerCase();
        return {
          key: sourceId + "->" + targetId + ":" + kind + ":" + idx,
          sourceId,
          targetId,
          source,
          target,
          kind,
        };
      })
      .filter(Boolean);
  }, [graph?.edges, layout.positions]);

  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.key === selectedEdgeKey) || null,
    [edges, selectedEdgeKey],
  );

  const worldBounds = useMemo(() => ({ width: layout.totalWidth, height: layout.totalHeight }), [layout]);

  const fitToView = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const availableWidth = Math.max(320, rect.width - 24);
    const availableHeight = Math.max(240, rect.height - 24);
    const scaleX = availableWidth / Math.max(1, worldBounds.width);
    const scaleY = availableHeight / Math.max(1, worldBounds.height);
    const nextZoom = Math.max(DAG_MIN_ZOOM, Math.min(DAG_MAX_ZOOM, Math.min(scaleX, scaleY)));
    const nextPanX = (rect.width - worldBounds.width * nextZoom) / 2;
    const nextPanY = (rect.height - worldBounds.height * nextZoom) / 2;
    setZoom(nextZoom);
    setPan({ x: nextPanX, y: nextPanY });
  }, [worldBounds.width, worldBounds.height]);

  useEffect(() => {
    fitToView();
  }, [fitToView, graphKey, sortedNodes.length, edges.length]);

  useEffect(() => {
    setWireSourceId("");
    setSelectedEdgeKey("");
    setWireDrag(null);
    setWireHoverId("");
  }, [graphKey, interactionMode]);

  useEffect(() => () => {
    if (typeof wireDragCleanupRef.current === "function") {
      wireDragCleanupRef.current();
      wireDragCleanupRef.current = null;
    }
  }, []);

  const applyZoomAtPoint = useCallback((nextZoom, clientX, clientY) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clamped = Math.max(DAG_MIN_ZOOM, Math.min(DAG_MAX_ZOOM, nextZoom));
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = (localX - pan.x) / zoom;
    const worldY = (localY - pan.y) / zoom;
    setZoom(clamped);
    setPan({ x: localX - worldX * clamped, y: localY - worldY * clamped });
  }, [pan.x, pan.y, zoom]);

  const handleWheel = useCallback((event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1.1 : 0.9;
    applyZoomAtPoint(zoom * delta, event.clientX, event.clientY);
  }, [applyZoomAtPoint, zoom]);

  const handlePanStart = useCallback((event) => {
    if (event.button !== 0) return;
    const targetEl = event.target;
    if (targetEl?.closest?.(".dag-node")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
    const onMove = (moveEvent) => {
      setPan({ x: start.panX + (moveEvent.clientX - start.x), y: start.panY + (moveEvent.clientY - start.y) });
    };
    const onUp = () => {
      setIsPanning(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [pan.x, pan.y]);

  const nodeById = useMemo(() => {
    const map = new Map();
    for (const node of sortedNodes) map.set(String(node.id), node);
    return map;
  }, [sortedNodes]);

  const highlightedIds = useMemo(() => {
    if (!highlightNodeIds || highlightNodeIds === "all") return new Set();
    return highlightNodeIds instanceof Set
      ? highlightNodeIds
      : new Set(Array.isArray(highlightNodeIds) ? highlightNodeIds : []);
  }, [highlightNodeIds]);

  const handleNodeClick = useCallback(async (node, event) => {
    event?.stopPropagation?.();
    if (isWireMode && typeof onCreateEdge === "function") {
      const id = String(node?.id || "");
      if (!id || wiringBusy) return;
      if (!wireSourceId) {
        setWireSourceId(id);
        setSelectedEdgeKey("");
        return;
      }
      if (wireSourceId === id) {
        setWireSourceId("");
        return;
      }
      const sourceNode = nodeById.get(wireSourceId) || null;
      const targetNode = nodeById.get(id) || null;
      if (!sourceNode || !targetNode) {
        setWireSourceId("");
        return;
      }
      setWiringBusy(true);
      try {
        await onCreateEdge({ sourceNode, targetNode });
      } finally {
        setWireSourceId("");
        setWiringBusy(false);
      }
      return;
    }
    if (typeof onActivateNode === "function") {
      onActivateNode(node);
      return;
    }
    if (node?.taskId) onOpenTask?.(node.taskId);
  }, [isWireMode, onActivateNode, onCreateEdge, onOpenTask, wireSourceId, nodeById, wiringBusy]);
  const commitWireConnection = useCallback(async (sourceId, targetId) => {
    if (!isWireMode || typeof onCreateEdge !== "function") return;
    if (!sourceId || !targetId || sourceId === targetId || wiringBusy) {
      setWireSourceId("");
      setWireHoverId("");
      return;
    }
    const sourceNode = nodeById.get(sourceId) || null;
    const targetNode = nodeById.get(targetId) || null;
    if (!sourceNode || !targetNode) {
      setWireSourceId("");
      setWireHoverId("");
      return;
    }
    setWiringBusy(true);
    try {
      await onCreateEdge({ sourceNode, targetNode });
    } finally {
      setWireSourceId("");
      setWireHoverId("");
      setWiringBusy(false);
    }
  }, [isWireMode, nodeById, onCreateEdge, wiringBusy]);

  const handleWireNodePointerDown = useCallback((node, event) => {
    if (!isWireMode || wiringBusy) return;
    const sourceId = String(node?.id || "").trim();
    if (!sourceId) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (typeof wireDragCleanupRef.current === "function") {
      wireDragCleanupRef.current();
      wireDragCleanupRef.current = null;
    }

    const dragState = {
      sourceId,
      startX: Number(event?.clientX || 0),
      startY: Number(event?.clientY || 0),
      dragging: false,
    };

    const handleMove = (moveEvent) => {
      const nextX = Number(moveEvent?.clientX || 0);
      const nextY = Number(moveEvent?.clientY || 0);
      if (!dragState.dragging) {
        const deltaX = nextX - dragState.startX;
        const deltaY = nextY - dragState.startY;
        if (Math.hypot(deltaX, deltaY) < 6) return;
        dragState.dragging = true;
        setWireSourceId(sourceId);
        setSelectedEdgeKey("");
        setWireHoverId("");
        wireHoverIdRef.current = "";
        setWireDrag({ sourceId, clientX: nextX, clientY: nextY });
        return;
      }
      setWireDrag((current) => current
        ? { ...current, clientX: nextX, clientY: nextY }
        : current);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };

    const finishWire = async () => {
      const targetId = wireHoverIdRef.current;
      setWireDrag(null);
      await commitWireConnection(sourceId, targetId);
    };

    const handleUp = async (upEvent) => {
      cleanup();
      wireDragCleanupRef.current = null;
      if (dragState.dragging) {
        await finishWire();
        return;
      }
      await handleNodeClick(node, upEvent);
    };

    const handleCancel = () => {
      cleanup();
      wireDragCleanupRef.current = null;
      setWireDrag(null);
      setWireHoverId("");
      wireHoverIdRef.current = "";
    };

    wireDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  }, [commitWireConnection, handleNodeClick, isWireMode, wiringBusy]);

  const handleEdgeClick = useCallback((edge, event) => {
    event?.stopPropagation?.();
    if (!isWireMode || typeof onDeleteEdge !== "function") return;
    setSelectedEdgeKey((current) => current === edge.key ? "" : edge.key);
    setWireSourceId("");
  }, [isWireMode, onDeleteEdge]);

  const handleDeleteSelectedEdge = useCallback(async () => {
    if (!selectedEdge || typeof onDeleteEdge !== "function") return;
    setWiringBusy(true);
    try {
      await onDeleteEdge(selectedEdge);
      setSelectedEdgeKey("");
    } finally {
      setWiringBusy(false);
    }
  }, [onDeleteEdge, selectedEdge]);

  const beginWireDrag = useCallback((node, event) => {
    if (!isWireMode || typeof onCreateEdge !== "function" || wiringBusy) return;
    const sourceId = String(node?.id || "").trim();
    if (!sourceId) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (typeof wireDragCleanupRef.current === "function") {
      wireDragCleanupRef.current();
      wireDragCleanupRef.current = null;
    }
    setWireSourceId(sourceId);
    setSelectedEdgeKey("");
    setWireHoverId("");
    wireHoverIdRef.current = "";
    setWireDrag({ sourceId, clientX: event.clientX, clientY: event.clientY });

    const handleMove = (moveEvent) => {
      setWireDrag((current) => current
        ? { ...current, clientX: moveEvent.clientX, clientY: moveEvent.clientY }
        : current);
    };
    const finish = async () => {
      const targetId = wireHoverIdRef.current;
      if (typeof wireDragCleanupRef.current === "function") {
        wireDragCleanupRef.current();
        wireDragCleanupRef.current = null;
      }
      setWireDrag(null);
      await commitWireConnection(sourceId, targetId);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", finish);
    };
    wireDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", finish, { once: true });
  }, [commitWireConnection, isWireMode, onCreateEdge, wiringBusy]);

  const previewPath = (() => {
    if (!wireDrag || !stageRef.current) return null;
    const source = layout.positions.get(String(wireDrag.sourceId));
    if (!source) return null;
    const rect = stageRef.current.getBoundingClientRect();
    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = (wireDrag.clientX - rect.left - pan.x) / zoom;
    const y2 = (wireDrag.clientY - rect.top - pan.y) / zoom;
    const c1 = x1 + Math.max(40, (x2 - x1) * 0.35);
    const c2 = x2 - Math.max(30, (x2 - x1) * 0.35);
    return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
  })();

  if (!sortedNodes.length) {
    return html`
      <${Paper} variant="outlined" style=${{ padding: "12px", marginBottom: "10px" }}>
        <div class="meta-text">${emptyMessage}</div>
      <//>
    `;
  }

  return html`
    <div class="tasks-dag-section">
      <div class="task-dag-header-row">
        <div>
          <div style=${{ fontWeight: "700" }}>${title || "Task DAG"}</div>
          ${description ? html`<div class="meta-text">${description}</div>` : null}
          <div class="meta-text">Drag to pan · wheel to zoom · ${isWireMode ? "drag from one node to another, or click source then target, to wire edges" : "click node to open task"}.</div>
        </div>
        <div class="task-dag-controls">
          <${Button} size="small" variant="outlined" onClick=${() => setZoom((z) => Math.max(DAG_MIN_ZOOM, z * 0.9))}>-</${Button}>
          <${Button} size="small" variant="outlined" onClick=${() => setZoom((z) => Math.min(DAG_MAX_ZOOM, z * 1.1))}>+</${Button}>
          <${Button} size="small" variant="outlined" onClick=${fitToView}>Fit</${Button}>
          <${Button} size="small" variant="text" onClick=${() => { setZoom(1); setPan({ x: 24, y: 24 }); }}>Reset</${Button}>
          <span class="task-dag-zoom-pill">${Math.round(zoom * 100)}%</span>
          ${selectedEdge && typeof onDeleteEdge === "function"
            ? html`<${Button} size="small" variant="outlined" color="error" disabled=${wiringBusy} onClick=${handleDeleteSelectedEdge}>Delete edge</${Button}>`
            : null}
          ${allowWiring
            ? html`<span class="task-dag-wire-pill">${wireDrag ? "Drag to a target node to connect" : wireSourceId ? `Source: ${wireSourceId}` : wiringBusy ? "Saving edge…" : "Wire by drag or click"}</span>`
            : null}
        </div>
      </div>
      <div class="task-dag-legend">
        <span class="task-dag-legend-item"><span class="task-dag-legend-line" style=${{ background: "var(--accent)" }}></span>depends-on</span>
        <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-dashed"></span>sequential</span>
        <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-block"></span>blocks</span>
      </div>
      <div class=${`task-dag-canvas-wrap ${isPanning ? "is-panning" : ""}`} ref=${stageRef} onWheel=${handleWheel} onPointerDown=${handlePanStart}>
        <svg class="task-dag-canvas" role="img" aria-label="Task dependency graph">
          <defs>
            <marker id=${`dag-arrow-${graphKey}`} markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
              <path d="M0,0 L10,4 L0,8 z" fill="var(--accent)" />
            </marker>
          </defs>
          <g transform=${`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            <rect x="0" y="0" width=${worldBounds.width} height=${worldBounds.height} fill="transparent" />
            ${edges.map((edge, idx) => {
              const { source, target, kind } = edge;
              const x1 = source.x + source.width;
              const y1 = source.y + source.height / 2;
              const x2 = target.x;
              const y2 = target.y + target.height / 2;
              const c1 = x1 + Math.max(40, (x2 - x1) * 0.35);
              const c2 = x2 - Math.max(30, (x2 - x1) * 0.35);
              const style = DAG_EDGE_STYLES[kind] || DAG_EDGE_STYLES["depends-on"];
              return html`
                <path
                  key=${`edge-${idx}`}
                  d=${`M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke=${style.color}
                  stroke-dasharray=${style.dash || ""}
                  stroke-opacity=${selectedEdgeKey === edge.key ? "1" : "0.75"}
                  stroke-width=${selectedEdgeKey === edge.key ? "3" : "2"}
                  marker-end=${`url(#dag-arrow-${graphKey})`}
                  onClick=${(event) => handleEdgeClick(edge, event)}
                />
              `;
            })}
            ${previewPath ? html`
              <path
                d=${previewPath}
                fill="none"
                stroke="var(--accent)"
                stroke-width="2.5"
                stroke-dasharray="6 5"
                stroke-opacity="0.9"
                marker-end=${`url(#dag-arrow-${graphKey})`}
                pointer-events="none"
              />
            ` : null}
            ${sortedNodes.map((node) => {
              const pos = layout.positions.get(String(node.id));
              if (!pos) return null;
              const selected = wireSourceId && String(node.id) === wireSourceId;
              const hoverTarget = wireHoverId && String(node.id) === wireHoverId;
              const highlighted = highlightedIds.has(String(node.id)) || highlightedIds.has(String(node.taskId || ""));
              return html`
                <g
                  key=${node.id}
                  class=${`dag-node ${selected ? "dag-node-selected" : ""} ${hoverTarget ? "dag-node-hover-target" : ""} ${highlighted ? "dag-node-highlighted" : ""}`}
                  onPointerDown=${(event) => event.stopPropagation()}
                                    onPointerDown=${(event) => {
                                      if (isWireMode) {
                                        handleWireNodePointerDown(node, event);
                                        return;
                                      }
                                      event.stopPropagation();
                                    }}
                  onPointerEnter=${() => {
                    if (!wireDrag || String(node.id) === String(wireDrag.sourceId)) return;
                    wireHoverIdRef.current = String(node.id);
                    setWireHoverId(String(node.id));
                  }}
                  onPointerLeave=${() => {
                    if (wireHoverIdRef.current !== String(node.id)) return;
                    wireHoverIdRef.current = "";
                    setWireHoverId("");
                  }}
                  onClick=${(event) => handleNodeClick(node, event)}
                  onClick=${isWireMode ? undefined : (event) => handleNodeClick(node, event)}
                  style=${{ cursor: isWireMode ? "crosshair" : node.taskId ? "pointer" : "default" }}
                >
                  <rect
                    x=${pos.x}
                    y=${pos.y}
                    width=${pos.width}
                    height=${pos.height}
                    rx="14"
                    ry="14"
                    fill="var(--bg-surface)"
                    stroke=${selected ? "var(--accent)" : hoverTarget ? "var(--color-warning)" : highlighted ? "var(--color-done)" : "var(--border)"}
                    stroke-width=${selected || hoverTarget || highlighted ? "2.2" : "1.5"}
                  />
                  <text x=${pos.x + 12} y=${pos.y + 24} fill="var(--text-primary)" font-size="13" font-weight="700">
                    ${truncate(node.title || "(untitled)", 34)}
                  </text>
                  <text x=${pos.x + 12} y=${pos.y + 44} fill="var(--text-muted)" font-size="11">
                    ${truncate(node.taskId || node.id, 38)}
                  </text>
                  <text x=${pos.x + 12} y=${pos.y + 64} fill="var(--accent)" font-size="11">
                    ${String(node.status || "todo")}
                  </text>
                  ${isWireMode ? html`
                    <circle
                      cx=${pos.x + pos.width - 14}
                      cy=${pos.y + pos.height / 2}
                      r="8"
                      fill=${selected ? "var(--accent)" : "var(--bg-canvas, #0f1115)"}
                      stroke="var(--accent)"
                      stroke-width="2"
                      onPointerDown=${(event) => handleWireNodePointerDown(node, event)}
                    />
                  ` : null}
                  ${Number.isFinite(node.order) && html`<text x=${pos.x + pos.width - 16} y=${pos.y + 22} text-anchor="end" fill="var(--text-muted)" font-size="11">#${node.order}</text>`}
                  ${highlighted && html`<text x=${pos.x + pos.width - 12} y=${pos.y + pos.height - 12} text-anchor="end" fill="var(--color-done)" font-size="11" font-weight="700">Ready</text>`}
                </g>
              `;
            })}
          </g>
        </svg>
      </div>
    </div>
  `;
}
/* ─── TasksTab ─── */
export function TasksTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const importInputRef = useRef(null);
  const [detailTask, setDetailTask] = useState(null);
  const [detailTaskHydrating, setDetailTaskHydrating] = useState(false);
  const [startTarget, setStartTarget] = useState(null);
  const [startAnyOpen, setStartAnyOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [kanbanLoadingMore, setKanbanLoadingMore] = useState(false);
  const [listSortCol, setListSortCol] = useState("");   // active column sort in list mode
  const [listSortDir, setListSortDir] = useState("desc"); // "asc" | "desc"
  const [collapsedHierarchyRows, setCollapsedHierarchyRows] = useState({});
  const [dagLoading, setDagLoading] = useState(false);
  const [dagError, setDagError] = useState("");
  const [dagOrganizeFeedback, setDagOrganizeFeedback] = useState("");
  const [dagOrganizeSuggestions, setDagOrganizeSuggestions] = useState([]);
  const [dagSprints, setDagSprints] = useState([]);
  const [dagSelectedSprint, setDagSelectedSprint] = useState("all");
  const [dagSprintGraph, setDagSprintGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagGlobalGraph, setDagGlobalGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagEpicGraph, setDagEpicGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagSources, setDagSources] = useState({ sprints: "", sprintGraph: "", globalGraph: "", epicDeps: "", tasks: "" });
  const [dagSprintOrderMode, setDagSprintOrderMode] = useState("parallel");
  const [dagAllTasks, setDagAllTasks] = useState([]);
  const [dagEpicDependencies, setDagEpicDependencies] = useState([]);
  const [dagFocusMode, setDagFocusMode] = useState("all");
  const [showCreateSprint, setShowCreateSprint] = useState(false);
  const [hierarchySubtasksByParentId, setHierarchySubtasksByParentId] = useState({});
  const detailRequestIdRef = useRef(0);
  const [editingSprint, setEditingSprint] = useState(null);
  const [createSeed, setCreateSeed] = useState(null);
  const [dagInteractionMode, setDagInteractionMode] = useState("open");
  const [isCompact, setIsCompact] = useState(() => {
    try { return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false; }
    catch { return false; }
  });
  const searchRef = useRef(null);
  const actionsRef = useRef(null);
  const handleHierarchySubtasksUpdate = useCallback((parentTaskId, nextSubtasks) => {
    const parentId = toText(parentTaskId);
    if (!parentId) return;
    setHierarchySubtasksByParentId((prev) => {
      const nextRows = normalizeSubtasksPayload({ subtasks: nextSubtasks });
      const prevRows = Array.isArray(prev?.[parentId]) ? prev[parentId] : [];
      const mergedRows = mergeSubtaskLists(prevRows, nextRows);
      if (!mergedRows.length && !prevRows.length) return prev;
      return {
        ...prev,
        [parentId]: mergedRows,
      };
    });
  }, []);
  const listStateRef = useRef({
    filter: tasksFilter?.value ?? "all",
    priority: tasksPriority?.value ?? "",
    sort: tasksSort?.value ?? "updated",
    page: tasksPage?.value ?? 0,
    pageSize: tasksPageSize?.value ?? 25,
  });

  /* Detect desktop for keyboard shortcut hint */
  const [showKbdHint] = useState(() => {
    try { return globalThis.matchMedia?.("(hover: hover)")?.matches ?? false; }
    catch { return false; }
  });
  const isMac = typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform || "");

  const tasks = tasksData.value || [];
  const filterVal = tasksFilter?.value ?? "todo";
  const priorityVal = tasksPriority?.value ?? "";
  const searchVal = tasksSearch?.value ?? "";
  const sortVal = tasksSort?.value ?? "updated";
  const page = tasksPage?.value ?? 0;
  const pageSize = tasksPageSize?.value ?? 25;
  const totalPages = tasksTotalPages?.value ?? 1;
  const defaultSdk = executorData.value?.data?.sdk || "auto";
  const activeSlots = executorData.value?.data?.slots || [];
  const hasActiveSlots = activeSlots.length > 0;
  const completedOnly = filterVal === "done";
  const trimmedSearch = searchVal.trim();
  const statusLabel =
    STATUS_CHIPS.find((s) => s.value === filterVal)?.label || "All";
  const priorityLabel =
    PRIORITY_CHIPS.find((p) => p.value === priorityVal)?.label || "Any";
  const sortLabel =
    SORT_OPTIONS.find((o) => o.value === sortVal)?.label || "Updated";
  const hasSearch = Boolean(trimmedSearch);
  const hasStatusFilter = filterVal && filterVal !== "all";
  const hasPriorityFilter = Boolean(priorityVal);
  const hasSortFilter = sortVal && sortVal !== "updated";
  const hasActiveFilters =
    hasSearch || hasStatusFilter || hasPriorityFilter || hasSortFilter;
  const activeFilterCount =
    [hasSearch, hasStatusFilter, hasPriorityFilter, hasSortFilter]
      .filter(Boolean).length;
  const filterSummaryParts = [];
  if (hasSearch)
    filterSummaryParts.push(`Search: "${truncate(trimmedSearch, 24)}"`);
  if (hasStatusFilter) filterSummaryParts.push(`Status: ${statusLabel}`);
  if (hasPriorityFilter) filterSummaryParts.push(`Priority: ${priorityLabel}`);
  if (hasSortFilter) filterSummaryParts.push(`Sort: ${sortLabel}`);
  const filterSummary = filterSummaryParts.join(" · ");
  const lastNonCompletedRef = useRef(
    filterVal && filterVal !== "done" ? filterVal : "all",
  );
  const isKanban = viewMode.value === "kanban";
  const isDag = viewMode.value === "dag";
  const isList = !isKanban && !isDag;
  const viewModeInitRef = useRef(false);
  const hasMoreKanbanPages = isKanban && page + 1 < totalPages;
  const boardColumnTotals = tasksStatusCounts?.value || { draft: 0, backlog: 0, blocked: 0, inProgress: 0, inReview: 0, done: 0 };
  const boardTotalTasks = Number(tasksTotal?.value || 0);
  const dagTaskCatalog = dagAllTasks.length ? dagAllTasks : tasks;
  const dagPlanningState = useMemo(() => buildDagPlanningState({
    tasks: dagTaskCatalog,
    sprintId: dagSelectedSprint,
    sprintOrderMode: dagSprintOrderMode,
    sprintOptions: dagSprints,
    epicDependencies: dagEpicDependencies,
  }), [dagAllTasks, dagEpicDependencies, dagSelectedSprint, dagSprintOrderMode, dagSprints, tasks]);
  const dagEpicCatalog = dagPlanningState.epicCatalog;
  const dagScopedTasks = useMemo(
    () => (dagTaskCatalog || []).filter((task) => dagSelectedSprint === "all" ? true : getTaskSprintId(task) === dagSelectedSprint),
    [dagSelectedSprint, dagTaskCatalog],
  );
  const dagSprintQueue = useMemo(
    () => [...dagScopedTasks].sort((a, b) => {
      const ao = Number(getTaskSprintOrder(a) || Number.MAX_SAFE_INTEGER);
      const bo = Number(getTaskSprintOrder(b) || Number.MAX_SAFE_INTEGER);
      if (ao !== bo) return ao - bo;
      return String(a?.title || a?.id || "").localeCompare(String(b?.title || b?.id || ""));
    }),
    [dagScopedTasks],
  );
  const dagReadyQueue = useMemo(
    () => dagSprintQueue.filter((task) => dagPlanningState.readyTaskIds.has(toText(task?.id))),
    [dagPlanningState.readyTaskIds, dagSprintQueue],
  );
  const dagBacklogQueue = useMemo(
    () => dagSprintQueue.filter((task) => dagPlanningState.backlogTaskIds.has(toText(task?.id))),
    [dagPlanningState.backlogTaskIds, dagSprintQueue],
  );
  const dagExecutionQueue = useMemo(
    () => dagSprintQueue.filter((task) => dagPlanningState.executionTaskIds.has(toText(task?.id))),
    [dagPlanningState.executionTaskIds, dagSprintQueue],
  );
  const dagFocusOptions = [
    { id: "all", label: "All structure", count: dagPlanningState.counts.all },
    { id: "backlog", label: "Backlog & draft", count: dagPlanningState.counts.backlog },
    { id: "execution", label: "Running & review", count: dagPlanningState.counts.execution },
    { id: "ready", label: "Ready next", count: dagPlanningState.counts.ready },
  ];
  const dagOrganizeSummary = useMemo(() => {
    if (dagOrganizeFeedback) return dagOrganizeFeedback;
    return "Run Auto Wire to rewrite sprint order, add inferred dependencies, and surface any cleanup suggestions that still need review.";
  }, [dagOrganizeFeedback]);
  const dagSelectedSprintLabel = useMemo(() => {
    if (dagSelectedSprint === "all") return "all sprints";
    return dagSprints.find((entry) => entry.id === dagSelectedSprint)?.label || dagSelectedSprint;
  }, [dagSelectedSprint, dagSprints]);

  const loadMoreKanbanTasks = useCallback(async () => {
    if (!isKanban || kanbanLoadingMore || isSearching) return;
    if (!hasMoreKanbanPages) return;
    setKanbanLoadingMore(true);
    if (tasksPage) tasksPage.value = page + 1;
    try {
      await loadTasks({ append: true, pageSize: KANBAN_PAGE_SIZE });
    } finally {
      setKanbanLoadingMore(false);
    }
  }, [hasMoreKanbanPages, isKanban, isSearching, kanbanLoadingMore, page]);

  const loadDagViews = useCallback(async () => {
    const sprintMeta = await fetchFirstAvailableDagPath(DAG_SPRINT_ENDPOINT_CANDIDATES);
    const sprintOptions = normalizeSprintOptions(sprintMeta?.payload);
    const resolvedSprint =
      dagSelectedSprint !== "all" && sprintOptions.some((entry) => entry.id === dagSelectedSprint)
        ? dagSelectedSprint
        : sprintOptions[0]?.id || "all";

    const sprintGraphCandidates = DAG_GRAPH_ENDPOINT_CANDIDATES.flatMap((basePath) =>
      buildSprintPathCandidates(basePath, resolvedSprint),
    );
    const globalGraphCandidates = DAG_GLOBAL_ENDPOINT_CANDIDATES.flatMap((basePath) =>
      buildSprintPathCandidates(basePath, resolvedSprint),
    );

    const sprintGraphMeta = await fetchFirstAvailableDagPath(sprintGraphCandidates);
    const globalGraphMeta = await fetchFirstAvailableDagPath(globalGraphCandidates);
    const epicDepsMeta = await fetchFirstAvailableDagPath(DAG_EPIC_DEPENDENCY_ENDPOINT_CANDIDATES);
    const tasksMeta = await fetchFirstAvailableDagPath(["/api/tasks?limit=1000", "/api/tasks?limit=500"]);

    const globalSource =
      extractGlobalDagPayload(
        globalGraphMeta?.payload,
        sprintGraphMeta?.payload,
        sprintMeta?.payload,
      ) || globalGraphMeta?.payload;

    const nextSprintGraph = normalizeDagGraph(
      sprintGraphMeta?.payload,
      resolvedSprint === "all" ? "All Sprint Task DAG" : `Sprint ${resolvedSprint} DAG`,
    );
    const nextGlobalGraph = normalizeDagGraph(globalSource, "DAG of DAGs");

    const allTasksPayload = extractDagPayload(tasksMeta?.payload);
    const allTasks = Array.isArray(allTasksPayload?.data)
      ? allTasksPayload.data
      : Array.isArray(allTasksPayload?.tasks)
        ? allTasksPayload.tasks
        : Array.isArray(allTasksPayload)
          ? allTasksPayload
          : tasks;
    const epicDeps = normalizeEpicDependenciesPayload(epicDepsMeta?.payload);
    const nextEpicGraph = buildEpicDagGraph(allTasks, epicDeps);
    setDagAllTasks(allTasks);
    setDagEpicDependencies(epicDeps);

    const sprintMetaEntry = sprintOptions.find((entry) => entry.id === resolvedSprint) || null;
    setDagSprintOrderMode(toText(sprintMetaEntry?.executionMode || sprintMetaEntry?.taskOrderMode || sprintMetaEntry?.sprintOrderMode || "parallel", "parallel"));
    setDagSprints(sprintOptions);
    setDagSprintGraph(nextSprintGraph);
    setDagGlobalGraph(nextGlobalGraph);
    setDagEpicGraph(nextEpicGraph);
    setDagSources({
      sprints: sprintMeta?.path || "",
      sprintGraph: sprintGraphMeta?.path || "",
      globalGraph: globalGraphMeta?.path || "",
      epicDeps: epicDepsMeta?.path || "",
      tasks: tasksMeta?.path || "",
    });

    if (resolvedSprint !== dagSelectedSprint) {
      setDagSelectedSprint(resolvedSprint);
    }

    const hasAnyGraphData =
      nextSprintGraph.nodes.length > 0 ||
      nextGlobalGraph.nodes.length > 0 ||
      nextEpicGraph.nodes.length > 0;
    if (!hasAnyGraphData) {
      throw new Error("No DAG data was returned from DAG endpoints.");
    }
  }, [dagSelectedSprint, tasks]);

  useEffect(() => {
    if (!isDag) return;
    let cancelled = false;

    const run = async () => {
      setDagLoading(true);
      setDagError("");
      try {
        await loadDagViews();
      } catch (error) {
        if (!cancelled) {
          setDagError(error?.message || "Failed to load DAG views.");
        }
      } finally {
        if (!cancelled) setDagLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [isDag, dagSelectedSprint, loadDagViews]);

  // Add/remove body class so kanban.css can apply height-bounded flex layout
  // to main-content, enabling per-column vertical scroll on mobile.
  useEffect(() => {
    document.body.classList.toggle("tasks-board-view", isKanban);
    return () => { document.body.classList.remove("tasks-board-view"); };
  }, [isKanban, isList]);

  useEffect(() => {
    if (filterVal && filterVal !== "done") {
      lastNonCompletedRef.current = filterVal;
    }
  }, [filterVal]);

  useEffect(() => {
    if (viewModeInitRef.current) return;
    if (isCompact) {
      viewMode.value = "list";
    }
    viewModeInitRef.current = true;
  }, [isCompact]);

  useEffect(() => {
    if (isKanban) return;
    listStateRef.current = {
      filter: filterVal,
      priority: priorityVal,
      sort: sortVal,
      page,
      pageSize,
    };
  }, [isList, filterVal, priorityVal, sortVal, page, pageSize]);

  useEffect(() => {
    let shouldReload = false;
    if (isKanban) {
      if (tasksFilter?.value !== "all") {
        tasksFilter.value = "all";
        shouldReload = true;
      }
      if (tasksPriority?.value) {
        tasksPriority.value = "";
        shouldReload = true;
      }
      if (tasksPage?.value !== 0) {
        tasksPage.value = 0;
        shouldReload = true;
      }
      if ((tasksPageSize?.value ?? 0) !== 25) {
        tasksPageSize.value = 25;
        shouldReload = true;
      }
    } else if (isList && listStateRef.current) {
      const next = listStateRef.current;
      if (tasksFilter?.value !== (next.filter ?? "all")) {
        tasksFilter.value = next.filter ?? "all";
        shouldReload = true;
      }
      if (tasksPriority?.value !== (next.priority ?? "")) {
        tasksPriority.value = next.priority ?? "";
        shouldReload = true;
      }
      if (tasksSort?.value !== (next.sort ?? "updated")) {
        tasksSort.value = next.sort ?? "updated";
        shouldReload = true;
      }
      if (tasksPage?.value !== (next.page ?? 0)) {
        tasksPage.value = next.page ?? 0;
        shouldReload = true;
      }
      if (tasksPageSize?.value !== (next.pageSize ?? 20)) {
        tasksPageSize.value = next.pageSize ?? 20;
        shouldReload = true;
      }
    }
    if (shouldReload) loadTasks();
  }, [isKanban, isList]);

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

  useEffect(() => {
    setDagOrganizeFeedback("");
    setDagOrganizeSuggestions([]);
  }, [dagSelectedSprint]);

  useEffect(() => {
    if (isCompact) {
      setFiltersOpen(false);
      setActionsOpen(false);
    }
  }, [isCompact]);


  useEffect(() => {
    if (!actionsOpen || typeof document === "undefined") return undefined;
    const handlePointerDown = (event) => {
      if (!actionsRef.current) return;
      if (!actionsRef.current.contains(event.target)) {
        setActionsOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  /* Search (local fuzzy filter on already-loaded data) */
  const searchLower = trimmedSearch.toLowerCase();
  const sharedTaskHierarchyModel = useMemo(
    () => buildTaskHierarchyModel(tasks, { subtasksByParentId: hierarchySubtasksByParentId }),
    [hierarchySubtasksByParentId, tasks],
  );
  const sharedTaskHierarchyView = useMemo(() => deriveTaskHierarchyView(sharedTaskHierarchyModel, {
    matchTask: (task) => !searchLower || buildTaskSearchDocument(task).includes(searchLower),
  }), [searchLower, sharedTaskHierarchyModel]);
  const visible = useMemo(
    () => flattenTaskHierarchyView(sharedTaskHierarchyView, { includeHidden: !searchLower }),
    [searchLower, sharedTaskHierarchyView],
  );

  const summaryMetrics = useMemo(() => {
    const counts = {
      backlog: 0,
      active: 0,
      review: 0,
      done: 0,
      blocked: 0,
      draft: 0,
    };
    for (const task of tasks) {
      const status = String(task?.status || "").toLowerCase();
      if (["inprogress", "in-progress", "working", "active", "assigned", "running"].includes(status)) {
        counts.active += 1;
      } else if (["inreview", "in-review", "review", "pr-open", "pr-review"].includes(status)) {
        counts.review += 1;
      } else if (["done", "completed", "closed", "merged", "cancelled"].includes(status)) {
        counts.done += 1;
      } else if (["error", "blocked", "failed"].includes(status)) {
        counts.blocked += 1;
      } else if (["draft"].includes(status)) {
        counts.draft += 1;
      } else {
        counts.backlog += 1;
      }
    }
    return [
      { label: "Backlog", value: counts.backlog, color: "var(--color-todo)" },
      { label: "Active", value: counts.active, color: "var(--color-inprogress)" },
      { label: "Review", value: counts.review, color: "var(--color-inreview)" },
      { label: "Done", value: counts.done, color: "var(--color-done)" },
      { label: "Blocked", value: counts.blocked, color: "var(--color-error)" },
    ];
  }, [tasks]);

  const sortHierarchyNodeStates = useCallback((items = []) => (
    [...items].sort((left, right) => {
      const sorted = compareTasksForHierarchicalList(left?.task, right?.task, listSortCol, listSortDir);
      if (sorted !== 0) return sorted;
      const leftOrder = sharedTaskHierarchyModel.originalOrderById.get(String(left?.id || left?.task?.id || "")) || 0;
      const rightOrder = sharedTaskHierarchyModel.originalOrderById.get(String(right?.id || right?.task?.id || "")) || 0;
      return leftOrder - rightOrder;
    })
  ), [listSortCol, listSortDir, sharedTaskHierarchyModel.originalOrderById]);

  const hierarchicalListRows = useMemo(() => buildHierarchicalTaskRows(
    sharedTaskHierarchyView.rootNodes,
    {
      collapsedState: collapsedHierarchyRows,
      hasSearch: Boolean(searchLower),
      sortChildren: sortHierarchyNodeStates,
    },
  ), [collapsedHierarchyRows, searchLower, sharedTaskHierarchyView.rootNodes, sortHierarchyNodeStates]);
  const listVisibleCount = hierarchicalListRows.length;

  const dagTaskFocusIds = useMemo(() => {
    if (dagFocusMode === "backlog") return dagPlanningState.backlogTaskIds;
    if (dagFocusMode === "ready") return dagPlanningState.readyTaskIds;
    if (dagFocusMode === "execution") return new Set([...dagPlanningState.executionTaskIds, ...dagPlanningState.readyTaskIds]);
    return "all";
  }, [dagFocusMode, dagPlanningState]);

  const dagSprintFocusIds = useMemo(() => {
    if (dagFocusMode === "backlog") return dagPlanningState.sprintIdsByFocus.backlog;
    if (dagFocusMode === "ready") return dagPlanningState.sprintIdsByFocus.ready;
    if (dagFocusMode === "execution") return new Set([...dagPlanningState.sprintIdsByFocus.execution, ...dagPlanningState.sprintIdsByFocus.ready]);
    return "all";
  }, [dagFocusMode, dagPlanningState]);

  const dagEpicFocusIds = useMemo(() => {
    if (dagFocusMode === "backlog") return dagPlanningState.epicIdsByFocus.backlog;
    if (dagFocusMode === "ready") return dagPlanningState.epicIdsByFocus.ready;
    if (dagFocusMode === "execution") return new Set([...dagPlanningState.epicIdsByFocus.execution, ...dagPlanningState.epicIdsByFocus.ready]);
    return "all";
  }, [dagFocusMode, dagPlanningState]);

  const dagSprintGraphView = useMemo(() => filterDagGraphByIds(dagSprintGraph, dagTaskFocusIds, (node) => toText(node?.taskId || node?.id)), [dagSprintGraph, dagTaskFocusIds]);
  const dagGlobalGraphView = useMemo(() => filterDagGraphByIds(dagGlobalGraph, dagSprintFocusIds, (node) => toText(node?.sprintId || node?.id)), [dagGlobalGraph, dagSprintFocusIds]);
  const dagEpicGraphView = useMemo(() => filterDagGraphByIds(dagEpicGraph, dagEpicFocusIds, (node) => toText(node?.epicId || node?.id)), [dagEpicGraph, dagEpicFocusIds]);
  const dagReadyHighlightIds = dagFocusMode === "execution" || dagFocusMode === "ready" ? dagPlanningState.readyTaskIds : null;

  /* ── Handlers ── */
  const handleFilter = async (s) => {
    haptic();
    if (tasksFilter) tasksFilter.value = s;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  const toggleCompletedFilter = async () => {
    const next = completedOnly
      ? lastNonCompletedRef.current || "all"
      : "done";
    await handleFilter(next);
  };

  const handleCompletedToggle = async (next) => {
    if (next === completedOnly) return;
    await toggleCompletedFilter();
  };

  const handlePriorityFilter = async (p) => {
    haptic();
    if (tasksPriority) tasksPriority.value = p;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  const handleSort = async (e) => {
    haptic();
    if (tasksSort) tasksSort.value = e.target.value;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  /* Server-side search: debounce 300ms then reload from server */
  const triggerServerSearch = useCallback(
    debounce(async () => {
      if (tasksPage) tasksPage.value = 0;
      setIsSearching(true);
      try { await loadTasks(); } finally { setIsSearching(false); }
    }, 300),
    [],
  );

  const handleSearch = useCallback(
    (val) => {
      if (tasksSearch) tasksSearch.value = val;
      triggerServerSearch();
    },
    [triggerServerSearch],
  );

  const handleClearSearch = useCallback(() => {
    if (tasksSearch) tasksSearch.value = "";
    triggerServerSearch.cancel();
    if (tasksPage) tasksPage.value = 0;
    setIsSearching(false);
    loadTasks();
  }, [triggerServerSearch]);

  const handleClearFilters = useCallback(async () => {
    haptic();
    if (tasksFilter) tasksFilter.value = "all";
    if (tasksPriority) tasksPriority.value = "";
    if (tasksSort) tasksSort.value = "updated";
    if (tasksSearch) tasksSearch.value = "";
    if (tasksPage) tasksPage.value = 0;
    triggerServerSearch.cancel();
    setIsSearching(false);
    await refreshTab("tasks");
  }, [triggerServerSearch]);

  const toggleHierarchyRow = useCallback((collapseKey) => {
    if (!collapseKey) return;
    setCollapsedHierarchyRows((prev) => ({
      ...prev,
      [collapseKey]: !prev[collapseKey],
    }));
  }, []);

  const handleQuickCreateChildTask = useCallback((task) => {
    if (!task?.id) return;
    haptic();
    setCreateSeed({
      taskType: "subtask",
      parentTaskId: task.id,
      epicId: toText(task?.epicId || task?.meta?.epicId),
      sprintId: getTaskSprintId(task),
      draft: true,
    });
    setShowCreate(true);
  }, []);

  const handleInlineListStatusChange = useCallback(async (task, nextStatus) => {
    if (!task?.id || !nextStatus || normalizeTaskStatusValue(task?.status) === normalizeTaskStatusValue(nextStatus)) return;
    await applyTaskLifecycleTransition(task, nextStatus);
  }, []);

  const handleToggleFilters = useCallback(() => {
    haptic();
    setFiltersOpen((open) => !open);
  }, []);

  const handleRefreshDag = useCallback(async () => {
    haptic("medium");
    setDagLoading(true);
    setDagError("");
    try {
      await loadDagViews();
      showToast("DAG data refreshed", "success");
    } catch (error) {
      setDagError(error?.message || "Failed to refresh DAG views.");
    } finally {
      setDagLoading(false);
    }
  }, [loadDagViews]);

  const handleAutoOrganizeDag = useCallback(async () => {
    haptic("medium");
    setDagLoading(true);
    setDagError("");
    try {
      const result = await apiFetch("/api/tasks/dag/organize", {
        method: "POST",
        body: JSON.stringify(dagSelectedSprint && dagSelectedSprint !== "all"
          ? { sprintId: dagSelectedSprint, applyDependencySuggestions: true, syncEpicDependencies: true }
          : { applyDependencySuggestions: true, syncEpicDependencies: true }),
      });
      const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
      const appliedDependencySuggestionCount = Number(result?.data?.appliedDependencySuggestionCount || 0);
      const syncedEpicDependencyCount = Number(result?.data?.syncedEpicDependencyCount || 0);
      const updatedTaskCount = Number(result?.data?.updatedTaskCount || 0);
      const updatedSprintCount = Number(result?.data?.updatedSprintCount || 0);
      setDagOrganizeSuggestions(suggestions);
      setDagOrganizeFeedback(
        [
          `Auto-wired ${dagSelectedSprintLabel}.`,
          updatedSprintCount > 0 ? `${updatedSprintCount} sprint order update${updatedSprintCount === 1 ? "" : "s"}.` : "",
          updatedTaskCount > 0 ? `${updatedTaskCount} task order update${updatedTaskCount === 1 ? "" : "s"}.` : "",
          appliedDependencySuggestionCount > 0 ? `${appliedDependencySuggestionCount} dependency edge${appliedDependencySuggestionCount === 1 ? "" : "s"} added.` : "",
          syncedEpicDependencyCount > 0 ? `${syncedEpicDependencyCount} epic dependency set${syncedEpicDependencyCount === 1 ? "" : "s"} synced.` : "",
          suggestions.length > 0 ? `${suggestions.length} cleanup suggestion${suggestions.length === 1 ? "" : "s"} still need review.` : "No follow-up cleanup suggestions.",
        ].filter(Boolean).join(" "),
      );
      showToast(
        appliedDependencySuggestionCount > 0 || syncedEpicDependencyCount > 0
          ? `Auto-wired DAG · ${appliedDependencySuggestionCount + syncedEpicDependencyCount} dependency update${appliedDependencySuggestionCount + syncedEpicDependencyCount === 1 ? "" : "s"}`
          : suggestions.length > 0
            ? `DAG organized · ${suggestions.length} suggestions`
            : "DAG organized",
        "success",
      );
      await loadDagViews();
    } catch (error) {
      setDagError(error?.message || "Failed to organize DAG.");
    } finally {
      setDagLoading(false);
    }
  }, [dagSelectedSprint, dagSelectedSprintLabel, loadDagViews]);

  const handleCreateSprint = useCallback(() => {
    haptic("medium");
    setEditingSprint(null);
    setShowCreateSprint(true);
  }, []);

  const handleEditSprint = useCallback((sprint) => {
    haptic("medium");
    setEditingSprint(sprint || null);
    setShowCreateSprint(true);
  }, []);

  const handleMoveSprint = useCallback(async (sprintId, direction) => {
    const currentIndex = dagSprints.findIndex((entry) => entry.id === sprintId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= dagSprints.length) return;
    const reordered = [...dagSprints];
    const [moved] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    haptic("medium");
    try {
      await Promise.all(reordered.map((entry, index) => apiFetch(`/api/tasks/sprints/${encodeURIComponent(entry.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ order: index + 1 }),
      })));
      showToast("Sprint order updated", "success");
      await loadDagViews();
    } catch {
      setDagError("Failed to reorder sprints.");
    }
  }, [dagSprints, loadDagViews]);

  const handleDagSprintModeChange = useCallback(async (mode) => {
    const nextMode = toText(mode, "parallel").toLowerCase();
    if (!dagSelectedSprint || dagSelectedSprint === "all") {
      showToast("Select a sprint before changing execution mode", "warning");
      return;
    }
    if (nextMode !== "parallel" && nextMode !== "sequential") return;
    setDagSprintOrderMode(nextMode);
    haptic("medium");
    try {
      await apiFetch(`/api/tasks/sprints/${encodeURIComponent(dagSelectedSprint)}`, {
        method: "PATCH",
        body: JSON.stringify({ executionMode: nextMode, taskOrderMode: nextMode, sprintOrderMode: nextMode }),
      });
      showToast("Sprint execution mode updated", "success");
      await loadDagViews();
    } catch {
      setDagError("Failed to update sprint execution mode.");
    }
  }, [dagSelectedSprint, loadDagViews]);

  const persistSprintTaskOrder = useCallback(async (sprintId, orderedTasks) => {
    await Promise.all(orderedTasks.map((entry, index) => apiFetch(
      "/api/tasks/sprints/" + encodeURIComponent(sprintId) + "/tasks",
      {
        method: "POST",
        body: JSON.stringify({ taskId: entry.id, sprintOrder: index + 1 }),
      },
    )));
  }, []);

  const handleNudgeSprintTaskOrder = useCallback(async (taskId, delta) => {
    const task = dagTaskCatalog.find((entry) => toText(entry?.id) === toText(taskId));
    const sprintId = toText(getTaskSprintId(task));
    if (!task?.id || !sprintId) return;
    const sprintQueue = dagSprintQueue
      .filter((entry) => toText(getTaskSprintId(entry)) === sprintId)
      .sort((left, right) => {
        const leftOrder = Number(getTaskSprintOrder(left) || Number.MAX_SAFE_INTEGER);
        const rightOrder = Number(getTaskSprintOrder(right) || Number.MAX_SAFE_INTEGER);
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return String(left?.title || left?.id || "").localeCompare(String(right?.title || right?.id || ""));
      });
    const currentIndex = sprintQueue.findIndex((entry) => toText(entry?.id) === toText(taskId));
    const nextIndex = currentIndex + delta;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sprintQueue.length) return;
    const reordered = [...sprintQueue];
    const [movedTask] = reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, movedTask);
    try {
      await persistSprintTaskOrder(sprintId, reordered);
      showToast("Sprint queue reordered", "success");
      await loadDagViews();
    } catch {
      setDagError("Failed to update sprint task order.");
    }
  }, [dagSprintQueue, dagTaskCatalog, loadDagViews, persistSprintTaskOrder]);

  const handleCreateDagEdge = useCallback(async ({ sourceNode, targetNode, graphKind }) => {
    const srcTaskId = toText(sourceNode?.taskId || sourceNode?.id);
    const dstTaskId = toText(targetNode?.taskId || targetNode?.id);

    if (graphKind === "epic") {
      const srcEpic = toText(sourceNode?.epicId || sourceNode?.id);
      const dstEpic = toText(targetNode?.epicId || targetNode?.id);
      if (!srcEpic || !dstEpic || srcEpic === dstEpic) return;
      const existing = normalizeDependencyInput(targetNode?.dependencies || []);
      const dependencies = normalizeDependencyInput([...existing, srcEpic]);
      await apiFetch("/api/tasks/epic-dependencies", {
        method: "PUT",
        body: JSON.stringify({ epicId: dstEpic, dependencies }),
      });
      showToast(`Wired epic dependency: ${srcEpic} -> ${dstEpic}`, "success");
      await loadDagViews();
      return;
    }

    if (!srcTaskId || !dstTaskId || srcTaskId === dstTaskId) return;
    const existing = normalizeDependencyInput(
      targetNode?.dependencies ||
      targetNode?.dependencyTaskIds ||
      [],
    );
    const dependencies = normalizeDependencyInput([...existing, srcTaskId]);
    await apiFetch("/api/tasks/dependencies", {
      method: "PUT",
      body: JSON.stringify({
        taskId: dstTaskId,
        dependencies,
      }),
    });
    showToast(`Wired dependency: ${srcTaskId} -> ${dstTaskId}`, "success");
    await loadDagViews();
  }, [loadDagViews]);

  const handleApplyDagSuggestion = useCallback(async (entry) => {
    const suggestionType = toText(entry?.type);
    if (suggestionType !== "missing_sequential_dependency") return;

    const dependencyTaskId = toText(entry?.dependencyTaskId);
    const taskId = toText(entry?.taskId);
    if (!dependencyTaskId || !taskId || dependencyTaskId === taskId) return;

    haptic("medium");
    setDagLoading(true);
    setDagError("");
    try {
      const task = dagTaskCatalog.find((candidate) => toText(candidate?.id) === taskId);
      const existing = normalizeDependencyInput(getTaskDependencyIds(task));
      if (existing.includes(dependencyTaskId)) {
        setDagOrganizeSuggestions((current) => current.filter((candidate) => !(
          toText(candidate?.type) === suggestionType &&
          toText(candidate?.taskId) === taskId &&
          toText(candidate?.dependencyTaskId) === dependencyTaskId
        )));
        setDagOrganizeFeedback(`Dependency ${dependencyTaskId} -> ${taskId} is already present.`);
        showToast("Dependency already exists", "info");
        return;
      }

      await apiFetch("/api/tasks/dependencies", {
        method: "PUT",
        body: JSON.stringify({
          taskId,
          dependencies: normalizeDependencyInput([...existing, dependencyTaskId]),
        }),
      });

      setDagOrganizeSuggestions((current) => current.filter((candidate) => !(
        toText(candidate?.type) === suggestionType &&
        toText(candidate?.taskId) === taskId &&
        toText(candidate?.dependencyTaskId) === dependencyTaskId
      )));
      setDagOrganizeFeedback(`Applied sequential dependency ${dependencyTaskId} -> ${taskId}.`);
      showToast(`Applied dependency: ${dependencyTaskId} -> ${taskId}`, "success");
      await loadDagViews();
    } catch (error) {
      setDagError(error?.message || "Failed to apply organizer suggestion.");
    } finally {
      setDagLoading(false);
    }
  }, [dagTaskCatalog, loadDagViews]);

  const handleDeleteDagEdge = useCallback(async ({ sourceId, targetId, graphKind }) => {
    const srcId = toText(sourceId);
    const dstId = toText(targetId);
    if (!srcId || !dstId || srcId === dstId) return;

    if (graphKind === "epic") {
      const epic = dagEpicCatalog.find((entry) => toText(entry?.id) === dstId);
      const remaining = normalizeDependencyInput((epic?.dependencies || []).filter((id) => id !== srcId));
      await apiFetch("/api/tasks/epic-dependencies", {
        method: "PUT",
        body: JSON.stringify({ epicId: dstId, dependencies: remaining }),
      });
      showToast(`Removed epic dependency: ${srcId} -> ${dstId}`, "success");
      await loadDagViews();
      return;
    }

    const task = dagTaskCatalog.find((entry) => toText(entry?.id) === dstId);
    const remaining = normalizeDependencyInput(getTaskDependencyIds(task).filter((id) => id !== srcId));
    await apiFetch("/api/tasks/dependencies", {
      method: "PUT",
      body: JSON.stringify({ taskId: dstId, dependencies: remaining }),
    });
    showToast(`Removed dependency: ${srcId} -> ${dstId}`, "success");
    await loadDagViews();
  }, [dagEpicCatalog, dagTaskCatalog, loadDagViews]);

  const handleSprintChange = useCallback((nextSprint) => {
    const sprintId = toText(nextSprint, "all");
    if (sprintId === dagSelectedSprint) return;
    haptic();
    setDagSelectedSprint(sprintId);
  }, [dagSelectedSprint]);

  const handlePrev = async () => {
    if (tasksPage) tasksPage.value = Math.max(0, page - 1);
    await refreshTab("tasks");
  };

  const handleNext = async () => {
    if (tasksPage) tasksPage.value = page + 1;
    await refreshTab("tasks");
  };

  const handleStatusUpdate = async (taskId, newStatus) => {
    haptic("medium");
    const currentTask = (tasksData.value || []).find((row) => String(row?.id) === String(taskId));
    if (!currentTask) return;

    try {
      const result = await applyTaskLifecycleTransition(currentTask, newStatus);
      if (!result?.ok || result?.cancelled) return;
      if (result.status === "inreview") {
        const nextTask = (tasksData.value || []).find((row) => String(row?.id) === String(taskId));
        await reactivateTaskSession(taskId, {
          askFirst: true,
          title: nextTask?.title || taskId,
        }).catch(() => {});
      }
    } catch {
      /* toast */
    }
  };
  const startTask = async ({ taskId, sdk, model }) => {
    haptic("medium");
    let res = null;
    try {
      res = await apiFetch("/api/tasks/start", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          ...(sdk ? { sdk } : {}),
          ...(model ? { model } : {}),
        }),
      });
    } catch {
      return;
    }

    if (res?.queued) {
      showToast("Task queued (waiting for free slot)", "info");
    } else if (res?.wasPaused) {
      showToast("Task started (executor paused — force-dispatched)", "warning");
    } else if (res) {
      showToast("Task started", "success");
    }
    scheduleRefresh(150);
  };

  const openStartModal = (task) => {
    haptic("medium");
    setStartTarget(task);
  };

  const openDetail = async (taskId) => {
    haptic();
    const local = tasks.find((t) => t.id === taskId);
    const requestId = ++detailRequestIdRef.current;
    setDetailTask(local || { id: taskId, title: taskId, status: "todo", description: "" });
    setDetailTaskHydrating(true);
    const result = await apiFetch(
      buildTaskDetailPath(taskId, {
        includeDag: false,
        includeWorkflowRuns: false,
      }),
      { _silent: true },
    ).catch(() => ({ data: local }));
    if (detailRequestIdRef.current !== requestId) return;
    setDetailTask((prev) => ({ ...(prev || {}), ...(result.data || local || {}) }));
    setDetailTaskHydrating(false);
  };

  /* ── Batch operations ── */
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBatchDone = async () => {
    if (!selectedIds.size) return;
    const ok = await showConfirm(`Mark ${selectedIds.size} tasks as done?`);
    if (!ok) return;
    haptic("medium");
    for (const id of selectedIds) {
      await handleStatusUpdate(id, "done");
    }
    setSelectedIds(new Set());
    setBatchMode(false);
    scheduleRefresh(150);
  };

  const handleBatchCancel = async () => {
    if (!selectedIds.size) return;
    const ok = await showConfirm(`Cancel ${selectedIds.size} tasks?`);
    if (!ok) return;
    haptic("medium");
    for (const id of selectedIds) {
      await handleStatusUpdate(id, "cancelled");
    }
    setSelectedIds(new Set());
    setBatchMode(false);
    scheduleRefresh(150);
  };

  /* ── Export handlers ── */
  const handleExportCSV = async () => {
    setExporting(true);
    setActionsOpen(false);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks?limit=1000", { _silent: true });
      const allTasks = res?.data || res?.tasks || tasks;
      const headers = [
        "ID",
        "Title",
        "Status",
        "Priority",
        "Base Branch",
        "Tags",
        "Draft",
        "Created",
        "Updated",
        "Description",
      ];
      const rows = allTasks.map((t) => [
        t.id || "",
        t.title || "",
        t.status || "",
        t.priority || "",
        getTaskBaseBranch(t),
        getTaskTags(t).join(", "),
        t.draft || t.status === "draft" ? "true" : "false",
        t.created_at || "",
        t.updated_at || "",
        truncate(t.description || "", 200),
      ]);
      const date = new Date().toISOString().slice(0, 10);
      exportAsCSV(headers, rows, `tasks-${date}.csv`);
      showToast(`Exported ${allTasks.length} tasks`, "success");
    } catch {
      showToast("Export failed", "error");
    }
    setExporting(false);
  };

  const handleExportJSON = async () => {
    setExporting(true);
    setActionsOpen(false);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/export", { _silent: true });
      const payload = res?.data || {};
      const date = new Date().toISOString().slice(0, 10);
      exportAsJSON(payload, `tasks-state-${date}.json`);
      showToast(`Exported ${(payload?.tasks || []).length} tasks`, "success");
    } catch {
      showToast("Export failed", "error");
    }
    setExporting(false);
  };

  const handleImportTaskStateClick = () => {
    setActionsOpen(false);
    haptic("medium");
    importInputRef.current?.click?.();
  };

  const handleImportTaskStateFile = async (event) => {
    const file = event?.target?.files?.[0] || null;
    if (!file) return;
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      const taskList = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.tasks)
          ? parsed.tasks
          : Array.isArray(parsed?.backlog)
            ? parsed.backlog
            : Array.isArray(parsed?.data?.tasks)
              ? parsed.data.tasks
              : null;
      if (!Array.isArray(taskList)) {
        throw new Error("JSON must contain an array of tasks");
      }

      const ok = await showConfirm(
        `Import ${taskList.length} tasks from ${file.name}? Existing task IDs will be merged and missing tasks will be created.`,
      );
      if (!ok) return;

      setImporting(true);
      const payload = Array.isArray(parsed)
        ? { tasks: parsed, mode: "merge", source: { filename: file.name } }
        : {
            ...parsed,
            tasks: taskList,
            mode: "merge",
            source: {
              ...(parsed?.source && typeof parsed.source === "object" ? parsed.source : {}),
              filename: file.name,
            },
          };
      const res = await apiFetch("/api/tasks/import", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const summary = res?.data?.summary || {};
      const changedCount = Number(summary.created || 0) + Number(summary.updated || 0);
      showToast(
        `Imported ${Number(summary.created || 0)} new and updated ${Number(summary.updated || 0)} task${changedCount === 1 ? "" : "s"}${summary.failed ? ` (${summary.failed} failed)` : ""}`,
        summary.failed ? "warning" : "success",
      );
      scheduleRefresh(150);
    } catch (err) {
      showToast(err?.message || "Import failed", "error");
    } finally {
      setImporting(false);
      if (event?.target) {
        event.target.value = "";
      }
    }
  };

  /* ── Render ── */
  const showBatchBar = isList && batchMode && selectedIds.size > 0;

  if (!isDag && !tasksLoaded.value && !tasks.length && !searchVal)
    return html`<${Card} title="Loading Tasks…"><${SkeletonCard} /><//>`;

  if (!isDag && tasksLoaded.value && !tasks.length && !searchVal)
    return html`
      <div class="flex-between mb-sm" style="padding:0 4px">
        <${ToggleButtonGroup} size="small" exclusive value=${isDag ? 'dag' : (isKanban ? 'kanban' : 'list')}>
          <${ToggleButton} value="list" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText(":menu: List")}<//>
          <${ToggleButton} value="kanban" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board<//>
          <${ToggleButton} value="dag" onClick=${() => { viewMode.value = 'dag'; haptic(); }}>⛓ DAG<//>
        <//>
        <div style="display:flex;gap:8px;align-items:center;">
          <${Button}
            variant="text" size="small"
            onClick=${() => {
              haptic();
              setShowTemplates(true);
            }}
          >${iconText(":zap: Templates")}<//>
          <${Button}
            variant="text" size="small"
            onClick=${toggleCompletedFilter}
          >
            ${completedOnly ? "Show All" : "Show Completed"}
          <//>
        </div>
      </div>
      ${hasActiveSlots &&
      html`
        <${Card} title="Active Slots">
          ${activeSlots.map(
            (slot) => html`
              <div key=${slot.taskId} class="list-item">
                <div class="list-item-content">
                  <div class="list-item-title">
                    ${truncate(slot.taskTitle || "(untitled)", 50)}
                  </div>
                  <div class="meta-text">
                    ${slot.taskId} · ${slot.branch || "no branch"}
                  </div>
                </div>
                <${Badge} status="inprogress" text="running" />
              </div>
            `,
          )}
        <//>
      `}
      ${!hasActiveSlots &&
      html`
        <${EmptyState}
          message="No tasks yet"
          description="Create a task to start orchestrating agents."
          icon="clipboard"
          action=${{
            label: "Create Task",
            onClick: () => {
              haptic();
              setShowCreate(true);
            },
          }}
        />
      `}
      <${Fab} color="primary" size="small" onClick=${() => { haptic(); setShowCreate(true); }}>${ICONS.plus}<//>
      ${showCreate && html`<${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />`}
    `;

  const filterButton = html`
    <${Button}
      className=${`filter-toggle tasks-filter-btn ${filtersOpen || activeFilterCount > 0 ? "active" : ""}`}
      variant="outlined" size="small"
      onClick=${handleToggleFilters}
      aria-expanded=${filtersOpen}
    >
      ${ICONS.filter}
      Filters
      ${activeFilterCount > 0 && html`
        <span class="filter-count">${activeFilterCount}</span>
      `}
    <//>
  `;

  const viewToggle = html`
    <${ToggleButtonGroup} className="view-toggle tasks-view-toggle" size="small" exclusive value=${isDag ? 'dag' : (isKanban ? 'kanban' : 'list')}>
      <${ToggleButton} value="list" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText(":menu: List")}<//>
      <${ToggleButton} value="kanban" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board<//>
      <${ToggleButton} value="dag" onClick=${() => { viewMode.value = 'dag'; haptic(); }}>⛓ DAG<//>
    <//>
  `;

  const dagSprintPicker = isDag && html`
    <div class="tasks-toolbar-group" style=${{ minWidth: isCompact ? "130px" : "180px" }}>
      <${Select}
        size="small"
        value=${dagSelectedSprint}
        onChange=${(event) => handleSprintChange(event.target.value)}
        disabled=${dagLoading}
        style=${{ minWidth: "100%" }}
      >
        <${MenuItem} value="all">All sprints</${MenuItem}>
        ${dagSprints.map((sprint) => html`
          <${MenuItem} key=${sprint.id} value=${sprint.id}>${sprint.label}</${MenuItem}>
        `)}
      </${Select}>
    </div>
  `;

  const newButton = html`
    <${Button}
      className="tasks-new-btn"
      variant="contained" size="small"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
      aria-label="Create task"
    >
      ${ICONS.plus}
      ${isCompact ? "New" : "New Task"}
    <//>
  `;

  const actionsMenu = html`
    <div class="actions-wrap" ref=${actionsRef}>
      <${Button}
        className="actions-btn tasks-actions-btn"
        variant="text" size="small"
        onClick=${() => { setActionsOpen(!actionsOpen); haptic(); }}
        aria-haspopup="menu"
        aria-expanded=${actionsOpen}
        disabled=${exporting || importing}
      >
        ${ICONS.ellipsis}
        <span class="actions-label">Actions</span>
      <//>
      ${actionsOpen && html`
        <div class="actions-dropdown" role="menu">
          <${MenuItem}
            onClick=${() => { setActionsOpen(false); setStartAnyOpen(true); }}
          >
            ${iconText(":play: Start Task")}
          <//>
          <${MenuItem}
            onClick=${() => { setActionsOpen(false); setShowTemplates(true); }}
          >
            ${iconText(":zap: Trigger Templates")}
          <//>
          <${MenuItem} onClick=${handleExportCSV}>${iconText(":chart: Export CSV")}<//>
          <${MenuItem} onClick=${handleExportJSON}>${iconText(":clipboard: Export Task State JSON")}<//>
          <${MenuItem} onClick=${handleImportTaskStateClick}>${iconText(":inbox_tray: Import Task State JSON")}<//>
        </div>
      `}
    </div>
  `;

  return html`
    <div class="sticky-search">
      <input
        ref=${importInputRef}
        type="file"
        accept="application/json,.json"
        style=${{ display: "none" }}
        onChange=${handleImportTaskStateFile}
      />
      <div class="tasks-toolbar">
        <div class="tasks-toolbar-row">
          <div class="sticky-search-main">
          <${SearchInput}
            inputRef=${searchRef}
            placeholder="Search title, ID, or tag…"
            value=${searchVal}
            onInput=${(e) => handleSearch(e.target.value)}
            onClear=${handleClearSearch}
          />
          ${showKbdHint && !searchVal && html`<span class="pill" style="font-size:10px;padding:2px 7px;opacity:0.55;white-space:nowrap;pointer-events:none">${isMac ? "⌘K" : "Ctrl+K"}</span>`}
          ${isSearching && html`<span class="pill" style="font-size:10px;padding:2px 7px;color:var(--accent);white-space:nowrap">Searching…</span>`}
          ${!isSearching && searchVal && html`<span class="pill" style="font-size:10px;padding:2px 7px;white-space:nowrap">${isList ? listVisibleCount : visible.length} result${(isList ? listVisibleCount : visible.length) !== 1 ? "s" : ""}</span>`}
          </div>
          <div class=${`tasks-toolbar-actions ${isCompact ? "compact" : ""}`}>
            ${isCompact
              ? html`
                  <div class="tasks-toolbar-group tasks-toolbar-group--primary">
                    ${filterButton}
                    ${viewToggle}
                    ${dagSprintPicker}
                  </div>
                  <div class="tasks-toolbar-group tasks-toolbar-group--secondary">
                    ${newButton}
                    ${actionsMenu}
                  </div>
                `
              : html`
                  ${filterButton}
                  ${viewToggle}
                    ${dagSprintPicker}
                  ${newButton}
                  <${Button}
                    variant="text" size="small"
                    onClick=${() => {
                      haptic();
                      setStartAnyOpen(true);
                    }}
                  >
                    ${iconText(":play: Start Task")}
                  <//>
                  ${actionsMenu}
                `}
          </div>
        </div>

        <div class="tasks-filter-panel ${filtersOpen ? "open" : ""}">
          <div class="tasks-filter-grid">
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Status</div>
                <div class="chip-group">
                  ${STATUS_CHIPS.map(
                    (s) => html`
                      <${Chip}
                        key=${s.value}
                        label=${s.label}
                        variant=${filterVal === s.value ? "filled" : "outlined"}
                        color=${filterVal === s.value ? "primary" : "default"}
                        size="small"
                        onClick=${() => handleFilter(s.value)}
                      />
                    `,
                  )}
                </div>
              </div>
            `}
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Priority</div>
                <div class="chip-group">
                  ${PRIORITY_CHIPS.map(
                    (p) => html`
                      <${Chip}
                        key=${p.value}
                        label=${p.label}
                        variant=${priorityVal === p.value ? "filled" : "outlined"}
                        color=${priorityVal === p.value ? "primary" : "default"}
                        size="small"
                        onClick=${() => handlePriorityFilter(p.value)}
                      />
                    `,
                  )}
                </div>
              </div>
            `}
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Sort</div>
              <div class="tasks-filter-row">
                <${Select}
                  size="small"
                  value=${sortVal}
                  onChange=${handleSort}
                >
                  ${SORT_OPTIONS.map(
                    (o) =>
                      html`<${MenuItem} key=${o.value} value=${o.value}>${o.label}</${MenuItem}>`,
                  )}
                </${Select}>
                <span class="pill"><span class="numeral">${isList ? listVisibleCount : visible.length}</span> shown</span>
              </div>
            </div>
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Actions</div>
              <div class="tasks-filter-row">
                ${isList && (isCompact
                  ? html`
                      <${Toggle}
                        label="Completed only"
                        checked=${completedOnly}
                        onChange=${handleCompletedToggle}
                      />
                    `
                  : html`
                      <${Button}
                        variant="text" size="small"
                        onClick=${toggleCompletedFilter}
                      >
                        ${completedOnly ? "Show All" : "Show Completed"}
                      <//>
                    `)}
                ${hasActiveFilters &&
                html`
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleClearFilters}
                  >
                    Clear Filters
                  <//>
                `}
              </div>
            </div>
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">List Options</div>
                <label
                  class="meta-text toggle-label"
                  onClick=${() => {
                    setBatchMode(!batchMode);
                    haptic();
                    setSelectedIds(new Set());
                  }}
                >
                  <${Switch} size="small" checked=${batchMode} />
                  Batch Select
                </label>
              </div>
            `}
            ${isKanban && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Board View</div>
                <div class="meta-text">
                  Board view shows every status in one place. Switch to List to filter by status or priority.
                </div>
              </div>
            `}
            ${isDag && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">DAG View</div>
                <div class="meta-text">
                  Sprint DAG = selected sprint execution plan. Global DAG = cross-sprint dependencies.
                </div>
                <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
                  <${Select}
                    size="small"
                    value=${dagSprintOrderMode}
                    disabled=${dagLoading || dagSelectedSprint === "all"}
                    onChange=${(e) => handleDagSprintModeChange(e.target.value)}
                  >
                    <${MenuItem} value="parallel">Mode: parallel</${MenuItem}>
                    <${MenuItem} value="sequential">Mode: sequential</${MenuItem}>
                  </${Select}>
                </div>
                <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleRefreshDag}
                    disabled=${dagLoading}
                  >
                    ${dagLoading ? "Refreshing…" : "Refresh DAG"}
                  <//>
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleAutoOrganizeDag}
                    disabled=${dagLoading}
                  >
                    Auto Wire
                  <//>
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleCreateSprint}
                    disabled=${dagLoading}
                  >
                    + New Sprint
                  <//>
                </div>
                <div class="task-dag-legend" style=${{ marginTop: "8px" }}>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line" style=${{ background: "var(--accent)" }}></span>depends-on</span>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-dashed"></span>sequential</span>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-block"></span>blocks</span>
                </div>
                ${(dagSources.sprintGraph || dagSources.globalGraph) && html`
                  <div class="meta-text" style=${{ marginTop: "6px" }}>
                    Source: ${dagSources.sprintGraph || dagSources.globalGraph}
                  </div>
                `}
              </div>
            `}
          </div>
        </div>
      </div>
      ${isList && hasActiveFilters && (!isCompact || filtersOpen) && html`
        <div class="filter-summary">
          <div class="filter-summary-text">
            <span class="pill">Filters</span>
            <span>${filterSummary}</span>
          </div>
          <div class="filter-summary-actions">
            <${Button} variant="text" size="small" onClick=${handleClearFilters}>
              Clear Filters
            <//>
          </div>
        </div>
      `}
      ${showBatchBar &&
      html`
        <div class="btn-row batch-action-bar">
          <span class="pill">${selectedIds.size} selected</span>
          <${Button} variant="contained" size="small" onClick=${handleBatchDone}>
            ${iconText("✓ Done All")}
          <//>
          <${Button} variant="contained" color="error" size="small" onClick=${handleBatchCancel}>
            ${iconText("✕ Cancel All")}
          <//>
          <${Button}
            variant="text" size="small"
            onClick=${() => {
              setSelectedIds(new Set());
              haptic();
            }}
          >
            Clear
          <//>
        </div>
      `}
    </div>

    ${!isDag && html`
      <div class="snapshot-bar">
        ${summaryMetrics.map((m) => html`
          <${Tooltip} title=${isKanban ? m.label : `Filter by ${m.label}`}><${Button}
            key=${m.label}
            variant="text" size="small"
            style=${{ textTransform: "none" }}
            onClick=${() => {
              if (!isList) return;
              const statusVal = SNAPSHOT_STATUS_MAP[m.label];
              if (statusVal !== undefined) handleFilter(filterVal === statusVal ? 'all' : statusVal);
            }}
          >
            <span class="snapshot-dot" style="background:${m.color};" />
            <strong class="snapshot-val numeral">${m.value}</strong>
            <span class="snapshot-lbl">${m.label}</span>
          <//><//>
        `)}
        <span class="snapshot-view-tag">${iconText(isKanban ? ":dot: Board" : ":menu: List")}</span>
      </div>
    `}

    ${isDag && html`
      <div class="snapshot-bar snapshot-bar-dag">
        <span class="snapshot-view-tag">${iconText(":link: DAG")}</span>
        ${dagFocusOptions.map((option) => html`
          <button
            type="button"
            class=${`snapshot-pill-btn ${dagFocusMode === option.id ? "snapshot-pill-active" : ""}`}
            onClick=${() => setDagFocusMode(option.id)}
          >
            ${option.label} · <span class="numeral">${option.count}</span>
          </button>
        `)}
        <span class="pill">Sprint nodes: <span class="numeral">${dagSprintGraphView.nodes.length}</span></span>
        <span class="pill">Global nodes: <span class="numeral">${dagGlobalGraphView.nodes.length}</span></span>
        <span class="pill">Epic nodes: <span class="numeral">${dagEpicGraphView.nodes.length}</span></span>
      </div>
    `}

    <style>
      .actions-btn { display:inline-flex; align-items:center; gap:4px; }
      .actions-dropdown {
        position:absolute; right:0; top:100%; margin-top:4px; z-index:100;
        background:var(--card-bg, #1e1e2e); border:1px solid var(--border, #333);
        border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,.3); overflow:hidden;
        min-width:160px;
      }
      .actions-dropdown-item {
        display:block; width:100%; padding:10px 14px; border:none;
        background:none; color:inherit; text-align:left; font-size:13px;
        cursor:pointer;
      }
      .actions-dropdown-item:hover { background:var(--hover-bg, rgba(255,255,255,.08)); }
      .snapshot-pill-btn {
        background: none;
        border: 1px solid transparent;
        border-radius: 999px;
        cursor: pointer;
        padding: 2px 8px;
        transition: border-color 0.15s, background 0.15s;
        font: inherit;
      }
      .snapshot-pill-btn:hover {
        border-color: var(--border);
        background: var(--bg-card-hover, rgba(255,255,255,0.05));
      }
      .snapshot-pill-active {
        border-color: var(--accent) !important;
        background: rgba(59,130,246,0.12) !important;
      }
      .task-dag-shell { display:grid; grid-template-columns:minmax(260px, 320px) minmax(0, 1fr); gap:12px; align-items:start; }
      .task-dag-sidebar { padding:12px; border:1px solid var(--border); border-radius:16px; background:var(--bg-surface); position:sticky; top:10px; display:grid; gap:12px; }
      .task-dag-sidebar-head { display:grid; gap:8px; }
      .task-dag-sidebar-title { font-weight:700; }
      .task-dag-sidebar-list { display:grid; gap:8px; }
      .task-dag-sidebar-card { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border:1px solid var(--border); border-radius:12px; background:rgba(255,255,255,0.02); }
      .task-dag-sidebar-card.is-active { border-color: var(--accent); background: rgba(59,130,246,0.10); }
      .task-dag-sidebar-card-main { display:grid; gap:2px; text-align:left; background:none; border:none; color:inherit; padding:0; cursor:pointer; flex:1; }
      .task-dag-sidebar-card-actions { display:flex; align-items:center; gap:6px; }
      .task-dag-mini-btn { min-width:28px; height:28px; border-radius:8px; border:1px solid var(--border); background:transparent; color:inherit; cursor:pointer; }
      .task-dag-mini-btn:disabled { opacity:0.45; cursor:not-allowed; }
      .task-structure-chip { cursor:pointer; border:1px solid var(--border); }
      .task-structure-chip-muted { opacity:0.8; }
      .task-structure-chip-active { border-color: var(--accent); background: rgba(59,130,246,0.18); }
      @media (max-width: 960px) { .task-dag-shell { grid-template-columns: 1fr; } .task-dag-sidebar { position: static; } }
      @media (max-width: 640px) {
        .actions-label { display:none; }
      }
    </style>

    ${isKanban && html`<${KanbanBoard} onOpenTask=${openDetail} hasMoreTasks=${hasMoreKanbanPages} loadingMoreTasks=${kanbanLoadingMore} onLoadMoreTasks=${loadMoreKanbanTasks} columnTotals=${boardColumnTotals} totalTasks=${boardTotalTasks} workspaceId=${activeWorkspaceId.value || ""} hierarchyModel=${sharedTaskHierarchyModel} tasks=${tasks} />`}

    ${isDag && html`
      <div class="task-dag-shell">
        <div class="task-dag-sidebar jira-panel">
          <div class="task-dag-sidebar-head">
            <div>
              <div class="task-dag-sidebar-title">Planning controls</div>
              <div class="meta-text">Jira-style sprint and epic planning with direct DAG editing.</div>
            </div>
            <div class="btn-row">
              <${Button} size="small" variant="text" onClick=${handleRefreshDag} disabled=${dagLoading}>${dagLoading ? "Refreshing…" : "Refresh"}</${Button}>
              <${Button} size="small" variant="text" onClick=${handleCreateSprint}>+ Sprint</${Button}>
              <${Button} size="small" variant="text" onClick=${() => { setCreateSeed({ taskType: "epic", draft: true, sprintId: dagSelectedSprint !== "all" ? dagSelectedSprint : "" }); setShowCreate(true); }}>+ Epic</${Button}>
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Interaction</div>
            <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
              <${ToggleButtonGroup}
                size="small"
                exclusive
                value=${dagInteractionMode}
                onChange=${(_event, next) => { if (next) setDagInteractionMode(next); }}
              >
                <${ToggleButton} value="open">Open tasks</${ToggleButton}>
                <${ToggleButton} value="wire">Wire DAG</${ToggleButton}>
              </${ToggleButtonGroup}>
            </div>
            <div class="meta-text" style=${{ marginTop: "6px" }}>
              ${dagInteractionMode === "wire" ? "Drag from a source node to a target node to add edges, or click source then target for rapid multi-wiring." : "Click any node to open the Jira-style side panel."}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Selected sprint</div>
            <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
              ${dagSprintPicker}
            </div>
            <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
              <${Select} size="small" value=${dagSprintOrderMode} disabled=${dagLoading || dagSelectedSprint === "all"} onChange=${(e) => handleDagSprintModeChange(e.target.value)}>
                <${MenuItem} value="parallel">Mode: parallel</${MenuItem}>
                <${MenuItem} value="sequential">Mode: sequential</${MenuItem}>
              </${Select}>
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Organizer review</div>
            <div class="meta-text" style=${{ marginTop: "6px" }}>
              ${dagOrganizeSummary}
            </div>
            ${dagOrganizeSuggestions.length > 0 && html`
              <div class="meta-text" style=${{ marginTop: "4px" }}>
                Showing ${Math.min(dagOrganizeSuggestions.length, 6)} of ${dagOrganizeSuggestions.length} suggestion${dagOrganizeSuggestions.length === 1 ? "" : "s"} for ${dagSelectedSprintLabel}.
              </div>
            `}
            <div class="task-dag-sidebar-list" style=${{ marginTop: "8px" }}>
              ${dagOrganizeSuggestions.slice(0, 6).map((entry) => {
                const suggestionType = toText(entry?.type, "dependency_update");
                const suggestionLabel = suggestionType === "missing_sequential_dependency"
                  ? "Sequential gap"
                  : suggestionType === "redundant_transitive_dependency"
                    ? "Redundant edge"
                    : "Dependency suggestion";
                const taskId = toText(entry?.taskId);
                const dependencyTaskId = toText(entry?.dependencyTaskId);
                return html`
                  <div class="task-dag-sidebar-card">
                    <div class="task-dag-sidebar-card-main">
                      <strong>${suggestionLabel}</strong>
                      <span class="meta-text">${truncate(toText(entry?.message, "Dependency rewrite suggested."), 120)}</span>
                      <span class="meta-text">${dependencyTaskId ? `${dependencyTaskId} -> ` : ""}${taskId || "task"}</span>
                    </div>
                    <div class="task-dag-sidebar-card-actions">
                      ${suggestionType === "missing_sequential_dependency" && dependencyTaskId && taskId
                        ? html`<button type="button" class="task-dag-mini-btn" onClick=${() => handleApplyDagSuggestion(entry)}>apply</button>`
                        : null}
                      ${dependencyTaskId ? html`<button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(dependencyTaskId)}>dep</button>` : null}
                      ${taskId ? html`<button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(taskId)}>task</button>` : null}
                    </div>
                  </div>
                `;
              })}
              ${dagOrganizeSuggestions.length === 0 ? html`<div class="meta-text">No pending organizer suggestions for this scope.</div>` : null}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Sprints</div>
            <div class="task-dag-sidebar-list">
              ${dagSprints.map((sprint, index) => html`
                <div class=${`task-dag-sidebar-card ${dagSelectedSprint === sprint.id ? "is-active" : ""}`}>
                  <button type="button" class="task-dag-sidebar-card-main" onClick=${() => handleSprintChange(sprint.id)}>
                    <strong>${sprint.label}</strong>
                    <span class="meta-text">${sprint.executionMode || "parallel"}</span>
                  </button>
                  <div class="task-dag-sidebar-card-actions">
                    <button type="button" class="task-dag-mini-btn" disabled=${index === 0} onClick=${() => handleMoveSprint(sprint.id, -1)}>↑</button>
                    <button type="button" class="task-dag-mini-btn" disabled=${index === dagSprints.length - 1} onClick=${() => handleMoveSprint(sprint.id, 1)}>↓</button>
                    <button type="button" class="task-dag-mini-btn" onClick=${() => handleEditSprint(sprint)}>✎</button>
                    <button type="button" class="task-dag-mini-btn" onClick=${() => { setCreateSeed({ taskType: "task", sprintId: sprint.id }); setShowCreate(true); }}>+</button>
                  </div>
                </div>
              `)}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Epics</div>
            <div class="task-dag-sidebar-list">
              ${dagEpicCatalog.map((epic) => html`
                <div class="task-dag-sidebar-card">
                  <div class="task-dag-sidebar-card-main">
                    <strong>${epic.label}</strong>
                    <span class="meta-text">${epic.taskCount} tasks · ${epic.dependencies.length} deps</span>
                  </div>
                  <div class="task-dag-sidebar-card-actions">
                    <button type="button" class="task-dag-mini-btn" onClick=${() => { setCreateSeed({ taskType: "task", epicId: epic.id, sprintId: dagSelectedSprint !== "all" ? dagSelectedSprint : "" }); setShowCreate(true); }}>+</button>
                    ${epic.anchorTaskId ? html`<button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(epic.anchorTaskId)}>↗</button>` : null}
                  </div>
                </div>
              `)}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Sprint queue</div>
            <div class="task-dag-sidebar-list">
              ${dagSprintQueue.slice(0, 18).map((task) => html`
                <div class="task-dag-sidebar-card">
                  <div class="task-dag-sidebar-card-main">
                    <strong>${truncate(task.title || task.id, 32)}</strong>
                    <span class="meta-text">${task.id} · #${getTaskSprintOrder(task) || "—"} · ${task.status || "todo"}</span>
                  </div>
                  <div class="task-dag-sidebar-card-actions">
                    <button type="button" class="task-dag-mini-btn" onClick=${() => handleNudgeSprintTaskOrder(task.id, -1)}>↑</button>
                    <button type="button" class="task-dag-mini-btn" onClick=${() => handleNudgeSprintTaskOrder(task.id, 1)}>↓</button>
                    <button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(task.id)}>↗</button>
                  </div>
                </div>
              `)}
              ${dagSprintQueue.length === 0 ? html`<div class="meta-text">No tasks in the selected sprint yet.</div>` : null}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Ready next</div>
            <div class="task-dag-sidebar-list">
              ${dagReadyQueue.slice(0, 12).map((task) => html`
                <div class="task-dag-sidebar-card">
                  <div class="task-dag-sidebar-card-main">
                    <strong>${truncate(task.title || task.id, 32)}</strong>
                    <span class="meta-text">${task.id} · ${task.status || "todo"}</span>
                  </div>
                  <div class="task-dag-sidebar-card-actions">
                    <button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(task.id)}>↗</button>
                    <button type="button" class="task-dag-mini-btn" onClick=${() => openStartModal(task)}>▶</button>
                  </div>
                </div>
              `)}
              ${dagReadyQueue.length === 0 ? html`<div class="meta-text">No unblocked tasks are ready right now.</div>` : null}
            </div>
          </div>
          <div class="tasks-filter-section">
            <div class="tasks-filter-title">Backlog & review lanes</div>
            <div class="task-dag-sidebar-list">
              ${dagBacklogQueue.slice(0, 6).map((task) => html`<div class="task-dag-sidebar-card"><div class="task-dag-sidebar-card-main"><strong>${truncate(task.title || task.id, 28)}</strong><span class="meta-text">Backlog · ${task.id}</span></div><div class="task-dag-sidebar-card-actions"><button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(task.id)}>↗</button></div></div>`)}
              ${dagExecutionQueue.slice(0, 6).map((task) => html`<div class="task-dag-sidebar-card"><div class="task-dag-sidebar-card-main"><strong>${truncate(task.title || task.id, 28)}</strong><span class="meta-text">Running/Review · ${task.id}</span></div><div class="task-dag-sidebar-card-actions"><button type="button" class="task-dag-mini-btn" onClick=${() => openDetail(task.id)}>↗</button></div></div>`)}
              ${dagBacklogQueue.length === 0 && dagExecutionQueue.length === 0 ? html`<div class="meta-text">No backlog or active tasks in this slice.</div>` : null}
            </div>
          </div>
        </div>
        <div class="task-dag-wrap" style=${{ display: "grid", gap: "10px", marginTop: "8px" }}>
          ${dagError ? html`<${Alert} severity="warning">${dagError}</${Alert}>` : null}
          ${dagLoading ? html`<${Alert} severity="info">Loading DAG data…</${Alert}>` : null}
          <${DagGraphSection}
            title=${dagSprintGraph.title || (dagSelectedSprint === "all" ? "All Sprint DAG" : `Sprint ${dagSelectedSprint} DAG`)}
            description=${dagFocusMode === "execution" ? "Running and review tasks, with ready-next nodes highlighted." : dagSprintGraph.description || "Task dependency order within the selected sprint."}
            graph=${dagSprintGraphView}
            graphKey="sprint"
            onOpenTask=${openDetail}
            onCreateEdge={({ sourceNode, targetNode }) => handleCreateDagEdge({ sourceNode, targetNode, graphKind: "task" })}
            onDeleteEdge=${(edge) => handleDeleteDagEdge({ sourceId: edge?.sourceId, targetId: edge?.targetId, graphKind: "task" })}
            allowWiring=${true}
            interactionMode=${dagInteractionMode}
            highlightNodeIds=${dagReadyHighlightIds}
            emptyMessage="No sprint DAG data available yet."
          ><//>
          <${DagGraphSection}
            title=${dagGlobalGraph.title || "Global DAG of DAGs"}
            description=${dagGlobalGraph.description || "Cross-sprint dependency overview."}
            graph=${dagGlobalGraphView}
            graphKey="global"
            onActivateNode=${(node) => handleSprintChange(node?.sprintId || node?.id || "all")}
            allowWiring=${false}
            interactionMode="open"
            emptyMessage="No global DAG data available yet."
          ><//>
          <${DagGraphSection}
            title=${dagEpicGraph.title || "Epic Dependency DAG"}
            description=${dagEpicGraph.description || "Epics and their run prerequisites."}
            graph=${dagEpicGraphView}
            graphKey="epic"
            onActivateNode=${(node) => {
              const epic = dagEpicCatalog.find((entry) => toText(entry?.id) === toText(node?.epicId || node?.id));
              if (epic?.anchorTaskId) openDetail(epic.anchorTaskId);
            }}
            onCreateEdge={({ sourceNode, targetNode }) => handleCreateDagEdge({ sourceNode, targetNode, graphKind: "epic" })}
            onDeleteEdge=${(edge) => handleDeleteDagEdge({ sourceId: edge?.sourceId, targetId: edge?.targetId, graphKind: "epic" })}
            allowWiring=${true}
            interactionMode=${dagInteractionMode}
            emptyMessage="No epic DAG data available yet."
          ><//>
        </div>
      </div>
    `}

    ${isList && listVisibleCount > 0 && html`
      <div class="task-table-wrap">
        <div class="task-list-header" role="row">
          <button
            type="button"
            class="task-list-header-sort"
            onClick=${() => {
              if (listSortCol === "title") setListSortDir(listSortDir === "asc" ? "desc" : "asc");
              else { setListSortCol("title"); setListSortDir("asc"); }
            }}
          >
            Hierarchy <span class="task-th-arrow">${listSortCol === "title" ? (listSortDir === "asc" ? "▲" : "▼") : "⇅"}</span>
          </button>
          <div class="task-list-header-actions">
            ${[
              { col: "status", label: "Status" },
              { col: "priority", label: "Priority" },
              { col: "updated", label: "Updated" },
            ].map(({ col, label }) => {
              const active = listSortCol === col;
              const arrow = active ? (listSortDir === "asc" ? "▲" : "▼") : "⇅";
              return html`
                <button
                  type="button"
                  key=${col}
                  class="task-list-header-sort"
                  onClick=${() => {
                    if (listSortCol === col) setListSortDir(listSortDir === "asc" ? "desc" : "asc");
                    else { setListSortCol(col); setListSortDir(col === "updated" ? "desc" : "asc"); }
                  }}
                >
                  ${label} <span class="task-th-arrow">${arrow}</span>
                </button>
              `;
            })}
          </div>
        </div>
        <div class="task-tree-list" role="tree" aria-label="Task hierarchy list">
          ${hierarchicalListRows.map((row) => {
            const task = row.task;
            const statusTone = getTaskListStatusTone(task.status);
            const isManual = isTaskManual(task);
            const branch = getTaskBaseBranch(task);
            const repoName = task.repository || task.workspace || "";
            const updatedLabel = task.updated_at || task.updated ? formatRelative(task.updated_at || task.updated) : "";
            const issueTypeLabel = getTaskListIssueTypeLabel(task);
            const selected = batchMode && selectedIds.has(task.id);
            return html`
              <div
                key=${task.id}
                class="task-tree-row ${selected ? "task-tree-row-selected" : ""}"
                data-status=${task.status || ""}
                data-tone=${statusTone}
                data-depth=${row.depth}
                data-match=${row.matchState}
                role="treeitem"
                aria-level=${row.depth + 1}
                aria-expanded=${row.hasChildren ? String(row.isExpanded) : undefined}
                tabIndex=${0}
                onClick=${() => batchMode ? toggleSelect(task.id) : openDetail(task.id)}
                onKeyDown=${(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === "ArrowRight" && row.hasChildren && row.isCollapsed) {
                    event.preventDefault();
                    toggleHierarchyRow(row.node.collapseKey);
                  } else if (event.key === "ArrowLeft" && row.hasChildren && row.isExpanded) {
                    event.preventDefault();
                    toggleHierarchyRow(row.node.collapseKey);
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (batchMode) toggleSelect(task.id);
                    else openDetail(task.id);
                  }
                }}
              >
                <div class="task-tree-main" style=${{ "--task-tree-depth": row.depth }}>
                  <div class="task-tree-title-line">
                    ${row.hasChildren
                      ? html`
                          <button
                            type="button"
                            class="task-tree-disclosure"
                            aria-label=${row.isExpanded ? "Collapse children" : "Expand children"}
                            onClick=${(event) => {
                              event.stopPropagation();
                              toggleHierarchyRow(row.node.collapseKey);
                            }}
                          >
                            ${row.isExpanded ? "▾" : "▸"}
                          </button>
                        `
                      : html`<span class="task-tree-disclosure task-tree-disclosure-placeholder">•</span>`}
                    ${batchMode && html`
                      <button
                        type="button"
                        class="task-tree-select"
                        aria-label=${selected ? "Deselect task" : "Select task"}
                        aria-pressed=${selected ? "true" : "false"}
                        onClick=${(event) => {
                          event.stopPropagation();
                          toggleSelect(task.id);
                        }}
                      >
                        ${selected ? "✓" : ""}
                      </button>
                    `}
                    <span class="task-tree-issue-type" data-kind=${issueTypeLabel.toLowerCase().replace(/[^a-z]+/g, "-")}>${issueTypeLabel}</span>
                    <span class="task-tree-title">${task.title || "(untitled)"}</span>
                    ${row.progressTotal > 0 && html`<span class="task-tree-progress-pill">${row.progressDone}/${row.progressTotal} done</span>`}
                    ${row.blockedCount > 0 && html`<span class="task-tree-alert-pill">${row.blockedCount} blocked</span>`}
                    ${isManual && html`<span class="task-tree-meta-pill">Manual</span>`}
                    ${row.matchState === "descendant" && html`<span class="task-tree-meta-pill">Matched child</span>`}
                  </div>
                  <div class="task-tree-meta-line">
                    ${task.id ? html`<span class="task-tree-id">${task.id}</span>` : null}
                    ${task.priority ? html`<span class="task-tree-meta-pill" data-tone=${task.priority}>${task.priority}</span>` : null}
                    ${repoName ? html`<span>${repoName}</span>` : null}
                    ${branch ? html`<code class="task-td-code">${branch}</code>` : null}
                    ${task.assignee ? html`<span>@${task.assignee}</span>` : null}
                    ${updatedLabel ? html`<span>${updatedLabel}</span>` : null}
                    ${toText(task?.epicId || task?.meta?.epicId) ? html`<span>Epic ${toText(task?.epicId || task?.meta?.epicId)}</span>` : null}
                  </div>
                </div>
                <div class="task-tree-actions" onClick=${(event) => event.stopPropagation()}>
                  <${Select}
                    size="small"
                    value=${normalizeTaskStatusValue(task.status || "todo")}
                    className="task-tree-status-select"
                    onChange=${async (event) => {
                      await handleInlineListStatusChange(task, event.target.value);
                    }}
                  >
                    ${["draft", "todo", "inprogress", "inreview", "blocked", "done", "cancelled"].map((statusOption) => html`
                      <${MenuItem} value=${statusOption}>${statusOption}</${MenuItem}>
                    `)}
                  </${Select}>
                  <button
                    type="button"
                    class="task-tree-action-btn"
                    onClick=${(event) => {
                      event.stopPropagation();
                      openDetail(task.id);
                    }}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    class="task-tree-action-btn"
                    onClick=${(event) => {
                      event.stopPropagation();
                      handleQuickCreateChildTask(task);
                    }}
                  >
                    + Child
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `}
    ${isList && !listVisibleCount &&
    html`
      <${EmptyState}
        message="No tasks match those filters"
        description="Try clearing filters or searching by ID, title, or tag."
        action=${hasActiveFilters
          ? { label: "Clear Filters", onClick: handleClearFilters }
          : null}
      />
    `}

    ${isList && html`
      <div class="pager">
        <${Button}
          variant="outlined" size="small"
          onClick=${handlePrev}
          disabled=${page <= 0}
        >
          ← Prev
        <//>
        <span class="pager-info">Page <span class="numeral">${page + 1}</span> / <span class="numeral">${totalPages}</span></span>
        <${Button}
          variant="outlined" size="small"
          onClick=${handleNext}
          disabled=${page + 1 >= totalPages}
        >
          Next →
        <//>
      </div>
    `}

    <${Fab}
      color="primary" size="small"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
    >
      ${ICONS.plus}
    <//>

    ${showCreateSprint && html`
      <${CreateSprintModalInline}
        initialValues=${editingSprint}
        onClose=${() => {
          setShowCreateSprint(false);
          setEditingSprint(null);
        }}
        onSaved=${async (savedSprint) => {
          setShowCreateSprint(false);
          setEditingSprint(null);
          if (savedSprint?.id) setDagSelectedSprint(savedSprint.id);
          await loadDagViews();
        }}
      />
    `}

    ${showCreate &&
    html`
      <${CreateTaskModalInline}
        initialValues=${createSeed}
        sprintOptions=${dagSprints}
        taskCatalog=${dagTaskCatalog}
        epicCatalog=${dagEpicCatalog}
        onClose=${() => {
          setShowCreate(false);
          setCreateSeed(null);
        }}
        onCreated=${async () => {
          setShowCreate(false);
          setCreateSeed(null);
          await loadDagViews();
        }}
      />
    `}
    ${detailTask && isActiveStatus(detailTask.status) && hasLiveExecutionEvidence(detailTask) &&
    !isDag &&
    html`
      <${TaskProgressModal}
        task=${detailTask}
        onClose=${() => {
          detailRequestIdRef.current += 1;
          setDetailTask(null);
          setDetailTaskHydrating(false);
        }}
      />
    `}
    ${detailTask && (isDag || !isActiveStatus(detailTask.status) || !hasLiveExecutionEvidence(detailTask)) &&
    html`
      <${TaskDetailModal}
        task=${detailTask}
        isHydrating=${detailTaskHydrating}
        onClose=${() => {
          detailRequestIdRef.current += 1;
          setDetailTask(null);
          setDetailTaskHydrating(false);
        }}
        onStart=${(task) => openStartModal(task)}
        onOpenTask=${openDetail}
        presentation=${isDag ? "side-sheet" : "modal"}
        taskCatalog=${dagTaskCatalog}
        epicCatalog=${dagEpicCatalog}
        hierarchyModel=${sharedTaskHierarchyModel}
        hierarchyNodeState=${sharedTaskHierarchyView.nodeStateById.get(String(detailTask?.id || "")) || null}
        onUpdateHierarchySubtasks=${handleHierarchySubtasksUpdate}
      />
    `}
    ${startTarget &&
    html`
      <${StartTaskModal}
        task=${startTarget}
        defaultSdk=${defaultSdk}
        allowTaskIdInput=${false}
        onClose=${() => setStartTarget(null)}
        onStart=${startTask}
        presentation=${isDag ? "side-sheet" : "modal"}
      />
    `}
    ${startAnyOpen &&
    html`
      <${StartTaskModal}
        task=${null}
        defaultSdk=${defaultSdk}
        allowTaskIdInput=${true}
        onClose=${() => setStartAnyOpen(false)}
        onStart=${startTask}
      />
    `}
    ${showTemplates &&
    html`
      <${TriggerTemplatesModal}
        onClose=${() => setShowTemplates(false)}
      />
    `}
  `;
}

function CreateSprintModalInline({ onClose, initialValues = null, onSaved = null }) {
  const [name, setName] = useState(toText(initialValues?.name || initialValues?.title || ""));
  const [goal, setGoal] = useState(toText(initialValues?.goal || initialValues?.description || ""));
  const [executionMode, setExecutionMode] = useState(toText(initialValues?.executionMode || initialValues?.taskOrderMode, "parallel"));
  const [orderInput, setOrderInput] = useState(toText(initialValues?.order));
  const [saving, setSaving] = useState(false);

  const handleSubmit = useCallback(async () => {
    const cleanName = sanitizeTaskText(name || "").trim();
    if (!cleanName) {
      showToast("Sprint name is required", "warning");
      return false;
    }
    const payload = {
      name: cleanName,
      goal: sanitizeTaskText(goal || "").trim() || undefined,
      executionMode: executionMode === "sequential" ? "sequential" : "parallel",
      taskOrderMode: executionMode === "sequential" ? "sequential" : "parallel",
    };
    const orderNumber = Number(orderInput);
    if (Number.isFinite(orderNumber) && orderNumber > 0) payload.order = orderNumber;
    setSaving(true);
    try {
      const result = initialValues?.id
        ? await apiFetch("/api/tasks/sprints/" + encodeURIComponent(initialValues.id), {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
        : await apiFetch("/api/tasks/sprints", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      showToast(initialValues?.id ? "Sprint updated" : "Sprint created", "success");
      await onSaved?.(result?.data || result);
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  }, [executionMode, goal, initialValues?.id, name, onSaved, orderInput]);

  return html`
    <${Modal}
      title=${initialValues?.id ? "Edit Sprint" : "New Sprint"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      activeOperationLabel=${saving ? "Sprint save in progress" : ""}
    >
      <div class="flex-col create-task-form">
        <${TextField} size="small" placeholder="Sprint name" value=${name} onInput=${(e) => setName(e.target.value)} fullWidth autoFocus=${true} />
        <${TextField} multiline rows=${3} size="small" placeholder="Sprint goal" value=${goal} onInput=${(e) => setGoal(e.target.value)} fullWidth />
        <div class="input-row">
          <${Select} size="small" value=${executionMode} onChange=${(e) => setExecutionMode(e.target.value)}>
            <${MenuItem} value="parallel">Parallel execution</${MenuItem}>
            <${MenuItem} value="sequential">Sequential execution</${MenuItem}>
          </${Select}>
          <${TextField} size="small" type="number" placeholder="Board order" value=${orderInput} onInput=${(e) => setOrderInput(e.target.value)} inputProps=${{ min: 1, step: 1 }} />
        </div>
        <div class="btn-row" style=${{ marginTop: "8px" }}>
          <${Button} variant="contained" size="small" disabled=${saving} onClick=${() => { void handleSubmit(); }}>
            ${saving ? "Saving…" : initialValues?.id ? "Save Sprint" : "Create Sprint"}
          <//>
          <${Button} variant="text" size="small" disabled=${saving} onClick=${onClose}>Cancel</${Button}>
        </div>
      </div>
    <//>
  `;
}

/* ── Inline CreateTask (duplicated here to keep tasks.js self-contained) ── */
function CreateTaskModalInline({ onClose, initialValues = null, sprintOptions = [], taskCatalog = [], epicCatalog = [], onCreated = null }) {
  const initialTaskType = normalizeTaskTypeValue(initialValues?.taskType || initialValues?.type || "task");
  const [title, setTitle] = useState(initialValues?.title || "");
  const [description, setDescription] = useState(initialValues?.description || "");
  const [baseBranch, setBaseBranch] = useState(initialValues?.baseBranch || "");
  const [priority, setPriority] = useState(initialValues?.priority || "medium");
  const [taskType, setTaskType] = useState(initialTaskType);
  const [epicId, setEpicId] = useState(initialValues?.epicId || "");
  const [goalId, setGoalId] = useState(initialValues?.goalId || "");
  const [parentGoalId, setParentGoalId] = useState(initialValues?.parentGoalId || "");
  const [storyPoints, setStoryPoints] = useState(toText(initialValues?.storyPoints));
  const [budgetWindow, setBudgetWindow] = useState(initialValues?.budgetWindow || "");
  const [budgetCents, setBudgetCents] = useState(toText(initialValues?.budgetCents));
  const [budgetCurrency, setBudgetCurrency] = useState(initialValues?.budgetCurrency || "USD");
  const [coordinationTeamId, setCoordinationTeamId] = useState(initialValues?.coordinationTeamId || "");
  const [coordinationRole, setCoordinationRole] = useState(initialValues?.coordinationRole || "");
  const [coordinationReportsTo, setCoordinationReportsTo] = useState(initialValues?.coordinationReportsTo || "");
  const [coordinationLevel, setCoordinationLevel] = useState(initialValues?.coordinationLevel || "");
  const [dependenciesInput, setDependenciesInput] = useState((initialValues?.dependencies || []).join(", "));
  const [selectedSprintId, setSelectedSprintId] = useState(initialValues?.sprintId || "");
  const [sprintOrderInput, setSprintOrderInput] = useState(toText(initialValues?.sprintOrder));
  const [tagsInput, setTagsInput] = useState((initialValues?.tags || []).join(", "));
  const [draft, setDraft] = useState(Boolean(initialValues?.draft));
  const [submitting, setSubmitting] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId.value || initialValues?.workspaceId || "");
  const [repository, setRepository] = useState(initialValues?.repository || "");
  const [repositories, setRepositories] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(
    initialValues?.epicId
    || initialValues?.goalId
    || initialValues?.parentGoalId
    || initialValues?.budgetWindow
    || initialValues?.budgetCents
    || initialValues?.coordinationTeamId
    || initialValues?.coordinationRole
    || initialValues?.coordinationReportsTo
    || initialValues?.coordinationLevel
    || initialValues?.sprintId
    || initialValues?.dependencies?.length,
  ));
  const initialSnapshotRef = useRef({
    title: initialValues?.title || "",
    description: initialValues?.description || "",
    baseBranch: initialValues?.baseBranch || "",
    priority: initialValues?.priority || "medium",
    taskType: initialTaskType,
    epicId: initialValues?.epicId || "",
    goalId: initialValues?.goalId || "",
    parentGoalId: initialValues?.parentGoalId || "",
    storyPoints: toText(initialValues?.storyPoints),
    budgetWindow: initialValues?.budgetWindow || "",
    budgetCents: toText(initialValues?.budgetCents),
    budgetCurrency: initialValues?.budgetCurrency || "USD",
    coordinationTeamId: initialValues?.coordinationTeamId || "",
    coordinationRole: initialValues?.coordinationRole || "",
    coordinationReportsTo: initialValues?.coordinationReportsTo || "",
    coordinationLevel: initialValues?.coordinationLevel || "",
    sprintId: initialValues?.sprintId || "",
    sprintOrder: toText(initialValues?.sprintOrder),
    dependenciesInput: (initialValues?.dependencies || []).join(", "),
    tagsInput: (initialValues?.tags || []).join(", "),
    draft: Boolean(initialValues?.draft),
  });
  const planningDependencyIds = useMemo(() => normalizeDependencyInput(dependenciesInput), [dependenciesInput]);
  const dependencyTaskSuggestions = useMemo(() => (taskCatalog || []).filter((entry) => toText(entry?.id) && !planningDependencyIds.includes(toText(entry?.id))).slice(0, 10), [dependenciesInput, taskCatalog]);
  const pendingKey = "modal:create-task-inline";

  const handleRewrite = async () => {
    if (!title.trim() || rewriting) return;
    setRewriting(true);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/rewrite", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      if (res?.data) {
        if (res.data.title) setTitle(res.data.title);
        if (res.data.description) setDescription(res.data.description);
        showToast("Task description improved", "success");
        haptic("medium");
      }
    } catch {
      /* toast via apiFetch */
    }
    setRewriting(false);
  };
  const activeWsId = activeWorkspaceId.value || "";

  const workspaceOptions = managedWorkspaces.value || [];
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((ws) => ws.id === workspaceId) || null,
    [workspaceId, workspaceOptions],
  );
  const repositoryOptions = selectedWorkspace?.repos || [];

  useEffect(() => {
    if (!workspaceOptions.length) {
      loadWorkspaces().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (workspaceId || !activeWsId) return;
    setWorkspaceId(activeWsId);
  }, [activeWsId, workspaceId]);

  useEffect(() => {
    if (!repositoryOptions.length) {
      if (repository) setRepository("");
      if (repositories.length) setRepositories([]);
      return;
    }
    if (!repositoryOptions.some((repo) => repo?.slug === repository)) {
      const primary = repositoryOptions.find((repo) => repo?.primary);
      const defaultSlug = primary?.slug || repositoryOptions[0]?.slug || "";
      setRepository(defaultSlug);
      setRepositories(defaultSlug ? [defaultSlug] : []);
    }
  }, [workspaceId, repositoryOptions.length]);

  const unsavedSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      baseBranch: baseBranch || "",
      priority: priority || "medium",
      taskType,
      epicId: epicId || "",
      goalId: goalId || "",
      parentGoalId: parentGoalId || "",
      storyPoints: storyPoints || "",
      budgetWindow: budgetWindow || "",
      budgetCents: budgetCents || "",
      budgetCurrency: budgetCurrency || "",
      coordinationTeamId: coordinationTeamId || "",
      coordinationRole: coordinationRole || "",
      coordinationReportsTo: coordinationReportsTo || "",
      coordinationLevel: coordinationLevel || "",
      sprintId: selectedSprintId || "",
      sprintOrder: sprintOrderInput || "",
      dependenciesInput: dependenciesInput || "",
      tagsInput: tagsInput || "",
      draft: Boolean(draft),
    }),
    [baseBranch, budgetCents, budgetCurrency, budgetWindow, coordinationLevel, coordinationReportsTo, coordinationRole, coordinationTeamId, dependenciesInput, description, draft, epicId, goalId, parentGoalId, priority, selectedSprintId, sprintOrderInput, storyPoints, tagsInput, taskType, title],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, unsavedSnapshot),
    [unsavedSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setBaseBranch(base.baseBranch || "");
    setPriority(base.priority || "medium");
    setTaskType(base.taskType || "task");
    setEpicId(base.epicId || "");
    setGoalId(base.goalId || "");
    setParentGoalId(base.parentGoalId || "");
    setStoryPoints(base.storyPoints || "");
    setBudgetWindow(base.budgetWindow || "");
    setBudgetCents(base.budgetCents || "");
    setBudgetCurrency(base.budgetCurrency || "USD");
    setCoordinationTeamId(base.coordinationTeamId || "");
    setCoordinationRole(base.coordinationRole || "");
    setCoordinationReportsTo(base.coordinationReportsTo || "");
    setCoordinationLevel(base.coordinationLevel || "");
    setSelectedSprintId(base.sprintId || "");
    setSprintOrderInput(base.sprintOrder || "");
    setDependenciesInput(base.dependenciesInput || "");
    setTagsInput(base.tagsInput || "");
    setDraft(Boolean(base.draft));
    showToast("Changes discarded", "info");
  }, []);

  const toggleRepo = (slug) => {
    setRepositories((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    // Keep single-repo compat: repository = first selected
    setRepository((prev) => {
      if (repositories.includes(slug)) {
        const next = repositories.filter((s) => s !== slug);
        return next[0] || "";
      }
      return prev || slug;
    });
  };

  const handleSubmit = async ({ closeAfterSave = true } = {}) => {
    if (rewriting) {
      showToast("Wait for AI improvement to finish before saving.", "warning");
      return false;
    }
    if (!title.trim()) {
      showToast("Title is required", "error");
      return false;
    }
    setSubmitting(true);
    haptic("medium");
    const cleanTitle = sanitizeTaskText(title).trim();
    const cleanDescription = buildTaskDescriptionFallback(title, description);
    const cleanTagsInput = sanitizeTaskText(tagsInput || "");
    const tags = normalizeTagInput(cleanTagsInput);
    const effectiveRepos = repositories.length > 0 ? repositories : (repository ? [repository] : []);
    try {
      const createResponse = await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: cleanTitle,
          description: cleanDescription,
          baseBranch: baseBranch.trim() || undefined,
          priority,
          type: taskType,
          epicId: epicId || undefined,
          goalId: goalId || undefined,
          parentGoalId: parentGoalId || undefined,
          storyPoints: storyPoints === "" ? undefined : Number(storyPoints),
          budgetWindow: budgetWindow || undefined,
          budgetCents: budgetCents === "" ? undefined : Number(budgetCents),
          budgetCurrency: (budgetCurrency || "USD").trim() || undefined,
          coordinationTeamId: coordinationTeamId || undefined,
          coordinationRole: coordinationRole || undefined,
          coordinationReportsTo: coordinationReportsTo || undefined,
          coordinationLevel: coordinationLevel || undefined,
          tags,
          draft,
          status: draft ? "draft" : "todo",
          workspace: workspaceId || undefined,
          repository: effectiveRepos[0] || undefined,
          repositories: effectiveRepos.length > 1 ? effectiveRepos : undefined,
        }),
      });
      const createdTask = createResponse?.data || createResponse || null;
      const createdTaskId = toText(createdTask?.id);
      const dependencies = normalizeDependencyInput(dependenciesInput);
      const sprintOrderNumber = sprintOrderInput === "" ? null : Number(sprintOrderInput);
      if (createdTaskId && selectedSprintId) {
        if (dependencies.length > 0) {
          await apiFetch("/api/tasks/dependencies", {
            method: "PUT",
            body: JSON.stringify({
              taskId: createdTaskId,
              dependencies,
              sprintId: selectedSprintId,
              sprintOrder: Number.isFinite(sprintOrderNumber) ? sprintOrderNumber : undefined,
            }),
          });
        } else {
          await apiFetch("/api/tasks/sprints/" + encodeURIComponent(selectedSprintId) + "/tasks", {
            method: "POST",
            body: JSON.stringify({
              taskId: createdTaskId,
              sprintOrder: Number.isFinite(sprintOrderNumber) ? sprintOrderNumber : undefined,
            }),
          });
        }
      } else if (createdTaskId && dependencies.length > 0) {
        await apiFetch("/api/tasks/dependencies", {
          method: "PUT",
          body: JSON.stringify({
            taskId: createdTaskId,
            dependencies,
          }),
        });
      }
      showToast("Task created", "success");
      setTitle(cleanTitle);
      setDescription(cleanDescription);
      setTagsInput(cleanTagsInput);
      initialSnapshotRef.current = {
        title: cleanTitle,
        description: cleanDescription,
        baseBranch: baseBranch.trim(),
        priority,
        taskType,
        epicId,
        goalId,
        parentGoalId,
        storyPoints,
        budgetWindow,
        budgetCents,
        budgetCurrency,
        coordinationTeamId,
        coordinationRole,
        coordinationReportsTo,
        coordinationLevel,
        sprintId: selectedSprintId,
        sprintOrder: sprintOrderInput,
        dependenciesInput,
        tagsInput: cleanTagsInput,
        draft: Boolean(draft),
      };
      await onCreated?.(createdTask);
      if (closeAfterSave) {
        onClose?.();
      }
      await loadTasks();
      return closeAfterSave ? { closed: true } : true;
    } catch {
      /* toast */
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.MainButton) {
      tg.MainButton.setText(taskType === "epic" ? "Create Epic" : "Create Task");
      tg.MainButton.show();
      tg.MainButton.onClick(handleSubmit);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handleSubmit);
      };
    }
  }, [
    title,
    description,
    baseBranch,
    priority,
    taskType,
    epicId,
    goalId,
    parentGoalId,
    storyPoints,
    budgetWindow,
    budgetCents,
    budgetCurrency,
    coordinationTeamId,
    coordinationRole,
    coordinationReportsTo,
    coordinationLevel,
    selectedSprintId,
    sprintOrderInput,
    dependenciesInput,
    tagsInput,
    draft,
    rewriting,
    workspaceId,
    repository,
    repositories,
  ]);

  const parsedTags = normalizeTagInput(tagsInput);
  const hasAdvanced = baseBranch || draft || showAdvanced || epicId || goalId || parentGoalId || budgetWindow || budgetCents || coordinationTeamId || coordinationRole || coordinationReportsTo || coordinationLevel || selectedSprintId || dependenciesInput || storyPoints || taskType !== "task";

  const footerContent = html`
    <${Button}
      variant="contained" size="small"
      style=${{ width: "100%" }}
      onClick=${() => {
        void handleSubmit({ closeAfterSave: true });
      }}
      disabled=${submitting || rewriting}
    >
      ${submitting ? "Creating…" : iconText("✓ Create Task")}
    <//>
  `;

  return html`
    <${Modal}
      title=${taskType === "epic" ? "New Epic" : "New Task"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      footer=${footerContent}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSubmit({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${rewriting ? "Improve with AI is still running" : ""}
    >
      <div class="flex-col create-task-form">

        <!-- Title — autofocus so keyboard opens immediately -->
        <div class="input-with-mic">
          <${TextField}
            size="small"
            variant="outlined"
            placeholder="Task title *"
            value=${title}
            autoFocus=${true}
            onInput=${(e) => setTitle(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit({ closeAfterSave: true });
              }
            }}
            fullWidth
          />
          <${VoiceMicButtonInline}
            onTranscript=${(t) => setTitle((prev) => (prev ? prev + " " + t : t))}
            disabled=${submitting || rewriting}
          />
        </div>

        <${MarkdownTaskEditor}
          value=${description}
          onChange=${setDescription}
          placeholder="What needs to be done? Scope, acceptance checks, dependencies, and constraints..."
          minHeight=${300}
          disabled=${submitting}
        />

        <div class="task-markdown-toolbar">
          <div class="task-markdown-help">Rich Markdown supported. Write in Markdown or switch modes for a visual editor.</div>
          <div class="task-markdown-toolbar-actions">
            <${VoiceMicButton}
              onTranscript=${(t) => setDescription((prev) => (prev ? `${prev}\n\n${t}` : t))}
              disabled=${submitting || rewriting}
              size="sm"
            />
            <${Tooltip} title="Use AI to expand and improve this task description"><${Button}
              variant="text" size="small"
              style=${{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", padding: "5px 10px", opacity: !title.trim() ? 0.45 : 1 }}
              disabled=${!title.trim() || rewriting || submitting}
              onClick=${handleRewrite}
            >
              ${rewriting
                ? html`<span class="spin-icon" style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon(":clock:")}</span> Improving…`
                : html`${iconText(":star: Improve with AI")}`
              }
            <//><//>
          </div>
        </div>

        <!-- Priority — always visible, most commonly changed -->
        <${SegmentedControl}
          options=${[
            { value: "low", label: "Low" },
            { value: "medium", label: "Med" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          value=${priority}
          onChange=${(v) => { haptic(); setPriority(v); }}
        />

        <!-- Task type & planning -->
        <div class="input-row">
          <${Select} size="small" value=${taskType} onChange=${(e) => { setTaskType(e.target.value); if (e.target.value !== "epic" && initialValues?.epicId == null && epicId && epicId === slugifyPlanningId(title || epicId, "epic")) setEpicId(""); }}>
            <${MenuItem} value="task">Task</${MenuItem}>
            <${MenuItem} value="epic">Epic</${MenuItem}>
            <${MenuItem} value="subtask">Subtask</${MenuItem}>
          </${Select}>
          <${TextField} size="small" placeholder="Epic ID / slug" value=${epicId} onInput=${(e) => setEpicId(e.target.value)} fullWidth />
        </div>
        <div class="input-row">
          <${Select} size="small" value=${selectedSprintId} onChange=${(e) => setSelectedSprintId(e.target.value)}>
            <${MenuItem} value="">No sprint</${MenuItem}>
            ${sprintOptions.map((sprint) => html`<${MenuItem} value=${sprint.id}>${sprint.label}</${MenuItem}>`)}
          </${Select}>
          <${TextField} size="small" type="number" placeholder="Sprint order" value=${sprintOrderInput} onInput=${(e) => setSprintOrderInput(e.target.value)} inputProps=${{ min: 1, step: 1 }} />
          <${TextField} size="small" placeholder="Story points" value=${storyPoints} onInput=${(e) => setStoryPoints(e.target.value)} />
        </div>
        ${(epicCatalog.length > 0 || dependencyTaskSuggestions.length > 0) && html`
          <div class="task-comments-block jira-panel" style="padding:10px 12px">
            ${epicCatalog.length > 0 && html`<div style=${{ marginBottom: "8px" }}><div class="meta-text" style=${{ marginBottom: "4px" }}>Epic shortcuts</div><div class="tag-row">${epicCatalog.slice(0, 10).map((entry) => html`<button type="button" class="tag-chip task-structure-chip ${epicId === entry.id ? "task-structure-chip-active" : ""}" onClick=${() => setEpicId(entry.id)}>${entry.label}</button>`)}</div></div>`}
            ${dependencyTaskSuggestions.length > 0 && html`<div><div class="meta-text" style=${{ marginBottom: "4px" }}>Quick dependencies</div><div class="tag-row">${dependencyTaskSuggestions.map((entry) => html`<button type="button" class="tag-chip task-structure-chip task-structure-chip-muted" onClick=${() => setDependenciesInput(normalizeDependencyInput([...planningDependencyIds, entry.id]).join(", "))}>${entry.id}</button>`)}</div></div>`}
          </div>
        `}
        <${TextField} size="small" multiline rows=${2} placeholder="Dependency task IDs (comma or newline separated)" value=${dependenciesInput} onInput=${(e) => setDependenciesInput(e.target.value)} fullWidth />
        ${planningDependencyIds.length > 0 && html`<div class="tag-row">${planningDependencyIds.map((depId) => html`<button type="button" class="tag-chip task-structure-chip" onClick=${() => setDependenciesInput(planningDependencyIds.filter((entry) => entry !== depId).join(", "))}>${depId} ×</button>`)}</div>`}


        <!-- Workspace + Repo row -->
        ${workspaceOptions.length > 0 && html`
          <div class="input-row">
            <${Select}
              size="small"
              value=${workspaceId}
              onChange=${(e) => setWorkspaceId(e.target.value)}
            >
              <${MenuItem} value="">Active workspace</${MenuItem}>
              ${workspaceOptions.map(
                (ws) => html`<${MenuItem} value=${ws.id}>${ws.name || ws.id}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
          ${repositoryOptions.length > 0 && html`
            <div class="repo-select-group">
              ${repositoryOptions.length === 1
                ? html`<div class="repo-auto-label">
                    Repo: <strong>${repositoryOptions[0].name}</strong>
                    ${repositoryOptions[0].primary ? " (Primary)" : ""}
                  </div>`
                : html`<div class="repo-checkboxes">
                    <span class="repo-checkboxes-label">Repositories</span>
                    ${repositoryOptions.map((repo) => html`
                      <label class="repo-checkbox-item">
                        <${Switch} size="small" checked=${repositories.includes(repo.slug)} onChange=${() => toggleRepo(repo.slug)} />
                        ${repo.name}${repo.primary ? " (Primary)" : ""}
                      </label>
                    `)}
                  </div>`
              }
            </div>
          `}
        `}

        <!-- Tags -->
        <${TextField} size="small" variant="outlined" placeholder="Tags (comma-separated, optional)" value=${tagsInput} onInput=${(e) => setTagsInput(e.target.value)} fullWidth />
        ${parsedTags.length > 0 && html`
          <div class="tag-row">
            ${parsedTags.map((tag) => html`<span class="tag-chip">#${tag}</span>`)}
          </div>
        `}

        <!-- Advanced toggle -->
        <${Button}
          variant="text" size="small"
          style=${{ textAlign: "left", justifyContent: "flex-start", gap: "6px", padding: "6px 0", color: "var(--text-hint)" }}
          onClick=${() => setShowAdvanced(!showAdvanced)}
        >
          <span style="display:inline-block;transition:transform 0.15s;transform:rotate(${showAdvanced ? 90 : 0}deg)">${resolveIcon(":play:")}</span>
          Advanced${hasAdvanced && !showAdvanced ? " •" : ""}
        <//>

        <!-- Advanced fields: base branch + draft -->
        ${(showAdvanced || hasAdvanced) && html`
          <${TextField} size="small" variant="outlined" placeholder="Base branch (optional, e.g. main)" value=${baseBranch} onInput=${(e) => setBaseBranch(e.target.value)} fullWidth />
          <div class="input-row">
            <${TextField} size="small" variant="outlined" placeholder="Primary goal ID" value=${goalId} onInput=${(e) => setGoalId(e.target.value)} fullWidth />
            <${TextField} size="small" variant="outlined" placeholder="Parent goal ID" value=${parentGoalId} onInput=${(e) => setParentGoalId(e.target.value)} fullWidth />
          </div>
          <div class="input-row">
            <${TextField} size="small" variant="outlined" placeholder="Budget window (e.g. 2026-Q2)" value=${budgetWindow} onInput=${(e) => setBudgetWindow(e.target.value)} fullWidth />
            <${TextField} size="small" variant="outlined" type="number" placeholder="Budget cents" value=${budgetCents} onInput=${(e) => setBudgetCents(e.target.value)} inputProps=${{ min: 0, step: 1 }} />
            <${TextField} size="small" variant="outlined" placeholder="USD" value=${budgetCurrency} onInput=${(e) => setBudgetCurrency(e.target.value.toUpperCase())} />
          </div>
          <div class="input-row">
            <${TextField} size="small" variant="outlined" placeholder="Coordination team ID" value=${coordinationTeamId} onInput=${(e) => setCoordinationTeamId(e.target.value)} fullWidth />
            <${TextField} size="small" variant="outlined" placeholder="Coordination role" value=${coordinationRole} onInput=${(e) => setCoordinationRole(e.target.value)} fullWidth />
          </div>
          <div class="input-row">
            <${TextField} size="small" variant="outlined" placeholder="Reports to" value=${coordinationReportsTo} onInput=${(e) => setCoordinationReportsTo(e.target.value)} fullWidth />
            <${TextField} size="small" variant="outlined" placeholder="Coordination level" value=${coordinationLevel} onInput=${(e) => setCoordinationLevel(e.target.value)} fullWidth />
          </div>
          <${Toggle}
            label="Draft (save to backlog, don't start)"
            checked=${draft}
            onChange=${(next) => setDraft(next)}
          />
        `}

        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${unsavedChangesMessage(changeCount)}
          saveLabel="Create Task"
          discardLabel="Discard"
          onSave=${() => {
            void handleSubmit({ closeAfterSave: false });
          }}
          onDiscard=${resetToInitial}
          saving=${submitting}
          disabled=${rewriting}
        />

      </div>
    <//>
  `;
}
