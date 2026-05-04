import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const TEST_ENV_KEYS = [
  "BOSUN_TEST_SANDBOX",
  "BOSUN_TEST_SANDBOX_ROOT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "VE_GIT_AUTHOR_NAME",
  "VE_GIT_AUTHOR_EMAIL",
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "JEST_WORKER_ID",
  "NODE_ENV",
];

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

afterEach(async () => {
  await vi.resetModules();
});

describe("test runtime sandbox", () => {
  it("forces git/global test state into a temp sandbox without overriding repo-local config precedence", async () => {
    const env = snapshotEnv();
    try {
      process.env.VITEST = "1";
      process.env.GIT_AUTHOR_EMAIL = "test@example.com";
      process.env.GIT_COMMITTER_EMAIL = "test@example.com";

      await vi.resetModules();
      const runtime = await import("../infra/test-runtime.mjs");
      const context = runtime.ensureTestRuntimeSandbox({ force: true });

      expect(context).toBeTruthy();
      expect(context.sandboxRoot).toContain(resolve(tmpdir(), "bosun-test-sandbox"));
      expect(process.env.BOSUN_TEST_SANDBOX).toBe("1");
      expect(process.env.BOSUN_TEST_SANDBOX_ROOT).toBe(context.sandboxRoot);
      expect(process.env.GIT_CONFIG_GLOBAL).toBe(context.gitGlobalConfigPath);
      expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(process.env.GIT_AUTHOR_EMAIL).toBeUndefined();
      expect(process.env.GIT_COMMITTER_EMAIL).toBeUndefined();
      expect(existsSync(context.gitGlobalConfigPath)).toBe(true);
    } finally {
      restoreEnv(env);
    }
  });

  it("redirects the default workflow engine store away from the repo .bosun directory", async () => {
    const env = snapshotEnv();
    try {
      process.env.VITEST = "1";
      delete process.env.BOSUN_HOME;
      delete process.env.BOSUN_DIR;
      delete process.env.CODEX_MONITOR_HOME;
      delete process.env.CODEX_MONITOR_DIR;

      await vi.resetModules();
      const runtime = await import("../infra/test-runtime.mjs");
      const context = runtime.ensureTestRuntimeSandbox({ force: true });
      const workflow = await import("../workflow/workflow-engine.mjs");

      workflow.resetWorkflowEngine();
      const engine = workflow.getWorkflowEngine();

      expect(engine.workflowDir).toBe(context.workflowDir);
      expect(engine.runsDir).toBe(context.runsDir);
      expect(engine.workflowDir).not.toContain(resolve(process.cwd(), ".bosun"));
      expect(engine.runsDir).not.toContain(resolve(process.cwd(), ".bosun"));
    } finally {
      restoreEnv(env);
    }
  });

  it("wires both Vitest and node:test through the shared bootstrap", async () => {
    const vitestSetup = readFileSync(resolve(process.cwd(), "tests/setup.mjs"), "utf8");
    const nodeBootstrap = readFileSync(resolve(process.cwd(), "tests/node-test-bootstrap.mjs"), "utf8");
    const runtimeBootstrap = readFileSync(resolve(process.cwd(), "tests/runtime-bootstrap.mjs"), "utf8");
    const uiServer = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
    const agentPool = readFileSync(resolve(process.cwd(), "agent/agent-pool.mjs"), "utf8");
    const agentLauncher = readFileSync(resolve(process.cwd(), "agent/agent-launcher.mjs"), "utf8");
    const threadRegistry = readFileSync(resolve(process.cwd(), "agent/thread-registry.mjs"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const sessionTrackerModule = await import("../infra/session-tracker.mjs");

    expect(vitestSetup).toContain('import "./runtime-bootstrap.mjs";');
    expect(nodeBootstrap).toContain('import "./runtime-bootstrap.mjs";');
    expect(runtimeBootstrap).toContain("installTestRuntimeGuards()");
    expect(sessionTrackerModule._test.resolveSessionTrackerPersistDir()).toBeNull();
    expect(sessionTrackerModule._test.resolveSessionTrackerPersistDir({ persistDir: "/tmp/custom-sessions" })).toBe(
      "/tmp/custom-sessions",
    );
    expect(uiServer).toContain("shouldHideGeneratedWorkflowFromList");
    expect(uiServer).toContain("const cacheDir = sandbox?.cacheDir || resolve(repoRoot, \".bosun\", \".cache\");");
    expect(agentPool).toContain('export * from "./agent-launcher.mjs";');
    expect(agentLauncher).toContain('from "./thread-registry.mjs"');
    expect(agentLauncher).toContain("ensureManagedThreadRegistryLoaded");
    expect(agentLauncher).toContain("setManagedThreadRecord");
    expect(threadRegistry).toContain('process.env.BOSUN_TEST_CACHE_DIR');
    expect(threadRegistry).toContain('resolve(testCacheDir, "thread-registry.json")');
    expect(packageJson.scripts["test:node"]).toContain("--import ./tests/node-test-bootstrap.mjs");
  });

  it("blocks destructive git mutations against non-temp repositories in test runtime", async () => {
    const env = snapshotEnv();
    try {
      process.env.VITEST = "1";
      await vi.resetModules();
      const runtime = await import("../infra/test-runtime.mjs");

      expect(() =>
        runtime.assertSafeGitMutationInTests({
          command: "git",
          args: ["push", "origin", "HEAD"],
          cwd: process.cwd(),
        }),
      ).toThrow(/blocked destructive git command/i);

      expect(() =>
        runtime.assertSafeGitMutationInTests({
          command: "git",
          args: ["push", "origin", "HEAD"],
          cwd: resolve(tmpdir(), "bosun-safe-test-repo"),
        }),
      ).not.toThrow();
    } finally {
      restoreEnv(env);
    }
  });
});
