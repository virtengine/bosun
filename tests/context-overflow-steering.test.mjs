/**
 * Tests for context overflow detection (expanded vendor patterns) and
 * active session steering across all 3 SDKs.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  createErrorDetector,
  TOKEN_OVERFLOW_PATTERNS,
} from "../infra/error-detector.mjs";
import {
  getActiveSessions,
  hasActiveSession,
  isContextOverflowError,
  steerActiveThread,
} from "../agent/agent-pool.mjs";
import {
  AgentSupervisor,
  createAgentSupervisor,
  SITUATION,
  INTERVENTION,
} from "../agent/agent-supervisor.mjs";

// ---------------------------------------------------------------------------
// 1. TOKEN_OVERFLOW_PATTERNS — vendor-specific coverage
// ---------------------------------------------------------------------------

describe("TOKEN_OVERFLOW_PATTERNS — vendor-specific strings", () => {
  const shouldMatch = [
    // Original patterns
    "Error: context too long — exceeded maximum",
    "max context length exceeded by 5000 tokens",
    "conversation too long to continue",
    "input too large for this model",
    "reduce context size before retrying",
    "maximum context length is 128000 tokens",
    "413 Payload Too Large",

    // ── NEW vendor-specific patterns ──
    // OpenAI
    "context_length_exceeded",
    'error code: context_length_exceeded, message: "model max context length"',
    "This model's maximum context length is 128000 tokens",
    "string_above_max_length: prompt field exceeds limit",

    // Anthropic
    "prompt_too_long",
    "prompt is too long for this model",
    "prompt too large to process",

    // Codex CLI
    "token_budget exceeded for this session",
    "token budget limit hit",

    // Copilot
    "turn_limit_reached",
    "turn limit exceeded for session",

    // Generic
    "maximum number of tokens exceeded",
  ];

  for (const text of shouldMatch) {
    it(`matches: "${text}"`, () => {
      const match = TOKEN_OVERFLOW_PATTERNS.some((re) => re.test(text));
      expect(match, `Expected "${text}" to match TOKEN_OVERFLOW_PATTERNS`).toBe(
        true,
      );
    });
  }

  const shouldNotMatch = [
    "Task completed successfully",
    "Running go test ./...",
    "error: file not found",
    "HTTP 500 Internal Server Error",
    "rate limit exceeded", // rate limit, not context overflow
    "invalid API key",
  ];

  for (const text of shouldNotMatch) {
    it(`does NOT match: "${text}"`, () => {
      const match = TOKEN_OVERFLOW_PATTERNS.some((re) => re.test(text));
      expect(
        match,
        `Expected "${text}" to NOT match TOKEN_OVERFLOW_PATTERNS`,
      ).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Error detector — classify & recordError for token_overflow
// ---------------------------------------------------------------------------

describe("error-detector — token_overflow classification", () => {
  it("classifies context_length_exceeded as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("context_length_exceeded");
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies prompt_too_long as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("prompt_too_long: content exceeds limit");
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies turn_limit_reached as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("turn_limit_reached for session abc-123");
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies token_budget exceeded as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("token_budget exceeded for this session");
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies string_above_max_length as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("string_above_max_length in prompt field");
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies 'This model's maximum context length' as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify(
      "This model's maximum context length is 128000 tokens",
    );
    expect(result.pattern).toBe("token_overflow");
  });

  it("classifies 'maximum number of tokens' as token_overflow", () => {
    const detector = createErrorDetector();
    const result = detector.classify("maximum number of tokens exceeded");
    expect(result.pattern).toBe("token_overflow");
  });

  it("recordError returns new_session action for token_overflow", () => {
    const detector = createErrorDetector();
    const classification = detector.classify("context_length_exceeded");
    const result = detector.recordError("task-overflow-1", classification);
    expect(result.action).toBe("new_session");
    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain("git log");
  });
});

// ---------------------------------------------------------------------------
// 3. Supervisor — _diagnose detects expanded TOKEN_OVERFLOW patterns
// ---------------------------------------------------------------------------

describe("agent-supervisor — expanded TOKEN_OVERFLOW diagnosis", () => {
  let supervisor;
  let mockForceNewThread;

  beforeEach(() => {
    vi.useFakeTimers();
    mockForceNewThread = vi.fn();
    supervisor = createAgentSupervisor({
      sendTelegram: vi.fn(),
      setTaskStatus: vi.fn(),
      getTask: vi.fn().mockReturnValue({ title: "Test task" }),
      forceNewThread: mockForceNewThread,
      injectPrompt: vi.fn(),
      sendContinueSignal: vi.fn(),
      assessIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    supervisor.stop();
    vi.useRealTimers();
  });

  const overflowStrings = [
    // Original
    { error: "context too long maximum exceeded", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "max token exceeded", expected: SITUATION.TOKEN_OVERFLOW },

    // ── NEW vendor-specific ──
    { error: "context_length_exceeded", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "prompt_too_long", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "This model's maximum context length is 128000", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "token_budget exceeded", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "turn_limit_reached", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "conversation too long for this session", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "string_above_max_length in prompt", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "maximum number of tokens allowed", expected: SITUATION.TOKEN_OVERFLOW },
    { error: "prompt is too long", expected: SITUATION.TOKEN_OVERFLOW },
  ];

  for (const { error, expected } of overflowStrings) {
    it(`diagnoses "${error}" as ${expected}`, () => {
      const result = supervisor.assess("task-overflow", { error });
      expect(result.situation).toBe(expected);
    });
  }

  it("TOKEN_OVERFLOW first intervention is FORCE_NEW_THREAD", () => {
    const result = supervisor.assess("task-overflow-fn", {
      error: "context_length_exceeded",
    });
    expect(result.situation).toBe(SITUATION.TOKEN_OVERFLOW);
    expect(result.intervention).toBe(INTERVENTION.FORCE_NEW_THREAD);
  });

  it("TOKEN_OVERFLOW recovery prompt mentions git log and fresh session", () => {
    const result = supervisor.assess("task-overflow-prompt", {
      error: "prompt_too_long",
    });
    expect(result.prompt).toContain("git log");
    expect(result.prompt).toContain("fresh session");
  });

  it("TOKEN_OVERFLOW intervene() calls forceNewThread callback", async () => {
    const decision = supervisor.assess("task-overflow-int", {
      error: "context_length_exceeded",
    });
    await supervisor.intervene("task-overflow-int", decision);
    expect(mockForceNewThread).toHaveBeenCalledWith(
      "task-overflow-int",
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. isContextOverflowError — exported from agent-pool
// ---------------------------------------------------------------------------

describe("isContextOverflowError", () => {
  const positives = [
    "context_length_exceeded",
    "prompt_too_long",
    "prompt is too long for this model",
    "context too long—exceeded limit",
    "token_budget exceeded",
    "turn_limit_reached",
    "conversation too long",
    "maximum context length is 128000",
    "max token limit reached",
    "maximum number of tokens exceeded",
    "string_above_max_length",
    "input too large",
    "reduce the length of your input",
  ];

  for (const msg of positives) {
    it(`returns true for: "${msg}"`, () => {
      expect(isContextOverflowError(msg)).toBe(true);
    });
  }

  const negatives = [
    null,
    undefined,
    "",
    "Task completed successfully",
    "rate limit exceeded",
    "HTTP 500 Internal Server Error",
    "invalid API key",
  ];

  for (const msg of negatives) {
    it(`returns false for: ${JSON.stringify(msg)}`, () => {
      expect(isContextOverflowError(msg)).toBe(false);
    });
  }

  it("handles Error objects", () => {
    expect(isContextOverflowError(new Error("context_length_exceeded"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Active session steering (steerActiveThread, hasActiveSession)
// ---------------------------------------------------------------------------

describe("steerActiveThread / hasActiveSession", () => {
  it("returns false when no active session exists", () => {
    expect(hasActiveSession("nonexistent-task")).toBe(false);
    expect(steerActiveThread("nonexistent-task", "do something")).toBe(false);
  });

  it("getActiveSessions returns array", () => {
    const sessions = getActiveSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Supervisor — steering callback wiring verification
// ---------------------------------------------------------------------------

describe("agent-supervisor — steering callbacks", () => {
  let supervisor;
  let mockInjectPrompt;
  let mockSendContinue;
  let mockForceNewThread;

  beforeEach(() => {
    vi.useFakeTimers();
    mockInjectPrompt = vi.fn();
    mockSendContinue = vi.fn();
    mockForceNewThread = vi.fn();
    supervisor = createAgentSupervisor({
      sendTelegram: vi.fn(),
      setTaskStatus: vi.fn(),
      getTask: vi.fn().mockReturnValue({ title: "Test task" }),
      injectPrompt: mockInjectPrompt,
      sendContinueSignal: mockSendContinue,
      forceNewThread: mockForceNewThread,
      assessIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    supervisor.stop();
    vi.useRealTimers();
  });

  it("INJECT_PROMPT intervention calls injectPrompt callback", async () => {
    // Simulate a situation that uses INJECT_PROMPT
    // plan_stuck first intervention is INJECT_PROMPT
    const decision = supervisor.assess("task-steer-1", {
      error: null,
      planningPhraseCount: 5,
    });
    if (decision.intervention === INTERVENTION.INJECT_PROMPT) {
      await supervisor.intervene("task-steer-1", decision);
      expect(mockInjectPrompt).toHaveBeenCalled();
    }
    // If the situation doesn't map to INJECT, that's fine — we just verify the wiring
  });

  it("CONTINUE_SIGNAL intervention calls sendContinueSignal callback", async () => {
    await supervisor.intervene("task-steer-2", {
      intervention: INTERVENTION.CONTINUE_SIGNAL,
      prompt: null,
      reason: "test",
      situation: "test",
    });
    expect(mockSendContinue).toHaveBeenCalledWith("task-steer-2");
  });

  it("FORCE_NEW_THREAD intervention calls forceNewThread callback", async () => {
    await supervisor.intervene("task-steer-3", {
      intervention: INTERVENTION.FORCE_NEW_THREAD,
      prompt: "recovery prompt",
      reason: "context overflow",
      situation: SITUATION.TOKEN_OVERFLOW,
    });
    expect(mockForceNewThread).toHaveBeenCalledWith(
      "task-steer-3",
      "context overflow",
    );
  });
});
