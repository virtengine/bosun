import { buildProviderTurnPayload } from "../agent/provider-message-transform.mjs";
import { retryFetch } from "./retry-fetch.mjs";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";

const _sessions = new Map();

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

function getSessionRecord(sessionId = "", model = "") {
  const normalizedSessionId = toTrimmedString(sessionId);
  if (!normalizedSessionId) {
    return {
      id: null,
      busy: false,
      model: toTrimmedString(model),
      messages: [],
      updatedAt: null,
    };
  }
  if (!_sessions.has(normalizedSessionId)) {
    _sessions.set(normalizedSessionId, {
      id: normalizedSessionId,
      busy: false,
      model: toTrimmedString(model),
      messages: [],
      updatedAt: null,
    });
  }
  return _sessions.get(normalizedSessionId);
}

function resolvePayload(input, execOptions = {}) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return buildProviderTurnPayload(input, {
      providerId: execOptions.provider || execOptions.providerConfig?.provider || "anthropic-messages",
      model: execOptions.model || execOptions.providerConfig?.model || null,
      sessionId: execOptions.sessionId || null,
      threadId: execOptions.threadId || execOptions.sessionId || null,
      metadata: execOptions.metadata || {},
      tools: Array.isArray(execOptions.tools) ? execOptions.tools : [],
      reasoningEffort: execOptions.reasoningEffort || null,
    });
  }
  return buildProviderTurnPayload(input, {
    providerId: execOptions.provider || execOptions.providerConfig?.provider || "anthropic-messages",
    model: execOptions.model || execOptions.providerConfig?.model || null,
    sessionId: execOptions.sessionId || null,
    threadId: execOptions.threadId || execOptions.sessionId || null,
    metadata: execOptions.metadata || {},
    tools: Array.isArray(execOptions.tools) ? execOptions.tools : [],
    reasoningEffort: execOptions.reasoningEffort || null,
  });
}

function resolveCredentials(execOptions = {}) {
  const providerConfig = execOptions.providerConfig && typeof execOptions.providerConfig === "object"
    ? execOptions.providerConfig
    : {};
  const env = execOptions.env && typeof execOptions.env === "object"
    ? execOptions.env
    : process.env;
  const apiKey =
    toTrimmedString(providerConfig.apiKey)
    || toTrimmedString(env.ANTHROPIC_API_KEY)
    || "";
  return { apiKey };
}

function resolveEndpoint(execOptions = {}) {
  const providerConfig = execOptions.providerConfig && typeof execOptions.providerConfig === "object"
    ? execOptions.providerConfig
    : {};
  const raw =
    toTrimmedString(providerConfig.endpoint)
    || toTrimmedString(providerConfig.baseUrl)
    || DEFAULT_ENDPOINT;
  if (/\/v1\/messages\/?$/i.test(raw)) return raw.replace(/\/+$/, "");
  if (/\/v1\/?$/i.test(raw)) return `${raw.replace(/\/+$/, "")}/messages`;
  return `${raw.replace(/\/+$/, "")}/v1/messages`;
}

function stringifyStructuredValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function sanitizeTextContent(value) {
  return toTrimmedString(value);
}

function toAnthropicToolDefinition(tool = {}) {
  const name = toTrimmedString(tool.name || tool.function?.name);
  if (!name) return null;
  return {
    name,
    description: toTrimmedString(tool.description || tool.function?.description) || undefined,
    input_schema:
      (tool.parameters && typeof tool.parameters === "object")
        ? cloneJson(tool.parameters)
        : (tool.function?.parameters && typeof tool.function.parameters === "object")
          ? cloneJson(tool.function.parameters)
          : { type: "object", properties: {} },
  };
}

function toTextBlock(text = "") {
  const normalized = sanitizeTextContent(text);
  return normalized ? { type: "text", text: normalized } : null;
}

function normalizeToolResultContent(output) {
  if (Array.isArray(output)) {
    return output
      .map((entry) => toTextBlock(typeof entry === "string" ? entry : stringifyStructuredValue(entry)))
      .filter(Boolean);
  }
  if (typeof output === "string") {
    const textBlock = toTextBlock(output);
    return textBlock ? [textBlock] : [];
  }
  const textBlock = toTextBlock(stringifyStructuredValue(output));
  return textBlock ? [textBlock] : [];
}

function toAnthropicBlocks(message = {}) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const blocks = [];
  const fallbackText = toTrimmedString(message.text);
  for (const part of parts) {
    const type = toTrimmedString(part?.type).toLowerCase();
    if (type === "text") {
      const block = toTextBlock(part.text || part.content);
      if (block) blocks.push(block);
      continue;
    }
    if (type === "reasoning" || type === "thinking") {
      const block = toTextBlock(part.text || part.content || part.summary);
      if (block) blocks.push(block);
      continue;
    }
    if (type === "tool_call") {
      blocks.push({
        type: "tool_use",
        id: toTrimmedString(part.id) || `tool-use-${blocks.length + 1}`,
        name: toTrimmedString(part.name || part.tool || "tool"),
        input: isPlainObject(part.input) || Array.isArray(part.input) ? cloneJson(part.input) : {},
      });
      continue;
    }
    if (type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: toTrimmedString(part.toolCallId || part.id),
        is_error: part.is_error === true || part.isError === true,
        content: normalizeToolResultContent(part.output),
      });
      continue;
    }
  }
  if (blocks.length === 0 && fallbackText) {
    const block = toTextBlock(fallbackText);
    if (block) blocks.push(block);
  }
  return blocks;
}

function mergeAnthropicMessages(messages = []) {
  const merged = [];
  for (const entry of messages) {
    if (!entry || !Array.isArray(entry.content) || entry.content.length === 0) continue;
    const role = toTrimmedString(entry.role).toLowerCase();
    if (!["user", "assistant"].includes(role)) continue;
    const previous = merged.at(-1);
    if (previous?.role === role) {
      previous.content.push(...entry.content);
      continue;
    }
    merged.push({
      role,
      content: cloneJson(entry.content),
    });
  }
  return merged;
}

function buildAnthropicRequest(payload, execOptions = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = [];
  const conversation = [];
  for (const message of messages) {
    const role = toTrimmedString(message?.role).toLowerCase();
    if (role === "system" || role === "developer") {
      const text = Array.isArray(message?.content)
        ? message.content
          .filter((entry) => ["text", "reasoning", "thinking"].includes(toTrimmedString(entry?.type).toLowerCase()))
          .map((entry) => sanitizeTextContent(entry?.text || entry?.content || entry?.summary))
          .filter(Boolean)
          .join("\n")
        : sanitizeTextContent(message?.text);
      if (text) systemParts.push({ type: "text", text });
      continue;
    }

    if (role === "tool") {
      const toolBlocks = toAnthropicBlocks({
        ...message,
        role: "user",
      }).filter((entry) => entry?.type === "tool_result");
      if (toolBlocks.length > 0) {
        conversation.push({ role: "user", content: toolBlocks });
      }
      continue;
    }

    const mappedRole = role === "assistant" ? "assistant" : "user";
    const blocks = toAnthropicBlocks(message);
    if (blocks.length === 0) continue;
    conversation.push({ role: mappedRole, content: blocks });
  }

  const toolDefinitions = (Array.isArray(payload.tools) ? payload.tools : [])
    .map((tool) => toAnthropicToolDefinition(tool))
    .filter(Boolean);

  return {
    model:
      toTrimmedString(payload.model)
      || toTrimmedString(execOptions.model)
      || toTrimmedString(execOptions.providerConfig?.model)
      || "claude-sonnet-4",
    max_tokens:
      Number.isFinite(Number(execOptions.providerConfig?.maxTokens))
        ? Number(execOptions.providerConfig.maxTokens)
        : DEFAULT_MAX_TOKENS,
    system: systemParts.length > 0 ? systemParts : undefined,
    messages: mergeAnthropicMessages(conversation),
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
  };
}

function extractAnthropicText(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => toTrimmedString(part?.type).toLowerCase() === "text")
    .map((part) => sanitizeTextContent(part?.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractAnthropicReasoning(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => ["thinking", "reasoning"].includes(toTrimmedString(part?.type).toLowerCase()))
    .map((part, index) => ({
      id: toTrimmedString(part?.id) || `reasoning-${index + 1}`,
      type: "reasoning",
      text: sanitizeTextContent(part?.thinking || part?.text || part?.summary),
      originalType: toTrimmedString(part?.type) || "thinking",
    }))
    .filter((entry) => entry.text);
}

function extractAnthropicToolCalls(content = []) {
  return (Array.isArray(content) ? content : [])
    .filter((part) => toTrimmedString(part?.type).toLowerCase() === "tool_use")
    .map((part, index) => ({
      id: toTrimmedString(part?.id) || `tool-call-${index + 1}`,
      type: "tool_call",
      name: toTrimmedString(part?.name) || null,
      input: isPlainObject(part?.input) || Array.isArray(part?.input) ? cloneJson(part.input) : {},
      status: "requested",
      originalType: "tool_use",
    }))
    .filter((entry) => entry.name);
}

function normalizeAnthropicUsage(usage = {}) {
  const inputTokens = Number(usage?.input_tokens || usage?.inputTokens || 0);
  const outputTokens = Number(usage?.output_tokens || usage?.outputTokens || 0);
  const cacheCreationTokens = Number(
    usage?.cache_creation_input_tokens
    || usage?.cacheCreationInputTokens
    || 0,
  );
  const cacheReadTokens = Number(
    usage?.cache_read_input_tokens
    || usage?.cacheReadInputTokens
    || 0,
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheInputTokens: cacheCreationTokens + cacheReadTokens,
    raw: cloneJson(usage),
  };
}

async function parseErrorResponse(response) {
  const text = await response.text().catch(() => "unknown");
  try {
    const payload = JSON.parse(text);
    const message = toTrimmedString(
      payload?.error?.message
      || payload?.message
      || text,
    );
    return message || `Anthropic request failed (${response.status})`;
  } catch {
    return toTrimmedString(text) || `Anthropic request failed (${response.status})`;
  }
}

function buildAssistantItems(content = [], text = "") {
  const output = [];
  if (text) {
    output.push({ type: "text", text });
  }
  output.push(...extractAnthropicReasoning(content));
  output.push(...extractAnthropicToolCalls(content));
  return output;
}

export const anthropicNativeAdapter = {
  name: "anthropic-native",
  provider: "ANTHROPIC_NATIVE",
  displayName: "Anthropic Native",
  acceptsTurnPayload: true,
  async init() {
    return true;
  },
  isBusy(sessionId = null) {
    const record = getSessionRecord(sessionId);
    return record.busy === true;
  },
  getInfo(sessionId = null) {
    const record = getSessionRecord(sessionId);
    return {
      sessionId: record.id,
      isBusy: record.busy === true,
      model: record.model || null,
      updatedAt: record.updatedAt || null,
      messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
    };
  },
  listSessions() {
    return Array.from(_sessions.values()).map((entry) => ({
      sessionId: entry.id,
      isBusy: entry.busy === true,
      model: entry.model || null,
      updatedAt: entry.updatedAt || null,
      messageCount: Array.isArray(entry.messages) ? entry.messages.length : 0,
    }));
  },
  getSessionMessages(sessionId = null) {
    return cloneJson(getSessionRecord(sessionId).messages || []);
  },
  reset(options = {}) {
    const sessionId = toTrimmedString(options?.sessionId);
    if (sessionId) {
      _sessions.delete(sessionId);
      return;
    }
    _sessions.clear();
  },
  async exec(input, execOptions = {}) {
    const payload = resolvePayload(input, execOptions);
    const sessionId = toTrimmedString(payload.sessionId || execOptions.sessionId || "");
    const threadId = toTrimmedString(payload.threadId || execOptions.threadId || sessionId);
    const model =
      toTrimmedString(payload.model)
      || toTrimmedString(execOptions.model)
      || toTrimmedString(execOptions.providerConfig?.model);
    const record = getSessionRecord(sessionId, model);
    record.busy = true;
    record.model = model;
    record.messages = cloneJson(payload.messages || []);
    record.updatedAt = new Date().toISOString();

    try {
      const { apiKey } = resolveCredentials(execOptions);
      if (!apiKey) {
        return {
          success: false,
          finalResponse: ":close: Anthropic API key is not configured.",
          items: [],
          usage: null,
          providerId: execOptions.provider || payload.providerId || "anthropic-messages",
          model,
          sessionId: sessionId || null,
          threadId: threadId || null,
        };
      }

      const requestBody = buildAnthropicRequest(payload, execOptions);
      const response = await retryFetch(resolveEndpoint(execOptions), {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: execOptions.abortController?.signal || execOptions.signal,
      }, {
        maxRetries: 2,
        signal: execOptions.abortController?.signal || execOptions.signal,
      });

      if (!response.ok) {
        const message = await parseErrorResponse(response);
        return {
          success: false,
          finalResponse: `:close: Anthropic request failed (${response.status}): ${message}`,
          items: [],
          usage: null,
          providerId: execOptions.provider || payload.providerId || "anthropic-messages",
          model: requestBody.model,
          sessionId: sessionId || null,
          threadId: threadId || null,
        };
      }

      const responsePayload = await response.json();
      const content = Array.isArray(responsePayload?.content) ? responsePayload.content : [];
      const finalResponse = extractAnthropicText(content) || "(Agent completed with no text output)";
      const assistantMessage = {
        role: "assistant",
        content: buildAssistantItems(content, extractAnthropicText(content)),
      };
      record.messages = [
        ...cloneJson(payload.messages || []),
        assistantMessage,
      ];
      record.updatedAt = new Date().toISOString();
      return {
        success: true,
        finalResponse,
        items: [assistantMessage],
        usage: normalizeAnthropicUsage(responsePayload?.usage || {}),
        providerId: execOptions.provider || payload.providerId || "anthropic-messages",
        model: toTrimmedString(responsePayload?.model) || requestBody.model,
        sessionId: sessionId || null,
        threadId: threadId || null,
        finishReason: toTrimmedString(responsePayload?.stop_reason || responsePayload?.stopReason) || null,
        status: "completed",
      };
    } finally {
      record.busy = false;
      record.updatedAt = new Date().toISOString();
    }
  },
};

export default anthropicNativeAdapter;
