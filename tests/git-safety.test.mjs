import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

const { evaluateBranchSafetyForPush, normalizeBaseBranch } = await import(
  "../git/git-safety.mjs"
);

describe("git-safety", () => {
  let repoDir = "";
  let gitState = null;
  let gitConfig = null;

  function setGitState({ baseFiles = 0, headFiles = 0, diff = null, headPaths = null } = {}) {
    gitState = {
      fileCounts: new Map([
        ["origin/main", baseFiles],
        ["HEAD", headFiles],
      ]),
      treePaths: new Map([
        [
          "origin/main",
          Array.from({ length: baseFiles }, (_, i) => `file-${i}.txt`),
        ],
        [
          "HEAD",
          headPaths || Array.from({ length: headFiles }, (_, i) => `file-${i}.txt`),
        ],
      ]),
      diffStats: new Map([
        [
          "origin/main...HEAD",
          diff || { files: 0, inserted: 0, deleted: 0 },
        ],
      ]),
    };
  }

  beforeEach(() => {
    repoDir = "/tmp/git-safety";
    setGitState({
      baseFiles: 600,
      headFiles: 600,
      diff: { files: 0, inserted: 0, deleted: 0 },
    });
    gitConfig = new Map();
    spawnSyncMock.mockImplementation((_cmd, args) => {
      const [command, ...rest] = args;
      if (command === "ls-tree" && rest[0] === "-r") {
        const ref = rest[2];
        const files = gitState.treePaths.get(ref);
        if (files == null) {
          return { status: 1, stdout: "" };
        }
        return { status: 0, stdout: files.join("\n") };
      }
      if (command === "diff" && rest[0] === "--numstat") {
        const range = rest[1];
        const stats = gitState.diffStats.get(range);
        if (!stats) return { status: 1, stdout: "" };
        if (stats.files <= 0) return { status: 0, stdout: "" };
        const lines = [
          `${stats.inserted}\t${stats.deleted}\tfile-0.txt`,
          ...Array.from({ length: stats.files - 1 }, (_, i) => `0\t0\tfile-${i + 1}.txt`),
        ];
        return { status: 0, stdout: lines.join("\n") };
      }
      if (command === "config" && rest[0] === "--get") {
        const value = gitConfig.get(rest[1]);
        if (value == null) return { status: 1, stdout: "" };
        return { status: 0, stdout: value };
      }
      return { status: 1, stdout: "" };
    });
  });

  it("normalizes base branch names", () => {
    expect(normalizeBaseBranch("main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("refs/remotes/origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("origin/origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
  });

  it("flags README-only destructive branch states", async () => {
    setGitState({
      baseFiles: 600,
      headFiles: 1,
      diff: { files: 600, inserted: 0, deleted: 600 },
    });

    const safety = evaluateBranchSafetyForPush(repoDir, { baseBranch: "main" });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain("HEAD tracks only");
  });

  it("supports explicit bypass for emergency pushes", async () => {
    const prev = process.env.VE_ALLOW_DESTRUCTIVE_PUSH;
    process.env.VE_ALLOW_DESTRUCTIVE_PUSH = "1";
    try {
      const safety = evaluateBranchSafetyForPush(repoDir, {
        baseBranch: "main",
      });
      expect(safety.safe).toBe(true);
      expect(safety.bypassed).toBe(true);
    } finally {
      if (prev == null) delete process.env.VE_ALLOW_DESTRUCTIVE_PUSH;
      else process.env.VE_ALLOW_DESTRUCTIVE_PUSH = prev;
    }
  });

  it("blocks leaked test git identities", () => {
    const prev = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    try {
      const safety = evaluateBranchSafetyForPush(repoDir, { baseBranch: "main" });
      expect(safety.safe).toBe(false);
      expect(safety.reason).toContain("blocked test git identity");
    } finally {
      if (prev == null) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = prev;
    }
  });

  it("blocks known fixture repo signatures before push", () => {
    setGitState({
      baseFiles: 600,
      headFiles: 1,
      headPaths: [".github/agents/TaskPlanner.agent.md"],
      diff: { files: 600, inserted: 6, deleted: 514183 },
    });

    const safety = evaluateBranchSafetyForPush(repoDir, { baseBranch: "main" });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain("known test fixture signature");
    expect(safety.reason).toContain("TaskPlanner.agent.md");
  });
});
