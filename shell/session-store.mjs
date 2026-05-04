// shell/session-store.mjs
//
// Crash-safe JSONL session persistence for the native harness.
//
// Design choices (see _docs/BOSUN_NATIVE_HARNESS_GAP_PLAN.md §C.1 / §D.1):
//   - Append-only JSONL file per session — survives process crashes; no
//     external dependency (no SQLite required).
//   - Each line is one event: { kind, ts, payload }. Replaying the events in
//     order reconstructs the in-memory session (`messages[]`, `model`,
//     `lastResponseId`, `aggregatedUsage`).
//   - All file I/O is best-effort: persistence failures are logged via
//     console.warn and never break the live agent path.
//   - Pure ESM, fs/promises only — works in Node 20+.
//
// Public API:
//   - createSessionStore({ rootDir }) → { append, load, list, remove, sessionPath }
//   - replayEvents(events) → { messages, model, lastResponseId, aggregatedUsage,
//                              compactionCount, createdAt, updatedAt }
//
// Event kinds:
//   - "session.created"      payload: { model }
//   - "user_message"         payload: { text }
//   - "assistant_message"    payload: { text, toolCalls? }
//   - "function_call"        payload: { callId, name, arguments }
//   - "function_call_output" payload: { callId, output }
//   - "session.usage"        payload: usage object (cumulative additions)
//   - "session.lastResponseId" payload: { id }
//   - "session.compaction"   payload: { strategy, removedCount, newMessageCount }
//   - "session.cleared"      payload: {}
//
// The store is intentionally generic — adapters call append(sessionId, kind,
// payload) at the points that mutate session state.

import { promises as fs, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_ROOT = path.join(os.homedir(), ".bosun", "native-sessions");

function safeId(sessionId) {
  // Allowlist: alphanumerics plus underscore/dot/dash, then collapse any run
  // of consecutive dots so the resulting basename can never look like a
  // traversal segment ("..", "../", "..\"). path.join() with a single
  // string argument already prevents real escape, but a clean basename keeps
  // disk inspection and log output unambiguous.
  return String(sessionId || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 200);
}

function ensureDirSync(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function createSessionStore(options = {}) {
  const rootDir = options.rootDir ? String(options.rootDir) : DEFAULT_ROOT;
  ensureDirSync(rootDir);

  function sessionPath(sessionId) {
    const id = safeId(sessionId);
    if (!id) throw new Error("session-store: sessionId is required");
    return path.join(rootDir, `${id}.jsonl`);
  }

  async function append(sessionId, kind, payload = {}) {
    const id = safeId(sessionId);
    if (!id || !kind) return false;
    const line = JSON.stringify({ kind, ts: Date.now(), payload }) + "\n";
    try {
      await fs.appendFile(sessionPath(id), line, "utf8");
      return true;
    } catch (err) {
      // Best-effort: never let persistence failure block the live turn.
      console.warn("[session-store] append failed:", err?.message || err);
      return false;
    }
  }

  async function load(sessionId) {
    const id = safeId(sessionId);
    if (!id) return null;
    const filePath = sessionPath(id);
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      console.warn("[session-store] read failed:", err?.message || err);
      return null;
    }
    const events = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines (e.g. partial write at the tail of a crash).
      }
    }
    return replayEvents(events);
  }

  async function list() {
    try {
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => e.name.slice(0, -".jsonl".length));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      console.warn("[session-store] list failed:", err?.message || err);
      return [];
    }
  }

  async function remove(sessionId) {
    const id = safeId(sessionId);
    if (!id) return false;
    try {
      await fs.unlink(sessionPath(id));
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      console.warn("[session-store] unlink failed:", err?.message || err);
      return false;
    }
  }

  return { append, load, list, remove, sessionPath, rootDir };
}

/**
 * Reconstruct in-memory session state by replaying append-only events in
 * order.  Pure function — exposed for tests and for in-process resume.
 *
 * Returns null when the event log is empty.
 */
export function replayEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const session = {
    model: "",
    lastResponseId: null,
    messages: [],
    compactionCount: 0,
    aggregatedUsage: null,
    createdAt: null,
    updatedAt: null,
  };
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const kind = String(ev.kind || "");
    const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
    if (typeof ev.ts === "number") {
      if (session.createdAt == null) session.createdAt = ev.ts;
      session.updatedAt = ev.ts;
    }
    switch (kind) {
      case "session.created":
        if (payload.model) session.model = String(payload.model);
        break;
      case "user_message":
        session.messages.push({ type: "user_message", text: String(payload.text ?? "") });
        break;
      case "assistant_message":
        session.messages.push({
          type: "assistant_message",
          text: String(payload.text ?? ""),
          toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls : [],
        });
        break;
      case "function_call":
        session.messages.push({
          type: "function_call",
          callId: payload.callId,
          name: payload.name,
          arguments: payload.arguments,
        });
        break;
      case "function_call_output":
        session.messages.push({
          type: "function_call_output",
          callId: payload.callId,
          output: payload.output,
        });
        break;
      case "session.usage":
        if (!session.aggregatedUsage) session.aggregatedUsage = {};
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === "number") {
            session.aggregatedUsage[k] = (session.aggregatedUsage[k] || 0) + v;
          }
        }
        break;
      case "session.lastResponseId":
        if (payload.id) session.lastResponseId = String(payload.id);
        break;
      case "session.compaction":
        session.compactionCount += 1;
        break;
      case "session.cleared":
        session.messages = [];
        session.lastResponseId = null;
        break;
      default:
        // Unknown kinds are ignored for forward compatibility.
        break;
    }
  }
  return session;
}

export default createSessionStore;
