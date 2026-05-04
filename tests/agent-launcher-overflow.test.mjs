import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isContextOverflowError } from "../agent/agent-launcher.mjs";

describe("agent launcher overflow recovery", () => {
  it("classifies Invalid string length as a context overflow signal", () => {
    expect(isContextOverflowError("Invalid string length")).toBe(true);
    expect(
      isContextOverflowError(
        "OpenAI API error 400: Invalid 'input[5].content[0].text': string too long. code=string_above_max_length",
      ),
    ).toBe(true);
  });

  it("invalidates the persistent thread before retrying an overflow failure", () => {
    const source = readFileSync(resolve(process.cwd(), "agent/agent-launcher.mjs"), "utf8");

    expect(source).toMatch(
      /const overflowFailure = isContextOverflowError\(lastResult\.error\);[\s\S]*?if \(overflowFailure\) \{[\s\S]*?forceNewThread\(taskKey, `context_overflow_attempt_\$\{attempt\}`\);/,
    );
  });
});
