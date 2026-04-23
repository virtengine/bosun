/**
 * workflow-flowchart-utils.mjs — Browser-safe flowchart helpers.
 *
 * Extracted from workflow/workflow-serializer.mjs so the UI can import the
 * flowchart normalization/derivation helpers without pulling in Node-only
 * dependencies (e.g. `node:crypto`).
 *
 * This module is served by the UI server at `/lib/workflow-flowchart-utils.mjs`
 * and is also re-imported by `workflow/workflow-serializer.mjs` on the Node
 * side so there is a single source of truth for the flowchart logic.
 */

export function cloneJsonValue(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

export function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value))
    .filter(Boolean))];
}

export function normalizePosition(position, fallback = null) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  return fallback;
}

export function buildNodePosition(node) {
  return normalizePosition(node?.position, { x: 0, y: 0 });
}

export function computeStepPosition(nodes = []) {
  if (!Array.isArray(nodes) || nodes.length === 0) return { x: 0, y: 0 };
  const positions = nodes.map((node) => buildNodePosition(node));
  const total = positions.reduce((acc, position) => ({
    x: acc.x + position.x,
    y: acc.y + position.y,
  }), { x: 0, y: 0 });
  return {
    x: Math.round(total.x / positions.length),
    y: Math.round(total.y / positions.length),
  };
}

export function normalizeFlowchartGroup(group, nodeIdSet = new Set()) {
  if (!group || typeof group !== "object") return null;
  const nodeIds = uniqueStrings(group.nodeIds).filter((nodeId) => nodeIdSet.size === 0 || nodeIdSet.has(nodeId));
  if (!nodeIds.length) return null;
  return {
    id: normalizeText(group.id),
    label: normalizeText(group.label || group.name, "Group"),
    color: normalizeText(group.color, "#60a5fa"),
    nodeIds,
  };
}

export function buildDerivedFlowchart(workflow = {}) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  const nodeMap = new Map(nodes.map((node) => [normalizeText(node?.id), node]).filter(([id]) => id));
  const nodeIdSet = new Set(nodeMap.keys());
  const groups = (Array.isArray(workflow?.groups) ? workflow.groups : [])
    .map((group) => normalizeFlowchartGroup(group, nodeIdSet))
    .filter((group) => group && group.id && group.nodeIds.length > 1);

  const claimedNodeIds = new Set();
  const steps = [];
  for (const group of groups) {
    const runtimeNodeIds = group.nodeIds.filter((nodeId) => !claimedNodeIds.has(nodeId) && nodeMap.has(nodeId));
    if (runtimeNodeIds.length < 2) continue;
    for (const nodeId of runtimeNodeIds) claimedNodeIds.add(nodeId);
    const memberNodes = runtimeNodeIds.map((nodeId) => nodeMap.get(nodeId)).filter(Boolean);
    steps.push({
      id: `group:${group.id}`,
      label: group.label,
      kind: "group",
      groupId: group.id,
      runtimeNodeIds,
      primaryNodeId: runtimeNodeIds[0],
      position: computeStepPosition(memberNodes),
      color: group.color,
    });
  }

  for (const node of nodes) {
    const nodeId = normalizeText(node?.id);
    if (!nodeId || claimedNodeIds.has(nodeId)) continue;
    steps.push({
      id: `node:${nodeId}`,
      label: normalizeText(node?.label, nodeId),
      kind: "node",
      groupId: "",
      runtimeNodeIds: [nodeId],
      primaryNodeId: nodeId,
      position: buildNodePosition(node),
    });
  }

  const runtimeNodeToStepId = new Map();
  for (const step of steps) {
    for (const nodeId of step.runtimeNodeIds) runtimeNodeToStepId.set(nodeId, step.id);
  }

  const links = [];
  const seenLinks = new Map();
  for (const edge of edges) {
    const sourceNodeId = normalizeText(edge?.source);
    const targetNodeId = normalizeText(edge?.target);
    const sourceStepId = runtimeNodeToStepId.get(sourceNodeId);
    const targetStepId = runtimeNodeToStepId.get(targetNodeId);
    if (!sourceStepId || !targetStepId || sourceStepId === targetStepId) continue;
    const dedupeKey = `${sourceStepId}->${targetStepId}`;
    if (!seenLinks.has(dedupeKey)) {
      const nextLink = {
        id: normalizeText(edge?.id, dedupeKey),
        sourceStepId,
        targetStepId,
        edgeIds: uniqueStrings([edge?.id].filter(Boolean)),
      };
      if (normalizeText(edge?.label)) nextLink.label = normalizeText(edge.label);
      if (normalizeText(edge?.condition)) nextLink.condition = normalizeText(edge.condition);
      links.push(nextLink);
      seenLinks.set(dedupeKey, nextLink);
      continue;
    }
    const existing = seenLinks.get(dedupeKey);
    existing.edgeIds = uniqueStrings([...(existing.edgeIds || []), edge?.id].filter(Boolean));
    if (!existing.label && normalizeText(edge?.label)) existing.label = normalizeText(edge.label);
    if (!existing.condition && normalizeText(edge?.condition)) existing.condition = normalizeText(edge.condition);
  }

  return {
    version: 1,
    source: "derived",
    steps,
    links,
  };
}

export function normalizeFlowchartStep(step, index = 0, workflowNodeIdSet = null) {
  if (!step || typeof step !== "object") return null;
  const runtimeNodeIds = uniqueStrings(step.runtimeNodeIds ?? step.nodeIds ?? step.nodes ?? step.runtimeNodes ?? []);
  const filteredRuntimeNodeIds = workflowNodeIdSet instanceof Set
    ? runtimeNodeIds.filter((nodeId) => workflowNodeIdSet.has(nodeId))
    : runtimeNodeIds;
  const primaryNodeId = normalizeText(step.primaryNodeId || step.nodeId || filteredRuntimeNodeIds[0]);
  const groupId = normalizeText(step.groupId || step.clusterId);
  const id = normalizeText(step.id || step.stepId || groupId || primaryNodeId || `step-${index + 1}`);
  const label = normalizeText(step.label || step.title || primaryNodeId || id, id);
  return {
    id,
    label,
    kind: normalizeText(step.kind || (groupId ? "group" : "node"), "node"),
    groupId,
    runtimeNodeIds: filteredRuntimeNodeIds,
    primaryNodeId: primaryNodeId || filteredRuntimeNodeIds[0] || "",
    position: normalizePosition(step.position, null),
    ...(normalizeText(step.description) ? { description: normalizeText(step.description) } : {}),
    ...(normalizeText(step.color) ? { color: normalizeText(step.color) } : {}),
  };
}

export function normalizeFlowchartLink(link, index = 0, stepIdSet = null) {
  if (!link || typeof link !== "object") return null;
  const sourceStepId = normalizeText(link.sourceStepId || link.source || link.from);
  const targetStepId = normalizeText(link.targetStepId || link.target || link.to);
  if (!sourceStepId || !targetStepId) return null;
  if (stepIdSet instanceof Set && (!stepIdSet.has(sourceStepId) || !stepIdSet.has(targetStepId))) return null;
  const normalized = {
    id: normalizeText(link.id, `link-${index + 1}`),
    sourceStepId,
    targetStepId,
    edgeIds: uniqueStrings(link.edgeIds ?? link.runtimeEdgeIds ?? link.edges ?? []),
  };
  if (normalizeText(link.label)) normalized.label = normalizeText(link.label);
  if (normalizeText(link.condition)) normalized.condition = normalizeText(link.condition);
  return normalized;
}

export function normalizeWorkflowFlowchartMetadata(flowchart, workflow = null) {
  if (!flowchart || typeof flowchart !== "object") return null;
  const workflowNodeIdSet = workflow && Array.isArray(workflow?.nodes)
    ? new Set((workflow.nodes || []).map((node) => normalizeText(node?.id)).filter(Boolean))
    : null;
  const rawSteps = Array.isArray(flowchart?.steps) ? flowchart.steps : (Array.isArray(flowchart?.nodes) ? flowchart.nodes : []);
  const steps = rawSteps
    .map((step, index) => normalizeFlowchartStep(step, index, workflowNodeIdSet))
    .filter((step) => step && step.id);
  if (!steps.length) return null;
  const stepIdSet = new Set(steps.map((step) => step.id));
  const rawLinks = Array.isArray(flowchart?.links) ? flowchart.links : (Array.isArray(flowchart?.edges) ? flowchart.edges : []);
  const links = rawLinks
    .map((link, index) => normalizeFlowchartLink(link, index, stepIdSet))
    .filter(Boolean);
  return {
    version: Number.isFinite(Number(flowchart?.version)) ? Math.max(1, Math.round(Number(flowchart.version))) : 1,
    source: normalizeText(flowchart?.source, "user"),
    steps,
    links,
  };
}

export function buildFlowchartStepMergeKey(step) {
  const runtimeKey = uniqueStrings(step?.runtimeNodeIds).join("|");
  return runtimeKey || normalizeText(step?.groupId || step?.primaryNodeId || step?.id);
}

export function buildWorkflowDraftFlowchart(workflow = {}) {
  const derived = buildDerivedFlowchart(workflow);
  const existing = normalizeWorkflowFlowchartMetadata(
    workflow?.metadata?.flowchart || workflow?.metadata?.draftFlowchart || null,
    workflow,
  );
  if (!existing) return derived;

  const nextSteps = [];
  const coveredNodeIds = new Set();
  const seenStepIds = new Set();
  const seenMergeKeys = new Set();

  for (const step of existing.steps) {
    const runtimeNodeIds = uniqueStrings(step.runtimeNodeIds);
    const normalizedStep = {
      ...step,
      runtimeNodeIds,
      primaryNodeId: normalizeText(step.primaryNodeId || runtimeNodeIds[0]),
      position: normalizePosition(step.position, null),
    };
    if (seenStepIds.has(normalizedStep.id)) continue;
    seenStepIds.add(normalizedStep.id);
    seenMergeKeys.add(buildFlowchartStepMergeKey(normalizedStep));
    for (const nodeId of runtimeNodeIds) coveredNodeIds.add(nodeId);
    nextSteps.push(normalizedStep);
  }

  for (const step of derived.steps) {
    const uncoveredRuntimeNodeIds = step.runtimeNodeIds.filter((nodeId) => !coveredNodeIds.has(nodeId));
    if (!uncoveredRuntimeNodeIds.length) continue;
    const mergeKey = buildFlowchartStepMergeKey({ ...step, runtimeNodeIds: uncoveredRuntimeNodeIds });
    if (seenMergeKeys.has(mergeKey)) continue;
    let nextId = step.id;
    let dedupeIndex = 1;
    while (seenStepIds.has(nextId)) {
      dedupeIndex += 1;
      nextId = `${step.id}-${dedupeIndex}`;
    }
    nextSteps.push({
      ...step,
      id: nextId,
      runtimeNodeIds: uncoveredRuntimeNodeIds,
      primaryNodeId: uncoveredRuntimeNodeIds[0] || step.primaryNodeId,
    });
    seenStepIds.add(nextId);
    seenMergeKeys.add(mergeKey);
    for (const nodeId of uncoveredRuntimeNodeIds) coveredNodeIds.add(nodeId);
  }

  const runtimeNodeToStepId = new Map();
  for (const step of nextSteps) {
    for (const nodeId of step.runtimeNodeIds) {
      if (!runtimeNodeToStepId.has(nodeId)) runtimeNodeToStepId.set(nodeId, step.id);
    }
  }

  const nextLinks = [];
  const seenLinkKeys = new Set();
  for (const link of existing.links) {
    const sourceStepId = normalizeText(link.sourceStepId);
    const targetStepId = normalizeText(link.targetStepId);
    if (!seenStepIds.has(sourceStepId) || !seenStepIds.has(targetStepId)) continue;
    const dedupeKey = `${sourceStepId}->${targetStepId}`;
    if (seenLinkKeys.has(dedupeKey)) continue;
    nextLinks.push({
      ...link,
      sourceStepId,
      targetStepId,
      edgeIds: uniqueStrings(link.edgeIds),
    });
    seenLinkKeys.add(dedupeKey);
  }

  for (const edge of Array.isArray(workflow?.edges) ? workflow.edges : []) {
    const sourceStepId = runtimeNodeToStepId.get(normalizeText(edge?.source));
    const targetStepId = runtimeNodeToStepId.get(normalizeText(edge?.target));
    if (!sourceStepId || !targetStepId || sourceStepId === targetStepId) continue;
    const dedupeKey = `${sourceStepId}->${targetStepId}`;
    if (seenLinkKeys.has(dedupeKey)) {
      const existingLink = nextLinks.find((entry) => `${entry.sourceStepId}->${entry.targetStepId}` === dedupeKey);
      if (existingLink) {
        existingLink.edgeIds = uniqueStrings([...(existingLink.edgeIds || []), edge?.id].filter(Boolean));
        if (!existingLink.label && normalizeText(edge?.label)) existingLink.label = normalizeText(edge.label);
        if (!existingLink.condition && normalizeText(edge?.condition)) existingLink.condition = normalizeText(edge.condition);
      }
      continue;
    }
    const nextLink = {
      id: normalizeText(edge?.id, dedupeKey),
      sourceStepId,
      targetStepId,
      edgeIds: uniqueStrings([edge?.id].filter(Boolean)),
    };
    if (normalizeText(edge?.label)) nextLink.label = normalizeText(edge.label);
    if (normalizeText(edge?.condition)) nextLink.condition = normalizeText(edge.condition);
    nextLinks.push(nextLink);
    seenLinkKeys.add(dedupeKey);
  }

  return {
    version: existing.version || derived.version || 1,
    source: existing.source || "user",
    steps: nextSteps,
    links: nextLinks,
  };
}
