import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { createReviewAgent, ReviewAgent } from "../agent/review-agent.mjs";

/* eslint-disable no-unused-vars */

// Mock execWithRetry to avoid real SDK calls
vi.mock("../agent/agent-pool.mjs", () => ({
  execWithRetry: vi.fn().mockResolvedValue({
    output: '{"verdict": "approved", "issues": [], "summary": "LGTM"}',
    success: true,
  }),
  getPoolSdkName: vi.fn().mockReturnValue("codex"),
}));

// Mock diff-stats to avoid real git calls
vi.mock("../git/diff-stats.mjs", () => ({
  collectDiffStats: vi.fn().mockReturnValue({
    files: [{ file: "test.mjs", additions: 10, deletions: 5, binary: false }],
    totalFiles: 1,
    totalAdditions: 10,
    totalDeletions: 5,
    formatted: "1 file(s) changed, +10 -5",
  }),
  getCompactDiffSummary: vi.fn().mockReturnValue("1 file(s) changed, +10 -5"),
  getRecentCommits: vi.fn().mockReturnValue(["abc123 fix: test"]),
}));

describe("review-agent", () => {
  async function waitFor(condition, timeoutMs = 2000) {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitFor timeout");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((cmd, args) => {
      if (cmd === "gh" && args?.[0] === "pr" && args?.[1] === "diff") {
        return { status: 0, stdout: "diff --git a/file.mjs b/file.mjs\n+change\n" };
      }
      if (cmd === "git" && args?.[0] === "diff") {
        return { status: 0, stdout: "diff --git a/fallback.mjs b/fallback.mjs\n+fallback\n" };
      }
      return { status: 1, stdout: "", stderr: "not mocked" };
    });
  });

  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  describe("ReviewAgent constructor", () => {
    it("creates instance with defaults", () => {
      const agent = createReviewAgent();
      expect(agent).toBeInstanceOf(ReviewAgent);
    });

    it("accepts options", () => {
      const agent = createReviewAgent({
        autoFix: false,
        waitForMerge: false,
        maxConcurrentReviews: 1,
      });
      expect(agent).toBeInstanceOf(ReviewAgent);
    });
  });

  describe("queueReview", () => {
    it("queues a task for review", async () => {
      const agent = createReviewAgent({
        autoFix: false,
        waitForMerge: false,
      });

      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
        prUrl: "https://github.com/owner/repo/pull/123",
      });

      const status = agent.getStatus();
      expect(status.queuedReviews).toBe(1);
    });

    it("deduplicates by task ID", async () => {
      const agent = createReviewAgent({
        autoFix: false,
        waitForMerge: false,
      });

      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
      });
      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
      });

      const status = agent.getStatus();
      expect(status.queuedReviews).toBe(1);
    });

    it("skips tasks without id", async () => {
      const agent = createReviewAgent();
      await agent.queueReview({}); // No ID
      const status = agent.getStatus();
      expect(status.queuedReviews).toBe(0);
    });
  });

  describe("cancelReview", () => {
    it("cancels queued reviews", async () => {
      const agent = createReviewAgent({
        autoFix: false,
        waitForMerge: false,
      });

      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
      });
      agent.cancelReview("task-1");

      const status = agent.getStatus();
      expect(status.queuedReviews).toBe(0);
    });
  });

  describe("re-queue after cancel", () => {
    it("allows re-queue after cancelling", async () => {
      const agent = createReviewAgent({
        autoFix: false,
        waitForMerge: false,
      });

      await agent.queueReview({
        id: "task-1",
        title: "Test",
        branchName: "ve/test",
      });
      agent.cancelReview("task-1");

      // After cancel, re-queue should work
      await agent.queueReview({
        id: "task-1",
        title: "Test",
        branchName: "ve/test",
      });
      const status = agent.getStatus();
      expect(status.queuedReviews).toBe(1);
    });
  });

  describe("getStatus", () => {
    it("returns correct status", () => {
      const agent = createReviewAgent();
      const status = agent.getStatus();

      expect(status).toHaveProperty("activeReviews", 0);
      expect(status).toHaveProperty("queuedReviews", 0);
      expect(status).toHaveProperty("completedReviews", 0);
      // completedReviews covers both fixed and approved
    });
  });

  describe("start / stop", () => {
    it("starts and stops cleanly", async () => {
      const agent = createReviewAgent();
      agent.start();
      await agent.stop();
    });

    it("allows re-queue after a completed review", async () => {
      const onReviewComplete = vi.fn();
      const agent = createReviewAgent({ onReviewComplete });
      agent.start();

      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
      });
      await waitFor(() => agent.getStatus().completedReviews >= 1);

      await agent.queueReview({
        id: "task-1",
        title: "Test Task",
        branchName: "ve/test-branch",
      });
      await waitFor(() => agent.getStatus().completedReviews >= 2);

      expect(onReviewComplete).toHaveBeenCalledTimes(2);
      await agent.stop();
    });
  });


  describe("diff retrieval", () => {
    it("uses prNumber-only context to fetch diff", async () => {
      const onReviewComplete = vi.fn();
      const agent = createReviewAgent({ onReviewComplete });
      agent.start();

      await agent.queueReview({
        id: "task-pr-number",
        title: "PR only",
        prNumber: 123,
        description: "",
      });

      await waitFor(() => onReviewComplete.mock.calls.length > 0);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "gh",
        ["pr", "diff", "123"],
        expect.objectContaining({ encoding: "utf8" }),
      );
      expect(onReviewComplete.mock.calls[0][1].approved).toBe(true);
      await agent.stop();
    });

    it("skips queueing when review context is missing", async () => {
      const onReviewComplete = vi.fn();
      const agent = createReviewAgent({ onReviewComplete });
      agent.start();

      await agent.queueReview({
        id: "task-no-context",
        title: "No context",
        description: "",
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(onReviewComplete).not.toHaveBeenCalled();
      expect(agent.getStatus().queuedReviews).toBe(0);
      await agent.stop();
    });
  });

});
