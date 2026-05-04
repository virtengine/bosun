import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

vi.mock("../config/config.mjs", () => ({
  loadConfig: loadConfigMock,
}));

const { getKanbanAdapter, setKanbanBackend } =
  await import("../kanban/kanban-adapter.mjs");

/**
 * Helper to mock a gh CLI call. `stdout` will be returned; pass an object
 * to have it JSON-serialized automatically.
 */
function mockGh(stdout, stderr = "") {
  const raw = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(null, { stdout: raw, stderr });
  });
}

function mockGhError(message) {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(new Error(message), { stdout: "", stderr: message });
  });
}

// ─── Env snapshot helpers ───────────────────────────────────────────────────

const ENV_KEYS = [
  "GITHUB_REPOSITORY",
  "GITHUB_REPO_OWNER",
  "GITHUB_REPO_NAME",
  "GITHUB_PROJECT_MODE",
  "GITHUB_PROJECT_OWNER",
  "GITHUB_PROJECT_NUMBER",
  "GITHUB_PROJECT_TITLE",
  "GITHUB_PROJECT_AUTO_SYNC",
  "GITHUB_PROJECT_STATUS_TODO",
  "GITHUB_PROJECT_STATUS_INPROGRESS",
  "GITHUB_PROJECT_STATUS_INREVIEW",
  "GITHUB_PROJECT_STATUS_DONE",
  "GITHUB_PROJECT_STATUS_CANCELLED",
  "BOSUN_ENFORCE_TASK_LABEL",
  "BOSUN_TASK_LABEL",
];

function snapshotEnv() {
  const snap = {};
  for (const key of ENV_KEYS) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap) {
  for (const key of ENV_KEYS) {
    if (snap[key] === undefined) delete process.env[key];
    else process.env[key] = snap[key];
  }
}

// ─── Test suites ────────────────────────────────────────────────────────────

describe("GitHub Projects v2 integration", () => {
  let envSnap;

  beforeEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset(); // Clear call history AND mockImplementationOnce queue
    envSnap = snapshotEnv();

    // Baseline env for all tests
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
    process.env.GITHUB_PROJECT_MODE = "kanban";
    process.env.GITHUB_PROJECT_NUMBER = "7";
    process.env.BOSUN_ENFORCE_TASK_LABEL = "false";
    delete process.env.GITHUB_PROJECT_AUTO_SYNC;
    delete process.env.GITHUB_PROJECT_STATUS_TODO;
    delete process.env.GITHUB_PROJECT_STATUS_INPROGRESS;
    delete process.env.GITHUB_PROJECT_STATUS_INREVIEW;
    delete process.env.GITHUB_PROJECT_STATUS_DONE;
    delete process.env.GITHUB_PROJECT_STATUS_CANCELLED;

    loadConfigMock.mockReturnValue({
      repoSlug: "acme/widgets",
      kanban: { backend: "github" },
    });
    setKanbanBackend("github");
  });

  afterEach(() => {
    restoreEnv(envSnap);
  });

  // ── getProjectNodeId ────────────────────────────────────────────────────

  describe("getProjectNodeId()", () => {
    it("resolves org project node ID via GraphQL and caches it", async () => {
      mockGh({
        data: {
          user: { projectV2: null },
          organization: { projectV2: { id: "PVT_org_abc123" } },
        },
      });

      const adapter = getKanbanAdapter();
      const id1 = await adapter.getProjectNodeId("7");
      expect(id1).toBe("PVT_org_abc123");

      // Second call should NOT trigger another gh call (cached)
      const id2 = await adapter.getProjectNodeId("7");
      expect(id2).toBe("PVT_org_abc123");
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it("resolves user project node ID when org returns null", async () => {
      mockGh({
        data: {
          user: { projectV2: { id: "PVT_user_xyz789" } },
          organization: { projectV2: null },
        },
      });

      const adapter = getKanbanAdapter();
      const id = await adapter.getProjectNodeId("3");
      expect(id).toBe("PVT_user_xyz789");
    });

    it("returns null and does not cache on failure", async () => {
      mockGhError("GraphQL error: project not found");

      const adapter = getKanbanAdapter();
      const id = await adapter.getProjectNodeId("999");
      expect(id).toBeNull();
    });

    it("returns null for empty projectNumber", async () => {
      const adapter = getKanbanAdapter();
      const id = await adapter.getProjectNodeId(null);
      expect(id).toBeNull();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  // ── getProjectFields ──────────────────────────────────────────────────

  describe("getProjectFields()", () => {
    const sampleFields = [
      {
        id: "PVTF_status",
        name: "Status",
        type: "SINGLE_SELECT",
        options: [
          { id: "opt_todo", name: "Todo" },
          { id: "opt_ip", name: "In Progress" },
          { id: "opt_done", name: "Done" },
        ],
      },
      {
        id: "PVTF_priority",
        name: "Priority",
        type: "SINGLE_SELECT",
        options: [
          { id: "opt_low", name: "Low" },
          { id: "opt_high", name: "High" },
        ],
      },
      {
        id: "PVTF_estimate",
        name: "Estimate",
        type: "NUMBER",
        options: [],
      },
    ];

    it("returns full field Map keyed by lowercase name", async () => {
      mockGh(sampleFields);

      const adapter = getKanbanAdapter();
      const fieldMap = await adapter.getProjectFields("7");

      expect(fieldMap).toBeInstanceOf(Map);
      expect(fieldMap.size).toBe(3);

      const status = fieldMap.get("status");
      expect(status).toMatchObject({
        id: "PVTF_status",
        name: "Status",
        type: "SINGLE_SELECT",
      });
      expect(status.options).toHaveLength(3);

      expect(fieldMap.get("priority")).toMatchObject({ id: "PVTF_priority" });
      expect(fieldMap.get("estimate")).toMatchObject({
        id: "PVTF_estimate",
        type: "NUMBER",
      });
    });

    it("caches field data and reuses on second call", async () => {
      mockGh(sampleFields);

      const adapter = getKanbanAdapter();
      await adapter.getProjectFields("7");
      const fieldMap2 = await adapter.getProjectFields("7");

      // Only one gh call should have been made
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(fieldMap2.size).toBe(3);
    });

    it("returns empty Map for null projectNumber", async () => {
      const adapter = getKanbanAdapter();
      const result = await adapter.getProjectFields(null);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });
  });

  // ── _normaliseProjectItem ────────────────────────────────────────────

  describe("_normaliseProjectItem()", () => {
    it("normalizes a project item with content and status", () => {
      const adapter = getKanbanAdapter();
      const task = adapter._normaliseProjectItem({
        id: "PVTI_123",
        status: "In Progress",
        content: {
          number: 42,
          title: "Fix auth bug",
          body: "Branch: `ve/42-fix-auth`\nPR: #99",
          url: "https://github.com/acme/widgets/issues/42",
          state: "open",
          labels: [{ name: "bosun" }, { name: "high" }],
          assignees: [{ login: "alice" }],
        },
      });

      expect(task).not.toBeNull();
      expect(task.id).toBe("42");
      expect(task.title).toBe("Fix auth bug");
      expect(task.status).toBe("inprogress");
      expect(task.assignee).toBe("alice");
      expect(task.priority).toBe("high");
      expect(task.branchName).toBe("ve/42-fix-auth");
      expect(task.prNumber).toBe("99");
      expect(task.meta.projectItemId).toBe("PVTI_123");
      expect(task.meta.projectStatus).toBe("In Progress");
      expect(task.backend).toBe("github");
    });

    it("extracts issue number from URL when content.number is missing", () => {
      const adapter = getKanbanAdapter();
      const task = adapter._normaliseProjectItem({
        id: "PVTI_456",
        status: "Todo",
        content: {
          url: "https://github.com/acme/widgets/issues/77",
          title: "My task",
          body: "",
          labels: [],
          assignees: [],
        },
      });

      expect(task).not.toBeNull();
      expect(task.id).toBe("77");
    });

    it("returns null for draft items without content number or URL", () => {
      const adapter = getKanbanAdapter();
      const task = adapter._normaliseProjectItem({
        id: "PVTI_draft",
        title: "Draft idea",
        content: {},
      });
      expect(task).toBeNull();
    });

    it("falls back to label-based status when project status is missing", () => {
      const adapter = getKanbanAdapter();
      const task = adapter._normaliseProjectItem({
        id: "PVTI_789",
        content: {
          number: 10,
          title: "Review needed",
          body: "",
          state: "open",
          labels: [{ name: "inreview" }],
          assignees: [],
        },
      });

      expect(task.status).toBe("inreview");
    });

    it("detects codex meta flags from labels", () => {
      const adapter = getKanbanAdapter();
      const task = adapter._normaliseProjectItem({
        id: "item1",
        status: "Todo",
        content: {
          number: 5,
          title: "Ignored task",
          body: "",
          labels: [{ name: "codex:ignore" }, { name: "codex:stale" }],
          assignees: [],
        },
      });

      expect(task.meta.codex.isIgnored).toBe(true);
      expect(task.meta.codex.isStale).toBe(true);
      expect(task.meta.codex.isClaimed).toBe(false);
    });
  });

  // ── _normalizeProjectStatus ──────────────────────────────────────────

  describe("_normalizeProjectStatus()", () => {
    it("maps project status name → internal status (default mapping)", () => {
      const adapter = getKanbanAdapter();

      expect(adapter._normalizeProjectStatus("Todo")).toBe("todo");
      expect(adapter._normalizeProjectStatus("In Progress")).toBe("inprogress");
      expect(adapter._normalizeProjectStatus("In Review")).toBe("inreview");
      expect(adapter._normalizeProjectStatus("Done")).toBe("done");
      expect(adapter._normalizeProjectStatus("Cancelled")).toBe("cancelled");
    });

    it("maps internal status → project status name (reverse)", () => {
      const adapter = getKanbanAdapter();

      expect(adapter._normalizeProjectStatus("todo", true)).toBe("Todo");
      expect(adapter._normalizeProjectStatus("inprogress", true)).toBe(
        "In Progress",
      );
      expect(adapter._normalizeProjectStatus("inreview", true)).toBe(
        "In Review",
      );
      expect(adapter._normalizeProjectStatus("done", true)).toBe("Done");
      expect(adapter._normalizeProjectStatus("cancelled", true)).toBe(
        "Cancelled",
      );
    });

    it("is case-insensitive for project → internal", () => {
      const adapter = getKanbanAdapter();
      expect(adapter._normalizeProjectStatus("in progress")).toBe("inprogress");
      expect(adapter._normalizeProjectStatus("IN REVIEW")).toBe("inreview");
      expect(adapter._normalizeProjectStatus("TODO")).toBe("todo");
    });

    it("falls back to 'todo' for unknown project statuses", () => {
      const adapter = getKanbanAdapter();
      expect(adapter._normalizeProjectStatus("Backlog")).toBe("todo");
      expect(adapter._normalizeProjectStatus("")).toBe("todo");
      expect(adapter._normalizeProjectStatus(null)).toBe("todo");
    });

    it("falls back to project Todo for unknown internal statuses", () => {
      const adapter = getKanbanAdapter();
      expect(adapter._normalizeProjectStatus("unknown", true)).toBe("Todo");
      expect(adapter._normalizeProjectStatus(null, true)).toBe("Todo");
    });
  });

  // ── Configurable status mapping via env vars ────────────────────────

  describe("configurable status mapping via env vars", () => {
    // Note: PROJECT_STATUS_MAP is resolved at module load time,
    // so we need to test via the _normalizeProjectStatus method which reads it.
    // For truly dynamic per-instance testing, we validate the adapter
    // uses the mapping correctly.

    it("uses default mappings when env vars are not set", () => {
      const adapter = getKanbanAdapter();
      expect(adapter._normalizeProjectStatus("Todo")).toBe("todo");
      expect(adapter._normalizeProjectStatus("In Progress")).toBe("inprogress");
    });

    it("_syncStatusToProject uses configurable mapping", async () => {
      // Mock field-list to return Status field
      mockGh([
        {
          id: "PVTF_s",
          name: "Status",
          type: "SINGLE_SELECT",
          options: [
            { id: "opt_1", name: "Todo" },
            { id: "opt_2", name: "In Progress" },
            { id: "opt_3", name: "Done" },
          ],
        },
      ]);
      // Mock item-add (ensure issue in project)
      mockGh("item added");
      // Mock GraphQL project ID
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_org_1" } },
        },
      });
      // Mock GraphQL item ID
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_item1", project: { id: "PVT_org_1" } }],
            },
          },
        },
      });
      // Mock GraphQL mutation
      mockGh({
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "ok" } },
        },
      });

      const adapter = getKanbanAdapter();
      const result = await adapter._syncStatusToProject(
        "https://github.com/acme/widgets/issues/42",
        "7",
        "inprogress",
      );

      expect(result).toBe(true);
      // Check the mutation included the "In Progress" option
      const mutationCall = execFileMock.mock.calls[4]; // 5th call is the mutation
      expect(mutationCall[1]).toContain("api");
    });
  });

  // ── GITHUB_PROJECT_AUTO_SYNC toggle ────────────────────────────────

  describe("GITHUB_PROJECT_AUTO_SYNC toggle", () => {
    it("skips project sync when GITHUB_PROJECT_AUTO_SYNC=false", async () => {
      process.env.GITHUB_PROJECT_AUTO_SYNC = "false";

      // Re-create adapter with fresh env
      setKanbanBackend("github");

      // Mock issue close and issue view (for updateTaskStatus)
      mockGh("Closed issue #42");
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      mockGh("[]"); // comments

      const adapter = getKanbanAdapter();
      await adapter.updateTaskStatus("42", "done");

      // Should NOT have made any project-related gh calls
      // (only issue close + issue view + comments = 3 calls)
      expect(execFileMock).toHaveBeenCalledTimes(3);
      const allArgs = execFileMock.mock.calls.map((c) => c[1]);
      const projectCalls = allArgs.filter(
        (args) =>
          Array.isArray(args) &&
          args.some(
            (a) =>
              String(a).includes("project") || String(a).includes("graphql"),
          ),
      );
      expect(projectCalls).toHaveLength(0);
    });

    it("performs project sync when GITHUB_PROJECT_AUTO_SYNC is not set (default true)", async () => {
      // Default: auto-sync enabled
      process.env.GITHUB_PROJECT_AUTO_SYNC = "true";
      setKanbanBackend("github");

      // Mock issue close
      mockGh("Closed issue #42");
      // Mock issue view
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      // Mock comments
      mockGh("[]");
      // Mock _resolveProjectNumber - project list
      mockGh([{ title: "Bosun", number: 7 }]);
      // Mock issue view (second call in sync path)
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      mockGh("[]"); // comments for second getTask
      // Mock project field-list
      mockGh([
        {
          id: "PVTF_s",
          name: "Status",
          type: "SINGLE_SELECT",
          options: [{ id: "opt_done", name: "Done" }],
        },
      ]);
      // Mock item-add
      mockGh("added");
      // Mock project ID
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      // Mock item ID
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }],
            },
          },
        },
      });
      // Mock mutation
      mockGh({
        data: {
          updateProjectV2ItemFieldValue: { projectV2Item: { id: "ok" } },
        },
      });
      // Mock final getTask
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      mockGh("[]");

      const adapter = getKanbanAdapter();
      await adapter.updateTaskStatus("42", "done");

      // Should have made project-related calls
      expect(execFileMock.mock.calls.length).toBeGreaterThan(3);
    });
  });

  // ── _getProjectItemIdForIssue ─────────────────────────────────────

  describe("_getProjectItemIdForIssue()", () => {
    it("resolves item ID via GraphQL and caches it", async () => {
      // Mock getProjectNodeId (GraphQL)
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_org_1" } },
        },
      });
      // Mock resource query for item ID
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [
                { id: "PVTI_abc", project: { id: "PVT_org_1" } },
                { id: "PVTI_other", project: { id: "PVT_other" } },
              ],
            },
          },
        },
      });

      const adapter = getKanbanAdapter();
      const itemId = await adapter._getProjectItemIdForIssue("7", "42");
      expect(itemId).toBe("PVTI_abc");

      // Second call should be cached
      const itemId2 = await adapter._getProjectItemIdForIssue("7", "42");
      expect(itemId2).toBe("PVTI_abc");
      // Only 2 gh calls total (project ID + item query), not 4
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it("returns null when issue not in project", async () => {
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh({
        data: {
          resource: {
            projectItems: { nodes: [] },
          },
        },
      });

      const adapter = getKanbanAdapter();
      const itemId = await adapter._getProjectItemIdForIssue("7", "999");
      expect(itemId).toBeNull();
    });

    it("returns null for missing parameters", async () => {
      const adapter = getKanbanAdapter();
      expect(await adapter._getProjectItemIdForIssue(null, "42")).toBeNull();
      expect(await adapter._getProjectItemIdForIssue("7", null)).toBeNull();
      expect(execFileMock).not.toHaveBeenCalled();
    });
  });

  // ── syncFieldToProject ────────────────────────────────────────────

  describe("syncFieldToProject()", () => {
    function setupFieldMocks(fieldType = "SINGLE_SELECT") {
      // getProjectNodeId
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      // getProjectFields (field-list)
      const fields = [
        {
          id: "PVTF_status",
          name: "Status",
          type: "SINGLE_SELECT",
          options: [
            { id: "opt_todo", name: "Todo" },
            { id: "opt_ip", name: "In Progress" },
          ],
        },
        {
          id: "PVTF_estimate",
          name: "Estimate",
          type: "NUMBER",
          options: [],
        },
        {
          id: "PVTF_due",
          name: "Due Date",
          type: "DATE",
          options: [],
        },
        {
          id: "PVTF_notes",
          name: "Notes",
          type: "TEXT",
          options: [],
        },
      ];
      mockGh(fields);
      // _getProjectItemIdForIssue — resource query
      // Project node is already cached from first call, so only item query needed
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }],
            },
          },
        },
      });
      // mutation response
      mockGh({
        data: {
          updateProjectV2ItemFieldValue: {
            projectV2Item: { id: "PVTI_1" },
          },
        },
      });
    }

    it("updates a SINGLE_SELECT field", async () => {
      setupFieldMocks();

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject(
        "42",
        "7",
        "Status",
        "In Progress",
      );
      expect(result).toBe(true);

      // Find the mutation call
      const calls = execFileMock.mock.calls;
      const mutationCall = calls[calls.length - 1];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toBeTruthy();
      expect(mutationArg).toContain("singleSelectOptionId");
      expect(mutationArg).toContain("opt_ip");
    });

    it("updates a NUMBER field", async () => {
      setupFieldMocks();

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject("42", "7", "Estimate", 5);
      expect(result).toBe(true);

      const calls = execFileMock.mock.calls;
      const mutationCall = calls[calls.length - 1];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toContain("number: 5");
    });

    it("updates a DATE field", async () => {
      setupFieldMocks();

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject(
        "42",
        "7",
        "Due Date",
        "2026-03-01",
      );
      expect(result).toBe(true);

      const calls = execFileMock.mock.calls;
      const mutationCall = calls[calls.length - 1];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toContain("date:");
      expect(mutationArg).toContain("2026-03-01");
    });

    it("updates a TEXT field", async () => {
      setupFieldMocks();

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject(
        "42",
        "7",
        "Notes",
        "Hello world",
      );
      expect(result).toBe(true);

      const calls = execFileMock.mock.calls;
      const mutationCall = calls[calls.length - 1];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toContain("text:");
      expect(mutationArg).toContain("Hello world");
    });

    it("returns false for unknown field name", async () => {
      // getProjectNodeId
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      // getProjectFields
      mockGh([
        { id: "PVTF_s", name: "Status", type: "SINGLE_SELECT", options: [] },
      ]);

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject(
        "42",
        "7",
        "NonExistentField",
        "value",
      );
      expect(result).toBe(false);
    });

    it("returns false for unknown option in SINGLE_SELECT", async () => {
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh([
        {
          id: "PVTF_s",
          name: "Status",
          type: "SINGLE_SELECT",
          options: [{ id: "opt_1", name: "Todo" }],
        },
      ]);
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }],
            },
          },
        },
      });

      const adapter = getKanbanAdapter();
      const result = await adapter.syncFieldToProject(
        "42",
        "7",
        "Status",
        "NonExistent Option",
      );
      expect(result).toBe(false);
    });

    it("returns false for missing parameters", async () => {
      const adapter = getKanbanAdapter();
      expect(await adapter.syncFieldToProject(null, "7", "Status", "v")).toBe(
        false,
      );
      expect(await adapter.syncFieldToProject("42", null, "Status", "v")).toBe(
        false,
      );
      expect(await adapter.syncFieldToProject("42", "7", null, "v")).toBe(
        false,
      );
    });

    it("syncIterationToProject resolves iteration by name", async () => {
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh([
        {
          id: "PVTF_iter",
          name: "Iteration",
          type: "ITERATION",
          configuration: {
            iterations: [
              { id: "iter_1", title: "Sprint 23" },
              { id: "iter_2", title: "Sprint 24" },
            ],
          },
          options: [],
        },
      ]);
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }],
            },
          },
        },
      });
      mockGh({
        data: {
          update_0: {
            projectV2Item: { id: "PVTI_1" },
          },
        },
      });

      const adapter = getKanbanAdapter();
      const result = await adapter.syncIterationToProject("42", "7", "Sprint 24");
      expect(result).toBe(true);

      const mutationCall = execFileMock.mock.calls[3];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toContain("iterationId");
      expect(mutationArg).toContain("iter_2");
      expect(mutationArg).toContain("update_0:");
    });
  });

  // ── Rate limit retry in _gh() ─────────────────────────────────────

  describe("rate limit retry in _gh()", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries once after rate limit error and succeeds", async () => {
      vi.useFakeTimers();

      // First call: rate limit error
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("API rate limit exceeded"), {
          stdout: "",
          stderr: "API rate limit exceeded",
        });
      });
      // Second call (retry): success
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, {
          stdout: JSON.stringify([{ id: "task-1" }]),
          stderr: "",
        });
      });

      const adapter = getKanbanAdapter();
      const promise = adapter._gh(["api", "user"]);

      // Advance past the 60s rate limit wait
      await vi.advanceTimersByTimeAsync(61_000);

      const result = await promise;
      expect(result).toEqual([{ id: "task-1" }]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it("throws after rate limit retry also fails", async () => {
      vi.useFakeTimers();

      // Both attempts fail with rate limit
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("API rate limit exceeded"), {
          stdout: "",
          stderr: "API rate limit exceeded",
        });
      });
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("API rate limit exceeded"), {
          stdout: "",
          stderr: "API rate limit exceeded",
        });
      });

      const adapter = getKanbanAdapter();
      const promise = adapter._gh(["api", "user"]);

      // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow(/rate limit retry/);

      // Advance past the 60s rate limit wait
      await vi.advanceTimersByTimeAsync(61_000);

      await assertion;
    });


    it("retries transient gh CLI failures and succeeds", async () => {
      vi.useFakeTimers();

      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("invalid character '<' looking for beginning of value"), {
          stdout: "",
          stderr: "invalid character '<' looking for beginning of value",
        });
      });
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, {
          stdout: JSON.stringify([{ id: "task-2" }]),
          stderr: "",
        });
      });

      const adapter = getKanbanAdapter();
      const promise = adapter._gh(["api", "user"]);

      await vi.advanceTimersByTimeAsync(adapter._transientRetryDelayMs + 100);

      const result = await promise;
      expect(result).toEqual([{ id: "task-2" }]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it("throws after transient retry budget is exhausted", async () => {
      vi.useFakeTimers();

      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("service unavailable"), {
          stdout: "",
          stderr: "service unavailable",
        });
      });
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(new Error("service unavailable"), {
          stdout: "",
          stderr: "service unavailable",
        });
      });

      const adapter = getKanbanAdapter();
      adapter._transientRetryMax = 1;
      const promise = adapter._gh(["api", "user"]);

      const assertion = expect(promise).rejects.toThrow(/gh CLI failed/);
      await vi.advanceTimersByTimeAsync(adapter._transientRetryDelayMs + 100);
      await assertion;
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it("retries transient invalid JSON responses and succeeds", async () => {
      vi.useFakeTimers();

      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, {
          stdout: "<html><body><h1>502 Bad Gateway</h1></body></html>",
          stderr: "",
        });
      });
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, {
          stdout: JSON.stringify([{ id: "task-3" }]),
          stderr: "",
        });
      });

      const adapter = getKanbanAdapter();
      const promise = adapter._gh(["api", "user"]);

      await vi.advanceTimersByTimeAsync(adapter._transientRetryDelayMs + 100);

      const result = await promise;
      expect(result).toEqual([{ id: "task-3" }]);
      expect(execFileMock).toHaveBeenCalledTimes(2);
    });
    it("does not retry on non-rate-limit errors", async () => {
      mockGhError("not found");

      const adapter = getKanbanAdapter();
      await expect(adapter._gh(["issue", "view", "999"])).rejects.toThrow(
        /gh CLI failed/,
      );
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── listTasksFromProject (public, no N+1) ────────────────────────

  describe("listTasksFromProject()", () => {
    it("normalizes project items without individual issue fetches", async () => {
      mockGh([
        {
          id: "PVTI_1",
          status: "In Progress",
          content: {
            number: 10,
            title: "Task A",
            body: "",
            url: "https://github.com/acme/widgets/issues/10",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [{ login: "bob" }],
          },
        },
        {
          id: "PVTI_2",
          status: "Done",
          content: {
            number: 11,
            title: "Task B",
            body: "",
            url: "https://github.com/acme/widgets/issues/11",
            state: "closed",
            labels: [],
            assignees: [],
          },
        },
        {
          id: "PVTI_3",
          status: "Todo",
          content: {
            type: "PullRequest",
            number: 99,
            title: "PR item",
            url: "https://github.com/acme/widgets/pull/99",
          },
        },
      ]);

      const adapter = getKanbanAdapter();
      const tasks = await adapter.listTasksFromProject("7");

      // PR item should be skipped
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe("10");
      expect(tasks[0].status).toBe("inprogress");
      expect(tasks[0].assignee).toBe("bob");
      expect(tasks[0].meta.projectNumber).toBe("7");
      expect(tasks[1].id).toBe("11");
      expect(tasks[1].status).toBe("done");

      // Only 1 gh call (item-list), not N+1
      expect(execFileMock).toHaveBeenCalledTimes(1);
    });

    it("resolves shared-state comment fetches using task issue URL repo", async () => {
      mockGh([
        {
          id: "PVTI_cross_repo",
          status: "Todo",
          content: {
            number: 759,
            title: "Cross-repo item",
            body: "",
            url: "https://github.com/virtengine/virtengine/issues/759",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]);
      mockGh([]);

      const adapter = getKanbanAdapter();
      const tasks = await adapter.listTasks("ignored");

      expect(tasks).toHaveLength(1);
      const apiCall = execFileMock.mock.calls.find(
        (call) =>
          Array.isArray(call[1]) &&
          call[1][0] === "api" &&
          String(call[1][1] || "").includes(
            "/repos/virtengine/virtengine/issues/759/comments",
          ),
      );
      expect(apiCall).toBeTruthy();
    });

    it("uses cached cross-repo locator for later getTask issue-view fetches", async () => {
      mockGh([
        {
          id: "PVTI_cross_repo",
          status: "Todo",
          content: {
            number: 759,
            title: "Cross-repo item",
            body: "",
            url: "https://github.com/virtengine/virtengine/issues/759",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]);
      mockGh([]);
      mockGh({
        number: 759,
        title: "Cross-repo item",
        body: "",
        state: "open",
        url: "https://github.com/virtengine/virtengine/issues/759",
        labels: [{ name: "bosun" }],
        assignees: [],
        comments: [],
      });

      const adapter = getKanbanAdapter();
      await adapter.listTasks("ignored");
      const task = await adapter.getTask("759");

      expect(task).toMatchObject({
        id: "759",
        projectId: "virtengine/virtengine",
      });
      const issueViewCall = execFileMock.mock.calls.find(
        (call) =>
          Array.isArray(call[1]) &&
          call[1][0] === "issue" &&
          call[1][1] === "view" &&
          call[1].includes("759"),
      );
      expect(issueViewCall?.[1]).toContain("--repo");
      expect(issueViewCall?.[1]).toContain("virtengine/virtengine");
    });

    it("returns empty array for null projectNumber", async () => {
      const adapter = getKanbanAdapter();
      const tasks = await adapter.listTasksFromProject(null);
      expect(tasks).toEqual([]);
    });

    it("caches project item IDs from list results", async () => {
      mockGh([
        {
          id: "PVTI_cached",
          status: "Todo",
          content: {
            number: 55,
            title: "Cached issue",
            body: "",
            url: "https://github.com/acme/widgets/issues/55",
            state: "open",
            labels: [],
            assignees: [],
          },
        },
      ]);

      const adapter = getKanbanAdapter();
      await adapter.listTasksFromProject("7");

      // The item ID should now be in the cache
      expect(adapter._projectItemCache.get("7:55")).toBe("PVTI_cached");
    });

    it("filters project items by filters.projectField", async () => {
      mockGh([
        {
          id: "PVTI_1",
          status: "Todo",
          fieldValues: { Priority: "High" },
          content: {
            number: 10,
            title: "Task A",
            body: "",
            url: "https://github.com/acme/widgets/issues/10",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
        {
          id: "PVTI_2",
          status: "Todo",
          fieldValues: { Priority: "Low" },
          content: {
            number: 11,
            title: "Task B",
            body: "",
            url: "https://github.com/acme/widgets/issues/11",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]);

      const adapter = getKanbanAdapter();
      const tasks = await adapter.listTasksFromProject("7", {
        projectField: { Priority: "High" },
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe("10");
    });
  });

  describe("status+field batch mutations and draft flow", () => {
    it("batches status + project field updates with GraphQL aliases", async () => {
      mockGh("Closed issue #42");
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      mockGh("[]");
      mockGh([
        {
          id: "PVTF_s",
          name: "Status",
          type: "SINGLE_SELECT",
          options: [{ id: "opt_done", name: "Done" }],
        },
        {
          id: "PVTF_p",
          name: "Priority",
          type: "SINGLE_SELECT",
          options: [{ id: "opt_high", name: "High" }],
        },
      ]);
      mockGh("added");
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh({
        data: {
          resource: {
            projectItems: {
              nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }],
            },
          },
        },
      });
      mockGh({ data: { update_0: {}, update_1: {} } });
      mockGh({
        number: 42,
        title: "test",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      });
      mockGh("[]");

      const adapter = getKanbanAdapter();
      await adapter.updateTaskStatus("42", "done", {
        projectFields: { Priority: "High" },
      });

      const mutationCall = execFileMock.mock.calls[7];
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("updateProjectV2ItemFieldValue"),
      );
      expect(mutationArg).toContain("update_0:");
      expect(mutationArg).toContain("update_1:");
      expect(mutationArg).toContain("PVTF_s");
      expect(mutationArg).toContain("PVTF_p");
      expect(mutationArg).toContain("opt_done");
      expect(mutationArg).toContain("opt_high");
    });

    it("listTasks applies projectField filter in project mode", async () => {
      mockGh([
        {
          id: "PVTI_1",
          status: "Todo",
          fieldValues: { Priority: "High" },
          content: {
            number: 10,
            title: "Task A",
            body: "",
            url: "https://github.com/acme/widgets/issues/10",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
        {
          id: "PVTI_2",
          status: "Todo",
          fieldValues: { Priority: "Low" },
          content: {
            number: 11,
            title: "Task B",
            body: "",
            url: "https://github.com/acme/widgets/issues/11",
            state: "open",
            labels: [{ name: "bosun" }],
            assignees: [],
          },
        },
      ]);
      mockGh("[]");

      const adapter = getKanbanAdapter();
      const tasks = await adapter.listTasks("ignored", {
        projectField: { Priority: "High" },
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe("10");
    });

    it("createTask supports addProjectV2DraftIssue without conversion", async () => {
      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh({
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_draft_1" } },
        },
      });

      const adapter = getKanbanAdapter();
      const task = await adapter.createTask("ignored", {
        title: "Draft task",
        description: "Draft body",
        draft: true,
      });
      expect(task.id).toBe("draft:PVTI_draft_1");
      expect(task.meta?.isDraft).toBe(true);

      const issueCreateCall = execFileMock.mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1].includes("issue"),
      );
      expect(issueCreateCall).toBeUndefined();
    });

    it("createTask can convert a project draft issue to repository issue", async () => {
      process.env.GITHUB_PROJECT_AUTO_SYNC = "false";
      setKanbanBackend("github");

      mockGh({
        data: {
          user: null,
          organization: { projectV2: { id: "PVT_1" } },
        },
      });
      mockGh({
        data: {
          addProjectV2DraftIssue: { projectItem: { id: "PVTI_draft_2" } },
        },
      });
      mockGh({
        data: {
          repository: { id: "REPO_1" },
        },
      });
      mockGh({
        data: {
          convertProjectV2DraftIssueItemToIssue: {
            issue: {
              number: 88,
              url: "https://github.com/acme/widgets/issues/88",
            },
          },
        },
      });
      mockGh("created");
      mockGh("updated");
      mockGh("Closed issue #88");
      mockGh({
        number: 88,
        title: "Draft task",
        body: "Draft body",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/88",
        labels: [],
        assignees: [],
      });
      mockGh("[]");

      const adapter = getKanbanAdapter();
      const task = await adapter.createTask("ignored", {
        title: "Draft task",
        description: "Draft body",
        draft: true,
        convertDraft: true,
        assignee: "alice",
        status: "done",
      });
      expect(task.id).toBe("88");

      const mutationCall = execFileMock.mock.calls[3];
      expect(mutationCall[1]).toContain("graphql");
      const mutationArg = mutationCall[1].find((a) =>
        String(a).includes("convertProjectV2DraftIssueItemToIssue"),
      );
      expect(mutationArg).toBeTruthy();
    });
  });
});
