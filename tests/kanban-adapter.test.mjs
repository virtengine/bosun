import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const loadConfigMock = vi.hoisted(() => vi.fn());
const fetchWithFallbackMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../config/config.mjs", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../infra/fetch-runtime.mjs", () => ({
  fetchWithFallback: fetchWithFallbackMock,
}));


const {
  getKanbanAdapter,
  setKanbanBackend,
  getKanbanBackendName,
  listTasks: listKanbanTasks,
  getTask: getKanbanTask,
  updateTaskStatus: updateKanbanTaskStatus,
  updateTask: patchKanbanTask,
  createTask: createKanbanTask,
  deleteTask: deleteKanbanTask,
  addComment: addKanbanComment,
  persistSharedStateToIssue,
  readSharedStateFromIssue,
  markTaskIgnored,
} = await import("../kanban/kanban-adapter.mjs");
const {
  configureTaskStore,
  loadStore,
  addTask,
  removeTask,
  getTask,
} = await import("../task/task-store.mjs");
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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

beforeEach(() => {
  fetchWithFallbackMock.mockImplementation((...args) => globalThis.fetch(...args));
});

describe("kanban-adapter github backend", () => {
  const originalRepo = process.env.GITHUB_REPOSITORY;
  const originalOwner = process.env.GITHUB_REPO_OWNER;
  const originalName = process.env.GITHUB_REPO_NAME;
  const originalProjectMode = process.env.GITHUB_PROJECT_MODE;
  const originalTaskLabelEnforce = process.env.BOSUN_ENFORCE_TASK_LABEL;
  const originalDefaultAssignee = process.env.GITHUB_DEFAULT_ASSIGNEE;

  beforeEach(() => {
    execFileMock.mockReset();
    vi.clearAllMocks();
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
    delete process.env.GITHUB_DEFAULT_ASSIGNEE;
    process.env.GITHUB_PROJECT_MODE = "issues";
    process.env.BOSUN_ENFORCE_TASK_LABEL = "true";
    loadConfigMock.mockReturnValue({
      repoSlug: "acme/widgets",
      kanban: { backend: "github" },
    });
    setKanbanBackend("github");
  });

  afterEach(() => {
    if (originalRepo === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalRepo;
    }
    if (originalOwner === undefined) {
      delete process.env.GITHUB_REPO_OWNER;
    } else {
      process.env.GITHUB_REPO_OWNER = originalOwner;
    }
    if (originalName === undefined) {
      delete process.env.GITHUB_REPO_NAME;
    } else {
      process.env.GITHUB_REPO_NAME = originalName;
    }
    if (originalProjectMode === undefined) {
      delete process.env.GITHUB_PROJECT_MODE;
    } else {
      process.env.GITHUB_PROJECT_MODE = originalProjectMode;
    }
    if (originalTaskLabelEnforce === undefined) {
      delete process.env.BOSUN_ENFORCE_TASK_LABEL;
    } else {
      process.env.BOSUN_ENFORCE_TASK_LABEL = originalTaskLabelEnforce;
    }
    if (originalDefaultAssignee === undefined) {
      delete process.env.GITHUB_DEFAULT_ASSIGNEE;
    } else {
      process.env.GITHUB_DEFAULT_ASSIGNEE = originalDefaultAssignee;
    }
  });

  it("uses repo slug from config when owner/repo env vars are not set", async () => {
    mockGh("[]");
    const adapter = getKanbanAdapter();
    await adapter.listTasks("ignored-project-id", { status: "todo", limit: 5 });

    const call = execFileMock.mock.calls[0];
    expect(call).toBeTruthy();
    const args = call[1];
    expect(args).toContain("--repo");
    expect(args).toContain("acme/widgets");
  });

  it("handles non-JSON output for issue close and then fetches updated issue", async () => {
    mockGh("✓ Closed issue #42");
    mockGh(
      JSON.stringify({
        number: 42,
        title: "example",
        body: "",
        state: "closed",
        url: "https://github.com/acme/widgets/issues/42",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.updateTaskStatus("42", "cancelled");

    expect(task?.id).toBe("42");
    expect(task?.status).toBe("done");

    const closeCallArgs = execFileMock.mock.calls[0][1];
    expect(closeCallArgs).toContain("close");
    expect(closeCallArgs).toContain("--reason");
    expect(closeCallArgs).toContain("not planned");
  });

  it("creates issue from URL output and resolves it via issue view", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "alice";
    mockGh("ok");
    mockGh("https://github.com/acme/widgets/issues/55\n");
    mockGh(
      JSON.stringify({
        number: 55,
        title: "new task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/55",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask("ignored-project-id", {
      title: "new task",
      description: "desc",
    });

    expect(task?.id).toBe("55");
    expect(task?.taskUrl).toBe("https://github.com/acme/widgets/issues/55");
    expect(getKanbanBackendName()).toBe("github");

    const issueCreateCall = execFileMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("create"),
    );
    expect(issueCreateCall).toBeTruthy();
    expect(issueCreateCall[1]).toContain("--label");
    expect(issueCreateCall[1]).toContain("bosun");
    expect(issueCreateCall[1]).toContain("--assignee");
    expect(issueCreateCall[1]).toContain("alice");
  });

  it("supports payload-only createTask calls for the github adapter", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "alice";
    mockGh("ok");
    mockGh("https://github.com/acme/widgets/issues/88\n");
    mockGh(
      JSON.stringify({
        number: 88,
        title: "payload-only github task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/88",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask({
      title: "payload-only github task",
      description: "desc",
    });

    expect(task?.id).toBe("88");
    expect(task?.taskUrl).toBe("https://github.com/acme/widgets/issues/88");
  });

  it("supports payload-only exported createTask helper calls for the github adapter", async () => {
    process.env.GITHUB_DEFAULT_ASSIGNEE = "alice";
    mockGh("ok");
    mockGh("https://github.com/acme/widgets/issues/89\n");
    mockGh(
      JSON.stringify({
        number: 89,
        title: "payload-only github helper task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/89",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const task = await createKanbanTask({
      title: "payload-only github helper task",
      description: "desc",
    });

    expect(task?.id).toBe("89");
    expect(task?.taskUrl).toBe("https://github.com/acme/widgets/issues/89");
  });

  it("rejects github issue creation when title is empty", async () => {
    const adapter = getKanbanAdapter();
    await expect(
      adapter.createTask("ignored-project-id", { title: "   ", description: "desc" }),
    ).rejects.toThrow("requires non-empty title");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does not default assignee to repo owner when user resolution fails", async () => {
    mockGh("ok");
    mockGhError(new Error("gh api unavailable"));
    mockGh("https://github.com/acme/widgets/issues/77\n");
    mockGh(
      JSON.stringify({
        number: 77,
        title: "new task",
        body: "desc",
        state: "open",
        url: "https://github.com/acme/widgets/issues/77",
        labels: [],
        assignees: [],
      }),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask("ignored-project-id", {
      title: "new task",
      description: "desc",
    });

    expect(task?.id).toBe("77");
    const issueCreateCall = execFileMock.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("create"),
    );
    expect(issueCreateCall).toBeTruthy();
    expect(issueCreateCall[1]).not.toContain("--assignee");
    expect(issueCreateCall[1]).not.toContain("acme");
  });

  it("filters listTasks to codex-scoped labels when enforcement is enabled", async () => {
    mockGh(
      JSON.stringify([
        {
          number: 10,
          title: "scoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "bosun" }],
          assignees: [],
        },
        {
          number: 11,
          title: "unscoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/11",
          labels: [{ name: "bug" }],
          assignees: [],
        },
      ]),
    );
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("ignored-project-id", {
      status: "todo",
      limit: 25,
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("10");
  });

  it("does not filter by codex labels when enforcement is disabled", async () => {
    process.env.BOSUN_ENFORCE_TASK_LABEL = "false";
    setKanbanBackend("github");
    mockGh(
      JSON.stringify([
        {
          number: 10,
          title: "scoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "bosun" }],
          assignees: [],
        },
        {
          number: 11,
          title: "unscoped",
          body: "",
          state: "open",
          url: "https://github.com/acme/widgets/issues/11",
          labels: [{ name: "bug" }],
          assignees: [],
        },
      ]),
    );
    mockGh("[]");
    mockGh("[]");

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("ignored-project-id", {
      status: "todo",
      limit: 25,
    });

    expect(tasks).toHaveLength(2);
  });

  it("falls back to issues when project board listing fails", async () => {
    process.env.GITHUB_PROJECT_MODE = "kanban";
    process.env.GITHUB_PROJECT_NUMBER = "5";

    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const joined = args.join(" ");
      if (joined.includes("project item-list")) {
        cb(new Error("unknown owner type"), { stdout: "", stderr: "" });
        return;
      }
      if (joined.includes("issue list")) {
        cb(
          null,
          {
            stdout: JSON.stringify([
              {
                number: 77,
                title: "Issue fallback task",
                body: "",
                state: "OPEN",
                url: "https://github.com/acme/widgets/issues/77",
                assignees: [],
                labels: [{ name: "bosun" }],
                comments: [],
              },
            ]),
            stderr: "",
          },
        );
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    });

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("ignored", { status: "todo" });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "77", title: "Issue fallback task" });
  });

  it("returns cached tasks during github issue-list backoff failures", async () => {
    const adapter = getKanbanAdapter();
    adapter._rateLimitRetryDelayMs = 0;
    adapter._transientRetryMax = 0;

    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      if (args.includes("issue") && args.includes("list")) {
        cb(
          null,
          {
            stdout: JSON.stringify([
              {
                number: 81,
                title: "Cached task",
                body: "",
                state: "OPEN",
                url: "https://github.com/acme/widgets/issues/81",
                assignees: [],
                labels: [{ name: "bosun" }],
                comments: [],
              },
            ]),
            stderr: "",
          },
        );
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    });

    const first = await adapter.listTasks("ignored", { status: "todo" });
    expect(first).toHaveLength(1);
    expect(first[0]?.id).toBe("81");

    adapter._issueListCache.clear();
    execFileMock.mockImplementationOnce((_cmd, args, _opts, cb) => {
      if (args.includes("issue") && args.includes("list")) {
        cb(new Error("gh unavailable"), { stdout: "", stderr: "" });
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    });

    const second = await adapter.listTasks("ignored", { status: "todo" });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe("81");
  });

  it("reopens issue and syncs status labels for open-state transitions", async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      const joined = args.join(" ");
      if (joined.includes("issue reopen")) {
        cb(null, { stdout: "✓ Reopened issue #42", stderr: "" });
        return;
      }
      if (joined.includes("label create")) {
        cb(null, { stdout: "✓ Created label", stderr: "" });
        return;
      }
      if (joined.includes("issue edit")) {
        cb(null, { stdout: "✓ Edited labels", stderr: "" });
        return;
      }
      if (joined.includes("issue view")) {
        cb(
          null,
          {
            stdout: JSON.stringify({
              number: 42,
              title: "example",
              body: "",
              state: "open",
              url: "https://github.com/acme/widgets/issues/42",
              labels: [{ name: "inprogress" }],
              assignees: [],
            }),
            stderr: "",
          },
        );
        return;
      }
      if (args[0] === "api" && args[1]?.includes("/issues/42/comments")) {
        cb(null, { stdout: "[]", stderr: "" });
        return;
      }
      cb(null, { stdout: "[]", stderr: "" });
    });

    const adapter = getKanbanAdapter();
    const task = await adapter.updateTaskStatus("42", "inprogress");

    expect(task?.id).toBe("42");
    expect(task?.status).toBe("inprogress");
    const callArgs = execFileMock.mock.calls.map((call) => call[1].join(" "));
    expect(callArgs.some((args) => args.includes("reopen"))).toBe(true);
    expect(
      callArgs.some(
        (args) => args.includes("--add-label") && args.includes("inprogress"),
      ),
    ).toBe(true);
    expect(callArgs.some((args) => args.includes("--remove-label"))).toBe(true);
  });

  it("persists, reads, and ignores shared state through issue labels/comments", async () => {
    mockGh(JSON.stringify({ labels: [{ name: "bug" }] }));
    mockGh("✓ Labels updated");
    mockGh(JSON.stringify([]));
    mockGh("ok");

    mockGh(
      JSON.stringify([
        {
          id: 1001,
          body: `<!-- bosun-state
{
  "ownerId": "workstation-a/agent-a",
  "attemptToken": "token-a",
  "attemptStarted": "2026-02-17T00:00:00.000Z",
  "heartbeat": "2026-02-17T00:01:00.000Z",
  "status": "working",
  "retryCount": 1
}
-->`,
        },
      ]),
    );

    mockGh("✓ Labels updated");
    mockGh("ok");

    const adapter = getKanbanAdapter();
    const state = {
      ownerId: "workstation-a/agent-a",
      attemptToken: "token-a",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "working",
      retryCount: 1,
    };

    const persisted = await adapter.persistSharedStateToIssue("42", state);
    expect(persisted).toBe(true);

    const loaded = await adapter.readSharedStateFromIssue("42");
    expect(loaded).toMatchObject(state);

    const ignored = await adapter.markTaskIgnored("42", "manual-only");
    expect(ignored).toBe(true);

    const editCalls = execFileMock.mock.calls.filter(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].includes("issue") &&
        call[1].includes("edit"),
    );
    expect(editCalls.some((call) => call[1].includes("codex:working"))).toBe(
      true,
    );
    expect(editCalls.some((call) => call[1].includes("codex:ignore"))).toBe(
      true,
    );
  });

  it("returns false when shared state persistence exhausts retries", async () => {
    mockGhError(new Error("api down"));
    mockGhError(new Error("still down"));

    const adapter = getKanbanAdapter();
    const persisted = await adapter.persistSharedStateToIssue("42", {
      ownerId: "ws/agent",
      attemptToken: "token-b",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "claimed",
      retryCount: 0,
    });
    expect(persisted).toBe(false);
  });

  it("addComment posts a comment on a github issue", async () => {
    mockGh("ok");

    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("42", "Hello from CI");

    expect(result).toBe(true);
    const call = execFileMock.mock.calls[0];
    const args = call[1];
    expect(args).toContain("issue");
    expect(args).toContain("comment");
    expect(args).toContain("42");
    expect(args).toContain("--body");
    expect(args).toContain("Hello from CI");
  });

  it("addComment returns false for invalid issue number", async () => {
    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("not-a-number", "body");
    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("addComment returns false when body is empty", async () => {
    const adapter = getKanbanAdapter();
    const result = await adapter.addComment("42", "");
    expect(result).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("caches missing GitHub issues and avoids repeated fetch/log spam", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGhError(new Error("Not Found (HTTP 404)"));

    const adapter = getKanbanAdapter();
    const first = await adapter.getTask("759");
    const second = await adapter.getTask("759");

    expect(first.id).toBe("759");
    expect(first.meta?.externalMissing).toBe(true);
    expect(first.meta?.externalMissingReason).toBe("issue_not_found");
    expect(second.meta?.externalMissing).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("addComment returns false when gh CLI fails", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
      cb(new Error("network error"), { stdout: "", stderr: "" });
    });

    const adapter = getKanbanAdapter();
    adapter._transientRetryMax = 0;
    const result = await adapter.addComment("42", "test body");
    expect(result).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("kanban-adapter jira backend", () => {
  const originalKanbanBackend = process.env.KANBAN_BACKEND;
  const originalJiraBaseUrl = process.env.JIRA_BASE_URL;
  const originalJiraToken = process.env.JIRA_API_TOKEN;
  const originalJiraEmail = process.env.JIRA_EMAIL;
  const originalProjectKey = process.env.JIRA_PROJECT_KEY;
  const originalIssueType = process.env.JIRA_ISSUE_TYPE;
  const originalEnforce = process.env.JIRA_ENFORCE_TASK_LABEL;
  const originalUseAdf = process.env.JIRA_USE_ADF_COMMENTS;

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "ERR",
      headers: {
        get: (name) =>
          String(name || "").toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KANBAN_BACKEND = "jira";
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_API_TOKEN = "token-1";
    process.env.JIRA_EMAIL = "bot@acme.dev";
    process.env.JIRA_PROJECT_KEY = "PROJ";
    process.env.JIRA_ISSUE_TYPE = "Task";
    process.env.JIRA_ENFORCE_TASK_LABEL = "true";
    process.env.JIRA_USE_ADF_COMMENTS = "false";
    delete process.env.JIRA_CUSTOM_FIELD_OWNER_ID;
    delete process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN;
    delete process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED;
    delete process.env.JIRA_CUSTOM_FIELD_HEARTBEAT;
    delete process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT;
    delete process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON;
    delete process.env.JIRA_CUSTOM_FIELD_SHARED_STATE;
    loadConfigMock.mockReturnValue({
      kanban: { backend: "jira" },
    });
    setKanbanBackend("jira");
  });

  afterEach(() => {
    if (originalKanbanBackend === undefined) {
      delete process.env.KANBAN_BACKEND;
    } else {
      process.env.KANBAN_BACKEND = originalKanbanBackend;
    }
    if (originalJiraBaseUrl === undefined) {
      delete process.env.JIRA_BASE_URL;
    } else {
      process.env.JIRA_BASE_URL = originalJiraBaseUrl;
    }
    if (originalJiraToken === undefined) {
      delete process.env.JIRA_API_TOKEN;
    } else {
      process.env.JIRA_API_TOKEN = originalJiraToken;
    }
    if (originalJiraEmail === undefined) {
      delete process.env.JIRA_EMAIL;
    } else {
      process.env.JIRA_EMAIL = originalJiraEmail;
    }
    if (originalProjectKey === undefined) {
      delete process.env.JIRA_PROJECT_KEY;
    } else {
      process.env.JIRA_PROJECT_KEY = originalProjectKey;
    }
    if (originalIssueType === undefined) {
      delete process.env.JIRA_ISSUE_TYPE;
    } else {
      process.env.JIRA_ISSUE_TYPE = originalIssueType;
    }
    if (originalEnforce === undefined) {
      delete process.env.JIRA_ENFORCE_TASK_LABEL;
    } else {
      process.env.JIRA_ENFORCE_TASK_LABEL = originalEnforce;
    }
    if (originalUseAdf === undefined) {
      delete process.env.JIRA_USE_ADF_COMMENTS;
    } else {
      process.env.JIRA_USE_ADF_COMMENTS = originalUseAdf;
    }
  });

  it("initializes jira adapter and tracks configured Jira credentials", async () => {
    fetchWithFallbackMock.mockResolvedValueOnce(jsonResponse({ values: [] }));
    const adapter = getKanbanAdapter();
    expect(getKanbanBackendName()).toBe("jira");
    expect(adapter.name).toBe("jira");
    expect(adapter._baseUrl).toBe("https://acme.atlassian.net");
    expect(adapter._token).toBe("token-1");
    expect(adapter._email).toBe("bot@acme.dev");
    await adapter.listProjects();
    expect(fetchWithFallbackMock).toHaveBeenCalled();
  });

  it("lists and filters tasks by jira status/labels/projectField", async () => {
    fetchWithFallbackMock
      .mockResolvedValueOnce(
        jsonResponse({
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "First",
                description: "desc",
                status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                labels: ["bosun"],
                priority: { name: "High" },
                project: { key: "PROJ" },
                customfield_10042: "alpha",
              },
            },
            {
              key: "PROJ-2",
              fields: {
                summary: "Second",
                description: "desc",
                status: { name: "To Do", statusCategory: { key: "new" } },
                labels: ["bug"],
                project: { key: "PROJ" },
                customfield_10042: "beta",
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ comments: [] }));

    const adapter = getKanbanAdapter();
    const tasks = await adapter.listTasks("PROJ", {
      status: "inprogress",
      projectField: { customfield_10042: "alpha" },
      limit: 20,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("PROJ-1");
    expect(tasks[0]?.status).toBe("inprogress");
  });

  it("updates jira task status via transitions and supports wrapper delegation", async () => {
    let transitioned = false;
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "GET" && text.includes("/issue/PROJ-9?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-9",
            fields: {
              summary: "Task",
              description: "body",
              status: transitioned
                ? { name: "In Progress", statusCategory: { key: "indeterminate" } }
                : { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-9/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-9/transitions")) {
        return Promise.resolve(
          jsonResponse({
            transitions: [
              {
                id: "31",
                to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
              },
            ],
          }),
        );
      }
      if (method === "POST" && text.includes("/issue/PROJ-9/transitions")) {
        transitioned = true;
        return Promise.resolve(jsonResponse(null, 204));
      }
      return Promise.resolve(jsonResponse({ comments: [] }));
    });

    const updated = await updateKanbanTaskStatus("PROJ-9", "inprogress");
    expect(updated.status).toBe("inprogress");
    const transitionCall = fetchWithFallbackMock.mock.calls.find((call) =>
      String(call[0]).includes("/transitions"),
    );
    expect(transitionCall).toBeTruthy();
  });

  it("creates, patches, comments, and marks ignored jira tasks", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "POST" && text.endsWith("/rest/api/3/issue")) {
        return Promise.resolve(jsonResponse({ key: "PROJ-77" }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-77?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-77",
            fields: {
              summary: "Renamed",
              description: "Updated",
              status: { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-77/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      if (method === "PUT" && text.includes("/issue/PROJ-77")) {
        return Promise.resolve(jsonResponse(null, 204));
      }
      if (method === "POST" && text.includes("/issue/PROJ-77/comment")) {
        return Promise.resolve(jsonResponse({ id: "9001" }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const adapter = getKanbanAdapter();
    const created = await createKanbanTask("PROJ", {
      title: "New task",
      description: "Body",
    });
    expect(created.id).toBe("PROJ-77");

    const patched = await patchKanbanTask("PROJ-77", {
      title: "Renamed",
      description: "Updated",
    });
    expect(patched.title).toBe("Renamed");

    const commented = await addKanbanComment("PROJ-77", "hello jira");
    expect(commented).toBe(true);

    const ignored = await markTaskIgnored("PROJ-77", "manual review");
    expect(ignored).toBe(true);
  });

  it("supports payload-only createTask calls for the jira adapter", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "POST" && text.endsWith("/rest/api/3/issue")) {
        return Promise.resolve(jsonResponse({ key: "PROJ-88" }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-88?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-88",
            fields: {
              summary: "Payload-only Jira task",
              description: "Body",
              status: { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-88/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const adapter = getKanbanAdapter();
    const task = await adapter.createTask({
      title: "Payload-only Jira task",
      description: "Body",
      status: "todo",
    });

    expect(task).toMatchObject({
      id: "PROJ-88",
      title: "Payload-only Jira task",
      description: "Body",
      status: "todo",
      projectId: "PROJ",
      backend: "jira",
    });
  });

  it("supports payload-only exported createTask helper calls for the jira adapter", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "POST" && text.endsWith("/rest/api/3/issue")) {
        return Promise.resolve(jsonResponse({ key: "PROJ-89" }));
      }
      if (method === "GET" && text.includes("/issue/PROJ-89?fields=")) {
        return Promise.resolve(
          jsonResponse({
            key: "PROJ-89",
            fields: {
              summary: "Payload-only Jira helper task",
              description: "Body",
              status: { name: "To Do", statusCategory: { key: "new" } },
              labels: ["bosun"],
              project: { key: "PROJ" },
            },
          }),
        );
      }
      if (method === "GET" && text.includes("/issue/PROJ-89/comment")) {
        return Promise.resolve(jsonResponse({ comments: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const task = await createKanbanTask({
      title: "Payload-only Jira helper task",
      description: "Body",
      status: "todo",
    });

    expect(task).toMatchObject({
      id: "PROJ-89",
      title: "Payload-only Jira helper task",
      description: "Body",
      status: "todo",
      projectId: "PROJ",
      backend: "jira",
    });
  });

  it("persists and reads shared state from Jira comments", async () => {
    fetchWithFallbackMock.mockImplementation((url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const text = String(url);
      if (method === "PUT" && text.includes("/issue/PROJ-201")) {
        return Promise.resolve(jsonResponse(null, 204));
      }
      if (method === "GET" && text.includes("/issue/PROJ-201/comment")) {
        return Promise.resolve(
          jsonResponse({
            comments: [
              {
                id: "c1",
                body: `<!-- bosun-state
{
  "ownerId": "ws-2/agent-2",
  "attemptToken": "token-2",
  "attemptStarted": "2026-02-17T00:00:00.000Z",
  "heartbeat": "2026-02-17T00:01:00.000Z",
  "status": "claimed",
  "retryCount": 0
}
-->`,
              },
            ],
            total: 1,
          }),
        );
      }
      if (method === "POST" && text.includes("/issue/PROJ-201/comment")) {
        return Promise.resolve(jsonResponse({ id: "c1" }));
      }
      return Promise.resolve(jsonResponse({ comments: [] }));
    });

    const sharedState = {
      ownerId: "ws-2/agent-2",
      attemptToken: "token-2",
      attemptStarted: "2026-02-17T00:00:00.000Z",
      heartbeat: "2026-02-17T00:01:00.000Z",
      status: "claimed",
      retryCount: 0,
    };
    const persisted = await persistSharedStateToIssue("PROJ-201", sharedState);
    expect(persisted).toBe(true);
    const loaded = await readSharedStateFromIssue("PROJ-201");
    expect(loaded).toMatchObject(sharedState);
  });

  it("throws on invalid jira issue keys", async () => {
    await expect(getKanbanTask("not-a-key")).rejects.toThrow(/invalid issue key/);
    await expect(deleteKanbanTask("123")).rejects.toThrow(/invalid issue key/);
  });
});

describe("kanban-adapter internal backend", () => {
  const originalKanbanBackend = process.env.KANBAN_BACKEND;
  let tempDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(resolve(tmpdir(), "bosun-internal-kanban-"));
    configureTaskStore({ baseDir: tempDir });
    loadStore();
    process.env.KANBAN_BACKEND = "internal";
    loadConfigMock.mockReturnValue({
      kanban: { backend: "internal" },
    });
    setKanbanBackend("internal");
  });

  afterEach(() => {
    if (originalKanbanBackend === undefined) {
      delete process.env.KANBAN_BACKEND;
    } else {
      process.env.KANBAN_BACKEND = originalKanbanBackend;
    }
  });

  it("uses internal backend by default when configured", () => {
    expect(getKanbanBackendName()).toBe("internal");
  });

  it("creates, lists, updates, comments, and deletes internal tasks", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Internal task",
      description: "Local source-of-truth task",
      status: "todo",
    });
    expect(created.backend).toBe("internal");
    expect(created.id).toBeTruthy();

    const listed = await adapter.listTasks("internal", { status: "todo" });
    expect(listed.some((task) => task.id === created.id)).toBe(true);

    const updated = await adapter.updateTaskStatus(created.id, "inprogress");
    expect(updated.status).toBe("inprogress");

    const updatedWithLinkage = await adapter.updateTaskStatus(created.id, "inreview", {
      branchName: "feature/internal-linkage",
      prNumber: 321,
      prUrl: "https://example.test/pr/321",
      source: "workflow",
    });
    expect(updatedWithLinkage.status).toBe("inreview");
    expect(updatedWithLinkage.branchName).toBe("feature/internal-linkage");
    expect(updatedWithLinkage.prNumber).toBe(321);
    expect(updatedWithLinkage.prUrl).toBe("https://example.test/pr/321");

    const patchedLinkage = await adapter.updateTask(created.id, {
      branchName: "feature/internal-linkage-v2",
      prNumber: 654,
      prUrl: "https://example.test/pr/654",
    });
    expect(patchedLinkage.branchName).toBe("feature/internal-linkage-v2");
    expect(patchedLinkage.prNumber).toBe(654);
    expect(patchedLinkage.prUrl).toBe("https://example.test/pr/654");

    const commented = await adapter.addComment(created.id, "review me");
    expect(commented).toBe(true);
    const fromStore = getTask(created.id);
    expect(Array.isArray(fromStore?.meta?.comments)).toBe(true);
    expect(fromStore.meta.comments.length).toBeGreaterThan(0);

    const deleted = await adapter.deleteTask(created.id);
    expect(deleted).toBe(true);
    expect(removeTask(created.id)).toBe(false);
  });

  it("preserves PR linkage across repeated status updates and store reload cycles", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Internal linkage persistence",
      description: "Ensures PR linkage survives reloads",
      status: "todo",
    });

    const firstReview = await adapter.updateTaskStatus(created.id, "inreview", {
      branchName: "feature/reload-linkage",
      prNumber: 321,
      prUrl: "https://example.test/pr/321",
      source: "workflow",
    });

    expect(firstReview.branchName).toBe("feature/reload-linkage");
    expect(firstReview.prNumber).toBe(321);
    expect(firstReview.prUrl).toBe("https://example.test/pr/321");

    const transitioned = await adapter.updateTaskStatus(created.id, "done", {
      source: "workflow",
    });
    expect(transitioned.status).toBe("done");
    expect(transitioned.branchName).toBe("feature/reload-linkage");
    expect(transitioned.prNumber).toBe(321);
    expect(transitioned.prUrl).toBe("https://example.test/pr/321");

    loadStore();
    const reloadedAdapter = getKanbanAdapter();
    const reloaded = await reloadedAdapter.getTask(created.id);
    expect(reloaded.status).toBe("done");
    expect(reloaded.branchName).toBe("feature/reload-linkage");
    expect(reloaded.prNumber).toBe(321);
    expect(reloaded.prUrl).toBe("https://example.test/pr/321");

    const listAfterReload = await reloadedAdapter.listTasks("internal");
    const listed = listAfterReload.find((task) => task.id === created.id);
    expect(listed?.branchName).toBe("feature/reload-linkage");
    expect(listed?.prNumber).toBe(321);
    expect(listed?.prUrl).toBe("https://example.test/pr/321");
  });

  it("merges PR linkage updates idempotently without duplicating metadata records", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Internal linkage merge",
      description: "Ensures merge stays idempotent",
      status: "todo",
      meta: {
        prLinkage: [
          {
            branchName: "feature/idempotent-linkage",
            prNumber: 456,
            prUrl: "https://example.test/pr/456",
            source: "auto-load",
            linkedAt: "2026-03-22T10:00:00.000Z",
          },
        ],
      },
    });

    const first = await adapter.updateTaskStatus(created.id, "inreview", {
      branchName: "feature/idempotent-linkage",
      prNumber: 456,
      prUrl: "https://example.test/pr/456",
      source: "workflow",
    });

    const second = await adapter.updateTask(created.id, {
      branchName: "feature/idempotent-linkage",
      prNumber: 456,
      prUrl: "https://example.test/pr/456",
      meta: {
        prLinkage: [
          {
            branchName: "feature/idempotent-linkage",
            prNumber: 456,
            prUrl: "https://example.test/pr/456",
            source: "auto-load",
            linkedAt: "2026-03-22T10:00:00.000Z",
          },
        ],
      },
    });

    const firstRecords = first.meta?.prLinkage;
    const secondRecords = second.meta?.prLinkage;
    expect(Array.isArray(firstRecords)).toBe(true);
    expect(Array.isArray(secondRecords)).toBe(true);
    expect(secondRecords).toHaveLength(1);
    expect(secondRecords[0]).toMatchObject({
      branchName: "feature/idempotent-linkage",
      prNumber: 456,
      prUrl: "https://example.test/pr/456",
    });
    expect(second.prLinkage).toHaveLength(1);
    expect(second.branchName).toBe("feature/idempotent-linkage");
    expect(second.prNumber).toBe(456);
    expect(second.prUrl).toBe("https://example.test/pr/456");
  });

  it("persists PR linkage metadata when canonical linkage fields update without explicit meta", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Canonical linkage persistence",
      description: "Preserves linkage metadata across direct updates",
      status: "todo",
    });

    const updated = await adapter.updateTask(created.id, {
      branchName: "feature/canonical-linkage",
      prNumber: 777,
      prUrl: "https://example.test/pr/777",
    });

    expect(updated.branchName).toBe("feature/canonical-linkage");
    expect(updated.prNumber).toBe(777);
    expect(updated.prUrl).toBe("https://example.test/pr/777");
    expect(updated.prLinkage).toHaveLength(1);
    expect(updated.meta?.prLinkage).toHaveLength(1);
    expect(updated.meta?.prLinkage?.[0]).toMatchObject({
      branchName: "feature/canonical-linkage",
      prNumber: 777,
      prUrl: "https://example.test/pr/777",
    });

    loadStore();
    const reloadedAdapter = getKanbanAdapter();
    const reloaded = await reloadedAdapter.getTask(created.id);
    expect(reloaded.prLinkage).toHaveLength(1);
    expect(reloaded.meta?.prLinkage).toHaveLength(1);
    expect(reloaded.branchName).toBe("feature/canonical-linkage");
    expect(reloaded.prNumber).toBe(777);
    expect(reloaded.prUrl).toBe("https://example.test/pr/777");
  });

  it("preserves canonical PR linkage fields when reload data only carries meta linkage", async () => {
    const adapter = getKanbanAdapter();

    const created = await adapter.createTask("internal", {
      title: "Meta-only reload linkage",
      description: "Hydrates canonical linkage from metadata",
      status: "todo",
      meta: {
        prLinkage: [{
          branchName: "feature/meta-only-linkage",
          prNumber: 654,
          prUrl: "https://example.test/pr/654",
          source: "auto-load",
          freshness: "fresh",
          updatedAt: "2026-03-22T12:00:00.000Z",
        }],
      },
    });

    loadStore();
    const reloadedAdapter = getKanbanAdapter();
    const reloaded = await reloadedAdapter.getTask(created.id);

    expect(reloaded.prLinkage).toHaveLength(1);
    expect(reloaded.meta?.prLinkage).toHaveLength(1);
    expect(reloaded.branchName).toBe("feature/meta-only-linkage");
    expect(reloaded.prNumber).toBe(654);
    expect(reloaded.prUrl).toBe("https://example.test/pr/654");
    expect(reloaded.meta?.prLinkageSource).toBe("auto-load");
    expect(reloaded.meta?.prLinkageFreshness).toBe("fresh");
    expect(reloaded.meta?.prLinkageUpdatedAt).toBe("2026-03-22T12:00:00.000Z");
  });

  it("exposes internal timeline, workflow tracking, and planner provenance on task detail", async () => {
    const adapter = getKanbanAdapter();

    addTask({
      id: "internal-detail-1",
      title: "Tracked internal task",
      status: "inreview",
      timeline: [{ type: "status.transition", status: "inreview", timestamp: "2026-03-08T10:00:00.000Z" }],
      workflowRuns: [{ workflowId: "wf-1", runId: "run-1", status: "completed", endedAt: "2026-03-08T10:05:00.000Z" }],
      statusHistory: [{ status: "inprogress", timestamp: "2026-03-08T09:55:00.000Z", source: "workflow" }],
      lastActivityAt: "2026-03-08T10:05:00.000Z",
      meta: {
        plannerProvenance: {
          plannerRunId: "planner-1",
          workflowRunId: "run-1",
          generatedAt: "2026-03-08T10:00:00.000Z",
          sourceLabels: ["scheduled-replenishment", "workflow"],
          plannerNodeId: "run-planner",
        },
      },
    });

    const task = await adapter.getTask("internal-detail-1");
    expect(Array.isArray(task.timeline)).toBe(true);
    expect(task.timeline.length).toBeGreaterThanOrEqual(1);
    expect(task.timeline.some((entry) => entry.type === "status.transition" || entry.status === "inreview")).toBe(true);
    expect(task.workflowRuns).toHaveLength(1);
    expect(Array.isArray(task.statusHistory)).toBe(true);
    expect(task.statusHistory).toHaveLength(1);
    expect(task.lastActivityAt).toBe("2026-03-08T10:05:00.000Z");
    expect(Array.isArray(task.meta.workflowRuns)).toBe(true);
    expect(Array.isArray(task.meta.timeline)).toBe(true);
    expect(task.meta?.plannerProvenance).toMatchObject({
      plannerRunId: "planner-1",
      workflowRunId: "run-1",
      generatedAt: "2026-03-08T10:00:00.000Z",
      sourceLabels: ["scheduled-replenishment", "workflow"],
      plannerNodeId: "run-planner",
    });
  });

  it("recovers title/description from legacy malformed planner payloads", async () => {
    const adapter = getKanbanAdapter();
    addTask({
      id: "legacy-malformed-1",
      title: "Untitled task",
      status: "todo",
      projectId: {
        title: "feat(legacy): recovered title",
        description: "Recovered description",
        status: "todo",
      },
    });

    const task = await adapter.getTask("legacy-malformed-1");
    expect(task).toBeTruthy();
    expect(task.title).toBe("feat(legacy): recovered title");
    expect(task.description).toBe("Recovered description");
    expect(task.projectId).toBe("internal");
  });

  it("supports payload-only createTask calls for the internal adapter", async () => {
    const adapter = getKanbanAdapter();

    const task = await adapter.createTask({
      title: "feat(workflow): payload-only createTask",
      description: "Created without explicit projectId arg",
      status: "draft",
      workspace: "virtengine-gh",
      repository: "virtengine/bosun",
    });

    expect(task).toBeTruthy();
    expect(task.title).toBe("feat(workflow): payload-only createTask");
    expect(task.description).toBe("Created without explicit projectId arg");
    expect(task.status).toBe("draft");
    expect(task.draft).toBe(true);
    expect(task.projectId).toBe("internal");
    expect(task.workspace).toBe("virtengine-gh");
    expect(task.repository).toBe("virtengine/bosun");

    const viaHelper = await createKanbanTask({
      title: "feat(workflow): payload-only helper createTask",
      description: "Created through exported helper without explicit projectId arg",
      status: "todo",
      workspace: "virtengine-gh",
      repository: "virtengine/bosun",
    });

    expect(viaHelper).toBeTruthy();
    expect(viaHelper.title).toBe("feat(workflow): payload-only helper createTask");
    expect(viaHelper.description).toBe(
      "Created through exported helper without explicit projectId arg",
    );
    expect(viaHelper.status).toBe("todo");
    expect(viaHelper.draft).toBe(false);
    expect(viaHelper.projectId).toBe("internal");
    expect(viaHelper.workspace).toBe("virtengine-gh");
    expect(viaHelper.repository).toBe("virtengine/bosun");
  });
});

