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
  runHistory = [],
} = {}) {
  const workflowDefinition = {
    id: workflowId,
    nodes: [
      { id: "trigger", type: "trigger.task_available" },
      { id: "run-agent-plan", type: "action.run_agent" },
    ],
  };
  const resolvedRetryCtx = retryCtx || (ctx ? { ...ctx, id: `retry-${ctx.id}` } : null);
  const engine = {
    services: {
      kanban: {
        getTask: vi.fn(async (taskId) => taskById[taskId] || null),
      },
    },
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
    get: vi.fn(() => workflowDefinition),
  };
  return {
    repoRoot,
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

  it("resume keeps the cached run id even when a newer same-task non-completed run exists", async () => {
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
        { runId: "run-latest-running", taskId: task.id, status: "running", startedAt: "2026-04-26T15:05:00.000Z" },
        { runId: "run-stale-completed", taskId: task.id, status: "completed", endedAt: "2026-04-26T14:59:00.000Z" },
      ],
    });

    await executeTaskSimulationCommand(["simulate", "task", "resume"], { runtime });

    expect(runtime.engine.retryRun).toHaveBeenCalledWith("run-stale-completed", { mode: "from_failed" });
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
