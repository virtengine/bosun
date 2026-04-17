import { resolve } from "node:path";
import { availableParallelism, cpus } from "node:os";
import { spawnSync } from "node:child_process";
import * as vitestConfig from "vitest/config";

const defineConfig =
  vitestConfig.defineConfig ??
  vitestConfig.default?.defineConfig ??
  ((config) => config);

function detectParallelism() {
  try {
    if (typeof availableParallelism === "function") {
      return availableParallelism();
    }
  } catch {
    // Fall through to cpu count.
  }
  return Array.isArray(cpus?.()) && cpus().length > 0 ? cpus().length : 4;
}

function parseWorkerCount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function detectBlockedChildSpawn() {
  if (process.platform !== "win32") return "0";
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const errorCode = result?.error?.code;
    return errorCode === "EPERM" || errorCode === "EACCES" ? "1" : "0";
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES" ? "1" : "0";
  }
}

if (!process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED) {
  process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED = detectBlockedChildSpawn();
}

const detectedParallelism = detectParallelism();
const windowsSuggestedMaxWorkers = Math.max(
  2,
  Math.min(4, Math.floor(detectedParallelism / 2) || 2),
);
const windowsSuggestedMinWorkers = Math.max(
  1,
  Math.min(3, Math.floor(windowsSuggestedMaxWorkers / 2) || 1),
);
const windowsDefaultMaxWorkers = parseWorkerCount(
  process.env.BOSUN_VITEST_MAX_WORKERS,
  windowsSuggestedMaxWorkers,
);
const windowsDefaultMinWorkers = Math.min(
  parseWorkerCount(process.env.BOSUN_VITEST_MIN_WORKERS, windowsSuggestedMinWorkers),
  windowsDefaultMaxWorkers,
);
const defaultMaxWorkers =
  process.platform === "win32"
    ? windowsDefaultMaxWorkers
    : parseWorkerCount(process.env.BOSUN_VITEST_MAX_WORKERS, undefined);
const defaultMinWorkers =
  process.platform === "win32"
    ? windowsDefaultMinWorkers
    : parseWorkerCount(process.env.BOSUN_VITEST_MIN_WORKERS, undefined);
const isolatedProjectSuites = [
  "ui-server.test.mjs",
  "workflow-engine.test.mjs",
  "workflow-guaranteed.test.mjs",
  "workflow-task-lifecycle.test.mjs",
  "workflow-templates.test.mjs",
  "agent-pool.test.mjs",
  "bosun-native-workflow-nodes.test.mjs",
  "workflow-templates-e2e.test.mjs",
  "session-manager.test.mjs",
  "primary-agent.runtime.test.mjs",
];
const sharedTestExcludes = [
  "**/node_modules/**",
  "**/.cache/**",
  "**/*.node.test.mjs",
  ...(process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED === "1"
    ? ["workflow-task-lifecycle.test.mjs"]
    : []),
];
const defaultTestTimeout = process.platform === "win32" ? 15_000 : 5_000;

const sharedProjectTestConfig = {
  environment: "node",
  globals: true,
  dir: "tests",
  exclude: sharedTestExcludes,
  testTimeout: defaultTestTimeout,
  // Retry once on failure to absorb transient OS-level jitter (disk, scheduling).
  // Persistent regressions still fail on the second attempt.
  retry: 1,
  minWorkers: defaultMinWorkers,
  maxWorkers: defaultMaxWorkers,
  setupFiles: ["tests/setup.mjs"],
  experimental: {
    fsModuleCache: process.env.BOSUN_VITEST_FS_CACHE !== "0",
  },
};

const stripShebangPlugin = {
  name: "strip-shebang",
  enforce: "pre",
  transform(code, id) {
    if (!/\.(?:[cm]?js|mjs)$/.test(id)) return null;
    const normalized = String(code || "");
    if (!/^\ufeff?#!/.test(normalized)) return null;
    return {
      code: normalized.replace(/^\ufeff?#![^\n]*\r?\n?/, ""),
      map: null,
    };
  },
};

export default defineConfig({
  plugins: [stripShebangPlugin],
  esbuild: false,
  keepProcessEnv: true,
  resolve: {
    alias: {
      "@openai/codex-sdk": resolve(process.cwd(), "tests", "shims", "codex-sdk.mjs"),
    },
  },
  test: {
    reporters: ["default", "tests/near-timeout-reporter.mjs"],
    projects: [
      {
        test: {
          ...sharedProjectTestConfig,
          name: "fast",
          pool: "forks",
          isolate: true,
          include: ["**/*.test.mjs"],
          exclude: [...sharedTestExcludes, ...isolatedProjectSuites],
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          ...sharedProjectTestConfig,
          name: "isolated",
          pool: "forks",
          isolate: true,
          include: isolatedProjectSuites,
          exclude: sharedTestExcludes,
          // Isolated suites are memory-heavy (ui-server, workflow-guaranteed need >8 GB).
          // Run one at a time to avoid OOM when two heavy forks share system memory.
          maxWorkers: parseWorkerCount(process.env.BOSUN_VITEST_ISOLATED_MAX_WORKERS, 1),
          minWorkers: 1,
          // Isolated suites are long-running deterministic tests. A retry on a
          // 3-minute timeout costs 6 minutes and rarely recovers — these tests
          // fail from genuine budget exhaustion, not OS-level jitter.
          retry: 0,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
