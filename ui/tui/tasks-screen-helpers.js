import {
  taskCreate,
  taskDelete,
  taskList,
  taskUpdate,
} from "../../task/task-cli.mjs";

export const TASK_VIEW_WIDTH_THRESHOLD = 140;
export const DISPLAY_COLUMNS = [
  { key: "todo", label: "TODO" },
  { key: "in_progress", label: "IN PROGRESS" },
  { key: "review", label: "REVIEW" },
  { key: "done", label: "DONE" },
];
export const STATUS_OPTIONS = DISPLAY_COLUMNS.map((column) => column.key);
export const PRIORITY_OPTIONS = ["critical", "high", "medium", "low"];
export const PRIORITY_COLOR_MAP = {
  critical: "red",
  high: "#ff9e3d",
  medium: "yellow",
  low: "green",
};
export const EMPTY_TASK_FORM = {
  title: "",
  priority: "medium",
  status: "todo",
  tagsText: "",
  description: "",
  stepsText: "",
  acceptanceCriteriaText: "",
  verificationText: "",
};
export const LINE_LIST_FIELD_KEYS = new Set([
  "stepsText",
  "acceptanceCriteriaText",
  "verificationText",
]);

const DISPLAY_STATUS_ORDER = {
  todo: 0,
  in_progress: 1,
  review: 2,
  done: 3,
};

const PERSISTED_STATUS_MAP = {
  draft: "todo",
  todo: "todo",
  in_progress: "in_progress",
  inprogress: "in_progress",
  blocked: "in_progress",
  review: "review",
  inreview: "review",
  done: "done",
};

const PRIORITY_ORDER = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function shortTaskId(id) {
  const value = String(id || "").trim();
  if (!value) return "--------";
  return value.length <= 8 ? value : value.slice(0, 8);
}

export function truncateText(value, maxWidth = 24) {
  const text = String(value || "");
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
}

export function normalizeTaskStatus(status) {
  return PERSISTED_STATUS_MAP[String(status || "todo").trim().toLowerCase()] || "todo";
}

export function toPersistedStatus(status) {
  const normalized = normalizeTaskStatus(status);
  if (normalized === "in_progress") return "inprogress";
  if (normalized === "review") return "inreview";
  return normalized;
}

export function resolveTaskView(width, preferredView = "kanban") {
  if (Number(width || 0) < TASK_VIEW_WIDTH_THRESHOLD) return "list";
  return preferredView === "list" ? "list" : "kanban";
}

export function parseTags(tagsText) {
  if (Array.isArray(tagsText)) {
    return tagsText.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean);
  }
  return String(tagsText || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
}

export function parseLineList(value) {
  if (Array.isArray(value)) {
    return value.map((line) => String(line || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeTask(task, titleWidth = 24) {
  const normalizedStatus = normalizeTaskStatus(task?.status);
  const tags = Array.isArray(task?.tags) ? task.tags : parseTags(task?.tagsText);
  return {
    ...task,
    idShort: shortTaskId(task?.id),
    statusDisplay: normalizedStatus,
    priority: String(task?.priority || "medium").toLowerCase(),
    priorityColor: PRIORITY_COLOR_MAP[String(task?.priority || "medium").toLowerCase()] || "yellow",
    tags,
    truncatedTitle: truncateText(task?.title || "Untitled", Math.max(8, titleWidth)),
  };
}

function matchesFilter(task, filterText) {
  const query = String(filterText || "").trim().toLowerCase();
  if (!query) return true;
  const title = String(task?.title || "").toLowerCase();
  const id = String(task?.id || "").toLowerCase();
  const tags = (Array.isArray(task?.tags) ? task.tags : []).map((tag) => String(tag || "").toLowerCase());
  return title.includes(query) || id.includes(query) || tags.some((tag) => tag.includes(query));
}

function compareTasks(left, right) {
  const statusDelta = (DISPLAY_STATUS_ORDER[left.statusDisplay] ?? 99) - (DISPLAY_STATUS_ORDER[right.statusDisplay] ?? 99);
  if (statusDelta !== 0) return statusDelta;
  const priorityDelta = (PRIORITY_ORDER[left.priority] ?? 99) - (PRIORITY_ORDER[right.priority] ?? 99);
  if (priorityDelta !== 0) return priorityDelta;
  return String(left.title || "").localeCompare(String(right.title || ""));
}

export function buildBoardColumns(tasks = [], { filterText = "", columnWidth = 32 } = {}) {
  const filtered = (Array.isArray(tasks) ? tasks : [])
    .map((task) => normalizeTask(task, columnWidth - 12))
    .filter((task) => matchesFilter(task, filterText))
    .sort(compareTasks);

  return DISPLAY_COLUMNS.map((column) => {
    const items = filtered.filter((task) => task.statusDisplay === column.key);
    return {
      ...column,
      count: items.length,
      items,
    };
  });
}

export function buildListRows(tasks = [], { filterText = "", rowWidth = 72 } = {}) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => normalizeTask(task, rowWidth - 28))
    .filter((task) => matchesFilter(task, filterText))
    .sort(compareTasks);
}

export function formatColumnSummary(columns = []) {
  return (Array.isArray(columns) ? columns : [])
    .map((column) => `${column.label} (${Number(column.count || 0)})`)
    .join(" | ");
}

export function validateTaskForm(formState = {}) {
  const errors = {};
  if (!String(formState.title || "").trim()) {
    errors.title = "Title is required";
  }
  return errors;
}

export function parseTaskDescription(description = "") {
  const lines = String(description || "").split(/\r?\n/);
  const state = {
    description: [],
    steps: [],
    acceptanceCriteria: [],
    verification: [],
  };
  let section = "description";

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();
    if (/^##\s+Implementation Steps$/i.test(trimmed)) {
      section = "steps";
      continue;
    }
    if (/^##\s+Acceptance Criteria$/i.test(trimmed)) {
      section = "acceptanceCriteria";
      continue;
    }
    if (/^##\s+Verification$/i.test(trimmed)) {
      section = "verification";
      continue;
    }
    if (!trimmed) {
      if (section === "description") {
        state.description.push("");
      }
      continue;
    }
    if (section === "description") {
      state.description.push(line);
      continue;
    }
    state[section].push(trimmed.replace(/^-\s*/, ""));
  }

  return {
    description: state.description.join("\n").trim(),
    steps: state.steps,
    acceptanceCriteria: state.acceptanceCriteria,
    verification: state.verification,
  };
}

export function buildTaskDescription(formState = {}) {
  const sections = [];
  const description = String(formState.description || "").trim();
  if (description) sections.push(description);

  const groups = [
    ["Implementation Steps", parseLineList(formState.steps ?? formState.stepsText)],
    ["Acceptance Criteria", parseLineList(formState.acceptanceCriteria ?? formState.acceptanceCriteriaText)],
    ["Verification", parseLineList(formState.verification ?? formState.verificationText)],
  ];

  for (const [label, entries] of groups) {
    if (!entries.length) continue;
    if (sections.length) sections.push("");
    sections.push(`## ${label}`);
    entries.forEach((entry) => {
      sections.push(`- ${entry}`);
    });
  }

  return sections.join("\n").trim();
}

export function buildTaskPayload(formState = {}) {
  return {
    title: String(formState.title || "").trim(),
    priority: String(formState.priority || "medium").trim().toLowerCase() || "medium",
    status: toPersistedStatus(formState.status || "todo"),
    tags: parseTags(formState.tagsText ?? formState.tags),
    description: buildTaskDescription(formState),
    draft: false,
  };
}

export function buildFormStateFromTask(task = {}) {
  const parsed = parseTaskDescription(task.description || "");
  return {
    title: String(task.title || ""),
    priority: String(task.priority || "medium").toLowerCase() || "medium",
    status: normalizeTaskStatus(task.status || "todo"),
    tagsText: (Array.isArray(task.tags) ? task.tags : []).join(", "),
    description: parsed.description,
    stepsText: parsed.steps.join("\n"),
    acceptanceCriteriaText: parsed.acceptanceCriteria.join("\n"),
    verificationText: parsed.verification.join("\n"),
  };
}

export function createTaskApiFromRequestJson(requestJson) {
  if (typeof requestJson !== "function") {
    return {
      list: taskList,
      create: taskCreate,
      update: (taskId, payload) => taskUpdate(taskId, payload),
      delete: taskDelete,
    };
  }

  return {
    async list(filters = {}) {
      const params = new URLSearchParams();
      if (filters && typeof filters === "object") {
        for (const [key, value] of Object.entries(filters)) {
          if (value == null || value === "") continue;
          params.set(key, String(value));
        }
      }
      const query = params.toString();
      const payload = await requestJson(`/api/tasks${query ? `?${query}` : ""}`);
      if (Array.isArray(payload)) return payload;
      if (Array.isArray(payload?.data)) return payload.data;
      return [];
    },
    async create(payload = {}) {
      const response = await requestJson("/api/tasks/create", {
        method: "POST",
        body: payload,
      });
      return response?.data || response;
    },
    async update(taskId, payload = {}) {
      const response = await requestJson("/api/tasks/update", {
        method: "POST",
        body: {
          id: taskId,
          taskId,
          ...payload,
        },
      });
      return response?.data || response;
    },
    async delete(taskId) {
      const response = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "DELETE",
      });
      return response?.deleted === true || response?.ok === true || response === true;
    },
  };
}

export async function listTasksFromApi(filters = {}, taskApi = { list: taskList }) {
  return taskApi.list(filters);
}

export async function createTaskFromForm(formState = {}, taskApi = { create: taskCreate }) {
  const errors = validateTaskForm(formState);
  if (Object.keys(errors).length) {
    const err = new Error(errors.title || "Validation failed");
    err.validationErrors = errors;
    throw err;
  }
  return taskApi.create(buildTaskPayload(formState));
}

export async function updateTaskFromForm(taskId, formState = {}, taskApi = { update: taskUpdate }) {
  const errors = validateTaskForm(formState);
  if (Object.keys(errors).length) {
    const err = new Error(errors.title || "Validation failed");
    err.validationErrors = errors;
    throw err;
  }
  return taskApi.update(taskId, buildTaskPayload(formState));
}

export async function deleteTaskById(taskId, taskApi = { delete: taskDelete }) {
  return taskApi.delete(taskId);
}
