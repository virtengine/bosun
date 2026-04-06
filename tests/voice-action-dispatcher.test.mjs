import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock external boundaries ────────────────────────────────────────────────

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    voice: { enabled: true, delegateExecutor: "codex-sdk" },
    primaryAgent: "codex-sdk",
    kanbanBackend: "internal",
    projectName: "test-project",
    mode: "generic",
  })),
}));

vi.mock("../agent/primary-agent.mjs", () => {
  let _agent = "codex-sdk";
  let _mode = "agent";
  return {
    execPrimaryPrompt: vi.fn(async (msg) => `Agent response to: ${msg}`),
    getPrimaryAgentName: vi.fn(() => _agent),
    setPrimaryAgent: vi.fn((name) => { _agent = name; }),
    getAgentMode: vi.fn(() => _mode),
    setAgentMode: vi.fn((m) => { _mode = m; }),
  };
});

const mockTasks = [
  { id: "task-1", number: 1, title: "Fix login bug", status: "todo", labels: ["bug"], body: "Login fails on mobile" },
  { id: "task-2", number: 2, title: "Add dark mode", status: "inprogress", labels: ["feature"], body: "Dark mode toggle" },
  { id: "task-3", number: 3, title: "Update docs", status: "done", labels: ["docs"], body: "README updates" },
  { id: "task-4", number: 4, title: "API refactor", status: "todo", labels: ["refactor"], body: "Refactor REST endpoints" },
  { id: "task-5", number: 5, title: "Voice integration", status: "inreview", labels: ["feature", "voice"], body: "Voice agent" },
];

vi.mock("../kanban/kanban-adapter.mjs", () => ({
  listTasks: vi.fn(async (_projId, _filters) => mockTasks),
  getTask: vi.fn(async (id) => mockTasks.find((t) => t.id === id || String(t.number) === String(id)) || null),
  createTask: vi.fn(async (_projId, data) => ({ id: "task-new", number: 99, title: data.title, status: "todo" })),
  updateTask: vi.fn(async () => {}),
  updateTaskStatus: vi.fn(async () => {}),
  deleteTask: vi.fn(async () => {}),
  addComment: vi.fn(async () => {}),
}));

vi.mock("../infra/session-tracker.mjs", () => ({
  listSessions: vi.fn(() => [
    { id: "sess-1", type: "primary", status: "active", lastActiveAt: "2026-03-01T00:00:00Z" },
  ]),
  listAllSessions: vi.fn(() => [
    { id: "sess-1", type: "primary", status: "active", lastActiveAt: "2026-03-01T00:00:00Z" },
  ]),
  getSession: vi.fn((id) =>
    id === "sess-1"
      ? { id: "sess-1", messages: [{ role: "user", content: "Hello", timestamp: "2026-03-01T00:00:01Z" }] }
      : null,
  ),
  getSessionById: vi.fn((id) =>
    id === "sess-1"
      ? { id: "sess-1", messages: [{ role: "user", content: "Hello", timestamp: "2026-03-01T00:00:01Z" }] }
      : null,
  ),
  createSession: vi.fn((opts) => ({ id: opts?.id || `sess-${Date.now()}`, type: opts?.type || "voice", status: "active" })),
}));

vi.mock("../agent/fleet-coordinator.mjs", () => ({
  getFleetStatus: vi.fn(() => ({ workstations: 2, healthy: true })),
}));

vi.mock("../agent/agent-supervisor.mjs", () => ({}));
vi.mock("../workspace/shared-state-manager.mjs", () => ({}));

vi.mock("../agent/agent-prompts.mjs", () => ({
  getAgentPromptDefinitions: vi.fn(() => [
    { key: "orchestrator", filename: "orchestrator.md", description: "Orchestrator prompt" },
    { key: "voiceAgent", filename: "voice-agent.md", description: "Voice agent prompt" },
  ]),
  getDefaultPromptTemplate: vi.fn((key) => key === "voiceAgent" ? "# Voice Agent\nTest prompt" : ""),
  AGENT_PROMPT_DEFINITIONS: [
    { key: "orchestrator", filename: "orchestrator.md", description: "Orchestrator prompt" },
  ],
}));

vi.mock("../agent/bosun-skills.mjs", () => ({
  BUILTIN_SKILLS: [
    { filename: "test-skill.md", title: "Test Skill", tags: ["test"], scope: "global" },
  ],
}));

vi.mock("../workflow/workflow-templates.mjs", () => ({
  listTemplates: vi.fn(() => [
    { id: "wf-1", name: "Standard", description: "Standard workflow" },
  ]),
  getTemplate: vi.fn((id) =>
    id === "wf-1" ? { id: "wf-1", name: "Standard", description: "Standard workflow", steps: [] } : null,
  ),
}));

vi.mock("../voice/voice-tools.mjs", () => ({
  executeToolCall: vi.fn(async (name, args) => ({
    result: `Tool ${name} executed with ${JSON.stringify(args)}`,
  })),
}));

// ── Import module under test ────────────────────────────────────────────────

vi.resetModules();

const {
  dispatchVoiceAction,
  dispatchVoiceActions,
  listAvailableActions,
  hasAction,
  getActionManifest,
  getVoiceActionPromptSection,
} = await import("../voice/voice-action-dispatcher.mjs");
const { executeToolCall } = await import("../voice/voice-tools.mjs");
const {
  clearVisionSessionState,
  describeMultimodalFallback,
  ensureBrowserWorkerIsolation,
  getBrowserWorkerIsolation,
  getVoiceTurnTrace,
  formatVoiceTurnTrace,
  recordMultimodalFallback,
} = await import("../voice/vision-session-state.mjs");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("voice-action-dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVisionSessionState("trace-mismatch");
    clearVisionSessionState("trace-duplicate");
    clearVisionSessionState("browser-worker-session");
  });

  describe("browser worker isolation", () => {
    it("creates an isolated browser profile context per session and records text fallback state", () => {
      const browserWorker = ensureBrowserWorkerIsolation("browser-worker-session", {
        parentSessionId: "parent-browser-session",
        rootSessionId: "root-browser-session",
        requestedCapabilities: ["playwright.navigate", "playwright.screenshot"],
        toolHints: ["browser", "screenshot"],
      });
      const fallback = recordMultimodalFallback("browser-worker-session", {
        summary: "Build dashboard shows one failing smoke test in the right rail.",
        source: "browser-screenshot",
        width: 1440,
        height: 900,
        reason: "ui_validation",
      });
      const description = describeMultimodalFallback("browser-worker-session");

      expect(browserWorker).toEqual(expect.objectContaining({
        sessionId: "browser-worker-session",
        parentSessionId: "parent-browser-session",
        rootSessionId: "root-browser-session",
        profileScope: "isolated-subagent",
        profileDir: expect.stringContaining(".bosun/.cache/browser-workers/"),
        requestedCapabilities: ["playwright.navigate", "playwright.screenshot"],
      }));
      expect(getBrowserWorkerIsolation("browser-worker-session")).toEqual(expect.objectContaining({
        workerId: browserWorker.workerId,
        profileId: browserWorker.profileId,
      }));
      expect(fallback).toEqual(expect.objectContaining({
        available: true,
        source: "browser-screenshot",
        summary: expect.stringContaining("failing smoke test"),
      }));
      expect(description).toEqual(expect.objectContaining({
        available: true,
        description: expect.stringContaining("failing smoke test"),
        browserWorker: expect.objectContaining({
          workerId: browserWorker.workerId,
        }),
      }));
    });
  });

  // ── Registry ───────────────────────────────────────────────

  describe("action registry", () => {
    it("lists all available actions", () => {
      const actions = listAvailableActions();
      expect(actions).toContain("task.list");
      expect(actions).toContain("task.create");
      expect(actions).toContain("task.get");
      expect(actions).toContain("task.update");
      expect(actions).toContain("task.updateStatus");
      expect(actions).toContain("task.delete");
      expect(actions).toContain("task.search");
      expect(actions).toContain("task.stats");
      expect(actions).toContain("task.comment");
      expect(actions).toContain("agent.delegate");
      expect(actions).toContain("agent.ask");
      expect(actions).toContain("agent.plan");
      expect(actions).toContain("agent.code");
      expect(actions).toContain("agent.web");
      expect(actions).toContain("agent.instant");
      expect(actions).toContain("agent.status");
      expect(actions).toContain("agent.switch");
      expect(actions).toContain("agent.setMode");
      expect(actions).toContain("session.list");
      expect(actions).toContain("session.history");
      expect(actions).toContain("system.status");
      expect(actions).toContain("system.fleet");
      expect(actions).toContain("system.config");
      expect(actions).toContain("system.health");
      expect(actions).toContain("workspace.readFile");
      expect(actions).toContain("workspace.listDir");
      expect(actions).toContain("workspace.search");
      expect(actions).toContain("tool.call");
      expect(actions).toContain("workflow.list");
      expect(actions).toContain("skill.list");
      expect(actions).toContain("prompt.list");
      expect(actions).toContain("prompt.get");
      expect(actions).toContain("batch");
    });

    it("checks if action exists", () => {
      expect(hasAction("task.list")).toBe(true);
      expect(hasAction("nonexistent")).toBe(false);
      expect(hasAction("")).toBe(false);
    });
  });

  // ── Action manifest ────────────────────────────────────────

  describe("action manifest", () => {
    it("returns manifest array", () => {
      const manifest = getActionManifest();
      expect(Array.isArray(manifest)).toBe(true);
      expect(manifest.length).toBeGreaterThan(10);
      expect(manifest[0]).toHaveProperty("action");
      expect(manifest[0]).toHaveProperty("description");
    });

    it("generates prompt section", () => {
      const section = getVoiceActionPromptSection();
      expect(section).toContain("Available Bosun Actions");
      expect(section).toContain("task.list");
      expect(section).toContain("agent.delegate");
      expect(section).toContain("batch");
    });
  });

  // ── Dispatcher ─────────────────────────────────────────────

  describe("dispatchVoiceAction", () => {
    it("returns error for missing action", async () => {
      const result = await dispatchVoiceAction({});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("action is required");
    });

    it("returns error for unknown action", async () => {
      const result = await dispatchVoiceAction({ action: "nonexistent" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown action");
    });

    it("echoes correlation id", async () => {
      const result = await dispatchVoiceAction({ action: "system.status", params: {}, id: "corr-123" });
      expect(result.id).toBe("corr-123");
    });

    it("includes duration", async () => {
      const result = await dispatchVoiceAction({ action: "system.status", params: {} });
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("prevents duplicate dispatches within the same turn", async () => {
      const intent = {
        action: "tool.call",
        params: { toolName: "list_tasks", args: { status: "todo" } },
        id: "dup-tool-1",
      };
      const context = { sessionId: "voice-session-dup", turnId: "turn-dup-1" };

      const first = await dispatchVoiceAction(intent, context);
      const second = await dispatchVoiceAction(intent, context);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.error).toMatch(/duplicate/i);
      expect(vi.mocked(executeToolCall)).toHaveBeenCalledTimes(1);
    });
  });

  // ── Task actions ───────────────────────────────────────────

  describe("task actions", () => {
    it("lists all tasks", async () => {
      const result = await dispatchVoiceAction({ action: "task.list", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBe(5);
      expect(result.data.tasks).toHaveLength(5);
      expect(result.data.tasks[0]).toHaveProperty("id");
      expect(result.data.tasks[0]).toHaveProperty("title");
      expect(result.data.tasks[0]).toHaveProperty("status");
    });

    it("lists tasks with limit", async () => {
      const result = await dispatchVoiceAction({ action: "task.list", params: { limit: 2 } });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBe(2);
      expect(result.data.total).toBe(5);
    });

    it("gets a specific task", async () => {
      const result = await dispatchVoiceAction({ action: "task.get", params: { taskId: "task-1" } });
      expect(result.ok).toBe(true);
      expect(result.data.title).toBe("Fix login bug");
      expect(result.data.status).toBe("todo");
    });

    it("returns error for missing task", async () => {
      const result = await dispatchVoiceAction({ action: "task.get", params: { taskId: "nonexistent" } });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("creates a task", async () => {
      const result = await dispatchVoiceAction({
        action: "task.create",
        params: { title: "New feature", description: "Add voice calling", priority: "high" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.title).toBe("New feature");
      expect(result.data.message).toContain("Task created");
    });

    it("requires title for task creation", async () => {
      const result = await dispatchVoiceAction({ action: "task.create", params: {} });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("title is required");
    });

    it("updates task status", async () => {
      const result = await dispatchVoiceAction({
        action: "task.updateStatus",
        params: { taskId: "task-1", status: "inprogress" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.status).toBe("inprogress");
    });

    it("deletes a task", async () => {
      const result = await dispatchVoiceAction({ action: "task.delete", params: { taskId: "task-1" } });
      expect(result.ok).toBe(true);
      expect(result.data.message).toContain("deleted");
    });

    it("searches tasks", async () => {
      const result = await dispatchVoiceAction({ action: "task.search", params: { query: "voice" } });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBeGreaterThan(0);
      expect(result.data.tasks[0].title).toContain("Voice");
    });

    it("gets task statistics", async () => {
      const result = await dispatchVoiceAction({ action: "task.stats", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.total).toBe(5);
      expect(result.data.byStatus).toBeDefined();
      expect(result.data.backlog).toBe(2);
      expect(result.data.inProgress).toBe(1);
    });

    it("comments on a task", async () => {
      const result = await dispatchVoiceAction({
        action: "task.comment",
        params: { taskId: "task-1", body: "Working on this!" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.message).toContain("Comment added");
    });
  });

  // ── Agent actions ──────────────────────────────────────────

  describe("agent actions", () => {
    it("delegates to agent", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.delegate",
        params: { message: "Fix the bug in auth.mjs" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.executor).toBe("codex-sdk");
      expect(result.data.mode).toBe("agent");
      expect(result.data.response).toContain("Agent response to");
    });

    it("agent.ask delegates in ask mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.ask",
        params: { message: "How does the config system work?" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.mode).toBe("ask");
    });

    it("agent.plan delegates in plan mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.plan",
        params: { message: "Plan a refactor of voice module" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.mode).toBe("plan");
    });

    it("agent.code delegates in agent mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.code",
        params: { message: "Write a new endpoint" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.mode).toBe("agent");
    });

    it("agent.web delegates in web mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.web",
        params: { message: "Summarize this docs topic quickly" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.mode).toBe("web");
    });

    it("agent.instant delegates in instant mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.instant",
        params: { message: "Quickly explain why test failed" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.mode).toBe("instant");
    });

    it("gets agent status", async () => {
      const result = await dispatchVoiceAction({ action: "agent.status", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.activeAgent).toBe("codex-sdk");
      expect(result.data.status).toBe("available");
    });

    it("switches agent", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.switch",
        params: { executor: "copilot-sdk" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.current).toBe("copilot-sdk");
    });

    it("rejects invalid executor", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.switch",
        params: { executor: "invalid-agent" },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid executor");
    });

    it("sets agent mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.setMode",
        params: { mode: "plan" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.current).toBe("plan");
    });

    it("sets agent mode using alias quick -> instant", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.setMode",
        params: { mode: "quick" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.current).toBe("instant");
    });

    it("rejects invalid mode", async () => {
      const result = await dispatchVoiceAction({
        action: "agent.setMode",
        params: { mode: "invalid" },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid mode");
    });
  });

  // ── Session actions ────────────────────────────────────────

  describe("session actions", () => {
    it("lists sessions", async () => {
      const result = await dispatchVoiceAction({ action: "session.list", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.sessions).toBeDefined();
    });

    it("gets session history", async () => {
      const result = await dispatchVoiceAction({
        action: "session.history",
        params: { sessionId: "sess-1" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.sessionId).toBe("sess-1");
    });
  });

  // ── System actions ─────────────────────────────────────────

  describe("system actions", () => {
    it("gets system status", async () => {
      const result = await dispatchVoiceAction({ action: "system.status", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.primaryAgent).toBeDefined();
      expect(result.data.voiceEnabled).toBe(true);
    });

    it("gets fleet status", async () => {
      const result = await dispatchVoiceAction({ action: "system.fleet", params: {} });
      expect(result.ok).toBe(true);
    });

    it("gets config", async () => {
      const result = await dispatchVoiceAction({ action: "system.config", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.projectName).toBe("test-project");
    });

    it("gets config by key", async () => {
      const result = await dispatchVoiceAction({
        action: "system.config",
        params: { key: "primaryAgent" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.primaryAgent).toBe("codex-sdk");
    });

    it("gets health", async () => {
      const result = await dispatchVoiceAction({ action: "system.health", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.healthy).toBe(true);
      expect(typeof result.data.uptime).toBe("number");
      expect(typeof result.data.memoryMB).toBe("number");
    });
  });

  // ── Tool call passthrough ──────────────────────────────────

  describe("tool call passthrough", () => {
    it("dispatches tool call", async () => {
      const result = await dispatchVoiceAction({
        action: "tool.call",
        params: { toolName: "list_tasks", args: { status: "todo" } },
      });
      expect(result.ok).toBe(true);
      expect(result.data.result).toContain("list_tasks");
    });

    it("requires toolName", async () => {
      const result = await dispatchVoiceAction({ action: "tool.call", params: {} });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("toolName is required");
    });
  });

  // ── Workflow actions ───────────────────────────────────────

  describe("workflow actions", () => {
    it("lists workflows", async () => {
      const result = await dispatchVoiceAction({ action: "workflow.list", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBeGreaterThan(0);
      expect(result.data.templates[0].id).toBe("wf-1");
    });

    it("gets a workflow template", async () => {
      const result = await dispatchVoiceAction({
        action: "workflow.get",
        params: { id: "wf-1" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.name).toBe("Standard");
    });

    it("returns error for missing workflow", async () => {
      const result = await dispatchVoiceAction({
        action: "workflow.get",
        params: { id: "nonexistent" },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  // ── Skill/prompt actions ───────────────────────────────────

  describe("skill and prompt actions", () => {
    it("lists skills", async () => {
      const result = await dispatchVoiceAction({ action: "skill.list", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBeGreaterThan(0);
      expect(result.data.skills[0].title).toBe("Test Skill");
    });

    it("lists prompts", async () => {
      const result = await dispatchVoiceAction({ action: "prompt.list", params: {} });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBeGreaterThan(0);
    });

    it("gets a prompt template", async () => {
      const result = await dispatchVoiceAction({
        action: "prompt.get",
        params: { key: "voiceAgent" },
      });
      expect(result.ok).toBe(true);
      expect(result.data.key).toBe("voiceAgent");
      expect(result.data.content).toContain("Voice Agent");
    });
  });

  // ── Batch actions ──────────────────────────────────────────

  describe("batch actions", () => {
    it("executes multiple actions", async () => {
      const result = await dispatchVoiceAction({
        action: "batch",
        params: {
          actions: [
            { action: "task.stats", params: {} },
            { action: "agent.status", params: {} },
          ],
        },
      });
      expect(result.ok).toBe(true);
      expect(result.data.count).toBe(2);
      expect(result.data.results[0].ok).toBe(true);
      expect(result.data.results[1].ok).toBe(true);
    });

    it("rejects empty batch", async () => {
      const result = await dispatchVoiceAction({
        action: "batch",
        params: { actions: [] },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("actions array is required");
    });

    it("limits batch size", async () => {
      const actions = Array.from({ length: 15 }, (_, i) => ({
        action: "task.stats",
        params: {},
      }));
      const result = await dispatchVoiceAction({
        action: "batch",
        params: { actions },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Maximum 10");
    });
  });

  // ── dispatchVoiceActions (multiple) ────────────────────────

  describe("dispatchVoiceActions", () => {
    it("dispatches multiple intents", async () => {
      const results = await dispatchVoiceActions([
        { action: "system.status", params: {} },
        { action: "task.stats", params: {} },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
    });

    it("handles non-array input", async () => {
      const results = await dispatchVoiceActions(null);
      expect(results).toEqual([]);
    });

    it("records mismatch reasons without leaking sensitive params", async () => {
      const result = await dispatchVoiceAction(
        {
          action: "nonexistent",
          params: { apiKey: "sk-top-secret", token: "bearer-secret" },
        },
        { sessionId: "trace-mismatch", traceTurns: true },
      );
      expect(result.ok).toBe(false);

      const trace = getVoiceTurnTrace("trace-mismatch");
      expect(trace?.turns?.length).toBeGreaterThan(0);
      expect(trace?.turns?.at(-1)?.events?.some((event) => event.reason === "unknown_action")).toBe(true);

      const replay = formatVoiceTurnTrace("trace-mismatch");
      expect(replay).toContain("unknown_action");
      expect(replay).not.toContain("sk-top-secret");
      expect(replay).not.toContain("bearer-secret");
    });

    it("prevents duplicate dispatches within a traced batch", async () => {
      const results = await dispatchVoiceActions(
        [
          { action: "task.stats", params: { token: "secret-value" }, id: "dup-1" },
          { action: "task.stats", params: { token: "secret-value" }, id: "dup-1" },
        ],
        { sessionId: "trace-duplicate", traceTurns: true },
      );

      expect(results).toHaveLength(2);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(false);
      expect(results[1].error).toMatch(/duplicate/i);

      const replay = formatVoiceTurnTrace("trace-duplicate");
      expect(replay).toContain("duplicate_dispatch");
      expect(replay).not.toContain("secret-value");
    });
  });
});


