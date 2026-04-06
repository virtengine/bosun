import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { WorkflowContext } from "../workflow/workflow-engine.mjs";
import {
  appendDelegationAuditEvent,
  buildDelegatedExecutionStateSnapshot,
  buildDelegationWatchdogDecision,
  extractDelegationGuardMap,
  getExecutionStateScopeView,
  getDelegationAuditTrail,
  normalizeDelegationGuardMap,
  setDelegationTransitionGuard,
} from "../workflow/delegation-runtime.mjs";

const workflowNodesSource = readFileSync(
  resolve(process.cwd(), "workflow", "workflow-nodes.mjs"),
  "utf8",
);
const workflowBoundaryDoc = readFileSync(
  resolve(process.cwd(), "workflow", "workflow-harness-boundaries.md"),
  "utf8",
);

describe("workflow harness boundaries", () => {
  it("keeps workflow-nodes.mjs as a composition shell over modular registrars", () => {
    expect(workflowNodesSource).toContain('import "./workflow-nodes/definitions.mjs";');
    expect(workflowNodesSource).toContain('import "./workflow-nodes/actions.mjs";');
    expect(workflowNodesSource).toContain('import "./workflow-nodes/flow.mjs";');
    expect(workflowNodesSource).toContain('export { registerNodeType, getNodeType, listNodeTypes, unregisterNodeType } from "./workflow-engine.mjs";');
    expect(workflowNodesSource).not.toContain("registerBuiltinNodeType(");
    expect(workflowNodesSource).not.toContain("runWorkflowNode(");
  });

  it("documents delegation-runtime as the shared owner for delegation watchdog and audit state", () => {
    expect(workflowBoundaryDoc).toContain("`workflow/delegation-runtime.mjs` owns delegation watchdog interpretation");
    expect(workflowBoundaryDoc).toContain("`workflow/workflow-nodes.mjs` is the public composition shell");
    expect(workflowBoundaryDoc).toContain("`workflow/workflow-nodes/agent.mjs` and `workflow/workflow-nodes/validation.mjs`");
    expect(workflowBoundaryDoc).toContain("they may not own provider routing, session lifecycle, or tool policy");
  });

  it("normalizes delegation guard and audit state through the shared runtime helpers", () => {
    const ctx = new WorkflowContext({
      _delegationTransitionGuards: {
        " assign-1 ": {
          transitionKey: "assign-1",
          status: "assigned",
        },
      },
      _delegationAuditTrail: [
        { type: "complete", at: 20, timestamp: "2026-04-03T00:00:20.000Z" },
        { type: "assign", at: 10, timestamp: "2026-04-03T00:00:10.000Z" },
      ],
    });

    expect(normalizeDelegationGuardMap(ctx.data._delegationTransitionGuards)).toEqual({
      "assign-1": {
        transitionKey: "assign-1",
        status: "assigned",
      },
    });
    expect(getDelegationAuditTrail(ctx).map((entry) => entry.type)).toEqual(["assign", "complete"]);

    appendDelegationAuditEvent(ctx, {
      type: "owner-mismatch",
      taskId: "task-1",
      claimToken: "claim-1",
      instanceId: "instance-1",
      at: 30,
    });
    appendDelegationAuditEvent(ctx, {
      type: "owner-mismatch",
      taskId: "task-1",
      claimToken: "claim-1",
      instanceId: "instance-1",
      at: 40,
    });

    expect(ctx.getDelegationAuditTrail().filter((entry) => entry.type === "owner-mismatch")).toHaveLength(1);
    expect(extractDelegationGuardMap({
      data: {
        _delegationTransitionGuards: ctx.data._delegationTransitionGuards,
      },
    })).toEqual({
      "assign-1": {
        transitionKey: "assign-1",
        status: "assigned",
      },
    });
  });

  it("makes watchdog retry and exhaustion decisions from canonical delegation state", () => {
    const startedAt = Date.now() - 10_000;

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "delegate-node",
          state: "delegated",
          timeoutMs: 1000,
          maxRecoveries: 2,
          recoveryAttempts: 1,
          startedAt,
        },
      },
    })).toMatchObject({
      type: "retry",
      mode: "from_failed",
      nodeId: "delegate-node",
      maxRecoveries: 2,
      recoveryAttempts: 1,
    });

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "delegate-node",
          state: "stalled",
          timeoutMs: 1000,
          maxRecoveries: 1,
          recoveryAttempts: 1,
          startedAt,
        },
      },
    })).toMatchObject({
      type: "exhausted",
      nodeId: "delegate-node",
      maxRecoveries: 1,
      recoveryAttempts: 1,
    });

    expect(buildDelegationWatchdogDecision({
      startedAt,
      data: {
        _delegationWatchdog: {
          nodeId: "task-scoped",
          state: "delegated",
          taskScoped: true,
          timeoutMs: 1000,
          startedAt,
        },
      },
    })).toBeNull();
  });

  it("creates inherited execution-state snapshots for delegated child workflows", () => {
    const parentCtx = new WorkflowContext({
      _workflowSessionId: "task-parent",
      _workflowRootSessionId: "task-parent",
      _workflowParentSessionId: "task-parent",
      _workflowRootRunId: "run-parent",
      _workflowDelegationDepth: 0,
      _delegatedSessionIds: ["task-parent"],
      _delegationAuditTrail: [
        {
          type: "assign",
          transitionKey: "assign:parent",
          taskId: "task-parent",
          at: 10,
          timestamp: "2026-04-06T00:00:10.000Z",
        },
      ],
      _delegationTransitionGuards: {
        "assign:parent": {
          transitionKey: "assign:parent",
          status: "completed",
        },
      },
    });
    parentCtx.__workflowRuntimeState = {
      delegationTransitionResults: {
        "claim:parent": { type: "claim_task", status: "completed" },
      },
    };

    const snapshot = buildDelegatedExecutionStateSnapshot(parentCtx, {
      workflowId: "child-workflow",
      nodeId: "delegate-node",
      childSessionId: "task-parent:child",
      parentSessionId: "task-parent",
      rootSessionId: "task-parent",
      parentRunId: "run-parent",
      rootRunId: "run-parent",
      delegationDepth: 1,
    });

    expect(snapshot.global.writable).toBe(false);
    expect(snapshot.stream.inherited.delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "task-parent" }),
    ]);
    expect(snapshot.execution.inherited.parentExecution).toEqual(
      expect.objectContaining({
        delegationTransitionResults: {
          "claim:parent": expect.objectContaining({ type: "claim_task" }),
        },
      }),
    );

    const childCtx = new WorkflowContext({
      _executionStateScopes: snapshot,
    });
    appendDelegationAuditEvent(childCtx, {
      type: "handoff-complete",
      transitionKey: "handoff:child",
      taskId: "task-parent",
      at: 20,
      timestamp: "2026-04-06T00:00:20.000Z",
    });
    setDelegationTransitionGuard(childCtx, "assign:child", {
      transitionKey: "assign:child",
      status: "queued",
    });

    expect(getExecutionStateScopeView(childCtx, "stream").delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "task-parent" }),
      expect.objectContaining({ type: "handoff-complete", taskId: "task-parent" }),
    ]);
    expect(getExecutionStateScopeView(childCtx, "stream").delegationTransitionGuards).toEqual({
      "assign:parent": expect.objectContaining({ status: "completed" }),
      "assign:child": expect.objectContaining({ status: "queued" }),
    });
    expect(parentCtx.data._delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "task-parent" }),
    ]);
  });
});
