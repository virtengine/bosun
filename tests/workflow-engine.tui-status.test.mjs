import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
import { WorkflowEngine, resetWorkflowEngine } from "../workflow/workflow-engine.mjs";
import { registerNodeType } from "../workflow/workflow-nodes.mjs";

function makeSimpleWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || `test-wf-${Math.random().toString(36).slice(2, 8)}`,
    name: opts.name || "Test Workflow",
    description: opts.description || "Workflow status event test",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
  };
}

describe("WorkflowEngine TUI status events", () => {
  let tmpDir;
  let engine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-tui-status-"));
    engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
      services: {},
    });
  });

  afterEach(() => {
    resetWorkflowEngine();
    resetStateLedgerCache();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort on Windows */ }
  });

  it("emits workflow:status for run start, node completion, run completion, and run errors", async () => {
    registerNodeType("test.tui_success", {
      describe: () => "Successful node",
      execute: async () => ({ ok: true }),
    });
    registerNodeType("test.tui_failure", {
      describe: () => "Failing node",
      execute: async () => {
        throw new Error("boom");
      },
    });

    const successWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "success", type: "test.tui_success", label: "Success", config: {} },
      ],
      [{ source: "trigger", target: "success" }],
      { id: "workflow-success", name: "Workflow Success" },
    );
    engine.save(successWorkflow);

    const successEvents = [];
    engine.on("workflow:status", (event) => successEvents.push(event));
    await engine.execute(successWorkflow.id, { trigger: true });

    expect(successEvents.some((event) => event.eventType === "run:start")).toBe(true);
    expect(successEvents.some((event) => event.eventType === "node:complete" && event.nodeId === "success")).toBe(true);
    expect(successEvents.some((event) => event.eventType === "run:end")).toBe(true);

    const failureWorkflow = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "failure", type: "test.tui_failure", label: "Failure", config: { maxRetries: 0 } },
      ],
      [{ source: "trigger", target: "failure" }],
      { id: "workflow-failure", name: "Workflow Failure" },
    );
    engine.save(failureWorkflow);

    const failureEvents = [];
    engine.on("workflow:status", (event) => {
      if (event.workflowId === failureWorkflow.id) failureEvents.push(event);
    });
    const failedRun = await engine.execute(failureWorkflow.id, { trigger: true });
    expect(failedRun?.dagState?.status || failedRun?.data?._dagState?.status).toBe('failed');

    expect(failureEvents.some((event) => event.eventType === "run:start")).toBe(true);
    expect(failureEvents.some((event) => (event.eventType === "run:error" && event.error === "boom") || (event.eventType === "run:end" && event.status === "failed"))).toBe(true);
  });
});


