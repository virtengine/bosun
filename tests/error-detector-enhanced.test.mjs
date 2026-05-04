import { describe, expect, it } from "vitest";
import {
  createErrorDetector,
  PUSH_FAILURE_PATTERNS,
  TEST_FAILURE_PATTERNS,
  LINT_FAILURE_PATTERNS,
  PERMISSION_WAIT_PATTERNS,
  EMPTY_RESPONSE_PATTERNS,
  AUTH_ERROR_PATTERNS,
  MODEL_ERROR_PATTERNS,
  CONTENT_POLICY_PATTERNS,
  CODEX_SANDBOX_PATTERNS,
} from "../infra/error-detector.mjs";

describe("error-detector enhanced methods", () => {
  describe("analyzeMessageSequence", () => {
    it("returns empty for no messages", () => {
      const detector = createErrorDetector();
      const result = detector.analyzeMessageSequence([]);
      expect(result.patterns).toEqual([]);
      expect(result.primary).toBeNull();
    });

    it("detects tool_loop pattern", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 6; i++) {
        messages.push({
          type: "tool_call",
          content: "read_file(/some/path)",
          meta: { toolName: "read_file" },
        });
      }

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("tool_loop");
      expect(result.details.tool_loop).toBeDefined();
    });

    it("detects near-identical tool_loop pattern when tool args drift only in volatile values", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "tool_call",
          content: "npm test -- --shard 101 --tmp C:/tmp/run-555111000",
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "tool_call",
          content: "npm test -- --shard 102 --tmp C:/tmp/run-555111001",
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "tool_call",
          content: "npm test -- --shard 103 --tmp C:/tmp/run-555111002",
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "tool_call",
          content: "npm test -- --shard 104 --tmp C:/tmp/run-555111003",
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "tool_call",
          content: "npm test -- --shard 105 --tmp C:/tmp/run-555111004",
          meta: { toolName: "run_in_terminal" },
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("tool_loop");
      expect(result.details.tool_loop).toContain("Near-identical");
    });

    it("detects analysis_paralysis (all reads, no writes)", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          type: "tool_call",
          content: i % 2 === 0 ? "read_file()" : "grep_search()",
          meta: { toolName: i % 2 === 0 ? "read_file" : "grep_search" },
        });
      }

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("analysis_paralysis");
    });

    it("does NOT detect analysis_paralysis when edits present", () => {
      const detector = createErrorDetector();
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({
          type: "tool_call",
          content: "read_file()",
          meta: { toolName: "read_file" },
        });
      }
      messages.push({
        type: "tool_call",
        content: "write_file()",
        meta: { toolName: "create_file" },
      });

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("analysis_paralysis");
    });

    it("detects plan_stuck pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "agent_message", content: "Here's the plan for this task..." },
        { type: "agent_message", content: "Ready to start implementing?" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("plan_stuck");
    });

    it("detects needs_clarification pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "I need clarification on which approach to take",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("needs_clarification");
    });

    it("detects false_completion pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Task complete! I've completed all the changes.",
        },
        {
          type: "tool_call",
          content: "read_file()",
          meta: { toolName: "read_file" },
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("false_completion");
    });

    it("does NOT detect false_completion when git commit is present", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Task complete! I've completed all the changes.",
        },
        {
          type: "tool_call",
          content: "git commit -m 'fix: thing'",
          meta: { toolName: "run_in_terminal" },
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("false_completion");
    });

    it("detects rate_limited pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "error",
          content: "rate limit exceeded: 429 Too Many Requests",
        },
        {
          type: "error",
          content: "rate limit: please retry after 30s",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("rate_limited");
    });

    it("detects doom_loop from near-identical assistant messages without edits", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Retrying build verification for shard 101 in temp run 555111000",
        },
        {
          type: "agent_message",
          content: "Retrying build verification for shard 102 in temp run 555111001",
        },
        {
          type: "agent_message",
          content: "Retrying build verification for shard 103 in temp run 555111002",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("doom_loop");
      expect(result.primary).toBe("doom_loop");
      expect(result.details.doom_loop).toContain("Near-identical assistant outputs");
    });

    it("returns primary pattern by priority", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "error",
          content: "rate limit exceeded: 429",
        },
        {
          type: "error",
          content: "rate limit again: 429",
        },
        {
          type: "agent_message",
          content: "Here's the plan...",
        },
        {
          type: "agent_message",
          content: "Ready to start implementing?",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      // rate_limited has higher priority than plan_stuck
      expect(result.primary).toBe("rate_limited");
    });
  });

  describe("getRecoveryPromptForAnalysis", () => {
    it("returns plan_stuck recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Fix bug", {
        primary: "plan_stuck",
        details: {},
      });

      expect(prompt).toContain("CONTINUE IMPLEMENTATION");
      expect(prompt).toContain("Fix bug");
      expect(prompt).toContain("implement immediately");
    });

    it("returns tool_loop recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Build feature", {
        primary: "tool_loop",
        details: { tool_loop: "Repeated: read_file" },
      });

      expect(prompt).toContain("BREAK THE LOOP");
    });

    it("returns doom_loop recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Build feature", {
        primary: "doom_loop",
        details: { doom_loop: "Near-identical assistant outputs repeated 3x without edits" },
      });

      expect(prompt).toContain("BREAK THE DOOM LOOP");
      expect(prompt).toContain("changes state");
    });

    it("returns analysis_paralysis recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Refactor", {
        primary: "analysis_paralysis",
        details: {},
      });

      expect(prompt).toContain("START EDITING");
    });

    it("returns needs_clarification recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "needs_clarification",
        details: {},
      });

      expect(prompt).toContain("MAKE A DECISION");
    });

    it("returns false_completion recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "false_completion",
        details: {},
      });

      expect(prompt).toContain("ACTUALLY COMPLETE");
      expect(prompt).toContain("git commit");
    });

    it("returns rate_limited recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: "rate_limited",
        details: {},
      });

      expect(prompt).toContain("RATE LIMITED");
    });

    it("returns generic prompt for null analysis", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Task", {
        primary: null,
        details: {},
      });

      expect(prompt).toContain("Continue working");
    });

    it("returns commits_no_push recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Deploy fix", {
        primary: "commits_no_push",
        details: {},
      });

      expect(prompt).toContain("PUSH YOUR COMMITS");
      expect(prompt).toContain("Deploy fix");
      expect(prompt).toContain("git push");
    });

    it("returns permission_wait recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Auth fix", {
        primary: "permission_wait",
        details: {},
      });

      expect(prompt).toContain("DO NOT WAIT");
      expect(prompt).toContain("Auth fix");
    });

    it("returns error_loop recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Bug fix", {
        primary: "error_loop",
        details: { error_loop: "Same error repeated 3x: build failed" },
      });

      expect(prompt).toContain("BREAK THE ERROR LOOP");
      expect(prompt).toContain("Bug fix");
      expect(prompt).toContain("Same error repeated 3x");
    });

    it("returns no_progress recovery prompt", () => {
      const detector = createErrorDetector();
      const prompt = detector.getRecoveryPromptForAnalysis("Feature", {
        primary: "no_progress",
        details: {},
      });

      expect(prompt).toContain("START WORKING");
      expect(prompt).toContain("Feature");
    });
  });

  // ── NEW: analyzeMessageSequence — additional behavioral patterns ──

  describe("analyzeMessageSequence — new behavioral patterns", () => {
    it("detects commits_no_push pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "tool_call",
          content: 'git commit -m "feat: add thing"',
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "agent_message",
          content: "Task is complete! All changes committed.",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("commits_no_push");
    });

    it("does NOT detect commits_no_push when push is present", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "tool_call",
          content: 'git commit -m "feat: add thing"',
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "tool_call",
          content: "git push origin main",
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "agent_message",
          content: "Task is complete!",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("commits_no_push");
    });

    it("does NOT detect commits_no_push when not claiming done", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "tool_call",
          content: 'git commit -m "wip"',
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "agent_message",
          content: "Let me continue working on the next step",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("commits_no_push");
    });

    it("detects permission_wait pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "I found the bug.",
        },
        {
          type: "agent_message",
          content: "Would you like me to fix it now?",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("permission_wait");
    });

    it("detects permission_wait with 'should I proceed'", () => {
      const detector = createErrorDetector();
      const messages = [
        {
          type: "agent_message",
          content: "Should I proceed with the fix?",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("permission_wait");
    });

    it("detects no_progress pattern", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "system", content: "Task assigned" },
        { type: "system", content: "Session started" },
        { type: "system", content: "Heartbeat" },
        { type: "system", content: "Heartbeat" },
        { type: "system", content: "Heartbeat" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("no_progress");
    });

    it("does NOT detect no_progress with tool calls", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "system", content: "Task assigned" },
        { type: "system", content: "Session started" },
        { type: "system", content: "Heartbeat" },
        { type: "tool_call", content: "read_file()", meta: { toolName: "read_file" } },
        { type: "system", content: "Heartbeat" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("no_progress");
    });

    it("detects error_loop pattern (3x same error)", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "error", content: "build failed: undefined reference to main" },
        { type: "error", content: "build failed: undefined reference to main" },
        { type: "error", content: "build failed: undefined reference to main" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).toContain("error_loop");
    });

    it("does NOT detect error_loop with different errors", () => {
      const detector = createErrorDetector();
      const messages = [
        { type: "error", content: "build failed: undefined reference to main" },
        { type: "error", content: "lint error: unused variable x" },
        { type: "error", content: "test failed: assertion error" },
      ];

      const result = detector.analyzeMessageSequence(messages);
      expect(result.patterns).not.toContain("error_loop");
    });

    it("prioritizes commits_no_push over no_progress", () => {
      const detector = createErrorDetector();
      const messages = [
        // Not enough non-tool messages for no_progress to trigger with tool calls
        {
          type: "tool_call",
          content: 'git commit -m "feat"',
          meta: { toolName: "run_in_terminal" },
        },
        {
          type: "agent_message",
          content: "Task is done and complete!",
        },
      ];

      const result = detector.analyzeMessageSequence(messages);
      // commits_no_push has higher priority than no_progress
      if (result.patterns.includes("commits_no_push")) {
        const priority = [
          "rate_limited", "doom_loop", "plan_stuck", "false_completion",
          "commits_no_push", "permission_wait", "error_loop",
          "needs_clarification", "tool_loop", "analysis_paralysis", "no_progress",
        ];
        const commitIdx = priority.indexOf("commits_no_push");
        const progressIdx = priority.indexOf("no_progress");
        expect(commitIdx).toBeLessThan(progressIdx);
      }
    });
  });

  // ── NEW: classify — new pattern groups ──

  describe("classify — new pattern groups", () => {
    it("classifies push_failure", () => {
      const detector = createErrorDetector();
      const result = detector.classify("git push failed: rejected push to main");
      expect(result.pattern).toBe("push_failure");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    });

    it("classifies pre-push hook failure as push_failure", () => {
      const detector = createErrorDetector();
      const result = detector.classify("pre-push hook failed with exit code 1");
      expect(result.pattern).toBe("push_failure");
    });

    it("classifies non-fast-forward as push_failure", () => {
      const detector = createErrorDetector();
      const result = detector.classify("error: non-fast-forward updates rejected");
      expect(result.pattern).toBe("push_failure");
    });

    it("classifies test_failure", () => {
      const detector = createErrorDetector();
      const result = detector.classify("FAIL  github.com/virtengine/pkg/test  0.5s");
      expect(result.pattern).toBe("test_failure");
    });

    it("classifies test_failure from 'tests failed'", () => {
      const detector = createErrorDetector();
      const result = detector.classify("2 tests failed in the test suite");
      expect(result.pattern).toBe("test_failure");
    });

    it("classifies lint_failure", () => {
      const detector = createErrorDetector();
      const result = detector.classify("golangci-lint error: unused variable x");
      expect(result.pattern).toBe("lint_failure");
    });

    it("classifies lint_failure from eslint", () => {
      const detector = createErrorDetector();
      const result = detector.classify("eslint error: unexpected console.log");
      expect(result.pattern).toBe("lint_failure");
    });

    it("classifies lint_failure from gofmt", () => {
      const detector = createErrorDetector();
      const result = detector.classify("gofmt differs from expected in main.go");
      expect(result.pattern).toBe("lint_failure");
    });
  });

  // ── NEW: recordError — new switch cases ──

  describe("recordError — new pattern cases", () => {
    it("returns retry_with_prompt for push_failure (first time)", () => {
      const detector = createErrorDetector();
      const result = detector.recordError("task-1", {
        pattern: "push_failure",
        confidence: 0.85,
        details: "git push rejected",
      });
      expect(result.action).toBe("retry_with_prompt");
      expect(result.prompt).toContain("git push failed");
      expect(result.errorCount).toBe(1);
    });

    it("returns manual for push_failure after 3 retries", () => {
      const detector = createErrorDetector();
      detector.recordError("task-1", { pattern: "push_failure", confidence: 0.85 });
      detector.recordError("task-1", { pattern: "push_failure", confidence: 0.85 });
      const result = detector.recordError("task-1", { pattern: "push_failure", confidence: 0.85 });
      expect(result.action).toBe("manual");
      expect(result.reason).toContain("Push failures persist");
    });

    it("returns retry_with_prompt for test_failure (first time)", () => {
      const detector = createErrorDetector();
      const result = detector.recordError("task-1", {
        pattern: "test_failure",
        confidence: 0.83,
        details: "FAIL github.com/pkg",
      });
      expect(result.action).toBe("retry_with_prompt");
      expect(result.prompt).toContain("Tests are failing");
      expect(result.errorCount).toBe(1);
    });

    it("returns manual for test_failure after 3 retries", () => {
      const detector = createErrorDetector();
      detector.recordError("task-1", { pattern: "test_failure", confidence: 0.83 });
      detector.recordError("task-1", { pattern: "test_failure", confidence: 0.83 });
      const result = detector.recordError("task-1", { pattern: "test_failure", confidence: 0.83 });
      expect(result.action).toBe("manual");
    });

    it("returns retry_with_prompt for lint_failure (first time)", () => {
      const detector = createErrorDetector();
      const result = detector.recordError("task-1", {
        pattern: "lint_failure",
        confidence: 0.82,
        details: "golangci-lint error",
      });
      expect(result.action).toBe("retry_with_prompt");
      expect(result.prompt).toContain("Linting");
      expect(result.errorCount).toBe(1);
    });

    it("returns manual for lint_failure after 3 retries", () => {
      const detector = createErrorDetector();
      detector.recordError("task-1", { pattern: "lint_failure", confidence: 0.82 });
      detector.recordError("task-1", { pattern: "lint_failure", confidence: 0.82 });
      const result = detector.recordError("task-1", { pattern: "lint_failure", confidence: 0.82 });
      expect(result.action).toBe("manual");
    });
  });

  // ── NEW: Pattern regex coverage ──

  describe("pattern regex exports", () => {
    it("PUSH_FAILURE_PATTERNS match expected strings", () => {
      const tests = [
        "git push failed to remote",
        "rejected push to main",
        "pre-push hook failed",
        "remote rejected your changes",
        "non-fast-forward update rejected",
      ];
      for (const t of tests) {
        const match = PUSH_FAILURE_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match PUSH_FAILURE_PATTERNS`).toBe(true);
      }
    });

    it("TEST_FAILURE_PATTERNS match expected strings", () => {
      const tests = [
        "FAIL  github.com/test/pkg",
        "tests failed in suite",
        "--- FAIL: TestFoo",
        "FAILED assertion check",
        "Expected 42 but got 0",
      ];
      for (const t of tests) {
        const match = TEST_FAILURE_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match TEST_FAILURE_PATTERNS`).toBe(true);
      }
    });

    it("LINT_FAILURE_PATTERNS match expected strings", () => {
      const tests = [
        "golangci-lint error in file.go",
        "eslint error: no-unused-vars",
        "lint failed for module",
        "gofmt differs from expected",
      ];
      for (const t of tests) {
        const match = LINT_FAILURE_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match LINT_FAILURE_PATTERNS`).toBe(true);
      }
    });

    it("PERMISSION_WAIT_PATTERNS match expected strings", () => {
      const tests = [
        "waiting for your input",
        "please confirm the changes",
        "should I proceed now?",
        "what would you prefer to do?",
        "I need your confirmation",
      ];
      for (const t of tests) {
        const match = PERMISSION_WAIT_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match PERMISSION_WAIT_PATTERNS`).toBe(true);
      }
    });

    it("EMPTY_RESPONSE_PATTERNS match expected strings", () => {
      const tests = [
        "   ",
        "no output from agent",
        "agent produced no output",
      ];
      for (const t of tests) {
        const match = EMPTY_RESPONSE_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match EMPTY_RESPONSE_PATTERNS`).toBe(true);
      }
    });

    // ── Auth Error Patterns ───────────────────────────────────────────
    it("AUTH_ERROR_PATTERNS match API key errors", () => {
      const tests = [
        "invalid api key provided",
        "Error: authentication_error",
        "401 Unauthorized",
        "403 Forbidden",
        "billing_hard_limit_reached",
        "insufficient_quota",
        "invalid credentials for account",
        "access denied to resource",
        "OPENAI_API_KEY is invalid",
        "permission_error: not allowed",
      ];
      for (const t of tests) {
        const match = AUTH_ERROR_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match AUTH_ERROR_PATTERNS`).toBe(true);
      }
    });

    it("AUTH_ERROR_PATTERNS do NOT match transient errors", () => {
      const nonMatches = [
        "500 Internal Server Error",
        "ECONNREFUSED",
        "rate limit exceeded",
        "session expired",
      ];
      for (const t of nonMatches) {
        const match = AUTH_ERROR_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to NOT match AUTH_ERROR_PATTERNS`).toBe(false);
      }
    });

    // ── Model Error Patterns ──────────────────────────────────────────
    it("MODEL_ERROR_PATTERNS match model-related errors", () => {
      const tests = [
        "model gpt-5 not found",
        "model not supported in this region",
        "invalid model specified",
        "model does not exist: claude-4-opus",
        "not_found_error: model xyz not available",
        "model claude-2.0 deprecated",
        "engine not found for deployment",
      ];
      for (const t of tests) {
        const match = MODEL_ERROR_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match MODEL_ERROR_PATTERNS`).toBe(true);
      }
    });

    // ── Content Policy Patterns ───────────────────────────────────────
    it("CONTENT_POLICY_PATTERNS match safety violations", () => {
      const tests = [
        "content_policy_violation",
        "content filter triggered",
        "safety_system blocked output",
        "flagged content in request",
        "output blocked by moderation",
        "responsible ai policy violation",
      ];
      for (const t of tests) {
        const match = CONTENT_POLICY_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match CONTENT_POLICY_PATTERNS`).toBe(true);
      }
    });

    // ── Codex Sandbox Patterns ────────────────────────────────────────
    it("CODEX_SANDBOX_PATTERNS match sandbox errors", () => {
      const tests = [
        "sandbox failed to initialize",
        "bwrap error: permission denied",
        "bubblewrap error creating namespace",
        "EPERM: operation not permitted, mkdir",
        "writable_roots misconfigured",
        "codex segfault signal 11",
        "codex killed by OOM",
        "namespace error: ENOSYS",
      ];
      for (const t of tests) {
        const match = CODEX_SANDBOX_PATTERNS.some((re) => re.test(t));
        expect(match, `Expected "${t}" to match CODEX_SANDBOX_PATTERNS`).toBe(true);
      }
    });
  });

  // ── recordError for new pattern types ─────────────────────────────

  describe("recordError new pattern types", () => {
    it("auth_error returns block action immediately (no retries)", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("invalid api key");
      expect(classification.pattern).toBe("auth_error");
      const result = detector.recordError("task-auth-1", classification);
      expect(result.action).toBe("block");
    });

    it("model_error returns block action immediately", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("model gpt-5 not found");
      expect(classification.pattern).toBe("model_error");
      const result = detector.recordError("task-model-1", classification);
      expect(result.action).toBe("block");
    });

    it("content_policy returns block action immediately", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("content_policy_violation in response");
      expect(classification.pattern).toBe("content_policy");
      const result = detector.recordError("task-cp-1", classification);
      expect(result.action).toBe("block");
    });

    it("codex_sandbox returns retry_with_prompt on first failure", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("sandbox failed to start");
      expect(classification.pattern).toBe("codex_sandbox");
      const result = detector.recordError("task-sandbox-1", classification);
      expect(result.action).toBe("retry_with_prompt");
      expect(result.prompt).toBeDefined();
    });

    it("codex_sandbox returns block after 2 failures", () => {
      const detector = createErrorDetector();
      const c1 = detector.classify("sandbox failed");
      detector.recordError("task-sandbox-2", c1);
      const c2 = detector.classify("sandbox failed again");
      const result = detector.recordError("task-sandbox-2", c2);
      expect(result.action).toBe("block");
    });

    it("auth_error via 401 Unauthorized classifies correctly", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("HTTP 401 Unauthorized - check your API key");
      expect(classification.pattern).toBe("auth_error");
      const result = detector.recordError("task-401", classification);
      expect(result.action).toBe("block");
    });

    it("auth_error via insufficient_quota classifies correctly", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("Error: insufficient_quota - billing limit reached");
      expect(classification.pattern).toBe("auth_error");
      const result = detector.recordError("task-quota", classification);
      expect(result.action).toBe("block");
    });

    it("overloaded_error classifies as api_error (transient)", () => {
      const detector = createErrorDetector();
      const classification = detector.classify("overloaded_error: server is busy");
      expect(classification.pattern).toBe("api_error");
      // api_error action depends on retry count
    });
  });
});
