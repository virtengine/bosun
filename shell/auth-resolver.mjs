/**
 * shell/auth-resolver.mjs — Unified Credential Resolver for Native Adapters
 *
 * Resolves API keys, OAuth tokens, and endpoint configuration from:
 *   1. execOptions.providerConfig (highest priority)
 *   2. execOptions.env / process.env
 *   3. Shared auth state file (~/.bosun/voice-auth-state.json)
 *   4. Provider-specific fallbacks
 *
 * This is intentionally self-contained (no imports from agent/) to avoid
 * circular dependencies. It reads the auth state JSON file directly.
 *
 * Public API:
 *   resolveCredentials(execOptions) → { apiKey, oauthToken, authMode, isAzure, ... }
 *   resolveSharedOAuthToken(provider) → { token, source, expiresAt } | null
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TAG = "[auth-resolver]";

function toStr(v) {
  return String(v ?? "").trim();
}

function isAzureHostname(url) {
  if (!url) return false;
  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
    return host === "azure.com" || host.endsWith(".azure.com") || host.endsWith(".cognitiveservices.azure.com");
  } catch {
    return false;
  }
}

function isOpenRouterHostname(url) {
  if (!url) return false;
  try {
    const host = new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

const AUTH_STATE_PATH = join(homedir(), ".bosun", "voice-auth-state.json");

let _authStateCache = null;
let _authStateMtime = 0;

function readAuthState() {
  try {
    if (!existsSync(AUTH_STATE_PATH)) return {};
    try {
      const s = statSync(AUTH_STATE_PATH);
      if (s.mtimeMs === _authStateMtime && _authStateCache) {
        return _authStateCache;
      }
      _authStateMtime = s.mtimeMs;
    } catch {
      // Best effort
    }
    const raw = readFileSync(AUTH_STATE_PATH, "utf8");
    const parsed = raw ? JSON.parse(raw) : {};
    _authStateCache = parsed && typeof parsed === "object" ? parsed : {};
    return _authStateCache;
  } catch (err) {
    console.warn(`${TAG} failed to read auth state: ${err?.message || err}`);
    return {};
  }
}

/**
 * Resolve OAuth / API token from the shared auth state file.
 * @param {string} provider  e.g. "azure", "openai", "claude"
 */
export function resolveSharedOAuthToken(provider) {
  const accountId = toStr(provider).toLowerCase();
  if (!accountId) return null;

  const state = readAuthState();
  const providerState = state?.providers?.[accountId] || state?.[accountId] || {};
  const token = toStr(
    providerState.accessToken
    || providerState.access_token
    || providerState.oauthToken
    || providerState.oauth_token,
  );
  if (!token) return null;

  const expiresAt = toStr(providerState.expiresAt || providerState.expires_at);
  if (expiresAt && Date.now() > new Date(expiresAt).getTime()) {
    return null; // Expired
  }

  return {
    token,
    source: "state",
    provider: accountId,
    expiresAt: expiresAt || null,
    refreshToken: toStr(providerState.refreshToken || providerState.refresh_token) || null,
  };
}

/**
 * Full credential resolution for native adapters.
 *
 * @param {object} execOptions
 * @returns {object}  Resolved credentials with apiKey, oauthToken, authMode, isAzure, etc.
 */
export function resolveCredentials(execOptions) {
  const pc = execOptions?.providerConfig ?? {};
  const env = execOptions?.env ?? process.env;

  const effectiveEndpoint =
    toStr(pc.endpoint)
    || toStr(pc.baseUrl)
    || toStr(env.OPENAI_BASE_URL)
    || "";

  const isAzure =
    (isAzureHostname(effectiveEndpoint)
      || Boolean(toStr(pc.deployment))
      || pc.provider === "azure-openai-responses"
      || pc.providerId === "azure-openai-responses"
      || pc.provider === "azure"
      || toStr(pc.authMode).toLowerCase().includes("azure")) &&
    Boolean(effectiveEndpoint);

  const isOpenRouter =
    isOpenRouterHostname(effectiveEndpoint)
    || pc.provider === "openrouter"
    || pc.providerId === "openrouter";

  // ── API Key resolution ────────────────────────────────────────────────────
  // Priority: providerConfig → provider-specific env → generic env → auth state
  const provider = toStr(pc.provider || pc.providerId).toLowerCase();
  let providerApiKey = "";
  if (provider.includes("azure")) {
    providerApiKey = toStr(env.AZURE_OPENAI_API_KEY);
  } else if (provider.includes("anthropic") || provider.includes("claude")) {
    providerApiKey = toStr(env.ANTHROPIC_API_KEY);
  } else if (provider.includes("gemini") || provider.includes("google")) {
    providerApiKey = toStr(env.GOOGLE_API_KEY) || toStr(env.GEMINI_API_KEY);
  } else if (provider.includes("openai") && !provider.includes("azure")) {
    providerApiKey = toStr(env.OPENAI_API_KEY);
  }

  let apiKey =
    toStr(pc.apiKey)
    || providerApiKey
    || toStr(env.OPENAI_API_KEY)
    || toStr(env.AZURE_OPENAI_API_KEY)
    || toStr(env.ANTHROPIC_API_KEY)
    || toStr(env.GOOGLE_API_KEY)
    || toStr(env.GEMINI_API_KEY)
    || "";

  if (!apiKey && isOpenRouter) {
    apiKey = toStr(env.OPENROUTER_API_KEY) || "";
  }

  // ── OAuth Token resolution ────────────────────────────────────────────────
  // Priority: providerConfig → env → shared auth state
  let oauthToken =
    toStr(pc.oauthToken)
    || toStr(env.AZURE_OPENAI_AD_TOKEN)
    || toStr(env.AZURE_OPENAI_ACCESS_TOKEN)
    || toStr(env.OPENAI_OAUTH_ACCESS_TOKEN)
    || toStr(env.OPENAI_ACCESS_TOKEN)
    || "";

  // Fallback to shared auth state for Azure
  if (!oauthToken && isAzure) {
    const shared = resolveSharedOAuthToken("azure");
    if (shared?.token) {
      oauthToken = shared.token;
    }
  }

  // Fallback to shared auth state for OpenAI
  if (!apiKey && !oauthToken && !isAzure) {
    const shared = resolveSharedOAuthToken("openai");
    if (shared?.token) {
      // If token starts with sk- it's an API key, otherwise OAuth
      if (shared.token.startsWith("sk-")) {
        apiKey = shared.token;
      } else {
        oauthToken = shared.token;
      }
    }
  }

  // ── Auth mode determination ───────────────────────────────────────────────
  let authMode = toStr(pc.authMode) || "";
  if (!authMode) {
    if (oauthToken && !apiKey) authMode = "oauth";
    else if (apiKey) authMode = "apiKey";
    else authMode = "apiKey";
  }

  // For Azure: if we have an OAuth token AND the auth mode isn't explicitly apiKey, prefer OAuth
  if (isAzure && oauthToken && authMode !== "apiKey") {
    authMode = "oauth";
  }

  // ── Azure-specific endpoint resolution ────────────────────────────────────
  let resolvedEndpoint = effectiveEndpoint;
  let resolvedDeployment = toStr(pc.deployment) || "";

  if (isAzure && !resolvedEndpoint) {
    const resourceName = toStr(env.AZURE_RESOURCE_NAME) || toStr(pc.resourceName);
    if (resourceName) {
      resolvedEndpoint = `https://${resourceName}.openai.azure.com`;
    }
  }

  // ── Per-provider extra headers ────────────────────────────────────────────
  const extraHeaders = {};
  if (isOpenRouter) {
    extraHeaders["HTTP-Referer"] = "https://bosun.dev/";
    extraHeaders["X-Title"] = "bosun";
  }

  return {
    apiKey,
    oauthToken,
    authMode,
    isAzure,
    isOpenRouter,
    endpoint: resolvedEndpoint,
    baseUrl: resolvedEndpoint,
    deployment: resolvedDeployment,
    apiVersion: toStr(pc.apiVersion) || env.OPENAI_API_VERSION || "2025-03-01-preview",
    resourceName: toStr(env.AZURE_RESOURCE_NAME) || toStr(pc.resourceName) || "",
    extraHeaders,
    // Include sources for debugging
    _sources: {
      apiKey: apiKey ? (pc.apiKey ? "providerConfig" : (env.AZURE_OPENAI_API_KEY || env.OPENAI_API_KEY) ? "env" : "authState") : null,
      oauthToken: oauthToken ? (pc.oauthToken ? "providerConfig" : (env.AZURE_OPENAI_AD_TOKEN || env.AZURE_OPENAI_ACCESS_TOKEN) ? "env" : "authState") : null,
    },
  };
}

export default { resolveCredentials, resolveSharedOAuthToken };
