import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("workspace sync warnings include sample context and benign downgrade path", () => {
  const src = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
  assert.match(src, /function isBenignWorkspaceSyncFailure\(errorText\)/);
  assert.match(src, /function shouldEmitWorkspaceSyncWarn\(key, now = Date\.now\(\)\)/);
  assert.match(src, /function clearWorkspaceSyncWarnForWorkspace\(workspaceId\)/);
  assert.match(src, /function stopWorkspaceSyncTimers\(\)/);
  assert.match(src, /WORKSPACE_SYNC_INTERVAL_MS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_INTERVAL_MS/);
  assert.match(src, /WORKSPACE_SYNC_INITIAL_DELAY_MS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_INITIAL_DELAY_MS/);
  assert.match(src, /WORKSPACE_SYNC_INITIAL_JITTER_MS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_INITIAL_JITTER_MS/);
  assert.match(src, /WORKSPACE_SYNC_WARN_THROTTLE_MS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_WARN_THROTTLE_MS/);
  assert.match(src, /WORKSPACE_SYNC_SLOW_WARN_MS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_SLOW_WARN_MS/);
  assert.match(src, /WORKSPACE_SYNC_WARN_MAX_KEYS = parseEnvInteger\(/);
  assert.match(src, /BOSUN_WORKSPACE_SYNC_WARN_MAX_KEYS/);
  assert.match(src, /let workspaceSyncInFlight = false/);
  assert.match(src, /workspace sync: previous run still in progress — skipping overlap/);
  assert.match(src, /if \(shuttingDown\) return;/);
  assert.match(src, /workspaceSyncInitialTimer = safeSetTimeout\("workspace-sync-initial", \(\) =>/);
  assert.match(src, /workspaceSyncTimer = safeSetInterval\(\s*"workspace-sync-cycle",\s*doWorkspaceSync,\s*WORKSPACE_SYNC_INTERVAL_MS,\s*\)/);
  assert.match(src, /workspaceSyncInitialJitterMs =/);
  assert.match(src, /workspaceSyncInitialDelayEffectiveMs = Math\.max\(/);
  assert.match(src, /initial run in \$\{Math\.round\(workspaceSyncInitialDelayEffectiveMs \/ 1000\)\}s \(base=\$\{Math\.round\(WORKSPACE_SYNC_INITIAL_DELAY_MS \/ 1000\)\}s, jitter<=\$\{Math\.round\(WORKSPACE_SYNC_INITIAL_JITTER_MS \/ 1000\)\}s\)/);
  assert.match(src, /workspace sync: warn-throttle=\$\{Math\.round\(WORKSPACE_SYNC_WARN_THROTTLE_MS \/ 60000\)\}m slow-threshold=\$\{Math\.round\(WORKSPACE_SYNC_SLOW_WARN_MS \/ 1000\)\}s max-warn-keys=\$\{WORKSPACE_SYNC_WARN_MAX_KEYS\}/);
  assert.match(src, /warn-throttle \(\$\{Math\.round\(WORKSPACE_SYNC_WARN_THROTTLE_MS \/ 1000\)\}s\) is below interval \(\$\{Math\.round\(WORKSPACE_SYNC_INTERVAL_MS \/ 1000\)\}s\)/);
  assert.match(src, /slow-threshold \(\$\{Math\.round\(WORKSPACE_SYNC_SLOW_WARN_MS \/ 1000\)\}s\) is >= interval \(\$\{Math\.round\(WORKSPACE_SYNC_INTERVAL_MS \/ 1000\)\}s\)/);
  assert.match(src, /effective initial-delay \(\$\{Math\.round\(workspaceSyncInitialDelayEffectiveMs \/ 1000\)\}s\) is >= interval \(\$\{Math\.round\(WORKSPACE_SYNC_INTERVAL_MS \/ 1000\)\}s\)/);
  assert.match(src, /stopWorkspaceSyncTimers\(\);/);
  assert.match(
    src,
    /workspace sync: \$\{nonBenignFailed\.length\} repo\(s\) failed in \$\{wsId\}\$\{benignSuffix\}\$\{repoLabel\} \(sample: \$\{snippet \|\| "unknown error"\}\)/,
  );
  assert.match(src, /workspace sync: \$\{nonBenignFailed\.length\} repo\(s\) failed in \$\{wsId\}\$\{benignSuffix\}\$\{repoLabel\} \(duplicate warning suppressed\)/);
  assert.match(src, /workspace sync: \$\{wsId\} skipped \$\{failed\.length\} repo\(s\) with local changes/);
  assert.match(src, /clearWorkspaceSyncWarnForWorkspace\(wsId\);/);
  assert.match(src, /workspace sync failed for \$\{wsId\} \(duplicate warning suppressed\)/);
  assert.match(src, /let workspaceExceptionCount = 0/);
  assert.match(src, /let nonBenignFailedRepoCount = 0/);
  assert.match(src, /let benignFailedRepoCount = 0/);
  assert.match(src, /benignFailedRepoCount \+= benignFailed\.length/);
  assert.match(src, /nonBenignFailedRepoCount \+= nonBenignFailed\.length/);
  assert.match(src, /workspaceExceptionCount \+= 1/);
  assert.match(src, /workspace sync: cycle complete \(/);
  assert.match(src, /non-benign, \$\{benignFailedRepoCount\} benign, \$\{workspaceExceptionCount\} exception\(s\), \$\{Math\.round\(durationMs \/ 1000\)\}s\)/);
  assert.match(src, /workspace sync: all repos failed this cycle \(\$\{nonBenignFailedRepoCount\}\/\$\{repoCount\}\)/);
  assert.match(src, /workspace sync: \$\{workspaceExceptionCount\} workspace exception\(s\) this cycle/);
  assert.match(src, /workspace sync: all workspaces raised exceptions this cycle \(\$\{workspaceExceptionCount\}\/\$\{workspaceCount\}\)/);
  assert.match(src, /workspace sync: no repos processed across \$\{workspaceCount\} workspace\(s\) this cycle/);
  assert.match(src, /\[slow>=\$\{Math\.round\(WORKSPACE_SYNC_SLOW_WARN_MS \/ 1000\)\}s\]/);
  assert.match(src, /for \(const \[seenKey, seenAt\] of workspaceSyncWarnSeen\.entries\(\)\) \{/);
  assert.match(src, /now - Number\(seenAt \|\| 0\) >= WORKSPACE_SYNC_WARN_THROTTLE_MS/);
  assert.match(src, /workspaceSyncWarnSeen\.size > WORKSPACE_SYNC_WARN_MAX_KEYS/);
  assert.doesNotMatch(src, /workspace sync: \$\{failed\.length\} repo\(s\) failed in \$\{wsId\}/);
});

test("workspace manager pull failure prefers stderr/stdout details", () => {
  const src = readFileSync(resolve(process.cwd(), "workspace/workspace-manager.mjs"), "utf8");
  assert.match(src, /const stderr = normalizeSingleLine\(err\?\.stderr \|\| ""\)/);
  assert.match(src, /const stdout = normalizeSingleLine\(err\?\.stdout \|\| ""\)/);
  assert.match(src, /const message = normalizeSingleLine\(err\?\.message \|\| err \|\| ""\)/);
  assert.match(src, /err\?\.stderr \|\| err\?\.stdout \|\| err\?\.message/);
  assert.match(src, /git pull --no-rebase failed/);
  assert.match(src, /function buildGitPullFailureDetails\(err, repoPath, childProcess\)/);
  assert.match(src, /status=\$\{err\.status\}/);
  assert.match(src, /signal=\$\{err\.signal\}/);
  assert.match(src, /code=\$\{err\.code\}/);
  assert.match(src, /git status --porcelain --branch/);
  assert.match(src, /\| git status:/);
});
