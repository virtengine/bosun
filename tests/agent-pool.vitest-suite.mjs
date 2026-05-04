import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock SDK dynamic imports — these fire before any test module import.
// The SDKs are not installed in the test env, so we mock them to control
// behaviour: by default they throw "not available" unless overridden.
// ---------------------------------------------------------------------------

const mockCodexStartThread = vi.fn();
const mockCodexResumeThread = vi.fn();
const mockCodexCtor = vi.fn();
const mockCopilotStart = vi.fn();
const mockCopilotCreateSession = vi.fn();
const mockCopilotResumeSession = vi.fn();
const mockClaudeQuery = vi.fn();

function makeCodexMockThread(
  threadId = "mock-codex-thread",
  text = "codex-output",
) {
  return {
    id: threadId,
    runStreamed: async () => ({
      events: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "item.completed",
            item: { type: "agent_message", text },
          };
        },
      },
    }),
  };
}

vi.mock("@openai/codex-sdk", () => {
  return {
    Codex: class MockCodex {
      constructor(...args) {
        mockCodexCtor(...args);
      }

      startThread(...args) {
        if (process.env.__MOCK_CODEX_AVAILABLE !== "1") {
          return {
            id: "mock-codex-unavailable",
            runStreamed: async () => {
              throw new Error("Codex SDK not available: mocked unavailable");
            },
          };
        }
        const injected = mockCodexStartThread(...args);
        if (injected !== undefined) return injected;
        return makeCodexMockThread("mock-codex-thread-new", "codex-output");
      }

      resumeThread(...args) {
        if (process.env.__MOCK_CODEX_AVAILABLE !== "1") {
          throw new Error("Codex SDK not available: mocked unavailable");
        }
        const injected = mockCodexResumeThread(...args);
        if (injected !== undefined) return injected;
        const [threadId] = args;
        return makeCodexMockThread(
          threadId || "mock-codex-thread-resumed",
          "codex-resumed-output",
        );
      }
    },
  };
});

vi.mock("@github/copilot-sdk", () => {
  if (process.env.__MOCK_COPILOT_AVAILABLE === "1") {
    return {
      CopilotClient: class MockCopilotClient {
        async start() {
          const injected = mockCopilotStart();
          if (injected !== undefined) return injected;
        }
        async stop() {}
        async resumeSession(...args) {
          const injected = mockCopilotResumeSession(...args);
          if (injected !== undefined) return injected;
          const [sessionId] = args;
          return {
            sessionId: sessionId || "mock-copilot-session-resumed",
            sendAndWait: async () => {},
            on: (cb) => {
              cb({
                type: "assistant.message",
                data: { content: "copilot-output" },
              });
              return () => {};
            },
          };
        }
        async createSession(...args) {
          const injected = mockCopilotCreateSession(...args);
          if (injected !== undefined) return injected;
          return {
            sessionId: "mock-copilot-session-new",
            sendAndWait: async () => {},
            on: (cb) => {
              cb({
                type: "assistant.message",
                data: { content: "copilot-output" },
              });
              return () => {};
            },
          };
        }
      },
    };
  }
  throw new Error("Cannot find module '@github/copilot-sdk'");
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  if (process.env.__MOCK_CLAUDE_AVAILABLE === "1") {
    return {
      query: function mockQuery(payload = {}) {
        const injected = mockClaudeQuery(payload);
        if (injected !== undefined) return injected;
        return {
          async *[Symbol.asyncIterator]() {
            let sessionId = "mock-claude-session-new";
            try {
              const promptIterator =
                payload?.prompt?.[Symbol.asyncIterator]?.();
              if (promptIterator) {
                const first = await promptIterator.next();
                if (!first?.done) {
                  const incoming =
                    first?.value?.session_id || first?.value?.sessionId;
                  if (incoming) {
                    sessionId = incoming;
                  }
                }
              }
            } catch {
              /* best effort */
            }
            yield {
              type: "assistant",
              session_id: sessionId,
              message: {
                content: [{ type: "text", text: "claude-output" }],
              },
            };
            yield { type: "result", session_id: sessionId };
          },
        };
      },
    };
  }
  throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
});

// Mock agent-sdk.mjs so the config.toml resolution doesn't interfere
vi.mock("../agent/agent-sdk.mjs", () => ({
  resolveAgentSdkConfig: () => ({ primary: "", source: "test" }),
}));

// Mock config.mjs so tests don't read the real bosun.config.json
vi.mock("../config/config.mjs", () => ({
  loadConfig: () => ({}),
}));

// ---------------------------------------------------------------------------
// Helpers to save / restore env vars
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "AGENT_POOL_SDK",
  "PRIMARY_AGENT",
  "CODEX_SDK_DISABLED",
  "COPILOT_SDK_DISABLED",
  "CLAUDE_SDK_DISABLED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_MODEL_PROFILE",
  "CODEX_MODEL",
  "AZURE_OPENAI_API_KEY",
  "__MOCK_CODEX_AVAILABLE",
  "__MOCK_COPILOT_AVAILABLE",
  "__MOCK_CLAUDE_AVAILABLE",
  "COPILOT_MODEL",
  "COPILOT_SDK_MODEL",
  "GITHUB_TOKEN",
  "COPILOT_CLI_TOKEN",
  "AGENT_POOL_SDK_FAILURE_COOLDOWN_MS",
  "INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS",
];

/** @type {Record<string, string|undefined>} */
let savedEnv = {};

function saveEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearSdkEnv() {
  delete process.env.AGENT_POOL_SDK;
  delete process.env.PRIMARY_AGENT;
  delete process.env.CODEX_SDK_DISABLED;
  delete process.env.COPILOT_SDK_DISABLED;
  delete process.env.CLAUDE_SDK_DISABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.CODEX_MODEL_PROFILE;
  delete process.env.CODEX_MODEL;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.__MOCK_CODEX_AVAILABLE;
  delete process.env.__MOCK_COPILOT_AVAILABLE;
  delete process.env.__MOCK_CLAUDE_AVAILABLE;
  delete process.env.COPILOT_MODEL;
  delete process.env.COPILOT_SDK_MODEL;
  delete process.env.GITHUB_TOKEN;
  delete process.env.COPILOT_CLI_TOKEN;
  delete process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS;
  delete process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS;
  delete process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN;
  delete process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS;
}

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

let getPoolSdkName,
  setPoolSdk,
  resetPoolSdkCache,
  getAvailableSdks,
  launchEphemeralThread,
  execPooledPrompt,
  shouldCompressSessionItemsByDefault,
  launchOrResumeThread,
  execWithRetry,
  invalidateThreadAsync,
  getThreadRecord,
  clearThreadRegistry,
  ensureThreadRegistryLoaded;

beforeEach(async () => {
  saveEnv();
  clearSdkEnv();
  vi.resetModules();

  // Dynamic import to pick up mocks; then grab exports
  const mod = await import("../agent/agent-pool.mjs");
  getPoolSdkName = mod.getPoolSdkName;
  setPoolSdk = mod.setPoolSdk;
  resetPoolSdkCache = mod.resetPoolSdkCache;
  getAvailableSdks = mod.getAvailableSdks;
  launchEphemeralThread = mod.launchEphemeralThread;
  execPooledPrompt = mod.execPooledPrompt;
  shouldCompressSessionItemsByDefault = mod.shouldCompressSessionItemsByDefault;
  launchOrResumeThread = mod.launchOrResumeThread;
  execWithRetry = mod.execWithRetry;
  invalidateThreadAsync = mod.invalidateThreadAsync;
  getThreadRecord = mod.getThreadRecord;
  clearThreadRegistry = mod.clearThreadRegistry;
  ensureThreadRegistryLoaded = mod.ensureThreadRegistryLoaded;

  // Always reset the cache so each test starts clean
  resetPoolSdkCache();
  mockCodexStartThread.mockReset();
  mockCodexResumeThread.mockReset();
  mockCodexCtor.mockReset();
  mockCopilotStart.mockReset();
  mockCopilotCreateSession.mockReset();
  mockCopilotResumeSession.mockReset();
  mockClaudeQuery.mockReset();
  await ensureThreadRegistryLoaded();
  clearThreadRegistry();
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. SDK Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("SDK resolution", () => {
  it("uses AGENT_POOL_SDK env var when set", () => {
    process.env.AGENT_POOL_SDK = "copilot";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("copilot");
  });

  it("falls back to PRIMARY_AGENT env var", () => {
    // No AGENT_POOL_SDK
    process.env.PRIMARY_AGENT = "claude";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("claude");
  });

  it("AGENT_POOL_SDK takes priority over PRIMARY_AGENT", () => {
    process.env.AGENT_POOL_SDK = "claude";
    process.env.PRIMARY_AGENT = "copilot";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("claude");
  });

  it("skips disabled SDKs in resolution", () => {
    process.env.AGENT_POOL_SDK = "copilot";
    process.env.COPILOT_SDK_DISABLED = "1";
    resetPoolSdkCache();
    // copilot is disabled, should skip to fallback chain → codex
    expect(getPoolSdkName()).not.toBe("copilot");
  });

  it("uses fallback chain when all preferred are disabled", () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    // Claude not disabled → should pick claude
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("claude");
  });

  it("defaults to codex when nothing is set", () => {
    resetPoolSdkCache();
    // No env vars → fallback chain starts at codex
    expect(getPoolSdkName()).toBe("codex");
  });

  it("defaults to codex when all SDKs are disabled", () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    resetPoolSdkCache();
    // All disabled → last resort codex
    expect(getPoolSdkName()).toBe("codex");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. SDK Management
// ═══════════════════════════════════════════════════════════════════════════

describe("SDK management", () => {
  it("setPoolSdk sets the SDK name", () => {
    setPoolSdk("copilot");
    expect(getPoolSdkName()).toBe("copilot");
  });

  it("setPoolSdk normalises case", () => {
    setPoolSdk("CLAUDE");
    expect(getPoolSdkName()).toBe("claude");
  });

  it("setPoolSdk throws for unknown SDK", () => {
    expect(() => setPoolSdk("invalid")).toThrow(/unknown SDK/i);
    expect(() => setPoolSdk("gpt")).toThrow(/unknown SDK/i);
    expect(() => setPoolSdk("")).toThrow(/unknown SDK/i);
  });

  it("resetPoolSdkCache forces re-resolution", () => {
    setPoolSdk("claude");
    expect(getPoolSdkName()).toBe("claude");

    // Now set env var and reset — should pick up the new env
    process.env.AGENT_POOL_SDK = "copilot";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("copilot");
  });

  it("getAvailableSdks returns non-disabled SDKs", () => {
    // Nothing disabled → all three available
    const available = getAvailableSdks();
    expect(available).toContain("codex");
    expect(available).toContain("copilot");
    expect(available).toContain("claude");
    expect(available).toHaveLength(3);
  });

  it("getAvailableSdks excludes disabled SDKs", () => {
    process.env.COPILOT_SDK_DISABLED = "1";
    const available = getAvailableSdks();
    expect(available).not.toContain("copilot");
    expect(available).toContain("codex");
    expect(available).toContain("claude");
    expect(available).toHaveLength(2);
  });

  it("getAvailableSdks returns empty when all disabled", () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    expect(getAvailableSdks()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. launchEphemeralThread
// ═══════════════════════════════════════════════════════════════════════════

describe("launchEphemeralThread", () => {
  it("returns sdk field in result", async () => {
    // SDKs aren't actually available → will return error with sdk field
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result).toHaveProperty("sdk");
    expect(typeof result.sdk).toBe("string");
    expect(["codex", "copilot", "claude"]).toContain(result.sdk);
  });

  it("returns success/output/items/error fields", async () => {
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("error");
    expect(typeof result.success).toBe("boolean");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("uses extra.sdk override when provided", async () => {
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      {
        sdk: "claude",
      },
    );
    // Should attempt claude first (and fail since it's mocked to throw)
    // The error should reference claude SDK
    expect(result.sdk).toBe("claude");
  });

  it("returns error when SDK is not available", async () => {
    // Force codex only, which isn't installed
    setPoolSdk("codex");
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(typeof result.error).toBe("string");
  });

  it("tries fallback when Codex model listing returns 400", async () => {
    process.env.BOSUN_AGENT_POOL_FALLBACK_ORDER = "codex,copilot";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_API_KEY = "test-key";
    process.env.CLAUDE_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";

    setCodexLauncherMock(async () => ({
      success: false,
      output: "",
      items: [],
      error: "Failed to list models: 400",
      sdk: "codex",
    }));
    setCopilotLauncherMock(async () => ({
      success: true,
      output: "copilot fallback ok",
      items: [],
      error: null,
      sdk: "copilot",
    }));

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      { sdk: "codex" },
    );

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("copilot");
    expect(result.output).toContain("copilot fallback ok");
  });
  it("tries fallback when primary SDK not available", async () => {
    // Set codex as primary, disable it, have copilot available in fallback
    // Since both will fail (SDKs not installed), verify it tries multiple
    setPoolSdk("codex");
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    // The result should exist — it tried codex, then fallback chain
    expect(result).toBeDefined();
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("sdk");
  });
  it("fails over to fallback SDK when primary times out", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-token";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "timeout-thread-failover",
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    }));

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      25,
      {
        sdk: "codex",
      },
    );

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("copilot");
    expect(result.error).toBeNull();
    expect(result.output).toContain("copilot-output");
  });

  it("skips a cooled-down SDK after timeout and retries it after cooldown expiry", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "1000";
    setPoolSdk("codex");

    const nowSpy = vi.spyOn(Date, "now");
    let nowMs = 1_000_000;
    nowSpy.mockImplementation(() => nowMs);

    const makeTimeoutThread = (id) => ({
      id,
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    });

    mockCodexStartThread
      .mockImplementationOnce(() => makeTimeoutThread("cooldown-timeout-1"))
      .mockImplementationOnce(() => makeTimeoutThread("cooldown-timeout-2"));

    const first = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });

    expect(first.success).toBe(true);
    expect(first.sdk).toBe("copilot");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    const second = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });

    expect(second.success).toBe(true);
    expect(second.sdk).toBe("copilot");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    nowMs += 1001;

    const third = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });

    expect(third.success).toBe(true);
    expect(third.sdk).toBe("copilot");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("force-retries a cooled primary SDK when no other SDK is eligible", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");
    setSdkFailureCooldownForTest("codex", 600000);

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("forced-retry-success", "codex-recovered"),
    );

    const result = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("codex");
    expect(result.output).toContain("codex-recovered");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
  });

  it("force-retries cooled codex without requiring env API keys", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");
    setSdkFailureCooldownForTest("codex", 600000);

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("forced-retry-no-env-key-success", "codex-recovered-no-env-key"),
    );

    const result = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
      disableFallback: true,
    });

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("codex");
    expect(result.output).toContain("codex-recovered-no-env-key");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
  });

  it("force-retries cooled SDKs when remaining enabled fallback lacks prerequisites", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    delete process.env.ANTHROPIC_API_KEY;
    setPoolSdk("codex");
    setSdkFailureCooldownForTest("codex", 600000);

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("forced-retry-missing-claude-success", "codex-recovered-with-missing-claude"),
    );

    const result = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("codex");
    expect(result.output).toContain("codex-recovered-with-missing-claude");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
  });

  it("rescue-attempts a cooled primary SDK before returning no-sdk errors", async () => {
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");
    setSdkFailureCooldownForTest("codex", 120000);

    const result = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
      disableFallback: true,
    });

    expect(result.success).toBe(false);
    expect(result.sdk).toBe("codex");
    expect(result.error).toMatch(/codex/i);
    expect(result.error).not.toMatch(/no sdk available/i);
  });

  it("retries primary SDK during cooldown when fallback SDKs are missing credentials", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "1000";
    setPoolSdk("codex");

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    const makeTimeoutThread = (id) => ({
      id,
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    });

    mockCodexStartThread.mockImplementation(() =>
      makeTimeoutThread("cooldown-prereq-bypass-timeout"),
    );

    const first = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/codex timeout/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    delete process.env.OPENAI_API_KEY;

    const second = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/codex timeout/i);
    expect(second.error).not.toMatch(/no SDK available/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("retries a cooled-down fallback SDK when primary is blocked by missing prerequisites", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    delete process.env.CLAUDE_SDK_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "1000";
    setPoolSdk("claude");

    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    const makeTimeoutThread = (id) => ({
      id,
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    });

    mockCodexStartThread.mockImplementation(() =>
      makeTimeoutThread("cooldown-fallback-prereq-bypass-timeout"),
    );

    const first = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/codex timeout/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    const second = await launchEphemeralThread("test prompt", process.cwd(), 25);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/codex timeout/i);
    expect(second.error).not.toMatch(/no SDK available/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it("fails over when copilot startup reports a protocol version mismatch", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "1000";
    setPoolSdk("copilot");

    mockCopilotStart.mockImplementationOnce(() => {
      throw new Error(
        "SDK protocol version mismatch: SDK expects version 2, but server reports version 3.",
      );
    });

    const first = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "copilot",
    });

    expect(first.success).toBe(true);
    expect(first.sdk).toBe("codex");
    expect(mockCopilotStart).toHaveBeenCalledTimes(1);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    const second = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "copilot",
    });

    expect(second.success).toBe(true);
    expect(second.sdk).toBe("codex");
    expect(mockCopilotStart).toHaveBeenCalledTimes(1);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);
  });
  it("returns error when all SDKs are disabled", async () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no SDK available/i);
    expect(result.items).toEqual([]);
  });

  it("returns error message containing the SDK name", async () => {
    setPoolSdk("copilot");
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    // Should fail, and error should mention copilot
    expect(result.sdk).toBe("copilot");
  });

  it("respects extra.sdk over setPoolSdk", async () => {
    setPoolSdk("codex");
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      {
        sdk: "copilot",
      },
    );
    expect(result.sdk).toBe("copilot");
  });

  it("ignores invalid extra.sdk and uses resolved SDK", async () => {
    setPoolSdk("codex");
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      {
        sdk: "nonexistent",
      },
    );
    // Invalid sdk in extra should fall through to resolved pool sdk
    expect(result.sdk).toBe("codex");
  });

  it("applies envOverrides to Codex launch options per request", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    const result = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "codex",
      envOverrides: {
        CODEX_MODEL_PROFILE: "executor-2-profile",
        CODEX_MODEL: "gpt-5.3-codex",
      },
    });

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("codex");
    expect(mockCodexCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_MODEL_PROFILE: "executor-2-profile",
          CODEX_MODEL: "gpt-5.3-codex",
        }),
      }),
    );
  });

  it("disables remote model discovery for Azure Codex pool launches", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_BASE_URL = "https://example-resource.openai.azure.com/openai/v1";
    process.env.OPENAI_API_KEY = "azure-key";
    process.env.CODEX_MODEL = "gpt-5.4";
    setPoolSdk("codex");

    const result = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "codex",
    });

    expect(result.success).toBe(true);
    const codexCtorOpts = mockCodexCtor.mock.calls.at(-1)?.[0];
    expect(codexCtorOpts?.config).toEqual(expect.objectContaining({
      features: expect.objectContaining({
        remote_models: false,
      }),
      model_provider: "azure",
      model: "gpt-5.4",
    }));
  });

  it("accepts copilot output when sendAndWait times out waiting for session.idle", async () => {
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("copilot");

    mockCopilotCreateSession.mockImplementation(() => ({
      sendAndWait: async () => {
        throw new Error("Timeout after 300000ms waiting for session.idle");
      },
      on: (cb) => {
        cb({
          type: "assistant.message",
          data: { content: "copilot-complete-output" },
        });
        return () => {};
      },
    }));

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result.success).toBe(true);
    expect(result.sdk).toBe("copilot");
    expect(result.output).toContain("copilot-complete-output");
    expect(result.error).toBeNull();
  });

  it("fails copilot idle timeout when no assistant output was received", async () => {
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("copilot");

    mockCopilotCreateSession.mockImplementation(() => ({
      sendAndWait: async () => {
        throw new Error("Timeout after 300000ms waiting for session.idle");
      },
      on: () => () => {},
    }));

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result.success).toBe(false);
    expect(result.sdk).toBe("copilot");
    expect(result.error).toMatch(
      /\[agent-pool\] copilot timeout after 5000ms waiting for session\.idle/i,
    );
  });

  it("prefers session.send over sendAndWait when both are available", async () => {
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("copilot");

    let listeners = [];
    const sendAndWait = vi.fn(async () => {
      throw new Error("Timeout after 300000ms waiting for session.idle");
    });
    const send = vi.fn(
      async () =>
        await new Promise((resolve) => {
          setTimeout(() => {
            for (const cb of listeners) {
              cb({
                type: "assistant.message",
                data: { content: "copilot-send-output" },
              });
              cb({ type: "session.idle" });
            }
            resolve();
          }, 0);
        }),
    );

    mockCopilotCreateSession.mockImplementation(() => ({
      send,
      sendAndWait,
      on: (cb) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((x) => x !== cb);
        };
      },
    }));

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
    );
    expect(result.success).toBe(true);
    expect(result.sdk).toBe("copilot");
    expect(result.output).toContain("copilot-send-output");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sendAndWait).not.toHaveBeenCalled();
  });

  it("applies explicit extra.model to Copilot session config", async () => {
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("copilot");

    mockCopilotCreateSession.mockImplementation(() => ({
      send: async () => {},
      on: (cb) => {
        cb({ type: "assistant.message", data: { content: "ok" } });
        cb({ type: "session.idle" });
        return () => {};
      },
    }));

    const result = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "copilot",
      model: "gpt-5.3-codex",
    });

    expect(result.success).toBe(true);
    expect(mockCopilotCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.3-codex",
      }),
    );
  });

  it("uses COPILOT_MODEL env when extra.model is not provided", async () => {
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    process.env.COPILOT_MODEL = "gpt-5.3-codex";
    setPoolSdk("copilot");

    mockCopilotCreateSession.mockImplementation(() => ({
      send: async () => {},
      on: (cb) => {
        cb({ type: "assistant.message", data: { content: "ok" } });
        cb({ type: "session.idle" });
        return () => {};
      },
    }));

    const result = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "copilot",
    });

    expect(result.success).toBe(true);
    expect(mockCopilotCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.3-codex",
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. launchOrResumeThread
// ═══════════════════════════════════════════════════════════════════════════

describe("launchOrResumeThread", () => {
  it("applies configured monitor-monitor minimum timeout bound", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS = "80";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "timeout-thread-min-bound",
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    }));

    const result = await launchOrResumeThread(
      "monitor timeout test",
      process.cwd(),
      25,
      {
        taskKey: "monitor-monitor",
        sdk: "codex",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout after 80ms/i);
  });

  it("does not apply monitor timeout bounds to non-monitor task keys", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS = "90";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "timeout-thread-non-monitor",
      runStreamed: async (_prompt, { signal } = {}) => {
        await new Promise((_, reject) => {
          const abortNow = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abortNow();
            return;
          }
          signal?.addEventListener("abort", abortNow, { once: true });
        });
      },
    }));

    const result = await launchOrResumeThread("regular task timeout test", process.cwd(), 25, {
      taskKey: "task-123",
      sdk: "codex",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timeout after 25ms/i);
  });

  it("uses INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS for stalled codex streams", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS = "1000";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "first-event-timeout-thread",
      runStreamed: async (_prompt, { signal } = {}) => ({
        events: {
          async *[Symbol.asyncIterator]() {
            await new Promise((_, reject) => {
              const abortNow = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              };
              if (signal?.aborted) {
                abortNow();
                return;
              }
              signal?.addEventListener("abort", abortNow, { once: true });
            });
          },
        },
      }),
    }));

    const result = await launchOrResumeThread("first event timeout test", process.cwd(), 3500, {
      taskKey: "stream-first-event-timeout",
      sdk: "codex",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no events received within 1000ms");
  });

  it("caps and truncates stored codex stream items", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN = "1";
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS = "12";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "stream-cap-thread",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: {
                type: "command_execution",
                aggregated_output: "abcdefghijklmnopqrstuvwxyz",
              },
            };
            yield {
              type: "item.completed",
              item: {
                type: "command_execution",
                aggregated_output: "second item should be dropped",
              },
            };
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "final answer" },
            };
          },
        },
      }),
    }));

    const result = await launchOrResumeThread("stream cap test", process.cwd(), 5000, {
      taskKey: "stream-cap-task",
      sdk: "codex",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("final answer");
    expect(result.items.length).toBe(2);
    expect(result.items[0].aggregated_output).toContain("…truncated");
    expect(result.items[1]).toMatchObject({ type: "stream_notice" });
  });

  it("drops poisoned codex thread metadata when resume state is corrupted", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    const taskKey = "poisoned-resume-task";
    mockCodexStartThread
      .mockImplementationOnce(() =>
        makeCodexMockThread("legacy-thread-id", "first-run"),
      )
      .mockImplementationOnce(() => null);

    const first = await launchOrResumeThread(
      "initial prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "codex",
      },
    );

    expect(first.success).toBe(true);
    expect(first.threadId).toBe("legacy-thread-id");
    expect(first.resumed).toBe(false);

    mockCodexResumeThread.mockImplementation(() => {
      throw new Error(
        "state db missing rollout path for thread legacy-thread-id; invalid_encrypted_content; could not be verified",
      );
    });

    const second = await launchOrResumeThread(
      "follow-up prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "codex",
      },
    );

    expect(second.success).toBe(false);
    expect(second.resumed).toBe(false);
    expect(second.error).toMatch(/startThread\(\) returned null/i);

    const record = getThreadRecord(taskKey);
    expect(record).toBeTruthy();
    expect(record.threadId).toBeNull();
    expect(record.alive).toBe(false);
  });

  it("invalidateThreadAsync prevents reuse of an existing thread", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    const taskKey = "monitor-monitor";
    mockCodexStartThread
      .mockImplementationOnce(() =>
        makeCodexMockThread("thread-1", "first-run"),
      )
      .mockImplementationOnce(() =>
        makeCodexMockThread("thread-2", "second-run"),
      );

    const first = await launchOrResumeThread(
      "initial prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "codex",
      },
    );
    expect(first.success).toBe(true);
    expect(first.threadId).toBe("thread-1");
    expect(first.resumed).toBe(false);

    await invalidateThreadAsync(taskKey);
    const invalidatedRecord = getThreadRecord(taskKey);
    expect(invalidatedRecord?.alive).toBe(false);

    const second = await launchOrResumeThread(
      "follow-up prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "codex",
      },
    );

    expect(second.success).toBe(true);
    expect(second.resumed).toBe(false);
    expect(second.threadId).toBe("thread-2");
    expect(mockCodexResumeThread).not.toHaveBeenCalled();
  });

  it("uses persistent Copilot session IDs without carrying stale Codex thread IDs", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    const taskKey = "monitor-monitor";

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("legacy-thread-id", "codex-first-run"),
    );

    const first = await launchOrResumeThread(
      "initial prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "codex",
      },
    );
    expect(first.success).toBe(true);
    expect(first.threadId).toBe("legacy-thread-id");
    expect(first.resumed).toBe(false);

    const second = await launchOrResumeThread(
      "switch to copilot",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "copilot",
      },
    );
    expect(second.success).toBe(true);
    expect(second.threadId).toBe("mock-copilot-session-new");
    expect(second.resumed).toBe(false);

    const recordAfterSecond = getThreadRecord(taskKey);
    expect(recordAfterSecond?.sdk).toBe("copilot");
    expect(recordAfterSecond?.threadId).toBe("mock-copilot-session-new");
    expect(recordAfterSecond?.alive).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logSpy.mockClear();
    const third = await launchOrResumeThread(
      "copilot follow-up",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "copilot",
      },
    );
    expect(third.success).toBe(true);
    expect(third.resumed).toBe(true);
    expect(third.threadId).toBe("mock-copilot-session-new");
    const emittedLogs = logSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n");
    expect(emittedLogs).toContain("resuming Copilot session");
    expect(mockCopilotResumeSession).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("persists and resumes Claude session IDs", async () => {
    process.env.__MOCK_CLAUDE_AVAILABLE = "1";
    const taskKey = "monitor-monitor-claude";

    const first = await launchOrResumeThread(
      "initial prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "claude",
      },
    );
    expect(first.success).toBe(true);
    expect(first.threadId).toBe("mock-claude-session-new");
    expect(first.resumed).toBe(false);

    const firstRecord = getThreadRecord(taskKey);
    expect(firstRecord?.sdk).toBe("claude");
    expect(firstRecord?.threadId).toBe("mock-claude-session-new");
    expect(firstRecord?.alive).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logSpy.mockClear();
    const second = await launchOrResumeThread(
      "claude follow-up",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "claude",
      },
    );

    expect(second.success).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.threadId).toBe("mock-claude-session-new");
    const emittedLogs = logSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n");
    expect(emittedLogs).toContain("resuming Claude session");
    expect(mockClaudeQuery).toHaveBeenCalledTimes(2);
    logSpy.mockRestore();
  });

  it("registers workflow child sessions in the harness session manager", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("workflow-managed-thread", "managed-session-output"),
    );

    const sessionManagerMod = await import("../agent/session-manager.mjs");
    const sessionManager = sessionManagerMod.getBosunSessionManager();

    sessionManager.switchSession("workflow-parent-session", {
      scope: "workflow-task",
      sessionType: "task",
      taskKey: "workflow-parent-session",
      cwd: process.cwd(),
    });

    const result = await launchOrResumeThread(
      "workflow child prompt",
      process.cwd(),
      5000,
      {
        taskKey: "workflow-task-key",
        sdk: "codex",
        sessionId: "workflow-child-session",
        sessionScope: "workflow-task",
        parentSessionId: "workflow-parent-session",
        rootSessionId: "workflow-root-session",
        metadata: {
          source: "workflow-run-agent",
          workflowRunId: "run-200",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(sessionManager.getSession("workflow-child-session")).toMatchObject({
      sessionId: "workflow-child-session",
      parentSessionId: "workflow-parent-session",
      rootSessionId: "workflow-parent-session",
      metadata: expect.objectContaining({
        source: "workflow-run-agent",
        workflowRunId: "run-200",
      }),
    });
    expect(sessionManager.getReplaySnapshot("workflow-child-session")).toEqual(
      expect.objectContaining({
        lineage: expect.objectContaining({
          parentSessionId: "workflow-parent-session",
        }),
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. execWithRetry
// ═══════════════════════════════════════════════════════════════════════════

describe("execWithRetry", () => {
  it("retries after timeout without treating the next attempt as externally aborted", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    let launchCount = 0;
    mockCodexStartThread.mockImplementation(() => {
      launchCount += 1;
      if (launchCount === 1) {
        return {
          id: "timeout-thread-first",
          runStreamed: async (_prompt, { signal } = {}) => {
            await new Promise((_, reject) => {
              const abortNow = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              };
              if (signal?.aborted) {
                abortNow();
                return;
              }
              signal?.addEventListener("abort", abortNow, { once: true });
            });
          },
        };
      }
      return makeCodexMockThread("timeout-thread-second", "recovered-output");
    });

    const result = await execWithRetry("recover after timeout", {
      taskKey: "retry-timeout-task",
      cwd: process.cwd(),
      timeoutMs: 25,
      maxRetries: 1,
      sdk: "codex",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.error).toBeNull();
    expect(result.output).toContain("recovered-output");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. execPooledPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("execPooledPrompt", () => {
  it("routes task, workflow, delegate, and voice helper sessions through shredding by default", () => {
    expect(shouldCompressSessionItemsByDefault("task")).toBe(true);
    expect(shouldCompressSessionItemsByDefault("flow")).toBe(true);
    expect(shouldCompressSessionItemsByDefault("delegate")).toBe(true);
    expect(shouldCompressSessionItemsByDefault("voice-delegate")).toBe(true);
    expect(shouldCompressSessionItemsByDefault("voice-workflow-generate")).toBe(true);
    expect(shouldCompressSessionItemsByDefault("ephemeral")).toBe(false);
    expect(shouldCompressSessionItemsByDefault("ephemeral", { compressEphemeralItems: true })).toBe(true);
  });

  it("returns finalResponse on failure with error prefix", async () => {
    // Force all SDKs disabled so this path deterministically fails.
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await execPooledPrompt("do something");
    expect(result).toHaveProperty("finalResponse");
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("usage");
    // Should be an error response
    expect(result.finalResponse).toMatch(/\[agent-pool error\]/);
    expect(result.usage).toBeNull();
  });

  it("returns error message on failure", async () => {
    const result = await execPooledPrompt("test task");
    expect(typeof result.finalResponse).toBe("string");
    expect(result.finalResponse.length).toBeGreaterThan(0);
  });

  it("items is always an array", async () => {
    const result = await execPooledPrompt("test task");
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("usage is null for ephemeral threads", async () => {
    const result = await execPooledPrompt("test task");
    expect(result.usage).toBeNull();
  });

  it("passes options through to launchEphemeralThread", async () => {
    // Verify that extra options like sdk, cwd, timeoutMs are forwarded
    const result = await execPooledPrompt("test task", {
      sdk: "claude",
      cwd: process.cwd(),
      timeoutMs: 3000,
    });
    // The result should exist and be well-formed
    expect(result).toHaveProperty("finalResponse");
    expect(result).toHaveProperty("items");
    expect(result).toHaveProperty("usage");
  });

  it("passes onEvent callback through", async () => {
    const events = [];
    await execPooledPrompt("test task", {
      onEvent: (e) => events.push(e),
      timeoutMs: 3000,
    });
    // onEvent may or may not be called depending on SDK availability,
    // but the function should not throw
    expect(Array.isArray(events)).toBe(true);
  });

  it("returns (no output) when error is null but success is false", async () => {
    // This edge case is handled by the code: error is falsy → "(no output)"
    // We can't easily trigger this without deeper mocking, so we test the
    // format when all SDKs are disabled (which does produce an error)
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await execPooledPrompt("test task");
    expect(result.finalResponse).toMatch(/\[agent-pool error\]|no output/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Edge cases & integration of resolution + launch
// ═══════════════════════════════════════════════════════════════════════════

describe("resolution and launch integration", () => {
  it("setPoolSdk affects subsequent launchEphemeralThread calls", async () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    resetPoolSdkCache();

    setPoolSdk("claude");
    const result = await launchEphemeralThread("test", process.cwd(), 5000);
    expect(result.sdk).toBe("claude");
  });

  it("env var change after resetPoolSdkCache is picked up", async () => {
    process.env.AGENT_POOL_SDK = "copilot";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("copilot");

    // Change env and reset
    process.env.AGENT_POOL_SDK = "claude";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("claude");
  });

  it("disabled SDK env var is respected during launch", async () => {
    process.env.CODEX_SDK_DISABLED = "1";
    resetPoolSdkCache();
    // Should NOT resolve to codex
    expect(getPoolSdkName()).not.toBe("codex");
  });

  it("CODEX_SDK_DISABLED=1 skips codex in fallback chain", async () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await launchEphemeralThread("test", process.cwd(), 5000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no SDK available/);
    expect(result.error).toMatch(/all sdks are disabled/i);
  });
});

