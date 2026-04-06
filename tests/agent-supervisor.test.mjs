import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  AgentSupervisor,
  createAgentSupervisor,
  SITUATION,
  INTERVENTION,
} from "../agent/agent-supervisor.mjs";

describe("agent-supervisor", () => {
  /** @type {AgentSupervisor} */
  let supervisor;
  let mockSendTelegram;
  let mockSetTaskStatus;
  let mockGetTask;
  let mockSendContinue;
  let mockInjectPrompt;
  let mockForceNewThread;
  let mockRedispatch;
  let mockPauseExecutor;
  let mockDispatchFix;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSendTelegram = vi.fn();
    mockSetTaskStatus = vi.fn();
    mockGetTask = vi.fn().mockReturnValue({ title: "Test task", branchName: "ve/test" });
    mockSendContinue = vi.fn();
    mockInjectPrompt = vi.fn();
    mockForceNewThread = vi.fn();
    mockRedispatch = vi.fn();
    mockPauseExecutor = vi.fn();
    mockDispatchFix = vi.fn();

    supervisor = createAgentSupervisor({
      sendTelegram: mockSendTelegram,
      setTaskStatus: mockSetTaskStatus,
      getTask: mockGetTask,
      sendContinueSignal: mockSendContinue,
      injectPrompt: mockInjectPrompt,
      forceNewThread: mockForceNewThread,
      redispatchTask: mockRedispatch,
      pauseExecutor: mockPauseExecutor,
      dispatchFixTask: mockDispatchFix,
      assessIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    supervisor.stop();
    vi.useRealTimers();
  });

  // ── Factory ─────────────────────────────────────────────────────────

  describe("createAgentSupervisor", () => {
    it("returns an AgentSupervisor instance", () => {
      expect(supervisor).toBeInstanceOf(AgentSupervisor);
    });

    it("exposes SITUATION and INTERVENTION enums", () => {
      expect(SITUATION.HEALTHY).toBe("healthy");
      expect(SITUATION.PLAN_STUCK).toBe("plan_stuck");
      expect(SITUATION.DOOM_LOOP).toBe("doom_loop");
      expect(SITUATION.IDLE_SOFT).toBe("idle_soft");
      expect(SITUATION.IDLE_HARD).toBe("idle_hard");
      expect(SITUATION.ERROR_LOOP).toBe("error_loop");
      expect(SITUATION.RATE_LIMITED).toBe("rate_limited");
      expect(SITUATION.NO_COMMITS).toBe("no_commits");
      expect(SITUATION.COMMITS_NOT_PUSHED).toBe("commits_not_pushed");
      expect(SITUATION.POOR_QUALITY).toBe("poor_quality");
      expect(SITUATION.FALSE_COMPLETION).toBe("false_completion");

      expect(INTERVENTION.NONE).toBe("none");
      expect(INTERVENTION.CONTINUE_SIGNAL).toBe("continue_signal");
      expect(INTERVENTION.INJECT_PROMPT).toBe("inject_prompt");
      expect(INTERVENTION.FORCE_NEW_THREAD).toBe("force_new_thread");
      expect(INTERVENTION.REDISPATCH_TASK).toBe("redispatch_task");
      expect(INTERVENTION.BLOCK_AND_NOTIFY).toBe("block_and_notify");
    });
  });

  // ── Lifecycle ───────────────────────────────────────────────────────

  describe("start / stop", () => {
    it("starts without error", () => {
      supervisor.start();
      expect(supervisor.getSystemHealth().started).toBe(true);
    });

    it("stops without error", () => {
      supervisor.start();
      supervisor.stop();
      expect(supervisor.getSystemHealth().started).toBe(false);
    });

    it("is idempotent on start", () => {
      supervisor.start();
      supervisor.start();
      expect(supervisor.getSystemHealth().started).toBe(true);
    });
  });

  // ── Assess — Situation Detection ───────────────────────────────────

  describe("assess", () => {
    it("returns HEALTHY for no signals", () => {
      const result = supervisor.assess("task-1");
      expect(result.situation).toBe(SITUATION.HEALTHY);
      expect(result.intervention).toBe(INTERVENTION.NONE);
    });

    it("detects rate_limited from error text", () => {
      const result = supervisor.assess("task-1", {
        error: "429 Too Many Requests",
      });
      expect(result.situation).toBe(SITUATION.RATE_LIMITED);
      expect(result.intervention).toBe(INTERVENTION.COOLDOWN);
    });

    it("detects rate_limit_flood when 3+ rate limits in sequence", () => {
      // Build up error patterns
      const bus = {
        getAgentLiveness: () => [],
        getErrorHistory: () => [
          { pattern: "rate_limit", ts: Date.now() },
          { pattern: "rate_limit", ts: Date.now() },
          { pattern: "rate_limit", ts: Date.now() },
        ],
        getEventLog: () => [],
      };
      const s = createAgentSupervisor({ eventBus: bus });
      const result = s.assess("task-1", {
        error: "429 Too Many Requests",
      });
      expect(result.situation).toBe(SITUATION.RATE_LIMIT_FLOOD);
      expect(result.intervention).toBe(INTERVENTION.PAUSE_EXECUTOR);
    });

    it("detects api_error from ECONNREFUSED", () => {
      const result = supervisor.assess("task-1", {
        error: "ECONNREFUSED 127.0.0.1:443",
      });
      expect(result.situation).toBe(SITUATION.API_ERROR);
      expect(result.intervention).toBe(INTERVENTION.CONTINUE_SIGNAL);
    });

    it("detects token_overflow", () => {
      const result = supervisor.assess("task-1", {
        error: "context too long exceeded maximum tokens",
      });
      expect(result.situation).toBe(SITUATION.TOKEN_OVERFLOW);
    });

    it("detects session_expired", () => {
      const result = supervisor.assess("task-1", {
        error: "session expired unauthorized",
      });
      expect(result.situation).toBe(SITUATION.SESSION_EXPIRED);
    });

    it("detects model_error", () => {
      const result = supervisor.assess("task-1", {
        error: "model not supported: gpt-5",
      });
      expect(result.situation).toBe(SITUATION.MODEL_ERROR);
    });

    it("detects build_failure", () => {
      const result = supervisor.assess("task-1", {
        error: "go build failed: compilation error in main.go",
      });
      expect(result.situation).toBe(SITUATION.BUILD_FAILURE);
    });

    it("detects test_failure", () => {
      const result = supervisor.assess("task-1", {
        error: "FAIL	github.com/test/pkg	0.5s",
      });
      expect(result.situation).toBe(SITUATION.TEST_FAILURE);
    });

    it("detects git_conflict", () => {
      const result = supervisor.assess("task-1", {
        error: "CONFLICT (content): Merge conflict in README.md",
      });
      expect(result.situation).toBe(SITUATION.GIT_CONFLICT);
    });

    it("detects push_failure", () => {
      const result = supervisor.assess("task-1", {
        error: "git push failed: rejected push non-fast-forward",
      });
      expect(result.situation).toBe(SITUATION.PUSH_FAILURE);
    });

    it("detects pre_push_failure", () => {
      const result = supervisor.assess("task-1", {
        error: "pre-push hook failed with exit code 1",
      });
      expect(result.situation).toBe(SITUATION.PRE_PUSH_FAILURE);
    });

    it("detects no_commits from context", () => {
      const result = supervisor.assess("task-1", {
        hasCommits: false,
        output: "task is complete, all done",
      });
      expect(result.situation).toBe(SITUATION.NO_COMMITS);
    });

    it("detects poor_quality from review result", () => {
      const result = supervisor.assess("task-1", {
        reviewResult: {
          approved: false,
          issues: [{ severity: "critical", description: "SQL injection" }],
        },
      });
      expect(result.situation).toBe(SITUATION.POOR_QUALITY);
    });

    it("respects situation override from context", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.PLAN_STUCK,
      });
      expect(result.situation).toBe(SITUATION.PLAN_STUCK);
      expect(result.intervention).toBe(INTERVENTION.INJECT_PROMPT);
    });
  });

  // ── Health Score ────────────────────────────────────────────────────

  describe("health score", () => {
    it("returns 0-100 range", () => {
      const result = supervisor.assess("task-1");
      expect(result.healthScore).toBeGreaterThanOrEqual(0);
      expect(result.healthScore).toBeLessThanOrEqual(100);
    });

    it("scores higher with no signals than with errors", () => {
      const healthy = supervisor.assess("task-1");
      const error = supervisor.assess("task-2", {
        error: "go build failed",
      });
      expect(healthy.healthScore).toBeGreaterThanOrEqual(error.healthScore);
    });
  });

  // ── Intervention Ladder ─────────────────────────────────────────────

  describe("intervention escalation", () => {
    it("escalates through the ladder for plan_stuck", () => {
      // First time: inject_prompt
      const r1 = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(r1.intervention).toBe(INTERVENTION.INJECT_PROMPT);

      // Second time: force_new_thread
      const r2 = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(r2.intervention).toBe(INTERVENTION.FORCE_NEW_THREAD);

      // Third time: redispatch
      const r3 = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(r3.intervention).toBe(INTERVENTION.REDISPATCH_TASK);

      // Fourth time: block
      const r4 = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(r4.intervention).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });

    it("escalates for idle_hard from continue to inject to new thread to block", () => {
      const interventions = [];
      for (let i = 0; i < 4; i++) {
        const r = supervisor.assess("task-2", { situation: SITUATION.IDLE_HARD });
        interventions.push(r.intervention);
      }
      expect(interventions[0]).toBe(INTERVENTION.CONTINUE_SIGNAL);
      expect(interventions[1]).toBe(INTERVENTION.INJECT_PROMPT);
      expect(interventions[2]).toBe(INTERVENTION.FORCE_NEW_THREAD);
      expect(interventions[3]).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });

    it("does not escalate for HEALTHY", () => {
      for (let i = 0; i < 5; i++) {
        const r = supervisor.assess("task-3");
        expect(r.intervention).toBe(INTERVENTION.NONE);
      }
    });

    it("uses continue-first recovery with cooldowns for repeated api_error", async () => {
      const first = supervisor.assess("task-api", { error: "500 Internal Server Error" });
      expect(first.intervention).toBe(INTERVENTION.CONTINUE_SIGNAL);
      await supervisor.intervene("task-api", first);
      expect(mockSendContinue).toHaveBeenCalledWith("task-api");

      const cooling = supervisor.assess("task-api", { error: "500 Internal Server Error" });
      expect(cooling.intervention).toBe(INTERVENTION.COOLDOWN);

      vi.advanceTimersByTime(3 * 60_000 + 1);
      const second = supervisor.assess("task-api", { error: "500 Internal Server Error" });
      expect(second.intervention).toBe(INTERVENTION.CONTINUE_SIGNAL);
      await supervisor.intervene("task-api", second);

      vi.advanceTimersByTime(5 * 60_000 + 1);
      const third = supervisor.assess("task-api", { error: "500 Internal Server Error" });
      expect(third.intervention).toBe(INTERVENTION.CONTINUE_SIGNAL);
      await supervisor.intervene("task-api", third);

      vi.advanceTimersByTime(5 * 60_000 + 1);
      const fourth = supervisor.assess("task-api", { error: "500 Internal Server Error" });
      expect(fourth.intervention).toBe(INTERVENTION.FORCE_NEW_THREAD);
    });

    it("resets api_error recovery when the error signature changes", async () => {
      const first = supervisor.assess("task-api-reset", { error: "500 Internal Server Error" });
      await supervisor.intervene("task-api-reset", first);

      const changed = supervisor.assess("task-api-reset", { error: "502 Bad Gateway upstream" });
      expect(changed.intervention).toBe(INTERVENTION.CONTINUE_SIGNAL);
    });
  });

  // ── Recovery Prompts ────────────────────────────────────────────────

  describe("recovery prompts", () => {
    it("generates plan_stuck prompt mentioning task title", () => {
      const result = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(result.prompt).toBeTruthy();
      expect(result.prompt).toContain("Test task");
      expect(result.prompt).toContain("IMPLEMENT NOW");
    });

    it("generates false_completion prompt", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.FALSE_COMPLETION,
      });
      expect(result.prompt).toContain("NOT complete");
    });

    it("generates no_commits prompt", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.NO_COMMITS,
      });
      expect(result.prompt).toContain("zero commits");
    });

    it("generates commits_not_pushed prompt with branch", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.COMMITS_NOT_PUSHED,
      });
      expect(result.prompt).toContain("push");
    });

    it("generates tool_loop prompt", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.TOOL_LOOP,
        loopedTools: "grep_search, read_file",
      });
      expect(result.prompt).toContain("different strategy");
      expect(result.prompt).toContain("grep_search, read_file");
    });

    it("generates doom_loop prompt", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.DOOM_LOOP,
      });
      expect(result.prompt).toContain("doom loop");
      expect(result.prompt).toContain("changes state");
    });

    it("generates error_loop prompt", () => {
      const result = supervisor.assess("task-1", {
        situation: SITUATION.ERROR_LOOP,
        errorPattern: "build_failure",
      });
      expect(result.prompt).toContain("ROOT CAUSE");
    });

    it("generates poor_quality prompt with review issues", () => {
      // First, set review issues
      supervisor.onReviewComplete("task-1", {
        approved: false,
        issues: [
          { severity: "critical", file: "main.go", line: 42, description: "SQL injection" },
        ],
      });

      const result = supervisor.assess("task-1", {
        situation: SITUATION.POOR_QUALITY,
      });
      expect(result.prompt).toContain("SQL injection");
      expect(result.prompt).toContain("main.go");
    });

    it("returns null for HEALTHY (no prompt needed)", () => {
      const result = supervisor.assess("task-1");
      expect(result.prompt).toBeNull();
    });
  });

  // ── Intervention Dispatch ───────────────────────────────────────────

  describe("intervene", () => {
    it("dispatches CONTINUE_SIGNAL", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.CONTINUE_SIGNAL,
        prompt: null,
        reason: "idle",
        situation: SITUATION.IDLE_HARD,
      });
      expect(mockSendContinue).toHaveBeenCalledWith("task-1");
    });

    it("records api_error continue cooldown state", async () => {
      const decision = supervisor.assess("task-api-intervene", {
        error: "500 Internal Server Error",
      });
      await supervisor.intervene("task-api-intervene", decision);
      const diagnostics = supervisor.getTaskDiagnostics("task-api-intervene");
      expect(diagnostics.apiErrorRecovery.continueAttempts).toBe(1);
      expect(diagnostics.apiErrorRecovery.cooldownRemainingMs).toBeGreaterThan(0);
    });

    it("dispatches INJECT_PROMPT", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.INJECT_PROMPT,
        prompt: "Fix the build",
        reason: "build failure",
        situation: SITUATION.BUILD_FAILURE,
      });
      expect(mockInjectPrompt).toHaveBeenCalledWith("task-1", "Fix the build");
    });

    it("dispatches FORCE_NEW_THREAD", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.FORCE_NEW_THREAD,
        prompt: null,
        reason: "token overflow",
        situation: SITUATION.TOKEN_OVERFLOW,
      });
      expect(mockForceNewThread).toHaveBeenCalledWith("task-1", "token overflow");
    });

    it("dispatches REDISPATCH_TASK", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.REDISPATCH_TASK,
        prompt: null,
        reason: "agent dead",
        situation: SITUATION.AGENT_DEAD,
      });
      expect(mockRedispatch).toHaveBeenCalledWith("task-1");
    });

    it("dispatches BLOCK_AND_NOTIFY with telegram", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.BLOCK_AND_NOTIFY,
        prompt: null,
        reason: "max retries",
        situation: SITUATION.ERROR_LOOP,
      });
      expect(mockSetTaskStatus).toHaveBeenCalledWith("task-1", "blocked", "supervisor");
      expect(mockSendTelegram).toHaveBeenCalled();
      expect(mockSendTelegram.mock.calls[0][0]).toContain("blocked");
    });

    it("dispatches PAUSE_EXECUTOR", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.PAUSE_EXECUTOR,
        prompt: null,
        reason: "rate limit flood",
        situation: SITUATION.RATE_LIMIT_FLOOD,
      });
      expect(mockPauseExecutor).toHaveBeenCalledWith(300000, "rate limit flood");
      expect(mockSendTelegram).toHaveBeenCalled();
    });

    it("dispatches DISPATCH_FIX with review issues", async () => {
      // Set review issues first
      supervisor.onReviewComplete("task-1", {
        approved: false,
        issues: [{ severity: "critical", description: "bug" }],
      });

      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.DISPATCH_FIX,
        prompt: "Fix review issues",
        reason: "review rejected",
        situation: SITUATION.POOR_QUALITY,
      });
      expect(mockDispatchFix).toHaveBeenCalledWith("task-1", [
        { severity: "critical", description: "bug" },
      ]);
    });

    it("NONE does nothing", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.NONE,
        prompt: null,
        reason: "healthy",
        situation: SITUATION.HEALTHY,
      });
      expect(mockSendContinue).not.toHaveBeenCalled();
      expect(mockInjectPrompt).not.toHaveBeenCalled();
      expect(mockForceNewThread).not.toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      const brokenSupervisor = createAgentSupervisor({
        sendContinueSignal: () => {
          throw new Error("connection lost");
        },
      });
      // Should not throw
      await brokenSupervisor.intervene("task-1", {
        intervention: INTERVENTION.CONTINUE_SIGNAL,
        prompt: null,
        reason: "test",
        situation: SITUATION.IDLE_HARD,
      });
    });
  });

  // ── assessAndIntervene ──────────────────────────────────────────────

  describe("assessAndIntervene", () => {
    it("assesses and dispatches in one call", async () => {
      const decision = await supervisor.assessAndIntervene("task-1", {
        situation: SITUATION.PLAN_STUCK,
      });
      expect(decision.situation).toBe(SITUATION.PLAN_STUCK);
      expect(decision.intervention).toBe(INTERVENTION.INJECT_PROMPT);
      expect(mockInjectPrompt).toHaveBeenCalled();
    });

    it("does not dispatch for HEALTHY", async () => {
      const decision = await supervisor.assessAndIntervene("task-1");
      expect(decision.intervention).toBe(INTERVENTION.NONE);
      expect(mockInjectPrompt).not.toHaveBeenCalled();
    });
  });

  // ── Review Enforcement ──────────────────────────────────────────────

  describe("review enforcement", () => {
    it("records approved review", async () => {
      await supervisor.onReviewComplete("task-1", {
        approved: true,
        issues: [],
        summary: "LGTM",
      });
      const diag = supervisor.getTaskDiagnostics("task-1");
      expect(diag.reviewVerdict).toBe("approved");
      expect(diag.qualityScore).toBeGreaterThanOrEqual(80);
    });

    it("records rejected review and dispatches fix", async () => {
      await supervisor.onReviewComplete("task-1", {
        approved: false,
        issues: [
          { severity: "critical", description: "SQL injection", file: "db.go" },
          { severity: "major", description: "Missing error check", file: "handler.go" },
        ],
        summary: "Critical security issues",
      });

      const diag = supervisor.getTaskDiagnostics("task-1");
      expect(diag.reviewVerdict).toBe("changes_requested");
      expect(diag.reviewIssueCount).toBe(2);
      // Quality score penalized: 100 - 30(critical) - 15(major) = 55
      expect(diag.qualityScore).toBe(55);
    });

    it("canComplete returns false when review rejected", () => {
      supervisor.onReviewComplete("task-1", {
        approved: false,
        issues: [{ severity: "critical" }],
      });
      const check = supervisor.canComplete("task-1");
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain("rejected");
    });

    it("canComplete returns true when review approved", () => {
      supervisor.onReviewComplete("task-1", {
        approved: true,
        issues: [],
      });
      const check = supervisor.canComplete("task-1");
      expect(check.allowed).toBe(true);
    });

    it("canComplete returns true for untracked tasks", () => {
      const check = supervisor.canComplete("unknown-task");
      expect(check.allowed).toBe(true);
    });
  });

  // ── Completion Verification ─────────────────────────────────────────

  describe("verifyCompletion", () => {
    it("returns HEALTHY for good completion", () => {
      const result = supervisor.verifyCompletion("task-1", {
        hasCommits: true,
        prUrl: "https://github.com/test/repo/pull/42",
        prNumber: 42,
      });
      expect(result.situation).toBe(SITUATION.HEALTHY);
      expect(result.issues).toHaveLength(0);
    });

    it("detects no commits", () => {
      const result = supervisor.verifyCompletion("task-1", {
        hasCommits: false,
      });
      expect(result.situation).toBe(SITUATION.NO_COMMITS);
      expect(result.issues).toContain("No commits detected");
    });

    it("detects no PR", () => {
      const result = supervisor.verifyCompletion("task-1", {
        hasCommits: true,
      });
      expect(result.situation).toBe(SITUATION.PR_NOT_CREATED);
      expect(result.issues).toContain("No PR created");
    });

    it("detects plan_stuck from output", () => {
      const result = supervisor.verifyCompletion("task-1", {
        hasCommits: true,
        prUrl: "https://github.com/test/repo/pull/42",
        output: "Here is my plan. Ready to implement?",
      });
      expect(result.situation).toBe(SITUATION.PLAN_STUCK);
    });

    it("detects false completion from output without commits", () => {
      const result = supervisor.verifyCompletion("task-1", {
        hasCommits: false,
        output: "Task is complete, all done, successfully completed the work",
      });
      expect(result.situation).toBe(SITUATION.FALSE_COMPLETION);
    });
  });

  // ── Diagnostics ─────────────────────────────────────────────────────

  describe("diagnostics", () => {
    it("getTaskDiagnostics returns null for unknown task", () => {
      expect(supervisor.getTaskDiagnostics("nonexistent")).toBeNull();
    });

    it("getTaskDiagnostics returns data after assessment", () => {
      supervisor.assess("task-1", { error: "build failed" });
      const diag = supervisor.getTaskDiagnostics("task-1");
      expect(diag).toBeTruthy();
      expect(diag.taskId).toBe("task-1");
      expect(diag.recentSituations.length).toBeGreaterThan(0);
    });

    it("getAllDiagnostics returns all tracked tasks", () => {
      supervisor.assess("task-1");
      supervisor.assess("task-2");
      supervisor.assess("task-3");
      const all = supervisor.getAllDiagnostics();
      expect(all).toHaveLength(3);
    });

    it("getSystemHealth returns expected shape", () => {
      supervisor.start();
      supervisor.assess("task-1");
      const health = supervisor.getSystemHealth();
      expect(health).toHaveProperty("started", true);
      expect(health).toHaveProperty("trackedTasks", 1);
      expect(health).toHaveProperty("averageHealth");
      expect(health).toHaveProperty("blockedTasks");
      expect(health).toHaveProperty("activeInterventions");
    });
  });

  // ── Reset ───────────────────────────────────────────────────────────

  describe("resetTask", () => {
    it("clears all state for a task", () => {
      supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(supervisor.getTaskDiagnostics("task-1").interventionCount).toBe(2);

      supervisor.resetTask("task-1");
      expect(supervisor.getTaskDiagnostics("task-1")).toBeNull();

      // Fresh assessment should start at intervention 0
      const result = supervisor.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      expect(result.intervention).toBe(INTERVENTION.INJECT_PROMPT);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles missing dispatch functions gracefully", async () => {
      const barebones = createAgentSupervisor({});
      // Should not throw even with no dispatch functions
      await barebones.intervene("task-1", {
        intervention: INTERVENTION.INJECT_PROMPT,
        prompt: "test",
        reason: "test",
        situation: SITUATION.PLAN_STUCK,
      });
    });

    it("handles missing getTask gracefully", () => {
      const noTask = createAgentSupervisor({});
      const result = noTask.assess("task-1", { situation: SITUATION.PLAN_STUCK });
      // Should still generate a prompt (with task ID as fallback)
      expect(result.prompt).toBeTruthy();
    });

    it("caps situation history to 50 entries", () => {
      for (let i = 0; i < 60; i++) {
        supervisor.assess("task-1");
      }
      const diag = supervisor.getTaskDiagnostics("task-1");
      expect(diag.recentSituations.length).toBeLessThanOrEqual(10); // returns last 10
    });

    it("caps health scores to 20 entries", () => {
      for (let i = 0; i < 25; i++) {
        supervisor.assess("task-1");
      }
      // Internally capped at 20
      const diag = supervisor.getTaskDiagnostics("task-1");
      expect(diag.currentHealthScore).toBeDefined();
    });

    it("emits supervisor-intervention event to event bus", async () => {
      const mockBus = { emit: vi.fn() };
      const s = createAgentSupervisor({
        eventBus: mockBus,
        sendContinueSignal: mockSendContinue,
      });
      await s.intervene("task-1", {
        intervention: INTERVENTION.CONTINUE_SIGNAL,
        prompt: null,
        reason: "idle",
        situation: SITUATION.IDLE_HARD,
      });
      expect(mockBus.emit).toHaveBeenCalledWith(
        "agent:supervisor-intervention",
        "task-1",
        expect.objectContaining({
          situation: SITUATION.IDLE_HARD,
          intervention: INTERVENTION.CONTINUE_SIGNAL,
        }),
      );
    });

    it("DISPATCH_FIX falls back to inject_prompt if no review issues", async () => {
      await supervisor.intervene("task-1", {
        intervention: INTERVENTION.DISPATCH_FIX,
        prompt: "Generic fix prompt",
        reason: "poor quality",
        situation: SITUATION.POOR_QUALITY,
      });
      // No review issues set, no dispatchFixTask call
      expect(mockDispatchFix).not.toHaveBeenCalled();
      // Falls back to inject
      expect(mockInjectPrompt).toHaveBeenCalledWith("task-1", "Generic fix prompt");
    });

    it("maps near-identical reasoning anomalies to doom_loop", () => {
      const s = createAgentSupervisor({
        anomalyDetector: {
          getActiveAnomalies: () => [
            {
              type: "THOUGHT_SPINNING",
              severity: "LOW",
              data: { loopKind: "near_identical_reasoning" },
            },
          ],
        },
      });
      const result = s.assess("task-doom");
      expect(result.situation).toBe(SITUATION.DOOM_LOOP);
      expect(result.intervention).toBe(INTERVENTION.INJECT_PROMPT);
    });

    it("maps idle stall anomalies to idle situations", () => {
      const s = createAgentSupervisor({
        anomalyDetector: {
          getActiveAnomalies: () => [
            {
              type: "IDLE_STALL",
              severity: "HIGH",
              data: {},
            },
          ],
        },
      });
      const result = s.assess("task-stall");
      expect(result.situation).toBe(SITUATION.IDLE_HARD);
    });

    it("maps no_progress session analysis to idle_soft", () => {
      const s = createAgentSupervisor({
        sessionTracker: {
          getProgressStatus: () => ({
            totalEvents: 8,
            elapsedMs: 120000,
            idleMs: 1000,
            hasCommits: false,
            hasEdits: false,
          }),
          getLastMessages: () => [
            { type: "system", content: "Task assigned" },
            { type: "system", content: "Session started" },
            { type: "agent_message", content: "Still checking status 101" },
            { type: "agent_message", content: "Still checking status 102" },
            { type: "agent_message", content: "Still checking status 103" },
            { type: "system", content: "Heartbeat" },
          ],
        },
        errorDetector: {
          analyzeMessageSequence: () => ({
            primary: "no_progress",
            patterns: ["no_progress"],
            details: { no_progress: "stalled" },
          }),
        },
      });
      const result = s.assess("task-stalled");
      expect(result.situation).toBe(SITUATION.IDLE_SOFT);
    });
  });

  // ── Comprehensive Situation Coverage ────────────────────────────────

  describe("situation coverage", () => {
    const testCases = [
      { error: "429 rate limit exceeded", expected: SITUATION.RATE_LIMITED },
      { error: "ETIMEDOUT connecting to api", expected: SITUATION.API_ERROR },
      { error: "context too long maximum exceeded", expected: SITUATION.TOKEN_OVERFLOW },
      { error: "session expired please login", expected: SITUATION.SESSION_EXPIRED },
      { error: "model not supported claude-x", expected: SITUATION.MODEL_ERROR },
      { error: "ECONNREFUSED localhost:8080", expected: SITUATION.API_ERROR },
      { error: "500 Internal Server Error", expected: SITUATION.API_ERROR },
      { error: "502 Bad Gateway", expected: SITUATION.API_ERROR },
      { error: "fetch failed network error", expected: SITUATION.API_ERROR },
      { error: "quota exceeded", expected: SITUATION.RATE_LIMITED },
      { error: "thread not found", expected: SITUATION.SESSION_EXPIRED },
      { error: "max token exceeded", expected: SITUATION.TOKEN_OVERFLOW },
      { error: "pre-push hook failed exit code 1", expected: SITUATION.PRE_PUSH_FAILURE },
      { error: "git push failed rejected", expected: SITUATION.PUSH_FAILURE },
      { error: "go build failed compilation error", expected: SITUATION.BUILD_FAILURE },
      { error: "FAIL github.com/pkg/test 1.2s", expected: SITUATION.TEST_FAILURE },
      { error: "golangci-lint error found", expected: SITUATION.LINT_FAILURE },
      { error: "merge conflict in README.md", expected: SITUATION.GIT_CONFLICT },
    ];

    for (const { error, expected } of testCases) {
      it(`detects ${expected} from "${error.slice(0, 40)}"`, () => {
        const result = supervisor.assess(`task-${expected}`, { error });
        expect(result.situation).toBe(expected);
      });
    }
  });

  // ── Auth / Config / Policy / Sandbox Situation Detection ─────────

  describe("auth/config/policy/sandbox situation detection", () => {
    const authCases = [
      { error: "invalid api key", expected: SITUATION.AUTH_FAILURE },
      { error: "authentication_error from Anthropic", expected: SITUATION.AUTH_FAILURE },
      { error: "401 Unauthorized on /v1/chat", expected: SITUATION.AUTH_FAILURE },
      { error: "403 Forbidden: access denied", expected: SITUATION.AUTH_FAILURE },
      { error: "billing_hard_limit reached", expected: SITUATION.AUTH_FAILURE },
      { error: "insufficient_quota for org", expected: SITUATION.AUTH_FAILURE },
      { error: "invalid credentials supplied", expected: SITUATION.AUTH_FAILURE },
      { error: "not authorized to access this model", expected: SITUATION.AUTH_FAILURE },
      { error: "permission_error on resource", expected: SITUATION.AUTH_FAILURE },
    ];

    for (const { error, expected } of authCases) {
      it(`detects AUTH_FAILURE from "${error.slice(0, 40)}"`, () => {
        const result = supervisor.assess("task-auth", { error });
        expect(result.situation).toBe(expected);
      });
    }

    const contentPolicyCases = [
      { error: "content_policy_violation in response" },
      { error: "content filter blocked the output" },
      { error: "safety_system rejected request" },
      { error: "flagged content detected in prompt" },
      { error: "output blocked by safety filter" },
    ];
    for (const { error } of contentPolicyCases) {
      it(`detects CONTENT_POLICY from "${error.slice(0, 40)}"`, () => {
        const result = supervisor.assess("task-cp", { error });
        expect(result.situation).toBe(SITUATION.CONTENT_POLICY);
      });
    }

    const sandboxCases = [
      { error: "sandbox failed to initialize" },
      { error: "bwrap error: permission denied" },
      { error: "bubblewrap failed with EPERM" },
      { error: "EPERM: operation not permitted on /tmp" },
      { error: "writable_roots paths not configured" },
      { error: "codex segfault during execution" },
      { error: "namespace error in sandbox" },
    ];
    for (const { error } of sandboxCases) {
      it(`detects CODEX_SANDBOX from "${error.slice(0, 40)}"`, () => {
        const result = supervisor.assess("task-sb", { error });
        expect(result.situation).toBe(SITUATION.CODEX_SANDBOX);
      });
    }

    const configCases = [
      { error: "config invalid: missing EXECUTOR field" },
      { error: "config missing for agent pool" },
      { error: "misconfigured agent settings detected" },
      { error: "OPENAI_API_KEY not set in environment" },
      { error: "ANTHROPIC_API_KEY not set for claude executor" },
    ];
    for (const { error } of configCases) {
      it(`detects INVALID_CONFIG from "${error.slice(0, 40)}"`, () => {
        const result = supervisor.assess("task-cfg", { error });
        expect(result.situation).toBe(SITUATION.INVALID_CONFIG);
      });
    }

    it("AUTH_FAILURE intervention is immediate BLOCK_AND_NOTIFY", () => {
      const result = supervisor.assess("task-auth-int", {
        error: "invalid api key",
      });
      expect(result.situation).toBe(SITUATION.AUTH_FAILURE);
      expect(result.intervention).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });

    it("CONTENT_POLICY intervention is immediate BLOCK_AND_NOTIFY", () => {
      const result = supervisor.assess("task-cp-int", {
        error: "content_policy_violation",
      });
      expect(result.situation).toBe(SITUATION.CONTENT_POLICY);
      expect(result.intervention).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });

    it("CODEX_SANDBOX first escalation is INJECT_PROMPT", () => {
      const result = supervisor.assess("task-sb-esc", {
        error: "sandbox failed",
      });
      expect(result.situation).toBe(SITUATION.CODEX_SANDBOX);
      expect(result.intervention).toBe(INTERVENTION.INJECT_PROMPT);
    });

    it("MODEL_ERROR intervention is immediate BLOCK_AND_NOTIFY", () => {
      const result = supervisor.assess("task-model-int", {
        error: "model not supported claude-99",
      });
      expect(result.situation).toBe(SITUATION.MODEL_ERROR);
      expect(result.intervention).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });

    it("INVALID_CONFIG intervention is immediate BLOCK_AND_NOTIFY", () => {
      const result = supervisor.assess("task-cfg-int", {
        error: "config invalid: no executors",
      });
      expect(result.situation).toBe(SITUATION.INVALID_CONFIG);
      expect(result.intervention).toBe(INTERVENTION.BLOCK_AND_NOTIFY);
    });
  });
});
