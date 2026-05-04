/**
 * maintenance.mjs - Process hygiene and cleanup for bosun.
 *
 * Handles:
 *  - Killing stale orchestrator processes from previous runs
 *  - Reaping stuck git push processes (>5 min)
 *  - Pruning broken/orphaned git worktrees
 *  - Monitor singleton enforcement via PID file
 *  - Periodic maintenance sweeps
 */

import { execSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  pruneStaleWorktrees,
  getWorktreeStats,
  fixGitConfigCorruption,
} from "../workspace/worktree-manager.mjs";

const isWindows = process.platform === "win32";

// ── Workflow event bridge ─────────────────────────────────────────────────
// The daemon injects its workflow-event queue. Standalone callers must not
// import monitor.mjs just to emit best-effort events.
let _queueWorkflowEvent = null;
export function setMaintenanceWorkflowEventQueue(queueFn) {
  _queueWorkflowEvent = typeof queueFn === "function" ? queueFn : null;
}
function emitMaintenanceEvent(eventType, data = {}) {
  if (!_queueWorkflowEvent) return;
  _queueWorkflowEvent(eventType, data);
}
const BRANCH_SYNC_LOG_THROTTLE_MS = Math.max(
  5_000,
  Number(process.env.BRANCH_SYNC_LOG_THROTTLE_MS || "300000") || 300000,
);
const MAINTENANCE_WARNING_THROTTLE_MS = BRANCH_SYNC_LOG_THROTTLE_MS;
const branchSyncLogState = new Map();
const branchSyncWarningState = new Map();

/**
 * Pure throttle-state evaluator.
 *
 * @param {Map} state - Mutable Map tracking { lastLoggedAt, suppressed } per key.
 * @param {string} key - Throttle bucket key.
 * @param {number} nowMs - Current epoch milliseconds.
 * @param {number} throttleMs - Throttle window; minimum clamped to 1 000 ms.
 * @returns {{ shouldLog: boolean, suppressed: number }}
 */
export function evaluateThrottledWarning(state, key, nowMs, throttleMs) {
  const normalizedKey = String(key || "default").trim() || "default";
  const effectiveThrottle = Math.max(1_000, Number(throttleMs) || 1_000);
  const entry = state.get(normalizedKey) || { lastLoggedAt: 0, suppressed: 0 };

  if (entry.lastLoggedAt > 0 && nowMs - entry.lastLoggedAt < effectiveThrottle) {
    const next = { lastLoggedAt: entry.lastLoggedAt, suppressed: entry.suppressed + 1 };
    state.set(normalizedKey, next);
    return { shouldLog: false, suppressed: next.suppressed };
  }

  const suppressed = entry.suppressed;
  state.set(normalizedKey, { lastLoggedAt: nowMs, suppressed: 0 });
  return { shouldLog: true, suppressed };
}

/**
 * Reset the module-level branchSyncWarningState map. Intended for test isolation only.
 */
export function resetBranchSyncWarningStateForTests() {
  branchSyncWarningState.clear();
}

/**
 * Emit a throttled branch-sync warning using the module-level warning state.
 */
function warnThrottledBranchSync(key, message) {
  const { shouldLog, suppressed } = evaluateThrottledWarning(
    branchSyncWarningState,
    key,
    Date.now(),
    MAINTENANCE_WARNING_THROTTLE_MS,
  );
  if (!shouldLog) return;
  const suffix =
    suppressed > 0
      ? ` (suppressed ${suppressed} similar message(s) in last ${Math.round(MAINTENANCE_WARNING_THROTTLE_MS / 1000)}s)`
      : "";
  console.warn(`${message}${suffix}`);
}

/**
 * Clear the throttle state for a given branch-sync warning key (e.g. on clean path).
 */
function clearBranchSyncWarning(key) {
  const normalizedKey = String(key || "default").trim() || "default";
  branchSyncWarningState.delete(normalizedKey);
}

function logThrottledBranchSync(
  key,
  message,
  levelOrOptions = {},
) {
  const options = typeof levelOrOptions === "string"
    ? { level: levelOrOptions }
    : (levelOrOptions || {});
  const {
    level = "warn",
    throttleMs = BRANCH_SYNC_LOG_THROTTLE_MS,
  } = options;
  const normalizedKey = String(key || "default").trim() || "default";
  const now = Date.now();
  const state = branchSyncLogState.get(normalizedKey) || {
    lastLoggedAt: 0,
    suppressed: 0,
  };

  if (
    state.lastLoggedAt > 0 &&
    now - state.lastLoggedAt < Math.max(1_000, Number(throttleMs) || BRANCH_SYNC_LOG_THROTTLE_MS)
  ) {
    state.suppressed += 1;
    branchSyncLogState.set(normalizedKey, state);
    return;
  }

  const suppressed = state.suppressed || 0;
  const suffix =
    suppressed > 0
      ? ` (suppressed ${suppressed} similar message(s) in last ${Math.round(
          Math.max(1_000, Number(throttleMs) || BRANCH_SYNC_LOG_THROTTLE_MS) / 1000,
        )}s)`
      : "";
  const line = `${message}${suffix}`;

  const isConsoleLogLevel = level === "info" || level === "log";
  if (level === "error") {
    console.error(line);
  } else if (level === "info") {
    console.log(line);
  } else if (isConsoleLogLevel) {
    console.log(line);
  } else {
    console.warn(line);
  }

  branchSyncLogState.set(normalizedKey, {
    lastLoggedAt: now,
    suppressed: 0,
  });
}

/**
 * Get all running processes matching a filter.
 * Returns [{pid, parentPid, name, commandLine, creationDate}].
 */
function getProcesses(filter) {
  if (!isWindows) {
    // Linux/macOS: use ps
    try {
      const out = execSync(`ps -eo pid,ppid,comm,lstart,args 2>/dev/null`, {
        encoding: "utf8",
        timeout: 10000,
      });
      const lines = out.trim().split("\n").slice(1);
      return lines
        .map((line) => {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+?\d{4})\s+(.+)$/);
          if (!m) return null;
          return {
            pid: Number(m[1]),
            parentPid: Number(m[2]),
            name: m[3],
            creationDate: new Date(m[4]),
            commandLine: m[5],
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // Windows: use PowerShell to get process info (WMI is more reliable for CommandLine)
  try {
    const cmd = `Get-CimInstance Win32_Process ${filter ? `-Filter "${filter}"` : ""} | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate | ConvertTo-Json -Compress`;
    const out = spawnSync("powershell", ["-NoProfile", "-Command", cmd], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (out.status !== 0 || !out.stdout.trim()) return [];
    const parsed = JSON.parse(out.stdout);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((p) => p && p.ProcessId)
      .map((p) => ({
        pid: p.ProcessId,
        parentPid: p.ParentProcessId || 0,
        name: p.Name || "",
        commandLine: p.CommandLine || "",
        creationDate: p.CreationDate
          ? new Date(p.CreationDate.replace(/\/Date\((\d+)\)\//, "$1") * 1)
          : null,
      }));
  } catch {
    return [];
  }
}

/**
 * Kill a process by PID with force.
 */
function killPid(pid, label, opts = {}) {
  const tree = opts?.tree === true;
  try {
    if (isWindows) {
      let result = null;
      if (tree) {
        const args = ["/F", "/T", "/PID", String(pid)];
        result = spawnSync("taskkill", args, {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
      }
      if (!result || result.status !== 0) {
        result = spawnSync("powershell", [
          "-NoProfile",
          "-Command",
          `Stop-Process -Id ${Number(pid)} -Force -ErrorAction Stop`,
        ], {
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
      }
      if (result.status !== 0) {
        const errorText = String(result.stderr || result.stdout || "").trim();
        throw new Error(errorText || `Windows process kill failed for PID ${pid}`);
      }
    } else {
      process.kill(pid, "SIGKILL");
    }
    console.log(`[maintenance] killed ${label || "process"} (PID ${pid})`);
    return true;
  } catch (e) {
    // Process may already be gone
    if (e.code !== "ESRCH") {
      console.warn(`[maintenance] failed to kill PID ${pid}: ${e.message}`);
    }
    return false;
  }
}

const BOSUN_PROBE_NODE_MARKERS = [
  "starttelegramuiserver({ port: 0",
  "skipinstancelock: true",
  "skipautoopen: true",
];
const BOSUN_PROBE_IMPORT_MARKERS = [
  "import('./server/ui-server.mjs')",
  "import(\"./server/ui-server.mjs\")",
  "import('playwright')",
  "import(\"playwright\")",
  "chromium.launch({ headless: true })",
];
const PLAYWRIGHT_PROFILE_MARKERS = [
  "playwright_chromiumdev_profile-",
  "playwright_firefoxdev_profile-",
  "playwright_webkitdev_profile-",
];
const HELPER_TREE_PROCESS_NAMES = new Set([
  "node",
  "node.exe",
  "chrome",
  "chrome.exe",
  "msedge",
  "msedge.exe",
  "firefox",
  "firefox.exe",
  "webkit",
  "webkit.exe",
]);

export function classifyBosunHelperProcess(commandLine) {
  const normalized = String(commandLine || "").trim().toLowerCase().replace(/\\/g, "/");
  if (!normalized) return null;

  const looksLikeBosunUiProbe =
    normalized.includes("node") &&
    BOSUN_PROBE_NODE_MARKERS.every((marker) => normalized.includes(marker)) &&
    BOSUN_PROBE_IMPORT_MARKERS.some((marker) => normalized.includes(marker));
  if (looksLikeBosunUiProbe) return "bosun-ui-probe";

  const looksLikePlaywrightBrowser =
    (normalized.includes("chrome.exe") || normalized.includes("msedge.exe") || normalized.includes("firefox")) &&
    PLAYWRIGHT_PROFILE_MARKERS.some((marker) => normalized.includes(marker));
  if (looksLikePlaywrightBrowser) return "playwright-browser";

  return null;
}

function isHelperTreeAncestorProcess(proc, cutoff) {
  const name = String(proc?.name || "").trim().toLowerCase();
  if (!HELPER_TREE_PROCESS_NAMES.has(name)) return false;
  const createdAtMs = proc?.creationDate?.getTime?.() || NaN;
  return Number.isFinite(createdAtMs) && createdAtMs < cutoff;
}

function findHelperProcessTreeRoot(proc, processByPid, cutoff) {
  let target = proc;
  const visited = new Set([Number(proc?.pid) || 0]);

  while (true) {
    const parentPid = Number(target?.parentPid || 0);
    if (!parentPid || visited.has(parentPid)) break;
    const parent = processByPid.get(parentPid);
    if (!parent || !isHelperTreeAncestorProcess(parent, cutoff)) break;
    target = parent;
    visited.add(parentPid);
  }

  return target;
}

export function reapStaleBosunHelperProcesses(maxAgeMs = 15 * 60 * 1000, opts = {}) {
  const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 15 * 60 * 1000);
  const skipPids = new Set(
    [process.pid, ...(Array.isArray(opts.skipPids) ? opts.skipPids : [])]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  );
  const filterName = isWindows
    ? "Name='node.exe' OR Name='chrome.exe' OR Name='msedge.exe' OR Name='firefox.exe'"
    : null;
  const procs = getProcesses(filterName);
  const processByPid = new Map(
    procs
      .map((proc) => [Number(proc?.pid || 0), proc])
      .filter(([pid]) => Number.isFinite(pid) && pid > 0),
  );
  const reapedTargetPids = new Set();
  let killed = 0;

  for (const p of procs) {
    if (skipPids.has(Number(p.pid))) continue;
    const classification = classifyBosunHelperProcess(p.commandLine || "");
    if (!classification) continue;
    const createdAtMs = p.creationDate?.getTime?.() || NaN;
    if (!Number.isFinite(createdAtMs) || createdAtMs >= cutoff) continue;

    const target =
      classification === "playwright-browser"
        ? findHelperProcessTreeRoot(p, processByPid, cutoff)
        : p;
    const targetPid = Number(target?.pid || p.pid);
    if (!Number.isFinite(targetPid) || targetPid <= 0) continue;
    if (skipPids.has(targetPid) || reapedTargetPids.has(targetPid)) continue;

    if (killPid(targetPid, classification, { tree: true })) {
      reapedTargetPids.add(targetPid);
      killed++;
    }
  }

  if (killed > 0) {
    console.log(`[maintenance] reaped ${killed} stale Bosun helper process(es)`);
  }
  return killed;
}

/**
 * Kill stale orchestrator processes (pwsh running orchestrator.ps1).
 * Skips our own child if childPid is provided.
 */
export function killStaleOrchestrators(childPid) {
  const myPid = process.pid;
  const procs = getProcesses("Name='pwsh.exe'");
  let killed = 0;

  for (const p of procs) {
    if (p.pid === myPid || p.pid === childPid) continue;
    if (p.commandLine && p.commandLine.includes("orchestrator.ps1")) {
      killPid(p.pid, "stale orchestrator");
      killed++;
    }
  }

  if (killed > 0) {
    console.log(
      `[maintenance] killed ${killed} stale orchestrator process(es)`,
    );
  }
  return killed;
}

/**
 * Kill git push processes that have been running longer than maxAgeMs.
 * Default: 5 minutes. These get stuck on network issues or lock contention.
 */
export function reapStuckGitPushes(maxAgeMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  const filterName = isWindows
    ? "Name='pwsh.exe' OR Name='git.exe' OR Name='bash.exe'"
    : null;
  const procs = getProcesses(filterName);
  let killed = 0;

  for (const p of procs) {
    if (!p.commandLine) continue;
    // Match git push commands (direct or via pwsh/bash wrappers)
    const isGitPush =
      p.commandLine.includes("git push") ||
      p.commandLine.includes("git.exe push");
    if (!isGitPush) continue;

    // Check age
    if (p.creationDate && p.creationDate.getTime() < cutoff) {
      killPid(
        p.pid,
        `stuck git push (age ${Math.round((Date.now() - p.creationDate.getTime()) / 60000)}min)`,
      );
      killed++;
    }
  }

  if (killed > 0) {
    console.log(`[maintenance] reaped ${killed} stuck git push process(es)`);
  }
  return killed;
}

/**
 * Prune broken git worktrees and remove orphaned temp directories.
 */
export function cleanupWorktrees(repoRoot) {
  let pruned = 0;

  // 1. `git worktree prune` removes entries whose directories no longer exist
  try {
    spawnSync("git", ["worktree", "prune"], {
      cwd: repoRoot,
      timeout: 15000,
      windowsHide: true,
    });
    console.log("[maintenance] git worktree prune completed");
    pruned++;
  } catch (e) {
    console.warn(`[maintenance] git worktree prune failed: ${e.message}`);
  }

  // 2. List remaining worktrees and check for stale temp ones
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (result.stdout) {
      const entries = result.stdout.split(/\n\n/).filter(Boolean);
      for (const entry of entries) {
        const pathMatch = entry.match(/^worktree\s+(.+)/m);
        if (!pathMatch) continue;
        const wtPath = pathMatch[1].trim();
        // Only touch orphaned temp worktrees
        if (wtPath === repoRoot) continue;
        if (!wtPath.includes("copilot-worktree")) continue;
        // Check if the path exists on disk
        if (!existsSync(wtPath)) {
          console.log(
            `[maintenance] removing orphaned worktree entry: ${wtPath}`,
          );
          try {
            spawnSync("git", ["worktree", "remove", "--force", wtPath], {
              cwd: repoRoot,
              timeout: 10000,
              windowsHide: true,
            });
            pruned++;
          } catch {
            /* best effort */
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[maintenance] worktree list check failed: ${e.message}`);
  }

  // 3. Clean up old copilot-worktree entries (older than 7 days)
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (result.stdout) {
      const entries = result.stdout.split(/\n\n/).filter(Boolean);
      for (const entry of entries) {
        const pathMatch = entry.match(/^worktree\s+(.+)/m);
        if (!pathMatch) continue;
        const wtPath = pathMatch[1].trim();
        if (wtPath === repoRoot) continue;
        // copilot-worktree-YYYY-MM-DD format
        const dateMatch = wtPath.match(/copilot-worktree-(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) continue;
        const wtDate = new Date(dateMatch[1]);
        const ageMs = Date.now() - wtDate.getTime();
        if (ageMs > 7 * 24 * 60 * 60 * 1000) {
          console.log(`[maintenance] removing old copilot worktree: ${wtPath}`);
          try {
            spawnSync("git", ["worktree", "remove", "--force", wtPath], {
              cwd: repoRoot,
              timeout: 15000,
              windowsHide: true,
            });
            pruned++;
          } catch {
            /* best effort */
          }
        }
      }
    }
  } catch {
    /* best effort */
  }

  return pruned;
}

// ── Stale Branch Cleanup ────────────────────────────────────────────────

/**
 * Clean up old local branches created by codex/bosun automation.
 *
 * Targets branches matching `ve/*` and `copilot-worktree-*` patterns.
 *
 * Safety checks before deleting a branch:
 *  1. Not the currently checked-out branch
 *  2. Not checked out in any active worktree
 *  3. Has a corresponding remote branch (was pushed) OR has been merged
 *  4. Local and remote refs match (no unpushed local commits)
 *  5. Last commit is older than `minAgeMs` (default 24 hours)
 *
 * @param {string} repoRoot - repository root path
 * @param {object} [opts]
 * @param {number}  [opts.minAgeMs=86400000] - minimum age in ms (default 24h)
 * @param {boolean} [opts.dryRun=false] - if true, log but don't delete
 * @param {string[]} [opts.protectedBranches] - branches to never delete (default: ["main","mainnet/main"])
 * @param {string[]} [opts.patterns] - branch glob prefixes to target (default: ["ve/","copilot-worktree-"])
 * @returns {{ deleted: string[], skipped: { branch: string, reason: string }[], errors: string[] }}
 */
export function cleanupStaleBranches(repoRoot, opts = {}) {
  const {
    minAgeMs = 24 * 60 * 60 * 1000,
    dryRun = false,
    protectedBranches = ["main", "mainnet/main"],
    patterns = ["ve/", "copilot-worktree-"],
  } = opts;

  const result = { deleted: [], skipped: [], errors: [] };
  if (!repoRoot) return result;

  // 1. Get currently checked-out branch
  let currentBranch = null;
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status === 0) currentBranch = r.stdout.trim();
  } catch {
    /* best effort */
  }

  // 2. Get branches checked out in worktrees (cannot delete these)
  const worktreeBranches = new Set();
  try {
    const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout) {
      for (const entry of r.stdout.split(/\n\n/).filter(Boolean)) {
        const branchMatch = entry.match(/^branch\s+refs\/heads\/(.+)/m);
        if (branchMatch) worktreeBranches.add(branchMatch[1]);
      }
    }
  } catch {
    /* best effort */
  }

  // 3. List all local branches
  let localBranches;
  try {
    const r = spawnSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      { cwd: repoRoot, encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    if (r.status !== 0 || !r.stdout) return result;
    localBranches = r.stdout.trim().split("\n").filter(Boolean);
  } catch (e) {
    result.errors.push(`Failed to list branches: ${e.message}`);
    return result;
  }

  // 4. Filter to target patterns only
  const targetBranches = localBranches.filter((b) =>
    patterns.some((p) => b.startsWith(p)),
  );

  if (targetBranches.length === 0) return result;

  const cutoff = Date.now() - minAgeMs;

  for (const branch of targetBranches) {
    // Skip protected branches
    if (protectedBranches.includes(branch)) {
      result.skipped.push({ branch, reason: "protected" });
      continue;
    }

    // Skip currently checked-out branch
    if (branch === currentBranch) {
      result.skipped.push({ branch, reason: "checked-out" });
      continue;
    }

    // Skip branches checked out in worktrees
    if (worktreeBranches.has(branch)) {
      result.skipped.push({ branch, reason: "active-worktree" });
      continue;
    }

    // Check last commit date
    try {
      const dateResult = spawnSync(
        "git",
        ["log", "-1", "--format=%ct", branch],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      if (dateResult.status !== 0 || !dateResult.stdout.trim()) {
        result.skipped.push({ branch, reason: "no-commit-date" });
        continue;
      }
      const commitEpoch = parseInt(dateResult.stdout.trim(), 10) * 1000;
      if (commitEpoch > cutoff) {
        result.skipped.push({ branch, reason: "too-recent" });
        continue;
      }
    } catch {
      result.skipped.push({ branch, reason: "date-check-failed" });
      continue;
    }

    // Check if remote tracking branch exists and is in sync
    const remoteRef = `origin/${branch}`;
    const remoteExists = spawnSync(
      "git",
      ["rev-parse", "--verify", `refs/remotes/${remoteRef}`],
      { cwd: repoRoot, timeout: 5000, windowsHide: true },
    );

    if (remoteExists.status === 0) {
      // Remote exists — check if local is ahead (unpushed commits)
      const aheadCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${remoteRef}..${branch}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const ahead = parseInt(aheadCheck.stdout?.trim(), 10) || 0;
      if (ahead > 0) {
        result.skipped.push({ branch, reason: "unpushed-commits" });
        continue;
      }
    } else {
      // No remote — check if merged into main (safe to delete if merged)
      const mergedCheck = spawnSync(
        "git",
        ["branch", "--merged", "main", "--list", branch],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const isMerged = mergedCheck.stdout?.trim() === branch;
      if (!isMerged) {
        result.skipped.push({ branch, reason: "not-pushed-not-merged" });
        continue;
      }
    }

    // All checks passed — delete the branch
    if (dryRun) {
      console.log(`[maintenance] would delete stale branch: ${branch}`);
      result.deleted.push(branch);
    } else {
      try {
        const del = spawnSync("git", ["branch", "-D", branch], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        });
        if (del.status === 0) {
          console.log(`[maintenance] deleted stale branch: ${branch}`);
          result.deleted.push(branch);
        } else {
          const err = (del.stderr || del.stdout || "").trim();
          result.errors.push(`${branch}: ${err}`);
        }
      } catch (e) {
        result.errors.push(`${branch}: ${e.message}`);
      }
    }
  }

  if (result.deleted.length > 0) {
    console.log(
      `[maintenance] branch cleanup: ${result.deleted.length} deleted, ${result.skipped.length} skipped, ${result.errors.length} errors`,
    );
  }

  return result;
}

// ── Monitor Singleton via PID file ──────────────────────────────────────

const PID_FILE_NAME = "bosun.pid";
const MONITOR_MARKER = "bosun/monitor.mjs";
const MONITOR_SCRIPT_SEGMENT_RE =
  /(?:^|[\/\s"'=])monitor\.mjs(?=$|[?#/\s"'`),;:])/;
const JS_MONITOR_LAUNCHER_RE = /\b(node(?:\.exe)?|bun|tsx|deno)\b/;
const MONITOR_EVAL_IMPORT_RE =
  /(import|require)\s*\(\s*["'`][^"'`]*monitor\.mjs[^"'`]*["'`]\s*\)/;

function hasMonitorSubcommandInvocation(commandLine) {
  const normalized = String(commandLine || "").toLowerCase().replace(/\\/g, "/");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  let sawMonitorScript = false;
  for (const token of tokens) {
    if (!sawMonitorScript) {
      if (token.includes("monitor.mjs")) sawMonitorScript = true;
      continue;
    }
    if (token.startsWith("--")) continue;
    return true;
  }
  return false;
}
const PID_START_TIME_TOLERANCE_MS = 90_000;
const UNKNOWN_OWNER_MONITOR_GRACE_MS = 3 * 60 * 1000;
const MONITOR_PROCESS_STARTED_AT = new Date().toISOString();
const MONITOR_LOCK_TOKEN = randomUUID();
const DUPLICATE_START_WARN_STATE_FILE = "monitor-duplicate-start-warning-state.json";
const DUPLICATE_START_WARN_THROTTLE_MS = Math.max(
  5_000,
  Number(process.env.MONITOR_DUPLICATE_START_WARN_THROTTLE_MS || "60000") || 60000,
);

function logDuplicateStartWarning(lockDir, existingPid, message) {
  const statePath = resolve(lockDir, DUPLICATE_START_WARN_STATE_FILE);
  const now = Date.now();
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = {};
  }

  const lastPid = Number(state?.pid);
  const lastLoggedAt = Number(state?.lastLoggedAt || 0);
  const suppressed = Math.max(0, Number(state?.suppressed || 0));
  const samePid = Number(existingPid) > 0 && lastPid === Number(existingPid);

  if (samePid && now - lastLoggedAt < DUPLICATE_START_WARN_THROTTLE_MS) {
    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          pid: existingPid,
          lastLoggedAt,
          suppressed: suppressed + 1,
        }),
        "utf8",
      );
    } catch {
      /* best effort */
    }
    return;
  }

  const suffix =
    samePid && suppressed > 0
      ? " (suppressed " +
        suppressed +
        " duplicate-start warnings in last " +
        Math.round(DUPLICATE_START_WARN_THROTTLE_MS / 1000) +
        "s)"
      : "";
  // Duplicate lock contention is benign (exit 0 path), so keep it out of error channels.
  try {
    console.log(message + suffix);
  } catch {
    try {
      process.stdout.write(String(message + suffix) + "\n");
    } catch {
      /* best effort */
    }
  }
  try {
    writeFileSync(
      statePath,
      JSON.stringify({
        pid: existingPid,
        lastLoggedAt: now,
        suppressed: 0,
      }),
      "utf8",
    );
  } catch {
    /* best effort */
  }
}


function parsePidFile(raw) {
  const text = String(raw || "").trim();
  if (!text) return { pid: null, raw: text };
  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return { pid: Number(data?.pid), raw: text, data };
    } catch {
      return { pid: Number(text), raw: text };
    }
  }
  return { pid: Number(text), raw: text };
}

export function formatPidFileSummary(parsed) {
  const pid = Number(parsed?.pid);
  if (Number.isFinite(pid) && pid > 0) return String(pid);
  const raw = String(parsed?.raw || "").replace(/\s+/g, " ").trim();
  if (!raw) return "unknown";
  if (raw.length <= 80) return raw;
  return `${raw.slice(0, 77)}...`;
}

function isCurrentProcessLockOwner(parsed) {
  if (!parsed || Number(parsed.pid) !== Number(process.pid)) return false;
  const data = parsed.data;
  const token = data?.lock_token;
  if (typeof token === "string" && token.trim().length > 0) {
    return token === MONITOR_LOCK_TOKEN;
  }
  // Backward-compatible fallback for pre-token lock files.
  return Boolean(data?.started_at) && data.started_at === MONITOR_PROCESS_STARTED_AT;
}
function getProcessSnapshot(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const processes = getProcesses();
  const entry = processes.find((p) => Number(p.pid) === Number(pid));
  if (!entry) return null;
  return {
    commandLine: entry.commandLine || "",
    creationDate: entry.creationDate || null,
  };
}

export function classifyMonitorCommandLine(commandLine) {
  const normalized = String(commandLine || "").toLowerCase().replace(/\\/g, "/");
  if (!normalized.trim()) return "unknown";
  // Sub-command invocations (e.g. `monitor.mjs agent list --json --active`) are helper
  // processes, NOT the singleton daemon monitor. Detect by a positional (non-flag) word
  // following monitor.mjs — the daemon only uses flag args (--daemon-child, --watch, …).
  if (normalized.includes("monitor.mjs") && hasMonitorSubcommandInvocation(normalized)) {
    return "other";
  }
  if (normalized.includes(MONITOR_MARKER)) return "monitor";
  if (normalized.includes("bosun") && normalized.includes("monitor.mjs")) {
    return "monitor";
  }

  const hasMonitorScriptSegment = MONITOR_SCRIPT_SEGMENT_RE.test(normalized);
  // Dev-mode launches may use relative or eval-import forms:
  // `node monitor.mjs`, `node ./monitor.mjs`, `node -e "import('./monitor.mjs')"`.
  if (
    hasMonitorScriptSegment &&
    (JS_MONITOR_LAUNCHER_RE.test(normalized) ||
      ((normalized.includes("import") || normalized.includes("require")) && normalized.includes("monitor.mjs")))
  ) {
    return "monitor";
  }

  if (
    normalized.includes("bosun") &&
    normalized.includes("cli.mjs")
  ) {
    return "monitor";
  }

  return "other";
}
function isLikelySameProcessFromPidFile(processInfo, pidFileData) {
  if (!processInfo || !pidFileData?.started_at) return null;
  const lockStartMs = Date.parse(pidFileData.started_at);
  const processStartMs = processInfo.creationDate?.getTime?.() || NaN;
  if (!Number.isFinite(lockStartMs) || !Number.isFinite(processStartMs)) {
    return null;
  }
  return Math.abs(processStartMs - lockStartMs) <= PID_START_TIME_TOLERANCE_MS;
}

function pidFileLooksLikeMonitor(pidFileData) {
  if (!pidFileData || !Array.isArray(pidFileData.argv)) return false;
  return classifyMonitorCommandLine(pidFileData.argv.join(" ")) === "monitor";
}

export function shouldAssumeMonitorForUnknownOwner(
  pidFileData,
  nowMs = Date.now(),
) {
  if (!pidFileLooksLikeMonitor(pidFileData)) return false;
  const startedAtMs = Date.parse(String(pidFileData?.started_at || ""));
  if (!Number.isFinite(startedAtMs)) {
    // Conservative fallback: lock payload strongly resembles monitor ownership.
    return true;
  }
  return Math.abs(nowMs - startedAtMs) <= UNKNOWN_OWNER_MONITOR_GRACE_MS;
}

function classifyMonitorProcess(pid, pidFileData) {
  const processInfo = getProcessSnapshot(pid);
  const commandClass = classifyMonitorCommandLine(processInfo?.commandLine || "");
  if (commandClass === "monitor") return "monitor";

  // Fallback for cases where OS command-line capture omits argv.
  const sameProcess = isLikelySameProcessFromPidFile(processInfo, pidFileData);
  if (sameProcess === true && pidFileLooksLikeMonitor(pidFileData)) {
    return "monitor";
  }

  return commandClass;
}
/**
 * Acquire a singleton lock by writing our PID file.
 * If a stale monitor is detected (PID file exists but process dead), clean up and take over.
 * Returns true if we acquired the lock, false if another monitor is actually running.
 */
export function acquireMonitorLock(lockDir) {
  const pidFile = resolve(lockDir, PID_FILE_NAME);
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch {
    /* best effort */
  }

  const registerCleanup = () => {
    const cleanup = () => {
      try {
        const parsed = parsePidFile(readFileSync(pidFile, "utf8"));
        if (isCurrentProcessLockOwner(parsed)) {
          unlinkSync(pidFile);
        }
      } catch {
        /* best effort */
      }
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
  };

  const writeFreshLock = () => {
    const payload = {
      pid: process.pid,
      started_at: MONITOR_PROCESS_STARTED_AT,
      argv: process.argv,
      lock_token: MONITOR_LOCK_TOKEN,
    };
    const fd = openSync(pidFile, "wx");
    try {
      writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
    registerCleanup();
    console.log("[maintenance] monitor PID file written: " + pidFile);
    return true;
  };

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return writeFreshLock();
    } catch (err) {
      if (err?.code !== "EEXIST") {
        console.warn("[maintenance] failed to write PID file: " + err.message);
        return true; // Don't block startup on PID file failure
      }

      if (!existsSync(pidFile)) {
        // Lock vanished between EEXIST and inspection, retry quickly.
        continue;
      }

      try {
        const raw = readFileSync(pidFile, "utf8");
        const parsed = parsePidFile(raw);
        const existingPid = parsed.pid;

        if (existingPid && existingPid === process.pid) {
          if (isCurrentProcessLockOwner(parsed)) {
            // Re-entrant startup within the same process.
            return true;
          }
          console.warn(
            "[maintenance] PID file uses current PID but lock owner identity mismatched; replacing lock",
          );
        }

        if (
          existingPid &&
          existingPid !== process.pid &&
          isProcessAlive(existingPid)
        ) {
          const classification = classifyMonitorProcess(existingPid, parsed.data);
          if (classification === "monitor") {
            logDuplicateStartWarning(
              lockDir,
              existingPid,
              "[maintenance] another bosun is already running (PID " + existingPid + "). Ignoring duplicate start.",
            );
            return false;
          }
          if (classification === "unknown") {
            if (shouldAssumeMonitorForUnknownOwner(parsed.data)) {
              logDuplicateStartWarning(
                lockDir,
                existingPid,
                "[maintenance] PID file points to a live process (PID " + existingPid +
                  ") with unavailable command line, but lock payload matches a recent monitor start; ignoring duplicate start",
              );
              return false;
            }
            // Unknown owner + stale monitor metadata is more likely PID reuse.
            console.warn(
              "[maintenance] PID file points to a live process (PID " + existingPid +
                ") with unavailable command line and stale monitor metadata; assuming PID reuse and replacing lock",
            );
          } else {
            console.warn(
              "[maintenance] PID file points to non-monitor process (PID " + existingPid + "); replacing lock",
            );
          }
        } else {
          console.warn(
            "[maintenance] removing stale PID file (PID " + formatPidFileSummary(parsed) + " no longer alive)",
          );
        }
      } catch {
        // Can't parse/read existing lock; remove it and retry.
      }

      try {
        unlinkSync(pidFile);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") {
          if (attempt === maxAttempts) {
            console.error(
              "[maintenance] failed to remove stale PID file after " + attempt + " attempt(s): " + unlinkErr.message,
            );
            return false;
          }
          continue;
        }
      }
    }
  }

  console.error("[maintenance] failed to acquire monitor PID lock after retries");
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0); // Signal 0 = check existence, don't actually kill
    return true;
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      return true;
    }
    return false;
  }
}

// ── Full Maintenance Sweep ──────────────────────────────────────────────

/**
 * Fast-forward local tracking branches (e.g. main) to match origin.
 *
 * When local `main` falls behind `origin/main`, new worktrees and task
 * branches spawned from it start stale, causing avoidable rebase conflicts.
 * This function periodically pulls so the local ref stays current.
 *
 * Safe: only does `--ff-only` — never creates merge commits. It skips when
 * the checked-out branch has uncommitted changes (git will refuse the checkout
 * anyway). If local and remote both have unique commits, it logs a warning and
 * skips.
 *
 * @param {string} repoRoot
 * @param {string[]} [branches] - branches to sync (default: ["main"])
 * @returns {number} count of branches successfully synced
 */
export function syncLocalTrackingBranches(repoRoot, branches) {
  if (!repoRoot) return 0;
  const toSync = branches && branches.length ? branches : ["main"];
  let synced = 0;

  // 1. Fetch all remotes first (single network call)
  try {
    spawnSync("git", ["fetch", "--all", "--prune", "--quiet"], {
      cwd: repoRoot,
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (e) {
    logThrottledBranchSync(
      "sync:fetch-failed",
      `[maintenance] git fetch --all failed: ${e.message}`,
      "warn",
    );
    return 0;
  }

  // 2. Determine which branch is currently checked out (so we can handle it)
  let currentBranch = null;
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status === 0) currentBranch = result.stdout.trim();
  } catch {
    /* best effort */
  }

  for (const branch of toSync) {
    try {
      // Check if local branch exists
      const refCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        { cwd: repoRoot, timeout: 5000, windowsHide: true },
      );
      if (refCheck.status !== 0) {
        // Local branch doesn't exist — nothing to sync
        continue;
      }

      // Check if remote tracking ref exists
      const remoteRef = `origin/${branch}`;
      const remoteCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", `refs/remotes/${remoteRef}`],
        { cwd: repoRoot, timeout: 5000, windowsHide: true },
      );
      if (remoteCheck.status !== 0) continue;

      // Measure divergence in both directions up front
      const behindCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${branch}..${remoteRef}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const behind = parseInt(behindCheck.stdout?.trim(), 10) || 0;

      const aheadCheck = spawnSync(
        "git",
        ["rev-list", "--count", `${remoteRef}..${branch}`],
        { cwd: repoRoot, encoding: "utf8", timeout: 5000, windowsHide: true },
      );
      const ahead = parseInt(aheadCheck.stdout?.trim(), 10) || 0;

      if (behind === 0 && ahead === 0) continue; // Already in sync

      // 'main' must always mirror upstream — NEVER push local commits.
      // Hard-reset instead of rebase-push to prevent workspace drift.
      if (branch === "main" && ahead > 0) {
        if (branch === currentBranch) {
          const reset = spawnSync("git", ["reset", "--hard", remoteRef], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
          });
          if (reset.status === 0) {
            logThrottledBranchSync(
              `sync:${branch}:hard-reset`,
              `[maintenance] hard-reset 'main' to ${remoteRef} (was ${ahead}\u2191 ${behind}\u2193) — main must not diverge from upstream`,
              "warn",
            );
            synced++;
          } else {
            logThrottledBranchSync(
              `sync:${branch}:hard-reset-failed`,
              `[maintenance] hard-reset of 'main' to ${remoteRef} failed`,
              "error",
            );
          }
        } else {
          // Not checked out — force-update the ref directly
          const update = spawnSync(
            "git",
            ["update-ref", `refs/heads/${branch}`, `refs/remotes/${remoteRef}`],
            { cwd: repoRoot, timeout: 5000, windowsHide: true },
          );
          if (update.status === 0) {
            logThrottledBranchSync(
              `sync:${branch}:force-update-ref`,
              `[maintenance] force-updated 'main' ref to ${remoteRef} (was ${ahead}\u2191 ${behind}\u2193) — discarded local-only commits`,
              "warn",
            );
            synced++;
          } else {
            logThrottledBranchSync(
              `sync:${branch}:force-update-ref-failed`,
              `[maintenance] force-update of 'main' ref to ${remoteRef} failed`,
              "error",
            );
          }
        }
        continue;
      }

      // Local is ahead of remote but not behind — try a plain push
      if (behind === 0 && ahead > 0) {
        const push = spawnSync(
          "git",
          ["push", "origin", `${branch}:refs/heads/${branch}`, "--quiet"],
          { cwd: repoRoot, encoding: "utf8", timeout: 30_000, windowsHide: true },
        );
        if (push.status === 0) {
          logThrottledBranchSync(
            `sync:${branch}:push-success`,
            `[maintenance] pushed local '${branch}' to origin (${ahead} commit(s) ahead)`,
            "info",
          );
          synced++;
        } else {
          logThrottledBranchSync(
            `sync:${branch}:push-failed`,
            `[maintenance] git push '${branch}' failed: ${(push.stderr || push.stdout || "").toString().trim()}`,
            "warn",
          );
        }
        continue;
      }

      // Truly diverged: local has unique commits AND is missing remote commits.
      // Attempt merge-based integration onto remote then push (checked-out branch only).
      if (ahead > 0) {
        const statusCheck = spawnSync("git", ["status", "--porcelain"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        if (statusCheck.stdout?.trim()) {
          console.log(`[maintenance] local '${branch}' diverged (${ahead}↑ ${behind}↓) but has uncommitted changes — skipping`);
          logThrottledBranchSync(
            `sync:${branch}:diverged-dirty`,
            `[maintenance] local '${branch}' diverged (${ahead}↑ ${behind}↓) but has uncommitted changes — skipping`,
            "info",
          );
          continue;
        }
        if (branch === currentBranch) {
          const merge = spawnSync(
            "git",
            ["merge", "--no-edit", remoteRef, "--quiet"],
            { cwd: repoRoot, encoding: "utf8", timeout: 60_000, windowsHide: true },
          );
          if (merge.status !== 0) {
            spawnSync("git", ["merge", "--abort"], {
              cwd: repoRoot, timeout: 10_000, windowsHide: true,
            });
            console.warn(
              `[maintenance] merge of '${branch}' with ${remoteRef} failed (${ahead}↑ ${behind}↓) — skipping`,
            );
            continue;
          }
          const push = spawnSync(
            "git",
            ["push", "origin", `${branch}:refs/heads/${branch}`, "--quiet"],
            { cwd: repoRoot, encoding: "utf8", timeout: 30_000, windowsHide: true },
          );
          if (push.status === 0) {
            logThrottledBranchSync(
              `sync:${branch}:merge-push-success`,
              `[maintenance] merged and pushed '${branch}' (was ${ahead}↑ ${behind}↓)`,
              "info",
            );
            synced++;
          } else {
            logThrottledBranchSync(
              `sync:${branch}:merge-push-failed`,
              `[maintenance] push after merge of '${branch}' failed: ${(push.stderr || push.stdout || "").toString().trim()}`,
              "warn",
            );
          }
        } else {
          logThrottledBranchSync(
            `sync:${branch}:diverged-not-checked-out`,
            `[maintenance] local '${branch}' diverged (${ahead}↑ ${behind}↓) and not checked out — skipping (rebase requires checkout)`,
            "warn",
          );
        }
        continue;
      }

      // If this is the currently checked-out branch, use git pull --ff-only
      if (branch === currentBranch) {
        // Check for uncommitted changes — skip if dirty
        const statusCheck = spawnSync("git", ["status", "--porcelain"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 5000,
          windowsHide: true,
        });
        if (statusCheck.stdout?.trim()) {
          console.log(`[maintenance] '${branch}' is checked out with uncommitted changes — skipping pull`);
          logThrottledBranchSync(
            `sync:${branch}:dirty-pull-skip`,
            `[maintenance] '${branch}' is checked out with uncommitted changes — skipping pull`,
            "info",
          );
          continue;
        }

        const pull = spawnSync("git", ["pull", "--ff-only", "--quiet"], {
          cwd: repoRoot,
          encoding: "utf8",
          timeout: 30_000,
          windowsHide: true,
        });
        if (pull.status === 0) {
          logThrottledBranchSync(
            `sync:${branch}:pull-success`,
            `[maintenance] fast-forwarded checked-out '${branch}' (was ${behind} behind)`,
            "info",
          );
          synced++;
        } else {
          logThrottledBranchSync(
            `sync:${branch}:pull-failed`,
            `[maintenance] git pull --ff-only on '${branch}' failed: ${(pull.stderr || pull.stdout || "").toString().trim()}`,
            "warn",
          );
        }
      } else {
        // Not checked out — use git fetch to update the local ref directly
        // This is safe because no worktree has it checked out
        const update = spawnSync(
          "git",
          ["update-ref", `refs/heads/${branch}`, `refs/remotes/${remoteRef}`],
          { cwd: repoRoot, timeout: 5000, windowsHide: true },
        );
        if (update.status === 0) {
          logThrottledBranchSync(
            `sync:${branch}:update-ref-success`,
            `[maintenance] fast-forwarded '${branch}' → ${remoteRef} (was ${behind} behind)`,
            "info",
          );
          synced++;
        } else {
          logThrottledBranchSync(
            `sync:${branch}:update-ref-failed`,
            `[maintenance] update-ref failed for '${branch}'`,
            "warn",
          );
        }
      }
    } catch (e) {
      logThrottledBranchSync(
        `sync:${branch}:unexpected-error`,
        `[maintenance] error syncing '${branch}': ${e.message}`,
        "error",
      );
    }
  }

  if (synced > 0) {
    logThrottledBranchSync(
      "sync:summary",
      `[maintenance] synced ${synced}/${toSync.length} local tracking branch(es)`,
      "info",
    );
  }
  return synced;
}

/**
 * Run full maintenance sweep: stale kill, git push reap, worktree cleanup,
 * local tracking branch sync, and optionally task archiving.
 * @param {object} opts
 * @param {string} opts.repoRoot - repository root path
 * @param {number} [opts.childPid] - current orchestrator child PID to skip
 * @param {number} [opts.gitPushMaxAgeMs] - max age for git push before kill (default 5min)
 * @param {string[]} [opts.syncBranches] - local branches to fast-forward (default: ["main"])
 * @param {function} [opts.archiveCompletedTasks] - optional async function to archive completed tasks
 * @param {object} [opts.branchCleanup] - branch cleanup options (passed to cleanupStaleBranches)
 * @param {boolean} [opts.branchCleanup.enabled=true] - enable/disable branch cleanup
 * @param {number} [opts.branchCleanup.minAgeMs] - minimum branch age before cleanup (default 24h)
 * @param {boolean} [opts.branchCleanup.dryRun] - if true, log only without deleting
 */
export async function runMaintenanceSweep(opts = {}) {
  const {
    repoRoot,
    childPid,
    gitPushMaxAgeMs,
    helperProcessMaxAgeMs,
    syncBranches,
    archiveCompletedTasks,
    branchCleanup,
  } = opts;
  console.log("[maintenance] starting sweep...");

  const staleKilled = killStaleOrchestrators(childPid);
  const helperProcessesReaped = reapStaleBosunHelperProcesses(helperProcessMaxAgeMs, {
    skipPids: [childPid],
  });
  const pushesReaped = reapStuckGitPushes(gitPushMaxAgeMs);
  const worktreesPruned = repoRoot ? cleanupWorktrees(repoRoot) : 0;

  // Also prune via centralized WorktreeManager
  try {
    const pruneResult = await pruneStaleWorktrees();
    if (pruneResult.pruned > 0) {
      console.log(
        `[maintenance] WorktreeManager pruned ${pruneResult.pruned} stale worktrees`,
      );
    }
  } catch (wtErr) {
    console.warn(
      `[maintenance] WorktreeManager prune failed: ${wtErr.message}`,
    );
  }

  const branchesSynced = repoRoot
    ? syncLocalTrackingBranches(repoRoot, syncBranches)
    : 0;

  // Branch cleanup: delete old ve/* and copilot-worktree-* branches
  let branchesDeleted = 0;
  const branchCleanupEnabled = branchCleanup?.enabled !== false;
  if (repoRoot && branchCleanupEnabled) {
    try {
      const branchResult = cleanupStaleBranches(repoRoot, {
        minAgeMs: branchCleanup?.minAgeMs,
        dryRun: branchCleanup?.dryRun,
      });
      branchesDeleted = branchResult.deleted.length;
    } catch (err) {
      console.warn(`[maintenance] branch cleanup failed: ${err.message}`);
    }
  }

  // Optional: Archive old completed tasks (if provided)
  let tasksArchived = 0;
  if (archiveCompletedTasks && typeof archiveCompletedTasks === "function") {
    try {
      const result = await archiveCompletedTasks();
      tasksArchived = result?.archived || 0;
      if (tasksArchived > 0) {
        console.log(
          `[maintenance] archived ${tasksArchived} old completed tasks`,
        );
      }
    } catch (err) {
      console.warn(`[maintenance] task archiving failed: ${err.message}`);
    }
  }

  // Guard against core.bare=true corruption that accumulates from worktree ops
  try {
    const repoRoot = resolve(import.meta.dirname || ".", "..");
    fixGitConfigCorruption(repoRoot);
  } catch {
    /* best-effort */
  }

  // Prune expired context cache entries (tool-log cache, 24h TTL)
  let toolLogsPruned = 0;
  try {
    const { pruneToolLogCache } = await import("../workspace/context-cache.mjs");
    toolLogsPruned = await pruneToolLogCache();
  } catch (cacheErr) {
    console.warn(`[maintenance] tool-log cache prune failed: ${cacheErr.message}`);
  }

  const result = {
    staleKilled,
    helperProcessesReaped,
    pushesReaped,
    worktreesPruned,
    branchesSynced,
    tasksArchived,
    branchesDeleted,
    toolLogsPruned,
  };

  console.log(
    `[maintenance] sweep complete: ${staleKilled} stale orchestrators, ${helperProcessesReaped} stale helper processes, ${pushesReaped} stuck pushes, ${worktreesPruned} worktrees pruned, ${branchesSynced} branches synced, ${branchesDeleted} stale branches deleted, ${toolLogsPruned} tool-log cache entries pruned`,
  );

  // Emit workflow event so event-driven workflows can react to sweep results
  emitMaintenanceEvent("maintenance.sweep_complete", result);

  return result;
}
