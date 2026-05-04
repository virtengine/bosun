import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

async function loadRuntimeAccumulatorModule() {
  vi.resetModules();
  vi.doUnmock("node:fs");
  return import("../infra/runtime-accumulator.mjs");
}

describe("runtime-accumulator", () => {
  it("accumulates completed sessions monotonically across 3 restarts with 2 sessions each", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-accumulator-"));
    const taskId = "task-restart-accumulator";
    const {
      _resetRuntimeAccumulatorForTests,
      addCompletedSession,
      getRuntimeStats,
      getSessionAccumulatorLogPath,
      getTaskLifetimeTotals,
    } = await loadRuntimeAccumulatorModule();

    try {
      let expectedAttempts = 0;
      let expectedTokenCount = 0;
      let expectedInputTokens = 0;
      let expectedOutputTokens = 0;
      let expectedDurationMs = 0;
      let previousTotals = null;

      for (let restart = 0; restart < 3; restart += 1) {
        _resetRuntimeAccumulatorForTests({ cacheDir });

        const beforeTotals = getTaskLifetimeTotals(taskId);
        expect(beforeTotals.attemptsCount).toBe(expectedAttempts);
        expect(beforeTotals.tokenCount).toBe(expectedTokenCount);
        expect(beforeTotals.durationMs).toBe(expectedDurationMs);

        for (let index = 0; index < 2; index += 1) {
          const startedAt = Date.now() + restart * 10_000 + index * 100;
          const durationMs = 8_000 + restart * 1_000 + index * 500;
          const inputTokens = 1_000 + restart * 100 + index * 10;
          const outputTokens = 400 + restart * 50 + index * 5;
          const tokenCount = inputTokens + outputTokens;

          addCompletedSession({
            id: `${taskId}-session-${restart}-${index}`,
            sessionId: `${taskId}-session-${restart}-${index}`,
            sessionKey: `${taskId}:restart-${restart}:session-${index}`,
            taskId,
            taskTitle: "Restart accumulation test",
            startedAt,
            endedAt: startedAt + durationMs,
            durationMs,
            tokenCount,
            inputTokens,
            outputTokens,
            status: "completed",
          });

          const currentLines = readFileSync(getSessionAccumulatorLogPath(), "utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          expect(currentLines).toHaveLength(expectedAttempts + 1);

          expectedAttempts += 1;
          expectedTokenCount += tokenCount;
          expectedInputTokens += inputTokens;
          expectedOutputTokens += outputTokens;
          expectedDurationMs += durationMs;

          const totals = getTaskLifetimeTotals(taskId);
          expect(totals.attemptsCount).toBe(expectedAttempts);
          expect(totals.tokenCount).toBe(expectedTokenCount);
          expect(totals.inputTokens).toBe(expectedInputTokens);
          expect(totals.outputTokens).toBe(expectedOutputTokens);
          expect(totals.durationMs).toBe(expectedDurationMs);

          if (previousTotals) {
            expect(totals.attemptsCount).toBeGreaterThanOrEqual(previousTotals.attemptsCount);
            expect(totals.tokenCount).toBeGreaterThanOrEqual(previousTotals.tokenCount);
            expect(totals.durationMs).toBeGreaterThanOrEqual(previousTotals.durationMs);
          }
          previousTotals = totals;
        }
      }

      _resetRuntimeAccumulatorForTests({ cacheDir });
      const restoredTotals = getTaskLifetimeTotals(taskId);
      expect(restoredTotals.attemptsCount).toBe(6);
      expect(restoredTotals.tokenCount).toBe(expectedTokenCount);
      expect(restoredTotals.inputTokens).toBe(expectedInputTokens);
      expect(restoredTotals.outputTokens).toBe(expectedOutputTokens);
      expect(restoredTotals.durationMs).toBe(expectedDurationMs);

      const runtimeStats = getRuntimeStats();
      expect(runtimeStats.sessionCount).toBe(6);
      expect(runtimeStats.runtimeMs).toBe(expectedDurationMs);
      expect(runtimeStats.lifetimeTotals).toEqual({
        attemptsCount: 6,
        tokenCount: expectedTokenCount,
        inputTokens: expectedInputTokens,
        outputTokens: expectedOutputTokens,
        durationMs: expectedDurationMs,
      });

      const logPath = getSessionAccumulatorLogPath();
      const lines = readFileSync(logPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      expect(lines).toHaveLength(6);
    } finally {
      _resetRuntimeAccumulatorForTests();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("emits a typed session-accumulated event with updated per-task totals", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-accumulator-events-"));
    const taskId = "task-session-event";
    const payloads = [];
    const {
      _resetRuntimeAccumulatorForTests,
      addSessionAccumulationListener,
      addCompletedSession,
    } = await loadRuntimeAccumulatorModule();

    try {
      _resetRuntimeAccumulatorForTests({ cacheDir });
      const unsubscribe = addSessionAccumulationListener((payload) => payloads.push(payload));

      addCompletedSession({
        id: `${taskId}-session-1`,
        sessionId: `${taskId}-session-1`,
        sessionKey: `${taskId}:session-1`,
        taskId,
        taskTitle: "Event payload test",
        startedAt: 1_000,
        endedAt: 3_500,
        durationMs: 2_500,
        tokenCount: 300,
        inputTokens: 200,
        outputTokens: 100,
        status: "completed",
      });
      unsubscribe();

      expect(payloads).toHaveLength(1);
      expect(payloads[0]).toMatchObject({
        type: "session-accumulated",
        taskId,
        session: {
          taskId,
          tokenCount: 300,
          inputTokens: 200,
          outputTokens: 100,
          durationMs: 2_500,
        },
        totals: {
          taskId,
          attemptsCount: 1,
          tokenCount: 300,
          inputTokens: 200,
          outputTokens: 100,
          durationMs: 2_500,
        },
      });
    } finally {
      _resetRuntimeAccumulatorForTests();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("preserves turn count and timeline details on completed session records", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-accumulator-turns-"));
    const taskId = "task-session-turns";
    const {
      _resetRuntimeAccumulatorForTests,
      addCompletedSession,
      getRuntimeStats,
    } = await loadRuntimeAccumulatorModule();

    try {
      _resetRuntimeAccumulatorForTests({ cacheDir });

      const record = addCompletedSession({
        id: `${taskId}-session-1`,
        sessionId: `${taskId}-session-1`,
        sessionKey: `${taskId}:session-1`,
        taskId,
        taskTitle: "Turn persistence test",
        startedAt: 1_000,
        endedAt: 6_000,
        durationMs: 5_000,
        tokenCount: 180,
        inputTokens: 120,
        outputTokens: 60,
        turnCount: 2,
        turns: [
          { turnIndex: 0, durationMs: 2_000, totalTokens: 75, status: "completed" },
          { turnIndex: 1, durationMs: 3_000, totalTokens: 105, status: "completed" },
        ],
        status: "completed",
      });

      expect(record).toEqual(expect.objectContaining({
        turnCount: 2,
        turns: [
          expect.objectContaining({ turnIndex: 0, totalTokens: 75 }),
          expect.objectContaining({ turnIndex: 1, totalTokens: 105 }),
        ],
      }));

      _resetRuntimeAccumulatorForTests({ cacheDir });
      const restoredStats = getRuntimeStats();
      expect(restoredStats.completedSessions[0]).toEqual(expect.objectContaining({
        taskId,
        turnCount: 2,
        turns: [
          expect.objectContaining({ turnIndex: 0, totalTokens: 75 }),
          expect.objectContaining({ turnIndex: 1, totalTokens: 105 }),
        ],
      }));
      expect(restoredStats.lifetimeTotals).toEqual(expect.objectContaining({
        attemptsCount: 1,
        tokenCount: 180,
        inputTokens: 120,
        outputTokens: 60,
        durationMs: 5_000,
      }));
    } finally {
      _resetRuntimeAccumulatorForTests();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("projects completed session observability metrics into runtime aggregates", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-accumulator-metrics-"));
    const {
      _resetRuntimeAccumulatorForTests,
      addCompletedSession,
      getRuntimeStats,
    } = await loadRuntimeAccumulatorModule();

    try {
      _resetRuntimeAccumulatorForTests({ cacheDir });

      addCompletedSession({
        id: "task-observe-1-session-1",
        sessionId: "task-observe-1-session-1",
        sessionKey: "task-observe-1:session-1",
        taskId: "task-observe-1",
        taskTitle: "Aggregate observability metrics",
        startedAt: 1_000,
        endedAt: 5_000,
        durationMs: 4_000,
        tokenCount: 120,
        inputTokens: 70,
        outputTokens: 50,
        turnCount: 3,
        toolCalls: 5,
        toolResults: 4,
        errors: 1,
        hasEdits: true,
        hasCommits: false,
        fileCounts: { editOps: 2 },
        topTools: [
          { name: "shell.exec", count: 3 },
          { name: "apply_patch", count: 1 },
        ],
        recentActions: [
          { type: "tool", label: "Ran shell.exec", level: "info", timestamp: "2026-03-31T07:00:00.000Z" },
        ],
        contextWindow: { usedTokens: 800, totalTokens: 1_000 },
        runtimeHealth: {
          state: "implementation_done_commit_blocked",
          severity: "warning",
          live: false,
          idleMs: 50,
          toolCalls: 5,
          toolResults: 4,
          errors: 1,
          hasEdits: true,
        },
        status: "implementation_done_commit_blocked",
      });

      addCompletedSession({
        id: "task-observe-2-session-1",
        sessionId: "task-observe-2-session-1",
        sessionKey: "task-observe-2:session-1",
        taskId: "task-observe-2",
        taskTitle: "Aggregate observability metrics follow-up",
        startedAt: 6_000,
        endedAt: 11_000,
        durationMs: 5_000,
        tokenCount: 200,
        inputTokens: 120,
        outputTokens: 80,
        turnCount: 2,
        toolCalls: 2,
        toolResults: 1,
        errors: 2,
        hasEdits: false,
        hasCommits: true,
        fileCounts: { editOps: 1 },
        topTools: [
          { name: "apply_patch", count: 2 },
          { name: "mcp.search", count: 1 },
        ],
        recentActions: [
          { type: "approval", label: "Approved patch", level: "info", timestamp: "2026-03-31T07:05:00.000Z" },
          { type: "retry", label: "Retried tool call", level: "warning", timestamp: "2026-03-31T07:06:00.000Z" },
        ],
        contextUsagePercent: 92,
        runtimeHealth: {
          state: "failed",
          severity: "error",
          live: false,
          idleMs: 10,
          toolCalls: 2,
          toolResults: 1,
          errors: 2,
          hasCommits: true,
        },
        status: "failed",
      });

      _resetRuntimeAccumulatorForTests({ cacheDir });
      const stats = getRuntimeStats();

      expect(stats.sessionCount).toBe(2);
      expect(stats.totalTurns).toBe(5);
      expect(stats.healthBuckets).toEqual(expect.objectContaining({
        completed: 1,
        failed: 1,
      }));
      expect(stats.severityBuckets).toEqual(expect.objectContaining({
        warning: 1,
        error: 1,
      }));
      expect(stats.toolSummary).toEqual(expect.objectContaining({
        toolCalls: 7,
        toolResults: 5,
        errors: 3,
        editOps: 3,
        commitOps: 1,
        sessionsWithEdits: 1,
        sessionsWithCommits: 1,
      }));
      expect(stats.toolSummary.topTools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "shell.exec", count: 3 }),
        expect.objectContaining({ name: "apply_patch", count: 3 }),
        expect.objectContaining({ name: "mcp.search", count: 1 }),
      ]));
      expect(stats.contextSummary).toEqual(expect.objectContaining({
        sessionCount: 2,
        maxUsagePercent: 92,
        avgUsagePercent: 86,
        sessionsNearLimit: 1,
        sessionsHighPressure: 2,
      }));
      expect(stats.completedSessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: "task-observe-1",
          topTools: [
            expect.objectContaining({ name: "shell.exec", count: 3 }),
            expect.objectContaining({ name: "apply_patch", count: 1 }),
          ],
          recentActions: [
            expect.objectContaining({ type: "tool", label: "Ran shell.exec" }),
          ],
          contextWindow: expect.objectContaining({ usedTokens: 800, totalTokens: 1_000, percent: 80 }),
          runtimeHealth: expect.objectContaining({ state: "completed", severity: "warning" }),
        }),
        expect.objectContaining({
          taskId: "task-observe-2",
          recentActions: [
            expect.objectContaining({ type: "approval", label: "Approved patch" }),
            expect.objectContaining({ type: "retry", label: "Retried tool call" }),
          ],
          runtimeHealth: expect.objectContaining({ state: "failed", severity: "error" }),
        }),
      ]));
    } finally {
      _resetRuntimeAccumulatorForTests();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
