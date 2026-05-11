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
      expect(rows[0].matchState).toBe("direct");
      expect(rows[0].isExpanded).toBe(true);
      expect(rows.slice(1).every((row) => row.depth === 1)).toBe(true);
    });

    it("builds hierarchy paths from model ancestry even when tasks use fallback parent fields", () => {
      const taskList = [
        { id: "EPIC-1", title: "Epic", taskType: "epic", epicId: "EPIC-1" },
        { id: "TASK-1", title: "Parent", taskType: "task", epicId: "EPIC-1" },
        { id: "TASK-2", title: "Child", taskType: "subtask", parentId: "TASK-1" },
      ];
      const model = hierarchy.buildTaskHierarchyModel(taskList);
      const path = tasks.buildTaskHierarchyPath(taskList[2], model);

      expect(path.map((entry) => entry.id)).toEqual(["TASK-1", "TASK-2"]);
    });

    it("normalizes subtasks from mixed payload shapes and preserves fallback parent linkage", () => {
      const normalized = tasks.normalizeSubtaskRow({
        taskId: "SUB-9",
        summary: "Nested child",
        state: "blocked",
        owner: "carol",
        type: "SubTask",
        points: 3,
        epic_id: "EPIC-1",
        due_at: "2026-05-02T10:15:00Z",
        meta: {
          blockedReason: "Waiting on dependency",
          dependencyTaskIds: ["TASK-77"],
          tags: ["backend", { name: "urgent" }],
          parentTaskId: "TASK-1",
        },
      }, "FALLBACK-PARENT");

      expect(normalized).toEqual({
        id: "SUB-9",
        title: "Nested child",
        status: "blocked",
        assignee: "carol",
        taskType: "subtask",
        storyPoints: "3",
        epicId: "EPIC-1",
        dueDate: "2026-05-02",
        blockedReason: "Waiting on dependency",
        dependencyTaskIds: ["TASK-77"],
        labels: ["backend", "urgent"],
        parentTaskId: "TASK-1",
      });
    });

    it("keeps kanban grouping aligned with hierarchy-filtered search results", () => {
      const model = hierarchy.buildTaskHierarchyModel(createEpicTasks());
      const view = hierarchy.deriveTaskHierarchyView(model, {
        matchTask: (task) => task.id === "TASK-10",
      });
      const columnItems = kanban.buildKanbanColumnItems(view.rootNodes, {
        hasSearch: true,
        collapsedState: {
          [hierarchy.getTaskHierarchyCollapseKey("epic", "EPIC-1")]: true,
        },
      });

      expect(columnItems.map((item) => item.id)).toEqual(["EPIC-1", "TASK-10"]);
      expect(columnItems[0].matchState).toBe("descendant");
      expect(columnItems[0].isExpanded).toBe(true);
      expect(new Set(columnItems.map((item) => item.id)).size).toBe(columnItems.length);
    });
  });
}
