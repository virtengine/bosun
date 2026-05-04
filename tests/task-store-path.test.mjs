import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";

const tempDirs = [];
const TEST_ENV_KEYS = [
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "NODE_ENV",
  "NODE_TEST_CONTEXT",
  "JEST_WORKER_ID",
  "BOSUN_TEST_CACHE_DIR",
  "BOSUN_HOME",
  "BOSUN_DIR",
  "REPO_ROOT",
];

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadTaskStoreModule() {
  await vi.resetModules();
  return import("../task/task-store.mjs");
}

async function loadTaskAttachmentsModule() {
  await vi.resetModules();
  return import("../task/task-attachments.mjs");
}

function snapshotEnv() {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of TEST_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

afterEach(() => {
  resetStateLedgerCache();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("task-store path configuration", () => {
  it("configureTaskStore changes active store path", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-");
    const customStorePath = resolve(tempDir, "custom-state.json");

    taskStore.configureTaskStore({ storePath: customStorePath });

    expect(taskStore.getStorePath()).toBe(customStorePath);
  });

  it("getStorePath returns path configured via baseDir", async () => {
    const taskStore = await loadTaskStoreModule();
    const baseDir = makeTempDir("ve-task-store-base-");
    const expectedPath = resolve(
      baseDir,
      ".bosun",
      ".cache",
      "kanban-state.json",
    );

    taskStore.configureTaskStore({ baseDir });

    expect(taskStore.getStorePath()).toBe(expectedPath);
  });

  it("reconfigure resets in-memory load state without throwing", async () => {
    const taskStore = await loadTaskStoreModule();
    const firstDir = makeTempDir("ve-task-store-first-");
    const secondDir = makeTempDir("ve-task-store-second-");
    const firstPath = resolve(firstDir, "first.json");
    const secondPath = resolve(secondDir, "second.json");

    taskStore.configureTaskStore({ storePath: firstPath });
    taskStore.loadStore();
    taskStore.addTask({ id: "task-1", title: "One" });
    expect(taskStore.getAllTasks().length).toBe(1);

    expect(() =>
      taskStore.configureTaskStore({ storePath: secondPath }),
    ).not.toThrow();

    taskStore.loadStore();
    expect(taskStore.getAllTasks()).toEqual([]);
  });

  it("isolates real persistent store paths during test runtime", async () => {
    const env = snapshotEnv();
    const repoRoot = makeTempDir("ve-task-store-home-");
    try {
      process.env.VITEST = "1";
      process.env.REPO_ROOT = repoRoot;
      delete process.env.BOSUN_HOME;

      const persistentPath = resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
      const taskStore = await loadTaskStoreModule();

      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(dirname(taskStore.getStorePath())).toContain(
        resolve(tmpdir(), "bosun-vitest"),
      );
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
      expect(taskStore.getStorePath()).not.toContain(
        resolve(repoRoot, ".bosun", ".cache"),
      );

      taskStore.configureTaskStore({ storePath: persistentPath });
      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
      expect(taskStore.getStorePath()).not.toContain(
        resolve(repoRoot, ".bosun", ".cache"),
      );
    } finally {
      restoreEnv(env);
    }
  });

  it("isolates persistent store paths for node test runtime signals", async () => {
    const env = snapshotEnv();
    const repoRoot = makeTempDir("ve-task-store-node-test-");
    const testCacheDir = makeTempDir("ve-task-store-node-cache-");
    try {
      delete process.env.VITEST;
      process.env.NODE_TEST_CONTEXT = "1";
      process.env.BOSUN_TEST_CACHE_DIR = testCacheDir;
      process.env.REPO_ROOT = repoRoot;
      delete process.env.BOSUN_HOME;

      const persistentPath = resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
      const taskStore = await loadTaskStoreModule();

      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
      expect(taskStore.getStorePath()).not.toContain(
        resolve(repoRoot, ".bosun", ".cache"),
      );
    } finally {
      restoreEnv(env);
    }
  });

  it("re-evaluates store isolation when test env appears after module import", async () => {
    const env = snapshotEnv();
    const repoRoot = makeTempDir("ve-task-store-late-env-");
    const testCacheDir = makeTempDir("ve-task-store-late-cache-");
    try {
      delete process.env.VITEST;
      delete process.env.NODE_TEST_CONTEXT;
      delete process.env.BOSUN_TEST_CACHE_DIR;
      process.env.REPO_ROOT = repoRoot;
      delete process.env.BOSUN_HOME;

      const persistentPath = resolve(repoRoot, ".bosun", ".cache", "kanban-state.json");
      const taskStore = await loadTaskStoreModule();

      expect(taskStore.getStorePath()).toBe(persistentPath);

      process.env.NODE_TEST_CONTEXT = "1";
      process.env.BOSUN_TEST_CACHE_DIR = testCacheDir;

      expect(taskStore.getAllTasks()).toEqual([]);
      expect(taskStore.getStorePath()).toContain("kanban-state-vitest-");
      expect(taskStore.getStorePath()).not.toBe(persistentPath);
    } finally {
      restoreEnv(env);
    }
  });

  it("normalizes equivalent workspace-rooted keys to one canonical key", async () => {
    const taskStore = await loadTaskStoreModule();
    const isWin = process.platform === "win32";
    // Backslash→forward-slash normalization always applies; case folding only on Windows
    expect(taskStore.normalizeWorkspaceStorageKey("VirtEngine-GH\\BOSUN")).toBe(
      isWin ? "virtengine-gh/bosun" : "VirtEngine-GH/BOSUN",
    );
    expect(taskStore.normalizeWorkspaceStorageKey("./virtengine-gh/bosun/")).toBe(
      "virtengine-gh/bosun",
    );
  });

  it("rejects collisions caused by separator normalization", async () => {
    const taskStore = await loadTaskStoreModule();
    // Use separator-only collision that works on all platforms
    expect(() =>
      taskStore.normalizeWorkspaceStorageKeys(
        ["virtengine-gh/bosun", "virtengine-gh\\bosun"],
        { kind: "test.workspace-keys" },
      ),
    ).toThrow(/collision/i);
  });

  it("prefers explicit REPO_ROOT over BOSUN_HOME for default store resolution", async () => {
    const env = snapshotEnv();
    const explicitRepoRoot = makeTempDir("ve-task-store-explicit-repo-");
    const homeDir = makeTempDir("ve-task-store-explicit-home-");
    try {
      process.env.VITEST = "1";
      process.env.REPO_ROOT = explicitRepoRoot;
      process.env.BOSUN_HOME = homeDir;

      const taskStore = await loadTaskStoreModule();
      const storePath = String(taskStore.getStorePath() || "").toLowerCase();

      expect(storePath).toContain("kanban-state-vitest-");
      expect(storePath).toContain(basename(explicitRepoRoot).toLowerCase());
      expect(storePath).not.toContain(basename(homeDir).toLowerCase());
    } finally {
      restoreEnv(env);
    }
  });

  it("deduplicates task attachment paths across legacy path fields", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-attachments-");
    const storePath = resolve(tempDir, "kanban-state.json");
    taskStore.configureTaskStore({ storePath });

    const task = taskStore.addTask({
      id: "task-attach-1",
      title: "Normalize attachments",
      attachments: [
        { filePath: "artifacts\\build.log", name: "build.log" },
        { path: "./artifacts/build.log", name: "duplicate build.log" },
      ],
      meta: {
        attachments: [
          { filePath: "notes\\plan.md", name: "plan.md" },
          { path: "./notes/plan.md", name: "duplicate plan.md" },
        ],
      },
    });

    expect(task.attachments).toHaveLength(1);
    expect(task.meta.attachments).toHaveLength(1);
    expect(task.attachments[0]).toEqual(
      expect.objectContaining({ filePath: "artifacts/build.log" }),
    );
    expect(task.meta.attachments[0]).toEqual(
      expect.objectContaining({ filePath: "notes/plan.md" }),
    );
  });

  it("reads legacy attachment records through canonical path matching", async () => {
    const attachments = await loadTaskAttachmentsModule();
    const tempDir = makeTempDir("ve-task-attachments-");
    const storePath = resolve(tempDir, "task-attachments.json");
    attachments.configureTaskAttachmentsStore({ storePath });

    writeFileSync(
      storePath,
      JSON.stringify({
        _meta: { version: 1, updatedAt: new Date().toISOString() },
        tasks: {
          "internal:task-legacy": {
            taskId: "task-legacy",
            backend: "internal",
            attachments: [
              { id: "legacy-1", filePath: "logs\\agent.txt", name: "agent.txt" },
              { id: "legacy-2", path: "./logs/agent.txt", name: "duplicate agent.txt" },
            ],
          },
        },
      }),
      "utf8",
    );

    const listed = attachments.listTaskAttachments("task-legacy");

    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(
      expect.objectContaining({ filePath: "logs/agent.txt" }),
    );
  });
  it("canonicalizes mixed-case legacy task path fields at the task root", async () => {
    const taskStore = await loadTaskStoreModule();
    const tempDir = makeTempDir("ve-task-store-root-paths-");
    const storePath = resolve(tempDir, "kanban-state.json");
    taskStore.configureTaskStore({ storePath });

    const task = taskStore.addTask({
      id: "task-root-paths-1",
      title: "Normalize root task paths",
      attachments: [
        { filePath: "Artifacts\\Build.LOG", name: "build.log" },
        { path: "./artifacts/build.log", name: "duplicate build.log" },
      ],
      archivePath: "Archive\\Done\\Task-Root-Paths-1.JSON",
      importPath: "Imports\\Task-Root-Paths-1.JSON",
      filePaths: ["Src\\Runner.MJS", "./src/runner.mjs"],
      paths: ["Docs\\Plan.MD", "./docs/plan.md"],
      meta: {
        exportPath: "Exports\\Task-Root-Paths-1.JSON",
      },
    });

    expect(task.attachments).toHaveLength(1);
    expect(task.attachments[0]).toEqual(
      expect.objectContaining({ filePath: "artifacts/build.log" }),
    );
    expect(task.archivePath).toBe("archive/done/task-root-paths-1.json");
    expect(task.importPath).toBe("imports/task-root-paths-1.json");
    expect(task.filePaths).toEqual(["src/runner.mjs"]);
    expect(task.paths).toEqual(["docs/plan.md"]);
    expect(task.meta.exportPath).toBe("exports/task-root-paths-1.json");
  });
});

