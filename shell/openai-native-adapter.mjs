/**
 * openai-native-adapter.mjs
 *
 * Bosun-native HTTP adapter for:
 *   - OpenAI Responses API  (apiStyle = "responses")
 *   - OpenAI Chat Completions API  (apiStyle = "chat-completions")
 *   - Azure OpenAI  (detected via endpoint containing .azure.com or
 *     providerConfig.deployment being set)
 *   - OpenAI-compatible endpoints  (Ollama, vLLM, etc.)
 *
 * Replaces codex-sdk for all providers in the openai/azure/oai-compat
 * family, giving Bosun full ownership of:
 *   - HTTP request construction and credential resolution
 *   - SSE stream parsing and event normalization
 *   - Per-session conversation history
 *   - Tool-call execution loop
 *   - Usage accounting
 *
 * Adapter contract (must match shell-adapter-registry.mjs shape):
 *   exec(message, execOptions)  → Promise<Result>
 *   isBusy(sessionId?)         → boolean
 *   getInfo(sessionId?)        → SessionInfo
 *   init()                     → Promise<void>
 *   reset(options?)            → void
 *
 * Result shape:
 *   { finalResponse, items, usage, sessionId, threadId, ok, success }
 */

import { normalizeProviderUsageMetadata } from "../agent/providers/provider-usage-normalizer.mjs";
import { estimateCostFromUsage } from "../agent/providers/provider-model-pricing.mjs";
import {
  createContextCompactor,
  estimateTokenCount,
  isContextOverflowError,
} from "./context-compaction.mjs";
import { pruneMessages } from "./message-pruner.mjs";
import { createStreamSmootherFactory } from "./smooth-stream.mjs";
import { isStopConditionMet, resolvePrepareStep } from "./stop-condition.mjs";
import { createToolExecutor } from "./tool-executor.mjs";
import { retryFetch, isRetryableStatus } from "./retry-fetch.mjs";
import {
  detectBrokenToolCalls,
  repairToolCalls,
  applyRepairs,
} from "./tool-call-repair.mjs";
import { maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { createSessionResumer } from "./session-resume.mjs";
import { resolveMcpTools, createMcpToolOrchestrator } from "./mcp-client.mjs";
import { discoverMcpServers } from "./mcp-registry.mjs";
import { resolveCredentials } from "./auth-resolver.mjs";
import { normalizeMessages } from "./provider-transform.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_ROUNDS = 16;

// ── Tier-1 helpers (BOSUN_NATIVE_HARNESS_GAP_PLAN §D.2 / §D.3 / §D.6) ───────

/**
 * Auto-detect prompt caching from the model name when the caller did not
 * pass an explicit `promptCaching` flag. Anthropic and Anthropic-routed
 * OpenAI-compatible endpoints benefit from `cache_control` injection;
 * vanilla OpenAI ignores the field, so it is safe to enable for clearly
 * Anthropic-flavoured routes only.
 */
export function shouldEnablePromptCaching(providerConfig, execOptions) {
  const pc = providerConfig ?? {};
  const explicit = pc.promptCaching ?? execOptions?.promptCaching;
  if (explicit != null) return Boolean(explicit);
  const model = String(pc.model || execOptions?.model || "").toLowerCase();
  const provider = String(pc.provider || execOptions?.provider || "").toLowerCase();
  if (provider === "anthropic" || provider === "claude") return true;
  if (model.startsWith("claude-")) return true;
  if (model.startsWith("anthropic/")) return true;
  if (model.includes("/claude-")) return true; // openrouter/claude-3-opus etc.
  return false;
}

/**
 * Budget enforcement (§D.3). Thrown by exec() when a hard cost cap is set
 * via execOptions.maxCostUsd or providerConfig.maxCostUsd and the running
 * total surpasses it. Distinct class so callers can catch it specifically.
 */
export class BudgetExceededError extends Error {
  constructor(message, { sessionId, costUsd, limitUsd } = {}) {
    super(message);
    this.name = "BudgetExceededError";
    this.code = "BUDGET_EXCEEDED";
    this.sessionId = sessionId ?? null;
    this.costUsd = Number(costUsd) || 0;
    this.limitUsd = Number(limitUsd) || 0;
  }
}

/**
 * Compute cache hit ratio as a percentage (§D.6). Defensive on missing
 * fields and zero input — returns 0 rather than NaN/Infinity.
 */
export function computeCacheHitPct(usage) {
  const inputTokens = Number(usage?.inputTokens) || 0;
  const cacheInputTokens = Number(usage?.cacheInputTokens) || 0;
  if (inputTokens <= 0) return 0;
  const ratio = (cacheInputTokens / inputTokens) * 100;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 10) / 10));
}
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min stream idle
const RESPONSES_API_VERSION_DEFAULT = "2025-03-01-preview";
const OPENAI_BASE_URL = "https://api.openai.com";
const OPENAI_TEXT_ITEM_MAX_CHARS = 10_485_760;
const DEFAULT_HISTORY_TEXT_MAX_CHARS = 8_000_000;
const MIN_HISTORY_TEXT_MAX_CHARS = 1024;

// Shared compactor — one instance handles all sessions in the process.
const _compactor = createContextCompactor();

// Shared tool executor — one instance handles all sessions in the process.
const _toolExecutor = createToolExecutor();

// Shared stream smoother factory — one per session, word-chunked at 12ms.
const _smoothers = createStreamSmootherFactory({ chunking: "word", delayMs: 12 });

// ── Azure Deployment Discovery Cache ─────────────────────────────────────────
// Azure AI Foundry deployments often use full versioned model IDs (e.g.
// "gpt-5.4-mini-2026-03-17") while callers pass short aliases ("gpt-5.4-mini").
// This cache resolves short names to the latest matching deployment via the
// Azure Models API, caching results for 10 minutes per endpoint.

const _azureDeploymentCache = new Map();
const AZURE_DEPLOYMENT_CACHE_TTL_MS = 10 * 60 * 1000;

async function resolveAzureDeploymentName(baseEndpoint, shortModel, apiKey) {
  if (!shortModel || !baseEndpoint) return shortModel;
  const cacheKey = `${baseEndpoint}::${shortModel}`;
  const cached = _azureDeploymentCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AZURE_DEPLOYMENT_CACHE_TTL_MS) {
    return cached.deployment;
  }
  try {
    const url = `${baseEndpoint}/openai/models?api-version=2025-03-01-preview`;
    const headers = { "api-key": apiKey, "Content-Type": "application/json" };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return shortModel;
    const body = await res.json();
    const models = Array.isArray(body?.data) ? body.data : [];
    // Find exact match first
    if (models.some((m) => m.id === shortModel)) {
      _azureDeploymentCache.set(cacheKey, { deployment: shortModel, ts: Date.now() });
      return shortModel;
    }
    // Find latest versioned variant matching the short prefix
    const candidates = models
      .filter((m) => typeof m.id === "string" && m.id.startsWith(shortModel + "-"))
      .map((m) => m.id)
      .sort();
    const best = candidates.length > 0 ? candidates[candidates.length - 1] : shortModel;
    _azureDeploymentCache.set(cacheKey, { deployment: best, ts: Date.now() });
    return best;
  } catch {
    return shortModel;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

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

function getHistoryTextMaxChars() {
  const raw = Number(process.env.BOSUN_OPENAI_NATIVE_MAX_HISTORY_TEXT_CHARS);
  if (!Number.isFinite(raw)) return DEFAULT_HISTORY_TEXT_MAX_CHARS;
  return Math.max(
    MIN_HISTORY_TEXT_MAX_CHARS,
    Math.min(OPENAI_TEXT_ITEM_MAX_CHARS - 1024, Math.trunc(raw)),
  );
}

function serializeRequestField(value, fallback = "") {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return String(value ?? fallback);
  }
}

function truncateOversizedHistoryText(value, label = "history text", maxChars = getHistoryTextMaxChars()) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= maxChars) return text;
  const marker = `\n…[${label} truncated ${text.length - maxChars} chars to stay within OpenAI per-item limits]…\n`;
  const availableChars = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(availableChars * 0.6);
  const tailChars = Math.max(0, availableChars - headChars);
  return `${text.slice(0, headChars)}${marker}${tailChars > 0 ? text.slice(-tailChars) : ""}`;
}

function sanitizeHistoryEntryForRequest(entry, maxChars = getHistoryTextMaxChars()) {
  if (!entry || typeof entry !== "object") return entry;
  let next = entry;
  const updateField = (field, label, { structured = false } = {}) => {
    const current = next?.[field];
    if (current == null) return;
    let truncated = current;
    if (structured) {
      const serialized = serializeRequestField(current, "");
      if (serialized.length <= maxChars) return;
      truncated = truncateOversizedHistoryText(serialized, label, maxChars);
    } else {
      truncated = truncateOversizedHistoryText(current, label, maxChars);
      if (truncated === current) return;
    }
    if (next === entry) next = { ...entry };
    next[field] = truncated;
  };

  switch (entry.type) {
    case "user_message":
      updateField("text", "user message");
      break;
    case "assistant_message":
      updateField("text", "assistant message");
      if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
        let toolCalls = entry.toolCalls;
        for (let idx = 0; idx < entry.toolCalls.length; idx += 1) {
          const toolCall = entry.toolCalls[idx];
          if (toolCall?.arguments == null) continue;
          const currentArgs = toolCall.arguments;
          const serializedArgs = serializeRequestField(currentArgs, "{}");
          if (serializedArgs.length <= maxChars) continue;
          const truncatedArgs = truncateOversizedHistoryText(serializedArgs, "tool call arguments", maxChars);
          if (toolCalls === entry.toolCalls) toolCalls = entry.toolCalls.slice();
          toolCalls[idx] = { ...toolCall, arguments: truncatedArgs };
        }
        if (toolCalls !== entry.toolCalls) {
          if (next === entry) next = { ...entry };
          next.toolCalls = toolCalls;
        }
      }
      break;
    case "function_call":
      updateField("arguments", "tool call arguments", { structured: true });
      break;
    case "function_call_output":
      updateField("output", "tool output", { structured: true });
      break;
    case "compaction_checkpoint":
      updateField("text", "checkpoint summary");
      break;
    default:
      break;
  }
  return next;
}

export function sanitizeHistoryEntriesForRequest(history, options = {}) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(
        MIN_HISTORY_TEXT_MAX_CHARS,
        Math.min(OPENAI_TEXT_ITEM_MAX_CHARS - 1024, Math.trunc(Number(options.maxChars))),
      )
    : getHistoryTextMaxChars();
  let changed = false;
  const sanitized = history.map((entry) => {
    const next = sanitizeHistoryEntryForRequest(entry, maxChars);
    if (next !== entry) changed = true;
    return next;
  });
  return changed ? sanitized : history;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Credential Resolution ────────────────────────────────────────────────────
// Delegated to shell/auth-resolver.mjs for unified auth state + env handling.

// ── Endpoint Resolution ──────────────────────────────────────────────────────

/**
 * Build the full request URL.
 * For Azure: {endpoint}/openai/deployments/{deployment}/{path}?api-version=...
 * For OpenAI/compatible: {baseUrl}/{path}
 */
function resolveEndpointUrl(execOptions, apiStyle = "responses") {
  const pc = execOptions?.providerConfig ?? {};
  const env = execOptions?.env ?? process.env;
  const model = toTrimmedString(pc.model || execOptions?.model || "");
  const deployment = toTrimmedString(pc.deployment) || model;
  const rawEndpoint = toTrimmedString(pc.endpoint || pc.baseUrl || env.OPENAI_BASE_URL || "");
  const apiVersion = toTrimmedString(pc.apiVersion) || RESPONSES_API_VERSION_DEFAULT;

  const credentials = resolveCredentials(execOptions);
  const isAzure = credentials.isAzure && Boolean(rawEndpoint);

  // Azure AI Foundry exposes an OpenAI-compatible gateway at /openai/v1.
  // When the base URL already contains that path, use it directly with the
  // model name in the request body — NOT the /openai/deployments/{dep}/... pattern
  // which is for classic Azure OpenAI Service only.
  const hasOpenAIVersionPath = /\/openai\/v\d+\/?$/.test(rawEndpoint);

  if (isAzure && !hasOpenAIVersionPath) {
    // Classic Azure OpenAI Service: /openai/deployments/{deployment}/...
    const base = trimTrailingSlashes(rawEndpoint).replace(/\/openai$/, "");
    if (apiStyle === "responses") {
      return `${base}/openai/deployments/${deployment}/responses?api-version=${apiVersion}`;
    }
    return `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  // OpenAI-compatible path (standard OpenAI, Azure AI Foundry with /openai/v1, etc.)
  // Normalise: strip trailing slash and any trailing /v1 so we can re-add a
  // canonical /v1/ prefix.  Keep /openai if present (Azure AI Foundry needs it).
  const baseUrl = trimTrailingSlashes(rawEndpoint || OPENAI_BASE_URL);
  const clean = baseUrl.replace(/\/v\d+$/, "");
  if (apiStyle === "responses") return `${clean}/v1/responses`;
  return `${clean}/v1/chat/completions`;
}

function buildAuthHeaders(credentials) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (credentials.authMode === "oauth" && credentials.oauthToken) {
    headers.Authorization = `Bearer ${credentials.oauthToken}`;
  } else if (credentials.isAzure && credentials.apiKey) {
    headers["api-key"] = credentials.apiKey;
  } else if (credentials.apiKey) {
    headers.Authorization = `Bearer ${credentials.apiKey}`;
  }
  return headers;
}

// ── Tool Format Conversion ───────────────────────────────────────────────────

/**
 * Convert a Bosun tool definition to Responses API format.
 * { type: "function", name, description, parameters }
 */
function toBosunToolToResponses(tool) {
  if (!isPlainObject(tool)) return null;
  const name = toTrimmedString(tool.name || tool.function?.name || "");
  if (!name) return null;
  const description = toTrimmedString(
    tool.description || tool.function?.description || "",
  );
  const parameters = tool.parameters || tool.function?.parameters || { type: "object", properties: {} };
  return { type: "function", name, description, parameters };
}

/**
 * Convert a Bosun tool definition to Chat Completions API format.
 * { type: "function", function: { name, description, parameters } }
 */
function toBosunToolToChat(tool) {
  if (!isPlainObject(tool)) return null;
  const name = toTrimmedString(tool.name || tool.function?.name || "");
  if (!name) return null;
  const description = toTrimmedString(
    tool.description || tool.function?.description || "",
  );
  const parameters = tool.parameters || tool.function?.parameters || { type: "object", properties: {} };
  return { type: "function", function: { name, description, parameters } };
}

// ── Message History Format ───────────────────────────────────────────────────

/**
 * Convert internal history entry to Responses API input item.
 */
function historyEntryToResponsesInput(entry) {
  if (entry.type === "user_message") {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: entry.text }],
    };
  }
  if (entry.type === "assistant_message") {
    const content = [];
    if (entry.text) content.push({ type: "output_text", text: entry.text });
    return { type: "message", role: "assistant", content };
  }
  if (entry.type === "function_call") {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || !entry.callId) return null;
    return {
      type: "function_call",
      call_id: entry.callId,
      name,
      arguments: serializeRequestField(entry.arguments, {}),
    };
  }
  if (entry.type === "function_call_output") {
    return {
      type: "function_call_output",
      call_id: entry.callId,
      output: serializeRequestField(entry.output, ""),
    };
  }
  return null;
}

/**
 * Convert internal history entry to Chat Completions message.
 */
function historyEntryToChatMessage(entry) {
  if (entry.type === "user_message") {
    return { role: "user", content: entry.text };
  }
  if (entry.type === "assistant_message") {
    const msg = { role: "assistant", content: entry.text || null };
    if (Array.isArray(entry.toolCalls) && entry.toolCalls.length > 0) {
      msg.content = entry.text || null;
      msg.tool_calls = entry.toolCalls.map((tc) => ({
        id: tc.callId,
        type: "function",
        function: {
          name: tc.name,
          arguments: typeof tc.arguments === "string"
            ? tc.arguments
            : JSON.stringify(tc.arguments ?? {}),
        },
      }));
    }
    return msg;
  }
  if (entry.type === "function_call_output") {
    return {
      role: "tool",
      tool_call_id: entry.callId,
      content: typeof entry.output === "string"
        ? entry.output
        : JSON.stringify(entry.output ?? ""),
    };
  }
  return null;
}

// ── Request Body Builders ────────────────────────────────────────────────────

/**
 * Inject Anthropic-style prompt-cache breakpoints into Chat Completions
 * messages.  Adds `cache_control: { type: "ephemeral" }` on every Nth user
 * message in older history so Anthropic's API can cache those conversation
 * prefixes server-side across turns.
 *
 * Pattern mirrored from Claude Code's explicit `cache_control` placement:
 *   - System prompt (handled in buildChatRequest)
 *   - Last tool definition (handled in buildChatRequest)
 *   - Historical user messages at breakpoint intervals ← this function
 *
 * @param {object[]} messages   Chat Completions messages (roles: user/assistant/tool)
 * @returns {object[]}          New array; breakpoint messages have content upgraded
 *                              from string to [{type:"text",text,cache_control:{...}}]
 */
function injectHistoryCacheBreakpoints(messages) {
  const BREAKPOINT_INTERVAL = 5;  // mark every 5th user message in the stable head
  const KEEP_RECENT = 3;          // never mark the last 3 user messages (dynamic tail)

  const userIndices = messages.reduce((acc, m, i) => {
    if (m?.role === "user") acc.push(i);
    return acc;
  }, []);

  // Only consider stable (older) messages for breakpoints
  const candidateIndices = userIndices.slice(0, Math.max(0, userIndices.length - KEEP_RECENT));
  if (candidateIndices.length < BREAKPOINT_INTERVAL) return messages;  // not enough history

  const breakpointSet = new Set();
  for (let i = BREAKPOINT_INTERVAL - 1; i < candidateIndices.length; i += BREAKPOINT_INTERVAL) {
    breakpointSet.add(candidateIndices[i]);
  }

  return messages.map((msg, idx) => {
    if (!breakpointSet.has(idx)) return msg;
    const text = typeof msg.content === "string" ? msg.content : null;
    if (!text) return msg;  // skip already-array content (already has a breakpoint)
    return {
      ...msg,
      content: [{ type: "text", text, cache_control: { type: "ephemeral" } }],
    };
  });
}

/**
 * Build an OpenAI Responses API request body.
 *
 * Cache-read optimizations implemented (OpenAI / Codex patterns):
 *   1. `instructions` field — system prompt sits OUTSIDE `input[]` as a stable
 *      prefix.  OpenAI's automatic prompt-cache hits on prefixes ≥ 1024 tokens;
 *      keeping the system prompt as a separate, unchanging field maximises this.
 *   2. `store: true` for persistent sessions — tells OpenAI to retain the
 *      response server-side, enabling `previous_response_id` continuation on the
 *      next turn (zero history re-send cost when the thread is live).
 *   3. `previous_response_id` — already set; combined with `store: true` this
 *      is the Responses API equivalent of Codex CLI's ContextManager threading.
 *
 * @param {object[]} history             Internal session message array
 * @param {object[]} tools               Bosun tool definitions
 * @param {object}   execOptions         Standard exec options
 * @param {string|null} previousResponseId  Last response ID for server threading
 * @param {boolean}  persistent          Whether the session persists across turns
 */
function buildResponsesRequest(history, tools, execOptions, previousResponseId = null, persistent = false) {
  const pc = execOptions?.providerConfig ?? {};
  const model = toTrimmedString(pc.model || execOptions?.model || "gpt-4o");
  const maxChars = getHistoryTextMaxChars();
  const systemPrompt = truncateOversizedHistoryText(
    toTrimmedString(pc.systemPrompt || execOptions?.systemPrompt || ""),
    "system prompt",
    maxChars,
  );
  const reasoningEffort = toTrimmedString(
    pc.reasoningEffort || execOptions?.reasoningEffort || "",
  );
  const responseFormat = execOptions?.responseFormat || pc.responseFormat || null;

  // Drop any function_call entries with empty/missing names, plus their
  // associated function_call_output entries — Azure rejects empty `name`.
  const validCallIds = new Set();
  for (const entry of history) {
    if (entry?.type === "function_call" && entry.callId && typeof entry.name === "string" && entry.name.trim().length > 0) {
      validCallIds.add(entry.callId);
    }
  }
  const filteredHistory = sanitizeHistoryEntriesForRequest(history).filter((entry) => {
    if (entry?.type === "function_call") {
      return entry.callId && typeof entry.name === "string" && entry.name.trim().length > 0;
    }
    if (entry?.type === "function_call_output") {
      return entry.callId && validCallIds.has(entry.callId);
    }
    return true;
  });
  const input = filteredHistory.map(historyEntryToResponsesInput).filter(Boolean).map((item) => {
    if (!item || typeof item !== "object") return item;
    let next = item;
    if (Array.isArray(item.content) && item.content.length > 0) {
      let content = item.content;
      for (let idx = 0; idx < item.content.length; idx += 1) {
        const part = item.content[idx];
        if (!part || typeof part.text !== "string") continue;
        const truncated = truncateOversizedHistoryText(part.text, `${item.role || item.type || "input"} text`, maxChars);
        if (truncated === part.text) continue;
        if (content === item.content) content = item.content.slice();
        content[idx] = { ...part, text: truncated };
      }
      if (content !== item.content) {
        if (next === item) next = { ...item };
        next.content = content;
      }
    }
    if (typeof item.arguments === "string") {
      const truncated = truncateOversizedHistoryText(item.arguments, "tool call arguments", maxChars);
      if (truncated !== item.arguments) {
        if (next === item) next = { ...item };
        next.arguments = truncated;
      }
    }
    if (typeof item.output === "string") {
      const truncated = truncateOversizedHistoryText(item.output, "tool output", maxChars);
      if (truncated !== item.output) {
        if (next === item) next = { ...item };
        next.output = truncated;
      }
    }
    return next;
  });
  const normalizedTools = Array.isArray(tools)
    ? tools.map(toBosunToolToResponses).filter(Boolean)
    : [];

  const body = {
    model,
    input,
    stream: true,
    ...(normalizedTools.length > 0 ? { tools: normalizedTools } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    // Server-side thread continuation — avoids re-sending full history on each turn.
    // Only set when the provider supports it (standard OpenAI Responses API).
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    // Cache optimization 1: system prompt as `instructions` (stable prefix outside input[]).
    // OpenAI caches prefixes ≥1024 tokens automatically; keeping system as a separate,
    // unchanging field ensures it never shifts the cache boundary.
    ...(systemPrompt ? { instructions: systemPrompt } : {}),
    // Cache optimization 2: store:true retains server-side state for previous_response_id.
    // On subsequent turns only new user input is sent; the entire prior conversation
    // is served from the server cache at the cached-input price (typically 50% discount).
    ...(persistent ? { store: true } : {}),
  };

  // Structured output (D.8)
  if (responseFormat) {
    if (responseFormat.type === "json_schema" && responseFormat.jsonSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: responseFormat.name || "response",
          schema: responseFormat.jsonSchema,
          strict: responseFormat.strict !== false,
        },
      };
    } else if (responseFormat.type === "json_object") {
      body.text = { format: { type: "json_object" } };
    } else if (responseFormat.type === "text") {
      body.text = { format: { type: "text" } };
    }
  }

  return body;
}

/**
 * Build an OpenAI Chat Completions API request body.
 *
 * Cache-read optimizations implemented (Claude Code / Anthropic patterns):
 *   1. System prompt prepended as { role: "system" } message, or as an array
 *      content block with `cache_control: { type: "ephemeral" }` when prompt
 *      caching is enabled — marks the system prompt as a stable prefix for
 *      Anthropic's 5-minute cache TTL (refreshed on every access).
 *   2. Last tool definition gets `cache_control` when prompt caching is on —
 *      tools are identical across all turns; caching them saves re-processing
 *      the full schema every request.
 *   3. History cache breakpoints (injectHistoryCacheBreakpoints) — every 5th
 *      user message in stable history gets `cache_control`, letting Anthropic
 *      cache the conversation up to those anchor points.
 *
 * Prompt caching is activated when `providerConfig.promptCaching === true` or
 * `execOptions.promptCaching === true` (e.g. when routing through Anthropic,
 * OpenRouter with Anthropic models, or a caching-capable proxy).
 *
 * @param {object[]} history    Internal session message array
 * @param {object[]} tools      Bosun tool definitions
 * @param {object}   execOptions Standard exec options
 */
function buildChatRequest(history, tools, execOptions) {
  const pc = execOptions?.providerConfig ?? {};
  const model = toTrimmedString(pc.model || execOptions?.model || "gpt-4o");
  const systemPrompt = toTrimmedString(pc.systemPrompt || execOptions?.systemPrompt || "");
  const reasoningEffort = toTrimmedString(
    pc.reasoningEffort || execOptions?.reasoningEffort || "",
  );
  const responseFormat = execOptions?.responseFormat || pc.responseFormat || null;
  // Enable Anthropic-style cache_control injection when the caller signals it
  // OR when the model name matches a known Anthropic route (auto-detect).
  // Safe to leave off for standard OpenAI — unknown fields are ignored by the API.
  const promptCaching = shouldEnablePromptCaching(pc, execOptions);

  let messages = history.map(historyEntryToChatMessage).filter(Boolean);
  messages = normalizeMessages(messages, pc);

  // Prepend system prompt if provided and not already present in history.
  // With prompt caching: emit as an array content block so cache_control
  // can be attached to the final item (Claude Code pattern).
  if (systemPrompt && !messages.some((m) => m.role === "system")) {
    const systemContent = promptCaching
      ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
      : systemPrompt;
    messages = [{ role: "system", content: systemContent }, ...messages];
  }

  // Inject history cache breakpoints for Anthropic caching (Claude Code pattern).
  if (promptCaching) {
    messages = injectHistoryCacheBreakpoints(messages);
  }

  const normalizedTools = Array.isArray(tools)
    ? tools.map(toBosunToolToChat).filter(Boolean)
    : [];

  // Mark the last tool definition with cache_control so Anthropic caches the
  // full tool schema prefix (tools are static across all turns in a session).
  let cachedTools = normalizedTools;
  if (promptCaching && normalizedTools.length > 0) {
    cachedTools = normalizedTools.map((tool, idx) =>
      idx === normalizedTools.length - 1
        ? { ...tool, cache_control: { type: "ephemeral" } }
        : tool,
    );
  }

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(cachedTools.length > 0 ? { tools: cachedTools } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };

  // Anthropic thinking budget via OpenAI-compatible proxy (D.11)
  const thinkingBudget = Number(pc.thinkingBudget || execOptions?.thinkingBudget);
  if (Number.isFinite(thinkingBudget) && thinkingBudget > 0 && promptCaching) {
    // Some Anthropic proxies accept `thinking` as an extension field
    body.thinking = { type: "enabled", budget_tokens: Math.trunc(thinkingBudget) };
  }

  // Structured output (D.8)
  if (responseFormat) {
    if (responseFormat.type === "json_schema" && responseFormat.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: responseFormat.name || "response",
          schema: responseFormat.jsonSchema,
          strict: responseFormat.strict !== false,
        },
      };
    } else if (responseFormat.type === "json_object") {
      body.response_format = { type: "json_object" };
    } else if (responseFormat.type === "text") {
      body.response_format = { type: "text" };
    }
  }

  return body;
}

// ── SSE Stream Parsing ───────────────────────────────────────────────────────

/**
 * Parse a Server-Sent Events response body into an async iterator of
 * { event?, data } objects.  Works with Node.js 18+ native fetch.
 */
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
      buffer = lines.pop() ?? ""; // last incomplete line stays in buffer

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

// ── Responses API Stream Processor ──────────────────────────────────────────

/**
 * Stream a single Responses API call and collect the result.
 * Returns { text, toolCalls, stopReason, usage, responseId }
 *
 * Emits onEvent callbacks for live UI updates.
 */
async function streamResponsesTurn(url, headers, body, execOptions) {
  const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
  // _emitDelta is injected by exec() to route raw deltas through the smooth-stream buffer.
  // When set, raw delta text is NOT forwarded directly; the smoother emits chunked events.
  const emitDelta = typeof execOptions?._emitDelta === "function" ? execOptions._emitDelta : null;
  const signal = execOptions?.abortController?.signal ?? null;
  const sessionId = toTrimmedString(execOptions?.sessionId || "");
  const timeoutMs = Number(execOptions?.timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS;

  let text = "";
  let usage = null;
  let stopReason = null;
  let responseId = null;
  const toolCalls = new Map(); // callId → { name, argumentsRaw }

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
      headers,
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
    let errBody = "";
    try { errBody = await response.text(); } catch { /* ignore */ }
    throw new Error(
      `OpenAI API error ${response.status}: ${errBody.slice(0, 500)}`,
    );
  }

  try {
    for await (const { event, data } of parseSseStream(response, fetchSignal)) {
      resetIdleTimer();
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      // Responses API events are keyed by event name
      const eventType = event || parsed.type || "";

      if (eventType === "response.created" || eventType.startsWith("response.created")) {
        responseId = toTrimmedString(parsed.response?.id || parsed.id || "");
        onEvent?.({ type: "session.stream.start", sessionId, responseId });
        continue;
      }

      if (eventType.includes("output_text.delta")) {
        // IMPORTANT: do NOT trim here. The Responses API streams tokens with
        // leading/trailing whitespace (e.g. " word", "word "); trimming each
        // delta would concatenate words with no spaces between them.
        const rawDelta = parsed.delta ?? parsed.text ?? "";
        const delta = typeof rawDelta === "string" ? rawDelta : String(rawDelta);
        if (delta) {
          text += delta;
          // Route through smoother when available; otherwise emit directly.
          if (emitDelta) {
            await emitDelta(delta);
          } else {
            onEvent?.({ type: "session.stream.delta", sessionId, delta, text });
          }
        }
        continue;
      }

      if (eventType.includes("function_call_arguments.delta")) {
        const callId = toTrimmedString(parsed.call_id || parsed.item_id || "");
        // Function-call argument JSON must also preserve whitespace within
        // string literals; trimming corrupts the resulting JSON parse.
        const rawArgsDelta = parsed.delta ?? "";
        const delta = typeof rawArgsDelta === "string" ? rawArgsDelta : String(rawArgsDelta);
        if (callId && delta) {
          const existing = toolCalls.get(callId) || { name: "", argumentsRaw: "" };
          existing.argumentsRaw += delta;
          toolCalls.set(callId, existing);
        }
        continue;
      }

      if (eventType.includes("output_item.added") || eventType.includes("output_item.done")) {
        const item = parsed.item || parsed;
        if (item?.type === "function_call") {
          const callId = toTrimmedString(item.call_id || item.id || "");
          const name = toTrimmedString(item.name || "");
          if (callId && name) {
            const existing = toolCalls.get(callId) || { name: "", argumentsRaw: item.arguments || "" };
            existing.name = name;
            if (item.arguments) existing.argumentsRaw = item.arguments;
            toolCalls.set(callId, existing);
          }
        }
        continue;
      }

      if (eventType.includes("response.completed") || eventType === "response.completed") {
        const r = parsed.response || parsed;
        responseId = toTrimmedString(r.id || responseId);
        stopReason = toTrimmedString(r.status || r.stop_reason || r.finish_reason || "stop");
        if (r.usage) {
          usage = normalizeProviderUsageMetadata({
            input_tokens: r.usage.input_tokens,
            output_tokens: r.usage.output_tokens,
            total_tokens: r.usage.total_tokens,
            cache_input_tokens: r.usage.input_tokens_details?.cached_tokens,
          });
        }
        // Extract full output text from completed event if missing from deltas
        if (!text && r.output) {
          for (const item of Array.isArray(r.output) ? r.output : []) {
            if (item?.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (part?.type === "output_text" && part.text) text += part.text;
              }
            }
          }
        }
        onEvent?.({ type: "session.stream.complete", sessionId, text, usage, stopReason });
        break;
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }

  const resolvedToolCalls = [...toolCalls.entries()]
    .filter(([, tc]) => tc.name && tc.name.length > 0)
    .map(([callId, tc]) => ({
    callId,
    name: tc.name,
    arguments: (() => {
      try { return JSON.parse(tc.argumentsRaw); } catch { return tc.argumentsRaw; }
    })(),
    argumentsRaw: tc.argumentsRaw,
  }));

  return { text, toolCalls: resolvedToolCalls, stopReason, usage, responseId };
}

// ── Chat Completions Stream Processor ───────────────────────────────────────

/**
 * Stream a single Chat Completions call and collect the result.
 * Returns { text, toolCalls, stopReason, usage }
 */
async function streamChatTurn(url, headers, body, execOptions) {
  const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
  const emitDelta = typeof execOptions?._emitDelta === "function" ? execOptions._emitDelta : null;
  const signal = execOptions?.abortController?.signal ?? null;
  const sessionId = toTrimmedString(execOptions?.sessionId || "");
  const timeoutMs = Number(execOptions?.timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS;

  let text = "";
  let usage = null;
  let stopReason = null;
  const pendingToolCalls = new Map(); // index → { id, name, argumentsRaw }

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
      headers,
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
    let errBody = "";
    try { errBody = await response.text(); } catch { /* ignore */ }
    throw new Error(`OpenAI API error ${response.status}: ${errBody.slice(0, 500)}`);
  }

  try {
    for await (const { data } of parseSseStream(response, fetchSignal)) {
      resetIdleTimer();
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
      const delta = choice?.delta ?? {};

      if (delta.content) {
        text += delta.content;
        if (emitDelta) {
          await emitDelta(delta.content);
        } else {
          onEvent?.({ type: "session.stream.delta", sessionId, delta: delta.content, text });
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index ?? 0;
          const existing = pendingToolCalls.get(idx) || { id: "", name: "", argumentsRaw: "" };
          if (tcDelta.id) existing.id = tcDelta.id;
          if (tcDelta.function?.name) existing.name += tcDelta.function.name;
          if (tcDelta.function?.arguments) existing.argumentsRaw += tcDelta.function.arguments;
          pendingToolCalls.set(idx, existing);
        }
      }

      if (choice?.finish_reason) {
        stopReason = choice.finish_reason;
      }

      if (parsed.usage) {
        usage = normalizeProviderUsageMetadata({
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
          total_tokens: parsed.usage.total_tokens,
          cached_tokens: parsed.usage.prompt_tokens_details?.cached_tokens,
        });
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }

  onEvent?.({ type: "session.stream.complete", sessionId, text, usage, stopReason });

  const resolvedToolCalls = [...pendingToolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      callId: tc.id,
      name: tc.name,
      arguments: (() => {
        try { return JSON.parse(tc.argumentsRaw); } catch { return tc.argumentsRaw; }
      })(),
      argumentsRaw: tc.argumentsRaw,
    }));

  return { text, toolCalls: resolvedToolCalls, stopReason, usage };
}

// ── Summarisation API Call ───────────────────────────────────────────────────

/**
 * Makes a lightweight, non-streaming Chat Completions call to summarise
 * a slice of conversation history.  Used by the compaction system when it
 * needs to generate a checkpoint narrative.
 *
 * Always uses Chat Completions (not Responses API) for simplicity — no SSE,
 * just a plain JSON response.  A small, fast model (e.g. gpt-4o-mini) is
 * preferred so compaction is cheap.
 *
 * @param {Object[]} entries     History entries to summarise
 * @param {Object}   execOptions Standard exec options (provides URL/creds)
 * @param {string}   [summaryModel]  Override model for the summary call
 * @returns {Promise<{ summary: string, usage: object|null }>}
 */
async function callSummarisationApi(entries, execOptions, summaryModel) {
  // Build the summarisation prompt inline (mirrors context-compaction internals)
  const dialogue = entries.map((e) => {
    switch (e?.type) {
      case "user_message":            return `USER:\n${e.text ?? ""}`;
      case "assistant_message":       return `ASSISTANT:\n${e.text || "(tool-only turn)"}`;
      case "function_call":           return `TOOL CALL [${e.name}]:\n${typeof e.arguments === "string" ? e.arguments : JSON.stringify(e.arguments ?? {})}`;
      case "function_call_output":    return `TOOL RESULT:\n${String(e.output ?? "").slice(0, 2000)}`;
      case "compaction_checkpoint":   return `[PRIOR SUMMARY]\n${e.text ?? ""}`;
      default: return "";
    }
  }).filter(Boolean).join("\n\n---\n\n");

  const userPrompt =
    `Summarize the following conversation for context continuity.\n\n` +
    `CONVERSATION:\n\n${dialogue}\n\n` +
    `Write a structured summary with: Goal, Progress & Decisions, Key Technical Details, ` +
    `Current State, Pending Actions. Preserve all file paths, function names, and code snippets.`;

  // Use the cheapest/fastest available model for the summary call
  const pc    = execOptions?.providerConfig ?? {};
  const model = toTrimmedString(summaryModel || pc.summaryModel || pc.compactionModel || "gpt-4o-mini");
  const url   = resolveEndpointUrl({ ...execOptions, providerConfig: { ...pc, model } }, "chat-completions");
  const creds = resolveCredentials(execOptions);
  const headers = {
    ...buildAuthHeaders(creds),
    Accept: "application/json",  // override SSE accept for non-streaming
  };

  const body = {
    model,
    messages: [
      {
        role: "system",
        content: "You are an expert at summarizing technical AI coding-assistant sessions concisely and accurately.",
      },
      { role: "user", content: userPrompt },
    ],
    stream: false,
    max_tokens: 2048,
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort("summarisation_timeout"), 30_000);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    let errBody = "";
    try { errBody = await response.text(); } catch { /* ignore */ }
    throw new Error(`Summarisation API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const json = await response.json();
  const summary = toTrimmedString(json?.choices?.[0]?.message?.content || "");
  const usage   = json?.usage
    ? normalizeProviderUsageMetadata({
        prompt_tokens: json.usage.prompt_tokens,
        completion_tokens: json.usage.completion_tokens,
        total_tokens: json.usage.total_tokens,
      })
    : null;

  return { summary, usage };
}

// ── Adapter Factory ──────────────────────────────────────────────────────────

export function createOpenAINativeAdapter(factoryOptions = {}) {
  // Per-session conversation state
  // Each entry: { messages: HistoryEntry[], busy: bool, model: string, lastResponseId: string|null }
  const _sessions = new Map();
  const _busySet = new Set();

  // Session persistence (D.9)
  const _resumer = createSessionResumer(factoryOptions.sessionStore);

  function getSession(sessionId) {
    if (!sessionId) return null;
    return _sessions.get(sessionId) ?? null;
  }

  async function ensureSession(sessionId, model = "") {
    if (!sessionId) return { messages: [], model, lastResponseId: null };
    if (!_sessions.has(sessionId)) {
      // Try to resume from disk before creating a fresh session (D.9)
      const { resumed, session } = await _resumer.tryResume(sessionId, model);
      if (resumed && session) {
        _sessions.set(sessionId, {
          messages: session.messages,
          model: session.model || model || "",
          lastResponseId: session.lastResponseId || null,
          aggregatedUsage: session.aggregatedUsage || null,
          compactionCount: session.compactionCount || 0,
        });
      } else {
        _sessions.set(sessionId, { messages: [], model: model || "", lastResponseId: null });
      }
    }
    const s = _sessions.get(sessionId);
    if (model && !s.model) s.model = model;
    return s;
  }

  function resolveApiStyle(execOptions) {
    const pc = execOptions?.providerConfig ?? {};
    const styleRaw = toTrimmedString(
      pc.transport?.apiStyle || pc.apiStyle || execOptions?.apiStyle || "",
    ).toLowerCase();
    if (styleRaw === "chat-completions" || styleRaw === "chat_completions") {
      return "chat-completions";
    }
    // Default to responses for OpenAI/Azure; fall back to chat for compatible
    if (styleRaw === "chat" || styleRaw === "openai-chat") return "chat-completions";
    return "responses";
  }

  /**
   * Execute one tool round: call the orchestrator for each pending tool call
   * and collect results.
   *
   * Upgraded to use the shared ToolExecutor which provides:
   *   - Parallel vs serial classification (write-pattern heuristic + explicit flag)
   *   - Per-tool abort signal with configurable timeout
   *   - Approval gating (needsApproval on tool definition)
   *   - Doom-loop detection across rounds
   *   - Tool-call repair for malformed/missing-args calls (AI SDK pattern)
   */
  async function executeToolCalls(toolCalls, execOptions) {
    const sessionId    = toTrimmedString(execOptions?.sessionId || "");
    const onEvent      = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;
    const toolDefs     = execOptions?.toolDefinitions ?? {};

    // ── Tool-call repair (AI SDK ToolCallRepairFunction pattern) ────────────
    // Detect calls with bad JSON or missing required args before dispatching.
    const broken = detectBrokenToolCalls(toolCalls, toolDefs);
    let repairedCalls = toolCalls;
    if (broken.length > 0) {
      onEvent?.({
        type: "session.tool.repair_start",
        sessionId,
        brokenCount: broken.length,
        broken: broken.map((b) => ({ name: b.tc?.name, reason: b.reason })),
      });
      const repairs = await repairToolCalls(broken, execOptions);
      repairedCalls = applyRepairs(toolCalls, repairs);
      const repaired = repairs.filter((r) => r.success).length;
      onEvent?.({
        type: "session.tool.repair_complete",
        sessionId,
        repaired,
        failed: repairs.length - repaired,
      });
    }

    // ── Dispatch via ToolExecutor (parallel + serial batching) ────────────
    const { results, doomLoopDetected, anyTimedOut } =
      await _toolExecutor.execute(repairedCalls, { ...execOptions, sessionId });

    if (doomLoopDetected) {
      onEvent?.({ type: "session.warn", sessionId, warning: "doom_loop_detected" });
    }
    if (anyTimedOut) {
      onEvent?.({ type: "session.warn", sessionId, warning: "tool_timeout" });
    }

    return results;
  }

  /**
   * Main exec function.  Runs a full turn including the tool-call loop.
   *
   * Compaction hooks:
   *   - /compact slash command → immediate manual compaction, no API call
   *   - proactive check before the while loop (≥ 70% context window)
   *   - pre_tool check before each tool-call round (≥ 85%)
   *   - overflow retry when the API returns context_length_exceeded (rollback)
   */
  async function exec(userMessage, execOptions = {}) {
    const sessionId = toTrimmedString(execOptions?.sessionId || "") || null;
    const isPersistent = Boolean(sessionId) || execOptions?.persistent === true;
    const effectiveSessionId = sessionId || `native-ephemeral-${Date.now()}`;

    if (_busySet.has(effectiveSessionId)) {
      return {
        ok: false,
        success: false,
        finalResponse: "Agent is busy with another turn. Please wait.",
        items: [],
        usage: null,
      };
    }
    _busySet.add(effectiveSessionId);

    const pc = execOptions?.providerConfig ?? {};
    const model = toTrimmedString(pc.model || execOptions?.model || "gpt-4o");
    const apiStyle = resolveApiStyle(execOptions);
    const credentials = resolveCredentials(execOptions);

    // Azure deployment names often differ from short model aliases — resolve
    // the full versioned deployment name before building the request URL.
    // Only needed for classic Azure OpenAI Service (deployment-based URLs).
    // Azure AI Foundry endpoints with /openai/v1 use model names in the body.
    if (credentials.isAzure && model) {
      const env = execOptions?.env ?? process.env;
      const rawEndpoint = toTrimmedString(pc.endpoint || pc.baseUrl || env.OPENAI_BASE_URL || "");
      const usesDeploymentPath = !/\/openai\/v\d+\/?$/.test(rawEndpoint);
      if (usesDeploymentPath) {
        const base = trimTrailingSlashes(rawEndpoint).replace(/\/openai$/, "");
        const resolved = await resolveAzureDeploymentName(base, model, credentials.apiKey);
        if (resolved !== model) {
          execOptions = { ...execOptions, providerConfig: { ...pc, deployment: resolved } };
        }
      }
    }

    const url = resolveEndpointUrl(execOptions, apiStyle);
    const authHeaders = buildAuthHeaders(credentials);
    let tools = Array.isArray(execOptions?.tools) ? execOptions.tools : [];

    // ── MCP tool discovery (D.7) ────────────────────────────────────────────
    // If execOptions references MCP servers, resolve their tool schemas and
    // merge them into the native tool list.  Also wrap the orchestrator so
    // MCP namespaced calls (mcp__server__tool) are routed correctly.
    const mcpServerConfigs = execOptions?.mcpServers || pc?.mcpServers || [];
    if (mcpServerConfigs.length > 0) {
      try {
        tools = await resolveMcpTools(tools, mcpServerConfigs);
      } catch (err) {
        console.warn(`${TAG} MCP tool resolution failed: ${err?.message || err}`);
      }
    }

    // Wrap toolOrchestrator with MCP routing if not already wrapped
    if (!execOptions?._mcpWrapped) {
      const originalOrchestrator = execOptions?.toolOrchestrator || null;
      execOptions = {
        ...execOptions,
        toolOrchestrator: createMcpToolOrchestrator(originalOrchestrator),
        _mcpWrapped: true,
      };
    }

    // Load or init session history (D.9 — resume from disk when available)
    const session = await ensureSession(isPersistent ? effectiveSessionId : null, model);
    if (model && !session.model) session.model = model;

    const onEvent = typeof execOptions?.onEvent === "function" ? execOptions.onEvent : null;

    // ── Stop condition + prepareStep (AI SDK pattern) ─────────────────────────
    // stopWhen: halt the tool loop when the condition is met (overrides MAX_TOOL_ROUNDS).
    // prepareStep: mutate execOptions per-step (model/tools/temperature overrides).
    const stopWhen    = execOptions?.stopWhen    ?? null;
    const prepareStepFn = execOptions?.prepareStep ?? null;

    // ── Smooth streaming setup ────────────────────────────────────────────────
    // Wrap onEvent delta emissions through the smoother for this session.
    const smoother = _smoothers.get(effectiveSessionId);
    smoother.reset();
    const emitDelta = onEvent
      ? async (delta) => {
          await smoother.feed(delta, (chunk) =>
            onEvent({ type: "session.stream.delta", sessionId: effectiveSessionId, delta: chunk })
          );
        }
      : null;
    const flushSmoother = async () => {
      if (!onEvent) return;
      await smoother.flush((chunk) =>
        onEvent({ type: "session.stream.delta", sessionId: effectiveSessionId, delta: chunk })
      );
    };

    // ── /compact slash command ────────────────────────────────────────────────
    // Allows the user to explicitly trigger compaction at any time.
    const trimmedMsg = String(userMessage || "").trim().toLowerCase();
    if (trimmedMsg === "/compact" || trimmedMsg === "/compact manual") {
      _busySet.delete(effectiveSessionId);
      const compactResult = await _compactor.compact(session, {
        strategy: "manual",
        summarise: (entries) => callSummarisationApi(entries, execOptions),
      });
      const budgetAfter = _compactor.getTokenBudget(effectiveSessionId);
      onEvent?.({
        type: "session.compaction",
        sessionId: effectiveSessionId,
        strategy: compactResult.strategy,
        removedCount: compactResult.removedCount,
        checkpointAdded: compactResult.checkpointAdded,
        newMessageCount: compactResult.newMessageCount,
      });
      return {
        ok: true,
        success: true,
        finalResponse: compactResult.checkpointAdded
          ? `Compacted ${compactResult.removedCount} messages into a checkpoint summary.\n\n` +
            `${compactResult.summaryText}\n\n` +
            `(${compactResult.newMessageCount} messages remain in context.)`
          : `Rolled back ${compactResult.removedCount} messages. ` +
            `(${compactResult.newMessageCount} messages remain.)`,
        text: compactResult.summaryText ?? "",
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
        compacted: true,
        compactionResult: compactResult,
        tokenBudget: budgetAfter,
      };
    }

    // ── /undo, /clear, /status slash commands (§D.5) ─────────────────────────
    // Lightweight session-management commands that never make an API call.
    if (trimmedMsg === "/undo") {
      _busySet.delete(effectiveSessionId);
      const removed = [];
      // Remove trailing function_call_output / function_call pairs first, then
      // the most recent assistant_message + user_message pair.
      while (session.messages.length > 0) {
        const tail = session.messages.at(-1);
        if (!tail) break;
        if (tail.type === "function_call_output" || tail.type === "function_call") {
          removed.push(session.messages.pop());
          continue;
        }
        if (tail.type === "assistant_message") {
          removed.push(session.messages.pop());
          // Now drop the matching user_message that prompted it, if present.
          const next = session.messages.at(-1);
          if (next?.type === "user_message") removed.push(session.messages.pop());
          break;
        }
        if (tail.type === "user_message") {
          removed.push(session.messages.pop());
          break;
        }
        break;
      }
      session.lastResponseId = null; // can't reuse server-side thread after undo
      onEvent?.({
        type: "session.undo",
        sessionId: effectiveSessionId,
        removedCount: removed.length,
        newMessageCount: session.messages.length,
      });
      return {
        ok: true,
        success: true,
        finalResponse: `Undid last turn (removed ${removed.length} entries; ` +
          `${session.messages.length} remain).`,
        text: "",
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
        undone: true,
        removedCount: removed.length,
      };
    }

    if (trimmedMsg === "/clear") {
      _busySet.delete(effectiveSessionId);
      const removedCount = session.messages.length;
      session.messages = [];
      session.lastResponseId = null;
      session.compactionCount = 0;
      onEvent?.({
        type: "session.cleared",
        sessionId: effectiveSessionId,
        removedCount,
      });
      return {
        ok: true,
        success: true,
        finalResponse: `Cleared session history (${removedCount} entries removed). ` +
          `System prompt and model preserved.`,
        text: "",
        items: [],
        usage: null,
        sessionId: effectiveSessionId,
        cleared: true,
        removedCount,
      };
    }

    if (trimmedMsg === "/status") {
      _busySet.delete(effectiveSessionId);
      const tokenBudget = _compactor.getTokenBudget(effectiveSessionId);
      const status = {
        sessionId: effectiveSessionId,
        model: session.model || model,
        apiStyle,
        messageCount: session.messages.length,
        compactionCount: session.compactionCount ?? 0,
        estimatedTokens: estimateTokenCount(session.messages),
        tokenBudget,
        lastResponseId: session.lastResponseId ?? null,
      };
      onEvent?.({ type: "session.status", ...status });
      const lines = [
        `Session ${status.sessionId}`,
        `Model: ${status.model} (${status.apiStyle})`,
        `Messages: ${status.messageCount} (≈${status.estimatedTokens} tokens)`,
        `Compactions so far: ${status.compactionCount}`,
        tokenBudget?.contextWindow
          ? `Context window: ${tokenBudget.usedPct ?? 0}% used (${tokenBudget.usedTokens ?? 0}/${tokenBudget.contextWindow})`
          : null,
        status.lastResponseId ? `Last response id: ${status.lastResponseId}` : null,
      ].filter(Boolean);
      return {
        ok: true,
        success: true,
        finalResponse: lines.join("\n"),
        text: lines.join("\n"),
        items: session.messages,
        usage: null,
        sessionId: effectiveSessionId,
        status,
        tokenBudget,
      };
    }

    // ── /resume slash command (D.9) ─────────────────────────────────────────
    if (trimmedMsg.startsWith("/resume ")) {
      _busySet.delete(effectiveSessionId);
      const targetId = trimmedMsg.slice("/resume ".length).trim();
      if (!targetId) {
        return {
          ok: false,
          success: false,
          finalResponse: "Usage: /resume <session_id>",
          text: "",
          items: [],
          usage: null,
          sessionId: effectiveSessionId,
        };
      }
      const { resumed, session: loaded } = await _resumer.tryResume(targetId, model);
      if (resumed && loaded) {
        _sessions.set(targetId, {
          messages: loaded.messages,
          model: loaded.model || model,
          lastResponseId: loaded.lastResponseId || null,
          aggregatedUsage: loaded.aggregatedUsage || null,
          compactionCount: loaded.compactionCount || 0,
        });
        onEvent?.({ type: "session.resumed", sessionId: targetId, messageCount: loaded.messages.length });
        return {
          ok: true,
          success: true,
          finalResponse: `Resumed session ${targetId} (${loaded.messages.length} messages).`,
          text: "",
          items: loaded.messages,
          usage: null,
          sessionId: targetId,
          resumed: true,
        };
      }
      return {
        ok: false,
        success: false,
        finalResponse: `Session "${targetId}" not found on disk.`,
        text: "",
        items: [],
        usage: null,
        sessionId: effectiveSessionId,
      };
    }

    // Append user turn
    session.messages.push(sanitizeHistoryEntryForRequest({
      type: "user_message",
      text: String(userMessage || ""),
    }));

    onEvent?.({ type: "session.turn.start", sessionId: effectiveSessionId, model, apiStyle });

    // ── Proactive compaction ──────────────────────────────────────────────────
    // Fire before the first API call when context is within 70–95%.
    const proactiveDecision = _compactor.shouldCompact(session, { model });
    if (proactiveDecision.shouldCompact &&
        (proactiveDecision.strategy === "proactive" ||
         proactiveDecision.strategy === "head_truncate")) {
      const compactResult = await _compactor.compact(session, {
        strategy: proactiveDecision.strategy,
        summarise: (entries) => callSummarisationApi(entries, execOptions),
      });
      if (compactResult.compacted) {
        onEvent?.({
          type: "session.compaction",
          sessionId: effectiveSessionId,
          strategy: compactResult.strategy,
          removedCount: compactResult.removedCount,
          checkpointAdded: compactResult.checkpointAdded,
          newMessageCount: compactResult.newMessageCount,
          urgency: proactiveDecision.urgency,
        });
      }
    }

    let aggregatedUsage = null;
    let finalText = "";
    let roundCount = 0;
    // Active execOptions may be mutated per-step by prepareStep
    let activeOpts = execOptions;
    // Hard cost budget cap (§D.3). When exceeded we emit
    // session.budget.exceeded and throw BudgetExceededError before the next round.
    const maxCostUsd = Number(
      execOptions?.maxCostUsd ?? pc?.maxCostUsd ?? 0,
    ) || 0;

    try {
      while (roundCount < MAX_TOOL_ROUNDS) {
        roundCount++;
        const stepState = {
          stepNumber: roundCount,
          roundCount,
          toolCalls: [],
          toolResults: [],
          stopReason: "",
          text: finalText,
          sessionId: effectiveSessionId,
        };

        // Check stop condition before this step (skips step 1 to always run at least one turn)
        if (roundCount > 1 && stopWhen && await isStopConditionMet(stopWhen, stepState)) {
          onEvent?.({ type: "session.warn", sessionId: effectiveSessionId, warning: "stop_condition_met", stepNumber: roundCount });
          break;
        }

        // Apply prepareStep overrides (model/tools/temperature per step)
        if (prepareStepFn) {
          activeOpts = await resolvePrepareStep(prepareStepFn, stepState, activeOpts);
        }

        // Resolve active model/pc each step (prepareStep may have changed them)
        const activePC    = activeOpts?.providerConfig ?? pc;
        const activeModel = toTrimmedString(activePC.model || activeOpts?.model || model);
        const activeTools = Array.isArray(activeOpts?.tools) ? activeOpts.tools : tools;

        // ── Tiered disk-backed shredding + inline pruning (D.10) ─────────────
        // First apply age-based compression with disk archival so no data is lost.
        // Then prune reasoning tokens and cap oversized outputs inline.
        try {
          session.messages = await maybeCompressSessionItems(session.messages, {
            sessionType: "primary",
            agentType: "openai-native",
            sessionId: effectiveSessionId,
          });
        } catch (err) {
          console.warn(`[openai-native-adapter] shredding failed: ${err?.message || err}`);
        }
        session.messages = pruneMessages(session.messages, {
          stripReasoning:    true,
          truncateOutputs:   true,
          maxToolOutputChars: 8_000,
        });
        session.messages = sanitizeHistoryEntriesForRequest(session.messages);

        // Stream one API turn — with overflow retry on first context error
        let turnResult;
        let overflowRetried = false;
        for (let attempt = 0; attempt <= 1; attempt++) {
          try {
            if (apiStyle === "chat-completions") {
              const chatBody = buildChatRequest(session.messages, activeTools, { ...activeOpts, providerConfig: { ...activePC, model: activeModel } });
              turnResult = await streamChatTurn(url, authHeaders, chatBody, { ...activeOpts, _emitDelta: emitDelta });
            } else {
              const responsesBody = buildResponsesRequest(session.messages, activeTools, { ...activeOpts, providerConfig: { ...activePC, model: activeModel } }, session.lastResponseId, isPersistent);
              turnResult = await streamResponsesTurn(url, authHeaders, responsesBody, { ...activeOpts, _emitDelta: emitDelta });
            }
            break; // success — exit retry loop

          } catch (apiErr) {
            if (!overflowRetried && isContextOverflowError(apiErr)) {
              overflowRetried = true;
              // Rollback without extra API call — fast and safe
              const overflowResult = await _compactor.onContextOverflow(session, {
                summarise: (entries) => callSummarisationApi(entries, execOptions),
              });
              if (!overflowResult.compacted) throw apiErr; // nothing could be dropped
              onEvent?.({
                type: "session.compaction",
                sessionId: effectiveSessionId,
                strategy: overflowResult.strategy,
                removedCount: overflowResult.removedCount,
                checkpointAdded: overflowResult.checkpointAdded,
                newMessageCount: overflowResult.newMessageCount,
                urgency: "critical",
              });
              // Loop will retry with the compacted history
            } else {
              throw apiErr; // not an overflow error, or already retried
            }
          }
        }

        finalText = turnResult.text;

        // Flush stream smoother after each LLM turn
        await flushSmoother();

        // Store last response ID for server-side thread continuation (Responses API)
        if (turnResult.responseId && isPersistent) {
          session.lastResponseId = turnResult.responseId;
        }

        // Record actual usage for future shouldCompact() calls
        if (turnResult.usage) {
          // Populate costUsd from pricing table if API didn't return it
          if (!turnResult.usage.costUsd || turnResult.usage.costUsd === 0) {
            const computedCost = estimateCostFromUsage(activeModel, turnResult.usage);
            if (computedCost > 0) turnResult.usage.costUsd = computedCost;
          }
          _compactor.recordUsage(effectiveSessionId, turnResult.usage);
          if (!aggregatedUsage) {
            aggregatedUsage = { ...turnResult.usage };
          } else {
            aggregatedUsage.inputTokens  = (aggregatedUsage.inputTokens  || 0) + (turnResult.usage.inputTokens  || 0);
            aggregatedUsage.outputTokens = (aggregatedUsage.outputTokens || 0) + (turnResult.usage.outputTokens || 0);
            aggregatedUsage.totalTokens  = (aggregatedUsage.totalTokens  || 0) + (turnResult.usage.totalTokens  || 0);
            aggregatedUsage.cacheInputTokens = (aggregatedUsage.cacheInputTokens || 0) + (turnResult.usage.cacheInputTokens || 0);
            // Anthropic bills cache_creation_input_tokens separately from
            // cached reads; track it on its own field when the provider
            // surfaces it (§D.6 / §B.2).
            aggregatedUsage.cacheCreationInputTokens =
              (aggregatedUsage.cacheCreationInputTokens || 0) +
              (turnResult.usage.cacheCreationInputTokens || 0);
            aggregatedUsage.costUsd      = (aggregatedUsage.costUsd      || 0) + (turnResult.usage.costUsd      || 0);
          }
        }

        // ── Hard cost budget enforcement (§D.3) ───────────────────────────────
        // Surface a session.budget.update event every round so dashboards can
        // render a live cost meter; throw BudgetExceededError when the cap is
        // crossed so callers can catch and surface a clean abort to the user.
        const cumulativeCostUsd = Number(aggregatedUsage?.costUsd) || 0;
        const cacheHitPctRound = computeCacheHitPct(aggregatedUsage);
        onEvent?.({
          type: "session.budget.update",
          sessionId: effectiveSessionId,
          stepNumber: roundCount,
          cumulativeCostUsd,
          maxCostUsd,
          cacheHitPct: cacheHitPctRound,
          usage: aggregatedUsage ? { ...aggregatedUsage } : null,
        });
        if (maxCostUsd > 0 && cumulativeCostUsd > maxCostUsd) {
          onEvent?.({
            type: "session.budget.exceeded",
            sessionId: effectiveSessionId,
            stepNumber: roundCount,
            cumulativeCostUsd,
            limitUsd: maxCostUsd,
          });
          throw new BudgetExceededError(
            `Session cost $${cumulativeCostUsd.toFixed(4)} exceeded limit $${maxCostUsd.toFixed(4)}`,
            { sessionId: effectiveSessionId, costUsd: cumulativeCostUsd, limitUsd: maxCostUsd },
          );
        }

        // Append assistant turn to history (before tool results)
        const assistantEntry = {
          type: "assistant_message",
          text: finalText,
          toolCalls: turnResult.toolCalls.map((tc) => ({
            callId: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
          })),
        };
        session.messages.push(sanitizeHistoryEntryForRequest(assistantEntry));

        // No tool calls → done
        if (!turnResult.toolCalls.length) break;

        // Check stop reason
        const stopReason = toTrimmedString(turnResult.stopReason || "").toLowerCase();
        if (stopReason === "stop" || stopReason === "end_turn" || stopReason === "max_tokens") {
          if (stopReason === "max_tokens") {
            onEvent?.({ type: "session.warn", sessionId: effectiveSessionId, warning: "max_tokens reached" });
          }
          break;
        }

        // ── Pre-tool compaction ───────────────────────────────────────────────
        // Before executing tools (which may add large outputs), compact if needed.
        const preToolDecision = _compactor.shouldCompact(session, { model, beforeToolRound: true });
        if (preToolDecision.shouldCompact) {
          const compactResult = await _compactor.compact(session, {
            strategy: preToolDecision.strategy,
            summarise: (entries) => callSummarisationApi(entries, execOptions),
          });
          if (compactResult.compacted) {
            onEvent?.({
              type: "session.compaction",
              sessionId: effectiveSessionId,
              strategy: compactResult.strategy,
              removedCount: compactResult.removedCount,
              checkpointAdded: compactResult.checkpointAdded,
              newMessageCount: compactResult.newMessageCount,
              urgency: preToolDecision.urgency,
            });
          }
        }

        // Update step state with this turn's tool calls for stop-condition evaluation
        stepState.toolCalls = turnResult.toolCalls;
        stepState.stopReason = turnResult.stopReason || "";
        stepState.text = finalText;

        // Check stop condition now that we know what tools were called
        if (stopWhen && await isStopConditionMet(stopWhen, stepState)) {
          onEvent?.({ type: "session.warn", sessionId: effectiveSessionId, warning: "stop_condition_met", stepNumber: roundCount });
          break;
        }

        // Execute tools
        const toolResults = await executeToolCalls(turnResult.toolCalls, { ...activeOpts, sessionId: effectiveSessionId });
        stepState.toolResults = toolResults;

        // Append function calls and outputs for Responses API format
        if (apiStyle === "responses") {
          for (const tc of turnResult.toolCalls) {
            session.messages.push(sanitizeHistoryEntryForRequest({
              type: "function_call",
              callId: tc.callId,
              name: tc.name,
              arguments: tc.argumentsRaw || JSON.stringify(tc.arguments ?? {}),
            }));
          }
          for (const tr of toolResults) {
            session.messages.push(sanitizeHistoryEntryForRequest({
              type: "function_call_output",
              callId: tr.callId,
              output: tr.output,
            }));
          }
        } else {
          // Chat format: tool results appended directly to messages via historyEntryToChatMessage
          for (const tr of toolResults) {
            session.messages.push(sanitizeHistoryEntryForRequest({
              type: "function_call_output",
              callId: tr.callId,
              output: tr.output,
            }));
          }
        }

        // ── session.step.finish (§D.4) ───────────────────────────────────────
        // Mirrors the AI SDK onStepFinish callback: one event per completed
        // tool-call round bundling the LLM response, tool results, and usage.
        onEvent?.({
          type: "session.step.finish",
          sessionId: effectiveSessionId,
          stepNumber: roundCount,
          text: finalText,
          toolCalls: turnResult.toolCalls.map((tc) => ({
            callId: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
          })),
          toolResults: toolResults.map((tr) => ({
            callId: tr.callId,
            output: tr.output,
          })),
          stopReason: turnResult.stopReason || "",
          usage: turnResult.usage ?? null,
          isContinued: roundCount < MAX_TOOL_ROUNDS,
        });
      }

      if (roundCount >= MAX_TOOL_ROUNDS) {
        onEvent?.({ type: "session.warn", sessionId: effectiveSessionId, warning: "max_tool_rounds reached" });
      }

      // If not persistent, clear history (keep overhead low)
      if (!isPersistent) {
        _sessions.delete(effectiveSessionId);
        _smoothers.remove(effectiveSessionId);
      }

      const tokenBudget = _compactor.getTokenBudget(effectiveSessionId);
      const cacheHitPctFinal = computeCacheHitPct(aggregatedUsage);
      onEvent?.({
        type: "session.turn.complete",
        sessionId: effectiveSessionId,
        text: finalText,
        usage: aggregatedUsage,
        tokenBudget,
        cacheHitPct: cacheHitPctFinal,
        cumulativeCostUsd: Number(aggregatedUsage?.costUsd) || 0,
      });

      return {
        ok: true,
        success: true,
        finalResponse: finalText,
        text: finalText,
        items: session.messages.slice(-Math.min(session.messages.length, 100)),
        usage: aggregatedUsage,
        sessionId: effectiveSessionId,
        model,
        roundCount,
        tokenBudget,
      };
    } catch (err) {
      onEvent?.({ type: "session.turn.error", sessionId: effectiveSessionId, error: String(err?.message || err) });
      // On error, remove the incomplete assistant turn if it was added
      const lastEntry = session.messages.at(-1);
      if (lastEntry?.type === "assistant_message") session.messages.pop();
      // Remove user message too so the turn can be retried cleanly
      const prevEntry = session.messages.at(-1);
      if (prevEntry?.type === "user_message") session.messages.pop();

      if (!isPersistent) {
        _sessions.delete(effectiveSessionId);
        _smoothers.remove(effectiveSessionId);
      }

      return {
        ok: false,
        success: false,
        finalResponse: `Error: ${err?.message || err}`,
        text: "",
        items: [],
        usage: aggregatedUsage,
        sessionId: effectiveSessionId,
      };
    } finally {
      _busySet.delete(effectiveSessionId);
    }
  }

  function isBusy(sessionId) {
    if (sessionId) return _busySet.has(String(sessionId));
    return _busySet.size > 0;
  }

  function getInfo(sessionId) {
    const sid = toTrimmedString(sessionId || "");
    const session = sid ? _sessions.get(sid) : null;
    const tokenBudget = _compactor.getTokenBudget(sid || null);
    return {
      sessionId: sid || null,
      model: session?.model || null,
      messageCount: session?.messages?.length ?? 0,
      busy: isBusy(sid),
      adapterName: "openai-native",
      tokenBudget,
      compactionCount: session?.compactionCount ?? 0,
      estimatedTokens: session ? estimateTokenCount(session.messages) : 0,
    };
  }

  async function init() {
    // No-op: the native adapter has no process to spawn or SDK to initialize.
    // Credentials and endpoints are resolved per-call from execOptions/process.env.
    return true;
  }

  function reset(options = {}) {
    const sessionId = toTrimmedString(options?.sessionId || "");
    if (sessionId) {
      _sessions.delete(sessionId);
      _toolExecutor.resetDoomLoopState(sessionId);
      _smoothers.remove(sessionId);
    } else if (options?.all) {
      _sessions.clear();
      _busySet.clear();
      _smoothers.resetAll();
    }
  }

  function listSessions() {
    return [..._sessions.keys()];
  }

  function getSessionMessages(sessionId) {
    return cloneJson(_sessions.get(toTrimmedString(sessionId))?.messages ?? []);
  }

  return {
    name: "openai-native",
    provider: "OPENAI_NATIVE",
    displayName: "OpenAI Native",
    exec,
    isBusy,
    getInfo,
    init,
    reset,
    listSessions,
    getSessionMessages,
  };
}

export const openaiNativeAdapter = createOpenAINativeAdapter();
export default openaiNativeAdapter;
