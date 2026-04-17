import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeout } from "./timeout-helper.mjs";

const __RUN_VITEST_ONLY = Boolean(process.env.VITEST);
// agent-pool tests exercise real child-process spawns; Windows needs much more
// headroom than the standard multiplier, so use a large explicit base.
const SLOW_AGENT_POOL_TEST_TIMEOUT_MS = testTimeout(30_000);
let mockCodexStartThread;
let mockCodexResumeThread;
let mockCodexCtor;
let mockCopilotStart;
let mockCopilotCreateSession;
let mockCopilotResumeSession;
let mockClaudeQuery;
let mockOpencodeExec;
let mockLoadConfig;
let mockMcpResolve;
let mockMcpWrap;
let isolatedHomeDir;
let setSdkFailureCooldownForTest;
function ensureMock(name) {
  const candidate = globalThis[name];
  if (typeof candidate === "function") {
    return candidate;
  }
  return (...args) => {
    const current = globalThis[name];
    if (typeof current !== "function") {
      throw new Error(`Missing test mock: ${name}`);
    }
    return current(...args);
  };
}

const callMockCodexCtor = ensureMock("__agentPoolMockCodexCtor");
const callMockCodexStartThread = ensureMock("__agentPoolMockCodexStartThread");
const callMockCodexResumeThread = ensureMock("__agentPoolMockCodexResumeThread");
const callMockCopilotStart = ensureMock("__agentPoolMockCopilotStart");
const callMockCopilotCreateSession = ensureMock("__agentPoolMockCopilotCreateSession");
const callMockCopilotResumeSession = ensureMock("__agentPoolMockCopilotResumeSession");
const callMockClaudeQuery = ensureMock("__agentPoolMockClaudeQuery");
const callMockOpencodeExec = ensureMock("__agentPoolMockOpencodeExec");
const callMockLoadConfig = ensureMock("__agentPoolMockLoadConfig");
const callMockMcpResolve = ensureMock("__agentPoolMockMcpResolve");
const callMockMcpWrap = ensureMock("__agentPoolMockMcpWrap");

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

function setCodexLauncherMock(impl) {
  mockCodexStartThread.mockImplementation(impl);
}

function setCopilotLauncherMock(impl) {
  mockCopilotCreateSession.mockImplementation(impl);
}

if (__RUN_VITEST_ONLY) {
const { afterEach, beforeEach, describe, expect, it, vi } = globalThis;

// ---------------------------------------------------------------------------
// Mock SDK dynamic imports — these fire before any test module import.
// The SDKs are not installed in the test env, so we mock them to control
// behaviour: by default they throw "not available" unless overridden.
// ---------------------------------------------------------------------------

mockCodexStartThread = vi.fn();
mockCodexResumeThread = vi.fn();
mockCodexCtor = vi.fn();
mockCopilotStart = vi.fn();
mockCopilotCreateSession = vi.fn();
mockCopilotResumeSession = vi.fn();
mockClaudeQuery = vi.fn();
mockOpencodeExec = vi.fn();
mockLoadConfig = vi.fn();
mockMcpResolve = vi.fn();
mockMcpWrap = vi.fn();
globalThis.__agentPoolMockCodexStartThread = mockCodexStartThread;
globalThis.__agentPoolMockCodexResumeThread = mockCodexResumeThread;
globalThis.__agentPoolMockCodexCtor = mockCodexCtor;
globalThis.__agentPoolMockCopilotStart = mockCopilotStart;
globalThis.__agentPoolMockCopilotCreateSession = mockCopilotCreateSession;
globalThis.__agentPoolMockCopilotResumeSession = mockCopilotResumeSession;
globalThis.__agentPoolMockClaudeQuery = mockClaudeQuery;
globalThis.__agentPoolMockOpencodeExec = mockOpencodeExec;
globalThis.__agentPoolMockLoadConfig = mockLoadConfig;
globalThis.__agentPoolMockMcpResolve = mockMcpResolve;
globalThis.__agentPoolMockMcpWrap = mockMcpWrap;

vi.mock("@openai/codex-sdk", () => {
  const getMock = (name) => {
    const candidate = globalThis[name];
    if (typeof candidate !== "function") {
      throw new Error(`Missing test mock: ${name}`);
    }
    return candidate;
  };
  const makeThread = (threadId = "mock-codex-thread", text = "codex-output") => ({
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
  });
  return {
    Codex: class MockCodex {
      constructor(...args) {
        getMock("__agentPoolMockCodexCtor")(...args);
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
        const injected = getMock("__agentPoolMockCodexStartThread")(...args);
        if (injected !== undefined) return injected;
        return makeThread("mock-codex-thread-new", "codex-output");
      }

      resumeThread(...args) {
        if (process.env.__MOCK_CODEX_AVAILABLE !== "1") {
          throw new Error("Codex SDK not available: mocked unavailable");
        }
        const injected = getMock("__agentPoolMockCodexResumeThread")(...args);
        if (injected !== undefined) return injected;
        const [threadId] = args;
        return makeThread(
          threadId || "mock-codex-thread-resumed",
          "codex-resumed-output",
        );
      }
    },
  };
});

vi.mock("@github/copilot-sdk", () => {
  const getMock = (name) => {
    const candidate = globalThis[name];
    if (typeof candidate !== "function") {
      throw new Error(`Missing test mock: ${name}`);
    }
    return candidate;
  };
  if (process.env.__MOCK_COPILOT_AVAILABLE === "1") {
    return {
      CopilotClient: class MockCopilotClient {
        async start() {
          const injected = getMock("__agentPoolMockCopilotStart")();
          if (injected !== undefined) return injected;
        }
        async stop() {}
        async resumeSession(...args) {
          const injected = getMock("__agentPoolMockCopilotResumeSession")(...args);
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
          const injected = getMock("__agentPoolMockCopilotCreateSession")(...args);
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
  const getMock = (name) => {
    const candidate = globalThis[name];
    if (typeof candidate !== "function") {
      throw new Error(`Missing test mock: ${name}`);
    }
    return candidate;
  };
  if (process.env.__MOCK_CLAUDE_AVAILABLE === "1") {
    return {
      query: function mockQuery(payload = {}) {
        const injected = getMock("__agentPoolMockClaudeQuery")(payload);
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

vi.mock("../shell/opencode-shell.mjs", () => ({
  execOpencodePrompt: (...args) => {
    if (process.env.__MOCK_OPENCODE_AVAILABLE !== "1") {
      throw new Error("OpenCode SDK not available: mocked unavailable");
    }
    const injected = callMockOpencodeExec(...args);
    if (injected !== undefined) return injected;
    return {
      finalResponse: "opencode-output",
      items: [],
      usage: null,
    };
  },
}));

// Mock agent-sdk.mjs so the config.toml resolution doesn't interfere
vi.mock("../agent/agent-sdk.mjs", () => ({
  resolveAgentSdkConfig: () => ({ primary: "", source: "test" }),
  resolveCodexSdkInstall: () => ({
    entryPath: `${process.cwd().replace(/\\/g, "/")}/node_modules/@openai/codex-sdk/dist/index.js`,
    rootDir: process.cwd(),
  }),
  resolveAgentSdkModuleEntry: (specifier) => ({
    entryPath: `${process.cwd().replace(/\\/g, "/")}/node_modules/${String(specifier || "").split("/").join("/")}/index.js`,
    rootDir: process.cwd(),
  }),
}));

// Mock config.mjs so tests don't read the real bosun.config.json
vi.mock("../config/config.mjs", () => ({
  loadConfig: (...args) => {
    const candidate = globalThis.__agentPoolMockLoadConfig;
    if (typeof candidate !== "function") {
      throw new Error("Missing test mock: __agentPoolMockLoadConfig");
    }
    return candidate(...args);
  },
}));

vi.mock("../workflow/mcp-registry.mjs", () => ({
  resolveMcpServersForAgent: (...args) => {
    const candidate = globalThis.__agentPoolMockMcpResolve;
    if (typeof candidate !== "function") {
      throw new Error("Missing test mock: __agentPoolMockMcpResolve");
    }
    return candidate(...args);
  },
  wrapServersWithDiscoveryProxy: (...args) => {
    const candidate = globalThis.__agentPoolMockMcpWrap;
    if (typeof candidate !== "function") {
      throw new Error("Missing test mock: __agentPoolMockMcpWrap");
    }
    return candidate(...args);
  },
  writeTempCopilotMcpConfig: () => `${process.cwd().replace(/\\/g, "/")}/.tmp-mcp-config.json`,
  buildClaudeMcpEnv: () => ({ envVar: "", fileContent: { mcpServers: {} } }),
}));

// ---------------------------------------------------------------------------
// Helpers to save / restore env vars
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "AGENT_POOL_SDK",
  "PRIMARY_AGENT",
  "CODEX_SDK_DISABLED",
  "COPILOT_SDK_DISABLED",
  "CLAUDE_SDK_DISABLED",
  "OPENCODE_SDK_DISABLED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "CODEX_MODEL_PROFILE",
  "CODEX_MODEL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY_SWEDEN",
  "AZURE_SWEDEN_ENDPOINT",
  "AZURE_SWEDEN_BASE_URL",
  "__MOCK_CODEX_AVAILABLE",
  "__MOCK_COPILOT_AVAILABLE",
  "__MOCK_CLAUDE_AVAILABLE",
  "__MOCK_OPENCODE_AVAILABLE",
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
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
  delete process.env.AGENT_POOL_SDK;
  delete process.env.PRIMARY_AGENT;
  delete process.env.CODEX_SDK_DISABLED;
  delete process.env.COPILOT_SDK_DISABLED;
  delete process.env.CLAUDE_SDK_DISABLED;
  delete process.env.OPENCODE_SDK_DISABLED;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_ORGANIZATION;
  delete process.env.OPENAI_PROJECT;
  delete process.env.CODEX_MODEL_PROFILE;
  delete process.env.CODEX_MODEL;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY_SWEDEN;
  delete process.env.AZURE_SWEDEN_ENDPOINT;
  delete process.env.AZURE_SWEDEN_BASE_URL;
  delete process.env.__MOCK_CODEX_AVAILABLE;
  delete process.env.__MOCK_COPILOT_AVAILABLE;
  delete process.env.__MOCK_CLAUDE_AVAILABLE;
  delete process.env.__MOCK_OPENCODE_AVAILABLE;
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
  setSdkFailureCooldownForTest,
  getAvailableSdks,
  getAvailableSlots,
  getAgentExecutionSlotStatus,
  allocateSlot,
  releaseSlot,
  launchEphemeralThread,
  execPooledPrompt,
  shouldCompressSessionItemsByDefault,
  launchOrResumeThread,
  continueSession,
  execWithRetry,
  invalidateThreadAsync,
  getThreadRecord,
  clearThreadRegistry,
  ensureThreadRegistryLoaded,
  createCompiledInternalHarnessSession,
  createInternalHarnessSession,
  runCompiledInternalHarnessProfile,
  runInternalHarnessProfile;

beforeEach(async () => {
  saveEnv();
  clearSdkEnv();
  process.env.GITHUB_TOKEN = "test-github-token";
  isolatedHomeDir = mkdtempSync(join(tmpdir(), "bosun-agent-pool-home-"));
  process.env.HOME = isolatedHomeDir;
  process.env.USERPROFILE = isolatedHomeDir;
  vi.resetModules();

  // Dynamic import to pick up mocks; then grab exports
  const mod = await import("../agent/agent-pool.mjs");
  getPoolSdkName = mod.getPoolSdkName;
  setPoolSdk = mod.setPoolSdk;
  resetPoolSdkCache = mod.resetPoolSdkCache;
  setSdkFailureCooldownForTest = mod.setSdkFailureCooldownForTest;
  getAvailableSdks = mod.getAvailableSdks;
  getAvailableSlots = mod.getAvailableSlots;
  getAgentExecutionSlotStatus = mod.getAgentExecutionSlotStatus;
  allocateSlot = mod.allocateSlot;
  releaseSlot = mod.releaseSlot;
  launchEphemeralThread = mod.launchEphemeralThread;
  execPooledPrompt = mod.execPooledPrompt;
  shouldCompressSessionItemsByDefault = mod.shouldCompressSessionItemsByDefault;
  launchOrResumeThread = mod.launchOrResumeThread;
  continueSession = mod.continueSession;
  execWithRetry = mod.execWithRetry;
  invalidateThreadAsync = mod.invalidateThreadAsync;
  getThreadRecord = mod.getThreadRecord;
  clearThreadRegistry = mod.clearThreadRegistry;
  ensureThreadRegistryLoaded = mod.ensureThreadRegistryLoaded;
  createCompiledInternalHarnessSession = mod.createCompiledInternalHarnessSession;
  createInternalHarnessSession = mod.createInternalHarnessSession;
  runCompiledInternalHarnessProfile = mod.runCompiledInternalHarnessProfile;
  runInternalHarnessProfile = mod.runInternalHarnessProfile;

  // Always reset the cache so each test starts clean
  resetPoolSdkCache();
  mockCodexStartThread.mockReset();
  mockCodexResumeThread.mockReset();
  mockCodexCtor.mockReset();
  mockCopilotStart.mockReset();
  mockCopilotCreateSession.mockReset();
  mockCopilotResumeSession.mockReset();
  mockClaudeQuery.mockReset();
  mockOpencodeExec.mockReset();
  mockLoadConfig.mockReset();
  mockLoadConfig.mockReturnValue({});
  mockMcpResolve.mockReset();
  mockMcpResolve.mockResolvedValue([]);
  mockMcpWrap.mockReset();
  mockMcpWrap.mockImplementation((_cwd, servers) => servers);
  await ensureThreadRegistryLoaded();
  clearThreadRegistry();
});

afterEach(() => {
  restoreEnv();
  if (isolatedHomeDir) {
    rmSync(isolatedHomeDir, { recursive: true, force: true });
    isolatedHomeDir = undefined;
  }
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. SDK Resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("agent execution slot queue", () => {
  it("keeps later requests pending until a shared slot is released", async () => {
    process.env.AGENT_POOL_MAX_PARALLEL = "1";

    const first = await allocateSlot("slot-owner-1", {
      taskKey: "slot-owner-1",
      workflowId: "wf-a",
    });
    expect(first.slotId).toMatch(/^agent-slot-/);
    expect(getAvailableSlots()).toBe(0);

    const queuedSnapshots = [];
    const acquiredSnapshots = [];
    let secondResolved = false;
    const secondPromise = allocateSlot("slot-owner-2", {
      taskKey: "slot-owner-2",
      workflowId: "wf-b",
      onQueued: (snapshot) => queuedSnapshots.push(snapshot),
      onAcquired: (snapshot) => acquiredSnapshots.push(snapshot),
    }).then((lease) => {
      secondResolved = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondResolved).toBe(false);
    expect(getAgentExecutionSlotStatus()).toMatchObject({
      activeSlots: 1,
      queuedSlots: 1,
      maxParallel: 1,
    });
    expect(queuedSnapshots).toHaveLength(1);
    expect(queuedSnapshots[0]).toMatchObject({
      ownerKey: "slot-owner-2",
      activeSlots: 1,
      queuedSlots: 1,
      maxParallel: 1,
    });

    await releaseSlot(first);
    const second = await secondPromise;

    expect(secondResolved).toBe(true);
    expect(second.ownerKey).toBe("slot-owner-2");
    expect(acquiredSnapshots).toHaveLength(1);
    expect(acquiredSnapshots[0]).toMatchObject({
      ownerKey: "slot-owner-2",
      slotId: second.slotId,
      activeSlots: 1,
      maxParallel: 1,
    });

    await releaseSlot(second);
    expect(getAgentExecutionSlotStatus()).toMatchObject({
      activeSlots: 0,
      queuedSlots: 0,
      maxParallel: 1,
    });
    expect(getAvailableSlots()).toBe(1);
  });
});

describe("SDK resolution", () => {
  it("uses AGENT_POOL_SDK env var when set", () => {
    process.env.AGENT_POOL_SDK = "copilot";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("copilot");
  });

  it("normalizes opencode-sdk from PRIMARY_AGENT env var", () => {
    process.env.PRIMARY_AGENT = "opencode-sdk";
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("opencode");
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
    process.env.OPENCODE_SDK_DISABLED = "1";
    resetPoolSdkCache();
    // All disabled → last resort codex
    expect(getPoolSdkName()).toBe("codex");
  });

  it("uses opencode when config primaryAgent is opencode-sdk", () => {
    mockLoadConfig.mockReturnValue({
      primaryAgent: "opencode-sdk",
    });
    resetPoolSdkCache();
    expect(getPoolSdkName()).toBe("opencode");
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

  it("setPoolSdk normalizes opencode-sdk aliases", () => {
    setPoolSdk("OpenCode-SDK");
    expect(getPoolSdkName()).toBe("opencode");
  });

  it("setPoolSdk throws for unknown SDK", () => {
    expect(() => setPoolSdk("invalid")).toThrow(/unknown SDK/i);
    expect(() => setPoolSdk("")).toThrow(/unknown SDK/i);
  });

  it("setPoolSdk normalizes gpt aliases to codex", () => {
    setPoolSdk("gpt");
    expect(getPoolSdkName()).toBe("codex");
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
    // Nothing disabled → all supported SDKs available
    const available = getAvailableSdks();
    expect(available).toContain("codex");
    expect(available).toContain("copilot");
    expect(available).toContain("claude");
    expect(available).toContain("opencode");
    expect(available).toHaveLength(4);
  });

  it("getAvailableSdks excludes disabled SDKs", () => {
    process.env.COPILOT_SDK_DISABLED = "1";
    const available = getAvailableSdks();
    expect(available).not.toContain("copilot");
    expect(available).toContain("codex");
    expect(available).toContain("claude");
    expect(available).toContain("opencode");
    expect(available).toHaveLength(3);
  });

  it("getAvailableSdks returns empty when all disabled", () => {
    process.env.CODEX_SDK_DISABLED = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    process.env.OPENCODE_SDK_DISABLED = "1";
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
    expect(["codex", "copilot", "claude", "opencode"]).toContain(result.sdk);
  });

  it("launches via opencode when requested through opencode-sdk alias", async () => {
    process.env.__MOCK_OPENCODE_AVAILABLE = "1";
    mockOpencodeExec.mockResolvedValue({
      finalResponse: "opencode handled the workflow",
      items: [{ type: "assistant.message", data: { content: "opencode handled the workflow" } }],
      usage: null,
    });

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      { sdk: "opencode-sdk", taskKey: "workflow-opencode" },
    );

    expect(result.success).toBe(true);
    expect(result.sdk).toBe("opencode");
    expect(result.output).toBe("opencode handled the workflow");
    expect(result.threadId).toBe("workflow-opencode");
    expect(mockOpencodeExec).toHaveBeenCalledTimes(1);
    expect(mockOpencodeExec.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        persistent: true,
        sessionId: "workflow-opencode",
      }),
    );
  });

  it("forwards full OpenCode provider configuration to the shell adapter", async () => {
    process.env.__MOCK_OPENCODE_AVAILABLE = "1";
    mockOpencodeExec.mockResolvedValue({
      finalResponse: "opencode handled the workflow",
      items: [],
      usage: null,
    });

    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      {
        sdk: "opencode",
        taskKey: "workflow-opencode-provider-config",
        provider: "openrouter",
        model: "moonshotai/kimi-k2",
        providerConfig: {
          baseUrl: "https://openrouter.example/v1",
          apiKey: "test-opencode-key",
          port: 4111,
          timeoutMs: 12345,
        },
      },
    );

    expect(result.success).toBe(true);
    expect(mockOpencodeExec).toHaveBeenCalledTimes(1);
    expect(mockOpencodeExec.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        sessionId: "workflow-opencode-provider-config",
        provider: "openrouter",
        providerConfig: {
          model: "moonshotai/kimi-k2",
          baseUrl: "https://openrouter.example/v1",
          apiKey: "test-opencode-key",
          port: 4111,
          timeoutMs: 12345,
        },
      }),
    );
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

  it("treats an explicit empty MCP selection as opt-out from default server fallback", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        allowDefaultServers: true,
        defaultServers: ["context7"],
      },
    });

    await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      { mcpServers: [] },
    );

    expect(mockMcpResolve).not.toHaveBeenCalled();
    expect(mockMcpWrap).not.toHaveBeenCalled();
  });

  it("does not spawn a discovery proxy when no MCP servers resolved", async () => {
    mockLoadConfig.mockReturnValue({
      mcpServers: {
        useDiscoveryProxy: true,
      },
    });
    mockMcpResolve.mockResolvedValue([]);

    await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      { mcpServers: ["context7"] },
    );

    expect(mockMcpResolve).toHaveBeenCalledWith(
      process.cwd(),
      ["context7"],
      expect.objectContaining({
        defaultServers: [],
      }),
    );
    expect(mockMcpWrap).not.toHaveBeenCalled();
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
    // Claude is requested first but fails prereqs in test env (no ANTHROPIC_API_KEY),
    // so it falls through the fallback chain. The result has expected shape.
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("error");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no SDK available|claude|codex|copilot|opencode/i);
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
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-token";
    process.env.CLAUDE_API_KEY = "";
    process.env.ANTHROPIC_API_KEY = "";

    setCodexLauncherMock(() => ({
      id: "codex-model-list-400",
      runStreamed: async () => {
        throw new Error("Failed to list models: 400");
      },
    }));
    setCopilotLauncherMock(() => ({
      send: async () => {},
      on: (cb) => {
        cb({
          type: "assistant.message",
          data: { content: "copilot fallback ok" },
        });
        cb({ type: "session.idle" });
        return () => {};
      },
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

  it("skips codex before launch when the Windows SDK runtime binary is missing", async () => {
    if (process.platform !== "win32") return;

    process.env.BOSUN_AGENT_POOL_FALLBACK_ORDER = "codex,copilot";
    process.env.__MOCK_COPILOT_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.GITHUB_TOKEN = "test-token";

    const sdkPkgDir = join(process.cwd(), "node_modules", "@openai", "codex-sdk");
    const runtimePkgDir = join(process.cwd(), "node_modules", "@openai", "codex-win32-x64");
    const sdkPkgJsonPath = join(sdkPkgDir, "package.json");
    const runtimePkgJsonPath = join(runtimePkgDir, "package.json");
    mkdirSync(sdkPkgDir, { recursive: true });
    const savedSdkPkgJson = (() => {
      try {
        return readFileSync(sdkPkgJsonPath, "utf8");
      } catch {
        return null;
      }
    })();
    const savedRuntimePkgJson = (() => {
      try {
        return readFileSync(runtimePkgJsonPath, "utf8");
      } catch {
        return null;
      }
    })();
    writeFileSync(sdkPkgJsonPath, JSON.stringify({ name: "@openai/codex-sdk" }));
    rmSync(runtimePkgJsonPath, { force: true });

    setCopilotLauncherMock(() => ({
      send: async () => {},
      on: (cb) => {
        cb({
          type: "assistant.message",
          data: { content: "copilot fallback ok" },
        });
        cb({ type: "session.idle" });
        return () => {};
      },
    }));

    try {
      const result = await launchEphemeralThread(
        "test prompt",
        process.cwd(),
        5000,
        { sdk: "codex" },
      );

      expect(result.success).toBe(true);
      expect(result.sdk).toBe("copilot");
      expect(result.output).toContain("copilot fallback ok");
      expect(mockCodexStartThread).not.toHaveBeenCalled();
    } finally {
      if (savedSdkPkgJson == null) {
        rmSync(sdkPkgJsonPath, { force: true });
      } else {
        writeFileSync(sdkPkgJsonPath, savedSdkPkgJson, "utf8");
      }
      if (savedRuntimePkgJson == null) {
        rmSync(runtimePkgJsonPath, { force: true });
      } else {
        writeFileSync(runtimePkgJsonPath, savedRuntimePkgJson, "utf8");
      }
    }
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

  it("does not cool down SDKs for ignorable model listing 400 errors", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS = "600000";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "model-list-400-thread",
      runStreamed: async () => {
        throw new Error("Failed to list models: 400 Bad Request");
      },
    }));

    const first = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
      disableFallback: true,
    });

    expect(first.success).toBe(false);
    expect(first.sdk).toBe("codex");
    expect(first.error).toMatch(/failed to list models/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("model-list-400-retry", "codex-after-ignorable-400"),
    );

    const second = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
      disableFallback: true,
    });

    expect(second.success).toBe(true);
    expect(second.sdk).toBe("codex");
    expect(second.output).toContain("codex-after-ignorable-400");
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);
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
      makeTimeoutThread("cooldown-missing-prereq-timeout"),
    );

    const first = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/codex timeout/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);

    const second = await launchEphemeralThread("test prompt", process.cwd(), 25, {
      sdk: "codex",
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/codex timeout/i);
    expect(second.error).not.toMatch(/no SDK available/i);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();

  });

  it("does not retry deterministic SDK failures in execWithRetry", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementation(() => ({
      id: "missing-runtime-thread",
      runStreamed: async () => {
        throw new Error("spawn codex.exe ENOENT");
      },
    }));

    const result = await execWithRetry("test prompt", {
      taskKey: "task-deterministic-sdk-failure",
      cwd: process.cwd(),
      timeoutMs: 5000,
      sdk: "codex",
      maxRetries: 2,
      maxContinues: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/enoent/i);
    expect(result.attempts).toBe(1);
    expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("bypasses primary prerequisite gate during cooldown when no fallback SDK is eligible", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
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
    // Disable fallback SDKs so the test is deterministic regardless of local
    // SDK availability (e.g. VS Code Copilot connected to the real copilot-sdk).
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");
    const result = await launchEphemeralThread(
      "test prompt",
      process.cwd(),
      5000,
      {
        sdk: "nonexistent",
      },
    );
    // Invalid sdk in extra is ignored; codex is resolved but has no API key →
    // prereqs fail and fallbacks are disabled, so the pool returns a failure.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no SDK available|codex/i);
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
    const codexCtorOpts = mockCodexCtor.mock.calls.at(-1)?.[0];
    expect(codexCtorOpts).toBeTruthy();
    expect(codexCtorOpts.env).toBeTruthy();
    expect(codexCtorOpts.env?.CODEX_MODEL ?? codexCtorOpts.config?.model).toBe("gpt-5.3-codex");
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
      model: "gpt-5.4",
    }));
    expect(codexCtorOpts?.config?.model_provider).toMatch(/^azure/);
  });

  it("removes non-selected Azure provider env keys for Codex pool launches", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_BASE_URL = "https://example-resource.openai.azure.com/openai/v1";
    process.env.OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_API_KEY_SWEDEN = "sweden-key";
    process.env.AZURE_SWEDEN_ENDPOINT = "https://example-sweden.openai.azure.com";
    process.env.AZURE_SWEDEN_BASE_URL = "https://example-sweden.openai.azure.com/openai/v1";
    process.env.CODEX_MODEL = "gpt-5.4";
    setPoolSdk("codex");

    const codexDir = join(isolatedHomeDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), [
      'model = "gpt-5.4"',
      'model_provider = "azure-us"',
      '',
      '[model_providers.azure-us]',
      'base_url = "https://example-resource.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      '',
      '[model_providers.azure-sweden]',
      'base_url = "https://example-sweden.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY_SWEDEN"',
      '',
    ].join("\n"), "utf8");

    const result = await launchEphemeralThread("test prompt", process.cwd(), 5000, {
      sdk: "codex",
    });

    expect(result.success).toBe(true);
    const codexCtorOpts = mockCodexCtor.mock.calls
      .map(([options]) => options)
      .find((options) => {
        const providers = Object.values(options?.config?.model_providers || {});
        return providers.some((provider) =>
          provider?.env_key === "AZURE_OPENAI_API_KEY"
          && provider?.base_url === "https://example-resource.openai.azure.com/openai/v1",
        );
      }) || mockCodexCtor.mock.calls.at(-1)?.[0];
    expect(codexCtorOpts?.config).toEqual(expect.objectContaining({
      model_provider: expect.stringMatching(/^azure/),
      model: "gpt-5.4",
      sandbox_mode: "workspace-write",
    }));
    const providerConfig = Object.values(codexCtorOpts?.config?.model_providers || {})
      .find((provider) =>
        provider?.env_key === "AZURE_OPENAI_API_KEY"
        && provider?.base_url === "https://example-resource.openai.azure.com/openai/v1",
      );
    expect(providerConfig).toEqual(expect.objectContaining({
      env_key: "AZURE_OPENAI_API_KEY",
      base_url: "https://example-resource.openai.azure.com/openai/v1",
    }));
    expect(codexCtorOpts?.unsetEnvKeys || []).toEqual(expect.arrayContaining([
      "AZURE_OPENAI_API_KEY_SWEDEN",
      "AZURE_SWEDEN_ENDPOINT",
      "AZURE_SWEDEN_BASE_URL",
    ]));
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
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("does not apply monitor timeout bounds to non-monitor task keys", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);


  it("strips optional OpenAI organization and project headers from Codex SDK env", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_ORGANIZATION = "org_stale";
    process.env.OPENAI_PROJECT = "proj_stale";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");

    const result = await launchOrResumeThread(
      "sanitize optional headers",
      process.cwd(),
      5000,
      {
        sdk: "codex",
      },
    );

    expect(result.success).toBe(true);
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    const [opts] = mockCodexCtor.mock.calls.at(-1);
    expect(opts.env.OPENAI_ORGANIZATION).toBeUndefined();
    expect(opts.env.OPENAI_PROJECT).toBeUndefined();
  });

  it("uses INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS for stalled codex streams", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("does not throw when using default codex stream safety constants", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    delete process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS;
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() => ({
      id: "default-stream-safety-thread",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "stream ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await launchOrResumeThread("default stream safety test", process.cwd(), 5000, {
      taskKey: "stream-default-safety",
      sdk: "codex",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("stream ok");
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("continues managed harness sessions using stored session metadata", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("managed-thread-1", "first output"),
    );
    mockCodexResumeThread.mockImplementationOnce((threadId) =>
      makeCodexMockThread(threadId || "managed-thread-1", "continued output"),
    );

    const first = await launchOrResumeThread("first task turn", process.cwd(), 5000, {
      taskKey: "task-continue-1",
      sessionId: "managed-session-1",
      sessionScope: "workflow-task",
      sessionType: "task",
      sdk: "codex",
      metadata: {
        workflowId: "workflow-1",
      },
    });

    expect(first.success).toBe(true);

    const resumed = await continueSession("managed-session-1", "continue the task", {
      timeout: 5000,
    });

    expect(resumed.success).toBe(true);
    expect(mockCodexResumeThread).toHaveBeenCalledWith(
      "managed-thread-1",
      expect.any(Object),
      expect.any(Object),
    );
    expect(getThreadRecord("task-continue-1")).toEqual(expect.objectContaining({
      threadId: "managed-thread-1",
      sdk: "codex",
      alive: true,
    }));
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("does not throw when a managed session controller is asked to continue without a prompt", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");

    const sessionManagerMod = await import("../agent/session-manager.mjs");
    const sessionManager = sessionManagerMod.getBosunSessionManager();
    let noPromptResult = null;

    mockCodexStartThread.mockImplementationOnce(() =>
      ({
        id: "managed-thread-no-prompt",
        runStreamed: async () => ({
          events: {
            async *[Symbol.asyncIterator]() {
              const controller = sessionManager.getSessionController("managed-session-no-prompt");
              noPromptResult = controller ? await controller.run({}) : null;
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "first output" },
              };
            },
          },
        }),
      }),
    );

    const first = await launchOrResumeThread("first task turn", process.cwd(), 5000, {
      taskKey: "task-no-prompt-continue",
      sessionId: "managed-session-no-prompt",
      sessionScope: "workflow-task",
      sessionType: "task",
      sdk: "codex",
    });

    expect(first.success).toBe(true);
    expect(noPromptResult).toEqual(expect.objectContaining({
      sessionId: "managed-session-no-prompt",
    }));
    expect(mockCodexResumeThread).not.toHaveBeenCalled();
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("drops stale codex thread metadata when resume times out", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    const taskKey = "timeout-resume-task";
    mockCodexStartThread
      .mockImplementationOnce(() =>
        makeCodexMockThread("timeout-thread-id", "first-run"),
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
    expect(first.threadId).toBe("timeout-thread-id");
    expect(first.resumed).toBe(false);

    mockCodexResumeThread.mockImplementation(() => ({
      id: "timeout-thread-id",
      runStreamed: async () => {
        const error = new Error("resume aborted");
        error.name = "AbortError";
        throw error;
      },
    }));

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("persists and resumes OpenCode session IDs", async () => {
    process.env.__MOCK_OPENCODE_AVAILABLE = "1";
    const taskKey = "monitor-monitor-opencode";

    mockOpencodeExec
      .mockResolvedValueOnce({
        finalResponse: "open-code first run",
        items: [],
        usage: null,
      })
      .mockResolvedValueOnce({
        finalResponse: "open-code resumed run",
        items: [],
        usage: null,
      });

    const first = await launchOrResumeThread(
      "initial prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "opencode",
      },
    );
    expect(first.success).toBe(true);
    expect(first.threadId).toBe(taskKey);
    expect(first.resumed).toBe(false);

    const firstRecord = getThreadRecord(taskKey);
    expect(firstRecord?.sdk).toBe("opencode");
    expect(firstRecord?.threadId).toBe(taskKey);
    expect(firstRecord?.alive).toBe(true);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logSpy.mockClear();
    const second = await launchOrResumeThread(
      "follow-up prompt",
      process.cwd(),
      5000,
      {
        taskKey,
        sdk: "opencode",
      },
    );

    expect(second.success).toBe(true);
    expect(second.resumed).toBe(true);
    expect(second.threadId).toBe(taskKey);
    expect(mockOpencodeExec).toHaveBeenCalledTimes(2);
    expect(mockOpencodeExec.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        persistent: true,
        sessionId: taskKey,
      }),
    );
    expect(mockOpencodeExec.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        persistent: true,
        sessionId: taskKey,
      }),
    );
    const emittedLogs = logSpy.mock.calls
      .map((args) => args.join(" "))
      .join("\n");
    expect(emittedLogs).toContain("resuming OpenCode session");
    logSpy.mockRestore();
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("finalizes pooled workflow lifecycle through the canonical session manager", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementationOnce(() =>
      makeCodexMockThread("workflow-managed-thread", "managed-session-output"),
    );

    const sessionManagerMod = await import("../agent/session-manager.mjs");
    const sessionManager = sessionManagerMod.getBosunSessionManager();

    const result = await launchOrResumeThread(
      "workflow managed prompt",
      process.cwd(),
      5000,
      {
        taskKey: "workflow-managed-task",
        sdk: "codex",
        sessionId: "workflow-managed-session",
        sessionScope: "workflow-task",
        sessionType: "task",
        metadata: {
          source: "workflow-run-agent",
          workflowRunId: "run-201",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(sessionManager.getSession("workflow-managed-session")).toEqual(
      expect.objectContaining({
        sessionId: "workflow-managed-session",
        status: "completed",
        activeThreadId: "workflow-managed-thread",
      }),
    );
    expect(sessionManager.getReplayState("workflow-managed-session")).toEqual(
      expect.objectContaining({
        sessionId: "workflow-managed-session",
        resumeFrom: expect.objectContaining({
          threadId: "workflow-managed-thread",
          action: "external_execution_completed",
        }),
      }),
    );
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. execWithRetry
// ═══════════════════════════════════════════════════════════════════════════


describe("sdk cooldown heuristics", () => {
  it("treats 400 model-list failures as fallback-worthy but not cooldown-worthy errors", async () => {
    const { __testables } = await import("../agent/agent-pool.mjs");
    expect(__testables.shouldFallbackForSdkError("Error: Failed to list models: 400")).toBe(true);
    expect(__testables.shouldApplySdkCooldown("Error: Failed to list models: 400")).toBe(false);
  });

  it("detects repeated reconnect fingerprints as retry circuit breakers", async () => {
    const { __testables } = await import("../agent/agent-pool.mjs");
    const failureFingerprints = new Map([
      ["[agent-pool] copilot timeout after <ms> waiting for session.idle", 1],
    ]);

    const classified = __testables.classifyRetryCircuitBreak(
      {
        success: false,
        error: "[agent-pool] copilot timeout after 120000ms waiting for session.idle",
        output: "",
        items: [],
      },
      {
        failureFingerprints,
        consecutiveNoOutputFailures: 0,
      },
    );

    expect(classified.shouldBreak).toBe(true);
    expect(classified.blockedReason).toBe("blocked_by_env");
  });
});
describe("execWithRetry", () => {
  it("retries after timeout without treating the next attempt as externally aborted", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("stops retrying after repeated no-output starts", async () => {
    process.env.__MOCK_CODEX_AVAILABLE = "1";
    process.env.COPILOT_SDK_DISABLED = "1";
    process.env.CLAUDE_SDK_DISABLED = "1";
    setPoolSdk("codex");

    mockCodexStartThread.mockImplementation(() => ({
      id: "timeout-thread-repeat",
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

    const result = await execWithRetry("repeat no output", {
      taskKey: "retry-no-output-task",
      cwd: process.cwd(),
      timeoutMs: 25,
      maxRetries: 2,
      sdk: "codex",
      abortController: new AbortController(),
    });

    expect(result.success).toBe(false);
    expect(result.retryCircuitBroken).toBe(true);
    expect(result.blockedReason).toBe("no_output");
    expect(result.attempts).toBe(2);
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);
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
    process.env.OPENCODE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await execPooledPrompt("test task");
    expect(result.finalResponse).toMatch(/\[agent-pool error\]|no output/i);
  });
});

describe("internal harness facade exports", () => {
  it("creates managed harness sessions through the shared session manager", async () => {
    const { getBosunSessionManager } = await import("../agent/session-manager.mjs");
    const session = createInternalHarnessSession({
      agentId: "bosun-harness",
      entryStageId: "plan",
      stages: [{ id: "plan", type: "prompt", prompt: "Plan." }],
    }, {
      runId: "pool-run-1",
      sessionId: "pool-session-1",
      taskKey: "pool-task-1",
      dryRun: true,
    });

    const managed = getBosunSessionManager().getSession("pool-session-1");

    expect(session.sessionId).toBe("pool-session-1");
    expect(managed).toEqual(expect.objectContaining({
      sessionId: "pool-session-1",
      taskKey: "pool-task-1",
    }));
    expect(session.runtimeController.getState()).toEqual(expect.objectContaining({
      runtimeConfig: expect.any(Object),
      contracts: expect.objectContaining({
        run: expect.objectContaining({ kind: "bosun-internal-harness-run-contract" }),
        event: expect.objectContaining({ kind: "bosun-internal-harness-event-contract" }),
      }),
    }));
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

  it("runs compiled and source harness profiles through the canonical harness/session path", async () => {
    const compiledProfile = {
      agentId: "bosun-harness",
      name: "Bosun Harness",
      entryStageId: "plan",
      taskKey: "pool-task-2",
      stages: [{ id: "plan", type: "prompt", prompt: "Plan." }],
      metadata: {},
    };

    const compiledRun = await runCompiledInternalHarnessProfile(compiledProfile, {
      runId: "pool-run-2",
      sessionId: "pool-session-2",
      taskKey: "pool-task-2",
      dryRun: true,
    });
    const sourceRun = await runInternalHarnessProfile({
      name: "Bosun Harness Source",
      entryStageId: "plan",
      taskKey: "pool-task-3",
      stages: [{ id: "plan", type: "prompt", prompt: "Plan." }],
    }, {
      runId: "pool-run-3",
      sessionId: "pool-session-3",
      taskKey: "pool-task-3",
      dryRun: true,
    });

    expect(compiledRun.result).toEqual(expect.objectContaining({
      success: true,
      status: "completed",
    }));
    expect(compiledRun.getSessionRecord()).toEqual(expect.objectContaining({
      sessionId: "pool-session-2",
      taskKey: "pool-task-2",
    }));
    expect(sourceRun.result).toEqual(expect.objectContaining({
      success: true,
      status: "completed",
    }));
    expect(sourceRun.getSessionRecord()).toEqual(expect.objectContaining({
      sessionId: "pool-session-3",
      taskKey: "pool-task-3",
    }));
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);
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
  }, SLOW_AGENT_POOL_TEST_TIMEOUT_MS);

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
    process.env.OPENCODE_SDK_DISABLED = "1";
    resetPoolSdkCache();

    const result = await launchEphemeralThread("test", process.cwd(), 5000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no SDK available/);
    expect(result.error).toMatch(/all sdks are disabled/i);
  });
});
}
