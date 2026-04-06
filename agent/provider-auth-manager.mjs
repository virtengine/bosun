import { getProviderCapabilities, normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getProviderAuthAdapter } from "./auth/index.mjs";
import { getBuiltinProviderEnvHints } from "./providers/index.mjs";
import { CredentialStore } from "../workflow/credential-store.mjs";
import {
  buildSharedProviderAccountSummary,
  isClaudeOAuthTosWarningRequired,
  resolveCodexSubscriptionAuth,
  resolveCopilotOAuthAuth,
  resolveSharedOAuthToken,
} from "./provider-auth-state.mjs";

const AUTH_METHOD_ORDER = Object.freeze([
  "local",
  "subscription",
  "oauth",
  "apiKey",
]);

const PROVIDER_CREDENTIAL_BLUEPRINTS = Object.freeze({
  "openai-responses": {
    apiKey: {
      label: "OpenAI API Key",
      envKeys: ["OPENAI_API_KEY"],
      validation: { prefix: "sk-", minLength: 12 },
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
    },
  },
  "anthropic-messages": {
    apiKey: {
      label: "Anthropic API Key",
      envKeys: ["ANTHROPIC_API_KEY"],
      validation: { prefix: "sk-ant-", minLength: 12 },
      templates: {
        headers: {
          "x-api-key": "{{credential.value}}",
          "anthropic-version": "2023-06-01",
        },
      },
    },
  },
  "azure-openai-responses": {
    apiKey: {
      label: "Azure OpenAI API Key",
      envKeys: ["AZURE_OPENAI_API_KEY"],
      validation: { minLength: 12 },
      templates: {
        headers: { "api-key": "{{credential.value}}" },
        query: { "api-version": "{{context.apiVersion}}" },
      },
    },
    oauth: {
      label: "Azure OpenAI OAuth Token",
      envKeys: ["AZURE_OPENAI_ACCESS_TOKEN", "AZURE_OPENAI_AD_TOKEN"],
      templates: {
        headers: { Authorization: "Bearer {{credential.value}}" },
        query: { "api-version": "{{context.apiVersion}}" },
      },
      refreshable: true,
    },
  },
  "openai-compatible": {
    apiKey: {
      label: "OpenAI-Compatible API Key",
      envKeys: ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"],
      validation: { minLength: 8 },
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
    },
  },
  "gemini-generate-content": {
    apiKey: {
      label: "Gemini API Key",
      envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      validation: { minLength: 12 },
      templates: {},
    },
  },
  "openai-codex-subscription": {
    oauth: {
      label: "OpenAI OAuth Session",
      envKeys: ["OPENAI_OAUTH_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN"],
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
      refreshable: true,
    },
    apiKey: {
      label: "Codex API Key",
      envKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
      validation: { minLength: 12 },
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
    },
  },
  "claude-subscription-shim": {
    oauth: {
      label: "Claude OAuth Session",
      envKeys: ["CLAUDE_ACCESS_TOKEN", "ANTHROPIC_ACCESS_TOKEN"],
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
      refreshable: true,
    },
  },
  "copilot-oauth": {
    oauth: {
      label: "GitHub Copilot OAuth Session",
      envKeys: ["GITHUB_TOKEN", "GH_TOKEN", "COPILOT_ACCESS_TOKEN"],
      templates: { headers: { Authorization: "Bearer {{credential.value}}" } },
      refreshable: true,
    },
  },
});

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === "object") return Object.values(value).some(hasValue);
  return toTrimmedString(value) !== "";
}

function normalizeMethodName(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "apikey") return "apiKey";
  return normalized;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCredentialName(value = "") {
  return toTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
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

function buildSyntheticCredentialValidation(value, blueprint = {}) {
  const errors = [];
  const validation = blueprint.validation && typeof blueprint.validation === "object"
    ? blueprint.validation
    : {};
  if (!hasValue(value)) errors.push("Credential value is missing");
  if (hasValue(value) && validation.prefix && !String(value).startsWith(validation.prefix)) {
    errors.push(`Credential must start with "${validation.prefix}"`);
  }
  if (hasValue(value) && validation.minLength && String(value).length < validation.minLength) {
    errors.push(`Credential must be at least ${validation.minLength} characters`);
  }
  if (hasValue(value) && validation.pattern) {
    try {
      if (!new RegExp(validation.pattern).test(String(value))) {
        errors.push("Credential does not match the required format");
      }
    } catch {
      errors.push("Credential validation pattern is invalid");
    }
  }
  return {
    ok: errors.length === 0,
    status: errors.length > 0 ? (!hasValue(value) ? "missing" : "invalid") : "ready",
    errors,
    value: value || null,
    expiringSoon: false,
    refreshable: blueprint.refreshable === true,
  };
}

function resolveProviderCredentialRecord(providerId, method, options = {}) {
  const credentialStore = resolveCredentialStore(options);
  const blueprint = PROVIDER_CREDENTIAL_BLUEPRINTS?.[providerId]?.[method] || null;
  if (!blueprint) return { credentialStore, blueprint, record: null, validation: null, templates: null };

  const explicitName = toTrimmedString(
    options.credentialNames?.[method]
    || options.credentialNames?.[providerId]
    || options.credentialName,
  );
  const providerCredentials = credentialStore?.listByProvider(providerId) || [];
  const matchingRecord =
    (explicitName ? credentialStore?.get(explicitName) : null)
    || providerCredentials.find((entry) => {
      const lifecycleMode = toTrimmedString(entry?.lifecycle?.authMode || entry?.metadata?.authMode || "").toLowerCase();
      if (lifecycleMode && lifecycleMode !== method.toLowerCase()) return false;
      return true;
    })
    || null;

  if (matchingRecord) {
    const validation = credentialStore.validate(matchingRecord.name, {
      workflowId: options.workflowId,
      env: options.env || process.env,
      config: options.config || null,
    });
    const templates = credentialStore.resolveTemplates(matchingRecord.name, matchingRecord.templates || blueprint.templates || {}, {
      workflowId: options.workflowId,
      env: options.env || process.env,
      config: options.config || null,
      providerId,
      context: {
        apiVersion: options.settings?.apiVersion || options.settings?.api_version || null,
      },
    });
    return { credentialStore, blueprint, record: matchingRecord, validation, templates };
  }

  const envState = resolveProviderAuthEnv(providerId, options.env || process.env);
  const envInfo = method === "apiKey"
    ? envState.apiKey
    : method === "oauth"
      ? envState.oauth
      : envState.subscription;
  const value = toTrimmedString(envInfo?.value || "");
  const validation = buildSyntheticCredentialValidation(value, blueprint);
  const templates = blueprint.templates
    ? CredentialStore
      ? {
          headers: {},
          query: {},
          body: {},
          ...{
            headers: Object.fromEntries(
              Object.entries(blueprint.templates.headers || {}).map(([key, template]) => [
                key,
                String(template).replace("{{credential.value}}", value),
              ]),
            ),
            query: Object.fromEntries(
              Object.entries(blueprint.templates.query || {}).map(([key, template]) => [
                key,
                String(template).replace("{{context.apiVersion}}", toTrimmedString(options.settings?.apiVersion || options.settings?.api_version || "")),
              ]),
            ),
            body: blueprint.templates.body || {},
          },
        }
      : null
    : null;
  return { credentialStore, blueprint, record: null, validation, templates };
}

export function buildProviderCredentialLifecycle(providerId, resolvedState = {}, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const state = resolvedState && typeof resolvedState === "object" ? resolvedState : {};
  const methods = Array.isArray(state.methods) ? state.methods : [];
  const supportedMethods = methods.length > 0
    ? methods
    : listProviderAuthModes(normalizedProviderId).map((type) => ({ type }));
  const lifecycleMethods = supportedMethods.map((methodState) => {
    const methodType = normalizeMethodName(methodState?.type || methodState);
    const { blueprint, record, validation, templates } = resolveProviderCredentialRecord(
      normalizedProviderId,
      methodType,
      {
        ...options,
        settings: state.settings || options.settings || {},
      },
    );
    const configured = record
      ? validation?.ok === true || validation?.status === "expiring"
      : methodState?.configured === true || validation?.ok === true;
    const authenticated = methodState?.authenticated === true || state.preferredMode === methodType && state.authenticated === true;
    const expiresAt =
      validation?.expiresAt
      || record?.lifecycle?.expiresAt
      || methodState?.expiresAt
      || state.expiresAt
      || null;
    const requiresCredential = methodType !== "local";
    const missing = requiresCredential && !(configured || authenticated);
    const source = record?.name
      ? "credential-store"
      : methodState?.source || (validation?.value ? "env" : null);
    return {
      type: methodType,
      label: blueprint?.label || methodType,
      configured,
      authenticated,
      status: authenticated
        ? "authenticated"
        : configured
          ? (validation?.status || "configured")
          : (missing ? "missing" : "idle"),
      source,
      missing,
      refreshable: validation?.refreshable === true || blueprint?.refreshable === true,
      envKeys: blueprint?.envKeys || [],
      credentialName: record?.name || null,
      templates: templates || blueprint?.templates || null,
      validationErrors: validation?.errors || [],
      expiresAt,
    };
  });

  const missingCredentials = lifecycleMethods
    .filter((entry) => entry.missing)
    .map((entry) => ({
      type: entry.type,
      label: entry.label,
      envKeys: entry.envKeys,
    }));

  return {
    providerId: normalizedProviderId,
    status: missingCredentials.length > 0
      ? "missing"
      : lifecycleMethods.some((entry) => entry.authenticated)
        ? "authenticated"
        : lifecycleMethods.some((entry) => entry.configured)
          ? "configured"
          : "idle",
    methods: lifecycleMethods,
    missingCredentials,
  };
}

function getProviderEnvHints(providerId) {
  return getBuiltinProviderEnvHints(providerId);
}

function resolveAdapterSettings(providerId, options = {}) {
  const adapter = getProviderAuthAdapter(providerId);
  if (!adapter) {
    return {
      providerId: normalizeProviderCapabilityId(providerId),
      enabled: options.enabled !== undefined ? options.enabled === true : true,
      enabledSource: options.enabled !== undefined ? "input" : "default",
      authMode: null,
      authModeSource: null,
      defaultModel: null,
      defaultModelSource: null,
      baseUrl: null,
      baseUrlSource: null,
      endpoint: null,
      endpointSource: null,
      deployment: null,
      deploymentSource: null,
      apiVersion: null,
      apiVersionSource: null,
      workspace: null,
      workspaceSource: null,
    };
  }
  const resolved = adapter.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  });
  if (options.enabled !== undefined) {
    return {
      ...resolved,
      enabled: options.enabled === true,
      enabledSource: "input",
    };
  }
  return resolved;
}

function readEnvHints(env = process.env, keys = []) {
  for (const key of keys) {
    const value = toTrimmedString(env?.[key]);
    if (!value) continue;
    return {
      configured: true,
      source: "env",
      key,
      value,
    };
  }
  return {
    configured: false,
    source: null,
    key: null,
    value: null,
  };
}

export function listProviderAuthModes(providerId, capabilities = null) {
  const adapter = getProviderAuthAdapter(providerId);
  if (adapter?.driver?.auth?.supportedModes?.length > 0) {
    return unique(adapter.driver.auth.supportedModes.map(normalizeMethodName));
  }
  const capabilitySnapshot = capabilities && typeof capabilities === "object"
    ? { ...capabilities }
    : getProviderCapabilities(providerId);
  if (capabilitySnapshot.auth === false) return [];
  const supported = [];
  if (capabilitySnapshot.local) supported.push("local");
  if (capabilitySnapshot.subscription) supported.push("subscription");
  if (capabilitySnapshot.oauth) supported.push("oauth");
  if (capabilitySnapshot.apiKey) supported.push("apiKey");
  return supported.length > 0 ? supported : ["apiKey"];
}

export function resolveProviderAuthEnv(providerId, env = process.env) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const adapter = getProviderAuthAdapter(normalizedProviderId);
  if (adapter) {
    return adapter.resolveEnv(env);
  }
  const hints = getProviderEnvHints(normalizedProviderId);
  return {
    providerId: normalizedProviderId,
    apiKey: readEnvHints(env, hints.apiKey),
    oauth: readEnvHints(env, hints.oauth),
    subscription: readEnvHints(env, hints.subscription),
  };
}

function normalizeMethodState(method, authState = {}, envState = {}, capabilities = {}) {
  const credentials = authState.credentials && typeof authState.credentials === "object"
    ? authState.credentials
    : {};
  const errors = authState.errors && typeof authState.errors === "object"
    ? authState.errors
    : {};
  const lastError = toTrimmedString(errors[method] || authState.lastError || "");
  const expiresAt = toTrimmedString(authState.expiresAt || authState[`${method}ExpiresAt`] || "");
  const expired = authState.expired === true
    || authState[`${method}Expired`] === true
    || (expiresAt ? Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now() : false);
  const revoked = authState.revoked === true || authState[`${method}Revoked`] === true;
  if (method === "local") {
    const available = authState.localAvailable !== false && authState.available !== false;
    return {
      type: method,
      supported: capabilities.local === true,
      available,
      configured: available,
      authenticated: available && !revoked,
      source: "runtime",
      credentialKey: null,
      lastError,
      expiresAt: null,
    };
  }

  if (method === "apiKey") {
    const explicitValue =
      authState.apiKey
      || credentials.apiKey
      || authState.secret
      || credentials.secret;
    const envInfo = envState.apiKey || { configured: false, key: null, source: null };
    const configured = hasValue(explicitValue) || envInfo.configured;
    return {
      type: method,
      supported: capabilities.apiKey === true,
      available: true,
      configured,
      authenticated: configured && !expired && !revoked,
      source: hasValue(explicitValue) ? "input" : envInfo.source,
      credentialKey: envInfo.key,
      lastError,
      expiresAt: expired ? expiresAt || null : null,
    };
  }

  if (method === "oauth") {
    const token =
      authState.accessToken
      || authState.oauthToken
      || credentials.accessToken
      || credentials.oauthToken;
    const envInfo = envState.oauth || { configured: false, key: null, source: null };
    const configured = hasValue(token) || envInfo.configured || authState.connected === true;
    const authenticated = authState.authenticated === true
      || authState.connected === true
      || authState.loggedIn === true
      || (configured && !expired && !revoked);
    return {
      type: method,
      supported: capabilities.oauth === true,
      available: true,
      configured,
      authenticated,
      source: hasValue(token) ? "input" : envInfo.source,
      credentialKey: envInfo.key,
      lastError,
      expiresAt: expiresAt || null,
    };
  }

  const envInfo = envState.subscription || { configured: false, key: null, source: null };
  const configured = authState.loggedIn === true
    || authState.sessionActive === true
    || authState.subscriptionActive === true
    || hasValue(authState.accountId)
    || envInfo.configured;
  const authenticated = authState.authenticated === true
    || authState.loggedIn === true
    || authState.sessionActive === true
    || authState.subscriptionActive === true
    || (envInfo.configured && !revoked);
  return {
    type: "subscription",
    supported: capabilities.subscription === true,
    available: true,
    configured,
    authenticated,
    source: configured && !hasValue(authState.accountId) ? envInfo.source : "input",
    credentialKey: envInfo.key,
    lastError,
    expiresAt: expiresAt || null,
  };
}

function buildImplicitProviderAuthState(providerId, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  if (normalizedProviderId === "openai-codex-subscription") {
    const detected = resolveCodexSubscriptionAuth(options.env || process.env);
    if (!detected?.authenticated) return {};
    const mode = detected.authMode === "apikey" ? "apiKey" : (detected.authMode || "oauth");
    return {
      mode,
      authMode: mode,
      accessToken: detected.token || null,
      connected: true,
      authenticated: true,
      loggedIn: true,
      sessionActive: true,
      subscriptionActive: mode !== "apiKey",
      accountId: detected.accountId || null,
      authSource: detected.source || null,
      authPath: detected.authPath || null,
      lastRefresh: detected.lastRefresh || null,
    };
  }

  if (normalizedProviderId === "claude-subscription-shim") {
    const shared = resolveSharedOAuthToken("claude");
    if (!shared?.token) return {};
    return {
      mode: "oauth",
      authMode: "oauth",
      accessToken: shared.token,
      connected: true,
      authenticated: true,
      loggedIn: true,
      sessionActive: true,
      subscriptionActive: true,
      authSource: shared.source || null,
      expiresAt: shared.expiresAt || null,
    };
  }

  if (normalizedProviderId === "copilot-oauth") {
    const detected = resolveCopilotOAuthAuth(options.env || process.env);
    if (!detected?.authenticated) return {};
    return {
      mode: "oauth",
      authMode: "oauth",
      accessToken: detected.token || null,
      connected: true,
      authenticated: true,
      loggedIn: true,
      sessionActive: true,
      authSource: detected.source || null,
      accountId: detected.login || null,
    };
  }

  if (normalizedProviderId === "azure-openai-responses") {
    const shared = resolveSharedOAuthToken("azure");
    if (!shared?.token) return {};
    return {
      mode: "oauth",
      authMode: "oauth",
      accessToken: shared.token,
      connected: true,
      authenticated: true,
      loggedIn: true,
      sessionActive: true,
      authSource: shared.source || null,
      expiresAt: shared.expiresAt || null,
    };
  }

  if (normalizedProviderId === "openai-responses") {
    const shared = resolveSharedOAuthToken("openai");
    if (!shared?.token) return {};
    return {
      mode: "oauth",
      authMode: "oauth",
      accessToken: shared.token,
      connected: true,
      authenticated: true,
      loggedIn: true,
      sessionActive: true,
      authSource: shared.source || null,
      expiresAt: shared.expiresAt || null,
    };
  }

  return {};
}

function buildProviderWarnings(providerId, resolvedState = {}, preferredMethod = null) {
  const warnings = [];
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  if (
    normalizedProviderId === "claude-subscription-shim"
    && isClaudeOAuthTosWarningRequired({
      enabled: resolvedState?.enabled !== false,
      authenticated: resolvedState?.authenticated === true || preferredMethod?.configured === true,
      mode: preferredMethod?.type || resolvedState?.preferredMode || resolvedState?.settings?.authMode || resolvedState?.settings?.mode,
    })
  ) {
    warnings.push({
      code: "claude_oauth_tos_warning",
      severity: "warning",
      message: "Claude OAuth tokens are intended for Anthropic first-party clients. Using Claude OAuth with Bosun tooling may violate Anthropic terms. Switch Claude integrations to API key mode if you want this warning to disappear.",
    });
  }
  return warnings;
}

export function normalizeProviderAuthState(providerId, authState = {}, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const capabilitySnapshot = options.capabilities && typeof options.capabilities === "object"
    ? { ...getProviderCapabilities(normalizedProviderId), ...options.capabilities }
    : getProviderCapabilities(normalizedProviderId);
  const settingsState = resolveAdapterSettings(normalizedProviderId, options);
  const envState = resolveProviderAuthEnv(normalizedProviderId, options.env || process.env);
  const implicitAuthState = options.implicitAuth === false
    ? {}
    : buildImplicitProviderAuthState(normalizedProviderId, options);
  const mergedAuthState = {
    ...(implicitAuthState && typeof implicitAuthState === "object" ? implicitAuthState : {}),
    ...(authState && typeof authState === "object" ? authState : {}),
  };
  const supportedModes = listProviderAuthModes(normalizedProviderId, capabilitySnapshot);
  const requestedMode = normalizeMethodName(
    options.preferredMode
    || mergedAuthState.mode
    || mergedAuthState.authMode
    || settingsState.authMode,
  );
  const methods = supportedModes
    .map((mode) => normalizeMethodState(mode, mergedAuthState, envState, capabilitySnapshot))
    .sort((left, right) => AUTH_METHOD_ORDER.indexOf(left.type) - AUTH_METHOD_ORDER.indexOf(right.type));
  const preferredMethod =
    methods.find((entry) => entry.type === requestedMode)
    || methods.find((entry) => entry.authenticated)
    || methods.find((entry) => entry.configured)
    || methods[0]
    || null;
  const authenticated = capabilitySnapshot.auth === false || methods.some((entry) => entry.authenticated);
  const enabled = settingsState.enabled !== false;
  const available = enabled && (
    capabilitySnapshot.auth === false
    || methods.length === 0
    || methods.some((entry) => entry.available !== false)
  );
  const requiresAction = enabled
    && capabilitySnapshot.auth !== false
    && !!preferredMethod
    && preferredMethod.type !== "local"
    && !authenticated;
  let status = "unavailable";
  if (!enabled) {
    status = "disabled";
  } else if (capabilitySnapshot.auth === false) {
    status = "ready";
  } else if (!available) {
    status = "unavailable";
  } else if (preferredMethod?.type === "local" && preferredMethod.authenticated) {
    status = "local_ready";
  } else if (authenticated) {
    status = "authenticated";
  } else if (methods.some((entry) => entry.configured)) {
    status = "configured";
  } else {
    status = "unauthenticated";
  }
  const warnings = buildProviderWarnings(normalizedProviderId, {
    enabled,
    authenticated,
    preferredMode: preferredMethod?.type || null,
    settings: settingsState,
  }, preferredMethod);
  const lifecycle = buildProviderCredentialLifecycle(normalizedProviderId, {
    providerId: normalizedProviderId,
    status,
    enabled,
    available,
    authenticated,
    preferredMode: preferredMethod?.type || null,
    expiresAt: preferredMethod?.expiresAt || null,
    methods,
    settings: settingsState,
  }, options);
  return {
    providerId: normalizedProviderId,
    status,
    enabled,
    available,
    authenticated,
    canRun: enabled && (capabilitySnapshot.auth === false || authenticated || status === "local_ready"),
    requiresAction,
    preferredMode: preferredMethod?.type || null,
    supportedModes: unique(methods.map((entry) => entry.type)),
    capabilitySnapshot,
    methods,
    lastError: preferredMethod?.lastError || null,
    expiresAt: preferredMethod?.expiresAt || null,
    connection: {
      authSource: toTrimmedString(mergedAuthState.authSource || "") || null,
      accountId: toTrimmedString(mergedAuthState.accountId || "") || null,
      authPath: toTrimmedString(mergedAuthState.authPath || "") || null,
      lastRefresh: toTrimmedString(mergedAuthState.lastRefresh || "") || null,
    },
    settings: settingsState,
    env: envState,
    credentialLifecycle: lifecycle,
    warnings,
    sharedAccounts: buildSharedProviderAccountSummary(false),
  };
}

export function createProviderAuthManager(defaultOptions = {}) {
  return {
    listAuthModes(providerId, capabilities = null) {
      return listProviderAuthModes(providerId, capabilities);
    },
    resolveEnv(providerId, env = defaultOptions.env || process.env) {
      return resolveProviderAuthEnv(providerId, env);
    },
    resolve(providerId, authState = {}, options = {}) {
      return normalizeProviderAuthState(providerId, authState, { ...defaultOptions, ...options });
    },
    resolveCredentialLifecycle(providerId, authState = {}, options = {}) {
      const resolved = this.resolve(providerId, authState, options);
      return resolved.credentialLifecycle || buildProviderCredentialLifecycle(providerId, resolved, { ...defaultOptions, ...options });
    },
    isAuthenticated(providerId, authState = {}, options = {}) {
      return this.resolve(providerId, authState, options).authenticated;
    },
  };
}

export default createProviderAuthManager;
