/**
 * tests/opencode-model-capabilities.test.mjs
 *
 * The Zen "free" set and the agent-capable set are different properties.
 * These tests pin the verified 2026-09-27 capability split so a regression
 * (e.g. re-adding a non-tool-use model to the executor path) fails loudly:
 *
 * Unsupported (fail every agent turn with "No endpoints found that support
 * tool use"): space-bunny-free, longcat-2.5-preview-free,
 * mimo-v2.6-flash-free, muse-spark-1.3-contributor-free.
 *
 * Supported: nemotron-3-ultra-free, ling-3.0-flash-fin-free,
 * nemotron-3.5-lightning-free.
 */

import { describe, it, expect } from "vitest";

import {
  OPENCODE_AGENT_CAPABLE_FREE_MODELS,
  OPENCODE_TOOL_USE_UNSUPPORTED_MODELS,
  normalizeOpencodeModelId,
  isKnownToolUseUnsupportedModel,
  isKnownAgentCapableModel,
  describeOpencodeModelCapability,
  getToolUsePreflightError,
  isToolUseUnsupportedError,
} from "../shell/opencode-model-capabilities.mjs";

describe("Zen free capability sets", () => {
  it("lists the four verified non-tool-use models as unsupported", () => {
    expect([...OPENCODE_TOOL_USE_UNSUPPORTED_MODELS].sort()).toEqual(
      [
        "space-bunny-free",
        "longcat-2.5-preview-free",
        "mimo-v2.6-flash-free",
        "muse-spark-1.3-contributor-free",
      ].sort(),
    );
  });

  it("lists the three verified tool-use models as agent-capable", () => {
    expect([...OPENCODE_AGENT_CAPABLE_FREE_MODELS].sort()).toEqual(
      [
        "nemotron-3-ultra-free",
        "ling-3.0-flash-fin-free",
        "nemotron-3.5-lightning-free",
      ].sort(),
    );
  });

  it("keeps the two sets disjoint", () => {
    const unsupported = new Set(OPENCODE_TOOL_USE_UNSUPPORTED_MODELS);
    for (const model of OPENCODE_AGENT_CAPABLE_FREE_MODELS) {
      expect(unsupported.has(model)).toBe(false);
    }
  });
});

describe("normalizeOpencodeModelId", () => {
  it("strips the opencode/ provider prefix", () => {
    expect(normalizeOpencodeModelId("opencode/space-bunny-free")).toBe("space-bunny-free");
  });

  it("strips the opencode-go/ provider prefix without changing capability", () => {
    expect(normalizeOpencodeModelId("opencode-go/space-bunny-free")).toBe("space-bunny-free");
    expect(normalizeOpencodeModelId("opencode-go/nemotron-3-ultra-free")).toBe(
      "nemotron-3-ultra-free",
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(normalizeOpencodeModelId("  OpenCode/Space-Bunny-Free ")).toBe("space-bunny-free");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeOpencodeModelId("")).toBe("");
    expect(normalizeOpencodeModelId(null)).toBe("");
    expect(normalizeOpencodeModelId(undefined)).toBe("");
  });
});

describe("isKnownToolUseUnsupportedModel / isKnownAgentCapableModel", () => {
  it("flags each unsupported id with and without provider prefix", () => {
    for (const id of OPENCODE_TOOL_USE_UNSUPPORTED_MODELS) {
      expect(isKnownToolUseUnsupportedModel(id)).toBe(true);
      expect(isKnownToolUseUnsupportedModel(`opencode/${id}`)).toBe(true);
      expect(isKnownToolUseUnsupportedModel(`opencode-go/${id}`)).toBe(true);
      expect(isKnownAgentCapableModel(id)).toBe(false);
    }
  });

  it("flags each capable id with and without provider prefix", () => {
    for (const id of OPENCODE_AGENT_CAPABLE_FREE_MODELS) {
      expect(isKnownAgentCapableModel(id)).toBe(true);
      expect(isKnownAgentCapableModel(`opencode/${id}`)).toBe(true);
      expect(isKnownToolUseUnsupportedModel(id)).toBe(false);
    }
  });

  it("returns false for unknown and empty models (unknown must not block)", () => {
    expect(isKnownToolUseUnsupportedModel("some-future-model")).toBe(false);
    expect(isKnownAgentCapableModel("some-future-model")).toBe(false);
    expect(isKnownToolUseUnsupportedModel("")).toBe(false);
  });
});

describe("describeOpencodeModelCapability", () => {
  it("reports capable:false with alternatives for an unsupported model", () => {
    const described = describeOpencodeModelCapability("opencode/muse-spark-1.3-contributor-free");
    expect(described.capable).toBe(false);
    expect(described.alternatives).toEqual([...OPENCODE_AGENT_CAPABLE_FREE_MODELS]);
  });

  it("reports capable:true for a supported model", () => {
    expect(describeOpencodeModelCapability("opencode/nemotron-3-ultra-free").capable).toBe(true);
  });

  it("reports capable:null for unknown models so they are never blocked", () => {
    expect(describeOpencodeModelCapability("gpt-5.2-codex").capable).toBe(null);
    expect(describeOpencodeModelCapability("").capable).toBe(null);
  });
});

describe("getToolUsePreflightError", () => {
  it("refuses an unsupported model and names agent-capable alternatives", () => {
    const err = getToolUsePreflightError("opencode/space-bunny-free");
    expect(err).toContain("does not support tool use");
    expect(err).toContain("opencode/nemotron-3-ultra-free");
    expect(err).toContain("opencode/ling-3.0-flash-fin-free");
    expect(err).toContain("opencode/nemotron-3.5-lightning-free");
  });

  it("returns null for capable, unknown, and empty models", () => {
    expect(getToolUsePreflightError("opencode/nemotron-3-ultra-free")).toBeNull();
    expect(getToolUsePreflightError("gpt-5.2-codex")).toBeNull();
    expect(getToolUsePreflightError("")).toBeNull();
    expect(getToolUsePreflightError(null)).toBeNull();
  });
});

describe("isToolUseUnsupportedError", () => {
  it("matches the exact provider rejection string", () => {
    expect(isToolUseUnsupportedError("No endpoints found that support tool use.")).toBe(true);
    expect(isToolUseUnsupportedError("APIError: No endpoints found that support tool use")).toBe(true);
  });

  it("matches Error objects carrying the rejection", () => {
    expect(isToolUseUnsupportedError(new Error("No endpoints found that support tool use."))).toBe(true);
  });

  it("matches SDK result shapes with nested info.error", () => {
    expect(
      isToolUseUnsupportedError({
        data: {
          info: {
            error: { name: "APIError", data: { message: "No endpoints found that support tool use." } },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects unrelated failures and empty input", () => {
    expect(isToolUseUnsupportedError("connection refused")).toBe(false);
    expect(isToolUseUnsupportedError(new Error("503 service unavailable"))).toBe(false);
    expect(isToolUseUnsupportedError({ data: { info: {} } })).toBe(false);
    expect(isToolUseUnsupportedError("")).toBe(false);
    expect(isToolUseUnsupportedError(null)).toBe(false);
    expect(isToolUseUnsupportedError(undefined)).toBe(false);
  });
});
