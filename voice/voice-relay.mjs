/**
 * voice-relay.mjs — Multi-provider voice relay for real-time voice sessions.
 *
 * Supports:
 *   - OpenAI Realtime API (WebRTC) — direct API key
 *   - Azure OpenAI Realtime API (WebRTC) — API key + endpoint
 *   - Claude/Gemini provider mode (Tier 2 speech fallback + provider vision)
 *   - Tier 2 fallback (browser STT → executor → browser TTS)
 *   - Direct JavaScript action dispatch (voice model returns JSON, Bosun executes)
 *
 * @module voice-relay
 */

import { loadConfig } from "../config/config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName } from "../agent/primary-agent.mjs";
import { resolveVoiceOAuthToken } from "./voice-auth-manager.mjs";
import {
  beginVoiceTurnTrace as beginVoiceTurnTraceState,
  completeVoiceTurnTrace as completeVoiceTurnTraceState,
  abortVoiceTurnTrace as abortVoiceTurnTraceState,
  getVoiceTurnTrace as getVoiceTurnTraceState,
  renderVoiceTurnTrace as renderVoiceTurnTraceState,
  formatVoiceTurnTrace as formatVoiceTurnTraceState,
} from "./vision-session-state.mjs";

// ── Module-scope state ──────────────────────────────────────────────────────
let _voiceConfig = null;   // cached resolved config
let _configLoadedAt = 0;   // timestamp of last config load

const CONFIG_TTL_MS = 30_000; // re-read config every 30s

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
const OPENAI_REALTIME_MODEL = "gpt-realtime-1.5";
const OPENAI_AUDIO_RESPONSES_MODEL = "gpt-audio-1.5";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_DEFAULT_VISION_MODEL = "gpt-4.1-nano";
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

const AZURE_API_VERSION = "2025-04-01-preview";

/**
 * Strip any path suffix from an Azure endpoint URL so code can safely append
 * its own path segments (e.g. /openai/realtime/sessions).
 * Users sometimes paste a full URL like https://foo.openai.azure.com/openai/realtime
 * into the endpoint field; extracting only scheme+host prevents double-path 404s.
 */
function normalizeAzureEndpoint(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s;
  }
}

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4.6";
const CLAUDE_DEFAULT_VISION_MODEL = "claude-sonnet-4.6";
const GEMINI_GENERATE_CONTENT_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro";
const GEMINI_DEFAULT_VISION_MODEL = "gemini-3.0-flash";

function buildOpenAIRealtimeSessionUrl(overrideBase = "") {
  const trimmed = String(overrideBase || "").trim().replace(/\/+$/, "");
  if (!trimmed) return `${OPENAI_REALTIME_URL}/sessions`;
  if (/\/v1\/realtime$/i.test(trimmed)) return `${trimmed}/sessions`;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/realtime/sessions`;
  return `${trimmed}/v1/realtime/sessions`;
}

function buildOpenAIRealtimeWebRtcUrl(model, overrideBase = "") {
  const trimmed = String(overrideBase || "").trim().replace(/\/+$/, "");
  const encodedModel = encodeURIComponent(String(model || OPENAI_REALTIME_MODEL));
  if (!trimmed) return `${OPENAI_REALTIME_URL}?model=${encodedModel}`;
  if (/\/v1\/realtime$/i.test(trimmed)) return `${trimmed}?model=${encodedModel}`;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/realtime?model=${encodedModel}`;
  return `${trimmed}/v1/realtime?model=${encodedModel}`;
}

// GA models (gpt-realtime, gpt-realtime-1.5, gpt-realtime-mini, etc.) use /openai/v1/ paths.
// Preview models (for example gpt-4o-realtime-preview-*) use legacy /openai/realtimeapi/ paths.
// NOTE: Azure AI Foundry "Global Standard" deployments may only support preview paths
// even for GA model names.  We try GA first.  If it 404s the caller falls back to preview.
function isAzureGaProtocol(deployment) {
  const d = String(deployment || "").toLowerCase().trim();
  return d.startsWith("gpt-realtime") && !d.startsWith("gpt-4o-realtime");
}

function normalizeOpenAIRealtimeModel(rawModel) {
  const model = String(rawModel || "").trim();
  if (!model) return OPENAI_REALTIME_MODEL;
  // Audio-only model slugs are not accepted by realtime SDP/session endpoints.
  if (/^gpt-audio/i.test(model)) return OPENAI_REALTIME_MODEL;
  return model;
}

function normalizeAzureRealtimeDeployment(rawDeployment) {
  const deployment = String(rawDeployment || "").trim();
  if (!deployment) return OPENAI_REALTIME_MODEL;
  if (/^gpt-audio/i.test(deployment)) return OPENAI_REALTIME_MODEL;
  return deployment;
}

function parseOptionalBoolean(rawValue) {
  if (rawValue == null) return null;
  const normalized = String(rawValue).trim().toLowerCase();
  if (!normalized) return null;
  return !["0", "false", "no", "off"].includes(normalized);
}

function isOpenAIAudioResponsesModel(rawModel) {
  const model = String(rawModel || "").trim().toLowerCase();
  return /^gpt-audio/.test(model);
}

const VALID_EXECUTORS = new Set([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
]);

const VALID_AGENT_MODES = new Set([
  "ask",
  "agent",
  "plan",
  "web",
  "instant",
  "code",
  "architect",
]);

const VALID_VOICE_PROVIDERS = new Set([
  "openai",
  "azure",
  "claude",
  "gemini",
  "fallback",
]);

/**
 * Check whether a realtime candidate entry has usable credentials.
 * For OAuth entries (authSource === "oauth"), resolves the token from the
 * voice-auth-manager state file instead of requiring a static apiKey.
 */
function candidateHasCredentials(entry, cfg) {
  if (entry.provider === "openai") {
    if (entry.authSource === "oauth") {
      return Boolean(resolveVoiceOAuthToken("openai")?.token || cfg.openaiOAuthToken || cfg.openaiKey);
    }
    return Boolean(entry.apiKey || cfg.openaiOAuthToken || cfg.openaiKey);
  }
  if (entry.provider === "azure") {
    const hasKey = Boolean(entry.apiKey || cfg.azureOAuthToken || cfg.azureKey);
    const hasEndpoint = Boolean(entry.endpoint || cfg.azureEndpoint);
    return hasKey && hasEndpoint;
  }
  return false;
}

const DEFAULT_VOICE_FAILOVER = Object.freeze({
  enabled: true,
  maxAttempts: 2,
});

function parseFailoverInt(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeVoiceProviderEntry(entry) {
  if (typeof entry === "string") {
    const provider = String(entry || "").trim().toLowerCase();
    if (!VALID_VOICE_PROVIDERS.has(provider)) return null;
    return {
      provider,
      model: null,
      visionModel: null,
      voiceId: null,
      azureDeployment: null,
      endpoint: null,
      apiKey: null,
      authSource: "apiKey",
      role: "primary",
      weight: 100,
      name: null,
      enabled: true,
    };
  }

  if (!entry || typeof entry !== "object") return null;
  const provider = String(entry.provider || "").trim().toLowerCase();
  if (!VALID_VOICE_PROVIDERS.has(provider)) return null;

  const model = String(entry.model || "").trim() || null;
  const visionModel = String(entry.visionModel || "").trim() || null;
  const voiceId = String(entry.voiceId || "").trim() || null;
  const azureDeployment = String(entry.azureDeployment || "").trim() || null;
  const endpoint = String(entry.endpoint || "").trim() || null;
  const apiKey = String(entry.apiKey || "").trim() || null;
  const authSource = ["apiKey", "oauth"].includes(entry.authSource) ? entry.authSource : "apiKey";
  const role = String(entry.role || "primary").trim() || "primary";
  const weight = typeof entry.weight === "number" ? entry.weight : 100;
  const name = String(entry.name || "").trim() || null;
  const enabled = entry.enabled !== false;

  return {
    provider,
    model,
    visionModel,
    voiceId,
    azureDeployment,
    endpoint,
    apiKey,
    authSource,
    role,
    weight,
    name,
    enabled,
  };
}

function normalizeVoiceProviderChain(rawProviders, primaryProvider) {
  const dedup = new Set();
  const chain = [];
  const pushEntry = (entry) => {
    const normalized = normalizeVoiceProviderEntry(entry);
    if (!normalized) return;
    if (dedup.has(normalized.provider)) return;
    dedup.add(normalized.provider);
    chain.push(normalized);
  };

  if (Array.isArray(rawProviders)) {
    rawProviders.forEach(pushEntry);
  } else if (typeof rawProviders === "string" && rawProviders.trim()) {
    rawProviders
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((provider) => pushEntry({ provider }));
  }

  if (primaryProvider && VALID_VOICE_PROVIDERS.has(primaryProvider)) {
    const existingIndex = chain.findIndex((entry) => entry.provider === primaryProvider);
    if (existingIndex > 0) {
      const [entry] = chain.splice(existingIndex, 1);
      chain.unshift(entry);
    } else if (existingIndex === -1) {
      chain.unshift({
        provider: primaryProvider,
        model: null,
        visionModel: null,
        voiceId: null,
        azureDeployment: null,
      });
    }
  }

  return chain;
}

function getProviderChainWithCredentialFallbacks(chain, credentialState = {}) {
  const dedup = new Set();
  const providers = [];
  const pushProvider = (provider) => {
    if (!provider || dedup.has(provider)) return;
    if (!VALID_VOICE_PROVIDERS.has(provider)) return;
    dedup.add(provider);
    providers.push(provider);
  };

  chain.forEach((entry) => pushProvider(entry.provider));

  if (credentialState.azureAvailable) pushProvider("azure");
  if (credentialState.openaiAvailable) pushProvider("openai");
  if (credentialState.claudeAvailable) pushProvider("claude");
  if (credentialState.geminiAvailable) pushProvider("gemini");
  pushProvider("fallback");

  return providers;
}

function shouldFailoverRealtimeError(err) {
  const message = String(err?.message || "");
  const statusMatch = message.match(/\((\d{3})\)/);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : null;
  if (status && (status === 401 || status === 403 || status === 408 || status === 409 || status === 429 || status >= 500)) {
    return true;
  }
  if (/invalid_model|not supported in realtime mode|model .* not supported/i.test(message)) {
    return true;
  }
  if (/ECONNRESET|ETIMEDOUT|network|fetch failed|connection|connect/i.test(message)) {
    return true;
  }
  return false;
}

function redactSecretLikeText(value) {
  let sanitized = String(value || "");
  sanitized = sanitized.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{10,}\b/g, "$1-***REDACTED***");
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer ***REDACTED***");
  sanitized = sanitized.replace(
    /("?(?:api[_-]?key|access[_-]?token|client[_-]?secret|authorization)"?\s*[:=]\s*"?)([^",\s}{\]]+)/gi,
    "$1***REDACTED***",
  );
  return sanitized;
}

async function buildProviderErrorDetails(response, fallback = "unknown") {
  const raw = await response.text().catch(() => fallback);
  return redactSecretLikeText(raw || fallback);
}

function sanitizeVoiceCallContext(context = {}) {
  const rawSessionId = String(context?.sessionId || "").trim();
  const rawExecutor = String(context?.executor || "").trim().toLowerCase();
  const rawMode = String(context?.mode || "").trim().toLowerCase();
  const rawModel = String(context?.model || "").trim();
  const rawVoiceAgentId = String(context?.voiceAgentId || "").trim();
  const rawVoiceAgentName = String(context?.voiceAgentName || "").trim();
  const rawVoiceAgentInstructions = String(context?.voiceAgentInstructions || "").trim();
  const rawVoiceToolCapabilityPrompt = String(context?.voiceToolCapabilityPrompt || "").trim();
  const rawVoiceAgentSkills = Array.isArray(context?.voiceAgentSkills)
    ? context.voiceAgentSkills.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const rawEnabledMcpServers = Array.isArray(context?.enabledMcpServers)
    ? context.enabledMcpServers.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  const rawVoiceAgentSkillsContent = String(context?.voiceAgentSkillsContent || "").trim();

  return {
    sessionId: rawSessionId || null,
    executor: VALID_EXECUTORS.has(rawExecutor) ? rawExecutor : null,
    mode: VALID_AGENT_MODES.has(rawMode) ? rawMode : null,
    model: rawModel || null,
    voiceAgentId: rawVoiceAgentId || null,
    voiceAgentName: rawVoiceAgentName || null,
    voiceAgentInstructions: rawVoiceAgentInstructions || null,
    voiceToolCapabilityPrompt: rawVoiceToolCapabilityPrompt || null,
    voiceAgentSkills: rawVoiceAgentSkills,
    voiceAgentSkillsContent: rawVoiceAgentSkillsContent || null,
    enabledMcpServers: rawEnabledMcpServers,
  };
}

async function buildSessionScopedInstructions(baseInstructions, callContext = {}) {
  const context = sanitizeVoiceCallContext(callContext);
  if (
    !context.sessionId
    && !context.executor
    && !context.mode
    && !context.model
    && !context.voiceAgentId
    && !context.voiceAgentInstructions
    && !context.voiceToolCapabilityPrompt
  ) {
    return baseInstructions;
  }

  // ── Chat history injection ────────────────────────────────────────────
  let chatHistorySection = "";
  if (context.sessionId) {
    try {
      const tracker = await import("../infra/session-tracker.mjs");
      const session = tracker.getSessionById
        ? tracker.getSessionById(context.sessionId)
        : null;
      if (session && Array.isArray(session.messages) && session.messages.length > 0) {
        const shouldIncludeInVoiceHistory = (msg) => {
          if (!msg || typeof msg !== "object") return false;
          const msgType = String(msg.type || "").trim().toLowerCase();
          if (msgType === "tool_call" || msgType === "tool_result") return false;
          const meta = msg.meta && typeof msg.meta === "object" ? msg.meta : {};
          const eventType = String(meta.eventType || "").trim().toLowerCase();
          if (eventType.includes("tool")) return false;
          if (eventType.includes("transcript")) return false;
          if (eventType.startsWith("voice_background_")) return false;
          if (eventType.startsWith("vision_")) return false;
          const source = String(meta.source || "").trim().toLowerCase();
          if (source === "vision") return false;
          const role = String(msg.role || msg.type || "").trim().toLowerCase();
          const content = String(msg.content || "").trim();
          if (!content) return false;
          if (role === "system") return false;
          if (content.startsWith("[Voice Action Started]")) return false;
          if (content.startsWith("[Voice Action Complete]")) return false;
          if (content.startsWith("[Voice Action Error]")) return false;
          if (content.startsWith("[Voice Delegation")) return false;
          if (content.startsWith("[Background Task Started]")) return false;
          if (content.startsWith("[Vision ")) return false;
          return true;
        };
        const recent = session.messages.filter(shouldIncludeInVoiceHistory).slice(-20);
        const lines = recent.map((msg) => {
          const role = String(msg.role || msg.type || "unknown").toUpperCase();
          const content = String(msg.content || "").trim();
          return `[${role}]: ${content}`;
        });
        const historyText = lines.join("\n");
        // Cap at ~3000 chars to avoid bloating the Realtime context
        const capped = historyText.length > 3000
          ? historyText.slice(0, 3000) + "\n... (earlier messages truncated)"
          : historyText;
        chatHistorySection = [
          "",
          "## Recent Chat History",
          "The following are the most recent messages from the active chat session.",
          "Use this context to understand what the user has been working on.",
          capped,
        ].join("\n");
      }
    } catch {
      // best effort — continue without chat history
    }
  }

  // ── Prepend voice agent identity as primary instructions ─────────────
  // voiceInstructions defines who the agent IS (e.g. "You are Nova").
  // It must come BEFORE the base instructions so the model adopts the
  // persona rather than falling back to its default identity.
  if (context.voiceAgentInstructions) {
    baseInstructions = `${context.voiceAgentInstructions}\n\n${baseInstructions}`;
  }

  const suffix = [
    "",
    "## Bosun Voice Call Context",
    `Active chat session id: ${context.sessionId || "none"}.`,
    context.voiceAgentId
      ? `Active voice agent id: ${context.voiceAgentId}.`
      : "Active voice agent id: default.",
    context.voiceAgentName
      ? `Active voice agent name: ${context.voiceAgentName}.`
      : "",
    context.voiceToolCapabilityPrompt || "",
    context.enabledMcpServers?.length
      ? `Enabled MCP servers for this session: ${context.enabledMcpServers.join(", ")}.`
      : "",
    context.voiceAgentSkillsContent
      ? `## Voice Agent Skills\n${context.voiceAgentSkillsContent}`
      : context.voiceAgentSkills?.length
        ? `Voice agent skills: ${context.voiceAgentSkills.join(", ")}.`
        : "",
    context.executor
      ? `Preferred executor for delegated work: ${context.executor}.`
      : "Preferred executor for delegated work: use configured default.",
    context.mode
      ? `Preferred delegation mode: ${context.mode}.`
      : "Preferred delegation mode: use configured default.",
    context.model
      ? `Preferred model override: ${context.model}.`
      : "Preferred model override: none.",
    chatHistorySection,
    "",
    "## Guidance for Session-Bound Calls",
    "- You have access to multiple tools. Prefer read-only/direct JS tools first for instant operational answers (tasks, sessions, status, config, files, logs).",
    "- For visual questions about camera/screen, call query_live_view with the user's exact question.",
    "- For questions that require project/code understanding, call ask_agent_context in mode=instant first and speak the returned answer in this turn.",
    "- Do NOT use delegate_to_agent for simple questions, status checks, or informational queries. delegate_to_agent is for long-running code modifications, file writes, PR creation, or multi-step workflows.",
    "- If you can answer with ask_agent_context or direct read-only tools, prefer those instead of delegation.",
    "- Delegation is non-blocking — results appear in the chat session but NOT in this voice turn. Only delegate when the user explicitly asks to 'run', 'write', 'create', 'fix', or 'implement' something.",
    "- Do not wait on slow agents for normal Q&A. Prefer direct tools and ask_agent_context (instant mode).",
    "- STRICT RULE: Any side-effectful tool (writes, commands, workflow execution, delegation, config/task mutations) requires explicit user confirmation in this session before execution.",
    "- For ambiguous action requests, ask a confirmation question before running side-effectful tools.",
    "- After a tool call finishes, send a short completion confirmation unless you are already giving a fuller immediate answer.",
    "- Preserve user intent when delegating. Do not paraphrase away technical detail.",
    "- Keep spoken responses concise. The user can see detailed results in the chat sidebar.",
    "- You can read chat history context to avoid asking the user to repeat themselves.",
    "- ALWAYS respond in English unless the user has explicitly requested a different language.",
  ].join("\n");

  return `${baseInstructions}${suffix}`;
}

function resolveToolChoice(toolDefinitions, callContext = {}) {
  // Always let the model choose which tool to use — even in session-bound calls.
  // The old behavior forced delegate_to_agent for every turn, which blocked the
  // voice agent from answering quick questions directly or using read-only tools.
  return "auto";
}

function extractModelResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const text = String(choice?.message?.content || "").trim();
    if (text) return text;
  }

  return "";
}

function parseImageDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i,
  );
  if (!match) {
    throw new Error("Invalid frame format (expected data:image/*;base64,...)");
  }
  return {
    mimeType: String(match[1] || "").toLowerCase(),
    base64Data: String(match[2] || ""),
    dataUrl: raw,
  };
}

function extractClaudeResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter((part) => part?.type === "text")
    .map((part) => String(part?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) return text;
  return "";
}

function extractGeminiResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];
    const text = parts
      .map((part) => String(part?.text || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

async function analyzeVisionWithOpenAI(dataUrl, model, prompt, contextText, cfg) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 220,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n\n${contextText}`,
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`Vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractModelResponseText(payload);
  if (!summary) {
    throw new Error("Vision model returned an empty summary");
  }
  return {
    summary,
    provider: "openai",
    model,
  };
}

async function analyzeVisionWithAzure(dataUrl, model, prompt, contextText, cfg) {
  const endpoint = normalizeAzureEndpoint(cfg.azureEndpoint);
  const url = `${endpoint}/openai/responses?api-version=${AZURE_API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": cfg.azureKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_output_tokens: 220,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${prompt}\n\n${contextText}`,
            },
            {
              type: "input_image",
              image_url: dataUrl,
              detail: "high",
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`Azure vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractModelResponseText(payload);
  if (!summary) {
    throw new Error("Azure vision model returned an empty summary");
  }
  return {
    summary,
    provider: "azure",
    model,
  };
}

async function analyzeVisionWithClaude(frame, model, prompt, contextText, cfg) {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": cfg.claudeKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 260,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${prompt}\n\n${contextText}` },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: frame.mimeType,
                data: frame.base64Data,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`Claude vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractClaudeResponseText(payload);
  if (!summary) {
    throw new Error("Claude vision model returned an empty summary");
  }
  return {
    summary,
    provider: "claude",
    model,
  };
}

async function analyzeVisionWithGemini(frame, model, prompt, contextText, cfg) {
  const apiKey = String(cfg.geminiKey || "").trim();
  const endpoint =
    `${GEMINI_GENERATE_CONTENT_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: `${prompt}\n\n${contextText}` },
            {
              inlineData: {
                mimeType: frame.mimeType,
                data: frame.base64Data,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 220,
      },
    }),
  });
  if (!response.ok) {
    const errText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`Gemini vision request failed (${response.status}): ${errText}`);
  }
  const payload = await response.json();
  const summary = extractGeminiResponseText(payload);
  if (!summary) {
    throw new Error("Gemini vision model returned an empty summary");
  }
  return {
    summary,
    provider: "gemini",
    model,
  };
}

// ── Voice provider detection ────────────────────────────────────────────────

/**
 * Resolve voice configuration from bosun config + env.
 * Returns { provider, model, openaiKey, azureKey, azureEndpoint, azureDeployment,
 *           claudeKey, geminiKey, voiceId, turnDetection, instructions,
 *           fallbackMode, delegateExecutor, enabled, visionModel }
 */
export function getVoiceConfig(forceReload = false) {
  if (!forceReload && _voiceConfig && (Date.now() - _configLoadedAt < CONFIG_TTL_MS)) {
    return _voiceConfig;
  }

  const cfg = loadConfig();
  const voice = cfg.voice || {};

  // Provider priority: env > config > key autodetect.
  // "auto" resolves to azure/openai/claude/gemini/fallback based on available credentials.
  const rawProvider = String(
    process.env.VOICE_PROVIDER || voice.provider || "auto",
  )
    .trim()
    .toLowerCase();
  const hasExplicitEnvProvider = Boolean(
    process.env.VOICE_PROVIDER
    && String(process.env.VOICE_PROVIDER).trim().toLowerCase() !== "auto",
  );

  // API keys
  const openaiOAuthToken =
    String(voice.openaiAccessToken || "").trim()
    || resolveVoiceOAuthToken("openai", forceReload)?.token
    || "";
  const openaiKey = voice.openaiApiKey
    || process.env.OPENAI_REALTIME_API_KEY
    || process.env.OPENAI_API_KEY
    || "";

  const azureOAuthToken =
    String(voice.azureAccessToken || "").trim()
    || resolveVoiceOAuthToken("azure", forceReload)?.token
    || "";
  const azureKey = voice.azureApiKey
    || process.env.AZURE_OPENAI_REALTIME_API_KEY
    || process.env.AZURE_OPENAI_API_KEY
    || "";

  const azureEndpoint = voice.azureEndpoint
    || process.env.AZURE_OPENAI_REALTIME_ENDPOINT
    || process.env.AZURE_OPENAI_ENDPOINT
    || "";

  const azureDeployment = voice.azureDeployment
    || process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT
    || "gpt-realtime-1.5";

  const claudeOAuthToken =
    String(voice.claudeAccessToken || "").trim()
    || resolveVoiceOAuthToken("claude", forceReload)?.token
    || "";
  const claudeKey = voice.claudeApiKey
    || process.env.ANTHROPIC_API_KEY
    || "";

  const geminiOAuthToken =
    String(voice.geminiAccessToken || "").trim()
    || resolveVoiceOAuthToken("gemini", forceReload)?.token
    || "";
  const geminiKey = voice.geminiApiKey
    || process.env.GEMINI_API_KEY
    || process.env.GOOGLE_API_KEY
    || "";

  const openaiAvailable = Boolean(openaiOAuthToken || openaiKey);
  const azureAvailable = Boolean((azureOAuthToken || azureKey) && azureEndpoint);
  const claudeAvailable = Boolean(claudeKey || claudeOAuthToken);
  const geminiAvailable = Boolean(geminiKey || geminiOAuthToken);

  const autoProvider =
    azureAvailable
      ? "azure"
      : (openaiAvailable
          ? "openai"
          : (claudeAvailable
              ? "claude"
              : (geminiAvailable ? "gemini" : "fallback")));

  const provider = rawProvider === "auto" ? autoProvider : rawProvider;

  const rawProviderChain = process.env.VOICE_PROVIDERS
    || (hasExplicitEnvProvider ? [] : (voice.providers || []));
  const providerChain = normalizeVoiceProviderChain(rawProviderChain, provider);
  const providerChainWithFallbacks = getProviderChainWithCredentialFallbacks(providerChain, {
    openaiAvailable,
    azureAvailable,
    claudeAvailable,
    geminiAvailable,
  });

  // voiceEndpoints: named per-endpoint configs each with their own credentials.
  const rawVoiceEndpoints = Array.isArray(voice.voiceEndpoints) ? voice.voiceEndpoints : [];
  const voiceEndpointCandidates = rawVoiceEndpoints
    .filter((ep) => ep && ep.enabled !== false && (ep.provider === "openai" || ep.provider === "azure" || ep.provider === "custom"))
    .map((ep) => ({
      provider: String(ep.provider || "").toLowerCase() === "custom" ? "openai" : String(ep.provider || "").toLowerCase(),
      endpoint: String(ep.endpoint || "").trim() || null,
      apiKey: String(ep.apiKey || "").trim() || null,
      authSource: ["apiKey", "oauth"].includes(ep.authSource) ? ep.authSource : "apiKey",
      model: String(ep.model || "").trim() || null,
      azureDeployment: String(ep.deployment || ep.azureDeployment || "").trim() || null,
      voiceId: String(ep.voiceId || "").trim() || null,
      visionModel: String(ep.visionModel || "").trim() || null,
      transcriptionModel: String(ep.transcriptionModel || "").trim() || null,
      // Azure defaults to transcription OFF unless explicitly enabled because
      // item-level ASR failures can spam and destabilize long-running calls.
      transcriptionEnabled: String(ep.provider || "").toLowerCase() === "azure"
        ? (ep.transcriptionEnabled === true)
        : (ep.transcriptionEnabled !== false),
      role: String(ep.role || "primary").trim() || "primary",
      weight: typeof ep.weight === "number" ? ep.weight : 100,
      name: String(ep.name || "").trim() || null,
      enabled: true,
    }))
    .sort((a, b) => {
      if (a.role === "primary" && b.role !== "primary") return -1;
      if (a.role !== "primary" && b.role === "primary") return 1;
      return (b.weight || 0) - (a.weight || 0);
    });

  const realtimeCandidates = voiceEndpointCandidates.length > 0
    ? voiceEndpointCandidates
    : providerChain
        .filter((entry) => entry.provider === "openai" || entry.provider === "azure")
        .map((entry) => ({ ...entry, endpoint: null, apiKey: null, role: "primary", weight: 100, name: null }));
  if (!realtimeCandidates.length && (provider === "openai" || provider === "azure")) {
    realtimeCandidates.push({
      provider,
      model: null,
      visionModel: null,
      voiceId: null,
      azureDeployment: null,
      endpoint: null,
      apiKey: null,
      role: "primary",
      weight: 100,
      name: null,
      enabled: true,
    });
  }

  const failoverEnabledRaw =
    voice?.failover?.enabled ?? process.env.VOICE_FAILOVER_ENABLED;
  const failoverEnabled =
    failoverEnabledRaw == null
      ? DEFAULT_VOICE_FAILOVER.enabled
      : !["0", "false", "no", "off"].includes(
          String(failoverEnabledRaw).trim().toLowerCase(),
        );
  const failoverMaxAttempts = parseFailoverInt(
    voice?.failover?.maxAttempts ?? process.env.VOICE_FAILOVER_MAX_ATTEMPTS,
    DEFAULT_VOICE_FAILOVER.maxAttempts,
  );

  const diagnostics = [];
  if (
    process.env.OPENAI_REALTIME_API_KEY
    && process.env.OPENAI_API_KEY
    && process.env.OPENAI_REALTIME_API_KEY !== process.env.OPENAI_API_KEY
  ) {
    diagnostics.push(
      "Both OPENAI_REALTIME_API_KEY and OPENAI_API_KEY are set; realtime key takes precedence.",
    );
  }
  if (/^sk-test-/i.test(String(openaiKey || ""))) {
    diagnostics.push(
      "OpenAI realtime key appears to be a test/placeholder value (sk-test-*).",
    );
  }
  const defaultModel =
    provider === "claude"
      ? CLAUDE_DEFAULT_MODEL
      : provider === "gemini"
        ? GEMINI_DEFAULT_MODEL
        : OPENAI_REALTIME_MODEL;
  const model = String(voice.model || process.env.VOICE_MODEL || defaultModel).trim() || defaultModel;
  const voiceId = voice.voiceId || process.env.VOICE_ID || "alloy";
  const turnDetection =
    voice.turnDetection || process.env.VOICE_TURN_DETECTION || "semantic_vad";
  const defaultVisionModel =
    provider === "claude"
      ? CLAUDE_DEFAULT_VISION_MODEL
      : provider === "gemini"
        ? GEMINI_DEFAULT_VISION_MODEL
        : OPENAI_DEFAULT_VISION_MODEL;
  const visionModel =
    voice.visionModel || process.env.VOICE_VISION_MODEL || defaultVisionModel;
  const transcriptionModel =
    voice.transcriptionModel || process.env.VOICE_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const transcriptionEnabledRaw =
    voice.transcriptionEnabled ?? process.env.VOICE_TRANSCRIPTION_ENABLED;
  const transcriptionEnabled =
    transcriptionEnabledRaw == null
      ? true
      : !["0", "false", "no", "off"].includes(
          String(transcriptionEnabledRaw).trim().toLowerCase(),
        );
  const azureTranscriptionEnabled = parseOptionalBoolean(
    voice.azureTranscriptionEnabled ?? process.env.VOICE_AZURE_TRANSCRIPTION_ENABLED,
  );
  const fallbackMode =
    voice.fallbackMode || process.env.VOICE_FALLBACK_MODE || "browser";
  const delegateExecutor =
    voice.delegateExecutor ||
    process.env.VOICE_DELEGATE_EXECUTOR ||
    cfg.primaryAgent ||
    "codex-sdk";
  const enabled =
    voice.enabled != null
      ? voice.enabled !== false
      : !["0", "false", "no", "off"].includes(
          String(process.env.VOICE_ENABLED || "")
            .trim()
            .toLowerCase(),
        );

  const instructions = voice.instructions || `You are Bosun, a helpful voice assistant for the VirtEngine development platform.
You are NOT ChatGPT — never identify yourself as ChatGPT or any other AI assistant. Your name is Bosun.
You help developers manage tasks, steer coding agents, monitor builds, and navigate the workspace.
Be concise and conversational. When users ask about code or tasks, use the available tools.
For complex operations like writing code or creating PRs, delegate to the appropriate agent.

LANGUAGE RULES:
- Always respond in English unless the user explicitly requests another language.
- If the user speaks in a non-English language, respond in English and confirm: "I'll respond in English. Let me know if you'd prefer another language."
- Never switch languages based on the user's accent or speech patterns alone.

TOOL USAGE PRIORITY:
- For quick information, status checks, task queries, or simple questions: use direct tools (list_tasks, get_session_status, ask_agent_context, etc.) and answer immediately in this voice turn.
- NEVER delegate to an agent for questions you can answer directly using available tools.
- Only use delegate_to_agent for operations that genuinely require an agent to write code, modify files, or run complex multi-step workflows.
- When in doubt, use ask_agent_context in instant mode first — it returns answers within this voice turn.`;

  _voiceConfig = Object.freeze({
    provider,
    providerChain,
    providerChainWithFallbacks,
    realtimeCandidates,
    failover: {
      enabled: failoverEnabled,
      maxAttempts: failoverMaxAttempts,
    },
    model,
    openaiKey,
    openaiOAuthToken,
    azureKey,
    azureOAuthToken,
    azureEndpoint,
    azureDeployment,
    claudeKey,
    claudeOAuthToken,
    geminiKey,
    geminiOAuthToken,
    voiceId,
    turnDetection,
    visionModel,
    instructions,
    transcriptionModel,
    transcriptionEnabled,
    azureTranscriptionEnabled,
    fallbackMode,
    delegateExecutor,
    enabled,
    diagnostics,
  });
  _configLoadedAt = Date.now();
  return _voiceConfig;
}

/**
 * Check if any voice tier is available.
 */
export function isVoiceAvailable() {
  const cfg = getVoiceConfig();
  if (!cfg.enabled) return { available: false, tier: null, reason: "Voice disabled in config" };

  const realtimeProvider = cfg.realtimeCandidates.find((candidate) => candidateHasCredentials(candidate, cfg));
  if (realtimeProvider) {
    return { available: true, tier: 1, provider: realtimeProvider.provider };
  }

  if (cfg.provider === "claude" && (cfg.claudeKey || cfg.claudeOAuthToken)) {
    return { available: true, tier: 2, provider: "claude" };
  }
  if (cfg.provider === "gemini" && (cfg.geminiKey || cfg.geminiOAuthToken)) {
    return { available: true, tier: 2, provider: "gemini" };
  }
  if (cfg.fallbackMode === "disabled") {
    return {
      available: false,
      tier: null,
      reason: `Voice provider "${cfg.provider}" is not configured and fallback is disabled`,
    };
  }
  // Tier 2 fallback available when enabled
  return { available: true, tier: 2, provider: "fallback" };
}

/**
 * Create an ephemeral token for OpenAI Realtime API (WebRTC).
 * Returns { token, expiresAt, model, voiceId, provider }
 */
export async function createEphemeralToken(toolDefinitions = [], callContext = {}) {
  const cfg = getVoiceConfig();
  const requestedModel = String(callContext?.model || cfg.model || "").trim();

  // gpt-audio-* models use OpenAI Responses API (non-SDP transport).
  if (isOpenAIAudioResponsesModel(requestedModel)) {
    const openaiCandidate =
      cfg.realtimeCandidates.find(
        (entry) =>
          entry.provider === "openai" &&
          candidateHasCredentials(entry, cfg),
      )
      || (candidateHasCredentials({ provider: "openai", authSource: "api-key" }, cfg)
        ? { provider: "openai", authSource: "api-key", model: requestedModel, voiceId: cfg.voiceId }
        : null);
    if (openaiCandidate) {
      const context = sanitizeVoiceCallContext(callContext);
      const baseInstructions = await resolveVoiceBaseInstructions(context);
      const instructions = await buildSessionScopedInstructions(baseInstructions, context);
      const voiceId = String(openaiCandidate?.voiceId || cfg.voiceId || "alloy").trim() || "alloy";
      return {
        provider: "openai",
        model: requestedModel || OPENAI_AUDIO_RESPONSES_MODEL,
        voiceId,
        transport: "responses-audio",
        instructions,
      };
    }
  }

  const candidates = cfg.realtimeCandidates.filter((entry) => candidateHasCredentials(entry, cfg));

  if (!candidates.length) {
    throw new Error(
      `Realtime WebRTC token is unavailable for provider "${cfg.provider}". ` +
      "Use VOICE_PROVIDER=openai|azure and configure OAuth/API credentials for Tier 1 realtime voice.",
    );
  }

  const maxAttempts = cfg.failover.enabled
    ? Math.min(Math.max(cfg.failover.maxAttempts, 1), candidates.length)
    : 1;

  let lastError = null;
  for (let index = 0; index < maxAttempts; index++) {
    const candidate = candidates[index];
    try {
      if (candidate.provider === "azure") {
        return await createAzureEphemeralToken(cfg, toolDefinitions, callContext, candidate);
      }
      return await createOpenAIEphemeralToken(cfg, toolDefinitions, callContext, candidate);
    } catch (err) {
      lastError = err;
      const canRetry = cfg.failover.enabled && index + 1 < maxAttempts && shouldFailoverRealtimeError(err);
      if (!canRetry) break;
    }
  }

  throw lastError || new Error("Failed to create realtime token");
}

function extractAudioBase64FromResponsesPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = String(
    payload?.audio?.data
      || payload?.audio?.base64
      || payload?.output_audio?.data
      || payload?.output_audio?.base64
      || "",
  ).trim();
  if (direct) return direct;

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const maybe = String(
        part?.audio?.data
          || part?.audio?.base64
          || part?.data
          || part?.b64_json
          || "",
      ).trim();
      if (maybe) return maybe;
    }
  }
  return "";
}

/**
 * Execute a single turn using OpenAI Responses audio models (gpt-audio-*).
 * Returns text + optional audio bytes (base64).
 */
export async function generateOpenAIAudioResponse(inputText, callContext = {}, options = {}) {
  const cfg = getVoiceConfig();
  const text = String(inputText || "").trim();
  if (!text) throw new Error("inputText is required");

  const credential = String(cfg.openaiOAuthToken || cfg.openaiKey || "").trim();
  if (!credential) {
    throw new Error("OpenAI voice credential not configured (OAuth token or API key required)");
  }

  const context = sanitizeVoiceCallContext(callContext);
  const baseInstructions = await resolveVoiceBaseInstructions(context);
  const instructions = await buildSessionScopedInstructions(baseInstructions, context);
  const preferredModel = String(options?.model || context.model || cfg.model || OPENAI_AUDIO_RESPONSES_MODEL).trim();
  const model = isOpenAIAudioResponsesModel(preferredModel)
    ? preferredModel
    : OPENAI_AUDIO_RESPONSES_MODEL;
  const voiceId = String(options?.voiceId || cfg.voiceId || "alloy").trim() || "alloy";

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      modalities: ["text", "audio"],
      audio: {
        voice: voiceId,
        format: "mp3",
      },
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: instructions }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`OpenAI audio response failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const outputText = extractModelResponseText(payload) || "";
  const audioBase64 = extractAudioBase64FromResponsesPayload(payload);

  return {
    provider: "openai",
    model,
    voiceId,
    text: outputText,
    audioBase64,
    audioMimeType: "audio/mpeg",
  };
}

async function createOpenAIEphemeralToken(cfg, toolDefinitions = [], callContext = {}, candidate = {}) {
  // Per-endpoint credentials take priority over global config.
  // If the endpoint uses OAuth (authSource === "oauth"), resolve via the OAuth manager.
  let credential = "";
  if (candidate.authSource === "oauth") {
    credential = String(resolveVoiceOAuthToken(candidate.provider || "openai")?.token || cfg.openaiOAuthToken || "").trim();
  } else {
    credential = String(candidate.apiKey || cfg.openaiOAuthToken || cfg.openaiKey || "").trim();
  }
  if (!credential) {
    throw new Error("OpenAI voice credential not configured (OAuth token or API key required)");
  }

  const context = sanitizeVoiceCallContext(callContext);
  const baseInstructions = await resolveVoiceBaseInstructions(context);
  const instructions = await buildSessionScopedInstructions(baseInstructions, context);
  const model = normalizeOpenAIRealtimeModel(candidate?.model || cfg.model || OPENAI_REALTIME_MODEL);
  const voiceId = String(candidate?.voiceId || cfg.voiceId || "alloy").trim() || "alloy";
  // Per-endpoint transcription overrides
  const transcriptionModel = String(candidate?.transcriptionModel || "").trim() || cfg.transcriptionModel;
  const transcriptionEnabled = candidate?.transcriptionEnabled !== undefined
    ? candidate.transcriptionEnabled !== false
    : cfg.azureTranscriptionEnabled != null
      ? cfg.azureTranscriptionEnabled !== false
      : false;

  const sessionConfig = {
    model,
    voice: voiceId,
    instructions,
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    tool_choice: resolveToolChoice(toolDefinitions, context),
    turn_detection: {
      type: cfg.turnDetection,
      ...(cfg.turnDetection === "server_vad" ? {
        threshold: 0.75,
        prefix_padding_ms: 500,
        silence_duration_ms: 1800,
        create_response: true,
        interrupt_response: false,
      } : {}),
      ...(cfg.turnDetection === "semantic_vad" ? {
        eagerness: "low",
        create_response: true,
        interrupt_response: false,
      } : {}),
    },
    ...(transcriptionEnabled ? { input_audio_transcription: { model: transcriptionModel } } : {}),
    tools: toolDefinitions,
  };

  const response = await fetch(buildOpenAIRealtimeSessionUrl(candidate?.endpoint || ""), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sessionConfig),
  });

  if (!response.ok) {
    const errorText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`OpenAI Realtime session failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return {
    token: data.client_secret?.value || data.token,
    expiresAt: data.client_secret?.expires_at || (Date.now() / 1000 + 60),
    model,
    voiceId,
    provider: "openai",
    url: buildOpenAIRealtimeWebRtcUrl(model, candidate?.endpoint || ""),
    sessionConfig,
    callContext: context,
  };
}

/**
 * Create an ephemeral token for Azure OpenAI Realtime API.
 */
async function createAzureEphemeralToken(cfg, toolDefinitions = [], callContext = {}, candidate = {}) {
  // Per-endpoint credentials (from voiceEndpoints) take priority over global config.
  const resolvedEndpoint = normalizeAzureEndpoint(candidate?.endpoint || cfg.azureEndpoint || "");
  const resolvedApiKey = String(candidate?.apiKey || cfg.azureKey || "").trim();
  const resolvedOAuthToken = String(cfg.azureOAuthToken || "").trim();

  if (!resolvedEndpoint) {
    throw new Error("Azure OpenAI Realtime not configured (need endpoint + key)");
  }
  if (!resolvedApiKey && !resolvedOAuthToken) {
    throw new Error("Azure OpenAI Realtime not configured (need endpoint + key)");
  }

  const context = sanitizeVoiceCallContext(callContext);
  const baseInstructions = await resolveVoiceBaseInstructions(context);
  const instructions = await buildSessionScopedInstructions(baseInstructions, context);
  const deployment = normalizeAzureRealtimeDeployment(
    candidate?.azureDeployment || candidate?.model || cfg.azureDeployment || OPENAI_REALTIME_MODEL,
  );
  const voiceId = String(candidate?.voiceId || cfg.voiceId || "alloy").trim() || "alloy";
  // Per-endpoint transcription overrides
  const transcriptionModel = String(candidate?.transcriptionModel || "").trim() || cfg.transcriptionModel;
  const transcriptionEnabled = candidate?.transcriptionEnabled !== undefined ? candidate.transcriptionEnabled !== false : cfg.transcriptionEnabled;
  // GA protocol (gpt-realtime-1.5, gpt-realtime, etc.) uses /openai/v1/realtime/sessions?api-version=...
  // Preview protocol uses /openai/realtimeapi/sessions?api-version=...
  // Azure AI Foundry "Global Standard" resources may not support GA paths even for GA model names,
  // so we build both and try GA first with automatic fallback to preview.
  const gaUrl = `${resolvedEndpoint}/openai/v1/realtime/sessions?api-version=${AZURE_API_VERSION}`;
  const previewUrl = `${resolvedEndpoint}/openai/realtimeapi/sessions?api-version=${AZURE_API_VERSION}&deployment=${encodeURIComponent(deployment)}`;
  const useGa = isAzureGaProtocol(deployment);
  const url = useGa ? gaUrl : previewUrl;

  const headers = {
    "Content-Type": "application/json",
  };
  if (resolvedOAuthToken) {
    headers.Authorization = `Bearer ${resolvedOAuthToken}`;
  } else {
    headers["api-key"] = resolvedApiKey;
  }

  const sessionConfig = {
    ...(isAzureGaProtocol(deployment) ? { type: "realtime" } : {}),
    model: deployment,
    voice: voiceId,
    instructions,
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    tool_choice: resolveToolChoice(toolDefinitions, context),
    turn_detection: {
      type: cfg.turnDetection,
      ...(cfg.turnDetection === "server_vad" ? {
        threshold: 0.75,
        prefix_padding_ms: 500,
        silence_duration_ms: 1800,
        create_response: true,
        interrupt_response: false,
      } : {}),
      ...(cfg.turnDetection === "semantic_vad" ? {
        eagerness: "low",
        create_response: true,
        interrupt_response: false,
      } : {}),
    },
    ...(transcriptionEnabled ? { input_audio_transcription: { model: transcriptionModel } } : {}),
    tools: toolDefinitions,
  };

  let response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(sessionConfig),
  });

  // Track whether the GA path was used (not the fallback preview path).
  let usedGaPath = useGa;

  // Azure AI Foundry "Global Standard" deployments may 404 on the GA path.
  // Automatically fall back to the preview path before giving up.
  if (!response.ok && response.status === 404 && useGa) {
    usedGaPath = false;
    const previewConfig = { ...sessionConfig };
    delete previewConfig.type; // preview path does not accept type: "realtime"
    response = await fetch(previewUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(previewConfig),
    });
  }

  if (!response.ok) {
    const errorText = await buildProviderErrorDetails(response, "unknown");
    throw new Error(`Azure Realtime session failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  // WebRTC URL diverges from /sessions URL: GA uses /openai/v1/realtime, preview uses /openai/realtime.
  // Use a boolean flag instead of response.url (which may be unavailable in some runtimes).
  const gaSessionSucceeded = usedGaPath;
  const webrtcUrl = (useGa && gaSessionSucceeded)
    ? `${resolvedEndpoint}/openai/v1/realtime?api-version=${AZURE_API_VERSION}`
    : `${resolvedEndpoint}/openai/realtime?api-version=${AZURE_API_VERSION}&deployment=${encodeURIComponent(deployment)}`;

  // WebSocket fallback URL — Azure Realtime API always supports WebSocket even
  // when WebRTC SDP is unavailable (404).  The api-key query parameter provides
  // authentication since browsers cannot set custom headers on WebSocket.
  const wsAuthParam = resolvedOAuthToken
    ? `access_token=${encodeURIComponent(resolvedOAuthToken)}`
    : `api-key=${encodeURIComponent(resolvedApiKey)}`;
  const wsUrl = (useGa && gaSessionSucceeded)
    ? `wss://${new URL(resolvedEndpoint).host}/openai/v1/realtime?api-version=${AZURE_API_VERSION}&${wsAuthParam}`
    : `wss://${new URL(resolvedEndpoint).host}/openai/realtime?api-version=${AZURE_API_VERSION}&deployment=${encodeURIComponent(deployment)}&${wsAuthParam}`;

  return {
    token: data.client_secret?.value || data.token,
    expiresAt: data.client_secret?.expires_at || (Date.now() / 1000 + 60),
    model: deployment,
    voiceId,
    provider: "azure",
    url: webrtcUrl,
    wsUrl,
    sessionConfig,
    azureEndpoint: resolvedEndpoint,
    azureDeployment: deployment,
    callContext: context,
  };
}

/**
 * Analyze a camera/screen frame and return a concise summary.
 * @param {string} frameDataUrl - data URL (image/jpeg|png|webp)
 * @param {object} options - { source, context, prompt }
 * @returns {Promise<{ summary: string, provider: string, model: string }>}
 */
export async function analyzeVisionFrame(frameDataUrl, options = {}) {
  const frame = parseImageDataUrl(frameDataUrl);
  const dataUrl = frame.dataUrl;

  const cfg = getVoiceConfig();
  const source = String(options?.source || "screen").trim().toLowerCase() || "screen";
  const callContext = sanitizeVoiceCallContext(options?.context || {});
  const model =
    String(
      options?.model
      || options?.visionModel
      || cfg.visionModel
      || process.env.VOICE_VISION_MODEL
      || OPENAI_DEFAULT_VISION_MODEL,
    ).trim();
  const prompt = String(options?.prompt || "").trim()
    || "Summarize what is visible in this live frame for a coding assistant. Focus on code, terminal output, errors, UI labels, and actionable context.";

  const contextText = [
    `Frame source: ${source}.`,
    `Bound chat session: ${callContext.sessionId || "none"}.`,
    callContext.executor ? `Preferred executor: ${callContext.executor}.` : "",
    callContext.mode ? `Preferred mode: ${callContext.mode}.` : "",
    callContext.model ? `Preferred model override: ${callContext.model}.` : "",
    "Respond in 1-3 concise sentences. Include likely next action if obvious.",
  ]
    .filter(Boolean)
    .join("\n");

  const preferredProviders = [];
  const pushProvider = (value) => {
    const provider = String(value || "").trim().toLowerCase();
    if (!provider || preferredProviders.includes(provider)) return;
    preferredProviders.push(provider);
  };
  pushProvider(cfg.provider);
  if (cfg.openaiKey) pushProvider("openai");
  if (cfg.azureKey && cfg.azureEndpoint) pushProvider("azure");
  if (cfg.claudeKey) pushProvider("claude");
  if (cfg.geminiKey) pushProvider("gemini");

  let lastError = null;
  for (const provider of preferredProviders) {
    try {
      if (provider === "openai" && cfg.openaiKey) {
        return await analyzeVisionWithOpenAI(
          dataUrl,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "azure" && cfg.azureKey && cfg.azureEndpoint) {
        return await analyzeVisionWithAzure(
          dataUrl,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "claude" && cfg.claudeKey) {
        return await analyzeVisionWithClaude(
          frame,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
      if (provider === "gemini" && cfg.geminiKey) {
        return await analyzeVisionWithGemini(
          frame,
          model,
          prompt,
          contextText,
          cfg,
        );
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) {
    throw new Error(`Vision request failed: ${lastError.message}`);
  }

  throw new Error(
    "Vision unavailable: configure OPENAI, Azure, Anthropic, or Gemini voice credentials",
  );
}

/**
 * Execute a voice tool call server-side.
 * Returns { result: string, error?: string }
 */
export async function executeVoiceTool(toolName, toolArgs, context = {}) {
  try {
    // Import voice-tools lazily to avoid circular deps
    const { executeToolCall } = await import("./voice-tools.mjs");
    return await executeToolCall(toolName, toolArgs, context);
  } catch (err) {
    console.error("[voice-relay] tool execution error (%s): %s", String(toolName || "unknown"), String(err?.message || err || "unknown"));
    return { result: null, error: err.message };
  }
}

/**
 * Base tools allowed during session-bound voice calls.
 * Owner/admin sessions get additional tools via VOICE_OWNER_EXTRA_TOOLS.
 */
const VOICE_READ_ONLY_TOOLS = new Set([
  "get_admin_help",
  "ask_agent_context",
  "query_live_view",
  "get_workspace_context",
  "list_tasks",
  "get_task",
  "search_tasks",
  "get_task_stats",
  "get_agent_status",
  "list_sessions",
  "get_session_history",
  "get_system_status",
  "get_fleet_status",
  "get_pr_status",
  "get_config",
  "search_code",
  "read_file_content",
  "list_directory",
  "get_recent_logs",
  "list_workflows",
  "get_workflow_definition",
  "list_workflow_runs",
  "get_workflow_run",
  "analyze_workflow",
  "list_skills",
  "list_prompts",
  "poll_background_session",
]);

const VOICE_SIDE_EFFECT_TOOLS = new Set([
  "delegate_to_agent",
  "create_task",
  "update_task_status",
  "delete_task",
  "comment_on_task",
  "switch_agent",
  "set_agent_mode",
  "update_config",
  "create_workflow",
  "update_workflow_definition",
  "delete_workflow",
  "create_workflow_from_template",
  "generate_workflow_with_agent",
  "execute_workflow",
  "retry_workflow_run",
  "run_command",
  "dispatch_action",
  "bosun_slash_command",
  "invoke_mcp_tool",
  "warm_codebase_context",
]);

const VOICE_SESSION_ALLOWED_TOOLS = new Set([
  ...VOICE_READ_ONLY_TOOLS,
  ...VOICE_SIDE_EFFECT_TOOLS,
]);

/**
 * Additional tools unlocked for owner/admin-authenticated sessions.
 * These allow direct shell access and mutating system operations.
 */
const VOICE_OWNER_EXTRA_TOOLS = new Set([
  "run_workspace_command",
]);

const PRIVILEGED_VOICE_AUTH_SOURCES = new Set([
  "desktop-api-key",
  "fallback",
  "unsafe",
]);

export function isPrivilegedVoiceContext(context = {}) {
  const source = String(context?.authSource || "").trim().toLowerCase();
  return PRIVILEGED_VOICE_AUTH_SOURCES.has(source);
}

function shouldAllowVoiceSideEffectsForMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "agent" || normalized === "code" || normalized === "web";
}

async function resolveVoiceLibraryRoot(callContext = {}) {
  const context = sanitizeVoiceCallContext(callContext);
  if (!context.sessionId) return process.cwd();
  try {
    const tracker = await import("../infra/session-tracker.mjs");
    let session = null;
    if (typeof tracker.getSessionById === "function") {
      session = tracker.getSessionById(context.sessionId);
    } else if (typeof tracker.getSession === "function") {
      session = tracker.getSession(context.sessionId);
    }
    const workspaceDir = String(
      session?.workspaceDir
      || session?.metadata?.workspaceDir
      || "",
    ).trim();
    if (workspaceDir) return workspaceDir;
  } catch {
    // best effort
  }
  return process.cwd();
}

function resolveLibraryObjectEntryContent(resolveEntry, getEntryContent, rootDir, id) {
  const resolved = resolveEntry(rootDir, id);
  if (resolved?.content && typeof resolved.content === "object") {
    return resolved.content;
  }
  if (resolved?.entry) {
    const fallback = getEntryContent(rootDir, resolved.entry);
    if (fallback && typeof fallback === "object") {
      return fallback;
    }
  }
  return null;
}

function resolveLibraryTextEntryContent(resolveEntry, getEntryContent, rootDir, id) {
  const resolved = resolveEntry(rootDir, id);
  if (typeof resolved?.content === "string" && resolved.content.trim()) {
    return resolved.content;
  }
  if (resolved?.entry) {
    const fallback = getEntryContent(rootDir, resolved.entry);
    if (typeof fallback === "string" && fallback.trim()) {
      return fallback;
    }
  }
  return "";
}

function resolveVoiceAgentPromptOverrideTemplate(
  rootDir,
  voiceAgentId,
  resolveEntry,
  getEntryContent,
) {
  const id = String(voiceAgentId || "").trim();
  if (!id) return "";

  const profile = resolveLibraryObjectEntryContent(
    resolveEntry,
    getEntryContent,
    rootDir,
    id,
  );
  const promptOverrideId = String(profile?.promptOverride || "").trim();
  if (!promptOverrideId) return "";

  return resolveLibraryTextEntryContent(
    resolveEntry,
    getEntryContent,
    rootDir,
    promptOverrideId,
  );
}

function resolveVoicePromptTemplateFromDefaults(
  rootDir,
  promptKey,
  resolveAgentPrompts,
  getDefaultPromptTemplate,
) {
  try {
    const resolved = resolveAgentPrompts(null, rootDir, {});
    const template = String(resolved?.prompts?.[promptKey] || "").trim();
    if (template) return template;
  } catch {
    // best effort
  }
  return String(getDefaultPromptTemplate(promptKey) || "");
}

async function resolveVoiceBaseInstructions(callContext = {}, options = {}) {
  const cfg = getVoiceConfig();
  const context = sanitizeVoiceCallContext(callContext);
  let baseInstructions = cfg.instructions || "";

  if (options.customInstructions) {
    return String(options.customInstructions);
  }

  try {
    const [
      {
        resolveAgentPrompts,
        renderPromptTemplate,
        getDefaultPromptTemplate,
        setLibraryResolver,
      },
      {
        resolveLibraryRefs,
        resolveEntry,
        getEntryContent,
      },
    ] = await Promise.all([
      import("../agent/agent-prompts.mjs"),
      import("../infra/library-manager.mjs"),
    ]);

    const rootDir = await resolveVoiceLibraryRoot(context);
    setLibraryResolver(resolveLibraryRefs);

    const promptKey = options.compact ? "voiceAgentCompact" : "voiceAgent";
    const overrideTemplate = resolveVoiceAgentPromptOverrideTemplate(
      rootDir,
      context.voiceAgentId,
      resolveEntry,
      getEntryContent,
    );
    const template = overrideTemplate || resolveVoicePromptTemplateFromDefaults(
      rootDir,
      promptKey,
      resolveAgentPrompts,
      getDefaultPromptTemplate,
    );

    if (template) {
      const manifest = await getVoiceActionManifest();
      const rendered = renderPromptTemplate(template, {
        VOICE_ACTION_MANIFEST: manifest,
      }, rootDir);
      if (typeof rendered === "string" && rendered.trim()) {
        baseInstructions = rendered;
      }
    }
  } catch {
    // Fall back to config instructions
  }

  return baseInstructions;
}

export function normalizeVoiceToolArgs(toolName, toolArgs) {
  const extractLatestTextFromHistory = (history) => {
    const items = Array.isArray(history) ? history : [];
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const role = String(item?.role || "").trim().toLowerCase();
      if (role && role !== "user") continue;
      const content = Array.isArray(item?.content) ? item.content : [];
      for (let j = content.length - 1; j >= 0; j--) {
        const part = content[j];
        const transcript = String(part?.transcript || "").trim();
        if (transcript) return transcript;
        const text = String(part?.text || part?.input_text || "").trim();
        if (text) return text;
      }
      const direct = String(item?.text || item?.message || "").trim();
      if (direct) return direct;
    }
    return "";
  };

  const resolvePromptFromArgs = (value) => {
    const direct = String(
      value?.message ||
      value?.prompt ||
      value?.query ||
      value?.question ||
      value?.request ||
      value?.text ||
      "",
    ).trim();
    if (direct) return direct;

    const nested = value?.context && typeof value.context === "object"
      ? value.context
      : null;
    const nestedDirect = String(
      nested?.message ||
      nested?.prompt ||
      nested?.query ||
      nested?.question ||
      nested?.request ||
      nested?.text ||
      "",
    ).trim();
    if (nestedDirect) return nestedDirect;

    const fromNestedHistory = extractLatestTextFromHistory(nested?.history);
    if (fromNestedHistory) return fromNestedHistory;
    const fromTopHistory = extractLatestTextFromHistory(value?.history);
    if (fromTopHistory) return fromTopHistory;
    return "";
  };

  const normalized =
    toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
      ? { ...toolArgs }
      : {};

  if (String(toolName || "").trim() === "read_file_content") {
    const directPath = typeof normalized.filePath === "string" ? normalized.filePath.trim() : "";
    const aliasPath = typeof normalized.path === "string" ? normalized.path.trim() : "";
    if (!directPath && aliasPath) {
      normalized.filePath = aliasPath;
    }
    if (!normalized.filePath && normalized.context && typeof normalized.context === "object") {
      const nestedFilePath = typeof normalized.context.filePath === "string"
        ? normalized.context.filePath.trim()
        : "";
      const nestedPath = typeof normalized.context.path === "string"
        ? normalized.context.path.trim()
        : "";
      if (nestedFilePath) normalized.filePath = nestedFilePath;
      else if (nestedPath) normalized.filePath = nestedPath;
    }
  }

  const normalizedToolName = String(toolName || "").trim().toLowerCase();
  if (
    normalizedToolName === "ask_agent_context"
    || normalizedToolName === "query_live_view"
  ) {
    const inferredPrompt = resolvePromptFromArgs(normalized);
    if (normalizedToolName === "ask_agent_context") {
      if (!String(normalized.message || "").trim() && inferredPrompt) {
        normalized.message = inferredPrompt;
      }
    }
    if (normalizedToolName === "query_live_view") {
      if (!String(normalized.query || "").trim() && inferredPrompt) {
        normalized.query = inferredPrompt;
      }
    }

    // Tool logs can receive giant SDK history payloads; keep minimal fields.
    if (normalized.context && typeof normalized.context === "object") {
      const slimContext = { ...normalized.context };
      delete slimContext.history;
      normalized.context = slimContext;
    }
    delete normalized.history;
  }

  return normalized;
}

export async function getAllowedVoiceTools(context = {}) {
  if (!context?.sessionId) return null;
  const mode = String(context?.mode || "").trim().toLowerCase();
  const allowSideEffects = shouldAllowVoiceSideEffectsForMode(mode);
  return getSessionAllowedTools({
    isOwner: isPrivilegedVoiceContext(context),
    allowSideEffects,
  });
}

/**
 * Get the set of tools allowed for session-bound voice calls.
 * @param {{ isOwner?: boolean, allowSideEffects?: boolean }} options
 * @returns {Set<string>}
 */
export function getSessionAllowedTools(options = {}) {
  const allowSideEffects = options.allowSideEffects !== false;
  const merged = new Set(VOICE_READ_ONLY_TOOLS);
  if (allowSideEffects) {
    for (const t of VOICE_SIDE_EFFECT_TOOLS) merged.add(t);
  }
  if (options.isOwner && allowSideEffects) {
    for (const t of VOICE_OWNER_EXTRA_TOOLS) merged.add(t);
  }
  return merged;
}

/**
 * Get the full tool definitions array for voice sessions.
 */
export async function getVoiceToolDefinitions(options = {}) {
  try {
    const { getToolDefinitions } = await import("./voice-tools.mjs");
    const allTools = getToolDefinitions();
    const context = options?.context || {};
    if (context?.sessionId) {
      const allowed = await getAllowedVoiceTools(context);
      if (allowed instanceof Set) {
        return allTools.filter((tool) => allowed.has(tool?.name));
      }
    }

    const delegateOnly = options?.delegateOnly === true;
    if (!delegateOnly || isPrivilegedVoiceContext(context)) return allTools;
    return allTools.filter((tool) => getSessionAllowedTools({ allowSideEffects: true }).has(tool?.name));
  } catch (err) {
    console.error("[voice-relay] failed to load voice tool definitions:", err.message);
    return [];
  }
}

/**
 * Get the WebRTC connection URL for the client.
 */
export function getRealtimeConnectionInfo() {
  const cfg = getVoiceConfig();
  const candidate = cfg.realtimeCandidates.find((entry) => candidateHasCredentials(entry, cfg));
  if (!candidate) {
    return {
      provider: cfg.provider,
      url: null,
      model: cfg.model,
      tier: 2,
    };
  }

  // For gpt-audio-* models we use the non-SDP Responses transport.
  if (
    candidate.provider === "openai"
    && isOpenAIAudioResponsesModel(cfg.model || candidate?.model || "")
  ) {
    return {
      provider: "openai",
      url: null,
      model: String(cfg.model || candidate?.model || OPENAI_AUDIO_RESPONSES_MODEL).trim() || OPENAI_AUDIO_RESPONSES_MODEL,
      transport: "responses-audio",
    };
  }

  if (candidate.provider === "azure") {
    const endpoint = normalizeAzureEndpoint(candidate?.endpoint || cfg.azureEndpoint || "");
    const deployment = normalizeAzureRealtimeDeployment(
      candidate?.azureDeployment || candidate?.model || cfg.azureDeployment || OPENAI_REALTIME_MODEL,
    );
    // GA protocol: /openai/v1/realtime with api-version; model set during /sessions exchange.
    // Preview protocol: /openai/realtime with api-version and deployment.
    const url = isAzureGaProtocol(deployment)
      ? `${endpoint}/openai/v1/realtime?api-version=${AZURE_API_VERSION}`
      : `${endpoint}/openai/realtime?api-version=${AZURE_API_VERSION}&deployment=${encodeURIComponent(deployment)}`;
    return {
      provider: "azure",
      url,
      model: deployment,
      transport: "webrtc",
    };
  }
  const model = normalizeOpenAIRealtimeModel(candidate?.model || cfg.model || OPENAI_REALTIME_MODEL);
  return {
    provider: "openai",
    url: buildOpenAIRealtimeWebRtcUrl(model, candidate?.endpoint || ""),
    model,
    transport: "webrtc",
  };
}

export function beginVoiceTurnTrace(sessionId, metadata = {}) {
  return beginVoiceTurnTraceState(sessionId, metadata);
}

export function completeVoiceTurnTrace(sessionId, details = {}) {
  return completeVoiceTurnTraceState(sessionId, details);
}

export function abortVoiceTurnTrace(sessionId, reason = "aborted", details = {}) {
  return abortVoiceTurnTraceState(sessionId, reason, details);
}

export function getVoiceTurnTrace(sessionId, options = {}) {
  return getVoiceTurnTraceState(sessionId, options);
}

export function renderVoiceTurnTrace(sessionId, options = {}) {
  return renderVoiceTurnTraceState(sessionId, options);
}

export function formatVoiceTurnTrace(sessionId, options = {}) {
  return formatVoiceTurnTraceState(sessionId, options);
}

// ── Voice action dispatch (direct JavaScript, no MCP bridge) ────────────────

/**
 * Dispatch a voice action intent through the action dispatcher.
 * The voice model returns JSON action objects; Bosun processes them
 * directly via JavaScript and returns structured results.
 *
 * @param {Object} intent — { action, params, id? }
 * @param {Object} context — { sessionId, executor, mode, model }
 * @returns {Promise<Object>} Structured result
 */
export async function dispatchVoiceActionIntent(intent, context = {}) {
  try {
    const { dispatchVoiceAction } = await import("./voice-action-dispatcher.mjs");
    return await dispatchVoiceAction(intent, context);
  } catch (err) {
    console.error("[voice-relay] action dispatch error:", err.message);
    return {
      ok: false,
      action: intent?.action || "",
      data: null,
      error: err.message,
      durationMs: 0,
    };
  }
}

/**
 * Dispatch multiple voice action intents.
 * @param {Array} intents
 * @param {Object} context
 * @returns {Promise<Array>}
 */
export async function dispatchVoiceActionIntents(intents, context = {}) {
  try {
    const { dispatchVoiceActions } = await import("./voice-action-dispatcher.mjs");
    return await dispatchVoiceActions(intents, context);
  } catch (err) {
    console.error("[voice-relay] batch action dispatch error:", err.message);
    return [];
  }
}

/**
 * Get the action manifest for voice prompt injection.
 * @returns {string}
 */
export async function getVoiceActionManifest() {
  try {
    const { getVoiceActionPromptSection } = await import("./voice-action-dispatcher.mjs");
    return getVoiceActionPromptSection();
  } catch (err) {
    console.error("[voice-relay] action manifest error:", err.message);
    return "";
  }
}

/**
 * List all available voice actions.
 * @returns {Promise<string[]>}
 */
export async function listVoiceActions() {
  try {
    const { listAvailableActions } = await import("./voice-action-dispatcher.mjs");
    return listAvailableActions();
  } catch {
    return [];
  }
}

/**
 * Build the full voice agent prompt by resolving the voice prompt template
 * and injecting the action manifest.
 *
 * @param {Object} options — { compact?, customInstructions? }
 * @returns {Promise<string>}
 */
export async function buildVoiceAgentPrompt(options = {}) {
  const context = sanitizeVoiceCallContext(options?.context || {});
  return resolveVoiceBaseInstructions(context, {
    compact: options.compact === true,
    customInstructions: options.customInstructions,
  });
}

