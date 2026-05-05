/**
 * voice-client-sdk.js — Client-side voice using @openai/agents SDK as primary,
 * with automatic fallback to legacy voice-client.js on failure.
 *
 * Provider strategy:
 *   - OpenAI/Azure: @openai/agents RealtimeSession (WebRTC, auto mic/speaker)
 *   - Gemini: WebSocket streaming via server proxy (Live API)
 *   - Claude/fallback: Falls through to voice-fallback.js (Web Speech API)
 *
 * The module exposes the same signal-based API as voice-client.js so
 * voice-overlay.js can switch transparently.
 *
 * @module voice-client-sdk
 */

import { signal, computed } from "@preact/signals";
import {
  ensureMicTrackingPatched,
  registerMicStream,
  stopTrackedMicStreams,
} from "./mic-track-registry.js";
import { shouldAutoBargeIn } from "./voice-barge-in.js";
import { isVoiceMicMuted } from "./voice-client.js";

// ── State Signals (same shape as voice-client.js) ───────────────────────────

export const sdkVoiceState = signal("idle");
export const sdkVoiceTranscript = signal("");
export const sdkVoiceResponse = signal("");
export const sdkVoiceError = signal(null);
export const sdkVoiceToolCalls = signal([]);
export const sdkVoiceSessionId = signal(null);
export const sdkVoiceBoundSessionId = signal(null);
export const sdkVoiceDuration = signal(0);
export const sdkVoiceProvider = signal(null);
export const sdkVoiceSdkActive = signal(false);

export const isSdkVoiceActive = computed(() =>
  sdkVoiceState.value !== "idle" && sdkVoiceState.value !== "error"
);

// User transcript is always enabled — transcription is surfaced from the API's
// input_audio_transcription feature (primary) or browser SpeechRecognition (backup).
const ENABLE_USER_TRANSCRIPT = true;

// ── Browser SpeechRecognition (parallel backup for user transcription) ──────

const _BrowserSpeechRecognition = typeof globalThis !== "undefined"
  ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
  : null;
let _browserRecognition = null;
let _browserTranscriptActive = false;
// When the API-level transcription delivers a user transcript, we prefer it
// over the browser's; this flag suppresses duplicate browser results.
let _apiTranscriptDelivered = false;

function _startBrowserTranscription() {
  if (!_BrowserSpeechRecognition || _browserRecognition) return;
  try {
    const recognition = new _BrowserSpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    // Attempt to match user's language, fall back to English
    recognition.lang = navigator?.language || "en-US";

    recognition.onresult = (event) => {
      // Only use browser transcript when API-level transcription hasn't delivered yet
      if (_apiTranscriptDelivered) return;
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      const text = transcript.trim();
      if (!text) return;
      sdkVoiceTranscript.value = text;
      emit("transcript", { text, final: event.results[event.resultIndex]?.isFinal || false, source: "browser" });
      if (event.results[event.resultIndex]?.isFinal) {
        _persistTranscriptIfNew("user", text, "browser.speech_recognition.final");
      }
    };

    recognition.onerror = (e) => {
      // Non-fatal: browser recognition may fail on some systems
      if (e.error !== "no-speech" && e.error !== "aborted") {
        console.warn("[voice-client-sdk] Browser SpeechRecognition error:", e.error);
      }
    };

    recognition.onend = () => {
      // Auto-restart while session is active
      if (_browserTranscriptActive && _session) {
        try { recognition.start(); } catch { /* already running or stopped */ }
      }
    };

    recognition.start();
    _browserRecognition = recognition;
    _browserTranscriptActive = true;
  } catch (err) {
    console.warn("[voice-client-sdk] Browser SpeechRecognition unavailable:", err?.message);
  }
}

function _stopBrowserTranscription() {
  _browserTranscriptActive = false;
  if (_browserRecognition) {
    try { _browserRecognition.stop(); } catch { /* ignore */ }
    _browserRecognition = null;
  }
}

// ── Module-scope state ──────────────────────────────────────────────────────

let _session = null;
let _durationTimer = null;
let _sessionStartTime = 0;
let _eventHandlers = new Map();
let _geminiMicStream = null;
let _geminiRecorder = null;
let _callContext = {
  sessionId: null,
  executor: null,
  mode: null,
  model: null,
  voiceAgentId: null,
};
let _sdkConfig = null;
let _usingLegacyFallback = false;
let _sdkModuleUnavailableLogged = false;
let _agentsRealtimeModulePromise = null;
let _agentsRealtimeModuleSource = null;
let _lastPersistedUserTranscript = "";
let _lastPersistedAssistantTranscript = "";
let _pendingUserTranscriptTimer = null;
let _pendingAssistantTranscriptTimer = null;
let _pendingUserTranscriptText = "";
let _pendingAssistantTranscriptText = "";
let _awaitingToolCompletionAck = false;
let _toolCompletionAckTimer = null;
let _assistantBaselineBeforeToolAck = "";
const _sdkCapturedMicStreams = new Set();
let _lastAutoBargeInAt = 0;
const AUTO_BARGE_IN_COOLDOWN_MS = 1200;
// Minimum speech duration (ms) before an interrupt is allowed — filters keyboard/click noise
let _speechStartedAt = 0;
const MIN_SPEECH_DURATION_FOR_INTERRUPT_MS = 400;
// Delayed response clear — keep response visible in center after turn ends
let _responseClearTimer = null;
const RESPONSE_DISPLAY_HOLD_MS = 8000;
let _traceTurnCounter = 0;
let _traceCurrentTurnId = null;
let _traceTurnActive = false;
let _traceLlmFirstTokenMarked = false;
let _traceTtsFirstAudioMarked = false;
// Set to true by stopSdkVoiceSession() so that any in-flight getUserMedia
// call in startAgentsSdkSession / startGeminiMicCapture releases the track
// immediately instead of leaving the browser mic indicator active.
let _sdkExplicitStop = false;

// ── Event System ────────────────────────────────────────────────────────────

export function onSdkVoiceEvent(event, handler) {
  if (!_eventHandlers.has(event)) _eventHandlers.set(event, new Set());
  _eventHandlers.get(event).add(handler);
  return () => _eventHandlers.get(event)?.delete(handler);
}

function emit(event, data) {
  const handlers = _eventHandlers.get(event);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[voice-client-sdk] event handler error (${event}):`, err);
      }
    }
  }
}

function maybeAutoInterruptSdkResponse(reason = "speech-started") {
  const now = Date.now();
  // Only interrupt if speech has been ongoing long enough to be real speech
  // (filters out keyboard clicks, mouse clicks, coughs, etc.)
  if (_speechStartedAt > 0) {
    const speechDuration = now - _speechStartedAt;
    if (speechDuration < MIN_SPEECH_DURATION_FOR_INTERRUPT_MS) {
      return false;
    }
  }
  if (!shouldAutoBargeIn({
    muted: isVoiceMicMuted.value,
    audioActive: Boolean(_session),
    now,
    lastTriggeredAt: _lastAutoBargeInAt,
    minIntervalMs: AUTO_BARGE_IN_COOLDOWN_MS,
  })) {
    return false;
  }
  _lastAutoBargeInAt = now;
  interruptSdkResponse();
  sdkVoiceState.value = "listening";
  emit("auto-barge-in", { reason });
  return true;
}

function _currentTraceSessionId() {
  return String(_callContext?.sessionId || sdkVoiceSessionId.value || "").trim();
}

function _recordSdkTraceEvent(eventType, extra = {}) {
  const sessionId = _currentTraceSessionId();
  const normalizedEventType = String(eventType || "").trim();
  if (!sessionId || !normalizedEventType) return;
  const payload = {
    sessionId,
    turnId: String(extra?.turnId || _traceCurrentTurnId || "").trim() || null,
    eventType: normalizedEventType,
    source: "voice-client-sdk",
    provider: String(extra?.provider || sdkVoiceProvider.value || "").trim() || undefined,
    transport: String(extra?.transport || "sdk").trim() || "sdk",
    reason: String(extra?.reason || "").trim() || undefined,
    role: String(extra?.role || "").trim() || undefined,
    timestamp: new Date().toISOString(),
    meta: extra?.meta && typeof extra.meta === "object" ? extra.meta : undefined,
  };
  fetch("/api/voice/trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch((err) => {
    console.warn("[voice-client-sdk] trace persistence failed:", err?.message || err);
  });
}

function _sdkTraceBeginTurn(eventType, extra = {}) {
  if (_traceTurnActive && _traceCurrentTurnId) return;
  _traceTurnCounter += 1;
  _traceCurrentTurnId = `${_currentTraceSessionId() || "voice"}-turn-${Date.now()}-${_traceTurnCounter}`;
  _traceTurnActive = true;
  _traceLlmFirstTokenMarked = false;
  _traceTtsFirstAudioMarked = false;
  _recordSdkTraceEvent(eventType, {
    ...extra,
    turnId: _traceCurrentTurnId,
  });
}

function _sdkTraceMarkLlmFirstToken(eventType, extra = {}) {
  if (!_traceTurnActive || !_traceCurrentTurnId || _traceLlmFirstTokenMarked) return;
  _traceLlmFirstTokenMarked = true;
  _recordSdkTraceEvent(eventType, {
    ...extra,
    turnId: _traceCurrentTurnId,
  });
}

function _sdkTraceMarkTtsFirstAudio(eventType, extra = {}) {
  if (!_traceTurnActive || !_traceCurrentTurnId || _traceTtsFirstAudioMarked) return;
  _traceTtsFirstAudioMarked = true;
  _recordSdkTraceEvent(eventType, {
    ...extra,
    turnId: _traceCurrentTurnId,
  });
}

function _sdkTraceEndTurn(eventType, extra = {}) {
  if (!_traceTurnActive || !_traceCurrentTurnId) return;
  _recordSdkTraceEvent(eventType, {
    ...extra,
    turnId: _traceCurrentTurnId,
  });
  _traceTurnActive = false;
  _traceCurrentTurnId = null;
  _traceLlmFirstTokenMarked = false;
  _traceTtsFirstAudioMarked = false;
}

function _sdkTraceInterrupt(eventType, extra = {}) {
  _recordSdkTraceEvent(eventType, {
    ...extra,
    turnId: _traceCurrentTurnId,
  });
  if (_traceTurnActive) {
    _sdkTraceEndTurn("turn_end", {
      reason: "interrupted",
      ...extra,
    });
  }
}

function _normalizeCallContext(options = {}) {
  return {
    sessionId: String(options?.sessionId || "").trim() || null,
    executor: String(options?.executor || "").trim() || null,
    mode: String(options?.mode || "").trim() || null,
    model: String(options?.model || "").trim() || null,
    voiceAgentId: String(options?.voiceAgentId || "").trim() || null,
  };
}

function getSdkErrorMessage(err) {
  if (!err) return "Session error";
  if (typeof err?.message === "string" && err.message.trim()) return err.message.trim();
  if (typeof err?.error?.message === "string" && err.error.message.trim()) return err.error.message.trim();
  if (typeof err?.error === "string" && err.error.trim()) return err.error.trim();
  return "Session error";
}

function isGenericSdkErrorMessage(message) {
  const normalized = String(message || "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "session error" || normalized === "unknown error";
}

function isNonFatalSdkSessionError(err) {
  const message = getSdkErrorMessage(err);
  const lower = String(message || "").toLowerCase();
  // Tool policy errors are surfaced in tool-call UI; they should not trip a
  // persistent top-level "Session error" banner while audio remains healthy.
  if (lower.includes("not allowed for session-bound calls")) {
    return true;
  }
  if (lower.includes("no active response found") || lower.includes("cancellation failed")) {
    return true;
  }
  if (!message) return false;
  // Seen during transient renegotiation on some browsers even when stream remains active.
  if (/setRemoteDescription/i.test(message) && /SessionDescription/i.test(message)) {
    return true;
  }
  // Runtime item-level transcription failures should not hard-fail the live call.
  if (
    lower.includes("input transcription failed")
    || lower.includes("transcription failed for item")
    || lower.includes("input_audio_transcription")
  ) {
    return true;
  }
  return false;
}

function isAzureGaRealtimeDeployment(deployment) {
  const normalized = String(deployment || "").trim().toLowerCase();
  return normalized.startsWith("gpt-realtime") && !normalized.startsWith("gpt-4o-realtime");
}

function isUsableAgentsRealtimeModule(mod) {
  return Boolean(mod && mod.RealtimeAgent && mod.RealtimeSession);
}

async function loadAgentsRealtimeModule() {
  if (_agentsRealtimeModulePromise) return _agentsRealtimeModulePromise;
  _agentsRealtimeModulePromise = (async () => {
    // 1) Prefer locally bundled dependency when available.
    try {
      const mod = await import("@openai/agents/realtime");
      if (isUsableAgentsRealtimeModule(mod)) {
        _agentsRealtimeModuleSource = "local-bundle";
        return mod;
      }
    } catch {
      // continue to browser ESM fallbacks
    }

    // 2) Browser-safe ESM fallbacks for non-bundled deployments.
    const sources = [
      "https://esm.sh/@openai/agents/realtime?bundle",
      "https://cdn.jsdelivr.net/npm/@openai/agents/realtime/+esm",
      "https://unpkg.com/@openai/agents/realtime?module",
    ];
    let lastErr = null;
    for (const source of sources) {
      try {
        const mod = await import(source);
        if (isUsableAgentsRealtimeModule(mod)) {
          _agentsRealtimeModuleSource = source;
          return mod;
        }
        lastErr = new Error(`Loaded SDK module from ${source}, but exports were incomplete`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Failed to load @openai/agents/realtime in browser");
  })();
  return _agentsRealtimeModulePromise;
}

// ── SDK Configuration Fetch ────────────────────────────────────────────────

/**
 * Fetch SDK configuration from the server.
 * Determines if we should use Agents SDK or legacy voice.
 */
async function fetchSdkConfig() {
  try {
    const res = await fetch("/api/voice/sdk-config", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      return { useSdk: false, reason: `Server returned ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { useSdk: false, reason: err.message };
  }
}

// ── Transcript persistence ──────────────────────────────────────────────────

async function _recordTranscript(role, content, eventType = "") {
  const sessionId = String(_callContext?.sessionId || sdkVoiceSessionId.value || "").trim();
  const text = String(content || "").trim();
  if (!sessionId || !text) return;
  try {
    await fetch("/api/voice/transcript", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        role,
        content: text,
        eventType,
        executor: _callContext?.executor || undefined,
        mode: _callContext?.mode || undefined,
        model: _callContext?.model || undefined,
        provider: sdkVoiceProvider.value || undefined,
      }),
    });
  } catch (err) {
    console.warn("[voice-client-sdk] transcript persistence failed:", err?.message || err);
  }
}

function _resetTranscriptPersistenceState() {
  _lastPersistedUserTranscript = "";
  _lastPersistedAssistantTranscript = "";
  _pendingUserTranscriptText = "";
  _pendingAssistantTranscriptText = "";
  if (_pendingUserTranscriptTimer) {
    clearTimeout(_pendingUserTranscriptTimer);
    _pendingUserTranscriptTimer = null;
  }
  if (_pendingAssistantTranscriptTimer) {
    clearTimeout(_pendingAssistantTranscriptTimer);
    _pendingAssistantTranscriptTimer = null;
  }
  if (_toolCompletionAckTimer) {
    clearTimeout(_toolCompletionAckTimer);
    _toolCompletionAckTimer = null;
  }
  _awaitingToolCompletionAck = false;
  _assistantBaselineBeforeToolAck = "";
  _traceTurnCounter = 0;
  _traceCurrentTurnId = null;
  _traceTurnActive = false;
  _traceLlmFirstTokenMarked = false;
  _traceTtsFirstAudioMarked = false;
  _apiTranscriptDelivered = false;
  // Clean up tool result injection state
  for (const timer of _pendingToolResultTimers.values()) {
    clearTimeout(timer);
  }
  _pendingToolResultTimers.clear();
  _toolResultInjected.clear();
}

function _flushPendingTranscriptBuffers() {
  if (_pendingUserTranscriptTimer) {
    clearTimeout(_pendingUserTranscriptTimer);
    _pendingUserTranscriptTimer = null;
  }
  if (_pendingAssistantTranscriptTimer) {
    clearTimeout(_pendingAssistantTranscriptTimer);
    _pendingAssistantTranscriptTimer = null;
  }

  const finalUser = String(_pendingUserTranscriptText || "").trim();
  if (finalUser) {
    _persistTranscriptIfNew("user", finalUser, "sdk.history_updated.user.flush");
  }

  const finalAssistant = String(_pendingAssistantTranscriptText || "").trim();
  if (finalAssistant) {
    _persistTranscriptIfNew("assistant", finalAssistant, "sdk.history_updated.assistant.flush");
  }

  _pendingUserTranscriptText = "";
  _pendingAssistantTranscriptText = "";
}

function _persistTranscriptIfNew(role, text, eventType) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const value = String(text || "").trim();
  if (!value) return;
  if (normalizedRole === "user") {
    if (value === _lastPersistedUserTranscript) return;
    _lastPersistedUserTranscript = value;
  } else if (normalizedRole === "assistant") {
    if (value === _lastPersistedAssistantTranscript) return;
    _lastPersistedAssistantTranscript = value;
  }
  _recordTranscript(normalizedRole, value, eventType);
}

function _markToolCompletionPending() {
  _awaitingToolCompletionAck = true;
  _assistantBaselineBeforeToolAck = String(_lastPersistedAssistantTranscript || "").trim();
  if (_toolCompletionAckTimer) clearTimeout(_toolCompletionAckTimer);
  _toolCompletionAckTimer = setTimeout(() => {
    _toolCompletionAckTimer = null;
    if (!_awaitingToolCompletionAck) return;
    const ack = "Done.";
    sdkVoiceResponse.value = ack;
    emit("response-complete", { text: ack });
    _persistTranscriptIfNew("assistant", ack, "tool_call.done.auto_ack.timeout");
    _awaitingToolCompletionAck = false;
    _assistantBaselineBeforeToolAck = "";
  }, 6000);
}

function _markAssistantToolResponseObserved(latestAssistantText = "") {
  if (!_awaitingToolCompletionAck) return;
  const latest = String(latestAssistantText || _lastPersistedAssistantTranscript || "").trim();
  if (!latest) return;
  if (latest === _assistantBaselineBeforeToolAck) return;
  _awaitingToolCompletionAck = false;
  _assistantBaselineBeforeToolAck = "";
  if (_toolCompletionAckTimer) {
    clearTimeout(_toolCompletionAckTimer);
    _toolCompletionAckTimer = null;
  }
}

// ── Robust tool result injection ────────────────────────────────────────────
// After the SDK processes a tool call, we verify that the model has received
// the function_call_output. If the model hasn't responded within a short
// window, we manually inject the result via sendEvent() as a fallback.

let _pendingToolResultTimers = new Map();
let _toolResultInjected = new Set(); // call IDs that were manually injected

function _ensureToolResultInjected(session, callId, toolName, resultStr) {
  // Immediately inject the tool result into the model's conversation context.
  // The SDK's auto-injection is unreliable — the result gets stored in the
  // session tracker / chat history but doesn't always reach the model's
  // realtime conversation context, causing the model to say "I'm having
  // trouble" even though the tool succeeded.
  const key = String(callId || "");
  if (!key) return;

  // Truncate large results for voice context
  const VOICE_TOOL_OUTPUT_MAX = 6000;
  let output = resultStr || "Done";
  if (output.length > VOICE_TOOL_OUTPUT_MAX) {
    output = output.slice(0, VOICE_TOOL_OUTPUT_MAX)
      + "\n... (truncated for voice — full result available in chat)";
  }

  // Mark as injected immediately to prevent duplicate injections
  _toolResultInjected.add(key);

  // Inject NOW — don't wait for SDK auto-injection
  if (session && typeof session.sendEvent === "function") {
    try {
      session.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      });
      session.sendEvent({ type: "response.create" });
      console.info(`[voice-client-sdk] Injected tool result for ${toolName} (${callId})`);
      return;
    } catch (err) {
      console.warn("[voice-client-sdk] sendEvent injection failed:", err?.message);
    }
  }

  // Fallback: inject as user-role context message
  _injectContextMessage(
    session,
    `[Tool Result — ${toolName}]\n${output}`,
  );
}

/**
 * Inject a context message directly into the voice agent's conversation.
 * Used for tool result fallback injection and background progress updates.
 */
function _injectContextMessage(session, text) {
  if (!session || !text) return;
  const inputText = String(text).trim();
  if (!inputText) return;

  if (typeof session.sendMessage === "function") {
    // @openai/agents SDK — sendMessage injects as user text and triggers response
    session.sendMessage(inputText);
  } else if (typeof session.sendEvent === "function") {
    session.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: inputText }],
      },
    });
    session.sendEvent({ type: "response.create" });
  } else if (session.readyState === WebSocket.OPEN) {
    // Gemini WebSocket
    session.send(JSON.stringify({ type: "text.input", text: inputText }));
  }
}

// ── Background agent progress tracking ──────────────────────────────────────
// When a voice tool dispatches a background task/agent, we track it and
// periodically inject progress updates into the voice conversation so the
// model stays aware without the user having to ask.

let _backgroundProgressTimer = null;
let _trackedBackgroundTasks = new Map(); // taskId → { name, startedAt, lastStatus, sessionId }

function _trackBackgroundTask(taskId, info = {}) {
  const key = String(taskId || "").trim();
  if (!key) return;
  _trackedBackgroundTasks.set(key, {
    name: String(info.name || "background task").trim(),
    startedAt: Date.now(),
    lastStatus: "started",
    lastCheckedAt: 0,
    sessionId: String(info.sessionId || "").trim() || null,
    completionInjected: false,
  });
  _ensureBackgroundProgressPolling();
}

function _ensureBackgroundProgressPolling() {
  if (_backgroundProgressTimer) return;
  if (_trackedBackgroundTasks.size === 0) return;

  _backgroundProgressTimer = setInterval(async () => {
    if (!_session || _trackedBackgroundTasks.size === 0) {
      _stopBackgroundProgressPolling();
      return;
    }

    for (const [taskId, task] of _trackedBackgroundTasks) {
      const now = Date.now();
      // Don't check more than every 15 seconds
      if (now - task.lastCheckedAt < 15_000) continue;
      task.lastCheckedAt = now;

      try {
        const res = await fetch("/api/voice/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolName: "poll_background_session",
            args: { sessionId: task.sessionId || taskId },
            sessionId: sdkVoiceSessionId.value,
          }),
        });
        const result = await res.json();
        const statusText = typeof result?.result === "string"
          ? result.result
          : JSON.stringify(result?.result || "");

        // Detect completion/failure
        const isComplete = /complete|finished|done|failed|error/i.test(statusText);
        const previousStatus = task.lastStatus;
        task.lastStatus = statusText.slice(0, 200);

        // Only inject if status meaningfully changed or task completed
        if (isComplete && !task.completionInjected) {
          task.completionInjected = true;
          const summary = statusText.length > 500
            ? statusText.slice(0, 500) + "..."
            : statusText;
          _injectContextMessage(
            _session,
            `[Background Task Update — ${task.name}]\nStatus: ${summary}\n` +
            "(You don't need to tell the user about this unless they ask about it.)",
          );
          // Remove completed task
          _trackedBackgroundTasks.delete(taskId);
        }
      } catch {
        // Non-fatal — will retry on next interval
      }
    }

    if (_trackedBackgroundTasks.size === 0) {
      _stopBackgroundProgressPolling();
    }
  }, 10_000); // Check every 10 seconds
}

function _stopBackgroundProgressPolling() {
  if (_backgroundProgressTimer) {
    clearInterval(_backgroundProgressTimer);
    _backgroundProgressTimer = null;
  }
  _trackedBackgroundTasks.clear();
  // Clean up pending tool result timers
  for (const timer of _pendingToolResultTimers.values()) {
    clearTimeout(timer);
  }
  _pendingToolResultTimers.clear();
  _toolResultInjected.clear();
}

function _scheduleUserTranscriptFinalize(text) {
  const value = String(text || "").trim();
  if (!value) return;
  _pendingUserTranscriptText = value;
  // API-level transcript arrived — prefer it over browser SpeechRecognition
  _apiTranscriptDelivered = true;
  if (_pendingUserTranscriptTimer) clearTimeout(_pendingUserTranscriptTimer);
  _pendingUserTranscriptTimer = setTimeout(() => {
    _pendingUserTranscriptTimer = null;
    const finalText = String(_pendingUserTranscriptText || "").trim();
    if (!finalText) return;
    sdkVoiceTranscript.value = finalText;
    emit("transcript", { text: finalText, final: true, source: "api" });
    _persistTranscriptIfNew("user", finalText, "sdk.history_updated.user.final");
    // Reset for next utterance
    _apiTranscriptDelivered = false;
  }, 350);
}

function _scheduleAssistantTranscriptFinalize(text) {
  const value = String(text || "").trim();
  if (!value) return;
  _pendingAssistantTranscriptText = value;
  if (_pendingAssistantTranscriptTimer) clearTimeout(_pendingAssistantTranscriptTimer);
  _pendingAssistantTranscriptTimer = setTimeout(() => {
    _pendingAssistantTranscriptTimer = null;
    const finalText = String(_pendingAssistantTranscriptText || "").trim();
    if (!finalText) return;
    _sdkTraceMarkLlmFirstToken("llm_first_token", { reason: "assistant_transcript.final" });
    _sdkTraceMarkTtsFirstAudio("tts_first_audio", { reason: "assistant_transcript.final" });
    sdkVoiceResponse.value = finalText;
    emit("response-complete", { text: finalText });
    _persistTranscriptIfNew("assistant", finalText, "sdk.history_updated.assistant.final");
    _markAssistantToolResponseObserved(finalText);
    _sdkTraceEndTurn("turn_end", { reason: "assistant_transcript.final" });
    // Keep response visible in center — schedule delayed clear instead of
    // immediately setting sdkVoiceResponse to "". The response will persist
    // until the user starts speaking or the hold timer expires.
    _scheduleResponseClear();
    sdkVoiceState.value = "listening";
  }, 700);
}

/**
 * Schedule a delayed clear of the assistant response from the center display.
 * The response stays visible for RESPONSE_DISPLAY_HOLD_MS or until the user
 * starts speaking (whichever comes first).
 */
function _scheduleResponseClear() {
  if (_responseClearTimer) clearTimeout(_responseClearTimer);
  _responseClearTimer = setTimeout(() => {
    _responseClearTimer = null;
    sdkVoiceResponse.value = "";
  }, RESPONSE_DISPLAY_HOLD_MS);
}

/**
 * Immediately clear the response display — called when the user starts
 * speaking so the center area shows their new transcript.
 */
function _clearResponseForNewTurn() {
  if (_responseClearTimer) {
    clearTimeout(_responseClearTimer);
    _responseClearTimer = null;
  }
  sdkVoiceResponse.value = "";
}

// ── OpenAI/Azure Agents SDK Session ─────────────────────────────────────────

/**
 * Start a voice session using @openai/agents RealtimeSession.
 * This runs entirely client-side with WebRTC auto-mic handling.
 */
async function startAgentsSdkSession(config, options = {}) {
  const resolvedConfig = config && typeof config === "object" ? config : {};
  // Dynamically import @openai/agents/realtime using browser-safe sources.
  const agentsMod = await loadAgentsRealtimeModule();
  const { RealtimeAgent, RealtimeSession } = agentsMod;

  if (!RealtimeAgent || !RealtimeSession) {
    throw new Error("@openai/agents/realtime not available in browser");
  }

  // Fetch token and tools from server
  const tokenRes = await fetch("/api/voice/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: _callContext.sessionId || undefined,
      executor: _callContext.executor || undefined,
      mode: _callContext.mode || undefined,
      model: _callContext.model || undefined,
      voiceAgentId: _callContext.voiceAgentId || undefined,
      delegateOnly: false,
      sdkMode: true,
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({ error: "Token fetch failed" }));
    throw new Error(err.error || `Token fetch failed (${tokenRes.status})`);
  }
  const tokenData = await tokenRes.json();

  // Create RealtimeAgent with server-provided instructions
  const agent = new RealtimeAgent({
    name: "Bosun Voice Agent",
    instructions: tokenData.instructions || "You are Bosun, a helpful voice assistant.",
    tools: (tokenData.tools || []).map((t) => {
      // Core fetch logic for executing a tool via the server.
      const fetchToolResult = async (args) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30_000);
        let res;
        try {
          res = await fetch("/api/voice/tool", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              toolName: t.name,
              args,
              sessionId: sdkVoiceSessionId.value,
              executor: _callContext.executor || undefined,
              mode: _callContext.mode || undefined,
              model: _callContext.model || undefined,
              voiceAgentId: _callContext.voiceAgentId || undefined,
            }),
          });
        } catch (fetchErr) {
          const isTimeout = fetchErr?.name === "AbortError";
          throw new Error(
            isTimeout
              ? `Tool "${t.name}" timed out after 30 s — the server may still be processing`
              : (fetchErr?.message || `Tool "${t.name}" fetch failed`),
          );
        } finally {
          clearTimeout(timeoutId);
        }
        const result = await res.json().catch(() => ({}));
        if (!res.ok || result?.error) {
          const message = String(result?.error || `Tool ${t.name} failed (${res.status})`).trim();
          throw new Error(message || `Tool ${t.name} failed`);
        }
        // SDK expects string results — ensure we always return a string.
        const output = result.result ?? result.output ?? "Done";
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);

        // Track background tasks for progress polling
        const BACKGROUND_TOOLS = new Set([
          "delegate_to_agent", "execute_workflow", "create_task",
        ]);
        if (BACKGROUND_TOOLS.has(t.name)) {
          const taskId = result?.taskId || result?.sessionId
            || args?.sessionId || `bg-${Date.now()}`;
          _trackBackgroundTask(taskId, {
            name: `${t.name}: ${String(args?.prompt || args?.title || args?.workflowId || "").slice(0, 60)}`,
            sessionId: result?.sessionId || args?.sessionId || taskId,
          });
        }

        return outputStr;
      };

      // The @openai/agents SDK calls invokeFunctionTool → tool.invoke(runContext, input, details)
      // where input is the raw JSON string of tool arguments from the model.
      const invokeTool = async (_runContext, inputStr, _details) => {
        let args = {};
        if (typeof inputStr === "string") {
          try { args = JSON.parse(inputStr || "{}"); } catch { args = {}; }
        } else if (inputStr && typeof inputStr === "object") {
          args = inputStr;
        }
        return fetchToolResult(args);
      };

      // execute(parsedInput, runContext) — used if the SDK wraps via tool() helper.
      const executeTool = async (parsedInput) => {
        const args = (parsedInput && typeof parsedInput === "object") ? parsedInput : {};
        return fetchToolResult(args);
      };

      return {
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.parameters || { type: "object", properties: {} },
        // SDK calls: await tool.needsApproval(context, parsedArgs, callId)
        async needsApproval() {
          return false;
        },
        execute: executeTool,
        invoke: invokeTool,
      };
    }),
  });

  // Determine model and voice
  const model = String(tokenData.model || resolvedConfig.model || "gpt-realtime-1.5").trim();
  const voiceId = String(tokenData.voiceId || resolvedConfig.voiceId || "alloy").trim();
  const turnDetection = String(resolvedConfig.turnDetection || "semantic_vad").trim();
  // Use server-provided transcription model from sessionConfig, fall back to default
  const serverSessionConfig = tokenData?.sessionConfig || {};
  const transcriptionModel =
    serverSessionConfig?.input_audio_transcription?.model || "gpt-4o-transcribe";
  const transcriptionEnabled =
    serverSessionConfig?.input_audio_transcription !== undefined;
  const turnDetectionConfig = {
    type: turnDetection,
    ...(turnDetection === "server_vad"
      ? {
          threshold: 0.82,
          prefix_padding_ms: 500,
          silence_duration_ms: 1600,
          create_response: true,
          interrupt_response: false,
          createResponse: true,
          interruptResponse: false,
        }
      : {}),
    ...(turnDetection === "semantic_vad"
      ? {
          eagerness: "low",
          create_response: true,
          interrupt_response: false,
          createResponse: true,
          interruptResponse: false,
        }
      : {}),
  };

  // Create session with config
  const session = new RealtimeSession(agent, {
    model,
    config: {
      outputModalities: ["text", "audio"],
      // Explicitly set toolChoice so the model proactively uses tools when appropriate.
      toolChoice: "auto",
      audio: {
        input: {
          format: "pcm16",
          ...(transcriptionEnabled ? { transcription: { model: transcriptionModel } } : {}),
          turnDetection: turnDetectionConfig,
        },
        output: {
          format: "pcm16",
          voice: voiceId,
          ...(transcriptionEnabled ? { transcription: { model: transcriptionModel } } : {}),
        },
      },
    },
  });

  // ── Wire up SDK events to our signals ──

  session.on("history_updated", (history) => {
    if (sdkVoiceError.value && sdkVoiceState.value !== "error") {
      sdkVoiceError.value = null;
    }
    const items = history || [];
    const lastUserMsg = [...items].reverse().find(
      (item) => item.role === "user" && item.type === "message"
    );
    const lastAssistantMsg = [...items].reverse().find(
      (item) => item.role === "assistant" && item.type === "message"
    );

    if (lastUserMsg) {
      const transcript = lastUserMsg.content?.map((c) => c.transcript || c.text || "").join("") || "";
      if (transcript) {
        _scheduleUserTranscriptFinalize(transcript);
      }
    }

    if (lastAssistantMsg) {
      const response = lastAssistantMsg.content?.map((c) => c.transcript || c.text || "").join("") || "";
      if (response) {
        _sdkTraceMarkLlmFirstToken("llm_first_token", { reason: "history_updated.assistant" });
        _markAssistantToolResponseObserved(response);
        _scheduleAssistantTranscriptFinalize(response);
      }
    }

    emit("history-updated", { history: items });
  });

  session.on("audio_interrupted", () => {
    _sdkTraceInterrupt("interrupt", { reason: "audio_interrupted" });
    sdkVoiceState.value = "listening";
    emit("interrupt", {});
  });

  // The SDK emits raw API events via "transport_event" — use it to detect user speech.
  // "speech_started" is NOT a session-level event in @openai/agents SDK.
  session.on("transport_event", (event) => {
    const eventType = event?.type || "";
    if (eventType === "input_audio_buffer.speech_started") {
      _speechStartedAt = Date.now();
      _sdkTraceBeginTurn("turn_start", { reason: "speech_started" });
      // Clear any lingering response so the center shows user's new transcript
      _clearResponseForNewTurn();
      // Don't interrupt immediately — the barge-in will check speech duration
      // in maybeAutoInterruptSdkResponse when called from the debounced path.
      // Only attempt barge-in after MIN_SPEECH_DURATION_FOR_INTERRUPT_MS.
      setTimeout(() => {
        if (_speechStartedAt > 0 && (Date.now() - _speechStartedAt) >= MIN_SPEECH_DURATION_FOR_INTERRUPT_MS) {
          maybeAutoInterruptSdkResponse("speech-started-confirmed");
        }
      }, MIN_SPEECH_DURATION_FOR_INTERRUPT_MS);
      emit("speech-started", {});
    }
    if (eventType === "input_audio_buffer.speech_stopped") {
      _speechStartedAt = 0;
    }
  });

  // ── Tool call events ──
  // The @openai/agents SDK emits "agent_tool_start" and "agent_tool_end"
  // (NOT "tool_call_start"/"tool_call_done"/"tool_call_error").
  // Signature: (context, agent, tool, { toolCall }) for start,
  //            (context, agent, tool, result, { toolCall }) for end.
  session.on("agent_tool_start", (_ctx, _agent, tool, details) => {
    const toolCall = details?.toolCall || {};
    const callId = toolCall?.callId || toolCall?.call_id || `tc-${Date.now()}`;
    const name = tool?.name || toolCall?.name || "unknown";
    console.info(`[voice-client-sdk] tool call started: ${name} (${callId})`);
    sdkVoiceToolCalls.value = [
      ...sdkVoiceToolCalls.value,
      { callId, name, status: "running" },
    ];
    sdkVoiceState.value = "thinking";
    emit("tool-call-start", { callId, name });
  });

  session.on("agent_tool_end", (_ctx, _agent, tool, result, details) => {
    const toolCall = details?.toolCall || {};
    const callId = toolCall?.callId || toolCall?.call_id;
    const name = tool?.name || "unknown";
    const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
    const resultPreview = resultStr.length > 120
      ? resultStr.slice(0, 120) + "..."
      : resultStr;
    console.info(`[voice-client-sdk] tool call done: ${name} (${callId}) → ${resultPreview}`);
    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "complete" } : tc
    );

    // ── Robust tool result injection ──
    // The SDK should auto-inject the function_call_output, but in case it
    // doesn't (race condition, SDK bug, etc.), we verify via a short delay
    // and manually inject if the model hasn't acknowledged the result.
    _ensureToolResultInjected(session, callId, name, resultStr);

    // Return to listening once all tool calls have resolved.
    const stillRunning = sdkVoiceToolCalls.value.some((tc) => tc.status === "running");
    if (!stillRunning && sdkVoiceState.value === "thinking") {
      sdkVoiceState.value = "listening";
    }
    if (!stillRunning) {
      _markToolCompletionPending();
    }
    emit("tool-call-complete", { callId, name, result });
  });

  session.on("error", (err) => {
    const message = getSdkErrorMessage(err);
    if (isNonFatalSdkSessionError(err)) {
      console.warn("[voice-client-sdk] transient session warning:", message);
      return;
    }
    // If we have running tool calls and get an error, mark them as failed.
    // The SDK throws errors from tool invocation into the session error stream.
    const runningTools = sdkVoiceToolCalls.value.filter((tc) => tc.status === "running");
    if (runningTools.length > 0 && /tool|function/i.test(message)) {
      sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
        tc.status === "running" ? { ...tc, status: "error", error: message } : tc
      );
      const stillRunning = sdkVoiceToolCalls.value.some((tc) => tc.status === "running");
      if (!stillRunning && sdkVoiceState.value === "thinking") {
        sdkVoiceState.value = "listening";
      }
      for (const tc of runningTools) {
        emit("tool-call-error", { callId: tc.callId, name: tc.name, error: message });
      }
      // Don't propagate tool errors as fatal session errors
      return;
    }
    const currentState = String(sdkVoiceState.value || "").toLowerCase();
    const sessionStillActive = ["connected", "listening", "thinking", "speaking"].includes(currentState);
    if (sessionStillActive && isGenericSdkErrorMessage(message)) {
      console.warn("[voice-client-sdk] ignoring generic session warning while active:", message);
      return;
    }
    console.error("[voice-client-sdk] session error:", err);
    sdkVoiceError.value = message;
    emit("error", { message });
  });

  session.on("guardrail_tripped", (event) => {
    emit("guardrail-tripped", event);
  });

  // Connect with the token
  const connectOpts = { apiKey: tokenData.token };

  const explicitRealtimeUrl = String(tokenData.url || "").trim();
  if (explicitRealtimeUrl) {
    // Always prefer server-resolved realtime URL so endpoint/model/api-version stay
    // aligned with the selected voice endpoint and provider protocol.
    connectOpts.url = explicitRealtimeUrl;
  } else if (tokenData.provider === "azure" && tokenData.azureEndpoint) {
    const endpoint = String(tokenData.azureEndpoint).replace(/\/+$/, "");
    const deployment = String(tokenData.azureDeployment || tokenData.model || "gpt-realtime-1.5").trim();
    connectOpts.url = isAzureGaRealtimeDeployment(deployment)
      ? `${endpoint}/openai/v1/realtime?model=${encodeURIComponent(deployment)}`
      : `${endpoint}/openai/realtime?api-version=2025-04-01-preview&deployment=${encodeURIComponent(deployment)}`;
  } else if (tokenData.provider === "openai") {
    const model = String(tokenData.model || resolvedConfig.model || "gpt-realtime-1.5").trim();
    connectOpts.url = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  }

  try {
    const safeUrl = String(connectOpts.url || "").trim();
    const parsed = safeUrl ? new URL(safeUrl) : null;
    const safeOrigin = parsed ? parsed.origin : "default";
    const safePath = parsed ? parsed.pathname : "";
    console.info(
      `[voice-client-sdk] connecting realtime session via ${safeOrigin}${safePath} (provider=${tokenData.provider || "unknown"})`,
    );
  } catch {
    // ignore URL logging issues
  }

  // Attempt WebRTC connection first. For Azure 404 failures, signal legacy
  // fallback so voice-client.js can use native browser WebSocket transport.
  // Wrap getUserMedia during connect so we can always stop SDK-owned mic tracks
  // on teardown, even if the SDK keeps hidden stream references.
  await _withGetUserMediaCapture(async () => {
    const connectUrl = String(connectOpts.url || "").trim();
    if (/^wss:/i.test(connectUrl)) {
      const fallbackErr = new Error("Azure SDK connect requires WebRTC URL; fallback to legacy websocket transport");
      fallbackErr.code = "AZURE_SDK_WSS_URL_UNSUPPORTED";
      fallbackErr.fallbackToLegacy = true;
      throw fallbackErr;
    }

    try {
      await session.connect(connectOpts);
    } catch (connectErr) {
      const errMsg = String(connectErr?.message || "");
      const isWebRtc404 = /404|not found|SDP/i.test(errMsg);
      if (tokenData.provider === "azure" && isWebRtc404) {
        const fallbackErr = new Error("Azure WebRTC unavailable (404); fallback to legacy websocket transport");
        fallbackErr.code = "AZURE_WEBRTC_404_FALLBACK";
        fallbackErr.fallbackToLegacy = true;
        fallbackErr.cause = connectErr;
        throw fallbackErr;
      } else {
        throw connectErr;
      }
    }
  });

  // Guard: stopSdkVoiceSession() may have been called while session.connect()
  // was awaiting.  Release any mic streams captured during connect so that the
  // browser indicator goes away, then abort this session setup.
  if (_sdkExplicitStop) {
    _stopCapturedSdkMicStreams();
    stopTrackedMicStreams();
    try { session.close?.(); } catch { /* ignore */ }
    throw new Error("SDK session was stopped during connection");
  }

  if (_agentsRealtimeModuleSource) {
    console.info(`[voice-client-sdk] using OpenAI Realtime SDK from ${_agentsRealtimeModuleSource}`);
  }

  _session = session;
  sdkVoiceSdkActive.value = true;
  sdkVoiceState.value = "listening";
  sdkVoiceProvider.value = tokenData.provider || "openai";
  _sessionStartTime = Date.now();
  sdkVoiceSessionId.value = _callContext.sessionId || `voice-sdk-${Date.now()}`;
  startDurationTimer();

  // Start browser SpeechRecognition as parallel/backup transcription source
  _apiTranscriptDelivered = false;
  _startBrowserTranscription();

  emit("connected", {
    provider: tokenData.provider,
    sessionId: sdkVoiceSessionId.value,
    sdk: "openai-agents",
    callContext: { ..._callContext },
  });

  return session;
}

// ── Gemini Live Session (WebSocket via server proxy) ────────────────────────

/**
 * Start a Gemini Live voice session.
 * Since Gemini Live uses WebSocket and we can't directly use the @google/genai
 * SDK in the browser without exposing the API key, we use a server-proxied
 * approach: the server manages the Gemini Live WebSocket, and the client
 * sends/receives audio via a bosun WebSocket relay.
 */
async function startGeminiLiveSession(config, options = {}) {
  const resolvedConfig = config && typeof config === "object" ? config : {};
  // For Gemini, fall back to server-mediated approach
  // The client sends mic audio via WebSocket to our server,
  // which forwards to Gemini Live API and returns audio.
  const wsProtocol = globalThis.location?.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${globalThis.location?.host}/api/voice/gemini-live`;

  const ws = new WebSocket(wsUrl);
  let audioElement = null;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Gemini Live connection timeout"));
    }, 15000);

    ws.onopen = () => {
      clearTimeout(timeout);

      // Send session config
      ws.send(JSON.stringify({
        type: "session.config",
        sessionId: _callContext.sessionId,
        executor: _callContext.executor,
        mode: _callContext.mode,
        model: resolvedConfig.model,
        voiceAgentId: _callContext.voiceAgentId || undefined,
      }));

      _session = ws;
      sdkVoiceSdkActive.value = true;
      sdkVoiceState.value = "connected";
      sdkVoiceProvider.value = "gemini";
      _sessionStartTime = Date.now();
      sdkVoiceSessionId.value = _callContext.sessionId || `voice-gemini-${Date.now()}`;
      startDurationTimer();

      // Start browser SpeechRecognition as parallel/backup transcription
      _apiTranscriptDelivered = false;
      _startBrowserTranscription();

      // Start mic capture and stream to server
      startGeminiMicCapture(ws).catch((err) => {
        console.error("[voice-client-sdk] Gemini mic capture failed:", err);
        sdkVoiceError.value = err.message;
        sdkVoiceState.value = "error";
      });

      emit("connected", {
        provider: "gemini",
        sessionId: sdkVoiceSessionId.value,
        sdk: "google-genai-live",
        callContext: { ..._callContext },
      });

      resolve(ws);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleGeminiServerEvent(msg);
      } catch {
        // Binary audio data — play it
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
          playGeminiAudio(event.data);
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      reject(new Error("Gemini Live WebSocket error"));
    };

    ws.onclose = () => {
      if (sdkVoiceState.value !== "idle") {
        sdkVoiceState.value = "idle";
        emit("disconnected", { reason: "Gemini Live connection closed" });
      }
    };
  });
}

async function startGeminiMicCapture(ws) {
  const mediaDevices = navigator?.mediaDevices;
  if (!mediaDevices?.getUserMedia) {
    throw new Error("Microphone API unavailable");
  }

  _geminiMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 16000,
      channelCount: 1,
    },
  });
  registerMicStream(_geminiMicStream);

  // Guard: stopSdkVoiceSession() may have raced with this getUserMedia await.
  // Release the mic immediately instead of leaving the indicator active.
  if (_sdkExplicitStop) {
    for (const track of _geminiMicStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _geminiMicStream = null;
    throw new Error("SDK session was stopped during microphone acquisition");
  }

  // Use MediaRecorder to stream chunks to server
  const recorder = new MediaRecorder(_geminiMicStream, {
    mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm",
  });
  _geminiRecorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data);
    }
  };

  recorder.start(250); // Send chunks every 250ms
  sdkVoiceState.value = "listening";
}

function forEachAudioTrackInSource(source, cb) {
  if (!source || typeof cb !== "function") return;
  const seenObjects = new Set();
  const seenTracks = new Set();
  const queue = [{ node: source, depth: 0 }];
  let visited = 0;

  while (queue.length) {
    const { node, depth } = queue.shift();
    if (!node || (typeof node !== "object" && typeof node !== "function")) continue;
    if (seenObjects.has(node)) continue;
    seenObjects.add(node);
    visited += 1;
    if (visited > 220 || depth > 4) continue;

    if (typeof node?.getTracks === "function") {
      try {
        for (const track of node.getTracks()) {
          if (!track || String(track?.kind || "").toLowerCase() !== "audio") continue;
          if (seenTracks.has(track)) continue;
          seenTracks.add(track);
          cb(track);
        }
      } catch {
        // ignore stream enumeration failures
      }
    }

    if (typeof node?.getSenders === "function") {
      try {
        for (const sender of node.getSenders()) {
          const track = sender?.track;
          if (!track || String(track?.kind || "").toLowerCase() !== "audio") continue;
          if (seenTracks.has(track)) continue;
          seenTracks.add(track);
          cb(track);
        }
      } catch {
        // ignore pc sender failures
      }
    }

    let values = null;
    try {
      values = Object.values(node);
    } catch {
      values = null;
    }
    if (!values) continue;
    for (const next of values) {
      if (!next || (typeof next !== "object" && typeof next !== "function")) continue;
      queue.push({ node: next, depth: depth + 1 });
    }
  }
}

function stopMicLikeTracks(source) {
  forEachAudioTrackInSource(source, (track) => {
    try { track.stop(); } catch { /* ignore */ }
  });
}

function _captureSdkMicStream(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  const hasAudio = (stream.getAudioTracks?.() || []).length > 0;
  if (!hasAudio) return;
  _sdkCapturedMicStreams.add(stream);
}

function _stopCapturedSdkMicStreams() {
  for (const stream of _sdkCapturedMicStreams) {
    try {
      for (const track of stream.getTracks()) {
        if (String(track?.kind || "").toLowerCase() !== "audio") continue;
        try { track.stop(); } catch { /* ignore */ }
      }
    } catch {
      // best effort
    }
  }
  _sdkCapturedMicStreams.clear();
}

async function _withGetUserMediaCapture(fn) {
  const mediaDevices = globalThis?.navigator?.mediaDevices;
  const original = mediaDevices?.getUserMedia;
  if (!mediaDevices || typeof original !== "function") {
    return await fn();
  }
  mediaDevices.getUserMedia = async (...args) => {
    const stream = await original.apply(mediaDevices, args);
    _captureSdkMicStream(stream);
    return stream;
  };
  try {
    return await fn();
  } finally {
    mediaDevices.getUserMedia = original;
  }
}

function setMicLikeTracksEnabled(source, enabled) {
  let updated = false;
  forEachAudioTrackInSource(source, (track) => {
    try {
      track.enabled = Boolean(enabled);
      updated = true;
    } catch {
      // ignore per-track failures
    }
  });
  return updated;
}

function handleGeminiServerEvent(msg) {
  const type = msg.type;

  switch (type) {
    case "transcript.user":
      sdkVoiceTranscript.value = msg.text || "";
      emit("transcript", { text: msg.text, final: true, source: "api" });
      _persistTranscriptIfNew("user", msg.text, "gemini.user_transcript");
      break;

    case "transcript.assistant":
      _sdkTraceMarkLlmFirstToken("llm_first_token", { reason: "gemini.transcript.assistant" });
      sdkVoiceResponse.value = msg.text || "";
      emit("response-complete", { text: msg.text });
      _persistTranscriptIfNew("assistant", msg.text, "gemini.assistant_transcript");
      _markAssistantToolResponseObserved(msg.text || "");
      _sdkTraceEndTurn("turn_end", { reason: "gemini.transcript.assistant" });
      break;

    case "audio.delta":
      // Binary audio handled in ws.onmessage
      break;

    case "tool_call":
      handleGeminiToolCall(msg).catch((err) => {
        console.error("[voice-client-sdk] Gemini tool call failed:", err);
      });
      break;

    case "speech_started":
      _sdkTraceBeginTurn("turn_start", { reason: "gemini.speech_started", transport: "websocket" });
      maybeAutoInterruptSdkResponse("speech-started");
      sdkVoiceState.value = "listening";
      emit("speech-started", {});
      break;

    case "speech_stopped":
      sdkVoiceState.value = "thinking";
      emit("speech-stopped", {});
      break;

    case "error":
      sdkVoiceError.value = msg.message || "Gemini error";
      emit("error", { message: msg.message });
      break;

    default:
      break;
  }
}

async function handleGeminiToolCall(msg) {
  const callId = msg.callId || `gemini-tc-${Date.now()}`;
  const name = msg.name || "unknown";
  const args = msg.args || {};

  sdkVoiceToolCalls.value = [...sdkVoiceToolCalls.value, { callId, name, args, status: "running" }];
  sdkVoiceState.value = "thinking";
  emit("tool-call-start", { callId, name, args });

  try {
    const res = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: name,
        args,
        sessionId: sdkVoiceSessionId.value,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
        voiceAgentId: _callContext.voiceAgentId || undefined,
      }),
    });
    const result = await res.json();

    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "complete", result: result.result } : tc
    );
    const stillRunning = sdkVoiceToolCalls.value.some((tc) => tc.status === "running");
    if (!stillRunning) {
      _markToolCompletionPending();
    }

    // Send tool result back to Gemini via WebSocket
    if (_session && _session.readyState === WebSocket.OPEN) {
      _session.send(JSON.stringify({
        type: "tool_result",
        callId,
        name,
        result: result.result || result.error || "No output",
      }));
    }

    emit("tool-call-complete", { callId, name, result: result.result });
  } catch (err) {
    sdkVoiceToolCalls.value = sdkVoiceToolCalls.value.map((tc) =>
      tc.callId === callId ? { ...tc, status: "error", error: err.message } : tc
    );
    emit("tool-call-error", { callId, name, error: err.message });
  }
}

function playGeminiAudio(data) {
  // Use Web Audio API to play PCM audio from Gemini
  try {
    _sdkTraceMarkTtsFirstAudio("tts_first_audio", { reason: "gemini.audio.delta", transport: "websocket" });
    if (typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined") {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!playGeminiAudio._ctx) {
        playGeminiAudio._ctx = new AudioCtx({ sampleRate: 24000 });
      }
      const ctx = playGeminiAudio._ctx;

      if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => {
          ctx.decodeAudioData(buf, (audioBuffer) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.start();
          }).catch(() => { /* ignore decode errors */ });
        });
      }
    }
  } catch {
    // Audio playback not available
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a voice session using the best available SDK.
 * Falls back to legacy voice-client.js if SDK initialization fails.
 *
 * @param {object} options — { sessionId, executor, mode, model }
 * @returns {Promise<{ sdk: boolean, provider: string }>}
 */
export async function startSdkVoiceSession(options = {}) {
  ensureMicTrackingPatched();
  _sdkExplicitStop = false; // reset before each new session attempt
  if (_session) {
    console.warn("[voice-client-sdk] Session already active");
    return { sdk: sdkVoiceSdkActive.value, provider: sdkVoiceProvider.value };
  }

  isVoiceMicMuted.value = false;
  _callContext = _normalizeCallContext(options);
  sdkVoiceBoundSessionId.value = _callContext.sessionId;
  sdkVoiceState.value = "connecting";
  sdkVoiceError.value = null;
  sdkVoiceTranscript.value = "";
  sdkVoiceResponse.value = "";
  sdkVoiceToolCalls.value = [];
  _usingLegacyFallback = false;
  _lastAutoBargeInAt = 0;
  _speechStartedAt = 0;
  if (_responseClearTimer) { clearTimeout(_responseClearTimer); _responseClearTimer = null; }
  _resetTranscriptPersistenceState();

  try {
    // 1. Fetch SDK config from server
    _sdkConfig = await fetchSdkConfig();

    // 2. Try SDK-based session based on provider
    if (_sdkConfig.useSdk) {
      const provider = _sdkConfig.provider || "openai";

      if (provider === "openai" || provider === "azure") {
        await startAgentsSdkSession(_sdkConfig, options);
        return { sdk: true, provider };
      }

      if (provider === "gemini") {
        await startGeminiLiveSession(_sdkConfig, options);
        return { sdk: true, provider: "gemini" };
      }
    }

    // 3. SDK not available — signal fallback
    _usingLegacyFallback = true;
    sdkVoiceSdkActive.value = false;
    emit("sdk-unavailable", {
      reason: _sdkConfig.fallbackReason || "SDK not available for provider",
      provider: _sdkConfig.provider,
    });

    return { sdk: false, provider: _sdkConfig.provider, reason: _sdkConfig.fallbackReason };
  } catch (err) {
    const reason = String(err?.message || "");
    const expectedModuleMissing =
      /SDK module unavailable in browser/i.test(reason) ||
      /Failed to resolve module specifier '@openai\/agents\/realtime'/i.test(reason) ||
      /Cannot find module '@openai\/agents\/realtime'/i.test(reason);
    const expectedAzureFallback =
      err?.code === "AZURE_WEBRTC_404_FALLBACK"
      || err?.code === "AZURE_SDK_WSS_URL_UNSUPPORTED";
    if (expectedModuleMissing) {
      if (!_sdkModuleUnavailableLogged) {
        console.warn(
          "[voice-client-sdk] Realtime SDK bundle unavailable; using legacy voice transport.",
        );
        _sdkModuleUnavailableLogged = true;
      }
    } else if (expectedAzureFallback) {
      console.warn("[voice-client-sdk] Azure SDK WebRTC unavailable; using legacy voice websocket transport.");
    } else {
      console.error("[voice-client-sdk] SDK session failed, signaling fallback:", err);
    }
    _usingLegacyFallback = true;
    sdkVoiceSdkActive.value = false;
    sdkVoiceState.value = "idle";
    sdkVoiceError.value = null; // Don't show error — we'll fallback
    _stopCapturedSdkMicStreams();
    emit("sdk-unavailable", {
      reason: reason || "SDK unavailable",
      provider: _sdkConfig?.provider || "unknown",
    });

    return {
      sdk: false,
      provider: _sdkConfig?.provider || "unknown",
      reason: reason || "SDK unavailable",
    };
  }
}

/**
 * Stop the current SDK voice session.
 */
export function stopSdkVoiceSession() {
  // Set before any cleanup so in-flight getUserMedia / session.connect awaiters
  // detect the cancellation and release acquired mic tracks immediately.
  _sdkExplicitStop = true;
  emit("session-ending", { sessionId: sdkVoiceSessionId.value });
  _flushPendingTranscriptBuffers();
  _stopBrowserTranscription();
  _stopBackgroundProgressPolling();
  if (_geminiRecorder) {
    try { _geminiRecorder.stop(); } catch { /* ignore */ }
    _geminiRecorder = null;
  }

  if (_session) {
    stopMicLikeTracks(_session);
    try {
      if (typeof _session.close === "function") {
        _session.close();
      } else if (typeof _session.disconnect === "function") {
        _session.disconnect();
      }
    } catch {
      // best effort
    }
    _session = null;
  }
  _stopCapturedSdkMicStreams();

  // Stop Gemini mic stream if active
  if (_geminiMicStream) {
    for (const track of _geminiMicStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    _geminiMicStream = null;
  }
  // Force-stop any tracked audio input streams to avoid stale browser mic
  // capture indicators after call close (covers async/race teardown paths).
  stopTrackedMicStreams();

  clearInterval(_durationTimer);
  _durationTimer = null;
  if (_responseClearTimer) { clearTimeout(_responseClearTimer); _responseClearTimer = null; }
  _speechStartedAt = 0;

  sdkVoiceState.value = "idle";
  sdkVoiceTranscript.value = "";
  sdkVoiceResponse.value = "";
  sdkVoiceToolCalls.value = [];
  sdkVoiceSessionId.value = null;
  sdkVoiceBoundSessionId.value = null;
  sdkVoiceDuration.value = 0;
  sdkVoiceProvider.value = null;
  sdkVoiceSdkActive.value = false;
  isVoiceMicMuted.value = false;
  _callContext = {
    sessionId: null,
    executor: null,
    mode: null,
    model: null,
    voiceAgentId: null,
  };
  _usingLegacyFallback = false;
  if (_traceTurnActive) {
    _sdkTraceEndTurn("turn_end", { reason: "session_ended" });
  }
  _resetTranscriptPersistenceState();

  emit("session-ended", {});
}

/**
 * Interrupt the current response (barge-in).
 */
export function interruptSdkResponse() {
  if (_session) {
    // Always attempt to interrupt — don't gate on _traceTurnActive because
    // the agent may be speaking audio even when turn tracking wasn't started.
    if (typeof _session.interrupt === "function") {
      // @openai/agents SDK
      try { _session.interrupt(); } catch { /* best effort */ }
    } else if (typeof _session.cancelResponse === "function") {
      try { _session.cancelResponse(); } catch { /* best effort */ }
    } else if (_session.readyState === WebSocket.OPEN) {
      // Gemini WebSocket
      _session.send(JSON.stringify({ type: "response.cancel" }));
    }
    _sdkTraceInterrupt("interrupt", { reason: "interruptSdkResponse" });
    sdkVoiceState.value = "listening";
    emit("interrupt", {});
  }
}

/**
 * Toggle microphone mute state for SDK-driven voice sessions.
 * Returns the new muted state.
 */
export function toggleSdkMicMute() {
  const willBeMuted = !isVoiceMicMuted.value;
  const enabled = !willBeMuted;

  if (_session) {
    // Try SDK-native controls first when available.
    try {
      if (enabled && typeof _session.unmute === "function") {
        _session.unmute();
      } else if (!enabled && typeof _session.mute === "function") {
        _session.mute();
      }
    } catch {
      // fall through to track-level toggles
    }
    setMicLikeTracksEnabled(_session, enabled);
  }

  if (_geminiMicStream) {
    for (const track of _geminiMicStream.getTracks()) {
      if (String(track?.kind || "").toLowerCase() !== "audio") continue;
      try { track.enabled = enabled; } catch { /* ignore */ }
    }
  }

  isVoiceMicMuted.value = willBeMuted;
  return isVoiceMicMuted.value;
}

/**
 * Send a text message to the voice agent.
 * @param {string} text
 * @param {{ persistText?: string, eventType?: string }} [options]
 */
export function sendSdkTextMessage(text, options = {}) {
  const inputText = String(text || "").trim();
  if (!inputText) return;
  if (!_session) {
    console.warn("[voice-client-sdk] Cannot send text — no active session");
    return;
  }

  const persistText = String(options?.persistText ?? inputText).trim();
  if (persistText) {
    _persistTranscriptIfNew(
      "user",
      persistText,
      String(options?.eventType || "sdk.send_text_message"),
    );
  }

  if (typeof _session.sendMessage === "function") {
    // @openai/agents SDK
    _session.sendMessage(inputText);
  } else if (_session.readyState === WebSocket.OPEN) {
    // Gemini WebSocket
    _session.send(JSON.stringify({
      type: "text.input",
      text: inputText,
    }));
  }
}

/**
 * Stream an image frame into the active Realtime session without forcing
 * an immediate spoken response. Returns true when sent via realtime transport.
 */
export function sendSdkImageFrame(imageDataUrl, options = {}) {
  const image = String(imageDataUrl || "").trim();
  if (!image || !_session) return false;
  const source = String(options?.source || "screen").trim() || "screen";
  const width = Number(options?.width) || undefined;
  const height = Number(options?.height) || undefined;

  try {
    if (typeof _session.addImage === "function") {
      _session.addImage(image, { triggerResponse: false });
      return true;
    }
    // Prefer low-level event fallback over custom sendMessage payload shapes
    // to avoid SDK version mismatches (observed in some browser builds).
    if (typeof _session.sendEvent === "function") {
      _session.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: image,
              detail: "low",
            },
          ],
        },
      });
      return true;
    }
  } catch (err) {
    console.warn("[voice-client-sdk] failed to send realtime image frame:", err?.message || err);
  }
  return false;
}

/**
 * Check if falling back to legacy voice.
 */
export function isUsingLegacyFallback() {
  return _usingLegacyFallback;
}

/**
 * Get current SDK session info.
 */
export function getSdkSessionInfo() {
  return {
    active: sdkVoiceSdkActive.value,
    provider: sdkVoiceProvider.value,
    sessionId: sdkVoiceSessionId.value,
    state: sdkVoiceState.value,
    duration: sdkVoiceDuration.value,
    usingLegacy: _usingLegacyFallback,
    sdkConfig: _sdkConfig,
  };
}

/**
 * Send a Bosun slash command or plain text to the active voice session.
 *
 * Slash command routing:
 *   /instant <prompt>    → prompts the agent for a fast inline answer
 *   /ask <prompt>        → prompts the agent in read-only ask mode
 *   /background <prompt> → requests a background agent delegation
 *   /bg <prompt>         → alias for /background
 *   /mcp <tool> [server] → invokes an MCP tool via the agent
 *   /workspace <cmd>     → runs a workspace shell command
 *   <plain text>         → sent directly to the Realtime session
 *
 * @param {string} commandOrText  Slash command or plain message text.
 */
export function sendVoiceCommand(commandOrText) {
  const text = String(commandOrText || "").trim();
  if (!text) return;

  if (!text.startsWith("/")) {
    sendSdkTextMessage(text, {
      persistText: text,
      eventType: "sdk.voice_command.text",
    });
    return;
  }

  // For slash commands, send a structured natural-language instruction that
  // will cause the Realtime agent to call bosun_slash_command tool.
  // Wrapping in a clear directive avoids the agent interpreting the slash as
  // part of the conversation rather than a tool invocation trigger.
  const instruction =
    `[SYSTEM COMMAND] Call the bosun_slash_command tool with command: ${text}`;
  sendSdkTextMessage(instruction, {
    persistText: text,
    eventType: "sdk.voice_command.slash",
  });
}

// ── Duration Timer ──────────────────────────────────────────────────────────

function startDurationTimer() {
  clearInterval(_durationTimer);
  _durationTimer = setInterval(() => {
    sdkVoiceDuration.value = Math.floor((Date.now() - _sessionStartTime) / 1000);
  }, 1000);
}
