#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { createInternalHarnessSession } from "../agent/internal-harness-runtime.mjs";
import { createProviderKernel } from "../agent/provider-kernel.mjs";
import { createBosunSessionManager } from "../agent/session-manager.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";

const ITERATIONS = Math.max(1, Number.parseInt(process.env.BOSUN_HARNESS_PARITY_ITERATIONS || "3", 10) || 3);
const SURFACES = Object.freeze([
  { surface: "chat", scope: "primary", sessionType: "primary" },
  { surface: "workflow", scope: "workflow:bench", sessionType: "workflow" },
  { surface: "tui", scope: "tui:bench", sessionType: "tui" },
  { surface: "web-ui", scope: "web-ui:bench", sessionType: "web-ui" },
  { surface: "telegram", scope: "telegram:bench", sessionType: "telegram" },
]);

function percentile(values = [], ratio = 0.95) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return Number(sorted[index].toFixed(2));
}

function createBenchRuntime() {
  const providerKernel = createProviderKernel({
    adapters: {
      "bench-sdk": {
        name: "bench-sdk",
        provider: "BENCH",
        exec: async (message, options = {}) => ({
          finalResponse: `[${options.provider}] ${message}`,
          sessionId: options.sessionId || null,
          threadId: options.threadId || null,
          providerId: options.provider || null,
          usage: {
            inputTokens: 10,
            outputTokens: 6,
            totalTokens: 16,
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
        id: "surface_echo",
        handler: async (args = {}) => ({
          ok: true,
          surface: args.surface,
          stageId: args.stageId,
        }),
      }],
    }],
  });

  return { providerKernel, toolOrchestrator };
}

function createProfile() {
  return {
    agentId: "bosun-harness-parity-bench",
    entryStageId: "plan",
    provider: "openai-compatible",
    stages: [
      {
        id: "plan",
        type: "prompt",
        prompt: "Plan the next action.",
        transitions: [{ on: "success", to: "finalize" }],
      },
      {
        id: "finalize",
        type: "finalize",
        prompt: "Finalize the response.",
      },
    ],
  };
}

async function runSurfaceIteration(surfaceEntry, iteration) {
  const sessionManager = createBosunSessionManager();
  const { providerKernel, toolOrchestrator } = createBenchRuntime();
  const sessionId = `bench-${surfaceEntry.surface}-${iteration}`;
  const profile = createProfile();

  sessionManager.beginExternalSession({
    sessionId,
    scope: surfaceEntry.scope,
    sessionType: surfaceEntry.sessionType,
    taskKey: `task-${surfaceEntry.surface}-${iteration}`,
    cwd: process.cwd(),
    source: surfaceEntry.surface,
  });
  sessionManager.registerExecution(sessionId, {
    scope: surfaceEntry.scope,
    sessionType: surfaceEntry.sessionType,
    taskKey: `task-${surfaceEntry.surface}-${iteration}`,
    cwd: process.cwd(),
    status: "running",
    threadId: `${sessionId}:bootstrap`,
    providerSelection: "openai-compatible",
    adapterName: "bench-sdk",
  });

  const session = createInternalHarnessSession(profile, {
    runId: `run-${surfaceEntry.surface}-${iteration}`,
    sessionId,
    taskKey: `task-${surfaceEntry.surface}-${iteration}`,
    surface: surfaceEntry.surface,
    channel: surfaceEntry.scope,
    requestedBy: "harness-parity-bench",
    executeTurn: async ({ stage }) => {
      const toolResult = await toolOrchestrator.execute("surface_echo", {
        surface: surfaceEntry.surface,
        stageId: stage.id,
      }, {
        sessionId,
        turnId: `${sessionId}:${stage.id}`,
        approval: { mode: "auto" },
      });
      const providerSession = providerKernel.createExecutionSession({
        adapterName: "bench-sdk",
        selectionId: "openai-compatible",
        sessionId,
        threadId: `${sessionId}:${stage.id}`,
        model: "bench-model",
      });
      const providerResult = await providerSession.runTurn(
        `${surfaceEntry.surface}:${stage.prompt}`,
        {
          sessionId,
          threadId: `${sessionId}:${stage.id}`,
          model: "bench-model",
        },
      );
      return {
        success: true,
        outcome: "success",
        status: "completed",
        output: `${providerResult.finalResponse} :: ${toolResult.surface}`,
        sessionId: providerResult.sessionId,
        threadId: providerResult.threadId,
        providerId: providerResult.providerId,
      };
    },
  });

  const startedAt = performance.now();
  const result = await session.run();
  const durationMs = performance.now() - startedAt;

  sessionManager.finalizeExternalExecution(sessionId, {
    success: result.success,
    status: result.status,
    threadId: `${sessionId}:final`,
    result,
  });

  return {
    surface: surfaceEntry.surface,
    durationMs,
    status: result.status,
    providerId: session.getState().provider,
    events: session.getState().events.length,
  };
}

async function main() {
  const results = [];
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (const surface of SURFACES) {
      results.push(await runSurfaceIteration(surface, iteration));
    }
  }

  const bySurface = Object.fromEntries(
    SURFACES.map(({ surface }) => {
      const surfaceResults = results.filter((entry) => entry.surface === surface);
      const durations = surfaceResults.map((entry) => entry.durationMs);
      return [surface, {
        iterations: surfaceResults.length,
        avgDurationMs: Number((durations.reduce((sum, value) => sum + value, 0) / Math.max(1, durations.length)).toFixed(2)),
        p95DurationMs: percentile(durations, 0.95),
        statuses: [...new Set(surfaceResults.map((entry) => entry.status))],
        providerIds: [...new Set(surfaceResults.map((entry) => entry.providerId))],
        minEvents: Math.min(...surfaceResults.map((entry) => entry.events)),
      }];
    }),
  );

  console.log(JSON.stringify({
    benchmark: "harness-parity",
    iterations: ITERATIONS,
    surfaces: bySurface,
  }, null, 2));
}

await main();
