import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import "../workflow/workflow-nodes/triggers.mjs";
import "../workflow/workflow-nodes/actions.mjs";
import "../workflow/workflow-nodes/flow.mjs";
import { getNodeType } from "../workflow/workflow-engine.mjs";
import { _resetSingleton, getSessionTracker } from "../infra/session-tracker.mjs";
import {
  getApprovalRequest,
  getApprovalRequestById,
  resolveApprovalRequest,
} from "../workflow/approval-queue.mjs";
import { createHarnessSessionManager } from "../agent/session-manager.mjs";

describe("workflow modular actions", () => {
  beforeEach(() => {
    _resetSingleton({ persistDir: null });
  });

  afterEach(() => {
    _resetSingleton({ persistDir: null });
    vi.restoreAllMocks();
  });

  it("registers merge-aware push_branch schema in the modular action registry", () => {
    const nodeType = getNodeType("action.push_branch");

    expect(nodeType).toBeDefined();
    expect(nodeType.schema.properties.mergeBaseBeforePush).toBeDefined();
    expect(nodeType.schema.properties.mergeBaseBeforePush.default).toBe(false);
    expect(nodeType.schema.properties.autoResolveMergeConflicts).toBeDefined();
    expect(nodeType.schema.properties.conflictResolverSdk).toBeDefined();
    expect(nodeType.schema.properties.skipHooks).toBeDefined();
    expect(nodeType.schema.properties.requireApproval).toBeDefined();
    expect(nodeType.schema.properties.approvalTimeoutMs).toBeDefined();
  });

  it("waits for operator approval before creating a PR in the modular registry when risky approvals are enabled", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-modular-pr-approval-"));
    const previousSetting = process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED;
    process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED = "true";
    try {
      const nodeType = getNodeType("action.create_pr");
      const ctx = {
        id: "modular-run-1",
        data: {
          repoRoot,
          _dagState: { runId: "modular-run-1", workflowId: "wf-modular" },
          _workflowId: "wf-modular",
          _workflowName: "Modular Approval Workflow",
        },
        resolve(value) {
          return value;
        },
        log: vi.fn(),
      };
      const engine = {
        _checkpointRun: vi.fn(() => {
          const requestId = Object.keys(ctx.data._pendingApprovalRequests || {})[0];
          if (requestId) {
            resolveApprovalRequest(requestId, {
              repoRoot,
              decision: "approved",
              actorId: "modular-tester",
            });
          }
        }),
      };
      const node = {
        id: "modular-pr-node",
        type: "action.create_pr",
        config: {
          title: "Modular approval gated PR",
          branch: "feat/modular-approval",
          cwd: "C:/__bosun_nonexistent__/modular-pr-test",
        },
      };

      const result = await nodeType.execute(node, ctx, engine);
      const request = getApprovalRequest("workflow-action", "modular-run-1:modular-pr-node", { repoRoot });

      expect(engine._checkpointRun).toHaveBeenCalled();
      expect(request?.status).toBe("approved");
      expect(request?.action?.label).toBe("Create pull request");
      expect(result.success).toBe(true);
      expect(result.handedOff).toBe(true);
      expect(ctx.data._pendingApprovalRequests).toEqual({});
    } finally {
      if (previousSetting === undefined) delete process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED;
      else process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED = previousSetting;
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
        // Windows can briefly retain handles on the approval queue file after the assertion path.
      }
    }
  });

  it("propagates blocked delegated workflow outcomes into the task session", async () => {
    const nodeType = getNodeType("action.run_agent");
    const node = {
      id: "run-agent",
      type: "action.run_agent",
      config: {
        prompt: "Implement the requested change end-to-end.",
        failOnError: false,
      },
    };
    const ctx = {
      id: "run-1",
      data: {
        taskId: "TASK-123",
        task: {
          id: "TASK-123",
          title: "Fix push blockage",
          description: "Resolve the pre-push blockage and preserve implementation state.",
          taskUrl: "https://example.test/tasks/TASK-123",
        },
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const engine = {
      services: {},
      list: () => [
        {
          id: "delegate-workflow",
          name: "Delegate Workflow",
          enabled: true,
          metadata: { replaces: { module: "primary-agent.mjs" } },
          nodes: [{ id: "trigger", type: "trigger.task_assigned", config: {} }],
        },
      ],
      execute: vi.fn().mockResolvedValue({
        id: "child-run",
        errors: [],
        data: {
          _workflowTerminalStatus: "completed",
          _workflowTerminalOutput: {
            blockedReason: "blocked_by_repo",
            implementationState: "implementation_done_commit_blocked",
            error: "pre-push hook declined",
          },
        },
      }),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const session = getSessionTracker().getSessionById("TASK-123");

    expect(engine.execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: false,
      delegated: true,
      subStatus: "implementation_done_commit_blocked",
      blockedReason: "blocked_by_repo",
      implementationState: "implementation_done_commit_blocked",
    });
    expect(session?.status).toBe("implementation_done_commit_blocked");
  });

  it("passes managed harness session lineage into agent-pool workflow runs", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const launchOrResumeThread = vi.fn().mockResolvedValue({
      success: true,
      output: "workflow agent completed",
      items: [],
      sdk: "codex",
      threadId: "workflow-thread-1",
      resumed: false,
    });
    const node = {
      id: "run-agent",
      type: "action.run_agent",
      config: {
        prompt: "Implement the requested change end-to-end.",
        failOnError: false,
        autoRecover: false,
      },
    };
    const ctx = {
      id: "run-parent-1",
      data: {
        _workflowId: "wf-managed-session",
        _workflowName: "Managed Session Workflow",
        _workflowSessionId: "session-parent-1",
        _workflowRootSessionId: "session-root-1",
        taskId: "TASK-200",
        taskTitle: "Managed session linkage",
        task: {
          id: "TASK-200",
          title: "Managed session linkage",
        },
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
      setNodeStatus: vi.fn(),
    };
    const engine = {
      services: {
        sessionManager,
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "fallback should not be used",
            items: [],
            sdk: "codex",
            threadId: "workflow-thread-fallback",
          }),
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.success).toBe(true);
    expect(launchOrResumeThread).toHaveBeenCalledOnce();
    expect(launchOrResumeThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        sessionId: "TASK-200:agent:run-parent-1:run-agent:turn",
        sessionScope: "workflow-task",
        parentSessionId: "session-parent-1",
        rootSessionId: "session-root-1",
        metadata: expect.objectContaining({
          source: "workflow-run-agent",
          workflowRunId: "run-parent-1",
          workflowId: "wf-managed-session",
          workflowName: "Managed Session Workflow",
          workflowNodeId: "run-agent",
          taskId: "TASK-200",
          taskTitle: "Managed session linkage",
        }),
      }),
    );
    expect(sessionManager.getSession("TASK-200:agent:run-parent-1:run-agent:turn")).toMatchObject({
      sessionId: "TASK-200:agent:run-parent-1:run-agent:turn",
      parentSessionId: "session-parent-1",
      rootSessionId: "session-root-1",
      status: "completed",
      sessionType: "workflow-agent",
    });
  });

  it("inherits resolved executor settings for workflow agent launches when sdk is auto", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const launchOrResumeThread = vi.fn().mockResolvedValue({
      success: true,
      output: "workflow agent completed",
      items: [],
      sdk: "codex",
      threadId: "workflow-thread-2",
      resumed: false,
    });
    const node = {
      id: "run-agent",
      type: "action.run_agent",
      config: {
        prompt: "Plan the task.",
        sdk: "auto",
        failOnError: false,
        autoRecover: false,
      },
    };
    const ctx = {
      id: "run-parent-2",
      data: {
        _workflowId: "wf-resolved-executor",
        _workflowName: "Resolved Executor Workflow",
        taskId: "TASK-201",
        taskTitle: "Resolved executor inheritance",
        resolvedSdk: "codex",
        resolvedModel: "gpt-5.4",
        task: {
          id: "TASK-201",
          title: "Resolved executor inheritance",
        },
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
      setNodeStatus: vi.fn(),
    };
    const engine = {
      services: {
        sessionManager,
        agentPool: {
          launchEphemeralThread: vi.fn().mockResolvedValue({
            success: true,
            output: "fallback should not be used",
            items: [],
            sdk: "codex",
            threadId: "workflow-thread-fallback-2",
          }),
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.success).toBe(true);
    expect(launchOrResumeThread).toHaveBeenCalledOnce();
    expect(launchOrResumeThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        sdk: "codex",
        model: "gpt-5.4",
      }),
    );
  });

  it("routes child workflow execution through the shared session manager lineage graph", async () => {
    const nodeType = getNodeType("action.execute_workflow");
    const sessionManager = createHarnessSessionManager();
    const node = {
      id: "dispatch-child",
      type: "action.execute_workflow",
      config: {
        workflowId: "child-wf",
        mode: "sync",
        outputVariable: "childSummary",
      },
    };
    const ctx = {
      id: "run-parent-2",
      data: {
        _workflowId: "parent-wf",
        _workflowName: "Parent Workflow",
        _workflowSessionId: "session-parent-2",
        _workflowRootSessionId: "session-root-2",
        taskId: "TASK-201",
        taskTitle: "Spawn child workflow",
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const childCtx = {
      id: "child-run-1",
      errors: [],
      data: {
        _workflowTerminalOutput: { summary: "child complete" },
      },
    };
    const engine = {
      services: { sessionManager },
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "child-wf" }),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const childSessionId = "TASK-201:subagent:run-parent-2:dispatch-child:child-wf";

    expect(result).toMatchObject({
      success: true,
      queued: false,
      mode: "sync",
      workflowId: "child-wf",
      childSessionId,
      parentSessionId: "session-parent-2",
      rootSessionId: "session-root-2",
      runId: "child-run-1",
    });
    expect(ctx.data.childSummary).toEqual(result);
    expect(sessionManager.getSession(childSessionId)).toMatchObject({
      sessionId: childSessionId,
      parentSessionId: "session-parent-2",
      rootSessionId: "session-root-2",
      status: "completed",
      sessionType: "workflow-subagent",
    });
    expect(sessionManager.getLineageView(childSessionId)).toMatchObject({
      session: expect.objectContaining({
        sessionId: childSessionId,
        parentSessionId: "session-parent-2",
        rootSessionId: "session-root-2",
      }),
      rootSession: expect.objectContaining({
        sessionId: "session-root-2",
      }),
    });
  });

  it("routes workflow bosun_tool through the centralized tool orchestrator approval path", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-bosun-tool-approval-"));
    const nodeType = getNodeType("action.bosun_tool");
    const toolsMod = await import("../agent/agent-custom-tools.mjs");
    vi.spyOn(toolsMod, "getCustomTool").mockReturnValue({
      id: "demo-tool",
      entry: {
        title: "Demo Tool",
        category: "test",
        requiresApproval: true,
      },
    });
    vi.spyOn(toolsMod, "listCustomTools").mockReturnValue([{ id: "demo-tool" }]);
    vi.spyOn(toolsMod, "invokeCustomTool").mockResolvedValue({
      exitCode: 0,
      stdout: "{\"ok\":true}",
      stderr: "",
    });

    const ctx = {
      id: "run-tool-1",
      data: {
        repoRoot,
        _workflowId: "wf-tool",
        _workflowName: "Tool Workflow",
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const node = {
      id: "tool-node",
      type: "action.bosun_tool",
      config: {
        toolId: "demo-tool",
        requireApproval: true,
        approvalTimeoutMs: 1000,
      },
    };

    const result = await nodeType.execute(node, ctx, {});
    const approvalRequest = getApprovalRequestById(result.approvalRequestId, { repoRoot });

    expect(result.success).toBe(false);
    expect(result.approvalRequestId).toBeTruthy();
    expect(result.approvalState).toBe("pending");
    expect(approvalRequest).toMatchObject({
      status: "pending",
      scopeType: "workflow-action",
    });
    expect(toolsMod.invokeCustomTool).not.toHaveBeenCalled();
  });
});
