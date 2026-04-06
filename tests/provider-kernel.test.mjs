import { describe, expect, it, vi } from "vitest";

import { buildProviderKernelSettings, createProviderKernel } from "../agent/provider-kernel.mjs";
import { createProviderRegistry } from "../agent/provider-registry.mjs";
import anthropicNativeAdapter from "../shell/anthropic-native-adapter.mjs";
import geminiNativeAdapter from "../shell/gemini-native-adapter.mjs";

function createBenchKernel() {
  const adapters = {
    "opencode-sdk": {
      name: "opencode-sdk",
      provider: "OPENCODE",
      exec: async (message, options = {}) => ({
        finalResponse: `provider:${message}`,
        sessionId: options.sessionId || "provider-session",
        threadId: options.threadId || "provider-thread",
        providerId: options.provider || null,
        usage: {
          inputTokens: 24,
          outputTokens: 12,
          totalTokens: 36,
        },
      }),
    },
  };
  const config = {
    providers: {
      defaultProvider: "openai-compatible",
      openaiCompatible: {
        enabled: true,
        defaultModel: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
    },
  };
  const registry = createProviderRegistry({
    adapters,
    configExecutors: [],
    includeBuiltins: true,
    env: {},
    settings: {
      BOSUN_PROVIDER_DEFAULT: "openai-compatible",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
      BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1",
    },
  });
  const kernel = createProviderKernel({
    adapters,
    config,
    env: {},
    providerRegistry: registry,
  });
  return { registry, kernel };
}

describe("provider kernel cutover", () => {
  it("exposes one authoritative registry snapshot for default provider, auth, models, and capabilities", () => {
    const { registry } = createBenchKernel();

    const snapshot = registry.getRegistrySnapshot();
    const provider = registry.getDefaultProvider();
    const runtime = registry.resolveProviderRuntime("openai-compatible");

    expect(snapshot.contractVersion).toBe("bosun.provider-registry.v1");
    expect(snapshot.defaultProviderId).toBe("openai-compatible");
    expect(provider).toMatchObject({
      providerId: "openai-compatible",
      enabled: true,
      available: true,
      defaultModel: expect.any(String),
    });
    expect(snapshot.modelCatalogs["openai-compatible"]).toMatchObject({
      providerId: "openai-compatible",
      defaultModel: "qwen2.5-coder:latest",
      models: expect.arrayContaining([
        expect.objectContaining({
          id: "qwen2.5-coder:latest",
        }),
      ]),
    });
    expect(snapshot.capabilities["openai-compatible"]).toEqual(
      expect.objectContaining({
        streaming: true,
      }),
    );
    expect(snapshot.authHealth["openai-compatible"]).toEqual(
      expect.objectContaining({
        providerId: "openai-compatible",
        enabled: true,
        canRun: true,
      }),
    );
    expect(runtime).toEqual(
      expect.objectContaining({
        selection: expect.objectContaining({
          providerId: "openai-compatible",
          adapterName: "opencode-sdk",
        }),
        provider: expect.objectContaining({
          providerId: "openai-compatible",
        }),
      }),
    );
  });

  it("creates normalized execution sessions only through the provider kernel", async () => {
    const { kernel } = createBenchKernel();

    const runtime = kernel.resolveRuntime("openai-compatible", "opencode-sdk");
    const session = kernel.createExecutionSession({
      selectionId: "openai-compatible",
      adapterName: "opencode-sdk",
      sessionId: "cutover-provider-session",
      threadId: "cutover-provider-thread",
      model: "qwen2.5-coder:latest",
      metadata: {
        surface: "chat",
      },
    });

    const result = await session.runTurn("Normalize provider runtime.");

    expect(runtime.providerId).toBe("openai-compatible");
    expect(runtime.providerConfig).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    );
    expect(result).toMatchObject({
      output: "provider:USER: Normalize provider runtime.",
      finalResponse: "provider:USER: Normalize provider runtime.",
      providerId: "openai-compatible",
      sessionId: "cutover-provider-session",
      threadId: "cutover-provider-thread",
      usage: {
        inputTokens: 24,
        outputTokens: 12,
        totalTokens: 36,
      },
    });
    expect(session.getState()).toEqual(
      expect.objectContaining({
        provider: "openai-compatible",
        model: "qwen2.5-coder:latest",
        sessionId: "cutover-provider-session",
        threadId: "cutover-provider-thread",
      }),
    );
  });

  it("accepts UI-aligned provider config aliases when flattening harness settings", () => {
    const settings = buildProviderKernelSettings({
      providers: {
        defaultProvider: "azure-openai-responses",
        openai: {
          enabled: true,
          defaultModel: "gpt-5.4",
        },
        azureOpenai: {
          enabled: true,
          mode: "apiKey",
          defaultModel: "gpt-5.4-mini",
          endpoint: "https://azure.example.test/openai/v1",
          deployment: "gpt-5-prod",
          apiVersion: "2025-03-01-preview",
        },
        copilot: {
          enabled: true,
          defaultModel: "claude-opus-4.6",
        },
      },
    });

    expect(settings).toMatchObject({
      BOSUN_PROVIDER_DEFAULT: "azure-openai-responses",
      BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED: true,
      BOSUN_PROVIDER_OPENAI_RESPONSES_MODEL: "gpt-5.4",
      BOSUN_PROVIDER_AZURE_OPENAI_ENABLED: true,
      BOSUN_PROVIDER_AZURE_OPENAI_ENDPOINT: "https://azure.example.test/openai/v1",
      BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT: "gpt-5-prod",
      BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED: true,
      BOSUN_PROVIDER_COPILOT_OAUTH_MODEL: "claude-opus-4.6",
    });
  });

  it("prefers the native adapter for harness-managed OpenAI-family providers", async () => {
    const openaiNativeExec = async (message, options = {}) => ({
      finalResponse: `native:${message}`,
      sessionId: options.sessionId || "native-session",
      threadId: options.threadId || "native-thread",
      providerId: options.provider || null,
      usage: {
        inputTokens: 12,
        outputTokens: 6,
        totalTokens: 18,
      },
    });
    const kernel = createProviderKernel({
      adapters: {
        "openai-native": {
          name: "openai-native",
          provider: "OPENAI_NATIVE",
          exec: openaiNativeExec,
        },
      },
      config: {
        agentRuntime: "harness",
        providers: {
          defaultProvider: "openai-compatible",
          openaiCompatible: {
            enabled: true,
            defaultModel: "qwen2.5-coder:latest",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        },
      },
      env: {},
    });

    const runtime = kernel.resolveRuntime("openai-compatible");
    const session = kernel.createExecutionSession({
      selectionId: "openai-compatible",
      sessionId: "native-provider-session",
      threadId: "native-provider-thread",
      model: "qwen2.5-coder:latest",
    });
    const result = await session.runTurn("Stay on the harness-native path.");

    expect(runtime.selection).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      adapterName: "openai-native",
    }));
    expect(runtime.providerEntry).toEqual(expect.objectContaining({
      providerId: "openai-compatible",
      adapterId: "openai-native",
    }));
    expect(result).toMatchObject({
      finalResponse: "native:USER: Stay on the harness-native path.",
      providerId: "openai-compatible",
      sessionId: "native-provider-session",
      threadId: "native-provider-thread",
    });
  });

  it("prefers the native adapter for harness-managed Anthropic providers and passes the full turn payload", async () => {
    const anthropicExec = vi.fn(async (payload, options = {}) => ({
      finalResponse: "anthropic-native:ok",
      items: [{
        role: "assistant",
        content: [{ type: "text", text: "anthropic-native:ok" }],
      }],
      providerId: options.provider || null,
      sessionId: options.sessionId || "anthropic-session",
      threadId: options.threadId || "anthropic-thread",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    }));
    const kernel = createProviderKernel({
      adapters: {
        "anthropic-native": {
          name: "anthropic-native",
          provider: "ANTHROPIC_NATIVE",
          acceptsTurnPayload: true,
          exec: anthropicExec,
        },
      },
      config: {
        agentRuntime: "harness",
        providers: {
          defaultProvider: "anthropic-messages",
          anthropic: {
            enabled: true,
            defaultModel: "claude-sonnet-4",
          },
        },
      },
      env: {
        ANTHROPIC_API_KEY: "anthropic-secret",
      },
    });

    const runtime = kernel.resolveRuntime("anthropic-messages");
    const session = kernel.createExecutionSession({
      selectionId: "anthropic-messages",
      sessionId: "anthropic-provider-session",
      threadId: "anthropic-provider-thread",
      model: "claude-sonnet-4",
    });
    const result = await session.runTurn("Stay on the Bosun-native Anthropic path.");

    expect(runtime.selection).toEqual(expect.objectContaining({
      providerId: "anthropic-messages",
      adapterName: "anthropic-native",
    }));
    expect(runtime.providerEntry).toEqual(expect.objectContaining({
      providerId: "anthropic-messages",
      adapterId: "anthropic-native",
    }));
    expect(anthropicExec).toHaveBeenCalledTimes(1);
    expect(anthropicExec.mock.calls[0][0]).toEqual(expect.objectContaining({
      providerId: "anthropic-messages",
      model: "claude-sonnet-4",
      messages: [
        expect.objectContaining({
          role: "user",
          text: "Stay on the Bosun-native Anthropic path.",
        }),
      ],
    }));
    expect(result).toMatchObject({
      finalResponse: "anthropic-native:ok",
      providerId: "anthropic-messages",
      sessionId: "anthropic-provider-session",
      threadId: "anthropic-provider-thread",
    });
  });

  it("treats non-env auth bindings as direct credential literals for harness executors", () => {
    const registry = createProviderRegistry({
      adapters: {
        "openai-native": {
          name: "openai-native",
          provider: "OPENAI_NATIVE",
          exec: async () => ({ finalResponse: "ok" }),
        },
      },
      configExecutors: [
        {
          id: "openai-prod",
          name: "OpenAI Prod",
          providerId: "openai-responses",
          enabled: true,
          authBindings: {
            apiKeyEnv: "sk-test-literal-1234567890",
          },
        },
      ],
      env: {},
      includeBuiltins: false,
      preferNativeAdapters: true,
      settings: {},
    });

    expect(registry.getProvider("openai-prod")).toEqual(expect.objectContaining({
      adapterId: "openai-native",
      auth: expect.objectContaining({
        authenticated: true,
        canRun: true,
        preferredMode: "apiKey",
      }),
    }));
  });

  it("treats Anthropic API-key bindings as harness-native credentials", () => {
    const registry = createProviderRegistry({
      adapters: {
        "anthropic-native": {
          name: "anthropic-native",
          provider: "ANTHROPIC_NATIVE",
          exec: async () => ({ finalResponse: "ok" }),
        },
      },
      configExecutors: [
        {
          id: "anthropic-prod",
          name: "Anthropic Prod",
          providerId: "anthropic-messages",
          enabled: true,
          authBindings: {
            apiKeyEnv: "sk-ant-api-direct-literal",
          },
        },
      ],
      env: {},
      includeBuiltins: false,
      preferNativeAdapters: true,
      settings: {},
    });

    expect(registry.getProvider("anthropic-prod")).toEqual(expect.objectContaining({
      adapterId: "anthropic-native",
      auth: expect.objectContaining({
        authenticated: true,
        canRun: true,
        preferredMode: "apiKey",
      }),
    }));
  });

  it("prefers the native adapter for harness-managed Gemini providers", async () => {
    const geminiExec = vi.fn(async (_payload, options = {}) => ({
      finalResponse: "gemini-native:ok",
      items: [{
        role: "assistant",
        content: [{ type: "text", text: "gemini-native:ok" }],
      }],
      providerId: options.provider || null,
      sessionId: options.sessionId || "gemini-session",
      threadId: options.threadId || "gemini-thread",
      usage: {
        inputTokens: 14,
        outputTokens: 7,
        totalTokens: 21,
      },
    }));
    const kernel = createProviderKernel({
      adapters: {
        "gemini-native": {
          name: "gemini-native",
          provider: "GEMINI_NATIVE",
          acceptsTurnPayload: true,
          exec: geminiExec,
        },
      },
      config: {
        agentRuntime: "harness",
        providers: {
          defaultProvider: "gemini-generate-content",
          gemini: {
            enabled: true,
            defaultModel: "gemini-2.5-pro",
          },
        },
      },
      env: {
        GEMINI_API_KEY: "gemini-secret",
      },
    });

    const runtime = kernel.resolveRuntime("gemini-generate-content");
    const session = kernel.createExecutionSession({
      selectionId: "gemini-generate-content",
      sessionId: "gemini-provider-session",
      threadId: "gemini-provider-thread",
      model: "gemini-2.5-pro",
    });
    const result = await session.runTurn("Stay on the Bosun-native Gemini path.");

    expect(runtime.selection).toEqual(expect.objectContaining({
      providerId: "gemini-generate-content",
      adapterName: "gemini-native",
    }));
    expect(runtime.providerEntry).toEqual(expect.objectContaining({
      providerId: "gemini-generate-content",
      adapterId: "gemini-native",
    }));
    expect(geminiExec).toHaveBeenCalledTimes(1);
    expect(geminiExec.mock.calls[0][0]).toEqual(expect.objectContaining({
      providerId: "gemini-generate-content",
      model: "gemini-2.5-pro",
      messages: [
        expect.objectContaining({
          role: "user",
          text: "Stay on the Bosun-native Gemini path.",
        }),
      ],
    }));
    expect(result).toMatchObject({
      finalResponse: "gemini-native:ok",
      providerId: "gemini-generate-content",
      sessionId: "gemini-provider-session",
      threadId: "gemini-provider-thread",
    });
  });

  it("surfaces Gemini API-key bindings as harness-native credentials", () => {
    const registry = createProviderRegistry({
      adapters: {
        "gemini-native": {
          name: "gemini-native",
          provider: "GEMINI_NATIVE",
          exec: async () => ({ finalResponse: "ok" }),
        },
      },
      configExecutors: [
        {
          id: "gemini-prod",
          name: "Gemini Prod",
          providerId: "gemini-generate-content",
          enabled: true,
          authBindings: {
            apiKeyEnv: "gemini-direct-key-literal",
          },
        },
      ],
      env: {},
      includeBuiltins: false,
      preferNativeAdapters: true,
      settings: {},
    });

    expect(registry.getProvider("gemini-prod")).toEqual(expect.objectContaining({
      adapterId: "gemini-native",
      auth: expect.objectContaining({
        authenticated: true,
        canRun: true,
        preferredMode: "apiKey",
      }),
    }));
  });
});

describe("anthropic native adapter", () => {
  it("maps Bosun turn payloads onto the Anthropic Messages API", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        id: "msg_123",
        model: "claude-sonnet-4",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "I need to inspect the file first." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
        ],
        usage: {
          input_tokens: 120,
          output_tokens: 35,
        },
      }),
    }));
    globalThis.fetch = fetchMock;

    try {
      const result = await anthropicNativeAdapter.exec({
        providerId: "anthropic-messages",
        model: "claude-sonnet-4",
        sessionId: "anthropic-native-session",
        threadId: "anthropic-native-thread",
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "You are Bosun." }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "Inspect README.md" }],
          },
        ],
      }, {
        provider: "anthropic-messages",
        providerConfig: {
          model: "claude-sonnet-4",
        },
        env: {
          ANTHROPIC_API_KEY: "anthropic-live-key",
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(requestInit.headers).toEqual(expect.objectContaining({
        "x-api-key": "anthropic-live-key",
        "anthropic-version": "2023-06-01",
      }));
      const requestBody = JSON.parse(requestInit.body);
      expect(requestBody).toEqual(expect.objectContaining({
        model: "claude-sonnet-4",
        system: [{ type: "text", text: "You are Bosun." }],
        messages: [
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Inspect README.md" }],
          }),
        ],
        tools: [
          expect.objectContaining({
            name: "read_file",
          }),
        ],
      }));
      expect(result).toMatchObject({
        success: true,
        finalResponse: "I need to inspect the file first.",
        providerId: "anthropic-messages",
        model: "claude-sonnet-4",
        sessionId: "anthropic-native-session",
        threadId: "anthropic-native-thread",
        usage: {
          inputTokens: 120,
          outputTokens: 35,
          totalTokens: 155,
        },
      });
      expect(result.items).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({ type: "text", text: "I need to inspect the file first." }),
            expect.objectContaining({ type: "tool_call", name: "read_file" }),
          ],
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      anthropicNativeAdapter.reset();
    }
  });
});

describe("gemini native adapter", () => {
  it("maps Bosun turn payloads onto the Gemini Generate Content API", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [
                { text: "I should inspect the file first." },
                { functionCall: { name: "read_file", args: { path: "README.md" } } },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 90,
          candidatesTokenCount: 22,
          totalTokenCount: 112,
        },
      }),
    }));
    globalThis.fetch = fetchMock;

    try {
      const result = await geminiNativeAdapter.exec({
        providerId: "gemini-generate-content",
        model: "gemini-2.5-pro",
        sessionId: "gemini-native-session",
        threadId: "gemini-native-thread",
        tools: [
          {
            name: "read_file",
            description: "Read a file from disk",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "You are Bosun." }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "Inspect README.md" }],
          },
        ],
      }, {
        provider: "gemini-generate-content",
        providerConfig: {
          model: "gemini-2.5-pro",
        },
        env: {
          GEMINI_API_KEY: "gemini-live-key",
        },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, requestInit] = fetchMock.mock.calls[0];
      expect(url).toContain("/models/gemini-2.5-pro:generateContent?key=gemini-live-key");
      const requestBody = JSON.parse(requestInit.body);
      expect(requestBody).toEqual(expect.objectContaining({
        systemInstruction: {
          role: "system",
          parts: [{ text: "You are Bosun." }],
        },
        contents: [
          expect.objectContaining({
            role: "user",
            parts: [{ text: "Inspect README.md" }],
          }),
        ],
        tools: [
          {
            functionDeclarations: [
              expect.objectContaining({
                name: "read_file",
              }),
            ],
          },
        ],
      }));
      expect(result).toMatchObject({
        success: true,
        finalResponse: "I should inspect the file first.",
        providerId: "gemini-generate-content",
        model: "gemini-2.5-pro",
        sessionId: "gemini-native-session",
        threadId: "gemini-native-thread",
        usage: {
          inputTokens: 90,
          outputTokens: 22,
          totalTokens: 112,
        },
      });
      expect(result.items).toEqual([
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({ type: "text", text: "I should inspect the file first." }),
            expect.objectContaining({ type: "tool_call", name: "read_file" }),
          ],
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      geminiNativeAdapter.reset();
    }
  });
});
