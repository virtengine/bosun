import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("github-shared-state", () => {
  let adapter;
  let originalProjectMode;
  let originalProjectNumber;
  let originalProjectId;
  let envSnapshot = {};

  beforeEach(async () => {
    vi.clearAllMocks();
    execFileMock.mockReset();
    envSnapshot = {
      GITHUB_PROJECT_MODE: process.env.GITHUB_PROJECT_MODE,
    };
    process.env.GITHUB_PROJECT_MODE = "issues";

    originalProjectMode = process.env.GITHUB_PROJECT_MODE;
    originalProjectNumber = process.env.GITHUB_PROJECT_NUMBER;
    originalProjectId = process.env.GITHUB_PROJECT_ID;
    process.env.GITHUB_PROJECT_MODE = "issues";
    delete process.env.GITHUB_PROJECT_NUMBER;
    delete process.env.GITHUB_PROJECT_ID;

    // Mock config
    vi.doMock("../config.mjs", () => ({
      loadConfig: vi.fn(() => ({
        repoSlug: "acme/widgets",
        kanban: { backend: "github" },
      })),
    }));

    const { getKanbanAdapter, setKanbanBackend } =
      await import("../kanban/kanban-adapter.mjs");
    setKanbanBackend("github");
    adapter = getKanbanAdapter();
    adapter._issueListCache?.clear?.();
    adapter._sharedStateCache?.clear?.();
    // Disable rate limit retry delay for test speed
    adapter._rateLimitRetryDelayMs = 0;
  });

  afterEach(() => {
    if (originalProjectMode === undefined) {
      delete process.env.GITHUB_PROJECT_MODE;
    } else {
      process.env.GITHUB_PROJECT_MODE = originalProjectMode;
    }
    if (originalProjectNumber === undefined) {
      delete process.env.GITHUB_PROJECT_NUMBER;
    } else {
      process.env.GITHUB_PROJECT_NUMBER = originalProjectNumber;
    }
    if (originalProjectId === undefined) {
      delete process.env.GITHUB_PROJECT_ID;
    } else {
      process.env.GITHUB_PROJECT_ID = originalProjectId;
    }
    vi.doUnmock("../config.mjs");
    if (envSnapshot.GITHUB_PROJECT_MODE === undefined) {
      delete process.env.GITHUB_PROJECT_MODE;
    } else {
      process.env.GITHUB_PROJECT_MODE = envSnapshot.GITHUB_PROJECT_MODE;
    }
    vi.resetModules();
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

  describe("persistSharedStateToIssue", () => {
    it("creates labels and comment for claimed state", async () => {
      // Mock getting current labels
      mockGh(JSON.stringify([]));

      // Mock label edit
      mockGh("✓ Labels updated");

      // Mock getting comments
      mockGh(JSON.stringify([]));

      // Mock creating comment
      mockGh(
        JSON.stringify({
          id: 123456,
          body: "Comment created",
        }),
      );

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);
      expect(execFileMock).toHaveBeenCalled();

      // Check that we called gh with correct arguments
      const calls = execFileMock.mock.calls;

      // Should have label and comment operations
      const labelCall = calls.find((c) => c[1].includes("--add-label"));
      expect(labelCall).toBeDefined();
      expect(labelCall[1]).toContain("codex:claimed");

      const commentCall = calls.find((c) => c[1].includes("comment"));
      expect(commentCall).toBeDefined();
    });

    it("updates existing bosun comment", async () => {
      // Mock getting current labels
      mockGh(JSON.stringify({ labels: [{ name: "codex:claimed" }] }));

      // Mock label edit (no changes needed)
      mockGh("✓ Labels unchanged");

      // Mock getting comments with existing state comment
      mockGh(
        JSON.stringify([
          {
            id: 999,
            body: `<!-- bosun-state
{
  "ownerId": "agent-old/workstation-old",
  "status": "claimed"
}
-->
Old comment`,
          },
        ]),
      );

      // Mock PATCH comment
      mockGh(
        JSON.stringify({
          id: 999,
          body: "Comment updated",
        }),
      );

      const sharedState = {
        taskId: "42",
        ownerId: "agent-2/workstation-2",
        attemptToken: "token-456",
        attemptStarted: "2026-02-14T11:00:00Z",
        heartbeat: "2026-02-14T11:30:00Z",
        status: "working",
        retryCount: 1,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);

      // Should have called PATCH on existing comment
      const patchCall = execFileMock.mock.calls.find(
        (c) =>
          c[1]?.includes("PATCH") &&
          c[1]?.some((arg) => String(arg).includes("999")),
      );
      expect(patchCall).toBeDefined();
    });

    it("updates labels based on status", async () => {
      // Mock getting current labels with old status
      mockGh(
        JSON.stringify({
          labels: [{ name: "codex:claimed" }, { name: "bug" }],
        }),
      );

      // Mock label edit
      mockGh("✓ Labels updated");

      // Mock getting comments
      mockGh(JSON.stringify([]));

      // Mock creating comment
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "working",
        retryCount: 0,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);

      // Check that we removed old label and added new
      const labelCall = execFileMock.mock.calls.find((c) =>
        c[1].includes("--add-label"),
      );
      expect(labelCall).toBeDefined();
      expect(labelCall[1]).toContain("--remove-label");
      expect(labelCall[1]).toContain("codex:claimed");
      expect(labelCall[1]).toContain("--add-label");
      expect(labelCall[1]).toContain("codex:working");
    });

    it("retries on failure", async () => {
      // First attempt fails
      mockGhError(new Error("Network timeout"));

      // Mock getting current labels for retry
      mockGh(JSON.stringify([]));

      // Mock label edit for retry
      mockGh("✓ Labels updated");

      // Mock getting comments for retry
      mockGh(JSON.stringify([]));

      // Mock creating comment for retry
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);
      expect(execFileMock.mock.calls.length).toBeGreaterThan(1);
    });

    it("returns false after max retries", async () => {
      // Both attempts fail
      mockGhError(new Error("Network timeout"));
      mockGhError(new Error("Network timeout"));

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(false);
    });

    it("handles stale status", async () => {
      mockGh(JSON.stringify([]));
      mockGh("✓ Labels updated");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:00:00Z",
        status: "stale",
        retryCount: 2,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);

      const labelCall = execFileMock.mock.calls.find((c) =>
        c[1].includes("--add-label"),
      );
      expect(labelCall[1]).toContain("codex:stale");
    });

    it("rejects invalid issue number", async () => {
      const sharedState = {
        taskId: "invalid",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      await expect(
        adapter.persistSharedStateToIssue("not-a-number", sharedState),
      ).rejects.toThrow("Invalid issue number");
    });
  });

  describe("readSharedStateFromIssue", () => {
    it("parses structured comment correctly", async () => {
      const stateData = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "working",
        retryCount: 1,
      };

      mockGh(
        JSON.stringify([
          {
            id: 123,
            body: `<!-- bosun-state
${JSON.stringify(stateData, null, 2)}
-->
**Bosun Status**: Working on this task`,
          },
        ]),
      );

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toMatchObject(stateData);
    });

    it("returns null when no state comment exists", async () => {
      mockGh(
        JSON.stringify([
          { id: 1, body: "Regular comment" },
          { id: 2, body: "Another comment" },
        ]),
      );

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });

    it("returns latest state when multiple comments exist", async () => {
      const oldState = {
        taskId: "42",
        ownerId: "agent-old/workstation-old",
        attemptToken: "token-old",
        attemptStarted: "2026-02-14T09:00:00Z",
        heartbeat: "2026-02-14T09:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const newState = {
        taskId: "42",
        ownerId: "agent-new/workstation-new",
        attemptToken: "token-new",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "working",
        retryCount: 1,
      };

      mockGh(
        JSON.stringify([
          {
            id: 100,
            body: `<!-- bosun-state
${JSON.stringify(oldState, null, 2)}
-->
Old state`,
          },
          { id: 101, body: "Regular comment" },
          {
            id: 102,
            body: `<!-- bosun-state
${JSON.stringify(newState, null, 2)}
-->
New state`,
          },
        ]),
      );

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toMatchObject(newState);
    });

    it("returns null for malformed JSON", async () => {
      mockGh(
        JSON.stringify([
          {
            id: 123,
            body: `<!-- bosun-state
{ invalid json }
-->
Invalid`,
          },
        ]),
      );

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });

    it("returns null for missing required fields", async () => {
      const incompleteState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        // Missing attemptToken, attemptStarted, heartbeat, status
      };

      mockGh(
        JSON.stringify([
          {
            id: 123,
            body: `<!-- bosun-state
${JSON.stringify(incompleteState, null, 2)}
-->
Incomplete state`,
          },
        ]),
      );

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });

    it("handles gh CLI errors gracefully", async () => {
      mockGhError(new Error("API rate limit exceeded"));
      mockGhError(new Error("API rate limit exceeded")); // retry attempt

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });

    it("rejects invalid issue number", async () => {
      await expect(adapter.readSharedStateFromIssue("invalid")).rejects.toThrow(
        "Invalid issue number",
      );
    });
  });

  describe("markTaskIgnored", () => {
    it("adds ignore label and comment", async () => {
      // Mock label edit
      mockGh("✓ Label added");

      // Mock creating comment
      mockGh(
        JSON.stringify({
          id: 123,
          body: "Ignored comment",
        }),
      );

      const result = await adapter.markTaskIgnored(
        42,
        "Task requires manual security review",
      );

      expect(result).toBe(true);

      // Check label was added
      const labelCall = execFileMock.mock.calls.find((c) =>
        c[1].includes("--add-label"),
      );
      expect(labelCall).toBeDefined();
      expect(labelCall[1]).toContain("codex:ignore");

      // Check comment was created
      const commentCall = execFileMock.mock.calls.find((c) =>
        c[1].includes("comment"),
      );
      expect(commentCall).toBeDefined();
    });

    it("includes reason in comment", async () => {
      mockGh("✓ Label added");
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const reason = "Requires manual database migration";
      await adapter.markTaskIgnored(42, reason);

      const commentCall = execFileMock.mock.calls.find((c) =>
        c[1].includes("comment"),
      );
      expect(commentCall).toBeDefined();

      // The reason should be in the comment body
      const bodyArg = commentCall[1].find((arg) => arg.includes(reason));
      expect(bodyArg).toBeDefined();
    });

    it("returns false on error", async () => {
      mockGhError(new Error("API error"));

      const result = await adapter.markTaskIgnored(42, "Some reason");

      expect(result).toBe(false);
    });

    it("rejects invalid issue number", async () => {
      await expect(
        adapter.markTaskIgnored("invalid", "Some reason"),
      ).rejects.toThrow("Invalid issue number");
    });
  });

  describe("listTasks with shared state enrichment", () => {
    it("enriches tasks with shared state from comments", async () => {
      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "working",
        retryCount: 1,
      };

      // Mock issue list
      mockGh(
        JSON.stringify([
          {
            number: 42,
            title: "Test task",
            body: "Task description",
            state: "open",
            url: "https://github.com/acme/widgets/issues/42",
            labels: [{ name: "codex:working" }, { name: "bosun" }],
            assignees: [],
          },
        ]),
      );

      // Mock comments for the issue
      mockGh(
        JSON.stringify([
          {
            id: 123,
            body: `<!-- bosun-state
${JSON.stringify(sharedState, null, 2)}
-->
Status comment`,
          },
        ]),
      );

      const tasks = await adapter.listTasks("project-id", {
        status: "todo",
        limit: 10,
      });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].meta.sharedState).toMatchObject(sharedState);
    });

    it("handles tasks without shared state", async () => {
      // Mock issue list
      mockGh(
        JSON.stringify([
          {
            number: 43,
            title: "Task without state",
            body: "Description",
            state: "open",
            url: "https://github.com/acme/widgets/issues/43",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        ]),
      );

      // Mock empty comments
      mockGh(JSON.stringify([]));

      const tasks = await adapter.listTasks("project-id", {
        status: "todo",
        limit: 10,
      });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].meta?.sharedState).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("handles network timeouts with retry", async () => {
      // First attempt times out
      mockGhError(new Error("ETIMEDOUT"));

      // Retry succeeds
      mockGh(JSON.stringify([]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const sharedState = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const result = await adapter.persistSharedStateToIssue(42, sharedState);

      expect(result).toBe(true);
    });

    it("handles API rate limiting", async () => {
      mockGhError(new Error("API rate limit exceeded. Please retry after..."));
      mockGhError(new Error("API rate limit exceeded. Please retry after...")); // retry attempt

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });

    it("handles malformed gh CLI responses", async () => {
      mockGh("not json at all");

      const result = await adapter.readSharedStateFromIssue(42);

      expect(result).toBeNull();
    });
  });

  describe("exported convenience functions", () => {
    it("exports persistSharedStateToIssue", async () => {
      const { persistSharedStateToIssue } =
        await import("../kanban/kanban-adapter.mjs");

      expect(typeof persistSharedStateToIssue).toBe("function");

      // Mock for the test
      mockGh(JSON.stringify([]));
      mockGh("✓ Success");
      mockGh(JSON.stringify([]));
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const state = {
        taskId: "42",
        ownerId: "agent-1/workstation-1",
        attemptToken: "token-123",
        attemptStarted: "2026-02-14T10:00:00Z",
        heartbeat: "2026-02-14T10:30:00Z",
        status: "claimed",
        retryCount: 0,
      };

      const result = await persistSharedStateToIssue(42, state);
      expect(typeof result).toBe("boolean");
    });

    it("exports readSharedStateFromIssue", async () => {
      const { readSharedStateFromIssue } =
        await import("../kanban/kanban-adapter.mjs");

      expect(typeof readSharedStateFromIssue).toBe("function");

      mockGh(JSON.stringify([]));

      const result = await readSharedStateFromIssue(42);
      expect(result).toBeNull();
    });

    it("exports markTaskIgnored", async () => {
      const { markTaskIgnored } = await import("../kanban/kanban-adapter.mjs");

      expect(typeof markTaskIgnored).toBe("function");

      mockGh("✓ Success");
      mockGh(JSON.stringify({ id: 123, body: "Comment" }));

      const result = await markTaskIgnored(42, "Test reason");
      expect(typeof result).toBe("boolean");
    });
  });
});
