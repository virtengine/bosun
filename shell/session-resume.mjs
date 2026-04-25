/**
 * shell/session-resume.mjs — Session Store Resume Integration
 *
 * Bridges the in-memory adapter sessions with `shell/session-store.mjs`
 * so that persisted sessions can be restored across process restarts.
 *
 * Public API:
 *   createSessionResumer(store) → {
 *     tryResume(sessionId, model) → { resumed: bool, session }
 *     persistSession(sessionId, session) → Promise<void>
 *   }
 */

import { createSessionStore, replayEvents } from "./session-store.mjs";

const TAG = "[session-resume]";

function toStr(v) {
  return String(v ?? "").trim();
}

export function createSessionResumer(storeOrOptions = {}) {
  const store = storeOrOptions?.append && storeOrOptions?.load
    ? storeOrOptions
    : createSessionStore(storeOrOptions);

  /**
   * Attempt to load a persisted session from disk.
   * Returns { resumed: boolean, session: object|null }
   * where session has { messages, model, lastResponseId, aggregatedUsage, compactionCount }.
   */
  async function tryResume(sessionId, model = "") {
    const id = toStr(sessionId);
    if (!id) return { resumed: false, session: null };
    try {
      const loaded = await store.load(id);
      if (!loaded || !Array.isArray(loaded.messages)) {
        return { resumed: false, session: null };
      }
      return {
        resumed: true,
        session: {
          messages: loaded.messages,
          model: loaded.model || model,
          lastResponseId: loaded.lastResponseId || null,
          aggregatedUsage: loaded.aggregatedUsage || null,
          compactionCount: loaded.compactionCount || 0,
          createdAt: loaded.createdAt || null,
          updatedAt: loaded.updatedAt || null,
        },
      };
    } catch (err) {
      console.warn(`${TAG} resume failed for "${id}": ${err?.message || err}`);
      return { resumed: false, session: null };
    }
  }

  /**
   * Persist a session snapshot to disk. Best-effort: never throws.
   */
  async function persistSession(sessionId, session = {}) {
    const id = toStr(sessionId);
    if (!id) return;
    try {
      // Only write a lightweight checkpoint; full history is append-only via events.
      const model = session.model || "";
      await store.append(id, "session.checkpoint", {
        model,
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
        lastResponseId: session.lastResponseId || null,
        compactionCount: session.compactionCount || 0,
      });
    } catch (err) {
      console.warn(`${TAG} persist failed for "${id}": ${err?.message || err}`);
    }
  }

  return { store, tryResume, persistSession };
}

/**
 * Singleton default resumer using the default store directory.
 */
let _defaultResumer = null;

export function getDefaultSessionResumer() {
  if (!_defaultResumer) {
    _defaultResumer = createSessionResumer();
  }
  return _defaultResumer;
}

export function resetDefaultSessionResumer() {
  _defaultResumer = null;
}

export default { createSessionResumer, getDefaultSessionResumer, resetDefaultSessionResumer };
