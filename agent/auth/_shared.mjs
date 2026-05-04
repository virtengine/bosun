import { getBuiltInProviderDriver, normalizeProviderDefinitionId } from "../providers/index.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function parseBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = toTrimmedString(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function firstConfigured(keys = [], sources = []) {
  for (const key of keys) {
    for (const source of sources) {
      const value = toTrimmedString(source?.[key]);
      if (!value) continue;
      return {
        value,
        key,
        source: source === sources[0] ? "settings" : "env",
      };
    }
  }
  return {
    value: "",
    key: null,
    source: null,
  };
}

export function createProviderAuthAdapter(definition = {}) {
  const providerId = normalizeProviderDefinitionId(definition.providerId, "");
  const driver = getBuiltInProviderDriver(providerId);
  if (!providerId || !driver) {
    throw new Error("Known providerId is required for auth adapter");
  }
  const settingsConfig = definition.settings && typeof definition.settings === "object"
    ? definition.settings
    : {};
  const envConfig = definition.env && typeof definition.env === "object"
    ? definition.env
    : {};
  const defaults = {
    enabled: driver.visibility?.defaultEnabled === true,
    authMode: driver.auth?.preferredMode || null,
    defaultModel: driver.models?.defaultModel || null,
  };
  return Object.freeze({
    id: providerId,
    providerId,
    label: definition.label || driver.name || providerId,
    driver,
    settingsConfig,
    envConfig,
    listSettingsKeys() {
      return Object.values(settingsConfig).filter(Boolean);
    },
    resolveSettings(options = {}) {
      const settings = options.settings && typeof options.settings === "object" ? options.settings : {};
      const env = options.env && typeof options.env === "object" ? options.env : {};
      const sources = [settings, env];
      const enabledRaw = firstConfigured([settingsConfig.enabled], sources);
      const authModeRaw = firstConfigured([settingsConfig.authMode], sources);
      const defaultModelRaw = firstConfigured([settingsConfig.defaultModel, settingsConfig.globalDefaultModel], sources);
      const baseUrlRaw = firstConfigured([settingsConfig.baseUrl], sources);
      const endpointRaw = firstConfigured([settingsConfig.endpoint], sources);
      const deploymentRaw = firstConfigured([settingsConfig.deployment], sources);
      const apiVersionRaw = firstConfigured([settingsConfig.apiVersion], sources);
      const workspaceRaw = firstConfigured([settingsConfig.workspace], sources);
      const enabled = enabledRaw.key
        ? parseBooleanLike(enabledRaw.value, defaults.enabled)
        : defaults.enabled;
      return {
        providerId,
        enabled,
        enabledSource: enabledRaw.source || "default",
        authMode: authModeRaw.value || defaults.authMode,
        authModeSource: authModeRaw.source || (defaults.authMode ? "default" : null),
        defaultModel: defaultModelRaw.value || defaults.defaultModel,
        defaultModelSource: defaultModelRaw.source || (defaults.defaultModel ? "default" : null),
        baseUrl: baseUrlRaw.value || null,
        baseUrlSource: baseUrlRaw.source || null,
        endpoint: endpointRaw.value || null,
        endpointSource: endpointRaw.source || null,
        deployment: deploymentRaw.value || null,
        deploymentSource: deploymentRaw.source || null,
        apiVersion: apiVersionRaw.value || null,
        apiVersionSource: apiVersionRaw.source || null,
        workspace: workspaceRaw.value || null,
        workspaceSource: workspaceRaw.source || null,
      };
    },
    resolveEnv(env = process.env) {
      const hints = driver.auth?.env && typeof driver.auth.env === "object"
        ? driver.auth.env
        : {};
      const sources = [env];
      const readEntry = (keys = []) => {
        const match = firstConfigured([...(Array.isArray(keys) ? keys : [])], sources);
        return {
          configured: Boolean(match.value),
          key: match.key,
          value: match.value || null,
          source: match.source || null,
          keys: [...(Array.isArray(keys) ? keys : [])],
        };
      };
      return {
        providerId,
        apiKey: readEntry(hints.apiKey),
        oauth: readEntry(hints.oauth),
        subscription: readEntry(hints.subscription),
        endpoint: readEntry(hints.endpoint),
        baseUrl: readEntry(hints.baseUrl),
        deployment: readEntry(hints.deployment),
        apiVersion: readEntry(hints.apiVersion),
        organization: readEntry(hints.organization),
        project: readEntry(hints.project),
        workspace: readEntry(hints.workspace),
      };
    },
  });
}

export default createProviderAuthAdapter;
