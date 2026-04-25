function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeToken(value) {
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry))
      .filter(Boolean),
  )];
}

function uniqueTokens(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => normalizeToken(entry))
      .filter(Boolean),
  )];
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeModelFamily(modelId = "") {
  const normalized = normalizeToken(modelId);
  if (!normalized) return "general";
  if (normalized.startsWith("gpt-") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) {
    return "openai";
  }
  if (normalized.includes("claude")) return "anthropic";
  if (normalized.includes("copilot")) return "copilot";
  if (normalized.includes("llama") || normalized.includes("qwen") || normalized.includes("mistral")) return "local";
  return "general";
}

function normalizeModelHint(model, defaults = {}) {
  const value = model && typeof model === "object"
    ? model
    : { id: model };
  const id = toTrimmedString(value.id || value.model || value.name);
  if (!id) return null;
  const aliases = uniqueTokens([id, ...(Array.isArray(value.aliases) ? value.aliases : [])]);
  return {
    id,
    label: toTrimmedString(value.label || value.name || id) || id,
    family: toTrimmedString(value.family || defaults.family) || normalizeModelFamily(id),
    local: value.local === true || defaults.local === true,
    default: value.default === true || id === toTrimmedString(defaults.defaultModel),
    reasoningEffort: toTrimmedString(value.reasoningEffort || value.reasoning || defaults.reasoningEffort) || null,
    contextWindow: Number.isFinite(Number(value.contextWindow)) ? Number(value.contextWindow) : null,
    aliases,
    metadata: value.metadata && typeof value.metadata === "object" ? cloneJson(value.metadata) : {},
  };
}

function normalizeCapabilitySnapshot(input = {}) {
  return {
    streaming: input.streaming !== false,
    tools: input.tools === true,
    reasoning: input.reasoning === true,
    usage: input.usage !== false,
    cost: input.cost !== false,
    auth: input.auth !== false,
    apiKey: input.apiKey === true,
    oauth: input.oauth === true,
    subscription: input.subscription === true,
    local: input.local === true,
    openaiCompatible: input.openaiCompatible === true,
    multimodal: input.multimodal === true,
    vision: input.vision === true,
    sessions: input.sessions === true,
    steering: input.steering === true,
  };
}

function normalizeAuthHints(auth = {}) {
  const env = auth.env && typeof auth.env === "object" ? auth.env : {};
  const supportedModes = uniqueStrings(auth.supportedModes || auth.modes || []);
  return {
    required: auth.required !== false,
    preferredMode: toTrimmedString(auth.preferredMode || supportedModes[0]) || null,
    supportedModes,
    env: {
      apiKey: uniqueStrings(env.apiKey),
      oauth: uniqueStrings(env.oauth),
      subscription: uniqueStrings(env.subscription),
      endpoint: uniqueStrings(env.endpoint),
      baseUrl: uniqueStrings(env.baseUrl),
      deployment: uniqueStrings(env.deployment),
      apiVersion: uniqueStrings(env.apiVersion),
      organization: uniqueStrings(env.organization),
      project: uniqueStrings(env.project),
      workspace: uniqueStrings(env.workspace),
    },
    settings: uniqueStrings(auth.settings),
    metadata: auth.metadata && typeof auth.metadata === "object" ? cloneJson(auth.metadata) : {},
  };
}

function normalizeTransportHints(input = {}) {
  return {
    protocol: toTrimmedString(input.protocol || input.transport || "http") || "http",
    apiStyle: toTrimmedString(input.apiStyle || input.style || "generic") || "generic",
    messageShape: toTrimmedString(input.messageShape || "chat") || "chat",
    toolCallShape: toTrimmedString(input.toolCallShape || "generic") || "generic",
    reasoningParameter: toTrimmedString(input.reasoningParameter || input.reasoningParam) || null,
    streamEventShape: toTrimmedString(input.streamEventShape || "delta") || "delta",
  };
}

function normalizeAdapterHints(input = {}) {
  return {
    adapterId: toTrimmedString(input.adapterId) || null,
    executor: toTrimmedString(input.executor) || null,
    shell: toTrimmedString(input.shell) || null,
    providerFamily: toTrimmedString(input.providerFamily) || null,
  };
}

function normalizeVisibility(input = {}) {
  return {
    advanced: input.advanced === true,
    defaultEnabled: input.defaultEnabled === true,
    explicitEnablementRequired: input.explicitEnablementRequired !== false,
  };
}

function findFirstConfigured(keys = [], sources = []) {
  for (const key of keys) {
    for (const source of sources) {
      const value = toTrimmedString(source?.[key]);
      if (value) {
        return {
          value,
          source: key,
        };
      }
    }
  }
  return {
    value: null,
    source: null,
  };
}

export function resolveEnvConfig(driver, options = {}) {
  const settings = options.settings && typeof options.settings === "object" ? options.settings : {};
  const env = options.env && typeof options.env === "object" ? options.env : {};
  const credentials = options.credentials && typeof options.credentials === "object" ? options.credentials : {};
  const sources = [options, settings, credentials, env];
  const auth = driver.auth || normalizeAuthHints();
  const resolved = {
    apiKey: findFirstConfigured(auth.env.apiKey, sources),
    oauthToken: findFirstConfigured(auth.env.oauth, sources),
    subscriptionToken: findFirstConfigured(auth.env.subscription, sources),
    endpoint: findFirstConfigured(auth.env.endpoint, sources),
    baseUrl: findFirstConfigured(auth.env.baseUrl, sources),
    deployment: findFirstConfigured(auth.env.deployment, sources),
    apiVersion: findFirstConfigured(auth.env.apiVersion, sources),
    organization: findFirstConfigured(auth.env.organization, sources),
    project: findFirstConfigured(auth.env.project, sources),
    workspace: findFirstConfigured(auth.env.workspace, sources),
  };
  return {
    apiKey: resolved.apiKey.value,
    oauthToken: resolved.oauthToken.value,
    subscriptionToken: resolved.subscriptionToken.value,
    endpoint: resolved.endpoint.value,
    baseUrl: resolved.baseUrl.value,
    deployment: resolved.deployment.value,
    apiVersion: resolved.apiVersion.value,
    organization: resolved.organization.value,
    project: resolved.project.value,
    workspace: resolved.workspace.value,
    sources: Object.fromEntries(
      Object.entries(resolved).map(([key, value]) => [key, value.source || null]),
    ),
  };
}

export function normalizeUsageSnapshot(usage = {}) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(
    usage.inputTokens
      ?? usage.promptTokens
      ?? usage.prompt_tokens
      ?? usage.input_tokens
      ?? 0,
  );
  const outputTokens = Number(
    usage.outputTokens
      ?? usage.completionTokens
      ?? usage.completion_tokens
      ?? usage.output_tokens
      ?? 0,
  );
  const totalTokens = Number(
    usage.totalTokens
      ?? usage.total_tokens
      ?? inputTokens + outputTokens,
  );
  const cacheInputTokens = Number(
    usage.cacheInputTokens
      ?? usage.cachedInputTokens
      ?? usage.cache_input_tokens
      ?? usage.cached_input_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? 0,
  );
  const costUsd = Number(
    usage.costUsd
      ?? usage.costUSD
      ?? usage.cost_usd
      ?? usage.cost
      ?? 0,
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    cacheInputTokens: Number.isFinite(cacheInputTokens) ? cacheInputTokens : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    raw: cloneJson(usage),
  };
}

function normalizeModels(models = {}, defaults = {}) {
  const known = (Array.isArray(models.known) ? models.known : [])
    .map((entry) => normalizeModelHint(entry, defaults))
    .filter(Boolean);
  const recommended = (Array.isArray(models.recommended) ? models.recommended : known)
    .map((entry) => normalizeModelHint(entry, defaults))
    .filter(Boolean);
  const defaultModel = toTrimmedString(models.defaultModel || defaults.defaultModel || known.find((entry) => entry.default)?.id || recommended[0]?.id);
  const normalizedKnown = known.map((entry) => ({
    ...entry,
    default: entry.default || entry.id === defaultModel,
  }));
  return {
    defaultModel: defaultModel || null,
    supportsCustomModel: models.supportsCustomModel !== false,
    catalogSource: toTrimmedString(models.catalogSource || "static") || "static",
    known: normalizedKnown,
    recommended,
  };
}

function normalizeMetadata(input = {}) {
  return {
    vendor: toTrimmedString(input.vendor) || null,
    family: toTrimmedString(input.family) || null,
    label: toTrimmedString(input.label || input.name) || null,
    description: toTrimmedString(input.description) || "",
    docsSlug: toTrimmedString(input.docsSlug) || null,
  };
}

function buildModelAliasMap(models = []) {
  const map = new Map();
  for (const entry of models) {
    map.set(normalizeToken(entry.id), entry.id);
    for (const alias of entry.aliases || []) {
      map.set(normalizeToken(alias), entry.id);
    }
  }
  return map;
}

export function createProviderDriver(definition = {}) {
  const id = normalizeToken(definition.id);
  if (!id) {
    throw new Error("Provider driver id is required");
  }
  const aliases = uniqueTokens([id, ...(Array.isArray(definition.aliases) ? definition.aliases : [])]);
  const capabilities = normalizeCapabilitySnapshot(definition.capabilities || {});
  const auth = normalizeAuthHints({
    ...definition.auth,
    required: capabilities.auth,
  });
  const models = normalizeModels(definition.models, {
    defaultModel: definition.models?.defaultModel,
  });
  const modelAliasMap = buildModelAliasMap(models.known);
  const metadata = normalizeMetadata(definition.metadata || definition);
  const transport = normalizeTransportHints(definition.transport || {});
  const adapterHints = normalizeAdapterHints(definition.adapterHints || {});
  const visibility = normalizeVisibility(definition.visibility || {});
  const provider = toTrimmedString(definition.provider || adapterHints.executor || metadata.vendor).toUpperCase() || null;
  const executor = toTrimmedString(definition.executor || adapterHints.executor || provider).toUpperCase() || null;
  const variant = toTrimmedString(definition.variant || "DEFAULT") || "DEFAULT";

  const driver = {
    id,
    aliases,
    name: metadata.label || id,
    description: metadata.description,
    provider,
    executor,
    variant,
    adapterId: adapterHints.adapterId,
    defaultModel: models.defaultModel,
    models: models.known.map((entry) => cloneJson(entry)),
    metadata,
    visibility,
    capabilities,
    auth,
    transport,
    adapterHints,
    models,
    matches(value) {
      return aliases.includes(normalizeToken(value));
    },
    normalizeModel(model) {
      const raw = toTrimmedString(model || models.defaultModel);
      if (!raw) return null;
      return modelAliasMap.get(normalizeToken(raw)) || raw;
    },
    listKnownModels() {
      return models.known.map((entry) => cloneJson(entry));
    },
    createSessionConfig(options = {}) {
      const envConfig = resolveEnvConfig(driver, options);
      const resolvedModel = driver.normalizeModel(
        options.model
        || options.defaultModel
        || options.settings?.defaultModel
        || models.defaultModel,
      );
      const authMode = toTrimmedString(
        options.authMode
        || options.settings?.authMode
        || auth.preferredMode,
      ) || null;
      return {
        providerId: id,
        model: resolvedModel,
        authMode,
        transport: cloneJson(transport),
        capabilities: cloneJson(capabilities),
        apiKey: envConfig.apiKey || null,
        oauthToken: envConfig.oauthToken || null,
        subscriptionToken: envConfig.subscriptionToken || null,
        endpoint: toTrimmedString(options.endpoint) || envConfig.endpoint || envConfig.baseUrl || null,
        baseUrl: toTrimmedString(options.baseUrl) || envConfig.baseUrl || null,
        deployment: toTrimmedString(options.deployment) || envConfig.deployment || null,
        apiVersion: toTrimmedString(options.apiVersion) || envConfig.apiVersion || null,
        organization: toTrimmedString(options.organization) || envConfig.organization || null,
        project: toTrimmedString(options.project) || envConfig.project || null,
        workspace: toTrimmedString(options.workspace) || envConfig.workspace || null,
        credentials: {
          apiKeyConfigured: Boolean(envConfig.apiKey),
          oauthConfigured: Boolean(envConfig.oauthToken),
          subscriptionConfigured: Boolean(envConfig.subscriptionToken),
          sources: cloneJson(envConfig.sources),
        },
        metadata: cloneJson(metadata),
      };
    },
    normalizeUsage(usage) {
      return normalizeUsageSnapshot(usage);
    },
  };

  return Object.freeze(driver);
}

export function normalizeProviderDriverId(value) {
  return normalizeToken(value);
}
