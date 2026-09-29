import { describe, expect, it } from "vitest";
import NearTimeoutReporter from "./near-timeout-reporter.mjs";

/**
 * Regression guard for the vitest 3 -> 4 reporter-hook rename.
 *
 * This reporter was dead in production: it implemented `onFinished(files)`, the
 * vitest <=3 hook. Vitest 4 calls `onTestRunEnd(testModules, ...)` instead and
 * dropped `onFinished` from the reporter interface, so the class was loaded,
 * configured, and never called — the "fix at-risk tests before they flake"
 * guardrail reported nothing at all while still appearing in `reporters:`.
 *
 * These cases pin the vitest 4 hook name AND the vitest 4 result shape, so a
 * future rename fails here loudly instead of silently disabling the guardrail.
 */

/** Build a task node shaped like vitest 4's runner output. */
function task({ type, name, state = "pass", duration, timeout, tasks, suite }) {
  const node = { type, name, mode: "run", result: { state, duration } };
  if (typeof timeout === "number") node.timeout = timeout;
  if (tasks) node.tasks = tasks;
  if (suite) node.suite = suite;
  return node;
}

/** Run a reporter hook and capture everything it prints. */
function collectOutput(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

/** The vitest 4 `onTestRunEnd` payload: TestModules wrapping a file Task. */
function testModulesFor(fileTask) {
  return [{ type: "module", id: "1", task: fileTask }];
}

describe("near-timeout reporter (vitest 4 contract)", () => {
  it("exposes onTestRunEnd, the hook vitest 4 actually calls", () => {
    const reporter = new NearTimeoutReporter();
    expect(typeof reporter.onTestRunEnd).toBe("function");
  });

  it("reports a passing test that consumed more than the warn threshold", () => {
    const reporter = new NearTimeoutReporter();
    const atRisk = task({ type: "test", name: "slow but passing", duration: 9_000, timeout: 10_000 });
    const fileTask = task({
      type: "suite",
      name: "tests/example.test.mjs",
      duration: 9_100,
      tasks: [atRisk],
    });

    const output = collectOutput(() => reporter.onTestRunEnd(testModulesFor(fileTask)));

    expect(output).toContain("Near-timeout warning");
    expect(output).toContain("slow but passing");
    expect(output).toContain("90%");
  });

  it("walks into nested describes and reports a test at depth 2", () => {
    const reporter = new NearTimeoutReporter();
    const deepTest = task({
      type: "test",
      name: "deep passing test",
      duration: 8_500,
      timeout: 10_000,
      suite: { name: "nested", suite: { name: "outer" } },
    });
    const innerSuite = task({ type: "suite", name: "nested", duration: 8_600, tasks: [deepTest] });
    const fileTask = task({
      type: "suite",
      name: "tests/example.test.mjs",
      duration: 8_700,
      tasks: [task({ type: "suite", name: "outer", duration: 8_650, tasks: [innerSuite] })],
    });

    const output = collectOutput(() => reporter.onTestRunEnd(testModulesFor(fileTask)));

    expect(output).toContain("deep passing test");
    expect(output).toContain("outer > nested > deep passing test");
  });

  it("does not report when every test is comfortably inside its budget", () => {
    const reporter = new NearTimeoutReporter();
    const fileTask = task({
      type: "suite",
      name: "tests/example.test.mjs",
      duration: 20,
      tasks: [task({ type: "test", name: "fast test", duration: 20, timeout: 10_000 })],
    });

    const output = collectOutput(() => reporter.onTestRunEnd(testModulesFor(fileTask)));

    expect(output).toBe("");
  });

  it("ignores failing tests (their duration is the timeout, not real work)", () => {
    const reporter = new NearTimeoutReporter();
    const fileTask = task({
      type: "suite",
      name: "tests/example.test.mjs",
      duration: 10_000,
      tasks: [
        task({ type: "test", name: "timed out test", state: "fail", duration: 10_000, timeout: 10_000 }),
      ],
    });

    const output = collectOutput(() => reporter.onTestRunEnd(testModulesFor(fileTask)));

    expect(output).toBe("");
  });

  it("does not stop at a suite carrying an empty tasks array", () => {
    // A test node with `tasks: []` must not be mistaken for a suite and skipped.
    // (`[]` is truthy, so the old existence check silently dropped these tests.)
    const reporter = new NearTimeoutReporter();
    const leaf = task({ type: "test", name: "leaf test", duration: 9_500, timeout: 10_000, tasks: [] });
    const fileTask = task({
      type: "suite",
      name: "tests/example.test.mjs",
      duration: 9_600,
      tasks: [leaf],
    });

    const output = collectOutput(() => reporter.onTestRunEnd(testModulesFor(fileTask)));

    expect(output).toContain("leaf test");
  });

  it("still works through the legacy onFinished hook", () => {
    const reporter = new NearTimeoutReporter();
    const legacyFile = {
      tasks: [task({ type: "test", name: "legacy test", duration: 9_000, timeout: 10_000 })],
    };

    const output = collectOutput(() => reporter.onFinished([legacyFile]));

    expect(output).toContain("legacy test");
  });

  it("tolerates an empty or missing run payload without throwing", () => {
    const reporter = new NearTimeoutReporter();
    expect(() => reporter.onTestRunEnd([])).not.toThrow();
    expect(() => reporter.onTestRunEnd(undefined)).not.toThrow();
    expect(() => reporter.onFinished(undefined)).not.toThrow();
  });
});
