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

async function waitFor(condition, { timeoutMs = 20000, intervalMs = 50, message = "condition not met" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
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
  process.env.BOSUN_CONFIG_PATH = join(root, "bosun.config.json");
  process.env.BOSUN_HOME = root;
  process.env.BOSUN_DIR = root;
  process.env.BOSUN_TEST_CACHE_DIR = join(root, ".cache");
  process.env.BOSUN_STATE_LEDGER_PATH = join(root, "state-ledger.sqlite");
  process.env.CODEX_MONITOR_HOME = root;
  process.env.CODEX_MONITOR_DIR = root;
  writeFileSync(
    process.env.BOSUN_CONFIG_PATH,
    JSON.stringify({
      harness: { enabled: true, validation: { mode: "report" } },
    }, null, 2),
  );
  return root;
}

async function cleanupRuntimeEnv(root) {
  await settleUiRuntimeCleanup();
  await removeDirWithRetries(root);
}

async function stopScenarioServer(mod, serverRef) {
  if (!serverRef) return null;
  mod.stopTelegramUiServer();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return null;
}

async function runHistoryScenario() {
  const root = setupRuntimeEnv("bosun-harness-run-script-");
  const mod = await import("../../server/ui-server.mjs");
  let harnessTurnExecutorCallCount = 0;
  let releaseSlowStage = null;
  const slowStageEntered = new Promise((resolve) => {
    releaseSlowStage = resolve;
  });
  mod.injectUiDependencies({
    harnessTurnExecutor: async (context) => {
      harnessTurnExecutorCallCount += 1;
      if (context?.stage?.id === "plan" && String(context?.taskKey || "").includes("live-visibility")) {
        releaseSlowStage?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { success: true, outcome: "success", status: "completed" };
      }
      if (context?.stage?.id === "plan") {
        return { success: false, outcome: "needs-repair", status: "needs_repair", error: "lint failure" };
      }
      return { success: true, outcome: "success", status: "completed" };
    },
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const createdTaskJson = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Harness linked task", description: "Verify harness runs appear in canonical task detail history." }),
    }).then((r) => r.json());
    const taskId = createdTaskJson.data.id;
    const source = {
      name: "Bosun API Harness Runner",
      entryStageId: "plan",
      stages: [
        { id: "plan", type: "prompt", prompt: "Plan the work.", transitions: [{ on: "needs-repair", to: "repair" }], repairLoop: { maxAttempts: 1, targetStageId: "repair", backoffMs: 1 } },
        { id: "repair", type: "repair", prompt: "Repair the issue.", transitions: [{ on: "success", to: "done" }] },
        { id: "done", type: "finalize", prompt: "Summarize the finished work." },
      ],
    };

    const runJson = await fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: JSON.stringify(source), taskId }),
    }).then((r) => r.json());

    const liveRunPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "live-visibility-run",
        taskKey: "live-visibility:live-visibility-run",
        source: JSON.stringify({ name: "Bosun Live Harness", entryStageId: "plan", stages: [{ id: "plan", type: "prompt", prompt: "Plan the work." }] }),
      }),
    }).then((r) => r.json());
    await slowStageEntered;
    await fetch(`http://127.0.0.1:${port}/api/harness/runs?limit=10`).then((r) => r.json());
    await fetch(`http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent("live-visibility-run")}`).then((r) => r.json());
    await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    await fetch(`http://127.0.0.1:${port}/api/telemetry/summary`).then((r) => r.json());
    await liveRunPromise;
    await fetch(`http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent(runJson.runId)}/events?category=transition&direction=desc&limit=2`).then((r) => r.json());
    const replayJson = await fetch(`http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent(runJson.runId)}/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }).then((r) => r.json());
    const dryRunJson = await fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: JSON.stringify(source), dryRun: true }),
    }).then((r) => r.json());

    return {
      ok: runJson.ok === true
        && runJson.status === "completed"
        && existsSync(runJson.runPath)
        && harnessTurnExecutorCallCount === 7
        && replayJson.ok === true
        && dryRunJson.dryRun === true,
      details: {
        status: runJson.status,
        replayOk: replayJson.ok,
        dryRun: dryRunJson.dryRun,
        callCount: harnessTurnExecutorCallCount,
      },
    };
  } finally {
    server = await stopScenarioServer(mod, server);
    await cleanupRuntimeEnv(root);
  }
}

async function runStopScenario() {
  const root = setupRuntimeEnv("bosun-harness-stop-script-");
  const mod = await import("../../server/ui-server.mjs");
  let notifyStarted = null;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  mod.injectUiDependencies({
    createCompiledInternalHarnessSession: (compiledProfile, options = {}) => ({
      agentId: compiledProfile.agentId || "test-harness",
      compiledProfile,
      compiledProfileJson: JSON.stringify(compiledProfile),
      validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
      isValid: true,
      run: () => new Promise((resolve) => {
        const signal = options.abortController?.signal;
        const finish = () => {
          const timestamp = new Date().toISOString();
          options.onHarnessEvent?.({ type: "harness:session-start", runId: options.runId, taskKey: options.taskKey, entryStageId: "plan", timestamp });
          options.onHarnessEvent?.({ type: "harness:stage-start", runId: options.runId, taskKey: options.taskKey, stageId: "plan", stageType: "prompt", timestamp });
          options.onHarnessEvent?.({ type: "harness:aborted", runId: options.runId, taskKey: options.taskKey, stageId: "plan", reason: "operator_stop", timestamp });
          resolve({
            success: false,
            status: "aborted",
            runId: options.runId,
            currentStageId: "plan",
            completedStageId: null,
            history: [],
            error: "aborted",
          });
        };
        if (signal?.aborted) {
          finish();
          return;
        }
        notifyStarted?.();
        signal?.addEventListener?.("abort", finish, { once: true });
      }),
    }),
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const createdTaskJson = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Harness stop task", description: "Verify stop persists aborted harness runs." }),
    }).then((r) => r.json());
    const taskId = createdTaskJson.data.id;
    const runPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "stop-harness-run",
        taskId,
        source: JSON.stringify({ name: "Bosun Stop Harness", entryStageId: "plan", stages: [{ id: "plan", type: "prompt", prompt: "Wait for stop." }] }),
      }),
    }).then((r) => r.json());
    await started;
    const stopJson = await fetch(`http://127.0.0.1:${port}/api/harness/runs/stop-harness-run/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator_stop" }),
    }).then((r) => r.json());
    const runJson = await runPromise;
    return {
      ok: stopJson.ok === true
        && stopJson.stopped === true
        && runJson.status === "aborted"
        && runJson.runRecord?.events?.some((event) => event.type === "harness:aborted") === true,
      details: {
        stopOk: stopJson.ok,
        stopped: stopJson.stopped,
        status: runJson.status,
      },
    };
  } finally {
    server = await stopScenarioServer(mod, server);
    await cleanupRuntimeEnv(root);
  }
}

async function runNudgeScenario() {
  const root = setupRuntimeEnv("bosun-harness-nudge-script-");
  const mod = await import("../../server/ui-server.mjs");
  let sessionState = null;
  mod.injectUiDependencies({
    createCompiledInternalHarnessSession: (compiledProfile, options = {}) => {
      sessionState = {
        runStarted: false,
        released: false,
        nudges: [],
        resolveRun: null,
      };
      return {
        agentId: compiledProfile.agentId || "test-harness",
        compiledProfile,
        compiledProfileJson: JSON.stringify(compiledProfile),
        validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
        isValid: true,
        canSteer: () => sessionState.runStarted && !sessionState.released,
        steer: (prompt, meta = {}) => {
          sessionState.nudges.push({ prompt, meta });
          const baseEvent = {
            runId: options.runId,
            taskKey: options.taskKey,
            stageId: "plan",
            interventionType: String(meta?.kind || meta?.type || "nudge").trim() || "nudge",
            timestamp: new Date().toISOString(),
            meta: { ...(meta && typeof meta === "object" ? meta : {}) },
          };
          options.onHarnessEvent?.({ ...baseEvent, type: "harness:intervention-requested", prompt });
          options.onHarnessEvent?.({ ...baseEvent, type: "harness:intervention-delivered", prompt, reason: "steered" });
          return {
            ok: true,
            delivered: true,
            reason: "steered",
            interventionType: baseEvent.interventionType,
            stageId: "plan",
            targetTaskKey: options.taskKey,
          };
        },
        run: () => new Promise((resolve) => {
          sessionState.resolveRun = resolve;
          sessionState.runStarted = true;
          options.onHarnessEvent?.({ type: "harness:session-start", runId: options.runId, taskKey: options.taskKey, entryStageId: "plan", timestamp: new Date().toISOString() });
          options.onHarnessEvent?.({ type: "harness:stage-start", runId: options.runId, taskKey: options.taskKey, stageId: "plan", stageType: "prompt", mode: "initial", step: 1, maxSteps: 8, timestamp: new Date().toISOString() });
        }),
        controller: {
          canSteer: () => sessionState.runStarted && !sessionState.released,
        },
      };
    },
  });

  let server = null;
  try {
    server = await mod.startTelegramUiServer({ port: 0, host: "127.0.0.1", skipInstanceLock: true, skipAutoOpen: true });
    const port = server.address().port;
    const runPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "nudge-harness-run",
        source: JSON.stringify({ name: "Bosun Nudge Harness", entryStageId: "plan", stages: [{ id: "plan", type: "prompt", prompt: "Wait for operator intervention." }] }),
      }),
    }).then((r) => r.json());

    await waitFor(() => sessionState?.runStarted === true, { message: "harness session did not start" });
    const nudgeJson = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/nudge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Inspect the failing harness test before continuing.", mode: "steer", actor: "operator", reason: "new_evidence" }),
    }).then((r) => r.json());
    const approvalRequestJson = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actor: "reviewer", reason: "Manual approval required before continuing.", preview: "Wait for reviewer signoff before applying the final patch." }),
    }).then((r) => r.json());
    const approvalJson = await fetch(`http://127.0.0.1:${port}/api/harness/approvals/${encodeURIComponent("harness-run:nudge-harness-run")}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", actor: "reviewer", note: "Ship after the focused test passes." }),
    }).then((r) => r.json());
    sessionState.released = true;
    sessionState.resolveRun?.({
      success: true,
      status: "completed",
      runId: "nudge-harness-run",
      currentStageId: "plan",
      completedStageId: "plan",
      history: [],
    });
    const runJson = await runPromise;
    return {
      ok: nudgeJson.ok === true
        && approvalRequestJson.approvalPending === true
        && approvalJson.ok === true
        && runJson.ok === true
        && sessionState.nudges.length === 2,
      details: {
        nudgeOk: nudgeJson.ok,
        approvalPending: approvalRequestJson.approvalPending,
        approvalOk: approvalJson.ok,
        runOk: runJson.ok,
        nudges: sessionState.nudges.length,
      },
    };
  } finally {
    server = await stopScenarioServer(mod, server);
    await cleanupRuntimeEnv(root);
  }
}

const scenario = String(process.argv[2] || "").trim();

const handlers = {
  "run-history": runHistoryScenario,
  "stop-run": runStopScenario,
  "nudge-approval": runNudgeScenario,
};

if (!Object.prototype.hasOwnProperty.call(handlers, scenario)) {
  console.error(`Unknown scenario: ${scenario}`);
  process.exit(2);
}

try {
  const result = await handlers[scenario]();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
}
