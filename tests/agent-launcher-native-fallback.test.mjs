import { describe, it, expect } from "vitest";
import { createHarnessProviderSessionRuntime } from "../agent/internal-harness-control-plane.mjs";
import { createRetryQueueState, reduceRetryQueue, snapshotRetryQueue } from "../agent/retry-queue.mjs";

describe("native fallback hardening seams", () => {
  it("routes openai-native launches through provider runtime and preserves extra metadata", async () => {
    const launchNative = async (...args) => ({ kind: "launch", args });
    const runtime = createHarnessProviderSessionRuntime({
      launchers: {
        "openai-native": launchNative,
      },
    });

    const extra = {
      sessionId: "native-1",
      nativeFallbackContext: {
        enabled: true,
        maxAttempts: 3,
        attempt: 1,
      },
    };

    const result = await runtime.launchSession({
      sdkName: "openai-native",
      prompt: "native launch",
      cwd: "C:/repo",
      timeoutMs: 2500,
      extra,
    });

    expect(launchNative).toBeTypeOf("function");
    expect(result).toEqual({
      kind: "launch",
      args: ["native launch", "C:/repo", 2500, extra],
    });
  });

  it("tracks retry budget exhaustion for native fallback attempts", () => {
    let state = createRetryQueueState(1000);
    state = reduceRetryQueue(state, {
      type: "bump-count",
      taskId: "native-fallback:session-1",
      now: 1000,
      item: {
        taskId: "native-fallback:session-1",
        taskTitle: "OpenAI Native fallback",
        status: "retrying",
        reason: "binary_not_found",
        maxRetries: 2,
        fallbackReason: "binary_not_found",
      },
    });
    state = reduceRetryQueue(state, {
      type: "bump-count",
      taskId: "native-fallback:session-1",
      now: 2000,
      item: {
        taskId: "native-fallback:session-1",
        taskTitle: "OpenAI Native fallback",
        status: "retrying",
        reason: "binary_not_found",
        maxRetries: 2,
        fallbackReason: "binary_not_found",
      },
    });
    state = reduceRetryQueue(state, {
      type: "mark-exhausted",
      taskId: "native-fallback:session-1",
      now: 3000,
    });

    const snapshot = snapshotRetryQueue(state);
    expect(snapshot.count).toBe(0);
    expect(snapshot.stats.totalRetriesToday).toBe(2);
    expect(snapshot.stats.peakRetryDepth).toBe(2);
    expect(snapshot.stats.exhaustedTaskIds).toContain("native-fallback:session-1");
  });
});
