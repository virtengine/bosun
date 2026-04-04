import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderRegistry,
  listRegisteredProviders,
  resolveProviderSelection,
} from "../agent/provider-registry.mjs";
import { getProviderCapabilities } from "../agent/provider-capabilities.mjs";
import {
  buildToolCapabilityContract,
  createToolCapabilityManifest,
  createToolOrchestrator,
} from "../agent/tool-orchestrator.mjs";
import { createToolRunner } from "../agent/harness/tool-runner.mjs";
import {
  createCompiledHarnessSession,
  createBosunSessionManager,
  createHarnessSessionManager,
} from "../agent/session-manager.mjs";
import {
  createHarnessFailoverController,
  createHarnessProviderSessionRuntime,
  planPersistentThreadExecution,
} from "../agent/internal-harness-control-plane.mjs";
import {
  buildProviderKernelSettings,
  createProviderKernel,
} from "../agent/provider-kernel.mjs";
import { createQueryEngine } from "../agent/query-engine.mjs";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";

describe("provider registry foundation", () => {
  const adapters = {
    "codex-sdk": {
      name: "codex-sdk",
      displayName: "Codex",
      provider: "CODEX",
      sdkCommands: ["/status"],
      steer: () => true,
      listSessions: () => [],
    },
    "claude-sdk": {
      name: "claude-sdk",
      displayName: "Claude",
      provider: "CLAUDE",
      sdkCommands: ["/model"],
      steer: () => true,
    },
  };

  it("lists configured providers with normalized capabilities", () => {
    const providers = listRegisteredProviders({
      adapters,
      env: { OPENAI_API_KEY: "test-key" },
      configExecutors: [
        {
          name: "codex-primary",
          executor: "CODEX",
          enabled: true,
          models: ["gpt-5.4"],
        },
        {
          name: "claude-review",
          executor: "CLAUDE",
          enabled: false,
          models: ["claude-opus-4.1"],
        },
      ],
      readBusy: (adapter) => adapter.provider === "CODEX",
      getAdapterCapabilities: (adapter) => ({
        steering: typeof adapter.steer === "function",
        sessions: typeof adapter.listSessions === "function",
        sdkCommands: adapter.sdkCommands || [],
      }),
    });

    expect(providers).toHaveLength(2);
    expect(providers[0]).toEqual(expect.objectContaining({
      id: "codex-primary",
      providerId: "openai-codex-subscription",
      adapterId: "codex-sdk",
      available: true,
      busy: true,
      models: ["gpt-5.4"],
      defaultModel: "gpt-5.4",
      auth: expect.objectContaining({
        providerId: "openai-codex-subscription",
        authenticated: true,
        canRun: true,
      }),
      capabilities: expect.objectContaining({
        streaming: true,
        steering: true,
        sessions: true,
        subscription: true,
      }),
    }));
    expect(providers[1]).toEqual(expect.objectContaining({
      id: "claude-review",
      providerId: "claude-subscription-shim",
      adapterId: "claude-sdk",
      available: false,
      models: ["claude-opus-4.1"],
    }));
  });

  it("resolves provider selections by adapter alias or configured id", () => {
    const options = {
      adapters,
      configExecutors: [{ name: "codex-primary", executor: "CODEX", enabled: true }],
    };
    expect(resolveProviderSelection("codex", options)).toEqual({
      providerId: "openai-codex-subscription",
      adapterName: "codex-sdk",
      selectionId: "openai-codex-subscription",
      model: "gpt-5.4",
    });
    expect(resolveProviderSelection("codex-primary", options)).toEqual({
      providerId: "openai-codex-subscription",
      adapterName: "codex-sdk",
      selectionId: "codex-primary",
      model: "gpt-5.4",
    });

    const registry = createProviderRegistry(options);
    expect(registry.getCapabilities("claude-sdk")).toEqual(expect.objectContaining({
      streaming: true,
      subscription: true,
    }));
    expect(getProviderCapabilities("opencode-sdk")).toEqual(expect.objectContaining({
      local: true,
      openaiCompatible: true,
    }));
  });

  it("honors provider-kernel enablement and default provider selection", () => {
    const registry = createProviderRegistry({
      adapters,
      includeBuiltins: true,
      env: {},
      settings: {
        BOSUN_PROVIDER_DEFAULT: "openai-compatible",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
      },
    });

    const defaultProvider = registry.getDefaultProvider();
    const openaiCompatible = registry.getProvider("openai-compatible");
    const ollama = registry.getProvider("ollama");

    expect(defaultProvider).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      adapterId: "opencode-sdk",
    }));
    expect(registry.contract).toEqual(expect.objectContaining({
      listProviders: true,
      listEnabledProviders: true,
      getInventory: true,
      resolveProviderRuntime: true,
      discoverRuntimeCatalog: true,
    }));
    expect(openaiCompatible).toEqual(expect.objectContaining({
      enabled: true,
      available: true,
    }));
    expect(ollama).toEqual(expect.objectContaining({
      enabled: false,
      available: false,
    }));
    expect(registry.listEnabledProviders()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: "openai-compatible",
      }),
    ]));
    expect(registry.getInventory()).toEqual(expect.objectContaining({
      defaultProvider: expect.objectContaining({
        providerId: "openai-compatible",
      }),
    }));
  });
});

describe("tool orchestrator foundation", () => {
  it("builds a stable capability contract and emits structured execution events", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "list_sessions",
          handler: async () => ({ ok: true }),
          networkAccess: "allow",
        }],
      }],
      executeTool: vi.fn(async (toolName, args) => ({
        ok: true,
        toolName,
        args,
      })),
    });

    const manifest = createToolCapabilityManifest({ cwd: process.cwd() });
    const contract = buildToolCapabilityContract({ cwd: process.cwd() });
    const result = await orchestrator.execute("list_sessions", { limit: 3 }, {
      sessionId: "session-1",
      agentProfileId: "voice-agent",
    });

    expect(manifest.toolBridge.function).toContain("executeToolCall");
    expect(contract).toContain("## Tool Capability Contract");
    expect(result).toEqual({
      ok: true,
      toolName: "list_sessions",
      args: { limit: 3 },
    });
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
  });

  it("blocks approval-gated tools before execution and emits an approval request event", async () => {
    const events = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "push_branch",
          requiresApproval: true,
        }],
      }],
      executeTool,
    });

    await expect(orchestrator.execute("push_branch", { branch: "feature/test" }, {
      sessionId: "session-approval",
      approval: { mode: "manual" },
    })).rejects.toThrow(/requires operator approval/i);

    expect(executeTool).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "approval_requested",
        toolName: "push_branch",
        approval: expect.objectContaining({
          blocked: true,
          approvalState: "pending",
          approvalRequired: true,
        }),
      }),
    ]);
  });

  it("blocks disallowed network access before execution and emits an execution error event", async () => {
    const events = [];
    const executeTool = vi.fn(async () => ({ ok: true }));
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "fetch_remote_context",
          networkAccess: "restricted",
          allowedHosts: ["api.openai.com"],
        }],
      }],
      executeTool,
    });

    await expect(orchestrator.execute("fetch_remote_context", {}, {
      sessionId: "session-network",
      requestedHosts: ["169.254.169.254"],
    })).rejects.toThrow(/blocked by policy|not allowlisted/i);

    expect(executeTool).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_execution_error",
        toolName: "fetch_remote_context",
        error: expect.stringMatching(/blocked by policy|not allowlisted/i),
      }),
    ]);
  });

  it("emits truncated end-event payloads but returns the full tool result", async () => {
    const events = [];
    const longOutput = { lines: Array.from({ length: 20 }, (_, index) => `line-${index}-${"x".repeat(24)}`) };
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{
          id: "collect_logs",
          networkAccess: "allow",
        }],
      }],
      truncation: { maxChars: 96, tailChars: 12 },
      executeTool: vi.fn(async () => longOutput),
    });

    const result = await orchestrator.execute("collect_logs", {}, { sessionId: "session-truncation" });

    expect(result).toEqual(longOutput);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events[2]).toEqual(expect.objectContaining({
      type: "tool_execution_end",
      result: expect.objectContaining({
        truncated: true,
        preview: expect.stringContaining("…truncated"),
      }),
    }));
  });

  it("emits execution error events when the tool hook throws", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [{
        source: "test",
        definitions: [{ id: "run_failing_tool", networkAccess: "allow" }],
      }],
      executeTool: vi.fn(async () => {
        throw new Error("tool exploded");
      }),
    });

    await expect(orchestrator.execute("run_failing_tool", {}, {
      sessionId: "session-error",
    })).rejects.toThrow("tool exploded");

    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_error",
    ]);
    expect(events[2]).toEqual(expect.objectContaining({
      toolName: "run_failing_tool",
      error: "tool exploded",
    }));
  });

  it("retries transient tool failures and emits retry telemetry before succeeding", async () => {
    const events = [];
    const executeTool = vi.fn()
      .mockRejectedValueOnce(new Error("transient failure"))
      .mockResolvedValueOnce({ ok: true, recovered: true });
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      retryPolicy: {
        maxAttempts: 2,
      },
      toolSources: [{
        source: "test",
        definitions: [{ id: "retryable_tool", networkAccess: "allow" }],
      }],
      executeTool,
    });

    const result = await orchestrator.execute("retryable_tool", {}, {
      sessionId: "session-retry",
    });

    expect(result).toEqual({ ok: true, recovered: true });
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_retry",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events[2]).toEqual(expect.objectContaining({
      toolName: "retryable_tool",
      attempt: 1,
      nextAttempt: 2,
      error: "transient failure",
    }));
    expect(events[4]).toEqual(expect.objectContaining({
      toolName: "retryable_tool",
      attempt: 2,
      attemptCount: 2,
    }));
  });

  it("emits approval_resolved telemetry when a gated tool is already approved", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      onEvent: (event) => events.push(event),
      toolSources: [ {
        source: "test",
        definitions: [{ id: "push_branch", requiresApproval: true, networkAccess: "allow" }],
      } ],
      executeTool: vi.fn(async () => ({ ok: true })),
    });

    const result = await orchestrator.execute("push_branch", { branch: "feature/test" }, {
      sessionId: "session-approved",
      approval: {
        mode: "manual",
        decision: "approved",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(events.map((event) => event.type)).toEqual([
      "approval_resolved",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events[0]).toEqual(expect.objectContaining({
      type: "approval_resolved",
      toolName: "push_branch",
      decision: "approved",
      status: "approved",
    }));
  });
});

describe("tool runner bridge", () => {
  it("delegates list and run calls through the orchestrator and forwards the event hook", async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const toolOrchestrator = {
      listTools: vi.fn(() => [{ id: "list_tasks" }]),
      executeTool,
    };
    const onEvent = vi.fn();
    const runner = await createToolRunner({
      toolOrchestrator,
      onEvent,
    });

    const tools = runner.listTools();
    const result = await runner.runTool("list_tasks", { limit: 2 }, {
      sessionId: "runner-session",
    });

    expect(tools).toEqual([{ id: "list_tasks" }]);
    expect(result).toEqual({ ok: true });
    expect(toolOrchestrator.listTools).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("list_tasks", { limit: 2 }, {
      sessionId: "runner-session",
      onEvent,
    });
  });

  it("fails fast when the orchestrator execute hook is missing", async () => {
    const runner = await createToolRunner({
      toolOrchestrator: {
        listTools: () => [],
      },
    });

    await expect(runner.runTool("list_tasks", {}, {})).rejects.toThrow(
      "Tool orchestrator is not configured",
    );
  });
});

describe("session manager foundation", () => {
  const compiledProfile = {
    agentId: "harness-foundation",
    taskKey: "task-harness",
    entryStageId: "plan",
    metadata: { stageCount: 2 },
    stages: [
      {
        id: "plan",
        type: "prompt",
        prompt: "Plan the change.",
        transitions: [{ on: "success", to: "done" }],
      },
      {
        id: "done",
        type: "finalize",
        prompt: "Finish.",
      },
    ],
  };

  it("creates compiled sessions that run through the internal harness runtime", async () => {
    const seenTurns = [];
    const session = createCompiledHarnessSession(compiledProfile, {
      runId: "run-1",
      taskKey: "task-harness",
      executeTurn: vi.fn(async ({ stage, mode }) => {
        seenTurns.push({ stageId: stage.id, mode });
        return {
          success: true,
          outcome: "success",
          status: "completed",
          output: `completed ${stage.id}`,
        };
      }),
      steerActiveTurn: vi.fn(() => true),
    });

    const result = await session.run();

    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    expect(seenTurns).toEqual([
      { stageId: "plan", mode: "initial" },
      { stageId: "done", mode: "continue" },
    ]);
    expect(session.canSteer()).toBe(false);
  });

  it("supports compiled and source sessions through the manager facade", async () => {
    const manager = createHarnessSessionManager({
      buildTurnExecutor: () => async ({ stage }) => ({
        success: true,
        outcome: "success",
        status: "completed",
        output: stage.id,
      }),
    });

    const compiledRun = await manager.runCompiledSession(compiledProfile, {
      runId: "run-compiled",
    });
    expect(compiledRun.result.success).toBe(true);

    const sourceRun = await manager.runSession({
      name: "Foundation Harness",
      entryStageId: "plan",
      stages: [
        {
          id: "plan",
          type: "prompt",
          prompt: "Plan.",
          transitions: [{ on: "success", to: "done" }],
        },
        {
          id: "done",
          type: "finalize",
          prompt: "Done.",
        },
      ],
    }, {
      runId: "run-source",
    });
    expect(sourceRun.isValid).toBe(true);
    expect(sourceRun.result.success).toBe(true);
  }, 15000);

  it("tracks Bosun-native sessions, child lineage, and replay snapshots", async () => {
    const trackerMod = await import("../infra/session-tracker.mjs");
    trackerMod._resetSingleton();
    const tracker = trackerMod.getSessionTracker();
    const manager = createBosunSessionManager();

    manager.switchSession("primary-session", {
      scope: "primary",
      sessionType: "primary",
      adapterName: "codex-sdk",
      providerSelection: "codex-sdk",
      taskKey: "primary-session",
      cwd: "C:/repo",
    });
    manager.createChildSession("primary-session", {
      sessionId: "child-session",
      scope: "task",
      sessionType: "task",
      adapterName: "codex",
      providerSelection: "codex",
      taskKey: "child-session",
      cwd: "C:/repo",
    });
    tracker.recordEvent("primary-session", {
      role: "user",
      content: "resume this task",
      timestamp: new Date().toISOString(),
    });

    const sessions = manager.listSessions({ scope: "primary" });
    const replay = manager.getReplaySnapshot("primary-session");

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: "primary-session",
        scope: "primary",
        sessionType: "primary",
      }),
    ]);
    expect(replay).toEqual(expect.objectContaining({
      sessionId: "primary-session",
      taskKey: "primary-session",
      lineage: expect.objectContaining({
        childSessionIds: ["child-session"],
      }),
      messages: [
        expect.objectContaining({
          role: "user",
          content: "resume this task",
        }),
      ],
    }));
  });

  it("applies external continue, retry, resume, cancel, and finalize through canonical lifecycle state", async () => {
    const testCacheDir = mkdtempSync(join(tmpdir(), "bosun-session-manager-"));
    vi.stubEnv("BOSUN_TEST_CACHE_DIR", testCacheDir);
    try {
      const manager = createBosunSessionManager();

      manager.beginExternalSession({
        sessionId: "external-session",
        scope: "workflow-task",
        sessionType: "task",
        taskKey: "external-task",
        cwd: "C:/repo",
        source: "workflow",
      });
      expect(manager.continueSession("external-session")).toEqual(expect.objectContaining({
        sessionId: "external-session",
        status: "running",
      }));
      expect(manager.retrySession("external-session")).toEqual(expect.objectContaining({
        sessionId: "external-session",
        status: "retrying",
      }));
      expect(manager.resumeSession("external-session")).toEqual(expect.objectContaining({
        sessionId: "external-session",
        status: "resuming",
      }));

      manager.registerExecution("external-session", {
        sessionType: "task",
        taskKey: "external-task",
        cwd: "C:/repo",
        status: "running",
        threadId: "external-thread",
        providerSelection: "codex",
        adapterName: "codex",
      });
      const completed = manager.finalizeExternalExecution("external-session", {
        success: true,
        threadId: "external-thread",
        result: { output: "done" },
      });

      expect(completed).toEqual(expect.objectContaining({
        sessionId: "external-session",
        status: "completed",
        activeThreadId: "external-thread",
      }));
      expect(manager.cancelSession("external-session", "operator_stop")).toEqual(
        expect.objectContaining({
          sessionId: "external-session",
          status: "aborted",
          lastError: "operator_stop",
        }),
      );
      expect(manager.getReplayState("external-session")).toEqual(expect.objectContaining({
        sessionId: "external-session",
        resumeFrom: expect.objectContaining({
          threadId: "external-thread",
          action: "session_aborted",
        }),
      }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  it("routes external continue, retry, resume, and cancel through a bound compatibility controller", async () => {
    const testCacheDir = mkdtempSync(join(tmpdir(), "bosun-session-manager-controller-"));
    vi.stubEnv("BOSUN_TEST_CACHE_DIR", testCacheDir);
    try {
      const manager = createBosunSessionManager();
      const run = vi.fn(async (input = {}) => ({
        success: true,
        status: input.lifecycleState || "completed",
        echoedPrompt: input.prompt,
      }));
      const abort = vi.fn();

      manager.beginExternalSession({
        sessionId: "external-controller-session",
        scope: "workflow-task",
        sessionType: "task",
        taskKey: "external-controller-task",
        cwd: "C:/repo",
        source: "workflow",
      });
      manager.bindExternalController("external-controller-session", {
        run,
        abort,
      });

      await expect(manager.continueSession("external-controller-session", {
        action: "continue",
        runRequest: { prompt: "continue this task" },
      })).resolves.toEqual(expect.objectContaining({
        echoedPrompt: "continue this task",
        status: "running",
      }));
      await expect(manager.retrySession("external-controller-session", {
        runRequest: { prompt: "retry this task" },
      })).resolves.toEqual(expect.objectContaining({
        echoedPrompt: "retry this task",
        status: "retrying",
      }));
      await expect(manager.resumeSession("external-controller-session", {
        runRequest: { prompt: "resume this task" },
      })).resolves.toEqual(expect.objectContaining({
        echoedPrompt: "resume this task",
        status: "resuming",
      }));

      manager.cancelSession("external-controller-session", "operator_stop");

      expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        sessionId: "external-controller-session",
        action: "continue",
        lifecycleState: "running",
        prompt: "continue this task",
      }));
      expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        sessionId: "external-controller-session",
        action: "retry",
        lifecycleState: "retrying",
        prompt: "retry this task",
      }));
      expect(run).toHaveBeenNthCalledWith(3, expect.objectContaining({
        sessionId: "external-controller-session",
        action: "resume",
        lifecycleState: "resuming",
        prompt: "resume this task",
      }));
      expect(abort).toHaveBeenCalledWith("operator_stop");
    } finally {
      vi.unstubAllEnvs();
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  it("projects parent-child lineage, thread ancestry, and subagent completion through canonical owners", async () => {
    const testCacheDir = mkdtempSync(join(tmpdir(), "bosun-lineage-graph-"));
    vi.stubEnv("BOSUN_TEST_CACHE_DIR", testCacheDir);
    try {
      const manager = createBosunSessionManager();

      manager.beginExternalSession({
        sessionId: "root-session",
        scope: "workflow-task",
        sessionType: "task",
        taskKey: "root-task",
        cwd: "C:/repo",
        source: "workflow",
      });
      manager.registerExecution("root-session", {
        sessionType: "task",
        taskKey: "root-task",
        cwd: "C:/repo",
        status: "running",
        threadId: "root-thread",
        providerSelection: "codex",
        adapterName: "codex",
      });
      manager.beginExternalSession({
        sessionId: "child-session",
        parentSessionId: "root-session",
        scope: "workflow-task",
        sessionType: "task",
        taskKey: "child-task",
        cwd: "C:/repo",
        source: "workflow",
      });
      manager.registerExecution("child-session", {
        sessionType: "task",
        taskKey: "child-task",
        cwd: "C:/repo",
        status: "running",
        threadId: "child-thread",
        providerSelection: "codex",
        adapterName: "codex",
      });
      manager.finalizeExternalExecution("child-session", {
        success: true,
        threadId: "child-thread",
        result: { output: "child done" },
      });

      const childLineage = manager.getLineageView("child-session");
      const rootLineage = manager.getLineageView("root-session");
      const waited = await manager.waitForSubagent("child-session", { timeoutMs: 25 });

      expect(childLineage.session).toEqual(expect.objectContaining({
        sessionId: "child-session",
        parentSessionId: "root-session",
        rootSessionId: "root-session",
      }));
      expect(childLineage.rootSession || childLineage.root).toEqual(expect.objectContaining({
        sessionId: "root-session",
      }));
      expect(childLineage.parent).toEqual(expect.objectContaining({
        sessionId: "root-session",
      }));
      expect(childLineage.threadLineage).toEqual([
        expect.objectContaining({ threadId: "root-thread" }),
        expect.objectContaining({ threadId: "child-thread" }),
      ]);
      expect(rootLineage.session).toEqual(expect.objectContaining({
        sessionId: "root-session",
      }));
      expect(rootLineage.descendants).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: "child-session",
        }),
      ]));
      expect(rootLineage.subagents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          childSessionId: "child-session",
          status: "completed",
        }),
      ]));
      expect(waited).toEqual(expect.objectContaining({
        childSessionId: "child-session",
        childThreadId: "child-thread",
        status: "completed",
      }));
      expect(manager.getReplaySnapshot("child-session")).toEqual(expect.objectContaining({
        sessionContract: expect.objectContaining({
          sessionId: "child-session",
          rootSessionId: "root-session",
        }),
      }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  it("does not invoke a bound controller run without a continuation prompt", async () => {
    const testCacheDir = mkdtempSync(join(tmpdir(), "bosun-session-manager-no-prompt-"));
    vi.stubEnv("BOSUN_TEST_CACHE_DIR", testCacheDir);
    try {
      const manager = createBosunSessionManager();
      const run = vi.fn(async () => ({ success: true }));

      manager.beginExternalSession({
        sessionId: "external-no-prompt-session",
        scope: "workflow-task",
        sessionType: "task",
        taskKey: "external-no-prompt-task",
        cwd: "C:/repo",
        source: "workflow",
      });
      manager.bindExternalController("external-no-prompt-session", { run });

      expect(manager.continueSession("external-no-prompt-session")).toEqual(
        expect.objectContaining({
          sessionId: "external-no-prompt-session",
          status: "running",
        }),
      );
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  it("applies a canonical subagent pool when child harness sessions run concurrently", async () => {
    const testCacheDir = mkdtempSync(join(tmpdir(), "bosun-subagent-pool-session-"));
    vi.stubEnv("BOSUN_TEST_CACHE_DIR", testCacheDir);
    const executionOrder = [];
    try {
      const manager = createHarnessSessionManager({
        subagentMaxParallel: 1,
        executeTurn: async ({ taskKey }) => {
          executionOrder.push(`start:${taskKey}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
          executionOrder.push(`end:${taskKey}`);
          return {
            success: true,
            status: "completed",
            outcome: "success",
            output: taskKey,
          };
        },
      });

      manager.beginExternalSession({
        sessionId: "root-session",
        sessionType: "task",
        taskKey: "root-task",
      });

      const first = manager.spawnSubagent({
        name: "Subagent A",
        taskKey: "subagent-a",
        entryStageId: "task",
        stages: [{ id: "task", type: "prompt", prompt: "Run A." }],
      }, {
        parentSessionId: "root-session",
      });
      const second = manager.spawnSubagent({
        name: "Subagent B",
        taskKey: "subagent-b",
        entryStageId: "task",
        stages: [{ id: "task", type: "prompt", prompt: "Run B." }],
      }, {
        parentSessionId: "root-session",
      });

      const [firstResult, secondResult] = await Promise.all([
        first.run(),
        second.run(),
      ]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(executionOrder).toEqual([
        "start:subagent-a",
        "end:subagent-a",
        "start:subagent-b",
        "end:subagent-b",
      ]);
      expect(manager.getSubagentPool().getPool("root-session")).toEqual(expect.objectContaining({
        activeCount: 0,
        queueDepth: 0,
      }));
      expect(manager.getReplayState(second.sessionId)).toEqual(expect.objectContaining({
        latestSnapshot: expect.objectContaining({
          action: expect.stringMatching(/subagent_slot_(queued|acquired|released)|session_completed/),
        }),
      }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });
});

describe("harness control-plane foundation", () => {
  it("routes failover execution through the canonical harness failover controller", async () => {
    const queryEngine = {
      policy: { recoveryRetryAttempts: 2 },
      clearAdapterFailureState: vi.fn(),
      noteAdapterFailure: vi.fn(() => ({ allowFailover: true })),
      executeTurn: vi.fn(async (request) => ({
        ok: true,
        adapterName: request.initialAdapterName,
        result: { success: true, output: "done" },
      })),
    };
    const controller = createHarnessFailoverController({ queryEngine });
    const result = await controller.executeTurn({
      adapters: { "codex-sdk": { name: "codex-sdk" } },
      initialAdapterName: "codex-sdk",
      executeAdapterTurn: async () => ({ success: true }),
    });

    expect(controller.policy).toEqual({ recoveryRetryAttempts: 2 });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      adapterName: "codex-sdk",
    }));
    expect(queryEngine.executeTurn).toHaveBeenCalledTimes(1);
  });

  it("plans persistent thread execution through the canonical control-plane policy", () => {
    expect(planPersistentThreadExecution({
      taskKey: "monitor-monitor",
      requestedSdk: "codex",
      existingRecord: {
        sdk: "codex",
        threadId: "thread-1",
        turnCount: 78,
        createdAt: Date.now(),
        alive: true,
      },
      maxThreadTurns: 80,
      warningThreshold: 64,
      absoluteAgeMs: 60_000,
      monitorTaskKey: "monitor-monitor",
      monitorRefreshTurnsRemaining: 2,
    })).toEqual(expect.objectContaining({
      action: "launch_fresh",
      reason: "monitor_refresh_threshold",
      invalidateRecord: true,
      markRecordDead: true,
    }));

    expect(planPersistentThreadExecution({
      taskKey: "task-1",
      requestedSdk: "claude",
      existingRecord: {
        sdk: "claude",
        threadId: "thread-2",
        turnCount: 12,
        createdAt: Date.now(),
        alive: true,
      },
      maxThreadTurns: 80,
      warningThreshold: 64,
      absoluteAgeMs: 60_000,
    })).toEqual(expect.objectContaining({
      action: "resume_existing",
      strategy: "resume_claude",
      reason: "resume_existing",
    }));

    expect(planPersistentThreadExecution({
      taskKey: "task-2",
      requestedSdk: "copilot",
      existingRecord: {
        sdk: "codex",
        threadId: "thread-3",
        turnCount: 2,
        createdAt: Date.now(),
        alive: true,
      },
      maxThreadTurns: 80,
      warningThreshold: 64,
      absoluteAgeMs: 60_000,
    })).toEqual(expect.objectContaining({
      action: "launch_fresh",
      reason: "sdk_changed",
      invalidateRecord: true,
      markRecordDead: true,
    }));
  });

  it("routes launch, resume, and recover executors through the canonical provider session runtime interface", async () => {
    const launchCodex = vi.fn(async (...args) => ({ kind: "launch", args }));
    const resumeClaude = vi.fn(async (...args) => ({ kind: "resume", args }));
    const recoverCodex = vi.fn(async (input) => ({ kind: "recover", input }));
    const runtime = createHarnessProviderSessionRuntime({
      launchers: {
        codex: launchCodex,
      },
      resumers: {
        resume_claude: resumeClaude,
      },
      recoverers: {
        "codex-sdk": recoverCodex,
      },
    });

    const launchResult = await runtime.launchSession({
      sdkName: "codex",
      prompt: "launch prompt",
      cwd: "C:/repo",
      timeoutMs: 1000,
      extra: { sessionId: "launch-1" },
    });
    const resumeResult = await runtime.resumeSession({
      strategy: "resume_claude",
      sdkName: "claude",
      threadId: "thread-1",
      prompt: "resume prompt",
      cwd: "C:/repo",
      timeoutMs: 1000,
      extra: { sessionId: "resume-1" },
    });
    const recoverResult = await runtime.recoverSession({
      adapterName: "codex-sdk",
      adapter: { name: "codex-sdk" },
      retry: 1,
      maxRetries: 2,
    });

    expect(launchCodex).toHaveBeenCalledWith(
      "launch prompt",
      "C:/repo",
      1000,
      { sessionId: "launch-1" },
    );
    expect(resumeClaude).toHaveBeenCalledWith(
      "thread-1",
      "resume prompt",
      "C:/repo",
      1000,
      { sessionId: "resume-1" },
      "claude",
    );
    expect(recoverCodex).toHaveBeenCalledWith(expect.objectContaining({
      adapterName: "codex-sdk",
      retry: 1,
      maxRetries: 2,
    }));
    expect(launchResult.kind).toBe("launch");
    expect(resumeResult.kind).toBe("resume");
    expect(recoverResult.kind).toBe("recover");
  });
});

describe("provider kernel foundation", () => {
  it("flattens provider settings and resolves runtime config from the shared kernel", () => {
    const config = {
      providers: {
        defaultProvider: "openai-compatible",
        openaiCompatible: {
          enabled: true,
          defaultModel: "qwen2.5-coder:latest",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    };
    const settings = buildProviderKernelSettings(config);
    const kernel = createProviderKernel({
      adapters: {
        "opencode-sdk": {
          name: "opencode-sdk",
          provider: "OPENCODE",
          exec: async () => ({ finalResponse: "ok" }),
        },
      },
      config,
      env: {},
    });

    expect(settings).toEqual(expect.objectContaining({
      BOSUN_PROVIDER_DEFAULT: "openai-compatible",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: true,
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
    }));

    const runtime = kernel.resolveRuntime("openai-compatible", "opencode-sdk");
    expect(runtime).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      providerConfig: expect.objectContaining({
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    }));
  });

  it("creates adapter-backed provider sessions through the shared kernel", async () => {
    const exec = vi.fn(async (_message, options) => ({
      finalResponse: "kernel-output",
      sessionId: options.sessionId,
      threadId: options.threadId,
      provider: options.provider,
    }));
    const kernel = createProviderKernel({
      adapters: {
        "opencode-sdk": {
          name: "opencode-sdk",
          provider: "OPENCODE",
          exec,
        },
      },
      config: {
        providers: {
          defaultProvider: "openai-compatible",
          openaiCompatible: {
            enabled: true,
            defaultModel: "qwen2.5-coder:latest",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
      },
      env: {},
    });

    const session = kernel.createExecutionSession({
      adapterName: "opencode-sdk",
      selectionId: "openai-compatible",
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
      model: "qwen2.5-coder:latest",
    });
    const result = await session.runTurn("route through kernel", {
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
    });

    expect(exec).toHaveBeenCalledWith(
      "USER: route through kernel",
      expect.objectContaining({
        provider: "openai-compatible",
        providerConfig: expect.objectContaining({
          provider: "openai-compatible",
          model: "qwen2.5-coder:latest",
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      sessionId: "provider-session-1",
      threadId: "provider-thread-1",
      finalResponse: "kernel-output",
    }));
  });

  it("lets explicit provider overrides augment kernel-resolved runtime config", async () => {
    const exec = vi.fn(async (_message, options) => ({
      finalResponse: "override-output",
      sessionId: options.sessionId,
      threadId: options.threadId,
      provider: options.provider,
    }));
    const kernel = createProviderKernel({
      adapters: {
        "opencode-sdk": {
          name: "opencode-sdk",
          provider: "OPENCODE",
          exec,
        },
      },
      config: {
        providers: {
          defaultProvider: "openai-compatible",
          openaiCompatible: {
            enabled: true,
            defaultModel: "qwen2.5-coder:latest",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
      },
      env: {},
    });

    const session = kernel.createExecutionSession({
      adapterName: "opencode-sdk",
      selectionId: "openai-compatible",
      provider: "openrouter",
      providerConfig: {
        apiKey: "test-key",
        baseUrl: "https://openrouter.example/v1",
      },
      sessionId: "provider-session-override",
      threadId: "provider-thread-override",
      model: "moonshotai/kimi-k2",
    });
    await session.runTurn("use overrides", {
      sessionId: "provider-session-override",
      threadId: "provider-thread-override",
      model: "moonshotai/kimi-k2",
    });

    expect(exec).toHaveBeenCalledWith(
      "USER: use overrides",
      expect.objectContaining({
        provider: "openrouter",
        providerConfig: expect.objectContaining({
          baseUrl: "https://openrouter.example/v1",
          apiKey: "test-key",
          model: "moonshotai/kimi-k2",
        }),
      }),
    );
  });
});

describe("harness agent service foundation", () => {
  it("prefers retry-aware task execution when autoRecover is enabled", async () => {
    const execWithRetry = vi.fn(async () => ({ success: true, output: "retry-path" }));
    const service = createHarnessAgentService({
      agentPool: {
        execWithRetry,
        launchOrResumeThread: vi.fn(),
        launchEphemeralThread: vi.fn(),
      },
    });

    const result = await service.runTask("run the task", {
      autoRecover: true,
      taskKey: "task-1",
      cwd: "C:/repo",
      timeoutMs: 1234,
    });

    expect(execWithRetry).toHaveBeenCalledWith("run the task", expect.objectContaining({
      taskKey: "task-1",
      cwd: "C:/repo",
      timeoutMs: 1234,
    }));
    expect(result).toEqual({ success: true, output: "retry-path" });
  });

  it("falls back to resumable launch semantics when retry execution is unavailable", async () => {
    const launchOrResumeThread = vi.fn(async () => ({ success: true, output: "resume-path" }));
    const service = createHarnessAgentService({
      agentPool: {
        launchOrResumeThread,
        launchEphemeralThread: vi.fn(),
      },
    });

    const result = await service.runTask("resume the task", {
      autoRecover: false,
      taskKey: "task-2",
      cwd: "C:/repo",
      timeoutMs: 5678,
      sessionId: "session-2",
    });

    expect(launchOrResumeThread).toHaveBeenCalledWith(
      "resume the task",
      "C:/repo",
      5678,
      expect.objectContaining({
        taskKey: "task-2",
        sessionId: "session-2",
      }),
    );
    expect(result).toEqual({ success: true, output: "resume-path" });
  });

  it("maps workflow env input onto pooled launcher envOverrides", async () => {
    const launchOrResumeThread = vi.fn(async () => ({ success: true, output: "resume-path" }));
    const service = createHarnessAgentService({
      agentPool: {
        launchOrResumeThread,
        launchEphemeralThread: vi.fn(),
      },
    });

    await service.runTask("resume with env", {
      autoRecover: false,
      taskKey: "task-env",
      cwd: "C:/repo",
      timeoutMs: 4321,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "C:/repo/.bosun/worktrees/task-env",
      },
    });

    expect(launchOrResumeThread).toHaveBeenCalledWith(
      "resume with env",
      "C:/repo",
      4321,
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_CONFIG_KEY_0: "safe.directory",
        }),
        envOverrides: expect.objectContaining({
          GIT_CONFIG_KEY_0: "safe.directory",
          GIT_CONFIG_VALUE_0: "C:/repo/.bosun/worktrees/task-env",
        }),
      }),
    );
  });

  it("exposes a canonical facade for surface and worker bridges", async () => {
    const listener = vi.fn();
    const addActiveSessionListener = vi.fn(() => "listener-1");
    const getAvailableSdks = vi.fn(() => ["codex", "claude"]);
    const getActiveThreads = vi.fn(() => [{ id: "thread-1" }]);
    const createCompiledInternalHarnessSession = vi.fn(() => ({ id: "compiled-1" }));
    const setPoolSdk = vi.fn();
    const resetPoolSdkCache = vi.fn();
    const invalidateThread = vi.fn();
    const execPooledPrompt = vi.fn(async () => ({ success: true, output: "pooled" }));
    const service = createHarnessAgentService({
      agentPool: {
        addActiveSessionListener,
        getAvailableSdks,
        getActiveThreads,
        createCompiledInternalHarnessSession,
        setPoolSdk,
        resetPoolSdkCache,
        invalidateThread,
        execPooledPrompt,
        killSession: vi.fn(async () => true),
      },
    });

    expect(service.addActiveSessionListener(listener)).toBe("listener-1");
    expect(service.getAvailableSdks()).toEqual(["codex", "claude"]);
    expect(service.getActiveThreads()).toEqual([{ id: "thread-1" }]);
    expect(service.createCompiledInternalHarnessSession({ profile: "test" })).toEqual({ id: "compiled-1" });
    expect(await service.execPooledPrompt("background prompt", { scope: "test" })).toEqual({
      success: true,
      output: "pooled",
    });

    service.setPoolSdk("claude");
    service.resetPoolSdkCache();
    service.invalidateThread("thread-1");

    expect(addActiveSessionListener).toHaveBeenCalledWith(listener);
    expect(createCompiledInternalHarnessSession).toHaveBeenCalledWith({ profile: "test" });
    expect(execPooledPrompt).toHaveBeenCalledWith("background prompt", { scope: "test" });
    expect(setPoolSdk).toHaveBeenCalledWith("claude");
    expect(resetPoolSdkCache).toHaveBeenCalledTimes(1);
    expect(invalidateThread).toHaveBeenCalledWith("thread-1");
  });

  it("routes default interactive turns through canonical provider-session ownership", async () => {
    const sessionManager = createBosunSessionManager();
    const runTurn = vi.fn(async () => ({
      success: true,
      status: "completed",
      finalResponse: "interactive-ok",
      threadId: "provider-thread-1",
      providerId: "openai-responses",
    }));
    const createExecutionSession = vi.fn(() => ({
      runTurn,
      getState: () => ({
        sessionId: "chat-session",
        threadId: "provider-thread-1",
        model: "gpt-5.4",
      }),
      adapter: null,
    }));
    const service = createHarnessAgentService({
      sessionManager,
      providerKernel: {
        createExecutionSession,
      },
      getPrimaryAgentName: () => "openai-responses",
      getAgentMode: () => "agent",
    });

    const result = await service.runInteractivePrompt("hello from chat", {
      sessionId: "chat-session",
      sessionType: "primary",
      cwd: "C:/repo",
      mode: "agent",
    });

    expect(createExecutionSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "chat-session",
      selectionId: "openai-responses",
      provider: "openai-responses",
      cwd: "C:/repo",
      sessionManager,
    }));
    expect(runTurn).toHaveBeenCalledWith(
      expect.stringContaining("hello from chat"),
      expect.objectContaining({
        sessionId: "chat-session",
        cwd: "C:/repo",
        sessionManager,
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      success: true,
      finalResponse: "interactive-ok",
      threadId: "provider-thread-1",
      adapter: "openai-responses",
    }));
    expect(sessionManager.getSession("chat-session")).toEqual(expect.objectContaining({
      sessionId: "chat-session",
      status: "completed",
      activeThreadId: "provider-thread-1",
    }));
  });

  it("continues canonical interactive sessions through the bound session-manager controller", async () => {
    const sessionManager = createBosunSessionManager();
    const runTurn = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        status: "completed",
        finalResponse: "first-turn",
        threadId: "provider-thread-2",
        providerId: "openai-responses",
      })
      .mockResolvedValueOnce({
        success: true,
        status: "completed",
        finalResponse: "second-turn",
        threadId: "provider-thread-2",
        providerId: "openai-responses",
      });
    const createExecutionSession = vi.fn(() => ({
      runTurn,
      getState: () => ({
        sessionId: "chat-session-2",
        threadId: "provider-thread-2",
        model: "gpt-5.4",
      }),
      adapter: null,
    }));
    const service = createHarnessAgentService({
      sessionManager,
      providerKernel: {
        createExecutionSession,
      },
      getPrimaryAgentName: () => "openai-responses",
      getAgentMode: () => "agent",
    });

    await service.runInteractivePrompt("first turn", {
      sessionId: "chat-session-2",
      sessionType: "primary",
      cwd: "C:/repo",
    });
    const resumed = await service.continueSession("chat-session-2", "continue the thread", {
      cwd: "C:/repo",
    });

    expect(runTurn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("continue the thread"),
      expect.objectContaining({
        sessionId: "chat-session-2",
        cwd: "C:/repo",
        sessionManager,
      }),
    );
    expect(resumed).toEqual(expect.objectContaining({
      success: true,
      finalResponse: "second-turn",
      threadId: "provider-thread-2",
    }));
    expect(sessionManager.getReplayState("chat-session-2")).toEqual(expect.objectContaining({
      sessionId: "chat-session-2",
      resumeFrom: expect.objectContaining({
        threadId: "provider-thread-2",
      }),
    }));
  });

  it("forwards interactive usage metadata through assistant summary events", async () => {
    const sessionManager = createBosunSessionManager();
    const onEvent = vi.fn();
    const runTurn = vi.fn(async () => ({
      success: true,
      status: "completed",
      finalResponse: "current assistant response",
      threadId: "provider-thread-3",
      providerId: "openai-responses",
      usage: {
        inputTokens: 120,
        outputTokens: 24,
        totalTokens: 144,
        cacheInputTokens: 18,
      },
      items: [
        {
          id: "assistant-old",
          role: "assistant",
          type: "agent_message",
          text: "I inspected the repository, compared the last commits, and gathered detailed command evidence. ".repeat(4),
        },
        {
          id: "tool-result-1",
          type: "tool_result",
          output: "git diff --stat\n".repeat(40),
        },
        {
          id: "assistant-middle",
          role: "assistant",
          type: "agent_message",
          text: "Intermediate assistant output after the first tool result.",
        },
        {
          id: "tool-result-2",
          type: "tool_result",
          output: "npm test -- --runInBand\n".repeat(40),
        },
        {
          id: "assistant-current",
          role: "assistant",
          type: "agent_message",
          text: "current assistant response",
        },
      ],
    }));
    const createExecutionSession = vi.fn(() => ({
      runTurn,
      getState: () => ({
        sessionId: "chat-session-3",
        threadId: "provider-thread-3",
        model: "gpt-5.4",
      }),
      adapter: null,
    }));
    const service = createHarnessAgentService({
      sessionManager,
      providerKernel: {
        createExecutionSession,
      },
      getPrimaryAgentName: () => "openai-responses",
      getAgentMode: () => "agent",
    });

    const result = await service.runInteractivePrompt("compress this turn", {
      sessionId: "chat-session-3",
      sessionType: "primary",
      cwd: "C:/repo",
      onEvent,
      forceContextShredding: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      finalResponse: "current assistant response",
    }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      id: "assistant-current",
      role: "assistant",
      content: "current assistant response",
      meta: {
        usage: expect.objectContaining({
          totalTokens: 144,
          cacheInputTokens: 18,
        }),
      },
    }));
  });
});

describe("query engine foundation", () => {
  it("suppresses failover until the configured infrastructure failure threshold is met", async () => {
    const engine = createQueryEngine({
      failoverConsecutiveInfraErrors: 3,
      failoverErrorWindowMs: 60_000,
      recoveryRetryAttempts: 0,
    });
    const adapters = {
      "codex-sdk": { name: "codex-sdk" },
      "copilot-sdk": { name: "copilot-sdk" },
    };
    const executeAdapterTurn = vi.fn(async ({ adapterName }) => {
      if (adapterName === "codex-sdk") {
        throw new Error("AGENT_TIMEOUT: codex did not respond");
      }
      return { finalResponse: "copilot-ok" };
    });

    const first = await engine.executeTurn({
      adapters,
      initialAdapterName: "codex-sdk",
      fallbackOrder: ["codex-sdk", "copilot-sdk"],
      maxFailoverAttempts: 1,
      executeAdapterTurn,
    });
    const second = await engine.executeTurn({
      adapters,
      initialAdapterName: "codex-sdk",
      fallbackOrder: ["codex-sdk", "copilot-sdk"],
      maxFailoverAttempts: 1,
      executeAdapterTurn,
    });
    const third = await engine.executeTurn({
      adapters,
      initialAdapterName: "codex-sdk",
      fallbackOrder: ["codex-sdk", "copilot-sdk"],
      maxFailoverAttempts: 1,
      executeAdapterTurn,
    });

    expect(first).toEqual(expect.objectContaining({
      ok: false,
      suppressed: true,
    }));
    expect(second).toEqual(expect.objectContaining({
      ok: false,
      suppressed: true,
    }));
    expect(third).toEqual(expect.objectContaining({
      ok: true,
      adapterName: "copilot-sdk",
      result: expect.objectContaining({ finalResponse: "copilot-ok" }),
    }));
  });

  it("retries the current adapter via the recovery hook before failing over", async () => {
    const engine = createQueryEngine({
      failoverConsecutiveInfraErrors: 1,
      recoveryRetryAttempts: 1,
    });
    const executeAdapterTurn = vi.fn()
      .mockRejectedValueOnce(new Error("Codex Exec exited with code 3221225786"))
      .mockResolvedValueOnce({ finalResponse: "codex-recovered" });
    const recoverAdapter = vi.fn(async () => {});

    const outcome = await engine.executeTurn({
      adapters: {
        "codex-sdk": { name: "codex-sdk" },
        "copilot-sdk": { name: "copilot-sdk" },
      },
      initialAdapterName: "codex-sdk",
      fallbackOrder: ["codex-sdk", "copilot-sdk"],
      maxFailoverAttempts: 1,
      executeAdapterTurn,
      recoverAdapter,
    });

    expect(outcome).toEqual(expect.objectContaining({
      ok: true,
      adapterName: "codex-sdk",
      recovered: true,
      result: expect.objectContaining({ finalResponse: "codex-recovered" }),
    }));
    expect(recoverAdapter).toHaveBeenCalledTimes(1);
    expect(executeAdapterTurn).toHaveBeenCalledTimes(2);
  });
});
