import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const scenarioScript = resolve(repoRoot, "tests", "fixtures", "ui-server-task-detail-scenarios.mjs");

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

test("includes replayable task runs and a latest run summary on task detail", { timeout: 70000 }, async () => {
  const payload = await runScenario("replayable-task-runs", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.ok, true);
  assert.equal(payload.details?.runId, "run-replay-1");
  assert.equal(payload.details?.replayable, true);
  assert.match(String(payload.details?.latestRunSummary || ""), /Investigated the failure/);
});

test("backfills linked session ids and worktree paths from persistent task sessions", { timeout: 70000 }, async () => {
  const payload = await runScenario("linked-session-backfill", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.ok, true);
  assert.equal(payload.details?.sessionId, "session-linked-task-1");
  assert.equal(payload.details?.primarySessionId, "session-linked-task-1");
  assert.equal(typeof payload.details?.worktreePath, "string");
  assert.ok(payload.details.worktreePath.length > 0);
});

test("preserves stored workflow session links while merging summary metadata without rereading run detail files", { timeout: 70000 }, async () => {
  const payload = await runScenario("workflow-merge", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.ok, true);
  assert.equal(payload.details?.sessionId, "stored-session-1");
  assert.equal(payload.details?.primarySessionId, "derived-session-1");
  assert.equal(payload.details?.runDetailCalls, 0);
  assert.equal(payload.details?.traceCalls, 0);
});
