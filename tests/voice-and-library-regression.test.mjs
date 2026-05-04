import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ══════════════════════════════════════════════════════════════════════════════
//  Regression tests for voice agent + library issues
//  Covers: voice identity injection, tool result handling, turn detection,
//          MCP marketplace scoping, library search, voice profile tools
// ══════════════════════════════════════════════════════════════════════════════

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    voice: {
      provider: "openai",
      openaiApiKey: "sk-test-key",
    },
    primaryAgent: "codex-sdk",
  })),
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

vi.mock("../voice/voice-tools.mjs", () => ({
  executeToolCall: vi.fn(async (name) => ({ result: `mock result for ${name}` })),
  getToolDefinitions: vi.fn(() => [
    { type: "function", name: "list_tasks" },
    { type: "function", name: "delegate_to_agent" },
  ]),
}));

vi.mock("../agent/provider-auth-state.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveSharedOAuthToken: vi.fn(() => null),
    saveSharedOAuthToken: vi.fn(),
  };
});

vi.mock("../infra/session-tracker.mjs", () => ({
  getSessionById: vi.fn(() => null),
  getSession: vi.fn(() => null),
  recordEvent: vi.fn(),
  addSessionEventListener: vi.fn(() => () => {}),
}));

// ── Global fetch mock ────────────────────────────────────────────────────────

const _origFetch = globalThis.fetch;
const _origVoiceTurnDetection = process.env.VOICE_TURN_DETECTION;

beforeEach(() => {
  delete process.env.VOICE_TURN_DETECTION;
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      client_secret: { value: "test-token", expires_at: Date.now() / 1000 + 60 },
    }),
  }));
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  if (_origVoiceTurnDetection == null) {
    delete process.env.VOICE_TURN_DETECTION;
  } else {
    process.env.VOICE_TURN_DETECTION = _origVoiceTurnDetection;
  }
  vi.restoreAllMocks();
});

// ── Fresh imports per test (avoid cross-file module cache leaks) ────────────

let loadConfig;
let getVoiceConfig;
let createEphemeralToken;

beforeEach(async () => {
  vi.resetModules();
  ({ loadConfig } = await import("../config/config.mjs"));
  ({
    getVoiceConfig,
    createEphemeralToken,
  } = await import("../voice/voice-relay.mjs"));
});

// ══════════════════════════════════════════════════════════════════════════════
//  1. Voice identity / instructions injection
// ══════════════════════════════════════════════════════════════════════════════

describe("voice agent identity injection", () => {
  it("prepends voiceInstructions BEFORE base instructions (not as suffix emphasis)", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      voice: { provider: "openai", openaiApiKey: "sk-test" },
      primaryAgent: "codex-sdk",
    });
    getVoiceConfig(true);

    await createEphemeralToken(
      [{ type: "function", name: "list_tasks" }],
      {
        sessionId: "session-1",
        voiceAgentId: "voice-agent-female",
        voiceAgentInstructions: "You are Nova, a female voice agent.",
      },
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    const instructions = payload.instructions;

    // voiceInstructions should appear at the START of instructions
    expect(instructions.startsWith("You are Nova, a female voice agent.")).toBe(true);

    // Should NOT contain the old "emphasis" format
    expect(instructions).not.toContain("Voice agent instruction emphasis:");

    // Context section should still be present
    expect(instructions).toContain("Bosun Voice Call Context");
  });

  it("works without voiceInstructions (no crash, no empty prepend)", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      voice: { provider: "openai", openaiApiKey: "sk-test" },
      primaryAgent: "codex-sdk",
    });
    getVoiceConfig(true);

    await createEphemeralToken(
      [{ type: "function", name: "list_tasks" }],
      { sessionId: "session-2" },
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    const instructions = payload.instructions;

    // Should not start with undefined/null/empty
    expect(instructions).toBeTruthy();
    expect(instructions).not.toMatch(/^undefined/);
    expect(instructions).not.toMatch(/^null/);
  });

  it("includes voiceAgentName in context section", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      voice: { provider: "openai", openaiApiKey: "sk-test" },
      primaryAgent: "codex-sdk",
    });
    getVoiceConfig(true);

    await createEphemeralToken(
      [{ type: "function", name: "list_tasks" }],
      {
        sessionId: "session-3",
        voiceAgentId: "voice-agent-female",
        voiceAgentName: "Nova",
        voiceAgentInstructions: "You are Nova.",
      },
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    expect(payload.instructions).toContain("Active voice agent name: Nova.");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  2. Turn detection settings
// ══════════════════════════════════════════════════════════════════════════════

describe("voice turn detection settings", () => {
  it("uses relaxed server_vad settings to prevent talking over user", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      voice: { provider: "openai", openaiApiKey: "sk-test", turnDetection: "server_vad" },
      primaryAgent: "codex-sdk",
    });
    getVoiceConfig(true);

    await createEphemeralToken(
      [{ type: "function", name: "list_tasks" }],
      { sessionId: "session-vad" },
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    const td = payload.turn_detection;

    expect(td.type).toBe("server_vad");
    // Silence duration should be >= 1500ms for natural pauses
    expect(td.silence_duration_ms).toBeGreaterThanOrEqual(1500);
    // Threshold should be >= 0.7 to filter keyboard/ambient noise from triggering VAD
    expect(td.threshold).toBeGreaterThanOrEqual(0.7);
    // Prefix padding should allow natural speech starts
    expect(td.prefix_padding_ms).toBeGreaterThanOrEqual(400);
  });

  it("uses low eagerness for semantic_vad", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      voice: {
        provider: "openai",
        openaiApiKey: "sk-test",
        turnDetection: "semantic_vad",
      },
      primaryAgent: "codex-sdk",
    });
    getVoiceConfig(true);

    await createEphemeralToken(
      [{ type: "function", name: "list_tasks" }],
      { sessionId: "session-svad" },
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const payload = JSON.parse(fetchCall[1].body);
    const td = payload.turn_detection;

    expect(td.type).toBe("semantic_vad");
    expect(td.eagerness).toBe("low");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  3. Voice tool result handling (client-side logic validated structurally)
// ══════════════════════════════════════════════════════════════════════════════

describe("voice tool output normalization", () => {
  // These test the normalization logic that the voice-client uses.
  // We extract and validate the logic inline rather than requiring a browser env.

  function normalizeToolOutput(result) {
    let toolOutput = "";
    if (result.error) {
      toolOutput = `Tool error: ${result.error}`;
    } else if (result.result != null && result.result !== "") {
      toolOutput = typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result);
    } else {
      toolOutput = "Tool completed with no output";
    }
    const VOICE_TOOL_OUTPUT_MAX = 6000;
    if (toolOutput.length > VOICE_TOOL_OUTPUT_MAX) {
      toolOutput = toolOutput.slice(0, VOICE_TOOL_OUTPUT_MAX) +
        "\n... (truncated for voice — full result available in chat)";
    }
    return toolOutput;
  }

  it("handles normal string result", () => {
    const out = normalizeToolOutput({ result: "5 tasks found" });
    expect(out).toBe("5 tasks found");
  });

  it("handles empty string result without falling through to error", () => {
    const out = normalizeToolOutput({ result: "" });
    expect(out).toBe("Tool completed with no output");
    expect(out).not.toContain("error");
  });

  it("handles null result gracefully", () => {
    const out = normalizeToolOutput({ result: null });
    expect(out).toBe("Tool completed with no output");
  });

  it("handles object result by stringifying", () => {
    const out = normalizeToolOutput({ result: { count: 5, tasks: ["a", "b"] } });
    expect(out).toContain('"count":5');
    expect(out).toContain('"tasks"');
  });

  it("handles array result by stringifying", () => {
    const out = normalizeToolOutput({ result: [{ id: "1" }, { id: "2" }] });
    expect(out).toContain("[");
    expect(out).toContain('"id":"1"');
  });

  it("prefers error field when present", () => {
    const out = normalizeToolOutput({ error: "auth failed", result: "some data" });
    expect(out).toBe("Tool error: auth failed");
  });

  it("truncates very large outputs", () => {
    const largeResult = "x".repeat(10000);
    const out = normalizeToolOutput({ result: largeResult });
    expect(out.length).toBeLessThan(7000);
    expect(out).toContain("truncated for voice");
  });

  it("does NOT truncate normal-sized outputs", () => {
    const normalResult = "Here are your 5 tasks: ...";
    const out = normalizeToolOutput({ result: normalResult });
    expect(out).toBe(normalResult);
    expect(out).not.toContain("truncated");
  });

  // Regression: old code used `result.result || result.error || "No output"`
  // which failed on falsy values like empty string, 0, false
  it("does not use falsy-check pattern (regression)", () => {
    // The old `||` pattern would turn "" into error or "No output"
    const emptyOut = normalizeToolOutput({ result: "" });
    expect(emptyOut).not.toBe("No output");

    // The old pattern would turn 0 into error or "No output"
    const zeroOut = normalizeToolOutput({ result: 0 });
    // 0 is not null/undefined, so it should stringify
    expect(zeroOut).toBe("0");

    // false should also stringify
    const falseOut = normalizeToolOutput({ result: false });
    expect(falseOut).toBe("false");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  4. MCP Marketplace component scoping (importAgents not defined)
// ══════════════════════════════════════════════════════════════════════════════

describe("MCP marketplace scoping", () => {
  it("McpMarketplace loadData does not reference importAgents from outer scope", async () => {
    // Read the UI source and verify that McpMarketplace's loadData
    // does NOT contain the importAgents guard
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "ui/tabs/library.js"),
      "utf8",
    );

    // Find the McpMarketplace function body
    const mcpStart = src.indexOf("function McpMarketplace(");
    expect(mcpStart).toBeGreaterThan(-1);

    // Find the loadData callback within McpMarketplace
    const loadDataStart = src.indexOf("const loadData = useCallback(", mcpStart);
    expect(loadDataStart).toBeGreaterThan(-1);

    // Find the closing of the useCallback (next `}, [])`)
    const loadDataEnd = src.indexOf("}, []);", loadDataStart);
    expect(loadDataEnd).toBeGreaterThan(-1);

    const loadDataBody = src.slice(loadDataStart, loadDataEnd);

    // Must NOT reference importAgents/importPrompts/importSkills/importTools
    // These belong to other component scopes
    expect(loadDataBody).not.toContain("importAgents");
    expect(loadDataBody).not.toContain("importPrompts");
    expect(loadDataBody).not.toContain("importSkills");
    expect(loadDataBody).not.toContain("importTools");
  });

  it("site/ui McpMarketplace also has no importAgents guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "site/ui/tabs/library.js"),
      "utf8",
    );

    const mcpStart = src.indexOf("function McpMarketplace(");
    expect(mcpStart).toBeGreaterThan(-1);

    const loadDataStart = src.indexOf("const loadData = useCallback(", mcpStart);
    expect(loadDataStart).toBeGreaterThan(-1);

    const loadDataEnd = src.indexOf("}, []);", loadDataStart);
    expect(loadDataEnd).toBeGreaterThan(-1);

    const loadDataBody = src.slice(loadDataStart, loadDataEnd);

    expect(loadDataBody).not.toContain("importAgents");
    expect(loadDataBody).not.toContain("importPrompts");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  5. Library search API wiring
// ══════════════════════════════════════════════════════════════════════════════

describe("library search infrastructure", () => {
  it("fetchEntries passes search query to API", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "ui/tabs/library.js"),
      "utf8",
    );

    // Verify fetchEntries reads searchQuery and passes it as ?search= param
    const fetchStart = src.indexOf("async function fetchEntries(");
    expect(fetchStart).toBeGreaterThan(-1);

    const fetchEnd = src.indexOf("}", fetchStart + 100);
    const fetchBody = src.slice(fetchStart, fetchEnd);

    // Must read searchQuery signal
    expect(fetchBody).toContain("searchQuery");
    // Must set search param
    expect(fetchBody).toContain('params.set("search"');
  });

  it("server-side listEntries filters by search query", async () => {
    const { listEntries } = await import(
      "../infra/library-manager.mjs"
    );
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tmp = mkdtempSync(join(tmpdir(), "lib-search-"));
    mkdirSync(resolve(tmp, ".bosun"), { recursive: true });

    // Create a manifest at the correct path (.bosun/library.json)
    const manifestPath = resolve(tmp, ".bosun", "library.json");
    const manifest = {
      version: 1,
      entries: [
        { id: "test-skill-1", name: "Code Review Expert", type: "skill", description: "Reviews code", tags: ["review"], source: "builtin" },
        { id: "test-agent-1", name: "Debug Agent", type: "agent", description: "Debugs issues", tags: ["debug"], source: "builtin" },
        { id: "test-prompt-1", name: "TDD Prompt", type: "prompt", description: "Test-driven development", tags: ["tdd"], source: "builtin" },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const allEntries = listEntries(tmp);
    // With no search, all entries should be returned (at least the 3 we added + builtins)
    expect(allEntries.length).toBeGreaterThanOrEqual(3);

    // Search by name
    const reviewResults = listEntries(tmp, { search: "Review" });
    const reviewNames = reviewResults.map((e) => e.name);
    expect(reviewNames).toContain("Code Review Expert");
    // Debug Agent should NOT match "Review"
    expect(reviewNames).not.toContain("Debug Agent");

    // Search by tag
    const tddResults = listEntries(tmp, { search: "tdd" });
    expect(tddResults.some((e) => e.id === "test-prompt-1")).toBe(true);

    // Search by description
    const debugResults = listEntries(tmp, { search: "Debugs" });
    expect(debugResults.some((e) => e.id === "test-agent-1")).toBe(true);

    // Empty search returns all
    const emptyResults = listEntries(tmp, { search: "" });
    expect(emptyResults.length).toBe(allEntries.length);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  6. Voice agent profile tools configuration
// ══════════════════════════════════════════════════════════════════════════════

describe("voice agent profile tool configuration", () => {
  it("enabledTools: null means all tools pass through filter", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    // Verify voice-agent-female profile has enabledTools: null
    const src = readFileSync(
      resolve(process.cwd(), "infra/library-manager.mjs"),
      "utf8",
    );
    const profileStart = src.indexOf('"voice-agent-female"');
    expect(profileStart).toBeGreaterThan(-1);

    const profileChunk = src.slice(profileStart, profileStart + 1200);
    expect(profileChunk).toContain("enabledTools: null");
    expect(profileChunk).toContain("voiceInstructions:");
  });

  it("voice-agent-female has voiceInstructions with a persona name", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "infra/library-manager.mjs"),
      "utf8",
    );
    const profileStart = src.indexOf('"voice-agent-female"');
    const profileChunk = src.slice(profileStart, profileStart + 1200);

    // Must contain a persona name (not defaulting to "ChatGPT")
    expect(profileChunk).toContain("You are Nova");
    // The voiceInstructions may mention ChatGPT in a negative context
    // ("You are NOT ChatGPT"), which is correct — it reinforces the persona.
    expect(profileChunk).toContain("NOT ChatGPT");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  7. UI mirroring — voice-client tool output normalization
// ══════════════════════════════════════════════════════════════════════════════

describe("voice-client UI mirroring", () => {
  it("both ui/ and site/ui/ voice-client use null-safe tool output", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const uiDir of ["ui", "site/ui"]) {
      const src = readFileSync(
        resolve(process.cwd(), uiDir, "modules/voice-client.js"),
        "utf8",
      );

      // Must NOT use the old falsy pattern
      expect(src).not.toContain('result.result || result.error || "No output"');

      // Must use proper null check
      expect(src).toContain("result.result != null");

      // Must have truncation logic
      expect(src).toContain("VOICE_TOOL_OUTPUT_MAX");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  8. Validation.lint handles empty command gracefully
// ══════════════════════════════════════════════════════════════════════════════

describe("validation.lint empty command handling", () => {
  it("lint node type handles empty/missing command without shell errors", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "workflow/workflow-nodes/validation.mjs"),
      "utf8",
    );

    // Must check for empty command
    expect(src).toMatch(/String\(command \|\| ""\)\.trim\(\)/);

    // Must return passed: true when command is empty (skip, not fail)
    expect(src).toContain("passed: true");
    expect(src).toContain('reason: "skipped"');
    expect(src).toContain("Validation skipped: no command configured.");
  });
});
