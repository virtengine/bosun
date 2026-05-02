import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_ACTIVE_PROFILE = "xl";
const DEFAULT_SUBAGENT_PROFILE = "m";

function clean(value) {
  return String(value ?? "").trim();
}

function isAzureOpenAIBaseUrl(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value || ""));
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
  } catch {
    return false;
  }
}

function normalizeAzureOpenAIBaseUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!isAzureOpenAIBaseUrl(parsed)) {
      return raw;
    }
    parsed.pathname = "/openai/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function normalizeProfileName(value, fallback = DEFAULT_ACTIVE_PROFILE) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  return raw.replace(/[^a-z0-9_-]/g, "") || fallback;
}

function profilePrefix(name) {
  return `CODEX_MODEL_PROFILE_${name.toUpperCase()}_`;
}

function normalizeProvider(value, fallback) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (["azure", "azure-openai", "azure_openai"].includes(raw)) {
    return "azure";
  }
  if (["openai", "default"].includes(raw)) {
    return "openai";
  }
  if (["compatible", "openai-compatible", "openai_compatible"].includes(raw)) {
    return "compatible";
  }
  return fallback;
}

function hasEnvValue(env, key) {
  return Boolean(key && clean(env?.[key]));
}

export function getProviderEndpointEnvKeys(sectionName, providerKind) {
  const normalizedName = clean(sectionName).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (providerKind === "azure") {
    const keys = ["AZURE_OPENAI_ENDPOINT"];
    if (normalizedName) {
      keys.push(`${normalizedName}_ENDPOINT`);
      keys.push(`${normalizedName}_BASE_URL`);
      if (normalizedName.startsWith("AZURE_")) {
        const suffix = normalizedName.slice("AZURE_".length);
        if (suffix) {
          keys.push(`AZURE_${suffix}_ENDPOINT`);
          keys.push(`AZURE_${suffix}_BASE_URL`);
        }
      }
    }
    return [...new Set(keys)];
  }
  return normalizedName ? [`${normalizedName}_BASE_URL`] : [];
}

function providerRuntimeConfigured(env, section) {
  if (!section) return false;
  if (!section.envKey) return true;
  if (!hasEnvValue(env, section.envKey)) return false;
  const providerKind = inferProviderKindFromSection(section.name, section, "openai");
  const endpointKeys = getProviderEndpointEnvKeys(section.name, providerKind);
  if (!endpointKeys.length) return true;
  return endpointKeys.some((key) => hasEnvValue(env, key));
}
function inferProviderKindFromSection(name, section, fallback = "openai") {
  if (isAzureOpenAIBaseUrl(section?.baseUrl)) return "azure";
  const normalized = normalizeProvider(name, "");
  if (normalized) return normalized;
  return fallback;
}

function readProfileField(env, profileName, field) {
  return clean(env[`${profilePrefix(profileName)}${field}`]);
}

function profileRecord(env, profileName, globalProvider) {
  const provider = normalizeProvider(
    readProfileField(env, profileName, "PROVIDER"),
    globalProvider,
  );
  const explicitModel = readProfileField(env, profileName, "MODEL");
  const model =
    explicitModel ||
    (profileName === "xl" ? "gpt-5.3-codex" : profileName === "m" ? "gpt-5.1-codex-mini" : "");
  const baseUrl = readProfileField(env, profileName, "BASE_URL");
  const apiKey = readProfileField(env, profileName, "API_KEY");
  const apiKeyEnv = readProfileField(env, profileName, "API_KEY_ENV");
  const subagentModel = readProfileField(env, profileName, "SUBAGENT_MODEL");
  return {
    name: profileName,
    provider,
    model,
    modelIsExplicit: Boolean(explicitModel),
    baseUrl,
    apiKey,
    apiKeyEnv,
    subagentModel,
  };
}

function resolveCodexHomeDir(env = process.env) {
  const explicitHome = clean(env?.HOME) || clean(env?.USERPROFILE);
  if (explicitHome) return explicitHome;
  if (env === process.env) return homedir();
  return "";
}

export function readCodexConfigRuntimeDefaults(env = process.env) {
  try {
    const homeDir = resolveCodexHomeDir(env);
    if (!homeDir) {
      return { model: "", modelProvider: "", providers: {} };
    }
    const configPath = resolve(homeDir, ".codex", "config.toml");
    if (!existsSync(configPath)) {
      return { model: "", modelProvider: "", providers: {} };
    }
    const content = readFileSync(configPath, "utf8");
    const head = content.split(/\n\[/)[0] || "";
    const modelMatch = head.match(/^\s*model\s*=\s*"([^"]+)"/m);
    const modelProviderMatch = head.match(/^\s*model_provider\s*=\s*"([^"]+)"/m);
    const providers = {};
    const providerSectionRegex = /^\[model_providers\.([^\]]+)\]\s*([\s\S]*?)(?=^\[[^\]]+\]|$(?![\s\S]))/gm;
    for (const match of content.matchAll(providerSectionRegex)) {
      const [, rawName = "", body = ""] = match;
      const name = clean(rawName);
      if (!name) continue;
      const baseUrlMatch = body.match(/^\s*base_url\s*=\s*"([^"]+)"/m);
      const envKeyMatch = body.match(/^\s*env_key\s*=\s*"([^"]+)"/m);
      providers[name] = {
        name,
        baseUrl: clean(baseUrlMatch?.[1]),
        envKey: clean(envKeyMatch?.[1]),
      };
    }
    return {
      model: clean(modelMatch?.[1]),
      modelProvider: clean(modelProviderMatch?.[1]),
      providers,
    };
  } catch {
    return { model: "", modelProvider: "", providers: {} };
  }
}

function readCodexConfigTopLevelModel(env = process.env) {
  return readCodexConfigRuntimeDefaults(env).model;
}

function selectConfigProviderForRuntime(configDefaults, env, preferredProvider = "") {
  const providers = configDefaults?.providers || {};
  const preferred = clean(preferredProvider).toLowerCase();
  const entries = Object.values(providers).map((section) => ({
    ...section,
    provider: inferProviderKindFromSection(section.name, section, preferred || "openai"),
  }));
  const runtimeBaseUrl = clean(env?.OPENAI_BASE_URL);
  const matchingEntries = preferred
    ? entries.filter((section) => section.provider === preferred)
    : entries;
  const baseUrlMatchedEntries = runtimeBaseUrl
    ? matchingEntries.filter((section) => clean(section.baseUrl) === runtimeBaseUrl)
    : [];
  const envBackedEntries = matchingEntries.filter((section) => providerRuntimeConfigured(env, section));
  const baseUrlMatchedEnvBackedEntries = runtimeBaseUrl
    ? envBackedEntries.filter((section) => clean(section.baseUrl) === runtimeBaseUrl)
    : [];
  const preferredNames = preferred === "azure"
    ? ["azure"]
    : preferred === "openai"
      ? ["openai"]
      : [];
  const findNamed = (sections) => preferredNames
    .map((name) => sections.find((section) => section.name === name))
    .find(Boolean);

  const configuredName = clean(configDefaults?.modelProvider);
  if (configuredName) {
    const configuredSection = providers[configuredName];
    if (configuredSection) {
      const configured = {
        ...configuredSection,
        provider: inferProviderKindFromSection(
          configuredSection.name,
          configuredSection,
          preferred || "openai",
        ),
      };
      const preferredMatches = !preferred || configured.provider === preferred;
      const baseUrlMatches = !runtimeBaseUrl || clean(configured.baseUrl) === runtimeBaseUrl;
      if (preferredMatches && baseUrlMatches && providerRuntimeConfigured(env, configured)) {
        return configured;
      }
    }
  }

  return (
    baseUrlMatchedEnvBackedEntries[0] ||
    baseUrlMatchedEntries[0] ||
    findNamed(envBackedEntries) ||
    envBackedEntries[0] ||
    findNamed(matchingEntries) ||
    matchingEntries[0] ||
    null
  );
}

function inferGlobalProvider(env, configDefaults = null) {
  const baseUrl = clean(env.OPENAI_BASE_URL).toLowerCase();
  if (isAzureOpenAIBaseUrl(baseUrl)) return "azure";
  if (baseUrl) return "openai";
  const configured = selectConfigProviderForRuntime(configDefaults, env);
  return configured?.provider || "openai";
}

/**
 * Resolve codex model/provider profile configuration from env vars.
 * Applies active profile values onto runtime env keys (`CODEX_MODEL`,
 * `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) while keeping
 * sensible fallbacks to global env vars.
 */
export function resolveCodexProfileRuntime(envInput = process.env) {
  const sourceEnv = { ...envInput };
  const configDefaults = readCodexConfigRuntimeDefaults(sourceEnv);
  const activeProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE,
    DEFAULT_ACTIVE_PROFILE,
  );
  const subagentProfile = normalizeProfileName(
    sourceEnv.CODEX_MODEL_PROFILE_SUBAGENT || sourceEnv.CODEX_SUBAGENT_PROFILE,
    DEFAULT_SUBAGENT_PROFILE,
  );

  const globalProvider = inferGlobalProvider(sourceEnv, configDefaults);
  const active = profileRecord(sourceEnv, activeProfile, globalProvider);
  const sub = profileRecord(sourceEnv, subagentProfile, globalProvider);

  const env = { ...sourceEnv };

  const configModel = readCodexConfigTopLevelModel(sourceEnv);

  if (active.model) {
    env.CODEX_MODEL = active.model;
  }

  const profileApiKey = active.apiKey;
  let resolvedProvider = active.provider || globalProvider;
  let configProvider = selectConfigProviderForRuntime(
    configDefaults,
    sourceEnv,
    resolvedProvider,
  );
  const runtimeBaseUrl =
    clean(active.baseUrl) ||
    clean(env.OPENAI_BASE_URL) ||
    clean(configProvider?.baseUrl);

  if (isAzureOpenAIBaseUrl(runtimeBaseUrl) || isAzureOpenAIBaseUrl(configProvider?.baseUrl)) {
    resolvedProvider = "azure";
    configProvider = selectConfigProviderForRuntime(
      configDefaults,
      sourceEnv,
      resolvedProvider,
    ) || configProvider;
  }
  if (runtimeBaseUrl) {
    const normalizedBaseUrl =
      resolvedProvider === "azure"
        ? normalizeAzureOpenAIBaseUrl(runtimeBaseUrl)
        : runtimeBaseUrl;
    env.OPENAI_BASE_URL = normalizedBaseUrl;
    active.baseUrl = normalizedBaseUrl;
  }

  if (!profileApiKey && configProvider?.envKey && hasEnvValue(sourceEnv, configProvider.envKey)) {
    const configuredApiKey = clean(sourceEnv[configProvider.envKey]);
    if (resolvedProvider === "azure") {
      env.AZURE_OPENAI_API_KEY = configuredApiKey;
      if (!env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = configuredApiKey;
      }
    } else {
      env.OPENAI_API_KEY = configuredApiKey;
    }
  }

  // Azure deployments often differ from default model names.
  // If the env is using Azure and the model is still the default,
  // prefer the top-level ~/.codex/config.toml model when present.
  // The hardcoded profile fallback (e.g. "gpt-5.3-codex" for xl) should NOT
  // block the config.toml override — only explicit env or profile fields should.
  const runtimeModelExplicit = Boolean(clean(sourceEnv.CODEX_MODEL));
  const shouldPreferAzureConfigModel =
    resolvedProvider === "azure" &&
    configModel &&
    !active.modelIsExplicit &&
    !runtimeModelExplicit;
  if (shouldPreferAzureConfigModel) {
    env.CODEX_MODEL = configModel;
    active.model = configModel;
  }

  if (profileApiKey) {
    if (resolvedProvider === "azure") {
      env.AZURE_OPENAI_API_KEY = profileApiKey;
      if (!env.OPENAI_API_KEY) {
        env.OPENAI_API_KEY = profileApiKey;
      }
    } else {
      env.OPENAI_API_KEY = profileApiKey;
      if (!env.AZURE_OPENAI_API_KEY && resolvedProvider === "compatible") {
        env.AZURE_OPENAI_API_KEY = "";
      }
    }
  }

  if (resolvedProvider === "azure") {
    if (!clean(env.AZURE_OPENAI_API_KEY) && clean(sourceEnv.AZURE_OPENAI_KEY)) {
      env.AZURE_OPENAI_API_KEY = clean(sourceEnv.AZURE_OPENAI_KEY);
    }
    if (!clean(env.AZURE_OPENAI_API_KEY) && clean(env.OPENAI_API_KEY)) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    if (!clean(env.OPENAI_API_KEY) && clean(env.AZURE_OPENAI_API_KEY)) {
      env.OPENAI_API_KEY = env.AZURE_OPENAI_API_KEY;
    }
  }

  if (!clean(env.CODEX_SUBAGENT_MODEL)) {
    env.CODEX_SUBAGENT_MODEL =
      sub.subagentModel || sub.model || active.subagentModel || "gpt-5.1-codex-mini";
  }

  env.CODEX_MODEL_PROFILE = activeProfile;
  env.CODEX_MODEL_PROFILE_SUBAGENT = subagentProfile;

  return {
    env,
    activeProfile,
    subagentProfile,
    active,
    subagent: sub,
    provider: resolvedProvider,
    /** The config.toml provider section selected for this runtime. */
    configProvider: configProvider
      ? { name: configProvider.name, envKey: configProvider.envKey, baseUrl: configProvider.baseUrl }
      : null,
  };
}
