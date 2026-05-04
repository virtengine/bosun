/**
 * _helpers.mjs — Shared helpers for workflow template definitions.
 *
 * These utilities generate positioned nodes and edges in a consistent format.
 * All template module files import from here.
 *
 * ## Sub-Workflow Composition
 *
 * Templates can be composed from reusable sub-workflows using:
 *
 *   subWorkflow(id, nodes, edges)      — define a reusable node+edge fragment
 *   embedSubWorkflow(sub, prefix, overrides) — embed a fragment into a parent
 *   agentPhase(id, label, prompt, extra)     — shorthand for action.run_agent node
 *   makeAgentPipeline(opts)                  — factory for trigger → phase₁ → … → done
 *
 * Sub-workflows use prefixed node IDs to avoid collisions when embedded
 * multiple times in the same parent workflow.
 */

// ── Layout state ────────────────────────────────────────────────────────────

let _nextX = 100;
let _nextY = 100;

const TEMPLATE_LAYOUT_DEFAULTS = Object.freeze({
  centerX: 480,
  topY: 80,
  columnGap: 280,
  rowGap: 180,
});

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function getNodeOriginalPosition(node, fallbackX = 0) {
  return {
    x: toFiniteNumber(node?.position?.x, fallbackX),
    y: toFiniteNumber(node?.position?.y, 0),
  };
}

/**
 * Create a workflow node definition with automatic positioning.
 * @param {string} id - Unique node identifier within the template
 * @param {string} type - Node type (e.g. "trigger.pr_event", "action.run_agent")
 * @param {string} label - Human-readable label
 * @param {object} [config] - Node configuration
 * @param {object} [opts] - Position overrides and extra fields
 * @returns {object} Node definition
 */
export function node(id, type, label, config = {}, opts = {}) {
  const x = opts.x ?? _nextX;
  const y = opts.y ?? _nextY;
  _nextX = x + 280;
  return {
    id,
    type,
    label,
    config,
    position: { x, y },
    outputs: opts.outputs || ["default"],
    ...(opts.extra || {}),
  };
}

/**
 * Create a workflow edge definition.
 * @param {string} source - Source node ID
 * @param {string} target - Target node ID
 * @param {object} [opts] - Port, condition, and extra fields
 * @returns {object} Edge definition
 */
export function edge(source, target, opts = {}) {
  const e = {
    id: opts.id || `${source}->${target}`,
    source,
    target,
    sourcePort: opts.port || "default",
    condition: opts.condition || undefined,
  };
  if (opts.backEdge) e.backEdge = true;
  if (opts.maxIterations != null) e.maxIterations = opts.maxIterations;
  if (opts.label) e.label = opts.label;
  return e;
}

/**
 * Reset the auto-layout position counters.
 * Call this before defining each new template.
 */
export function resetLayout() {
  _nextX = 100;
  _nextY = 100;
}

export function normalizeTemplateLayoutInPlace(template, opts = {}) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  const edges = Array.isArray(template?.edges) ? template.edges : [];
  if (nodes.length <= 1) return template;

  const centerX = toFiniteNumber(opts.centerX, TEMPLATE_LAYOUT_DEFAULTS.centerX);
  const topY = toFiniteNumber(opts.topY, TEMPLATE_LAYOUT_DEFAULTS.topY);
  const columnGap = Math.max(180, toFiniteNumber(opts.columnGap, TEMPLATE_LAYOUT_DEFAULTS.columnGap));
  const rowGap = Math.max(120, toFiniteNumber(opts.rowGap, TEMPLATE_LAYOUT_DEFAULTS.rowGap));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const originalPosition = new Map(
    nodes.map((node, index) => [node.id, getNodeOriginalPosition(node, index * columnGap)]),
  );

  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edgeDef of edges) {
    if (!edgeDef || edgeDef.backEdge === true) continue;
    const source = String(edgeDef.source || "").trim();
    const target = String(edgeDef.target || "").trim();
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    outgoing.get(source).push(target);
    incoming.get(target).push(source);
  }

  const sortedNodeIds = [...nodeIds].sort((left, right) => {
    const leftPos = originalPosition.get(left) || { x: 0, y: 0 };
    const rightPos = originalPosition.get(right) || { x: 0, y: 0 };
    if (leftPos.y !== rightPos.y) return leftPos.y - rightPos.y;
    if (leftPos.x !== rightPos.x) return leftPos.x - rightPos.x;
    return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0);
  });

  const rootIds = sortedNodeIds.filter((nodeId) => {
    const node = nodes[originalIndex.get(nodeId) || 0];
    return (incoming.get(nodeId)?.length || 0) === 0 || String(node?.type || "").startsWith("trigger.");
  });
  const queue = rootIds.length > 0 ? [...rootIds] : [sortedNodeIds[0]];
  const indegree = new Map([...incoming.entries()].map(([nodeId, parents]) => [nodeId, parents.length]));
  const depthById = new Map(queue.map((nodeId) => [nodeId, 0]));
  const queued = new Set(queue);

  for (const nodeId of sortedNodeIds) {
    if ((indegree.get(nodeId) || 0) === 0 && !queued.has(nodeId)) {
      queue.push(nodeId);
      queued.add(nodeId);
      depthById.set(nodeId, 0);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    const currentDepth = depthById.get(nodeId) || 0;
    for (const targetId of outgoing.get(nodeId) || []) {
      const nextDepth = currentDepth + 1;
      if (nextDepth > (depthById.get(targetId) || 0)) {
        depthById.set(targetId, nextDepth);
      }
      indegree.set(targetId, (indegree.get(targetId) || 0) - 1);
      if ((indegree.get(targetId) || 0) <= 0 && !queued.has(targetId)) {
        queue.push(targetId);
        queued.add(targetId);
      }
    }
  }

  const unresolved = sortedNodeIds.filter((nodeId) => !depthById.has(nodeId));
  while (unresolved.length > 0) {
    let progressed = false;
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      const nodeId = unresolved[index];
      const parents = incoming.get(nodeId) || [];
      if (parents.every((parentId) => depthById.has(parentId))) {
        const nextDepth = parents.length > 0
          ? Math.max(...parents.map((parentId) => depthById.get(parentId) || 0)) + 1
          : 0;
        depthById.set(nodeId, nextDepth);
        unresolved.splice(index, 1);
        progressed = true;
      }
    }
    if (progressed) continue;
    const nodeId = unresolved.shift();
    const parents = incoming.get(nodeId) || [];
    const knownParentDepths = parents
      .map((parentId) => depthById.get(parentId))
      .filter((depth) => Number.isFinite(depth));
    const fallbackDepth = knownParentDepths.length > 0
      ? Math.max(...knownParentDepths) + 1
      : 0;
    depthById.set(nodeId, fallbackDepth);
  }

  const layerMap = new Map();
  for (const nodeId of sortedNodeIds) {
    const depth = depthById.get(nodeId) || 0;
    if (!layerMap.has(depth)) layerMap.set(depth, []);
    layerMap.get(depth).push(nodeId);
  }

  const assignedX = new Map();
  const sortedLayers = [...layerMap.keys()].sort((left, right) => left - right);
  for (const depth of sortedLayers) {
    const layerNodeIds = layerMap.get(depth) || [];
    layerNodeIds.sort((left, right) => {
      const leftParents = (incoming.get(left) || []).filter((parentId) => assignedX.has(parentId));
      const rightParents = (incoming.get(right) || []).filter((parentId) => assignedX.has(parentId));
      const leftBarycenter = leftParents.length > 0
        ? leftParents.reduce((sum, parentId) => sum + assignedX.get(parentId), 0) / leftParents.length
        : (originalPosition.get(left)?.x || 0);
      const rightBarycenter = rightParents.length > 0
        ? rightParents.reduce((sum, parentId) => sum + assignedX.get(parentId), 0) / rightParents.length
        : (originalPosition.get(right)?.x || 0);
      if (leftBarycenter !== rightBarycenter) return leftBarycenter - rightBarycenter;
      const leftPos = originalPosition.get(left) || { x: 0, y: 0 };
      const rightPos = originalPosition.get(right) || { x: 0, y: 0 };
      if (leftPos.x !== rightPos.x) return leftPos.x - rightPos.x;
      if (leftPos.y !== rightPos.y) return leftPos.y - rightPos.y;
      return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0);
    });

    const startX = centerX - ((layerNodeIds.length - 1) * columnGap) / 2;
    layerNodeIds.forEach((nodeId, index) => {
      const node = nodes[originalIndex.get(nodeId) || 0];
      const x = Math.round(startX + index * columnGap);
      const y = topY + depth * rowGap;
      node.position = { x, y };
      assignedX.set(nodeId, x);
    });
  }

  return template;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Sub-Workflow Composition Primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Standard boilerplate config for action.run_agent nodes.
 * Templates merge this with a `prompt` to avoid repeating 10 identical fields.
 * @param {object} [extra] - Optional overrides (e.g. resolveMode, failOnError)
 * @returns {object} Config object with template variables
 */
export function agentDefaults(extra = {}) {
  return {
    sdk: "{{resolvedSdk}}",
    model: "{{resolvedModel}}",
    cwd: "{{worktreePath}}",
    timeoutMs: "{{taskTimeoutMs}}",
    maxRetries: "{{maxRetries}}",
    maxContinues: "{{maxContinues}}",
    resolveMode: "library",
    failOnError: false,
    ...extra,
  };
}

/**
 * Create an action.run_agent node with standard boilerplate merged in.
 * Only the prompt (and optional extra config) needs to be specified.
 * @param {string} id - Node ID
 * @param {string} label - Display label
 * @param {string} prompt - The agent prompt for this phase
 * @param {object} [extra] - Additional config overrides
 * @param {object} [opts] - Position / output overrides
 * @returns {object} Node definition
 */
export function agentPhase(id, label, prompt, extra = {}, opts = {}) {
  return node(id, "action.run_agent", label, {
    prompt,
    ...agentDefaults(extra),
  }, opts);
}

/**
 * Define a reusable sub-workflow fragment (a group of nodes + edges).
 *
 * A sub-workflow is not a standalone workflow — it's a composable fragment
 * that can be embedded into parent workflows via embedSubWorkflow().
 *
 * @param {string} id - Unique identifier for this sub-workflow definition
 * @param {Array} nodes - Array of node definitions (from node() / agentPhase())
 * @param {Array} edges - Array of edge definitions (from edge())
 * @param {object} [meta] - Optional metadata (description, entryNode, exitNode)
 * @returns {object} Sub-workflow definition { id, nodes, edges, meta }
 */
export function subWorkflow(id, nodes, edges, meta = {}) {
  if (!id || typeof id !== "string") {
    throw new Error("subWorkflow: id must be a non-empty string");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`subWorkflow(${id}): must have at least one node`);
  }
  if (!Array.isArray(edges)) {
    throw new Error(`subWorkflow(${id}): edges must be an array`);
  }
  // Validate that edge sources/targets reference defined nodes
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (!nodeIds.has(e.source)) {
      throw new Error(`subWorkflow(${id}): edge source "${e.source}" not found in nodes`);
    }
    if (!nodeIds.has(e.target)) {
      throw new Error(`subWorkflow(${id}): edge target "${e.target}" not found in nodes`);
    }
  }
  return {
    id,
    nodes,
    edges,
    meta: {
      entryNode: meta.entryNode || nodes[0].id,
      exitNode: meta.exitNode || nodes[nodes.length - 1].id,
      description: meta.description || "",
      ...meta,
    },
  };
}

/**
 * Embed a sub-workflow into a parent workflow by prefixing all node/edge IDs.
 *
 * This is the core composition mechanism — like calling a function.
 * Each embed gets a unique prefix so the same sub-workflow can appear
 * multiple times in one parent without ID collisions.
 *
 * Returns { nodes, edges, entryNodeId, exitNodeId } ready to spread
 * into a parent template's nodes/edges arrays and wire with edges.
 *
 * @param {object} sub - Sub-workflow from subWorkflow()
 * @param {string} prefix - Unique prefix for this embed (e.g. "backend-")
 * @param {object} [opts] - Embedding options
 * @param {object} [opts.configOverrides] - Config values to merge into every node
 * @param {object} [opts.nodeOverrides] - Per-node config patches keyed by ORIGINAL (unprefixed) node ID
 * @returns {{ nodes: Array, edges: Array, entryNodeId: string, exitNodeId: string }}
 */
export function embedSubWorkflow(sub, prefix, opts = {}) {
  if (!sub || !Array.isArray(sub.nodes)) {
    throw new Error("embedSubWorkflow: first argument must be a sub-workflow");
  }
  if (!prefix || typeof prefix !== "string") {
    throw new Error("embedSubWorkflow: prefix must be a non-empty string");
  }

  // Support legacy positional: embedSubWorkflow(sub, prefix, configOverrides)
  const options = (opts && typeof opts === "object" && !Array.isArray(opts))
    ? (opts.configOverrides || opts.nodeOverrides ? opts : { configOverrides: opts })
    : {};
  const configOverrides = options.configOverrides || {};
  const nodeOverrides = options.nodeOverrides || {};

  const prefixedId = (id) => `${prefix}${id}`;

  const nodes = sub.nodes.map((n) => ({
    ...n,
    id: prefixedId(n.id),
    config: { ...n.config, ...configOverrides, ...(nodeOverrides[n.id] || {}) },
  }));

  const edges = sub.edges.map((e) => ({
    ...e,
    id: `${prefixedId(e.source)}->${prefixedId(e.target)}`,
    source: prefixedId(e.source),
    target: prefixedId(e.target),
  }));

  return {
    nodes,
    edges,
    entryNodeId: prefixedId(sub.meta.entryNode),
    exitNodeId: prefixedId(sub.meta.exitNode),
  };
}

/**
 * Connect two sub-workflow embeds (or any two nodes) with an edge.
 * Convenience for wiring exitNodeId → entryNodeId between composed fragments.
 *
 * @param {string} fromNodeId - Source node ID (typically exitNodeId of previous embed)
 * @param {string} toNodeId - Target node ID (typically entryNodeId of next embed)
 * @param {object} [opts] - Edge options (condition, port, backEdge, etc.)
 * @returns {object} Edge definition
 */
export function wire(fromNodeId, toNodeId, opts = {}) {
  return edge(fromNodeId, toNodeId, opts);
}

/**
 * Factory: build a complete agent pipeline template from phase definitions.
 *
 * Replaces the repetitive trigger → plan → implement → verify → done pattern
 * found across all task-execution templates. Only the phases differ.
 *
 * @param {object} opts
 * @param {string} opts.id - Template ID
 * @param {string} opts.name - Template display name
 * @param {string} opts.description - Template description
 * @param {string} opts.taskPattern - Regex for trigger.task_assigned matching
 * @param {Array<{id:string, label:string, prompt:string}>} opts.phases - Agent phases
 * @param {string[]} [opts.tags] - Metadata tags
 * @param {object} [opts.variables] - Variable overrides (merged with defaults)
 * @param {object} [opts.metadata] - Metadata overrides
 * @returns {object} Complete workflow template definition
 */
export function makeAgentPipeline(opts) {
  if (!opts?.id) throw new Error("makeAgentPipeline: id is required");
  if (!opts?.taskPattern) throw new Error("makeAgentPipeline: taskPattern is required");
  if (!Array.isArray(opts?.phases) || opts.phases.length === 0) {
    throw new Error("makeAgentPipeline: at least one phase is required");
  }

  resetLayout();

  const defaultVariables = {
    taskTimeoutMs: 21600000,
    maxRetries: 2,
    maxContinues: 3,
    testCommand: "auto",
    buildCommand: "auto",
    lintCommand: "auto",
  };

  const triggerNode = node("trigger", "trigger.task_assigned", "Task Assigned", {
    taskPattern: opts.taskPattern,
  }, { x: 400, y: 50 });

  const yStart = 180;
  const yStep = 160;
  const phaseNodes = opts.phases.map((phase, i) =>
    agentPhase(phase.id, phase.label, phase.prompt, phase.extra || {}, {
      x: 400,
      y: yStart + i * yStep,
    }),
  );

  const doneNode = node("done", "notify.log", "Complete", {
    message: opts.doneMessage || `${opts.name} completed.`,
  }, { x: 400, y: yStart + opts.phases.length * yStep });

  const allNodes = [triggerNode, ...phaseNodes, doneNode];

  // Linear pipeline: trigger → phase0 → phase1 → … → done
  const edges = [];
  edges.push(edge("trigger", opts.phases[0].id));
  for (let i = 0; i < opts.phases.length - 1; i++) {
    edges.push(edge(opts.phases[i].id, opts.phases[i + 1].id));
  }
  edges.push(edge(opts.phases[opts.phases.length - 1].id, "done"));

  return {
    id: opts.id,
    name: opts.name,
    description: opts.description || "",
    category: opts.category || "task-execution",
    enabled: true,
    recommended: opts.recommended !== false,
    trigger: "trigger.task_assigned",
    variables: { ...defaultVariables, ...opts.variables },
    metadata: {
      author: "bosun",
      version: 1,
      createdAt: "2025-06-01T00:00:00Z",
      templateVersion: "1.0.0",
      tags: opts.tags || [],
      resolveMode: "library",
      ...(opts.metadata || {}),
    },
    nodes: allNodes,
    edges,
  };
}
