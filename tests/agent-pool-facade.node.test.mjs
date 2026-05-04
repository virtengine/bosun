import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "agent/agent-pool.mjs"), "utf8");

describe("agent-pool facade boundary", () => {
  it("re-exports the canonical launcher surface", () => {
    assert.match(
      source,
      /export \* from "\.\/agent-launcher\.mjs";/,
      "agent-pool should re-export the bounded launcher owner",
    );
  });

  it("does not retain launcher implementation bodies", () => {
    assert.ok(
      !source.includes("export async function launchEphemeralThread")
      && !source.includes("async function launchCodexThread"),
      "agent-pool should remain a thin facade with no launcher implementation bodies",
    );
  });
});
