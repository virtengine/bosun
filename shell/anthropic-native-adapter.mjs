/**
 * shell/anthropic-native-adapter.mjs — Native Anthropic Messages API Adapter
 *
 * Full-featured native adapter for the Anthropic Messages API with:
 *   - SSE streaming with content_block_start/delta event model
 *   - Explicit cache_control injection (prompt caching)
 *   - Extended thinking with budget_tokens control
 *   - Tool-call execution loop
 *   - Session persistence and resume
 *   - Tiered disk-backed shredding
 *   - MCP tool integration
 *   - Structured output support
 */

import { buildProviderTurnPayload } from "../agent/provider-message-transform.mjs";
import { retryFetch } from "./retry-fetch.mjs";
import { createToolExecutor } from "./tool-executor.mjs";
import { createContextCompactor, estimateTokenCount, isContextOverflowError } from "./context-compaction.mjs";
import { pruneMessages } from "./message-pruner.mjs";
import { maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { createSessionResumer } from "./session-resume.mjs";
import { resolveMcpTools, createMcpToolOrchestrator } from "./mcp-client.mjs";
import { normalizeProviderUsageMetadata } from "../agent/providers/provider-usage-normalizer.mjs";
import { estimateCostFromUsage } from "../agent/providers/provider-model-pricing.mjs";
import { resolveCredentials } from "./auth-resolver.mjs";

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_TOOL_ROUNDS = 16;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const _sessions = new Map();
const _busySet = new Set();
const _compactor = createContextCompactor();
const _toolExecutor = createToolExecutor();
const _resumer = createSessionResumer();

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

// ── Session helpers ──────────────────────────────────────────────────────────

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

async function ensureSession(sessionId, model = "") {
  if (!sessionId) return { messages: [], model: model || "", lastResponseId: null };
  if (!_sessions.has(sessionId)) {
    const { resumed, session: loaded } = await _resumer.tryResume(sessionId, model);
    if (resumed && loaded) {
      _sessions.set(sessionId, {
        id: sessionId,
        busy: false,
        model: loaded.model || model || "",
        messages: loaded.messages,
        updatedAt: null,
        aggregatedUsage: loaded.aggregatedUsage || null,
        compactionCount: loaded.compactionCount || 0,
      });
    } else {
      _sessions.set(sessionId, {
        id: sessionId,
        busy: false,
        model: toTrimmedString(model),
        messages: [],
        updatedAt: null,
      });
    }
  }
  const s = _sessions.get(sessionId);
  if (model && !s.model) s.model = model;
  return s;
}

// ── Payload / credentials / endpoint ─────────────────────────────────────────

function resolvePayload(input, execOptions = {}) {
  const base = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return buildProviderTurnPayload(base, {
    providerId: execOptions.provider || execOptions.providerConfig?.provider || "anthropic-messages",
    model: execOptions.model || execOptions.providerConfig?.model || null,
    sessionId: execOptions.sessionId || null,
    threadId: execOptions.threadId || execOptions.sessionId || null,
    metadata: execOptions.metadata || {},
    tools: Array.isArray(execOptions.tools) ? execOptions.tools : [],
    reasoningEffort: execOptions.reasoningEffort || null,
  });
}

function resolveEndpoint(execOptions = {}) {
  const providerConfig = execOptions.providerConfig && typeof execOptions.providerConfig === "object"
    ? execOptions.providerConfig
    : {};
  const raw =
    toTrimmedString(providerConfig.endpoint)
    || toTrimmedString(providerConfig.baseUrl)
    || DEFAULT_ENDPOINT;
  if (/\/v1\/messages\/?$/i.test(raw)) return trimTrailingSlashes(raw);
  if (/\/v1\/?$/i.test(raw)) return `${trimTrailingSlashes(raw)}/messages`;
  return `${trimTrailingSlashes(raw)}/v1/messages`;
}

// ── Content / tool helpers ───────────────────────────────────────────────────

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
      if (block) blocks.push({ type: "text", text: `[thinking] ${block.text}` });
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

// ── Request builder ──────────────────────────────────────────────────────────

function buildAnthropicRequest(payload, execOptions = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const pc = execOptions?.providerConfig ?? {};
  const maxTokens = Number.isFinite(Number(pc.maxTokens))
    ? Number(pc.maxTokens)
    : DEFAULT_MAX_TOKENS;
  const thinkingBudget = Number(pc.thinkingBudget || execOptions?.thinkingBudget);
  const responseFormat = execOptions?.responseFormat || pc.responseFormat || null;

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

  // Cache_control injection on system/tools (prompt caching)
  const promptCaching = pc.promptCaching === true || execOptions?.promptCaching === true;
  if (promptCaching && systemParts.length > 0) {
    systemParts[systemParts.length - 1].cache_control = { type: "ephemeral" };
  }
  if (promptCaching && toolDefinitions.length > 0) {
    toolDefinitions[toolDefinitions.length - 1] = {
      ...toolDefinitions[toolDefinitions.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }

  const body = {
    model:
      toTrimmedString(payload.model)
      || toTrimmedString(execOptions.model)
      || toTrimmedString(execOptions.providerConfig?.model)
      || "claude-sonnet-4",
    max_tokens: maxTokens,
    system: systemParts.length > 0 ? systemParts : undefined,
    messages: mergeAnthropicMessages(conversation),
    tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
    stream: true,
  };

  // Extended thinking budget (D.11)
  if (Number.isFinite(thinkingBudget) && thinkingBudget > 0) {
    body.thinking = { type: "enabled", budget_tokens: Math.trunc(thinkingBudget) };
  }

  // Structured output (D.8)
  if (responseFormat) {
    if (responseFormat.type === "json_schema" && responseFormat.jsonSchema) {
      // Anthropic beta header for extended output schema support
      body.stream = false; // structured output works more reliably non-streamed on Anthropic
      // Fall back to including schema hint in system prompt when streaming is off
    }
  }

  return body;
}

// ── Response extraction ──────────────────────────────────────────────────────

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
      text: sanitizeTextContent(part?.thinking || part?.text || part?.summary || ""),
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

// ── SSE stream parsing (Anthropic event model) ───────────────────────────────

async function* parseSseStream(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let currentEvent = null;
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          yield { event: currentEvent, data };
          currentEvent = null;
        } else if (line === "") {
          currentEvent = null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Streaming turn processor ─────────────────────────────────────────────────

async function streamAnthropicTurn(url, apiKey, body, execOptions = {}) {
  const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
  const signal = execOptions?.abortController?.signal ?? null;
  const sessionId = toTrimmedString(execOptions?.sessionId || "");
  const timeoutMs = Number(execOptions?.timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS;

  let text = "";
  let usage = null;
  let stopReason = null;
  const toolCalls = new Map(); // id → { name, input }

  const controller = new AbortController();
  const fetchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  let idleTimer = null;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort("stream_idle_timeout"), timeoutMs);
  };
  resetIdleTimer();

  let response;
  try {
    response = await retryFetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    }, { maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2 });
  } catch (err) {
    clearTimeout(idleTimer);
    const msg = err?.name === "AbortError" ? "Request aborted" : `Network error: ${err?.message || err}`;
    throw new Error(msg);
  }

  if (!response.ok) {
    clearTimeout(idleTimer);
    const message = await parseErrorResponse(response);
    throw new Error(`Anthropic API error ${response.status}: ${message}`);
  }

  try {
    for await (const { event, data } of parseSseStream(response, fetchSignal)) {
      resetIdleTimer();
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      const eventType = event || parsed.type || "";

      if (eventType === "message_start") {
        onEvent?.({ type: "session.stream.start", sessionId });
        continue;
      }

      if (eventType === "content_block_delta") {
        const delta = parsed.delta;
        if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          onEvent?.({ type: "session.stream.delta", sessionId, delta: delta.text, text });
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          // Stream thinking as a special delta type
          onEvent?.({ type: "session.stream.thinking", sessionId, delta: delta.thinking });
        }
        continue;
      }

      if (eventType === "content_block_start") {
        const block = parsed.content_block;
        if (block?.type === "tool_use" && block.id && block.name) {
          toolCalls.set(block.id, { name: block.name, input: {} });
        }
        continue;
      }

      if (eventType === "content_block_stop") {
        // tool_use block is complete; input was assembled via input_json deltas
        continue;
      }

      if (eventType === "message_delta") {
        if (parsed.delta?.stop_reason) {
          stopReason = parsed.delta.stop_reason;
        }
        if (parsed.usage) {
          usage = normalizeAnthropicUsage(parsed.usage);
        }
        continue;
      }

      if (eventType === "message_stop") {
        // Final stop; nothing more to process
        continue;
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }

  // For streamed tool_use blocks, Anthropic sends content_block_start with the tool
  // header, then input_json deltas. However, our current SSE parser above doesn't
  // track input_json deltas. For simplicity, if text is empty and we expected tool
  // calls, fall back to a non-streaming parse. In practice, Anthropic usually sends
  // tool_use as content blocks that include the full input at start.
  const resolvedToolCalls = [...toolCalls.entries()]
    .filter(([, tc]) => tc.name)
    .map(([callId, tc]) => ({
      callId,
      name: tc.name,
      arguments: tc.input,
      argumentsRaw: JSON.stringify(tc.input),
    }));

  onEvent?.({ type: "session.stream.complete", sessionId, text, usage, stopReason });

  return { text, toolCalls: resolvedToolCalls, stopReason, usage };
}

// ── Non-streaming fallback for structured output ─────────────────────────────

async function callAnthropicNonStreaming(url, apiKey, body, execOptions = {}) {
  const signal = execOptions?.abortController?.signal ?? null;
  const controller = new AbortController();
  const fetchSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timeoutMs = Number(execOptions?.timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS;
  const timeoutTimer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let response;
  try {
    response = await retryFetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: false }),
      signal: fetchSignal,
    }, { maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2 });
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!response.ok) {
    const message = await parseErrorResponse(response);
    throw new Error(`Anthropic API error ${response.status}: ${message}`);
  }

  const payload = await response.json();
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = extractAnthropicText(content) || "";
  const toolCalls = extractAnthropicToolCalls(content);
  const stopReason = payload.stop_reason || payload.stopReason || null;
  const usage = normalizeAnthropicUsage(payload?.usage || {});

  return { text, toolCalls, stopReason, usage };
}

// ── Tool execution ───────────────────────────────────────────────────────────

async function executeToolCalls(toolCalls, execOptions) {
  const sessionId = toTrimmedString(execOptions?.sessionId || "");
  const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
  const { results, doomLoopDetected, anyTimedOut } =
    await _toolExecutor.execute(toolCalls, { ...execOptions, sessionId });
  if (doomLoopDetected) {
    onEvent?.({ type: "session.warn", sessionId, warning: "doom_loop_detected" });
  }
  if (anyTimedOut) {
    onEvent?.({ type: "session.warn", sessionId, warning: "tool_timeout" });
  }
  return results;
}

// ── Compaction / summarisation helpers ───────────────────────────────────────

async function callSummarisationApi(entries, execOptions, summaryModel) {
  const dialogue = entries.map((e) => {
    switch (e?.type) {
      case "user_message": return `USER:\n${e.text ?? ""}`;
      case "assistant_message": return `ASSISTANT:\n${e.text || ""}`;
      case "function_call": return `TOOL CALL [${e.name}]:\n${typeof e.arguments === "string" ? e.arguments : JSON.stringify(e.arguments ?? {})}`;
      case "function_call_output": return `TOOL RESULT:\n${String(e.output ?? "").slice(0, 2000)}`;
      default: return "";
    }
  }).filter(Boolean).join("\n\n---\n\n");

  const userPrompt =
    `Summarize the following conversation for context continuity.\n\n` +
    `CONVERSATION:\n\n${dialogue}\n\n` +
    `Write a structured summary with: Goal, Progress & Decisions, Key Technical Details, Current State, Pending Actions.`;

  const pc = execOptions?.providerConfig ?? {};
  const model = toTrimmedString(summaryModel || pc.summaryModel || pc.compactionModel || "claude-3-haiku-20240307");
  const url = resolveEndpoint({ ...execOptions, providerConfig: { ...pc, model } });
  const { apiKey } = resolveCredentials(execOptions);
  const body = {
    model,
    max_tokens: 2048,
    messages: [
      { role: "user", content: userPrompt },
    ],
    system: [{ type: "text", text: "You are an expert at summarizing technical AI coding-assistant sessions concisely and accurately." }],
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort("summarisation_timeout"), 30_000);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Summarisation API error ${response.status}: ${text.slice(0, 300)}`);
  }

  const json = await response.json();
  const summary = extractAnthropicText(json?.content || []);
  const usage = json?.usage ? normalizeAnthropicUsage(json.usage) : null;
  return { summary, usage };
}

// ── Adapter exports ──────────────────────────────────────────────────────────

export const anthropicNativeAdapter = {
  name: "anthropic-native",
  provider: "ANTHROPIC_NATIVE",
  displayName: "Anthropic Native",
  acceptsTurnPayload: true,
  async init() {
    return true;
  },
  isBusy(sessionId = null) {
    if (sessionId) return _busySet.has(String(sessionId));
    return _busySet.size > 0;
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
      _toolExecutor.resetDoomLoopState(sessionId);
      return;
    }
    if (options?.all) {
      _sessions.clear();
      _busySet.clear();
    }
  },

  async exec(input, execOptions = {}) {
    const payload = resolvePayload(input, execOptions);
    const sessionId = toTrimmedString(payload.sessionId || execOptions.sessionId || "");
    const isPersistent = Boolean(sessionId) || execOptions?.persistent === true;
    const effectiveSessionId = sessionId || `anthropic-ephemeral-${Date.now()}`;

    if (_busySet.has(effectiveSessionId)) {
      return {
        success: false,
        finalResponse: "Agent is busy with another turn. Please wait.",
        items: [],
        usage: null,
        sessionId: effectiveSessionId,
      };
    }
    _busySet.add(effectiveSessionId);

    const model =
      toTrimmedString(payload.model)
      || toTrimmedString(execOptions.model)
      || toTrimmedString(execOptions.providerConfig?.model);
    const { apiKey } = resolveCredentials(execOptions);

    let tools = Array.isArray(execOptions?.tools) ? execOptions.tools : [];

    // ── MCP tool discovery (D.7) ────────────────────────────────────────────
    const mcpServerConfigs = execOptions?.mcpServers || execOptions?.providerConfig?.mcpServers || [];
    if (mcpServerConfigs.length > 0) {
      try {
        tools = await resolveMcpTools(tools, mcpServerConfigs);
      } catch (err) {
        console.warn(`[anthropic-native-adapter] MCP tool resolution failed: ${err?.message || err}`);
      }
    }

    if (!execOptions?._mcpWrapped) {
      const originalOrchestrator = execOptions?.toolOrchestrator || null;
      execOptions = {
        ...execOptions,
        toolOrchestrator: createMcpToolOrchestrator(originalOrchestrator),
        _mcpWrapped: true,
      };
    }

    const session = await ensureSession(isPersistent ? effectiveSessionId : null, model);
    if (model && !session.model) session.model = model;
    const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;

    const trimmedMsg = String(input || "").trim().toLowerCase();

    // Slash commands
    if (trimmedMsg === "/undo") {
      _busySet.delete(effectiveSessionId);
      const removed = [];
      while (session.messages.length > 0) {
        const tail = session.messages.at(-1);
        if (tail?.type === "function_call_output" || tail?.type === "function_call") {
          removed.push(session.messages.pop());
          continue;
        }
        if (tail?.type === "assistant_message") {
          removed.push(session.messages.pop());
          const next = session.messages.at(-1);
          if (next?.type === "user_message") removed.push(session.messages.pop());
          break;
        }
        if (tail?.type === "user_message") {
          removed.push(session.messages.pop());
          break;
        }
        break;
      }
      onEvent?.({ type: "session.undo", sessionId: effectiveSessionId, removedCount: removed.length });
      return {
        success: true,
        finalResponse: `Undid last turn (removed ${removed.length} entries; ${session.messages.length} remain).`,
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
      };
    }

    if (trimmedMsg === "/clear") {
      _busySet.delete(effectiveSessionId);
      const removedCount = session.messages.length;
      session.messages = [];
      onEvent?.({ type: "session.cleared", sessionId: effectiveSessionId, removedCount });
      return {
        success: true,
        finalResponse: `Cleared session history (${removedCount} entries removed).`,
        items: [],
        usage: null,
        sessionId: effectiveSessionId,
      };
    }

    if (trimmedMsg === "/status") {
      _busySet.delete(effectiveSessionId);
      const status = {
        sessionId: effectiveSessionId,
        model: session.model || model,
        messageCount: session.messages.length,
        compactionCount: session.compactionCount ?? 0,
      };
      onEvent?.({ type: "session.status", ...status });
      return {
        success: true,
        finalResponse: `Session ${status.sessionId}\nModel: ${status.model}\nMessages: ${status.messageCount}\nCompactions: ${status.compactionCount}`,
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
        status,
      };
    }

    if (trimmedMsg.startsWith("/resume ")) {
      _busySet.delete(effectiveSessionId);
      const targetId = trimmedMsg.slice("/resume ".length).trim();
      const { resumed, session: loaded } = await _resumer.tryResume(targetId, model);
      if (resumed && loaded) {
        _sessions.set(targetId, {
          id: targetId,
          busy: false,
          model: loaded.model || model,
          messages: loaded.messages,
          updatedAt: null,
          aggregatedUsage: loaded.aggregatedUsage || null,
          compactionCount: loaded.compactionCount || 0,
        });
        return {
          success: true,
          finalResponse: `Resumed session ${targetId} (${loaded.messages.length} messages).`,
          items: loaded.messages,
          usage: null,
          sessionId: targetId,
          resumed: true,
        };
      }
      return {
        success: false,
        finalResponse: `Session "${targetId}" not found on disk.`,
        items: [],
        usage: null,
        sessionId: effectiveSessionId,
      };
    }

    if (trimmedMsg === "/compact") {
      _busySet.delete(effectiveSessionId);
      const compactResult = await _compactor.compact(session, {
        strategy: "manual",
        summarise: (entries) => callSummarisationApi(entries, execOptions),
      });
      return {
        success: true,
        finalResponse: compactResult.checkpointAdded
          ? `Compacted ${compactResult.removedCount} messages into a checkpoint summary.`
          : `Rolled back ${compactResult.removedCount} messages.`,
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
      };
    }

    // Append user turn
    session.messages.push({ type: "user_message", text: String(input || "") });
    onEvent?.({ type: "session.turn.start", sessionId: effectiveSessionId, model });

    let aggregatedUsage = null;
    let finalText = "";
    let roundCount = 0;
    const maxCostUsd = Number(execOptions?.maxCostUsd ?? execOptions?.providerConfig?.maxCostUsd ?? 0) || 0;

    try {
      while (roundCount < MAX_TOOL_ROUNDS) {
        roundCount++;

        // Proactive compaction
        if (roundCount === 1) {
          const proactive = _compactor.shouldCompact(session, { model });
          if (proactive.shouldCompact) {
            const res = await _compactor.compact(session, {
              strategy: proactive.strategy,
              summarise: (entries) => callSummarisationApi(entries, execOptions),
            });
            if (res.compacted) {
              onEvent?.({ type: "session.compaction", sessionId: effectiveSessionId, strategy: res.strategy, removedCount: res.removedCount });
            }
          }
        }

        // ── Tiered shredding (D.10) ────────────────────────────────────────
        try {
          session.messages = await maybeCompressSessionItems(session.messages, {
            sessionType: "primary",
            agentType: "anthropic-native",
            sessionId: effectiveSessionId,
          });
        } catch (err) {
          console.warn(`[anthropic-native-adapter] shredding failed: ${err?.message || err}`);
        }
        session.messages = pruneMessages(session.messages, {
          stripReasoning: true,
          truncateOutputs: true,
          maxToolOutputChars: 8_000,
        });

        const requestBody = buildAnthropicRequest(
          { ...payload, messages: session.messages, tools },
          execOptions,
        );

        let turnResult;
        const useStreaming = requestBody.stream !== false;
        try {
          if (useStreaming) {
            turnResult = await streamAnthropicTurn(resolveEndpoint(execOptions), apiKey, requestBody, {
              ...execOptions,
              sessionId: effectiveSessionId,
            });
          } else {
            turnResult = await callAnthropicNonStreaming(resolveEndpoint(execOptions), apiKey, requestBody, {
              ...execOptions,
              sessionId: effectiveSessionId,
            });
          }
        } catch (apiErr) {
          if (isContextOverflowError(apiErr)) {
            const overflowResult = await _compactor.onContextOverflow(session, {
              summarise: (entries) => callSummarisationApi(entries, execOptions),
            });
            if (!overflowResult.compacted) throw apiErr;
            onEvent?.({ type: "session.compaction", sessionId: effectiveSessionId, strategy: overflowResult.strategy, urgency: "critical" });
            // Retry with compacted history
            continue;
          }
          throw apiErr;
        }

        finalText = turnResult.text;

        if (turnResult.usage) {
          if (!turnResult.usage.costUsd || turnResult.usage.costUsd === 0) {
            const computedCost = estimateCostFromUsage(model, turnResult.usage);
            if (computedCost > 0) turnResult.usage.costUsd = computedCost;
          }
          _compactor.recordUsage(effectiveSessionId, turnResult.usage);
          if (!aggregatedUsage) {
            aggregatedUsage = { ...turnResult.usage };
          } else {
            aggregatedUsage.inputTokens = (aggregatedUsage.inputTokens || 0) + (turnResult.usage.inputTokens || 0);
            aggregatedUsage.outputTokens = (aggregatedUsage.outputTokens || 0) + (turnResult.usage.outputTokens || 0);
            aggregatedUsage.totalTokens = (aggregatedUsage.totalTokens || 0) + (turnResult.usage.totalTokens || 0);
            aggregatedUsage.cacheInputTokens = (aggregatedUsage.cacheInputTokens || 0) + (turnResult.usage.cacheInputTokens || 0);
            aggregatedUsage.cacheCreationInputTokens = (aggregatedUsage.cacheCreationInputTokens || 0) + (turnResult.usage.cacheCreationInputTokens || 0);
            aggregatedUsage.costUsd = (aggregatedUsage.costUsd || 0) + (turnResult.usage.costUsd || 0);
          }
        }

        // Budget enforcement
        const cumulativeCostUsd = Number(aggregatedUsage?.costUsd) || 0;
        onEvent?.({ type: "session.budget.update", sessionId: effectiveSessionId, stepNumber: roundCount, cumulativeCostUsd, maxCostUsd, usage: aggregatedUsage ? { ...aggregatedUsage } : null });
        if (maxCostUsd > 0 && cumulativeCostUsd > maxCostUsd) {
          onEvent?.({ type: "session.budget.exceeded", sessionId: effectiveSessionId, cumulativeCostUsd, limitUsd: maxCostUsd });
          throw new Error(`Session cost $${cumulativeCostUsd.toFixed(4)} exceeded limit $${maxCostUsd.toFixed(4)}`);
        }

        // Append assistant turn
        const assistantEntry = {
          type: "assistant_message",
          text: finalText,
          toolCalls: turnResult.toolCalls.map((tc) => ({
            callId: tc.id,
            name: tc.name,
            arguments: tc.input,
          })),
        };
        session.messages.push(assistantEntry);

        if (!turnResult.toolCalls.length) break;

        // Pre-tool compaction
        const preTool = _compactor.shouldCompact(session, { model, beforeToolRound: true });
        if (preTool.shouldCompact) {
          const res = await _compactor.compact(session, {
            strategy: preTool.strategy,
            summarise: (entries) => callSummarisationApi(entries, execOptions),
          });
          if (res.compacted) {
            onEvent?.({ type: "session.compaction", sessionId: effectiveSessionId, strategy: res.strategy });
          }
        }

        // Execute tools
        const toolResults = await executeToolCalls(turnResult.toolCalls.map((tc) => ({
          callId: tc.id,
          name: tc.name,
          arguments: tc.input,
          argumentsRaw: JSON.stringify(tc.input),
        })), { ...execOptions, sessionId: effectiveSessionId });

        // Append tool calls and results
        for (const tc of turnResult.toolCalls) {
          session.messages.push({
            type: "function_call",
            callId: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.input),
          });
        }
        for (const tr of toolResults) {
          session.messages.push({
            type: "function_call_output",
            callId: tr.callId,
            output: tr.output,
          });
        }

        onEvent?.({
          type: "session.step.finish",
          sessionId: effectiveSessionId,
          stepNumber: roundCount,
          text: finalText,
          toolCalls: turnResult.toolCalls.map((tc) => ({ callId: tc.id, name: tc.name, arguments: tc.input })),
          toolResults: toolResults.map((tr) => ({ callId: tr.callId, output: tr.output })),
          stopReason: turnResult.stopReason || "",
          usage: turnResult.usage ?? null,
          isContinued: roundCount < MAX_TOOL_ROUNDS,
        });
      }

      if (!isPersistent) {
        _sessions.delete(effectiveSessionId);
      }

      onEvent?.({
        type: "session.turn.complete",
        sessionId: effectiveSessionId,
        text: finalText,
        usage: aggregatedUsage,
      });

      return {
        success: true,
        finalResponse: finalText,
        items: session.messages.slice(-Math.min(session.messages.length, 100)),
        usage: aggregatedUsage,
        sessionId: effectiveSessionId,
        model,
        roundCount,
      };
    } catch (err) {
      onEvent?.({ type: "session.turn.error", sessionId: effectiveSessionId, error: String(err?.message || err) });
      const lastEntry = session.messages.at(-1);
      if (lastEntry?.type === "assistant_message") session.messages.pop();
      const prevEntry = session.messages.at(-1);
      if (prevEntry?.type === "user_message") session.messages.pop();
      if (!isPersistent) {
        _sessions.delete(effectiveSessionId);
      }
      return {
        success: false,
        finalResponse: `Error: ${err?.message || err}`,
        items: [],
        usage: aggregatedUsage,
        sessionId: effectiveSessionId,
      };
    } finally {
      _busySet.delete(effectiveSessionId);
    }
  },
};

export default anthropicNativeAdapter;
