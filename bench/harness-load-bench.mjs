#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { createInternalHarnessSession } from "../agent/internal-harness-runtime.mjs";
import { createProviderKernel } from "../agent/provider-kernel.mjs";
import { createBosunSessionManager } from "../agent/session-manager.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import {
  createHarnessObservabilitySpine,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";

const SESSION_COUNT = Math.max(4, Number.parseInt(process.env.BOSUN_HARNESS_LOAD_SESSIONS || "18", 10) || 18);
const ABORT_EVERY = Math.max(0, Number.parseInt(process.env.BOSUN_HARNESS_LOAD_ABORT_EVERY || "6", 10) || 6);
const STAGE_DELAY_MS = Math.max(1, Number.parseInt(process.env.BOSUN_HARNESS_LOAD_STAGE_DELAY_MS || "12", 10) || 12);

function percentile(values = [], ratio = 0.95) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index].toFixed(2));
}

function sleepWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
}

function createLoadRuntime() {
  const providerKernel = createProviderKernel({
    adapters: {
      "bench-sdk": {
        name: "bench-sdk",
        provider: "BENCH",
        exec: async (message, options = {}) => ({
          finalResponse: `load:${message}`,
          sessionId: options.sessionId || null,
          threadId: options.threadId || null,
          providerId: options.provider || null,
          usage: {
            inputTokens: 18,
            outputTokens: 9,
            totalTokens: 27,
          },
        }),
      },
    },
    config: {
      providers: {
        defaultProvider: "openai-compatible",
        openaiCompatible: {
          enabled: true,
          defaultModel: "bench-model",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      },
    },
    env: {},
  });
  const toolOrchestrator = createToolOrchestrator({
    toolSources: [{
      source: "bench",
      definitions: [{
        id: "load_echo",
        handler: async (args = {}) => ({
          ok: true,
          sessionId: args.sessionId,
        }),
      }],
    }],
  });
  return { providerKernel, toolOrchestrator };
}

function createProfile() {
  return {
    agentId: "bosun-harness-load-bench",
    entryStageId: "plan",
    provider: "openai-compatible",
    stages: [
      {
        id: "plan",
        type: "prompt",
        prompt: "Plan the benchmark action.",
        transitions: [{ on: "success", to: "apply" }],
      },
      {
        id: "apply",
        type: "prompt",
        prompt: "Apply the benchmark action.",
        transitions: [{ on: "success", to: "finalize" }],
      },
      {
        id: "finalize",
        type: "finalize",
        prompt: "Finalize the benchmark response.",
      },
    ],
  };
}

async function runLoadSession(index, telemetry) {
  const sessionManager = createBosunSessionManager();
  const { providerKernel, toolOrchestrator } = createLoadRuntime();
  const profile = createProfile();
  const sessionId = `load-session-${index}`;
  const abortController = new AbortController();
  const shouldAbort = ABORT_EVERY > 0 && index > 0 && index % ABORT_EVERY === 0;

  sessionManager.beginExternalSession({
    sessionId,
    threadId: `${sessionId}:root`,
    scope: index % 2 === 0 ? "tui:bench" : "workflow:bench",
    sessionType: index % 2 === 0 ? "tui" : "workflow",
    taskKey: `TASK-LOAD-${index}`,
    cwd: process.cwd(),
    source: "load-bench",
  });
  sessionManager.registerExecution(sessionId, {
    sessionType: index % 2 === 0 ? "tui" : "workflow",
    taskKey: `TASK-LOAD-${index}`,
    threadId: `${sessionId}:root`,
    cwd: process.cwd(),
    status: "running",
    scope: index % 2 === 0 ? "tui:bench" : "workflow:bench",
    metadata: {
      benchmark: "load",
    },
  });

  const session = createInternalHarnessSession(profile, {
    runId: `load-run-${index}`,
    sessionId,
    taskKey: `TASK-LOAD-${index}`,
    surface: index % 2 === 0 ? "tui" : "workflow",
    channel: index % 2 === 0 ? "tui:bench" : "workflow:bench",
    requestedBy: "harness-load-bench",
    abortController,
    onEvent: (event) => {
      telemetry.recordEvent({
        timestamp: event.timestamp || new Date().toISOString(),
        eventType: event.type || "harness:event",
        source: "internal-harness-runtime",
        category: "harness",
        sessionId,
        runId: `load-run-${index}`,
        taskId: `TASK-LOAD-${index}`,
        status: event.status || null,
        summary: event.summary || event.type || null,
      });
    },
    executeTurn: async ({ stage, signal }) => {
      await toolOrchestrator.execute("load_echo", {
        sessionId,
        stageId: stage.id,
      }, {
        sessionId,
        turnId: `${sessionId}:${stage.id}`,
        approval: { mode: "auto" },
      });
      await sleepWithSignal(STAGE_DELAY_MS, signal);
      const providerSession = providerKernel.createExecutionSession({
        adapterName: "bench-sdk",
        selectionId: "openai-compatible",
        sessionId,
        threadId: `${sessionId}:${stage.id}`,
        model: "bench-model",
      });
      const providerResult = await providerSession.runTurn(stage.prompt, {
        sessionId,
        threadId: `${sessionId}:${stage.id}`,
        model: "bench-model",
      });
      return {
        success: true,
        outcome: "success",
        status: "completed",
        output: providerResult.finalResponse,
        sessionId: providerResult.sessionId,
        threadId: providerResult.threadId,
        providerId: providerResult.providerId,
      };
    },
  });

  let abortScheduledAt = null;
  if (shouldAbort) {
    const timer = setTimeout(() => {
      abortScheduledAt = performance.now();
      abortController.abort("bench-abort");
    }, Math.max(1, Math.floor(STAGE_DELAY_MS / 2)));
  }

  const startedAt = performance.now();
  const result = await session.run().catch((error) => ({
    success: false,
    status: error?.name === "AbortError" ? "aborted" : "failed",
    error: error?.message || String(error),
  }));
  const finishedAt = performance.now();

  sessionManager.finalizeExternalExecution(sessionId, {
    success: result.success,
    status: result.status,
    error: result.error || null,
    threadId: `${sessionId}:final`,
    result,
  });

  return {
    sessionId,
    status: result.status,
    durationMs: finishedAt - startedAt,
    cancellationLatencyMs: abortScheduledAt == null ? null : finishedAt - abortScheduledAt,
  };
}

async function main() {
  resetHarnessObservabilitySpinesForTests();
  const telemetry = createHarnessObservabilitySpine({
    persist: false,
    maxInMemoryEvents: SESSION_COUNT * 18,
  });

  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: SESSION_COUNT }, (_, index) => runLoadSession(index + 1, telemetry)),
  );
  const flushStartedAt = performance.now();
  await telemetry.flush();
  const flushDurationMs = performance.now() - flushStartedAt;
  const totalDurationMs = performance.now() - startedAt;

  const completed = results.filter((entry) => entry.status === "completed");
  const aborted = results.filter((entry) => entry.status === "aborted");
  const failed = results.filter((entry) => entry.status === "failed");
  const durations = results.map((entry) => entry.durationMs);
  const cancellationLatencies = aborted
    .map((entry) => entry.cancellationLatencyMs)
    .filter((value) => Number.isFinite(value));

  console.log(JSON.stringify({
    benchmark: "harness-load",
    sessions: SESSION_COUNT,
    completed: completed.length,
    aborted: aborted.length,
    failed: failed.length,
    totalDurationMs: Number(totalDurationMs.toFixed(2)),
    throughputSessionsPerSecond: Number(((SESSION_COUNT / totalDurationMs) * 1000).toFixed(2)),
    latency: {
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
    },
    cancellationLatency: {
      count: cancellationLatencies.length,
      p50Ms: percentile(cancellationLatencies, 0.5),
      p95Ms: percentile(cancellationLatencies, 0.95),
    },
    projectionFreshnessMs: Number(flushDurationMs.toFixed(2)),
    telemetry: telemetry.getSummary(),
  }, null, 2));
}

await main();
