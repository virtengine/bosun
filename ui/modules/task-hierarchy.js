function toText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

const TERMINAL_STATUSES = new Set(["done", "completed", "closed", "merged", "cancelled"]);
const BLOCKED_STATUSES = new Set(["blocked", "error", "failed"]);
const KNOWN_TASK_TYPES = new Set(["epic", "task", "subtask"]);

export function getTaskHierarchyTaskType(task, fallback = "task") {
  const normalized = toText(
    task?.taskType
      || task?.type
      || task?.kind
      || task?.meta?.taskType
      || task?.meta?.type,
    fallback,
  ).toLowerCase();
  return KNOWN_TASK_TYPES.has(normalized) ? normalized : fallback;
}

export function getTaskHierarchyEpicId(task) {
  return toText(
    task?.epicId
      || task?.epic
      || task?.epic_id
      || task?.meta?.epicId
      || task?.meta?.epic
      || task?.meta?.epic_id,
  );
}

export function getTaskHierarchyParentTaskId(task) {
  return toText(
    task?.parentTaskId
      || task?.parentId
      || task?.parent_task_id
      || task?.meta?.parentTaskId
      || task?.meta?.parentId
      || task?.meta?.parent_task_id,
  );
}

export function getTaskHierarchyCollapseKey(kind, id) {
  const normalizedKind = toText(kind, "task").toLowerCase();
  const normalizedId = toText(id, "unknown");
  return `tasks-hierarchy:${normalizedKind}:${normalizedId}`;
}

function normalizeSupplementalSubtasks(subtasksByParentId = {}) {
  const normalized = new Map();
  for (const [rawParentId, rawChildren] of Object.entries(subtasksByParentId || {})) {
    const parentId = toText(rawParentId);
    if (!parentId) continue;
    const rows = Array.isArray(rawChildren) ? rawChildren : [];
    const children = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = toText(row.id || row.taskId);
      if (!id || seen.has(id) || id === parentId) continue;
      seen.add(id);
      children.push({
        id,
        title: toText(row.title || row.summary || row.name, "(untitled subtask)"),
        status: toText(row.status || row.state),
        assignee: toText(row.assignee || row.owner),
        storyPoints: toText(row.storyPoints || row.points),
        parentTaskId: parentId,
        taskType: "subtask",
        _hierarchySupplemental: true,
      });
    }
    if (children.length > 0) normalized.set(parentId, children);
  }
  return normalized;
}

function createEmptyNodeState(entry = {}) {
  return {
    ...entry,
    childIds: [],
    visibleChildIds: [],
    totalChildCount: 0,
    visibleChildCount: 0,
    descendantCount: 0,
    visibleDescendantCount: 0,
    completedChildCount: 0,
    blockedChildCount: 0,
    completedDescendantCount: 0,
    blockedDescendantCount: 0,
    searchMatchState: "none",
    directMatch: false,
    descendantMatch: false,
    visible: false,
  };
}

export function buildTaskHierarchyModel(tasks = [], options = {}) {
  const taskList = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task === "object") : [];
  const taskById = new Map();
  const originalOrderById = new Map();
  const childIdsByParentId = new Map();
  const rootTaskIds = [];
  const parentTaskIds = [];
  const epicGroups = new Map();
  const supplementalSubtasks = normalizeSupplementalSubtasks(options?.subtasksByParentId || {});
  const supplementalParentByChildId = new Map();

  const registerTask = (task, order, extra = {}) => {
    const id = toText(task?.id || task?.taskId);
    if (!id) return null;
    if (!taskById.has(id)) {
      taskById.set(id, { ...task, ...extra });
      originalOrderById.set(id, order);
      return taskById.get(id);
    }
    const next = { ...taskById.get(id), ...extra };
    taskById.set(id, next);
    if (!originalOrderById.has(id)) originalOrderById.set(id, order);
    return next;
  };

  taskList.forEach((task, index) => {
    registerTask(task, index);
  });

  let supplementalIndex = taskList.length;
  for (const [parentId, children] of supplementalSubtasks.entries()) {
    for (const child of children) {
      supplementalParentByChildId.set(child.id, parentId);
      registerTask(child, supplementalIndex++, child);
    }
  }

  const taskMetaById = new Map();
  for (const [id, task] of taskById.entries()) {
    const taskType = getTaskHierarchyTaskType(task);
    const epicId = getTaskHierarchyEpicId(task);
    const parentTaskId = getTaskHierarchyParentTaskId(task) || supplementalParentByChildId.get(id) || "";
    taskMetaById.set(id, {
      id,
      taskType,
      epicId,
      parentTaskId,
      collapseKey: getTaskHierarchyCollapseKey("task", id),
      epicCollapseKey: epicId ? getTaskHierarchyCollapseKey("epic", epicId) : "",
    });
  }

  const appendChildId = (parentId, childId) => {
    const parentKey = toText(parentId);
    const childKey = toText(childId);
    if (!parentKey || !childKey || parentKey === childKey) return;
    const existing = childIdsByParentId.get(parentKey) || [];
    if (existing.includes(childKey)) return;
    existing.push(childKey);
    existing.sort((left, right) => (originalOrderById.get(left) || 0) - (originalOrderById.get(right) || 0));
    childIdsByParentId.set(parentKey, existing);
  };

  for (const [id, meta] of taskMetaById.entries()) {
    if (meta.parentTaskId && taskById.has(meta.parentTaskId)) appendChildId(meta.parentTaskId, id);
  }
  for (const [parentId, children] of supplementalSubtasks.entries()) {
    if (!taskById.has(parentId)) continue;
    for (const child of children) appendChildId(parentId, child.id);
  }

  for (const [id, task] of taskById.entries()) {
    const meta = taskMetaById.get(id);
    const hasParent = meta?.parentTaskId && taskById.has(meta.parentTaskId) && meta.parentTaskId !== id;
    if (!hasParent) rootTaskIds.push(id);
    const childIds = childIdsByParentId.get(id) || [];
    if (childIds.length > 0) parentTaskIds.push(id);

    if (meta?.epicId) {
      if (!epicGroups.has(meta.epicId)) {
        epicGroups.set(meta.epicId, {
          id: meta.epicId,
          label: meta.epicId,
          taskIds: [],
          rootTaskIds: [],
          parentTaskIds: [],
          collapseKey: getTaskHierarchyCollapseKey("epic", meta.epicId),
          anchorTaskId: "",
        });
      }
      const group = epicGroups.get(meta.epicId);
      group.taskIds.push(id);
      if (!hasParent) group.rootTaskIds.push(id);
      if (childIds.length > 0) group.parentTaskIds.push(id);
      if (meta.taskType === "epic") {
        group.anchorTaskId = id;
        group.label = toText(task?.title, meta.epicId);
      } else if (!group.anchorTaskId && !group.label) {
        group.label = toText(task?.title, meta.epicId);
      }
    }
  }

  rootTaskIds.sort((left, right) => (originalOrderById.get(left) || 0) - (originalOrderById.get(right) || 0));
  parentTaskIds.sort((left, right) => (originalOrderById.get(left) || 0) - (originalOrderById.get(right) || 0));

  const epicGroupsOrdered = [...epicGroups.values()]
    .map((group) => ({
      ...group,
      taskIds: [...new Set(group.taskIds)],
      rootTaskIds: [...new Set(group.rootTaskIds)],
      parentTaskIds: [...new Set(group.parentTaskIds)],
    }))
    .sort((left, right) => {
      const leftOrder = left.anchorTaskId ? (originalOrderById.get(left.anchorTaskId) || 0) : Number.MAX_SAFE_INTEGER;
      const rightOrder = right.anchorTaskId ? (originalOrderById.get(right.anchorTaskId) || 0) : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.label || left.id).localeCompare(String(right.label || right.id));
    });

  return {
    tasks: [...taskById.values()].sort((left, right) => (originalOrderById.get(toText(left?.id)) || 0) - (originalOrderById.get(toText(right?.id)) || 0)),
    taskById,
    taskMetaById,
    childIdsByParentId,
    rootTaskIds,
    parentTaskIds,
    epicGroups: epicGroupsOrdered,
    originalOrderById,
    supplementalSubtasksByParentId: supplementalSubtasks,
  };
}

export function deriveTaskHierarchyView(model, options = {}) {
  const hierarchyModel = model && typeof model === "object" ? model : buildTaskHierarchyModel([]);
  const matchTask = typeof options?.matchTask === "function" ? options.matchTask : () => true;
  const nodeStateById = new Map();
  const visited = new Set();

  const visit = (taskId, ancestry = new Set()) => {
    const id = toText(taskId);
    if (!id) return createEmptyNodeState({ id: "" });
    if (nodeStateById.has(id)) return nodeStateById.get(id);
    if (ancestry.has(id)) {
      const cycleState = createEmptyNodeState({
        id,
        task: hierarchyModel.taskById.get(id) || null,
        meta: hierarchyModel.taskMetaById.get(id) || null,
      });
      nodeStateById.set(id, cycleState);
      return cycleState;
    }

    const task = hierarchyModel.taskById.get(id) || null;
    const meta = hierarchyModel.taskMetaById.get(id) || null;
    const childIds = [...(hierarchyModel.childIdsByParentId.get(id) || [])];
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(id);
    const childStates = childIds.map((childId) => visit(childId, nextAncestry));
    const directMatch = Boolean(task) && Boolean(matchTask(task));
    const visibleChildIds = childStates.filter((entry) => entry.visible).map((entry) => entry.id);
    const descendantCount = childStates.reduce((sum, entry) => sum + 1 + entry.descendantCount, 0);
    const visibleDescendantCount = childStates.reduce((sum, entry) => sum + (entry.visible ? 1 : 0) + entry.visibleDescendantCount, 0);
    const completedChildCount = childStates.reduce((sum, entry) => {
      const childStatus = toText(entry.task?.status).toLowerCase();
      return sum + (TERMINAL_STATUSES.has(childStatus) ? 1 : 0);
    }, 0);
    const blockedChildCount = childStates.reduce((sum, entry) => {
      const childStatus = toText(entry.task?.status).toLowerCase();
      return sum + (BLOCKED_STATUSES.has(childStatus) ? 1 : 0);
    }, 0);
    const completedDescendantCount = childStates.reduce((sum, entry) => {
      const childStatus = toText(entry.task?.status).toLowerCase();
      return sum + (TERMINAL_STATUSES.has(childStatus) ? 1 : 0) + entry.completedDescendantCount;
    }, 0);
    const blockedDescendantCount = childStates.reduce((sum, entry) => {
      const childStatus = toText(entry.task?.status).toLowerCase();
      return sum + (BLOCKED_STATUSES.has(childStatus) ? 1 : 0) + entry.blockedDescendantCount;
    }, 0);
    const descendantMatch = visibleChildIds.length > 0;
    const visible = directMatch || descendantMatch;
    const searchMatchState = directMatch ? "self" : descendantMatch ? "descendant" : "none";
    const state = {
      id,
      task,
      meta,
      childIds,
      children: childStates,
      visibleChildIds,
      totalChildCount: childIds.length,
      visibleChildCount: visibleChildIds.length,
      descendantCount,
      visibleDescendantCount,
      completedChildCount,
      blockedChildCount,
      completedDescendantCount,
      blockedDescendantCount,
      directMatch,
      descendantMatch,
      visible,
      searchMatchState,
      collapseKey: meta?.collapseKey || getTaskHierarchyCollapseKey("task", id),
      isParentNode: childIds.length > 0,
    };
    nodeStateById.set(id, state);
    visited.add(id);
    return state;
  };

  for (const taskId of hierarchyModel.rootTaskIds || []) visit(taskId);
  for (const taskId of hierarchyModel.taskById.keys()) {
    if (!visited.has(taskId)) visit(taskId);
  }

  const visibleTaskIds = new Set();
  const directMatchTaskIds = new Set();
  const descendantMatchTaskIds = new Set();
  const parentNodes = [];
  for (const [id, state] of nodeStateById.entries()) {
    if (state.visible) visibleTaskIds.add(id);
    if (state.directMatch) directMatchTaskIds.add(id);
    if (state.descendantMatch) descendantMatchTaskIds.add(id);
    if (state.isParentNode) parentNodes.push(state);
  }

  const epicGroups = (hierarchyModel.epicGroups || []).map((group) => {
    const visibleTaskIdsForEpic = group.taskIds.filter((taskId) => nodeStateById.get(taskId)?.visible);
    const completedCount = group.taskIds.reduce((sum, taskId) => {
      const task = hierarchyModel.taskById.get(taskId);
      return sum + (TERMINAL_STATUSES.has(toText(task?.status).toLowerCase()) ? 1 : 0);
    }, 0);
    const blockedCount = group.taskIds.reduce((sum, taskId) => {
      const task = hierarchyModel.taskById.get(taskId);
      return sum + (BLOCKED_STATUSES.has(toText(task?.status).toLowerCase()) ? 1 : 0);
    }, 0);
    const parentNodeIds = group.parentTaskIds.filter((taskId) => nodeStateById.get(taskId)?.isParentNode);
    return {
      ...group,
      visibleTaskIds: visibleTaskIdsForEpic,
      visibleTaskCount: visibleTaskIdsForEpic.length,
      visibleRootTaskIds: group.rootTaskIds.filter((taskId) => nodeStateById.get(taskId)?.visible),
      visibleParentTaskIds: parentNodeIds.filter((taskId) => nodeStateById.get(taskId)?.visible),
      completedCount,
      blockedCount,
      searchMatchState: visibleTaskIdsForEpic.length > 0 ? "match" : "none",
    };
  });

  return {
    model: hierarchyModel,
    nodeStateById,
    visibleTaskIds,
    directMatchTaskIds,
    descendantMatchTaskIds,
    rootNodes: (hierarchyModel.rootTaskIds || []).map((taskId) => nodeStateById.get(taskId)).filter(Boolean),
    visibleRootNodes: (hierarchyModel.rootTaskIds || []).map((taskId) => nodeStateById.get(taskId)).filter((entry) => entry?.visible),
    parentNodes: parentNodes.sort((left, right) => (hierarchyModel.originalOrderById.get(left.id) || 0) - (hierarchyModel.originalOrderById.get(right.id) || 0)),
    epicGroups,
  };
}

export function flattenTaskHierarchyView(view, options = {}) {
  const hierarchyView = view && typeof view === "object" ? view : deriveTaskHierarchyView(buildTaskHierarchyModel([]));
  const includeHidden = options?.includeHidden === true;
  const out = [];
  const visited = new Set();
  const append = (entry) => {
    if (!entry || !entry.id || visited.has(entry.id)) return;
    visited.add(entry.id);
    if (includeHidden || entry.visible) out.push(entry.task);
    for (const child of entry.children || []) append(child);
  };
  for (const root of hierarchyView.rootNodes || []) append(root);
  return out.filter(Boolean);
}
