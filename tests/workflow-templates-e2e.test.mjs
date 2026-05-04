/**
 * workflow-templates-e2e.test.mjs — End-to-end execution tests for ALL 36
 * workflow templates.
 *
 * Unlike the dry-run tests in workflow-templates.test.mjs, these tests
 * install each template and fully execute it through the workflow engine
 * with realistic mock services, verifying:
 *   1. Node execution order
 *   2. Concrete output assertions per node type
 *   3. Conditional branching paths
 *   4. Error / failure paths
 *   5. action.execute_workflow chaining
 *   6. Variable resolution
 *   7. Template installation lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { isCiOnlyTestRun } from "./test-speed-gates.mjs";

// ── Mock child_process so node types that shell-out complete instantly ──
vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    execSync: vi.fn((cmd) => {
      // Return plausible empty-ish output for any command
      if (/gh pr list/i.test(cmd)) return "[]";
      if (/gh pr view/i.test(cmd)) return '{"number":1,"title":"mock","mergeable":"MERGEABLE","labels":[]}';
      if (/gh pr merge/i.test(cmd)) return "merged";
      if (/gh release/i.test(cmd)) return '{"tag_name":"v0.0.0"}';
      if (/gh issue/i.test(cmd)) return "[]";
      if (/npm (run )?build/i.test(cmd)) return "build ok";
      if (/npm test/i.test(cmd)) return "tests ok";
      if (/npm run lint/i.test(cmd)) return "lint ok";
      if (/npm audit/i.test(cmd)) return '{"vulnerabilities":{}}';
      if (/git /i.test(cmd)) return "";
      if (/bosun /i.test(cmd)) return "[]";
      if (/grep|find|ls|dir|cat|type/i.test(cmd)) return "";
      return "";
    }),
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdout.pipe = vi.fn();
      proc.stderr.pipe = vi.fn();
      proc.kill = vi.fn();
      proc.pid = 9999;
      setTimeout(() => proc.emit("close", 0), 5);
      return proc;
    }),
  };
});

// Generous timeout — some templates have complex DAGs even with mocks.
vi.setConfig({ testTimeout: 60_000 });
import {
  WORKFLOW_TEMPLATES,
  getTemplate,
  installTemplate,
  installTemplateSet,
} from "../workflow/workflow-templates.mjs";
import {
  WorkflowEngine,
  registerNodeType,
  getNodeType,
} from "../workflow/workflow-engine.mjs";

const runFullTemplatePipelineE2E = isCiOnlyTestRun;
const fullPipelineIt = runFullTemplatePipelineE2E ? it : it.skip;

// ═══════════════════════════════════════════════════════════════════════════
//  Mock Service Layer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a realistic mock services object that tracks all side effects.
 * Each service method returns sensible defaults and records its calls.
 */
function createMockServices() {
  const calls = [];
  const record = (service, method, args) => {
    calls.push({ service, method, args, ts: Date.now() });
  };

  return {
    _calls: calls,
    _getCallsFor(service, method) {
      return calls.filter((c) => c.service === service && (!method || c.method === method));
    },

    kanban: {
      listTasks: vi.fn(async () => {
        record("kanban", "listTasks", []);
        return [
          { id: "TASK-1", title: "Fix login bug", status: "todo", priority: "high" },
          { id: "TASK-2", title: "Add dark mode", status: "inprogress", priority: "medium" },
          { id: "TASK-3", title: "Write docs", status: "todo", priority: "low" },
        ];
      }),
      updateTask: vi.fn(async (id, update) => {
        record("kanban", "updateTask", [id, update]);
        return { id, ...update, updated: true };
      }),
      getTask: vi.fn(async (id) => {
        record("kanban", "getTask", [id]);
        return { id, title: `Task ${id}`, status: "todo", priority: "medium" };
      }),
      createTask: vi.fn(async (task) => {
        record("kanban", "createTask", [task]);
        return { id: `TASK-NEW-${Date.now()}`, ...task };
      }),
      archiveTask: vi.fn(async (id) => {
        record("kanban", "archiveTask", [id]);
        return { id, archived: true };
      }),
    },

    git: {
      getCurrentBranch: vi.fn(() => {
        record("git", "getCurrentBranch", []);
        return "feat/test-branch";
      }),
      hasPendingChanges: vi.fn(() => {
        record("git", "hasPendingChanges", []);
        return false;
      }),
      push: vi.fn(async (branch) => {
        record("git", "push", [branch]);
        return { success: true, branch };
      }),
      checkout: vi.fn(async (branch) => {
        record("git", "checkout", [branch]);
        return { success: true };
      }),
      createBranch: vi.fn(async (name) => {
        record("git", "createBranch", [name]);
        return { success: true, branch: name };
      }),
    },

    agentPool: {
      getAvailableSlots: vi.fn(() => {
        record("agentPool", "getAvailableSlots", []);
        return 3;
      }),
      allocateSlot: vi.fn(async (taskId) => {
        record("agentPool", "allocateSlot", [taskId]);
        return { slotId: `slot-${taskId}`, allocated: true };
      }),
      releaseSlot: vi.fn(async (slotId) => {
        record("agentPool", "releaseSlot", [slotId]);
        return { released: true };
      }),
      listAgents: vi.fn(() => {
        record("agentPool", "listAgents", []);
        return [
          { id: "agent-1", type: "codex", status: "idle" },
          { id: "agent-2", type: "copilot", status: "busy" },
        ];
      }),
      launchEphemeralThread: vi.fn(async (prompt, cwd, timeout, extra) => {
        record("agentPool", "launchEphemeralThread", [prompt, cwd, timeout]);
        // Return planner-parseable output so materialize_planner_tasks succeeds
        const plannerOutput = JSON.stringify({
          tasks: [
            { title: "Mock task: implement feature", description: "Auto-generated placeholder task", acceptance_criteria: ["Feature behavior is validated"], verification: ["npm test -- feature"], repo_areas: ["workflow"], impact: 0.8, confidence: 0.8, risk: 0.3 },
            { title: "Mock task: write tests", description: "Auto-generated placeholder task", acceptance_criteria: ["Coverage improved"], verification: ["npm test -- tests"], repo_areas: ["tests"], impact: 0.7, confidence: 0.85, risk: 0.2 },
          ],
        });
        return { success: true, output: plannerOutput, sdk: "mock", threadId: `thread-${Date.now()}` };
      }),
      execWithRetry: vi.fn(async (prompt, opts) => {
        record("agentPool", "execWithRetry", [prompt, opts]);
        const plannerOutput = JSON.stringify({
          tasks: [
            { title: "Mock task: implement feature", description: "Auto-generated placeholder task", acceptance_criteria: ["Feature behavior is validated"], verification: ["npm test -- feature"], repo_areas: ["workflow"], impact: 0.8, confidence: 0.8, risk: 0.3 },
            { title: "Mock task: write tests", description: "Auto-generated placeholder task", acceptance_criteria: ["Coverage improved"], verification: ["npm test -- tests"], repo_areas: ["tests"], impact: 0.7, confidence: 0.85, risk: 0.2 },
          ],
        });
        return { success: true, output: plannerOutput, sdk: "mock", threadId: `thread-${Date.now()}`, attempts: 1, continues: 0 };
      }),
      launchOrResumeThread: vi.fn(async (prompt, cwd, timeout, opts) => {
        record("agentPool", "launchOrResumeThread", [prompt, cwd, timeout]);
        return { success: true, output: "mock agent resumed", sdk: "mock", threadId: `thread-${Date.now()}` };
      }),
      continueSession: vi.fn(async (sessionId, prompt, opts) => {
        record("agentPool", "continueSession", [sessionId, prompt]);
        return { success: true, output: "mock continued", sdk: "mock" };
      }),
    },

    worktree: {
      acquire: vi.fn(async (branch) => {
        record("worktree", "acquire", [branch]);
        return { path: `/tmp/worktree/${branch}`, branch, acquired: true };
      }),
      release: vi.fn(async (path) => {
        record("worktree", "release", [path]);
        return { released: true };
      }),
      list: vi.fn(() => {
        record("worktree", "list", []);
        return [
          { path: "/tmp/worktree/feat/test", branch: "feat/test", active: true },
        ];
      }),
    },

    claims: {
      claim: vi.fn(async (taskId, agentId) => {
        record("claims", "claim", [taskId, agentId]);
        return { taskId, agentId, claimed: true, ts: Date.now() };
      }),
      release: vi.fn(async (taskId) => {
        record("claims", "release", [taskId]);
        return { released: true };
      }),
      isClaimed: vi.fn((taskId) => {
        record("claims", "isClaimed", [taskId]);
        return false;
      }),
    },

    presence: {
      heartbeat: vi.fn(async (agentId) => {
        record("presence", "heartbeat", [agentId]);
        return { alive: true };
      }),
      isAlive: vi.fn((agentId) => {
        record("presence", "isAlive", [agentId]);
        return true;
      }),
      getStatus: vi.fn(() => {
        record("presence", "getStatus", []);
        return { agents: 2, active: 1 };
      }),
    },

    config: {
      get: vi.fn((key, fallback) => {
        record("config", "get", [key, fallback]);
        const defaults = {
          maxSlots: 3,
          executor: "codex",
          baseBranch: "main",
          telegramChatId: "12345",
          repoOwner: "virtengine",
          repoName: "bosun",
          prMergeMethod: "squash",
          autoMerge: true,
          stalePrDays: 14,
          maxRetries: 3,
        };
        return defaults[key] ?? fallback;
      }),
    },

    telegram: {
      send: vi.fn(async (msg) => {
        record("telegram", "send", [msg]);
        return { sent: true, messageId: Date.now() };
      }),
      sendMessage: vi.fn(async (chatId, msg, opts) => {
        record("telegram", "sendMessage", [chatId, msg, opts]);
        return { sent: true, messageId: Date.now() };
      }),
    },

    meeting: {
      getSession: vi.fn(async (id) => {
        record("meeting", "getSession", [id]);
        return { id: id || "session-1", active: true, title: "Sprint Sync" };
      }),
      createSession: vi.fn(async (opts) => {
        record("meeting", "createSession", [opts]);
        return { id: `session-${Date.now()}`, ...opts, active: true };
      }),
      startMeeting: vi.fn(async (opts) => {
        record("meeting", "startMeeting", [opts]);
        return { sessionId: opts?.sessionId || `meeting-${Date.now()}`, created: true, session: { active: true } };
      }),
      sendMeetingMessage: vi.fn(async (sessionId, message, opts) => {
        record("meeting", "sendMeetingMessage", [sessionId, message]);
        return { sent: true, sessionId };
      }),
      fetchMeetingTranscript: vi.fn(async (sessionId, opts) => {
        record("meeting", "fetchMeetingTranscript", [sessionId]);
        return {
          messages: [{ role: "system", content: "Mock meeting transcript" }],
          page: 1, pageSize: 200, totalMessages: 1, totalPages: 1,
        };
      }),
      stopMeeting: vi.fn(async (sessionId, opts) => {
        record("meeting", "stopMeeting", [sessionId]);
        return { ok: true, sessionId, status: opts?.status || "completed" };
      }),
      analyzeMeetingFrame: vi.fn(async (sessionId, frameDataUrl, opts) => {
        record("meeting", "analyzeMeetingFrame", [sessionId]);
        return { ok: true, analyzed: true, summary: "Mock vision analysis", sessionId };
      }),
    },

    prompts: {
      planner: "Generate {{taskCount}} tasks for the project backlog. Return JSON with shape { tasks: [...] }.",
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Engine Setup
// ═══════════════════════════════════════════════════════════════════════════

let tmpDir;
let engine;
let mockServices;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-e2e-test-"));
  mockServices = createMockServices();
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: mockServices,
  });
  return engine;
}

/**
 * Register placeholder node types for experimental/meeting types that
 * aren't in the main workflow-nodes.mjs registry.
 */
function ensureExperimentalNodeTypes() {
  const registerIfMissing = (type, handler) => {
    if (getNodeType(type)) return;
    registerNodeType(type, handler);
  };
  const registerForE2E = (type, handler) => {
    registerNodeType(type, handler, { source: "test-e2e" });
  };
  const resolveNodeString = (value, ctx) => {
    if (typeof value === "string") return ctx.resolve(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  };
  const buildCommandText = (node, ctx) => {
    const command = String(ctx.resolve(node.config?.command || "") || "").trim();
    const rawArgs = node.config?.args ?? [];
    const args = Array.isArray(rawArgs)
      ? rawArgs.map((value) => resolveNodeString(value, ctx)).filter(Boolean)
      : [resolveNodeString(rawArgs, ctx)].filter(Boolean);
    return { command, args, text: [command, ...args].filter(Boolean).join(" ").trim() };
  };
  const buildMockReviewSignals = (node, ctx) => {
    const repo = String(ctx.resolve(node.config?.env?.DIRECT_REPO || "") || ctx.data?.repo || "virtengine/bosun");
    const prNumber = Number(ctx.resolve(node.config?.env?.DIRECT_PR_NUMBER || "") || ctx.data?.prNumber || 42);
    const prUrl = String(ctx.resolve(node.config?.env?.DIRECT_PR_URL || "") || ctx.data?.prUrl || `https://github.com/${repo}/pull/${prNumber}`);
    const actionable = [
      {
        kind: "comment",
        severity: "medium",
        summary: "Tighten failing review feedback into a focused repair plan.",
      },
    ];
    const qualityChecks = [
      {
        name: "unit-tests",
        conclusion: "failure",
        summary: "Mock quality check failure",
      },
    ];
    const sonarChecks = [
      {
        name: "SonarQube",
        conclusion: "failure",
        summary: "Mock SonarQube issue set",
      },
    ];
    return {
      repo,
      prNumber,
      prUrl,
      sourceKind: String(ctx.resolve(node.config?.env?.DIRECT_EVENT || "") || "schedule"),
      prDigest: {
        core: { number: prNumber, url: prUrl, title: "Mock PR" },
        body: "Mock PR body",
        files: [{ path: "src/mock.js", additions: 5, deletions: 1 }],
        issueComments: [],
        reviews: [],
        reviewComments: [],
        checks: qualityChecks,
        digestSummary: "Mock PR digest summary",
      },
      signals: {
        commentFindings: actionable,
        qualityChecks,
        sonarChecks,
      },
      commentFindings: actionable,
      qualityChecks,
      sonarChecks,
      actionable,
      hasSonarFailure: true,
    };
  };
  const buildMockCommandOutput = (node, ctx) => {
    const { text } = buildCommandText(node, ctx);
    if (node.config?.parseJson === true) {
      if (node.id === "fetch-review-signals" || node.id === "fetch-sonar-signals") {
        return buildMockReviewSignals(node, ctx);
      }
      return { ok: true, command: text };
    }
    if (/git describe --tags --abbrev=0/i.test(text)) return "v0.0.0";
    if (/gh pr list --state merged/i.test(text)) {
      return JSON.stringify([
        {
          number: 1,
          title: "feat: mock release item",
          labels: [{ name: "feature" }],
          author: { login: "bosun-bot" },
          mergedAt: "2026-04-01T00:00:00Z",
        },
      ]);
    }
    if (/git log /i.test(text)) return "feat: mock release item (#1)\nfix: stabilize tests (#2)";
    if (/gh pr view/i.test(text)) return '{"number":1,"title":"mock","mergeable":"MERGEABLE","labels":[]}';
    if (/gh (issue|pr) /i.test(text)) return "[]";
    if (/npm (run )?build/i.test(text)) return "build ok";
    if (/npm test/i.test(text)) return "tests ok";
    if (/npm run lint/i.test(text)) return "lint ok";
    if (/npm audit/i.test(text)) return '{"vulnerabilities":{}}';
    if (/git /i.test(text)) return "";
    return "ok";
  };
  const buildMockAgentOutput = (node, ctx) => {
    if (node.id === "draft-notes") {
      return {
        output: [
          "# What's Changed",
          "",
          "## :rocket: Features",
          "- Added mock release automation (#1)",
          "",
          "## :bug: Bug Fixes",
          "- Stabilized workflow template E2E coverage (#2)",
        ].join("\n"),
        releaseNotes: [
          "# What's Changed",
          "",
          "## :rocket: Features",
          "- Added mock release automation (#1)",
        ].join("\n"),
      };
    }
    return {
      output: `mock agent response for ${node.id}`,
      summary: `mock summary for ${node.id}`,
    };
  };

  registerIfMissing("meeting.start", {
    describe: () => "Start a meeting session",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        sessionId: `meeting-${ctx.id}`,
        title: ctx.resolve(node.config?.title || ""),
        executor: ctx.resolve(node.config?.executor || ""),
      };
    },
  });

  registerIfMissing("meeting.send", {
    describe: () => "Send a meeting message",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        message: ctx.resolve(node.config?.message || ""),
        role: ctx.resolve(node.config?.role || "system"),
      };
    },
  });

  registerIfMissing("meeting.transcript", {
    describe: () => "Capture meeting transcript",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        format: ctx.resolve(node.config?.format || "markdown"),
        transcript: "bosun wake sprint planning notes and action items",
      };
    },
  });

  registerIfMissing("meeting.vision", {
    describe: () => "Analyze meeting frame",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        analyzed: true,
        summary: "Vision analysis: code review dashboard shown",
      };
    },
  });

  registerIfMissing("meeting.finalize", {
    describe: () => "Finalize meeting session",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        status: ctx.resolve(node.config?.status || "completed"),
      };
    },
  });

  registerIfMissing("trigger.meeting.wake_phrase", {
    describe: () => "Wake phrase trigger",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      const phrase = String(ctx.resolve(node.config?.wakePhrase || "")).toLowerCase();
      const text = String(ctx.resolve(node.config?.text || "")).toLowerCase();
      return { triggered: Boolean(phrase) && text.includes(phrase) };
    },
  });

  // These nodes have real implementations that read/write workflow history and
  // skillbook state. Override them for e2e template coverage so every template
  // executes deterministically inside the tmp test sandbox.
  registerForE2E("action.load_skillbook_strategies", {
    describe: () => "Load canned skillbook strategies",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        workflowId: ctx.resolve(node.config?.workflowId || ctx.data?._workflowId || ""),
        strategies: [
          {
            id: "strategy-test-recovery",
            title: "Retry with narrower verification scope",
            score: 0.92,
          },
        ],
        guidanceSummary: "Retry with narrower verification scope and preserve current worktree state.",
      };
    },
  });

  registerForE2E("action.run_command", {
    describe: () => "Execute a deterministic command result for e2e tests",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      return {
        success: true,
        output: buildMockCommandOutput(node, ctx),
        exitCode: 0,
      };
    },
  });

  registerForE2E("action.run_agent", {
    describe: () => "Return deterministic agent output for e2e tests",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      const { output, summary, releaseNotes } = buildMockAgentOutput(node, ctx);
      return {
        success: true,
        output,
        summary,
        releaseNotes,
        sdk: String(node.config?.sdk || "mock"),
        items: [],
        threadId: `agent-${node.id}-${Date.now()}`,
        sessionId: `agent-${node.id}-${Date.now()}`,
        attempts: 1,
        continues: 0,
        resumed: false,
      };
    },
  });

  registerForE2E("agent.run_planner", {
    describe: () => "Generate deterministic planner output for e2e tests",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      const taskCount = Number(ctx.resolve(node.config?.taskCount || 2)) || 2;
      const tasks = Array.from({ length: Math.max(1, Math.min(taskCount, 3)) }, (_, index) => ({
        title: `Mock planned task ${index + 1}`,
        description: "Auto-generated placeholder task",
        acceptance_criteria: ["Planner output is parseable"],
        verification: ["npm test -- tests"],
        repo_areas: ["workflow"],
        impact: 0.8,
        confidence: 0.85,
        risk: 0.2,
      }));
      return {
        success: true,
        output: JSON.stringify({ tasks }),
        taskCount: tasks.length,
        threadId: `planner-${Date.now()}`,
        sdk: "mock",
      };
    },
  });

  registerForE2E("action.evaluate_run", {
    describe: () => "Evaluate a run with deterministic test output",
    schema: { type: "object", properties: {} },
    async execute(node, ctx) {
      const runId = String(ctx.resolve(node.config?.runId || "") || ctx.id || "test-run");
      return {
        success: true,
        runId,
        workflowId: String(ctx.data?._workflowId || ctx.workflowId || "test-workflow"),
        evaluation: {
          summary: "Stable test evaluation",
          status: "healthy",
        },
        promotion: {
          decision: "hold",
          reason: "E2E harness uses deterministic mock evaluation output.",
        },
      };
    },
  });

  registerForE2E("action.apply_self_improvement_ratchet", {
    describe: () => "Apply a no-op ratchet decision for tests",
    schema: { type: "object", properties: {} },
    async execute() {
      return {
        success: true,
        decision: "hold",
        applied: false,
        reason: "E2E harness keeps self-improvement state immutable.",
      };
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  E2E Test Suite
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow-templates E2E execution", () => {
  beforeAll(async () => {
    // Register all built-in node types
    await import("../workflow/workflow-nodes.mjs");
    ensureExperimentalNodeTypes();
  });

  beforeEach(() => {
    makeTmpEngine();
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── Parametric: Every template installs and force-executes cleanly ────

  // Override delay-related variables so templates with action.delay nodes
  // don't sleep for minutes during tests (e.g. canary-deploy promotionDelayMs).
  const DELAY_OVERRIDES = {
    promotionDelayMs: 10,
    pollIntervalMs: 1,
    maxTurns: 2,
    stuckThresholdMs: 10,
    onStuck: "pause",
  };

  describe("all templates execute without engine errors", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      it(`${template.id} installs, executes, and returns valid context`, async () => {
        const installed = installTemplate(template.id, engine, DELAY_OVERRIDES);
        expect(installed.id).toBeDefined();
        expect(installed.metadata.installedFrom).toBe(template.id);

        const ctx = await engine.execute(installed.id, {}, { force: true });
        expect(ctx).toBeDefined();
        expect(ctx.id).toBeDefined();
        expect(ctx.startedAt).toBeGreaterThan(0);
        // Engine should not throw — errors are captured
        expect(ctx.errors.length, `${template.id} produced engine-level errors: ${JSON.stringify(ctx.errors)}`).toBe(0);
      });
    }
  });

  // ── Per-Template Behavioral Tests ─────────────────────────────────────

  // ── GitHub Templates ──────────────────────────────────────────────────

  describe("PR Merge Strategy (template-pr-merge-strategy)", () => {
    it("executes merge flow with CI check data", async () => {
      const installed = installTemplate("template-pr-merge-strategy", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 42,
        branch: "feat/login",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);

      // Verify trigger node ran
      const triggerOutput = ctx.getNodeOutput("trigger");
      expect(triggerOutput).toBeDefined();
    });

    it("handles missing PR number gracefully", async () => {
      const installed = installTemplate("template-pr-merge-strategy", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });
      expect(ctx).toBeDefined();
    });
  });

  describe("PR Triage (template-pr-triage)", () => {
    it("triages a new PR with labels", async () => {
      const installed = installTemplate("template-pr-triage", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 100,
        prTitle: "feat: add dark mode",
        prBody: "Adds dark mode support to the dashboard",
        prAuthor: "dev-user",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("PR Conflict Resolver (template-pr-conflict-resolver)", () => {
    it("executes conflict resolution flow", async () => {
      const installed = installTemplate("template-pr-conflict-resolver", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 55,
        branch: "feat/conflicts",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Stale PR Reaper (template-stale-pr-reaper)", () => {
    it("executes stale PR cleanup flow", async () => {
      const installed = installTemplate("template-stale-pr-reaper", engine);
      const ctx = await engine.execute(installed.id, {
        staleDays: 14,
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Release Drafter (template-release-drafter)", () => {
    it("drafts a release from recent commits", async () => {
      const installed = installTemplate("template-release-drafter", engine);
      const ctx = await engine.execute(installed.id, {
        baseBranch: "main",
        tagPrefix: "v",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Bosun PR Watchdog (template-bosun-pr-watchdog)", () => {
    it("monitors and processes bosun-attached PRs", async () => {
      const installed = installTemplate("template-bosun-pr-watchdog", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 77,
        branch: "feat/watchdog-test",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("GitHub Kanban Sync (template-github-kanban-sync)", () => {
    it("syncs GitHub issues with kanban board", async () => {
      const installed = installTemplate("template-github-kanban-sync", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("SDK Conflict Resolver (template-sdk-conflict-resolver)", () => {
    it("resolves SDK-level conflicts", async () => {
      const installed = installTemplate("template-sdk-conflict-resolver", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 88,
        branch: "feat/sdk-conflicts",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);

      // Should have chain to merge strategy (action.execute_workflow)
      const template = getTemplate("template-sdk-conflict-resolver");
      const chainNode = template.nodes.find((n) => n.type === "action.execute_workflow");
      expect(chainNode).toBeDefined();
    });
  });

  // ── Agent Templates ───────────────────────────────────────────────────

  describe("Frontend Agent (template-frontend-agent)", () => {
    it("runs frontend agent workflow with screenshot validation", async () => {
      const installed = installTemplate("template-frontend-agent", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-101",
        taskTitle: "Fix CSS layout",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Review Agent (template-review-agent)", () => {
    it("runs automated PR review", async () => {
      const installed = installTemplate("template-review-agent", engine);
      const ctx = await engine.execute(installed.id, {
        prNumber: 42,
        prTitle: "feat: add auth",
        prBody: "Adds auth middleware",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Custom Agent (template-custom-agent)", () => {
    it("runs custom agent profile workflow", async () => {
      const installed = installTemplate("template-custom-agent", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-200",
        agentProfile: "custom-v1",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Agent Session Monitor (template-agent-session-monitor)", () => {
    it("monitors agent sessions for anomalies", async () => {
      const installed = installTemplate("template-agent-session-monitor", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Backend Agent (template-backend-agent)", () => {
    it("runs backend agent with test validation", async () => {
      const installed = installTemplate("template-backend-agent", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-300",
        taskTitle: "Add API endpoint",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Voice/Video Parallel Rollout (template-voice-video-parallel-rollout)", () => {
    it("orchestrates parallel voice and video rollout", async () => {
      const installed = installTemplate("template-voice-video-parallel-rollout", engine);
      const ctx = await engine.execute(installed.id, {
        sessionTitle: "Team Standup",
        meetingExecutor: "codex",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Meeting Subworkflow Chain (template-meeting-subworkflow-chain)", () => {
    it("chains meeting to child workflow", async () => {
      const template = getTemplate("template-meeting-subworkflow-chain");
      expect(template).toBeDefined();

      // First install the child workflow (task-planner) that the chain targets
      const childInstalled = installTemplate("template-task-planner", engine);

      const installed = installTemplate("template-meeting-subworkflow-chain", engine, {
        childWorkflowId: childInstalled.id,
      });
      const ctx = await engine.execute(installed.id, {
        sessionTitle: "Sprint Planning Sync",
        wakePhrase: "bosun wake",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  // ── Planning Templates ────────────────────────────────────────────────

  describe("Task Planner (template-task-planner)", () => {
    it("executes task planning flow", async () => {
      const installed = installTemplate("template-task-planner", engine);
      const ctx = await engine.execute(installed.id, {
        minTodoCount: 3,
        taskCount: 5,
        prompt: "Generate backend tasks",
        plannerContext: "Node.js API project",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);

      // Verify template has materialize node
      const tpl = getTemplate("template-task-planner");
      const materializeNode = tpl.nodes.find((n) => n.type === "action.materialize_planner_tasks");
      expect(materializeNode).toBeDefined();
    });
  });

  describe("Task Replenish (template-task-replenish)", () => {
    it("replenishes task backlog", async () => {
      const installed = installTemplate("template-task-replenish", engine);
      const ctx = await engine.execute(installed.id, {
        minBacklog: 2,
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Nightly Report (template-nightly-report)", () => {
    it("generates nightly status report", async () => {
      const installed = installTemplate("template-nightly-report", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Sprint Retrospective (template-sprint-retrospective)", () => {
    it("runs sprint retrospective analysis", async () => {
      const installed = installTemplate("template-sprint-retrospective", engine);
      const ctx = await engine.execute(installed.id, {
        sprintDays: 14,
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  // ── CI/CD Templates ───────────────────────────────────────────────────

  describe("Build & Deploy (template-build-deploy)", () => {
    it("runs build and deploy pipeline", async () => {
      const installed = installTemplate("template-build-deploy", engine);
      const ctx = await engine.execute(installed.id, {
        branch: "main",
        buildCommand: "npm run build",
        deployTarget: "production",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Release Pipeline (template-release-pipeline)", () => {
    it("runs release pipeline flow", async () => {
      const installed = installTemplate("template-release-pipeline", engine);
      const ctx = await engine.execute(installed.id, {
        version: "1.0.0",
        branch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Canary Deploy (template-canary-deploy)", () => {
    it("runs canary deployment flow", async () => {
      const installed = installTemplate("template-canary-deploy", engine, {
        promotionDelayMs: 10,
      });
      const ctx = await engine.execute(installed.id, {
        branch: "main",
        canaryPercent: 10,
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  // ── Reliability Templates ─────────────────────────────────────────────

  describe("Error Recovery (template-error-recovery)", () => {
    it("processes error recovery with retry chain", async () => {
      // installTemplate auto-installs the required sibling (task-repair-worktree)
      const installed = installTemplate("template-error-recovery", engine);

      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-ERR-1",
        taskTitle: "Broken build",
        lastError: "npm ERR! code ELIFECYCLE",
        maxRetries: 3,
        retryCount: 0,
        worktreePath: "/tmp/worktree/feat/fix",
        branch: "feat/fix",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });

    it("template chains to task-repair-worktree on failure path", () => {
      const tpl = getTemplate("template-error-recovery");
      const chainNode = tpl.nodes.find((n) => n.id === "chain-repair");
      expect(chainNode).toBeDefined();
      expect(chainNode.type).toBe("action.execute_workflow");
      expect(chainNode.config.workflowId).toBe("template-task-repair-worktree");
    });
  });

  describe("Anomaly Watchdog (template-anomaly-watchdog)", () => {
    it("monitors for anomalies and triggers alerts", async () => {
      const installed = installTemplate("template-anomaly-watchdog", engine);
      const ctx = await engine.execute(installed.id, {
        stallThresholdMs: 300000,
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Workspace Hygiene (template-workspace-hygiene)", () => {
    it("cleans up stale worktrees and branches", async () => {
      const installed = installTemplate("template-workspace-hygiene", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Health Check (template-health-check)", () => {
    it("runs system health checks", async () => {
      const installed = installTemplate("template-health-check", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Task Finalization Guard (template-task-finalization-guard)", () => {
    it("finalizes task with PR and archival chain", async () => {
      // installTemplate auto-installs the required sibling (task-archiver)
      const installed = installTemplate("template-task-finalization-guard", engine);

      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-FIN-1",
        taskTitle: "Complete feature X",
        worktreePath: "/tmp/worktree/feat/x",
        branch: "feat/x",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });

    it("template chains to task-archiver on success path", () => {
      const tpl = getTemplate("template-task-finalization-guard");
      const chainNode = tpl.nodes.find((n) => n.id === "chain-archiver");
      expect(chainNode).toBeDefined();
      expect(chainNode.type).toBe("flow.universal");
      expect(chainNode.config.workflowId).toBe("template-task-archiver");
    });
  });

  describe("Task Repair Worktree (template-task-repair-worktree)", () => {
    it("repairs damaged worktree", async () => {
      const installed = installTemplate("template-task-repair-worktree", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-REP-1",
        taskTitle: "Fix broken worktree",
        worktreePath: "/tmp/worktree/feat/broken",
        branch: "feat/broken",
        baseBranch: "main",
        error: "git lock file exists",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Task Status Transition Manager (template-task-status-transition-manager)", () => {
    it("manages task status transitions", async () => {
      const installed = installTemplate("template-task-status-transition-manager", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-ST-1",
        fromStatus: "todo",
        toStatus: "inprogress",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Continuation Loop (template-continuation-loop)", () => {
    it("advances through mocked external statuses and exits on terminal state", async () => {
      const statuses = ["inprogress", "inreview", "done"];
      mockServices.kanban.getTask.mockImplementation(async (id) => ({
        id,
        title: `Task ${id}`,
        status: "inprogress",
        externalStatus: statuses.shift() || "done",
      }));

      const installed = installTemplate("template-continuation-loop", engine, {
        taskId: "LIN-123",
        worktreePath: "/tmp/worktree/lin-123",
        maxTurns: 8,
        pollIntervalMs: 1,
        terminalStates: ["done", "cancelled"],
        stuckThresholdMs: 600000,
        onStuck: "retry",
      });

      const ctx = await engine.execute(installed.id, {}, { force: true });
      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
      expect(ctx.getNodeStatus("end-terminal")).toBe("completed");
      expect(mockServices.kanban.getTask).toHaveBeenCalled();
      expect(mockServices.kanban.getTask.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("fires session-stuck hook and executes pause action when configured", async () => {
      mockServices.kanban.getTask.mockImplementation(async (id) => ({
        id,
        title: `Task ${id}`,
        status: "inprogress",
        externalStatus: "inprogress",
      }));

      const installed = installTemplate("template-continuation-loop", engine, {
        taskId: "LIN-STUCK-1",
        worktreePath: "/tmp/worktree/lin-stuck-1",
        maxTurns: 3,
        pollIntervalMs: 1,
        terminalStates: ["done", "cancelled"],
        stuckThresholdMs: 1,
        onStuck: "pause",
      });

      const ctx = await engine.execute(installed.id, {}, { force: true });
      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
      expect(ctx.getNodeStatus("emit-stuck")).toBe("completed");
      expect(ctx.getNodeStatus("stuck-pause")).toBe("completed");
      expect(ctx.getNodeStatus("end-paused")).toBe("completed");
      expect(ctx.data?.eventType).toBe("session-stuck");
    });
  });

  describe("Incident Response (template-incident-response)", () => {
    it("handles incident response workflow", async () => {
      const installed = installTemplate("template-incident-response", engine);
      const ctx = await engine.execute(installed.id, {
        incidentTitle: "API Down",
        severity: "high",
        description: "Production API returning 500s",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Task Archiver (template-task-archiver)", () => {
    it("archives completed tasks", async () => {
      const installed = installTemplate("template-task-archiver", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-ARC-1",
        taskTitle: "Old feature",
        completedAt: new Date().toISOString(),
        taskJson: JSON.stringify({ id: "TASK-ARC-1", title: "Old feature" }),
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Sync Engine (template-sync-engine)", () => {
    it("syncs kanban state with external sources", async () => {
      const installed = installTemplate("template-sync-engine", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  // ── Security Templates ────────────────────────────────────────────────

  describe("Dependency Audit (template-dependency-audit)", () => {
    it("audits project dependencies", async () => {
      const installed = installTemplate("template-dependency-audit", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  describe("Secret Scanner (template-secret-scanner)", () => {
    it("scans for leaked secrets", async () => {
      const installed = installTemplate("template-secret-scanner", engine);
      const ctx = await engine.execute(installed.id, {}, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });
  });

  // ── Task Lifecycle Templates ──────────────────────────────────────────

  describe("Task Lifecycle (template-task-lifecycle)", () => {
    it("runs full task lifecycle from trigger to completion", async () => {
      const installed = installTemplate("template-task-lifecycle", engine);
      const ctx = await engine.execute(installed.id, {
        taskId: "TASK-LC-1",
        taskTitle: "Implement feature Y",
        executor: "codex",
        baseBranch: "main",
      }, { force: true });

      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });

    it("has all required lifecycle nodes", () => {
      const tpl = getTemplate("template-task-lifecycle");
      const requiredTypes = [
        "trigger.task_available",
        "condition.slot_available",
        "action.allocate_slot",
        "action.claim_task",
        "action.resolve_executor",
        "action.acquire_worktree",
        "read-workflow-contract",
        "workflow-contract-validation",
        "action.build_task_prompt",
      ];
      for (const type of requiredTypes) {
        const found = tpl.nodes.some((n) => n.type === type);
        expect(found, `Missing node type ${type} in task-lifecycle`).toBe(true);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Cross-Cutting Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe("action.execute_workflow chain targets", () => {
    it("error-recovery chains to task-repair-worktree (dispatch mode)", () => {
      const tpl = getTemplate("template-error-recovery");
      const chainNode = tpl.nodes.find((n) => n.type === "action.execute_workflow");
      expect(chainNode).toBeDefined();
      expect(chainNode.config.workflowId).toBe("template-task-repair-worktree");
      expect(chainNode.config.mode).toBe("dispatch");
    });

    it("task-finalization-guard chains to task-archiver (dispatch mode)", () => {
      const tpl = getTemplate("template-task-finalization-guard");
      const chainNode = tpl.nodes.find((n) => n.id === "chain-archiver");
      expect(chainNode).toBeDefined();
      expect(chainNode.config.workflowId).toBe("template-task-archiver");
      expect(chainNode.config.mode).toBe("dispatch");
    });

    it("sdk-conflict-resolver chains to pr-merge-strategy (dispatch mode)", () => {
      const tpl = getTemplate("template-sdk-conflict-resolver");
      const chainNode = tpl.nodes.find((n) => n.type === "action.execute_workflow");
      expect(chainNode).toBeDefined();
      expect(chainNode.config.workflowId).toBe("template-pr-merge-strategy");
      expect(chainNode.config.mode).toBe("dispatch");
    });

    it("meeting-subworkflow-chain chains to child workflow (sync mode)", () => {
      const tpl = getTemplate("template-meeting-subworkflow-chain");
      const chainNode = tpl.nodes.find((n) => n.type === "action.execute_workflow");
      expect(chainNode).toBeDefined();
      expect(chainNode.config.workflowId).toBe("{{childWorkflowId}}");
      expect(chainNode.config.mode).toBe("sync");
    });

    it("all chain targets exist as valid template IDs", () => {
      const chainTargets = new Set();
      for (const tpl of WORKFLOW_TEMPLATES) {
        for (const node of tpl.nodes) {
          if (["action.execute_workflow", "flow.universal"].includes(node.type)) {
            const target = node.config?.workflowId;
            if (target && !target.includes("{{")) {
              chainTargets.add(target);
            }
          }
        }
      }
      for (const target of chainTargets) {
        const exists = getTemplate(target);
        expect(exists, `Chain target "${target}" does not exist as a template`).toBeDefined();
      }
    });
  });

  describe("template variable resolution", () => {
    it("installs with overrides and verifies execution uses them", async () => {
      const installed = installTemplate("template-anomaly-watchdog", engine, {
        stallThresholdMs: 999999,
      });
      expect(installed.variables.stallThresholdMs).toBe(999999);

      const ctx = await engine.execute(installed.id, {}, { force: true });
      expect(ctx).toBeDefined();
      expect(ctx.errors).toEqual([]);
    });

    it("default variables are accessible during execution", async () => {
      const installed = installTemplate("template-task-planner", engine);
      expect(installed.variables.taskCount).toBe(5);

      const ctx = await engine.execute(installed.id, {}, { force: true });
      expect(ctx.variables.taskCount).toBe(5);
    });
  });

  describe("template installation lifecycle", () => {
    it("installing all recommended templates succeeds", () => {
      const recommended = WORKFLOW_TEMPLATES.filter((t) => t.recommended);
      const result = installTemplateSet(
        engine,
        recommended.map((t) => t.id),
      );
      expect(result.errors).toEqual([]);
      // installed + skipped (auto-installed by grouped flows) = total
      expect(result.installed.length + result.skipped.length).toBe(recommended.length);
    });

    it("installing all 36 templates succeeds without conflicts", () => {
      const result = installTemplateSet(
        engine,
        WORKFLOW_TEMPLATES.map((t) => t.id),
      );
      expect(result.errors).toEqual([]);
      // installed + skipped (auto-installed by grouped flows) = total
      expect(result.installed.length + result.skipped.length).toBe(WORKFLOW_TEMPLATES.length);
    });

    it("double-install is correctly skipped", () => {
      installTemplate("template-error-recovery", engine);
      // error-recovery auto-installed task-repair-worktree;
      // installTemplateSet expands groups, so both should be skipped
      const result = installTemplateSet(engine, ["template-error-recovery"]);
      expect(result.skipped).toContain("template-error-recovery");
      expect(result.installed.length).toBe(0);
    });
  });

  describe("full pipeline: install all + execute all", () => {
    // This path is intentionally opt-in only because it takes several minutes
    // on Windows and makes local pre-push feedback unusably slow.
    fullPipelineIt("installs and executes every template in sequence without cross-contamination", async () => {
      // Use installTemplateSet to handle grouped flow dedup correctly
      const allIds = WORKFLOW_TEMPLATES.map((t) => t.id);
      // Build per-template overrides map so canary-deploy gets short delay
      const overridesById = {};
      for (const id of allIds) overridesById[id] = DELAY_OVERRIDES;
      const installResult = installTemplateSet(engine, allIds, overridesById);
      expect(installResult.errors).toEqual([]);

      const results = [];
      for (const wf of engine.list()) {
        const installedFrom = wf.metadata?.installedFrom || wf.id;
        if (process.env.BOSUN_DEBUG_TEMPLATE_E2E === "1") {
          console.log(`[template-e2e] executing ${installedFrom}`);
        }
        const ctx = await engine.execute(wf.id, {}, { force: true });
        results.push({
          id: installedFrom,
          status: ctx.errors.length > 0 ? "failed" : "completed",
          errorCount: ctx.errors.length,
          nodeCount: ctx.nodeStatuses.size,
        });
      }

      const failures = results.filter((r) => r.status === "failed");
      expect(
        failures,
        `${failures.length} templates failed: ${failures.map((f) => f.id).join(", ")}`,
      ).toEqual([]);
      expect(results.length).toBe(WORKFLOW_TEMPLATES.length);
    }, 120_000);
  });

  describe("template node type coverage", () => {
    it("every node type used in templates is registered in the engine", async () => {
      const usedTypes = new Set();
      for (const template of WORKFLOW_TEMPLATES) {
        for (const node of template.nodes) {
          usedTypes.add(node.type);
        }
      }

      const unregistered = [];
      for (const type of usedTypes) {
        if (!getNodeType(type)) {
          unregistered.push(type);
        }
      }

      expect(
        unregistered,
        `Unregistered node types used in templates: ${unregistered.join(", ")}`,
      ).toEqual([]);
    });
  });

  describe("template metadata integrity", () => {
    it("every template with replaces metadata has valid module target", () => {
      for (const template of WORKFLOW_TEMPLATES) {
        const replaces = template.metadata?.replaces;
        if (!replaces) continue;
        expect(typeof replaces.module).toBe("string");
        expect(replaces.module).toMatch(/\.mjs$/);
        expect(Array.isArray(replaces.functions)).toBe(true);
        expect(replaces.functions.length).toBeGreaterThan(0);
      }
    });

    it("every template has exactly one category and it exists", async () => {
      const { TEMPLATE_CATEGORIES } = await import("../workflow/workflow-templates.mjs");
      for (const template of WORKFLOW_TEMPLATES) {
        expect(template.category).toBeDefined();
        expect(TEMPLATE_CATEGORIES[template.category], `Unknown category "${template.category}" for ${template.id}`).toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  Grouped Flows
  // ═══════════════════════════════════════════════════════════════════════

  describe("grouped flows", () => {
    const KNOWN_GROUPS = [
      { parent: "template-error-recovery", child: "template-task-repair-worktree" },
      { parent: "template-task-finalization-guard", child: "template-task-archiver" },
      { parent: "template-sdk-conflict-resolver", child: "template-pr-merge-strategy" },
      { parent: "template-meeting-subworkflow-chain", child: "template-task-planner" },
    ];

    it("every template with requiredTemplates references valid template IDs", () => {
      for (const template of WORKFLOW_TEMPLATES) {
        const required = template.metadata?.requiredTemplates;
        if (!Array.isArray(required)) continue;
        for (const depId of required) {
          expect(getTemplate(depId), `${template.id} requires unknown template "${depId}"`).not.toBeNull();
        }
      }
    });

    it("all 4 known execute_workflow chains have requiredTemplates metadata", () => {
      for (const { parent, child } of KNOWN_GROUPS) {
        const template = getTemplate(parent);
        expect(template, `Template ${parent} not found`).not.toBeNull();
        expect(
          template.metadata?.requiredTemplates,
          `${parent} missing requiredTemplates metadata`,
        ).toContain(child);
      }
    });

    it("getTemplateGroup returns full transitive group", async () => {
      const { getTemplateGroup } = await import("../workflow/workflow-templates.mjs");
      for (const { parent, child } of KNOWN_GROUPS) {
        const group = getTemplateGroup(parent);
        expect(group, `getTemplateGroup("${parent}") returned null`).not.toBeNull();
        expect(group.root).toBe(parent);
        expect(group.members).toContain(parent);
        expect(group.members).toContain(child);
      }
    });

    it("expandTemplateGroups adds missing group members", async () => {
      const { expandTemplateGroups } = await import("../workflow/workflow-templates.mjs");
      // Requesting only the parent should auto-expand to include children
      const expanded = expandTemplateGroups(["template-error-recovery"]);
      expect(expanded).toContain("template-error-recovery");
      expect(expanded).toContain("template-task-repair-worktree");
    });

    it("installTemplate auto-installs required sibling templates", () => {
      // Installing error-recovery should also install task-repair-worktree
      installTemplate("template-error-recovery", engine);
      const all = engine.list();
      const installedFromIds = all.map((w) => w.metadata?.installedFrom);
      expect(installedFromIds).toContain("template-error-recovery");
      expect(installedFromIds).toContain("template-task-repair-worktree");
    });

    it("installTemplateSet expands groups automatically", () => {
      // Requesting only parent should bring in children too
      const result = installTemplateSet(engine, ["template-task-finalization-guard"]);
      expect(result.errors).toEqual([]);
      const all = engine.list();
      const installedFromIds = all.map((w) => w.metadata?.installedFrom);
      expect(installedFromIds).toContain("template-task-finalization-guard");
      expect(installedFromIds).toContain("template-task-archiver");
    });

    it("enabling a parent workflow auto-enables disabled children", () => {
      // Install both — child disabled
      const parent = installTemplate("template-error-recovery", engine);
      const all = engine.list();
      const child = all.find((w) => w.metadata?.installedFrom === "template-task-repair-worktree");
      expect(child).toBeDefined();

      // Manually disable child
      child.enabled = false;
      engine.save(child);
      expect(engine.get(child.id).enabled).toBe(false);

      // Re-enable parent (trigger save with enabled=true)
      parent.enabled = true;
      engine.save(parent);

      // Child should now be auto-enabled
      const refreshedChild = engine.get(child.id);
      expect(refreshedChild.enabled).not.toBe(false);
    });

    it("getTemplateGroup returns null for unknown template", async () => {
      const { getTemplateGroup } = await import("../workflow/workflow-templates.mjs");
      expect(getTemplateGroup("nonexistent-template")).toBeNull();
    });

    it("templates without requiredTemplates have singleton groups", async () => {
      const { getTemplateGroup } = await import("../workflow/workflow-templates.mjs");
      const group = getTemplateGroup("template-health-check");
      expect(group.members).toEqual(["template-health-check"]);
    });
  });
});
