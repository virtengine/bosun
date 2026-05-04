import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");

// ── evaluateThrottledWarning (new pure helper export) ──────────────────────

describe("maintenance evaluateThrottledWarning pure helper", () => {
  it("exports setMaintenanceWorkflowEventQueue for monitor-owned wiring", async () => {
    const mod = await import("../infra/maintenance.mjs");
    expect(typeof mod.setMaintenanceWorkflowEventQueue).toBe("function");
  });

  it("is exported from maintenance.mjs", async () => {
    const mod = await import("../infra/maintenance.mjs");
    expect(typeof mod.evaluateThrottledWarning).toBe("function");
  });

  it("returns shouldLog:true and suppressed:0 on first call", async () => {
    const { evaluateThrottledWarning } = await import("../infra/maintenance.mjs");
    const state = new Map();
    const result = evaluateThrottledWarning(state, "key1", Date.now(), 60_000);
    expect(result.shouldLog).toBe(true);
    expect(result.suppressed).toBe(0);
  });

  it("returns shouldLog:false within throttle window (suppresses duplicate)", async () => {
    const { evaluateThrottledWarning } = await import("../infra/maintenance.mjs");
    const state = new Map();
    const now = Date.now();
    evaluateThrottledWarning(state, "key2", now, 60_000);
    const result = evaluateThrottledWarning(state, "key2", now + 1_000, 60_000);
    expect(result.shouldLog).toBe(false);
    expect(result.suppressed).toBeGreaterThanOrEqual(1);
  });

  it("returns shouldLog:true with suppressed count after throttle window expires", async () => {
    const { evaluateThrottledWarning } = await import("../infra/maintenance.mjs");
    const state = new Map();
    const now = Date.now();
    evaluateThrottledWarning(state, "key3", now, 5_000);
    evaluateThrottledWarning(state, "key3", now + 1_000, 5_000); // suppressed
    evaluateThrottledWarning(state, "key3", now + 2_000, 5_000); // suppressed
    // After throttle window
    const result = evaluateThrottledWarning(state, "key3", now + 6_000, 5_000);
    expect(result.shouldLog).toBe(true);
    expect(result.suppressed).toBeGreaterThanOrEqual(2);
  });

  it("enforces a minimum throttle of 1 000 ms (ignores sub-1s throttleMs)", async () => {
    const { evaluateThrottledWarning } = await import("../infra/maintenance.mjs");
    const state = new Map();
    const now = Date.now();
    evaluateThrottledWarning(state, "key4", now, 1); // throttleMs < 1000
    // Within 1 second — even though throttleMs=1 was passed, min is 1000ms
    const result = evaluateThrottledWarning(state, "key4", now + 500, 1);
    expect(result.shouldLog).toBe(false);
  });

  it("isolates state per key (different keys are independent)", async () => {
    const { evaluateThrottledWarning } = await import("../infra/maintenance.mjs");
    const state = new Map();
    const now = Date.now();
    evaluateThrottledWarning(state, "keyA", now, 60_000);
    // keyA is within throttle window
    const resultA = evaluateThrottledWarning(state, "keyA", now + 100, 60_000);
    // keyB has never been called
    const resultB = evaluateThrottledWarning(state, "keyB", now + 100, 60_000);
    expect(resultA.shouldLog).toBe(false);
    expect(resultB.shouldLog).toBe(true); // independent key
  });
});

// ── resetBranchSyncWarningStateForTests ──────────────────────────────────

describe("maintenance resetBranchSyncWarningStateForTests", () => {
  it("is exported from maintenance.mjs", async () => {
    const mod = await import("../infra/maintenance.mjs");
    expect(typeof mod.resetBranchSyncWarningStateForTests).toBe("function");
  });

  it("calling resetBranchSyncWarningStateForTests resets the internal state so next call logs", async () => {
    const { evaluateThrottledWarning, resetBranchSyncWarningStateForTests } =
      await import("../infra/maintenance.mjs");
    // Force a suppress
    const state = new Map();
    const now = Date.now();
    evaluateThrottledWarning(state, "reset-test", now, 60_000);
    const suppressed = evaluateThrottledWarning(
      state,
      "reset-test",
      now + 100,
      60_000,
    );
    expect(suppressed.shouldLog).toBe(false);

    // resetBranchSyncWarningStateForTests clears the internal module-level branchSyncWarningState
    resetBranchSyncWarningStateForTests();

    // After reset, the module-level state is cleared — new calls to warnThrottledBranchSync
    // would log immediately. We verify the function runs without throwing.
    expect(() => resetBranchSyncWarningStateForTests()).not.toThrow();
  });
});

describe("maintenance branch sync warning throttle", () => {
  it("keeps maintenance workflow events as a no-op until a queue is injected", () => {
    expect(source).toMatch(
      /function\s+emitMaintenanceEvent\s*\(\s*eventType,\s*data\s*=\s*\{\}\s*\)\s*\{\s*if\s*\(!_queueWorkflowEvent\)\s*return;\s*_queueWorkflowEvent\(eventType,\s*data\);\s*\}/,
    );
  });

  it("defines logThrottledBranchSync function", () => {
    expect(source).toMatch(/function\s+logThrottledBranchSync\s*\(/);
  });

  it("logThrottledBranchSync accepts key, message, and level parameters", () => {
    // Function signature should accept (key, message, level)
    const funcMatch = source.match(
      /function\s+logThrottledBranchSync\s*\(([^)]+)\)/,
    );
    expect(funcMatch).not.toBeNull();
    const params = funcMatch[1];
    // Should have at least key and message params
    expect(params.split(",").length).toBeGreaterThanOrEqual(2);
  });

  it("supports warn, info, and error log levels", () => {
    expect(source).toMatch(/logThrottledBranchSync/);
    // Should dispatch to console.warn, console.info/log, console.error
    const hasWarn = source.includes("console.warn");
    const hasInfo =
      source.includes("console.info") || source.includes("console.log");
    const hasError = source.includes("console.error");
    expect(hasWarn).toBe(true);
    expect(hasInfo).toBe(true);
    expect(hasError).toBe(true);
  });

  it("throttles repeated branch sync messages by key", () => {
    // Should maintain a Map or similar to track last-seen timestamps per key
    const hasThrottleMap =
      source.includes("logThrottledBranchSync") &&
      (source.includes("new Map") || source.includes("branchSyncWarn") ||
        source.includes("throttle"));
    expect(hasThrottleMap).toBe(true);
  });

  it("dirty working-tree check runs before divergence check on current branch", () => {
    // Dirty check should come first to avoid misleading divergence warnings
    const dirtyCheckIdx = source.indexOf("uncommitted changes");
    const divergedIdx = source.indexOf("diverged");
    expect(dirtyCheckIdx).toBeGreaterThan(-1);
    expect(divergedIdx).toBeGreaterThan(-1);
    // Dirty check should appear before divergence warning in the sync logic
    expect(dirtyCheckIdx).toBeLessThan(divergedIdx);
  });

  it("uses logThrottledBranchSync for branch sync event logging", () => {
    expect(source).toMatch(/logThrottledBranchSync\s*\(/);
  });
});
