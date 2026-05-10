/**
 * voice-fallback.js — Tier 2 voice using browser Web Speech API + bosun chat.
 *
 * Flow: SpeechRecognition → text → POST /api/voice/tool(delegate_to_agent) → SpeechSynthesis
 *
 * @module voice-fallback
 */

import { signal } from "@preact/signals";

export const fallbackState = signal("idle"); // idle | listening | processing | speaking | error
export const fallbackTranscript = signal("");
export const fallbackResponse = signal("");
export const fallbackError = signal(null);

let _recognition = null;
let _synthesis = null;
let _sessionId = null;
let _isSpeaking = false;
let _restartListeningTimer = null;
let _callContext = {
  executor: null,
  mode: null,
  model: null,
};

const SpeechRecognition = typeof globalThis !== "undefined"
  ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)
  : null;

export const fallbackSupported = Boolean(SpeechRecognition) && typeof globalThis.speechSynthesis !== "undefined";

async function recordFallbackTranscript(role, content, eventType = "") {
  const sessionId = String(_sessionId || "").trim();
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
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
        provider: "fallback",
      }),
    });
  } catch {
    // best effort persistence
  }
}

/**
 * Start a fallback voice session.
 * @param {string} sessionId — existing chat session ID to use
 * @param {{ executor?: string, mode?: string, model?: string }} [options]
 */
export function startFallbackSession(sessionId, options = {}) {
  if (!fallbackSupported) {
    fallbackError.value = "Speech APIs not supported in this browser";
    fallbackState.value = "error";
    return;
  }

  _sessionId = sessionId || null;
  _callContext = {
    executor: String(options?.executor || "").trim() || null,
    mode: String(options?.mode || "").trim() || null,
    model: String(options?.model || "").trim() || null,
  };
  _synthesis = globalThis.speechSynthesis;
  fallbackState.value = "idle";
  fallbackError.value = null;
  startListening();
}

/**
 * Stop the fallback session.
 */
export function stopFallbackSession() {
  if (_restartListeningTimer) {
    clearTimeout(_restartListeningTimer);
    _restartListeningTimer = null;
  }
  _sessionId = null;
  stopListening();
  stopSpeaking();
  fallbackState.value = "idle";
  fallbackTranscript.value = "";
  fallbackResponse.value = "";
  _callContext = { executor: null, mode: null, model: null };
}

function startListening() {
  if (!_sessionId) return;
  if (!SpeechRecognition) return;

  if (_restartListeningTimer) {
    clearTimeout(_restartListeningTimer);
    _restartListeningTimer = null;
  }
  stopListening();

  _recognition = new SpeechRecognition();
  _recognition.continuous = false;
  _recognition.interimResults = true;
  _recognition.lang = navigator?.language || "en-US";
  _recognition.maxAlternatives = 1;

  _recognition.onstart = () => {
    fallbackState.value = "listening";
    fallbackTranscript.value = "";
  };

  _recognition.onresult = (event) => {
    let transcript = "";
    let isFinal = false;
    for (const result of event.results) {
      transcript += result[0].transcript;
      if (result.isFinal) isFinal = true;
    }
    fallbackTranscript.value = transcript;
    if (isFinal && transcript.trim()) {
      processUserInput(transcript.trim());
    }
  };

  _recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      // Restart listening silently
      if (!_sessionId) return;
      _restartListeningTimer = setTimeout(() => {
        _restartListeningTimer = null;
        startListening();
      }, 500);
      return;
    }
    if (event.error === "aborted") return;
    fallbackError.value = `Speech error: ${event.error}`;
    fallbackState.value = "error";
  };

  _recognition.onend = () => {
    // Auto-restart if still in active session and not processing
    if (_sessionId && fallbackState.value === "listening") {
      _restartListeningTimer = setTimeout(() => {
        _restartListeningTimer = null;
        startListening();
      }, 300);
    }
  };

  try {
    _recognition.start();
  } catch (err) {
    fallbackError.value = `Could not start recognition: ${err.message}`;
    fallbackState.value = "error";
  }
}

function stopListening() {
  if (_recognition) {
    try { _recognition.abort(); } catch { /* ignore */ }
    _recognition = null;
  }
}

async function processUserInput(text) {
  fallbackState.value = "processing";
  stopListening();
  await recordFallbackTranscript("user", text, "fallback.user_input");

  try {
    // Use the same server-side voice tool pipeline as Tier 1 for consistency.
    const res = await fetch("/api/voice/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "delegate_to_agent",
        args: {
          message: text,
          mode: _callContext.mode || "instant",
          executor: _callContext.executor || undefined,
          model: _callContext.model || undefined,
        },
        sessionId: _sessionId || undefined,
        executor: _callContext.executor || undefined,
        mode: _callContext.mode || undefined,
        model: _callContext.model || undefined,
      }),
    });

    if (!res.ok) {
      throw new Error(`Server responded with ${res.status}`);
    }

    const data = await res.json();
    const responseText =
      data?.result ||
      data?.text ||
      data?.message ||
      data?.content ||
      (data?.error ? `Error: ${data.error}` : JSON.stringify(data));

    fallbackResponse.value = responseText;
    await recordFallbackTranscript("assistant", responseText, "fallback.assistant_output");
    await speak(responseText);
  } catch (err) {
    fallbackError.value = `Processing error: ${err.message}`;
    fallbackState.value = "error";
  }
}

function speak(text) {
  return new Promise((resolve) => {
    if (!_synthesis || !text) {
      resolve();
      startListening();
      return;
    }

    // Cancel any ongoing speech
    _synthesis.cancel();

    // Clean text for TTS (remove markdown, code blocks, etc.)
    const cleanText = text
      .replace(/```[\s\S]*?```/g, " (code block) ")
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .replace(/[#*_~]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();

    if (!cleanText) {
      resolve();
      startListening();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanText.slice(0, 500));
    utterance.rate = 1.1;
    utterance.pitch = 1.0;

    fallbackState.value = "speaking";
    _isSpeaking = true;

    utterance.onend = () => {
      _isSpeaking = false;
      fallbackState.value = "idle";
      resolve();
      // Resume listening after speaking
      if (_sessionId) {
        _restartListeningTimer = setTimeout(() => {
          _restartListeningTimer = null;
          startListening();
        }, 300);
      }
    };
    utterance.onerror = () => {
      _isSpeaking = false;
      resolve();
      if (_sessionId) startListening();
    };

    _synthesis.speak(utterance);
  });
}

function stopSpeaking() {
  if (_synthesis) {
    try { _synthesis.cancel(); } catch { /* ignore */ }
  }
  _isSpeaking = false;
}

/**
 * Interrupt current speech (barge-in for fallback).
 */
export function interruptFallback() {
  stopSpeaking();
  fallbackState.value = "idle";
  startListening();
}
