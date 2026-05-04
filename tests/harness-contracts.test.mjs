import { describe, expect, it } from "vitest";

import { compileInternalHarnessProfile } from "../agent/internal-harness-profile.mjs";
import { createInternalHarnessSession } from "../agent/internal-harness-runtime.mjs";

describe("Harness contract regressions", () => {
  it("records canonical run metadata and mode progression", async () => {
    const events = [];
    const profile = {
      agentId: "contract-harness",
      entryStageId: "plan",
      stages: [
        {
          id: "plan",
          type: "prompt",
          prompt: "Plan the approach",
          transitions: [{ on: "success", to: "finalize" }],
        },
        {
          id: "finalize",
          type: "finalize",
          prompt: "Wrap it up",
        },
      ],
    };

    const session = createInternalHarnessSession(profile, {
      taskKey: "run-contract-task",
      executeTurn: async ({ stage }) => {
        return {
          success: true,
          outcome: "success",
          status: "completed",
          output: `executed:${stage.id}`,
        };
      },
      onEvent: (event) => events.push(event),
    });

    const result = await session.run();
    const state = session.getState();

    expect(result.success).toBe(true);
    expect(result.history).toHaveLength(2);
    expect(result.history[0]).toMatchObject({ stageId: "plan", mode: "initial" });
    expect(result.history[1]).toMatchObject({ stageId: "finalize", mode: "continue" });
    expect(state.sessionId).toBe("run-contract-task");
    expect(state.runId).toBe(result.runId);
    expect(events.some((event) => event.type === "harness:stage-start")).toBe(true);
    expect(events.some((event) => event.type === "harness:stage-result")).toBe(true);
  });

  it("emits harness events that satisfy the canonical event contract", async () => {
    const received = [];
    const profile = {
      agentId: "contract-events",
      entryStageId: "first",
      stages: [
        {
          id: "first",
          type: "prompt",
          prompt: "First stage",
          transitions: [{ on: "success", to: "second" }],
        },
        {
          id: "second",
          type: "finalize",
          prompt: "Second stage",
        },
      ],
    };

    const runtime = createInternalHarnessSession(profile, {
      taskKey: "event-contract-task",
      executeTurn: async ({ stage }) => {
        return {
          success: true,
          outcome: "success",
          status: "completed",
          output: `contract:${stage.id}`,
          threadId: `thread-${stage.id}`,
        };
      },
      onEvent: (event) => received.push(event),
    });

    const result = await runtime.run();
    const stageEvents = received.filter((event) => event.stageId);
    expect(stageEvents.length).toBeGreaterThanOrEqual(2);
    stageEvents.forEach((event) => {
      expect(event).toMatchObject({
        type: expect.any(String),
        runId: result.runId,
        sessionId: "event-contract-task",
        stageId: expect.any(String),
        timestamp: expect.any(String),
      });
    });
  });

  it("applies runtime-config defaults while honoring overrides", () => {
    const compiled = compileInternalHarnessProfile(
      {
        entryStageId: "start",
        stages: [
          {
            id: "start",
            prompt: "Begin",
            cwd: "/repo/special",
            sessionType: "overridden",
            transitions: [{ on: "success", to: "finish" }],
          },
          {
            id: "finish",
            prompt: "Finish",
          },
        ],
      },
      {
        defaultCwd: "/repo/default",
        defaultSessionType: "workflow",
        defaultSdk: "codex",
        defaultModel: "gpt-5.4",
        defaultTaskKey: "runtime-config-task",
      },
    );

    expect(compiled.compiledProfile.cwd).toBe("/repo/default");
    expect(compiled.compiledProfile.sessionType).toBe("workflow");
    expect(compiled.compiledProfile.sdk).toBe("codex");
    expect(compiled.compiledProfile.model).toBe("gpt-5.4");
    expect(compiled.compiledProfile.taskKey).toBe("runtime-config-task");
    expect(compiled.compiledProfile.stages[0].cwd).toBe("/repo/special");
    expect(compiled.compiledProfile.stages[0].sessionType).toBe("overridden");
    expect(compiled.compiledProfile.stages[1].sessionType).toBe("workflow");
    expect(compiled.validationReport.stats.stageCount).toBe(2);
    expect(compiled.compiledProfile.metadata.stageCount).toBe(2);
  });
});
