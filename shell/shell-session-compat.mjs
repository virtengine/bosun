/**
 * Transitional architecture note:
 * This module is a compatibility bridge from legacy shell session idioms into
 * the canonical harness session manager, provider kernel, tool orchestrator,
 * and telemetry spine. It may translate transport payloads, but it must not
 * define parallel lifecycle, provider, or tool-control semantics.
 */

import { getBosunSessionManager } from "../agent/session-manager.mjs";
import { createProviderKernel } from "../agent/provider-kernel.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { normalizeProviderDefinitionId } from "../agent/providers/index.mjs";
import { recordHarnessTelemetryEvent } from "../infra/session-telemetry.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function normalizeScope(adapterName, explicitScope = "") {
  const scope = toTrimmedString(explicitScope);
  if (scope) return scope;
  return `shell:${toTrimmedString(adapterName) || "adapter"}`;
}

function normalizeProviderSelection(adapterName, explicitSelection = "") {
  const normalized = normalizeProviderDefinitionId(explicitSelection || adapterName, "");
  return normalized || toTrimmedString(explicitSelection || adapterName) || null;
}

function buildMetadata(adapterName, input = {}) {
  return {
    shellCompat: true,
    adapterName: toTrimmedString(adapterName) || null,
    ...toPlainObject(input.metadata),
  };
}

function buildCommonInput(adapterName, scope, providerSelection, sessionType, input = {}) {
  const sessionId = toTrimmedString(input.sessionId || input.id || "");
  if (!sessionId) return null;
  return {
    sessionId,
    scope,
    sessionType: toTrimmedString(input.sessionType || sessionType) || sessionType,
    taskKey: toTrimmedString(input.taskKey || sessionId) || sessionId,
    threadId: toTrimmedString(input.threadId || "") || null,
    cwd: toTrimmedString(input.cwd || ""),
    providerSelection: toTrimmedString(input.providerSelection || providerSelection) || providerSelection,
    adapterName: toTrimmedString(input.adapterName || adapterName) || adapterName,
    status: toTrimmedString(input.status || "idle") || "idle",
    metadata: buildMetadata(adapterName, input),
  };
}

function mergeRecords(primary = {}, fallback = {}) {
  const primaryRecord = toPlainObject(primary);
  const fallbackRecord = toPlainObject(fallback);
  return {
    ...fallbackRecord,
    ...primaryRecord,
    metadata: {
      ...toPlainObject(fallbackRecord.metadata),
      ...toPlainObject(primaryRecord.metadata),
    },
  };
}

function matchesAdapter(record, adapterName) {
  const normalizedAdapter = toTrimmedString(adapterName);
  if (!normalizedAdapter) return true;
  const metadataAdapter = toTrimmedString(record?.metadata?.adapterName || "");
  return !metadataAdapter || metadataAdapter === normalizedAdapter;
}

function formatSessionRecord(record, adapterName, activeSessionId = "") {
  if (!record) return null;
  const sessionId = toTrimmedString(record.sessionId || record.id || "");
  if (!sessionId) return null;
  const metadata = toPlainObject(record.metadata);
  const isActive = toTrimmedString(activeSessionId) === sessionId;
  return {
    id: sessionId,
    sessionId,
    adapter: adapterName,
    status: toTrimmedString(record.status || "idle") || "idle",
    threadId: toTrimmedString(record.activeThreadId || record.threadId || metadata.providerThreadId || "") || null,
    cwd: toTrimmedString(metadata.cwd || metadata.workingDirectory || "") || null,
    active: isActive,
    isActive,
    turnCount: Number(metadata.turnCount || 0),
    createdAt: record.createdAt || null,
    lastActiveAt: record.lastActiveAt || null,
    metadata,
  };
}

export function createShellSessionCompat(options = {}) {
  const adapterName = toTrimmedString(options.adapterName || options.name || "adapter") || "adapter";
  const providerSelection =
    normalizeProviderSelection(adapterName, options.providerSelection || adapterName)
    || adapterName;
  const sessionType = toTrimmedString(options.sessionType || "primary") || "primary";
  const scope = normalizeScope(adapterName, options.scope);
  const sessionManager = options.sessionManager || getBosunSessionManager();
  const providerKernel = options.providerKernel || createProviderKernel({
    adapters: options.adapters || {},
    env: options.env || process.env,
    config: options.config,
  });

  function resolveProvider(input = {}) {
    const selection = normalizeProviderSelection(
      adapterName,
      input.providerSelection || input.provider || providerSelection,
    );
    const runtime = selection && providerKernel?.resolveRuntime
      ? providerKernel.resolveRuntime(selection, adapterName)
      : null;
    return {
      selection,
      providerId: runtime?.providerId || selection || null,
      providerConfig: runtime?.providerConfig || null,
      providerEntry: runtime?.providerEntry || null,
      runtime,
    };
  }

  function recordCompatibilityEvent(eventType, sessionId, input = {}) {
    const provider = resolveProvider(input);
    recordHarnessTelemetryEvent({
      source: "shell-session-compat",
      eventType,
      category: input.category || "shell",
      sessionId: toTrimmedString(sessionId || input.sessionId || input.id || "") || null,
      rootSessionId: toTrimmedString(input.rootSessionId || input.sessionId || sessionId || "") || null,
      parentSessionId: toTrimmedString(input.parentSessionId || "") || null,
      threadId: toTrimmedString(input.threadId || input.providerThreadId || "") || null,
      runId: toTrimmedString(input.runId || "") || null,
      workflowId: toTrimmedString(input.workflowId || "") || null,
      providerId: provider.providerId || null,
      providerTurnId: toTrimmedString(input.providerTurnId || "") || null,
      modelId: toTrimmedString(
        input.model
        || input.modelId
        || provider.providerConfig?.model
        || provider.providerEntry?.defaultModel
        || "",
      ) || null,
      toolId: toTrimmedString(input.toolId || "") || null,
      toolName: toTrimmedString(input.toolName || "") || null,
      commandName: toTrimmedString(input.commandName || "") || null,
      surface: "shell",
      channel: adapterName,
      action: toTrimmedString(input.action || input.rawEventType || "") || null,
      actor: adapterName,
      status: toTrimmedString(input.status || "") || null,
      metadata: {
        shellCompat: true,
        adapterName,
        providerSelection: provider.selection,
        ...(toPlainObject(input.metadata)),
      },
      summary: toTrimmedString(input.summary || "") || null,
      error: toTrimmedString(input.error || "") || null,
    }, { configDir: options.configDir || process.cwd() });
  }

  function registerLifecycle(sessionId, input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, {
      ...input,
      sessionId,
      providerSelection: resolveProvider(input).providerId || providerSelection,
    });
    if (!common) return null;
    if (input.activate === true) {
      sessionManager.switchSession(common.sessionId, common);
    } else {
      sessionManager.ensureSession(common);
    }
    const record = sessionManager.registerExecution(common.sessionId, common);
    recordCompatibilityEvent(`shell.session.${common.status || "updated"}`, common.sessionId, {
      ...input,
      sessionId: common.sessionId,
      threadId: common.threadId,
      cwd: common.cwd,
      status: common.status,
      metadata: common.metadata,
      category: "session",
    });
    return record;
  }

  function ensureSession(input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, input);
    if (!common) return null;
    const record = sessionManager.ensureSession(common);
    if (input.activate === true) {
      sessionManager.switchSession(common.sessionId, common);
      return sessionManager.getSession(common.sessionId) || record;
    }
    return record;
  }

  function activateSession(sessionId, input = {}) {
    const common = buildCommonInput(adapterName, scope, providerSelection, sessionType, {
      ...input,
      sessionId,
    });
    if (!common) return null;
    sessionManager.ensureSession(common);
    return sessionManager.switchSession(common.sessionId, common);
  }

  function registerExecution(sessionId, input = {}) {
    return registerLifecycle(sessionId, input);
  }

  function bindController(sessionId, controller = {}) {
    const normalizedSessionId = toTrimmedString(sessionId);
    if (!normalizedSessionId) return null;
    if (typeof sessionManager.bindExternalController !== "function") return null;
    return sessionManager.bindExternalController(normalizedSessionId, controller);
  }

  function hydrate(input = {}) {
    const sessionId = toTrimmedString(input.sessionId || input.id || "");
    if (!sessionId) return null;
    return ensureSession({
      ...input,
      sessionId,
      activate: input.activate !== false,
    });
  }

  function getActiveSession() {
    const active = sessionManager.getActiveSession(scope);
    return matchesAdapter(active, adapterName) ? active : null;
  }

  function getActiveSessionId() {
    return getActiveSession()?.sessionId || null;
  }

  function clearActiveSession() {
    if (typeof sessionManager.clearActiveSession === "function") {
      sessionManager.clearActiveSession(scope);
    }
  }

  function getSessionRecord(sessionId) {
    const record = sessionManager.getSession(toTrimmedString(sessionId));
    return matchesAdapter(record, adapterName)
      ? formatSessionRecord(record, adapterName, getActiveSessionId())
      : null;
  }

  function getSessionInfo(fallback = {}) {
    const localSessionId = toTrimmedString(
      fallback.sessionId || fallback.namedSessionId || fallback.id || "",
    );
    const activeSessionId = getActiveSessionId();
    const active = sessionManager.getSession(localSessionId || activeSessionId || "");
    return mergeRecords(
      formatSessionRecord(active, adapterName, activeSessionId) || {},
      fallback,
    );
  }

  function listSessions(options = {}) {
    const activeSessionId = getActiveSessionId();
    const compatSessions = sessionManager
      .listSessions({ scope })
      .filter((record) => matchesAdapter(record, adapterName));
    const merged = new Map();
    for (const record of compatSessions) {
      const formatted = formatSessionRecord(record, adapterName, activeSessionId);
      const key = toTrimmedString(formatted?.sessionId || "");
      if (key) merged.set(key, formatted);
    }
    for (const record of Array.isArray(options.extraSessions) ? options.extraSessions : []) {
      const key = toTrimmedString(record?.sessionId || record?.id || "");
      if (!key) continue;
      merged.set(key, mergeRecords(merged.get(key), record));
    }
    return [...merged.values()];
  }

  function reset(options = {}) {
    const sessionId = toTrimmedString(
      options.sessionId || getActiveSessionId() || options.id || "",
    );
    clearActiveSession();
    if (options.keepManagedRecord === false || !sessionId) {
      return null;
    }
    return sessionManager.ensureSession({
      ...(buildCommonInput(adapterName, scope, providerSelection, sessionType, {
        ...options,
        sessionId,
        status: options.status || "idle",
      }) || {}),
    });
  }

  function beginTurn(sessionId, input = {}) {
    return registerLifecycle(sessionId, {
      ...input,
      sessionId,
      status: input.status || "running",
    });
  }

  function completeTurn(sessionId, input = {}) {
    return registerLifecycle(sessionId, {
      ...input,
      sessionId,
      status: input.status || "completed",
    });
  }

  function failTurn(sessionId, input = {}) {
    return registerLifecycle(sessionId, {
      ...input,
      sessionId,
      status: input.status || "failed",
    });
  }

  function abortTurn(sessionId, input = {}) {
    return registerLifecycle(sessionId, {
      ...input,
      sessionId,
      status: input.status || "aborted",
    });
  }

  function recordStreamEvent(sessionId, rawEvent, input = {}) {
    return recordCompatibilityEvent("shell.stream.event", sessionId, {
      ...input,
      rawEventType: rawEvent?.type,
      summary: toTrimmedString(input.summary || "") || toTrimmedString(rawEvent?.type || "") || null,
      metadata: {
        rawEventType: rawEvent?.type || null,
        ...(toPlainObject(input.metadata)),
      },
      category: "stream",
      status: input.status || "running",
    });
  }

  function recordToolEvent(sessionId, rawEvent, input = {}) {
    return recordCompatibilityEvent("shell.tool.event", sessionId, {
      ...input,
      rawEventType: rawEvent?.type,
      category: "tool",
      status: input.status || "running",
    });
  }

  function createToolGateway(input = {}) {
    return createToolOrchestrator({
      cwd: input.cwd,
      repoRoot: input.repoRoot || input.cwd || process.cwd(),
      registry: input.registry,
      toolSources: input.toolSources,
      executeTool: input.executeTool,
      approvalOptions: input.approvalOptions,
      networkPolicy: input.networkPolicy,
      retryPolicy: input.retryPolicy,
      truncation: input.truncation,
      onEvent: (event) => {
        recordToolEvent(input.sessionId || input.threadId || null, event, {
          ...input,
          toolId: event?.toolId || input.toolId || null,
          toolName: event?.toolName || input.toolName || null,
          action: event?.type || null,
          metadata: {
            eventType: event?.type || null,
            ...(toPlainObject(input.metadata)),
          },
          status: event?.status || input.status || "running",
        });
        if (typeof input.onEvent === "function") {
          input.onEvent(event);
        }
      },
    });
  }

  return {
    adapterName,
    scope,
    sessionType,
    providerSelection,
    providerKernel,
    sessionManager,
    resolveProvider,
    ensureSession,
    ensureManagedSession(sessionId, input = {}) {
      return ensureSession({
        ...input,
        sessionId,
      });
    },
    activateSession,
    switchSession(sessionId, input = {}) {
      return activateSession(sessionId, input);
    },
    createSession(sessionId, input = {}) {
      return ensureSession({
        ...input,
        sessionId,
        activate: false,
      });
    },
    registerExecution,
    bindController,
    beginTurn,
    completeTurn,
    failTurn,
    abortTurn,
    recordStreamEvent,
    recordToolEvent,
    createToolGateway,
    hydrate,
    getActiveSession,
    getActiveSessionId,
    clearActiveSession,
    getSessionRecord,
    getSessionInfo,
    listSessions,
    reset,
  };
}

export default createShellSessionCompat;
