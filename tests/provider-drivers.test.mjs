import { describe, expect, it } from "vitest";

import { listProviderAuthAdapters } from "../agent/auth/index.mjs";
import {
  getBuiltInProviderDriver,
  hasBuiltInProviderDriver,
  listBuiltInProviderDrivers,
  listBuiltInProviderIds,
  normalizeProviderDriverId,
} from "../agent/providers/index.mjs";

describe("provider driver modules", () => {
  it("registers every Step 3 built-in provider driver", () => {
    expect(listBuiltInProviderIds()).toEqual([
      "openai-responses",
      "openai-codex-subscription",
      "azure-openai-responses",
      "anthropic-messages",
      "claude-subscription-shim",
      "openai-compatible",
      "ollama",
      "copilot-oauth",
      "gemini-generate-content",
      "openrouter",
      "perplexity",
      "deepinfra",
      "groq",
      "together",
      "xai",
      "fireworks",
      "cerebras",
      "sambanova",
      "nebius",
    ]);
    expect(listBuiltInProviderDrivers()).toHaveLength(19);
  });

  it("keeps auth adapter coverage aligned with the authoritative provider registry set", () => {
    expect(listProviderAuthAdapters().map((entry) => entry.providerId)).toEqual(
      listBuiltInProviderIds(),
    );
  });

  it("normalizes provider aliases and exposes driver metadata", () => {
    expect(normalizeProviderDriverId("GitHub_Copilot")).toBe("github-copilot");
    expect(hasBuiltInProviderDriver("github-copilot")).toBe(true);
    expect(hasBuiltInProviderDriver("chatgpt-subscription")).toBe(true);
    expect(hasBuiltInProviderDriver("openrouter")).toBe(true);
    expect(hasBuiltInProviderDriver("pplx")).toBe(true);
    expect(hasBuiltInProviderDriver("deep-infra")).toBe(true);
    expect(hasBuiltInProviderDriver("groq-api")).toBe(true);
    expect(hasBuiltInProviderDriver("together-ai")).toBe(true);
    expect(hasBuiltInProviderDriver("grok")).toBe(true);
    expect(hasBuiltInProviderDriver("fireworks-ai")).toBe(true);
    expect(hasBuiltInProviderDriver("cerebras-ai")).toBe(true);
    expect(hasBuiltInProviderDriver("samba-nova")).toBe(true);
    expect(hasBuiltInProviderDriver("nebius-ai")).toBe(true);

    const driver = getBuiltInProviderDriver("azure-openai");
    expect(driver).toMatchObject({
      id: "azure-openai-responses",
      metadata: {
        vendor: "microsoft",
        family: "openai",
      },
      adapterHints: {
        adapterId: "codex-sdk",
        executor: "AZURE_OPENAI",
      },
      capabilities: {
        apiKey: true,
        oauth: true,
        tools: true,
        reasoning: true,
      },
      auth: {
        preferredMode: "apiKey",
        supportedModes: ["apiKey", "oauth"],
      },
    });
  });

  it("builds normalized session config for API-key providers", () => {
    const driver = getBuiltInProviderDriver("openai");
    const config = driver.createSessionConfig({
      env: {
        OPENAI_API_KEY: "sk-test",
        OPENAI_PROJECT_ID: "proj_123",
      },
      settings: {
        defaultModel: "gpt5.4-mini",
      },
    });

    expect(config).toMatchObject({
      providerId: "openai-responses",
      model: "gpt-5.4-mini",
      authMode: "apiKey",
      credentials: {
        apiKeyConfigured: true,
        oauthConfigured: false,
        subscriptionConfigured: false,
      },
      project: "proj_123",
    });
    expect(config.transport.apiStyle).toBe("responses");
  });

  it("builds normalized session config for deployment and local providers", () => {
    const azure = getBuiltInProviderDriver("azure-responses").createSessionConfig({
      env: {
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_DEPLOYMENT: "gpt-5-prod",
        AZURE_OPENAI_API_VERSION: "2026-01-01-preview",
      },
    });
    const ollama = getBuiltInProviderDriver("ollama").createSessionConfig({
      env: {
        OLLAMA_HOST: "http://127.0.0.1:11434",
      },
    });

    expect(azure).toMatchObject({
      providerId: "azure-openai-responses",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-5-prod",
      apiVersion: "2026-01-01-preview",
      credentials: {
        apiKeyConfigured: false,
        oauthConfigured: false,
      },
    });
    expect(ollama).toMatchObject({
      providerId: "ollama",
      authMode: "local",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen2.5-coder:latest",
      capabilities: {
        local: true,
        openaiCompatible: true,
      },
    });
  });

  it("builds normalized session config for native OpenAI-compatible vendor providers", () => {
    const openrouter = getBuiltInProviderDriver("openrouter").createSessionConfig({
      env: {
        OPENROUTER_API_KEY: "openrouter-test-key",
        OPENROUTER_BASE_URL: "https://openrouter.example/v1",
      },
      settings: {
        defaultModel: "openai/gpt-5",
      },
    });
    const perplexity = getBuiltInProviderDriver("perplexity").createSessionConfig({
      env: {
        PERPLEXITY_API_KEY: "perplexity-test-key",
      },
      settings: {
        defaultModel: "sonar-pro",
      },
    });
    const groq = getBuiltInProviderDriver("groq").createSessionConfig({
      env: {
        GROQ_API_KEY: "groq-test-key",
      },
      settings: {
        defaultModel: "llama-3.3-70b-versatile",
      },
    });
    const fireworks = getBuiltInProviderDriver("fireworks").createSessionConfig({
      env: {
        FIREWORKS_API_KEY: "fireworks-test-key",
      },
      settings: {
        defaultModel: "llama-v3p3-70b-instruct",
      },
    });

    expect(openrouter).toMatchObject({
      providerId: "openrouter",
      authMode: "apiKey",
      endpoint: "https://openrouter.example/v1",
      baseUrl: "https://openrouter.example/v1",
      model: "openai/gpt-5",
      credentials: {
        apiKeyConfigured: true,
      },
    });
    expect(perplexity).toMatchObject({
      providerId: "perplexity",
      authMode: "apiKey",
      model: "sonar-pro",
      credentials: {
        apiKeyConfigured: true,
      },
    });
    expect(groq).toMatchObject({
      providerId: "groq",
      authMode: "apiKey",
      model: "llama-3.3-70b-versatile",
      credentials: {
        apiKeyConfigured: true,
      },
    });
    expect(fireworks).toMatchObject({
      providerId: "fireworks",
      authMode: "apiKey",
      model: "llama-v3p3-70b-instruct",
      credentials: {
        apiKeyConfigured: true,
      },
    });
  });

  it("normalizes usage snapshots and model aliases from drivers", () => {
    const copilot = getBuiltInProviderDriver("copilot");
    const usage = copilot.normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 40,
    });

    expect(copilot.normalizeModel("copilot-claude")).toBe("claude-sonnet-4");
    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 40,
      totalTokens: 160,
      costUsd: 0,
    });
  });
});
