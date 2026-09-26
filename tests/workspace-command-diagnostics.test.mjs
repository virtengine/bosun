import { beforeEach, describe, expect, it, vi } from "vitest";

describe("workspace command diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("escapes backslashes in suggested pytest reruns", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "pytest",
      output: "FAILED tests\\api\\test_sample.py::test_case - AssertionError\n= 1 failed in 0.42s =",
      exitCode: 1,
    });

    expect(diagnostic.suggestedRerun).toBe('pytest "tests\\\\api\\\\test_sample.py::test_case"');
  });

  it("parses vitest failures without regex backtracking over tool output", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "vitest",
      output: [
        " FAIL  tests/example.test.mjs:14:1",
        " Test Files  1 failed | 5 passed",
      ].join("\n"),
      exitCode: 1,
    });

    expect(diagnostic.runner).toBe("vitest");
    expect(diagnostic.failedTargets).toContain("tests/example.test.mjs:14:1");
    expect(diagnostic.summary).toContain("1 failed file");
  });

  it("extracts file anchors from tokenized output", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "node",
      output: "Error in workspace/command-diagnostics.mjs:63 and tests/workspace-command-diagnostics.test.mjs:1",
      exitCode: 1,
    });

    expect(diagnostic.fileAnchors).toContain("workspace/command-diagnostics.mjs:63");
    expect(diagnostic.fileAnchors).toContain("tests/workspace-command-diagnostics.test.mjs:1");
  });

  it("keeps vitest rerun guidance for a compacted test excerpt with no surviving target", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    // Second compaction pass: the raw child output (and with it the `FAIL <file>`
    // line and the `Test Files ... failed` summary) has already been replaced by
    // the compacted excerpt, so neither vitest signal reaches this call.
    const diagnostic = await analyzeCommandDiagnostic({
      command: "node -e \"process.exit(1)\"",
      output: [
        "[Live-compacted test] node -e \"process.exit(1)\" -> 223 lines / 6.6K chars, saved ~71% | Full output: bosun --tool-log 123456",
        "",
        "Highlights: 1 error line; 2 file or match lines",
      ].join("\n"),
      exitCode: 1,
    });

    expect(diagnostic.family).toBe("test");
    expect(diagnostic.runner).toBe("vitest");
    expect(diagnostic.suggestedRerun).toContain("vitest run");
  });

  it("reports the retained test target when a compacted excerpt still names one", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "node -e \"process.exit(1)\"",
      output: [
        "[Live-compacted test] node -e \"process.exit(1)\" -> 223 lines / 6.6K chars, saved ~71% | Full output: bosun --tool-log 123456",
        "",
        "Highlights: 1 error line; 2 file or match lines",
        "",
        "Top files: tests/runtime/example.test.ts",
      ].join("\n"),
      exitCode: 1,
    });

    expect(diagnostic.runner).toBe("vitest");
    expect(diagnostic.suggestedRerun).toContain("vitest run");
    expect(diagnostic.suggestedRerun).toContain("tests/runtime/example.test.ts");
  });

  it("does not turn a non-test compacted excerpt into a vitest rerun", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "npx tsc --noEmit",
      output: [
        "[Live-compacted build] npx tsc --noEmit -> 90 lines / 5.1K chars, saved ~64% | Full output: bosun --tool-log 987",
        "",
        "Selected lines:",
        "src/app.ts:12:3 error TS2322: Type 'string' is not assignable to type 'number'.",
      ].join("\n"),
      exitCode: 1,
    });

    expect(diagnostic.runner).toBe("build");
    expect(diagnostic.suggestedRerun || "").not.toContain("vitest run");
  });
});