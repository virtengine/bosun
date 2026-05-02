import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({ primaryAgent: "codex-sdk", voice: {} })),
}));

vi.mock("../agent/primary-agent.mjs", () => ({
  execPrimaryPrompt: vi.fn(async () => "agent response"),
  getPrimaryAgentName: vi.fn(() => "codex-sdk"),
  setPrimaryAgent: vi.fn(),
}));

vi.mock("../agent/agent-pool.mjs", () => ({
  execPooledPrompt: vi.fn(async () => ({
    finalResponse: "pooled agent response",
    items: [],
    usage: null,
  })),
  resolvePoolSdkName: vi.fn((sdk) => sdk || "codex-sdk"),
}));

vi.mock("../kanban/kanban-adapter.mjs", () => ({
  getKanbanAdapter: vi.fn(() => ({
    listProjects: vi.fn(async () => []),
    listTasks: vi.fn(async () => []),
  })),
}));

vi.mock("../infra/session-tracker.mjs", () => ({
  listSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSessionById: vi.fn(() => null),
  recordEvent: vi.fn(),
}));

vi.mock("../agent/fleet-coordinator.mjs", () => ({
  getFleetStatus: vi.fn(() => ({ instances: [] })),
}));

vi.mock("../agent/agent-supervisor.mjs", () => ({}));
vi.mock("../workspace/shared-state-manager.mjs", () => ({}));

vi.mock("../workflow/workflow-engine.mjs", () => ({
  getWorkflowEngine: vi.fn(() => ({
    getRunDetail: vi.fn((runId) => {
      if (runId === "run-failed") {
        return {
          runId,
          workflowId: "wf-1",
          workflowName: "Workflow One",
          status: "failed",
          detail: { data: { _workflowId: "wf-1", _workflowName: "Workflow One" } },
        };
      }
      if (runId === "run-create-tasks-resume") {
        return {
          runId,
          workflowId: "wf-1",
          workflowName: "Workflow One",
          status: "paused",
          detail: { data: { _workflowId: "wf-1", _workflowName: "Workflow One" } },
        };
      }
      if (runId === "run-create-tasks-blocked") {
        return {
          runId,
          workflowId: "wf-1",
          workflowName: "Workflow One",
          status: "paused",
          detail: { data: { _workflowId: "wf-1", _workflowName: "Workflow One" } },
        };
      }
      return null;
    }),
    getRetryOptions: vi.fn((runId) => (runId === "run-create-tasks-resume"
      ? {
          runId,
          status: "paused",
          recommendedMode: "from_failed",
          recommendedReason: "create_tasks_pending.resume_only",
          guardedState: {
            code: "create_tasks_pending",
            nextNodeLabel: "Create Tasks",
            safeResume: true,
          },
        }
      : (runId === "run-create-tasks-blocked"
        ? {
            runId,
            status: "paused",
            recommendedMode: "from_scratch",
            guardedState: {
              code: "create_tasks_pending",
              nextNodeLabel: "Create Tasks",
              safeResume: false,
            },
          }
        : null))),
    resolveOperatorRetry: vi.fn((runId, mode) => (runId === "run-create-tasks-resume"
      ? {
          mode,
          operatorAction: "resume",
          decisionReason: "create_tasks_pending.resume_only",
          blocked: false,
          guardedState: {
            code: "create_tasks_pending",
            nextNodeLabel: "Create Tasks",
            safeResume: true,
          },
          retryArgs: {
            mode,
            _resumeInterrupted: true,
            _decisionReason: "create_tasks_pending.resume_only",
          },
        }
      : (runId === "run-create-tasks-blocked"
        ? {
            mode,
            operatorAction: "retry",
            blocked: true,
            blockedMessage: "Run is paused with Create Tasks as the next pending node. Manual retry is blocked to avoid duplicate task creation.",
            guardedState: {
              code: "create_tasks_pending",
              nextNodeLabel: "Create Tasks",
              safeResume: false,
            },
          }
        : null))),
    retryRun: vi.fn(async (runId, opts = {}) => ({
      originalRunId: runId,
      retryRunId: `retry-${runId}`,
      mode: opts.mode || "from_failed",
      ctx: { errors: [] },
    })),
  })),
}));

const { executeToolCall } = await import("../voice/voice-tools.mjs");

describe("voice-tools Create Tasks retry guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports resume context for guarded Create Tasks recovery", async () => {
    const result = await executeToolCall(
      "retry_workflow_run",
      { runId: "run-create-tasks-resume", mode: "from_failed" },
      { surface: "bosun-tool" },
    );
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.result);
    expect(parsed).toMatchObject({
      ok: true,
      mode: "from_failed",
      originalRunId: "run-create-tasks-resume",
      retryRunId: "retry-run-create-tasks-resume",
      operatorAction: "resume",
      decisionReason: "create_tasks_pending.resume_only",
      guardedState: {
        code: "create_tasks_pending",
        safeResume: true,
      },
    });
  });

  it("blocks unsafe guarded Create Tasks retries with operator guidance", async () => {
    const result = await executeToolCall(
      "retry_workflow_run",
      { runId: "run-create-tasks-blocked", mode: "from_failed" },
      { surface: "bosun-tool" },
    );
    expect(result.error).toBeUndefined();
    const parsed = JSON.parse(result.result);
    expect(parsed).toMatchObject({
      ok: false,
      mode: "from_failed",
      operatorAction: "retry",
      guardedState: {
        code: "create_tasks_pending",
        safeResume: false,
      },
      retryOptions: {
        recommendedMode: "from_scratch",
      },
    });
    expect(String(parsed.error || "")).toMatch(/Create Tasks.*duplicate task creation/i);
  });
});
