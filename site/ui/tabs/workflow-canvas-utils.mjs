function deepClone(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

function normalizeGraphValue(value) {
  return Array.isArray(value) ? deepClone(value) : [];
}

function normalizeGroupList(groups = []) {
  return normalizeGraphValue(groups)
    .map((group) => ({
      ...group,
      id: String(group?.id || "").trim(),
      label: String(group?.label || group?.name || "Group").trim() || "Group",
      color: String(group?.color || "#60a5fa").trim() || "#60a5fa",
      nodeIds: [...new Set((Array.isArray(group?.nodeIds) ? group.nodeIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean))],
      collapsed: group?.collapsed === true,
    }))
    .filter((group) => group.id && group.nodeIds.length > 0);
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveHistoryGroupsAndLimit(groupsOrLimit, limitMaybe) {
  if (Array.isArray(groupsOrLimit)) {
    return {
      groups: groupsOrLimit,
      limit: Number.isFinite(Number(limitMaybe)) ? Math.max(1, Math.floor(Number(limitMaybe))) : 50,
    };
  }
  return {
    groups: [],
    limit: Number.isFinite(Number(groupsOrLimit)) ? Math.max(1, Math.floor(Number(groupsOrLimit))) : 50,
  };
}

function subsequenceScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  let position = 0;
  for (const char of needle) {
    position = haystack.indexOf(char, position);
    if (position === -1) return 0;
    position += 1;
  }
  return Math.max(6, 18 - Math.max(0, haystack.length - needle.length));
}

function scoreField(value, token, weight = 1) {
  if (!value) return 0;
  if (value === token) return 160 * weight;
  if (value.startsWith(`${token}.`) || value.startsWith(`${token}_`)) return 140 * weight;
  if (value.startsWith(token)) return 120 * weight;
  if (value.includes(`.${token}`) || value.includes(`_${token}`) || value.includes(` ${token}`)) return 95 * weight;
  if (value.includes(token)) return 72 * weight;
  const fuzzy = subsequenceScore(token, value);
  return fuzzy ? fuzzy * weight : 0;
}

function getLabel(type) {
  return String(type || "").split(".").pop()?.replace(/_/g, " ") || String(type || "");
}

function normalizePreviewLine(text, maxLength = 84) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

function collectPreviewText(value, lines = [], seen = new Set(), depth = 0) {
  if (value == null || depth > 2 || lines.length >= 6) return lines;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const rawLines = String(value)
      .split(/\r?\n/)
      .map((line) => normalizePreviewLine(line))
      .filter(Boolean);
    for (const line of rawLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= 6) break;
    }
    return lines;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 4)) {
      collectPreviewText(item, lines, seen, depth + 1);
      if (lines.length >= 6) break;
    }
    return lines;
  }
  if (typeof value !== "object") return lines;

  const prioritizedKeys = [
    "summary",
    "narrative",
    "text",
    "message",
    "content",
    "output",
    "result",
    "answer",
    "response",
    "stdout",
    "stderr",
  ];
  let matched = false;
  for (const key of prioritizedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    matched = true;
    collectPreviewText(value[key], lines, seen, depth + 1);
    if (lines.length >= 6) return lines;
  }
  if (Array.isArray(value.lines)) {
    matched = true;
    collectPreviewText(value.lines, lines, seen, depth + 1);
  }
  if (value.preview && typeof value.preview === "object") {
    matched = true;
    collectPreviewText(value.preview, lines, seen, depth + 1);
  }
  if (!matched) {
    try {
      const json = JSON.stringify(value);
      if (json) collectPreviewText(json, lines, seen, depth + 1);
    } catch {}
  }
  return lines;
}

function extractPreviewTokenCount(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.tokenCount,
    value.totalTokens,
    value.total_tokens,
    value.tokens,
    value.usage?.total_tokens,
    value.usage?.totalTokens,
    value.tokenUsage?.totalTokens,
    value.metrics?.total_tokens,
    value.metrics?.totalTokens,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.max(0, Math.round(parsed));
    }
  }
  const input = Number(
    value.inputTokens
    ?? value.input_tokens
    ?? value.promptTokens
    ?? value.prompt_tokens
    ?? value.usage?.prompt_tokens
    ?? value.usage?.inputTokens
    ?? value.tokenUsage?.inputTokens,
  );
  const output = Number(
    value.outputTokens
    ?? value.output_tokens
    ?? value.completionTokens
    ?? value.completion_tokens
    ?? value.usage?.completion_tokens
    ?? value.usage?.outputTokens
    ?? value.tokenUsage?.outputTokens,
  );
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return Math.max(0, Math.round((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)));
  }
  return null;
}

function toNodeTypeMap(nodeTypes = []) {
  if (nodeTypes instanceof Map) return nodeTypes;
  return new Map((Array.isArray(nodeTypes) ? nodeTypes : []).map((type) => [type?.type, type]));
}

function normalizePortDescriptor(port, direction, index) {
  const fallbackName = index === 0 ? "default" : `${direction}-${index + 1}`;
  if (!port || typeof port !== "object") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: "Any",
      description: "",
      accepts: [],
      color: null,
    };
  }
  return {
    ...port,
    name: String(port.name || fallbackName).trim() || fallbackName,
    label: String(port.label || port.name || fallbackName).trim() || fallbackName,
    type: String(port.type || "Any").trim() || "Any",
    description: String(port.description || "").trim(),
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
    color: typeof port.color === "string" && port.color.trim() ? port.color.trim() : null,
  };
}

function resolvePortByName(ports, requestedName) {
  const normalizedName = String(requestedName || "").trim() || "default";
  return (Array.isArray(ports) ? ports : []).find((port) => port.name === normalizedName) || null;
}

function isWildcardPortType(type) {
  const normalized = String(type || "").trim();
  return normalized === "*" || normalized === "Any";
}

function isPortConnectionCompatible(sourcePort, targetPort) {
  if (!sourcePort || !targetPort) return { compatible: true, reason: null };
  const sourceType = String(sourcePort.type || "Any").trim() || "Any";
  const targetType = String(targetPort.type || "Any").trim() || "Any";
  const accepted = new Set(
    [targetType, ...(Array.isArray(targetPort.accepts) ? targetPort.accepts : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (isWildcardPortType(sourceType) || isWildcardPortType(targetType) || accepted.has("*") || accepted.has("Any")) {
    return { compatible: true, reason: null };
  }
  if (sourceType === targetType || accepted.has(sourceType)) {
    return { compatible: true, reason: null };
  }
  return {
    compatible: false,
    reason: `${sourcePort.label || sourcePort.name} emits ${sourceType}, but ${targetPort.label || targetPort.name} expects ${targetType}`,
  };
}

function buildUnknownPortIssue(edge, direction, requestedPortName, availablePorts = []) {
  const portLabel = direction === "output" ? "source" : "target";
  const availableNames = (Array.isArray(availablePorts) ? availablePorts : [])
    .map((port) => String(port?.name || "").trim())
    .filter(Boolean);
  const availableSuffix = availableNames.length ? ` Available ports: ${availableNames.join(", ")}.` : "";
  return {
    code: direction === "output" ? "unknown-output-port" : "unknown-input-port",
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: direction === "output"
      ? requestedPortName
      : String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default",
    targetPort: direction === "input"
      ? requestedPortName
      : String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default",
    sourceType: null,
    targetType: null,
    severity: "error",
    message: `Unknown ${portLabel} port "${requestedPortName}" on edge ${edge.id || `${edge.source}->${edge.target}`}.${availableSuffix}`,
  };
}

export function createGraphSnapshot(nodes = [], edges = [], groups = []) {
  const safeNodes = normalizeGraphValue(nodes);
  return {
    nodes: safeNodes,
    edges: hydrateCanvasEdges(safeNodes, normalizeGraphValue(edges)),
    groups: normalizeGroupList(groups),
  };
}

export function serializeGraphSnapshot(nodesOrSnapshot = [], maybeEdges = [], maybeGroups = []) {
  if (
    nodesOrSnapshot &&
    typeof nodesOrSnapshot === "object" &&
    !Array.isArray(nodesOrSnapshot) &&
    ("nodes" in nodesOrSnapshot || "edges" in nodesOrSnapshot || "groups" in nodesOrSnapshot)
  ) {
    return JSON.stringify(createGraphSnapshot(nodesOrSnapshot.nodes, nodesOrSnapshot.edges, nodesOrSnapshot.groups));
  }
  return JSON.stringify(createGraphSnapshot(nodesOrSnapshot, maybeEdges, maybeGroups));
}

export function parseGraphSnapshot(snapshot) {
  if (!snapshot) return createGraphSnapshot();
  try {
    const parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];
    const shouldHydratePorts = edges.some((edge) => {
      if (!edge || typeof edge !== "object") return false;
      return ["sourcePort", "targetPort", "fromPort", "toPort"].some((key) => Object.prototype.hasOwnProperty.call(edge, key));
    });
    const normalizedEdges = shouldHydratePorts
      ? edges.map((edge) => {
        if (!edge || typeof edge !== "object") return edge;
        const sourcePort = String(edge.sourcePort ?? edge.fromPort ?? "").trim() || "default";
        const targetPort = String(edge.targetPort ?? edge.toPort ?? "").trim() || "default";
        const nextEdge = { ...edge, sourcePort, targetPort };
        delete nextEdge.fromPort;
        delete nextEdge.toPort;
        return nextEdge;
      })
      : edges;
    return createGraphSnapshot(parsed?.nodes, normalizedEdges, parsed?.groups);
  } catch {
    return createGraphSnapshot();
  }
}

export function resolveCanvasNodePorts(node, nodeTypes = []) {
  const typeInfo = toNodeTypeMap(nodeTypes).get(node?.type) || null;
  const typePorts = typeInfo?.ports || {};
  const typeInputs = Array.isArray(typeInfo?.inputs) ? typeInfo.inputs : typePorts.inputs;
  const typeOutputs = Array.isArray(typeInfo?.outputs) ? typeInfo.outputs : typePorts.outputs;
  const nodeInputs = Array.isArray(node?.inputs) ? node.inputs : null;
  const nodeOutputs = Array.isArray(node?.outputs) ? node.outputs : null;
  const inputSource = Array.isArray(node?.inputPorts) && node.inputPorts.length
    ? node.inputPorts
    : (nodeInputs && nodeInputs.length ? nodeInputs : typeInputs);
  const outputSource = Array.isArray(node?.outputPorts) && node.outputPorts.length
    ? node.outputPorts
    : (nodeOutputs && nodeOutputs.length ? nodeOutputs : typeOutputs);
  const inputs = (Array.isArray(inputSource) ? inputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "input", index));
  const outputs = (Array.isArray(outputSource) ? outputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "output", index));
  return {
    inputs: inputs.length ? inputs : [normalizePortDescriptor(null, "input", 0)],
    outputs: outputs.length ? outputs : [normalizePortDescriptor(null, "output", 0)],
  };
}

export function hydrateCanvasEdges(nodes = [], edges = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  return (Array.isArray(edges) ? edges : []).map((edge) => {
    const sourceNode = nodeMap.get(edge?.source);
    const targetNode = nodeMap.get(edge?.target);
    const sourcePorts = resolveCanvasNodePorts(sourceNode, nodeTypeMap).outputs;
    const targetPorts = resolveCanvasNodePorts(targetNode, nodeTypeMap).inputs;
    const requestedSourcePort = String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default";
    const requestedTargetPort = String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default";
    const sourcePort = resolvePortByName(sourcePorts, requestedSourcePort);
    const targetPort = resolvePortByName(targetPorts, requestedTargetPort);
    const normalized = {
      ...edge,
      sourcePort: sourcePort?.name || requestedSourcePort,
      targetPort: targetPort?.name || requestedTargetPort,
      sourcePortType: sourcePort?.type || String(edge?.sourcePortType || "").trim() || "Any",
      targetPortType: targetPort?.type || String(edge?.targetPortType || "").trim() || "Any",
    };
    delete normalized.fromPort;
    delete normalized.toPort;
    return normalized;
  });
}

function inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap) {
  const sourceNode = nodeMap.get(edge?.source);
  const targetNode = nodeMap.get(edge?.target);
  const sourcePorts = resolveCanvasNodePorts(sourceNode, nodeTypeMap).outputs;
  const targetPorts = resolveCanvasNodePorts(targetNode, nodeTypeMap).inputs;
  const requestedSourcePortName = String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default";
  const requestedTargetPortName = String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default";
  const sourcePort = resolvePortByName(sourcePorts, requestedSourcePortName);
  const targetPort = resolvePortByName(targetPorts, requestedTargetPortName);
  const issues = [];

  if (!sourcePort) {
    issues.push(buildUnknownPortIssue(edge, "output", requestedSourcePortName, sourcePorts));
  }
  if (!targetPort) {
    issues.push(buildUnknownPortIssue(edge, "input", requestedTargetPortName, targetPorts));
  }

  if (sourcePort && targetPort) {
    const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
    if (!compatibility.compatible) {
      issues.push({
        code: "invalid-port-binding",
        edgeId: edge.id || `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        sourcePort: sourcePort.name,
        targetPort: targetPort.name,
        sourceType: sourcePort.type,
        targetType: targetPort.type,
        severity: "error",
        message: compatibility.reason,
      });
    }
  }

  return {
    edge,
    sourceNode,
    targetNode,
    sourcePorts,
    targetPorts,
    sourcePort,
    targetPort,
    requestedSourcePortName,
    requestedTargetPortName,
    issues,
  };
}

export function inspectCanvasEdgePorts(edge, nodes = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  return inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap);
}

export function canUpdateCanvasEdgePortMapping(edge, patch = {}, nodes = [], nodeTypes = []) {
  const validation = inspectCanvasEdgePorts({ ...edge, ...patch }, nodes, nodeTypes);
  const changedSourcePort = Object.prototype.hasOwnProperty.call(patch, "sourcePort")
    || Object.prototype.hasOwnProperty.call(patch, "fromPort");
  const changedTargetPort = Object.prototype.hasOwnProperty.call(patch, "targetPort")
    || Object.prototype.hasOwnProperty.call(patch, "toPort");
  const blockingIssue = validation.issues.find((issue) => (
    (issue?.code === "unknown-output-port" && changedSourcePort)
    || (issue?.code === "unknown-input-port" && changedTargetPort)
  )) || null;
  return {
    allowed: !blockingIssue,
    blockingIssue,
    validation,
  };
}

export function validateCanvasEdgePorts(nodes = [], edges = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const issues = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    issues.push(...inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap).issues);
  }
  return issues;
}

export const HISTORY_LIMIT = 50;
export const HISTORY_COMMIT_DEBOUNCE_MS = 220;

export function createHistoryState(nodes = [], edges = [], groups = []) {
  return {
    past: [],
    present: serializeGraphSnapshot(nodes, edges, groups),
    future: [],
  };
}

export function pushHistorySnapshot(history, nodes, edges, groupsOrLimit = [], limitMaybe = 50) {
  const safeHistory = history || createHistoryState();
  const { groups, limit } = resolveHistoryGroupsAndLimit(groupsOrLimit, limitMaybe);
  const nextPresent = serializeGraphSnapshot(nodes, edges, groups);
  if (nextPresent === safeHistory.present) return safeHistory;
  const nextPast = [...safeHistory.past, safeHistory.present];
  if (nextPast.length > limit) nextPast.splice(0, nextPast.length - limit);
  return {
    past: nextPast,
    present: nextPresent,
    future: [],
  };
}

export function undoHistory(history) {
  const safeHistory = history || createHistoryState();
  if (!safeHistory.past.length) {
    return { history: safeHistory, snapshot: parseGraphSnapshot(safeHistory.present) };
  }
  const previousPresent = safeHistory.past[safeHistory.past.length - 1];
  return {
    history: {
      past: safeHistory.past.slice(0, -1),
      present: previousPresent,
      future: [safeHistory.present, ...safeHistory.future],
    },
    snapshot: parseGraphSnapshot(previousPresent),
  };
}

export function redoHistory(history, limit = 50) {
  const safeHistory = history || createHistoryState();
  if (!safeHistory.future.length) {
    return { history: safeHistory, snapshot: parseGraphSnapshot(safeHistory.present) };
  }
  const [nextPresent, ...future] = safeHistory.future;
  const nextPast = [...safeHistory.past, safeHistory.present];
  if (nextPast.length > limit) nextPast.splice(0, nextPast.length - limit);
  return {
    history: {
      past: nextPast,
      present: nextPresent,
      future,
    },
    snapshot: parseGraphSnapshot(nextPresent),
  };
}

function replaceSelectedNodeReferences(value, selectedNodeIds, executeNodeId) {
  if (typeof value === "string") {
    let nextValue = value;
    for (const nodeId of selectedNodeIds) {
      const pattern = new RegExp(`\\{\\{\\s*${escapeRegex(nodeId)}(\\.[^}]*)?\\s*\\}\\}`, "g");
      nextValue = nextValue.replace(
        pattern,
        (_match, pathSuffix = "") => `{{${executeNodeId}.output.nodeOutputs.${nodeId}${pathSuffix || ""}}}`,
      );
    }
    return nextValue;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => replaceSelectedNodeReferences(entry, selectedNodeIds, executeNodeId));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceSelectedNodeReferences(entry, selectedNodeIds, executeNodeId)]),
    );
  }
  return value;
}

export function createNodeGroup(graph = {}, selectedNodeIds = [], options = {}) {
  const snapshot = createGraphSnapshot(graph.nodes, graph.edges, graph.groups);
  const nodeIds = [...new Set((Array.isArray(selectedNodeIds) ? selectedNodeIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!nodeIds.length) return snapshot;
  const groupId = String(options.id || `group-${Date.now()}`).trim();
  const nextGroup = {
    id: groupId,
    label: String(options.label || options.name || "New Group").trim() || "New Group",
    color: String(options.color || "#60a5fa").trim() || "#60a5fa",
    nodeIds,
    collapsed: options.collapsed === true,
  };
  return createGraphSnapshot(snapshot.nodes, snapshot.edges, [...snapshot.groups.filter((group) => group.id !== groupId), nextGroup]);
}

export function toggleWorkflowGroupCollapsed(graph = {}, groupId, collapsed = null) {
  const snapshot = createGraphSnapshot(graph.nodes, graph.edges, graph.groups);
  const normalizedId = String(groupId || "").trim();
  return createGraphSnapshot(
    snapshot.nodes,
    snapshot.edges,
    snapshot.groups.map((group) => group.id === normalizedId
      ? { ...group, collapsed: collapsed == null ? !group.collapsed : collapsed === true }
      : group),
  );
}

export function moveWorkflowGroupByDelta(graph = {}, groupId, deltaX = 0, deltaY = 0) {
  const snapshot = createGraphSnapshot(graph.nodes, graph.edges, graph.groups);
  const group = snapshot.groups.find((entry) => entry.id === String(groupId || "").trim());
  if (!group) return snapshot;
  const memberSet = new Set(group.nodeIds);
  return createGraphSnapshot(
    snapshot.nodes.map((node) => memberSet.has(node.id)
      ? {
          ...node,
          position: {
            x: Number(node?.position?.x || 0) + Number(deltaX || 0),
            y: Number(node?.position?.y || 0) + Number(deltaY || 0),
          },
        }
      : node),
    snapshot.edges,
    snapshot.groups,
  );
}

export function resolveWorkflowGroupBounds(graph = {}, groupId, options = {}) {
  const snapshot = createGraphSnapshot(graph.nodes, graph.edges, graph.groups);
  const group = options.groupOverride || snapshot.groups.find((entry) => entry.id === String(groupId || "").trim());
  const memberNodes = snapshot.nodes.filter((node) => group?.nodeIds?.includes(node.id));
  if (!group || memberNodes.length === 0) {
    return { x: 0, y: 0, width: 240, height: 120 };
  }
  const paddingX = Number(options.paddingX ?? 28);
  const paddingTop = Number(options.paddingTop ?? 42);
  const paddingBottom = Number(options.paddingBottom ?? 22);
  const nodeWidth = Number(options.nodeWidth ?? 220);
  const nodeHeight = Number(options.nodeHeight ?? 118);
  const minX = Math.min(...memberNodes.map((node) => Number(node?.position?.x || 0)));
  const minY = Math.min(...memberNodes.map((node) => Number(node?.position?.y || 0)));
  const maxX = Math.max(...memberNodes.map((node) => Number(node?.position?.x || 0) + nodeWidth));
  const maxY = Math.max(...memberNodes.map((node) => Number(node?.position?.y || 0) + nodeHeight));
  return {
    x: minX - paddingX,
    y: minY - paddingTop,
    width: Math.max(220, (maxX - minX) + (paddingX * 2)),
    height: Math.max(110, (maxY - minY) + paddingTop + paddingBottom),
  };
}

function buildGroupProxyNode(group, memberNodes = []) {
  const bounds = resolveWorkflowGroupBounds({ nodes: memberNodes }, group.id, { groupOverride: group });
  return {
    id: group.id,
    type: "__group__",
    label: group.label,
    color: group.color,
    position: { x: bounds.x, y: bounds.y },
    size: { width: bounds.width, height: bounds.height },
    inputPorts: [{ name: "default", label: "In", type: "Any", color: group.color }],
    outputPorts: [{ name: "default", label: "Out", type: "Any", color: group.color }],
    outputs: ["default"],
    isGroupProxy: true,
    groupId: group.id,
    memberNodeIds: [...group.nodeIds],
  };
}

export function buildCollapsedGraph(graph = {}) {
  const snapshot = createGraphSnapshot(graph.nodes, graph.edges, graph.groups);
  const collapsedGroups = snapshot.groups.filter((group) => group.collapsed);
  if (!collapsedGroups.length) {
    return {
      visibleNodes: snapshot.nodes,
      visibleEdges: snapshot.edges,
      visibleGroups: snapshot.groups,
      collapsedGroups: [],
    };
  }

  const collapsedNodeToGroup = new Map();
  for (const group of collapsedGroups) {
    for (const nodeId of group.nodeIds) collapsedNodeToGroup.set(nodeId, group);
  }

  const visibleNodes = snapshot.nodes.filter((node) => !collapsedNodeToGroup.has(node.id));
  for (const group of collapsedGroups) {
    const memberNodes = snapshot.nodes.filter((node) => group.nodeIds.includes(node.id));
    visibleNodes.push(buildGroupProxyNode(group, memberNodes));
  }

  const visibleEdges = [];
  const seenEdges = new Set();
  for (const edge of snapshot.edges) {
    const sourceGroup = collapsedNodeToGroup.get(edge.source) || null;
    const targetGroup = collapsedNodeToGroup.get(edge.target) || null;
    if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) continue;

    const normalizedEdge = {
      ...edge,
      source: sourceGroup ? sourceGroup.id : edge.source,
      target: targetGroup ? targetGroup.id : edge.target,
      sourcePort: sourceGroup ? "default" : edge.sourcePort,
      targetPort: targetGroup ? "default" : edge.targetPort,
      originalEdgeIds: [edge.id],
    };
    const dedupeKey = `${normalizedEdge.source}:${normalizedEdge.sourcePort || "default"}->${normalizedEdge.target}:${normalizedEdge.targetPort || "default"}`;
    if (seenEdges.has(dedupeKey)) {
      const existing = visibleEdges.find((entry) => `${entry.source}:${entry.sourcePort || "default"}->${entry.target}:${entry.targetPort || "default"}` === dedupeKey);
      if (existing) existing.originalEdgeIds = [...new Set([...(existing.originalEdgeIds || []), edge.id])];
      continue;
    }
    seenEdges.add(dedupeKey);
    visibleEdges.push(normalizedEdge);
  }

  return {
    visibleNodes,
    visibleEdges,
    visibleGroups: snapshot.groups,
    collapsedGroups,
  };
}

export function convertSelectionToSubworkflow(parentWorkflow = {}, selectedNodeIds = [], options = {}) {
  const snapshot = createGraphSnapshot(parentWorkflow.nodes, parentWorkflow.edges, parentWorkflow.groups);
  const selectedIds = [...new Set((Array.isArray(selectedNodeIds) ? selectedNodeIds : []).map((id) => String(id || "").trim()).filter(Boolean))];
  const selectedIdSet = new Set(selectedIds);
  if (!selectedIds.length) {
    return {
      parentWorkflow: { ...parentWorkflow, ...snapshot },
      childWorkflow: null,
      executeNode: null,
    };
  }

  const selectedNodes = snapshot.nodes.filter((node) => selectedIdSet.has(node.id));
  const selectedEdges = snapshot.edges.filter((edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target));
  const incomingEdges = snapshot.edges.filter((edge) => !selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target));
  const outgoingEdges = snapshot.edges.filter((edge) => selectedIdSet.has(edge.source) && !selectedIdSet.has(edge.target));
  const remainingEdges = snapshot.edges.filter((edge) => !selectedIdSet.has(edge.source) && !selectedIdSet.has(edge.target));
  const remainingNodes = snapshot.nodes.filter((node) => !selectedIdSet.has(node.id));
  const rootNodes = selectedNodes.filter((node) => !selectedEdges.some((edge) => edge.target === node.id));
  const leafNodes = selectedNodes.filter((node) => !selectedEdges.some((edge) => edge.source === node.id));
  const childWorkflowId = String(options.childWorkflowId || `${parentWorkflow.id || "workflow"}-child-${Date.now()}`);
  const executeNodeId = String(options.executeNodeId || `execute-${childWorkflowId}`);
  const triggerNodeId = String(options.triggerNodeId || "workflow-call");
  const endNodeId = String(options.endNodeId || "workflow-end");
  const minX = Math.min(...selectedNodes.map((node) => Number(node?.position?.x || 0)));
  const minY = Math.min(...selectedNodes.map((node) => Number(node?.position?.y || 0)));
  const maxX = Math.max(...selectedNodes.map((node) => Number(node?.position?.x || 0)));
  const maxY = Math.max(...selectedNodes.map((node) => Number(node?.position?.y || 0)));

  const triggerNode = {
    id: triggerNodeId,
    type: "trigger.workflow_call",
    label: "Workflow Call",
    config: { inputs: {} },
    position: { x: minX - 260, y: minY },
    outputs: ["default"],
  };
  const endNode = {
    id: endNodeId,
    type: "flow.end",
    label: "Workflow End",
    config: {
      status: "completed",
      output: {
        nodeOutputs: Object.fromEntries(selectedIds.map((nodeId) => [nodeId, `{{${nodeId}}}`])),
      },
    },
    position: { x: maxX + 260, y: maxY },
    outputs: ["default"],
  };
  const executeNode = {
    id: executeNodeId,
    type: "action.execute_workflow",
    label: String(options.executeNodeLabel || options.childName || "Execute Sub-workflow"),
    config: {
      workflowId: childWorkflowId,
      mode: "sync",
      input: Object.fromEntries([...new Set(incomingEdges.map((edge) => edge.source))].map((nodeId) => [nodeId, `{{${nodeId}}}`])),
    },
    position: {
      x: Math.round(selectedNodes.reduce((sum, node) => sum + Number(node?.position?.x || 0), 0) / selectedNodes.length),
      y: Math.round(selectedNodes.reduce((sum, node) => sum + Number(node?.position?.y || 0), 0) / selectedNodes.length),
    },
    outputs: ["default"],
  };

  return {
    executeNode,
    childWorkflow: {
      id: childWorkflowId,
      name: String(options.childName || "Sub-workflow"),
      description: String(options.childDescription || `Extracted from ${parentWorkflow.name || parentWorkflow.id || "workflow"}`),
      trigger: "trigger.workflow_call",
      enabled: true,
      nodes: [triggerNode, ...selectedNodes, endNode],
      edges: [
        ...selectedEdges,
        ...rootNodes.map((node, index) => ({ id: `edge-${triggerNodeId}-${node.id}-${index}`, source: triggerNodeId, target: node.id })),
        ...leafNodes.map((node, index) => ({ id: `edge-${node.id}-${endNodeId}-${index}`, source: node.id, target: endNodeId })),
      ],
      groups: snapshot.groups.filter((group) => group.nodeIds.every((nodeId) => selectedIdSet.has(nodeId))),
      variables: {},
      metadata: { extractedFromWorkflowId: parentWorkflow.id || null },
    },
    parentWorkflow: {
      ...parentWorkflow,
      nodes: [
        ...remainingNodes.map((node) => ({
          ...node,
          config: replaceSelectedNodeReferences(node.config || {}, selectedIds, executeNodeId),
        })),
        executeNode,
      ],
      edges: [
        ...remainingEdges,
        ...incomingEdges.map((edge, index) => ({ ...edge, id: `${edge.id || "edge"}-to-${executeNodeId}-${index}`, target: executeNodeId, targetPort: "default" })),
        ...outgoingEdges.map((edge, index) => ({ ...edge, id: `${executeNodeId}-to-${edge.id || "edge"}-${index}`, source: executeNodeId, sourcePort: "default" })),
      ],
      groups: snapshot.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => !selectedIdSet.has(nodeId)) }))
        .filter((group) => group.nodeIds.length > 0),
    },
  };
}

export function getNodeSearchMetadata(nodeType) {
  const schemaProps = Object.keys(nodeType?.schema?.properties || {});
  const declaredInputs = Array.isArray(nodeType?.inputs)
    ? nodeType.inputs.filter((value) => typeof value === "string" && value.trim())
    : [];
  const mergedInputs = [...new Set([...declaredInputs, ...schemaProps])];
  const outputs = Array.isArray(nodeType?.outputs) && nodeType.outputs.length ? nodeType.outputs : ["default"];
  return {
    category: nodeType?.category || String(nodeType?.type || "").split(".")[0] || "other",
    description: String(nodeType?.description || ""),
    inputs: mergedInputs,
    label: getLabel(nodeType?.type),
    outputs,
    type: String(nodeType?.type || ""),
  };
}

export function searchNodeTypes(types = [], query = "", limit = 30) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ranked = [];

  for (const nodeType of types) {
    const metadata = getNodeSearchMetadata(nodeType);
    const label = metadata.label.toLowerCase();
    const category = metadata.category.toLowerCase();
    const description = metadata.description.toLowerCase();
    const type = metadata.type.toLowerCase();
    const inputText = metadata.inputs.join(" ").toLowerCase();
    const outputText = metadata.outputs.join(" ").toLowerCase();
    const combined = `${type} ${label} ${category} ${description} ${inputText} ${outputText}`.trim();

    let score = normalizedQuery ? 0 : 1;
    let matched = !normalizedQuery;

    for (const token of tokens) {
      const tokenScore = Math.max(
        scoreField(type, token, 1.35),
        scoreField(label, token, 1.25),
        scoreField(category, token, 1.1),
        scoreField(inputText, token, 0.9),
        scoreField(outputText, token, 0.75),
        scoreField(description, token, 0.55),
      );
      if (!tokenScore) {
        matched = false;
        break;
      }
      matched = true;
      score += tokenScore;
    }

    if (!matched) continue;
    if (normalizedQuery) {
      if (type === normalizedQuery || label === normalizedQuery) score += 220;
      else if (type.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) score += 140;
      else if (combined.includes(normalizedQuery)) score += 60;
    }

    ranked.push({ ...nodeType, ...metadata, score });
  }

  ranked.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
  return ranked.slice(0, Math.max(1, limit));
}

export function buildNodeStatusesFromRunDetail(run) {
  const detail = run?.detail || {};
  const statuses = { ...(detail?.nodeStatuses || {}) };
  const statusEvents = Array.isArray(detail?.nodeStatusEvents) ? detail.nodeStatusEvents : [];
  const logs = Array.isArray(detail?.logs) ? detail.logs : [];

  for (const event of statusEvents) {
    const nodeId = String(event?.nodeId || "").trim();
    const status = String(event?.status || "").trim();
    if (!nodeId || !status) continue;
    statuses[nodeId] = status;
  }

  if (Object.keys(statuses).length === 0) {
    const fallbackStatus = run?.status === "failed"
      ? "failed"
      : run?.status === "completed"
        ? "completed"
        : "running";
    for (const entry of logs) {
      const nodeId = String(entry?.nodeId || "").trim();
      if (!nodeId || statuses[nodeId]) continue;
      statuses[nodeId] = fallbackStatus;
    }
  }

  return statuses;
}

export function resolveNodeOutputPreview(_nodeType, livePreview = null, rawOutput = null) {
  const liveLines = Array.isArray(livePreview?.lines)
    ? livePreview.lines.map((line) => normalizePreviewLine(line)).filter(Boolean)
    : [];
  const liveTokenCount = extractPreviewTokenCount(livePreview);
  if (liveLines.length || liveTokenCount != null) {
    return {
      lines: liveLines.slice(0, 3),
      tokenCount: liveTokenCount,
    };
  }

  return {
    lines: collectPreviewText(rawOutput).slice(0, 3),
    tokenCount: extractPreviewTokenCount(rawOutput),
  };
}



