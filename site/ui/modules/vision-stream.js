/**
 * vision-stream.js — Live camera/screen frame streaming for voice calls.
 *
 * Captures compressed JPEG frames at a fixed interval and sends them to
 * /api/vision/frame with the active chat session context.
 */

import { signal } from "@preact/signals";

export const visionShareState = signal("off"); // off | starting | streaming | error
export const visionShareSource = signal(null); // screen | camera | null
export const visionShareError = signal(null);
export const visionLastSummary = signal("");
export const visionLastAnalyzedAt = signal(0);
export const visionTransportMode = signal("idle"); // idle | realtime | fallback | negotiating

let _stream = null;
let _video = null;
let _canvas = null;
let _captureTimer = null;
let _sendInFlight = false;
let _lastFrameFingerprint = "";
let _lastFrameSentAt = 0;
let _hybridAnalyzeInFlight = false;
let _lastHybridAnalyzeAt = 0;
let _context = {
  sessionId: null,
  executor: null,
  mode: null,
  model: null,
  source: null,
  intervalMs: 1000,
  maxWidth: 1280,
  jpegQuality: 0.65,
  onFrame: null,
  preferRealtimeVision: false,
  hybridSummaryIntervalMs: 4500,
};

function isLocalhostLikeHost() {
  const host = String(globalThis?.location?.hostname || "").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isElectronDesktopRuntime() {
  return Boolean(globalThis?.veDesktop);
}

function isSecureOrLocalhost() {
  // Electron desktop shells commonly run on local HTTP origins but still
  // allow trusted desktop capture; do not gate those by browser HTTPS rules.
  if (isElectronDesktopRuntime()) return true;
  return Boolean(globalThis?.isSecureContext) || isLocalhostLikeHost();
}

function isLikelyEmbeddedWebView() {
  const ua = String(globalThis?.navigator?.userAgent || "").toLowerCase();
  return /telegram|tgweb|wv;|webview|fb_iab|instagram/.test(ua);
}

export function supportsVisionSource(source = "screen") {
  const normalized = normalizeSource(source);
  const mediaDevices = globalThis?.navigator?.mediaDevices;
  if (normalized === "screen") {
    // Electron desktop can provide screen capture even when feature-detect
    // timing or runtime flags hide getDisplayMedia initially.
    if (isElectronDesktopRuntime()) return true;
    if (!mediaDevices) return false;
    if (!isSecureOrLocalhost()) return false;
    if (typeof mediaDevices.getDisplayMedia === "function") return true;
    return false;
  }
  if (!mediaDevices) return false;
  if (!isSecureOrLocalhost()) return false;
  return typeof mediaDevices.getUserMedia === "function";
}

function explainVisionStartError(err, source) {
  const normalized = normalizeSource(source);
  const name = String(err?.name || "").trim();
  const message = String(err?.message || "").trim();
  if (!isSecureOrLocalhost()) {
    return "Screen/camera sharing requires HTTPS (or localhost). Open Bosun via secure origin.";
  }
  if (normalized === "screen" && isLikelyEmbeddedWebView()) {
    return "Screen sharing is not supported in this in-app WebView. Open Bosun in desktop Chrome/Edge.";
  }
  if (normalized === "screen" && typeof globalThis?.navigator?.mediaDevices?.getDisplayMedia !== "function") {
    if (isElectronDesktopRuntime()) {
      return "Screen sharing could not start in Electron. Update desktop app and retry.";
    }
    return "Screen sharing is not supported by this browser/runtime.";
  }
  if (name === "NotAllowedError") {
    return normalized === "screen"
      ? "Screen share permission was denied."
      : "Camera permission was denied.";
  }
  if (name === "NotFoundError") {
    return normalized === "screen"
      ? "No screen/window source was selected."
      : "No camera device was found.";
  }
  if (name === "AbortError") {
    return "Share request was cancelled before starting.";
  }
  if (name === "NotReadableError") {
    return "Could not access the selected capture source (already in use or blocked by OS policy).";
  }
  if (name === "InvalidStateError") {
    return "Capture could not start in the current page state. Try focusing the tab and retrying.";
  }
  if (message) return message;
  return `Could not start ${normalized} sharing`;
}

function normalizeSource(source) {
  const value = String(source || "").trim().toLowerCase();
  if (value === "camera") return "camera";
  return "screen";
}

function normalizeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resetContext() {
  _context = {
    sessionId: null,
    executor: null,
    mode: null,
    model: null,
    source: null,
    intervalMs: 1000,
    maxWidth: 1280,
    jpegQuality: 0.65,
    onFrame: null,
    preferRealtimeVision: false,
    hybridSummaryIntervalMs: 4500,
  };
  _lastFrameFingerprint = "";
  _lastFrameSentAt = 0;
  _hybridAnalyzeInFlight = false;
  _lastHybridAnalyzeAt = 0;
}

function fingerprintFrame(dataUrl) {
  const raw = String(dataUrl || "");
  if (!raw) return "";
  // Cheap stable fingerprint to skip near-identical consecutive frames.
  return `${raw.length}:${raw.slice(0, 80)}:${raw.slice(-80)}`;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // no-op
    }
  }
}

async function waitForVideoReady(video) {
  if (!video) return;
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise((resolve) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      try {
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("loadeddata", onReady);
      } catch {
        // no-op
      }
    };
    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
  });
}

async function captureAndSendFrame() {
  if (_sendInFlight) return;
  if (!_video || !_canvas) return;
  if (!_context.sessionId) return;
  const vw = Number(_video.videoWidth) || 0;
  const vh = Number(_video.videoHeight) || 0;
  if (vw <= 0 || vh <= 0) return;

  const targetWidth = Math.min(vw, Number(_context.maxWidth) || 1280);
  const targetHeight = Math.max(1, Math.round((vh * targetWidth) / vw));
  _canvas.width = targetWidth;
  _canvas.height = targetHeight;

  const ctx = _canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return;
  ctx.drawImage(_video, 0, 0, targetWidth, targetHeight);
  const frameDataUrl = _canvas.toDataURL("image/jpeg", _context.jpegQuality);
  const now = Date.now();
  const fingerprint = fingerprintFrame(frameDataUrl);
  if (fingerprint && fingerprint === _lastFrameFingerprint && now - _lastFrameSentAt < 900) {
    return;
  }
  _lastFrameFingerprint = fingerprint;
  _lastFrameSentAt = now;

  _sendInFlight = true;
  try {
  const framePayload = {
      sessionId: _context.sessionId,
      executor: _context.executor || undefined,
      mode: _context.mode || undefined,
      model: _context.model || undefined,
      source: _context.source || "screen",
      frameDataUrl,
      width: targetWidth,
      height: targetHeight,
    };

    const sendServerAnalysis = async ({ minIntervalMs } = {}) => {
      const res = await fetch("/api/vision/frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...framePayload,
          minIntervalMs: Number.isFinite(Number(minIntervalMs)) ? Number(minIntervalMs) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || `Vision upload failed (${res.status})`);
      }
      if (data?.analyzed && typeof data?.summary === "string" && data.summary.trim()) {
        visionLastSummary.value = data.summary.trim();
        visionLastAnalyzedAt.value = Date.now();
        return true;
      }
      return false;
    };

    if (typeof _context.onFrame === "function") {
      try {
        const handled = await _context.onFrame(frameDataUrl, {
          source: framePayload.source,
          width: targetWidth,
          height: targetHeight,
          sessionId: _context.sessionId,
        });
        const wasHandled = handled === true || handled?.handled === true;
        if (wasHandled) {
          visionTransportMode.value = "realtime";
          const summary = String(handled?.summary || "").trim();
          if (summary) {
            visionLastSummary.value = summary;
            visionLastAnalyzedAt.value = Date.now();
          } else if (_context.preferRealtimeVision) {
            visionLastSummary.value = "Live vision streaming is active in the realtime session.";
            visionLastAnalyzedAt.value = Date.now();
          }
          // Hybrid assist: keep fresh analyzed summaries in session metadata for
          // tool calls while realtime transport remains the primary live path.
          const hybridInterval = Math.max(
            1200,
            Number(_context.hybridSummaryIntervalMs) || 4500,
          );
          const nowMs = Date.now();
          if (!_hybridAnalyzeInFlight && nowMs - _lastHybridAnalyzeAt >= hybridInterval) {
            _hybridAnalyzeInFlight = true;
            _lastHybridAnalyzeAt = nowMs;
            sendServerAnalysis({ minIntervalMs: hybridInterval })
              .catch(() => {})
              .finally(() => {
                _hybridAnalyzeInFlight = false;
              });
          }
          return;
        }
      } catch (err) {
        if (_context.preferRealtimeVision) {
          console.warn("[vision-stream] realtime frame path failed; using server analysis fallback:", err?.message || err);
        }
      }
    }

    const analyzed = await sendServerAnalysis();
    if (analyzed) {
      visionTransportMode.value = "fallback";
    } else if (visionTransportMode.value === "negotiating") {
      visionTransportMode.value = "fallback";
    }
  } catch (err) {
    visionShareState.value = "error";
    visionShareError.value = err?.message || "Vision stream failed";
  } finally {
    _sendInFlight = false;
  }
}

function cleanupDomNodes() {
  if (_video) {
    try {
      _video.pause();
      _video.srcObject = null;
    } catch {
      // no-op
    }
    _video = null;
  }
  _canvas = null;
}

export async function startVisionShare(options = {}) {
  const sessionId = String(options?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("sessionId required to start vision share");
  }

  const source = normalizeSource(options?.source);
  const intervalMs = normalizeNumber(options?.intervalMs, 1000, 300, 10_000);
  const maxWidth = normalizeNumber(options?.maxWidth, 1280, 320, 1920);
  const jpegQuality = normalizeNumber(options?.jpegQuality, 0.65, 0.35, 0.92);

  await stopVisionShare();
  visionShareState.value = "starting";
  visionTransportMode.value = "negotiating";
  visionShareError.value = null;
  visionShareSource.value = source;

  try {
    if (!navigator?.mediaDevices) {
      throw new Error("Media devices API unavailable");
    }
    if (!isSecureOrLocalhost()) {
      throw new Error("Screen/camera sharing requires HTTPS (or localhost).");
    }

    if (source === "screen") {
      if (typeof navigator.mediaDevices.getDisplayMedia !== "function" && !isElectronDesktopRuntime()) {
        throw new Error("Screen sharing is not supported in this browser");
      }
      _stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 6, max: 12 },
        },
        audio: false,
      });
    } else {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 8, max: 12 },
        },
        audio: false,
      });
    }

    const videoTrack = _stream.getVideoTracks()[0];
    if (!videoTrack) {
      throw new Error("No video track available");
    }
    videoTrack.addEventListener("ended", () => {
      stopVisionShare().catch(() => {});
    });

    _video = document.createElement("video");
    _video.autoplay = true;
    _video.muted = true;
    _video.playsInline = true;
    _video.srcObject = _stream;
    _canvas = document.createElement("canvas");

    await waitForVideoReady(_video);
    try {
      await _video.play();
    } catch {
      // Some browsers auto-play once frames are requested.
    }

    _context = {
      sessionId,
      executor: String(options?.executor || "").trim() || null,
      mode: String(options?.mode || "").trim() || null,
      model: String(options?.model || "").trim() || null,
      source,
      intervalMs,
      maxWidth,
      jpegQuality,
      onFrame: typeof options?.onFrame === "function" ? options.onFrame : null,
      preferRealtimeVision: options?.preferRealtimeVision === true,
      hybridSummaryIntervalMs: normalizeNumber(options?.hybridSummaryIntervalMs, 4500, 1200, 20_000),
    };

    visionShareState.value = "streaming";
    _captureTimer = setInterval(() => {
      captureAndSendFrame().catch((err) => {
        visionShareState.value = "error";
        visionShareError.value = err?.message || "Vision capture failed";
      });
    }, intervalMs);
    await captureAndSendFrame();
  } catch (err) {
    stopTracks(_stream);
    _stream = null;
    cleanupDomNodes();
    resetContext();
    visionShareState.value = "error";
    visionShareError.value = explainVisionStartError(err, source);
    throw err;
  }
}

export async function stopVisionShare() {
  if (_captureTimer) {
    clearInterval(_captureTimer);
    _captureTimer = null;
  }
  stopTracks(_stream);
  _stream = null;
  cleanupDomNodes();
  resetContext();
  _sendInFlight = false;
  visionShareState.value = "off";
  visionTransportMode.value = "idle";
  visionShareSource.value = null;
  visionShareError.value = null;
  visionLastSummary.value = "";
  visionLastAnalyzedAt.value = 0;
}

export async function toggleVisionShare(source, options = {}) {
  const nextSource = normalizeSource(source);
  if (visionShareState.value === "streaming" && visionShareSource.value === nextSource) {
    await stopVisionShare();
    return false;
  }
  await startVisionShare({ ...options, source: nextSource });
  return true;
}
