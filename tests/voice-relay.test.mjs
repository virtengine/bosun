import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock external boundaries ────────────────────────────────────────────────

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    voice: {},
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

// Prevent real shared auth state on disk from leaking into tests
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

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      client_secret: { value: "test-token", expires_at: Date.now() / 1000 + 60 },
    }),
    text: async () => "ok",
  }));
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  vi.restoreAllMocks();
});

// ── Fresh imports per test (avoid cross-file module cache leaks) ────────────

let loadConfig;
let resolveSharedOAuthToken;
let beginVoiceTurnTrace;
let completeVoiceTurnTrace;
let abortVoiceTurnTrace;
let getVoiceTurnTrace;
let renderVoiceTurnTrace;
let formatVoiceTurnTrace;
let getVoiceConfig;
let isVoiceAvailable;
let createEphemeralToken;
let getVoiceToolDefinitions;
let getSessionAllowedTools;
let executeVoiceTool;
let getRealtimeConnectionInfo;
let analyzeVisionFrame;
let dispatchVoiceActionIntent;
let clearVisionSessionState;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("voice-relay", () => {
  // Reset env before each test
  const envKeys = [
    "OPENAI_API_KEY",
    "OPENAI_REALTIME_API_KEY",
    "OPENAI_OAUTH_ACCESS_TOKEN",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AZURE_OPENAI_ACCESS_TOKEN",
    "VOICE_PROVIDER",
    "VOICE_TURN_DETECTION",
    "VOICE_PROVIDERS",
    "VOICE_MODEL",
    "VOICE_VISION_MODEL",
    "VOICE_ID",
    "VOICE_FAILOVER_MAX_ATTEMPTS",
    "AZURE_OPENAI_REALTIME_ENDPOINT",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_REALTIME_API_KEY",
    "AZURE_OPENAI_REALTIME_DEPLOYMENT",
    "AZURE_OPENAI_ENDPOINT",
  ];
  const savedEnv = {};

  beforeEach(async () => {
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }

    vi.resetModules();

    ({ loadConfig } = await import("../config/config.mjs"));
    ({ resolveSharedOAuthToken } = await import("../agent/provider-auth-state.mjs"));
    ({
      beginVoiceTurnTrace,
      completeVoiceTurnTrace,
      abortVoiceTurnTrace,
      getVoiceTurnTrace,
      renderVoiceTurnTrace,
      formatVoiceTurnTrace,
      getVoiceConfig,
      isVoiceAvailable,
      createEphemeralToken,
      getVoiceToolDefinitions,
      getSessionAllowedTools,
      executeVoiceTool,
      getRealtimeConnectionInfo,
      analyzeVisionFrame,
      dispatchVoiceActionIntent,
    } = await import("../voice/voice-relay.mjs"));
    ({ clearVisionSessionState } = await import("../voice/vision-session-state.mjs"));

    // Reset config mock to default
    vi.mocked(loadConfig).mockReturnValue({
      voice: {},
      primaryAgent: "codex-sdk",
    });
  });

  afterEach(() => {
    clearVisionSessionState?.("primary-1");
    clearVisionSessionState?.("primary-claude-1");
    clearVisionSessionState?.("primary-gemini-1");
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("voice turn trace diagnostics", () => {
    it("records interrupted turns without leaking auth-sensitive values", () => {
      beginVoiceTurnTrace("voice-trace-interrupt", {
        turnId: "turn-interrupt-1",
        transport: "webrtc",
        authorization: "Bearer top-secret-token",
      });

      abortVoiceTurnTrace("voice-trace-interrupt", "transport-interrupted", {
        turnId: "turn-interrupt-1",
        category: "transport",
        authToken: "sk-live-secret",
        closeCode: 1011,
      });

      const trace = getVoiceTurnTrace("voice-trace-interrupt");
      const replay = renderVoiceTurnTrace("voice-trace-interrupt");
      const serialized = JSON.stringify(trace);

      expect(serialized).not.toContain("top-secret-token");
      expect(serialized).not.toContain("sk-live-secret");
      expect(replay).toContain("transport-interrupted");
      expect(replay).toContain("transport issue");
    });

    it("formats dispatch mismatches for replay", () => {
      beginVoiceTurnTrace("voice-trace-mismatch", {
        turnId: "turn-mismatch-1",
        transport: "webrtc",
      });

      abortVoiceTurnTrace("voice-trace-mismatch", "response-action-mismatch", {
        turnId: "turn-mismatch-1",
        category: "dispatch-mismatch",
        expected: "tool:dispatch_action",
        actual: "transport:response.done",
      });
      completeVoiceTurnTrace("voice-trace-mismatch", { turnId: "turn-mismatch-1", status: "aborted" });

      const replay = renderVoiceTurnTrace("voice-trace-mismatch");

      expect(replay).toContain("dispatch mismatch");
      expect(replay).toContain("tool:dispatch_action");
      expect(replay).toContain("transport:response.done");
    });
  });

  // ── getVoiceConfig ──────────────────────────────────────────

  describe("getVoiceConfig", () => {
    it("returns correct defaults when no config or env set", () => {
      const cfg = getVoiceConfig(true);
      expect(cfg.provider).toBe("fallback");
      expect(cfg.model).toBe("gpt-realtime-1.5");
      expect(cfg.voiceId).toBe("alloy");
      expect(cfg.turnDetection).toBe("semantic_vad");
      expect(cfg.fallbackMode).toBe("browser");
      expect(cfg.enabled).toBe(true);
      expect(cfg.delegateExecutor).toBe("codex-sdk");
      expect(cfg.openaiKey).toBe("");
      expect(cfg.azureKey).toBe("");
      expect(cfg.claudeKey).toBe("");
      expect(cfg.geminiKey).toBe("");
    });

    it("uses config.voice properties when set", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "openai",
          model: "custom-model",
          voiceId: "nova",
          openaiApiKey: "sk-from-config",
          turnDetection: "semantic_vad",
          fallbackMode: "disabled",
          delegateExecutor: "claude-sdk",
        },
        primaryAgent: "codex-sdk",
      });
      const cfg = getVoiceConfig(true);
      expect(cfg.provider).toBe("openai");
      expect(cfg.model).toBe("custom-model");
      expect(cfg.voiceId).toBe("nova");
      expect(cfg.openaiKey).toBe("sk-from-config");
      expect(cfg.turnDetection).toBe("semantic_vad");
      expect(cfg.fallbackMode).toBe("disabled");
      expect(cfg.delegateExecutor).toBe("claude-sdk");
    });

    it("uses env vars when config is empty", () => {
      process.env.OPENAI_API_KEY = "sk-from-env";
      process.env.VOICE_PROVIDER = "openai";
      process.env.VOICE_MODEL = "env-model";
      process.env.VOICE_ID = "echo";
      const cfg = getVoiceConfig(true);
      expect(cfg.provider).toBe("openai");
      expect(cfg.model).toBe("env-model");
      expect(cfg.openaiKey).toBe("sk-from-env");
      expect(cfg.voiceId).toBe("echo");
    });

    it("prefers dedicated realtime env keys over generic API keys", () => {
      process.env.OPENAI_API_KEY = "sk-generic";
      process.env.OPENAI_REALTIME_API_KEY = "sk-realtime";
      process.env.AZURE_OPENAI_API_KEY = "az-generic";
      process.env.AZURE_OPENAI_REALTIME_API_KEY = "az-realtime";
      const cfg = getVoiceConfig(true);
      expect(cfg.openaiKey).toBe("sk-realtime");
      expect(cfg.azureKey).toBe("az-realtime");
    });

    it("auto provider prefers claude when Anthropic key is available and OpenAI/Azure are missing", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const cfg = getVoiceConfig(true);
      expect(cfg.provider).toBe("claude");
      expect(cfg.claudeKey).toBe("sk-ant-test");
    });

    it("auto provider resolves to gemini when Gemini key is available and OpenAI/Azure/Claude are missing", () => {
      process.env.GEMINI_API_KEY = "gemini-test-key";
      const cfg = getVoiceConfig(true);
      expect(cfg.provider).toBe("gemini");
      expect(cfg.geminiKey).toBe("gemini-test-key");
    });

    it("caches result and returns same object within TTL", () => {
      const first = getVoiceConfig(true);
      // Change config — but cached version should be returned
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "azure" },
        primaryAgent: "codex-sdk",
      });
      const second = getVoiceConfig(); // no forceReload
      expect(second).toBe(first);
    });

    it("forceReload bypasses cache", () => {
      const first = getVoiceConfig(true);
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "azure", azureApiKey: "az-key", azureEndpoint: "https://az.endpoint" },
        primaryAgent: "codex-sdk",
      });
      const second = getVoiceConfig(true);
      expect(second).not.toBe(first);
      expect(second.provider).toBe("azure");
    });
  });

  // ── isVoiceAvailable ────────────────────────────────────────

  describe("isVoiceAvailable", () => {
    it("returns tier 1 for openai provider with key", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      const result = isVoiceAvailable();
      // Force reload so new config takes effect
      getVoiceConfig(true);
      const result2 = isVoiceAvailable();
      expect(result2.available).toBe(true);
      expect(result2.tier).toBe(1);
      expect(result2.provider).toBe("openai");
    });

    it("returns tier 1 for azure provider with key and endpoint", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          azureApiKey: "az-key",
          azureEndpoint: "https://my.azure.com",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const result = isVoiceAvailable();
      expect(result.available).toBe(true);
      expect(result.tier).toBe(1);
      expect(result.provider).toBe("azure");
    });

    it("returns tier 2 fallback when no API keys configured", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {},
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const result = isVoiceAvailable();
      expect(result.available).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.provider).toBe("fallback");
    });

    it("returns tier 2 Claude mode when provider is claude and key is set", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "claude", claudeApiKey: "sk-ant-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const result = isVoiceAvailable();
      expect(result.available).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.provider).toBe("claude");
    });

    it("returns tier 2 Gemini mode when provider is gemini and key is set", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "gemini", geminiApiKey: "gemini-test-key" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const result = isVoiceAvailable();
      expect(result.available).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.provider).toBe("gemini");
    });

    it("returns unavailable when voice is disabled", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { enabled: false },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const result = isVoiceAvailable();
      expect(result.available).toBe(false);
      expect(result.tier).toBeNull();
      expect(result.reason).toMatch(/disabled/i);
    });
  });

  // ── createEphemeralToken ────────────────────────────────────

  describe("createEphemeralToken", () => {
    it("calls OpenAI API correctly for openai provider", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const result = await createEphemeralToken([]);
      expect(result.token).toBe("test-token");
      expect(result.provider).toBe("openai");
      expect(result.voiceId).toBe("alloy");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("api.openai.com/v1/realtime/sessions");
      expect(fetchCall[1].headers.Authorization).toBe("Bearer sk-test");
      const payload = JSON.parse(fetchCall[1].body);
      expect(payload.tool_choice).toBe("auto");
    });

    it("calls Azure API correctly for azure provider (preview deployment)", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          azureApiKey: "az-key",
          azureEndpoint: "https://myresource.openai.azure.com",
          azureDeployment: "gpt-4o-realtime-preview",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const result = await createEphemeralToken([]);
      expect(result.token).toBe("test-token");
      expect(result.provider).toBe("azure");

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("myresource.openai.azure.com");
      expect(fetchCall[0]).toContain("realtimeapi/sessions");
      expect(fetchCall[1].headers["api-key"]).toBe("az-key");
      // Preview protocol must NOT include type: "realtime" (causes 400)
      expect(JSON.parse(fetchCall[1].body).type).toBeUndefined();
    });

    it("calls Azure GA API correctly for GA model (gpt-realtime-1.5)", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          azureApiKey: "az-key",
          azureEndpoint: "https://myresource.openai.azure.com",
          azureDeployment: "gpt-realtime-1.5",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const result = await createEphemeralToken([]);
      expect(result.token).toBe("test-token");
      expect(result.provider).toBe("azure");

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("myresource.openai.azure.com");
      expect(fetchCall[0]).toContain("openai/v1/realtime/sessions");
      expect(fetchCall[0]).toContain("api-version=2025-04-01-preview");
      expect(fetchCall[1].headers["api-key"]).toBe("az-key");
      // GA protocol requires type: "realtime" in the session POST body
      const body = JSON.parse(fetchCall[1].body);
      expect(body.type).toBe("realtime");
    });

    it("uses per-endpoint credentials from voiceEndpoints config", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          voiceEndpoints: [
            {
              name: "foundry-us",
              provider: "azure",
              endpoint: "https://foundry.openai.azure.com",
              deployment: "gpt-realtime-1.5",
              apiKey: "ep-specific-key",
              role: "primary",
              enabled: true,
            },
          ],
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const result = await createEphemeralToken([]);
      expect(result.token).toBe("test-token");
      expect(result.provider).toBe("azure");

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[0]).toContain("foundry.openai.azure.com");
      expect(fetchCall[0]).toContain("openai/v1/realtime/sessions");
      expect(fetchCall[0]).toContain("api-version=2025-04-01-preview");
      expect(fetchCall[1].headers["api-key"]).toBe("ep-specific-key");
      // GA deployment — must have type: "realtime"
      expect(JSON.parse(fetchCall[1].body).type).toBe("realtime");
    });

    it("injects call context into realtime session instructions", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const result = await createEphemeralToken([
        { type: "function", name: "delegate_to_agent" },
      ], {
        sessionId: "primary-123",
        executor: "claude-sdk",
        mode: "plan",
        model: "claude-opus-4.6",
      });
      expect(result.callContext).toMatchObject({
        sessionId: "primary-123",
        executor: "claude-sdk",
        mode: "plan",
        model: "claude-opus-4.6",
      });

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const payload = JSON.parse(fetchCall[1].body);
      expect(payload.instructions).toContain("Active chat session id: primary-123.");
      expect(payload.instructions).toContain("Preferred executor for delegated work: claude-sdk.");
      expect(payload.instructions).toContain("Preferred delegation mode: plan.");
      expect(payload.instructions).toContain("Preferred model override: claude-opus-4.6.");
      // tool_choice is now always "auto" — the model picks the right tool
      expect(payload.tool_choice).toBe("auto");
    });

    it("throws when no API key configured for openai", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      await expect(createEphemeralToken()).rejects.toThrow(/unavailable|not configured/i);
    });

    it("prefers OpenAI OAuth token over API key when both are present", async () => {
      vi.mocked(resolveSharedOAuthToken).mockImplementation((provider) =>
        provider === "openai" ? { token: "oauth-openai-token" } : null,
      );
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      await createEphemeralToken([]);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toBe("Bearer oauth-openai-token");
    });

    it("fails over from OpenAI to Azure when realtime auth fails", async () => {
      process.env.OPENAI_REALTIME_API_KEY = "sk-openai-bad";
      process.env.AZURE_OPENAI_REALTIME_API_KEY = "az-key";
      process.env.AZURE_OPENAI_REALTIME_ENDPOINT = "https://myresource.openai.azure.com";
      process.env.VOICE_PROVIDERS = "openai,azure";
      process.env.VOICE_FAILOVER_MAX_ATTEMPTS = "2";

      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "openai",
          azureDeployment: "gpt-4o-realtime-preview",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      vi.mocked(globalThis.fetch)
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => '{"error":"invalid_api_key"}',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            client_secret: { value: "azure-fallback-token", expires_at: Date.now() / 1000 + 60 },
          }),
          text: async () => "ok",
        });

      const result = await createEphemeralToken([]);
      expect(result.provider).toBe("azure");
      expect(result.token).toBe("azure-fallback-token");
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
      const secondCall = vi.mocked(globalThis.fetch).mock.calls[1];
      expect(secondCall[0]).toContain("myresource.openai.azure.com");
    });

    it("throws for non-realtime providers", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "claude", claudeApiKey: "sk-ant-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      await expect(createEphemeralToken([])).rejects.toThrow(/unavailable for provider "claude"/i);
    });

    it("redacts credentials from realtime error payloads", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Incorrect API key provided: sk-super-secret","authorization":"Bearer sk-super-secret","api_key":"sk-super-secret"}}',
      });

      let message = "";
      try {
        await createEphemeralToken([]);
      } catch (err) {
        message = String(err?.message || "");
      }
      expect(message).toMatch(/REDACTED/);
      expect(message).not.toMatch(/sk-super-secret/);
    });
  });

  // ── getRealtimeConnectionInfo ───────────────────────────────

  describe("getRealtimeConnectionInfo", () => {
    it("returns OpenAI URL for openai provider", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const info = getRealtimeConnectionInfo();
      expect(info.provider).toBe("openai");
      expect(info.url).toContain("api.openai.com/v1/realtime");
      expect(info.model).toBe("gpt-realtime-1.5");
    });

    it("returns Azure preview URL for preview deployment", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          azureApiKey: "az-key",
          azureEndpoint: "https://myresource.openai.azure.com",
          azureDeployment: "gpt-4o-realtime-preview",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const info = getRealtimeConnectionInfo();
      expect(info.provider).toBe("azure");
      expect(info.url).toContain("myresource.openai.azure.com");
      expect(info.url).toContain("deployment=gpt-4o-realtime-preview");
      expect(info.model).toBe("gpt-4o-realtime-preview");
    });

    it("returns Azure GA URL for GA deployment (gpt-realtime-1.5)", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "azure",
          azureApiKey: "az-key",
          azureEndpoint: "https://myresource.openai.azure.com",
          azureDeployment: "gpt-realtime-1.5",
        },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);

      const info = getRealtimeConnectionInfo();
      expect(info.provider).toBe("azure");
      expect(info.url).toBe("https://myresource.openai.azure.com/openai/v1/realtime?api-version=2025-04-01-preview");
      expect(info.model).toBe("gpt-realtime-1.5");
    });

    it("returns tier-2 metadata for claude provider", () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "claude", claudeApiKey: "sk-ant-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      const info = getRealtimeConnectionInfo();
      expect(info.provider).toBe("claude");
      expect(info.url).toBeNull();
      expect(info.tier).toBe(2);
    });
  });

  // ── executeVoiceTool ────────────────────────────────────────

  describe("executeVoiceTool", () => {
    it("delegates to voice-tools executeToolCall", async () => {
      const result = await executeVoiceTool("list_tasks", {});
      expect(result.result).toContain("mock result for list_tasks");
    });
  });

  // ── getSessionAllowedTools ───────────────────────────────────

  describe("getSessionAllowedTools", () => {
    it("returns a Set of allowed tool names", () => {
      const allowed = getSessionAllowedTools();
      expect(allowed).toBeInstanceOf(Set);
      expect(allowed.has("get_admin_help")).toBe(true);
      expect(allowed.has("delegate_to_agent")).toBe(true);
      expect(allowed.has("list_tasks")).toBe(true);
      expect(allowed.has("get_agent_status")).toBe(true);
      expect(allowed.has("get_session_history")).toBe(true);
      expect(allowed.has("create_workflow")).toBe(true);
      expect(allowed.has("update_workflow_definition")).toBe(true);
      expect(allowed.has("execute_workflow")).toBe(true);
      expect(allowed.has("list_workflow_runs")).toBe(true);
      expect(allowed.has("get_workflow_run")).toBe(true);
      expect(allowed.has("analyze_workflow")).toBe(true);
    });

    it("does not include write-heavy tools", () => {
      const allowed = getSessionAllowedTools();
      // Base set excludes run_workspace_command (owner-only)
      expect(allowed.has("run_workspace_command")).toBe(false);
    });
  });

  // ── getVoiceToolDefinitions ─────────────────────────────────

  describe("getVoiceToolDefinitions", () => {
    it("returns array of tool definitions", async () => {
      const defs = await getVoiceToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
      expect(defs[0]).toHaveProperty("name");
    });

    it("filters to session-allowed tools when delegateOnly is true", async () => {
      const defs = await getVoiceToolDefinitions({ delegateOnly: true });
      expect(Array.isArray(defs)).toBe(true);
      // The mock only has list_tasks and delegate_to_agent, both are in the allowed set
      expect(defs.length).toBeGreaterThanOrEqual(1);
      const names = defs.map((d) => d.name);
      expect(names).toContain("delegate_to_agent");
    });
  });

  describe("turn trace diagnostics", () => {
    it("formats interrupted turns as transport issues", () => {
      const turn = beginVoiceTurnTrace("relay-trace-transport", {
        transport: "webrtc",
        phase: "user_speech",
      });

      abortVoiceTurnTrace("relay-trace-transport", "transport_interrupted", {
        turnId: turn.turnId,
        authToken: "secret-token",
        detail: "socket closed",
      });

      const trace = getVoiceTurnTrace("relay-trace-transport");
      expect(trace?.turns).toHaveLength(1);

      const replay = formatVoiceTurnTrace("relay-trace-transport");
      expect(replay).toContain("transport issue");
      expect(replay).toContain("transport_interrupted");
      expect(replay).not.toContain("secret-token");
    });

    it("replays action mismatches separately from transport failures", async () => {
      const result = await dispatchVoiceActionIntent(
        {
          action: "missing.action",
          params: { authorization: "Bearer top-secret" },
        },
        { sessionId: "relay-trace-mismatch", traceTurns: true },
      );
      expect(result.ok).toBe(false);

      const replay = formatVoiceTurnTrace("relay-trace-mismatch");
      expect(replay).toContain("dispatch mismatch");
      expect(replay).toContain("unknown_action");
      expect(replay).not.toContain("top-secret");
    });
  });
  describe("analyzeVisionFrame", () => {
    it("calls OpenAI responses API for valid frame input", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output_text: "Code editor with failing tests is visible.",
        }),
      });

      const result = await analyzeVisionFrame(
        "data:image/jpeg;base64,dGVzdA==",
        { source: "screen", context: { sessionId: "primary-1" } },
      );
      expect(result.summary).toContain("failing tests");
      expect(result.provider).toBe("openai");
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls.at(-1);
      expect(fetchCall?.[0]).toContain("/v1/responses");
    });

    it("calls Anthropic Messages API when provider is claude", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "claude",
          claudeApiKey: "sk-ant-test",
          visionModel: "claude-3-7-sonnet-latest",
        },
        primaryAgent: "claude-sdk",
      });
      getVoiceConfig(true);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Terminal shows a failing lint check." }],
        }),
      });

      const result = await analyzeVisionFrame(
        "data:image/png;base64,dGVzdA==",
        { source: "screen", context: { sessionId: "primary-claude-1" } },
      );
      expect(result.provider).toBe("claude");
      expect(result.summary).toContain("failing lint");
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls.at(-1);
      expect(fetchCall?.[0]).toContain("api.anthropic.com/v1/messages");
    });

    it("calls Gemini generateContent API when provider is gemini", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: {
          provider: "gemini",
          geminiApiKey: "gemini-test-key",
          visionModel: "gemini-2.5-flash",
        },
        primaryAgent: "gemini-sdk",
      });
      getVoiceConfig(true);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: "Code editor and test runner are both visible." }],
              },
            },
          ],
        }),
      });

      const result = await analyzeVisionFrame(
        "data:image/webp;base64,dGVzdA==",
        { source: "camera", context: { sessionId: "primary-gemini-1" } },
      );
      expect(result.provider).toBe("gemini");
      expect(result.summary).toContain("test runner");
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls.at(-1);
      expect(fetchCall?.[0]).toContain("generativelanguage.googleapis.com/v1beta/models/");
      expect(fetchCall?.[0]).toContain(":generateContent");
    });

    it("redacts credentials from vision provider errors", async () => {
      vi.mocked(loadConfig).mockReturnValue({
        voice: { provider: "openai", openaiApiKey: "sk-test" },
        primaryAgent: "codex-sdk",
      });
      getVoiceConfig(true);
      vi.mocked(globalThis.fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"message":"Incorrect API key provided: sk-top-secret","api_key":"sk-top-secret"}',
      });

      let message = "";
      try {
        await analyzeVisionFrame("data:image/jpeg;base64,dGVzdA==", {
          source: "screen",
          context: { sessionId: "primary-1" },
        });
      } catch (err) {
        message = String(err?.message || "");
      }
      expect(message).toMatch(/REDACTED/);
      expect(message).not.toMatch(/sk-top-secret/);
    });
  });
});


