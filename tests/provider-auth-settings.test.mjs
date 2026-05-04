import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { normalizeProviderAuthState } from "../agent/provider-auth-manager.mjs";
import { CredentialStore } from "../workflow/credential-store.mjs";
import { getProviderModelCatalog } from "../agent/provider-model-catalog.mjs";

describe("provider auth and model settings", () => {
  it("uses provider settings to enable advanced providers and surface configured auth mode", () => {
    const auth = normalizeProviderAuthState("openai-compatible", {}, {
      implicitAuth: false,
      env: {
        OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4000/v1",
      },
      settings: {
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE: "local",
        BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
      },
    });

    expect(auth.enabled).toBe(true);
    expect(auth.status).toBe("local_ready");
    expect(auth.preferredMode).toBe("local");
    expect(auth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "local",
      defaultModel: "qwen2.5-coder:latest",
    }));
  });

  it("surfaces subscription workspace settings through auth normalization", () => {
    const chatgptAuth = normalizeProviderAuthState("openai-codex-subscription", {}, {
      implicitAuth: false,
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE: "chatgpt-team-alpha",
      },
    });
    const claudeAuth = normalizeProviderAuthState("claude-subscription-shim", {}, {
      implicitAuth: false,
      settings: {
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE: "claude-lab-beta",
      },
    });

    expect(chatgptAuth.enabled).toBe(true);
    expect(chatgptAuth.settings).toEqual(expect.objectContaining({
      workspace: "chatgpt-team-alpha",
    }));
    expect(claudeAuth.enabled).toBe(true);
    expect(claudeAuth.settings).toEqual(expect.objectContaining({
      workspace: "claude-lab-beta",
    }));
  });

  it("surfaces Claude OAuth warning metadata when subscription auth is enabled", () => {
    const claudeAuth = normalizeProviderAuthState("claude-subscription-shim", {
      connected: true,
      authenticated: true,
      sessionActive: true,
    }, {
      implicitAuth: false,
      settings: {
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED: "true",
        BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE: "oauth",
      },
    });

    expect(claudeAuth.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "claude_oauth_tos_warning",
          severity: "warning",
        }),
      ]),
    );
  });

  it("detects Codex auth.json during auth normalization and surfaces the source path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-codex-auth-"));
    const authPath = join(tempDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        access_token: "header.payload.signature",
        account_id: "acct_123",
      },
    }));

    const codexAuth = normalizeProviderAuthState("openai-codex-subscription", {}, {
      env: {
        CODEX_AUTH_JSON_PATH: authPath,
      },
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
      },
    });

    expect(codexAuth.authenticated).toBe(true);
    expect(codexAuth.preferredMode).toBe("oauth");
    expect(codexAuth.connection).toEqual(expect.objectContaining({
      authSource: "auth.json",
      accountId: "acct_123",
      authPath,
    }));
  });

  it("detects Codex auth.json API-key schema during auth normalization", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-codex-auth-"));
    const authPath = join(tempDir, "auth.json");
    writeFileSync(authPath, JSON.stringify({
      OPENAI_API_KEY: "sk-test-codex-auth-json",
    }));

    const codexAuth = normalizeProviderAuthState("openai-codex-subscription", {}, {
      env: {
        CODEX_AUTH_JSON_PATH: authPath,
      },
      settings: {
        BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
      },
    });

    expect(codexAuth.authenticated).toBe(true);
    expect(codexAuth.canRun).toBe(true);
    expect(codexAuth.preferredMode).toBe("apiKey");
    expect(codexAuth.connection).toEqual(expect.objectContaining({
      authSource: "auth.json",
      authPath,
    }));
  });

  it("prefers provider-scoped model settings over built-in defaults", () => {
    const catalog = getProviderModelCatalog("azure-openai-responses", {
      settings: {
        BOSUN_PROVIDER_AZURE_OPENAI_ENABLED: "true",
        BOSUN_PROVIDER_AZURE_OPENAI_MODEL: "o4-mini",
      },
    });

    expect(catalog.enabled).toBe(true);
    expect(catalog.defaultModel).toBe("o4-mini");
    expect(catalog.models.some((entry) => entry.id === "o4-mini" && entry.default === true)).toBe(true);
  });

  it("surfaces Gemini API-key settings and model defaults through auth normalization", () => {
    const auth = normalizeProviderAuthState("gemini-generate-content", {}, {
      implicitAuth: false,
      env: {
        GEMINI_API_KEY: "gemini-test-key",
      },
      settings: {
        BOSUN_PROVIDER_GEMINI_ENABLED: "true",
        BOSUN_PROVIDER_GEMINI_MODEL: "gemini-2.5-flash",
        BOSUN_PROVIDER_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com/v1beta",
      },
    });
    const catalog = getProviderModelCatalog("gemini-generate-content", {
      settings: {
        BOSUN_PROVIDER_GEMINI_ENABLED: "true",
        BOSUN_PROVIDER_GEMINI_MODEL: "gemini-2.5-flash",
      },
    });

    expect(auth.enabled).toBe(true);
    expect(auth.authenticated).toBe(true);
    expect(auth.preferredMode).toBe("apiKey");
    expect(auth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "apiKey",
      defaultModel: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    }));
    expect(catalog.defaultModel).toBe("gemini-2.5-flash");
    expect(catalog.models.some((entry) => entry.id === "gemini-2.5-flash" && entry.default === true)).toBe(true);
  });

  it("surfaces OpenRouter API-key settings and model defaults through auth normalization", () => {
    const auth = normalizeProviderAuthState("openrouter", {}, {
      implicitAuth: false,
      env: {
        OPENROUTER_API_KEY: "openrouter-test-key",
      },
      settings: {
        BOSUN_PROVIDER_OPENROUTER_ENABLED: "true",
        BOSUN_PROVIDER_OPENROUTER_MODEL: "openai/gpt-5",
        BOSUN_PROVIDER_OPENROUTER_BASE_URL: "https://openrouter.example/v1",
      },
    });
    const catalog = getProviderModelCatalog("openrouter", {
      settings: {
        BOSUN_PROVIDER_OPENROUTER_ENABLED: "true",
        BOSUN_PROVIDER_OPENROUTER_MODEL: "openai/gpt-5",
      },
    });

    expect(auth.enabled).toBe(true);
    expect(auth.authenticated).toBe(true);
    expect(auth.preferredMode).toBe("apiKey");
    expect(auth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "apiKey",
      defaultModel: "openai/gpt-5",
      baseUrl: "https://openrouter.example/v1",
    }));
    expect(catalog.defaultModel).toBe("openai/gpt-5");
    expect(catalog.models.some((entry) => entry.id === "openai/gpt-5" && entry.default === true)).toBe(true);
  });

  it("surfaces Groq API-key settings and model defaults through auth normalization", () => {
    const auth = normalizeProviderAuthState("groq", {}, {
      implicitAuth: false,
      env: {
        GROQ_API_KEY: "groq-test-key",
      },
      settings: {
        BOSUN_PROVIDER_GROQ_ENABLED: "true",
        BOSUN_PROVIDER_GROQ_MODEL: "llama-3.3-70b-versatile",
        BOSUN_PROVIDER_GROQ_BASE_URL: "https://api.groq.example/openai/v1",
      },
    });
    const catalog = getProviderModelCatalog("groq", {
      settings: {
        BOSUN_PROVIDER_GROQ_ENABLED: "true",
        BOSUN_PROVIDER_GROQ_MODEL: "llama-3.3-70b-versatile",
      },
    });

    expect(auth.enabled).toBe(true);
    expect(auth.authenticated).toBe(true);
    expect(auth.preferredMode).toBe("apiKey");
    expect(auth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "apiKey",
      defaultModel: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.example/openai/v1",
    }));
    expect(catalog.defaultModel).toBe("llama-3.3-70b-versatile");
    expect(catalog.models.some((entry) => entry.id === "llama-3.3-70b-versatile" && entry.default === true)).toBe(true);
  });

  it("surfaces Fireworks and Nebius API-key settings through auth normalization", () => {
    const fireworksAuth = normalizeProviderAuthState("fireworks", {}, {
      implicitAuth: false,
      env: {
        FIREWORKS_API_KEY: "fireworks-test-key",
      },
      settings: {
        BOSUN_PROVIDER_FIREWORKS_ENABLED: "true",
        BOSUN_PROVIDER_FIREWORKS_MODEL: "llama-v3p3-70b-instruct",
        BOSUN_PROVIDER_FIREWORKS_BASE_URL: "https://fireworks.example/inference/v1",
      },
    });
    const nebiusAuth = normalizeProviderAuthState("nebius", {}, {
      implicitAuth: false,
      env: {
        NEBIUS_API_KEY: "nebius-test-key",
      },
      settings: {
        BOSUN_PROVIDER_NEBIUS_ENABLED: "true",
        BOSUN_PROVIDER_NEBIUS_MODEL: "meta-llama/Meta-Llama-3.1-70B-Instruct",
        BOSUN_PROVIDER_NEBIUS_BASE_URL: "https://nebius.example/v1",
      },
    });

    expect(fireworksAuth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "apiKey",
      defaultModel: "llama-v3p3-70b-instruct",
      baseUrl: "https://fireworks.example/inference/v1",
    }));
    expect(nebiusAuth.settings).toEqual(expect.objectContaining({
      enabled: true,
      authMode: "apiKey",
      defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
      baseUrl: "https://nebius.example/v1",
    }));
  });

  it("builds provider credential lifecycle state from the shared credential store", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-provider-cred-"));
    const credentialStore = new CredentialStore({ configDir: tempDir });
    credentialStore.set("openai-runtime", {
      type: "static",
      value: "sk-runtime-1234567890",
      provider: "openai-responses",
      validation: { prefix: "sk-", minLength: 12 },
      lifecycle: { authMode: "apiKey" },
      templates: {
        headers: { Authorization: "Bearer {{credential.value}}" },
      },
    });

    const auth = normalizeProviderAuthState("openai-responses", {}, {
      implicitAuth: false,
      credentialStore,
      settings: {
        BOSUN_PROVIDER_OPENAI_ENABLED: "true",
        BOSUN_PROVIDER_OPENAI_MODE: "apiKey",
      },
    });

    expect(auth.credentialLifecycle).toEqual(expect.objectContaining({
      providerId: "openai-responses",
      status: "configured",
    }));
    expect(auth.credentialLifecycle.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "apiKey",
        configured: true,
        credentialName: "openai-runtime",
        templates: expect.objectContaining({
          headers: { Authorization: "Bearer sk-runtime-1234567890" },
        }),
      }),
    ]));
  });
});
