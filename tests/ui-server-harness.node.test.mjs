import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { testTimeout } from "./timeout-helper.mjs";

// Linux-baseline timeouts; testTimeout() applies the platform multiplier (5x on
// win32 by default, overridable with BOSUN_TEST_TIMEOUT_MULTIPLIER) per
// tests/AGENTS.md "Anti-Flake Conventions -> Timeouts". Do NOT hardcode raw
// millisecond literals here and do NOT branch on process.platform in this file.
//
// Each value is a per-scenario Linux baseline measured standalone on 2026-10-01
// (run-history 24s, stop-run 14s, nudge-approval 8s) plus headroom for a loaded
// runner. Under the node test runner the same scenarios measured 17-38s on
// Windows, so a flat 60s budget left the slowest test with no margin at all; the
// multiplier is the mechanism the repo already chose for that headroom.
//
// The child (execFile) budget stays strictly below its test budget so a hung
// scenario fails with a scenario-level timeout instead of being masked by the
// runner killing the whole test.
const SCENARIO_TIMEOUTS_MS = {
  "run-history": testTimeout(30_000),
  "stop-run": testTimeout(20_000),
  "nudge-approval": testTimeout(15_000),
};

const TEST_TIMEOUT_MS = testTimeout(40_000);

const repoRoot = process.cwd();
const scenarioScript = resolve(repoRoot, "tests", "fixtures", "ui-server-harness-scenarios.mjs");

function runScenario(name) {
  const timeoutMs = SCENARIO_TIMEOUTS_MS[name];
  if (!timeoutMs) throw new Error(`No timeout budget declared for scenario ${name}`);
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [scenarioScript, name],
      {
        cwd: repoRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Scenario ${name} failed: ${error.message}\n${stderr || stdout}`));
          return;
        }
        const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
        const payload = lines.length ? JSON.parse(lines.at(-1)) : {};
        resolvePromise(payload);
      },
    );
  });
}

test("runs harness profiles through the API with dry-run, persisted run records, and task-linked history", { timeout: TEST_TIMEOUT_MS }, async () => {
  const payload = await runScenario("run-history");
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.status, "completed");
  assert.equal(payload.details?.replayOk, true);
  assert.equal(payload.details?.dryRun, true);
  assert.equal(payload.details?.callCount, 7);
});

test("stops active harness runs through the API and persists aborted task history", { timeout: TEST_TIMEOUT_MS }, async () => {
  const payload = await runScenario("stop-run");
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.stopOk, true);
  assert.equal(payload.details?.stopped, true);
  assert.equal(payload.details?.status, "aborted");
});

test("nudges active harness runs and resolves approval interventions through the API", { timeout: TEST_TIMEOUT_MS }, async () => {
  const payload = await runScenario("nudge-approval");
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.nudgeOk, true);
  assert.equal(payload.details?.approvalPending, true);
  assert.equal(payload.details?.approvalOk, true);
  assert.equal(payload.details?.runOk, true);
  assert.equal(payload.details?.nudges, 2);
});
