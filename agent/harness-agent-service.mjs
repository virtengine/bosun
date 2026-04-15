import * as defaultAgentPool from "./agent-pool.mjs";
import {
  getAgentMode as defaultGetAgentMode,
  getPrimaryAgentName as defaultGetPrimaryAgentName,
  switchPrimaryAgent as defaultSwitchPrimaryAgent,
} from "./primary-agent.mjs";
import { loadConfig } from "../config/config.mjs";
import { createProviderKernel } from "./provider-kernel.mjs";
import { getBosunSessionManager } from "./session-manager.mjs";
import { buildToolCapabilityContract } from "./tool-orchestrator.mjs";
import { createShellAdapterRegistry } from "../shell/shell-adapter-registry.mjs";
import { buildContextEnvelope, maybeCompressSessionItems } from "../workspace/context-cache.mjs";

const INTERACTIVE_MODE_PREFIXES = Object.freeze({
  ask: "[MODE: ask] Respond briefly and directly. Avoid using tools unless absolutely necessary. Do not make code changes.\n\n",
  agent: "",
  plan: "[MODE: plan] Create a detailed plan for the following request but do NOT execute it. Outline the steps, files involved, and approach without making any changes.\n\n",
  web: "[MODE: web] Respond in a concise, web-assistant style. Prioritize immediate answers and lightweight checks. Avoid code edits and long-running operations unless explicitly requested.\n\n",
  instant: "[MODE: instant] Respond immediately with the fastest useful answer. Keep it short, avoid deep tool use, and do not make code changes unless explicitly requested.\n\n",
});

function normalizeTurnResult(result, fallback = {}) {
  if (typeof result === "string") {
    return {
      ok: true,
      success: true,
      finalResponse: result,
      text: result,
      message: result,
      output: result,
      ...fallback,
    };
  }
  const record = result && typeof result === "object" ? { ...result } : {};
  const text = String(
    record.finalResponse
    || record.output
    || record.text
    || record.message
    || fallback.finalResponse
    || "",
  );
  return {
    ...fallback,
    ...record,
    ok: record.ok !== false && record.success !== false,
    success: record.success !== false,
    finalResponse: record.finalResponse || text,
    text: record.text || text,
    message: record.message || text,
    output: record.output || text,
  };
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return "";
  const value = Number(bytes);
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const size = value / Math.pow(1024, idx);
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[idx]}`;
}

function formatAttachmentLine(attachment = {}) {
  const name = attachment.name || attachment.filename || attachment.title || "attachment";
  const kind = attachment.kind ? ` (${attachment.kind})` : "";
  const sizeText = attachment.size ? `, ${formatBytes(attachment.size)}` : "";
  const location =
    attachment.filePath
    || attachment.path
    || attachment.url
    || attachment.uri
    || "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${sizeText}${suffix}`;
}

function appendAttachmentsToPrompt(message, attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!list.length) return message;
  const lines = ["", "Attachments:", ...list.map((entry) => formatAttachmentLine(entry))];
  return `${message}${lines.join("\n")}`;
}

function normalizeInteractiveMode(mode, fallback = "agent") {
  const normalized = toTrimmedString(mode).toLowerCase();
  return INTERACTIVE_MODE_PREFIXES[normalized] !== undefined ? normalized : fallback;
}

function frameInteractivePrompt(prompt, options = {}) {
  const normalizedMode = normalizeInteractiveMode(options.mode, "agent");
  const modePrefix = INTERACTIVE_MODE_PREFIXES[normalizedMode] || "";
  const messageWithAttachments = options.attachmentsAppended === true
    ? String(prompt || "")
    : appendAttachmentsToPrompt(String(prompt || ""), options.attachments);
  const toolContract = buildToolCapabilityContract(options);
  const framed = [toolContract, messageWithAttachments].filter(Boolean).join("\n\n");
  return modePrefix ? `${modePrefix}${framed}` : framed;
}

function normalizeEphemeralLaunchOptions(input = {}) {
  const normalized = { ...input };
  delete normalized.sessionId;
  delete normalized.threadId;
  delete normalized.resumeThreadId;
  delete normalized.workflowSessionId;
  delete normalized.taskKey;
  return normalized;
}

function normalizePoolLaunchOptions(input = {}) {
  const normalized = { ...input };
  if (
    normalized.env
    && typeof normalized.env === "object"
    && !Array.isArray(normalized.env)
    && (!normalized.envOverrides || typeof normalized.envOverrides !== "object")
  ) {
    normalized.envOverrides = { ...normalized.env };
  }
  return normalized;
}

function normalizeAgentPool(pool = {}) {
  const hasInjectedPool = pool && typeof pool === "object" && Object.keys(pool).length > 0;
  return {
    addActiveSessionListener:
      typeof pool.addActiveSessionListener === "function"
        ? pool.addActiveSessionListener.bind(pool)
        : defaultAgentPool.addActiveSessionListener,
    clearThreadRegistry:
      typeof pool.clearThreadRegistry === "function"
        ? pool.clearThreadRegistry.bind(pool)
        : defaultAgentPool.clearThreadRegistry,
    continueSession:
      typeof pool.continueSession === "function"
        ? pool.continueSession.bind(pool)
        : (hasInjectedPool ? undefined : defaultAgentPool.continueSession),
    createCompiledInternalHarnessSession:
      typeof pool.createCompiledInternalHarnessSession === "function"
        ? pool.createCompiledInternalHarnessSession.bind(pool)
        : defaultAgentPool.createCompiledInternalHarnessSession,
    execWithRetry:
      typeof pool.execWithRetry === "function"
        ? pool.execWithRetry.bind(pool)
        : (hasInjectedPool ? undefined : defaultAgentPool.execWithRetry),
    execPooledPrompt:
      typeof pool.execPooledPrompt === "function"
        ? pool.execPooledPrompt.bind(pool)
        : defaultAgentPool.execPooledPrompt,
    getActiveThreads:
      typeof pool.getActiveThreads === "function"
        ? pool.getActiveThreads.bind(pool)
        : defaultAgentPool.getActiveThreads,
    getAvailableSdks:
      typeof pool.getAvailableSdks === "function"
        ? pool.getAvailableSdks.bind(pool)
        : defaultAgentPool.getAvailableSdks,
    getPoolSdkName:
      typeof pool.getPoolSdkName === "function"
        ? pool.getPoolSdkName.bind(pool)
        : defaultAgentPool.getPoolSdkName,
    invalidateThread:
      typeof pool.invalidateThread === "function"
        ? pool.invalidateThread.bind(pool)
        : defaultAgentPool.invalidateThread,
    launchOrResumeThread:
      typeof pool.launchOrResumeThread === "function"
        ? pool.launchOrResumeThread.bind(pool)
        : (hasInjectedPool ? undefined : defaultAgentPool.launchOrResumeThread),
    launchEphemeralThread:
      typeof pool.launchEphemeralThread === "function"
        ? pool.launchEphemeralThread.bind(pool)
        : (hasInjectedPool ? undefined : defaultAgentPool.launchEphemeralThread),
    killSession:
      typeof pool.killSession === "function"
        ? pool.killSession.bind(pool)
        : async (sessionId) => {
            if (!sessionId) return false;
            try {
              (pool.invalidateThread || defaultAgentPool.invalidateThread)?.(sessionId);
              return true;
            } catch {
              return false;
            }
          },
    resetPoolSdkCache:
      typeof pool.resetPoolSdkCache === "function"
        ? pool.resetPoolSdkCache.bind(pool)
        : defaultAgentPool.resetPoolSdkCache,
    setPoolSdk:
      typeof pool.setPoolSdk === "function"
        ? pool.setPoolSdk.bind(pool)
        : defaultAgentPool.setPoolSdk,
  };
}

function buildInteractiveMetadata(options = {}, selectionId = "") {
  return {
    source: "harness-agent-service",
    surface: toTrimmedString(options.surface || "interactive") || "interactive",
    mode: normalizeInteractiveMode(options.mode, "agent"),
    agent: toTrimmedString(options.agent || selectionId || "") || null,
    model: toTrimmedString(options.model || "") || null,
    agentProfileId: toTrimmedString(options.agentProfileId || "") || null,
    cwd: toTrimmedString(options.cwd || "") || "",
    requestedBy: toTrimmedString(options.requestedBy || "") || null,
    ...toPlainObject(options.metadata),
  };
}

function normalizeInteractivePrompt(value, fallback = "") {
  return toTrimmedString(
    value?.prompt
    || value?.message
    || value?.userMessage
    || fallback,
  );
}

function summarizeContextCompressionItems(items) {
  const envelope = buildContextEnvelope({ scope: "continuation", items });
  if (!envelope) return null;
  return {
    total: envelope.meta?.total || 0,
    counts: envelope.meta?.counts || { agent: 0, user: 0, tool: 0, other: 0 },
    detail: envelope.meta?.detail || "",
    toolFamilies: envelope.meta?.toolFamilies || {},
    budgetPolicies: envelope.meta?.budgetPolicies || {},
    lowSignalToolCount: envelope.meta?.lowSignalToolCount || 0,
    content: envelope.content,
  };
}

function emitInteractiveTurnSummary(onEvent, sessionType, result) {
  if (typeof onEvent !== "function" || !result) return;
  const assistantItems = Array.isArray(result?.items) ? result.items : [];
  const latestAssistantItem = [...assistantItems]
    .reverse()
    .find((item) => String(item?.role || "").toLowerCase() === "assistant" && String(item?.text || "").trim());
  const text = String(
    result.finalResponse
    || result.text
    || result.message
    || latestAssistantItem?.text
    || "",
  ).trim();
  if (text) {
    onEvent({
      id: latestAssistantItem?.id || undefined,
      role: "assistant",
      content: text,
      timestamp: new Date().toISOString(),
      _sessionType: sessionType,
      meta: result?.usage
        ? {
            usage: { ...result.usage },
          }
        : undefined,
      _compressed: latestAssistantItem?._compressed || undefined,
      _originalLength:
        Number.isFinite(Number(latestAssistantItem?._originalLength))
          ? Number(latestAssistantItem._originalLength)
          : undefined,
      _cachedLogId: latestAssistantItem?._cachedLogId || undefined,
    });
  }
  const compressionSummary = summarizeContextCompressionItems(result?.items);
  if (compressionSummary) {
    onEvent({
      role: "system",
      type: "system",
      content: compressionSummary.content,
      timestamp: new Date().toISOString(),
      meta: {
        contextCompression: compressionSummary,
      },
    });
  }
}

export function createHarnessAgentService(options = {}) {
  const rawAgentPool = options.agentPool || {};
  const agentPool = normalizeAgentPool(rawAgentPool);
  const getPrimaryAgentName =
    typeof options.getPrimaryAgentName === "function"
      ? options.getPrimaryAgentName
      : defaultGetPrimaryAgentName;
  const getAgentMode =
    typeof options.getAgentMode === "function"
      ? options.getAgentMode
      : defaultGetAgentMode;
  const switchPrimaryAgentImpl =
    typeof options.switchPrimaryAgent === "function"
      ? options.switchPrimaryAgent
      : defaultSwitchPrimaryAgent;
  const explicitInteractiveExecutor =
    typeof options.execPrimaryPrompt === "function"
      ? options.execPrimaryPrompt
      : null;
  const sessionManager =
    options.sessionManager && typeof options.sessionManager === "object"
      ? options.sessionManager
      : getBosunSessionManager();
  let adapters =
    options.adapters && typeof options.adapters === "object"
      ? options.adapters
      : null;
  const getAdapters = () => {
    if (!adapters) {
      adapters = createShellAdapterRegistry();
    }
    return adapters;
  };
  let providerKernel =
    options.providerKernel && typeof options.providerKernel.createExecutionSession === "function"
      ? options.providerKernel
      : null;
  const getProviderKernel = () => {
    if (!providerKernel) {
      providerKernel = createProviderKernel({
        adapters: getAdapters(),
        getConfig: typeof options.getConfig === "function" ? options.getConfig : () => loadConfig() || {},
        config: options.config,
        env: options.env || process.env,
        sessionManager,
        onEvent: options.onEvent,
        toolOrchestrator: options.toolOrchestrator,
        toolRegistry: options.toolRegistry,
        toolSources: options.toolSources,
        includeBuiltinBosunTools: options.includeBuiltinBosunTools,
      });
    }
    return providerKernel;
  };

  const interactiveSessions = new Map();
  const interactiveAbortControllers = new Map();
  let interactivePrimarySelection = toTrimmedString(options.defaultInteractiveProvider || "");

  function getInteractiveSelection(input = {}) {
    const requested = toTrimmedString(
      input.providerSelection
      || input.provider
      || input.agent
      || input.selectionId
      || input.adapterName
      || interactivePrimarySelection
      || getPrimaryAgentName()
      || "",
    );
    return requested || "openai-codex-subscription";
  }

  function getInteractiveEntry(sessionId) {
    const normalizedSessionId = toTrimmedString(sessionId);
    return normalizedSessionId ? (interactiveSessions.get(normalizedSessionId) || null) : null;
  }

  function setInteractiveAbortController(sessionId, controller = null) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    if (!controller) {
      interactiveAbortControllers.delete(normalizedSessionId);
      return null;
    }
    interactiveAbortControllers.set(normalizedSessionId, controller);
    return controller;
  }

  function ensureInteractiveSession(input = {}) {
    const sessionId = toTrimmedString(input.sessionId || input.id || "");
    if (!sessionId) {
      throw new Error("Interactive harness execution requires a sessionId");
    }
    const selectionId = getInteractiveSelection(input);
    const cwd = toTrimmedString(input.cwd || process.cwd()) || process.cwd();
    const scope = toTrimmedString(input.scope || input.sessionScope || "primary") || "primary";
    const sessionType = toTrimmedString(input.sessionType || "primary") || "primary";
    const taskKey = toTrimmedString(input.taskKey || sessionId) || sessionId;
    const model = toTrimmedString(input.model || "") || null;
    const metadata = buildInteractiveMetadata(input, selectionId);
    const existing = getInteractiveEntry(sessionId);
    const reuseExisting =
      existing
      && existing.selectionId === selectionId
      && existing.model === model
      && existing.cwd === cwd;

    const managedRecord = sessionManager.beginExternalSession({
      sessionId,
      scope,
      sessionType,
      taskKey,
      cwd,
      providerSelection: selectionId,
      adapterName: selectionId,
      source: "harness-agent-service",
      metadata,
    });

    if (reuseExisting) {
      const next = {
        ...existing,
        cwd,
        taskKey,
        model,
        metadata,
        sessionType,
        scope,
        managedRecord,
      };
      interactiveSessions.set(sessionId, next);
      bindInteractiveController(next);
      return next;
    }

    const providerSession = getProviderKernel().createExecutionSession({
      selectionId,
      provider: selectionId,
      adapterName: selectionId,
      sessionId,
      threadId: toTrimmedString(
        managedRecord?.activeThreadId
        || existing?.providerSession?.getState?.().threadId
        || existing?.threadId
        || "",
      ) || null,
      cwd,
      repoRoot: input.repoRoot || cwd,
      model,
      metadata,
      sessionManager,
      onEvent: input.onEvent || options.onEvent,
      agentProfileId: toTrimmedString(input.agentProfileId || "") || null,
      subagentMaxParallel: input.subagentMaxParallel ?? options.subagentMaxParallel,
    });
    const next = {
      sessionId,
      selectionId,
      providerSession,
      cwd,
      taskKey,
      model,
      metadata,
      sessionType,
      scope,
      managedRecord,
    };
    interactiveSessions.set(sessionId, next);
    bindInteractiveController(next);
    return next;
  }

  function bindInteractiveController(entry) {
    if (!entry || typeof sessionManager.bindExternalController !== "function") {
      return null;
    }
    const sessionId = entry.sessionId;
    return sessionManager.bindExternalController(sessionId, {
      abort(reason = "aborted") {
        const abortController = interactiveAbortControllers.get(sessionId);
        if (abortController && !abortController.signal.aborted) {
          try {
            abortController.abort(reason);
          } catch {
          }
        }
      },
      async run(runRequest = {}) {
        const prompt = normalizeInteractivePrompt(runRequest);
        if (!prompt) {
          throw new Error(`Interactive harness session "${sessionId}" continuation requires a prompt`);
        }
        return await executeInteractiveTurn(prompt, {
          ...entry,
          ...runRequest,
          sessionId,
        });
      },
      steer(prompt, meta = {}) {
        const adapter = entry.providerSession?.adapter || null;
        if (typeof adapter?.steer !== "function") {
          return {
            ok: false,
            delivered: false,
            reason: "not_steerable",
            interventionType: toTrimmedString(meta?.kind || meta?.type || "steer") || "steer",
            stageId: null,
            targetTaskKey: entry.taskKey,
          };
        }
        try {
          const response = adapter.steer(prompt, meta);
          return {
            ok: response !== false,
            delivered: response !== false,
            reason: response === false ? "adapter_rejected" : null,
            interventionType: toTrimmedString(meta?.kind || meta?.type || "steer") || "steer",
            stageId: null,
            targetTaskKey: entry.taskKey,
          };
        } catch (error) {
          return {
            ok: false,
            delivered: false,
            reason: String(error?.message || error || "steer_failed"),
            interventionType: toTrimmedString(meta?.kind || meta?.type || "steer") || "steer",
            stageId: null,
            targetTaskKey: entry.taskKey,
          };
        }
      },
    });
  }

  async function executeInteractiveTurn(prompt, input = {}) {
    const entry = ensureInteractiveSession(input);
    const sessionId = entry.sessionId;
    const abortController =
      input.abortController instanceof AbortController
        ? input.abortController
        : new AbortController();
    setInteractiveAbortController(sessionId, abortController);
    const framedPrompt = frameInteractivePrompt(prompt, {
      ...input,
      mode: input.mode || entry.metadata.mode || getAgentMode(),
      attachments: input.attachments,
      attachmentsAppended: input.attachmentsAppended === true,
      cwd: entry.cwd,
      agentProfileId: input.agentProfileId || entry.metadata.agentProfileId || null,
      sessionManager,
    });

    sessionManager.registerExecution(sessionId, {
      sessionType: entry.sessionType,
      taskKey: entry.taskKey,
      cwd: entry.cwd,
      status: "running",
      threadId: entry.providerSession?.getState?.().threadId || null,
      providerSelection: entry.selectionId,
      adapterName: entry.selectionId,
      metadata: entry.metadata,
    });

    try {
      const result = await entry.providerSession.runTurn(framedPrompt, {
        cwd: entry.cwd,
        repoRoot: input.repoRoot || entry.cwd,
        model: input.model || entry.model || undefined,
        sessionId,
        threadId: entry.providerSession?.getState?.().threadId || null,
        sessionManager,
        onEvent: input.onEvent || options.onEvent,
        abortController,
        taskKey: entry.taskKey,
        sessionType: entry.sessionType,
        requestedBy: input.requestedBy || entry.metadata.requestedBy || null,
        agentProfileId: input.agentProfileId || entry.metadata.agentProfileId || null,
        metadata: entry.metadata,
        subagentMaxParallel: input.subagentMaxParallel ?? options.subagentMaxParallel,
      });
      const state = entry.providerSession.getState();
      const compressedItems = await maybeCompressSessionItems(result?.items, {
        sessionType: entry.sessionType,
        agentType: entry.selectionId,
        sessionId,
        force: input.forceContextShredding === true,
        skip: input.skipContextShredding === true,
      });
      const normalized = normalizeTurnResult({
        ...result,
        items: compressedItems,
      }, {
        adapter: entry.selectionId,
        threadId: state.threadId || result?.threadId || sessionId,
      });
      emitInteractiveTurnSummary(input.onEvent || options.onEvent, entry.sessionType, normalized);
      sessionManager.finalizeExternalExecution(sessionId, {
        success: normalized.success !== false,
        status: normalized.status || (normalized.success === false ? "failed" : "completed"),
        threadId: normalized.threadId || state.threadId || sessionId,
        error: normalized.success === false ? normalized.error || "interactive_turn_failed" : null,
        result: normalized,
      });
      return normalized;
    } catch (error) {
      sessionManager.finalizeExternalExecution(sessionId, {
        success: false,
        status: "failed",
        threadId: entry.providerSession?.getState?.().threadId || sessionId,
        error: String(error?.message || error || "interactive_turn_failed"),
        result: {
          error: String(error?.message || error || "interactive_turn_failed"),
        },
      });
      throw error;
    } finally {
      if (interactiveAbortControllers.get(sessionId) === abortController) {
        setInteractiveAbortController(sessionId, null);
      }
    }
  }

  return {
    addActiveSessionListener(listener) {
      return agentPool.addActiveSessionListener?.(listener) || null;
    },

    clearThreadRegistry() {
      interactiveSessions.clear();
      return agentPool.clearThreadRegistry?.();
    },

    createCompiledInternalHarnessSession(...args) {
      if (typeof agentPool.createCompiledInternalHarnessSession !== "function") {
        throw new Error("Compiled harness sessions are unavailable");
      }
      return agentPool.createCompiledInternalHarnessSession(...args);
    },

    execPooledPrompt(...args) {
      if (typeof agentPool.execPooledPrompt === "function") {
        return agentPool.execPooledPrompt(...args);
      }
      return this.runBackgroundPrompt(args[0], args[1] || {});
    },

    getActiveThreads() {
      return typeof agentPool.getActiveThreads === "function"
        ? agentPool.getActiveThreads()
        : [];
    },

    getAvailableSdks() {
      return typeof agentPool.getAvailableSdks === "function"
        ? agentPool.getAvailableSdks()
        : [];
    },

    getPoolSdkName() {
      return agentPool.getPoolSdkName?.() || "codex";
    },

    getPrimaryAgentName() {
      return interactivePrimarySelection || getPrimaryAgentName();
    },

    getAgentMode() {
      return getAgentMode();
    },

    async switchPrimaryAgent(name) {
      interactivePrimarySelection = toTrimmedString(name || "") || interactivePrimarySelection;
      return await switchPrimaryAgentImpl(name);
    },

    invalidateThread(sessionId) {
      return agentPool.invalidateThread?.(sessionId);
    },

    async runTask(prompt, input = {}) {
      const normalizedInput = normalizePoolLaunchOptions(input);
      const cwd = normalizedInput.cwd || process.cwd();
      const timeoutMs = Number(normalizedInput.timeoutMs || normalizedInput.timeout || 60 * 60 * 1000);
      const taskKey = normalizedInput.taskKey || null;
      const launchOptions = {
        ...normalizedInput,
        timeoutMs,
      };

      if (normalizedInput.autoRecover !== false && typeof agentPool.execWithRetry === "function") {
        return await agentPool.execWithRetry(prompt, launchOptions);
      }
      if (taskKey && typeof agentPool.launchOrResumeThread === "function") {
        return await agentPool.launchOrResumeThread(prompt, cwd, timeoutMs, launchOptions);
      }
      if (typeof agentPool.launchEphemeralThread === "function") {
        return await agentPool.launchEphemeralThread(
          prompt,
          cwd,
          timeoutMs,
          normalizeEphemeralLaunchOptions(launchOptions),
        );
      }
      throw new Error("Agent pool does not expose execWithRetry, launchOrResumeThread, or launchEphemeralThread");
    },

    async runBackgroundPrompt(prompt, input = {}) {
      const result = await this.runTask(prompt, input);
      return normalizeTurnResult(result, {
        adapter: result?.sdk || input.sdk || this.getPoolSdkName(),
        threadId: result?.threadId || null,
      });
    },

    async execWithRetry(prompt, input = {}) {
      if (typeof agentPool.execWithRetry === "function") {
        return await agentPool.execWithRetry(prompt, normalizePoolLaunchOptions(input));
      }
      return await this.runTask(prompt, { ...input, autoRecover: false });
    },

    async launchEphemeralThread(prompt, cwd, timeoutMs, input = {}) {
      const normalizedInput = normalizePoolLaunchOptions(input);
      if (typeof agentPool.launchEphemeralThread === "function") {
        return await agentPool.launchEphemeralThread(
          prompt,
          cwd,
          timeoutMs,
          normalizeEphemeralLaunchOptions(normalizedInput),
        );
      }
      return await this.runTask(prompt, {
        ...normalizedInput,
        cwd,
        timeoutMs,
        autoRecover: false,
      });
    },

    async launchOrResumeThread(prompt, cwd, timeoutMs, input = {}) {
      const normalizedInput = normalizePoolLaunchOptions(input);
      if (typeof agentPool.launchOrResumeThread === "function") {
        return await agentPool.launchOrResumeThread(prompt, cwd, timeoutMs, normalizedInput);
      }
      return await this.runTask(prompt, {
        ...normalizedInput,
        cwd,
        timeoutMs,
      });
    },

    async continueSession(sessionId, prompt, options = {}) {
      const normalizedOptions = normalizePoolLaunchOptions(options);
      const normalizedSessionId = toTrimmedString(sessionId);
      if (normalizedSessionId && interactiveSessions.has(normalizedSessionId)) {
        ensureInteractiveSession({
          ...interactiveSessions.get(normalizedSessionId),
          ...normalizedOptions,
          sessionId: normalizedSessionId,
        });
        return await sessionManager.continueSession(normalizedSessionId, {
          action: normalizedOptions.action || "continue",
          lifecycleState: normalizedOptions.lifecycleState || "running",
          runRequest: {
            ...normalizedOptions,
            sessionId: normalizedSessionId,
            prompt,
          },
        });
      }
      if (
        normalizedSessionId
        && typeof sessionManager.getSessionController === "function"
        && sessionManager.getSessionController(normalizedSessionId)
      ) {
        return await sessionManager.continueSession(normalizedSessionId, {
          action: normalizedOptions.action || "continue",
          lifecycleState: normalizedOptions.lifecycleState || "running",
          runRequest: {
            ...normalizedOptions,
            sessionId: normalizedSessionId,
            prompt,
          },
        });
      }
      if (
        typeof rawAgentPool.continueSession !== "function"
        && typeof rawAgentPool.launchEphemeralThread === "function"
      ) {
        const cwd = normalizedOptions.cwd || process.cwd();
        const timeoutMs = Number(normalizedOptions.timeoutMs || normalizedOptions.timeout || 60 * 60 * 1000);
        return await rawAgentPool.launchEphemeralThread(prompt, cwd, timeoutMs, normalizeEphemeralLaunchOptions({
          ...normalizedOptions,
          timeoutMs,
        }));
      }
      return await agentPool.continueSession(normalizedSessionId, prompt, normalizedOptions);
    },

    async continueSessionPrompt(sessionId, prompt, options = {}) {
      const result = await this.continueSession(sessionId, prompt, options);
      return normalizeTurnResult(result, {
        adapter: result?.providerId || result?.sdk || options.sdk || this.getPrimaryAgentName(),
        threadId: result?.threadId || sessionId || null,
      });
    },

    async runInteractivePrompt(prompt, options = {}) {
      if (explicitInteractiveExecutor) {
        const result = await explicitInteractiveExecutor(prompt, options);
        return normalizeTurnResult(result, {
          adapter: this.getPrimaryAgentName(),
          threadId: options.sessionId || null,
        });
      }
      const normalizedSessionId = toTrimmedString(options.sessionId || "");
      if (!normalizedSessionId) {
        throw new Error("Interactive prompt executor requires a sessionId");
      }
      return await executeInteractiveTurn(prompt, {
        ...options,
        sessionId: normalizedSessionId,
        agent: options.agent || options.providerSelection || options.provider || this.getPrimaryAgentName(),
      });
    },

    async killSession(sessionId) {
      const normalizedSessionId = toTrimmedString(sessionId);
      if (
        normalizedSessionId
        && (
          interactiveSessions.has(normalizedSessionId)
          || typeof sessionManager.getSession === "function" && sessionManager.getSession(normalizedSessionId)
        )
      ) {
        try {
          sessionManager.cancelSession(normalizedSessionId, "operator_stop");
          return true;
        } catch {
          return false;
        }
      }
      return await agentPool.killSession(normalizedSessionId);
    },

    resetPoolSdkCache() {
      return agentPool.resetPoolSdkCache?.();
    },

    setPoolSdk(name) {
      return agentPool.setPoolSdk?.(name);
    },
  };
}

export default createHarnessAgentService;
