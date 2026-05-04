import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const originalCommandDiagnosticsStateFile = process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE;

async function loadWorkflowHarness() {
  vi.resetModules();
  const [{ WorkflowContext }, { getNodeType }] = await Promise.all([
    import("../workflow/workflow-engine.mjs"),
    import("../workflow/workflow-nodes.mjs"),
  ]);
  return { WorkflowContext, getNodeType };
}

function buildCtx(WorkflowContext, data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

describe("workflow heavy runner integration", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
      tempDir = "";
    }
    if (originalCommandDiagnosticsStateFile === undefined) {
      delete process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE;
    } else {
      process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE = originalCommandDiagnosticsStateFile;
    }
    vi.resetModules();
  });

  it("offloads validation.tests runs and preserves compact retrieval fields", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-validation-runner-"));
    process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE = join(tempDir, "command-diagnostics-state.json");
    const { WorkflowContext, getNodeType } = await loadWorkflowHarness();
    const nodeType = getNodeType("validation.tests");
    const node = makeNode("validation.tests", {
      command:
        "node -e \"for (let i = 0; i < 220; i += 1) console.log('ok helper-' + i + ' ' + 'x'.repeat(16)); console.log('FAIL tests/runtime/example.test.ts'); console.error('Error: expected true to be false'); process.exit(1);\"",
      runner: {
        enabled: true,
        runtime: "local-process",
        artifactDir: join(tempDir, ".artifacts"),
      },
    });

    const result = await nodeType.execute(node, buildCtx(WorkflowContext, { worktreePath: tempDir }));

    expect(result.passed).toBe(false);
    expect(result.executionLane).toBe("runner-pool");
    expect(result.runnerLease?.runtime).toBe("local-process");
    expect(Array.isArray(result.runnerArtifactPointers)).toBe(true);
    expect(result.runnerArtifactPointers.length).toBeGreaterThan(0);
    expect(result.outputCompacted).toBe(true);
    expect(result.output).toContain("bosun --tool-log");
    expect(
      result.outputSuggestedRerun
      || result.outputDiagnostics?.suggestedRerun
      || result.output,
    ).toContain("vitest run");
  }, process.platform === "win32" ? 30000 : 15000);

  it("surfaces blocked evidence when runner lease acquisition exhausts retries", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-validation-runner-blocked-"));
    process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE = join(tempDir, "command-diagnostics-state.json");
    const { WorkflowContext, getNodeType } = await loadWorkflowHarness();
    const nodeType = getNodeType("validation.build");
    const node = makeNode("validation.build", {
      command: 'node -e "console.log(\'build\')"',
      runner: {
        enabled: true,
        runtime: "remote-sandbox",
        retries: 1,
        artifactDir: join(tempDir, ".artifacts"),
      },
    });

    const result = await nodeType.execute(node, buildCtx(WorkflowContext, { worktreePath: tempDir }));

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("runner_lease_failed");
    expect(result.executionLane).toBe("runner-pool");
    expect(result.runnerLease?.status).toBe("blocked");
    expect(result.output).toContain("runner lease");
  });
});
