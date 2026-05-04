import { describe, it, expect } from "vitest";
import {
  SequentialPipeline,
  FanoutPipeline,
  RacePipeline,
  runConfiguredWorkflow,
} from "../workflow/pipeline.mjs";

describe("workflow pipeline primitives", () => {
  it("SequentialPipeline hands only the prior output into the next fresh context", async () => {
    const seenInputs = [];
    const pipeline = new SequentialPipeline([
      {
        name: "analyze",
        async run() {
          return {
            success: true,
            output: "analysis complete",
            usage: { totalTokens: 2 },
            branch: "feat/pipeline",
            filePaths: ["src/pipeline.mjs"],
          };
        },
      },
      {
        name: "review",
        async run(input) {
          seenInputs.push(input);
          return {
            success: true,
            output: `reviewed: ${input.previous.output}`,
            usage: { promptTokens: 1, completionTokens: 2 },
          };
        },
      },
    ], { createHub: false });

    const result = await pipeline.run({
      taskId: "task-1",
      title: "Implement pipeline",
      prompt: "Build the new primitives",
      branch: "feat/pipeline",
      filePaths: ["src/pipeline.mjs"],
    });

    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(result.tokensUsed.totalTokens).toBe(5);
    expect(seenInputs[0]).toEqual({
      task: expect.objectContaining({
        taskId: "task-1",
        title: "Implement pipeline",
        prompt: "Build the new primitives",
        branch: "feat/pipeline",
      }),
      previous: expect.objectContaining({
        output: "analysis complete",
        summary: "analysis complete",
        branch: "feat/pipeline",
        filePaths: ["src/pipeline.mjs"],
      }),
    });
  });

  it("FanoutPipeline broadcasts the same task to all agents", async () => {
    const previousValues = [];
    const pipeline = new FanoutPipeline([
      { name: "left", async run(input) { previousValues.push(input.previous); return { success: true, output: "left" }; } },
      { name: "right", async run(input) { previousValues.push(input.previous); return { success: true, output: "right" }; } },
    ], { createHub: false });

    const result = await pipeline.run({ prompt: "search" });

    expect(result.success).toBe(true);
    expect(result.outputs.map((entry) => entry.output)).toEqual(["left", "right"]);
    expect(previousValues).toEqual([null, null]);
  });

  it("RacePipeline returns the first successful result and aborts slower agents", async () => {
    let slowAborted = false;
    const pipeline = new RacePipeline([
      {
        name: "fast",
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { success: true, output: "fast" };
        },
      },
      {
        name: "slow",
        async run(_input, context) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 200);
            context.signal.addEventListener("abort", () => {
              slowAborted = true;
              clearTimeout(timer);
              resolve();
            }, { once: true });
          });
          if (context.signal.aborted) {
            throw new Error("aborted");
          }
          return { success: true, output: "slow" };
        },
      },
    ], { createHub: false });

    const result = await pipeline.run({ prompt: "go" });

    expect(result.success).toBe(true);
    expect(result.winner).toEqual(expect.objectContaining({ agentName: "fast" }));
    expect(slowAborted).toBe(true);
  });

  it("runs configured sequential workflows through Bosun agent adapters", async () => {
    const prompts = [];
    const result = await runConfiguredWorkflow(
      "code-review",
      { title: "Add feature", prompt: "Implement the pipeline feature" },
      {
        createHub: false,
        workflows: {
          "code-review": {
            type: "sequential",
            stages: ["implement", "review"],
          },
        },
        services: {
          agentPool: {
            async execWithRetry(prompt) {
              prompts.push(prompt);
              return {
                success: true,
                output: `output-${prompts.length}`,
                usage: { totalTokens: 1 },
              };
            },
          },
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.outputs).toHaveLength(2);
    expect(prompts[0]).toContain("implementation stage");
    expect(prompts[1]).toContain("Previous stage output");
  });

  it("passes managed harness session lineage into configured Bosun pipeline agents", async () => {
    const mockExecWithRetry = async (_prompt, options) => {
      mockExecWithRetry.calls.push(options);
      return {
        success: true,
        output: `output-${mockExecWithRetry.calls.length}`,
        usage: { totalTokens: 1 },
      };
    };
    mockExecWithRetry.calls = [];

    const result = await runConfiguredWorkflow(
      "code-review",
      {
        taskId: "TASK-PIPE-1",
        title: "Add harness session lineage",
        prompt: "Keep pipeline runs visible in the harness.",
      },
      {
        createHub: false,
        workflows: {
          "code-review": {
            type: "sequential",
            stages: ["implement", "review"],
          },
        },
        services: {
          agentPool: {
            execWithRetry: mockExecWithRetry,
          },
        },
      },
    );

    expect(result.success).toBe(true);
    expect(mockExecWithRetry.calls).toHaveLength(2);
    expect(mockExecWithRetry.calls[0]).toEqual(
      expect.objectContaining({
        sessionId: expect.stringContaining("TASK-PIPE-1:pipeline:implement"),
        sessionScope: "pipeline-task",
        parentSessionId: "TASK-PIPE-1",
        rootSessionId: "TASK-PIPE-1",
        metadata: expect.objectContaining({
          source: "workflow-pipeline-agent",
          pipelineName: "code-review",
          pipelineKind: "sequential",
          taskId: "TASK-PIPE-1",
          taskTitle: "Add harness session lineage",
          stageName: "implement",
        }),
      }),
    );
  });
});
