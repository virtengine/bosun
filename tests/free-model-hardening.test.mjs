import { describe, expect, it } from "vitest";
import { testTimeout } from "./timeout-helper.mjs";

import {
  classifyTruncatedTurn,
  formatTurnDiagnostics,
  getModelCapabilities,
  isFreeTierModel,
  logProviderTurn,
  lowerReasoningBudget,
  resolveFreeTierTimeoutMs,
} from "../agent/free-model-policy.mjs";
import { normalizeProviderResultPayload } from "../agent/provider-message-transform.mjs";
import { createProviderSession } from "../agent/provider-session.mjs";

const TEST_TIMEOUT_MS = testTimeout(30_000);

describe("free-model hardening", () => {
  it("classifies finish_reason=length with reasoning-only content as retryable, never silent success", () => {
    const classification = classifyTruncatedTurn({
      text: "",
      reasoningText: "long chain of thought that consumed the budget",
      toolCalls: [],
      finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 2000 },
    });
    expect(classification.retryable).toBe(true);
    expect(classification.fallbackAvailable).toBe(true);
    expect(classification.kind).toBe("truncated_length_reasoning_only");
    expect(classification.reasoningChars).toBeGreaterThan(0);
    expect(classification.contentChars).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("normalizes OpenRouter reasoning_content shapes and flags reasoning-only payloads", () => {
    const normalized = normalizeProviderResultPayload({
      choices: [{
        message: { content: "", reasoning_content: "all reasoning, no visible answer" },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 50, completion_tokens: 1500 },
    }, { providerId: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" });
    expect(normalized.reasoningText).toContain("all reasoning");
    expect(normalized.finishReason).toBe("length");
    expect(normalized.truncated).toBe(true);
    expect(normalized.reasoningOnly).toBe(true);
    expect(normalized.retryable).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("resolves slow-model-aware timeouts for the free tier", () => {
    // Observed: 16s cold start, 55s tool turns — budgets must clear both.
    expect(resolveFreeTierTimeoutMs({ model: "nvidia/nemotron-3.5-lightning:free", isFirstTurn: true }))
      .toBeGreaterThanOrEqual(16_000);
    expect(resolveFreeTierTimeoutMs({ model: "openrouter/free", isFirstTurn: false }))
      .toBeGreaterThanOrEqual(55_000);
    // Explicit caller timeouts still win.
    expect(resolveFreeTierTimeoutMs({ model: "openrouter/free", timeoutMs: 5000 })).toBe(5000);
    expect(lowerReasoningBudget("high")).toBe("medium");
    expect(lowerReasoningBudget("medium")).toBe("low");
  }, TEST_TIMEOUT_MS);

  it("exposes per-model capability metadata for routing", () => {
    expect(isFreeTierModel("nvidia/nemotron-3.5-lightning:free")).toBe(true);
    expect(isFreeTierModel("openai/gpt-5")).toBe(false);
    const caps = getModelCapabilities("nvidia/nemotron-3.5-lightning:free");
    expect(caps.toolCalling).toBe("unreliable");
    expect(caps.reasoningStyle).toBe("reasoning-heavy");
    expect(caps.recommendedReasoningEffort).toBe("low");
  }, TEST_TIMEOUT_MS);

  it("logs per-turn model, latency, finish reason and token counts", () => {
    const lines = [];
    const entry = logProviderTurn({
      model: "nvidia/nemotron-3.5-lightning:free",
      latencyMs: 16000,
      finishReason: "length",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      classification: classifyTruncatedTurn({
        text: "",
        reasoningText: "reasoning",
        toolCalls: [],
        finishReason: "length",
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
    }, { info: (line) => lines.push(line) });
    expect(entry.model).toContain("nemotron");
    expect(entry.latencyMs).toBe(16000);
    expect(entry.finishReason).toBe("length");
    expect(entry.totalTokens).toBe(30);
    expect(lines.join("\n")).toContain("finishReason=length");
    expect(formatTurnDiagnostics({ model: "m", latencyMs: 5, finishReason: "stop", usage: {} }).classification).toBe("ok");
  }, TEST_TIMEOUT_MS);

  it("surfaces reasoning-only provider turns as explicit failure, not empty success", async () => {
    const events = [];
    const session = createProviderSession("openrouter", {
      model: "nvidia/nemotron-3.5-lightning:free",
      adapter: {
        name: "free-stub",
        exec: async () => ({
          finalResponse: "",
          text: "",
          choices: [{
            message: { content: "", reasoning_content: "budget consumed by reasoning" },
            finish_reason: "length",
          }],
          finish_reason: "length",
          reasoning_content: "budget consumed by reasoning",
          usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
          sessionId: "free-1",
        }),
      },
      onEvent: (event) => events.push(event),
    });
    const result = await session.runTurn("reasoning-heavy prompt", {});
    // Must not be a silent empty success.
    const isExplicit = result.success === false || Boolean(result.reasoningFallback || result.truncated);
    expect(isExplicit).toBe(true);
    if (result.success === false) {
      expect(String(result.error || "")).not.toBe("");
    } else {
      expect(String(result.finalResponse || result.output || "").trim().length).toBeGreaterThan(0);
    }
    expect(events.some((event) => event.type === "provider:turn-diagnostics")).toBe(true);
  }, TEST_TIMEOUT_MS);
});
