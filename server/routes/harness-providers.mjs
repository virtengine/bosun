function toTrimmedString(value) {
  return String(value ?? "").trim();
}

const HARNESS_PROVIDER_CONFIG_KEYS = Object.freeze({
  "openai-responses": "openai",
  "openai-codex-subscription": "chatgptCodex",
  "azure-openai-responses": "azureOpenai",
  "anthropic-messages": "anthropic",
  "claude-subscription-shim": "claudeSubscription",
  "openai-compatible": "openaiCompatible",
  "ollama": "ollama",
  "copilot-oauth": "copilot",
  openrouter: "openrouter",
  perplexity: "perplexity",
  deepinfra: "deepinfra",
  groq: "groq",
  together: "together",
  xai: "xai",
  fireworks: "fireworks",
  cerebras: "cerebras",
  sambanova: "sambanova",
  nebius: "nebius",
});

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeDiscoveredModelEntry(entry, providerId = "", source = "runtime") {
  const value = entry && typeof entry === "object" ? entry : { id: entry };
  const id = toTrimmedString(value.id || value.model || value.name);
  if (!id) return null;
  const contextWindow = Number(value.contextWindow ?? value.contextLength ?? value.context_window ?? value.maxContextTokens);
  const maxOutputTokens = Number(value.maxOutputTokens ?? value.outputTokens ?? value.defaultMaxTokens ?? value.default_max_tokens);
  return Object.fromEntries(Object.entries({
    id,
    label: toTrimmedString(value.label || value.name || id) || id,
    providerId: toTrimmedString(value.providerId || providerId) || providerId,
    apiModel: toTrimmedString(value.apiModel || value.api_model || value.model || id) || id,
    apiStyle: toTrimmedString(value.apiStyle || value.transport?.apiStyle || "") || null,
    apiVersion: toTrimmedString(value.apiVersion || "") || null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    contextLength: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : null,
    toolCalling: typeof value.toolCalling === "boolean" ? value.toolCalling : null,
    vision: typeof value.vision === "boolean" ? value.vision : null,
    supportsAttachments: typeof value.supportsAttachments === "boolean" ? value.supportsAttachments : null,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : null,
    streaming: typeof value.streaming === "boolean" ? value.streaming : null,
    catalogSource: source,
    custom: value.custom === true,
  }).filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined));
}

async function discoverOpenAiCompatibleModels(endpoint = "", apiKeyEnv = "") {
  const baseUrl = toTrimmedString(endpoint).replace(/\/+$/, "");
  if (!baseUrl) return [];
  const apiKey = apiKeyEnv ? toTrimmedString(process.env[apiKeyEnv]) : "";
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  for (const suffix of ["/v1/models", "/models"]) {
    try {
      const response = await fetch(`${baseUrl}${suffix}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const data = await response.json().catch(() => null);
      const rawModels = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      const models = rawModels
        .map((entry) => normalizeDiscoveredModelEntry(entry, "openai-compatible", "openai-compatible-models-api"))
        .filter(Boolean);
      if (models.length > 0) return models;
    } catch {
      // Try the next common endpoint shape before falling back to static catalog.
    }
  }
  return [];
}

function collectEnabledHarnessProviderIds(executors = []) {
  const enabled = new Set();
  for (const entry of Array.isArray(executors) ? executors : []) {
    if (entry?.enabled === false) continue;
    const providerId = toTrimmedString(entry?.providerId || entry?.provider || entry?.type || "");
    if (providerId) enabled.add(providerId);
  }
  return enabled;
}

function alignProviderConfigWithHarnessExecutors(configData = {}, executors = [], primaryExecutorId = "", routingMode = "") {
  const harnessExecutors = Array.isArray(executors) ? executors : [];
  const enabledProviderIds = collectEnabledHarnessProviderIds(harnessExecutors);
  const primaryExecutor = harnessExecutors.find((entry) => toTrimmedString(entry?.id || "") === primaryExecutorId) || null;
  const primaryProviderId = toTrimmedString(primaryExecutor?.providerId || "");
  const providers = ensureObject(configData.providers);
  configData.providers = providers;

  for (const providerId of enabledProviderIds) {
    const providerConfigKey = HARNESS_PROVIDER_CONFIG_KEYS[providerId];
    if (!providerConfigKey) continue;
    providers[providerConfigKey] = ensureObject(providers[providerConfigKey]);
    providers[providerConfigKey].enabled = true;
  }

  if (primaryProviderId) {
    providers.defaultProvider = primaryProviderId;
  }
  if (["default-only", "fallback", "spread"].includes(routingMode)) {
    providers.routingMode = routingMode;
  }
}

function buildProviderSelectionPayload(deps = {}) {
  return {
    poolSdk: toTrimmedString(deps.getPoolSdkName?.() || "") || null,
    primaryAgent:
      toTrimmedString(deps.getPrimaryAgentSelection?.() || deps.getPrimaryAgentName?.() || "")
      || null,
    availableSdks: Array.isArray(deps.getAvailableSdks?.())
      ? deps.getAvailableSdks()
      : [],
  };
}

export function getHarnessProviderSelection(deps = {}) {
  return buildProviderSelectionPayload(deps);
}

export async function tryHandleHarnessProviderRoutes(context = {}) {
  const { req, res, path, deps = {} } = context;
  const {
    jsonResponse,
    buildResolvedSettingsState,
    buildProviderInventory,
    buildHarnessExecutorInventory,
    getProviderModelCatalog,
    readJsonBody,
    readConfigDocument,
    writeJsonFileAtomic,
    emitConfigReload,
    invalidateApiCache,
    broadcastUiEvent,
  } = deps;

  if (path === "/api/providers" && req.method === "GET") {
    try {
      const { rawValues } = buildResolvedSettingsState();
      jsonResponse(res, 200, {
        ok: true,
        ...buildProviderInventory(rawValues),
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/executors" && req.method === "GET") {
    try {
      const { configData } = readConfigDocument();
      const { rawValues } = buildResolvedSettingsState();
      const providerInventory = buildProviderInventory(rawValues);
      jsonResponse(res, 200, {
        ok: true,
        ...buildHarnessExecutorInventory(configData, rawValues, providerInventory),
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/harness/executors" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const executors = Array.isArray(body?.executors) ? body.executors : null;
      const primaryExecutor = toTrimmedString(body?.primaryExecutor || "");
      const routingMode = toTrimmedString(body?.routingMode || "").toLowerCase();
      if (!executors) {
        jsonResponse(res, 400, { ok: false, error: "executors array required" });
        return true;
      }
      const { configPath, configData } = readConfigDocument();
      if (!configData.harness || typeof configData.harness !== "object") {
        configData.harness = {};
      }
      configData.harness.executors = executors;
      if (primaryExecutor) {
        configData.harness.primaryExecutor = primaryExecutor;
      } else {
        delete configData.harness.primaryExecutor;
      }
      if (["default-only", "fallback", "spread"].includes(routingMode)) {
        configData.harness.routingMode = routingMode;
      } else if (routingMode === "") {
        delete configData.harness.routingMode;
      }
      alignProviderConfigWithHarnessExecutors(configData, executors, primaryExecutor, routingMode);
      writeJsonFileAtomic(configPath, configData);
      emitConfigReload?.({
        reason: "harness-executors-updated",
        source: "harness-providers-route",
      });
      invalidateApiCache?.("status");
      invalidateApiCache?.("server-state");
      invalidateApiCache?.("infra");
      broadcastUiEvent?.(["settings", "overview", "sessions"], "invalidate", {
        reason: "harness-executors-updated",
      });
      const { rawValues } = buildResolvedSettingsState();
      const providerInventory = buildProviderInventory(rawValues);
      jsonResponse(res, 200, {
        ok: true,
        configPath,
        ...buildHarnessExecutorInventory(configData, rawValues, providerInventory),
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  // POST /api/harness/discover-models — discover available models for an executor instance.
  // For Azure: calls the deployment list API at the configured endpoint.
  // For all providers: falls back to the static known-models catalog.
  if (path === "/api/harness/discover-models" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const providerId = toTrimmedString(body?.providerId || "");
      const endpoint = toTrimmedString(body?.endpoint || body?.baseUrl || "");
      const apiKeyEnv = toTrimmedString(body?.apiKeyEnv || "");

      // For Azure, try a live deployment listing.
      if (providerId === "azure-openai-responses" && endpoint) {
        const apiKey = (apiKeyEnv ? String(process.env[apiKeyEnv] || "") : "")
          || String(process.env.AZURE_OPENAI_API_KEY || "");
        if (apiKey) {
          try {
            const base = endpoint.replace(/\/$/, "");
            const deploymentsUrl = `${base}/openai/deployments?api-version=2024-10-01-preview`;
            const azRes = await fetch(deploymentsUrl, {
              headers: { "api-key": apiKey, "Content-Type": "application/json" },
              signal: AbortSignal.timeout(10_000),
            });
            if (azRes.ok) {
              const azData = await azRes.json().catch(() => null);
              const deployments = Array.isArray(azData?.value) ? azData.value : [];
              const modelIds = [
                ...new Set(
                  deployments
                    .map((d) => toTrimmedString(d?.model || d?.id || d?.name || ""))
                    .filter(Boolean),
                ),
              ];
              const modelEntries = modelIds
                .map((id) => normalizeDiscoveredModelEntry({ id, apiVersion: body?.apiVersion }, providerId, "azure-deployment-api"))
                .filter(Boolean);
              if (modelEntries.length > 0) {
                jsonResponse(res, 200, {
                  ok: true,
                  models: modelEntries.map((entry) => entry.id),
                  modelEntries,
                  catalog: { providerId, models: modelEntries, defaultModel: modelEntries[0]?.id || null },
                  source: "azure-deployment-api",
                });
                return true;
              }
            }
          } catch {
            // fall through to static catalog
          }
        }
      }

      if (["openai-compatible", "ollama"].includes(providerId) && endpoint) {
        const discovered = await discoverOpenAiCompatibleModels(endpoint, apiKeyEnv);
        if (discovered.length > 0) {
          jsonResponse(res, 200, {
            ok: true,
            models: discovered.map((entry) => entry.id),
            modelEntries: discovered,
            catalog: { providerId, models: discovered, defaultModel: discovered[0]?.id || null },
            source: "openai-compatible-models-api",
          });
          return true;
        }
      }

      // Fall back to static provider catalog.
      const { rawValues } = buildResolvedSettingsState();
      const catalog = getProviderModelCatalog(providerId, { env: process.env, settings: rawValues });
      const modelEntries = (Array.isArray(catalog?.models) ? catalog.models : [])
        .map((entry) => normalizeDiscoveredModelEntry(entry, providerId, catalog?.catalogSource || "static-catalog"))
        .filter(Boolean);
      const models = modelEntries
        .map((m) => toTrimmedString(m?.id || ""))
        .filter(Boolean);
      jsonResponse(res, 200, {
        ok: true,
        models,
        modelEntries,
        catalog: {
          providerId,
          defaultModel: catalog?.defaultModel || modelEntries[0]?.id || null,
          models: modelEntries,
        },
        source: "static-catalog",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/providers/sdk" && req.method === "GET") {
    try {
      jsonResponse(res, 200, {
        ok: true,
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/providers/sdk" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const target = toTrimmedString(body?.sdk || body?.provider || "").toLowerCase();
      if (!target) {
        jsonResponse(res, 400, { ok: false, error: "sdk is required" });
        return true;
      }
      if (target === "auto" || target === "reset") {
        deps.resetPoolSdkCache?.();
        jsonResponse(res, 200, {
          ok: true,
          reset: true,
          selection: buildProviderSelectionPayload(deps),
        });
        return true;
      }

      const available = new Set(
        (Array.isArray(deps.getAvailableSdks?.()) ? deps.getAvailableSdks() : [])
          .map((entry) => toTrimmedString(entry).toLowerCase())
          .filter(Boolean),
      );
      if (available.size > 0 && !available.has(target)) {
        jsonResponse(res, 400, {
          ok: false,
          error: `Unknown sdk: ${target}`,
          availableSdks: [...available],
        });
        return true;
      }

      deps.setPoolSdk?.(target);
      const switchResult = await deps.switchPrimaryAgent?.(`${target}-sdk`);
      jsonResponse(res, switchResult?.ok === false ? 409 : 200, {
        ok: switchResult?.ok !== false,
        target,
        switchResult: switchResult || null,
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}
