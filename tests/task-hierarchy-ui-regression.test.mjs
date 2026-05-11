import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const uiHierarchy = await import("../ui/modules/task-hierarchy.js");
const siteHierarchy = await import("../site/ui/modules/task-hierarchy.js");
const uiTasks = await import("../ui/tabs/tasks.js");
const siteTasks = await import("../site/ui/tabs/tasks.js");

const taskTabSources = [
  "ui/tabs/tasks.js",
  "site/ui/tabs/tasks.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const kanbanSources = [
  "ui/components/kanban-board.js",
  "site/ui/components/kanban-board.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const taskStyleSources = [
  "ui/styles/components.css",
  "site/ui/styles/components.css",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const kanbanStyleSources = [
  "ui/styles/kanban.css",
  "site/ui/styles/kanban.css",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

describe("task hierarchy shared model", () => {
  it("normalizes collapse keys and preserves mirrored search visibility state", () => {
    expect(uiHierarchy.getTaskHierarchyCollapseKey(" Task ", " TASK-1 ")).toBe("tasks-hierarchy:task:TASK-1");
    expect(siteHierarchy.getTaskHierarchyCollapseKey("EPIC", "EPIC-1")).toBe("tasks-hierarchy:epic:EPIC-1");

    const tasks = [
      { id: "EPIC-1", title: "Epic", taskType: "epic", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-1", title: "Parent task", taskType: "task", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-2", title: "Matching child", taskType: "subtask", epicId: "EPIC-1", parentTaskId: "TASK-1", status: "inprogress" },
    ];

    for (const hierarchy of [uiHierarchy, siteHierarchy]) {
      const model = hierarchy.buildTaskHierarchyModel(tasks);
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-2",
      });
      expect([...view.visibleTaskIds].sort()).toEqual(["TASK-1", "TASK-2"]);
      expect(view.nodeStateById.get("TASK-1")?.searchMatchState).toBe("descendant");
      expect(view.nodeStateById.get("TASK-1")?.visibleChildIds).toEqual(["TASK-2"]);
    }
  });

  it("exports reusable hierarchy builders for both UI trees", () => {
    expect(typeof uiHierarchy.buildTaskHierarchyModel).toBe("function");
    expect(typeof uiHierarchy.deriveTaskHierarchyView).toBe("function");
    expect(typeof uiHierarchy.flattenTaskHierarchyView).toBe("function");
    expect(typeof siteHierarchy.buildTaskHierarchyModel).toBe("function");
    expect(typeof siteHierarchy.deriveTaskHierarchyView).toBe("function");
    expect(typeof siteHierarchy.flattenTaskHierarchyView).toBe("function");
    expect(typeof uiTasks.buildHierarchicalTaskRows).toBe("function");
    expect(typeof uiTasks.buildTaskHierarchyPath).toBe("function");
    expect(typeof uiTasks.normalizeSubtaskRow).toBe("function");
    expect(typeof siteTasks.buildHierarchicalTaskRows).toBe("function");
    expect(typeof siteTasks.buildTaskHierarchyPath).toBe("function");
    expect(typeof siteTasks.normalizeSubtaskRow).toBe("function");
  });

  it("keeps parents visible when only a child matches the current view", () => {
    const tasks = [
      { id: "EPIC-1", title: "Epic", taskType: "epic", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-1", title: "Parent", taskType: "task", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-2", title: "Child", taskType: "subtask", parentTaskId: "TASK-1", status: "inprogress" },
      { id: "TASK-3", title: "Sibling", taskType: "subtask", parentTaskId: "TASK-1", status: "todo" },
    ];

    for (const hierarchy of [uiHierarchy, siteHierarchy]) {
      const model = hierarchy.buildTaskHierarchyModel(tasks);
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-2",
      });
      const flattened = hierarchy.flattenTaskHierarchyView(view);

      expect(flattened.map((node) => node.id)).toEqual(["TASK-1", "TASK-2"]);
      expect(view.nodeStateById.get("TASK-1")?.searchMatchState).toBe("descendant");
      expect(view.nodeStateById.get("TASK-1")?.visibleChildIds).toEqual(["TASK-2"]);
    }
  });

  it("supports mixed parent linkage shapes without changing collapse key format", () => {
    const tasks = [
      { id: "TASK-1", title: "Parent", taskType: "task", status: "todo" },
      { id: "TASK-2", title: "Child A", taskType: "subtask", parentId: "TASK-1", status: "todo" },
      { id: "TASK-3", title: "Child B", taskType: "subtask", parent_task_id: "TASK-1", status: "todo" },
      { id: "TASK-4", title: "Child C", taskType: "subtask", meta: { parentTaskId: "TASK-1" }, status: "todo" },
    ];

    for (const hierarchy of [uiHierarchy, siteHierarchy]) {
      const model = hierarchy.buildTaskHierarchyModel(tasks);
      expect(model.childIdsByParentId.get("TASK-1")).toEqual(["TASK-2", "TASK-3", "TASK-4"]);
      expect(hierarchy.getTaskHierarchyCollapseKey("task", "TASK-1")).toBe("tasks-hierarchy:task:TASK-1");
    }
  });
});

describe("task hierarchy mirrored source regressions", () => {
  it("keeps task tab hierarchy helpers and breadcrumb hooks wired in both bundles", () => {
    for (const { relPath, source } of taskTabSources) {
      expect(source).toContain("export function normalizeSubtaskRow");
      expect(source).toContain("export function buildTaskHierarchyPath");
      expect(source).toContain("export function buildHierarchicalTaskRows");
      expect(source).toContain("matchState");
      expect(source).toContain("autoExpanded");
      expect(source).toContain("hierarchyPath");
      expect(source).toContain("task-hierarchy-summary");
      expect(source).toContain("task-hierarchy-crumb");
      expect(source).toContain("parent_task_id");
      expect(source).toContain("meta?.parentTaskId");
      expect(source).toContain("due_at");
      expect(source).toContain("dependencyTaskIds");
      expect(source).toContain("normalizeTaskDueDateInput");
      expect(source).toContain("normalizeDependencyInput");
      expect(source).toContain("normalizeTagInput");
      expect(source).toContain("forceShowDescendants");
    }
  });

  it("keeps kanban hierarchy affordances and mirrored styles present", () => {
    for (const { relPath, source } of kanbanSources) {
      expect(source).toContain("kanban-group-shell");
      expect(source).toContain("buildKanbanColumnItems");
      expect(source).toContain("visibleTaskIds");
      expect(source).toContain("forceExpanded");
    }

    for (const { relPath, source } of taskStyleSources) {
      expect(source).toContain(".task-hierarchy-summary");
      expect(source).toContain(".task-hierarchy-crumb");
    }

    for (const { relPath, source } of kanbanStyleSources) {
      expect(source).toContain(".kanban-group-shell");
      expect(source).toContain(".kanban-group-children");
      expect(source).toContain(".kanban-checklist-row");
      expect(source).toContain(".kanban-icon-cap");
    }
  });
});
