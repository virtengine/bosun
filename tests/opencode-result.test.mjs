/**
 * The OpenCode executor reported "(Agent completed with no text output)" for
 * every failure — including a hard provider rejection. That string reads as
 * success, so a completely non-functional executor looked like a working one
 * that happened to be terse.
 *
 * An agent error arrives as a non-text part (here, a "patch") plus info.error.
 * The error has to be reported.
 */

import { describe, it, expect } from "vitest";

import { formatOpencodeResult } from "../shell/opencode-result.mjs";

describe("formatOpencodeResult", () => {
  it("joins text parts", () => {
    const out = formatOpencodeResult({
      data: {
        parts: [
          { type: "step-start" },
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "step-finish" },
        ],
      },
    });
    expect(out).toBe("first\nsecond");
  });

  it("trims text parts and drops empty ones", () => {
    const out = formatOpencodeResult({
      data: { parts: [{ type: "text", text: "  padded  " }, { type: "text", text: "   " }] },
    });
    expect(out).toBe("padded");
  });

  it("reports the agent error instead of claiming an empty completion", () => {
    // The real payload: providerID routed to a model with no tool-use endpoint.
    const out = formatOpencodeResult({
      data: {
        info: {
          role: "assistant",
          providerID: "openrouter",
          modelID: "space-bunny-free",
          error: { name: "APIError", data: { message: "No endpoints found that support tool use." } },
        },
        parts: [{ type: "patch", text: "" }],
      },
    });
    expect(out).toContain("No endpoints found that support tool use.");
    expect(out).toContain("APIError");
    expect(out).not.toContain("no text output");
  });

  it("prefers real text over an accompanying error field", () => {
    // A turn can carry both; the text is the answer the user asked for.
    const out = formatOpencodeResult({
      data: {
        info: { error: { name: "APIError", data: { message: "transient" } } },
        parts: [{ type: "text", text: "recovered answer" }],
      },
    });
    expect(out).toBe("recovered answer");
  });

  it("falls back to info.content when there are no parts", () => {
    const out = formatOpencodeResult({ data: { info: { content: "  from info  " } } });
    expect(out).toBe("from info");
  });

  it("only says 'no text output' when there is genuinely nothing to report", () => {
    const out = formatOpencodeResult({ data: { parts: [{ type: "step-start" }] } });
    expect(out).toBe("(Agent completed with no text output)");
  });

  it("handles a bare info.parts shape and a missing data", () => {
    expect(formatOpencodeResult({ info: { parts: [{ type: "text", text: "x" }] } })).toBe("x");
    expect(formatOpencodeResult({})).toBe("(Agent completed with no text output)");
    expect(formatOpencodeResult(null)).toBe("(Agent completed with no text output)");
  });
});
