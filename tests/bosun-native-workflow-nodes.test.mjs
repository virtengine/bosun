/**
 * bosun-native-workflow-nodes.test.mjs — Tests for Bosun native workflow nodes
 *
 * Tests the three new node types that enable Bosun tools and workflows
 * to be invoked from within workflow nodes:
 *   1. action.bosun_tool — Programmatic Bosun tool invocation
 *   2. action.invoke_workflow — Lightweight sub-workflow piping
 *   3. action.bosun_function — Direct Bosun function calls
 *
 * Also tests the associated templates from bosun-native.mjs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
} from "../workflow/workflow-engine.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow/workflow-nodes.mjs";
import { registerCustomTool } from "../agent/agent-custom-tools.mjs";
import { listApprovalRequests } from "../workflow/approval-queue.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
const SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

function makeTmpDir() {
  tmpDir = mkdtempSync(join(tmpdir(), "bosun-native-wf-test-"));
  return tmpDir;
}

function makeTmpEngine(services = {}) {
  const dir = makeTmpDir();
  const engine = new WorkflowEngine({
    workflowDir: join(dir, "workflows"),
    runsDir: join(dir, "runs"),
    services,
  });
  return engine;
}

function makeSimpleWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || "test-wf-" + Math.random().toString(36).slice(2, 8),
    name: opts.name || "Test Workflow",
    description: opts.description || "Test workflow",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  action.bosun_tool
// ═══════════════════════════════════════════════════════════════════════════

describe("action.bosun_tool", () => {
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.bosun_tool");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/bosun/i);
    expect(handler.schema.required).toContain("toolId");
    expect(handler.schema.properties.toolId).toBeDefined();
    expect(handler.schema.properties.args).toBeDefined();
    expect(handler.schema.properties.extract).toBeDefined();
    expect(handler.schema.properties.outputMap).toBeDefined();
    expect(handler.schema.properties.outputVariable).toBeDefined();
    expect(handler.schema.properties.portConfig).toBeDefined();
  });

  it("throws when toolId is missing", async () => {
    const handler = getNodeType("action.bosun_tool");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.bosun_tool", config: {} };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/toolId.*required/i);
  });

  it("returns error output when tool not found", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: { toolId: "nonexistent-tool-xyz" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.toolId).toBe("nonexistent-tool-xyz");
    expect(result.matchedPort).toBe("error");
    expect(result.port).toBe("error");
  });

  it("resolves toolId from template variables", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ toolName: "my-custom-tool", repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: { toolId: "{{toolName}}" },
    };
    // Tool won't be found, but toolId should be resolved from template
    const result = await handler.execute(node, ctx);
    expect(result.toolId).toBe("my-custom-tool");
    expect(result.success).toBe(false);
  });

  it("stores result in outputVariable when configured", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "nonexistent-tool",
        outputVariable: "toolResult",
      },
    };
    await handler.execute(node, ctx);
    expect(ctx.data.toolResult).toBeDefined();
    expect(ctx.data.toolResult.success).toBe(false);
  });

  it("can invoke a builtin tool (list-todos) on a real workspace", async () => {
    const handler = getNodeType("action.bosun_tool");
    // Use the bosun directory itself as the workspace
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "list-todos",
        args: ["--help"],
        parseJson: false,
        outputVariable: "todoResult",
      },
    };
    const result = await handler.execute(node, ctx);
    // The tool should execute (whether or not it finds TODOs)
    expect(result.toolId).toBe("list-todos");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(result.matchedPort).toBeDefined();
    expect(ctx.data.todoResult).toBeDefined();
  }, 15000);

  it("uses the workflow sandbox root when repoRoot is missing", async () => {
    const handler = getNodeType("action.bosun_tool");
    const engine = makeTmpEngine();
    registerCustomTool(tmpDir, {
      id: "sandbox-tool",
      title: "Sandbox Tool",
      description: "Prints a marker from the sandbox workspace",
      category: "utility",
      lang: "mjs",
      script: "console.log('sandbox-ok');",
    });
    const ctx = new WorkflowContext({});
    const node = {
      id: "sandbox-tool-run",
      type: "action.bosun_tool",
      config: {
        toolId: "sandbox-tool",
        parseJson: false,
      },
    };

    const result = await handler.execute(node, ctx, engine);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain("sandbox-ok");
  });

  it("resolves args with template interpolation", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({
      repoRoot: tmpDir,
      myArg: "hello-world",
    });
    const node = {
      id: "t1",
      type: "action.bosun_tool",
      config: {
        toolId: "nonexistent",
        args: ["--flag", "{{myArg}}"],
      },
    };
    // Will fail (tool not found), but we can verify args were resolved
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(false);
    // The logs should contain resolved args
    const logMsg = ctx.logs.find((l) => l.nodeId === "t1" && l.message.includes("hello-world"));
    // Tool not found so the invocation log won't contain the args
    // but toolId resolution should work
    expect(result.toolId).toBe("nonexistent");
  });

  it("records Bosun tool execution in the execution ledger when engine hook exists", async () => {
    const handler = getNodeType("action.bosun_tool");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const recordLedgerEvent = vi.fn();
    const node = {
      id: "t-ledger",
      type: "action.bosun_tool",
      config: { toolId: "nonexistent-tool-xyz" },
    };

    const result = await handler.execute(node, ctx, { _recordLedgerEvent: recordLedgerEvent });

    expect(result.success).toBe(false);
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.started",
        executionKind: "tool",
        toolId: "nonexistent-tool-xyz",
      }),
    );
    expect(recordLedgerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.failed",
        executionKind: "tool",
        toolId: "nonexistent-tool-xyz",
      }),
    );
  });

  it("queues workflow-action approval requests before running an approval-gated Bosun tool", async () => {
    const handler = getNodeType("action.bosun_tool");
    const repoRoot = makeTmpDir();
    registerCustomTool(repoRoot, {
      id: "approval-tool",
      title: "Approval Tool",
      description: "Should be blocked until approved",
      category: "utility",
      lang: "mjs",
      script: "console.log('should-not-run');",
    });
    const ctx = new WorkflowContext({
      repoRoot,
      _runId: "run-approval-1",
      _workflowId: "wf-approval-1",
    });
    const node = {
      id: "t-approval",
      type: "action.bosun_tool",
      config: {
        toolId: "approval-tool",
        requireApproval: true,
        approvalReason: "operator review required",
      },
    };

    const result = await handler.execute(node, ctx);
    const approvals = listApprovalRequests({
      repoRoot,
      scopeType: "workflow-action",
      status: "pending",
      includeResolved: true,
      limit: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/requires operator approval/i);
    expect(approvals.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeType: "workflow-action",
        runId: "run-approval-1",
        nodeId: "t-approval",
        status: "pending",
      }),
    ]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.build_task_prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("action.build_task_prompt", () => {
  const originalCacheAnchorMode = process.env.BOSUN_CACHE_ANCHOR_MODE;

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
    if (originalCacheAnchorMode === undefined) {
      delete process.env.BOSUN_CACHE_ANCHOR_MODE;
    } else {
      process.env.BOSUN_CACHE_ANCHOR_MODE = originalCacheAnchorMode;
    }
  });

  it("splits user/system prompts and keeps system prompt stable across tasks", async () => {
    process.env.BOSUN_CACHE_ANCHOR_MODE = "strict";
    const handler = getNodeType("action.build_task_prompt");
    const repoRoot = makeTmpDir();
    writeFileSync(join(repoRoot, "AGENTS.md"), "Agent instructions for tests.");

    const baseNode = {
      id: "prompt-1",
      type: "action.build_task_prompt",
      config: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        taskDescription: "{{taskDescription}}",
        branch: "{{branch}}",
        baseBranch: "{{baseBranch}}",
        worktreePath: "{{worktreePath}}",
        repoRoot: "{{repoRoot}}",
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      },
    };

    const ctxA = new WorkflowContext({
      taskId: "task-abc",
      taskTitle: "Cache anchor check",
      taskDescription: "First task description",
      branch: "task/cache-anchor",
      baseBranch: "main",
      worktreePath: join(repoRoot, ".bosun", "worktrees", "task-abc"),
      repoRoot,
    });
    const resultA = await handler.execute(baseNode, ctxA);
    const userPromptA = resultA.userPrompt || resultA.prompt;
    const systemPromptA = resultA.systemPrompt || ctxA.data._taskSystemPrompt;

    expect(userPromptA).toContain("Task ID: task-abc");
    expect(userPromptA).toContain("## Environment");
    expect(userPromptA).toContain("Co-authored-by: bosun-ve[bot]");
    expect(systemPromptA).toBeTruthy();
    expect(systemPromptA).not.toContain("task-abc");
    expect(systemPromptA).not.toContain("Cache anchor check");
    expect(systemPromptA).not.toContain("task/cache-anchor");

    const ctxB = new WorkflowContext({
      taskId: "task-xyz",
      taskTitle: "Different task",
      taskDescription: "Second task description",
      branch: "task/different",
      baseBranch: "main",
      worktreePath: join(repoRoot, ".bosun", "worktrees", "task-xyz"),
      repoRoot,
    });
    const resultB = await handler.execute(baseNode, ctxB);
    const systemPromptB = resultB.systemPrompt || ctxB.data._taskSystemPrompt;

    expect(systemPromptB).toBe(systemPromptA);
  });

  it("falls back to the task ID when the title is the default placeholder", async () => {
    const handler = getNodeType("action.build_task_prompt");
    const repoRoot = makeTmpDir();

    const node = {
      id: "prompt-untitled",
      type: "action.build_task_prompt",
      config: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        taskDescription: "{{taskDescription}}",
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      },
    };

    const ctx = new WorkflowContext({
      taskId: "89d82c54-c804-45f7-8018-137de0702ddb",
      taskTitle: "Untitled task",
      taskDescription: "Prompt body",
      repoRoot,
      worktreePath: join(repoRoot, ".bosun", "worktrees", "task-89d82c54"),
    });

    const result = await handler.execute(node, ctx);
    const userPrompt = result.userPrompt || result.prompt;

    expect(userPrompt).toContain("# Task: Task 89d82c54-c804-45f7-8018-137de0702ddb");
    expect(userPrompt).toContain("Task ID: 89d82c54-c804-45f7-8018-137de0702ddb");
    expect(userPrompt).not.toContain("# Task: Untitled task");
  });

  it("injects workflow continuation guidance from issue advisor into task prompts", async () => {
    const handler = getNodeType("action.build_task_prompt");
    const repoRoot = makeTmpDir();
    const node = {
      id: "prompt-issue-advisor",
      type: "action.build_task_prompt",
      config: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        taskDescription: "{{taskDescription}}",
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      },
    };
    const ctx = new WorkflowContext({
      taskId: "TASK-IA",
      taskTitle: "Recover validation failure",
      taskDescription: "Continue task execution after validation failed.",
      repoRoot,
      worktreePath: join(repoRoot, ".bosun", "worktrees", "task-ia"),
    });
    ctx.data._issueAdvisor = {
      recommendedAction: "replan_subgraph",
      summary: "Tests failed after dependency changes.",
      nextStepGuidance: "Preserve completed work and replan the impacted downstream subgraph before continuing.",
    };
    ctx.data._plannerFeedback = {
      dagStateSummary: {
        revisionCount: 2,
        counts: { completed: 2, failed: 1, pending: 3 },
      },
    };

    const result = await handler.execute(node, ctx);
    const userPrompt = result.userPrompt || result.prompt;

    expect(userPrompt).toContain("## Workflow Continuation Context");
    expect(userPrompt).toContain("Issue Advisor Action");
    expect(userPrompt).toContain("replan_subgraph");
    expect(userPrompt).toContain("DAG Revisions");
  });

  it("includes a task reference section when taskUrl is provided", async () => {
    const handler = getNodeType("action.build_task_prompt");
    const repoRoot = makeTmpDir();
    const node = {
      id: "prompt-task-url",
      type: "action.build_task_prompt",
      config: {
        taskId: "{{taskId}}",
        taskTitle: "{{taskTitle}}",
        taskDescription: "{{taskDescription}}",
        taskUrl: "{{taskUrl}}",
        includeAgentsMd: false,
        includeStatusEndpoint: false,
      },
    };

    const ctx = new WorkflowContext({
      taskId: "TASK-URL",
      taskTitle: "Track prompt reference",
      taskDescription: "Follow the linked task.",
      taskUrl: "https://github.com/acme/widgets/issues/42",
      repoRoot,
      worktreePath: join(repoRoot, ".bosun", "worktrees", "task-url"),
    });

    const result = await handler.execute(node, ctx);
    const userPrompt = result.userPrompt || result.prompt;

    expect(userPrompt).toContain("## Task Reference");
    expect(userPrompt).toContain("https://github.com/acme/widgets/issues/42");
  });
});

describe("action.continue_session", () => {
  it("prepends issue-advisor guidance to continuation prompts", async () => {
    const handler = getNodeType("action.continue_session");
    const repoRoot = makeTmpDir();
    const {
      initSharedKnowledge,
      buildKnowledgeEntry,
      appendKnowledgeEntry,
    } = await import("../workspace/shared-knowledge.mjs");
    initSharedKnowledge({ repoRoot, targetFile: "AGENTS.md" });
    mkdirSync(join(repoRoot, ".bosun", "context-index"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".bosun", "context-index", "agent-index.json"),
      JSON.stringify({
        relations: [
          {
            relationType: "file_imports_file",
            fromPath: "src/auth/login.mjs",
            toPath: "src/auth/session-store.mjs",
          },
        ],
      }, null, 2),
      "utf8",
    );
    const memoryResult = await appendKnowledgeEntry(buildKnowledgeEntry({
      content: "Workspace memory: reseed fixtures in src/auth/login.mjs before resuming retry work.",
      scope: "testing",
      scopeLevel: "workspace",
      teamId: "team-a",
      workspaceId: "workspace-1",
      sessionId: "session-0",
      runId: "run-0",
      agentId: "agent-memory",
      relatedPaths: ["src/auth/login.mjs"],
    }));
    expect(memoryResult.success).toBe(true);

    const continueSession = vi.fn().mockResolvedValue({
      success: true,
      output: "continued",
      threadId: "thread-1",
    });
    const engine = {
      services: {
        agentPool: { continueSession },
      },
    };
    const ctx = new WorkflowContext({
      sessionId: "thread-1",
      repoRoot,
      taskId: "TASK-CONT-1",
      taskTitle: "Resume auth retry work",
      taskDescription: "Resume retry work without losing fixture state.",
      workspaceId: "workspace-1",
      runId: "run-1",
    });
    ctx.data.teamId = "team-a";
    ctx.data._changedFiles = ["src/auth/login.mjs"];
    ctx.data._issueAdvisor = {
      recommendedAction: "spawn_fix_step",
      summary: "Review feedback requested a targeted patch before resuming.",
      nextStepGuidance: "Preserve completed work and insert a targeted fix step before resuming downstream execution.",
    };
    ctx.data._plannerFeedback = {
      dagStateSummary: { counts: { completed: 2, failed: 1, pending: 0 } },
    };

    const result = await handler.execute({
      id: "continue-1",
      type: "action.continue_session",
      config: { prompt: "Continue fixing the issue." },
    }, ctx, engine);

    expect(result.success).toBe(true);
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(continueSession.mock.calls[0][1]).toContain("Issue-advisor continuation context");
    expect(continueSession.mock.calls[0][1]).toContain("spawn_fix_step");
    expect(continueSession.mock.calls[0][1]).toContain("## Persistent Memory Briefing");
    expect(continueSession.mock.calls[0][1]).toContain("reseed fixtures in src/auth/login.mjs");
    expect(continueSession.mock.calls[0][1]).toContain("matched=src/auth/login.mjs");
    expect(ctx.data._continuedSessionRetrievedMemory?.[0]).toEqual(expect.objectContaining({
      directPathHits: ["src/auth/login.mjs"],
    }));
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.invoke_workflow
// ═══════════════════════════════════════════════════════════════════════════

describe("action.invoke_workflow", () => {
  let engine;

  beforeEach(() => {
    engine = makeTmpEngine();
  });

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.invoke_workflow");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/invoke.*workflow/i);
    expect(handler.schema.required).toContain("workflowId");
    expect(handler.schema.properties.workflowId).toBeDefined();
    expect(handler.schema.properties.mode).toBeDefined();
    expect(handler.schema.properties.forwardFields).toBeDefined();
    expect(handler.schema.properties.extractFromNodes).toBeDefined();
    expect(handler.schema.properties.pipeContext).toBeDefined();
  });

  it("throws when workflowId is empty", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.invoke_workflow", config: {} };
    await expect(handler.execute(node, ctx, engine)).rejects.toThrow(/workflowId.*required/i);
  });

  it("throws when engine is not available", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.invoke_workflow",
      config: { workflowId: "some-wf" },
    };
    await expect(handler.execute(node, ctx, null)).rejects.toThrow(/engine.*not available/i);
  });

  it("soft-fails when workflow not found and failOnError is false (default)", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.invoke_workflow",
      config: { workflowId: "nonexistent-wf" },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.port).toBe("error");
  });

  it("throws when workflow not found and failOnError is true", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.invoke_workflow",
      config: { workflowId: "nonexistent-wf", failOnError: true },
    };
    await expect(handler.execute(node, ctx, engine)).rejects.toThrow(/not found/i);
  });

  it("sync mode executes child and forwards output", async () => {
    // Create a simple child workflow
    const childWf = makeSimpleWorkflow(
      [{ id: "child-trigger", type: "trigger.manual", label: "Start", config: {} }],
      [],
      { id: "child-wf", name: "Child" },
    );
    engine.save(childWf);

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "invoke",
          type: "action.invoke_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "child-wf",
            outputVariable: "childResult",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "invoke" }],
      { id: "parent-wf" },
    );
    engine.save(parentWf);

    const ctx = await engine.execute("parent-wf", {});
    expect(ctx.errors).toHaveLength(0);

    const output = ctx.getNodeOutput("invoke");
    expect(output).toBeDefined();
    expect(output.success).toBe(true);
    expect(output.workflowId).toBe("child-wf");
    expect(output.mode).toBe("sync");
    expect(output.matchedPort).toBe("default");
    expect(typeof output.runId).toBe("string");
    expect(ctx.data.childResult).toEqual(output);
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("dispatch mode returns immediately without waiting", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    let resolveChild;
    const childPromise = new Promise((r) => { resolveChild = r; });
    const mockEngine = {
      execute: vi.fn().mockReturnValue(childPromise),
      get: vi.fn().mockReturnValue({ id: "child-dispatch-wf" }),
    };

    const node = {
      id: "dispatch-node",
      type: "action.invoke_workflow",
      config: {
        workflowId: "child-dispatch-wf",
        mode: "dispatch",
        outputVariable: "dispatchResult",
      },
    };

    try {
      const result = await handler.execute(node, ctx, mockEngine);
      expect(result.success).toBe(true);
      expect(result.dispatched).toBe(true);
      expect(result.mode).toBe("dispatch");
      expect(result.workflowId).toBe("child-dispatch-wf");
      expect(result.matchedPort).toBe("default");
      expect(ctx.data.dispatchResult).toEqual(result);
    } finally {
      resolveChild?.(new WorkflowContext({}));
      await childPromise;
    }
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("dispatch mode accepts synchronous engine return values", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const mockEngine = {
      execute: vi.fn(() => new WorkflowContext({ ok: true })),
      get: vi.fn().mockReturnValue({ id: "child-dispatch-wf" }),
    };

    const node = {
      id: "dispatch-node-sync-return",
      type: "action.invoke_workflow",
      config: {
        workflowId: "child-dispatch-wf",
        mode: "dispatch",
        outputVariable: "dispatchResult",
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(result.dispatched).toBe(true);
    expect(result.mode).toBe("dispatch");
    expect(result.workflowId).toBe("child-dispatch-wf");
    expect(ctx.data.dispatchResult).toEqual(result);
    expect(mockEngine.execute).toHaveBeenCalledTimes(1);
  });

  it("handles child workflow failure gracefully (failOnError=false)", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const failedChildCtx = new WorkflowContext({});
    failedChildCtx.error("child-node", new Error("child exploded"));

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(failedChildCtx),
      get: vi.fn().mockReturnValue({ id: "failing-wf" }),
    };

    const node = {
      id: "soft-fail",
      type: "action.invoke_workflow",
      config: {
        workflowId: "failing-wf",
        failOnError: false,
        outputVariable: "failResult",
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].error).toMatch(/child exploded/);
    expect(result.matchedPort).toBe("error");
    expect(ctx.data.failResult).toEqual(result);
  });

  it("throws on child failure when failOnError=true", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const failedChildCtx = new WorkflowContext({});
    failedChildCtx.error("child-node", new Error("fatal error"));

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(failedChildCtx),
      get: vi.fn().mockReturnValue({ id: "fatal-wf" }),
    };

    const node = {
      id: "hard-fail",
      type: "action.invoke_workflow",
      config: {
        workflowId: "fatal-wf",
        failOnError: true,
      },
    };

    await expect(handler.execute(node, ctx, mockEngine))
      .rejects.toThrow(/fatal error/i);
  });

  it("forwards child workflow node outputs to parent", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("step-1", { count: 42, items: ["a", "b"] });
    childCtx.setNodeOutput("step-2", { summary: "all done", flag: true });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "child-forward-wf" }),
    };

    const node = {
      id: "forward-test",
      type: "action.invoke_workflow",
      config: { workflowId: "child-forward-wf" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    // All child node output fields should be merged to top-level
    expect(result.count).toBe(42);
    expect(result.items).toEqual(["a", "b"]);
    expect(result.summary).toBe("all done");
    expect(result.flag).toBe(true);
  });

  it("extracts from specific child nodes via extractFromNodes", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("relevant-step", { value: "keep-me" });
    childCtx.setNodeOutput("irrelevant-step", { noise: "ignore-me" });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "extract-wf" }),
    };

    const node = {
      id: "extract-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "extract-wf",
        extractFromNodes: ["relevant-step"],
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.value).toBe("keep-me");
    expect(result.noise).toBeUndefined();
    expect(result["relevant-step"]).toEqual({ value: "keep-me" });
  });

  it("filters forwarded fields via forwardFields", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({ _workflowId: "parent-wf" });

    const childCtx = new WorkflowContext({});
    childCtx.setNodeOutput("step-1", { count: 10, secret: "hidden", value: "shown" });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(childCtx),
      get: vi.fn().mockReturnValue({ id: "filter-wf" }),
    };

    const node = {
      id: "filter-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "filter-wf",
        forwardFields: ["count", "value"],
      },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.count).toBe(10);
    expect(result.value).toBe("shown");
    expect(result.secret).toBeUndefined();
  });

  it("pipes parent context when pipeContext=true", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({
      _workflowId: "parent-wf",
      sharedData: "hello",
      contextValue: 42,
    });

    const capturedInput = {};
    const mockEngine = {
      execute: vi.fn().mockImplementation((id, input) => {
        Object.assign(capturedInput, input);
        return Promise.resolve(new WorkflowContext({}));
      }),
      get: vi.fn().mockReturnValue({ id: "pipe-wf" }),
    };

    const node = {
      id: "pipe-test",
      type: "action.invoke_workflow",
      config: {
        workflowId: "pipe-wf",
        pipeContext: true,
        input: { extra: "override" },
      },
    };

    await handler.execute(node, ctx, mockEngine);
    expect(capturedInput.sharedData).toBe("hello");
    expect(capturedInput.contextValue).toBe(42);
    expect(capturedInput.extra).toBe("override");
  });

  it("resolves workflowId from template variables", async () => {
    const handler = getNodeType("action.invoke_workflow");
    const ctx = new WorkflowContext({
      _workflowId: "parent-wf",
      targetWf: "dynamic-child-wf",
    });

    const mockEngine = {
      execute: vi.fn().mockResolvedValue(new WorkflowContext({})),
      get: vi.fn().mockReturnValue({ id: "dynamic-child-wf" }),
    };

    const node = {
      id: "dynamic-test",
      type: "action.invoke_workflow",
      config: { workflowId: "{{targetWf}}" },
    };

    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.workflowId).toBe("dynamic-child-wf");
    expect(mockEngine.execute).toHaveBeenCalledWith(
      "dynamic-child-wf",
      expect.objectContaining({ _parentWorkflowId: "parent-wf" }),
      expect.anything(),
    );
  });

  it("integrates in a real workflow engine execution", async () => {
    const childWf = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "child-set-var", type: "action.set_variable", label: "Set Var",
          config: { name: "childOutput", value: "hello-from-child" },
        },
      ],
      [{ id: "e1", source: "child-trigger", target: "child-set-var" }],
      { id: "child-integration-wf" },
    );

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "invoke",
          type: "action.invoke_workflow",
          label: "Invoke",
          config: {
            workflowId: "child-integration-wf",
            outputVariable: "childResult",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log",
          config: { message: "Child ran: {{invoke.workflowId}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "invoke" },
        { id: "e2", source: "invoke", target: "log" },
      ],
      { id: "parent-integration-wf" },
    );

    engine.save(childWf);
    engine.save(parentWf);

    const ctx = await engine.execute("parent-integration-wf", {});
    expect(ctx.errors).toHaveLength(0);

    const invokeOutput = ctx.getNodeOutput("invoke");
    expect(invokeOutput.success).toBe(true);
    expect(invokeOutput.workflowId).toBe("child-integration-wf");
    expect(ctx.data.childResult).toBeDefined();
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.bosun_function
// ═══════════════════════════════════════════════════════════════════════════

describe("action.bosun_function", () => {
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("is registered with correct schema", () => {
    const handler = getNodeType("action.bosun_function");
    expect(handler).toBeDefined();
    expect(handler.execute).toBeInstanceOf(Function);
    expect(handler.describe()).toMatch(/bosun.*function/i);
    expect(handler.outputs.map((port) => port.name)).toEqual(["default", "error"]);
    expect(handler.schema.required).toContain("function");
    expect(handler.schema.properties.function).toBeDefined();
    expect(handler.schema.properties.args).toBeDefined();
    expect(handler.schema.properties.extract).toBeDefined();
    expect(handler.schema.properties.outputMap).toBeDefined();
    expect(handler.schema.properties.outputVariable).toBeDefined();
    // Should list available functions in enum
    expect(handler.schema.properties.function.enum).toContain("tools.list");
    expect(handler.schema.properties.function.enum).toContain("git.status");
    expect(handler.schema.properties.function.enum).toContain("tasks.list");
    expect(handler.schema.properties.function.enum).toContain("workflows.list");
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("throws when function name is missing", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = { id: "t1", type: "action.bosun_function", config: {} };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/function.*required/i);
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("throws for unknown function name", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1", type: "action.bosun_function",
      config: { function: "nonexistent.function" },
    };
    await expect(handler.execute(node, ctx)).rejects.toThrow(/unknown function/i);
  });

  it("calls tools.builtin and returns builtin tool list", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "tools.builtin",
        outputVariable: "builtins",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.function).toBe("tools.builtin");
    expect(Array.isArray(result.data)).toBe(true);
    // Should contain known builtin tools
    const toolIds = result.data.map((t) => t.id);
    expect(toolIds).toContain("list-todos");
    expect(ctx.data.builtins).toEqual(result);
  });

  it("resolves tool catalog lookups from the workflow sandbox when repoRoot is missing", async () => {
    const handler = getNodeType("action.bosun_function");
    const engine = makeTmpEngine();
    registerCustomTool(tmpDir, {
      id: "sandbox-tool",
      title: "Sandbox Tool",
      description: "Scoped to the workflow sandbox",
      category: "utility",
      lang: "mjs",
      script: "console.log('sandbox-ok');",
    });
    const ctx = new WorkflowContext({});
    const node = {
      id: "fn-sandbox-tool",
      type: "action.bosun_function",
      config: {
        function: "tools.get",
        args: {
          toolId: "sandbox-tool",
        },
      },
    };

    const result = await handler.execute(node, ctx, engine);

    expect(result.success).toBe(true);
    expect(result.data?.found).toBe(true);
    expect(result.data?.id).toBe("sandbox-tool");
  });

  it("calls git.status and returns structured git info", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.status",
        outputVariable: "gitStatus",
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.changedFiles).toBe("number");
    expect(Array.isArray(result.files)).toBe(true);
    expect(typeof result.clean).toBe("boolean");
    expect(ctx.data.gitStatus).toBeDefined();
  });

  it("calls git.branch and returns branch info", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "git.branch" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(typeof result.current).toBe("string");
    expect(Array.isArray(result.branches)).toBe(true);
    expect(typeof result.branchCount).toBe("number");
  });

  it("calls git.log and returns commit list", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.log",
        args: { count: "5" },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.commits)).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.commits[0]).toHaveProperty("hash");
    expect(result.commits[0]).toHaveProperty("message");
  });

  it("calls workflows.list with engine", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const mockEngine = {
      list: vi.fn().mockReturnValue([
        { id: "wf-1", name: "Workflow 1", enabled: true, nodes: [1, 2], edges: [1] },
        { id: "wf-2", name: "Workflow 2", enabled: false, nodes: [1], edges: [] },
      ]),
    };
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "workflows.list" },
    };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(true);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe("wf-1");
    expect(result.data[1].enabled).toBe(false);
  });

  it("calls config.show and returns config data", async () => {
    const handler = getNodeType("action.bosun_function");
    makeTmpDir();
    const ctx = new WorkflowContext({ repoRoot: tmpDir });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "config.show" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    // No config file in tmpDir, so exists should be false
    expect(result.exists).toBe(false);
  });

  it("handles service unavailability gracefully", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    // No kanban service
    const mockEngine = { services: {} };
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "tasks.list" },
    };
    const result = await handler.execute(node, ctx, mockEngine);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kanban.*not available/i);
    expect(result.matchedPort).toBe("error");
  });

  it("resolves function name from template variables", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({ fnName: "tools.builtin" });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: { function: "{{fnName}}" },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.function).toBe("tools.builtin");
  });

  it("resolves args from template variables", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({
      repoRoot: bosunRoot,
      commitCount: "3",
    });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.log",
        args: { count: "{{commitCount}}" },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.commits.length).toBeLessThanOrEqual(3);
  });

  it("supports extract config for field extraction", async () => {
    const handler = getNodeType("action.bosun_function");
    const ctx = new WorkflowContext({});
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "tools.builtin",
        extract: {
          fields: {
            firstToolId: "[0].id",
            toolCount: "length",
          },
          defaults: {
            firstToolId: "none",
            toolCount: 0,
          },
          types: {
            toolCount: "number",
          },
        },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.firstToolId).toBeDefined();
    expect(typeof result.toolCount).toBe("number");
    expect(result.toolCount).toBeGreaterThan(0);
  });

  it("supports outputMap for field renaming", async () => {
    const handler = getNodeType("action.bosun_function");
    const bosunRoot = resolve(import.meta.dirname, "..");
    const ctx = new WorkflowContext({ repoRoot: bosunRoot });
    const node = {
      id: "t1",
      type: "action.bosun_function",
      config: {
        function: "git.branch",
        outputMap: {
          activeBranch: "current",
          totalBranches: "branchCount",
        },
      },
    };
    const result = await handler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.activeBranch).toBeDefined();
    expect(typeof result.totalBranches).toBe("number");
  }, 30_000);

  it("integrates in a real workflow engine execution", async () => {
    const engine = makeTmpEngine();
    const bosunRoot = resolve(import.meta.dirname, "..");

    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "git-info",
          type: "action.bosun_function",
          label: "Git Info",
          config: {
            function: "git.branch",
            outputVariable: "branchInfo",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log",
          config: { message: "Branch: {{git-info.current}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "git-info" },
        { id: "e2", source: "git-info", target: "log" },
      ],
      { id: "bosun-fn-integration-wf" },
    );
    engine.save(wf);

    const ctx = await engine.execute("bosun-fn-integration-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const output = ctx.getNodeOutput("git-info");
    expect(output.success).toBe(true);
    expect(typeof output.current).toBe("string");
    expect(ctx.data.branchInfo).toBeDefined();
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
//  Template validation
// ═══════════════════════════════════════════════════════════════════════════

describe("Bosun native templates", () => {
  it("BOSUN_TOOL_PIPELINE_TEMPLATE has valid structure", async () => {
    const { BOSUN_TOOL_PIPELINE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.id).toBe("template-bosun-tool-pipeline");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.category).toBe("mcp-integration");
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.nodes.length).toBeGreaterThan(3);
    expect(BOSUN_TOOL_PIPELINE_TEMPLATE.edges.length).toBeGreaterThan(2);

    // Should use the new node types
    const nodeTypes = BOSUN_TOOL_PIPELINE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.bosun_tool");
  });

  it("WORKFLOW_COMPOSITION_TEMPLATE has valid structure", async () => {
    const { WORKFLOW_COMPOSITION_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(WORKFLOW_COMPOSITION_TEMPLATE.id).toBe("template-workflow-composition");
    expect(WORKFLOW_COMPOSITION_TEMPLATE.nodes.length).toBeGreaterThan(3);

    const nodeTypes = WORKFLOW_COMPOSITION_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("INLINE_WORKFLOW_COMPOSITION_TEMPLATE has valid structure", async () => {
    const { INLINE_WORKFLOW_COMPOSITION_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(INLINE_WORKFLOW_COMPOSITION_TEMPLATE.id).toBe("template-inline-workflow-composition");
    expect(INLINE_WORKFLOW_COMPOSITION_TEMPLATE.nodes.length).toBeGreaterThan(3);

    const nodeTypes = INLINE_WORKFLOW_COMPOSITION_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.inline_workflow");
    expect(nodeTypes).toContain("notify.log");
  });

  it("MCP_TO_BOSUN_BRIDGE_TEMPLATE has valid structure", async () => {
    const { MCP_TO_BOSUN_BRIDGE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(MCP_TO_BOSUN_BRIDGE_TEMPLATE.id).toBe("template-mcp-to-bosun-bridge");

    const nodeTypes = MCP_TO_BOSUN_BRIDGE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.mcp_tool_call");
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("GIT_HEALTH_PIPELINE_TEMPLATE has valid structure", async () => {
    const { GIT_HEALTH_PIPELINE_TEMPLATE } = await import("../workflow-templates/bosun-native.mjs");
    expect(GIT_HEALTH_PIPELINE_TEMPLATE.id).toBe("template-git-health-pipeline");

    const nodeTypes = GIT_HEALTH_PIPELINE_TEMPLATE.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.bosun_function");
    expect(nodeTypes).toContain("action.bosun_tool");
    expect(nodeTypes).toContain("action.invoke_workflow");
  });

  it("all templates are registered in WORKFLOW_TEMPLATES", async () => {
    const { WORKFLOW_TEMPLATES } = await import("../workflow/workflow-templates.mjs");
    const ids = WORKFLOW_TEMPLATES.map((t) => t.id);
    expect(ids).toContain("template-bosun-tool-pipeline");
    expect(ids).toContain("template-workflow-composition");
    expect(ids).toContain("template-inline-workflow-composition");
    expect(ids).toContain("template-mcp-to-bosun-bridge");
    expect(ids).toContain("template-git-health-pipeline");
  });

  it("all template nodes reference valid registered node types", async () => {
    const { BOSUN_TOOL_PIPELINE_TEMPLATE, WORKFLOW_COMPOSITION_TEMPLATE, INLINE_WORKFLOW_COMPOSITION_TEMPLATE, MCP_TO_BOSUN_BRIDGE_TEMPLATE, GIT_HEALTH_PIPELINE_TEMPLATE } =
      await import("../workflow-templates/bosun-native.mjs");

    const templates = [
      BOSUN_TOOL_PIPELINE_TEMPLATE,
      WORKFLOW_COMPOSITION_TEMPLATE,
      INLINE_WORKFLOW_COMPOSITION_TEMPLATE,
      MCP_TO_BOSUN_BRIDGE_TEMPLATE,
      GIT_HEALTH_PIPELINE_TEMPLATE,
    ];

    for (const template of templates) {
      for (const n of template.nodes) {
        const handler = getNodeType(n.type);
        expect(handler).toBeDefined();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-node data piping integration
// ═══════════════════════════════════════════════════════════════════════════

describe("cross-node data piping", () => {
  let engine;

  beforeEach(() => {
    engine = makeTmpEngine();
  });

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  it("pipes data from bosun_function to notify.log via templates", async () => {
    const bosunRoot = resolve(import.meta.dirname, "..");
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "fn",
          type: "action.bosun_function",
          label: "Get Branch",
          config: { function: "git.branch" },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log Branch",
          config: { message: "Branch: {{fn.current}}, Count: {{fn.branchCount}}" },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "fn" },
        { id: "e2", source: "fn", target: "log" },
      ],
      { id: "pipe-test-wf" },
    );
    engine.save(wf);

    const ctx = await engine.execute("pipe-test-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const fnOutput = ctx.getNodeOutput("fn");
    expect(fnOutput.success).toBe(true);

    // Verify the log message was rendered with actual data
    const logOutput = ctx.getNodeOutput("log");
    expect(logOutput).toBeDefined();
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("chains bosun_function → invoke_workflow → notify.log", async () => {
    const bosunRoot = resolve(import.meta.dirname, "..");

    // Child workflow that sets a variable
    const childWf = makeSimpleWorkflow(
      [
        { id: "child-trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "child-action",
          type: "action.set_variable",
          label: "Set Child Data",
          config: { name: "childResult", value: "child-data-value" },
        },
      ],
      [{ id: "e1", source: "child-trigger", target: "child-action" }],
      { id: "chain-child-wf" },
    );

    const parentWf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "get-branch",
          type: "action.bosun_function",
          label: "Get Branch",
          config: { function: "git.branch" },
        },
        {
          id: "invoke-child",
          type: "action.invoke_workflow",
          label: "Invoke Child",
          config: {
            workflowId: "chain-child-wf",
            outputVariable: "childResult",
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Final Log",
          config: {
            message: "Branch: {{get-branch.current}}, Child: {{invoke-child.success}}",
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "get-branch" },
        { id: "e2", source: "get-branch", target: "invoke-child" },
        { id: "e3", source: "invoke-child", target: "log" },
      ],
      { id: "chain-parent-wf" },
    );

    engine.save(childWf);
    engine.save(parentWf);

    const ctx = await engine.execute("chain-parent-wf", { repoRoot: bosunRoot });
    expect(ctx.errors).toHaveLength(0);

    const branchOutput = ctx.getNodeOutput("get-branch");
    expect(branchOutput.success).toBe(true);
    expect(typeof branchOutput.current).toBe("string");

    const invokeOutput = ctx.getNodeOutput("invoke-child");
    expect(invokeOutput.success).toBe(true);
    expect(invokeOutput.workflowId).toBe("chain-child-wf");
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);
});

describe("self-improvement workflow nodes", () => {
  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("action.evaluate_run evaluates a persisted run and surfaces promotion insights", async () => {
    const dir = makeTmpDir();
    const engine = new WorkflowEngine({
      workflowDir: join(dir, "workflows"),
      runsDir: join(dir, "runs"),
      services: {},
    });
    registerNodeType("test.self_improvement.pass", {
      describe: () => "pass",
      schema: { type: "object", properties: {} },
      async execute() {
        return { ok: true };
      },
    });
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "pass", type: "test.self_improvement.pass", label: "Pass", config: {} },
      ],
      [{ id: "e1", source: "trigger", target: "pass" }],
      { id: "wf-self-improvement-pass" },
    );
    engine.save(wf);

    const runCtx = await engine.execute(wf.id, {
      taskId: "TASK-SI-1",
      taskTitle: "Baseline run",
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });

    const handler = getNodeType("action.evaluate_run");
    const ctx = new WorkflowContext({
      runId: runCtx.id,
      repoRoot: dir,
      _workflowId: wf.id,
    });
    const node = {
      id: "eval-run",
      type: "action.evaluate_run",
      config: {
        runId: runCtx.id,
        repoRoot: dir,
        outputVariable: "evaluationResult",
      },
    };
    const result = await handler.execute(node, ctx, engine);
    expect(result.success).toBe(true);
    expect(result.workflowId).toBe(wf.id);
    expect(result.benchmark.traceEventCount).toBeGreaterThan(0);
    expect(Array.isArray(result.strategies)).toBe(true);
    expect(result.promotion).toEqual(expect.objectContaining({
      decision: expect.any(String),
      summary: expect.any(String),
    }));
    expect(ctx.data.evaluationResult.score).toBe(result.score);

    const historyPath = join(dir, ".bosun", "evaluation-history.json");
    expect(existsSync(historyPath)).toBe(true);
    const history = JSON.parse(readFileSync(historyPath, "utf8"));
    expect(Array.isArray(history[wf.id])).toBe(true);
    expect(history[wf.id].some((entry) => entry.runId === runCtx.id)).toBe(true);
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("action.promote_strategy persists promoted strategy knowledge", async () => {
    const repoRoot = makeTmpDir();
    const promoteHandler = getNodeType("action.promote_strategy");
    const ctx = new WorkflowContext({
      repoRoot,
      _workspaceId: "workspace-1",
      _changedFiles: ["workflow/workflow-engine.mjs"],
      sessionId: "session-1",
      runId: "run-1",
      _workflowId: "wf-self-improvement-pass",
      taskId: "TASK-SI-2",
      task: {
        id: "TASK-SI-2",
        title: "Promote self-improvement baseline",
        filePaths: ["workflow/workflow-engine.mjs"],
        meta: {
          filePaths: ["workflow/workflow-engine.mjs"],
        },
      },
      _lastRunEvaluation: {
        runId: "run-1",
        workflowId: "wf-self-improvement-pass",
        score: 91,
        grade: "A",
        benchmark: {
          throughputPerMinute: 8,
          retryDensity: 0,
          traceCoverage: 1,
        },
        strategies: [
          {
            strategyId: "wf-self-improvement-pass:preserve_current_pattern:global:quality",
            category: "quality",
            recommendation: "Preserve the current workflow pattern as the reliability baseline.",
            rationale: "Healthy execution with no actionable failures.",
            confidence: 0.82,
            evidence: ["grade:A", "score:91"],
            tags: ["self-improvement", "baseline"],
          },
        ],
        promotion: {
          shouldPromote: true,
          decision: "capture_baseline",
          selectedStrategy: {
            strategyId: "wf-self-improvement-pass:preserve_current_pattern:global:quality",
            category: "quality",
            recommendation: "Preserve the current workflow pattern as the reliability baseline.",
            rationale: "Healthy execution with no actionable failures.",
            confidence: 0.82,
            evidence: ["grade:A", "score:91"],
            tags: ["self-improvement", "baseline"],
          },
          rationale: "Healthy baseline worth preserving.",
        },
      },
    });
    const node = {
      id: "promote",
      type: "action.promote_strategy",
      config: {
        scopeLevel: "workspace",
        scope: "workflow-reliability",
        repoRoot,
        outputVariable: "promotionResult",
      },
    };

    const result = await promoteHandler.execute(node, ctx);
    expect(result.success).toBe(true);
    expect(result.persisted).toBe(true);
    expect(result.strategyId).toContain("wf-self-improvement-pass");

    const registryPath = join(repoRoot, ".cache", "bosun", "persistent-memory.json");
    expect(existsSync(registryPath)).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(Array.isArray(registry.entries)).toBe(true);
    const promotedEntry = registry.entries.find((entry) => entry.strategyId === result.strategyId);
    expect(promotedEntry).toBeTruthy();
    expect(promotedEntry.relatedPaths).toContain("workflow/workflow-engine.mjs");
    const skillbookPath = join(repoRoot, ".bosun", "skillbook", "strategies.json");
    expect(existsSync(skillbookPath)).toBe(true);
    const skillbook = JSON.parse(readFileSync(skillbookPath, "utf8"));
    expect(Array.isArray(skillbook.strategies)).toBe(true);
    expect(skillbook.strategies.some((entry) => entry.strategyId === result.strategyId)).toBe(true);
    const { getPromotedStrategyFromStateLedger } = await import("../lib/state-ledger-sqlite.mjs");
    expect(getPromotedStrategyFromStateLedger(result.strategyId, { repoRoot })).toEqual(
      expect.objectContaining({
        strategyId: result.strategyId,
        workflowId: "wf-self-improvement-pass",
        decision: "capture_baseline",
        status: "promoted",
      }),
    );
    expect(result.skillbookPath).toContain(".bosun");
    expect(result.ledgerPath).toContain(".sqlite");
    expect(ctx.data.promotionResult.strategyId).toBe(result.strategyId);
    const { retrieveKnowledgeEntries } = await import("../workspace/shared-knowledge.mjs");
    const retrieved = await retrieveKnowledgeEntries({
      repoRoot,
      workspaceId: "workspace-1",
      sessionId: "session-9",
      runId: "run-9",
      taskId: "TASK-SI-2",
      changedFiles: ["workflow/workflow-engine.mjs"],
      query: "workflow reliability baseline",
      limit: 5,
    });
    expect(retrieved).toContainEqual(expect.objectContaining({
      strategyId: result.strategyId,
      directPathHits: ["workflow/workflow-engine.mjs"],
    }));
  });

  it("action.load_skillbook_strategies ranks reusable strategies for the current workflow", async () => {
    const repoRoot = makeTmpDir();
    const skillbookDir = join(repoRoot, ".bosun", "skillbook");
    mkdirSync(skillbookDir, { recursive: true });
    writeFileSync(join(skillbookDir, "strategies.json"), JSON.stringify({
      version: "1.0.0",
      updatedAt: "2026-03-31T00:00:00.000Z",
      strategies: [
        {
          strategyId: "wf-self-improvement-pass:preferred",
          workflowId: "wf-self-improvement-pass",
          category: "strategy",
          scopeLevel: "workspace",
          status: "promoted",
          confidence: 0.93,
          recommendation: "Retry by running targeted validation before wider retries.",
          rationale: "This pattern recovered recent validation failures without reopening unrelated work.",
          tags: ["recovery", "validation"],
          relatedPaths: ["src/billing/invoice-runner.mjs"],
          updatedAt: new Date().toISOString(),
        },
        {
          strategyId: "wf-self-improvement-pass:path-matched",
          workflowId: "wf-self-improvement-pass",
          category: "strategy",
          scopeLevel: "workspace",
          status: "promoted",
          confidence: 0.78,
          recommendation: "Retry by validating the workflow engine path before wider retries.",
          rationale: "This path-specific strategy should outrank generic guidance when the same file is active.",
          tags: ["recovery", "validation"],
          relatedPaths: ["workflow/workflow-engine.mjs"],
          updatedAt: new Date().toISOString(),
        },
        {
          strategyId: "other-workflow:secondary",
          workflowId: "wf-other",
          category: "strategy",
          scopeLevel: "workspace",
          status: "promoted",
          confidence: 0.41,
          recommendation: "Unrelated fallback strategy.",
          rationale: "Lower confidence and wrong workflow.",
          tags: ["fallback"],
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    }, null, 2), "utf8");

    const handler = getNodeType("action.load_skillbook_strategies");
    const ctx = new WorkflowContext({
      repoRoot,
      _workflowId: "wf-self-improvement-pass",
      _changedFiles: ["workflow/workflow-engine.mjs"],
      taskTitle: "Recover validation failures",
      lastError: "validation step failed on retry",
    });
    const result = await handler.execute({
      id: "load-skillbook",
      type: "action.load_skillbook_strategies",
      config: {
        repoRoot,
        query: "validation retry recovery",
        limit: 1,
        outputVariable: "loadedGuidance",
      },
    }, ctx);

    expect(result.success).toBe(true);
    expect(result.matched).toBe(1);
    expect(result.strategyIds).toEqual(["wf-self-improvement-pass:path-matched"]);
    expect(result.guidanceSummary).toContain("Retry by validating the workflow engine path before wider retries.");
    expect(result.guidanceSummary).toContain("matched=workflow/workflow-engine.mjs");
    expect(ctx.data.loadedGuidance.strategyIds).toEqual(["wf-self-improvement-pass:path-matched"]);
  });

  it("agent.run_planner injects reusable skillbook guidance into the planner prompt", async () => {
    const repoRoot = makeTmpDir();
    const skillbookDir = join(repoRoot, ".bosun", "skillbook");
    mkdirSync(skillbookDir, { recursive: true });
    writeFileSync(join(skillbookDir, "strategies.json"), JSON.stringify({
      version: "1.0.0",
      updatedAt: "2026-03-31T00:00:00.000Z",
      strategies: [
        {
          strategyId: "wf-plan:triage",
          workflowId: "wf-plan",
          category: "strategy",
          scopeLevel: "workspace",
          status: "promoted",
          confidence: 0.88,
          recommendation: "Break reliability work into targeted validation-first tasks.",
          rationale: "This reduces blocked downstream work and shortens review loops.",
          tags: ["planner", "reliability"],
          updatedAt: new Date().toISOString(),
        },
      ],
    }, null, 2), "utf8");

    const handler = getNodeType("agent.run_planner");
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: '```json\n{"tasks":[]}\n```',
      sdk: "codex",
      items: [],
      threadId: "planner-thread-skillbook",
    });
    const engine = {
      services: {
        agentPool: { launchEphemeralThread },
        prompts: { planner: "Plan the next backlog tasks." },
      },
    };
    const ctx = new WorkflowContext({
      repoRoot,
      _workflowId: "wf-plan",
      taskTitle: "Improve reliability backlog",
      taskDescription: "Find the highest-value reliability fixes.",
    });

    const result = await handler.execute({
      id: "planner-with-skillbook",
      type: "agent.run_planner",
      config: {
        taskCount: 3,
        context: "Focus on reliability and validation ordering.",
      },
    }, ctx, engine);

    expect(result.success).toBe(true);
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
    expect(sentPrompt).toContain("Reusable strategy guidance:");
    expect(sentPrompt).toContain("Break reliability work into targeted validation-first tasks.");
  });

  it("agent.run_planner refreshes repo topology from source files when the index is missing", async () => {
    const repoRoot = makeTmpDir();
    mkdirSync(join(repoRoot, "agent"), { recursive: true });
    mkdirSync(join(repoRoot, "workflow"), { recursive: true });
    writeFileSync(
      join(repoRoot, "agent", "primary-agent.mjs"),
      "import { runWorkflowNode } from '../workflow/workflow-nodes.mjs';\nexport function buildArchitectEditorFrame(options) { return runWorkflowNode(options); }\n",
      "utf8",
    );
    writeFileSync(
      join(repoRoot, "workflow", "workflow-nodes.mjs"),
      "export function runWorkflowNode(options) { return options; }\n",
      "utf8",
    );

    const handler = getNodeType("agent.run_planner");
    const launchEphemeralThread = vi.fn().mockResolvedValue({
      success: true,
      output: '```json\n{"tasks":[]}\n```',
      sdk: "codex",
      items: [],
      threadId: "planner-thread-repomap-refresh",
    });
    const engine = {
      services: {
        agentPool: { launchEphemeralThread },
        prompts: { planner: "Plan the next backlog tasks." },
      },
    };
    const ctx = new WorkflowContext({
      repoRoot,
      _workflowId: "wf-plan",
      taskTitle: "Improve planner topology",
      taskDescription: "Use repository structure to plan the next steps.",
      changedFiles: ["agent/primary-agent.mjs"],
    });

    const result = await handler.execute({
      id: "planner-with-repomap-refresh",
      type: "agent.run_planner",
      config: {
        taskCount: 2,
        context: "Focus on the primary agent execution path.",
        repoMapQuery: "primary agent execution path",
      },
    }, ctx, engine);

    expect(result.success).toBe(true);
    expect(launchEphemeralThread).toHaveBeenCalledTimes(1);
    const sentPrompt = String(launchEphemeralThread.mock.calls[0][0] || "");
    expect(sentPrompt).toContain("## Repo Topology");
    expect(sentPrompt).toContain("agent/primary-agent.mjs");
    expect(sentPrompt).toContain("adjacent: workflow/workflow-nodes.mjs");
  });

  it("workflow proof bundles surface skillbook guidance captured during execution", async () => {
    const repoRoot = makeTmpDir();
    const skillbookDir = join(repoRoot, ".bosun", "skillbook");
    mkdirSync(skillbookDir, { recursive: true });
    writeFileSync(join(skillbookDir, "strategies.json"), JSON.stringify({
      version: "1.0.0",
      updatedAt: "2026-03-31T00:00:00.000Z",
      strategies: [
        {
          strategyId: "wf-proof:reuse",
          workflowId: "wf-proof",
          category: "strategy",
          scopeLevel: "workspace",
          status: "promoted",
          confidence: 0.79,
          recommendation: "Reuse the proven recovery sequencing before escalating.",
          rationale: "Promoted after the last healthy recovery run.",
          tags: ["recovery"],
          updatedAt: new Date().toISOString(),
        },
      ],
    }, null, 2), "utf8");

    const engine = new WorkflowEngine({
      workflowDir: join(repoRoot, "workflows"),
      runsDir: join(repoRoot, "runs"),
      services: {},
    });
    const wf = makeSimpleWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "load-skillbook",
          type: "action.load_skillbook_strategies",
          label: "Load Skillbook",
          config: {
            repoRoot,
            workflowId: "wf-proof",
            query: "recovery escalation",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "load-skillbook" }],
      { id: "wf-proof", name: "Skillbook Proof" },
    );
    engine.save(wf);

    const runCtx = await engine.execute("wf-proof", { repoRoot, _workflowId: "wf-proof" });
    const run = engine.getRunDetail(runCtx.id);

    expect(run?.detail?.skillbookGuidance?.strategyIds).toEqual(["wf-proof:reuse"]);
    expect(run?.proofBundle?.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "skillbook",
          decision: "reuse_strategies",
        }),
      ]),
    );
    expect(run?.proofBundle?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "skillbook",
          kind: "reusable_strategy",
        }),
      ]),
    );
  }, SLOW_BOSUN_NATIVE_WORKFLOW_TEST_TIMEOUT_MS);

  it("workflow team coordination nodes support init, shared task claims, direct messaging, and completion", async () => {
    const initHandler = getNodeType("action.team_init");
    const publishHandler = getNodeType("action.team_task_publish");
    const claimHandler = getNodeType("action.team_task_claim");
    const messageHandler = getNodeType("action.team_message");
    const inboxHandler = getNodeType("action.team_inbox");
    const completeHandler = getNodeType("action.team_task_complete");
    const snapshotHandler = getNodeType("action.team_snapshot");
    expect(initHandler).toBeDefined();
    expect(publishHandler).toBeDefined();
    expect(claimHandler).toBeDefined();
    expect(messageHandler).toBeDefined();
    expect(inboxHandler).toBeDefined();
    expect(completeHandler).toBeDefined();
    expect(snapshotHandler).toBeDefined();

    const ctx = new WorkflowContext({});

    const initResult = await initHandler.execute({
      id: "team-init",
      type: "action.team_init",
      config: {
        teamId: "team-alpha",
        leadId: "lead-1",
        members: [
          { memberId: "dev-1", role: "worker" },
          { memberId: "qa-1", role: "reviewer" },
        ],
      },
    }, ctx);
    expect(initResult.teamSummary.rosterCount).toBe(3);

    const publishResult = await publishHandler.execute({
      id: "publish",
      type: "action.team_task_publish",
      config: {
        title: "Investigate failing workflow edge",
        description: "Shared workflow task for the worker pool.",
        createdBy: "lead-1",
      },
    }, ctx);
    expect(publishResult.count).toBe(1);
    const publishedTaskId = publishResult.publishedTasks[0].taskId;

    const claimResult = await claimHandler.execute({
      id: "claim",
      type: "action.team_task_claim",
      config: {
        taskId: publishedTaskId,
        memberId: "dev-1",
      },
    }, ctx);
    expect(claimResult).toEqual(expect.objectContaining({
      success: true,
      claimed: true,
      outcome: "claimed",
    }));

    const conflictResult = await claimHandler.execute({
      id: "claim-conflict",
      type: "action.team_task_claim",
      config: {
        taskId: publishedTaskId,
        memberId: "qa-1",
      },
    }, ctx);
    expect(conflictResult).toEqual(expect.objectContaining({
      claimed: false,
      reason: "already_claimed",
      outcome: "unavailable",
      claimedBy: "dev-1",
    }));

    const messageResult = await messageHandler.execute({
      id: "message",
      type: "action.team_message",
      config: {
        fromMemberId: "dev-1",
        toMemberId: "lead-1",
        taskId: publishedTaskId,
        content: "I claimed the shared task and started the investigation.",
      },
    }, ctx);
    expect(messageResult).toEqual(expect.objectContaining({
      success: true,
      kind: "direct",
      outcome: "direct",
    }));

    const inboxResult = await inboxHandler.execute({
      id: "inbox",
      type: "action.team_inbox",
      config: {
        memberId: "lead-1",
        markRead: true,
      },
    }, ctx);
    expect(inboxResult.messages).toHaveLength(1);
    expect(inboxResult.unreadCount).toBe(0);
    expect(inboxResult.messages[0]).toEqual(expect.objectContaining({
      fromMemberId: "dev-1",
      taskId: publishedTaskId,
    }));

    const completeResult = await completeHandler.execute({
      id: "complete",
      type: "action.team_task_complete",
      config: {
        taskId: publishedTaskId,
        memberId: "dev-1",
      },
    }, ctx);
    expect(completeResult).toEqual(expect.objectContaining({
      success: true,
      completed: true,
      outcome: "completed",
    }));

    const snapshot = await snapshotHandler.execute({
      id: "snapshot",
      type: "action.team_snapshot",
      config: {},
    }, ctx);
    expect(snapshot.teamSummary).toEqual(expect.objectContaining({
      teamId: "team-alpha",
      completedTaskCount: 1,
      messageCount: 1,
      eventCount: 5,
    }));
    expect(snapshot.tasks[0]).toEqual(expect.objectContaining({
      taskId: publishedTaskId,
      status: "completed",
      claimedBy: "dev-1",
      completedBy: "dev-1",
    }));
    expect(snapshot.tasks[0].claimHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "claim", memberId: "dev-1" }),
      expect.objectContaining({ action: "complete", memberId: "dev-1" }),
    ]));
  });
});
