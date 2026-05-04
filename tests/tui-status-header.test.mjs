import { describe, expect, it } from "vitest";

import {
  buildStatusHeaderModel,
  normalizeHeaderRateLimits,
} from "../tui/components/status-header.mjs";

describe("tui status header", () => {
  it("formats live system metrics and connection metadata", () => {
    const model = buildStatusHeaderModel({
      stats: {
        activeAgents: 3,
        maxAgents: 8,
        throughputTps: 12.5,
        uptimeMs: 3_661_000,
        tokensIn: 12_300,
        tokensOut: 4_560,
        tokensTotal: 16_860,
        sessionHealth: {
          live: 2,
          blocked: 1,
          stalled: 1,
        },
        context: {
          sessionsNearContextLimit: 1,
        },
        rateLimitSummary: {
          providersNearExhaustion: 2,
        },
        rateLimits: {
          openai: { primary: 18, secondary: 9, credits: 2, unit: "min" },
          anthropic: { primary: 0, secondary: 5, credits: 0, unit: "min" },
        },
      },
      configuredProviders: {
        codex: true,
        claude: true,
        gemini: false,
        copilot: false,
      },
      connectionState: "reconnecting",
      projectLabel: "linear://ENG",
      refreshCountdownSec: 1,
      connectionSource: "saved-remote",
      connectionEndpoint: "https://bosun.example.com:4400",
      authMode: "api-key",
    });

    expect(model.row1).toContain("Agents:");
    expect(model.row1).toContain("Throughput: 12.5 tps");
    expect(model.row1).toContain("Runtime: 1h 1m");
    expect(model.row1).toContain("Tokens: in 12.3k | out 4.6k | total 16.9k");

    expect(model.row3.connection.label).toBe("Reconnecting");
    expect(model.row3.healthLabel).toContain("Live  2");
    expect(model.row3.healthLabel).toContain("blocked  1");
    expect(model.row3.healthLabel).toContain("near limit  1");
    expect(model.row3.projectLabel).toBe("linear://ENG");
    expect(model.row3.refreshLabel).toBe("Next refresh: 1s");
    expect(model.row4.attachLabel).toBe("Attach: saved-remote -> https://bosun.example.com:4400");
    expect(model.row4.authLabel).toBe("Auth: API key");
  });

  it("maps provider aliases and shows n/a for unconfigured providers", () => {
    const providers = normalizeHeaderRateLimits(
      {
        openai: { primary: 10, secondary: 5, credits: 3, unit: "min" },
        anthropic: { primary: 4, secondary: 2, credits: 1, unit: "min" },
      },
      {
        codex: true,
        claude: true,
        gemini: false,
        copilot: false,
      },
    );

    expect(providers.codex.label).toContain("primary 10/min | secondary 5/min | credits 3");
    expect(providers.claude.label).toContain("primary 4/min | secondary 2/min | credits 1");
    expect(providers.gemini.label).toContain("n/a");
    expect(providers.gemini.tone).toBe("dim");
    expect(providers.copilot.label).toContain("n/a");
  });

  it("flags exhausted providers red", () => {
    const providers = normalizeHeaderRateLimits(
      {
        copilot: { primary: 0, secondary: 1, credits: 0, unit: "min" },
      },
      { copilot: true },
    );

    expect(providers.copilot.tone).toBe("danger");
    expect(providers.copilot.label).toContain("primary 0/min | secondary 1/min | credits 0");
  });

  it("flags near-exhaustion yellow from provider limits and accepts totalTokens alias", () => {
    const providers = normalizeHeaderRateLimits(
      {
        gemini: {
          primary: 2,
          primaryLimit: 10,
          secondary: 9,
          secondaryLimit: 10,
          credits: 1,
          creditsLimit: 5,
          unit: "min",
        },
      },
      { gemini: true },
    );

    const model = buildStatusHeaderModel({
      stats: {
        activeAgents: 1,
        maxAgents: 4,
        throughputTps: 2,
        uptimeMs: 20_000,
        tokensIn: 100,
        tokensOut: 50,
        totalTokens: 150,
        rateLimits: {
          gemini: {
            primary: 2,
            primaryLimit: 10,
            secondary: 9,
            secondaryLimit: 10,
            credits: 1,
            creditsLimit: 5,
            unit: "min",
          },
        },
      },
      configuredProviders: { gemini: true },
    });

    expect(providers.gemini.tone).toBe("warning");
    expect(model.row1).toContain("Tokens: in 100 | out 50 | total 150");
  });
});
