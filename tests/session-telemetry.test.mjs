import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHarnessObservabilitySpine,
  exportHarnessTelemetryTrace,
  exportHarnessTelemetryTraceAsync,
  flushHarnessTelemetryRuntimeForTests,
  resetHarnessObservabilitySpinesForTests,
  resolveHarnessTelemetryPaths,
} from "../infra/session-telemetry.mjs";
import { LiveEventProjector } from "../infra/live-event-projector.mjs";
import { RuntimeMetrics } from "../infra/runtime-metrics.mjs";
import { ProviderUsageLedger } from "../infra/provider-usage-ledger.mjs";
import { createReplayReader } from "../infra/replay-reader.mjs";
import { createHarnessTelemetryRuntime } from "../infra/session-telemetry-runtime.mjs";
import {
  configureBosunHotPathRuntimeForTests,
  resetBosunHotPathRuntimeForTests,
} from "../lib/hot-path-runtime.mjs";

describe("session telemetry spine", () => {
  const tempDirs = [];

  beforeEach(() => {
    resetBosunHotPathRuntimeForTests();
    resetHarnessObservabilitySpinesForTests();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
    resetBosunHotPathRuntimeForTests();
    resetHarnessObservabilitySpinesForTests();
  });

  it("projects canonical events into live summaries, metrics, provider usage, and trace export", () => {
    const spine = createHarnessObservabilitySpine({ persist: false });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:00.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      category: "provider",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      spanId: "bbbbbbbbbbbbbbbb",
      status: "completed",
      latencyMs: 180,
      costUsd: 0.12,
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
      summary: "provider turn complete",
    });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:01.000Z",
      eventType: "tool.execution.completed",
      source: "session-tracker",
      category: "tool",
      taskId: "task-1",
      sessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      toolId: "apply_patch",
      toolName: "apply_patch",
      status: "completed",
      durationMs: 45,
      retryCount: 1,
    });

    spine.recordEvent({
      timestamp: "2026-04-02T08:00:02.000Z",
      eventType: "approval.resolved",
      source: "workflow-execution-ledger",
      category: "approval",
      taskId: "task-1",
      sessionId: "session-1",
      runId: "run-1",
      approvalId: "approval-1",
      actor: "operator",
      status: "approved",
    });

    const summary = spine.getSummary();
    expect(summary.eventCount).toBe(3);
    expect(summary.live.sessions[0]).toEqual(expect.objectContaining({
      sessionId: "session-1",
      taskId: "task-1",
      totalEvents: 3,
      totalTokens: 200,
      totalCostUsd: 0.12,
      lastApprovalId: "approval-1",
      lastToolName: "apply_patch",
    }));
    expect(summary.metrics.totals).toEqual(expect.objectContaining({
      events: 3,
      totalTokens: 200,
      costUsd: 0.12,
      retries: 1,
      approvals: 1,
    }));
    expect(summary.providers[0]).toEqual(expect.objectContaining({
      providerId: "openai-api",
      modelId: "gpt-5.4",
      requests: 1,
      totalTokens: 200,
    }));
    expect(summary.live.tools[0]).toEqual(expect.objectContaining({
      toolName: "apply_patch",
      totalCalls: 1,
      totalRetries: 1,
    }));

    const trace = exportHarnessTelemetryTrace({ taskId: "task-1" }, { persist: false });
    expect(trace.traceEvents).toHaveLength(0);

    const exportedTrace = spine.exportTrace({ taskId: "task-1" });
    expect(exportedTrace.traceEvents).toHaveLength(3);
    expect(exportedTrace.traceEvents[0]).toEqual(expect.objectContaining({
      name: "provider.turn.completed",
      cat: "provider",
    }));
  });

  it("projects artifact mutations and subagent lineage into live views, metrics, and filters", () => {
    const spine = createHarnessObservabilitySpine({ persist: false });

    spine.recordEvent({
      timestamp: "2026-04-03T08:00:00.000Z",
      eventType: "patch_applied",
      source: "internal-harness-control-plane",
      category: "artifact",
      taskId: "task-artifact-1",
      sessionId: "session-artifact-1",
      runId: "run-artifact-1",
      artifactId: "artifact-1",
      artifactPath: "server/ui-server.mjs",
      patchHash: "patch-1",
      status: "completed",
      summary: "patched ui server",
    });

    spine.recordEvent({
      timestamp: "2026-04-03T08:00:01.000Z",
      eventType: "subagent_completed",
      source: "internal-harness-control-plane",
      category: "subagent",
      taskId: "task-artifact-1",
      sessionId: "session-artifact-1",
      runId: "run-artifact-1",
      childSessionId: "session-child-1",
      childTaskId: "task-child-1",
      subagentId: "subagent-1",
      status: "completed",
      summary: "delegate finished",
    });

    const summary = spine.getSummary();
    expect(summary.live.sessions[0]).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
      lastArtifactPath: "server/ui-server.mjs",
      childSessionIds: ["session-child-1"],
      childTaskIds: ["task-child-1"],
    }));
    expect(summary.live.runs[0]).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
      childSessionIds: ["session-child-1"],
      childTaskIds: ["task-child-1"],
    }));
    expect(summary.live.artifacts[0]).toEqual(expect.objectContaining({
      artifactId: "artifact-1",
      artifactPath: "server/ui-server.mjs",
      patchHash: "patch-1",
      lastEventType: "patch_applied",
    }));
    expect(summary.live.subagents[0]).toEqual(expect.objectContaining({
      subagentId: "subagent-1",
      childSessionId: "session-child-1",
      childTaskId: "task-child-1",
      parentSessionId: "session-artifact-1",
      parentTaskId: "task-artifact-1",
    }));
    expect(summary.metrics.totals).toEqual(expect.objectContaining({
      artifactMutations: 1,
      subagentEvents: 1,
    }));
    expect(summary.metrics.byCategory).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "artifact", count: 1 }),
      expect.objectContaining({ key: "subagent", count: 1 }),
    ]));

    expect(spine.listEvents({ filePath: "server/ui-server.mjs" })).toHaveLength(1);
    expect(spine.listEvents({ childSessionId: "session-child-1" })).toHaveLength(1);
    expect(spine.listEvents({ subagentId: "subagent-1" })).toHaveLength(1);

    const exportedTrace = spine.exportTrace({ runId: "run-artifact-1" });
    expect(exportedTrace.traceEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "patch_applied",
        args: expect.objectContaining({
          artifactPath: "server/ui-server.mjs",
          patchHash: "patch-1",
        }),
      }),
      expect.objectContaining({
        name: "subagent_completed",
        args: expect.objectContaining({
          childSessionId: "session-child-1",
          childTaskId: "task-child-1",
          subagentId: "subagent-1",
        }),
      }),
    ]));
  });

  it("batches persistence in the JS telemetry runtime and reports hot-path status", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-runtime-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxInMemoryEvents: 16,
      maxPersistBatchEvents: 2,
    });

    for (let index = 0; index < 5; index += 1) {
      spine.recordEvent({
        timestamp: `2026-04-02T09:00:0${index}.000Z`,
        eventType: "workflow.node.complete",
        source: "workflow-engine",
        category: "workflow",
        taskId: "task-hot-path",
        sessionId: "session-hot-path",
        runId: "run-hot-path",
        status: "completed",
        summary: `workflow node ${index}`,
      });
    }

    await flushHarnessTelemetryRuntimeForTests();

    const summary = spine.getSummary();
    expect(summary.hotPath.exec).toEqual(expect.objectContaining({
      available: true,
      service: "exec",
      reason: "javascript",
    }));
    expect(summary.hotPath.bridge.exec).toEqual(expect.objectContaining({
      service: "exec",
      reason: "javascript",
    }));
    expect(summary.hotPath.telemetryBridge).toEqual(expect.objectContaining({
      service: "telemetry",
      reason: "javascript",
    }));
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      available: true,
      service: "telemetry",
      reason: "javascript",
      processedEvents: 5,
      persistedEvents: 5,
      persistBatches: 3,
      maxPersistBatchEvents: 2,
    }));
  });

  it("keeps a bounded in-memory ring buffer while preserving full processed and persisted counts", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-ring-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxInMemoryEvents: 100,
      maxPersistBatchEvents: 8,
    });

    for (let index = 0; index < 106; index += 1) {
      spine.recordEvent({
        timestamp: `2026-04-02T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        eventType: "workflow.node.complete",
        source: "workflow-engine",
        category: "workflow",
        taskId: "task-ring",
        sessionId: "session-ring",
        runId: "run-ring",
        status: "completed",
        summary: `workflow node ${index}`,
      });
    }

    await flushHarnessTelemetryRuntimeForTests();

    const summary = spine.getSummary();
    expect(summary.eventCount).toBe(100);
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      droppedEvents: 6,
      processedEvents: 106,
      persistedEvents: 106,
      inMemoryEvents: 100,
    }));
  });

  it("rebuilds the same live lineage projections from persisted canonical events", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-replay-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxPersistBatchEvents: 2,
    });

    spine.recordEvent({
      timestamp: "2026-04-03T09:00:00.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      taskId: "task-replay-1",
      sessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      runId: "run-replay-1",
      rootRunId: "run-root-1",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      costUsd: 0.03,
      status: "completed",
    });
    spine.recordEvent({
      timestamp: "2026-04-03T09:00:01.000Z",
      eventType: "approval.requested",
      source: "workflow-execution-ledger",
      taskId: "task-replay-1",
      sessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      runId: "run-replay-1",
      rootRunId: "run-root-1",
      approvalId: "approval-replay-1",
      toolId: "push_branch",
      toolName: "push_branch",
      actor: "operator",
      status: "pending",
    });
    spine.recordEvent({
      timestamp: "2026-04-03T09:00:02.000Z",
      eventType: "subagent.completed",
      source: "internal-harness-control-plane",
      taskId: "task-replay-1",
      sessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      runId: "run-replay-1",
      rootRunId: "run-root-1",
      subagentId: "subagent-replay-1",
      childSessionId: "session-child-replay-1",
      childTaskId: "task-child-replay-1",
      childRunId: "run-child-replay-1",
      status: "completed",
    });

    await flushHarnessTelemetryRuntimeForTests();

    const live = spine.getLiveSnapshot();
    const replay = createReplayReader({ configDir }).readTelemetryProjection({
      sessionId: "session-replay-1",
    });

    expect(replay.live.sessions).toEqual(live.sessions);
    expect(replay.live.runs).toEqual(live.runs);
    expect(replay.live.approvals).toEqual(live.approvals);
    expect(replay.live.subagents).toEqual(live.subagents);
    expect(replay.providers).toEqual(spine.getProviderUsageSummary());
    expect(replay.live.sessions[0]).toEqual(expect.objectContaining({
      sessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      providerIds: ["openai-api"],
      approvalIds: ["approval-replay-1"],
      subagentIds: ["subagent-replay-1"],
    }));
    expect(replay.live.approvals[0]).toEqual(expect.objectContaining({
      approvalId: "approval-replay-1",
      sessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      runId: "run-replay-1",
      rootRunId: "run-root-1",
      toolName: "push_branch",
    }));
    expect(replay.live.subagents[0]).toEqual(expect.objectContaining({
      subagentId: "subagent-replay-1",
      childSessionId: "session-child-replay-1",
      childTaskId: "task-child-replay-1",
      childRunId: "run-child-replay-1",
      parentSessionId: "session-replay-1",
      rootSessionId: "session-root-1",
      runId: "run-replay-1",
      rootRunId: "run-root-1",
    }));
  });

  it("rehydrates buffered events and live status directly from persisted telemetry logs", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-runtime-restore-"));
    tempDirs.push(configDir);
    const spine = createHarnessObservabilitySpine({
      persist: true,
      configDir,
      maxPersistBatchEvents: 2,
    });

    spine.recordEvent({
      timestamp: "2026-04-04T10:00:00.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      taskId: "task-runtime-restore-1",
      sessionId: "session-runtime-restore-1",
      threadId: "thread-runtime-restore-1",
      runId: "run-runtime-restore-1",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      status: "running",
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
      },
    });
    spine.recordEvent({
      timestamp: "2026-04-04T10:00:01.000Z",
      eventType: "approval.requested",
      source: "workflow-execution-ledger",
      taskId: "task-runtime-restore-1",
      sessionId: "session-runtime-restore-1",
      threadId: "thread-runtime-restore-1",
      runId: "run-runtime-restore-1",
      approvalId: "approval-runtime-restore-1",
      toolName: "push_branch",
      status: "pending",
    });

    await flushHarnessTelemetryRuntimeForTests();
    resetHarnessObservabilitySpinesForTests();

    const runtime = createHarnessTelemetryRuntime({
      persist: true,
      paths: resolveHarnessTelemetryPaths(configDir),
      projector: new LiveEventProjector(),
      metrics: new RuntimeMetrics(),
      providerUsage: new ProviderUsageLedger(),
    });

    const restored = runtime.restoreFromDisk();
    const status = runtime.getStatus();
    const events = runtime.getEvents();

    expect(restored).toEqual(expect.objectContaining({
      restoredFromDisk: true,
      restoredEvents: 2,
      liveSessions: 1,
      liveRuns: 1,
      activeSessions: 1,
      activeRuns: 1,
      latestSessionId: "session-runtime-restore-1",
      latestRunId: "run-runtime-restore-1",
      latestLiveStatus: "pending",
    }));
    expect(status).toEqual(expect.objectContaining({
      restoredFromDisk: true,
      restoredEvents: 2,
      liveSessions: 1,
      liveRuns: 1,
      activeSessions: 1,
      activeRuns: 1,
      latestSessionId: "session-runtime-restore-1",
      latestRunId: "run-runtime-restore-1",
      latestLiveStatus: "pending",
      lastRestoredEventAt: "2026-04-04T10:00:01.000Z",
      lastBufferedEventAt: "2026-04-04T10:00:01.000Z",
    }));
    expect(events).toHaveLength(2);
  });

  it("restores a bounded tail window from oversized telemetry logs", () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-telemetry-runtime-tail-"));
    tempDirs.push(configDir);
    const paths = resolveHarnessTelemetryPaths(configDir);
    mkdirSync(join(configDir, ".cache", "harness", "observability"), { recursive: true });
    const lines = [];
    for (let index = 0; index < 40; index += 1) {
      lines.push(JSON.stringify({
        timestamp: `2026-04-04T11:00:${String(index).padStart(2, "0")}.000Z`,
        eventType: "workflow.node.complete",
        source: "workflow-engine",
        taskId: `task-tail-${index}`,
        sessionId: `session-tail-${index}`,
        runId: `run-tail-${index}`,
        status: index === 39 ? "running" : "completed",
        summary: `tail event ${index}`,
      }));
    }
    writeFileSync(paths.eventsPath, `${lines.join("\n")}\n`, "utf8");

    const runtime = createHarnessTelemetryRuntime({
      persist: true,
      paths,
      projector: new LiveEventProjector(),
      metrics: new RuntimeMetrics(),
      providerUsage: new ProviderUsageLedger(),
      maxInMemoryEvents: 10,
      maxRestoreBytes: 512,
      maxRestoreEvents: 5,
    });

    const restored = runtime.restoreFromDisk();
    const status = runtime.getStatus();
    const events = runtime.getEvents();

    expect(restored).toEqual(expect.objectContaining({
      restoredFromDisk: true,
      restoredEvents: 5,
      latestSessionId: "session-tail-39",
      latestRunId: "run-tail-39",
      latestLiveStatus: "running",
    }));
    expect(events).toHaveLength(5);
    expect(events.map((event) => event.runId)).toEqual([
      "run-tail-35",
      "run-tail-36",
      "run-tail-37",
      "run-tail-38",
      "run-tail-39",
    ]);
    expect(status).toEqual(expect.objectContaining({
      restoredFromDisk: true,
      restoredEvents: 5,
      restoredFileBytes: expect.any(Number),
      restoredReadBytes: expect.any(Number),
      restoreTruncated: true,
      latestSessionId: "session-tail-39",
      latestRunId: "run-tail-39",
      latestLiveStatus: "running",
      lastRestoredEventAt: "2026-04-04T11:00:39.000Z",
    }));
  });

  it("can use native telemetry export acceleration without changing canonical event storage", async () => {
    const nativeEvents = [];
    configureBosunHotPathRuntimeForTests({
      telemetryClient: {
        async request(command, payload) {
          if (command === "append_events") {
            nativeEvents.push(...(payload.events || []));
            return {
              ok: true,
              service: "bosun-telemetry",
              version: "test-native",
              accepted: payload.events.length,
              eventCount: nativeEvents.length,
            };
          }
          if (command === "export_trace") {
            return {
              ok: true,
              service: "bosun-telemetry",
              version: "test-native",
              trace: {
                schemaVersion: 1,
                format: "chrome-trace",
                displayTimeUnit: "ms",
                traceEvents: nativeEvents
                  .filter((event) => event.sessionId === payload.filter?.sessionId)
                  .map((event) => ({
                    name: event.eventType,
                    cat: event.category,
                    ts: Date.parse(event.timestamp) * 1000,
                    ph: "i",
                    s: "t",
                    args: {
                      sessionId: event.sessionId,
                      providerId: event.providerId ?? null,
                    },
                  })),
              },
            };
          }
          if (command === "flush" || command === "status" || command === "reset") {
            return { ok: true, service: "bosun-telemetry", version: "test-native" };
          }
          throw new Error(`unsupported:${command}`);
        },
        async flush() {},
        async reset() {
          nativeEvents.length = 0;
        },
      },
    });

    const spine = createHarnessObservabilitySpine({ persist: false });
    spine.recordEvent({
      timestamp: "2026-04-03T13:00:00.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      category: "provider",
      taskId: "task-native-export",
      sessionId: "session-native-export",
      runId: "run-native-export",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      status: "completed",
    });

    await flushHarnessTelemetryRuntimeForTests();

    const syncTrace = spine.exportTrace({ sessionId: "session-native-export" });
    const asyncTrace = await exportHarnessTelemetryTraceAsync(
      { sessionId: "session-native-export" },
      { persist: false },
    );
    const summary = spine.getSummary();

    expect(syncTrace.traceEvents).toHaveLength(1);
    expect(asyncTrace.traceEvents).toEqual([
      expect.objectContaining({
        name: "provider.turn.completed",
        args: expect.objectContaining({
          sessionId: "session-native-export",
          providerId: "openai-api",
        }),
      }),
    ]);
    expect(summary.hotPath.bridge.telemetry).toEqual(expect.objectContaining({
      mode: "native",
      nativeVersion: "test-native",
    }));
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      nativeMirrorFlushes: 1,
      nativeMirrorFailures: 0,
    }));
  });
});
