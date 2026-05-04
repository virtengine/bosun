import { describe, it, expect } from "vitest";
import { RunEvaluator } from "../workflow/run-evaluator.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRunDetail(overrides = {}) {
  const now = Date.now();
  return {
    detail: {
      id: "run-1",
      startedAt: now - 10_000,
      endedAt: now,
      duration: 10_000,
      nodeStatuses: { n1: "completed", n2: "completed" },
      nodeOutputs: { n1: { ok: true }, n2: { ok: true } },
      retryAttempts: {},
      errors: [],
      nodeTimings: {
        n1: { startedAt: now - 10_000, endedAt: now - 5000 },
        n2: { startedAt: now - 5000, endedAt: now },
      },
      nodeInputs: { n1: { foo: 1 }, n2: { bar: 2 } },
      nodeStatusEvents: [],
      ...overrides,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RunEvaluator", () => {
  const evaluator = new RunEvaluator();

  describe("scoring", () => {
    it("gives a perfect run score near 100", () => {
      const run = makeRunDetail();
      const result = evaluator.evaluate(run);
      expect(result.score).toBeGreaterThanOrEqual(90);
      expect(result.grade).toBe("A");
      expect(result.judgment).toMatchObject({
        decision: "ACCEPT",
      });
      expect(result.issues).toHaveLength(0);
    });

    it("penalises failed nodes (-10 each)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "failed" },
        errors: [
          { nodeId: "n2", error: "boom", timestamp: Date.now() },
          { nodeId: "n3", error: "crash", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(80);
      expect(result.metrics.failedNodes).toBe(2);
      expect(result.issues.some((i) => i.severity === "error" && i.nodeId === "n2")).toBe(true);
    });

    it("penalises retried nodes (-5 each)", () => {
      const run = makeRunDetail({
        retryAttempts: { n1: 2 },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(95);
      expect(result.metrics.retriedNodes).toBe(1);
    });

    it("penalises skipped nodes (-2 each)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "skipped", n3: "skipped" },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(96);
      expect(result.metrics.skippedNodes).toBe(2);
    });

    it("penalises slow total duration (-5)", () => {
      const now = Date.now();
      const run = makeRunDetail({
        startedAt: now - 400_000,
        endedAt: now,
        duration: 400_000,
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(95);
      expect(result.issues.some((i) => i.message.includes("took"))).toBe(true);
    });

    it("penalises a slow node (-10)", () => {
      const now = Date.now();
      const run = makeRunDetail({
        nodeTimings: {
          n1: { startedAt: now - 200_000, endedAt: now },
          n2: { startedAt: now - 1000, endedAt: now },
        },
      });
      const result = evaluator.evaluate(run);
      expect(result.score).toBeLessThanOrEqual(90);
      expect(result.issues.some((i) => i.nodeId === "n1")).toBe(true);
    });

    it("penalises high error rate (-20)", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "failed", n2: "failed" },
        errors: [
          { nodeId: "n1", error: "err1", timestamp: Date.now() },
          { nodeId: "n2", error: "err2", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      // -10*2 failed + -20 high error rate = at most 60
      expect(result.score).toBeLessThanOrEqual(60);
    });

    it("clamps score to 0 minimum", () => {
      const statuses = {};
      const errors = [];
      for (let i = 0; i < 20; i++) {
        statuses[`n${i}`] = "failed";
        errors.push({ nodeId: `n${i}`, error: "err", timestamp: Date.now() });
      }
      const run = makeRunDetail({ nodeStatuses: statuses, errors });
      const result = evaluator.evaluate(run);
      expect(result.score).toBe(0);
      expect(result.grade).toBe("F");
    });
  });

  describe("grade boundaries", () => {
    it("A >= 90", () => {
      const run = makeRunDetail();
      expect(evaluator.evaluate(run).grade).toBe("A");
    });

    it("B for score 75-89", () => {
      // 3 failed nodes = -30, so score 70 → but also high error rate if 3/5
      // Use 1 failed + 2 retried + 1 skipped = -10 -10 -2 = 78
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "completed", n4: "completed", n5: "skipped" },
        retryAttempts: { n1: 1, n3: 1 },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.grade).toMatch(/^[AB]$/);
    });

    it("F for score < 40", () => {
      const statuses = {};
      const errors = [];
      for (let i = 0; i < 8; i++) {
        statuses[`n${i}`] = "failed";
        errors.push({ nodeId: `n${i}`, error: "err", timestamp: Date.now() });
      }
      const run = makeRunDetail({ nodeStatuses: statuses, errors });
      expect(evaluator.evaluate(run).grade).toBe("F");
    });
  });

  describe("remediation suggestions", () => {
    it("suggests from_failed when one node failed", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "timeout exceeded", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBe("from_failed");
      expect(result.judgment).toMatchObject({
        decision: "RETRY",
        retryMode: "from_failed",
      });
    });

    it("suggests from_scratch when multiple nodes failed", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "failed", n2: "failed" },
        errors: [
          { nodeId: "n1", error: "err1", timestamp: Date.now() },
          { nodeId: "n2", error: "err2", timestamp: Date.now() },
        ],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBe("from_scratch");
    });

    it("suggests increase_timeout for timeout errors", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: 'Node "n2" timed out after 10000ms', timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      const action = result.remediation.fixActions.find((a) => a.nodeId === "n2");
      expect(action.type).toBe("increase_timeout");
    });

    it("suggests check_config for not-found errors", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "Resource not found", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      const action = result.remediation.fixActions.find((a) => a.nodeId === "n2");
      expect(action.type).toBe("check_config");
    });

    it("sets canAutoFix true when all issues have known fixes", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "timed out after 10000ms", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.canAutoFix).toBe(true);
    });

    it("sets canAutoFix false when unknown errors exist", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "Unexpected syntax error in line 42", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.remediation.canAutoFix).toBe(false);
    });

    it("returns null suggestedRetryMode when no failures", () => {
      const run = makeRunDetail();
      const result = evaluator.evaluate(run);
      expect(result.remediation.suggestedRetryMode).toBeNull();
    });
  });

  describe("metrics calculation", () => {
    it("computes correct node counts", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed", n3: "skipped" },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.totalNodeCount).toBe(3);
      expect(result.metrics.completedNodes).toBe(1);
      expect(result.metrics.failedNodes).toBe(1);
      expect(result.metrics.skippedNodes).toBe(1);
    });

    it("computes error rate", () => {
      const run = makeRunDetail({
        nodeStatuses: { n1: "completed", n2: "failed" },
        errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.errorRate).toBe(0.5);
    });

    it("identifies slowest node", () => {
      const now = Date.now();
      const run = makeRunDetail({
        nodeTimings: {
          n1: { startedAt: now - 1000, endedAt: now },
          n2: { startedAt: now - 5000, endedAt: now },
        },
      });
      const result = evaluator.evaluate(run);
      expect(result.metrics.slowestNode.nodeId).toBe("n2");
      expect(result.metrics.slowestNode.durationMs).toBeGreaterThanOrEqual(4900);
    });

    it("handles empty run detail", () => {
      const result = evaluator.evaluate(null);
      expect(result.score).toBe(0);
      expect(result.grade).toBe("F");
    });

    it("emits benchmark, strategy, and promotion insights", () => {
      const now = Date.now();
      const run = makeRunDetail({
        duration: 12_000,
        nodeStatuses: { n1: "completed", n2: "failed", n3: "completed" },
        retryAttempts: { n2: 1 },
        errors: [{ nodeId: "n2", error: "Node timed out after 10000ms", timestamp: now }],
        nodeTimings: {
          n1: { startedAt: now - 12_000, endedAt: now - 8_000 },
          n2: { startedAt: now - 8_000, endedAt: now - 2_000 },
          n3: { startedAt: now - 2_000, endedAt: now },
        },
        data: {
          _workflowId: "wf-self-improve",
          _taskWorkflowEvents: [
            { eventType: "workflow.run.start", taskId: "TASK-1", nodeId: null },
            { eventType: "workflow.node.start", taskId: "TASK-1", nodeId: "n2" },
            { eventType: "workflow.node.error", taskId: "TASK-1", nodeId: "n2" },
            { eventType: "workflow.run.error", taskId: "TASK-1", nodeId: null },
          ],
        },
      });
      const result = evaluator.evaluate(run, { workflowId: "wf-self-improve" });
      expect(result.benchmark.traceEventCount).toBe(4);
      expect(result.benchmark.dominantFailureMode).toMatch(/isolated_failure|high_error_rate|retry_thrash/);
      expect(Array.isArray(result.strategies)).toBe(true);
      expect(result.strategies.length).toBeGreaterThan(0);
      expect(result.strategies[0].strategyId).toContain("wf-self-improve");
      expect(result.promotion).toEqual(expect.objectContaining({
        workflowId: "wf-self-improve",
        decision: expect.any(String),
        summary: expect.any(String),
      }));
      expect(result.ratchet).toEqual(expect.objectContaining({
        workflowId: "wf-self-improve",
        decision: expect.any(String),
        summary: expect.any(String),
      }));
      expect(result.insights.strategyIds).toContain(result.strategies[0].strategyId);
      expect(result.insights.traceSample.length).toBeGreaterThan(0);
    });

    it("incorporates governance state into issues, remediation, and promotion decisions", () => {
      const run = makeRunDetail({
        data: {
          _workflowId: "wf-governance",
          goalAncestry: [
            { goalId: "goal-root", title: "Root Goal", depth: 0 },
            { goalId: "goal-child", title: "Implement Governance", depth: 1 },
          ],
          heartbeatRun: {
            runId: "hb-1",
            status: "waiting",
            sourceRunId: "run-parent",
            wakeAt: "2026-03-31T10:00:00.000Z",
          },
          wakeupRequest: {
            requestId: "wake-1",
            source: "scheduler",
            requestedAt: "2026-03-31T09:55:00.000Z",
            wakeAt: "2026-03-31T10:00:00.000Z",
          },
          budgetPolicy: {
            budgetCents: 1000,
            spentCents: 950,
            reservedCents: 100,
            nearLimitThresholdCents: 150,
            currency: "USD",
            approvalRequired: true,
          },
          executionPolicy: {
            mode: "strict",
            approvalRequired: true,
            approvalState: "pending",
            violations: [
              {
                ruleId: "scope-lock",
                message: "Scope lock required before implementation.",
                blocking: true,
                nodeId: "n2",
              },
            ],
          },
        },
      });
      const result = evaluator.evaluate(run, { workflowId: "wf-governance" });
      expect(result.governance).toEqual(expect.objectContaining({
        primaryGoalId: "goal-child",
        goalDepth: 1,
        heartbeatRun: expect.objectContaining({ runId: "hb-1" }),
        wakeupRequest: expect.objectContaining({ requestId: "wake-1" }),
        budgetOutcome: expect.objectContaining({ status: "exceeded" }),
        policyOutcome: expect.objectContaining({ status: "blocked", blockingViolationCount: 1 }),
        blocked: true,
        approvalPending: true,
      }));
      expect(result.metrics.governanceBlocked).toBe(true);
      expect(result.metrics.budgetStatus).toBe("exceeded");
      expect(result.metrics.policyStatus).toBe("blocked");
      expect(result.issues.some((issue) => issue.message.includes("budget exceeded"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("Policy violation"))).toBe(true);
      expect(result.remediation.fixActions.map((action) => action.type)).toEqual(expect.arrayContaining([
        "request_budget_approval",
        "request_execution_approval",
        "resolve_policy_violation",
      ]));
      expect(result.remediation.canAutoRetry).toBe(false);
      expect(result.strategies.some((strategy) => strategy.category === "governance")).toBe(true);
      expect(result.promotion.blockedByGovernance).toBe(true);
      expect(result.promotion.shouldPromote).toBe(false);
      expect(result.insights.governance).toEqual(expect.objectContaining({
        primaryGoalId: "goal-child",
        policyOutcome: expect.objectContaining({ status: "blocked" }),
      }));
      expect(result.judgment).toMatchObject({
        decision: "ESCALATE",
        reason: "governance.approval_pending",
      });
    });

    it("tracks objective progress, constraint violations, and token budgets in evaluation metrics", () => {
      const run = makeRunDetail({
        data: {
          _workflowId: "wf-objectives",
          objectiveFrame: {
            successCriteria: [
              { id: "criterion-1", title: "Collect baseline", status: "satisfied", blocking: true },
              { id: "criterion-2", title: "Ship final recommendation", status: "partial", blocking: true },
            ],
            goalProgress: {
              status: "in_progress",
              completedCriteriaCount: 1,
              totalCriteriaCount: 2,
              completionRatio: 0.5,
            },
            constraintState: {
              status: "warning",
              blocked: false,
              violations: [
                {
                  constraintId: "citation-coverage",
                  message: "Missing one supporting citation.",
                  blocking: false,
                },
              ],
            },
            tokenBudget: {
              budgetTokens: 2000,
              totalTokens: 1900,
              remainingTokens: 100,
              status: "near_limit",
              approvalRequired: true,
            },
          },
        },
      });

      const result = evaluator.evaluate(run, { workflowId: "wf-objectives" });

      expect(result.governance).toEqual(expect.objectContaining({
        objectiveFrame: expect.objectContaining({
          blocked: false,
        }),
        successCriteria: expect.arrayContaining([
          expect.objectContaining({ title: "Collect baseline", status: "satisfied" }),
          expect.objectContaining({ title: "Ship final recommendation", status: "partial" }),
        ]),
        goalProgress: expect.objectContaining({
          status: "in_progress",
          completionRatio: 0.5,
        }),
        constraintState: expect.objectContaining({
          status: "warning",
          violationCount: 1,
          blockingViolationCount: 0,
        }),
        tokenBudget: expect.objectContaining({
          status: "near_limit",
          totalTokens: 1900,
          approvalRequired: true,
        }),
      }));
      expect(result.metrics.successCriteriaCount).toBe(2);
      expect(result.metrics.completedCriteriaCount).toBe(1);
      expect(result.metrics.goalProgressStatus).toBe("in_progress");
      expect(result.metrics.goalCompletionRatio).toBe(0.5);
      expect(result.metrics.constraintStatus).toBe("warning");
      expect(result.metrics.constraintViolationCount).toBe(1);
      expect(result.metrics.blockingConstraintViolationCount).toBe(0);
      expect(result.metrics.tokenBudgetStatus).toBe("near_limit");
      expect(result.metrics.totalTokens).toBe(1900);
      expect(result.issues.some((issue) => issue.message.includes("Blocking success criterion incomplete: Ship final recommendation"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("Constraint violation (citation-coverage)"))).toBe(true);
      expect(result.issues.some((issue) => issue.message.includes("Token budget is near limit"))).toBe(true);
      expect(result.remediation.fixActions.map((action) => action.type)).toEqual(expect.arrayContaining([
        "complete_success_criterion",
        "review_goal_progress",
        "review_token_budget",
      ]));
      expect(result.judgment.decision).toBe("ESCALATE");
    });
  });
});

// ── Configurable thresholds ─────────────────────────────────────────────────

describe("RunEvaluator configurable thresholds", () => {
  it("uses default config when no opts", () => {
    const ev = new RunEvaluator();
    const run = makeRunDetail();
    const result = ev.evaluate(run);
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("accepts custom penalty values", () => {
    // Use an absurdly high penalty for failed nodes
    const ev = new RunEvaluator({ penaltyFailedNode: 50 });
    const run = makeRunDetail({
      nodeStatuses: { n1: "completed", n2: "failed" },
      errors: [{ nodeId: "n2", error: "err", timestamp: Date.now() }],
    });
    const result = ev.evaluate(run);
    // With 50 penalty per failed node, score should be much lower than default
    expect(result.score).toBeLessThanOrEqual(50);
  });
});

// ── History & Trends ────────────────────────────────────────────────────────

describe("RunEvaluator history & trends", () => {
  let tmpDir;

  function makeTmpDir() {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-eval-test-"));
    return tmpDir;
  }

  afterEach(() => {
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("getHistory returns empty array for unknown workflow", () => {
    const ev = new RunEvaluator({ configDir: makeTmpDir() });
    expect(ev.getHistory("unknown")).toEqual([]);
  });

  it("getTrend returns null for unknown workflow", () => {
    const ev = new RunEvaluator({ configDir: makeTmpDir() });
    expect(ev.getTrend("unknown")).toBeNull();
  });

  it("persists history across instances", () => {
    const dir = makeTmpDir();

    // Create evaluator, attach to mock engine, record some evaluations
    const ev1 = new RunEvaluator({ configDir: dir });
    // Manually invoke evaluate and check that history is populated
    const run = makeRunDetail();
    // We need to use attachToEngine or manually record. Let's use a mock.
    const mockEngine = {
      handlers: {},
      on(event, handler) { this.handlers[event] = handler; },
      getRunDetail(runId) { return makeRunDetail(); },
    };
    ev1.attachToEngine(mockEngine);
    // Simulate run:complete
    mockEngine.handlers["run:complete"]({ runId: "run-1", workflowId: "wf-1" });
    mockEngine.handlers["run:complete"]({ runId: "run-2", workflowId: "wf-1" });

    const history = ev1.getHistory("wf-1");
    expect(history).toHaveLength(2);
    expect(history[0].runId).toBe("run-1");
    expect(history[1].runId).toBe("run-2");

    // Reload from disk
    const ev2 = new RunEvaluator({ configDir: dir });
    const reloaded = ev2.getHistory("wf-1");
    expect(reloaded).toHaveLength(2);
  });

  it("upserts durable history when evaluate records the same run more than once", () => {
    const dir = makeTmpDir();
    const ev = new RunEvaluator({ configDir: dir });
    const run = {
      runId: "run-upsert-1",
      ...makeRunDetail(),
    };

    ev.evaluate(run, { workflowId: "wf-upsert", recordHistory: true });
    ev.evaluate(run, { workflowId: "wf-upsert", recordHistory: true });

    const history = ev.getHistory("wf-upsert");
    expect(history).toHaveLength(1);
    expect(history[0].runId).toBe("run-upsert-1");

    const historyPath = join(dir, ".bosun", "evaluation-history.json");
    expect(existsSync(historyPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(historyPath, "utf8"));
    expect(persisted["wf-upsert"]).toHaveLength(1);
    expect(persisted["wf-upsert"][0].runId).toBe("run-upsert-1");
  });

  it("getTrend computes average and stable trend", () => {
    const dir = makeTmpDir();
    const ev = new RunEvaluator({ configDir: dir });
    const mockEngine = {
      handlers: {},
      on(event, handler) { this.handlers[event] = handler; },
      getRunDetail() { return makeRunDetail(); }, // perfect runs
    };
    ev.attachToEngine(mockEngine);

    // Fire 6 perfect runs
    for (let i = 0; i < 6; i++) {
      mockEngine.handlers["run:complete"]({ runId: `run-${i}`, workflowId: "wf-1" });
    }

    const trend = ev.getTrend("wf-1");
    expect(trend).toBeTruthy();
    expect(trend.evaluationCount).toBe(6);
    expect(trend.avgScore).toBeGreaterThanOrEqual(90);
    expect(trend.trend).toBe("stable");
    expect(trend.recentGrades).toHaveLength(5);
    expect(trend.recentEntries).toHaveLength(5);
  });

  it("persists ratchet baselines and can revert to the previous baseline after regression", () => {
    const dir = makeTmpDir();
    const ev = new RunEvaluator({ configDir: dir });

    const baselineRun = {
      runId: "run-baseline-1",
      ...makeRunDetail({
        retryAttempts: { n1: 1 },
      }),
    };
    const baselineEval = ev.evaluate(baselineRun, { workflowId: "wf-ratchet" });
    expect(baselineEval.ratchet.decision).toBe("capture_baseline");
    ev.recordRatchetDecision("wf-ratchet", {
      ...baselineEval.ratchet,
      runId: baselineRun.runId,
      candidate: baselineEval.ratchet.candidate,
      targetStrategy: baselineEval.ratchet.targetStrategy,
    });

    const improvedRun = {
      runId: "run-improved-2",
      ...makeRunDetail(),
    };
    const improvedEval = ev.evaluate(improvedRun, { workflowId: "wf-ratchet" });
    expect(improvedEval.ratchet.decision).toBe("apply_candidate");
    ev.recordRatchetDecision("wf-ratchet", {
      ...improvedEval.ratchet,
      runId: improvedRun.runId,
      candidate: improvedEval.ratchet.candidate,
      targetStrategy: improvedEval.ratchet.targetStrategy,
    });

    const regressedRun = {
      runId: "run-regressed-3",
      ...makeRunDetail({
        nodeStatuses: { n1: "failed", n2: "completed" },
        retryAttempts: { n1: 1 },
        errors: [{ nodeId: "n1", error: "Node timed out after 10000ms", timestamp: Date.now() }],
      }),
    };
    const regressedEval = ev.evaluate(regressedRun, { workflowId: "wf-ratchet" });
    expect(regressedEval.ratchet.decision).toBe("revert_to_baseline");
    const persisted = ev.recordRatchetDecision("wf-ratchet", {
      ...regressedEval.ratchet,
      runId: regressedRun.runId,
      candidate: regressedEval.ratchet.candidate,
      targetStrategy: regressedEval.ratchet.targetStrategy,
    });

    expect(persisted.stateAfter.activeBaseline.runId).toBe("run-baseline-1");
    expect(persisted.stateAfter.previousBaseline.runId).toBe("run-improved-2");

    const historyPath = join(dir, ".bosun", "evaluation-history.json");
    const saved = JSON.parse(readFileSync(historyPath, "utf8"));
    expect(saved.__ratchet["wf-ratchet"].decisions).toHaveLength(3);

    const reloaded = new RunEvaluator({ configDir: dir });
    const reloadedState = reloaded.getRatchetState("wf-ratchet");
    expect(reloadedState.activeBaseline.runId).toBe("run-baseline-1");
    expect(reloadedState.previousBaseline.runId).toBe("run-improved-2");
  });

  it("attachToEngine is safe with invalid engine", () => {
    const ev = new RunEvaluator();
    // Should not throw
    ev.attachToEngine(null);
    ev.attachToEngine({});
    ev.attachToEngine({ on: "not-a-function" });
  });
});
