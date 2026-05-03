import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionTracker } from "../infra/session-tracker.mjs";
import {
  _resetRuntimeAccumulatorForTests,
  getRuntimeStats,
} from "../infra/runtime-accumulator.mjs";

describe("session runtime telemetry", () => {
  const cleanupDirs = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    _resetRuntimeAccumulatorForTests({ cacheDir: join(tmpdir(), `bosun-runtime-reset-${Date.now()}`) });
  });

  it("propagates rich session telemetry into live summaries and completed runtime aggregates", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-runtime-telemetry-"));
    cleanupDirs.push(cacheDir);
    _resetRuntimeAccumulatorForTests({ cacheDir });

    const tracker = createSessionTracker({ persistDir: null, idleThresholdMs: 60_000 });
    tracker.startSession("task-telemetry", "Telemetry task");
    tracker.recordEvent("task-telemetry", {
      role: "user",
      content: "Please patch src/app.mjs and commit the change.",
      timestamp: "2026-03-30T10:00:00.000Z",
      turnIndex: 0,
    });
    tracker.recordEvent("task-telemetry", {
      type: "tool_call",
      name: "apply_patch",
      arguments: "*** Update File: src/app.mjs\n+export const telemetry = true;\n",
      timestamp: "2026-03-30T10:00:01.000Z",
    });
    tracker.recordEvent("task-telemetry", {
      type: "tool_result",
      output: "Patch applied.",
      timestamp: "2026-03-30T10:00:02.000Z",
    });
    tracker.recordEvent("task-telemetry", {
      type: "tool_call",
      name: "command_execution",
      arguments: "git commit -am \"telemetry\"",
      timestamp: "2026-03-30T10:00:03.000Z",
    });
    tracker.recordEvent("task-telemetry", {
      role: "assistant",
      content: "Updated src/app.mjs and committed it.\n184k/200k tokens 92%",
      timestamp: "2026-03-30T10:00:04.000Z",
      turnIndex: 0,
      meta: {
        usage: {
          inputTokens: 120,
          outputTokens: 45,
          totalTokens: 165,
        },
      },
    });

    const liveSession = tracker.listAllSessions({ includePersisted: false }).find((session) => session.taskId === "task-telemetry");
    expect(liveSession).toBeTruthy();
    expect(liveSession.status).toBe("committing");
    expect(liveSession.hasEdits).toBe(true);
    expect(liveSession.hasCommits).toBe(true);
    expect(liveSession.fileCounts.editedFiles).toBe(1);
    expect(liveSession.topTools[0]).toEqual({ name: "apply_patch", count: 1 });
    expect(liveSession.contextUsagePercent).toBe(92);
    expect(liveSession.contextPressure).toBe("high");
    expect(liveSession.runtimeHealth.state).toBe("committing");
    expect(liveSession.runtimeHealth.reasons).toContain("commits");

    tracker.endSession("task-telemetry", "completed");

    const runtimeStats = getRuntimeStats();
    expect(runtimeStats.sessionCount).toBe(1);
    expect(runtimeStats.totalInputTokens).toBe(120);
    expect(runtimeStats.totalOutputTokens).toBe(45);
    expect(runtimeStats.totalTurns).toBe(1);
    expect(runtimeStats.contextSummary.sessionsNearLimit).toBe(1);
    expect(runtimeStats.toolSummary.sessionsWithCommits).toBe(1);
    expect(runtimeStats.toolSummary.topTools[0]).toEqual({ name: "apply_patch", count: 1 });
    expect(runtimeStats.healthBuckets.completed).toBe(1);

    const completedSession = runtimeStats.completedSessions[0];
    expect(completedSession.status).toBe("completed");
    expect(completedSession.totalEvents).toBe(5);
    expect(completedSession.lastEventType).toBe("assistant");
    expect(completedSession.hasEdits).toBe(true);
    expect(completedSession.hasCommits).toBe(true);
    expect(completedSession.fileCounts.editOps).toBe(1);
    expect(completedSession.contextUsagePercent).toBe(92);
    expect(completedSession.contextPressure).toBe("high");
    expect(completedSession.runtimeHealth.state).toBe("completed");
    expect(completedSession.runtimeHealth.hasCommits).toBe(true);

    tracker.destroy();
  });
});
