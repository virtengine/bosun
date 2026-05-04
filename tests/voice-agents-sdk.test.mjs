import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock external boundaries ────────────────────────────────────────────────

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    voice: {},
    primaryAgent: "codex-sdk",
  })),
}));

vi.mock("../agent/provider-auth-state.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveSharedOAuthToken: vi.fn(() => null),
  };
});

// ── Mock @openai/agents/realtime ────────────────────────────────────────────

const mockRealtimeAgent = vi.fn(function MockRealtimeAgent(opts) {
  this.name = opts?.name || "test-agent";
  this.instructions = opts?.instructions || "";
  this.tools = opts?.tools || [];
});

const mockRealtimeSession = vi.fn(function MockRealtimeSession(agent, config) {
  this.agent = agent;
  this.config = config;
  this.connect = vi.fn(async () => {});
  this.close = vi.fn();
  this.on = vi.fn();
});

vi.mock("@openai/agents/realtime", () => ({
  RealtimeAgent: mockRealtimeAgent,
  RealtimeSession: mockRealtimeSession,
  VERSION: "0.1.0-test",
}));

// ── Mock @google/genai ──────────────────────────────────────────────────────

const mockGoogleGenAI = vi.fn(function MockGoogleGenAI() {
  this.aio = {
    live: {
      connect: vi.fn(async () => ({
        send: vi.fn(),
        close: vi.fn(),
      })),
    },
  };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: mockGoogleGenAI,
  VERSION: "0.1.0-test",
}));

// ── Import module under test ────────────────────────────────────────────────

const {
  checkSdkAvailability,
  getAllSdkCapabilities,
  convertToolsForAgentsSdk,
  createOpenAIRealtimeAgent,
  createRealtimeSession,
  connectRealtimeSession,
  createGeminiLiveSession,
  createSdkVoiceSession,
  resolveBestVoiceSession,
  getClientSdkConfig,
  getSdkDiagnostics,
} = await import("../voice/voice-agents-sdk.mjs");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("voice-agents-sdk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── checkSdkAvailability ────────────────────────────────────

  describe("checkSdkAvailability", () => {
    it("reports openai as available when @openai/agents loads", async () => {
      const result = await checkSdkAvailability("openai");
      expect(result.available).toBe(true);
      expect(result.info.name).toBe("openai");
      expect(result.info.transport).toBe("webrtc");
      expect(result.info.tier).toBe(1);
    });

    it("reports azure as available when @openai/agents loads", async () => {
      const result = await checkSdkAvailability("azure");
      expect(result.available).toBe(true);
      expect(result.info.name).toBe("azure");
    });

    it("reports gemini as available when @google/genai loads", async () => {
      const result = await checkSdkAvailability("gemini");
      expect(result.available).toBe(true);
      expect(result.info.name).toBe("gemini");
      expect(result.info.transport).toBe("websocket");
    });

    it("reports claude as unavailable (no native voice SDK)", async () => {
      const result = await checkSdkAvailability("claude");
      expect(result.available).toBe(false);
      expect(result.reason).toContain("No native voice SDK");
      expect(result.fallbackTo).toBe("bosun-legacy");
    });

    it("reports fallback as unavailable", async () => {
      const result = await checkSdkAvailability("fallback");
      expect(result.available).toBe(false);
      expect(result.fallbackTo).toBe("bosun-legacy");
    });

    it("handles unknown provider gracefully", async () => {
      const result = await checkSdkAvailability("unknown-provider");
      expect(result.available).toBe(false);
    });

    it("handles empty provider string", async () => {
      const result = await checkSdkAvailability("");
      expect(result.available).toBe(false);
    });
  });

  // ── getAllSdkCapabilities ───────────────────────────────────

  describe("getAllSdkCapabilities", () => {
    it("returns capabilities for all known providers", async () => {
      const caps = await getAllSdkCapabilities();
      expect(Object.keys(caps)).toEqual(
        expect.arrayContaining(["openai", "azure", "gemini", "claude", "fallback"]),
      );
      expect(caps.openai.available).toBe(true);
      expect(caps.azure.available).toBe(true);
      expect(caps.gemini.available).toBe(true);
      expect(caps.claude.available).toBe(false);
      expect(caps.fallback.available).toBe(false);
    });
  });

  // ── convertToolsForAgentsSdk ───────────────────────────────

  describe("convertToolsForAgentsSdk", () => {
    it("converts Bosun tool definitions to Agents SDK format", () => {
      const bosunTools = [
        { type: "function", name: "list_tasks", description: "List tasks", parameters: { type: "object", properties: {} } },
        { type: "function", name: "delegate_to_agent", description: "Delegate work" },
      ];
      const result = convertToolsForAgentsSdk(bosunTools);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("list_tasks");
      expect(result[0].description).toBe("List tasks");
      expect(result[1].name).toBe("delegate_to_agent");
      expect(result[1].parameters).toEqual({ type: "object", properties: {} });
    });

    it("returns empty array for non-array input", () => {
      expect(convertToolsForAgentsSdk(null)).toEqual([]);
      expect(convertToolsForAgentsSdk(undefined)).toEqual([]);
      expect(convertToolsForAgentsSdk("not-array")).toEqual([]);
    });
  });

  // ── createOpenAIRealtimeAgent ──────────────────────────────

  describe("createOpenAIRealtimeAgent", () => {
    it("creates a RealtimeAgent with default instructions", async () => {
      const result = await createOpenAIRealtimeAgent({ enrichInstructions: false });
      expect(result).not.toBeNull();
      expect(result.agent).toBeDefined();
      expect(result.provider).toBe("openai");
      expect(mockRealtimeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Bosun Voice Agent",
        }),
      );
    });

    it("passes custom instructions and tools", async () => {
      const tools = [{ type: "function", name: "test_tool" }];
      const result = await createOpenAIRealtimeAgent({
        name: "Custom Agent",
        instructions: "Custom instructions",
        tools,
        enrichInstructions: false,
      });
      expect(result.agent).toBeDefined();
      expect(mockRealtimeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Custom Agent",
          instructions: "Custom instructions",
          tools,
        }),
      );
    });
  });

  // ── createRealtimeSession ──────────────────────────────────

  describe("createRealtimeSession", () => {
    it("creates a session with correct model and voice config", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(
        agentResult.agent,
        "openai",
        { model: "gpt-realtime-1.5", voiceId: "nova" },
      );
      expect(sessionHandle.session).toBeDefined();
      expect(sessionHandle.provider).toBe("openai");
      expect(sessionHandle.model).toBe("gpt-realtime-1.5");
      expect(sessionHandle.voiceId).toBe("nova");
    });

    it("uses defaults when config is empty", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(
        agentResult.agent,
        "azure",
        {},
      );
      expect(sessionHandle.model).toBe("gpt-realtime-1.5");
      expect(sessionHandle.voiceId).toBe("alloy");
      expect(sessionHandle.provider).toBe("azure");
    });
  });

  // ── connectRealtimeSession ─────────────────────────────────

  describe("connectRealtimeSession", () => {
    it("connects with OpenAI credentials", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(agentResult.agent, "openai", {});
      await connectRealtimeSession(sessionHandle, { openaiKey: "sk-test-key" });
      expect(sessionHandle.session.connect).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "sk-test-key" }),
      );
    });

    it("connects with Azure credentials and URL", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(agentResult.agent, "azure", {});
      await connectRealtimeSession(sessionHandle, {
        azureKey: "az-test-key",
        azureEndpoint: "https://my-az.openai.azure.com",
        azureDeployment: "gpt-realtime-1.5",
      });
      expect(sessionHandle.session.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: "az-test-key",
          url: expect.stringContaining("my-az.openai.azure.com"),
        }),
      );
    });

    it("throws when OpenAI credential is missing", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(agentResult.agent, "openai", {});
      await expect(
        connectRealtimeSession(sessionHandle, {}),
      ).rejects.toThrow(/credential not configured/i);
    });

    it("throws when Azure credential is missing", async () => {
      const agentResult = await createOpenAIRealtimeAgent();
      const sessionHandle = await createRealtimeSession(agentResult.agent, "azure", {});
      await expect(
        connectRealtimeSession(sessionHandle, {}),
      ).rejects.toThrow(/credential not configured/i);
    });
  });

  // ── createGeminiLiveSession ────────────────────────────────

  describe("createGeminiLiveSession", () => {
    it("creates a Gemini Live session with API key", async () => {
      const result = await createGeminiLiveSession({
        geminiKey: "test-gemini-key",
      });
      expect(result).not.toBeNull();
      expect(result.provider).toBe("gemini");
      expect(result.transport).toBe("websocket");
      expect(typeof result.connect).toBe("function");
    });

    it("throws when API key is missing", async () => {
      await expect(
        createGeminiLiveSession({}),
      ).rejects.toThrow(/API key not configured/i);
    });

    it("includes tool declarations when tools provided", async () => {
      const tools = [
        { name: "list_tasks", description: "List tasks", parameters: { type: "object", properties: {} } },
      ];
      const result = await createGeminiLiveSession({
        geminiKey: "test-key",
        tools,
      });
      expect(result.liveConfig.tools).toBeDefined();
      expect(result.liveConfig.tools[0].functionDeclarations).toHaveLength(1);
    });
  });

  // ── createSdkVoiceSession ─────────────────────────────────

  describe("createSdkVoiceSession", () => {
    it("returns SDK session for openai provider", async () => {
      const result = await createSdkVoiceSession("openai", {
        openaiKey: "sk-test",
      });
      expect(result.useLegacy).toBe(false);
      expect(result.sdk).toBe("openai-agents");
      expect(result.provider).toBe("openai");
      expect(result.agent).toBeDefined();
      expect(result.session).toBeDefined();
    });

    it("returns SDK session for azure provider", async () => {
      const result = await createSdkVoiceSession("azure", {
        azureKey: "az-test",
        azureEndpoint: "https://az.test",
      });
      expect(result.useLegacy).toBe(false);
      expect(result.sdk).toBe("openai-agents");
      expect(result.provider).toBe("azure");
    });

    it("returns SDK session for gemini provider", async () => {
      const result = await createSdkVoiceSession("gemini", {
        geminiKey: "gem-test",
      });
      expect(result.useLegacy).toBe(false);
      expect(result.sdk).toBe("google-genai-live");
      expect(result.provider).toBe("gemini");
    });

    it("returns useLegacy for claude", async () => {
      const result = await createSdkVoiceSession("claude", {});
      expect(result.useLegacy).toBe(true);
      expect(result.reason).toContain("real-time voice SDK");
    });

    it("returns useLegacy for fallback provider", async () => {
      const result = await createSdkVoiceSession("fallback", {});
      expect(result.useLegacy).toBe(true);
    });

    it("handles case-insensitive provider names", async () => {
      const result = await createSdkVoiceSession("OpenAI", {
        openaiKey: "sk-test",
      });
      expect(result.provider).toBe("openai");
      expect(result.useLegacy).toBe(false);
    });
  });

  // ── resolveBestVoiceSession ────────────────────────────────

  describe("resolveBestVoiceSession", () => {
    it("resolves first available SDK in provider chain", async () => {
      const result = await resolveBestVoiceSession({
        provider: "openai",
        providerChainWithFallbacks: ["openai", "azure", "fallback"],
        openaiKey: "sk-test",
      });
      expect(result.useLegacy).toBe(false);
      expect(result.provider).toBe("openai");
    });

    it("falls through to next provider when first fails", async () => {
      const result = await resolveBestVoiceSession({
        provider: "claude",
        providerChainWithFallbacks: ["claude", "gemini"],
        geminiKey: "gem-test",
      });
      expect(result.useLegacy).toBe(false);
      expect(result.provider).toBe("gemini");
    });

    it("returns useLegacy when all providers fail", async () => {
      const result = await resolveBestVoiceSession({
        provider: "fallback",
        providerChainWithFallbacks: ["claude", "fallback"],
      });
      expect(result.useLegacy).toBe(true);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ── getClientSdkConfig ─────────────────────────────────────

  describe("getClientSdkConfig", () => {
    it("returns useSdk: true for openai provider", async () => {
      const config = await getClientSdkConfig({ provider: "openai" });
      expect(config.useSdk).toBe(true);
      expect(config.provider).toBe("openai");
      expect(config.transport).toBe("webrtc");
      expect(config.tier).toBe(1);
    });

    it("returns useSdk: true for gemini provider", async () => {
      const config = await getClientSdkConfig({ provider: "gemini" });
      expect(config.useSdk).toBe(true);
      expect(config.transport).toBe("websocket");
    });

    it("returns useSdk: false for claude provider", async () => {
      const config = await getClientSdkConfig({ provider: "claude" });
      expect(config.useSdk).toBe(false);
      expect(config.fallbackReason).toContain("No native voice SDK");
    });

    it("includes model and voice defaults", async () => {
      const config = await getClientSdkConfig({});
      expect(config.model).toBeDefined();
      expect(config.voiceId).toBe("alloy");
      expect(config.turnDetection).toBe("semantic_vad");
    });
  });

  // ── getSdkDiagnostics ──────────────────────────────────────

  describe("getSdkDiagnostics", () => {
    it("returns diagnostics with provider capabilities", async () => {
      const diag = await getSdkDiagnostics();
      expect(diag.providers).toBeDefined();
      expect(diag.sdkVersions).toBeDefined();
      expect(diag.timestamp).toBeDefined();
      expect(diag.providers.openai.available).toBe(true);
      expect(diag.providers.claude.available).toBe(false);
    });
  });
});
