import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
    execSync: vi.fn(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
    return {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      realpathSync: vi.fn((path) => String(path)),
      rmSync: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: Date.now(), isDirectory: () => true })),
      symlinkSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => "{}"),
    };
  });

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn(() => Promise.resolve("{}")),
    writeFile: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
    rm: vi.fn(() => Promise.resolve()),
  };
});

const ensureWorktreeRuntimeSetupMock = vi.hoisted(() => vi.fn(() => ({ ok: true })));
const inspectWorktreeRuntimeSetupMock = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  issues: [],
  hooksPath: ".githooks",
  missingFiles: [],
})));

vi.mock("../workspace/worktree-setup.mjs", () => ({
  ensureWorktreeRuntimeSetup: ensureWorktreeRuntimeSetupMock,
  inspectWorktreeRuntimeSetup: inspectWorktreeRuntimeSetupMock,
}));

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";

import {
  WorktreeManager,
  bootstrapWorktreeForPath,
  getWorktreeManager,
  resetWorktreeManager,
  sanitizeBranchName,
  gitEnv,
  fixGitConfigCorruption,
  TAG,
  DEFAULT_BASE_DIR,
  DEFAULT_MANAGED_TASK_BASE_DIR,
  MAX_WORKTREE_AGE_MS,
  COPILOT_WORKTREE_MAX_AGE_MS,
  GIT_ENV,
} from "../workspace/worktree-manager.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = "/fake/repo";

function normalizePath(value) {
  return String(value).replace(/\\/g, "/");
}

/** Build a porcelain `git worktree list` stdout string. */
function porcelainOutput(entries) {
  return (
    entries
      .map(
        (e) =>
          `worktree ${e.path}\nHEAD ${e.head ?? "abc123"}\nbranch ${e.branch}`,
      )
      .join("\n\n") + "\n\n"
  );
}

/** Set spawnSync to return a given result for calls whose args contain `needle`. */
function mockGit(needle, overrides = {}) {
  spawnSync.mockImplementation((cmd, args) => {
    if (Array.isArray(args) && args.some((a) => String(a).includes(needle))) {
      return { status: 0, stdout: "", stderr: "", ...overrides };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

function mockGitMulti(handlers) {
  spawnSync.mockImplementation((_cmd, args) => {
    for (const { match, result } of handlers) {
      if (Array.isArray(args) && args.some((a) => String(a).includes(match))) {
        return { status: 0, stdout: "", stderr: "", ...result };
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("worktree-manager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorktreeManager();
    existsSync.mockReturnValue(false);
    readdirSync.mockReturnValue([]);
    realpathSync.mockImplementation((path) => String(path));
    rmSync.mockReset();
    statSync.mockReturnValue({ mtimeMs: Date.now(), isDirectory: () => true });
    inspectWorktreeRuntimeSetupMock.mockReturnValue({
      ok: true,
      issues: [],
      hooksPath: ".githooks",
      missingFiles: [],
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // sanitizeBranchName
  // ────────────────────────────────────────────────────────────────────────

  describe("sanitizeBranchName", () => {
    it("replaces slashes with hyphens", () => {
      expect(sanitizeBranchName("ve/abc-my-feature")).toBe("ve-abc-my-feature");
    });

    it("handles nested slashes", () => {
      expect(sanitizeBranchName("feature/nested/deep")).toBe(
        "feature-nested-deep",
      );
    });

    it("strips refs/heads/ prefix", () => {
      expect(sanitizeBranchName("refs/heads/main")).toBe("main");
    });

    it("returns empty string for empty input", () => {
      expect(sanitizeBranchName("")).toBe("");
    });

    it("removes special characters", () => {
      expect(sanitizeBranchName("feat*?<>|branch")).toBe("featbranch");
    });

    it("preserves alphanumeric, dots, and hyphens", () => {
      expect(sanitizeBranchName("v1.0-rc1")).toBe("v1.0-rc1");
    });

    it("strips leading dots", () => {
      expect(sanitizeBranchName(".hidden")).toBe("hidden");
    });

    it("strips trailing dots", () => {
      expect(sanitizeBranchName("branch.")).toBe("branch");
    });

    it("truncates to 60 characters", () => {
      const long = "a".repeat(150);
      expect(sanitizeBranchName(long).length).toBe(60);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // gitEnv
  // ────────────────────────────────────────────────────────────────────────

  describe("gitEnv", () => {
    it("returns GIT_EDITOR set to ':'", () => {
      expect(gitEnv().GIT_EDITOR).toBe(":");
    });

    it("returns GIT_MERGE_AUTOEDIT set to 'no'", () => {
      expect(gitEnv().GIT_MERGE_AUTOEDIT).toBe("no");
    });

    it("returns GIT_TERMINAL_PROMPT set to '0'", () => {
      expect(gitEnv().GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("includes process.env values", () => {
      const env = gitEnv();
      // Should carry through common env vars (GIT_ENV overrides may differ)
      const pathKey = process.platform === "win32" ? "Path" : "PATH";
      expect(env[pathKey] || env.PATH).toBeTruthy();
      expect(env.HOME || env.USERPROFILE || env.HOMEDRIVE).toBeTruthy();
    });

    it("does not mutate process.env", () => {
      const before = { ...process.env };
      gitEnv();
      expect(process.env).toEqual(before);
    });

    it("strips inherited git plumbing variables", () => {
      const previous = {
        GIT_DIR: process.env.GIT_DIR,
        GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      };
      process.env.GIT_DIR = "/tmp/bad-dir";
      process.env.GIT_WORK_TREE = "/tmp/bad-tree";
      process.env.GIT_COMMON_DIR = "/tmp/bad-common";
      process.env.GIT_INDEX_FILE = "/tmp/bad-index";
      try {
        const env = gitEnv();
        expect(env.GIT_DIR).toBeUndefined();
        expect(env.GIT_WORK_TREE).toBeUndefined();
        expect(env.GIT_COMMON_DIR).toBeUndefined();
        expect(env.GIT_INDEX_FILE).toBeUndefined();
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value == null) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  describe("fixGitConfigCorruption", () => {
    it("repairs core.bare=true and unsets shared core.worktree", () => {
      existsSync.mockImplementation((path) => String(path).replace(/\\/g, "/").endsWith("/.git/worktrees"));
      spawnSync.mockImplementation((_cmd, args) => {
        if (args?.[0] === "config" && args?.[1] === "--bool" && args?.[2] === "--get" && args?.[3] === "core.bare") {
          return { status: 0, stdout: "true\n", stderr: "" };
        }
        if (args?.[0] === "config" && args?.[1] === "--local" && args?.[2] === "--get" && args?.[3] === "core.worktree") {
          return { status: 0, stdout: "/wrong/worktree\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      fixGitConfigCorruption(REPO_ROOT);

      expect(spawnSync).toHaveBeenCalledWith("git", ["config", "--local", "core.bare", "false"], expect.any(Object));
      expect(spawnSync).toHaveBeenCalledWith("git", ["config", "--local", "--unset-all", "core.worktree"], expect.any(Object));
    });

    it("repairs shared core.worktree even when core.bare is already false", () => {
      existsSync.mockImplementation((path) => String(path).replace(/\\/g, "/").endsWith("/.git/worktrees"));
      spawnSync.mockImplementation((_cmd, args) => {
        if (args?.[0] === "config" && args?.[1] === "--bool" && args?.[2] === "--get" && args?.[3] === "core.bare") {
          return { status: 0, stdout: "false\n", stderr: "" };
        }
        if (args?.[0] === "config" && args?.[1] === "--local" && args?.[2] === "--get" && args?.[3] === "core.worktree") {
          return { status: 0, stdout: "/wrong/worktree\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      fixGitConfigCorruption(REPO_ROOT);

      expect(spawnSync).not.toHaveBeenCalledWith("git", ["config", "--local", "core.bare", "false"], expect.any(Object));
      expect(spawnSync).toHaveBeenCalledWith("git", ["config", "--local", "--unset-all", "core.worktree"], expect.any(Object));
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GIT_ENV constant
  // ────────────────────────────────────────────────────────────────────────

  describe("GIT_ENV constant", () => {
    it("has GIT_EDITOR = ':'", () => {
      expect(GIT_ENV.GIT_EDITOR).toBe(":");
    });

    it("has GIT_MERGE_AUTOEDIT = 'no'", () => {
      expect(GIT_ENV.GIT_MERGE_AUTOEDIT).toBe("no");
    });

    it("has GIT_TERMINAL_PROMPT = '0'", () => {
      expect(GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Constants
  // ────────────────────────────────────────────────────────────────────────

  describe("Constants", () => {
    it("TAG equals '[worktree-manager]'", () => {
      expect(TAG).toBe("[worktree-manager]");
    });

    it("DEFAULT_BASE_DIR equals '.cache/worktrees'", () => {
      expect(DEFAULT_BASE_DIR).toBe(".cache/worktrees");
    });

    it("MAX_WORKTREE_AGE_MS equals 12 hours (43200000)", () => {
      expect(MAX_WORKTREE_AGE_MS).toBe(12 * 60 * 60 * 1000);
    });

    it("COPILOT_WORKTREE_MAX_AGE_MS equals 7 days", () => {
      expect(COPILOT_WORKTREE_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // WorktreeManager constructor
  // ────────────────────────────────────────────────────────────────────────

  describe("WorktreeManager constructor", () => {
    it("creates instance with repoRoot", () => {
      const mgr = new WorktreeManager(REPO_ROOT);
      expect(mgr.repoRoot).toContain("fake");
    });

    it("sets default baseDir from repoRoot + .cache/worktrees", () => {
      const mgr = new WorktreeManager(REPO_ROOT);
      expect(mgr.baseDir).toContain(".cache");
      expect(mgr.baseDir).toContain("worktrees");
    });

    it("accepts custom baseDir option", () => {
      const mgr = new WorktreeManager(REPO_ROOT, {
        baseDir: "custom/wt-dir",
      });
      expect(mgr.baseDir).toContain("custom");
      expect(mgr.baseDir).toContain("wt-dir");
    });

    it("initializes empty registry", () => {
      const mgr = new WorktreeManager(REPO_ROOT);
      expect(mgr.registry.size).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getWorktreeManager / resetWorktreeManager
  // ────────────────────────────────────────────────────────────────────────

  describe("getWorktreeManager / resetWorktreeManager", () => {
    it("returns same instance on multiple calls (singleton)", () => {
      const a = getWorktreeManager(REPO_ROOT);
      const b = getWorktreeManager(REPO_ROOT);
      expect(a).toBe(b);
    });

    it("resets instance when resetWorktreeManager called", () => {
      const a = getWorktreeManager(REPO_ROOT);
      resetWorktreeManager();
      const b = getWorktreeManager(REPO_ROOT);
      expect(a).not.toBe(b);
    });

    it("creates new instance after reset", () => {
      getWorktreeManager(REPO_ROOT);
      resetWorktreeManager();
      const fresh = getWorktreeManager(REPO_ROOT);
      expect(fresh.registry.size).toBe(0);
    });

    it("accepts repoRoot on first call", () => {
      const mgr = getWorktreeManager("/custom/root");
      expect(mgr.repoRoot).toContain("custom");
    });

    it("rebinds singleton when explicit repoRoot changes", () => {
      const first = getWorktreeManager("/repo/one");
      const second = getWorktreeManager("/repo/two");
      expect(first).not.toBe(second);
      expect(second.repoRoot).toContain("repo");
      expect(second.repoRoot).toContain("two");
    });

    it("uses git top-level from cwd when repoRoot is omitted", () => {
      spawnSync.mockImplementation((_, args) => {
        if (args?.includes("--show-toplevel")) {
          return { status: 0, stdout: "/detected/repo\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const mgr = getWorktreeManager();
      expect(mgr.repoRoot.replace(/\\/g, "/")).toContain("/detected/repo");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // acquireWorktree
  // ────────────────────────────────────────────────────────────────────────

  describe("acquireWorktree", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("creates new worktree when none exists for branch", async () => {
      // git worktree list → empty (just main, no matching branch)
      mockGitMulti([
        {
          match: "--porcelain",
          result: {
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
          },
        },
        { match: "worktree", result: { status: 0 } },
      ]);

      const res = await mgr.acquireWorktree("ve/abc-feat", "task-1", {
        owner: "monitor",
      });

      expect(res.created).toBe(true);
      expect(res.existing).toBe(false);
      expect(res.path).toBeTruthy();
    });

    it("links repo node_modules into newly created worktrees when available", async () => {
      mockGitMulti([
        {
          match: "--porcelain",
          result: {
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
          },
        },
        { match: "worktree", result: { status: 0 } },
      ]);
      existsSync.mockImplementation(
        (path) => String(path).replace(/\\/g, "/").endsWith(`${REPO_ROOT}/node_modules`),
      );

      await mgr.acquireWorktree("ve/abc-feat", "task-1", {
        owner: "monitor",
      });

      expect(symlinkSync).toHaveBeenCalledTimes(1);
      const [targetPath, linkPath, linkType] = symlinkSync.mock.calls[0];
      expect(String(targetPath).replace(/\\/g, "/")).toMatch(
        /\/fake\/repo\/node_modules$/,
      );
      expect(String(linkPath).replace(/\\/g, "/")).toMatch(
        /\/fake\/repo\/\.cache\/worktrees\/ve-abc-feat\/node_modules$/,
      );
      expect(typeof linkType).toBe("string");
    });

    it("runs configured bootstrap commands for detected ecosystems when shared dependencies are absent", async () => {
      const previousEnabled = process.env.WORKTREE_BOOTSTRAP_ENABLED;
      const previousCommand = process.env.WORKTREE_BOOTSTRAP_NODE_COMMAND;
      process.env.WORKTREE_BOOTSTRAP_ENABLED = "true";
      process.env.WORKTREE_BOOTSTRAP_NODE_COMMAND = "npm ci";
      try {
        mockGitMulti([
          {
            match: "--porcelain",
            result: {
              stdout: porcelainOutput([
                { path: REPO_ROOT, branch: "refs/heads/main" },
              ]),
            },
          },
          { match: "worktree", result: { status: 0 } },
        ]);
        existsSync.mockImplementation((path) => {
          const normalized = String(path).replace(/\\/g, "/");
          return normalized.endsWith("/package.json") || normalized.endsWith("/ve-bootstrap");
        });

        await mgr.acquireWorktree("ve/bootstrap", "task-bootstrap", {
          owner: "monitor",
        });

        expect(ensureWorktreeRuntimeSetupMock).toHaveBeenCalled();
        const bootstrapCall = spawnSync.mock.calls.find(([cmd]) => cmd === "npm ci");
        expect(bootstrapCall).toBeTruthy();
      } finally {
        if (previousEnabled === undefined) delete process.env.WORKTREE_BOOTSTRAP_ENABLED;
        else process.env.WORKTREE_BOOTSTRAP_ENABLED = previousEnabled;
        if (previousCommand === undefined) delete process.env.WORKTREE_BOOTSTRAP_NODE_COMMAND;
        else process.env.WORKTREE_BOOTSTRAP_NODE_COMMAND = previousCommand;
      }
    });

    it("bootstraps arbitrary managed worktree paths with shared node_modules", () => {
      const worktreePath = `${REPO_ROOT}/.bosun/worktrees/task-abc123`;
      const normalizedRepoRoot = normalizePath(resolve(REPO_ROOT));
      const normalizedWorktreePath = normalizePath(resolve(worktreePath));
      existsSync.mockImplementation((path) => {
        const normalized = normalizePath(path);
        return normalized.endsWith("/.bosun/worktrees/task-abc123")
          || normalized.endsWith("/package.json")
          || normalized.endsWith(`${REPO_ROOT}/node_modules`)
          || normalized.endsWith(`${REPO_ROOT}/.githooks/pre-commit`)
          || normalized.endsWith(`${REPO_ROOT}/.githooks/pre-push`);
      });

      bootstrapWorktreeForPath(REPO_ROOT, worktreePath);

      const [ensureRepoRoot, ensureWorktreePath] = ensureWorktreeRuntimeSetupMock.mock.calls[0] || [];
      expect(String(ensureRepoRoot).replace(/\\/g, "/")).toMatch(/\/fake\/repo$/);
      expect(String(ensureWorktreePath).replace(/\\/g, "/")).toMatch(/\/fake\/repo\/\.bosun\/worktrees\/task-abc123$/);
      const [inspectRepoRoot, inspectWorktreePath] = inspectWorktreeRuntimeSetupMock.mock.calls[0] || [];
      expect(String(inspectRepoRoot).replace(/\\/g, "/")).toMatch(/\/fake\/repo$/);
      expect(String(inspectWorktreePath).replace(/\\/g, "/")).toMatch(/\/fake\/repo\/\.bosun\/worktrees\/task-abc123$/);
      expect(symlinkSync).toHaveBeenCalledTimes(1);
      const [targetPath, linkPath] = symlinkSync.mock.calls[0];
  expect(normalizePath(targetPath)).toBe(`${normalizedRepoRoot}/node_modules`);
  expect(normalizePath(linkPath)).toBe(`${normalizedWorktreePath}/node_modules`);
    });

    it("fails closed when runtime setup inspection reports missing hook state", () => {
      const worktreePath = `${REPO_ROOT}/.bosun/worktrees/task-broken`;
      existsSync.mockImplementation((path) => {
        const normalized = String(path).replace(/\\/g, "/");
        return normalized.endsWith(`${REPO_ROOT}/.githooks/pre-commit`)
          || normalized.endsWith(`${REPO_ROOT}/.githooks/pre-push`);
      });
      inspectWorktreeRuntimeSetupMock.mockReturnValue({
        ok: false,
        issues: ["git core.hooksPath is not configured"],
        hooksPath: "",
        missingFiles: [".githooks/pre-push"],
      });

      expect(() => bootstrapWorktreeForPath(REPO_ROOT, worktreePath))
        .toThrow(/runtime setup incomplete/i);
    });

    it("returns existing worktree when one exists for branch", async () => {
      const wtPath = `${REPO_ROOT}/.cache/worktrees/ve-abc-feat`;
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
              { path: wtPath, branch: "refs/heads/ve/abc-feat" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const res = await mgr.acquireWorktree("ve/abc-feat", "task-2", {
        owner: "monitor",
      });

      expect(res.created).toBe(false);
      expect(res.existing).toBe(true);
      expect(res.path).toBe(wtPath);
    });

    it("links repo node_modules into reused worktrees when the worktree copy is missing", async () => {
      const wtPath = `${REPO_ROOT}/.cache/worktrees/ve-abc-feat`;
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
              { path: wtPath, branch: "refs/heads/ve/abc-feat" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      existsSync.mockImplementation(
        (path) => String(path).replace(/\\/g, "/").endsWith(`${REPO_ROOT}/node_modules`),
      );

      await mgr.acquireWorktree("ve/abc-feat", "task-2", {
        owner: "monitor",
      });

      expect(symlinkSync).toHaveBeenCalledTimes(1);
      const [targetPath, linkPath, linkType] = symlinkSync.mock.calls[0];
      expect(String(targetPath).replace(/\\/g, "/")).toMatch(
        /\/fake\/repo\/node_modules$/,
      );
      expect(String(linkPath).replace(/\\/g, "/")).toMatch(
        /\/fake\/repo\/\.cache\/worktrees\/ve-abc-feat\/node_modules$/,
      );
      expect(typeof linkType).toBe("string");
    });

    it("repairs reused worktree node_modules when an existing copy no longer points at repo root", async () => {
      const wtPath = `${REPO_ROOT}/.cache/worktrees/ve-abc-feat`;
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
              { path: wtPath, branch: "refs/heads/ve/abc-feat" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      existsSync.mockImplementation((path) => {
        const normalized = String(path).replace(/\\/g, "/");
        return normalized.endsWith(`${REPO_ROOT}/node_modules`)
          || normalized.endsWith(`${wtPath}/node_modules`);
      });
      realpathSync.mockImplementation((path) => String(path).replace(/\\/g, "/"));

      await mgr.acquireWorktree("ve/abc-feat", "task-2", {
        owner: "monitor",
      });

      expect(rmSync).toHaveBeenCalledWith(
        expect.stringMatching(/node_modules$/),
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(symlinkSync).toHaveBeenCalledTimes(1);
    });

    it("keeps shared node_modules when the existing worktree path already resolves to repo root", async () => {
      const wtPath = `${REPO_ROOT}/.cache/worktrees/ve-abc-feat`;
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
              { path: wtPath, branch: "refs/heads/ve/abc-feat" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      existsSync.mockImplementation((path) => {
        const normalized = String(path).replace(/\\/g, "/");
        return normalized.endsWith(`${REPO_ROOT}/node_modules`)
          || normalized.endsWith(`${wtPath}/node_modules`);
      });
      realpathSync.mockImplementation((path) => {
        const normalized = String(path).replace(/\\/g, "/");
        if (normalized.endsWith(`${REPO_ROOT}/node_modules`)
          || normalized.endsWith(`${wtPath}/node_modules`)) {
          return `${REPO_ROOT}/node_modules`;
        }
        return normalized;
      });

      await mgr.acquireWorktree("ve/abc-feat", "task-2", {
        owner: "monitor",
      });

      expect(rmSync).not.toHaveBeenCalled();
      expect(symlinkSync).not.toHaveBeenCalled();
    });

    it("registers worktree with taskKey", async () => {
      mockGitMulti([
        {
          match: "--porcelain",
          result: {
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
          },
        },
        { match: "add", result: { status: 0 } },
      ]);

      await mgr.acquireWorktree("ve/xyz-task", "task-xyz", {
        owner: "monitor",
      });

      const record = mgr.getWorktreeForTask("task-xyz");
      expect(record).toBeTruthy();
      expect(record.branch).toBe("ve/xyz-task");
    });

    it("registers with owner", async () => {
      mockGitMulti([
        {
          match: "--porcelain",
          result: {
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
          },
        },
        { match: "add", result: { status: 0 } },
      ]);

      await mgr.acquireWorktree("ve/own-test", "task-own", {
        owner: "error-resolver",
      });

      const record = mgr.getWorktreeForTask("task-own");
      expect(record.owner).toBe("error-resolver");
    });

    it("handles git worktree add failure gracefully", async () => {
      mockGitMulti([
        {
          match: "--porcelain",
          result: {
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
          },
        },
        {
          match: "add",
          result: { status: 1, stderr: "fatal: some git error" },
        },
      ]);

      const res = await mgr.acquireWorktree("ve/fail", "task-fail");

      // When git add fails and it's not "already checked out", created=false, existing=false
      expect(res.created).toBe(false);
      expect(res.existing).toBe(false);
    });

    it("retries with --detach when branch is already checked out", async () => {
      let detachCalled = false;
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
            stderr: "",
          };
        }
        if (args && args.includes("--detach")) {
          detachCalled = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args && args.includes("add")) {
          return {
            status: 1,
            stdout: "",
            stderr: "fatal: 've/checked-out' is already checked out",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      await mgr.acquireWorktree("ve/checked-out", "task-det");
      expect(detachCalled).toBe(true);
    });

    it("reuses existing local branch instead of creating with -b", async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args?.[0] === "worktree" && args?.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
            stderr: "",
          };
        }
        if (args?.[0] === "show-ref") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args?.[0] === "worktree" && args?.[1] === "add") {
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      await mgr.acquireWorktree("ve/existing", "task-existing", {
        owner: "monitor",
        baseBranch: "origin/main",
      });

      const addCall = spawnSync.mock.calls.find(
        ([, args]) => args?.[0] === "worktree" && args?.[1] === "add",
      );
      expect(addCall).toBeTruthy();
      expect(addCall[1]).not.toContain("-b");
      expect(addCall[1][addCall[1].length - 1]).toBe("ve/existing");
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // releaseWorktree
  // ────────────────────────────────────────────────────────────────────────

  describe("releaseWorktree", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("removes worktree and clears registry entry", async () => {
      // Seed the registry directly
      mgr.registry.set("task-rel", {
        path: "/fake/repo/.cache/worktrees/ve-rel",
        branch: "ve/rel",
        taskKey: "task-rel",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });
      mgr._loaded = true;

      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

      const res = await mgr.releaseWorktree("task-rel");

      expect(res.success).toBe(true);
      expect(res.path).toContain("ve-rel");
      expect(mgr.registry.has("task-rel")).toBe(false);
    });

    it("returns success false when taskKey not found", async () => {
      mgr._loaded = true;
      const res = await mgr.releaseWorktree("nonexistent-key");
      expect(res.success).toBe(false);
      expect(res.path).toBeNull();
    });

    it("handles git worktree remove failure gracefully", async () => {
      mgr.registry.set("task-rfail", {
        path: "/fake/repo/.cache/worktrees/ve-rfail",
        branch: "ve/rfail",
        taskKey: "task-rfail",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });
      mgr._loaded = true;

      spawnSync.mockReturnValue({
        status: 1,
        stdout: "",
        stderr: "error: cannot remove",
      });

      const res = await mgr.releaseWorktree("task-rfail");

      // Even on git failure, registry is cleaned up
      expect(res.success).toBe(false);
      expect(res.path).toContain("ve-rfail");
      expect(mgr.registry.has("task-rfail")).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // releaseWorktreeByBranch
  // ────────────────────────────────────────────────────────────────────────

  describe("releaseWorktreeByBranch", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
      mgr._loaded = true;
    });

    it("removes worktree by branch name", async () => {
      mgr.registry.set("task-rb", {
        path: "/fake/repo/.cache/worktrees/ve-rb",
        branch: "ve/rb",
        taskKey: "task-rb",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });

      const res = await mgr.releaseWorktreeByBranch("ve/rb");

      expect(res.success).toBe(true);
      expect(res.path).toContain("ve-rb");
      expect(mgr.registry.has("task-rb")).toBe(false);
    });

    it("returns success false when branch not found", async () => {
      spawnSync.mockImplementation((_cmd, args) => {
        if (args && args.includes("--porcelain")) {
          return {
            status: 0,
            stdout: porcelainOutput([
              { path: REPO_ROOT, branch: "refs/heads/main" },
            ]),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      });

      const res = await mgr.releaseWorktreeByBranch("nonexistent/branch");
      expect(res.success).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // findWorktreeForBranch
  // ────────────────────────────────────────────────────────────────────────

  describe("findWorktreeForBranch", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("finds worktree by exact branch match", () => {
      const wtPath = "/fake/repo/.cache/worktrees/ve-abc-feat";
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: REPO_ROOT, branch: "refs/heads/main" },
          { path: wtPath, branch: "refs/heads/ve/abc-feat" },
        ]),
        stderr: "",
      });

      expect(mgr.findWorktreeForBranch("ve/abc-feat")).toBe(wtPath);
    });

    it("returns null when no match", () => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: REPO_ROOT, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });

      expect(mgr.findWorktreeForBranch("ve/no-match")).toBeNull();
    });

    it("handles refs/heads/ prefix in branch ref", () => {
      const wtPath = "/fake/repo/.cache/worktrees/ve-prefixed";
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: wtPath, branch: "refs/heads/ve/prefixed" },
        ]),
        stderr: "",
      });

      // Pass with refs/heads/ prefix — should still match
      expect(mgr.findWorktreeForBranch("refs/heads/ve/prefixed")).toBe(wtPath);
    });

    it("returns null for null/empty branch", () => {
      expect(mgr.findWorktreeForBranch(null)).toBeNull();
      expect(mgr.findWorktreeForBranch("")).toBeNull();
    });

    it("handles git command failure gracefully", () => {
      spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "error" });
      expect(mgr.findWorktreeForBranch("ve/any")).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // listAllWorktrees
  // ────────────────────────────────────────────────────────────────────────

  describe("listAllWorktrees", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("returns parsed worktree entries with metadata", () => {
      const wtPath = "/fake/repo/.cache/worktrees/ve-list-test";
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: REPO_ROOT, branch: "refs/heads/main" },
          { path: wtPath, branch: "refs/heads/ve/list-test" },
        ]),
        stderr: "",
      });

      const list = mgr.listAllWorktrees();
      expect(list.length).toBe(2);

      const main = list.find((w) => w.branch === "main");
      expect(main).toBeTruthy();

      const wt = list.find((w) => w.branch === "ve/list-test");
      expect(wt).toBeTruthy();
      expect(wt.path).toBe(wtPath);
    });

    it("marks main worktree as isMainWorktree", () => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });

      const list = mgr.listAllWorktrees();
      expect(list[0].isMainWorktree).toBe(true);
    });

    it("runs git without shell to avoid DEP0190 warnings", () => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });

      mgr.listAllWorktrees();

      const listCall = spawnSync.mock.calls.find(
        (_call) => _call[1]?.[0] === "worktree" && _call[1]?.[1] === "list",
      );
      expect(listCall).toBeTruthy();
      expect(listCall[2]?.shell).toBe(false);
    });

    it("includes registry metadata when available", () => {
      const wtPath = "/fake/repo/.cache/worktrees/ve-meta";
      mgr.registry.set("task-meta", {
        path: wtPath,
        branch: "ve/meta",
        taskKey: "task-meta",
        createdAt: Date.now() - 5000,
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
          { path: wtPath, branch: "refs/heads/ve/meta" },
        ]),
        stderr: "",
      });

      const list = mgr.listAllWorktrees();
      const wt = list.find((w) => w.branch === "ve/meta");
      expect(wt.taskKey).toBe("task-meta");
      expect(wt.status).toBe("active");
      expect(wt.owner).toBe("monitor");
    });

    it("returns empty array when git fails", () => {
      spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "error" });
      expect(mgr.listAllWorktrees()).toEqual([]);
    });

    it("returns empty array when no stdout", () => {
      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
      expect(mgr.listAllWorktrees()).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // listActiveWorktrees
  // ────────────────────────────────────────────────────────────────────────

  describe("listActiveWorktrees", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("returns only registered (tracked) worktrees", () => {
      const activePath = "/fake/repo/.cache/worktrees/ve-active";
      const untrackedPath = "/fake/repo/.cache/worktrees/ve-untracked";

      mgr.registry.set("task-active", {
        path: activePath,
        branch: "ve/active",
        taskKey: "task-active",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
          { path: activePath, branch: "refs/heads/ve/active" },
          { path: untrackedPath, branch: "refs/heads/ve/untracked" },
        ]),
        stderr: "",
      });

      const active = mgr.listActiveWorktrees();
      // Only the tracked one (with taskKey) should appear
      expect(active.length).toBe(1);
      expect(active[0].taskKey).toBe("task-active");
    });

    it("excludes main worktree", () => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });

      const active = mgr.listActiveWorktrees();
      // Main has no taskKey and is "main" status, not "active"
      expect(active.length).toBe(0);
    });

    it("includes age calculation for tracked entries", () => {
      const activePath = "/fake/repo/.cache/worktrees/ve-aged";
      const createdAt = Date.now() - 60_000;

      mgr.registry.set("task-aged", {
        path: activePath,
        branch: "ve/aged",
        taskKey: "task-aged",
        createdAt,
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
          { path: activePath, branch: "refs/heads/ve/aged" },
        ]),
        stderr: "",
      });

      const active = mgr.listActiveWorktrees();
      expect(active[0].age).toBeGreaterThanOrEqual(60_000);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // pruneStaleWorktrees
  // ────────────────────────────────────────────────────────────────────────

  describe("pruneStaleWorktrees", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
      mgr._loaded = true;
    });

    it("runs 'git worktree prune'", async () => {
      spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
      await mgr.pruneStaleWorktrees();

      const pruneCalls = spawnSync.mock.calls.filter(
        ([, args]) => args && args.includes("prune"),
      );
      expect(pruneCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("removes stale worktrees older than MAX_WORKTREE_AGE_MS", async () => {
      const stalePath = "/fake/repo/.cache/worktrees/ve-stale";
      mgr.registry.set("task-stale", {
        path: stalePath,
        branch: "ve/stale",
        taskKey: "task-stale",
        createdAt: Date.now() - MAX_WORKTREE_AGE_MS - 10_000,
        lastUsedAt: Date.now() - MAX_WORKTREE_AGE_MS - 10_000,
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
          { path: stalePath, branch: "refs/heads/ve/stale" },
        ]),
        stderr: "",
      });
      // Path doesn't exist on disk for the eviction check
      existsSync.mockImplementation((p) => {
        if (String(p).includes("ve-stale")) return false;
        return false;
      });

      const result = await mgr.pruneStaleWorktrees();
      // Either pruned or evicted the stale entry
      expect(result.pruned + result.evicted).toBeGreaterThanOrEqual(1);
    });

    it("removes copilot-worktree entries older than 7 days", async () => {
      // Build a date string for 8 days ago
      const oldDate = new Date(
        Date.now() - COPILOT_WORKTREE_MAX_AGE_MS - 86_400_000,
      );
      const dateStr = oldDate.toISOString().slice(0, 10);
      const copilotPath = `/fake/repo/.cache/worktrees/copilot-worktree-${dateStr}`;

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
          {
            path: copilotPath,
            branch: "refs/heads/copilot-temp",
          },
        ]),
        stderr: "",
      });

      const result = await mgr.pruneStaleWorktrees();
      expect(result.pruned).toBeGreaterThanOrEqual(1);
    });

    it("evicts registry entries whose paths no longer exist", async () => {
      mgr.registry.set("task-ghost", {
        path: "/gone/path",
        branch: "ve/ghost",
        taskKey: "task-ghost",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });
      existsSync.mockReturnValue(false);

      const result = await mgr.pruneStaleWorktrees();
      expect(result.evicted).toBeGreaterThanOrEqual(1);
      expect(mgr.registry.has("task-ghost")).toBe(false);
    });

    it("respects dryRun option", async () => {
      mgr.registry.set("task-dry", {
        path: "/gone/dry",
        branch: "ve/dry",
        taskKey: "task-dry",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        status: "active",
        owner: "monitor",
      });

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });
      existsSync.mockReturnValue(false);

      const result = await mgr.pruneStaleWorktrees({ dryRun: true });

      // dryRun should NOT actually delete
      expect(result.pruned).toBe(0);
      expect(result.evicted).toBe(0);
      // Registry entry should still exist
      expect(mgr.registry.has("task-dry")).toBe(true);
    });

    it("returns { pruned, evicted } counts", async () => {
      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
      });

      const result = await mgr.pruneStaleWorktrees();
      expect(result).toHaveProperty("pruned");
      expect(result).toHaveProperty("evicted");
      expect(typeof result.pruned).toBe("number");
      expect(typeof result.evicted).toBe("number");
    });

    it("removes orphan managed task worktree dirs under .bosun/worktrees", async () => {
      const managedTaskRoot = normalizePath(resolve(REPO_ROOT, DEFAULT_MANAGED_TASK_BASE_DIR));
      const orphanPath = `${managedTaskRoot}/task-abc123-deadbeef`;

      spawnSync.mockReturnValue({
        status: 0,
        stdout: porcelainOutput([
          { path: mgr.repoRoot, branch: "refs/heads/main" },
        ]),
        stderr: "",
        });
        existsSync.mockImplementation((p) => {
          const normalized = String(p).replace(/\\/g, "/");
          return normalized.endsWith(`/${DEFAULT_MANAGED_TASK_BASE_DIR}`);
        });
        readdirSync.mockImplementation((dirPath) => {
        if (String(dirPath).replace(/\\/g, "/").endsWith(`/${DEFAULT_MANAGED_TASK_BASE_DIR}`)) {
          return [{ name: "task-abc123-deadbeef", isDirectory: () => true }];
        }
        return [];
      });
      statSync.mockImplementation((targetPath) => ({
        mtimeMs: String(targetPath).replace(/\\/g, "/").endsWith("/.bosun/worktrees/task-abc123-deadbeef")
          ? Date.now() - MAX_WORKTREE_AGE_MS - 10_000
          : Date.now(),
        isDirectory: () => true,
      }));

      const result = await mgr.pruneStaleWorktrees();
      expect(result.pruned).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getStats
  // ────────────────────────────────────────────────────────────────────────

  describe("getStats", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("returns correct total count", () => {
      mgr.registry.set("a", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });
      mgr.registry.set("b", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });

      expect(mgr.getStats().total).toBe(2);
    });

    it("returns correct active count", () => {
      mgr.registry.set("a", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });
      mgr.registry.set("b", {
        status: "releasing",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });

      expect(mgr.getStats().active).toBe(1);
    });

    it("returns correct stale count", () => {
      mgr.registry.set("a", {
        status: "stale",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });
      mgr.registry.set("b", {
        status: "active",
        lastUsedAt: Date.now() - MAX_WORKTREE_AGE_MS - 1,
        owner: "monitor",
      });

      // Both should be stale: one by status, one by age
      expect(mgr.getStats().stale).toBe(2);
    });

    it("returns byOwner breakdown", () => {
      mgr.registry.set("a", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });
      mgr.registry.set("b", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "error-resolver",
      });
      mgr.registry.set("c", {
        status: "active",
        lastUsedAt: Date.now(),
        owner: "monitor",
      });

      const stats = mgr.getStats();
      expect(stats.byOwner.monitor).toBe(2);
      expect(stats.byOwner["error-resolver"]).toBe(1);
    });

    it("handles empty registry", () => {
      const stats = mgr.getStats();
      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.stale).toBe(0);
      expect(stats.byOwner).toEqual({});
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // updateWorktreeUsage
  // ────────────────────────────────────────────────────────────────────────

  describe("updateWorktreeUsage", () => {
    let mgr;
    beforeEach(() => {
      mgr = new WorktreeManager(REPO_ROOT);
    });

    it("updates lastUsedAt timestamp", async () => {
      const oldTime = Date.now() - 100_000;
      mgr.registry.set("task-upd", {
        path: "/fake/path",
        branch: "ve/upd",
        taskKey: "task-upd",
        createdAt: oldTime,
        lastUsedAt: oldTime,
        status: "active",
        owner: "monitor",
      });

      await mgr.updateWorktreeUsage("task-upd");

      const record = mgr.registry.get("task-upd");
      expect(record.lastUsedAt).toBeGreaterThan(oldTime);
    });

    it("does nothing for unknown taskKey", async () => {
      // Should not throw
      await mgr.updateWorktreeUsage("nonexistent");
      expect(mgr.registry.size).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // getWorktreeForTask
  // ────────────────────────────────────────────────────────────────────────

  describe("getWorktreeForTask", () => {
    it("returns record when taskKey exists", () => {
      const mgr = new WorktreeManager(REPO_ROOT);
      mgr.registry.set("tk-1", { branch: "ve/t1", status: "active" });
      expect(mgr.getWorktreeForTask("tk-1")).toBeTruthy();
      expect(mgr.getWorktreeForTask("tk-1").branch).toBe("ve/t1");
    });

    it("returns null when taskKey not found", () => {
      const mgr = new WorktreeManager(REPO_ROOT);
      expect(mgr.getWorktreeForTask("nope")).toBeNull();
    });
  });
});
