import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import "../workflow/workflow-nodes/triggers.mjs";
import {
  buildRunAgentShellFallbackInvocation,
  parseRunAgentShellFallbackOutput,
} from "../workflow/workflow-nodes/actions.mjs";
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

  it("builds run_agent fallback launches without Windows URL pathname cwd corruption", () => {
    const invocation = buildRunAgentShellFallbackInvocation("prompt", "C:\\repo", 12345);

    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args.slice(0, 3)).toEqual([
      "--input-type=module",
      "-e",
      expect.stringContaining("launchEphemeralThread"),
    ]);
    expect(invocation.args.slice(-3)).toEqual(["prompt", "C:\\repo", "12345"]);
    expect(invocation.cwd).toContain(join("workflow", "workflow-nodes"));
    expect(invocation.cwd).not.toMatch(/[A-Za-z]:\\[A-Za-z]:\\/);
    expect(invocation.maxBuffer).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("parses run_agent fallback JSON from the tail of verbose agent logs", () => {
    const parsed = parseRunAgentShellFallbackOutput([
      "[agent-pool] primary SDK missing prerequisites; trying fallback chain",
      "{\"event\":\"not the final result\"}",
      "{\"success\":true,\"output\":\"agent completed\",\"threadId\":\"thread-1\"}",
    ].join("\n"));

    expect(parsed).toEqual({
      success: true,
      output: "agent completed",
      threadId: "thread-1",
    });
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

  it("treats structured tool-session blocks as failed agent runs", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const launchOrResumeThread = vi.fn().mockResolvedValue({
      success: true,
      output: "Still blocked in this same poisoned tool session.\n\nResult:\n- blocked: tool-session failure",
      items: [],
      sdk: "openai-native",
      threadId: "workflow-thread-tool-session",
      resumed: false,
    });
    const node = {
      id: "run-agent-tests",
      type: "action.run_agent",
      config: {
        prompt: "Write tests for the requested change.",
        failOnError: false,
        autoRecover: false,
      },
    };
    const ctx = {
      id: "run-parent-poisoned",
      data: {
        _workflowId: "template-task-lifecycle",
        _workflowName: "Task Lifecycle",
        _workflowSessionId: "session-parent-poisoned",
        _workflowRootSessionId: "session-root-poisoned",
        taskId: "TASK-TOOL-SESSION-1",
        taskTitle: "Surface poisoned tool sessions as blocked",
        task: {
          id: "TASK-TOOL-SESSION-1",
          title: "Surface poisoned tool sessions as blocked",
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
            sdk: "openai-native",
            threadId: "workflow-thread-fallback-tool-session",
          }),
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const tracker = getSessionTracker();

    expect(result).toMatchObject({
      success: false,
      blockedReason: "blocked_by_env",
      error: expect.stringContaining("tool-session failure"),
      output: expect.stringContaining("Still blocked in this same poisoned tool session"),
    });
    expect(tracker.getSessionById("TASK-TOOL-SESSION-1")?.status).toBe("blocked_by_env");
    expect(tracker.getSessionById("TASK-TOOL-SESSION-1:agent:run-parent-poisoned:run-agent-tests:turn")?.status).toBe("blocked_by_env");
  });

  it("treats doom-loop tool invocation blocks as failed agent runs", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const launchOrResumeThread = vi.fn().mockResolvedValue({
      success: true,
      output: "Blocked: tool invocation failure.\n\nThis session is permanently stuck behind doom-loop protection because repeated tool calls were made with empty arguments. I cannot inspect or modify files from this turn.",
      items: [],
      sdk: "openai-native",
      threadId: "workflow-thread-doom-loop",
      resumed: false,
    });
    const node = {
      id: "run-agent-tests",
      type: "action.run_agent",
      config: {
        prompt: "Write tests for the requested change.",
        failOnError: false,
        autoRecover: false,
      },
    };
    const ctx = {
      id: "run-parent-doom-loop",
      data: {
        _workflowId: "template-task-lifecycle",
        _workflowName: "Task Lifecycle",
        _workflowSessionId: "session-parent-doom-loop",
        _workflowRootSessionId: "session-root-doom-loop",
        taskId: "TASK-TOOL-SESSION-2",
        taskTitle: "Surface doom-loop blocks as blocked",
        task: {
          id: "TASK-TOOL-SESSION-2",
          title: "Surface doom-loop blocks as blocked",
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
            sdk: "openai-native",
            threadId: "workflow-thread-fallback-doom-loop",
          }),
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const tracker = getSessionTracker();

    expect(result).toMatchObject({
      success: false,
      blockedReason: "blocked_by_env",
      error: expect.stringContaining("tool invocation failure"),
      output: expect.stringContaining("doom-loop protection"),
    });
    expect(tracker.getSessionById("TASK-TOOL-SESSION-2")?.status).toBe("blocked_by_env");
    expect(tracker.getSessionById("TASK-TOOL-SESSION-2:agent:run-parent-doom-loop:run-agent-tests:turn")?.status).toBe("blocked_by_env");
  });

  it("marks workflow agent sessions no_output when only workflow heartbeats occur", async () => {
    vi.useFakeTimers();
    try {
      const nodeType = getNodeType("action.run_agent");
      const sessionManager = createHarnessSessionManager();
      let resolveLaunch = null;
      const launchOrResumeThread = vi.fn().mockImplementation(() => new Promise((resolve) => {
        resolveLaunch = resolve;
      }));
      const node = {
        id: "run-agent",
        type: "action.run_agent",
        config: {
          prompt: "Run a long silent validation step.",
          failOnError: false,
          autoRecover: false,
        },
      };
      const ctx = {
        id: "run-parent-heartbeat",
        data: {
          _workflowId: "wf-heartbeat",
          _workflowName: "Heartbeat Workflow",
          _workflowSessionId: "session-parent-heartbeat",
          _workflowRootSessionId: "session-root-heartbeat",
          taskId: "TASK-HEARTBEAT-1",
          taskTitle: "Keep session alive while agent is quiet",
          task: {
            id: "TASK-HEARTBEAT-1",
            title: "Keep session alive while agent is quiet",
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
              threadId: "workflow-thread-fallback-heartbeat",
            }),
            launchOrResumeThread,
          },
        },
        list: () => [],
        execute: vi.fn(),
      };

      const executionPromise = nodeType.execute(node, ctx, engine);

      await vi.advanceTimersByTimeAsync(181_000);

      const tracker = getSessionTracker();
      const taskSession = tracker.getSessionById("TASK-HEARTBEAT-1");
      const delegateSession = tracker.getSessionById("TASK-HEARTBEAT-1:agent:run-parent-heartbeat:run-agent:turn");

      expect(taskSession?.status).toBe("no_output");
      expect(delegateSession?.status).toBe("no_output");
      expect(Number.isFinite(taskSession?.endedAt)).toBe(true);
      expect(Number.isFinite(delegateSession?.endedAt)).toBe(true);

      const result = await executionPromise;

      expect(result.success).toBe(false);
      expect(String(result.error || "")).toMatch(/first_event_timeout/i);
      expect(launchOrResumeThread).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records raw copilot stream events when formatted stream text is null", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const launchOrResumeThread = vi.fn().mockImplementation(async (_prompt, _cwd, _timeout, options = {}) => {
      await options.onEvent?.(null, {
        type: "assistant.message",
        timestamp: "2026-04-29T12:20:17.660Z",
        data: {
          content: "Tests passed; proceeding to the next step.",
        },
      });
      return {
        success: true,
        output: "workflow agent completed",
        items: [],
        sdk: "copilot",
        threadId: "workflow-thread-copilot-raw-events",
        resumed: false,
      };
    });
    const node = {
      id: "run-agent-tests",
      type: "action.run_agent",
      config: {
        prompt: "Write tests for the requested change.",
        failOnError: false,
        autoRecover: false,
      },
    };
    const ctx = {
      id: "run-parent-copilot-raw",
      data: {
        _workflowId: "wf-copilot-raw-events",
        _workflowName: "Copilot Raw Events Workflow",
        _workflowSessionId: "session-parent-copilot-raw",
        _workflowRootSessionId: "session-root-copilot-raw",
        taskId: "TASK-COPILOT-RAW",
        taskTitle: "Capture raw Copilot stream events",
        task: {
          id: "TASK-COPILOT-RAW",
          title: "Capture raw Copilot stream events",
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
            sdk: "copilot",
            threadId: "workflow-thread-fallback-copilot-raw",
          }),
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const tracker = getSessionTracker();
    const taskSession = tracker.getSessionById("TASK-COPILOT-RAW");
    const delegateSession = tracker.getSessionById("TASK-COPILOT-RAW:agent:run-parent-copilot-raw:run-agent-tests:turn");

    expect(result.success).toBe(true);
    expect(launchOrResumeThread).toHaveBeenCalledOnce();
    expect(launchOrResumeThread.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        sendRawEvents: true,
      }),
    );
    expect(taskSession?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_message",
          content: "Tests passed; proceeding to the next step.",
        }),
      ]),
    );
    expect(delegateSession?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_message",
          content: "Tests passed; proceeding to the next step.",
        }),
      ]),
    );
  });

  it("returns a structured failure result when stale-session recovery still throws", async () => {
    const nodeType = getNodeType("action.run_agent");
    const sessionManager = createHarnessSessionManager();
    const invalidateThread = vi.fn();
    const launchOrResumeThread = vi.fn()
      .mockRejectedValueOnce(new Error("Cannot read properties of null (reading 'sessionId')"))
      .mockRejectedValueOnce(new Error("Cannot read properties of null (reading 'sessionId')"));
    const node = {
      id: "run-agent-plan",
      type: "action.run_agent",
      config: {
        prompt: "Implement the requested change end-to-end.",
        failOnError: false,
      },
    };
    const ctx = {
      id: "retry-run-1",
      data: {
        _workflowId: "template-task-lifecycle",
        _workflowName: "Task Lifecycle",
        _workflowSessionId: "session-parent-1",
        _workflowRootSessionId: "session-root-1",
        taskId: "TASK-STALE-FAIL-1",
        taskTitle: "Recover stale session gracefully",
        task: {
          id: "TASK-STALE-FAIL-1",
          title: "Recover stale session gracefully",
          description: "Ensure stale session crashes do not hard-stop the workflow.",
          taskUrl: "https://example.test/tasks/TASK-STALE-FAIL-1",
          branchName: "feat/recover-stale-session-gracefully",
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
          invalidateThread,
          launchOrResumeThread,
        },
      },
      list: () => [],
      execute: vi.fn(),
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result).toMatchObject({
      success: false,
      error: "Cannot read properties of null (reading 'sessionId')",
    });
    expect(launchOrResumeThread).toHaveBeenCalledTimes(2);
    expect(invalidateThread).toHaveBeenCalledWith(
      "template-task-lifecycle:retry-run-1:run-agent-plan",
    );
  });

  it("clears blockedReason when returning a task to inprogress", async () => {
    const nodeType = getNodeType("action.update_task_status");
    const updateTaskStatus = vi.fn().mockResolvedValue({ success: true });
    const updateTask = vi.fn().mockResolvedValue({ success: true });
    const getTask = vi.fn().mockResolvedValue({
      id: "TASK-RESET-1",
      title: "Recover blocked task",
      blockedReason: "blocked_by_repo",
    });
    const node = {
      id: "set-inprogress",
      type: "action.update_task_status",
      config: {
        taskId: "TASK-RESET-1",
        status: "inprogress",
        taskTitle: "Recover blocked task",
      },
    };
    const ctx = {
      data: {},
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const engine = {
      services: {
        kanban: {
          getTask,
          updateTaskStatus,
          updateTask,
        },
      },
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.success).toBe(true);
    expect(updateTaskStatus).toHaveBeenCalledWith(
      "TASK-RESET-1",
      "inprogress",
      expect.any(Object),
    );
    expect(updateTask).toHaveBeenCalledWith(
      "TASK-RESET-1",
      expect.objectContaining({ blockedReason: null }),
    );
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
        allowedTools: ["read_file", "search_files"],
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
    expect(sessionManager.getSubagentControl().getSubagent(childSessionId)).toMatchObject({
      childSessionId,
      status: "completed",
      contract: expect.objectContaining({
        freshConversation: true,
        toolPolicy: expect.objectContaining({
          allowedTools: ["read_file", "search_files"],
          deniedTools: expect.arrayContaining(["spawn_subagent", "wait_subagent"]),
          allowNestedDelegation: false,
        }),
        memoryPolicy: expect.objectContaining({
          mode: "read_only",
        }),
        reportingPolicy: expect.objectContaining({
          mode: "one_way_progress",
        }),
        escalationPolicy: expect.objectContaining({
          mode: "wait_for_response",
          waitForResponse: true,
        }),
      }),
      latestProgress: expect.objectContaining({
        status: "completed",
      }),
    });
  });

  it("surfaces explicit wait_for_response child escalations as waiting subagent state", async () => {
    const nodeType = getNodeType("action.execute_workflow");
    const sessionManager = createHarnessSessionManager();
    const node = {
      id: "dispatch-child-waiting",
      type: "action.execute_workflow",
      config: {
        workflowId: "child-wf",
        mode: "sync",
        outputVariable: "childSummary",
      },
    };
    const ctx = {
      id: "run-parent-3",
      data: {
        _workflowId: "parent-wf",
        _workflowName: "Parent Workflow",
        _workflowSessionId: "session-parent-3",
        _workflowRootSessionId: "session-root-3",
        taskId: "TASK-202",
        taskTitle: "Wait on child workflow",
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const childCtx = {
      id: "child-run-waiting",
      errors: [],
      data: {
        _waitForResponse: true,
        _waitForResponseMessage: "Need operator confirmation before continuing",
        _workflowTerminalOutput: {
          needsApproval: true,
          escalation: {
            type: "wait_for_response",
            waitForResponse: true,
            message: "Need operator confirmation before continuing",
          },
        },
      },
    };
    const engine = {
      services: { sessionManager },
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "child-wf" }),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const childSessionId = "TASK-202:subagent:run-parent-3:dispatch-child-waiting:child-wf";
    const record = sessionManager.getSubagentControl().getSubagent(childSessionId);

    expect(result).toMatchObject({
      success: true,
      status: "waiting",
      waitForResponse: true,
      childSessionId,
      escalation: expect.objectContaining({
        type: "wait_for_response",
        waitForResponse: true,
        message: "Need operator confirmation before continuing",
      }),
    });
    expect(ctx.data.childSummary).toEqual(result);
    expect(record).toMatchObject({
      childSessionId,
      status: "waiting",
      escalation: expect.objectContaining({
        type: "wait_for_response",
        waitForResponse: true,
      }),
      latestProgress: expect.objectContaining({
        status: "waiting",
      }),
    });
  });

  it("binds isolated browser-worker context and multimodal fallback metadata onto workflow subagents", async () => {
    const nodeType = getNodeType("action.execute_workflow");
    const sessionManager = createHarnessSessionManager();
    const node = {
      id: "dispatch-child-browser",
      type: "action.execute_workflow",
      config: {
        workflowId: "browser-child-wf",
        mode: "sync",
        outputVariable: "childSummary",
        browserIsolation: true,
        browserCapabilities: ["playwright.navigate", "playwright.screenshot"],
        allowedTools: ["playwright.navigate", "playwright.screenshot", "vision-analysis"],
      },
    };
    const ctx = {
      id: "run-parent-browser",
      data: {
        _workflowId: "parent-wf",
        _workflowName: "Parent Workflow",
        _workflowSessionId: "session-parent-browser",
        _workflowRootSessionId: "session-root-browser",
        taskId: "TASK-203",
        taskTitle: "Validate browser child workflow",
      },
      resolve(value) {
        return value;
      },
      log: vi.fn(),
    };
    const childCtx = {
      id: "child-run-browser",
      errors: [],
      data: {
        _workflowTerminalOutput: { summary: "browser child complete" },
      },
    };
    const engine = {
      services: { sessionManager },
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "browser-child-wf" }),
    };

    const result = await nodeType.execute(node, ctx, engine);
    const childSessionId = "TASK-203:subagent:run-parent-browser:dispatch-child-browser:browser-child-wf";
    const record = sessionManager.getSubagentControl().getSubagent(childSessionId);

    expect(result).toMatchObject({
      success: true,
      childSessionId,
      browserWorker: expect.objectContaining({
        sessionId: childSessionId,
        profileScope: "isolated-subagent",
        requestedCapabilities: ["playwright.navigate", "playwright.screenshot", "vision-analysis"],
      }),
      multimodalFallback: expect.objectContaining({
        fallback: expect.objectContaining({
          enabled: true,
          mode: "vision_summary_to_text",
        }),
      }),
    });
    expect(record).toMatchObject({
      metadata: expect.objectContaining({
        browserWorker: expect.objectContaining({
          sessionId: childSessionId,
        }),
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
