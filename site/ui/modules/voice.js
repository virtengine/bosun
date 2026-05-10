/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Voice Input (Web Speech API)
 *
 *  Provides:
 *   - useVoiceInput(onTranscript, opts) — Preact hook
 *   - VoiceMicButton({ onTranscript, disabled, title, className }) — component
 *
 *  Gracefully degrades when SpeechRecognition is unavailable.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import htm from "htm";
import { haptic } from "./telegram.js";
import { resolveIcon } from "./icon-utils.js";
import { IconButton } from "@mui/material";

const html = htm.bind(h);

/* ─── detect browser support ─── */

function getSpeechRecognition() {
  if (typeof globalThis === "undefined") return null;
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

export const speechSupported = Boolean(getSpeechRecognition());

/* ─── inject styles once ─── */

let stylesInjected = false;
function injectVoiceStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
/* ── Voice mic button ── */
.mic-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.10);
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  color: var(--tg-theme-hint-color, #888);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
  box-sizing: border-box;
  font-size: 0;
  line-height: 1;
  user-select: none;
}
.mic-btn svg {
  width: 16px;
  height: 16px;
  display: block;
}
.mic-btn:hover:not(:disabled) {
  background: rgba(255,255,255,0.06);
  color: var(--tg-theme-text-color, #fff);
  border-color: rgba(255,255,255,0.18);
}
.mic-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.mic-btn.listening {
  background: rgba(239,68,68,0.18);
  color: #ef4444;
  border-color: rgba(239,68,68,0.5);
  box-shadow: 0 0 0 3px rgba(239,68,68,0.15);
  animation: micPulse 1.2s ease-in-out infinite;
}
@keyframes micPulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(239,68,68,0.15); }
  50%       { box-shadow: 0 0 0 6px rgba(239,68,68,0.06); }
}
.mic-btn-sm {
  width: 24px;
  height: 24px;
}
.mic-btn-sm svg {
  width: 12px;
  height: 12px;
}
.mic-btn-inline {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
}

/* ── Input with mic wrapper ── */
.input-with-mic {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
}
.input-with-mic .input {
  flex: 1;
  padding-right: 38px !important;
}
.input-with-mic .mic-btn-inline {
  right: 6px;
}

/* ── Textarea with mic wrapper ── */
.textarea-with-mic {
  position: relative;
}
.textarea-with-mic .input {
  padding-right: 38px !important;
}
.textarea-with-mic .mic-btn {
  position: absolute;
  right: 6px;
  top: 8px;
  width: 26px;
  height: 26px;
  font-size: 13px;
}

/* ── Listening indicator pill ── */
.mic-listening-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 20px;
  background: rgba(239,68,68,0.12);
  border: 1px solid rgba(239,68,68,0.3);
  color: #ef4444;
  font-size: 11px;
  font-weight: 500;
  animation: micPulse 1.2s ease-in-out infinite;
}
.mic-listening-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ef4444;
  animation: micPulse 1.2s ease-in-out infinite;
}
  `;
  document.head.appendChild(style);
}

/* ─── useVoiceInput hook ────────────────────────────────────────
 *
 * @param {(text: string) => void} onTranscript  — called when speech recognised
 * @param {{ lang?: string, continuous?: boolean, interim?: boolean }} opts
 * @returns {{ listening: boolean, supported: boolean, start: () => void,
 *             stop: () => void, toggle: () => void, error: string|null }}
 */
export function useVoiceInput(onTranscript, opts = {}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recognizerRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const SR = getSpeechRecognition();
  const supported = Boolean(SR);

  const stop = useCallback(() => {
    if (recognizerRef.current) {
      try { recognizerRef.current.stop(); } catch { /* ignore */ }
      recognizerRef.current = null;
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!SR) {
      setError("Speech recognition not supported in this browser.");
      return;
    }
    // Stop any existing session
    stop();
    setError(null);

    const rec = new SR();
    rec.lang = opts.lang || navigator?.language || "en-US";
    rec.continuous = opts.continuous ?? false;
    rec.interimResults = opts.interim ?? false;
    rec.maxAlternatives = 1;

    rec.onstart = () => setListening(true);
    rec.onend = () => {
      recognizerRef.current = null;
      setListening(false);
    };
    rec.onerror = (e) => {
      const msg = e.error === "not-allowed"
        ? "Microphone permission denied."
        : e.error === "no-speech"
        ? null  // silent – user just didn't speak
        : `Voice error: ${e.error}`;
      if (msg) setError(msg);
      recognizerRef.current = null;
      setListening(false);
    };
    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ")
        .trim();
      if (transcript) onTranscriptRef.current(transcript);
    };

    try {
      rec.start();
      recognizerRef.current = rec;
    } catch (err) {
      setError(`Could not start voice input: ${err.message}`);
    }
  }, [SR, stop, opts.lang, opts.continuous, opts.interim]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  // Cleanup on unmount
  useEffect(() => () => stop(), [stop]);

  return { listening, supported, start, stop, toggle, error };
}

export function requestVoiceModeOpen(detail = {}) {
  try {
    globalThis.dispatchEvent?.(new CustomEvent("ve:open-voice-mode", { detail }));
  } catch {
    // no-op
  }
}

/* ─── VoiceMicButton component ─────────────────────────────────
 *
 * In v0.36+, all in-app mic actions open the real voice mode overlay.
 */
export function VoiceMicButton({ onTranscript, disabled = false, title, className = "", size = "md" }) {
  // Legacy callback kept for backward compatibility; real voice mode owns transcript flow.
  void onTranscript;
  useEffect(() => { injectVoiceStyles(); }, []);

  const sizeClass = size === "sm" ? "mic-btn-sm" : "";

  return html`
    <${IconButton}
      size=${size === "sm" ? "small" : "medium"}
      class="mic-btn ${sizeClass} ${className}"
      disabled=${disabled}
      onClick=${() => {
        haptic("light");
        requestVoiceModeOpen();
      }}
      title=${title || "Live voice mode"}
      aria-label="Open live voice mode"
      aria-pressed="false"
    >
      ${resolveIcon(":mic:")}
    <//>
  `;
}

/* ─── VoiceMicButtonInline ──────────────────────────────────────
 *  Positioned absolutely inside a .input-with-mic or .textarea-with-mic wrapper.
 */
export function VoiceMicButtonInline({ onTranscript, disabled = false }) {
  void onTranscript;
  useEffect(() => { injectVoiceStyles(); }, []);

  return html`
    <${IconButton}
      size="small"
      class="mic-btn mic-btn-sm mic-btn-inline"
      disabled=${disabled}
      onClick=${(e) => {
        e.stopPropagation();
        haptic("light");
        requestVoiceModeOpen();
      }}
      title="Live voice mode"
      aria-label="Open live voice mode"
      aria-pressed="false"
    >
      ${resolveIcon(":mic:")}
    <//>
  `;
}
