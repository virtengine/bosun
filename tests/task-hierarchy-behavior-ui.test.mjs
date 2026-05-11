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

function createDeepHierarchyTasks() {
  return [
    { id: "TASK-100", title: "Root parent", taskType: "task", status: "todo" },
    { id: "TASK-101", title: "First branch", taskType: "subtask", parentTaskId: "TASK-100", status: "todo" },
    { id: "TASK-102", title: "Grandchild match", taskType: "subtask", parentTaskId: "TASK-101", status: "inprogress" },
    { id: "TASK-103", title: "Other grandchild", taskType: "subtask", parentTaskId: "TASK-101", status: "todo" },
    { id: "TASK-104", title: "Sibling branch", taskType: "subtask", parentTaskId: "TASK-100", status: "todo" },
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

    it("shows only the matching descendant branch during search while hiding unrelated siblings", () => {
      const model = hierarchy.buildTaskHierarchyModel(createDeepHierarchyTasks());
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-102",
      });
      const rows = tasks.buildHierarchicalTaskRows(view.rootNodes, {
        hasSearch: true,
        collapsedState: {
          [hierarchy.getTaskHierarchyCollapseKey("task", "TASK-100")]: true,
          [hierarchy.getTaskHierarchyCollapseKey("subtask", "TASK-101")]: true,
        },
      });

      expect(rows.map((row) => row.id)).toEqual(["TASK-100", "TASK-101", "TASK-102"]);
      expect(rows.map((row) => row.depth)).toEqual([0, 1, 2]);
      expect(rows[0].matchState).toBe("descendant");
      expect(rows[1].matchState).toBe("descendant");
      expect(rows[2].matchState).toBe("direct");
      expect(rows[0].isExpanded).toBe(true);
      expect(rows[1].isExpanded).toBe(true);
      expect(rows.some((row) => row.id === "TASK-103")).toBe(false);
      expect(rows.some((row) => row.id === "TASK-104")).toBe(false);
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
      expect(rows[0].matchState).toBe("direct");
      expect(rows[0].isExpanded).toBe(true);
      expect(rows.slice(1).every((row) => row.depth === 1)).toBe(true);
    });

    it("builds hierarchy paths through fallback parent keys", () => {
      const parent = tasks.normalizeSubtaskRow({
        id: "TASK-20",
        title: "Fallback parent",
        taskType: "task",
      });
      const child = tasks.normalizeSubtaskRow({
        id: "TASK-21",
        title: "Fallback child",
        taskType: "subtask",
        parentId: "TASK-20",
      });
      const path = tasks.buildTaskHierarchyPath(child, new Map([
        [parent.id, parent],
        [child.id, child],
      ]));

      expect(child.parentTaskId).toBe("TASK-20");
      expect(path.map((entry) => entry.id)).toEqual(["TASK-20", "TASK-21"]);
    });

    it("groups epic tasks for kanban columns without duplicating child cards", () => {
      const items = createEpicTasks();
      const model = hierarchy.buildTaskHierarchyModel(items);
      const view = hierarchy.deriveTaskHierarchyView(model);
      const columnItems = kanban.buildKanbanColumnItems(model.tasks, view, model);

      expect(columnItems).toHaveLength(1);
      expect(columnItems[0].kind).toBe("group");
      expect(columnItems[0].group.kind).toBe("epic");
      expect(columnItems[0].group.parentTask.id).toBe("EPIC-1");
      expect(columnItems[0].group.children.map((task) => task.id)).toEqual(["TASK-10", "TASK-11"]);

      const grouped = kanban.groupTasksByStatus(items, {
        statuses: ["todo"],
        hierarchyMode: true,
      });
      expect(grouped.todo).toHaveLength(1);
      expect(grouped.todo[0].id).toBe("EPIC-1");
      expect(grouped.todo[0].childTasks.map((task) => task.id)).toEqual(["TASK-10", "TASK-11"]);
    });
  });
}
