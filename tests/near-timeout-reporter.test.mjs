/**
 * Guards tests/near-timeout-reporter.mjs — the "warn before a test flakes" reporter
 * registered in vitest.config.mjs.
 *
 * Regression context: this reporter implemented `onFinished(files)`, the vitest <=3
 * reporter hook. Vitest 4 removed `onFinished` from the reporter interface and calls
 * `onTestRunEnd(testModules, unhandledErrors, reason)` instead, so the method was never
 * invoked. Because it still loaded fine and its absence is silent, the reporter had been
 * dead for the whole vitest 4 lifetime: a test measured at 8056ms of a 10000ms budget
 * (80.6%, above the documented 75% threshold) produced no warning at all. Nothing
 * detected that, which is why these tests exist.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import NearTimeoutReporter from "./near-timeout-reporter.mjs";

const require = createRequire(import.meta.url);

function vitestMajorVersion() {
  try {
    return Number.parseInt(require("vitest/package.json").version.split(".")[0], 10);
  } catch {
    return Number.NaN;
  }
}

/** Build the shape vitest passes to onTestRunEnd: [{ task: <file Task> }]. */
function testModule(name, children) {
  const file = { name, tasks: [] };
  const attach = (node, parent) => {
    node.suite = parent;
    for (const child of node.tasks ?? []) attach(child, node);
  };
  for (const child of children) {
    attach(child, file);
    file.tasks.push(child);
  }
  return { task: file };
}

function captureLog(run) {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.flat().join("\n");
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("near-timeout reporter", () => {
  it("implements the hook the installed vitest major actually calls", () => {
    const reporter = new NearTimeoutReporter();
    expect(typeof reporter.onTestRunEnd).toBe("function");

    const major = vitestMajorVersion();
    if (Number.isFinite(major) && major >= 4) {
      // vitest 4 calls onTestRunEnd; onFinished is not part of the interface.
      expect(reporter.onFinished).toBeUndefined();
      expect(NearTimeoutReporter.prototype.onFinished).toBeUndefined();
    }
  });

  it("warns about a passing test at or above the threshold", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([
        testModule("sample.test.mjs", [
          { name: "at risk", result: { state: "pass", duration: 8000 }, timeout: 10000 },
        ]),
      ]);
    });

    expect(out).toContain("Near-timeout warning");
    expect(out).toContain("80%");
    expect(out).toContain("at risk");
  });

  it("stays silent when no test is near its budget", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([
        testModule("sample.test.mjs", [
          { name: "fast", result: { state: "pass", duration: 40 }, timeout: 10000 },
        ]),
      ]);
    });

    expect(out).toBe("");
  });

  it("does not count failing tests, which already report themselves", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([
        testModule("sample.test.mjs", [
          { name: "failed", result: { state: "fail", duration: 9999 }, timeout: 10000 },
        ]),
      ]);
    });

    expect(out).toBe("");
  });

  it("recurses into nested describes", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      // A real suite node carries `tasks`; a real test leaf carries `result` and no `tasks`.
      const leaf = { name: "inner", result: { state: "pass", duration: 9500 }, timeout: 10000 };
      const suite = { name: "outer", tasks: [leaf] };
      reporter.onTestRunEnd([testModule("sample.test.mjs", [suite])]);
    });

    expect(out).toContain("95%");
    expect(out).toContain("outer > inner");
  });

  it("treats a test with no timeout budget (timeout: 0) as not at risk", () => {
    // Vitest encodes "no timeout" as `timeout: 0`, not undefined, so a `??` guard
    // lets 0 through as the denominator and yields Infinity% — which sorts the
    // entry to the top of the warning as the most at-risk test in the run.
    // A test without a budget cannot flake on one, so it must be skipped.
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([
        testModule("sample.test.mjs", [
          { name: "no budget", result: { state: "pass", duration: 413 }, timeout: 0 },
        ]),
      ]);
    });

    expect(out).toBe("");
  });

  it("skips only the zero-timeout test when a sibling has a real budget", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([
        testModule("sample.test.mjs", [
          { name: "no budget", result: { state: "pass", duration: 413 }, timeout: 0 },
          { name: "at risk", result: { state: "pass", duration: 9000 }, timeout: 10000 },
        ]),
      ]);
    });

    expect(out).toContain("90%");
    expect(out).toContain("at risk");
    expect(out).not.toContain("no budget");
    expect(out).not.toContain("Infinity");
  });

  it("survives an empty or missing run", () => {
    const out = captureLog(() => {
      const reporter = new NearTimeoutReporter();
      reporter.onTestRunEnd([]);
      reporter.onTestRunEnd(undefined);
      reporter.onTestRunEnd([{ task: { name: "empty.test.mjs", tasks: [] } }]);
    });

    expect(out).toBe("");
  });
});
