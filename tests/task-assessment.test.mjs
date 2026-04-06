import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assessTask,
  quickAssess,
  buildAssessmentPrompt,
  extractDecisionJson,
  resetAssessmentDedup,
  VALID_ACTIONS,
} from "../task/task-assessment.mjs";

describe("task-assessment", () => {
  beforeEach(() => {
    resetAssessmentDedup();
  });

  // ── VALID_ACTIONS ────────────────────────────────────────────────────────

  describe("VALID_ACTIONS", () => {
    it("contains the expected lifecycle actions", () => {
      expect(VALID_ACTIONS.has("merge")).toBe(true);
      expect(VALID_ACTIONS.has("reprompt_same")).toBe(true);
      expect(VALID_ACTIONS.has("reprompt_new_session")).toBe(true);
      expect(VALID_ACTIONS.has("new_attempt")).toBe(true);
      expect(VALID_ACTIONS.has("wait")).toBe(true);
      expect(VALID_ACTIONS.has("manual_review")).toBe(true);
      expect(VALID_ACTIONS.has("close_and_replan")).toBe(true);
      expect(VALID_ACTIONS.has("accept_with_debt")).toBe(true);
      expect(VALID_ACTIONS.has("split_task")).toBe(true);
      expect(VALID_ACTIONS.has("escalate_to_replan")).toBe(true);
      expect(VALID_ACTIONS.has("noop")).toBe(true);
    });

    it("does not contain invalid actions", () => {
      expect(VALID_ACTIONS.has("banana")).toBe(false);
      expect(VALID_ACTIONS.has("")).toBe(false);
    });
  });

  // ── extractDecisionJson ──────────────────────────────────────────────────

  describe("extractDecisionJson", () => {
    it("parses direct JSON string", () => {
      const raw = '{"action":"merge","reason":"CI passing"}';
      expect(extractDecisionJson(raw)).toEqual({
        action: "merge",
        reason: "CI passing",
      });
    });

    it("parses JSON inside markdown fences", () => {
      const raw =
        "```json\n{\"action\":\"reprompt_same\",\"prompt\":\"Fix the lint error\"}\n```";
      expect(extractDecisionJson(raw)).toEqual({
        action: "reprompt_same",
        prompt: "Fix the lint error",
      });
    });

    it("parses JSON embedded in prose", () => {
      const raw =
        'Here is my recommendation: {"action":"wait","waitSeconds":300,"reason":"CI pending"} end.';
      expect(extractDecisionJson(raw)).toEqual({
        action: "wait",
        waitSeconds: 300,
        reason: "CI pending",
      });
    });

    it("returns null for null input", () => {
      expect(extractDecisionJson(null)).toBeNull();
    });

    it("returns null for non-JSON text", () => {
      expect(extractDecisionJson("no json here at all")).toBeNull();
    });

    it("returns null when action field is missing", () => {
      expect(extractDecisionJson('{"reason":"something"}')).toBeNull();
    });
  });

  // ── buildAssessmentPrompt ────────────────────────────────────────────────

  describe("buildAssessmentPrompt", () => {
    it("includes task context in prompt", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        taskTitle: "Add authentication module",
        taskDescription: "Implement JWT-based auth",
        trigger: "agent_completed",
        branch: "ve/add-auth",
        upstreamBranch: "main",
        agentType: "codex",
        attemptCount: 1,
        shortId: "abc",
      });

      expect(prompt).toContain("# Task Lifecycle Assessment");
      expect(prompt).toContain("**Task:** Add authentication module");
      expect(prompt).toContain("**Branch:** ve/add-auth");
      expect(prompt).toContain("**Upstream/Base:** main");
      expect(prompt).toContain("**Agent:** codex");
      expect(prompt).toContain("**Attempt #:** 1");
      expect(prompt).toContain("agent_completed");
    });

    it("includes rebase failure details when trigger is rebase_failed", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "rebase_failed",
        rebaseError: "CONFLICT (content): Merge conflict in src/index.js",
        conflictFiles: ["src/index.js", "package-lock.json"],
        shortId: "abc",
      });

      expect(prompt).toContain("Rebase Failure Details");
      expect(prompt).toContain(
        "CONFLICT (content): Merge conflict in src/index.js",
      );
      expect(prompt).toContain("src/index.js");
      expect(prompt).toContain("package-lock.json");
    });

    it("includes PR details when prNumber is provided", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "ci_failed",
        prNumber: 42,
        prState: "open",
        ciStatus: "failing",
        shortId: "abc",
      });

      expect(prompt).toContain("PR #42");
      expect(prompt).toContain("CI: failing");
    });

    it("includes branch status when commits data provided", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "idle_detected",
        commitsAhead: 3,
        commitsBehind: 2,
        diffStat: "3 files changed",
        shortId: "abc",
      });

      expect(prompt).toContain("Commits ahead: 3");
      expect(prompt).toContain("Commits behind: 2");
      expect(prompt).toContain("3 files changed");
    });

    it("includes explicit objective-frame sections when present", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "agent_completed",
        shortId: "abc",
        objectiveFrame: {
          successCriteria: [
            {
              id: "criterion-1",
              title: "Finish evidence summary",
              description: "Capture final evidence and operator notes",
              status: "partial",
              blocking: true,
            },
          ],
          goalProgress: {
            status: "in_progress",
            completedCriteriaCount: 1,
            totalCriteriaCount: 2,
            completionRatio: 0.5,
            summary: "Half complete",
          },
          constraintState: {
            status: "blocked",
            blocked: true,
            violationCount: 1,
            blockingViolationCount: 1,
            violations: [
              {
                constraintId: "approval",
                message: "Operator approval required before rollout.",
                blocking: true,
              },
            ],
          },
          tokenBudget: {
            status: "near_limit",
            budgetTokens: 1000,
            totalTokens: 910,
            remainingTokens: 90,
            utilizationRatio: 0.91,
          },
        },
      });

      expect(prompt).toContain("## Explicit Success Criteria");
      expect(prompt).toContain("Finish evidence summary [partial] (blocking)");
      expect(prompt).toContain("## Goal Progress");
      expect(prompt).toContain("Completion ratio: 50%");
      expect(prompt).toContain("## Constraints");
      expect(prompt).toContain("approval: Operator approval required before rollout.");
      expect(prompt).toContain("## Token Budget");
      expect(prompt).toContain("Status: near_limit");
    });

    it("includes agent last message", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "agent_completed",
        agentLastMessage: "All tests passed, PR is ready",
        shortId: "abc",
      });

      expect(prompt).toContain("Agent's Last Message");
      expect(prompt).toContain("All tests passed, PR is ready");
    });

    it("includes downstream impact details for pr_merged_downstream trigger", () => {
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "pr_merged_downstream",
        upstreamBranch: "main",
        shortId: "abc",
      });

      expect(prompt).toContain("Downstream Impact");
      expect(prompt).toContain("main");
    });

    it("truncates long task descriptions to 3000 chars", () => {
      const longDesc = "x".repeat(4000);
      const prompt = buildAssessmentPrompt({
        taskId: "abc-123",
        trigger: "agent_completed",
        taskDescription: longDesc,
        shortId: "abc",
      });

      // Description is sliced at 3000
      expect(prompt).toContain("x".repeat(3000));
      expect(prompt).not.toContain("x".repeat(3001));
    });
  });

  // ── quickAssess ──────────────────────────────────────────────────────────

  describe("quickAssess", () => {
    it("returns reprompt_same for auto-resolvable lock file conflicts", () => {
      const result = quickAssess({
        taskId: "t1",
        trigger: "rebase_failed",
        upstreamBranch: "main",
        conflictFiles: ["pnpm-lock.yaml", "package-lock.json"],
        shortId: "t1",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("reprompt_same");
      expect(result.success).toBe(true);
      expect(result.prompt).toContain("pnpm-lock.yaml");
      expect(result.prompt).toContain("package-lock.json");
      expect(result.prompt).toContain("git merge --continue");
    });

    it("returns reprompt_same for go.sum conflicts", () => {
      const result = quickAssess({
        taskId: "t2",
        trigger: "rebase_failed",
        upstreamBranch: "staging",
        conflictFiles: ["go.sum"],
        shortId: "t2",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("reprompt_same");
      expect(result.prompt).toContain("go.sum");
    });

    it("returns null when conflict files are non-auto-resolvable", () => {
      const result = quickAssess({
        taskId: "t3",
        trigger: "rebase_failed",
        conflictFiles: ["src/auth/handler.ts", "db/migrations/001.sql"],
        shortId: "t3",
      });

      expect(result).toBeNull();
    });

    it("returns manual_review when attemptCount >= 4", () => {
      const result = quickAssess({
        taskId: "t4",
        trigger: "agent_completed",
        attemptCount: 4,
        shortId: "t4",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("manual_review");
      expect(result.reason).toContain("4 attempts");
    });

    it("returns new_attempt when sessionRetries >= 3", () => {
      const result = quickAssess({
        taskId: "t5",
        trigger: "agent_completed",
        sessionRetries: 3,
        agentType: "codex",
        shortId: "t5",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("new_attempt");
      expect(result.agentType).toBe("copilot");
    });

    it("switches agent type from copilot to codex on session retry exhaustion", () => {
      const result = quickAssess({
        taskId: "t6",
        trigger: "agent_completed",
        sessionRetries: 3,
        agentType: "copilot",
        shortId: "t6",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("new_attempt");
      expect(result.agentType).toBe("codex");
    });

    it("returns reprompt_same for pr_merged_downstream without rebase error", () => {
      const result = quickAssess({
        taskId: "t7",
        trigger: "pr_merged_downstream",
        upstreamBranch: "main",
        shortId: "t7",
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("reprompt_same");
      expect(result.prompt).toContain("git fetch origin");
      expect(result.prompt).toContain("main");
    });

    it("returns null for triggers that need SDK assessment", () => {
      const result = quickAssess({
        taskId: "t8",
        trigger: "idle_detected",
        shortId: "t8",
      });

      expect(result).toBeNull();
    });

    it("prioritizes max-attempts over session-retries", () => {
      const result = quickAssess({
        taskId: "t9",
        trigger: "agent_failed",
        attemptCount: 5,
        sessionRetries: 4,
        shortId: "t9",
      });

      // attemptCount check runs first in the implementation
      expect(result.action).toBe("manual_review");
    });

    it("returns manual_review when objective constraints are blocked", () => {
      const result = quickAssess({
        taskId: "t10",
        trigger: "agent_completed",
        shortId: "t10",
        objectiveFrame: {
          constraintState: {
            status: "blocked",
            blocked: true,
            approvalPending: true,
            violations: [
              {
                constraintId: "approval",
                message: "Approval pending",
                blocking: true,
              },
            ],
          },
        },
      });

      expect(result).not.toBeNull();
      expect(result.action).toBe("manual_review");
      expect(result.reason).toContain("blocked");
      expect(result.rawOutput).toBe("quick_assess:constraint_blocked");
    });
  });

  // ── assessTask ───────────────────────────────────────────────────────────

  describe("assessTask", () => {
    it("returns parsed decision from execCodex output", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse:
          '{"action":"reprompt_same","prompt":"Fix the lint error","reason":"small fix needed"}',
      });

      const result = await assessTask(
        {
          taskId: "task-001",
          taskTitle: "Fix linting",
          trigger: "agent_completed",
          shortId: "task-001",
        },
        { execCodex, logDir: null },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("reprompt_same");
      expect(result.prompt).toBe("Fix the lint error");
      expect(result.reason).toBe("small fix needed");
      expect(execCodex).toHaveBeenCalledTimes(1);
    });

    it("falls back to manual_review on invalid action in response", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"banana","reason":"??"}',
      });

      const result = await assessTask(
        {
          taskId: "task-002",
          taskTitle: "Test task",
          trigger: "rebase_failed",
          shortId: "task-002",
        },
        { execCodex, logDir: null },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("manual_review");
      expect(result.reason).toContain("Could not parse");
    });

    it("deduplicates repeated assessments within cooldown window", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"wait","waitSeconds":60,"reason":"CI running"}',
      });

      const ctx = {
        taskId: "task-003",
        taskTitle: "Dedup test",
        trigger: "ci_failed",
        shortId: "task-003",
      };

      const first = await assessTask(ctx, { execCodex, logDir: null });
      const second = await assessTask(ctx, { execCodex, logDir: null });

      expect(first.action).toBe("wait");
      expect(second.action).toBe("noop");
      expect(second.reason).toBe("dedup");
      expect(execCodex).toHaveBeenCalledTimes(1);
    });

    it("returns noop on execCodex failure", async () => {
      const execCodex = vi.fn().mockRejectedValue(new Error("SDK timeout"));

      const result = await assessTask(
        {
          taskId: "task-004",
          taskTitle: "Error test",
          trigger: "agent_failed",
          shortId: "task-004",
        },
        { execCodex, logDir: null },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("noop");
      expect(result.reason).toContain("SDK timeout");
    });

    it("calls onTelegram callback with decision summary", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"merge","reason":"all good"}',
      });
      const onTelegram = vi.fn();

      await assessTask(
        {
          taskId: "task-005",
          taskTitle: "Merge test",
          trigger: "agent_completed",
          shortId: "task-005",
        },
        { execCodex, logDir: null, onTelegram },
      );

      expect(onTelegram).toHaveBeenCalledTimes(1);
      const msg = onTelegram.mock.calls[0][0];
      expect(msg).toContain("merge");
      expect(msg).toContain(":check:");
    });

    it("extracts waitSeconds from decision", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse: '{"action":"wait","waitSeconds":180,"reason":"building"}',
      });

      const result = await assessTask(
        {
          taskId: "task-006",
          taskTitle: "Wait test",
          trigger: "ci_failed",
          shortId: "task-006",
        },
        { execCodex, logDir: null },
      );

      expect(result.action).toBe("wait");
      expect(result.waitSeconds).toBe(180);
    });

    it("extracts agentType from new_attempt decision", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse:
          '{"action":"new_attempt","agentType":"copilot","reason":"switch agent"}',
      });

      const result = await assessTask(
        {
          taskId: "task-007",
          taskTitle: "Switch agent",
          trigger: "agent_failed",
          shortId: "task-007",
        },
        { execCodex, logDir: null },
      );

      expect(result.action).toBe("new_attempt");
      expect(result.agentType).toBe("copilot");
    });

    it("extracts normalized debtItems from accept_with_debt decisions", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse:
          '{"action":"accept_with_debt","reason":"core flow fixed, edge cases deferred","debtItems":[{"type":"missing_functionality","severity":"high","description":"Add timeout fallback path"},{"criterion":"Load test coverage for retry lane"}]}',
      });

      const result = await assessTask(
        {
          taskId: "task-008",
          taskTitle: "Debt extract",
          trigger: "agent_completed",
          shortId: "task-008",
        },
        { execCodex, logDir: null },
      );

      expect(result.action).toBe("accept_with_debt");
      expect(Array.isArray(result.debtItems)).toBe(true);
      expect(result.debtItems.length).toBe(2);
      expect(result.debtItems[0]).toMatchObject({
        type: "missing_functionality",
        severity: "high",
      });
      expect(result.debtItems[1]).toMatchObject({
        severity: "medium",
      });
    });

    it("extracts normalized splitTasks from split_task decisions", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse:
          '{"action":"split_task","reason":"scope too broad","splitTasks":[{"title":"Implement parser core","description":"Create parser skeleton","acceptance_criteria":["Handles empty input"],"priority":"high","tags":["parser"]},{"name":"Add integration tests","acceptanceCriteria":["Covers parse success + failure"]}]}',
      });

      const result = await assessTask(
        {
          taskId: "task-009",
          taskTitle: "Split extract",
          trigger: "agent_failed",
          shortId: "task-009",
        },
        { execCodex, logDir: null },
      );

      expect(result.action).toBe("split_task");
      expect(Array.isArray(result.splitTasks)).toBe(true);
      expect(result.splitTasks.length).toBe(2);
      expect(result.splitTasks[0]).toMatchObject({
        title: "Implement parser core",
        priority: "high",
      });
      expect(result.splitTasks[1]).toMatchObject({
        title: "Add integration tests",
      });
      expect(result.splitTasks[1].acceptance_criteria).toEqual([
        "Covers parse success + failure",
      ]);
    });

    it("normalizes objectiveFrame from decision output", async () => {
      const execCodex = vi.fn().mockResolvedValue({
        finalResponse:
          '{"action":"wait","waitSeconds":120,"reason":"Need operator confirmation","objectiveFrame":{"successCriteria":[{"id":"criterion-1","title":"Gather operator approval","status":"partial","blocking":true}],"goalProgress":{"status":"in_progress","completedCriteriaCount":1,"totalCriteriaCount":2,"completionRatio":0.5},"constraintState":{"status":"blocked","blocked":true,"violations":[{"constraintId":"approval","message":"Operator approval pending","blocking":true}]},"tokenBudget":{"budgetTokens":1000,"totalTokens":950,"remainingTokens":50,"status":"near_limit"}}}',
      });

      const result = await assessTask(
        {
          taskId: "task-010",
          taskTitle: "Objective frame extract",
          trigger: "agent_completed",
          shortId: "task-010",
        },
        { execCodex, logDir: null },
      );

      expect(result.action).toBe("wait");
      expect(result.objectiveFrame).toEqual(expect.objectContaining({
        blocked: true,
        successCriteria: [
          expect.objectContaining({
            title: "Gather operator approval",
            status: "partial",
            blocking: true,
          }),
        ],
        goalProgress: expect.objectContaining({
          status: "in_progress",
          completionRatio: 0.5,
        }),
        constraintState: expect.objectContaining({
          status: "blocked",
          blocked: true,
          blockingViolationCount: 1,
        }),
        tokenBudget: expect.objectContaining({
          status: "near_limit",
          totalTokens: 950,
        }),
      }));
    });
  });
});
