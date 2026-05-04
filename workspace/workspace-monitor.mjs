/**
 * @fileoverview Real-time workspace monitoring and log streaming
 * Tracks workspace sessions, streams logs, detects stuck agents, caches state
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

const MONITOR_INTERVAL_MS = 30_000; // Check every 30 seconds
const STUCK_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without progress
const REBASE_COMMIT_THRESHOLD = 20; // If syncing >20 commits, consider merge instead
const MAX_DUPLICATE_COMMITS = 5; // Flag if >5 commits with same message
const ERROR_LOOP_THRESHOLD = 3; // Same error 3 times = loop
const ERROR_LOOP_WINDOW_MS = 15 * 60 * 1000; // Within 15 minutes

// ── Workspace State Cache ─────────────────────────────────────────────────────

class WorkspaceMonitor {
  constructor(options = {}) {
    this.cacheDir = options.cacheDir || resolve(".cache", "workspace-logs");
    this.repoRoot = options.repoRoot || process.cwd();
    this.workspaces = new Map(); // attemptId -> WorkspaceState
    this.monitorInterval = null;
    this.onStuckDetected = options.onStuckDetected || null;
    this.onProgressUpdate = options.onProgressUpdate || null;
  }

  async init() {
    await mkdir(this.cacheDir, { recursive: true });
    console.log(`[workspace-monitor] initialized (cache: ${this.cacheDir})`);
  }

  /**
   * Start monitoring a workspace session
   */
  async startMonitoring(attemptId, workspacePath, metadata = {}) {
    if (this.workspaces.has(attemptId)) {
      console.warn(
        `[workspace-monitor] already monitoring ${attemptId}, skipping`,
      );
      return;
    }

    const state = {
      attemptId,
      workspacePath,
      taskId: metadata.taskId,
      executor: metadata.executor,
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      lastGitCheck: null,
      gitState: null,
      commitHistory: [],
      fileChanges: [],
      errorHistory: [], // Track errors for loop detection
      rebaseAttempts: 0, // Count rebase attempts
      conflictCount: 0, // Count conflicts encountered
      lastError: null, // Last error fingerprint
      lastErrorAt: null, // When last error occurred
      logFilePath: resolve(this.cacheDir, `${attemptId}.log`),
      stateFilePath: resolve(this.cacheDir, `${attemptId}.state.json`),
      stuck: false,
      stuckReason: null,
      errorLoop: false, // Detected error loop
      errorLoopType: null, // Type of loop (rebase, conflict, command)
    };

    this.workspaces.set(attemptId, state);

    // Create log file
    await writeFile(
      state.logFilePath,
      `[${new Date().toISOString()}] Monitoring started for attempt ${attemptId}\n` +
        `Workspace: ${workspacePath}\n` +
        `Task: ${metadata.taskId}\n` +
        `Executor: ${metadata.executor}\n` +
        `---\n\n`,
    );

    console.log(
      `[workspace-monitor] started monitoring ${attemptId} (${workspacePath})`,
    );

    // Start periodic checks if not already running
    if (!this.monitorInterval) {
      this.monitorInterval = setInterval(
        () => this.checkAllWorkspaces(),
        MONITOR_INTERVAL_MS,
      );
    }

    // Do initial check
    await this.checkWorkspace(attemptId);
  }

  /**
   * Stop monitoring a workspace
   */
  async stopMonitoring(attemptId, reason = "completed") {
    const state = this.workspaces.get(attemptId);
    if (!state) return;

    await this.logWorkspace(
      attemptId,
      `\n[${new Date().toISOString()}] Monitoring stopped: ${reason}\n`,
    );

    // Save final state
    await this.saveWorkspaceState(attemptId);

    this.workspaces.delete(attemptId);

    // Stop interval if no more workspaces
    if (this.workspaces.size === 0 && this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    console.log(`[workspace-monitor] stopped monitoring ${attemptId}`);
  }

  /**
   * Check all monitored workspaces for issues
   */
  async checkAllWorkspaces() {
    const promises = [];
    for (const attemptId of this.workspaces.keys()) {
      promises.push(
        this.checkWorkspace(attemptId).catch((err) => {
          console.error(
            `[workspace-monitor] error checking ${attemptId}: ${err.message}`,
          );
        }),
      );
    }
    await Promise.all(promises);
  }

  /**
   * Check a single workspace for stuck conditions
   */
  async checkWorkspace(attemptId) {
    const state = this.workspaces.get(attemptId);
    if (!state) return;

    const now = Date.now();
    const gitState = await this.captureGitState(state.workspacePath);

    if (!gitState) {
      await this.logWorkspace(
        attemptId,
        `[${new Date().toISOString()}] ERROR: Could not read git state\n`,
      );
      return;
    }

    // Update state
    state.lastGitCheck = now;
    const oldGitState = state.gitState;
    state.gitState = gitState;

    // Detect progress
    const hasProgress = this.detectProgress(oldGitState, gitState);
    if (hasProgress) {
      state.lastProgressAt = now;
      state.stuck = false;
      state.stuckReason = null;
    }

    // Log git state changes
    if (oldGitState && this.hasGitStateChanged(oldGitState, gitState)) {
      await this.logWorkspace(
        attemptId,
        `[${new Date().toISOString()}] Git state update:\n` +
          `  Branch: ${gitState.branch}\n` +
          `  Commits ahead: ${gitState.commitsAhead}\n` +
          `  Commits behind: ${gitState.commitsBehind}\n` +
          `  Modified files: ${gitState.modifiedFiles}\n` +
          `  Rebase in progress: ${gitState.rebaseInProgress}\n` +
          (gitState.rebaseInProgress
            ? `  Rebase done/todo: ${gitState.rebaseDone}/${gitState.rebaseTodo}\n`
            : ""),
      );
    }

    // Detect stuck conditions
    const stuckCheck = this.detectStuck(state, now);
    if (stuckCheck.stuck && !state.stuck) {
      state.stuck = true;
      state.stuckReason = stuckCheck.reason;

      await this.logWorkspace(
        attemptId,
        `[${new Date().toISOString()}] :alert:  STUCK DETECTED: ${stuckCheck.reason}\n` +
          `  Time since last progress: ${Math.round((now - state.lastProgressAt) / 60000)} minutes\n` +
          `  Recommendation: ${stuckCheck.recommendation}\n\n`,
      );

      // Trigger callback
      if (this.onStuckDetected) {
        this.onStuckDetected({
          attemptId,
          reason: stuckCheck.reason,
          recommendation: stuckCheck.recommendation,
          state,
        });
      }
    }

    // Check for inefficient patterns
    const warnings = this.detectInefficiencies(gitState, state);
    for (const warning of warnings) {
      await this.logWorkspace(
        attemptId,
        `[${new Date().toISOString()}] :alert:  ${warning}\n`,
      );
    }

    // Save state snapshot
    await this.saveWorkspaceState(attemptId);

    // Trigger progress callback
    if (this.onProgressUpdate && hasProgress) {
      this.onProgressUpdate({ attemptId, gitState, state });
    }
  }

  /**
   * Capture current git state from workspace
   */
  async captureGitState(workspacePath) {
    if (!existsSync(workspacePath)) {
      return null;
    }

    const gitDir = resolve(workspacePath, ".git");
    if (!existsSync(gitDir)) {
      return null;
    }

    try {
      // Get branch
      const branch = await this.gitCommand(workspacePath, [
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);

      // Check if rebase in progress
      const rebaseMergeDir = resolve(gitDir, "rebase-merge");
      const rebaseInProgress = existsSync(rebaseMergeDir);

      let rebaseDone = 0;
      let rebaseTodo = 0;
      if (rebaseInProgress) {
        try {
          const doneFile = resolve(rebaseMergeDir, "done");
          const todoFile = resolve(rebaseMergeDir, "git-rebase-todo");
          if (existsSync(doneFile)) {
            const done = await readFile(doneFile, "utf8");
            rebaseDone = done.split("\n").filter((l) => l.trim()).length;
          }
          if (existsSync(todoFile)) {
            const todo = await readFile(todoFile, "utf8");
            rebaseTodo = todo
              .split("\n")
              .filter((l) => l.trim() && l.startsWith("pick ")).length;
          }
        } catch {
          /* best effort */
        }
      }

      // Get commits ahead/behind
      const [ahead, behind, modified, untracked, lastCommit] =
        await Promise.all([
          this.gitCommand(workspacePath, [
            "rev-list",
            "--count",
            "@{u}..HEAD",
          ]).catch(() => "0"),
          this.gitCommand(workspacePath, [
            "rev-list",
            "--count",
            "HEAD..@{u}",
          ]).catch(() => "0"),
          this.gitCommand(workspacePath, ["diff", "--name-only"]).then(
            (out) => out.split("\n").filter(Boolean).length,
          ),
          this.gitCommand(workspacePath, [
            "ls-files",
            "--others",
            "--exclude-standard",
          ]).then((out) => out.split("\n").filter(Boolean).length),
          this.gitCommand(workspacePath, [
            "log",
            "-1",
            "--format=%H|%s|%ct",
          ]).catch(() => "||0"),
        ]);

      const [lastHash, lastMessage, lastTimestamp] = lastCommit.split("|");

      return {
        branch: branch.trim(),
        rebaseInProgress,
        rebaseDone,
        rebaseTodo,
        commitsAhead: parseInt(ahead, 10) || 0,
        commitsBehind: parseInt(behind, 10) || 0,
        modifiedFiles: modified,
        untrackedFiles: untracked,
        lastCommitHash: lastHash,
        lastCommitMessage: lastMessage,
        lastCommitTime: parseInt(lastTimestamp, 10) * 1000,
      };
    } catch (err) {
      console.error(
        `[workspace-monitor] error capturing git state: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Execute git command in workspace
   */
  async gitCommand(cwd, args) {
    if (!Array.isArray(args) || args.length === 0) {
      throw new TypeError("gitCommand expected a non-empty args array");
    }

    const command = String(args[0] || "").toLowerCase();
    const allowedCommands = new Set(["rev-parse", "rev-list", "diff", "ls-files", "log"]);
    if (!allowedCommands.has(command)) {
      throw new Error(`Unsupported git subcommand in monitor: ${command}`);
    }

    const commandShapes = new Map([
      ["rev-parse", [["--abbrev-ref", "HEAD"]]],
      ["rev-list", [["--count", "@{u}..HEAD"], ["--count", "HEAD..@{u}"]]],
      ["diff", [["--name-only"]]],
      ["ls-files", [["--others", "--exclude-standard"]]],
      ["log", [["-1", "--format=%H|%s|%ct"]]],
    ]).get(command) || [];

    const receivedTail = args.slice(1).map((entry) => String(entry || ""));
    const matchedShape = commandShapes.some((shape) =>
      shape.length === receivedTail.length && shape.every((expected, idx) => expected === receivedTail[idx]),
    );
    if (!matchedShape) {
      throw new Error(`Unsupported git arguments in monitor for ${command}: ${receivedTail.join(" ")}`);
    }

    const safeArgs = [command, ...receivedTail];
    return new Promise((resolve, reject) => {
      const proc = spawn("git", safeArgs, { cwd, shell: false });
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `git exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Detect if progress was made since last check
   */
  detectProgress(oldState, newState) {
    if (!oldState) return true; // First check counts as progress

    // Different commit hash = progress
    if (oldState.lastCommitHash !== newState.lastCommitHash) return true;

    // File changes = progress
    if (
      oldState.modifiedFiles !== newState.modifiedFiles ||
      oldState.untrackedFiles !== newState.untrackedFiles
    )
      return true;

    // Rebase progress
    if (
      newState.rebaseInProgress &&
      oldState.rebaseDone !== newState.rebaseDone
    )
      return true;

    return false;
  }

  /**
   * Check if git state changed meaningfully
   */
  hasGitStateChanged(oldState, newState) {
    return (
      oldState.branch !== newState.branch ||
      oldState.lastCommitHash !== newState.lastCommitHash ||
      oldState.rebaseInProgress !== newState.rebaseInProgress ||
      oldState.rebaseDone !== newState.rebaseDone ||
      oldState.commitsAhead !== newState.commitsAhead ||
      oldState.commitsBehind !== newState.commitsBehind
    );
  }

  /**
   * Detect stuck conditions
   */
  detectStuck(state, now) {
    const timeSinceProgress = now - state.lastProgressAt;

    // Stuck in rebase for >10 minutes
    if (
      state.gitState?.rebaseInProgress &&
      timeSinceProgress > STUCK_THRESHOLD_MS
    ) {
      const totalCommits =
        state.gitState.rebaseDone + state.gitState.rebaseTodo;
      return {
        stuck: true,
        reason: `Stuck in rebase (${state.gitState.rebaseDone}/${totalCommits} commits, ${Math.round(timeSinceProgress / 60000)}min)`,
        recommendation:
          totalCommits > REBASE_COMMIT_THRESHOLD
            ? "Abort rebase, use merge instead for large drifts"
            : "Check for conflicts or infinite loops",
      };
    }

    // No progress for >10 minutes
    if (timeSinceProgress > STUCK_THRESHOLD_MS) {
      return {
        stuck: true,
        reason: `No progress for ${Math.round(timeSinceProgress / 60000)} minutes`,
        recommendation: "Agent may be stuck in a loop or waiting for input",
      };
    }

    return { stuck: false };
  }

  /**
   * Detect inefficient patterns
   */
  detectInefficiencies(gitState, state) {
    const warnings = [];

    // Massive sync
    if (gitState.rebaseInProgress) {
      const totalCommits = gitState.rebaseDone + gitState.rebaseTodo;
      if (totalCommits > REBASE_COMMIT_THRESHOLD) {
        warnings.push(
          `INEFFICIENCY: Syncing ${totalCommits} commits (consider merge for >20 commits)`,
        );
      }
    }

    // Too many commits ahead (agent making micro-commits)
    if (gitState.commitsAhead > 50) {
      warnings.push(
        `INEFFICIENCY: ${gitState.commitsAhead} commits ahead (agent should squash commits)`,
      );
    }

    // Check for duplicate commit messages
    if (gitState.lastCommitMessage && state.commitHistory.length > 0) {
      const duplicates = state.commitHistory.filter(
        (c) => c.message === gitState.lastCommitMessage,
      ).length;
      if (duplicates > MAX_DUPLICATE_COMMITS) {
        warnings.push(
          `INEFFICIENCY: Duplicate commit message "${gitState.lastCommitMessage}" (${duplicates} times)`,
        );
      }
    }

    // Update commit history
    if (
      !state.commitHistory.find((c) => c.hash === gitState.lastCommitHash)
    ) {
      state.commitHistory.push({
        hash: gitState.lastCommitHash,
        message: gitState.lastCommitMessage,
        timestamp: gitState.lastCommitTime,
      });

      // Keep only last 100 commits in memory
      if (state.commitHistory.length > 100) {
        state.commitHistory = state.commitHistory.slice(-100);
      }
    }

    return warnings;
  }

  /**
   * Append to workspace log file
   */
  async logWorkspace(attemptId, message) {
    const state = this.workspaces.get(attemptId);
    if (!state) return;

    try {
      await appendFile(state.logFilePath, message);
    } catch (err) {
      console.error(
        `[workspace-monitor] failed to write log for ${attemptId}: ${err.message}`,
      );
    }
  }

  /**
   * Save workspace state to JSON
   */
  async saveWorkspaceState(attemptId) {
    const state = this.workspaces.get(attemptId);
    if (!state) return;

    try {
      const snapshot = {
        attemptId: state.attemptId,
        taskId: state.taskId,
        executor: state.executor,
        workspacePath: state.workspacePath,
        startedAt: state.startedAt,
        lastProgressAt: state.lastProgressAt,
        lastGitCheck: state.lastGitCheck,
        gitState: state.gitState,
        commitHistory: state.commitHistory,
        stuck: state.stuck,
        stuckReason: state.stuckReason,
        logFile: state.logFilePath,
      };

      await writeFile(
        state.stateFilePath,
        JSON.stringify(snapshot, null, 2),
        "utf8",
      );
    } catch (err) {
      console.error(
        `[workspace-monitor] failed to save state for ${attemptId}: ${err.message}`,
      );
    }
  }

  /**
   * Get current state for an attempt
   */
  getState(attemptId) {
    return this.workspaces.get(attemptId);
  }

  /**
   * Get all monitored workspaces
   */
  getAllStates() {
    return Array.from(this.workspaces.values());
  }

  /**
   * Cleanup and stop monitoring
   */
  async shutdown() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    // Save all states before shutdown
    const promises = [];
    for (const attemptId of this.workspaces.keys()) {
      promises.push(this.stopMonitoring(attemptId, "shutdown"));
    }
    await Promise.all(promises);

    console.log("[workspace-monitor] shut down");
  }
}

export { WorkspaceMonitor };

