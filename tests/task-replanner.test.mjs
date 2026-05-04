import { describe, expect, it } from "vitest";

import {
  buildTaskReplanContext,
  buildTaskReplanOperationalProtocols,
  buildTaskReplanPrompt,
  extractTaskReplanProposal,
  normalizeTaskReplanProposal,
} from "../task/task-replanner.mjs";

describe("task replanner helpers", () => {
  it("extracts fenced json proposals and normalizes graph fields", () => {
    const raw = {
      finalResponse: [
        "ignore this preface",
        "```json\n" + JSON.stringify({
          summary: "Split the work into parser and tests.",
          planReasoning: "The current task is too broad for one attempt.",
          currentPlanStep: "Create the parser core task first.",
          stopReason: "Two subtasks are enough for the first wave.",
          recommendedAction: "split_task",
          parentTaskPatch: {
            status: "blocked",
            blockedReason: "Waiting for replanned subtasks",
          },
          subtasks: [
            {
              title: "Build parser core",
              description: "Implement the parser core.",
              acceptanceCriteria: ["Handles empty input"],
              priority: "high",
              tags: ["parser"],
            },
            {
              title: "Add integration tests",
              description: "Cover success and failure cases.",
              dependsOnIndexes: [0],
              dependsOnTaskIds: ["TASK-BASE"],
            },
          ],
          dependencyPatches: [
            { taskId: "TASK-REVIEW", dependsOnTaskIds: ["TASK-BASE"] },
          ],
        }, null, 2) + "\n```",
      ],
    };

    const extracted = extractTaskReplanProposal(raw);
    const normalized = normalizeTaskReplanProposal(extracted, {
      parentTask: { priority: "medium" },
    });

    expect(normalized.recommendedAction).toBe("split_task");
    expect(normalized.parentTaskPatch).toMatchObject({
      status: "blocked",
      blockedReason: "Waiting for replanned subtasks",
    });
    expect(normalized.subtasks).toHaveLength(2);
    expect(normalized.subtasks[0]).toMatchObject({
      title: "Build parser core",
      priority: "high",
      acceptanceCriteria: ["Handles empty input"],
    });
    expect(normalized.subtasks[1].dependsOnIndexes).toEqual([0]);
    expect(normalized.subtasks[1].dependsOnTaskIds).toEqual(["TASK-BASE"]);
    expect(normalized.dependencyPatches).toEqual([
      { taskId: "TASK-REVIEW", dependsOnTaskIds: ["TASK-BASE"] },
    ]);
  });

  it("builds a prompt with serialized task graph context", () => {
    const context = buildTaskReplanContext(
      {
        id: "TASK-1",
        title: "Parent",
        description: "Top level task",
        status: "blocked",
        priority: "high",
        dependencyTaskIds: ["TASK-BASE"],
        timeline: [{ type: "task.failed", source: "workflow", message: "Agent failed" }],
        workflowRuns: [{ runId: "run-1", status: "failed", summary: "compile failed" }],
      },
      {
        childTasks: [{ id: "TASK-1A", title: "Child A", status: "todo" }],
        relatedTasks: [{ id: "TASK-2", title: "Sibling", status: "todo" }],
        auditSummary: { eventCount: 4, artifactCount: 1, toolCallCount: 3 },
      },
    );

    const prompt = buildTaskReplanPrompt(context);
    expect(prompt).toContain("TASK-1");
    expect(prompt).toContain("\"childTasks\"");
    expect(prompt).toContain("\"auditSummary\"");
    expect(prompt).toContain("Return exactly one JSON object");
  });

  it("supports explicit decomposition mode context and prompt guidance", () => {
    const context = buildTaskReplanContext(
      {
        id: "TASK-9",
        title: "Break apart ingestion epic",
        description: "One task is carrying schema, implementation, and verification.",
        status: "inprogress",
        priority: "critical",
      },
      {
        mode: "decompose",
        childTasks: [],
        relatedTasks: [{ id: "TASK-10", title: "Sibling", status: "todo" }],
      },
    );

    const prompt = buildTaskReplanPrompt(context);
    const normalized = normalizeTaskReplanProposal({
      mode: "decompose",
      summary: "Create a child graph.",
      subtasks: [{ title: "Schema contract", description: "Define the contract." }],
    }, {
      parentTask: { priority: "high" },
      mode: "decompose",
    });

    expect(context.mode).toBe("decompose");
    expect(prompt).toContain("\"mode\": \"decompose\"");
    expect(prompt).toContain("explicit decomposition request");
    expect(normalized.mode).toBe("decompose");
    expect(normalized.subtasks[0].tags).toContain("decompose");
  });

  it("builds runtime operational protocols from task graph context", () => {
    const context = buildTaskReplanContext(
      {
        id: "TASK-42",
        title: "Research sweep and patch cycle",
        description: "One task is carrying investigation, implementation, and verification work across multiple related items.",
        status: "blocked",
        priority: "high",
        tags: ["research", "batch"],
        timeline: [
          { type: "task.failed", source: "workflow", message: "compile failed" },
          { type: "task.retry", source: "workflow", message: "retry queued" },
          { type: "task.note", source: "operator", message: "hold context for handoff" },
        ],
        workflowRuns: [{ runId: "run-1", status: "failed", summary: "compile failed" }],
      },
      {
        childTasks: [],
        relatedTasks: [
          { id: "TASK-43", title: "Sibling A", status: "todo" },
          { id: "TASK-44", title: "Sibling B", status: "todo" },
        ],
        auditSummary: { eventCount: 5, artifactCount: 2, toolCallCount: 7 },
      },
    );

    const protocols = buildTaskReplanOperationalProtocols(context, { labels: ["research"] });
    expect(protocols.map((entry) => entry.title)).toEqual(expect.arrayContaining([
      "Task Decomposition Protocol",
      "Context Preservation Protocol",
      "Batch Ledger Protocol",
    ]));
    expect(protocols.every((entry) => entry.sourceKind === "runtime-protocol")).toBe(true);
  });
});
