import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");

test("maintenance sweep reaps stale Bosun helper processes", () => {
  assert.match(
    source,
    /export function classifyBosunHelperProcess\(commandLine\)/,
    "expected helper-process classifier export",
  );
  assert.match(
    source,
    /export function reapStaleBosunHelperProcesses\(maxAgeMs = 15 \* 60 \* 1000, opts = \{\}\)/,
    "expected stale helper-process reaper export",
  );
  assert.match(
    source,
    /function findHelperProcessTreeRoot\(proc, processByPid, cutoff\)/,
    "expected helper-process reaper to resolve orphaned Playwright tree roots",
  );
  assert.match(
    source,
    /ParentProcessId, Name, CommandLine, CreationDate/,
    "expected process enumeration to capture parent PID and process name for tree reaping",
  );
  assert.match(
    source,
    /Stop-Process -Id \$\{Number\(pid\)\} -Force -ErrorAction Stop/,
    "expected Windows kill path to fall back to Stop-Process when taskkill tree termination fails",
  );
  assert.match(
    source,
    /const helperProcessesReaped = reapStaleBosunHelperProcesses\(helperProcessMaxAgeMs, \{\s*skipPids: \[childPid\],\s*\}\);/s,
    "expected runMaintenanceSweep to invoke helper-process reaper",
  );
  assert.match(
    source,
    /stale helper processes/,
    "expected maintenance summary log to include helper-process reaping count",
  );
});
