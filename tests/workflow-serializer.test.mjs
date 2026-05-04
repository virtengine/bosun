import { describe, it, expect } from "vitest";
import {
  buildWorkflowDraftFlowchart,
  serializeWorkflowToCode,
  deserializeCodeToWorkflow,
  validateWorkflowCode,
  diffWorkflowCode,
} from "../workflow/workflow-serializer.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeWorkflow(overrides = {}) {
  return {
    id: "wf-test-1",
    name: "Test Workflow",
    description: "A test workflow",
    category: "testing",
    enabled: true,
    variables: { apiKey: "secret" },
    nodes: [
      { id: "n1", type: "trigger.manual", label: "Start", position: { x: 10, y: 20 } },
      { id: "n2", type: "action.http_request", label: "Fetch", config: { url: "https://example.com" }, position: { x: 100, y: 20 } },
    ],
    edges: [
      { source: "n1", target: "n2", label: "on-start" },
    ],
    // Internal metadata that should be stripped
    _internal: true,
    createdAt: "2025-01-01",
    updatedAt: "2025-06-01",
    ...overrides,
  };
}

// ── serializeWorkflowToCode ─────────────────────────────────────────────────

describe("serializeWorkflowToCode", () => {
  it("serializes a valid workflow to JSON code + hash + metadata", () => {
    const wf = makeWorkflow();
    const result = serializeWorkflowToCode(wf);

    expect(result.code).toBeTruthy();
    expect(typeof result.code).toBe("string");
    expect(typeof result.hash).toBe("string");
    expect(result.hash).toHaveLength(16);

    const parsed = JSON.parse(result.code);
    expect(parsed.name).toBe("Test Workflow");
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.edges).toHaveLength(1);

    expect(result.metadata.nodeCount).toBe(2);
    expect(result.metadata.edgeCount).toBe(1);
    expect(result.metadata.variableCount).toBe(1);
    expect(result.metadata.triggerTypes).toEqual(["trigger.manual"]);
    expect(typeof result.metadata.serializedAt).toBe("number");
  });

  it("strips internal metadata (_internal, createdAt, updatedAt)", () => {
    const wf = makeWorkflow();
    const result = serializeWorkflowToCode(wf);
    const parsed = JSON.parse(result.code);

    expect(parsed._internal).toBeUndefined();
    expect(parsed.createdAt).toBeUndefined();
    expect(parsed.updatedAt).toBeUndefined();
    expect(parsed.id).toBeUndefined();
  });

  it("handles empty workflow (no nodes/edges/variables)", () => {
    const result = serializeWorkflowToCode({ name: "Empty" });
    const parsed = JSON.parse(result.code);

    expect(parsed.name).toBe("Empty");
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
    expect(parsed.variables).toEqual({});
    expect(result.metadata.nodeCount).toBe(0);
  });

  it("defaults name to 'Untitled Workflow' when missing", () => {
    const result = serializeWorkflowToCode({});
    const parsed = JSON.parse(result.code);
    expect(parsed.name).toBe("Untitled Workflow");
  });

  it("throws on null input", () => {
    expect(() => serializeWorkflowToCode(null)).toThrow("Invalid workflow");
  });

  it("throws on non-object input", () => {
    expect(() => serializeWorkflowToCode("string")).toThrow("Invalid workflow");
  });

  it("omits empty config on nodes", () => {
    const wf = makeWorkflow({
      nodes: [{ id: "n1", type: "trigger.manual", config: {} }],
    });
    const result = serializeWorkflowToCode(wf);
    const parsed = JSON.parse(result.code);
    expect(parsed.nodes[0].config).toBeUndefined();
  });

  it("includes non-empty config on nodes", () => {
    const wf = makeWorkflow();
    const result = serializeWorkflowToCode(wf);
    const parsed = JSON.parse(result.code);
    const fetchNode = parsed.nodes.find(n => n.id === "n2");
    expect(fetchNode.config).toEqual({ url: "https://example.com" });
  });

  it("produces deterministic hash for same input", () => {
    const wf = makeWorkflow();
    const r1 = serializeWorkflowToCode(wf);
    const r2 = serializeWorkflowToCode(wf);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.code).toBe(r2.code);
  });

  it("omits optional edge fields when absent", () => {
    const wf = makeWorkflow({
      edges: [{ source: "n1", target: "n2" }],
    });
    const result = serializeWorkflowToCode(wf);
    const parsed = JSON.parse(result.code);
    const edge = parsed.edges[0];
    expect(edge.sourcePort).toBeUndefined();
    expect(edge.targetPort).toBeUndefined();
    expect(edge.label).toBeUndefined();
    expect(edge.condition).toBeUndefined();
  });

  it("serializes a linked draft flowchart map into workflow metadata", () => {
    const wf = makeWorkflow({
      nodes: [
        { id: "start", type: "trigger.manual", label: "Start", position: { x: 10, y: 20 } },
        { id: "fetch", type: "action.http_request", label: "Fetch", position: { x: 180, y: 20 } },
        { id: "notify", type: "action.log", label: "Notify", position: { x: 360, y: 20 } },
      ],
      edges: [
        { id: "edge-1", source: "start", target: "fetch" },
        { id: "edge-2", source: "fetch", target: "notify" },
      ],
      groups: [{ id: "group-fetch", label: "Research", nodeIds: ["start", "fetch"] }],
    });

    const result = serializeWorkflowToCode(wf);
    const parsed = JSON.parse(result.code);

    expect(parsed.metadata?.flowchart?.steps).toEqual([
      expect.objectContaining({
        id: "group:group-fetch",
        label: "Research",
        runtimeNodeIds: ["start", "fetch"],
      }),
      expect.objectContaining({
        id: "node:notify",
        label: "Notify",
        runtimeNodeIds: ["notify"],
      }),
    ]);
    expect(parsed.metadata?.flowchart?.links).toEqual([
      expect.objectContaining({
        sourceStepId: "group:group-fetch",
        targetStepId: "node:notify",
        edgeIds: ["edge-2"],
      }),
    ]);
  });
});

// ── deserializeCodeToWorkflow ───────────────────────────────────────────────

describe("deserializeCodeToWorkflow", () => {
  it("deserializes valid JSON code into a workflow", () => {
    const code = JSON.stringify({
      name: "My Flow",
      description: "desc",
      nodes: [{ id: "a", type: "trigger.manual" }],
      edges: [{ source: "a", target: "a" }],
    });
    const { workflow, errors } = deserializeCodeToWorkflow(code);

    expect(errors).toEqual([]);
    expect(workflow).not.toBeNull();
    expect(workflow.name).toBe("My Flow");
    expect(workflow.nodes).toHaveLength(1);
    expect(workflow.edges).toHaveLength(1);
    expect(workflow.enabled).toBe(true);
    expect(workflow.category).toBe("custom");
  });

  it("returns errors for invalid JSON syntax", () => {
    const { workflow, errors } = deserializeCodeToWorkflow("{bad json}");
    expect(workflow).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("JSON parse error");
  });

  it("returns errors for empty input", () => {
    const { workflow, errors } = deserializeCodeToWorkflow("");
    expect(workflow).toBeNull();
    expect(errors).toEqual(["Empty or non-string input"]);
  });

  it("returns errors for non-string input", () => {
    const { workflow, errors } = deserializeCodeToWorkflow(123);
    expect(workflow).toBeNull();
    expect(errors).toEqual(["Empty or non-string input"]);
  });

  it("returns errors when root is an array", () => {
    const { workflow, errors } = deserializeCodeToWorkflow("[]");
    expect(workflow).toBeNull();
    expect(errors).toEqual(["Root must be a JSON object"]);
  });

  it("returns errors for missing name", () => {
    const code = JSON.stringify({ nodes: [], edges: [] });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors).toContain("Missing or empty 'name' field");
  });

  it("returns errors for missing nodes array", () => {
    const code = JSON.stringify({ name: "X", edges: [] });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors).toContain("'nodes' must be an array");
  });

  it("returns errors for missing edges array", () => {
    const code = JSON.stringify({ name: "X", nodes: [] });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors).toContain("'edges' must be an array");
  });

  it("detects duplicate node ids", () => {
    const code = JSON.stringify({
      name: "Dup",
      nodes: [
        { id: "n1", type: "a" },
        { id: "n1", type: "b" },
      ],
      edges: [],
    });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors.some(e => e.includes("duplicate id"))).toBe(true);
  });

  it("detects nodes with missing id/type", () => {
    const code = JSON.stringify({
      name: "Bad",
      nodes: [{ label: "no-id-or-type" }],
      edges: [],
    });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors.some(e => e.includes("missing or invalid 'id'"))).toBe(true);
    expect(errors.some(e => e.includes("missing or invalid 'type'"))).toBe(true);
  });

  it("detects edges with missing source/target", () => {
    const code = JSON.stringify({
      name: "Bad",
      nodes: [{ id: "n1", type: "a" }],
      edges: [{ source: "n1" }],
    });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors.some(e => e.includes("missing or invalid 'target'"))).toBe(true);
  });

  it("migrates legacy edge port aliases into explicit source/target port fields", () => {
    const code = JSON.stringify({
      name: "Migrated Ports",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.run_command" },
      ],
      edges: [{ source: "n1", target: "n2", fromPort: "success", toPort: "payload" }],
    });

    const { workflow, errors } = deserializeCodeToWorkflow(code);

    expect(errors).toEqual([]);
    expect(workflow.edges[0].sourcePort).toBe("success");
    expect(workflow.edges[0].targetPort).toBe("payload");
    expect(workflow.edges[0].fromPort).toBeUndefined();
    expect(workflow.edges[0].toPort).toBeUndefined();
  });

  it("rejects variables as array", () => {
    const code = JSON.stringify({
      name: "V",
      nodes: [],
      edges: [],
      variables: [],
    });
    const { errors } = deserializeCodeToWorkflow(code);
    expect(errors).toContain("'variables' must be a plain object");
  });

  it("preserves explicit flowchart metadata through deserialization", () => {
    const code = JSON.stringify({
      name: "Flowchart",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.log" },
      ],
      edges: [{ source: "n1", target: "n2" }],
      metadata: {
        flowchart: {
          version: 1,
          source: "user",
          steps: [
            { id: "plan-step", label: "Plan Step", runtimeNodeIds: ["n1", "n2"] },
          ],
          links: [],
        },
      },
    });

    const { workflow, errors } = deserializeCodeToWorkflow(code);

    expect(errors).toEqual([]);
    expect(workflow.metadata.flowchart.steps).toEqual([
      expect.objectContaining({
        id: "plan-step",
        label: "Plan Step",
        runtimeNodeIds: ["n1", "n2"],
      }),
    ]);
  });

  it("defaults enabled to true if omitted", () => {
    const code = JSON.stringify({ name: "X", nodes: [], edges: [] });
    const { workflow } = deserializeCodeToWorkflow(code);
    expect(workflow.enabled).toBe(true);
  });

  it("preserves enabled: false", () => {
    const code = JSON.stringify({ name: "X", nodes: [], edges: [], enabled: false });
    const { workflow } = deserializeCodeToWorkflow(code);
    expect(workflow.enabled).toBe(false);
  });
});

// ── validateWorkflowCode ────────────────────────────────────────────────────

describe("validateWorkflowCode", () => {
  it("returns valid: true for valid code", () => {
    const code = JSON.stringify({
      name: "Valid",
      nodes: [{ id: "n1", type: "trigger.manual" }],
      edges: [],
    });
    const result = validateWorkflowCode(code);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns valid: false with line number for JSON syntax errors", () => {
    const result = validateWorkflowCode('{\n  "name": "X",\n  bad\n}');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("JSON syntax error");
  });

  it("returns valid: false for structural errors", () => {
    const code = JSON.stringify({ nodes: "not-an-array", edges: [] });
    const result = validateWorkflowCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid: false for empty input", () => {
    const result = validateWorkflowCode("");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toBe("Empty input");
  });

  it("returns valid: false for non-string input", () => {
    const result = validateWorkflowCode(null);
    expect(result.valid).toBe(false);
  });
});

// ── diffWorkflowCode ───────────────────────────────────────────────────────

describe("diffWorkflowCode", () => {
  const base = JSON.stringify({
    name: "Flow",
    nodes: [
      { id: "n1", type: "trigger.manual" },
      { id: "n2", type: "action.log" },
    ],
    edges: [{ source: "n1", target: "n2" }],
  });

  it("reports no changes for identical code", () => {
    const diff = diffWorkflowCode(base, base);
    expect(diff.changed).toBe(false);
    expect(diff.summary).toBe("No changes");
  });

  it("detects added nodes", () => {
    const modified = JSON.stringify({
      name: "Flow",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.log" },
        { id: "n3", type: "action.http" },
      ],
      edges: [{ source: "n1", target: "n2" }],
    });
    const diff = diffWorkflowCode(base, modified);
    expect(diff.changed).toBe(true);
    expect(diff.nodesDiff.added).toEqual(["n3"]);
    expect(diff.summary).toContain("+1 nodes");
  });

  it("detects removed nodes", () => {
    const modified = JSON.stringify({
      name: "Flow",
      nodes: [{ id: "n1", type: "trigger.manual" }],
      edges: [],
    });
    const diff = diffWorkflowCode(base, modified);
    expect(diff.changed).toBe(true);
    expect(diff.nodesDiff.removed).toEqual(["n2"]);
  });

  it("detects modified nodes", () => {
    const modified = JSON.stringify({
      name: "Flow",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.http" },
      ],
      edges: [{ source: "n1", target: "n2" }],
    });
    const diff = diffWorkflowCode(base, modified);
    expect(diff.changed).toBe(true);
    expect(diff.nodesDiff.modified).toContain("n2");
  });

  it("detects added/removed edges", () => {
    const modified = JSON.stringify({
      name: "Flow",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.log" },
      ],
      edges: [
        { source: "n1", target: "n2" },
        { source: "n2", target: "n1" },
      ],
    });
    const diff = diffWorkflowCode(base, modified);
    expect(diff.changed).toBe(true);
    expect(diff.edgesDiff.added).toContain("n2->n1");
  });

  it("detects rename", () => {
    const modified = JSON.stringify({
      name: "New Name",
      nodes: [
        { id: "n1", type: "trigger.manual" },
        { id: "n2", type: "action.log" },
      ],
      edges: [{ source: "n1", target: "n2" }],
    });
    const diff = diffWorkflowCode(base, modified);
    expect(diff.changed).toBe(true);
    expect(diff.summary).toContain("Renamed");
  });

  it("handles parse errors gracefully", () => {
    const diff = diffWorkflowCode("{bad", base);
    expect(diff.changed).toBe(true);
    expect(diff.summary).toContain("parse errors");
  });
});

// ── Round-trip ──────────────────────────────────────────────────────────────

describe("Round-trip: serialize → deserialize", () => {
  it("preserves core fields through a round-trip", () => {
    const wf = makeWorkflow();
    const serialized = serializeWorkflowToCode(wf);
    const { workflow, errors } = deserializeCodeToWorkflow(serialized.code);

    expect(errors).toEqual([]);
    expect(workflow.name).toBe(wf.name);
    expect(workflow.description).toBe(wf.description);
    expect(workflow.category).toBe(wf.category);
    expect(workflow.enabled).toBe(wf.enabled);
    expect(workflow.variables).toEqual(wf.variables);
    expect(workflow.nodes).toHaveLength(wf.nodes.length);
    expect(workflow.edges).toHaveLength(wf.edges.length);

    // Node ids preserved
    expect(workflow.nodes.map(n => n.id)).toEqual(wf.nodes.map(n => n.id));
    // Edge source/target preserved
    expect(workflow.edges[0].source).toBe(wf.edges[0].source);
    expect(workflow.edges[0].target).toBe(wf.edges[0].target);
  });

  it("supplements a partial saved flowchart with missing runtime nodes and links", () => {
    const flowchart = buildWorkflowDraftFlowchart({
      nodes: [
        { id: "n1", type: "trigger.manual", label: "Start", position: { x: 0, y: 0 } },
        { id: "n2", type: "action.log", label: "Log", position: { x: 150, y: 0 } },
      ],
      edges: [{ source: "n1", target: "n2" }],
      metadata: {
        flowchart: {
          version: 1,
          source: "user",
          steps: [
            { id: "manual-step", label: "Start", runtimeNodeIds: ["n1"] },
          ],
          links: [],
        },
      },
    });

    expect(flowchart.steps).toEqual([
      expect.objectContaining({ id: "manual-step", runtimeNodeIds: ["n1"] }),
      expect.objectContaining({ id: "node:n2", runtimeNodeIds: ["n2"] }),
    ]);
    expect(flowchart.links).toEqual([
      expect.objectContaining({ sourceStepId: "manual-step", targetStepId: "node:n2" }),
    ]);
  });
});
