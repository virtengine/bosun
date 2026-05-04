/**
 * workflow-serializer.mjs — Workflow ↔ JSON code serialization
 *
 * Converts between the internal workflow graph format (nodes/edges/variables)
 * and a clean, human-readable JSON representation for code editing.
 *
 * Browser-safe flowchart helpers (used by both the UI and the Node-side
 * serializer) live in `lib/workflow-flowchart-utils.mjs`. Importing them from
 * a single source keeps the UI free of `node:*` dependencies while preserving
 * the public surface of this module.
 */
import { createHash } from "node:crypto";
import {
  cloneJsonValue,
  normalizeText,
  uniqueStrings,
  buildWorkflowDraftFlowchart,
  normalizeWorkflowFlowchartMetadata,
} from "../lib/workflow-flowchart-utils.mjs";

export {
  buildWorkflowDraftFlowchart,
  normalizeWorkflowFlowchartMetadata,
};

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
