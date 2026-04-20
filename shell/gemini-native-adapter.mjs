import { buildProviderTurnPayload } from "../agent/provider-message-transform.mjs";
import { retryFetch } from "./retry-fetch.mjs";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const _sessions = new Map();

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function trimTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return end === s.length ? s : s.slice(0, end);
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
  return buildProviderTurnPayload(input, {
    providerId: execOptions.provider || execOptions.providerConfig?.provider || "gemini-generate-content",
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
    || toTrimmedString(env.GEMINI_API_KEY)
    || toTrimmedString(env.GOOGLE_API_KEY)
    || "";
  return { apiKey };
}

function resolveBaseUrl(execOptions = {}) {
  const providerConfig = execOptions.providerConfig && typeof execOptions.providerConfig === "object"
    ? execOptions.providerConfig
    : {};
  const env = execOptions.env && typeof execOptions.env === "object"
    ? execOptions.env
    : process.env;
  return trimTrailingSlashes(
    toTrimmedString(providerConfig.baseUrl)
    || toTrimmedString(providerConfig.endpoint)
    || toTrimmedString(env.GEMINI_BASE_URL)
    || DEFAULT_BASE_URL
  );
}

function resolveEndpoint(execOptions = {}, model = "", apiKey = "") {
  const baseUrl = trimTrailingSlashes(resolveBaseUrl(execOptions));
  const normalizedModel = encodeURIComponent(toTrimmedString(model));
  const normalizedKey = encodeURIComponent(apiKey);
  return `${baseUrl}/models/${normalizedModel}:generateContent?key=${normalizedKey}`;
}

function normalizeToolDefinition(tool = {}) {
  const name = toTrimmedString(tool.name || tool.function?.name);
  if (!name) return null;
  return {
    name,
    description: toTrimmedString(tool.description || tool.function?.description) || undefined,
    parameters:
      (tool.parameters && typeof tool.parameters === "object")
        ? cloneJson(tool.parameters)
        : (tool.function?.parameters && typeof tool.function.parameters === "object")
          ? cloneJson(tool.function.parameters)
          : { type: "object", properties: {} },
  };
}

function toTextPart(text = "") {
  const normalized = toTrimmedString(text);
  return normalized ? { text: normalized } : null;
}

function toolResultToGeminiResponse(output) {
  if (typeof output === "string") {
    return { content: output };
  }
  if (isPlainObject(output) || Array.isArray(output)) {
    return cloneJson(output);
  }
  return { value: output };
}

function messageToGeminiParts(message = {}) {
  const parts = Array.isArray(message.content) ? message.content : [];
  const output = [];
  const fallbackText = toTrimmedString(message.text);
  for (const part of parts) {
    const type = toTrimmedString(part?.type).toLowerCase();
    if (type === "text") {
      const textPart = toTextPart(part.text || part.content);
      if (textPart) output.push(textPart);
      continue;
    }
    if (type === "reasoning" || type === "thinking") {
      const textPart = toTextPart(part.text || part.content || part.summary);
      if (textPart) output.push(textPart);
      continue;
    }
    if (type === "tool_call") {
      output.push({
        functionCall: {
          name: toTrimmedString(part.name || part.tool || "tool"),
          args: isPlainObject(part.input) || Array.isArray(part.input) ? cloneJson(part.input) : {},
        },
      });
      continue;
    }
    if (type === "tool_result") {
      output.push({
        functionResponse: {
          name: toTrimmedString(part.name || part.toolCallId || "tool"),
          response: toolResultToGeminiResponse(part.output),
        },
      });
    }
  }
  if (output.length === 0 && fallbackText) {
    const textPart = toTextPart(fallbackText);
    if (textPart) output.push(textPart);
  }
  return output;
}

function mergeGeminiContents(contents = []) {
  const merged = [];
  for (const entry of contents) {
    const role = toTrimmedString(entry?.role).toLowerCase();
    const parts = Array.isArray(entry?.parts) ? entry.parts.filter(Boolean) : [];
    if (!role || parts.length === 0) continue;
    const previous = merged.at(-1);
    if (previous?.role === role) {
      previous.parts.push(...parts);
      continue;
    }
    merged.push({
      role,
      parts: cloneJson(parts),
    });
  }
  return merged;
}

function buildGeminiRequest(payload, execOptions = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const systemParts = [];
  const contents = [];
  for (const message of messages) {
    const role = toTrimmedString(message?.role).toLowerCase();
    if (role === "system" || role === "developer") {
      const text = Array.isArray(message?.content)
        ? message.content
          .filter((entry) => ["text", "reasoning", "thinking"].includes(toTrimmedString(entry?.type).toLowerCase()))
          .map((entry) => toTrimmedString(entry?.text || entry?.content || entry?.summary))
          .filter(Boolean)
          .join("\n")
        : toTrimmedString(message?.text);
      if (text) systemParts.push({ text });
      continue;
    }
    const parts = messageToGeminiParts(message);
    if (parts.length === 0) continue;
    contents.push({
      role: role === "assistant" ? "model" : "user",
      parts,
    });
  }

  const functionDeclarations = (Array.isArray(payload.tools) ? payload.tools : [])
    .map((tool) => normalizeToolDefinition(tool))
    .filter(Boolean);

  return {
    systemInstruction: systemParts.length > 0 ? { role: "system", parts: systemParts } : undefined,
    contents: mergeGeminiContents(contents),
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens:
        Number.isFinite(Number(execOptions.providerConfig?.maxOutputTokens))
          ? Number(execOptions.providerConfig.maxOutputTokens)
          : DEFAULT_MAX_OUTPUT_TOKENS,
    },
  };
}

function extractCandidate(payload = {}) {
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
  return candidates[0] || null;
}

function extractGeminiText(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => toTrimmedString(part?.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractGeminiToolCalls(parts = []) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.functionCall && typeof part.functionCall === "object")
    .map((part, index) => ({
      id: `tool-call-${index + 1}`,
      type: "tool_call",
      name: toTrimmedString(part.functionCall?.name) || null,
      input: isPlainObject(part.functionCall?.args) || Array.isArray(part.functionCall?.args)
        ? cloneJson(part.functionCall.args)
        : {},
      status: "requested",
      originalType: "functionCall",
    }))
    .filter((entry) => entry.name);
}

function normalizeGeminiUsage(usage = {}) {
  const inputTokens = Number(usage?.promptTokenCount || usage?.input_tokens || usage?.inputTokens || 0);
  const outputTokens = Number(usage?.candidatesTokenCount || usage?.output_tokens || usage?.outputTokens || 0);
  const totalTokens = Number(usage?.totalTokenCount || usage?.total_tokens || inputTokens + outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheInputTokens: 0,
    raw: cloneJson(usage),
  };
}

async function parseErrorResponse(response) {
  const text = await response.text().catch(() => "unknown");
  try {
    const payload = JSON.parse(text);
    return (
      toTrimmedString(payload?.error?.message)
      || toTrimmedString(payload?.message)
      || toTrimmedString(text)
      || `Gemini request failed (${response.status})`
    );
  } catch {
    return toTrimmedString(text) || `Gemini request failed (${response.status})`;
  }
}

export const geminiNativeAdapter = {
  name: "gemini-native",
  provider: "GEMINI_NATIVE",
  displayName: "Gemini Native",
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
      || toTrimmedString(execOptions.providerConfig?.model)
      || "gemini-2.5-pro";
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
          finalResponse: ":close: Gemini API key is not configured.",
          items: [],
          usage: null,
          providerId: execOptions.provider || payload.providerId || "gemini-generate-content",
          model,
          sessionId: sessionId || null,
          threadId: threadId || null,
        };
      }

      const requestBody = buildGeminiRequest({ ...payload, model }, execOptions);
      const response = await retryFetch(resolveEndpoint(execOptions, model, apiKey), {
        method: "POST",
        headers: {
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
          finalResponse: `:close: Gemini request failed (${response.status}): ${message}`,
          items: [],
          usage: null,
          providerId: execOptions.provider || payload.providerId || "gemini-generate-content",
          model,
          sessionId: sessionId || null,
          threadId: threadId || null,
        };
      }

      const responsePayload = await response.json();
      const candidate = extractCandidate(responsePayload);
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const finalResponse = extractGeminiText(parts) || "(Agent completed with no text output)";
      const assistantMessage = {
        role: "assistant",
        content: [
          ...(finalResponse ? [{ type: "text", text: finalResponse }] : []),
          ...extractGeminiToolCalls(parts),
        ],
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
        usage: normalizeGeminiUsage(responsePayload?.usageMetadata || responsePayload?.usage || {}),
        providerId: execOptions.provider || payload.providerId || "gemini-generate-content",
        model,
        sessionId: sessionId || null,
        threadId: threadId || null,
        finishReason: toTrimmedString(candidate?.finishReason || responsePayload?.finishReason) || null,
        status: "completed",
      };
    } finally {
      record.busy = false;
      record.updatedAt = new Date().toISOString();
    }
  },
};

export default geminiNativeAdapter;
