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

test("scopes /api/project-summary to the active workspace like /api/tasks", { timeout: 70000 }, async () => {
  const payload = await runScenario("project-summary-scope", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.ok, true);
  assert.equal(payload.details?.taskCount, 3);
  assert.equal(payload.details?.completedCount, 2);
});

test("blocks /api/tasks/start when can-start guard fails unless force override is set", { timeout: 70000 }, async () => {
  const payload = await runScenario("guarded-start", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.blockedStatus, 409);
  assert.equal(payload.details?.blockedOk, false);
  assert.equal(payload.details?.forcedStatus, 200);
  assert.equal(payload.details?.forcedOk, true);
  assert.equal(payload.details?.executeTaskCalls, 1);
});

test("reports guarded lifecycle start without dispatching execution", { timeout: 70000 }, async () => {
  const payload = await runScenario("guarded-lifecycle", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.ok, true);
  assert.equal(payload.details?.started, false);
  assert.equal(payload.details?.reason, "start_guard_blocked");
  assert.equal(payload.details?.executeTaskCalls, 0);
});

test("includes blocked diagnostics on /api/tasks/detail and counts blocked tasks on /api/tasks", { timeout: 70000 }, async () => {
  const payload = await runScenario("blocked-diagnostics", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.detailOk, true);
  assert.equal(payload.details?.listOk, true);
  assert.equal(payload.details?.blockedCategory, "dependency_blocked");
  assert.equal(payload.details?.stableCause, "api_error_cooldown");
});

test("reads task log diagnostics from bounded monitor-log tails on task detail", { timeout: 70000 }, async () => {
  const payload = await runScenario("log-diagnostics", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.detailOk, true);
  assert.equal(payload.details?.listedStatus, "blocked");
});

test("classifies blocked task rows from workflow-run worktree failure evidence when local logs are quiet", { timeout: 70000 }, async () => {
  const payload = await runScenario("workflow-run-evidence", 65000);
  assert.equal(payload.ok, true);
  assert.equal(payload.details?.listOk, true);
  assert.equal(payload.details?.category, "worktree_failure");
  assert.ok(Number(payload.details?.worktreeFailureCount || 0) > 0);
  assert.equal(payload.details?.runDetailCalls, 0);
  assert.equal(payload.details?.traceCalls, 0);
});
