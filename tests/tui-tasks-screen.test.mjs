import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";

import {
  formatColumnSummary,
  LINE_LIST_FIELD_KEYS,
  TASK_VIEW_WIDTH_THRESHOLD,
  buildBoardColumns,
  buildListRows,
  normalizeTaskStatus,
  parseTaskDescription,
  resolveTaskView,
  validateTaskForm,
} from "../ui/tui/tasks-screen-helpers.js";
import {
  TASK_COLUMNS,
  buildTaskFormRows,
  bucketTasksByStatus,
  createEmptyTaskFormState,
  formatTask,
  normalizeTaskCreatePayload,
} from "../tui/screens/tasks-screen-helpers.mjs";

let createTaskApiFromRequestJson;
let createTaskFromForm;
let deleteTaskById;
let listTasksFromApi;
let taskList;
let updateTaskFromForm;

async function loadTaskCrudModules() {
  vi.resetModules();
  const taskScreenHelpers = await import("../ui/tui/tasks-screen-helpers.js");
  const taskCli = await import("../task/task-cli.mjs");

  ({
    createTaskApiFromRequestJson,
    createTaskFromForm,
    deleteTaskById,
    listTasksFromApi,
    updateTaskFromForm,
  } = taskScreenHelpers);
  ({ taskList } = taskCli);
}

const tempDirs = [];

function createTempStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "bosun-tui-tasks-"));
  tempDirs.push(dir);
  return join(dir, "kanban-state.json");
}

function readStore(storePath) {
  return JSON.parse(readFileSync(storePath, "utf8"));
}

afterEach(() => {
  delete process.env.BOSUN_STORE_PATH;
  resetStateLedgerCache();
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await loadTaskCrudModules();
});

describe("tui tasks screen helpers", () => {
  it("creates a default inline task form draft", () => {
    expect(createEmptyTaskFormState()).toEqual({
      title: "",
      description: "",
      priority: "medium",
    });
  });

  it("normalizes inline task form payloads and enforces a title", () => {
    expect(normalizeTaskCreatePayload({ title: "   " })).toEqual({
      ok: false,
      error: "Title is required.",
    });

    expect(normalizeTaskCreatePayload({
      title: "  Ship inline form  ",
      description: "  Render in terminal  ",
      priority: "HIGH",
    })).toEqual({
      ok: true,
      payload: {
        title: "Ship inline form",
        description: "Render in terminal",
        priority: "high",
      },
    });
  });

  it("projects inline form rows with the active editor on the same line", () => {
    expect(buildTaskFormRows(createEmptyTaskFormState(), "title")).toEqual([
      {
        field: "title",
        label: "Title",
        value: "",
        displayValue: "(required)",
        isActive: true,
        isPlaceholder: true,
        inputPlaceholder: undefined,
      },
      {
        field: "description",
        label: "Description",
        value: "",
        displayValue: "(optional)",
        isActive: false,
        isPlaceholder: true,
        inputPlaceholder: undefined,
      },
      {
        field: "priority",
        label: "Priority",
        value: "medium",
        displayValue: "medium",
        isActive: false,
        isPlaceholder: false,
        inputPlaceholder: "critical, high, medium, low",
      },
    ]);

    expect(buildTaskFormRows({
      title: "Ship inline form",
      description: "Render the editor inside the row",
      priority: "high",
    }, "description")[1]).toEqual({
      field: "description",
      label: "Description",
      value: "Render the editor inside the row",
      displayValue: "Render the editor inside the row",
      isActive: true,
      isPlaceholder: false,
      inputPlaceholder: undefined,
    });
  });

  it("buckets inline tasks by status and formats compact rows", () => {
    const buckets = bucketTasksByStatus([
      { id: "task-12345678", title: "Draft form", status: "todo", priority: "high" },
      { id: "task-abcdef12", title: "Ship tests", status: "done" },
    ]);

    expect(TASK_COLUMNS.every((column) => buckets.has(column))).toBe(true);
    expect(buckets.get("todo")).toHaveLength(1);
    expect(buckets.get("done")).toHaveLength(1);
    expect(formatTask(buckets.get("todo")[0])).toBe("task-123  [h] Draft form");
  });

  it("falls back to list view below the kanban width threshold", () => {
    expect(TASK_VIEW_WIDTH_THRESHOLD).toBe(140);
    expect(resolveTaskView(120)).toBe("list");
    expect(resolveTaskView(160)).toBe("kanban");
    expect(resolveTaskView(200, "list")).toBe("list");
  });

  it("builds four board columns with counts and real-time filtering by title, tag, or id", () => {
    const tasks = [
      { id: "MT-101", title: "Fix login flow", status: "todo", priority: "critical", tags: ["auth"] },
      { id: "MT-102", title: "Ship audit log", status: "inprogress", priority: "high", tags: ["ops"] },
      { id: "MT-103", title: "Review release notes", status: "inreview", priority: "medium", tags: ["docs"] },
      { id: "MT-104", title: "Close sprint board", status: "done", priority: "low", tags: ["ops"] },
      { id: "MT-105", title: "Unblock deploy", status: "blocked", priority: "high", tags: ["deploy"] },
    ];

    const allColumns = buildBoardColumns(tasks, { filterText: "", columnWidth: 30 });
    expect(allColumns.map((column) => column.key)).toEqual(["todo", "in_progress", "review", "done"]);
    expect(allColumns.map((column) => column.count)).toEqual([1, 2, 1, 1]);

    const titleFiltered = buildBoardColumns(tasks, { filterText: "login", columnWidth: 30 });
    expect(titleFiltered[0].items).toHaveLength(1);
    expect(titleFiltered[0].items[0].idShort).toBe("MT-101");

    const tagFiltered = buildBoardColumns(tasks, { filterText: "deploy", columnWidth: 30 });
    expect(tagFiltered[1].items).toHaveLength(1);
    expect(tagFiltered[1].items[0].idShort).toBe("MT-105");

    const idFiltered = buildBoardColumns(tasks, { filterText: "104", columnWidth: 30 });
    expect(idFiltered[3].items).toHaveLength(1);
    expect(idFiltered[3].items[0].idShort).toBe("MT-104");
  });

  it("formats the status summary line shown above the board", () => {
    const summary = formatColumnSummary([
      { label: "TODO", count: 12 },
      { label: "IN PROGRESS", count: 5 },
      { label: "REVIEW", count: 3 },
      { label: "DONE", count: 47 },
    ]);

    expect(summary).toBe("TODO (12) | IN PROGRESS (5) | REVIEW (3) | DONE (47)");
  });

  it("marks list-style form fields for steps, acceptance criteria, and verification", () => {
    expect(LINE_LIST_FIELD_KEYS.has("stepsText")).toBe(true);
    expect(LINE_LIST_FIELD_KEYS.has("acceptanceCriteriaText")).toBe(true);
    expect(LINE_LIST_FIELD_KEYS.has("verificationText")).toBe(true);
  });

  it("sorts list rows by status and priority for narrow terminals", () => {
    const rows = buildListRows([
      { id: "MT-3", title: "done low", status: "done", priority: "low", tags: [] },
      { id: "MT-2", title: "review high", status: "inreview", priority: "high", tags: [] },
      { id: "MT-4", title: "todo medium", status: "todo", priority: "medium", tags: [] },
      { id: "MT-1", title: "todo critical", status: "todo", priority: "critical", tags: [] },
    ]);

    expect(rows.map((row) => row.idShort)).toEqual(["MT-1", "MT-4", "MT-2", "MT-3"]);
  });

  it("validates that title is required before submit", () => {
    expect(validateTaskForm({ title: "   " })).toEqual({ title: "Title is required" });
    expect(validateTaskForm({ title: "Wire up tasks" })).toEqual({});
  });

  it("parses structured description sections into form fields", () => {
    const parsed = parseTaskDescription(`Summary line\n\n## Implementation Steps\n- First\n- Second\n\n## Acceptance Criteria\n- Third\n\n## Verification\n- Fourth`);

    expect(parsed.description).toBe("Summary line");
    expect(parsed.steps).toEqual(["First", "Second"]);
    expect(parsed.acceptanceCriteria).toEqual(["Third"]);
    expect(parsed.verification).toEqual(["Fourth"]);
  });

  it("persists create, update, and delete through the task CLI API", async () => {
    const storePath = createTempStorePath();
    process.env.BOSUN_STORE_PATH = storePath;

    const created = await createTaskFromForm({
      title: "Ship terminal kanban",
      priority: "high",
      status: "in_progress",
      tagsText: "tui,kanban",
      description: "Implement CRUD",
      steps: ["Render four columns"],
      acceptanceCriteria: ["Counts render"],
      verification: ["Create task in TUI"],
    });

    expect(created.title).toBe("Ship terminal kanban");
    expect(normalizeTaskStatus(created.status)).toBe("in_progress");

    const createdStore = readStore(storePath);
    expect(Object.keys(createdStore.tasks || {})).toHaveLength(1);

    const updated = await updateTaskFromForm(created.id, {
      title: "Ship terminal kanban now",
      priority: "critical",
      status: "review",
      tagsText: "tui,release",
      description: "Implement CRUD and polish",
      steps: ["Render four columns", "Support filters"],
      acceptanceCriteria: ["Counts render", "Filters update immediately"],
      verification: ["Move task to review"],
    });

    expect(updated.title).toBe("Ship terminal kanban now");
    expect(normalizeTaskStatus(updated.status)).toBe("review");

    const listed = await taskList();
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toContain("## Implementation Steps");
    expect(listed[0].tags).toEqual(["tui", "release"]);

    const removed = await deleteTaskById(created.id);
    expect(removed).toBe(true);
    expect(Object.keys(readStore(storePath).tasks || {})).toHaveLength(0);
  });

  it("maps remote task CRUD onto the ui-server API contract", async () => {
    const requestJson = async (path, options = {}) => {
      if (path === "/api/tasks") {
        return { ok: true, data: [{ id: "task-1", title: "Remote", status: "todo" }] };
      }
      if (path === "/api/tasks/create") {
        return { ok: true, data: { id: "task-2", ...options.body } };
      }
      if (path === "/api/tasks/update") {
        return { ok: true, data: { id: options.body.taskId, ...options.body } };
      }
      if (path === "/api/tasks/task-3") {
        return { ok: true, deleted: true };
      }
      throw new Error(`Unexpected path ${path}`);
    };
    const taskApi = createTaskApiFromRequestJson(requestJson);

    await expect(listTasksFromApi({}, taskApi)).resolves.toEqual([
      { id: "task-1", title: "Remote", status: "todo" },
    ]);
    await expect(createTaskFromForm({ title: "Create remote task" }, taskApi)).resolves.toMatchObject({
      id: "task-2",
      title: "Create remote task",
    });
    await expect(updateTaskFromForm("task-2", { title: "Updated remote task" }, taskApi)).resolves.toMatchObject({
      id: "task-2",
      title: "Updated remote task",
    });
    await expect(deleteTaskById("task-3", taskApi)).resolves.toBe(true);
  });
});
