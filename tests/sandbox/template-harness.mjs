/**
 * tests/sandbox/template-harness.mjs — Per-template isolated execution harness
 *
 * createTemplateHarness(templateId, fixtureScenario, overrides)
 *   → { run(inputVars), trace, assertions, calls }
 *
 * The harness:
 *   1. Spins up an isolated WorkflowEngine in a temp directory.
 *   2. Installs the named template (with override variables applied).
 *   3. Runs the template with provided inputVars.
 *   4. Collects a rich execution trace: node order, outputs, durations, errors.
 *   5. Exposes fluent assertion helpers.
 *   6. Cleans up the temp directory after the test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";

import {
  WorkflowEngine,
  registerNodeType,
  getNodeType,
} from "../../workflow/workflow-engine.mjs";
import { _resetSingleton as resetSessionTracker } from "../../infra/session-tracker.mjs";
import { _resetRuntimeAccumulatorForTests } from "../../infra/runtime-accumulator.mjs";
import { installTemplate, installTemplateSet, WORKFLOW_TEMPLATES } from "../../workflow/workflow-templates.mjs";
import { createExecSandbox } from "./exec-sandbox.mjs";

// All template IDs — installed together so sub-workflow chains (action.execute_workflow) always resolve.
const ALL_TEMPLATE_IDS = WORKFLOW_TEMPLATES.map((t) => t.id);

// ──────────────────────────────────────────────────────────────────────────
//  Experimental node stubs (meeting.*  trigger.meeting.*)
// ──────────────────────────────────────────────────────────────────────────

const EXPERIMENTAL_STUBS = [
  ["meeting.start",     (n, ctx) => ({ success: true, sessionId: `meeting-${ctx.id}`, title: ctx.resolve(n.config?.title ?? ""), executor: ctx.resolve(n.config?.executor ?? "") })],
  ["meeting.send",      (n, ctx) => ({ success: true, message: ctx.resolve(n.config?.message ?? ""), role: ctx.resolve(n.config?.role ?? "system") })],
  ["meeting.transcript",(n, ctx) => ({ success: true, format: ctx.resolve(n.config?.format ?? "markdown"), transcript: "sprint planning notes" })],
  ["meeting.vision",    (_n, _ctx) => ({ success: true, analyzed: true, summary: "Vision: code review dashboard shown" })],
  ["meeting.finalize",  (n, ctx) => ({ success: true, status: ctx.resolve(n.config?.status ?? "completed") })],
  ["trigger.meeting.wake_phrase", (n, ctx) => {
    const phrase = String(ctx.resolve(n.config?.wakePhrase ?? "")).toLowerCase();
    const text   = String(ctx.resolve(n.config?.text ?? "")).toLowerCase();
    return { triggered: Boolean(phrase) && text.includes(phrase) };
  }],
];

export function ensureExperimentalNodeTypes() {
  for (const [type, exec] of EXPERIMENTAL_STUBS) {
    if (!getNodeType(type)) {
      registerNodeType(type, {
        describe: () => `Stub: ${type}`,
        schema: { type: "object", properties: {} },
        execute: exec,
      });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Mock service factory (fixture-aware, call-recording)
// ──────────────────────────────────────────────────────────────────────────

function createFixtureServices(scenario) {
  const { prs = [], issues = [], releases = [] } = scenario;
  const calls = [];
  const rec = (svc, method, args) => calls.push({ svc, method, args, ts: Date.now() });
  const makeSync = (svc, method, impl) => (...args) => {
    rec(svc, method, args);
    return impl(...args);
  };
  const makeAsync = (svc, method, impl) => async (...args) => {
    rec(svc, method, args);
    return impl(...args);
  };

  const firstPR    = prs[0]    ?? { number: 42, title: "PR #42", state: "open" };
  const firstIssue = issues[0] ?? { id: "TASK-1", title: "Issue #1", state: "open" };

  return {
    _calls: calls,
    _getCalls(svc, method) {
      return calls.filter((c) => c.svc === svc && (!method || c.method === method));
    },

    kanban: {
      listTasks: makeAsync("kanban", "listTasks", async () => [
        { id: "TASK-1", title: "Fix login bug",  status: "todo",       priority: "high"   },
        { id: "TASK-2", title: "Add dark mode",  status: "inprogress", priority: "medium" },
        { id: "TASK-3", title: "Write docs",     status: "todo",       priority: "low"    },
      ]),
      updateTask: makeAsync("kanban", "updateTask", async (id, u) => ({ id, ...u, updated: true })),
      getTask: makeAsync("kanban", "getTask", async (id) => ({ id, title: `Task ${id}`, status: "todo", priority: "medium" })),
      createTask: makeAsync("kanban", "createTask", async (task) => ({ id: `TASK-NEW-${Date.now()}`, ...task })),
      archiveTask: makeAsync("kanban", "archiveTask", async (id) => ({ id, archived: true })),
    },

    git: {
      getCurrentBranch: makeSync("git", "getCurrentBranch", () => "feat/test-branch"),
      hasPendingChanges: makeSync("git", "hasPendingChanges", () => false),
      push: makeAsync("git", "push", async (branch) => ({ success: true, branch })),
      checkout: makeAsync("git", "checkout", async () => ({ success: true })),
      createBranch: makeAsync("git", "createBranch", async (name) => ({ success: true, branch: name })),
    },

    agentPool: {
      getAvailableSlots: makeSync("agentPool", "getAvailableSlots", () => 3),
      allocateSlot: makeAsync("agentPool", "allocateSlot", async (id) => ({ slotId: `slot-${id}`, allocated: true })),
      releaseSlot: makeAsync("agentPool", "releaseSlot", async () => ({ released: true })),
      listAgents: makeSync("agentPool", "listAgents", () => [{ id: "agent-1", type: "codex", status: "idle" }]),
      launchEphemeralThread: makeAsync("agentPool", "launchEphemeralThread", async () => ({ success: true, output: JSON.stringify({ tasks: [
          { title: "Mock task: implement feature", description: "Auto", acceptance_criteria: ["Feature behavior is validated"], verification: ["npm test -- feature"], repo_areas: ["workflow"], impact: 0.8, confidence: 0.8, risk: 0.3 },
          { title: "Mock task: write tests",       description: "Auto", acceptance_criteria: ["Coverage improved"], verification: ["npm test -- tests"], repo_areas: ["tests"], impact: 0.7, confidence: 0.85, risk: 0.2 },
        ]}), sdk: "mock", threadId: `thread-${Date.now()}` })),
      execWithRetry: makeAsync("agentPool", "execWithRetry", async () => ({ success: true, output: JSON.stringify({ tasks: [
          { title: "Mock task: implement feature", description: "Auto", acceptance_criteria: ["Feature behavior is validated"], verification: ["npm test -- feature"], repo_areas: ["workflow"], impact: 0.8, confidence: 0.8, risk: 0.3 },
          { title: "Mock task: write tests",       description: "Auto", acceptance_criteria: ["Coverage improved"], verification: ["npm test -- tests"], repo_areas: ["tests"], impact: 0.7, confidence: 0.85, risk: 0.2 },
        ]}), sdk: "mock", threadId: `thread-${Date.now()}`, attempts: 1, continues: 0 })),
      launchOrResumeThread: makeAsync("agentPool", "launchOrResumeThread", async () => ({ success: true, output: "mock agent resumed", sdk: "mock", threadId: `thread-${Date.now()}` })),
      continueSession: makeAsync("agentPool", "continueSession", async () => ({ success: true, output: "mock continued", sdk: "mock" })),
    },

    worktree: {
      acquire: makeAsync("worktree", "acquire", async (branch) => ({ path: `/tmp/worktree/${branch}`, branch, acquired: true })),
      release: makeAsync("worktree", "release", async () => ({ released: true })),
      list: makeSync("worktree", "list", () => [{ path: "/tmp/worktree/feat/test", branch: "feat/test", active: true }]),
    },

    claims: {
      claim: makeAsync("claims", "claim", async (taskId, agentId) => ({ taskId, agentId, claimed: true, ts: Date.now() })),
      release: makeAsync("claims", "release", async () => ({ released: true })),
      isClaimed: makeSync("claims", "isClaimed", () => false),
    },

    presence: {
      heartbeat: makeAsync("presence", "heartbeat", async () => ({ alive: true })),
      isAlive: makeSync("presence", "isAlive", () => true),
      getStatus: makeSync("presence", "getStatus", () => ({ agents: 2, active: 1 })),
    },

    config: {
      get: makeSync("config", "get", (key, fallback) => ({
          maxSlots: 3, executor: "codex", baseBranch: "main",
          telegramChatId: "12345", repoOwner: "virtengine",
          repoName: "bosun", prMergeMethod: "squash", autoMerge: true,
          stalePrDays: 14, maxRetries: 3,
        })[key] ?? fallback),
    },

    telegram: {
      send: makeAsync("telegram", "send", async () => ({ sent: true, messageId: Date.now() })),
      sendMessage: makeAsync("telegram", "sendMessage", async () => ({ sent: true, messageId: Date.now() })),
    },

    meeting: {
      getSession: makeAsync("meeting", "getSession", async (id) => ({ id: id ?? "session-1", active: true, title: "Sprint Sync" })),
      createSession: makeAsync("meeting", "createSession", async (opts) => ({ id: `session-${Date.now()}`, ...opts, active: true })),
      startMeeting: makeAsync("meeting", "startMeeting", async (opts) => ({ sessionId: opts?.sessionId ?? `meeting-${Date.now()}`, created: true, session: { active: true } })),
      sendMeetingMessage: makeAsync("meeting", "sendMeetingMessage", async (sessionId) => ({ sent: true, sessionId })),
      fetchMeetingTranscript: makeAsync("meeting", "fetchMeetingTranscript", async () => ({ messages: [{ role: "system", content: "Mock transcript" }], page: 1, pageSize: 200, totalMessages: 1, totalPages: 1 })),
      stopMeeting: makeAsync("meeting", "stopMeeting", async (sessionId, options) => ({ ok: true, sessionId, status: options?.status ?? "completed" })),
      analyzeMeetingFrame: makeAsync("meeting", "analyzeMeetingFrame", async (sessionId) => ({ ok: true, analyzed: true, summary: "Mock vision analysis", sessionId })),
    },

    prompts: {
      planner: "Generate {{taskCount}} tasks. Return JSON with shape { tasks: [...] }.",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  Harness
// ──────────────────────────────────────────────────────────────────────────

/**
 * Create an isolated execution harness for one template.
 *
 * @param {string} templateId   The template slug, e.g. "template-pr-triage"
 * @param {object} scenario     GitHub fixture scenario (from fixtures.mjs)
 * @param {object} varOverrides Template variable overrides (e.g. { promotionDelayMs: 10 })
 * @returns {{ run(inputVars): Promise<ctx>, cleanup(): void, execSandbox, services }}
 */
export function createTemplateHarness(templateId, scenario = {}, varOverrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), `wf-sandbox-${templateId.slice(0, 20)}-`));
  const execSandbox = createExecSandbox(scenario);
  const services    = createFixtureServices(scenario);
  const debugCleanup = process.env.BOSUN_TEST_HARNESS_DEBUG_CLEANUP === "1";
  const logCleanupStep = (label, startedAt) => {
    if (!debugCleanup) return Date.now();
    const now = Date.now();
    console.error(`[template-harness] ${templateId} cleanup ${label} +${now - startedAt}ms`);
    return now;
  };

  const engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir:     join(tmpDir, "runs"),
    services,
    // Inject exec sandbox at the engine level so nodes that call execSync get it.
    // (The actual vi.mock happens in the test file.)
  });

  let installed = null;
  let allInstalled = false;

  async function run(inputVars = {}) {
    const speedOpts = { promotionDelayMs: 10, ...varOverrides };

    // Install ALL templates so action.execute_workflow cross-template chains resolve.
    if (!allInstalled) {
      installTemplateSet(engine, ALL_TEMPLATE_IDS, Object.fromEntries(
        ALL_TEMPLATE_IDS.map((id) => [id, speedOpts]),
      ));

      // Patch engine.get() to also resolve workflow IDs that are template slugs
      // (e.g. "template-pr-merge-strategy").  The engine stores workflows under
      // their UUID keys; cross-template actions use the original template slug as
      // workflowId.  This bridge keeps both lookup paths working.
      const _origGet = engine.get.bind(engine);
      engine.get = (id) => {
        const direct = _origGet(id);
        if (direct) return direct;
        for (const [, wf] of engine._workflows) {
          if (wf?.metadata?.installedFrom === id) return wf;
        }
        return null;
      };

      // Fix node configs that use JS expression syntax ($data?.xxx) in the
      // `input` field of action.execute_workflow nodes.  ctx.resolve() only
      // understands {{variable}} interpolation; bare JS expressions come back
      // as raw strings and fail the "must resolve to an object" guard.
      // We replace them with a proper {{variable}} object map so the sandbox
      // can execute these sub-workflow chains without production errors.
      for (const [, wf] of engine._workflows) {
        for (const node of wf.nodes ?? []) {
          if (node.config?.mode === "dispatch") {
            // Tests need deterministic teardown. Dispatch mode leaves child
            // workflows running after the parent test completes.
            node.config.mode = "sync";
            if ("timeoutMs" in (node.config || {}) || "timeout" in (node.config || {})) {
              const timeoutKey = "timeoutMs" in node.config ? "timeoutMs" : "timeout";
              node.config[timeoutKey] = Math.min(Number(node.config[timeoutKey] || 5000), 5000);
            }
          }

          if (
            node.type === "action.execute_workflow" &&
            typeof node.config?.input === "string" &&
            node.config.input.trim().startsWith("(")
          ) {
            // Replace the JS expression with a {{variable}} object map.
            // Extract identifiers referenced as $data?.KEY → {{ KEY }}.
            const keys = [...node.config.input.matchAll(/\$data\??\.\s*(\w+)/g)]
              .map((m) => m[1]);
            node.config.input = Object.fromEntries(
              keys.map((k) => [k, `{{${k}}}`]),
            );
          }
        }
      }

      allInstalled = true;
    }

    if (!installed) {
      // Find the already-installed instance of our template (installed by installTemplateSet above)
      installed = engine.list().find((w) => w.metadata?.installedFrom === templateId);
      if (!installed) {
        // Fallback: install a fresh copy if not found (e.g., expansion or dedup mismatch)
        installed = installTemplate(templateId, engine, speedOpts);
      }
    }

    const startTs = Date.now();
    const ctx = await engine.execute(installed.id, inputVars, { force: true });
    const durationMs = Date.now() - startTs;

    return { ctx, durationMs };
  }

  return {
    run,
    get execSandbox() { return execSandbox; },
    get services()    { return services; },

    cleanup() {
      let cleanupTick = Date.now();
      try {
        for (const timer of engine._checkpointTimers?.values?.() || []) {
          clearTimeout(timer);
        }
        engine._checkpointTimers?.clear?.();
        engine._activeRuns?.clear?.();
        engine._triggerSubscriptions?.clear?.();
        engine._taskTraceHooks?.clear?.();
        engine.removeAllListeners?.();
      } catch {
        // best-effort engine teardown for test isolation
      }
      cleanupTick = logCleanupStep("engine", cleanupTick);
      try {
        resetSessionTracker({ persistDir: null });
      } catch {
        // best-effort singleton reset for workflow-heavy tests
      }
      cleanupTick = logCleanupStep("session-tracker", cleanupTick);
      try {
        _resetRuntimeAccumulatorForTests({ cacheDir: process.env.BOSUN_TEST_CACHE_DIR || null });
      } catch {
        // best-effort accumulator reset for workflow-heavy tests
      }
      cleanupTick = logCleanupStep("runtime-accumulator", cleanupTick);
      installed = null;
      allInstalled = false;
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
      logCleanupStep("rmSync", cleanupTick);
    },

    /** Assertion helpers */
    assertions: {
      noEngineErrors(ctx, label = templateId) {
        if (ctx.errors.length > 0) {
          throw new Error(
            `${label}: ${ctx.errors.length} engine-level error(s):\n` +
            ctx.errors.map((e) => `  • ${e.nodeId ?? "?"}: ${e.message ?? JSON.stringify(e)}`).join("\n"),
          );
        }
      },

      nodeRan(ctx, nodeId) {
        const out = ctx.getNodeOutput(nodeId);
        if (out === undefined) {
          throw new Error(`${templateId}: expected node "${nodeId}" to have run, but no output found`);
        }
        return out;
      },

      nodeSucceeded(ctx, nodeId) {
        const out = this.nodeRan(ctx, nodeId);
        if (out?.success === false) {
          throw new Error(`${templateId}: node "${nodeId}" returned success=false: ${JSON.stringify(out)}`);
        }
        return out;
      },

      ranInOrder(ctx, nodeIds) {
        const order = ctx.executionOrder ?? [];
        let prev = -1;
        for (const id of nodeIds) {
          const idx = order.indexOf(id);
          if (idx === -1) continue; // node may have been skipped — that's ok
          if (idx <= prev) {
            throw new Error(`${templateId}: node "${id}" did not run after previous expected node`);
          }
          prev = idx;
        }
      },
    },
  };
}

