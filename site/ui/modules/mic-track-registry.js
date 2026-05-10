/**
 * mic-track-registry.js
 *
 * Tracks microphone input streams obtained via getUserMedia and provides a
 * hard-stop primitive used by voice teardown to prevent lingering "mic in use"
 * indicators after a call is closed.
 */

const trackedStreams = new Set();
let patched = false;

function isMediaStreamLike(stream) {
  return Boolean(stream && typeof stream.getTracks === "function");
}

function getAudioTracks(stream) {
  if (!isMediaStreamLike(stream)) return [];
  try {
    return (stream.getAudioTracks?.() || [])
      .filter((track) => String(track?.kind || "").toLowerCase() === "audio");
  } catch {
    return [];
  }
}

function pruneInactiveStreams() {
  for (const stream of trackedStreams) {
    const tracks = getAudioTracks(stream);
    if (!tracks.length) {
      trackedStreams.delete(stream);
      continue;
    }
    const hasLive = tracks.some((track) => String(track?.readyState || "live").toLowerCase() !== "ended");
    if (!hasLive) trackedStreams.delete(stream);
  }
}

export function registerMicStream(stream) {
  if (!isMediaStreamLike(stream)) return;
  trackedStreams.add(stream);
  const tracks = getAudioTracks(stream);
  for (const track of tracks) {
    try {
      track.addEventListener?.("ended", () => {
        pruneInactiveStreams();
      }, { once: true });
    } catch {
      // no-op
    }
  }
}

export function ensureMicTrackingPatched() {
  if (patched) return;
  const mediaDevices = globalThis?.navigator?.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") return;
  const original = mediaDevices.getUserMedia.bind(mediaDevices);
  mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args);
    registerMicStream(stream);
    return stream;
  };
  patched = true;
}

export function stopTrackedMicStreams() {
  for (const stream of trackedStreams) {
    const tracks = getAudioTracks(stream);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // no-op
      }
    }
  }
  pruneInactiveStreams();
}

export function _resetMicTrackRegistryForTests() {
  trackedStreams.clear();
  patched = false;
}
