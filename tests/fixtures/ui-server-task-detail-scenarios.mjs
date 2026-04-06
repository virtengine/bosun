import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resetStateLedgerCache } from "../../lib/state-ledger-sqlite.mjs";
import { _resetRuntimeAccumulatorForTests } from "../../infra/runtime-accumulator.mjs";
import { _resetSingleton as resetSessionTrackerSingleton } from "../../infra/session-tracker.mjs";

async function settleUiRuntimeCleanup() {
  const mod = await import("../../server/ui-server.mjs");
  const taskStore = await import("../../task/task-store.mjs");
  mod.stopTelegramUiServer();
  await taskStore._resetForTests();
  resetSessionTrackerSingleton({ persistDir: null });
  _resetRuntimeAccumulatorForTests();
  resetStateLedgerCache();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function removeDirWithRetries(dirPath) {
  if (!dirPath) return;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM") throw error;
      resetStateLedgerCache();
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function setupRuntimeEnv(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  process.env.VITEST = "1";
  process.env.BOSUN_ENV_NO_OVERRIDE = "1";
  process.env.TELEGRAM_UI_TLS_DISABLE = "true";
  process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
  process.env.TELEGRAM_UI_TUNNEL = "disabled";
  process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
  process.env.TELEGRAM_BOT_TOKEN = "";
  process.env.TELEGRAM_CHAT_ID = "";
  process.env.KANBAN_BACKEND = "internal";
  process.env.BOSUN_HOME = root;
  process.env.BOSUN_DIR = root;
  process.env.BOSUN_TEST_CACHE_DIR = join(root, ".cache");
  process.env.BOSUN_STATE_LEDGER_PATH = join(root, "state-ledger.sqlite");
  process.env.CODEX_MONITOR_HOME = root;
  process.env.CODEX_MONITOR_DIR = root;
  process.env.REPO_ROOT = root;
  process.env.BOSUN_CONFIG_PATH = join(root, "bosun.config.json");
  writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
    harness: { enabled: true, validation: { mode: "report" } },
  }, null, 2));
  return root;
}

async function cleanupRuntimeEnv(root, extraPaths = []) {
  await settleUiRuntimeCleanup();
  for (const path of extraPaths) {
    await removeDirWithRetries(path);
  }
  await removeDirWithRetries(root);
}

async function runReplayableTaskRunsScenario() {
  const root = setupRuntimeEnv("bosun-ui-task-runs-script-");
  const mod = await import("../../server/ui-server.mjs");
  let server = null;
  try {
    server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const taskStore = await import("../../task/task-store.mjs");
    taskStore.addTask({ id: "task-replay-1", title: "Replay me", status: "blocked" });
    taskStore.appendTaskRun("task-replay-1", {
      runId: "run-replay-1",
      startedAt: "2026-03-22T10:00:00.000Z",
      status: "failed",
      sdk: "codex",
      threadId: "thread-replay-1",
      steps: [
        { type: "thread", payload: { sdk: "codex", resumed: false } },
        { type: "assistant", payload: { content: "Investigated the failure and need a follow-up turn." } },
      ],
    });

    const detail = await fetch(`http://127.0.0.1:${port}/api/tasks/detail?taskId=task-replay-1`).then((response) => response.json());
    return {
      ok: detail.ok === true
        && Array.isArray(detail.data?.runs)
        && detail.data.runs[0]?.runId === "run-replay-1"
        && detail.data.runs[0]?.replayable === true
        && detail.data.runs[0]?.steps?.[0]?.summary === "Started codex session."
        && String(detail.data?.meta?.latestRunSummary || "").includes("Investigated the failure"),
      details: {
        ok: detail.ok === true,
        runId: detail.data?.runs?.[0]?.runId || null,
        replayable: detail.data?.runs?.[0]?.replayable === true,
        latestRunSummary: detail.data?.meta?.latestRunSummary || null,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runLinkedSessionBackfillScenario() {
  const root = setupRuntimeEnv("bosun-ui-linked-task-session-script-");
  const worktreeDir = mkdtempSync(join(tmpdir(), "bosun-ui-linked-worktree-script-"));
  const mod = await import("../../server/ui-server.mjs");
  const { _resetSingleton, getSessionTracker } = await import("../../infra/session-tracker.mjs");
  _resetSingleton({ persistDir: null });
  let server = null;
  try {
    server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Persistent linked session task",
        description: "keep session links after blocking",
        status: "todo",
      }),
    }).then((response) => response.json());
    const taskId = created.data.id;

    const taskStore = await import("../../task/task-store.mjs");
    taskStore.updateTask(taskId, { status: "blocked" });

    const tracker = getSessionTracker();
    tracker.createSession({
      id: "session-linked-task-1",
      taskId,
      type: "task",
      metadata: {
        title: "Persistent linked session task",
        workspaceDir: worktreeDir,
        worktreePath: worktreeDir,
      },
    });

    const detail = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    ).then((response) => response.json());

    return {
      ok: detail.ok === true
        && detail.data?.status === "blocked"
        && detail.data?.sessionId === "session-linked-task-1"
        && detail.data?.primarySessionId === "session-linked-task-1"
        && detail.data?.worktreePath === worktreeDir
        && detail.data?.meta?.primarySessionId === "session-linked-task-1"
        && detail.data?.meta?.worktreePath === worktreeDir
        && Array.isArray(detail.data?.meta?.linkedSessionIds)
        && detail.data.meta.linkedSessionIds.includes("session-linked-task-1"),
      details: {
        ok: detail.ok === true,
        sessionId: detail.data?.sessionId || null,
        primarySessionId: detail.data?.primarySessionId || null,
        worktreePath: detail.data?.worktreePath || null,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await cleanupRuntimeEnv(root, [worktreeDir]);
  }
}

async function runWorkflowMergeScenario() {
  const root = setupRuntimeEnv("bosun-ui-workflow-merge-script-");
  const mod = await import("../../server/ui-server.mjs");
  const workflowEngineModule = await import("../../workflow/workflow-engine.mjs");
  let server = null;
  let runDetailCalls = 0;
  let traceCalls = 0;
  const fakeEngine = {
    getRunHistory: () => [],
    getRunDetail: () => {
      runDetailCalls += 1;
      throw new Error("run detail should not be loaded when summary metadata is present");
    },
    getTaskTraceEvents: () => {
      traceCalls += 1;
      return [];
    },
    registerTaskTraceHook: () => {},
    load: () => {},
  };
  mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

  try {
    server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Workflow merge task",
        description: "preserve stored workflow session link",
        status: "todo",
      }),
    }).then((response) => response.json());
    const taskId = created.data.id;

    fakeEngine.getRunHistory = () => [
      {
        runId: "run-merge-1",
        workflowId: "wf-merge-1",
        workflowName: "Merged workflow",
        status: "completed",
        startedAt: "2026-03-15T12:00:00.000Z",
        endedAt: "2026-03-15T12:02:00.000Z",
        duration: 120000,
        taskId,
        taskIds: [taskId],
        sessionId: "derived-session-1",
        primarySessionId: "derived-session-1",
        sessionIds: ["derived-session-1"],
        plannerTimeline: [
          {
            eventType: "planner.plan_completed",
            timestamp: "2026-03-15T12:01:30.000Z",
            summary: "Planner completed with ranked tasks.",
            stepLabel: "run-planner",
            status: "completed",
          },
        ],
        proofBundle: {
          summary: {
            plannerEventCount: 1,
            decisionCount: 1,
            evidenceCount: 1,
            artifactCount: 1,
          },
          plannerTimeline: [
            {
              eventType: "planner.plan_completed",
              timestamp: "2026-03-15T12:01:30.000Z",
              summary: "Planner completed with ranked tasks.",
              stepLabel: "run-planner",
              status: "completed",
            },
          ],
          decisions: [
            {
              source: "planner",
              decision: "planner.plan_completed",
              summary: "Planner completed with ranked tasks.",
            },
          ],
          evidence: [
            {
              source: "completion-evidence",
              kind: "artifact",
              summary: "Independent review proof",
            },
          ],
          artifacts: [
            {
              source: "ledger",
              kind: "planner_output",
              path: "/tmp/planner-output.json",
              summary: "Planner output captured.",
            },
          ],
        },
      },
    ];

    const taskStore = await import("../../task/task-store.mjs");
    taskStore.updateTask(taskId, {
      workflowRuns: [
        {
          runId: "run-merge-1",
          workflowId: "wf-merge-1",
          status: "linked",
          summary: "Stored workflow link",
          meta: { sessionId: "stored-session-1" },
        },
      ],
    });

    const detail = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    ).then((response) => response.json());
    const mergedRun = Array.isArray(detail.data?.workflowRuns)
      ? detail.data.workflowRuns.find((run) => run?.runId === "run-merge-1")
      : null;

    return {
      ok: detail.ok === true
        && mergedRun?.runId === "run-merge-1"
        && mergedRun?.workflowId === "wf-merge-1"
        && mergedRun?.sessionId === "stored-session-1"
        && mergedRun?.primarySessionId === "derived-session-1"
        && mergedRun?.meta?.sessionId === "stored-session-1"
        && mergedRun?.proofSummary?.plannerEventCount === 1
        && mergedRun?.proofSummary?.evidenceCount === 1
        && mergedRun?.proofSummary?.artifactCount === 1
        && mergedRun?.plannerTimeline?.[0]?.eventType === "planner.plan_completed"
        && mergedRun?.proofBundle?.artifacts?.[0]?.path === "/tmp/planner-output.json"
        && runDetailCalls === 0
        && traceCalls === 0,
      details: {
        ok: detail.ok === true,
        sessionId: mergedRun?.sessionId || null,
        primarySessionId: mergedRun?.primarySessionId || null,
        runDetailCalls,
        traceCalls,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    mod._testInjectWorkflowEngine(workflowEngineModule, null);
    await cleanupRuntimeEnv(root);
  }
}

async function runProjectSummaryScopeScenario() {
  const root = setupRuntimeEnv("bosun-project-summary-workspace-script-");
  const configPath = join(root, "bosun.config.json");
  const wsAlphaRepo = join(root, "workspaces", "alpha", "virtengine");
  const wsBetaRepo = join(root, "workspaces", "beta", "virtengine");
  mkdirSync(join(wsAlphaRepo, ".git"), { recursive: true });
  mkdirSync(join(wsBetaRepo, ".git"), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        $schema: "./bosun.schema.json",
        activeWorkspace: "alpha",
        workspaces: [
          {
            id: "alpha",
            name: "Alpha Workspace",
            path: join(root, "workspaces", "alpha"),
            activeRepo: "virtengine",
            repos: [{ name: "virtengine", path: wsAlphaRepo, primary: true }],
          },
          {
            id: "beta",
            name: "Beta Workspace",
            path: join(root, "workspaces", "beta"),
            activeRepo: "virtengine",
            repos: [{ name: "virtengine", path: wsBetaRepo, primary: true }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const mod = await import("../../server/ui-server.mjs");
  mod.injectUiDependencies({
    taskStoreApi: {
      listProjects: async () => [{ id: "internal", name: "Internal Task Store" }],
      listTasks: async () => ([
        { id: "task-alpha-done", title: "alpha done", status: "done", workspace: "alpha" },
        { id: "task-alpha-merged", title: "alpha merged", status: "merged", workspace: "alpha" },
        { id: "task-alpha-progress", title: "alpha working", status: "inprogress", workspace: "alpha" },
        { id: "task-beta-done", title: "beta done", status: "done", workspace: "beta" },
      ]),
    },
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const summary = await fetch(`http://127.0.0.1:${port}/api/project-summary`).then((response) => response.json());
    return {
      ok: summary.ok === true
        && summary.data?.taskCount === 3
        && summary.data?.completedCount === 2,
      details: {
        ok: summary.ok === true,
        taskCount: summary.data?.taskCount ?? null,
        completedCount: summary.data?.completedCount ?? null,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runGuardedStartScenario() {
  const root = setupRuntimeEnv("bosun-guarded-start-script-");
  process.env.EXECUTOR_MODE = "internal";
  const mod = await import("../../server/ui-server.mjs");
  let executeTaskCalls = 0;
  mod.injectUiDependencies({
    taskStoreApi: {
      canStartTask: () => ({ canStart: false, reason: "dependency_blocked", blockedBy: [{ taskId: "dep-1" }] }),
      appendTaskTimelineEvent: () => {},
      addTaskComment: () => ({ id: "comment-1" }),
    },
    getInternalExecutor: () => ({
      getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
      executeTask: async () => {
        executeTaskCalls += 1;
      },
      isPaused: () => false,
    }),
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded start task", description: "start guard" }),
    }).then((response) => response.json());
    const taskId = created.data.id;

    const blockedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    const blockedJson = await blockedResp.json();

    const forcedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId, force: true }),
    });
    const forcedJson = await forcedResp.json();

    return {
      ok: created.ok === true
        && blockedResp.status === 409
        && blockedJson.ok === false
        && blockedJson.canStart?.canStart === false
        && forcedResp.status === 200
        && forcedJson.ok === true
        && forcedJson.canStart?.override === true
        && executeTaskCalls === 1,
      details: {
        blockedStatus: blockedResp.status,
        blockedOk: blockedJson.ok,
        forcedStatus: forcedResp.status,
        forcedOk: forcedJson.ok,
        executeTaskCalls,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runGuardedLifecycleScenario() {
  const root = setupRuntimeEnv("bosun-guarded-lifecycle-script-");
  process.env.EXECUTOR_MODE = "internal";
  const mod = await import("../../server/ui-server.mjs");
  let executeTaskCalls = 0;
  mod.injectUiDependencies({
    taskStoreApi: {
      canStartTask: () => ({ canStart: false, reason: "dependency_blocked" }),
      appendTaskTimelineEvent: () => {},
    },
    getInternalExecutor: () => ({
      getStatus: () => ({ maxParallel: 3, activeSlots: 0, slots: [] }),
      executeTask: async () => {
        executeTaskCalls += 1;
      },
      isPaused: () => false,
    }),
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded lifecycle", description: "lifecycle guard" }),
    }).then((response) => response.json());

    const update = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        status: "inprogress",
        lifecycleAction: "start",
      }),
    }).then((response) => response.json());

    return {
      ok: created.ok === true
        && update.ok === true
        && update.lifecycle?.startDispatch?.started === false
        && update.lifecycle?.startDispatch?.reason === "start_guard_blocked"
        && executeTaskCalls === 0,
      details: {
        ok: update.ok === true,
        started: update.lifecycle?.startDispatch?.started,
        reason: update.lifecycle?.startDispatch?.reason || null,
        executeTaskCalls,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runBlockedDiagnosticsScenario() {
  const root = setupRuntimeEnv("bosun-blocked-diagnostics-script-");
  const mod = await import("../../server/ui-server.mjs");
  mod._testInjectWorkflowEngine(null, null);
  let taskId = null;
  mod.injectUiDependencies({
    taskStoreApi: {
      canStartTask: () => ({
        canStart: false,
        reason: "dependency_blocked",
        blockedBy: [{ taskId: "dep-1", reason: "Waiting for dep-1" }],
        blockingTaskIds: ["dep-1"],
      }),
    },
    getAgentSupervisor: () => ({
      getTaskDiagnostics: () => ({
        taskId,
        interventionCount: 2,
        lastIntervention: "continue_signal",
        lastDecision: { reason: "retry same thread" },
        apiErrorRecovery: {
          signature: "upstream timeout while polling",
          continueAttempts: 2,
          cooldownUntil: Date.now() + 60_000,
        },
      }),
    }),
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked detail task",
        description: "waiting on dependency",
        status: "blocked",
        blockedReason: "Dependency dep-1 is unresolved",
      }),
    }).then((response) => response.json());
    taskId = created.data.id;

    const detail = await fetch(`http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`).then((response) => response.json());
    const list = await fetch(`http://127.0.0.1:${port}/api/tasks`).then((response) => response.json());
    const listedTask = Array.isArray(list.data) ? list.data.find((entry) => entry.id === taskId) : null;

    return {
      ok: detail.ok === true
        && detail.data?.canStart?.canStart === false
        && detail.data?.blockedContext?.category === "dependency_blocked"
        && Array.isArray(detail.data?.blockedContext?.blockedBy)
        && detail.data.blockedContext.blockedBy[0]?.taskId === "dep-1"
        && String(detail.data?.blockedContext?.summary || "").includes("Bosun will not dispatch this task")
        && detail.data?.diagnostics?.stableCause?.code === "api_error_cooldown"
        && detail.data?.diagnostics?.supervisor?.apiErrorRecovery?.continueAttempts === 2
        && list.ok === true
        && Number(list.statusCounts?.blocked || 0) >= 1
        && listedTask?.canStart?.canStart === false
        && listedTask?.blockedContext?.category === "dependency_blocked"
        && listedTask?.diagnostics?.stableCause?.code === "api_error_cooldown",
      details: {
        detailOk: detail.ok === true,
        listOk: list.ok === true,
        blockedCategory: detail.data?.blockedContext?.category || null,
        stableCause: detail.data?.diagnostics?.stableCause?.code || null,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runLogDiagnosticsScenario() {
  const root = setupRuntimeEnv("bosun-log-diagnostics-script-");
  const mod = await import("../../server/ui-server.mjs");
  mod._testInjectWorkflowEngine(null, null);
  const logsDir = resolve(process.cwd(), ".bosun", "logs");
  mkdirSync(logsDir, { recursive: true });
  const monitorErrorPath = resolve(logsDir, "monitor-error.log");
  const previousMonitorError = existsSync(monitorErrorPath)
    ? readFileSync(monitorErrorPath, "utf8")
    : null;

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked worktree task",
        description: "collect recent worktree failure evidence",
        status: "blocked",
        branchName: "ve/task-log-tail-12345678",
      }),
    }).then((response) => response.json());
    const taskId = created.data.id;

    const filler = Array.from({ length: 8000 }, (_, index) => `2026-03-04T04:00:${String(index % 60).padStart(2, "0")}.000Z filler line ${index}`);
    filler.push(
      `2026-03-04T04:30:00.000Z [ERROR] Worktree acquisition failed for ${taskId} branch ve/task-log-tail-12345678`,
      `2026-03-04T04:31:00.000Z [ERROR] Worktree refresh failed for existing branch ve/task-log-tail-12345678; managed worktree was removed after stale refresh state (${taskId})`,
    );
    writeFileSync(monitorErrorPath, `${filler.join("\n")}\n`, "utf8");

    const detail = await fetch(`http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`).then((response) => response.json());
    const list = await fetch(`http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`).then((response) => response.json());
    const listedTask = Array.isArray(list.data) ? list.data.find((entry) => entry.id === taskId) : null;
    const detailEvidence = Array.isArray(detail.data?.blockedContext?.logEvidence) ? detail.data.blockedContext.logEvidence : [];
    const listEvidence = Array.isArray(listedTask?.blockedContext?.logEvidence) ? listedTask.blockedContext.logEvidence : [];

    return {
      ok: detail.ok === true
        && listedTask?.id === taskId
        && listedTask?.status === "blocked",
      details: {
        detailOk: detail.ok === true,
        listedStatus: listedTask?.status || null,
        evidenceCount: detailEvidence.length,
      },
    };
  } finally {
    if (previousMonitorError == null) {
      rmSync(monitorErrorPath, { force: true });
    } else {
      writeFileSync(monitorErrorPath, previousMonitorError, "utf8");
    }
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    await cleanupRuntimeEnv(root);
  }
}

async function runWorkflowRunEvidenceScenario() {
  const root = setupRuntimeEnv("bosun-workflow-run-evidence-script-");
  const mod = await import("../../server/ui-server.mjs");
  let taskId = "";
  let runDetailCalls = 0;
  let traceCalls = 0;
  const fakeEngine = {
    getRunHistory: () => [
      {
        runId: "run-worktree-failure-1",
        workflowId: "wf-worktree-failure-1",
        workflowName: "Task Lifecycle",
        status: "failed",
        startedAt: "2026-03-31T15:43:05.000Z",
        endedAt: "2026-03-31T15:43:23.000Z",
        duration: 18000,
        taskId,
        taskIds: [taskId],
        detail: {
          data: { taskId },
        },
        meta: {
          failureKind: "branch_refresh_conflict",
          error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
          worktreeFailure: {
            failureKind: "branch_refresh_conflict",
            blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
            error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
            retryable: false,
          },
        },
      },
    ],
    getRunDetail: (runId) => {
      runDetailCalls += 1;
      return {
        runId,
        workflowId: "wf-worktree-failure-1",
        workflowName: "Task Lifecycle",
        status: "failed",
        endedAt: "2026-03-31T15:43:23.000Z",
        detail: {
          data: { taskId },
        },
        meta: {
          failureKind: "branch_refresh_conflict",
          error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
          worktreeFailure: {
            failureKind: "branch_refresh_conflict",
            blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
            error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
            retryable: false,
          },
        },
      };
    },
    getTaskTraceEvents: () => {
      traceCalls += 1;
      return [];
    },
    registerTaskTraceHook: () => {},
    load: () => {},
  };
  mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked workflow-run evidence task",
        description: "derive blocked context from workflow-run metadata",
        status: "blocked",
        branchName: "task/example",
      }),
    }).then((response) => response.json());
    taskId = created.data.id;
    const taskStore = await import("../../task/task-store.mjs");
    await taskStore.updateTask(taskId, {
      status: "blocked",
      branchName: "task/example",
    });
    if (typeof taskStore.waitForStoreWrites === "function") {
      await taskStore.waitForStoreWrites();
    }

    const list = await fetch(`http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`).then((response) => response.json());
    const listedTask = Array.isArray(list.data) ? list.data.find((entry) => entry.id === taskId) : null;
    const workflowRunEvidence = Array.isArray(listedTask?.blockedContext?.workflowRunEvidence)
      ? listedTask.blockedContext.workflowRunEvidence
      : [];

    return {
      ok: list.ok === true
        && listedTask?.status === "blocked"
        && listedTask?.blockedContext?.category === "worktree_failure"
        && Number(listedTask?.blockedContext?.worktreeFailureCount || 0) > 0
        && workflowRunEvidence.some((entry) => (
          entry?.source === "workflow-run"
          && entry?.failureKind === "branch_refresh_conflict"
          && String(entry?.message || "").includes("Worktree refresh failed for existing branch")
        ))
        && runDetailCalls === 0
        && traceCalls === 0,
      details: {
        listOk: list.ok === true,
        category: listedTask?.blockedContext?.category || null,
        worktreeFailureCount: listedTask?.blockedContext?.worktreeFailureCount || 0,
        runDetailCalls,
        traceCalls,
      },
    };
  } finally {
    if (server) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    mod._testInjectWorkflowEngine(null, null);
    await cleanupRuntimeEnv(root);
  }
}

const scenario = String(process.argv[2] || "").trim();

const handlers = {
  "replayable-task-runs": runReplayableTaskRunsScenario,
  "linked-session-backfill": runLinkedSessionBackfillScenario,
  "workflow-merge": runWorkflowMergeScenario,
  "project-summary-scope": runProjectSummaryScopeScenario,
  "guarded-start": runGuardedStartScenario,
  "guarded-lifecycle": runGuardedLifecycleScenario,
  "blocked-diagnostics": runBlockedDiagnosticsScenario,
  "log-diagnostics": runLogDiagnosticsScenario,
  "workflow-run-evidence": runWorkflowRunEvidenceScenario,
};

if (!Object.prototype.hasOwnProperty.call(handlers, scenario)) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exitCode = 2;
} else {
  try {
    const result = await handlers[scenario]();
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
