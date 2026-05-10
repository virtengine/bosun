/**
 * voice-barge-in.js
 *
 * Shared policy helpers for automatic barge-in (interrupt assistant playback
 * when the user starts speaking).
 */

export function shouldAutoBargeIn({
  muted = false,
  audioActive = false,
  now = Date.now(),
  lastTriggeredAt = 0,
  minIntervalMs = 700,
} = {}) {
  if (muted) return false;
  if (!audioActive) return false;
  const elapsed = Number(now) - Number(lastTriggeredAt || 0);
  return elapsed >= Number(minIntervalMs || 0);
}

export function shouldAutoBargeInFromMicLevel({
  speaking = false,
  level = 0,
  threshold = 0.08,
} = {}) {
  return Boolean(speaking) && Number(level) >= Number(threshold);
}
