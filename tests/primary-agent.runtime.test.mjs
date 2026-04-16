import { describe, it, expect, beforeEach, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });

const SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 15_000;

const mockConfigState = vi.hoisted(() => ({
  current: { primaryAgent: "codex-sdk" },
}));

const mockEnsureCodexConfig = vi.hoisted(() => vi.fn(() => ({ noChanges: true })));
const mockPrintConfigSummary = vi.hoisted(() => vi.fn());
const mockEnsureRepoConfigs = vi.hoisted(() => vi.fn(() => ({})));
const mockPrintRepoConfigSummary = vi.hoisted(() => vi.fn());
const mockResolveRepoRoot = vi.hoisted(() => vi.fn(() => "C:/repo"));
const mockRecordEvent = vi.hoisted(() => vi.fn());
const mockExecCodexPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "codex-ok", items: [] })));
const mockIsCodexBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetThreadInfo = vi.hoisted(() => vi.fn(() => ({ sessionId: "active-codex-session", threadId: "thread-1", isBusy: true })));
const mockResetThread = vi.hoisted(() => vi.fn(async () => {}));
const mockInitCodexShell = vi.hoisted(() => vi.fn(async () => true));
const mockGetCodexSessionId = vi.hoisted(() => vi.fn(() => "active-codex-session"));
const mockListCodexSessions = vi.hoisted(() => vi.fn(async () => []));
const mockSwitchCodexSession = vi.hoisted(() => vi.fn(async () => {}));
const mockCreateCodexSession = vi.hoisted(() => vi.fn(async () => {}));
const mockExecCopilotPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "copilot-ok", items: [] })));
const mockSteerCopilotPrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsCopilotBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetCopilotSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetCopilotSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitCopilotShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecClaudePrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "claude-ok", items: [] })));
const mockSteerClaudePrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsClaudeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetClaudeSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetClaudeSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitClaudeShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecGeminiPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "gemini-ok", items: [] })));
const mockSteerGeminiPrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockIsGeminiBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetGeminiSessionInfo = vi.hoisted(() => vi.fn(() => ({ isBusy: false })));
const mockResetGeminiSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitGeminiShell = vi.hoisted(() => vi.fn(async () => true));
const mockExecPooledPrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "pooled-ok", items: [] })));
const mockExecOpencodePrompt = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "opencode stub", items: [], usage: null })));
const mockSteerOpencodePrompt = vi.hoisted(() => vi.fn(async () => ({ ok: true, mode: "abort" })));
const mockIsOpencodeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetOpencodeSessionInfo = vi.hoisted(() => vi.fn(() => ({ turnCount: 0, isActive: false, isBusy: false, sessionCount: 0, namedSessionId: null })));
const mockResetOpencodeSession = vi.hoisted(() => vi.fn(async () => {}));
const mockInitOpencodeShell = vi.hoisted(() => vi.fn(async () => {}));
const mockGetOpencodeSessionId = vi.hoisted(() => vi.fn(() => null));
const mockListOpencodeSessions = vi.hoisted(() => vi.fn(async () => []));
const mockSwitchOpencodeSession = vi.hoisted(() => vi.fn(async () => {}));
const mockCreateOpencodeSession = vi.hoisted(() => vi.fn(async (id) => ({ id, serverSessionId: null })));
const mockExecOpenAINative = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "openai-native-ok", items: [], usage: null })));
const mockIsOpenAINativeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetOpenAINativeInfo = vi.hoisted(() => vi.fn(() => ({ busy: false })));
const mockInitOpenAINative = vi.hoisted(() => vi.fn(async () => true));
const mockResetOpenAINative = vi.hoisted(() => vi.fn(() => {}));
const mockListOpenAINativeSessions = vi.hoisted(() => vi.fn(() => []));
const mockGetOpenAINativeSessionMessages = vi.hoisted(() => vi.fn(() => []));
const mockExecAnthropicNative = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "anthropic-native-ok", items: [], usage: null })));
const mockIsAnthropicNativeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetAnthropicNativeInfo = vi.hoisted(() => vi.fn(() => ({ busy: false })));
const mockInitAnthropicNative = vi.hoisted(() => vi.fn(async () => true));
const mockResetAnthropicNative = vi.hoisted(() => vi.fn(() => {}));
const mockListAnthropicNativeSessions = vi.hoisted(() => vi.fn(() => []));
const mockGetAnthropicNativeSessionMessages = vi.hoisted(() => vi.fn(() => []));
const mockExecGeminiNative = vi.hoisted(() => vi.fn(async () => ({ finalResponse: "gemini-native-ok", items: [], usage: null })));
const mockIsGeminiNativeBusy = vi.hoisted(() => vi.fn(() => false));
const mockGetGeminiNativeInfo = vi.hoisted(() => vi.fn(() => ({ busy: false })));
const mockInitGeminiNative = vi.hoisted(() => vi.fn(async () => true));
const mockResetGeminiNative = vi.hoisted(() => vi.fn(() => {}));
const mockListGeminiNativeSessions = vi.hoisted(() => vi.fn(() => []));
const mockGetGeminiNativeSessionMessages = vi.hoisted(() => vi.fn(() => []));

vi.mock("../config/config.mjs", () => ({
  loadConfig: () => mockConfigState.current,
}));

vi.mock("../shell/codex-config.mjs", () => ({
  ensureCodexConfig: mockEnsureCodexConfig,
  printConfigSummary: mockPrintConfigSummary,
}));

vi.mock("../config/repo-config.mjs", () => ({
  ensureRepoConfigs: mockEnsureRepoConfigs,
  printRepoConfigSummary: mockPrintRepoConfigSummary,
}));

vi.mock("../config/repo-root.mjs", () => ({
  resolveRepoRoot: mockResolveRepoRoot,
}));

vi.mock("../infra/session-tracker.mjs", () => ({
  getSessionTracker: () => ({
    recordEvent: mockRecordEvent,
  }),
}));

vi.mock("../shell/codex-shell.mjs", () => ({
  execCodexPrompt: mockExecCodexPrompt,
  steerCodexPrompt: vi.fn(async () => ({ ok: true })),
  isCodexBusy: mockIsCodexBusy,
  getThreadInfo: mockGetThreadInfo,
  resetThread: mockResetThread,
  initCodexShell: mockInitCodexShell,
  getActiveSessionId: mockGetCodexSessionId,
  listSessions: mockListCodexSessions,
  switchSession: mockSwitchCodexSession,
  createSession: mockCreateCodexSession,
}));

vi.mock("../shell/copilot-shell.mjs", () => ({
  execCopilotPrompt: mockExecCopilotPrompt,
  steerCopilotPrompt: mockSteerCopilotPrompt,
  isCopilotBusy: mockIsCopilotBusy,
  getSessionInfo: mockGetCopilotSessionInfo,
  resetSession: mockResetCopilotSession,
  initCopilotShell: mockInitCopilotShell,
}));

vi.mock("../shell/claude-shell.mjs", () => ({
  execClaudePrompt: mockExecClaudePrompt,
  steerClaudePrompt: mockSteerClaudePrompt,
  isClaudeBusy: mockIsClaudeBusy,
  getSessionInfo: mockGetClaudeSessionInfo,
  resetClaudeSession: mockResetClaudeSession,
  initClaudeShell: mockInitClaudeShell,
}));

vi.mock("../shell/gemini-shell.mjs", () => ({
  execGeminiPrompt: mockExecGeminiPrompt,
  steerGeminiPrompt: mockSteerGeminiPrompt,
  isGeminiBusy: mockIsGeminiBusy,
  getSessionInfo: mockGetGeminiSessionInfo,
  resetSession: mockResetGeminiSession,
  initGeminiShell: mockInitGeminiShell,
  getActiveSessionId: vi.fn(() => null),
  listSessions: vi.fn(async () => []),
  switchSession: vi.fn(async () => {}),
  createSession: vi.fn(async (id) => ({ id })),
}));

vi.mock("../shell/opencode-shell.mjs", () => ({
  execOpencodePrompt: mockExecOpencodePrompt,
  steerOpencodePrompt: mockSteerOpencodePrompt,
  isOpencodeBusy: mockIsOpencodeBusy,
  getSessionInfo: mockGetOpencodeSessionInfo,
  resetSession: mockResetOpencodeSession,
  initOpencodeShell: mockInitOpencodeShell,
  getActiveSessionId: mockGetOpencodeSessionId,
  listSessions: mockListOpencodeSessions,
  switchSession: mockSwitchOpencodeSession,
  createSession: mockCreateOpencodeSession,
}));

vi.mock("../shell/openai-native-adapter.mjs", () => {
  const adapter = {
    name: "openai-native",
    provider: "OPENAI_NATIVE",
    displayName: "OpenAI Native",
    exec: mockExecOpenAINative,
    isBusy: mockIsOpenAINativeBusy,
    getInfo: mockGetOpenAINativeInfo,
    init: mockInitOpenAINative,
    reset: mockResetOpenAINative,
    listSessions: mockListOpenAINativeSessions,
    getSessionMessages: mockGetOpenAINativeSessionMessages,
  };
  return {
    openaiNativeAdapter: adapter,
    default: adapter,
  };
});

vi.mock("../shell/anthropic-native-adapter.mjs", () => {
  const adapter = {
    name: "anthropic-native",
    provider: "ANTHROPIC_NATIVE",
    displayName: "Anthropic Native",
    acceptsTurnPayload: true,
    exec: mockExecAnthropicNative,
    isBusy: mockIsAnthropicNativeBusy,
    getInfo: mockGetAnthropicNativeInfo,
    init: mockInitAnthropicNative,
    reset: mockResetAnthropicNative,
    listSessions: mockListAnthropicNativeSessions,
    getSessionMessages: mockGetAnthropicNativeSessionMessages,
  };
  return {
    anthropicNativeAdapter: adapter,
    default: adapter,
  };
});

vi.mock("../shell/gemini-native-adapter.mjs", () => {
  const adapter = {
    name: "gemini-native",
    provider: "GEMINI_NATIVE",
    displayName: "Gemini Native",
    acceptsTurnPayload: true,
    exec: mockExecGeminiNative,
    isBusy: mockIsGeminiNativeBusy,
    getInfo: mockGetGeminiNativeInfo,
    init: mockInitGeminiNative,
    reset: mockResetGeminiNative,
    listSessions: mockListGeminiNativeSessions,
    getSessionMessages: mockGetGeminiNativeSessionMessages,
  };
  return {
    geminiNativeAdapter: adapter,
    default: adapter,
  };
});

vi.mock("../agent/agent-pool.mjs", () => ({
  execPooledPrompt: mockExecPooledPrompt,
}));

describe("primary-agent runtime safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigState.current = { primaryAgent: "codex-sdk" };
    delete process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION;
    delete process.env.CODEX_SDK_DISABLED;
    delete process.env.COPILOT_SDK_DISABLED;
    delete process.env.CLAUDE_SDK_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_SDK_DISABLED;
    delete process.env.OPENCODE_SDK_DISABLED;
    delete process.env.PRIMARY_AGENT_RECOVERY_RETRY_ATTEMPTS;
    delete process.env.PRIMARY_AGENT_FAILOVER_CONSECUTIVE_INFRA_ERRORS;
    delete process.env.PRIMARY_AGENT_FAILOVER_ERROR_WINDOW_MS;
    mockIsCodexBusy.mockReturnValue(false);
    mockGetThreadInfo.mockReturnValue({
      sessionId: "active-codex-session",
      threadId: "thread-1",
      isBusy: false,
    });
    mockExecOpencodePrompt.mockResolvedValue({ finalResponse: "opencode stub", items: [], usage: null });
    mockExecOpenAINative.mockResolvedValue({ finalResponse: "openai-native-ok", items: [], usage: null });
    mockExecAnthropicNative.mockResolvedValue({ finalResponse: "anthropic-native-ok", items: [], usage: null });
    mockExecGeminiNative.mockResolvedValue({ finalResponse: "gemini-native-ok", items: [], usage: null });
  });

  it("keeps shell adapter parity in the shell-owned adapter registry", async () => {
    vi.resetModules();
    const { createShellAdapterRegistry } = await import("../shell/shell-adapter-registry.mjs");
    const withRuntimeOptions = vi.fn((_adapterName, options = {}) => ({
      ...options,
      provider: "openai-compatible",
    }));
    const registry = createShellAdapterRegistry({ withRuntimeOptions });

    await registry["opencode-sdk"].exec("route through adapter registry", {
      sessionId: "adapter-registry-session",
    });
    await registry["codex-sdk"].exec("no provider overlay", {
      sessionId: "codex-session",
    });

    expect(withRuntimeOptions).toHaveBeenCalledTimes(1);
    expect(withRuntimeOptions).toHaveBeenCalledWith(
      "opencode-sdk",
      expect.objectContaining({
        persistent: true,
        expectedPrimary: "opencode",
        sessionId: "adapter-registry-session",
      }),
    );
    expect(mockExecOpencodePrompt).toHaveBeenCalledWith(
      "route through adapter registry",
      expect.objectContaining({
        provider: "openai-compatible",
        expectedPrimary: "opencode",
      }),
    );
    expect(mockExecCodexPrompt).toHaveBeenCalledWith(
      "no provider overlay",
      expect.objectContaining({
        persistent: true,
        sessionId: "codex-session",
      }),
    );
  });

  it("does not eagerly touch native adapter properties during registry construction", async () => {
    vi.resetModules();
    vi.doMock("../shell/anthropic-native-adapter.mjs", () => {
      const adapter = {
        exec: vi.fn(async () => ({ finalResponse: "ok", items: [] })),
        isBusy: vi.fn(() => false),
        getInfo: vi.fn(() => ({ busy: false })),
        init: vi.fn(async () => true),
        reset: vi.fn(() => {}),
        listSessions: vi.fn(() => []),
        getSessionMessages: vi.fn(() => []),
      };
      Object.defineProperties(adapter, {
        name: { get() { throw new Error("name getter should not be touched during registry construction"); } },
        provider: { get() { throw new Error("provider getter should not be touched during registry construction"); } },
        displayName: { get() { throw new Error("displayName getter should not be touched during registry construction"); } },
        acceptsTurnPayload: { get() { throw new Error("acceptsTurnPayload getter should not be touched during registry construction"); } },
      });
      return {
        anthropicNativeAdapter: adapter,
        default: adapter,
      };
    });

    const { createShellAdapterRegistry } = await import("../shell/shell-adapter-registry.mjs");
    const registry = createShellAdapterRegistry();

    expect(registry["anthropic-native"]).toEqual(expect.objectContaining({
      name: "anthropic-native",
      provider: "ANTHROPIC_NATIVE",
      displayName: "Anthropic Native",
      acceptsTurnPayload: true,
    }));

    vi.doMock("../shell/anthropic-native-adapter.mjs", () => {
      const adapter = {
        name: "anthropic-native",
        provider: "ANTHROPIC_NATIVE",
        displayName: "Anthropic Native",
        acceptsTurnPayload: true,
        exec: mockExecAnthropicNative,
        isBusy: mockIsAnthropicNativeBusy,
        getInfo: mockGetAnthropicNativeInfo,
        init: mockInitAnthropicNative,
        reset: mockResetAnthropicNative,
        listSessions: mockListAnthropicNativeSessions,
        getSessionMessages: mockGetAnthropicNativeSessionMessages,
      };
      return {
        anthropicNativeAdapter: adapter,
        default: adapter,
      };
    });
  });

  it("uses dryRun codex config checks at runtime by default", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    await primaryAgent.initPrimaryAgent("codex-sdk");

    expect(mockEnsureCodexConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  }, 15000);

  it("falls back to pooled execution when active adapter is busy on another session", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    mockIsCodexBusy.mockReturnValue(true);
    mockGetThreadInfo.mockReturnValue({
      sessionId: "session-a",
      threadId: "thread-a",
      isBusy: true,
    });

    const result = await primaryAgent.execPrimaryPrompt("hello", {
      sessionId: "session-b",
      allowConcurrent: true,
    });

    expect(mockExecPooledPrompt).toHaveBeenCalledWith(
      expect.stringContaining("hello"),
      expect.objectContaining({ sdk: "codex" }),
    );
    expect(result.finalResponse).toBe("pooled-ok");
  });

  it("records a context compression marker when returned items were summarized", async () => {
    mockExecCodexPrompt.mockResolvedValueOnce({
      finalResponse: "done",
      items: [
        { type: "agent_message", text: "summary", _compressed: "agent_tier1", _originalLength: 300 },
        { type: "tool_output", text: "tool placeholder", _cachedLogId: "tool-log-1" },
      ],
    });

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.execPrimaryPrompt("hello", { sessionId: "session-1" });

    expect(mockRecordEvent).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        role: "system",
        type: "system",
        content: expect.stringContaining("Context summarized for continuation"),
        meta: expect.objectContaining({
          contextCompression: expect.objectContaining({
            total: 2,
            counts: expect.objectContaining({
              agent: 1,
              tool: 1,
            }),
            budgetPolicies: expect.any(Object),
            toolFamilies: expect.any(Object),
          }),
        }),
      }),
    );
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("surfaces configured executor profiles with model allow-lists and enabled flags", async () => {
    mockConfigState.current = {
      agentRuntime: "sdk-cli",
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "copilot-claude",
            executor: "COPILOT",
            variant: "CLAUDE_OPUS_4_6",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
          {
            name: "codex-backup",
            executor: "CODEX",
            variant: "DEFAULT",
            enabled: false,
            models: ["gpt-5.3-codex"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    const agents = primaryAgent.getAvailableAgents();
    const copilotClaude = agents.find((agent) => agent.id === "copilot-claude");
    const codexBackup = agents.find((agent) => agent.id === "codex-backup");

    expect(copilotClaude).toEqual(
      expect.objectContaining({
        available: true,
        adapterId: "copilot-sdk",
        models: ["claude-opus-4.6"],
      }),
    );
    expect(codexBackup).toEqual(
      expect.objectContaining({
        available: false,
        adapterId: "codex-sdk",
        models: ["gpt-5.3-codex"],
      }),
    );
  });

  it("switches by configured profile id and preserves selection id", async () => {
    mockConfigState.current = {
      agentRuntime: "sdk-cli",
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "copilot-claude",
            executor: "COPILOT",
            variant: "CLAUDE_OPUS_4_6",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    const switched = await primaryAgent.switchPrimaryAgent("copilot-claude");

    expect(switched.ok).toBe(true);
    expect(primaryAgent.getPrimaryAgentName()).toBe("copilot-sdk");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("copilot-claude");
  });

  it("maps GEMINI executor profiles to gemini-sdk adapter", async () => {
    mockConfigState.current = {
      agentRuntime: "sdk-cli",
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "gemini-default",
            executor: "GEMINI",
            variant: "DEFAULT",
            enabled: true,
            models: ["gemini-2.5-pro"],
          },
        ],
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    const switched = await primaryAgent.switchPrimaryAgent("gemini-default");

    expect(switched.ok).toBe(true);
    expect(primaryAgent.getPrimaryAgentName()).toBe("gemini-sdk");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("gemini-default");
  });

  it("prefers provider-kernel default provider for primary initialization", async () => {
    mockConfigState.current = {
      providers: {
        defaultProvider: "openai-compatible",
        openaiCompatible: {
          enabled: true,
          defaultModel: "qwen2.5-coder:latest",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    await primaryAgent.initPrimaryAgent();

    expect(primaryAgent.getPrimaryAgentName()).toBe("opencode-sdk");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("openai-compatible");
    expect(mockInitOpencodeShell).toHaveBeenCalled();
  });

  it("does not surface legacy SDK pool executors as chat-visible agents in harness mode", async () => {
    mockConfigState.current = {
      agentRuntime: "harness",
      primaryAgent: "codex-sdk",
      executorConfig: {
        executors: [
          {
            name: "primary-codex-us",
            executor: "CODEX",
            variant: "DEFAULT",
            enabled: true,
            models: ["gpt-5.3-codex"],
          },
          {
            name: "copilot-backup",
            executor: "COPILOT",
            variant: "DEFAULT",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
        ],
      },
      harness: {
        enabled: true,
        executors: [],
      },
      providers: {
        defaultProvider: "openai-responses",
        openaiResponses: {
          enabled: true,
          defaultModel: "gpt-5.4",
        },
        azureOpenAi: {
          enabled: true,
          defaultModel: "gpt-5.4-mini",
          endpoint: "https://azure.example.test",
          deployment: "gpt-5-prod",
          apiVersion: "2025-03-01-preview",
        },
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    const agents = primaryAgent.getAvailableAgents();

    expect(agents.some((agent) => agent.id === "primary-codex-us")).toBe(false);
    expect(agents.some((agent) => agent.id === "copilot-backup")).toBe(false);
    expect(agents.some((agent) => agent.id === "openai-responses")).toBe(true);
    expect(agents.some((agent) => agent.id === "azure-openai-responses")).toBe(true);
  });

  it("passes selected provider runtime config into opencode-backed execution", async () => {
    mockConfigState.current = {
      providers: {
        defaultProvider: "openai-compatible",
        openaiCompatible: {
          enabled: true,
          defaultModel: "qwen2.5-coder:latest",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent();

    await primaryAgent.execPrimaryPrompt("route through provider kernel", {
      sessionId: "opencode-provider-kernel",
    });

    expect(mockExecOpencodePrompt).toHaveBeenCalledTimes(1);
    const [, options] = mockExecOpencodePrompt.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({
      provider: "openai-compatible",
      providerConfig: expect.objectContaining({
        providerId: "openai-compatible",
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    }));
  });

  it("prefers the native adapter for harness-managed OpenAI providers", async () => {
    mockConfigState.current = {
      agentRuntime: "harness",
      providers: {
        defaultProvider: "openai-compatible",
        openaiCompatible: {
          enabled: true,
          defaultModel: "qwen2.5-coder:latest",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    };

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    await primaryAgent.initPrimaryAgent();
    await primaryAgent.execPrimaryPrompt("route through the native harness", {
      sessionId: "native-harness-session",
    });

    expect(primaryAgent.getPrimaryAgentName()).toBe("openai-native");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("openai-compatible");
    expect(mockInitOpenAINative).toHaveBeenCalled();
    const [message, options] = mockExecOpenAINative.mock.calls[0];
    expect(message).toContain("route through the native harness");
    expect(options).toEqual(expect.objectContaining({
      provider: "openai-compatible",
      providerConfig: expect.objectContaining({
        providerId: "openai-compatible",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    }));
    expect(String(options.providerConfig?.model || "").trim()).not.toBe("");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("prefers the native adapter for harness-managed Anthropic providers", async () => {
    mockConfigState.current = {
      agentRuntime: "harness",
      providers: {
        defaultProvider: "anthropic-messages",
        anthropic: {
          enabled: true,
          defaultModel: "claude-sonnet-4",
        },
      },
    };
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    await primaryAgent.initPrimaryAgent();
    await primaryAgent.execPrimaryPrompt("route through the Anthropic native harness", {
      sessionId: "anthropic-native-harness-session",
    });

    expect(primaryAgent.getPrimaryAgentName()).toBe("anthropic-native");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("anthropic-messages");
    expect(mockInitAnthropicNative).toHaveBeenCalled();
    const [payload, options] = mockExecAnthropicNative.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({
      providerId: "anthropic-messages",
      messages: [
        expect.objectContaining({
          role: "user",
          text: expect.stringContaining("route through the Anthropic native harness"),
        }),
      ],
    }));
    expect(options).toEqual(expect.objectContaining({
      provider: "anthropic-messages",
      providerConfig: expect.objectContaining({
        providerId: "anthropic-messages",
        provider: "anthropic-messages",
      }),
    }));
    expect(String(options.providerConfig?.model || "").trim()).not.toBe("");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("prefers the native adapter for harness-managed Gemini providers", async () => {
    mockConfigState.current = {
      agentRuntime: "harness",
      providers: {
        defaultProvider: "gemini-generate-content",
        gemini: {
          enabled: true,
          defaultModel: "gemini-2.5-pro",
        },
      },
    };
    process.env.GEMINI_API_KEY = "gemini-secret";

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");

    await primaryAgent.initPrimaryAgent();
    await primaryAgent.execPrimaryPrompt("route through the Gemini native harness", {
      sessionId: "gemini-native-harness-session",
    });

    expect(primaryAgent.getPrimaryAgentName()).toBe("gemini-native");
    expect(primaryAgent.getPrimaryAgentSelection()).toBe("gemini-generate-content");
    expect(mockInitGeminiNative).toHaveBeenCalled();
    const [payload, options] = mockExecGeminiNative.mock.calls[0];
    expect(payload).toEqual(expect.objectContaining({
      providerId: "gemini-generate-content",
      messages: [
        expect.objectContaining({
          role: "user",
          text: expect.stringContaining("route through the Gemini native harness"),
        }),
      ],
    }));
    expect(options).toEqual(expect.objectContaining({
      provider: "gemini-generate-content",
      providerConfig: expect.objectContaining({
        providerId: "gemini-generate-content",
        provider: "gemini-generate-content",
      }),
    }));
    expect(String(options.providerConfig?.model || "").trim()).not.toBe("");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("retries codex locally before any failover", async () => {
    process.env.PRIMARY_AGENT_RECOVERY_RETRY_ATTEMPTS = "1";
    process.env.PRIMARY_AGENT_FAILOVER_CONSECUTIVE_INFRA_ERRORS = "3";

    mockExecCodexPrompt
      .mockRejectedValueOnce(new Error("Codex Exec exited with code 3221225786"))
      .mockResolvedValueOnce({ finalResponse: "codex-recovered", items: [] });

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    const result = await primaryAgent.execPrimaryPrompt("hello", {
      sessionId: "session-retry",
    });

    expect(mockExecCodexPrompt).toHaveBeenCalledTimes(2);
    expect(mockExecCopilotPrompt).not.toHaveBeenCalled();
    expect(result.finalResponse).toBe("codex-recovered");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("prepends architect/editor framing for editor executions", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.execPrimaryPrompt("hello", {
      sessionId: "session-editor",
      mode: "plan",
      architectPlan: "1. Update runtime framing\n2. Verify focused tests",
      changedFiles: ["agent/primary-agent.mjs", "tests/primary-agent.runtime.test.mjs"],
      repoRoot: "C:/repo",
    });

    expect(mockExecCodexPrompt).toHaveBeenCalledTimes(1);
    const [framedMessage, framedOptions] = mockExecCodexPrompt.mock.calls[0];
    expect(framedOptions).toEqual(expect.objectContaining({ persistent: true, sessionId: "session-editor" }));
    expect(framedMessage).toContain("[MODE: plan]");
    expect(framedMessage).toContain("## Architect/Editor Execution");
    expect(framedMessage).toContain("You are the architect phase.");
    expect(framedMessage).toContain("## Repo Topology");
    expect(framedMessage).toContain("Root: C:/repo");
    expect(framedMessage).toContain("agent/primary-agent.mjs");
    expect(framedMessage).toContain("## Tool Capability Contract");
    expect(framedMessage).toContain("hello");
  });

  it("prepends architect plan and repo map for editor executions", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.execPrimaryPrompt("apply the approved plan", {
      sessionId: "session-editor-apply",
      mode: "agent",
      architectPlan: "1. Add repo map framing\n2. Validate focused runtime tests",
      changedFiles: ["agent/primary-agent.mjs", "tests/primary-agent.runtime.test.mjs"],
      repoRoot: "C:/repo",
    });

    expect(mockExecCodexPrompt).toHaveBeenCalledTimes(1);
    const [framedMessage] = mockExecCodexPrompt.mock.calls[0];
    expect(framedMessage).toContain("## Architect/Editor Execution");
    expect(framedMessage).toContain("You are the editor phase.");
    expect(framedMessage).toContain("## Architect Plan");
    expect(framedMessage).toContain("Add repo map framing");
    expect(framedMessage).toContain("## Repo Topology");
    expect(framedMessage).toContain("tests/primary-agent.runtime.test.mjs");
    expect(framedMessage).toContain("apply the approved plan");
  });

  it("suppresses failover until repeated infrastructure failures", async () => {
    process.env.PRIMARY_AGENT_RECOVERY_RETRY_ATTEMPTS = "0";
    process.env.PRIMARY_AGENT_FAILOVER_CONSECUTIVE_INFRA_ERRORS = "3";

    mockExecCodexPrompt.mockRejectedValue(new Error("AGENT_TIMEOUT: codex did not respond"));
    mockExecCopilotPrompt.mockResolvedValue({ finalResponse: "copilot-ok", items: [] });

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    const first = await primaryAgent.execPrimaryPrompt("hello", { sessionId: "s1" });
    const second = await primaryAgent.execPrimaryPrompt("hello", { sessionId: "s2" });

    expect(first.finalResponse).toContain("Failover suppressed");
    expect(second.finalResponse).toContain("Failover suppressed");
    expect(mockExecCopilotPrompt).not.toHaveBeenCalled();

    const third = await primaryAgent.execPrimaryPrompt("hello", { sessionId: "s3" });
    expect(mockExecCopilotPrompt).toHaveBeenCalledTimes(1);
    expect(third.finalResponse).toBe("copilot-ok");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("manages primary sessions through the session manager facade", async () => {
    mockCreateCodexSession.mockResolvedValueOnce({ id: "session-created" });
    mockListCodexSessions.mockResolvedValueOnce([{ id: "adapter-only-session" }]);

    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.createPrimarySession("session-created");
    expect(primaryAgent.getPrimarySessionId()).toBe("session-created");

    await primaryAgent.switchPrimarySession("session-switched");
    expect(primaryAgent.getPrimarySessionId()).toBe("session-switched");
    expect(mockSwitchCodexSession).toHaveBeenCalledWith("session-switched");

    const sessions = await primaryAgent.listPrimarySessions();
    expect(sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "session-created", sessionId: "session-created" }),
      expect.objectContaining({ id: "session-switched", sessionId: "session-switched" }),
      expect.objectContaining({ id: "adapter-only-session" }),
    ]));
  }, 15000);

  it("isolates non-primary active sessions by explicit harness scope", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    const { getBosunSessionManager } = await import("../agent/session-manager.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.execPrimaryPrompt("telegram scoped turn", {
      sessionId: "telegram-session-1",
      scope: "telegram:chat-1",
      sessionType: "telegram",
    });
    await primaryAgent.execPrimaryPrompt("voice scoped turn", {
      sessionId: "voice-session-1",
      scope: "voice-dispatch:call-1",
      sessionType: "voice-dispatch",
    });

    const sessionManager = getBosunSessionManager();
    expect(sessionManager.getActiveSessionId("telegram:chat-1")).toBe("telegram-session-1");
    expect(sessionManager.getActiveSessionId("voice-dispatch:call-1")).toBe("voice-session-1");
    expect(sessionManager.getActiveSessionId("primary")).not.toBe("telegram-session-1");
  }, SLOW_PRIMARY_AGENT_RUNTIME_TEST_TIMEOUT_MS);

  it("keeps primary execution lifecycle in the session-manager facade", async () => {
    vi.resetModules();
    const primaryAgent = await import("../agent/primary-agent.mjs");
    const { getBosunSessionManager } = await import("../agent/session-manager.mjs");
    await primaryAgent.initPrimaryAgent("codex-sdk");

    await primaryAgent.createPrimarySession("primary-facade-session");
    await primaryAgent.switchPrimarySession("primary-facade-session");

    const sessionManager = getBosunSessionManager();
    expect(sessionManager.getSession("primary-facade-session")).toEqual(
      expect.objectContaining({
        sessionId: "primary-facade-session",
        scope: "primary",
        sessionType: "primary",
      }),
    );
    expect(sessionManager.getLineageView("primary-facade-session")).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          sessionId: "primary-facade-session",
        }),
        parent: null,
        descendants: [],
      }),
    );
  });
});
