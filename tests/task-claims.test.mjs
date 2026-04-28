import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { resolve } from "node:path";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";

// Mock presence.mjs before importing task-claims.mjs
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
  selectCoordinator: vi.fn(() => ({
    instance_id: "coordinator-instance",
  })),
  initPresence: vi.fn(async () => ({})),
}));

describe("task-claims", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "codex-claims-"));
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

  describe("initTaskClaims", () => {
    it("initializes with default settings", async () => {
      const { initTaskClaims } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });
      // Should not throw
    });
  });

  describe("claimTask", () => {
    let initTaskClaims, claimTask, getClaim;

    beforeEach(async () => {
      vi.resetModules();
      ({ initTaskClaims, claimTask, getClaim } = await import(
        "../task/task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("claims a task successfully", async () => {
      const result = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        ttlMinutes: 30,
      });

      expect(result.success).toBe(true);
      expect(result.token).toBeTruthy();
      expect(result.claim).toBeDefined();
      expect(result.claim.task_id).toBe("task-1");
      expect(result.claim.instance_id).toBe("instance-1");
      expect(result.claim.ttl_minutes).toBe(30);
    });

    it("returns idempotent result for same token", async () => {
      const token = "idempotent-token-123";
      const result1 = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        claimToken: token,
      });

      expect(result1.success).toBe(true);

      const result2 = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        claimToken: token,
      });

      expect(result2.success).toBe(true);
      expect(result2.idempotent).toBe(true);
      expect(result2.token).toBe(token);
    });

    it("rejects duplicate claim from different instance", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const result = await claimTask({
        taskId: "task-1",
        instanceId: "instance-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("task_already_claimed");
      expect(result.existing_instance).toBe("instance-1");
    });

    it("stores claim metadata", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        metadata: { branch: "ve/task-1", agent: "codex" },
      });

      const claim = await getClaim("task-1");
      expect(claim.metadata.branch).toBe("ve/task-1");
      expect(claim.metadata.agent).toBe("codex");
    });

    it("registers explicit claim owners in presence when granting a claim", async () => {
      const { notePresence } = vi.mocked(await import("../infra/presence.mjs"));

      const result = await claimTask({
        taskId: "task-presence",
        instanceId: "instance-explicit",
      });

      expect(result.success).toBe(true);
      expect(notePresence).toHaveBeenCalledWith(
        expect.objectContaining({ instance_id: "instance-explicit" }),
        expect.objectContaining({ source: "task-claim" }),
      );
    });

    it("reclaims a task when existing owner is stale/offline and shared state accepts the takeover", async () => {
      vi.resetModules();
      const claimInSharedStateMock = vi.fn(async () => ({ success: true }));
      vi.doMock("../workspace/shared-state-manager.mjs", () => ({
        claimTaskInSharedState: claimInSharedStateMock,
        renewSharedStateHeartbeat: vi.fn(async () => ({ success: true })),
        releaseSharedState: vi.fn(async () => ({ success: true })),
      }));

      try {
        const { listActiveInstances } = vi.mocked(await import("../infra/presence.mjs"));
        const freshClaims = await import("../task/task-claims.mjs");
        await freshClaims.initTaskClaims({ repoRoot: tempRoot });

        await freshClaims.claimTask({
          taskId: "task-stale",
          instanceId: "instance-1",
        });
        const registry = await freshClaims._test.loadClaimsRegistry();
        registry.claims["task-stale"].metadata = {
          ...(registry.claims["task-stale"].metadata || {}),
          host: hostname(),
          pid: 999999,
        };
        await freshClaims._test.saveClaimsRegistry(registry);

        listActiveInstances.mockReturnValueOnce([{ instance_id: "instance-2" }]);
        const result = await freshClaims.claimTask({
          taskId: "task-stale",
          instanceId: "instance-2",
        });

        expect(result.success).toBe(true);
        expect(result.resolution?.override).toBe(true);
        expect(result.resolution?.reason).toBe("owner_stale");
        expect(result.claim.instance_id).toBe("instance-2");
        expect(claimInSharedStateMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.doUnmock("../workspace/shared-state-manager.mjs");
        vi.resetModules();
      }
    });

    it("does not reclaim when existing owner is active", async () => {
      const { listActiveInstances } = vi.mocked(await import("../infra/presence.mjs"));
      await claimTask({
        taskId: "task-active",
        instanceId: "instance-1",
      });

      listActiveInstances.mockReturnValue([{ instance_id: "instance-1" }]);
      const result = await claimTask({
        taskId: "task-active",
        instanceId: "instance-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("task_already_claimed");
      expect(result.existing_instance).toBe("instance-1");
    });
  });

  describe("shared state claim rollback", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
      vi.unmock("../workspace/shared-state-manager.mjs");
    });

    it("rolls back a new local claim when shared state reports active owner", async () => {
      const claimInSharedStateMock = vi.fn(async () => ({
        success: false,
        reason: "existing_owner_active",
      }));

      vi.doMock("../workspace/shared-state-manager.mjs", () => ({
        claimTaskInSharedState: claimInSharedStateMock,
        renewSharedStateHeartbeat: vi.fn(async () => ({ success: true })),
        releaseSharedState: vi.fn(async () => ({ success: true })),
      }));

      const { initTaskClaims, claimTask, getClaim } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });

      const result = await claimTask({
        taskId: "task-shared-conflict",
        instanceId: "instance-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("existing_owner_active");
      expect(await getClaim("task-shared-conflict")).toBeNull();
      expect(claimInSharedStateMock).toHaveBeenCalledTimes(1);
    });

    it("rolls back a new local claim when shared state prefixes the active-owner conflict reason", async () => {
      const claimInSharedStateMock = vi.fn(async () => ({
        success: false,
        reason: "conflict: existing_owner_active",
      }));

      vi.doMock("../workspace/shared-state-manager.mjs", () => ({
        claimTaskInSharedState: claimInSharedStateMock,
        renewSharedStateHeartbeat: vi.fn(async () => ({ success: true })),
        releaseSharedState: vi.fn(async () => ({ success: true })),
      }));

      const { initTaskClaims, claimTask, getClaim } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });

      const result = await claimTask({
        taskId: "task-shared-prefixed-conflict",
        instanceId: "instance-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("existing_owner_active");
      expect(await getClaim("task-shared-prefixed-conflict")).toBeNull();
      expect(claimInSharedStateMock).toHaveBeenCalledTimes(1);
    });

    it("restores previous local owner when override sync fails", async () => {
      const claimInSharedStateMock = vi
        .fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, reason: "existing_owner_active" });

      vi.doMock("../workspace/shared-state-manager.mjs", () => ({
        claimTaskInSharedState: claimInSharedStateMock,
        renewSharedStateHeartbeat: vi.fn(async () => ({ success: true })),
        releaseSharedState: vi.fn(async () => ({ success: true })),
      }));

      const { listActiveInstances, selectCoordinator } = vi.mocked(
        await import("../infra/presence.mjs"),
      );
      listActiveInstances.mockReturnValue([{ instance_id: "instance-1" }, { instance_id: "coordinator" }]);
      selectCoordinator.mockReturnValue({ instance_id: "coordinator" });

      const { initTaskClaims, claimTask, getClaim } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });

      const first = await claimTask({
        taskId: "task-shared-override",
        instanceId: "instance-1",
      });
      expect(first.success).toBe(true);

      const second = await claimTask({
        taskId: "task-shared-override",
        instanceId: "coordinator",
      });

      expect(second.success).toBe(false);
      expect(second.error).toBe("existing_owner_active");

      const persisted = await getClaim("task-shared-override");
      expect(persisted?.instance_id).toBe("instance-1");
      expect(claimInSharedStateMock).toHaveBeenCalledTimes(2);
    });
    it("forfeits local claim when shared heartbeat reports owner mismatch", async () => {
      const claimInSharedStateMock = vi.fn(async () => ({ success: true }));
      const renewSharedStateHeartbeatMock = vi
        .fn()
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, reason: "owner_mismatch" });

      vi.doMock("../workspace/shared-state-manager.mjs", () => ({
        claimTaskInSharedState: claimInSharedStateMock,
        renewSharedStateHeartbeat: renewSharedStateHeartbeatMock,
        releaseSharedState: vi.fn(async () => ({ success: true })),
      }));

      const { initTaskClaims, claimTask, renewClaim, getClaim } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });

      const first = await claimTask({
        taskId: "task-shared-renew-mismatch",
        instanceId: "instance-1",
      });
      expect(first.success).toBe(true);

      const beforeRenew = await getClaim("task-shared-renew-mismatch");
      expect(beforeRenew?.renewed_at).toBeFalsy();

      const renewedOnce = await renewClaim({
        taskId: "task-shared-renew-mismatch",
        claimToken: first.token,
        instanceId: "instance-1",
      });
      expect(renewedOnce.success).toBe(true);

      const snapshotBeforeFatal = await getClaim("task-shared-renew-mismatch");
      expect(snapshotBeforeFatal?.renewed_at).toBeTruthy();

      const renewedTwice = await renewClaim({
        taskId: "task-shared-renew-mismatch",
        claimToken: first.token,
        instanceId: "instance-1",
      });
      expect(renewedTwice.success).toBe(false);
      expect(renewedTwice.error).toBe("owner_mismatch");

      const afterFatal = await getClaim("task-shared-renew-mismatch");
      expect(afterFatal).toBeNull();
      expect(renewSharedStateHeartbeatMock).toHaveBeenCalledTimes(2);
    });
  });
  describe("releaseTask", () => {
    let initTaskClaims, claimTask, releaseTask, getClaim;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, releaseTask, getClaim } = await import(
        "../task/task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("releases a claimed task", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-1",
      });

      expect(releaseResult.success).toBe(true);

      const claim = await getClaim("task-1");
      expect(claim).toBeNull();
    });

    it("rejects release from different instance without force", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        instanceId: "instance-2",
      });

      expect(releaseResult.success).toBe(false);
      expect(releaseResult.error).toBe("task_claimed_by_different_instance");
    });

    it("allows force release from different instance", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const releaseResult = await releaseTask({
        taskId: "task-1",
        instanceId: "instance-2",
        force: true,
      });

      expect(releaseResult.success).toBe(true);
    });

    it("returns error when releasing unclaimed task", async () => {
      const releaseResult = await releaseTask({
        taskId: "nonexistent-task",
        instanceId: "instance-1",
      });

      expect(releaseResult.success).toBe(false);
      expect(releaseResult.error).toBe("task_not_claimed");
    });
  });

  describe("renewClaim", () => {
    let initTaskClaims, claimTask, renewClaim, getClaim;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, renewClaim, getClaim } = await import(
        "../task/task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("renews a claim with new TTL", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
        ttlMinutes: 30,
      });

      const originalExpiry = claimResult.claim.expires_at;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-1",
        ttlMinutes: 60,
      });

      expect(renewResult.success).toBe(true);
      expect(renewResult.claim.expires_at).not.toBe(originalExpiry);
      expect(renewResult.claim.ttl_minutes).toBe(60);
      expect(renewResult.claim.renewed_at).toBeTruthy();
    });

    it("rejects renewal from different instance", async () => {
      const claimResult = await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: claimResult.token,
        instanceId: "instance-2",
      });

      expect(renewResult.success).toBe(false);
      expect(renewResult.error).toBe("task_claimed_by_different_instance");
    });

    it("rejects renewal with wrong token", async () => {
      await claimTask({
        taskId: "task-1",
        instanceId: "instance-1",
      });

      const renewResult = await renewClaim({
        taskId: "task-1",
        claimToken: "wrong-token",
        instanceId: "instance-1",
      });

      expect(renewResult.success).toBe(false);
      expect(renewResult.error).toBe("claim_token_mismatch");
    });
  });

  describe("listClaims", () => {
    let initTaskClaims, claimTask, listClaims;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, listClaims } = await import(
        "../task/task-claims.mjs"
      ));
      const { listActiveInstances } = vi.mocked(await import("../infra/presence.mjs"));
      listActiveInstances.mockReturnValue([]);
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("lists all active claims", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const claims = await listClaims();

      expect(claims).toHaveLength(3);
    });

    it("filters claims by instance ID", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const claims = await listClaims({ instanceId: "instance-1" });

      expect(claims).toHaveLength(2);
      expect(claims.every((c) => c.instance_id === "instance-1")).toBe(true);
    });

    it("excludes expired claims by default", async () => {
      const { _test } = await import("../task/task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Manually create an expired claim
      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claims = await listClaims();

      expect(claims).toHaveLength(1);
      expect(claims[0].task_id).toBe("task-1");
    });

    it("excludes stale claims by default and rewrites the registry", async () => {
      const { _test } = await import("../task/task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-stale"] = {
        task_id: "task-stale",
        instance_id: "instance-stale",
        claim_token: "token-stale",
        claimed_at: new Date(Date.now() - 10_000).toISOString(),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
        metadata: {
          host: hostname(),
          pid: 999999,
        },
      };
      await _test.saveClaimsRegistry(registry);

      const claims = await listClaims();

      expect(claims).toHaveLength(1);
      expect(claims[0].task_id).toBe("task-1");
      expect(await _test.loadClaimsRegistry()).not.toHaveProperty(["claims", "task-stale"]);
    });

    it("keeps same-host live-pid claims when presence temporarily omits the owner", async () => {
      const { listActiveInstances } = vi.mocked(await import("../infra/presence.mjs"));
      const { _test } = await import("../task/task-claims.mjs");

      await claimTask({ taskId: "task-live", instanceId: "instance-live" });

      listActiveInstances.mockReturnValue([{ instance_id: "instance-other" }]);
      const claims = await listClaims();

      expect(claims).toHaveLength(1);
      expect(claims[0].task_id).toBe("task-live");
      expect(await _test.loadClaimsRegistry()).toHaveProperty(["claims", "task-live"]);
    });

    it("includes expired claims when requested", async () => {
      const { _test } = await import("../task/task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Manually create an expired claim
      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claims = await listClaims({ includeExpired: true });

      expect(claims).toHaveLength(2);
    });
  });

  describe("registry locking", () => {
    afterEach(() => {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    });

    it("does not let listClaims sweep overwrite a concurrent claim", async () => {
      vi.resetModules();

      let releaseFirstRename;
      const firstRenameBlocked = new Promise((resolveFirstRenameBlocked) => {
        releaseFirstRename = resolveFirstRenameBlocked;
      });
      let signalFirstRenameStarted;
      const firstRenameStarted = new Promise((resolveFirstRenameStarted) => {
        signalFirstRenameStarted = resolveFirstRenameStarted;
      });
      let renameCount = 0;

      vi.doMock("node:fs/promises", async () => {
        const actual = await vi.importActual("node:fs/promises");
        return {
          ...actual,
          rename: vi.fn(async (...args) => {
            renameCount += 1;
            if (renameCount === 1) {
              signalFirstRenameStarted();
              await firstRenameBlocked;
            }
            return actual.rename(...args);
          }),
        };
      });

      const freshClaims = await import("../task/task-claims.mjs");
      await freshClaims.initTaskClaims({ repoRoot: tempRoot });

      const claimsPath = resolve(tempRoot, ".cache", "bosun", "task-claims.json");
      await writeFile(
        claimsPath,
        JSON.stringify(
          {
            version: 1,
            claims: {
              "task-expired": {
                task_id: "task-expired",
                instance_id: "instance-expired",
                claim_token: "token-expired",
                claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
                ttl_minutes: 60,
              },
            },
            updated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );

      const listPromise = freshClaims.listClaims();
      await firstRenameStarted;

      const claimPromise = freshClaims.claimTask({
        taskId: "task-live",
        instanceId: "instance-live",
      });

      releaseFirstRename();
      await Promise.all([listPromise, claimPromise]);

      const registry = await freshClaims._test.loadClaimsRegistry();
      expect(registry).toHaveProperty(["claims", "task-live"]);
    });
  });

  describe("isTaskClaimed", () => {
    let initTaskClaims, claimTask, isTaskClaimed;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, isTaskClaimed } = await import(
        "../task/task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("returns true for claimed task", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      const claimed = await isTaskClaimed("task-1");
      expect(claimed).toBe(true);
    });

    it("returns false for unclaimed task", async () => {
      const claimed = await isTaskClaimed("nonexistent-task");
      expect(claimed).toBe(false);
    });

    it("returns false for expired claim", async () => {
      const { _test } = await import("../task/task-claims.mjs");

      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-1"] = {
        task_id: "task-1",
        instance_id: "instance-1",
        claim_token: "token-1",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const claimed = await isTaskClaimed("task-1");
      expect(claimed).toBe(false);
    });
  });

  describe("getClaimStats", () => {
    let initTaskClaims, claimTask, getClaimStats;

    beforeEach(async () => {
      ({ initTaskClaims, claimTask, getClaimStats } = await import(
        "../task/task-claims.mjs"
      ));
      await initTaskClaims({ repoRoot: tempRoot });
    });

    it("calculates statistics correctly", async () => {
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });
      await claimTask({ taskId: "task-2", instanceId: "instance-2" });
      await claimTask({ taskId: "task-3", instanceId: "instance-1" });

      const stats = await getClaimStats();

      expect(stats.total).toBe(3);
      expect(stats.active).toBe(3);
      expect(stats.expired).toBe(0);
      expect(stats.by_instance["instance-1"]).toBe(2);
      expect(stats.by_instance["instance-2"]).toBe(1);
    });

    it("counts expired claims separately", async () => {
      const { _test } = await import("../task/task-claims.mjs");

      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      const registry = await _test.loadClaimsRegistry();
      registry.claims["task-2"] = {
        task_id: "task-2",
        instance_id: "instance-1",
        claim_token: "token-2",
        claimed_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        ttl_minutes: 60,
      };
      await _test.saveClaimsRegistry(registry);

      const stats = await getClaimStats();

      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.expired).toBe(1);
    });
  });

  describe("resolveDuplicateClaim", () => {
    let _test;

    beforeEach(async () => {
      ({ _test } = await import("../task/task-claims.mjs"));
    });

    it("coordinator always wins against non-coordinator", async () => {
      const { getPresenceState, selectCoordinator } = vi.mocked(
        await import("../infra/presence.mjs"),
      );
      selectCoordinator.mockReturnValue({ instance_id: "coordinator" });

      const existing = {
        instance_id: "instance-1",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "coordinator",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 10,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_is_coordinator");
    });

    it("lower priority wins when neither is coordinator", async () => {
      const { selectCoordinator } = vi.mocked(await import("../infra/presence.mjs"));
      selectCoordinator.mockReturnValue({ instance_id: "other" });

      const existing = {
        instance_id: "instance-1",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-2",
        claimed_at: new Date().toISOString(),
        coordinator_priority: 50,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_lower_priority");
    });

    it("earlier timestamp wins when priorities are equal", async () => {
      const { selectCoordinator } = vi.mocked(await import("../infra/presence.mjs"));
      selectCoordinator.mockReturnValue(null);

      const earlier = new Date(Date.now() - 1000).toISOString();
      const later = new Date().toISOString();

      const existing = {
        instance_id: "instance-1",
        claimed_at: earlier,
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-2",
        claimed_at: later,
        coordinator_priority: 100,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(existing);
      expect(result.reason).toBe("existing_earlier");
    });

    it("uses instance ID as tie-breaker", async () => {
      const { selectCoordinator } = vi.mocked(await import("../infra/presence.mjs"));
      selectCoordinator.mockReturnValue(null);

      const timestamp = new Date().toISOString();

      const existing = {
        instance_id: "instance-b",
        claimed_at: timestamp,
        coordinator_priority: 100,
      };
      const newClaim = {
        instance_id: "instance-a",
        claimed_at: timestamp,
        coordinator_priority: 100,
      };

      const result = _test.resolveDuplicateClaim(existing, newClaim);

      expect(result.winner).toBe(newClaim);
      expect(result.reason).toBe("new_instance_id_lower");
    });
  });

  describe("sweepExpiredClaims", () => {
    let _test;

    beforeEach(async () => {
      ({ _test } = await import("../task/task-claims.mjs"));
    });

    it("removes expired claims", () => {
      const now = new Date();
      const registry = {
        version: 1,
        claims: {
          "task-1": {
            expires_at: new Date(now.getTime() - 1000).toISOString(),
          },
          "task-2": {
            expires_at: new Date(now.getTime() + 60000).toISOString(),
          },
          "task-3": {
            expires_at: new Date(now.getTime() - 5000).toISOString(),
          },
        },
      };

      const result = _test.sweepExpiredClaims(registry, now);

      expect(result.expiredCount).toBe(2);
      expect(Object.keys(result.registry.claims)).toHaveLength(1);
      expect(result.registry.claims["task-2"]).toBeDefined();
    });

    it("handles empty claims", () => {
      const registry = { version: 1, claims: {} };
      const result = _test.sweepExpiredClaims(registry);

      expect(result.expiredCount).toBe(0);
      expect(Object.keys(result.registry.claims)).toHaveLength(0);
    });
  });

  describe("coordinator override", () => {
    let initTaskClaims, claimTask;

    beforeEach(async () => {
      const { getPresenceState, selectCoordinator } = vi.mocked(
        await import("../infra/presence.mjs"),
      );

      ({ initTaskClaims, claimTask } = await import("../task/task-claims.mjs"));
      await initTaskClaims({ repoRoot: tempRoot });

      // Setup: instance-1 claims first
      getPresenceState.mockReturnValue({
        instance_id: "instance-1",
        coordinator_priority: 100,
      });
      selectCoordinator.mockReturnValue({ instance_id: "coordinator" });
    });

    it("coordinator can override existing non-coordinator claim", async () => {
      const { getPresenceState } = vi.mocked(await import("../infra/presence.mjs"));

      // First claim from non-coordinator
      getPresenceState.mockReturnValue({
        instance_id: "instance-1",
        coordinator_priority: 100,
      });
      await claimTask({ taskId: "task-1", instanceId: "instance-1" });

      // Coordinator claims
      getPresenceState.mockReturnValue({
        instance_id: "coordinator",
        coordinator_priority: 10,
      });
      const result = await claimTask({
        taskId: "task-1",
        instanceId: "coordinator",
      });

      expect(result.success).toBe(true);
      expect(result.resolution.override).toBe(true);
      expect(result.resolution.reason).toBe("new_is_coordinator");
    });
  });

  describe("saveClaimsRegistry", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.resetModules();
      vi.doUnmock("node:fs/promises");
    });

    it("preserves the last good registry when atomic replace keeps failing", async () => {
      const actualFs = await vi.importActual("node:fs/promises");
      const renameMock = vi.fn(async (from, to) => {
        if (String(to || "").endsWith("task-claims.json")) {
          const err = new Error("busy");
          err.code = "EINVAL";
          throw err;
        }
        return actualFs.rename(from, to);
      });
      const copyFileMock = vi.fn(actualFs.copyFile);
      const writeFileMock = vi.fn(actualFs.writeFile);

      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        rename: renameMock,
        copyFile: copyFileMock,
        writeFile: writeFileMock,
      }));

      const { initTaskClaims, _test } = await import("../task/task-claims.mjs");
      await initTaskClaims({ repoRoot: tempRoot });

      const cacheDir = resolve(tempRoot, ".cache/bosun");
      const registryPath = resolve(cacheDir, "task-claims.json");
      await actualFs.writeFile(
        registryPath,
        JSON.stringify(
          {
            version: 1,
            claims: {
              existing: {
                task_id: "existing",
                instance_id: "instance-1",
              },
            },
            updated_at: "2026-04-02T00:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      await expect(
        _test.saveClaimsRegistry({
          version: 1,
          claims: {
            replacement: {
              task_id: "replacement",
              instance_id: "instance-2",
            },
          },
        }),
      ).rejects.toThrow("Failed to replace claims registry atomically");

      const persisted = JSON.parse(await actualFs.readFile(registryPath, "utf8"));
      expect(persisted.claims.existing).toBeDefined();
      expect(persisted.claims.replacement).toBeUndefined();
      expect(copyFileMock).not.toHaveBeenCalled();

      const remainingFiles = await actualFs.readdir(cacheDir);
      expect(remainingFiles.some((name) => name.includes("task-claims.json.tmp-"))).toBe(false);
    });
  });

  describe("retryFsOperation", () => {
    let _test;

    beforeEach(async () => {
      ({ _test } = await import("../task/task-claims.mjs"));
    });

    it("retries retriable fs errors and eventually succeeds", async () => {
      const op = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }))
        .mockResolvedValueOnce("ok");

      const result = await _test.retryFsOperation(op, { maxRetries: 3, delayMs: 0 });

      expect(result).toBe("ok");
      expect(op).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retriable fs errors", async () => {
      const op = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("bad"), { code: "EINVAL" }));

      await expect(
        _test.retryFsOperation(op, { maxRetries: 3, delayMs: 0 }),
      ).rejects.toThrow("bad");
      expect(op).toHaveBeenCalledTimes(1);
    });
  });
});
