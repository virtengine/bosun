/**
 * Canonical architecture note:
 * Provider resolution, provider runtime normalization, and execution-session
 * creation are owned here. Transitional shells and legacy entrypoints may call
 * into this module, but they must not define parallel provider-selection or
 * provider-lifecycle semantics outside the provider kernel contract.
 */

import { createProviderRegistry } from "./provider-registry.mjs";
import { createProviderSession } from "./provider-session.mjs";
import { createToolOrchestrator } from "./tool-orchestrator.mjs";
import { readHarnessExecutorFabric } from "./harness-executor-config.mjs";
import { getBuiltInProviderDriver, normalizeProviderDefinitionId } from "./providers/index.mjs";
import { ProviderConfigurationError } from "./providers/provider-errors.mjs";
import {
  normalizeProviderSelection,
  normalizeProviderSessionInput,
} from "./providers/provider-contract.mjs";

function setProviderSetting(target, key, value) {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

function resolveProviderConfigAliases(config = {}) {
  const providers = config?.providers && typeof config.providers === "object"
    ? config.providers
    : {};
  return {
    ...providers,
    openai: providers.openai && typeof providers.openai === "object"
      ? providers.openai
      : providers.openaiResponses,
    openaiResponses: providers.openaiResponses && typeof providers.openaiResponses === "object"
      ? providers.openaiResponses
      : providers.openai,
    azureOpenai: providers.azureOpenai && typeof providers.azureOpenai === "object"
      ? providers.azureOpenai
      : providers.azureOpenAi,
    azureOpenAi: providers.azureOpenAi && typeof providers.azureOpenAi === "object"
      ? providers.azureOpenAi
      : providers.azureOpenai,
    copilot: providers.copilot && typeof providers.copilot === "object"
      ? providers.copilot
      : providers.copilotOAuth,
    copilotOAuth: providers.copilotOAuth && typeof providers.copilotOAuth === "object"
      ? providers.copilotOAuth
      : providers.copilot,
    openrouter: providers.openrouter && typeof providers.openrouter === "object"
      ? providers.openrouter
      : {},
    perplexity: providers.perplexity && typeof providers.perplexity === "object"
      ? providers.perplexity
      : {},
    deepinfra: providers.deepinfra && typeof providers.deepinfra === "object"
      ? providers.deepinfra
      : {},
    groq: providers.groq && typeof providers.groq === "object"
      ? providers.groq
      : {},
    together: providers.together && typeof providers.together === "object"
      ? providers.together
      : {},
    xai: providers.xai && typeof providers.xai === "object"
      ? providers.xai
      : {},
    fireworks: providers.fireworks && typeof providers.fireworks === "object"
      ? providers.fireworks
      : {},
    cerebras: providers.cerebras && typeof providers.cerebras === "object"
      ? providers.cerebras
      : {},
    sambanova: providers.sambanova && typeof providers.sambanova === "object"
      ? providers.sambanova
      : {},
    nebius: providers.nebius && typeof providers.nebius === "object"
      ? providers.nebius
      : {},
    gemini: providers.gemini && typeof providers.gemini === "object"
      ? providers.gemini
      : providers.geminiGenerateContent,
    geminiGenerateContent: providers.geminiGenerateContent && typeof providers.geminiGenerateContent === "object"
      ? providers.geminiGenerateContent
      : providers.gemini,
  };
}

export function buildProviderKernelSettings(config = {}) {
  const providers = resolveProviderConfigAliases(config);
  const flattened = {};
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEFAULT", providers.defaultProvider);
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEFAULT_MODEL", providers.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED", providers.openai?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_RESPONSES_MODEL", providers.openai?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED", providers.chatgptCodex?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE", providers.chatgptCodex?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODEL", providers.chatgptCodex?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE", providers.chatgptCodex?.workspace);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED", providers.azureOpenai?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_MODE", providers.azureOpenai?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_MODEL", providers.azureOpenai?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_ENDPOINT", providers.azureOpenai?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT", providers.azureOpenai?.deployment);
  setProviderSetting(flattened, "BOSUN_PROVIDER_AZURE_OPENAI_API_VERSION", providers.azureOpenai?.apiVersion);
  setProviderSetting(flattened, "BOSUN_PROVIDER_ANTHROPIC_ENABLED", providers.anthropic?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_ANTHROPIC_MODEL", providers.anthropic?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED", providers.claudeSubscription?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE", providers.claudeSubscription?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODEL", providers.claudeSubscription?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE", providers.claudeSubscription?.workspace);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED", providers.openaiCompatible?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODE", providers.openaiCompatible?.mode);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL", providers.openaiCompatible?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL", providers.openaiCompatible?.baseUrl);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_ENABLED", providers.ollama?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_MODEL", providers.ollama?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OLLAMA_BASE_URL", providers.ollama?.baseUrl);
  setProviderSetting(flattened, "BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED", providers.copilot?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_COPILOT_OAUTH_MODEL", providers.copilot?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENROUTER_ENABLED", providers.openrouter?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENROUTER_MODEL", providers.openrouter?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_OPENROUTER_BASE_URL", providers.openrouter?.baseUrl || providers.openrouter?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_PERPLEXITY_ENABLED", providers.perplexity?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_PERPLEXITY_MODEL", providers.perplexity?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_PERPLEXITY_BASE_URL", providers.perplexity?.baseUrl || providers.perplexity?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEEPINFRA_ENABLED", providers.deepinfra?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEEPINFRA_MODEL", providers.deepinfra?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_DEEPINFRA_BASE_URL", providers.deepinfra?.baseUrl || providers.deepinfra?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GROQ_ENABLED", providers.groq?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GROQ_MODEL", providers.groq?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GROQ_BASE_URL", providers.groq?.baseUrl || providers.groq?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_TOGETHER_ENABLED", providers.together?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_TOGETHER_MODEL", providers.together?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_TOGETHER_BASE_URL", providers.together?.baseUrl || providers.together?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_XAI_ENABLED", providers.xai?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_XAI_MODEL", providers.xai?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_XAI_BASE_URL", providers.xai?.baseUrl || providers.xai?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_FIREWORKS_ENABLED", providers.fireworks?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_FIREWORKS_MODEL", providers.fireworks?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_FIREWORKS_BASE_URL", providers.fireworks?.baseUrl || providers.fireworks?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CEREBRAS_ENABLED", providers.cerebras?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CEREBRAS_MODEL", providers.cerebras?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_CEREBRAS_BASE_URL", providers.cerebras?.baseUrl || providers.cerebras?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_SAMBANOVA_ENABLED", providers.sambanova?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_SAMBANOVA_MODEL", providers.sambanova?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_SAMBANOVA_BASE_URL", providers.sambanova?.baseUrl || providers.sambanova?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_NEBIUS_ENABLED", providers.nebius?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_NEBIUS_MODEL", providers.nebius?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_NEBIUS_BASE_URL", providers.nebius?.baseUrl || providers.nebius?.endpoint);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GEMINI_ENABLED", providers.gemini?.enabled);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GEMINI_MODEL", providers.gemini?.defaultModel);
  setProviderSetting(flattened, "BOSUN_PROVIDER_GEMINI_BASE_URL", providers.gemini?.baseUrl || providers.gemini?.endpoint);
  return flattened;
}

function resolveKernelProviderSettings(config = {}, providerId = "") {
  const providers = resolveProviderConfigAliases(config);
  const normalizedProviderId = normalizeProviderDefinitionId(providerId, "") || "";
  const providerConfigById = {
    "openai-responses": providers.openai,
    "openai-codex-subscription": providers.chatgptCodex,
    "azure-openai-responses": providers.azureOpenai,
    "anthropic-messages": providers.anthropic,
    "claude-subscription-shim": providers.claudeSubscription,
    "openai-compatible": providers.openaiCompatible,
    ollama: providers.ollama,
    "copilot-oauth": providers.copilot,
    openrouter: providers.openrouter,
    perplexity: providers.perplexity,
    deepinfra: providers.deepinfra,
    groq: providers.groq,
    together: providers.together,
    xai: providers.xai,
    fireworks: providers.fireworks,
    cerebras: providers.cerebras,
    sambanova: providers.sambanova,
    nebius: providers.nebius,
    "gemini-generate-content": providers.gemini,
  };
  const providerConfig = providerConfigById[normalizedProviderId];
  if (!providerConfig || typeof providerConfig !== "object") {
    return {};
  }
  return {
    defaultModel: providerConfig.defaultModel || null,
    authMode: providerConfig.mode || providerConfig.authMode || null,
    endpoint: providerConfig.endpoint || null,
    baseUrl: providerConfig.baseUrl || null,
    deployment: providerConfig.deployment || null,
    apiVersion: providerConfig.apiVersion || null,
    workspace: providerConfig.workspace || null,
    organization: providerConfig.organization || null,
    project: providerConfig.project || null,
  };
}

function isExplicitProviderSelection(providerEntry = null, normalizedSelectionId = "") {
  const entryId = String(providerEntry?.id || "").trim();
  const source = String(providerEntry?.source || "").trim().toLowerCase();
  return Boolean(
    source === "configured"
    && entryId
    && normalizedSelectionId
    && entryId === normalizedSelectionId,
  );
}

function renderProviderMessage(message = {}) {
  const role = String(message?.role || "user").trim().toUpperCase() || "USER";
  const lines = [];
  const text = String(
    message?.text
    || message?.content?.find?.((entry) => entry?.type === "text")?.text
    || "",
  ).trim();
  if (text) {
    lines.push(`${role}: ${text}`);
  }
  for (const entry of Array.isArray(message?.toolCalls) ? message.toolCalls : []) {
    lines.push(`${role} TOOL_CALL ${String(entry?.name || entry?.id || "tool").trim()}: ${JSON.stringify(entry?.input ?? {})}`);
  }
  for (const entry of Array.isArray(message?.toolResults) ? message.toolResults : []) {
    lines.push(`TOOL_RESULT ${String(entry?.name || entry?.toolCallId || "tool").trim()}: ${JSON.stringify(entry?.output ?? {})}`);
  }
  return lines.join("\n");
}

function extractMessageFromPayload(payload = {}) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    const transcript = payload.messages
      .map((message) => renderProviderMessage(message))
      .filter(Boolean)
      .join("\n\n");
    if (transcript) return transcript;
  }
  return payload.prompt
    || payload.messages?.at(-1)?.text
    || payload.messages?.at(-1)?.content?.find?.((entry) => entry?.type === "text")?.text
    || "";
}

function resolveKernelConfig(options = {}) {
  if (typeof options.getConfig === "function") {
    try {
      return options.getConfig() || {};
    } catch {
      return {};
    }
  }
  return options.config && typeof options.config === "object" ? options.config : {};
}

function findProviderModelEntry(providerEntry = null, modelId = "") {
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedModelId) return null;
  const models = Array.isArray(providerEntry?.modelCatalog?.models)
    ? providerEntry.modelCatalog.models
    : [];
  return models.find((entry) => String(entry?.id || "").trim() === normalizedModelId) || null;
}

function applyModelTransportOverrides(providerConfig = null, providerEntry = null, modelId = "") {
  if (!providerConfig || typeof providerConfig !== "object") return providerConfig;
  const modelEntry = findProviderModelEntry(providerEntry, modelId || providerConfig.model);
  if (!modelEntry) return providerConfig;
  const apiStyle = String(modelEntry?.apiStyle || "").trim();
  const transport = apiStyle
    ? {
        ...(providerConfig.transport && typeof providerConfig.transport === "object"
          ? providerConfig.transport
          : {}),
        apiStyle,
      }
    : providerConfig.transport;
  const capabilities = {
    ...(providerConfig.capabilities && typeof providerConfig.capabilities === "object"
      ? providerConfig.capabilities
      : {}),
  };
  for (const [key, value] of Object.entries({
    toolCalling: modelEntry.toolCalling,
    vision: modelEntry.vision,
    supportsAttachments: modelEntry.supportsAttachments,
    reasoning: modelEntry.reasoning,
    streaming: modelEntry.streaming,
  })) {
    if (typeof value === "boolean") capabilities[key] = value;
  }
  return {
    ...providerConfig,
    model: String(modelEntry.apiModel || modelEntry.id || providerConfig.model || "").trim() || providerConfig.model,
    displayModel: String(modelEntry.id || modelId || providerConfig.model || "").trim() || null,
    ...(transport ? { transport } : {}),
    capabilities,
    ...(Number.isFinite(Number(modelEntry.maxInputTokens)) ? { maxInputTokens: Number(modelEntry.maxInputTokens) } : {}),
    ...(Number.isFinite(Number(modelEntry.maxOutputTokens)) ? { maxOutputTokens: Number(modelEntry.maxOutputTokens) } : {}),
    ...(Number.isFinite(Number(modelEntry.contextWindow || modelEntry.contextLength)) ? { contextWindow: Number(modelEntry.contextWindow || modelEntry.contextLength) } : {}),
  };
}

function createRegistryFactory(options = {}) {
  return () => {
    if (options.providerRegistry && typeof options.providerRegistry.listProviders === "function") {
      return options.providerRegistry;
    }
    const config = resolveKernelConfig(options);
    const harnessFabric = readHarnessExecutorFabric(config);
    const agentRuntime = String(config?.agentRuntime || "").trim().toLowerCase();
    const allowLegacyExecutorProfiles = agentRuntime === "sdk-cli";
    const configExecutors = harnessFabric.hasExplicitExecutors
      ? harnessFabric.explicitExecutors
      : allowLegacyExecutorProfiles && Array.isArray(config?.executorConfig?.executors)
        ? config.executorConfig.executors
        : [];
    const settings = buildProviderKernelSettings(config);
    return createProviderRegistry({
      adapters: options.adapters || {},
      configExecutors,
      defaultProviderId:
        normalizeProviderDefinitionId(
          settings.BOSUN_PROVIDER_DEFAULT || options.env?.BOSUN_PROVIDER_DEFAULT || process.env.BOSUN_PROVIDER_DEFAULT || "",
          "",
      ) || undefined,
      env: options.env || process.env,
      includeBuiltins: harnessFabric.hasExplicitExecutors ? false : options.includeBuiltins !== false,
      preferNativeAdapters: agentRuntime === "harness",
      settings,
      readBusy: options.readBusy,
      getAdapterCapabilities: options.getAdapterCapabilities,
    });
  };
}

function createSessionToolOrchestrator(input = {}, options = {}) {
  if (input.toolOrchestrator && typeof input.toolOrchestrator === "object") {
    return input.toolOrchestrator;
  }
  if (options.toolOrchestrator && typeof options.toolOrchestrator === "object") {
    return options.toolOrchestrator;
  }
  return createToolOrchestrator({
    cwd: input.cwd || options.cwd || process.cwd(),
    repoRoot: input.repoRoot || options.repoRoot || input.cwd || options.cwd || process.cwd(),
    agentProfileId: input.agentProfileId || options.agentProfileId || null,
    sessionManager: input.sessionManager || options.sessionManager || null,
    onEvent: input.onEvent || options.onEvent,
    includeBuiltinBosunTools: input.includeBuiltinBosunTools ?? options.includeBuiltinBosunTools,
    toolSources: input.toolSources || options.toolSources,
    registry: input.toolRegistry || options.toolRegistry,
  });
}

export function createProviderKernel(options = {}) {
  const createRegistryInstance = createRegistryFactory(options);

  function resolveRuntime(selectionId = "", adapterName = "") {
    const registry = createRegistryInstance();
    const kernelConfig = resolveKernelConfig(options);
    const normalizedSelectionId = String(selectionId || "").trim();
    const resolvedRuntime = normalizedSelectionId
      ? (
        typeof registry.resolveProviderRuntime === "function"
          ? registry.resolveProviderRuntime(normalizedSelectionId)
          : {
              selection: registry.resolveSelection?.(normalizedSelectionId) || null,
              provider:
                registry.getProvider?.(normalizedSelectionId)
                || registry.getProvider?.(registry.resolveSelection?.(normalizedSelectionId)?.providerId)
                || registry.getDefaultProvider?.()
                || null,
            }
      )
      : { selection: null, provider: registry.getDefaultProvider() };
    const resolvedSelection = normalizeProviderSelection(resolvedRuntime.selection || {});
    const providerEntry = resolvedRuntime.provider || registry.getDefaultProvider();
    const providerId =
      providerEntry?.providerId
      || normalizeProviderDefinitionId(normalizedSelectionId || adapterName, "")
      || null;
    const driver = providerId ? getBuiltInProviderDriver(providerId) : null;
    const providerSettings = providerEntry?.auth?.settings && typeof providerEntry.auth.settings === "object"
      ? providerEntry.auth.settings
      : {};
    const kernelProviderSettings = resolveKernelProviderSettings(kernelConfig, providerId);
    const explicitSelection = isExplicitProviderSelection(providerEntry, normalizedSelectionId);
    const preferredSettings = explicitSelection ? providerSettings : kernelProviderSettings;
    const fallbackSettings = explicitSelection ? kernelProviderSettings : providerSettings;
    const providerOverrides = {
      model:
        preferredSettings.defaultModel
        || fallbackSettings.defaultModel
        || providerEntry?.defaultModel
        || resolvedSelection.model
        || null,
      authMode:
        preferredSettings.authMode
        || preferredSettings.mode
        || fallbackSettings.authMode
        || fallbackSettings.mode
        || providerEntry?.auth?.preferredMode
        || null,
      endpoint: preferredSettings.endpoint || fallbackSettings.endpoint || null,
      baseUrl: preferredSettings.baseUrl || fallbackSettings.baseUrl || null,
      deployment: preferredSettings.deployment || fallbackSettings.deployment || null,
      apiVersion: preferredSettings.apiVersion || fallbackSettings.apiVersion || null,
      workspace: preferredSettings.workspace || fallbackSettings.workspace || null,
    };
    const providerConfig = providerEntry?.providerId
      ? (
        typeof registry.buildSessionConfig === "function"
          ? registry.buildSessionConfig(
              explicitSelection ? normalizedSelectionId : providerEntry.providerId,
              providerOverrides,
            )
          : driver?.createSessionConfig({
              env: options.env || process.env,
              ...providerOverrides,
              settings: {
                defaultModel: preferredSettings.defaultModel || fallbackSettings.defaultModel || providerEntry?.defaultModel || null,
                authMode: preferredSettings.authMode || preferredSettings.mode || fallbackSettings.authMode || fallbackSettings.mode || null,
                endpoint: preferredSettings.endpoint || fallbackSettings.endpoint || null,
                baseUrl: preferredSettings.baseUrl || fallbackSettings.baseUrl || null,
                deployment: preferredSettings.deployment || fallbackSettings.deployment || null,
                apiVersion: preferredSettings.apiVersion || fallbackSettings.apiVersion || null,
                workspace: preferredSettings.workspace || fallbackSettings.workspace || null,
                organization: preferredSettings.organization || fallbackSettings.organization || null,
                project: preferredSettings.project || fallbackSettings.project || null,
              },
            })
      )
      : null;
    const effectiveProviderConfig = applyModelTransportOverrides(
      providerConfig,
      providerEntry,
      resolvedSelection.model,
    );

    return {
      registry,
      selection: resolvedSelection,
      providerEntry: providerEntry || null,
      providerId,
      providerConfig: effectiveProviderConfig
        ? {
            ...effectiveProviderConfig,
            provider: providerId,
          }
        : null,
    };
  }

  function withRuntimeOptions(adapterName, selectionId, runtimeOptions = {}) {
    const runtime = resolveRuntime(selectionId, adapterName);
    if (!runtime.providerId || !runtime.providerConfig) {
      return runtimeOptions;
    }
    return {
      ...runtimeOptions,
      provider: runtime.providerId,
      providerConfig: runtime.providerConfig,
    };
  }

  function createExecutionSession(input = {}) {
    const normalizedInput = normalizeProviderSessionInput({
      providerId: input.provider || input.selectionId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      model: input.model,
      metadata: input.metadata || {},
    });
    const requestedAdapterName = String(input.adapterName || "").trim();
    const selectionId = String(input.selectionId || input.provider || "").trim();
    const runtime = resolveRuntime(selectionId, requestedAdapterName);
    // Only use requestedAdapterName if it directly maps to a registered adapter;
    // otherwise fall back to the provider entry's adapterId so named harness
    // executors (whose selectionId is not an adapter key) still resolve correctly.
    const adapterName =
      (requestedAdapterName && options.adapters?.[requestedAdapterName] != null)
        ? requestedAdapterName
        : runtime.providerEntry?.adapterId || requestedAdapterName || "";
    const targetAdapter = options.adapters?.[adapterName] || null;
    if (!runtime.providerEntry && !targetAdapter) {
      throw new ProviderConfigurationError(`Unknown provider selection "${selectionId || adapterName || "default"}"`, {
        providerId: selectionId || null,
      });
    }
    const explicitProviderId =
      String(input.provider || runtime.providerId || "").trim() || runtime.providerId || null;
    const explicitProviderConfig =
      input.providerConfig && typeof input.providerConfig === "object" && !Array.isArray(input.providerConfig)
        ? { ...input.providerConfig }
        : null;
    const toolOrchestrator = createSessionToolOrchestrator(input, options);
    return createProviderSession(runtime.providerId, {
      providerRegistry: runtime.registry,
      adapter: targetAdapter,
      providerSelection: selectionId || runtime.selection?.selectionId || runtime.providerId || null,
      providerConfig: explicitProviderConfig || runtime.providerConfig || null,
      sessionId: normalizedInput.sessionId,
      threadId: normalizedInput.threadId,
      model: normalizedInput.model,
      metadata: normalizedInput.metadata,
      cwd: input.cwd || options.cwd || null,
      repoRoot: input.repoRoot || options.repoRoot || input.cwd || options.cwd || null,
      agentProfileId: input.agentProfileId || options.agentProfileId || null,
      sessionManager: input.sessionManager || options.sessionManager || null,
      onEvent: input.onEvent || options.onEvent,
      toolOrchestrator,
      executeTool: input.executeTool || options.executeTool || null,
      toolRunner: input.toolRunner || options.toolRunner || null,
      maxToolRounds: input.maxToolRounds ?? options.maxToolRounds,
      subagentMaxParallel: input.subagentMaxParallel ?? options.subagentMaxParallel,
      getProviderRunner:
        typeof options.getProviderRunner === "function"
          ? options.getProviderRunner
          : (
            targetAdapter && typeof targetAdapter.exec === "function"
              ? () => async (payload, runnerOptions = {}) => {
                  const execOptions = withRuntimeOptions(adapterName, selectionId, {
                    ...runnerOptions,
                    sessionId: payload.sessionId || runnerOptions.sessionId || null,
                    threadId: payload.threadId || runnerOptions.threadId || payload.sessionId || runnerOptions.sessionId || null,
                    model: payload.model || runnerOptions.model || null,
                    metadata: payload.metadata || runnerOptions.metadata || {},
                  });
                  const selectedModel = payload.model || runnerOptions.model || normalizedInput.model || null;
                  // Look up per-model apiVersion override from the registry catalog (Azure primarily)
                  const modelEntry = selectedModel
                    ? (runtime.registry.getModelCatalog?.(runtime.providerId)?.models || [])
                        .find((m) => m.id === selectedModel) || null
                    : null;
                  const modelApiVersion = modelEntry?.apiVersion || null;
                  const mergedProviderConfig =
                    explicitProviderConfig || execOptions.providerConfig || modelApiVersion
                      ? {
                           ...(execOptions.providerConfig || {}),
                           ...(explicitProviderConfig || {}),
                           model:
                             explicitProviderConfig?.model
                             || payload.model
                             || runnerOptions.model
                             || normalizedInput.model
                             || execOptions.providerConfig?.model
                             || null,
                           ...(modelApiVersion ? { apiVersion: modelApiVersion } : {}),
                         }
                       : undefined;
                  const adapterInput = targetAdapter.acceptsTurnPayload === true
                    ? payload
                    : extractMessageFromPayload(payload);
                  // When the adapter consumes a plain string (acceptsTurnPayload !== true)
                  // the rich payload — including the resolved tool definitions — is
                  // discarded by extractMessageFromPayload. Forward payload.tools through
                  // execOptions so string-mode adapters (e.g. openai-native) still receive
                  // tools and don't degrade into a one-turn text-only reply.
                  const payloadTools = Array.isArray(payload?.tools) ? payload.tools : null;
                  return targetAdapter.exec(adapterInput, {
                    ...execOptions,
                    ...(payloadTools && !Array.isArray(execOptions.tools) ? { tools: payloadTools } : {}),
                    ...(explicitProviderId ? { provider: explicitProviderId } : {}),
                    ...(mergedProviderConfig ? { providerConfig: mergedProviderConfig } : {}),
                  });
                }
              : null
          ),
    });
  }

  return {
    createRegistry: createRegistryInstance,
    getInventory() {
      return createRegistryInstance().getInventory();
    },
    listProviders() {
      return createRegistryInstance().listProviders();
    },
    listEnabledProviders() {
      return createRegistryInstance().listEnabledProviders();
    },
    getRegistrySnapshot() {
      return createRegistryInstance().getRegistrySnapshot();
    },
    resolveSelection(name) {
      return createRegistryInstance().resolveSelection(name);
    },
    resolveRuntime,
    withRuntimeOptions,
    createSession(input = {}) {
      return createExecutionSession(input);
    },
    createExecutionSession,
  };
}

export default createProviderKernel;
