#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { createHarnessObservabilitySpine, resetHarnessObservabilitySpinesForTests } from "../infra/session-telemetry.mjs";
import {
  runProcessWithBosunHotPathExec,
  watchPathsWithBosunHotPathExec,
} from "../lib/hot-path-runtime.mjs";

const SESSION_COUNT = Math.max(4, Number.parseInt(process.env.BOSUN_BENCH_SESSIONS || "12", 10) || 12);
const EVENTS_PER_SESSION = Math.max(10, Number.parseInt(process.env.BOSUN_BENCH_EVENTS_PER_SESSION || "180", 10) || 180);
const TOOL_CALLS = Math.max(4, Number.parseInt(process.env.BOSUN_BENCH_TOOL_CALLS || "48", 10) || 48);
const WORKFLOW_RUNS = Math.max(
  2,
  Number.parseInt(
    process.env.BOSUN_BENCH_WORKFLOW_RUNS || String(Math.max(2, Math.floor(SESSION_COUNT / 2))),
    10,
  ) || Math.max(2, Math.floor(SESSION_COUNT / 2)),
);

function buildEvent(sessionIndex, eventIndex) {
  const taskId = `bench-task-${sessionIndex}`;
  const sessionId = `bench-session-${sessionIndex}`;
  const runId = `bench-run-${sessionIndex}`;
  const cycle = eventIndex % 3;
  if (cycle === 0) {
    return {
      eventType: "provider.turn.completed",
      source: "agent-pool",
      category: "provider",
      taskId,
      sessionId,
      runId,
      providerId: "openai-api",
      modelId: "gpt-5.4",
      status: "completed",
      latencyMs: 140 + (eventIndex % 11),
      tokenUsage: {
        inputTokens: 80 + eventIndex,
        outputTokens: 40 + (eventIndex % 17),
        totalTokens: 120 + eventIndex + (eventIndex % 17),
      },
    };
  }
  if (cycle === 1) {
    return {
      eventType: "workflow.node.complete",
      source: "workflow-engine",
      category: "workflow",
      taskId,
      sessionId,
      runId,
      workflowId: "bench-workflow",
      workflowName: "Harness Bench",
      status: "completed",
      durationMs: 25 + (eventIndex % 9),
      summary: "workflow node completed",
    };
  }
  return {
    eventType: "tool.execution.completed",
    source: "agent-event-bus",
    category: "tool",
    taskId,
    sessionId,
    runId,
    toolName: "apply_patch",
    status: "completed",
    retryCount: eventIndex % 2,
    durationMs: 12 + (eventIndex % 7),
    summary: "tool run completed",
  };
}

async function main() {
  resetHarnessObservabilitySpinesForTests();
  const tempDir = mkdtempSync(join(tmpdir(), "bosun-hotpath-bench-"));
  const watchedPath = join(tempDir, "watch.txt");
  writeFileSync(watchedPath, "before", "utf8");
  const telemetry = createHarnessObservabilitySpine({
    persist: false,
    maxInMemoryEvents: (SESSION_COUNT * EVENTS_PER_SESSION) + (TOOL_CALLS * 3) + (WORKFLOW_RUNS * 6),
  });
  let toolEventCount = 0;
  const toolOrchestrator = createToolOrchestrator({
    truncation: {
      maxChars: 512,
      tailChars: 72,
    },
    onEvent: (event) => {
      toolEventCount += 1;
      telemetry.recordEvent({
        timestamp: new Date().toISOString(),
        eventType: `tool.${event.type || "event"}`,
        source: "tool-orchestrator",
        category: "tool",
        taskId: event.context?.taskId || event.context?.sessionId || "bench-tool-task",
        sessionId: event.context?.sessionId || "bench-tool-session",
        runId: event.context?.runId || null,
        toolName: event.toolName || "bench_tool",
        status: event.status || (event.type === "tool_execution_error"
          ? "failed"
          : event.type === "tool_execution_end"
            ? "completed"
            : "running"),
        retryCount: Number.isFinite(Number(event.attemptCount))
          ? Math.max(0, Number(event.attemptCount) - 1)
          : undefined,
        payload: {
          executionId: event.executionId || null,
          hotPath: event.hotPath || null,
          truncation: event.truncation || null,
        },
      });
    },
    executeTool: async (_toolName, args) => ({
      ok: true,
      args,
      lines: Array.from({ length: 24 }, (_, index) => `line-${index}-${"x".repeat(40)}`),
    }),
  });

  const mixedStart = performance.now();
  await Promise.all(
    Array.from({ length: SESSION_COUNT }, async (_, sessionIndex) => {
      for (let eventIndex = 0; eventIndex < EVENTS_PER_SESSION; eventIndex += 1) {
        telemetry.recordEvent(buildEvent(sessionIndex, eventIndex));
        if ((eventIndex + 1) % 64 === 0) {
          await Promise.resolve();
        }
      }
    }).concat(
      Array.from({ length: WORKFLOW_RUNS }, async (_, workflowIndex) => {
        const taskId = `bench-workflow-task-${workflowIndex}`;
        const sessionId = `bench-workflow-session-${workflowIndex}`;
        const runId = `bench-workflow-run-${workflowIndex}`;
        for (let nodeIndex = 0; nodeIndex < 3; nodeIndex += 1) {
          telemetry.recordEvent({
            eventType: "run.node.started",
            source: "workflow-engine",
            category: "workflow",
            taskId,
            sessionId,
            runId,
            workflowId: "bench-workflow",
            workflowName: "Harness Bench",
            summary: `node-${nodeIndex}-started`,
            status: "running",
          });
          telemetry.recordEvent({
            eventType: "run.node.completed",
            source: "workflow-engine",
            category: "workflow",
            taskId,
            sessionId,
            runId,
            workflowId: "bench-workflow",
            workflowName: "Harness Bench",
            summary: `node-${nodeIndex}-completed`,
            status: "completed",
            durationMs: 10 + nodeIndex,
          });
        }
      }),
      Array.from({ length: TOOL_CALLS }, (_, index) =>
        toolOrchestrator.execute("bench_tool", {
          call: index,
          payload: "y".repeat(2048),
        }, {
          sessionId: `bench-tool-${index}`,
          taskId: `bench-tool-task-${index}`,
          runId: `bench-tool-run-${index}`,
        })),
    ),
  );
  await telemetry.flush();
  const mixedDurationMs = performance.now() - mixedStart;
  const cancelController = new AbortController();
  const processStart = performance.now();
  const processPromise = runProcessWithBosunHotPathExec({
    processId: "bench-proc-1",
    command: process.execPath,
    args: [
      "-e",
      [
        "process.stdout.write('bench-start\\n');",
        "setTimeout(() => process.stdout.write('bench-mid\\n'), 25);",
        "setTimeout(() => process.exit(0), 1_000);",
      ].join(""),
    ],
    timeoutMs: 1_500,
    maxBufferBytes: 16 * 1024,
    tailBufferBytes: 1024,
  }, {
    signal: cancelController.signal,
  });
  setTimeout(() => cancelController.abort("bench-cancel"), 40);
  const watchStart = performance.now();
  const watchPromise = watchPathsWithBosunHotPathExec({
    paths: [watchedPath],
    timeoutMs: 750,
    pollMs: 10,
  });
  setTimeout(() => writeFileSync(watchedPath, "after", "utf8"), 20);
  const [processResult, watchResult] = await Promise.all([processPromise, watchPromise]);
  const processDurationMs = performance.now() - processStart;
  const watchDurationMs = performance.now() - watchStart;

  const summary = telemetry.getSummary();
  const workloadEvents = (SESSION_COUNT * EVENTS_PER_SESSION) + (WORKFLOW_RUNS * 6) + toolEventCount;
  const result = {
    sessions: SESSION_COUNT,
    workflowRuns: WORKFLOW_RUNS,
    toolCalls: TOOL_CALLS,
    totalEventsRecorded: summary.eventCount,
    workloadEvents,
    toolEventsRecorded: toolEventCount,
    mixedDurationMs: Number(mixedDurationMs.toFixed(2)),
    eventsPerSecond: Number(((workloadEvents / mixedDurationMs) * 1000).toFixed(2)),
    toolCallsPerSecond: Number(((TOOL_CALLS / mixedDurationMs) * 1000).toFixed(2)),
    processCancellation: {
      durationMs: Number(processDurationMs.toFixed(2)),
      cancelled: processResult.cancelled === true,
      timedOut: processResult.timedOut === true,
      retainedStdoutBytes: Number(processResult.buffer?.stdout?.retainedBytes || 0),
    },
    watcher: {
      durationMs: Number(watchDurationMs.toFixed(2)),
      changed: watchResult.changed === true,
      changedPaths: watchResult.changedPaths || [],
    },
    hotPath: summary.hotPath,
    metrics: summary.metrics?.totals || null,
    liveSessions: Array.isArray(summary.live?.sessions) ? summary.live.sessions.length : 0,
  };

  rmSync(tempDir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
}

await main();
