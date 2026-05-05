/**
 * audio-visualizer.js — Voice orb visualization component.
 *
 * Renders a pulsing orb that responds to voice state.
 * States: idle (gentle pulse), listening (active ripple),
 *         thinking (rotating), speaking (waveform),
 *         connecting (breathing)
 *
 * @module audio-visualizer
 */

import { h } from "preact";
import { useEffect } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ── Inject orb styles ──────────────────────────────────────────────────────

let _orbStylesInjected = false;

function injectOrbStyles() {
  if (_orbStylesInjected || typeof document === "undefined") return;
  _orbStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.voice-orb {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.voice-orb-inner {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #818cf8, #6366f1, #4f46e5, #4338ca);
  box-shadow: 0 0 60px rgba(99, 102, 241, 0.4), inset 0 0 30px rgba(255,255,255,0.1);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}
.voice-orb-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(99, 102, 241, 0.3);
  animation: orbRingPulse 2s ease-in-out infinite;
}
.voice-orb-ring:nth-child(2) {
  inset: -10px;
  animation-delay: 0.3s;
  border-color: rgba(99, 102, 241, 0.2);
}
.voice-orb-ring:nth-child(3) {
  inset: -20px;
  animation-delay: 0.6s;
  border-color: rgba(99, 102, 241, 0.1);
}
@keyframes orbRingPulse {
  0%, 100% { transform: scale(1); opacity: 0.5; }
  50% { transform: scale(1.05); opacity: 1; }
}

/* State: idle — gentle pulse */
.voice-orb[data-state="idle"] .voice-orb-inner,
.voice-orb[data-state="connected"] .voice-orb-inner {
  animation: orbIdlePulse 3s ease-in-out infinite;
}
@keyframes orbIdlePulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.03); }
}

/* State: listening — active ripple */
.voice-orb[data-state="listening"] .voice-orb-inner {
  background: radial-gradient(circle at 35% 35%, #34d399, #10b981, #059669);
  box-shadow: 0 0 80px rgba(16, 185, 129, 0.5), inset 0 0 30px rgba(255,255,255,0.15);
  animation: orbListenPulse 1s ease-in-out infinite;
}
.voice-orb[data-state="listening"] .voice-orb-ring {
  border-color: rgba(16, 185, 129, 0.4);
  animation: orbRingExpand 1s ease-out infinite;
}
@keyframes orbListenPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}
@keyframes orbRingExpand {
  from { transform: scale(1); opacity: 0.8; }
  to { transform: scale(1.3); opacity: 0; }
}

/* State: thinking — rotating glow */
.voice-orb[data-state="thinking"] .voice-orb-inner {
  background: radial-gradient(circle at 35% 35%, #fbbf24, #f59e0b, #d97706);
  box-shadow: 0 0 60px rgba(245, 158, 11, 0.4), inset 0 0 30px rgba(255,255,255,0.1);
  animation: orbThinkRotate 2s linear infinite;
}
@keyframes orbThinkRotate {
  from { box-shadow: 0 0 60px rgba(245, 158, 11, 0.4), inset 0 0 30px rgba(255,255,255,0.1); }
  50% { box-shadow: 20px 0 60px rgba(245, 158, 11, 0.6), inset 0 0 30px rgba(255,255,255,0.2); }
  to { box-shadow: 0 0 60px rgba(245, 158, 11, 0.4), inset 0 0 30px rgba(255,255,255,0.1); }
}

/* State: speaking — waveform pulse */
.voice-orb[data-state="speaking"] .voice-orb-inner {
  background: radial-gradient(circle at 35% 35%, #818cf8, #6366f1, #4f46e5);
  animation: orbSpeakPulse 0.8s ease-in-out infinite;
}
@keyframes orbSpeakPulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 60px rgba(99, 102, 241, 0.4); }
  25% { transform: scale(1.12); box-shadow: 0 0 80px rgba(99, 102, 241, 0.6); }
  50% { transform: scale(0.95); box-shadow: 0 0 40px rgba(99, 102, 241, 0.3); }
  75% { transform: scale(1.08); box-shadow: 0 0 70px rgba(99, 102, 241, 0.5); }
}

/* State: connecting — breathing */
.voice-orb[data-state="connecting"] .voice-orb-inner,
.voice-orb[data-state="reconnecting"] .voice-orb-inner {
  background: radial-gradient(circle at 35% 35%, #94a3b8, #64748b, #475569);
  animation: orbBreathing 2s ease-in-out infinite;
}
@keyframes orbBreathing {
  0%, 100% { transform: scale(0.9); opacity: 0.7; }
  50% { transform: scale(1.1); opacity: 1; }
}

/* State: error — red static */
.voice-orb[data-state="error"] .voice-orb-inner {
  background: radial-gradient(circle at 35% 35%, #f87171, #ef4444, #dc2626);
  box-shadow: 0 0 60px rgba(239, 68, 68, 0.4);
  animation: none;
}
  `;
  document.head.appendChild(style);
}

// ── AudioVisualizer Component ───────────────────────────────────────────────

/**
 * @param {{ state: string }} props
 */
export function AudioVisualizer({ state = "idle" }) {
  useEffect(() => { injectOrbStyles(); }, []);

  return html`
    <div class="voice-orb" data-state=${state}>
      <div class="voice-orb-ring" />
      <div class="voice-orb-ring" />
      <div class="voice-orb-ring" />
      <div class="voice-orb-inner" />
    </div>
  `;
}
