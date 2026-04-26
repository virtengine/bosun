import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSessionInsights,
  buildSessionInsights,
  _resetSessionInsightsWorker,
} from "../ui/modules/session-insights.js";

/**
 * Build a heavy (1000-message) session payload to stress both compute paths.
 * Mirrors the kind of session that historically blocked the main thread
 * for >100 ms when buildSessionInsights ran inline on every poll cycle.
 */
function buildHeavySession(messageCount = 1000) {
  const tools = ["read_file", "apply_patch", "command_execution", "grep_search"];
  const messages = [];
  for (let i = 0; i < messageCount; i++) {
    const tool = tools[i % tools.length];
    if (i % 7 === 0) {
      messages.push({
        type: "agent_message",
        role: "assistant",
        content: `Step ${i}: assistant reply with ample text body to inflate the payload size for the worker to chew on.`,
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        meta: {
          usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
        },
      });
      continue;
    }
    if (i % 11 === 0) {
      messages.push({
        type: "error",
        content: `Synthetic error ${i}`,
        timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
      continue;
    }
    messages.push({
      type: "tool_call",
      content:
        tool === "apply_patch"
          ? `*** Begin Patch\n*** Update File: src/ui/app.js\n*** End Patch\n`
          : `${tool}(src/path/to/file-${i % 25}.js)`,
      meta: { toolName: tool },
      timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
  return { messages, lastActivityAt: messages[messages.length - 1].timestamp };
}

/**
 * Synchronous in-memory Worker stub that re-uses buildSessionInsights so
 * we can assert the worker code path (postMessage round-trip + reply
 * routing) without spawning a real OS worker thread.
 */
class SyncWorkerStub {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(data) {
    queueMicrotask(() => {
      const insights = buildSessionInsights(data?.session || null);
      this.onmessage?.({ data: { id: data.id, ok: true, insights } });
    });
  }
  terminate() { /* noop */ }
}

const originalWorker = globalThis.Worker;

describe("computeSessionInsights (async)", () => {
  beforeEach(() => {
    _resetSessionInsightsWorker();
  });

  afterEach(() => {
    _resetSessionInsightsWorker();
    if (originalWorker == null) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  });

  it("falls back to the idle path when Worker is unavailable", async () => {
    delete globalThis.Worker;
    const session = buildHeavySession(1000);
    const insights = await computeSessionInsights(session);
    const expected = buildSessionInsights(session);
    expect(insights.totals.messages).toBe(expected.totals.messages);
    expect(insights.totals.toolCalls).toBe(expected.totals.toolCalls);
    expect(insights.totals.errors).toBe(expected.totals.errors);
    expect(insights.fileCounts.editedFiles).toBe(expected.fileCounts.editedFiles);
    expect(Array.isArray(insights.recentActions)).toBe(true);
    // Confirm we honor the Phase-3 cap so the worker boundary stays cheap.
    expect(insights.recentActions.length).toBeLessThanOrEqual(6);
  });

  it("uses the Worker path when Worker is available and routes id-keyed responses", async () => {
    globalThis.Worker = SyncWorkerStub;
    const session = buildHeavySession(1000);
    const [a, b] = await Promise.all([
      computeSessionInsights(session),
      computeSessionInsights(session),
    ]);
    expect(a.totals.messages).toBe(1000);
    expect(b.totals.messages).toBe(1000);
    expect(a.totals.toolCalls).toBe(b.totals.toolCalls);
  });

  it("worker and fallback paths produce identical totals for the same session", async () => {
    const session = buildHeavySession(1000);
    delete globalThis.Worker;
    const fallback = await computeSessionInsights(session);
    _resetSessionInsightsWorker();
    globalThis.Worker = SyncWorkerStub;
    const worker = await computeSessionInsights(session);
    expect(worker.totals).toEqual(fallback.totals);
    expect(worker.fileCounts).toEqual(fallback.fileCounts);
  });

  it("rejects with AbortError when the signal aborts before completion", async () => {
    delete globalThis.Worker;
    const ac = new AbortController();
    const session = buildHeavySession(200);
    const p = computeSessionInsights(session, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
