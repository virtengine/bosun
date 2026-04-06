import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  expireApprovalRequest,
  getApprovalRequest,
  getHarnessRunApprovalRequest,
  reconcileHarnessRunApprovalRequests,
  reconcileWorkflowRunApprovalRequests,
  resolveApprovalQueuePath,
  resolveApprovalRequest,
  upsertApprovalRequest,
  upsertWorkflowRunApprovalRequest,
  upsertHarnessRunApprovalRequest,
} from "../workflow/approval-queue.mjs";
import {
  resetStateLedgerCache,
  getWorkflowRunDetailFromStateLedger,
  writeHarnessRunToStateLedger,
  writeWorkflowRunDetailToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";

const tempRoots = [];

function createHarnessRunFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), "bosun-harness-approval-queue-"));
  tempRoots.push(repoRoot);
  const runPath = resolve(repoRoot, ".cache", "harness", "runs", "run-123.json");
  mkdirSync(dirname(runPath), { recursive: true });
  writeFileSync(
    runPath,
    JSON.stringify({
      runId: "run-123",
      taskId: "TASK-123",
      status: "running",
      approvals: [],
      latestApproval: null,
    }, null, 2) + "\n",
    "utf8",
  );
  return { repoRoot, runPath };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

async function removeDirWithRetries(dirPath) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM") throw error;
      resetStateLedgerCache();
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

afterEach(async () => {
  resetStateLedgerCache();
  while (tempRoots.length > 0) {
    const repoRoot = tempRoots.pop();
    await removeDirWithRetries(repoRoot);
  }
});

describe("workflow approval queue", () => {
  it("persists harness-run approval resolutions into the approval queue and run record", () => {
    const { repoRoot, runPath } = createHarnessRunFixture();
    const created = upsertHarnessRunApprovalRequest({
      runId: "run-123",
      taskId: "TASK-123",
      taskTitle: "Harness Task",
      stageId: "gate",
      stageType: "gate",
      requestedBy: "harness",
      reason: "Harness run requires operator approval.",
      preview: "Waiting for operator.",
      mode: "manual",
      timeoutMs: 30_000,
    }, { repoRoot });

    expect(created.request).toMatchObject({
      requestId: "harness-run:run-123",
      scopeType: "harness-run",
      scopeId: "run-123",
      status: "pending",
      judgment: "ESCALATE",
      stageId: "gate",
    });
    expect(getHarnessRunApprovalRequest("run-123", { repoRoot })).toMatchObject({
      requestId: "harness-run:run-123",
      status: "pending",
    });

    const resolved = resolveApprovalRequest("harness-run:run-123", {
      repoRoot,
      decision: "approved",
      actorId: "reviewer",
      note: "Proceed.",
    });

    expect(resolved.request).toMatchObject({
      requestId: "harness-run:run-123",
      status: "approved",
      judgment: "ACCEPT",
      resolution: expect.objectContaining({
        actorId: "reviewer",
        note: "Proceed.",
        judgment: "ACCEPT",
      }),
    });
    expect(resolved.updateResult).toMatchObject({
      runId: "run-123",
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "approved",
        actorId: "reviewer",
        note: "Proceed.",
      }),
    });

    const queuePath = resolveApprovalQueuePath(repoRoot);
    expect(existsSync(queuePath)).toBe(true);
    expect(readJson(queuePath)).toMatchObject({
      version: 1,
      requests: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          status: "approved",
        }),
      ],
    });
    expect(readJson(runPath)).toMatchObject({
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "approved",
        actorId: "reviewer",
        note: "Proceed.",
      }),
      approvals: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          decision: "approved",
        }),
      ],
    });
  });

  it("marks harness-run approvals expired and appends the timeout resolution to the run record", () => {
    const { repoRoot, runPath } = createHarnessRunFixture();
    upsertHarnessRunApprovalRequest({
      runId: "run-123",
      taskId: "TASK-123",
      stageId: "gate",
      reason: "Timed approval gate.",
      timeoutMs: 1_000,
    }, { repoRoot });

    const expired = expireApprovalRequest("harness-run:run-123", {
      repoRoot,
      actorId: "system:timeout",
      note: "Approval gate timed out.",
    });

    expect(expired.request).toMatchObject({
      requestId: "harness-run:run-123",
      status: "expired",
      judgment: "ESCALATE",
      resolution: expect.objectContaining({
        actorId: "system:timeout",
        note: "Approval gate timed out.",
      }),
    });
    expect(expired.updateResult).toMatchObject({
      runId: "run-123",
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "expired",
        actorId: "system:timeout",
      }),
    });
    expect(readJson(runPath)).toMatchObject({
      latestApproval: expect.objectContaining({
        requestId: "harness-run:run-123",
        decision: "expired",
      }),
      approvals: [
        expect.objectContaining({
          requestId: "harness-run:run-123",
          decision: "expired",
        }),
      ],
    });
  });

  it("reads approvals from SQL first and resolves harness approvals when the legacy queue file is missing", () => {
    const { repoRoot, runPath } = createHarnessRunFixture();
    writeHarnessRunToStateLedger(readJson(runPath), {
      anchorPath: resolve(repoRoot, ".cache", "harness", "runs"),
    });

    upsertHarnessRunApprovalRequest({
      runId: "run-123",
      taskId: "TASK-123",
      stageId: "gate",
      reason: "SQL-backed harness approval.",
      timeoutMs: 1_000,
    }, { repoRoot });

    const queuePath = resolveApprovalQueuePath(repoRoot);
    expect(existsSync(queuePath)).toBe(true);
    unlinkSync(queuePath);

    expect(getHarnessRunApprovalRequest("run-123", { repoRoot })).toMatchObject({
      requestId: "harness-run:run-123",
      status: "pending",
    });

    unlinkSync(runPath);
    const resolved = resolveApprovalRequest("harness-run:run-123", {
      repoRoot,
      decision: "approved",
      actorId: "sql-reviewer",
      note: "resolved from SQL state",
    });

    expect(resolved.request).toMatchObject({
      requestId: "harness-run:run-123",
      status: "approved",
    });
    expect(resolved.updateResult).toMatchObject({
      runId: "run-123",
      latestApproval: expect.objectContaining({
        decision: "approved",
        actorId: "sql-reviewer",
      }),
    });
  });

  it("reconciles stale harness approvals when the run no longer exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-harness-approval-stale-"));
    tempRoots.push(repoRoot);
    upsertHarnessRunApprovalRequest({
      runId: "ghost-run",
      requestedBy: "voice",
      reason: "Stale voice approval.",
      timeoutMs: 0,
    }, { repoRoot });

    const reconciled = reconcileHarnessRunApprovalRequests({ repoRoot });

    expect(reconciled.repaired).toEqual([
      expect.objectContaining({
        requestId: "harness-run:ghost-run",
        runId: "ghost-run",
        status: "expired",
      }),
    ]);
    expect(getHarnessRunApprovalRequest("ghost-run", { repoRoot })).toMatchObject({
      requestId: "harness-run:ghost-run",
      status: "expired",
      resolution: expect.objectContaining({
        actorId: "system:reconcile",
      }),
    });
  });

  it("resolves workflow-run approvals from SQL detail when the legacy detail file is missing", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-workflow-approval-queue-"));
    tempRoots.push(repoRoot);
    const runsDir = resolve(repoRoot, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    writeWorkflowRunDetailToStateLedger("run-wf-1", {
      startedAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      data: {
        _workflowId: "wf-1",
        _workflowName: "Workflow SQL Approval",
        _executionPolicy: {
          mode: "manual",
          approvalRequired: true,
          approvalState: "pending",
          blocked: true,
        },
        _workflowGovernance: {
          policyOutcome: {
            blocked: true,
            status: "blocked",
          },
        },
      },
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
      },
      nodeStatuses: {},
      logs: [],
      errors: [],
    }, { anchorPath: runsDir });

    const created = upsertWorkflowRunApprovalRequest({
      runId: "run-wf-1",
      workflowId: "wf-1",
      workflowName: "Workflow SQL Approval",
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
      },
    }, { repoRoot });

    expect(created.request).toMatchObject({
      requestId: "workflow-run:run-wf-1",
      status: "pending",
    });
    unlinkSync(resolveApprovalQueuePath(repoRoot));

    expect(getApprovalRequest("workflow-run", "run-wf-1", { repoRoot })).toMatchObject({
      requestId: "workflow-run:run-wf-1",
      status: "pending",
    });

    const resolved = resolveApprovalRequest("workflow-run:run-wf-1", {
      repoRoot,
      decision: "approved",
      actorId: "workflow-sql-reviewer",
      note: "approved from SQL detail",
    });

    expect(resolved.request).toMatchObject({
      requestId: "workflow-run:run-wf-1",
      status: "approved",
    });
    expect(getWorkflowRunDetailFromStateLedger("run-wf-1", { anchorPath: runsDir })).toMatchObject({
      data: {
        _workflowApproval: expect.objectContaining({
          requestId: "workflow-run:run-wf-1",
          decision: "approved",
          actorId: "workflow-sql-reviewer",
        }),
        _executionPolicy: expect.objectContaining({
          approvalState: "approved",
          blocked: false,
        }),
      },
    });
  });

  it("expires orphaned workflow-run approvals during reconciliation when the run detail is gone", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-workflow-approval-reconcile-"));
    tempRoots.push(repoRoot);

    const created = upsertWorkflowRunApprovalRequest({
      runId: "run-missing-1",
      workflowId: "wf-missing-1",
      workflowName: "Missing Approval Workflow",
      taskId: "task-missing-1",
      taskTitle: "Missing approval task",
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
      },
    }, { repoRoot });

    expect(created.request).toMatchObject({
      requestId: "workflow-run:run-missing-1",
      status: "pending",
    });

    const reconciled = reconcileWorkflowRunApprovalRequests({ repoRoot });
    const reconciledRequest = reconciled.requests.find((entry) => entry.requestId === "workflow-run:run-missing-1");

    expect(reconciled.repaired).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: "workflow-run:run-missing-1",
        runId: "run-missing-1",
        status: "expired",
      }),
    ]));
    expect(reconciledRequest).toMatchObject({
      requestId: "workflow-run:run-missing-1",
      status: "expired",
      judgment: "ESCALATE",
      resolution: expect.objectContaining({
        actorId: "system:reconcile",
        note: "Workflow run run-missing-1 no longer exists.",
      }),
    });
  });

  it("maps expired workflow-gate requests with proceed policy to ACCEPT judgments", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-workflow-gate-approval-queue-"));
    tempRoots.push(repoRoot);

    const created = upsertApprovalRequest({
      scopeType: "workflow-gate",
      scopeId: "run-gate-1:gate-1",
      runId: "run-gate-1",
      workflowId: "wf-gate-1",
      nodeId: "gate-1",
      reason: "Proceed after timeout.",
      timeoutMs: 10,
      onTimeout: "proceed",
      mode: "manual",
    }, { repoRoot });

    expect(created.request).toMatchObject({
      status: "pending",
      judgment: "ESCALATE",
    });

    const expired = expireApprovalRequest("workflow-gate:run-gate-1:gate-1", {
      repoRoot,
      actorId: "system:timeout",
      note: "Timed out but allowed to proceed.",
    });

    expect(expired.request).toMatchObject({
      status: "expired",
      judgment: "ACCEPT",
      resolution: expect.objectContaining({
        judgment: "ACCEPT",
      }),
    });
    expect(getApprovalRequest("workflow-gate", "run-gate-1:gate-1", { repoRoot })).toMatchObject({
      status: "expired",
      judgment: "ACCEPT",
    });
  });
});
