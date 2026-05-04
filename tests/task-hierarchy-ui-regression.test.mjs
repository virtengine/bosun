import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const uiHierarchy = await import("../ui/modules/task-hierarchy.js");
const siteHierarchy = await import("../site/ui/modules/task-hierarchy.js");

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
  it("exports reusable hierarchy builders for both UI trees", () => {
    expect(typeof uiHierarchy.buildTaskHierarchyModel).toBe("function");
    expect(typeof uiHierarchy.deriveTaskHierarchyView).toBe("function");
    expect(typeof uiHierarchy.flattenTaskHierarchyView).toBe("function");
    expect(typeof siteHierarchy.buildTaskHierarchyModel).toBe("function");
    expect(typeof siteHierarchy.deriveTaskHierarchyView).toBe("function");
    expect(typeof siteHierarchy.flattenTaskHierarchyView).toBe("function");
  });

  it("keeps parents visible when only a child matches the current view", () => {
    const tasks = [
      { id: "EPIC-1", title: "Epic", taskType: "epic", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-1", title: "Parent task", taskType: "task", epicId: "EPIC-1", status: "todo" },
      { id: "TASK-2", title: "Matching child", taskType: "subtask", epicId: "EPIC-1", parentTaskId: "TASK-1", status: "inprogress" },
    ];
    const model = uiHierarchy.buildTaskHierarchyModel(tasks);
    const view = uiHierarchy.deriveTaskHierarchyView(model, {
      matchTask: (task) => String(task?.title || "").includes("Matching child"),
    });
    const flattened = uiHierarchy.flattenTaskHierarchyView(view);

    expect(flattened.map((task) => task.id)).toEqual(["TASK-1", "TASK-2"]);
    expect(view.nodeStateById.get("TASK-1")?.searchMatchState).toBe("descendant");
    expect(view.nodeStateById.get("TASK-1")?.visibleChildCount).toBe(1);
    expect(view.nodeStateById.get("TASK-1")?.collapseKey).toBe("tasks-hierarchy:task:TASK-1");
    expect(view.epicGroups[0]?.collapseKey).toBe("tasks-hierarchy:epic:EPIC-1");
    expect(view.epicGroups[0]?.visibleTaskCount).toBe(2);
  });
});

for (const { relPath, source } of taskTabSources) {
  describe(`Tasks hierarchy wiring (${relPath})`, () => {
    it("builds a shared hierarchy model and passes it into task detail", () => {
      expect(source).toContain("buildTaskHierarchyModel");
      expect(source).toContain("deriveTaskHierarchyView");
      expect(source).toContain("flattenTaskHierarchyView");
      expect(source).toContain("const sharedTaskHierarchyModel = useMemo(");
      expect(source).toContain("const sharedTaskHierarchyView = useMemo(");
      expect(source).toContain("hierarchyNodeState=${sharedTaskHierarchyView.nodeStateById.get(String(detailTask?.id || \"\")) || null}");
      expect(source).toContain("onUpdateHierarchySubtasks=${handleHierarchySubtasksUpdate}");
    });

    it("renders a hierarchical Jira-style list with disclosure, inline status, and child creation", () => {
      expect(source).toContain("buildHierarchicalTaskRows(");
      expect(source).toContain("toggleHierarchyRow(");
      expect(source).toContain("handleQuickCreateChildTask");
      expect(source).toContain('role="tree" aria-label="Task hierarchy list"');
      expect(source).toContain('class="task-tree-row');
      expect(source).toContain('class="task-tree-disclosure"');
      expect(source).toContain('aria-expanded=${row.hasChildren ? String(row.isExpanded) : undefined}');
      expect(source).toContain('aria-label=${row.isExpanded ? "Collapse children" : "Expand children"}');
      expect(source).toContain('className="task-tree-status-select"');
      expect(source).toContain("Matched child");
      expect(source).toContain("+ Child");
      expect(source).toContain("progressTotal > 0");
    });

    it("keeps task detail hierarchy panels and child-work controls aligned", () => {
      expect(source).toContain("task-hierarchy-summary");
      expect(source).toContain("task-hierarchy-crumb");
      expect(source).toContain("Child Work");
      expect(source).toContain("handleInlineSubtaskUpdate");
      expect(source).toContain("task-subtask-controls");
      expect(source).toContain("task-subtask-open");
      expect(source).toContain("task-sidebar-group-title");
      expect(source).toContain("Planning Adjustments");
      expect(source).toContain("Execution Activity");
      expect(source).toContain("onOpenTask=${openDetail}");
    });
  });
}

for (const { relPath, source } of kanbanSources) {
  describe(`Kanban hierarchy wiring (${relPath})`, () => {
    it("derives filtered board tasks from the shared hierarchy view", () => {
      expect(source).toContain("buildTaskHierarchyModel");
      expect(source).toContain("deriveTaskHierarchyView");
      expect(source).toContain("const sharedHierarchyModel = useMemo(");
      expect(source).toContain("const hierarchyView = useMemo(() => deriveTaskHierarchyView");
      expect(source).toContain("[...hierarchyView.visibleTaskIds]");
    });

    it("renders parent shells instead of only isolated child cards", () => {
      expect(source).toContain("buildKanbanColumnItems(");
      expect(source).toContain("KanbanGroupShell");
      expect(source).toContain('kind: "group"');
      expect(source).toContain("kanban-group-shell");
      expect(source).toContain("kanban-group-children");
      expect(source).toContain("forceExpanded");
      expect(source).toContain("kanban-group-shell-toggle");
      expect(source).toContain("kanban-group-shell-open");
      expect(source).toContain("compact=${group?.kind !== \"epic\"}");
    });
  });
}

for (const { relPath, source } of taskStyleSources) {
  describe(`Task hierarchy list styles (${relPath})`, () => {
    it("defines tree-row, disclosure, and action styling for the hierarchical list", () => {
      expect(source).toContain(".task-list-header");
      expect(source).toContain(".task-tree-row");
      expect(source).toContain(".task-tree-main");
      expect(source).toContain(".task-tree-disclosure");
      expect(source).toContain(".task-tree-progress-pill");
      expect(source).toContain(".task-tree-action-btn");
      expect(source).toContain(".task-tree-status-select");
    });

    it("defines task-detail hierarchy summary and child work styling", () => {
      expect(source).toContain(".task-hierarchy-summary");
      expect(source).toContain(".task-inline-link-btn");
      expect(source).toContain(".task-sidebar-group-title");
      expect(source).toContain(".task-child-work-list");
      expect(source).toContain(".task-subtask-row");
    });
  });
}

for (const { relPath, source } of kanbanStyleSources) {
  describe(`Kanban hierarchy styles (${relPath})`, () => {
    it("defines grouped shell, checklist child rows, and icon caps", () => {
      expect(source).toContain(".kanban-group-shell");
      expect(source).toContain(".kanban-group-children");
      expect(source).toContain(".kanban-checklist-row");
      expect(source).toContain(".kanban-icon-cap");
      expect(source).toContain(".kanban-group-pill");
    });
  });
}
