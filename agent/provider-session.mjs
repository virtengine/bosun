import {
  buildProviderTurnPayload,
  normalizeProviderResultPayload,
} from "./provider-message-transform.mjs";
import { createProviderRegistry } from "./provider-registry.mjs";
import { normalizeProviderStreamEnvelope } from "./providers/provider-stream-normalizer.mjs";
import { ProviderConfigurationError } from "./providers/provider-errors.mjs";
import {
  normalizeProviderSelection,
  normalizeProviderSessionInput,
  normalizeProviderSessionState,
  normalizeProviderToolCallEnvelope,
} from "./providers/provider-contract.mjs";

export function extractProviderResponseText(result) {
  if (typeof result === "string") return result;
  return normalizeProviderResultPayload(result).text || JSON.stringify(result);
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeContinuationRole(role, fallback = "user") {
  const normalized = toTrimmedString(role).toLowerCase();
  if (["system", "user", "assistant", "tool", "developer"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function extractTextParts(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .filter((entry) => String(entry?.type || "").trim().toLowerCase() === "text")
    .map((entry) => toTrimmedString(entry?.text || entry?.content || ""))
    .filter(Boolean);
}

function countStructuredParts(parts = [], targetType = "") {
  const normalizedTarget = toTrimmedString(targetType).toLowerCase();
  if (!normalizedTarget) return 0;
  return (Array.isArray(parts) ? parts : []).filter((entry) =>
    String(entry?.type || "").trim().toLowerCase() === normalizedTarget).length;
}

function summarizeCompactedAssistantStep(message = {}) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const toolCallCount = Math.max(
    Array.isArray(message?.toolCalls) ? message.toolCalls.length : 0,
    countStructuredParts(parts, "tool_call"),
  );
  const toolResultCount = Math.max(
    Array.isArray(message?.toolResults) ? message.toolResults.length : 0,
    countStructuredParts(parts, "tool_result"),
  );
  const reasoningCount = Math.max(
    Array.isArray(message?.reasoning) ? message.reasoning.length : 0,
    countStructuredParts(parts, "reasoning"),
  );
  const summaryParts = [];
  if (toolCallCount > 0) {
    summaryParts.push(`${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}`);
  }
  if (toolResultCount > 0) {
    summaryParts.push(`${toolResultCount} tool result${toolResultCount === 1 ? "" : "s"}`);
  }
  if (reasoningCount > 0) {
    summaryParts.push(`${reasoningCount} reasoning step${reasoningCount === 1 ? "" : "s"}`);
  }
  if (!summaryParts.length) return "";
  return `Completed prior step using ${summaryParts.join(", ")}.`;
}

function compactContinuationMessage(message = {}) {
  if (!message || typeof message !== "object") return null;
  const role = normalizeContinuationRole(message.role, "user");
  if (role === "tool") return null;
  const content = Array.isArray(message.content) ? message.content : [];
  const textCandidates = [
    toTrimmedString(message.text),
    extractTextParts(content).join("\n").trim(),
  ].filter(Boolean);
  let text = textCandidates[0] || "";
  if (!text && role === "assistant") {
    text = summarizeCompactedAssistantStep(message);
  }
  if (!text) return null;
  const next = cloneValue(message);
  next.role = role;
  next.text = text;
  next.content = [{ type: "text", text }];
  delete next.toolCalls;
  delete next.toolResults;
  delete next.reasoning;
  return next;
}

export function buildCompactedContinuationHistory(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => compactContinuationMessage(message))
    .filter(Boolean);
}

function createEventEmitter(hooks = []) {
  const listeners = [...new Set(hooks.filter((hook) => typeof hook === "function"))];
  return (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
      }
    }
  };
}

function sumUsage(left = null, right = null) {
  if (!left && !right) return null;
  const base = left && typeof left === "object" ? { ...left } : {};
  const next = right && typeof right === "object" ? right : {};
  return {
    inputTokens: Number(base.inputTokens || 0) + Number(next.inputTokens || 0),
    outputTokens: Number(base.outputTokens || 0) + Number(next.outputTokens || 0),
    totalTokens: Number(base.totalTokens || 0) + Number(next.totalTokens || 0),
    cacheInputTokens: Number(base.cacheInputTokens || 0) + Number(next.cacheInputTokens || 0),
    costUsd: Number(base.costUsd || 0) + Number(next.costUsd || 0),
    raw: {
      ...(base.raw && typeof base.raw === "object" ? base.raw : {}),
      ...(next.raw && typeof next.raw === "object" ? next.raw : {}),
    },
  };
}

function buildAssistantMessagesFromResult(normalized, roundIndex = 0) {
  const messages = Array.isArray(normalized.items) ? normalized.items.map((entry) => cloneValue(entry)) : [];
  const hasToolCalls = messages.some((entry) => Array.isArray(entry?.toolCalls) && entry.toolCalls.length > 0);
  const hasToolResults = messages.some((entry) => Array.isArray(entry?.toolResults) && entry.toolResults.length > 0);
  const hasReasoning = messages.some((entry) => Array.isArray(entry?.reasoning) && entry.reasoning.length > 0);
  const synthesizedContent = [];
  if (!hasReasoning) {
    for (const entry of Array.isArray(normalized.reasoning) ? normalized.reasoning : []) {
      synthesizedContent.push({
        type: "reasoning",
        text: entry?.text || entry?.content || entry?.summary || "",
      });
    }
  }
  if (!hasToolCalls) {
    for (const entry of Array.isArray(normalized.toolCalls) ? normalized.toolCalls : []) {
      synthesizedContent.push({
        type: "tool_call",
        id: entry.id,
        name: entry.name,
        server: entry.server,
        tool: entry.tool,
        input: cloneValue(entry.input),
        status: entry.status,
      });
    }
  }
  if (!hasToolResults) {
    for (const entry of Array.isArray(normalized.toolResults) ? normalized.toolResults : []) {
      synthesizedContent.push({
        type: "tool_result",
        id: entry.id,
        toolCallId: entry.toolCallId,
        name: entry.name,
        output: cloneValue(entry.output),
        is_error: entry.isError === true,
        status: entry.status,
      });
    }
  }
  const assistantText = toTrimmedString(normalized.finalResponse || normalized.output || normalized.reasoningText || "");
  if (messages.length === 0 || synthesizedContent.length > 0) {
    messages.push({
      id: `provider-round-${roundIndex + 1}`,
      role: "assistant",
      content: assistantText ? [{ type: "text", text: assistantText }, ...synthesizedContent] : synthesizedContent,
      text: assistantText,
    });
  }
  return messages;
}

function buildToolResultMessages(toolCalls = [], toolExecutions = [], roundIndex = 0) {
  return toolExecutions.map((execution, index) => {
    const call = normalizeProviderToolCallEnvelope(toolCalls[index] || execution?.toolCall || {});
    const output = execution?.ok === false
      ? { error: execution.error || "tool_execution_failed" }
      : cloneValue(execution?.output);
    return {
      id: `provider-tool-result-${roundIndex + 1}-${index + 1}`,
      role: "tool",
      content: [{
        type: "tool_result",
        toolCallId: call.id,
        name: call.name,
        output,
        is_error: execution?.ok === false,
        status: execution?.ok === false ? "failed" : "completed",
      }],
      text:
        execution?.ok === false
          ? `Tool ${call.name || call.id || "tool"} failed: ${execution.error || "tool_execution_failed"}`
          : JSON.stringify(output),
    };
  });
}

function resolveToolExecutor(options = {}, turnOptions = {}) {
  if (typeof turnOptions.executeTool === "function") return turnOptions.executeTool;
  if (typeof options.executeTool === "function") return options.executeTool;
  if (typeof turnOptions.toolRunner?.runTool === "function") {
    return turnOptions.toolRunner.runTool.bind(turnOptions.toolRunner);
  }
  if (typeof options.toolRunner?.runTool === "function") {
    return options.toolRunner.runTool.bind(options.toolRunner);
  }
  if (typeof turnOptions.toolOrchestrator?.executeTool === "function") {
    return turnOptions.toolOrchestrator.executeTool.bind(turnOptions.toolOrchestrator);
  }
  if (typeof turnOptions.toolOrchestrator?.execute === "function") {
    return turnOptions.toolOrchestrator.execute.bind(turnOptions.toolOrchestrator);
  }
  if (typeof options.toolOrchestrator?.executeTool === "function") {
    return options.toolOrchestrator.executeTool.bind(options.toolOrchestrator);
  }
  if (typeof options.toolOrchestrator?.execute === "function") {
    return options.toolOrchestrator.execute.bind(options.toolOrchestrator);
  }
  return null;
}

function resolveToolDefinitions(options = {}, turnOptions = {}, context = {}) {
  if (Array.isArray(turnOptions.tools)) return cloneValue(turnOptions.tools);
  if (Array.isArray(options.tools)) return cloneValue(options.tools);
  if (typeof turnOptions.toolRunner?.listTools === "function") {
    return cloneValue(turnOptions.toolRunner.listTools(context));
  }
  if (typeof options.toolRunner?.listTools === "function") {
    return cloneValue(options.toolRunner.listTools(context));
  }
  if (typeof turnOptions.toolOrchestrator?.listTools === "function") {
    return cloneValue(turnOptions.toolOrchestrator.listTools(context));
  }
  if (typeof options.toolOrchestrator?.listTools === "function") {
    return cloneValue(options.toolOrchestrator.listTools(context));
  }
  return [];
}

async function executeProviderToolCalls(toolCalls = [], executeTool = null, context = {}, emitEvent = () => {}) {
  const results = [];
  if (typeof executeTool !== "function") return results;
  for (const rawToolCall of toolCalls) {
    const toolCall = normalizeProviderToolCallEnvelope(rawToolCall);
    emitEvent({
      type: "provider:tool-call-start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      sessionId: context.sessionId || null,
      threadId: context.threadId || null,
      providerId: context.providerId || null,
    });
    try {
      const output = await executeTool(toolCall.name, toolCall.input || {}, {
        ...context,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
      results.push({
        ok: true,
        toolCall,
        output,
      });
      emitEvent({
        type: "provider:tool-call-complete",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        sessionId: context.sessionId || null,
        threadId: context.threadId || null,
        providerId: context.providerId || null,
      });
    } catch (error) {
      const errorMessage = String(error?.message || error || "tool_execution_failed");
      results.push({
        ok: false,
        toolCall,
        error: errorMessage,
      });
      emitEvent({
        type: "provider:tool-call-error",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        sessionId: context.sessionId || null,
        threadId: context.threadId || null,
        providerId: context.providerId || null,
        error: errorMessage,
      });
    }
  }
  return results;
}

function normalizeProviderResult(result, context = {}) {
  const normalized = normalizeProviderResultPayload(result, context);
  return {
    success: result?.success !== false && !normalized.error,
    output: normalized.text,
    finalResponse: normalized.text,
    status: result?.status || (normalized.error || result?.success === false ? "failed" : "completed"),
    outcome: result?.outcome || (normalized.error || result?.success === false ? "failure" : "success"),
    sessionId: normalized.sessionId,
    threadId: normalized.threadId,
    items: normalized.messages,
    usage: normalized.usage,
    toolCalls: normalized.toolCalls,
    toolResults: normalized.toolResults,
    reasoning: normalized.reasoning,
    reasoningText: normalized.reasoningText,
    finishReason: normalized.finishReason,
    error: normalized.error,
    providerId: normalized.providerId || context.providerId || null,
    model: normalized.model || context.model || null,
    raw: result,
  };
}

export function createLinkedAbortController(parentController = null) {
  const controller = new AbortController();
  const parentSignal = parentController?.signal || null;
  if (!parentSignal) return controller;
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return controller;
  }
  parentSignal.addEventListener("abort", () => {
    controller.abort(parentSignal.reason || "user_stop");
  }, { once: true });
  return controller;
}

function createAbortError(reason = "aborted") {
  const error = new Error(toTrimmedString(reason) || "aborted");
  error.name = "AbortError";
  return error;
}

async function raceWithAbortSignal(promise, abortController = null) {
  const signal = abortController?.signal || null;
  if (!signal) return promise;
  if (signal.aborted) {
    throw createAbortError(signal.reason || "aborted");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
    };
    const handleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const handleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      handleReject(createAbortError(signal.reason || "aborted"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(promise).then(handleResolve, handleReject);
  });
}

export async function runProviderSessionTurn({
  adapter,
  message,
  options = {},
  timeoutMs,
  label,
  withTimeout,
}) {
  if (!adapter || typeof adapter.exec !== "function") {
    throw new Error("Provider adapter.exec is required");
  }
  if (typeof withTimeout !== "function") {
    throw new Error("withTimeout helper is required");
  }
  const timeoutAbort = createLinkedAbortController(options.abortController || null);
  const result = await withTimeout(
    adapter.exec(message, { ...options, abortController: timeoutAbort }),
    timeoutMs,
    label || `${adapter.name || "provider"}.exec`,
    timeoutAbort,
  );
  return {
    result,
    text: extractProviderResponseText(result),
    abortController: timeoutAbort,
  };
}

function resolveRegistry(options = {}) {
  if (options.providerRegistry && typeof options.providerRegistry.listProviders === "function") {
    return options.providerRegistry;
  }
  return createProviderRegistry({
    adapters: options.adapters || {},
    configExecutors: options.configExecutors || [],
    env: options.env,
    readBusy: options.readBusy,
    getAdapterCapabilities: options.getAdapterCapabilities,
    readAuthState: options.readAuthState,
  });
}

function resolveProviderRuntime(providerId, options = {}) {
  const registry = resolveRegistry(options);
  const selection = normalizeProviderSelection(
    registry.resolveSelection(providerId || options.provider || "")
      || { providerId: providerId || options.provider || null },
  );
  const provider = registry.getProvider(selection.selectionId || selection.providerId || providerId || options.provider)
    || registry.getDefaultProvider();
  const adapters = options.adapters && typeof options.adapters === "object"
    ? options.adapters
    : {};
  const adapter = provider?.adapterId ? adapters[provider.adapterId] || null : null;
  return {
    registry,
    provider,
    adapter,
  };
}

export function createProviderSession(providerId = null, options = {}) {
  const runtime = resolveProviderRuntime(providerId, options);
  const provider = runtime.provider?.providerId || providerId || options.provider || "unknown";
  const adapter = options.adapter || runtime.adapter;
  const initialSession = normalizeProviderSessionInput({
    providerId: provider,
    sessionId: options.sessionId,
    threadId: options.threadId,
    model: options.model || runtime.provider?.defaultModel || null,
    metadata: options.metadata || {},
  });
  let activeSessionId = initialSession.sessionId;
  let activeThreadId = initialSession.threadId;
  let activeModel = initialSession.model;
  let messageHistory = [];
  const emitSessionEvent = createEventEmitter([options.onEvent]);
  const runner =
    typeof options.runTurn === "function"
      ? options.runTurn
      : (typeof options.getProviderRunner === "function"
        ? options.getProviderRunner({
          providerId: provider,
          adapterId: runtime.provider?.adapterId || null,
          adapter,
          definition: runtime.provider?.definition || null,
        })
        : null);

  return {
    contractVersion: "bosun.provider-session.v1",
    provider,
    providerEntry: runtime.provider || null,
    adapter,
    options: { ...options, provider },
    async runTurn(message, turnOptions = {}) {
      if (typeof runner !== "function") {
        if (!adapter || typeof adapter.exec !== "function") {
          throw new ProviderConfigurationError(`Provider session "${provider}" is not configured`, {
            providerId: provider,
          });
        }
      }
      const inputPayload = buildProviderTurnPayload(message, {
        providerId: provider,
        model: turnOptions.model || activeModel || runtime.provider?.defaultModel || null,
        tools: resolveToolDefinitions(options, turnOptions, {
          cwd: turnOptions.cwd || options.cwd || null,
          repoRoot: turnOptions.repoRoot || options.repoRoot || turnOptions.cwd || options.cwd || null,
          agentProfileId: turnOptions.agentProfileId || options.agentProfileId || null,
        }),
        metadata: turnOptions.metadata || options.metadata,
        reasoningEffort: turnOptions.reasoningEffort || turnOptions.reasoning || options.reasoningEffort || options.reasoning,
        sessionId: turnOptions.sessionId || activeSessionId || options.sessionId,
        threadId: turnOptions.threadId || activeThreadId || options.threadId || options.sessionId,
      });
      const maxToolRounds = Math.max(0, Number(turnOptions.maxToolRounds ?? options.maxToolRounds ?? 8) || 0);
      const executeTool = resolveToolExecutor(options, turnOptions);
      const baseMessages = turnOptions.replaceHistory === true
        ? inputPayload.messages
        : [...messageHistory, ...inputPayload.messages];
      let workingMessages = baseMessages.map((entry) => cloneValue(entry));
      let aggregatedUsage = null;
      let aggregatedMessages = [];
      let aggregatedToolCalls = [];
      let aggregatedToolResults = [];
      let aggregatedReasoning = [];
      let finalNormalized = null;
      let lastPayload = {
        ...inputPayload,
        messages: workingMessages,
      };
      const turnAbortController = turnOptions.abortController || options.abortController || null;
      for (let round = 0; round <= maxToolRounds; round += 1) {
        const result = await raceWithAbortSignal(
          typeof runner === "function"
            ? runner(lastPayload, {
              ...options,
              ...turnOptions,
              provider,
              providerEntry: runtime.provider || null,
              adapter,
            })
            : adapter.exec(lastPayload, {
              ...options,
              ...turnOptions,
              provider,
              providerEntry: runtime.provider || null,
            }),
          turnAbortController,
        );
        const normalized = normalizeProviderResult(result, {
          providerId: provider,
          model: lastPayload.model,
          sessionId: lastPayload.sessionId,
          threadId: lastPayload.threadId,
        });
        finalNormalized = normalized;
        aggregatedUsage = sumUsage(aggregatedUsage, normalized.usage);
        aggregatedMessages.push(...buildAssistantMessagesFromResult(normalized, round));
        aggregatedToolCalls.push(...(Array.isArray(normalized.toolCalls) ? normalized.toolCalls.map((entry) => cloneValue(entry)) : []));
        aggregatedToolResults.push(...(Array.isArray(normalized.toolResults) ? normalized.toolResults.map((entry) => cloneValue(entry)) : []));
        aggregatedReasoning.push(...(Array.isArray(normalized.reasoning) ? normalized.reasoning.map((entry) => cloneValue(entry)) : []));

        if (!Array.isArray(normalized.toolCalls) || normalized.toolCalls.length === 0 || typeof executeTool !== "function") {
          workingMessages = [...workingMessages, ...buildAssistantMessagesFromResult(normalized, round)];
          break;
        }

        const toolExecutions = await executeProviderToolCalls(normalized.toolCalls, executeTool, {
          sessionId: normalized.sessionId || lastPayload.sessionId || activeSessionId,
          threadId: normalized.threadId || lastPayload.threadId || activeThreadId,
          providerId: provider,
          sessionManager: turnOptions.sessionManager || options.sessionManager || null,
          requestedBy: turnOptions.requestedBy || options.requestedBy || null,
          taskKey: turnOptions.taskKey || options.taskKey || null,
          cwd: turnOptions.cwd || options.cwd || null,
          repoRoot: turnOptions.repoRoot || options.repoRoot || turnOptions.cwd || options.cwd || null,
          runId: turnOptions.runId || options.runId || null,
          turnId: turnOptions.turnId || options.turnId || null,
          onEvent: turnOptions.onEvent || options.onEvent,
          approval: turnOptions.approval || options.approval || null,
          agentProfileId: turnOptions.agentProfileId || options.agentProfileId || null,
          subagentMaxParallel: turnOptions.subagentMaxParallel || options.subagentMaxParallel || null,
        }, emitSessionEvent);
        const toolResultMessages = buildToolResultMessages(normalized.toolCalls, toolExecutions, round);
        aggregatedToolResults.push(...toolResultMessages.flatMap((entry) => entry.content || []).map((entry, index) => ({
          id: entry.id || `provider-tool-result-entry-${round + 1}-${index + 1}`,
          type: "tool_result",
          toolCallId: entry.toolCallId,
          name: entry.name || null,
          output: cloneValue(entry.output),
          isError: entry.is_error === true,
          status: entry.status || null,
        })));
        workingMessages = [
          ...workingMessages,
          ...buildAssistantMessagesFromResult(normalized, round),
          ...toolResultMessages,
        ];
        lastPayload = buildProviderTurnPayload({
          providerId: provider,
          model: lastPayload.model,
          messages: workingMessages,
          metadata: lastPayload.metadata,
          tools: lastPayload.tools,
          reasoningEffort: lastPayload.reasoningEffort,
          sessionId: normalized.sessionId || lastPayload.sessionId,
          threadId: normalized.threadId || lastPayload.threadId,
        }, {
          providerId: provider,
          model: lastPayload.model,
        });
      }
      const normalized = finalNormalized || normalizeProviderResult({}, {
        providerId: provider,
        model: lastPayload.model,
        sessionId: lastPayload.sessionId,
        threadId: lastPayload.threadId,
      });
      const finalError = normalized.error || (normalized.success === false
        ? toTrimmedString(normalized.finalResponse || normalized.output || "provider_error") || "provider_error"
        : null);
      const finalSuccess = normalized.success !== false
        && !finalError
        && !["failed", "error"].includes(toTrimmedString(normalized.status).toLowerCase());
      const finalMessages = workingMessages.length > 0 ? workingMessages : buildAssistantMessagesFromResult(normalized, 0);
      messageHistory = buildCompactedContinuationHistory(finalMessages);
      activeModel = normalized.model || lastPayload.model || activeModel;
      activeSessionId = normalized.sessionId || lastPayload.sessionId || activeSessionId;
      activeThreadId = normalized.threadId || lastPayload.threadId || activeThreadId || activeSessionId;
      return {
        ...normalized,
        success: finalSuccess,
        items: aggregatedMessages.length > 0 ? aggregatedMessages : normalized.items,
        usage: aggregatedUsage || normalized.usage,
        toolCalls: aggregatedToolCalls.length > 0 ? aggregatedToolCalls : normalized.toolCalls,
        toolResults: aggregatedToolResults.length > 0 ? aggregatedToolResults : normalized.toolResults,
        reasoning: aggregatedReasoning.length > 0 ? aggregatedReasoning : normalized.reasoning,
        reasoningText:
          aggregatedReasoning.length > 0
            ? aggregatedReasoning.map((entry) => toTrimmedString(entry?.text || entry?.content || "")).filter(Boolean).join("\n")
            : normalized.reasoningText,
        error: finalError,
      };
    },
    normalizeStreamEvent(event, eventOptions = {}) {
      return normalizeProviderStreamEnvelope(event, {
        providerId: provider,
        sessionId: eventOptions.sessionId || activeSessionId || options.sessionId,
        threadId:
          eventOptions.threadId
          || activeThreadId
          || options.threadId
          || options.sessionId
          || activeSessionId,
        ...eventOptions,
      });
    },
    getState() {
      return normalizeProviderSessionState({
        providerId: provider,
        model: activeModel,
        sessionId: activeSessionId,
        threadId: activeThreadId,
        metadata: options.metadata || {},
      });
    },
  };
}

export default runProviderSessionTurn;
