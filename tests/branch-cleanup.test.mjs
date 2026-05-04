import { describe, it, expect, beforeEach, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

let cleanupStaleBranches;

let TEST_DIR = "";
let now = 0;
let gitState = null;

/**
 * Helper: initialise a bare-bones git repo with an initial commit on `main`,
 * then optionally create local-only branches for testing.
 */
function initTestRepo() {
  now = Date.now();
  TEST_DIR = "/tmp/branch-cleanup-test";
  gitState = {
    currentBranch: "main",
    branches: ["main"],
    worktrees: new Set(),
    commitTimes: { main: now - 7 * 24 * 60 * 60 * 1000 },
    remoteBranches: new Set(),
    mergedBranches: new Set(),
    aheadCounts: new Map(),
  };
}

function branchExists(name) {
  return gitState.branches.includes(name);
}

describe("cleanupStaleBranches", () => {
  beforeEach(() => {
    vi.resetModules();
    initTestRepo();
    spawnSyncMock.mockImplementation((_cmd, args) => {
      const [command, ...rest] = args;
      if (command === "rev-parse" && rest[0] === "--abbrev-ref") {
        return { status: 0, stdout: `${gitState.currentBranch}\n` };
      }
      if (command === "worktree" && rest[0] === "list") {
        const entries = [...gitState.worktrees].map(
          (branch) => `worktree /tmp/${branch}\nbranch refs/heads/${branch}\n`,
        );
        return { status: 0, stdout: entries.join("\n") };
      }
      if (command === "for-each-ref") {
        return {
          status: 0,
          stdout: gitState.branches.length ? `${gitState.branches.join("\n")}\n` : "",
        };
      }
      if (command === "log" && rest[0] === "-1") {
        const branch = rest[2];
        const commitTime = gitState.commitTimes[branch];
        if (!commitTime) return { status: 1, stdout: "" };
        return { status: 0, stdout: `${Math.floor(commitTime / 1000)}\n` };
      }
      if (command === "rev-parse" && rest[0] === "--verify") {
        const ref = rest[1] || "";
        const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
        if (match && gitState.remoteBranches.has(match[1])) {
          return { status: 0, stdout: `${ref}\n` };
        }
        return { status: 1, stdout: "" };
      }
      if (command === "rev-list" && rest[0] === "--count") {
        const range = rest[1] || "";
        const branch = range.split("..")[1];
        const ahead = gitState.aheadCounts.get(branch) || 0;
        return { status: 0, stdout: `${ahead}\n` };
      }
      if (command === "branch" && rest[0] === "--merged") {
        const branch = rest[3];
        const merged = gitState.mergedBranches.has(branch);
        return { status: 0, stdout: merged ? `${branch}\n` : "" };
      }
      if (command === "branch" && rest[0] === "-D") {
        const branch = rest[1];
        if (!gitState.branches.includes(branch)) {
          return { status: 1, stdout: "", stderr: "branch not found" };
        }
        gitState.branches = gitState.branches.filter((b) => b !== branch);
        gitState.remoteBranches.delete(branch);
        gitState.mergedBranches.delete(branch);
        gitState.aheadCounts.delete(branch);
        delete gitState.commitTimes[branch];
        return { status: 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    });
  });

  beforeEach(async () => {
    ({ cleanupStaleBranches } = await import("../infra/maintenance.mjs"));
  });

  function createBranch(name, { backdateMs, merged = false, remote = false, ahead = 0 } = {}) {
    if (!gitState.branches.includes(name)) {
      gitState.branches.push(name);
    }
    const ageMs = backdateMs ?? 0;
    gitState.commitTimes[name] = now - ageMs;
    if (merged) gitState.mergedBranches.add(name);
    if (remote) gitState.remoteBranches.add(name);
    if (ahead) gitState.aheadCounts.set(name, ahead);
  }

  it("should return empty results when no VE branches exist", () => {
    gitState.branches = ["main", "feature/alpha"];
    const result = cleanupStaleBranches(TEST_DIR);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("should skip protected branches", () => {
    // main already exists as the init branch and is protected by default
    const result = cleanupStaleBranches(TEST_DIR, { minAgeMs: 0 });
    // main should never appear in deleted
    expect(result.deleted).not.toContain("main");
  });

  it("should skip branches that are too recent", () => {
    // Create a ve/ branch without backdating — it's just seconds old
    createBranch("ve/test-recent", { backdateMs: 1000 });
    const result = cleanupStaleBranches(TEST_DIR);
    expect(result.deleted).toEqual([]);
    const skipped = result.skipped.find((s) => s.branch === "ve/test-recent");
    expect(skipped).toBeDefined();
    expect(skipped.reason).toBe("too-recent");
  });

  it("should skip the currently checked-out branch", () => {
    createBranch("ve/current-branch", {
      backdateMs: 2 * 24 * 60 * 60 * 1000,
      merged: true,
    });
    gitState.currentBranch = "ve/current-branch";
    const result = cleanupStaleBranches(TEST_DIR, { minAgeMs: 0 });
    expect(result.deleted).toEqual([]);
    const skipped = result.skipped.find(
      (s) => s.branch === "ve/current-branch",
    );
    expect(skipped).toBeDefined();
    expect(skipped.reason).toBe("checked-out");
  });

  it("should delete old merged branches", () => {
    // Create a ve/ branch, merge it into main, backdate it
    const twodays = 2 * 24 * 60 * 60 * 1000;
    createBranch("ve/old-merged", { backdateMs: twodays, merged: true });

    expect(branchExists("ve/old-merged")).toBe(true);
    const result = cleanupStaleBranches(TEST_DIR);
    expect(result.deleted).toContain("ve/old-merged");
    expect(branchExists("ve/old-merged")).toBe(false);
  });

  it("should skip old branches that are not pushed and not merged", () => {
    const twodays = 2 * 24 * 60 * 60 * 1000;
    createBranch("ve/old-unmerged", { backdateMs: twodays });

    const result = cleanupStaleBranches(TEST_DIR);
    const skipped = result.skipped.find((s) => s.branch === "ve/old-unmerged");
    expect(skipped).toBeDefined();
    expect(skipped.reason).toBe("not-pushed-not-merged");
    expect(branchExists("ve/old-unmerged")).toBe(true);
  });

  it("should support dry-run mode", () => {
    const twodays = 2 * 24 * 60 * 60 * 1000;
    createBranch("ve/dry-run-test", { backdateMs: twodays, merged: true });

    const result = cleanupStaleBranches(TEST_DIR, { dryRun: true });
    expect(result.deleted).toContain("ve/dry-run-test");
    // Branch should still exist because it's dry-run
    expect(branchExists("ve/dry-run-test")).toBe(true);
  });

  it("should only target specified patterns", () => {
    const twodays = 2 * 24 * 60 * 60 * 1000;
    createBranch("ve/should-target", { backdateMs: twodays, merged: true });
    createBranch("feature/should-ignore", { backdateMs: twodays, merged: true });

    const result = cleanupStaleBranches(TEST_DIR);
    expect(result.deleted).toContain("ve/should-target");
    // feature/ branch should not be touched
    expect(branchExists("feature/should-ignore")).toBe(true);
  });

  it("should handle custom patterns", () => {
    const twodays = 2 * 24 * 60 * 60 * 1000;
    createBranch("custom/old-branch", { backdateMs: twodays, merged: true });

    const result = cleanupStaleBranches(TEST_DIR, {
      patterns: ["custom/"],
    });
    expect(result.deleted).toContain("custom/old-branch");
  });

  it("should handle null repoRoot gracefully", () => {
    const result = cleanupStaleBranches(null);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("should respect custom minAgeMs", () => {
    // Branch is ~1 hour old
    const oneHour = 60 * 60 * 1000;
    createBranch("ve/hour-old", { backdateMs: oneHour + 5000, merged: true });

    // With default 24h threshold, should skip
    const result1 = cleanupStaleBranches(TEST_DIR, {
      minAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(result1.deleted).not.toContain("ve/hour-old");

    // With 30min threshold, should delete
    const result2 = cleanupStaleBranches(TEST_DIR, {
      minAgeMs: 30 * 60 * 1000,
    });
    expect(result2.deleted).toContain("ve/hour-old");
  });
});
