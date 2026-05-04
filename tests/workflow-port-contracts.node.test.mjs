import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowEngine,
  registerNodeType,
  isPortConnectionCompatible,
} from "../workflow/workflow-engine.mjs";
import {
  installTemplate,
  applyWorkflowTemplateState,
} from "../workflow/workflow-templates.mjs";
import "../workflow/workflow-nodes.mjs";

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-port-contract-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

function uniqueType(prefix) {
  return `test.${prefix}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

describe("workflow port compatibility contract", () => {
  it("accepts wildcard and declared accepted types", () => {
    assert.deepEqual(
      isPortConnectionCompatible(
        { name: "out", label: "Out", type: "json" },
        { name: "in", label: "In", type: "Any" },
      ),
      { compatible: true, reason: null },
    );

    assert.deepEqual(
      isPortConnectionCompatible(
        { name: "out", label: "Out", type: "json" },
        { name: "in", label: "In", type: "text", accepts: ["json", "yaml"] },
      ),
      { compatible: true, reason: null },
    );

    assert.deepEqual(
      isPortConnectionCompatible(
        { name: "out", label: "Out", type: "JSON" },
        { name: "in", label: "In", type: "TaskDef", accepts: ["json"] },
      ),
      { compatible: true, reason: null },
    );

    assert.deepEqual(
      isPortConnectionCompatible(
        { name: "out", label: "Out", type: "json" },
        { name: "in", label: "In", type: "TaskDef" },
      ),
      { compatible: true, reason: null },
    );
  });

  it("returns a helpful incompatibility reason for mismatched types", () => {
    const result = isPortConnectionCompatible(
      { name: "raw", label: "Raw Output", type: "json" },
      { name: "number", label: "Number Input", type: "number" },
    );

    assert.equal(result.compatible, false);
    assert.match(result.reason || "", /Raw Output emits json/);
    assert.match(result.reason || "", /Number Input expects number/);
  });
});

describe("workflow engine port hydration", () => {
  beforeEach(() => {
    makeTmpEngine();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // noop
    }
  });

  it("rejects save() when edge port types are incompatible", () => {
    const sourceType = uniqueType("port_source");
    const targetType = uniqueType("port_target");

    registerNodeType(sourceType, {
      describe: () => "Typed source",
      schema: { type: "object", properties: {} },
      outputs: [{ name: "default", label: "Raw", type: "json" }],
      async execute() {
        return { ok: true };
      },
    });

    registerNodeType(targetType, {
      describe: () => "Typed target",
      schema: { type: "object", properties: {} },
      inputs: [{ name: "default", label: "Scalar", type: "number" }],
      async execute() {
        return { ok: true };
      },
    });

    const wf = {
      id: "wf-save-rejects-incompatible-ports",
      name: "Save Rejects Incompatible Ports",
      enabled: true,
      nodes: [
        { id: "source", type: sourceType, label: "Source", config: {} },
        { id: "target", type: targetType, label: "Target", config: {} },
      ],
      edges: [{ id: "e1", source: "source", target: "target" }],
      variables: {},
    };

    assert.throws(
      () => engine.save(wf),
      /Workflow port validation failed: Raw emits json, but Scalar expects number/,
    );
  });

  it("load() preserves workflows and annotates validation issues for bad edges", () => {
    const sourceType = uniqueType("load_source");
    const targetType = uniqueType("load_target");

    registerNodeType(sourceType, {
      describe: () => "Typed source",
      schema: { type: "object", properties: {} },
      outputs: [{ name: "default", label: "Out", type: "json" }],
      async execute() {
        return { ok: true };
      },
    });

    registerNodeType(targetType, {
      describe: () => "Typed target",
      schema: { type: "object", properties: {} },
      inputs: [{ name: "default", label: "In", type: "number" }],
      async execute() {
        return { ok: true };
      },
    });

    const persisted = {
      id: "wf-load-hydrates-validation-issues",
      name: "Load Hydration Validation Issues",
      enabled: true,
      nodes: [
        { id: "source", type: sourceType, label: "Source", config: {} },
        { id: "target", type: targetType, label: "Target", config: {} },
      ],
      edges: [{ id: "e1", source: "source", target: "target" }],
      metadata: {},
      variables: {},
    };

    mkdirSync(join(tmpDir, "workflows"), { recursive: true });
    writeFileSync(join(tmpDir, "workflows", "wf-load-hydrates-validation-issues.json"), `${JSON.stringify(persisted, null, 2)}\n`);

    engine.load();
    const loaded = engine.get("wf-load-hydrates-validation-issues");

    assert.ok(loaded, "workflow should still be loaded in non-strict mode");
    assert.ok(Array.isArray(loaded.metadata?.validationIssues));
    assert.equal(loaded.metadata.validationIssues.length, 1);
    assert.equal(loaded.metadata.validationIssues[0].edgeId, "e1");
    assert.equal(loaded.metadata.validationIssues[0].sourceType, "json");
    assert.equal(loaded.metadata.validationIssues[0].targetType, "number");
    assert.equal(loaded.edges[0].sourcePortType, "json");
    assert.equal(loaded.edges[0].targetPortType, "number");
  });

  it("save() persists edge port type metadata for compatible edges", () => {
    const sourceType = uniqueType("save_source");
    const targetType = uniqueType("save_target");

    registerNodeType(sourceType, {
      describe: () => "Typed source",
      schema: { type: "object", properties: {} },
      outputs: [{ name: "default", label: "Out", type: "TaskDef" }],
      async execute() {
        return { ok: true };
      },
    });

    registerNodeType(targetType, {
      describe: () => "Typed target",
      schema: { type: "object", properties: {} },
      inputs: [{ name: "default", label: "In", type: "TaskDef" }],
      async execute() {
        return { ok: true };
      },
    });

    const saved = engine.save({
      id: "wf-save-persists-edge-port-types",
      name: "Save Persists Edge Port Types",
      enabled: true,
      nodes: [
        { id: "source", type: sourceType, label: "Source", config: {} },
        { id: "target", type: targetType, label: "Target", config: {} },
      ],
      edges: [{ id: "e1", source: "source", target: "target" }],
      variables: {},
    });

    assert.equal(saved.edges[0].sourcePortType, "TaskDef");
    assert.equal(saved.edges[0].targetPortType, "TaskDef");
  });

  it("installs the task lifecycle template without rejecting chained agent phases", () => {
    assert.doesNotThrow(() => {
      installTemplate("template-task-lifecycle", engine);
    });
    const installed = engine.list().find((workflow) => workflow.metadata?.installedFrom === "template-task-lifecycle");
    assert.ok(installed, "task lifecycle template should install successfully");
  });
});

describe("template fingerprint normalization for hydrated port metadata", () => {
  beforeEach(() => {
    makeTmpEngine();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // noop
    }
  });

  it("does not mark template-backed workflows customized for synthesized port fields", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);

    applyWorkflowTemplateState(wf);
    assert.equal(wf.metadata.templateState.isCustomized, false);

    for (const node of wf.nodes) {
      node.inputs = ["default"];
      node.inputPorts = [{ name: "default", label: "Default", type: "Any" }];
      node.outputPorts = [{ name: "default", label: "Default", type: "Any" }];
      node.outputs = ["default", "default"];
    }
    for (const edge of wf.edges) {
      edge.sourcePortType = "Any";
      edge.targetPortType = "Any";
      if (!Object.hasOwn(edge, "sourcePort")) edge.sourcePort = "default";
      if (!Object.hasOwn(edge, "targetPort")) edge.targetPort = "default";
    }

    applyWorkflowTemplateState(wf);
    assert.equal(
      wf.metadata.templateState.isCustomized,
      false,
      "derived port metadata should be ignored by fingerprint drift logic",
    );
  });

  it("still detects real user drift after fingerprint normalization", () => {
    const installed = installTemplate("template-error-recovery", engine);
    const wf = engine.get(installed.id);

    wf.variables._customizedByUser = "yes";
    applyWorkflowTemplateState(wf);

    assert.equal(wf.metadata.templateState.isCustomized, true);
  });
});
