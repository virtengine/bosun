import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scenarioScript = resolve(repoRoot, "tests", "fixtures", "ui-server-harness-scenarios.mjs");

function runScenario(name, timeoutMs = 60000) {
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

test("runs harness profiles through the API with dry-run, persisted run records, and task-linked history", { timeout: 70000 }, async () => {
  const payload = await runScenario("run-history", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.status, "completed");
  assert.equal(payload.details?.replayOk, true);
  assert.equal(payload.details?.dryRun, true);
  assert.equal(payload.details?.callCount, 7);
});

test("stops active harness runs through the API and persists aborted task history", { timeout: 70000 }, async () => {
  const payload = await runScenario("stop-run", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.stopOk, true);
  assert.equal(payload.details?.stopped, true);
  assert.equal(payload.details?.status, "aborted");
});

test("nudges active harness runs and resolves approval interventions through the API", { timeout: 70000 }, async () => {
  const payload = await runScenario("nudge-approval", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.nudgeOk, true);
  assert.equal(payload.details?.approvalPending, true);
  assert.equal(payload.details?.approvalOk, true);
  assert.equal(payload.details?.runOk, true);
  assert.equal(payload.details?.nudges, 2);
});
