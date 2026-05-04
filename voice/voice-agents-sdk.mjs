/**
 * voice-agents-sdk.mjs — Multi-provider voice agent SDK integration.
 *
 * Provider hierarchy (each uses its native SDK when available):
 *   1. OpenAI  → @openai/agents RealtimeAgent (WebRTC / WebSocket)
 *   2. Azure   → @openai/agents RealtimeAgent (same SDK, Azure endpoint)
 *   3. Gemini  → @google/genai Live API (WebSocket streaming)
 *   4. Claude  → No native voice SDK → falls back to Bosun Tier 2
 *   5. Bosun legacy → Custom WebRTC / Web Speech API fallback
 *
 * Each provider exposes a unified interface:
 *   - createSdkSession(provider, config) → session handle
 *   - getSdkCapabilities(provider) → { hasNativeSdk, transport, ... }
 *   - getSdkToolDefinitions(provider, tools) → provider-specific tool format
 *
 * @module voice-agents-sdk
 */

import { loadConfig } from "../config/config.mjs";
import { resolveSharedOAuthToken as resolveVoiceOAuthToken } from "../agent/provider-auth-state.mjs";

// ── Module-scope lazy imports ───────────────────────────────────────────────

let _openaiAgentsModule = null;
let _googleGenaiModule = null;

async function getOpenAIAgents() {
  if (!_openaiAgentsModule) {
    try {
      _openaiAgentsModule = await import("@openai/agents/realtime");
    } catch (err) {
      console.warn("[voice-agents-sdk] @openai/agents/realtime not available:", err.message);
      _openaiAgentsModule = null;
    }
  }
  return _openaiAgentsModule;
}

async function getGoogleGenAI() {
  if (!_googleGenaiModule) {
    try {
      _googleGenaiModule = await import("@google/genai");
    } catch (err) {
      console.warn("[voice-agents-sdk] @google/genai not available:", err.message);
      _googleGenaiModule = null;
    }
  }
  return _googleGenaiModule;
}

// ── Constants ───────────────────────────────────────────────────────────────

const OPENAI_REALTIME_MODEL = "gpt-realtime-1.5";

function normalizeOpenAIRealtimeModel(rawModel) {
  const model = String(rawModel || "").trim();
  if (!model) return OPENAI_REALTIME_MODEL;
  if (/^gpt-audio/i.test(model)) return OPENAI_REALTIME_MODEL;
  return model;
}

function normalizeAzureRealtimeDeployment(rawDeployment) {
  const deployment = String(rawDeployment || "").trim();
  if (!deployment) return OPENAI_REALTIME_MODEL;
  if (/^gpt-audio/i.test(deployment)) return OPENAI_REALTIME_MODEL;
  return deployment;
}

// GA models (gpt-realtime, gpt-realtime-1.5, gpt-realtime-mini, etc.) use /openai/v1/ WebSocket path.
// Preview models use /openai/realtime?api-version=...&deployment=...
function isAzureGaProtocol(deployment) {
  const d = String(deployment || "").toLowerCase().trim();
  return d.startsWith("gpt-realtime") && !d.startsWith("gpt-4o-realtime");
}
const GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

const SDK_PROVIDERS = Object.freeze({
  openai: {
    name: "openai",
    sdkPackage: "@openai/agents",
    hasNativeSdk: true,
    transport: "webrtc",
    tier: 1,
  },
  azure: {
    name: "azure",
    sdkPackage: "@openai/agents",
    hasNativeSdk: true,
    transport: "webrtc",
    tier: 1,
  },
  gemini: {
    name: "gemini",
    sdkPackage: "@google/genai",
    hasNativeSdk: true,
    transport: "websocket",
    tier: 1,
  },
  claude: {
    name: "claude",
    sdkPackage: null,
    hasNativeSdk: false,
    transport: "fallback",
    tier: 2,
  },
  fallback: {
    name: "fallback",
    sdkPackage: null,
    hasNativeSdk: false,
    transport: "fallback",
    tier: 2,
  },
});

// ── Capability detection ────────────────────────────────────────────────────

/**
 * Check if a provider's native SDK is available and loadable.
 * @param {string} provider
 * @returns {Promise<{ available: boolean, reason?: string, info: object }>}
 */
export async function checkSdkAvailability(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  const info = SDK_PROVIDERS[normalized] || SDK_PROVIDERS.fallback;

  if (!info.hasNativeSdk) {
    return {
      available: false,
      reason: `No native voice SDK for ${normalized}`,
      info,
      fallbackTo: "bosun-legacy",
    };
  }

  if (normalized === "openai" || normalized === "azure") {
    const mod = await getOpenAIAgents();
    if (!mod || !mod.RealtimeAgent || !mod.RealtimeSession) {
      return {
        available: false,
        reason: "@openai/agents/realtime not loadable",
        info,
        fallbackTo: "bosun-legacy",
      };
    }
    return { available: true, info };
  }

  if (normalized === "gemini") {
    const mod = await getGoogleGenAI();
    if (!mod) {
      return {
        available: false,
        reason: "@google/genai not loadable",
        info,
        fallbackTo: "bosun-legacy",
      };
    }
    return { available: true, info };
  }

  return {
    available: false,
    reason: `Unknown provider: ${normalized}`,
    info: SDK_PROVIDERS.fallback,
    fallbackTo: "bosun-legacy",
  };
}

/**
 * Get SDK capabilities for all configured providers.
 * @returns {Promise<Record<string, object>>}
 */
export async function getAllSdkCapabilities() {
  const results = {};
  for (const provider of Object.keys(SDK_PROVIDERS)) {
    results[provider] = await checkSdkAvailability(provider);
  }
  return results;
}

// ── OpenAI/Azure Agents SDK integration ─────────────────────────────────────

/**
 * Convert Bosun voice tool definitions (OpenAI function-calling format)
 * to @openai/agents tool() format for use with RealtimeAgent.
 *
 * Since the Agents SDK tool() helper requires Zod schemas and execute functions,
 * and our tools execute server-side via voice-tools.mjs, we keep tool definitions
 * in OpenAI format and pass them as raw config to the RealtimeSession.
 *
 * @param {Array} bosunTools — Array of { type, name, description, parameters }
 * @returns {Array} tools in format compatible with RealtimeAgent
 */
export function convertToolsForAgentsSdk(bosunTools) {
  if (!Array.isArray(bosunTools)) return [];
  return bosunTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Create an OpenAI Agents SDK RealtimeAgent for voice sessions.
 * @param {object} options
 * @returns {Promise<{ agent: object, sessionFactory: Function } | null>}
 */
export async function createOpenAIRealtimeAgent(options = {}) {
  const mod = await getOpenAIAgents();
  if (!mod || !mod.RealtimeAgent) {
    return null;
  }

  const { RealtimeAgent } = mod;

  const instructions = options.instructions || `You are Bosun, a helpful voice assistant for the VirtEngine development platform.
You help developers manage tasks, steer coding agents, monitor builds, and navigate the workspace.
Be concise and conversational. When users ask about code or tasks, use the available tools.
For complex operations like writing code or creating PRs, delegate to the appropriate agent.`;

  // If caller provided enrichInstructions, attempt to inject the action manifest
  let enrichedInstructions = instructions;
  if (options.enrichInstructions !== false) {
    try {
      const { buildVoiceAgentPrompt } = await import("./voice-relay.mjs");
      enrichedInstructions = await buildVoiceAgentPrompt({
        compact: options.compact || false,
        customInstructions: options.instructions || undefined,
      });
    } catch {
      // Fall back to base instructions
    }
  }
  if (!enrichedInstructions || !enrichedInstructions.trim()) {
    enrichedInstructions = instructions;
  }

  const agent = new RealtimeAgent({
    name: options.name || "Bosun Voice Agent",
    instructions: enrichedInstructions,
    tools: options.tools || [],
    handoffs: options.handoffs || [],
  });

  return {
    agent,
    provider: "openai",
    sdkVersion: mod.VERSION || "unknown",
  };
}

/**
 * Create a RealtimeSession from an agent with provider-specific config.
 * @param {object} agent — RealtimeAgent instance
 * @param {string} provider — "openai" or "azure"
 * @param {object} config — Voice config from getVoiceConfig()
 * @param {object} options — Session options
 * @returns {Promise<object>} RealtimeSession
 */
export async function createRealtimeSession(agent, provider, config = {}, options = {}) {
  const mod = await getOpenAIAgents();
  if (!mod || !mod.RealtimeSession) {
    throw new Error("@openai/agents/realtime not available");
  }

  const { RealtimeSession } = mod;

  const model = normalizeOpenAIRealtimeModel(
    options.model || config.model || OPENAI_REALTIME_MODEL,
  );

  const voiceId = String(
    options.voiceId || config.voiceId || "alloy",
  ).trim() || "alloy";

  const turnDetection = String(
    options.turnDetection || config.turnDetection || "semantic_vad",
  ).trim();

  const sessionConfig = {
    model,
    config: {
      outputModalities: ["text", "audio"],
      audio: {
        input: {
          format: "pcm16",
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turnDetection: {
            type: turnDetection,
            ...(turnDetection === "server_vad"
              ? { threshold: 0.75, prefix_padding_ms: 500, silence_duration_ms: 1200 }
              : {}),
            ...(turnDetection === "semantic_vad"
              ? { eagerness: "low" }
              : {}),
          },
        },
        output: {
          format: "pcm16",
          voice: voiceId,
        },
      },
    },
  };

  const session = new RealtimeSession(agent, sessionConfig);

  return {
    session,
    provider,
    model,
    voiceId,
    transport: options.transport || "webrtc",
  };
}

/**
 * Connect a RealtimeSession to the provider.
 * @param {object} sessionHandle — from createRealtimeSession()
 * @param {object} config — Voice config with credentials
 * @returns {Promise<void>}
 */
export async function connectRealtimeSession(sessionHandle, config = {}) {
  const { session, provider } = sessionHandle;

  const connectOpts = {};

  if (provider === "azure") {
    const credential = String(
      config.azureOAuthToken || config.azureKey || "",
    ).trim();
    if (!credential) {
      throw new Error("Azure voice credential not configured");
    }
    let endpoint = String(config.azureEndpoint || "").trim();
    while (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
    const openaiIdx = endpoint.toLowerCase().indexOf("/openai");
    if (openaiIdx >= 0) endpoint = endpoint.slice(0, openaiIdx);
    const deployment = normalizeAzureRealtimeDeployment(
      config.azureDeployment || OPENAI_REALTIME_MODEL,
    );
    connectOpts.apiKey = credential;
    connectOpts.url = isAzureGaProtocol(deployment)
      ? `${endpoint}/openai/v1/realtime`
      : `${endpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${deployment}`;
  } else {
    // OpenAI
    const credential = String(
      config.openaiOAuthToken || config.openaiKey || "",
    ).trim();
    if (!credential) {
      throw new Error("OpenAI voice credential not configured");
    }
    connectOpts.apiKey = credential;
  }

  await session.connect(connectOpts);
}

// ── Gemini Live API integration ─────────────────────────────────────────────

/**
 * Create a Gemini Live session using @google/genai.
 * Gemini Live uses WebSocket-based streaming (not WebRTC).
 *
 * @param {object} options
 * @returns {Promise<object | null>}
 */
export async function createGeminiLiveSession(options = {}) {
  const genai = await getGoogleGenAI();
  if (!genai) return null;

  const apiKey = String(
    options.geminiKey || options.apiKey || "",
  ).trim();
  if (!apiKey) {
    throw new Error("Gemini API key not configured for Live API");
  }

  const model = String(
    options.model || GEMINI_LIVE_MODEL,
  ).trim() || GEMINI_LIVE_MODEL;

  const instructions = options.instructions || `You are Bosun, a helpful voice assistant for the VirtEngine development platform.
You help developers manage tasks, steer coding agents, monitor builds, and navigate the workspace.
Be concise and conversational.`;

  // Enrich with action manifest for Gemini too
  let enrichedInstructions = instructions;
  if (options.enrichInstructions !== false) {
    try {
      const { buildVoiceAgentPrompt } = await import("./voice-relay.mjs");
      enrichedInstructions = await buildVoiceAgentPrompt({
        compact: options.compact || false,
        customInstructions: options.instructions || undefined,
      });
    } catch {
      // Fall back to base instructions
    }
  }
  if (!enrichedInstructions || !enrichedInstructions.trim()) {
    enrichedInstructions = instructions;
  }

  const GenAIClient = genai.GoogleGenAI || genai.GoogleGenerativeAI || genai.default;
  if (!GenAIClient) {
    throw new Error("Could not resolve GoogleGenAI client constructor from @google/genai");
  }

  const client = new GenAIClient({ apiKey });

  // Build tool declarations for Gemini format
  const toolDeclarations = (options.tools || []).map((tool) => ({
    name: tool.name,
    description: tool.description || "",
    parameters: tool.parameters || { type: "object", properties: {} },
  }));

  const liveConfig = {
    responseModalities: ["AUDIO"],
    systemInstruction: enrichedInstructions,
    ...(toolDeclarations.length > 0
      ? { tools: [{ functionDeclarations: toolDeclarations }] }
      : {}),
  };

  return {
    client,
    model,
    liveConfig,
    provider: "gemini",
    transport: "websocket",
    apiKey,

    /**
     * Connect to Gemini Live streaming session.
     * Returns a live session handle for send/receive.
     */
    async connect() {
      const liveSession = await client.aio?.live?.connect?.({
        model,
        config: liveConfig,
      });
      if (!liveSession) {
        // Fallback: try the synchronous live connect
        const liveClient = client.live || client.aio?.live;
        if (!liveClient) {
          throw new Error("Gemini Live API not available in this version of @google/genai");
        }
        return liveClient.connect({ model, config: liveConfig });
      }
      return liveSession;
    },
  };
}

// ── Unified session factory ─────────────────────────────────────────────────

/**
 * Create a voice session using the best available SDK for the given provider.
 * Falls back to { useLegacy: true } if no SDK is available.
 *
 * @param {string} provider — "openai", "azure", "gemini", "claude", "fallback"
 * @param {object} voiceConfig — from getVoiceConfig()
 * @param {object} options — { tools, instructions, callContext }
 * @returns {Promise<object>} Session handle or { useLegacy: true, reason }
 */
export async function createSdkVoiceSession(provider, voiceConfig = {}, options = {}) {
  const normalized = String(provider || "").trim().toLowerCase();

  // ── OpenAI / Azure: use @openai/agents ──
  if (normalized === "openai" || normalized === "azure") {
    try {
      const availability = await checkSdkAvailability(normalized);
      if (!availability.available) {
        return {
          useLegacy: true,
          reason: availability.reason,
          provider: normalized,
        };
      }

      const agentResult = await createOpenAIRealtimeAgent({
        instructions: voiceConfig.instructions || options.instructions,
        tools: options.tools || [],
        name: options.agentName || "Bosun Voice Agent",
      });

      if (!agentResult) {
        return {
          useLegacy: true,
          reason: "Failed to create RealtimeAgent",
          provider: normalized,
        };
      }

      const sessionHandle = await createRealtimeSession(
        agentResult.agent,
        normalized,
        voiceConfig,
        {
          model: voiceConfig.model,
          voiceId: voiceConfig.voiceId,
          turnDetection: voiceConfig.turnDetection,
        },
      );

      return {
        useLegacy: false,
        sdk: "openai-agents",
        provider: normalized,
        agent: agentResult.agent,
        session: sessionHandle.session,
        sessionHandle,
        model: sessionHandle.model,
        voiceId: sessionHandle.voiceId,

        async connect() {
          await connectRealtimeSession(sessionHandle, voiceConfig);
        },

        async disconnect() {
          try {
            sessionHandle.session.close?.();
          } catch {
            // best effort
          }
        },
      };
    } catch (err) {
      console.error(`[voice-agents-sdk] ${normalized} SDK session failed:`, err.message);
      return {
        useLegacy: true,
        reason: `SDK error: ${err.message}`,
        provider: normalized,
      };
    }
  }

  // ── Gemini: use @google/genai Live API ──
  if (normalized === "gemini") {
    try {
      const availability = await checkSdkAvailability("gemini");
      if (!availability.available) {
        return {
          useLegacy: true,
          reason: availability.reason,
          provider: "gemini",
        };
      }

      const geminiSession = await createGeminiLiveSession({
        geminiKey: voiceConfig.geminiKey || voiceConfig.geminiOAuthToken,
        model: voiceConfig.model,
        instructions: voiceConfig.instructions || options.instructions,
        tools: options.tools || [],
      });

      if (!geminiSession) {
        return {
          useLegacy: true,
          reason: "Failed to create Gemini Live session",
          provider: "gemini",
        };
      }

      return {
        useLegacy: false,
        sdk: "google-genai-live",
        provider: "gemini",
        model: geminiSession.model,
        transport: "websocket",
        geminiSession,

        async connect() {
          const liveHandle = await geminiSession.connect();
          this.liveHandle = liveHandle;
          return liveHandle;
        },

        async disconnect() {
          try {
            this.liveHandle?.close?.();
          } catch {
            // best effort
          }
        },
      };
    } catch (err) {
      console.error("[voice-agents-sdk] Gemini SDK session failed:", err.message);
      return {
        useLegacy: true,
        reason: `SDK error: ${err.message}`,
        provider: "gemini",
      };
    }
  }

  // ── Claude / Fallback: no native SDK ──
  return {
    useLegacy: true,
    reason: normalized === "claude"
      ? "Anthropic does not provide a real-time voice SDK"
      : "Using Bosun browser STT/TTS fallback",
    provider: normalized,
  };
}

// ── Provider resolution with SDK preference ────────────────────────────────

/**
 * Resolve the best voice session across the provider chain, preferring
 * native SDK implementations. Falls through to Bosun legacy for each
 * provider that fails SDK initialization.
 *
 * @param {object} voiceConfig — from getVoiceConfig()
 * @param {object} options — { tools, instructions, callContext }
 * @returns {Promise<object>} Best available session or legacy fallback
 */
export async function resolveBestVoiceSession(voiceConfig = {}, options = {}) {
  const providerChain = voiceConfig.providerChainWithFallbacks || [voiceConfig.provider || "openai"];
  const errors = [];

  for (const provider of providerChain) {
    const session = await createSdkVoiceSession(provider, voiceConfig, options);
    if (!session.useLegacy) {
      return session;
    }
    errors.push({ provider, reason: session.reason });
  }

  // All SDK attempts failed — return legacy fallback signal
  return {
    useLegacy: true,
    reason: "All provider SDKs unavailable, using Bosun legacy voice",
    errors,
    provider: voiceConfig.provider || "fallback",
  };
}

// ── Session config for client-side SDK usage ───────────────────────────────

/**
 * Generate client-side SDK configuration data for the voice overlay.
 * The client uses this to decide whether to initialize the Agents SDK
 * or fall back to legacy WebRTC.
 *
 * @param {object} voiceConfig — from getVoiceConfig()
 * @returns {Promise<object>} Client configuration
 */
export async function getClientSdkConfig(voiceConfig = {}) {
  const provider = voiceConfig.provider || "fallback";
  const configuredModel = String(voiceConfig.model || OPENAI_REALTIME_MODEL).trim();
  const audioResponsesMode = /^gpt-audio/i.test(configuredModel);
  const availability = await checkSdkAvailability(provider);
  const useSdk = availability.available && !audioResponsesMode;
  const fallbackReason = !useSdk
    ? (audioResponsesMode
      ? "gpt-audio models use Responses audio transport (legacy client path)"
      : availability.reason)
    : null;

  return {
    useSdk,
    provider,
    sdkPackage: availability.info?.sdkPackage || null,
    transport: audioResponsesMode ? "responses-audio" : (availability.info?.transport || "fallback"),
    tier: availability.info?.tier || 2,
    model: configuredModel,
    voiceId: voiceConfig.voiceId || "alloy",
    turnDetection: voiceConfig.turnDetection || "semantic_vad",
    fallbackReason,
  };
}

// ── Health check for active SDK sessions ───────────────────────────────────

/**
 * Diagnostic info for all SDK integrations.
 * @returns {Promise<object>}
 */
export async function getSdkDiagnostics() {
  const capabilities = await getAllSdkCapabilities();
  const openaiMod = await getOpenAIAgents().catch(() => null);
  const genaiMod = await getGoogleGenAI().catch(() => null);

  return {
    providers: capabilities,
    sdkVersions: {
      openaiAgents: openaiMod?.VERSION || (openaiMod ? "loaded (version unknown)" : "not loaded"),
      googleGenai: genaiMod?.VERSION || (genaiMod ? "loaded (version unknown)" : "not loaded"),
    },
    timestamp: new Date().toISOString(),
  };
}

