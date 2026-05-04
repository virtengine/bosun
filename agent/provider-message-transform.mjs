import { normalizeProviderErrorDetails } from "./providers/provider-errors.mjs";
import { normalizeProviderUsageMetadata } from "./providers/provider-usage-normalizer.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeRole(role, fallback = "user") {
  const normalized = toTrimmedString(role).toLowerCase();
  if (["system", "user", "assistant", "tool", "developer"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function inferMessageRole(base, fallbackRole = "user") {
  const explicitRole = normalizeRole(
    base?.role || base?.message?.role || base?.data?.role,
    fallbackRole,
  );
  if (explicitRole !== normalizeRole(fallbackRole, "user")) {
    return explicitRole;
  }
  const type = toTrimmedString(base?.type || base?.message?.type || "").toLowerCase();
  if (type.startsWith("assistant")) return "assistant";
  if (type.startsWith("user")) return "user";
  if (type.startsWith("system")) return "system";
  if (type.startsWith("developer")) return "developer";
  if (type.startsWith("tool")) return "tool";
  return explicitRole;
}

function normalizeToolCallInput(value) {
  if (value == null) return {};
  if (typeof value === "string") {
    const trimmed = toTrimmedString(value);
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return { text: trimmed };
    }
  }
  if (Array.isArray(value) || isPlainObject(value)) {
    return cloneJson(value);
  }
  return { value };
}

function normalizeReasoningBlock(value, index = 0) {
  if (typeof value === "string") {
    const text = toTrimmedString(value);
    if (!text) return null;
    return {
      id: `reasoning-${index + 1}`,
      type: "reasoning",
      text,
      originalType: "text",
    };
  }
  if (!isPlainObject(value)) return null;
  const text = toTrimmedString(
    value.text
      ?? value.content
      ?? value.summary
      ?? value.message,
  );
  if (!text) return null;
  return {
    id: toTrimmedString(value.id) || `reasoning-${index + 1}`,
    type: "reasoning",
    text,
    originalType: toTrimmedString(value.type) || "reasoning",
  };
}

function isToolCallLikeEntry(entry) {
  const type = toTrimmedString(entry?.type).toLowerCase();
  if (["tool_call", "function_call", "tool_use", "mcp_tool_call", "command_execution", "web_search"].includes(type)) {
    return true;
  }
  return !!(
    entry
    && (
      entry.tool_use_id
      || entry.toolUseId
      || entry.tool_call_id
      || entry.toolCallId
      || entry.call_id
      || entry.function_call
      || entry.name
      || entry.tool_name
      || entry.toolName
      || entry.tool
    )
    && (entry.input != null || entry.arguments != null || entry.args != null || type === "command_execution")
  );
}

function normalizeToolCallEntry(value, index = 0) {
  if (!isPlainObject(value) || !isToolCallLikeEntry(value)) return null;
  const originalType = toTrimmedString(value.type).toLowerCase();
  const server = toTrimmedString(value.server || value.mcpServer || value.server_name) || null;
  const tool = toTrimmedString(value.tool || value.mcpTool || value.tool_name || value.toolName) || null;
  const name =
    toTrimmedString(
      value.name
        || value.tool_name
        || value.toolName
        || value.function_name
        || (server && tool ? `mcp__${server}__${tool}` : "")
        || (originalType === "web_search" ? "WebSearch" : "")
        || (originalType === "command_execution" ? "command_execution" : ""),
    ) || null;
  if (!name) return null;
  return {
    id: toTrimmedString(
      value.id
        || value.tool_use_id
        || value.toolUseId
        || value.tool_call_id
        || value.toolCallId
        || value.call_id,
    ) || `tool-call-${index + 1}`,
    type: "tool_call",
    name,
    server,
    tool,
    input: normalizeToolCallInput(
      value.input
        ?? value.arguments
        ?? value.args
        ?? value.parameters
        ?? (originalType === "web_search" ? { query: value.query || "" } : undefined)
        ?? (originalType === "command_execution" ? { command: value.command || "" } : undefined),
    ),
    status: toTrimmedString(value.status || value.state || "") || null,
    originalType: originalType || null,
  };
}

function isToolResultLikeEntry(entry) {
  const type = toTrimmedString(entry?.type).toLowerCase();
  if (["tool_result", "function_result", "tool_output"].includes(type)) return true;
  return !!(
    entry
    && (
      entry.tool_call_id
      || entry.toolCallId
      || entry.tool_use_id
      || entry.toolUseId
      || entry.result
      || entry.output
      || entry.content
    )
    && (type.includes("result") || type.includes("output") || entry.is_error != null)
  );
}

function normalizeToolResultEntry(value, index = 0) {
  if (!isPlainObject(value) || !isToolResultLikeEntry(value)) return null;
  const originalType = toTrimmedString(value.type).toLowerCase();
  const output = cloneJson(
    value.output
      ?? value.result
      ?? value.content
      ?? value.value
      ?? "",
  );
  return {
    id: toTrimmedString(value.id) || `tool-result-${index + 1}`,
    type: "tool_result",
    toolCallId: toTrimmedString(
      value.tool_call_id
        || value.toolCallId
        || value.tool_use_id
        || value.toolUseId,
    ) || null,
    name: toTrimmedString(value.name || value.tool_name || value.toolName || value.tool || "") || null,
    output,
    isError: value.is_error === true || value.error === true,
    status: toTrimmedString(value.status || value.state || "") || null,
    originalType: originalType || null,
  };
}

function normalizeContentPart(entry, index = 0) {
  if (typeof entry === "string") {
    return { type: "text", text: entry };
  }
  if (!isPlainObject(entry)) return null;
  const type = toTrimmedString(entry.type).toLowerCase();
  if (type === "input_text" || type === "output_text" || type === "text") {
    return { type: "text", text: toTrimmedString(entry.text || entry.content) };
  }
  if (type === "reasoning" || type === "thinking") {
    return normalizeReasoningBlock(entry, index);
  }
  const toolCall = normalizeToolCallEntry(entry, index);
  if (toolCall) return toolCall;
  const toolResult = normalizeToolResultEntry(entry, index);
  if (toolResult) return toolResult;
  return cloneJson(entry);
}

function normalizeContentParts(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry, index) => normalizeContentPart(entry, index)).filter(Boolean);
}

function extractTextFromParts(parts = []) {
  const text = parts
    .filter((entry) => entry?.type === "text")
    .map((entry) => toTrimmedString(entry.text))
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  return parts
    .filter((entry) => entry?.type === "reasoning")
    .map((entry) => toTrimmedString(entry.text))
    .filter(Boolean)
    .join("\n");
}

function collectToolCalls(parts = []) {
  return parts
    .filter((entry) => entry?.type === "tool_call")
    .map((entry) => ({
      ...entry,
      input: cloneJson(entry.input),
    }));
}

function collectToolResults(parts = []) {
  return parts
    .filter((entry) => entry?.type === "tool_result")
    .map((entry) => ({
      ...entry,
      output: cloneJson(entry.output),
    }));
}

function collectReasoning(parts = []) {
  return parts
    .filter((entry) => entry?.type === "reasoning")
    .map((entry) => ({ ...entry }));
}

function resolveMessageContentSource(base = {}) {
  const baseType = toTrimmedString(base.type).toLowerCase();
  if ([
    "reasoning",
    "thinking",
    "tool_use",
    "tool_call",
    "function_call",
    "tool_result",
    "function_result",
    "tool_output",
    "mcp_tool_call",
    "command_execution",
    "web_search",
  ].includes(baseType)) {
    return base;
  }
  const candidates = [
    base.content,
    base.parts,
    base.message?.content,
    base.data?.content,
    base.data?.deltaContent,
    base.data?.text,
    base.item?.content,
    base.item?.text,
    base.text,
    base.output_text,
    base.input_text,
  ];
  for (const candidate of candidates) {
    if (candidate != null && candidate !== "") return candidate;
  }

  const supplementalParts = [];
  const toolCalls = Array.isArray(base.toolCalls) ? base.toolCalls : base.tool_calls;
  const toolResults = Array.isArray(base.toolResults) ? base.toolResults : base.tool_results;
  const reasoning = Array.isArray(base.reasoning) ? base.reasoning : (base.reasoning ? [base.reasoning] : []);
  if (Array.isArray(toolCalls)) supplementalParts.push(...toolCalls.map((entry) => ({ ...entry, type: entry?.type || "tool_call" })));
  if (Array.isArray(toolResults)) supplementalParts.push(...toolResults.map((entry) => ({ ...entry, type: entry?.type || "tool_result" })));
  if (reasoning.length > 0) supplementalParts.push(...reasoning.map((entry) => (typeof entry === "string" ? { type: "reasoning", text: entry } : entry)));
  return supplementalParts.length > 0 ? supplementalParts : "";
}

function normalizeTextContent(value) {
  const parts = normalizeContentParts(value);
  return {
    text: extractTextFromParts(parts),
    parts,
    toolCalls: collectToolCalls(parts),
    toolResults: collectToolResults(parts),
    reasoning: collectReasoning(parts),
  };
}

function normalizeMessageEntry(message, index = 0, fallbackRole = "user") {
  const base = message && typeof message === "object"
    ? message
    : { role: fallbackRole, content: message };
  const role = inferMessageRole(base, fallbackRole);
  const content = normalizeTextContent(resolveMessageContentSource(base));
  const metadataSource = base.metadata || base.data || base.item || {};
  return {
    id: toTrimmedString(base.id || base.message?.id || base.data?.id) || `msg-${index + 1}`,
    role,
    text: content.text,
    content: content.parts,
    toolCalls: content.toolCalls,
    toolResults: content.toolResults,
    reasoning: content.reasoning,
    _compressed: toTrimmedString(base._compressed) || null,
    _originalLength: Number.isFinite(Number(base._originalLength))
      ? Number(base._originalLength)
      : null,
    _cachedLogId: base._cachedLogId ?? null,
    _contextEnvelope: isPlainObject(base._contextEnvelope) ? cloneJson(base._contextEnvelope) : null,
    _liveCompactionFamily: toTrimmedString(base._liveCompactionFamily) || null,
    _commandDiagnostics: isPlainObject(base._commandDiagnostics) ? cloneJson(base._commandDiagnostics) : null,
    _semanticBudgetPolicy: toTrimmedString(base._semanticBudgetPolicy) || null,
    metadata:
      (metadataSource && typeof metadataSource === "object")
        ? cloneJson(metadataSource)
        : {},
  };
}

export function normalizeProviderMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  const fallbackRole = normalizeRole(options.fallbackRole, "user");
  return list
    .map((entry, index) => normalizeMessageEntry(entry, index, fallbackRole))
    .filter((entry) => entry.text || entry.content.length > 0);
}

export function buildProviderTurnPayload(input, options = {}) {
  if (Array.isArray(input)) {
    const messages = normalizeProviderMessages(input, options);
    return {
      providerId: toTrimmedString(options.providerId) || null,
      model: toTrimmedString(options.model) || null,
      prompt: messages.at(-1)?.text || "",
      messages,
      metadata: options.metadata && typeof options.metadata === "object" ? cloneJson(options.metadata) : {},
      tools: Array.isArray(options.tools) ? cloneJson(options.tools) : [],
      reasoningEffort: toTrimmedString(options.reasoningEffort) || null,
      sessionId: toTrimmedString(options.sessionId) || null,
      threadId: toTrimmedString(options.threadId || options.sessionId) || null,
    };
  }

  if (input && typeof input === "object") {
    const messages = normalizeProviderMessages(
      input.messages || input.history || input.items || input.prompt || "",
      { fallbackRole: input.role || options.fallbackRole || "user" },
    );
    return {
      providerId: toTrimmedString(input.providerId || options.providerId) || null,
      model: toTrimmedString(input.model || options.model) || null,
      prompt: toTrimmedString(input.prompt) || messages.at(-1)?.text || "",
      messages,
      metadata: input.metadata && typeof input.metadata === "object"
        ? cloneJson(input.metadata)
        : (options.metadata && typeof options.metadata === "object" ? cloneJson(options.metadata) : {}),
      tools: Array.isArray(input.tools)
        ? cloneJson(input.tools)
        : (Array.isArray(options.tools) ? cloneJson(options.tools) : []),
      reasoningEffort: toTrimmedString(input.reasoningEffort || options.reasoningEffort) || null,
      sessionId: toTrimmedString(input.sessionId || options.sessionId) || null,
      threadId: toTrimmedString(input.threadId || options.threadId || input.sessionId || options.sessionId) || null,
    };
  }

  const messages = normalizeProviderMessages([{ role: options.fallbackRole || "user", content: input }], options);
  return {
    providerId: toTrimmedString(options.providerId) || null,
    model: toTrimmedString(options.model) || null,
    prompt: messages.at(-1)?.text || "",
    messages,
    metadata: options.metadata && typeof options.metadata === "object" ? cloneJson(options.metadata) : {},
    tools: Array.isArray(options.tools) ? cloneJson(options.tools) : [],
    reasoningEffort: toTrimmedString(options.reasoningEffort) || null,
    sessionId: toTrimmedString(options.sessionId) || null,
    threadId: toTrimmedString(options.threadId || options.sessionId) || null,
  };
}

export function normalizeProviderUsage(usage = {}) {
  return normalizeProviderUsageMetadata(usage);
}

function normalizeProviderError(error, fallback = null) {
  if (!error && (fallback == null || fallback === "")) return null;
  return normalizeProviderErrorDetails(error, { message: fallback }).message || fallback;
}

function uniqueEntries(entries = [], keyFn = (entry) => entry?.id || JSON.stringify(entry)) {
  const seen = new Set();
  const output = [];
  for (const entry of entries) {
    if (!entry) continue;
    const key = keyFn(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function normalizeRootToolCalls(result = {}) {
  const sources = [
    ...(Array.isArray(result.toolCalls) ? result.toolCalls : []),
    ...(Array.isArray(result.tool_calls) ? result.tool_calls : []),
    ...(Array.isArray(result.calls) ? result.calls : []),
  ];
  return uniqueEntries(
    sources.map((entry, index) => normalizeToolCallEntry(entry, index)).filter(Boolean),
    (entry) => entry.id || `${entry.name}:${JSON.stringify(entry.input || {})}`,
  );
}

function normalizeRootToolResults(result = {}) {
  const sources = [
    ...(Array.isArray(result.toolResults) ? result.toolResults : []),
    ...(Array.isArray(result.tool_results) ? result.tool_results : []),
    ...(Array.isArray(result.results) ? result.results : []),
  ];
  return uniqueEntries(
    sources.map((entry, index) => normalizeToolResultEntry(entry, index)).filter(Boolean),
    (entry) => entry.id || `${entry.toolCallId}:${JSON.stringify(entry.output ?? {})}`,
  );
}

function normalizeRootReasoning(result = {}) {
  const source = result.reasoningBlocks || result.reasoning || result.thinking || [];
  const list = Array.isArray(source) ? source : [source];
  return uniqueEntries(
    list.map((entry, index) => normalizeReasoningBlock(entry, index)).filter(Boolean),
    (entry) => entry.id || entry.text,
  );
}

export function normalizeProviderStreamEvent(event = {}, options = {}) {
  const eventType = toTrimmedString(
    event.type
      || event.event
      || event.kind
      || options.defaultType
      || "message_update",
  );
  const messageSource =
    event.message
    || event.delta
    || event.item
    || {
      role: event.role || options.role || "assistant",
      content: event.text || event.content || "",
    };
  const message = normalizeMessageEntry(messageSource, 0, event.role || options.role || "assistant");
  const toolCall = normalizeToolCallEntry(
    event.toolCall
      || event.tool_call
      || event.item
      || null,
    0,
  );
  const toolResult = normalizeToolResultEntry(
    event.toolResult
      || event.tool_result
      || event.item
      || null,
    0,
  );
  const reasoning = uniqueEntries(
    [
      ...collectReasoning(message.content),
      ...normalizeRootReasoning(event),
    ],
    (entry) => `${entry.id || ""}:${entry.text || ""}`,
  );
  return {
    type: eventType,
    providerId: toTrimmedString(event.providerId || options.providerId) || null,
    sessionId: toTrimmedString(event.sessionId || options.sessionId) || null,
    threadId: toTrimmedString(event.threadId || options.threadId || event.sessionId) || null,
    message,
    usage: normalizeProviderUsage(event.usage),
    toolCall,
    toolResult,
    reasoning,
    reasoningText: reasoning.map((entry) => entry.text).filter(Boolean).join("\n") || null,
    finishReason: toTrimmedString(
      event.finishReason
        || event.finish_reason
        || event.item?.finishReason
        || event.item?.finish_reason,
    ) || null,
    status: toTrimmedString(event.status || event.item?.status || "") || null,
    error: normalizeProviderError(event.error, normalizeProviderError(event.item?.error)),
    raw: cloneJson(event),
  };
}

export function normalizeProviderResultPayload(result, options = {}) {
  let messages = normalizeProviderMessages(
    result?.messages
      || result?.items
      || result?.content
      || result?.output
      || [],
    { fallbackRole: options.role || "assistant" },
  );
  const text = toTrimmedString(
    result?.finalResponse
      || result?.text
      || result?.message
      || messages.at(-1)?.text
      || "",
  );
  if (messages.length === 0 && text) {
    messages = normalizeProviderMessages([{ role: options.role || "assistant", content: text }], {
      fallbackRole: options.role || "assistant",
    });
  }
  const messageToolCalls = messages.flatMap((entry) => entry.toolCalls || []);
  const messageToolResults = messages.flatMap((entry) => entry.toolResults || []);
  const messageReasoning = messages.flatMap((entry) => entry.reasoning || []);
  const toolCalls = uniqueEntries(
    [
      ...messageToolCalls,
      ...normalizeRootToolCalls(result || {}),
    ],
    (entry) => entry.id || `${entry.name}:${JSON.stringify(entry.input || {})}`,
  );
  const toolResults = uniqueEntries(
    [
      ...messageToolResults,
      ...normalizeRootToolResults(result || {}),
    ],
    (entry) => entry.id || `${entry.toolCallId}:${JSON.stringify(entry.output ?? {})}`,
  );
  const reasoning = uniqueEntries(
    [
      ...messageReasoning,
      ...normalizeRootReasoning(result || {}),
    ],
    (entry) => `${entry.id || ""}:${entry.text || ""}`,
  );
  return {
    text,
    messages,
    usage: normalizeProviderUsage(result?.usage),
    providerId: toTrimmedString(result?.providerId || options.providerId) || null,
    model: toTrimmedString(result?.model || options.model) || null,
    sessionId: toTrimmedString(result?.sessionId || options.sessionId) || null,
    threadId: toTrimmedString(result?.threadId || options.threadId || result?.sessionId) || null,
    toolCalls,
    toolResults,
    reasoning,
    reasoningText: reasoning.map((entry) => entry.text).filter(Boolean).join("\n") || null,
    finishReason: toTrimmedString(result?.finishReason || result?.finish_reason) || null,
    status: toTrimmedString(result?.status || "") || null,
    error: normalizeProviderError(result?.error, result?.success === false ? text || "provider_error" : null),
  };
}

export default normalizeProviderResultPayload;
