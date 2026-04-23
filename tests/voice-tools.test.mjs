import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock external boundaries ────────────────────────────────────────────────

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({ primaryAgent: "codex-sdk", voice: {} })),
}));

vi.mock("../agent/primary-agent.mjs", () => {
  let mode = "agent";
  return {
    execPrimaryPrompt: vi.fn(async (msg) => `Agent response to: ${msg}`),
    getPrimaryAgentName: vi.fn(() => "codex-sdk"),
    setPrimaryAgent: vi.fn(),
    getAgentMode: vi.fn(() => mode),
    setAgentMode: vi.fn((next) => { mode = next; }),
  };
});

vi.mock("../kanban/kanban-adapter.mjs", () => ({
  getKanbanAdapter: vi.fn(() => ({
    listProjects: vi.fn(async () => [{ id: "proj-1", name: "Test Project" }]),
    listTasks: vi.fn(async () => [{ id: "1", title: "Test Task", status: "todo" }]),
    getTask: vi.fn(async () => ({
      id: "1",
      title: "Test Task",
      status: "todo",
      body: "desc",
    })),
    createTask: vi.fn(async () => ({ id: "2", title: "New Task" })),
    updateTaskStatus: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => true),
    addComment: vi.fn(async () => true),
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

vi.mock("../agent/agent-pool.mjs", () => ({
  execPooledPrompt: vi.fn(async () => ({
    finalResponse: "pooled agent response",
    items: [],
    usage: null,
  })),
}));

vi.mock("../workflow/workflow-engine.mjs", () => ({
  getWorkflowEngine: vi.fn(() => ({
    save: vi.fn((def) => ({
      ...def,
      id: def?.id || "wf-saved",
      metadata: {
        ...(def?.metadata || {}),
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    })),
    delete: vi.fn(() => true),
    execute: vi.fn(async (workflowId) => ({
      id: `run-exec-${workflowId || "1"}`,
      errors: [],
      startedAt: 1000,
      endedAt: 1200,
      duration: 200,
    })),
    list: vi.fn(() => [{
      id: "wf-1",
      name: "Workflow One",
      enabled: true,
      nodes: [{ id: "n1" }, { id: "n2" }],
      edges: [{ from: "n1", to: "n2" }],
      triggers: [{ type: "manual" }],
    }]),
    get: vi.fn((id) => (id === "wf-1"
      ? {
          id: "wf-1",
          name: "Workflow One",
          enabled: true,
          nodes: [{ id: "n1" }, { id: "n2" }],
          edges: [{ from: "n1", to: "n2" }],
          triggers: [{ type: "manual" }],
        }
      : null)),
    getRunHistory: vi.fn(() => [{
      runId: "run-1",
      workflowId: "wf-1",
      workflowName: "Workflow One",
      status: "failed",
      startedAt: 1000,
      endedAt: 2000,
      duration: 1000,
      errorCount: 1,
      logCount: 2,
      activeNodeCount: 0,
      isStuck: false,
      triggerEvent: "manual",
      triggerSource: "manual",
    }]),
    getRunDetail: vi.fn((runId) => (runId === "run-1"
      ? {
          runId: "run-1",
          workflowId: "wf-1",
          workflowName: "Workflow One",
          status: "failed",
          startedAt: 1000,
          endedAt: 2000,
          duration: 1000,
          errorCount: 1,
          logCount: 2,
          nodeCount: 2,
          completedCount: 1,
          failedCount: 1,
          skippedCount: 0,
          activeNodeCount: 0,
          isStuck: false,
          triggerEvent: "manual",
          triggerSource: "manual",
          detail: {
            data: { _workflowId: "wf-1", _workflowName: "Workflow One" },
            errors: ["node failed"],
            logs: [{ level: "info", msg: "started" }, { level: "error", msg: "failed" }],
            nodeStatuses: { n1: "completed", n2: "failed" },
            nodeStatusEvents: [{ nodeId: "n2", status: "failed" }],
          },
        }
      : (runId === "run-ok"
        ? {
            runId: "run-ok",
            workflowId: "wf-1",
            workflowName: "Workflow One",
            status: "completed",
            startedAt: 1000,
            endedAt: 2000,
            duration: 1000,
            errorCount: 0,
            logCount: 1,
            detail: {
              data: { _workflowId: "wf-1", _workflowName: "Workflow One" },
              errors: [],
              logs: [{ level: "info", msg: "completed" }],
              nodeStatuses: { n1: "completed", n2: "completed" },
              nodeStatusEvents: [{ nodeId: "n2", status: "completed" }],
            },
          }
        : null))),
    retryRun: vi.fn(async (runId, opts = {}) => ({
      originalRunId: runId,
      retryRunId: "run-2",
      ctx: { errors: [], mode: opts.mode || "from_failed" },
    })),
  })),
}));

vi.mock("../agent/agent-prompts.mjs", () => ({
  AGENT_PROMPT_DEFINITIONS: [
    {
      key: "orchestrator",
      filename: "orchestrator.md",
      description: "Primary task execution prompt for autonomous task agents.",
    },
    {
      key: "voiceAgent",
      filename: "voice-agent.md",
      description: "Voice agent system prompt for real-time voice sessions with action dispatch.",
    },
  ],
  getAgentPromptDefinitions: vi.fn(() => [
    {
      key: "orchestrator",
      filename: "orchestrator.md",
      description: "Primary task execution prompt for autonomous task agents.",
    },
    {
      key: "voiceAgent",
      filename: "voice-agent.md",
      description: "Voice agent system prompt for real-time voice sessions with action dispatch.",
    },
  ]),
  getPromptDefaultUpdateStatus: vi.fn(() => ({
    workspaceDir: "/tmp/.bosun/agents",
    summary: {
      total: 2,
      missing: 0,
      upToDate: 1,
      updateAvailable: 1,
      needsReview: 0,
    },
    updates: [
      {
        key: "orchestrator",
        updateAvailable: true,
        needsReview: false,
        reason: "default-updated",
      },
      {
        key: "voiceAgent",
        updateAvailable: false,
        needsReview: false,
        reason: "up-to-date",
      },
    ],
  })),
  applyPromptDefaultUpdates: vi.fn((_repoRoot, options = {}) => ({
    workspaceDir: "/tmp/.bosun/agents",
    updated: Array.isArray(options?.keys) && options.keys.length ? options.keys : ["orchestrator"],
    skipped: [],
  })),
}));

vi.mock("../voice/vision-session-state.mjs", () => ({
  getVisionSessionState: vi.fn(() => ({
    lastFrameDataUrl: "data:image/jpeg;base64,ZmFrZQ==",
    lastFrameSource: "screen",
  })),
}));

vi.mock("../voice/voice-relay.mjs", () => ({
  analyzeVisionFrame: vi.fn(async () => ({
    summary: "The terminal shows a syntax error in voice-tools.mjs.",
    provider: "openai",
    model: "gpt-4o",
  })),
}));

// ── Fresh imports per test (avoid cross-file module cache leaks) ────────────

let getToolDefinitions;
let executeToolCall;
let VOICE_TOOLS;
let createBuiltinToolDefinitions;
let execPrimaryPrompt;
let setPrimaryAgent;
let execPooledPrompt;
let promptDefaults;
let sessionTracker;
let analyzeVisionFrame;

function withApprovedToolContext(context = {}) {
  return {
    ...context,
    approval: {
      mode: "manual",
      decision: "approved",
      state: "approved",
      ...(context?.approval && typeof context.approval === "object" ? context.approval : {}),
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("voice-tools", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      getToolDefinitions,
      executeToolCall,
      VOICE_TOOLS,
    } = await import("../voice/voice-tools.mjs"));
    ({ createBuiltinToolDefinitions } = await import("../agent/tool-builtin-catalog.mjs"));
    ({ execPrimaryPrompt, setPrimaryAgent } = await import("../agent/primary-agent.mjs"));
    ({ execPooledPrompt } = await import("../agent/agent-pool.mjs"));
    promptDefaults = await import("../agent/agent-prompts.mjs");
    sessionTracker = await import("../infra/session-tracker.mjs");
    ({ analyzeVisionFrame } = await import("../voice/voice-relay.mjs"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── getToolDefinitions ──────────────────────────────────────

  describe("getToolDefinitions", () => {
    it("returns non-empty array", () => {
      const defs = getToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it("each tool def has required fields", () => {
      const defs = getToolDefinitions();
      for (const def of defs) {
        expect(def).toHaveProperty("type", "function");
        expect(def).toHaveProperty("name");
        expect(typeof def.name).toBe("string");
        expect(def).toHaveProperty("description");
        expect(typeof def.description).toBe("string");
        expect(def).toHaveProperty("parameters");
        expect(def.parameters).toHaveProperty("type", "object");
      }
    });

    it("includes gemini-sdk in delegate and switch executor enums", () => {
      const defs = getToolDefinitions();
      const delegate = defs.find((def) => def.name === "delegate_to_agent");
      const switchAgent = defs.find((def) => def.name === "switch_agent");
      expect(delegate?.parameters?.properties?.executor?.enum || []).toContain("gemini-sdk");
      expect(switchAgent?.parameters?.properties?.executor?.enum || []).toContain("gemini-sdk");
    });

    it("includes direct workflow run-inspection tools", () => {
      const defs = getToolDefinitions();
      const names = defs.map((def) => def.name);
      expect(names).toContain("get_workflow_definition");
      expect(names).toContain("list_workflow_runs");
      expect(names).toContain("get_workflow_run");
      expect(names).toContain("retry_workflow_run");
    });
  });

  // ── VOICE_TOOLS export ──────────────────────────────────────

  describe("VOICE_TOOLS", () => {
    it("is exported and equals getToolDefinitions()", () => {
      expect(VOICE_TOOLS).toBeDefined();
      expect(VOICE_TOOLS).toBe(getToolDefinitions());
    });
  });

  // ── executeToolCall ─────────────────────────────────────────

  describe("executeToolCall", () => {
    it("returns error for unknown tool", async () => {
      const result = await executeToolCall("nonexistent_tool", {});
      expect(result.error).toMatch(/unknown tool/i);
      expect(result.result).toBeNull();
    });

    it("list_tasks returns task array", async () => {
      const result = await executeToolCall("list_tasks", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0]).toHaveProperty("id");
      expect(parsed[0]).toHaveProperty("title");
    });

    it("get_task returns task details", async () => {
      const result = await executeToolCall("get_task", { taskId: "1" });
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("id");
      expect(parsed).toHaveProperty("title");
      expect(parsed).toHaveProperty("status");
    });

    it("create_task returns success message", async () => {
      const result = await executeToolCall(
        "create_task",
        { title: "Test" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/created/i);
    });

    it("get_system_status returns status object", async () => {
      const result = await executeToolCall("get_system_status", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("primaryAgent");
    });

    it("get_agent_status returns agent info", async () => {
      const result = await executeToolCall("get_agent_status", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed).toHaveProperty("activeAgent");
      expect(parsed).toHaveProperty("status");
    });

    it("delegate_to_agent returns immediately with delegation confirmation", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        {
          message: "test instruction",
        },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      expect(vi.mocked(execPooledPrompt)).toHaveBeenCalled();
      const callArgs = vi.mocked(execPooledPrompt).mock.calls[0];
      expect(callArgs[0]).toBe("test instruction");
    });

    it("delegate_to_agent honors call context session/executor/mode/model", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        withApprovedToolContext({
          sessionId: "primary-abc123",
          executor: "claude-sdk",
          mode: "plan",
          model: "claude-opus-4.6",
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
      expect(callArgs?.[1]).toMatchObject({
        sdk: "claude-sdk",
        mode: "plan",
        model: "claude-opus-4.6",
      });
    });

    it("delegate_to_agent skips voice-only approval defaults for workflow-agent contexts", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-agent-1",
          surface: "workflow",
          sessionType: "workflow-agent",
          approvalMode: "auto",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
    });

    it("builtin bridged delegate_to_agent defaults to non-voice tool context", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      const defs = createBuiltinToolDefinitions();
      const delegateTool = defs.find((tool) => tool.id === "delegate_to_agent");
      const result = await delegateTool.handler(
        { message: "bridge this task" },
        { sessionId: "workflow-tool-1" },
      );
      expect(result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("bridge this task");
    });

    it("delegate_to_agent coerces session-bound ask mode to agent", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "summarize the task" },
        withApprovedToolContext({
          sessionId: "primary-gemini-1",
          executor: "gemini-sdk",
          mode: "ask",
          model: "gemini-2.5-pro",
        }),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[1]).toMatchObject({
        sdk: "gemini-sdk",
        mode: "ask",
        model: "gemini-2.5-pro",
      });
    });

    it("delegate_to_agent appends latest vision summary when available", async () => {
      vi.mocked(sessionTracker.getSessionById).mockReturnValue({
        messages: [
          {
            role: "system",
            content: "[Vision screen] Terminal shows vitest failures in tests/voice-relay.test.mjs.",
          },
        ],
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "Please fix the failing test and explain why." },
        withApprovedToolContext({ sessionId: "primary-vision-1" }),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[0]).toContain("Please fix the failing test");
      expect(callArgs?.[0]).toContain("Live visual context from this call");
      expect(callArgs?.[0]).toContain("[Vision screen]");
    });

    it("ask_agent_context returns quick response from pooled prompt", async () => {
      const result = await executeToolCall("ask_agent_context", { message: "What is this repo?" });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      expect(result.result).toMatch(/pooled agent response/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(callArgs?.[1]).toMatchObject({ mode: "instant" });
    });

    it("ask_agent_context derives prompt from nested context history when message is missing", async () => {
      const result = await executeToolCall("ask_agent_context", {
        context: {
          history: [
            {
              role: "user",
              content: [{ type: "input_audio", transcript: "Can you check our current backlog tasks?" }],
            },
          ],
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      const callArgs = vi.mocked(execPooledPrompt).mock.calls.at(-1);
      expect(String(callArgs?.[0] || "")).toContain("check our current backlog tasks");
    });

    it("run_command returns system status for 'status'", async () => {
      const result = await executeToolCall(
        "run_command",
        { command: "status" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      // Now actually dispatches to get_system_status — expect a structured result
      const parsed = JSON.parse(result.result);
      expect(parsed).toMatchObject({ primaryAgent: expect.any(String) });
    });

    it("run_command returns informative error for unknown command", async () => {
      const result = await executeToolCall("run_command", {
        command: "rm -rf /",
      }, withApprovedToolContext());
      expect(result.error).toBeUndefined();
      // The new handler returns a help message pointing to run_workspace_command
      expect(result.result).toMatch(/unknown command|not recognized|supported|run_workspace_command/i);
    });

    it("unknown slash command returns help text and does not delegate", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      const result = await executeToolCall(
        "bosun_slash_command",
        { command: "/unknowncmd test" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/unknown slash command|supported commands/i);
      expect(vi.mocked(execPooledPrompt)).not.toHaveBeenCalled();
    });

    it("invoke_mcp_tool failure path returns error without delegate fallback", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      vi.mocked(execPooledPrompt).mockRejectedValueOnce(new Error("mcp timeout"));
      const result = await executeToolCall(
        "invoke_mcp_tool",
        { tool: "create_issue" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/invocation failed|verify the tool\/server name/i);
      expect(result.result).not.toMatch(/continuing in background/i);
      expect(vi.mocked(execPooledPrompt)).toHaveBeenCalledTimes(1);
    });

    it("run_workspace_command blocks non-safe commands for non-owner sessions", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      const result = await executeToolCall(
        "run_workspace_command",
        { command: "npm publish" },
        withApprovedToolContext({ role: "user", isOwner: false }),
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/blocked non-read-only workspace command|owner\/admin/i);
      expect(vi.mocked(execPooledPrompt)).not.toHaveBeenCalled();
    });

    it("run_workspace_command allows safe read-only commands without approval", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      const result = await executeToolCall(
        "run_workspace_command",
        { command: "node --version" },
        { sessionId: "workflow-session", approvalMode: "auto" },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/^v\d+/i);
      expect(vi.mocked(execPooledPrompt)).not.toHaveBeenCalled();
    });

    it("list_prompts includes prompt sync summary and update candidates", async () => {
      const result = await executeToolCall("list_prompts", {});
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.sync).toMatchObject({
        summary: {
          total: 2,
          updateAvailable: 1,
        },
      });
      expect(Array.isArray(parsed.sync.updateCandidates)).toBe(true);
      expect(parsed.sync.updateCandidates[0]).toMatchObject({
        key: "orchestrator",
        updateAvailable: true,
        needsReview: false,
      });
    });

    it("sync_prompt_defaults returns review summary when apply=false", async () => {
      const result = await executeToolCall(
        "sync_prompt_defaults",
        { apply: false },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.summary).toMatchObject({ total: 2, updateAvailable: 1 });
      expect(Array.isArray(parsed.updates)).toBe(true);
      expect(parsed.updates[0]).toHaveProperty("key");
      expect(parsed.updates[0]).toHaveProperty("reason");
      expect(vi.mocked(promptDefaults.getPromptDefaultUpdateStatus)).toHaveBeenCalled();
    });

    it("slash /promptsync apply parses keys and applies selected updates", async () => {
      const result = await executeToolCall(
        "bosun_slash_command",
        {
          command: "/promptsync apply orchestrator, voiceAgent",
        },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.updated).toEqual(["orchestrator", "voiceAgent"]);
      expect(vi.mocked(promptDefaults.applyPromptDefaultUpdates)).toHaveBeenLastCalledWith(
        expect.any(String),
        { keys: ["orchestrator", "voiceAgent"] },
      );
    });

    it("list_workflow_runs returns structured run history", async () => {
      const result = await executeToolCall("list_workflow_runs", { workflowId: "wf-1", limit: 10 });
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.runs[0]).toMatchObject({
        runId: "run-1",
        workflowId: "wf-1",
        status: "failed",
      });
    });

    it("get_workflow_run returns run detail with errors and logs", async () => {
      const result = await executeToolCall("get_workflow_run", { runId: "run-1", logLimit: 5 });
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.run).toMatchObject({
        runId: "run-1",
        workflowId: "wf-1",
        status: "failed",
      });
      expect(Array.isArray(parsed.run.logs)).toBe(true);
      expect(Array.isArray(parsed.run.errors)).toBe(true);
    });

    it("create_workflow creates a blank workflow when definition is omitted", async () => {
      const result = await executeToolCall("create_workflow", {
        name: "Voice-created Workflow",
      }, withApprovedToolContext());
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.workflow.name).toContain("Voice-created Workflow");
    });

    it("update_workflow_definition updates an existing workflow", async () => {
      const result = await executeToolCall("update_workflow_definition", {
        workflowId: "wf-1",
        patch: { description: "updated by test" },
      }, withApprovedToolContext());
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.workflow.id).toBe("wf-1");
    });

    it("execute_workflow runs workflow and returns run summary", async () => {
      const result = await executeToolCall("execute_workflow", {
        workflowId: "wf-1",
        input: { source: "voice-test" },
      }, withApprovedToolContext());
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.run.runId).toContain("run-exec");
      expect(parsed.run.status).toBe("completed");
    });

    it("analyze_workflow returns workflow health summary", async () => {
      const result = await executeToolCall("analyze_workflow", { workflowId: "wf-1", limit: 10 });
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBe(1);
      expect(parsed.analyses[0].workflowId).toBe("wf-1");
    });

    it("retry_workflow_run retries failed run by id", async () => {
      const result = await executeToolCall(
        "retry_workflow_run",
        { runId: "run-1", mode: "from_failed" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.originalRunId).toBe("run-1");
      expect(parsed.retryRunId).toBe("run-2");
    });

    it("retry_workflow_run rejects from_failed for non-failed runs", async () => {
      const result = await executeToolCall(
        "retry_workflow_run",
        { runId: "run-ok", mode: "from_failed" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(false);
      expect(String(parsed.error || "")).toMatch(/requires a failed run/i);
    });

    it("query_live_view infers query from nested context history when query is missing", async () => {
      const result = await executeToolCall(
        "query_live_view",
        {
          context: {
            history: [
              {
                role: "user",
                content: [
                  { type: "input_audio", transcript: "what exact error is visible on screen right now?" },
                ],
              },
            ],
          },
        },
        { sessionId: "voice-session-1", executor: "codex-sdk", mode: "instant", model: "gpt-realtime-1.5" },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      expect(result.result).toMatch(/syntax error/i);
      const callArgs = vi.mocked(analyzeVisionFrame).mock.calls.at(-1);
      expect(String(callArgs?.[1]?.prompt || "")).toMatch(/error is visible on screen/i);
    });

    it("query_live_view uses default query when no user query context is present", async () => {
      const result = await executeToolCall(
        "query_live_view",
        {},
        { sessionId: "voice-session-2", executor: "codex-sdk", mode: "instant", model: "gpt-realtime-1.5" },
      );
      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/\{RESPONSE\}:/i);
      const callArgs = vi.mocked(analyzeVisionFrame).mock.calls.at(-1);
      expect(String(callArgs?.[1]?.prompt || "")).toMatch(/Describe what is visible right now/i);
    });
  });
});
