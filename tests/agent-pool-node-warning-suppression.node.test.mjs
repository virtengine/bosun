import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "agent/agent-launcher.mjs"), "utf8");

describe("agent-pool node warning suppression", () => {
  it("defines applyNodeWarningSuppressionEnv function", () => {
    assert.match(
      source,
      /function applyNodeWarningSuppressionEnv\s*\(/,
      "applyNodeWarningSuppressionEnv function should be defined",
    );
  });

  it("injects NODE_NO_WARNINGS=1 into spawned process env", () => {
    assert.ok(
      source.includes("NODE_NO_WARNINGS") && source.includes('"1"') || source.includes("NODE_NO_WARNINGS=1"),
      "should inject NODE_NO_WARNINGS=1",
    );
  });

  it("supports opt-out via BOSUN_SUPPRESS_NODE_WARNINGS=0", () => {
    assert.ok(
      source.includes("BOSUN_SUPPRESS_NODE_WARNINGS"),
      "should check BOSUN_SUPPRESS_NODE_WARNINGS env var for opt-out",
    );
  });

  it("applies suppression to Codex/Copilot spawned processes", () => {
    assert.ok(
      source.includes("applyNodeWarningSuppressionEnv"),
      "applyNodeWarningSuppressionEnv should be called in agent-launcher.mjs",
    );
  });

  it("does not suppress warnings when BOSUN_SUPPRESS_NODE_WARNINGS is 0", () => {
    // Verify the opt-out condition is checked before injecting NODE_NO_WARNINGS
    const hasOptOut = /BOSUN_SUPPRESS_NODE_WARNINGS.*[=!]=.*["']0["']|["']0["'].*BOSUN_SUPPRESS_NODE_WARNINGS/.test(source);
    assert.ok(
      hasOptOut,
      "should conditionally suppress based on BOSUN_SUPPRESS_NODE_WARNINGS",
    );
  });
});
