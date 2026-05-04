import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getOAuthUserLogin, getUserToken, loadOAuthState } from "../github/github-app-auth.mjs";

const PROVIDER_AUTH_STATE_PATH = join(homedir(), ".bosun", "voice-auth-state.json");
const STATE_TTL_MS = 15_000;

let _cachedState = null;
let _cachedStateAt = 0;

function toTrimmedString(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (lowered === "undefined" || lowered === "null") return "";
  return normalized;
}

function normalizeBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeAuthAccountId(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return "";
  if (normalized === "openai-codex-subscription" || normalized === "openai-responses" || normalized === "chatgpt" || normalized === "codex") {
    return "openai";
  }
  if (normalized === "azure-openai-responses") return "azure";
  if (normalized === "claude-subscription-shim" || normalized === "anthropic" || normalized === "claude-code") {
    return "claude";
  }
  if (normalized === "copilot-oauth" || normalized === "copilot" || normalized === "github") {
    return "copilot";
  }
  return normalized;
}

function readStateFile() {
  if (!existsSync(PROVIDER_AUTH_STATE_PATH)) return {};
  const raw = readFileSync(PROVIDER_AUTH_STATE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function getCachedState(forceReload = false) {
  const isFresh = !forceReload && _cachedState && (Date.now() - _cachedStateAt < STATE_TTL_MS);
  if (isFresh) return _cachedState;
  try {
    _cachedState = readStateFile();
  } catch {
    _cachedState = {};
  }
  _cachedStateAt = Date.now();
  return _cachedState;
}

function writeCachedState(next) {
  mkdirSync(dirname(PROVIDER_AUTH_STATE_PATH), { recursive: true });
  writeFileSync(PROVIDER_AUTH_STATE_PATH, JSON.stringify(next, null, 2));
  _cachedState = next;
  _cachedStateAt = Date.now();
}

function isExpired(expiresAt) {
  const normalized = toTrimmedString(expiresAt);
  if (!normalized) return false;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return false;
  return parsed <= Date.now() + 30_000;
}

function decodeJwtPayload(token) {
  const raw = toTrimmedString(token);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readNestedString(value, paths = []) {
  for (const path of paths) {
    let current = value;
    let valid = true;
    for (const key of path) {
      if (!current || typeof current !== "object" || !(key in current)) {
        valid = false;
        break;
      }
      current = current[key];
    }
    if (!valid) continue;
    const normalized = toTrimmedString(current);
    if (normalized) return normalized;
  }
  return "";
}

export function getProviderAuthStatePath() {
  return PROVIDER_AUTH_STATE_PATH;
}

export function readProviderAuthState(forceReload = false) {
  return getCachedState(forceReload);
}

export function resolveSharedOAuthToken(provider, forceReload = false) {
  const accountId = normalizeAuthAccountId(provider);
  if (!accountId) return null;

  const envCandidates = {
    openai: [
      process.env.BOSUN_VOICE_OPENAI_ACCESS_TOKEN,
      process.env.OPENAI_OAUTH_ACCESS_TOKEN,
      process.env.OPENAI_ACCESS_TOKEN,
    ],
    azure: [
      process.env.BOSUN_VOICE_AZURE_ACCESS_TOKEN,
      process.env.AZURE_OPENAI_ACCESS_TOKEN,
      process.env.AZURE_OPENAI_AD_TOKEN,
    ],
    claude: [
      process.env.BOSUN_VOICE_CLAUDE_ACCESS_TOKEN,
      process.env.CLAUDE_ACCESS_TOKEN,
      process.env.ANTHROPIC_ACCESS_TOKEN,
    ],
    gemini: [
      process.env.BOSUN_VOICE_GEMINI_ACCESS_TOKEN,
      process.env.GEMINI_ACCESS_TOKEN,
      process.env.GOOGLE_ACCESS_TOKEN,
    ],
  }[accountId] || [];

  const envToken = envCandidates.map((entry) => toTrimmedString(entry)).find(Boolean);
  if (envToken) {
    return {
      token: envToken,
      source: "env",
      provider: accountId,
      expiresAt: null,
    };
  }

  const state = getCachedState(forceReload);
  const providerState = state?.providers?.[accountId] || state?.[accountId] || {};
  const token = toTrimmedString(
    providerState.accessToken
    || providerState.access_token
    || providerState.oauthToken
    || providerState.oauth_token,
  );
  if (!token) return null;
  const expiresAt = toTrimmedString(providerState.expiresAt || providerState.expires_at);
  if (isExpired(expiresAt)) return null;
  return {
    token,
    source: "state",
    provider: accountId,
    expiresAt: expiresAt || null,
    refreshToken: toTrimmedString(providerState.refreshToken || providerState.refresh_token) || null,
  };
}

export function hasSharedOAuthToken(provider, forceReload = false) {
  return Boolean(resolveSharedOAuthToken(provider, forceReload));
}

export function saveSharedOAuthToken(provider, payload = {}) {
  const accountId = normalizeAuthAccountId(provider);
  if (!accountId) throw new Error("provider is required");
  const accessToken = toTrimmedString(payload?.accessToken || payload?.access_token);
  if (!accessToken) throw new Error("access token is required");
  const current = getCachedState(true);
  const next = {
    ...current,
    providers: {
      ...(current?.providers || {}),
      [accountId]: {
        accessToken,
        expiresAt: payload?.expiresAt || payload?.expires_at || null,
        refreshToken: payload?.refreshToken || payload?.refresh_token || null,
        tokenType: payload?.tokenType || payload?.token_type || "Bearer",
        updatedAt: new Date().toISOString(),
      },
    },
  };
  writeCachedState(next);
  return {
    ok: true,
    path: PROVIDER_AUTH_STATE_PATH,
    provider: accountId,
  };
}

export function clearSharedOAuthToken(provider) {
  const accountId = normalizeAuthAccountId(provider);
  if (!accountId) return { ok: true, wasLoggedIn: false };
  const current = getCachedState(true);
  if (!current?.providers?.[accountId]) return { ok: true, wasLoggedIn: false };
  const next = {
    ...current,
    providers: {
      ...(current.providers || {}),
    },
  };
  delete next.providers[accountId];
  writeCachedState(next);
  return { ok: true, wasLoggedIn: true };
}

export function resolveCodexAuthPath(env = process.env) {
  const explicit = toTrimmedString(env.CODEX_AUTH_JSON_PATH);
  if (explicit) return explicit;
  const codexHome = toTrimmedString(env.CODEX_HOME);
  if (codexHome) return join(codexHome, "auth.json");
  return join(homedir(), ".codex", "auth.json");
}

export function parseChatgptAccountId(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return "";
  return toTrimmedString(
    payload["https://api.openai.com/auth.chatgpt_account_id"]
    || payload.chatgpt_account_id,
  );
}

function loadJsonFile(path) {
  const resolved = toTrimmedString(path);
  if (!resolved || !existsSync(resolved)) return null;
  try {
    const raw = readFileSync(resolved, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveCodexSubscriptionAuth(env = process.env) {
  const envAccessToken = toTrimmedString(
    env.CODEX_API_KEY
    || env.OPENAI_ACCESS_TOKEN
    || env.OPENAI_OAUTH_TOKEN,
  );
  const envAccountId = toTrimmedString(env.CODEX_ACCOUNT_ID || env.CHATGPT_ACCOUNT_ID);
  if (envAccessToken) {
    return {
      authenticated: true,
      source: "env",
      token: envAccessToken,
      accountId: envAccountId || parseChatgptAccountId(envAccessToken) || null,
      authPath: null,
      authMode: envAccessToken.startsWith("sk-") ? "apiKey" : "oauth",
    };
  }

  const sharedToken = resolveSharedOAuthToken("openai");
  if (sharedToken?.token) {
    return {
      authenticated: true,
      source: sharedToken.source,
      token: sharedToken.token,
      accountId: parseChatgptAccountId(sharedToken.token) || null,
      authPath: null,
      authMode: "oauth",
      expiresAt: sharedToken.expiresAt || null,
    };
  }

  const authPath = resolveCodexAuthPath(env);
  const authJson = loadJsonFile(authPath);
  if (!authJson) {
    return {
      authenticated: false,
      source: "none",
      token: "",
      accountId: null,
      authPath,
      authMode: null,
    };
  }

  const token = readNestedString(authJson, [
    ["OPENAI_API_KEY"],
    ["CODEX_API_KEY"],
    ["access_token"],
    ["accessToken"],
    ["tokens", "access_token"],
    ["tokens", "accessToken"],
    ["tokens", "OPENAI_API_KEY"],
    ["tokens", "CODEX_API_KEY"],
    ["tokens", "id_token"],
    ["tokens", "idToken"],
    ["auth", "OPENAI_API_KEY"],
    ["auth", "CODEX_API_KEY"],
    ["auth", "access_token"],
    ["auth", "accessToken"],
    ["token", "OPENAI_API_KEY"],
    ["token", "CODEX_API_KEY"],
    ["token", "access_token"],
    ["token", "accessToken"],
  ]);
  const accountId =
    envAccountId
    || readNestedString(authJson, [
      ["account_id"],
      ["accountId"],
      ["tokens", "account_id"],
      ["tokens", "accountId"],
      ["auth", "account_id"],
      ["auth", "accountId"],
    ])
    || parseChatgptAccountId(token)
    || "";
  const authMode = toTrimmedString(authJson.auth_mode || authJson.authMode).toLowerCase();
  return {
    authenticated: Boolean(token),
    source: token ? "auth.json" : "none",
    token,
    accountId: accountId || null,
    authPath,
    authMode: authMode || (token.startsWith("sk-") ? "apiKey" : "oauth"),
    lastRefresh: toTrimmedString(authJson.last_refresh || authJson.lastRefresh) || null,
  };
}

export function resolveCopilotOAuthAuth(env = process.env) {
  const directToken = toTrimmedString(env.COPILOT_ACCESS_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN);
  if (directToken) {
    return {
      authenticated: true,
      source: "env",
      token: directToken,
      login: null,
    };
  }

  const token = toTrimmedString(getUserToken());
  const login = toTrimmedString(getOAuthUserLogin());
  const state = loadOAuthState?.() || null;
  if (token) {
    return {
      authenticated: true,
      source: "github-oauth-state",
      token,
      login: login || toTrimmedString(state?.user?.login) || null,
      savedAt: toTrimmedString(state?.savedAt) || null,
    };
  }

  return {
    authenticated: false,
    source: "none",
    token: "",
    login: null,
  };
}

export function buildSharedProviderAccountSummary(forceReload = false) {
  const openai = resolveSharedOAuthToken("openai", forceReload);
  const azure = resolveSharedOAuthToken("azure", forceReload);
  const claude = resolveSharedOAuthToken("claude", forceReload);
  const gemini = resolveSharedOAuthToken("gemini", forceReload);
  const codex = resolveCodexSubscriptionAuth(process.env);
  const copilot = resolveCopilotOAuthAuth(process.env);
  return {
    openai: {
      connected: Boolean(openai?.token),
      hasToken: Boolean(openai?.token),
      status: openai?.token ? "connected" : "idle",
      source: openai?.source || null,
      expiresAt: openai?.expiresAt || null,
    },
    azure: {
      connected: Boolean(azure?.token),
      hasToken: Boolean(azure?.token),
      status: azure?.token ? "connected" : "idle",
      source: azure?.source || null,
      expiresAt: azure?.expiresAt || null,
    },
    claude: {
      connected: Boolean(claude?.token),
      hasToken: Boolean(claude?.token),
      status: claude?.token ? "connected" : "idle",
      source: claude?.source || null,
      expiresAt: claude?.expiresAt || null,
      warning: claude?.token
        ? {
            code: "claude_oauth_tos_warning",
            severity: "warning",
            message: "Claude OAuth tokens are intended for Anthropic's first-party clients. Using Claude OAuth with third-party tools may violate Anthropic terms. Switch Claude integrations to API key mode if you want this warning to disappear.",
          }
        : null,
    },
    gemini: {
      connected: Boolean(gemini?.token),
      hasToken: Boolean(gemini?.token),
      status: gemini?.token ? "connected" : "idle",
      source: gemini?.source || null,
      expiresAt: gemini?.expiresAt || null,
    },
    codex: {
      connected: codex?.authenticated === true,
      hasToken: Boolean(codex?.token),
      status: codex?.authenticated ? "connected" : "idle",
      source: codex?.source || null,
      authMode: codex?.authMode || null,
      accountId: codex?.accountId || null,
      authPath: codex?.authPath || null,
    },
    copilot: {
      connected: copilot?.authenticated === true,
      hasToken: Boolean(copilot?.token),
      status: copilot?.authenticated ? "connected" : "idle",
      source: copilot?.source || null,
      accountId: copilot?.login || null,
    },
  };
}

export function isClaudeOAuthTosWarningRequired(options = {}) {
  return normalizeBoolean(options.enabled, true)
    && normalizeBoolean(options.authenticated, true)
    && ["oauth", "subscription"].includes(toTrimmedString(options.mode).toLowerCase());
}
