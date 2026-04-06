import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const scenario = String(process.argv[2] || "").trim();

const handlers = {
  "replayable-task-runs": runReplayableTaskRunsScenario,
  "linked-session-backfill": runLinkedSessionBackfillScenario,
  "workflow-merge": runWorkflowMergeScenario,
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
