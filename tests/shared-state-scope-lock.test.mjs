import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";

vi.mock("../infra/presence.mjs", () => ({
  getPresenceState: vi.fn(() => ({
    instance_id: "test-instance-1",
    coordinator_priority: 100,
  })),
  buildLocalPresence: vi.fn(() => ({
    instance_id: "test-instance-1",
    coordinator_priority: 100,
  })),
  notePresence: vi.fn(async () => ({})),
  listActiveInstances: vi.fn(() => []),
  selectCoordinator: vi.fn(() => ({ instance_id: "coordinator-instance" })),
  initPresence: vi.fn(async () => ({})),
}));

describe("shared-state scope locks", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "scope-lock-test-"));
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(async () => {
    if (tempRoot) {
      resetStateLedgerCache();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("acquires and releases scope locks through the shared-state lifecycle", async () => {
    const {
      claimTaskInSharedState,
      releaseSharedState,
    } = await import("../workspace/shared-state-manager.mjs");
    const { getTaskScopeLocks } = await import("../workspace/scope-locks.mjs");

    const claimResult = await claimTaskInSharedState(
      "task-1",
      "ws-1/agent-1",
      "token-1",
      300,
      tempRoot,
      {
        metadata: {
          filePaths: ["src/runtime/feature.mjs"],
        },
      },
    );

    expect(claimResult.success).toBe(true);
    expect(claimResult.state.scopePaths).toHaveLength(1);

    const locksAfterClaim = await getTaskScopeLocks("task-1", tempRoot);
    expect(locksAfterClaim).toHaveLength(1);
    expect(locksAfterClaim[0].relativePath).toBe("src/runtime/feature.mjs");
    expect(locksAfterClaim[0].attemptToken).toBe("token-1");

    const releaseResult = await releaseSharedState(
      "task-1",
      "token-1",
      "complete",
      undefined,
      tempRoot,
    );

    expect(releaseResult.success).toBe(true);
    expect(await getTaskScopeLocks("task-1", tempRoot)).toHaveLength(0);
  });

  it("allows the same owner to reclaim the same scope with a new attempt token", async () => {
    const { claimTaskInSharedState } = await import("../workspace/shared-state-manager.mjs");
    const { getTaskScopeLocks } = await import("../workspace/scope-locks.mjs");

    const firstClaim = await claimTaskInSharedState(
      "task-1",
      "ws-1/agent-1",
      "token-1",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );
    expect(firstClaim.success).toBe(true);

    const secondClaim = await claimTaskInSharedState(
      "task-1",
      "ws-1/agent-1",
      "token-2",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );

    expect(secondClaim.success).toBe(true);
    expect(secondClaim.state.attemptToken).toBe("token-2");

    const locks = await getTaskScopeLocks("task-1", tempRoot);
    expect(locks).toHaveLength(1);
    expect(locks[0].attemptToken).toBe("token-2");
  });

  it("rejects a different task that tries to claim an active locked path", async () => {
    const { claimTaskInSharedState } = await import("../workspace/shared-state-manager.mjs");

    const firstClaim = await claimTaskInSharedState(
      "task-1",
      "ws-1/agent-1",
      "token-1",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );
    expect(firstClaim.success).toBe(true);

    const secondClaim = await claimTaskInSharedState(
      "task-2",
      "ws-2/agent-2",
      "token-2",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );

    expect(secondClaim.success).toBe(false);
    expect(secondClaim.reason).toBe("scope_lock_conflict");
    expect(secondClaim.scopeLockConflict?.existing?.taskId).toBe("task-1");
  });

  it("releases scope locks when a stale shared-state entry is swept", async () => {
    const {
      claimTaskInSharedState,
      sweepStaleSharedStates,
    } = await import("../workspace/shared-state-manager.mjs");
    const { getTaskScopeLocks } = await import("../workspace/scope-locks.mjs");

    const claimResult = await claimTaskInSharedState(
      "task-stale",
      "ws-1/agent-1",
      "token-1",
      1,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );
    expect(claimResult.success).toBe(true);
    expect(await getTaskScopeLocks("task-stale", tempRoot)).toHaveLength(1);

    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));

    const sweepResult = await sweepStaleSharedStates(1000, tempRoot);
    expect(sweepResult.sweptCount).toBe(1);
    expect(await getTaskScopeLocks("task-stale", tempRoot)).toHaveLength(0);
  }, 15000);

  it("fails heartbeat renewal when expected scope locks are missing", async () => {
    const {
      claimTaskInSharedState,
      renewSharedStateHeartbeat,
    } = await import("../workspace/shared-state-manager.mjs");
    const { releaseScopeLocks, getTaskScopeLocks } = await import("../workspace/scope-locks.mjs");

    const claimResult = await claimTaskInSharedState(
      "task-renew",
      "ws-1/agent-1",
      "token-1",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/feature.mjs"] },
      },
    );
    expect(claimResult.success).toBe(true);
    expect(await getTaskScopeLocks("task-renew", tempRoot)).toHaveLength(1);

    await releaseScopeLocks({
      taskId: "task-renew",
      ownerId: "ws-1/agent-1",
      attemptToken: "token-1",
      repoRoot: tempRoot,
    });

    const renewResult = await renewSharedStateHeartbeat(
      "task-renew",
      "ws-1/agent-1",
      "token-1",
      tempRoot,
    );

    expect(renewResult.success).toBe(false);
    expect(renewResult.reason).toBe("scope_lock_owner_mismatch");
    expect(await getTaskScopeLocks("task-renew", tempRoot)).toHaveLength(0);
  });

  it("restores prior scope locks when a force-claim cannot acquire the new scope", async () => {
    const {
      claimTaskInSharedState,
      forceClaimTaskInSharedState,
      getSharedState,
    } = await import("../workspace/shared-state-manager.mjs");
    const { getTaskScopeLocks } = await import("../workspace/scope-locks.mjs");

    const originalClaim = await claimTaskInSharedState(
      "task-force",
      "ws-1/agent-1",
      "token-1",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/original.mjs"] },
      },
    );
    expect(originalClaim.success).toBe(true);

    const blockerClaim = await claimTaskInSharedState(
      "task-blocker",
      "ws-2/agent-2",
      "token-2",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/blocked.mjs"] },
      },
    );
    expect(blockerClaim.success).toBe(true);

    const forceResult = await forceClaimTaskInSharedState(
      "task-force",
      "ws-3/agent-3",
      "token-3",
      300,
      tempRoot,
      {
        metadata: { filePaths: ["src/runtime/blocked.mjs"] },
      },
    );

    expect(forceResult.success).toBe(false);
    expect(forceResult.reason).toBe("scope_lock_conflict");

    const originalLocks = await getTaskScopeLocks("task-force", tempRoot);
    expect(originalLocks).toHaveLength(1);
    expect(originalLocks[0].relativePath).toBe("src/runtime/original.mjs");
    expect(originalLocks[0].ownerId).toBe("ws-1/agent-1");
    expect(originalLocks[0].attemptToken).toBe("token-1");

    const sharedState = await getSharedState("task-force", tempRoot);
    expect(sharedState?.ownerId).toBe("ws-1/agent-1");
    expect(sharedState?.attemptToken).toBe("token-1");
  });

  it("rolls back a local task claim when shared-state scope locks conflict", async () => {
    const { initTaskClaims, claimTask, getClaim } = await import("../task/task-claims.mjs");
    await initTaskClaims({ repoRoot: tempRoot });

    const firstClaim = await claimTask({
      taskId: "task-1",
      instanceId: "instance-1",
      metadata: {
        filePaths: ["src/runtime/feature.mjs"],
      },
    });
    expect(firstClaim.success).toBe(true);

    const secondClaim = await claimTask({
      taskId: "task-2",
      instanceId: "instance-2",
      metadata: {
        filePaths: ["src/runtime/feature.mjs"],
      },
    });

    expect(secondClaim.success).toBe(false);
    expect(secondClaim.error).toBe("scope_lock_conflict");
    expect(await getClaim("task-2")).toBeNull();
  });

  it("creates explicit execution, stream, and global scope snapshots with inherited state boundaries", async () => {
    const {
      createInheritedExecutionStateScopes,
      getExecutionStateScopeEntry,
      normalizeExecutionStateScopes,
      updateExecutionStateScope,
    } = await import("../workspace/shared-state-manager.mjs");

    let scopes = normalizeExecutionStateScopes({
      execution: {
        current: {
          delegationTransitionResults: {
            "claim:parent": { type: "claim_task", status: "completed" },
          },
        },
      },
      stream: {
        current: {
          delegationAuditTrail: [{ type: "assign", taskId: "task-1" }],
          delegationTransitionGuards: {
            "assign:task-1": { status: "completed" },
          },
        },
      },
      global: {
        current: {
          workflowRootRunId: "run-root",
          workflowSessionId: "task-1",
        },
      },
    });

    scopes = updateExecutionStateScope(scopes, "execution", (current) => ({
      ...current,
      localOnly: true,
    }), { merge: true });

    const inherited = createInheritedExecutionStateScopes(scopes, {
      execution: {
        inherited: {
          parentExecution: getExecutionStateScopeEntry(scopes, "execution").current,
        },
        current: {
          localOnly: false,
        },
      },
      stream: {
        current: {
          delegationAuditTrail: [],
          delegationTransitionGuards: {},
        },
      },
      global: {
        current: {
          workflowSessionId: "task-1:child",
        },
        writable: false,
      },
    });

    expect(getExecutionStateScopeEntry(inherited, "execution").inherited.parentExecution).toEqual(
      expect.objectContaining({
        delegationTransitionResults: {
          "claim:parent": expect.objectContaining({ type: "claim_task" }),
        },
        localOnly: true,
      }),
    );
    expect(getExecutionStateScopeEntry(inherited, "stream").inherited.delegationAuditTrail).toEqual([
      expect.objectContaining({ type: "assign", taskId: "task-1" }),
    ]);
    expect(getExecutionStateScopeEntry(inherited, "global").writable).toBe(false);
    expect(getExecutionStateScopeEntry(inherited, "global").current.workflowSessionId).toBe("task-1:child");
  });
});
