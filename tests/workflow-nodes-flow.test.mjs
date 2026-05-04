/**
 * Tests for flow.try_catch and flow.parallel node types.
 *
 * Uses mock engines to verify sub-workflow execution, error handling,
 * retry logic, and parallel branch orchestration.
 */
import { describe, it, expect, vi } from "vitest";
import { getNodeType } from "../workflow/workflow-nodes.mjs";
import { WorkflowContext } from "../workflow/workflow-engine.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

/** Create a mock engine that tracks calls and returns controlled results. */
function makeMockEngine(executeFn) {
  return {
    execute: vi.fn(executeFn || (() => Promise.resolve({ id: "run-1", errors: [] }))),
  };
}

// ── flow.try_catch ──────────────────────────────────────────────────────────

describe("flow.try_catch node", () => {
  const nodeType = getNodeType("flow.try_catch");

  it("is registered", () => {
    expect(nodeType).toBeDefined();
    expect(nodeType.schema).toBeDefined();
  });

  it("success path — no catch/finally", async () => {
    const engine = makeMockEngine();
    const node = makeNode("flow.try_catch", { tryWorkflowId: "wf-try" });
    const ctx = makeCtx({ foo: "bar" });

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.hadError).toBe(false);
    expect(result.tryResult.success).toBe(true);
    expect(result.catchResult).toBeNull();
    expect(result.finallyResult).toBeNull();
    expect(result.attempts).toBe(1);
    expect(engine.execute).toHaveBeenCalledTimes(1);
  });

  it("catch path — try fails, catch executes", async () => {
    const engine = makeMockEngine(() => {
      throw new Error("boom");
    });
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      catchWorkflowId: "wf-catch",
    });
    const ctx = makeCtx();

    // Override engine.execute to succeed on catch workflow
    let callCount = 0;
    engine.execute.mockImplementation((wfId) => {
      callCount++;
      if (wfId === "wf-try") throw new Error("boom");
      return Promise.resolve({ id: "catch-run", errors: [] });
    });

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.hadError).toBe(true);
    expect(result.errorMessage).toBe("boom");
    expect(result.catchResult).toBeTruthy();
    expect(result.catchResult.executed).toBe(true);
    expect(ctx.data.$error).toBeTruthy();
    expect(ctx.data.$error.message).toBe("boom");
  });

  it("finally always executes after success", async () => {
    let finallyCalled = false;
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-finally") finallyCalled = true;
        return Promise.resolve({ id: "run-x", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      finallyWorkflowId: "wf-finally",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.hadError).toBe(false);
    expect(result.finallyResult).toBeTruthy();
    expect(result.finallyResult.executed).toBe(true);
    expect(finallyCalled).toBe(true);
  });

  it("finally executes after catch", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-try") throw new Error("fail");
        return Promise.resolve({ id: "run-x", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      catchWorkflowId: "wf-catch",
      finallyWorkflowId: "wf-finally",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.hadError).toBe(true);
    expect(result.catchResult.executed).toBe(true);
    expect(result.finallyResult.executed).toBe(true);
  });

  it("retries on failure before falling to catch", async () => {
    let attempts = 0;
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-try") {
          attempts++;
          if (attempts < 3) return Promise.reject(new Error(`fail-${attempts}`));
          return Promise.resolve({ id: "success-run", errors: [] });
        }
        return Promise.resolve({ id: "other-run", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      maxRetries: 3,
      retryDelayMs: 1, // minimal delay for fast tests
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    // On 3rd attempt, engine.execute succeeds and tryResult.success is true
    expect(result.tryResult.success).toBe(true);
    expect(result.hadError).toBe(false);
    expect(result.attempts).toBe(3);
    // engine.execute was called 3 times for the try workflow
    expect(engine.execute).toHaveBeenCalledTimes(3);
  });

  it("exhausts retries then falls to catch", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-try") throw new Error("always-fail");
        return Promise.resolve({ id: "catch-run", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      catchWorkflowId: "wf-catch",
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.hadError).toBe(true);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.catchResult.executed).toBe(true);
  });

  it("propagateError re-throws after catch", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-try") throw new Error("must-propagate");
        return Promise.resolve({ id: "run-x", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      catchWorkflowId: "wf-catch",
      propagateError: true,
    });
    const ctx = makeCtx();

    await expect(nodeType.execute(node, ctx, engine)).rejects.toThrow("must-propagate");
  });

  it("custom errorVariable name", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-try") throw new Error("custom-var-test");
        return Promise.resolve({ id: "run-x", errors: [] });
      }),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
      errorVariable: "myError",
    });
    const ctx = makeCtx();

    await nodeType.execute(node, ctx, engine);

    expect(ctx.data.myError).toBeTruthy();
    expect(ctx.data.myError.message).toBe("custom-var-test");
  });

  it("propagates parent/root run lineage into try/catch child workflows", async () => {
    const engine = {
      execute: vi.fn(() => Promise.resolve({ id: "wf-try-run", errors: [] })),
    };
    const node = makeNode("flow.try_catch", {
      tryWorkflowId: "wf-try",
    });
    const ctx = makeCtx({
      _workflowId: "parent-workflow",
      _workflowRootRunId: "root-run-1",
    });

    await nodeType.execute(node, ctx, engine);

    expect(engine.execute).toHaveBeenCalledWith(
      "wf-try",
      expect.objectContaining({
        _parentWorkflowId: "parent-workflow",
        _workflowParentRunId: ctx.id,
        _workflowRootRunId: "root-run-1",
        _workflowStack: ["parent-workflow", "wf-try"],
      }),
      expect.objectContaining({
        _parentRunId: ctx.id,
        _rootRunId: "root-run-1",
      }),
    );
  });

  it("passthrough when no tryWorkflowId", async () => {
    const engine = makeMockEngine();
    const node = makeNode("flow.try_catch", {});
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.tryResult.success).toBe(true);
    expect(result.tryResult.passthrough).toBe(true);
    expect(engine.execute).not.toHaveBeenCalled();
  });
});

describe("action.execute_workflow node", () => {
  const nodeType = getNodeType("action.execute_workflow");

  it("clears its timeout guard after a sync child workflow resolves", async () => {
    vi.useFakeTimers();
    try {
      const engine = {
        get: vi.fn(() => ({ id: "wf-child" })),
        execute: vi.fn(() => Promise.resolve({ id: "run-child", errors: [], data: {} })),
      };
      const node = makeNode("action.execute_workflow", {
        workflowId: "wf-child",
        timeout: 5000,
      });
      const ctx = makeCtx({ _workflowId: "wf-parent" });

      const result = await nodeType.execute(node, ctx, engine);

      expect(result.success).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── flow.parallel ───────────────────────────────────────────────────────────

describe("flow.parallel node", () => {
  const nodeType = getNodeType("flow.parallel");

  it("is registered", () => {
    expect(nodeType).toBeDefined();
    expect(nodeType.schema).toBeDefined();
  });

  it("returns empty results for no branches", async () => {
    const engine = makeMockEngine();
    const node = makeNode("flow.parallel", { branches: [] });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.branches).toEqual([]);
    expect(result.successCount).toBe(0);
    expect(result.failCount).toBe(0);
  });

  it("throws when engine.execute is missing", async () => {
    const node = makeNode("flow.parallel", {
      branches: [{ name: "a", workflowId: "wf-a" }],
    });
    const ctx = makeCtx();

    await expect(nodeType.execute(node, ctx, {})).rejects.toThrow(/engine/i);
  });

  it("all-settled runs all branches to completion", async () => {
    const engine = makeMockEngine((wfId) =>
      Promise.resolve({ id: `run-${wfId}`, errors: [] }),
    );
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "a", workflowId: "wf-a" },
        { name: "b", workflowId: "wf-b" },
      ],
      failStrategy: "all-settled",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.successCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(result.results.a.success).toBe(true);
    expect(result.results.b.success).toBe(true);
    expect(result.totalBranches).toBe(2);
  });

  it("all-settled captures individual branch failures", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-b") return Promise.reject(new Error("branch-b-failed"));
        return Promise.resolve({ id: "run-a", errors: [] });
      }),
    };
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "a", workflowId: "wf-a" },
        { name: "b", workflowId: "wf-b" },
      ],
      failStrategy: "all-settled",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.successCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.results.a.success).toBe(true);
    expect(result.results.b.success).toBe(false);
    expect(result.results.b.error).toContain("branch-b-failed");
  });

  it("clears all-settled timeout guards after branches finish early", async () => {
    vi.useFakeTimers();
    try {
      const engine = makeMockEngine((wfId) =>
        Promise.resolve({ id: `run-${wfId}`, errors: [] }),
      );
      const node = makeNode("flow.parallel", {
        branches: [
          { name: "a", workflowId: "wf-a" },
          { name: "b", workflowId: "wf-b" },
        ],
        failStrategy: "all-settled",
        timeoutMs: 5000,
      });
      const ctx = makeCtx();

      const result = await nodeType.execute(node, ctx, engine);

      expect(result.successCount).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-fast reports first failure", async () => {
    const engine = {
      execute: vi.fn((wfId) => {
        if (wfId === "wf-a") return Promise.reject(new Error("fast-fail"));
        return Promise.resolve({ id: "run-b", errors: [] });
      }),
    };
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "a", workflowId: "wf-a" },
        { name: "b", workflowId: "wf-b" },
      ],
      failStrategy: "fail-fast",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.failCount).toBeGreaterThanOrEqual(1);
  });

  it("clears fail-fast timeout guards after a branch fails immediately", async () => {
    vi.useFakeTimers();
    try {
      const engine = {
        execute: vi.fn((wfId) => {
          if (wfId === "wf-a") return Promise.reject(new Error("fast-fail"));
          return Promise.resolve({ id: "run-b", errors: [] });
        }),
      };
      const node = makeNode("flow.parallel", {
        branches: [
          { name: "a", workflowId: "wf-a" },
          { name: "b", workflowId: "wf-b" },
        ],
        failStrategy: "fail-fast",
        timeoutMs: 5000,
      });
      const ctx = makeCtx();

      const result = await nodeType.execute(node, ctx, engine);

      expect(result.failCount).toBeGreaterThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes branch-specific data overrides", async () => {
    const engine = {
      execute: vi.fn((wfId, data) =>
        Promise.resolve({ id: `run-${wfId}`, errors: [], data }),
      ),
    };
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "a", workflowId: "wf-a", data: { extra: 42 } },
      ],
      failStrategy: "all-settled",
    });
    const ctx = makeCtx({ base: true });

    await nodeType.execute(node, ctx, engine);

    const call = engine.execute.mock.calls[0];
    const passedData = call[1];
    expect(passedData.base).toBe(true);
    expect(passedData.extra).toBe(42);
    expect(passedData._parallelBranch).toBe("a");
  });

  it("propagates lineage into parallel branch workflow executions", async () => {
    const engine = {
      execute: vi.fn((wfId, data) =>
        Promise.resolve({ id: `run-${wfId}`, errors: [], data }),
      ),
    };
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "a", workflowId: "wf-a", data: { extra: 42 } },
      ],
      failStrategy: "all-settled",
    });
    const ctx = makeCtx({
      base: true,
      _workflowId: "parent-workflow",
      _workflowRootRunId: "root-run-1",
    });

    await nodeType.execute(node, ctx, engine);

    expect(engine.execute).toHaveBeenCalledWith(
      "wf-a",
      expect.objectContaining({
        base: true,
        extra: 42,
        _parallelBranch: "a",
        _parentWorkflowId: "parent-workflow",
        _workflowParentRunId: ctx.id,
        _workflowRootRunId: "root-run-1",
        _workflowStack: ["parent-workflow", "wf-a"],
      }),
      expect.objectContaining({
        _parentRunId: ctx.id,
        _rootRunId: "root-run-1",
      }),
    );
  });

  it("handles branch with missing workflowId", async () => {
    const engine = makeMockEngine();
    const node = makeNode("flow.parallel", {
      branches: [
        { name: "bad", workflowId: "" },
        { name: "good", workflowId: "wf-good" },
      ],
      failStrategy: "all-settled",
    });
    const ctx = makeCtx();

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.results.bad.success).toBe(false);
    expect(result.results.bad.error).toContain("Missing");
    expect(result.results.good.success).toBe(true);
  });
});
