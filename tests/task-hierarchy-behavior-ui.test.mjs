import { describe, expect, it } from "vitest";

const bundles = await Promise.all([
  Promise.all([
    import("../ui/modules/task-hierarchy.js"),
    import("../ui/tabs/tasks.js"),
    import("../ui/components/kanban-board.js"),
  ]).then(([hierarchy, tasks, kanban]) => ({ label: "ui", hierarchy, tasks, kanban })),
  Promise.all([
    import("../site/ui/modules/task-hierarchy.js"),
    import("../site/ui/tabs/tasks.js"),
    import("../site/ui/components/kanban-board.js"),
  ]).then(([hierarchy, tasks, kanban]) => ({ label: "site/ui", hierarchy, tasks, kanban })),
]);

function createHierarchyTasks() {
  return [
    { id: "TASK-1", title: "Parent task", taskType: "task", status: "todo", assignee: "alice" },
    {
      id: "TASK-2",
      title: "Matching child",
      taskType: "subtask",
      parentTaskId: "TASK-1",
      status: "inprogress",
      assignee: "bob",
      labels: ["api", "ux"],
      dependencyTaskIds: ["EXT-9"],
      blockedReason: "Waiting on API parity",
      dueDate: "2026-04-11",
    },
    { id: "TASK-3", title: "Sibling child", taskType: "subtask", parentTaskId: "TASK-1", status: "done" },
    { id: "TASK-4", title: "Standalone task", taskType: "task", status: "todo" },
  ];
}

function createEpicTasks() {
  return [
    { id: "EPIC-1", title: "Epic shell", taskType: "epic", epicId: "EPIC-1", status: "todo" },
    { id: "TASK-10", title: "Epic child A", taskType: "task", epicId: "EPIC-1", status: "todo" },
    { id: "TASK-11", title: "Epic child B", taskType: "task", epicId: "EPIC-1", status: "todo" },
  ];
}

for (const { label, hierarchy, tasks, kanban } of bundles) {
  describe(`${label} task hierarchy behavior`, () => {
    it("keeps matched descendants attached and auto-expands collapsed parents during search", () => {
      const model = hierarchy.buildTaskHierarchyModel(createHierarchyTasks());
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-2",
      });
      const rows = tasks.buildHierarchicalTaskRows(view.rootNodes, {
        hasSearch: true,
        collapsedState: {
          [hierarchy.getTaskHierarchyCollapseKey("task", "TASK-1")]: true,
        },
      });

      expect(rows.map((row) => row.id)).toEqual(["TASK-1", "TASK-2"]);
      expect(rows[0].matchState).toBe("descendant");
      expect(rows[0].isExpanded).toBe(true);
      expect(rows[0].progressDone).toBe(1);
      expect(rows[0].progressTotal).toBe(2);
      expect(rows[1].depth).toBe(1);
    });

    it("shows the full child hierarchy when a parent matches search", () => {
      const model = hierarchy.buildTaskHierarchyModel(createHierarchyTasks());
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-1",
      });
      const rows = tasks.buildHierarchicalTaskRows(view.rootNodes, {
        hasSearch: true,
        collapsedState: {
          [hierarchy.getTaskHierarchyCollapseKey("task", "TASK-1")]: true,
        },
      });

      expect(rows.map((row) => row.id)).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
      expect(rows[0].matchState).toBe("self");
      expect(rows[1].depth).toBe(1);
      expect(rows[2].depth).toBe(1);
    });

    it("builds breadcrumb paths and preserves detail child-task metadata", () => {
      const fixture = createHierarchyTasks();
      const model = hierarchy.buildTaskHierarchyModel(fixture);
      const childTask = fixture.find((task) => task.id === "TASK-2");
      const path = tasks.buildTaskHierarchyPath(childTask, model);
      const normalized = tasks.normalizeSubtaskRow(childTask, "TASK-1");

      expect(path.map((entry) => entry.id)).toEqual(["TASK-1", "TASK-2"]);
      expect(normalized).toMatchObject({
        id: "TASK-2",
        parentTaskId: "TASK-1",
        taskType: "subtask",
        dueDate: "2026-04-11",
        blockedReason: "Waiting on API parity",
        dependencyTaskIds: ["EXT-9"],
        labels: ["api", "ux"],
      });
    });

    it("renders parent shells in kanban columns for grouped child work", () => {
      const fixture = createHierarchyTasks().filter((task) => task.id !== "TASK-3");
      const model = hierarchy.buildTaskHierarchyModel(fixture);
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: () => true,
      });
      const items = kanban.buildKanbanColumnItems(fixture, view, model);

      expect(items[0]).toMatchObject({
        kind: "group",
        group: {
          kind: "parent",
          parentTask: { id: "TASK-1" },
        },
      });
      expect(items[0].group.children.map((task) => task.id)).toEqual(["TASK-2"]);
      expect(items[1]).toMatchObject({
        kind: "task",
        task: { id: "TASK-4" },
      });
    });

    it("renders epic shells when multiple epic tasks stay visible in one column", () => {
      const fixture = createEpicTasks();
      const model = hierarchy.buildTaskHierarchyModel(fixture);
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: () => true,
      });
      const items = kanban.buildKanbanColumnItems(fixture, view, model);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "group",
        group: {
          kind: "epic",
          title: "Epic shell",
        },
      });
      expect(items[0].group.children.map((task) => task.id)).toEqual(["TASK-10", "TASK-11"]);
    });
  });
}
