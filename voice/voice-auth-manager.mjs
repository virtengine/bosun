import { createHash, randomBytes } from "node:crypto";
import { exec as childExec } from "node:child_process";
import { createServer } from "node:http";
import { CredentialStore } from "../workflow/credential-store.mjs";
import {
  clearSharedOAuthToken,
  getProviderAuthStatePath,
  hasSharedOAuthToken,
  readProviderAuthState,
  resolveSharedOAuthToken,
  saveSharedOAuthToken,
} from "../agent/provider-auth-state.mjs";

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function normalizeEnvValue(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (lowered === "undefined" || lowered === "null") return "";
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, '&#39;');
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const ts = Number(new Date(expiresAt).getTime());
  if (Number.isNaN(ts)) return false;
  return ts <= Date.now() + 30_000;
}

function resolveCredentialStore(options = {}) {
  if (options.credentialStore) return options.credentialStore;
  if (!options.configDir) return null;
  try {
    return new CredentialStore({
      configDir: options.configDir,
      secretKey: options.secretKey,
    });
  } catch {
    return null;
  }
}

function getProviderEnvCandidates(provider) {
  switch (provider) {
    case "openai":
      return [
        process.env.BOSUN_VOICE_OPENAI_ACCESS_TOKEN,
        process.env.OPENAI_OAUTH_ACCESS_TOKEN,
        process.env.OPENAI_ACCESS_TOKEN,
      ];
    case "azure":
      return [
        process.env.BOSUN_VOICE_AZURE_ACCESS_TOKEN,
        process.env.AZURE_OPENAI_ACCESS_TOKEN,
      ];
    case "claude":
      return [
        process.env.BOSUN_VOICE_CLAUDE_ACCESS_TOKEN,
        process.env.ANTHROPIC_ACCESS_TOKEN,
      ];
    case "gemini":
      return [
        process.env.BOSUN_VOICE_GEMINI_ACCESS_TOKEN,
        process.env.GEMINI_ACCESS_TOKEN,
        process.env.GOOGLE_ACCESS_TOKEN,
      ];
    default:
      return [];
  }
}

export function resolveVoiceOAuthToken(provider, forceReload = false) {
  const normalizedProvider = normalizeProvider(provider);
  if (!normalizedProvider) return null;
  return resolveSharedOAuthToken(normalizedProvider, forceReload);
}

export function hasVoiceOAuthToken(provider, forceReload = false) {
  return hasSharedOAuthToken(provider, forceReload);
}

export function saveVoiceOAuthToken(provider, payload = {}) {
  return saveSharedOAuthToken(provider, payload);
}

export function getVoiceAuthStatePath() {
  return getProviderAuthStatePath();
}

// ── Generic OAuth PKCE provider registry ─────────────────────────────────────
//
// Provider configs reverse-engineered from official CLI tools:
// • openai  — https://github.com/openai/codex + opencode/issues/3281
// • claude  — github.com/XiaoConstantine/dspy-go/pkg/llms (Claude Code client)
// • gemini  — google-gemini/gemini-cli (Google Gemini CLI public client)
//
// All use OAuth 2.0 Authorization Code + PKCE (RFC 7636) with no client secret
// (public clients per RFC 8252 §8.4).
const CLAUDE_DEFAULT_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
].join(" ");

const OPENAI_DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.model.read",
].join(" ");

function normalizeScopeList(scopes) {
  return Array.from(
    new Set(
      String(scopes || "")
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ).join(" ");
}

function envOrDefault(name, fallback = "") {
  const value = normalizeEnvValue(process.env[name]);
  if (!value) return fallback;
  return value;
}

const GEMINI_DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const OAUTH_PROVIDERS = {
  openai: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://localhost:1455/auth/callback",
    port: 1455,
    // OpenAI's current public OAuth client allows OIDC-style scopes.
    // Keep an override for custom/private clients that support additional scopes.
    scopes: normalizeScopeList(
      process.env.BOSUN_OPENAI_OAUTH_SCOPES?.trim() || OPENAI_DEFAULT_SCOPES,
    ),
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    },
    accentColor: "#10a37f",
  },
  claude: {
    // Claude Code official OAuth client + scopes (Anthropic CLI parity).
    clientId: envOrDefault("BOSUN_CLAUDE_OAUTH_CLIENT_ID")
      || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: envOrDefault("BOSUN_CLAUDE_OAUTH_AUTHORIZE_URL")
      || "https://platform.claude.com/oauth/authorize",
    tokenUrl: envOrDefault("BOSUN_CLAUDE_OAUTH_TOKEN_URL")
      || "https://platform.claude.com/v1/oauth/token",
    redirectUri: "http://localhost:10001/auth/callback",
    port: 10001,
    // Claude requires explicit scopes. Keep env override for emergency rotation.
    scopes: envOrDefault("BOSUN_CLAUDE_OAUTH_SCOPES") || CLAUDE_DEFAULT_SCOPES,
    extraParams: {},
    accentColor: "#d97706",
  },
  gemini: {
    // Gemini CLI OAuth client (google-gemini/gemini-cli-core parity).
    // Set BOSUN_GEMINI_OAUTH_CLIENT_ID / BOSUN_GEMINI_OAUTH_CLIENT_SECRET in
    // your .env, or use the well-known public credentials from the gemini-cli
    // open-source repo (see .env.example for guidance).
    clientId: envOrDefault("BOSUN_GEMINI_OAUTH_CLIENT_ID"),
    clientSecret: envOrDefault("BOSUN_GEMINI_OAUTH_CLIENT_SECRET"),
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Google recommends loopback IP literals for local OAuth callbacks.
    redirectUri: "http://127.0.0.1:10002/auth/callback",
    port: 10002,
    scopes: envOrDefault("BOSUN_GEMINI_OAUTH_SCOPES") || GEMINI_DEFAULT_SCOPES,
    extraParams: {
      // Offline access (refresh token) + force consent screen to re-issue refresh_token
      access_type: "offline",
      prompt: "consent",
    },
    accentColor: "#1a73e8",
  },
};

function resolveVoiceProviderCredentialRecord(provider, options = {}) {
  const credentialStore = resolveCredentialStore(options);
  if (!credentialStore) return { record: null, validation: null };
  const candidates = credentialStore.listByProvider(provider);
  const record = candidates.find((entry) => {
    const authMode = normalizeProvider(entry?.lifecycle?.authMode || entry?.metadata?.authMode || "oauth");
    return !authMode || authMode === "oauth";
  }) || null;
  if (!record) return { record: null, validation: null };
  return {
    record,
    validation: credentialStore.validate(record.name, {
      env: options.env || process.env,
      config: options.config || null,
      workflowId: options.workflowId,
    }),
  };
}

export function describeVoiceProviderLifecycle(provider, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const cfg = OAUTH_PROVIDERS[normalizedProvider];
  if (!cfg) {
    return {
      provider: normalizedProvider,
      status: "unknown",
      missingActions: [],
      envKeys: [],
      refreshable: false,
    };
  }

  const token = resolveVoiceOAuthToken(normalizedProvider, options.forceReload === true);
  const loginStatus = _providerPendingLogin.get(normalizedProvider)?.status || "idle";
  const clientIdConfigured = normalizeEnvValue(cfg.clientId).length >= 8;
  const { record, validation } = resolveVoiceProviderCredentialRecord(normalizedProvider, options);
  const refreshable = Boolean(token?.refreshToken || validation?.refreshable);
  const missingActions = [];

  if (!clientIdConfigured) missingActions.push("configure_client");
  if (!token?.token && !record?.name) missingActions.push("sign_in");
  if (token?.expiresAt && isExpired(token.expiresAt) && refreshable) missingActions.push("refresh_token");

  return {
    provider: normalizedProvider,
    status: token?.token
      ? (isExpired(token.expiresAt) ? "expired" : "connected")
      : (loginStatus === "pending" ? "pending" : "idle"),
    hasToken: Boolean(token?.token),
    expiresAt: token?.expiresAt || validation?.expiresAt || null,
    refreshable,
    connectedSource: token?.source || (record?.name ? "credential-store" : null),
    pendingStatus: loginStatus,
    clientIdConfigured,
    requiredEnvKeys: cfg.clientSecret
      ? [`BOSUN_${normalizedProvider.toUpperCase()}_OAUTH_CLIENT_ID`, `BOSUN_${normalizedProvider.toUpperCase()}_OAUTH_CLIENT_SECRET`]
      : [`BOSUN_${normalizedProvider.toUpperCase()}_OAUTH_CLIENT_ID`],
    missingActions,
    credentialName: record?.name || null,
    validationErrors: validation?.errors || [],
  };
}

export function validateVoiceProviderLifecycle(provider, options = {}) {
  const lifecycle = describeVoiceProviderLifecycle(provider, options);
  return {
    ok: lifecycle.missingActions.length === 0 && lifecycle.validationErrors.length === 0,
    status: lifecycle.status,
    missingActions: lifecycle.missingActions,
    validationErrors: lifecycle.validationErrors,
    refreshable: lifecycle.refreshable,
  };
}

// Module-scope per-provider pending login state (never inside a function — hard rule).
const _providerPendingLogin = new Map();

// ── PKCE helpers ──────────────────────────────────────────────────────────────

function _generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}

function _computeCodeChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function _generateState() {
  return randomBytes(16).toString("hex");
}

// ── Generic token exchange ────────────────────────────────────────────────────

async function _exchangeCode(code, codeVerifier, cfg) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: codeVerifier,
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Generic one-shot callback server ─────────────────────────────────────────

function _createCallbackServer(provider, cfg, expectedState, codeVerifier) {
  const port = cfg.port;
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://localhost:${port}`);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    if (url.pathname !== "/auth/callback") {
      res.writeHead(404).end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") || error || "Unknown error";
    const pending = _providerPendingLogin.get(provider);

    if (error) {
      const providerHint = provider === "openai" && /invalid_scope/i.test(String(error))
        ? "<p><strong>Hint:</strong> OpenAI rejected one or more requested OAuth scopes. Reset to default OIDC scopes (openid profile email offline_access) and reconnect.</p>"
        : "";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
        <h2>Sign-in failed</h2><p>${escapeHtml(errorDescription)}</p>${providerHint}<p>You can close this window.</p>
      </body></html>`);
      if (pending) { pending.status = "error"; pending.result = { error: errorDescription }; }
      setTimeout(() => server.close(), 500);
      return;
    }

    if (!code || state !== expectedState) {
      res.writeHead(400).end("Invalid callback");
      if (pending) { pending.status = "error"; pending.result = { error: "state_mismatch" }; }
      setTimeout(() => server.close(), 500);
      return;
    }

    _exchangeCode(code, codeVerifier, cfg)
      .then((tokenData) => {
        const expiresAt = tokenData.expires_in
          ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
          : null;
        saveVoiceOAuthToken(provider, {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || null,
          expiresAt,
          tokenType: tokenData.token_type || "Bearer",
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px;text-align:center">
          <h2 style="color:${cfg.accentColor}">✓ Signed in successfully</h2>
          <p>You can close this window and return to Bosun.</p>
        </body></html>`);
        const p = _providerPendingLogin.get(provider);
        if (p) { p.status = "complete"; p.result = { ok: true }; }
      })
      .catch((err) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:40px">
          <h2>Token exchange failed</h2><p>${err.message}</p><p>You can close this window.</p>
        </body></html>`);
        const p = _providerPendingLogin.get(provider);
        if (p) { p.status = "error"; p.result = { error: err.message }; }
      })
      .finally(() => { setTimeout(() => server.close(), 1000); });
  });

  server.on("error", (err) => {
    const p = _providerPendingLogin.get(provider);
    if (p?.status === "pending") { p.status = "error"; p.result = { error: err.message }; }
  });

  // Bind explicitly to 127.0.0.1 (IPv4) rather than "localhost", which Node.js
  // resolves to ::1 (IPv6) on Windows — causing connection refused when the
  // browser follows the OAuth redirect to http://localhost:<port>/auth/callback.
  server.listen(port, "127.0.0.1");
  return server;
}

// ── Open browser cross-platform ───────────────────────────────────────────────

function _openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  childExec(cmd, () => { /* non-fatal: URL already returned to caller */ });
}

// ── Generic provider login functions ────────────────────────────────────────

function _startProviderLogin(provider, options = {}) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  if (!cfg.clientId || String(cfg.clientId).trim().length < 8) {
    throw new Error(
      `OAuth client_id is missing for provider "${provider}". ` +
      `Set the relevant BOSUN_*_OAUTH_CLIENT_ID env var or restore defaults in voice-auth-manager.mjs.`,
    );
  }

  // Cancel any existing login for this provider
  _cancelProviderLogin(provider);

  const codeVerifier = _generateCodeVerifier();
  const codeChallenge = _computeCodeChallenge(codeVerifier);
  const state = _generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    ...(cfg.scopes ? { scope: cfg.scopes } : {}),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...cfg.extraParams,
  });

  const authUrl = `${cfg.authorizeUrl}?${params.toString()}`;
  const server = _createCallbackServer(provider, cfg, state, codeVerifier);

  _providerPendingLogin.set(provider, {
    state,
    codeVerifier,
    server,
    status: "pending",
    result: null,
    startedAt: Date.now(),
  });

  if (options.openBrowser !== false) {
    try { _openBrowser(authUrl); } catch { /* ignore */ }
  }

  return { authUrl };
}

function _getProviderLoginStatus(provider) {
  const resolved = resolveVoiceOAuthToken(provider, false);
  const hasToken = Boolean(resolved);
  const accessToken = resolved?.token || null;
  const pending = _providerPendingLogin.get(provider);
  if (!pending) {
    return { status: hasToken ? "connected" : "idle", hasToken, accessToken };
  }
  const elapsed = Date.now() - pending.startedAt;
  if (elapsed > 5 * 60 * 1000 && pending.status === "pending") {
    _cancelProviderLogin(provider);
    return { status: "idle", hasToken, accessToken };
  }
  return { status: pending.status, result: pending.result || null, hasToken, accessToken };
}

function _cancelProviderLogin(provider) {
  const pending = _providerPendingLogin.get(provider);
  if (pending?.server) {
    try { pending.server.close(); } catch { /* ignore */ }
  }
  _providerPendingLogin.delete(provider);
}

function _logoutProvider(provider) {
  return clearSharedOAuthToken(provider);
}

async function _refreshProviderToken(provider) {
  const cfg = OAUTH_PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);

  const state = readProviderAuthState(true);
  const providerData = state?.providers?.[provider] || {};
  const refreshToken = providerData.refreshToken || providerData.refresh_token;
  if (!refreshToken) throw new Error(`No refresh token stored for ${provider}`);

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    ...(cfg.extraParams?.access_type ? { access_type: cfg.extraParams.access_type } : {}),
  });
  if (cfg.clientSecret) params.set("client_secret", cfg.clientSecret);

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const tokenData = await res.json();
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
    : null;

  saveVoiceOAuthToken(provider, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token || refreshToken,
    expiresAt,
    tokenType: tokenData.token_type || "Bearer",
  });

  return tokenData;
}

// ── Public API — OpenAI ──────────────────────────────────────────────────────

/** Start the OpenAI Codex OAuth PKCE flow (same as Codex CLI / ChatGPT app). */
export function startOpenAICodexLogin(options)    { return _startProviderLogin("openai", options); }
/** Poll the status of an in-progress OpenAI login. */
export function getOpenAILoginStatus()     { return _getProviderLoginStatus("openai"); }
/** Cancel an in-progress OpenAI login. */
export function cancelOpenAILogin()        { return _cancelProviderLogin("openai"); }
/** Remove the stored OpenAI OAuth token. */
export function logoutOpenAI()             { return _logoutProvider("openai"); }
/** Refresh an expired OpenAI access token using the stored refresh_token. */
export async function refreshOpenAICodexToken() { return _refreshProviderToken("openai"); }

// ── Public API — Claude ──────────────────────────────────────────────────────

/** Start the Anthropic Claude OAuth PKCE flow (same as `claude auth login`). */
export function startClaudeLogin(options)         { return _startProviderLogin("claude", options); }
/** Poll the status of an in-progress Claude login. */
export function getClaudeLoginStatus()     { return _getProviderLoginStatus("claude"); }
/** Cancel an in-progress Claude login. */
export function cancelClaudeLogin()        { return _cancelProviderLogin("claude"); }
/** Remove the stored Claude OAuth token. */
export function logoutClaude()             { return _logoutProvider("claude"); }
/** Refresh an expired Claude access token. */
export async function refreshClaudeToken() { return _refreshProviderToken("claude"); }

// ── Public API — Google Gemini ───────────────────────────────────────────────

/** Start the Google Gemini OAuth PKCE flow (same as gemini-cli `gemini auth login`). */
export function startGeminiLogin(options)         { return _startProviderLogin("gemini", options); }
/** Poll the status of an in-progress Gemini login. */
export function getGeminiLoginStatus()     { return _getProviderLoginStatus("gemini"); }
/** Cancel an in-progress Gemini login. */
export function cancelGeminiLogin()        { return _cancelProviderLogin("gemini"); }
/** Remove the stored Gemini OAuth token. */
export function logoutGemini()             { return _logoutProvider("gemini"); }
/** Refresh an expired Gemini access token. */
export async function refreshGeminiToken() { return _refreshProviderToken("gemini"); }
