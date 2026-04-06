/**
 * workflow-serializer.mjs — Workflow ↔ JSON code serialization
 *
 * Converts between the internal workflow graph format (nodes/edges/variables)
 * and a clean, human-readable JSON representation for code editing.
 */
import { createHash } from "node:crypto";

function cloneJsonValue(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value))
    .filter(Boolean))];
}

function normalizePosition(position, fallback = null) {
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  return fallback;
}

function buildNodePosition(node) {
  return normalizePosition(node?.position, { x: 0, y: 0 });
}

function computeStepPosition(nodes = []) {
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

function normalizeFlowchartGroup(group, nodeIdSet = new Set()) {
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

function buildDerivedFlowchart(workflow = {}) {
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

function normalizeFlowchartStep(step, index = 0, workflowNodeIdSet = null) {
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

function normalizeFlowchartLink(link, index = 0, stepIdSet = null) {
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

function buildFlowchartStepMergeKey(step) {
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
      const existing = nextLinks.find((entry) => `${entry.sourceStepId}->${entry.targetStepId}` === dedupeKey);
      if (existing) {
        existing.edgeIds = uniqueStrings([...(existing.edgeIds || []), edge?.id].filter(Boolean));
        if (!existing.label && normalizeText(edge?.label)) existing.label = normalizeText(edge.label);
        if (!existing.condition && normalizeText(edge?.condition)) existing.condition = normalizeText(edge.condition);
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

function buildSerializableWorkflowMetadata(workflow = {}) {
  const preservedMetadata = workflow?.metadata && typeof workflow.metadata === "object"
    ? cloneJsonValue(workflow.metadata)
    : {};
  const flowchart = buildWorkflowDraftFlowchart(workflow);
  if (flowchart?.steps?.length) {
    preservedMetadata.flowchart = flowchart;
  } else {
    delete preservedMetadata.flowchart;
  }
  if (preservedMetadata && Object.keys(preservedMetadata).length > 0) {
    return preservedMetadata;
  }
  return undefined;
}

/**
 * Serialize a workflow object into a clean, human-readable JSON structure.
 * Strips internal metadata, sorts keys for deterministic output.
 * @param {object} workflow - The workflow object from storage
 * @returns {{ code: string, hash: string, metadata: object }}
 */
export function serializeWorkflowToCode(workflow) {
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Invalid workflow: expected an object");
  }

  const clean = {
    name: workflow.name || "Untitled Workflow",
    description: workflow.description || "",
    category: workflow.category || "custom",
    enabled: workflow.enabled !== false,
    variables: workflow.variables || {},
    ...(buildSerializableWorkflowMetadata(workflow) ? { metadata: buildSerializableWorkflowMetadata(workflow) } : {}),
    nodes: (workflow.nodes || []).map(n => ({
      id: n.id,
      type: n.type,
      label: n.label || n.id,
      ...(n.config && Object.keys(n.config).length > 0 ? { config: n.config } : {}),
      position: n.position || { x: 0, y: 0 },
    })),
    edges: (workflow.edges || []).map((e) => {
      const sourcePort = String(e.sourcePort ?? e.fromPort ?? "").trim();
      const targetPort = String(e.targetPort ?? e.toPort ?? "").trim();
      return {
        source: e.source,
        target: e.target,
        ...(sourcePort ? { sourcePort } : {}),
        ...(targetPort ? { targetPort } : {}),
        ...(e.label ? { label: e.label } : {}),
        ...(e.condition ? { condition: e.condition } : {}),
      };
    }),
  };

  const code = JSON.stringify(clean, null, 2);
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 16);

  return {
    code,
    hash,
    metadata: {
      nodeCount: clean.nodes.length,
      edgeCount: clean.edges.length,
      variableCount: Object.keys(clean.variables).length,
      triggerTypes: [...new Set(clean.nodes.filter(n => n.type?.startsWith("trigger.")).map(n => n.type))],
      serializedAt: Date.now(),
    },
  };
}

/**
 * Deserialize JSON code back into a workflow object.
 * Validates structure and returns errors if invalid.
 * @param {string} code - JSON string to parse
 * @returns {{ workflow: object | null, errors: string[] }}
 */
export function deserializeCodeToWorkflow(code) {
  const errors = [];

  if (typeof code !== "string" || !code.trim()) {
    return { workflow: null, errors: ["Empty or non-string input"] };
  }

  let parsed;
  try {
    parsed = JSON.parse(code);
  } catch (err) {
    return { workflow: null, errors: [`JSON parse error: ${err.message}`] };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { workflow: null, errors: ["Root must be a JSON object"] };
  }

  // Validate required fields
  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    errors.push("Missing or empty 'name' field");
  }

  if (!Array.isArray(parsed.nodes)) {
    errors.push("'nodes' must be an array");
  } else {
    const ids = new Set();
    for (let i = 0; i < parsed.nodes.length; i++) {
      const node = parsed.nodes[i];
      if (!node || typeof node !== "object") {
        errors.push(`nodes[${i}]: must be an object`);
        continue;
      }
      if (!node.id || typeof node.id !== "string") {
        errors.push(`nodes[${i}]: missing or invalid 'id'`);
      } else if (ids.has(node.id)) {
        errors.push(`nodes[${i}]: duplicate id '${node.id}'`);
      } else {
        ids.add(node.id);
      }
      if (!node.type || typeof node.type !== "string") {
        errors.push(`nodes[${i}]: missing or invalid 'type'`);
      }
    }
  }

  if (!Array.isArray(parsed.edges)) {
    errors.push("'edges' must be an array");
  } else {
    for (let i = 0; i < parsed.edges.length; i++) {
      const edge = parsed.edges[i];
      if (!edge || typeof edge !== "object") {
        errors.push(`edges[${i}]: must be an object`);
        continue;
      }
      if (!edge.source || typeof edge.source !== "string") {
        errors.push(`edges[${i}]: missing or invalid 'source'`);
      }
      if (!edge.target || typeof edge.target !== "string") {
        errors.push(`edges[${i}]: missing or invalid 'target'`);
      }
    }
  }

  if (parsed.variables !== undefined && (typeof parsed.variables !== "object" || Array.isArray(parsed.variables))) {
    errors.push("'variables' must be a plain object");
  }

  if (errors.length > 0) {
    return { workflow: null, errors };
  }

  const edges = parsed.edges.map((edge) => {
    const sourcePort = String(edge?.sourcePort ?? edge?.fromPort ?? "").trim();
    const targetPort = String(edge?.targetPort ?? edge?.toPort ?? "").trim();
    const normalized = {
      ...edge,
      ...(sourcePort ? { sourcePort } : {}),
      ...(targetPort ? { targetPort } : {}),
    };
    delete normalized.fromPort;
    delete normalized.toPort;
    return normalized;
  });

  return {
    workflow: {
      name: parsed.name,
      description: parsed.description || "",
      category: parsed.category || "custom",
      enabled: parsed.enabled !== false,
      variables: parsed.variables || {},
      metadata: buildSerializableWorkflowMetadata({
        nodes: parsed.nodes,
        edges,
        groups: parsed.groups || [],
        metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata)
          ? parsed.metadata
          : {},
      }) || {},
      nodes: parsed.nodes,
      edges,
    },
    errors: [],
  };
}

/**
 * Validate a JSON code string without fully parsing it into a workflow.
 * Returns validation results with line numbers for errors when possible.
 * @param {string} code - JSON string to validate
 * @returns {{ valid: boolean, errors: Array<{ message: string, line?: number }> }}
 */
export function validateWorkflowCode(code) {
  if (typeof code !== "string" || !code.trim()) {
    return { valid: false, errors: [{ message: "Empty input" }] };
  }

  try {
    JSON.parse(code);
  } catch (err) {
    // Try to extract line number from JSON parse error
    const lineMatch = String(err.message).match(/position\s+(\d+)/i);
    let line;
    if (lineMatch) {
      const pos = parseInt(lineMatch[1], 10);
      line = code.slice(0, pos).split("\n").length;
    }
    return { valid: false, errors: [{ message: `JSON syntax error: ${err.message}`, line }] };
  }

  const { errors } = deserializeCodeToWorkflow(code);
  return {
    valid: errors.length === 0,
    errors: errors.map(e => ({ message: e })),
  };
}

/**
 * Compute a diff summary between two workflow code strings.
 * @param {string} oldCode
 * @param {string} newCode
 * @returns {{ changed: boolean, summary: string, nodesDiff: object, edgesDiff: object }}
 */
export function diffWorkflowCode(oldCode, newCode) {
  const oldResult = deserializeCodeToWorkflow(oldCode);
  const newResult = deserializeCodeToWorkflow(newCode);

  if (oldResult.errors.length > 0 || newResult.errors.length > 0) {
    return { changed: true, summary: "Cannot diff — parse errors present", nodesDiff: {}, edgesDiff: {} };
  }

  const oldW = oldResult.workflow;
  const newW = newResult.workflow;

  const oldNodeIds = new Set((oldW.nodes || []).map(n => n.id));
  const newNodeIds = new Set((newW.nodes || []).map(n => n.id));

  const nodesAdded = [...newNodeIds].filter(id => !oldNodeIds.has(id));
  const nodesRemoved = [...oldNodeIds].filter(id => !newNodeIds.has(id));
  const nodesModified = [...newNodeIds].filter(id => {
    if (!oldNodeIds.has(id)) return false;
    const oldNode = oldW.nodes.find(n => n.id === id);
    const newNode = newW.nodes.find(n => n.id === id);
    return JSON.stringify(oldNode) !== JSON.stringify(newNode);
  });

  const oldEdgeKeys = new Set((oldW.edges || []).map(e => `${e.source}->${e.target}`));
  const newEdgeKeys = new Set((newW.edges || []).map(e => `${e.source}->${e.target}`));

  const edgesAdded = [...newEdgeKeys].filter(k => !oldEdgeKeys.has(k));
  const edgesRemoved = [...oldEdgeKeys].filter(k => !newEdgeKeys.has(k));

  const changed = nodesAdded.length > 0 || nodesRemoved.length > 0 || nodesModified.length > 0
    || edgesAdded.length > 0 || edgesRemoved.length > 0
    || oldW.name !== newW.name || oldW.description !== newW.description;

  const parts = [];
  if (oldW.name !== newW.name) parts.push(`Renamed: "${oldW.name}" → "${newW.name}"`);
  if (nodesAdded.length) parts.push(`+${nodesAdded.length} nodes`);
  if (nodesRemoved.length) parts.push(`-${nodesRemoved.length} nodes`);
  if (nodesModified.length) parts.push(`~${nodesModified.length} nodes modified`);
  if (edgesAdded.length) parts.push(`+${edgesAdded.length} edges`);
  if (edgesRemoved.length) parts.push(`-${edgesRemoved.length} edges`);

  return {
    changed,
    summary: parts.length > 0 ? parts.join(", ") : "No changes",
    nodesDiff: { added: nodesAdded, removed: nodesRemoved, modified: nodesModified },
    edgesDiff: { added: edgesAdded, removed: edgesRemoved },
  };
}
