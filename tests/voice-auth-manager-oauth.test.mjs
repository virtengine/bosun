/**
 * Tests for the OAuth PKCE flow in voice-auth-manager.mjs.
 * Covers OpenAI, Claude, and Google Gemini providers.
 *
 * We mock:
 *  - node:http  so we never bind a real port
 *  - node:child_process  so we never open a real browser
 *  - fs write ops  so we never touch the real ~/.bosun directory
 *  - global fetch  for the token-exchange / refresh endpoints
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fs mock ───────────────────────────────────────────────────────────────────
let _fsStore = {};
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(_fsStore, p),
    readFileSync: (p, enc) => {
      if (!Object.prototype.hasOwnProperty.call(_fsStore, p))
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      return enc ? _fsStore[p] : Buffer.from(_fsStore[p]);
    },
    writeFileSync: (p, data) => {
      _fsStore[p] = typeof data === "string" ? data : data.toString();
    },
    mkdirSync: vi.fn(),
  };
});

// ── http mock ─────────────────────────────────────────────────────────────────
const _mockServer = {
  listen: vi.fn((_port, _host, cb) => { if (cb) cb(); }),
  close: vi.fn(),
  on: vi.fn(),
  _handler: null,
};
vi.mock("node:http", () => ({
  createServer: vi.fn((handler) => {
    _mockServer._handler = handler;
    return _mockServer;
  }),
}));

// ── child_process mock ─────────────────────────────────────────────────────────
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    exec: vi.fn((_cmd, cb) => { if (cb) cb(null); }),
  };
});

// ── fetch mock ────────────────────────────────────────────────────────────────
const _fetchMock = vi.fn();
globalThis.fetch = _fetchMock;

// ── helpers ───────────────────────────────────────────────────────────────────
function resetFsStore() {
  _fsStore = {};
}

function makeFetchOk(body) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    status: 200,
  });
}

function makeFetchFail(status, text) {
  return Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(text),
    status,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────
describe("voice-auth-manager OAuth", () => {
  let mod;

  beforeEach(async () => {
    resetFsStore();
    _mockServer.listen.mockClear();
    _mockServer.close.mockClear();
    _mockServer.on.mockClear();
    _fetchMock.mockReset();
    // Force a fresh import each time by resetting vitest module cache
    vi.resetModules();
    mod = await import("../voice/voice-auth-manager.mjs");
  });

  afterEach(() => {
    // Clean up any pending logins so tests stay isolated
    mod.cancelOpenAILogin();
    mod.cancelClaudeLogin?.();
    mod.cancelGeminiLogin?.();
  });

  // ── startOpenAICodexLogin ──────────────────────────────────────────────────

  it("startOpenAICodexLogin returns an authUrl pointing to auth.openai.com", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    expect(authUrl).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  });

  it("authUrl contains the correct client_id", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("authUrl contains PKCE code_challenge and S256 method", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge").length).toBeGreaterThan(20);
  });

  it("authUrl contains correct redirect_uri and scope", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
    expect(params.get("scope")).toContain("openid");
    expect(params.get("scope")).toContain("offline_access");
    expect(params.get("scope")).toContain("profile");
    expect(params.get("scope")).toContain("email");
    expect(params.get("scope")).toContain("api.model.read");
  });

  it("allows OpenAI OAuth full scope override via BOSUN_OPENAI_OAUTH_SCOPES", async () => {
    const prevOverride = process.env.BOSUN_OPENAI_OAUTH_SCOPES;
    try {
      process.env.BOSUN_OPENAI_OAUTH_SCOPES = "openid offline_access";
      vi.resetModules();
      const localMod = await import("../voice/voice-auth-manager.mjs");
      const { authUrl } = localMod.startOpenAICodexLogin();
      const params = new URLSearchParams(new URL(authUrl).search);
      const scope = params.get("scope") || "";
      expect(scope).toContain("openid");
      expect(scope).toContain("offline_access");
      expect(scope).not.toContain("profile");
      localMod.cancelOpenAILogin();
    } finally {
      if (prevOverride == null) delete process.env.BOSUN_OPENAI_OAUTH_SCOPES;
      else process.env.BOSUN_OPENAI_OAUTH_SCOPES = prevOverride;
      vi.resetModules();
      mod = await import("../voice/voice-auth-manager.mjs");
    }
  });

  it("treats BOSUN_*_OAUTH_CLIENT_ID=undefined as unset (gemini throws, claude uses its default)", async () => {
    const prevGemini = process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID;
    const prevClaude = process.env.BOSUN_CLAUDE_OAUTH_CLIENT_ID;
    try {
      process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID = "undefined";
      process.env.BOSUN_CLAUDE_OAUTH_CLIENT_ID = "undefined";
      vi.resetModules();
      const reloaded = await import("../voice/voice-auth-manager.mjs");

      // Gemini has no hardcoded fallback — must set BOSUN_GEMINI_OAUTH_CLIENT_ID
      expect(() => reloaded.startGeminiLogin()).toThrow(/client_id is missing/);
      const claude = new URL(reloaded.startClaudeLogin().authUrl);
      expect(claude.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      reloaded.cancelClaudeLogin?.();
      reloaded.cancelClaudeLogin?.();
    } finally {
      if (prevGemini === undefined) delete process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID;
      else process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID = prevGemini;
      if (prevClaude === undefined) delete process.env.BOSUN_CLAUDE_OAUTH_CLIENT_ID;
      else process.env.BOSUN_CLAUDE_OAUTH_CLIENT_ID = prevClaude;
      vi.resetModules();
      mod = await import("../voice/voice-auth-manager.mjs");
    }
  });

  it("treats literal undefined/null OAuth access token env vars as unset", async () => {
    const prevOpenAi = process.env.OPENAI_OAUTH_ACCESS_TOKEN;
    const prevAnthropic = process.env.ANTHROPIC_ACCESS_TOKEN;
    const prevGemini = process.env.GEMINI_ACCESS_TOKEN;
    try {
      process.env.OPENAI_OAUTH_ACCESS_TOKEN = "undefined";
      process.env.ANTHROPIC_ACCESS_TOKEN = "null";
      process.env.GEMINI_ACCESS_TOKEN = " undefined ";

      expect(mod.resolveVoiceOAuthToken("openai")).toBeNull();
      expect(mod.resolveVoiceOAuthToken("claude")).toBeNull();
      expect(mod.resolveVoiceOAuthToken("gemini")).toBeNull();
    } finally {
      if (prevOpenAi === undefined) delete process.env.OPENAI_OAUTH_ACCESS_TOKEN;
      else process.env.OPENAI_OAUTH_ACCESS_TOKEN = prevOpenAi;
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_ACCESS_TOKEN;
      else process.env.ANTHROPIC_ACCESS_TOKEN = prevAnthropic;
      if (prevGemini === undefined) delete process.env.GEMINI_ACCESS_TOKEN;
      else process.env.GEMINI_ACCESS_TOKEN = prevGemini;
    }
  });

  it("Claude authUrl does NOT contain openid scope", () => {
    const { authUrl } = mod.startClaudeLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("scope") || "").not.toContain("openid");
  });

  it("authUrl contains codex_cli_simplified_flow param", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("codex_cli_simplified_flow")).toBe("true");
  });

  it("authUrl contains a state parameter", () => {
    const { authUrl } = mod.startOpenAICodexLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("state")).toBeTruthy();
    expect(params.get("state").length).toBeGreaterThan(8);
  });

  it("starts the callback HTTP server on port 1455", () => {
    mod.startOpenAICodexLogin();
    expect(_mockServer.listen).toHaveBeenCalledWith(1455, "127.0.0.1");
  });

  it("cancelling a second call stops the first server and starts a fresh one", () => {
    mod.startOpenAICodexLogin();
    const firstListenCount = _mockServer.listen.mock.calls.length;
    mod.startOpenAICodexLogin(); // should cancel previous
    expect(_mockServer.close).toHaveBeenCalled();
    expect(_mockServer.listen.mock.calls.length).toBeGreaterThan(firstListenCount);
  });

  // ── getOpenAILoginStatus ──────────────────────────────────────────────────

  it("getOpenAILoginStatus returns idle when no login pending and no token", () => {
    const { status, hasToken } = mod.getOpenAILoginStatus();
    expect(status).toBe("idle");
    expect(hasToken).toBe(false);
  });

  it("getOpenAILoginStatus returns pending after startOpenAICodexLogin", () => {
    mod.startOpenAICodexLogin();
    const { status } = mod.getOpenAILoginStatus();
    expect(status).toBe("pending");
  });

  // ── cancelOpenAILogin ─────────────────────────────────────────────────────

  it("cancelOpenAILogin resets status to idle", () => {
    mod.startOpenAICodexLogin();
    mod.cancelOpenAILogin();
    const { status } = mod.getOpenAILoginStatus();
    expect(status).toBe("idle");
  });

  it("cancelOpenAILogin closes the callback server", () => {
    mod.startOpenAICodexLogin();
    _mockServer.close.mockClear();
    mod.cancelOpenAILogin();
    expect(_mockServer.close).toHaveBeenCalled();
  });

  it("cancelOpenAILogin is safe when no login is pending", () => {
    expect(() => mod.cancelOpenAILogin()).not.toThrow();
  });

  // ── logoutOpenAI ─────────────────────────────────────────────────────────

  it("logoutOpenAI returns wasLoggedIn:false when no token stored", () => {
    const result = mod.logoutOpenAI();
    expect(result.ok).toBe(true);
    expect(result.wasLoggedIn).toBe(false);
  });

  it("logoutOpenAI removes stored openai provider token", () => {
    // First save a token
    mod.saveVoiceOAuthToken("openai", {
      accessToken: "tok_test_abc",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(mod.hasVoiceOAuthToken("openai")).toBe(true);

    const result = mod.logoutOpenAI();
    expect(result.ok).toBe(true);
    expect(result.wasLoggedIn).toBe(true);
    expect(mod.hasVoiceOAuthToken("openai", true)).toBe(false);
  });

  // ── refreshOpenAICodexToken ───────────────────────────────────────────────

  it("refreshOpenAICodexToken throws when no refresh token stored", async () => {
    await expect(mod.refreshOpenAICodexToken()).rejects.toThrow(/refresh token/i);
  });

  it("refreshOpenAICodexToken calls auth.openai.com/oauth/token with refresh grant", async () => {
    // Store a token with a refresh_token
    mod.saveVoiceOAuthToken("openai", {
      accessToken: "old_access",
      refreshToken: "rt_refresh_token_123",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // expired
    });

    _fetchMock.mockReturnValueOnce(
      makeFetchOk({
        access_token: "new_access_token",
        refresh_token: "rt_new_refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    await mod.refreshOpenAICodexToken();

    expect(_fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = _fetchMock.mock.calls[0];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(opts.method).toBe("POST");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt_refresh_token_123");
    expect(body.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
  });

  it("refreshOpenAICodexToken saves new access token after successful refresh", async () => {
    mod.saveVoiceOAuthToken("openai", {
      accessToken: "old_access",
      refreshToken: "rt_to_refresh",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    _fetchMock.mockReturnValueOnce(
      makeFetchOk({
        access_token: "refreshed_access",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    await mod.refreshOpenAICodexToken();
    const resolved = mod.resolveVoiceOAuthToken("openai", true);
    expect(resolved?.token).toBe("refreshed_access");
  });

  it("describes voice provider lifecycle with refreshability and missing actions", async () => {
    mod.saveVoiceOAuthToken("openai", {
      accessToken: "voice_openai_token",
      refreshToken: "voice_refresh_token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const lifecycle = mod.describeVoiceProviderLifecycle("openai");

    expect(lifecycle).toEqual(expect.objectContaining({
      provider: "openai",
      status: "connected",
      hasToken: true,
      refreshable: true,
      connectedSource: expect.any(String),
    }));
    expect(lifecycle.missingActions).toEqual([]);
  });

  it("refreshOpenAICodexToken throws on non-OK response", async () => {
    mod.saveVoiceOAuthToken("openai", {
      accessToken: "old",
      refreshToken: "rt_bad",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    _fetchMock.mockReturnValueOnce(makeFetchFail(401, "invalid_token"));

    await expect(mod.refreshOpenAICodexToken()).rejects.toThrow(/401/);
  });

  // ── OAuth callback server handler ─────────────────────────────────────────

  it("callback handler exchanges code for token and saves it", async () => {
    mod.startOpenAICodexLogin();
    const { authUrl } = mod.startOpenAICodexLogin(); // second call to get fresh state
    const state = new URL(authUrl).searchParams.get("state");

    _fetchMock.mockReturnValueOnce(
      makeFetchOk({
        access_token: "callback_access_token",
        refresh_token: "rt_callback",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    // Simulate the browser callback
    const fakeReq = {
      url: `/auth/callback?code=authcode123&state=${state}`,
    };
    const chunks = [];
    const fakeRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn((chunk) => { if (chunk) chunks.push(chunk); }),
    };

    await new Promise((resolve) => {
      const originalEnd = fakeRes.end;
      fakeRes.end = vi.fn((chunk) => {
        originalEnd(chunk);
        // Give the async handler time to finish
        setTimeout(resolve, 50);
      });
      _mockServer._handler(fakeReq, fakeRes);
    });

    expect(fakeRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    // Token should now be stored
    const { status } = mod.getOpenAILoginStatus();
    expect(status).toBe("complete");
    const resolved = mod.resolveVoiceOAuthToken("openai", true);
    expect(resolved?.token).toBe("callback_access_token");
  });

  it("callback handler rejects state mismatch", () => {
    mod.startOpenAICodexLogin();
    const fakeReq = { url: "/auth/callback?code=abc&state=wrong_state" };
    const fakeRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    _mockServer._handler(fakeReq, fakeRes);
    expect(fakeRes.writeHead).toHaveBeenCalledWith(400);
    const { status } = mod.getOpenAILoginStatus();
    expect(status).toBe("error");
  });

  it("callback handler handles error param from OAuth server", () => {
    mod.startOpenAICodexLogin();

    const fakeReq = { url: "/auth/callback?error=access_denied&error_description=User+denied" };
    const fakeRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    _mockServer._handler(fakeReq, fakeRes);
    expect(fakeRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const { status } = mod.getOpenAILoginStatus();
    expect(status).toBe("error");
  });

  it("callback handler ignores non-callback paths", () => {
    mod.startOpenAICodexLogin();
    const fakeReq = { url: "/favicon.ico" };
    const fakeRes = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    _mockServer._handler(fakeReq, fakeRes);
    expect(fakeRes.writeHead).toHaveBeenCalledWith(404);
  });
});

// ════════════════════════════════════════════════════════════════
// Claude OAuth
// ════════════════════════════════════════════════════════════════
describe("voice-auth-manager Claude OAuth", () => {
  let mod;

  beforeEach(async () => {
    _fsStore = {};
    _mockServer.listen.mockClear();
    _mockServer.close.mockClear();
    _mockServer.on.mockClear();
    _fetchMock.mockReset();
    vi.resetModules();
    mod = await import("../voice/voice-auth-manager.mjs");
  });

  afterEach(() => {
    mod.cancelClaudeLogin?.();
  });

  it("startClaudeLogin returns an authUrl pointing to platform.claude.com", () => {
    const { authUrl } = mod.startClaudeLogin();
    expect(authUrl).toMatch(/^https:\/\/platform\.claude\.com\/oauth\/authorize\?/);
  });

  it("authUrl contains the correct Claude client_id", () => {
    const { authUrl } = mod.startClaudeLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });

  it("authUrl includes required Claude scopes (including user:inference)", () => {
    const { authUrl } = mod.startClaudeLogin();
    const scope = new URL(authUrl).searchParams.get("scope") || "";
    expect(scope).toContain("user:inference");
    expect(scope).toContain("user:profile");
  });

  it("authUrl contains PKCE code_challenge and S256 method", () => {
    const { authUrl } = mod.startClaudeLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("authUrl contains correct redirect_uri for Claude (port 10001)", () => {
    const { authUrl } = mod.startClaudeLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("redirect_uri")).toBe("http://localhost:10001/auth/callback");
  });

  it("starts the callback HTTP server on port 10001", () => {
    mod.startClaudeLogin();
    expect(_mockServer.listen).toHaveBeenCalledWith(10001, "127.0.0.1");
  });

  it("getClaudeLoginStatus returns idle initially", () => {
    const { status } = mod.getClaudeLoginStatus();
    expect(status).toBe("idle");
    expect(mod.getClaudeLoginStatus().hasToken).toBe(false);
  });

  it("getClaudeLoginStatus returns pending after startClaudeLogin", () => {
    mod.startClaudeLogin();
    expect(mod.getClaudeLoginStatus().status).toBe("pending");
  });

  it("cancelClaudeLogin resets status to idle and closes server", () => {
    mod.startClaudeLogin();
    _mockServer.close.mockClear();
    mod.cancelClaudeLogin();
    expect(mod.getClaudeLoginStatus().status).toBe("idle");
    expect(_mockServer.close).toHaveBeenCalled();
  });

  it("logoutClaude returns wasLoggedIn:false when no token", () => {
    const result = mod.logoutClaude();
    expect(result.ok).toBe(true);
    expect(result.wasLoggedIn).toBe(false);
  });

  it("refreshClaudeToken calls platform.claude.com/v1/oauth/token", async () => {
    mod.saveVoiceOAuthToken("claude", {
      accessToken: "old",
      refreshToken: "rt_claude_abc",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    _fetchMock.mockReturnValueOnce(makeFetchOk({
      access_token: "new_claude",
      expires_in: 3600,
    }));
    await mod.refreshClaudeToken();
    const [url] = _fetchMock.mock.calls[0];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(mod.resolveVoiceOAuthToken("claude", true)?.token).toBe("new_claude");
  });
});

// ════════════════════════════════════════════════════════════════
// Google Gemini OAuth
// ════════════════════════════════════════════════════════════════
describe("voice-auth-manager Gemini OAuth", () => {
  let mod;

  const FAKE_GEMINI_CLIENT_ID = "test-gemini-client-id.apps.googleusercontent.com";
  const FAKE_GEMINI_CLIENT_SECRET = "test-gemini-client-secret";

  beforeEach(async () => {
    _fsStore = {};
    _mockServer.listen.mockClear();
    _mockServer.close.mockClear();
    _mockServer.on.mockClear();
    _fetchMock.mockReset();
    process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID = FAKE_GEMINI_CLIENT_ID;
    process.env.BOSUN_GEMINI_OAUTH_CLIENT_SECRET = FAKE_GEMINI_CLIENT_SECRET;
    vi.resetModules();
    mod = await import("../voice/voice-auth-manager.mjs");
  });

  afterEach(() => {
    mod.cancelGeminiLogin?.();
    delete process.env.BOSUN_GEMINI_OAUTH_CLIENT_ID;
    delete process.env.BOSUN_GEMINI_OAUTH_CLIENT_SECRET;
  });

  it("startGeminiLogin returns an authUrl pointing to accounts.google.com", () => {
    const { authUrl } = mod.startGeminiLogin();
    expect(authUrl).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  });

  it("authUrl contains the correct Gemini client_id", () => {
    const { authUrl } = mod.startGeminiLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("client_id")).toBe(FAKE_GEMINI_CLIENT_ID);
  });

  it("authUrl contains access_type=offline and prompt=consent for refresh tokens", () => {
    const { authUrl } = mod.startGeminiLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("authUrl contains PKCE code_challenge and S256 method", () => {
    const { authUrl } = mod.startGeminiLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("authUrl contains correct redirect_uri for Gemini (port 10002)", () => {
    const { authUrl } = mod.startGeminiLogin();
    const params = new URLSearchParams(new URL(authUrl).search);
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:10002/auth/callback");
  });

  it("starts the callback HTTP server on port 10002", () => {
    mod.startGeminiLogin();
    expect(_mockServer.listen).toHaveBeenCalledWith(10002, "127.0.0.1");
  });

  it("getGeminiLoginStatus returns idle initially", () => {
    expect(mod.getGeminiLoginStatus().status).toBe("idle");
  });

  it("getGeminiLoginStatus returns pending after startGeminiLogin", () => {
    mod.startGeminiLogin();
    expect(mod.getGeminiLoginStatus().status).toBe("pending");
  });

  it("cancelGeminiLogin resets status and closes server", () => {
    mod.startGeminiLogin();
    _mockServer.close.mockClear();
    mod.cancelGeminiLogin();
    expect(mod.getGeminiLoginStatus().status).toBe("idle");
    expect(_mockServer.close).toHaveBeenCalled();
  });

  it("logoutGemini returns wasLoggedIn:false when no token", () => {
    const r = mod.logoutGemini();
    expect(r.ok).toBe(true);
    expect(r.wasLoggedIn).toBe(false);
  });

  it("refreshGeminiToken calls oauth2.googleapis.com/token", async () => {
    mod.saveVoiceOAuthToken("gemini", {
      accessToken: "old",
      refreshToken: "rt_gemini_xyz",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    _fetchMock.mockReturnValueOnce(makeFetchOk({
      access_token: "new_gemini",
      expires_in: 3600,
    }));
    await mod.refreshGeminiToken();
    const [url, opts] = _fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(opts.body);
    expect(body.get("client_secret")).toBe(FAKE_GEMINI_CLIENT_SECRET);
    expect(mod.resolveVoiceOAuthToken("gemini", true)?.token).toBe("new_gemini");
  });

  it("Gemini scope includes cloud-platform and user profile scopes", () => {
    const { authUrl } = mod.startGeminiLogin();
    const scope = new URL(authUrl).searchParams.get("scope");
    expect(scope).toContain("cloud-platform");
    expect(scope).toContain("userinfo.email");
  });
});
