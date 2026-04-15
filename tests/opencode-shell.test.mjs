/**
 * tests/opencode-shell.test.mjs
 *
 * Unit tests for the OpenCode shell adapter.
 *
 * External boundaries mocked:
 *   - @opencode-ai/sdk  (OpenCode server + client)
 *   - ./agent-sdk.mjs   (config reader)
 *   - ./repo-root.mjs   (workspace path)
 *   - node:fs/promises  (state file I/O)
 *
 * The module under test (opencode-shell.mjs) is imported fresh per describe
 * block where state isolation requires it, or shared where re-import isn't
 * needed (to mirror how bosun actually uses the module).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  flushHarnessTelemetryRuntimeForTests,
  listHarnessTelemetryEvents,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";

// ── Module-scope mock state ───────────────────────────────────────────────────

const mockSessionCreate = vi.fn();
const mockSessionGet = vi.fn();
const mockSessionList = vi.fn();
const mockSessionPrompt = vi.fn();
const mockSessionAbort = vi.fn();
const mockEventSubscribe = vi.fn();
const mockCreateOpencode = vi.fn();
const mockCreateOpencodeClient = vi.fn();
const SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 5_000;

/** Build a mock client that all SDK tests share */
function makeMockClient() {
  return {
    session: {
      create: mockSessionCreate,
      get: mockSessionGet,
      list: mockSessionList,
      prompt: mockSessionPrompt,
      abort: mockSessionAbort,
    },
    event: {
      subscribe: mockEventSubscribe,
    },
  };
}

/** Default: subscribe returns an empty async-iterable stream */
function defaultEventSubscribeResult() {
  mockEventSubscribe.mockResolvedValue({
    stream: {
      async *[Symbol.asyncIterator]() {
        // emit nothing — turns complete without SSE events
      },
    },
    destroy: vi.fn(),
  });
}

/** Build a successful prompt result */
function makePromptResult(text = "task complete") {
  return {
    data: {
      info: { id: "msg-1" },
      parts: [{ type: "text", text }],
    },
  };
}

// ── SDK mock ──────────────────────────────────────────────────────────────────

vi.mock("@opencode-ai/sdk", () => ({
  createOpencode: (...args) => mockCreateOpencode(...args),
  createOpencodeClient: (...args) => mockCreateOpencodeClient(...args),
}));

vi.mock("../agent/agent-sdk.mjs", () => ({
  resolveAgentSdkConfig: vi.fn(() => ({
    primary: "opencode",
    capabilities: { steering: true, subagents: true, vscodeTools: false },
  })),
}));

vi.mock("../config/repo-root.mjs", () => ({
  resolveRepoRoot: vi.fn(() => "/mock/repo"),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

// Zero-delay retries so transient-retry tests don't hit real network waits
vi.mock("../infra/stream-resilience.mjs", () => ({
  isTransientStreamError: (err) => String(err?.message || "").includes("503"),
  streamRetryDelay: () => 0,
  MAX_STREAM_RETRIES: 5,
}));

// ── Import the module under test ──────────────────────────────────────────────

// Dynamic import is used so each describe block can control env before import.
// We use a shared import here since the mocks are consistent across tests.
const {
  execOpencodePrompt,
  steerOpencodePrompt,
  isOpencodeBusy,
  getSessionInfo,
  getActiveSessionId,
  resetSession,
  listSessions,
  switchSession,
  createSession,
  initOpencodeShell,
} = await import("../shell/opencode-shell.mjs");

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupHappyPath() {
  const client = makeMockClient();
  mockCreateOpencode.mockResolvedValue({
    client,
    server: { close: vi.fn() },
  });
  mockSessionCreate.mockResolvedValue({ data: { id: "server-uuid-abc" } });
  mockSessionGet.mockResolvedValue({ data: { id: "server-uuid-abc" } });
  mockSessionPrompt.mockResolvedValue(makePromptResult("done!"));
  defaultEventSubscribeResult();
  return client;
}

afterEach(() => {
  resetHarnessObservabilitySpinesForTests();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("isOpencodeBusy()", () => {
  it("returns false when idle", () => {
    expect(isOpencodeBusy()).toBe(false);
  });
});

describe("getSessionInfo()", () => {
  it("returns a stable shape with expected keys", () => {
    const info = getSessionInfo();
    expect(info).toMatchObject({
      turnCount: expect.any(Number),
      isActive: expect.any(Boolean),
      isBusy: expect.any(Boolean),
      sessionCount: expect.any(Number),
    });
  });
});

describe("execOpencodePrompt() — primary guard", () => {
  it("returns an error message when primary SDK is not opencode", async () => {
    const { resolveAgentSdkConfig } = await import("../agent/agent-sdk.mjs");
    resolveAgentSdkConfig.mockReturnValueOnce({
      primary: "codex",
      capabilities: {},
    });

    const result = await execOpencodePrompt("do something");
    expect(result.finalResponse).toContain("codex");
    expect(result.finalResponse).toContain("disabled");
    expect(result.items).toEqual([]);
  });
});

describe("execOpencodePrompt() — disabled guard", () => {
  beforeEach(() => {
    process.env.OPENCODE_SDK_DISABLED = "1";
  });
  afterEach(() => {
    delete process.env.OPENCODE_SDK_DISABLED;
  });

  it("returns early with disabled message", async () => {
    const result = await execOpencodePrompt("test");
    expect(result.finalResponse).toContain("disabled");
    expect(result.items).toEqual([]);
  });
});

describe("execOpencodePrompt() — server startup failure", () => {
  it("returns error when createOpencode and client-only attach both fail", async () => {
    mockCreateOpencode.mockRejectedValue(new Error("binary not found"));
    mockCreateOpencodeClient.mockImplementation(() => {
      throw new Error("connection refused");
    });

    const result = await execOpencodePrompt("test");
    expect(result.finalResponse).toContain("OpenCode server could not be started");
  });
});

describe("execOpencodePrompt() — happy path", () => {
  beforeEach(() => {
    setupHappyPath();
  });

  afterEach(async () => {
    // Reset between tests to avoid cross-test session state
    await resetSession();
    vi.clearAllMocks();
  });

  it("returns finalResponse from prompt result", async () => {
    const result = await execOpencodePrompt("Fix the bug", { sessionId: "test-happy" });
    expect(result.finalResponse).toContain("done!");
    expect(result.items).toBeInstanceOf(Array);
    expect(result.usage).toBeNull();
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("calls onEvent with formatted strings", async () => {
    const events = [];
    // The module caches _client from first ensureServerStarted() call.
    // Re-configure the global vi.fn mocks (which are on the cached client).
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-onEvent" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-onEvent" } });
    mockSessionPrompt.mockResolvedValue(makePromptResult("response text"));
    mockEventSubscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "tool.start",
            properties: {
              sessionId: "uuid-onEvent",
              tool: "bash",
              input: { command: "go test ./..." },
            },
          };
        },
      },
      destroy: vi.fn(),
    });

    const result = await execOpencodePrompt("run the tests", {
      sessionId: "event-session",
      onEvent: (msg) => events.push(msg),
    });

    expect(result.finalResponse).toBe("response text");
    expect(events.some((e) => e.includes("Running") && e.includes("go test"))).toBe(true);
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("records canonical lifecycle and stream telemetry for the legacy entrypoint", async () => {
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-telemetry" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-telemetry" } });
    mockSessionPrompt.mockResolvedValue(makePromptResult("telemetry response"));
    mockEventSubscribe.mockResolvedValue({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "tool.start",
            properties: {
              sessionId: "uuid-telemetry",
              tool: "bash",
              input: { command: "npm test" },
            },
          };
        },
      },
      destroy: vi.fn(),
    });

    const result = await execOpencodePrompt("run telemetry path", {
      sessionId: "telemetry-session",
      persistent: true,
      provider: "opencode",
      onEvent: () => {},
    });

    await flushHarnessTelemetryRuntimeForTests();

    expect(result.finalResponse).toBe("telemetry response");
    const events = listHarnessTelemetryEvents({
      source: "shell-session-compat",
      sessionId: "telemetry-session",
    });
    expect(events.some((event) => event.eventType === "shell.session.running")).toBe(true);
    expect(events.some((event) => event.eventType === "shell.session.completed")).toBe(true);
    expect(events.some((event) => event.eventType === "shell.stream.event")).toBe(true);
    expect(events.some((event) => event.providerId === "openai-compatible")).toBe(true);
    expect(getActiveSessionId()).toBe("telemetry-session");
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("enriches prompt with statusData context", async () => {
    await execOpencodePrompt("do work", {
      sessionId: "status-session",
      statusData: { activeTask: "VE-42" },
    });

    const callArg = mockSessionPrompt.mock.calls[0];
    const body = callArg[0]?.body;
    const text = body?.parts?.[0]?.text || "";
    expect(text).toContain("Orchestrator Status");
    expect(text).toContain("VE-42");
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("does not enrich prompt when statusData is absent", async () => {
    await execOpencodePrompt("bare message", { sessionId: "bare-session" });
    const callArg = mockSessionPrompt.mock.calls[0];
    const text = callArg[0]?.body?.parts?.[0]?.text || "";
    expect(text).not.toContain("Orchestrator Status");
    expect(text).toContain("bare message");
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("includes model config when OPENCODE_MODEL is set", async () => {
    process.env.OPENCODE_MODEL = "anthropic/claude-sonnet-5";
    await execOpencodePrompt("with model", { sessionId: "model-session" });
    const body = mockSessionPrompt.mock.calls[0][0]?.body;
    expect(body?.model?.providerID).toBe("anthropic");
    expect(body?.model?.modelID).toBe("claude-sonnet-5");
    delete process.env.OPENCODE_MODEL;
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("omits model when OPENCODE_MODEL is not set", async () => {
    delete process.env.OPENCODE_MODEL;
    await execOpencodePrompt("no model", { sessionId: "no-model-session" });
    const body = mockSessionPrompt.mock.calls[0][0]?.body;
    expect(body).not.toHaveProperty("model");
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);

  it("allows Bosun-selected OpenCode runs even when agent-sdk primary is codex", async () => {
    const { resolveAgentSdkConfig } = await import("../agent/agent-sdk.mjs");
    resolveAgentSdkConfig.mockReturnValueOnce({
      primary: "codex",
      capabilities: { steering: true, subagents: true, vscodeTools: false },
    });

    const result = await execOpencodePrompt("do something", {
      sessionId: "bosun-opencode-primary",
      expectedPrimary: "opencode",
    });

    expect(result.finalResponse).toContain("done!");
    expect(result.items).toBeInstanceOf(Array);
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);
});

describe("execOpencodePrompt() — busy guard", () => {
  it("rejects concurrent turns", async () => {
    setupHappyPath();
    // Slow down prompt() to simulate overlap
    let resolveFirst;
    mockSessionPrompt.mockImplementation(
      () =>
        new Promise((res) => {
          resolveFirst = () => res(makePromptResult("slow"));
        }),
    );
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-busy" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-busy" } });
    defaultEventSubscribeResult();

    const first = execOpencodePrompt("slow task", { sessionId: "busy-1" });
    // Give the first call time to set activeTurn = true
    await new Promise((r) => setTimeout(r, 10));

    const second = await execOpencodePrompt("concurrent", { sessionId: "busy-2" });
    expect(second.finalResponse).toContain("still executing");

    // Resolve the first
    resolveFirst?.();
    await first;
    await resetSession();
  });
});

describe("execOpencodePrompt() — transient retry", () => {
  afterEach(async () => {
    await resetSession();
    vi.clearAllMocks();
  });

  it("retries on 503 error and succeeds", async () => {
    const client = makeMockClient();
    mockCreateOpencode.mockResolvedValue({ client, server: { close: vi.fn() } });
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-retry" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-retry" } });
    defaultEventSubscribeResult();

    let callCount = 0;
    mockSessionPrompt.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("503 service unavailable");
        return Promise.reject(err);
      }
      return Promise.resolve(makePromptResult("succeeded after retry"));
    });

    const result = await execOpencodePrompt("retry me", { sessionId: "retry-session" });
    expect(result.finalResponse).toBe("succeeded after retry");
    expect(callCount).toBe(2);
  });

  it("returns error message after exhausting all retries", async () => {
    const client = makeMockClient();
    mockCreateOpencode.mockResolvedValue({ client, server: { close: vi.fn() } });
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-exhaust" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-exhaust" } });
    defaultEventSubscribeResult();
    mockSessionPrompt.mockRejectedValue(new Error("503 service unavailable"));

    const result = await execOpencodePrompt("will fail", { sessionId: "exhaust-session" });
    expect(result.finalResponse).toContain("connection failed");
    expect(result.finalResponse).toContain("retries");
  });
});

describe("execOpencodePrompt() — timeout abort", () => {
  afterEach(async () => {
    await resetSession();
    vi.clearAllMocks();
  });

  it("returns timeout message and calls session.abort", async () => {
    // The module caches _client, so configure global mocks.
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-timeout" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-timeout" } });
    mockEventSubscribe.mockResolvedValue({
      stream: { async *[Symbol.asyncIterator]() {} },
      destroy: vi.fn(),
    });
    mockSessionAbort.mockResolvedValue({});

    // Prompt never resolves within timeout
    mockSessionPrompt.mockImplementation(
      () => new Promise(() => {/* never */}),
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort("timeout"), 50);

    const result = await execOpencodePrompt("long task", {
      sessionId: "timeout-session",
      abortController: controller,
    });

    expect(result.finalResponse).toContain("timed out");
    expect(mockSessionAbort).toHaveBeenCalled();
  });
});

describe("steerOpencodePrompt()", () => {
  afterEach(async () => {
    await resetSession();
    vi.clearAllMocks();
  });

  it("calls session.abort and returns ok:true when session is active", async () => {
    setupHappyPath();
    // Establish an active session
    await execOpencodePrompt("establish session", { sessionId: "steer-session" });

    const steerResult = await steerOpencodePrompt("stop and reconsider");
    expect(steerResult.ok).toBe(true);
    expect(steerResult.mode).toBe("abort");
  });

  it("returns ok:false with reason when no active session", async () => {
    // no session established
    const result = await steerOpencodePrompt("steer");
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("returns ok:false when SDK not opencode", async () => {
    const { resolveAgentSdkConfig } = await import("../agent/agent-sdk.mjs");
    resolveAgentSdkConfig.mockReturnValueOnce({
      primary: "codex",
      capabilities: { steering: false },
    });
    const result = await steerOpencodePrompt("steer");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not_opencode");
  });

  it("allows steering when Bosun selected OpenCode despite agent-sdk primary mismatch", async () => {
    setupHappyPath();
    mockSessionCreate.mockResolvedValue({ data: { id: "uuid-steer-bypass" } });
    mockSessionGet.mockResolvedValue({ data: { id: "uuid-steer-bypass" } });
    await execOpencodePrompt("establish session", {
      sessionId: "steer-bypass-session",
      expectedPrimary: "opencode",
    });

    const { resolveAgentSdkConfig } = await import("../agent/agent-sdk.mjs");
    resolveAgentSdkConfig.mockReturnValueOnce({
      primary: "codex",
      capabilities: { steering: true, subagents: true, vscodeTools: false },
    });

    const result = await steerOpencodePrompt("steer", {
      expectedPrimary: "opencode",
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("abort");
  });
});

describe("resetSession()", () => {
  it("clears turn state and session map", async () => {
    setupHappyPath();
    await execOpencodePrompt("setup", { sessionId: "reset-me", persistent: true });
    expect(getSessionInfo().namedSessionId).toBe("reset-me");

    await resetSession();
    const info = getSessionInfo();
    expect(info.namedSessionId).toBeNull();
    expect(info.isBusy).toBe(false);
    expect(info.sessionCount).toBe(0);
  });
});

describe("Session management — listSessions / switchSession / createSession", () => {
  beforeEach(() => {
    setupHappyPath();
    mockSessionList.mockResolvedValue({ data: [] });
  });

  afterEach(async () => {
    await resetSession();
    vi.clearAllMocks();
  });

  it("createSession returns {id, serverSessionId:null} for new sessions", async () => {
    const s = await createSession("new-session");
    expect(s.id).toBe("new-session");
    expect(s.serverSessionId).toBeNull();
  });

  it("listSessions includes sessions established via exec", async () => {
    await execOpencodePrompt("test", { sessionId: "list-sess-a", persistent: true });
    const sessions = await listSessions();
    expect(sessions.some((s) => s.id === "list-sess-a")).toBe(true);
  });

  it("switchSession updates activeNamedSessionId", async () => {
    await execOpencodePrompt("test", { sessionId: "switch-a", persistent: true });
    await switchSession("switch-b");
    expect(getActiveSessionId()).toBe("switch-b");
  }, SLOW_OPENCODE_SHELL_TEST_TIMEOUT_MS);
});

describe("Event formatting — formatOpencodeEvent (via onEvent)", () => {
  afterEach(async () => {
    await resetSession();
    vi.clearAllMocks();
  });

  const cases = [
    {
      label: "tool.start bash",
      event: { type: "tool.start", properties: { sessionId: "X", tool: "bash", input: { command: "npm test" } } },
      expectContains: ["Running", "npm test"],
    },
    {
      label: "tool.complete bash success",
      event: {
        type: "tool.complete",
        properties: { sessionId: "X", tool: "bash", input: { command: "npm test" }, exitCode: 0, output: "passed" },
      },
      expectContains: [":check:", "npm test"],
    },
    {
      label: "tool.complete bash failure",
      event: {
        type: "tool.complete",
        properties: { sessionId: "X", tool: "bash", input: { command: "npm test" }, exitCode: 1 },
      },
      expectContains: [":close:", "npm test"],
    },
    {
      label: "tool.start write",
      event: { type: "tool.start", properties: { sessionId: "X", tool: "write", input: { path: "src/app.ts" } } },
      expectContains: ["Writing", "src/app.ts"],
    },
    {
      label: "tool.start web_search",
      event: {
        type: "tool.start",
        properties: { sessionId: "X", tool: "web_search", input: { query: "opencode sdk" } },
      },
      expectContains: ["Searching", "opencode sdk"],
    },
    {
      label: "tool.start MCP",
      event: {
        type: "tool.start",
        properties: { sessionId: "X", tool: "mcp_vibe_list_issues", input: {} },
      },
      expectContains: ["MCP", "vibe"],
    },
    {
      label: "session.error",
      event: { type: "session.error", properties: { sessionId: "X", error: "boom" } },
      expectContains: [":close:", "boom"],
    },
    {
      label: "file.created",
      event: { type: "file.created", properties: { sessionId: "X", path: "lib/new.ts" } },
      expectContains: [":plus:", "lib/new.ts"],
    },
  ];

  for (const { label, event, expectContains } of cases) {
    it(`formats ${label}`, async () => {
      // The module caches _client; configure global mocks.
      mockSessionCreate.mockResolvedValue({ data: { id: "X" } });
      mockSessionGet.mockResolvedValue({ data: { id: "X" } });
      mockSessionPrompt.mockResolvedValue(makePromptResult("ok"));

      const emitted = [];
      mockEventSubscribe.mockResolvedValue({
        stream: {
          async *[Symbol.asyncIterator]() {
            yield event;
          },
        },
        destroy: vi.fn(),
      });

      await execOpencodePrompt("test event formatting", {
        sessionId: `fmt-${label.replace(/ /g, "-")}`,
        onEvent: (msg) => emitted.push(msg),
      });

      for (const expected of expectContains) {
        expect(emitted.some((e) => e && e.includes(expected))).toBe(true);
      }
    });
  }
});

describe("State persistence", () => {
  it("saveState and loadState roundtrip", async () => {
    const { readFile, writeFile } = await import("node:fs/promises");

    let savedContent = null;
    writeFile.mockImplementation((_path, content) => {
      savedContent = content;
      return Promise.resolve();
    });
    readFile.mockImplementation(() => {
      if (savedContent) return Promise.resolve(savedContent);
      return Promise.reject(new Error("ENOENT"));
    });

    setupHappyPath();
    await execOpencodePrompt("persist test", { sessionId: "persist-1", persistent: true });

    // Simulate re-init by calling initOpencodeShell (which calls loadState)
    await initOpencodeShell();

    expect(savedContent).not.toBeNull();
    const parsed = JSON.parse(savedContent);
    expect(parsed).toHaveProperty("activeNamedSessionId");
    expect(parsed).toHaveProperty("sessionMap");
    expect(parsed).toHaveProperty("turnCount");
  });
});

describe("initOpencodeShell()", () => {
  it("completes without error when SDK is available", async () => {
    await expect(initOpencodeShell()).resolves.toBeUndefined();
  });

  it("completes without error when OPENCODE_SDK_DISABLED=1", async () => {
    process.env.OPENCODE_SDK_DISABLED = "1";
    await expect(initOpencodeShell()).resolves.toBeUndefined();
    delete process.env.OPENCODE_SDK_DISABLED;
  });
});

describe("discoverProviders()", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the registry-backed compatibility shim instead of shell-local discovery ownership", async () => {
    vi.resetModules();
    const { discoverProviders } = await import("../shell/opencode-providers.mjs");
    const snapshot = await discoverProviders({ force: true });

    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.connectedIds)).toBe(true);
    expect(snapshot.providers.every((entry) => entry.source === "registry")).toBe(true);
  });
});
