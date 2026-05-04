import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

test("self restart watcher includes lib directory", () => {
  assert.match(src, /let selfWatcherLib = null;/);
  assert.match(src, /let selfWatcherMtimes = new Map\(\);/);
  assert.match(src, /const libDir = resolve\(__dirname, "lib"\);/);
  assert.match(src, /selfWatcherLib = watch\(libDir, \{ persistent: true \}, handleSourceChange\);/);
  assert.match(src, /const watchedDirs = \["infra\/", "infra\/lib\/"\];/);
  assert.match(src, /console\.log\(`\[monitor\] watching source files for self-restart: \$\{watchedDirs\.join\(", "\)\}`\);/);
});

test("self restart watcher snapshots mtimes and logs repo-relative changed paths", () => {
  assert.match(src, /function snapshotSelfWatcherDirMtimes\(rootDir\)/);
  assert.match(src, /function resolveSelfWatcherChangedPath\(filename, watchedRoots = \[\]\)/);
  assert.match(src, /function formatSelfWatcherLabel\(filePath\)/);
  assert.match(src, /const prevMtime = Number\(selfWatcherMtimes\.get\(fullPath\) \|\| 0\);/);
  assert.match(src, /if \(newMtime <= prevMtime\) \{/);
  assert.match(src, /const restartLabel = formatSelfWatcherLabel\(fullPath\);/);
  assert.match(src, /queueSelfRestart\(restartLabel\);/);
});

test("monitor schedules periodic stale helper-process reaping", () => {
  assert.match(src, /reapStaleBosunHelperProcesses/);
  assert.match(src, /const HELPER_PROCESS_REAP_INTERVAL_MS = Math\.max\(/);
  assert.match(src, /const HELPER_PROCESS_MAX_AGE_MS = Math\.max\(/);
  assert.match(
    src,
    /safeSetInterval\("helper-process-reaper", \(\) => \{\s*try \{\s*reapStaleBosunHelperProcesses\(HELPER_PROCESS_MAX_AGE_MS\);/s,
  );
});
