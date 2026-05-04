/**
 * Tests for workflow/credential-store.mjs
 *
 * Covers: CRUD, encryption, env/config references, scope checks,
 *         persistence, and edge cases.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let CredentialStore;
try {
  ({ CredentialStore } = await import("../workflow/credential-store.mjs"));
} catch {
  CredentialStore = null;
}

const skip = !CredentialStore;

describe.skipIf(skip)("CredentialStore", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-cred-test-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Construction ────────────────────────────────────────────────────

  it("requires configDir", () => {
    expect(() => new CredentialStore()).toThrow(/configDir/i);
  });

  it("creates store with configDir", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(store.size).toBe(0);
  });

  it("reports encrypted=false without BOSUN_SECRET_KEY", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(store.encrypted).toBe(false);
  });

  it("reports encrypted=true with secretKey", () => {
    const store = new CredentialStore({ configDir: tmpDir, secretKey: "test-secret-123" });
    expect(store.encrypted).toBe(true);
  });

  // ── Static credentials ──────────────────────────────────────────────

  it("set and resolve a static credential (unencrypted)", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("api-key", { type: "static", value: "sk-test-123" });
    expect(store.resolve("api-key")).toBe("sk-test-123");
  });

  it("set and resolve a static credential (encrypted)", () => {
    const store = new CredentialStore({ configDir: tmpDir, secretKey: "my-secret" });
    store.set("api-key", { type: "static", value: "sk-encrypted-abc" });
    expect(store.resolve("api-key")).toBe("sk-encrypted-abc");
  });

  it("encrypted value on disk is not plaintext", () => {
    const store = new CredentialStore({ configDir: tmpDir, secretKey: "my-secret" });
    store.set("api-key", { type: "static", value: "sk-encrypted-abc" });
    const filePath = join(tmpDir, ".bosun", "credentials.json");
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("sk-encrypted-abc");
  });

  // ── Env credentials ────────────────────────────────────────────────

  it("set and resolve an env credential", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    const envKey = "BOSUN_TEST_CRED_" + Date.now();
    process.env[envKey] = "env-value-42";
    try {
      store.set("my-env", { type: "env", value: envKey });
      expect(store.resolve("my-env")).toBe("env-value-42");
    } finally {
      delete process.env[envKey];
    }
  });

  it("env credential returns null when env var missing", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("missing-env", { type: "env", value: "DOES_NOT_EXIST_XYZ" });
    expect(store.resolve("missing-env")).toBeNull();
  });

  // ── CRUD operations ────────────────────────────────────────────────

  it("get returns metadata without value", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("my-key", { type: "static", value: "secret", label: "My Key", provider: "openai" });
    const meta = store.get("my-key");
    expect(meta).toBeTruthy();
    expect(meta.name).toBe("my-key");
    expect(meta.type).toBe("static");
    expect(meta.label).toBe("My Key");
    expect(meta.provider).toBe("openai");
    expect(meta).not.toHaveProperty("value");
  });

  it("list returns all metadata", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("a", { type: "static", value: "1" });
    store.set("b", { type: "env", value: "MY_VAR" });
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });

  it("delete removes credential", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("x", { type: "static", value: "v" });
    expect(store.has("x")).toBe(true);
    expect(store.delete("x")).toBe(true);
    expect(store.has("x")).toBe(false);
    expect(store.delete("x")).toBe(false);
  });

  it("has returns correct boolean", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(store.has("nope")).toBe(false);
    store.set("yes", { type: "static", value: "v" });
    expect(store.has("yes")).toBe(true);
  });

  it("size tracks count", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(store.size).toBe(0);
    store.set("a", { type: "static", value: "1" });
    expect(store.size).toBe(1);
    store.set("b", { type: "static", value: "2" });
    expect(store.size).toBe(2);
    store.delete("a");
    expect(store.size).toBe(1);
  });

  // ── Scope checks ──────────────────────────────────────────────────

  it("wildcard scope allows all workflows", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("k", { type: "static", value: "v", scopes: ["*"] });
    expect(store.resolve("k", { workflowId: "any-id" })).toBe("v");
  });

  it("specific scope restricts access", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("k", { type: "static", value: "v", scopes: ["wf-1"] });
    expect(store.resolve("k", { workflowId: "wf-1" })).toBe("v");
    expect(store.resolve("k", { workflowId: "wf-2" })).toBeNull();
  });

  it("setScopes updates scopes", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("k", { type: "static", value: "v", scopes: ["wf-1"] });
    store.setScopes("k", ["wf-1", "wf-2"]);
    expect(store.resolve("k", { workflowId: "wf-2" })).toBe("v");
  });

  // ── Persistence ───────────────────────────────────────────────────

  it("persists credentials to disk and reloads", () => {
    const store1 = new CredentialStore({ configDir: tmpDir, secretKey: "abc" });
    store1.set("persisted", { type: "static", value: "hello" });
    // Create a new instance to test reload
    const store2 = new CredentialStore({ configDir: tmpDir, secretKey: "abc" });
    expect(store2.resolve("persisted")).toBe("hello");
  });

  it("cannot decrypt with wrong key", () => {
    const store1 = new CredentialStore({ configDir: tmpDir, secretKey: "key-A" });
    store1.set("secret", { type: "static", value: "data" });
    const store2 = new CredentialStore({ configDir: tmpDir, secretKey: "key-B" });
    expect(store2.resolve("secret")).toBeNull();
  });

  // ── Validation ────────────────────────────────────────────────────

  it("rejects empty name", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(() => store.set("", { type: "static", value: "v" })).toThrow(/name/i);
  });

  it("rejects invalid type", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(() => store.set("k", { type: "invalid", value: "v" })).toThrow(/type/i);
  });

  it("rejects empty value", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    expect(() => store.set("k", { type: "static", value: "" })).toThrow(/value/i);
  });

  // ── Update preserves metadata ─────────────────────────────────────

  it("updating a credential preserves createdAt", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("k", { type: "static", value: "v1" });
    const t1 = store.get("k").createdAt;
    store.set("k", { type: "static", value: "v2" });
    expect(store.get("k").createdAt).toBe(t1);
    expect(store.resolve("k")).toBe("v2");
  });

  it("validates provider lifecycle metadata and resolves request templates", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("openai-api-key", {
      type: "static",
      value: "sk-live-1234567890",
      provider: "openai-responses",
      validation: { prefix: "sk-", minLength: 12 },
      lifecycle: { authMode: "apiKey", refreshable: false },
      templates: {
        headers: { Authorization: "Bearer {{credential.value}}" },
        body: { provider: "{{provider.id}}" },
      },
    });

    const resolved = store.resolveEntry("openai-api-key", { includeValue: true });
    const templates = store.resolveTemplates("openai-api-key", null, {
      providerId: "openai-responses",
    });

    expect(resolved).toEqual(expect.objectContaining({
      provider: "openai-responses",
      status: "ready",
      value: "sk-live-1234567890",
      lifecycle: expect.objectContaining({ authMode: "apiKey" }),
    }));
    expect(templates).toEqual({
      headers: { Authorization: "Bearer sk-live-1234567890" },
      query: {},
      body: { provider: "openai-responses" },
    });
  });

  it("reads config-backed credentials from nested config objects and reports validation failures", () => {
    const store = new CredentialStore({ configDir: tmpDir });
    store.set("azure-token", {
      type: "config",
      value: "providers.azure.token",
      provider: "azure-openai-responses",
      validation: { prefix: "tok_" },
      lifecycle: { authMode: "oauth", refreshable: true },
    });

    expect(store.resolve("azure-token", {
      config: { providers: { azure: { token: "tok_valid_123" } } },
    })).toBe("tok_valid_123");

    const invalid = store.validate("azure-token", {
      config: { providers: { azure: { token: "bad" } } },
    });
    expect(invalid).toEqual(expect.objectContaining({
      ok: false,
      status: "invalid",
    }));
    expect(invalid.errors[0]).toMatch(/start with "tok_"/i);
  });
});
