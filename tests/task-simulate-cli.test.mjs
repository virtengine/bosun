import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createTaskSimulationRuntime,
  executeTaskSimulationCommand,
  resolveTaskSimulationDefaultTargetBranch,
  runTaskSimulationCli,
} from "../task/task-simulate-cli.mjs";
import { resetWorkflowEngine } from "../workflow/workflow-engine.mjs";

const tempDirs = [];

afterEach(() => {
  resetWorkflowEngine();
  delete process.env.REPO_ROOT;
  delete process.env.BOSUN_STORE_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "bosun-task-simulate-"));
  tempDirs.push(dir);
  return dir;
}

function createFakeRuntime({
  repoRoot,
  taskById = {},
  ctx,
  retryCtx = null,
  workflowId = "workflow-task-lifecycle",
  workflowDefinitionsById = null,
  runHistory = [],
} = {}) {
  const definitionsById =
    workflowDefinitionsById && typeof workflowDefinitionsById === "object"
      ? workflowDefinitionsById
      : {
          [workflowId]: {
            id: workflowId,
            metadata: { installedFrom: "template-task-lifecycle" },
            nodes: [
              { id: "trigger", type: "trigger.task_available" },
              { id: "run-agent-plan", type: "action.run_agent" },
            ],
          },
        };
  const workflowDefinition =
    definitionsById[workflowId] || Object.values(definitionsById)[0];
  const listedWorkflows = Object.values(definitionsById).map((definition) => ({
    id: definition.id,
    enabled: definition.enabled !== false,
    metadata: definition.metadata || {},
  }));
  const resolvedRetryCtx = retryCtx || (ctx ? { ...ctx, id: `retry-${ctx.id}` } : null);
  const engine = {
    services: {
      kanban: {
        getTask: vi.fn(async (taskId) => taskById[taskId] || null),
      },
    },
    list: vi.fn(() => listedWorkflows),
    on: vi.fn(),
    off: vi.fn(),
    execute: vi.fn(async () => ctx),
    retryRun: vi.fn(async (runId, opts) => ({
      retryRunId: resolvedRetryCtx?.id || `retry-${runId}`,
      mode: opts?.mode || "from_failed",
      originalRunId: runId,
      ctx: resolvedRetryCtx,
    })),
    getRunHistory: vi.fn(() => runHistory),
    get: vi.fn((requestedWorkflowId) => (
      definitionsById[requestedWorkflowId] || workflowDefinition
    )),
  };
  return {
    repoRoot,
    runsDir: resolve(repoRoot, ".bosun", "workflow-runs"),
    workflowId,
    statePath: resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json"),
    engine,
    close: vi.fn(async () => {}),
  };
}

function buildContext({
  runId = "run-1",
  taskId = "",
  taskTitle = "",
  triggerOutput = null,
  terminalStatus = "completed",
  nodeStatuses = {},
} = {}) {
  return {
    id: runId,
    data: {
      ...(taskId ? { taskId } : {}),
      ...(taskTitle ? { taskTitle } : {}),
      _workflowTerminalStatus: terminalStatus,
    },
    errors: [],
    logs: [],
    getNodeOutput(nodeId) {
      if (nodeId === "trigger") return triggerOutput;
      return null;
    },
    getNodeStatus(nodeId) {
      return nodeStatuses[nodeId] || "completed";
    },
    getNodeInput() {
      return null;
    },
    getNodeTiming() {
      return null;
    },
  };
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result;
}

describe("task simulate CLI", () => {
  it("keeps origin/main when the current branch is the Bosun local ops branch", () => {
    const repoRoot = makeTempDir();
    git(["init"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    writeFileSync(resolve(repoRoot, "README.md"), "init\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "init"], repoRoot);
    git(["branch", "-M", "main"], repoRoot);
    git(["checkout", "-b", "bosun/codex-self-improvement-loop-commits"], repoRoot);

    const resolved = resolveTaskSimulationDefaultTargetBranch(
      {
        branchRouting: {
          defaultBranch: "origin/main",
          scopeMap: {},
        },
      },
      repoRoot,
    );

    expect(resolved).toBe("origin/main");
  });

  it("still prefers a generic non-main feature branch when config still defaults to origin/main", () => {
    const repoRoot = makeTempDir();
    git(["init"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    writeFileSync(resolve(repoRoot, "README.md"), "init\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "init"], repoRoot);
    git(["branch", "-M", "main"], repoRoot);
    git(["checkout", "-b", "feature/local-sim-base"], repoRoot);

    const resolved = resolveTaskSimulationDefaultTargetBranch(
      {
        branchRouting: {
          defaultBranch: "origin/main",
          scopeMap: {},
        },
      },
      repoRoot,
    );

    expect(resolved).toBe("feature/local-sim-base");
  });

  it("writes origin/main into the installed task workflow when the current branch is the Bosun local ops branch", async () => {
    const repoRoot = makeTempDir();
    git(["init"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    writeFileSync(resolve(repoRoot, "README.md"), "init\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "init"], repoRoot);
    git(["branch", "-M", "main"], repoRoot);
    git(["checkout", "-b", "bosun/codex-self-improvement-loop-commits"], repoRoot);

    const runtime = await createTaskSimulationRuntime({
      repoRoot,
      config: {
        repoRoot,
        workflowDefaults: {
          profile: "balanced",
          templates: [],
          autoInstall: true,
        },
        branchRouting: {
          defaultBranch: "origin/main",
          scopeMap: {},
          autoRebaseOnMerge: true,
          assessWithSdk: true,
        },
      },
      storePath: resolve(repoRoot, ".bosun", ".cache", "task-sim-test-store.json"),
    });

    try {
      expect(runtime.defaultTargetBranch).toBe("origin/main");
      const workflow = runtime.engine.get(runtime.workflowId);
      expect(workflow?.variables?.defaultTargetBranch).toBe("origin/main");
    } finally {
      await runtime.close?.();
    }
  });

  it("refreshes the installed task lifecycle workflow before reuse when the stored definition is stale", async () => {
    const repoRoot = makeTempDir();
    git(["init"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    writeFileSync(resolve(repoRoot, "README.md"), "init\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "init"], repoRoot);
    git(["branch", "-M", "main"], repoRoot);
    git(["checkout", "-b", "bosun/codex-self-improvement-loop-commits"], repoRoot);

    const config = {
      repoRoot,
      workflowDefaults: {
        profile: "balanced",
        templates: [],
        autoInstall: true,
      },
      branchRouting: {
        defaultBranch: "origin/main",
        scopeMap: {},
      },
    };
    const storePath = resolve(repoRoot, ".bosun", ".cache", "task-sim-stale-install-store.json");

    const runtime = await createTaskSimulationRuntime({
      repoRoot,
      config,
      storePath,
    });

    try {
      const workflowPath = resolve(repoRoot, ".bosun", "workflows", `${runtime.workflowId}.json`);
      const installed = JSON.parse(readFileSync(workflowPath, "utf8"));
      const implementNode = installed.nodes.find((node) => node.id === "run-agent-implement");
      expect(String(implementNode?.config?.prompt || "")).toContain("narrowest verification that proves the changed surface");

      implementNode.config.prompt = "{{_taskPrompt}}\n\nExecution phase: implementation. Complete implementation after tests exist, run required verification (tests/lint/build), then commit, push, and create/update PR.";
      writeFileSync(workflowPath, JSON.stringify(installed, null, 2), "utf8");
    } finally {
      await runtime.close?.();
      resetWorkflowEngine();
    }

    const refreshedRuntime = await createTaskSimulationRuntime({
      repoRoot,
      config,
      storePath,
    });

    try {
      const workflowPath = resolve(repoRoot, ".bosun", "workflows", `${refreshedRuntime.workflowId}.json`);
      const refreshed = JSON.parse(readFileSync(workflowPath, "utf8"));
      const implementNode = refreshed.nodes.find((node) => node.id === "run-agent-implement");
      expect(String(implementNode?.config?.prompt || "")).toContain("narrowest verification that proves the changed surface");
      expect(String(refreshedRuntime.engine.get(refreshedRuntime.workflowId)?.nodes?.find((node) => node.id === "run-agent-implement")?.config?.prompt || "")).toContain("narrowest verification that proves the changed surface");
    } finally {
      await refreshedRuntime.close?.();
    }
  });

  it("runs an explicit task through the installed lifecycle workflow", async () => {
    const repoRoot = makeTempDir();
    const task = {
      id: "task-123",
      title: "Fix prompt routing",
      baseBranch: "origin/main",
    };
    const ctx = buildContext({
      runId: "run-explicit",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        task,
      },
      nodeStatuses: {
        trigger: "completed",
        "run-agent-plan": "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
    });
    runtime.defaultTargetBranch = "bosun/codex-self-improvement-loop-commits";
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith(runtime.workflowId, expect.objectContaining({
      taskId: task.id,
      taskTitle: task.title,
      task: expect.objectContaining({
        id: task.id,
        baseBranch: "bosun/codex-self-improvement-loop-commits",
        base_branch: "bosun/codex-self-improvement-loop-commits",
      }),
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.taskId).toBe(task.id);
    expect(payload.status).toBe("completed");
    expect(payload.nodes.some((node) => node.id === "run-agent-plan")).toBe(true);
    const saved = JSON.parse(readFileSync(runtime.statePath, "utf8"));
    expect(saved.taskId).toBe(task.id);
  });

  it("routes an in-review task with PR context through the installed PR progressor workflow", async () => {
    const repoRoot = makeTempDir();
    const task = {
      id: "task-review",
      title: "Repair failed PR",
      status: "in_review",
      branchName: "task/e274fdfc65a8-fix-pr",
      baseBranch: "origin/main",
      prNumber: 487,
      prUrl: "https://github.com/virtengine/bosun/pull/487",
    };
    const ctx = buildContext({
      runId: "run-pr-progressor",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        taskTitle: task.title,
        prNumber: task.prNumber,
        prUrl: task.prUrl,
      },
      nodeStatuses: {
        trigger: "completed",
        "inspect-pr": "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
      workflowDefinitionsById: {
        "workflow-task-lifecycle": {
          id: "workflow-task-lifecycle",
          metadata: { installedFrom: "template-task-lifecycle" },
          nodes: [
            { id: "trigger", type: "trigger.task_available" },
            { id: "run-agent-plan", type: "action.run_agent" },
          ],
        },
        "workflow-pr-progressor": {
          id: "workflow-pr-progressor",
          metadata: { installedFrom: "template-bosun-pr-progressor" },
          nodes: [
            { id: "trigger", type: "trigger.workflow_call" },
            { id: "inspect-pr", type: "action.run_command" },
          ],
        },
      },
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith("workflow-pr-progressor", expect.objectContaining({
      taskId: task.id,
      taskTitle: task.title,
      branch: task.branchName,
      baseBranch: task.baseBranch,
      prNumber: task.prNumber,
      prUrl: task.prUrl,
      repo: "virtengine/bosun",
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.templateId).toBe("template-bosun-pr-progressor");
    expect(payload.workflowId).toBe("workflow-pr-progressor");
    expect(payload.nodes.some((node) => node.id === "inspect-pr")).toBe(true);
    const saved = JSON.parse(readFileSync(runtime.statePath, "utf8"));
    expect(saved.workflowId).toBe("workflow-pr-progressor");
  });

  it("replays a done task with stale synthetic base context through the installed lifecycle workflow", async () => {
    const repoRoot = makeTempDir();
    const task = {
      id: "task-merged",
      title: "Confirm merged PR state",
      status: "done",
      branchName: "task/e274fdfc65a8-fix-pr",
      baseBranch: "monitor-postmerge-sync",
      prNumber: 487,
      prUrl: "https://github.com/virtengine/bosun/pull/487",
    };
    const ctx = buildContext({
      runId: "run-pr-progressor-done",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        task,
      },
      nodeStatuses: {
        trigger: "completed",
        "run-agent-plan": "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
      workflowDefinitionsById: {
        "workflow-task-lifecycle": {
          id: "workflow-task-lifecycle",
          metadata: { installedFrom: "template-task-lifecycle" },
          nodes: [
            { id: "trigger", type: "trigger.task_available" },
            { id: "run-agent-plan", type: "action.run_agent" },
          ],
        },
        "workflow-pr-progressor": {
          id: "workflow-pr-progressor",
          metadata: { installedFrom: "template-bosun-pr-progressor" },
          nodes: [
            { id: "trigger", type: "trigger.workflow_call" },
            { id: "inspect-pr", type: "action.run_command" },
          ],
        },
      },
    });
    runtime.defaultTargetBranch = "origin/main";
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith("workflow-task-lifecycle", expect.objectContaining({
      taskId: task.id,
      taskTitle: task.title,
      task: expect.objectContaining({
        id: task.id,
        status: "done",
        prNumber: task.prNumber,
        prUrl: task.prUrl,
        baseBranch: "origin/main",
        base_branch: "origin/main",
      }),
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.templateId).toBe("template-task-lifecycle");
    expect(payload.workflowId).toBe("workflow-task-lifecycle");
    expect(payload.nodes.some((node) => node.id === "run-agent-plan")).toBe(true);
    const saved = JSON.parse(readFileSync(runtime.statePath, "utf8"));
    expect(saved.workflowId).toBe("workflow-task-lifecycle");
  });

  it("rewrites stored Bosun local ops task bases back to origin/main during simulation", async () => {
    const repoRoot = makeTempDir();
    const task = {
      id: "task-ops-base",
      title: "Fix prompt routing",
      baseBranch: "bosun/codex-self-improvement-loop-commits",
    };
    const ctx = buildContext({
      runId: "run-ops-base",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        task,
      },
      nodeStatuses: {
        trigger: "completed",
        "run-agent-plan": "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
    });
    runtime.defaultTargetBranch = "origin/main";
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith(runtime.workflowId, expect.objectContaining({
      taskId: task.id,
      taskTitle: task.title,
      task: expect.objectContaining({
        id: task.id,
        baseBranch: "origin/main",
        base_branch: "origin/main",
      }),
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.taskId).toBe(task.id);
  });

  it("runs without an explicit task id and persists the selected next task", async () => {
    const repoRoot = makeTempDir();
    const selectedTask = { id: "task-next", title: "Next runnable task" };
    const ctx = buildContext({
      runId: "run-next",
      triggerOutput: {
        triggered: true,
        reason: "selected_task",
        taskId: selectedTask.id,
        task: selectedTask,
      },
      nodeStatuses: {
        trigger: "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      ctx,
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith(runtime.workflowId, expect.not.objectContaining({
      taskId: expect.any(String),
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.taskId).toBe(selectedTask.id);
    expect(payload.explicitTaskId).toBeNull();
    const saved = JSON.parse(readFileSync(runtime.statePath, "utf8"));
    expect(saved.taskId).toBe(selectedTask.id);
  });

  it("ignores flag values when selecting the next task without an explicit task id", async () => {
    const repoRoot = makeTempDir();
    const selectedTask = { id: "task-next-flags", title: "Next task with flags" };
    const ctx = buildContext({
      runId: "run-next-flags",
      triggerOutput: {
        triggered: true,
        reason: "selected_task",
        taskId: selectedTask.id,
        task: selectedTask,
      },
      nodeStatuses: {
        trigger: "completed",
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      ctx,
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      [
        "simulate",
        "task",
        "--json",
        "--diagnose",
        "--config-dir",
        "/tmp/bosun-config",
        "--repo-root",
        "/tmp/repo-root",
      ],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith(runtime.workflowId, expect.not.objectContaining({
      taskId: expect.any(String),
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.taskId).toBe(selectedTask.id);
    expect(payload.explicitTaskId).toBeNull();
  });

  it("restarts the last simulated task from persisted state", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-restart", title: "Restart me" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ taskId: task.id, taskTitle: task.title }, null, 2),
      "utf8",
    );
    const ctx = buildContext({
      runId: "run-restart",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        task,
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", "restart", "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledWith(runtime.workflowId, expect.objectContaining({
      taskId: task.id,
    }));
    const payload = JSON.parse(stdout[0]);
    expect(payload.restarted).toBe(true);
    expect(payload.taskId).toBe(task.id);
  });

  it("shows help through the top-level CLI route", () => {
    const result = spawnSync(
      process.execPath,
      ["cli.mjs", "simulate", "task", "--help"],
      {
        cwd: process.cwd(),
        env: { ...process.env },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(String(result.stdout || "")).toContain("bosun simulate");
    expect(String(result.stdout || "")).toContain("task restart");
  });

  it("supports direct help invocation from the simulator module", async () => {
    const stdout = [];

    const result = await runTaskSimulationCli(["--help"], {
      stdout: (line) => stdout.push(line),
    });

    expect(result.ok).toBe(true);
    expect(stdout[0]).toContain("bosun simulate");
  });

  it("returns structured JSON when in-process code calls process.exit", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-exit", title: "Exit during simulation" };
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx: null,
    });
    runtime.engine.execute = vi.fn(async () => {
      process.exit(0);
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      {
        runtime,
        stdout: (line) => stdout.push(line),
        forceJsonOutput: true,
      },
    );

    expect(result.ok).toBe(true);
    const payload = JSON.parse(stdout[0]);
    expect(payload.status).toBe("failed");
    expect(payload.taskId).toBe(task.id);
    expect(payload.errors.some((entry) => entry?.name === "TaskSimulationProcessExitError")).toBe(true);
  });

  it("blocks overlapping task simulation runs when a live lock file exists", async () => {
    const repoRoot = makeTempDir();
    const runtime = createFakeRuntime({ repoRoot });
    const lockPath = resolve(repoRoot, ".bosun", ".cache", "task-simulator.pid");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        lockToken: "existing-lock",
        startedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );

    await expect(
      executeTaskSimulationCommand(["simulate", "task", "--json"], { runtime }),
    ).rejects.toThrow(/Another task simulator instance is already running/);

    expect(runtime.engine.execute).not.toHaveBeenCalled();
    expect(runtime.engine.retryRun).not.toHaveBeenCalled();
  });

  it("cleans up stale simulator locks and releases its own lock on success", async () => {
    const repoRoot = makeTempDir();
    const task = {
      id: "task-lock-cleanup",
      title: "Recover stale simulator lock",
      baseBranch: "origin/main",
    };
    const ctx = buildContext({
      runId: "run-lock-cleanup",
      taskId: task.id,
      taskTitle: task.title,
      triggerOutput: {
        triggered: true,
        reason: "direct_task",
        taskId: task.id,
        task,
      },
    });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
    });
    const lockPath = resolve(repoRoot, ".bosun", ".cache", "task-simulator.pid");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        lockToken: "stale-lock",
        startedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json"],
      { runtime, forceJsonOutput: true, stdout: () => {} },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.execute).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
  });

  // ── resume ───────────────────────────────────────────────────────────────

  it("resume throws when no prior run is recorded in state", async () => {
    const repoRoot = makeTempDir();
    const runtime = createFakeRuntime({ repoRoot });

    await expect(
      executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime }),
    ).rejects.toThrow(/No prior simulation run recorded for resume/);

    expect(runtime.engine.retryRun).not.toHaveBeenCalled();
    expect(runtime.engine.execute).not.toHaveBeenCalled();
  });

  it("resume calls engine.retryRun with mode=from_failed using saved runId", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-resume", title: "Resumable task" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-prior-99",
        workflowId: "workflow-task-lifecycle",
        repoRoot,
        savedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const ctx = buildContext({ runId: "run-resumed-99", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
      retryCtx: ctx,
    });
    const stdout = [];

    const result = await executeTaskSimulationCommand(
      ["simulate", "task", "resume", "--json"],
      { runtime, stdout: (line) => stdout.push(line), forceJsonOutput: true },
    );

    expect(result.ok).toBe(true);
    expect(runtime.engine.retryRun).toHaveBeenCalledOnce();
    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-prior-99", { mode: "from_failed" });
    expect(runtime.engine.execute).not.toHaveBeenCalled();

    const payload = JSON.parse(stdout[0]);
    expect(payload.resumed).toBe(true);
    expect(payload.restarted).toBe(false);
    expect(payload.resumeMode).toBe("from_failed");
    expect(payload.originalRunId).toBe("run-prior-99");
  });

  it("resume forwards explicit --mode to engine.retryRun", async () => {
    const repoRoot = makeTempDir();
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ taskId: "task-mode", runId: "run-mode-1", savedAt: new Date().toISOString() }),
      "utf8",
    );
    const ctx = buildContext({ runId: "run-mode-retry", taskId: "task-mode" });
    const runtime = createFakeRuntime({ repoRoot, retryCtx: ctx, ctx });

    await executeTaskSimulationCommand(
      ["simulate", "task", "resume", "--mode", "replan_from_failed"],
      { runtime },
    );

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-mode-1", { mode: "replan_from_failed" });
  });

  it("resume refuses to rerun a terminal task that is already done", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-done", title: "Already done", status: "done" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-done-1",
        workflowId: "workflow-task-lifecycle",
        savedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const ctx = buildContext({ runId: "run-done-retry", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx: ctx,
      ctx,
    });

    await expect(
      executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime }),
    ).rejects.toThrow(/resume is not allowed for terminal tasks/i);

    expect(runtime.engine.retryRun).not.toHaveBeenCalled();
    expect(runtime.engine.execute).not.toHaveBeenCalled();
  });

  it("resume honors --state-path overrides from the CLI", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-state-override", title: "Use overridden resume state" };
    const defaultStatePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    const overrideStatePath = resolve(repoRoot, ".bosun", ".cache", "resume-override.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      defaultStatePath,
      JSON.stringify({ taskId: "task-stale", runId: "run-stale", savedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    writeFileSync(
      overrideStatePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-override-1",
        workflowId: "workflow-task-lifecycle",
        savedAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
    const ctx = buildContext({ runId: "run-override-retry", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx: ctx,
      ctx,
    });

    await executeTaskSimulationCommand(
      ["simulate", "task", "resume", "--state-path", overrideStatePath],
      { runtime },
    );

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-override-1", { mode: "from_failed" });
  });

  it("resume prefers a newer same-lineage task run over the cached completed root run", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-newer", title: "Use latest interrupted run" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-stale-completed",
        workflowId: "workflow-task-lifecycle",
        savedAt: "2026-04-26T15:00:00.000Z",
      }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-retried-latest", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx,
      ctx: retryCtx,
      runHistory: [
        {
          runId: "run-latest-running",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-stale-completed",
          retryOf: "run-stale-completed",
          status: "running",
          startedAt: "2026-04-26T15:05:00.000Z",
          latestCheckpoint: { eventCursor: 25, updatedAt: "2026-04-26T15:07:00.000Z" },
        },
        {
          runId: "run-stale-completed",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-stale-completed",
          status: "completed",
          endedAt: "2026-04-26T14:59:00.000Z",
          latestCheckpoint: { eventCursor: 12, updatedAt: "2026-04-26T14:59:00.000Z" },
        },
      ],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-latest-running", { mode: "from_failed" });
  });

  it("resume prefers the most advanced same-lineage frontier over a newer but less progressed retry", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-progress", title: "Use most advanced interrupted run" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-root",
        workflowId: "workflow-task-lifecycle",
        savedAt: "2026-04-26T15:00:00.000Z",
      }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-retried-frontier", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx,
      ctx: retryCtx,
      runHistory: [
        {
          runId: "run-newer-less-progressed",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-root",
          retryOf: "run-root",
          status: "running",
          startedAt: "2026-04-26T15:10:00.000Z",
          latestCheckpoint: { eventCursor: 20, updatedAt: "2026-04-26T15:11:00.000Z" },
        },
        {
          runId: "run-older-more-progressed",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-root",
          retryOf: "run-root",
          status: "running",
          startedAt: "2026-04-26T15:05:00.000Z",
          latestCheckpoint: { eventCursor: 51, updatedAt: "2026-04-26T15:12:00.000Z" },
        },
        {
          runId: "run-root",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-root",
          status: "completed",
          startedAt: "2026-04-26T15:00:00.000Z",
          endedAt: "2026-04-26T15:04:00.000Z",
          latestCheckpoint: { eventCursor: 18, updatedAt: "2026-04-26T15:04:00.000Z" },
        },
      ],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-older-more-progressed", { mode: "from_failed" });
  });

  it("resume falls back to the most useful same-task frontier when the cached run is a completed retry wrapper", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-wrapper", title: "Skip completed retry wrapper" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-wrapper-completed",
        workflowId: "workflow-task-lifecycle",
        savedAt: "2026-04-26T15:00:00.000Z",
      }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-wrapper-retry", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx,
      ctx: retryCtx,
      runHistory: [
        {
          runId: "run-wrapper-completed",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-root-wrapper",
          retryOf: "run-root-wrapper",
          status: "completed",
          startedAt: "2026-04-26T15:06:00.000Z",
          endedAt: "2026-04-26T15:07:00.000Z",
          latestCheckpoint: { eventCursor: 2, updatedAt: "2026-04-26T15:07:00.000Z" },
        },
        {
          runId: "run-live-tests",
          workflowId: "workflow-task-lifecycle",
          taskId: task.id,
          rootRunId: "run-live-tests",
          status: "running",
          startedAt: "2026-04-26T15:08:00.000Z",
          latestCheckpoint: { eventCursor: 41, updatedAt: "2026-04-26T15:10:00.000Z" },
        },
      ],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-live-tests", { mode: "from_failed" });
  });

  it("resume recovers a same-task frontier from saved wrapper filtered tasks when cached state lost taskId", async () => {
    const repoRoot = makeTempDir();
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    const runsDir = resolve(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: null,
        taskTitle: null,
        runId: "run-wrapper",
        workflowId: "workflow-task-lifecycle",
        savedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    writeFileSync(
      resolve(runsDir, "run-wrapper.json"),
      JSON.stringify({
        id: "run-wrapper",
        nodeOutputs: {
          trigger: {
            triggered: false,
            reason: "prompt_quality_filtered",
            filteredTasks: [
              { taskId: "task-meaningful", missing: ["url"] },
              { taskId: "task-other", missing: ["url"] },
            ],
          },
        },
      }),
      "utf8",
    );
    const retryCtx = buildContext({
      runId: "run-retried-meaningful",
      taskId: "task-meaningful",
      taskTitle: "Recovered meaningful task",
    });
    const runtime = createFakeRuntime({
      repoRoot,
      retryCtx,
      ctx: retryCtx,
      runHistory: [
        {
          runId: "run-wrapper",
          status: "completed",
          workflowId: "workflow-task-lifecycle",
          rootRunId: "lineage-root",
        },
        {
          runId: "run-live-tests",
          status: "running",
          workflowId: "workflow-task-lifecycle",
          taskId: "task-meaningful",
        },
      ],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-live-tests", { mode: "from_failed" });
  });

  it("resume calls getRunHistory with the live engine binding before choosing a newer lineage run", async () => {
    const repoRoot = makeTempDir();
    const task = { id: "task-bound", title: "Bound run history" };
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: task.id,
        taskTitle: task.title,
        runId: "run-root-bound",
        workflowId: "workflow-task-lifecycle",
        savedAt: "2026-04-26T15:00:00.000Z",
      }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-bound-retry", taskId: task.id, taskTitle: task.title });
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      retryCtx,
      ctx: retryCtx,
      runHistory: [],
    });
    runtime.engine._history = [
      {
        runId: "run-frontier-bound",
        workflowId: "workflow-task-lifecycle",
        taskId: task.id,
        rootRunId: "run-root-bound",
        retryOf: "run-root-bound",
        status: "running",
        startedAt: "2026-04-26T15:05:00.000Z",
        latestCheckpoint: { eventCursor: 33, updatedAt: "2026-04-26T15:06:00.000Z" },
      },
      {
        runId: "run-root-bound",
        workflowId: "workflow-task-lifecycle",
        taskId: task.id,
        rootRunId: "run-root-bound",
        status: "completed",
        startedAt: "2026-04-26T15:00:00.000Z",
        endedAt: "2026-04-26T15:04:00.000Z",
      },
    ];
    runtime.engine.getRunHistory = vi.fn(function getRunHistoryBound() {
      return this._history;
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.getRunHistory).toHaveBeenCalledWith("workflow-task-lifecycle", 200);
    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-frontier-bound", { mode: "from_failed" });
  });

  it("resume updates the state file with the new retry run ID", async () => {
    const repoRoot = makeTempDir();
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ taskId: "task-persist", runId: "run-old", savedAt: new Date().toISOString() }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-new", taskId: "task-persist" });
    const runtime = createFakeRuntime({ repoRoot, retryCtx, ctx: retryCtx });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.runId).toBe("run-new");
    expect(saved.taskId).toBe("task-persist");
  });

  it("resume preserves the prior task state when a skipped retry wrapper reports no task identity", async () => {
    const repoRoot = makeTempDir();
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        taskId: null,
        taskTitle: null,
        runId: "run-meaningful",
        workflowId: "workflow-task-lifecycle",
        savedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-wrapper-only" });
    const runtime = createFakeRuntime({
      repoRoot,
      retryCtx,
      ctx: retryCtx,
      runHistory: [{
        id: "run-meaningful",
        taskId: "task-meaningful",
        taskTitle: "Meaningful task",
        workflowId: "workflow-task-lifecycle",
      }],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.runId).toBe("run-meaningful");
    expect(saved.taskId).toBe("task-meaningful");
    expect(saved.taskTitle).toBe("Meaningful task");
    expect(saved.workflowId).toBe("workflow-task-lifecycle");
  });

  it("resume text-mode output includes mode=resume line with retryMode and originalRunId", async () => {
    const repoRoot = makeTempDir();
    const statePath = resolve(repoRoot, ".bosun", ".cache", "task-simulator-last-run.json");
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ taskId: "task-txt", runId: "run-txt-1", savedAt: new Date().toISOString() }),
      "utf8",
    );
    const retryCtx = buildContext({ runId: "run-txt-resume", taskId: "task-txt" });
    const runtime = createFakeRuntime({ repoRoot, retryCtx, ctx: retryCtx });
    const lines = [];

    await executeTaskSimulationCommand(
      ["simulate", "task", "resume"],
      { runtime, stdout: (l) => lines.push(l) },
    );

    const modeLine = lines.find((l) => String(l).startsWith("mode=resume"));
    expect(modeLine).toBeDefined();
    expect(modeLine).toMatch(/retryMode=from_failed/);
    expect(modeLine).toMatch(/originalRunId=run-txt-1/);
  });

  it("help text documents the resume subcommand and --mode option", async () => {
    const stdout = [];
    const result = await runTaskSimulationCli(["--help"], {
      stdout: (line) => stdout.push(line),
    });

    expect(result.ok).toBe(true);
    const text = stdout.join("\n");
    expect(text).toContain("task resume");
    expect(text).toContain("--mode");
    expect(text).toContain("replan_subgraph");
    expect(text).toContain("--diagnose");
  });

  it("includes diagnostics for runtime paths, completed nodes, and agent lineage in JSON output", async () => {
    const repoRoot = makeTempDir();
    mkdirSync(resolve(repoRoot, "workflow", "workflow-nodes"), { recursive: true });
    mkdirSync(resolve(repoRoot, "workflow-templates"), { recursive: true });
    mkdirSync(resolve(repoRoot, "task"), { recursive: true });
    writeFileSync(resolve(repoRoot, "workflow", "workflow-engine.mjs"), "source-engine\n", "utf8");
    writeFileSync(resolve(repoRoot, "workflow", "workflow-nodes", "actions.mjs"), "source-actions\n", "utf8");
    const task = { id: "task-diagnostics", title: "Diagnose simulator" };
    const ctx = buildContext({
      runId: "run-diagnostics",
      taskId: task.id,
      taskTitle: task.title,
      nodeStatuses: {
        trigger: "completed",
        "run-agent-plan": "completed",
      },
    });
    ctx.getNodeOutput = (nodeId) => {
      if (nodeId === "trigger") return { triggered: true, taskId: task.id, task };
      if (nodeId === "run-agent-plan") return { lineageRunId: "run-diagnostics", sessionId: "session-1" };
      return null;
    };
    const runtime = createFakeRuntime({
      repoRoot,
      taskById: { [task.id]: task },
      ctx,
    });
    const stdout = [];

    await executeTaskSimulationCommand(
      ["simulate", "task", task.id, "--json", "--diagnose"],
      { runtime, stdout: (line) => stdout.push(line), forceJsonOutput: true },
    );

    const payload = JSON.parse(stdout[0]);
    expect(payload.diagnostics).toEqual(expect.objectContaining({
      mode: "explicit-task",
      completedNodeIds: expect.arrayContaining(["trigger", "run-agent-plan"]),
    }));
    expect(payload.diagnostics.agentLineage).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "run-agent-plan", lineageRunId: "run-diagnostics" }),
    ]));
    expect(payload.diagnostics.runtime).toEqual(expect.objectContaining({
      repoRoot: expect.stringContaining("bosun-task-simulate-"),
      hasMirrorDrift: false,
    }));
  });

});
