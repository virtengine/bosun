import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ── Mock external boundaries ────────────────────────────────────────────────

const { mockBosunSessionManager } = vi.hoisted(() => ({
  mockBosunSessionManager: {
    cancelSession: vi.fn(() => true),
    getSession: vi.fn(() => null),
  },
}));

const { mockSpawnSync } = vi.hoisted(() => ({
  mockSpawnSync: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawnSync: (...args) => mockSpawnSync(...args),
  };
});

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
  listAllSessions: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSessionById: vi.fn(() => null),
  createSession: vi.fn(),
  updateSessionStatus: vi.fn(),
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
  launchOrResumeThread: vi.fn(async () => ({
    success: true,
    output: "pooled agent response",
    items: [],
    usage: null,
    threadId: "thread-1",
  })),
  resolvePoolSdkName: vi.fn(() => "codex"),
}));

vi.mock("../agent/session-manager.mjs", () => ({
  getBosunSessionManager: vi.fn(() => mockBosunSessionManager),
}));

const mockWorkflowEngine = {
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
    getRunDetail: vi.fn((runId) => {
      if (runId === "run-1") {
        return {
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
        };
      }
      if (runId === "run-ok") {
        return {
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
        };
      }
      if (runId === "run-paused") {
        return {
          runId: "run-paused",
          workflowId: "wf-1",
          workflowName: "Workflow One",
          status: "paused",
          startedAt: 1000,
          endedAt: 2000,
          duration: 1000,
          errorCount: 0,
          logCount: 1,
          detail: {
            data: { _workflowId: "wf-1", _workflowName: "Workflow One" },
            errors: [],
            logs: [{ level: "info", msg: "paused" }],
            nodeStatuses: { n1: "completed", n2: "pending" },
            nodeStatusEvents: [{ nodeId: "n2", status: "pending" }],
          },
        };
      }
      return null;
    }),
    getRetryOptions: vi.fn((runId) => {
      if (runId !== "run-paused") return null;
      return {
        runId: "run-paused",
        status: "paused",
        recommendedMode: "from_failed",
        recommendedReason: "create_tasks_pending.resume_only",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeId: "create-tasks",
          nextNodeLabel: "Create Tasks",
          safeResume: true,
          blockers: [],
          summary: "Run is paused with Create Tasks as the next pending node.",
        },
        options: [
          {
            mode: "from_failed",
            label: "Resume from next pending step",
            available: true,
            recommended: true,
            reason: "create_tasks_pending.resume_only",
          },
        ],
      };
    }),
    retryRun: vi.fn(async (runId, opts = {}) => ({
      originalRunId: runId,
      retryRunId: "run-2",
      ctx: { errors: [], mode: opts.mode || "from_failed" },
    })),
};

vi.mock("../workflow/workflow-engine.mjs", () => ({
  getWorkflowEngine: vi.fn(() => mockWorkflowEngine),
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
let launchOrResumeThread;
let resolvePoolSdkName;
let promptDefaults;
let sessionTracker;
let analyzeVisionFrame;

function makeTempRoot() {
  const dir = resolve(
    tmpdir(),
    `voice-tools-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

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
    mockBosunSessionManager.cancelSession.mockReset();
    mockBosunSessionManager.cancelSession.mockReturnValue(true);
    mockBosunSessionManager.getSession.mockReset();
    mockBosunSessionManager.getSession.mockReturnValue(null);
    const actualChildProcess = await vi.importActual("node:child_process");
    mockSpawnSync.mockReset();
    mockSpawnSync.mockImplementation((...args) => actualChildProcess.spawnSync(...args));
    ({
      getToolDefinitions,
      executeToolCall,
      VOICE_TOOLS,
    } = await import("../voice/voice-tools.mjs"));
    ({ createBuiltinToolDefinitions } = await import("../agent/tool-builtin-catalog.mjs"));
    ({ execPrimaryPrompt, setPrimaryAgent } = await import("../agent/primary-agent.mjs"));
    ({ execPooledPrompt, launchOrResumeThread, resolvePoolSdkName } = await import("../agent/agent-pool.mjs"));
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

    it("includes openai-native and gemini-sdk in delegate and switch executor enums", () => {
      const defs = getToolDefinitions();
      const delegate = defs.find((def) => def.name === "delegate_to_agent");
      const switchAgent = defs.find((def) => def.name === "switch_agent");
      expect(delegate?.parameters?.properties?.executor?.enum || []).toContain("openai-native");
      expect(switchAgent?.parameters?.properties?.executor?.enum || []).toContain("openai-native");
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

    it("read_file_content appends indexed file context for agents", async () => {
      const testRoot = makeTempRoot();
      try {
        const { runContextIndex } = await import("../workspace/context-indexer.mjs");

        mkdirSync(resolve(testRoot, "src"), { recursive: true });
        mkdirSync(resolve(testRoot, "tests"), { recursive: true });

        writeFileSync(
          resolve(testRoot, "src", "helper.mjs"),
          "export function formatGreeting(name) { return `hello ${name}`; }\n",
          "utf8",
        );

        writeFileSync(
          resolve(testRoot, "src", "alpha.mjs"),
          [
            "// alpha module",
            "import { formatGreeting } from './helper.mjs';",
            "export function greetUser(name) { return formatGreeting(name); }",
            "",
          ].join("\n"),
          "utf8",
        );

        writeFileSync(
          resolve(testRoot, "tests", "alpha.test.mjs"),
          [
            "import { greetUser } from '../src/alpha.mjs';",
            "export function alphaRuntimeTest() { return greetUser('Bosun'); }",
            "",
          ].join("\n"),
          "utf8",
        );

        await runContextIndex({
          rootDir: testRoot,
          includeTests: true,
          useTreeSitter: false,
          useZoekt: false,
        });

        vi.mocked(sessionTracker.getSessionById).mockReturnValue({
          metadata: {
            workspaceDir: testRoot,
          },
        });

        const result = await executeToolCall(
          "read_file_content",
          { filePath: "src/alpha.mjs" },
          {
            sessionId: "workflow-agent-file-read",
            surface: "workflow",
            sessionType: "workflow-agent",
            repoRoot: testRoot,
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.result).toContain("export function greetUser");
        expect(result.result).toContain("## Injected File Context");
        expect(result.result).toContain("Language: javascript");
        expect(result.result).toContain("greetUser");
        expect(result.result).toContain("src/helper.mjs");
      } finally {
        if (existsSync(testRoot)) {
          await rm(testRoot, { recursive: true, force: true });
        }
      }
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
      expect(vi.mocked(launchOrResumeThread)).toHaveBeenCalled();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls[0];
      expect(callArgs[0]).toBe("test instruction");
      expect(callArgs[3]).toMatchObject({
        sessionId: expect.stringMatching(/^voice-live-/),
        taskKey: expect.stringMatching(/^voice-live-/),
        sessionType: "voice-delegate",
        sessionScope: "voice",
      });
      expect(callArgs[3]?.taskKey).toBe(callArgs[3]?.sessionId);
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
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
      expect(callArgs?.[3]).toMatchObject({
        sdk: "claude-sdk",
        mode: "plan",
        model: "claude-opus-4.6",
      });
    });

    it("delegate_to_agent falls back to the active pool executor when config still points at codex-sdk", async () => {
      vi.mocked(resolvePoolSdkName).mockReturnValueOnce("openai-native");

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-openai-native-1",
          surface: "workflow",
          sessionType: "workflow-agent",
          executor: "codex-sdk",
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-1",
      });
    });

    it("delegate_to_agent prefers the managed parent session runtime over stale workflow executor hints", async () => {
      mockBosunSessionManager.getSession.mockReturnValue({
        sessionId: "workflow-openai-native-2",
        metadata: {
          providerSelection: "openai-native",
          adapterName: "openai-native",
        },
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-openai-native-2",
          surface: "workflow",
          sessionType: "workflow-agent",
          executor: "codex-sdk",
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-2",
      });
    });

    it("delegate_to_agent ignores stale explicit codex executor overrides when workflow runtime is already native", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        {
          message: "ship it",
          executor: "codex-sdk",
        },
        {
          sessionId: "workflow-openai-native-3",
          surface: "workflow",
          sessionType: "workflow-agent",
          adapterName: "openai-native",
          sdk: "openai-native",
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-3",
      });
    });

    it("delegate_to_agent forwards native provider selection and config into delegated launches", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-openai-native-4",
          surface: "workflow",
          sessionType: "workflow-agent",
          adapterName: "openai-native",
          sdk: "openai-native",
          providerSelection: "azure-openai-responses-2",
          providerId: "azure-openai-responses",
          providerConfig: {
            selectionId: "azure-openai-responses-2",
            provider: "azure-openai-responses",
            providerId: "azure-openai-responses",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
            deployment: "gpt-5.4-secondary",
            model: "gpt-5.4",
          },
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-4",
        providerSelection: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        pinSdk: true,
        model: "gpt-5.4",
        providerConfig: expect.objectContaining({
          selectionId: "azure-openai-responses-2",
          provider: "azure-openai-responses",
          providerId: "azure-openai-responses",
          endpoint: "https://secondary.example/openai/v1",
          apiVersion: "2024-10-01-preview",
          deployment: "gpt-5.4-secondary",
          model: "gpt-5.4",
        }),
      });
    });

    it("delegate_to_agent prefers inherited provider config model over stale parent session model", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-openai-native-4b",
          surface: "workflow",
          sessionType: "workflow-agent",
          adapterName: "openai-native",
          sdk: "openai-native",
          model: "gpt-5",
          providerSelection: "azure-openai-responses-2",
          providerId: "azure-openai-responses",
          providerConfig: {
            selectionId: "azure-openai-responses-2",
            provider: "azure-openai-responses",
            providerId: "azure-openai-responses",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
            deployment: "gpt-5.4-secondary",
            model: "gpt-5.4",
          },
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-4b",
        model: "gpt-5.4",
        providerConfig: expect.objectContaining({
          model: "gpt-5.4",
        }),
      });
    });

    it("delegate_to_agent prefers managed session provider model over stale tool context model", async () => {
      mockBosunSessionManager.getSession.mockReturnValue({
        sessionId: "workflow-openai-native-4c",
        metadata: {
          providerSelection: "azure-openai-responses-2",
          providerId: "azure-openai-responses",
          model: "gpt-5",
          providerConfig: {
            selectionId: "azure-openai-responses-2",
            provider: "azure-openai-responses",
            providerId: "azure-openai-responses",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
            deployment: "gpt-5.4-secondary",
            model: "gpt-5.4",
          },
        },
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        {
          sessionId: "workflow-openai-native-4c",
          surface: "workflow",
          sessionType: "workflow-agent",
          adapterName: "openai-native",
          sdk: "openai-native",
          model: "gpt-5",
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-4c",
        providerSelection: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        model: "gpt-5.4",
        providerConfig: expect.objectContaining({
          model: "gpt-5.4",
        }),
      });
    });

    it("delegate_to_agent keeps inherited native provider model when subdelegate args request a generic alias", async () => {
      const result = await executeToolCall(
        "delegate_to_agent",
        {
          message: "ship it",
          model: "gpt-5",
        },
        {
          sessionId: "workflow-openai-native-4d",
          surface: "workflow",
          sessionType: "workflow-agent",
          adapterName: "openai-native",
          sdk: "openai-native",
          providerSelection: "azure-openai-responses-2",
          providerId: "azure-openai-responses",
          providerConfig: {
            selectionId: "azure-openai-responses-2",
            provider: "azure-openai-responses",
            providerId: "azure-openai-responses",
            endpoint: "https://secondary.example/openai/v1",
            apiVersion: "2024-10-01-preview",
            deployment: "gpt-5.4-secondary",
            model: "gpt-5.4",
          },
        },
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
        sdk: "openai-native",
        parentSessionId: "workflow-openai-native-4d",
        model: "gpt-5.4",
        providerConfig: expect.objectContaining({
          model: "gpt-5.4",
        }),
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
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("ship it");
      expect(callArgs?.[3]).toMatchObject({
        sessionId: expect.stringMatching(/^delegate-live-/),
        taskKey: expect.stringMatching(/^delegate-live-/),
        sessionType: "workflow-agent-delegate",
        sessionScope: "delegate",
        parentSessionId: "workflow-agent-1",
        pinSdk: true,
      });
    });

    it("builtin bridged delegate_to_agent defaults to non-voice tool context", async () => {
      vi.mocked(launchOrResumeThread).mockClear();
      const defs = createBuiltinToolDefinitions();
      const delegateTool = defs.find((tool) => tool.id === "delegate_to_agent");
      const result = await delegateTool.handler(
        { message: "bridge this task" },
        { sessionId: "workflow-tool-1" },
      );
      expect(result).toMatch(/\{RESPONSE\}/i);
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[0]).toBe("bridge this task");
      expect(callArgs?.[3]).toMatchObject({
        sessionId: expect.stringMatching(/^delegate-live-/),
        taskKey: expect.stringMatching(/^delegate-live-/),
        sessionType: "tool-bridge-delegate",
        sessionScope: "delegate",
        parentSessionId: "workflow-tool-1",
      });
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
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[3]).toMatchObject({
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
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      expect(callArgs?.[0]).toContain("Please fix the failing test");
      expect(callArgs?.[0]).toContain("Live visual context from this call");
      expect(callArgs?.[0]).toContain("[Vision screen]");
    });

    it("delegate_to_agent marks placeholder no-text delegate completions as no_output", async () => {
      vi.mocked(launchOrResumeThread).mockResolvedValueOnce({
        success: true,
        output: "(Agent completed with no text output)",
        items: [],
        status: "completed",
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "write the fix" },
        withApprovedToolContext({ sessionId: "primary-no-output-1" }),
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      const liveSessionId = callArgs?.[3]?.sessionId;
      await Promise.resolve();
      await Promise.resolve();
      expect(sessionTracker.updateSessionStatus).toHaveBeenCalledWith(liveSessionId, "no_output");
      expect(sessionTracker.recordEvent).toHaveBeenCalledWith(
        liveSessionId,
        expect.objectContaining({
          role: "system",
          content: expect.stringMatching(/no text output/i),
        }),
      );
    });

    it("delegate_to_agent preserves blocked delegate failures instead of marking them completed", async () => {
      vi.mocked(launchOrResumeThread).mockResolvedValueOnce({
        success: false,
        status: "blocked_by_env",
        blockedReason: "blocked_by_env",
        error: "Missing credentials for delegated execution",
        items: [],
      });

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "ship it" },
        withApprovedToolContext({ sessionId: "primary-blocked-1" }),
      );

      expect(result.error).toBeUndefined();
      const callArgs = vi.mocked(launchOrResumeThread).mock.calls.at(-1);
      const liveSessionId = callArgs?.[3]?.sessionId;
      await Promise.resolve();
      await Promise.resolve();
      const statusCallIndex = vi.mocked(sessionTracker.updateSessionStatus).mock.calls.findIndex(
        (call) => call[0] === liveSessionId && call[1] === "blocked_by_env",
      );
      const eventCallIndex = vi.mocked(sessionTracker.recordEvent).mock.calls.findIndex(
        (call) => call[0] === liveSessionId && /Missing credentials/i.test(String(call[1]?.content || "")),
      );
      expect(eventCallIndex).toBeGreaterThanOrEqual(0);
      expect(statusCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(sessionTracker.recordEvent).mock.invocationCallOrder[eventCallIndex],
      ).toBeLessThan(
        vi.mocked(sessionTracker.updateSessionStatus).mock.invocationCallOrder[statusCallIndex],
      );
      expect(sessionTracker.updateSessionStatus).toHaveBeenCalledWith(liveSessionId, "blocked_by_env");
      expect(sessionTracker.recordEvent).toHaveBeenCalledWith(
        liveSessionId,
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("Missing credentials for delegated execution"),
        }),
      );
    });

    it("delegate_to_agent blocks nested delegation from delegated tool sessions", async () => {
      vi.mocked(launchOrResumeThread).mockClear();

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "spawn another coding session" },
        {
          sessionId: "delegate-live-root",
          sessionType: "task-delegate",
          parentSessionId: "workflow-parent",
          surface: "bosun-builtin",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/nested delegate_to_agent calls are blocked/i);
      expect(vi.mocked(launchOrResumeThread)).not.toHaveBeenCalled();
    });

    it("delegate_to_agent blocks nested delegation when a delegate-live session loses sessionType metadata", async () => {
      vi.mocked(launchOrResumeThread).mockClear();

      const result = await executeToolCall(
        "delegate_to_agent",
        { message: "spawn another coding session" },
        withApprovedToolContext({
          sessionId: "delegate-live-root",
          parentSessionId: "workflow-parent",
        }),
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/nested delegate_to_agent calls are blocked/i);
      expect(vi.mocked(launchOrResumeThread)).not.toHaveBeenCalled();
    });

    it("cancel_subagent recursively terminalizes tracked delegate descendants", async () => {
      vi.mocked(sessionTracker.listAllSessions).mockReturnValue([
        {
          id: "delegate-live-root",
          status: "active",
          parentSessionId: "workflow-agent-1",
        },
        {
          id: "delegate-live-child",
          status: "active",
          parentSessionId: "delegate-live-root",
        },
        {
          id: "delegate-live-grandchild",
          status: "active",
          parentSessionId: "delegate-live-child",
        },
        {
          id: "delegate-live-terminal",
          status: "no_output",
          parentSessionId: "delegate-live-root",
        },
      ]);
      vi.mocked(sessionTracker.recordEvent).mockClear();
      vi.mocked(sessionTracker.updateSessionStatus).mockClear();
      mockBosunSessionManager.cancelSession.mockClear();

      const defs = createBuiltinToolDefinitions();
      const cancelTool = defs.find((tool) => tool.id === "cancel_subagent");
      const result = await cancelTool.handler(
        {
          childSessionId: "delegate-live-root",
          reason: "delegate_unusable",
        },
        { sessionId: "workflow-agent-1" },
      );

      expect(result).toMatchObject({
        ok: true,
        cancelled: true,
        sessionId: "delegate-live-root",
        lineageSessionIds: [
          "delegate-live-root",
          "delegate-live-child",
          "delegate-live-terminal",
          "delegate-live-grandchild",
        ],
        cancelledSessionIds: [
          "delegate-live-grandchild",
          "delegate-live-terminal",
          "delegate-live-child",
          "delegate-live-root",
        ],
        terminalizedSessionIds: [
          "delegate-live-grandchild",
          "delegate-live-child",
          "delegate-live-root",
        ],
      });
      expect(mockBosunSessionManager.cancelSession).toHaveBeenNthCalledWith(1, "delegate-live-grandchild", "delegate_unusable");
      expect(mockBosunSessionManager.cancelSession).toHaveBeenNthCalledWith(2, "delegate-live-terminal", "delegate_unusable");
      expect(mockBosunSessionManager.cancelSession).toHaveBeenNthCalledWith(3, "delegate-live-child", "delegate_unusable");
      expect(mockBosunSessionManager.cancelSession).toHaveBeenNthCalledWith(4, "delegate-live-root", "delegate_unusable");
      expect(sessionTracker.recordEvent).toHaveBeenCalledWith(
        "delegate-live-grandchild",
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("delegate_unusable"),
        }),
      );
      expect(sessionTracker.updateSessionStatus).toHaveBeenCalledWith("delegate-live-grandchild", "aborted");
      expect(sessionTracker.updateSessionStatus).toHaveBeenCalledWith("delegate-live-child", "aborted");
      expect(sessionTracker.updateSessionStatus).toHaveBeenCalledWith("delegate-live-root", "aborted");
      expect(sessionTracker.updateSessionStatus).not.toHaveBeenCalledWith("delegate-live-terminal", "aborted");
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

    it("list_directory honors explicit context cwd before repo root", async () => {
      const testRoot = makeTempRoot();
      const sentinel = "cwd-sentinel.txt";
      writeFileSync(resolve(testRoot, sentinel), "ok");
      try {
        const result = await executeToolCall(
          "list_directory",
          { path: "." },
          {
            cwd: testRoot,
            repoRoot: testRoot,
          },
        );
        expect(result.error).toBeUndefined();
        const parsed = JSON.parse(result.result);
        expect(parsed).toContain(sentinel);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    });

    it("run_workspace_command allows non-safe commands for delegated non-voice sessions", async () => {
      vi.mocked(execPooledPrompt).mockClear();
      const result = await executeToolCall(
        "run_workspace_command",
        { command: "node -p 1+1" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result.trim()).toBe("2");
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

    it("run_workspace_command resolves npm.cmd through the shell on Windows", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "9.9.9", ""],
        stdout: "9.9.9",
        stderr: "",
        status: 0,
        signal: null,
      });
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "win32" });

      try {
        const result = await executeToolCall(
          "run_workspace_command",
          { command: "npm test" },
          {
            sessionId: "delegate-session-1",
            surface: "bosun-builtin",
            sessionType: "tool-bridge-delegate",
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.result.trim()).toBe("9.9.9");
        expect(mockSpawnSync).toHaveBeenCalledWith(
          "npm.cmd",
          ["test"],
          expect.objectContaining({
            maxBuffer: 16 * 1024 * 1024,
            shell: true,
            timeout: 300000,
          }),
        );
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("run_workspace_command explains shell-metacharacter rejections with one-command guidance", async () => {
      const result = await executeToolCall(
        "run_workspace_command",
        { command: "npm test && npm run build" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/shell metacharacters are not allowed/i);
      expect(result.result).toMatch(/one command per tool call/i);
      expect(result.result).toMatch(/&&/);
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("run_workspace_command explains empty git diff output as a clean diff", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        { command: "git diff -- workflow/workflow-engine.mjs tests/workflow-engine.test.mjs" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/command completed with no output/i);
      expect(result.result).toMatch(/no diff/i);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/git(?:\.exe)?$/i),
        ["diff", "--", "workflow/workflow-engine.mjs", "tests/workflow-engine.test.mjs"],
        expect.objectContaining({
          shell: false,
        }),
      );
    });

    it("run_workspace_command treats empty vitest output as a success artifact when the command exits cleanly", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        { command: "node tools/vitest-runner.mjs run tests/workflow-engine.test.mjs" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/completed successfully with no output/i);
      expect(result.result).toMatch(/usable pass\/fail artifact/i);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "node",
        [
          expect.stringMatching(/tools[\\/]vitest-runner\.mjs$/i),
          "run",
          "tests/workflow-engine.test.mjs",
        ],
        expect.objectContaining({
          shell: false,
        }),
      );
    });

    it("run_workspace_command preserves a usable success artifact when long test output is truncated", async () => {
      const stdout = [
        "RUN  v3.2.4 C:/repo",
        ...Array.from({ length: 500 }, (_, index) => `progress line ${index}`),
        "Test Files 12 passed",
        "Tests 200 passed",
        "Duration 45.21s",
      ].join("\n");
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        { command: "npm test" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toMatch(/completed successfully/i);
      expect(result.result).toMatch(/exceeded the inline limit/i);
      expect(result.result).toMatch(/usable pass\/fail artifact/i);
      expect(result.result).toContain("Tests 200 passed");
      expect(result.result).toContain("Duration 45.21s");
      expect(result.result).toContain("...");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/npm(?:\.cmd)?$/i),
        ["test"],
        expect.objectContaining({
          shell: true,
        }),
      );
    });

    it("run_workspace_command rewrites managed-worktree vitest runs to the source checkout runner", async () => {
      const managedWorktree = resolve(
        process.cwd(),
        ".bosun",
        "worktrees",
        `voice-tools-vitest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      );
      mkdirSync(managedWorktree, { recursive: true });
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "ok", ""],
        stdout: "ok",
        stderr: "",
        status: 0,
        signal: null,
      });

      try {
        const result = await executeToolCall(
          "run_workspace_command",
          { command: "node tools/vitest-runner.mjs run tests/workflow-engine.test.mjs" },
          {
            cwd: managedWorktree,
            sessionId: "delegate-session-1",
            surface: "bosun-builtin",
            sessionType: "tool-bridge-delegate",
          },
        );

        expect(result.error).toBeUndefined();
        expect(result.result.trim()).toBe("ok");
        expect(mockSpawnSync).toHaveBeenCalledWith(
          "node",
          [
            resolve(process.cwd(), "tools", "vitest-runner.mjs"),
            "run",
            "tests/workflow-engine.test.mjs",
          ],
          expect.objectContaining({
            cwd: managedWorktree,
            maxBuffer: 16 * 1024 * 1024,
            shell: false,
            timeout: 300000,
          }),
        );
      } finally {
        await rm(managedWorktree, { recursive: true, force: true });
      }
    });

    it("run_workspace_command gives npm build scripts a long timeout", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "built", ""],
        stdout: "built",
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        { command: "npm run build" },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result.trim()).toBe("built");
        expect(mockSpawnSync).toHaveBeenCalledWith(
          expect.stringMatching(/npm(?:\.cmd)?$/i),
          ["run", "build"],
          expect.objectContaining({
            maxBuffer: 16 * 1024 * 1024,
            timeout: 300000,
          }),
        );
    });

    it("run_workspace_command preserves quoted conventional commit messages for delegated sessions", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "amended", ""],
        stdout: "amended",
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        {
          command: "git commit --amend -m \"fix(workspace): restore per-agent rate limiting for persistent memory writes\"",
        },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result.trim()).toBe("amended");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/git(?:\.exe)?$/i),
        [
          "commit",
          "--amend",
          "-m",
          "fix(workspace): restore per-agent rate limiting for persistent memory writes",
        ],
        expect.objectContaining({
          shell: false,
        }),
      );
    });

    it("run_workspace_command allows git commit co-author trailers with angle brackets for delegated sessions", async () => {
      mockSpawnSync.mockReturnValue({
        pid: 1234,
        output: [null, "committed", ""],
        stdout: "committed",
        stderr: "",
        status: 0,
        signal: null,
      });

      const result = await executeToolCall(
        "run_workspace_command",
        {
          command: "git commit -m \"feat(workflow): persist node completion checkpoints for resume-safe execution\" -m \"Co-authored-by: bosun-ve[bot] <262908237+bosun-ve[bot]@users.noreply.github.com>\"",
        },
        {
          sessionId: "delegate-session-1",
          surface: "bosun-builtin",
          sessionType: "tool-bridge-delegate",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.result.trim()).toBe("committed");
      expect(mockSpawnSync).toHaveBeenCalledWith(
        expect.stringMatching(/git(?:\.exe)?$/i),
        [
          "commit",
          "-m",
          "feat(workflow): persist node completion checkpoints for resume-safe execution",
          "-m",
          "Co-authored-by: bosun-ve[bot] <262908237+bosun-ve[bot]@users.noreply.github.com>",
        ],
        expect.objectContaining({
          shell: false,
        }),
      );
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

    it("retry_workflow_run resumes paused guarded runs through interrupted-run retry", async () => {
      const result = await executeToolCall(
        "retry_workflow_run",
        { runId: "run-paused", mode: "from_failed" },
        withApprovedToolContext(),
      );
      expect(result.error).toBeUndefined();
      const parsed = JSON.parse(result.result);
      expect(parsed.ok).toBe(true);
      expect(parsed.originalRunId).toBe("run-paused");
      expect(parsed.retryRunId).toBe("run-2");
      const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
      const engine = workflowEngineModule.getWorkflowEngine();
      expect(engine.retryRun).toHaveBeenCalledWith("run-paused", {
        mode: "from_failed",
        _resumeInterrupted: true,
        _decisionReason: "create_tasks_pending.resume_only",
      });
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
