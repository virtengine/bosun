import { describe, expect, it } from "vitest";

import { createInternalHarnessSession } from "../agent/internal-harness-runtime.mjs";
import { createProviderKernel } from "../agent/provider-kernel.mjs";
import { createBosunSessionManager } from "../agent/session-manager.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";

const HARNESS_RUNTIME_TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

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
          provider: options.provider || null,
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

  const toolEvents = [];
  const toolOrchestrator = createToolOrchestrator({
    onEvent: (event) => toolEvents.push(event),
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

  return { providerKernel, toolOrchestrator, toolEvents };
}

describe("harness runtime cutover", () => {
  it("runs the same canonical harness stack across chat, workflow, TUI, web UI, and Telegram surfaces", async () => {
    const profile = {
      agentId: "bosun-step10-cutover",
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
    const sessionManager = createBosunSessionManager();
    const { providerKernel, toolOrchestrator, toolEvents } = createBenchRuntime();
    const surfaces = [
      { surface: "chat", scope: "primary", sessionType: "primary" },
      { surface: "workflow", scope: "workflow:step10", sessionType: "workflow" },
      { surface: "tui", scope: "tui:step10", sessionType: "tui" },
      { surface: "web-ui", scope: "web-ui:step10", sessionType: "web-ui" },
      { surface: "telegram", scope: "telegram:step10", sessionType: "telegram" },
    ];

    const results = [];
    for (const entry of surfaces) {
      const sessionId = `surface-${entry.surface}`;
      sessionManager.beginExternalSession({
        sessionId,
        scope: entry.scope,
        sessionType: entry.sessionType,
        taskKey: `task-${entry.surface}`,
        cwd: process.cwd(),
        source: entry.surface,
      });
      sessionManager.registerExecution(sessionId, {
        scope: entry.scope,
        sessionType: entry.sessionType,
        taskKey: `task-${entry.surface}`,
        cwd: process.cwd(),
        status: "running",
        threadId: `${entry.surface}-bootstrap`,
        providerSelection: "openai-compatible",
        adapterName: "bench-sdk",
      });

      const session = createInternalHarnessSession(profile, {
        runId: `run-${entry.surface}`,
        sessionId,
        taskKey: `task-${entry.surface}`,
        surface: entry.surface,
        channel: entry.scope,
        requestedBy: "step10-harness-runtime-test",
        executeTurn: async ({ stage }) => {
          const toolResult = await toolOrchestrator.execute("surface_echo", {
            surface: entry.surface,
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
            `${entry.surface}:${stage.prompt}`,
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

      const result = await session.run();
      sessionManager.finalizeExternalExecution(sessionId, {
        success: result.success,
        status: result.status,
        threadId: `${sessionId}:final`,
        result,
      });

      results.push({
        surface: entry.surface,
        state: session.getState(),
        result,
      });
    }

    expect(results).toHaveLength(5);
    expect(results.map((entry) => entry.surface)).toEqual([
      "chat",
      "workflow",
      "tui",
      "web-ui",
      "telegram",
    ]);
    expect(results.every((entry) => entry.result.success === true)).toBe(true);
    expect(results.every((entry) => entry.result.status === "completed")).toBe(true);
    expect(results.every((entry) => entry.state.provider === "openai-compatible")).toBe(true);
    expect(results.every((entry) => entry.state.runtimeConfig.surface.surface === entry.surface)).toBe(true);
    expect(results.every((entry) => entry.state.events.some((event) => event.type === "harness:stage-result"))).toBe(true);

    for (const entry of results) {
      expect(sessionManager.getSession(`surface-${entry.surface}`)).toEqual(
        expect.objectContaining({
          sessionId: `surface-${entry.surface}`,
          sessionType: entry.surface === "chat" ? "primary" : entry.surface,
          status: "completed",
        }),
      );
    }

    expect(toolEvents.filter((event) => event.type === "tool_execution_end")).toHaveLength(10);
    expect(toolEvents.every((event) => event.executionId)).toBe(true);
  }, HARNESS_RUNTIME_TEST_TIMEOUT_MS);
});
