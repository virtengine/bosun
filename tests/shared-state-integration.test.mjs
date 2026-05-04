import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("shared-state-integration", () => {
  let tempRoot = null;
  let sharedStateManager;
  let kanbanAdapter;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "shared-state-integration-"));
    vi.clearAllMocks();

    // Mock config for kanban adapter
    vi.doMock("../config.mjs", () => ({
      loadConfig: vi.fn(() => ({
        repoSlug: "acme/widgets",
        kanban: { backend: "github" },
      })),
    }));

    // Import modules
    sharedStateManager = await import("../workspace/shared-state-manager.mjs");
    const kanbanModule = await import("../kanban/kanban-adapter.mjs");
    kanbanModule.setKanbanBackend("github");
    kanbanAdapter = kanbanModule.getKanbanAdapter();
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
    vi.doUnmock("../config.mjs");
  });

  function mockGh(stdout, stderr = "") {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(null, { stdout, stderr });
    });
  }

  function mockGhError(error) {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(error);
    });
  }

  describe("end-to-end flow: claim -> work -> heartbeat -> release", () => {
    it("completes full lifecycle with local and GitHub sync", async () => {
      const taskId = "42";
      const ownerId = "agent-1/workstation-1";
      const attemptToken = "token-123";

      // Step 1: Claim task in shared state
      const claimResult = await sharedStateManager.claimTaskInSharedState(
        taskId,
        ownerId,
        attemptToken,
        300,
        tempRoot,
      );

      expect(claimResult.success).toBe(true);
      expect(claimResult.state.attemptStatus).toBe("claimed");

      // Step 2: Persist to GitHub
      mockGh(JSON.stringify([])); // Get labels
      mockGh("✓ Labels updated"); // Update labels
      mockGh(JSON.stringify([])); // Get comments
      mockGh(JSON.stringify({ id: 123, body: "Comment" })); // Create comment

      const persistResult = await kanbanAdapter.persistSharedStateToIssue(
        taskId,
        {
          taskId,
          ownerId,
          attemptToken,
          attemptStarted: claimResult.state.attemptStarted,
          heartbeat: claimResult.state.ownerHeartbeat,
          status: "claimed",
          retryCount: 0,
        },
      );

      expect(persistResult).toBe(true);

      // Step 3: Simulate work with heartbeat renewal
      await new Promise((resolve) => setTimeout(resolve, 100));

      const renewResult = await sharedStateManager.renewSharedStateHeartbeat(
        taskId,
        ownerId,
        attemptToken,
        tempRoot,
      );

      expect(renewResult.success).toBe(true);

      // Step 4: Update GitHub with new heartbeat
      mockGh(JSON.stringify(["codex:claimed"])); // Get labels
      mockGh("✓ Labels updated"); // Update labels to working
      mockGh(
        JSON.stringify([
          {
            id: 123,
            body: "Old state comment",
          },
        ]),
      ); // Get comments
      mockGh(JSON.stringify({ id: 123, body: "Updated" })); // Update comment

      const updatedState = await sharedStateManager.getSharedState(
        taskId,
        tempRoot,
      );
      const updateResult = await kanbanAdapter.persistSharedStateToIssue(
        taskId,
        {
          taskId,
          ownerId,
          attemptToken,
          attemptStarted: updatedState.attemptStarted,
          heartbeat: updatedState.ownerHeartbeat,
          status: "working",
          retryCount: 0,
        },
      );

      expect(updateResult).toBe(true);

      // Step 5: Complete task
      const releaseResult = await sharedStateManager.releaseSharedState(
        taskId,
        attemptToken,
        "complete",
        undefined,
        tempRoot,
      );

      expect(releaseResult.success).toBe(true);

      // Verify final state
      const finalState = await sharedStateManager.getSharedState(
        taskId,
        tempRoot,
      );
      expect(finalState.attemptStatus).toBe("complete");
      expect(finalState.eventLog.length).toBeGreaterThanOrEqual(3);
      expect(finalState.eventLog.map((e) => e.event)).toContain("claimed");
      expect(finalState.eventLog.map((e) => e.event)).toContain("renewed");
      expect(finalState.eventLog.map((e) => e.event)).toContain("released");
    });

    it("handles failure with error tracking", async () => {
      const taskId = "43";
      const ownerId = "agent-2/workstation-2";
      const attemptToken = "token-456";

      // Claim task
      await sharedStateManager.claimTaskInSharedState(
        taskId,
        ownerId,
        attemptToken,
        300,
        tempRoot,
      );

      // Renew heartbeat
      await sharedStateManager.renewSharedStateHeartbeat(
        taskId,
        ownerId,
        attemptToken,
        tempRoot,
      );

      // Release as failed with error
      const errorMessage = "Build compilation error: undefined variable";
      const releaseResult = await sharedStateManager.releaseSharedState(
        taskId,
        attemptToken,
        "failed",
        errorMessage,
        tempRoot,
      );

      expect(releaseResult.success).toBe(true);

      // Verify error is tracked
      const state = await sharedStateManager.getSharedState(taskId, tempRoot);
      expect(state.attemptStatus).toBe("failed");
      expect(state.lastError).toBe(errorMessage);

      // Next attempt should preserve error
      const retryResult = await sharedStateManager.claimTaskInSharedState(
        taskId,
        "agent-3/workstation-3",
        "token-retry",
        300,
        tempRoot,
      );

      expect(retryResult.success).toBe(true);
      expect(retryResult.state.lastError).toBe(errorMessage);
      expect(retryResult.state.retryCount).toBe(1);
    });
  });

  describe("multi-agent conflict scenario", () => {
    it("prevents concurrent claims when first agent is active", async () => {
      const taskId = "44";
      const agent1 = "agent-1/workstation-1";
      const agent2 = "agent-2/workstation-2";

      // Agent 1 claims task
      const claim1 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        300,
        tempRoot,
      );

      expect(claim1.success).toBe(true);

      // Agent 2 tries to claim same task
      const claim2 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent2,
        "token-2",
        300,
        tempRoot,
      );

      expect(claim2.success).toBe(false);
      expect(claim2.reason).toContain("conflict");
      expect(claim2.reason).toContain("existing_owner_active");
      expect(claim2.state.ownerId).toBe(agent1);
    });

    it("allows takeover when first agent becomes stale", async () => {
      const taskId = "45";
      const agent1 = "agent-1/workstation-1";
      const agent2 = "agent-2/workstation-2";

      // Agent 1 claims task with short TTL
      const claim1 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        1, // 1 second TTL
        tempRoot,
      );

      expect(claim1.success).toBe(true);

      // Persist to GitHub
      mockGh(JSON.stringify([]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 100, body: "Comment" }));

      await kanbanAdapter.persistSharedStateToIssue(taskId, {
        taskId,
        ownerId: agent1,
        attemptToken: "token-1",
        attemptStarted: claim1.state.attemptStarted,
        heartbeat: claim1.state.ownerHeartbeat,
        status: "claimed",
        retryCount: 0,
      });

      // Wait for staleness
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Agent 2 detects stale state and takes over
      const claim2 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent2,
        "token-2",
        300,
        tempRoot,
      );

      expect(claim2.success).toBe(true);
      expect(claim2.state.ownerId).toBe(agent2);
      expect(claim2.state.retryCount).toBe(1);

      // Verify conflict was logged
      const conflictEvent = claim2.state.eventLog.find(
        (e) => e.event === "conflict",
      );
      expect(conflictEvent).toBeDefined();
      expect(conflictEvent.details).toContain("takeover");
    });

    it("coordinates through GitHub state comments", async () => {
      const taskId = "46";
      const agent1 = "agent-1/workstation-1";
      const agent2 = "agent-2/workstation-2";

      // Agent 1 claims and persists
      await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        300,
        tempRoot,
      );

      mockGh(JSON.stringify([]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 100, body: "Comment" }));

      const state1 = await sharedStateManager.getSharedState(taskId, tempRoot);
      await kanbanAdapter.persistSharedStateToIssue(taskId, {
        taskId,
        ownerId: agent1,
        attemptToken: "token-1",
        attemptStarted: state1.attemptStarted,
        heartbeat: state1.ownerHeartbeat,
        status: "working",
        retryCount: 0,
      });

      // Agent 2 reads state from GitHub
      mockGh(
        JSON.stringify([
          {
            id: 100,
            body: `<!-- bosun-state
${JSON.stringify({
  taskId,
  ownerId: agent1,
  attemptToken: "token-1",
  attemptStarted: state1.attemptStarted,
  heartbeat: state1.ownerHeartbeat,
  status: "working",
  retryCount: 0,
})}
-->
Status`,
          },
        ]),
      );

      const githubState = await kanbanAdapter.readSharedStateFromIssue(taskId);

      expect(githubState).toBeDefined();
      expect(githubState.ownerId).toBe(agent1);
      expect(githubState.status).toBe("working");

      // Agent 2 respects active claim
      const claim2 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent2,
        "token-2",
        300,
        tempRoot,
      );

      expect(claim2.success).toBe(false);
    });
  });

  describe("recovery scenario: stale task sweep and reclaim", () => {
    it("sweeps stale task and allows reclaim", async () => {
      const taskId = "47";
      const agent1 = "agent-1/workstation-1";
      const agent2 = "agent-2/workstation-2";

      // Agent 1 claims task
      await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        1,
        tempRoot,
      );

      // Wait for staleness
      await new Promise((resolve) => setTimeout(resolve, 1500));

      // Sweep stale states
      const sweepResult = await sharedStateManager.sweepStaleSharedStates(
        1000,
        tempRoot,
      );

      expect(sweepResult.sweptCount).toBe(1);
      expect(sweepResult.abandonedTasks).toContain(taskId);

      // Verify task is marked as abandoned
      const state = await sharedStateManager.getSharedState(taskId, tempRoot);
      expect(state.attemptStatus).toBe("abandoned");

      // Agent 2 can now claim abandoned task
      const claim2 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent2,
        "token-2",
        300,
        tempRoot,
      );

      expect(claim2.success).toBe(true);
      expect(claim2.state.ownerId).toBe(agent2);
      expect(claim2.state.retryCount).toBe(1);
    });

    it("tracks abandonment in GitHub", async () => {
      const taskId = "48";
      const agent1 = "agent-1/workstation-1";

      // Claim and persist
      await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        1,
        tempRoot,
      );

      mockGh(JSON.stringify([]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 100, body: "Comment" }));

      const state = await sharedStateManager.getSharedState(taskId, tempRoot);
      await kanbanAdapter.persistSharedStateToIssue(taskId, {
        taskId,
        ownerId: agent1,
        attemptToken: "token-1",
        attemptStarted: state.attemptStarted,
        heartbeat: state.ownerHeartbeat,
        status: "claimed",
        retryCount: 0,
      });

      // Wait and sweep
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await sharedStateManager.sweepStaleSharedStates(1000, tempRoot);

      // Update GitHub with abandoned status
      mockGh(JSON.stringify(["codex:claimed"]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([{ id: 100, body: "Old comment" }]));
      mockGh(JSON.stringify({ id: 100, body: "Updated" }));

      const abandonedState = await sharedStateManager.getSharedState(
        taskId,
        tempRoot,
      );
      await kanbanAdapter.persistSharedStateToIssue(taskId, {
        taskId,
        ownerId: agent1,
        attemptToken: "token-1",
        attemptStarted: abandonedState.attemptStarted,
        heartbeat: abandonedState.ownerHeartbeat,
        status: "stale",
        retryCount: 0,
      });

      // Verify GitHub was updated
      expect(execFileMock).toHaveBeenCalled();
      const labelCall = execFileMock.mock.calls.find((c) =>
        c[1]?.includes("codex:stale"),
      );
      expect(labelCall).toBeDefined();
    });
  });

  describe("ignore flag prevents retry", () => {
    it("prevents claim of ignored task", async () => {
      const taskId = "49";

      // Mark task as ignored
      const ignoreResult = await sharedStateManager.setIgnoreFlag(
        taskId,
        "human_created",
        tempRoot,
      );

      expect(ignoreResult.success).toBe(true);

      // Attempt to claim should fail
      const claimResult = await sharedStateManager.claimTaskInSharedState(
        taskId,
        "agent-1/workstation-1",
        "token-1",
        300,
        tempRoot,
      );

      expect(claimResult.success).toBe(false);
      expect(claimResult.reason).toContain("task_ignored");
    });

    it("syncs ignore flag to GitHub", async () => {
      const taskId = "50";

      // Set ignore flag
      await sharedStateManager.setIgnoreFlag(
        taskId,
        "requires_manual_review",
        tempRoot,
      );

      // Mark as ignored in GitHub
      mockGh("✓ Label added");
      mockGh(JSON.stringify({ id: 123, body: "Ignored comment" }));

      const result = await kanbanAdapter.markTaskIgnored(
        taskId,
        "requires_manual_review",
      );

      expect(result).toBe(true);

      // Verify label was added
      const labelCall = execFileMock.mock.calls.find((c) =>
        c[1]?.includes("codex:ignore"),
      );
      expect(labelCall).toBeDefined();
    });

    it("prevents retry when ignore flag is set", async () => {
      const taskId = "51";

      await sharedStateManager.setIgnoreFlag(taskId, "invalid_spec", tempRoot);

      const retryCheck = await sharedStateManager.shouldRetryTask(
        taskId,
        3,
        tempRoot,
      );

      expect(retryCheck.shouldRetry).toBe(false);
      expect(retryCheck.reason).toContain("ignored");
    });

    it("allows retry after clearing ignore flag", async () => {
      const taskId = "52";

      // Set and clear ignore flag
      await sharedStateManager.setIgnoreFlag(taskId, "test", tempRoot);
      await sharedStateManager.clearIgnoreFlag(taskId, tempRoot);

      // Should now allow retry
      const retryCheck = await sharedStateManager.shouldRetryTask(
        taskId,
        3,
        tempRoot,
      );

      expect(retryCheck.shouldRetry).toBe(true);
    });
  });

  describe("max retries exhaustion", () => {
    it("prevents retry after max attempts", async () => {
      const taskId = "53";
      const maxRetries = 3;

      // Simulate multiple failed attempts
      for (let i = 0; i <= maxRetries; i++) {
        await sharedStateManager.claimTaskInSharedState(
          taskId,
          `agent-${i}/workstation-${i}`,
          `token-${i}`,
          300,
          tempRoot,
        );

        await sharedStateManager.releaseSharedState(
          taskId,
          `token-${i}`,
          "failed",
          `Attempt ${i} failed`,
          tempRoot,
        );
      }

      // Check retry eligibility
      const retryCheck = await sharedStateManager.shouldRetryTask(
        taskId,
        maxRetries,
        tempRoot,
      );

      expect(retryCheck.shouldRetry).toBe(false);
      expect(retryCheck.reason).toContain("max_retries_exceeded");
      expect(retryCheck.reason).toContain(`${maxRetries}/${maxRetries}`);
    });

    it("marks exhausted task in GitHub", async () => {
      const taskId = "54";
      const maxRetries = 2;

      // Exhaust retries
      for (let i = 0; i <= maxRetries; i++) {
        await sharedStateManager.claimTaskInSharedState(
          taskId,
          `agent-${i}/workstation-${i}`,
          `token-${i}`,
          300,
          tempRoot,
        );

        await sharedStateManager.releaseSharedState(
          taskId,
          `token-${i}`,
          "failed",
          "Test failure",
          tempRoot,
        );
      }

      // Mark as ignored in GitHub
      mockGh("✓ Label added");
      mockGh(JSON.stringify({ id: 123, body: "Ignored" }));

      await kanbanAdapter.markTaskIgnored(
        taskId,
        `Max retries (${maxRetries}) exceeded`,
      );

      // Set local ignore flag
      await sharedStateManager.setIgnoreFlag(
        taskId,
        "max_retries_exceeded",
        tempRoot,
      );

      // Verify no further retries allowed
      const retryCheck = await sharedStateManager.shouldRetryTask(
        taskId,
        maxRetries,
        tempRoot,
      );

      expect(retryCheck.shouldRetry).toBe(false);
    });

    it("tracks retry count across takeovers", async () => {
      const taskId = "55";
      const agent1 = "agent-1/workstation-1";
      const agent2 = "agent-2/workstation-2";

      // Agent 1 claims and fails
      await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent1,
        "token-1",
        1,
        tempRoot,
      );
      await sharedStateManager.releaseSharedState(
        taskId,
        "token-1",
        "failed",
        "First failure",
        tempRoot,
      );

      // Agent 2 takes over
      const claim2 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        agent2,
        "token-2",
        300,
        tempRoot,
      );

      expect(claim2.state.retryCount).toBe(1);
      expect(claim2.state.lastError).toBe("First failure");

      // Agent 2 fails
      await sharedStateManager.releaseSharedState(
        taskId,
        "token-2",
        "failed",
        "Second failure",
        tempRoot,
      );

      // Next attempt should have retry count of 2
      const claim3 = await sharedStateManager.claimTaskInSharedState(
        taskId,
        "agent-3/workstation-3",
        "token-3",
        300,
        tempRoot,
      );

      expect(claim3.state.retryCount).toBe(2);
    });
  });

  describe("statistics and monitoring", () => {
    it("tracks overall state statistics", async () => {
      // Create various task states
      await sharedStateManager.claimTaskInSharedState(
        "task-1",
        "agent-1/ws-1",
        "token-1",
        300,
        tempRoot,
      );

      await sharedStateManager.claimTaskInSharedState(
        "task-2",
        "agent-2/ws-2",
        "token-2",
        300,
        tempRoot,
      );
      await sharedStateManager.releaseSharedState(
        "task-2",
        "token-2",
        "complete",
        undefined,
        tempRoot,
      );

      await sharedStateManager.claimTaskInSharedState(
        "task-3",
        "agent-3/ws-3",
        "token-3",
        300,
        tempRoot,
      );
      await sharedStateManager.releaseSharedState(
        "task-3",
        "token-3",
        "failed",
        "Error",
        tempRoot,
      );

      await sharedStateManager.setIgnoreFlag("task-4", "manual", tempRoot);

      const stats = await sharedStateManager.getStateStatistics(tempRoot);

      expect(stats.total).toBe(4);
      expect(stats.claimed).toBe(1);
      expect(stats.complete).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.ignored).toBe(1);
    });

    it("tracks state by owner", async () => {
      await sharedStateManager.claimTaskInSharedState(
        "task-1",
        "agent-1/ws-1",
        "token-1",
        300,
        tempRoot,
      );

      await sharedStateManager.claimTaskInSharedState(
        "task-2",
        "agent-1/ws-1",
        "token-2",
        300,
        tempRoot,
      );

      await sharedStateManager.claimTaskInSharedState(
        "task-3",
        "agent-2/ws-2",
        "token-3",
        300,
        tempRoot,
      );

      const stats = await sharedStateManager.getStateStatistics(tempRoot);

      expect(stats.byOwner["agent-1/ws-1"]).toBe(2);
      expect(stats.byOwner["agent-2/ws-2"]).toBe(1);
    });
  });

  describe("error scenarios", () => {
    it("handles GitHub API failures gracefully", async () => {
      const taskId = "56";

      await sharedStateManager.claimTaskInSharedState(
        taskId,
        "agent-1/ws-1",
        "token-1",
        300,
        tempRoot,
      );

      // Mock GitHub failure (need 2 errors for retry exhaustion)
      mockGhError(new Error("API error"));
      mockGhError(new Error("API error"));

      const state = await sharedStateManager.getSharedState(taskId, tempRoot);
      const result = await kanbanAdapter.persistSharedStateToIssue(taskId, {
        taskId,
        ownerId: state.ownerId,
        attemptToken: state.attemptToken,
        attemptStarted: state.attemptStarted,
        heartbeat: state.ownerHeartbeat,
        status: "claimed",
        retryCount: 0,
      });

      // Should fail gracefully
      expect(result).toBe(false);

      // Local state should still be valid
      const localState = await sharedStateManager.getSharedState(
        taskId,
        tempRoot,
      );
      expect(localState).toBeDefined();
      expect(localState.attemptStatus).toBe("claimed");
    });

    it("recovers from corrupted registry", async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const registryPath = join(
        tempRoot,
        ".cache",
        "bosun",
        "shared-task-states.json",
      );
      await mkdir(join(tempRoot, ".cache", "bosun"), {
        recursive: true,
      });
      await writeFile(registryPath, "corrupted json", "utf-8");

      // Should recover and create new registry
      const result = await sharedStateManager.claimTaskInSharedState(
        "task-1",
        "agent-1/ws-1",
        "token-1",
        300,
        tempRoot,
      );

      expect(result.success).toBe(true);
    });
  });
});
