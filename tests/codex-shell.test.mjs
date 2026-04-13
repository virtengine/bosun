import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15_000 });

const mockCodexCtor = vi.fn();
const mockStartThread = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    constructor(options) {
      mockCodexCtor(options);
    }

    startThread(...args) {
      return mockStartThread(...args);
    }
  },
}));

vi.mock("../shell/codex-sdk-import.mjs", () => ({
  Codex: class MockCodex {
    constructor(options) {
      mockCodexCtor(options);
    }

    startThread(...args) {
      return mockStartThread(...args);
    }
  },
}));

vi.mock("../agent/agent-sdk.mjs", () => ({
  resolveAgentSdkConfig: vi.fn(() => ({
    primary: "codex",
    capabilities: { steering: true },
  })),
  resolveCodexSdkInstall: vi.fn(() => ({
    entryPath: join(process.cwd(), "node_modules", "@openai", "codex-sdk", "dist", "index.js"),
    rootDir: process.cwd(),
  })),
}));

vi.mock("../config/repo-root.mjs", () => ({
  resolveRepoRoot: vi.fn(() => process.cwd()),
}));

vi.mock("../shell/codex-model-profiles.mjs", () => ({
  resolveCodexProfileRuntime: vi.fn(() => ({ env: {} })),
  readCodexConfigRuntimeDefaults: vi.fn(() => ({ model: "", modelProvider: "", providers: {} })),
}));

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({
    internalExecutor: {
      stream: {
        firstEventTimeoutMs: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS || 120000,
        ),
        maxItemsPerTurn: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN || 600,
        ),
        maxItemChars: Number(
          process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS || 12000,
        ),
      },
    },
  })),
}));

vi.mock("../infra/stream-resilience.mjs", () => ({
  MAX_STREAM_RETRIES: 2,
  streamRetryDelay: () => 0,
  isTransientStreamError: (err) =>
    String(err?.message || "").toLowerCase().includes("stream disconnected"),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

const {
  execCodexPrompt,
  getSessionStoreDir,
  resetThread,
} = await import("../shell/codex-shell.mjs");
const {
  resolveCodexProfileRuntime,
  readCodexConfigRuntimeDefaults,
} = await import("../shell/codex-model-profiles.mjs");

async function loadFreshCodexShell() {
  vi.resetModules();
  const shellModule = await import("../shell/codex-shell.mjs");
  const profileModule = await import("../shell/codex-model-profiles.mjs");
  return {
    ...shellModule,
    resolveCodexProfileRuntime: profileModule.resolveCodexProfileRuntime,
    readCodexConfigRuntimeDefaults: profileModule.readCodexConfigRuntimeDefaults,
  };
}

const ENV_KEYS = [
  "BOSUN_HOST_PLATFORM",
  "HOME",
  "INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY_SWEDEN",
  "CODEX_MODEL",
  "TEMP",
  "TMP",
  "USERPROFILE",
];

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

describe("codex-shell stream safeguards", () => {
  beforeEach(async () => {
    saveEnv();
    mockCodexCtor.mockReset();
    mockStartThread.mockReset();
    resolveCodexProfileRuntime.mockReturnValue({ env: {} });
    readCodexConfigRuntimeDefaults.mockReturnValue({ model: "", modelProvider: "", providers: {} });
    await resetThread();
  });

  afterEach(async () => {
    restoreEnv();
    await resetThread();
  });

  it("primes Codex with native structured-edit guidance before MCP fallbacks", async () => {
    let receivedPrompt = "";
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-edit-guidance",
      runStreamed: async (prompt) => {
        receivedPrompt = String(prompt || "");
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "ok" },
              };
              yield { type: "turn.completed" };
            },
          },
        };
      },
    }));

    const result = await execCodexPrompt("apply the requested code change", {
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("ok");
    expect(receivedPrompt).toContain("PREFER native Codex edit tools first");
    expect(receivedPrompt).toContain("replace_lines");
    expect(receivedPrompt).toContain("Never leave repo-root scratch artifacts behind");
    expect(receivedPrompt).toContain("do not create `.tmp-*`");
  });

  it("stores shell-private session state outside the chat history session directory", async () => {
    const normalized = getSessionStoreDir().replace(/\\/g, "/");
    expect(normalized.endsWith("/logs/codex-shell-sessions")).toBe(true);
    expect(normalized.endsWith("/logs/sessions")).toBe(false);
  });

  it("allows concurrent persistent turns in different sessions", async () => {
    let releaseFirstTurn;
    let markFirstRunning;
    const firstRunning = new Promise((resolve) => {
      markFirstRunning = resolve;
    });
    let startCount = 0;

    mockStartThread.mockImplementation(() => {
      startCount += 1;
      const threadIndex = startCount;
      return {
        id: `codex-test-thread-concurrent-${threadIndex}`,
        runStreamed: async () => {
          if (threadIndex === 1) {
            markFirstRunning();
            return {
              events: {
                async *[Symbol.asyncIterator]() {
                  await new Promise((resolve) => {
                    releaseFirstTurn = resolve;
                  });
                  yield {
                    type: "item.completed",
                    item: { type: "agent_message", text: "first session completed" },
                  };
                  yield { type: "turn.completed" };
                },
              },
            };
          }
          return {
            events: {
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "item.completed",
                  item: { type: "agent_message", text: "second session completed" },
                };
                yield { type: "turn.completed" };
              },
            },
          };
        },
      };
    });

    const firstPromise = execCodexPrompt("run first session", {
      persistent: true,
      sessionId: "persistent-a",
      timeoutMs: 5000,
    });
    await firstRunning;

    const second = await execCodexPrompt("run second session", {
      persistent: true,
      sessionId: "persistent-b",
      timeoutMs: 5000,
    });

    expect(second.finalResponse).toContain("second session completed");
    expect(startCount).toBe(2);

    releaseFirstTurn();
    const first = await firstPromise;
    expect(first.finalResponse).toContain("first session completed");
  }, 15000);

  it("returns normalized usage from streamed turn completion events", async () => {
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-usage",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "usage-aware result" },
            };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 210,
                output_tokens: 45,
                total_tokens: 255,
                input_tokens_details: { cached_tokens: 33 },
              },
            };
          },
        },
      }),
    }));

    const result = await execCodexPrompt("capture usage", {
      persistent: true,
      sessionId: "usage-session",
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("usage-aware result");
    expect(result.usage).toEqual(expect.objectContaining({
      inputTokens: 210,
      outputTokens: 45,
      totalTokens: 255,
      cacheInputTokens: 33,
    }));
  });

  it("retries when first stream event never arrives", async () => {
    process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS = "1000";

    let runAttempt = 0;
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-timeout",
      runStreamed: async (_prompt, { signal } = {}) => {
        runAttempt += 1;
        if (runAttempt === 1) {
          return {
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
          };
        }

        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "recovered output" },
              };
              yield { type: "turn.completed" };
            },
          },
        };
      },
    }));

    const result = await execCodexPrompt("recover from stalled stream", {
      timeoutMs: 2500,
    });

    expect(result.finalResponse).toContain("recovered output");
    expect(runAttempt).toBe(2);
  });


  it("avoids reserved built-in openai provider ids for custom base URLs", async () => {
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
    } = await loadFreshCodexShell();

    await freshResetThread();
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.CODEX_MODEL = "gpt-5.4";
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_BASE_URL: "https://example.test/v1",
        OPENAI_API_KEY: "test-key",
        CODEX_MODEL: "gpt-5.4",
      },
      configProvider: null,
    });

    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-provider",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    await freshExecCodexPrompt("test custom provider", { timeoutMs: 1000 });

    const ctorOptions = mockCodexCtor.mock.calls
      .map((call) => call?.[0] || null)
      .find((options) => options?.config?.model_provider);
    expect(ctorOptions).toBeDefined();
    expect(ctorOptions.config.model_provider).toBeDefined();
    expect(ctorOptions.config.model_provider).not.toBe("openai");
    expect(ctorOptions.config.model_provider).not.toBe("azure");
  });
  it("caps retained items and truncates oversized item payloads", async () => {
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN = "1";
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS = "12";

    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-caps",
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
                aggregated_output: "this item should be dropped",
              },
            };
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "final answer",
              },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await execCodexPrompt("test item cap", {
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("final answer");
    expect(result.items.length).toBe(2);
    expect(result.items[0].aggregated_output).toContain("…truncated");
    expect(result.items[1]).toMatchObject({ type: "stream_notice" });
  });

  it("resets thread and retries when API reports broken reasoning chain", async () => {
    let runAttempt = 0;
    mockStartThread.mockImplementation(() => ({
      id: `codex-test-thread-recoverable-${Date.now()}-${Math.random()}`,
      runStreamed: async () => {
        runAttempt += 1;
        if (runAttempt === 1) {
          throw new Error(
            "Item 'rs_test' of type 'reasoning' was provided without its required following item.",
          );
        }
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text: "recovered after thread reset" },
              };
              yield { type: "turn.completed" };
            },
          },
        };
      },
    }));

    const result = await execCodexPrompt("recover from malformed reasoning state", {
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("recovered after thread reset");
    expect(runAttempt).toBe(2);
  });

  it("does not inject reserved openai provider sections for default OpenAI", async () => {
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_API_KEY: "test-key",
        CODEX_MODEL: "gpt-5.4",
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-openai",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "openai ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await freshExecCodexPrompt("openai runtime", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("openai ok");
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    const ctorOptions = mockCodexCtor.mock.calls.at(-1)?.[0] || {};
    expect(ctorOptions.config?.model_providers || {}).not.toEqual(expect.objectContaining({
      azure: expect.anything(),
    }));
  });

  it("strips OPENAI_BASE_URL and configures Azure provider overrides", async () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
        OPENAI_API_KEY: "azure-key",
        CODEX_MODEL: "gpt-5.4",
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-azure",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "azure ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await freshExecCodexPrompt("azure runtime", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("azure ok");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.AZURE_OPENAI_API_KEY).toBe("azure-key");
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    expect(mockCodexCtor).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        model_provider: "azure",
        model: "gpt-5.4",
        model_providers: expect.objectContaining({
          azure: expect.objectContaining({
            base_url: "https://example-resource.openai.azure.com/openai/v1",
            env_key: "AZURE_OPENAI_API_KEY",
            wire_api: "responses",
          }),
        }),
      }),
    }));
  });

  it("removes non-selected Azure provider env keys before SDK startup", async () => {
    process.env.AZURE_OPENAI_API_KEY_SWEDEN = "sweden-key";
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
      readCodexConfigRuntimeDefaults: freshReadCodexConfigRuntimeDefaults,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
        OPENAI_API_KEY: "azure-key",
        CODEX_MODEL: "gpt-5.4",
        AZURE_OPENAI_API_KEY_SWEDEN: "sweden-key",
      },
      configProvider: {
        name: "azure-us",
        envKey: "AZURE_OPENAI_API_KEY",
      },
    });
    freshReadCodexConfigRuntimeDefaults.mockReturnValue({
      model: "gpt-5.4",
      modelProvider: "azure-us",
      providers: {
        "azure-us": {
          name: "azure-us",
          baseUrl: "https://example-resource.openai.azure.com/openai/v1",
          envKey: "AZURE_OPENAI_API_KEY",
        },
        "azure-sweden": {
          name: "azure-sweden",
          baseUrl: "https://example-sweden.openai.azure.com/openai/v1",
          envKey: "AZURE_OPENAI_API_KEY_SWEDEN",
        },
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-azure-multi-provider",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "azure provider sanitized" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await freshExecCodexPrompt("azure runtime multi-provider", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("azure provider sanitized");
    expect(process.env.AZURE_OPENAI_API_KEY_SWEDEN).toBeUndefined();
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    expect(mockCodexCtor).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        model_provider: "azure-us",
        model: "gpt-5.4",
        model_providers: expect.objectContaining({
          "azure-us": expect.objectContaining({
            base_url: "https://example-resource.openai.azure.com/openai/v1",
            env_key: "AZURE_OPENAI_API_KEY",
          }),
        }),
      }),
    }));
  });

  it("sanitizes Azure provider env keys during init preload", async () => {
    process.env.AZURE_OPENAI_API_KEY_SWEDEN = "sweden-key";
    const {
      execCodexPrompt: freshExecCodexPrompt,
      initCodexShell: freshInitCodexShell,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
      readCodexConfigRuntimeDefaults: freshReadCodexConfigRuntimeDefaults,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
        OPENAI_API_KEY: "azure-key",
        CODEX_MODEL: "gpt-5.4",
        AZURE_OPENAI_API_KEY_SWEDEN: "sweden-key",
      },
      configProvider: {
        name: "azure-us",
        envKey: "AZURE_OPENAI_API_KEY",
      },
    });
    freshReadCodexConfigRuntimeDefaults.mockReturnValue({
      model: "gpt-5.4",
      modelProvider: "azure-us",
      providers: {
        "azure-us": {
          name: "azure-us",
          baseUrl: "https://example-resource.openai.azure.com/openai/v1",
          envKey: "AZURE_OPENAI_API_KEY",
        },
        "azure-sweden": {
          name: "azure-sweden",
          baseUrl: "https://example-sweden.openai.azure.com/openai/v1",
          envKey: "AZURE_OPENAI_API_KEY_SWEDEN",
        },
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-init-preload",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "init preload ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    await freshInitCodexShell();
    const result = await freshExecCodexPrompt("azure init preload", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("init preload ok");
    expect(process.env.AZURE_OPENAI_API_KEY_SWEDEN).toBeUndefined();
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    expect(mockCodexCtor).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        model_provider: "azure-us",
        model: "gpt-5.4",
        model_providers: expect.objectContaining({
          "azure-us": expect.objectContaining({
            base_url: "https://example-resource.openai.azure.com/openai/v1",
            env_key: "AZURE_OPENAI_API_KEY",
          }),
        }),
      }),
    }));
  });
  it("prefers the Azure provider whose endpoint matches OPENAI_BASE_URL", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "bosun-codex-profile-"));
    const codexDir = join(tempHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), [
      'model = "gpt-5.4"',
      'model_provider = "azure-sweden"',
      '',
      '[model_providers.azure-sweden]',
      'base_url = "https://example-sweden.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY_SWEDEN"',
      '',
      '[model_providers.azure-us]',
      'base_url = "https://example-resource.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      '',
    ].join("\n"), "utf8");
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const actualProfiles = await vi.importActual("../shell/codex-model-profiles.mjs");
    const resolved = actualProfiles.resolveCodexProfileRuntime({
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
      OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_API_KEY_SWEDEN: "sweden-key",
    });

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    expect(resolved.provider).toBe("azure");
    expect(resolved.env.OPENAI_BASE_URL).toBe("https://example-resource.openai.azure.com/openai/v1");
    expect(resolved.env.AZURE_OPENAI_API_KEY).toBe("azure-key");
  });
  it("matches Azure config providers when OPENAI_BASE_URL is a bare endpoint", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const tempHome = mkdtempSync(join(tmpdir(), "bosun-codex-profile-"));
    const codexDir = join(tempHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "config.toml"), [
      'model = "gpt-5.4"',
      'model_provider = "azure-sweden"',
      '',
      '[model_providers.azure-sweden]',
      'base_url = "https://example-sweden.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY_SWEDEN"',
      '',
      '[model_providers.azure-us]',
      'base_url = "https://example-resource.openai.azure.com/openai/v1"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      '',
    ].join("\\n"), "utf8");
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    const actualProfiles = await vi.importActual("../shell/codex-model-profiles.mjs");
    const resolved = actualProfiles.resolveCodexProfileRuntime({
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com",
      OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_API_KEY_SWEDEN: "sweden-key",
      AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com",
    });

    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }

    expect(resolved.provider).toBe("azure");
    expect(resolved.env.OPENAI_BASE_URL).toBe("https://example-resource.openai.azure.com/openai/v1");
    expect(resolved.env.AZURE_OPENAI_API_KEY).toBe("azure-key");
  });
  it("strips non-Azure OPENAI_BASE_URL before creating the SDK", async () => {
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_BASE_URL: "https://gateway.example.com/v1",
        OPENAI_API_KEY: "openai-key",
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-openai",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "openai ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await freshExecCodexPrompt("openai runtime", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("openai ok");
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
    expect(mockCodexCtor).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        model_providers: expect.objectContaining({
          "openai-direct": expect.objectContaining({
            stream_idle_timeout_ms: 3600000,
            stream_max_retries: 15,
            request_max_retries: 6,
          }),
        }),
      }),
    }));
  });

  it("strips optional OpenAI organization and project headers before SDK startup", async () => {
    const {
      execCodexPrompt: freshExecCodexPrompt,
      resetThread: freshResetThread,
      resolveCodexProfileRuntime: freshResolveCodexProfileRuntime,
    } = await loadFreshCodexShell();

    await freshResetThread();
    freshResolveCodexProfileRuntime.mockReturnValue({
      env: {
        OPENAI_API_KEY: "openai-key",
        OPENAI_ORGANIZATION: "org_stale",
        OPENAI_PROJECT: "proj_stale",
      },
    });
    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-header-sanitize",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "sanitized ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await freshExecCodexPrompt("sanitize optional headers", { timeoutMs: 5000 });

    expect(result.finalResponse).toContain("sanitized ok");
    expect(process.env.OPENAI_ORGANIZATION).toBeUndefined();
    expect(process.env.OPENAI_PROJECT).toBeUndefined();
    expect(mockCodexCtor).toHaveBeenCalledTimes(1);
  });

  it("injects sandbox workspace roots into Codex runtime config", async () => {
    process.env.BOSUN_HOST_PLATFORM = "win32";
    process.env.TEMP = process.cwd();

    mockStartThread.mockImplementation(() => ({
      id: "codex-test-thread-sandbox-config",
      runStreamed: async () => ({
        events: {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "sandbox ok" },
            };
            yield { type: "turn.completed" };
          },
        },
      }),
    }));

    const result = await execCodexPrompt("verify sandbox injection", {
      timeoutMs: 5000,
    });

    expect(result.finalResponse).toContain("sandbox ok");
    const ctorOptions = mockCodexCtor.mock.calls.at(-1)?.[0] || {};
    const startThreadOptions = mockStartThread.mock.calls.at(-1)?.[0] || {};
    expect(startThreadOptions.sandboxMode).toBe("workspace-write");
    const writableRoots = ctorOptions.config?.sandbox_workspace_write?.writable_roots || [];
    expect(Array.isArray(writableRoots)).toBe(true);
    expect(writableRoots).not.toContain("/tmp");
  });

});
