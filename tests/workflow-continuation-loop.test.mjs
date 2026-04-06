import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowEngine } from "../workflow/workflow-engine.mjs";
import { installTemplate } from "../workflow/workflow-templates.mjs";
import "../workflow/workflow-nodes.mjs";

let tmpDir;
let engine;

function makeTmpEngine(services = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-continuation-loop-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services,
  });
  return engine;
}

function makeStatusKanban(statuses = []) {
  let idx = 0;
  return {
    getTask: vi.fn(async (taskId) => {
      const next = statuses[Math.min(idx, Math.max(0, statuses.length - 1))] || "todo";
      idx += 1;
      return {
        id: taskId,
        title: `Task ${taskId}`,
        externalStatus: next,
      };
    }),
  };
}

describe("continuation-loop template integration", () => {
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("polls externalStatus transitions and terminates on configured terminal state", async () => {
    const kanban = makeStatusKanban(["todo", "inprogress", "done"]);
    const launchEphemeralThread = vi.fn(async () => ({
      success: true,
      output: "continued",
      threadId: "session-1",
    }));
    makeTmpEngine({
      kanban,
      agentPool: { launchEphemeralThread },
    });

    const installed = installTemplate("template-continuation-loop", engine, {
      taskId: "TASK-100",
      worktreePath: tmpDir,
      pollIntervalMs: 0,
      maxTurns: 6,
      terminalStates: ["done", "cancelled"],
      stuckThresholdMs: 3600000,
      onStuck: "escalate",
      continuePrompt: "continue",
    });

    const ctx = await engine.execute(installed.id, {
      taskId: "TASK-100",
      sessionId: "session-1",
      worktreePath: tmpDir,
    }, { force: true });

    expect(ctx.errors).toEqual([]);
    expect(kanban.getTask).toHaveBeenCalled();
    expect(launchEphemeralThread.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(ctx.getNodeOutput("end-terminal")?.status).toBe("completed");
    expect(ctx.getNodeOutput("end-terminal")?.output?.externalStatus).toBe("done");
  }, 15000);

  it("fires a session-stuck event payload and executes retry action when no progress is detected", async () => {
    const kanban = makeStatusKanban(["inprogress", "inprogress", "done"]);
    const launchEphemeralThread = vi.fn(async (prompt) => ({
      success: true,
      output: `continued:${prompt}`,
      threadId: "session-stuck",
    }));
    makeTmpEngine({
      kanban,
      agentPool: { launchEphemeralThread },
    });

    const installed = installTemplate("template-continuation-loop", engine, {
      taskId: "TASK-200",
      worktreePath: tmpDir,
      pollIntervalMs: 0,
      maxTurns: 3,
      terminalStates: ["done", "cancelled"],
      stuckThresholdMs: 0,
      onStuck: "retry",
    });

    const ctx = await engine.execute(installed.id, {
      taskId: "TASK-200",
      sessionId: "session-stuck",
      worktreePath: tmpDir,
    }, { force: true });

    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("emit-stuck")?.eventType).toBe("session-stuck");
    expect(ctx.getNodeOutput("emit-stuck")?.payload?.onStuck).toBe("retry");
    expect(ctx.getNodeOutput("stuck-route")?.matchedPort).toBe("retry");
    expect(launchEphemeralThread.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ctx.getNodeOutput("end-terminal")?.output?.externalStatus).toBe("done");
  }, 15000);

  it("bounds stuck auto-retries and escalates with retry diagnostics after the limit", async () => {
    const kanban = {
      getTask: vi.fn(async (taskId) => ({
        id: taskId,
        title: `Task ${taskId}`,
        externalStatus: "inprogress",
      })),
    };
    const launchEphemeralThread = vi.fn(async (prompt) => ({
      success: true,
      output: `continued:${prompt}`,
      threadId: "session-stuck-limit",
    }));
    makeTmpEngine({
      kanban,
      agentPool: { launchEphemeralThread },
    });

    const installed = installTemplate("template-continuation-loop", engine, {
      taskId: "TASK-201",
      worktreePath: tmpDir,
      pollIntervalMs: 0,
      maxTurns: 5,
      terminalStates: ["done", "cancelled"],
      stuckThresholdMs: 0,
      onStuck: "retry",
      maxStuckAutoRetries: 1,
    });

    const ctx = await engine.execute(installed.id, {
      taskId: "TASK-201",
      sessionId: "session-stuck-limit",
      worktreePath: tmpDir,
    }, { force: true });

    expect(ctx.errors).toEqual([]);
    expect(ctx.getNodeOutput("emit-stuck")?.payload?.stuckRetryCount).toBe(1);
    expect(ctx.getNodeOutput("emit-stuck")?.payload?.maxStuckAutoRetries).toBe(1);
    expect(ctx.getNodeOutput("stuck-retry-budget")?.result).toBe(false);
    expect(ctx.getNodeStatus("stuck-escalate-budget")).toBe("completed");
    expect(ctx.getNodeStatus("end-escalated-budget")).toBe("completed");
    expect(launchEphemeralThread.mock.calls.length).toBeGreaterThanOrEqual(3);
  }, 15000);
  it("injects issue-advisor guidance into planner feedback for downstream continuation prompts", async () => {
    makeTmpEngine();
    const ctxLike = {
      data: {
        _dagState: {
          runId: "run-123",
          workflowId: "wf-123",
          status: "failed",
          nodes: {
            build: { nodeId: "build", label: "Build", status: "completed" },
            verify: {
              nodeId: "verify",
              label: "Verify",
              status: "failed",
              lastError: "validation failed: tests red",
            },
            patch: { nodeId: "patch", label: "Patch", status: "pending" },
          },
        },
      },
    };

    const advisor = engine._refreshDagState(ctxLike, "failed");
    expect(advisor.summary).toContain("Verify");
    expect(ctxLike.data._plannerFeedback.issueAdvisor.summary).toContain("Verify");
    expect(ctxLike.data._plannerFeedback.issueAdvisor.nextStepGuidance).toContain("Preserve completed work");
    expect(ctxLike.data._plannerFeedback.dagStateSummary.counts.failed).toBe(1);
  });
});
