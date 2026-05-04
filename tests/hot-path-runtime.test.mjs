import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEventsWithBosunHotPathTelemetry,
  configureBosunHotPathRuntimeForTests,
  exportTraceWithBosunHotPathTelemetry,
  getBosunHotPathStatus,
  resetBosunHotPathRuntimeForTests,
  runProcessWithBosunHotPathExec,
  watchPathsWithBosunHotPathExec,
} from "../lib/hot-path-runtime.mjs";
import {
  createHarnessObservabilitySpine,
  exportHarnessTelemetryTraceAsync,
  flushHarnessTelemetryRuntimeForTests,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";

describe("hot path runtime bridge", () => {
  const tempDirs = [];

  afterEach(() => {
    resetBosunHotPathRuntimeForTests();
    resetHarnessObservabilitySpinesForTests();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("falls back to in-process exec for cancellation-aware subprocesses and path watches", async () => {
    configureBosunHotPathRuntimeForTests({ disableNative: true });
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-hot-path-runtime-"));
    const watchedPath = join(tempDir, "watch.txt");
    tempDirs.push(tempDir);
    writeFileSync(watchedPath, "before", "utf8");

    const abortController = new AbortController();
    const processPromise = runProcessWithBosunHotPathExec({
      processId: "proc-fallback-1",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdout.write('start\\n');",
          "setTimeout(() => process.stdout.write('still-running\\n'), 100);",
          "setTimeout(() => process.exit(0), 1_000);",
        ].join(""),
      ],
      timeoutMs: 1_500,
      maxBufferBytes: 8_192,
      tailBufferBytes: 512,
    }, {
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort("test-cancel"), 50);

    const watchPromise = watchPathsWithBosunHotPathExec({
      paths: [watchedPath],
      timeoutMs: 750,
      pollMs: 10,
    });
    setTimeout(() => writeFileSync(watchedPath, "after", "utf8"), 30);

    const [processResult, watchResult] = await Promise.all([processPromise, watchPromise]);
    const status = getBosunHotPathStatus();

    expect(processResult).toEqual(expect.objectContaining({
      processId: "proc-fallback-1",
      cancelled: true,
      timedOut: false,
      buffer: expect.objectContaining({
        stdout: expect.objectContaining({
          originalBytes: expect.any(Number),
          retainedBytes: expect.any(Number),
        }),
      }),
    }));
    expect(watchResult).toEqual(expect.objectContaining({
      changed: true,
      changedPaths: [watchedPath],
      timedOut: false,
    }));
    expect(status.exec).toEqual(expect.objectContaining({
      service: "exec",
      reason: "javascript",
      processOps: 1,
      watchOps: 1,
      cancellations: 1,
      fallbacks: expect.any(Number),
    }));
  });

  it("normalizes native telemetry responses through the bridge and async spine export", async () => {
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
                  .filter((event) => !payload.filter?.sessionId || event.sessionId === payload.filter.sessionId)
                  .map((event) => ({
                    name: event.eventType,
                    cat: event.category,
                    ts: event.ts ?? Date.now() * 1000,
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
          if (command === "flush" || command === "reset" || command === "status") {
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

    await appendEventsWithBosunHotPathTelemetry([
      {
        timestamp: "2026-04-03T12:00:00.000Z",
        eventType: "provider.turn.completed",
        category: "provider",
        sessionId: "session-native-1",
        providerId: "openai-api",
      },
    ]);
    const directTrace = await exportTraceWithBosunHotPathTelemetry({ sessionId: "session-native-1" });

    const spine = createHarnessObservabilitySpine({ persist: false });
    spine.recordEvent({
      timestamp: "2026-04-03T12:00:01.000Z",
      eventType: "provider.turn.completed",
      source: "agent-event-bus",
      category: "provider",
      sessionId: "session-native-2",
      taskId: "task-native-2",
      providerId: "openai-api",
      modelId: "gpt-5.4",
      status: "completed",
    });
    await flushHarnessTelemetryRuntimeForTests();
    const asyncTrace = await exportHarnessTelemetryTraceAsync({ sessionId: "session-native-2" }, { persist: false });
    const summary = spine.getSummary();

    expect(directTrace).toEqual(expect.objectContaining({
      schemaVersion: 1,
      traceEvents: [
        expect.objectContaining({
          name: "provider.turn.completed",
          args: expect.objectContaining({
            sessionId: "session-native-1",
          }),
        }),
      ],
    }));
    expect(asyncTrace).toEqual(expect.objectContaining({
      schemaVersion: 1,
      traceEvents: [
        expect.objectContaining({
          name: "provider.turn.completed",
          args: expect.objectContaining({
            sessionId: "session-native-2",
          }),
        }),
      ],
    }));
    expect(summary.hotPath.bridge.telemetry).toEqual(expect.objectContaining({
      mode: "native",
      nativeVersion: "test-native",
      appendOps: expect.any(Number),
      exportOps: expect.any(Number),
    }));
    expect(summary.hotPath.telemetry).toEqual(expect.objectContaining({
      nativeMirrorFlushes: 1,
      nativeMirrorFailures: 0,
    }));
  });
});
