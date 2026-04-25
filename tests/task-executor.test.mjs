import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { resolve } from "node:path";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("../kanban/kanban-adapter.mjs", () => ({
  getKanbanAdapter: vi.fn(),
  getKanbanBackendName: vi.fn(() => "internal"),
  listTasks: vi.fn(() => []),
  listProjects: vi.fn(() => [{ id: "proj-1", name: "Test Project" }]),
  getTask: vi.fn(),
  updateTaskStatus: vi.fn(() => Promise.resolve()),
  addComment: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../agent/agent-pool.mjs", () => ({
  launchOrResumeThread: vi.fn(),
  execWithRetry: vi.fn(() =>
    Promise.resolve({ success: true, output: "done", attempts: 1 }),
  ),
  invalidateThread: vi.fn(),
  getActiveThreads: vi.fn(() => []),
  getPoolSdkName: vi.fn(() => "codex"),
  pruneAllExhaustedThreads: vi.fn(() => 0),
  ensureThreadRegistryLoaded: vi.fn(() => Promise.resolve()),
}));

vi.mock("../workspace/worktree-manager.mjs", () => {
  const acquireWorktree = vi.fn(() =>
    Promise.resolve({ path: "/fake/worktree", created: true }),
  );
  const releaseWorktree = vi.fn(() => Promise.resolve());
  const getWorktreeStats = vi.fn(() => ({
    active: 0,
    total: 0,
    stale: 0,
    byOwner: {},
  }));

  class WorktreeManager {
    acquireWorktree = acquireWorktree;
    releaseWorktree = releaseWorktree;
    getStats = getWorktreeStats;
  }

  return {
    WorktreeManager,
    acquireWorktree,
    releaseWorktree,
    getWorktreeStats,
  };
});

vi.mock("../workspace/shared-state-manager.mjs", () => ({
  getSharedState: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../task/task-claims.mjs", () => ({
  initTaskClaims: vi.fn(() => Promise.resolve()),
  claimTask: vi.fn(() => Promise.resolve({ success: true, token: "claim-1" })),
  renewClaim: vi.fn(() => Promise.resolve({ success: true })),
  getClaim: vi.fn(() => Promise.resolve(null)),
  releaseTask: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock("../infra/presence.mjs", () => ({
  initPresence: vi.fn(() => Promise.resolve()),
  getPresenceState: vi.fn(() => ({
    instance_id: "presence-instance-1",
    coordinator_priority: 100,
  })),
}));

vi.mock("../config/config.mjs", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../git/git-safety.mjs", () => ({
  evaluateBranchSafetyForPush: vi.fn(() => ({ safe: true })),
  sanitizeGitEnv: vi.fn(() => ({})),
  normalizeBaseBranch: vi.fn((baseBranch = "main", remote = "origin") => {
    let branch = String(baseBranch || "main").trim();
    if (!branch) branch = "main";
    branch = branch.replace(/^refs\/heads\//, "");
    branch = branch.replace(/^refs\/remotes\//, "");
    while (branch.startsWith(`${remote}/`)) {
      branch = branch.slice(remote.length + 1);
    }
    if (!branch) branch = "main";
    return { branch, remoteRef: `${remote}/${branch}` };
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execSync: vi.fn(() => ""),
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
});

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => ""),
  existsSync: vi.fn(() => false),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  TaskExecutor,
  getTaskExecutor,
  loadExecutorOptionsFromConfig,
  isInternalExecutorEnabled,
  getExecutorMode,
  setTaskStatusTransitionHandler,
} from "../task/task-executor.mjs";
import {
  listTasks,
  listProjects,
  getKanbanBackendName,
  updateTaskStatus,
  addComment,
} from "../kanban/kanban-adapter.mjs";
import {
  execWithRetry,
  getPoolSdkName,
  getActiveThreads,
  ensureThreadRegistryLoaded,
  invalidateThread,
} from "../agent/agent-pool.mjs";
import { acquireWorktree, releaseWorktree } from "../workspace/worktree-manager.mjs";
import { getSharedState } from "../workspace/shared-state-manager.mjs";
import {
  claimTask,
  renewClaim,
  getClaim,
  releaseTask as releaseTaskClaim,
} from "../task/task-claims.mjs";
import { initPresence, getPresenceState } from "../infra/presence.mjs";
import { loadConfig } from "../config/config.mjs";
import { evaluateBranchSafetyForPush } from "../git/git-safety.mjs";
import {
  getSessionTracker,
  _resetSingleton as resetSessionTrackerSingleton,
} from "../infra/session-tracker.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

const mockTask = {
  id: "task-123-uuid",
  title: "Fix the bug",
  description: "There is a bug that needs fixing",
  status: "todo",
  branchName: "ve/task-123-fix-the-bug",
};

/** Saved env vars to restore after each test. */
const ENV_KEYS = [
  "EXECUTOR_MODE",
  "INTERNAL_EXECUTOR_PARALLEL",
  "INTERNAL_EXECUTOR_POLL_MS",
  "INTERNAL_EXECUTOR_SDK",
  "INTERNAL_EXECUTOR_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_MAX_RETRIES",
  "INTERNAL_EXECUTOR_PROJECT_ID",
  "COPILOT_MODEL",
  "COPILOT_SDK_MODEL",
  "CLAUDE_MODEL",
  "CLAUDE_CODE_MODEL",
  "ANTHROPIC_MODEL",
  "VE_INSTANCE_ID",
  "BOSUN_INSTANCE_ID",
  "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
  "INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS",
  "INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS",
  "PROJECT_REQUIREMENTS_PROFILE",
  "PROJECT_REQUIREMENTS_NOTES",
  "BOSUN_COAUTHOR_MODE",
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("task-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTrackerSingleton({ persistDir: null });
    for (const key of ENV_KEYS) delete process.env[key];
    getSharedState.mockResolvedValue(null);
    setTaskStatusTransitionHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetSessionTrackerSingleton({ persistDir: null });
    for (const key of ENV_KEYS) delete process.env[key];
    setTaskStatusTransitionHandler(null);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Constructor
  // ────────────────────────────────────────────────────────────────────────

  describe("TaskExecutor constructor", () => {
    it("sets default options when none provided", () => {
      const ex = new TaskExecutor();
      expect(ex.mode).toBe("internal");
      expect(ex.maxParallel).toBe(3);
      expect(ex.pollIntervalMs).toBe(30_000);
      expect(ex.sdk).toBe("auto");
      expect(ex.taskTimeoutMs).toBe(6 * 60 * 60 * 1000);
      expect(ex.maxRetries).toBe(2);
      expect(ex.autoCreatePr).toBe(true);
      expect(ex.projectId).toBeNull();
    });

    it("overrides defaults with provided options", () => {
      const ex = new TaskExecutor({
        mode: "internal",
        maxParallel: 5,
        sdk: "copilot",
        projectId: "proj-42",
      });
      expect(ex.mode).toBe("internal");
      expect(ex.maxParallel).toBe(5);
      expect(ex.sdk).toBe("copilot");
      expect(ex.projectId).toBe("proj-42");
      // untouched defaults
      expect(ex.pollIntervalMs).toBe(30_000);
    });

    it("initializes empty _activeSlots Map", () => {
      const ex = new TaskExecutor();
      expect(ex._activeSlots).toBeInstanceOf(Map);
      expect(ex._activeSlots.size).toBe(0);
    });

    it("sets _running to false initially", () => {
      const ex = new TaskExecutor();
      expect(ex._running).toBe(false);
    });

    it("initializes backlog replenishment config and project requirements", () => {
      const ex = new TaskExecutor({
        backlogReplenishment: {
          enabled: true,
          minNewTasks: 2,
          maxNewTasks: 3,
        },
        projectRequirements: {
          profile: "system",
          notes: "cross-module coordination",
        },
      });
      const cfg = ex.getBacklogReplenishmentConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.minNewTasks).toBe(2);
      expect(cfg.maxNewTasks).toBe(3);
      expect(cfg.projectRequirements.profile).toBe("system");
    });

    it("_ensureTaskClaimsInitialized returns false (legacy stub)", async () => {
      const ex = new TaskExecutor();
      const result = await ex._ensureTaskClaimsInitialized();
      expect(result).toBe(false);
    });

    it("keeps explicit instance id when provided in env", () => {
      process.env.VE_INSTANCE_ID = "explicit-instance-1";
      const ex = new TaskExecutor();
      expect(ex._instanceId).toBe("explicit-instance-1");
    });

    it("defaults workflowOwnsTaskLifecycle to true", () => {
      const ex = new TaskExecutor();
      expect(ex.workflowOwnsTaskLifecycle).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getStatus
  // ────────────────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("returns running state", () => {
      const ex = new TaskExecutor();
      expect(ex.getStatus().running).toBe(false);
      ex._running = true;
      expect(ex.getStatus().running).toBe(true);
    });

    it("returns correct mode, maxParallel, sdk", () => {
      const ex = new TaskExecutor({ mode: "hybrid", maxParallel: 7 });
      const status = ex.getStatus();
      expect(status.mode).toBe("hybrid");
      expect(status.maxParallel).toBe(7);
      // sdk "auto" delegates to getPoolSdkName()
      expect(status.sdk).toBe("codex");
      expect(getPoolSdkName).toHaveBeenCalled();
    });

    it("returns empty slots when none active", () => {
      const ex = new TaskExecutor();
      const status = ex.getStatus();
      expect(status.activeSlots).toBe(0);
      expect(status.slots).toEqual([]);
    });

    it("surfaces in-progress recovery telemetry in status and tui snapshots", () => {
      const ex = new TaskExecutor();
      ex._inProgressRecovery = {
        totals: {
          runs: 2,
          failures: 1,
          resumed: 3,
          resetToTodo: 4,
          reconciledDrift: 1,
          skippedForActiveClaim: 2,
          skippedForNoCommitBlock: 1,
          resetUnstarted: 1,
          staleSharedClaim: 2,
          workflowOwnerlessReset: 1,
        },
        lastRun: {
          trigger: "interval",
          scannedCount: 5,
          resumedCount: 2,
          resetToTodoCount: 1,
          staleSharedClaimCount: 1,
          workflowOwnerlessResetCount: 1,
          durationMs: 3200,
          workflowEvidenceKept: [
            {
              taskId: "task-abc",
              runId: "run-live-1",
              source: "history",
              reason: "workflow_liveness",
              lastActivityAt: new Date().toISOString(),
            },
          ],
        },
        recentRuns: [],
      };

      const status = ex.getStatus();
      const tuiStats = ex.getTuiStats();

      expect(status.inProgressRecovery.totals.resetToTodo).toBe(4);
      expect(status.inProgressRecovery.lastRun.scannedCount).toBe(5);
      expect(status.inProgressRecovery.lastRun.workflowEvidenceKept).toEqual([
        expect.objectContaining({
          taskId: "task-abc",
          runId: "run-live-1",
        }),
      ]);
      expect(tuiStats.recovery.totals.resumed).toBe(3);
      expect(tuiStats.executor.activeSlots).toBe(0);
    });

    it("returns correct slot info when tasks are running", () => {
      const ex = new TaskExecutor();
      ex._activeSlots.set("task-abc", {
        taskId: "task-abc",
        taskTitle: "Some task",
        branch: "ve/task-abc-some-task",
        sdk: "codex",
        attempt: 1,
        startedAt: Date.now() - 5000,
        status: "running",
      });

      const status = ex.getStatus();
      expect(status.activeSlots).toBe(1);
      expect(status.slots).toHaveLength(1);
      expect(status.slots[0].taskId).toBe("task-abc");
      expect(status.slots[0].taskTitle).toBe("Some task");
      expect(status.slots[0].status).toBe("running");
      expect(status.slots[0].agentInstanceId).toBeNull();
      expect(status.slots[0].runningFor).toBeGreaterThanOrEqual(4);
    });

    it("surfaces repo area lock telemetry for operators", () => {
      const ex = new TaskExecutor({ repoAreaParallelLimit: 2 });
      ex._activeSlots.set("task-abc", {
        taskId: "task-abc",
        taskTitle: "Some task",
        repoAreas: ["infra"],
        attempt: 2,
        startedAt: Date.now() - 5_000,
        status: "running",
      });
      ex._repoAreaLockMetrics.set("infra", {
        conflicts: 2,
        blockedDispatches: 2,
        selectedDispatches: 1,
        waitMsTotal: 1200,
        waitSamples: 2,
        maxWaitMs: 900,
        lastConflictAt: "2026-03-07T00:00:00.000Z",
        lastSelectedAt: "2026-03-07T00:00:01.000Z",
      });
      ex._repoAreaDispatchCycle = {
        cycle: 4,
        at: "2026-03-07T00:00:02.000Z",
        candidateCount: 3,
        remaining: 1,
        selectedCount: 1,
        blockedTasks: 1,
        conflictEvents: 1,
        waitMsTotal: 600,
        waitSamples: 1,
        maxWaitMs: 600,
        blockedByArea: { infra: 1 },
        saturatedAreas: ["infra"],
        cycleAreaMetrics: {
          infra: {
            conflicts: 1,
            blockedDispatches: 1,
            selectedDispatches: 0,
            waitMsTotal: 600,
            waitSamples: 1,
            maxWaitMs: 600,
          },
        },
      };

      const status = ex.getStatus();

      expect(status.repoAreaLocks).toEqual(
        expect.objectContaining({
          enabled: true,
          configuredLimit: 2,
          fairQueue: expect.objectContaining({
            policy: "round_robin_oldest_wait",
          }),
          totals: expect.objectContaining({
            conflicts: 2,
            blockedDispatches: 2,
          }),
          lastDispatch: expect.objectContaining({
            cycle: 4,
            conflictEvents: 1,
            waitMsTotal: 600,
            saturatedAreas: ["infra"],
            areaLimits: expect.any(Object),
          }),
        }),
      );
      expect(status.repoAreaLocks.worker).toBeInstanceOf(Array);
      expect(status.repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            activeSlots: 1,
            conflicts: 2,
            averageWaitMs: 600,
            selectedDispatches: 1,
            adaptivePenalty: expect.any(Number),
          }),
        ]),
      );
    });
  });

  describe("repo-area collision scheduling", () => {
    it("enforces repoAreaParallelLimit when repo areas overlap", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 1 });
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
      });

      const selected = ex._selectTasksForBaseBranchLimit([
        { id: "t1", repo_areas: ["infra"] },
        { id: "t2", repo_areas: ["workflow"] },
      ], 2);

      expect(selected.map((task) => task.id)).toEqual(["t2"]);
    });

    it("keeps backward-compatible behavior when repoAreaParallelLimit is unset", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0 });
      const selected = ex._selectTasksForBaseBranchLimit([
        { id: "t1", repo_areas: ["infra"] },
        { id: "t2", repo_areas: ["infra"] },
      ], 2);
      expect(selected.map((task) => task.id)).toEqual(["t1", "t2"]);
    });

    it("applies fair queue ordering across mixed repo-area candidates", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      const selected = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-1", repo_areas: ["infra"] },
          { id: "infra-2", repo_areas: ["infra"] },
          { id: "workflow-1", repo_areas: ["workflow"] },
          { id: "workflow-2", repo_areas: ["workflow"] },
        ],
        2,
      );

      expect(selected.map((task) => task.id)).toEqual(["infra-1", "workflow-1"]);
      expect(ex.getStatus().repoAreaLocks.lastDispatch).toEqual(
        expect.objectContaining({
          policy: "round_robin_oldest_wait",
          selectedCount: 2,
        }),
      );
    });

    it("reduces effective repo area cap when active failures are high", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 3 });
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 2,
        startedAt: Date.now() - 1_000,
        status: "running",
      });
      ex._activeSlots.set("active-2", {
        taskId: "active-2",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: Date.now() - 1_000,
        status: "running",
      });

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["infra"] }],
        1,
      );

      expect(selected).toEqual([]);
      expect(ex.getStatus().repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            effectiveLimit: 2,
            conflicts: 1,
            blockedDispatches: 1,
            activeFailureRate: 0.5,
          }),
        ]),
      );
    });

    it("reduces effective repo area cap when merge latency is elevated", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["workflow"],
        attempt: 1,
        startedAt: Date.now() - 5 * 60 * 60 * 1000,
        status: "running",
      });

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["workflow"] }],
        1,
      );

      expect(selected).toEqual([]);
      expect(ex.getStatus().repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "workflow",
            effectiveLimit: 1,
            averageMergeLatencyMs: expect.any(Number),
          }),
        ]),
      );
    });

    it("reduces effective repo area cap from recent outcome telemetry", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      const startedAt = Date.now() - 1_000;
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt,
        status: "running",
      });
      ex._repoAreaTelemetry.set("infra", {
        conflictCount: 0,
        totalWaitMs: 0,
        lastWaitMs: 0,
        maxWaitMs: 0,
        lastBlockedAt: 0,
        lastOutcomeAt: Date.now(),
        recentOutcomes: [1, 1, 0, 1, 1, 0],
        mergeLatencySamples: [],
      });

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["infra"] }],
        1,
      );

      expect(selected).toEqual([]);
      expect(ex.getStatus().repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            effectiveLimit: 1,
            activeFailureRate: 0,
            outcomeFailureRate: expect.any(Number),
            adaptiveFailureRate: expect.any(Number),
          }),
        ]),
      );
    });

    it("reduces effective limit from outcome failure telemetry without active slots", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 3 });
      ex._repoAreaTelemetry.set("infra", {
        conflictCount: 0,
        totalWaitMs: 0,
        lastWaitMs: 0,
        maxWaitMs: 0,
        lastBlockedAt: 0,
        lastOutcomeAt: Date.now(),
        recentOutcomes: [1, 1, 1, 0, 1, 0],
        mergeLatencySamples: [],
      });

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["infra"] }],
        3,
      );

      expect(selected.map((t) => t.id)).toEqual(["t1"]);
      const status = ex.getStatus().repoAreaLocks;
      const infra = status.areas.find((item) => item.area === "infra");
      expect(infra).toBeDefined();
      expect(infra.effectiveLimit).toBeLessThan(3);
      expect(infra.adaptiveReasons).toContain("outcome_failure_rate");
      expect(infra.outcomeFailureRate).toBeGreaterThanOrEqual(0.5);
    });

    it("reduces effective limit from slow merge latency telemetry without active slots", () => {
      const slowLatencyMs = 5 * 60 * 60 * 1000;
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 3 });
      ex._repoAreaTelemetry.set("infra", {
        conflictCount: 0,
        totalWaitMs: 0,
        lastWaitMs: 0,
        maxWaitMs: 0,
        lastBlockedAt: 0,
        lastOutcomeAt: Date.now(),
        recentOutcomes: [],
        mergeLatencySamples: [slowLatencyMs, slowLatencyMs, slowLatencyMs],
      });

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["infra"] }],
        3,
      );

      expect(selected.map((t) => t.id)).toEqual(["t1"]);
      const status = ex.getStatus().repoAreaLocks;
      const infra = status.areas.find((item) => item.area === "infra");
      expect(infra).toBeDefined();
      expect(infra.effectiveLimit).toBeLessThan(3);
      expect(infra.adaptiveReasons).toContain("historical_merge_latency");
      expect(infra.telemetryMergeLatencyMs).toBeGreaterThanOrEqual(slowLatencyMs);
    });
    it("tracks repo area wait time once a blocked task is later selected", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 1 });
      const now = Date.now();
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: now - 2_000,
        status: "running",
      });

      vi.spyOn(Date, "now")
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 1_500)
        .mockReturnValue(now + 1_500);

      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);

      ex._activeSlots.clear();

      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t1", repo_areas: ["infra"] }],
        1,
      );

      expect(selected.map((task) => task.id)).toEqual(["t1"]);
      expect(ex.getStatus().repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            waitSamples: 1,
            averageWaitMs: 1500,
            maxWaitMs: 1500,
            selectedDispatches: 1,
          }),
        ]),
      );
      expect(ex.getStatus().repoAreaLocks.worker).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            waitSamples: 1,
            lastWaitMs: 1500,
            maxWaitMs: 1500,
          }),
        ]),
      );
      expect(ex.getStatus().repoAreaLocks.contention).toEqual(
        expect.objectContaining({
          events: 1,
          recent: expect.arrayContaining([
            expect.objectContaining({
              area: "infra",
              waitMs: 1500,
              resolutionReason: "selected",
              taskId: "t1",
            }),
          ]),
        }),
      );
    });

    it("tracks starvation counters per repo area and worker", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 1 });
      const now = Date.now();
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: now - 2_000,
        status: "running",
      });

      let tick = now;
      vi.spyOn(Date, "now").mockImplementation(() => {
        tick += 100;
        return tick;
      });

      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);
      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);
      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);

      const status = ex.getStatus().repoAreaLocks;
      expect(status.lastDispatch.starvationEvents).toBeGreaterThanOrEqual(1);
      expect(status.lastDispatch.starvingAreas).toContain("infra");
      expect(status.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            starvationEvents: 1,
            starvingTasks: 1,
            maxStarvationCycles: 3,
          }),
        ]),
      );
      expect(status.worker).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            starvationEvents: 1,
            maxStarvationCycles: 3,
          }),
        ]),
      );
    });

    it("emits contention diagnostics when a waiting task is dequeued", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 1 });
      const now = Date.now();
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: now - 2_000,
        status: "running",
      });

      vi.spyOn(Date, "now")
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 800)
        .mockReturnValue(now + 800);

      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);

      ex._activeSlots.clear();
      const selected = ex._selectTasksForBaseBranchLimit(
        [{ id: "t2", repo_areas: ["workflow"] }],
        1,
      );

      expect(selected.map((task) => task.id)).toEqual(["t2"]);
      expect(ex.getStatus().repoAreaLocks.contention).toEqual(
        expect.objectContaining({
          events: 1,
          byReason: expect.objectContaining({
            dequeued: 1,
          }),
          recent: expect.arrayContaining([
            expect.objectContaining({
              area: "infra",
              waitMs: 800,
              resolutionReason: "dequeued",
              taskId: "t1",
            }),
          ]),
        }),
      );
    });

    it("keeps throughput within budget under sustained lock pressure", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      const now = Date.now();
      ex._activeSlots.set("active-infra", {
        taskId: "active-infra",
        repoAreas: ["infra"],
        attempt: 2,
        startedAt: now - 6 * 60 * 60 * 1000,
        status: "running",
      });

      let tick = now;
      vi.spyOn(Date, "now").mockImplementation(() => {
        tick += 500;
        return tick;
      });

      const cycle1 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-task", repo_areas: ["infra"] },
          { id: "workflow-task-1", repo_areas: ["workflow"] },
          { id: "workflow-task-2", repo_areas: ["workflow"] },
        ],
        2,
      );
      const cycle2 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-task", repo_areas: ["infra"] },
          { id: "server-task-1", repo_areas: ["server"] },
          { id: "server-task-2", repo_areas: ["server"] },
        ],
        2,
      );

      ex._activeSlots.clear();

      const cycle3 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-task", repo_areas: ["infra"] },
          { id: "workflow-task-3", repo_areas: ["workflow"] },
        ],
        2,
      );

      const selectedCount = cycle1.length + cycle2.length + cycle3.length;
      expect(selectedCount).toBeGreaterThanOrEqual(4);

      const status = ex.getStatus();
      expect(status.repoAreaLocks.totals).toEqual(
        expect.objectContaining({
          dispatchCycles: 3,
          conflictEvents: expect.any(Number),
          blockedDispatches: expect.any(Number),
        }),
      );
      expect(status.repoAreaLocks.totals.conflictEvents).toBeGreaterThanOrEqual(2);
      expect(status.repoAreaLocks.lastDispatch).toEqual(
        expect.objectContaining({
          cycle: 3,
          selectedCount: 2,
          conflictEvents: expect.any(Number),
          waitMsTotal: expect.any(Number),
        }),
      );
      expect(status.repoAreaLocks.areas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            waitSamples: 1,
            conflicts: expect.any(Number),
          }),
        ]),
      );
    });

    it("records cross-cycle lock conflicts and wait metrics in a synthetic multi-agent simulation", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      const now = Date.now();
      ex._activeSlots.set("active-infra-1", {
        taskId: "active-infra-1",
        repoAreas: ["infra"],
        attempt: 2,
        startedAt: now - 3 * 60 * 60 * 1000,
        status: "running",
      });
      ex._activeSlots.set("active-infra-2", {
        taskId: "active-infra-2",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: now - 2 * 60 * 60 * 1000,
        status: "running",
      });

      let tick = now;
      vi.spyOn(Date, "now").mockImplementation(() => {
        tick += 300;
        return tick;
      });

      const cycle1 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-latent", repo_areas: ["infra"] },
          { id: "workflow-task-1", repo_areas: ["workflow"] },
          { id: "server-task-1", repo_areas: ["server"] },
        ],
        2,
      );
      const cycle2 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-latent", repo_areas: ["infra"] },
          { id: "workflow-task-2", repo_areas: ["workflow"] },
          { id: "server-task-2", repo_areas: ["server"] },
        ],
        2,
      );

      ex._activeSlots.delete("active-infra-1");
      ex._activeSlots.delete("active-infra-2");

      const cycle3 = ex._selectTasksForBaseBranchLimit(
        [
          { id: "infra-latent", repo_areas: ["infra"] },
          { id: "server-task-3", repo_areas: ["server"] },
        ],
        2,
      );
      const cycle4 = ex._selectTasksForBaseBranchLimit(
        [{ id: "infra-fast", repo_areas: ["infra"] }],
        1,
      );

      const selectedCount = cycle1.length + cycle2.length + cycle3.length + cycle4.length;
      expect(selectedCount).toBeGreaterThanOrEqual(6);

      const status = ex.getStatus().repoAreaLocks;
      const infra = status.areas.find((item) => item.area === "infra");
      expect(infra).toBeDefined();
      expect(infra).toEqual(
        expect.objectContaining({
          conflicts: expect.any(Number),
          blockedDispatches: expect.any(Number),
          waitSamples: 1,
          averageWaitMs: expect.any(Number),
        }),
      );
      expect(infra.conflicts).toBeGreaterThanOrEqual(2);
      expect(infra.blockedDispatches).toBeGreaterThanOrEqual(2);
      expect(infra.averageWaitMs).toBeGreaterThan(0);

      expect(status.totals).toEqual(
        expect.objectContaining({
          dispatchCycles: 4,
          conflictEvents: expect.any(Number),
        }),
      );
      expect(status.totals.conflictEvents).toBeGreaterThanOrEqual(2);
      expect(status.lastDispatch.cycle).toBe(4);
      expect(status.dispatch.recent).toHaveLength(4);
      expect(status.dispatch.recent.some((entry) => Number(entry?.conflictEvents || 0) > 0)).toBe(true);
      expect(
        status.dispatch.recent.some((entry) =>
          Array.isArray(entry?.areaLimits?.infra?.adaptiveReasons) &&
          entry.areaLimits.infra.adaptiveReasons.includes("active_failure_rate")
        ),
      ).toBe(true);
    });

    it("persists repo area lock metrics and dispatch cycles to runtime state", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 1 });
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: Date.now() - 2_000,
        status: "running",
      });

      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);
      ex.noteRepoAreaOutcome({ id: "t1", repo_areas: ["infra"] }, { status: "failed" });

      const runtimeWriteCall = writeFileSync.mock.calls
        .filter(([filePath]) =>
          String(filePath || "").includes("task-executor-runtime.json"),
        )
        .at(-1);
      expect(runtimeWriteCall).toBeDefined();
      const runtimePayload = JSON.parse(runtimeWriteCall[1]);
      expect(runtimePayload.repoAreaDispatchCycles).toBe(1);
      expect(runtimePayload.repoAreaDispatchCycle).toEqual(
        expect.objectContaining({
          cycle: 1,
          blockedTasks: 1,
          conflictEvents: 1,
          blockedByArea: expect.objectContaining({ infra: 1 }),
          areaLimits: expect.objectContaining({
            infra: expect.objectContaining({
              configuredLimit: 1,
              effectiveLimit: 1,
            }),
          }),
          cycleAreaMetrics: expect.objectContaining({
            infra: expect.objectContaining({
              conflicts: 1,
              blockedDispatches: 1,
            }),
          }),
        }),
      );
      expect(runtimePayload.repoAreaLockMetrics.infra).toEqual(
        expect.objectContaining({
          blockedDispatches: 1,
          conflicts: 1,
        }),
      );
      expect(runtimePayload.repoAreaContentionEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "infra",
            waitMs: expect.any(Number),
            resolutionReason: "abandoned",
            taskId: "t1",
          }),
        ]),
      );
      expect(runtimePayload.repoAreaLockStatus).toEqual(
        expect.objectContaining({
          enabled: true,
          configuredLimit: 1,
          totals: expect.objectContaining({
            dispatchCycles: 1,
            conflictEvents: 1,
          }),
          areas: expect.arrayContaining([
            expect.objectContaining({
              area: "infra",
              effectiveLimit: 1,
              conflicts: 1,
            }),
          ]),
        }),
      );
      expect(runtimePayload.inProgressRecovery).toEqual(
        expect.objectContaining({
          totals: expect.objectContaining({
            runs: 0,
            resetToTodo: 0,
          }),
        }),
      );
    });

    it("exposes adaptive lock reasons from historical telemetry", () => {
      const ex = new TaskExecutor({ baseBranchParallelLimit: 0, repoAreaParallelLimit: 2 });
      ex._repoAreaTelemetry.set("infra", {
        conflictCount: 3,
        totalWaitMs: 1_500,
        lastWaitMs: 600,
        maxWaitMs: 900,
        lastBlockedAt: Date.now() - 5_000,
        lastOutcomeAt: Date.now() - 2_000,
        recentOutcomes: [1, 1, 0, 1],
        mergeLatencySamples: [5 * 60 * 60 * 1000, 5 * 60 * 60 * 1000, 5 * 60 * 60 * 1000],
      });
      ex._activeSlots.set("active-1", {
        taskId: "active-1",
        repoAreas: ["infra"],
        attempt: 1,
        startedAt: Date.now() - 1_000,
        status: "running",
      });

      expect(
        ex._selectTasksForBaseBranchLimit([{ id: "t1", repo_areas: ["infra"] }], 1),
      ).toEqual([]);

      const status = ex.getStatus().repoAreaLocks;
      const infra = status.areas.find((item) => item.area === "infra");
      expect(status.totals.dispatchCycles).toBe(1);
      expect(status.totals.conflictEvents).toBeGreaterThanOrEqual(1);
      expect(infra).toEqual(
        expect.objectContaining({
          effectiveLimit: 1,
          adaptiveReasons: expect.arrayContaining(["failure_rate", "merge_latency"]),
          adaptivePenalty: expect.any(Number),
          historicalFailureRate: expect.any(Number),
        }),
      );
    });
  });

  describe("pause state persistence", () => {
    it("defaults manual pause reason and writes pausedAt to orchestrator pause state", () => {
      const ex = new TaskExecutor();

      ex.pause();

      const pauseWriteCall = writeFileSync.mock.calls.find(([filePath]) =>
        String(filePath || "").includes("orchestrator-pause.json"),
      );
      expect(pauseWriteCall).toBeDefined();
      const pausePayload = JSON.parse(pauseWriteCall[1]);
      expect(pausePayload.paused).toBe(true);
      expect(pausePayload.reason).toBe("manual");
      expect(typeof pausePayload.pausedAt).toBe("string");
      expect(pausePayload.pausedAt).toContain("T");
    });

    it("restores legacy paused runtime state with normalized reason metadata", () => {
      existsSync.mockImplementation((filePath) =>
        String(filePath || "").includes("task-executor-runtime.json"),
      );
      readFileSync.mockReturnValue(
        JSON.stringify({
          paused: true,
          pausedAt: null,
          pauseUntil: null,
          pauseReason: null,
          nextAgentInstanceId: 1,
          slots: {},
        }),
      );

      const ex = new TaskExecutor();
      ex._loadRuntimeState();
      const pauseInfo = ex.getPauseInfo();

      expect(pauseInfo.paused).toBe(true);
      expect(pauseInfo.pauseReason).toBe("manual");
      expect(typeof pauseInfo.pausedAt).toBe("number");

      const pauseWriteCall = writeFileSync.mock.calls.find(([filePath]) =>
        String(filePath || "").includes("orchestrator-pause.json"),
      );
      expect(pauseWriteCall).toBeDefined();
      const pausePayload = JSON.parse(pauseWriteCall[1]);
      expect(pausePayload.source).toBe("runtime-restore");
      expect(pausePayload.reason).toBe("manual");
      expect(typeof pausePayload.pausedAt).toBe("string");
    });

    it("restores persisted in-progress recovery telemetry from runtime state", () => {
      existsSync.mockImplementation((filePath) =>
        String(filePath || "").includes("task-executor-runtime.json"),
      );
      readFileSync.mockReturnValue(
        JSON.stringify({
          paused: false,
          nextAgentInstanceId: 1,
          inProgressRecovery: {
            totals: {
              runs: 3,
              failures: 1,
              resumed: 2,
              resetToTodo: 5,
              staleSharedClaim: 2,
            },
            lastRun: {
              trigger: "startup",
              scannedCount: 4,
              resetToTodoCount: 2,
              staleSharedClaimCount: 1,
              workflowEvidenceKept: [
                {
                  taskId: "task-restore-1",
                  runId: "run-restore-1",
                  source: "active-runs",
                },
              ],
            },
            recentRuns: [
              { trigger: "interval", scannedCount: 1, resetToTodoCount: 1 },
            ],
          },
          slots: {},
        }),
      );

      const ex = new TaskExecutor();
      ex._loadRuntimeState();
      const recovery = ex.getStatus().inProgressRecovery;

      expect(recovery.totals.runs).toBe(3);
      expect(recovery.totals.resetToTodo).toBe(5);
      expect(recovery.lastRun.trigger).toBe("startup");
      expect(recovery.lastRun.workflowEvidenceKept).toEqual([
        expect.objectContaining({
          taskId: "task-restore-1",
          runId: "run-restore-1",
        }),
      ]);
      expect(recovery.recentRuns).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // start / stop
  // ────────────────────────────────────────────────────────────────────────

  describe("start / stop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("start() sets _running to true; skips poll timer when workflow-owned", () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000 });
      ex.start();
      expect(ex._running).toBe(true);
      // workflowOwnsTaskLifecycle defaults to true — no poll timer
      expect(ex._pollTimer).toBeNull();
      expect(ex._recoveryTimer).not.toBeNull();
      ex._running = false;
    });

    it("start() creates poll timer when workflowOwnsTaskLifecycle is false", () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000, workflowOwnsTaskLifecycle: false });
      ex.start();
      expect(ex._running).toBe(true);
      expect(ex._pollTimer).not.toBeNull();
      expect(ex._recoveryTimer).not.toBeNull();
      ex._running = false;
      clearInterval(ex._pollTimer);
      clearInterval(ex._recoveryTimer);
    });

    it("start() waits for thread registry load before in-progress recovery", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 10_000 });
      let releaseRegistryLoad = null;
      const registryLoadGate = new Promise((resolve) => {
        releaseRegistryLoad = resolve;
      });
      ensureThreadRegistryLoaded.mockReturnValueOnce(registryLoadGate);
      const recoverySpy = vi
        .spyOn(ex, "_recoverInterruptedInProgressTasks")
        .mockResolvedValue(undefined);

      ex.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(recoverySpy).not.toHaveBeenCalled();

      releaseRegistryLoad?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(recoverySpy).toHaveBeenCalledTimes(1);

      ex._running = false;
      clearInterval(ex._pollTimer);
      clearInterval(ex._recoveryTimer);
    });

    it("stop() sets _running to false and clears poll timer", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 60_000 });
      ex.start();
      expect(ex._running).toBe(true);

      const stopPromise = ex.stop();
      // No active slots, should resolve quickly
      await stopPromise;

      expect(ex._running).toBe(false);
      expect(ex._pollTimer).toBeNull();
      expect(ex._recoveryTimer).toBeNull();
    });

    it("stop() waits for active slots gracefully", async () => {
      const ex = new TaskExecutor({ pollIntervalMs: 60_000 });
      ex.start();

      // Simulate an active slot
      ex._activeSlots.set("slot-1", {
        taskId: "slot-1",
        taskTitle: "test",
        startedAt: Date.now(),
        status: "running",
      });

      const stopPromise = ex.stop();

      // Advance timers to trigger the 1-second check intervals
      // Then remove the active slot to let stop() finish
      await vi.advanceTimersByTimeAsync(2000);
      ex._activeSlots.delete("slot-1");
      await vi.advanceTimersByTimeAsync(2000);

      await stopPromise;
      expect(ex._running).toBe(false);
    });
  });

  describe("in-progress recovery", () => {
    it("resumes fresh in-progress tasks on startup recovery", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: false });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "resume-1",
          title: "Resume this",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resume-1" }),
        expect.objectContaining({ recoveredFromInProgress: true }),
      );
    });

    it("moves stale in-progress tasks back to todo when no resumable thread exists", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: false });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const staleTs = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

      listTasks.mockResolvedValueOnce([
        {
          id: "stale-1",
          title: "Old in-progress task",
          status: "inprogress",
          updated_at: staleTs,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "stale-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resets unstarted in-progress tasks beyond slot capacity so backlog can flow", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 1, workflowOwnsTaskLifecycle: false });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const staleTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      listTasks.mockResolvedValueOnce([
        {
          id: "resume-1",
          title: "Resume one",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
        {
          id: "stale-unstarted-1",
          title: "Stale unstarted one",
          status: "inprogress",
          updated_at: staleTs,
          agentAttempts: 0,
        },
        {
          id: "stale-unstarted-2",
          title: "Stale unstarted two",
          status: "inprogress",
          updated_at: staleTs,
          agentAttempts: 0,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resume-1" }),
        expect.objectContaining({ recoveredFromInProgress: true }),
      );
      expect(updateTaskStatus).toHaveBeenCalledWith(
        "stale-unstarted-1",
        "todo",
        expect.objectContaining({ source: "task-executor-recovery-unstarted" }),
      );
      expect(updateTaskStatus).toHaveBeenCalledWith(
        "stale-unstarted-2",
        "todo",
        expect.objectContaining({ source: "task-executor-recovery-unstarted" }),
      );
    });

    it("does not reset fresh unstarted tasks owned by another live executor claim", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: false });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const freshTs = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      listTasks.mockResolvedValueOnce([
        {
          id: "claimed-unstarted-1",
          title: "Claimed but not locally threaded",
          status: "inprogress",
          updated_at: freshTs,
          agentAttempts: 0,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "remote-instance-1",
        ownerHeartbeat: new Date().toISOString(),
      });
      getClaim.mockResolvedValueOnce({
        instance_id: "remote-instance-1",
        metadata: {
          host: "remote-host",
          pid: 4242,
        },
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "claimed-unstarted-1",
        "todo",
        expect.objectContaining({ source: "task-executor-recovery-unstarted" }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not reset fresh workflow-owned tasks when an active workflow run exists", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-owned-1",
          title: "Workflow-owned active run",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 0,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([{ runId: "run-1" }]);
        }
        if (targetPath === resolve("/workflow-runs", "run-1.json")) {
          return JSON.stringify({
            data: {
              taskId: "wf-owned-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              },
            },
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-owned-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resets fresh workflow-owned tasks when no active workflow run or claim exists", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-ownerless-1",
          title: "Workflow-owned ownerless task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 0,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation(
        (targetPath) => targetPath === resolve("/workflow-runs", "_active-runs.json"),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-ownerless-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-ownerless-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not keep workflow-owned tasks alive on stale topology-only run detail with no checkpoint progress", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-24T00:00:00.000Z");
      vi.setSystemTime(now);

      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-stale-topology-1",
          title: "Workflow-owned stale topology should not block reset",
          status: "inprogress",
          updated_at: now.toISOString(),
          agentAttempts: 0,
          topology: {
            latestRunId: "run-topology-stale-1",
          },
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-topology-stale-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        if (targetPath === resolve("/workflow-runs", "run-topology-stale-1.json")) {
          return JSON.stringify({
            id: "run-topology-stale-1",
            startedAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
            endedAt: null,
            latestCheckpoint: null,
            updatedAt: new Date(now.getTime() - 21 * 60 * 1000 + 1).toISOString(),
            data: {
              taskId: "wf-stale-topology-1",
              _dagState: {
                status: "running",
                createdAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
                updatedAt: new Date(now.getTime() - 21 * 60 * 1000 + 1).toISOString(),
                lastStatusAt: new Date(now.getTime() - 21 * 60 * 1000 + 1).toISOString(),
              },
            },
          });
        }
        return "";
      });

      const summary = await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-stale-topology-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-stale-topology-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(summary.workflowEvidenceKept).toEqual([]);

      vi.useRealTimers();
    });

    it("marks ownerless workflow recovery resets to bypass workflow ownership", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const transitionSpy = vi.fn().mockResolvedValue(true);
      setTaskStatusTransitionHandler(transitionSpy);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-ownerless-bypass-1",
          title: "Workflow-owned ownerless task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 0,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation(
        (targetPath) => targetPath === resolve("/workflow-runs", "_active-runs.json"),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(transitionSpy).toHaveBeenCalledWith(
        "wf-ownerless-bypass-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
          bypassWorkflowOwnership: true,
        }),
      );
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-ownerless-bypass-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("keeps workflow-owned tasks in progress when latest run detail shows a recent running DAG", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-recent-run-1",
          title: "Workflow-owned recent run evidence",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
          topology: {
            latestRunId: "run-recent-1",
          },
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-recent-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        if (targetPath === resolve("/workflow-runs", "run-recent-1.json")) {
          return JSON.stringify({
            id: "run-recent-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-recent-run-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-recent-run-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resets workflow-owned tasks when a run is stuck at agent.started with no turn progress", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-23T00:00:00.000Z");
      vi.setSystemTime(now);

      const turnSessionId = "wf-startup-stalled-1:agent:run-startup-stalled-1:run-agent-tests:turn";
      const tracker = getSessionTracker();
      tracker.createSession({
        id: turnSessionId,
        type: "task",
        taskId: turnSessionId,
        metadata: {},
      });
      tracker.recordEvent(turnSessionId, "agent.started");
      vi.setSystemTime(new Date(now.getTime() + 21 * 60 * 1000));

      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-startup-stalled-1",
          title: "Workflow-owned startup-stalled run",
          status: "inprogress",
          updated_at: new Date(now.getTime()).toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-startup-stalled-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([
            {
              runId: "run-startup-stalled-1",
              taskId: "wf-startup-stalled-1",
              sessionIds: [turnSessionId],
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "run-startup-stalled-1.json")) {
          return JSON.stringify({
            id: "run-startup-stalled-1",
            status: "running",
            startedAt: new Date(now.getTime() - 25 * 60 * 1000).toISOString(),
            endedAt: null,
            sessionIds: [turnSessionId],
            latestCheckpoint: {
              eventType: "agent.started",
              nodeId: "run-agent-tests",
              updatedAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
              counters: {
                toolCallCount: 0,
                toolResultCount: 0,
                spillCount: 0,
              },
            },
            data: {
              taskId: "wf-startup-stalled-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-startup-stalled-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-startup-stalled-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resets workflow-owned tasks when write-tests is stuck at agent.started with no turn progress", async () => {
      vi.useFakeTimers();
      const now = new Date("2026-04-23T00:00:00.000Z");
      vi.setSystemTime(now);

      const turnSessionId = "wf-startup-stalled-write-tests-1:agent:run-startup-stalled-write-tests-1:write-tests:turn";
      const tracker = getSessionTracker();
      tracker.createSession({
        id: turnSessionId,
        type: "task",
        taskId: turnSessionId,
        metadata: {},
      });
      tracker.recordEvent(turnSessionId, "agent.started");
      vi.setSystemTime(new Date(now.getTime() + 21 * 60 * 1000));

      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-startup-stalled-write-tests-1",
          title: "Workflow-owned write-tests startup stall",
          status: "inprogress",
          updated_at: new Date(now.getTime()).toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-startup-stalled-write-tests-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([
            {
              runId: "run-startup-stalled-write-tests-1",
              taskId: "wf-startup-stalled-write-tests-1",
              sessionIds: [turnSessionId],
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "run-startup-stalled-write-tests-1.json")) {
          return JSON.stringify({
            id: "run-startup-stalled-write-tests-1",
            status: "running",
            startedAt: new Date(now.getTime() - 25 * 60 * 1000).toISOString(),
            endedAt: null,
            sessionIds: [turnSessionId],
            latestCheckpoint: {
              eventType: "agent.started",
              nodeId: "write-tests",
              updatedAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
              counters: {
                toolCallCount: 0,
                toolResultCount: 0,
                spillCount: 0,
              },
            },
            data: {
              taskId: "wf-startup-stalled-write-tests-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(now.getTime() - 21 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-startup-stalled-write-tests-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-startup-stalled-write-tests-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("keeps workflow-owned tasks in progress when recent run evidence only exists in timeline events", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-timeline-run-1",
          title: "Workflow-owned timeline run evidence",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
          timeline: [
            {
              type: "workflow.node.start",
              payload: {
                runId: "run-timeline-1",
              },
            },
          ],
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-timeline-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        if (targetPath === resolve("/workflow-runs", "run-timeline-1.json")) {
          return JSON.stringify({
            id: "run-timeline-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-timeline-run-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("keeps workflow-owned tasks in progress when history has a newer live run after an older stale run", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-history-multi-1",
          title: "Workflow-owned newer history run evidence",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-stale-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "index.json"),
          resolve("/workflow-runs", "run-history-stale-1.json"),
          resolve("/workflow-runs", "run-history-live-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        if (targetPath === resolve("/workflow-runs", "index.json")) {
          return JSON.stringify({
            runs: [
              {
                runId: "run-history-stale-1",
                taskId: "wf-history-multi-1",
                status: "paused",
                startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              },
              {
                runId: "run-history-live-1",
                taskId: "wf-history-multi-1",
                status: "running",
                startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              },
            ],
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-history-stale-1.json")) {
          return JSON.stringify({
            id: "run-history-stale-1",
            startedAt: Date.now() - 60 * 60 * 1000,
            endedAt: null,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-history-live-1.json")) {
          return JSON.stringify({
            id: "run-history-live-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-history-multi-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-history-multi-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalledWith({
        taskId: "wf-history-multi-1",
        force: true,
      });
      expect(invalidateThread).not.toHaveBeenCalledWith("wf-history-multi-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("builds a stale workflow cleanup patch when ownerless workflow tasks are reset", () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      const completedEndedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "run-stale-1.json"),
          resolve("/workflow-runs", "run-completed-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "run-stale-1.json")) {
          return JSON.stringify({
            id: "run-stale-1",
            status: "running",
            startedAt: Date.now() - 60 * 60 * 1000,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
              },
            },
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-completed-1.json")) {
          return JSON.stringify({
            id: "run-completed-1",
            status: "completed",
            endedAt: completedEndedAt,
            data: {
              _dagState: {
                status: "completed",
                endedAt: completedEndedAt,
              },
            },
          });
        }
        return "";
      });

      const patch = ex._buildRecoveredWorkflowStatePatch({
        topology: {
          workflowId: "template-task-lifecycle",
          workflowName: "Task Lifecycle",
          latestNodeId: "run-agent-implement",
          latestRunId: "run-stale-1",
          rootRunId: "run-root-1",
          parentRunId: "run-parent-1",
          latestSessionId: "session-current-1",
          sessionId: "session-current-1",
          rootSessionId: "session-root-1",
          parentSessionId: "session-parent-1",
          delegationDepth: 1,
        },
        workflowRuns: [
          {
            runId: "run-stale-1",
            status: "running",
            outcome: "running",
            summary: "workflow.run.start",
          },
          {
            runId: "run-completed-1",
            status: "running",
            outcome: "running",
            summary: "workflow.run.start",
          },
        ],
      });

      expect(patch).toEqual(expect.objectContaining({
        topology: expect.objectContaining({
          workflowId: null,
          workflowName: null,
          latestNodeId: null,
          latestRunId: null,
          latestSessionId: null,
          sessionId: null,
          rootSessionId: null,
          parentSessionId: null,
          delegationDepth: 0,
        }),
      }));
      expect(patch.workflowRuns).toEqual([
        expect.objectContaining({
          runId: "run-stale-1",
          status: "stale",
          outcome: "stale",
        }),
        expect.objectContaining({
          runId: "run-completed-1",
          status: "completed",
          outcome: "completed",
          endedAt: completedEndedAt,
        }),
      ]);
    });

    it("resets workflow-owned tasks whose shared-state claim is stale and no thread is alive", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: true });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-stale-claim-1",
          title: "Workflow-owned stale claim",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-deadbeef",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-stale-claim-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(invalidateThread).toHaveBeenCalledWith("wf-stale-claim-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("resets workflow-owned tasks when a stale workflow claim is masked by a lingering thread record", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: true });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-stale-thread-1",
          title: "Workflow-owned stale claim with thread record",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([
        { taskKey: "wf-stale-thread-1" },
      ]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-dead-thread-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-stale-thread-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-stale-thread-1",
        force: true,
      });
      expect(invalidateThread).toHaveBeenCalledWith("wf-stale-thread-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("keeps workflow-owned tasks in progress when stale shared state still has an active workflow run", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-stale-active-run-1",
          title: "Workflow-owned stale claim with active run",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-stale-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      existsSync.mockImplementation(
        (targetPath) => [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-active-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([
            {
              runId: "run-active-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-stale-active-run-1",
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "run-active-1.json")) {
          return JSON.stringify({
            id: "run-active-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              taskId: "wf-stale-active-run-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-stale-active-run-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalledWith({
        taskId: "wf-stale-active-run-1",
        force: true,
      });
      expect(invalidateThread).not.toHaveBeenCalledWith("wf-stale-active-run-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("falls back to repo-local workflow runs when the configured workspace mirror is stale", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs-mirror",
        repoRoot: "/repo-root",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-repo-fallback-1",
          title: "Workflow-owned task with repo-local run evidence",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs-mirror", "_active-runs.json"),
          resolve("/repo-root", ".bosun", "workflow-runs", "_active-runs.json"),
          resolve("/repo-root", ".bosun", "workflow-runs", "run-repo-fallback-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs-mirror", "_active-runs.json")) {
          return JSON.stringify([]);
        }
        if (
          targetPath ===
          resolve("/repo-root", ".bosun", "workflow-runs", "_active-runs.json")
        ) {
          return JSON.stringify([
            {
              runId: "run-repo-fallback-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-repo-fallback-1",
              startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            },
          ]);
        }
        if (
          targetPath ===
          resolve("/repo-root", ".bosun", "workflow-runs", "run-repo-fallback-1.json")
        ) {
          return JSON.stringify({
            id: "run-repo-fallback-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              taskId: "wf-repo-fallback-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-repo-fallback-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-missing-workflow-run",
        }),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalledWith({
        taskId: "wf-repo-fallback-1",
        force: true,
      });
      expect(invalidateThread).not.toHaveBeenCalledWith("wf-repo-fallback-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("re-reads live workflow evidence before resetting a stale shared-state claim", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-stale-refresh-1",
          title: "Workflow-owned stale claim refreshed from disk",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-stale-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      existsSync.mockImplementation(
        (targetPath) => [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "run-refresh-1.json"),
        ].includes(targetPath),
      );
      let activeRunsReads = 0;
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          activeRunsReads += 1;
          if (activeRunsReads === 1) return JSON.stringify([]);
          return JSON.stringify([
            {
              runId: "run-refresh-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-stale-refresh-1",
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "run-refresh-1.json")) {
          return JSON.stringify({
            id: "run-refresh-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              taskId: "wf-stale-refresh-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 30 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(activeRunsReads).toBeGreaterThanOrEqual(2);
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-stale-refresh-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalledWith({
        taskId: "wf-stale-refresh-1",
        force: true,
      });
      expect(invalidateThread).not.toHaveBeenCalledWith("wf-stale-refresh-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("keeps workflow-owned tasks in progress when duplicate same-task runs contain a newer live history entry", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-duplicate-live-1",
          title: "Workflow-owned duplicate same-task run evidence",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
          topology: {
            latestRunId: "run-thin-detail-1",
          },
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-stale-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "index.json"),
          resolve("/workflow-runs", "run-thin-detail-1.json"),
          resolve("/workflow-runs", "run-live-history-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([
            {
              runId: "run-thin-detail-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-duplicate-live-1",
              startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            },
            {
              runId: "run-live-history-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-duplicate-live-1",
              startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            },
            {
              runId: "run-placeholder-1",
              workflowId: "template-task-lifecycle",
              taskId: "{{taskId}}",
              startedAt: new Date().toISOString(),
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "index.json")) {
          return JSON.stringify({
            runs: [
              {
                runId: "run-thin-detail-1",
                taskId: "wf-duplicate-live-1",
                status: "running",
                startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
              },
              {
                runId: "run-live-history-1",
                taskId: "wf-duplicate-live-1",
                status: "running",
                startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
                updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              },
              {
                runId: "run-placeholder-1",
                taskId: "{{taskId}}",
                status: "running",
                startedAt: new Date().toISOString(),
              },
            ],
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-thin-detail-1.json")) {
          return JSON.stringify({
            id: "run-thin-detail-1",
            startedAt: Date.now() - 30 * 60 * 1000,
            endedAt: null,
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-live-history-1.json")) {
          return JSON.stringify({
            id: "run-live-history-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      const summary = await ex._recoverInterruptedInProgressTasks("startup");

      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "wf-duplicate-live-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(releaseTaskClaim).not.toHaveBeenCalledWith({
        taskId: "wf-duplicate-live-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(summary.workflowEvidenceKept).toEqual([
        expect.objectContaining({
          taskId: "wf-duplicate-live-1",
          runId: "run-live-history-1",
          reason: "stale_shared_claim",
        }),
      ]);
    });

    it("does not treat carried taskIds arrays in active-runs as authoritative workflow evidence", async () => {
      const ex = new TaskExecutor({
        projectId: "proj-1",
        maxParallel: 2,
        workflowOwnsTaskLifecycle: true,
        workflowRunsDir: "/workflow-runs",
      });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-array-carryover-1",
          title: "Workflow-owned carried taskIds array should not count",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-stale-owner",
        ownerHeartbeat: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      });
      existsSync.mockImplementation((targetPath) =>
        [
          resolve("/workflow-runs", "_active-runs.json"),
          resolve("/workflow-runs", "index.json"),
          resolve("/workflow-runs", "run-other-task-1.json"),
        ].includes(targetPath),
      );
      readFileSync.mockImplementation((targetPath) => {
        if (targetPath === resolve("/workflow-runs", "_active-runs.json")) {
          return JSON.stringify([
            {
              runId: "run-other-task-1",
              workflowId: "template-task-lifecycle",
              taskId: "wf-other-task-1",
              taskIds: [
                "wf-other-task-1",
                "wf-array-carryover-1",
              ],
              startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            },
          ]);
        }
        if (targetPath === resolve("/workflow-runs", "index.json")) {
          return JSON.stringify({
            runs: [
              {
                runId: "run-other-task-1",
                taskId: "wf-other-task-1",
                status: "running",
                startedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
              },
            ],
          });
        }
        if (targetPath === resolve("/workflow-runs", "run-other-task-1.json")) {
          return JSON.stringify({
            id: "run-other-task-1",
            startedAt: Date.now() - 2 * 60 * 1000,
            endedAt: null,
            data: {
              taskId: "wf-other-task-1",
              _dagState: {
                status: "running",
                updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
              },
            },
          });
        }
        return "";
      });

      const summary = await ex._recoverInterruptedInProgressTasks("startup");

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-array-carryover-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(releaseTaskClaim).toHaveBeenCalledWith({
        taskId: "wf-array-carryover-1",
        force: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
      expect(summary.workflowEvidenceKept).toEqual([]);
    });

    it("resets workflow-owned tasks when a fresh shared-state claim belongs to a dead local pid", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: true });
      ex._running = true;
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(() => {
          throw new Error("ESRCH");
        });

      listTasks.mockResolvedValueOnce([
        {
          id: "wf-dead-pid-1",
          title: "Workflow-owned dead local claim",
          status: "inprogress",
          updated_at: new Date().toISOString(),
          agentAttempts: 1,
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);
      getSharedState.mockResolvedValueOnce({
        ownerId: "wf-live-heartbeat",
        ownerHeartbeat: new Date().toISOString(),
      });
      getClaim.mockResolvedValueOnce({
        instance_id: "wf-live-heartbeat",
        metadata: {
          host: os.hostname(),
          pid: 987654,
        },
      });
      getPresenceState.mockReturnValue({
        instance_id: "presence-instance-1",
        coordinator_priority: 100,
      });

      await ex._recoverInterruptedInProgressTasks();

      expect(killSpy).toHaveBeenCalledWith(987654, 0);
      expect(updateTaskStatus).toHaveBeenCalledWith(
        "wf-dead-pid-1",
        "todo",
        expect.objectContaining({
          source: "task-executor-recovery-stale-workflow-claim",
        }),
      );
      expect(invalidateThread).toHaveBeenCalledWith("wf-dead-pid-1");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not resume in-progress tasks already blocked for no-commit thrash", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-1", 3);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-1",
          title: "Blocked task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("still resumes in-progress tasks when no-commit count is below block threshold", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2, workflowOwnsTaskLifecycle: false });
      ex._running = true;
      ex._noCommitCounts.set("resume-2", 2);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "resume-2",
          title: "Still eligible",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await ex._recoverInterruptedInProgressTasks();

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: "resume-2" }),
        expect.objectContaining({ recoveredFromInProgress: true }),
      );
      expect(updateTaskStatus).not.toHaveBeenCalledWith(
        "resume-2",
        "todo",
        expect.any(Object),
      );
    });

    it("keeps no-commit block precedence even when a resumable thread exists", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-thread-1", 3);
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-thread-1",
          title: "Blocked with thread",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([
        { taskKey: "blocked-thread-1" },
      ]);

      await ex._recoverInterruptedInProgressTasks();

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-thread-1",
        "todo",
        expect.any(Object),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does not crash recovery when resetting blocked no-commit task fails", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      ex._running = true;
      ex._noCommitCounts.set("blocked-err-1", 3);
      ex._slotRuntimeState.set("blocked-err-1", {
        taskId: "blocked-err-1",
        taskTitle: "Blocked task",
        branch: "ve/blocked-err-1",
        sdk: "codex",
        attempt: 0,
        startedAt: Date.now(),
        status: "running",
      });
      const executeSpy = vi
        .spyOn(ex, "executeTask")
        .mockResolvedValue(undefined);
      updateTaskStatus.mockRejectedValueOnce(new Error("backend unavailable"));

      listTasks.mockResolvedValueOnce([
        {
          id: "blocked-err-1",
          title: "Blocked task",
          status: "inprogress",
          updated_at: new Date().toISOString(),
        },
      ]);
      getActiveThreads.mockReturnValueOnce([]);

      await expect(ex._recoverInterruptedInProgressTasks()).resolves.toEqual(
        expect.objectContaining({
          scannedCount: 1,
          skippedForNoCommitBlockCount: 1,
        }),
      );

      expect(updateTaskStatus).toHaveBeenCalledWith(
        "blocked-err-1",
        "todo",
        expect.any(Object),
      );
      expect(ex._slotRuntimeState.has("blocked-err-1")).toBe(false);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("clears persisted anti-thrash state when manually reset", async () => {
      const ex = new TaskExecutor({ projectId: "proj-1", maxParallel: 2 });
      const saveSpy = vi.spyOn(ex, "_saveNoCommitState").mockImplementation(() => {});

      ex._noCommitCounts.set("throttle-1", 3);
      ex._skipUntil.set("throttle-1", Date.now() + 60_000);
      ex._taskCooldowns.set("throttle-1", Date.now());
      ex._idleContinueCounts.set("throttle-1", 2);
      ex._repoAreaBlockedTasks.set("throttle-1", {
        blockedAt: Date.now(),
        lastObservedWaitMs: 1000,
        areas: ["ui"],
      });

      const changed = ex.resetTaskThrottleState("throttle-1");

      expect(changed).toBe(true);
      expect(ex._noCommitCounts.has("throttle-1")).toBe(false);
      expect(ex._skipUntil.has("throttle-1")).toBe(false);
      expect(ex._taskCooldowns.has("throttle-1")).toBe(false);
      expect(ex._idleContinueCounts.has("throttle-1")).toBe(false);
      expect(ex._repoAreaBlockedTasks.has("throttle-1")).toBe(false);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // _pollLoop guards
  // [LEGACY TESTS REMOVED] "_pollLoop guards" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "claim renewal helpers" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // executeTask
  // [LEGACY TESTS REMOVED] "executeTask" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "prompt enrichment" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "backlog replenishment diagnostics" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // [LEGACY TESTS REMOVED] "planner result handling" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // loadExecutorOptionsFromConfig
  // [LEGACY TESTS REMOVED] "anti-thrash key normalization" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  describe("loadExecutorOptionsFromConfig", () => {
    it("returns defaults when nothing configured", () => {
      loadConfig.mockReturnValue({});
      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(5);
      expect(opts.sdk).toBe("auto");
      expect(opts.maxRetries).toBe(2);
    });

    it("reads from env vars", () => {
      process.env.EXECUTOR_MODE = "internal";
      process.env.INTERNAL_EXECUTOR_PARALLEL = "8";
      process.env.INTERNAL_EXECUTOR_SDK = "copilot";
      loadConfig.mockReturnValue({});

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(8);
      expect(opts.sdk).toBe("copilot");
    });

    it("reads repo area parallel limit from env and config", () => {
      process.env.INTERNAL_EXECUTOR_REPO_AREA_PARALLEL = "3";
      loadConfig.mockReturnValue({
        internalExecutor: {
          repoAreaParallelLimit: 2,
        },
      });

      const fromEnv = loadExecutorOptionsFromConfig();
      expect(fromEnv.repoAreaParallelLimit).toBe(3);

      delete process.env.INTERNAL_EXECUTOR_REPO_AREA_PARALLEL;
      const fromConfig = loadExecutorOptionsFromConfig();
      expect(fromConfig.repoAreaParallelLimit).toBe(2);
    });

    it("reads from config.internalExecutor", () => {
      loadConfig.mockReturnValue({
        internalExecutor: {
          mode: "hybrid",
          maxParallel: 4,
          sdk: "claude",
          maxRetries: 5,
        },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("hybrid");
      expect(opts.maxParallel).toBe(4);
      expect(opts.sdk).toBe("claude");
      expect(opts.maxRetries).toBe(5);
    });

    it("env vars take priority over config", () => {
      process.env.EXECUTOR_MODE = "internal";
      process.env.INTERNAL_EXECUTOR_PARALLEL = "10";
      loadConfig.mockReturnValue({
        internalExecutor: {
          mode: "hybrid",
          maxParallel: 2,
        },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(10);
    });

    it("validates mode values — uses env when set", () => {
      process.env.EXECUTOR_MODE = "hybrid";
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("hybrid");
    });

    it("reads from config.taskExecutor as fallback key", () => {
      loadConfig.mockReturnValue({
        taskExecutor: { mode: "internal", maxParallel: 6 },
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(6);
    });

    it("handles loadConfig throwing", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("config missing");
      });

      const opts = loadExecutorOptionsFromConfig();
      expect(opts.mode).toBe("internal");
      expect(opts.maxParallel).toBe(5);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // isInternalExecutorEnabled
  // ────────────────────────────────────────────────────────────────────────

  describe("isInternalExecutorEnabled", () => {
    it("returns true for EXECUTOR_MODE=internal", () => {
      process.env.EXECUTOR_MODE = "internal";
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns true for EXECUTOR_MODE=hybrid", () => {
      process.env.EXECUTOR_MODE = "hybrid";
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns false when nothing configured", () => {
      loadConfig.mockReturnValue({});
      expect(isInternalExecutorEnabled()).toBe(false);
    });

    it("falls back to config when env var not set", () => {
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("falls back to config.taskExecutor", () => {
      loadConfig.mockReturnValue({
        taskExecutor: { mode: "hybrid" },
      });
      expect(isInternalExecutorEnabled()).toBe(true);
    });

    it("returns false when loadConfig throws", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("oops");
      });
      expect(isInternalExecutorEnabled()).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getExecutorMode
  // ────────────────────────────────────────────────────────────────────────

  describe("getExecutorMode", () => {
    it("returns env EXECUTOR_MODE when valid", () => {
      process.env.EXECUTOR_MODE = "internal";
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns hybrid from env", () => {
      process.env.EXECUTOR_MODE = "hybrid";
      expect(getExecutorMode()).toBe("hybrid");
    });

    it("falls through to config when env invalid", () => {
      process.env.EXECUTOR_MODE = "bogus";
      loadConfig.mockReturnValue({
        internalExecutor: { mode: "internal" },
      });
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns 'internal' as default", () => {
      loadConfig.mockReturnValue({});
      expect(getExecutorMode()).toBe("internal");
    });

    it("returns 'internal' when loadConfig throws", () => {
      loadConfig.mockImplementation(() => {
        throw new Error("fail");
      });
      expect(getExecutorMode()).toBe("internal");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // branch safety guard
  // [LEGACY TESTS REMOVED] "branch safety guard" — replaced by workflow node tests
  // See tests/workflow-task-lifecycle.test.mjs
  // ────────────────────────────────────────────────────────────────────────
  // getTaskExecutor singleton
  // ────────────────────────────────────────────────────────────────────────

  describe("getTaskExecutor singleton", () => {
    // The module-level _instance can't be reset without vi.resetModules().
    // We test basic behavior and then re-import for isolation.

    it("returns a TaskExecutor instance", async () => {
      // Use dynamic import with resetModules to get a fresh module
      vi.resetModules();

      // Re-apply mocks for the fresh module
      vi.doMock("../kanban-adapter.mjs", () => ({
        getKanbanAdapter: vi.fn(),
        listTasks: vi.fn(() => []),
        listProjects: vi.fn(() => []),
        getTask: vi.fn(),
        updateTaskStatus: vi.fn(),
      }));
      vi.doMock("../agent-pool.mjs", () => ({
        launchOrResumeThread: vi.fn(),
        execWithRetry: vi.fn(() => Promise.resolve({ success: true })),
        invalidateThread: vi.fn(),
        getActiveThreads: vi.fn(() => []),
        getPoolSdkName: vi.fn(() => "codex"),
      }));
      vi.doMock("../worktree-manager.mjs", () => ({
        acquireWorktree: vi.fn(),
        releaseWorktree: vi.fn(),
        getWorktreeStats: vi.fn(() => ({ active: 0, total: 0 })),
      }));
      vi.doMock("../config.mjs", () => ({
        loadConfig: vi.fn(() => ({})),
      }));
      vi.doMock("node:child_process", () => ({
        execSync: vi.fn(() => ""),
        spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      }));
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal();
        return {
          ...actual,
          readFileSync: vi.fn(() => ""),
          existsSync: vi.fn(() => false),
        };
      });

      const mod = await import("../task/task-executor.mjs");
      const inst = mod.getTaskExecutor({ mode: "internal" });
      expect(inst).toBeInstanceOf(mod.TaskExecutor);
    });

    it("returns same instance on second call", async () => {
      vi.resetModules();

      vi.doMock("../kanban-adapter.mjs", () => ({
        getKanbanAdapter: vi.fn(),
        listTasks: vi.fn(() => []),
        listProjects: vi.fn(() => []),
        getTask: vi.fn(),
        updateTaskStatus: vi.fn(),
      }));
      vi.doMock("../agent-pool.mjs", () => ({
        launchOrResumeThread: vi.fn(),
        execWithRetry: vi.fn(() => Promise.resolve({ success: true })),
        invalidateThread: vi.fn(),
        getActiveThreads: vi.fn(() => []),
        getPoolSdkName: vi.fn(() => "codex"),
      }));
      vi.doMock("../worktree-manager.mjs", () => ({
        acquireWorktree: vi.fn(),
        releaseWorktree: vi.fn(),
        getWorktreeStats: vi.fn(() => ({ active: 0, total: 0 })),
      }));
      vi.doMock("../config.mjs", () => ({
        loadConfig: vi.fn(() => ({})),
      }));
      vi.doMock("node:child_process", () => ({
        execSync: vi.fn(() => ""),
        spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      }));
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal();
        return {
          ...actual,
          readFileSync: vi.fn(() => ""),
          existsSync: vi.fn(() => false),
        };
      });

      const mod = await import("../task/task-executor.mjs");
      const first = mod.getTaskExecutor({ mode: "internal" });
      const second = mod.getTaskExecutor({ mode: "hybrid" });
      expect(first).toBe(second);
      // Mode should be from the first call
      expect(first.mode).toBe("internal");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Legacy stubs — verify gutted methods return expected no-op values
  // ────────────────────────────────────────────────────────────────────────

describe("legacy method stubs", () => {
    it("executeTask dispatches workflow-owned lifecycle via onTaskStarted hook", async () => {
      const onTaskStarted = vi.fn();
      const ex = new TaskExecutor({ onTaskStarted, workflowOwnsTaskLifecycle: true });
      const result = await ex.executeTask({ id: "test-1", title: "Test" });
      expect(result).toMatchObject({
        queued: false,
        started: true,
        dispatched: true,
        mode: "workflow-owned",
        taskId: "test-1",
      });
      expect(onTaskStarted).toHaveBeenCalledTimes(1);
      const [taskArg, slotArg] = onTaskStarted.mock.calls[0];
      expect(taskArg).toMatchObject({ id: "test-1", title: "Test" });
      expect(slotArg).toMatchObject({
        taskId: "test-1",
        taskTitle: "Test",
        sdk: "auto",
        status: "running",
        attempt: 1,
      });
    });

    it("executeTask returns legacy_removed stub when workflow lifecycle ownership is disabled", async () => {
      const ex = new TaskExecutor({ workflowOwnsTaskLifecycle: false });
      const result = await ex.executeTask({ id: "test-1", title: "Test" });
      expect(result).toEqual({ skipped: true, reason: "legacy_removed" });
    });

    it("_pollLoop is a no-op", async () => {
      const ex = new TaskExecutor();
      ex._running = true;
      await ex._pollLoop();
      // Should return without error
      expect(listTasks).not.toHaveBeenCalled();
    });

    it("_buildTaskPrompt returns empty string", () => {
      const ex = new TaskExecutor();
      expect(ex._buildTaskPrompt({}, "/fake")).toBe("");
    });

    it("_pushBranch returns legacy_removed", () => {
      const ex = new TaskExecutor();
      const result = ex._pushBranch("/fake", "branch");
      expect(result).toEqual({ success: false, reason: "legacy_removed" });
    });

    it("_hasUnpushedCommits returns false", () => {
      const ex = new TaskExecutor();
      expect(ex._hasUnpushedCommits("/fake")).toBe(false);
    });

    it("_shouldAutoResume returns false", () => {
      const ex = new TaskExecutor();
      expect(ex._shouldAutoResume("t1", "test")).toBe(false);
    });

    it("_createPR returns null", async () => {
      const ex = new TaskExecutor();
      expect(await ex._createPR({}, "/fake")).toBeNull();
    });
  });

  // [LEGACY TESTS REMOVED] — All execution pipeline tests have been replaced
  // by comprehensive workflow node tests in tests/workflow-task-lifecycle.test.mjs
});
